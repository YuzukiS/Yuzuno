use super::*;
use crate::model::AgentDetail;
use axum::http::StatusCode;
use tower::ServiceExt;

fn workspace() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    // No runtime runs: these Agents are Codex Agents that never started.
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(),
        dir.path().join("no-codex").to_string_lossy().into()).unwrap();
    (dir, ws)
}

fn agent(store: &Store, id: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
        "model":"","harness":"codex","color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
}

/// Executor `id`, dispatched from a template by `by` (as the receipts key
/// it) for the task `task-<id>`, waiting for its slot.
fn executor(store: &Store, id: &str, by: &str) {
    agent(store, id);
    let db = store.db.write().unwrap();
    db.execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at)
         VALUES(?1,'executor','reviewer',?2,?3,'dispatched','now','now')",
        params![id, format!("task-{id}"), by],
    ).unwrap();
    crate::executor_slots::enqueue(&db, id, &format!("task-{id}"), None, "local", "reviewer", false).unwrap();
}

fn slot(store: &Store, id: &str) -> String {
    store.db.read().unwrap()
        .query_row("SELECT state FROM executor_slots WHERE agent_id=?1", [id], |r| r.get(0)).unwrap()
}

/// Its role row's `archived_at`, `state` and `released_by`.
fn role(store: &Store, id: &str) -> (Option<String>, Option<String>, Option<String>) {
    store.db.read().unwrap()
        .query_row("SELECT archived_at,state,released_by FROM agent_roles WHERE agent_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
}

/// The data of each `agent/closed` row of its history.
fn closes(store: &Store, id: &str) -> Vec<Value> {
    let db = store.db.read().unwrap();
    let mut query = db.prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind='agent/closed' ORDER BY seq").unwrap();
    let rows = query.query_map([id], |r| r.get::<_, String>(0)).unwrap();
    rows.map(|raw| serde_json::from_str(&raw.unwrap()).unwrap()).collect()
}

fn closed(store: &Store, id: &str) -> bool {
    store.agent(id).unwrap().closed_at.is_some()
}

async fn release(ws: &Arc<Workspace>, actor: Option<&str>, id: &str) -> Result<Value> {
    ws.collaboration_call(actor, "executor_release", json!({"requestId":format!("release-{id}"),"agentId":id})).await
}

fn refused(answer: Result<Value>, code: &str) -> bool {
    answer.is_err_and(|e| e.to_string().starts_with(code))
}

/// T-34 S4: the Agent that dispatched an executor from a template, or the
/// user, releases it, and no one else; only an executor is released. A
/// release closes it, says so in its close's row with who made it, archives
/// it and frees its slot; a repeat answers with the same time.
#[tokio::test]
async fn the_dispatcher_or_the_user_releases_an_executor_and_no_one_else() {
    let (_dir, ws) = workspace();
    let store = &ws.store;
    for id in ["lead", "other", "standing", "chosen"] {
        agent(store, id);
    }
    // "chosen" leads a Project, as the user sets it.
    let project = store.create_project("Synthetic", [("local".to_owned(), "/synthetic/project".to_owned())].into()).unwrap().id;
    store.set_agent_project("chosen", Some(&project)).unwrap();
    crate::agent_roles::save(store, &project, 0, vec!["chosen".into()]).unwrap();
    executor(store, "e1", "agent:lead");
    executor(store, "e2", "agent:lead");

    assert!(refused(release(&ws, Some("other"), "e1").await, "not_dispatcher:"), "another Agent is refused");
    assert!(!closed(store, "e1") && role(store, "e1").0.is_none(), "and nothing changed");
    assert_eq!(slot(store, "e1"), "waiting");
    assert!(refused(release(&ws, Some("e2"), "e1").await, "not_dispatcher:"), "so is another executor");
    assert!(refused(release(&ws, None, "standing").await, "not_executor:"), "a standing Agent is not released");
    assert!(refused(release(&ws, None, "chosen").await, "not_executor:"), "nor is a lead");
    assert!(!closed(store, "standing") && !closed(store, "chosen"));
    assert!(refused(release(&ws, None, "missing").await, "agent_not_found:"));

    let answer = release(&ws, Some("lead"), "e1").await.unwrap();
    let agent = store.agent("e1").unwrap();
    assert!(agent.closed_at.is_some(), "a release closes the executor");
    assert_eq!(answer["releasedAt"], json!(agent.closed_at), "the answer names when, its close's time");
    assert_eq!(answer["releasedBy"], "agent:lead", "and who released it");
    assert_eq!(role(store, "e1"), (agent.closed_at.clone(), Some("released".into()), Some("agent:lead".into())),
        "its role row is archived, with who released it");
    assert_eq!(slot(store, "e1"), "released", "its slot is free");
    assert_eq!(closes(store, "e1"), [json!({"reason":"released","by":"agent:lead"})], "its close's row says it was a release, and who made it");
    assert_eq!(release(&ws, Some("lead"), "e1").await.unwrap(), answer, "a repeat answers with the same releasedAt");
    assert_eq!(release(&ws, None, "e1").await.unwrap(), answer, "a repeat by the user keeps the first release and who made it");
    assert_eq!(closes(store, "e1").len(), 1, "and closes nothing again");

    let by_user = release(&ws, None, "e2").await.unwrap();
    assert!(by_user["releasedAt"].is_string(), "the user releases any executor");
    assert_eq!(closes(store, "e2"), [json!({"reason":"released","by":"user"})]);
    assert_eq!((by_user["releasedBy"].clone(), role(store, "e2").2), (json!("user"), Some("user".into())), "the user, named on the executor");
    assert!(!closed(store, "lead") && !closed(store, "other"), "callers stay open");
}

/// T-34 S4: an executor closed before is archived in its own transaction,
/// without a second close; a plain close archives nothing and is reopened as
/// before, but a released executor never is, by any route. The user can
/// still delete it. While an update drains, a release is refused as Close is.
#[tokio::test]
async fn a_closed_executor_is_released_without_a_second_close_and_a_released_one_is_never_reopened() {
    let (_dir, ws) = workspace();
    let store = &ws.store;
    agent(store, "lead");
    executor(store, "e3", "agent:lead");
    executor(store, "e4", "agent:lead");
    ws.close_agent("e3").await.unwrap();
    ws.close_agent("e4").await.unwrap();
    assert_eq!(role(store, "e4").0, None, "a plain close archives nothing");
    assert_eq!(store.agent("e4").unwrap().released_at, None);
    ws.reopen_agent_summary("e4").await.unwrap();
    assert!(!closed(store, "e4"), "and a closed executor that was not released is reopened as before");

    let answer = release(&ws, Some("lead"), "e3").await.unwrap();
    assert!(answer["releasedAt"].is_string(), "a closed executor is released");
    assert_eq!(closes(store, "e3"), [json!({})], "without a second close");
    let (_, state, by) = role(store, "e3");
    assert_eq!((state.as_deref(), by.as_deref()), (Some("released"), Some("agent:lead")), "released by its dispatcher, named on the executor");
    assert_eq!(answer["releasedBy"], "agent:lead");
    assert_eq!(release(&ws, None, "e3").await.unwrap(), answer, "a repeat by the user keeps the first release and who made it");

    for reopened in [ws.reopen_agent("e3").await.map(drop), ws.reopen_agent_summary("e3").await.map(drop)] {
        assert_eq!(reopened.err().map(|e| e.to_string()).as_deref(), Some(REOPEN_REFUSED), "a released executor is not reopened");
    }
    assert!(closed(store, "e3"));

    ws.admission.begin_drain("t34-lab-update").unwrap();
    assert!(refused(release(&ws, Some("lead"), "e4").await, "workspace_updating:"), "refused while an update drains, as Close is");
    assert!(ws.close_agent("e4").await.is_err());
    ws.admission.reopen("t34-lab-update").unwrap();
    assert!(!closed(store, "e4") && role(store, "e4").0.is_none());

    ws.delete_agent("e3").await.unwrap();
    assert!(store.agent("e3").is_err(), "the user can still delete a released executor");
}

/// T-34 S4: the close, the archive and the slot commit together or not at
/// all. A close that fails archives nothing; an archive that fails leaves
/// the executor open, its slot held. Since T-36 S2 either keeps the release
/// archiving, the failure its reason, and a release asked again tries again.
#[tokio::test]
async fn a_release_commits_with_its_close_and_its_slot_or_not_at_all() {
    let (_dir, ws) = workspace();
    let store = &ws.store;
    agent(store, "lead");
    executor(store, "e5", "agent:lead");
    let fail = |sql: &str| store.db.write().unwrap().execute_batch(sql).unwrap();
    let archiving = |answer: Value, why: &str| {
        let reason = answer["archiving"]["reason"].as_str().unwrap_or_default().to_owned();
        assert!(answer["releasedAt"].is_null() && reason.contains(why), "archiving, saying why: {answer}");
    };

    fail("CREATE TRIGGER t34_no_close BEFORE INSERT ON journal WHEN NEW.kind='agent/closed'
          BEGIN SELECT RAISE(ABORT,'synthetic: the close fails'); END;");
    archiving(release(&ws, Some("lead"), "e5").await.unwrap(), "synthetic: the close fails");
    assert!(!closed(store, "e5"), "a failed close leaves it open");
    assert_eq!(role(store, "e5").0, None, "a failed close archives nothing");
    assert_eq!(slot(store, "e5"), "waiting");
    fail("DROP TRIGGER t34_no_close;");

    fail("CREATE TRIGGER t34_no_archive BEFORE UPDATE OF archived_at ON agent_roles
          BEGIN SELECT RAISE(ABORT,'synthetic: the archive fails'); END;");
    archiving(release(&ws, Some("lead"), "e5").await.unwrap(), "synthetic: the archive fails");
    assert!(!closed(store, "e5"), "a failed archive leaves the executor open");
    assert_eq!(slot(store, "e5"), "waiting", "its slot held");
    assert!(closes(store, "e5").is_empty(), "with no close in its history");
    fail("DROP TRIGGER t34_no_archive;");

    release(&ws, Some("lead"), "e5").await.unwrap();
    assert!(closed(store, "e5") && role(store, "e5").0.is_some() && slot(store, "e5") == "released");
}

/// T-34 S4: the user's route, as Agent management calls it; the Agent as
/// listed then names its release.
#[tokio::test]
async fn the_users_release_route_releases_and_the_agent_lists_when() {
    let (_dir, ws) = workspace();
    agent(&ws.store, "lead");
    executor(&ws.store, "e6", "agent:lead");
    let post = |path: String| axum::http::Request::builder().method("POST").uri(path).body(axum::body::Body::empty()).unwrap();
    let response = router().with_state(ws.clone()).oneshot(post("/api/agents/e6/release".into())).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    let listed = ws.store.agents().unwrap().into_iter().find(|a| a.id == "e6").unwrap();
    assert_eq!(json!(listed.released_at), body["releasedAt"], "the Agent list names the release");
    assert_eq!(body["buildCleanup"], json!({"enabled": false}), "the build output cleanup is off unless the user turns it on (YN-65)");
    assert_eq!(listed.released_by.as_deref(), Some("user"), "and who made it");
    let listed = serde_json::to_value(&listed).unwrap();
    assert_eq!((listed["releasedAt"].clone(), listed["releasedBy"].clone()), (body["releasedAt"].clone(), json!("user")));
    let lead = serde_json::to_value(ws.store.agents().unwrap().into_iter().find(|a| a.id == "lead").unwrap()).unwrap();
    assert!(lead.get("releasedAt").is_none() && lead.get("releasedBy").is_none(), "absent for every other Agent");
    let response = router().with_state(ws.clone()).oneshot(post("/api/agents/lead/release".into())).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST, "a standing Agent's release is refused");
}

/// T-34 S4: the column for who released an executor is added to an
/// `agent_roles` an older Core made, once; opening again changes nothing.
#[test]
fn an_older_agent_roles_table_gets_the_released_by_column_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let columns = |store: &Store| -> Vec<String> {
        let db = store.db.read().unwrap();
        let mut query = db.prepare("SELECT name FROM pragma_table_info('agent_roles') ORDER BY cid").unwrap();
        query.query_map([], |r| r.get(0)).unwrap().map(|c| c.unwrap()).collect()
    };
    assert_eq!(columns(&store).last().map(String::as_str), Some("released_by"), "a new Workspace has the column");
    store.db.write().unwrap().execute_batch("ALTER TABLE agent_roles DROP COLUMN released_by;").unwrap();
    assert!(!columns(&store).contains(&"released_by".to_owned()), "as an older Core made it");
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let after = columns(&store);
    assert_eq!(after.iter().filter(|c| *c == "released_by").count(), 1, "added on open");
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    assert_eq!(columns(&store), after, "and once: opening again changes nothing");
}
