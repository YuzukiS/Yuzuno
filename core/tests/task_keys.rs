//! Per-Project task keys (T-56): a Project's key from its name, unique in the
//! Workspace forever; a task numbered in its Project as `<KEY>-<n>`; `T-<seq>`
//! for a task in no Project and for every task numbered before keys came; and
//! every key a task or a Project ever had still naming it, in every tool.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use yuzuno_workspace::{projects::ProjectChange, store::Store, workspace::Workspace};

fn call(store: &Store, actor: Option<&str>, operation: &str, input: Value) -> Value {
    store.collaboration_call(actor, operation, input).unwrap()
}

fn refused(store: &Store, operation: &str, input: Value) -> String {
    store.collaboration_call(None, operation, input).unwrap_err().to_string()
}

/// A Project key change the store refuses, as its message ("" if it took it).
fn key_refused(store: &Store, project: &str, key: &str) -> String {
    store.update_project(project, key_change(key)).err().map(|e| e.to_string()).unwrap_or_default()
}

fn key_change(key: &str) -> ProjectChange {
    ProjectChange { name: None, key: Some(key.into()), default_dirs: BTreeMap::new(), archived: None }
}

fn create(store: &Store, request: &str, project: Option<&str>) -> String {
    let created = call(store, None, "task_create", json!({"requestId":request,"title":request,"projectId":project}));
    created["task"]["id"].as_str().unwrap().to_owned()
}

fn moved(store: &Store, request: &str, task: &str, project: Option<&str>) -> Value {
    let version = call(store, None, "task_get", json!({"taskId":task,"view":"current"}))["current"]["version"].clone();
    call(store, None, "task_update", json!({"requestId":request,"taskId":task,"expectedVersion":version,
        "patch":{"projectId":project}}))
}

fn shown(store: &Store, task: &str) -> String {
    named(store, task).unwrap_or_else(|| panic!("{task} names no task"))
}

/// The key a reference shows its task by now, None if it names no task.
fn named(store: &Store, task: &str) -> Option<String> {
    let got = store.collaboration_call(None, "task_get", json!({"taskId":task})).ok()?;
    got["task"]["id"].as_str().map(str::to_owned)
}

fn open(dir: &tempfile::TempDir) -> Store {
    Store::open(&dir.path().join("workspace.sqlite")).unwrap()
}

#[test]
fn project_keys_come_from_names_and_are_unique_in_the_workspace_forever() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let next = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    assert_eq!(next.key.as_deref(), Some("YN"));
    let nest = store.create_project("yuzuno nest", BTreeMap::new()).unwrap();
    assert_eq!(nest.key.as_deref(), Some("YN2"), "a key taken gets the next free suffix");
    let chinese = store.create_project("研究项目", BTreeMap::new()).unwrap();
    assert_eq!(chinese.key.as_deref(), Some("P1"), "a name without an ASCII letter gets P<n>");
    assert_eq!(store.project(&next.id).unwrap().key.as_deref(), Some("YN"));
    let listed = call(&store, None, "projects_list", json!({}));
    assert_eq!(listed["projects"][0]["key"], "YN", "projects_list shows each key");

    // The user changes a key; the old one stays reserved for its Project.
    assert_eq!(store.update_project(&next.id, key_change("YUZ")).unwrap().key.as_deref(), Some("YUZ"));
    let taken = key_refused(&store, &nest.id, "YN");
    assert!(taken.contains("project_key_taken"), "an old key is never handed to another Project: {taken:?}");
    let current = key_refused(&store, &nest.id, "YUZ");
    assert!(current.contains("project_key_taken"), "nor a current one: {current:?}");
    for bad in ["T", "yn", "Y", "1YN", "ABCDEFGHIJK"] {
        let refused = key_refused(&store, &nest.id, bad);
        assert!(refused.contains("invalid_input"), "a key is an uppercase letter and 1-9 more: {bad:?}: {refused:?}");
    }
    // A Project takes back its own old key.
    assert_eq!(store.update_project(&next.id, key_change("YN")).unwrap().key.as_deref(), Some("YN"));
    assert_eq!(store.project(&next.id).unwrap().key.as_deref(), Some("YN"));
}

#[test]
fn tasks_in_a_project_count_from_one_and_tasks_outside_keep_the_global_number() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let next = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    let atlas = store.create_project("Atlas", BTreeMap::new()).unwrap();
    assert_eq!(create(&store, "loose", None), "T-1", "a task in no Project keeps T-<seq>");
    assert_eq!(create(&store, "n1", Some(&next.id)), "YN-1");
    assert_eq!(create(&store, "a1", Some(&atlas.id)), "ATL-1", "each Project counts on its own");
    assert_eq!(create(&store, "n2", Some(&next.id)), "YN-2");
    assert_eq!(create(&store, "loose2", None), "T-5", "the global number goes on for every task");
    // T-<seq> names every task, whatever key it shows.
    assert_eq!(shown(&store, "T-2"), "YN-1");
    assert_eq!(shown(&store, "T-3"), "ATL-1");
}

#[test]
fn a_moved_task_gets_a_new_key_and_every_old_one_still_names_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let next = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    let atlas = store.create_project("Atlas", BTreeMap::new()).unwrap();
    let task = create(&store, "loose", None);
    assert_eq!(task, "T-1");
    assert_eq!(moved(&store, "in", "T-1", Some(&next.id))["task"]["id"], "YN-1", "a task moved into a Project takes its next number");
    assert_eq!(moved(&store, "across", "YN-1", Some(&atlas.id))["task"]["id"], "ATL-1",
        "a task moved to another Project takes that Project's next number");
    assert_eq!(moved(&store, "out", "ATL-1", None)["task"]["id"], "T-1", "out of every Project it shows its global number again");
    for old in ["T-1", "YN-1", "ATL-1"] {
        assert_eq!(named(&store, old).as_deref(), Some("T-1"), "every key the task had still names it ({old})");
    }
    let keys = call(&store, None, "task_get", json!({"taskId":"YN-1","view":"current"}))["keys"].clone();
    assert_eq!(keys, json!({"global":"T-1","history":["YN-1","ATL-1"]}));
}

#[test]
fn a_projects_numbers_are_never_given_again() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let next = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    assert_eq!(create(&store, "n1", Some(&next.id)), "YN-1");
    assert_eq!(create(&store, "n2", Some(&next.id)), "YN-2");
    // The Project's highest number leaves with its task.
    moved(&store, "out", "YN-2", None);
    assert_eq!(create(&store, "n3", Some(&next.id)), "YN-3", "the number a task took with it is not reused");
    assert_eq!(moved(&store, "back", "T-2", Some(&next.id))["task"]["id"], "YN-4", "coming back is a new number");
    assert_eq!(named(&store, "YN-2").as_deref(), Some("YN-4"), "its old number still names it");
    assert_eq!(named(&store, "YN-1").as_deref(), Some("YN-1"));
}

#[test]
fn an_old_project_key_names_its_tasks_after_a_change_and_after_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let next = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    assert_eq!(create(&store, "n1", Some(&next.id)), "YN-1");
    store.update_project(&next.id, key_change("YUZ")).unwrap();
    assert_eq!(named(&store, "YN-1").as_deref(), Some("YUZ-1"), "the old prefix names the task, shown by its key now");
    assert_eq!(named(&store, "YUZ-1").as_deref(), Some("YUZ-1"));

    // A deleted Project's key stays reserved and keeps naming the tasks it had.
    let gone = store.create_project("Gone", BTreeMap::new()).unwrap();
    assert_eq!(create(&store, "g1", Some(&gone.id)), "GON-1");
    moved(&store, "out", "GON-1", None);
    store.delete_project(&gone.id).unwrap();
    assert_eq!(named(&store, "GON-1").as_deref(), Some("T-2"), "a deleted Project's key still names the tasks it had");
    let other = store.create_project("Other", BTreeMap::new()).unwrap();
    let taken = key_refused(&store, &other.id, "GON");
    assert!(taken.contains("project_key_taken"), "a deleted Project's key stays reserved: {taken:?}");
    let generated = store.create_project("Gone again", BTreeMap::new()).unwrap();
    assert_eq!(generated.key.as_deref(), Some("GA"));
    let similar = store.create_project("Gonzo", BTreeMap::new()).unwrap();
    assert_eq!(similar.key.as_deref(), Some("GON2"), "a generated key skips a deleted Project's key too");
}

#[test]
fn existing_tasks_keep_their_numbers_even_inside_a_project() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let next = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    // A task filed in the Project before keys came: a membership row and no number.
    let before = create(&store, "before", None);
    assert_eq!(before, "T-1");
    {
        let db = Connection::open(dir.path().join("workspace.sqlite")).unwrap();
        let id: String = db.query_row("SELECT id FROM collaboration_tasks WHERE seq=1", [], |r| r.get(0)).unwrap();
        db.execute("INSERT INTO project_tasks(task_id,project_id,assigned_at) VALUES(?1,?2,'2026-11-01T00:00:00Z')",
            [&id, &next.id]).unwrap();
    }
    assert_eq!(shown(&store, "T-1"), "T-1");
    let listed = call(&store, None, "task_list", json!({"projectId":next.id}));
    assert_eq!(listed["tasks"][0]["id"], "T-1");
    assert_eq!(moved(&store, "same", "T-1", Some(&next.id))["task"]["id"], "T-1",
        "setting the Project a task is in already changes nothing: an existing task keeps its number");
    // The Project's counter starts with its first new task.
    assert_eq!(create(&store, "first", Some(&next.id)), "YN-1");
}

#[test]
fn task_tools_take_every_form_and_answer_with_the_key_now() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let next = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    store.insert(&serde_json::from_value(json!({"agent": {
        "id":"dev", "name":"Dev", "cwd":"/workspace", "model":"", "color":"sage", "harness":"codex", "threadId":"s",
        "status":"idle", "closedAt":null, "createdAt":"", "updatedAt":"", "unreadCount":0,"pendingCount":0,"lastSeq":0,
        "reviewedSeq":0}, "turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    assert_eq!(create(&store, "n1", Some(&next.id)), "YN-1");
    store.update_project(&next.id, key_change("YUZ")).unwrap();
    for (n, form) in ["T-1", "YN-1", "YUZ-1"].iter().enumerate() {
        let got = store.collaboration_call(None, "task_get", json!({"taskId":form}));
        assert!(got.is_ok(), "task_get takes every key a task had: {form}: {got:?}");
        let got = got.unwrap();
        assert_eq!(got["task"]["id"], "YUZ-1", "{form}");
        let comment = call(&store, None, "task_comment", json!({"requestId":format!("c{n}"),"taskId":form,"body":"note"}));
        assert_eq!((comment["task"]["id"].as_str(), comment["activity"]["taskId"].as_str()), (Some("YUZ-1"), Some("YUZ-1")), "{form}");
        let version = got["task"]["version"].clone();
        let updated = call(&store, None, "task_update", json!({"requestId":format!("u{n}"),"taskId":form,
            "expectedVersion":version,"patch":{"progress":format!("step {n}")}}));
        assert_eq!(updated["task"]["id"], "YUZ-1", "{form}");
    }
    let version = call(&store, None, "task_get", json!({"taskId":"YN-1"}))["task"]["version"].clone();
    let dispatched = call(&store, None, "task_dispatch", json!({"requestId":"d","taskId":"YN-1","expectedVersion":version,
        "toAgentId":"dev"}));
    assert_eq!((dispatched["task"]["id"].as_str(), dispatched["message"]["taskId"].as_str()), (Some("YUZ-1"), Some("YUZ-1")));
    let listed = call(&store, None, "task_list", json!({"projectId":next.id}));
    assert_eq!(listed["tasks"][0]["id"], "YUZ-1");
    let mail = call(&store, Some("dev"), "peer_read", json!({"priority":"normal"}));
    assert!(mail["messages"].as_array().unwrap().iter().all(|m| m["taskId"] == "YUZ-1"), "{mail}");
    // A key names only its own canonical form.
    for bad in ["yuz-1", "Yuz-1", "YUZ-01", "YUZ-0"] {
        let refused = refused(&store, "task_get", json!({"taskId":bad}));
        assert!(refused.contains("invalid_input: use the canonical task ID"), "{bad}: {refused}");
    }
    for unknown in ["YUZ-2", "ZZ-1", "T-9"] {
        assert!(refused(&store, "task_get", json!({"taskId":unknown})).contains("task_not_found"), "{unknown}");
    }
}

#[test]
fn an_older_cores_writes_keep_every_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = open(&dir);
    let next = store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    assert_eq!(create(&store, "n1", Some(&next.id)), "YN-1");
    drop(store);
    // What an older Core does with the same database: it rewrites a Project's
    // data through its own record, creates Projects with only id and data, and
    // moves tasks through project_tasks alone.
    {
        let db = Connection::open(&path).unwrap();
        let data: String = db.query_row("SELECT data FROM projects WHERE id=?1", [&next.id], |r| r.get(0)).unwrap();
        // Its typed record has no key: what it writes back has none either.
        let mut renamed: Value = serde_json::from_str(&data).unwrap();
        renamed.as_object_mut().unwrap().remove("key");
        renamed["name"] = json!("Yuzuno Next");
        db.execute("UPDATE projects SET data=?1 WHERE id=?2", [&renamed.to_string(), &next.id]).unwrap();
        let older = json!({"id":"older","name":"Older","defaultDirs":{},"archivedAt":null,
            "createdAt":"2026-11-06T00:00:00Z","updatedAt":"2026-11-06T00:00:00Z"});
        db.execute("INSERT INTO projects(id,data) VALUES('older',?1)", [older.to_string()]).unwrap();
        db.execute("UPDATE project_tasks SET project_id='older' WHERE project_id=?1", [&next.id]).unwrap();
    }
    let store = open(&dir);
    assert_eq!(store.project(&next.id).unwrap().key.as_deref(), Some("YN"), "an older Core's rename keeps the key");
    assert_eq!(store.project("older").unwrap().key.as_deref(), Some("OLD"), "a Project an older Core made gets one on open");
    // The task an older Core moved shows its global number; its old key still names it.
    assert_eq!(named(&store, "YN-1").as_deref(), Some("T-1"), "a task an older Core moved shows T-<seq>, and its old key names it");
    assert_eq!(moved(&store, "here", "T-1", Some(&next.id))["task"]["id"], "YN-2");
}

#[test]
fn keys_filled_on_open_are_the_same_for_every_core_that_opens_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let store = open(&dir);
    for name in ["yuzuno-next", "yuzuno nest", "研究", "调研"] {
        store.create_project(name, BTreeMap::new()).unwrap();
    }
    drop(store);
    // As before keys came: no key on any Project.
    Connection::open(&path).unwrap().execute("UPDATE projects SET key=NULL", []).unwrap();
    let copy = dir.path().join("copy.sqlite");
    std::fs::copy(&path, &copy).unwrap();
    let keys = |store: &Store| store.projects().unwrap().into_iter().map(|p| p.key.unwrap()).collect::<Vec<_>>();
    let first = keys(&Store::open(&path).unwrap());
    assert_eq!(first, ["YN", "YN2", "P1", "P2"], "creation order, each against those filled before it");
    assert_eq!(keys(&Store::open(&copy).unwrap()), first);
    assert_eq!(keys(&Store::open(&path).unwrap()), first, "a second open changes nothing");
}

#[tokio::test]
async fn every_tool_takes_each_key_and_a_stored_reference_reads_as_the_key_now() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into_owned(), "unused-harness".into()).unwrap();
    let next = ws.store.create_project("yuzuno-next", BTreeMap::new()).unwrap();
    let created = ws.collaboration_call(None, "task_create", json!({"requestId":"n1","title":"n1","projectId":next.id})).await.unwrap();
    assert_eq!(created["task"]["id"], "YN-1");
    // A Job written while the task was YN-1 keeps that taskRef in its record.
    let path = dir.path().join("data/workspace.sqlite");
    {
        let db = Connection::open(&path).unwrap();
        let internal: String = db.query_row("SELECT id FROM collaboration_tasks WHERE seq=1", [], |r| r.get(0)).unwrap();
        let job = json!({"id":"job-1","taskId":internal,"taskRef":"YN-1","name":"synthetic","status":"succeeded",
            "agentId":"dev","createdAt":"2026-11-06T00:00:00Z"});
        db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('job-1',?1,'dev','succeeded',?2)",
            [&internal, &job.to_string()]).unwrap();
    }
    ws.store.update_project(&next.id, key_change("YUZ")).unwrap();
    let job = ws.collaboration_call(None, "job_get", json!({"jobId":"job-1"})).await.unwrap();
    assert_eq!(job["taskRef"], "YUZ-1", "the record says YN-1; a read says the key now");
    for form in ["T-1", "YN-1", "YUZ-1"] {
        let links = ws.collaboration_call(None, "github_links", json!({"taskId":form,"action":"list"})).await.unwrap();
        assert_eq!(links["links"], json!([]), "github_links {form}");
        let reviews = ws.collaboration_call(None, "review_list", json!({"taskId":form})).await.unwrap();
        assert_eq!(reviews["reviews"], json!([]), "review_list {form}");
        let cost = ws.collaboration_call(None, "job_cost", json!({"taskId":form})).await.unwrap();
        assert_eq!(cost["taskId"], "YUZ-1", "job_cost {form}");
        let jobs = ws.collaboration_call(None, "job_list", json!({"taskId":form})).await.unwrap();
        assert_eq!(jobs["jobs"][0]["taskRef"], "YUZ-1", "job_list {form}: {jobs}");
    }
    let stored: String = Connection::open(&path).unwrap()
        .query_row("SELECT json_extract(data,'$.taskRef') FROM local_jobs WHERE id='job-1'", [], |r| r.get(0)).unwrap();
    assert_eq!(stored, "YN-1", "the stored record is untouched");
}
