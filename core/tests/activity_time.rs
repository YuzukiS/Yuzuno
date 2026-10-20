use serde_json::json;
use yuzuno_workspace::model::AgentDetail;

fn detail() -> AgentDetail {
    serde_json::from_value(json!({
        "agent":{"id":"a","name":"A","cwd":"/tmp","model":"","color":"sage",
            "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]
    })).unwrap()
}

#[test]
fn native_start_and_local_fallback_survive_repeated_events_and_serialization() {
    let mut d = detail();
    let start = json!({"turn":{"id":"t","status":"inProgress","items":[],"startedAt":1700000000}});
    d.apply("turn/started", &start);
    assert_eq!(d.turns[0]["startedAt"], 1700000000);
    assert!(d.turns[0]["_yuzunoStartedAt"].as_i64().unwrap() > 0);
    // Fixed earlier fallback catches accidental resetting even within the same millisecond.
    d.turns[0]["_yuzunoStartedAt"] = json!(1700000000500_i64);
    d.apply("turn/started", &json!({"turn":{"id":"t","status":"inProgress","items":[]}}));
    d.apply("item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":"Progress"}));
    let restored: AgentDetail = serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
    assert_eq!(restored.turns[0]["startedAt"], 1700000000);
    assert_eq!(restored.turns[0]["_yuzunoStartedAt"], 1700000000500_i64);
    assert!(d.turn_mut("next")["_yuzunoStartedAt"].as_i64().unwrap() > 1700000000500_i64);
}

#[test]
fn compaction_has_an_independent_clock_and_duplicate_start_does_not_reset_it() {
    let mut d = detail();
    d.turn_mut("t")["_yuzunoStartedAt"] = json!(1700000000000_i64);
    let event = |id| json!({"turnId":"t","item":{"id":id,"type":"contextCompaction"}});
    d.apply("item/started", &event("first"));
    assert!(d.turns[0]["_yuzunoCompactionStartedAt"].as_i64().unwrap() > 0);
    d.turns[0]["_yuzunoCompactionStartedAt"] = json!(1700000060000_i64);
    d.apply("item/started", &event("first"));
    assert_eq!(d.turns[0]["_yuzunoCompactionStartedAt"], 1700000060000_i64);
    d.apply("item/started", &event("second"));
    let second_start = d.turns[0]["_yuzunoCompactionStartedAt"].clone();
    assert_ne!(second_start, 1700000060000_i64);
    d.apply("item/completed", &event("first"));
    assert_eq!(d.turns[0]["_yuzunoCompactionStartedAt"], second_start);
    d.apply("item/completed", &event("second"));
    assert!(d.turns[0]["_yuzunoCompactionStartedAt"].is_null());
    assert_eq!(d.turns[0]["_yuzunoStartedAt"], 1700000000000_i64);
}
