use serde_json::json;
use yuzuno_workspace::model::AgentDetail;

fn detail() -> AgentDetail {
    serde_json::from_value(json!({
        "agent":{"id":"a","name":"A","goal":"","cwd":"/tmp","model":"","color":"sage",
            "status":"working","createdAt":"","updatedAt":"","unreadCount":3,
            "pendingCount":0,"lastSeq":12,"reviewedSeq":5},
        "turns":[{"id":"t","status":"inProgress","items":[]}],"pending":[],"artifacts":[]
    })).unwrap()
}

#[test]
fn compaction_tracks_native_start_and_completion_without_changing_items_or_read_state() {
    let mut d = detail();
    let event = json!({"turnId":"t","item":{"type":"contextCompaction","id":"compact"}});
    // A historical completion alone must never pretend compaction is running.
    d.apply("item/completed", &event);
    assert!(d.turns[0]["_yuzunoCompactionId"].is_null());
    d.apply("item/started", &event);
    assert_eq!(d.turns[0]["_yuzunoCompactionId"], "compact");
    assert_eq!(d.turns[0]["items"][0], event["item"]);
    d.apply("item/completed", &event);
    assert!(d.turns[0]["_yuzunoCompactionId"].is_null());
    assert_eq!(d.agent.unread_count, 3);
    assert_eq!(d.agent.reviewed_seq, 5);
    assert!(d.pending.is_empty());
}

#[test]
fn thread_completion_and_terminal_turns_clear_compaction_and_its_clock() {
    for (method, params) in [
        ("thread/compacted", json!({"turnId":"t"})),
        ("thread/compacted", json!({})),
        ("turn/completed", json!({"turn":{"id":"t","status":"interrupted","items":[]}})),
        ("turn/completed", json!({"turn":{"id":"t","status":"failed","items":[]}})),
        ("turn/completed", json!({"turn":{"id":"t","status":"completed","items":[]}})),
    ] {
        let mut d = detail();
        d.apply("item/started", &json!({"turnId":"t","item":{"type":"contextCompaction","id":"compact"}}));
        assert_eq!(d.turns[0]["_yuzunoCompactionId"], "compact", "{method}: {params}");
        assert!(d.turns[0]["_yuzunoCompactionStartedAt"].as_i64().unwrap() > 0, "{method}: {params}");
        d.apply(method, &params);
        assert!(d.turns[0]["_yuzunoCompactionId"].is_null(), "{method}: {params}");
        assert!(d.turns[0]["_yuzunoCompactionStartedAt"].is_null(), "{method}: {params}");
    }
}

#[test]
fn late_compaction_completion_does_not_clear_a_newer_compaction() {
    let mut d = detail();
    for id in ["first", "second"] {
        d.apply("item/started", &json!({"turnId":"t","item":{"type":"contextCompaction","id":id}}));
    }
    d.apply("item/completed", &json!({"turnId":"t","item":{"type":"contextCompaction","id":"first"}}));
    assert_eq!(d.turns[0]["_yuzunoCompactionId"], "second");
}
