//! T-120: a native request's resolution and a thread status change are
//! committed as metadata (`apply_metadata_event`), without copying a long
//! record, and leave what applying them to the whole record leaves; so are a
//! thread's start, a connection's end and an MCP server's startup status
//! (T-140).
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
        ("mcpServer/startupStatus/updated", json!({"threadId":"thread-a","name":"docs","status":"starting","error":null})),
        ("mcpServer/startupStatus/updated", json!({"threadId":"thread-a","name":"docs","status":"failed","error":"exited"})),
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
                        claude_runtime: &mut meta.claude_runtime, context_usage: &mut meta.context_usage,
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
    assert_eq!(checked, 6 * 2 * 8 * 9);
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

/// A Codex connection that ends leaves the Agent disconnected: offline unless
/// its status is uncertain, with the reason unless Core closed it (which keeps
/// an error recorded before), and its context usage and pending requests
/// stale. Only the metadata changes, so it
/// is written as the metadata (T-140): a held record is changed in place, and,
/// held or not, it writes what the whole-record commit (`update`) wrote, with
/// receipts still sending or uncertain beside it. A held record with a user
/// message whose client ID `restore` gives back is written by the commit that
/// restores it, as before.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_disconnect_is_written_as_metadata_and_writes_what_the_whole_record_commit_wrote() {
    // The commit `on_event` made before, with the same change.
    let whole = |ws: &Workspace, p: &Value, intentional: bool| {
        ws.store.update("a", "runtime/disconnected", p, |d| {
            if let Some(usage) = &mut d.context_usage { usage.stale = true; }
            d.agent.connection_state = "disconnected".into();
            if d.agent.status != "uncertain" {
                d.agent.status = "offline".into();
            }
            if !intentional {
                d.agent.error = Some(p["message"].as_str().unwrap_or("连接已断开").into());
            }
            for r in &mut d.pending {
                r.stale = true;
            }
        }).unwrap();
    };
    // The first user message's client ID taken off again, in the held copy
    // and in its row (what a record read without binding holds).
    let unbind = |ws: &Workspace| {
        if let Some(held) = ws.store.held_for_test("a") {
            held.write().turns[0]["items"][0].as_object_mut().unwrap().remove("clientId");
        }
        let db = rusqlite::Connection::open(ws.data_dir.join("workspace.sqlite")).unwrap();
        let changed = db.execute("UPDATE agent_items SET data=json_remove(data,'$.clientId')
            WHERE agent_id='a' AND turn_id='t1' AND item_id='u1'", []).unwrap();
        assert_eq!(changed, 1);
    };
    // The whole record once written, but the clock, and the journal.
    let written = |ws: &Workspace| {
        ws.store.release_for_test("a");
        let mut d = serde_json::to_value(ws.store.detail("a").unwrap()).unwrap();
        d["agent"]["updatedAt"] = json!(0);
        d["agent"]["rev"] = json!(0);
        (d, kinds(ws))
    };
    // Lost with a reason, lost without one after an error, and closed by
    // Core, without and after an error.
    let ends = [
        (false, json!({"message":"pipe closed"}), None),
        (false, json!({}), Some("earlier")),
        (true, json!({"message":"closed"}), None),
        (true, json!({"message":"closed"}), Some("earlier")),
    ];
    let mut checked = 0;
    for (intentional, p, earlier) in &ends {
        for status in ["working", "uncertain"] {
            // Current, already stale, and none.
            for usage in [Some(usage_of(false)), Some(usage_of(true)), None] {
                for (held, restore) in [(true, false), (false, false), (true, true), (false, true)] {
                    let mut d = record(status, true);
                    d.agent.error = (*earlier).map(str::to_owned);
                    d.context_usage = usage.clone();
                    d.pending = vec![approval("p", 7, 1), PendingRequest { stale: true, ..approval("old", 6, 0) }];
                    // A receipt sending whose user message has arrived, and one uncertain.
                    d.turns[1]["items"] = json!([{"id":"u2","type":"userMessage","clientId":"next","content":[{"type":"text","text":"next"}]}]);
                    d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"next","text":"next"},"status":"sending"})).unwrap());
                    d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"maybe","text":"maybe"},"status":"uncertain"})).unwrap());
                    let (dir, other_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
                    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
                    let other = Workspace::new(other_dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
                    for w in [&ws, &other] {
                        w.store.insert(&d).unwrap();
                        w.store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
                        if !held {
                            w.store.release_for_test("a");
                        }
                        if restore {
                            unbind(w);
                        }
                    }
                    let rpc = connect(&ws, 1).await;
                    ws.rpcs.lock().unwrap().get_mut("a").unwrap().closing = *intentional;
                    let copy = ws.store.held_for_test("a");
                    let before = in_place();
                    ws.on_event("a", 1, json!({"method":"yuzuno/disconnected","params":p}));
                    let case = format!("{p} intentional={intentional} earlier={earlier:?} {status} usage={:?} held={held} restore={restore}",
                        usage.as_ref().map(|u| u.stale));
                    if let Some(copy) = &copy {
                        let kept = ws.store.held_for_test("a").is_some_and(|now| Arc::ptr_eq(&now, copy));
                        assert_eq!(kept, !restore, "{case}: copied");
                        assert_eq!(in_place(), before + u64::from(!restore), "{case}");
                    }
                    assert!(!ws.rpcs.lock().unwrap().contains_key("a"), "{case}");
                    whole(&other, p, *intentional);
                    let (mine, theirs) = (written(&ws), written(&other));
                    assert_eq!(mine, theirs, "{case}");
                    let agent = &mine.0["agent"];
                    assert_eq!(agent["connectionState"], "disconnected", "{case}");
                    assert_eq!(agent["status"], if status == "uncertain" { "uncertain" } else { "offline" }, "{case}");
                    let reason = if *intentional { json!(earlier) } else { json!(p["message"].as_str().unwrap_or("连接已断开")) };
                    assert_eq!(agent["error"], reason, "{case}");
                    assert!(mine.0["pending"].as_array().unwrap().iter().all(|r| r["stale"] == true), "{case}");
                    assert_eq!(mine.0["contextUsage"]["stale"], if usage.is_some() { json!(true) } else { Value::Null }, "{case}");
                    let receipts: Vec<_> = mine.0["messageReceipts"].as_array().unwrap().iter().map(|r| r["status"].clone()).collect();
                    assert_eq!(receipts, [json!("accepted"), json!("sending"), json!("uncertain")], "{case}");
                    assert_eq!(mine.0["turns"][0]["items"][0]["clientId"], "sent-1", "{case}");
                    assert_eq!(mine.1.last().map(|(kind, _)| kind.as_str()), Some("runtime/disconnected"), "{case}");
                    rpc.close();
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 4 * 2 * 3 * 4);
}

/// A disconnect whose write fails, its journal row or its metadata row
/// refused, changes nothing and publishes nothing (T-140): held or not, the
/// record, its rows, its rev and the Agent listed stay as they were, and
/// nothing is journaled.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_disconnect_whose_write_fails_changes_and_publishes_nothing() {
    let faults = [
        "CREATE TRIGGER refuse BEFORE INSERT ON journal WHEN NEW.kind='runtime/disconnected' BEGIN SELECT RAISE(ABORT, 'refused'); END;",
        "CREATE TRIGGER refuse BEFORE UPDATE ON agents BEGIN SELECT RAISE(ABORT, 'refused'); END;",
    ];
    let rows = |db: &rusqlite::Connection| -> (String, i64) {
        (db.query_row("SELECT data FROM agents WHERE id='a'", [], |r| r.get(0)).unwrap(),
            db.query_row("SELECT count(*) FROM journal WHERE agent_id='a'", [], |r| r.get(0)).unwrap())
    };
    for fault in faults {
        for held in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
            let mut d = record("working", true);
            d.context_usage = Some(usage_of(false));
            d.pending = vec![approval("p", 7, 1)];
            ws.store.insert(&d).unwrap();
            ws.store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
            if !held {
                ws.store.release_for_test("a");
            }
            let rpc = connect(&ws, 1).await;
            let db = rusqlite::Connection::open(ws.data_dir.join("workspace.sqlite")).unwrap();
            let copy = ws.store.held_for_test("a");
            let seen = || (ws.store.rev("a"), serde_json::to_value(ws.store.agents().unwrap()).unwrap(),
                copy.as_ref().map(|c| serde_json::to_value(&*c.read()).unwrap()), rows(&db));
            let before = seen();
            db.execute_batch(fault).unwrap();
            ws.on_event("a", 1, json!({"method":"yuzuno/disconnected","params":{"message":"pipe closed"}}));
            let case = format!("{fault} held={held}");
            assert_eq!(ws.store.held_for_test("a").is_some(), held, "{case}");
            if let Some(copy) = &copy {
                assert!(ws.store.held_for_test("a").is_some_and(|now| Arc::ptr_eq(&now, copy)), "{case}: replaced");
            }
            assert_eq!(seen(), before, "{case}");
            assert!(kinds(&ws).iter().all(|(kind, _)| kind != "runtime/disconnected"), "{case}");
            db.execute_batch("DROP TRIGGER refuse;").unwrap();
            rpc.close();
        }
    }
}

/// Context usage, stale or not.
fn usage_of(stale: bool) -> crate::model::ContextUsage {
    serde_json::from_value(json!({"usedTokens":1200,"windowTokens":200000,"usedPercent":0.6,"turnId":"t2",
        "updatedAt":"2026-10-23T00:00:00Z","stale":stale})).unwrap()
}

/// An MCP server's startup status changes no field of the record; applied to
/// the whole record it settled the status and accepted every receipt not yet
/// accepted or rejected by its user message, as every event does, an unknown
/// one too. It is committed as the metadata (T-140): a held record is
/// changed in place, and, held or not, beside each receipt state, it writes
/// what the whole-record commit (`record_applied`, as `on_event` made it)
/// wrote.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_mcp_startup_status_is_written_as_metadata_and_writes_what_the_whole_record_commit_wrote() {
    let method = "mcpServer/startupStatus/updated";
    let p = json!({"threadId":"thread-a","name":"docs","status":"ready","error":null});
    // The record once written, and the journal.
    let written = |ws: &Workspace| {
        ws.store.release_for_test("a");
        let d = ws.store.detail("a").unwrap();
        let mut meta = metadata(&d);
        meta["agent"]["rev"] = json!(0);
        (meta, serde_json::to_value(&d.turns).unwrap(), kinds(ws))
    };
    // A second receipt: none; sending, its message in the second Turn;
    // uncertain, its message in no Turn; unknown, its message in a Turn. The
    // Agent's status reaches only `settle_status`, which the test above checks
    // for every status; here what reaches the commit varies.
    let receipts: [Option<(&str, bool)>; 4] = [None, Some(("sending", true)), Some(("uncertain", false)), Some(("unknown", true))];
    let status = "working";
    let mut checked = 0;
    for running in [true, false] {
        for pending in [vec![], vec![approval("p", 7, 1)]] {
            for receipt in receipts {
                for held in [true, false] {
                    let mut d = record(status, running);
                    d.pending = pending.clone();
                    d.agent.pending_count = pending.len() as u64;
                    if let Some((state, shown)) = receipt {
                        if shown {
                            d.turns[1]["items"] = json!([{"id":"u2","type":"userMessage","clientId":"next","content":[{"type":"text","text":"next"}]}]);
                        }
                        d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"next","text":"next"},"status":state})).unwrap());
                    }
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
                    ws.on_event("a", 1, json!({"method":method,"params":p}));
                    let case = format!("{status} running={running} pending={} receipt={receipt:?} held={held}", pending.len());
                    if let Some(copy) = &copy {
                        assert!(ws.store.held_for_test("a").is_some_and(|now| Arc::ptr_eq(&now, copy)), "{case}: the record was copied");
                        assert_eq!(in_place(), before + 1, "{case}");
                    }
                    other.store.record_applied("a", method, method, &p).unwrap();
                    let (mine, theirs) = (written(&ws), written(&other));
                    assert_eq!(mine, theirs, "{case}");
                    assert_eq!(mine.2.last(), Some(&(method.to_owned(), p.clone())), "{case}");
                    rpc.close();
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 2 * 2 * 4 * 2);
}
