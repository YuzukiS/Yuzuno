//! `Store::commit`'s scopes (`update_meta`, `update_picking_meta`,
//! `record_applied`) write what comparing the whole record writes: the same
//! changes, sent through the scoped and the comparing commits of two stores
//! that hold the same record, leave the same record held and in the rows.
use super::tests::{detail, lab};
use super::*;

/// The clock is read separately in each store; nothing else may differ.
fn normalized(mut value: Value) -> Value {
    fn walk(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, value) in map.iter_mut() {
                    if matches!(key.as_str(), "updatedAt" | "_yuzunoStartedAt" | "_yuzunoCompletedAt" | "_yuzunoDurationMs") {
                        *value = json!(0);
                    } else if key == "_yuzunoTime" {
                        value["at"] = json!(0);
                    } else {
                        walk(value);
                    }
                }
            }
            Value::Array(values) => values.iter_mut().for_each(walk),
            _ => {}
        }
    }
    walk(&mut value);
    value
}

/// The record held and every row and journal entry of Agent `a`, without times.
fn held_and_rows(store: &Store) -> Value {
    let held = serde_json::to_value(store.detail("a").unwrap()).unwrap();
    let rows = {
        let db = store.db.read().unwrap();
        let mut rows = json!({});
        for (table, columns) in [
            ("agents", "id, data"),
            ("agent_turns", "turn_id, ord, items, data"),
            ("agent_items", "turn_id, item_id, ord, payloads, data, previews"),
            ("agent_payloads", "turn_id, item_id, field, data"),
            ("agent_window_items", "turn_id, item_id, data"),
            ("journal", "kind, data"),
        ] {
            let key = if table == "agents" { "id" } else { "agent_id" };
            let order = if table == "journal" { "seq" } else { columns };
            let mut statement = db.prepare(&format!("SELECT {columns} FROM {table} WHERE {key}='a' ORDER BY {order}")).unwrap();
            let count = statement.column_count();
            let values: Vec<Value> = statement.query_map([], |row| {
                Ok((0..count).map(|i| match row.get_ref(i).unwrap() {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Real(n) => json!(n),
                    rusqlite::types::ValueRef::Text(t) => {
                        let text = String::from_utf8_lossy(t).into_owned();
                        serde_json::from_str(&text).unwrap_or(Value::String(text))
                    }
                    rusqlite::types::ValueRef::Blob(b) => json!(b.len()),
                }).collect())
            }).unwrap().collect::<rusqlite::Result<_>>().unwrap();
            rows[table] = values.into();
        }
        rows
    };
    normalized(json!({"held": held, "rows": rows}))
}

/// `held_and_rows`, and the record read back from its rows alone (which
/// leaves it no longer held).
fn state(store: &Store) -> Value {
    let mut state = held_and_rows(store);
    {
        let mut memory = store.memory.lock().unwrap();
        memory.held.clear();
        memory.briefs.clear();
    }
    state["reloaded"] = normalized(serde_json::to_value(store.detail("a").unwrap()).unwrap());
    state
}

fn receipt(id: &str, text: &str) -> MessageReceipt {
    serde_json::from_value(json!({"input":{"clientMessageId":id,"text":text},"status":"sending"})).unwrap()
}

/// A record like a long imported conversation: completed Turns whose user
/// messages carry the client IDs of receipts, and tool output stored as
/// payloads.
fn record() -> AgentDetail {
    let mut d = detail("a");
    d.agent.status = "idle".into();
    d.turns = (0..6).map(|t| json!({"id":format!("t{t}"),"status":"completed","items":[
        {"id":format!("u{t}"),"type":"userMessage",
         "clientId": if t == 2 || t == 4 { json!(format!("old-{t}")) } else { Value::Null },
         "content":[{"type":"text","text":format!("message {t}")}]},
        {"id":format!("c{t}"),"type":"commandExecution","status":"completed","aggregatedOutput":"out\n".repeat(3000)},
        {"id":format!("m{t}"),"type":"agentMessage","text":format!("answer {t}")},
    ]})).collect();
    let mut bound = receipt("old-0", "message 0");
    bound.status = "accepted".into();
    bound.turn_id = Some("t0".into());
    d.turns[0]["items"][0]["clientId"] = json!("old-0");
    d.message_receipts.push(bound);
    d
}

/// Two stores holding the same record.
fn pair() -> ((tempfile::TempDir, Store), (tempfile::TempDir, Store)) {
    let (a, b) = (lab(), lab());
    for (_, store) in [&a, &b] {
        store.insert(&record()).unwrap();
        store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
        assert!(store.held("a").is_some());
    }
    (a, b)
}

#[test]
fn scoped_send_path_commits_write_what_comparing_writes() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    let same = |step: &str| {
        let (g, s) = (state(&generic), state(&scoped));
        assert_eq!(g, s, "{step}: the scoped commit wrote something else");
        // Each check reloads the record; hold it again for the next step.
        for store in [&generic, &scoped] {
            store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
        }
    };

    // A receipt whose native Item in an old Turn bind finds (its binding is
    // metadata), and one with text blocks, which restore writes into that
    // old Item: a change to the metadata alone that changes an old Turn.
    let mut found = receipt("old-2", "message 2");
    found.status = "accepted".into();
    let mut blocks = receipt("old-4", "message 4");
    blocks.status = "accepted".into();
    blocks.input.text_blocks = Some(vec![crate::message_content::TextBlock { id: "b".into(), start: 0, end: 7 }]);
    let (r1, r2) = (found.clone(), blocks.clone());
    generic.record_event("a", "message/requested", &json!({}), move |d| { d.message_receipts.push(r1); d.message_receipts.push(r2); }).unwrap();
    scoped.update_meta("a", "message/requested", &json!({}), move |m| { m.message_receipts.push(found); m.message_receipts.push(blocks); }).unwrap();
    same("receipts that restore old Items");

    // A send, as send_message and send_images_locked commit it.
    let sent = receipt("send-1", "hello");
    let copy = sent.clone();
    generic.record_event("a", "message/requested", &json!({}), move |d| d.message_receipts.push(copy)).unwrap();
    scoped.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(sent)).unwrap();
    same("message/requested");
    generic.record_event("a", "turn/requested", &json!({"threadId":"thread"}), |d| d.agent.status = "uncertain".into()).unwrap();
    scoped.update_meta("a", "turn/requested", &json!({"threadId":"thread"}), |m| m.agent.status = "uncertain".into()).unwrap();
    same("turn/requested");
    let accepted = json!({"turn":{"id":"new","status":"inProgress","items":[]}});
    let copy = accepted.clone();
    generic.record_event("a", "turn/accepted", &accepted, move |d| d.apply("turn/started", &copy)).unwrap();
    scoped.record_applied("a", "turn/accepted", "turn/started", &accepted).unwrap();
    same("turn/accepted");

    // The native events a send waits behind; turn/started carries the sent
    // message, which binds and accepts its receipt.
    for (kind, data) in [
        ("thread/status/changed", json!({"threadId":"thread","status":{"type":"active","activeFlags":[]}})),
        ("mcpServer/startupStatus/updated", json!({"name":"s","status":"ready"})),
        ("turn/started", json!({"threadId":"thread","turn":{"id":"new","status":"inProgress","items":[
            {"id":"native-new","type":"userMessage","clientId":"send-1","content":[{"type":"text","text":"hello"}]}]}})),
    ] {
        let copy = data.clone();
        generic.record_event("a", kind, &data, move |d| d.apply(kind, &copy)).unwrap();
        scoped.record_applied("a", kind, kind, &data).unwrap();
        same(kind);
    }

    let receipt_of = |status: &'static str| move |receipts: &mut Vec<MessageReceipt>| {
        let receipt = receipts.iter_mut().find(|r| r.input.client_message_id == "send-1").unwrap();
        if !matches!(receipt.status.as_str(), "accepted" | "unknown") {
            receipt.status = status.into();
            receipt.turn_id = Some("new".into());
        }
    };
    let pick = |d: &AgentDetail| d.message_receipts.iter().find(|r| r.input.client_message_id == "send-1").cloned();
    let (g, s) = (receipt_of("accepted"), receipt_of("accepted"));
    let picked = generic.update_picking("a", "message/receipt", &json!({}), move |d| g(&mut d.message_receipts), pick).unwrap();
    let picked_scoped = scoped.update_picking_meta("a", "message/receipt", &json!({}), move |m| s(&mut *m.message_receipts), pick).unwrap();
    assert_eq!(picked.map(|r| serde_json::to_value(r).unwrap()), picked_scoped.map(|r| serde_json::to_value(r).unwrap()));
    same("message/receipt");
}

#[test]
fn turns_without_distinct_ids_are_compared_as_before() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    for store in [&generic, &scoped] {
        store.record_event("a", "test/duplicate", &json!({}), |d| {
            let copy = d.turns[1].clone();
            d.turns.push(copy);
        }).unwrap();
    }
    let accepted = json!({"turn":{"id":"t1","status":"completed","items":[{"id":"m1","type":"agentMessage","text":"changed"}]}});
    let copy = accepted.clone();
    generic.record_event("a", "turn/completed", &accepted, move |d| d.apply("turn/completed", &copy)).unwrap();
    scoped.record_applied("a", "turn/completed", "turn/completed", &accepted).unwrap();
    assert_eq!(state(&generic), state(&scoped));
}

#[test]
fn a_failed_scoped_write_changes_neither_the_held_record_nor_its_rows() {
    let ((_ga, _generic), (_sa, scoped)) = pair();
    let before = held_and_rows(&scoped);
    scoped.db.write().unwrap().execute_batch(
        "CREATE TRIGGER refuse BEFORE INSERT ON journal WHEN NEW.kind='message/requested' BEGIN SELECT RAISE(ABORT, 'refused'); END;").unwrap();
    let error = scoped.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("lost", "x"))).unwrap_err();
    assert!(format!("{error:#}").contains("refused"), "{error:#}");
    assert!(scoped.held("a").is_some());
    assert_eq!(held_and_rows(&scoped), before);
    scoped.db.write().unwrap().execute_batch("DROP TRIGGER refuse;").unwrap();
    scoped.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("kept", "x"))).unwrap();
    let ids: Vec<String> = scoped.detail("a").unwrap().message_receipts.into_iter().map(|r| r.input.client_message_id).collect();
    assert_eq!(ids, ["old-0", "kept"]);
}

/// The metadata commits this thread got to writing without copying Turns.
fn in_place() -> u64 {
    super::META_IN_PLACE.with(|n| n.get())
}

#[test]
fn metadata_changes_to_a_held_record_are_written_without_copying_its_turns() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    let before = in_place();
    let sent = receipt("send-2", "hello");
    let copy = sent.clone();
    generic.record_event("a", "message/requested", &json!({}), move |d| d.message_receipts.push(copy)).unwrap();
    scoped.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(sent)).unwrap();
    assert_eq!(in_place(), before + 1, "the scoped store copied the record");
    assert_eq!(state(&generic), state(&scoped));
}

#[test]
fn a_metadata_change_to_a_record_kept_whole_is_written_whole() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    for store in [&generic, &scoped] {
        let whole = serde_json::to_string(&store.detail("a").unwrap()).unwrap();
        let mut db = store.db.write().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("UPDATE agents SET layout=0, data=?1 WHERE id='a'", [whole]).unwrap();
        record_rows::delete_rows(&tx, "a").unwrap();
        tx.commit().unwrap();
        drop(db);
        store.memory.lock().unwrap().held.clear();
        store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
    }
    let sent = receipt("whole", "hello");
    let copy = sent.clone();
    generic.record_event("a", "message/requested", &json!({}), move |d| d.message_receipts.push(copy)).unwrap();
    scoped.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(sent)).unwrap();
    let layout: i64 = scoped.db.read().unwrap().query_row("SELECT layout FROM agents WHERE id='a'", [], |r| r.get(0)).unwrap();
    assert_eq!(layout, 0);
    assert_eq!(state(&generic), state(&scoped));
}

/// Each way a metadata write can fail leaves the held record and its rows
/// as they were, and the next write goes through.
#[test]
fn metadata_writes_that_fail_before_planning_or_while_writing_rows_change_nothing() {
    for (fault, undo) in [
        // Planning reads the Turn rows.
        ("ALTER TABLE agent_turns RENAME TO hidden_turns;", "ALTER TABLE hidden_turns RENAME TO agent_turns;"),
        // The journal row goes first, then the metadata row.
        ("CREATE TRIGGER refuse BEFORE UPDATE ON agents BEGIN SELECT RAISE(ABORT, 'refused'); END;", "DROP TRIGGER refuse;"),
    ] {
        let ((_ga, _generic), (_sa, scoped)) = pair();
        let before = held_and_rows(&scoped);
        scoped.db.write().unwrap().execute_batch(fault).unwrap();
        assert!(scoped.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("lost", "x"))).is_err(), "{fault}");
        assert!(scoped.held("a").is_some());
        scoped.db.write().unwrap().execute_batch(undo).unwrap();
        assert_eq!(held_and_rows(&scoped), before, "{fault}");
        scoped.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("kept", "x"))).unwrap();
        let ids: Vec<String> = scoped.detail("a").unwrap().message_receipts.into_iter().map(|r| r.input.client_message_id).collect();
        assert_eq!(ids, ["old-0", "kept"], "{fault}");
    }
}

#[test]
fn a_change_that_panics_leaves_the_held_record_as_it_was() {
    let ((_ga, _generic), (_sa, scoped)) = pair();
    let before = held_and_rows(&scoped);
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        scoped.update_meta("a", "message/requested", &json!({}), |m| {
            m.message_receipts.push(receipt("lost", "x"));
            panic!("a bug in the change");
        })
    }));
    assert!(panicked.is_err());
    assert_eq!(held_and_rows(&scoped), before);
    scoped.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("kept", "x"))).unwrap();
    assert_eq!(scoped.detail("a").unwrap().message_receipts.len(), 2);
}

/// A reader of the held record sees each change whole: a receipt is never
/// there without its journal position, nor the other way round, and revs
/// only grow.
#[test]
fn readers_see_a_metadata_change_with_its_journal_position_and_rev() {
    let ((_ga, _generic), (_sa, scoped)) = pair();
    let scoped = std::sync::Arc::new(scoped);
    let base = scoped.detail("a").unwrap();
    let (receipts, seq) = (base.message_receipts.len(), base.agent.last_seq);
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = {
        let (store, done) = (scoped.clone(), done.clone());
        std::thread::spawn(move || {
            let (mut rev, mut reads) = (0, 0);
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                let d = store.detail("a").unwrap();
                let added = d.message_receipts.len() - receipts;
                assert_eq!(d.agent.last_seq - seq, added as i64, "a receipt and its journal row seen apart");
                assert!(d.agent.rev >= rev, "rev went back");
                rev = d.agent.rev;
                reads += 1;
            }
            reads
        })
    };
    for n in 0..100 {
        scoped.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(receipt(&format!("r{n}"), "x"))).unwrap();
    }
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(reader.join().unwrap() > 0);
    assert_eq!(scoped.detail("a").unwrap().message_receipts.len(), receipts + 100);
}

/// `held_and_rows`, and what memory shows of the record beside it: its rev
/// and its listed brief.
fn published(store: &Store) -> Value {
    let mut state = held_and_rows(store);
    let memory = store.memory.lock().unwrap();
    state["rev"] = json!(memory.rev("a"));
    state["brief"] = memory.briefs.get("a").map_or(Value::Null, |brief| json!({
        "agent": brief.agent, "activeTurn": brief.active_turn, "unmatched": brief.active_turn_unmatched,
        "pendingIds": brief.pending_ids, "activity": format!("{:?}", brief.activity)}));
    drop(memory);
    normalized(state)
}

/// A write that fails only at COMMIT publishes nothing, in the comparing
/// commit and in the metadata commit alike. A test trigger breaks a
/// deferred foreign key as the write's journal row goes in; SQLite checks it
/// when the transaction commits, after every row was written. The held
/// record, its rows and journal, rev, brief and the changes its rows still
/// lack stay as they were, and once the fault is gone the next write goes
/// through with those changes. This is the COMMIT error path, not a lost
/// disk or every I/O error.
#[test]
fn a_write_refused_by_its_commit_publishes_nothing() {
    for meta in [false, true] {
        let ((_ga, _generic), (_sa, store)) = pair();
        // A streamed Item the rows lack, written with the next commit.
        super::tests::stream(&store, "a", "item/completed",
            &json!({"turnId":"t5","item":{"id":"m5","type":"agentMessage","text":"later"}}));
        let unwritten = || store.memory.lock().unwrap().held.get("a").map(|held| held.unwritten.clone());
        let (before, lacking) = (published(&store), unwritten());
        assert!(lacking.as_ref().is_some_and(|dirty| !dirty.is_meta_only()), "{lacking:?}");
        store.db.write().unwrap().execute_batch(
            "CREATE TABLE t120_parent(id INTEGER PRIMARY KEY);
             CREATE TABLE t120_child(parent INTEGER REFERENCES t120_parent(id) DEFERRABLE INITIALLY DEFERRED);
             CREATE TRIGGER t120_orphan AFTER INSERT ON journal WHEN NEW.kind='message/requested'
                 BEGIN INSERT INTO t120_child(parent) VALUES(-1); END;").unwrap();
        let taken = in_place();
        let refused = if meta {
            store.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("lost", "x")))
        } else {
            store.record_event("a", "message/requested", &json!({}), |d| d.message_receipts.push(receipt("lost", "x")))
        };
        let error = format!("{:#}", refused.unwrap_err());
        assert!(error.contains("FOREIGN KEY constraint failed"), "meta {meta}: {error}");
        assert_eq!(in_place(), taken + u64::from(meta), "meta {meta}: which commit wrote");
        assert_eq!(published(&store), before, "meta {meta}");
        assert_eq!(unwritten(), lacking, "meta {meta}");
        store.db.write().unwrap().execute_batch("DROP TRIGGER t120_orphan;").unwrap();
        store.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("kept", "x"))).unwrap();
        let d = store.detail("a").unwrap();
        let ids: Vec<&str> = d.message_receipts.iter().map(|r| r.input.client_message_id.as_str()).collect();
        assert_eq!(ids, ["old-0", "kept"], "meta {meta}");
        assert!(unwritten().is_some_and(|dirty| dirty.is_meta_only()), "meta {meta}: the streamed Item was not written");
        let written: i64 = store.db.read().unwrap()
            .query_row("SELECT count(*) FROM agent_items WHERE agent_id='a' AND item_id='m5' AND data LIKE '%later%'", [], |r| r.get(0)).unwrap();
        assert_eq!(written, 1, "meta {meta}");
    }
}

fn pending_request(id: &str, rpc: u64) -> PendingRequest {
    serde_json::from_value(json!({"id":id,"agentId":"a","method":"item/tool/requestUserInput",
        "params":{"threadId":"thread","turnId":"t5","itemId":format!("q{rpc}"),"questions":[{"id":"q"}],
                  "_rpcId":rpc,"_runtimeGeneration":1,"_responseSent":false},
        "createdAt":"2026-10-20T00:00:00Z"})).unwrap()
}

/// A native request arriving and its answer (T-120) are metadata changes:
/// written in place, they leave what comparing the whole record leaves.
#[test]
fn a_native_request_and_its_answer_are_written_without_copying_the_record() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    let before = in_place();
    let (asked, copy) = (pending_request("p1", 7), pending_request("p1", 7));
    generic.record_event("a", "request", &json!({"turnId":"t5"}), move |d| {
        d.agent.status = "waiting".into();
        d.pending.push(copy);
    }).unwrap();
    scoped.update_meta("a", "request", &json!({"turnId":"t5"}), move |m| {
        m.agent.status = "waiting".into();
        m.pending.push(asked);
    }).unwrap();
    assert_eq!(state(&generic), state(&scoped));
    for store in [&generic, &scoped] {
        store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
    }
    generic.record_event("a", "request/replied", &json!({"requestId":"p1"}), |d| {
        d.pending[0].params["_responseSent"] = true.into();
    }).unwrap();
    scoped.update_meta("a", "request/replied", &json!({"requestId":"p1"}), |m| {
        m.pending[0].params["_responseSent"] = true.into();
    }).unwrap();
    assert_eq!(in_place(), before + 2, "the scoped store copied the record");
    let written = state(&scoped);
    assert_eq!(written, state(&generic));
    assert_eq!(written["reloaded"]["pending"][0]["params"]["_responseSent"], true);
    assert_eq!(written["reloaded"]["agent"]["pendingCount"], 1);
    assert_eq!(written["reloaded"]["agent"]["status"], "waiting");
}

/// `pending` reads what `detail` has, held or not, without copying the
/// record when it is held.
#[test]
fn pending_reads_the_requests_of_a_held_or_unheld_record() {
    let ((_a, store), _) = pair();
    store.update_meta("a", "request", &json!({}), |m| m.pending.push(pending_request("p1", 7))).unwrap();
    assert!(store.held("a").is_some());
    let held = store.pending("a").unwrap();
    assert_eq!(held.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["p1"]);
    {
        let mut memory = store.memory.lock().unwrap();
        memory.held.clear();
        memory.briefs.clear();
    }
    let unheld = store.pending("a").unwrap();
    assert_eq!(serde_json::to_value(&unheld).unwrap(), serde_json::to_value(&held).unwrap());
    assert_eq!(serde_json::to_value(&unheld).unwrap(), serde_json::to_value(&store.detail("a").unwrap().pending).unwrap());
    assert!(store.pending("missing").is_err());
}

/// A bounded synthetic measurement (T-120), run by hand: one native request
/// answered on a held record of 50, 500 and 2000 Turns, the way `respond`
/// did it (`detail` + `update`) and the way it does now (`pending` +
/// `update_meta`). Prints the median of 15 runs each; asserts nothing about
/// time. `cargo test --lib measure_native_answer_cost -- --ignored --nocapture`
#[test]
#[ignore]
fn measure_native_answer_cost() {
    fn median(mut times: Vec<std::time::Duration>) -> std::time::Duration {
        times.sort();
        times[times.len() / 2]
    }
    for turns in [50usize, 500, 2000] {
        let (_dir, store) = lab();
        let mut d = record();
        d.turns = (0..turns).map(|t| json!({"id":format!("t{t}"),"status":"completed","items":[
            {"id":format!("u{t}"),"type":"userMessage","content":[{"type":"text","text":format!("message {t}")}]},
            {"id":format!("c{t}"),"type":"commandExecution","status":"completed","aggregatedOutput":"out\n".repeat(500)},
            {"id":format!("m{t}"),"type":"agentMessage","text":"answer ".repeat(50)},
        ]})).collect();
        store.insert(&d).unwrap();
        store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
        let (mut before, mut after) = (vec![], vec![]);
        for round in 0..15 {
            let id = format!("p{round}");
            store.update_meta("a", "request", &json!({}), |m| m.pending.push(pending_request(&id, round))).unwrap();
            let start = std::time::Instant::now();
            let detail = store.detail("a").unwrap();
            assert!(detail.pending.iter().any(|p| p.id == id));
            store.update("a", "request/replied", &json!({"requestId":id}), |d| {
                d.pending.iter_mut().find(|p| p.id == id).unwrap().params["_responseSent"] = true.into();
            }).unwrap();
            before.push(start.elapsed());
            let start = std::time::Instant::now();
            assert!(store.pending("a").unwrap().iter().any(|p| p.id == id));
            store.update_meta("a", "request/replied", &json!({"requestId":id}), |m| {
                m.pending.iter_mut().find(|p| p.id == id).unwrap().params["_responseSent"] = true.into();
            }).unwrap();
            after.push(start.elapsed());
            store.update_meta("a", "serverRequest/resolved", &json!({}), |m| m.pending.retain(|p| p.id != id)).unwrap();
        }
        println!("turns {turns:>5}: detail+update {:>9.3?}  pending+update_meta {:>9.3?}", median(before), median(after));
    }
}
