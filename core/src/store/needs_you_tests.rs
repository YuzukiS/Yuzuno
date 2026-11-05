//! T-42: what waits on the user and how a Turn last ended, as the Agent
//! summary says them. Open asynchronous questions count in `pending_count`
//! beside the native requests, without holding the Agent; `last_turn_end`
//! is the last Turn that ended finished or failed.
use super::tests::{detail, lab, stream};
use super::*;

fn question(id: &str, status: &str) -> Value {
    json!({"id":id,"type":"agentMessage","delivery":"async","status":status,"text":"Which one?",
        "questions":[{"title":format!("Choose {id}"),"options":["A","B"]}]})
}

fn listed(store: &Store, id: &str) -> Agent {
    store.agents().unwrap().into_iter().find(|a| a.id == id).unwrap()
}

fn counts(store: &Store, id: &str) -> (u64, u64, u64) {
    let agent = listed(store, id);
    (agent.pending_count, agent.open_questions, agent.native_requests())
}

fn answer(store: &Store, id: &str, client: &str, item: &str, status: &str) {
    let receipt: MessageReceipt = serde_json::from_value(json!({"input":{"clientMessageId":client,"text":"A",
        "question":{"turnId":"t","itemId":item}},"status":status,"turnId":"t"})).unwrap();
    store.update(id, "message/receipt", &json!({}), |d| d.message_receipts.push(receipt)).unwrap();
}

#[test]
fn open_async_questions_count_beside_requests_until_answered() {
    let (dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    for item in [question("q1", "completed"), question("q2", "completed"), question("q3", "cancelled")] {
        stream(&store, "a", "item/completed", &json!({"threadId":"thread","turnId":"t","item":item}));
    }
    // Two are open; the cancelled one is not. None of them is a native request.
    assert_eq!(counts(&store, "a"), (2, 2, 0));
    let open = store.open_questions("a").unwrap();
    assert_eq!(open.iter().map(|q| q.item_id.as_str()).collect::<Vec<_>>(), ["q1", "q2"]);
    assert_eq!(open[0].title.as_deref(), Some("Choose q1"));
    assert!(open[0].at_ms.is_some());
    // An answer still being sent leaves it open; an accepted one closes it.
    answer(&store, "a", "send-1", "q1", "sending");
    assert_eq!(counts(&store, "a"), (2, 2, 0));
    answer(&store, "a", "send-2", "q1", "accepted");
    assert_eq!(counts(&store, "a"), (1, 1, 0));
    // A request waits beside the question.
    store.update("a", "test/pending", &json!({}), |d| d.pending.push(PendingRequest { id: "r1".into(), agent_id: "a".into(),
        method: "item/commandExecution/requestApproval".into(), params: json!({}), created_at: now(), stale: false })).unwrap();
    assert_eq!(counts(&store, "a"), (2, 1, 1));
    // A restart reads them from the rows again.
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(counts(&store, "a"), (2, 1, 1));
}

#[test]
fn an_imported_question_with_no_answer_sent_here_is_not_open() {
    let (_dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    {
        let db = store.db.write().unwrap();
        db.execute("INSERT INTO codex_imports(agent_id,thread_id) VALUES('a','thread')", []).unwrap();
        db.execute("INSERT INTO codex_import_turns(agent_id,turn_id) VALUES('a','t')", []).unwrap();
    }
    stream(&store, "a", "item/completed", &json!({"threadId":"thread","turnId":"t","item":question("old", "completed")}));
    assert_eq!(counts(&store, "a"), (0, 0, 0));
    // Once an answer is sent from here it is open again until accepted.
    answer(&store, "a", "send-1", "old", "sending");
    assert_eq!(counts(&store, "a"), (1, 1, 0));
}

/// How many times this thread has read the open questions.
fn reads() -> usize {
    record_rows::OPEN_QUESTION_READS.with(std::cell::Cell::get)
}

#[test]
fn only_a_question_an_answer_or_a_deletion_reads_the_open_questions_again() {
    // Review 7727a352: the read is two correlated subqueries over the
    // receipts, in the write transaction of every event that ran it.
    let (_dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    let message = |id: &str, text: &str| json!({"id":id,"type":"agentMessage","text":text});
    let from = reads();
    stream(&store, "a", "item/started", &json!({"threadId":"thread","turnId":"t","item":message("m1", "")}));
    stream(&store, "a", "item/agentMessage/delta", &json!({"threadId":"thread","turnId":"t","itemId":"m1","delta":"Hello"}));
    stream(&store, "a", "item/completed", &json!({"threadId":"thread","turnId":"t","item":message("m1", "Hello")}));
    store.update("a", "test/pending", &json!({}), |d| d.pending.push(PendingRequest { id: "r1".into(), agent_id: "a".into(),
        method: "item/commandExecution/requestApproval".into(), params: json!({}), created_at: now(), stale: false })).unwrap();
    let plain: MessageReceipt = serde_json::from_value(json!({"input":{"clientMessageId":"send-0","text":"go on"},
        "status":"accepted","turnId":"t"})).unwrap();
    store.update("a", "message/receipt", &json!({}), |d| d.message_receipts.push(plain)).unwrap();
    assert_eq!(reads(), from, "no question, answer or deletion: not read");
    assert_eq!(counts(&store, "a"), (1, 0, 1));
    // A question is read; a message beside it is not.
    stream(&store, "a", "item/completed", &json!({"threadId":"thread","turnId":"t","item":question("q1", "completed")}));
    assert_eq!(reads(), from + 1);
    assert_eq!(counts(&store, "a"), (2, 1, 1));
    stream(&store, "a", "item/completed", &json!({"threadId":"thread","turnId":"t","item":message("m2", "More")}));
    assert_eq!(reads(), from + 1);
    // So is the answer to it.
    answer(&store, "a", "send-1", "q1", "accepted");
    assert_eq!(reads(), from + 2);
    assert_eq!(counts(&store, "a"), (1, 0, 1));
    // And a Turn removed, which may have held one.
    store.update("a", "test/remove", &json!({}), |d| d.turns.retain(|t| t["id"] != "t")).unwrap();
    assert_eq!(reads(), from + 3);
}

#[test]
fn a_stream_event_that_opens_or_closes_a_question_is_written_and_announced_at_once() {
    // Review 9392d7c2: a write was urgent only for what `Watched` sees (the
    // native requests among it), so a question reached Needs you, the
    // title and the attention order with the next tick.
    let (_dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    let event = |item: Value| json!({"threadId":"thread","turnId":"t","item":item});
    let message = json!({"id":"m1","type":"agentMessage","text":"Hello"});
    assert!(!stream(&store, "a", "item/completed", &event(message)).urgent, "a plain message waits for the tick");
    assert!(stream(&store, "a", "item/completed", &event(question("q1", "completed"))).urgent, "a question is announced at once");
    assert_eq!(counts(&store, "a"), (1, 1, 0));
    assert!(stream(&store, "a", "item/completed", &event(question("q1", "cancelled"))).urgent, "so is one no longer asked");
    assert_eq!(counts(&store, "a"), (0, 0, 0));
}

fn end(store: &Store, id: &str, turn: &str, status: &str) {
    let data = json!({"threadId":"thread","turn":{"id":turn,"status":status}});
    store.record_event_turns(id, "turn/completed", &data, |d| {
        let ended = d.turns.iter_mut().find(|t| t["id"] == turn).unwrap();
        ended["status"] = json!(status);
    }).unwrap();
}

fn start(store: &Store, id: &str, turn: &str) {
    store.record_event_turns(id, "turn/started", &json!({"turn":{"id":turn,"status":"inProgress"}}),
        |d| d.turns.push(json!({"id":turn,"status":"inProgress","items":[]}))).unwrap();
}

#[test]
fn the_last_turn_end_is_the_last_finished_or_failed_one() {
    let (dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    assert_eq!(listed(&store, "a").last_turn_end, None);
    end(&store, "a", "t", "completed");
    let first = listed(&store, "a");
    let finished = first.last_turn_end.clone().unwrap();
    assert_eq!((finished.outcome.as_str(), finished.seq), ("finished", first.last_seq), "{finished:?}");
    start(&store, "a", "t2");
    end(&store, "a", "t2", "failed");
    let failed = listed(&store, "a").last_turn_end.unwrap();
    assert_eq!(failed.outcome, "failed");
    assert!(failed.seq > finished.seq);
    // An interrupted Turn, and a completion of a Turn already ended, leave it.
    start(&store, "a", "t3");
    end(&store, "a", "t3", "interrupted");
    end(&store, "a", "t2", "failed");
    assert_eq!(listed(&store, "a").last_turn_end.unwrap(), failed);
    // A restart keeps it.
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(listed(&store, "a").last_turn_end.unwrap(), failed);
}

#[test]
fn an_agent_from_before_takes_its_last_turn_end_from_the_journal() {
    let (dir, store) = lab();
    store.insert(&detail("a")).unwrap();
    {
        let db = store.db.write().unwrap();
        for (status, at) in [("completed", "2026-11-01T00:00:00Z"), ("interrupted", "2026-11-02T00:00:00Z")] {
            db.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a','turn/completed',?1,?2)",
                params![json!({"turn":{"id":"t","status":status}}).to_string(), at]).unwrap();
        }
    }
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let end = listed(&store, "a").last_turn_end.unwrap();
    assert_eq!((end.outcome.as_str(), end.at.as_str()), ("finished", "2026-11-01T00:00:00Z"), "{end:?}");
}
