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
    let asked = |session: &str| json!({"id":"evt_1","type":"permission.asked","properties":{"id":"per_1",
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
    let part = |id: &str, message: &str, text: &str| json!({"type":"message.part.updated","properties":{"sessionID":c.session,
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
