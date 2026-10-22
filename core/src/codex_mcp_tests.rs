//! T-29: a Codex Agent's MCP servers through the HTTP API, with a fake
//! app-server that reports its servers starting as it resumes the thread
//! and records every request. No account, model, MCP server or real session
//! is used.
use super::*;
use std::os::unix::fs::PermissionsExt;

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    base: String,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Lab {
    fn drop(&mut self) {
        self.server.abort();
        for c in self.ws.rpcs.lock().unwrap().values() { c.rpc.close(); }
    }
}

impl Lab {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
def say(m,p):print(json.dumps({'method':m,'params':p}),flush=True)
for line in sys.stdin:
 r=json.loads(line); m=r.get('method','')
 if 'method' not in r or 'id' not in r:continue
 with (root/'sent').open('a') as f:f.write(m+'\n')
 result={}
 if m in ['thread/start','thread/resume','thread/read']:
  if m=='thread/resume' and (root/'report').exists():
   for p in json.loads((root/'report').read_text()):say('mcpServer/startupStatus/updated',p)
  result={'thread':{'id':'thread-a','status':{'type':'idle'},'turns':[{'id':'old-turn','status':'completed','items':[]}]},'model':'m'}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.display().to_string()).unwrap();
        let d: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "threadId":"thread-a","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[{"id":"old-turn","status":"completed","items":[]}],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&d).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::server::router_on_port(ws.clone(), dir.path().join("web"), addr.port());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { dir, ws, base: format!("http://{addr}/api"), server }
    }

    fn report(&self, reports: Value) {
        std::fs::write(self.dir.path().join("report"), reports.to_string()).unwrap();
    }

    async fn connect(&self) {
        self.ws.reconnect("a").await.unwrap();
        let generation = self.ws.rpcs.lock().unwrap()["a"].generation;
        self.ws.collaboration_started("a", generation).await;
    }

    async fn get(&self) -> Value {
        let response = reqwest::Client::new().get(format!("{}/agents/a/codex/mcp", self.base)).header("X-Yuzuno-Client", "desktop").send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        response.json().await.unwrap()
    }

    /// The view once `servers` servers are listed (reports are events, handled as they arrive).
    async fn listed(&self, servers: usize) -> Value {
        for _ in 0..200 {
            let view = self.get().await;
            if view["servers"].as_array().is_some_and(|s| s.len() == servers) { return view; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("{servers} servers never listed: {}", self.get().await);
    }

    fn sent(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.path().join("sent")).unwrap_or_default().lines().map(str::to_owned).collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_panel_lists_what_this_connections_own_servers_reported_and_asks_codex_nothing() {
    let lab = Lab::new().await;
    assert_eq!(lab.get().await, json!({"state":"unavailable","reason":"not_connected","generation":null,"servers":[],"more":0}));
    lab.report(json!([
        {"threadId":"thread-a","name":"docs","status":"starting","error":null,"failureReason":null},
        {"threadId":"thread-a","name":"docs","status":"ready","error":null,"failureReason":null},
        {"threadId":"thread-a","name":"tracker","status":"failed","error":"401 from https://tracker.invalid","failureReason":"reauthenticationRequired"},
        {"threadId":"thread-child","name":"child-only","status":"ready","error":null,"failureReason":null},
        {"threadId":null,"name":"threadless","status":"ready","error":null,"failureReason":null}]));
    lab.connect().await;
    let view = lab.listed(2).await;
    assert_eq!(view["state"], "observed");
    assert_eq!(view["servers"].as_array().unwrap().iter().map(|s| (s["name"].as_str().unwrap(), s["status"].as_str().unwrap(),
        s["error"].as_str(), s["failureReason"].as_str())).collect::<Vec<_>>(),
        [("docs", "ready", None, None), ("tracker", "failed", Some("401 from https://tracker.invalid"), Some("reauthenticationRequired"))],
        "the latest report of each of its own thread's servers; another thread's or a threadless one is not this conversation's");
    let before = lab.sent();
    for _ in 0..3 { lab.get().await; }
    assert_eq!(lab.sent(), before, "reading sends Codex nothing");
    // What connecting sent (initialize, config/read, thread/resume, thread/read) is as before: no status list, which would start every server.
    assert!(!before.iter().any(|m| m.starts_with("mcpServer")), "{before:?}");
    // When the connection ends its reports go; a new one keeps nothing of them.
    let old = view["generation"].as_u64().unwrap();
    lab.ws.rpcs.lock().unwrap()["a"].rpc.close();
    for _ in 0..200 {
        if lab.get().await["state"] == "unavailable" { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(lab.get().await["reason"], "not_connected");
    lab.report(json!([]));
    lab.connect().await;
    let view = lab.get().await;
    assert!(view["generation"].as_u64().unwrap() > old, "{view}");
    assert_eq!((view["state"].as_str(), view["servers"].as_array().unwrap().len()), (Some("observed"), 0), "nothing received yet on this connection");
}
