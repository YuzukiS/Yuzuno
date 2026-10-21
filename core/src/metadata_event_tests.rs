//! T-120: a native request's resolution and a thread status change are
//! committed as metadata (`apply_metadata_event`), without copying a long
//! record, and leave what applying them to the whole record leaves.
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
async fn a_resolution_and_a_status_change_are_committed_as_metadata_unless_a_receipt_is_unconfirmed() {
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

    // A receipt still sending may be confirmed by the whole-record apply:
    // that commit is used, with the same result.
    ws.store.update_meta("a", "message/requested", &json!({}), |m| {
        m.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"next","text":"next"},"status":"sending"})).unwrap());
        m.pending.push(approval("p", 10, 1));
        m.agent.status = "waiting".into();
    }).unwrap();
    let before = in_place();
    ws.on_event("a", 1, resolved(10));
    assert_eq!(in_place(), before, "a resolution beside an unconfirmed receipt was committed as metadata");
    let after = ws.store.detail("a").unwrap();
    assert_eq!(after.pending.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["old"]);
    assert_eq!(after.agent.status, "idle");
    assert_eq!(after.message_receipts[1].status, "sending");
    rpc.close();
}
