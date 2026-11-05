use super::*;
use crate::{model::AgentDetail, store::Store};
use rusqlite::{params, OptionalExtension};
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

    /// Only the passes the test runs: a dispatch spawns none, so none races
    /// the test's own for a start or a rebuild.
    fn quiet(&self) {
        self.ws.executor_slots.quiet.store(true, std::sync::atomic::Ordering::Relaxed);
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

/// What Core says when a Codex start is refused for want of the program.
const REFUSED: &str = "Could not start Codex";

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
    assert!(reason.as_deref().is_some_and(|r| r.starts_with(REFUSED)), "released with its own reason, not \"closed\": {reason:?}");
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_some(), "the first is closed, and kept");
    let second: String = lab.ws.store.db.read().unwrap().query_row(
        "SELECT to_agent FROM executor_rebuilds WHERE from_agent=?1 AND state='done'", [&first], |r| r.get(0))
        .optional().unwrap().expect("the first failure is rebuilt once");
    assert_ne!(second, first);
    let (state, _, kept_seq, rebuilt_from) = lab.slot(&second);
    assert_eq!((state.as_str(), kept_seq, rebuilt_from.as_deref()), ("released", seq, Some(first.as_str())),
        "the rebuilt one kept the first's place, and says what it replaced");
    assert!(lab.ws.store.agent(&second).unwrap().closed_at.is_some(), "the second is closed, and kept");
    assert_eq!(lab.ws.store.agents().unwrap().iter().filter(|a| a.kind.as_deref() == Some("executor")).count(), 2, "one rebuild only");

    let view = lab.task_view(&task);
    let blocker = view["task"]["blocker"].as_str().unwrap();
    assert!(blocker.starts_with("Its executor did not start, nor the one Core rebuilt for it."), "{blocker}");
    assert_eq!(blocker.matches(REFUSED).count(), 2, "both reasons: {blocker}");
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
    assert!(fixed["supersededBy"]["reason"].as_str().unwrap().contains(REFUSED), "with why: {}", fixed["supersededBy"]);
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
    assert_eq!(lab.slot(&first).0, "starting", "an uncertain start keeps its slot");
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
    assert_eq!(lab.slot(&first).0, "starting", "a reopened executor keeps its slot, open");
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

/// The pending record of a settling start, as Core leaves it when it stops
/// at one point of the settling.
fn settling_as_left(lab: &Lab, agent: &str) {
    let made = lab.ws.store.executor_made(agent).unwrap().unwrap();
    lab.ws.store.executor_rebuild_begin(&made, agent, "the runtime refused it").unwrap();
}

fn rebuild_state(lab: &Lab, from: &str) -> Option<(String, Option<String>)> {
    lab.ws.store.db.read().unwrap().query_row(
        "SELECT state, to_agent FROM executor_rebuilds WHERE from_agent=?1", [from], |r| Ok((r.get(0)?, r.get(1)?))).optional().unwrap()
}

/// What Core does at its next start, after the dispatches and before the
/// slots (workspace.rs).
fn restart(lab: &Lab) {
    lab.ws.store.recover_executor_dispatches().unwrap();
    lab.ws.store.recover_executor_rebuilds().unwrap();
    lab.ws.store.recover_executor_slots().unwrap();
}

/// R1 dde34160 P2-1: a failed start's record is written before its executor
/// is closed, so no stop can leave the task on a closed executor with nothing
/// to finish. A test trigger notes, as each close releases a slot, whether
/// that executor's record was there.
#[tokio::test]
async fn a_failed_start_is_recorded_before_its_executor_is_closed() {
    let lab = Lab::new(missing).await;
    lab.ws.store.db.write().unwrap().execute_batch(
        "CREATE TABLE closes_saw(agent_id TEXT, recorded INTEGER);
         CREATE TRIGGER closes_saw AFTER UPDATE OF state ON executor_slots WHEN NEW.state='released' AND OLD.state!='released'
         BEGIN INSERT INTO closes_saw VALUES(NEW.agent_id, (SELECT COUNT(*) FROM executor_rebuilds WHERE from_agent=NEW.agent_id)); END;").unwrap();
    let task = lab.task("Review the recorded one").await;
    let first = lab.dispatch(&task, "recorded").await;
    for started in lab.ws.executor_slots_pass().await {
        started.await.unwrap();
    }
    until("the task is blocked", || lab.task_view(&task)["task"]["status"] == "blocked").await;
    let saw: Vec<(String, i64)> = lab.ws.store.db.read().unwrap().prepare("SELECT agent_id, recorded FROM closes_saw ORDER BY rowid").unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(saw.len(), 2, "the first and its rebuild were closed: {saw:?}");
    assert_eq!(saw[0], (first, 1), "recorded before its close released its slot");
    assert_eq!(saw[1].1, 1, "the rebuilt one too: {saw:?}");
}

/// R1 dde34160 P2-1, at the next start: Core stopped while a failed start
/// settled. Before the close, the record goes and the start waits again.
/// After the close, before the rebuild's dispatch began, the first pass makes
/// the rebuild. While that dispatch was being made, the task is blocked,
/// "Core restarted while it rebuilt" it, and the lead is told once.
#[tokio::test]
async fn a_stop_while_a_failed_start_settles_is_finished_at_the_next_start() {
    let lab = Lab::new(missing).await;
    lab.quiet();
    lab.occupy_the_slot();
    // Stopped before the close.
    let task = lab.task("Review across a stop before the close").await;
    let open = lab.dispatch(&task, "before-close").await;
    lab.taken(&open, 1);
    settling_as_left(&lab, &open);
    // Stopped after the close, before the rebuild's dispatch.
    let task = lab.task("Review across a stop after the close").await;
    let closed = lab.dispatch(&task, "after-close").await;
    let seq = lab.slot(&closed).2;
    settling_as_left(&lab, &closed);
    lab.ws.close_agent(&closed).await.unwrap();
    // Stopped while the rebuild's dispatch was being made.
    let cut = lab.task("Review across a stop in the rebuild").await;
    let made = lab.dispatch(&cut, "in-rebuild").await;
    settling_as_left(&lab, &made);
    lab.ws.close_agent(&made).await.unwrap();
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO executor_dispatches(actor,request_id,input_json,task_id,template_id,project_id,machine_id,template_json,agent_id,state,created_at,updated_at)
         VALUES('agent:lead',?1,'{}',?2,'reviewer',?3,'local','{}','half-made','pending','now','now')",
        params![rebuild_request(&made), cut, lab.project]).unwrap();

    restart(&lab);
    assert_eq!(rebuild_state(&lab, &open), None, "before the close: the record goes");
    assert_eq!(lab.slot(&open).0, "waiting", "and its start waits again, to be settled anew");
    assert_eq!(rebuild_state(&lab, &closed).map(|r| r.0).as_deref(), Some("pending"), "after the close: left for a pass");
    let view = lab.task_view(&cut);
    assert_eq!(view["task"]["status"], "blocked", "a rebuild cut short blocks its task");
    assert!(view["task"]["blocker"].as_str().unwrap().contains("Core restarted while it rebuilt"), "{}", view["task"]["blocker"]);
    assert_eq!(rebuild_state(&lab, &made).map(|r| r.0).as_deref(), Some("failed"));
    assert_eq!(lab.executor_mail().len(), 1, "the lead is told once");

    for started in lab.ws.executor_slots_pass().await {
        started.await.unwrap();
    }
    let (state, to) = rebuild_state(&lab, &closed).unwrap();
    assert_eq!(state, "done", "the first pass makes the rebuild Core stopped before");
    let second = to.unwrap();
    assert_eq!((lab.slot(&second).0.as_str(), lab.slot(&second).2), ("waiting", seq), "in the first's place");
    assert_eq!(lab.task_view(&task)["task"]["status"], "doing");
}

/// R1 dde34160 P2-2: a rebuild is known as one, in the first's place in the
/// queue, once its own dispatch commits: before any pass can start it, so a
/// rebuilt executor that fails at once is blocked, never rebuilt again.
#[tokio::test]
async fn a_rebuild_is_known_in_its_place_once_its_own_dispatch_commits() {
    let lab = Lab::new(missing).await;
    lab.quiet();
    lab.occupy_the_slot();
    let task = lab.task("Review the rebuilt one").await;
    let first = lab.dispatch(&task, "first").await;
    let seq = lab.slot(&first).2;
    settling_as_left(&lab, &first);
    lab.ws.close_agent(&first).await.unwrap();
    let made = lab.ws.store.executor_made(&first).unwrap().unwrap();
    let mut input = made.input.clone();
    input["requestId"] = json!(rebuild_request(&first));
    input["expectedVersion"] = lab.task_view(&task)["task"]["version"].clone();
    let second = lab.ws.executor_dispatch(Some("lead"), input).await.unwrap()["agentId"].as_str().unwrap().to_owned();
    // Nothing but that dispatch has run: its own transaction wrote these.
    assert_eq!(lab.ws.store.executor_rebuilt_from(&second).unwrap(), Some((first.clone(), "the runtime refused it".into())),
        "known as a rebuild once its dispatch commits");
    let (state, _, kept, from) = lab.slot(&second);
    assert_eq!((state.as_str(), kept, from.as_deref()), ("waiting", seq, Some(first.as_str())), "in the first's place, before any pass");
}

/// R1 dde34160 P2-3: a rebuild an update's drain refuses is waited out: no
/// block and no mail; it stays pending through the drain, and the first pass
/// after it makes the rebuild.
#[tokio::test]
async fn a_rebuild_an_update_drain_refuses_waits_and_a_later_pass_makes_it() {
    let lab = Lab::new(missing).await;
    lab.quiet();
    lab.occupy_the_slot();
    let task = lab.task("Review during an update").await;
    let first = lab.dispatch(&task, "drained").await;
    let seq = lab.slot(&first).2;
    lab.taken(&first, 1);
    let permit = lab.ws.admission.enter_work().unwrap();
    lab.ws.admission.begin_drain("t35-drain").unwrap();
    lab.ws.settle_start(&first, &permit, Failure::Definite("the runtime refused it".into()), false).await.unwrap();
    drop(permit);
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_some(), "closed, as any definite failure");
    assert_eq!(lab.task_view(&task)["task"]["status"], "doing", "a drain is waited out, not a block");
    assert_eq!(lab.executor_mail().len(), 0, "and no mail");
    assert!(lab.ws.executor_slots_pass().await.is_empty(), "no pass works while it drains");
    assert_eq!(rebuild_state(&lab, &first).map(|r| r.0).as_deref(), Some("pending"));
    lab.ws.admission.reopen("t35-drain").unwrap();
    for started in lab.ws.executor_slots_pass().await {
        started.await.unwrap();
    }
    let (state, to) = rebuild_state(&lab, &first).unwrap();
    assert_eq!(state, "done", "the pass after the drain makes the rebuild");
    assert_eq!(lab.slot(&to.unwrap()).2, seq);
    assert_eq!(lab.task_view(&task)["task"]["status"], "doing");
}

/// R1 dde34160 P3: two passes that meet one ended start settle it once. A
/// test meeting point holds each pass, once it has read the Agent, until the
/// other is there too (or a second goes by).
#[tokio::test]
async fn two_passes_settle_an_ended_start_once() {
    let lab = Lab::new(missing).await;
    lab.quiet();
    lab.occupy_the_slot();
    let task = lab.task("Review the one two passes see").await;
    let first = lab.dispatch(&task, "twice").await;
    lab.taken(&first, 1);
    lab.ws.store.update(&first, "runtime/error", &json!({}), |d| {
        d.agent.status = "error".into();
        d.agent.error = Some("the user's Connect failed".into());
    }).unwrap();
    *lab.ws.executor_slots.settle_meet.lock().unwrap() = Some(Arc::new(tokio::sync::Barrier::new(2)));
    let (one, other) = tokio::join!(lab.ws.executor_slots_pass(), lab.ws.executor_slots_pass());
    assert_eq!(one.len() + other.len(), 1, "two passes settle an ended start once");
    for settled in one.into_iter().chain(other) {
        settled.await.unwrap();
    }
    assert_eq!(rebuild_state(&lab, &first).map(|r| r.0).as_deref(), Some("done"));
    assert_eq!(lab.ws.store.agents().unwrap().iter().filter(|a| a.kind.as_deref() == Some("executor")).count(), 2, "one rebuild");
}

/// R2 de2313b7 P3-1: an executor a pass has just taken is that pass's to
/// start: it joins the in-flight set before its row reads starting. A test
/// meeting point holds the pass right after its take while another pass
/// runs; that one settles nothing, though the executor, reopened, still
/// shows an earlier start's error.
#[tokio::test]
async fn a_pass_that_just_took_a_slot_keeps_its_start_from_other_passes() {
    let lab = Lab::new(missing).await;
    lab.quiet();
    let task = lab.task("Review the reopened one, taken again").await;
    let first = lab.dispatch(&task, "taken-again").await;
    lab.ws.store.db.write().unwrap().execute("UPDATE executor_slots SET attempt=2 WHERE agent_id=?1", [&first]).unwrap();
    lab.ws.store.update(&first, "runtime/error", &json!({}), |d| {
        d.agent.status = "error".into();
        d.agent.error = Some("an earlier start failed".into());
    }).unwrap();
    let meet = Arc::new(tokio::sync::Barrier::new(2));
    *lab.ws.executor_slots.take_meet.lock().unwrap() = Some(meet.clone());
    let ws = lab.ws.clone();
    let taking = tokio::spawn(async move { ws.executor_slots_pass().await });
    until("the pass took its slot", || lab.slot(&first).0 == "starting").await;
    *lab.ws.executor_slots.take_meet.lock().unwrap() = None;
    let other = lab.ws.executor_slots_pass().await;
    assert!(other.is_empty(), "a pass in the gap settles nothing: it spawned {}", other.len());
    let _ = tokio::time::timeout(Duration::from_secs(5), meet.wait()).await;
    for started in taking.await.unwrap() {
        started.await.unwrap();
    }
    // Its own pass started it; that start failed too, and S1's rule keeps it open.
    assert_eq!(lab.slot(&first).0, "starting");
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_none());
}

/// R2 de2313b7 P3-2: S1's rule wins for a reopened executor (attempt 2)
/// whose start passes the time limit: Core neither closes nor rebuilds it;
/// it keeps its slot, with the cut-off reason, until the user closes it.
#[tokio::test]
async fn a_reopened_executor_cut_off_by_the_time_limit_stays_open() {
    let lab = Lab::new(silent).await;
    lab.quiet();
    *lab.ws.executor_slots.start_limit.lock().unwrap() = Some(Duration::from_secs(1));
    let task = lab.task("Review the reopened slow one").await;
    let first = lab.dispatch(&task, "reopened-slow").await;
    lab.ws.store.db.write().unwrap().execute("UPDATE executor_slots SET attempt=2 WHERE agent_id=?1", [&first]).unwrap();
    for started in lab.ws.executor_slots_pass().await {
        started.await.unwrap();
    }
    assert!(lab.ws.store.agent(&first).unwrap().closed_at.is_none(), "a reopened executor cut off by the limit stays open");
    let (state, reason, _, _) = lab.slot(&first);
    assert_eq!((state.as_str(), reason.as_deref()), ("starting", Some("its start did not finish within 1 s, the Workspace's limit")),
        "with its slot and why");
    assert_eq!(rebuild_state(&lab, &first), None, "and is not rebuilt");
    assert_eq!(lab.task_view(&task)["task"]["status"], "doing");
}
