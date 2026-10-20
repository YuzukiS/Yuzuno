use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;
use yuzuno_workspace::{server, workspace::Workspace};

// `/api/jobs/live` sits beside `/api/jobs/{id}`; it must answer as the
// per-Agent summary, never as a job named "live".
#[tokio::test]
async fn live_jobs_route_is_not_read_as_a_job_id() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(
        tmp.path().join("data"),
        tmp.path().to_string_lossy().into_owned(),
        "unused-harness".into(),
    )
    .unwrap();
    let router = server::router_on_port(ws, tmp.path().join("assets"), 4317);
    let get = |uri: &str| {
        Request::builder()
            .uri(uri)
            .header("host", "localhost:4317")
            .body(Body::empty())
            .unwrap()
    };
    let live = router.clone().oneshot(get("/api/jobs/live")).await.unwrap();
    assert_eq!(live.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(live.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(body, json!({"agents":{}}));
    let missing = router.oneshot(get("/api/jobs/not-a-job")).await.unwrap();
    assert_ne!(missing.status(), StatusCode::OK);
}
