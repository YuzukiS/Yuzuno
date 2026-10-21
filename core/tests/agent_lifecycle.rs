//! Agent lifecycle is separate from native session history and project files.
#![cfg(target_os = "linux")]
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, sync::Arc};
use yuzuno_workspace::{model::{AgentDetail, AgentSettings, MessageInput}, store::Store, workspace::Workspace};

fn detail(cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":cwd,"model":"test","color":"sage","threadId":"native-thread","status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

#[tokio::test]
async fn remote_image_draft_only_closed_agent_can_be_deleted_without_ssh() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let ws = Workspace::new(root.clone(), "/tmp".into(), "unused".into()).unwrap();
    let mut d = detail("/tmp");
    d.agent.closed_at = Some("already-closed".into());
    d.agent.remote = Some(serde_json::from_value(json!({"machine": {
        "id":"offline", "name":"offline", "target":"-must-not-run-ssh",
        "codex":"codex", "defaultCwd":"/tmp"
    }})).unwrap());
    ws.store.insert(&d).unwrap();
    let originals = root.join("input-images/a");
    std::fs::create_dir_all(&originals).unwrap();
    let original = originals.join(format!("{}.png", "a".repeat(64)));
    std::fs::write(&original, b"retained Core draft").unwrap();
    ws.delete_agent("a").await.unwrap();
    assert!(ws.store.detail("a").is_err());
    assert_eq!(std::fs::read(original).unwrap(), b"retained Core draft");
}

#[tokio::test]
async fn remote_image_possible_transfer_requires_cleanup_even_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let ws = Workspace::new(root.clone(), "/tmp".into(), "unused".into()).unwrap();
    let mut d = detail("/tmp");
    d.agent.closed_at = Some("already-closed".into());
    d.agent.remote = Some(serde_json::from_value(json!({"machine": {
        "id":"offline", "name":"offline", "target":"-must-not-run-ssh",
        "codex":"codex", "defaultCwd":"/tmp"
    }})).unwrap());
    ws.store.insert(&d).unwrap();
    let originals = root.join("input-images/a");
    std::fs::create_dir_all(&originals).unwrap();
    let original = originals.join(format!("{}.png", "a".repeat(64)));
    std::fs::write(&original, b"retained Core original").unwrap();
    let obligation = originals.join(".remote-transfer.json");
    let record = json!({"workspace":ws.store.workspace_id().unwrap(), "agent":"a",
        "machine":"offline", "target":"-must-not-run-ssh", "harness":"codex"});
    std::fs::write(&obligation, serde_json::to_vec(&record).unwrap()).unwrap();
    // Simulate a durable pre-transfer record with no successful acknowledgement.
    // A process restart cannot turn unknown remote copies into a draft-only case.
    drop(ws);
    let ws = Workspace::new(root, "/tmp".into(), "unused".into()).unwrap();
    assert!(ws.delete_agent("a").await.is_err());
    assert!(ws.store.detail("a").unwrap().agent.closed_at.is_some());
    assert_eq!(std::fs::read(original).unwrap(), b"retained Core original");
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(obligation).unwrap()).unwrap(), record);
}

#[tokio::test]
async fn remote_image_legacy_attempt_without_marker_still_requires_cleanup() {
    for status in ["accepted", "rejected", "uncertain", "sending"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        let ws = Workspace::new(root.clone(), "/tmp".into(), "unused".into()).unwrap();
        let mut d = detail("/tmp");
        d.agent.closed_at = Some("already-closed".into());
        d.agent.remote = Some(serde_json::from_value(json!({"machine": {
            "id":"offline", "name":"offline", "target":"-must-not-run-ssh",
            "codex":"codex", "defaultCwd":"/tmp"
        }})).unwrap());
        d.message_receipts.push(serde_json::from_value(json!({
            "input":{"clientMessageId":"legacy", "text":"", "images":[format!("{}.png", "a".repeat(64))]},
            "status":status, "turnId":null, "error":null
        })).unwrap());
        ws.store.insert(&d).unwrap();
        assert!(!root.join("input-images/a/.remote-transfer.json").exists());
        assert!(ws.delete_agent("a").await.is_err(), "{status} does not prove no remote copy exists");
        let retained = ws.store.detail("a").unwrap();
        assert!(retained.agent.closed_at.is_some());
        assert_eq!(retained.message_receipts[0].status, status);
    }
}

async fn fixture() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("native.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, sys, pathlib, os, time
root = pathlib.Path(__file__).parent
state = root / 'native-session.json'
with (root / 'pids').open('a') as log: log.write(str(os.getpid())+'\n')
def emit(value): print(json.dumps(value), flush=True)
def thread():
    return json.loads(state.read_text()) if state.exists() else {'id':'native-thread','status':{'type':'idle'},'turns':[]}
for line in sys.stdin:
    req = json.loads(line)
    with (root / 'calls.jsonl').open('a') as log: log.write(json.dumps(req)+'\n')
    method, params = req.get('method'), req.get('params', {})
    if 'id' not in req: continue
    result = {}
    if method in ['thread/start','thread/resume','thread/read']: result = {'thread':thread(), 'model':'test'}
    elif method == 'turn/start':
        t = thread()
        turn = {'id':'turn-1','status':'inProgress','error':None,'items':[{'id':'input','type':'userMessage','content':params['input']}]}
        t['turns'].append(turn)
        t['status'] = {'type':'active'}
        state.write_text(json.dumps(t))
        result = {'turn':turn}
    elif method == 'turn/interrupt':
        if (root / 'reject-interrupt').exists():
            emit({'id':req['id'],'error':{'code':-32600,'message':'interrupt rejected'}})
            continue
        if (root / 'silent-interrupt').exists():
            # Acknowledged, but its end is never reported.
            emit({'id':req['id'],'result':{}})
            continue
        emit({'id':req['id'],'result':{}})
        time.sleep(0.03)
        t = thread()
        t['turns'][-1]['status'] = 'interrupted'
        t['status'] = {'type':'idle'}
        state.write_text(json.dumps(t))
        emit({'method':'turn/completed','params':{'threadId':'native-thread','turn':t['turns'][-1]}})
        continue
    emit({'id':req['id'],'result':result})
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
    ws.store.insert(&detail(&dir.path().to_string_lossy())).unwrap();
    ws.reconnect("a").await.unwrap();
    (dir, ws)
}

#[tokio::test]
async fn close_waits_for_native_interrupt_then_reopen_keeps_identity_and_session() {
    let (dir, ws) = fixture().await;
    ws.send("a", "A real native protocol fixture task".into()).await.unwrap();
    let closed = ws.close_agent("a").await.unwrap();
    assert!(closed.agent.closed_at.is_some());
    assert!(closed.agent.error.is_none(), "intentional shutdown is not an execution error");
    assert_eq!(closed.turns[0]["status"], "interrupted", "ACK alone is not completion");
    assert_eq!(closed.agent.thread_id.as_deref(), Some("native-thread"));
    let pid = std::fs::read_to_string(dir.path().join("pids")).unwrap().lines().next().unwrap().to_owned();
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists(), "close waits for owned process exit");
    let sequence = closed.agent.last_seq;
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert_eq!(ws.close_agent("a").await.unwrap().agent.last_seq, sequence, "idempotent close and late disconnect cannot mutate history");
    assert!(ws.send("a", "do not send".into()).await.is_err());
    let message: MessageInput = serde_json::from_value(json!({"clientMessageId":"nope","text":"not sent"})).unwrap();
    assert!(ws.send_message("a", message).await.is_err());
    assert!(ws.reconnect("a").await.is_err());
    assert!(ws.agent_catalog("a").await.is_err());
    assert!(ws.update_settings("a", "test".into(), AgentSettings::default()).await.is_err());
    assert_eq!(ws.store.detail("a").unwrap().agent.last_seq, sequence);
    let reopened = ws.reopen_agent("a").await.unwrap();
    assert!(reopened.agent.closed_at.is_none());
    assert_eq!(reopened.agent.id, "a");
    assert_eq!(reopened.agent.thread_id.as_deref(), Some("native-thread"));
    assert_eq!(reopened.turns, closed.turns);
    let calls: Vec<Value> = std::fs::read_to_string(dir.path().join("calls.jsonl")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(calls.iter().filter(|c| c["method"] == "turn/start").count(), 1, "reopen never replays a task");
    assert_eq!(calls.iter().filter(|c| c["method"] == "thread/start").count(), 0, "existing native session is resumed");
    ws.close_agent("a").await.unwrap();
}

#[tokio::test]
async fn failed_interrupt_does_not_hide_or_delete_a_live_agent() {
    let (dir, ws) = fixture().await;
    ws.send("a", "running".into()).await.unwrap();
    std::fs::write(dir.path().join("reject-interrupt"), "").unwrap();
    assert!(ws.delete_agent("a").await.is_err());
    let retained = ws.store.detail("a").unwrap();
    assert!(retained.agent.closed_at.is_none());
    assert_eq!(retained.turns[0]["status"], "inProgress");
    assert_eq!(retained.agent.connection_state, "connected");
    std::fs::remove_file(dir.path().join("reject-interrupt")).unwrap();
    ws.close_agent("a").await.unwrap();
}

#[tokio::test]
async fn delete_removes_workspace_history_but_preserves_project_and_native_session() {
    let (dir, ws) = fixture().await;
    let project_file = dir.path().join("project.txt");
    std::fs::write(&project_file, "keep me").unwrap();
    ws.send("a", "running".into()).await.unwrap();
    ws.delete_agent("a").await.unwrap();
    assert!(ws.store.detail("a").is_err());
    assert!(ws.store.agents().unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(project_file).unwrap(), "keep me");
    assert!(dir.path().join("native-session.json").exists());
    let db = rusqlite::Connection::open(dir.path().join("data/workspace.sqlite")).unwrap();
    let remaining: i64 = db.query_row("SELECT COUNT(*) FROM journal WHERE agent_id='a'", [], |r| r.get(0)).unwrap();
    assert_eq!(remaining, 0);
    assert!(ws.reconnect("a").await.is_err());
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(ws.store.agents().unwrap().is_empty(), "late runtime events cannot recreate a deleted Agent");
}

#[tokio::test]
async fn closed_history_survives_restart_and_stays_out_of_catchup() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let last_seq;
    let closed_at;
    {
        let ws = Workspace::new(data.clone(), "/tmp".into(), "must-not-start".into()).unwrap();
        let mut d = detail("/tmp");
        d.agent.error = Some("Historical error".into());
        d.turns.push(json!({"id":"unknown-turn","status":"inProgress","items":[]}));
        ws.store.insert(&d).unwrap();
        let closed = ws.close_agent("a").await.unwrap();
        assert_eq!(closed.turns[0]["status"], "unknown", "offline close cannot invent interruption evidence");
        assert!(ws.store.catchup().unwrap()["items"].as_array().unwrap().is_empty());
        last_seq = closed.agent.last_seq;
        closed_at = closed.agent.closed_at;
    }
    // Concurrent fixture subprocesses can briefly inherit the advisory lock
    // between fork and exec. A new Core opens it only after that handoff finishes.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let store = loop {
        match Store::open(&data.join("workspace.sqlite")) {
            Ok(store) => break store,
            Err(error) if tokio::time::Instant::now() < deadline && error.to_string().contains("独占锁") =>
                tokio::time::sleep(std::time::Duration::from_millis(5)).await,
            Err(error) => panic!("{error}"),
        }
    };
    let restored = store.detail("a").unwrap();
    assert_eq!(restored.agent.closed_at, closed_at);
    assert_eq!(restored.agent.last_seq, last_seq, "restart must not revive or rewrite closed agents");
    assert_eq!(restored.agent.thread_id.as_deref(), Some("native-thread"));
    assert!(store.catchup().unwrap()["items"].as_array().unwrap().is_empty());
}

/// POST /api/agents/{id}/reconnect: without a view, the whole record as it
/// always was; `view=summary`, only the Agent, from the same reconcile; any
/// other view is refused before anything reconnects.
#[tokio::test]
async fn reconnect_over_http_answers_the_whole_record_or_only_the_agent() {
    use axum::{body::{to_bytes, Body}, http::Request};
    use tower::ServiceExt;
    let (dir, ws) = fixture().await;
    ws.send("a", "A real native protocol fixture task".into()).await.unwrap();
    let router = yuzuno_workspace::server::router_on_port(ws.clone(), dir.path().join("assets"), 4317);
    let post = |uri: &str| {
        let request = Request::post(uri).header("host", "localhost:4317").header("x-yuzuno-client", "desktop")
            .header("content-type", "application/json").body(Body::from("{}")).unwrap();
        let router = router.clone();
        async move {
            let response = router.oneshot(request).await.unwrap();
            let status = response.status().as_u16();
            let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
            (status, body)
        }
    };
    let calls = || std::fs::read_to_string(dir.path().join("calls.jsonl")).unwrap().lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
    let methods = |calls: &[Value]| calls.iter().map(|c| c["method"].as_str().unwrap_or_default().to_owned()).collect::<Vec<_>>();

    let (before, seq) = (calls().len(), ws.store.detail("a").unwrap().agent.last_seq);
    let (status, refused) = post("/api/agents/a/reconnect?view=window").await;
    assert_eq!(status, 400);
    assert!(refused["error"].as_str().unwrap().contains("view=summary"), "{refused}");
    assert_eq!(calls().len(), before, "nothing was asked of the native session");
    assert_eq!(ws.store.detail("a").unwrap().agent.last_seq, seq, "nothing was recorded");

    // The first reconnect after a send may ask the native session more; the
    // two compared below run in the same state.
    let (status, _) = post("/api/agents/a/reconnect").await;
    assert_eq!(status, 200);
    let before_whole = calls().len();
    let (status, whole) = post("/api/agents/a/reconnect").await;
    assert_eq!(status, 200);
    assert_eq!(whole["agent"]["id"], "a");
    assert_eq!(whole["turns"].as_array().unwrap().len(), 1, "the whole record, as before");
    assert!(!whole["turns"][0]["items"].as_array().unwrap().is_empty());
    let after_whole = calls().len();

    let (status, summary) = post("/api/agents/a/reconnect?view=summary").await;
    assert_eq!(status, 200);
    assert_eq!(summary.as_object().unwrap().keys().collect::<Vec<_>>(), ["agent"], "{summary}");
    assert_eq!(summary["agent"]["id"], "a");
    assert_eq!(summary["agent"]["connectionState"], "connected");
    assert_eq!(summary["agent"]["threadId"], "native-thread", "the same session");
    let all = calls();
    assert!(methods(&all[before_whole..after_whole]).iter().any(|m| m == "thread/read"));
    assert_eq!(methods(&all[after_whole..]), methods(&all[before_whole..after_whole]), "the same native requests as without a view");
    let calls = calls();
    assert_eq!(calls.iter().filter(|c| c["method"] == "turn/start").count(), 1, "nothing was sent again");
    assert_eq!(calls.iter().filter(|c| c["method"] == "thread/start").count(), 0);
    let ids = |turns: &[Value]| turns.iter().map(|t| (t["id"].clone(),
        t["items"].as_array().unwrap().iter().map(|i| i["id"].clone()).collect::<Vec<_>>())).collect::<Vec<_>>();
    let d = ws.store.detail("a").unwrap();
    assert_eq!(ids(&d.turns), ids(whole["turns"].as_array().unwrap()), "the history is unchanged");
    ws.close_agent("a").await.unwrap();
}

/// POST /api/agents/{id}/reopen answers with the Agent as the whole record
/// has it (its project too), now without reading the history to check that
/// it was closed; the history is kept, nothing is sent again, and an Agent
/// that is open already is answered without reconnecting.
#[tokio::test]
async fn reopen_over_http_answers_the_agent_as_the_whole_record_has_it() {
    use axum::{body::{to_bytes, Body}, http::Request};
    use tower::ServiceExt;
    let (dir, ws) = fixture().await;
    let project = ws.store.create_project("P", Default::default()).unwrap();
    ws.store.set_agent_project("a", Some(&project.id)).unwrap();
    ws.send("a", "A real native protocol fixture task".into()).await.unwrap();
    let router = yuzuno_workspace::server::router_on_port(ws.clone(), dir.path().join("assets"), 4317);
    let post = |uri: &str| {
        let request = Request::post(uri).header("host", "localhost:4317").header("x-yuzuno-client", "desktop")
            .header("content-type", "application/json").body(Body::from("{}")).unwrap();
        let router = router.clone();
        async move {
            let response = router.oneshot(request).await.unwrap();
            let status = response.status().as_u16();
            let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
            (status, body)
        }
    };
    let calls = || std::fs::read_to_string(dir.path().join("calls.jsonl")).unwrap().lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();

    let (status, summary) = post("/api/agents/a/reconnect?view=summary").await;
    assert_eq!(status, 200);
    assert_eq!(summary["agent"]["projectId"], project.id.as_str(), "the summary's Agent has its project");

    let closed = ws.close_agent("a").await.unwrap();
    let before = calls().len();
    let (status, reopened) = post("/api/agents/a/reopen").await;
    assert_eq!(status, 200, "{reopened}");
    let whole = serde_json::to_value(ws.store.detail("a").unwrap().agent).unwrap();
    assert_eq!(keys(&reopened), keys(&whole), "the same Agent fields as before");
    for key in ["id", "threadId", "projectId", "workSummary", "closedAt", "harness", "cwd"] {
        assert_eq!(reopened[key], whole[key], "{key}");
    }
    assert!(reopened["closedAt"].is_null());
    assert_eq!(reopened["projectId"], project.id.as_str());
    let d = ws.store.detail("a").unwrap();
    assert_eq!(d.turns, closed.turns, "the history is kept");
    let since = &calls()[before..];
    assert!(since.iter().any(|c| matches!(c["method"].as_str(), Some("thread/resume" | "thread/read"))), "it reconnected");
    assert!(since.iter().all(|c| c["method"] != "turn/start" && c["method"] != "thread/start"), "nothing was sent again");

    let before = calls().len();
    let (status, again) = post("/api/agents/a/reopen").await;
    assert_eq!(status, 200);
    assert_eq!(again["id"], "a");
    assert!(again["closedAt"].is_null());
    assert_eq!(calls().len(), before, "an open Agent is not reconnected");
    ws.close_agent("a").await.unwrap();
}

/// An interrupt Codex acknowledges but whose end it never reports leaves the
/// Agent open: close waits its 10 s for that end, says so and changes
/// nothing; once Codex reports the end, a close goes through.
#[tokio::test]
async fn an_interrupt_never_confirmed_leaves_the_agent_open() {
    let (dir, ws) = fixture().await;
    ws.send("a", "A real native protocol fixture task".into()).await.unwrap();
    std::fs::write(dir.path().join("silent-interrupt"), "yes").unwrap();
    let before = ws.store.detail("a").unwrap();
    let started = tokio::time::Instant::now();
    let error = ws.close_agent("a").await.unwrap_err();
    assert!(error.to_string().contains("中断尚未得到原生执行结果确认"), "{error}");
    assert!(started.elapsed() >= std::time::Duration::from_secs(10), "it waited the whole 10 s");
    let after = ws.store.detail("a").unwrap();
    assert!(after.agent.closed_at.is_none(), "an unconfirmed interrupt does not close the Agent");
    assert_eq!(after.turns.len(), before.turns.len());
    assert_eq!(after.turns[0]["status"], "inProgress");

    std::fs::remove_file(dir.path().join("silent-interrupt")).unwrap();
    let closed = ws.close_agent("a").await.unwrap();
    assert!(closed.agent.closed_at.is_some());
    assert_eq!(closed.turns[0]["status"], "interrupted", "closed on Codex's own end of the Turn");
}
