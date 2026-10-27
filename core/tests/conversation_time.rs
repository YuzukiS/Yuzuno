#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::{json, Value};
use std::time::Duration;
use yuzuno_workspace::{model::AgentDetail, record_rows, store::{route, Store}};

fn detail() -> AgentDetail {
    serde_json::from_value(json!({
        "agent":{"id":"a","name":"A","cwd":"/tmp","model":"","color":"sage",
            "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]
    })).unwrap()
}

#[test]
fn codex_message_times_come_from_native_item_times_and_never_move() {
    let mut d = detail();
    let user = json!({"id":"u","type":"userMessage","content":[{"type":"text","text":"go"}]});
    let reply = |text: &str| json!({"id":"r","type":"agentMessage","text":text});
    d.apply("item/started", &json!({"turnId":"t","startedAtMs":1_700_000_000_100_i64,"item":user}));
    d.apply("item/completed", &json!({"turnId":"t","completedAtMs":1_700_000_000_200_i64,"item":user}));
    d.apply("item/started", &json!({"turnId":"t","startedAtMs":1_700_000_030_000_i64,"item":reply("")}));
    d.apply("item/agentMessage/delta", &json!({"turnId":"t","itemId":"r","delta":"Done"}));
    d.apply("item/completed", &json!({"turnId":"t","completedAtMs":1_700_000_095_000_i64,"item":reply("Done")}));
    // A completion payload with partial bodies must not drop or move the times.
    d.apply("turn/completed", &json!({"turn":{"id":"t","status":"completed","items":[reply("Done")]}}));
    let restored: AgentDetail = serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
    let items = restored.turns[0]["items"].as_array().unwrap();
    assert_eq!(items[0]["_yuzunoTime"], json!({"at":1_700_000_000_100_i64,"source":"codex"}));
    assert_eq!(items[1]["_yuzunoTime"], json!({"at":1_700_000_030_000_i64,"source":"codex"}));
    assert_eq!(items[1]["text"], "Done");
}

#[test]
fn codex_without_item_times_records_when_core_saw_the_message_and_skips_tools() {
    let mut d = detail();
    d.apply("item/completed", &json!({"turnId":"t","item":{"id":"r","type":"agentMessage","text":"late join"}}));
    d.apply("item/started", &json!({"turnId":"t","startedAtMs":1_700_000_000_000_i64,"item":{"id":"c","type":"commandExecution"}}));
    let items = d.turns[0]["items"].as_array().unwrap();
    assert_eq!(items[0]["_yuzunoTime"]["source"], "core");
    assert!(items[0]["_yuzunoTime"]["at"].as_i64().unwrap() > 1_700_000_000_000_i64);
    assert!(items[1].get("_yuzunoTime").is_none());
}

#[test]
fn codex_turn_end_keeps_native_duration_and_records_live_completion_once() {
    let mut d = detail();
    d.apply("turn/started", &json!({"turn":{"id":"t","status":"inProgress","items":[],"startedAt":1_700_000_000}}));
    assert!(d.turns[0]["_yuzunoCompletedAt"].is_null());
    d.apply("turn/completed", &json!({"turn":{"id":"t","status":"completed","items":[],
        "startedAt":1_700_000_000,"completedAt":1_700_000_526,"durationMs":526_400}}));
    assert_eq!(d.turns[0]["completedAt"], 1_700_000_526);
    assert_eq!(d.turns[0]["durationMs"], 526_400);
    let recorded = d.turns[0]["_yuzunoCompletedAt"].clone();
    assert!(recorded.as_i64().unwrap() > 0);
    // A repeated completion without native times neither erases nor moves them.
    d.apply("turn/completed", &json!({"turn":{"id":"t","status":"completed","items":[]}}));
    assert_eq!(d.turns[0]["durationMs"], 526_400);
    assert_eq!(d.turns[0]["_yuzunoCompletedAt"], recorded);
    // A late start response never reopens or re-times a finished turn.
    d.apply("turn/started", &json!({"turn":{"id":"t","status":"inProgress","items":[],"startedAt":1_700_000_900}}));
    assert_eq!(d.turns[0]["startedAt"], 1_700_000_000);
}

/// A Store on disk that can be closed, reopened, and have its record row set
/// to what an earlier write left, as a killed Core would.
struct Lab { dir: tempfile::TempDir, store: Option<Store> }

impl Lab {
    fn new(harness: &str) -> Self {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        store.insert(&Self::record(harness)).unwrap();
        Self { dir, store: Some(store) }
    }
    fn record(harness: &str) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "harness":harness,"threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[{"id":"t","status":"inProgress","items":[]}],
            "pending":[],"artifacts":[]})).unwrap()
    }
    fn store(&self) -> &Store { self.store.as_ref().unwrap() }
    fn reopen(&mut self) {
        drop(self.store.take());
        self.store = Some(Store::open(&self.dir.path().join("workspace.sqlite")).unwrap());
    }
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.path().join("workspace.sqlite")).unwrap()
    }
    /// The record as written, read through a separate connection.
    fn row(&self) -> AgentDetail {
        let db = self.sql();
        let mut d = record_rows::load_meta(&db, "a").unwrap().unwrap();
        record_rows::scan(&db, "a", true, |turn| { d.turns.push(turn); Ok(true) }).unwrap();
        d
    }
    /// The record a Core killed now leaves (the rows as committed, copied
    /// while this Store stays open), opened by another Store.
    fn killed(&self) -> AgentDetail {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let copy = dir.path().join("workspace.sqlite");
        self.sql().execute("VACUUM INTO ?1", [copy.to_str().unwrap()]).unwrap();
        Store::open(&copy).unwrap().detail("a").unwrap()
    }
    fn stream(&self, kind: &str, data: &Value) {
        self.store().record_stream("a", route(kind, data), kind, data).unwrap();
    }
    fn claude(&self, event: Value) {
        let kind = format!("claude/{}", event["type"].as_str().unwrap());
        self.stream(&kind, &json!({"type":"event","turnId":"t","event":event}));
    }
    fn time(&self, item: &str) -> Value {
        time_in(&self.store().detail("a").unwrap(), item)
    }
    fn journal_ms(&self, kind: &str) -> i64 {
        let at: String = self.sql().query_row("SELECT at FROM journal WHERE kind=?1 ORDER BY seq DESC LIMIT 1", [kind], |r| r.get(0)).unwrap();
        chrono::DateTime::parse_from_rfc3339(&at).unwrap().timestamp_millis()
    }
}

fn time_in(d: &AgentDetail, item: &str) -> Value {
    d.turns[0]["items"].as_array().unwrap().iter().find(|i| i["id"] == item).map(|i| i["_yuzunoTime"].clone()).unwrap_or(Value::Null)
}

#[test]
fn a_claude_message_keeps_its_first_streamed_time_through_completion_a_kill_and_restart() {
    let mut lab = Lab::new("claude");
    let delta = |index: u64, delta: Value| json!({"type":"stream_event","event":{"type":"content_block_delta","index":index,"delta":delta}});
    lab.claude(json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}));
    lab.claude(delta(0, json!({"type":"thinking_delta","thinking":"Plan"})));
    lab.claude(delta(1, json!({"type":"text_delta","text":"Hel"})));
    let first = lab.time("m");
    assert_eq!(first["source"], "core");
    // The completed thinking block is written at once, with the partial
    // message streamed before it.
    lab.claude(json!({"type":"assistant","uuid":"b0","message":{"id":"m","content":[{"type":"thinking","thinking":"Plan it."}]}}));
    assert_eq!(time_in(&lab.row(), "m"), first);
    std::thread::sleep(Duration::from_millis(20));
    lab.claude(delta(1, json!({"type":"text_delta","text":"lo"})));
    lab.claude(json!({"type":"assistant","uuid":"b1","message":{"id":"m","content":[{"type":"text","text":"Hello"}]}}));
    assert_eq!(lab.time("m"), first, "completion never moves it");
    assert_eq!(time_in(&lab.killed(), "m"), first, "a kill leaves it as written");
    lab.reopen();
    assert_eq!(lab.time("m"), first, "closing writes it with the record");
}

#[test]
fn a_codex_message_time_comes_from_the_native_time_or_its_journal_row_and_survives_a_kill() {
    let lab = Lab::new("codex");
    lab.stream("item/started", &json!({"turnId":"t","startedAtMs":1_700_000_000_100_i64,
        "item":{"id":"native","type":"agentMessage","text":""}}));
    lab.stream("item/started", &json!({"turnId":"t","item":{"id":"local","type":"agentMessage","text":""}}));
    let live = (lab.time("native"), lab.time("local"));
    assert_eq!(live.0, json!({"at":1_700_000_000_100_i64,"source":"codex"}));
    assert_eq!(live.1, json!({"at":lab.journal_ms("item/started"),"source":"core"}));
    std::thread::sleep(Duration::from_millis(20));
    let killed = lab.killed();
    assert_eq!((time_in(&killed, "native"), time_in(&killed, "local")), live);
}
