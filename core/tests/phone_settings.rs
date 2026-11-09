//! What the phone entry may change (YN-79, the user's choice of 2026-11-09):
//! the routing keys, accounts, readings, policy and models, an OpenCode
//! Agent's login, and phone access itself. Both entries serve them; the phone
//! entry still admits only its configured Tailscale login, and any
//! Authorization header is refused on either. What stays on Core's own port
//! (the desktop profile, backups and restores) is not there.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;
use yuzuno_workspace::{server, workspace::Workspace};

const ORIGIN: &str = "https://core.example-tailnet.ts.net:8444";
const HOST: &str = "core.example-tailnet.ts.net:8444";
const LOGIN: &str = "person@example.com";

fn lab() -> (tempfile::TempDir, std::sync::Arc<Workspace>) {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), "/tmp".into(), "unused-codex".into()).unwrap();
    (tmp, ws)
}

fn unrouted(status: StatusCode) -> bool {
    matches!(status, StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED)
}

/// One request as the phone entry's Serve passes it; `headers` add to or
/// replace the login line (`None` for no login at all).
async fn phone(app: &axum::Router, method: &str, uri: &str, body: Option<Value>, login: Option<&str>, extra: &[(&str, &str)]) -> (StatusCode, String) {
    let mut builder = Request::builder().method(method).uri(uri).header("host", HOST).header("x-yuzuno-client", "desktop")
        .header("content-type", "application/json").header("origin", ORIGIN);
    if let Some(login) = login {
        builder = builder.header("tailscale-user-login", login);
    }
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    send(app, builder, body).await
}

/// One request as the page on Core's own port makes it.
async fn local(app: &axum::Router, method: &str, uri: &str, body: Option<Value>, extra: &[(&str, &str)]) -> (StatusCode, String) {
    let mut builder = Request::builder().method(method).uri(uri).header("host", "127.0.0.1:4317")
        .header("x-yuzuno-client", "desktop").header("content-type", "application/json");
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    send(app, builder, body).await
}

async fn send(app: &axum::Router, builder: axum::http::request::Builder, body: Option<Value>) -> (StatusCode, String) {
    let request = builder.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// Every route that moved, with a request each entry serves.
fn moved() -> Vec<(&'static str, &'static str, Option<Value>)> {
    vec![
        ("GET", "/api/routing/keys", None),
        ("GET", "/api/routing/accounts", None),
        ("GET", "/api/routing/readings", None),
        ("GET", "/api/routing/policy", None),
        ("GET", "/api/routing/models?harness=codex", None),
        ("GET", "/api/agents/nobody/opencode/login", None),
        ("GET", "/api/remote-access", None),
        ("POST", "/api/remote-access/apply", Some(json!({"requestId": "", "enabled": false}))),
        ("POST", "/api/remote-access/preview", Some(json!({}))),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn both_entries_serve_the_moved_settings_and_the_phone_still_needs_its_login() {
    let (_tmp, ws) = lab();
    let remote = server::remote_router(ws.clone(), ws.data_dir.join("assets"), None, server::RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    for (method, uri, body) in moved() {
        let (status, answer) = phone(&remote, method, uri, body.clone(), Some(LOGIN), &[]).await;
        assert!(!unrouted(status), "the phone entry has {method} {uri}: {status} {answer}");
        // Without a login, or with another one, the entry refuses it before any route.
        let (status, _) = phone(&remote, method, uri, body.clone(), None, &[]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "no login: {method} {uri}");
        let (status, _) = phone(&remote, method, uri, body.clone(), Some("someone@else"), &[]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "another login: {method} {uri}");
        // The computer's port still serves the same route.
        let (status, answer) = local(&server::router(ws.clone(), ws.data_dir.join("assets")), method, uri, body, &[]).await;
        assert!(!unrouted(status), "Core's own port has {method} {uri}: {status} {answer}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agents_credential_changes_none_of_them_on_either_entry() {
    let (_tmp, ws) = lab();
    let remote = server::remote_router(ws.clone(), ws.data_dir.join("assets"), None, server::RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    let local_app = server::router(ws.clone(), ws.data_dir.join("assets"));
    // The view of phone access was on both entries before this change; the
    // moved routes are the ones that refuse an Agent's credential.
    for (method, uri, body) in moved().into_iter().filter(|(_, uri, _)| *uri != "/api/remote-access") {
        let auth = [("authorization", "Bearer an-agents-token")];
        let (status, answer) = phone(&remote, method, uri, body.clone(), Some(LOGIN), &auth).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "the phone entry: {method} {uri}: {answer}");
        assert!(answer.contains("take no Agent credential"), "{answer}");
        let (status, answer) = local(&local_app, method, uri, body, &auth).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "Core's own port: {method} {uri}: {answer}");
        assert!(answer.contains("take no Agent credential"), "{answer}");
    }
    assert!(!ws.data_dir.join("secrets").exists(), "nothing was written");
}

#[tokio::test(flavor = "multi_thread")]
async fn what_stays_on_cores_own_port_is_not_on_the_phone_entry() {
    let (_tmp, ws) = lab();
    let remote = server::remote_router(ws.clone(), ws.data_dir.join("assets"), None, server::RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    for (method, uri, body) in [
        ("GET", "/api/desktop/start-profile", None),
        ("POST", "/api/workspace/backups", Some(json!({}))),
        ("POST", "/api/workspace/backups/check", Some(json!({}))),
        ("POST", "/api/workspace/restores", Some(json!({}))),
        ("POST", "/api/workspace/backup/schedule", Some(json!({}))),
        ("POST", "/api/workspace/backup/retention/preview", Some(json!({}))),
        ("POST", "/api/workspace/backup/retention/remove", Some(json!({}))),
    ] {
        let (status, answer) = phone(&remote, method, uri, body, Some(LOGIN), &[]).await;
        assert!(unrouted(status), "the phone entry must not serve {method} {uri}: {status} {answer}");
    }
}
