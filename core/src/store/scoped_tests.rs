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

/// `record_recovered_completion` commits what its `update` committed (T-140),
/// with the record held or not: the same journal row, unread count, rows, rev
/// and brief, and the streamed Item another Turn's rows lacked is written with
/// it. Once the completion is in the journal, a repeat writes nothing.
#[test]
fn a_recovered_completion_commits_what_update_committed() {
    for held in [true, false] {
        let ((_ga, generic), (_sa, scoped)) = pair();
        for store in [&generic, &scoped] {
            super::tests::stream(store, "a", "item/completed",
                &json!({"turnId":"t4","item":{"id":"m4","type":"agentMessage","text":"later"}}));
            if !held {
                assert!(store.flush().failed.is_empty());
                assert!(store.release_for_test("a"));
            }
        }
        let turn = record().turns[5].clone();
        generic.update("a", "turn/completed", &json!({"turn":turn,"recovered":true}), |_| {}).unwrap();
        scoped.record_recovered_completion("a", &turn).unwrap();
        assert_eq!(published(&scoped), published(&generic), "held {held}");
        let completions: i64 = scoped.db.read().unwrap()
            .query_row("SELECT count(*) FROM journal WHERE agent_id='a' AND kind='turn/completed'", [], |r| r.get(0)).unwrap();
        assert_eq!(completions, 1, "held {held}");
        let before = published(&scoped);
        scoped.record_recovered_completion("a", &turn).unwrap();
        assert_eq!(published(&scoped), before, "held {held}: a repeat wrote something");
        assert_eq!(state(&scoped), state(&generic), "held {held}");
    }
}

/// The Codex `turn/started` events this thread got to writing without
/// copying the record's other Turns (`Store::commit_turn`).
fn started_in_place() -> u64 {
    super::STARTED_IN_PLACE.with(|n| n.get())
}

fn started(turn: &str, items: Value) -> Value {
    json!({"threadId":"thread","turn":{"id":turn,"status":"inProgress","items":items}})
}

/// `turn/started` committed by comparing the whole record in `generic` and
/// through `record_applied` in `scoped`; whether `scoped` wrote it in place.
fn start_both(generic: &Store, scoped: &Store, kind: &str, data: &Value) -> bool {
    let copy = data.clone();
    generic.record_event("a", kind, data, move |d| d.apply("turn/started", &copy)).unwrap();
    let before = started_in_place();
    scoped.record_applied("a", kind, "turn/started", data).unwrap();
    started_in_place() == before + 1
}

#[test]
fn a_started_turn_is_written_without_copying_the_other_turns() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    let same = |step: &str, in_place: bool| {
        assert!(in_place, "{step}: the scoped store copied the record");
        assert_eq!(state(&generic), state(&scoped), "{step}: written in place, something else was written");
        for store in [&generic, &scoped] {
            store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
        }
    };
    // A streamed Item the rows lack is written with the new Turn.
    for store in [&generic, &scoped] {
        super::tests::stream(store, "a", "item/completed",
            &json!({"turnId":"t5","item":{"id":"m5","type":"agentMessage","text":"streamed"}}));
    }
    let new = started("n1", json!([{"id":"u-n1","type":"userMessage","content":[{"type":"text","text":"next"}]}]));
    same("a new Turn, with a streamed Item the rows lack", start_both(&generic, &scoped, "turn/started", &new));
    let again = started("n1", json!([{"id":"u-n1","type":"userMessage","content":[{"type":"text","text":"next"}]},
        {"id":"r-n1","type":"reasoning","summary":["thinking"]}]));
    same("the Turn it names, again, with another Item", start_both(&generic, &scoped, "turn/started", &again));
    let reversed = started("n1", json!([{"id":"r-n1","type":"reasoning","summary":["thought again"]},
        {"id":"u-n1","type":"userMessage","content":[{"type":"text","text":"next"}]}]));
    same("the Turn it names, its Items in another order", start_both(&generic, &scoped, "turn/started", &reversed));
    let late = started("t3", json!([{"id":"late","type":"agentMessage","text":"late"}]));
    same("a Turn already completed, which it leaves", start_both(&generic, &scoped, "turn/started", &late));
    let accepted = json!({"turn":{"id":"n2","status":"inProgress","items":[]}});
    same("turn/accepted", start_both(&generic, &scoped, "turn/accepted", &accepted));
    // A blocking request leaves the Agent waiting, not working.
    for store in [&generic, &scoped] {
        store.update_meta("a", "test/request", &json!({}), |m| m.pending.push(pending_request("p1", 1))).unwrap();
    }
    same("a blocking request pending", start_both(&generic, &scoped, "turn/started", &started("n4", json!([]))));
    assert_eq!(scoped.detail("a").unwrap().agent.status, "waiting");
    // A sent message: its receipt bound and its native Item restored.
    let mut sent = receipt("send-9", "hello there");
    sent.input.text_blocks = Some(vec![crate::message_content::TextBlock { id: "b".into(), start: 0, end: 5 }]);
    for store in [&generic, &scoped] {
        let copy = sent.clone();
        store.record_event("a", "message/requested", &json!({}), move |d| d.message_receipts.push(copy)).unwrap();
    }
    let message = started("n3", json!([{"id":"native-n3","type":"userMessage","clientId":"send-9",
        "content":[{"type":"text","text":"hello there"}]}]));
    same("a sent message, its receipt bound and restored", start_both(&generic, &scoped, "turn/started", &message));
    let d = scoped.detail("a").unwrap();
    assert!(d.message_receipts.iter().any(|r| r.input.client_message_id == "send-9"
        && r.binding.as_ref().is_some_and(|b| b.turn_id == "n3")), "the receipt was not bound");
    let item = &d.turns.iter().find(|t| t["id"] == "n3").unwrap()["items"][0];
    assert!(item.get(crate::message_content::BLOCKS).is_some(), "the message was not restored: {item}");
}

/// Where writing in place cannot be shown to write what comparing writes,
/// `turn/started` is committed as before.
#[test]
fn a_started_turn_is_compared_where_in_place_cannot_show_the_same_write() {
    let check = |generic: &Store, scoped: &Store, step: &str| {
        let data = started("f1", json!([{"id":"u-f1","type":"userMessage","content":[{"type":"text","text":"x"}]}]));
        assert!(!start_both(generic, scoped, "turn/started", &data), "{step}: written in place");
        assert_eq!(state(generic), state(scoped), "{step}");
    };
    let ((_ga, generic), (_sa, scoped)) = pair();
    for store in [&generic, &scoped] {
        store.record_event("a", "test/duplicate", &json!({}), |d| {
            let copy = d.turns[1].clone();
            d.turns.push(copy);
        }).unwrap();
    }
    check(&generic, &scoped, "Turns without distinct IDs");

    let ((_ga, generic), (_sa, scoped)) = pair();
    for store in [&generic, &scoped] {
        let mut memory = store.memory.lock().unwrap();
        memory.held.clear();
        memory.briefs.clear();
    }
    check(&generic, &scoped, "a record not held");

    // A receipt whose old Item restore has yet to change. Every way a record
    // comes to be held binds and restores it (a streamed event's apply too),
    // so the held copy is set back here, as a record read without binding is.
    let ((_ga, generic), (_sa, scoped)) = pair();
    for store in [&generic, &scoped] {
        let mut blocks = receipt("old-4", "message 4");
        blocks.status = "accepted".into();
        blocks.input.text_blocks = Some(vec![crate::message_content::TextBlock { id: "b".into(), start: 0, end: 7 }]);
        store.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(blocks)).unwrap();
        unrestore(store, "t4", "u4");
    }
    check(&generic, &scoped, "an old Item restore would change");

    // Another kind applied as turn/started (turn/completed keeps the journal
    // check `commit` makes for it).
    let ((_ga, generic), (_sa, scoped)) = pair();
    let data = started("t5", json!([]));
    let copy = data.clone();
    generic.record_event("a", "turn/completed", &data, move |d| d.apply("turn/started", &copy)).unwrap();
    let before = started_in_place();
    scoped.record_applied("a", "turn/completed", "turn/started", &data).unwrap();
    assert_eq!(started_in_place(), before, "another kind applied as turn/started: written in place");
    assert_eq!(state(&generic), state(&scoped), "another kind applied as turn/started");

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
    check(&generic, &scoped, "a record kept whole");
}

/// Each way a `turn/started` write can fail, planning, writing its journal,
/// metadata or Item rows, or at COMMIT, publishes nothing: the held record, its rows and journal, rev,
/// brief and the changes its rows still lack stay as they were, and once
/// the fault is gone the next write goes through with those changes.
#[test]
fn a_started_turn_whose_write_fails_publishes_nothing() {
    for (fault, undo, wrote) in [
        ("ALTER TABLE agent_turns RENAME TO hidden_turns;", "ALTER TABLE hidden_turns RENAME TO agent_turns;", false),
        ("CREATE TRIGGER refuse BEFORE INSERT ON journal WHEN NEW.kind='turn/started' BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            "DROP TRIGGER refuse;", true),
        ("CREATE TRIGGER refuse BEFORE UPDATE ON agents BEGIN SELECT RAISE(ABORT, 'refused'); END;", "DROP TRIGGER refuse;", true),
        ("CREATE TRIGGER refuse BEFORE INSERT ON agent_items WHEN NEW.turn_id='lost' BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            "DROP TRIGGER refuse;", true),
        ("CREATE TABLE t140_parent(id INTEGER PRIMARY KEY);
          CREATE TABLE t140_child(parent INTEGER REFERENCES t140_parent(id) DEFERRABLE INITIALLY DEFERRED);
          CREATE TRIGGER t140_orphan AFTER INSERT ON journal WHEN NEW.kind='turn/started'
              BEGIN INSERT INTO t140_child(parent) VALUES(-1); END;", "DROP TRIGGER t140_orphan;", true),
    ] {
        let ((_ga, _generic), (_sa, store)) = pair();
        super::tests::stream(&store, "a", "item/completed",
            &json!({"turnId":"t5","item":{"id":"m5","type":"agentMessage","text":"later"}}));
        let unwritten = || store.memory.lock().unwrap().held.get("a").map(|held| held.unwritten.clone());
        let (before, lacking) = (published(&store), unwritten());
        store.db.write().unwrap().execute_batch(fault).unwrap();
        let taken = started_in_place();
        let lost = started("lost", json!([{"id":"u-lost","type":"userMessage","content":[{"type":"text","text":"x"}]}]));
        assert!(store.record_applied("a", "turn/started", "turn/started", &lost).is_err(), "{fault}");
        assert_eq!(started_in_place(), taken + u64::from(wrote), "{fault}: which path wrote");
        assert!(store.held("a").is_some(), "{fault}");
        store.db.write().unwrap().execute_batch(undo).unwrap();
        assert_eq!(published(&store), before, "{fault}");
        assert_eq!(unwritten(), lacking, "{fault}");
        let kept = started("kept", json!([{"id":"u-kept","type":"userMessage","content":[{"type":"text","text":"x"}]}]));
        store.record_applied("a", "turn/started", "turn/started", &kept).unwrap();
        let d = store.detail("a").unwrap();
        let ids: Vec<&str> = d.turns.iter().filter_map(|t| t["id"].as_str()).collect();
        assert!(ids.contains(&"kept") && !ids.contains(&"lost"), "{fault}: {ids:?}");
        let written: i64 = store.db.read().unwrap()
            .query_row("SELECT count(*) FROM agent_items WHERE agent_id='a' AND item_id='m5' AND data LIKE '%later%'", [], |r| r.get(0)).unwrap();
        assert_eq!(written, 1, "{fault}: the streamed Item was not written");
    }
}

/// A reader of the held record sees each started Turn whole: never there
/// without its journal position, nor the other way round, and revs only
/// grow.
#[test]
fn readers_see_a_started_turn_with_its_journal_position_and_rev() {
    let ((_ga, _generic), (_sa, scoped)) = pair();
    let scoped = std::sync::Arc::new(scoped);
    let base = scoped.detail("a").unwrap();
    let (turns, seq) = (base.turns.len(), base.agent.last_seq);
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = {
        let (store, done) = (scoped.clone(), done.clone());
        std::thread::spawn(move || {
            let (mut rev, mut reads) = (0, 0);
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                let d = store.detail("a").unwrap();
                assert_eq!(d.agent.last_seq - seq, (d.turns.len() - turns) as i64, "a Turn and its journal row seen apart");
                assert!(d.agent.rev >= rev, "rev went back");
                rev = d.agent.rev;
                reads += 1;
            }
            reads
        })
    };
    let taken = started_in_place();
    for n in 0..60 {
        scoped.record_applied("a", "turn/started", "turn/started", &started(&format!("r{n}"), json!([]))).unwrap();
    }
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(reader.join().unwrap() > 0);
    assert_eq!(started_in_place(), taken + 60);
    assert_eq!(scoped.detail("a").unwrap().turns.len(), turns + 60);
}

/// Started Turns written in place while streamed Items reach the same record
/// on another thread leave held what its rows and journal rebuild.
#[test]
fn started_turns_racing_streamed_items_are_held_as_their_rows_and_journal_rebuild_them() {
    let ((_ga, _generic), (_sa, store)) = pair();
    let in_place = std::thread::scope(|s| {
        let streamer = s.spawn(|| {
            for n in 0..80 {
                super::tests::stream(&store, "a", "item/completed",
                    &json!({"turnId":"t5","item":{"id":format!("s{n}"),"type":"agentMessage","text":format!("streamed {n}")}}));
            }
        });
        let starter = s.spawn(|| {
            let before = started_in_place();
            for n in 0..40 {
                let data = started(&format!("r{n}"), json!([{"id":format!("u{n}"),"type":"userMessage","content":[{"type":"text","text":"x"}]}]));
                store.record_applied("a", "turn/started", "turn/started", &data).unwrap();
            }
            started_in_place() - before
        });
        streamer.join().unwrap();
        starter.join().unwrap()
    });
    assert_eq!(in_place, 40);
    let s = state(&store);
    assert_eq!(s["held"], s["reloaded"], "what is held is not what its rows and journal rebuild");
    let reloaded = &s["reloaded"]["turns"];
    let turns: Vec<&str> = reloaded.as_array().unwrap().iter().filter_map(|t| t["id"].as_str()).collect();
    assert!((0..40).all(|n| turns.contains(&format!("r{n}").as_str())), "{turns:?}");
    let t5 = reloaded.as_array().unwrap().iter().find(|t| t["id"] == "t5").unwrap();
    assert_eq!(t5["items"].as_array().unwrap().iter().filter(|i| i["id"].as_str().is_some_and(|id| id.starts_with('s'))).count(), 80);
}

/// `store`'s record with the text blocks `restore` gave the user message
/// `item` of Turn `turn` taken off again, in the held copy and in its row:
/// what a record read without binding holds (every way a record comes to be
/// held binds and restores it, so tests set it back).
fn unrestore(store: &Store, turn: &str, item: &str) {
    {
        let held = store.held("a").unwrap();
        let mut d = held.write();
        let message = d.turns.iter_mut().find(|t| t["id"] == turn).unwrap()["items"].as_array_mut().unwrap()
            .iter_mut().find(|i| i["id"] == item).unwrap();
        let fields = message.as_object_mut().unwrap();
        fields.remove(crate::message_content::BLOCKS);
        fields.remove("_yuzunoInputText");
    }
    let changed = store.db.write().unwrap().execute(
        "UPDATE agent_items SET data=json_remove(data,'$._yuzunoTextBlocks','$._yuzunoInputText')
         WHERE agent_id='a' AND turn_id=?1 AND item_id=?2", params![turn, item]).unwrap();
    assert_eq!(changed, 1);
}

/// The event's own apply restores a message of the Turn it names that the
/// event does not carry. Written in place, that Item's row is written as
/// comparing writes it.
#[test]
fn a_started_turn_writes_the_messages_its_apply_restores() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    let late = started("n5", json!([{"id":"u-n5","type":"userMessage","clientId":"late-5","content":[{"type":"text","text":"late text"}]}]));
    let mut receipt5 = receipt("late-5", "late text");
    receipt5.input.text_blocks = Some(vec![crate::message_content::TextBlock { id: "b".into(), start: 0, end: 4 }]);
    for store in [&generic, &scoped] {
        let copy = receipt5.clone();
        store.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(copy)).unwrap();
        store.record_applied("a", "turn/started", "turn/started", &late).unwrap();
        unrestore(store, "n5", "u-n5");
    }
    // The event again, carrying no Item: only its apply restores the message.
    assert!(start_both(&generic, &scoped, "turn/started", &started("n5", json!([]))), "not written in place");
    let restored = state(&scoped);
    assert_eq!(state(&generic), restored);
    let item = &restored["reloaded"]["turns"].as_array().unwrap().iter().find(|t| t["id"] == "n5").unwrap()["items"][0];
    assert!(item.get(crate::message_content::BLOCKS).is_some(), "the restored message was not written: {item}");
}

/// A client ID twice in the Turn a `turn/started` names: the receipt is bound
/// to the later user message, and `restore` gives the earlier one, whose ID
/// is synthetic, that message's ID. Written in place, the Turn, its Items and
/// the old ID's row, the receipts, the journal and the rev are as comparing
/// leaves them. Such a rename always leaves two Items of one ID in the Turn
/// (`restore` renames only to the ID a receipt is bound to in the same Turn),
/// and the event names that Turn, so all its Items are written three ways:
/// by the rename `restore` reports, by `Dirty::identified`, and by the
/// positional row keys of Items with one ID (rows of keys gone deleted).
#[test]
fn a_started_turn_writes_the_message_restore_renames() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    let same = |step: &str, in_place: bool| {
        assert!(in_place, "{step}: the scoped store copied the record");
        assert_eq!(state(&generic), state(&scoped), "{step}");
        for store in [&generic, &scoped] {
            store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
        }
    };
    let mut sent = receipt("dup-7", "same text");
    sent.input.text_blocks = Some(vec![crate::message_content::TextBlock { id: "b".into(), start: 0, end: 4 }]);
    for store in [&generic, &scoped] {
        let copy = sent.clone();
        store.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(copy)).unwrap();
    }
    let earlier = json!({"id":"item-3","type":"userMessage","clientId":"dup-7","content":[{"type":"text","text":"same text"}]});
    let later = json!({"id":"u-n7","type":"userMessage","clientId":"dup-7","content":[{"type":"text","text":"same text"}]});
    same("the earlier message, its receipt bound to it", start_both(&generic, &scoped, "turn/started", &started("n7", json!([earlier]))));
    let binding = |store: &Store| {
        let d = store.detail("a").unwrap();
        let b = d.message_receipts.iter().find(|r| r.input.client_message_id == "dup-7").unwrap().binding.clone().unwrap();
        (b.turn_id, b.item_id, b.user_index)
    };
    assert_eq!(binding(&scoped), ("n7".into(), "item-3".into(), 0));
    same("the later message, the earlier one renamed", start_both(&generic, &scoped, "turn/started", &started("n7", json!([later]))));
    assert_eq!(binding(&scoped), ("n7".into(), "u-n7".into(), 1));
    // The event again: nothing left to rename.
    same("the event again", start_both(&generic, &scoped, "turn/started", &started("n7", json!([]))));
    let s = state(&scoped);
    for kept in [&s["held"], &s["reloaded"]] {
        let items = &kept["turns"].as_array().unwrap().iter().find(|t| t["id"] == "n7").unwrap()["items"];
        let ids: Vec<&str> = items.as_array().unwrap().iter().filter_map(|i| i["id"].as_str()).collect();
        assert_eq!(ids, ["u-n7", "u-n7"], "the earlier message was not renamed");
        assert!(items.as_array().unwrap().iter().all(|i| i.get(crate::message_content::BLOCKS).is_some()), "{items}");
    }
    assert!(!s["rows"]["agent_items"].as_array().unwrap().iter().any(|row| row[1] == "item-3"), "the old ID's row was kept");
}

/// Receipts bound, restored and accepted by every Turn, as `apply` and
/// `commit` do, with the started Turn copied: a client ID in Turns before and
/// after it (bound by the last, accepted by the first), a receipt whose
/// binding moves, one still to be accepted from an older Turn, and a Turn
/// already ended, whose `apply` skips that step while `commit` still binds.
#[test]
fn a_started_turn_binds_and_accepts_receipts_by_every_turn() {
    let ((_ga, generic), (_sa, scoped)) = pair();
    let same = |step: &str, in_place: bool| {
        assert!(in_place, "{step}: the scoped store copied the record");
        assert_eq!(state(&generic), state(&scoped), "{step}");
        for store in [&generic, &scoped] {
            store.record_event("a", "test/hold", &json!({}), |_| {}).unwrap();
        }
    };
    // A Turn in the middle, "mid", and one after it with a message whose
    // client ID is also in Turn t1 and in no receipt yet.
    for store in [&generic, &scoped] {
        store.record_event("a", "test/turns", &json!({}), |d| {
            d.turns[1]["items"][0]["clientId"] = json!("dup");
            d.turns.push(json!({"id":"mid","status":"inProgress","items":[]}));
            d.turns.push(json!({"id":"late","status":"completed","items":[
                {"id":"u-late","type":"userMessage","clientId":"dup","content":[{"type":"text","text":"message 1"}]}]}));
        }).unwrap();
    }
    // A receipt still to be accepted, its client ID in t1 and "late".
    for store in [&generic, &scoped] {
        store.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("dup", "message 1"))).unwrap();
    }
    // The started Turn's message carries the same client ID: bound by the
    // last match ("late"), accepted by the first (t1).
    let mid = started("mid", json!([{"id":"u-mid","type":"userMessage","clientId":"dup","content":[{"type":"text","text":"message 1"}]}]));
    same("a client ID before and after the started Turn", start_both(&generic, &scoped, "turn/started", &mid));
    let dup = scoped.detail("a").unwrap().message_receipts.into_iter().find(|r| r.input.client_message_id == "dup").unwrap();
    assert_eq!((dup.status.as_str(), dup.turn_id.as_deref()), ("accepted", Some("t1")));
    assert_eq!(dup.binding.map(|b| b.turn_id), Some("late".to_string()));

    // A receipt bound to an older Turn's message whose client ID the started
    // Turn's message carries now: its binding moves to the started Turn.
    let moved = started("n6", json!([{"id":"u-n6","type":"userMessage","clientId":"old-4","content":[{"type":"text","text":"message 4"}]}]));
    for store in [&generic, &scoped] {
        let mut bound = receipt("old-4", "message 4");
        bound.status = "accepted".into();
        bound.turn_id = Some("t4".into());
        store.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(bound)).unwrap();
    }
    same("a binding that moves", start_both(&generic, &scoped, "turn/started", &moved));
    let old4 = scoped.detail("a").unwrap().message_receipts.into_iter().find(|r| r.input.client_message_id == "old-4").unwrap();
    assert_eq!(old4.binding.map(|b| b.turn_id), Some("n6".to_string()));

    // A Turn already ended: `apply` returns before the receipts, so a
    // receipt still to be accepted from an older Turn stays as it is.
    for store in [&generic, &scoped] {
        store.update_meta("a", "message/requested", &json!({}), |m| m.message_receipts.push(receipt("old-2", "message 2"))).unwrap();
    }
    let ended = started("t3", json!([{"id":"late-t3","type":"agentMessage","text":"late"}]));
    same("a Turn already ended, a receipt still to be accepted", start_both(&generic, &scoped, "turn/started", &ended));
    let old2 = scoped.detail("a").unwrap().message_receipts.into_iter().find(|r| r.input.client_message_id == "old-2").unwrap();
    assert_eq!(old2.status, "sending");
    // The next one accepts it from t2, as the whole record's apply does.
    same("then a new Turn", start_both(&generic, &scoped, "turn/started", &started("n7", json!([]))));
    let old2 = scoped.detail("a").unwrap().message_receipts.into_iter().find(|r| r.input.client_message_id == "old-2").unwrap();
    assert_eq!((old2.status.as_str(), old2.turn_id.as_deref()), ("accepted", Some("t2")));
}
