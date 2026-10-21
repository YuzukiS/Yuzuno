//! Stop at a checkpoint and resume from it, as Core records them (T-109).
//! The wrapper's side (forwarding the signal, verifying the checkpoint) is
//! acceptance/local-jobs/checkpoint_host_test.py, run by the last test here.
use super::*;
use crate::{model::AgentDetail, store::Store};

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
    store
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Training","status":"doing"}))
        .unwrap();
    (dir, store)
}
fn request(id: &str) -> Value {
    json!({"requestId":id,"taskId":"T-1","name":"Train","cwd":"/workspace","argv":["/usr/bin/python3","train.py"],
        "env":{"PATH":"/usr/bin:/bin"},"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},"timeoutSeconds":3600,
        "checkpoint":{"graceSeconds":60,"stoppedExitCode":75}})
}
fn machine() -> Value {
    json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}})
}
fn create(s: &Store, input: Submit) -> Value {
    s.create_job(None, input, json!({"cwd":"/workspace"}), machine(), json!({"bootId":"boot"})).unwrap()
}
/// A Job with a checkpoint that the host reports running.
fn running(s: &Store, request_id: &str) -> Value {
    let mut submitted = request(request_id);
    submitted["agentId"] = json!("a");
    let job = create(s, serde_json::from_value(submitted).unwrap());
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    let id = job["id"].as_str().unwrap();
    s.update_job_evidence(id, json!({"jobId":job["id"],"attempt":job["attempt"],"status":"running","reason":"Running with verified cgroup limits","started":{"at":1792000000.0}}))
        .unwrap();
    s.job(id).unwrap()
}
fn mail(s: &Store) -> Vec<Value> {
    s.collaboration_call(Some("a"), "peer_read", json!({})).unwrap()["messages"]
        .as_array()
        .unwrap()
        .clone()
}
/// The host's terminal evidence, with what the wrapper checked.
fn ended(job: &Value, status: &str, reason: &str, checkpoint: Value) -> Value {
    json!({"jobId":job["id"],"attempt":job["attempt"],"status":status,"reason":reason,"finishedAtUnix":1792000100.0,
        "evidence":{},"artifacts":[],"cost":null,"progress":null,"checkpoint":checkpoint})
}
fn past_deadline(s: &Store, id: &str) {
    let db = s.db.write().unwrap();
    let mut saved = store::get(&db, id).unwrap();
    saved["checkpointStop"]["deadline"] = json!("2026-01-01T00:00:00+00:00");
    store::save(&db, &saved).unwrap();
}
fn verified(job: &Value) -> Value {
    json!({"ok":true,"reason":null,"dir":format!("/workspace/.yuzuno-checkpoints/{}", job["attempt"].as_str().unwrap()),
        "manifestSha256":"ab".repeat(32),"files":[{"path":"last.ckpt","bytes":12,"sha256":"cd".repeat(32)}],"exitCode":75})
}

#[test]
fn a_checkpoint_is_declared_for_this_host_only_and_its_protocol_is_checked() {
    let parse = |value: Value| serde_json::from_value::<Submit>(value);
    let ok = parse(request("ok")).unwrap();
    ok.validate().unwrap();
    assert_eq!(ok.checkpoint.as_ref().unwrap().signal, "SIGTERM", "SIGTERM unless declared");
    for (field, value, why) in [
        ("signal", json!("SIGKILL"), "SIGTERM, SIGINT or SIGUSR1"),
        ("graceSeconds", json!(9), "10–900"),
        ("graceSeconds", json!(901), "10–900"),
        ("stoppedExitCode", json!(0), "never 0"),
        ("stoppedExitCode", json!(126), "1–125"),
    ] {
        let mut bad = request("bad");
        bad["checkpoint"][field] = value;
        let error = parse(bad).unwrap().validate().unwrap_err().to_string();
        assert!(error.contains(why), "{field}: {error}");
    }
    let mut short = request("short");
    short["timeoutSeconds"] = json!(60);
    assert!(parse(short).unwrap().validate().unwrap_err().to_string().contains("shorter than timeoutSeconds"));
    let mut remote = request("remote");
    remote["machineId"] = json!("lab");
    assert!(parse(remote).unwrap().validate().unwrap_err().to_string().contains("this Core's host only"));
    let mut unknown = request("unknown");
    unknown["checkpoint"]["dir"] = json!("/elsewhere");
    assert!(parse(unknown).is_err());
    // Only the user's resume sets what a Job resumes from.
    let mut forged = request("forged");
    forged["checkpointFrom"] = json!({"jobId":"other","dir":"/workspace"});
    assert!(parse(forged).is_err());
    // job_submit offers it; a run's stages do not, and refuse it.
    let definitions = tool_definitions();
    let tool = |name: &str| definitions.iter().find(|d| d["name"] == name).unwrap().clone();
    let declared = &tool("job_submit")["inputSchema"]["properties"]["checkpoint"];
    assert_eq!(declared["required"], json!(["graceSeconds", "stoppedExitCode"]));
    assert_eq!(declared["properties"]["signal"]["enum"], json!(["SIGTERM", "SIGINT", "SIGUSR1"]));
    let stage = &tool("job_run_submit")["inputSchema"]["properties"]["stages"]["items"]["properties"];
    assert!(stage.get("checkpoint").is_none() && stage.get("key").is_some(), "{stage}");
    let run = json!({"requestId":"run","taskId":"T-1","name":"Run","stages":[{"key":"train","cwd":"/workspace","argv":["/usr/bin/true"],
        "resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},"checkpoint":{"graceSeconds":60,"stoppedExitCode":75}}]});
    assert!(serde_json::from_value::<runs::RunSubmit>(run).is_err());
}

#[test]
fn a_stop_is_saved_before_the_host_acts_told_once_and_excludes_pause() {
    let (_dir, s) = setup();
    let job = running(&s, "train");
    let id = job["id"].as_str().unwrap();
    let (requested, act) = s.request_checkpoint_stop(id).unwrap();
    assert!(act);
    assert_eq!(requested["checkpointStop"]["state"], "requested");
    assert_eq!(requested["checkpointStop"]["graceSeconds"], 60);
    assert!(requested["checkpointStop"]["deadline"].is_string());
    // Lifecycle and reservation are untouched until the attempt ends.
    assert_eq!((requested["status"].clone(), requested["reserved"].clone()), (json!("running"), json!(true)));
    let answer = json!({"delivered":true,"request":{"attempt":job["attempt"],"nonce":"00"},"thawed":null,"reason":null});
    let signalled = s.record_checkpoint_stop(id, &job["attempt"], &answer).unwrap();
    assert_eq!(signalled["checkpointStop"]["state"], "signalled");
    assert!(signalled["checkpointStop"]["reason"].as_str().unwrap().contains("Sent SIGTERM"));
    let notices = mail(&s);
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["metadata"]["status"], "checkpointStop");
    let body = notices[0]["body"].as_str().unwrap();
    assert!(body.contains("stopped at a checkpoint by the user") && body.contains("Do not resubmit") && body.contains("exit 75"), "{body}");
    // A delivered stop is not sent again; a stopping job is not paused.
    let (again, act) = s.request_checkpoint_stop(id).unwrap();
    assert!(!act);
    assert_eq!(again["checkpointStop"], signalled["checkpointStop"]);
    assert!(s.request_job_pause(id, false).unwrap_err().to_string().contains("being stopped at a checkpoint"));
    assert_eq!(mail(&s).len(), 1);
    let listed = &s.list_jobs(None, None, None).unwrap()["jobs"][0];
    assert_eq!(listed["checkpointStop"]["state"], "signalled");
    assert_eq!(listed["checkpoint"]["stoppedExitCode"], 75);
}

#[test]
fn only_a_running_unpaused_job_that_declared_a_checkpoint_is_stopped_at_one() {
    let (_dir, s) = setup();
    let job = running(&s, "train");
    let id = job["id"].as_str().unwrap();
    let plain: Submit = serde_json::from_value({
        let mut plain = request("plain");
        plain.as_object_mut().unwrap().remove("checkpoint");
        plain["agentId"] = json!("a");
        plain
    })
    .unwrap();
    let plain = create(&s, plain);
    assert!(s.request_checkpoint_stop(plain["id"].as_str().unwrap()).unwrap_err().to_string().contains("declared no checkpoint"));
    s.request_job_pause(id, false).unwrap();
    assert!(s.request_checkpoint_stop(id).unwrap_err().to_string().contains("Resume the job first"));
    assert!(s.job(id).unwrap()["checkpointStop"].is_null());
}

#[test]
fn past_its_grace_period_a_stop_becomes_a_cancel_and_the_end_is_not_resumable() {
    let (_dir, s) = setup();
    let job = running(&s, "train");
    let id = job["id"].as_str().unwrap();
    s.request_checkpoint_stop(id).unwrap();
    s.record_checkpoint_stop(id, &job["attempt"], &json!({"delivered":true,"request":{}})).unwrap();
    assert!(s.due_checkpoint_stops().unwrap().is_empty(), "within its grace period nothing is due");
    assert!(!s.expire_checkpoint_stop(id, &job["attempt"]).unwrap());
    past_deadline(&s, id);
    let due = s.due_checkpoint_stops().unwrap();
    assert_eq!(due.iter().map(|j| j["id"].clone()).collect::<Vec<_>>(), [job["id"].clone()]);
    assert!(!s.expire_checkpoint_stop(id, &json!("another attempt")).unwrap(), "only the attempt that was due");
    assert!(s.expire_checkpoint_stop(id, &job["attempt"]).unwrap());
    let expired = s.job(id).unwrap();
    assert_eq!(expired["checkpointStop"]["state"], "expired");
    assert_eq!(expired["status"], "cancelling");
    assert!(expired["cancelRequestedAt"].is_string());
    assert_eq!(expired["reserved"], true, "held until the process groups have exited");
    assert!(s.due_checkpoint_stops().unwrap().is_empty() && !s.expire_checkpoint_stop(id, &job["attempt"]).unwrap(), "expired once");
    s.update_job_evidence(id, ended(&job, "cancelled", "Cancellation confirmed: launcher and worker groups have exited.", Value::Null))
        .unwrap();
    let done = s.job(id).unwrap();
    assert_eq!((done["status"].clone(), done["reserved"].clone()), (json!("cancelled"), json!(false)));
    assert_eq!(done["checkpointStop"]["state"], "notResumable");
    assert!(done["reason"].as_str().unwrap().contains("cannot be resumed"), "{}", done["reason"]);
    let told = mail(&s).into_iter().find(|m| m["metadata"]["status"] == "cancelled").unwrap();
    assert!(told["body"].as_str().unwrap().contains("without a verified checkpoint"));
    assert!(checkpoint::resumable(&done).unwrap_err().to_string().contains("No verified checkpoint"));
}

#[tokio::test]
async fn once_its_command_has_exited_the_check_of_its_files_is_not_cancelled() {
    // The wrapper writes checkpoint-exit.json when the command exits, before
    // it hashes the checkpoint: the grace period ends there (review bdcb4d39).
    let dir = tempfile::tempdir().unwrap();
    let job = json!({"id": uuid::Uuid::new_v4().to_string(), "attempt": "a1"});
    assert!(!host::command_exited(dir.path(), &job).await, "no record: not known to have exited");
    let folder = dir.path().join("jobs").join(job["id"].as_str().unwrap());
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("checkpoint-exit.json"), r#"{"attempt":"a0","exitCode":75}"#).unwrap();
    assert!(!host::command_exited(dir.path(), &job).await, "another attempt's exit");
    std::fs::write(folder.join("checkpoint-exit.json"), r#"{"attempt":"a1","exitCode":75}"#).unwrap();
    assert!(host::command_exited(dir.path(), &job).await);
}

#[tokio::test]
async fn a_resume_is_new_work_and_is_refused_during_an_update_drain_as_a_submit_is() {
    // Round 2 of the review (454355ab): resume queues a Job, so it needs
    // the same work admission as job_submit.
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.admission.begin_drain("t109-drain").unwrap();
    let resume = |ws: &Arc<Workspace>| call(ws.clone(), None, "job_checkpoint_resume".into(), json!({"jobId":"missing"}));
    let refused = resume(&ws).await.unwrap_err().to_string();
    let submit = call(ws.clone(), None, "job_submit".into(), json!({})).await.unwrap_err().to_string();
    assert_eq!(refused, submit, "refused the way a submit is");
    ws.admission.reopen("t109-drain").unwrap();
    // Admitted again: it gets as far as looking for the job.
    let admitted = resume(&ws).await.unwrap_err().to_string();
    assert_ne!(admitted, refused, "{admitted}");
}

#[test]
fn a_job_that_ends_before_the_stop_reaches_its_command_keeps_its_own_reason() {
    let (_dir, s) = setup();
    let job = running(&s, "train");
    let id = job["id"].as_str().unwrap();
    s.request_checkpoint_stop(id).unwrap();
    s.record_checkpoint_stop(id, &job["attempt"], &json!({"delivered":false,"reason":"systemd did not signal the wrapper"})).unwrap();
    let unsent = json!({"ok":false,"reason":"the command exited 0, not the declared stopped code 75","forward":null});
    s.update_job_evidence(id, ended(&job, "succeeded", "success", unsent)).unwrap();
    let done = s.job(id).unwrap();
    assert_eq!((done["status"].clone(), done["reason"].clone()), (json!("succeeded"), json!("success")));
    assert_eq!(done["checkpointStop"]["state"], "notResumable");
    assert!(done["checkpointStop"]["reason"].as_str().unwrap().starts_with("The job ended before the stop reached its command"));
    // One the signal reached is the user's stop, whatever its exit.
    let other = running(&s, "other");
    let other_id = other["id"].as_str().unwrap();
    s.request_checkpoint_stop(other_id).unwrap();
    s.record_checkpoint_stop(other_id, &other["attempt"], &json!({"delivered":true,"request":{}})).unwrap();
    let sent = json!({"ok":false,"reason":"the command exited 0, not the declared stopped code 75","forward":{"signal":"SIGTERM","pid":7}});
    s.update_job_evidence(other_id, ended(&other, "succeeded", "success", sent)).unwrap();
    let stopped = s.job(other_id).unwrap();
    assert!(stopped["reason"].as_str().unwrap().starts_with("Stopped at the user's request without a verified checkpoint"), "{}", stopped["reason"]);
}

#[test]
fn a_verified_checkpoint_ends_the_job_and_resumes_as_a_new_linked_job_once() {
    let (_dir, s) = setup();
    let job = running(&s, "train");
    let id = job["id"].as_str().unwrap();
    assert!(checkpoint::resumable(&job).unwrap_err().to_string().contains("not ended"));
    s.request_checkpoint_stop(id).unwrap();
    s.record_checkpoint_stop(id, &job["attempt"], &json!({"delivered":true,"request":{}})).unwrap();
    let reason = "Stopped at the user's request at a verified checkpoint; only the user resumes it";
    s.update_job_evidence(id, ended(&job, "cancelled", reason, verified(&job))).unwrap();
    let stopped = s.job(id).unwrap();
    assert_eq!((stopped["status"].clone(), stopped["reserved"].clone()), (json!("cancelled"), json!(false)));
    assert_eq!(stopped["checkpointStop"]["state"], "checkpointed");
    assert_eq!(stopped["reason"], reason);
    let from = checkpoint::resumable(&stopped).unwrap();
    assert_eq!(from["jobId"], stopped["id"]);
    assert_eq!(from["files"][0]["path"], "last.ckpt");
    let mut input = checkpoint::submission(&stopped).unwrap();
    input.checkpoint_from = Some(from.clone());
    input.validate().unwrap();
    assert!(s.previous_job(None, &input).unwrap().is_none());
    let next = create(&s, input.clone());
    // The same command, task and Agent; a new Job, attempt and checkpoint folder.
    for field in ["argv", "env", "resources", "timeoutSeconds", "checkpoint", "taskId", "agentId"] {
        assert_eq!(next[field], stopped[field], "{field}");
    }
    assert_ne!(next["id"], stopped["id"]);
    assert_ne!(next["attempt"], stopped["attempt"]);
    assert_eq!(next["checkpointFrom"], from);
    assert_eq!(next["status"], "queued");
    // A repeated resume finds the same Job and tells the Agent once.
    assert_eq!(s.previous_job(None, &input).unwrap().unwrap()["id"], next["id"]);
    let next_id = next["id"].as_str().unwrap();
    let linked = s.link_resumed(id, next_id).unwrap();
    assert_eq!(linked["id"], next["id"]);
    s.link_resumed(id, next_id).unwrap();
    assert_eq!(s.job(id).unwrap()["checkpointStop"]["resumedAs"], next_id);
    let resumed: Vec<Value> = mail(&s).into_iter().filter(|m| m["metadata"]["status"] == "checkpointResumed").collect();
    assert_eq!(resumed.len(), 1);
    assert!(resumed[0]["body"].as_str().unwrap().contains("YUZUNO_RESUME_FROM"));
    let listed = s.list_jobs(None, None, None).unwrap();
    let row = listed["jobs"].as_array().unwrap().iter().find(|j| j["id"] == next["id"]).unwrap();
    assert_eq!(row["resumeOf"], stopped["id"]);
    // Only the job it resumes is linked.
    let mut other = request("other");
    other["agentId"] = json!("a");
    let other = create(&s, serde_json::from_value(other).unwrap());
    assert!(s.link_resumed(other["id"].as_str().unwrap(), next_id).is_err());
}

#[test]
fn wrapper_forwards_the_stop_and_verifies_the_checkpoint() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../acceptance/local-jobs/checkpoint_host_test.py");
    let output = std::process::Command::new("/usr/bin/python3").arg(script).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}
