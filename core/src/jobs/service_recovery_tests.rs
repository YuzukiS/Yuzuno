//! T-14 bounded recovery (design v3.4) against the Store: the user's opt-in,
//! which endings start a retry, the budget, delay and fixed end time, the
//! lineage, Stop and opt-out at each stage, a Core restart, and the queue.
//! The host's own end-time enforcement is checked in host_test.py and the
//! isolated acceptance.
use super::tests::*;
use super::*;

fn now_unix() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64 / 1000.0
}

fn start_bounded(id: &str, job: &Value, revision: i64) -> Request {
    serde_json::from_value(json!({"requestId":id,"expectedJobId":job["id"],"expectedIntentRevision":revision,
        "sourceJobId":job["id"],"timeoutSeconds":7200,"recovery":{"mode":"bounded"}}))
    .unwrap()
}
fn opt_out_request(id: &str, job: &Value, revision: i64) -> Request {
    serde_json::from_value(json!({"requestId":id,"expectedJobId":job["id"],"expectedIntentRevision":revision,"mode":"manual"}))
        .unwrap()
}
fn opt_out_now(s: &Store, service: &str, request: &Request) -> Result<Value> {
    request.validate("recovery")?;
    opt_out(s, service, request)
}

/// A service whose user run has automatic retry on: its first Job (an
/// Agent's) ended, then the user's start. Returns the service and that run.
async fn armed(lab: &Lab) -> (String, Value) {
    let s = &lab.ws.store;
    let id = service(lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let receipt = start_now(s, &id, &start_bounded("start-1", &first, 0)).unwrap();
    (id, record(s, &json!({"id":receipt["jobId"]})))
}

/// Make a queued Job's delay pass, as time would.
fn due(s: &Store, job: &Value) {
    let db = s.db.write().unwrap();
    let mut value = store::get(&db, job["id"].as_str().unwrap()).unwrap();
    value["notBeforeUnix"] = json!(0);
    store::save(&db, &value).unwrap();
}
/// Reserve this queued Job and record it running now.
fn launch(s: &Store, job: &Value) -> Value {
    due(s, job);
    let reserved = s.reserve_next_job(None, None, None).unwrap().expect("a Job to reserve");
    assert_eq!(reserved["id"], job["id"]);
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":reserved["attempt"],
        "status":"running","reason":"Running","started":{"at":now_unix()}}))
        .unwrap();
    record(s, job)
}
/// The Job's process ended with this systemd Result and main status.
fn ended(s: &Store, job: &Value, status: &str, result: &str, code: &str) {
    let attempt = record(s, job)["attempt"].clone();
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":attempt,"status":status,
        "reason":result,"evidence":{"systemd":{"Result":result,"ExecMainStatus":code}}}))
        .unwrap();
}
fn crash(s: &Store, job: &Value) {
    ended(s, job, "failed", "exit-code", "1");
}
fn intent_of(s: &Store, service: &str) -> Value {
    intent(&*s.db.read().unwrap(), service).unwrap()
}
fn put_intent(s: &Store, service: &str, value: &Value) {
    write_intent(&*s.db.write().unwrap(), service, value).unwrap();
}
/// The service's current Job.
fn latest(s: &Store, service: &str) -> Value {
    current(&*s.db.read().unwrap(), service).unwrap().job
}
async fn recovery(lab: &Lab, id: &str) -> Value {
    listed(lab, id).await["lifecycle"]["recovery"].clone()
}

#[tokio::test]
async fn by_default_a_crash_is_never_retried() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite").await;
    let first = submit(s, "j1", &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let receipt = start_now(s, &id, &start_request("start-1", &first, 0)).unwrap();
    let user = record(s, &json!({"id":receipt["jobId"]}));
    assert_eq!(receipt["intent"]["recoveryMode"], "manual");
    let user = launch(s, &user);
    crash(s, &user);
    assert_eq!((jobs(s), links(s, &id)), (2, 2), "no retry");
    let view = listed(&lab, &id).await["lifecycle"]["recovery"].clone();
    assert_eq!((view["mode"].as_str(), view["state"].as_str()), (Some("manual"), Some("off")));
    assert_eq!((&view["retry"], &view["schedule"], &view["attempts"]),
        (&json!({"scheduled":0,"started":0,"max":0}), &json!([30,120,600]), &json!([])));
}

#[tokio::test]
async fn a_crash_queues_one_retry_after_its_delay_and_the_budget_ends_at_three() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let armed_intent = intent_of(s, &id);
    assert_eq!(armed_intent["recoveryMode"], "bounded");
    assert_eq!(armed_intent["recovery"]["generation"], armed_intent["revision"]);
    assert_eq!(armed_intent["recovery"]["rootJobId"], root["id"]);
    assert_eq!(recovery(&lab, &id).await["state"], "armed");

    let root = launch(s, &root);
    let fixed = intent_of(s, &id)["recovery"]["deadlineAtUnix"].as_f64().unwrap();
    let start = chrono::DateTime::parse_from_rfc3339(root["startedAt"].as_str().unwrap()).unwrap().timestamp_millis() as f64 / 1000.0;
    assert!((fixed - (start + 7200.0)).abs() < 0.01, "the end time is the run's start plus its chosen lifetime");

    let mut previous = root.clone();
    let outcomes = [("exit-code", "1", "exit:1"), ("signal", "9", "signal:SIGKILL"), ("core-dump", "11", "core_dump")];
    for (k, (result, code, _)) in outcomes.iter().enumerate() {
        let k = k as i64 + 1;
        let before = now_unix();
        ended(s, &previous, "failed", result, code);
        let retry = latest(s, &id);
        assert_eq!(retry["recoveryOf"]["retry"], k);
        assert_eq!(retry["recoveryOf"]["rootJobId"], root["id"]);
        assert_eq!(retry["recoveryOf"]["generation"], armed_intent["revision"]);
        assert_eq!(retry["retryOf"], previous["id"]);
        assert_eq!(retry["status"], "queued");
        assert_eq!(retry["requestId"].as_str().unwrap(), format!("{}/retry/{k}", root["requestId"].as_str().unwrap()));
        assert_eq!(retry["deadlineAtUnix"].as_f64(), Some(fixed), "every retry shares the one end time");
        let delay = retry["notBeforeUnix"].as_f64().unwrap() - before;
        let want = SCHEDULE_FOR_TEST[(k - 1) as usize] as f64;
        assert!((want - 1.0..=want + 5.0).contains(&delay), "retry {k} waits {want} s, not {delay}");
        assert_eq!(record(s, &previous)["retriedBy"], retry["id"]);
        assert!(record(s, &previous)["reason"].as_str().unwrap().contains(&format!("Automatic retry {k} of 3")));
        let intent = intent_of(s, &id);
        assert_eq!(intent["revision"], armed_intent["revision"], "an automatic retry is not a user action");
        assert_eq!(intent["appliesToJobId"], retry["id"]);
        let view = recovery(&lab, &id).await;
        assert_eq!((view["state"].as_str(), view["launch"].as_str()), (Some("waiting"), Some("queued")));
        assert_eq!(view["retry"]["scheduled"], k);
        assert!(view["notBefore"].is_string());
        // Not due yet: the queue leaves it out.
        assert!(s.reserve_next_job(None, None, None).unwrap().is_none(), "retry {k} waits for its delay");
        previous = launch(s, &retry);
        let view = recovery(&lab, &id).await;
        assert_eq!((view["state"].as_str(), view["launch"].as_str()), (Some("retry"), Some("running")));
        assert_eq!(view["retry"]["started"], k);
    }
    ended(s, &previous, "failed", "exit-code", "2");
    assert_eq!((jobs(s), links(s, &id)), (5, 5), "the first Job, the user's run and three retries");
    assert!(record(s, &previous)["reason"].as_str().unwrap().contains("Not retried automatically: all automatic retries"));
    let view = recovery(&lab, &id).await;
    assert_eq!((view["mode"].as_str(), view["state"].as_str()), (Some("manual"), Some("exhausted")));
    assert!(view["haltedReason"].is_null());
    assert_eq!(view["lastFailure"]["code"], 2);
    let outcomes: Vec<&str> = view["attempts"].as_array().unwrap().iter().map(|a| a["outcome"].as_str().unwrap()).collect();
    assert_eq!(outcomes, ["exit:1", "signal:SIGKILL", "core_dump", "exit:2"]);
    // A manual start with the box ticked opens a fresh period.
    let receipt = start_now(s, &id, &start_bounded("start-2", &previous, intent_of(s, &id)["revision"].as_i64().unwrap())).unwrap();
    assert_eq!(receipt["intent"]["recovery"]["scheduled"], 0);
    assert_eq!(recovery(&lab, &id).await["state"], "armed");
}

const SCHEDULE_FOR_TEST: [i64; 3] = [30, 120, 600];

#[tokio::test]
async fn one_crash_makes_at_most_one_retry_and_the_end_time_is_fixed_once() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let fixed = intent_of(s, &id)["recovery"]["deadlineAt"].clone();
    // Its end recorded with a later start (the worker's own clock): the end time stays.
    let attempt = record(s, &root)["attempt"].clone();
    s.update_job_evidence(root["id"].as_str().unwrap(), json!({"jobId":root["id"],"attempt":attempt,"status":"failed",
        "reason":"exit-code","started":{"at":now_unix() + 600.0},"evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"1"}}}))
        .unwrap();
    assert_eq!(intent_of(s, &id)["recovery"]["deadlineAt"], fixed);
    // Recorded again: nothing more (the Job is no longer reserved).
    crash(s, &root);
    // And the recovery step run again on it directly: still one.
    let mut again = record(s, &root);
    {
        let mut db = s.db.write().unwrap();
        let tx = db.transaction().unwrap();
        super::super::service_recovery::after_outcome(s, &tx, &mut again).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!((jobs(s), links(s, &id)), (3, 3), "one retry for one crash");
}

#[tokio::test]
async fn too_little_time_left_queues_or_starts_no_retry_and_a_retry_runs_only_to_the_end() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    // 50 s left: no retry.
    let mut value = intent_of(s, &id);
    value["recovery"]["deadlineAtUnix"] = json!(now_unix() + 50.0);
    put_intent(s, &id, &value);
    crash(s, &root);
    assert_eq!(jobs(s), 2);
    assert!(record(s, &root)["reason"].as_str().unwrap().contains("less than 60 s would remain"));
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("ended"), Some("insufficient_time")));

    // Enough at the crash, too little by the time it is reserved.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let mut value = intent_of(s, &id);
    value["recovery"]["deadlineAtUnix"] = json!(now_unix() + 500.0);
    put_intent(s, &id, &value);
    crash(s, &root);
    let retry = latest(s, &id);
    assert_eq!(retry["status"], "queued");
    // Its timeout is cut at reservation to what remains.
    due(s, &retry);
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert!(reserved["timeoutSeconds"].as_i64().unwrap() <= 500, "{}", reserved["timeoutSeconds"]);
    // A second one, queued, then left with 30 s at its reservation.
    let attempt = reserved["attempt"].clone();
    s.update_job_evidence(retry["id"].as_str().unwrap(), json!({"jobId":retry["id"],"attempt":attempt,"status":"running",
        "reason":"Running","started":{"at":now_unix()}})).unwrap();
    crash(s, &retry);
    let second = latest(s, &id);
    assert_eq!(second["recoveryOf"]["retry"], 2);
    {
        let db = s.db.write().unwrap();
        let mut value = store::get(&db, second["id"].as_str().unwrap()).unwrap();
        value["deadlineAtUnix"] = json!(now_unix() + 30.0);
        value["notBeforeUnix"] = json!(0);
        store::save(&db, &value).unwrap();
    }
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let refused = record(s, &second);
    assert_eq!(refused["status"], "rejected");
    assert_eq!(refused["result"]["evidence"]["recoveryRefusal"], "insufficient_time");
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("ended"), Some("insufficient_time")));
}

#[tokio::test]
async fn a_stop_ends_the_period_whichever_commits_first() {
    // Stop first: the crash after it starts nothing.
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    stop_now(s, &id, &stop_request("stop-1", &root, revision)).unwrap();
    crash(s, &root);
    assert_eq!(jobs(s), 2, "no retry after the user's stop");
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("halted"), Some("user_stop")));

    // The crash first: a Stop from the reading before it still stops the
    // period, and the queued retry never starts.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    crash(s, &root);
    let retry = latest(s, &id);
    let receipt = stop_now(s, &id, &stop_request("stop-1", &root, revision)).unwrap();
    assert_eq!((receipt["jobId"].clone(), receipt["status"].as_str()), (retry["id"].clone(), Some("cancelled")));
    due(s, &retry);
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none(), "the cancelled retry never starts");
    assert_eq!(intent_of(s, &id)["desiredState"], "stopped");
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("halted"), Some("user_stop")));

    // A newer manual run: an older Stop never touches it.
    let restart = start_now(s, &id, &start_request("start-2", &record(s, &retry), revision + 1)).unwrap();
    assert!(error(stop_now(s, &id, &stop_request("stop-old", &root, revision))).starts_with("stale_service_state"));
    assert!(error(stop_now(s, &id, &stop_request("stop-old2", &root, revision + 2))).starts_with("stale_service_state"));
    assert_eq!(record(s, &json!({"id":restart["jobId"]}))["status"], "queued");
}

#[tokio::test]
async fn a_stop_while_a_retry_is_starting_lets_nothing_follow() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    crash(s, &root);
    let retry = latest(s, &id);
    due(s, &retry);
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(recovery(&lab, &id).await["launch"], "starting");
    let receipt = stop_now(s, &id, &stop_request("stop-1", &root, revision)).unwrap();
    assert_eq!(receipt["status"], "cancelling", "a cancel asked of a launch in preparation; it may briefly run");
    assert_eq!(recovery(&lab, &id).await["launch"], "stopping");
    crash(s, &retry);
    assert_eq!(jobs(s), 3, "nothing follows the stopped retry");
}

#[tokio::test]
async fn opting_out_cancels_only_a_retry_not_yet_reserved() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    crash(s, &root);
    let retry = latest(s, &id);
    let receipt = opt_out_now(s, &id, &opt_out_request("off-1", &root, revision)).unwrap();
    assert_eq!(receipt["action"], "recovery");
    assert_eq!(receipt["cancelledRetryJobId"], retry["id"]);
    assert_eq!(record(s, &retry)["status"], "cancelled");
    assert_eq!(opt_out_now(s, &id, &opt_out_request("off-1", &root, revision)).unwrap(), receipt, "the same request is its receipt");
    let intent = intent_of(s, &id);
    assert_eq!((intent["recoveryMode"].as_str(), intent["desiredState"].as_str()), (Some("manual"), Some("running")));
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("off"), Some("opted_out")));
    assert!(error(opt_out_now(s, &id, &opt_out_request("off-2", &root, revision + 1))).starts_with("recovery_off"));

    // While the run is in progress: this round goes on, nothing follows it.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    let receipt = opt_out_now(s, &id, &opt_out_request("off-1", &root, revision)).unwrap();
    assert!(receipt["cancelledRetryJobId"].is_null());
    assert_eq!(record(s, &root)["status"], "running");
    crash(s, &root);
    assert_eq!(jobs(s), 2);

    // A retry already reserved for launch keeps its round too: no cancel is
    // asked of it, and its crash starts nothing.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    crash(s, &root);
    let retry = latest(s, &id);
    due(s, &retry);
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(reserved["id"], retry["id"]);
    let receipt = opt_out_now(s, &id, &opt_out_request("off-1", &root, revision)).unwrap();
    assert!(receipt["cancelledRetryJobId"].is_null());
    let kept = record(s, &retry);
    assert!(kept["cancelRequestedAt"].is_null() && kept["status"] == "starting", "{}", kept["status"]);
    s.update_job_evidence(retry["id"].as_str().unwrap(), json!({"jobId":retry["id"],"attempt":reserved["attempt"],
        "status":"running","reason":"Running","started":{"at":now_unix()}}))
        .unwrap();
    crash(s, &retry);
    assert_eq!(jobs(s), 3, "nothing follows the opt-out");
}

#[tokio::test]
async fn changed_inputs_a_refused_launch_and_other_endings_stop_recovery_with_their_reason() {
    let cases: [(&str, &str, &str, &str, &str); 7] = [
        ("rejected", "Guarded inputs changed while queued (README.md); command was not started.", "", "halted", "inputs_changed"),
        ("failed", "timeout", "", "ended", "lifetime_reached"),
        ("failed", "oom-kill", "", "halted", "oom"),
        ("interrupted", "OS boot changed", "", "halted", "host_restart"),
        ("unknown", "No conclusive terminal evidence", "", "halted", "unknown_outcome"),
        ("failed", "deadline", "stop", "ended", "lifetime_reached"),
        ("succeeded", "success", "", "ended", ""),
    ];
    for (status, reason, deadline, state, why) in cases {
        let lab = lab();
        let s = &lab.ws.store;
        let (id, root) = armed(&lab).await;
        let root = launch(s, &root);
        let attempt = record(s, &root)["attempt"].clone();
        let mut evidence = json!({"jobId":root["id"],"attempt":attempt,"status":status,"reason":reason,
            "evidence":{"systemd":{"Result":reason,"ExecMainStatus":"0"}}});
        if !deadline.is_empty() {
            evidence["evidence"]["deadline"] = json!({"kind":deadline});
        }
        s.update_job_evidence(root["id"].as_str().unwrap(), evidence).unwrap();
        assert_eq!(jobs(s), 2, "{status}/{reason}: no retry");
        let view = recovery(&lab, &id).await;
        assert_eq!(view["state"], state, "{status}/{reason}");
        assert_eq!(view["haltedReason"].as_str().unwrap_or(""), why, "{status}/{reason}");
    }
}

#[tokio::test]
async fn an_outcome_reconciled_with_its_end_time_marker_reads_as_the_end_time() {
    // What host.py's reconciliation records too since review 453aa6d2: the
    // signal or refusal the end time caused, with its marker.
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let attempt = record(s, &root)["attempt"].clone();
    s.update_job_evidence(root["id"].as_str().unwrap(), json!({"jobId":root["id"],"attempt":attempt,"status":"failed","reason":"signal",
        "evidence":{"systemd":{"Result":"signal","ExecMainStatus":"15"},"pids":null,"deadline":{"kind":"stop","at":1.0}}}))
        .unwrap();
    assert_eq!(jobs(s), 2, "the end time's SIGTERM is not a crash: no retry");
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("ended"), Some("lifetime_reached")));
    assert_eq!(view["attempts"][0]["outcome"], "lifetime");

    // A retry the worker refused just before exec.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    due(s, &retry);
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(reserved["id"], retry["id"]);
    s.update_job_evidence(retry["id"].as_str().unwrap(), json!({"jobId":retry["id"],"attempt":reserved["attempt"],"status":"rejected",
        "reason":"Not started: less than 60 s remain before the end time this service run shares with its automatic retries; no process was created",
        "evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"78"},"pids":null,"deadline":{"kind":"notStarted","at":1.0}}}))
        .unwrap();
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("ended"), Some("insufficient_time")));
    assert_eq!(jobs(s), 3, "nothing follows");
}

#[tokio::test]
async fn a_failed_recovery_step_still_records_the_outcome() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    // The task leaves its Project, so the retry's service check refuses it.
    let task = record(s, &root)["taskId"].as_str().unwrap().to_owned();
    s.db.write().unwrap().execute("DELETE FROM project_tasks WHERE task_id=?1", [&task]).unwrap();
    crash(s, &root);
    let ended = record(s, &root);
    assert_eq!(ended["status"], "failed", "the outcome is recorded");
    assert!(ended["retriedBy"].is_null());
    assert!(ended["reason"].as_str().unwrap().contains("Not retried automatically"));
    assert_eq!(jobs(s), 2);
    let intent = intent_of(s, &id);
    assert_eq!((intent["recovery"]["state"].as_str(), intent["recovery"]["haltedReason"].as_str()), (Some("halted"), Some("launch_refused")));
}

#[tokio::test]
async fn a_step_failing_after_the_retry_is_written_leaves_no_partial_retry() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    // The retry's Job row is written, then linking it to the service fails.
    s.db.write().unwrap().execute_batch("CREATE TEMP TRIGGER refuse_link BEFORE INSERT ON project_service_jobs
        BEGIN SELECT RAISE(ABORT, 'synthetic link failure'); END;").unwrap();
    crash(s, &root);
    let ended = record(s, &root);
    assert_eq!(ended["status"], "failed", "the outcome is recorded");
    assert!(ended["retriedBy"].is_null());
    assert!(ended["reason"].as_str().unwrap().contains("synthetic link failure"), "{}", ended["reason"]);
    assert_eq!((jobs(s), links(s, &id)), (2, 2), "no retry Job is left behind");
    let intent = intent_of(s, &id);
    assert_eq!((intent["recovery"]["state"].as_str(), intent["recovery"]["haltedReason"].as_str()), (Some("halted"), Some("launch_refused")));
    assert!(intent["recovery"]["retryJobId"].is_null() && intent["recovery"]["scheduled"] == 0);
}

#[tokio::test]
async fn after_a_core_restart_nothing_queued_before_it_starts_and_recovery_is_manual() {
    let lab = lab();
    let (id, retry) = {
        let s = &lab.ws.store;
        let (id, root) = armed(&lab).await;
        let root = launch(s, &root);
        crash(s, &root);
        let retry = latest(s, &id);
        (id, retry)
    };
    let data = lab._dir.path().join("data");
    drop(lab.ws);
    let ws = Workspace::new(data, "/tmp".into(), "unused".into()).unwrap();
    let lab = Lab { _dir: lab._dir, ws, project: lab.project };
    let s = &lab.ws.store;
    let intent = intent_of(s, &id);
    assert_eq!((intent["recoveryMode"].as_str(), intent["recovery"]["haltedReason"].as_str()), (Some("manual"), Some("core_restart")));
    due(s, &retry);
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let refused = record(s, &retry);
    assert_eq!((refused["status"].as_str(), refused["result"]["evidence"]["recoveryRefusal"].as_str()), (Some("rejected"), Some("core_restart")));
    assert_eq!(jobs(s), 3, "nothing follows");
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("halted"), Some("core_restart")));
}

#[tokio::test]
async fn a_run_that_takes_over_never_inherits_recovery() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    ended(s, &root, "succeeded", "success", "0");
    let other = submit(s, "j2", &id).unwrap();
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("ended"), Some("superseded")));
    // An older Stop never touches it.
    assert!(error(stop_now(s, &id, &stop_request("stop-old", &root, revision))).starts_with("stale_service_state"));
    let other = launch(s, &other);
    crash(s, &other);
    assert_eq!(jobs(s), 3, "its crash starts nothing");
}

#[tokio::test]
async fn retries_not_yet_due_never_take_the_queue_window() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    // Forty more Jobs not yet due, queued ahead of one that is.
    {
        let db = s.db.write().unwrap();
        for n in 0..40 {
            let mut value = store::get(&db, retry["id"].as_str().unwrap()).unwrap();
            value["id"] = json!(format!("later-{n}"));
            value["requestId"] = json!(format!("later-{n}"));
            store::insert_job(&db, value).unwrap();
        }
    }
    let other = service(&lab, "Docs").await;
    let due_now = submit(s, "due", &other).unwrap();
    let queued = super::super::queue::queued(&*s.db.read().unwrap()).unwrap();
    assert_eq!(queued.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), [due_now["id"].as_str().unwrap()]);
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(reserved["id"], due_now["id"]);
}

#[tokio::test]
async fn an_unknown_outcome_offers_stop_but_never_start_in_either_mode() {
    for bounded in [false, true] {
        let lab = lab();
        let s = &lab.ws.store;
        let (id, user) = if bounded {
            armed(&lab).await
        } else {
            let id = service(&lab, "Vite").await;
            let first = submit(s, "j1", &id).unwrap();
            run(s, &first);
            end(s, &first, "succeeded");
            let receipt = start_now(s, &id, &start_request("start-1", &first, 0)).unwrap();
            (id.clone(), record(s, &json!({"id":receipt["jobId"]})))
        };
        let user = launch(s, &user);
        s.job_unknown(user["id"].as_str().unwrap(), "Launch acknowledgement unavailable").unwrap();
        let view = listed(&lab, &id).await;
        assert_eq!(view["lifecycle"]["outcomeUnknown"], true, "bounded {bounded}");
        assert_eq!(view["job"]["canStop"], true);
        assert_eq!(view["lifecycle"]["canStart"], false);
        assert_eq!(view["lifecycle"]["recovery"]["launch"], "unknown");
        let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
        let receipt = stop_now(s, &id, &stop_request("stop-1", &user, revision)).unwrap();
        assert_eq!(receipt["status"], "cancelling", "a stop requested, not confirmed");
        let view = listed(&lab, &id).await;
        assert_eq!(view["lifecycle"]["outcomeUnknown"], true, "still unconfirmed");
        assert_eq!(view["lifecycle"]["recovery"]["launch"], "stopping");
        assert_eq!(view["lifecycle"]["canStart"], false);
        assert_eq!(jobs(s), 2, "never resent");
    }
}

#[tokio::test]
async fn recovery_is_only_a_start_choice_and_opt_out_takes_only_its_mode() {
    let job = json!({"id":"j"});
    let mut bad: Request = start_bounded("r", &job, 0);
    bad.recovery = Some(Recovery { mode: "always".into() });
    assert!(bad.validate("start").unwrap_err().to_string().starts_with("invalid_input"));
    let mut stop = stop_request("r", &job, 0);
    stop.recovery = Some(Recovery { mode: "bounded".into() });
    assert!(stop.validate("stop").is_err());
    let mut off = opt_out_request("r", &job, 0);
    assert!(off.validate("recovery").is_ok());
    off.mode = Some("bounded".into());
    assert!(off.validate("recovery").is_err());
    assert!(serde_json::from_value::<Request>(json!({"requestId":"r","expectedJobId":"j","expectedIntentRevision":0,
        "recovery":{"mode":"bounded","attempts":9}})).is_err(), "no other recovery settings");
}

#[tokio::test]
async fn a_waiting_retry_cancelled_through_jobs_ends_recovery() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    assert_eq!(recovery(&lab, &id).await["state"], "waiting");
    // Its own cancel through Jobs, by its Agent: not the service's Stop or opt-out.
    let cancelled = s.request_job_cancel(retry["agentId"].as_str(), retry["id"].as_str().unwrap()).unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(intent_of(s, &id)["recoveryMode"], "manual");
    let view = recovery(&lab, &id).await;
    assert_eq!((view["mode"].as_str(), view["state"].as_str(), view["haltedReason"].as_str()),
        (Some("manual"), Some("halted"), Some("cancelled")));
    assert!(view["notBefore"].is_null() && view["launch"].is_null());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none(), "nothing is left to start");
}

#[tokio::test]
async fn a_retry_that_ends_before_it_is_seen_running_still_counts_as_started() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    due(s, &retry);
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(reserved["id"], retry["id"]);
    // Its start receipt and its crash arrive in one reading.
    s.update_job_evidence(retry["id"].as_str().unwrap(), json!({"jobId":retry["id"],"attempt":reserved["attempt"],
        "status":"failed","reason":"exit-code","started":{"at":now_unix()},
        "evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"1"}}}))
        .unwrap();
    assert_eq!(recovery(&lab, &id).await["retry"], json!({"scheduled":2,"started":1,"max":3}));
    // One refused at launch never started its command and is not counted.
    let second = latest(s, &id);
    due(s, &second);
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(reserved["id"], second["id"]);
    assert!(record(s, &second)["startedAt"].is_string(), "reservation alone sets startedAt");
    s.update_job_evidence(second["id"].as_str().unwrap(), json!({"jobId":second["id"],"attempt":reserved["attempt"],
        "status":"rejected","reason":"Guarded inputs changed while queued (README.md); command was not started.",
        "started":{"at":now_unix()},"evidence":{}}))
        .unwrap();
    let view = recovery(&lab, &id).await;
    assert_eq!(view["retry"], json!({"scheduled":2,"started":1,"max":3}));
    assert_eq!(view["haltedReason"], "inputs_changed");
}

#[tokio::test]
async fn a_retry_keeps_its_runs_complete_identity() {
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    // A standalone Job's identity is complete at submission and never
    // recomputed later, so the retry must carry it for artifact reuse.
    assert!(root["identity"]["sha256"].is_string());
    assert_eq!(retry["identity"], root["identity"]);
}
