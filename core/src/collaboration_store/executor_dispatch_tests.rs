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
    match store.executor_dispatch_begin(actor, input, LocalDefault::Read(None)) {
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

/// YN-2 S4: an executor a dispatch creates in the task's Project never leads
/// it, though an Agent the user creates there does.
#[test]
fn an_executor_a_dispatch_creates_never_leads_its_project() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer()]));
    let t = task(&store, "Review", Some(&p), None);
    let plan = begun(&store, None, dispatch(&t, "first")).unwrap();
    let mut detail = agent_detail(&plan.dispatch.agent_id, &plan.name);
    detail.agent.project_id = Some(p.clone());
    store.insert_created_then(&detail, Some(plan.then())).unwrap();
    let db = store.db.read().unwrap();
    let id = plan.dispatch.agent_id.as_str();
    assert_eq!(crate::projects::agent_project(&db, id).unwrap().as_deref(), Some(p.as_str()), "a member of the task's Project");
    assert_eq!(crate::agent_roles::kind(&db, id).unwrap(), crate::agent_roles::EXECUTOR);
    assert!(!crate::agent_roles::leads(&db, id, &p).unwrap(), "an executor never leads its Project");
    assert!(crate::agent_roles::leads_in(&db, &p).unwrap().lead_agent_ids.is_empty());
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
    assert_eq!((plan.name.as_str(), plan.folders.as_slice()), ("LAB-1 · Reviewer", ["/synthetic/project".to_owned()].as_slice()));
    assert_eq!(row(&store, "user", "first").0, "pending");
    let busy = store.executor_dispatch_begin(None, dispatch(&t, "first"), LocalDefault::Read(None));
    assert!(matches!(&busy, Err(e) if e.to_string().starts_with("dispatch_in_progress:")),
        "a retry while the first creates its executor waits for it: only one Agent");

    create(&store, &plan);
    assert_eq!(row(&store, "user", "first").0, "created");
    let executor = plan.dispatch.agent_id.clone();
    let answer = store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
    assert_eq!((answer["agentId"].as_str(), answer["task"]["assigneeAgentId"].as_str()), (Some(executor.as_str()), Some(executor.as_str())));
    assert_eq!(row(&store, "user", "first").0, "dispatched", "the task and its row are dispatched together");
    let given = store.collaboration_call(None, "task_get", json!({"taskId":t,"dispatchId":answer["task"]["dispatch"]["id"]})).unwrap();
    // A template that says no delivery or steps is delivered as before, by
    // pull request, with that mode's steps (YN-23).
    let pr_steps = json!([{"kind":"materials"},{"kind":"work"},{"kind":"job"},{"kind":"pr"},{"kind":"review"},{"kind":"ci"},{"kind":"merge"}]);
    assert_eq!(given["dispatchMaterials"]["template"], json!({"id":"reviewer","label":"Reviewer","source":"workspace","instructions":"Review the change.",
        "deliveryMode":"pr","steps":pr_steps}),
        "the template and its instructions reach the executor with its materials");
    let body = answer["message"]["body"].as_str().unwrap();
    assert!(body.contains("\nDelivery: pr: deliver the work as a pull request\n")
        && body.contains("\nSteps (descriptive: Core does not track them): materials → work → job → pr → review → ci → merge\n"),
        "the mail says how the work is delivered and its steps: {body}");
    for _ in 0..2 {
        let again = store.executor_dispatch_begin(None, dispatch(&t, "first"), LocalDefault::Read(None));
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

/// T-35: a dispatched executor waits for its slot, from the transaction
/// that dispatches its task; the task shows it, with its place in the queue,
/// in its current and full views and in the task list.
#[test]
fn a_dispatched_executor_waits_for_its_slot_and_its_task_shows_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer()]));
    let t = task(&store, "Review", Some(&p), None);
    let plan = begun(&store, None, dispatch(&t, "first")).unwrap();
    create(&store, &plan);
    let slots = |store: &Store| -> i64 {
        store.db.read().unwrap().query_row("SELECT COUNT(*) FROM executor_slots", [], |r| r.get(0)).unwrap()
    };
    assert_eq!(slots(&store), 0, "created, not yet dispatched: no slot");
    store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
    let executor = plan.dispatch.agent_id.clone();
    let waiting = json!({"agentId":executor,"state":"waiting","machine":"local","position":1,
        "waitsFor":{"machine":"local","name":"this Core host","running":0,"limit":3}});
    let current = store.collaboration_call(None, "task_get", json!({"taskId":t,"view":"current"})).unwrap();
    assert_eq!(current["current"]["executorSlot"], waiting, "the task's current view shows its executor's slot");
    let full = store.collaboration_call(None, "task_get", json!({"taskId":t,"view":"full"})).unwrap();
    assert_eq!(full["task"]["executorSlot"], waiting);
    let listed = store.collaboration_call(None, "task_list", json!({})).unwrap();
    assert_eq!(listed["tasks"][0]["executorSlot"], waiting);
    store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
    assert_eq!(slots(&store), 1, "a replay queues it once");

    assert_eq!(store.executor_slot_next(&Default::default()).unwrap().as_deref(), Some(executor.as_str()));
    let current = store.collaboration_call(None, "task_get", json!({"taskId":t,"view":"current"})).unwrap();
    assert_eq!(current["current"]["executorSlot"], json!({"agentId":executor,"state":"starting","machine":"local"}));
    // A task without an executor has none; nor a compact row.
    let other = task(&store, "Plain", Some(&p), None);
    let current = store.collaboration_call(None, "task_get", json!({"taskId":other,"view":"current"})).unwrap();
    assert_eq!(current["current"].get("executorSlot"), None);
    let compact = store.collaboration_call(None, "task_list", json!({"compact":true})).unwrap();
    assert!(compact["tasks"].as_array().unwrap().iter().all(|row| row.get("executorSlot").is_none()));
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
    // An OpenCode template is no longer refused here: OpenCode Agents are on
    // unless Core was started with them off (YN-27; executor_templates_tests).
    templates(&store, json!([reviewer()]));
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
        (with(json!({"executor":{"templateId":"reviewer","machineId":"laptop"}})), "machine_not_found: no registered machine is laptop"),
        (with(json!({"executor":{"templateId":"reviewer","cwd":"/elsewhere"}})), "invalid_input: unknown field cwd"),
        (with(json!({"executor":"reviewer"})), "invalid_input: executor is"),
        (with(json!({"expectedVersion":7})), "version_conflict:"),
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

/// A registered machine, as the Machines list keeps it.
fn machine(store: &Store, id: &str, name: &str, contained: bool) {
    store.add_machine(&crate::remote::RemoteMachine {
        id: id.into(), name: name.into(), target: "tester@192.0.2.10".into(), contained, ..Default::default()
    }).unwrap();
}

/// T-35 S3b (Lead 2 Q2, mail 5898): `auto`, from the dispatch or its
/// template, is chosen at dispatch time and kept on the dispatch with the
/// numbers it was chosen by; the request and the template keep `auto`, and
/// the task's card has the choice. A worktree, a path on this Core host,
/// chooses this Core host.
#[test]
fn auto_chooses_a_machine_at_dispatch_and_keeps_why() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    store.add_machine(&crate::remote::RemoteMachine {
        id: "lab-box".into(), name: "Lab box".into(), target: "tester@192.0.2.10".into(),
        budget: Some(crate::remote::MachineBudget { cpu_millis: 4000, memory_mib: 16384 }), ..Default::default()
    }).unwrap();
    store.db.write().unwrap().execute("INSERT INTO local_job_settings(id,data) VALUES(1,?1)",
        [json!({"cpuMillis":2000,"memoryMiB":4096,"swapMiB":0}).to_string()]).unwrap();
    let p = store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into()),
        ("lab-box".into(), "/srv/lab/project".into())])).unwrap().id;
    templates(&store, json!([reviewer(), {"id":"chooser","label":"Chooser","harness":"claude","machineId":"auto"}]));
    let t = task(&store, "Review", Some(&p), None);
    let with = |request: &str, executor: Value| json!({"requestId":request,"taskId":t,"expectedVersion":1,"executor":executor});
    let choice_of = |request: &str| -> (String, Value, Value) {
        let (machine, choice, input): (String, String, String) = store.db.read().unwrap().query_row(
            "SELECT machine_id, choice_json, input_json FROM executor_dispatches WHERE request_id=?1", [request],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        (machine, serde_json::from_str(&choice).unwrap(), serde_json::from_str(&input).unwrap())
    };

    let asked = begun(&store, None, with("asked", json!({"templateId":"reviewer","machineId":"auto"}))).unwrap();
    assert_eq!((asked.machine.as_str(), asked.folders.as_slice()), ("lab-box", ["/srv/lab/project".to_owned()].as_slice()),
        "the more spare memory, in the Project's folder there");
    let (machine, choice, input) = choice_of("asked");
    assert_eq!(machine, "lab-box", "the dispatch records the machine chosen");
    assert_eq!((choice["requested"].as_str(), choice["chosen"].as_str()), (Some("auto"), Some("lab-box")), "{choice}");
    assert_eq!(choice["candidates"][1]["machine"], "local", "{choice}");
    assert_eq!(input["executor"]["machineId"], "auto", "the request keeps auto");

    let template = begun(&store, None, with("template", json!({"templateId":"chooser"}))).unwrap();
    assert_eq!(template.machine, "lab-box", "the template's auto");
    begun(&store, None, with("named", json!({"templateId":"chooser","machineId":"local"}))).unwrap();
    let unchosen = store.db.read().unwrap().query_row(
        "SELECT choice_json IS NULL FROM executor_dispatches WHERE request_id='named'", [], |r| r.get::<_, bool>(0)).unwrap();
    assert!(unchosen, "a machine the dispatch names is no choice");

    let carried = task(&store, "With a worktree", Some(&p), Some("/synthetic/worktree"));
    let worktree = begun(&store, None, json!({"requestId":"carried","taskId":carried,"expectedVersion":1,
        "executor":{"templateId":"reviewer","machineId":"auto"}})).unwrap();
    assert_eq!(worktree.machine, "local", "a worktree is a path on this Core host");

    create(&store, &asked);
    store.collaboration_call(None, "task_dispatch", asked.dispatch.input.clone()).unwrap();
    let current = store.collaboration_call(None, "task_get", json!({"taskId":t,"view":"current"})).unwrap();
    let slot = &current["current"]["executorSlot"];
    assert_eq!((slot["machine"].as_str(), slot["choice"]["chosen"].as_str()), (Some("lab-box"), Some("lab-box")),
        "the task's card has the choice: {slot}");
}

/// T-35 S3a (D8, Lead 2 Q1/Q3): an executor runs on the dispatch's machine,
/// else its template's, else this Core host; on another machine it works in
/// its Project's folder there. What can't run there is refused before
/// anything is written: no such machine, no Project folder on it, a worktree
/// (a path on this Core host), a Codex executor on a contained machine.
#[test]
fn a_dispatch_runs_on_its_machine_in_its_projects_folder_there() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    machine(&store, "lab-box", "Lab box", false);
    machine(&store, "boxed", "Boxed", true);
    let p = store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into()),
        ("lab-box".into(), "/srv/lab/project".into()), ("boxed".into(), "/srv/boxed/project".into())])).unwrap().id;
    templates(&store, json!([reviewer(), {"id":"remote","label":"Remote","harness":"claude","machineId":"lab-box"},
        {"id":"coder","label":"Coder","harness":"codex"}]));
    let t = task(&store, "Review", Some(&p), None);
    let with = |request: &str, executor: Value| json!({"requestId":request,"taskId":t,"expectedVersion":1,"executor":executor});

    let here = begun(&store, None, with("here", json!({"templateId":"reviewer"}))).unwrap();
    assert_eq!((here.machine.as_str(), here.folders.as_slice()), ("local", ["/synthetic/project".to_owned()].as_slice()), "unset: this Core host");
    let named = begun(&store, None, with("named", json!({"templateId":"reviewer","machineId":"lab-box"}))).unwrap();
    assert_eq!((named.machine.as_str(), named.folders.as_slice()), ("lab-box", ["/srv/lab/project".to_owned()].as_slice()),
        "the dispatch's machine, in the Project's folder there");
    let template = begun(&store, None, with("template", json!({"templateId":"remote"}))).unwrap();
    assert_eq!(template.machine, "lab-box", "the template's machine when the dispatch names none");
    let over = begun(&store, None, with("over", json!({"templateId":"remote","machineId":"local"}))).unwrap();
    assert_eq!(over.machine, "local", "the dispatch's machine wins");
    let recorded: String = store.db.read().unwrap().query_row(
        "SELECT machine_id FROM executor_dispatches WHERE request_id='named'", [], |r| r.get(0)).unwrap();
    assert_eq!(recorded, "lab-box", "the dispatch records its machine");

    let elsewhere = store.create_project("Here only", BTreeMap::from([("local".into(), "/synthetic/here".into())])).unwrap().id;
    let local_only = task(&store, "Here only", Some(&elsewhere), None);
    let registered = task(&store, "With a worktree", Some(&p), Some("/synthetic/worktree"));
    for (input, says) in [
        (with("unknown", json!({"templateId":"reviewer","machineId":"laptop"})), "machine_not_found: no registered machine is laptop".to_owned()),
        (json!({"requestId":"no-folder","taskId":local_only,"expectedVersion":1,"executor":{"templateId":"reviewer","machineId":"lab-box"}}),
            "no_folder: an executor on Lab box works in its Project's folder there, and the Project has none on Lab box".to_owned()),
        (json!({"requestId":"worktree","taskId":registered,"expectedVersion":1,"executor":{"templateId":"reviewer","machineId":"lab-box"}}),
            "folder_not_allowed: an executor on Lab box works in its Project's folder there, and the worktree /synthetic/worktree is a path on this Core host".to_owned()),
        (json!({"requestId":"given","taskId":t,"expectedVersion":1,"executor":{"templateId":"reviewer","machineId":"lab-box"},
            "materials":{"worktree":"/synthetic/given"}}),
            "folder_not_allowed: an executor on Lab box works in its Project's folder there, and the worktree /synthetic/given is a path on this Core host".to_owned()),
        (with("contained", json!({"templateId":"coder","machineId":"boxed"})), "machine_contained: Boxed keeps its Agents contained".to_owned()),
    ] {
        let got = begun(&store, None, input.clone()).err().unwrap_or_else(|| "accepted".into());
        assert!(got.starts_with(&says), "{input} should be refused with {says}; got: {got}");
    }
    let refused: i64 = store.db.read().unwrap().query_row(
        "SELECT COUNT(*) FROM executor_dispatches WHERE request_id IN ('unknown','no-folder','worktree','given','contained')", [], |r| r.get(0)).unwrap();
    assert_eq!(refused, 0, "nothing was written for a refused one");

    // YN-37: an unknown machine's refusal names where this executor could
    // run instead, by id and name only; a Codex one, not where Agents are contained.
    let unknown = begun(&store, None, with("unknown", json!({"templateId":"reviewer","machineId":"laptop"}))).err().unwrap();
    assert_eq!(unknown, "machine_not_found: no registered machine is laptop; this executor can run on \
        local (this Core host), lab-box (Lab box), boxed (Boxed). machines_list lists them");
    let codex = begun(&store, None, with("unknown-codex", json!({"templateId":"coder","machineId":"laptop"}))).err().unwrap();
    assert!(codex.contains("this executor can run on local (this Core host), lab-box (Lab box). machines_list"), "{codex}");
    assert!(!unknown.contains("192.0.2.10") && !codex.contains("tester@"), "no connection detail: {unknown} / {codex}");
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
/// never permission. A lead's executor works in the worktree the user
/// registered on its task or inside its Project's folder; any other folder is
/// refused, a sibling sharing the folder's name prefix too, and a worktree an
/// Agent registered on the task (#600 R2 3a54ae81). The user's is not.
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
    // Registered by an Agent, the same path is still only information.
    store.collaboration_call(Some("lead"), "task_update", json!({"requestId":"re-register","taskId":t,"expectedVersion":1,
        "patch":{"materials":{"worktree":elsewhere}}})).unwrap();
    let mut again = dispatch(&t, "re-registered");
    again["expectedVersion"] = json!(2);
    let refused = begun(&store, Some("lead"), again).err().unwrap_or_else(|| "accepted".into());
    assert!(refused.starts_with("folder_not_allowed:"), "a worktree an Agent registered on the task is no permission either: {refused}");
    let mut user = with("user", &elsewhere);
    user["expectedVersion"] = json!(2);
    let user = begun(&store, None, user).unwrap();
    assert_eq!(user.folders[0], elsewhere, "the user's executor may work anywhere");
}

/// T-34 S3a: a template dispatch's executor gets its Project's handover
/// document and Core's summary of the task so far in its materials, and the
/// mail says where to read them; an ordinary dispatch gets neither. The
/// summary is at most 4 KiB, however much there is to tell.
#[test]
fn a_template_dispatch_carries_the_projects_handover_and_a_summary_of_the_task() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer()]));
    agent(&store, "standing");
    store.save_handover(&p, 0, "# Lab\nBuild with make.", Some("First notes")).unwrap();
    let t = task(&store, "Review", Some(&p), None);
    let uuid = crate::collaboration_store::task_key(&store.db.read().unwrap(), &t).unwrap().0;
    store.collaboration_call(None, "task_comment", json!({"requestId":"note","taskId":t,"body":format!("Check the narrow viewport first\n{}", "x".repeat(5000))})).unwrap();
    // Ten linked pull requests, each with a review that left findings open: more than 4 KiB to tell.
    {
        let db = store.db.write().unwrap();
        db.execute("INSERT INTO github_repositories(id,data) VALUES(7,?1)", [json!({"fullName":"lab/app"}).to_string()]).unwrap();
        for n in 1..=10 {
            let link = format!("7:pull:{n}");
            db.execute("INSERT INTO github_objects(id,repo_id,kind,number,data) VALUES(?1,7,'pull',?2,?3)", params![link, n,
                json!({"snapshot":{"state":"open","headSha":"a".repeat(40),"ci":{"state":"success"}},"syncedAt":"2026-11-05T00:00:00Z"}).to_string()]).unwrap();
            db.execute("INSERT INTO github_task_links(task_id,object_id) VALUES(?1,?2)", params![uuid, link]).unwrap();
            let findings: Vec<Value> = (0..7).map(|f| json!({"priority": f % 4, "title": format!("Finding {f} {}", "y".repeat(300)), "path": "core/src/lib.rs"})).collect();
            db.execute("INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES(?1,?2,?3,'completed',?4)", params![format!("review-{n}"), uuid, link,
                json!({"id":format!("review-{n}"),"headSha":"a".repeat(40),"conclusion":"changes_requested","findings":findings}).to_string()]).unwrap();
        }
    }
    let plan = begun(&store, None, dispatch(&t, "first")).unwrap();
    create(&store, &plan);
    let answer = store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
    let given = store.collaboration_call(None, "task_get", json!({"taskId":t,"dispatchId":answer["task"]["dispatch"]["id"]})).unwrap();
    let materials = &given["dispatchMaterials"];
    assert_eq!(materials["handover"], json!({"projectId":p,"version":1,"markdown":"# Lab\nBuild with make."}), "the handover reaches the executor with its materials");
    let summary = materials["contextSummary"].as_str().unwrap_or_default();
    assert!(summary.contains("lab/app #1") && summary.contains("P1 Finding 1") && summary.contains("Check the narrow viewport first"),
        "the summary tells the linked PRs, their open findings and the newest comments: {summary}");
    assert!(!summary.contains("P3 Finding 3"), "only P0-P2 findings are told");
    assert!(summary.len() <= 4 * 1024, "the summary is at most 4 KiB: {} bytes", summary.len());
    let body = answer["message"]["body"].as_str().unwrap();
    assert!(body.contains("dispatchMaterials.handover.markdown") && body.contains("dispatchMaterials.contextSummary") && !body.contains("Build with make"),
        "the mail says where to read them, not what they say: {body}");

    let plain = json!({"requestId":"plain","taskId":t,"expectedVersion":answer["task"]["version"],"toAgentId":"standing"});
    let plain = store.collaboration_call(None, "task_dispatch", plain).unwrap();
    let plain = store.collaboration_call(None, "task_get", json!({"taskId":t,"dispatchId":plain["task"]["dispatch"]["id"]})).unwrap();
    assert!(plain["dispatchMaterials"].get("handover").is_none() && plain["dispatchMaterials"].get("contextSummary").is_none(),
        "an ordinary dispatch carries neither");
}

/// YN-23: a template's delivery mode, steps and when-to-choose line reach
/// its executor's materials as the template says them, and its mail says
/// the mode and the steps, each step's approver, rounds and label.
#[test]
fn a_template_dispatch_carries_its_delivery_mode_and_steps() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    let steps = json!([{"kind":"materials"},{"kind":"work","label":"Write the memo"},{"kind":"result","label":"Options"},
        {"kind":"gate","label":"Your choice"},{"kind":"gate","approver":"either","label":"Go ahead"}]);
    let memo = json!({"id":"reviewer","label":"Decision memo","harness":"codex","deliveryMode":"none","steps":steps,
        "whenToChoose":"A choice between options, with cost and risk"});
    templates(&store, json!([memo]));
    let t = task(&store, "Choose", Some(&p), None);
    let plan = begun(&store, None, dispatch(&t, "memo")).unwrap();
    create(&store, &plan);
    let answer = store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
    let given = store.collaboration_call(None, "task_get", json!({"taskId":t,"dispatchId":answer["task"]["dispatch"]["id"]})).unwrap();
    assert_eq!(given["dispatchMaterials"]["template"], json!({"id":"reviewer","label":"Decision memo","source":"workspace","instructions":null,
        "deliveryMode":"none","steps":steps,"whenToChoose":"A choice between options, with cost and risk"}));
    let body = answer["message"]["body"].as_str().unwrap();
    assert!(body.contains("\nDelivery: none: no repository change to deliver; your result is the deliverable\n"), "{body}");
    assert!(body.contains("\nSteps (descriptive: Core does not track them): materials → work: Write the memo → result: Options → gate (user): Your choice → gate (either): Go ahead\n"),
        "an approver left unset is the user: {body}");
    assert!(!body.contains("A choice between options"), "when to choose it is for whoever dispatches, not in the executor's mail: {body}");
}

/// T-34 S3a: what a template dispatch adds is held to its own limits, not to
/// the task's: the longest handover a Project can keep, beside the longest
/// description a task can have, still dispatches.
#[test]
fn a_long_handover_never_makes_a_template_dispatch_too_large() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer()]));
    // Quotes, each escaped in the materials' JSON: twice as long there.
    let long = "\"".repeat(crate::handover::MAX_BYTES);
    store.save_handover(&p, 0, &long, None).unwrap();
    let t = store.collaboration_call(None, "task_create", json!({"requestId":"create long","title":"Long","projectId":p,
        "description":"\"".repeat(32_768)})).unwrap()["task"]["id"].as_str().unwrap().to_owned();
    let plan = begun(&store, None, dispatch(&t, "first")).unwrap();
    create(&store, &plan);
    let answer = store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone());
    let answer = answer.unwrap_or_else(|e| panic!("a dispatch is not too large for its handover: {e}"));
    let given = store.collaboration_call(None, "task_get", json!({"taskId":t,"dispatchId":answer["task"]["dispatch"]["id"]})).unwrap();
    assert_eq!(given["dispatchMaterials"]["handover"]["markdown"].as_str().map(str::len), Some(crate::handover::MAX_BYTES),
        "the whole handover is given");
}

/// T-34 S3a (#605 R3 066d114c): the summary reads only the fields it tells of
/// a review, whatever else the review's record holds, and a review it cannot
/// read fails the dispatch instead of being told as no review.
#[test]
fn a_summary_reads_only_what_it_tells_of_a_review_and_an_unreadable_review_fails_the_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer()]));
    let (told, broken) = (task(&store, "Told", Some(&p), None), task(&store, "Broken", Some(&p), None));
    {
        let db = store.db.write().unwrap();
        db.execute("INSERT INTO github_repositories(id,data) VALUES(7,?1)", [json!({"fullName":"lab/app"}).to_string()]).unwrap();
        db.execute("INSERT INTO github_objects(id,repo_id,kind,number,data) VALUES('7:pull:1',7,'pull',1,?1)",
            [json!({"snapshot":{"state":"open","headSha":"a".repeat(40),"ci":{"state":"success"}},"syncedAt":"2026-11-05T00:00:00Z"}).to_string()]).unwrap();
        for (t, data) in [
            // A completed review's record carries its evidence as well: here 4 MiB of it.
            (&told, json!({"id":"review-1","headSha":"a".repeat(40),"conclusion":"changes_requested",
                "findings":[{"priority":1,"title":"Finding kept","path":"core/src/lib.rs"}],
                "evidence":{"files":[{"patch":"z".repeat(4 << 20)}]}}).to_string()),
            (&broken, "{not json".to_owned()),
        ] {
            let uuid = crate::collaboration_store::task_key(&db, t).unwrap().0;
            db.execute("INSERT INTO github_task_links(task_id,object_id) VALUES(?1,'7:pull:1')", [&uuid]).unwrap();
            db.execute("INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES(?1,?2,'7:pull:1','completed',?3)",
                params![format!("row-{t}"), uuid, data]).unwrap();
        }
    }
    let plan = begun(&store, None, dispatch(&told, "told")).unwrap();
    create(&store, &plan);
    let answer = store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
    let given = store.collaboration_call(None, "task_get", json!({"taskId":told,"dispatchId":answer["task"]["dispatch"]["id"]})).unwrap();
    let summary = given["dispatchMaterials"]["contextSummary"].as_str().unwrap_or_default();
    assert!(summary.contains("latest review review-1") && summary.contains("P1 Finding kept"),
        "a review whose record holds much more still tells its findings: {summary}");

    let plan = begun(&store, None, dispatch(&broken, "broken")).unwrap();
    create(&store, &plan);
    let failed = store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).err()
        .map_or_else(|| "dispatched".to_owned(), |e| format!("{e:#}"));
    assert!(failed.contains("malformed JSON"), "an unreadable review is an error, not an empty summary: {failed}");
}

fn harness(name: &str) -> crate::agent_defaults::AgentDefaults {
    crate::agent_defaults::AgentDefaults { harness: Some(name.into()), ..Default::default() }
}

/// YN-2 S1: a dispatch to a new executor that names no template makes a
/// general executor. Its harness is the new-Agent default of the task's
/// Project, else the Workspace's, else Codex; everything else is left for
/// the create path to inherit. It has no instructions of its own (the
/// handover and the task's materials are its instructions), no template
/// limit, and a retry finds it as any template dispatch's.
#[test]
fn a_dispatch_without_a_template_makes_a_general_executor_from_the_defaults_for_new_agents() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    let plain = store.create_project("Plain", BTreeMap::from([("local".into(), "/synthetic/plain".into())])).unwrap().id;
    store.save_project_agent_defaults(&p, &harness("claude")).unwrap();
    store.save_handover(&p, 0, "# Lab\nBuild with make.", None).unwrap();
    let t = task(&store, "Review", Some(&p), None);
    let general = |task: &str, request: &str, executor: Value| json!({"requestId":request,"taskId":task,"expectedVersion":1,"executor":executor});

    let plan = begun(&store, None, general(&t, "general", json!({})))
        .unwrap_or_else(|e| panic!("a dispatch that names no template makes a general executor: {e}"));
    assert_eq!((plan.template.harness.as_str(), plan.name.as_str(), plan.template.id.as_str()), ("claude", "LAB-1 · Executor", ""),
        "the Project's new-Agent harness, named {{task}} · Executor, with no template id");
    assert!(plan.template.model.is_none() && plan.template.permission_mode.is_none() && plan.template.instructions.is_none(),
        "everything else is inherited as for a new Agent: {:?}", plan.template);
    assert_eq!((plan.machine.as_str(), plan.folders.as_slice()), ("local", ["/synthetic/project".to_owned()].as_slice()));
    let (template_id, template_json): (String, String) = store.db.read().unwrap().query_row(
        "SELECT template_id, template_json FROM executor_dispatches WHERE request_id='general'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((template_id.as_str(), serde_json::from_str::<Value>(&template_json).unwrap()),
        ("", json!({"id":null,"label":"Executor","source":"builtin","instructions":null})));

    // Elsewhere, the Workspace's default, else the built-in Codex.
    let elsewhere = task(&store, "Elsewhere", Some(&plain), None);
    let null = begun(&store, None, general(&elsewhere, "builtin", json!({"templateId":null}))).unwrap();
    assert_eq!(null.template.harness, "codex", "a Project without a default, and no Workspace default: Codex");
    store.save_agent_defaults(&harness("claude")).unwrap();
    let workspace = begun(&store, None, general(&elsewhere, "workspace", json!({}))).unwrap();
    assert_eq!(workspace.template.harness, "claude", "the Workspace's default");

    create(&store, &plan);
    let answer = store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
    let executor = plan.dispatch.agent_id.clone();
    assert_eq!(answer["agentId"].as_str(), Some(executor.as_str()));
    let given = store.collaboration_call(None, "task_get", json!({"taskId":t,"dispatchId":answer["task"]["dispatch"]["id"]})).unwrap();
    let materials = &given["dispatchMaterials"];
    assert_eq!(materials["template"], json!({"id":null,"label":"Executor","source":"builtin","instructions":null}));
    assert_eq!(materials["handover"]["markdown"], "# Lab\nBuild with make.", "its instructions are the handover and the materials");
    let body = answer["message"]["body"].as_str().unwrap();
    assert!(body.contains("General executor") && !body.contains("Executor template:"), "the mail says it has no template: {body}");
    assert!(!body.contains("\nDelivery:") && !body.contains("\nSteps"), "nor a template's delivery or steps (YN-23): {body}");
    let role: Option<String> = store.db.read().unwrap()
        .query_row("SELECT template_id FROM agent_roles WHERE agent_id=?1 AND kind='executor'", [&executor], |r| r.get(0)).unwrap();
    assert_eq!(role, None, "its role names no template");
    let slot: String = store.db.read().unwrap()
        .query_row("SELECT template_id FROM executor_slots WHERE agent_id=?1", [&executor], |r| r.get(0)).unwrap();
    assert_eq!(slot, "", "no template limit of its own");
    assert_eq!(store.executor_slot_next(&Default::default()).unwrap().as_deref(), Some(executor.as_str()), "it starts in its turn");

    let Ok(Next::Dispatch(again)) = store.executor_dispatch_begin(None, general(&t, "general", json!({})), LocalDefault::Read(None)) else {
        panic!("a retry with the same requestId finds the first dispatch");
    };
    assert_eq!(again.agent_id, executor);
    assert_eq!(store.collaboration_call(None, "task_dispatch", again.input).unwrap(), answer, "a retry gets the first answer");
}

/// YN-2 S1: a template the dispatch names and neither list has is refused
/// with the ids it could name, and the general executor as the way without one.
#[test]
fn a_missing_template_is_refused_naming_the_templates_and_the_general_executor() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer(), {"id":"writer","label":"Writer","harness":"claude"}]));
    let t = task(&store, "Review", Some(&p), None);
    let refused = begun(&store, None, json!({"requestId":"missing","taskId":t,"expectedVersion":1,"executor":{"templateId":"missing"}})).unwrap_err();
    assert!(refused.starts_with("template_not_found:") && refused.contains("can use are: reviewer, writer")
        && refused.contains("executor: {} makes a general executor"), "{refused}");
    let empty = begun(&store, None, json!({"requestId":"empty","taskId":t,"expectedVersion":1,"executor":{"templateId":""}})).unwrap_err();
    assert!(empty.starts_with("invalid_input: templateId must not be empty"), "an empty id is no general executor: {empty}");
}

/// YN-2 S1: a general executor's machine is checked for the harness the
/// defaults give it, as a template's is for its own: a contained machine
/// runs no Codex executor, and `auto` leaves it out for one.
#[test]
fn a_general_executors_machine_is_checked_for_the_harness_its_defaults_give() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    machine(&store, "boxed", "Boxed", true);
    let p = store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into()),
        ("boxed".into(), "/srv/boxed/project".into())])).unwrap().id;
    let t = task(&store, "Review", Some(&p), None);
    let with = |request: &str, machine: &str| json!({"requestId":request,"taskId":t,"expectedVersion":1,"executor":{"machineId":machine}});
    let refused = begun(&store, None, with("codex", "boxed")).unwrap_err();
    assert!(refused.starts_with("machine_contained: Boxed keeps its Agents contained"), "the built-in Codex: {refused}");
    let auto = begun(&store, None, with("auto", "auto")).unwrap();
    assert_eq!(auto.machine, "local", "auto leaves the contained machine out for a Codex executor");
    store.save_project_agent_defaults(&p, &harness("claude")).unwrap();
    let claude = begun(&store, None, with("claude", "boxed")).unwrap();
    assert_eq!((claude.machine.as_str(), claude.template.harness.as_str()), ("boxed", "claude"), "a Claude Code default runs there");
}

/// YN-2 S2: templates are the Workspace's. A dispatch of a task in a Project
/// gets the Workspace's template of the id it names, never a Project's own
/// list kept from before, and its materials say so.
#[test]
fn a_dispatch_in_a_project_gets_the_workspaces_template_of_that_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let p = project(&store);
    templates(&store, json!([reviewer()]));
    store.db.write().unwrap().execute("INSERT INTO workspace_meta(key,value) VALUES(?1,?2)",
        params![crate::executor_templates::project_key(&p),
            json!({"version":1,"templates":[{"id":"reviewer","label":"Project reviewer","harness":"codex"}]}).to_string()]).unwrap();
    let t = task(&store, "Review", Some(&p), None);
    let plan = begun(&store, None, dispatch(&t, "first")).unwrap();
    assert_eq!((plan.template.label.as_str(), plan.template.harness.as_str()), ("Reviewer", "claude"),
        "the Workspace's reviewer, not the Project's own list from before");
    let given: String = store.db.read().unwrap()
        .query_row("SELECT template_json FROM executor_dispatches WHERE request_id='first'", [], |r| r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&given).unwrap()["source"], "workspace");
}

/// YN-34 S3b2: routing at dispatch, on synthetic readings.
mod routing {
    use super::*;
    use crate::{routing_keys::Provider, routing_launch::RuntimeProfile, routing_policy::evaluate::Gathered, routing_readings::DaySpend};

    fn gathered(with_key: bool) -> Gathered {
        Gathered { keys: if with_key { vec![("deepseek".into(), Provider::Deepseek, "local")] } else { vec![] }, codex_homes: vec![],
            spend: DaySpend::default(), cswap: Value::Null, codex: vec![] }
    }

    fn routed(store: &Store, input: Value, with_key: bool) -> Plan {
        match store.executor_dispatch_begin_routed(None, input, LocalDefault::Read(None), Some(&gathered(with_key))) {
            Ok(Next::Create(plan)) => *plan,
            Ok(Next::Dispatch(_)) => panic!("went on to a dispatch"),
            Err(error) => panic!("{error:#}"),
        }
    }

    /// The executor its plan makes, with the plan's harness (the waiting list reads it from the agent).
    fn create_as_planned(store: &Store, plan: &Plan) {
        let mut detail = agent_detail(&plan.dispatch.agent_id, &plan.name);
        detail.agent.harness = plan.template.harness.clone();
        store.insert_created_then(&detail, Some(plan.then())).unwrap();
    }

    fn route_of(store: &Store, agent: &str) -> Option<Value> {
        store.db.read().unwrap().query_row("SELECT route_json FROM executor_dispatches WHERE agent_id=?1", [agent],
            |r| r.get::<_, Option<String>>(0)).unwrap().map(|r| serde_json::from_str(&r).unwrap())
    }

    #[test]
    fn routing_gives_a_dispatch_its_candidate_or_has_it_wait_and_a_fixed_template_is_as_it_says() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        let p = project(&store);
        templates(&store, json!([reviewer(), {"id":"fixed","label":"Fixed","harness":"claude","routing":"fixed"}]));
        let policy = json!({"enabled": true, "whenNone": "wait", "candidates": [
            {"id": "c-deepseek", "enabled": true, "harness": "opencode", "model": "deepseek/deepseek-flash",
             "credential": {"kind": "apiKey", "keyId": "deepseek"}, "conditions": []},
            {"id": "c-codex", "enabled": true, "harness": "codex", "model": "gpt-test", "reasoningEffort": "high",
             "credential": {"kind": "login"}, "conditions": []}]});
        store.save_routing_policy(0, policy).unwrap().unwrap();

        // The first candidate whose conditions hold: DeepSeek on its key, on this Core host.
        let one = task(&store, "One", Some(&p), None);
        let plan = routed(&store, dispatch(&one, "one"), true);
        assert_eq!((plan.template.harness.as_str(), plan.template.model.as_deref(), plan.machine.as_str()),
            ("opencode", Some("deepseek/deepseek-flash"), "local"));
        assert_eq!(plan.profile, Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() }));
        assert!(plan.template.permission_mode.is_none(), "a Claude permission is not an OpenCode one");
        let route = route_of(&store, &plan.dispatch.agent_id).unwrap();
        assert_eq!((route["chosen"].clone(), route["at"].clone(), route["excluded"].clone()), (json!("c-deepseek"), json!("dispatch"), json!([])));
        create_as_planned(&store, &plan);
        store.collaboration_call(None, "task_dispatch", plan.dispatch.input.clone()).unwrap();
        let current = store.collaboration_call(None, "task_get", json!({"taskId": one, "view": "current"})).unwrap();
        assert_eq!(current["current"]["executorSlot"]["route"]["chosen"], "c-deepseek", "the task shows why: {current}");

        // A fixed template starts as it says, with no route and no profile.
        let mut input = dispatch(&task(&store, "Two", Some(&p), None), "two");
        input["executor"]["templateId"] = json!("fixed");
        let fixed = routed(&store, input, true);
        assert_eq!((fixed.template.harness.as_str(), fixed.profile.clone(), route_of(&store, &fixed.dispatch.agent_id)), ("claude", None, None));

        // A rebuild of the first leaves DeepSeek out: Codex, on the host's login, with its effort.
        let mut rebuild = dispatch(&task(&store, "Three", Some(&p), None), &format!("rebuild:{}", plan.dispatch.agent_id));
        rebuild["expectedVersion"] = json!(1);
        let again = routed(&store, rebuild, true);
        assert_eq!((again.template.harness.as_str(), again.template.model.as_deref(), again.template.reasoning_effort.as_deref(), again.profile.clone()),
            ("codex", Some("gpt-test"), Some("high"), None));
        let route = route_of(&store, &again.dispatch.agent_id).unwrap();
        assert_eq!((route["chosen"].clone(), route["excluded"].clone(), route["candidates"][0]["state"].clone()),
            (json!("c-codex"), json!(["c-deepseek"]), json!("failed")));

        // None holds (no key, and Codex off): made with the first one's harness, and it waits in the queue.
        let mut off = store.routing_policy().unwrap().policy;
        off["candidates"][1]["enabled"] = json!(false);
        store.save_routing_policy(1, off).unwrap().unwrap();
        let waits = routed(&store, dispatch(&task(&store, "Four", Some(&p), None), "four"), false);
        assert_eq!((waits.template.harness.as_str(), waits.template.model.clone(), waits.profile.clone()), ("opencode", None, None));
        let route = route_of(&store, &waits.dispatch.agent_id).unwrap();
        assert_eq!((route["waiting"].clone(), route["chosen"].clone()), (json!(true), Value::Null));
        create_as_planned(&store, &waits);
        store.collaboration_call(None, "task_dispatch", waits.dispatch.input.clone()).unwrap();
        assert!(crate::routing_policy::dispatch::waiting(&*store.db.read().unwrap(), &waits.dispatch.agent_id).unwrap());
        let listed = store.routing_waiting().unwrap();
        assert_eq!(listed.iter().map(|(a, h, m, _)| (a.clone(), h.clone(), m.clone())).collect::<Vec<_>>(),
            [(waits.dispatch.agent_id.clone(), "opencode".to_owned(), "local".to_owned())]);
        // The slot pass leaves it queued and takes the routed one ahead of it.
        let in_flight = std::sync::Mutex::new(std::collections::HashSet::new());
        assert_eq!(store.executor_slot_next(&in_flight).unwrap(), Some(plan.dispatch.agent_id.clone()));
        assert_eq!(store.executor_slot_next(&in_flight).unwrap(), None, "the waiting one is not started");

        // Routing turned off while it waits: it is released and starts as without routing (#805 R1 P2).
        let mut off = store.routing_policy().unwrap();
        off.policy["enabled"] = json!(false);
        store.save_routing_policy(off.version, off.policy.clone()).unwrap().unwrap();
        assert_eq!(store.release_routing_waiting().unwrap(), [waits.dispatch.agent_id.clone()]);
        let route = route_of(&store, &waits.dispatch.agent_id).unwrap();
        assert_eq!((route["waiting"].clone(), route["released"]["code"].clone()), (json!(false), json!("routingOff")));
        assert_eq!(store.executor_slot_next(&in_flight).unwrap(), Some(waits.dispatch.agent_id.clone()), "it starts in turn");
        assert!(store.routing_waiting().unwrap().is_empty());
        // On again, with no enabled candidate of its harness: none could ever be chosen, so it is released too.
        let mut on = store.routing_policy().unwrap();
        on.policy["enabled"] = json!(true);
        on.policy["candidates"][0]["enabled"] = json!(false);
        let release = |policy: &Value, harness: &str, excluded: &[&str], machine: &str| {
            let excluded: Vec<String> = excluded.iter().map(|e| (*e).to_owned()).collect();
            crate::routing_policy::dispatch::release_reason(policy, harness, &excluded, machine).map(|r| r["code"].clone())
        };
        let reason = |policy: &Value, harness: &str| release(policy, harness, &[], "local");
        assert_eq!((reason(&on.policy, "opencode"), reason(&on.policy, "codex")), (Some(json!("noCandidate")), Some(json!("noCandidate"))),
            "DeepSeek off, and Codex off since earlier");
        on.policy["candidates"][1]["enabled"] = json!(true);
        assert_eq!((reason(&on.policy, "opencode"), reason(&on.policy, "codex")), (Some(json!("noCandidate")), None),
            "an enabled Codex candidate may hold later, so a Codex executor keeps waiting");
        // Only candidates it could be given count (#805 R2 P3): not one excluded for its rebuild, and not
        // a host-only one while it waits on another machine.
        assert_eq!(release(&on.policy, "codex", &["c-codex"], "local"), Some(json!("noCandidate")), "excluded for a rebuild");
        on.policy["candidates"][0]["enabled"] = json!(true);
        assert_eq!((release(&on.policy, "opencode", &[], "local"), release(&on.policy, "opencode", &[], "lab-mac")),
            (None, Some(json!("noCandidate"))), "OpenCode on a key runs here only");
        assert_eq!(release(&on.policy, "codex", &[], "lab-mac"), None, "Codex on the login runs anywhere");

        // The newest choices first.
        let choices = store.routing_choices(10).unwrap();
        assert_eq!(choices.iter().map(|c| c["agentId"].as_str().unwrap().to_owned()).collect::<Vec<_>>(),
            [waits.dispatch.agent_id.clone(), again.dispatch.agent_id.clone(), plan.dispatch.agent_id.clone()]);
        assert_eq!((choices[0]["executorName"].clone(), choices[1].get("executorName")), (json!(waits.name), None),
            "a made executor is named; the rebuild here was never made");
    }
}
