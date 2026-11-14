//! YN-30: a run's stage stops at a checkpoint and resumes from it as a Job
//! does. The user's resume is the stage's next attempt in its run; its
//! dependants wait until it succeeds. Store-level, synthetic records only;
//! the wrapper's side is acceptance/local-jobs/checkpoint_host_test.py.
use super::*;

/// A stage whose command saves on SIGTERM and exits 75.
fn saving(key: &str, needs: &[&str]) -> Value {
    let mut value = stage(key, needs);
    value["timeoutSeconds"] = json!(3600);
    value["checkpoint"] = json!({"graceSeconds":60,"stoppedExitCode":75});
    value
}
/// The attempt reported running by the host.
fn running(s: &Store, job: &Value) {
    assert!(s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":job["attempt"],
        "status":"running","reason":"Running with verified cgroup limits","started":{"at":1792000000.0}})).unwrap());
}
fn verified(job: &Value) -> Value {
    json!({"ok":true,"reason":null,"dir":format!("/workspace/.yuzuno-checkpoints/{}", job["attempt"].as_str().unwrap()),
        "manifestSha256":"ab".repeat(32),"files":[{"path":"last.ckpt","bytes":12,"sha256":"cd".repeat(32)}],"exitCode":75})
}
/// The user's stop, delivered, and the attempt's end at a verified checkpoint.
fn stop_at_checkpoint(s: &Store, job: &Value) -> Value {
    let id = job["id"].as_str().unwrap();
    s.request_checkpoint_stop(id).unwrap();
    s.record_checkpoint_stop(id, &job["attempt"], &json!({"delivered":true,"request":{}})).unwrap();
    assert!(finish(s, job, "cancelled", json!({"Result":"exit-code","ExecMainStatus":"75"}),
        json!({"reason":"Stopped at the user's request at a verified checkpoint; only the user resumes it","checkpoint":verified(job)})));
    s.job(id).unwrap()
}
fn stage_of(run: &Value, key: &str) -> Value {
    run["stages"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap().clone()
}

#[test]
fn a_stopped_stage_waits_for_the_users_resume_and_its_dependant_with_it() {
    let (_dir, s) = setup();
    let run = create(&s, "stop", json!([saving("train", &[]), stage("eval", &["train"])]));
    let run_id = run["id"].as_str().unwrap();
    let train = start(&s);
    running(&s, &train);
    let stopped = stop_at_checkpoint(&s, &train);
    assert_eq!((stopped["status"].as_str(), stopped["checkpointStop"]["state"].as_str()), (Some("cancelled"), Some("checkpointed")));

    // The stage and the run read checkpointed; what needs it waits, idle.
    let view = s.run(run_id).unwrap();
    assert_eq!(view["status"], "checkpointed");
    assert_eq!(stage_of(&view, "train")["status"], "checkpointed");
    assert!(view["idleAt"].is_string(), "the safety net leaves it be");
    let eval = latest(&s, &run, "eval");
    assert_eq!(eval["status"], "waiting");
    assert!(eval["reason"].as_str().unwrap().contains("was stopped at a checkpoint by the user"), "{}", eval["reason"]);
    // Its own mail says only the user resumes it; the stop was told once before.
    let messages = mail(&s);
    let statuses: Vec<&str> = messages.iter().map(|m| m["metadata"]["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["checkpointStop", "cancelled"]);
    let body = messages[1]["body"].as_str().unwrap();
    assert!(body.contains("only the user resumes it") && body.contains("job_run_retry is refused") && body.contains("Not started and waiting: eval"), "{body}");

    // An Agent's retry would start it from scratch: refused. Nothing changed.
    let refused = s.retry_stage(Some("a"), "again", run_id, "train").unwrap_err().to_string();
    assert!(refused.contains("stopped at a checkpoint by the user; only the user resumes it"), "{refused}");
    assert_eq!(attempts(&s.run(run_id).unwrap(), "train").len(), 1);

    // The user's resume: the stage's next attempt, continuing from the checkpoint.
    let from = checkpoint::resumable(&stopped).unwrap();
    let next = s.resume_stage(stopped["id"].as_str().unwrap(), from.clone()).unwrap();
    assert_eq!((next["run"]["stage"].as_str(), next["run"]["attempt"].as_i64()), (Some("train"), Some(2)));
    assert_eq!(next["checkpointFrom"], from);
    assert_eq!(next["checkpointFrom"]["jobId"], stopped["id"]);
    assert!(next["retryOf"].is_null() && next.get("checkpointStop").is_none_or(Value::is_null), "{next}");
    assert_eq!(next["status"], "queued", "nothing upstream: released at once");
    assert_eq!(s.job(stopped["id"].as_str().unwrap()).unwrap()["checkpointStop"]["resumedAs"], next["id"]);
    // A repeat is the same attempt, told once.
    assert_eq!(s.resume_stage(stopped["id"].as_str().unwrap(), from).unwrap()["id"], next["id"]);
    let resumed: Vec<Value> = mail(&s).into_iter().filter(|m| m["metadata"]["status"] == "checkpointResumed").collect();
    assert_eq!(resumed.len(), 1);
    assert!(resumed[0]["body"].as_str().unwrap().contains("YUZUNO_RESUME_FROM"));
    let view = s.run(run_id).unwrap();
    assert_eq!(view["status"], "queued");
    assert_eq!(attempts(&view, "train")[1]["resumeOf"], stopped["id"]);

    // Once it succeeds, eval starts from its artifacts.
    let resumed = start(&s);
    assert_eq!(resumed["id"], next["id"]);
    assert!(success(&s, &resumed, "aaa"));
    let eval = latest(&s, &run, "eval");
    assert_eq!(eval["status"], "queued");
    assert_eq!(eval["upstream"][0]["jobId"], next["id"]);
}

#[test]
fn a_resumed_attempt_retried_for_an_interruption_resumes_from_the_same_checkpoint() {
    let (_dir, s) = setup();
    let mut train = saving("train", &[]);
    train["retry"] = json!({"attempts":3,"interrupted":true});
    let run = create(&s, "interrupted", json!([train]));
    let first = start(&s);
    running(&s, &first);
    let stopped = stop_at_checkpoint(&s, &first);
    let from = checkpoint::resumable(&stopped).unwrap();
    let resumed = s.resume_stage(stopped["id"].as_str().unwrap(), from.clone()).unwrap();
    let second = start(&s);
    assert_eq!(second["id"], resumed["id"]);
    assert_eq!(second["checkpointFrom"], from);
    // The host restarted under it: a declared retry, from the same checkpoint.
    assert!(finish(&s, &second, "interrupted", json!({"Result":"interrupted"}), json!({})));
    let third = latest(&s, &run, "train");
    assert_eq!(third["run"]["attempt"], 3);
    assert_eq!(third["retryOf"], second["id"]);
    assert_eq!(third["checkpointFrom"], from, "not from scratch");
    // Each attempt counts its own time from its own start.
    assert_eq!(third["timeoutSeconds"], 3600);
    assert!(third["startedAt"].is_null());
}

#[test]
fn a_stop_without_a_verified_checkpoint_is_never_retried_automatically_and_may_be_retried_fresh() {
    let (_dir, s) = setup();
    let mut train = saving("train", &[]);
    train["retry"] = json!({"attempts":3,"exitCodes":[75]});
    let run = create(&s, "unverified", json!([train]));
    let run_id = run["id"].as_str().unwrap();
    let first = start(&s);
    running(&s, &first);
    let id = first["id"].as_str().unwrap();
    s.request_checkpoint_stop(id).unwrap();
    s.record_checkpoint_stop(id, &first["attempt"], &json!({"delivered":true,"request":{}})).unwrap();
    // It exited 75, a code the stage declared retryable, without a manifest.
    assert!(finish(&s, &first, "failed", exit("75"), json!({"checkpoint":{"ok":false,"reason":"no manifest.json was written",
        "forward":{"problem":null},"exitCode":75}})));
    let ended = s.job(id).unwrap();
    assert_eq!(ended["checkpointStop"]["state"], "notResumable");
    assert!(ended["retriedBy"].is_null(), "a stop the user asked for is never retried automatically");
    let view = s.run(run_id).unwrap();
    assert_eq!(view["status"], "failed");
    assert_eq!(attempts(&view, "train").len(), 1);
    assert!(checkpoint::resumable(&ended).is_err());
    // Not resumable, so like a cancel: an explicit retry starts it afresh.
    let retried = s.retry_stage(Some("a"), "fresh", run_id, "train").unwrap();
    let second = attempts(&retried, "train")[1].clone();
    let second = s.job(second["id"].as_str().unwrap()).unwrap();
    assert!(second["checkpointFrom"].is_null() && second.get("checkpointStop").is_none_or(Value::is_null), "{second}");
    assert_eq!(second["checkpoint"], json!({"signal":"SIGTERM","graceSeconds":60,"stoppedExitCode":75}));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn only_the_user_resumes_a_stage_and_not_once_its_run_is_cancelled() {
    let (dir, s) = setup();
    let run = create(&s, "tool", json!([saving("train", &[]), saving("other", &[])]));
    let run_id = run["id"].as_str().unwrap().to_owned();
    // One at a time: the fixture budget holds one stage.
    let train = start(&s);
    running(&s, &train);
    let train = stop_at_checkpoint(&s, &train);
    let other = start(&s);
    assert_eq!(other["run"]["stage"], "other");
    running(&s, &other);
    let other = stop_at_checkpoint(&s, &other);
    drop(s);
    let ws = Workspace::new(dir.path().to_path_buf(), "/workspace".into(), "/usr/bin/false".into()).unwrap();
    // Store fixtures have no systemd processes; don't start the scheduler.
    ws.jobs.started.set(()).unwrap();
    let tool = |actor: Option<&str>, id: &Value| call(ws.clone(), actor.map(str::to_owned), "job_checkpoint_resume".into(), json!({"jobId":id}));
    let refused = tool(Some("a"), &train["id"]).await.unwrap_err().to_string();
    assert!(refused.contains("Only the user can resume"), "{refused}");
    let next = tool(None, &train["id"]).await.unwrap();
    assert_eq!((next["run"]["id"].as_str(), next["run"]["stage"].as_str(), next["run"]["attempt"].as_i64()),
        (Some(run_id.as_str()), Some("train"), Some(2)));
    assert_eq!(tool(None, &train["id"]).await.unwrap()["id"], next["id"], "a repeat is the same attempt");
    // Once the run is cancelled, the other stage's checkpoint no longer resumes.
    ws.store.request_run_cancel(None, &run_id).unwrap();
    let refused = tool(None, &other["id"]).await.unwrap_err().to_string();
    assert!(refused.contains("This run was cancelled"), "{refused}");
    assert_eq!(attempts(&ws.store.run(&run_id).unwrap(), "other").len(), 1);
}
