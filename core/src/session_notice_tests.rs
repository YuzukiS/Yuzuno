//! YN-5: a session Core attaches again after what Core gives it changed (its
//! Yuzuno tools, or the text it starts with) is told so once, in the
//! conversation, by a mail from Core. Claude Code keeps the tool definitions
//! it loaded and the system prompt it started with for the whole
//! conversation (YN-5 labs r1b, r3, r3b), so a resumed session would
//! otherwise act on stale ones. Nothing is said when nothing changed, nor to a
//! session the record does not describe.
use crate::workspace::Workspace;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

/// What an earlier Core gave `agent`'s session: task_dispatch with another
/// description and executor parameter, and other start text (and, with
/// `native`, a record of another session). The table is created when
/// missing, so this runs against a Core that keeps no such record.
fn attached_earlier(ws: &Workspace, agent: &str, native: Option<&str>) {
    let db = ws.store.db.write().unwrap();
    db.execute_batch("CREATE TABLE IF NOT EXISTS session_baselines(agent_id TEXT PRIMARY KEY, native_id TEXT,
        tools TEXT NOT NULL, start_text TEXT NOT NULL, updated_at TEXT NOT NULL)").unwrap();
    db.execute("UPDATE session_baselines SET start_text='earlier', native_id=COALESCE(?2,native_id),
        tools=json_set(tools,'$.task_dispatch.description','earlier','$.task_dispatch.parameters.executor','earlier')
        WHERE agent_id=?1", rusqlite::params![agent, native]).unwrap();
}

/// Core's notices in `agent`'s mailbox, as the Agent reads them.
async fn notices(ws: &Arc<Workspace>, agent: &str) -> Vec<Value> {
    let read = ws.collaboration_call(Some(agent), "peer_read", json!({"afterSeq":0,"limit":200})).await.unwrap();
    read["messages"].as_array().unwrap().iter()
        .filter(|m| m["sender"]["id"] == "core" && m["metadata"]["kind"] == "session_changed")
        .cloned().collect()
}

/// What the notice for `attached_earlier` says: the changed tool with only
/// its changed parts, and the start text as it is now.
fn says_what_changed(body: &str) {
    assert!(body.contains("- changed: task_dispatch"), "{body}");
    assert!(body.contains("task_dispatch:\n  description: \"Assign an existing task"), "the current description: {body}");
    assert!(body.contains("  parameter executor: {"), "the current executor parameter: {body}");
    assert!(!body.contains("parameter materials"), "nothing that did not change: {body}");
    assert!(body.contains(crate::guide::session_notice()), "the start text now: {body}");
}

/// A local Codex app-server standing in: thread `native-thread`, idle, no
/// background terminals; every call is logged to calls.jsonl.
const CODEX: &str = r#"#!/usr/bin/python3
import json, sys, pathlib
root = pathlib.Path(__file__).parent
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
    with (root / 'calls.jsonl').open('a') as log: log.write(json.dumps({'method': req.get('method')}) + '\n')
    if 'id' not in req: continue
    method = req.get('method')
    if method == 'thread/turns/list': sys.stdout.ids.add(req['id']); method = 'thread/read'
    result = {}
    if method in ['thread/start', 'thread/resume', 'thread/read']:
        result = {'thread': {'id': 'native-thread', 'status': {'type': 'idle'}, 'turns': []}, 'model': 'test'}
    elif method == 'config/read':
        result = {'config': {}}
    elif method == 'thread/backgroundTerminals/list':
        result = {'data': [], 'nextCursor': None}
    print(json.dumps({'id': req['id'], 'result': result}), flush=True)
"#;

/// A Codex Agent with the Workspace MCP, thread `native-thread`, attached once.
async fn codex() -> (tempfile::TempDir, Arc<Workspace>) {
    codex_with(None).await
}

/// `codex`, with these Brief rules in place before the first attach.
async fn codex_with(rules: Option<Arc<Rules>>) -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("codex.py");
    std::fs::write(&script, CODEX).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
    ws.collaboration_url.set("http://127.0.0.1:4999".into()).unwrap();
    if let Some(rules) = rules {
        ws.brief_turns.set_seam(rules);
    }
    let detail: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{
        "id":"a","name":"A","cwd":dir.path(),"model":"","color":"sage","threadId":"native-thread","harness":"codex",
        "status":"offline","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
    ws.reconnect("a").await.unwrap();
    (dir, ws)
}

/// The Brief's rules as the turn-end check reads them: a Project's Agent's
/// session starts with them; `unreadable` makes that read fail, as a
/// one-off database error would.
#[derive(Default)]
struct Rules {
    member: std::sync::atomic::AtomicBool,
    unreadable: std::sync::atomic::AtomicBool,
}

impl crate::brief_turns::Seam for Rules {
    fn hard_rules(&self) -> String {
        "BRIEF HARD RULES: call brief_update every turn.".into()
    }
    fn requires(&self, _: &crate::store::Store, _: &str) -> anyhow::Result<Option<String>> {
        use std::sync::atomic::Ordering::SeqCst;
        anyhow::ensure!(!self.unreadable.load(SeqCst), "database is locked");
        Ok(self.member.load(SeqCst).then(|| "p1".to_owned()))
    }
    fn receipt(&self, _: &crate::store::Store, _: &str, _: &str) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
    fn record(&self, _: &crate::store::Store, _: &str, _: &str, _: &str, _: &str) -> anyhow::Result<bool> {
        Ok(true)
    }
    fn outcome(&self, _: &crate::store::Store, _: &str, _: &str) -> anyhow::Result<Option<(String, u32)>> {
        Ok(None)
    }
}

/// Core lets the session go and attaches it again, as across an update:
/// the native thread or session is resumed, not replaced.
async fn attach_again(ws: &Arc<Workspace>, agent: &str) {
    ws.disconnect_agent(agent).await.unwrap();
    ws.reconnect(agent).await.unwrap();
    assert_eq!(ws.store.agent(agent).unwrap().connection_state, "connected");
}

#[tokio::test]
async fn a_resumed_codex_thread_is_told_once_what_changed_since_it_was_attached() {
    let (dir, ws) = codex().await;
    attached_earlier(&ws, "a", None);
    attach_again(&ws, "a").await;
    let calls = std::fs::read_to_string(dir.path().join("calls.jsonl")).unwrap();
    assert_eq!(calls.matches("\"thread/resume\"").count(), 2, "resumed both times, never started anew: {calls}");
    let told = notices(&ws, "a").await;
    assert_eq!(told.len(), 1, "one notice once the tools and the start text changed: {told:?}");
    says_what_changed(told[0]["body"].as_str().unwrap());
    attach_again(&ws, "a").await;
    assert_eq!(notices(&ws, "a").await.len(), 1, "told once: nothing changed since");
}

#[tokio::test]
async fn nothing_is_said_when_nothing_changed_or_the_record_is_of_another_session() {
    let (_dir, ws) = codex().await;
    attach_again(&ws, "a").await;
    assert!(notices(&ws, "a").await.is_empty(), "unchanged");
    attached_earlier(&ws, "a", Some("another-thread"));
    attach_again(&ws, "a").await;
    assert!(notices(&ws, "a").await.is_empty(), "what another session was given says nothing of this one");
    attach_again(&ws, "a").await;
    assert!(notices(&ws, "a").await.is_empty(), "and the record now describes this one, unchanged");
}

/// YN-5 R1: a failed read of the Brief rules says nothing about them. The
/// attach that fails to read them says nothing and leaves the record as it
/// was; the next one, unchanged, says nothing either; a real change still
/// does.
#[tokio::test]
async fn an_unreadable_start_text_is_no_change_and_a_real_one_still_notices() {
    use std::sync::atomic::Ordering::SeqCst;
    let rules = Arc::new(Rules::default());
    rules.member.store(true, SeqCst);
    let (_dir, ws) = codex_with(Some(rules.clone())).await;
    let recorded = || ws.store.db.read().unwrap()
        .query_row("SELECT start_text FROM session_baselines WHERE agent_id='a'", [], |r| r.get::<_, String>(0)).unwrap();
    let first = recorded();
    rules.unreadable.store(true, SeqCst);
    attach_again(&ws, "a").await;
    assert!(notices(&ws, "a").await.is_empty(), "an unreadable rule set is no change");
    assert_eq!(recorded(), first, "the record keeps what the session was given");
    rules.unreadable.store(false, SeqCst);
    attach_again(&ws, "a").await;
    assert!(notices(&ws, "a").await.is_empty(), "read again, the same as before");
    // No longer a Project's Agent: its sessions start without the rules.
    rules.member.store(false, SeqCst);
    attach_again(&ws, "a").await;
    let told = notices(&ws, "a").await;
    assert_eq!(told.len(), 1, "a real change still notices: {told:?}");
    let body = told[0]["body"].as_str().unwrap();
    assert!(body.contains("The text Core gives a session as it starts") && !body.contains("BRIEF HARD RULES"), "{body}");
}

#[tokio::test]
async fn a_resumed_claude_session_is_told_once_what_changed_since_it_was_attached() {
    struct Restore(Option<std::ffi::OsString>);
    impl Drop for Restore {
        fn drop(&mut self) {
            match &self.0 {
                Some(value) => std::env::set_var("YUZUNO_CLAUDE_BRIDGE", value),
                None => std::env::remove_var("YUZUNO_CLAUDE_BRIDGE"),
            }
        }
    }
    const SESSION: &str = "e0e0e0e0-0000-4000-8000-000000000075";
    let _env = crate::claude::BRIDGE_ENV.lock().await;
    let _restore = Restore(std::env::var_os("YUZUNO_CLAUDE_BRIDGE"));
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/session_notice_bridge.mjs"));
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.collaboration_url.set("http://127.0.0.1:4999".into()).unwrap();
    let agent = ws.claude_create("Notice".into(), String::new(), dir.path().to_string_lossy().into(), "fixture".into(), None)
        .await.unwrap();
    let id = agent.id.as_str();
    for _ in 0..400 {
        if ws.store.agent(id).unwrap().connection_state == "connected" { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // The start runs in the background under the Agent's gate, its record
    // last: wait for all of it, as Core's own calls on this Agent do.
    drop(ws.gate(id).await.lock().await);
    // Its first Turn named the session, as Claude does.
    ws.store.update(id, "test/session", &json!({}), |d| d.agent.claude_session_id = Some(SESSION.into())).unwrap();
    attached_earlier(&ws, id, None);
    attach_again(&ws, id).await;
    let starts = std::fs::read_to_string(dir.path().join("starts.jsonl")).unwrap();
    let last: Value = serde_json::from_str(starts.lines().last().unwrap()).unwrap();
    assert_eq!(last["resume"], SESSION, "the session was resumed: {starts}");
    let told = notices(&ws, id).await;
    assert_eq!(told.len(), 1, "one notice once the tools and the start text changed: {told:?}");
    says_what_changed(told[0]["body"].as_str().unwrap());
    attach_again(&ws, id).await;
    assert_eq!(notices(&ws, id).await.len(), 1, "told once: nothing changed since");
}
