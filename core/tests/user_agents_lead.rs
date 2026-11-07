//! YN-2 S4, the user's rule: an Agent the user creates in a Project, or moves
//! into one, leads it, through the HTTP API as the browser calls it. Codex
//! Agents only, as in agent_defaults_api.rs: creating one starts its runtime,
//! here a program that does not exist, so nothing runs. Its own test process,
//! so that start cannot hold the files of other tests' stores.
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
async fn an_agent_the_user_creates_or_moves_into_a_project_leads_it() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().to_string_lossy().into_owned();
    let ws = Workspace::new(tmp.path().join("data"), cwd.clone(), "unused-harness".into()).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let (status, project) = call(&router, "POST", "/api/projects", Some(json!({"name":"Lab"}))).await;
    assert_eq!(status, StatusCode::OK, "{project}");
    let id = project["id"].as_str().unwrap().to_owned();
    let leads = format!("/api/projects/{id}/leads");

    let (status, made) = call(&router, "POST", "/api/agents", Some(json!({"name":"Made","cwd":cwd,"projectId":id}))).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let made = made["id"].as_str().unwrap().to_owned();
    let (_, read) = call(&router, "GET", &leads, None).await;
    assert_eq!((read["version"].clone(), read["leadAgentIds"].clone()), (json!(1), json!([made])),
        "an Agent the user creates in a Project leads it: {read}");
    assert_eq!(ws.store.agent_kind(&made).unwrap().as_deref(), Some("lead"));

    let (_, outside) = call(&router, "POST", "/api/agents", Some(json!({"name":"Outside","cwd":cwd}))).await;
    let outside = outside["id"].as_str().unwrap().to_owned();
    assert_eq!(ws.store.agent_kind(&outside).unwrap(), None, "in no Project, it leads none");
    let (status, moved) = call(&router, "POST", &format!("/api/agents/{outside}/project"), Some(json!({"projectId":id}))).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (_, read) = call(&router, "GET", &leads, None).await;
    assert_eq!((read["version"].clone(), read["leadAgentIds"].clone()), (json!(2), json!([made, outside])),
        "an Agent the user moves into a Project leads it: {read}");

    // The user removes a lead: it stays removed; an Agent created after joins the list.
    let (status, saved) = call(&router, "PUT", &leads, Some(json!({"expectedVersion":2,"leadAgentIds":[made]}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (_, later) = call(&router, "POST", "/api/agents", Some(json!({"name":"Later","cwd":cwd,"projectId":id}))).await;
    let later = later["id"].as_str().unwrap().to_owned();
    let (_, read) = call(&router, "GET", &leads, None).await;
    assert_eq!(read["leadAgentIds"], json!([made, later]), "{read}");
    assert_eq!(ws.store.agent_kind(&outside).unwrap(), None, "the lead the user removed stays removed");
}
