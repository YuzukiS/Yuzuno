use super::*;
use crate::executor_lifecycle::tests::{role, task, task_is};

/// T-36 S3: Home's Needs you lists an executor the user dispatched whose
/// result waits for the user's release, or whose start failed. A lead's
/// executor in the same state never shows there: it is that lead's to follow.
#[tokio::test]
async fn needs_you_lists_the_executors_the_user_dispatched_and_never_a_leads() {
    let (_dir, ws, project) = lab();
    // b and c are executors here, so they don't lead the Project.
    set_leads(&ws, &project, &["a"]);
    let s = &ws.store;
    let (mine_public, mine) = task(s, "Mine to release");
    let (_, leads) = task(s, "The lead's to release");
    let (failed_public, failed) = task(s, "A start that failed");
    role(s, "b", &mine, "user", "d1", "running", None);
    task_is(s, &mine, "review", "", Some("d1"));
    role(s, "c", &leads, "agent:a", "d2", "running", None);
    task_is(s, &leads, "review", "", Some("d2"));
    role(s, "d", &failed, "user", "d3", "starting", Some("The runtime may still be running there: held for you"));
    let home = home::build(s).unwrap();
    let executors: Vec<_> = home["needsYou"].as_array().unwrap().iter().filter(|item| item["kind"] == "executor").collect();
    let shown: Vec<_> = executors.iter().map(|item| (item["agentId"].as_str().unwrap(), item["state"].as_str().unwrap())).collect();
    assert_eq!(shown, vec![("b", "delivering"), ("d", "failed")], "the user's two, its Project's first: {executors:?}");
    assert_eq!((executors[0]["taskId"].as_str(), executors[0]["title"].as_str()), (Some(mine_public.as_str()), Some("Mine to release")));
    assert_eq!(executors[1]["taskId"].as_str(), Some(failed_public.as_str()));
    assert_eq!(executors[1]["reason"], "The runtime may still be running there: held for you");
    // In the same build: the lead's executor, its result in too.
    let leads_shown = home["needsYou"].as_array().unwrap().iter().any(|item| item["agentId"] == "c");
    assert!(!leads_shown, "a lead's executor is never in Needs you");
}

/// T-36 S3 (Lead 2 mail 6191): the Chromium check's fixture
/// (web/tools/fixtures/executor-lifecycle.json) is Core's own answer, not a
/// hand-written one: the Agent listing's `executor`, the task list's
/// `task.executor` and Home's executor items for one Project whose executors
/// are in every state, read through the real callers. With
/// YUZUNO_LIFECYCLE_FIXTURE_OUT set, the answer is written there to be
/// copied verbatim; otherwise the kept copy must be exactly it.
#[tokio::test]
async fn the_web_checks_fixture_is_cores_own_answer() {
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    let s = &ws.store;
    const AT: &str = "2026-11-06T00:00:00Z";
    const CLOSED: &str = "2026-11-06T06:30:00Z";
    s.db.write().unwrap().execute("INSERT INTO projects(id,data) VALUES('p1',?1)",
        [json!({"id":"p1","name":"Yuzuno","defaultDirs":{},"archivedAt":null,"createdAt":AT,"updatedAt":AT}).to_string()]).unwrap();
    let member = |id: &str, name: &str| {
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":name,"cwd":"/synthetic/work","model":"test",
            "color":"sage","status":"idle","createdAt":AT,"updatedAt":AT,"unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        s.insert(&detail).unwrap();
        s.set_agent_project(id, Some("p1")).unwrap();
    };
    member("mori", "Mori");
    s.db.write().unwrap().execute("INSERT INTO agent_roles(agent_id,kind,project_id,created_by,created_at,updated_at)
        VALUES('mori','lead','p1','user',?1,?1)", [AT]).unwrap();
    member("hana", "Hana");
    let close = |id: &str| s.update(id, "test/closed", &json!({}), |d| d.agent.closed_at = Some(CLOSED.into())).unwrap();
    // Executor e50..e59, of tasks T-1..T-10, in each state.
    let executors = [
        ("e50", "Reviewer", "Review the release notes", "user", "released", "done"),
        ("e51", "Reviewer", "Review the parser change", "user", "starting", "doing"),
        ("e52", "Reviewer", "Review the import change", "user", "running", "review"),
        ("e53", "Builder", "Build the export", "agent:mori", "running", "doing"),
        ("e54", "Reviewer", "Review the docs change", "agent:mori", "running", "doing"),
        ("e55", "Builder", "Build the installer", "agent:mori", "waiting", "doing"),
        ("e56", "Reviewer", "Review the settings change", "user", "starting", "doing"),
        ("e57", "Builder", "Sign the release build", "user", "running", "blocked"),
        ("e58", "Reviewer", "Review the API change", "agent:mori", "running", "review"),
        ("e59", "Builder", "Draft the changelog", "user", "released", "doing"),
    ];
    for (id, label, title, by, slot, status) in executors {
        let (public, internal) = task(s, title);
        member(id, &format!("{public} · {label}"));
        let dispatch = format!("d{}", &id[1..]);
        let reason = (id == "e51").then_some("The runtime may still be running there: held for you");
        role(s, id, &internal, by, &dispatch, slot, reason);
        let blocker = if id == "e57" { "Waiting for the signing keys" } else { "" };
        task_is(s, &internal, status, blocker, (status == "review").then_some(dispatch.as_str()));
    }
    // e50 released for good; e54 being released while a Job runs; e59 closed by hand.
    s.db.write().unwrap().execute(
        "UPDATE agent_roles SET archived_at=?1,state='released',released_by='user' WHERE agent_id='e50'", [CLOSED]).unwrap();
    s.db.write().unwrap().execute("UPDATE agent_roles SET state='archiving' WHERE agent_id='e54'", []).unwrap();
    s.db.write().unwrap().execute("INSERT INTO executor_archiving(agent_id,released_by,since,reason,attempts,next_try_at)
        VALUES('e54','agent:mori','2026-11-06T06:35:00Z','Waiting to close: a Job is still running: cargo test (j1).',0,NULL)", []).unwrap();
    close("e50");
    close("e59");
    let agents: Vec<Value> = s.agents().unwrap().into_iter().map(|a| json!({"id":a.id,"name":a.name,"kind":a.kind,
        "closedAt":a.closed_at,"releasedAt":a.released_at,"releasedBy":a.released_by,"executor":a.executor})).collect();
    let listed = s.collaboration_call(None, "task_list", json!({})).unwrap();
    let tasks: Vec<Value> = listed["tasks"].as_array().unwrap().iter()
        .map(|t| json!({"id":t["id"],"title":t["title"],"status":t["status"],"executor":t["executor"]})).collect();
    let home = home::build(s).unwrap();
    let needs: Vec<Value> = home["needsYou"].as_array().unwrap().iter().filter(|i| i["kind"] == "executor").cloned().collect();
    let fixture = json!({"emittedBy":"core/src/project_brief/executor_needs_tests.rs the_web_checks_fixture_is_cores_own_answer",
        "agents":agents,"tasks":tasks,"needsYou":needs});
    let text = serde_json::to_string_pretty(&fixture).unwrap() + "\n";
    if let Ok(out) = std::env::var("YUZUNO_LIFECYCLE_FIXTURE_OUT") {
        std::fs::write(out, &text).unwrap();
        return;
    }
    let kept = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/tools/fixtures/executor-lifecycle.json");
    let kept = std::fs::read_to_string(kept).unwrap_or_else(|error| panic!("the web check's fixture is kept: {error}"));
    assert!(kept == text, "the web check's fixture is Core's own answer; emit it again with YUZUNO_LIFECYCLE_FIXTURE_OUT:\n{text}");
}
