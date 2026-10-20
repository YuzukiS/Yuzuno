//! The Store on record rows: the detail API and payload requests read rows
//! (without payloads, or one Item's), committed records stay in memory, and
//! a damaged record is shown read only without holding back other Agents.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
use yuzuno_workspace::{client_view, model::AgentDetail, record_rows::{self, Layout}, store::{route, Store}};

fn lab() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn text(n: usize, seed: &str) -> String {
    (0..n).map(|i| format!("{seed} line {i:05}\n")).collect()
}

fn record(id: &str) -> AgentDetail {
    serde_json::from_value(json!({
        "agent":{"id":id,"name":id,"cwd":"/w","model":"m","color":"sage","threadId":"thread","status":"idle",
            "createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":1,"lastSeq":0,"reviewedSeq":0},
        "turns":[
            {"id":"t1","status":"completed","items":[
                {"id":"ask","type":"userMessage","content":[{"type":"text","text":"build"}]},
                {"id":"cmd","type":"commandExecution","command":"make","status":"completed","aggregatedOutput":text(1500, "make")},
                {"id":"asked","type":"commandExecution","command":"rm","status":"inProgress","aggregatedOutput":text(1500, "rm")},
                {"id":"mcp","type":"mcpToolCall","status":"completed","result":{"content":[{"type":"text","text":text(900, "mcp")}]}},
                {"id":"reply","type":"agentMessage","text":"done","phase":"final_answer"}]},
            {"id":"t2","status":"inProgress","items":[
                {"id":"run","type":"commandExecution","command":"test","status":"inProgress","aggregatedOutput":text(1000, "test")}]}],
        // A request about "asked": clients are sent that Item whole.
        "pending":[{"id":"p","agentId":id,"method":"item/commandExecution/requestApproval",
            "params":{"turnId":"t1","itemId":"asked"},"createdAt":"now"}],
        "artifacts":[]})).unwrap()
}

fn sql(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    db
}

/// A Store whose Agent "a" is closed, so opening it does not hold "a" in
/// memory: reads go to its rows.
fn closed(dir: &Path) -> Store {
    let path = dir.join("workspace.sqlite");
    {
        let store = Store::open(&path).unwrap();
        store.insert(&record("a")).unwrap();
        store.update("a", "agent/closed", &json!({}), |d| d.agent.closed_at = Some("now".into())).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.streamed_records(), 0);
    store
}

fn json_of(detail: &AgentDetail) -> String {
    serde_json::to_string(detail).unwrap()
}

#[test]
fn the_detail_api_reads_rows_without_payloads_as_the_client_view() {
    let dir = lab();
    let store = closed(dir.path());
    let full = store.detail("a").unwrap();
    // Listed from its metadata, Turn rows and newest Turn alone.
    assert_eq!(serde_json::to_value(store.agent("a").unwrap().work_summary).unwrap(),
        serde_json::to_value(yuzuno_workspace::rail::project(&full)).unwrap());
    let expected = client_view::detail(full);
    assert_eq!(json_of(&store.client_detail("a").unwrap()), json_of(&expected));
    let asked = &expected.turns[0]["items"][2];
    assert_eq!(asked["aggregatedOutput"], text(1500, "rm"), "the Item a request is about stays whole");
    assert!(expected.turns[0]["items"][1]["_yuzunoTruncated"].is_object());
    // Payload rows of the other Items are never read for it.
    sql(&dir.path().join("workspace.sqlite"))
        .execute("UPDATE agent_payloads SET data='not json' WHERE item_id!='asked'", []).unwrap();
    assert_eq!(json_of(&store.client_detail("a").unwrap()), json_of(&expected));
    assert_eq!(store.detail("a").unwrap().agent.status, "error", "a full read finds the damage");
    // So does making the Item a request is about whole: a stand-in, not a failure.
    sql(&dir.path().join("workspace.sqlite"))
        .execute("UPDATE agent_payloads SET data='not json' WHERE item_id='asked'", []).unwrap();
    let shown = store.client_detail("a").unwrap();
    assert_eq!(shown.agent.status, "error");
    assert!(shown.agent.error.unwrap().contains("--revert-record-rows"));
}

#[test]
fn payload_requests_read_only_their_rows_or_the_record_in_memory() {
    let dir = lab();
    let store = closed(dir.path());
    let full = store.detail("a").unwrap();
    let item = |turn: Option<&str>, id: &str, fields: Option<&str>| store
        .payload_view("a", turn, Some(id), |d| client_view::item_payload(d, turn, id, fields)).unwrap().unwrap();
    let cmd = client_view::item_payload(&full, None, "cmd", None).unwrap();
    assert_eq!(cmd["fields"]["aggregatedOutput"], text(1500, "make"));
    assert_eq!(item(None, "cmd", None).unwrap(), cmd);
    assert_eq!(item(Some("t1"), "cmd", Some("command,status")).unwrap(),
        client_view::item_payload(&full, Some("t1"), "cmd", Some("command,status")).unwrap());
    let turn = store.payload_view("a", Some("t1"), None, |d| client_view::turn_payload(d, "t1")).unwrap().unwrap().unwrap();
    assert_eq!(turn, client_view::turn_payload(&full, "t1").unwrap());
    // What is missing is told apart as before.
    assert_eq!(item(Some("t2"), "cmd", None).unwrap_err(), client_view::Missing::Item);
    assert_eq!(item(Some("t9"), "cmd", None).unwrap_err(), client_view::Missing::Turn);
    assert_eq!(item(None, "nothing", None).unwrap_err(), client_view::Missing::Item);
    assert!(store.payload_view("nobody", None, Some("cmd"), |_| ()).unwrap().is_none());
    // Only that Item's rows are read.
    sql(&dir.path().join("workspace.sqlite"))
        .execute("UPDATE agent_payloads SET data='not json' WHERE item_id!='cmd'", []).unwrap();
    assert_eq!(item(None, "cmd", None).unwrap(), cmd);
    // A record held in memory is newer than its rows: it answers.
    let open = record("b");
    store.insert(&open).unwrap();
    let kind = "item/commandExecution/outputDelta";
    let p = json!({"turnId":"t2","itemId":"run","delta":"more\n"});
    store.record_stream("b", route(kind, &p), kind, &p).unwrap();
    let run = store.payload_view("b", None, Some("run"), |d| client_view::item_payload(d, None, "run", None)).unwrap().unwrap().unwrap();
    assert_eq!(run["fields"]["aggregatedOutput"], format!("{}more\n", text(1000, "test")));
}

#[test]
fn committed_records_stay_in_memory_so_a_turn_start_does_not_reload_them() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    store.insert(&record("a")).unwrap();
    store.update("a", "message/requested", &json!({}), |_| {}).unwrap();
    assert_eq!(store.streamed_records(), 1);
    // Proof the next updates do not read the record: its metadata row no
    // longer parses (every write rewrites it).
    sql(&path).execute("UPDATE agents SET data='not json' WHERE id='a'", []).unwrap();
    for kind in ["turn/requested", "turn/started", "turn/accepted", "message/receipt"] {
        store.update("a", kind, &json!({}), |d| d.agent.status = "working".into()).unwrap();
    }
    let row = record_rows::load(&sql(&path), "a", true).unwrap().unwrap();
    assert_eq!((row.agent.status.as_str(), row.turns.len()), ("working", 2));
    // Idle ones leave memory (see Store::stream_tick).
    std::thread::sleep(std::time::Duration::from_millis(5100));
    store.stream_tick(std::time::Duration::from_secs(60));
    assert_eq!(store.streamed_records(), 0);
}

#[test]
fn a_picked_update_returns_what_update_would_without_copying_the_record() {
    let dir = lab();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    store.insert(&record("a")).unwrap();
    // A receipt for a message whose native item is already in the record:
    // the commit binds it, and the pick sees it bound, as `update` returns it.
    let receipt: yuzuno_workspace::model::MessageReceipt = serde_json::from_value(json!({"input":{"clientMessageId":"c1",
        "text":"go on","expectedTurnId":"t2","question":null},"status":"sending","turnId":null,"error":null})).unwrap();
    let picked = store.update_picking("a", "message/receipt", &json!({}), move |d| {
        d.turns[1]["items"].as_array_mut().unwrap().push(json!({"id":"u","type":"userMessage","clientId":"c1",
            "content":[{"type":"text","text":"go on"}]}));
        d.message_receipts.push(receipt);
        d.message_receipts[0].status = "accepted".into();
    }, |d| d.message_receipts.iter().find(|r| r.input.client_message_id == "c1").cloned()).unwrap().unwrap();
    let full = store.update("a", "message/seen", &json!({}), |_| {}).unwrap();
    assert_eq!(serde_json::to_value(&picked).unwrap(), serde_json::to_value(&full.message_receipts[0]).unwrap());
    let binding = serde_json::to_value(picked.binding.expect("bound in the commit")).unwrap();
    assert_eq!((binding["turnId"].as_str(), binding["itemId"].as_str()), (Some("t2"), Some("u")));
    // Committed like `update`: the journal row and the record are written.
    assert_eq!(store.detail("a").unwrap().message_receipts.len(), 1);
}

/// A database an older Core left (whole records), converted by opening it.
fn converted(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("workspace.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);").unwrap();
    for id in ["a", "b"] {
        db.execute("INSERT INTO agents(id,data) VALUES(?1,?2)", params![id, json_of(&record(id))]).unwrap();
    }
    drop(db);
    let store = Store::open(&path).unwrap();
    // A change after the conversion, which the rows have and the original not.
    store.update("a", "agent/renamed", &json!({}), |d| d.agent.name = "renamed".into()).unwrap();
    path
}

#[test]
fn a_damaged_record_is_shown_read_only_and_holds_back_no_other_agent() {
    let dir = lab();
    let path = converted(dir.path());
    // An Item row goes missing.
    sql(&path).execute("DELETE FROM agent_items WHERE agent_id='a' AND item_id='mcp'", []).unwrap();
    let store = Store::open(&path).unwrap();
    let listed = store.agents().unwrap();
    assert_eq!(listed.len(), 2);
    let a = store.agent("a").unwrap();
    let note = a.error.clone().unwrap();
    assert_eq!(a.status, "error");
    assert!(note.contains("--revert-record-rows") && note.contains("转换时"), "{note}");
    // Shown as converted, with what the journal replays since.
    let shown = store.detail("a").unwrap();
    assert_eq!(shown.turns, record("a").turns);
    assert_eq!(shown.agent.name, "a");
    assert_eq!(store.client_detail("a").unwrap().turns.len(), 2);
    assert!(store.payload_view("a", None, Some("cmd"), |d| client_view::item_payload(d, None, "cmd", None)).unwrap().unwrap().is_ok());
    // Nothing is written over it.
    let refused = store.update("a", "agent/renamed", &json!({}), |d| d.agent.name = "again".into()).unwrap_err().to_string();
    assert!(refused.contains("--revert-record-rows"), "{refused}");
    let kind = "item/agentMessage/delta";
    let p = json!({"turnId":"t2","itemId":"reply2","delta":"x"});
    assert!(store.record_stream("a", route(kind, &p), kind, &p).is_err());
    // Nor is it marked read.
    let journal = |path: &Path| -> i64 { sql(path).query_row("SELECT COUNT(*) FROM journal WHERE agent_id='a' AND kind='workspace/reviewed'", [], |r| r.get(0)).unwrap() };
    let marks = journal(&path);
    // Refused, or already read as listed: either way nothing is written.
    assert!(!matches!(store.review("a", i64::MAX), Ok(true)));
    assert_eq!(journal(&path), marks);
    // The other Agent works as ever.
    store.update("b", "agent/renamed", &json!({}), |d| d.agent.name = "fine".into()).unwrap();
    assert_eq!(store.detail("b").unwrap().agent.name, "fine");
    drop(store);
    // Without the original only the metadata is shown; with that damaged
    // too, the Agent is still listed.
    sql(&path).execute("DELETE FROM agent_originals WHERE agent_id='a'", []).unwrap();
    let store = Store::open(&path).unwrap();
    let shown = store.detail("a").unwrap();
    assert!(shown.turns.is_empty() && shown.agent.name == "renamed");
    assert!(shown.agent.error.unwrap().contains("只显示它的设置"));
    drop(store);
    sql(&path).execute("UPDATE agents SET data='not json' WHERE id='a'", []).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.agents().unwrap().len(), 2);
    assert_eq!(store.agent("a").unwrap().status, "error");
}

/// A damaged record nobody has read in this process is not marked read
/// either: its rows are checked (without parsing them) first. One whose rows
/// fit but do not parse is found once something reads it.
#[test]
fn a_read_mark_is_refused_for_a_damaged_record() {
    let dir = lab();
    let store = closed(dir.path());
    let path = dir.path().join("workspace.sqlite");
    let marks = |path: &Path| -> i64 { sql(path).query_row("SELECT COUNT(*) FROM journal WHERE kind='workspace/reviewed'", [], |r| r.get(0)).unwrap() };
    sql(&path).execute("UPDATE agent_items SET ord=9 WHERE item_id='cmd'", []).unwrap();
    assert!(store.review("a", i64::MAX).is_err());
    assert_eq!(marks(&path), 0);
    assert_eq!(store.agent("a").unwrap().status, "error", "and listed as damaged");
    drop(store);
    let dir = lab();
    let store = closed(dir.path());
    let path = dir.path().join("workspace.sqlite");
    sql(&path).execute("UPDATE agent_items SET data='not json' WHERE item_id='cmd'", []).unwrap();
    assert_eq!(store.detail("a").unwrap().agent.status, "error");
    assert!(store.review("a", i64::MAX).is_err());
    assert_eq!(marks(&path), 0);
}

/// A record still stored whole (an older Core wrote it after the
/// conversion, or it could not be converted) answers payload requests.
#[test]
fn a_record_stored_whole_answers_payload_requests() {
    let dir = lab();
    let store = closed(dir.path());
    let path = dir.path().join("workspace.sqlite");
    sql(&path).execute("INSERT INTO agents(id,data) VALUES('w',?1)", [json_of(&record("w"))]).unwrap();
    assert_eq!(record_rows::layout(&sql(&path), "w").unwrap(), Some(Layout::Whole));
    let cmd = store.payload_view("w", None, Some("cmd"), |d| client_view::item_payload(d, None, "cmd", None)).unwrap().unwrap().unwrap();
    assert_eq!(cmd["fields"]["aggregatedOutput"], text(1500, "make"));
    let turn = store.payload_view("w", Some("t1"), None, |d| client_view::turn_payload(d, "t1")).unwrap().unwrap().unwrap();
    assert_eq!(turn["items"]["cmd"]["fields"]["aggregatedOutput"], text(1500, "make"));
}

/// A missing payload row is not seen by reads without payloads; once a
/// change finds it (the restart does), the Agent is listed and shown as
/// its stand-in, and nothing more is written to it.
#[test]
fn a_missing_payload_row_shows_the_stand_in_once_found() {
    let dir = lab();
    let path = converted(dir.path());
    sql(&path).execute("DELETE FROM agent_payloads WHERE agent_id='a' AND item_id='mcp'", []).unwrap();
    let store = Store::open(&path).unwrap();
    let listed = store.agent("a").unwrap();
    assert_eq!(listed.status, "error");
    let shown = store.client_detail("a").unwrap();
    assert_eq!(shown.agent.status, "error");
    assert!(shown.agent.error.unwrap().contains("--revert-record-rows"));
    // Payload requests answer from the same stand-in (its original here).
    let cmd = store.payload_view("a", None, Some("cmd"), |d| client_view::item_payload(d, None, "cmd", None)).unwrap().unwrap().unwrap();
    assert_eq!(cmd["fields"]["aggregatedOutput"], text(1500, "make"));
    assert!(!matches!(store.review("a", i64::MAX), Ok(true)));
    assert_eq!(store.agent("b").unwrap().status, "offline", "the other Agent is as ever");
}

#[test]
fn reverting_takes_the_workspace_lock_and_salvages_damaged_records() {
    let dir = lab();
    let path = converted(dir.path());
    let store = Store::open(&path).unwrap();
    assert!(record_rows::revert_workspace(&path).is_err(), "not while a Core has it open");
    drop(store);
    let db = sql(&path);
    // "a": one Item row and one payload row go missing.
    db.execute("DELETE FROM agent_items WHERE agent_id='a' AND item_id='mcp'", []).unwrap();
    db.execute("DELETE FROM agent_payloads WHERE agent_id='a' AND item_id='cmd'", []).unwrap();
    let rows_of_a: i64 = db.query_row("SELECT (SELECT COUNT(*) FROM agent_turns WHERE agent_id='a')
        + (SELECT COUNT(*) FROM agent_items WHERE agent_id='a') + (SELECT COUNT(*) FROM agent_payloads WHERE agent_id='a')
        + 2", [], |r| r.get(0)).unwrap();
    let backup = record_rows::recorded_backup(&db).unwrap().unwrap();
    drop(db);
    let done = record_rows::revert_workspace(&path).unwrap();
    assert_eq!(done.agents, ["b"]);
    assert!(done.failed.is_empty());
    let [(id, salvaged)] = done.salvaged.as_slice() else { panic!("{:?}", done.salvaged) };
    assert_eq!(id, "a");
    assert_eq!(*salvaged, record_rows::Salvage { turns: 2, items: 5, lost_turns: 0, lost_items: 1, lost_payloads: 1,
        stray_payloads: 0, metadata_from_original: false, rows_kept: rows_of_a as usize });
    let db = sql(&path);
    let whole = |id: &str| -> AgentDetail {
        assert_eq!(record_rows::layout(&db, id).unwrap(), Some(Layout::Whole));
        let data: String = db.query_row("SELECT data FROM agents WHERE id=?1", [id], |r| r.get(0)).unwrap();
        serde_json::from_str(&data).unwrap()
    };
    assert_eq!(whole("b").turns, record("b").turns, "as an older Core reads it");
    // Everything that could be read, the change after the conversion too.
    let a = whole("a");
    assert_eq!(a.agent.name, "renamed");
    let (now, then) = (&a.turns[0]["items"], &record("a").turns[0]["items"]);
    assert_eq!((now[0].clone(), now[2].clone(), now[4].clone()), (then[0].clone(), then[2].clone(), then[4].clone()));
    assert_eq!(a.turns[1], record("a").turns[1]);
    assert_eq!((now[3]["type"].as_str(), now[3][record_rows::SALVAGE].is_string()), (Some("unavailable"), true));
    let cmd = &now[1];
    assert!(cmd["aggregatedOutput"].as_str().unwrap().len() < text(1500, "make").len(), "the preview");
    assert!(cmd[record_rows::SALVAGE]["aggregatedOutput"].is_string());
    // Nothing is dropped, nothing forgotten.
    let kept: i64 = db.query_row("SELECT COUNT(*) FROM agent_salvage WHERE agent_id='a'", [], |r| r.get(0)).unwrap();
    assert_eq!(kept, rows_of_a);
    assert_eq!(record_rows::recorded_backup(&db).unwrap().as_deref(), Some(backup.as_str()));
    let rows: i64 = db.query_row("SELECT (SELECT COUNT(*) FROM agent_turns)+(SELECT COUNT(*) FROM agent_originals WHERE agent_id='b')", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
}

/// A damaged record whose metadata is unreadable takes its original's; with
/// no original it is left as it is, rows untouched.
#[test]
fn reverting_without_readable_metadata_uses_the_original_or_leaves_the_record() {
    let dir = lab();
    let path = converted(dir.path());
    sql(&path).execute("UPDATE agents SET data='not json' WHERE id='a'", []).unwrap();
    let done = record_rows::revert_workspace(&path).unwrap();
    let [(_, salvaged)] = done.salvaged.as_slice() else { panic!("{:?}", done.salvaged) };
    assert!(salvaged.metadata_from_original && salvaged.lost_items == 0);
    let data: String = sql(&path).query_row("SELECT data FROM agents WHERE id='a'", [], |r| r.get(0)).unwrap();
    let a: AgentDetail = serde_json::from_str(&data).unwrap();
    assert_eq!((a.agent.name.as_str(), a.turns.len()), ("a", 2), "metadata as converted, Turns from the rows");
    let dir = lab();
    let path = converted(dir.path());
    let db = sql(&path);
    db.execute("UPDATE agents SET data='not json' WHERE id='a'", []).unwrap();
    db.execute("DELETE FROM agent_originals WHERE agent_id='a'", []).unwrap();
    drop(db);
    let done = record_rows::revert_workspace(&path).unwrap();
    assert_eq!(done.agents, ["b"]);
    assert_eq!(done.failed.len(), 1);
    let db = sql(&path);
    assert_eq!(record_rows::layout(&db, "a").unwrap(), Some(Layout::Rows));
    let turns: i64 = db.query_row("SELECT COUNT(*) FROM agent_turns WHERE agent_id='a'", [], |r| r.get(0)).unwrap();
    assert_eq!(turns, 2, "its rows are left");
}

#[test]
fn the_revert_command_stores_records_whole_again() {
    let dir = lab();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    drop(converted(&data));
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_yuzuno-workspace"))
        .args(["--revert-record-rows", "--data-dir"]).arg(&data).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout}{}", String::from_utf8_lossy(&out.stderr));
    assert!(stdout.contains("Stored 2 Agent records whole again"), "{stdout}");
    let layouts: Vec<i64> = sql(&data.join("workspace.sqlite")).prepare("SELECT layout FROM agents").unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(layouts, [0, 0]);
    let _: Value = json!(null);
}

/// `record`, with an async question the model asked and a sent message whose
/// native item has arrived.
fn asked(id: &str) -> AgentDetail {
    let mut d = record(id);
    d.turns[0]["items"].as_array_mut().unwrap().push(json!({"id":"q","type":"agentMessage","text":"Which?",
        "delivery":"async","questions":[{"title":"Which?"}]}));
    d.turns[1]["items"].as_array_mut().unwrap().push(json!({"id":"u","type":"userMessage","clientId":"c1",
        "content":[{"type":"text","text":"go on"}]}));
    d.message_receipts = serde_json::from_value(json!([{"input":{"clientMessageId":"c1","text":"go on",
        "expectedTurnId":"t2","question":null},"status":"accepted","turnId":"t2","error":null}])).unwrap();
    d
}

fn turn_summary(d: &AgentDetail) -> Vec<(String, String)> {
    d.turns.iter().map(|t| (t["id"].as_str().unwrap().to_owned(), t["status"].as_str().unwrap().to_owned())).collect()
}

#[test]
fn a_send_view_has_what_a_send_checks_and_no_other_items() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    store.insert(&asked("a")).unwrap();
    let check = |store: &Store| {
        let (view, full) = (store.send_view("a").unwrap(), store.detail("a").unwrap());
        assert_eq!((view.agent.status.as_str(), view.agent.thread_id.as_deref()), (full.agent.status.as_str(), full.agent.thread_id.as_deref()));
        assert_eq!(view.agent.project_id, full.agent.project_id);
        assert_eq!(turn_summary(&view), turn_summary(&full));
        assert_eq!(serde_json::to_value(&view.message_receipts).unwrap(), serde_json::to_value(&full.message_receipts).unwrap());
        assert_eq!(serde_json::to_value(&view.pending).unwrap(), serde_json::to_value(&full.pending).unwrap());
        // Of the Items only the async question remains, as it was.
        let items: Vec<&Value> = view.turns.iter().flat_map(|t| t["items"].as_array().unwrap()).collect();
        assert_eq!(items, vec![&full.turns[0]["items"][5]]);
        assert_eq!(items[0]["id"], "q");
    };
    // Not held (idle): read from its rows.
    assert_eq!(store.streamed_records(), 0);
    check(&store);
    // Held after a commit: read from memory, not from the rows. Their
    // metadata row no longer parses, as in the test above.
    store.update("a", "message/requested", &json!({}), |_| {}).unwrap();
    assert_eq!(store.streamed_records(), 1);
    check(&store);
    sql(&path).execute("UPDATE agents SET data='not json' WHERE id='a'", []).unwrap();
    assert_eq!(turn_summary(&store.send_view("a").unwrap()), vec![("t1".into(), "completed".into()), ("t2".into(), "inProgress".into())]);
}
