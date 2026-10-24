//! GET /api/storage (T-193 slice 1) through Core's own router: it answers
//! with what the data folder holds and walks no folder to do it.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::Value;
use tower::ServiceExt;
use yuzuno_workspace::{server, workspace::Workspace};

#[tokio::test]
async fn the_overview_answers_through_cores_router_without_walking_a_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into(), "must-not-run".into()).unwrap();
    std::fs::create_dir_all(tmp.path().join("data/jobs/j1")).unwrap();
    std::fs::write(tmp.path().join("data/jobs/j1/log-0.bin"), vec![b'x'; 4000]).unwrap();
    let app = server::router(ws, tmp.path().join("assets"));
    let request = Request::builder().uri("/api/storage").header("host", "127.0.0.1:4317").body(Body::empty()).unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["format"], 1);
    let entries = body["entries"].as_array().unwrap();
    let jobs = entries.iter().find(|e| e["name"] == "jobs").unwrap();
    assert_eq!((jobs["kind"].as_str(), jobs["backup"].as_str()), (Some("folder"), Some("copied")));
    assert!(jobs.get("bytes").is_none(), "a folder's size is not measured: {jobs}");
    let database = entries.iter().find(|e| e["name"] == "workspace.sqlite").unwrap();
    assert!(database["bytes"].as_u64().unwrap() > 0, "{database}");
}
