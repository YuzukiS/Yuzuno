//! T-190: the workspace default for continuing after a Claude usage limit
//! (T-94) through the HTTP API, as Settings sets it. It says what applies
//! and what is saved; `null` deletes it, back to the built-in off; a request
//! that leaves the choice out, garbles it or adds a field changes nothing.
//! No Agent is created, so no Claude Code starts.
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use serde_json::{json, Value};
use tower::ServiceExt;
use yuzuno_workspace::{server, workspace::Workspace};

async fn call(router: &axum::Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri)
        .header("host", "localhost:4317").header("x-yuzuno-client", "desktop");
    if body.is_some() { request = request.header("content-type", "application/json"); }
    let request = request.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn the_workspace_default_says_what_is_saved_and_only_null_clears_it() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "unused-harness".into()).unwrap();
    let router = server::router_on_port(ws, tmp.path().join("assets"), 4317);
    let path = "/api/claude/auto-continue";
    assert_eq!(call(&router, "GET", path, None).await, (StatusCode::OK, json!({"enabled":false,"saved":null})), "built in: off, nothing saved");
    assert_eq!(call(&router, "POST", path, Some(json!({"enabled":true}))).await, (StatusCode::OK, json!({"enabled":true,"saved":true})));
    assert_eq!(call(&router, "GET", path, None).await.1, json!({"enabled":true,"saved":true}));
    for wrong in [json!({}), json!({"enabled":"no"}), json!({"enabled":0}), json!({"enabled":false,"agent":"a1"})] {
        let (status, _) = call(&router, "POST", path, Some(wrong.clone())).await;
        assert!(status.is_client_error(), "{wrong}: {status}");
        assert_eq!(call(&router, "GET", path, None).await.1, json!({"enabled":true,"saved":true}), "{wrong} changed nothing");
    }
    assert_eq!(call(&router, "POST", path, Some(json!({"enabled":false}))).await.1, json!({"enabled":false,"saved":false}), "off, and saved");
    assert_eq!(call(&router, "POST", path, Some(json!({"enabled":null}))).await, (StatusCode::OK, json!({"enabled":false,"saved":null})), "null: the built-in again");
    assert_eq!(call(&router, "GET", path, None).await.1, json!({"enabled":false,"saved":null}));
}
