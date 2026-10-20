use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;
use yuzuno_workspace::{
    server,
    updates::{controller::Controller, lifecycle::WorkspaceRuntime, state::Launch},
    workspace::Workspace,
};

async fn call(app: &axum::Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", "127.0.0.1:4399")
                .header("x-yuzuno-client", "desktop")
                .header("content-type", "application/json")
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn http_and_collaboration_admission_preserve_reads_and_completion_until_final_seal() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let workspace = Workspace::new(
        data.clone(),
        root.path().to_string_lossy().into(),
        "must-not-start-a-native-runtime".into(),
    )
    .unwrap();
    let controller = Controller::new(
        None,
        None,
        Launch {
            port: 4399,
            data_dir: data,
            cwd: root.path().into(),
            codex: "must-not-run".into(),
        },
        Arc::new(WorkspaceRuntime(workspace.clone())),
        workspace.admission.clone(),
    )
    .unwrap();
    let app = server::router_with_updates(
        workspace.clone(),
        root.path().join("assets"),
        4399,
        Some(controller),
    );
    let identity = workspace.store.workspace_id().unwrap();
    let before = call(&app, "GET", "/api/health", Value::Null).await;
    assert_eq!(before.0, StatusCode::OK);
    assert_eq!(before.1["workspaceId"], identity);
    assert_eq!(before.1["storageReady"], true);
    assert_eq!(before.1["releaseId"], "development");
    // The product's name, and the identifier desktops up to 0.2.0 require.
    assert_eq!((before.1["product"].as_str(), before.1["application"].as_str()), (Some("yuzuno"), Some("yuzuno-next")));

    workspace.admission.begin_drain("test-update").unwrap();
    for path in ["/api/workspace", "/api/projects"] {
        assert_eq!(call(&app, "GET", path, Value::Null).await.0, StatusCode::OK);
    }
    assert_eq!(
        call(&app, "POST", "/api/collaboration/task_list", json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert!(workspace
        .collaboration_call(None, "task_list", json!({}))
        .await
        .is_ok());
    for (path, body) in [
        (
            "/api/agents",
            json!({"name":"Must not exist", "cwd":root.path()}),
        ),
        (
            "/api/agents/missing/messages",
            json!({"clientMessageId":"fresh", "text":"Keep this draft"}),
        ),
        ("/api/agents/missing/reconnect", json!({})),
        ("/api/agents/missing/context/apply", json!({})),
    ] {
        let (status, error) = call(&app, "POST", path, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error["error"]
            .as_str()
            .unwrap()
            .starts_with("workspace_updating:"));
    }
    assert!(workspace.store.agents().unwrap().is_empty());
    for path in [
        "/api/requests/missing/respond",
        "/api/agents/missing/interrupt",
    ] {
        let (_, error) = call(&app, "POST", path, json!({"response":{}})).await;
        assert!(!error["error"]
            .as_str()
            .unwrap()
            .starts_with("workspace_updating:"));
    }
    // The router also starts job/CI/delivery bookkeeping. HTTP completion
    // does not mean those accepted background reads have finished. Exercise
    // the same quiescence fence as shutdown, with a bound to catch leaks.
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            workspace.admission.wait_quiescent().await;
            if workspace.admission.try_seal("test-update").unwrap() { break; }
        }
    }).await.expect("accepted work must release admission before sealing");
    assert_eq!(
        call(&app, "GET", "/api/workspace", Value::Null).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        call(&app, "GET", "/api/health", Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", "/api/updates", Value::Null).await.0,
        StatusCode::OK
    );
    assert!(workspace
        .collaboration_call(None, "task_list", json!({}))
        .await
        .unwrap_err()
        .to_string()
        .starts_with("workspace_updating:"));
    workspace.admission.reopen("test-update").unwrap();
    assert_eq!(
        call(&app, "GET", "/api/workspace", Value::Null).await.0,
        StatusCode::OK
    );
    assert_eq!(workspace.store.workspace_id().unwrap(), identity);
}
