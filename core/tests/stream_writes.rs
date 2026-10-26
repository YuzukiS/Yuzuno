//! Streamed output (deltas) is applied in memory and announced but never
//! journaled; its rows are written on the stream cadence, with the next
//! write, or before a read of the rows. Completed content and the other
//! frequent events are journaled and written at once, in one transaction.
//! Completed content and synchronous events are never lost; partial
//! streamed text may be, and nothing is ever repeated or replayed.
use serde_json::{json, Value};
use std::time::Duration;
use yuzuno_workspace::{model::AgentDetail, record_rows, store::{route, whole::WholeRecord, Route, Sel, Store, Streamed, MAX_STREAMS}};

fn detail() -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
        "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[{"id":"t","status":"inProgress","items":[]}],"pending":[],"artifacts":[]})).unwrap()
}

struct Lab { dir: tempfile::TempDir, store: Option<Store> }

impl Lab {
    fn new() -> Self {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        store.insert(&detail()).unwrap();
        Self { dir, store: Some(store) }
    }
    fn store(&self) -> &Store { self.store.as_ref().unwrap() }
    /// The record as written, read through a separate connection.
    fn row(&self) -> AgentDetail { self.row_of("a") }
    fn row_of(&self, id: &str) -> AgentDetail {
        let db = self.sql();
        let mut d = record_rows::load_meta(&db, id).unwrap().unwrap();
        record_rows::scan(&db, id, true, |turn| { d.turns.push(turn); Ok(true) }).unwrap();
        record_rows::each_receipt(&db, id, |r| d.message_receipts.push(r)).unwrap();
        d
    }
    /// The reply as the Agent's hot slice in memory has it.
    fn held(&self, id: &str) -> Value {
        self.store().peek(id, reply).expect("the Agent is in memory")
    }
    /// What a Core killed now leaves: the rows as committed, copied while
    /// this Store stays open, in a directory of their own.
    fn killed(&self) -> tempfile::TempDir {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let copy = dir.path().join("workspace.sqlite");
        self.sql().execute("VACUUM INTO ?1", [copy.to_str().unwrap()]).unwrap();
        dir
    }
    fn journal(&self, kind: &str) -> i64 {
        self.sql().query_row("SELECT COUNT(*) FROM journal WHERE kind=?1", [kind], |r| r.get(0)).unwrap()
    }
    fn top(&self) -> i64 {
        self.sql().query_row("SELECT MAX(seq) FROM journal", [], |r| r.get(0)).unwrap()
    }
    /// A second connection, as another process (or a failing disk) sees the file.
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.path().join("workspace.sqlite")).unwrap()
    }
    /// Item writes of Agent `id` fail (`refuse`), until `allow`.
    fn refuse_items_of(&self, id: &str) {
        self.sql().execute_batch(&format!("
            CREATE TRIGGER refuse_insert BEFORE INSERT ON agent_items WHEN NEW.agent_id='{id}' BEGIN SELECT RAISE(ABORT,'disk full'); END;
            CREATE TRIGGER refuse_update BEFORE UPDATE ON agent_items WHEN NEW.agent_id='{id}' BEGIN SELECT RAISE(ABORT,'disk full'); END;")).unwrap();
    }
    fn allow(&self) {
        self.sql().execute_batch("DROP TRIGGER refuse_insert; DROP TRIGGER refuse_update;").unwrap();
    }
    /// A native event, routed as Codex and Claude events are.
    fn stream(&self, id: &str, kind: &str, data: &Value) -> Streamed {
        self.store().record_stream(id, route(kind, data), kind, data).unwrap()
    }
    fn delta(&self, text: &str) { self.delta_to("a", text); }
    fn delta_to(&self, id: &str, text: &str) {
        let p = json!({"turnId":"t","itemId":"reply","delta":text});
        assert!(!self.stream(id, "item/agentMessage/delta", &p).urgent);
    }
    /// Journaled completed content: the whole reply Item.
    fn complete(&self, text: &str) { self.complete_to("a", text); }
    fn complete_to(&self, id: &str, text: &str) {
        let p = json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":text}});
        assert!(!self.stream(id, "item/completed", &p).urgent);
    }
    fn start_reply(&self) {
        let p = json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":""}});
        assert!(!self.stream("a", "item/started", &p).urgent);
    }
    /// Another Agent like "a".
    fn add(&self, id: &str) {
        let mut d = detail();
        d.agent.id = id.into();
        self.store().insert(&d).unwrap();
    }
}

fn reply(d: &AgentDetail) -> Value {
    d.turns.iter().rev().flat_map(|t| t["items"].as_array().into_iter().flatten()).find(|i| i["id"] == "reply")
        .map(|i| i["text"].clone()).unwrap_or(Value::Null)
}

fn turn_ids(d: &AgentDetail) -> Vec<String> {
    d.turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect()
}

fn claude(event: Value) -> Value {
    json!({"type":"event","turnId":"t","event":event})
}

#[test]
fn each_native_event_takes_one_route_and_unknown_kinds_never_rewrite_records() {
    let none = json!({});
    let codex = |kinds: &[&str], expected: Route| for kind in kinds {
        assert_eq!(route(kind, &none), expected, "{kind}");
    };
    codex(&["item/agentMessage/delta", "item/commandExecution/outputDelta", "item/reasoning/summaryTextDelta",
            "item/plan/delta", "item/reasoning/summaryPartAdded"], Route::Ephemeral);
    // Streaming output nothing in the record keeps.
    codex(&["turn/diff/updated", "item/fileChange/outputDelta", "item/reasoning/textDelta"], Route::Ignored);
    codex(&["item/started", "item/completed", "turn/plan/updated", "thread/tokenUsage/updated"], Route::Deferred);
    // Kept as evidence, the record untouched; a kind Core does not know yet
    // is one of these, never a full rewrite.
    codex(&["hook/started", "hook/completed", "account/rateLimits/updated", "item/autoApprovalReview/started",
            "item/autoApprovalReview/completed", "guardianWarning", "warning", "deprecationNotice",
            "item/commandExecution/terminalInteraction", "thread/goal/cleared", "item/mcpToolCall/progress",
            "someFuture/notification"], Route::Evidence);
    // Turn boundaries, request resolution, errors, status, compaction,
    // the thread's start and MCP server connection status.
    codex(&["turn/started", "turn/completed", "serverRequest/resolved", "error", "thread/status/changed",
            "thread/started", "thread/compacted", "mcpServer/startupStatus/updated"], Route::Synchronous);
    let sdk = |events: &[Value], expected: Route| for event in events {
        let kind = format!("claude/{}", event["type"].as_str().unwrap());
        assert_eq!(route(&kind, &claude(event.clone())), expected, "{event}");
    };
    sdk(&[json!({"type":"stream_event","event":{"type":"content_block_delta"}})], Route::Ephemeral);
    sdk(&[json!({"type":"system","subtype":"thinking_tokens","estimated_tokens":12}),
          json!({"type":"stream_event","parent_tool_use_id":"agent","event":{"type":"content_block_delta"}})], Route::Ignored);
    // A sub-agent's task events keep its Agent call current (T-26).
    sdk(&[json!({"type":"assistant","message":{"id":"m"}}), json!({"type":"user","message":{}}),
          json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}),
          json!({"type":"system","subtype":"task_started"}), json!({"type":"system","subtype":"task_progress"}),
          json!({"type":"system","subtype":"task_updated"}), json!({"type":"system","subtype":"task_notification"})], Route::Deferred);
    sdk(&[json!({"type":"system","subtype":"status","status":"requesting"}),
          json!({"type":"system","subtype":"hook_response"}), json!({"type":"system","subtype":"background_tasks_changed"}),
          json!({"type":"tool_progress","tool_use_id":"tool"}), json!({"type":"command_lifecycle","state":"queued"}),
          json!({"type":"auth_status"})], Route::Evidence);
    sdk(&[json!({"type":"result","is_error":false}), json!({"type":"system","subtype":"init","model":"opus"}),
          json!({"type":"system","subtype":"compact_boundary"}),
          json!({"type":"system","subtype":"status","permissionMode":"plan"})], Route::Synchronous);
}

#[test]
fn kinds_kept_as_evidence_change_nothing_apply_would_keep() {
    let mut codex = detail();
    codex.turns[0]["items"] = json!([{"id":"reply","type":"agentMessage","text":"x","_yuzunoCompletedText":"x"}]);
    for kind in ["hook/started", "account/rateLimits/updated", "guardianWarning", "turn/diff/updated",
                 "item/fileChange/outputDelta", "item/mcpToolCall/progress"] {
        let mut applied = codex.clone();
        applied.apply(kind, &json!({"turnId":"t","itemId":"reply","delta":"y","run":{"id":"h"}}));
        applied.agent.updated_at = codex.agent.updated_at.clone();
        assert_eq!(serde_json::to_value(&applied).unwrap(), serde_json::to_value(&codex).unwrap(), "{kind}");
    }
}

#[test]
fn deltas_are_visible_and_announced_at_once_and_written_on_the_cadence_never_journaled() {
    let lab = Lab::new();
    for word in ["Hello ", "streamed ", "world"] { lab.delta(word); }
    assert_eq!(lab.journal("item/agentMessage/delta"), 0);
    // In memory at once; the rows wait for the stream cadence.
    assert_eq!(lab.held("a"), "Hello streamed world");
    assert_eq!(reply(&lab.row()), Value::Null);
    // Announced once for the three deltas, and written once due.
    assert_eq!(lab.store().stream_tick(Duration::from_secs(60)).announce, vec!["a".to_string()]);
    assert_eq!(reply(&lab.row()), Value::Null);
    assert!(lab.store().stream_tick(Duration::ZERO).announce.is_empty());
    let row = lab.row();
    assert_eq!(reply(&row), "Hello streamed world");
    assert_eq!(row.agent.last_seq, 0);
    // A reader of the rows has what is held written first.
    lab.delta("!");
    assert_eq!(reply(&lab.store().view("a", Sel::Open).unwrap()), "Hello streamed world!");
    assert_eq!(reply(&lab.row()), "Hello streamed world!");
    assert_eq!(lab.journal("item/agentMessage/delta"), 0);
}

#[test]
fn completed_content_is_journaled_and_written_at_once_with_the_text_streamed_before_it() {
    let lab = Lab::new();
    lab.start_reply();
    lab.delta("Hello");
    assert_eq!(reply(&lab.row()), "");
    lab.complete("Hello world");
    assert_eq!((lab.journal("item/started"), lab.journal("item/completed")), (1, 1));
    let row = lab.row();
    assert_eq!(reply(&row), "Hello world");
    assert_eq!(row.agent.last_seq, lab.top());
    assert_eq!(lab.held("a"), "Hello world");
    // Nothing waits for the cadence; it is announced on it.
    assert!(lab.store().held_agents().iter().all(|held| !held.unwritten));
    assert_eq!(lab.store().stream_tick(Duration::ZERO).announce, vec!["a".to_string()]);
}

#[test]
fn a_completed_item_replaces_the_partial_text_written_before_it() {
    let lab = Lab::new();
    lab.start_reply();
    lab.delta("Hel");
    assert!(lab.store().stream_tick(Duration::ZERO).failed.is_empty());
    assert_eq!(reply(&lab.row()), "Hel");
    lab.delta("lo");
    lab.complete("Hello world");
    // A kill now leaves the completed Item, once.
    let killed = lab.killed();
    let restored = Store::open(&killed.path().join("workspace.sqlite")).unwrap().detail("a").unwrap();
    for d in [&lab.row(), &restored] {
        assert_eq!(reply(d), "Hello world");
        assert_eq!(d.turns[0]["items"].as_array().unwrap().iter().filter(|i| i["id"] == "reply").count(), 1);
    }
}

#[test]
fn a_completed_claude_message_replaces_the_partial_text_written_before_it() {
    let lab = Lab::new();
    let mut c = detail();
    c.agent.id = "c".into();
    c.agent.harness = "claude".into();
    lab.store().insert(&c).unwrap();
    let stream = |event: Value| lab.stream("c", "claude/stream_event", &claude(json!({"type":"stream_event","event":event})));
    stream(json!({"type":"message_start","message":{"id":"m"}}));
    stream(json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}));
    // The thinking block completes (journaled) while its text streams on.
    lab.stream("c", "claude/assistant", &claude(json!({"type":"assistant","uuid":"b0",
        "message":{"id":"m","content":[{"type":"thinking","thinking":"Plan it."}]}})));
    stream(json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}));
    assert!(lab.store().stream_tick(Duration::ZERO).failed.is_empty());
    stream(json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}));
    lab.stream("c", "claude/assistant", &claude(json!({"type":"assistant","uuid":"b1",
        "message":{"id":"m","content":[{"type":"text","text":"Hello"}]}})));
    let live = lab.store().detail("c").unwrap();
    let killed = lab.killed();
    let restored = Store::open(&killed.path().join("workspace.sqlite")).unwrap().detail("c").unwrap();
    for d in [&live, &lab.row_of("c"), &restored] {
        let items = d.turns[0]["items"].as_array().unwrap();
        assert_eq!(items.iter().filter(|i| i["id"] == "m").count(), 1);
        assert_eq!(items.iter().find(|i| i["id"] == "m").unwrap()["text"], "Hello");
        assert_eq!(items.iter().find(|i| i["id"] == "m:thinking").unwrap()["summary"], json!(["Plan it."]));
    }
}

#[test]
fn evidence_is_journaled_without_loading_or_writing_the_record() {
    let lab = Lab::new();
    let codex = json!({"run":{"id":"stop:7","eventName":"stop","status":"running"},"threadId":"thread","turnId":"t"});
    for kind in ["hook/started", "hook/completed", "account/rateLimits/updated", "turn/diff/updated", "guardianWarning",
                 "item/mcpToolCall/progress"] {
        assert_eq!(lab.stream("a", kind, &codex), Streamed::default(), "{kind}");
    }
    let thinking = claude(json!({"type":"system","subtype":"thinking_tokens","estimated_tokens":3}));
    assert_eq!(lab.stream("a", "claude/system", &thinking), Streamed::default());
    // Journaled (but the diff and thinking counts); nothing parsed or held,
    // the row untouched, and nothing to announce.
    assert_eq!((lab.journal("hook/started"), lab.journal("item/mcpToolCall/progress"), lab.journal("turn/diff/updated"),
                lab.journal("claude/system")), (1, 1, 0, 0));
    assert_eq!(lab.store().streamed_records(), 0);
    assert_eq!(lab.row().agent.last_seq, 0);
    assert!(lab.store().stream_tick(Duration::from_secs(60)).announce.is_empty());
    let detail = lab.store().detail("a").unwrap();
    assert_eq!((detail.agent.status.as_str(), detail.pending.len(), detail.agent.unread_count), ("working", 0, 0));
    // Nor does evidence write held output early.
    lab.delta("x");
    lab.stream("a", "hook/completed", &codex);
    assert!(lab.store().stream_tick(Duration::from_secs(60)).failed.is_empty());
    assert_eq!(reply(&lab.row()), Value::Null);
}

#[test]
fn a_streamed_event_that_changes_status_or_turns_is_journaled_written_and_announced_at_once() {
    let lab = Lab::new();
    lab.delta("text");
    // An Item of a Turn Core never saw start creates that Turn.
    let item = json!({"turnId":"t2","item":{"id":"cmd","type":"commandExecution","command":"ls"}});
    assert!(lab.stream("a", "item/started", &item).urgent);
    let row = lab.row();
    assert!(row.turns.iter().any(|t| t["id"] == "t2" && t["status"] == "inProgress"));
    assert_eq!(row.agent.last_seq, lab.top());
    // So does a delta: streamed output, but the new Turn must survive a
    // crash, so this one is journaled and written with it.
    let delta = json!({"turnId":"t3","itemId":"later","delta":"more"});
    assert!(lab.stream("a", "item/agentMessage/delta", &delta).urgent);
    assert_eq!(lab.journal("item/agentMessage/delta"), 1);
    let row = lab.row();
    assert!(row.turns.iter().any(|t| t["id"] == "t3" && t["status"] == "inProgress"));
    assert_eq!(row.agent.last_seq, lab.top());
    // Claude output from another session is refused and marks the Agent.
    for (id, kind, event) in [
        ("c", "claude/assistant", json!({"type":"assistant","session_id":"other","message":{"id":"m","content":[]}})),
        ("d", "claude/stream_event", json!({"type":"stream_event","session_id":"other","event":{"type":"message_start","message":{"id":"m"}}})),
    ] {
        let mut agent = detail();
        agent.agent.id = id.into();
        agent.agent.harness = "claude".into();
        agent.agent.claude_session_id = Some("session".into());
        lab.store().insert(&agent).unwrap();
        assert!(lab.stream(id, kind, &claude(event)).urgent, "{kind}");
        assert_eq!(lab.row_of(id).agent.status, "uncertain", "{kind}");
        assert_eq!(lab.store().agent(id).unwrap().status, "uncertain", "{kind}");
    }
    assert_eq!(lab.journal("claude/stream_event"), 1);
}

#[test]
fn an_unused_thread_can_be_replaced_while_its_record_is_held() {
    let lab = Lab::new();
    let mut fresh = detail();
    fresh.agent.id = "fresh".into();
    fresh.agent.status = "offline".into();
    fresh.turns.clear();
    lab.store().insert(&fresh).unwrap();
    let birth = json!({"threadId":"thread","newEmptyThread":true,"turnRequestJournalVersion":1});
    lab.store().update("fresh", "thread/attached", &birth, |_| {}).unwrap();
    // Thread-level notices before any Turn: evidence, and a usage report
    // that holds the record in memory. Neither is use of the thread.
    lab.stream("fresh", "account/rateLimits/updated", &json!({"rateLimits":{}}));
    lab.stream("fresh", "thread/tokenUsage/updated", &json!({"threadId":"thread","tokenUsage":{}}));
    assert_eq!(lab.store().streamed_records(), 1);
    assert!(lab.store().begin_empty_thread_replacement("fresh", "thread").unwrap());
    assert_eq!(lab.store().detail("fresh").unwrap().agent.status, "uncertain");
    assert_eq!(lab.row_of("fresh").agent.status, "uncertain");
    // Streamed output is use, even before anything about it was journaled.
    let mut used = fresh.clone();
    used.agent.id = "used".into();
    lab.store().insert(&used).unwrap();
    lab.store().update("used", "thread/attached", &birth, |_| {}).unwrap();
    // (it creates the Turn, so it is journaled at once, see above)
    lab.stream("used", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":"hello"}));
    assert!(!lab.store().begin_empty_thread_replacement("used", "thread").unwrap());
}

#[test]
fn the_next_full_event_writes_held_content_with_it() {
    let lab = Lab::new();
    lab.start_reply();
    lab.delta("Partial ");
    lab.delta("answer");
    let request = json!({"turnId":"t","itemId":"cmd","command":"rm -rf build"});
    lab.store().update("a", "request", &request, |d| {
        d.pending.push(serde_json::from_value(json!({"id":"p","agentId":"a","method":"item/commandExecution/requestApproval",
            "params":request,"createdAt":"now"})).unwrap());
        d.agent.status = "waiting".into();
    }).unwrap();
    // Requests are never deferred, and the content before them is not lost.
    let row = lab.row();
    assert_eq!(row.pending.len(), 1);
    assert_eq!(row.agent.status, "waiting");
    assert_eq!(reply(&row), "Partial answer");
    assert_eq!(row.agent.unread_count, 1);
    lab.delta(" continues");
    lab.complete("Partial answer continues");
    let completed = json!({"turn":{"id":"t","status":"completed","items":[]}});
    lab.store().update("a", "turn/completed", &completed, |d| d.apply("turn/completed", &completed)).unwrap();
    let row = lab.row();
    assert_eq!(row.turns[0]["status"], "completed");
    assert_eq!(reply(&row), "Partial answer continues");
}

#[test]
fn a_streaming_record_stays_in_memory_after_a_full_event() {
    let lab = Lab::new();
    lab.delta("before ");
    lab.store().record_event("a", "thread/status/changed", &json!({"status":{"type":"active"}}), Sel::Meta, |_| {}).unwrap();
    assert_eq!(lab.store().streamed_records(), 1);
    // A change of the metadata alone writes the held output first.
    assert_eq!(reply(&lab.row()), "before ");
    // Proof the next delta reads no row: the reply's no longer parses.
    let item: String = lab.sql().query_row("SELECT data FROM agent_items WHERE agent_id='a' AND item_id='reply'", [], |r| r.get(0)).unwrap();
    lab.sql().execute("UPDATE agent_items SET data='not json' WHERE agent_id='a' AND item_id='reply'", []).unwrap();
    lab.delta("after");
    assert_eq!(lab.held("a"), "before after");
    lab.sql().execute("UPDATE agent_items SET data=?1 WHERE agent_id='a' AND item_id='reply'", [&item]).unwrap();
    assert!(lab.store().flush().failed.is_empty());
    assert_eq!(reply(&lab.row()), "before after");
}

#[test]
fn every_change_takes_a_rev_and_snapshots_compare_against_it() {
    let lab = Lab::new();
    lab.start_reply();
    let started = lab.store().rev("a");
    assert!(started > 0);
    assert_eq!(lab.store().detail("a").unwrap().agent.rev, started);
    // A snapshot requested now: nothing is newer yet.
    assert_eq!(lab.store().changed_items_since("a", started).unwrap().newer, false);
    // Streamed output has no journal seq but takes a rev.
    lab.delta("live");
    let streamed = lab.store().rev("a");
    assert!(streamed > started);
    assert_eq!(lab.store().detail("a").unwrap().agent.last_seq, lab.top());
    assert_eq!(lab.store().agents().unwrap()[0].rev, streamed);
    let since = lab.store().changed_items_since("a", started).unwrap();
    assert!(since.newer && since.complete);
    assert_eq!(since.items, ["reply".to_string()].into());
    // Output streamed before the request is not newer than it.
    assert_eq!(lab.store().changed_items_since("a", streamed).unwrap().newer, false);
    // Reading changes the rev but is no event.
    let seen = lab.store().detail("a").unwrap().agent.last_seq;
    assert!(lab.store().review("a", seen).unwrap());
    assert!(lab.store().rev("a") > streamed);
    assert_eq!(lab.store().changed_items_since("a", streamed).unwrap().newer, false);
    // The evidence outlives the record in memory (released, evicted, or
    // dropped by a failed write).
    for n in 0..MAX_STREAMS {
        lab.add(&format!("other-{n}"));
        lab.delta_to(&format!("other-{n}"), "x");
    }
    assert!(lab.store().streamed_records() <= MAX_STREAMS);
    assert!(lab.store().changed_items_since("a", started).unwrap().items.contains("reply"));
    assert_eq!(lab.store().detail("a").unwrap().agent.rev, lab.store().rev("a"));
}

#[test]
fn item_evidence_is_bounded_and_says_when_it_no_longer_reaches_back() {
    let lab = Lab::new();
    let early = lab.store().rev("a");
    for n in 0..300 {
        let p = json!({"turnId":"t","itemId":format!("item-{n}"),"delta":"x"});
        lab.stream("a", "item/agentMessage/delta", &p);
    }
    let since = lab.store().changed_items_since("a", early).unwrap();
    assert!(since.newer && !since.complete);
    assert!(since.items.len() <= 256);
    assert!(since.items.contains("item-299"));
    let recent = lab.store().rev("a") - 10;
    let since = lab.store().changed_items_since("a", recent).unwrap();
    assert!(since.complete);
    assert_eq!(since.items.len(), 10);
}

#[test]
fn reading_while_text_streams_marks_the_streamed_copy() {
    let lab = Lab::new();
    lab.start_reply();
    lab.delta("one");
    let seen = lab.top();
    assert!(lab.store().review("a", seen).unwrap());
    assert!(!lab.store().review("a", seen).unwrap());
    // The read mark is written at once, the streamed text on the cadence.
    assert_eq!(lab.journal("workspace/reviewed"), 1);
    let row = lab.row();
    assert_eq!((row.agent.reviewed_seq, reply(&row)), (seen, Value::from("")));
    assert_eq!(lab.store().agent("a").unwrap().reviewed_seq, seen);
    assert_eq!(lab.store().peek("a", |d| d.agent.reviewed_seq), Some(seen));
    assert!(lab.store().stream_tick(Duration::ZERO).failed.is_empty());
    let row = lab.row();
    assert_eq!((row.agent.reviewed_seq, reply(&row)), (seen, Value::from("one")));
}

#[test]
fn closing_the_store_writes_held_content() {
    let mut lab = Lab::new();
    lab.complete("kept on close");
    lab.delta(" and streamed");
    drop(lab.store.take());
    assert_eq!(reply(&lab.row()), "kept on close and streamed");
    let store = Store::open(&lab.dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(reply(&store.detail("a").unwrap()), "kept on close and streamed");
}

#[test]
fn after_a_kill_written_content_and_read_marks_survive_and_partial_text_may_not() {
    let lab = Lab::new();
    lab.complete("Before");
    let command = json!({"turnId":"t","item":{"id":"cmd","type":"commandExecution","command":"ls","aggregatedOutput":"a.rs",
        "status":"completed"}});
    lab.stream("a", "item/completed", &command);
    let seen = lab.top();
    assert!(lab.store().review("a", seen).unwrap());
    lab.delta(" partial");
    let top = lab.top();
    let killed = lab.killed();
    let path = killed.path().join("workspace.sqlite");
    // The journal is no record: an event only there is not replayed.
    rusqlite::Connection::open(&path).unwrap().execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a','item/completed',?1,'2026-10-13T20:00:01.5+00:00')",
        [json!({"turnId":"t","item":{"id":"lost","type":"agentMessage","text":"journal only"}}).to_string()]).unwrap();
    let store = Store::open(&path).unwrap();
    let detail = store.detail("a").unwrap();
    let items = detail.turns[0]["items"].as_array().unwrap();
    assert_eq!(reply(&detail), "Before");
    assert_eq!(detail.agent.reviewed_seq, seen);
    assert!(items.iter().any(|i| i["id"] == "cmd" && i["aggregatedOutput"] == "a.rs"));
    assert!(!items.iter().any(|i| i["id"] == "lost"));
    assert_eq!(items.iter().filter(|i| i["id"] == "reply").count(), 1);
    // Opening marks the open Agent restarted, after every journaled event.
    assert_eq!(detail.agent.status, "offline");
    assert!(detail.agent.last_seq > top);
}

#[test]
fn a_failed_write_keeps_no_half_applied_copy_and_a_retry_applies_once() {
    let lab = Lab::new();
    lab.complete("kept");
    lab.sql().execute_batch("CREATE TRIGGER refuse BEFORE INSERT ON journal WHEN NEW.data LIKE '%lost%' OR NEW.kind='boom'
        BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    // An event whose journal write fails changes nothing, in memory or rows.
    let p = json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":"kept lost"}});
    assert!(lab.store().record_stream("a", Route::Deferred, "item/completed", &p).is_err());
    assert_eq!((lab.held("a"), reply(&lab.row())), (Value::from("kept"), Value::from("kept")));
    // Nor does a full event that fails.
    assert!(lab.store().update("a", "boom", &json!({}), |d| d.agent.status = "broken".into()).is_err());
    let detail = lab.store().detail("a").unwrap();
    assert_eq!((reply(&detail), detail.agent.status.as_str()), (Value::from("kept"), "working"));
    assert_eq!(lab.store().peek("a", |d| d.agent.status.clone()).as_deref(), Some("working"));
    lab.sql().execute_batch("DROP TRIGGER refuse;").unwrap();
    lab.complete("kept once");
    lab.store().update("a", "item/started", &json!({}), |_| {}).unwrap();
    assert_eq!(reply(&lab.row()), "kept once");
}

#[test]
fn a_failed_write_of_streamed_output_keeps_it_for_the_next_tick() {
    let lab = Lab::new();
    lab.delta("waiting");
    lab.refuse_items_of("a");
    assert_eq!(lab.store().stream_tick(Duration::ZERO).failed.len(), 1);
    assert_eq!(lab.held("a"), "waiting");
    lab.allow();
    assert!(lab.store().stream_tick(Duration::ZERO).failed.is_empty());
    assert_eq!(reply(&lab.row()), "waiting");
}

#[test]
fn one_record_that_cannot_be_written_holds_back_no_other_agent() {
    let lab = Lab::new();
    lab.add("b");
    lab.delta("stuck");
    lab.delta_to("b", "flows");
    lab.refuse_items_of("a");
    let tick = lab.store().stream_tick(Duration::ZERO);
    assert_eq!(tick.failed.len(), 1);
    // The other Agent is written and both are still announced.
    let mut announced = tick.announce;
    announced.sort();
    assert_eq!(announced, ["a", "b"]);
    assert_eq!(reply(&lab.row_of("b")), "flows");
    assert_eq!(lab.held("a"), "stuck");
    lab.delta_to("b", " on");
    assert_eq!(lab.store().stream_tick(Duration::ZERO).announce, vec!["b".to_string()]);
    lab.allow();
    assert!(lab.store().stream_tick(Duration::ZERO).failed.is_empty());
    assert_eq!(reply(&lab.row()), "stuck");
}

#[test]
fn memory_holds_a_bounded_number_of_streamed_records() {
    let lab = Lab::new();
    let ids: Vec<String> = (0..MAX_STREAMS + 2).map(|n| format!("agent-{n}")).collect();
    for id in &ids {
        lab.add(id);
        lab.delta_to(id, &format!("text of {id}"));
        assert!(lab.store().streamed_records() <= MAX_STREAMS);
    }
    // The ones dropped from memory were written first, streamed text and
    // all, so nothing vanishes from view; each is still announced once.
    let mut announced = lab.store().stream_tick(Duration::from_secs(60)).announce;
    announced.sort();
    let mut expected = ids.clone();
    expected.sort();
    assert_eq!(announced, expected);
    for id in &ids {
        assert_eq!(reply(&lab.store().detail(id).unwrap()), format!("text of {id}"));
    }
    assert_eq!(reply(&lab.row_of("agent-0")), "text of agent-0");
}

#[test]
fn a_record_that_cannot_be_evicted_holds_back_no_other_agent() {
    let lab = Lab::new();
    let ids: Vec<String> = (0..MAX_STREAMS).map(|n| format!("agent-{n}")).collect();
    for id in &ids {
        lab.add(id);
        lab.delta_to(id, "x");
    }
    lab.refuse_items_of("agent-0");
    // The least recently streamed record cannot be written to make room:
    // it stays held, and the next Agent's event is still recorded.
    lab.add("late");
    lab.complete_to("late", "recorded");
    assert_eq!(lab.store().streamed_records(), MAX_STREAMS + 1);
    assert_eq!(reply(&lab.row_of("late")), "recorded");
    assert_eq!(lab.held("agent-0"), "x");
    lab.allow();
    assert!(lab.store().flush().failed.is_empty());
    assert_eq!(reply(&lab.row_of("agent-0")), "x");
}

#[test]
fn an_active_agent_holds_its_open_and_newest_turns_and_what_it_just_wrote() {
    let lab = Lab::new();
    let mut long = detail();
    long.agent.id = "long".into();
    long.turns = (0..200).map(|n| json!({"id":format!("old-{n}"),"status":"completed",
        "items":[{"id":format!("r-{n}"),"type":"agentMessage","text":"x".repeat(1000)}]})).collect();
    long.turns.push(json!({"id":"t","status":"inProgress","items":[]}));
    lab.store().insert(&long).unwrap();
    let held = || lab.store().peek("long", turn_ids).unwrap();
    lab.delta_to("long", "streamed");
    assert_eq!(held(), ["t"]);
    // An event about an older Turn reads that Turn alone, and memory keeps it
    // only until the next write.
    let old = json!({"turnId":"old-5","item":{"id":"r-5","type":"agentMessage","text":"edited"}});
    lab.stream("long", "item/completed", &old);
    assert_eq!(held(), ["old-5", "t"]);
    lab.complete_to("long", "done");
    assert_eq!(held(), ["t"]);
    let row = lab.row_of("long");
    assert_eq!(row.turns.len(), 201);
    assert_eq!(row.turns[5]["items"][0]["text"], "edited");
    assert_eq!(row.turns[4]["items"][0]["text"], "x".repeat(1000));
    assert_eq!(reply(&row), "done");
}

#[test]
fn listed_agents_follow_every_write_without_parsing_records() {
    let lab = Lab::new();
    lab.complete("x");
    let listed = lab.store().agents().unwrap();
    assert_eq!(listed[0].last_seq, lab.store().detail("a").unwrap().agent.last_seq);
    assert_eq!(listed[0].last_message.as_deref(), Some("x"));
    lab.complete("xy");
    assert_eq!(lab.store().agents().unwrap()[0].last_seq, lab.store().detail("a").unwrap().agent.last_seq);
    lab.store().update("a", "agent/closed", &json!({}), |d| d.agent.closed_at = Some("now".into())).unwrap();
    assert!(lab.store().agent("a").unwrap().closed_at.is_some());
    assert_eq!(lab.store().binding("a").unwrap(), (true, Some("thread".into())));
    assert_eq!(reply(&lab.row()), "xy");
    lab.store().delete_closed_agent("a").unwrap();
    assert!(lab.store().agents().unwrap().is_empty());
    assert!(lab.store().agent("a").is_err());
}
