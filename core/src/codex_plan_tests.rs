//! T-29: a Codex Agent's collaboration mode (/plan) through the HTTP API,
//! with a fake app-server that behaves as Codex 0.162.1 does:
//! - It keeps the thread's mode in a file and reports it in its
//!   `thread/resume` answer.
//! - `thread/settings/updated` comes only when the settings changed.
//! - A turn without `collaborationMode` keeps the mode.
//! - It records every request.
//! No account, model or real session is used.
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
    /// `flags`, read on each request:
    /// - old: a Codex without collaboration modes;
    /// - noplan: one that lists no Plan preset;
    /// - refuse: it refuses the update;
    /// - drop: it exits without answering;
    /// - hang: it never answers the update;
    /// - early: it reports the new mode before answering;
    /// - silent: it accepts without reporting.
    async fn new(flags: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
def say(m,p):print(json.dumps({'method':m,'params':p}),flush=True)
def answer(i,result):print(json.dumps({'id':i,'result':result}),flush=True)
def refuse(i,code,message):print(json.dumps({'id':i,'error':{'code':code,'message':message}}),flush=True)
def mode():return (root/'mode').read_text() if (root/'mode').exists() else 'default'
def collab(kind):return {'mode':kind,'settings':{'model':'m','reasoning_effort':'high','developer_instructions':None}}
thread={'id':'thread-a','status':{'type':'idle'},'turns':[{'id':'old-turn','status':'completed','items':[]}]}
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
 flags=(root/'flags').read_text().split()
 if m!='initialize':
  with (root/'sent').open('a') as f:f.write(json.dumps({'method':m,'params':p})+'\n')
 i=r['id']
 if m in ['thread/start','thread/read']:
  answer(i,{'thread':thread,'model':'m','reasoningEffort':'high'})
 elif m=='thread/resume':
  answer(i,{'thread':thread,'model':'m','reasoningEffort':'high','collaborationMode':None if 'old' in flags else collab(mode())})
 elif m=='collaborationMode/list':
  presets=[{'name':'Plan','mode':'plan','model':None,'reasoning_effort':'medium'},{'name':'Default','mode':'default','model':None,'reasoning_effort':None}]
  if 'old' in flags: refuse(i,-32601,'Method not found')
  else: answer(i,{'data':presets[1:] if 'noplan' in flags else presets})
 elif m=='thread/settings/update':
  if 'refuse' in flags: refuse(i,-32600,'invalid thread settings override: mode unavailable'); continue
  if 'drop' in flags: sys.exit(0)
  if 'hang' in flags: continue
  kind=p['collaborationMode']['mode']; changed=kind!=mode(); (root/'mode').write_text(kind)
  settings={'model':'m','effort':'high','collaborationMode':collab(kind)}
  if 'early' in flags and changed: say('thread/settings/updated',{'threadId':p['threadId'],'threadSettings':settings})
  answer(i,{})
  if 'early' not in flags and 'silent' not in flags and changed: say('thread/settings/updated',{'threadId':p['threadId'],'threadSettings':settings})
 elif m=='turn/start':
  if p.get('collaborationMode'): (root/'mode').write_text(p['collaborationMode']['mode'])
  turn={'id':'plan-turn','status':'inProgress','items':[]}
  answer(i,{'turn':turn})
  say('turn/started',{'threadId':'thread-a','turn':turn})
  if mode()=='plan':
   say('item/completed',{'threadId':'thread-a','turnId':'plan-turn','item':{'type':'plan','id':'plan-1','text':'# Parser plan\n- read the grammar'}})
   print(json.dumps({'id':900,'method':'item/tool/requestUserInput','params':{'threadId':'thread-a','turnId':'plan-turn','itemId':'ask-1',
    'questions':[{'id':'scope','header':'Scope','question':'Which files?','isOther':True,'isSecret':False,'options':None}],'isBlocking':True,'autoResolutionMs':None}}),flush=True)
 else:
  answer(i,{})
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.path().join("flags"), flags).unwrap();
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

    fn flags(&self, flags: &str) {
        std::fs::write(self.dir.path().join("flags"), flags).unwrap();
    }

    async fn connect(&self) -> u64 {
        self.ws.reconnect("a").await.unwrap();
        let generation = self.ws.rpcs.lock().unwrap()["a"].generation;
        self.ws.collaboration_started("a", generation).await;
        generation
    }

    async fn get(&self) -> Value {
        let response = reqwest::Client::new().get(format!("{}/agents/a/codex/plan", self.base)).header("X-Yuzuno-Client", "desktop").send().await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        response.json().await.unwrap()
    }

    async fn switch(&self, mode: &str, generation: u64) -> (u16, Value) {
        let response = reqwest::Client::new().post(format!("{}/agents/a/codex/plan", self.base))
            .header("X-Yuzuno-Client", "desktop").json(&json!({"mode":mode,"generation":generation})).send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    /// The Agent's detail, as the composer reads it.
    async fn detail(&self) -> Value {
        reqwest::Client::new().get(format!("{}/agents/a", self.base)).header("X-Yuzuno-Client", "desktop").send().await.unwrap().json().await.unwrap()
    }

    /// The detail once `done` holds of it (Codex's reports are events, handled as they arrive).
    async fn until(&self, what: &str, done: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..300 {
            let detail = self.detail().await;
            if done(&detail) { return detail; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("never {what}: {}", self.detail().await["codexPlan"]);
    }

    fn sent(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("sent")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn methods_from(&self, from: usize) -> Vec<String> {
        self.sent()[from..].iter().map(|r| r["method"].as_str().unwrap().to_owned()).collect()
    }
}

fn reported(detail: &Value) -> Option<&str> {
    detail["codexPlan"]["reported"]["mode"].as_str()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_lists_the_modes_on_the_agents_own_connection_and_changes_nothing() {
    let lab = Lab::new("").await;
    assert_eq!(lab.get().await, json!({"state":"unavailable","reason":"not_connected","generation":null,"modes":[],"reported":null,"switch":null}));
    assert!(lab.sent().is_empty(), "nothing is started or resumed to read it");
    assert!(lab.detail().await.get("codexPlan").is_none());
    let generation = lab.connect().await;
    let before = lab.sent().len();
    let view = lab.get().await;
    assert_eq!((view["state"].as_str(), view["generation"].as_u64(), view["modes"].clone()), (Some("ready"), Some(generation), json!(["plan","default"])));
    assert_eq!((view["reported"]["mode"].as_str(), view["reported"]["source"].as_str(), &view["switch"]), (Some("default"), Some("resume"), &Value::Null),
        "the mode Codex resumed the thread in: {view}");
    assert_eq!(lab.methods_from(before), ["collaborationMode/list"], "reading only lists; no update, turn or thread");
    assert_eq!(lab.sent()[before]["params"], json!({}));
    let detail = lab.detail().await;
    assert_eq!((reported(&detail), detail["codexPlan"]["generation"].as_u64()), (Some("default"), Some(generation)), "the composer has it too");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_codex_without_collaboration_modes_says_so_and_nothing_is_switched() {
    let lab = Lab::new("old").await;
    let generation = lab.connect().await;
    let before = lab.sent().len();
    let view = lab.get().await;
    assert_eq!((view["state"].as_str(), view["reason"].as_str(), &view["reported"]), (Some("unsupported"), Some("old_protocol"), &Value::Null),
        "a resume answer without a mode reports none: {view}");
    assert!(lab.detail().await.get("codexPlan").is_none(), "nothing to show in the composer");
    let (status, answer) = lab.switch("plan", generation).await;
    assert_eq!(status, 400, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("不提供协作模式") && answer["error"].as_str().unwrap().contains("模式没有改变"), "{answer}");
    lab.flags("noplan");
    let (status, answer) = lab.switch("plan", generation).await;
    assert_eq!(status, 400, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("没有列出Plan 模式"), "{answer}");
    assert_eq!(lab.methods_from(before), ["collaborationMode/list", "collaborationMode/list", "collaborationMode/list"], "no update reached Codex");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_switch_changes_only_the_mode_and_is_confirmed_by_codexs_own_report() {
    for flags in ["", "early"] {
        let lab = Lab::new(flags).await;
        let generation = lab.connect().await;
        let before = lab.sent().len();
        let (status, answer) = lab.switch("plan", generation).await;
        assert_eq!(status, 200, "{flags}: {answer}");
        assert_eq!(lab.methods_from(before), ["collaborationMode/list", "thread/settings/update"], "{flags}");
        // The mode only, with the model and effort the Agent sends with every
        // turn (not the Plan preset's medium effort) and Codex's own Plan
        // instructions. No model, permission or folder field.
        assert_eq!(lab.sent()[before + 1]["params"], json!({"threadId":"thread-a","collaborationMode":{"mode":"plan",
            "settings":{"model":"m","reasoning_effort":"high","developer_instructions":null}}}), "{flags}");
        let detail = lab.until("reported plan", |d| reported(d) == Some("plan")).await;
        assert_eq!((detail["codexPlan"]["reported"]["source"].as_str(), &detail["codexPlan"]["switch"]), (Some("settings"), &Value::Null),
            "{flags}: Codex's report settled the switch, whichever came first");
        // Leaving only switches back: no turn, no new thread, nothing asks Codex to implement the plan.
        let (status, answer) = lab.switch("default", generation).await;
        assert_eq!(status, 200, "{flags}: {answer}");
        assert_eq!(lab.sent().last().unwrap()["params"]["collaborationMode"]["mode"], "default");
        lab.until("reported default", |d| reported(d) == Some("default") && d["codexPlan"]["switch"].is_null()).await;
        assert_eq!(lab.methods_from(before), ["collaborationMode/list", "thread/settings/update", "collaborationMode/list", "thread/settings/update"], "{flags}");
    }
    // Codex accepted but has not reported the mode: shown as accepted, not as switched.
    let lab = Lab::new("silent").await;
    let generation = lab.connect().await;
    let (status, answer) = lab.switch("plan", generation).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!((answer["reported"]["mode"].as_str(), answer["switch"]["to"].as_str(), answer["switch"]["state"].as_str()),
        (Some("default"), Some("plan"), Some("accepted")), "{answer}");
    let view = lab.get().await;
    assert_eq!((view["switch"]["state"].as_str(), view["reported"]["mode"].as_str()), (Some("accepted"), Some("default")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_next_message_keeps_codexs_mode_and_its_questions_use_the_existing_requests() {
    let lab = Lab::new("").await;
    let generation = lab.connect().await;
    let (status, answer) = lab.switch("plan", generation).await;
    assert_eq!(status, 200, "{answer}");
    lab.until("reported plan", |d| reported(d) == Some("plan")).await;
    let before = lab.sent().len();
    lab.ws.send("a", "Plan the parser".into()).await.unwrap();
    assert_eq!(lab.methods_from(before), ["turn/start"], "an ordinary message: no settings update with it");
    let start = &lab.sent()[before]["params"];
    assert!(start.get("collaborationMode").is_none(), "the turn keeps Codex's mode: {start}");
    assert_eq!(start["input"], json!([{"type":"text","text":"Plan the parser"}]));
    // Codex's plan and its question arrive as they always do.
    let detail = lab.until("asked", |d| d["pending"].as_array().is_some_and(|p| !p.is_empty())).await;
    assert_eq!(detail["pending"][0]["method"], "item/tool/requestUserInput");
    assert!(detail["turns"].as_array().unwrap().iter().flat_map(|t| t["items"].as_array().unwrap())
        .any(|i| i["type"] == "plan" && i["text"] == "# Parser plan\n- read the grammar"), "{}", detail["turns"]);
    assert_eq!(reported(&detail), Some("plan"));
    // While the turn runs, the mode is not switched, as Codex's CLI allows it only between turns.
    let before = lab.sent().len();
    let (status, answer) = lab.switch("default", generation).await;
    assert_eq!(status, 400, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("Turn 尚未结束"), "{answer}");
    assert_eq!(lab.sent().len(), before, "nothing reached Codex");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_lost_or_stale_switch_says_so_and_is_never_sent_again() {
    let lab = Lab::new("refuse").await;
    let generation = lab.connect().await;
    let before = lab.sent().len();
    let (status, answer) = lab.switch("plan", generation).await;
    assert_eq!(status, 400);
    let error = answer["error"].as_str().unwrap();
    assert!(error.contains("mode unavailable") && error.contains("模式没有改变"), "Codex's own reason: {error}");
    let view = lab.get().await;
    assert_eq!((view["reported"]["mode"].as_str(), &view["switch"]), (Some("default"), &Value::Null), "a refusal changed nothing");
    // A switch for a connection the user did not see is refused before Codex.
    let (status, answer) = lab.switch("plan", generation + 1).await;
    assert_eq!(status, 400, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("连接已变化"), "{answer}");
    assert_eq!(lab.methods_from(before), ["collaborationMode/list", "thread/settings/update", "collaborationMode/list"]);
    // No answer: unknown, never sent again. The connection it went on is gone, and its reports with it.
    lab.flags("drop");
    let before = lab.sent().len();
    let (status, answer) = lab.switch("plan", generation).await;
    assert!(status >= 400, "{answer}");
    let error = answer["error"].as_str().unwrap();
    assert!(error.contains("无法确认") && error.contains("不要重复"), "{error}");
    assert_eq!(lab.methods_from(before), ["collaborationMode/list", "thread/settings/update"], "sent once");
    for _ in 0..300 {
        if lab.get().await["reason"] == "not_connected" { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(lab.get().await["reason"], "not_connected");
    assert!(lab.detail().await.get("codexPlan").is_none());
    assert!(!lab.methods_from(before).iter().any(|m| m.starts_with("turn/") || m == "thread/start"), "never a turn or a new thread");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_this_connections_reports_of_its_own_thread_are_shown() {
    let lab = Lab::new("").await;
    let generation = lab.connect().await;
    let plan = json!({"mode":"plan","settings":{"model":"m","reasoning_effort":null,"developer_instructions":null}});
    // A sub-agent's thread, or a report of an older connection, is not this conversation's.
    lab.ws.dispatch_event("a", generation, json!({"method":"thread/settings/updated","params":{"threadId":"thread-child","threadSettings":{"collaborationMode":plan}}})).await;
    lab.ws.dispatch_event("a", generation - 1, json!({"method":"thread/settings/updated","params":{"threadId":"thread-a","threadSettings":{"collaborationMode":plan}}})).await;
    assert_eq!(reported(&lab.detail().await), Some("default"));
    lab.ws.dispatch_event("a", generation, json!({"method":"thread/settings/updated","params":{"threadId":"thread-a","threadSettings":{"collaborationMode":plan}}})).await;
    assert_eq!(reported(&lab.detail().await), Some("plan"));
    // A new connection shows only what its own resume answer reports.
    lab.ws.remove_connection("a", generation).await;
    assert!(lab.detail().await.get("codexPlan").is_none(), "disconnected: nothing is known");
    std::fs::write(lab.dir.path().join("mode"), "plan").unwrap();
    let next = lab.connect().await;
    let detail = lab.detail().await;
    assert_eq!((reported(&detail), detail["codexPlan"]["reported"]["source"].as_str(), detail["codexPlan"]["generation"].as_u64()),
        (Some("plan"), Some("resume"), Some(next)));
    let (status, answer) = lab.switch("default", generation).await;
    assert!(status == 400 && answer["error"].as_str().unwrap().contains("连接已变化"), "the old connection's view switches nothing: {answer}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_switch_whose_request_goes_away_before_codex_answers_is_left_unknown_not_sending() {
    let lab = Lab::new("hang").await;
    let generation = lab.connect().await;
    let before = lab.sent().len();
    // As when the browser's request is dropped while Core waits for Codex.
    let change: crate::codex_plan::Change = serde_json::from_value(json!({"mode":"plan","generation":generation})).unwrap();
    let ws = lab.ws.clone();
    let switch = tokio::spawn(async move { ws.codex_plan_switch("a", change).await });
    for _ in 0..300 {
        if lab.methods_from(before).iter().any(|m| m == "thread/settings/update") { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(lab.detail().await["codexPlan"]["switch"]["state"], "sending");
    switch.abort();
    assert!(switch.await.unwrap_err().is_cancelled());
    let view = lab.get().await;
    assert_eq!((view["switch"]["to"].as_str(), view["switch"]["state"].as_str(), view["reported"]["mode"].as_str()),
        (Some("plan"), Some("unknown"), Some("default")), "{view}");
    assert_eq!(lab.detail().await["codexPlan"]["switch"]["state"], "unknown");
    assert_eq!(lab.methods_from(before), ["collaborationMode/list", "thread/settings/update", "collaborationMode/list"], "sent once, never again");
    // Codex's own report still settles it.
    lab.ws.dispatch_event("a", generation, json!({"method":"thread/settings/updated","params":{"threadId":"thread-a",
        "threadSettings":{"collaborationMode":{"mode":"plan","settings":{"model":"m","reasoning_effort":"high","developer_instructions":null}}}}})).await;
    let view = lab.get().await;
    assert_eq!((view["reported"]["mode"].as_str(), &view["switch"]), (Some("plan"), &Value::Null));
}
