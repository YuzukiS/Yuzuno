//! The session store's own checks (T-140): what memory keeps, what a change
//! writes, and that no read or change needs more than the Turns it names.
use super::*;

pub(super) fn lab() -> (tempfile::TempDir, Store) {
    // On disk, next to the build: /tmp is memory here. The folder may not
    // exist when CARGO_TARGET_DIR points elsewhere.
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    (dir, store)
}

pub(super) fn detail(id: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"m","color":"sage",
        "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[{"id":"t","status":"inProgress","items":[]}],"pending":[],"artifacts":[]})).unwrap()
}

pub(super) fn stream(store: &Store, id: &str, kind: &str, data: &Value) -> Streamed {
    store.record_stream(id, route(kind, data), kind, data).unwrap()
}

/// An Agent with `turns` ended Turns, each with a command whose output is
/// `output` bytes, and an open Turn "t" with `open_items` short replies.
fn long(id: &str, turns: usize, output: usize, open_items: usize) -> AgentDetail {
    let mut d = detail(id);
    d.turns = (0..turns).map(|n| json!({"id":format!("old-{n}"),"status":"completed","items":[
        {"id":format!("u-{n}"),"type":"userMessage","content":[{"type":"text","text":"go"}]},
        {"id":format!("cmd-{n}"),"type":"commandExecution","status":"completed","command":"make",
            "aggregatedOutput":"o".repeat(output)}]})).collect();
    let items: Vec<Value> = (0..open_items).map(|n| json!({"id":format!("r-{n}"),"type":"agentMessage","text":"x"})).collect();
    d.turns.push(json!({"id":"t","status":"inProgress","items":items}));
    d
}

fn turns_read() -> u64 {
    record_rows::TURNS_READ.with(|n| n.get())
}

fn planned_items() -> u64 {
    record_rows::PLANNED_ITEMS.with(|n| n.get())
}

fn held_bytes(store: &Store, id: &str) -> usize {
    store.peek(id, |d| serde_json::to_vec(d).unwrap().len()).expect("held")
}

#[test]
fn events_read_and_hold_only_the_turns_they_name_whatever_the_history() {
    let (_dir, store) = lab();
    // 300 Turns of 256 KiB output each: some 75 MiB of history.
    store.insert(&long("a", 300, 256 << 10, 0)).unwrap();
    let before = (turns_read(), detail_reads_of("a"));
    for n in 0..50 {
        stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":format!("{n} ")}));
    }
    stream(&store, "a", "item/completed", &json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":"done"}}));
    assert!(store.stream_tick(Duration::ZERO).failed.is_empty());
    // The first event read the open Turn (also the newest); nothing since.
    assert_eq!(turns_read() - before.0, 1);
    assert!(held_bytes(&store, "a") < 4 << 10, "{}", held_bytes(&store, "a"));
    // An event about an older Turn reads it, and memory keeps its output
    // as a preview, until the next write drops the Turn.
    let old = json!({"turnId":"old-7","item":{"id":"cmd-7","type":"commandExecution","status":"completed","command":"make",
        "aggregatedOutput":"p".repeat(256 << 10)}});
    stream(&store, "a", "item/completed", &old);
    assert_eq!(turns_read() - before.0, 2);
    assert!(held_bytes(&store, "a") < 16 << 10, "{}", held_bytes(&store, "a"));
    store.record_event("a", "turn/completed", &json!({"turn":{"id":"t","status":"completed"}}), Sel::Open,
        |d| d.apply("turn/completed", &json!({"turn":{"id":"t","status":"completed","items":[]}}))).unwrap();
    assert_eq!(store.peek("a", |d| d.turns.iter().map(|t| t["id"].clone()).collect::<Vec<_>>()).unwrap(), [json!("t")]);
    // Sending and the reads clients make do the same.
    let send = store.send_view("a").unwrap();
    assert_eq!(send.turns.len(), 1);
    store.review("a", i64::MAX).unwrap();
    assert_eq!(turns_read() - before.0, 3);
    assert_eq!(detail_reads_of("a"), before.1);
    let mut row = store.payload_view("a", Some("old-7"), Some("cmd-7"), |d| d.turns.clone()).unwrap().unwrap();
    assert_eq!(row.remove(0)["items"][0]["aggregatedOutput"].as_str().unwrap().len(), 256 << 10);
}

#[test]
fn a_write_plans_only_the_items_it_changed() {
    let (_dir, store) = lab();
    store.insert(&long("a", 2, 16, 40)).unwrap();
    stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"r-3","delta":"y"}));
    let before = planned_items();
    assert!(store.stream_tick(Duration::ZERO).failed.is_empty());
    assert_eq!(planned_items() - before, 1);
    let before = planned_items();
    stream(&store, "a", "item/completed", &json!({"turnId":"t","item":{"id":"r-9","type":"agentMessage","text":"z"}}));
    assert_eq!(planned_items() - before, 1);
    let before = planned_items();
    store.update_meta("a", "agent/renamed", &json!({}), |m| m.agent.name = "b".into()).unwrap();
    assert_eq!(planned_items() - before, 0);
    let rows: i64 = store.db.read().unwrap().query_row("SELECT COUNT(*) FROM agent_items WHERE agent_id='a'", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 2 * 2 + 40);
}

#[test]
fn a_long_open_turn_is_held_within_its_budget_and_an_event_still_reaches_any_item() {
    let (_dir, store) = lab();
    let mut d = detail("a");
    // 4000 ended Items of 2 KiB in the open Turn: some 8 MiB.
    let items: Vec<Value> = (0..4000).map(|n| json!({"id":format!("c{n}"),"type":"commandExecution","status":"completed",
        "command":"make","aggregatedOutput":"o".repeat(2048)})).collect();
    d.turns = vec![json!({"id":"t","status":"inProgress","items":items})];
    store.insert(&d).unwrap();
    let bound = HOT_ITEMS + (64 << 10);
    stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":"x"}));
    assert!(held_bytes(&store, "a") < bound, "{}", held_bytes(&store, "a"));
    // An event about an Item left to its rows reads it back, in its place.
    stream(&store, "a", "item/completed", &json!({"turnId":"t","item":{"id":"c5","type":"commandExecution",
        "status":"completed","command":"make","aggregatedOutput":"edited"}}));
    assert!(held_bytes(&store, "a") < bound, "{}", held_bytes(&store, "a"));
    let row = store.detail("a").unwrap();
    let items = row.turns[0]["items"].as_array().unwrap();
    assert_eq!(items.len(), 4001);
    assert_eq!(items[5]["aggregatedOutput"], "edited");
    assert_eq!(items.iter().filter(|i| i["id"] == "c5").count(), 1);
    assert_eq!(items[4000]["id"], "reply");
    // A change gets the Turn whole, and memory keeps it within the budget.
    store.record_event("a", "turn/completed", &json!({"turn":{"id":"t","status":"completed"}}), Sel::Open,
        |d| d.turns[0]["status"] = "completed".into()).unwrap();
    assert!(held_bytes(&store, "a") < bound, "{}", held_bytes(&store, "a"));
    assert_eq!(store.detail("a").unwrap().turns[0]["items"].as_array().unwrap().len(), 4001);
}

#[test]
fn a_streamed_field_keeps_its_end_in_memory_and_its_start_in_rows_never_dropped() {
    let (_dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    let started = json!({"turnId":"t","item":{"id":"run","type":"commandExecution","command":"make","status":"inProgress","aggregatedOutput":""}});
    stream(&store, "a", "item/started", &started);
    let mut whole = String::new();
    for n in 0..20_000 {
        let line = format!("line {n:06} {}\n", "z".repeat(50));
        whole.push_str(&line);
        stream(&store, "a", "item/commandExecution/outputDelta", &json!({"turnId":"t","itemId":"run","delta":line}));
    }
    let held = store.peek("a", |d| d.turns[0]["items"][0]["aggregatedOutput"].as_str().unwrap().len()).unwrap();
    assert!(held <= STREAM_HOLD, "{held}");
    let chunks = || -> i64 {
        store.db.read().unwrap().query_row("SELECT COUNT(*) FROM agent_stream_chunks WHERE agent_id='a'", [], |r| r.get(0)).unwrap()
    };
    assert!(chunks() > 0);
    let full = || store.payload_view("a", Some("t"), Some("run"), |d| d.turns[0]["items"][0]["aggregatedOutput"].clone()).unwrap().unwrap();
    assert_eq!(full(), whole);
    // Clients get its end, noted with the size of all of it.
    let shown = store.client_detail("a").unwrap();
    let item = shown.turns[0]["items"].as_array().unwrap().iter().find(|i| i["id"] == "run").unwrap().clone();
    assert_eq!(item["_yuzunoTruncated"]["aggregatedOutput"]["bytes"], whole.len());
    assert!(whole.ends_with(item["aggregatedOutput"].as_str().unwrap()));
    // The completed Item with the output that streamed keeps its start in
    // the chunks: it is not written again.
    let completed = json!({"turnId":"t","item":{"id":"run","type":"commandExecution","command":"make","status":"completed",
        "aggregatedOutput":whole}});
    let spilled = chunks();
    stream(&store, "a", "item/completed", &completed);
    assert_eq!(chunks(), spilled);
    assert_eq!(full(), whole);
    let shown = store.client_detail("a").unwrap();
    let item = shown.turns[0]["items"].as_array().unwrap().iter().find(|i| i["id"] == "run").unwrap().clone();
    assert_eq!(item["status"], "completed");
    assert_eq!(item["_yuzunoTruncated"]["aggregatedOutput"]["bytes"], whole.len());
    // One completed with other output than streamed is replaced, its chunks
    // dropped, though only its first byte differs.
    stream(&store, "a", "item/started", &json!({"turnId":"t","item":{"id":"other","type":"commandExecution","command":"make",
        "status":"inProgress","aggregatedOutput":""}}));
    let part = "y".repeat(600 << 10);
    for _ in 0..3 {
        stream(&store, "a", "item/commandExecution/outputDelta", &json!({"turnId":"t","itemId":"other","delta":part}));
    }
    assert!(chunks() > spilled);
    let mut changed = part.repeat(3);
    changed.replace_range(0..1, "z");
    stream(&store, "a", "item/completed", &json!({"turnId":"t","item":{"id":"other","type":"commandExecution","command":"make",
        "status":"completed","aggregatedOutput":changed}}));
    assert_eq!(chunks(), spilled);
    let other = store.payload_view("a", Some("t"), Some("other"), |d| d.turns[0]["items"].as_array().unwrap().iter()
        .find(|i| i["id"] == "other").unwrap()["aggregatedOutput"].clone()).unwrap().unwrap();
    assert_eq!(other, changed);
    assert_eq!(full(), whole);
}

#[test]
fn receipts_are_read_when_an_event_needs_them_and_never_held() {
    let (_dir, store) = lab();
    let mut d = detail("a");
    d.message_receipts = (0..50).map(|n| serde_json::from_value(json!({"input":{"clientMessageId":format!("c{n}"),
        "text":"x".repeat(10_000)},"status":if n == 49 { "sending" } else { "accepted" },"turnId":"t"})).unwrap()).collect();
    store.insert(&d).unwrap();
    stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":"x"}));
    assert!(store.peek("a", |d| d.message_receipts.is_empty()).unwrap());
    assert!(store.update_readiness("a").unwrap().1.sending);
    // The native user message with its client ID accepts its receipt.
    stream(&store, "a", "item/started", &json!({"turnId":"t","item":{"id":"u","type":"userMessage","clientId":"c49",
        "content":[{"type":"text","text":"x"}]}}));
    assert_eq!(store.receipt("a", "c49").unwrap().unwrap().status, "accepted");
    assert!(store.peek("a", |d| d.message_receipts.is_empty()).unwrap());
    assert!(!store.update_readiness("a").unwrap().1.sending);
}

/// A snapshot merge's selection (`Sel::Named`) reads the Turns it names
/// whole and a long newest Turn it does not name as the Agent holds it; a
/// change through it keeps that Turn's Items that stayed in their rows.
#[test]
fn a_named_selection_reads_whole_only_the_turns_it_names() {
    let (_dir, store) = lab();
    let mut d = detail("a");
    // 4000 ended Items of 2 KiB in the newest Turn: some 8 MiB.
    let items: Vec<Value> = (0..4000).map(|n| json!({"id":format!("c{n}"),"type":"commandExecution","status":"completed",
        "command":"make","aggregatedOutput":"o".repeat(2048)})).collect();
    d.turns = vec![json!({"id":"old","status":"completed","items":[{"id":"u","type":"userMessage","content":[]}]}),
        json!({"id":"t","status":"completed","items":items})];
    store.insert(&d).unwrap();
    let size = |d: &AgentDetail| serde_json::to_vec(&d.turns).unwrap().len();
    let held = store.view("a", Sel::Named(vec![])).unwrap();
    assert_eq!(held.turns.len(), 1);
    assert!(size(&held) < HOT_ITEMS + (64 << 10), "{}", size(&held));
    let named = store.view("a", Sel::Named(vec!["t".into()])).unwrap();
    assert_eq!(named.turns[0]["items"].as_array().unwrap().len(), 4000);
    store.record_event("a", "test/merged", &json!({}), Sel::Named(vec!["old".into()]), |d| {
        assert_eq!(d.turns.len(), 2);
        assert!(serde_json::to_vec(&d.turns[1]).unwrap().len() < HOT_ITEMS + (64 << 10));
        d.agent.connection_state = "connected".into();
    }).unwrap();
    let after = store.detail("a").unwrap();
    assert_eq!(after.agent.connection_state, "connected");
    let items = after.turns[1]["items"].as_array().unwrap();
    assert_eq!(items.len(), 4000);
    assert_eq!(items[1234]["aggregatedOutput"], "o".repeat(2048));
}

/// A Turn started and completed next to a long one (`record_applied` of
/// events that name their Turn) leaves every Item of the long Turn as it was.
#[test]
fn a_turn_beside_a_long_one_leaves_its_items_as_they_were() {
    let (_dir, store) = lab();
    let mut d = detail("a");
    let items: Vec<Value> = (0..4000).map(|n| json!({"id":format!("c{n}"),"type":"commandExecution","status":"completed",
        "command":"make","aggregatedOutput":"o".repeat(2048)})).collect();
    d.agent.status = "idle".into();
    d.turns = vec![json!({"id":"long","status":"completed","items":items})];
    store.insert(&d).unwrap();
    store.record_applied("a", "turn/accepted", "turn/started", &json!({"turn":{"id":"next","status":"inProgress","items":[]}})).unwrap();
    store.record_applied("a", "turn/completed", "turn/completed", &json!({"turn":{"id":"next","status":"completed",
        "items":[{"id":"m","type":"agentMessage","text":"done"}]}})).unwrap();
    let after = store.detail("a").unwrap();
    assert_eq!(after.turns.len(), 2);
    assert_eq!(after.turns[0]["items"], d.turns[0]["items"]);
    assert_eq!(after.turns[1]["status"], "completed");
    assert_eq!(after.turns[1]["items"][0]["text"], "done");
    assert_eq!(after.agent.status, "idle");
}

/// A Workspace an earlier Core wrote is refused before anything is written
/// to it: its file, schema version and journal mode stay as they were
/// (docs/adr/0002-session-store-new-data-directory.md).
#[test]
fn an_earlier_cores_workspace_is_refused_as_it_was() {
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    // An earlier schema: a rollback journal, version 1, Agents as whole rows.
    let older = dir.path().join("older.sqlite");
    Connection::open(&older).unwrap().execute_batch("CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        PRAGMA user_version=1; INSERT INTO agents VALUES('a','{}');").unwrap();
    // The Core before this store's: WAL, version 2, its tables, no store mark.
    let earlier = dir.path().join("earlier.sqlite");
    Connection::open(&earlier).unwrap().execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=2;
        INSERT INTO agents VALUES('a','{}'); PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    for (path, version, mode) in [(&older, 1, "delete"), (&earlier, 2, "wal")] {
        let before = std::fs::read(path).unwrap();
        let error = Store::open(path).err().expect("an earlier Core's Workspace is refused");
        assert!(format!("{error:#}").contains("旧版会话存储"), "{error:#}");
        assert_eq!(std::fs::read(path).unwrap(), before, "{} unchanged", path.display());
        let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
        assert!(std::fs::metadata(&wal).map_or(true, |m| m.len() == 0), "nothing written to {}", wal.display());
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), version);
        assert_eq!(db.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)).unwrap(), mode);
    }
}
