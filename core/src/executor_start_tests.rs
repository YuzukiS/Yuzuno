use super::*;
use crate::{model::AgentDetail, store::Store};
use rusqlite::params;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};

async fn until(what: &str, mut check: impl FnMut() -> bool) {
    let waited = tokio::time::timeout(Duration::from_secs(20), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await;
    assert!(waited.is_ok(), "timed out waiting: {what}");
}

/// A Workspace whose Codex is `program`, with a Project ("Lab", its folder
/// on this host), a lead of it ("lead", not started), and the Workspace's
/// Codex template "reviewer". Its scheduler loop is not started: each test
/// runs passes itself, beside those a dispatch spawns.
struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    project: String,
}

impl Lab {
    async fn new(program: impl FnOnce(&Path) -> String) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let folder = std::fs::canonicalize(folder).unwrap().to_string_lossy().into_owned();
        let program = program(dir.path());
        let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), program).unwrap();
        let project = ws.store.create_project("Lab", BTreeMap::from([("local".into(), folder)])).unwrap().id;
        agent(&ws.store, "lead", "claude");
        ws.store.set_agent_project("lead", Some(&project)).unwrap();
        crate::agent_roles::save(&ws.store, &project, 0, vec!["lead".into()]).unwrap();
        ws.store.db.write().unwrap().execute(
            "INSERT INTO workspace_meta(key,value) VALUES('executors.templates',?1)",
            [json!({"version":1,"templates":[{"id":"reviewer","label":"Reviewer","harness":"codex"}]}).to_string()]).unwrap();
        Lab { _dir: dir, ws, project }
    }

    async fn task(&self, title: &str) -> String {
        let input = json!({"requestId":format!("create {title}"),"title":title,"projectId":self.project});
        self.ws.collaboration_call(None, "task_create", input).await.unwrap()["task"]["id"].as_str().unwrap().to_owned()
    }

    /// The lead dispatches `task` from the template; the executor's id.
    async fn dispatch(&self, task: &str, request: &str) -> String {
        let input = json!({"requestId":request,"taskId":task,"expectedVersion":1,"executor":{"templateId":"reviewer"}});
        self.ws.collaboration_call(Some("lead"), "task_dispatch", input).await.unwrap()["agentId"].as_str().unwrap().to_owned()
    }

    fn task_view(&self, task: &str) -> Value {
        self.ws.store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"full"})).unwrap()
    }

    fn slot(&self, agent: &str) -> (String, Option<String>, i64, Option<String>) {
        self.ws.store.db.read().unwrap().query_row(
            "SELECT state, reason, seq, rebuilt_from FROM executor_slots WHERE agent_id=?1", [agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
    }

    /// The lead's mail about executors, as Core sent it.
    fn executor_mail(&self) -> Vec<Value> {
        let rows: Vec<String> = self.ws.store.db.read().unwrap()
            .prepare("SELECT data FROM collaboration_messages WHERE recipient_id='lead' AND json_extract(data,'$.metadata.kind')='executor' ORDER BY seq").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        rows.iter().map(|raw| serde_json::from_str(raw).unwrap()).collect()
    }

    /// The only slot taken by an executor that never runs, so one dispatched
    /// next waits until a test moves it on.
    fn occupy_the_slot(&self) {
        let db = self.ws.store.db.write().unwrap();
        db.execute("INSERT INTO workspace_meta(key,value) VALUES('executors.slots',?1)", [json!({"version":1,"slots":1}).to_string()]).unwrap();
        db.execute("INSERT INTO executor_slots(agent_id,seq,task_id,machine_id,template_id,state,since,queued_at)
            VALUES('holder',0,'task-holder','local','reviewer','running','now','now')", []).unwrap();
        // An open Agent, so no pass releases it.
        drop(db);
        agent(&self.ws.store, "holder", "codex");
    }

    /// `agent` as a pass that took it leaves it: starting, with no reason.
    fn taken(&self, agent: &str, attempt: i64) {
        self.ws.store.db.write().unwrap().execute(
            "UPDATE executor_slots SET state='starting',reason=NULL,attempt=?2 WHERE agent_id=?1", params![agent, attempt]).unwrap();
    }
}

fn agent(store: &Store, id: &str, harness: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
        "model":"","harness":harness,"color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
}

/// A Codex that can't start: no such program.
fn missing(dir: &Path) -> String {
    dir.join("no-codex").to_string_lossy().into_owned()
}

/// A Codex that starts and never answers.
fn silent(dir: &Path) -> String {
    let script = dir.join("silent-codex");
    std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_string_lossy().into_owned()
}

/// Lead 2 (mail 5367): a start the time limit cut off is a definite failure
/// only when closing the executor confirmed its runtime ended. When the
/// close can't confirm that, its runtime may run on in its folder: the start
/// is uncertain, held and never rebuilt, for two executors must never run in
/// one folder.
#[test]
fn a_cut_off_start_is_definite_only_when_its_close_confirmed_the_runtime_ended() {
    let limit = Duration::from_secs(300);
    assert_eq!(cut_off(&Ok(()), limit),
        Failure::Definite("its start did not finish within 300 s, the Workspace's limit; Core closed it".into()));
    let unconfirmed = cut_off(&Err(anyhow::anyhow!("Not confirmed: the machine didn't confirm it stopped")), limit);
    assert_eq!(unconfirmed, Failure::Uncertain("its start did not finish within 300 s, the Workspace's limit, and Core could not \
        confirm its runtime stopped: Not confirmed: the machine didn't confirm it stopped".into()),
        "unconfirmed: uncertain, never rebuilt, so no second executor works in its folder");
}

/// D3, E1, E2: a fresh dispatch's executor whose start fails is closed and
/// kept, and rebuilt once, as a new dispatch D2 of the same request by the
/// same lead, which keeps its place in the queue. When that one fails too,
/// Core blocks the task with both reasons and mails the lead once. D1 reads
/// as superseded, with why; a replay of the first request returns its answer.
#[tokio::test]
async fn a_failed_start_is_rebuilt_once_then_the_task_is_blocked_with_both_reasons() {
    let lab = Lab::new(missing).await;
    let task = lab.task("Review the parser").await;
    let first = lab.dispatch(&task, "first").await;
    let d1 = lab.task_view(&task)["task"]["dispatch"]["id"].as_str().unwrap().to_owned();
    let seq = lab.slot(&first).2;
    for started in lab.ws.executor_slots_pass().await {
        started.await.unwrap();
    }
    until("the task is blocked", || lab.task_view(&task)["task"]["status"] == "blocked").await;

    let (state, reason, _, _) = lab.slot(&first);
    assert_eq!(state, "released");
    assert!(reason.as_deref().is_some_and(|r| r.contains("no-codex")), "released with its own reason, not \"closed\": {reason:?}");
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_some(), "the first is closed, and kept");
    let second: String = lab.ws.store.db.read().unwrap().query_row(
        "SELECT to_agent FROM executor_rebuilds WHERE from_agent=?1 AND state='done'", [&first], |r| r.get(0)).unwrap();
    assert_ne!(second, first);
    let (state, _, kept_seq, rebuilt_from) = lab.slot(&second);
    assert_eq!((state.as_str(), kept_seq, rebuilt_from.as_deref()), ("released", seq, Some(first.as_str())),
        "the rebuilt one kept the first's place, and says what it replaced");
    assert!(lab.ws.store.agent(&second).unwrap().closed_at.is_some(), "the second is closed, and kept");
    assert_eq!(lab.ws.store.agents().unwrap().iter().filter(|a| a.kind.as_deref() == Some("executor")).count(), 2, "one rebuild only");

    let view = lab.task_view(&task);
    let blocker = view["task"]["blocker"].as_str().unwrap();
    assert!(blocker.starts_with("Its executor did not start, nor the one Core rebuilt for it."), "{blocker}");
    assert_eq!(blocker.matches("no-codex").count(), 2, "both reasons: {blocker}");
    let d2 = view["task"]["dispatch"]["id"].as_str().unwrap().to_owned();
    assert_ne!(d2, d1, "D2 is a dispatch of its own");
    assert_eq!(view["task"]["dispatch"]["executor"]["id"], json!(second));
    let activities = view["activities"].as_array().unwrap();
    let by_core: Vec<&Value> = activities.iter().filter(|a| a["actor"]["kind"] == "system").collect();
    assert_eq!(by_core.iter().map(|a| a["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["comment", "updated"],
        "Core wrote the rebuild and the block");
    assert!(by_core[0]["body"].as_str().unwrap().contains("rebuilt it once as"), "{}", by_core[0]);
    assert_eq!(by_core[1]["changes"]["status"], "blocked");
    let detail = &by_core[1]["source"]["executorStart"];
    assert_eq!(detail["dispatcher"], json!({"kind":"agent","id":"lead"}), "the activity names the dispatcher");
    assert_eq!(detail["executors"].as_array().unwrap().iter().map(|e| e["agentId"].clone()).collect::<Vec<_>>(), [json!(first), json!(second)],
        "and both executors, each with its reason");

    let mail = lab.executor_mail();
    assert_eq!(mail.len(), 1, "one mail to the lead: {mail:?}");
    assert_eq!(mail[0]["metadata"]["status"], "blocked");
    assert!(mail[0]["body"].as_str().unwrap().contains("is blocked: its executor did not start, nor the one Core rebuilt for it"));

    let fixed = lab.ws.store.collaboration_call(None, "task_get", json!({"taskId":task,"dispatchId":d1})).unwrap();
    assert_eq!(fixed["supersededBy"]["byDispatchId"], json!(d2), "D1 reads as superseded");
    assert!(fixed["supersededBy"]["reason"].as_str().unwrap().contains("no-codex"), "with why: {}", fixed["supersededBy"]);
    let replay = json!({"requestId":"first","taskId":task,"expectedVersion":1,"executor":{"templateId":"reviewer"}});
    let replayed = lab.ws.collaboration_call(Some("lead"), "task_dispatch", replay).await.unwrap();
    assert_eq!(replayed["agentId"], json!(first), "a replay of the first request returns its recorded answer");
}

/// E3 and the timeout's safety: a start that doesn't finish within the
/// limit is cut off; its close confirms the runtime ended (a local process,
/// killed with its start), so it is a definite failure, rebuilt once.
#[tokio::test]
async fn a_start_past_the_time_limit_is_cut_off_and_settled_as_a_definite_failure() {
    let lab = Lab::new(silent).await;
    *lab.ws.executor_slots.start_limit.lock().unwrap() = Some(Duration::from_secs(1));
    let task = lab.task("Review the slow one").await;
    let first = lab.dispatch(&task, "slow").await;
    for started in lab.ws.executor_slots_pass().await {
        started.await.unwrap();
    }
    until("the task is blocked", || lab.task_view(&task)["task"]["status"] == "blocked").await;
    let (state, reason, _, _) = lab.slot(&first);
    assert_eq!(state, "released");
    assert_eq!(reason.as_deref(), Some("its start did not finish within 1 s, the Workspace's limit; Core closed it"));
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_some());
    assert!(lab.task_view(&task)["task"]["blocker"].as_str().unwrap().contains("did not finish within"));
}

/// D4: an uncertain start keeps its slot as starting with why, the executor
/// open; Core neither closes nor rebuilds it, and mails the lead once.
#[tokio::test]
async fn an_uncertain_start_keeps_its_slot_open_and_mails_the_dispatcher_once() {
    let lab = Lab::new(missing).await;
    lab.occupy_the_slot();
    let task = lab.task("Review the uncertain one").await;
    let first = lab.dispatch(&task, "uncertain").await;
    lab.taken(&first, 1);
    let permit = lab.ws.admission.enter_work().unwrap();
    lab.ws.settle_start(&first, &permit, Failure::Uncertain("its start was not confirmed".into()), false).await.unwrap();
    assert_eq!(lab.slot(&first).0, "starting");
    assert_eq!(lab.slot(&first).1.as_deref(), Some("its start was not confirmed"));
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_none(), "open, for the user's Connect or Close");
    let rebuilds: i64 = lab.ws.store.db.read().unwrap().query_row("SELECT COUNT(*) FROM executor_rebuilds", [], |r| r.get(0)).unwrap();
    assert_eq!(rebuilds, 0, "no rebuild");
    let mail = lab.executor_mail();
    assert_eq!(mail.len(), 1, "one mail: {mail:?}");
    assert_eq!(mail[0]["metadata"]["status"], "uncertain");
    assert!(mail[0]["body"].as_str().unwrap().contains("may have started"), "{}", mail[0]["body"]);
    assert_eq!(lab.task_view(&task)["task"]["status"], "doing", "nothing is blocked");
}

/// R1 P3-2 stays: an executor the user reopened (attempt 2) whose start
/// fails stays open with its slot and the reason; nothing is rebuilt.
#[tokio::test]
async fn a_reopened_executor_whose_start_fails_is_not_rebuilt() {
    let lab = Lab::new(missing).await;
    lab.occupy_the_slot();
    let task = lab.task("Review the reopened one").await;
    let first = lab.dispatch(&task, "reopened").await;
    lab.taken(&first, 2);
    let permit = lab.ws.admission.enter_work().unwrap();
    lab.ws.settle_start(&first, &permit, Failure::Definite("the runtime refused it".into()), false).await.unwrap();
    assert_eq!(lab.slot(&first).0, "starting");
    assert_eq!(lab.slot(&first).1.as_deref(), Some("the runtime refused it"));
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_none());
    let rebuilds: i64 = lab.ws.store.db.read().unwrap().query_row("SELECT COUNT(*) FROM executor_rebuilds", [], |r| r.get(0)).unwrap();
    assert_eq!(rebuilds, 0, "a reopened executor is not rebuilt");
}

/// R1 P3-1: a starting executor no pass is starting, open and disconnected
/// after a start that failed (the user's own Connect won its gate), is
/// settled by the next pass as a definite failure with its error: closed,
/// its slot released with why, and rebuilt in its place.
#[tokio::test]
async fn a_pass_settles_a_start_that_ended_without_it() {
    let lab = Lab::new(missing).await;
    lab.occupy_the_slot();
    let task = lab.task("Review the raced one").await;
    let first = lab.dispatch(&task, "raced").await;
    lab.taken(&first, 1);
    lab.ws.store.update(&first, "runtime/error", &json!({}), |d| {
        d.agent.status = "error".into();
        d.agent.error = Some("the user's Connect failed".into());
    }).unwrap();
    for settled in lab.ws.executor_slots_pass().await {
        settled.await.unwrap();
    }
    until("its rebuild is made", || lab.ws.store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM executor_rebuilds WHERE state='done'", [], |r| r.get::<_, i64>(0)).unwrap() == 1).await;
    assert_eq!(lab.slot(&first).0, "released");
    assert_eq!(lab.slot(&first).1.as_deref(), Some("the user's Connect failed"));
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_some());
    // An executor a pass is still starting is not settled from outside.
    let task = lab.task("Review the one in flight").await;
    let other = lab.dispatch(&task, "in-flight").await;
    lab.taken(&other, 1);
    lab.ws.store.update(&other, "runtime/error", &json!({}), |d| d.agent.status = "error".into()).unwrap();
    lab.ws.executor_slots.in_flight.lock().unwrap().insert(other.clone());
    for settled in lab.ws.executor_slots_pass().await {
        settled.await.unwrap();
    }
    assert_eq!(lab.slot(&other).0, "starting", "one in flight is its pass's to settle");
}

/// A stop between the first executor's close and its rebuild's dispatch
/// leaves no executor working on the task: at the next start Core blocks it,
/// "Core restarted during the rebuild", and mails the lead.
#[tokio::test]
async fn a_rebuild_a_restart_cut_short_blocks_its_task() {
    let lab = Lab::new(missing).await;
    lab.occupy_the_slot();
    let task = lab.task("Review across a restart").await;
    let first = lab.dispatch(&task, "restart").await;
    let made = lab.ws.store.executor_made(&first).unwrap().unwrap();
    lab.ws.store.executor_rebuild_begin(&made, &first, "the runtime refused it").unwrap();
    lab.ws.store.recover_executor_rebuilds().unwrap();
    let view = lab.task_view(&task);
    assert_eq!(view["task"]["status"], "blocked");
    assert!(view["task"]["blocker"].as_str().unwrap().contains("Core restarted while it rebuilt"), "{}", view["task"]["blocker"]);
    let state: String = lab.ws.store.db.read().unwrap().query_row(
        "SELECT state FROM executor_rebuilds WHERE from_agent=?1", [&first], |r| r.get(0)).unwrap();
    assert_eq!(state, "failed");
    assert_eq!(lab.executor_mail().len(), 1, "the lead is told once");
}
