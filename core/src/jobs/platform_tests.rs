//! Local Jobs on a Core whose host cannot run them (T-88): macOS, as
//! `host::NOT_LINUX` makes one Core's data folder look while these tests run
//! on Linux. Local work is refused before the helper is written or run and
//! before anything is saved; a Job for a registered machine, the history and
//! the answers already given are unchanged.
use super::runs::{self, Prepared, RunSubmit};
use super::*;
use crate::{model::AgentDetail, remote::RemoteMachine};
use axum::response::IntoResponse;
use std::path::PathBuf;

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    data: PathBuf,
}
impl Lab {
    /// From now on this Core runs on macOS, as far as `host::local_host` can tell.
    fn on_macos(&self) {
        host::NOT_LINUX.lock().unwrap().push(self.data.clone());
    }
    fn helpers(&self) -> Vec<String> {
        std::fs::read_dir(self.data.join("jobs"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("host-"))
            .collect()
    }
    /// Local Jobs and runs in the Store, and its saved budget.
    fn saved(&self) -> (i64, i64, Option<String>) {
        use rusqlite::OptionalExtension;
        let db = self.ws.store.db.read().unwrap();
        let count = |table: &str| db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap();
        let budget = db.query_row("SELECT data FROM local_job_settings WHERE id=1", [], |r| r.get(0)).optional().unwrap();
        (count("local_jobs"), count("local_job_runs"), budget)
    }
    async fn call(&self, actor: Option<&str>, operation: &str, input: Value) -> Result<Value> {
        call(self.ws.clone(), actor.map(str::to_owned), operation.into(), input).await
    }
}
impl Drop for Lab {
    fn drop(&mut self) {
        host::NOT_LINUX.lock().unwrap().retain(|d| d != &self.data);
    }
}

fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused".into()).unwrap();
    // No scheduler: each test makes its calls itself.
    ws.jobs.started.set(()).unwrap();
    ws.store
        .add_machine(&RemoteMachine { id: "m1".into(), name: "lab box".into(), target: "lab-box.invalid".into(),
            codex: "codex".into(), default_cwd: "/home/u".into(), ..Default::default() })
        .unwrap();
    let on = serde_json::to_value(ws.store.machine("m1").unwrap()).unwrap();
    // `a` runs on this host, `r` on the registered machine m1.
    for (id, remote) in [("a", Value::Null), ("r", json!({"machine":on,"runtime":null}))] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"test","color":"sage",
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0,
            "remote":remote},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&agent).unwrap();
    }
    ws.store
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Jobs","status":"doing"}))
        .unwrap();
    Lab { _dir: dir, ws, data }
}

fn job(request: &str, extra: Value) -> Value {
    let mut job = json!({"requestId":request,"taskId":"T-1","name":request,"cwd":"/tmp","argv":["/usr/bin/true"],
        "resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0}});
    for (key, value) in extra.as_object().unwrap() {
        job[key] = value.clone();
    }
    job
}
fn run_input(request: &str) -> Value {
    json!({"requestId":request,"taskId":"T-1","name":"Fixture run","stages":[{"key":"prep","cwd":"/tmp","argv":["/usr/bin/true"],
        "resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0}}]})
}
fn machine() -> Value {
    json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}})
}
fn budget() -> Resources {
    Resources { cpu_millis: 1000, memory_mi_b: 1024, swap_mi_b: 0 }
}
async fn put_budget(ws: &Arc<Workspace>) -> Result<Value, String> {
    match set_budget(AppState(ws.clone()), Json(budget())).await {
        Ok(Json(value)) => Ok(value),
        Err(error) => {
            let body = axum::body::to_bytes(error.into_response().into_body(), usize::MAX).await.unwrap();
            Err(serde_json::from_slice::<Value>(&body).unwrap()["error"].as_str().unwrap().to_owned())
        }
    }
}
/// A run whose one stage failed, as a Linux Core would have saved it.
fn failed_run(s: &crate::store::Store) -> String {
    let input: RunSubmit = serde_json::from_value(run_input("earlier-run")).unwrap();
    let prepared: Vec<Prepared> = input.stages.iter().map(|stage| {
        let submit = input.submit(stage);
        let snapshot = json!({"cwd":"/tmp","git":null,"files":[]});
        let identity = runs::spec_identity(&submit, &snapshot, stage.needs());
        Prepared { submit, snapshot, identity, reuse: None, guard_exclude: vec![] }
    }).collect();
    let run = s.create_run(Some("a"), input, prepared, machine(), json!({"bootId":"boot"})).unwrap();
    let started = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(started["run"]["id"], run["id"], "the run's stage is the one started");
    s.update_job_evidence(started["id"].as_str().unwrap(), json!({"jobId":started["id"],"attempt":started["attempt"],
        "status":"failed","reason":"exit-code","evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"1"}}})).unwrap();
    run["id"].as_str().unwrap().to_owned()
}
/// A Job stopped at a verified checkpoint, which only the user resumes.
fn checkpointed(s: &crate::store::Store) -> String {
    let input = job("train", json!({"agentId":"a","env":{"PATH":"/usr/bin:/bin"},"timeoutSeconds":3600,
        "checkpoint":{"graceSeconds":60,"stoppedExitCode":75}}));
    let created = s.create_job(None, serde_json::from_value(input).unwrap(), json!({"cwd":"/tmp"}), machine(), json!({"bootId":"boot"})).unwrap();
    let id = created["id"].as_str().unwrap();
    let started = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(started["id"], created["id"], "this Job is the one started");
    s.update_job_evidence(id, json!({"jobId":started["id"],"attempt":started["attempt"],"status":"running",
        "reason":"Running with verified cgroup limits","started":{"at":1792000000.0}})).unwrap();
    s.request_checkpoint_stop(id).unwrap();
    s.record_checkpoint_stop(id, &started["attempt"], &json!({"delivered":true,"request":{}})).unwrap();
    s.update_job_evidence(id, json!({"jobId":started["id"],"attempt":started["attempt"],"status":"cancelled",
        "reason":"Stopped at the user's request at a verified checkpoint; only the user resumes it","finishedAtUnix":1792000100.0,
        "evidence":{},"artifacts":[],"cost":null,"progress":null,
        "checkpoint":{"ok":true,"reason":null,"dir":"/tmp/.yuzuno-checkpoints/c","manifestSha256":"ab".repeat(32),
            "files":[{"path":"last.ckpt","bytes":12,"sha256":"cd".repeat(32)}],"exitCode":75}})).unwrap();
    checkpoint::resumable(&s.job(id).unwrap()).unwrap();
    id.to_owned()
}

#[tokio::test]
async fn local_work_on_a_host_that_is_not_linux_is_refused_before_anything_is_written_run_or_saved() {
    let lab = lab();
    let stopped = checkpointed(&lab.ws.store);
    lab.on_macos();
    let refusal = host::local_host(&lab.data).unwrap_err().to_string();
    assert!(refusal.contains("Local Jobs need Linux with a systemd user manager, and this Core runs on macos"), "{refusal}");
    assert!(refusal.contains("nothing was written, run or queued on this host"), "{refusal}");
    let before = lab.saved();
    let decide = json!({"requestId":"go-on","runId":"run","stage":"prep","gateId":"gate","attemptId":"attempt","decision":"continue"});
    for (actor, operation, input) in [
        (None, "job_submit", job("here", json!({}))),
        (None, "job_submit", job("named-local", json!({"machineId":"local"}))),
        // `a` runs on this host: the alias resolves here, then is refused.
        (Some("a"), "job_submit", job("on-agent", json!({"machineId":"agent"}))),
        (Some("a"), "job_run_submit", run_input("run")),
        (None, "job_budget", json!({})),
        (Some("a"), "job_run_retry", json!({"requestId":"retry","runId":"run","stage":"prep"})),
        (Some("a"), "job_run_decide", decide),
        (None, "job_checkpoint_resume", json!({"jobId":stopped})),
    ] {
        let error = match lab.call(actor, operation, input).await {
            Err(error) => error.to_string(),
            Ok(value) => panic!("{operation} was not refused: {value}"),
        };
        assert_eq!(error, refusal, "{operation}");
    }
    assert_eq!(put_budget(&lab.ws).await, Err(refusal.clone()), "PUT budget");
    // Nothing written or run for them, and nothing saved.
    assert_eq!(lab.helpers(), Vec::<String>::new());
    assert!(lab.ws.jobs.gpu_sampled.lock().unwrap().is_none(), "no GPU sample through the helper");
    assert_eq!(lab.saved(), before);
    // Only the checkpointed Job made before, with the budget its machine suggested then.
    assert_eq!((before.0, before.1), (1, 0));
    assert_eq!(serde_json::from_str::<Value>(before.2.as_deref().unwrap()).unwrap(), machine()["suggestedBudget"]);
    assert!(lab.ws.store.job(&stopped).unwrap()["checkpointStop"]["resumedAs"].is_null());
}

#[tokio::test]
async fn on_such_a_host_a_registered_machine_the_history_and_answers_already_given_are_unchanged() {
    let lab = lab();
    let s = &lab.ws.store;
    // Answers given before, by a Linux Core with the same data: a retried
    // run, and a submit as job_submit saved it.
    let run = failed_run(s);
    let retried = s.retry_stage(Some("a"), "retried", &run, "prep").unwrap();
    let mut submitted: Submit = serde_json::from_value(job("kept", json!({"agentId":"a"}))).unwrap();
    submitted.validate().unwrap();
    submitted.default_env();
    let kept = s.create_job(None, submitted, json!({"cwd":"/tmp"}), machine(), json!({"bootId":"boot"})).unwrap();
    lab.on_macos();
    let before = lab.saved();
    // A repeated submit and a repeated retry get their earlier answers.
    assert_eq!(lab.call(None, "job_submit", job("kept", json!({"agentId":"a"}))).await.unwrap()["id"], kept["id"]);
    let again = lab.call(Some("a"), "job_run_retry", json!({"requestId":"retried","runId":run,"stage":"prep"})).await.unwrap();
    assert_eq!((again["id"].clone(), again["stages"][0]["attempts"].as_array().map(Vec::len)),
        (retried["id"].clone(), retried["stages"][0]["attempts"].as_array().map(Vec::len)));
    // A new retry would queue a stage here: refused.
    let refusal = host::local_host(&lab.data).unwrap_err().to_string();
    let another = lab.call(Some("a"), "job_run_retry", json!({"requestId":"another","runId":run,"stage":"prep"})).await;
    assert_eq!(another.map_err(|e| e.to_string()), Err(refusal), "a new retry");
    assert_eq!(lab.saved(), before, "repeats saved nothing new");
    // `r` runs on m1: its alias resolves there, and the Job is queued for m1.
    let remote = lab.call(Some("r"), "job_submit", job("on-m1", json!({"machineId":"agent","cwd":"/home/u","guardGit":false}))).await.unwrap();
    assert_eq!(remote["target"], json!({"requested":"agent","kind":"ssh","machineId":"m1","machineName":"lab box"}));
    assert_eq!((remote["status"].clone(), remote["executor"]["machineId"].clone()), (json!("queued"), json!("m1")));
    assert_eq!(lab.saved().0, before.0 + 1);
    // The history still reads.
    let listed = lab.call(None, "job_list", json!({})).await.unwrap();
    let ids: Vec<Value> = listed["jobs"].as_array().unwrap().iter().map(|j| j["id"].clone()).collect();
    assert!(ids.contains(&kept["id"]) && ids.contains(&remote["id"]), "{listed}");
    assert_eq!(lab.call(None, "job_get", json!({"jobId":kept["id"]})).await.unwrap()["id"], kept["id"]);
    assert_eq!(lab.call(None, "job_logs", json!({"jobId":kept["id"]})).await.unwrap()["totalBytes"], 0);
    assert_eq!(lab.helpers(), Vec::<String>::new());
}

#[tokio::test]
async fn on_linux_the_same_requests_go_on_as_before() {
    let lab = lab();
    host::local_host(&lab.data).unwrap();
    assert_eq!(put_budget(&lab.ws).await.unwrap(), json!(budget()));
    // Past the host check, each reaches the Store and its own answer.
    let retry = lab.call(Some("a"), "job_run_retry", json!({"requestId":"retry","runId":"missing","stage":"prep"})).await.unwrap_err().to_string();
    let decide = lab.call(Some("a"), "job_run_decide",
        json!({"requestId":"go-on","runId":"missing","stage":"prep","gateId":"gate","attemptId":"attempt","decision":"continue"})).await.unwrap_err().to_string();
    let refusal = "Local Jobs need Linux";
    assert!(!retry.contains(refusal) && !decide.contains(refusal), "{retry} / {decide}");
    let run = failed_run(&lab.ws.store);
    let retried = lab.call(Some("a"), "job_run_retry", json!({"requestId":"retry","runId":run,"stage":"prep"})).await.unwrap();
    assert_eq!(retried["stages"][0]["attempts"].as_array().map(Vec::len), Some(2), "{retried}");
    let helper = host::helper(&lab.data).await.unwrap();
    assert_eq!(std::fs::read(helper).unwrap(), include_bytes!("host.py"));
}
