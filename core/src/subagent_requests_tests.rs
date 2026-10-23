//! T-63: a Codex Agent's direct sub-agents ask for approval through it.
//! The events are the ones Codex 0.162.1 sent in the isolated probes: the
//! child's request and its resolution arrive on the parent's connection with
//! the child's thread, after the parent's `subAgentActivity` Item.
use super::*;
use std::time::Duration;

const PARENT: &str = "00000000-0000-4000-8000-000000000000";
const ALPHA: &str = "11111111-1111-4111-8111-111111111111";
const BETA: &str = "22222222-2222-4222-8222-222222222222";
const STRANGER: &str = "33333333-3333-4333-8333-333333333333";

fn activity(child: &str, path: &str) -> Value {
    json!({"type": "subAgentActivity", "id": format!("call-{child}"), "kind": "started",
        "agentThreadId": child, "agentPath": path, "model": "m", "reasoningEffort": "low"})
}

fn parent() -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
        "threadId":PARENT,"status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"turn-p","status":"inProgress","items":[
            {"type":"userMessage","id":"u","content":[]},
            activity(ALPHA, "/root/alpha"), activity(BETA, "/root/beta")]}],
        "pending":[],"artifacts":[]})).unwrap()
}

fn approval(rpc: u64, thread: &str, turn: &str, item: &str) -> Value {
    json!({"id": rpc, "method": "item/commandExecution/requestApproval", "params": {
        "kind": "command", "threadId": thread, "turnId": turn, "itemId": item, "startedAtMs": 1,
        "environmentId": "local", "command": format!("/bin/zsh -lc 'touch {item}.txt'"), "cwd": "/tmp",
        "availableDecisions": ["accept", "cancel"]}})
}

fn resolved(rpc: u64, thread: &str) -> Value {
    json!({"method": "serverRequest/resolved", "params": {"threadId": thread, "requestId": rpc}})
}

/// A connection that keeps every line Core sends to Codex.
async fn connect(ws: &Workspace, generation: u64, sent: &std::path::Path) -> Arc<Rpc> {
    let (tx, _rx) = mpsc::channel(8);
    let code = "import sys\nfor line in sys.stdin:\n  open(sys.argv[1],'a').write(line)\n";
    let rpc = Rpc::spawn("python3", &["-c".into(), code.into(), sent.display().to_string()], tx)
        .await
        .unwrap();
    ws.rpcs.lock().unwrap().insert(
        "a".into(),
        Connection { generation, rpc: rpc.clone(), closing: false, events: None, attachment: Default::default() },
    );
    rpc
}

/// What Core sent to Codex so far, one JSON value per line.
async fn sent(path: &std::path::Path, at_least: usize) -> Vec<Value> {
    for _ in 0..100 {
        let lines: Vec<Value> = std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        if lines.len() >= at_least {
            return lines;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("Core did not send {at_least} lines to Codex");
}

fn workspace(dir: &tempfile::TempDir) -> Arc<Workspace> {
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.store.insert(&parent()).unwrap();
    ws
}

fn pending(ws: &Workspace) -> Vec<PendingRequest> {
    ws.store.detail("a").unwrap().pending
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recorded_childs_approval_is_answered_from_the_parent_and_returns_to_that_child() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    let log = dir.path().join("sent.jsonl");
    let rpc = connect(&ws, 1, &log).await;
    ws.dispatch_event("a", 1, approval(0, ALPHA, "turn-alpha", "alpha")).await;
    ws.dispatch_event("a", 1, approval(1, BETA, "turn-beta", "beta")).await;
    let requests = pending(&ws);
    assert_eq!(requests.len(), 2, "both children wait in the parent's Pending");
    let alpha = requests.iter().find(|r| r.params["threadId"] == ALPHA).unwrap().clone();
    let beta = requests.iter().find(|r| r.params["threadId"] == BETA).unwrap().clone();
    assert_ne!(alpha.id, beta.id);
    assert_eq!(alpha.params["_subAgent"]["path"], "/root/alpha");
    assert_eq!(alpha.params["_subAgent"]["threadId"], ALPHA);
    assert_eq!(beta.params["_subAgent"]["path"], "/root/beta");
    let detail = ws.store.detail("a").unwrap();
    assert_eq!(detail.agent.status, "waiting");
    assert!(detail.agent.error.is_none(), "a child's approval is not an error");

    // The answer goes to that child's request id only, on the same connection.
    ws.respond(&alpha.id, json!({"decision":"accept"})).await.unwrap();
    let lines = sent(&log, 1).await;
    assert_eq!(lines, vec![json!({"id":0,"result":{"decision":"accept"}})]);
    assert!(ws.respond(&alpha.id, json!({"decision":"accept"})).await.is_err(),
        "a sent answer is not sent twice");
    // A decision the child's request does not offer is refused before sending.
    assert!(ws.respond(&beta.id, json!({"decision":"acceptForSession"})).await.is_err());

    // A resolution clears only the request of its own thread.
    ws.dispatch_event("a", 1, resolved(1, ALPHA)).await;
    assert_eq!(pending(&ws).len(), 2, "BETA's request id on ALPHA's thread clears nothing");
    ws.dispatch_event("a", 1, resolved(0, ALPHA)).await;
    let left = pending(&ws);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].params["threadId"], BETA);

    // The parent's own approvals are unchanged.
    ws.dispatch_event("a", 1, approval(2, PARENT, "turn-p", "own")).await;
    let own = pending(&ws).into_iter().find(|r| r.params["threadId"] == PARENT).unwrap();
    assert!(own.params.get("_subAgent").is_none());
    ws.respond(&own.id, json!({"decision":"cancel"})).await.unwrap();
    ws.respond(&beta.id, json!({"decision":"cancel"})).await.unwrap();
    let lines = sent(&log, 3).await;
    assert_eq!(lines[1], json!({"id":2,"result":{"decision":"cancel"}}));
    assert_eq!(lines[2], json!({"id":1,"result":{"decision":"cancel"}}));
    ws.dispatch_event("a", 1, resolved(1, BETA)).await;
    ws.dispatch_event("a", 1, resolved(2, PARENT)).await;
    assert!(pending(&ws).is_empty());
    assert_ne!(ws.store.detail("a").unwrap().agent.status, "waiting");
    rpc.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn threads_this_agent_did_not_start_and_other_child_requests_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    let log = dir.path().join("sent.jsonl");
    let rpc = connect(&ws, 1, &log).await;
    // A thread no Turn of this Agent records: refused, as before T-63.
    ws.dispatch_event("a", 1, approval(5, STRANGER, "turn-s", "stranger")).await;
    let lines = sent(&log, 1).await;
    assert_eq!(lines[0]["id"], 5);
    assert!(lines[0]["error"]["message"].as_str().unwrap().contains("no action was authorized"));
    assert!(pending(&ws).is_empty());
    assert!(ws.store.detail("a").unwrap().agent.error.unwrap().contains("其他或未知会话"));
    // A recorded child's question is not an approval: refused, naming the child.
    ws.dispatch_event("a", 1, json!({"id": 6, "method": "item/tool/requestUserInput", "params": {
        "threadId": ALPHA, "turnId": "turn-alpha", "itemId": "q", "questions": []}})).await;
    let lines = sent(&log, 2).await;
    assert_eq!(lines[1]["id"], 6);
    assert!(lines[1]["error"].is_object());
    assert!(pending(&ws).is_empty());
    assert!(ws.store.detail("a").unwrap().agent.error.unwrap().contains("/root/alpha"));
    // A child's other events stay out of the parent's record.
    let before = ws.store.detail("a").unwrap();
    ws.dispatch_event("a", 1, json!({"method": "item/started", "params": {"threadId": ALPHA,
        "turnId": "turn-alpha", "item": {"type": "agentMessage", "id": "child-reply", "text": "hi"}}})).await;
    let after = ws.store.detail("a").unwrap();
    assert_eq!(after.turns, before.turns);
    // A stranger's resolution clears nothing of the parent.
    ws.dispatch_event("a", 1, approval(7, PARENT, "turn-p", "own")).await;
    ws.dispatch_event("a", 1, resolved(7, STRANGER)).await;
    assert_eq!(pending(&ws).len(), 1);
    rpc.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_childs_request_from_an_old_connection_is_never_answered_with_a_new_decision() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    let log = dir.path().join("sent.jsonl");
    let rpc = connect(&ws, 1, &log).await;
    ws.dispatch_event("a", 1, approval(0, ALPHA, "turn-alpha", "alpha")).await;
    let old = pending(&ws).remove(0);
    ws.dispatch_event("a", 1, json!({"method": "yuzuno/disconnected", "params": {"message": "test"}})).await;
    assert!(pending(&ws)[0].stale);
    assert!(ws.respond(&old.id, json!({"decision":"accept"})).await.is_err());
    rpc.close();
    // Codex asks again on the new connection: a new request, a new action
    // token; the old token cannot answer it.
    let log2 = dir.path().join("sent2.jsonl");
    let rpc = connect(&ws, 2, &log2).await;
    ws.dispatch_event("a", 2, approval(0, ALPHA, "turn-alpha", "alpha")).await;
    let requests = pending(&ws);
    assert_eq!(requests.len(), 1, "the replay replaces the stale request");
    assert_ne!(requests[0].id, old.id);
    assert_eq!(requests[0].params["_runtimeGeneration"], 2);
    assert!(ws.respond(&old.id, json!({"decision":"accept"})).await.is_err());
    ws.respond(&requests[0].id, json!({"decision":"accept"})).await.unwrap();
    assert_eq!(sent(&log2, 1).await, vec![json!({"id":0,"result":{"decision":"accept"}})]);
    assert!(std::fs::read_to_string(&log).unwrap_or_default().is_empty(),
        "nothing was sent to the old connection");
    rpc.close();
}

fn file_started(thread: &str, item: &str, diff: &str) -> Value {
    json!({"method": "item/started", "params": {"threadId": thread, "turnId": "turn-alpha", "item": {
        "type": "fileChange", "id": item, "status": "inProgress",
        "changes": [{"path": "/tmp/alpha.md", "kind": {"type": "add"}, "diff": diff}]}}})
}

fn file_approval(rpc: u64, thread: &str, item: &str) -> Value {
    json!({"id": rpc, "method": "item/fileChange/requestApproval", "params": {"threadId": thread,
        "turnId": "turn-alpha", "itemId": item, "startedAtMs": 1, "reason": null, "grantRoot": null}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_childs_file_change_request_shows_the_changes_its_item_proposed() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    let log = dir.path().join("sent.jsonl");
    let rpc = connect(&ws, 1, &log).await;
    // As Codex sends it: the child's Item with its changes, then the request.
    ws.dispatch_event("a", 1, file_started(ALPHA, "edit", "alpha\n")).await;
    let turns = ws.store.detail("a").unwrap().turns;
    assert!(!serde_json::to_string(&turns).unwrap().contains("alpha.md"),
        "the child's Item is not written into the parent's Turns");
    ws.dispatch_event("a", 1, file_approval(0, ALPHA, "edit")).await;
    let request = pending(&ws).remove(0);
    assert_eq!(request.params["_subAgent"]["path"], "/root/alpha");
    assert_eq!(request.params["_changes"]["changes"][0]["path"], "/tmp/alpha.md");
    assert_eq!(request.params["_changes"]["changes"][0]["diff"], "alpha\n");
    assert_eq!(request.params["_changes"]["changes"][0]["truncated"], false);
    // After a reconnect Codex asks again without the Item: what was shown stays.
    ws.dispatch_event("a", 1, json!({"method": "yuzuno/disconnected", "params": {}})).await;
    rpc.close();
    let rpc = connect(&ws, 2, &log).await;
    ws.dispatch_event("a", 2, file_approval(3, ALPHA, "edit")).await;
    let replayed = pending(&ws);
    assert_eq!(replayed.len(), 1);
    assert_eq!(replayed[0].params["_changes"]["changes"][0]["diff"], "alpha\n");
    // A very long diff is cut on a character boundary, and says so.
    ws.dispatch_event("a", 2, file_started(BETA, "big", &"é".repeat(40_000))).await;
    ws.dispatch_event("a", 2, file_approval(4, BETA, "big")).await;
    let big = pending(&ws).into_iter().find(|r| r.params["threadId"] == BETA).unwrap();
    let diff = big.params["_changes"]["changes"][0]["diff"].as_str().unwrap();
    assert!(diff.len() <= 64 * 1024 && diff.chars().all(|c| c == 'é'));
    assert_eq!(big.params["_changes"]["changes"][0]["truncated"], true);
    // A thread this Agent did not start has nothing kept and its request is refused.
    ws.dispatch_event("a", 2, file_started(STRANGER, "foreign", "x\n")).await;
    ws.dispatch_event("a", 2, file_approval(5, STRANGER, "foreign")).await;
    assert_eq!(pending(&ws).len(), 2);
    assert!(ws.child_changes.take("a", STRANGER, "foreign").is_none());
    rpc.close();
}

/// A child's file change, its request and its resolution find the child in
/// the parent's `subAgentActivity` Items without reading the parent's whole
/// record, whether it is held or not (T-140); what they do is unchanged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_childs_events_find_it_without_reading_the_parents_whole_record() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    let log = dir.path().join("sent.jsonl");
    let rpc = connect(&ws, 1, &log).await;
    let reads = || crate::store::detail_reads_of("a");
    let held = |ws: &Workspace| ws.store.peek("a", |_| ()).is_some();
    // Inserted, the record is not held, and a file change commits nothing.
    assert!(!held(&ws));
    let before = reads();
    ws.dispatch_event("a", 1, file_started(ALPHA, "edit", "alpha\n")).await;
    ws.dispatch_event("a", 1, file_started(STRANGER, "foreign", "x\n")).await;
    assert!(!held(&ws));
    // The request's commit holds it.
    ws.dispatch_event("a", 1, file_approval(0, ALPHA, "edit")).await;
    assert!(held(&ws));
    ws.dispatch_event("a", 1, approval(1, BETA, "turn-beta", "beta")).await;
    ws.dispatch_event("a", 1, resolved(0, ALPHA)).await;
    ws.dispatch_event("a", 1, file_started(BETA, "edit-b", "beta\n")).await;
    ws.dispatch_event("a", 1, approval(2, STRANGER, "turn-x", "x")).await;
    assert_eq!(reads(), before, "a child's event read the parent's whole record");

    let requests = pending(&ws);
    assert_eq!(requests.len(), 1, "ALPHA's request resolved, BETA's waits, STRANGER's refused: {requests:?}");
    assert_eq!(requests[0].params["threadId"], BETA);
    assert_eq!(requests[0].params["_subAgent"]["path"], "/root/beta");
    assert!(ws.child_changes.take("a", BETA, "edit-b").is_some(), "a child's file change is kept");
    assert!(ws.child_changes.take("a", STRANGER, "foreign").is_none());
    let lines = sent(&log, 1).await;
    assert!(lines.iter().any(|l| l["id"] == 2 && l["error"]["code"] == -32601), "{lines:?}");
    rpc.close();
}

/// Codex answering `thread/turns/list` for the children: ALPHA's first Turn
/// has ended and its second still runs; BETA cannot be read.
async fn connect_codex(ws: &Workspace, generation: u64) -> Arc<Rpc> {
    let code = format!(r#"import json, sys
turns = {{"{ALPHA}": [{{"id": "turn-alpha-2", "status": "inProgress", "items": []}},
                     {{"id": "turn-alpha", "status": "completed", "items": []}}]}}
for line in sys.stdin:
    r = json.loads(line)
    if "id" not in r or "method" not in r: continue
    t = r["params"].get("threadId")
    if r["method"] == "thread/turns/list" and t in turns:
        print(json.dumps({{"id": r["id"], "result": {{"data": turns[t], "nextCursor": None}}}}), flush=True)
    else:
        print(json.dumps({{"id": r["id"], "error": {{"code": -32600, "message": "thread not found"}}}}), flush=True)
"#);
    let (tx, _rx) = mpsc::channel(8);
    let rpc = Rpc::spawn("python3", &["-c".into(), code], tx).await.unwrap();
    ws.rpcs.lock().unwrap().insert(
        "a".into(),
        Connection { generation, rpc: rpc.clone(), closing: false, events: None, attachment: Default::default() },
    );
    rpc
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn after_a_reconnect_a_childs_stale_request_goes_only_once_codex_shows_its_turn_ended() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    let log = dir.path().join("sent.jsonl");
    let rpc = connect(&ws, 1, &log).await;
    ws.dispatch_event("a", 1, approval(0, ALPHA, "turn-alpha", "first")).await;
    ws.dispatch_event("a", 1, approval(1, ALPHA, "turn-alpha-2", "second")).await;
    ws.dispatch_event("a", 1, approval(2, BETA, "turn-beta", "beta")).await;
    ws.dispatch_event("a", 1, approval(3, PARENT, "turn-p", "own")).await;
    ws.dispatch_event("a", 1, json!({"method": "yuzuno/disconnected", "params": {}})).await;
    rpc.close();
    assert!(pending(&ws).iter().all(|r| r.stale));
    let rpc = connect_codex(&ws, 2).await;
    // A settle for a connection that is no longer current changes nothing.
    ws.settle_child_requests("a", &rpc, 1).await;
    assert_eq!(pending(&ws).len(), 4);
    ws.settle_child_requests("a", &rpc, 2).await;
    let left: Vec<_> = pending(&ws).into_iter().map(|r| r.params["itemId"].clone()).collect();
    assert_eq!(left.len(), 3, "only the request of ALPHA's ended Turn went: {left:?}");
    assert!(!left.contains(&json!("first")));
    assert!(left.contains(&json!("second")), "a Turn still running keeps its request");
    assert!(left.contains(&json!("beta")), "a child Codex cannot read keeps its request");
    assert!(left.contains(&json!("own")), "the parent's own requests are left to its snapshot");
    let detail = ws.store.detail("a").unwrap();
    assert_eq!(detail.agent.pending_count, 3);
    assert_ne!(detail.agent.status, "waiting", "stale requests do not ask for you");
    rpc.close();
}
