//! Where a conversation was last read, shared between the user's browsers
//! (T-170): the browser boundary guards it like any change, the phone's
//! remote entry admits its own login, it marks nothing read, and it goes
//! with its Agent.
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}, Router};
use serde_json::{json, Value};
use tower::ServiceExt;
use yuzuno_workspace::{model::AgentDetail, server::{self, RemoteEntry}, workspace::Workspace};

const ORIGIN: &str = "https://core.example-tailnet.ts.net:8444";
const HOST: &str = "core.example-tailnet.ts.net:8444";
const LOGIN: &str = "person@example.com";

fn agent() -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":"mori", "name":"Mori", "cwd":"/tmp", "model":"", "color":"sage",
        "harness":"codex", "threadId":"thread-1", "status":"closed",
        "closedAt":"2026-10-12T00:00:00Z", "createdAt":"", "updatedAt":"",
        "unreadCount":2,"pendingCount":0,"lastSeq":7,"reviewedSeq":5
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

fn body(seq: u64, turn: &str) -> String {
    json!({"position":{"mode":"anchor","turnId":turn,"itemId":format!("{turn}-reply"),"threadId":"thread-1","progress":0.4},
        "source":"desk-1","label":"desktop","clientSeq":seq}).to_string()
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn local(method: &str, uri: &str, payload: Option<String>, client: bool) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri).header("host", "127.0.0.1:4317");
    if client {
        builder = builder.header("x-yuzuno-client", "desktop");
    }
    if payload.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    builder.body(payload.map(Body::from).unwrap_or_else(Body::empty)).unwrap()
}

#[tokio::test]
async fn a_browser_shares_where_it_read_through_the_guard_and_nothing_is_marked_read() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    ws.store.insert(&agent()).unwrap();
    let app = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);

    let (status, _) = send(&app, local("PUT", "/api/agents/mori/reading", Some(body(5, "t1")), false)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a change needs the client header");
    let (status, seen) = send(&app, local("PUT", "/api/agents/mori/reading", Some(body(5, "t1")), true)).await;
    assert_eq!(status, StatusCode::OK, "{seen}");
    assert_eq!((seen["accepted"].as_bool(), seen["sourceSeq"].as_u64()), (Some(true), Some(5)));

    let (status, seen) = send(&app, local("GET", "/api/agents/mori/reading?source=phone-1", None, false)).await;
    assert_eq!(status, StatusCode::OK);
    let handoff = &seen["handoff"];
    assert_eq!((handoff["turnId"].as_str(), handoff["progress"].as_f64(), handoff["label"].as_str()), (Some("t1"), Some(0.4), Some("desktop")));
    assert_eq!(seen["sourceSeq"], 0, "another browser has no mark yet");

    // An older duplicate is not applied; the answer says how far that source got.
    let (_, late) = send(&app, local("PUT", "/api/agents/mori/reading", Some(body(4, "t0")), true)).await;
    assert_eq!((late["accepted"].as_bool(), late["sourceSeq"].as_u64(), late["handoff"]["turnId"].as_str()), (Some(false), Some(5), Some("t1")));

    // Bad input and an unknown Agent.
    let bad = json!({"position":{"mode":"anchor","turnId":"t1","progress":2},"source":"desk-1","label":"desktop","clientSeq":6}).to_string();
    assert_eq!(send(&app, local("PUT", "/api/agents/mori/reading", Some(bad), true)).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&app, local("GET", "/api/agents/nobody/reading", None, false)).await.0, StatusCode::NOT_FOUND);

    // Reading where someone was is not reading it now.
    let detail = ws.store.detail("mori").unwrap();
    assert_eq!((detail.agent.reviewed_seq, detail.agent.unread_count), (5, 2));
}

#[tokio::test]
async fn the_phone_entry_admits_its_login_only() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    ws.store.insert(&agent()).unwrap();
    let remote = server::remote_router(ws, tmp.path().join("assets"), None, RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    let request = |login: Option<&str>| {
        let mut builder = Request::builder().method("PUT").uri("/api/agents/mori/reading")
            .header("host", HOST).header("origin", ORIGIN).header("x-yuzuno-client", "desktop")
            .header("content-type", "application/json");
        if let Some(login) = login {
            builder = builder.header("tailscale-user-login", login);
        }
        builder.body(Body::from(body(1, "t1"))).unwrap()
    };
    assert_eq!(send(&remote, request(None)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&remote, request(Some("visitor@example.org"))).await.0, StatusCode::FORBIDDEN);
    let (status, seen) = send(&remote, request(Some(LOGIN))).await;
    assert_eq!(status, StatusCode::OK, "{seen}");
    assert_eq!(seen["accepted"], true);
}

#[tokio::test]
async fn the_record_goes_with_its_agent() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    ws.store.insert(&agent()).unwrap();
    let app = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    assert_eq!(send(&app, local("PUT", "/api/agents/mori/reading", Some(body(5, "t1")), true)).await.0, StatusCode::OK);
    assert_eq!(send(&app, local("DELETE", "/api/agents/mori", None, true)).await.0, StatusCode::OK);
    assert_eq!(send(&app, local("GET", "/api/agents/mori/reading", None, false)).await.0, StatusCode::NOT_FOUND);
    // A new Agent under the same ID starts with nothing.
    ws.store.insert(&agent()).unwrap();
    let (_, seen) = send(&app, local("GET", "/api/agents/mori/reading?source=desk-1", None, false)).await;
    assert_eq!((seen["handoff"].clone(), seen["sourceSeq"].as_u64()), (Value::Null, Some(0)));
}
