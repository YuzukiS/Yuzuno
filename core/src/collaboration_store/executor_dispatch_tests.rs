use super::*;
use crate::{model::AgentDetail, workspace::Workspace};
use std::collections::BTreeMap;

fn agent_detail(id: &str, name: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":name,"cwd":"/synthetic/work","model":"","harness":"claude",
        "color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

fn agent(store: &Store, id: &str) {
    store.insert(&agent_detail(id, &format!("Agent {id}"))).unwrap();
}

/// The Workspace's templates, as a save leaves them.
fn templates(store: &Store, list: Value) {
    store.db.write().unwrap().execute(
        "INSERT INTO workspace_meta(key,value) VALUES('executors.templates',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [json!({"version":1,"templates":list}).to_string()]).unwrap();
}

fn reviewer() -> Value {
    json!({"id":"reviewer","label":"Reviewer","harness":"claude","instructions":"Review the change."})
}

fn project(store: &Store) -> String {
    store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into())])).unwrap().id
}

/// A task (its ID), in `project` if given, with a registered worktree if given.
fn task(store: &Store, title: &str, project: Option<&str>, worktree: Option<&str>) -> String {
    let mut input = json!({"requestId":format!("create {title}"),"title":title,"projectId":project});
    if let Some(worktree) = worktree {
        input["materials"] = json!({"worktree":worktree});
    }
    store.collaboration_call(None, "task_create", input).unwrap()["task"]["id"].as_str().unwrap().to_owned()
}

fn dispatch(task: &str, request: &str) -> Value {
    json!({"requestId":request,"taskId":task,"expectedVersion":1,"executor":{"templateId":"reviewer"}})
}

fn begun(store: &Store, actor: Option<&str>, input: Value) -> Result<Plan, String> {
    match store.executor_dispatch_begin(actor, input) {
        Ok(Next::Create(plan)) => Ok(*plan),
        Ok(Next::Dispatch(_)) => Err("went on to a dispatch".into()),
        Err(error) => Err(error.to_string()),
    }
}

/// The executor as the create path makes it: its record, with what the plan
/// writes in the same transaction.
fn create(store: &Store, plan: &Plan) {
    store.insert_created_then(&agent_detail(&plan.dispatch.agent_id, &plan.name), Some(plan.then())).unwrap();
}

fn row(store: &Store, actor: &str, request: &str) -> (String, Option<String>) {
    store.db.read().unwrap().query_row("SELECT state,error FROM executor_dispatches WHERE actor=?1 AND request_id=?2",
        params![actor, request], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
}

/// T-34: a template dispatch is a row of its own, keyed by its caller and
/// requestId, so a retry goes on where the first stopped and never creates a
/// second executor; once dispatched, a retry gets the first answer.
#[test]
fn a_retry_with_the_same_request_finds_its_dispatch_and_never_makes_a_second_agent() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer()]));
    let t = task(&store, "Review", Some(&p), None);
    let plan = begun(&store, None, dispatch(&t, "first")).unwrap();
    assert_eq!((plan.name.as_str(), plan.folders.as_slice()), ("T-1 · Reviewer", ["/synthetic/project".to_owned()].as_slice()));
    assert_eq!(row(&store, "user", "first").0, "pending");
    let busy = store.executor_dispatch_begin(None, dispatch(&t, "first"));
    assert!(matches!(&busy, Err(e) if e.to_string().starts_with("dispatch_in_progress:")),
        "a retry while the first creates its executor waits for it: only one Agent");

    create(&store, &plan);
    assert_eq!(row(&store, "user", "first").0, "created");
    let executor = plan.dispatch.agent_id.clone();
    let answer = store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
    assert_eq!((answer["agentId"].as_str(), answer["task"]["assigneeAgentId"].as_str()), (Some(executor.as_str()), Some(executor.as_str())));
    assert_eq!(row(&store, "user", "first").0, "dispatched", "the task and its row are dispatched together");
    let given = store.collaboration_call(None, "task_get", json!({"taskId":t,"dispatchId":answer["task"]["dispatch"]["id"]})).unwrap();
    assert_eq!(given["dispatchMaterials"]["template"], json!({"id":"reviewer","label":"Reviewer","source":"workspace","instructions":"Review the change."}),
        "the template and its instructions reach the executor with its materials");
    for _ in 0..2 {
        let again = store.executor_dispatch_begin(None, dispatch(&t, "first"));
        let Ok(Next::Dispatch(again)) = again else {
            panic!("a retry with the same requestId finds the first dispatch: only one Agent");
        };
        assert_eq!(again.agent_id, executor, "a retry with the same requestId finds the first dispatch: only one Agent");
        assert_eq!(store.collaboration_call(None, "task_dispatch", again.input).unwrap(), answer, "a retry gets the first answer");
    }
    assert_eq!(store.agents().unwrap().len(), 1, "only one Agent");

    // The executor: its kind, Project, template, task and dispatch, and who made it.
    let role: (String, String, String, String, String, String) = store.db.read().unwrap().query_row(
        "SELECT kind,project_id,template_id,task_id,created_by,dispatch_id FROM agent_roles WHERE agent_id=?1", [&executor],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).unwrap();
    let task_uuid = crate::collaboration_store::task_key(&store.db.read().unwrap(), &t).unwrap().0;
    assert_eq!(role, ("executor".into(), p.clone(), "reviewer".into(), task_uuid, "user".into(), answer["task"]["dispatch"]["id"].as_str().unwrap().into()));

    let mut other = dispatch(&t, "first");
    other["body"] = json!("Another payload");
    assert!(begun(&store, None, other).unwrap_err().starts_with("idempotency_conflict:"));
    // An ordinary dispatch's requestId is not taken again by a template one,
    // and an ordinary one cannot name an executor Core did not make.
    agent(&store, "standing");
    let plain = json!({"requestId":"plain","taskId":t,"expectedVersion":2,"toAgentId":"standing"});
    store.collaboration_call(None, "task_dispatch", plain).unwrap();
    assert!(begun(&store, None, dispatch(&t, "plain")).unwrap_err().starts_with("idempotency_conflict:"));
    let forged = json!({"requestId":"forged","taskId":t,"expectedVersion":3,"toAgentId":"standing","executor":{"templateId":"reviewer"}});
    let forged = store.collaboration_call(None, "task_dispatch", forged).unwrap_err().to_string();
    assert!(forged.contains("whose Agent Core makes"), "{forged}");
}

/// T-34: a dispatch that fails is `failed` with its error, which a retry
/// gets again; the executor it made is named once, to be closed.
#[test]
fn a_failed_dispatch_fails_again_on_retry_and_names_its_executor_to_close() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer()]));
    let t = task(&store, "Review", Some(&p), None);
    let plan = begun(&store, None, dispatch(&t, "first")).unwrap();
    create(&store, &plan);
    let made = store.executor_dispatch_failed("user", "first", "invalid_input: the store refused it").unwrap();
    assert_eq!(made.as_deref(), Some(plan.dispatch.agent_id.as_str()), "the executor it made is named, to close");
    assert_eq!(row(&store, "user", "first"), ("failed".into(), Some("invalid_input: the store refused it".into())));
    assert_eq!(begun(&store, None, dispatch(&t, "first")).unwrap_err(), "invalid_input: the store refused it");
    assert_eq!(store.executor_dispatch_failed("user", "first", "again").unwrap(), None);
    assert!(store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).is_err(), "a failed dispatch is not dispatched later");
    // One that fails before its executor exists names none.
    let plan = begun(&store, None, dispatch(&t, "second")).unwrap();
    assert_eq!(store.executor_dispatch_failed("user", "second", "the create was refused").unwrap(), None);
    assert!(store.agent(&plan.dispatch.agent_id).is_err());
}

/// T-34 (Lead 4849): a Core that stopped mid-dispatch fails it at the next
/// start, before any runtime starts, and closes the executor it made.
#[tokio::test]
async fn a_core_restarted_mid_dispatch_fails_it_and_closes_the_executor_it_made() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let (made, pending) = {
        let store = Store::open(&data.join("workspace.sqlite")).unwrap();
        let p = project(&store);
        templates(&store, json!([reviewer()]));
        let t = task(&store, "Review", Some(&p), None);
        let made = begun(&store, None, dispatch(&t, "created")).unwrap();
        create(&store, &made);
        let pending = begun(&store, None, dispatch(&t, "pending")).unwrap();
        (made.dispatch.agent_id, pending.dispatch.agent_id)
    };
    let ws = Workspace::new(data, dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let closed = ws.store.agent(&made).unwrap().closed_at;
    assert!(closed.is_some(), "a Core restarted mid-dispatch closes the executor it made");
    assert!(ws.store.agent(&pending).is_err());
    for request in ["created", "pending"] {
        let (state, error) = row(&ws.store, "user", request);
        assert_eq!(state, "failed", "{request}");
        assert!(error.unwrap().starts_with("core_restarted:"), "{request}");
    }
    let t = ws.store.collaboration_call(None, "task_list", json!({})).unwrap()["tasks"][0]["id"].as_str().unwrap().to_owned();
    assert!(begun(&ws.store, None, dispatch(&t, "created")).unwrap_err().starts_with("core_restarted:"), "a retry gets that failure");
    assert_eq!(ws.store.collaboration_call(None, "task_get", json!({"taskId":t})).unwrap()["task"]["status"], "todo", "nothing was dispatched");
}

/// T-34: the user dispatches from a template, or an Agent that leads the
/// task's Project; a task in no Project, the user only.
#[test]
fn only_a_lead_of_the_tasks_project_or_the_user_dispatches_from_a_template() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["lead", "member"] {
        agent(&store, id);
    }
    let p = project(&store);
    for id in ["lead", "member"] {
        store.set_agent_project(id, Some(&p)).unwrap();
    }
    crate::agent_roles::save(&store, &p, 0, vec!["lead".into()]).unwrap();
    templates(&store, json!([reviewer()]));
    let t = task(&store, "In the Project", Some(&p), None);
    let loose = task(&store, "In no Project", None, Some("/synthetic/worktree"));
    let refused = begun(&store, Some("member"), dispatch(&t, "member")).err().unwrap_or_else(|| "accepted".into());
    assert!(refused.starts_with("not_lead:"), "a non-lead is refused: {refused}");
    let refused = begun(&store, Some("lead"), dispatch(&loose, "lead loose")).unwrap_err();
    assert!(refused.starts_with("not_lead: this task is in no Project"), "{refused}");
    let lead = begun(&store, Some("lead"), dispatch(&t, "lead")).unwrap();
    assert_eq!(lead.dispatch.actor, "agent:lead");
    let user = begun(&store, None, dispatch(&loose, "user loose")).unwrap();
    assert_eq!(user.folders, ["/synthetic/worktree"], "a task in no Project works in its worktree");
    assert_eq!(user.project_id, None);
}

/// T-34: what a template dispatch is checked for before anything is written.
#[test]
fn a_template_dispatch_is_refused_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    let empty = store.create_project("No folder", BTreeMap::new()).unwrap().id;
    templates(&store, json!([reviewer(), {"id":"opencode","label":"OpenCode","harness":"opencode"}]));
    let t = task(&store, "Review", Some(&p), Some("/synthetic/worktree"));
    let homeless = task(&store, "No folder", Some(&empty), None);
    let archived = task(&store, "Archived", Some(&p), None);
    store.collaboration_call(None, "task_update", json!({"requestId":"archive","taskId":archived,"expectedVersion":1,"patch":{"archived":true}})).unwrap();
    let with = |change: Value| {
        let mut input = dispatch(&t, "refused");
        for (key, value) in change.as_object().unwrap() {
            input[key] = value.clone();
        }
        input
    };
    for (input, says) in [
        (with(json!({"executor":{"templateId":"missing"}})), "template_not_found:"),
        (with(json!({"executor":{"templateId":"reviewer","machineId":"laptop"}})), "Executors run on this Core host in this phase, not on laptop"),
        (with(json!({"executor":{"templateId":"reviewer","cwd":"/elsewhere"}})), "invalid_input: unknown field cwd"),
        (with(json!({"executor":"reviewer"})), "invalid_input: executor is"),
        (with(json!({"expectedVersion":7})), "version_conflict:"),
        (with(json!({"executor":{"templateId":"opencode"}})), "OpenCode Agents aren't enabled on this Core"),
        (json!({"requestId":"refused","taskId":archived,"expectedVersion":2,"executor":{"templateId":"reviewer"}}), "task_archived:"),
        (dispatch(&homeless, "refused"), "no_folder:"),
    ] {
        let got = begun(&store, None, input.clone()).err().unwrap_or_else(|| "accepted".into());
        assert!(got.starts_with(says) || got.contains(says), "{input} should be refused with {says}; got: {got}");
    }
    let written: i64 = store.db.read().unwrap().query_row("SELECT COUNT(*) FROM executor_dispatches", [], |r| r.get(0)).unwrap();
    assert_eq!(written, 0, "nothing was written");
    // Its worktree comes before its Project's folder; given materials before both.
    assert_eq!(begun(&store, None, dispatch(&t, "worktree")).unwrap().folders, ["/synthetic/worktree", "/synthetic/project"]);
    let given = with(json!({"requestId":"given","materials":{"worktree":"/synthetic/given"}}));
    assert_eq!(begun(&store, None, given).unwrap().folders, ["/synthetic/given", "/synthetic/project"]);
    let cleared = with(json!({"requestId":"cleared","materials":null}));
    assert_eq!(begun(&store, None, cleared).unwrap().folders, ["/synthetic/project"]);
}

/// T-34 (R3 d51396b7): an executor is created under the work permit its
/// dispatch holds. An update that starts draining meanwhile refuses an
/// ordinary create, but not this one, so the dispatch is not failed by it.
#[tokio::test]
async fn an_executor_is_created_under_its_dispatchs_permit_while_an_update_drains() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let ws = Workspace::new(dir.path().join("data"), cwd.clone(), "unused".into()).unwrap();
    let held = ws.admission.enter_work().unwrap();
    ws.admission.begin_drain("t34-lab-update").unwrap();
    let ordinary = ws.claude_create_on_with("Standing".into(), String::new(), cwd.clone(), String::new(), None, None, Default::default(), None).await;
    assert!(ordinary.is_err_and(|e| e.to_string().starts_with("workspace_updating:")), "an ordinary create is refused while an update drains");
    let birth = crate::workspace::Birth { id: "executor-1".into(), then: Box::new(|_| Ok(())) };
    let born = ws.claude_create_on_with("T-1 · Reviewer".into(), String::new(), cwd.clone(), String::new(), None, None, Default::default(), Some(birth)).await;
    assert!(born.is_ok(), "an executor is created under its dispatch's permit while an update drains: {:?}", born.err());
    let birth = crate::workspace::Birth { id: "executor-2".into(), then: Box::new(|_| Ok(())) };
    let codex = ws.create_on_with("T-2 · Builder".into(), String::new(), cwd, String::new(), None, None, Default::default(), Some(birth)).await;
    assert!(codex.is_ok(), "a Codex executor too: {:?}", codex.err());
    drop(held);
}

/// T-34 (R6 3458f905): a path in a dispatch's materials is information,
/// never permission. A lead's executor works in the task's registered
/// worktree or inside its Project's folder; any other folder is refused,
/// a sibling sharing the folder's name prefix too. The user's is not.
#[test]
fn an_agents_executor_works_only_in_the_tasks_worktree_or_its_projects_folder() {
    let dir = tempfile::tempdir().unwrap();
    let real = |name: &str| {
        let path = dir.path().join(name);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::canonicalize(path).unwrap().to_string_lossy().into_owned()
    };
    let (home, inside, sibling, elsewhere, registered) = (real("project"), real("project/sub"), real("project-other"), real("elsewhere"), real("registered"));
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    agent(&store, "lead");
    let p = store.create_project("Lab", BTreeMap::from([("local".into(), home.clone())])).unwrap().id;
    store.set_agent_project("lead", Some(&p)).unwrap();
    crate::agent_roles::save(&store, &p, 0, vec!["lead".into()]).unwrap();
    templates(&store, json!([reviewer()]));
    let t = task(&store, "Review", Some(&p), Some(registered.as_str()));
    let with = |request: &str, folder: &str| {
        let mut input = dispatch(&t, request);
        input["materials"] = json!({"worktree":folder});
        input
    };
    // A folder made only after the check, or a link inside the Project to
    // elsewhere, would let the executor work outside (#600 R1 a0e42a9f).
    let later = format!("{home}/later");
    let link = format!("{home}/link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
    let mut outside = vec![("elsewhere", &elsewhere), ("sibling", &sibling), ("not yet", &later)];
    if cfg!(unix) {
        outside.push(("symlink", &link));
    }
    for (request, folder) in outside {
        let refused = begun(&store, Some("lead"), with(request, folder)).err().unwrap_or_else(|| "accepted".into());
        assert!(refused.starts_with("folder_not_allowed:"),
            "an Agent cannot point its executor outside the task's worktree and its Project's folder ({request}): {refused}");
    }
    let inner = begun(&store, Some("lead"), with("inside", &inside)).unwrap();
    assert_eq!(inner.folders[0], inside, "inside the Project's folder");
    let dotted = begun(&store, Some("lead"), with("dotted", &format!("{inside}/../sub"))).unwrap();
    assert_eq!(dotted.folders[0], inside, "the executor works in the folder that was checked");
    let own = begun(&store, Some("lead"), dispatch(&t, "registered")).unwrap();
    assert_eq!(own.folders[0], registered, "the task's registered worktree");
    let user = begun(&store, None, with("user", &elsewhere)).unwrap();
    assert_eq!(user.folders[0], elsewhere, "the user's executor may work anywhere");
}
