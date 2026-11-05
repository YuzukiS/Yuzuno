use super::*;

fn ev(kind: &str, created: i64, data: Value) -> Value {
    json!({"id": "evt_1", "type": kind, "created": created, "data": data})
}

fn kinds(read: &[Value]) -> Vec<&str> {
    read.iter().map(|e| e["type"].as_str().unwrap()).collect()
}

/// A turn is everything up to its `idle` message, and an answer answers the
/// newest user message before it: with two user messages in one turn and the
/// answers interleaved, each answer names its own (Lead 4983, note 2).
#[test]
fn an_answer_answers_the_newest_user_message_before_it_in_its_turn() {
    let messages = json!([
        {"id": "msg_u1", "type": "user", "text": "first", "time": {"created": 1}},
        {"id": "msg_a1", "type": "assistant", "model": {"id": "m", "providerID": "p"}, "time": {"created": 2, "completed": 3},
            "finish": "tool-calls", "content": [{"type": "text", "text": "on it"}]},
        {"id": "msg_u2", "type": "user", "text": "steered", "time": {"created": 4}},
        {"id": "msg_a2", "type": "assistant", "time": {"created": 5, "completed": 6}, "finish": "tool-calls", "content": []},
        {"id": "msg_a3", "type": "assistant", "time": {"created": 7, "completed": 8}, "finish": "stop", "content": []},
        {"id": "msg_i1", "type": "idle", "outcome": "succeeded", "time": {"created": 9}},
        {"id": "msg_u3", "type": "user", "text": "next", "time": {"created": 10}},
        {"id": "msg_a4", "type": "assistant", "time": {"created": 11}, "content": []},
        {"id": "msg_i2", "type": "idle", "outcome": "failed", "error": {"type": "provider_auth", "message": "no key"}, "time": {"created": 12}},
        {"id": "msg_a5", "type": "assistant", "time": {"created": 13}, "content": []},
    ]);
    let Read { messages: read, ended, open, steps } = read_messages(&messages);
    assert!(steps.is_empty(), "no answer under way once its turn ended");
    assert_eq!(open, None, "the last turn ended");
    let parents: Vec<(&str, Value)> = read.iter().filter(|m| m["info"]["role"] == "assistant")
        .map(|m| (m["info"]["id"].as_str().unwrap(), m["info"]["parentID"].clone())).collect();
    assert_eq!(parents, vec![("msg_a1", json!("msg_u1")), ("msg_a2", json!("msg_u2")), ("msg_a3", json!("msg_u2")), ("msg_a4", json!("msg_u3")),
        ("msg_a5", Value::Null)], "each answer answers its turn's newest user message before it; one after an idle message, none");
    assert_eq!(read[1]["info"]["modelID"], "m");
    assert_eq!(read[1]["info"]["providerID"], "p");
    assert_eq!(read[1]["info"]["time"]["completed"], 3);
    assert_eq!(ended, vec![
        Ended { user: "msg_u2".into(), error: None },
        Ended { user: "msg_u3".into(), error: Some(json!({"name": EXECUTION_FAILED, "data": {"message": "no key", "type": "provider_auth"}})) },
    ], "each turn's end, under its newest user message");
}

/// Text and reasoning entries are `<answer>:<ordinal>`, a tool its call's
/// ID; none starts with `~`, which the record would key by position
/// (Lead 4983, note 5).
#[test]
fn an_answers_entries_are_its_items_and_none_is_keyed_by_position() {
    let messages = json!([
        {"id": "msg_u1", "type": "user", "time": {"created": 1}},
        {"id": "msg_a1", "type": "assistant", "time": {"created": 2}, "content": [
            {"type": "reasoning", "text": "think"},
            {"type": "text", "text": "hello"},
            {"type": "tool", "id": "call_1", "name": "bash", "state": {"status": "completed", "input": {"command": "ls"},
                "content": [{"type": "text", "text": "a.txt"}]}},
            {"type": "tool", "id": "call_2", "name": "read", "state": {"status": "error", "input": {}, "error": {"type": "x", "message": "gone"}}},
            {"type": "tool", "id": "call_3", "name": "edit", "state": {"status": "streaming", "input": "{\"pa"}},
        ]},
    ]);
    let read = read_messages(&messages);
    assert_eq!(read.open.as_deref(), Some("msg_u1"), "a turn not yet ended is open");
    let parts = read.messages[1]["parts"].as_array().unwrap();
    let ids: Vec<&str> = parts.iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["msg_a1:0", "msg_a1:1", "call_1", "call_2", "call_3"], "a text or reasoning entry by its ordinal, a tool by its call's ID");
    assert!(ids.iter().all(|id| !id.starts_with('~')));
    assert_eq!((&parts[0]["type"], &parts[0]["text"]), (&json!("reasoning"), &json!("think")));
    assert_eq!((&parts[1]["type"], &parts[1]["text"]), (&json!("text"), &json!("hello")));
    assert_eq!(parts[2]["state"], json!({"status": "completed", "input": {"command": "ls"}, "output": "a.txt"}));
    assert_eq!(parts[2]["tool"], "bash");
    assert_eq!(parts[3]["state"], json!({"status": "error", "input": {}, "error": "gone"}));
    assert_eq!(parts[4]["state"], json!({"status": "pending", "input": {}}), "input still streaming is none yet");
    assert!(parts.iter().all(|p| p["messageID"] == "msg_a1"));
}

/// The live stream reads as the snapshot does: a delivered message is a
/// user message, a step its answer to the newest one, its entries the
/// Turn's items, and the execution's end the turn's.
#[test]
fn live_events_read_as_the_snapshot_reads_the_same_turn() {
    let mut c = Cursor::default();
    let s = json!("ses_1");
    let d = |extra: Value| { let mut v = json!({"sessionID": s}); v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone()); v };
    let admitted = c.read(&ev("session.inbox.enqueued", 1, d(json!({"inboxID": "msg_u1", "item": {"type": "user"}}))));
    assert_eq!(admitted[0]["data"]["info"], json!({"id": "msg_u1", "role": "user", "time": {"created": 1}}));
    let delivered = c.read(&ev("session.inbox.delivered", 2, d(json!({"inboxID": "msg_u1"}))));
    assert_eq!(delivered[0]["data"]["info"], json!({"id": "msg_u1", "role": "user", "time": {"created": 2}}));
    assert_eq!(kinds(&c.read(&ev("session.execution.started", 3, d(json!({}))))), ["session.status"]);
    let started = c.read(&ev("session.step.started", 4, d(json!({"assistantMessageID": "msg_a1", "model": {"id": "m", "providerID": "p"}}))));
    assert_eq!(started[0]["data"]["info"]["parentID"], "msg_u1");
    assert_eq!(started[0]["data"]["info"]["time"]["completed"], Value::Null, "not yet ended");
    let text = c.read(&ev("session.text.started", 5, d(json!({"assistantMessageID": "msg_a1", "ordinal": 0}))));
    assert_eq!(text[0]["data"]["part"], json!({"id": "msg_a1:0", "messageID": "msg_a1", "type": "text", "text": ""}));
    // Deltas gather for DELTA_GATHER_MS of the events' own time, then are written together.
    assert!(c.read(&ev("session.text.delta", 100, d(json!({"assistantMessageID": "msg_a1", "ordinal": 0, "delta": "Hel"})))).is_empty());
    let delta = c.read(&ev("session.text.delta", 100 + DELTA_GATHER_MS, d(json!({"assistantMessageID": "msg_a1", "ordinal": 0, "delta": "lo"}))));
    assert_eq!(delta[0]["data"], json!({"sessionID": "ses_1", "messageID": "msg_a1", "partID": "msg_a1:0", "type": "text", "delta": "Hello"}));
    assert!(c.read(&ev("session.text.delta", 400, d(json!({"assistantMessageID": "msg_a1", "ordinal": 0, "delta": " wor"})))).is_empty());
    let whole = c.read(&ev("session.text.ended", 401, d(json!({"assistantMessageID": "msg_a1", "ordinal": 0, "text": "Hello world"}))));
    assert_eq!(whole[0]["data"]["part"]["text"], "Hello world", "the whole text replaces what streamed and what had not been written");
    // A tool through its states keeps its name and input.
    let tool = |kind: &str, at: i64, extra: Value| {
        let mut data = d(json!({"assistantMessageID": "msg_a1", "id": "call_1"}));
        data.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        ev(kind, at, data)
    };
    let states: Vec<Value> = [
        tool("session.tool.input.started", 410, json!({"name": "bash"})),
        tool("session.tool.called", 411, json!({"input": {"command": "ls"}, "executed": true})),
        tool("session.tool.progress", 412, json!({"metadata": {"lines": 1}})),
        tool("session.tool.success", 413, json!({"content": [{"type": "text", "text": "a.txt"}], "executed": true})),
    ].iter().map(|e| c.read(e).remove(0)["data"]["part"].clone()).collect();
    assert_eq!(states.iter().map(|p| p["state"]["status"].as_str().unwrap()).collect::<Vec<_>>(), ["pending", "running", "running", "completed"]);
    assert!(states.iter().all(|p| p["id"] == "call_1" && p["tool"] == "bash" && p["messageID"] == "msg_a1"));
    assert_eq!(states[3]["state"], json!({"status": "completed", "input": {"command": "ls"}, "output": "a.txt"}));
    let ended = c.read(&ev("session.step.ended", 420, d(json!({"assistantMessageID": "msg_a1", "finish": "tool-calls",
        "tokens": {"input": 10, "output": 2, "reasoning": 0, "cache": {"read": 0, "write": 0}}}))));
    let info = &ended[0]["data"]["info"];
    assert_eq!((&info["parentID"], &info["time"]["created"], &info["time"]["completed"], &info["modelID"]), (&json!("msg_u1"), &json!(4), &json!(420), &json!("m")));
    assert_eq!(info["tokens"]["input"], 10);
    // A steered input: the next step answers it.
    c.read(&ev("session.inbox.enqueued", 430, d(json!({"inboxID": "msg_u2", "item": {"type": "user"}}))));
    c.read(&ev("session.inbox.delivered", 431, d(json!({"inboxID": "msg_u2"}))));
    let next = c.read(&ev("session.step.started", 432, d(json!({"assistantMessageID": "msg_a2"}))));
    assert_eq!(next[0]["data"]["info"]["parentID"], "msg_u2");
    let idle = c.read(&ev("session.execution.succeeded", 440, d(json!({}))));
    assert_eq!(kinds(&idle), ["session.status"]);
    assert_eq!(idle[0]["data"]["status"]["type"], "idle");
    let after = c.read(&ev("session.step.started", 450, d(json!({"assistantMessageID": "msg_a3"}))));
    assert_eq!(after[0]["data"]["info"]["parentID"], Value::Null, "the turn is over");
}

/// A message 2.x admits is stored: its user message confirms it, from the
/// event or from the inbox a whole read lists. It answers nothing until 2.x
/// delivers it into the turn: a step that starts before that is the earlier
/// message's. A synthetic message, or a compaction asked for, is not a user's
/// message sent.
#[test]
fn an_admitted_message_is_stored_and_answers_nothing_until_it_is_delivered() {
    let mut c = Cursor::default();
    let d = |extra: Value| { let mut v = json!({"sessionID": "ses_1"}); v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone()); v };
    c.read(&ev("session.inbox.enqueued", 1, d(json!({"inboxID": "msg_u1", "item": {"type": "user"}}))));
    c.read(&ev("session.inbox.delivered", 2, d(json!({"inboxID": "msg_u1"}))));
    let steered = c.read(&ev("session.inbox.enqueued", 3, d(json!({"inboxID": "msg_u2", "item": {"type": "user", "delivery": "steer"}}))));
    assert_eq!(kinds(&steered), ["message.updated"]);
    assert_eq!(steered[0]["data"]["info"], json!({"id": "msg_u2", "role": "user", "time": {"created": 3}}));
    let before = c.read(&ev("session.step.started", 4, d(json!({"assistantMessageID": "msg_a1"}))));
    assert_eq!(before[0]["data"]["info"]["parentID"], "msg_u1", "admitted, not yet delivered");
    c.read(&ev("session.inbox.delivered", 5, d(json!({"inboxID": "msg_u2"}))));
    let after = c.read(&ev("session.step.started", 6, d(json!({"assistantMessageID": "msg_a2"}))));
    assert_eq!(after[0]["data"]["info"]["parentID"], "msg_u2");
    for item in ["synthetic", "compaction", "move"] {
        let id = format!("msg_{item}");
        assert!(c.read(&ev("session.inbox.enqueued", 7, d(json!({"inboxID": id, "item": {"type": item}})))).is_empty(), "{item}");
    }
    // A whole read: the inbox lists what is admitted and not delivered.
    let inbox = json!([
        {"id": "msg_u3", "sessionID": "ses_1", "type": "user", "delivery": "steer", "payload": {"text": "more"}, "time": {"created": 8}},
        {"id": "msg_s1", "sessionID": "ses_1", "type": "synthetic", "delivery": "queue", "payload": {"text": "go on"}, "time": {"created": 9}},
        {"id": "msg_c1", "sessionID": "ses_1", "type": "compaction", "delivery": "queue", "payload": {}, "time": {"created": 10}},
    ]);
    assert_eq!(admitted(&inbox), vec![json!({"id": "msg_u3", "role": "user", "time": {"created": 8}})]);
    assert!(admitted(&json!([])).is_empty());
}

/// How an execution ends is how Core's record names it: failed, an
/// interruption as an aborted answer, and a shutdown as nothing (the
/// execution resumes it).
#[test]
fn an_executions_end_is_read_as_core_names_it() {
    let s = json!({"sessionID": "ses_1"});
    let mut c = Cursor::default();
    let failed = c.read(&ev("session.execution.failed", 1, json!({"sessionID": "ses_1", "error": {"type": "provider_auth", "message": "no key"}})));
    assert_eq!(kinds(&failed), ["session.error", "session.status"]);
    assert_eq!(failed[0]["data"]["error"], json!({"name": EXECUTION_FAILED, "data": {"message": "no key", "type": "provider_auth"}}));
    for reason in ["user", "superseded", "inactivity"] {
        let read = c.read(&ev("session.execution.interrupted", 2, json!({"sessionID": "ses_1", "reason": reason})));
        assert_eq!(kinds(&read), ["session.error", "session.status"], "{reason}");
        assert_eq!(read[0]["data"]["error"]["name"], "MessageAbortedError", "{reason}");
    }
    assert!(c.read(&ev("session.execution.interrupted", 3, json!({"sessionID": "ses_1", "reason": "shutdown"}))).is_empty());
    assert_eq!(c.read(&ev("session.retry.scheduled", 4, s.clone()))[0]["data"]["status"]["type"], "retry");
    let child = c.read(&ev("session.created", 5, json!({"sessionID": "ses_2", "parentID": "ses_1", "title": "t", "agent": "a"})));
    assert_eq!(child[0]["data"]["info"], json!({"id": "ses_2", "parentID": "ses_1", "title": "t", "agent": "a"}));
    assert!(c.read(&ev("session.shell.started", 6, s.clone())).is_empty(), "nothing Core reads");
}

/// A 1.19.3-shaped event, as the stand-in's 1.19.3 mode sends, is left as it is.
#[test]
fn a_1_19_3_event_is_left_as_it_is() {
    let mut c = Cursor::default();
    for event in [
        ev("message.updated", 1, json!({"sessionID": "s", "info": {"id": "m"}})),
        ev("session.status", 1, json!({"sessionID": "s", "status": {"type": "idle"}})),
        ev("session.created", 1, json!({"sessionID": "s", "info": {"id": "s"}})),
        ev("permission.asked", 1, json!({"sessionID": "s", "id": "per_1"})),
    ] {
        assert_eq!(c.read(&event), vec![event.clone()]);
    }
    assert!(is_v2(&json!([{"id": "m", "type": "user"}])));
    assert!(!is_v2(&json!([{"info": {"id": "m"}, "parts": []}])));
    assert!(!is_v2(&json!([])));
}

#[test]
fn a_delta_streams_into_its_item_and_makes_it_if_its_start_was_missed() {
    let mut items = vec![json!({"id": "msg_a1:0", "type": "agentMessage", "text": "Hel"})];
    apply_delta(&mut items, &json!({"partID": "msg_a1:0", "messageID": "msg_a1", "type": "text", "delta": "lo"}));
    apply_delta(&mut items, &json!({"partID": "msg_a1:1", "messageID": "msg_a1", "type": "reasoning", "delta": "hm"}));
    assert_eq!(items, vec![json!({"id": "msg_a1:0", "type": "agentMessage", "text": "Hello"}),
        json!({"id": "msg_a1:1", "type": "reasoning", "summary": ["hm"], "nativeMessageId": "msg_a1"})]);
}

/// Each session is read apart: a sub-agent's execution ending is not the
/// end of the Agent's own turn.
#[test]
fn a_sub_agents_end_is_not_the_agents() {
    let mut c = Cursor::default();
    c.read(&ev("session.inbox.enqueued", 1, json!({"sessionID": "ses_a", "inboxID": "msg_u1", "item": {"type": "user"}})));
    c.read(&ev("session.inbox.delivered", 2, json!({"sessionID": "ses_a", "inboxID": "msg_u1"})));
    c.read(&ev("session.execution.succeeded", 3, json!({"sessionID": "ses_child"})));
    let step = c.read(&ev("session.step.started", 4, json!({"sessionID": "ses_a", "assistantMessageID": "msg_a1"})));
    assert_eq!(step[0]["data"]["info"]["parentID"], "msg_u1", "a sub-agent's execution ending is not the Agent's");
    c.resumed("ses_a", Some("msg_u9".into()), vec![("msg_a8".into(), Some("msg_u8".into()))]);
    let resumed = c.read(&ev("session.step.started", 5, json!({"sessionID": "ses_a", "assistantMessageID": "msg_a2"})));
    assert_eq!(resumed[0]["data"]["info"]["parentID"], "msg_u9", "a whole read says which turn is open");
    let ended = c.read(&ev("session.step.ended", 6, json!({"sessionID": "ses_a", "assistantMessageID": "msg_a8"})));
    assert_eq!(ended[0]["data"]["info"]["parentID"], "msg_u8", "a step under way at the read ends as its own");
    let unknown = c.read(&ev("session.step.ended", 7, json!({"sessionID": "ses_a", "assistantMessageID": "msg_a7"})));
    assert_eq!(unknown[0]["data"]["info"]["parentID"], Value::Null, "an end of a step never seen to start answers nothing");
}
