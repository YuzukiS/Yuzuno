use super::*;

fn gated(key: &str, needs: &[&str]) -> Value {
    let mut value = stage(key, needs);
    value["waitForAnalysis"] = json!(true);
    value
}

fn gate(run: &Value, key: &str) -> Value {
    run["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == key)
        .unwrap()["analysis"]
        .clone()
}

fn decision(run: &Value, key: &str, request: &str, choice: &str) -> runs::AnalysisDecision {
    let gate = gate(run, key);
    serde_json::from_value(json!({"requestId":request,"runId":run["id"],"stage":key,
        "gateId":gate["id"],"attemptId":gate["attemptId"],"decision":choice,"reason":"Reviewed the retained evidence"})).unwrap()
}

#[test]
fn successful_gate_releases_resources_survives_restart_and_notifies_once() {
    let (dir, s) = setup();
    let mut first = gated("train", &[]);
    first["exclusive"] = json!(true);
    first["gpu"] = json!({"memoryMiB":128});
    s.record_gpu_sample(json!({"source":"fixture","devices":[{"index":0,
        "uuid":"GPU-00000000-1111-2222-3333-444444444444","name":"Fixture GPU",
        "memoryTotalMiB":8192,"memoryFreeMiB":8192,"memoryUsedMiB":0,"utilizationPercent":0}]}))
        .unwrap();
    let run = create(&s, "gated", json!([first, stage("eval", &["train"])]));
    let train = start(&s);
    assert_eq!(train["reserved"], true);
    assert_eq!(train["gpuReservation"][0]["uuid"], "GPU-00000000-1111-2222-3333-444444444444");
    assert!(success(&s, &train, "aaa"));
    let run = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(run["status"], "waiting_analysis");
    assert_eq!(run["awaitingAnalysis"], true);
    assert!(run["settledAt"].is_null());
    assert!(run["idleAt"].is_string());
    let done = s.job(train["id"].as_str().unwrap()).unwrap();
    assert_eq!(done["status"], "succeeded");
    assert_eq!(done["reserved"], false);
    assert_eq!(done["result"]["artifacts"][0]["sha256"], "aaa");
    assert_eq!(s.active_jobs().unwrap().len(), 0);
    assert!(s.gpu_devices().unwrap()["devices"][0]["reservations"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(latest(&s, &run, "eval")["status"], "waiting");
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let messages = mail(&s);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["metadata"]["status"], "waiting_analysis");
    assert_eq!(messages[0]["metadata"]["gateId"], gate(&run, "train")["id"]);
    assert_eq!(messages[0]["metadata"]["attempt"], train["attempt"]);
    assert_eq!(messages[0]["metadata"]["artifacts"][0]["sha256"], "aaa");
    assert_eq!(messages[0]["notice"]["status"], "waiting_analysis");
    assert!(!success(&s, &train, "aaa"));
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert!(!s.advance_runs().unwrap());
    assert_eq!(s.run(run["id"].as_str().unwrap()).unwrap(), run);
    assert_eq!(mail(&s).len(), 1);
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let choice = decision(&run, "train", "continue", "continue");
    assert!(s
        .decide_run(Some("b"), &choice)
        .unwrap_err()
        .to_string()
        .contains("own runs"));
    let mut stale = choice.clone();
    stale.gate_id = "old-gate".into();
    assert!(s
        .decide_run(Some("a"), &stale)
        .unwrap_err()
        .to_string()
        .contains("stale_analysis_gate"));
    stale = choice.clone();
    stale.attempt_id = "old-attempt".into();
    assert!(s
        .decide_run(Some("a"), &stale)
        .unwrap_err()
        .to_string()
        .contains("stale_analysis_gate"));
    let continued = s.decide_run(Some("a"), &choice).unwrap();
    assert_eq!(continued["status"], "running");
    assert!(continued["idleAt"].is_null());
    assert_eq!(s.decide_run(Some("a"), &choice).unwrap(), continued);
    let other = decision(&run, "train", "continue", "cancel");
    assert!(s
        .decide_run(Some("a"), &other)
        .unwrap_err()
        .to_string()
        .contains("idempotency_conflict"));
    let eval = start(&s);
    assert_eq!(eval["run"]["stage"], "eval");
    assert_eq!(eval["upstream"][0]["artifacts"][0]["sha256"], "aaa");
    assert_eq!(eval["guardChecks"][0]["artifacts"][0]["sha256"], "aaa");
    assert!(success(&s, &eval, "bbb"));
    assert_eq!(
        s.run(run["id"].as_str().unwrap()).unwrap()["status"],
        "succeeded"
    );
    assert_eq!(mail(&s).len(), 2);
}

#[test]
fn gates_block_only_dependants_and_remain_listed_while_other_branches_run() {
    let (_dir, s) = setup();
    let run = create(
        &s,
        "branches",
        json!([gated("a", &[]), stage("b", &["a"]), stage("c", &[])]),
    );
    let a = start(&s);
    assert!(success(&s, &a, "aaa"));
    assert_eq!(latest(&s, &run, "b")["status"], "waiting");
    let c = start(&s);
    assert_eq!(c["run"]["stage"], "c");
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "running");
    let listed = s
        .list_runs(Some("a"), Some("T-1"), None, None, true)
        .unwrap();
    assert_eq!(listed["runs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["runs"][0]["awaitingAnalysis"], true);
    assert!(
        s.list_runs(Some("b"), None, None, None, true).unwrap()["runs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(success(&s, &c, "ccc"));
    let cancel = decision(&view, "a", "stop", "cancel");
    let stopped = s.decide_run(None, &cancel).unwrap();
    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(s.decide_run(None, &cancel).unwrap(), stopped);
    assert_eq!(latest(&s, &run, "a")["status"], "succeeded");
    assert_eq!(latest(&s, &run, "b")["status"], "cancelled");
    assert!(s.list_runs(None, None, None, None, true).unwrap()["runs"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn a_pending_gate_does_not_hide_a_failed_or_unknown_sibling() {
    for needs in [["a", "b"], ["b", "a"]] {
        for outcome in ["failed", "unknown"] {
            let (_dir, s) = setup();
            let run = create(
                &s,
                "blocked-sibling",
                json!([gated("a", &[]), stage("b", &[]), stage("join", &needs)]),
            );
            let a = start(&s);
            assert_eq!(a["run"]["stage"], "a");
            assert!(success(&s, &a, "aaa"));
            let b = start(&s);
            assert_eq!(b["run"]["stage"], "b");
            assert!(finish(&s, &b, outcome, exit("1"), json!({})));
            let join = latest(&s, &run, "join");
            assert_eq!(join["status"], "waiting");
            assert!(join["startedAt"].is_null());
            let reason = join["reason"].as_str().unwrap();
            assert!(reason.contains("Upstream stage b attempt 1"), "{reason}");
            assert!(reason.contains(outcome), "{reason}");
            let view = s.run(run["id"].as_str().unwrap()).unwrap();
            assert_eq!(gate(&view, "a")["state"], "waiting");
            assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
        }
    }
}

#[test]
fn final_stage_needs_a_decision_and_cancellation_wins_over_job_success() {
    for choice in ["continue", "cancel"] {
        let (_dir, s) = setup();
        let run = create(&s, "last", json!([gated("last", &[])]));
        let job = start(&s);
        assert!(success(&s, &job, "last"));
        let view = s.run(run["id"].as_str().unwrap()).unwrap();
        assert_eq!(view["status"], "waiting_analysis");
        assert!(view["settledAt"].is_null());
        let view = s
            .decide_run(None, &decision(&view, "last", "last", choice))
            .unwrap();
        assert_eq!(
            view["status"],
            if choice == "continue" {
                "succeeded"
            } else {
                "cancelled"
            }
        );
        assert!(view["settledAt"].is_string());
        assert_eq!(
            s.job(job["id"].as_str().unwrap()).unwrap()["status"],
            "succeeded"
        );
        assert_eq!(mail(&s).len(), 2);
    }
}

#[test]
fn simultaneous_continue_retries_and_cancel_never_duplicate_or_revive_work() {
    let (_dir, s) = setup();
    let run = create(&s, "race", json!([gated("a", &[]), stage("b", &["a"])]));
    success(&s, &start(&s), "aaa");
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    let choice = decision(&view, "a", "same", "continue");
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let (s, barrier, choice) = (s.clone(), barrier.clone(), choice.clone());
            std::thread::spawn(move || {
                barrier.wait();
                s.decide_run(Some("a"), &choice).unwrap()
            })
        })
        .collect();
    barrier.wait();
    for thread in threads {
        assert_eq!(thread.join().unwrap()["status"], "running");
    }
    assert_eq!(
        attempts(&s.run(run["id"].as_str().unwrap()).unwrap(), "b").len(),
        1
    );
    s.request_run_cancel(None, run["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        s.decide_run(Some("a"), &choice).unwrap()["status"],
        "cancelled"
    );
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());

    let run = create(
        &s,
        "cancel-race",
        json!([gated("a", &[]), stage("b", &["a"])]),
    );
    success(&s, &start(&s), "aaa");
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    let choice = decision(&view, "a", "race-continue", "continue");
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let other = {
        let (s, barrier) = (s.clone(), barrier.clone());
        std::thread::spawn(move || {
            barrier.wait();
            s.decide_run(Some("a"), &choice)
        })
    };
    barrier.wait();
    s.request_run_cancel(None, run["id"].as_str().unwrap())
        .unwrap();
    let _ = other.join().unwrap(); // Either serialized order is valid.
    assert_eq!(
        s.run(run["id"].as_str().unwrap()).unwrap()["status"],
        "cancelled"
    );
    assert_eq!(latest(&s, &run, "b")["status"], "cancelled");
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    assert!(s
        .decide_run(Some("a"), &decision(&view, "a", "new", "continue"))
        .is_err());
}

#[test]
fn reuse_creates_a_new_gate_not_an_inherited_decision_or_duplicate_notice_key() {
    let (_dir, s) = setup();
    let run = create(&s, "source", json!([gated("a", &[])]));
    let job = start(&s);
    success(&s, &job, "aaa");
    let old = s.run(run["id"].as_str().unwrap()).unwrap();
    s.decide_run(Some("a"), &decision(&old, "a", "old", "continue"))
        .unwrap();
    let mut reused = gated("a", &[]);
    reused["reuse"] = job["id"].clone();
    let request = input("reused", json!([reused]));
    let mut prepared = prepare(&request);
    let done = s.job(job["id"].as_str().unwrap()).unwrap();
    // The HTTP submission path verifies these bytes before create_run; this
    // fixture exercises the persisted gate lifecycle after that verification.
    prepared[0].reuse = Some(json!({"jobId":done["id"],"attempt":done["attempt"],
        "cwd":done["cwd"],"artifacts":done["result"]["artifacts"],"identity":done["identity"]["sha256"]}));
    let new = s
        .create_run(Some("a"), request, prepared, machine(), json!({}))
        .unwrap();
    assert_eq!(new["status"], "waiting_analysis");
    assert_ne!(gate(&new, "a")["id"], gate(&old, "a")["id"]);
    assert_eq!(gate(&new, "a")["jobId"], job["id"]);
    assert_eq!(gate(&new, "a")["execution"], "reused");
    assert!(attempts(&new, "a").is_empty());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    assert_eq!(
        s.list_runs(None, None, None, None, true).unwrap()["runs"][0]["id"],
        new["id"]
    );
    let notices: Vec<_> = mail(&s)
        .into_iter()
        .filter(|m| m["metadata"]["status"] == "waiting_analysis")
        .collect();
    assert_eq!(notices.len(), 2);
    assert_ne!(notices[0]["notice"]["key"], notices[1]["notice"]["key"]);
    let mut stale = decision(&old, "a", "stale", "continue");
    stale.run_id = new["id"].as_str().unwrap().into();
    assert!(s
        .decide_run(Some("a"), &stale)
        .unwrap_err()
        .to_string()
        .contains("stale_analysis_gate"));
    let new = s
        .decide_run(Some("a"), &decision(&new, "a", "new", "continue"))
        .unwrap();
    assert_eq!(new["status"], "succeeded");
    let completions = mail(&s);
    for (run, count) in [(&old, "1/1"), (&new, "0/0")] {
        let notice = completions.iter().find(|m|
            m["metadata"]["runId"] == run["id"] && m["metadata"]["status"] == "succeeded"
        ).unwrap();
        assert!(notice["body"].as_str().unwrap().contains(
            &format!("Resources ({count} attempts shown;")), "{}", notice["body"]);
    }
}

#[test]
fn analysis_continue_does_not_bypass_recorded_cost_limit() {
    let (_dir, s) = setup();
    let mut request =
        serde_json::to_value(input("cost", json!([gated("a", &[]), stage("b", &["a"])]))).unwrap();
    request["costLimitUsd"] = json!(0.5);
    let request: RunSubmit = serde_json::from_value(request).unwrap();
    let prepared = prepare(&request);
    let run = s
        .create_run(Some("a"), request, prepared, machine(), json!({}))
        .unwrap();
    let job = start(&s);
    finish(
        &s,
        &job,
        "succeeded",
        json!({"Result":"success","ExecMainStatus":"0"}),
        json!({"artifacts":[artifact("a.json", "aaa")],"cost":{"knownUsd":0.6,"unknownEntries":1}}),
    );
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    let result = s
        .decide_run(Some("a"), &decision(&view, "a", "over", "continue"))
        .unwrap();
    assert_eq!(result["status"], "blocked");
    assert_eq!(latest(&s, &run, "b")["status"], "waiting");
    assert!(latest(&s, &run, "b")["reason"]
        .as_str()
        .unwrap()
        .contains("soft limit"));
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
}

#[test]
fn a_gate_notification_failure_rolls_back_the_outcome_and_retry_sends_once() {
    let (_dir, s) = setup();
    let run = create(&s, "atomic", json!([gated("a", &[])]));
    let job = start(&s);
    s.db.write().unwrap().execute_batch("CREATE TRIGGER fail_gate_mail BEFORE INSERT ON collaboration_messages BEGIN SELECT RAISE(ABORT,'mail unavailable'); END;").unwrap();
    let evidence = json!({"jobId":job["id"],"attempt":job["attempt"],"status":"succeeded","reason":"success",
        "artifacts":[artifact("a.json", "aaa")],"evidence":{"systemd":{"Result":"success","ExecMainStatus":"0"}}});
    assert!(s
        .update_job_evidence(job["id"].as_str().unwrap(), evidence.clone())
        .is_err());
    assert_eq!(
        s.job(job["id"].as_str().unwrap()).unwrap()["reserved"],
        true
    );
    assert!(gate(&s.run(run["id"].as_str().unwrap()).unwrap(), "a").is_null());
    s.db.write()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_gate_mail;")
        .unwrap();
    assert!(s
        .update_job_evidence(job["id"].as_str().unwrap(), evidence.clone())
        .unwrap());
    assert!(!s
        .update_job_evidence(job["id"].as_str().unwrap(), evidence)
        .unwrap());
    assert_eq!(mail(&s).len(), 1);
}

#[tokio::test]
async fn update_drain_rejects_continue_but_accepts_gate_cancellation() {
    let (dir, s) = setup();
    let run = create(&s, "drain", json!([gated("a", &[])]));
    success(&s, &start(&s), "aaa");
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    drop(s);
    let ws = Workspace::new(
        dir.path().to_path_buf(),
        "/workspace".into(),
        "/usr/bin/false".into(),
    )
    .unwrap();
    // Store fixtures have no systemd processes; don't start the scheduler.
    ws.jobs.started.set(()).unwrap();
    ws.admission.begin_drain("update").unwrap();
    let request = serde_json::to_value(decision(&view, "a", "drain", "continue")).unwrap();
    let error = call(
        ws.clone(),
        Some("a".into()),
        "job_run_decide".into(),
        request,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("workspace_updating"));
    assert_eq!(
        gate(&ws.store.run(run["id"].as_str().unwrap()).unwrap(), "a")["state"],
        "waiting"
    );
    let request = serde_json::to_value(decision(&view, "a", "drain-cancel", "cancel")).unwrap();
    let result = call(
        ws.clone(),
        Some("a".into()),
        "job_run_decide".into(),
        request,
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "cancelled");
}
