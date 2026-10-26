use super::*;
use chrono::{DateTime, Utc};
use serde_json::json;

/// The metadata row is serde's own output of the record without its Turns
/// and receipts, whatever members it has.
#[test]
fn the_metadata_row_is_the_record_without_turns_or_receipts() {
    let sparse: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m",
        "color":"sage","threadId":null,"status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
        "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    let mut full = sparse.clone();
    full.turns = vec![json!({"id":"t","status":"completed","items":[{"id":"i","type":"agentMessage","text":"q\" {x}"}]})];
    full.history = Some(crate::model::HistoryWindow { next_cursor: Some("c".into()), has_more: true, loaded_count: 1 });
    full.pending = serde_json::from_value(json!([{"id":"p","agentId":"a","method":"m","params":{"z":1,"a":2},"createdAt":"now"}])).unwrap();
    full.artifacts = serde_json::from_value(json!([{"path":"/x","name":"x","kind":"file","sourceItemId":"i"}])).unwrap();
    full.context_usage = crate::model::ContextUsage::measured(10, 100, "t", Utc::now());
    full.message_receipts = serde_json::from_value(json!([{"input":{"clientMessageId":"m","text":"hi"},"status":"accepted","turnId":"t"}])).unwrap();
    full.claude_runtime = Some(Default::default());
    full.codex_handoff = Some(crate::model::CodexHandoff { writer_conflict_at: Some("then".into()), ..Default::default() });
    for detail in [&sparse, &full] {
        let row = MetaBody::of(detail).unwrap().row(&detail.agent).unwrap();
        let mut expected = serde_json::to_value(detail).unwrap();
        expected.as_object_mut().unwrap().remove("turns");
        expected.as_object_mut().unwrap().remove("messageReceipts");
        assert_eq!(serde_json::from_str::<Value>(&row).unwrap(), expected);
        let read = from_meta(&row).unwrap();
        assert!(read.turns.is_empty() && read.message_receipts.is_empty());
        assert_eq!(serde_json::to_value(&read.agent).unwrap(), serde_json::to_value(&detail.agent).unwrap());
    }
}

fn apply(detail: &mut AgentDetail, kind: &str, data: &Value, at: DateTime<Utc>) {
    if kind.starts_with("claude/") {
        crate::claude::project_event_at(detail, data["turnId"].as_str(), &data["event"], at);
    } else {
        detail.apply_at(kind, data, at);
    }
}

fn without_items(turn: &Value) -> Value {
    let mut turn = turn.clone();
    if let Some(members) = turn.as_object_mut() {
        members.remove("items");
    }
    turn
}

/// What a write with `named` would leave stale after `before` became
/// `after`, given what a write finds by itself: new, removed and moved
/// Turns, and new, removed and moved Items of every Turn it writes or
/// whose Item count changed.
fn stale(named: &Dirty, before: &AgentDetail, after: &AgentDetail) -> Option<String> {
    if named.all {
        return None;
    }
    let old = by_id(&before.turns).expect("Turn IDs");
    for turn in &after.turns {
        let id = turn["id"].as_str().expect("Turn ID");
        let Some(previous) = old.get(id) else { continue };
        if *previous == turn {
            continue;
        }
        let touched = named.turns.get(id);
        if without_items(previous) != without_items(turn) && touched.is_none() && !named.turn_rows {
            return Some(format!("Turn {id}'s own fields"));
        }
        let (Some(was), Some(now)) = (split_items(previous), split_items(turn)) else {
            return touched.is_none().then(|| format!("Turn {id} stored whole"));
        };
        if touched.is_none() && was.len() == now.len() {
            if was != now {
                return Some(format!("Items of Turn {id}, which is not named"));
            }
            continue;
        }
        let was = by_id(was).expect("Item IDs");
        for item in now {
            let item_id = item["id"].as_str().expect("Item ID");
            if was.get(item_id).is_some_and(|w| *w != item)
                && !touched.is_some_and(|t| t.all_items || t.items.contains(item_id)) {
                return Some(format!("Item {item_id} of Turn {id}"));
            }
        }
    }
    None
}

/// Applies each event to `after`, checks what `of_event` names against
/// what changed, then brings `before` level (no copy of the record).
fn check(before: &mut AgentDetail, after: &mut AgentDetail, events: &[(String, Value, DateTime<Utc>)]) -> usize {
    let mut changed = 0;
    for (n, (kind, data, at)) in events.iter().enumerate() {
        apply(after, kind, data, *at);
        if let Some(what) = stale(&Dirty::of_applied(after, kind, data), before, after) {
            panic!("event {n} ({kind}) changed {what} without naming it");
        }
        changed += usize::from(!Dirty::between(&before.turns, &after.turns).is_meta_only());
        apply(before, kind, data, *at);
    }
    changed
}

/// Looking an Item up by ID in any Turn, and rows keyed by position,
/// read an index, never every Item of the Agent.
#[test]
fn item_lookups_use_indexes() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);").unwrap();
    migrate(&db).unwrap();
    for sql in [NEWEST_ITEM, POSITIONAL_ITEMS] {
        let plan: Vec<String> = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap()
            .query_map(params!["a", "x"], |r| r.get::<_, String>(3)).unwrap().map(Result::unwrap).collect();
        let items = plan.iter().find(|step| step.contains(" i ")).unwrap();
        assert!(items.contains("agent_items_by_id") && items.contains("item_id"), "{plan:?}");
    }
}

fn record(harness: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/w","model":"m","color":"sage","harness":harness,
        "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"old","status":"completed","items":[{"id":"x","type":"agentMessage","text":"old"}]},
            {"id":"t","status":"inProgress","items":[]}],"pending":[],"artifacts":[],
        "claudeRuntime":{"contextWindow":200000}})).unwrap()
}

#[test]
fn of_event_names_what_codex_events_change() {
    let at = Utc::now();
    let events: Vec<(String, Value, DateTime<Utc>)> = [
        ("turn/started", json!({"turn":{"id":"t","status":"inProgress","items":[]}})),
        ("item/started", json!({"turnId":"t","item":{"id":"c","type":"commandExecution","status":"inProgress"}})),
        ("item/commandExecution/outputDelta", json!({"turnId":"t","itemId":"c","delta":"out\n"})),
        ("item/agentMessage/delta", json!({"turnId":"t","itemId":"m","delta":"Hel"})),
        ("item/agentMessage/delta", json!({"turnId":"t","itemId":"m","delta":"lo"})),
        ("item/reasoning/summaryPartAdded", json!({"turnId":"t","itemId":"r","summaryIndex":1})),
        ("item/reasoning/summaryTextDelta", json!({"turnId":"t","itemId":"r","summaryIndex":1,"delta":"why"})),
        ("item/plan/delta", json!({"turnId":"t","itemId":"p","delta":"1."})),
        ("turn/plan/updated", json!({"turnId":"t","plan":[{"step":"a","status":"pending"}]})),
        ("item/started", json!({"turnId":"t","item":{"id":"k","type":"contextCompaction"}})),
        ("thread/compacted", json!({"turnId":"t"})),
        ("item/completed", json!({"turnId":"t","item":{"id":"k","type":"contextCompaction"}})),
        ("item/started", json!({"turnId":"t","item":{"id":"k2","type":"contextCompaction"}})),
        ("thread/compacted", json!({})),
        ("item/completed", json!({"turnId":"t","item":{"id":"f","type":"fileChange","changes":[{"path":"/w/a"}]}})),
        ("item/completed", json!({"turnId":"t","item":{"id":"m","type":"agentMessage","text":"Hello"}})),
        ("item/started", json!({"turnId":"new","item":{"id":"n","type":"agentMessage","text":""}})),
        ("thread/tokenUsage/updated", json!({"turnId":"t","tokenUsage":{"last":{"totalTokens":5},"modelContextWindow":100}})),
        ("hook/started", json!({"turnId":"t","run":{"id":"h"}})),
        ("account/rateLimits/updated", json!({"rateLimits":{}})),
        ("turn/diff/updated", json!({"turnId":"t","diff":"..."})),
        ("item/autoApprovalReview/started", json!({"turnId":"t","review":{}})),
        ("error", json!({"error":{"message":"x"},"willRetry":true})),
        ("serverRequest/resolved", json!({"requestId":1})),
        ("turn/completed", json!({"turn":{"id":"t","status":"completed","items":[{"id":"c","type":"commandExecution","aggregatedOutput":"all"},{"id":"z","type":"agentMessage","text":"final"}]}})),
        ("turn/started", json!({"turn":{"id":"old","status":"inProgress"}})),
        ("item/agentMessage/delta", json!({"turnId":"old","itemId":"x","delta":" more"})),
    ].into_iter().map(|(k, d)| (k.to_owned(), d, at)).collect();
    let (mut before, mut after) = (record("codex"), record("codex"));
    assert!(check(&mut before, &mut after, &events) > 15);
}

#[test]
fn of_event_names_what_claude_events_change() {
    let at = Utc::now();
    let claude = |event: Value| ("claude/".to_owned() + event["type"].as_str().unwrap(), json!({"type":"event","turnId":"t","event":event}), at);
    let mut events = vec![
        claude(json!({"type":"system","subtype":"init","model":"opus","claude_code_version":"2"})),
        claude(json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","usage":{"input_tokens":10}}}})),
        claude(json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}})),
        claude(json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}})),
        claude(json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}})),
        claude(json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}})),
        claude(json!({"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool","name":"Bash","input":{}}}})),
        claude(json!({"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}})),
        claude(json!({"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":5}}})),
        claude(json!({"type":"system","subtype":"thinking_tokens","tokens":3})),
        claude(json!({"type":"assistant","uuid":"u1","message":{"id":"m1","content":[{"type":"thinking","thinking":"hmm"}]}})),
        claude(json!({"type":"assistant","uuid":"u2","message":{"id":"m1","content":[{"type":"text","text":"Hi"}]}})),
        claude(json!({"type":"assistant","uuid":"u3","message":{"id":"m1","content":[{"type":"tool_use","id":"tool","name":"Bash","input":{"command":"ls"}}]}})),
        claude(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool","content":"a.rs"}]}})),
        claude(json!({"type":"tool_progress","tool_use_id":"tool","elapsed_time_seconds":3})),
        claude(json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}})),
        claude(json!({"type":"system","subtype":"status","status":"requesting"})),
        claude(json!({"type":"system","subtype":"compact_boundary"})),
        claude(json!({"type":"result","subtype":"success","is_error":false,"result":"Hi","modelUsage":{"opus":{"contextWindow":200000}}})),
    ];
    events.push(("claude/assistant".into(), json!({"turnId":"missing","event":{"type":"assistant","message":{"id":"m","content":[]}}}), at));
    let (mut before, mut after) = (record("claude"), record("claude"));
    assert!(check(&mut before, &mut after, &events) > 10);
}

/// A Claude sub-agent's frames and task events change the Turn of its
/// call, whichever Turn the event names, if any.
#[test]
fn of_applied_names_the_turn_of_a_subagents_call() {
    let at = Utc::now();
    let claude = |turn: Value, event: Value| ("claude/".to_owned() + event["type"].as_str().unwrap(), json!({"type":"event","turnId":turn,"event":event}), at);
    let sub = |id: &str| json!({"type":"assistant","uuid":id,"parent_tool_use_id":"agent","message":{"id":id,"content":[
        {"type":"tool_use","id":id,"name":"Read","input":{}}]}});
    let events = vec![
        claude("t".into(), json!({"type":"assistant","uuid":"u","message":{"id":"m","content":[{"type":"tool_use","id":"agent","name":"Agent","input":{}}]}})),
        claude("t".into(), json!({"type":"system","subtype":"task_started","task_id":"task","tool_use_id":"agent","task_type":"local_agent","is_backgrounded":true})),
        claude("t".into(), json!({"type":"result","subtype":"success","is_error":false,"result":""})),
        claude(Value::Null, sub("late")),
        claude("old".into(), sub("elsewhere")),
        claude(Value::Null, json!({"type":"system","subtype":"task_progress","task_id":"task","tool_use_id":"agent","last_tool_name":"Read"})),
        claude(Value::Null, json!({"type":"user","parent_tool_use_id":"agent","message":{"content":[{"type":"tool_result","tool_use_id":"late","content":"x"}]}})),
        claude(Value::Null, json!({"type":"system","subtype":"task_updated","task_id":"task","patch":{"status":"completed"}})),
    ];
    let (mut before, mut after) = (record("claude"), record("claude"));
    assert_eq!(check(&mut before, &mut after, &events), events.len());
    assert_eq!(after.turns[0]["items"].as_array().unwrap().len(), 1, "nothing landed in the Turn an event named");
}

fn rows_db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);").unwrap();
    migrate(&db).unwrap();
    db
}

/// One field over TRIM_ABOVE (a payload) and one exactly at it (kept in
/// its Item row, as client_view::trim decides), stored as rows.
fn payload_record(db: &Connection) -> AgentDetail {
    let limit = crate::client_view::TRIM_ABOVE;
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/w","model":"m","color":"sage",
        "threadId":"thread","status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"t1","status":"completed","items":[
            {"id":"big","type":"commandExecution","command":"c","aggregatedOutput":"x".repeat(limit + 200),"exitCode":0},
            {"id":"at","type":"commandExecution","command":"c","aggregatedOutput":"y".repeat(limit),"exitCode":0},
            {"id":"say","type":"agentMessage","text":"done"}]}],
        "pending":[],"artifacts":[]})).unwrap();
    let tx = db.unchecked_transaction().unwrap();
    insert(&tx, "a", &split(&detail).unwrap()).unwrap();
    tx.commit().unwrap();
    detail
}

/// A Turn read without its payloads is the Turn with each Item as
/// `compact` makes it: what an active Agent keeps of an ended Item is
/// exactly what the writer recognizes as stored (`item_out`).
#[test]
fn a_turn_read_without_payloads_is_its_items_compacted() {
    let db = rows_db();
    let detail = payload_record(&db);
    let payloads: i64 = db.query_row("SELECT COUNT(*) FROM agent_payloads", [], |r| r.get(0)).unwrap();
    assert_eq!(payloads, 1, "only the field over TRIM_ABOVE is a payload");
    assert_eq!(load_turn(&db, "a", "t1", true).unwrap().unwrap(), detail.turns[0]);
    assert_eq!(load_item(&db, "a", Some("t1"), "big", true).unwrap().unwrap()["items"][0], detail.turns[0]["items"][0]);
    let mut compacted = detail.turns[0].clone();
    for item in compacted["items"].as_array_mut().unwrap() {
        compact(item);
    }
    assert_ne!(compacted, detail.turns[0]);
    assert_eq!(load_turn(&db, "a", "t1", false).unwrap().unwrap(), compacted);
    let mut meta = detail.clone();
    meta.turns.clear();
    assert_eq!(serde_json::to_value(load_meta(&db, "a").unwrap().unwrap()).unwrap(), serde_json::to_value(&meta).unwrap());
}

/// A payload whose text is not JSON makes the record Damaged; one that is
/// not text at all is a read error.
#[test]
fn a_payload_that_is_not_json_is_damaged_and_one_that_is_not_text_is_a_read_error() {
    let db = rows_db();
    payload_record(&db);
    db.execute("UPDATE agent_payloads SET data='not json'", []).unwrap();
    for error in [load_turn(&db, "a", "t1", true).unwrap_err(), load_item(&db, "a", Some("t1"), "big", true).unwrap_err()] {
        assert!(error.downcast_ref::<Damaged>().is_some(), "{error:#}");
    }
    // Read without payloads, the Turn does not need them.
    assert!(load_turn(&db, "a", "t1", false).unwrap().is_some());
    db.execute("UPDATE agent_payloads SET data=x'ff'", []).unwrap();
    for error in [load_turn(&db, "a", "t1", true).map(drop).unwrap_err(), load_item(&db, "a", Some("t1"), "big", true).map(drop).unwrap_err()] {
        assert!(error.downcast_ref::<Damaged>().is_none() && error.downcast_ref::<rusqlite::Error>().is_some(), "{error:#}");
    }
}

/// A Turn written with a gap keeps the gap's rows as they are, moved when
/// Items before it change, and refuses an Item the gap's rows hold.
#[test]
fn a_gap_keeps_its_rows_and_refuses_an_item_it_holds() {
    let db = rows_db();
    let item = |n: usize, text: &str| json!({"id":format!("i{n}"),"type":"agentMessage","text":text});
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/w","model":"m","color":"sage",
        "threadId":"thread","status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"t","status":"inProgress","items":(0..10).map(|n| item(n, "x")).collect::<Vec<_>>()}],
        "pending":[],"artifacts":[]})).unwrap();
    let tx = db.unchecked_transaction().unwrap();
    insert(&tx, "a", &split(&detail).unwrap()).unwrap();
    tx.commit().unwrap();
    let write = |turns: Vec<Value>, dirty: &Dirty| -> Result<Written> {
        let mut d = detail.clone();
        d.turns = turns;
        let plan = plan(&db, "a", &d, &d.turns, &[], dirty, &[])?;
        let tx = db.unchecked_transaction().unwrap();
        let written = super::apply(&tx, "a", &plan, &d.agent)?;
        tx.commit().unwrap();
        Ok(written)
    };
    let held = |items: Vec<Value>| vec![json!({"id":"t","status":"inProgress","items":items})];
    // i0..i5 left to their rows; i9 changed and i10 new.
    write(held(vec![gap(0, 6), item(6, "x"), item(7, "x"), item(8, "x"), item(9, "changed"), item(10, "new")]),
        Dirty::default().item("t", "i9").item("t", "i10")).unwrap();
    let back = load_turn(&db, "a", "t", true).unwrap().unwrap();
    let ids: Vec<&str> = back["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(ids, (0..11).map(|n| format!("i{n}")).collect::<Vec<_>>());
    assert_eq!((back["items"][3]["text"].as_str(), back["items"][9]["text"].as_str()), (Some("x"), Some("changed")));
    // An Item the gap holds, again after it: nothing is written.
    let refused = write(held(vec![gap(0, 6), item(6, "x"), item(7, "x"), item(8, "x"), item(9, "changed"), item(10, "new"),
        item(3, "twice")]), Dirty::default().item("t", "i3")).unwrap_err();
    assert!(refused.downcast_ref::<GapConflict>().is_some(), "{refused:#}");
    assert_eq!(load_turn(&db, "a", "t", true).unwrap().unwrap()["items"].as_array().unwrap().len(), 11);
    // An Item before the gap: the gap's rows move after it.
    write(held(vec![item(99, "first"), gap(0, 6), item(6, "x"), item(7, "x"), item(8, "x"), item(9, "changed"), item(10, "new")]),
        Dirty::default().item("t", "i99")).unwrap();
    let back = load_turn(&db, "a", "t", true).unwrap().unwrap();
    let ids: Vec<&str> = back["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(ids[..3], ["i99", "i0", "i1"]);
    assert_eq!(ids.len(), 12);
    assert!(rows_fit(&db, "a").unwrap());
}

/// An Item held without payloads stands for the whole Item it was read
/// from, with or without its time, and for no other.
#[test]
fn a_compact_item_holds_its_whole_item_only() {
    let whole = json!({"id": "c", "type": "commandExecution", "status": "completed", "aggregatedOutput": "x".repeat(200_000)});
    let mut held = whole.clone();
    compact(&mut held);
    assert_ne!(held, whole);
    assert!(holds(&held, &whole));
    assert!(holds(&whole, &whole));
    held[crate::conversation_time::ITEM_TIME] = json!({"startedAt": "2026-10-26T00:00:00Z"});
    assert!(holds(&held, &whole), "a time the snapshot lacks is the held Item's own");
    let mut longer = whole.clone();
    longer["aggregatedOutput"] = json!(format!("{}y", "x".repeat(200_000)));
    assert!(!holds(&held, &longer));
    let mut failed = whole.clone();
    failed["status"] = json!("failed");
    assert!(!holds(&held, &failed));
    let mut more = whole.clone();
    more["exitCode"] = json!(1);
    assert!(!holds(&held, &more));
}
