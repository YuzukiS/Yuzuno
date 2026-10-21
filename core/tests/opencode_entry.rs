//! Creating an OpenCode Agent (T-110 S1c) over HTTP, in a Core that turned
//! `YUZUNO_EXPERIMENTAL_OPENCODE` on, against the stand-in `opencode serve`
//! (tests/fixtures/opencode_server.py, run by /usr/bin/python3). The switch is
//! this test process's own; tests/opencode_agent.rs checks a Core without it.
//! No OpenCode, account, model or network service is used.
#![cfg(target_os = "linux")]

use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}, Router};
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};
use tower::ServiceExt;
use yuzuno_workspace::{model::AgentDetail, server, workspace::Workspace};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");

fn turned_on() {
    static ON: OnceLock<tempfile::TempDir> = OnceLock::new();
    ON.get_or_init(|| {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("opencode");
        std::fs::write(&program, format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
        std::env::set_var("YUZUNO_EXPERIMENTAL_OPENCODE", "1");
        dir
    });
}

async fn call(router: &Router, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder().method(method).uri(uri)
        .header("host", "localhost:4317").header("x-yuzuno-client", "desktop")
        .header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))))
}

async fn until(ws: &Workspace, id: &str, what: &str, done: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
    for _ in 0..400 {
        let d = ws.store.detail(id).unwrap();
        if done(&d) {
            return d;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}: {:#?}", ws.store.detail(id).unwrap());
}

#[tokio::test]
async fn a_core_that_turned_opencode_on_creates_a_local_agent_and_keeps_its_session_when_deleted() {
    turned_on();
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    let router = server::router_on_port(ws.clone(), dir.path().join("assets"), 4317);

    let (_, workspace) = call(&router, "GET", "/api/workspace", Value::Null).await;
    assert_eq!(workspace["opencode"], json!({"enabled":true,"version":"1.19.3"}));
    let (status, models) = call(&router, "GET", "/api/models?harness=opencode", Value::Null).await;
    assert_eq!((status, &models), (StatusCode::OK, &json!({"models":[],"opencode":{"version":"1.19.3"}})));

    // What it does not do is refused before anything is created.
    for (body, refusal) in [
        (json!({"name":"O","harness":"opencode","cwd":work,"machineId":"m1"}), "本机"),
        (json!({"name":"O","harness":"opencode","cwd":work,"model":"some/model"}), "默认模型"),
        (json!({"name":"O","harness":"opencode","cwd":dir.path().join("missing")}), "工作目录"),
    ] {
        let (status, text) = call(&router, "POST", "/api/agents", body).await;
        assert!(!status.is_success() && text.to_string().contains(refusal), "{status} {text}");
    }
    assert!(ws.store.agents().unwrap().is_empty());

    let (status, created) = call(&router, "POST", "/api/agents", json!({"name":" OpenCode ","harness":"opencode","cwd":work})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!((&created["harness"], &created["name"], &created["model"]), (&json!("opencode"), &json!("OpenCode"), &json!("")));
    let d = until(&ws, &id, "connected", |d| d.agent.connection_state == "connected").await;
    let session = d.agent.opencode_session_id.clone().expect("the session is kept");

    // Its model and permissions are OpenCode's own configuration.
    let (status, refused) = call(&router, "POST", &format!("/api/agents/{id}/settings"), json!({"model":"x"})).await;
    assert!(!status.is_success() && refused.to_string().contains("OpenCode"), "{status} {refused}");
    let (_, models) = call(&router, "GET", &format!("/api/agents/{id}/models"), Value::Null).await;
    assert_eq!(models["models"], json!([]));

    // Deleting the Agent ends its process and keeps OpenCode's own record of
    // the session, as it keeps Codex's and Claude's.
    let root = dir.path().join("data/opencode").join(&id);
    let pid = serde_json::from_str::<Value>(&std::fs::read_to_string(root.join("start.json")).unwrap()).unwrap()["pid"].as_u64().unwrap();
    let (status, deleted) = call(&router, "DELETE", &format!("/api/agents/{id}"), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert!(ws.store.agents().unwrap().is_empty());
    let mut ended = false;
    for _ in 0..200 {
        // No such process, or a zombie its parent has yet to reap.
        ended = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map_or(true, |stat| stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')));
        if ended {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(ended, "OpenCode {pid} still runs");
    let state: Value = serde_json::from_str(&std::fs::read_to_string(root.join("state.json")).unwrap()).unwrap();
    assert!(state.to_string().contains(&session), "{state}");
}
