//! T-184: the user's Disconnect. An idle local Codex or Claude Agent's native
//! session stops; the Agent stays open with its identity, session, history
//! and settings; nothing starts it again (a send, a message, a second
//! Disconnect) until the user's Reconnect, which resumes the same session;
//! the choice survives a Core restart. Work or doubt refuses and changes
//! nothing: a running Turn, a background terminal, a list Codex doesn't
//! answer, a sub-agent still running. Scripted runtimes only: a fake Codex
//! app-server (as agent_lifecycle.rs has it) and the real Claude bridge over
//! a scripted SDK (tests/fixtures/claude_quota_bridge.mjs). No model, account,
//! daily Core or real connection is used.
#![cfg(target_os = "linux")]
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::Path, sync::Arc, time::Duration};
use yuzuno_workspace::{model::{AgentDetail, MessageInput}, workspace::Workspace};

/// The fake Codex app-server, as agent_lifecycle.rs's, which also lists
/// background terminals (`terminals.json`, failing while `terminals-fail`
/// exists; a sub-agent's are `terminals-<thread>.json` and
/// `terminals-fail-<thread>`) and reads sub-agents (`children.json`: thread
/// id to status).
const NATIVE: &str = r#"#!/usr/bin/python3
import json, sys, pathlib, os
root = pathlib.Path(__file__).parent
state = root / 'native-session.json'
with (root / 'pids').open('a') as log: log.write(str(os.getpid())+'\n')
def emit(value): print(json.dumps(value), flush=True)
def thread():
    return json.loads(state.read_text()) if state.exists() else {'id':'native-thread','status':{'type':'idle'},'turns':[]}
def read(name, default):
    path = root / name
    return json.loads(path.read_text()) if path.exists() else default
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
    req = json.loads(line)
    with (root / 'calls.jsonl').open('a') as log: log.write(json.dumps(req)+'\n')
    method, params = req.get('method'), req.get('params', {})
    if 'id' not in req: continue
    if method=='thread/turns/list': sys.stdout.ids.add(req['id']); method='thread/read'
    result = {}
    if method == 'thread/read' and params.get('threadId') not in (None, 'native-thread'):
        child = params['threadId']
        result = {'thread': {'id': child, 'parentThreadId': 'native-thread', 'status': {'type': read('children.json', {}).get(child, 'notLoaded')}}}
    elif method in ['thread/start','thread/resume','thread/read']: result = {'thread':thread(), 'model':'test'}
    elif method == 'thread/backgroundTerminals/list':
        suffix = '' if params.get('threadId') in (None, 'native-thread') else '-' + params['threadId']
        if (root / ('terminals-fail' + suffix)).exists():
            emit({'id':req['id'],'error':{'code':-32603,'message':'list failed'}})
            continue
        result = {'data': read('terminals' + suffix + '.json', []), 'nextCursor': None}
    elif method == 'turn/start':
        t = thread()
        turn = {'id':'turn-1','status':'inProgress','error':None,'items':[{'id':'input','type':'userMessage','content':params['input']}]}
        t['turns'].append(turn)
        t['status'] = {'type':'active'}
        state.write_text(json.dumps(t))
        result = {'turn':turn}
    emit({'id':req['id'],'result':result})
"#;

fn detail(cwd: &str, turns: Value) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":cwd,"model":"test","color":"sage","threadId":"native-thread","status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":turns,"pending":[],"artifacts":[]})).unwrap()
}

/// A local Codex Agent, connected and idle, over the fake app-server.
async fn codex(turns: Value) -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("native.py");
    std::fs::write(&script, NATIVE).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
    ws.store.insert(&detail(&dir.path().to_string_lossy(), turns)).unwrap();
    ws.reconnect("a").await.unwrap();
    assert_eq!(ws.store.detail("a").unwrap().agent.connection_state, "connected");
    (dir, ws)
}

fn calls(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join("calls.jsonl")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn pids(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("pids")).unwrap_or_default().lines().map(str::to_owned).collect()
}

fn alive(pid: &str) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// Kept as it was: connected, not disconnected, its process running.
fn kept(ws: &Workspace, dir: &Path) {
    let d = ws.store.detail("a").unwrap();
    assert_eq!(d.agent.connection_state, "connected", "the connection stays");
    assert!(d.agent.disconnected_at.is_none() && d.agent.closed_at.is_none());
    assert!(alive(pids(dir).last().unwrap()), "the native process still runs");
}

#[tokio::test]
async fn an_idle_codex_agent_disconnects_stays_open_and_starts_again_only_when_the_user_reconnects() {
    let (dir, ws) = codex(json!([{"id":"t0","status":"completed","items":[]}])).await;
    let before = ws.store.detail("a").unwrap();
    let agent = ws.disconnect_agent("a").await.unwrap();
    assert!(agent.disconnected_at.is_some(), "the user's choice is recorded");
    assert!(agent.closed_at.is_none(), "the Agent stays open: not Close");
    assert_eq!((agent.status.as_str(), agent.connection_state.as_str()), ("offline", "disconnected"));
    assert_eq!(agent.thread_id.as_deref(), Some("native-thread"));
    let first = pids(dir.path()).first().unwrap().clone();
    assert!(!alive(&first), "the native session stopped");

    // Nothing starts it again: a send, a message, a second Disconnect.
    let seen = calls(dir.path()).len();
    let refused = ws.send("a", "not now".into()).await.unwrap_err().to_string();
    assert!(refused.contains("disconnected"), "{refused}");
    let message: MessageInput = serde_json::from_value(json!({"clientMessageId":"m1","text":"not now either"})).unwrap();
    assert!(ws.send_message("a", message).await.unwrap_err().to_string().contains("disconnected"));
    assert!(ws.disconnect_agent("a").await.is_err(), "already disconnected");
    assert_eq!(calls(dir.path()).len(), seen, "nothing reached Codex");
    assert_eq!(pids(dir.path()).len(), 1, "no native process was started");
    let d = ws.store.detail("a").unwrap();
    assert!(d.message_receipts.is_empty(), "the refused send left nothing half-sent");
    assert_eq!(d.turns, before.turns, "history is as it was");

    // The choice survives a Core restart.
    drop(ws);
    let program = dir.path().join("native.py").to_string_lossy().into_owned();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), program).unwrap();
    let restarted = ws.store.detail("a").unwrap();
    assert!(restarted.agent.disconnected_at.is_some());
    assert!(ws.send("a", "still not".into()).await.is_err());
    assert_eq!(pids(dir.path()).len(), 1);

    // The user's Reconnect resumes the same session; then it can work.
    let reconnected = ws.reconnect("a").await.unwrap();
    assert!(reconnected.agent.disconnected_at.is_none());
    assert_eq!(reconnected.agent.connection_state, "connected");
    assert_eq!(reconnected.agent.thread_id.as_deref(), Some("native-thread"));
    // The reconnect answers with the window: the whole short history here.
    let unsliced: Vec<Value> = reconnected.turns.iter().cloned().map(|mut t| {
        t.as_object_mut().unwrap().remove("_yuzunoSlice");
        t
    }).collect();
    assert_eq!(unsliced, before.turns);
    let after = calls(dir.path());
    assert!(after[seen..].iter().any(|c| c["method"] == "thread/resume" && c["params"]["threadId"] == "native-thread"), "the same thread");
    assert!(!after.iter().any(|c| c["method"] == "thread/start"), "never another session");
    assert!(!after.iter().any(|c| c["method"] == "turn/start"), "nothing was sent for it");
    ws.send("a", "now go on".into()).await.unwrap();
    assert_eq!(calls(dir.path()).iter().filter(|c| c["method"] == "turn/start").count(), 1);
}

#[tokio::test]
async fn work_or_doubt_refuses_a_codex_disconnect_and_changes_nothing() {
    // A sub-agent this Agent started, per its own record.
    let (dir, ws) = codex(json!([{"id":"t0","status":"completed","items":[
        {"id":"started-c1","type":"subAgentActivity","kind":"started","agentThreadId":"c1"}]}])).await;
    let refuse = |error: anyhow::Error, what: &str| {
        let error = error.to_string();
        assert!(error.starts_with("Not disconnected") && error.contains(what), "{error}");
    };

    std::fs::write(dir.path().join("terminals.json"), r#"[{"id":"sleep 600"}]"#).unwrap();
    refuse(ws.disconnect_agent("a").await.unwrap_err(), "1 background terminal");
    kept(&ws, dir.path());
    std::fs::remove_file(dir.path().join("terminals.json")).unwrap();

    std::fs::write(dir.path().join("terminals-fail"), "").unwrap();
    refuse(ws.disconnect_agent("a").await.unwrap_err(), "didn't say whether background terminals");
    kept(&ws, dir.path());
    std::fs::remove_file(dir.path().join("terminals-fail")).unwrap();

    std::fs::write(dir.path().join("children.json"), r#"{"c1":"active"}"#).unwrap();
    refuse(ws.disconnect_agent("a").await.unwrap_err(), "sub-agent c1");
    kept(&ws, dir.path());
    std::fs::write(dir.path().join("children.json"), r#"{"c1":"idle"}"#).unwrap();

    // A sub-agent at rest may still have left a terminal running.
    std::fs::write(dir.path().join("terminals-c1.json"), r#"[{"id":"tail -f build.log"}]"#).unwrap();
    refuse(ws.disconnect_agent("a").await.unwrap_err(), "sub-agent c1 has 1 background terminal");
    kept(&ws, dir.path());
    std::fs::remove_file(dir.path().join("terminals-c1.json")).unwrap();
    std::fs::write(dir.path().join("terminals-fail-c1"), "").unwrap();
    refuse(ws.disconnect_agent("a").await.unwrap_err(), "whether sub-agent c1's background terminals");
    kept(&ws, dir.path());
    std::fs::remove_file(dir.path().join("terminals-fail-c1")).unwrap();

    ws.send("a", "a task that runs".into()).await.unwrap();
    refuse(ws.disconnect_agent("a").await.unwrap_err(), "running");
    kept(&ws, dir.path());
    assert_eq!(pids(dir.path()).len(), 1, "every refusal kept the same process");
    assert!(!calls(dir.path()).iter().any(|c| c["method"] == "turn/interrupt"), "a refusal interrupts nothing");
}

async fn until(ws: &Workspace, id: &str, what: &str, done: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
    for _ in 0..800 {
        let d = ws.store.detail(id).unwrap();
        if done(&d) {
            return d;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

fn prompts(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path).unwrap_or_default().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["text"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn an_idle_claude_agent_disconnects_and_only_the_users_reconnect_resumes_its_session() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let log = dir.path().join("prompts.jsonl");
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_quota_bridge.mjs"));
    std::env::set_var("YUZUNO_TEST_CLAUDE_PROMPTS", &log);
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let id = ws.claude_create("C".into(), String::new(), dir.path().to_string_lossy().into(), "m".into(), None).await.unwrap().id;
    until(&ws, &id, "the bridge", |d| d.agent.connection_state == "connected").await;
    let turn = ws.claude_send(&id, "hello".into()).await.unwrap()["turnId"].as_str().unwrap().to_owned();
    let done = until(&ws, &id, "the first turn", |d| d.turns.iter().any(|t| t["id"] == turn.as_str() && t["status"] != "inProgress") && d.agent.status == "idle").await;
    let session = done.agent.claude_session_id.clone();
    assert!(session.is_some());

    let agent = ws.disconnect_agent(&id).await.unwrap();
    assert!(agent.disconnected_at.is_some() && agent.closed_at.is_none());
    assert_eq!((agent.status.as_str(), agent.connection_state.as_str()), ("offline", "disconnected"));
    assert!(ws.claude_send(&id, "not now".into()).await.unwrap_err().to_string().contains("disconnected"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(prompts(&log), vec!["hello".to_owned()], "nothing was sent while disconnected");
    let still = ws.store.detail(&id).unwrap();
    assert_eq!((still.agent.connection_state.as_str(), still.agent.disconnected_at.is_some()), ("disconnected", true), "nothing reconnected it");

    let reconnected = ws.reconnect(&id).await.unwrap();
    assert!(reconnected.agent.disconnected_at.is_none());
    until(&ws, &id, "the reconnected bridge", |d| d.agent.connection_state == "connected").await;
    assert_eq!(ws.store.detail(&id).unwrap().agent.claude_session_id, session, "the same Claude session");
    let again = ws.claude_send(&id, "again".into()).await.unwrap()["turnId"].as_str().unwrap().to_owned();
    until(&ws, &id, "the second turn", |d| d.turns.iter().any(|t| t["id"] == again.as_str() && t["status"] != "inProgress")).await;
    assert_eq!(prompts(&log), vec!["hello".to_owned(), "again".to_owned()]);
}
