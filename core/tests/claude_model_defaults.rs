//! T-190: a default Claude Code model for new Agents on the Core host,
//! through the HTTP API. Core runs the real bridge over a scripted SDK
//! (tests/fixtures/claude_models_bridge.mjs) whose model list is
//! `models.json` in the Workspace folder: no Claude Code runs. Its own test
//! process, as it sets YUZUNO_CLAUDE_BRIDGE for every test in it.
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

/// A Workspace in a fresh folder whose Claude catalog is `models`.
fn workspace(models: &Value) -> (tempfile::TempDir, axum::Router, String) {
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_models_bridge.mjs"));
    let tmp = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let cwd = tmp.path().to_string_lossy().into_owned();
    std::fs::write(tmp.path().join("models.json"), models.to_string()).unwrap();
    let ws = Workspace::new(tmp.path().join("data"), cwd.clone(), "unused-harness".into()).unwrap();
    let router = server::router_on_port(ws, tmp.path().join("assets"), 4317);
    (tmp, router, cwd)
}

fn catalog_reads(dir: &std::path::Path) -> usize {
    std::fs::read_to_string(dir.join("starts")).unwrap_or_default().lines().filter(|l| l.starts_with("folder")).count()
}

fn error(answer: &Value) -> &str {
    answer["error"].as_str().unwrap_or_default()
}

/// Its own field, from Claude Code's catalog on the Core host: a request that
/// leaves the model out (or sends "") inherits it, `null` asks for Claude
/// Code's own default, a named model is used as before. A default the catalog
/// no longer offers, or one that can't run the Auto mode it would get, is
/// said, not used. Codex, SSH machines and existing Agents are untouched,
/// and clearing or saving other fields reads no catalog.
#[tokio::test]
async fn claude_code_on_the_core_host_takes_a_default_model_its_catalog_offers() {
    let (tmp, router, cwd) = workspace(&json!([
        {"value":"sonnet","displayName":"Sonnet","supportsAutoMode":true},
        {"value":"haiku","displayName":"Haiku","supportsAutoMode":false},
    ]));
    let claude = |extra: Value| {
        let mut body = json!({"name":"C","cwd":cwd,"harness":"claude"});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        body
    };
    let created = |agent: &Value| (agent["model"].clone(), agent["defaultSources"]["model"].clone());

    // No default: as before.
    let (status, plain) = call(&router, "POST", "/api/agents", Some(claude(json!({})))).await;
    assert_eq!(status, StatusCode::OK, "{plain}");
    assert_eq!(created(&plain), (json!(""), json!("builtin")));

    // Only what the catalog offers is saved; the Codex fields stay as they are.
    let (status, refused) = call(&router, "POST", "/api/agent-defaults", Some(json!({"claudeModel":"gone"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error(&refused).contains("not among this Core host's Claude Code models") && error(&refused).ends_with("nothing was saved"), "{refused}");
    let (status, saved) = call(&router, "POST", "/api/agent-defaults", Some(json!({"claudeModel":"sonnet"}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["saved"], json!({"claudeModel":"sonnet"}));
    assert_eq!(saved["effective"]["claudeModel"], json!({"value":"sonnet","source":"workspace"}));
    assert_eq!(saved["effective"]["codexModel"], json!({"value":null,"source":"builtin"}));

    let (_, inherit) = call(&router, "POST", "/api/agents", Some(claude(json!({})))).await;
    assert_eq!(created(&inherit), (json!("sonnet"), json!("workspace")), "{inherit}");
    let (_, older) = call(&router, "POST", "/api/agents", Some(claude(json!({"model":""})))).await;
    assert_eq!(created(&older), (json!("sonnet"), json!("workspace")), "an empty model is not a choice: {older}");
    let (_, native) = call(&router, "POST", "/api/agents", Some(claude(json!({"model":null})))).await;
    assert_eq!(created(&native), (json!(""), json!("request")), "{native}");
    let (_, own) = call(&router, "POST", "/api/agents", Some(claude(json!({"model":"opus"})))).await;
    assert_eq!(created(&own), (json!("opus"), json!("request")), "a model named is used as before: {own}");
    assert!(own["defaultSources"].get("effort").is_none(), "no effort default for Claude: {own}");
    let (status, effort) = call(&router, "POST", "/api/agents", Some(claude(json!({"model":"sonnet","reasoningEffort":"high"})))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{effort}");
    assert!(error(&effort).contains("only for Codex on the Core host"), "{effort}");
    // Codex never takes Claude's model.
    let (status, codex) = call(&router, "POST", "/api/agents", Some(json!({"name":"X","cwd":cwd}))).await;
    assert_eq!(status, StatusCode::OK, "{codex}");
    assert_eq!((codex["harness"].clone(), codex["model"].clone(), codex["defaultSources"]["model"].clone()), (json!("codex"), json!(""), json!("builtin")));

    // A project's own model comes first in it.
    let (_, project) = call(&router, "POST", "/api/projects", Some(json!({"name":"P"}))).await;
    let project = project["id"].as_str().unwrap().to_owned();
    let (status, overridden) = call(&router, "POST", &format!("/api/projects/{project}/agent-defaults"), Some(json!({"claudeModel":"haiku"}))).await;
    assert_eq!(status, StatusCode::OK, "{overridden}");
    assert_eq!(overridden["effective"]["claudeModel"], json!({"value":"haiku","source":"project"}));
    let (_, in_project) = call(&router, "POST", "/api/agents", Some(claude(json!({"projectId":project})))).await;
    assert_eq!(created(&in_project), (json!("haiku"), json!("project")), "{in_project}");

    // A default that can't run Auto mode is not used with it; a model or permission of this Agent's own is.
    let (status, _) = call(&router, "POST", "/api/agent-defaults", Some(json!({"claudePermissionMode":"auto"}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, conflict) = call(&router, "POST", "/api/agents", Some(claude(json!({"projectId":project})))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{conflict}");
    assert!(error(&conflict).contains("haiku, the default Claude Code model set for this project, can't run in Auto mode"), "{conflict}");
    let (status, asked) = call(&router, "POST", "/api/agents", Some(claude(json!({"projectId":project,"permissionMode":"default"})))).await;
    assert_eq!(status, StatusCode::OK, "{asked}");
    assert_eq!((asked["model"].clone(), asked["settings"]["permissionMode"].clone()), (json!("haiku"), json!("default")));
    let (status, named) = call(&router, "POST", "/api/agents", Some(claude(json!({"projectId":project,"model":"sonnet"})))).await;
    assert_eq!(status, StatusCode::OK, "{named}");
    assert_eq!((named["model"].clone(), named["settings"]["permissionMode"].clone()), (json!("sonnet"), json!("auto")));

    // No longer offered: said, not used, on the Core host only.
    std::fs::write(tmp.path().join("models.json"), json!([{"value":"haiku","displayName":"Haiku","supportsAutoMode":false}]).to_string()).unwrap();
    let (status, stale) = call(&router, "POST", "/api/agents", Some(claude(json!({})))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{stale}");
    assert!(error(&stale).contains("The default Claude Code model set for this Workspace can't be used now") && error(&stale).contains("Choose a model for this Agent"), "{stale}");
    let (_, remote) = call(&router, "POST", "/api/agents", Some(claude(json!({"machineId":"elsewhere"})))).await;
    assert!(!error(&remote).contains("default Claude Code model") && error(&remote).contains("远程机器不存在"), "an SSH machine keeps its own model: {remote}");

    // Clearing it, or saving another field, reads no catalog.
    std::fs::remove_file(tmp.path().join("models.json")).unwrap();
    let reads = catalog_reads(tmp.path());
    let (status, cleared) = call(&router, "POST", "/api/agent-defaults", Some(json!({"claudeModel":null,"harness":"claude"}))).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["saved"], json!({"harness":"claude","claudePermissionMode":"auto"}));
    assert_eq!(catalog_reads(tmp.path()), reads, "no catalog read to clear or save other fields");
    let (status, unreadable) = call(&router, "POST", "/api/agent-defaults", Some(json!({"claudeModel":"sonnet"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error(&unreadable).starts_with("Can't read this Core host's Claude Code models") && error(&unreadable).ends_with("nothing was saved"), "{unreadable}");

    // The Agent made before any default is as it was.
    let id = plain["id"].as_str().unwrap();
    let (status, detail) = call(&router, "GET", &format!("/api/agents/{id}"), None).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!((detail["agent"]["id"].clone(), detail["agent"]["model"].clone()), (json!(id), json!("")), "{detail}");
    std::fs::write(tmp.path().join("end-session"), "").unwrap();
}

/// A save that waits on Claude's catalog does not undo a change saved
/// meanwhile (as review ac471f13 required for Codex's).
#[tokio::test]
async fn a_save_waiting_on_claudes_catalog_keeps_a_change_saved_meanwhile() {
    let (tmp, router, _) = workspace(&json!([{"value":"sonnet","displayName":"Sonnet"}]));
    std::fs::write(tmp.path().join("hold"), "").unwrap();
    let waiting = tokio::spawn({
        let router = router.clone();
        async move { call(&router, "POST", "/api/agent-defaults", Some(json!({"claudeModel":"sonnet"}))).await }
    });
    let mut polls = 0;
    while !tmp.path().join("listing").exists() {
        polls += 1;
        assert!(polls < 1500, "the catalog was not asked for its models");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let (status, meanwhile) = call(&router, "POST", "/api/agent-defaults", Some(json!({"claudePermissionMode":"auto"}))).await;
    assert_eq!(status, StatusCode::OK, "{meanwhile}");
    std::fs::remove_file(tmp.path().join("hold")).unwrap();
    let (status, saved) = waiting.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["saved"], json!({"claudePermissionMode":"auto","claudeModel":"sonnet"}));
}
