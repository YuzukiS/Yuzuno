//! The phone entry (T-170): a second loopback port that only Tailscale Serve
//! is pointed at. Every request there needs the configured Tailscale login,
//! this host and, for a change, this origin and the client header; none falls
//! back to the local port's rules. The local port refuses what only a proxy
//! sends. The names below are made up.
use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use tower::ServiceExt;
use yuzuno_workspace::{
    server::{self, RemoteEntry},
    workspace::Workspace,
};

const ORIGIN: &str = "https://core.example-tailnet.ts.net:8444";
const HOST: &str = "core.example-tailnet.ts.net:8444";
const LOGIN: &str = "person@example.com";

fn entry() -> RemoteEntry {
    RemoteEntry::new(ORIGIN, LOGIN).unwrap()
}

fn apps(tmp: &tempfile::TempDir) -> (Router, Router) {
    let ws = Workspace::new(tmp.path().join("data"), "/tmp".into(), "unused-codex".into()).unwrap();
    let remote = server::remote_router(ws.clone(), tmp.path().join("assets"), None, entry());
    let local = server::router(ws, tmp.path().join("assets"));
    (remote, local)
}

fn request(method: &str, uri: &str, headers: &[(&str, &str)]) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let body = if method == "GET" { Body::empty() } else { Body::from(r#"{"throughSeq":0}"#) };
    builder.body(body).unwrap()
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, String) {
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

const READ: &[(&str, &str)] = &[("host", HOST), ("tailscale-user-login", LOGIN)];
const WRITE: &[(&str, &str)] = &[
    ("host", HOST),
    ("tailscale-user-login", LOGIN),
    ("origin", ORIGIN),
    ("x-yuzuno-client", "desktop"),
    ("content-type", "application/json"),
];

fn with(base: &[(&'static str, &'static str)], extra: &[(&'static str, &'static str)]) -> Vec<(&'static str, &'static str)> {
    base.iter().chain(extra).copied().collect()
}

fn without(base: &[(&'static str, &'static str)], name: &str) -> Vec<(&'static str, &'static str)> {
    base.iter().filter(|(n, _)| *n != name).copied().collect()
}

#[tokio::test]
async fn the_configured_login_reaches_pages_api_events_and_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let (remote, _) = apps(&tmp);
    let (health, _) = send(&remote, request("GET", "/api/health", READ)).await;
    assert_eq!(health, StatusCode::OK);
    // The page itself goes through the same check (no build here: not 403).
    let (page, _) = send(&remote, request("GET", "/", READ)).await;
    assert_ne!(page, StatusCode::FORBIDDEN);
    let events = remote.clone().oneshot(request("GET", "/api/events", READ)).await.unwrap();
    assert_eq!(events.status(), StatusCode::OK);
    assert_eq!(events.headers()[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(events.headers()[header::X_FRAME_OPTIONS], "DENY");
    drop(events);
    // A change reaches its handler (which answers for the missing Agent).
    let (change, body) = send(&remote, request("POST", "/api/agents/missing/review", WRITE)).await;
    assert_ne!(change, StatusCode::FORBIDDEN, "{body}");
    // A page's read carries its Origin, which must be this one.
    let (read, _) = send(&remote, request("GET", "/api/health", &with(READ, &[("origin", ORIGIN)]))).await;
    assert_eq!(read, StatusCode::OK);
    // Forwarded headers are neither needed nor read.
    let (forwarded, _) = send(&remote, request("GET", "/api/health",
        &with(READ, &[("x-forwarded-host", "elsewhere.example"), ("x-forwarded-for", "100.64.0.9")]))).await;
    assert_eq!(forwarded, StatusCode::OK);
}

#[tokio::test]
async fn anyone_else_is_refused_and_nothing_falls_back_to_the_local_rules() {
    let tmp = tempfile::tempdir().unwrap();
    let (remote, _) = apps(&tmp);
    let cases: Vec<(&str, &str, Vec<(&str, &str)>, &str)> = vec![
        // Who: Serve sets no login for a tagged node, the local machine or Funnel.
        ("GET", "/api/health", without(READ, "tailscale-user-login"), "Not the Tailscale login"),
        ("GET", "/", without(READ, "tailscale-user-login"), "Not the Tailscale login"),
        ("GET", "/api/events", without(READ, "tailscale-user-login"), "Not the Tailscale login"),
        ("POST", "/api/agents/missing/review", without(WRITE, "tailscale-user-login"), "Not the Tailscale login"),
        // A shared-in user of another tailnet has a login of their own.
        ("GET", "/api/health", vec![("host", HOST), ("tailscale-user-login", "visitor@example.org")], "Not the Tailscale login"),
        ("GET", "/api/health", vec![("host", HOST), ("tailscale-user-login", "Person@example.com")], "Not the Tailscale login"),
        ("GET", "/api/health", with(READ, &[("tailscale-user-login", LOGIN)]), "Not the Tailscale login"),
        ("GET", "/api/health", with(READ, &[("tailscale-funnel-request", "?1")]), "Funnel"),
        // Where: only this host, never guessed from a forwarded header.
        ("GET", "/api/health", vec![("host", "core.example-tailnet.ts.net"), ("tailscale-user-login", LOGIN)], "Unrecognized workspace host"),
        ("GET", "/api/health", vec![("host", "127.0.0.1:4318"), ("tailscale-user-login", LOGIN)], "Unrecognized workspace host"),
        ("GET", "/api/health", vec![("host", "127.0.0.1:4318"), ("tailscale-user-login", LOGIN), ("x-forwarded-host", HOST)], "Unrecognized workspace host"),
        ("GET", "/api/health", vec![("tailscale-user-login", LOGIN)], "Unrecognized workspace host"),
        // A loopback request on this port is not a local one.
        ("GET", "/api/health", vec![("host", "127.0.0.1:4317")], "Not the Tailscale login"),
        // Which page: a read with another Origin, or two.
        ("GET", "/api/health", with(READ, &[("origin", "https://elsewhere.example")]), "Unrecognized workspace origin"),
        ("GET", "/api/health", with(READ, &[("origin", ORIGIN), ("origin", ORIGIN)]), "Unrecognized workspace origin"),
        ("GET", "/api/health", with(READ, &[("origin", "http://core.example-tailnet.ts.net:8444")]), "Unrecognized workspace origin"),
        // A change needs this page's Origin and the client header.
        ("POST", "/api/agents/missing/review", without(WRITE, "origin"), "A change must come from this workspace's page"),
        ("POST", "/api/agents/missing/review", without(WRITE, "x-yuzuno-client"), "Workspace client header required"),
        ("POST", "/api/agents/missing/review", with(&without(WRITE, "origin"), &[("origin", "https://elsewhere.example")]), "Unrecognized workspace origin"),
    ];
    for (method, uri, headers, reason) in cases {
        let (status, body) = send(&remote, request(method, uri, &headers)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri} {headers:?}");
        assert!(body.contains(reason), "{method} {uri} {headers:?}: {body}");
    }
}

#[tokio::test]
async fn the_remote_entry_does_not_serve_the_agents_mcp_endpoints() {
    let tmp = tempfile::tempdir().unwrap();
    let (remote, local) = apps(&tmp);
    // Locally the path is the MCP router's, which refuses a session ID itself.
    let (status, body) = send(&local, request("POST", "/mcp/some-agent", &[("host", "127.0.0.1:4317"), ("mcp-session-id", "x")])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("does not use sessions"), "{body}");
    // On the remote entry the same path is just a page that is not there.
    let probe = with(WRITE, &[("mcp-session-id", "x")]);
    let (mcp, mcp_body) = send(&remote, request("POST", "/mcp/some-agent", &probe)).await;
    let (other, other_body) = send(&remote, request("POST", "/no-such-page", &probe)).await;
    assert_eq!((mcp, &mcp_body), (other, &other_body));
    assert_ne!(mcp, StatusCode::FORBIDDEN, "past the entry's own check: {mcp_body}");
    assert!(!mcp_body.contains("MCP") && !mcp_body.contains("session"), "{mcp_body}");
}

#[tokio::test]
async fn where_core_is_installed_is_told_only_on_its_own_port() {
    // T-171: the desktop on the Core's computer asks; a phone never needs it.
    let tmp = tempfile::tempdir().unwrap();
    let (remote, local) = apps(&tmp);
    let (status, body) = send(&local, request("GET", "/api/desktop/start-profile", &[("host", "127.0.0.1:4317")])).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"available\""), "{body}");
    let (profile, profile_body) = send(&remote, request("GET", "/api/desktop/start-profile", READ)).await;
    let (other, other_body) = send(&remote, request("GET", "/api/no-such-route", READ)).await;
    assert_eq!((profile, &profile_body), (other, &other_body));
    assert!(!profile_body.contains("available"), "{profile_body}");
}

#[tokio::test]
async fn the_local_port_refuses_what_only_a_proxy_sends() {
    let tmp = tempfile::tempdir().unwrap();
    let (_, local) = apps(&tmp);
    let local_read: &[(&str, &str)] = &[("host", "127.0.0.1:4317")];
    let (plain, _) = send(&local, request("GET", "/api/health", local_read)).await;
    assert_eq!(plain, StatusCode::OK, "an ordinary local request is unchanged");
    for marker in [
        ("tailscale-user-login", LOGIN),
        ("tailscale-headers-info", "https://tailscale.com/s/serve-headers"),
        ("tailscale-funnel-request", "?1"),
        ("x-forwarded-for", "100.64.0.9"),
    ] {
        let (status, body) = send(&local, request("GET", "/api/health", &with(local_read, &[marker]))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{marker:?}");
        assert!(body.contains("Proxied request"), "{body}");
    }
}

#[test]
fn the_settings_name_one_https_origin_and_one_login() {
    let entry = RemoteEntry::new("https://Core.Example-Tailnet.ts.net:8444/", LOGIN).unwrap();
    assert_eq!(entry.origin(), ORIGIN, "lowercased as a browser sends it, no trailing slash");
    // https' own port is left out, as a browser leaves it out.
    assert_eq!(RemoteEntry::new("https://core.example-tailnet.ts.net:443", LOGIN).unwrap().origin(), "https://core.example-tailnet.ts.net");
    for origin in [
        "http://core.example-tailnet.ts.net:8444",
        "https://core.example-tailnet.ts.net:8444/workspace",
        "https://core.example-tailnet.ts.net:8444/?a=1",
        "https://core.example-tailnet.ts.net:8444/#x",
        "https://user@core.example-tailnet.ts.net:8444",
        "core.example-tailnet.ts.net:8444",
        "",
    ] {
        assert!(RemoteEntry::new(origin, LOGIN).is_err(), "{origin:?}");
    }
    for login in ["", " person@example.com", "person@example.com ", "person@\nexample.com"] {
        assert!(RemoteEntry::new(ORIGIN, login).is_err(), "{login:?}");
    }
    let some = |v: &str| Some(v.to_owned());
    assert!(RemoteEntry::from_settings(None, None, None, 4317).unwrap().is_none());
    let (port, entry) = RemoteEntry::from_settings(some("4318"), some(ORIGIN), some(LOGIN), 4317).unwrap().unwrap();
    assert_eq!((port, entry.origin()), (4318, ORIGIN));
    for (port, origin, login) in [
        (some("4318"), some(ORIGIN), None),
        (None, some(ORIGIN), some(LOGIN)),
        (some("4318"), None, None),
        (some("4317"), some(ORIGIN), some(LOGIN)),
        (some("0"), some(ORIGIN), some(LOGIN)),
        (some("http"), some(ORIGIN), some(LOGIN)),
    ] {
        assert!(RemoteEntry::from_settings(port.clone(), origin.clone(), login.clone(), 4317).is_err(), "{port:?} {origin:?} {login:?}");
    }
}
