use super::*;
use crate::model::AgentDetail;
use std::sync::{Arc, Barrier};

fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["lead", "dev", "other"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":id,
            "cwd":"/workspace","model":"test","color":"sage","threadId":format!("session-{id}"),
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
        .unwrap();
        store.insert(&agent).unwrap();
    }
    for (request, title) in [("create-1", "First goal"), ("create-2", "Second goal")] {
        store
            .collaboration_call(None, "task_create", json!({"requestId":request,"title":title}))
            .unwrap();
    }
    (dir, store)
}

fn version(store: &Store, task: &str) -> Value {
    store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["version"].clone()
}

/// The lead dispatches `task` to dev and dev reports; returns
/// (resultId, dispatchId, messageId, message seq).
fn reported(store: &Store, task: &str) -> (String, String, String, i64) {
    let dispatched = store
        .collaboration_call(Some("lead"), "task_dispatch", json!({"requestId":format!("dispatch-{task}"),
            "taskId":task,"expectedVersion":version(store, task),"toAgentId":"dev"}))
        .unwrap();
    let dispatch = dispatched["message"]["dispatchId"].as_str().unwrap().to_owned();
    report(store, task, &dispatch, &format!("result-{task}"))
}

fn report(store: &Store, task: &str, dispatch: &str, request: &str) -> (String, String, String, i64) {
    let out = store
        .collaboration_call(Some("dev"), "task_submit_result", json!({"requestId":request,"taskId":task,
            "expectedVersion":version(store, task),"dispatchId":dispatch,"summary":"Ready for review"}))
        .unwrap();
    let message = &out["message"];
    assert_eq!(message["delivery"]["state"], "pending");
    (out["task"]["result"]["id"].as_str().unwrap().to_owned(), dispatch.to_owned(),
        message["id"].as_str().unwrap().to_owned(), message["seq"].as_i64().unwrap())
}

fn ack(store: &Store, actor: Option<&str>, task: &str, result: &str, dispatch: &str, request: &str) -> Result<Value> {
    store.collaboration_call(actor, "task_result_ack",
        json!({"requestId":request,"taskId":task,"resultId":result,"dispatchId":dispatch}))
}

fn delivery(store: &Store, message: &str) -> (String, Value) {
    store.db.read().unwrap().query_row(
        "SELECT delivery_state,delivery_detail FROM collaboration_messages WHERE id=?1", [message],
        |r| Ok((r.get(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap()))).unwrap()
}

fn acks(store: &Store) -> i64 {
    store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM collaboration_result_acks", [], |r| r.get(0)).unwrap()
}

fn lead_batches(store: &Store) -> Vec<Value> {
    store.pending_peer_deliveries().unwrap().into_iter().filter(|b| b["agentId"] == "lead").collect()
}

fn mail_from_other(store: &Store, request: &str) -> i64 {
    store.collaboration_call(Some("other"), "peer_send",
        json!({"requestId":request,"toAgentId":"lead","body":"Unrelated note"}))
        .unwrap()["message"]["seq"].as_i64().unwrap()
}

#[test]
fn only_the_notified_agent_acknowledges_the_exact_result() {
    let (_dir, store) = fixture();
    let (result, dispatch, message, _) = reported(&store, "T-1");
    let (other_result, other_dispatch, _, _) = reported(&store, "T-2");
    let task_before = store.collaboration_call(None, "task_get", json!({"taskId":"T-1"})).unwrap();
    for (actor, task, result, dispatch, code) in [
        (Some("other"), "T-1", result.as_str(), dispatch.as_str(), "result_ack_forbidden:"),
        // The executor reported it; it was not the one notified.
        (Some("dev"), "T-1", result.as_str(), dispatch.as_str(), "result_ack_forbidden:"),
        (None, "T-1", result.as_str(), dispatch.as_str(), "result_ack_forbidden:"),
        (Some("lead"), "T-1", result.as_str(), other_dispatch.as_str(), "result_dispatch_mismatch:"),
        (Some("lead"), "T-1", other_result.as_str(), dispatch.as_str(), "result_not_found:"),
        (Some("lead"), "T-2", result.as_str(), dispatch.as_str(), "result_not_found:"),
        (Some("lead"), "T-1", "missing", dispatch.as_str(), "result_not_found:"),
    ] {
        let error = ack(&store, actor, task, result, dispatch, "refused").unwrap_err().to_string();
        assert!(error.starts_with(code), "{actor:?} {task}: {error}");
    }
    assert_eq!(acks(&store), 0);
    assert_eq!(delivery(&store, &message).0, "pending");
    let done = ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack").unwrap();
    assert_eq!(done["acknowledgment"]["taskId"], "T-1");
    assert_eq!(done["acknowledgment"]["alreadyAcknowledged"], false);
    assert_eq!(done["wakeUp"], json!({"messageId":message,"state":"skipped"}));
    let (state, detail) = delivery(&store, &message);
    assert_eq!((state.as_str(), &detail["reason"]), ("skipped", &json!("result_acknowledged")));
    // The task and its history are untouched; the message stays readable.
    assert_eq!(store.collaboration_call(None, "task_get", json!({"taskId":"T-1"})).unwrap(), task_before);
    let inbox = store.collaboration_call(Some("lead"), "peer_read", json!({})).unwrap();
    let kept = inbox["messages"].as_array().unwrap().iter().find(|m| m["id"] == json!(message)).unwrap();
    assert_eq!(kept["resultId"], json!(result));
    assert_eq!(kept["delivery"]["state"], "skipped");
}

#[test]
fn repeats_are_idempotent_and_the_acknowledgment_survives_restart() {
    let (dir, store) = fixture();
    let (result, dispatch, message, _) = reported(&store, "T-1");
    let (other_result, _, _, _) = reported(&store, "T-2");
    let first = ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack").unwrap();
    assert_eq!(ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack").unwrap(), first);
    let conflict = ack(&store, Some("lead"), "T-1", &other_result, &dispatch, "ack").unwrap_err().to_string();
    assert!(conflict.starts_with("idempotency_conflict:"), "{conflict}");
    let again = ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack-again").unwrap();
    assert_eq!(again["acknowledgment"]["alreadyAcknowledged"], true);
    assert_eq!(again["acknowledgment"]["acknowledgedAt"], first["acknowledgment"]["acknowledgedAt"]);
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    assert_eq!(acks(&store), 1);
    assert_eq!(delivery(&store, &message).0, "skipped");
    assert_eq!(ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack").unwrap(), first);
    let reopened = ack(&store, Some("lead"), "T-1", &result, &dispatch, "after-restart").unwrap();
    assert_eq!(reopened["acknowledgment"]["acknowledgedAt"], first["acknowledgment"]["acknowledgedAt"]);
    // A later result of the same dispatch is a new result with its own wake-up.
    let (revision, _, revised, _) = report(&store, "T-1", &dispatch, "revision");
    assert_ne!(revision, result);
    assert_eq!(delivery(&store, &revised).0, "pending");
    assert_eq!(lead_batches(&store)[0]["messageCount"], 2, "T-1's revision and T-2's result");
}

#[test]
fn reading_task_get_done_and_comments_do_not_acknowledge() {
    let (_dir, store) = fixture();
    let (_, _, message, _) = reported(&store, "T-1");
    store.collaboration_call(Some("lead"), "task_get", json!({"taskId":"T-1"})).unwrap();
    store.collaboration_call(Some("lead"), "task_comment", json!({"requestId":"note","taskId":"T-1","body":"Accepted."})).unwrap();
    store.collaboration_call(Some("lead"), "task_update", json!({"requestId":"done","taskId":"T-1",
        "expectedVersion":version(&store, "T-1"),"patch":{"status":"done"}})).unwrap();
    assert_eq!((acks(&store), delivery(&store, &message).0.as_str()), (0, "pending"));
    assert_eq!(lead_batches(&store).len(), 1, "the wake-up still waits");
    store.collaboration_call(Some("lead"), "peer_read", json!({})).unwrap();
    assert_eq!((acks(&store), delivery(&store, &message).0.as_str()), (0, "pending"));
}

#[test]
fn an_acknowledgment_never_withdraws_a_wake_up_already_sent_or_uncertain() {
    let (dir, store) = fixture();
    let (result, dispatch, message, seq) = reported(&store, "T-1");
    assert_eq!(store.set_peer_delivery("lead", seq, "sending", json!({})).unwrap(), 1);
    let done = ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack").unwrap();
    assert_eq!(done["wakeUp"]["state"], "sending");
    assert_eq!(store.set_peer_delivery("lead", seq, "delivered", json!({})).unwrap(), 1);
    assert_eq!(delivery(&store, &message).0, "delivered");
    // In flight when Core stopped: it stays uncertain.
    let (result, dispatch, message, seq) = reported(&store, "T-2");
    assert_eq!(store.set_peer_delivery("lead", seq, "sending", json!({})).unwrap(), 1);
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let done = ack(&store, Some("lead"), "T-2", &result, &dispatch, "ack-2").unwrap();
    assert_eq!((done["wakeUp"]["state"].as_str(), delivery(&store, &message).0.as_str()), (Some("uncertain"), "uncertain"));
}

#[test]
fn a_wake_up_that_comes_back_unsent_stays_quiet_once_acknowledged() {
    let (_dir, store) = fixture();
    let (result, dispatch, message, seq) = reported(&store, "T-1");
    let hook = json!({"mode":"hook","clientMessageId":"client-1","turnId":"turn-1"});
    assert_eq!(store.set_peer_delivery("lead", seq, "sending", hook).unwrap(), 1);
    ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack").unwrap();
    assert_eq!(delivery(&store, &message).0, "sending");
    // The native hook deferred it: never injected, so nothing was sent.
    store.record_peer_hook_delivery("lead", "client-1", "turn-1", None, "deferred").unwrap();
    assert_eq!(delivery(&store, &message).0, "skipped");
    assert!(lead_batches(&store).is_empty());
    // An explicit retry of a failed notice is held the same way.
    let (result, dispatch, message, seq) = reported(&store, "T-2");
    store.set_peer_delivery("lead", seq, "sending", json!({})).unwrap();
    store.set_peer_delivery("lead", seq, "error", json!({"reason":"test"})).unwrap();
    ack(&store, Some("lead"), "T-2", &result, &dispatch, "ack-2").unwrap();
    assert_eq!(delivery(&store, &message).0, "error");
    store.set_peer_delivery("lead", seq, "pending", json!({})).unwrap();
    assert_eq!(delivery(&store, &message).0, "skipped");
}

#[test]
fn a_batch_keeps_every_other_message_and_names_only_them() {
    let (_dir, store) = fixture();
    let before = mail_from_other(&store, "before");
    let (result, dispatch, message, _) = reported(&store, "T-1");
    let (_, _, kept, _) = reported(&store, "T-2");
    let after = mail_from_other(&store, "after");
    ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack").unwrap();
    let batch = lead_batches(&store);
    assert_eq!((batch.len(), batch[0]["messageCount"].as_i64(), batch[0]["throughSeq"].as_i64()), (1, Some(3), Some(after)));
    assert_eq!(store.set_peer_delivery("lead", after, "sending", json!({})).unwrap(), 3);
    let (state, detail) = delivery(&store, &kept);
    let kept_seq = store.db.read().unwrap()
        .query_row("SELECT seq FROM collaboration_messages WHERE id=?1", [&kept], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(state, "sending");
    assert_eq!(detail["mailbox"]["messageCount"], 3);
    assert_eq!(detail["mailbox"]["memberSeqs"], json!([before, kept_seq, after]));
    assert_eq!(delivery(&store, &message).0, "skipped");
}

#[test]
fn an_acknowledgment_racing_the_reservation_is_one_or_the_other() {
    for round in 0..20 {
        let (_dir, store) = fixture();
        let (result, dispatch, message, seq) = reported(&store, "T-1");
        let store = Arc::new(store);
        let barrier = Arc::new(Barrier::new(2));
        let reserve = {
            let (store, barrier) = (store.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                store.set_peer_delivery("lead", seq, "sending", json!({})).unwrap()
            })
        };
        let acked = {
            let (store, barrier) = (store.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                ack(&store, Some("lead"), "T-1", &result, &dispatch, "ack").unwrap()
            })
        };
        let (reserved, acked) = (reserve.join().unwrap(), acked.join().unwrap());
        let state = delivery(&store, &message).0;
        assert_eq!(acks(&store), 1, "round {round}");
        if reserved == 1 {
            assert_eq!((state.as_str(), &acked["wakeUp"]["state"]), ("sending", &json!("sending")), "round {round}");
        } else {
            assert_eq!((reserved, state.as_str()), (0, "skipped"), "round {round}");
        }
    }
}
