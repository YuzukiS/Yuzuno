//! T-14: the user's stop and start of a local managed service, against the
//! Store: the intent, its revision and receipt, the retained launch, and every
//! state in which a new run must not start. The host's snapshot of the inputs
//! is given here; control() reads it from the host helper.
use super::*;
use crate::services::NewService;

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    project: String,
}

/// A Project with a task in it (T-1) and an Agent.
fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let agent: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace",
        "model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
    .unwrap();
    ws.store.insert(&agent).unwrap();
    let project = ws.store.create_project("Portal", Default::default()).unwrap().id;
    ws.store
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Portal","status":"doing","projectId":project}))
        .unwrap();
    Lab { _dir: dir, ws, project }
}

async fn service(lab: &Lab, name: &str) -> String {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let new = NewService { name: name.into(), machine_id: "local".into(), port, path: "/".into() };
    lab.ws.register_service(&lab.project, new, json!({"kind":"user"}), None).await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The inputs as the host read them, unchanged since the source Job.
fn snap() -> Value {
    json!({"cwd":"/workspace","git":null,"files":[]})
}
fn machine() -> Value {
    json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}})
}
fn capability() -> Value {
    json!({"bootId":"boot"})
}

fn served(id: &str, service: &str) -> Submit {
    let mut submit: Submit = serde_json::from_value(json!({"requestId":id,"taskId":"T-1","agentId":"a","name":"Dev server",
        "cwd":"/workspace","argv":["/usr/bin/python3","-m","http.server"],"env":{"PATH":"/usr/bin:/bin","LAB_ONLY":"1"},
        "resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},"timeoutSeconds":3600,"guardGit":false,
        "service":{"serviceId":service,"healthPath":"/health"}}))
    .unwrap();
    submit.service_link = Some(Link { service_id: service.into(), health_path: Some("/health".into()) });
    submit
}

/// An Agent's ordinary job_submit(serviceId).
fn submit(s: &Store, id: &str, service: &str) -> Result<Value> {
    s.create_job(None, served(id, service), snap(), machine(), capability())
}

fn run(s: &Store, job: &Value) {
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":job["attempt"],"status":"running",
        "reason":"Running with verified cgroup limits","started":{"at":1792000000.0}}))
        .unwrap();
}
fn end(s: &Store, job: &Value, status: &str) {
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":job["attempt"],"status":status,
        "reason":"ended","exitCode":0}))
        .unwrap();
}
/// A Job record put in a state the worker would report.
fn force(s: &Store, job: &Value, status: &str, reserved: bool) {
    let db = s.db.write().unwrap();
    let mut value = store::get(&db, job["id"].as_str().unwrap()).unwrap();
    value["status"] = json!(status);
    value["reserved"] = json!(reserved);
    store::save(&db, &value).unwrap();
}
fn record(s: &Store, job: &Value) -> Value {
    store::get(&*s.db.read().unwrap(), job["id"].as_str().unwrap()).unwrap()
}

fn stop_request(id: &str, job: &Value, revision: i64) -> Request {
    serde_json::from_value(json!({"requestId":id,"expectedJobId":job["id"],"expectedIntentRevision":revision})).unwrap()
}
fn start_request(id: &str, job: &Value, revision: i64) -> Request {
    serde_json::from_value(json!({"requestId":id,"expectedJobId":job["id"],"expectedIntentRevision":revision,
        "sourceJobId":job["id"],"timeoutSeconds":7200}))
    .unwrap()
}
fn stop_now(s: &Store, service: &str, request: &Request) -> Result<Value> {
    request.validate("stop")?;
    stop(s, service, request)
}
/// control()'s start with the host's reading given: a receipt first, as there.
fn start_now(s: &Store, service: &str, request: &Request) -> Result<Value> {
    request.validate("start")?;
    if let Some(receipt) = previous(&*s.db.read().unwrap(), service, "start", request)? {
        return Ok(receipt);
    }
    match prepare(s, service, request)? {
        Prepared::Receipt(receipt) => Ok(receipt),
        Prepared::Start(input, original) => finish_start(s, service, request, input, &original, Ok(read(snap()))),
    }
}
/// The host's reading, as control() gives it to finish_start.
fn read(snapshot: Value) -> (Value, Value, Value) {
    (snapshot, machine(), capability())
}
fn jobs(s: &Store) -> i64 {
    s.db.read().unwrap().query_row("SELECT COUNT(*) FROM local_jobs", [], |r| r.get(0)).unwrap()
}
/// A start's submission, where the test expects one to be made.
fn prepared(s: &Store, service: &str, request: &Request) -> (Submit, Current) {
    match prepare(s, service, request).unwrap() {
        Prepared::Start(input, original) => (input, original),
        Prepared::Receipt(receipt) => panic!("expected a start to prepare, got the receipt {receipt}"),
    }
}

async fn listed(lab: &Lab, id: &str) -> Value {
    lab.ws.project_services(&lab.project).await.unwrap()["services"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap()
        .clone()
}
fn links(s: &Store, service: &str) -> i64 {
    s.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM project_service_jobs WHERE service_id=?1", [service], |r| r.get(0))
        .unwrap()
}
fn error(result: Result<Value>) -> String {
    format!("{:#}", result.unwrap_err())
}

#[tokio::test]
async fn stop_keeps_the_users_choice_with_one_receipt_and_survives_a_core_restart() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let job = submit(s, "j1", &id).unwrap();
    run(s, &job);

    let request = stop_request("stop-1", &job, 0);
    let receipt = stop_now(s, &id, &request).unwrap();
    assert_eq!(receipt["action"], "stop");
    assert_eq!(receipt["jobId"], job["id"]);
    assert_eq!(receipt["status"], "cancelling", "a cancel request, not proof of exit");
    let intent = &receipt["intent"];
    assert_eq!(
        (intent["revision"].as_i64(), intent["desiredState"].as_str(), intent["recoveryMode"].as_str()),
        (Some(1), Some("stopped"), Some("manual"))
    );
    assert_eq!(intent["requestedBy"], json!({"kind":"user"}));
    assert_eq!(intent["appliesToJobId"], job["id"]);
    assert_eq!(record(s, &job)["status"], "cancelling");

    // The same request again: the same receipt, nothing more done.
    assert_eq!(stop_now(s, &id, &request).unwrap(), receipt);
    // The same requestId for another payload: refused, and it says so.
    let other = stop_request("stop-1", &job, 1);
    assert!(error(stop_now(s, &id, &other)).starts_with("service_control_conflict"));
    // A new request from the old reading: stale, no second intent.
    assert!(error(stop_now(s, &id, &stop_request("stop-2", &job, 0))).starts_with("stale_service_state"));

    // The intent and the receipt outlast Core: a new Workspace on the same data.
    let data = lab._dir.path().join("data");
    drop(lab.ws);
    let ws = Workspace::new(data, "/tmp".into(), "unused".into()).unwrap();
    let again = Lab { _dir: lab._dir, ws, project: lab.project };
    let view = listed(&again, &id).await;
    assert_eq!(view["lifecycle"]["intent"]["desiredState"], "stopped");
    assert_eq!(view["lifecycle"]["intent"]["revision"], 1);
    assert_eq!(stop_now(&again.ws.store, &id, &request).unwrap(), receipt, "the receipt is durable");
}

#[tokio::test]
async fn a_refused_stop_changes_nothing() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let job = submit(s, "j1", &id).unwrap();
    run(s, &job);
    let wrong: Value = json!({"id":"not-the-job"});
    assert!(error(stop_now(s, &id, &stop_request("stop-x", &wrong, 0))).starts_with("stale_service_state"));
    assert_eq!(record(s, &job)["status"], "running", "not cancelled");
    let view = listed(&lab, &id).await;
    assert_eq!(view["lifecycle"]["intent"]["revision"], 0);
    assert_eq!(view["lifecycle"]["intent"]["desiredState"], "unspecified");
    let receipts: i64 = s.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM collaboration_requests WHERE operation='service_stop'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(receipts, 0);
}

#[tokio::test]
async fn an_ordinary_submit_cannot_clear_the_users_stop() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let job = submit(s, "j1", &id).unwrap();
    // Stopped while still queued: the ordinary Jobs cancellation.
    let receipt = stop_now(s, &id, &stop_request("stop-1", &job, 0)).unwrap();
    assert_eq!(receipt["status"], "cancelled");
    assert!(error(submit(s, "j2", &id)).starts_with("service_stopped"));
    assert_eq!(links(s, &id), 1, "nothing linked by the refused submit");
    assert_eq!(listed(&lab, &id).await["lifecycle"]["intent"]["desiredState"], "stopped");
}

#[tokio::test]
async fn start_makes_one_run_from_the_retained_launch_and_its_retry_is_the_same_start() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    stop_now(s, &id, &stop_request("stop-1", &first, 0)).unwrap();
    end(s, &first, "cancelled");
    let view = listed(&lab, &id).await;
    assert_eq!(view["lifecycle"]["canStart"], true, "{view}");

    let request = start_request("start-1", &first, 1);
    let receipt = start_now(s, &id, &request).unwrap();
    assert_eq!(receipt["action"], "start");
    assert_ne!(receipt["jobId"], first["id"]);
    assert_eq!(receipt["intent"]["desiredState"], "running");
    assert_eq!(receipt["intent"]["revision"], 2);
    assert_eq!(receipt["intent"]["sourceJobId"], first["id"]);
    // Nothing of the launch in the receipt.
    for key in ["argv", "env", "cwd", "snapshot"] {
        assert!(receipt.get(key).is_none() && receipt["intent"].get(key).is_none(), "{key} in {receipt}");
    }
    // The new run is the retained launch, with the timeout the user chose.
    let second = record(s, &json!({"id": receipt["jobId"]}));
    for key in ["argv", "env", "cwd", "name", "resources", "taskId", "agentId"] {
        assert_eq!(second[key], record(s, &first)[key], "{key}");
    }
    assert_eq!(second["timeoutSeconds"], 7200);
    let view = listed(&lab, &id).await;
    assert_eq!(view["job"]["jobId"], receipt["jobId"]);
    assert_eq!(view["job"]["earlierJobIds"], json!([first["id"]]));
    assert!(view["job"].get("argv").is_none() && view["lifecycle"].get("argv").is_none());

    // Retried: the same receipt, still one new run.
    assert_eq!(start_now(s, &id, &request).unwrap(), receipt);
    assert_eq!(links(s, &id), 2);
    let mut other = request.clone();
    other.timeout_seconds = Some(3600);
    assert!(error(start_now(s, &id, &other)).starts_with("service_control_conflict"));
    // An Agent's submit now meets the new run, not the user's stop.
    assert!(error(submit(s, "j3", &id)).contains("still served by Job"));
}

#[tokio::test]
async fn no_start_while_the_run_may_still_serve_or_its_record_is_gone() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let job = submit(s, "j1", &id).unwrap();
    let blocked = |lab: &Lab, n: &str| {
        let request = start_request(n, &job, 0);
        error(start_now(&lab.ws.store, &id, &request))
    };
    // Queued, running, cancelling, unknown with its reservation, ended but still reserved.
    assert!(blocked(&lab, "s-queued").starts_with("service_busy"));
    run(s, &job);
    assert!(blocked(&lab, "s-running").starts_with("service_busy"));
    s.request_job_cancel(None, job["id"].as_str().unwrap()).unwrap();
    assert!(blocked(&lab, "s-cancelling").starts_with("service_busy"));
    force(s, &job, "unknown", true);
    assert!(blocked(&lab, "s-unknown").starts_with("service_busy"));
    force(s, &job, "cancelled", true);
    assert!(blocked(&lab, "s-reserved").starts_with("service_busy"));
    let view = listed(&lab, &id).await;
    assert_eq!(view["lifecycle"]["canStart"], false);
    assert_eq!(view["lifecycle"]["startBlockedCode"], "service_busy");
    assert_eq!(links(s, &id), 1);

    // The linked Job's record is gone: unknown, never stopped or started from here.
    s.db.write().unwrap().execute("DELETE FROM local_jobs WHERE id=?1", [job["id"].as_str().unwrap()]).unwrap();
    assert!(blocked(&lab, "s-missing").starts_with("source_unavailable"));
    assert!(error(stop_now(s, &id, &stop_request("stop-missing", &job, 0))).starts_with("source_unavailable"));
    let view = listed(&lab, &id).await;
    assert_eq!(view["job"]["status"], "unknown");
    assert_eq!(view["job"]["canStop"], false);
    assert_eq!(view["lifecycle"]["canStart"], false);
    assert_eq!(view["lifecycle"]["startBlockedCode"], "source_unavailable");
    assert_eq!(view["lifecycle"]["intent"]["revision"], 0, "no intent recorded");
}

#[tokio::test]
async fn a_stop_from_an_earlier_reading_cannot_touch_the_new_run() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "failed");
    let receipt = start_now(s, &id, &start_request("start-1", &first, 0)).unwrap();
    let second = record(s, &json!({"id": receipt["jobId"]}));
    run(s, &second);
    // A stop prepared against the first run, or the old revision: refused.
    assert!(error(stop_now(s, &id, &stop_request("stop-old", &first, 1))).starts_with("stale_service_state"));
    assert!(error(stop_now(s, &id, &stop_request("stop-rev", &second, 0))).starts_with("stale_service_state"));
    assert_eq!(record(s, &second)["status"], "running");
}

#[tokio::test]
async fn a_later_stop_prevents_an_earlier_prepared_start() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let request = start_request("start-1", &first, 0);
    let (input, original) = prepared(s, &id, &request);
    // While the start reads the host, the user stops the service.
    stop_now(s, &id, &stop_request("stop-1", &first, 0)).unwrap();
    let refused = error(commit_start(s, &id, &request, input, &original, snap(), machine(), capability()));
    assert!(refused.starts_with("stale_service_state"), "{refused}");
    assert_eq!(links(s, &id), 1, "no run started");
    assert_eq!(listed(&lab, &id).await["lifecycle"]["intent"]["desiredState"], "stopped");
}

#[tokio::test]
async fn an_agents_submit_and_the_users_start_cannot_both_win() {
    let lab = lab();
    let s = &lab.ws.store;

    // The Agent's submit first: the prepared start is stale.
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let request = start_request("start-1", &first, 0);
    let (input, original) = prepared(s, &id, &request);
    let agents = submit(s, "j2", &id).unwrap();
    let refused = error(commit_start(s, &id, &request, input, &original, snap(), machine(), capability()));
    assert!(refused.starts_with("stale_service_state"), "{refused}");
    assert_eq!(listed(&lab, &id).await["job"]["jobId"], agents["id"]);
    assert_eq!(links(s, &id), 2);

    // The user's start first, in a lab of its own (the Agent's Job above
    // would take the next reservation): the Agent's submit meets the new run.
    let lab = self::lab();
    let s = &lab.ws.store;
    let other = service(&lab, "Docs").await;
    let first = submit(s, "k1", &other).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let receipt = start_now(s, &other, &start_request("start-2", &first, 0)).unwrap();
    let refused = error(submit(s, "k2", &other));
    assert!(refused.contains("still served by Job") && refused.contains(receipt["jobId"].as_str().unwrap()), "{refused}");
    assert_eq!(links(s, &other), 2);
}

#[tokio::test]
async fn two_starts_from_one_reading_make_one_run() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    // Two different requests prepared from the same reading: the second is stale.
    let one = start_request("start-1", &first, 0);
    let two = start_request("start-2", &first, 0);
    let (a, a_source) = prepared(s, &id, &one);
    let (b, b_source) = prepared(s, &id, &two);
    let receipt = commit_start(s, &id, &one, a, &a_source, snap(), machine(), capability()).unwrap();
    assert!(error(commit_start(s, &id, &two, b, &b_source, snap(), machine(), capability())).starts_with("stale_service_state"));
    assert_eq!(start_now(s, &id, &one).unwrap(), receipt, "its retry is its receipt");
    assert_eq!(links(s, &id), 2);
}

#[tokio::test]
async fn one_request_prepared_twice_makes_one_run() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    // A lost reply retried while the first attempt still runs: both prepared.
    let request = start_request("start-1", &first, 0);
    let (a, a_source) = prepared(s, &id, &request);
    let (b, b_source) = prepared(s, &id, &request);
    let receipt = commit_start(s, &id, &request, a, &a_source, snap(), machine(), capability()).unwrap();
    assert_eq!(commit_start(s, &id, &request, b, &b_source, snap(), machine(), capability()).unwrap(), receipt);
    assert_eq!(links(s, &id), 2);
}

#[tokio::test]
async fn a_retry_that_reads_after_its_original_committed_gets_the_receipt_not_stale() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let request = start_request("start-1", &first, 0);
    // control() looked for a receipt before the original committed, and
    // prepares after: the revision has moved, the receipt is there.
    let (input, original) = prepared(s, &id, &request);
    let receipt = commit_start(s, &id, &request, input, &original, snap(), machine(), capability()).unwrap();
    match prepare(s, &id, &request).unwrap() {
        Prepared::Receipt(again) => assert_eq!(again, receipt),
        Prepared::Start(..) => panic!("a retry of a committed start prepared another"),
    }
    assert_eq!(links(s, &id), 2);
}

#[tokio::test]
async fn a_retry_prepared_with_its_original_gets_its_receipt_whatever_it_reads_after() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    // A lost reply retried while the first attempt still runs: three
    // attempts of one request, all prepared before any committed.
    let request = start_request("start-1", &first, 0);
    let (a, a_source) = prepared(s, &id, &request);
    let (b, b_source) = prepared(s, &id, &request);
    let (c, c_source) = prepared(s, &id, &request);
    let receipt = finish_start(s, &id, &request, a, &a_source, Ok(read(snap()))).unwrap();
    // The run it started has since changed a guarded input, or the host can
    // no longer read them: either way, this request's start was made.
    let changed = json!({"cwd":"/workspace","git":{"head":"other"},"files":[]});
    assert_eq!(finish_start(s, &id, &request, b, &b_source, Ok(read(changed))).unwrap(), receipt);
    let unreadable = Err(anyhow::anyhow!("source_unavailable: the original working directory or guarded inputs cannot be read; no Job was created"));
    assert_eq!(finish_start(s, &id, &request, c, &c_source, unreadable).unwrap(), receipt);
    assert_eq!((jobs(s), links(s, &id)), (2, 2), "one new run only");
}

#[tokio::test]
async fn a_start_whose_inputs_changed_or_cannot_be_read_is_refused_and_makes_nothing() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let request = start_request("start-1", &first, 0);
    let (a, a_source) = prepared(s, &id, &request);
    let changed = json!({"cwd":"/workspace","git":{"head":"other"},"files":[]});
    let refused = error(finish_start(s, &id, &request, a, &a_source, Ok(read(changed))));
    assert!(refused.starts_with("guarded_inputs_changed"), "{refused}");
    let (b, b_source) = prepared(s, &id, &request);
    let unreadable = Err(anyhow::anyhow!("source_unavailable: the original working directory or guarded inputs cannot be read; no Job was created"));
    assert!(error(finish_start(s, &id, &request, b, &b_source, unreadable)).starts_with("source_unavailable"));
    // Nothing was recorded for the request: its retry may still start.
    assert_eq!((jobs(s), links(s, &id)), (1, 1));
    assert_eq!(listed(&lab, &id).await["lifecycle"]["intent"]["revision"], 0);
    let (c, c_source) = prepared(s, &id, &request);
    finish_start(s, &id, &request, c, &c_source, Ok(read(snap()))).unwrap();
    assert_eq!((jobs(s), links(s, &id)), (2, 2));
}

#[tokio::test]
async fn changed_or_incomplete_sources_are_refused_and_nothing_starts() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let request = start_request("start-1", &first, 0);

    // The guarded inputs changed since the source Job.
    let (input, original) = prepared(s, &id, &request);
    let changed = json!({"cwd":"/workspace","git":{"head":"other"},"files":[]});
    let refused = error(commit_start(s, &id, &request, input, &original, changed, machine(), capability()));
    assert!(refused.starts_with("guarded_inputs_changed"), "{refused}");

    // A source without the input snapshot of its time (an older record).
    let mut old = record(s, &first);
    old["snapshot"] = json!({"cwd":"/workspace"});
    store::save(&*s.db.write().unwrap(), &old).unwrap();
    assert!(error(start_now(s, &id, &start_request("start-2", &first, 0))).starts_with("source_unavailable"));

    // A checkpointed source: its settings are not silently dropped.
    let mut checkpointed = record(s, &first);
    checkpointed["snapshot"] = snap();
    checkpointed["checkpoint"] = json!({"graceSeconds":30,"stoppedExitCode":75});
    store::save(&*s.db.write().unwrap(), &checkpointed).unwrap();
    assert!(error(start_now(s, &id, &start_request("start-3", &first, 0))).starts_with("source_unavailable"));

    // The source task archived.
    let mut plain = record(s, &first);
    plain["checkpoint"] = Value::Null;
    store::save(&*s.db.write().unwrap(), &plain).unwrap();
    {
        // The task's own key, as the Job keeps it (T-1 is its reference).
        let key = record(s, &first)["taskId"].as_str().unwrap().to_owned();
        let db = s.db.write().unwrap();
        let raw: String = db.query_row("SELECT data FROM collaboration_tasks WHERE id=?1", [&key], |r| r.get(0)).unwrap();
        let mut task: Value = serde_json::from_str(&raw).unwrap();
        task["archivedAt"] = json!("2026-10-31T00:00:00Z");
        db.execute("UPDATE collaboration_tasks SET data=?1 WHERE id=?2", [task.to_string(), key]).unwrap();
    }
    assert!(error(start_now(s, &id, &start_request("start-4", &first, 0))).starts_with("source_unavailable"));
    assert_eq!(links(s, &id), 1);
    assert_eq!(listed(&lab, &id).await["lifecycle"]["canStart"], false);
}

#[tokio::test]
async fn a_guard_goes_only_with_the_submission_it_was_made_for() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let other = service(&lab, "Docs").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let request = start_request("start-1", &first, 0);
    let guard = |input: &Submit, original: &Current| StartGuard {
        service_id: id.clone(),
        request: request.clone(),
        source: source_identity(original),
        health_path: original.link.health_path.clone(),
        prepared: input.as_requested().unwrap(),
    };

    // Another command after the guard was made.
    let (mut input, original) = prepared(s, &id, &request);
    input.service_control = Some(guard(&input, &original));
    input.argv = vec!["/bin/false".into()];
    let refused = error(s.create_job(None, input, snap(), machine(), capability()));
    assert!(refused.contains("prepared launch is not the one checked"), "{refused}");

    // Another service's link.
    let (mut input, original) = prepared(s, &id, &request);
    input.service_control = Some(guard(&input, &original));
    input.service_link = Some(Link { service_id: other.clone(), health_path: Some("/health".into()) });
    let refused = error(s.create_job(None, input, snap(), machine(), capability()));
    assert!(refused.contains("prepared launch is not the one checked"), "{refused}");

    // An Agent cannot carry a guard into create_job.
    let (mut input, original) = prepared(s, &id, &request);
    input.service_control = Some(guard(&input, &original));
    let refused = error(s.create_job(Some("a"), input, snap(), machine(), capability()));
    assert!(refused.starts_with("service_control_forbidden"), "{refused}");
    assert_eq!(links(s, &id), 1);
    assert_eq!(links(s, &other), 0);
}

#[tokio::test]
async fn the_controls_are_the_users_and_take_no_launch_settings() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let job = submit(s, "j1", &id).unwrap();
    // An Agent: refused before anything is read.
    let refused = control(lab.ws.clone(), Some("a".into()), id.clone(), "stop".into(), stop_request("stop-1", &job, 0)).await;
    assert!(format!("{:#}", refused.unwrap_err()).starts_with("service_control_forbidden"));
    // The browser cannot send a command, environment or directory.
    for extra in [json!({"env":{"X":"1"}}), json!({"argv":["sh"]}), json!({"cwd":"/"})] {
        let mut body = json!({"requestId":"r","expectedJobId":job["id"],"expectedIntentRevision":0,"sourceJobId":job["id"],"timeoutSeconds":60});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(serde_json::from_value::<Request>(body).is_err());
    }
    // Nor can a job_submit name the internal guard.
    let mut body = serde_json::to_value(served("x", &id)).unwrap();
    body["serviceControl"] = json!({"serviceId": id});
    assert!(serde_json::from_value::<Submit>(body).is_err());
    // Stop takes no launch settings; start needs its source and a bounded timeout.
    let mut stop = stop_request("stop-2", &job, 0);
    stop.timeout_seconds = Some(60);
    assert!(error_of(stop.validate("stop")).starts_with("invalid_input"));
    let mut start = start_request("start-1", &job, 0);
    start.source_job_id = Some("another".into());
    assert!(error_of(start.validate("start")).starts_with("invalid_input"));
    let mut start = start_request("start-2", &job, 0);
    start.timeout_seconds = Some(604801);
    assert!(error_of(start.validate("start")).starts_with("invalid_input"));
}

#[tokio::test]
async fn external_and_older_services_get_no_new_controls_or_choices() {
    let lab = lab();
    let s = &lab.ws.store;
    let external = service(&lab, "Jupyter").await;
    let view = listed(&lab, &external).await;
    assert_eq!(view["job"], Value::Null);
    assert_eq!(view["lifecycle"], Value::Null);

    // A service linked before intents existed: no choice is read into it.
    let id = service(&lab, "Vite").await;
    let job = submit(s, "j1", &id).unwrap();
    run(s, &job);
    end(s, &job, "cancelled");
    let view = listed(&lab, &id).await;
    assert_eq!(view["lifecycle"]["intent"]["desiredState"], "unspecified", "a cancelled Job alone is not the user's stop");
    assert_eq!(view["lifecycle"]["intent"]["recoveryMode"], "manual");
    assert_eq!(view["lifecycle"]["intent"]["revision"], 0);
    // And an ordinary submit still serves it anew.
    submit(s, "j2", &id).unwrap();
}

fn error_of(result: Result<()>) -> String {
    format!("{:#}", result.unwrap_err())
}
