//! YN-130: a Reconnect right after a Codex app-server exits. Its transport has
//! stopped, but the event loop has not yet applied `yuzuno/disconnected`, so
//! the stopped connection is still in `rpcs`. A child of `workspace`, so it
//! can hold that event and see the connection.
use super::*;
use std::os::unix::fs::PermissionsExt;

/// A Codex app-server that resumes and reads its one thread, starts a Turn,
/// and exits when told `test/exit`.
const NATIVE: &str = r#"#!/usr/bin/python3
import json, sys
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method, params = request.get('method'), request.get('params') or {}
    if method == 'test/exit': sys.exit(0)
    if 'id' not in request: continue
    result = {}
    if method in ('thread/resume', 'thread/read'):
        result = {'thread':{'id':params['threadId'],'status':{'type':'idle'},'turns':[]},'model':'test-model'}
    elif method == 'thread/turns/list': result = {'data':[],'nextCursor':None}
    elif method == 'config/read': result = {'config':{'model_context_window':None,'model_auto_compact_token_limit':None}}
    elif method == 'turn/start': result = {'turn':{'id':'turn-1','status':'inProgress','items':[]}}
    emit({'id':request['id'],'result':result})
"#;

const PATIENCE: std::time::Duration = std::time::Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reconnect_right_after_the_app_server_exits_attaches_a_new_one() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("native.py");
    std::fs::write(&script, NATIVE).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(root.path().join("data"), "/tmp".into(), script.to_string_lossy().into()).unwrap();
    ws.store.insert(&serde_json::from_value(json!({"agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp",
        "model":"test-model","color":"sage","threadId":"thread","status":"idle","createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    ws.reconnect("a").await.unwrap();
    let old = ws.rpcs.lock().unwrap().get("a").cloned().unwrap();

    // The app-server exits; its disconnect waits in the event queue.
    ws.disconnects_held.send_replace(true);
    old.rpc.send(json!({"method":"test/exit"})).await.unwrap();
    let deadline = tokio::time::Instant::now() + PATIENCE;
    while old.rpc.is_running() {
        assert!(tokio::time::Instant::now() < deadline, "the app-server did not exit");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let reconnect = tokio::spawn({
        let ws = ws.clone();
        async move { ws.reconnect("a").await }
    });
    // The disconnect stays held until the Reconnect ended or waits for it.
    let events = old.events.clone().unwrap();
    while !reconnect.is_finished() && !events.draining() {
        assert!(tokio::time::Instant::now() < deadline, "the Reconnect neither ended nor waited for the disconnect");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    ws.disconnects_held.send_replace(false);
    let reconnected = reconnect.await.unwrap();
    assert!(reconnected.is_ok(), "a Reconnect right after the app-server exited: {:#}", reconnected.unwrap_err());

    let new = ws.rpcs.lock().unwrap().get("a").cloned().unwrap();
    assert_ne!(new.generation, old.generation);
    assert!(new.rpc.is_running());
    assert_eq!(ws.detail("a").await.unwrap().agent.connection_state, "connected");
    let input = serde_json::from_value(json!({"clientMessageId":"after","text":"hello","expectedTurnId":null})).unwrap();
    assert_eq!(ws.send_message("a", input).await.unwrap().status, "accepted");
}
