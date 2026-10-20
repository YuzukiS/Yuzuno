use serde_json::{json, Value};
use std::time::Duration;
use yuzuno_workspace::{model::AgentDetail, record_rows::{self, Dirty}, store::{route, Store}};

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
    fn row(&self) -> AgentDetail { record_rows::load(&self.sql(), "a", true).unwrap().unwrap() }
    /// Reopens with the record row as `row` and the journal as it is.
    fn crash_to(&mut self, row: &AgentDetail) {
        drop(self.store.take());
        let mut db = self.sql();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let tx = db.transaction().unwrap();
        record_rows::write(&tx, "a", row, &Dirty::all()).unwrap();
        tx.commit().unwrap();
        drop(db);
        self.reopen();
    }
    fn stream(&self, kind: &str, data: &Value) {
        self.store().record_stream("a", route(kind, data), kind, data).unwrap();
    }
    fn claude(&self, event: Value) {
        let kind = format!("claude/{}", event["type"].as_str().unwrap());
        self.stream(&kind, &json!({"type":"event","turnId":"t","event":event}));
    }
    fn time(&self, item: &str) -> Value {
        let d = self.store().detail("a").unwrap();
        d.turns[0]["items"].as_array().unwrap().iter().find(|i| i["id"] == item).map(|i| i["_yuzunoTime"].clone()).unwrap_or(Value::Null)
    }
    fn journal_ms(&self, kind: &str) -> i64 {
        let at: String = self.sql().query_row("SELECT at FROM journal WHERE kind=?1 ORDER BY seq DESC LIMIT 1", [kind], |r| r.get(0)).unwrap();
        chrono::DateTime::parse_from_rfc3339(&at).unwrap().timestamp_millis()
    }
}

#[test]
fn a_claude_message_keeps_its_first_streamed_time_through_completion_restart_and_replay() {
    let mut lab = Lab::new("claude");
    let delta = |index: u64, delta: Value| json!({"type":"stream_event","event":{"type":"content_block_delta","index":index,"delta":delta}});
    lab.claude(json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}));
    lab.claude(delta(0, json!({"type":"thinking_delta","thinking":"Plan"})));
    lab.claude(delta(1, json!({"type":"text_delta","text":"Hel"})));
    let first = lab.time("m");
    assert_eq!(first["source"], "core");
    // Streamed text alone never makes a write due; the journaled thinking
    // block does, so the stream cadence writes the partial message.
    lab.claude(json!({"type":"assistant","uuid":"b0","message":{"id":"m","content":[{"type":"thinking","thinking":"Plan it."}]}}));
    assert!(lab.store().stream_tick(Duration::ZERO).failed.is_empty());
    let mid_stream = lab.row();
    assert!(mid_stream.turns[0]["items"].as_array().unwrap().iter().any(|i| i["id"] == "m" && i["_yuzunoTime"] == first));
    std::thread::sleep(Duration::from_millis(20));
    lab.claude(delta(1, json!({"type":"text_delta","text":"lo"})));
    lab.claude(json!({"type":"assistant","uuid":"b1","message":{"id":"m","content":[{"type":"text","text":"Hello"}]}}));
    assert_eq!(lab.time("m"), first, "completion never moves it");
    lab.reopen();
    assert_eq!(lab.time("m"), first, "closing writes it with the record");
    // Killed after the mid-stream write: the journaled completion replays
    // onto the written message, which keeps its time.
    lab.crash_to(&mid_stream);
    assert_eq!(lab.time("m"), first);
    // Killed before any write: only journaled blocks are left. The message
    // is timed by its own completed block's journal row on every replay.
    lab.crash_to(&Lab::record("claude"));
    let replayed = lab.time("m");
    assert_eq!(replayed, json!({"at":lab.journal_ms("claude/assistant"),"source":"core"}));
    lab.crash_to(&Lab::record("claude"));
    assert_eq!(lab.time("m"), replayed);
}

#[test]
fn a_codex_message_time_replays_from_the_native_time_or_its_journal_row() {
    let mut lab = Lab::new("codex");
    lab.stream("item/started", &json!({"turnId":"t","startedAtMs":1_700_000_000_100_i64,
        "item":{"id":"native","type":"agentMessage","text":""}}));
    lab.stream("item/started", &json!({"turnId":"t","item":{"id":"local","type":"agentMessage","text":""}}));
    let live = (lab.time("native"), lab.time("local"));
    assert_eq!(live.0, json!({"at":1_700_000_000_100_i64,"source":"codex"}));
    assert_eq!(live.1, json!({"at":lab.journal_ms("item/started"),"source":"core"}));
    std::thread::sleep(Duration::from_millis(20));
    lab.crash_to(&Lab::record("codex"));
    assert_eq!((lab.time("native"), lab.time("local")), live);
}
