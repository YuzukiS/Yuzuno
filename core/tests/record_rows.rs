//! Agent records as rows (`record_rows`, T-140 session store): exact round
//! trips, writes by dirty set of the Turns given, Turns and Items read alone,
//! Items written back from their form without payloads, Item keys and
//! message receipts apart from the metadata.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use yuzuno_workspace::model::AgentDetail;
use yuzuno_workspace::record_rows::{self as rows, Dirty};

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
        json!({"id":"t2","status":"inProgress","_claudeTextBlocks":{"msg":[{"index":"0","bytes":1,"confirmed":false}]},"items":[
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

/// A write of `detail`'s metadata, Turns and receipts, `loaded` being every
/// Turn it had (so a Turn it lacks now is deleted).
fn write(db: &mut Connection, detail: &AgentDetail, dirty: &Dirty) -> rows::Written {
    let loaded = rows::turn_ids(db, &detail.agent.id).unwrap();
    let receipts: Vec<_> = detail.message_receipts.iter().collect();
    let plan = rows::plan(db, &detail.agent.id, detail, &detail.turns, &loaded, dirty, &receipts).unwrap();
    let tx = db.transaction().unwrap();
    let written = rows::apply(&tx, &detail.agent.id, &plan, &detail.agent).unwrap();
    tx.commit().unwrap();
    written
}

/// The whole record as stored, read a Turn at a time (only a test does).
fn stored(db: &Connection, id: &str) -> AgentDetail {
    read(db, id, true)
}

fn read(db: &Connection, id: &str, payloads: bool) -> AgentDetail {
    let mut d = rows::load_meta(db, id).unwrap().unwrap();
    rows::scan(db, id, payloads, |turn| { d.turns.push(turn); Ok(true) }).unwrap();
    rows::each_receipt(db, id, |r| d.message_receipts.push(r)).unwrap();
    d
}

/// The record as read without payloads: each large field its preview, as
/// clients are sent it.
fn lean(detail: &AgentDetail) -> AgentDetail {
    let mut lean = detail.clone();
    for item in lean.turns.iter_mut().flat_map(|t| t["items"].as_array_mut().into_iter().flatten()) {
        rows::compact(item);
    }
    lean
}

fn count(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
}

fn item<'a>(detail: &'a mut AgentDetail, turn: usize, id: &str) -> &'a mut Value {
    detail.turns[turn]["items"].as_array_mut().unwrap().iter_mut().find(|i| i["id"] == id).unwrap()
}

#[test]
fn a_record_round_trips_exactly_through_its_rows() {
    let detail = parsed(&rich());
    let split = rows::split(&detail).unwrap();
    assert_eq!((split.turns.len(), split.items.len(), split.receipts.len()), (3, 13, 1));
    let meta: Value = serde_json::from_str(&split.meta).unwrap();
    assert!(meta.get("turns").is_none() && meta.get("messageReceipts").is_none(), "the metadata holds no Turns or receipts");
    assert_eq!(meta["agent"]["threadId"], "thread", "json_extract on agents.data keeps working");
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    insert(&mut db, &detail);
    assert_same(&stored(&db, "a"), &detail);
    // Without payloads: what the client view sends.
    assert_same(&read(&db, "a", false), &lean(&detail));
    let bytes: i64 = db.query_row("SELECT SUM(LENGTH(CAST(data AS BLOB))) FROM agent_payloads WHERE agent_id='a'", [], |r| r.get(0)).unwrap();
    assert_eq!(bytes as usize, split.payloads.iter().map(|p| p.data.len()).sum::<usize>());
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
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    insert(&mut db, &detail);
    let lean = read(&db, "a", false);
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

/// Items with odd IDs and shapes round trip; a Turn needs a string ID no
/// other Turn has (T-140: Turns are written alone, by their ID).
#[test]
fn odd_items_round_trip_and_turns_need_their_own_ids() {
    let payload = text(1000, "p");
    let odd = parsed(&record("odd", vec![
        json!({"id":"t0","items":[{"id":"~1","type":"commandExecution","aggregatedOutput":payload},
            {"id":"same","aggregatedOutput":payload,"type":"commandExecution"},{"id":"same","type":"commandExecution"},
            "a string item", 7, null, {"id":null}, {"id":12}]}),
        json!({"id":"noItems"}),
        json!({"id":"itemsNotArray","items":{"a":1}}),
        json!({"id":"keys","items":[{"id":"k","type":"commandExecution","aggregatedOutput":payload,"items":3,"":"empty key"}],"":{"items":1}}),
    ]));
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    insert(&mut db, &odd);
    assert_same(&stored(&db, "odd"), &odd);
    // Items keyed by position are rewritten with every write of their Turn.
    let mut changed = odd.clone();
    changed.turns[0]["items"][3] = "another string".into();
    write(&mut db, &changed, Dirty::default().turn("t0"));
    assert_same(&stored(&db, "odd"), &changed);
    let same = rows::load_item(&db, "odd", None, "same", true).unwrap().unwrap();
    assert!(same["items"][0].get("aggregatedOutput").is_none(), "the newer of two Items with one ID");
    let turn = rows::load_item(&db, "odd", Some("t0"), "~1", true).unwrap().unwrap();
    assert_eq!(turn["items"][0]["aggregatedOutput"].as_str(), Some(payload.as_str()));
    // An Item in preview form (a field noted as stored apart) has no row to
    // take its payload from: never written as if whole.
    let annotated = json!({"id":"annotated","items":[{"id":"a","type":"commandExecution","aggregatedOutput":payload,
        rows::TRUNCATED:{"aggregatedOutput":{"bytes":1}}}]});
    for turns in [vec![json!({"id":"dup","items":[]}), json!({"id":"dup","items":[]})], vec![json!({"items":[]})],
        vec![json!("a string Turn")], vec![json!({"id":"~0","items":[]})], vec![annotated]] {
        let error = rows::split(&record("bad", turns.clone())).err();
        assert!(error.is_some(), "{turns:?}");
    }
}

#[test]
fn floats_survive_exactly() {
    let detail = parsed(&record("f", vec![json!({"id":"t","startedAt":1760367343.8171482,"items":[
        {"id":"i","type":"x","values":[39.430133835633676,0.1,1e-300,123456789.12345679,-0.0],"aggregatedOutput":text(800, "o")}]})]));
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    insert(&mut db, &detail);
    let back = stored(&db, "f");
    assert_same(&back, &detail);
    assert_eq!(back.context_usage.unwrap().used_percent.to_bits(), 39.430133835633676f64.to_bits());
}

#[test]
fn reading_without_payloads_never_reads_payload_rows() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let detail = parsed(&rich());
    insert(&mut db, &detail);
    let lean = lean(&detail);
    db.execute("UPDATE agent_payloads SET data='not json'", []).unwrap();
    assert!(rows::load_turn(&db, "a", "t1", true).is_err(), "payload rows are read with them");
    assert_eq!(rows::load_turn(&db, "a", "t2", false).unwrap().unwrap(), lean.turns[1]);
    db.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE agent_payloads;").unwrap();
    assert_same(&read(&db, "a", false), &lean);
    let error = format!("{:#}", rows::load_turn(&db, "a", "t1", true).unwrap_err());
    assert!(error.contains("no such table"), "{error}");
}

#[test]
fn one_turn_one_item_and_the_metadata_read_alone() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let detail = parsed(&rich());
    insert(&mut db, &detail);
    assert_eq!(rows::load_turn(&db, "a", "t1", true).unwrap().unwrap(), detail.turns[0]);
    assert_eq!(rows::load_turn(&db, "a", "missing", true).unwrap(), None);
    let mut meta = detail.clone();
    meta.turns.clear();
    meta.message_receipts.clear();
    assert_same(&rows::load_meta(&db, "a").unwrap().unwrap(), &meta);
    let mut alone = detail.turns[0].clone();
    alone["items"] = json!([detail.turns[0]["items"][2]]);
    assert_eq!(rows::load_item(&db, "a", None, "cmd", true).unwrap().unwrap(), alone);
    let lean = rows::load_turn(&db, "a", "t1", false).unwrap().unwrap();
    assert_eq!(rows::load_item(&db, "a", Some("t1"), "cmd", false).unwrap().unwrap()["items"][0], lean["items"][2]);
    assert_eq!(rows::load_item(&db, "a", Some("t2"), "cmd", true).unwrap().unwrap()["items"], json!([]));
    assert_eq!(rows::load_item(&db, "a", None, "nothing", true).unwrap(), None);
    assert_eq!(rows::load_item(&db, "a", Some("missing"), "cmd", true).unwrap(), None);
    // The Turns a read selects, by position and status, without reading them.
    assert_eq!(rows::turn_ids(&db, "a").unwrap(), ["t1", "t2", "t3"]);
    assert_eq!(rows::newest_turns(&db, "a", 2).unwrap(), ["t2", "t3"]);
    assert_eq!(rows::open_turns(&db, "a").unwrap(), ["t2"]);
    let turns: Vec<String> = rows::load_turns(&db, "a", &["t3".into(), "t1".into(), "gone".into()], false).unwrap()
        .into_iter().map(|(_, t)| t["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(turns, ["t1", "t3"], "in record order, those it has");
}

/// Only rows that do not fit together make a record `Damaged`; a database
/// error (a missing table, a busy file) is returned as it is.
#[test]
fn database_errors_are_not_taken_for_damage() {
    let dir = lab();
    let path = dir.path().join("w.sqlite");
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
    for result in [rows::load_meta(&db, "a").map(|_| ()), rows::load_turn(&db, "a", "t1", true).map(|_| ()),
        rows::load_item(&db, "a", None, "cmd", true).map(|_| ())] {
        assert!(!damage(result.unwrap_err()), "busy taken for damage");
    }
    other.execute_batch("ROLLBACK;").unwrap();
    db.execute("UPDATE agent_items SET ord=-1 WHERE item_id='cmd'", []).unwrap();
    assert!(damage(rows::load_turn(&db, "a", "t1", true).unwrap_err()));
    db.execute("UPDATE agent_items SET ord=2 WHERE item_id='cmd'", []).unwrap();
    db.execute("UPDATE agent_items SET data='not json' WHERE item_id='cmd'", []).unwrap();
    assert!(damage(rows::load_item(&db, "a", None, "cmd", true).unwrap_err()));
}

#[test]
fn rows_that_do_not_fit_are_found_without_parsing_them() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
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
        ("agent_payloads", "turn_id||'/'||{}.item_id||'/'||{}.field"), ("agent_receipts", "client_id")] {
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

/// A write is given some Turns: one of them it removes is deleted with its
/// Items and payloads, and the others' positions close up; a Turn it was not
/// given is left as it is.
#[test]
fn deleted_turns_and_items_are_removed_with_their_payloads() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&rich());
    insert(&mut db, &detail);
    log_changes(&db);
    let payloads = count(&db, "agent_payloads");
    detail.turns[0]["items"].as_array_mut().unwrap().retain(|i| i["id"] != "mcp");
    detail.turns.remove(1);
    let between = Dirty::between(&parsed(&rich()).turns, &detail.turns);
    write(&mut db, &detail, &between);
    assert_eq!(changes(&db), ["agent_items-t1/mcp", "agent_items-t2/msg", "agent_items-t2/toolu_1", "agent_items-t2/toolu_2",
        "agent_items-t2/unicode", "agent_items~t1/m", "agent_payloads-t1/mcp/result", "agent_payloads-t2/toolu_1/output",
        "agent_payloads-t2/toolu_2/output", "agent_payloads-t2/unicode/aggregatedOutput", "agent_turns-t2",
        "agent_turns~t1", "agent_turns~t3"]);
    assert_eq!(count(&db, "agent_payloads"), payloads - 4);
    assert_same(&stored(&db, "a"), &detail);
    assert!(rows::rows_fit(&db, "a").unwrap(), "positions close up");
    // A Turn not given to the write stays.
    let plan = rows::plan(&db, "a", &detail, &detail.turns[..1], &["t1".into()], &Dirty::default(), &[]).unwrap();
    let tx = db.transaction().unwrap();
    rows::apply(&tx, "a", &plan, &detail.agent).unwrap();
    tx.commit().unwrap();
    assert_same(&stored(&db, "a"), &detail);
    let tx = db.transaction().unwrap();
    rows::delete_rows(&tx, "a").unwrap();
    tx.commit().unwrap();
    assert_eq!((count(&db, "agent_turns"), count(&db, "agent_items"), count(&db, "agent_payloads"), count(&db, "agent_receipts")),
        (0, 0, 0, 0));
}

/// A new Turn goes after the newest; Items added to or moved in a Turn that
/// is written are written without being named.
#[test]
fn new_turns_go_after_the_newest_and_moved_items_are_written() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&rich());
    insert(&mut db, &detail);
    detail.turns.push(json!({"id":"t4","items":[{"id":"n","type":"commandExecution","aggregatedOutput":text(900, "n")}]}));
    detail.turns[2]["items"].as_array_mut().unwrap().push(json!({"id":"late","type":"agentMessage","text":"late"}));
    detail.turns[1]["items"].as_array_mut().unwrap().swap(0, 1);
    write(&mut db, &detail, Dirty::default().turn("t2"));
    let back = stored(&db, "a");
    assert_eq!(back.turns[3], detail.turns[3], "a new Turn is written whole");
    assert_eq!(back.turns[2], detail.turns[2], "an Item count that changed is seen");
    assert_eq!(back.turns[1], detail.turns[1], "a Turn written has its Items in their places");
    assert_eq!(rows::turn_ids(&db, "a").unwrap(), ["t1", "t2", "t3", "t4"]);
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
    write(&mut db, &detail, &Dirty::between(&parsed(&rich()).turns, &detail.turns));
    assert_eq!(count(&db, "agent_payloads"), payloads - 1);
    assert_same(&stored(&db, "a"), &detail);
    let items: Vec<(String, i64)> = db.prepare("SELECT item_id, payloads FROM agent_items WHERE turn_id='t1' AND payloads>0 ORDER BY item_id")
        .unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
    assert_eq!(items, [("mcp".to_owned(), 1), ("small".to_owned(), 1)]);
    let previews: i64 = db.query_row("SELECT COUNT(*) FROM agent_items WHERE (previews IS NULL) != (payloads=0)", [], |r| r.get(0)).unwrap();
    assert_eq!(previews, 0, "Items have previews exactly when they have payloads");
    assert_same(&read(&db, "a", false), &lean(&detail));
}

/// What memory keeps of an Item that ended is its form without payloads
/// (T-140). Written back, a field still holding its stored preview keeps its
/// payload row; a field changed since is stored as any field is; a Turn
/// changed elsewhere keeps every payload of its Items.
#[test]
fn items_written_back_from_their_previews_keep_their_payloads() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let detail = parsed(&rich());
    insert(&mut db, &detail);
    log_changes(&db);
    // As memory holds it: the Turns without payloads.
    let mut held = read(&db, "a", false);
    held.message_receipts = detail.message_receipts.clone();
    // A change of the Turn's own fields and of a small field of an Item
    // whose large field is a preview: every Item of the Turn written.
    held.turns[0]["status"] = "interrupted".into();
    item(&mut held, 0, "cmd")["exitCode"] = 1.into();
    write(&mut db, &held, Dirty::default().whole_turn("t1"));
    let after = changes(&db);
    assert!(!after.iter().any(|c| c.starts_with("agent_payloads")), "no payload row is rewritten or deleted: {after:?}");
    let mut expected = detail.clone();
    expected.turns[0]["status"] = "interrupted".into();
    item(&mut expected, 0, "cmd")["exitCode"] = 1.into();
    assert_same(&stored(&db, "a"), &expected);
    // A field replaced with new content: stored again, as a payload if large.
    item(&mut held, 0, "cmd")["aggregatedOutput"] = text(1200, "rerun").into();
    item(&mut held, 0, "fc")["changes"] = json!([{"path":"/w/one.rs"}]);
    write(&mut db, &held, Dirty::default().item("t1", "cmd").item("t1", "fc"));
    assert_eq!(changes(&db), ["agent_items~t1/cmd", "agent_items~t1/fc", "agent_payloads-t1/fc/changes",
        "agent_payloads~t1/cmd/aggregatedOutput"]);
    item(&mut expected, 0, "cmd")["aggregatedOutput"] = text(1200, "rerun").into();
    item(&mut expected, 0, "fc")["changes"] = json!([{"path":"/w/one.rs"}]);
    assert_same(&stored(&db, "a"), &expected);
    // An Item in its form without payloads moved to a Turn it has no row in
    // is refused rather than written without them.
    let moved = held.turns[1]["items"][0].clone();
    held.turns[2]["items"].as_array_mut().unwrap().push(moved);
    let loaded = rows::turn_ids(&db, "a").unwrap();
    assert!(rows::plan(&db, "a", &held, &held.turns, &loaded, Dirty::default().whole_turn("t3"), &[]).is_err());
}

/// What finds an Item without reading its Turn: kept with its row, replaced
/// as it changes, gone with it.
#[test]
fn item_keys_follow_their_items() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&record("k", vec![
        json!({"id":"t1","status":"completed","items":[
            {"id":"u","type":"userMessage","clientId":"c1","nativeUuid":"n1","content":[]},
            {"id":"call","type":"claudeToolUse","name":"Agent","status":"completed",
                "subAgent":{"taskId":"task-1","status":"running","result":text(2000, "long result")}},
            {"id":"sub","type":"subAgentActivity","agentThreadId":"child-1"}]}),
        json!({"id":"t2","status":"inProgress","items":[]}),
    ]));
    insert(&mut db, &detail);
    let keyed = |kind: &str, key: &str| rows::keyed(&db, "k", kind, key).unwrap();
    assert_eq!(keyed("client", "c1"), [("t1".to_owned(), "u".to_owned())]);
    assert_eq!(keyed("uuid", "n1"), [("t1".to_owned(), "u".to_owned())]);
    assert_eq!(keyed("task", "task-1"), [("t1".to_owned(), "call".to_owned())]);
    assert_eq!(keyed("running", "call"), [("t1".to_owned(), "call".to_owned())]);
    assert_eq!(rows::keys_of(&db, "k", "child").unwrap(), ["child-1"]);
    assert_eq!(count(&db, "agent_payloads"), 0, "a task record is never a payload, so its keys are in its row");
    // The task ends: it no longer counts as running.
    item(&mut detail, 0, "call")["subAgent"]["status"] = "completed".into();
    write(&mut db, &detail, Dirty::default().item("t1", "call"));
    assert!(rows::keyed(&db, "k", "running", "call").unwrap().is_empty());
    assert_eq!(rows::keyed(&db, "k", "task", "task-1").unwrap().len(), 1);
    detail.turns.remove(0);
    write(&mut db, &detail, &Dirty::default());
    assert_eq!(count(&db, "agent_item_keys"), 0);
}

/// Receipts are rows of their own: those not settled are read alone, the
/// settled ones by their Turn or client ID.
#[test]
fn receipts_are_kept_apart_from_the_metadata() {
    let dir = lab();
    let mut db = database(&dir.path().join("w.sqlite"));
    let mut detail = parsed(&rich());
    detail.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"c2","text":"next"},"status":"sending"})).unwrap());
    insert(&mut db, &detail);
    let open = rows::open_receipts(&db, "a").unwrap();
    assert_eq!(open.iter().map(|r| r.input.client_message_id.as_str()).collect::<Vec<_>>(), ["c2"]);
    assert_eq!(rows::turn_receipts(&db, "a", &["t1".into()]).unwrap().len(), 1);
    assert!(rows::turn_receipts(&db, "a", &["t2".into()]).unwrap().is_empty());
    assert_eq!(rows::receipt(&db, "a", "c1").unwrap().unwrap().status, "accepted");
    // Accepted later: settled, kept with its Turn.
    detail.message_receipts[1].status = "accepted".into();
    detail.message_receipts[1].turn_id = Some("t2".into());
    write(&mut db, &detail, &Dirty::default());
    assert!(rows::open_receipts(&db, "a").unwrap().is_empty());
    assert_eq!(rows::turn_receipts(&db, "a", &["t2".into()]).unwrap()[0].input.client_message_id, "c2");
    assert!(rows::answered(&db, "a", None, None).is_ok_and(|found| !found));
}

/// A Workspace whose Agents an earlier session store wrote is not opened:
/// none of its records is read or converted (T-140).
#[test]
fn a_workspace_of_an_earlier_store_is_not_opened() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
    db.execute("INSERT INTO agents(id,data) VALUES('old',?1)", [serde_json::to_string(&parsed(&rich())).unwrap()]).unwrap();
    drop(db);
    let error = yuzuno_workspace::store::Store::open(&path).err().unwrap();
    assert!(format!("{error:#}").contains("旧版会话存储"), "{error:#}");
    let data: String = Connection::open(&path).unwrap().query_row("SELECT data FROM agents WHERE id='old'", [], |r| r.get(0)).unwrap();
    assert!(data.contains("\"turns\""), "the record is left as it was");
    // An empty Workspace is this store's from its first open.
    let fresh = dir.path().join("fresh.sqlite");
    drop(yuzuno_workspace::store::Store::open(&fresh).unwrap());
    let marked: String = Connection::open(&fresh).unwrap()
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [rows::STORE_KEY], |r| r.get(0)).unwrap();
    assert_eq!(marked, rows::STORE_VERSION);
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

/// Random edits of random Turns, each written as a change of the Turns it
/// selected (those it changed, removed or added), keep the rows equal to the
/// record.
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
        let dirty = Dirty::between(&before.turns, &detail.turns);
        write(&mut db, &detail, &dirty);
        assert!(same(&stored(&db, "r"), &detail), "step {step}");
        assert!(rows::rows_fit(&db, "r").unwrap(), "step {step}");
    }
    assert!(detail.turns.iter().map(|t| t["items"].as_array().unwrap().len()).sum::<usize>() > 20);
    assert!(count(&db, "agent_payloads") > 5);
}

#[test]
fn between_names_what_changed() {
    let before = parsed(&rich());
    let mut after = before.clone();
    assert!(Dirty::between(&before.turns, &after.turns).is_meta_only());
    item(&mut after, 0, "cmd")["status"] = "failed".into();
    after.turns[1]["status"] = "completed".into();
    after.turns.push(json!({"id":"t4","items":[]}));
    let dirty = Dirty::between(&before.turns, &after.turns);
    let mut expected = Dirty::default();
    expected.item("t1", "cmd").turn("t2").whole_turn("t4");
    assert_eq!(dirty, expected);
    after.turns[0]["items"][0]["id"] = Value::Null;
    item(&mut after, 0, "small")["status"] = "x".into();
    assert!(Dirty::between(&before.turns, &after.turns).turns()["t1"].all_items, "Items without IDs");
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
