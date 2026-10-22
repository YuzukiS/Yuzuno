//! `Store::send_view` of a record that is not held reads its rows a Turn at a
//! time and keeps only the Items the view keeps (T-140, `read_send`). The
//! oracle is the read it replaces: `send_view_of` of the rows without
//! payloads (`View::Rows`). Each case is set up the same way in two stores;
//! one is read the new way, the other the old, and both must give the same
//! view, the same error and the same damage mark, and so must a second read.
use super::*;

const LARGE: usize = 20_000;

fn record(turns: Value, pending: Value) -> AgentDetail {
    serde_json::from_value(json!({
        "agent": {"id": "a", "name": "a", "cwd": "/tmp", "model": "m", "color": "sage", "threadId": "thread",
            "status": "working", "connectionState": "connected", "createdAt": "", "updatedAt": "", "unreadCount": 0,
            "pendingCount": 1, "lastSeq": 0, "reviewedSeq": 0},
        "turns": turns,
        "pending": pending,
        "contextUsage": {"usedTokens": 1, "windowTokens": 2, "usedPercent": 50.0, "turnId": "t2", "updatedAt": "", "stale": false},
        "messageReceipts": [{"input": {"clientMessageId": "c1", "text": "hello"}, "status": "accepted", "turnId": "t0",
            "error": null, "binding": {"turnId": "t0", "itemId": "u0", "userIndex": 0}}],
        "artifacts": []})).unwrap()
}

/// Three Turns: one with a user message, a large command output, a large
/// async question and a reply; one stored whole (no Item array); the newest,
/// running, with a small async question and a large running command.
fn turns() -> Value {
    json!([
        {"id": "t0", "status": "completed", "items": [
            {"id": "u0", "type": "userMessage", "clientId": "c1", "content": [{"type": "text", "text": "hello"}]},
            {"id": "c0", "type": "commandExecution", "status": "completed", "command": "ls", "aggregatedOutput": "o".repeat(LARGE)},
            {"id": "q0", "type": "requestUserInput", "delivery": "async", "questions": [{"id": "q", "question": "which?"}],
                "detail": "d".repeat(LARGE)},
            {"id": "m0", "type": "agentMessage", "text": "done"}]},
        {"id": "t1", "status": "completed"},
        {"id": "t2", "status": "inProgress", "items": [
            {"id": "q2", "type": "requestUserInput", "delivery": "async", "questions": [{"id": "q", "question": "go on?"}]},
            {"id": "c2", "type": "commandExecution", "status": "inProgress", "command": "make", "aggregatedOutput": "m".repeat(LARGE)}]}
    ])
}

fn approval(item: &str) -> Value {
    json!([{"id": "request-a", "agentId": "a", "method": "item/commandExecution/requestApproval",
        "params": {"_rpcId": 7, "turnId": "t2", "itemId": item, "command": "make"}, "createdAt": "2026-10-22", "stale": false}])
}

/// A store holding `detail` as rows, nothing of it held in memory, with
/// `prepare` applied to its database.
fn stored(detail: &AgentDetail, prepare: &dyn Fn(&Store)) -> (tempfile::TempDir, Store) {
    let (dir, store) = super::tests::lab();
    store.insert(detail).unwrap();
    store.release("a");
    prepare(&store);
    (dir, store)
}

fn sql(store: &Store, statements: &str) {
    store.db.write().unwrap().execute_batch(statements).unwrap();
}

/// The send view as it was read before (`View::Rows`).
fn oracle(store: &Store) -> Result<AgentDetail> {
    let mut view = send_view_of(&store.current("a", View::Rows, &mut || {})?);
    view.agent.project_id = store.agent_project("a")?;
    Ok(view)
}

/// The clock is read in each store separately; nothing else may differ.
fn shown(read: Result<AgentDetail>, store: &Store) -> Value {
    fn walk(value: &mut Value) {
        match value {
            Value::Object(map) => map.iter_mut().for_each(|(key, value)| if key == "updatedAt" { *value = json!(0) } else { walk(value) }),
            Value::Array(values) => values.iter_mut().for_each(walk),
            _ => {}
        }
    }
    let mut value = match read {
        Ok(view) => serde_json::to_value(view).unwrap(),
        Err(error) => json!({"error": error.to_string()}),
    };
    walk(&mut value);
    json!({"view": value, "damaged": store.memory.lock().unwrap().damaged.contains("a")})
}

fn reads() -> u64 {
    SEND_ROWS_READS.with(|n| n.get())
}

/// Both reads of the case agree, twice, and the new one read the rows a
/// Turn at a time exactly when `from_rows`.
fn same(case: &str, detail: &AgentDetail, prepare: &dyn Fn(&Store), from_rows: bool) -> Value {
    let (_new_dir, new) = stored(detail, prepare);
    let (_old_dir, old) = stored(detail, prepare);
    let before = reads();
    let first = shown(new.send_view("a"), &new);
    assert_eq!(reads() - before, u64::from(from_rows), "{case}: read from rows a Turn at a time");
    assert_eq!(first, shown(oracle(&old), &old), "{case}");
    assert_eq!(shown(new.send_view("a"), &new), shown(oracle(&old), &old), "{case}: read again");
    first
}

#[test]
fn a_send_view_read_a_turn_at_a_time_is_the_view_the_rows_gave() {
    let plain = record(turns(), approval("c2"));
    let view = same("as written", &plain, &|_| {}, true);
    let turns = view["view"]["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0]["items"].as_array().unwrap().iter().map(|i| i["id"].clone()).collect::<Vec<_>>(), [json!("q0")]);
    assert!(turns[0]["items"][0].get(record_rows::TRUNCATED).is_some(), "an async question with a large field is its preview");
    assert!(turns[1].get("items").is_none(), "a Turn stored whole has no Item array, as before");
    assert_eq!(turns[2]["items"].as_array().unwrap().len(), 1);
    assert_eq!(view["view"]["messageReceipts"][0]["binding"]["itemId"], "u0");
    assert_eq!(view["view"]["pending"][0]["params"]["itemId"], "c2");

    let referenced = same("a pending request names the large async question", &record(turns(), approval("q0")), &|_| {}, true);
    assert!(referenced["view"]["turns"][0]["items"][0].get(record_rows::TRUNCATED).is_none(), "made whole, as before");
    assert_eq!(referenced["view"]["turns"][0]["items"][0]["detail"].as_str().map(str::len), Some(LARGE));
    same("a pending request names an Item that is not there", &record(turns(), approval("gone")), &|_| {}, true);
    same("no pending request", &record(turns(), json!([])), &|_| {}, true);
    same("no Turns", &record(json!([]), json!([])), &|_| {}, true);
    same("an empty Turn", &record(json!([{"id": "t0", "status": "completed", "items": []}]), json!([])), &|_| {}, true);
    let big: Vec<Value> = (0..3000).map(|n| if n % 500 == 0 {
        json!({"id": format!("q{n}"), "type": "requestUserInput", "delivery": "async", "questions": [{"id": "q", "question": "?"}]})
    } else {
        json!({"id": format!("i{n}"), "type": "commandExecution", "status": "completed", "command": "c",
            "aggregatedOutput": if n % 7 == 0 { "x".repeat(LARGE) } else { "short".into() }})
    }).collect();
    let one = same("one large Turn", &record(json!([{"id": "t0", "status": "inProgress", "items": big}]), json!([])), &|_| {}, true);
    assert_eq!(one["view"]["turns"][0]["items"].as_array().unwrap().len(), 6);
    same("a payload row nothing reads is missing", &plain, &|store| sql(store, "DELETE FROM agent_payloads WHERE item_id='c0'"), true);
    same("a read mark after the last write", &plain, &|store| {
        sql(store, "INSERT INTO journal(agent_id,kind,data,at) VALUES('a','workspace/reviewed','{\"throughSeq\":1}','2026-10-22T00:00:00Z')");
    }, true);
}

#[test]
fn the_rows_are_read_as_before_wherever_a_turn_at_a_time_could_differ() {
    let plain = record(turns(), approval("c2"));
    same("journal to replay", &plain, &|store| {
        let event = json!({"turnId": "t2", "item": {"id": "m3", "type": "agentMessage", "text": "after the last write"}});
        store.db.write().unwrap().execute(
            "INSERT INTO journal(agent_id,kind,data,at) VALUES('a','item/completed',?1,'2026-10-22T00:00:00Z')", [event.to_string()]).unwrap();
    }, false);
    same("stored whole", &plain, &|store| {
        let whole = serde_json::to_string(&store.detail("a").unwrap()).unwrap();
        let mut db = store.db.write().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("UPDATE agents SET layout=0, data=?1 WHERE id='a'", [whole]).unwrap();
        record_rows::delete_rows(&tx, "a").unwrap();
        tx.commit().unwrap();
        drop(db);
        store.memory.lock().unwrap().held.clear();
    }, false);
    let damaged: [(&str, &str); 9] = [
        ("an Item that does not parse", "UPDATE agent_items SET data='{not json' WHERE item_id='m0'"),
        ("previews that do not parse", "UPDATE agent_items SET previews='[' WHERE item_id='c0'"),
        ("previews not an object", "UPDATE agent_items SET previews='[1]' WHERE item_id='c0'"),
        ("previews of another count", "UPDATE agent_items SET previews='{}' WHERE item_id='c0'"),
        ("a number out of range in previews", "UPDATE agent_items SET previews='{\"aggregatedOutput\":1e400}' WHERE item_id='c0'"),
        ("an Item out of place", "UPDATE agent_items SET ord=7 WHERE item_id='m0'"),
        ("a Turn that does not parse", "UPDATE agent_turns SET data='{' WHERE ord=2"),
        ("Turns out of order", "UPDATE agent_turns SET ord=9 WHERE ord=2"),
        ("the referenced Item's payload is missing", "DELETE FROM agent_payloads WHERE item_id='c2'"),
    ];
    for (case, statement) in damaged {
        let view = same(case, &plain, &|store| sql(store, statement), false);
        assert_eq!(view["damaged"], true, "{case}: shown as damaged, as before");
    }
    let view = same("an Item row without its Turn row", &plain, &|store| sql(store,
        "PRAGMA foreign_keys=OFF; INSERT INTO agent_items(agent_id,turn_id,item_id,ord,payloads,data) VALUES('a','nowhere','x',0,0,'{}'); PRAGMA foreign_keys=ON;"), false);
    assert_eq!(view["damaged"], true);
    let (_dir, empty) = super::tests::lab();
    let missing = shown(empty.send_view("a"), &empty);
    assert_eq!(missing, shown(oracle(&empty), &empty));
    assert!(missing["view"]["error"].as_str().is_some_and(|e| e.contains("Agent 不存在")), "{missing}");
}

/// A write that commits while the rows are read is not missed: the read is
/// made again, or answered from the record the write left held.
#[test]
fn a_write_while_the_rows_are_read_is_in_the_send_view() {
    let (_dir, store) = stored(&record(turns(), approval("c2")), &|_| {});
    let completed = json!({"turn": {"id": "t2", "status": "completed", "items": []}});
    let mut once = true;
    let seen = send_view_of(&store.current("a", View::Send, &mut || {
        if std::mem::take(&mut once) {
            store.update("a", "turn/completed", &completed, |d| d.apply("turn/completed", &completed)).unwrap();
        }
    }).unwrap());
    assert_eq!(seen.turns[2]["status"], "completed");
    let top: i64 = store.db.read().unwrap()
        .query_row("SELECT MAX(seq) FROM journal WHERE agent_id='a' AND kind!='workspace/reviewed'", [], |r| r.get(0)).unwrap();
    assert_eq!(seen.agent.last_seq, top);

    // Released again, the next read is from the rows, and shows the end.
    store.release("a");
    let before = reads();
    let again = store.send_view("a").unwrap();
    assert_eq!(reads() - before, 1);
    assert_eq!(again.turns[2]["status"], "completed");
    assert_eq!(shown(Ok(again), &store)["view"], shown(oracle(&store), &store)["view"]);
}
