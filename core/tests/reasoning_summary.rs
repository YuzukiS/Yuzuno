use serde_json::json;
use yuzuno_workspace::model::AgentDetail;

fn detail() -> AgentDetail {
    serde_json::from_value(json!({
        "agent":{"id":"a","name":"A","cwd":"/tmp","model":"","color":"sage",
            "status":"working","createdAt":"","updatedAt":"","unreadCount":3,
            "pendingCount":0,"lastSeq":12,"reviewedSeq":5},
        "turns":[],"pending":[],"artifacts":[]
    })).unwrap()
}

#[test]
fn summary_stream_accumulates_sections_without_replacing_other_items_or_read_state() {
    let mut d = detail();
    d.apply("item/started", &json!({"turnId":"t","item":{"id":"shell","type":"commandExecution"}}));
    d.apply("item/started", &json!({"turnId":"t","item":{"id":"r","type":"reasoning","summary":[],"content":[]}}));
    let part = json!({"turnId":"t","itemId":"r","summaryIndex":0});
    d.apply("item/reasoning/summaryPartAdded", &part);
    for delta in ["检查", "布局"] {
        d.apply("item/reasoning/summaryTextDelta", &json!({"turnId":"t","itemId":"r","summaryIndex":0,"delta":delta}));
    }
    d.apply("item/reasoning/summaryPartAdded", &part);
    d.apply("item/reasoning/summaryPartAdded", &json!({"turnId":"t","itemId":"r","summaryIndex":1}));
    d.apply("item/reasoning/summaryTextDelta", &json!({"turnId":"t","itemId":"r","summaryIndex":1,"delta":"Verify the result."}));
    assert_eq!(d.turns[0]["items"][0]["id"], "shell");
    assert_eq!(d.turns[0]["items"][1]["summary"], json!(["检查布局", "Verify the result."]));
    assert_eq!(d.turns[0]["items"].as_array().unwrap().len(), 2);
    assert_eq!((d.agent.unread_count, d.agent.reviewed_seq, d.agent.pending_count), (3, 5, 0));
}

#[test]
fn summary_can_arrive_without_start_and_final_payload_is_authoritative() {
    let mut d = detail();
    d.apply("item/reasoning/summaryTextDelta", &json!({"turnId":"t","itemId":"r","summaryIndex":1,"delta":"Live text"}));
    assert_eq!(d.turns[0]["items"][0]["summary"], json!(["", "Live text"]));
    let final_item = json!({"id":"r","type":"reasoning","summary":["Final summary"],"content":[]});
    d.apply("item/completed", &json!({"turnId":"t","item":final_item}));
    assert_eq!(d.turns[0]["items"][0], final_item);
    assert_eq!(d.turns[0]["items"].as_array().unwrap().len(), 1);
}

#[test]
fn raw_reasoning_deltas_do_not_become_public_summaries() {
    let mut d = detail();
    d.apply("item/reasoning/textDelta", &json!({"turnId":"t","itemId":"r","contentIndex":0,"delta":"Raw-only fixture"}));
    assert!(d.turns.is_empty());
    d.apply("item/reasoning/summaryTextDelta", &json!({"turnId":"t","itemId":"r","summaryIndex":-1,"delta":"Invalid index"}));
    assert!(d.turns.is_empty());
}
