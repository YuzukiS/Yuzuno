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
    assert_eq!(before["defaultSources"], json!({"harness":"builtin","permission":"builtin","model":"builtin","effort":"builtin"}));

    let (status, saved) = call(&router, "POST", "/api/agent-defaults",
        Some(json!({"codexPermissionPreset":"config","claudePermissionMode":"auto"}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["effective"]["codexPermissionPreset"], json!({"value":"config","source":"workspace"}));
    let (_, codex) = call(&router, "POST", "/api/agents", Some(json!({"name":"Codex","cwd":cwd}))).await;
    assert_eq!(codex["settings"]["permissionPreset"], "config");
    assert!(codex["settings"].get("permissionMode").is_none(), "a Claude default does not reach a Codex Agent");
    assert_eq!(codex["defaultSources"], json!({"harness":"builtin","permission":"workspace","model":"builtin","effort":"builtin"}));
    let (_, own) = call(&router, "POST", "/api/agents",
        Some(json!({"name":"Own","cwd":cwd,"harness":"codex","permissionPreset":"ask"}))).await;
    assert_eq!(own["settings"]["permissionPreset"], "ask");
    assert_eq!(own["defaultSources"], json!({"harness":"request","permission":"request","model":"builtin","effort":"builtin"}));

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

/// A project's overrides (T-190): for Agents created in it, after their own
/// choice and before the Workspace's; only for Agents created from then on;
/// `null` deletes only the project's choice, which then inherits again.
#[tokio::test]
async fn a_projects_overrides_reach_only_new_agents_in_it_and_null_inherits_again() {
    let (tmp, ws, cwd) = workspace();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let (status, project) = call(&router, "POST", "/api/projects", Some(json!({"name":"Lab"}))).await;
    assert_eq!(status, StatusCode::OK, "{project}");
    let id = project["id"].as_str().unwrap().to_owned();
    let overrides = format!("/api/projects/{id}/agent-defaults");
    call(&router, "POST", "/api/agent-defaults", Some(json!({"codexPermissionPreset":"config"}))).await;
    let (_, before) = call(&router, "POST", "/api/agents", Some(json!({"name":"Before","cwd":cwd,"projectId":id}))).await;
    assert_eq!((before["settings"]["permissionPreset"].clone(), before["defaultSources"]["permission"].clone()), (json!("config"), json!("workspace")), "{before}");

    let (status, saved) = call(&router, "POST", &overrides, Some(json!({"codexPermissionPreset":"auto"}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["effective"]["codexPermissionPreset"], json!({"value":"auto","source":"project"}));
    assert_eq!(saved["project"]["inherited"]["codexPermissionPreset"], json!({"value":"config","source":"workspace"}));
    let (_, read) = call(&router, "GET", &format!("/api/agent-defaults?projectId={id}"), None).await;
    assert_eq!((read["project"]["saved"].clone(), read["effective"]["harness"].clone()),
        (json!({"codexPermissionPreset":"auto"}), json!({"value":"codex","source":"builtin"})), "{read}");
    let (_, outside_view) = call(&router, "GET", "/api/agent-defaults", None).await;
    assert_eq!(outside_view["effective"]["codexPermissionPreset"], json!({"value":"config","source":"workspace"}), "the Workspace's view is unchanged");
    assert!(outside_view.get("project").is_none());

    let (_, inside) = call(&router, "POST", "/api/agents", Some(json!({"name":"Inside","cwd":cwd,"projectId":id}))).await;
    assert_eq!(inside["settings"]["permissionPreset"], "auto", "{inside}");
    assert_eq!(inside["defaultSources"], json!({"harness":"builtin","permission":"project","model":"builtin","effort":"builtin"}));
    let (_, outside) = call(&router, "POST", "/api/agents", Some(json!({"name":"Outside","cwd":cwd}))).await;
    assert_eq!((outside["settings"]["permissionPreset"].clone(), outside["defaultSources"]["permission"].clone()), (json!("config"), json!("workspace")));
    let (_, asked) = call(&router, "POST", "/api/agents", Some(json!({"name":"Asked","cwd":cwd,"projectId":id,"permissionPreset":"ask"}))).await;
    assert_eq!((asked["settings"]["permissionPreset"].clone(), asked["defaultSources"]["permission"].clone()), (json!("ask"), json!("request")));
    let (status, refused) = call(&router, "POST", "/api/agents",
        Some(json!({"name":"Wrong","cwd":cwd,"projectId":id,"harness":"codex","permissionMode":"auto"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "another harness's permission is refused in a project too: {refused}");
    // An Agent created before the override keeps what it was created with.
    let kept = ws.store.agent(before["id"].as_str().unwrap()).unwrap();
    assert_eq!(kept.settings.permission_preset.as_deref(), Some("config"));

    // null deletes only the project's choice; a field left out stays as it is.
    call(&router, "POST", &overrides, Some(json!({"harness":"codex"}))).await;
    let (_, cleared) = call(&router, "POST", &overrides, Some(json!({"codexPermissionPreset":null}))).await;
    assert_eq!(cleared["project"]["saved"], json!({"harness":"codex"}), "{cleared}");
    assert_eq!(cleared["effective"]["codexPermissionPreset"], json!({"value":"config","source":"workspace"}), "inherited again");
    assert_eq!(cleared["saved"], json!({"codexPermissionPreset":"config"}), "the Workspace's choice is untouched");
    // Refused: a mode no harness here has, a default this Core doesn't have, a project that doesn't exist.
    let (status, _) = call(&router, "POST", &overrides, Some(json!({"claudePermissionMode":"bypassPermissions"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&router, "POST", &overrides, Some(json!({"model":"x"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&router, "POST", "/api/projects/no-such-project/agent-defaults", Some(json!({"harness":"codex"}))).await;
    assert!(!status.is_success(), "{status}");
    // An archived project's defaults are not changed, as nothing else of it is.
    let (status, _) = call(&router, "PATCH", &format!("/api/projects/{id}"), Some(json!({"archived":true}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, archived) = call(&router, "POST", &overrides, Some(json!({"harness":"claude"}))).await;
    assert!(!status.is_success() && archived["error"].as_str().unwrap_or_default().contains("archived"), "{status} {archived}");
    let (_, still) = call(&router, "GET", &format!("/api/agent-defaults?projectId={id}"), None).await;
    assert_eq!(still["project"]["saved"], json!({"harness":"codex"}), "unchanged: {still}");
    assert_eq!(ws.store.agents().unwrap().len(), 4, "refused requests created nothing");
}

/// A stub Codex app-server: its model list is read from `models.json` beside
/// it on each request, so a test can change what the Core host offers.
fn stub_codex(dir: &std::path::Path, models: &Value) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(dir.join("models.json"), models.to_string()).unwrap();
    let script = dir.join("codex.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, os, sys, time
root = os.path.dirname(os.path.abspath(__file__))
class _TurnsList:
    """thread/turns/list answered as this fake's thread/read (T-140)."""
    def __init__(self, raw): self.raw, self.ids, self.buf = raw, set(), ''
    def write(self, text):
        self.buf += text
        while '\n' in self.buf:
            line, self.buf = self.buf.split('\n', 1)
            try:
                v = json.loads(line)
                if isinstance(v, dict) and v.get('id') in self.ids and 'result' in v:
                    self.ids.discard(v['id'])
                    turns = ((v['result'] or {}).get('thread') or {}).get('turns') or []
                    v['result'] = {'data': list(reversed(turns)), 'nextCursor': None}
                    line = json.dumps(v)
            except ValueError: pass
            self.raw.write(line + '\n')
        return len(text)
    def flush(self): self.raw.flush()
sys.stdout = _TurnsList(sys.stdout)
for line in sys.stdin:
    r = json.loads(line)
    if 'id' not in r: continue
    m = r.get('method')
    if m=='thread/turns/list': sys.stdout.ids.add(r['id']); m='thread/read'
    result = {}
    if m == 'model/list':
        # While `hold` exists, the list waits, and says so with `listing`.
        if os.path.exists(os.path.join(root, 'hold')):
            open(os.path.join(root, 'listing'), 'w').close()
            while os.path.exists(os.path.join(root, 'hold')): time.sleep(0.02)
        with open(os.path.join(root, 'models.json')) as f: result = {'data': json.load(f), 'nextCursor': None}
    elif m in ['thread/start', 'thread/resume', 'thread/read']:
        result = {'thread': {'id': 'thread', 'status': {'type': 'idle'}, 'turns': []}, 'model': 'm-big'}
    elif m == 'config/read':
        result = {'config': {}}
    print(json.dumps({'id': r['id'], 'result': result}), flush=True)
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    script.to_string_lossy().into_owned()
}

/// A default model and effort (T-190): Codex on the Core host only, from its
/// catalog, as one pair; a request that leaves the model out (or sends "")
/// inherits it, `null` asks for Codex's own default; a default the catalog no
/// longer offers is said, not used. Elsewhere an effort is refused.
#[tokio::test]
async fn codex_on_the_core_host_takes_a_default_model_and_effort_its_catalog_offers() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().to_string_lossy().into_owned();
    let small = json!({"id":"m-small","model":"m-small","defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"}]});
    let big = json!({"id":"m-big","model":"m-big","supportedReasoningEfforts":[{"reasoningEffort":"high"}]});
    let codex = stub_codex(tmp.path(), &json!([small, big]));
    let ws = Workspace::new(tmp.path().join("data"), cwd.clone(), codex).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let created = |agent: &Value| (agent["model"].clone(), agent["settings"]["reasoningEffort"].clone(), agent["defaultSources"]["model"].clone(), agent["defaultSources"]["effort"].clone());

    // No default: as before.
    let (status, plain) = call(&router, "POST", "/api/agents", Some(json!({"name":"Plain","cwd":cwd}))).await;
    assert_eq!(status, StatusCode::OK, "{plain}");
    assert_eq!(created(&plain), (json!(""), Value::Null, json!("builtin"), json!("builtin")));

    // Only what the catalog offers is saved, as a pair.
    let (status, refused) = call(&router, "POST", "/api/agent-defaults", Some(json!({"codexModel":"gone"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(refused["error"].as_str().unwrap().contains("not among this Core host's Codex models") && refused["error"].as_str().unwrap().ends_with("nothing was saved"), "{refused}");
    let (status, _) = call(&router, "POST", "/api/agent-defaults", Some(json!({"codexModel":"m-small","codexReasoningEffort":"high"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "an effort its model doesn't offer");
    let (status, saved) = call(&router, "POST", "/api/agent-defaults", Some(json!({"codexModel":"m-big","codexReasoningEffort":"high"}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!((saved["effective"]["codexModel"].clone(), saved["effective"]["codexReasoningEffort"].clone()),
        (json!({"value":"m-big","source":"workspace"}), json!({"value":"high","source":"workspace"})));

    let (_, inherit) = call(&router, "POST", "/api/agents", Some(json!({"name":"Inherit","cwd":cwd}))).await;
    assert_eq!(created(&inherit), (json!("m-big"), json!("high"), json!("workspace"), json!("workspace")), "{inherit}");
    let (_, older) = call(&router, "POST", "/api/agents", Some(json!({"name":"Older","cwd":cwd,"model":""}))).await;
    assert_eq!(created(&older).0, json!("m-big"), "an empty model is not a choice: {older}");
    let (_, native) = call(&router, "POST", "/api/agents", Some(json!({"name":"Native","cwd":cwd,"model":null}))).await;
    assert_eq!(created(&native), (json!(""), Value::Null, json!("request"), json!("builtin")), "{native}");
    let (_, own) = call(&router, "POST", "/api/agents", Some(json!({"name":"Own","cwd":cwd,"model":"m-small","reasoningEffort":"low"}))).await;
    assert_eq!(created(&own), (json!("m-small"), json!("low"), json!("request"), json!("request")), "{own}");
    for (body, why) in [
        (json!({"name":"Wrong","cwd":cwd,"model":"m-small","reasoningEffort":"high"}), "doesn't offer the reasoning effort high"),
        (json!({"name":"Wrong","cwd":cwd,"reasoningEffort":"high"}), "Choose the Codex model"),
        (json!({"name":"Wrong","cwd":cwd,"harness":"claude","reasoningEffort":"high"}), "only for Codex on the Core host"),
    ] {
        let (status, refused) = call(&router, "POST", "/api/agents", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert!(refused["error"].as_str().unwrap().contains(why), "{refused}");
    }

    // A project's model comes with its own effort (none), not the Workspace's.
    let (_, project) = call(&router, "POST", "/api/projects", Some(json!({"name":"Lab"}))).await;
    let id = project["id"].as_str().unwrap().to_owned();
    let (status, set) = call(&router, "POST", &format!("/api/projects/{id}/agent-defaults"), Some(json!({"codexModel":"m-small"}))).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let (_, in_project) = call(&router, "POST", "/api/agents", Some(json!({"name":"In project","cwd":cwd,"projectId":id}))).await;
    assert_eq!(created(&in_project), (json!("m-small"), Value::Null, json!("project"), json!("builtin")), "{in_project}");

    // The Core host stops offering the Workspace's model: the next Agent is refused, and says so.
    std::fs::write(tmp.path().join("models.json"), json!([small]).to_string()).unwrap();
    let (status, stale) = call(&router, "POST", "/api/agents", Some(json!({"name":"Stale","cwd":cwd}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{stale}");
    let why = stale["error"].as_str().unwrap();
    assert!(why.contains("default Codex model set for this Workspace can't be used now") && why.contains("Choose a model for this Agent"), "{stale}");
    // Agents already created keep theirs.
    let kept = ws.store.agent(inherit["id"].as_str().unwrap()).unwrap();
    assert_eq!((kept.model.as_str(), kept.settings.reasoning_effort.as_deref()), ("m-big", Some("high")));
    assert_eq!(ws.store.agents().unwrap().len(), 6, "refused requests created nothing");
}

/// A save that waits on the catalog does not undo a change saved meanwhile:
/// it reads, changes and writes the defaults in one store transaction
/// (review ac471f13).
#[tokio::test]
async fn a_save_waiting_on_the_catalog_keeps_a_change_saved_meanwhile() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().to_string_lossy().into_owned();
    let codex = stub_codex(tmp.path(), &json!([{"id":"m-big","model":"m-big","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}]));
    let ws = Workspace::new(tmp.path().join("data"), cwd, codex).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);

    std::fs::write(tmp.path().join("hold"), "").unwrap();
    let waiting = tokio::spawn({
        let router = router.clone();
        async move { call(&router, "POST", "/api/agent-defaults", Some(json!({"codexModel":"m-big"}))).await }
    });
    let mut polls = 0;
    while !tmp.path().join("listing").exists() {
        polls += 1;
        assert!(polls < 1500, "the catalog was not asked for its models");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let (status, meanwhile) = call(&router, "POST", "/api/agent-defaults", Some(json!({"harness":"claude"}))).await;
    assert_eq!(status, StatusCode::OK, "{meanwhile}");
    std::fs::remove_file(tmp.path().join("hold")).unwrap();

    let (status, saved) = waiting.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["saved"], json!({"harness":"claude","codexModel":"m-big"}));
    let (_, read) = call(&router, "GET", "/api/agent-defaults", None).await;
    assert_eq!(read["saved"], json!({"harness":"claude","codexModel":"m-big"}));
}
