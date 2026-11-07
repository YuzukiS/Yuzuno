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
    let Read { messages: read, ended, open, steps, tools, .. } = read_messages(&messages);
    assert_eq!(steps, vec![OpenStep { id: "msg_a5".into(), parent: None, created: json!(13), model: Value::Null }],
        "of the answers not yet ended, only the one after the last turn's end is under way, answering nothing");
    assert!(tools.is_empty());
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
    let next = c.read(&ev("session.step.started", 432, d(json!({"assistantMessageID": "msg_a2", "started": 431}))));
    assert_eq!(next[0]["data"]["info"]["parentID"], "msg_u2");
    assert_eq!(next[0]["data"]["info"]["time"]["created"], 431, "an answer starts when its step says it started, as 2.x stores it");
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
    let read = read_messages(&json!([
        {"id": "msg_u8", "type": "user", "time": {"created": 1}},
        {"id": "msg_a8", "type": "assistant", "time": {"created": 2}, "content": []},
        {"id": "msg_u9", "type": "user", "time": {"created": 3}},
    ]));
    c.resumed("ses_a", &read, &json!([]));
    let resumed = c.read(&ev("session.step.started", 5, json!({"sessionID": "ses_a", "assistantMessageID": "msg_a2"})));
    assert_eq!(resumed[0]["data"]["info"]["parentID"], "msg_u9", "a whole read says which turn is open");
    let ended = c.read(&ev("session.step.ended", 6, json!({"sessionID": "ses_a", "assistantMessageID": "msg_a8"})));
    assert_eq!(ended[0]["data"]["info"]["parentID"], "msg_u8", "a step under way at the read ends as its own");
    let unknown = c.read(&ev("session.step.ended", 7, json!({"sessionID": "ses_a", "assistantMessageID": "msg_a7"})));
    assert_eq!(unknown[0]["data"]["info"]["parentID"], Value::Null, "an end of a step never seen to start answers nothing");
}

/// What a whole read in mid-turn hands the live stream, which the events
/// after it do not repeat (R1 98de4ffb): of an answer under way, its start
/// and model; of a tool under way, its answer, name and input; and what the
/// inbox holds, so that delivering a compaction asked for is no user's
/// message.
#[test]
fn a_whole_read_gives_the_live_stream_what_its_later_events_do_not_repeat() {
    let messages = json!([
        {"id": "msg_u1", "type": "user", "time": {"created": 1}},
        {"id": "msg_a0", "type": "assistant", "model": {"id": "m", "providerID": "p"}, "time": {"created": 2, "completed": 3},
            "content": [{"type": "tool", "id": "call_0", "name": "bash", "state": {"status": "running", "input": {"command": "old"}}}]},
        {"id": "msg_a1", "type": "assistant", "model": {"id": "m", "providerID": "p"}, "time": {"created": 5}, "content": [
            {"type": "tool", "id": "call_1", "name": "bash", "state": {"status": "running", "input": {"command": "ls"}}},
            {"type": "tool", "id": "call_2", "name": "read", "state": {"status": "streaming", "input": "{\"pa"}},
            {"type": "tool", "id": "call_3", "name": "edit", "state": {"status": "completed", "input": {}, "content": []}},
        ]},
    ]);
    let read = read_messages(&messages);
    assert_eq!(read.steps, vec![OpenStep { id: "msg_a1".into(), parent: Some("msg_u1".into()), created: json!(5),
        model: json!({"id": "m", "providerID": "p"}) }], "only the answer not yet ended, with its start and model");
    assert_eq!(read.tools, vec![
        OpenTool { id: "call_1".into(), message: "msg_a1".into(), name: json!("bash"), input: json!({"command": "ls"}) },
        OpenTool { id: "call_2".into(), message: "msg_a1".into(), name: json!("read"), input: Value::Null },
    ], "only its tools under way, an input still streaming as none");
    let mut c = Cursor::default();
    let inbox = json!([{"id": "msg_c1", "sessionID": "ses_1", "type": "compaction", "delivery": "queue", "payload": {}, "time": {"created": 6}}]);
    c.resumed("ses_1", &read, &inbox);
    let d = |extra: Value| { let mut v = json!({"sessionID": "ses_1"}); v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone()); v };
    let ended = c.read(&ev("session.step.ended", 9, d(json!({"assistantMessageID": "msg_a1", "finish": "tool-calls", "tokens": {"total": 7}}))));
    let info = &ended[0]["data"]["info"];
    assert_eq!((&info["parentID"], &info["time"]["created"], &info["time"]["completed"], &info["providerID"], &info["modelID"]),
        (&json!("msg_u1"), &json!(5), &json!(9), &json!("p"), &json!("m")), "the answer ends with the start and model the read found");
    let done = c.read(&ev("session.tool.success", 10, d(json!({"assistantMessageID": "msg_a1", "id": "call_1",
        "content": [{"type": "text", "text": "a.txt"}], "executed": true}))));
    let part = &done[0]["data"]["part"];
    assert_eq!((&part["tool"], &part["state"]["input"], &part["state"]["status"]), (&json!("bash"), &json!({"command": "ls"}), &json!("completed")),
        "the tool keeps the name and input the read found");
    assert!(c.read(&ev("session.inbox.delivered", 11, d(json!({"inboxID": "msg_c1"})))).is_empty(), "a compaction delivered is no user's message");
    let next = c.read(&ev("session.step.started", 12, d(json!({"assistantMessageID": "msg_a2"}))));
    assert_eq!(next[0]["data"]["info"]["parentID"], "msg_u1");
}

/// A message delivered whose admission this connection never saw is marked
/// so (T-61 slice 3): what it was is not known here, so it is no command's
/// input. One whose admission it saw, a synthetic one too, is not.
#[test]
fn a_delivery_whose_admission_was_not_seen_says_so() {
    let mut c = Cursor::default();
    let d = |extra: Value| { let mut v = json!({"sessionID": "ses_1"}); v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone()); v };
    let unseen = c.read(&ev("session.inbox.delivered", 1, d(json!({"inboxID": "msg_u0"}))));
    assert_eq!(unseen[0]["data"]["info"], json!({"id": "msg_u0", "role": "user", "time": {"created": 1}, "_opencodeUnseen": true}));
    assert!(c.read(&ev("session.inbox.enqueued", 2, d(json!({"inboxID": "msg_s1", "item": {"type": "synthetic"}})))).is_empty());
    let seen = c.read(&ev("session.inbox.delivered", 3, d(json!({"inboxID": "msg_s1"}))));
    assert_eq!(seen[0]["data"]["info"], json!({"id": "msg_s1", "role": "user", "time": {"created": 3}}));
}

/// Text gathered for an answer's entry is written out by the next event of
/// that answer, by its step's end, and by its execution's end, not only by
/// a later delta of the same entry or its own end (T-32 slice 4a; R2 and R5
/// notes). A session whose execution ended keeps nothing (R3 notes).
#[test]
fn gathered_text_is_written_out_by_its_answers_next_event_and_an_idle_session_keeps_nothing() {
    let mut c = Cursor::default();
    let d = |extra: Value| { let mut v = json!({"sessionID": "ses_1"}); v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone()); v };
    c.read(&ev("session.inbox.enqueued", 1, d(json!({"inboxID": "msg_u1", "item": {"type": "user"}}))));
    c.read(&ev("session.inbox.delivered", 2, d(json!({"inboxID": "msg_u1"}))));
    c.read(&ev("session.step.started", 3, d(json!({"assistantMessageID": "msg_a1"}))));
    assert!(c.read(&ev("session.reasoning.delta", 10, d(json!({"assistantMessageID": "msg_a1", "ordinal": 0, "delta": "think"})))).is_empty());
    // The answer's next entry: what its reasoning gathered goes first.
    let next = c.read(&ev("session.text.started", 20, d(json!({"assistantMessageID": "msg_a1", "ordinal": 1}))));
    assert_eq!((kinds(&next), &next[0]["data"]["partID"], &next[0]["data"]["delta"]),
        (vec!["message.part.delta", "message.part.updated"], &json!("msg_a1:0"), &json!("think")),
        "an entry's gathered text written out by its answer's next event");
    assert!(c.read(&ev("session.text.delta", 30, d(json!({"assistantMessageID": "msg_a1", "ordinal": 1, "delta": "Hel"})))).is_empty());
    // Another delta of the same entry within the quarter-second gathers on.
    assert!(c.read(&ev("session.text.delta", 40, d(json!({"assistantMessageID": "msg_a1", "ordinal": 1, "delta": "lo"})))).is_empty());
    // Its step's end.
    let ended = c.read(&ev("session.step.ended", 50, d(json!({"assistantMessageID": "msg_a1", "finish": "stop"}))));
    assert_eq!((kinds(&ended), &ended[0]["data"]["delta"]), (vec!["message.part.delta", "message.updated"], &json!("Hello")),
        "its step's end writes it out");
    // The execution's end writes out what is left, then ends the turn.
    c.read(&ev("session.step.started", 60, d(json!({"assistantMessageID": "msg_a2"}))));
    c.read(&ev("session.text.delta", 70, d(json!({"assistantMessageID": "msg_a2", "ordinal": 0, "delta": "Bye"}))));
    let idle = c.read(&ev("session.execution.succeeded", 80, d(json!({}))));
    assert_eq!((kinds(&idle), &idle[0]["data"]["delta"]), (vec!["message.part.delta", "session.status"], &json!("Bye")),
        "the execution's end writes it out");
    assert!(c.sessions.is_empty(), "a session with nothing under way keeps nothing");
}

/// One compaction, started and ended, is one message, the one 2.x stores for
/// it: its input's ID, else its start event's (T-32 slice 4a, R3 notes).
#[test]
fn a_compaction_started_and_ended_is_one_entry() {
    let mut c = Cursor::default();
    let at = |kind: &str, id: &str, data: Value| json!({"id": id, "type": kind, "created": 1, "data": data});
    let started = c.read(&at("session.compaction.started", "evt_A1", json!({"sessionID": "ses_1", "reason": "auto"})));
    let ended = c.read(&at("session.compaction.ended", "evt_A2", json!({"sessionID": "ses_1", "reason": "auto"})));
    assert_eq!((&started[0]["data"]["info"]["id"], &ended[0]["data"]["info"]["id"]), (&json!("msg_A1"), &json!("msg_A1")),
        "one compaction, one entry, under the ID 2.x stores it by");
    let manual = c.read(&at("session.compaction.started", "evt_B1", json!({"sessionID": "ses_1", "reason": "manual", "inputID": "msg_in"})));
    assert_eq!(manual[0]["data"]["info"]["id"], "msg_in");
    assert!(c.sessions.get("ses_1").is_some_and(|open| open.compaction.as_deref() == Some("msg_in")));
}

/// A shell command (T-32 slice 4a, D2): read whole and live as the same
/// command item of the newest message before it, never an answer.
#[test]
fn a_shell_command_is_read_whole_and_live_as_the_same_command_item() {
    let messages = json!([
        {"id": "msg_u1", "type": "user", "time": {"created": 1}},
        {"id": "msg_S1", "type": "shell", "shellID": "sh_1", "command": "ls", "status": "exited", "exit": 0,
            "output": {"output": "a.txt\n", "cursor": 6, "size": 6, "truncated": false}, "time": {"created": 2, "completed": 3}},
        {"id": "msg_S2", "type": "shell", "shellID": "sh_2", "command": "false", "status": "exited", "exit": 1, "time": {"created": 4}},
    ]);
    let read = read_messages(&messages);
    assert_eq!(read.messages[1]["info"], json!({"id": "msg_S1", "role": "shell", "parentID": "msg_u1", "time": {"created": 2}}));
    let whole = read.messages[1]["parts"][0].clone();
    assert_eq!(whole, json!({"id": "msg_S1", "messageID": "msg_S1", "type": "shell", "command": "ls", "status": "completed",
        "output": "a.txt\n", "exit": 0}));
    assert_eq!(read.messages[2]["parts"][0]["status"], "failed", "a non-zero exit failed");
    let mut c = Cursor::default();
    c.resumed("ses_1", &read, &json!([]));
    let shell = json!({"id": "sh_1", "status": "running", "command": "ls", "cwd": "/w", "shell": "/bin/sh", "file": "/f"});
    let started = c.read(&json!({"id": "evt_S1", "type": "session.shell.started", "created": 2, "data": {"sessionID": "ses_1", "shell": shell}}));
    assert_eq!(started[0]["data"]["info"], read.messages[1]["info"], "the same message, of the same turn");
    assert_eq!(started[1]["data"]["part"]["status"], "inProgress");
    let mut done = shell.clone();
    done["status"] = json!("exited");
    done["exit"] = json!(0);
    let ended = c.read(&json!({"id": "evt_S9", "type": "session.shell.ended", "created": 3, "data": {"sessionID": "ses_1", "shell": done,
        "output": {"output": "a.txt\n", "cursor": 6, "size": 6, "truncated": false}}}));
    assert_eq!(ended[0]["data"]["part"], whole, "live as whole");
}

/// The question tool's form, as 2.2.5 makes it (probe p4/p0).
fn question_form(id: &str) -> Value {
    json!({"id": id, "sessionID": "ses_1", "title": "Questions", "metadata": {"kind": "question", "tool": {"id": "call_1", "messageID": "msg_1"}},
        "fields": [{"key": "q0", "type": "string", "custom": true, "title": "Pick", "description": "Which one?",
            "options": [{"value": "A", "label": "A", "description": "the first"}]}]})
}

/// A 2.x question form is read as Core's question, keeping its fields, the
/// same live and from a whole read (T-61 slice 2): one function reads both.
#[test]
fn a_2x_question_form_is_read_as_cores_question_keeping_its_fields() {
    let form = question_form("frm_1");
    let read = request_of(&form);
    assert_eq!(read["questions"], json!([{"question": "Which one?", "header": "Pick", "multiple": false, "custom": true,
        "options": [{"label": "A", "description": "the first"}]}]), "Core's question, read from its field");
    assert_eq!(read["fields"], form["fields"], "its fields kept, to answer it by");
    assert!(read.get("_opencodeUnfillable").is_none());
    let mut c = Cursor::default();
    let asked = c.read(&ev("form.created", 1, json!({"form": form})));
    assert_eq!((kinds(&asked), &asked[0]["data"]), (vec!["question.asked"], &read), "a form asked live reads as one a whole read lists");
    let permission = json!({"id": "per_1", "sessionID": "ses_1", "action": "shell", "resources": ["ls"], "save": ["ls *"]});
    assert_eq!(request_of(&permission), permission, "a permission request as 2.x sent it");
}

/// A form Yuzuno can't fill says why, by the rule 2.x's own ACP client
/// keeps (D-8 (a)): not a question's or a web search provider's; a field
/// external, conditional, hidden and required with no default, named as a
/// secret, or of a kind Yuzuno's card doesn't take.
#[test]
fn a_form_yuzuno_cannot_fill_says_why() {
    let with = |change: &dyn Fn(&mut Value)| { let mut form = question_form("frm_1"); change(&mut form); request_of(&form) };
    for (why, change) in [
        ("not a question", Box::new(|f: &mut Value| f["metadata"]["kind"] = "mcp".into()) as Box<dyn Fn(&mut Value)>),
        ("a secret", Box::new(|f: &mut Value| f["fields"][0]["title"] = "Your API key".into())),
        ("a secret", Box::new(|f: &mut Value| f["fields"][0]["key"] = "access_token".into())),
        ("outside OpenCode", Box::new(|f: &mut Value| f["fields"][0]["type"] = "external".into())),
        ("a kind of answer", Box::new(|f: &mut Value| f["fields"][0]["type"] = "boolean".into())),
        ("depend on each other", Box::new(|f: &mut Value| f["fields"][0]["when"] = json!([{"key": "q1", "equals": "x"}]))),
        ("doesn't show", Box::new(|f: &mut Value| { f["fields"][0]["hidden"] = true.into(); f["fields"][0]["required"] = true.into(); })),
    ] {
        let read = with(&*change);
        let said = read["_opencodeUnfillable"].as_str().unwrap_or_default();
        assert!(said.contains(why), "a form Yuzuno can't fill says why ({why}): {said:?}");
        assert!(read.get("questions").is_none(), "and asks nothing: {why}");
    }
    let provider = with(&|f: &mut Value| { f["metadata"]["kind"] = "websearch.provider".into(); f["fields"][0]["custom"] = false.into(); });
    assert!(provider.get("_opencodeUnfillable").is_none() && provider["questions"][0]["custom"] == false, "a web search provider's is filled");
}

/// Core's answers become 2.x's answer by field key and option value (T-61
/// slice 2): a label is its option's value (a web search provider's differ),
/// typed text only where the field takes it, one value for a text field, a
/// list for a multiselect, an empty list unanswered, a hidden field its
/// default; anything else is refused before it is sent.
#[test]
fn answers_become_2xs_answer_by_field_key_and_option_value() {
    let form = request_of(&json!({"id": "frm_1", "sessionID": "s", "title": "Q", "metadata": {"kind": "websearch.provider"}, "fields": [
        {"key": "provider", "type": "string", "custom": false, "title": "Provider", "options": [{"value": "allow", "label": "Allow searches"}]},
        {"key": "tags", "type": "multiselect", "title": "Tags", "options": [{"value": "a", "label": "Alpha"}, {"value": "b", "label": "Beta"}]},
        {"key": "note", "type": "string", "title": "Note"},
        {"key": "region", "type": "string", "hidden": true, "default": "eu"}]}));
    let answered = form_answer(&form, &[vec!["Allow searches".into()], vec!["Alpha".into(), "Beta".into()], vec!["my own".into()]]).unwrap();
    assert_eq!(answered, json!({"provider": "allow", "tags": ["a", "b"], "note": "my own", "region": "eu"}), "by key and value");
    let unanswered = form_answer(&form, &[vec!["Allow searches".into()], vec![], vec![]]).unwrap();
    assert_eq!(unanswered, json!({"provider": "allow", "region": "eu"}), "an empty list leaves a field unanswered");
    let typed = form_answer(&form, &[vec!["something else".into()], vec![], vec![]]).unwrap_err().to_string();
    assert!(typed.contains("not one of the choices"), "typed text where the field takes none is refused: {typed}");
    let two = form_answer(&form, &[vec!["Allow searches".into(), "Allow searches".into()], vec![], vec![]]).unwrap_err().to_string();
    assert!(two.contains("takes one answer"), "two answers to a text field are refused: {two}");
    let short = form_answer(&form, &[vec![]]).unwrap_err().to_string();
    assert!(short.contains("3 questions, 1 answered"), "every shown question answered or left empty: {short}");
    let unfillable = request_of(&json!({"id": "frm_2", "sessionID": "s", "metadata": {"kind": "mcp"}, "fields": []}));
    assert!(form_answer(&unfillable, &[]).is_err(), "a form Yuzuno can't fill takes no answer");
    assert_eq!(form_answer(&request_of(&question_form("frm_3")), &[vec!["A".into()]]).unwrap(), json!({"q0": "A"}));
}

/// A run Core declined a request of ends its turn as declined (D-7 (a)):
/// 2.x ends it as a shutdown (`interrupted`, reason `shutdown`, probe p0),
/// which for any other run leaves the turn open (it resumes). The mark
/// lives for that run only, and an answer that failed takes it back.
#[test]
fn a_run_core_declined_a_request_of_ends_its_turn_as_declined_and_another_shutdown_leaves_it_open() {
    let mut c = Cursor::default();
    c.read(&ev("permission.asked", 1, json!({"id": "per_1", "sessionID": "ses_1", "action": "shell", "resources": ["ls"]})));
    let shutdown = c.read(&ev("session.execution.interrupted", 2, json!({"sessionID": "ses_1", "reason": "shutdown"})));
    assert!(shutdown.is_empty(), "a shutdown Core did not cause leaves the turn open: {shutdown:?}");

    let mut c = Cursor::default();
    c.read(&ev("permission.asked", 1, json!({"id": "per_1", "sessionID": "ses_1", "action": "shell", "resources": ["ls"]})));
    c.declining("ses_1", true);
    c.read(&ev("permission.replied", 2, json!({"sessionID": "ses_1", "requestID": "per_1", "reply": "reject"})));
    let end = c.read(&ev("session.execution.interrupted", 3, json!({"sessionID": "ses_1", "reason": "shutdown"})));
    assert_eq!(kinds(&end), ["session.error", "session.status"], "the run Core declined a request of ends its turn");
    assert_eq!(end[0]["data"]["error"]["data"]["message"], DECLINED, "as declined");
    assert_eq!(end[0]["data"]["error"]["name"], ABORTED);
    assert!(c.sessions.is_empty(), "the mark lives for that run only");

    let mut c = Cursor::default();
    c.read(&ev("form.created", 1, json!({"form": question_form("frm_1")})));
    c.declining("ses_1", true);
    c.declining("ses_1", false);
    assert!(c.read(&ev("session.execution.interrupted", 2, json!({"sessionID": "ses_1", "reason": "shutdown"}))).is_empty(),
        "a decline that failed takes the mark back");
}

/// Only a question's answer is kept with its event (D-11 (a)): Core's
/// `question.replied` says whether the form was a question, live or one a
/// whole read listed.
#[test]
fn a_replied_form_says_whether_it_was_a_question() {
    let mut c = Cursor::default();
    c.read(&ev("form.created", 1, json!({"form": question_form("frm_1")})));
    let provider = json!({"id": "frm_2", "sessionID": "ses_1", "title": "Q", "metadata": {"kind": "websearch.provider"}, "fields": []});
    c.read(&ev("form.created", 2, json!({"form": provider})));
    let first = c.read(&ev("form.replied", 3, json!({"id": "frm_1", "sessionID": "ses_1", "answer": {"q0": "A"}})));
    let second = c.read(&ev("form.replied", 4, json!({"id": "frm_2", "sessionID": "ses_1", "answer": {"provider": "allow"}})));
    assert_eq!((&first[0]["data"]["question"], &second[0]["data"]["question"]), (&json!(true), &json!(false)), "a question, and not");
    let mut c = Cursor::default();
    c.resumed("ses_1", &read_messages(&json!([])), &json!([]));
    c.asked(&question_form("frm_3"));
    let replied = c.read(&ev("form.replied", 5, json!({"id": "frm_3", "sessionID": "ses_1", "answer": {"q0": "A"}})));
    assert_eq!(replied[0]["data"]["question"], true, "one a whole read listed too");
}

/// A 2.x request lives only while its run does: the run's end ends each of
/// its own still open in Core too, as 2.2.5 sends no reply for a permission
/// request its interrupt ended (T-32 slice 4a, probe p3). One answered or
/// cancelled before is not ended again, and one a whole read found pending
/// ends as one asked live.
#[test]
fn a_runs_end_ends_its_2x_requests_still_open() {
    let mut c = Cursor::default();
    let asked = c.read(&ev("permission.asked", 1, json!({"id": "per_1", "sessionID": "ses_1", "action": "shell", "resources": ["ls"]})));
    assert_eq!(kinds(&asked), ["permission.asked"]);
    c.read(&ev("form.created", 2, json!({"form": {"id": "frm_1", "sessionID": "ses_1", "title": "Pick", "fields": []}})));
    c.read(&ev("form.cancelled", 3, json!({"id": "frm_1", "sessionID": "ses_1"})));
    let end = c.read(&ev("session.execution.interrupted", 5, json!({"sessionID": "ses_1", "reason": "user"})));
    assert_eq!((kinds(&end), &end[0]["data"]), (vec!["permission.replied", "session.error", "session.status"],
        &json!({"sessionID": "ses_1", "requestID": "per_1"})), "a run's end ends its requests still open, and only those");
    assert!(c.sessions.is_empty());

    let mut c = Cursor::default();
    c.resumed("ses_1", &read_messages(&json!([])), &json!([]));
    c.asked(&json!({"id": "frm_2", "sessionID": "ses_1", "title": "Pick", "fields": []}));
    let end = c.read(&ev("session.execution.succeeded", 6, json!({"sessionID": "ses_1"})));
    assert_eq!((kinds(&end), &end[0]["data"]["requestID"]), (vec!["question.replied", "session.status"], &json!("frm_2")),
        "one a whole read found pending ends with its run");
}

/// A compaction a whole read finds running ends under the ID its message is
/// stored by, as one started live does: the stream broke while it ran, and
/// its end after the read is the entry that read made, not a second one
/// (T-32 slice 4a, R3 4051b7d4).
#[test]
fn a_compaction_a_whole_read_finds_running_ends_as_the_one_entry_it_read() {
    let messages = json!([
        {"id": "msg_u1", "type": "user", "time": {"created": 1}},
        {"id": "msg_C1", "type": "compaction", "status": "running", "reason": "auto", "time": {"created": 2}},
    ]);
    let read = read_messages(&messages);
    let whole: Vec<&Value> = read.messages.iter().filter(|m| m["info"]["summary"] == true).map(|m| &m["info"]["id"]).collect();
    assert_eq!(whole, [&json!("msg_C1")], "the whole read's entry, under the stored ID");
    let mut c = Cursor::default();
    c.resumed("ses_1", &read, &json!([]));
    let ended = c.read(&json!({"id": "evt_E9", "type": "session.compaction.ended", "created": 3, "data": {"sessionID": "ses_1", "reason": "auto"}}));
    assert_eq!(ended.iter().map(|e| e["data"]["info"]["id"].clone()).collect::<Vec<_>>(), [json!("msg_C1")],
        "one compaction, one entry, across a whole read");
    let done = json!([{"id": "msg_C1", "type": "compaction", "status": "completed", "reason": "auto", "time": {"created": 2}}]);
    assert_eq!(read_messages(&done).compaction, None, "one completed is not running");
}

/// A shell command a whole read finds running ends as the command item that
/// read made: the stream broke while it ran, and its end after the read
/// gives that item its status, output and exit code (T-32 slice 4a, R4
/// 1dfc453d).
#[test]
fn a_shell_a_whole_read_finds_running_ends_as_the_command_item_it_read() {
    let messages = json!([
        {"id": "msg_u1", "type": "user", "time": {"created": 1}},
        {"id": "msg_S1", "type": "shell", "shellID": "sh_1", "command": "ls", "status": "running", "time": {"created": 2}},
    ]);
    let read = read_messages(&messages);
    assert_eq!(read.messages[1]["parts"][0]["status"], "inProgress", "the whole read's command item, under way");
    let mut c = Cursor::default();
    c.resumed("ses_1", &read, &json!([]));
    let shell = json!({"id": "sh_1", "status": "exited", "exit": 0, "command": "ls", "cwd": "/w", "shell": "/bin/sh", "file": "/f"});
    let ended = c.read(&json!({"id": "evt_S9", "type": "session.shell.ended", "created": 3, "data": {"sessionID": "ses_1", "shell": shell,
        "output": {"output": "a.txt\n", "cursor": 6, "size": 6, "truncated": false}}}));
    let parts: Vec<(Value, Value, Value, Value)> = ended.iter().map(|e| &e["data"]["part"])
        .map(|p| (p["id"].clone(), p["status"].clone(), p["output"].clone(), p["exit"].clone())).collect();
    assert_eq!(parts, [(json!("msg_S1"), json!("completed"), json!("a.txt\n"), json!(0))], "the command item that read made, ended");
    let done = json!([{"id": "msg_S1", "type": "shell", "shellID": "sh_1", "command": "ls", "status": "exited", "exit": 0, "time": {"created": 2}}]);
    assert!(read_messages(&done).shells.is_empty(), "one exited is not running");
}
