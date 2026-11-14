//! YN-145 F2: the files a message attaches reach Claude by path, in the text
//! the bridge is given, and its receipt keeps the user's own words. The real
//! bridge over a scripted SDK (tests/fixtures/claude_quota_bridge.mjs), which
//! logs every prompt it is given; no model is called.
#![cfg(target_os = "linux")]

#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use axum::{body::{to_bytes, Body}, http::Request};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;
use yuzuno_workspace::{model::{AgentDetail, MessageInput}, workspace::Workspace};

async fn until(ws: &Arc<Workspace>, id: &str, what: &str, done: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
    for _ in 0..800 {
        let d = ws.store.detail(id).unwrap();
        if done(&d) {
            return d;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

fn prompts(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path).unwrap_or_default().lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()["text"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_claude_message_carries_its_files_by_path_and_keeps_the_users_words() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let log = dir.path().join("prompts.jsonl");
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_quota_bridge.mjs"));
    std::env::set_var("YUZUNO_TEST_CLAUDE_PROMPTS", &log);
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.start_collaboration(4999);
    let id = ws.claude_create("C".into(), String::new(), dir.path().to_string_lossy().into(), "m".into(), None).await.unwrap().id;
    until(&ws, &id, "the bridge", |d| d.agent.connection_state == "connected").await;
    let router = yuzuno_workspace::server::router(ws.clone(), dir.path().join("web"));
    let response = router.oneshot(Request::builder().method("POST").uri(format!("/api/agents/{id}/files?name=report.pdf"))
        .header("host", "127.0.0.1:4317").header("x-yuzuno-client", "desktop")
        .body(Body::from("the report")).unwrap()).await.unwrap();
    assert_eq!(response.status(), 200);
    let file: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let first: MessageInput = serde_json::from_value(serde_json::json!({"clientMessageId":"files","text":"Look at this"})).unwrap();
    let receipt = ws.send_message_from(&id, first, Vec::new(), vec![serde_json::from_value(file.clone()).unwrap()], None).await.unwrap();
    assert_eq!(receipt.status, "accepted");
    until(&ws, &id, "the first turn", |d| d.agent.status == "idle" && d.turns.iter().any(|t| t["status"] != "inProgress")).await;
    let sent = prompts(&log).pop().unwrap();
    assert!(sent.starts_with("Look at this\n\nAttached files: the user attached 1 file to this message."), "{sent}");
    let at = std::fs::canonicalize(dir.path().join("data/input-files").join(&id).join(file["id"].as_str().unwrap())
        .join(file["name"].as_str().unwrap())).unwrap();
    assert!(sent.contains(&format!("`{}`", at.display())), "{sent} lacks {}", at.display());
    // The user's own words are what the bubble shows; the notice is not.
    let saved = ws.store.detail(&id).unwrap();
    assert_eq!(saved.message_receipts[0].input.text, "Look at this");
    assert_eq!(saved.message_receipts[0].files.len(), 1);
    assert_eq!(saved.message_receipts[0].file_paths, vec![at.display().to_string()]);
    // Without files, the prompt is the words, byte for byte.
    let plain: MessageInput = serde_json::from_value(serde_json::json!({"clientMessageId":"plain","text":"No files"})).unwrap();
    assert_eq!(ws.send_message_from(&id, plain, Vec::new(), Vec::new(), None).await.unwrap().file_paths, Vec::<String>::new());
    until(&ws, &id, "the second turn", |d| d.agent.status == "idle" && d.turns.len() >= 2).await;
    assert_eq!(prompts(&log).pop().unwrap(), "No files");
}
