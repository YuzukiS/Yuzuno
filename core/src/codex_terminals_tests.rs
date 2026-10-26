//! T-29 `/ps` and `/stop` through the HTTP API, with a fake app-server whose
//! background terminal requests behave as Codex 0.162.1's do (T-29 comment
//! 5749): `list` pages by process number, `terminate` stops one number and
//! answers whether it did. The terminals live in a file a test edits between
//! the list and the stop, as Codex's do while the user reads them. Every
//! background terminal request is recorded with the process that got it. No
//! real terminal, Git, account, model or session is used.
use super::*;
use crate::codex_terminals::{StopRequest, Target};
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

const SCRIPT: &str = r#"#!/usr/bin/python3
import json,os,sys,time,pathlib
root=pathlib.Path(__file__).parent
def out(v):print(json.dumps(v),flush=True)
def log(v):
 with (root/'sent').open('a') as f:f.write(json.dumps(v|{'pid':os.getpid()})+'\n')
def flags():return (root/'flags').read_text().split()
def terms():return json.loads((root/'terminals.json').read_text())
def save(t):(root/'terminals.json').write_text(json.dumps(t))
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
 r=json.loads(line); m=r.get('method',''); p=r.get('params',{})
 if 'method' not in r or 'id' not in r:continue
 if m=='thread/turns/list': sys.stdout.ids.add(r['id']); m='thread/read'
 i=r['id']; f=flags()
 if m.startswith('thread/backgroundTerminals/'):
  log({'method':m,'params':p})
  if 'old' in f: out({'id':i,'error':{'code':-32601,'message':'Method not found'}}); continue
  if m.endswith('/list'):
   if 'list-refuse' in f: out({'id':i,'error':{'code':-32600,'message':'thread not loaded'}}); continue
   if 'list-slow' in f: time.sleep(float((root/'slow').read_text()) if (root/'slow').exists() else 0.6)
   t=sorted(terms(),key=lambda x:int(x['processId'])); cur=p.get('cursor'); lim=p.get('limit') or len(t)
   if 'list-endless' in f: out({'id':i,'result':{'data':[x|{'osPid':None,'cpuPercent':None,'rssKb':None} for x in t],'nextCursor':'0'}}); continue
   start=0 if cur is None else next((k for k,x in enumerate(t) if int(x['processId'])>int(cur)),len(t)); end=min(start+lim,len(t))
   out({'id':i,'result':{'data':[x|{'osPid':None,'cpuPercent':None,'rssKb':None} for x in t[start:end]],'nextCursor':t[end-1]['processId'] if end<len(t) else None}}); continue
  if m.endswith('/terminate'):
   if 'term-slow' in f: time.sleep(float((root/'slow').read_text()) if (root/'slow').exists() else 0.6)
   if 'term-drop' in f: sys.exit(0)
   if 'term-refuse' in f: out({'id':i,'error':{'code':-32600,'message':'cannot stop it here'}}); continue
   t=terms(); left=[x for x in t if x['processId']!=p['processId']]
   if 'term-false' in f: out({'id':i,'result':{'terminated':False}}); continue
   if 'term-false-gone' in f: save(left); out({'id':i,'result':{'terminated':False}}); continue
   save(left); out({'id':i,'result':{'terminated':len(left)<len(t)}}); continue
  out({'id':i,'error':{'code':-32601,'message':'Method not found'}}); continue
 out({'id':i,'result':{'thread':{'id':'thread-a','status':{'type':'idle'},'turns':[]},'model':'m'} if m.startswith('thread/') else {}})
"#;

fn terminal(process: &str, item: &str, command: &str) -> Value {
    json!({"processId":process,"itemId":item,"command":command,"cwd":"/w/app"})
}

impl Lab {
    async fn new(flags: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, SCRIPT).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.path().join("flags"), flags).unwrap();
        std::fs::write(dir.path().join("terminals.json"), "[]").unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.display().to_string()).unwrap();
        let d: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/w/app","model":"m","color":"sage",
            "threadId":"thread-a","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&d).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::server::router_on_port(ws.clone(), dir.path().join("web"), addr.port());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { dir, ws, base: format!("http://{addr}/api"), server }
    }

    fn write(&self, name: &str, content: &str) {
        std::fs::write(self.dir.path().join(name), content).unwrap();
    }

    fn terminals(&self, list: Value) {
        self.write("terminals.json", &list.to_string());
    }

    async fn connect(&self) -> u64 {
        self.ws.reconnect("a").await.unwrap();
        self.ws.rpcs.lock().unwrap()["a"].generation
    }

    async fn list(&self) -> Value {
        let response = reqwest::Client::new().get(format!("{}/agents/a/codex/terminals", self.base))
            .header("X-Yuzuno-Client", "desktop").send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        response.json().await.unwrap()
    }

    async fn stop_raw(&self, body: Value) -> (u16, Value) {
        let response = reqwest::Client::new().post(format!("{}/agents/a/codex/terminals/stop", self.base))
            .header("X-Yuzuno-Client", "desktop").json(&body).send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    /// Stops these (processId, itemId) pairs, as the dialog shows them, on `generation`.
    async fn stop(&self, generation: u64, targets: &[(&str, &str)]) -> Value {
        let targets: Vec<Value> = targets.iter().map(|(p, i)| json!({"processId":p,"itemId":i})).collect();
        let (status, body) = self.stop_raw(json!({"generation":generation,"threadId":"thread-a","targets":targets})).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    fn sent(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("sent")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    /// The process numbers terminate was sent for, in order.
    fn terminated(&self) -> Vec<String> {
        self.sent().iter().filter(|r| r["method"] == "thread/backgroundTerminals/terminate")
            .map(|r| r["params"]["processId"].as_str().unwrap().to_owned()).collect()
    }

    async fn until(&self, what: &str, done: impl Fn(&[Value]) -> bool) {
        for _ in 0..300 {
            if done(&self.sent()) { return; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("never {what}: {:?}", self.sent());
    }
}

fn outcomes(report: &Value) -> Vec<(String, String, bool)> {
    report["outcomes"].as_array().unwrap().iter().map(|o| (o["processId"].as_str().unwrap().to_owned(),
        o["outcome"].as_str().unwrap().to_owned(), o["sent"].as_bool().unwrap())).collect()
}

fn listed(listing: &Value) -> Vec<(String, String)> {
    listing["terminals"].as_array().unwrap().iter()
        .map(|t| (t["processId"].as_str().unwrap().to_owned(), t["itemId"].as_str().unwrap().to_owned())).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_list_is_read_on_the_current_connection_only_every_page_and_marks_the_running_turns_terminals() {
    let lab = Lab::new("").await;
    assert_eq!(lab.list().await, json!({"state":"unavailable","reason":"not_connected","detail":null,"generation":null,"threadId":null,"terminals":[],"complete":false}));
    let stop = lab.stop(1, &[("1001", "call-a")]).await;
    assert_eq!((stop["state"].as_str(), stop["reason"].as_str()), (Some("unavailable"), Some("not_connected")));
    assert!(lab.sent().is_empty() && lab.ws.rpcs.lock().unwrap().is_empty(), "nothing connected or asked");
    let generation = lab.connect().await;
    lab.terminals(Value::Array((0..150).map(|n| terminal(&(1000 + n).to_string(), &format!("call-{n}"), "npm run dev")).collect()));
    lab.ws.store.update("a", "test/turn", &json!({}), |d| d.turns.push(json!({"id":"t9","status":"inProgress",
        "items":[{"id":"call-7","type":"commandExecution","status":"inProgress"}]}))).unwrap();
    let listing = lab.list().await;
    assert_eq!((listing["state"].as_str(), listing["generation"].as_u64(), listing["threadId"].as_str(), listing["complete"].as_bool()),
        (Some("listed"), Some(generation), Some("thread-a"), Some(true)));
    assert_eq!(listing["terminals"].as_array().unwrap().len(), 150);
    assert_eq!(listing["terminals"][0], json!({"processId":"1000","itemId":"call-0","command":"npm run dev","cwd":"/w/app","inRunningTurn":false}));
    assert_eq!(listing["terminals"][7]["inRunningTurn"], true, "started by a command of the running Turn");
    let pages: Vec<Value> = lab.sent().iter().map(|r| r["params"].clone()).collect();
    assert_eq!(pages, vec![json!({"threadId":"thread-a","cursor":null,"limit":100}), json!({"threadId":"thread-a","cursor":"1099","limit":100})]);
    assert!(lab.terminated().is_empty(), "listing stops nothing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_sends_one_terminate_per_terminal_the_user_saw_and_never_widens_to_what_came_after() {
    let lab = Lab::new("").await;
    let generation = lab.connect().await;
    lab.terminals(json!([terminal("1001", "call-a", "npm run dev"), terminal("1002", "call-b", "tail -f log"), terminal("1003", "call-c", "watch")]));
    let shown = lab.list().await;
    // While the dialog is open: b ends, c's number now names another call, d starts.
    lab.terminals(json!([terminal("1001", "call-a", "npm run dev"), terminal("1003", "call-new", "other"), terminal("1004", "call-d", "new one")]));
    let report = lab.stop(generation, &[("1001", "call-a"), ("1002", "call-b"), ("1003", "call-c")]).await;
    assert_eq!(listed(&shown).len(), 3);
    assert_eq!(outcomes(&report), [("1001".into(), "stopped".into(), true), ("1002".into(), "gone".into(), false), ("1003".into(), "replaced".into(), false)]);
    assert_eq!(lab.terminated(), ["1001"], "only the terminal still as it was shown");
    assert!(!lab.sent().iter().any(|r| r["method"] == "thread/backgroundTerminals/clean"), "never a stop of everything");
    assert_eq!(listed(&report["after"]), [("1003".to_owned(), "call-new".to_owned()), ("1004".to_owned(), "call-d".to_owned())], "the check after, with what came later untouched");
    // Each terminate came right after a list that still named its terminal.
    let sent = lab.sent();
    let methods: Vec<&str> = sent.iter().map(|r| r["method"].as_str().unwrap().rsplit('/').next().unwrap()).collect();
    assert_eq!(methods, ["list", "list", "terminate", "list", "list", "list"], "shown, check a, stop a, check b, check c, after");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_codex_answers_is_told_apart_and_nothing_is_sent_again() {
    let lab = Lab::new("").await;
    let generation = lab.connect().await;
    lab.terminals(json!([terminal("1001", "call-a", "a"), terminal("1002", "call-b", "b")]));
    lab.write("flags", "term-false");
    let report = lab.stop(generation, &[("1001", "call-a")]).await;
    assert_eq!(outcomes(&report), [("1001".into(), "not_stopped".into(), true)], "Codex could not stop it and it is still listed");
    lab.write("flags", "term-false-gone");
    let report = lab.stop(generation, &[("1001", "call-a")]).await;
    assert_eq!(outcomes(&report), [("1001".into(), "gone".into(), true)], "it ended meanwhile");
    lab.write("flags", "term-refuse");
    let report = lab.stop(generation, &[("1002", "call-b")]).await;
    assert_eq!(outcomes(&report), [("1002".into(), "refused".into(), true)]);
    assert_eq!(report["outcomes"][0]["detail"], "cannot stop it here");
    assert_eq!(lab.terminated(), ["1001", "1001", "1002"], "one terminate per stop; none repeated");
    // No answer: unknown, the rest not sent, and nothing after it on that connection.
    lab.terminals(json!([terminal("1002", "call-b", "b"), terminal("1003", "call-c", "c")]));
    lab.write("flags", "term-drop");
    let report = lab.stop(generation, &[("1002", "call-b"), ("1003", "call-c")]).await;
    assert_eq!(outcomes(&report), [("1002".into(), "unknown".into(), true), ("1003".into(), "not_sent".into(), false)]);
    assert!(report["after"].is_null() || report["after"]["state"] == "failed", "no check on a connection that is gone: {}", report["after"]);
    assert_eq!(lab.terminated(), ["1001", "1001", "1002", "1002"], "the unknown one is not sent again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_is_bound_to_the_connection_and_conversation_shown_and_runs_once_at_a_time() {
    let lab = Lab::new("term-slow").await;
    let generation = lab.connect().await;
    lab.terminals(json!([terminal("1001", "call-a", "a"), terminal("1002", "call-b", "b")]));
    for (status, body) in [
        lab.stop_raw(json!({"generation":generation + 1,"threadId":"thread-a","targets":[{"processId":"1001","itemId":"call-a"}]})).await,
        lab.stop_raw(json!({"generation":generation,"threadId":"thread-other","targets":[{"processId":"1001","itemId":"call-a"}]})).await,
    ] {
        assert_eq!((status, body["state"].as_str(), body["reason"].as_str()), (200, Some("unavailable"), Some("target_changed")), "{body}");
    }
    for bad in [json!([]), json!([{"processId":"abc","itemId":"x"}]), json!([{"processId":"-1","itemId":"x"}]),
            json!([{"processId":"1001","itemId":""}]), json!([{"processId":"1001","itemId":"x"},{"processId":"1001","itemId":"x"}])] {
        let (status, _) = lab.stop_raw(json!({"generation":generation,"threadId":"thread-a","targets":bad})).await;
        assert_eq!(status, 400, "{bad}");
    }
    assert!(lab.sent().is_empty(), "nothing listed or stopped for a target the dialog did not show");
    // A double click: the second waits for nothing and stops nothing.
    let ws = lab.ws.clone();
    let first = tokio::spawn(async move {
        ws.codex_terminals_stop("a", StopRequest { generation, thread_id: "thread-a".into(),
            targets: vec![Target { process_id: "1001".into(), item_id: "call-a".into() }] }).await.unwrap()
    });
    lab.until("the first stop is sent", |sent| sent.iter().any(|r| r["method"] == "thread/backgroundTerminals/terminate")).await;
    let second = lab.stop(generation, &[("1001", "call-a")]).await;
    assert_eq!((second["state"].as_str(), second["reason"].as_str()), (Some("busy"), Some("busy")));
    let first = serde_json::to_value(first.await.unwrap()).unwrap();
    assert_eq!(outcomes(&first), [("1001".into(), "stopped".into(), true)]);
    assert_eq!(lab.terminated(), ["1001"], "one terminate for two clicks");
    assert_eq!(lab.stop(generation, &[("1002", "call-b")]).await["state"], "done", "the next stop runs");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_ends_with_its_connection_and_an_old_codex_is_told_apart() {
    let lab = Lab::new("term-slow").await;
    lab.write("slow", "1.5");
    let first = lab.connect().await;
    lab.terminals(json!([terminal("1001", "call-a", "a"), terminal("1002", "call-b", "b")]));
    let ws = lab.ws.clone();
    let stop = tokio::spawn(async move {
        ws.codex_terminals_stop("a", StopRequest { generation: first, thread_id: "thread-a".into(), targets: vec![
            Target { process_id: "1001".into(), item_id: "call-a".into() }, Target { process_id: "1002".into(), item_id: "call-b".into() }] }).await.unwrap()
    });
    lab.until("the stop is sent", |sent| sent.iter().any(|r| r["method"] == "thread/backgroundTerminals/terminate")).await;
    let old = lab.sent()[0]["pid"].clone();
    lab.ws.remove_connection("a", first).await;
    let report = serde_json::to_value(stop.await.unwrap()).unwrap();
    assert_eq!(outcomes(&report), [("1001".into(), "unknown".into(), true), ("1002".into(), "not_sent".into(), false)]);
    lab.write("flags", "");
    let second = lab.connect().await;
    assert_ne!(first, second);
    tokio::time::sleep(std::time::Duration::from_millis(1600)).await;
    assert!(lab.sent().iter().all(|r| r["pid"] == old), "nothing of the old stop reached the new connection");
    assert_eq!(lab.list().await["generation"].as_u64(), Some(second));
    lab.write("flags", "old");
    assert_eq!((lab.list().await["state"].as_str(), lab.list().await["reason"].as_str()), (Some("unavailable"), Some("old_protocol")));
    let report = lab.stop(second, &[("1001", "call-a")]).await;
    assert_eq!(outcomes(&report), [("1001".into(), "not_sent".into(), false)]);
    assert_eq!(report["outcomes"][0]["detail"], "unsupported");
    lab.write("flags", "list-refuse");
    let listing = lab.list().await;
    assert_eq!((listing["state"].as_str(), listing["reason"].as_str(), listing["detail"].as_str()), (Some("failed"), Some("refused"), Some("thread not loaded")));
    assert_eq!(lab.terminated(), ["1001"], "only the one terminate of the old connection");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_terminal_missing_from_a_list_cut_short_is_not_said_to_have_ended() {
    let lab = Lab::new("").await;
    let generation = lab.connect().await;
    lab.terminals(json!([terminal("1001", "call-a", "a")]));
    // Codex always says there is more, so every list stops at its page limit, incomplete; 1001 ends but Codex says it did not stop it.
    lab.write("flags", "list-endless term-false-gone");
    let report = lab.stop(generation, &[("1002", "call-b"), ("1001", "call-a")]).await;
    assert_eq!(outcomes(&report), [("1002".into(), "not_sent".into(), false), ("1001".into(), "not_stopped".into(), true)],
        "missing from a list cut short is not gone, before a stop or after one Codex did not make");
    assert_eq!((report["outcomes"][0]["detail"].as_str(), report["outcomes"][1]["detail"].as_str()), (Some("unlisted"), Some("unchecked")));
    assert_eq!(lab.terminated(), ["1001"], "nothing sent for the unlisted one, and it does not stop the rest");
    assert_eq!(report["after"]["complete"], false);
    let lists = lab.sent().iter().filter(|r| r["method"] == "thread/backgroundTerminals/list").count();
    assert_eq!(lists, 4 * 20, "check 1002, check 1001, the check after Codex said no, the list after: each read to its 20 pages");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_is_not_sent_when_its_connection_changed_while_the_check_was_read() {
    let lab = Lab::new("").await;
    let generation = lab.connect().await;
    lab.terminals(json!([terminal("1001", "call-a", "a"), terminal("1002", "call-b", "b")]));
    lab.write("flags", "list-slow");
    let ws = lab.ws.clone();
    let stop = tokio::spawn(async move {
        ws.codex_terminals_stop("a", StopRequest { generation, thread_id: "thread-a".into(), targets: vec![
            Target { process_id: "1001".into(), item_id: "call-a".into() }, Target { process_id: "1002".into(), item_id: "call-b".into() }] }).await.unwrap()
    });
    lab.until("the check is asked for", |sent| sent.iter().any(|r| r["method"] == "thread/backgroundTerminals/list")).await;
    // The Agent starts closing, as its Close does first, while Codex reads the check; the old connection still answers it.
    lab.ws.rpcs.lock().unwrap().get_mut("a").unwrap().closing = true;
    let report = serde_json::to_value(stop.await.unwrap()).unwrap();
    assert_eq!(outcomes(&report), [("1001".into(), "not_sent".into(), false), ("1002".into(), "not_sent".into(), false)]);
    assert_eq!((report["outcomes"][0]["detail"].as_str(), report["outcomes"][1]["detail"].as_str()), (Some("connection"), Some("connection")));
    assert!(lab.terminated().is_empty(), "nothing sent on a connection that is no longer the Agent's: {:?}", lab.sent());
    assert!(report["after"].is_null());
}
