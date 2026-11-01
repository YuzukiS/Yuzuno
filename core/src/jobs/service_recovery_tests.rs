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
/// Reserve this queued Job and record it running now, its command created
/// (the host's `command` record), as a reading of a started command shows.
fn launch(s: &Store, job: &Value) -> Value {
    due(s, job);
    let reserved = s.reserve_next_job(None, None, None).unwrap().expect("a Job to reserve");
    assert_eq!(reserved["id"], job["id"]);
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":reserved["attempt"],
        "status":"running","reason":"Running","started":{"at":now_unix()},
        "command":{"attempt":reserved["attempt"],"pid":4242,"startedAt":now_unix()}}))
        .unwrap();
    record(s, job)
}
/// Reserve this queued Job only: its worker may start, nothing else is known.
fn reserve(s: &Store, job: &Value) -> Value {
    due(s, job);
    let reserved = s.reserve_next_job(None, None, None).unwrap().expect("a Job to reserve");
    assert_eq!(reserved["id"], job["id"]);
    reserved
}
/// The Job's process ended with this systemd Result and main status. For an
/// exit or a signal, the host's wrapper recorded it as the command's own, as
/// it does for a command it created (`command`).
fn ended(s: &Store, job: &Value, status: &str, result: &str, code: &str) {
    let attempt = record(s, job)["attempt"].clone();
    let mut evidence = json!({"systemd":{"Result":result,"ExecMainStatus":code}});
    if let (Some(sign), Ok(n)) = (match result { "exit-code" => Some(1), "signal" | "core-dump" => Some(-1), _ => None }, code.parse::<i64>()) {
        evidence["command"] = json!({"attempt":attempt,"exitCode":sign * n});
    }
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":attempt,"status":status,
        "reason":result,"evidence":evidence}))
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
        "reason":"exit-code","started":{"at":now_unix() + 600.0},
        "evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"1"},"command":{"attempt":attempt,"exitCode":1}}}))
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

/// This attempt stopped at the end time, as the host recorded it: Core's
/// reconciliation first, or the collector first (which adds its launch).
fn ended_at_the_end(s: &Store, job: &Value, first: &str, signal: &str) {
    let attempt = record(s, job)["attempt"].clone();
    let mut evidence = json!({"systemd":{"Result":"signal","ExecMainStatus":signal},"pids":null,
        "deadline":{"kind":"stop","attempt":attempt,"at":1.0}});
    if first == "collector" {
        evidence["launch"] = json!({"returnCode":0,"stderr":""});
    }
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":attempt,"status":"failed",
        "reason":"signal","evidence":evidence}))
        .unwrap();
}

#[tokio::test]
async fn a_stop_at_the_end_time_ends_recovery_whichever_path_recorded_it() {
    // SIGTERM at the end, or the SIGKILL 3 s later; the marker decides, not
    // the clock (the end here is still hours away).
    for (first, signal) in [("reconcile", "15"), ("reconcile", "9"), ("collector", "15"), ("collector", "9")] {
        // Budget not used up: the root reaches the end.
        let lab = lab();
        let s = &lab.ws.store;
        let (id, root) = armed(&lab).await;
        let root = launch(s, &root);
        ended_at_the_end(s, &root, first, signal);
        assert_eq!(jobs(s), 2, "{first}/{signal}: no retry follows");
        let view = recovery(&lab, &id).await;
        assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("ended"), Some("lifetime_reached")), "{first}/{signal}");
        assert_eq!(view["attempts"][0]["outcome"], "lifetime");

        // Budget used up: the third retry reaches the end.
        let lab = self::lab();
        let s = &lab.ws.store;
        let (id, root) = armed(&lab).await;
        let mut current = launch(s, &root);
        for _ in 0..3 {
            crash(s, &current);
            current = launch(s, &latest(s, &id));
        }
        assert_eq!(current["recoveryOf"]["retry"], 3);
        ended_at_the_end(s, &current, first, signal);
        assert_eq!(jobs(s), 5, "{first}/{signal}: nothing follows the third retry");
        let view = recovery(&lab, &id).await;
        assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("ended"), Some("lifetime_reached")), "{first}/{signal}");
        assert_eq!(view["retry"], json!({"scheduled":3,"started":3,"max":3}));
    }
}

#[tokio::test]
async fn without_a_marker_a_signal_is_a_crash_and_an_unknown_outcome_stays_unknown() {
    // The control: a SIGTERM the end time did not cause is a crash.
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    ended(s, &root, "failed", "signal", "15");
    assert_eq!(jobs(s), 3, "a retry is queued");
    assert_eq!(recovery(&lab, &id).await["lastFailure"]["signal"], "SIGTERM");

    // A marker never makes an unconfirmed outcome an ending.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let attempt = record(s, &root)["attempt"].clone();
    s.update_job_evidence(root["id"].as_str().unwrap(), json!({"jobId":root["id"],"attempt":attempt,"status":"unknown",
        "reason":"No conclusive terminal evidence","evidence":{"deadline":{"kind":"stop","attempt":attempt,"at":1.0}}}))
        .unwrap();
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("halted"), Some("unknown_outcome")));
    assert_eq!(view["attempts"][0]["outcome"], "unknown");

    // A retry the worker refused just before exec reads as too little time.
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
        "evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"78"},"pids":null,
            "deadline":{"kind":"notStarted","attempt":reserved["attempt"],"at":1.0}}}))
        .unwrap();
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("ended"), Some("insufficient_time")));
    assert_eq!(jobs(s), 3, "nothing follows");
}

/// The wrapper's own failure, as the host records it: `extra` is what it
/// knew about the command (nothing, its exit, or the stage it stopped at).
fn wrapper_failed(s: &Store, job: &Value, extra: Value) {
    let attempt = record(s, job)["attempt"].clone();
    let mut evidence = json!({"systemd":{"Result":"exit-code","ExecMainStatus":"1"},"pids":null});
    for (key, value) in extra.as_object().unwrap() {
        evidence[key] = value.clone();
        evidence[key]["attempt"] = attempt.clone();
    }
    // The wrapper's own start receipt is there either way: it comes first.
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":attempt,"status":"failed",
        "reason":"exit-code","started":{"attempt":attempt,"at":now_unix()},"evidence":evidence}))
        .unwrap();
}

#[tokio::test]
async fn only_the_commands_own_exit_is_a_crash_a_wrapper_failure_never_retries_or_spends_budget() {
    let cases: [(Value, &str); 5] = [
        (json!({"notLaunched":{"stage":"inputs","reason":"RuntimeError: Guarded inputs must be files: config.txt"}}), "inputs_changed"),
        (json!({"notLaunched":{"stage":"process","reason":"FileNotFoundError: [Errno 2] No such file or directory"}}), "launch_refused"),
        (json!({"notLaunched":{"stage":"prepare","reason":"OSError: [Errno 28] No space left on device"}}), "launch_refused"),
        // The wrapper failed after creating the command, before recording its exit.
        (json!({"command":{"pid":42,"startedAt":1.0}}), "unknown_outcome"),
        // The command exited 0; the wrapper failed afterwards.
        (json!({"command":{"pid":42,"startedAt":1.0,"exitCode":0}}), "unknown_outcome"),
    ];
    for (extra, why) in cases {
        // On the run itself: the budget is untouched.
        let lab = lab();
        let s = &lab.ws.store;
        let (id, root) = armed(&lab).await;
        let root = launch(s, &root);
        wrapper_failed(s, &root, extra.clone());
        assert_eq!(jobs(s), 2, "{why}: nothing follows");
        assert!(record(s, &root)["retriedBy"].is_null(), "{why}");
        let view = recovery(&lab, &id).await;
        assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("halted"), Some(why)), "{extra}");
        assert_eq!(view["retry"]["scheduled"], 0, "{why}: no budget spent");

        // On a retry, failing straight from its reservation: the budget stays
        // what it was, and it counts as started only if its command was.
        let lab = self::lab();
        let s = &lab.ws.store;
        let (id, root) = armed(&lab).await;
        let root = launch(s, &root);
        crash(s, &root);
        let retry = latest(s, &id);
        reserve(s, &retry);
        wrapper_failed(s, &retry, extra.clone());
        assert_eq!(jobs(s), 3, "{why}: nothing follows the retry");
        assert!(record(s, &retry)["retriedBy"].is_null());
        let started = i64::from(extra["command"]["pid"].is_i64());
        let view = recovery(&lab, &id).await;
        assert_eq!((view["haltedReason"].as_str(), &view["retry"]), (Some(why), &json!({"scheduled":1,"started":started,"max":3})), "{extra}");
    }

    // The command's own exit 1, or its own SIGSEGV: one retry each.
    for (result, code, extra) in [("exit-code", "1", json!({"command":{"pid":42,"exitCode":1}})),
                                  ("core-dump", "11", json!({"command":{"pid":42,"exitCode":-11}}))] {
        let lab = lab();
        let s = &lab.ws.store;
        let (id, root) = armed(&lab).await;
        let root = launch(s, &root);
        let attempt = record(s, &root)["attempt"].clone();
        let mut evidence = json!({"systemd":{"Result":result,"ExecMainStatus":code}});
        evidence["command"] = extra["command"].clone();
        evidence["command"]["attempt"] = attempt.clone();
        s.update_job_evidence(root["id"].as_str().unwrap(), json!({"jobId":root["id"],"attempt":attempt,"status":"failed",
            "reason":result,"evidence":evidence}))
            .unwrap();
        assert_eq!(jobs(s), 3, "{result}: one retry");
        assert_eq!(recovery(&lab, &id).await["retry"]["scheduled"], 1);
    }
}

/// A running reading of this reserved attempt, with the host's command
/// record if `command` is given (`attempt` decides whose it claims to be).
fn running(s: &Store, reserved: &Value, command: Option<&Value>) -> bool {
    let mut reading = json!({"jobId":reserved["id"],"attempt":reserved["attempt"],"status":"running",
        "reason":"Running with verified cgroup limits","started":{"attempt":reserved["attempt"],"at":now_unix()},
        "evidence":{"SubState":"running"},"command":null});
    if let Some(attempt) = command {
        reading["command"] = json!({"attempt":attempt,"pid":4242,"startedAt":now_unix()});
    }
    s.update_job_evidence(reserved["id"].as_str().unwrap(), reading).unwrap()
}

#[tokio::test]
async fn a_retry_counts_as_started_only_once_its_command_was_created() {
    // A wrapper failure delivered straight after reservation, never running.
    let lab = lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    reserve(s, &retry);
    wrapper_failed(s, &retry, json!({"notLaunched":{"stage":"inputs","reason":"RuntimeError: Guarded inputs must be files"}}));
    let view = recovery(&lab, &id).await;
    assert_eq!((&view["retry"], view["haltedReason"].as_str()), (&json!({"scheduled":1,"started":0,"max":3}), Some("inputs_changed")));

    // Live: the worker runs before its command; the command's record arrives
    // in a later reading and is taken once; repeats, and another attempt's
    // record, change nothing.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    let reserved = reserve(s, &retry);
    assert!(running(s, &reserved, None));
    assert_eq!(recovery(&lab, &id).await["retry"]["started"], 0, "the worker alone is not a start");
    assert!(!running(s, &reserved, None), "a repeat without the command changes nothing");
    assert!(!running(s, &reserved, Some(&json!("another-attempt"))), "another attempt's record is not this one's");
    assert_eq!(recovery(&lab, &id).await["retry"]["started"], 0);
    assert!(running(s, &reserved, Some(&reserved["attempt"])), "the command's record is taken once");
    assert_eq!(recovery(&lab, &id).await["retry"], json!({"scheduled":1,"started":1,"max":3}));
    assert!(!running(s, &reserved, Some(&reserved["attempt"])), "and a repeat changes nothing");
    assert_eq!(recovery(&lab, &id).await["retry"]["started"], 1);
    crash(s, &retry);
    assert_eq!(recovery(&lab, &id).await["retry"], json!({"scheduled":2,"started":1,"max":3}), "its crash spends one more, starts none");

    // A fast exit: the command's record arrives only with the outcome.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    let reserved = reserve(s, &retry);
    s.update_job_evidence(retry["id"].as_str().unwrap(), json!({"jobId":retry["id"],"attempt":reserved["attempt"],
        "status":"failed","reason":"exit-code","started":{"attempt":reserved["attempt"],"at":now_unix()},
        "evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"1"},
            "command":{"attempt":reserved["attempt"],"pid":4242,"exitCode":1}}}))
        .unwrap();
    assert_eq!(recovery(&lab, &id).await["retry"], json!({"scheduled":2,"started":1,"max":3}));

    // Another attempt's record, or none: no start, and its exit is no crash.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    let reserved = reserve(s, &retry);
    s.update_job_evidence(retry["id"].as_str().unwrap(), json!({"jobId":retry["id"],"attempt":reserved["attempt"],
        "status":"failed","reason":"exit-code","started":{"attempt":reserved["attempt"],"at":now_unix()},
        "evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"1"},
            "command":{"attempt":"another-attempt","pid":4242,"exitCode":1}}}))
        .unwrap();
    let view = recovery(&lab, &id).await;
    assert_eq!((&view["retry"], view["haltedReason"].as_str()), (&json!({"scheduled":1,"started":0,"max":3}), Some("unknown_outcome")));
    assert_eq!(jobs(s), 3, "nothing follows");

    // A cancel being confirmed is never overwritten by a later reading.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    crash(s, &root);
    let retry = latest(s, &id);
    let reserved = reserve(s, &retry);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    stop_now(s, &id, &stop_request("stop-1", &retry, revision)).unwrap();
    assert_eq!(record(s, &retry)["status"], "cancelling");
    assert!(!running(s, &reserved, Some(&reserved["attempt"])));
    assert_eq!(record(s, &retry)["status"], "cancelling");

    // Turned off while reserved: the retry may still run. Its command's start
    // is recorded in the closed period, once; recovery stays off, keeps its
    // reason, revision, end time and budget, and its crash starts nothing.
    let lab = self::lab();
    let s = &lab.ws.store;
    let (id, root) = armed(&lab).await;
    let root = launch(s, &root);
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    crash(s, &root);
    let retry = latest(s, &id);
    let reserved = reserve(s, &retry);
    opt_out_now(s, &id, &opt_out_request("off-1", &root, revision)).unwrap();
    let closed = intent_of(s, &id);
    assert!(running(s, &reserved, None));
    assert_eq!(intent_of(s, &id)["recovery"]["started"], 0, "the worker alone is not a start");
    assert!(running(s, &reserved, Some(&reserved["attempt"])));
    assert_eq!(record(s, &retry)["status"], "running");
    assert!(!running(s, &reserved, Some(&reserved["attempt"])), "a repeat changes nothing");
    let after = intent_of(s, &id);
    assert_eq!(after["recovery"]["started"], 1);
    for key in ["revision", "recoveryMode", "desiredState", "appliesToJobId"] {
        assert_eq!(after[key], closed[key], "{key} unchanged");
    }
    for key in ["state", "haltedReason", "haltedAt", "deadlineAtUnix", "scheduled", "retryJobId"] {
        assert_eq!(after["recovery"][key], closed["recovery"][key], "recovery.{key} unchanged");
    }
    crash(s, &retry);
    assert_eq!(jobs(s), 3, "its crash starts nothing");
    let view = recovery(&lab, &id).await;
    assert_eq!((view["mode"].as_str(), view["state"].as_str(), view["haltedReason"].as_str()), (Some("manual"), Some("off"), Some("opted_out")));
    assert_eq!(view["retry"], json!({"scheduled":1,"started":1,"max":3}));
    assert_eq!(intent_of(s, &id)["revision"], closed["revision"]);

    // A new manual run after that: the closed period's record is not touched
    // by anything the new run does.
    let receipt = start_now(s, &id, &start_request("start-2", &retry, revision + 1)).unwrap();
    let manual = record(s, &json!({"id":receipt["jobId"]}));
    let manual = launch(s, &manual);
    crash(s, &manual);
    assert_eq!(jobs(s), 4, "the manual run's crash starts nothing");
    assert!(intent_of(s, &id)["recovery"].is_null(), "a manual run has no period");
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

/// As `armed`, for another service of the same Project.
async fn armed_as(lab: &Lab, name: &str) -> (String, Value) {
    let s = &lab.ws.store;
    let id = service(lab, name).await;
    let first = submit(s, &format!("{name}-1"), &id).unwrap();
    run(s, &first);
    end(s, &first, "succeeded");
    let receipt = start_now(s, &id, &start_bounded(&format!("{name}-start"), &first, 0)).unwrap();
    (id, record(s, &json!({"id":receipt["jobId"]})))
}
/// Core starts again on the same Workspace.
fn core_restarted(lab: Lab) -> Lab {
    let data = lab._dir.path().join("data");
    drop(lab.ws);
    let ws = Workspace::new(data, "/tmp".into(), "unused".into()).unwrap();
    Lab { _dir: lab._dir, ws, project: lab.project }
}

#[tokio::test]
async fn after_a_core_restart_a_retry_queued_before_it_is_rejected_at_once_and_recovery_is_manual() {
    let lab = lab();
    let s = &lab.ws.store;
    // Vite: its third retry is queued, 600 s out.
    let (id, root) = armed(&lab).await;
    let mut previous = launch(s, &root);
    for _ in 0..2 {
        crash(s, &previous);
        previous = launch(s, &latest(s, &id));
    }
    crash(s, &previous);
    let third = record(s, &latest(s, &id));
    assert_eq!((third["recoveryOf"]["retry"].as_i64(), third["status"].as_str()), (Some(3), Some("queued")));
    let revision = intent_of(s, &id)["revision"].as_i64().unwrap();
    // Docs: a retry already reserved. Api: a retry whose outcome is unknown.
    // Plain: an ordinary queued Job. And a remote Job shaped like a retry.
    let (docs, root) = armed_as(&lab, "Docs").await;
    crash(s, &launch(s, &root));
    let reserved = reserve(s, &latest(s, &docs));
    let (api, root) = armed_as(&lab, "Api").await;
    crash(s, &launch(s, &root));
    let unknown = reserve(s, &latest(s, &api));
    s.job_unknown(unknown["id"].as_str().unwrap(), "Launch acknowledgement unavailable").unwrap();
    let plain = service(&lab, "Plain").await;
    let ordinary = submit(s, "plain-1", &plain).unwrap();
    {
        let db = s.db.write().unwrap();
        let mut value = third.clone();
        value["id"] = json!("remote-retry");
        value["requestId"] = json!("remote-retry");
        value["executor"] = json!({"machineId":"lab-remote","machineName":"lab"});
        store::insert_job(&db, value).unwrap();
    }
    let others = |s: &Store| [&reserved, &unknown, &ordinary, &json!({"id":"remote-retry"})].map(|job| record(s, job));
    let before = others(s);
    assert_eq!(before.each_ref().map(|job| job["status"].as_str()), [Some("starting"), Some("unknown"), Some("queued"), Some("queued")]);
    let count = jobs(s);

    // No delay passes and no clock moves before these readings.
    let lab = core_restarted(lab);
    let s = &lab.ws.store;
    let refused = record(s, &third);
    assert!(refused["notBeforeUnix"].as_f64().unwrap() > now_unix() + 500.0, "its delay has not passed");
    assert_eq!((refused["status"].as_str(), refused["result"]["evidence"]["recoveryRefusal"].as_str()),
        (Some("rejected"), Some("core_restart")), "rejected at Core start, before its delay");
    assert_eq!((refused["reserved"] == true, &refused["attempt"]), (false, &third["attempt"]), "no new attempt");
    assert!(refused["finishedAt"].is_string() && refused["notifications"]["rejected"].is_string());
    let mut kept = refused.clone();
    for field in ["status", "reason", "finishedAt", "result", "notifications"] {
        match third.get(field) {
            Some(value) => kept[field] = value.clone(),
            None => drop(kept.as_object_mut().unwrap().remove(field)),
        }
    }
    assert_eq!(kept, third, "only its outcome is recorded: its lineage, launch and history stay");
    assert_eq!(jobs(s), count, "nothing follows");
    assert_eq!(others(s), before, "a reserved retry, an unknown one, an ordinary queued Job and a remote Job are left as they were");
    let intent = intent_of(s, &id);
    assert_eq!((intent["recoveryMode"].as_str(), intent["recovery"]["haltedReason"].as_str()), (Some("manual"), Some("core_restart")));
    assert_eq!((intent["revision"].as_i64(), &intent["appliesToJobId"]), (Some(revision), &third["id"]));
    let view = recovery(&lab, &id).await;
    assert_eq!((view["state"].as_str(), view["haltedReason"].as_str()), (Some("halted"), Some("core_restart")));
    assert_eq!(view["retry"], json!({"scheduled":3,"started":2,"max":3}));

    // Starting again changes nothing more.
    let lab = core_restarted(lab);
    let s = &lab.ws.store;
    assert_eq!((record(s, &third), jobs(s)), (refused.clone(), count));
    assert_eq!(others(s), before);

    // The user's Start again from what the panel reads: a new period that
    // holds nothing of the old retry.
    let receipt = start_now(s, &id, &start_bounded("start-after", &refused, revision)).unwrap();
    let intent = intent_of(s, &id);
    assert_eq!((intent["recoveryMode"].as_str(), &intent["recovery"]["rootJobId"]), (Some("bounded"), &receipt["jobId"]));
    assert_eq!((intent["recovery"]["scheduled"].as_i64(), intent["recovery"]["started"].as_i64()), (Some(0), Some(0)));
    assert!(intent["recovery"]["retryJobId"].is_null());
    assert_eq!((record(s, &third)["status"].as_str(), jobs(s)), (Some("rejected"), count + 1));
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
        "evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"1"},"command":{"attempt":reserved["attempt"],"pid":4242,"exitCode":1}}}))
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
