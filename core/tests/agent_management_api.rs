use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use serde_json::{json, Value};
use tower::ServiceExt;
use yuzuno_workspace::{model::AgentDetail, server, workspace::Workspace};

fn closed_agent(cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":"closed-test", "name":"Closed teammate", "cwd":cwd, "model":"", "color":"sage",
        "harness":"codex", "threadId":"native-session-kept", "status":"closed",
        "closedAt":"2026-10-12T00:00:00Z", "createdAt":"", "updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

#[tokio::test]
async fn deletion_requires_workspace_client_header_and_does_not_remove_project_files() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let file = project.join("keep.txt");
    std::fs::write(&file, "must survive").unwrap();
    let ws = Workspace::new(tmp.path().join("data"), project.to_string_lossy().into_owned(), "unused-harness".into()).unwrap();
    ws.store.insert(&closed_agent(&project.to_string_lossy())).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let request = |authorized| {
        let mut req = Request::builder().method("DELETE").uri("/api/agents/closed-test")
            .header("host", "localhost:4317");
        if authorized { req = req.header("x-yuzuno-client", "desktop"); }
        req.body(Body::empty()).unwrap()
    };
    let rejected = router.clone().oneshot(request(false)).await.unwrap();
    assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
    assert!(ws.store.detail("closed-test").is_ok());
    let accepted = router.oneshot(request(true)).await.unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&to_bytes(accepted.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body["deleted"], true);
    assert!(ws.store.detail("closed-test").is_err());
    assert_eq!(std::fs::read_to_string(file).unwrap(), "must survive");
}

#[tokio::test]
async fn model_route_rejects_unknown_harness_and_claude_rejects_codex_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "unused-harness".into()).unwrap();
    let mut detail = closed_agent(&tmp.path().to_string_lossy());
    detail.agent.harness = "claude".into();
    ws.store.insert(&detail).unwrap();
    let router = server::router_on_port(ws, tmp.path().join("assets"), 4317);
    let unknown = router.clone().oneshot(Request::builder().uri("/api/models?harness=unknown")
        .header("host", "localhost:4317").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
    let settings = router.oneshot(Request::builder().method("POST").uri("/api/agents/closed-test/settings")
        .header("host", "localhost:4317").header("x-yuzuno-client", "desktop").header("content-type", "application/json")
        .body(Body::from(json!({"model":"haiku", "settings":{"reasoningEffort":null,"approvalPolicy":"never","sandbox":"danger-full-access"}}).to_string())).unwrap()).await.unwrap();
    assert_eq!(settings.status(), StatusCode::BAD_REQUEST);
    let body: Value = serde_json::from_slice(&to_bytes(settings.into_body(), 4096).await.unwrap()).unwrap();
    assert!(body["error"].as_str().unwrap().contains("Claude"));
}
