//! T-120: a native request's resolution and a thread status change are
//! committed as metadata (`apply_metadata_event`), without copying a long
//! record, and leave what applying them to the whole record leaves; so is a
//! thread's start (T-140).
use super::*;

fn record(status: &str, running: bool) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
        "threadId":"thread-a","status":status,"connectionState":"connected","createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"t1","status":"completed","items":[
                {"id":"u1","type":"userMessage","clientId":"sent-1","content":[{"type":"text","text":"first"}]}]},
            {"id":"t2","status":if running { "inProgress" } else { "completed" },"items":[]}],
        "messageReceipts":[{"input":{"clientMessageId":"sent-1","text":"first"},"status":"accepted","turnId":"t1"}],
        "pending":[],"artifacts":[]})).unwrap()
}

fn request(id: &str, method: &str, rpc: u64, generation: u64, extra: Value) -> PendingRequest {
    let mut params = json!({"threadId":"thread-a","turnId":"t2","itemId":id,"_rpcId":rpc,"_runtimeGeneration":generation});
    for (key, value) in extra.as_object().unwrap() { params[key] = value.clone(); }
    PendingRequest { id: id.into(), agent_id: "a".into(), method: method.into(), params, created_at: now(), stale: false }
}

fn approval(id: &str, rpc: u64, generation: u64) -> PendingRequest {
    request(id, "item/commandExecution/requestApproval", rpc, generation, json!({}))
}

/// The Agent, its pending requests and receipts, without the update time
/// (each side reads the clock).
fn metadata(d: &AgentDetail) -> Value {
    let mut agent = serde_json::to_value(&d.agent).unwrap();
    agent["updatedAt"] = json!(0);
    json!({"agent":agent,"pending":d.pending,"receipts":d.message_receipts})
}

/// Every resolution and status a record can be in when one arrives: the one
/// blocking request, one of two, a non-blocking question, a request of
/// another connection or thread, and each thread status, against each Agent
/// status, with and without a running Turn. The metadata commit gets the
/// running Turn as `metadata_event` reads it; both leave the same Agent.
#[test]
fn a_resolution_or_status_change_on_the_metadata_leaves_what_the_whole_record_leaves() {
    let question = request("q", "item/tool/requestUserInput", 9, 1, json!({"isBlocking":false}));
    let pendings: Vec<Vec<PendingRequest>> = vec![
        vec![],
        vec![approval("p", 7, 1)],
        vec![approval("p", 7, 1), approval("p2", 8, 1)],
        vec![approval("p", 7, 1), question.clone()],
        vec![question],
        vec![approval("p", 7, 2)],
        vec![request("p", "item/commandExecution/requestApproval", 7, 1, json!({"threadId":"child"}))],
        vec![PendingRequest { stale: true, ..approval("p", 7, 1) }],
    ];
    let events = [
        ("serverRequest/resolved", json!({"threadId":"thread-a","requestId":7,"_runtimeGeneration":1})),
        ("serverRequest/resolved", json!({"requestId":7,"_runtimeGeneration":1})),
        ("serverRequest/resolved", json!({"threadId":"thread-a","requestId":9,"_runtimeGeneration":1})),
        ("serverRequest/resolved", json!({"threadId":"thread-a","requestId":42,"_runtimeGeneration":1})),
        ("thread/status/changed", json!({"threadId":"thread-a","status":{"type":"systemError"}})),
        ("thread/status/changed", json!({"threadId":"thread-a","status":{"type":"active","activeFlags":[]}})),
        ("thread/status/changed", json!({"threadId":"thread-a","status":{"type":"idle"}})),
    ];
    let mut checked = 0;
    for status in ["waiting", "working", "idle", "error", "offline", "uncertain"] {
        for running in [true, false] {
            for pending in &pendings {
                for (method, p) in &events {
                    let mut before = record(status, running);
                    // Bound as a stored record's receipts are.
                    crate::message_content::bind(&mut before.turns, &mut before.message_receipts);
                    before.pending = pending.clone();
                    before.agent.pending_count = pending.len() as u64;
                    let mut whole = before.clone();
                    whole.apply(method, p);
                    let mut meta = before.clone();
                    let running = meta.turns.iter().any(|t| t["status"] == "inProgress");
                    apply_metadata_event(&mut crate::store::Meta {
                        agent: &mut meta.agent, message_receipts: &mut meta.message_receipts, pending: &mut meta.pending,
                        claude_runtime: &mut meta.claude_runtime,
                    }, method, p, running);
                    // Set by `Store::update_meta`, as by the whole-record commit.
                    meta.agent.pending_count = meta.pending.len() as u64;
                    assert_eq!(metadata(&meta), metadata(&whole), "{status} running={running} {method} {p} pending={pending:?}");
                    assert_eq!(serde_json::to_value(&whole.turns).unwrap(), serde_json::to_value(&before.turns).unwrap(), "{method} changed a Turn");
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 6 * 2 * 8 * 7);
}

/// A harmless stdin sink standing in for the native connection.
async fn connect(ws: &Workspace, generation: u64) -> Arc<Rpc> {
    let (tx, _rx) = mpsc::channel(8);
    let rpc = Rpc::spawn("python3", &["-c".into(), "import sys; sys.stdin.read()".into()], tx).await.unwrap();
    ws.rpcs.lock().unwrap().insert("a".into(), Connection { generation, rpc: rpc.clone(), closing: false, events: None, attachment: Default::default() });
    rpc
}

fn in_place() -> u64 {
    crate::store::META_IN_PLACE.with(|n| n.get())
}

fn kinds(ws: &Workspace) -> Vec<(String, Value)> {
    let db = rusqlite::Connection::open(ws.data_dir.join("workspace.sqlite")).unwrap();
    let mut query = db.prepare("SELECT kind, data FROM journal WHERE agent_id='a' ORDER BY seq").unwrap();
    query.query_map([], |r| Ok((r.get::<_, String>(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap())))
        .unwrap().map(Result::unwrap).collect()
}

/// Events arrive on the ownership lock's thread (`dispatch_event`); here
/// the test thread calls `on_event` the same way, so the commit counts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resolution_and_a_status_change_are_committed_as_metadata_and_accept_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let mut d = record("waiting", true);
    d.pending = vec![approval("p", 7, 1), PendingRequest { stale: true, ..approval("old", 7, 0) }];
    ws.store.insert(&d).unwrap();
    // Held, as a streaming Agent's record is.
    ws.store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
    let rpc = connect(&ws, 1).await;
    let resolved = |rpc: u64| json!({"method":"serverRequest/resolved","params":{"threadId":"thread-a","requestId":rpc}});

    // The answered request goes; the old connection's request with the same
    // wire id stays, stale; with a Turn running the Agent works again.
    let before = in_place();
    ws.on_event("a", 1, resolved(7));
    assert_eq!(in_place(), before + 1, "the resolution copied the record");
    let after = ws.store.detail("a").unwrap();
    assert_eq!(after.pending.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["old"]);
    assert_eq!((after.agent.status.as_str(), after.agent.pending_count), ("working", 1));
    let (kind, data) = kinds(&ws).pop().unwrap();
    assert_eq!((kind.as_str(), &data["_runtimeGeneration"]), ("serverRequest/resolved", &json!(1)));

    // Without a running Turn, the Agent is idle once nothing blocks.
    ws.store.record_event("a", "test/finished", &json!({}), |d| {
        d.turns[1]["status"] = "completed".into();
        d.pending.push(approval("p", 9, 1));
        d.agent.status = "waiting".into();
    }).unwrap();
    let before = in_place();
    ws.on_event("a", 1, resolved(9));
    assert_eq!(in_place(), before + 1);
    let after = ws.store.detail("a").unwrap();
    assert_eq!(after.pending.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["old"]);
    assert_eq!(after.agent.status, "idle");

    let before = in_place();
    ws.on_event("a", 1, json!({"method":"thread/status/changed","params":{"threadId":"thread-a","status":{"type":"systemError"}}}));
    assert_eq!(in_place(), before + 1, "the status change copied the record");
    assert_eq!(ws.store.detail("a").unwrap().agent.status, "error");

    // Beside a receipt still sending, the event is committed as metadata too
    // (T-140): the receipt has no user message yet, and stays sending.
    ws.store.update_meta("a", "message/requested", &json!({}), |m| {
        m.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"next","text":"next"},"status":"sending"})).unwrap());
        m.pending.push(approval("p", 10, 1));
        m.agent.status = "waiting".into();
    }).unwrap();
    let before = in_place();
    ws.on_event("a", 1, resolved(10));
    assert_eq!(in_place(), before + 1, "a resolution beside an unconfirmed receipt copied the record");
    let after = ws.store.detail("a").unwrap();
    assert_eq!(after.pending.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["old"]);
    assert_eq!(after.agent.status, "idle");
    assert_eq!(after.message_receipts[1].status, "sending");

    // Its user message is in a Turn, not yet accepted: the next status change
    // accepts it by that Turn, as the whole record's apply does, in place.
    ws.store.record_event("a", "test/message", &json!({}), |d| {
        d.turns[1]["items"] = json!([{"id":"u2","type":"userMessage","clientId":"next","content":[{"type":"text","text":"next"}]}]);
    }).unwrap();
    assert_eq!(ws.store.detail("a").unwrap().message_receipts[1].status, "sending");
    let before = in_place();
    ws.on_event("a", 1, json!({"method":"thread/status/changed","params":{"threadId":"thread-a","status":{"type":"idle"}}}));
    assert_eq!(in_place(), before + 1, "the status change beside an unconfirmed receipt copied the record");
    let receipt = ws.store.detail("a").unwrap().message_receipts[1].clone();
    assert_eq!((receipt.status.as_str(), receipt.turn_id.as_deref()), ("accepted", Some("t2")));
    rpc.close();
}

/// Without a receipt sending or uncertain, a resolution or status change is
/// the metadata commit it was before (T-120): a receipt of another state
/// whose user message is in a Turn, here unknown (as a Claude connection that
/// ended leaves one), is not accepted by it, as it was not before (T-140).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_an_unconfirmed_receipt_a_status_change_accepts_no_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let mut d = record("working", true);
    d.turns[1]["items"] = json!([{"id":"u2","type":"userMessage","clientId":"later","content":[{"type":"text","text":"later"}]}]);
    d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"later","text":"later"},"status":"unknown"})).unwrap());
    ws.store.insert(&d).unwrap();
    ws.store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
    let rpc = connect(&ws, 1).await;
    let before = in_place();
    ws.on_event("a", 1, json!({"method":"thread/status/changed","params":{"threadId":"thread-a","status":{"type":"idle"}}}));
    assert_eq!(in_place(), before + 1, "the status change copied the record");
    let receipt = ws.store.detail("a").unwrap().message_receipts[1].clone();
    assert_eq!((receipt.status.as_str(), receipt.turn_id.as_deref()), ("unknown", None));
    rpc.close();
}

/// A native `turn/started` reaches `Store::record_applied` from `on_event`
/// and is written without copying the record's other Turns (T-140).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_native_turn_started_is_written_without_copying_the_record() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.store.insert(&record("idle", false)).unwrap();
    ws.store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
    let rpc = connect(&ws, 1).await;
    let before = crate::store::STARTED_IN_PLACE.with(|n| n.get());
    ws.on_event("a", 1, json!({"method":"turn/started","params":{"threadId":"thread-a",
        "turn":{"id":"t3","status":"inProgress","items":[{"id":"u3","type":"userMessage","content":[{"type":"text","text":"third"}]}]}}}));
    assert_eq!(crate::store::STARTED_IN_PLACE.with(|n| n.get()), before + 1, "the turn/started copied the record");
    let after = ws.store.detail("a").unwrap();
    assert_eq!(after.turns.iter().map(|t| t["id"].as_str().unwrap()).collect::<Vec<_>>(), ["t1", "t2", "t3"]);
    assert_eq!(after.agent.status, "working");
    assert_eq!(kinds(&ws).pop().unwrap().0, "turn/started");
    rpc.close();
}

/// A native `turn/completed` reaches `Store::record_applied` from `on_event`
/// and is written without copying the record's other Turns (T-140).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_native_turn_completed_is_written_without_copying_the_record() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.store.insert(&record("working", true)).unwrap();
    ws.store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
    let rpc = connect(&ws, 1).await;
    let before = crate::store::COMPLETED_IN_PLACE.with(|n| n.get());
    ws.on_event("a", 1, json!({"method":"turn/completed","params":{"threadId":"thread-a",
        "turn":{"id":"t2","status":"completed","items":[{"id":"m2","type":"agentMessage","text":"done"}]}}}));
    assert_eq!(crate::store::COMPLETED_IN_PLACE.with(|n| n.get()), before + 1, "the turn/completed copied the record");
    let after = ws.store.detail("a").unwrap();
    assert_eq!(after.turns[1]["status"], "completed");
    assert_eq!(after.turns[1]["items"][0]["text"], "done");
    assert_eq!((after.agent.status.as_str(), after.agent.unread_count), ("idle", 1));
    assert_eq!(kinds(&ws).pop().unwrap().0, "turn/completed");
    rpc.close();
}

/// Codex's `thread/started` keeps the Agent's thread as its recovery handle:
/// set only while none is recorded, and never to a sub-agent's thread. It is
/// written as the metadata (T-140): a held record is changed in place, and,
/// held or not, it writes what the whole-record commit (`update`) wrote.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_started_is_written_as_metadata_and_writes_what_the_whole_record_commit_wrote() {
    // The commit `on_event` made before, with the same change.
    let whole = |ws: &Workspace, p: &Value| {
        ws.store.update("a", "thread/started", p, |d| {
            if d.agent.thread_id.is_none() && p["thread"]["parentThreadId"].is_null() {
                d.agent.thread_id = p["thread"]["id"].as_str().map(str::to_owned);
            }
        }).unwrap();
    };
    // The record once written, and the journal.
    let written = |ws: &Workspace| {
        ws.store.release_for_test("a");
        let d = ws.store.detail("a").unwrap();
        let mut meta = metadata(&d);
        meta["agent"]["rev"] = json!(0);
        (meta, serde_json::to_value(&d.turns).unwrap(), kinds(ws))
    };
    // No thread yet, its own; no thread yet, a sub-agent's; the same thread again.
    let cases = [
        (None, json!({"thread":{"id":"thread-n","parentThreadId":null}}), json!("thread-n")),
        (None, json!({"thread":{"id":"child-1","parentThreadId":"thread-p"}}), Value::Null),
        (Some("thread-a"), json!({"thread":{"id":"thread-a","parentThreadId":null}}), json!("thread-a")),
    ];
    for (known, p, expected) in cases {
        for held in [true, false] {
            let mut d = record("working", true);
            d.agent.thread_id = known.map(str::to_owned);
            let (dir, other_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
            let other = Workspace::new(other_dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
            for w in [&ws, &other] {
                w.store.insert(&d).unwrap();
                w.store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
                if !held {
                    w.store.release_for_test("a");
                }
            }
            let rpc = connect(&ws, 1).await;
            let copy = ws.store.held_for_test("a");
            let before = in_place();
            ws.on_event("a", 1, json!({"method":"thread/started","params":p}));
            if let Some(copy) = &copy {
                assert!(ws.store.held_for_test("a").is_some_and(|now| Arc::ptr_eq(&now, copy)), "{p}: the record was copied");
                assert_eq!(in_place(), before + 1, "{p}");
            }
            whole(&other, &p);
            let (mine, theirs) = (written(&ws), written(&other));
            assert_eq!(mine, theirs, "{p} held={held}");
            assert_eq!(mine.0["agent"]["threadId"], expected, "{p}");
            assert_eq!(mine.2.last().map(|(kind, _)| kind.as_str()), Some("thread/started"));
            rpc.close();
        }
    }
}
