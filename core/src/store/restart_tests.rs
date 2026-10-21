//! `Store::open` marks open Agents restarted by their metadata alone when
//! that is all the whole-record commit would write (T-140): the same record,
//! sent through `restart_meta_only` and through the whole commit in two
//! stores, leaves the same rows, journal and record; every case that commit
//! would change more for is left to it.
use super::*;

/// The clock is read separately in each store; nothing else may differ.
fn normalized(mut value: Value) -> Value {
    fn walk(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, value) in map.iter_mut() {
                    if key == "updatedAt" {
                        *value = json!(0);
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

/// Every row and journal entry of Agent `a`, the record read back from its
/// rows alone and its listed view, without times.
fn state(store: &Store) -> Value {
    let rows = {
        let db = store.db.read().unwrap();
        let mut rows = json!({});
        for (table, columns) in [
            ("agents", "id, layout, data"),
            ("agent_turns", "turn_id, ord, items, data"),
            ("agent_items", "turn_id, item_id, ord, payloads, data, previews"),
            ("journal", "seq, kind, data"),
        ] {
            let key = if table == "agents" { "id" } else { "agent_id" };
            let mut statement = db.prepare(&format!("SELECT {columns} FROM {table} WHERE {key}='a' ORDER BY {columns}")).unwrap();
            let count = statement.column_count();
            let values: Vec<Value> = statement.query_map([], |row| {
                Ok((0..count).map(|i| match row.get_ref(i).unwrap() {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Text(t) => {
                        let text = String::from_utf8_lossy(t).into_owned();
                        serde_json::from_str(&text).unwrap_or(Value::String(text))
                    }
                    other => json!(format!("{other:?}")),
                }).collect())
            }).unwrap().collect::<rusqlite::Result<_>>().unwrap();
            rows[table] = values.into();
        }
        rows
    };
    {
        let mut memory = store.memory.lock().unwrap();
        memory.held.clear();
        memory.briefs.clear();
    }
    let reloaded = serde_json::to_value(store.detail("a").unwrap()).unwrap();
    let listed = serde_json::to_value(store.agent("a").unwrap()).unwrap();
    normalized(json!({"rows": rows, "reloaded": reloaded, "listed": listed}))
}

fn user(id: &str, client: Option<&str>, blocks: bool) -> Value {
    let mut item = json!({"id": id, "type": "userMessage", "content": [{"type": "text", "text": "hello"}]});
    if let Some(client) = client {
        item["clientId"] = json!(client);
    }
    if blocks {
        item[crate::message_content::BLOCKS] = json!([{"id": "b1", "start": 0, "end": 5}]);
    }
    item
}

fn receipt(client: &str, binding: Option<(&str, &str, usize)>, status: &str, blocks: bool) -> Value {
    let mut receipt = json!({"input": {"clientMessageId": client, "text": "hello"}, "status": status, "turnId": "t1", "error": null});
    if let Some((turn, item, index)) = binding {
        receipt["binding"] = json!({"turnId": turn, "itemId": item, "userIndex": index});
    }
    if blocks {
        receipt["input"]["textBlocks"] = json!([{"id": "b1", "start": 0, "end": 5}]);
    }
    receipt
}

/// Agent `a`: one Turn with a user message and a reply, a newest Turn, the
/// given receipts, a pending request and context usage, as Core wrote it.
fn record(user_item: Value, receipts: Vec<Value>, status: &str, newest: &str) -> AgentDetail {
    serde_json::from_value(json!({
        "agent": {"id": "a", "name": "a", "cwd": "/tmp", "model": "m", "color": "sage", "threadId": "thread",
            "status": status, "connectionState": "connected", "createdAt": "", "updatedAt": "", "unreadCount": 0,
            "pendingCount": 1, "lastSeq": 0, "reviewedSeq": 0},
        "turns": [
            {"id": "t1", "status": "completed", "items": [user_item, {"id": "m1", "type": "agentMessage", "text": "hi"}]},
            {"id": "t2", "status": newest, "items": [{"id": "m2", "type": "agentMessage", "text": "more"}]}],
        "pending": [{"id": "request-a", "agentId": "a", "method": "item/commandExecution/requestApproval",
            "params": {"_rpcId": 7, "turnId": "t2", "command": "git status"}, "createdAt": "2026-10-21", "stale": false}],
        "contextUsage": {"usedTokens": 1, "windowTokens": 2, "usedPercent": 50.0, "turnId": "t2", "updatedAt": "", "stale": false},
        "messageReceipts": receipts, "artifacts": []})).unwrap()
}

/// A store holding `detail` as rows, nothing of it held in memory, as
/// `Store::open` finds it.
fn stored(detail: &AgentDetail) -> (tempfile::TempDir, Store) {
    let (dir, store) = super::tests::lab();
    store.insert(detail).unwrap();
    store.release("a");
    store.memory.lock().unwrap().briefs.clear();
    (dir, store)
}

fn journal_len(store: &Store) -> i64 {
    store.db.read().unwrap().query_row("SELECT COUNT(*) FROM journal", [], |r| r.get(0)).unwrap()
}

#[test]
fn the_metadata_alone_is_what_the_whole_record_commit_writes() {
    let cases = [
        ("bound receipt", record(user("u1", Some("c1"), false), vec![receipt("c1", Some(("t1", "u1", 0)), "accepted", false)], "idle", "completed")),
        ("pasted blocks already shown", record(user("u1", Some("c1"), true), vec![receipt("c1", Some(("t1", "u1", 0)), "accepted", true)], "idle", "completed")),
        ("no receipts", record(user("u1", None, false), vec![], "working", "completed")),
        ("newest Turn still running", record(user("u1", Some("c1"), false), vec![receipt("c1", Some(("t1", "u1", 0)), "accepted", false)], "working", "inProgress")),
        ("unknown start stays unknown", record(user("u1", Some("c1"), false), vec![receipt("c1", Some(("t1", "u1", 0)), "uncertain", false)], "uncertain", "inProgress")),
    ];
    for (case, detail) in cases {
        let (_meta_dir, meta) = stored(&detail);
        let (_whole_dir, whole) = stored(&detail);
        assert!(meta.restart_meta_only("a").unwrap(), "{case}: written as metadata");
        whole.record_meta_change("a", "workspace/restarted", &json!({}), |d| {
            let newest = d.turns.last().is_some_and(|t| t["status"] == "inProgress");
            mark_restarted(d, newest);
        }).unwrap();
        whole.release("a");
        let (meta_state, whole_state) = (state(&meta), state(&whole));
        assert_eq!(meta_state, whole_state, "{case}");
        let record = &meta_state["reloaded"];
        assert_eq!(record["agent"]["connectionState"], "disconnected", "{case}");
        assert_eq!(record["pending"][0]["stale"], true, "{case}");
        assert_eq!(record["contextUsage"]["stale"], true, "{case}");
        let journal = meta_state["rows"]["journal"].as_array().unwrap();
        assert_eq!(journal.last().unwrap()[1], "workspace/restarted", "{case}");
        assert_eq!(record["agent"]["lastSeq"], journal.last().unwrap()[0], "{case}: last_seq is the restart's row");
    }
}

#[test]
fn the_record_is_read_whenever_restarting_could_change_more_than_the_metadata() {
    let replay = |store: &Store| {
        store.db.write().unwrap().execute(
            "INSERT INTO journal(agent_id,kind,data,at) VALUES('a','item/completed',?1,'2026-10-21T00:00:00Z')",
            [json!({"turnId": "t2", "item": {"id": "m3", "type": "agentMessage", "text": "after the last write"}}).to_string()],
        ).unwrap();
    };
    let cases: [(&str, AgentDetail, Option<&dyn Fn(&Store)>); 6] = [
        ("receipt not bound yet", record(user("u1", Some("c1"), false), vec![receipt("c1", None, "accepted", false)], "idle", "completed"), None),
        ("bound elsewhere", record(user("u1", Some("c1"), false), vec![receipt("c1", Some(("t1", "u1", 1)), "accepted", false)], "idle", "completed"), None),
        ("user message without its client ID", record(user("u1", None, false), vec![receipt("c1", Some(("t1", "u1", 0)), "accepted", false)], "idle", "completed"), None),
        ("pasted blocks not shown yet", record(user("u1", Some("c1"), false), vec![receipt("c1", Some(("t1", "u1", 0)), "accepted", true)], "idle", "completed"), None),
        ("message still being sent", record(user("u1", Some("c1"), false), vec![receipt("c1", Some(("t1", "u1", 0)), "sending", false)], "working", "inProgress"), None),
        ("journal to replay", record(user("u1", Some("c1"), false), vec![receipt("c1", Some(("t1", "u1", 0)), "accepted", false)], "working", "inProgress"), Some(&replay)),
    ];
    for (case, detail, prepare) in cases {
        let (_dir, store) = stored(&detail);
        if let Some(prepare) = prepare {
            prepare(&store);
        }
        let before = journal_len(&store);
        assert!(!store.restart_meta_only("a").unwrap(), "{case}: left to the whole record");
        assert_eq!(journal_len(&store), before, "{case}: nothing written");
    }
}

#[test]
fn opening_marks_open_agents_by_their_metadata_and_a_damaged_record_holds_back_no_other() {
    let (dir, store) = super::tests::lab();
    let mut plain = record(user("u1", Some("c1"), false), vec![receipt("c1", Some(("t1", "u1", 0)), "accepted", false)], "working", "inProgress");
    store.insert(&plain).unwrap();
    plain.agent.id = "b".into();
    store.insert(&plain).unwrap();
    let mut closed = plain.clone();
    closed.agent.id = "c".into();
    closed.agent.closed_at = Some("2026-10-21T00:00:00Z".into());
    store.insert(&closed).unwrap();
    drop(store);
    // Agent b's user message no longer parses: its record is damaged.
    rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap()
        .execute("UPDATE agent_items SET data='{not json' WHERE agent_id='b' AND item_id='u1'", []).unwrap();
    let before = RESTARTED_META_ONLY.with(|n| n.get());
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(RESTARTED_META_ONLY.with(|n| n.get()) - before, 1, "only a was marked by its metadata");
    let a = store.detail("a").unwrap();
    assert_eq!((a.agent.status.as_str(), a.agent.connection_state.as_str()), ("offline", "disconnected"));
    assert!(a.agent.error.as_deref().is_some_and(|e| e.contains("服务已重启")), "the running Turn is reported");
    assert_eq!(a.turns[1]["status"], "inProgress", "no Turn changes");
    assert!(store.agent("b").is_ok(), "b is still listed, as it is");
    assert!(store.agent("c").unwrap().closed_at.is_some(), "a closed Agent is not marked");
}
