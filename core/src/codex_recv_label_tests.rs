//! YN-221 S7c: a Codex app-server's messages are handled under the receive
//! loop's own label, `agent codex-recv`: its polls, and the store job each
//! message asks for. With the clocks off (`YUZUNO_DIAG_CPU=0`) nothing is
//! counted. A label names the loop, never an Agent or a message. A child of
//! `workspace`, as reconnect_exit_tests.rs, for its connection.
use super::*;
use std::os::unix::fs::PermissionsExt;

const LABEL: &str = "agent codex-recv";
/// An Agent id that must not appear in any label.
const AGENT: &str = "recv-agent-7f3a";

/// A Codex app-server that resumes its one thread and, told `test/notify`,
/// sends five notices.
const NATIVE: &str = r#"#!/usr/bin/python3
import json, sys
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method, params = request.get('method'), request.get('params') or {}
    if method == 'test/notify':
        for n in range(5): emit({'method':'test/notice','params':{'n':n,'text':'notice-text-sentinel'}})
        continue
    if 'id' not in request: continue
    result = {}
    if method in ('thread/resume', 'thread/read'):
        result = {'thread':{'id':params['threadId'],'status':{'type':'idle'},'turns':[]},'model':'test-model'}
    elif method == 'thread/turns/list': result = {'data':[],'nextCursor':None}
    elif method == 'config/read': result = {'config':{'model_context_window':None,'model_auto_compact_token_limit':None}}
    emit({'id':request['id'],'result':result})
"#;

/// This label's polls and store jobs in the runtime report, and every label's name.
fn counted(ws: &Workspace) -> (u64, u64, Vec<String>) {
    let report = crate::runtime_diag::report(ws);
    let labels = report["cpu"]["labels"].as_array().cloned().unwrap_or_default();
    let names = labels.iter().filter_map(|l| l["label"].as_str().map(str::to_owned)).collect();
    let this = labels.iter().find(|l| l["label"] == LABEL);
    let field = |name: &str| this.and_then(|l| l[name].as_u64()).unwrap_or(0);
    (field("polls"), field("storeJobs"), names)
}

/// A connected Agent, its app-server told to send its notices, and the counts once they are handled.
async fn notices() -> ((u64, u64, Vec<String>), (u64, u64, Vec<String>)) {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("native.py");
    std::fs::write(&script, NATIVE).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(root.path().join("data"), "/tmp".into(), script.to_string_lossy().into()).unwrap();
    ws.store.insert(&serde_json::from_value(json!({"agent":{"id":AGENT,"name":"A","goal":"test","cwd":"/tmp",
        "model":"test-model","color":"sage","threadId":"thread","status":"idle","createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    ws.reconnect(AGENT).await.unwrap();
    let connection = ws.rpcs.lock().unwrap().get(AGENT).cloned().unwrap();
    let before = counted(&ws);
    connection.rpc.send(json!({"method":"test/notify"})).await.unwrap();
    // Each notice is handled once the store job it asked for has ended; with the clocks off there is nothing to wait for.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while crate::runtime_diag::cpu_enabled() && counted(&ws).1 < before.1 + 5 {
        assert!(tokio::time::Instant::now() < deadline, "the notices were not handled: {:?}", counted(&ws));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    (before, counted(&ws))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_codex_message_and_its_store_job_count_under_the_receive_loop_label() {
    if !crate::runtime_diag::cpu_enabled() {
        return; // This process was started with the clocks off; the test below covers that.
    }
    let (before, after) = notices().await;
    assert!(after.0 > before.0, "the loop's polls are counted: {before:?} {after:?}");
    // At least its five notices; a connection may send others of its own as it starts.
    assert!(after.1 >= before.1 + 5, "each notice's store job is counted under the loop: {before:?} {after:?}");
    assert!(after.2.iter().all(|name| !name.contains(AGENT) && !name.contains("notice-text-sentinel") && !name.contains("test/notice")),
        "no Agent or message in a label: {:?}", after.2);
}

/// Run by the test below in a process of its own with `YUZUNO_DIAG_CPU=0`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "run with YUZUNO_DIAG_CPU=0 by with_the_clocks_off_nothing_is_counted"]
async fn clocks_off_child() {
    assert!(!crate::runtime_diag::cpu_enabled(), "YUZUNO_DIAG_CPU=0 turns the clocks off");
    let (before, after) = notices().await;
    assert_eq!((before.0, before.1), (0, 0));
    assert_eq!((after.0, after.1), (0, 0), "nothing counted under {LABEL}");
    assert!(after.2.is_empty(), "no label at all: {:?}", after.2);
}

#[test]
fn with_the_clocks_off_nothing_is_counted() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "workspace::codex_recv_label_tests::clocks_off_child", "--ignored", "--nocapture", "--test-threads=1"])
        .env("YUZUNO_DIAG_CPU", "0")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success() && text.contains("1 passed"), "{text}\n{}", String::from_utf8_lossy(&output.stderr));
}
