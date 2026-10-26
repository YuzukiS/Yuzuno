#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tower::ServiceExt;
use yuzuno_workspace::{model::AgentDetail, server, store::Store, workspace::Workspace};

fn agent(id: &str, cwd: &str, closed: bool) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":id, "name":format!("Agent {id}"), "cwd":cwd, "model":"", "color":"sage",
        "harness":"codex", "threadId":format!("session-{id}"), "status":"idle",
        "closedAt": if closed { json!("2026-10-12T00:00:00Z") } else { Value::Null },
        "createdAt":"", "updatedAt":"", "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

fn in_project(id: &str, project: &str) -> AgentDetail {
    let mut detail = agent(id, "/workspace", false);
    detail.agent.project_id = Some(project.into());
    detail
}

fn raw_agent_json(path: &std::path::Path, id: &str) -> Value {
    let db = Connection::open(path).unwrap();
    let raw: String = db.query_row("SELECT data FROM agents WHERE id=?1", [id], |r| r.get(0)).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn membership_is_explicit_and_never_stored_in_agent_records() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let main = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    let other = store.create_project("Research", BTreeMap::new()).unwrap();
    // Agent folders are unrestricted: an external worktree belongs to the same project.
    let mut main_folder = in_project("main", &main.id);
    main_folder.agent.cwd = "/home/u/yuzuno-next".into();
    let mut worktree = in_project("worktree", &main.id);
    worktree.agent.cwd = "/home/u/yuzuno-next-collaboration".into();
    store.insert(&main_folder).unwrap();
    store.insert(&worktree).unwrap();
    store.insert(&agent("loose", "/home/u/yuzuno-next", false)).unwrap();

    let agents = store.agents().unwrap();
    let project_of = |id: &str| agents.iter().find(|a| a.id == id).unwrap().project_id.clone();
    assert_eq!(project_of("main").as_deref(), Some(main.id.as_str()));
    assert_eq!(project_of("worktree").as_deref(), Some(main.id.as_str()));
    assert_eq!(project_of("loose"), None, "a shared folder never implies membership");
    assert!(raw_agent_json(&path, "main")["agent"].get("projectId").is_none());

    // Ordinary record updates keep the link, and report it to their callers.
    let updated = store.update("main", "turn/completed", &json!({"turn":{"id":"t1"}}), |d| d.agent.status = "idle".into()).unwrap();
    assert_eq!(updated.agent.project_id.as_deref(), Some(main.id.as_str()));
    assert!(raw_agent_json(&path, "main")["agent"].get("projectId").is_none());
    let before = store.detail("main").unwrap().agent;
    store.set_agent_project("main", Some(&other.id)).unwrap();
    let after = store.detail("main").unwrap().agent;
    assert_eq!(after.project_id.as_deref(), Some(other.id.as_str()));
    assert_eq!((after.cwd, after.last_seq, after.reviewed_seq, after.unread_count),
        (before.cwd, before.last_seq, before.reviewed_seq, before.unread_count));
    assert!(raw_agent_json(&path, "main")["agent"].get("projectId").is_none());
    store.set_agent_project("main", None).unwrap();
    assert_eq!(store.detail("main").unwrap().agent.project_id, None);
}

#[test]
fn archived_projects_keep_members_but_accept_none_and_delete_only_when_unused() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("App", BTreeMap::new()).unwrap();
    assert!(store.create_project(" app ", BTreeMap::new()).is_err(), "active names are unique");
    store.insert(&in_project("a", &project.id)).unwrap();
    let archived = store.update_project(&project.id, yuzuno_workspace::projects::ProjectChange {
        name: None, default_dirs: BTreeMap::new(), archived: Some(true) }).unwrap();
    assert!(archived.archived_at.is_some());
    assert_eq!(store.detail("a").unwrap().agent.project_id.as_deref(), Some(project.id.as_str()));
    store.insert(&agent("b", "/workspace", false)).unwrap();
    assert!(store.set_agent_project("b", Some(&project.id)).unwrap_err().to_string().contains("project_archived"));
    assert!(store.insert(&in_project("c", &project.id)).is_err());
    assert!(store.detail("c").is_err(), "a rejected membership creates no Agent");
    // An archived name can be reused by a new active project.
    store.create_project("App", BTreeMap::new()).unwrap();
    assert!(store.delete_project(&project.id).unwrap_err().to_string().contains("project_in_use"));
    store.set_agent_project("a", None).unwrap();
    store.delete_project(&project.id).unwrap();
    assert!(store.project(&project.id).is_err());
}

#[test]
fn deleting_agents_cascades_even_from_plain_sql_and_reopen_sweeps_orphans() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("workspace.sqlite");
    let project_id;
    {
        let store = Store::open(&path).unwrap();
        project_id = store.create_project("App", BTreeMap::new()).unwrap().id;
        let mut closed = agent("closed", "/workspace", true);
        closed.agent.project_id = Some(project_id.clone());
        store.insert(&closed).unwrap();
        store.insert(&in_project("plain-sql", &project_id)).unwrap();
        store.insert(&in_project("manual", &project_id)).unwrap();
        store.delete_closed_agent("closed").unwrap();
    }
    let count = |db: &Connection, id: &str| -> i64 {
        db.query_row("SELECT COUNT(*) FROM project_agents WHERE agent_id=?1", [id], |r| r.get(0)).unwrap()
    };
    {
        // An older Core issues exactly these statements with foreign keys on.
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        assert_eq!(count(&db, "closed"), 0);
        db.execute("DELETE FROM journal WHERE agent_id='plain-sql'", []).unwrap();
        db.execute("DELETE FROM agents WHERE id='plain-sql'", []).unwrap();
        assert_eq!(count(&db, "plain-sql"), 0);
        // A manual edit with foreign keys off leaves an orphan behind.
        db.execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM agents WHERE id='manual';").unwrap();
        assert_eq!(count(&db, "manual"), 1);
    }
    let store = Store::open(&path).unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    assert_eq!(count(&db, "manual"), 0, "every open sweeps orphan links");
    let projects: i64 = db.query_row("SELECT COUNT(*) FROM projects WHERE id=?1", [&project_id], |r| r.get(0)).unwrap();
    assert_eq!(projects, 1, "the project itself survives");
}

fn call(store: &Store, actor: Option<&str>, operation: &str, input: Value) -> Value {
    store.collaboration_call(actor, operation, input).unwrap()
}

#[test]
fn task_project_defaults_follow_the_creator_and_retries_return_the_first_answer() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    let app = store.create_project("App", BTreeMap::new()).unwrap();
    let research = store.create_project("Research", BTreeMap::new()).unwrap();
    store.insert(&in_project("dev", &app.id)).unwrap();
    store.insert(&in_project("helper", &research.id)).unwrap();

    let first = call(&store, Some("dev"), "task_create", json!({"requestId":"r1","title":"Default"}));
    assert_eq!(first["task"]["projectId"], json!(app.id));
    assert_eq!(first["activity"]["changes"]["projectId"], json!(app.id));
    let none = call(&store, Some("dev"), "task_create", json!({"requestId":"r2","title":"Explicit none","projectId":null}));
    assert_eq!(none["task"]["projectId"], Value::Null);
    let user = call(&store, None, "task_create", json!({"requestId":"r3","title":"From the GUI"}));
    assert_eq!(user["task"]["projectId"], Value::Null, "the user has no project to default to");
    let explicit = call(&store, Some("dev"), "task_create", json!({"requestId":"r4","title":"Elsewhere","projectId":research.id}));
    assert_eq!(explicit["task"]["projectId"], json!(research.id));

    // The creator moves; retrying the same request is the same task and project.
    store.set_agent_project("dev", Some(&research.id)).unwrap();
    let retry = call(&store, Some("dev"), "task_create", json!({"requestId":"r1","title":"Default"}));
    assert_eq!(retry["task"]["id"], first["task"]["id"]);
    assert_eq!(retry["task"]["projectId"], json!(app.id));
    let listed = call(&store, None, "task_list", json!({"projectId":app.id}));
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 1);

    // Assigning across projects never changes the task's project.
    let dispatched = call(&store, None, "task_dispatch", json!({"requestId":"d1","taskId":first["task"]["id"],
        "expectedVersion":1,"toAgentId":"helper"}));
    assert_eq!(dispatched["task"]["assigneeAgentId"], "helper");
    assert_eq!(dispatched["task"]["projectId"], json!(app.id));

    let archived = store.update_project(&research.id, yuzuno_workspace::projects::ProjectChange {
        name: None, default_dirs: BTreeMap::new(), archived: Some(true) }).unwrap();
    assert!(archived.archived_at.is_some());
    // An Agent still in an archived project files new tasks under no project.
    let fallback = call(&store, Some("helper"), "task_create", json!({"requestId":"r7","title":"After archive"}));
    assert_eq!(fallback["task"]["projectId"], Value::Null);
    assert_eq!(fallback["projectNotice"]["code"], "project_archived");
    assert_eq!(fallback["projectNotice"]["projectId"], json!(research.id));
    let again = call(&store, Some("helper"), "task_create", json!({"requestId":"r7","title":"After archive"}));
    assert_eq!(again, fallback, "a retry replays the same answer and notice");
    let error = store.collaboration_call(None, "task_create",
        json!({"requestId":"r5","title":"Into archive","projectId":research.id})).unwrap_err();
    assert!(error.to_string().contains("project_archived"));
    assert!(store.collaboration_call(None, "task_create",
        json!({"requestId":"r6","title":"Bad","projectId":7})).is_err());
}

#[test]
fn task_project_updates_share_version_checks_and_list_filters_apply_to_counts() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    let app = store.create_project("App", BTreeMap::new()).unwrap();
    let research = store.create_project("Research", BTreeMap::new()).unwrap();
    let task = call(&store, None, "task_create", json!({"requestId":"c","title":"Move me","projectId":app.id}));
    let id = task["task"]["id"].clone();
    call(&store, None, "task_create", json!({"requestId":"c2","title":"Loose","status":"doing"}));

    let kept = call(&store, None, "task_update", json!({"requestId":"u1","taskId":id,"expectedVersion":1,"patch":{"status":"doing"}}));
    assert_eq!(kept["task"]["projectId"], json!(app.id), "absent keeps the project");
    let stale = store.collaboration_call(None, "task_update",
        json!({"requestId":"u2","taskId":id,"expectedVersion":1,"patch":{"projectId":research.id}}));
    assert!(stale.unwrap_err().to_string().contains("version_conflict"));
    assert_eq!(call(&store, None, "task_get", json!({"taskId":id}))["task"]["projectId"], json!(app.id),
        "a rejected update leaves the project unchanged");
    let moved = call(&store, None, "task_update", json!({"requestId":"u3","taskId":id,"expectedVersion":2,"patch":{"projectId":research.id}}));
    assert_eq!(moved["task"]["projectId"], json!(research.id));
    assert_eq!(moved["task"]["version"], 3);
    assert_eq!(moved["activity"]["changes"]["projectId"], json!(research.id));
    let cleared = call(&store, None, "task_update", json!({"requestId":"u4","taskId":id,"expectedVersion":3,"patch":{"projectId":null}}));
    assert_eq!(cleared["task"]["projectId"], Value::Null);
    call(&store, None, "task_update", json!({"requestId":"u5","taskId":id,"expectedVersion":4,"patch":{"projectId":app.id}}));

    let all = call(&store, None, "task_list", json!({}));
    assert_eq!(all["tasks"].as_array().unwrap().len(), 2);
    let scoped = call(&store, None, "task_list", json!({"projectId":app.id}));
    assert_eq!(scoped["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["counts"]["doing"], 1);
    let loose = call(&store, None, "task_list", json!({"projectId":null}));
    assert_eq!(loose["tasks"][0]["title"], "Loose");
    assert_eq!(loose["tasks"][0]["projectId"], Value::Null);
    let empty = call(&store, None, "task_list", json!({"projectId":research.id}));
    assert_eq!(empty["tasks"].as_array().unwrap().len(), 0);
    assert_eq!(empty["counts"]["doing"], 0);
    let unknown = store.collaboration_call(None, "task_list", json!({"projectId":"App"})).unwrap_err();
    assert!(unknown.to_string().contains("project_not_found"), "a name or typo is not an empty project");
}

#[test]
fn peers_list_shows_each_agents_project() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    let app = store.create_project("App", BTreeMap::new()).unwrap();
    store.insert(&in_project("dev", &app.id)).unwrap();
    store.insert(&agent("loose", "/workspace", false)).unwrap();
    let empty = store.create_project("Empty", BTreeMap::new()).unwrap();
    let old = store.create_project("Old", BTreeMap::new()).unwrap();
    store.update_project(&old.id, yuzuno_workspace::projects::ProjectChange {
        name: None, default_dirs: BTreeMap::new(), archived: Some(true) }).unwrap();
    let peers = call(&store, Some("dev"), "peers_list", json!({}));
    let project = |id: &str| peers["peers"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap()["project"].clone();
    assert_eq!(project("dev"), json!({"id":app.id,"name":"App","archived":false}));
    assert_eq!(project("loose"), Value::Null);
    // Projects without agents are still addressable, and archived ones are marked.
    let listed = call(&store, Some("dev"), "projects_list", json!({}));
    assert_eq!(listed["projects"], json!([
        {"id":app.id,"name":"App","archived":false},
        {"id":empty.id,"name":"Empty","archived":false},
        {"id":old.id,"name":"Old","archived":true},
    ]));
    assert!(store.collaboration_call(Some("dev"), "projects_list", json!({"x":1})).is_err());
    assert!(yuzuno_workspace::collaboration_store::tool_definitions().iter().any(|t| t["name"] == "projects_list"));
}

async fn request(router: &axum::Router, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
    let response = router.clone().oneshot(Request::builder().method(method).uri(uri)
        .header("host", "localhost:4317").header("x-yuzuno-client", "desktop")
        .header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn project_api_validates_default_folders_and_moves_agents() {
    let tmp = tempfile::tempdir().unwrap();
    let main = tmp.path().join("yuzuno-next");
    let worktree = tmp.path().join("yuzuno-next-collaboration");
    std::fs::create_dir_all(&main).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    let ws = Workspace::new(tmp.path().join("data"), main.to_string_lossy().into_owned(), "unused-harness".into()).unwrap();
    ws.store.insert(&agent("existing", &worktree.to_string_lossy(), true)).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);

    let (status, created) = request(&router, "POST", "/api/projects",
        json!({"name":"yuzuno-next","defaultDirs":{"local":format!("{}/./", main.display())}})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["defaultDirs"]["local"], json!(main.canonicalize().unwrap()));
    let (status, missing) = request(&router, "PATCH", &format!("/api/projects/{id}"),
        json!({"defaultDirs":{"local":tmp.path().join("missing")}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{missing}");
    let (status, unknown_machine) = request(&router, "PATCH", &format!("/api/projects/{id}"),
        json!({"defaultDirs":{"not-a-machine":"/tmp"}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{unknown_machine}");
    let (status, renamed) = request(&router, "PATCH", &format!("/api/projects/{id}"),
        json!({"name":"Yuzuno next","defaultDirs":{"local":null}})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["name"], "Yuzuno next");
    assert!(renamed["defaultDirs"].get("local").is_none());

    // Moving a closed Agent is a membership change only; its folder is untouched.
    let (status, moved) = request(&router, "POST", "/api/agents/existing/project", json!({"projectId":id})).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["projectId"], json!(id));
    assert_eq!(moved["cwd"], json!(worktree.to_string_lossy()));
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Linked","projectId":id})).unwrap();
    let (_, workspace) = request(&router, "GET", "/api/workspace", Value::Null).await;
    assert_eq!(workspace["workspace"]["id"], json!(ws.store.workspace_id().unwrap()));
    assert_eq!(workspace["projects"][0]["id"], json!(id));
    assert_eq!(workspace["agents"][0]["projectId"], json!(id));
    assert_eq!(workspace["projectUsage"][&id], json!({"agents":1,"tasks":1}));

    let (status, in_use) = request(&router, "DELETE", &format!("/api/projects/{id}"), Value::Null).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(in_use["error"].as_str().unwrap().contains("archive it instead"));
    let (status, _) = request(&router, "POST", "/api/agents/existing/project", json!({"projectId":null})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, tasks_only) = request(&router, "DELETE", &format!("/api/projects/{id}"), Value::Null).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a linked task also keeps the project");
    assert!(tasks_only["error"].as_str().unwrap().contains("0 agent(s) and 1 task(s)"));
    let (_, empty) = request(&router, "POST", "/api/projects", json!({"name":"Empty"})).await;
    let (status, _) = request(&router, "DELETE", &format!("/api/projects/{}", empty["id"].as_str().unwrap()), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn closing_an_agent_reports_its_project() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "unused-harness".into()).unwrap();
    let project = ws.store.create_project("App", BTreeMap::new()).unwrap();
    ws.store.insert(&in_project("open", &project.id)).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let (status, closed) = request(&router, "POST", "/api/agents/open/close", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert!(closed["closedAt"].is_string());
    assert_eq!(closed["projectId"], json!(project.id), "the UI swaps this copy into its state");
}

#[tokio::test]
async fn creating_an_agent_can_save_its_folder_as_the_project_default() {
    let tmp = tempfile::tempdir().unwrap();
    let worktree = tmp.path().join("outside-worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "unused-harness".into()).unwrap();
    let project = ws.store.create_project("App", BTreeMap::new()).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let (status, created) = request(&router, "POST", "/api/agents", json!({"name":"Dev","cwd":worktree,
        "projectId":project.id,"saveProjectDefault":true})).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["projectId"], json!(project.id));
    assert_eq!(ws.store.project(&project.id).unwrap().default_dirs["local"],
        worktree.canonicalize().unwrap().to_string_lossy());
    let (status, plain) = request(&router, "POST", "/api/agents", json!({"name":"Loose","cwd":worktree})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(plain.get("projectId").is_none());
    let (status, _) = request(&router, "POST", "/api/agents", json!({"name":"Ghost","cwd":worktree,"projectId":"missing"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(ws.store.agents().unwrap().len(), 2, "an invalid project creates no Agent");
}
