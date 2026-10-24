//! GET /api/storage and its measurement (T-193 slice 1), through Core's own
//! router: reading the overview starts nothing, a measurement starts only on
//! a client's POST, and its result is read back with the overview.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::Value;
use std::{sync::Arc, time::{Duration, Instant}};
use tower::ServiceExt;
use yuzuno_workspace::{server, workspace::Workspace};

async fn send(app: &Router, method: &str, path: &str, client: bool) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path).header("host", "127.0.0.1:4317");
    if client {
        builder = builder.header("x-yuzuno-client", "desktop");
    }
    let response = app.clone().oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::String(String::from_utf8_lossy(&body).into_owned())))
}

fn workspace(tmp: &tempfile::TempDir) -> Arc<Workspace> {
    Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into(), "must-not-run".into()).unwrap()
}

#[tokio::test]
async fn the_overview_starts_nothing_and_a_measurement_starts_only_when_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = workspace(&tmp);
    std::fs::create_dir_all(tmp.path().join("data/jobs/j1")).unwrap();
    std::fs::write(tmp.path().join("data/jobs/j1/log-0.bin"), vec![b'x'; 4000]).unwrap();
    let app = server::router(ws, tmp.path().join("assets"));

    let (status, overview) = send(&app, "GET", "/api/storage", false).await;
    assert_eq!(status, StatusCode::OK, "{overview}");
    assert_eq!(overview["format"], 1);
    assert!(overview["entries"].as_array().unwrap().iter().any(|e| e["name"] == "workspace.sqlite"));
    assert_eq!(overview["measurement"], Value::Null, "reading the overview measures nothing");

    let (status, _) = send(&app, "POST", "/api/storage/measure", false).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a page without Yuzuno's client header starts nothing");
    let (_, again) = send(&app, "GET", "/api/storage", false).await;
    assert_eq!(again["measurement"], Value::Null);

    let (status, started) = send(&app, "POST", "/api/storage/measure", true).await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let id = started["measurement"]["id"].clone();
    assert!(id.is_string(), "{started}");
    let deadline = Instant::now() + Duration::from_secs(20);
    let measurement = loop {
        let (_, overview) = send(&app, "GET", "/api/storage", false).await;
        if overview["measurement"]["state"] != "running" {
            break overview["measurement"].clone();
        }
        assert!(Instant::now() < deadline, "the measurement ends");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!((measurement["id"].clone(), measurement["state"].as_str()), (id, Some("done")), "{measurement}");
    let jobs = measurement["folders"].as_array().unwrap().iter().find(|f| f["name"] == "jobs").unwrap();
    assert_eq!((jobs["files"].as_u64(), jobs["bytes"].as_u64()), (Some(1), Some(4000)), "{jobs}");

    let (status, stopped) = send(&app, "POST", "/api/storage/measure/stop", true).await;
    assert_eq!(status, StatusCode::OK, "{stopped}");
    assert_eq!(stopped["measurement"]["state"], "done", "stopping an ended measurement changes nothing");
}
