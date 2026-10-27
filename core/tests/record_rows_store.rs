//! The Store on record rows (T-140 session store): the detail API is the
//! client window, payload requests read only their rows, an active Agent's
//! metadata and open Turns are what memory keeps, and a damaged record is
//! refused without holding back other Agents.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use yuzuno_workspace::{client_view, model::AgentDetail, store::{route, whole::WholeRecord, Sel, Store}};

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

/// A Store whose Agent "a" is closed and not in memory: reads go to its rows.
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

/// The detail API answers with the client window, whose Items are as the
/// client view sends them; the payload rows of Items it sends as previews
/// are never read for it.
#[test]
fn the_detail_api_is_the_client_window_read_without_other_payloads() {
    let dir = lab();
    let store = closed(dir.path());
    let full = store.detail("a").unwrap();
    // Listed from its metadata and its open and newest Turns.
    assert_eq!(serde_json::to_value(store.agent("a").unwrap().work_summary).unwrap(),
        serde_json::to_value(yuzuno_workspace::rail::project(&full)).unwrap());
    let shown = store.client_detail("a").unwrap();
    // The window projected from the whole record, as clients get it.
    let mut expected = client_view::detail(full);
    yuzuno_workspace::conversation_window::project(&mut expected,
        &yuzuno_workspace::conversation_window::Query { view: Some("window".into()), ..Default::default() }).unwrap();
    assert_eq!(serde_json::to_value(&shown.turns).unwrap(), serde_json::to_value(&expected.turns).unwrap());
    let asked = &shown.turns[0]["items"][2];
    assert_eq!(asked["aggregatedOutput"], text(1500, "rm"), "the Item a request is about stays whole");
    assert!(shown.turns[0]["items"][1]["_yuzunoTruncated"].is_object());
    sql(&dir.path().join("workspace.sqlite"))
        .execute("UPDATE agent_payloads SET data='not json' WHERE item_id!='asked'", []).unwrap();
    assert_eq!(json_of(&store.client_detail("a").unwrap()), json_of(&shown));
    assert!(store.detail("a").is_err(), "a whole read with payloads finds the damage");
}

#[test]
fn payload_requests_read_only_their_rows_and_see_streamed_output() {
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
    assert_eq!(item(Some("t2"), "cmd", None).unwrap_err(), client_view::Missing::Item);
    assert_eq!(item(Some("t9"), "cmd", None).unwrap_err(), client_view::Missing::Turn);
    assert_eq!(item(None, "nothing", None).unwrap_err(), client_view::Missing::Item);
    assert!(store.payload_view("nobody", None, Some("cmd"), |_| ()).unwrap().is_none());
    sql(&dir.path().join("workspace.sqlite"))
        .execute("UPDATE agent_payloads SET data='not json' WHERE item_id!='cmd'", []).unwrap();
    assert_eq!(item(None, "cmd", None).unwrap(), cmd);
    // Output streamed only into memory is written before a read sees rows.
    store.insert(&record("b")).unwrap();
    let kind = "item/commandExecution/outputDelta";
    let p = json!({"turnId":"t2","itemId":"run","delta":"more\n"});
    store.record_stream("b", route(kind, &p), kind, &p).unwrap();
    let run = store.payload_view("b", None, Some("run"), |d| client_view::item_payload(d, None, "run", None)).unwrap().unwrap().unwrap();
    assert_eq!(run["fields"]["aggregatedOutput"], format!("{}more\n", text(1000, "test")));
}

/// What memory keeps of an Agent with activity: its metadata and its open and
/// newest Turns, Items that ended without their payloads. A change takes the
/// metadata from there, and idle Agents leave memory.
#[test]
fn an_active_agent_keeps_its_metadata_and_open_turns_in_memory() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    store.insert(&record("a")).unwrap();
    let kind = "item/commandExecution/outputDelta";
    let p = json!({"turnId":"t2","itemId":"run","delta":"x"});
    store.record_stream("a", route(kind, &p), kind, &p).unwrap();
    assert_eq!(store.streamed_records(), 1);
    let held = store.peek("a", |d| d.turns.iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>()).unwrap();
    assert_eq!(held, ["t2"], "the open Turn, which is the newest");
    // The metadata row no longer parses: a change of the Agent in memory
    // does not read it, and writes it again.
    sql(&path).execute("UPDATE agents SET data='not json' WHERE id='a'", []).unwrap();
    for kind in ["turn/requested", "turn/accepted", "message/receipt"] {
        store.record_event("a", kind, &json!({}), Sel::Open, |d| d.agent.status = "working".into()).unwrap();
    }
    let row = store.detail("a").unwrap();
    assert_eq!((row.agent.status.as_str(), row.turns.len()), ("working", 2));
    std::thread::sleep(std::time::Duration::from_millis(5100));
    store.stream_tick(std::time::Duration::from_secs(60));
    assert_eq!(store.streamed_records(), 0);
}

#[test]
fn a_picked_change_returns_the_committed_slice() {
    let dir = lab();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    store.insert(&record("a")).unwrap();
    // A receipt for a message whose native item is in the record: the commit
    // binds it, and the pick sees it bound.
    let receipt: yuzuno_workspace::model::MessageReceipt = serde_json::from_value(json!({"input":{"clientMessageId":"c1",
        "text":"go on","expectedTurnId":"t2","question":null},"status":"sending","turnId":null,"error":null})).unwrap();
    let picked = store.update_picking("a", "message/receipt", &json!({}), Sel::Open, move |d| {
        // The open Turn, which is the newest: all Sel::Open holds.
        d.turns.iter_mut().find(|t| t["id"] == "t2").unwrap()["items"].as_array_mut().unwrap().push(json!({"id":"u","type":"userMessage","clientId":"c1",
            "content":[{"type":"text","text":"go on"}]}));
        d.message_receipts.push(receipt);
        d.message_receipts[0].status = "accepted".into();
    }, |d| d.message_receipts.iter().find(|r| r.input.client_message_id == "c1").cloned()).unwrap().unwrap();
    let full = store.detail("a").unwrap();
    assert_eq!(serde_json::to_value(&picked).unwrap(), serde_json::to_value(&full.message_receipts[0]).unwrap());
    let binding = serde_json::to_value(picked.binding.expect("bound in the commit")).unwrap();
    assert_eq!((binding["turnId"].as_str(), binding["itemId"].as_str()), (Some("t2"), Some("u")));
    assert_eq!(store.receipt("a", "c1").unwrap().unwrap().status, "accepted");
}

/// A record whose rows do not fit together is listed with why, refused for
/// changes and read marks, and holds back no other Agent.
#[test]
fn a_damaged_record_is_refused_and_holds_back_no_other_agent() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    {
        let store = Store::open(&path).unwrap();
        store.insert(&record("a")).unwrap();
        store.insert(&record("b")).unwrap();
    }
    sql(&path).execute_batch("PRAGMA foreign_keys=OFF; UPDATE agent_items SET data='not json' WHERE agent_id='a' AND item_id='run';").unwrap();
    let store = Store::open(&path).unwrap();
    let listed = store.agents().unwrap();
    assert_eq!(listed.len(), 2);
    let a = listed.iter().find(|agent| agent.id == "a").unwrap();
    assert_eq!(a.status, "error");
    assert!(a.error.as_deref().unwrap_or_default().contains("无法读取"), "{:?}", a.error);
    assert!(store.send_view("a").is_err());
    assert!(store.record_event("a", "agent/renamed", &json!({}), Sel::Open, |d| d.agent.name = "again".into()).is_err());
    let kind = "item/agentMessage/delta";
    let p = json!({"turnId":"t2","itemId":"reply2","delta":"x"});
    assert!(store.record_stream("a", route(kind, &p), kind, &p).is_err());
    let marks = || -> i64 { sql(&path).query_row("SELECT COUNT(*) FROM journal WHERE agent_id='a' AND kind='workspace/reviewed'", [], |r| r.get(0)).unwrap() };
    let before = marks();
    assert!(!matches!(store.review("a", i64::MAX), Ok(true)));
    assert_eq!(marks(), before);
    store.record_event("b", "agent/renamed", &json!({}), Sel::Meta, |d| d.agent.name = "fine".into()).unwrap();
    assert_eq!(store.agent("b").unwrap().name, "fine");
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
        "expectedTurnId":"t2","question":null},"status":"accepted","turnId":"t2","error":null},
        {"input":{"clientMessageId":"c2","text":"and this","expectedTurnId":null,"question":null},"status":"sending","turnId":null,"error":null}])).unwrap();
    d
}

/// A send checks the Agent, its pending requests, its receipts not settled
/// and its open and newest Turns, from memory or the rows alike; a question
/// in an older Turn is read with that Turn.
#[test]
fn a_send_view_has_the_metadata_open_receipts_and_open_and_newest_turns() {
    let dir = lab();
    let path = dir.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    store.insert(&asked("a")).unwrap();
    let check = |store: &Store| {
        let (view, full) = (store.send_view("a").unwrap(), store.detail("a").unwrap());
        assert_eq!((view.agent.status.as_str(), view.agent.thread_id.as_deref()), (full.agent.status.as_str(), full.agent.thread_id.as_deref()));
        assert_eq!(view.agent.project_id, full.agent.project_id);
        let ids: Vec<&str> = view.turns.iter().map(|t| t["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["t2"]);
        let receipts: Vec<&str> = view.message_receipts.iter().map(|r| r.input.client_message_id.as_str()).collect();
        assert_eq!(receipts, ["c1", "c2"], "the open one, and the one kept with its Turn");
        assert_eq!(serde_json::to_value(&view.pending).unwrap(), serde_json::to_value(&full.pending).unwrap());
        let question = store.view("a", Sel::Turns(vec!["t1".into()])).unwrap();
        assert!(question.turns.iter().any(|t| t["items"].as_array().unwrap().iter().any(|i| i["id"] == "q")));
    };
    assert_eq!(store.streamed_records(), 0);
    check(&store);
    let kind = "item/commandExecution/outputDelta";
    let p = json!({"turnId":"t2","itemId":"run","delta":"x"});
    store.record_stream("a", route(kind, &p), kind, &p).unwrap();
    assert_eq!(store.streamed_records(), 1);
    check(&store);
    let value: Value = serde_json::to_value(store.send_view("a").unwrap().turns).unwrap();
    assert!(value[0]["items"][0]["aggregatedOutput"].as_str().unwrap().ends_with('x'), "with what streamed");
}
