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
    /// The Agent's ID: its own, where a test counts reads of its record.
    id: String,
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
        Self::with_id("a").await
    }

    async fn with_id(id: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
def say(m,p):print(json.dumps({'method':m,'params':p}),flush=True)
class _TurnsList:
    """thread/turns/list answered as this fake's thread/read (T-140)."""
    def __init__(self, raw): self.raw, self.ids, self.buf = raw, set(), ''
    def write(self, text):
        self.buf += text
        while '\n' in self.buf:
            line, self.buf = self.buf.split('\n', 1)
            try:
                v = json.loads(line)
                if isinstance(v, dict) and v.get('id') in self.ids and 'result' in v:
                    self.ids.discard(v['id'])
                    turns = ((v['result'] or {}).get('thread') or {}).get('turns') or []
                    v['result'] = {'data': list(reversed(turns)), 'nextCursor': None}
                    line = json.dumps(v)
            except ValueError: pass
            self.raw.write(line + '\n')
        return len(text)
    def flush(self): self.raw.flush()
sys.stdout = _TurnsList(sys.stdout)
for line in sys.stdin:
 r=json.loads(line); m=r.get('method','')
 if 'method' not in r or 'id' not in r:continue
 if m=='thread/turns/list': sys.stdout.ids.add(r['id']); m='thread/read'
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
        let d: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":"A","cwd":"/tmp","model":"m","color":"sage",
            "threadId":"thread-a","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[{"id":"old-turn","status":"completed","items":[]}],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&d).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::server::router_on_port(ws.clone(), dir.path().join("web"), addr.port());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { dir, ws, base: format!("http://{addr}/api"), id: id.into(), server }
    }

    fn report(&self, reports: Value) {
        std::fs::write(self.dir.path().join("report"), reports.to_string()).unwrap();
    }

    async fn connect(&self) {
        self.ws.reconnect(&self.id).await.unwrap();
        let generation = self.ws.rpcs.lock().unwrap()[&self.id].generation;
        self.ws.collaboration_started(&self.id, generation).await;
    }

    async fn get(&self) -> Value {
        let response = reqwest::Client::new().get(format!("{}/agents/{}/codex/mcp", self.base, self.id)).header("X-Yuzuno-Client", "desktop").send().await.unwrap();
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

/// T-29 (Lead peer 6809): opening or refreshing the panel checks the Agent as
/// listed, never its whole record, whether that record is held in memory or
/// not, and connected or not; and it asks Codex nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_the_panel_reads_no_whole_record_held_or_not() {
    let lab = Lab::with_id("mcp-panel-reads").await;
    let id = lab.id.clone();
    let reads = || crate::store::detail_reads_of(&id);
    // Held after a write; released, read from its row.
    let touch = |held: bool| {
        lab.ws.store.update(&id, "test/touched", &json!({}), |d| d.agent.updated_at = crate::model::now()).unwrap();
        if !held { assert!(lab.ws.store.release_for_test(&id), "the write held it"); }
    };
    for held in [true, false] {
        touch(held);
        let before = reads();
        assert_eq!(lab.get().await["reason"], "not_connected");
        assert_eq!(reads(), before, "not connected, held {held}: a whole record was read");
    }
    lab.report(json!([{"threadId":"thread-a","name":"docs","status":"ready","error":null,"failureReason":null}]));
    lab.connect().await;
    lab.listed(1).await;
    // Whatever connecting itself reads is done before counting.
    let mut last = reads();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if reads() == last { break; }
        last = reads();
    }
    let sent = lab.sent();
    for held in [true, false] {
        touch(held);
        let before = reads();
        for _ in 0..2 {
            let view = lab.get().await;
            assert_eq!((view["state"].as_str(), view["servers"].as_array().map(Vec::len)), (Some("observed"), Some(1)), "held {held}: {view}");
        }
        assert_eq!(reads(), before, "connected, held {held}: a whole record was read");
    }
    assert_eq!(lab.sent(), sent, "reading sends Codex nothing");
    // Closed, as listed: still no whole record.
    lab.ws.store.update(&id, "test/closed", &json!({}), |d| d.agent.closed_at = Some(crate::model::now())).unwrap();
    let before = reads();
    assert_eq!(lab.get().await["reason"], "closed");
    assert_eq!(reads(), before, "closed: a whole record was read");
}
