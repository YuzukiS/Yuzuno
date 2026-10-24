//! Backups and restores from Settings (T-192, slice 2), through Core's HTTP
//! routes: they start only on Core's own port, the phone entry may read, and
//! each runs as an idempotent operation. Temporary folders only.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use yuzuno_workspace::{
    server::{self, RemoteEntry},
    workspace::Workspace,
};

const ORIGIN: &str = "https://core.example-tailnet.ts.net:8444";
const HOST: &str = "core.example-tailnet.ts.net:8444";
const LOGIN: &str = "person@example.com";

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>, remote: bool) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    builder = if remote {
        builder.header("host", HOST).header("tailscale-user-login", LOGIN).header("origin", ORIGIN)
    } else {
        builder.header("host", "127.0.0.1:4317")
    };
    builder = builder.header("x-yuzuno-client", "desktop").header("content-type", "application/json");
    let request = builder.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// No route takes the request: 404, or 405 where the page's own GET
/// fallback answers the path.
fn unrouted(status: StatusCode) -> bool {
    matches!(status, StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED)
}

async fn finished(app: &Router, id: &str) -> Value {
    for _ in 0..600 {
        let (status, op) = call(app, "GET", &format!("/api/workspace/backup/operations/{id}"), None, false).await;
        assert_eq!(status, StatusCode::OK, "{op}");
        if op["state"] != "running" {
            return op;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("operation {id} did not finish");
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_back_up_check_and_restore_only_from_cores_own_port() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused-codex".into()).unwrap();
    let remote = server::remote_router(ws.clone(), tmp.path().join("assets"), None, RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    let local = server::router(ws, tmp.path().join("assets"));

    let (status, view) = call(&local, "GET", "/api/workspace/backup", None, false).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!((view["canChange"].clone(), view["canBackUp"].clone()), (json!(true), json!(true)), "{view}");
    let (status, phone) = call(&remote, "GET", "/api/workspace/backup", None, true).await;
    assert_eq!((status, phone["canChange"].clone()), (StatusCode::OK, json!(false)), "the phone entry may read");

    let backup = tmp.path().join("backup");
    let request = json!({"requestId":"b1","to":backup});
    let (status, _) = call(&remote, "POST", "/api/workspace/backups", Some(request.clone()), true).await;
    assert!(unrouted(status), "a phone cannot start a backup: {status}");
    assert!(!backup.exists());
    let (status, started) = call(&local, "POST", "/api/workspace/backups", Some(request.clone()), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let id = started["operation"]["id"].as_str().unwrap().to_owned();
    let (_, again) = call(&local, "POST", "/api/workspace/backups", Some(request), false).await;
    assert_eq!(again["operation"]["id"], id.as_str(), "the same request is the same operation");
    let (status, conflict) = call(&local, "POST", "/api/workspace/backups",
        Some(json!({"requestId":"b1","to":tmp.path().join("elsewhere")})), false).await;
    assert_eq!((status, conflict["code"].clone()), (StatusCode::CONFLICT, json!("idempotency_conflict")));
    let done = finished(&local, &id).await;
    assert_eq!(done["state"], "succeeded", "{done}");
    assert_eq!(done["result"]["path"], json!(backup));
    yuzuno_workspace::workspace_backup::verify(&backup).unwrap();
    let (status, _) = call(&local, "POST", &format!("/api/workspace/backup/operations/{id}/stop"), None, false).await;
    assert_eq!(status, StatusCode::CONFLICT, "only a running operation stops");

    let (status, checked) = call(&local, "POST", "/api/workspace/backups/check", Some(json!({"requestId":"c1","path":backup})), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{checked}");
    assert_eq!(finished(&local, checked["operation"]["id"].as_str().unwrap()).await["state"], "succeeded");

    let restored = tmp.path().join("restored");
    let (status, pre) = call(&local, "POST", "/api/workspace/restore/precheck", Some(json!({"from":backup,"to":restored})), false).await;
    assert_eq!(status, StatusCode::OK, "{pre}");
    assert_eq!((pre["target"].clone(), pre["sameIdentity"].clone()), (json!("new"), json!(true)), "{pre}");
    let (status, refused) = call(&local, "POST", "/api/workspace/restore/precheck", Some(json!({"from":backup,"to":data})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(refused["error"].as_str().unwrap().contains("holds a Workspace"), "the reason is given: {refused}");
    assert!(!restored.exists(), "a precheck writes nothing");
    let (status, _) = call(&remote, "POST", "/api/workspace/restores", Some(json!({"requestId":"r1","from":backup,"to":restored})), true).await;
    assert!(unrouted(status), "a phone cannot restore: {status}");
    let (status, started) = call(&local, "POST", "/api/workspace/restores", Some(json!({"requestId":"r1","from":backup,"to":restored})), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let done = finished(&local, started["operation"]["id"].as_str().unwrap()).await;
    assert_eq!(done["state"], "succeeded", "{done}");
    assert!(done["result"]["nextSteps"][0].as_str().unwrap().contains("--data-dir"));
    assert!(restored.join("workspace.sqlite").is_file());
    let (status, relative) = call(&local, "POST", "/api/workspace/backups", Some(json!({"requestId":"b2","to":"relative/path"})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{relative}");
}
