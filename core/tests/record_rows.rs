//! Agent records as rows (`record_rows`): exact round trips, writes by
//! dirty set, loads without payloads, and converting existing records.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use yuzuno_workspace::model::AgentDetail;
use yuzuno_workspace::record_rows::{self as rows, Dirty, Layout, Step};

/// On disk, next to the build: /tmp is memory here. The folder may not exist
/// when CARGO_TARGET_DIR points elsewhere.
fn lab() -> tempfile::TempDir {
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    tempfile::tempdir_in(parent).unwrap()
}

/// A database with the tables Store::open creates before record_rows.
fn database(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
    rows::migrate(&db).unwrap();
    db
}

fn text(n: usize, seed: &str) -> String {
    (0..n).map(|i| format!("{seed} line {i:05}\n")).collect()
}

fn record(id: &str, turns: Vec<Value>) -> AgentDetail {
    serde_json::from_value(json!({
        "agent":{"id":id,"name":id,"cwd":"/w","model":"m","color":"sage","threadId":"thread","status":"idle",
            "createdAt":"2026-10-13T00:00:00Z","updatedAt":"2026-10-13T00:00:01Z","unreadCount":1,"pendingCount":0,
            "lastMessage":"done","lastSeq":42,"reviewedSeq":40,"remote":null},
        "turns":turns,"pending":[],
        "artifacts":[{"path":"/w/a.rs","name":"a.rs","kind":"text","sourceItemId":"fc"}],
        "contextUsage":{"usedTokens":1000,"windowTokens":200000,"usedPercent":39.430133835633676,"turnId":"t1",
            "updatedAt":"2026-10-13T00:00:01Z","stale":false},
        "messageReceipts":[{"input":{"clientMessageId":"c1","text":"hi","expectedTurnId":null},"status":"accepted","turnId":"t1","error":null}],
        "claudeRuntime":{"model":"opus","contextWindow":200000,"rateLimits":{"x":0.1}},
        "history":{"nextCursor":"n","hasMore":true,"loadedCount":2},
    })).unwrap()
}

/// Turns with every kind of Item and field size a real record has.
fn rich() -> AgentDetail {
    let big = text(1500, "out");
    record("a", vec![
        json!({"id":"t1","status":"completed","startedAt":1760000000.123,"_yuzunoStartedAt":1760000000123i64,"error":null,
            "_yuzunoPlan":[{"step":"x","status":"completed"}],"items":[
            {"id":"u","type":"userMessage","clientId":"c1","content":[{"type":"text","text":"hi"}]},
            {"id":"r","type":"reasoning","summary":[text(900, "think")],"content":[]},
            {"id":"cmd","type":"commandExecution","command":"cargo test","status":"completed","exitCode":0,
                "aggregatedOutput":big,"commandActions":[{"type":"unknown","command":"cargo test"}]},
            {"id":"small","type":"commandExecution","command":"ls","aggregatedOutput":"a\nb\n","status":"completed"},
            {"id":"edge","type":"commandExecution","aggregatedOutput":"x".repeat(yuzuno_workspace::client_view::TRIM_ABOVE)},
            {"id":"fc","type":"fileChange","status":"completed","changes":(0..40).map(|i| json!({"path":format!("/w/f{i}.rs"),
                "kind":{"type":"update"},"diff":text(20, "diff")})).collect::<Vec<_>>()},
            {"id":"fc-live","type":"fileChange","status":"inProgress","changes":[{"path":"/w/x","diff":text(900, "live")}]},
            {"id":"mcp","type":"mcpToolCall","server":"s","tool":"t","arguments":{"q":"x"},"status":"completed",
                "result":{"content":[{"type":"text","text":text(800, "mcp")}],"structuredContent":{"rows":text(300, "s")},"isError":false}},
            {"id":"m","type":"agentMessage","text":text(2000, "reply"),"phase":"final_answer","_yuzunoCompletedText":"…"},
        ]}),
        json!({"id":"t2","status":"inProgress","_claudeTextBlocks":{"msg":[{"index":"0","text":"a","confirmed":false}]},"items":[
            {"id":"toolu_1","type":"claudeToolUse","name":"Bash","input":{"command":"make"},"status":"completed","output":text(700, "bash")},
            {"id":"toolu_2","type":"claudeToolUse","name":"Read","input":{"file_path":"/w/b"},"status":"completed",
                "output":[{"type":"text","text":text(700, "read")}]},
            {"id":"msg","type":"agentMessage","text":"a","nativeMessageId":"msg"},
            {"id":"unicode","type":"commandExecution","aggregatedOutput":"柚子\u{1F34B}\t\"quoted\"\\\n".repeat(1200)},
        ]}),
        json!({"id":"t3","status":"failed","error":{"message":"boom"},"items":[]}),
    ])
}

fn same(a: &AgentDetail, b: &AgentDetail) -> bool {
    serde_json::to_string(a).unwrap() == serde_json::to_string(b).unwrap()
}

fn assert_same(a: &AgentDetail, b: &AgentDetail) {
    assert!(same(a, b), "records differ:\n{}\n{}", serde_json::to_string(a).unwrap(), serde_json::to_string(b).unwrap());
}

/// What a whole row gives on load: the record as Core holds it.
fn parsed(detail: &AgentDetail) -> AgentDetail {
    serde_json::from_str(&serde_json::to_string(detail).unwrap()).unwrap()
}

fn insert(db: &mut Connection, detail: &AgentDetail) {
    let tx = db.transaction().unwrap();
    rows::insert(&tx, &detail.agent.id, &rows::split(detail).unwrap()).unwrap();
    tx.commit().unwrap();
}

fn write(db: &mut Connection, detail: &AgentDetail, dirty: &Dirty) -> rows::Written {
    let tx = db.transaction().unwrap();
    let written = rows::write(&tx, &detail.agent.id, detail, dirty).unwrap();
    tx.commit().unwrap();
    written
}

fn stored(db: &Connection, id: &str) -> AgentDetail {
    rows::load(db, id, true).unwrap().unwrap()
}

fn count(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
}

fn item<'a>(detail: &'a mut AgentDetail, turn: usize, id: &str) -> &'a mut Value {
    detail.turns[turn]["items"].as_array_mut().unwrap().iter_mut().find(|i| i["id"] == id).unwrap()
}

#[test]
fn split_and_assemble_give_back_exactly_the_record() {
    let detail = parsed(&rich());
    let split = rows::split(&detail).unwrap();
    assert_same(&rows::assemble(split.clone(), true).unwrap(), &detail);
    assert_eq!(split.turns.len(), 3);
    assert_eq!(split.items.len(), 13);
    // Through the database too.
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    insert(&mut db, &detail);
    assert_same(&stored(&db, "a"), &detail);
    assert_eq!(rows::layout(&db, "a").unwrap(), Some(Layout::Rows));
    let Some(rows::Stored::Rows(read, fields)) = rows::read(&db, "a", false).unwrap() else { panic!("not rows") };
    assert!(fields.is_empty());
    assert_eq!(sorted(read), sorted(rows::Rows { payloads: Vec::new(), ..split.clone() }), "without payloads, with previews");
    let Some(rows::Stored::Rows(read, fields)) = rows::read(&db, "a", true).unwrap() else { panic!("not rows") };
    let mut without_previews = split;
    without_previews.items.iter_mut().for_each(|i| i.previews = None);
    // Payloads come parsed where they were read: each is its row's text parsed.
    let key = |p: &(String, String, String, Value)| (p.0.clone(), p.1.clone(), p.2.clone());
    let mut parsed: Vec<(String, String, String, Value)> = fields.into_iter()
        .flat_map(|((turn, item), list)| list.into_iter().map(move |(field, value)| (turn.clone(), item.clone(), field, value.unwrap())))
        .collect();
    parsed.sort_by_key(key);
    let mut expected: Vec<(String, String, String, Value)> = without_previews.payloads.iter()
        .map(|p| (p.turn.clone(), p.item.clone(), p.field.clone(), serde_json::from_str(&p.data).unwrap())).collect();
    expected.sort_by_key(key);
    assert!(!expected.is_empty());
    assert_eq!(parsed, expected, "with payloads, each parsed from its row");
    assert_eq!(sorted(read), sorted(rows::Rows { payloads: Vec::new(), ..without_previews }), "with payloads, without previews");
}

/// Rows in key order: the database returns them in index order.
fn sorted(mut rows: rows::Rows) -> rows::Rows {
    rows.turns.sort_by(|a, b| a.key.cmp(&b.key));
    rows.items.sort_by(|a, b| (&a.turn, &a.key).cmp(&(&b.turn, &b.key)));
    rows.payloads.sort_by(|a, b| (&a.turn, &a.item, &a.field).cmp(&(&b.turn, &b.item, &b.field)));
    rows
}

#[test]
fn large_fields_become_payload_rows_with_client_previews() {
    let detail = parsed(&rich());
    let split = rows::split(&detail).unwrap();
    let mut payloads: Vec<String> = split.payloads.iter().map(|p| format!("{}/{}/{}", p.turn, p.item, p.field)).collect();
    payloads.sort();
    // Conversation text, a file change in progress, small fields and one of
    // exactly the threshold stay in their Item rows.
    assert_eq!(payloads, ["t1/cmd/aggregatedOutput", "t1/fc/changes", "t1/mcp/result", "t2/toolu_1/output",
        "t2/toolu_2/output", "t2/unicode/aggregatedOutput"]);
    let lean = rows::assemble(split, false).unwrap();
    let cmd = &lean.turns[0]["items"][2];
    let output = cmd["aggregatedOutput"].as_str().unwrap();
    assert!(output.len() <= yuzuno_workspace::client_view::PREVIEW && detail.turns[0]["items"][2]["aggregatedOutput"].as_str().unwrap().ends_with(output),
        "a command keeps the end of its output");
    assert_eq!(cmd[rows::TRUNCATED]["aggregatedOutput"]["bytes"], detail.turns[0]["items"][2]["aggregatedOutput"].as_str().unwrap().len());
    assert_eq!(cmd[rows::TRUNCATED]["aggregatedOutput"]["keep"], "tail");
    assert_eq!(cmd[rows::TRUNCATED]["aggregatedOutput"]["lines"], 1500);
    assert_eq!(cmd["command"], "cargo test", "small fields stay whole");
    assert!(lean.turns[0]["items"][5]["changes"].is_array(), "previews keep their shape");
    assert_eq!(lean.turns[0]["items"][8], detail.turns[0]["items"][8], "conversation text stays whole");
    assert_eq!(lean.turns[0]["items"][6], detail.turns[0]["items"][6], "a file change in progress stays whole");
    let lean_size = serde_json::to_string(&lean).unwrap().len();
    let full_size = serde_json::to_string(&detail).unwrap().len();
    assert!(lean_size * 3 < full_size * 2, "{lean_size} of {full_size} bytes without payloads");
}

#[test]
fn records_with_odd_ids_and_shapes_round_trip() {
    let payload = text(1000, "p");
    let odd = record("odd", vec![
        json!({"id":"dup","items":[{"id":"x","type":"commandExecution","aggregatedOutput":payload}]}),
        json!({"id":"dup","items":[{"id":"x","type":"commandExecution","aggregatedOutput":"other"}]}),
        json!({"status":"noId","items":[{"type":"commandExecution","aggregatedOutput":payload}]}),
        json!({"id":"~0","items":[{"id":"~1","type":"commandExecution","aggregatedOutput":payload},
            {"id":"same","aggregatedOutput":payload,"type":"commandExecution"},{"id":"same","type":"commandExecution"},
            "a string item", 7, null, {"id":null}, {"id":12}]}),
        json!({"id":"noItems"}),
        json!({"id":"itemsNotArray","items":{"a":1}}),
        json!("a string Turn"),
        json!({"id":"annotated","items":[{"id":"a","type":"commandExecution","aggregatedOutput":payload,
            rows::TRUNCATED:{"aggregatedOutput":{"bytes":1}}}]}),
        json!({"id":"keys","items":[{"id":"k","type":"commandExecution","aggregatedOutput":payload,"items":3,"":"empty key"}],"":{"items":1}}),
    ]);
    let odd = parsed(&odd);
    assert_same(&rows::assemble(rows::split(&odd).unwrap(), true).unwrap(), &odd);
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    insert(&mut db, &odd);
    assert_same(&stored(&db, "odd"), &odd);
    // Positional rows are rewritten with every write, so changes to them
    // need not be named.
    let mut changed = odd.clone();
    changed.turns[0]["items"][0]["aggregatedOutput"] = "short".into();
    changed.turns[3]["items"][3] = "another string".into();
    changed.turns.swap(4, 5);
    write(&mut db, &changed, &Dirty::default());
    assert_same(&stored(&db, "odd"), &changed);
    // The newest Turn with a repeated ID, and Items keyed by position, are found.
    assert_eq!(rows::load_turn(&db, "odd", "dup", true).unwrap().unwrap()["items"][0]["aggregatedOutput"], "other");
    // Without a Turn: the newest Turn holding it, by ID or by position.
    assert_eq!(rows::load_item(&db, "odd", None, "x", true).unwrap().unwrap()["items"][0]["aggregatedOutput"], "other");
    let same = rows::load_item(&db, "odd", None, "same", true).unwrap().unwrap();
    assert!(same["items"][0].get("aggregatedOutput").is_none(), "the newer of two Items with one ID");
    assert_eq!(rows::load_item(&db, "odd", None, "~1", true).unwrap().unwrap()["id"], "~0");
    let turn = rows::load_item(&db, "odd", Some("~0"), "~1", true).unwrap().unwrap();
    assert_eq!((turn["id"].as_str(), turn["items"][0]["aggregatedOutput"].as_str()), (Some("~0"), Some(payload.as_str())));
}

#[test]
fn floats_survive_exactly() {
    let mut detail = record("f", vec![json!({"id":"t","startedAt":1760367343.8171482,"items":[
        {"id":"i","type":"x","values":[39.430133835633676,0.1,1e-300,123456789.12345679,-0.0],"aggregatedOutput":text(800, "o")}]})]);
    detail = parsed(&detail);
    let back = rows::assemble(rows::split(&detail).unwrap(), true).unwrap();
    assert_same(&back, &detail);
    assert_eq!(back.context_usage.unwrap().used_percent.to_bits(), 39.430133835633676f64.to_bits());
}

#[test]
fn a_converted_record_is_unreadable_to_older_builds() {
    let detail = parsed(&rich());
    let meta = rows::split(&detail).unwrap().meta;
    let error = serde_json::from_str::<AgentDetail>(&meta).unwrap_err().to_string();
    assert!(error.contains("missing field `turns`"), "{error}");
    let meta: Value = serde_json::from_str(&meta).unwrap();
    assert_eq!(meta["agent"]["threadId"], "thread", "json_extract on agents.data keeps working");
}

#[test]
fn loading_without_payloads_never_reads_payload_rows() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let detail = parsed(&rich());
    insert(&mut db, &detail);
    let lean = rows::assemble(rows::split(&detail).unwrap(), false).unwrap();
    db.execute("UPDATE agent_payloads SET data='not json'", []).unwrap();
    assert!(rows::load(&db, "a", true).is_err(), "payload rows are read with them");
    assert_same(&rows::load(&db, "a", false).unwrap().unwrap(), &lean);
    assert_eq!(rows::load_turn(&db, "a", "t2", false).unwrap().unwrap(), lean.turns[1]);
    db.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE agent_payloads;").unwrap();
    assert_same(&rows::load(&db, "a", false).unwrap().unwrap(), &lean);
    assert_eq!(rows::load_meta(&db, "a").unwrap().unwrap().turns.len(), 0);
    let error = format!("{:#}", rows::load(&db, "a", true).unwrap_err());
    assert!(error.contains("no such table"), "{error}");
}

#[test]
fn one_turn_one_items_payloads_and_the_metadata_load_alone() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let detail = parsed(&rich());
    insert(&mut db, &detail);
    assert_eq!(rows::load_turn(&db, "a", "t1", true).unwrap().unwrap(), detail.turns[0]);
    assert_eq!(rows::load_turn(&db, "a", "missing", true).unwrap(), None);
    let mut meta = detail.clone();
    meta.turns.clear();
    assert_same(&rows::load_meta(&db, "a").unwrap().unwrap(), &meta);
    // One Item, in its Turn (without the Turn's other Items).
    let mut alone = detail.turns[0].clone();
    alone["items"] = json!([detail.turns[0]["items"][2]]);
    assert_eq!(rows::load_item(&db, "a", None, "cmd", true).unwrap().unwrap(), alone);
    let lean = rows::load_turn(&db, "a", "t1", false).unwrap().unwrap();
    assert_eq!(rows::load_item(&db, "a", Some("t1"), "cmd", false).unwrap().unwrap()["items"][0], lean["items"][2]);
    // A Turn without that Item holds none; no such Item anywhere is None.
    assert_eq!(rows::load_item(&db, "a", Some("t2"), "cmd", true).unwrap().unwrap()["items"], json!([]));
    assert_eq!(rows::load_item(&db, "a", None, "nothing", true).unwrap(), None);
    assert_eq!(rows::load_item(&db, "a", Some("missing"), "cmd", true).unwrap(), None);
}

/// Only rows that do not fit together make a record `Damaged`; a database
/// error (a missing table, a busy file) is returned as it is, so it is never
/// mistaken for damage and answered with a stand-in.
#[test]
fn database_errors_are_not_taken_for_damage() {
    let dir = lab();
    let path = dir.path().join("w.sqlite");
    // Rollback journal, so a writer's exclusive lock keeps readers out.
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
        CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
    rows::migrate(&db).unwrap();
    insert(&mut db, &parsed(&rich()));
    db.busy_timeout(std::time::Duration::ZERO).unwrap();
    let damage = |error: anyhow::Error| error.downcast_ref::<rows::Damaged>().is_some();
    let other = Connection::open(&path).unwrap();
    other.execute_batch("BEGIN EXCLUSIVE;").unwrap();
    let busy = [
        rows::load(&db, "a", true).map(|_| ()),
        rows::load_meta(&db, "a").map(|_| ()),
        rows::load_recent(&db, "a").map(|_| ()),
        rows::load_turn(&db, "a", "t1", true).map(|_| ()),
        rows::load_item(&db, "a", None, "cmd", true).map(|_| ()),
    ];
    for result in busy {
        let error = result.unwrap_err();
        assert!(!damage(error), "busy taken for damage");
    }
    other.execute_batch("ROLLBACK;").unwrap();
    // A statement failing half-way through an Item's read.
    db.execute_batch("PRAGMA foreign_keys=OFF; ALTER TABLE agent_payloads RENAME TO moved;").unwrap();
    let error = rows::load_item(&db, "a", Some("t1"), "cmd", true).unwrap_err();
    assert!(format!("{error:#}").contains("no such table") && !damage(error));
    db.execute_batch("ALTER TABLE moved RENAME TO agent_payloads; PRAGMA foreign_keys=ON;").unwrap();
    assert!(rows::load_item(&db, "a", Some("t1"), "cmd", true).unwrap().is_some());
    // Rows that do not fit together are damage, also a negative position.
    db.execute("UPDATE agent_items SET ord=-1 WHERE item_id='cmd'", []).unwrap();
    assert!(damage(rows::load(&db, "a", true).unwrap_err()));
    db.execute("UPDATE agent_items SET ord=2 WHERE item_id='cmd'", []).unwrap();
    db.execute("UPDATE agent_items SET data='not json' WHERE item_id='cmd'", []).unwrap();
    assert!(damage(rows::load_item(&db, "a", None, "cmd", true).unwrap_err()));
}

/// What SQL alone can tell of rows that do not fit together.
#[test]
fn rows_that_do_not_fit_are_found_without_parsing_them() {
    let dir = lab();
    let path = dir.path().join("w.sqlite");
    let mut db = database(&path);
    insert(&mut db, &parsed(&rich()));
    assert!(rows::rows_fit(&db, "a").unwrap());
    db.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    for (damage, repair) in [
        ("UPDATE agent_turns SET ord=5 WHERE turn_id='t3'", "UPDATE agent_turns SET ord=2 WHERE turn_id='t3'"),
        ("UPDATE agent_turns SET items=8 WHERE turn_id='t1'", "UPDATE agent_turns SET items=9 WHERE turn_id='t1'"),
        ("UPDATE agent_items SET ord=7 WHERE item_id='cmd'", "UPDATE agent_items SET ord=2 WHERE item_id='cmd'"),
        ("UPDATE agent_items SET payloads=2 WHERE item_id='cmd'", "UPDATE agent_items SET payloads=1 WHERE item_id='cmd'"),
        ("UPDATE agent_payloads SET item_id='gone' WHERE item_id='cmd'", "UPDATE agent_payloads SET item_id='cmd' WHERE item_id='gone'"),
        ("UPDATE agent_items SET turn_id='gone' WHERE item_id='msg'", "UPDATE agent_items SET turn_id='t2' WHERE item_id='msg'"),
    ] {
        db.execute(damage, []).unwrap();
        assert!(!rows::rows_fit(&db, "a").unwrap(), "{damage}");
        assert!(rows::load(&db, "a", true).unwrap_err().is::<rows::Damaged>(), "{damage}");
        db.execute(repair, []).unwrap();
        assert!(rows::rows_fit(&db, "a").unwrap(), "{repair}");
    }
}

#[test]
fn metadata_alone_is_written_without_touching_turns() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&rich());
    insert(&mut db, &detail);
    log_changes(&db);
    let mut meta = rows::load_meta(&db, "a").unwrap().unwrap();
    meta.agent.reviewed_seq = 42;
    let tx = db.transaction().unwrap();
    assert!(rows::write_meta(&tx, "a", &rows::MetaBody::of(&meta).unwrap(), &meta.agent).unwrap());
    tx.commit().unwrap();
    assert_eq!(changes(&db), ["agents~a"]);
    detail.agent.reviewed_seq = 42;
    assert_same(&stored(&db, "a"), &detail);
}

/// Every row change, as the database makes it.
fn log_changes(db: &Connection) {
    let mut sql = String::from("CREATE TEMP TABLE IF NOT EXISTS changes(what TEXT);");
    for (table, key) in [("agents", "id"), ("agent_turns", "turn_id"), ("agent_items", "turn_id||'/'||{}.item_id"),
        ("agent_payloads", "turn_id||'/'||{}.item_id||'/'||{}.field")] {
        for (event, row, mark) in [("INSERT", "NEW", "+"), ("UPDATE", "NEW", "~"), ("DELETE", "OLD", "-")] {
            let key = format!("{row}.{}", key.replace("{}", row));
            sql += &format!("CREATE TEMP TRIGGER IF NOT EXISTS log_{table}_{event} AFTER {event} ON main.{table}
                BEGIN INSERT INTO changes VALUES('{table}{mark}'||{key}); END;");
        }
    }
    db.execute_batch(&sql).unwrap();
}

fn changes(db: &Connection) -> Vec<String> {
    let mut query = db.prepare("SELECT what FROM changes ORDER BY rowid").unwrap();
    let mut all: Vec<String> = query.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    db.execute("DELETE FROM changes", []).unwrap();
    all.sort();
    all
}

#[test]
fn a_dirty_write_touches_only_the_rows_named() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&rich());
    insert(&mut db, &detail);
    log_changes(&db);
    // One Item grows; another changes without being named.
    let output = format!("{}more\n", item(&mut detail, 0, "cmd")["aggregatedOutput"].as_str().unwrap());
    item(&mut detail, 0, "cmd")["aggregatedOutput"] = output.into();
    item(&mut detail, 1, "toolu_1")["status"] = "failed".into();
    detail.agent.last_seq = 43;
    let mut dirty = Dirty::default();
    dirty.item("t1", "cmd");
    let written = write(&mut db, &detail, &dirty);
    assert_eq!(changes(&db), ["agent_items~t1/cmd", "agent_payloads~t1/cmd/aggregatedOutput", "agents~a"]);
    assert_eq!((written.meta, written.turns, written.items, written.payloads, written.deleted), (true, 0, 1, 1, 0));
    let back = stored(&db, "a");
    assert_eq!(back.turns[0], detail.turns[0]);
    assert_eq!(back.turns[1]["items"][0]["status"], "completed", "a change not named is not written");
    // A Turn's own fields; then everything, which writes only what differs.
    detail.turns[1]["status"] = "completed".into();
    write(&mut db, &detail, Dirty::default().turn("t2"));
    assert_eq!(changes(&db), ["agent_turns~t2"]);
    write(&mut db, &detail, &Dirty::all());
    assert_eq!(changes(&db), ["agent_items~t2/toolu_1"]);
    assert_same(&stored(&db, "a"), &detail);
    // Nothing changed: nothing is written, not even the metadata.
    write(&mut db, &detail, &Dirty::all());
    assert_eq!(changes(&db), Vec::<String>::new());
}

#[test]
fn deleted_turns_and_items_are_removed_with_their_payloads() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&rich());
    insert(&mut db, &detail);
    log_changes(&db);
    let payloads = count(&db, "agent_payloads");
    // Remove an Item with a payload from t1 (the Item after it moves up),
    // and all of t2 (three payloads).
    detail.turns[0]["items"].as_array_mut().unwrap().retain(|i| i["id"] != "mcp");
    detail.turns.remove(1);
    let between = Dirty::between(&parsed(&rich()), &detail);
    write(&mut db, &detail, &between);
    assert_eq!(changes(&db), ["agent_items-t1/mcp", "agent_items-t2/msg", "agent_items-t2/toolu_1", "agent_items-t2/toolu_2",
        "agent_items-t2/unicode", "agent_items~t1/m", "agent_payloads-t1/mcp/result", "agent_payloads-t2/toolu_1/output",
        "agent_payloads-t2/toolu_2/output", "agent_payloads-t2/unicode/aggregatedOutput", "agent_turns-t2",
        "agent_turns~t1", "agent_turns~t3"]);
    assert_eq!(count(&db, "agent_payloads"), payloads - 4);
    assert_same(&stored(&db, "a"), &detail);
    // Even without being named, as long as the Turn is.
    detail.turns[0]["items"].as_array_mut().unwrap().retain(|i| i["id"] != "cmd");
    write(&mut db, &detail, Dirty::default().turn("t1"));
    assert_same(&stored(&db, "a"), &detail);
    // A whole Agent's rows.
    let tx = db.transaction().unwrap();
    rows::delete_rows(&tx, "a").unwrap();
    tx.commit().unwrap();
    assert_eq!((count(&db, "agent_turns"), count(&db, "agent_items"), count(&db, "agent_payloads")), (0, 0, 0));
}

#[test]
fn added_moved_and_recounted_rows_are_written_without_being_named() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&rich());
    insert(&mut db, &detail);
    // A Turn inserted before the others, an Item appended to an unnamed
    // Turn, and an unnamed Turn whose Items swap places.
    detail.turns.insert(0, json!({"id":"t0","items":[{"id":"n","type":"commandExecution","aggregatedOutput":text(900, "n")}]}));
    detail.turns[2]["items"].as_array_mut().unwrap().push(json!({"id":"late","type":"agentMessage","text":"late"}));
    detail.turns[1]["items"].as_array_mut().unwrap().swap(0, 1);
    write(&mut db, &detail, &Dirty::default());
    let back = stored(&db, "a");
    assert_eq!(back.turns[0], detail.turns[0]);
    assert_eq!(back.turns[2], detail.turns[2]);
    // Order within a Turn nobody named is not compared (only its Item count):
    // that move must be named.
    assert_ne!(back.turns[1], detail.turns[1]);
    write(&mut db, &detail, Dirty::default().turn("t1"));
    assert_same(&stored(&db, "a"), &detail);
}

#[test]
fn fields_move_between_item_and_payload_rows_as_they_grow_and_shrink() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&rich());
    insert(&mut db, &detail);
    let payloads = count(&db, "agent_payloads");
    item(&mut detail, 0, "small")["aggregatedOutput"] = text(1000, "grown").into();
    item(&mut detail, 0, "cmd")["aggregatedOutput"] = "short now".into();
    item(&mut detail, 0, "fc")["status"] = "inProgress".into();
    write(&mut db, &detail, &Dirty::between(&parsed(&rich()), &detail));
    assert_eq!(count(&db, "agent_payloads"), payloads - 1);
    assert_same(&stored(&db, "a"), &detail);
    let items: Vec<(String, i64)> = db.prepare("SELECT item_id, payloads FROM agent_items WHERE turn_id='t1' AND payloads>0 ORDER BY item_id")
        .unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
    assert_eq!(items, [("mcp".to_owned(), 1), ("small".to_owned(), 1)]);
    let previews: i64 = db.query_row("SELECT COUNT(*) FROM agent_items WHERE (previews IS NULL) != (payloads=0)", [], |r| r.get(0)).unwrap();
    assert_eq!(previews, 0, "Items have previews exactly when they have payloads");
    assert_same(&rows::load(&db, "a", false).unwrap().unwrap(), &rows::assemble(rows::split(&detail).unwrap(), false).unwrap());
}

/// A small deterministic generator, so failures reproduce.
struct Random(u64);

impl Random {
    fn next(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }
}

fn random_item(random: &mut Random, n: usize) -> Value {
    let size = [3, 100, 700, 900][random.next(4)];
    match random.next(4) {
        0 => json!({"id":format!("i{n}"),"type":"commandExecution","status":"completed","aggregatedOutput":text(size, "r")}),
        1 => json!({"id":format!("i{n}"),"type":"agentMessage","text":text(size, "m")}),
        2 => json!({"id":format!("i{n}"),"type":"fileChange","status":"completed","changes":[{"path":"p","diff":text(size, "d")}]}),
        _ => json!({"id":format!("i{n}"),"type":"claudeToolUse","name":"Read","output":[{"type":"text","text":text(size, "t")}]}),
    }
}

#[test]
fn random_edits_written_by_their_compared_dirty_sets_keep_rows_equal_to_the_record() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&record("r", vec![]));
    insert(&mut db, &detail);
    let mut random = Random(0x2545F4914F6CDD1D);
    let mut next = 0;
    for step in 0..250 {
        let before = detail.clone();
        for _ in 0..1 + random.next(3) {
            next += 1;
            let turns = detail.turns.len();
            match random.next(10) {
                0 | 1 => detail.turns.push(json!({"id":format!("t{next}"),"status":"inProgress","items":[]})),
                2 if turns > 0 => { detail.turns.remove(random.next(turns)); }
                3 if turns > 1 => detail.turns.swap(random.next(turns), random.next(turns)),
                _ if turns > 0 => {
                    let turn = &mut detail.turns[random.next(turns)];
                    let items = turn["items"].as_array_mut().unwrap();
                    match random.next(6) {
                        0 | 1 => items.push(random_item(&mut random, next)),
                        2 if !items.is_empty() => { items.remove(random.next(items.len())); }
                        3 if items.len() > 1 => { let (a, b) = (random.next(items.len()), random.next(items.len())); items.swap(a, b) }
                        4 if !items.is_empty() => { let i = random.next(items.len()); items[i] = random_item(&mut random, next); items[i]["id"] = format!("i{i}x{next}").into() }
                        _ => turn["status"] = ["completed", "failed", "inProgress"][random.next(3)].into(),
                    }
                }
                _ => detail.agent.last_seq += 1,
            }
        }
        let dirty = Dirty::between(&before, &detail);
        write(&mut db, &detail, &dirty);
        assert!(same(&stored(&db, "r"), &detail), "step {step}");
    }
    assert!(detail.turns.iter().map(|t| t["items"].as_array().unwrap().len()).sum::<usize>() > 20);
    assert!(count(&db, "agent_payloads") > 5);
}

#[test]
fn between_names_what_changed() {
    let before = parsed(&rich());
    let mut after = before.clone();
    assert!(Dirty::between(&before, &after).is_meta_only());
    item(&mut after, 0, "cmd")["status"] = "failed".into();
    after.turns[1]["status"] = "completed".into();
    after.turns.push(json!({"id":"t4","items":[]}));
    let dirty = Dirty::between(&before, &after);
    let mut expected = Dirty::default();
    expected.item("t1", "cmd").turn("t2").whole_turn("t4");
    assert_eq!(dirty, expected);
    after.turns[0]["items"][0]["id"] = Value::Null;
    item(&mut after, 0, "small")["status"] = "x".into();
    assert!(Dirty::between(&before, &after).turns()["t1"].all_items, "Items without IDs");
    after.turns[2]["id"] = "t1".into();
    assert!(Dirty::between(&before, &after).is_all(), "Turns sharing an ID");
}

#[test]
fn of_event_names_the_turn_and_item_of_an_event() {
    let mut item = Dirty::default();
    item.item("t", "i");
    for kind in ["item/started", "item/completed"] {
        assert_eq!(Dirty::of_event(kind, &json!({"turnId":"t","item":{"id":"i"}})), item, "{kind}");
    }
    for kind in ["item/agentMessage/delta", "item/commandExecution/outputDelta", "item/reasoning/summaryTextDelta",
        "item/commandExecution/terminalInteraction"] {
        assert_eq!(Dirty::of_event(kind, &json!({"turnId":"t","itemId":"i"})), item, "{kind}");
    }
    let mut turn = Dirty::default();
    turn.item("t", "a").item("t", "b");
    assert_eq!(Dirty::of_event("turn/completed", &json!({"turn":{"id":"t","items":[{"id":"a"},{"id":"b"}]}})), turn);
    assert_eq!(Dirty::of_event("turn/plan/updated", &json!({"turnId":"t"})), Dirty::default().turn("t").clone());
    for kind in ["hook/started", "hook/completed", "account/rateLimits/updated", "thread/tokenUsage/updated",
        "turn/diff/updated", "serverRequest/resolved", "item/autoApprovalReview/started", "guardianWarning", "error"] {
        assert!(Dirty::of_event(kind, &json!({"turnId":"t"})).is_meta_only(), "{kind}");
    }
    assert!(Dirty::of_event("thread/compacted", &json!({})).all_turn_rows());
    assert!(Dirty::of_event("claude/system", &json!({"turnId":"t","event":{"type":"system","subtype":"compact_boundary"}})).all_turn_rows());
    assert!(Dirty::of_event("claude/system", &json!({"turnId":"t","event":{"type":"system","subtype":"thinking_tokens"}})).is_meta_only());
    let whole = Dirty::of_event("claude/assistant", &json!({"turnId":"t","event":{"type":"assistant"}}));
    assert!(whole.turns()["t"].all_items);
    assert!(Dirty::of_event("some/newKind", &json!({"turnId":"t"})).turns()["t"].all_items, "unknown kinds: their whole Turn");
    assert!(Dirty::of_event("some/newKind", &json!({})).is_meta_only());
}

// ---------------------------------------------------------------------------
// Converting existing records

/// A database as an older Core leaves it: whole records, no row tables yet.
fn old_database(path: &Path, details: &[AgentDetail], raw: &[(&str, &str)]) {
    let db = Connection::open(path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
    for detail in details {
        db.execute("INSERT INTO agents(id,data) VALUES(?1,?2)", params![detail.agent.id, serde_json::to_string(detail).unwrap()]).unwrap();
    }
    for (id, data) in raw {
        db.execute("INSERT INTO agents(id,data) VALUES(?1,?2)", params![id, data]).unwrap();
    }
}

fn agents() -> Vec<AgentDetail> {
    let mut b = parsed(&rich());
    b.agent.id = "b".into();
    vec![parsed(&rich()), b, parsed(&record("c", vec![json!({"id":"t","items":[]})]))]
}

fn backups(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().contains(".before-record-rows-")).collect();
    found.sort();
    found
}

#[test]
fn converting_backs_up_first_converts_every_record_and_is_then_a_no_op() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    old_database(&path, &agents(), &[]);
    let mut db = database(&path);
    let conversion = rows::convert(&mut db, &path).unwrap();
    assert_eq!(conversion.converted, ["a", "b", "c"]);
    assert!(conversion.failed.is_empty());
    assert_eq!(backups(dir.path()), [conversion.backup.clone().unwrap()]);
    for detail in agents() {
        assert_eq!(rows::layout(&db, &detail.agent.id).unwrap(), Some(Layout::Rows));
        assert_same(&stored(&db, &detail.agent.id), &detail);
    }
    // The backup holds the records as they were, readable by older builds.
    let backup = Connection::open(conversion.backup.unwrap()).unwrap();
    for detail in agents() {
        let data: String = backup.query_row("SELECT data FROM agents WHERE id=?1", [&detail.agent.id], |r| r.get(0)).unwrap();
        assert_same(&serde_json::from_str(&data).unwrap(), &detail);
    }
    // Again: nothing to do, nothing written, no second backup.
    let version = |db: &Connection| db.query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0)).unwrap();
    let (changes, before) = (db.total_changes(), version(&db));
    let again = rows::convert(&mut db, &path).unwrap();
    assert!(again.converted.is_empty() && again.failed.is_empty() && again.backup.is_none());
    assert_eq!((db.total_changes(), version(&db)), (changes, before));
    assert_eq!(backups(dir.path()).len(), 1);
}

#[test]
fn an_interrupted_conversion_resumes_without_a_second_backup() {
    for crash_at in ["checked", "converted"] {
        let dir = lab();
        let path = dir.path().join("workspace.sqlite");
        old_database(&path, &agents(), &[]);
        let mut db = database(&path);
        // A crash with "b" checked but not committed, or just committed.
        let error = rows::convert_with(&mut db, &path, |step| match step {
            Step::Checked("b") if crash_at == "checked" => anyhow::bail!("killed"),
            Step::Converted("b") if crash_at == "converted" => anyhow::bail!("killed"),
            _ => Ok(()),
        }).unwrap_err();
        assert_eq!(error.to_string(), "killed");
        drop(db);
        let mut db = database(&path);
        let b = if crash_at == "checked" { Layout::Whole } else { Layout::Rows };
        assert_eq!([rows::layout(&db, "a").unwrap(), rows::layout(&db, "b").unwrap(), rows::layout(&db, "c").unwrap()],
            [Some(Layout::Rows), Some(b), Some(Layout::Whole)], "{crash_at}");
        let rows_of_b: i64 = db.query_row("SELECT COUNT(*) FROM agent_turns WHERE agent_id='b'", [], |r| r.get(0)).unwrap();
        assert_eq!(rows_of_b > 0, b == Layout::Rows, "an uncommitted Agent leaves no rows");
        let resumed = rows::convert(&mut db, &path).unwrap();
        let expected: &[&str] = if crash_at == "checked" { &["b", "c"] } else { &["c"] };
        assert_eq!(resumed.converted, expected);
        assert!(resumed.backup.is_none());
        assert_eq!(backups(dir.path()).len(), 1);
        for detail in agents() {
            assert_same(&stored(&db, &detail.agent.id), &detail);
        }
    }
}

/// A crash while the backup is copied leaves a copy nothing records; the
/// next run removes it before copying again. A copy that fails is removed
/// at once, and nothing is converted without a backup.
#[test]
fn an_incomplete_backup_is_never_left_behind() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    old_database(&path, &agents(), &[]);
    let mut db = database(&path);
    // Killed while copying: part of a copy exists, nothing records it as done.
    let error = rows::convert_with(&mut db, &path, |step| match step {
        Step::BackingUp(target) => {
            std::fs::write(target, b"part of a copy").unwrap();
            anyhow::bail!("killed")
        }
        _ => Ok(()),
    }).unwrap_err();
    assert_eq!(error.to_string(), "killed");
    drop(db);
    assert_eq!(backups(dir.path()).len(), 1);
    let mut db = database(&path);
    let done = rows::convert(&mut db, &path).unwrap();
    assert_eq!(backups(dir.path()), [done.backup.clone().unwrap()], "the partial copy is gone, one complete backup left");
    assert_eq!(rows::recorded_backup(&db).unwrap(), done.backup.map(|p| p.to_string_lossy().into_owned()));
    Connection::open(&backups(dir.path())[0]).unwrap().query_row("SELECT COUNT(*) FROM agents", [], |r| r.get::<_, i64>(0)).unwrap();
    // A copy that fails (here: something is already at its path) is removed,
    // and no record is converted without a backup.
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    old_database(&path, &agents(), &[]);
    let mut db = database(&path);
    let error = rows::convert_with(&mut db, &path, |step| {
        if let Step::BackingUp(target) = step {
            std::fs::write(target, b"in the way").unwrap();
        }
        Ok(())
    }).unwrap_err();
    assert!(format!("{error:#}").contains("could not copy"), "{error:#}");
    assert!(backups(dir.path()).is_empty());
    assert_eq!(count(&db, "agent_turns"), 0);
    assert_eq!(rows::recorded_backup(&db).unwrap(), None);
    assert_eq!(rows::convert(&mut db, &path).unwrap().converted.len(), 3);
    assert_eq!(backups(dir.path()).len(), 1);
}

#[test]
fn a_record_that_cannot_be_converted_stays_whole_and_holds_back_no_other() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    old_database(&path, &agents(), &[("broken", "{\"agent\":{}}")]);
    let mut db = database(&path);
    let conversion = rows::convert(&mut db, &path).unwrap();
    assert_eq!(conversion.converted, ["a", "b", "c"]);
    assert_eq!(conversion.failed.len(), 1);
    assert_eq!(conversion.failed[0].0, "broken");
    let (data, layout): (String, i64) = db.query_row("SELECT data, layout FROM agents WHERE id='broken'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((data.as_str(), layout), ("{\"agent\":{}}", 0));
    // Whole records are still written whole.
    let mut c = stored(&db, "c");
    c.agent.name = "renamed".into();
    let tx = db.transaction().unwrap();
    tx.execute("UPDATE agents SET layout=0, data=?1 WHERE id='c'", [serde_json::to_string(&c).unwrap()]).unwrap();
    rows::delete_rows(&tx, "c").unwrap();
    assert_eq!(rows::write(&tx, "c", &c, &Dirty::default()).unwrap().layout, Layout::Whole);
    tx.commit().unwrap();
    assert_same(&stored(&db, "c"), &c);
}

#[test]
fn reverting_stores_records_whole_again_with_their_latest_changes() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    old_database(&path, &agents(), &[]);
    let mut db = database(&path);
    rows::convert(&mut db, &path).unwrap();
    let mut a = stored(&db, "a");
    item(&mut a, 0, "cmd")["aggregatedOutput"] = text(2000, "after").into();
    write(&mut db, &a, Dirty::default().item("t1", "cmd"));
    assert_eq!(rows::revert(&mut db).unwrap().agents.len(), 3);
    assert_eq!((count(&db, "agent_turns"), count(&db, "agent_items"), count(&db, "agent_payloads")), (0, 0, 0));
    let data: String = db.query_row("SELECT data FROM agents WHERE id='a' AND layout=0", [], |r| r.get(0)).unwrap();
    assert_same(&serde_json::from_str(&data).unwrap(), &a);
    // The backup is not forgotten; converting again takes a new one, and
    // the first stays recorded.
    let first = rows::recorded_backup(&db).unwrap().unwrap();
    assert_eq!(rows::convert(&mut db, &path).unwrap().converted.len(), 3);
    assert_eq!(backups(dir.path()).len(), 2);
    let earlier: String = db.query_row("SELECT value FROM workspace_meta WHERE key='recordRowsEarlierBackups'", [], |r| r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Vec<String>>(&earlier).unwrap(), [first.clone()]);
    assert_ne!(rows::recorded_backup(&db).unwrap().unwrap(), first);
}

#[test]
fn store_open_converts_whole_records_and_new_agents_are_rows() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    old_database(&path, &agents(), &[]);
    {
        let store = yuzuno_workspace::store::Store::open(&path).unwrap();
        store.insert(&parsed(&record("s", vec![]))).unwrap();
        for detail in agents() {
            assert_eq!(store.detail(&detail.agent.id).unwrap().turns, detail.turns);
        }
    }
    let db = Connection::open(&path).unwrap();
    for id in ["a", "b", "c", "s"] {
        assert_eq!(rows::layout(&db, id).unwrap(), Some(Layout::Rows), "{id}");
    }
    assert_eq!(backups(dir.path()).len(), 1);
    assert_eq!(count(&db, "agent_originals"), 3, "the converted Agents' whole rows are kept a while");
    // Reopening converts nothing more.
    drop(db);
    drop(yuzuno_workspace::store::Store::open(&path).unwrap());
    assert_eq!(backups(dir.path()).len(), 1);
}

// ---------------------------------------------------------------------------
// Real records

/// Every Agent of a copy of a real Workspace database (never the live file):
/// `YUZUNO_RECORD_ROWS_DB=<copy> cargo test --test record_rows -- --ignored`.
/// The copy is converted in a scratch copy of its own.
#[test]
#[ignore = "needs YUZUNO_RECORD_ROWS_DB: a copy of a real Workspace database"]
fn every_real_record_round_trips_and_converts_exactly() {
    let Ok(source) = std::env::var("YUZUNO_RECORD_ROWS_DB") else {
        panic!("set YUZUNO_RECORD_ROWS_DB to a copy of a Workspace database");
    };
    let original = Connection::open_with_flags(&source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut query = original.prepare("SELECT id, data FROM agents ORDER BY rowid").unwrap();
    let records: Vec<(String, String)> = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
    assert!(!records.is_empty());
    let mut exact_text = 0;
    for (id, data) in &records {
        let detail: AgentDetail = serde_json::from_str(data).unwrap();
        let back = rows::assemble(rows::split(&detail).unwrap(), true).unwrap();
        assert!(same(&back, &detail), "{id}");
        exact_text += usize::from(serde_json::to_string(&back).unwrap() == *data);
    }
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    original.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
    let mut db = database(&path);
    let conversion = rows::convert(&mut db, &path).unwrap();
    assert!(conversion.failed.is_empty(), "{:?}", conversion.failed);
    assert_eq!(conversion.converted.len(), records.len());
    for (id, data) in &records {
        let detail: AgentDetail = serde_json::from_str(data).unwrap();
        assert!(same(&stored(&db, id), &detail), "{id} from the converted database");
    }
    println!("{} records round-trip exactly; {exact_text} of them byte for byte as stored", records.len());
}
