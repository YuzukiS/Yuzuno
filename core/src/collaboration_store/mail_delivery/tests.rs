//! T-50: which refused wake-ups ring again, and how a mail's delivery reads.
//! Through the native harness and a Job's own mail: jobs/tests.rs.
use super::*;
use crate::model::AgentDetail;

fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["a", "b"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
            "cwd":"/workspace","model":"test","color":"sage","threadId":format!("session-{id}"),
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        store.insert(&agent).unwrap();
    }
    (dir, store)
}

/// A mail from a to b whose wake-up ended `state` with `detail`.
fn refused(store: &Store, key: &str, state: &str, detail: Value) -> i64 {
    let mail = store.collaboration_call(Some("a"), "peer_send", json!({"requestId":key,"toAgentId":"b","body":"Results are in"})).unwrap();
    let seq = mail["message"]["seq"].as_i64().unwrap();
    store.set_peer_delivery("b", seq, "sending", json!({})).unwrap();
    store.set_peer_delivery("b", seq, state, detail).unwrap();
    seq
}

fn state(store: &Store, seq: i64) -> (String, Value) {
    let (state, detail): (String, String) = store.db.read().unwrap()
        .query_row("SELECT delivery_state,delivery_detail FROM collaboration_messages WHERE seq=?1", [seq], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    (state, serde_json::from_str(&detail).unwrap())
}

fn ago(seconds: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::seconds(seconds)).to_rfc3339()
}

#[test]
fn only_a_definite_refusal_with_its_time_rings_again_and_never_unread_mail_twice() {
    let (_dir, store) = fixture();
    let due = refused(&store, "due", "error", json!({"mode":"start","error":"turn already completed","failedAt":ago(31)}));
    let early = refused(&store, "early", "error", json!({"mode":"start","error":"turn already completed","failedAt":ago(5)}));
    // May have been accepted: never repeated.
    let unknown = refused(&store, "unknown", "uncertain", json!({"mode":"start","error":"connection lost","failedAt":ago(600)}));
    // Recorded before failures carried a time: left as it was.
    let legacy = refused(&store, "legacy", "error", json!({"mode":"start","error":"turn already completed"}));
    // A result mail to a closed recipient never had a wake-up.
    let closed = refused(&store, "closed", "error", json!({"reason":"recipient_closed","failedAt":ago(600)}));
    // Read already: nothing to ring.
    let read = refused(&store, "read", "error", json!({"mode":"start","error":"turn already completed","failedAt":ago(600)}));
    store.db.write().unwrap().execute("INSERT INTO collaboration_message_reads(message_seq,reader_id,read_at) VALUES(?1,'b','now')", [read]).unwrap();
    assert_eq!(store.retry_refused_peer_deliveries().unwrap(), 1);
    let (now, detail) = state(&store, due);
    assert_eq!((now.as_str(), &detail["retry"]["count"], &detail["retry"]["lastError"]), ("pending", &json!(1), &json!("turn already completed")));
    for seq in [early, legacy, closed, read] {
        assert_eq!(state(&store, seq).0, "error", "{seq}");
    }
    assert_eq!(state(&store, unknown).0, "uncertain");
    // Sent again, it keeps its count; refused again, the next wait is longer.
    store.set_peer_delivery("b", due, "sending", json!({"mode":"start"})).unwrap();
    assert_eq!(state(&store, due).1["retry"]["count"], 1);
    store.set_peer_delivery("b", due, "error", json!({"mode":"start","error":"turn already completed","failedAt":ago(31)})).unwrap();
    assert_eq!(store.retry_refused_peer_deliveries().unwrap(), 0, "the second wait is 60 s");
    store.db.write().unwrap().execute("UPDATE collaboration_messages SET delivery_detail=json_set(delivery_detail,'$.failedAt',?1) WHERE seq=?2",
        rusqlite::params![ago(61), due]).unwrap();
    assert_eq!(store.retry_refused_peer_deliveries().unwrap(), 1);
    assert_eq!(state(&store, due).1["retry"]["count"], 2);
}

#[test]
fn a_delivery_reads_as_what_failed_and_what_happens_next() {
    let refused = "turn already completed";
    let at = ago(5);
    // (state, detail, read, closed, kind, words)
    let cases = [
        ("error", json!({"mode":"start","error":refused,"failedAt":at}), false, false, None,
            Some(format!("delivery failed: {refused}; it is tried again at the recipient's next wake-up. The mail stays in the mailbox."))),
        ("error", json!({"mode":"hook","error":refused,"failedAt":at,"retry":{"count":3,"of":3}}), false, false, None,
            Some(format!("delivery failed: {refused}; tried again 3 times, not again. The mail stays in the mailbox."))),
        // T-50 R1 P3 and R2 P3: what Core will not try again is never promised.
        ("error", json!({"mode":"start","error":refused}), false, false, Some("job"),
            Some(format!("delivery failed: {refused}; it is not tried again: it was refused before Core recorded refusal times. The mail stays in the mailbox."))),
        ("error", json!({"mode":"start","error":refused,"failedAt":at}), true, false, Some("job"),
            Some(format!("delivery failed: {refused}; it is not tried again: the recipient has read the mail. The mail stays in the mailbox."))),
        ("error", json!({"mode":"start","error":refused,"failedAt":at}), false, true, Some("job"),
            Some(format!("delivery failed: {refused}; it is not tried again: the recipient is closed. The mail stays in the mailbox."))),
        ("error", json!({"mode":"hook","error":refused,"failedAt":at}), false, false, Some("update_wait"),
            Some(format!("delivery failed: {refused}; it is not tried again. The mail stays in the mailbox."))),
        ("error", json!({"reason":"recipient_closed"}), false, true, Some("task_result"),
            Some("delivery failed: recipient_closed; it is not tried again. The mail stays in the mailbox.".to_owned())),
        ("pending", json!({"retry":{"count":2,"of":3,"lastError":refused}}), false, false, None,
            Some(format!("delivery failed: {refused}; trying again at the recipient's next wake-up (retry 2 of 3). The mail stays in the mailbox."))),
        ("pending", json!({"retry":{"count":2,"of":3,"lastError":refused}}), true, false, None,
            Some(format!("delivery failed: {refused}; it is not tried again: the recipient has read the mail. The mail stays in the mailbox."))),
        ("pending", json!({"retry":{"count":2,"of":3,"lastError":refused}}), false, true, None,
            Some(format!("delivery failed: {refused}; it is not tried again: the recipient is closed. The mail stays in the mailbox."))),
        ("uncertain", json!({"error":"connection lost"}), false, false, None,
            Some("delivery uncertain: connection lost; the recipient may have received it, so it is not repeated. The mail stays in the mailbox.".to_owned())),
        ("pending", json!({}), false, false, None, None),
        ("delivered", json!({"retry":{"count":1,"of":3}}), false, false, None, None),
        ("skipped", json!({"reason":"result_acknowledged"}), false, false, None, None),
    ];
    for (state, detail, read, closed, kind, words) in cases {
        assert_eq!(problem(state, &detail, read, closed, kind), words, "{state} {detail} read={read} closed={closed} {kind:?}");
    }
}
