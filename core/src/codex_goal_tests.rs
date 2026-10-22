//! T-29: a Codex Agent's goal through the HTTP API, with a fake app-server
//! that keeps the thread's goal in a file and records every request. No
//! account, model or real session is used.
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

const GOAL: &str = r#"{"threadId":"thread-a","objective":"Ship the parser","status":"active","tokenBudget":null,"tokensUsed":120,"timeUsedSeconds":30,"createdAt":1,"updatedAt":2}"#;

impl Lab {
    /// `goal`: the thread's goal to begin with, or none.
    async fn new(goal: Option<&str>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
state=root/'goal.json'
for line in sys.stdin:
 r=json.loads(line); m=r.get('method',''); p=r.get('params',{})
 if 'method' not in r or 'id' not in r:continue
 if m.startswith('thread/goal/') or m.startswith('turn/'):
  with (root/'sent').open('a') as f:f.write(json.dumps({'method':m,'params':p})+'\n')
 mode=(root/'mode').read_text() if (root/'mode').exists() else ''
 goal=json.loads(state.read_text())
 result={}
 if m in ['thread/start','thread/resume','thread/read']:
  result={'thread':{'id':'thread-a','status':{'type':'idle'},'turns':[{'id':'old-turn','status':'completed','items':[]}]},'model':'m'}
 elif m.startswith('thread/goal/') and mode=='missing':
  print(json.dumps({'id':r['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True); continue
 elif m.startswith('thread/goal/') and mode=='disabled':
  print(json.dumps({'id':r['id'],'error':{'code':-32600,'message':'goals feature is disabled'}}),flush=True); continue
 elif m=='thread/goal/set' and mode=='drop':
  sys.exit(0)
 elif m=='thread/goal/get':
  result={'goal':goal}
 elif m=='thread/goal/set':
  goal=goal or {'threadId':p['threadId'],'tokenBudget':None,'tokensUsed':0,'timeUsedSeconds':0,'createdAt':3,'updatedAt':3}
  for k in ['objective','status']:
   if k in p:goal[k]=p[k]
  state.write_text(json.dumps(goal)); result={'goal':goal}
 elif m=='thread/goal/clear':
  state.write_text('null'); result={'cleared':goal is not None}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.path().join("goal.json"), goal.unwrap_or("null")).unwrap();
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

    async fn connect(&self) {
        self.ws.reconnect("a").await.unwrap();
        let generation = self.ws.rpcs.lock().unwrap()["a"].generation;
        self.ws.collaboration_started("a", generation).await;
    }

    fn mode(&self, mode: &str) {
        std::fs::write(self.dir.path().join("mode"), mode).unwrap();
    }

    async fn get(&self) -> Value {
        let response = reqwest::Client::new().get(format!("{}/agents/a/codex/goal", self.base)).header("X-Yuzuno-Client", "desktop").send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        response.json().await.unwrap()
    }

    async fn change(&self, body: Value) -> (u16, Value) {
        let response = reqwest::Client::new().post(format!("{}/agents/a/codex/goal", self.base))
            .header("X-Yuzuno-Client", "desktop").json(&body).send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    /// The goal and turn requests Codex received, in order.
    fn sent(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("sent")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn methods(&self) -> Vec<String> {
        self.sent().iter().map(|r| r["method"].as_str().unwrap().to_owned()).collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_goal_is_read_from_the_agents_own_codex_only_while_connected_and_reading_changes_nothing() {
    let lab = Lab::new(Some(GOAL)).await;
    let view = lab.get().await;
    assert_eq!((view["state"].as_str(), view["reason"].as_str()), (Some("unavailable"), Some("not_connected")));
    assert!(lab.sent().is_empty(), "nothing is started to read it");
    lab.connect().await;
    let view = lab.get().await;
    assert_eq!((view["state"].as_str(), view["goal"]["objective"].as_str(), view["goal"]["status"].as_str()), (Some("ready"), Some("Ship the parser"), Some("active")));
    assert_eq!(lab.sent(), [json!({"method":"thread/goal/get","params":{"threadId":"thread-a"}})], "only read; no set, clear or turn");
    lab.mode("missing");
    assert_eq!(lab.get().await, json!({"state":"unsupported","reason":"old_protocol","goal":null}));
    lab.mode("disabled");
    assert_eq!(lab.get().await, json!({"state":"failed","reason":"goals feature is disabled","goal":null}), "Codex's own reason, as it says it");
    assert!(lab.methods().iter().all(|m| m == "thread/goal/get"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_objective_is_the_users_own_and_an_unfinished_goal_is_replaced_only_when_confirmed() {
    let lab = Lab::new(None).await;
    lab.connect().await;
    let (status, answer) = lab.change(json!({"action":"set","objective":"  Ship the parser \n"})).await;
    assert_eq!((status, answer["goal"]["objective"].as_str(), answer["goal"]["status"].as_str()), (200, Some("Ship the parser"), Some("active")), "{answer}");
    assert_eq!(lab.sent(), [json!({"method":"thread/goal/get","params":{"threadId":"thread-a"}}),
        json!({"method":"thread/goal/set","params":{"threadId":"thread-a","origin":"user","objective":"Ship the parser","status":"active"}})]);
    // Another objective while that one is unfinished: refused until confirmed.
    let (status, answer) = lab.change(json!({"action":"set","objective":"Write the docs"})).await;
    assert_eq!(status, 400, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("确认替换"));
    assert_eq!(lab.methods()[2..], ["thread/goal/get"], "nothing changed");
    let (status, answer) = lab.change(json!({"action":"set","objective":"Write the docs","replace":true})).await;
    assert_eq!((status, answer["goal"]["objective"].as_str()), (200, Some("Write the docs")));
    assert_eq!(lab.sent()[4..], [json!({"method":"thread/goal/clear","params":{"threadId":"thread-a","origin":"user"}}),
        json!({"method":"thread/goal/set","params":{"threadId":"thread-a","origin":"user","objective":"Write the docs","status":"active"}})],
        "cleared first, as Codex's CLI replaces one");
    assert!(!lab.methods().iter().any(|m| m.starts_with("turn/")), "Yuzuno starts no turn for it; Codex's own events show any");
    // A complete goal is finished: a new objective replaces it without asking, cleared first too.
    std::fs::write(lab.dir.path().join("goal.json"), GOAL.replace("\"active\"", "\"complete\"")).unwrap();
    let before = lab.sent().len();
    let (status, answer) = lab.change(json!({"action":"set","objective":"Next"})).await;
    assert_eq!((status, answer["goal"]["tokensUsed"].as_u64()), (200, Some(0)), "its own accounting: {answer}");
    assert_eq!(lab.methods()[before..], ["thread/goal/get", "thread/goal/clear", "thread/goal/set"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pause_resume_and_clear_are_codexs_own_and_only_pausing_or_clearing_waits_for_nothing() {
    let lab = Lab::new(Some(GOAL)).await;
    lab.connect().await;
    for (action, params) in [("pause", json!({"status":"paused"})), ("resume", json!({"status":"active"}))] {
        let (status, answer) = lab.change(json!({"action":action})).await;
        assert_eq!((status, answer["goal"]["status"].clone()), (200, params["status"].clone()), "{action}: {answer}");
        let mut expected = json!({"threadId":"thread-a","origin":"user"});
        expected.as_object_mut().unwrap().extend(params.as_object().unwrap().clone());
        assert_eq!(lab.sent().last().unwrap(), &json!({"method":"thread/goal/set","params":expected}));
    }
    // While an earlier result is unconfirmed, nothing that may start Codex
    // working goes in; pausing and clearing still do.
    lab.ws.store.update_meta("a", "test/uncertain", &json!({}), |m| { m.agent.status = "uncertain".into(); }).unwrap();
    let before = lab.sent().len();
    for body in [json!({"action":"resume"}), json!({"action":"set","objective":"Other","replace":true})] {
        let (status, answer) = lab.change(body.clone()).await;
        assert_eq!(status, 400, "{body}: {answer}");
        assert!(answer["error"].as_str().unwrap().contains("尚未确认"), "{answer}");
    }
    assert_eq!(lab.sent().len(), before, "nothing reached Codex");
    let (status, _) = lab.change(json!({"action":"pause"})).await;
    assert_eq!(status, 200);
    let (status, answer) = lab.change(json!({"action":"clear"})).await;
    assert_eq!((status, answer), (200, json!({"goal":null,"cleared":true})));
    assert_eq!(lab.sent().last().unwrap(), &json!({"method":"thread/goal/clear","params":{"threadId":"thread-a","origin":"user"}}));
    // Anything else, or Codex's fields under another action, is refused before Codex.
    let before = lab.sent().len();
    for body in [json!({"action":"pause","origin":"automatic"}), json!({"action":"set","objective":"x","tokenBudget":10}), json!({"action":"set","objective":" "})] {
        let (status, _) = lab.change(body.clone()).await;
        assert!((400..500).contains(&status), "{body}: {status}");
    }
    assert_eq!(lab.sent().len(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_or_lost_change_says_so_and_is_never_sent_again() {
    let lab = Lab::new(Some(GOAL)).await;
    lab.connect().await;
    lab.mode("missing");
    let (status, answer) = lab.change(json!({"action":"pause"})).await;
    assert_eq!(status, 400);
    assert!(answer["error"].as_str().unwrap().contains("不提供原生目标"), "{answer}");
    lab.mode("disabled");
    let (_, answer) = lab.change(json!({"action":"clear"})).await;
    assert!(answer["error"].as_str().unwrap().contains("goals feature is disabled") && answer["error"].as_str().unwrap().contains("实际状态"), "{answer}");
    lab.mode("drop");
    let before = lab.sent().len();
    let (status, answer) = lab.change(json!({"action":"pause"})).await;
    assert!(status >= 400, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("无法确认") && answer["error"].as_str().unwrap().contains("不要重复"), "{answer}");
    assert_eq!(lab.methods()[before..], ["thread/goal/set"], "sent once, never again");
    assert!(!lab.methods().iter().any(|m| m.starts_with("turn/")), "never sent as a prompt");
}
