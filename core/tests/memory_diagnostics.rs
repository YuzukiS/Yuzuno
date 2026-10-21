//! GET /api/diagnostics/memory (T-140): the process's memory counters and the
//! heap-maintenance policy's state, read on request. It passes the same
//! local and remote entry checks as the rest of the API, reports a count it
//! cannot read as null with a reason, and holds no record content or path.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;
use yuzuno_workspace::{
    server::{self, RemoteEntry},
    updates::{controller::Controller, lifecycle::WorkspaceRuntime, state::Launch},
    workspace::Workspace,
};

const PATH: &str = "/api/diagnostics/memory";

async fn get(app: &Router, headers: &[(&str, &str)]) -> (StatusCode, String) {
    let mut builder = Request::builder().method("GET").uri(PATH);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app.clone().oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

fn workspace(tmp: &tempfile::TempDir) -> Arc<Workspace> {
    Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into(), "must-not-run".into()).unwrap()
}

#[tokio::test]
async fn reports_counters_and_the_reclaim_state_without_contents_or_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = workspace(&tmp);
    let app = server::router(ws.clone(), tmp.path().join("assets"));
    let (status, body) = get(&app, &[("host", "127.0.0.1:4317")]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let report: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(report["format"], 1);
    assert!(report["readAt"].is_string());
    assert!(report["note"].as_str().unwrap().contains("not one atomic snapshot"));
    if cfg!(target_os = "linux") {
        let os = &report["os"];
        assert_eq!(os["available"], true);
        assert!(os["rssBytes"].as_u64().unwrap() > 0);
        assert!(os["hwmBytes"].as_u64().unwrap() >= os["rssBytes"].as_u64().unwrap());
        assert!(os["threads"].as_u64().unwrap() >= 1);
        for key in ["anonBytes", "fileBytes", "shmemBytes", "swapBytes"] {
            assert!(os[key].is_u64(), "{key} is a count the kernel gives here");
        }
    } else {
        assert_eq!(report["os"]["available"], false);
        assert!(report["os"]["reason"].is_string());
    }
    if cfg!(all(target_os = "linux", target_env = "gnu")) {
        let allocator = &report["allocator"];
        assert_eq!(allocator["available"], true);
        for key in ["arena", "uordblks", "fordblks", "hblkhd", "hblks"] {
            assert!(allocator[key].is_u64(), "{key} is glibc's own count");
        }
        assert!(allocator["uordblks"].as_u64().unwrap() > 0);
        let reclaim = &report["reclaim"];
        assert_eq!(reclaim["available"], true);
        assert_eq!(reclaim["policy"]["idleGraceSeconds"], 60);
        assert_eq!(reclaim["policy"]["intervalSeconds"], 30);
        // Nothing has streamed: the tick has not started, and the grace has not begun.
        assert_eq!(reclaim["maintenanceTickRunning"], false);
        if reclaim["gateBusy"] == false {
            assert!(reclaim["gate"]["waitingFor"].as_array().unwrap().iter().any(|w| w == "idleGrace"));
        }
    } else {
        assert_eq!(report["allocator"]["available"], false);
        assert!(report["allocator"]["reason"].is_string());
        assert_eq!(report["reclaim"]["available"], false);
    }
    assert_eq!(report["store"]["heldRecords"], 0);
    assert_eq!(report["store"]["maxHeldRecords"], 8);
    // Without an update controller, no admission layer counts this request.
    assert_eq!(report["admission"]["includesThisRequest"], false);
    assert_eq!(report["admission"]["inFlight"], 0);
    let workspace_id = ws.store.workspace_id().unwrap();
    for private in [workspace_id.as_str(), tmp.path().to_str().unwrap(), "/home/", "/proc/"] {
        assert!(!body.contains(private), "the report does not name {private}");
    }
}

#[tokio::test]
async fn with_update_admission_its_own_permit_is_counted_and_said_so() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = workspace(&tmp);
    let controller = Controller::new(
        None,
        None,
        Launch { port: 4398, data_dir: tmp.path().join("data"), cwd: tmp.path().into(), codex: "must-not-run".into() },
        Arc::new(WorkspaceRuntime(ws.clone())),
        ws.admission.clone(),
    )
    .unwrap();
    let app = server::router_with_updates(ws, tmp.path().join("assets"), 4398, Some(controller.clone()));
    let (status, body) = get(&app, &[("host", "127.0.0.1:4398")]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let report: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(report["admission"]["includesThisRequest"], true);
    assert_eq!(report["admission"]["inFlight"], 1);
    if cfg!(all(target_os = "linux", target_env = "gnu")) && report["reclaim"]["gateBusy"] == false {
        let waiting = report["reclaim"]["gate"]["waitingFor"].as_array().unwrap();
        assert!(!waiting.iter().any(|w| w == "requestsInFlight"), "its own permit is not another request: {waiting:?}");
    }
    // While an update drains, it waits like any other request rather than slipping past.
    controller.admission.begin_drain("drain-test").unwrap();
    let (status, _) = get(&app, &[("host", "127.0.0.1:4398")]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn the_local_and_remote_entry_checks_apply() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = workspace(&tmp);
    let local = server::router(ws.clone(), tmp.path().join("assets"));
    let (status, _) = get(&local, &[("host", "core.example.test:4317")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "not a loopback host");
    let (status, _) = get(&local, &[("host", "127.0.0.1:4317"), ("x-forwarded-for", "192.0.2.7")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a proxied request uses the remote entry");
    let entry = RemoteEntry::new("https://core.example-tailnet.ts.net:8444", "person@example.com").unwrap();
    let remote = server::remote_router(ws, tmp.path().join("assets"), None, entry);
    let host = ("host", "core.example-tailnet.ts.net:8444");
    let (status, _) = get(&remote, &[host]).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no Tailscale login");
    let (status, _) = get(&remote, &[host, ("tailscale-user-login", "someone-else@example.com")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "another login");
    let (status, body) = get(&remote, &[host, ("tailscale-user-login", "person@example.com")]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
