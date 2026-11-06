use super::*;
use crate::model::AgentDetail;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

/// How many closes of each Agent are made to fail as an unconfirmed remote
/// close does (executor_release.rs `archive_now`).
static FAILING_CLOSES: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

pub(crate) fn close_fails(agent: &str) -> bool {
    let mut failing = FAILING_CLOSES.lock().unwrap();
    let Some(left) = failing.as_mut().and_then(|all| all.get_mut(agent)).filter(|left| **left > 0) else { return false };
    *left -= 1;
    true
}

fn fail_closes(agent: &str, times: usize) {
    FAILING_CLOSES.lock().unwrap().get_or_insert_with(HashMap::new).insert(agent.to_owned(), times);
}

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

/// A task (its public ID), in `project` if given, and its internal ID.
fn task(store: &Store, title: &str, project: Option<&str>) -> (String, String) {
    let created = store.collaboration_call(None, "task_create", json!({"requestId":format!("create {title}"),"title":title,"projectId":project})).unwrap();
    let public = created["task"]["id"].as_str().unwrap().to_owned();
    let internal = task_key(&store.db.read().unwrap(), &public).unwrap().0;
    (public, internal)
}

/// Executor `id` of `task` (internal ID), dispatched by `by` (as the receipts key it).
fn executor(store: &Store, id: &str, task: &str, by: &str) {
    agent(store, id);
    store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at)
         VALUES(?1,'executor','reviewer',?2,?3,'dispatched','now','now')",
        params![id, task, by],
    ).unwrap();
}

/// A Job of `agent` holding its reservation (`reserved`), or queued.
fn job(store: &Store, id: &str, name: &str, agent: &str, task: &str, reserved: bool) {
    let status = if reserved { "running" } else { "queued" };
    store.db.write().unwrap().execute(
        "INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES(?1,?2,?3,?4,?5,?6)",
        params![id, task, agent, status, reserved, json!({"id":id,"name":name,"agentId":agent,"taskId":task,"status":status}).to_string()],
    ).unwrap();
}

fn end_job(store: &Store, id: &str) {
    store.db.write().unwrap().execute("UPDATE local_jobs SET reserved=0,status='succeeded' WHERE id=?1", [id]).unwrap();
}

async fn release(ws: &Arc<Workspace>, actor: Option<&str>, id: &str) -> Result<Value> {
    ws.collaboration_call(actor, "executor_release", json!({"requestId":format!("release-{id}-{}", actor.unwrap_or("user")),"agentId":id})).await
}

fn closed(store: &Store, id: &str) -> bool {
    store.agent(id).unwrap().closed_at.is_some()
}

/// Its role row's `state`, `archived_at` and `released_by`.
fn role(store: &Store, id: &str) -> (Option<String>, Option<String>, Option<String>) {
    store.db.read().unwrap()
        .query_row("SELECT state,archived_at,released_by FROM agent_roles WHERE agent_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
}

fn refused(answer: Result<Value>, code: &str) -> String {
    match answer {
        Ok(answer) => panic!("refused with {code}, not answered: {answer}"),
        Err(error) => {
            let error = error.to_string();
            assert!(error.starts_with(code), "refused with {code}: {error}");
            error
        }
    }
}

/// T-36 S2: a release while a Job of the executor's still runs is archiving:
/// the answer says what it waits for, the executor stays open, starts
/// nothing new and can still report. Once the Job ends, a pass closes it for
/// good, as the release's.
#[tokio::test]
async fn a_release_with_a_running_job_is_archiving_until_the_job_ends() {
    let (_dir, ws) = workspace();
    agent(&ws.store, "lead");
    let (public, t) = task(&ws.store, "Review", None);
    executor(&ws.store, "e1", &t, "agent:lead");
    job(&ws.store, "j1", "build", "e1", &t, true);
    let answer = release(&ws, Some("lead"), "e1").await.unwrap();
    assert_eq!(answer["archiving"]["reason"], "Waiting to close: a Job is still running: build (j1).", "the answer says what it waits for: {answer}");
    assert_eq!(answer["archiving"]["releasedBy"], "agent:lead");
    assert!(answer["releasedAt"].is_null() && !closed(&ws.store, "e1"), "not closed while its Job runs");
    assert_eq!(role(&ws.store, "e1").0.as_deref(), Some("archiving"));
    let submit = json!({"requestId":"more","taskId":public,"name":"more","cwd":"/synthetic/work","argv":["/usr/bin/true"],
        "resources":{"cpuMillis":100,"memoryMiB":64,"swapMiB":0}});
    let error = refused(ws.collaboration_call(Some("e1"), "job_submit", submit).await, "executor_archiving:");
    assert!(error.contains("job_submit is refused"), "{error}");
    refused(ws.collaboration_call(Some("e1"), "review_start", json!({"requestId":"r","taskId":public})).await, "executor_archiving:");
    ws.collaboration_call(Some("e1"), "task_comment", json!({"requestId":"note","taskId":public,"body":"Still here"})).await
        .expect("it can still report");
    ws.archive_pass().await;
    assert!(!closed(&ws.store, "e1"), "a pass while the Job runs changes nothing");
    end_job(&ws.store, "j1");
    ws.archive_pass().await;
    assert!(closed(&ws.store, "e1"), "closed once its Job ended");
    let (state, archived, by) = role(&ws.store, "e1");
    assert_eq!((state.as_deref(), archived.is_some(), by.as_deref()), (Some("released"), true, Some("agent:lead")));
    assert!(archiving(&ws.store.db.read().unwrap(), "e1").unwrap().is_none(), "no longer archiving");
    let again = release(&ws, Some("lead"), "e1").await.unwrap();
    assert!(again["releasedAt"].is_string() && again.get("archiving").is_none(), "{again}");
}

/// T-36 S2: what a release waits for, besides its running Jobs: a delivery
/// flow it owns that has not ended, and a pull request operation it asked
/// for still in flight. Queued Jobs are not waited for.
#[test]
fn a_release_waits_for_its_delivery_flow_and_its_pull_request_operation() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let (_, t) = task(&store, "Review", None);
    executor(&store, "e1", &t, "agent:lead");
    job(&store, "queued", "later", "e1", &t, false);
    assert_eq!(waits(&store.db.read().unwrap(), "e1").unwrap(), Vec::<String>::new(), "a queued Job is not waited for");
    store.db.write().unwrap().execute("INSERT INTO delivery_flows(task_id,data) VALUES(?1,?2)",
        params![t, json!({"id":"f1","taskRef":"T-1","owner":{"kind":"agent","id":"e1","name":"Agent e1"},"terminal":null}).to_string()]).unwrap();
    store.db.write().unwrap().execute(
        "INSERT INTO pr_operations(id,task_id,repo_id,head,status,data) VALUES('op1',?1,1,'feature','running',?2)",
        params![t, json!({"requestedBy":{"kind":"agent","id":"e1","name":"Agent e1"}}).to_string()]).unwrap();
    assert_eq!(waits(&store.db.read().unwrap(), "e1").unwrap(), vec![
        "its delivery flow for T-1 is still under way (stop it, or let it end)".to_owned(),
        "1 pull request operation is still in flight".to_owned(),
    ]);
    store.db.write().unwrap().execute("UPDATE delivery_flows SET data=json_set(data,'$.terminal',json('{\"state\":\"stopped\"}'))", []).unwrap();
    store.db.write().unwrap().execute("UPDATE pr_operations SET status='completed'", []).unwrap();
    assert!(waits(&store.db.read().unwrap(), "e1").unwrap().is_empty(), "once both ended, nothing");
}

/// T-36 S2: a close that cannot be confirmed (a remote close) keeps the
/// executor archiving, its error as the reason, tried again only after its
/// wait; once the close goes through, it is archived.
#[tokio::test]
async fn a_close_that_fails_stays_archiving_and_is_tried_again_after_its_wait() {
    let (_dir, ws) = workspace();
    agent(&ws.store, "lead");
    let (_, t) = task(&ws.store, "Review", None);
    executor(&ws.store, "remote", &t, "agent:lead");
    fail_closes("remote", 1);
    let answer = release(&ws, None, "remote").await.unwrap();
    let reason = answer["archiving"]["reason"].as_str().unwrap();
    assert!(reason.starts_with("The close could not be confirmed, so it is tried again: 远程状态尚未确认"), "{answer}");
    let (attempts, next): (i64, Option<String>) = ws.store.db.read().unwrap()
        .query_row("SELECT attempts,next_try_at FROM executor_archiving WHERE agent_id='remote'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(attempts, 1);
    let wait = chrono::DateTime::parse_from_rfc3339(next.as_deref().unwrap()).unwrap().signed_duration_since(chrono::Utc::now());
    assert!((25..=31).contains(&wait.num_seconds()), "tried again in about 30 s: {wait}");
    ws.archive_pass().await;
    assert!(!closed(&ws.store, "remote"), "not before its wait");
    ws.store.db.write().unwrap().execute("UPDATE executor_archiving SET next_try_at=?1", [chrono::Utc::now().to_rfc3339()]).unwrap();
    ws.archive_pass().await;
    assert!(closed(&ws.store, "remote"), "the next try closes it");
    assert_eq!(role(&ws.store, "remote").2.as_deref(), Some("user"), "still the user's release");
}

/// T-36 S2 (the user's decision of 2026-11-06): the Agent that dispatched an
/// executor, any lead of its task's Project, or the user releases it. A lead
/// of another Project is told whose Project it is; any other Agent is
/// refused as before.
#[tokio::test]
async fn the_dispatcher_any_lead_of_the_tasks_project_or_the_user_releases_it() {
    let (_dir, ws) = workspace();
    let s = &ws.store;
    for id in ["lead", "colead", "elsewhere", "plain"] {
        agent(s, id);
    }
    let app = s.create_project("App", BTreeMap::from([("local".into(), "/synthetic/app".into())])).unwrap().id;
    let docs = s.create_project("Docs", BTreeMap::from([("local".into(), "/synthetic/docs".into())])).unwrap().id;
    for (id, project) in [("lead", &app), ("colead", &app), ("plain", &app), ("elsewhere", &docs)] {
        s.set_agent_project(id, Some(project)).unwrap();
    }
    crate::agent_roles::save(s, &app, 0, vec!["lead".into(), "colead".into()]).unwrap();
    crate::agent_roles::save(s, &docs, 0, vec!["elsewhere".into()]).unwrap();
    let mut released = vec![];
    for (n, actor) in [Some("lead"), Some("colead"), None].into_iter().enumerate() {
        let (_, t) = task(s, &format!("Slice {n}"), Some(&app));
        let id = format!("e{n}");
        executor(s, &id, &t, "agent:lead");
        if n == 0 {
            let error = refused(release(&ws, Some("elsewhere"), &id).await, "not_project_lead:");
            assert_eq!(error, "not_project_lead: you lead Docs, not App, this executor's task's Project; only the Agent that \
                dispatched this executor, a lead of its task's Project, or the user can release it");
            refused(release(&ws, Some("plain"), &id).await, "not_dispatcher:");
            assert!(!closed(s, &id), "nothing changed");
        }
        let answer = release(&ws, actor, &id).await.unwrap_or_else(|error| panic!("{actor:?} may release it: {error}"));
        released.push((answer["releasedAt"].is_string(), answer["releasedBy"].clone()));
    }
    assert_eq!(released, vec![(true, json!("agent:lead")), (true, json!("agent:colead")), (true, json!("user"))],
        "the dispatcher, a lead of the task's Project and the user");
}

/// T-36 S2: setting a task done releases its executor, by the same rule as
/// a release: its dispatcher, a lead of its Project or the user. Another
/// Agent's done leaves it as it was.
#[tokio::test]
async fn setting_its_task_done_releases_the_executor_by_the_same_rule() {
    let (_dir, ws) = workspace();
    let s = &ws.store;
    agent(s, "lead");
    agent(s, "plain");
    let (first, t1) = task(s, "First", None);
    let (second, t2) = task(s, "Second", None);
    executor(s, "e1", &t1, "agent:lead");
    executor(s, "e2", &t2, "agent:lead");
    let done = |task: &str, request: &str| json!({"requestId":request,"taskId":task,"expectedVersion":1,"patch":{"status":"done"}});
    ws.collaboration_call(Some("lead"), "task_update", done(&first, "lead done")).await.unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !closed(s, "e1") {
        assert!(std::time::Instant::now() < deadline, "the dispatcher's done releases its executor");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(role(s, "e1").2.as_deref(), Some("agent:lead"));
    ws.collaboration_call(Some("plain"), "task_update", done(&second, "plain done")).await.unwrap();
    // What its done set off, awaited here: the same rule refuses it.
    ws.release_on_done(Some("plain".into()), second.clone()).await;
    assert!(!closed(s, "e2") && role(s, "e2").1.is_none(), "another Agent's done does not release it");
}

/// T-36 S2: the close that archives an executor tells its dispatcher of each
/// task-status proposal it left undecided; a decided one is not repeated.
#[tokio::test]
async fn its_archive_mails_its_dispatcher_each_proposal_it_left_undecided() {
    let (_dir, ws) = workspace();
    agent(&ws.store, "lead");
    let (_, t) = task(&ws.store, "Review", None);
    executor(&ws.store, "e1", &t, "agent:lead");
    let spec = |status: &str| json!({"root":"r","elements":{"r":{"type":"Result","props":{"title":"Status","summary":"Done here."},"children":["p"]},
        "p":{"type":"TaskStatus","props":{"taskId":"T-1","status":status,"reason":"Merged; acceptance is open"}}}}).to_string();
    for (id, status) in [("open", "review"), ("decided", "done")] {
        ws.store.db.write().unwrap().execute(
            "INSERT INTO interactive_results(id,chain_id,version,agent_id,session_id,turn_id,request_id,schema_version,spec_json,defaults_json,raw_json,created_at)
             VALUES(?1,?1,1,'e1','session','t1',?1,2,?2,'[]',?2,'now')", params![id, spec(status)]).unwrap();
    }
    ws.store.db.write().unwrap().execute(
        "INSERT INTO result_task_actions(result_id,request_id,task_id,action,status,reason,expected_version,state,actor_json,created_at,updated_at)
         VALUES('decided','d1',?1,'decline',NULL,NULL,NULL,'declined','{}','now','now')", [&t]).unwrap();
    release(&ws, Some("lead"), "e1").await.unwrap();
    let read = ws.store.collaboration_call(None, "peer_read", json!({"agentId":"lead"})).unwrap();
    let mail: Vec<_> = read["messages"].as_array().unwrap().iter().filter(|m| m["metadata"]["kind"] == "executor_proposal").collect();
    assert_eq!(mail.len(), 1, "one mail, for the undecided proposal: {mail:?}");
    assert_eq!(mail[0]["metadata"]["resultId"], "open");
    assert!(mail[0]["body"].as_str().unwrap().starts_with("Agent e1 (the executor of T-1 you dispatched, now released) left a task status proposal \
        undecided: T-1 to review, because \"Merged; acceptance is open\"."), "{}", mail[0]["body"]);
}
