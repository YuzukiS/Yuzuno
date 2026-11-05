use super::*;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");

fn agent(cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":"oc", "name":"OpenCode", "cwd":cwd, "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
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
        .filter(|call| call["path"].as_str().unwrap().ends_with("/prompt_async")).collect::<Vec<_>>();

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
    assert_eq!(calls[1]["body"]["parts"][0]["text"], text);
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

/// A compaction request's answer lands only on the attempt it was sent for
/// (T-10, Lead 3805): one from another process generation or session, under
/// the same Turn, is never written. Giving up needs that attempt's own ended
/// answer: one of another generation or session is refused before anything
/// is asked of OpenCode. On a record alone, with no OpenCode running.
#[tokio::test]
async fn a_compaction_answer_is_its_own_attempt_s_alone() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let mut d = agent(&dir.path().to_string_lossy());
    let attempt = |answer: Value| json!({"id":"compact_1","status":"interrupted","items":[],
        "_opencodeCompact":{"state":"stopped","nativePending":true,"generation":2,"session":"ses_a","message":"msg_c","part":"prt_c","answer":answer}});
    d.turns.push(attempt(Value::Null));
    ws.store.insert(&d).unwrap();
    let answer = |ws: &Workspace| ws.store.detail("oc").unwrap().turns[0]["_opencodeCompact"]["answer"].clone();
    ws.opencode_compact_answered("oc", 1, "ses_a", "compact_1", CompactAnswer::Ended).await;
    assert!(answer(&ws).is_null(), "another process's answer: {}", answer(&ws));
    ws.opencode_compact_answered("oc", 2, "ses_b", "compact_1", CompactAnswer::Ended).await;
    assert!(answer(&ws).is_null(), "another session's answer: {}", answer(&ws));
    ws.opencode_compact_answered("oc", 2, "ses_a", "compact_1", CompactAnswer::Ended).await;
    assert_eq!((answer(&ws)["kind"].as_str(), answer(&ws)["generation"].as_u64(), answer(&ws)["session"].as_str()), (Some("ended"), Some(2), Some("ses_a")));
    // An ended answer that is not this attempt's own: refused, nothing removed.
    for (generation, session) in [(1, "ses_a"), (2, "ses_b")] {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = agent(&dir.path().to_string_lossy());
        d.turns.push(attempt(json!({"kind":"ended","status":200,"body":true,"generation":generation,"session":session})));
        ws.store.insert(&d).unwrap();
        let error = ws.opencode_compact_abandon("oc", "compact_1").await.unwrap_err().to_string();
        assert!(error.contains("还没有这次压缩的请求已经结束的证据"), "{generation} {session}: {error}");
    }
    // Its own: past that check, to the next (no OpenCode connected here).
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let mut d = agent(&dir.path().to_string_lossy());
    d.turns.push(attempt(json!({"kind":"ended","status":200,"body":true,"generation":2,"session":"ses_a"})));
    ws.store.insert(&d).unwrap();
    let error = ws.opencode_compact_abandon("oc", "compact_1").await.unwrap_err().to_string();
    assert!(error.contains("OpenCode 未连接"), "{error}");
}
