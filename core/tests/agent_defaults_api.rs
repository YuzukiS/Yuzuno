//! T-190: defaults for new Agents through the HTTP API, as a client sets
//! and uses them. Codex Agents only: creating one starts its runtime, here a
//! program that does not exist, so nothing runs; a Claude Agent would start
//! this host's Claude Code. Its own test process, so that start cannot hold
//! the files of other tests' stores.
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

fn workspace() -> (tempfile::TempDir, std::sync::Arc<Workspace>, String) {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().to_string_lossy().into_owned();
    let ws = Workspace::new(tmp.path().join("data"), cwd.clone(), "unused-harness".into()).unwrap();
    (tmp, ws, cwd)
}

/// An Agent's own Codex permission preset, asked for when it is created,
/// is its setting. (Before T-190 the create request dropped the field.)
#[tokio::test]
async fn an_agents_own_permission_preset_reaches_its_settings() {
    let (tmp, ws, cwd) = workspace();
    let router = server::router_on_port(ws, tmp.path().join("assets"), 4317);
    let (status, agent) = call(&router, "POST", "/api/agents",
        Some(json!({"name":"Own","cwd":cwd,"harness":"codex","permissionPreset":"config"}))).await;
    assert_eq!(status, StatusCode::OK, "{agent}");
    assert_eq!(agent["settings"]["permissionPreset"], "config", "{agent}");
}

/// The Workspace's defaults reach only Agents created after they are set;
/// an Agent's own choice wins; existing Agents keep theirs; "built in" is no
/// choice at all. Each new Agent says where its values came from.
#[tokio::test]
async fn defaults_reach_only_new_agents_and_say_where_each_value_came_from() {
    let (tmp, ws, cwd) = workspace();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let (_, built_in) = call(&router, "GET", "/api/agent-defaults", None).await;
    assert_eq!(built_in["effective"]["harness"], json!({"value":"codex","source":"builtin"}));
    assert_eq!(built_in["effective"]["codexPermissionPreset"], json!({"value":null,"source":"builtin"}));

    let (_, before) = call(&router, "POST", "/api/agents", Some(json!({"name":"Before","cwd":cwd}))).await;
    assert_eq!(before["harness"], "codex");
    assert!(before["settings"].get("permissionPreset").is_none(), "{before}");
    assert_eq!(before["defaultSources"], json!({"harness":"builtin","permission":"builtin"}));

    let (status, saved) = call(&router, "POST", "/api/agent-defaults",
        Some(json!({"codexPermissionPreset":"config","claudePermissionMode":"auto"}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["effective"]["codexPermissionPreset"], json!({"value":"config","source":"workspace"}));
    let (_, codex) = call(&router, "POST", "/api/agents", Some(json!({"name":"Codex","cwd":cwd}))).await;
    assert_eq!(codex["settings"]["permissionPreset"], "config");
    assert!(codex["settings"].get("permissionMode").is_none(), "a Claude default does not reach a Codex Agent");
    assert_eq!(codex["defaultSources"], json!({"harness":"builtin","permission":"workspace"}));
    let (_, own) = call(&router, "POST", "/api/agents",
        Some(json!({"name":"Own","cwd":cwd,"harness":"codex","permissionPreset":"ask"}))).await;
    assert_eq!(own["settings"]["permissionPreset"], "ask");
    assert_eq!(own["defaultSources"], json!({"harness":"request","permission":"request"}));

    let (status, refused) = call(&router, "POST", "/api/agents",
        Some(json!({"name":"Wrong","cwd":cwd,"harness":"codex","permissionMode":"auto"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let (status, _) = call(&router, "POST", "/api/agent-defaults", Some(json!({"codexPermissionPreset":"yolo"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&router, "POST", "/api/agent-defaults", Some(json!({"model":"x"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a default this Core does not have is refused");

    // Built in again: the choice is deleted, and the next Agent is as before.
    let (_, cleared) = call(&router, "POST", "/api/agent-defaults", Some(json!({"codexPermissionPreset":null}))).await;
    assert_eq!(cleared["saved"], json!({"claudePermissionMode":"auto"}));
    let (_, after) = call(&router, "POST", "/api/agents", Some(json!({"name":"After","cwd":cwd}))).await;
    assert!(after["settings"].get("permissionPreset").is_none(), "{after}");
    assert_eq!(after["defaultSources"]["permission"], "builtin");

    // Existing Agents keep what they were created with.
    let kept = ws.store.agent(before["id"].as_str().unwrap()).unwrap();
    assert_eq!(kept.settings.permission_preset, None);
    let kept = ws.store.agent(codex["id"].as_str().unwrap()).unwrap();
    assert_eq!(kept.settings.permission_preset.as_deref(), Some("config"));
    assert_eq!(ws.store.agents().unwrap().len(), 4, "refused requests created nothing");
}
