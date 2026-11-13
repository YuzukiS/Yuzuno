use super::*;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");

fn agent(cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":"oc", "name":"OpenCode", "cwd":cwd, "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

/// OpenCode Agents are on unless Core was started with the switch at `0`
/// (YN-27): unset and the `1` that turned them on before both leave them on.
#[test]
fn only_a_switch_of_0_turns_opencode_agents_off() {
    use std::ffi::OsStr;
    assert!(switched_on(None), "on without the switch");
    for on in ["1", "", "true", "00", " 0"] {
        assert!(switched_on(Some(OsStr::new(on))), "{on:?} leaves it on");
    }
    assert!(!switched_on(Some(OsStr::new("0"))), "0 turns it off");
}

/// One `opencode` for the whole test process: YUZUNO_OPENCODE_BIN is the
/// process's, and every Agent's stand-in keeps its state in its own folder.
#[cfg(target_os = "linux")]
fn program() {
    static PROGRAM: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    PROGRAM.get_or_init(|| {
        use std::os::unix::fs::PermissionsExt;
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        let program = dir.path().join("opencode");
        std::fs::write(&program, format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
        program
    });
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn events_of_an_older_connection_or_another_session_change_nothing() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    ws.reconnect("oc").await.unwrap();
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    let asked = |session: &str| json!({"id":"evt_1","type":"permission.asked","data":{"id":"per_1",
        "sessionID":session,"permission":"bash","patterns":["ls"],"metadata":{},"always":[]}});
    let before = ws.store.detail("oc").unwrap().agent.last_seq;
    // An older connection's stream, and another session's event, write nothing.
    ws.dispatch_opencode_event("oc", c.generation - 1, asked(&c.session)).await;
    ws.dispatch_opencode_event("oc", c.generation, asked("ses_other")).await;
    let d = ws.store.detail("oc").unwrap();
    assert!(d.pending.is_empty());
    assert_eq!(d.agent.last_seq, before, "not even journaled");
    ws.dispatch_opencode_event("oc", c.generation, asked(&c.session)).await;
    let d = ws.store.detail("oc").unwrap();
    assert_eq!(d.pending.len(), 1);
    assert_eq!((&d.pending[0].params["_runtimeGeneration"], &d.pending[0].params["_opencodeSession"]),
        (&json!(c.generation), &json!(c.session)));
    // The same request again, as a snapshot would show it, is not a second one.
    ws.dispatch_opencode_event("oc", c.generation, asked(&c.session)).await;
    assert_eq!(ws.store.detail("oc").unwrap().pending.len(), 1);
    ws.close_agent("oc").await.unwrap();
}

/// YN-48: an event whose application panics ends neither the reading of the
/// Agent's events nor its Turn. The panic is read as the stream breaking: the
/// stream is opened again and the session read whole, so the Turn ends as
/// OpenCode says, the Agent stays connected, and the events after it are read
/// (the next message runs and ends). Before, the task reading the events died
/// with it and the Turn stayed working with nothing more read.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_event_whose_application_panics_is_read_as_a_broken_stream_and_the_turn_still_ends() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    ws.reconnect("oc").await.unwrap();
    let session = ws.store.detail("oc").unwrap().agent.opencode_session_id.unwrap();
    let ended = |turn: String| {
        let ws = ws.clone();
        async move {
            for _ in 0..400 {
                let d = ws.store.detail("oc").unwrap();
                if let Some(t) = d.turns.iter().find(|t| t["id"] == turn.as_str() && t["status"] != "inProgress") {
                    return t["status"].clone();
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("the turn did not end within 10 s: {:#?}", ws.store.detail("oc").unwrap().turns);
        }
    };
    let input = |client: &str, text: &str| serde_json::from_value::<crate::model::MessageInput>(json!({"clientMessageId": client, "text": text})).unwrap();
    let first = ws.send_message("oc", input("c1", "hello")).await.unwrap().turn_id.unwrap();
    control(&data, "event", json!({"type": "yuzuno.test.panic", "created": 1, "properties": {"sessionID": session}})).await;
    control(&data, "reply", json!({"sessionID": session, "text": "Done."})).await;
    assert_eq!(ended(first).await, "completed", "the Turn ends as OpenCode says");
    let d = ws.store.detail("oc").unwrap();
    assert_eq!((d.agent.connection_state.as_str(), d.agent.status.as_str()), ("connected", "idle"));
    let second = ws.send_message("oc", input("c2", "again")).await.unwrap().turn_id.unwrap();
    control(&data, "reply", json!({"sessionID": session, "text": "Again."})).await;
    assert_eq!(ended(second).await, "completed", "the events after it are read");
    ws.close_agent("oc").await.unwrap();
}

/// Whether where its OpenCode keeps snapshots can be known is kept with the
/// connection (T-10 Revert): the stand-in runs through a script, so it
/// cannot, and the connection says why.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_opencode_started_through_a_script_cannot_say_where_its_snapshots_are() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    ws.reconnect("oc").await.unwrap();
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    let why = c.files.as_ref().as_ref().unwrap_err();
    assert!(why.contains("not a native executable"), "{why}");
    ws.close_agent("oc").await.unwrap();
}

/// The stand-in's control, on its own port (`start.json`).
#[cfg(target_os = "linux")]
async fn control(data: &std::path::Path, name: &str, body: Value) -> Value {
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode/oc/start.json")).unwrap()).unwrap();
    reqwest::Client::builder().no_proxy().build().unwrap()
        .post(format!("http://127.0.0.1:{}/__fixture/{name}", seen["port"])).json(&body)
        .timeout(Duration::from_secs(20)).send().await.unwrap().json().await.unwrap()
}

/// A form an OpenCode Agent publishes is answered as a new message (T-10):
/// its answers are checked against the form and the conversation it was
/// published in, then sent once under their receipt, and not again.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_form_an_opencode_agent_publishes_is_answered_once_as_a_new_message() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    ws.reconnect("oc").await.unwrap();
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    let message = |value: Value| serde_json::from_value::<crate::model::MessageInput>(value).unwrap();
    let prompts = || std::fs::read_to_string(data.join("opencode/oc/calls.jsonl")).unwrap_or_default().lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|call| call["path"].as_str().unwrap().ends_with("/prompt")).collect::<Vec<_>>();

    let turn = ws.send_message("oc", message(json!({"clientMessageId":"c1","text":"Set it up"}))).await.unwrap().turn_id.unwrap();
    let spec = json!({"root":"r","elements":{
        "r":{"type":"Result","props":{"title":"Setup","summary":"Answer once"},"children":["f"]},
        "f":{"type":"Clarification","props":{"id":"setup","title":"Setup","fields":[{"id":"directory","type":"text","label":"Directory","required":true}]}}
    }});
    let published = ws.result_publish("oc", json!({"requestId":"form","expectedTurnId":turn,"spec":spec})).await.unwrap().unwrap();
    let result = published["resultId"].as_str().unwrap().to_owned();
    control(&data, "reply", json!({"sessionID":c.session,"text":"Where should it go?"})).await;
    for _ in 0..400 {
        if ws.store.detail("oc").unwrap().turns.iter().any(|t| t["id"] == turn.as_str() && t["status"] == "completed") { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let answer = json!({"resultId":result,"formId":"setup","answers":{"directory":"src"}});
    let text = ws.results.check_answers(&spec, &answer).await.unwrap();

    // Text that is not the form's answers is refused before anything is sent.
    assert!(ws.send_message("oc", message(json!({"clientMessageId":"form-0","text":"something else","clarification":answer}))).await.is_err());
    assert_eq!(prompts().len(), 1);
    let form = message(json!({"clientMessageId":"form-1","text":text,"clarification":answer}));
    let sent = ws.send_message("oc", form.clone()).await.unwrap();
    assert_eq!(sent.status, "accepted");
    assert_eq!(sent.input.clarification.as_ref().map(|c| c.result_id.as_str()), Some(result.as_str()));
    let calls = prompts();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1]["body"]["text"], text);
    // The same message again is its receipt; the same form's answers again are refused.
    assert_eq!(ws.send_message("oc", form).await.unwrap().turn_id, sent.turn_id);
    assert!(ws.send_message("oc", message(json!({"clientMessageId":"form-2","text":text,"clarification":answer}))).await.is_err());
    assert_eq!(prompts().len(), 2, "sent once");
    ws.close_agent("oc").await.unwrap();
}

/// Choosing a model waits for the Agent gate (T-10), as a close or a
/// reconnect does, so it never changes an Agent a close is ending.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn choosing_a_model_waits_for_the_agent_gate() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    ws.reconnect("oc").await.unwrap();
    let gate = ws.gate("oc").await;
    let held = gate.lock().await;
    let chosen = tokio::spawn({
        let ws = ws.clone();
        async move { ws.opencode_set_model("oc", "deepseek/deepseek-flash".into()).await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!chosen.is_finished(), "it waits while the gate is held");
    assert_eq!(ws.store.detail("oc").unwrap().agent.model, "");
    drop(held);
    assert_eq!(chosen.await.unwrap().unwrap().model, "deepseek/deepseek-flash");
    ws.close_agent("oc").await.unwrap();
}

/// A part of an answer to a Turn that ended, arriving after a newer Turn
/// began, is the ended Turn's (T-140): the change reads that Turn, not only
/// the open and newest ones.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_late_part_reaches_the_turn_its_message_answers() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    ws.reconnect("oc").await.unwrap();
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    // Two Turns that ended, each answered by its own message; neither is in memory.
    ws.store.update("oc", "test/turns", &json!({}), |d| {
        for (turn, answer) in [("msg_old", "msg_answer_old"), ("msg_new", "msg_answer_new")] {
            d.turns.push(json!({"id":turn,"status":"completed","_opencodeConfirmed":true,
                "_opencodeAnswers":{answer:{"completed":1,"error":null,"finish":"stop"}},"items":[]}));
        }
    }).unwrap();
    ws.store.release_for_test("oc");
    let held = |turn: &str| ws.store.held_for_test("oc").is_some_and(|d| d.read().turns.iter().any(|t| t["id"] == turn));
    assert!(!held("msg_old"), "the ended Turn is read from rows, not memory");
    let part = |id: &str, message: &str, text: &str| json!({"type":"message.part.updated","data":{"sessionID":c.session,
        "part":{"id":id,"sessionID":c.session,"messageID":message,"type":"text","text":text}}});
    ws.dispatch_opencode_event("oc", c.generation, part("prt_late", "msg_answer_old", "late")).await;
    ws.dispatch_opencode_event("oc", c.generation, part("prt_new", "msg_answer_new", "new")).await;
    let d = ws.store.detail("oc").unwrap();
    let items = |turn: &str| d.turns.iter().find(|t| t["id"] == turn).unwrap()["items"].as_array().unwrap()
        .iter().map(|i| (i["id"].as_str().unwrap().to_owned(), i["text"].clone())).collect::<Vec<_>>();
    assert_eq!(items("msg_old"), [("prt_late".to_owned(), json!("late"))]);
    assert_eq!(items("msg_new"), [("prt_new".to_owned(), json!("new"))]);
    ws.close_agent("oc").await.unwrap();
}

/// A receipt a connection that ended settled as unknown, for a message that
/// then was never sent: it says rejected, not unknown.
#[tokio::test]
async fn a_message_never_sent_is_rejected_even_once_settled_as_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let mut d = agent(&dir.path().to_string_lossy());
    // Still running, so the send is refused before anything is sent.
    d.turns.push(json!({"id":"msg_running","status":"inProgress","items":[]}));
    d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"c1","text":"hi"},
        "status":"unknown","turnId":null,"error":"settled when the connection ended"})).unwrap());
    ws.store.insert(&d).unwrap();
    let refused = ws.opencode_send_locked("oc", "hi".into(), Some("c1")).await.unwrap_err();
    assert!(refused.to_string().contains("没有发送"), "{refused}");
    let receipt = &ws.store.detail("oc").unwrap().message_receipts[0];
    assert_eq!((receipt.status.as_str(), receipt.error.as_deref()), ("rejected", Some(refused.to_string().as_str())));
}

/// A whole read settles each compaction asked for and not yet ended (T-61
/// slice 4, #699 R1 a136ddf1): one 2.x, idle, has no record of did not run,
/// so its Turn fails and it holds nothing back; one 1.19.3 was asked for
/// ends unknown for good; one still waiting in 2.x's inbox (as read before
/// or after its messages), or 2.x not idle, waits; and so does one the read
/// may predate, begun before 2.x's answer to it, or with no answer yet
/// (#699 R2 f4dafc6c). One asked of an earlier process, or unknown before
/// Core kept its answer's time, counts as answered before the read began
/// (#699 P3-a, P3-b, P3-d).
#[test]
fn a_whole_read_ends_a_compaction_2x_has_no_record_of_and_one_1193_was_asked_for() {
    let compact = |id: &str, status: &str, attempt: Value| json!({"id": id, "status": status, "items": [], "_opencodeCompact": attempt});
    let mut d = agent("/w");
    d.turns = vec![
        compact("compact_old", "inProgress", json!({"state": "pending", "session": "ses_1", "generation": 1})),
        compact("compact_lost", "outcomeUnknown", json!({"state": "unknown", "input": "msg_lost", "generation": 1, "askedBy": "srv1", "answered": 100})),
        compact("compact_waiting", "inProgress", json!({"state": "pending", "input": "msg_waiting", "generation": 1, "askedBy": "srv1", "answered": 100})),
        compact("compact_later", "inProgress", json!({"state": "pending", "input": "msg_later", "generation": 1, "askedBy": "srv1", "answered": 300})),
        compact("compact_asking", "inProgress", json!({"state": "pending", "input": "msg_asking", "generation": 1, "askedBy": "srv1"})),
        compact("compact_crashed", "inProgress", json!({"state": "pending", "input": "msg_crashed", "generation": 0, "askedBy": "srv0"})),
        compact("compact_unanswered", "outcomeUnknown", json!({"state": "unknown", "input": "msg_unanswered", "generation": 1, "askedBy": "srv1"})),
        // Asked before Core restarted: the same generation again, a wall-clock `answered` far past this Server's ticks.
        compact("compact_restarted", "inProgress", json!({"state": "pending", "input": "msg_restarted", "generation": 1,
            "askedBy": "srv_before", "answered": 1_794_000_000_000u64})),
        // Asked before Core kept the Server's name at all.
        compact("compact_unnamed", "inProgress", json!({"state": "pending", "input": "msg_unnamed", "generation": 1, "answered": 1_794_000_000_000u64})),
    ];
    let (first, then) = (json!([{"id": "msg_waiting", "type": "compaction"}]), json!([]));
    let mut busy = d.clone();
    settle_compactions(&mut busy, &[], [&first, &then], false, 200, "srv1");
    assert_eq!(busy.turns[1]["_opencodeCompact"]["state"], "unknown", "not idle: a record may still come");
    let mut moved = d.clone();
    settle_compactions(&mut moved, &[], [&then, &first], true, 200, "srv1");
    assert_eq!(moved.turns[2]["_opencodeCompact"]["state"], "pending", "in the inbox as read after the messages too");
    settle_compactions(&mut d, &[], [&first, &then], true, 200, "srv1");
    for (n, why) in [(3, "a read begun before 2.x's answer to it"), (4, "no answer to it yet")] {
        let t = &d.turns[n];
        assert_eq!((&t["status"], &t["_opencodeCompact"]["state"]), (&json!("inProgress"), &json!("pending")), "{why}: {t:#}");
    }
    for (n, why) in [(5, "an earlier process's, with no answer kept"), (6, "unknown before Core kept its answer's time"),
        (7, "asked before Core restarted, in the same generation"), (8, "asked before Core kept its Server's name")] {
        let t = &d.turns[n];
        assert_eq!((&t["status"], &t["_opencodeCompact"]["state"]), (&json!("failed"), &json!("absent")),
            "{why}: answered before this read began, and missing: {t:#}");
    }
    d.turns.truncate(3);
    let (old, lost, waiting) = (&d.turns[0], &d.turns[1], &d.turns[2]);
    assert_eq!((&old["status"], &old["_opencodeCompact"]["state"]), (&json!("outcomeUnknown"), &json!("lost")), "1.19.3's: {old:#}");
    assert!(lost["status"] == "failed" && lost["_opencodeCompact"]["state"] == "absent"
        && lost["error"]["message"].as_str().unwrap_or_default().contains("它没有执行"), "no record at idle: it did not run: {lost:#}");
    assert_eq!((&waiting["status"], &waiting["_opencodeCompact"]["state"]), (&json!("inProgress"), &json!("pending")), "still waiting in the inbox");
    assert!(compaction_blocks(&d, "x").is_some(), "the waiting one still holds new input back");
    d.turns.pop();
    assert!(compaction_blocks(&d, "x").is_none(), "the others hold nothing back");
}

/// YN-78 S2a: an OpenCode executor whose level is auto gets its own
/// temporary directory, actually in the environment of the process Core
/// starts, recorded with its identity; an ordinary close does not release it.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_executor_gets_its_own_temp_dir_in_the_environment() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    ws.store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,created_by,state,created_at,updated_at)
         VALUES('oc','executor','template','lead','created','now','now')", []).unwrap();
    ws.store.set_permission_level("oc", Some("auto")).unwrap();
    ws.reconnect("oc").await.unwrap();
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode/oc/start.json")).unwrap()).unwrap();
    let expected = std::fs::canonicalize(data.join("t/oc")).unwrap();
    for name in ["TMPDIR", "TMP", "TEMP"] {
        assert_eq!(seen["env"][name].as_str(), expected.to_str(), "{name}");
    }
    let workspace = ws.store.workspace_id().unwrap();
    let record = ws.store.executor_temp_dir(&workspace, "oc").unwrap().unwrap();
    assert_eq!(record.path, expected.to_string_lossy());
    assert_eq!(record.released_at, None);
    // An ordinary close is not a release.
    ws.close_agent("oc").await.unwrap();
    assert_eq!(ws.store.executor_temp_dir(&workspace, "oc").unwrap().unwrap().released_at, None);
}

/// An executor row for Agent `id`, as a dispatch makes one.
#[cfg(target_os = "linux")]
fn executor(ws: &Workspace, id: &str) {
    ws.store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,created_by,state,created_at,updated_at)
         VALUES(?1,'executor','template','lead','created','now','now')", [id]).unwrap();
}

/// The stand-in's requests, as it logged them.
#[cfg(target_os = "linux")]
fn stand_in_calls(data: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(data.join("opencode/oc/calls.jsonl")).unwrap_or_default().lines()
        .filter_map(|line| serde_json::from_str(line).ok()).collect()
}

/// YN-78 S4b-2: a local OpenCode executor at Auto-approve starts with Core's
/// own answers, its rules and their instructions together; a permission
/// request it can't bind to a tool call is refused by Core with its reason
/// (a reject that lets the run go on), and never becomes the user's.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_auto_executors_requests_are_answered_by_core_never_the_user() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    executor(&ws, "oc");
    ws.store.set_permission_level("oc", Some("auto")).unwrap();
    ws.reconnect("oc").await.unwrap();
    let folder = std::fs::canonicalize(data.join("opencode/oc")).unwrap();
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode/oc/start.json")).unwrap()).unwrap();
    let config: Value = serde_json::from_str(seen["configContent"].as_str().unwrap()).unwrap();
    assert_eq!(config["instructions"], json!([folder.join("yuzuno-rules.md")]));
    assert_eq!((&config["permission"]["external_directory"]["*"], &config["permission"]["grep"]), (&json!("ask"), &json!("ask")));
    assert!(config["permission"].get("doom_loop").is_none());
    let home = std::fs::canonicalize(&data).unwrap().join("synthetic-home");
    assert_eq!(config["permission"]["external_directory"][format!("{}/.ssh/*", home.display())], "deny", "a default protection, though missing");
    let rules = std::fs::read_to_string(folder.join("yuzuno-rules.md")).unwrap();
    assert!(rules.contains("Auto-approve") && rules.contains(&format!("{}/.ssh/", home.display())), "{rules}");
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    assert!(c.auto.is_some(), "the connection has its engine from its start");
    let asked = control(&data, "ask", json!({"sessionID": c.session, "action": "external_directory", "resources": ["/elsewhere/*"]})).await;
    let request = asked["id"].as_str().unwrap().to_owned();
    let path = format!("/api/session/{}/permission/{request}/reply", c.session);
    let mut reply = None;
    for _ in 0..200 {
        reply = stand_in_calls(&data).into_iter().find(|call| call["method"] == "POST" && call["path"] == path.as_str());
        if reply.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let reply = reply.expect("Core answered the request");
    assert_eq!(reply["body"]["decision"], "reject");
    assert!(reply["body"]["message"].as_str().unwrap().contains("couldn't tell which tool call asked"), "{reply}");
    let mut journaled = None;
    for _ in 0..200 {
        journaled = ws.store.db.read().unwrap().query_row("SELECT data FROM journal WHERE agent_id='oc' AND kind='opencode/autoAnswer'", [],
            |r| r.get::<_, String>(0)).ok();
        if journaled.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let journaled: Value = serde_json::from_str(&journaled.expect("the refusal is recorded once delivered")).unwrap();
    assert_eq!((&journaled["decision"], &journaled["reason"], &journaled["outcome"]), (&json!("reject"), &json!("call_unidentified"), &json!("delivered")));
    let d = ws.store.detail("oc").unwrap();
    assert!(d.pending.is_empty(), "never the user's request");
    assert!(!ws.store.db.read().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM journal WHERE agent_id='oc' AND kind='opencode/permission.asked')",
        [], |r| r.get::<_, bool>(0)).unwrap(), "not journaled one by one");
    ws.close_agent("oc").await.unwrap();
}

/// YN-78 S4b-2: an executor at Auto-approve whose answers can't all be made
/// ready is not started, never started with the old wider rules: its rules
/// overridden after Yuzuno's, another OpenCode release, an environment its
/// protections can't be resolved from.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_auto_executor_that_cannot_get_cores_answers_is_not_started() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    executor(&ws, "oc");
    ws.store.set_permission_level("oc", Some("auto")).unwrap();
    let folder = data.join("opencode/oc");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("permission-after"), r#"[{"action":"external_directory","resource":"*","effect":"allow"}]"#).unwrap();
    // Each refusal says why in its own top line, as the API, the journal and
    // the Agent's error show it (`to_string`, never `{:#}`).
    let refused = ws.reconnect("oc").await.unwrap_err().to_string();
    assert!(refused.contains("did not enable its Auto-approve answers") && refused.contains("not run with weaker rules")
        && refused.contains("doesn't keep the permission level auto"), "{refused}");
    assert!(ws.opencodes.lock().unwrap().get("oc").is_none());
    std::fs::remove_file(folder.join("permission-after")).unwrap();
    std::fs::write(folder.join("version"), "2.2.6").unwrap();
    let refused = ws.reconnect("oc").await.unwrap_err().to_string();
    let says = |text: &str| text.contains("did not enable its Auto-approve answers") && text.contains("this OpenCode is 2.2.6")
        && text.contains(&format!("support OpenCode {} only", auto::SUPPORTED));
    assert!(says(&refused), "the API's error: {refused}");
    let error = ws.store.detail("oc").unwrap().agent.error.unwrap_or_default();
    assert!(says(&error), "the Agent's error: {error}");
    let failed: Value = serde_json::from_str(&ws.store.db.read().unwrap().query_row(
        "SELECT data FROM journal WHERE agent_id='oc' AND kind='opencode/connectFailed' ORDER BY seq DESC LIMIT 1", [], |r| r.get::<_, String>(0)).unwrap()).unwrap();
    assert!(says(failed["error"].as_str().unwrap_or_default()), "opencode/connectFailed: {failed}");
    assert!(ws.opencodes.lock().unwrap().get("oc").is_none(), "no working connection");
    std::fs::remove_file(folder.join("version")).unwrap();
    auto::TEST_ENVS.lock().unwrap().push((data.clone(), crate::opencode_protection::PathEnv {
        vars: [("HOME", std::ffi::OsString::from(""))].into_iter().collect(), ..Default::default() }));
    std::fs::remove_file(folder.join("start.json")).unwrap();
    let refused = ws.reconnect("oc").await.unwrap_err().to_string();
    assert!(refused.contains("did not enable its Auto-approve answers") && refused.contains("HOME is set but empty"), "{refused}");
    assert!(!folder.join("start.json").exists(), "no server was started");
    assert!(ws.opencodes.lock().unwrap().get("oc").is_none());
}

/// The tool entries of OpenCode's stored messages, in order: name, input,
/// status, and at most 120 characters of what each returned or failed with.
#[cfg(target_os = "linux")]
fn lab_tools(messages: &Value) -> Vec<Value> {
    let mut tools = Vec::new();
    for message in messages.as_array().into_iter().flatten() {
        let entries = message["content"].as_array().or(message["parts"].as_array());
        for entry in entries.into_iter().flatten().filter(|entry| entry["type"] == "tool") {
            let state = &entry["state"];
            let said = [&state["output"], &state["content"], &state["error"], &state["result"]].into_iter()
                .find(|value| !value.is_null()).map(|value| value.to_string().chars().take(120).collect::<String>());
            // 2.2.5 keeps a tool's times on its entry (`created`, `ran`, `completed`, ms).
            let time = if entry["time"].is_null() { &state["time"] } else { &entry["time"] };
            tools.push(json!({"name": entry["name"].as_str().or(entry["tool"].as_str()), "input": state["input"], "status": state["status"],
                "said": said, "time": time}));
        }
    }
    tools
}

/// What a lab Turn left: the Turn, OpenCode's tool entries, Core's recorded
/// answers, and anything that reached the user's queue.
#[cfg(target_os = "linux")]
async fn lab_record(ws: &Arc<Workspace>, turn: &str, started: Duration) -> Value {
    let mut status = Value::Null;
    for _ in 0..1800 {
        let d = ws.store.detail("oc").unwrap();
        if let Some(t) = d.turns.iter().find(|t| t["id"] == turn && t["status"] != "inProgress") {
            status = t["status"].clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let c = ws.opencodes.lock().unwrap().get("oc").cloned();
    let messages = match &c {
        Some(c) => c.server.messages(&c.session).await.unwrap_or(Value::Null),
        None => Value::Null,
    };
    let db = ws.store.db.read().unwrap();
    let rows = |sql: &str| -> Vec<Value> {
        let mut query = db.prepare(sql).unwrap();
        query.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(|row| row.ok()).filter_map(|text| serde_json::from_str(&text).ok()).collect()
    };
    let answers = rows("SELECT data FROM journal WHERE agent_id='oc' AND kind='opencode/autoAnswer' ORDER BY seq");
    let asked = rows("SELECT data FROM journal WHERE agent_id='oc' AND kind='opencode/permission.asked' ORDER BY seq");
    let d = ws.store.detail("oc").unwrap();
    json!({"turn": status, "startSeconds": started.as_secs_f64(), "tools": lab_tools(&messages), "autoAnswers": answers,
        "userRequestsJournaled": asked.len(), "pending": d.pending.len(), "agentStatus": d.agent.status, "agentError": d.agent.error})
}

/// YN-78 S4b-2: the release limit is Auto-approve's own. On another OpenCode
/// release Core otherwise supports (2.2.6 here), only a local executor at
/// Auto-approve is refused; an executor at ask, full or read-only, and a
/// standing Agent at auto, start as before.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn on_another_opencode_release_only_an_auto_executor_is_refused() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    assert_ne!(auto::SUPPORTED, "2.2.6");
    for (id, level, executes) in [("oc-auto", "auto", true), ("oc-ask", "ask", true), ("oc-full", "full", true),
        ("oc-ro", crate::permission_levels::READ_ONLY, true), ("oc-standing", "auto", false)] {
        let mut detail = agent(&dir.path().to_string_lossy());
        detail.agent.id = id.into();
        ws.store.insert(&detail).unwrap();
        if executes {
            executor(&ws, id);
        }
        ws.store.set_permission_level(id, Some(level)).unwrap();
        let folder = data.join("opencode").join(id);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("version"), "2.2.6").unwrap();
        let started = ws.reconnect(id).await;
        if id == "oc-auto" {
            let refused = started.unwrap_err().to_string();
            assert!(refused.contains("this OpenCode is 2.2.6") && refused.contains("did not enable its Auto-approve answers"), "{refused}");
            assert!(ws.opencodes.lock().unwrap().get(id).is_none());
        } else {
            started.unwrap_or_else(|error| panic!("{id} at {level} starts on 2.2.6: {error:#}"));
            let c = ws.opencodes.lock().unwrap().get(id).cloned().unwrap();
            assert!(c.auto.is_none(), "{id}: no Core answers");
            ws.close_agent(id).await.unwrap();
        }
    }
}

/// YN-78 S4b-2 lab: run only by its lab Job, never in CI (ignored). The real
/// production connection with native OpenCode 2.2.5 (YUZUNO_OPENCODE_BIN), a
/// scripted model on loopback that the Job starts, a synthetic home and
/// synthetic files under YUZUNO_LAB_DIR. One Turn's reads go through Core's
/// answers: a file outside, a protected one, a project link to it, and a
/// file in the executor's own temporary directory. No request waits for the
/// user. Writes `lab-result.json` in the lab folder before it checks.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore]
async fn lab_native_auto_approve() {
    let lab = std::path::PathBuf::from(std::env::var_os("YUZUNO_LAB_DIR").expect("YUZUNO_LAB_DIR"));
    let (home, project, data) = (lab.join("home"), lab.join("project"), lab.join("d"));
    auto::TEST_ENVS.lock().unwrap().push((data.clone(), crate::opencode_protection::PathEnv {
        vars: [("HOME", home.clone().into_os_string())].into_iter().collect(), ..Default::default() }));
    let ws = Workspace::new(data.clone(), project.to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&project.to_string_lossy())).unwrap();
    executor(&ws, "oc");
    ws.store.set_permission_level("oc", Some("auto")).unwrap();
    let begun = std::time::Instant::now();
    ws.reconnect("oc").await.unwrap();
    let started = begun.elapsed();
    let workspace = ws.store.workspace_id().unwrap();
    let temp = ws.store.executor_temp_dir(&workspace, "oc").unwrap().expect("its temporary directory").path;
    std::fs::write(format!("{temp}/scratch.txt"), "synthetic scratch\n").unwrap();
    std::fs::write(lab.join("expect.json"), json!({"temp": temp}).to_string()).unwrap();
    let input = serde_json::from_value::<crate::model::MessageInput>(json!({"clientMessageId": "lab-1", "text": "Run the lab's reads."})).unwrap();
    let turn = ws.send_message("oc", input).await.unwrap().turn_id.unwrap();
    let result = lab_record(&ws, &turn, started).await;
    std::fs::write(lab.join("lab-result.json"), serde_json::to_string_pretty(&result).unwrap()).unwrap();
    ws.close_agent("oc").await.unwrap();
    assert_eq!(result["turn"], "completed", "{result:#}");
    assert_eq!((result["pending"].as_u64(), result["userRequestsJournaled"].as_u64()), (Some(0), Some(0)), "no request was the user's");
    let tools = result["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 4, "{result:#}");
    let said = |n: usize| tools[n]["said"].as_str().unwrap_or_default().to_owned();
    assert!(tools[0]["status"] == "completed" && said(0).contains("synthetic outside note"), "an ordinary file outside: {:#}", tools[0]);
    assert!(tools[1]["status"] != "completed" && !said(1).contains("synthetic-not-a-key"), "a protected file: {:#}", tools[1]);
    assert!(tools[2]["status"] != "completed" && !said(2).contains("synthetic-not-a-key"), "a project link to it: {:#}", tools[2]);
    assert!(tools[3]["status"] == "completed" && said(3).contains("synthetic scratch"), "its own temporary directory: {:#}", tools[3]);
    assert!(result["autoAnswers"].as_array().unwrap().iter().any(|a| a["decision"] == "reject" && a["reason"] == "protected_location"
        && a["outcome"] == "delivered"), "Core refused the link to a protected location: {result:#}");
}

/// YN-78 S4b-2's one paid trial: run only by its lab Job (ignored). The same
/// production connection with a real DeepSeek model (YUZUNO_LAB_MODEL), its
/// key read here from YUZUNO_LAB_DEEPSEEK_KEY_FILE into this process's own
/// environment for OpenCode to inherit, never printed, written or passed in
/// argv. One Turn, never retried; what the model did is recorded as it is.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore]
async fn lab_deepseek_auto_approve_turn() {
    let lab = std::path::PathBuf::from(std::env::var_os("YUZUNO_LAB_DIR").expect("YUZUNO_LAB_DIR"));
    let model = std::env::var("YUZUNO_LAB_MODEL").expect("YUZUNO_LAB_MODEL");
    let key = std::fs::read_to_string(std::env::var_os("YUZUNO_LAB_DEEPSEEK_KEY_FILE").expect("the key file")).unwrap();
    std::env::set_var("DEEPSEEK_API_KEY", key.trim());
    drop(key);
    let (home, project, data) = (lab.join("home"), lab.join("project"), lab.join("d"));
    auto::TEST_ENVS.lock().unwrap().push((data.clone(), crate::opencode_protection::PathEnv {
        vars: [("HOME", home.clone().into_os_string())].into_iter().collect(), ..Default::default() }));
    let ws = Workspace::new(data.clone(), project.to_string_lossy().into(), "unused".into()).unwrap();
    let mut detail = agent(&project.to_string_lossy());
    detail.agent.model = model.clone();
    ws.store.insert(&detail).unwrap();
    executor(&ws, "oc");
    ws.store.set_permission_level("oc", Some("auto")).unwrap();
    let begun = std::time::Instant::now();
    ws.reconnect("oc").await.unwrap();
    let started = begun.elapsed();
    let workspace = ws.store.workspace_id().unwrap();
    let temp = ws.store.executor_temp_dir(&workspace, "oc").unwrap().expect("its temporary directory").path;
    std::fs::write(format!("{temp}/scratch.txt"), "synthetic scratch\n").unwrap();
    let outside = lab.join("outside/notes.txt");
    let protected = home.join(".ssh/id_synthetic");
    let text = format!("This is a permission test with synthetic files. Use only the read tool, once for each path, in this order, \
        and do not use any other tool: 1) {} 2) {} 3) secret-link/id_synthetic 4) {temp}/scratch.txt . Some reads will be refused; \
        that is expected, do not retry them. Then reply with one line per path saying read or refused.", outside.display(), protected.display());
    let input = serde_json::from_value::<crate::model::MessageInput>(json!({"clientMessageId": "lab-ds-1", "text": text})).unwrap();
    let turn = ws.send_message("oc", input).await.unwrap().turn_id.unwrap();
    let mut result = lab_record(&ws, &turn, started).await;
    result["model"] = json!(model);
    std::env::remove_var("DEEPSEEK_API_KEY");
    std::fs::write(lab.join("lab-result.json"), serde_json::to_string_pretty(&result).unwrap()).unwrap();
    ws.close_agent("oc").await.unwrap();
    assert_eq!((result["pending"].as_u64(), result["userRequestsJournaled"].as_u64()), (Some(0), Some(0)), "no request was the user's: {result:#}");
}

/// YN-78 S2c: a Turn's end is reported once, the first time it is recorded
/// live, whatever it ended as: completed, failed or interrupted. One still
/// running, one a whole read finds ended (nothing was running) and a second
/// live event about the same Turns report nothing.
#[test]
fn a_turn_ended_live_is_reported_once_whatever_it_ended_as() {
    let mut d = agent("/synthetic/work");
    d.turns = ["c", "f", "i", "r"].iter().map(|id| json!({"id": id, "status": "inProgress"})).collect();
    d.turns.push(json!({"id": "old", "status": "completed"}));
    let running = running_ids(&d);
    for (id, status) in [("c", "completed"), ("f", "failed"), ("i", "interrupted")] {
        d.turns.iter_mut().find(|t| t["id"] == id).unwrap()["status"] = status.into();
    }
    assert_eq!(ended_live(&mut d, &running, 7), ["c", "f", "i"]);
    assert!(ended_live(&mut d, &running, 9).is_empty(), "already recorded");
    assert!(ended_live(&mut d, &[], 11).is_empty(), "a whole read");
    assert_eq!(d.turns[0]["_yuzunoCompletedAt"], 7, "the first time stands");
}

/// The executor's latest measurement as its Overview reads it, and its
/// latest ticket's revision.
#[cfg(target_os = "linux")]
fn temp_usage(ws: &Workspace) -> (Option<Value>, Option<i64>) {
    use rusqlite::OptionalExtension;
    let db = ws.store.db.read().unwrap();
    let ticket = db.query_row("SELECT revision FROM executor_temp_usage WHERE agent_id='oc'", [], |r| r.get(0)).optional().unwrap();
    (crate::executor_temp_usage::view(&db, "oc").unwrap(), ticket)
}

/// Each `agent.tempUsage` told on `live` so far.
#[cfg(target_os = "linux")]
fn told(live: &mut crate::events::Subscription) -> Vec<Value> {
    let mut found = Vec::new();
    while let Some(entry) = live.try_next() {
        let message: Value = serde_json::from_str(&entry.data).unwrap();
        if message["type"] == "agent.tempUsage" {
            found.push(message);
        }
    }
    found
}

#[cfg(target_os = "linux")]
async fn told_within(live: &mut crate::events::Subscription, seconds: u64) -> Vec<Value> {
    let until = std::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        let found = told(live);
        if !found.is_empty() || std::time::Instant::now() >= until {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Everything the stand-in sent before this is applied: an event of no kind
/// Core projects, journaled after the ones before it on the same stream.
#[cfg(target_os = "linux")]
async fn applied_so_far(ws: &Workspace, data: &std::path::Path, session: &str, name: &str) {
    let kind = format!("yuzuno.test.{name}");
    control(data, "event", json!({"type": kind, "created": 1, "properties": {"sessionID": session}})).await;
    let journal = format!("opencode/{kind}");
    for _ in 0..400 {
        let seen: i64 = ws.store.db.read().unwrap()
            .query_row("SELECT COUNT(*) FROM journal WHERE agent_id='oc' AND kind=?1", [&journal], |r| r.get(0)).unwrap();
        if seen > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{journal} was not applied within 10 s");
}

/// The allocated bytes below `dir`, as the walk counts them.
#[cfg(target_os = "linux")]
fn allocated_below(dir: &std::path::Path) -> i64 {
    use std::os::unix::fs::MetadataExt;
    let mut total = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let meta = std::fs::symlink_metadata(entry.unwrap().path()).unwrap();
        total += if meta.is_dir() { 0 } else { meta.blocks() as i64 * 512 };
    }
    total
}

#[cfg(target_os = "linux")]
async fn turn_ended(ws: &Workspace, turn: &str) -> Value {
    for _ in 0..400 {
        let d = ws.store.detail("oc").unwrap();
        if let Some(t) = d.turns.iter().find(|t| t["id"] == turn && t["status"] != "inProgress") {
            return t["status"].clone();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the turn did not end within 10 s");
}

#[cfg(target_os = "linux")]
fn message(client: &str, text: &str) -> crate::model::MessageInput {
    serde_json::from_value(json!({"clientMessageId": client, "text": text})).unwrap()
}

/// YN-78 S2c: once a live main-session Turn of an executor at Auto-approve
/// ends, its temporary directory is measured once, in the background, and
/// clients are told only its revision. The Turn's end is committed first: a
/// worker held at a barrier leaves it visible, and the ticket made, with no
/// result yet. A repeated idle, a sub-agent's session and a reconnect's whole
/// read make no ticket.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_main_turn_ended_live_measures_the_executors_temp_dir_once() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    executor(&ws, "oc");
    ws.store.set_permission_level("oc", Some("auto")).unwrap();
    ws.reconnect("oc").await.unwrap();
    let session = ws.store.detail("oc").unwrap().agent.opencode_session_id.unwrap();
    let workspace = ws.store.workspace_id().unwrap();
    let temp = std::path::PathBuf::from(ws.store.executor_temp_dir(&workspace, "oc").unwrap().unwrap().path);
    std::fs::write(temp.join("scratch.bin"), vec![7u8; 40 * 1024]).unwrap();
    let mut live = ws.changes.subscribe(None);

    let first = ws.send_message("oc", message("c1", "hello")).await.unwrap().turn_id.unwrap();
    control(&data, "reply", json!({"sessionID": session, "text": "Done."})).await;
    assert_eq!(turn_ended(&ws, &first).await, "completed");
    assert_eq!(told_within(&mut live, 10).await, [json!({"type": "agent.tempUsage", "agentId": "oc", "revision": 1})],
        "its revision only: no path, no count");
    let (usage, ticket) = temp_usage(&ws);
    let usage = usage.unwrap();
    assert_eq!((usage["state"].as_str(), usage["bytes"].as_i64(), ticket), (Some("measured"), Some(allocated_below(&temp)), Some(1)));
    assert!(usage["bytes"].as_i64().unwrap() >= 40 * 1024);

    // A repeated idle, a sub-agent's session going idle, and a reconnect's
    // whole read of the same history: no new ticket, nothing told.
    control(&data, "idle", json!({"sessionID": session})).await;
    let child = control(&data, "child", json!({"parentID": session, "title": "helper"})).await["id"].as_str().unwrap().to_owned();
    control(&data, "busy", json!({"sessionID": child})).await;
    control(&data, "idle", json!({"sessionID": child})).await;
    applied_so_far(&ws, &data, &session, "after-idle").await;
    ws.reconnect("oc").await.unwrap();
    applied_so_far(&ws, &data, &session, "after-reconnect").await;
    assert_eq!(temp_usage(&ws).1, Some(1));
    assert!(told(&mut live).is_empty());

    // The next Turn, its worker held at a barrier: the Turn's end is
    // visible first, its ticket made, its result not yet.
    let (at_barrier, worker_there) = std::sync::mpsc::channel::<()>();
    let (release, barrier) = std::sync::mpsc::channel::<()>();
    let barrier = std::sync::Mutex::new(barrier);
    let at_barrier = std::sync::Mutex::new(at_barrier);
    ws.temp_usage.hooks.lock().unwrap().before_walk = Some(Arc::new(move || {
        at_barrier.lock().unwrap().send(()).unwrap();
        barrier.lock().unwrap().recv().unwrap();
    }));
    let second = ws.send_message("oc", message("c2", "again")).await.unwrap().turn_id.unwrap();
    control(&data, "reply", json!({"sessionID": session, "text": "Again."})).await;
    assert_eq!(turn_ended(&ws, &second).await, "completed");
    tokio::task::spawn_blocking(move || worker_there.recv_timeout(Duration::from_secs(10))).await.unwrap()
        .expect("the worker reached its barrier");
    let (usage, ticket) = temp_usage(&ws);
    assert_eq!((usage.unwrap()["revision"].as_i64(), ticket), (Some(1), Some(2)), "the ticket is made, the result not yet");
    assert!(told(&mut live).is_empty());
    release.send(()).unwrap();
    assert_eq!(told_within(&mut live, 10).await, [json!({"type": "agent.tempUsage", "agentId": "oc", "revision": 2})]);
    ws.close_agent("oc").await.unwrap();
}

/// YN-78 S2c: no measurement for a Turn whose end could not be written, nor
/// later from a reconnect's whole read of the same history.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_turn_end_not_written_is_never_measured() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    executor(&ws, "oc");
    ws.store.set_permission_level("oc", Some("auto")).unwrap();
    ws.reconnect("oc").await.unwrap();
    let session = ws.store.detail("oc").unwrap().agent.opencode_session_id.unwrap();
    let first = ws.send_message("oc", message("c1", "hello")).await.unwrap().turn_id.unwrap();
    // Every write that would end a Turn fails.
    ws.store.db.write().unwrap().execute_batch(
        "CREATE TRIGGER no_end_update BEFORE UPDATE ON agent_turns WHEN json_extract(NEW.data,'$.status') <> 'inProgress'
           BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;
         CREATE TRIGGER no_end_insert BEFORE INSERT ON agent_turns WHEN json_extract(NEW.data,'$.status') <> 'inProgress'
           BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;").unwrap();
    control(&data, "reply", json!({"sessionID": session, "text": "Done."})).await;
    applied_so_far(&ws, &data, &session, "after-failure").await;
    let turn = ws.store.detail("oc").unwrap().turns.into_iter().find(|t| t["id"] == first.as_str()).unwrap();
    assert_eq!((turn["status"].as_str(), turn["_yuzunoCompletedAt"].is_null()), (Some("inProgress"), true), "its end was not written");
    assert_eq!(temp_usage(&ws), (None, None), "a rolled-back end starts nothing");
    // Writes work again; a reconnect reads the session whole: still no ticket.
    ws.store.db.write().unwrap().execute_batch("DROP TRIGGER no_end_update; DROP TRIGGER no_end_insert;").unwrap();
    ws.reconnect("oc").await.unwrap();
    applied_so_far(&ws, &data, &session, "after-whole-read").await;
    assert_eq!(temp_usage(&ws), (None, None));
    ws.close_agent("oc").await.unwrap();
}

/// YN-78 S2c: a read-only executor's start passes no temporary directory, so
/// its Turns have nothing to measure.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_read_only_executor_has_no_temp_dir_to_measure() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&dir.path().to_string_lossy())).unwrap();
    executor(&ws, "oc");
    ws.store.set_permission_level("oc", Some("read-only")).unwrap();
    ws.reconnect("oc").await.unwrap();
    assert!(ws.opencodes.lock().unwrap().get("oc").unwrap().temp.is_none());
    let session = ws.store.detail("oc").unwrap().agent.opencode_session_id.unwrap();
    let turn = ws.send_message("oc", message("c1", "hello")).await.unwrap().turn_id.unwrap();
    control(&data, "reply", json!({"sessionID": session, "text": "Done."})).await;
    assert_eq!(turn_ended(&ws, &turn).await, "completed");
    applied_so_far(&ws, &data, &session, "read-only").await;
    assert_eq!(temp_usage(&ws), (None, None));
    ws.close_agent("oc").await.unwrap();
}
