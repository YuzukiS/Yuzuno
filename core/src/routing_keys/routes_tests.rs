//! The routing keys' routes (YN-34 S1a), through Core's routers: written
//! only on Core's own port by the user's browser, never with an Agent's
//! credential, never on the phone entry, never through a Workspace tool, and
//! no answer ever holds a value. Synthetic values only.
use crate::{model::AgentDetail, server, workspace::Workspace};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

const KEY: &str = "sk-test-yn34-route-0123456789";
const TOKEN: &str = "ops_test-yn34-route-token-0123456789";
const ORIGIN: &str = "https://core.example-tailnet.ts.net:8444";
const HOST: &str = "core.example-tailnet.ts.net:8444";
const LOGIN: &str = "person@example.com";

fn lab() -> (tempfile::TempDir, Arc<Workspace>) {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), "/tmp".into(), "unused-codex".into()).unwrap();
    (tmp, ws)
}

/// A request as the user's browser on Core's port sends it, with `extra`
/// headers; `remote` as the phone entry's proxy sends it.
async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>, remote: bool, extra: &[(&str, &str)]) -> (StatusCode, String) {
    let mut builder = Request::builder().method(method).uri(uri);
    builder = if remote {
        builder.header("host", HOST).header("tailscale-user-login", LOGIN).header("origin", ORIGIN)
    } else {
        builder.header("host", "127.0.0.1:4317")
    };
    builder = builder.header("x-yuzuno-client", "desktop").header("content-type", "application/json");
    for (name, value) in extra {
        builder = builder.header(*name, *value);
    }
    let request = builder.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn unrouted(status: StatusCode) -> bool {
    matches!(status, StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_is_written_and_no_answer_ever_holds_it() {
    let (_tmp, ws) = lab();
    let app = server::router(ws.clone(), ws.data_dir.join("assets"));
    let (status, put) = call(&app, "PUT", "/api/routing/keys/anthropic",
        Some(json!({"source":"local","provider":"anthropic","value":KEY})), false, &[]).await;
    assert_eq!(status, StatusCode::OK, "{put}");
    let put: Value = serde_json::from_str(&put).unwrap();
    assert_eq!((put["id"].clone(), put["source"].clone(), put["set"].clone()), (json!("anthropic"), json!("local"), json!(true)));
    let (status, put_ref) = call(&app, "PUT", "/api/routing/keys/openai",
        Some(json!({"source":"1password","provider":"openai","reference":"op://Vault/OpenAI API/credential"})), false, &[]).await;
    assert_eq!(status, StatusCode::OK, "{put_ref}");
    let (status, token) = call(&app, "PUT", "/api/routing/1password/token", Some(json!({"value":TOKEN})), false, &[]).await;
    assert_eq!(status, StatusCode::OK, "{token}");
    let (_, listed) = call(&app, "GET", "/api/routing/keys", None, false, &[]).await;
    let (_, one_password) = call(&app, "GET", "/api/routing/1password", None, false, &[]).await;
    for answer in [&put.to_string(), &put_ref, &token, &listed, &one_password] {
        assert!(!answer.contains(KEY) && !answer.contains(TOKEN), "no value in {answer}");
    }
    let listed: Value = serde_json::from_str(&listed).unwrap();
    assert_eq!(listed["keys"].as_array().unwrap().len(), 2, "{listed}");
    assert_eq!(listed["onePasswordToken"]["set"], true);
    let local = listed["keys"].as_array().unwrap().iter().find(|k| k["id"] == "anthropic").unwrap();
    let fields: std::collections::BTreeSet<&str> = local.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(fields, ["id", "provider", "set", "setAt", "source"].into(), "a local key shows only these");
    // Unknown fields are refused, so nothing rides along unchecked; and a
    // refusal never quotes the body, not even a key pasted into the wrong field.
    for body in [
        json!({"source":"local","provider":"anthropic","value":KEY,"show":true}),
        json!({"source":"local","provider":KEY,"value":"x"}),
        json!({"source":KEY,"provider":"openai","value":"x"}),
        json!({"source":"local","provider":"openai","value":[KEY]}),
    ] {
        let (status, answer) = call(&app, "PUT", "/api/routing/keys/x", Some(body.clone()), false, &[]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(answer.contains("The body is not a routing key") && !answer.contains(KEY), "{answer}");
    }
    let (status, answer) = call(&app, "PUT", "/api/routing/1password/token", Some(json!({"token":TOKEN})), false, &[]).await;
    assert!(status == StatusCode::BAD_REQUEST && !answer.contains(TOKEN), "{answer}");
    let (status, removed) = call(&app, "DELETE", "/api/routing/keys/anthropic", None, false, &[]).await;
    assert_eq!((status, removed.as_str()), (StatusCode::OK, r#"{"removed":true}"#));
    let (status, removed) = call(&app, "DELETE", "/api/routing/1password/token", None, false, &[]).await;
    assert_eq!((status, removed.as_str()), (StatusCode::OK, r#"{"removed":true}"#));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agents_credential_is_refused() {
    let (_tmp, ws) = lab();
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{
        "id":"executor-1","name":"Executor","cwd":"/tmp","model":"","color":"sage",
        "threadId":null,"status":"offline","createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
    let config = crate::collaboration_mcp::agent_http_config(&ws, "executor-1", "http://127.0.0.1:4317").unwrap();
    let bearer = config["headers"]["Authorization"].as_str().unwrap().to_owned();
    let app = server::router(ws.clone(), ws.data_dir.join("assets"));
    for authorization in [bearer.as_str(), "Bearer not-a-token", "Basic dXNlcjpwYXNz"] {
        for (method, uri, body) in [
            ("PUT", "/api/routing/keys/anthropic", Some(json!({"source":"local","provider":"anthropic","value":KEY}))),
            ("PUT", "/api/routing/1password/token", Some(json!({"value":TOKEN}))),
            ("GET", "/api/routing/keys", None),
            ("DELETE", "/api/routing/keys/anthropic", None),
            ("POST", "/api/routing/keys/anthropic/check", None),
        ] {
            let (status, answer) = call(&app, method, uri, body, false, &[("authorization", authorization)]).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {answer}");
            assert!(answer.contains("take no Agent credential"), "{answer}");
        }
    }
    assert!(!ws.data_dir.join(crate::routing_keys::DIR).exists(), "nothing was written");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_entry_has_none_of_them_and_the_browser_boundary_holds() {
    let (_tmp, ws) = lab();
    let remote = server::remote_router(ws.clone(), ws.data_dir.join("assets"), None, server::RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    for (method, uri, body) in [
        ("PUT", "/api/routing/keys/anthropic", Some(json!({"source":"local","provider":"anthropic","value":KEY}))),
        ("PUT", "/api/routing/1password/token", Some(json!({"value":TOKEN}))),
        ("GET", "/api/routing/keys", None),
        ("GET", "/api/routing/1password", None),
        ("DELETE", "/api/routing/1password/token", None),
    ] {
        let (status, answer) = call(&remote, method, uri, body, true, &[]).await;
        // No route there: 404/405, or for a GET the page's own fallback, never an answer of these routes.
        assert!(unrouted(status) || !answer.contains("\"set\"") && !answer.contains("onePassword"), "the phone entry: {method} {uri} {status} {answer}");
    }
    let local = server::router(ws.clone(), ws.data_dir.join("assets"));
    // A page from another origin, or a request without the client header, is the boundary's to refuse.
    let (status, _) = call(&local, "PUT", "/api/routing/keys/a", Some(json!({"source":"local","provider":"openai","value":KEY})), false,
        &[("origin", "https://elsewhere.example")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let request = Request::builder().method("PUT").uri("/api/routing/keys/a").header("host", "127.0.0.1:4317")
        .header("content-type", "application/json").body(Body::from(json!({"source":"local","provider":"openai","value":KEY}).to_string())).unwrap();
    assert_eq!(local.clone().oneshot(request).await.unwrap().status(), StatusCode::FORBIDDEN, "no client header");
    assert!(!ws.data_dir.join(crate::routing_keys::DIR).exists(), "nothing was written");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_1password_key_without_the_token_checks_as_token_missing() {
    let (_tmp, ws) = lab();
    let app = server::router(ws.clone(), ws.data_dir.join("assets"));
    call(&app, "PUT", "/api/routing/keys/openai",
        Some(json!({"source":"1password","provider":"openai","reference":"op://Vault/OpenAI API/credential"})), false, &[]).await;
    let (status, answer) = call(&app, "POST", "/api/routing/keys/openai/check", None, false, &[]).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let answer: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!((answer["ok"].clone(), answer["reason"]["code"].clone()), (json!(false), json!("tokenMissing")), "{answer}");
    assert_eq!(answer["reason"]["messageZh"], "1Password 服务账号的令牌没设置");
    let (status, answer) = call(&app, "POST", "/api/routing/keys/nobody/check", None, false, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{answer}");
}

/// No Workspace tool an Agent can call reaches a routing key.
#[test]
fn no_workspace_tool_reaches_a_routing_key() {
    let tools = crate::collaboration_store::tool_definitions();
    assert!(tools.len() > 10, "the Workspace's tools are listed");
    for tool in tools {
        let name = tool["name"].as_str().unwrap().to_lowercase();
        assert!(["routing", "secret", "1password", "apikey", "api_key", "credential"].iter().all(|word| !name.contains(word)),
            "no Workspace tool reaches a routing key: {name}");
    }
}
