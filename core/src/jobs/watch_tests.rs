//! T-59: Core reads its local Jobs' own files on each tick and starts the host
//! helper only when they call for it. Synthetic records, a cgroup tree of the
//! test's own and a stand-in helper that logs each run; no systemd.
use super::*;
use crate::model::AgentDetail;
use std::path::PathBuf;

/// The stand-in helper: logs `mode job-folder` beside the Jobs' folders and
/// answers what the job's folder holds for that mode (`answer-<mode>.json`).
const STUB: &str = r#"import pathlib, sys
spec = pathlib.Path(sys.argv[2])
with open(spec.parent.parent / 'helper-runs', 'a') as log:
    log.write(sys.argv[1] + ' ' + spec.parent.name + '\n')
answer = spec.parent / ('answer-' + sys.argv[1] + '.json')
print(answer.read_text() if answer.exists() else '{}')
"#;

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    root: PathBuf,
}

impl Drop for Lab {
    fn drop(&mut self) {
        host::CGROUPS.lock().unwrap().retain(|(dir, _)| *dir != self.ws.data_dir);
        host::HELPERS.lock().unwrap().retain(|(dir, _)| *dir != self.ws.data_dir);
    }
}

fn boot() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim().to_owned()
}

fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/workspace".into(), "unused".into()).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Training outcome","status":"doing"})).unwrap();
    let root = dir.path().join("cgroup");
    let stub = dir.path().join("stub-helper.py");
    std::fs::write(&stub, STUB).unwrap();
    host::CGROUPS.lock().unwrap().push((ws.data_dir.clone(), root.clone()));
    host::HELPERS.lock().unwrap().push((ws.data_dir.clone(), stub));
    Lab { _dir: dir, ws, root }
}

/// A reserved attempt, queued under `boot`.
fn reserved(lab: &Lab, name: &str, boot: &str) -> Value {
    let input: Submit = serde_json::from_value(json!({"requestId":name,"taskId":"T-1","name":name,"cwd":"/workspace","argv":["/usr/bin/sleep","600"],
        "resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0}})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":8192,"swapMiB":0}});
    lab.ws.store.create_job(Some("a"), input, json!({"cwd":"/workspace"}), machine, json!({"bootId": boot})).unwrap();
    lab.ws.store.reserve_next_job(None, None, None).unwrap().unwrap()
}

fn id(job: &Value) -> String {
    job["id"].as_str().unwrap().to_owned()
}

fn now(lab: &Lab, job: &Value) -> Value {
    lab.ws.store.job(&id(job)).unwrap()
}

fn folder(lab: &Lab, job: &Value) -> PathBuf {
    host::folder(&lab.ws.data_dir, job).unwrap()
}

fn write(path: PathBuf, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value.to_string()).unwrap();
}

/// One unit's cgroup as the test wants it: `live`, `frozen`, `empty`, `gone`
/// or `unreadable` (its cgroup.events a directory).
fn set(lab: &Lab, group: &str, state: &str) {
    let dir = lab.root.join(group.trim_start_matches('/'));
    let _ = std::fs::remove_dir_all(&dir);
    if state == "gone" {
        return;
    }
    std::fs::create_dir_all(&dir).unwrap();
    match state {
        "unreadable" => std::fs::create_dir(dir.join("cgroup.events")).unwrap(),
        _ => std::fs::write(dir.join("cgroup.events"), match state {
            "live" => "populated 1\nfrozen 0\n",
            "frozen" => "populated 1\nfrozen 1\n",
            _ => "populated 0\nfrozen 0\n",
        }).unwrap(),
    }
}

fn worker(job: &Value) -> String {
    format!("/t59/{}-worker", id(job))
}

fn collector(job: &Value) -> String {
    format!("/t59/{}-collector", id(job))
}

/// The records of an attempt whose collector started its worker, both
/// running; the helper's `reconcile` answers as for a running worker.
fn started(lab: &Lab, job: &Value, with_command: bool) -> Value {
    let dir = folder(lab, job);
    let (attempt, boot) = (&job["attempt"], &job["bootId"]);
    write(dir.join("dispatched.json"), &json!({"jobId":job["id"],"attempt":attempt,"bootId":boot}));
    write(dir.join("spec.json"), job);
    write(dir.join("launch.json"), &json!({"attempt":attempt,"bootId":boot,"at":1.0,"controlGroup":collector(job)}));
    let proof = json!({"jobId":job["id"],"attempt":attempt,"bootId":boot,"invocationId":"invocation","controlGroup":worker(job),"pid":1,"at":1.0});
    write(dir.join("started.json"), &proof);
    if with_command {
        command(lab, job);
    }
    set(lab, &worker(job), "live");
    set(lab, &collector(job), "live");
    answer(lab, job, "reconcile", json!({"status":"unresolved","systemd":{"SubState":"running","InvocationID":"invocation"},
        "supervisor":{"ActiveState":"active"},"started":proof,"freezer":{"populated":true,"frozen":false},
        "command": if with_command { json!({"attempt":attempt,"pid":2,"startedAt":1.0}) } else { Value::Null }}));
    proof
}

fn command(lab: &Lab, job: &Value) {
    write(folder(lab, job).join("command.json"), &json!({"attempt":job["attempt"],"pid":2,"startedAt":1.0}));
}

fn answer(lab: &Lab, job: &Value, mode: &str, value: Value) {
    write(folder(lab, job).join(format!("answer-{mode}.json")), &value);
}

/// An outcome as the collector records it.
fn outcome(job: &Value, status: &str) -> Value {
    json!({"jobId":job["id"],"attempt":job["attempt"],"bootId":job["bootId"],"status":status,"reason":status,"finishedAtUnix":2.0,"evidence":{}})
}

/// The helper's runs so far for this attempt, as `mode`s.
fn runs(lab: &Lab, job: &Value) -> Vec<String> {
    let log = std::fs::read_to_string(lab.ws.data_dir.join("jobs").join("helper-runs")).unwrap_or_default();
    let id = id(job);
    log.lines().filter_map(|line| line.strip_suffix(&format!(" {id}")).map(str::to_owned)).collect()
}

async fn ticks(lab: &Lab, n: usize) {
    for _ in 0..n {
        tick(&lab.ws).await.unwrap();
    }
}

/// Two Jobs running for 90 ticks (3 minutes of Core's 2 s tick) start the
/// helper once each, for their start, and none after; an ended one starts it
/// once more, to settle (the bound per attempt the PR states).
#[tokio::test]
async fn two_running_jobs_start_no_helper_process_after_their_start() {
    let lab = lab();
    let one = reserved(&lab, "one", &boot());
    let two = reserved(&lab, "two", &boot());
    started(&lab, &one, true);
    started(&lab, &two, true);
    ticks(&lab, 1).await;
    assert_eq!((runs(&lab, &one), runs(&lab, &two)), (vec!["reconcile".to_owned()], vec!["reconcile".to_owned()]), "one run each for the start");
    assert_eq!((now(&lab, &one)["status"].clone(), now(&lab, &two)["status"].clone()), (json!("running"), json!("running")));
    ticks(&lab, 89).await;
    assert_eq!((runs(&lab, &one).len(), runs(&lab, &two).len()), (1, 1), "no helper process after the start while two Jobs run");
    // The first ends: its collector records the outcome and both units go.
    write(folder(&lab, &one).join("result.json"), &outcome(&one, "succeeded"));
    answer(&lab, &one, "reconcile", outcome(&one, "succeeded"));
    set(&lab, &worker(&one), "gone");
    set(&lab, &collector(&one), "gone");
    ticks(&lab, 10).await;
    assert_eq!(runs(&lab, &one), ["reconcile", "reconcile"], "one helper run to settle an ended attempt");
    assert_eq!((now(&lab, &one)["status"].clone(), now(&lab, &one)["reserved"].clone()), (json!("succeeded"), json!(false)));
    assert_eq!(runs(&lab, &two).len(), 1, "the other still starts none");
}

/// Nothing is kept across a restart: a Core that starts reads the files and
/// asks what they call for, so an attempt that ended while it was down is
/// settled on its first tick.
#[tokio::test]
async fn an_attempt_that_ended_while_core_was_down_is_settled_on_its_first_tick() {
    let lab = lab();
    let job = reserved(&lab, "restart", &boot());
    started(&lab, &job, true);
    ticks(&lab, 2).await;
    assert_eq!(now(&lab, &job)["status"], "running");
    lab.ws.jobs.watch.reset();
    write(folder(&lab, &job).join("result.json"), &outcome(&job, "failed"));
    answer(&lab, &job, "reconcile", outcome(&job, "failed"));
    set(&lab, &worker(&job), "gone");
    set(&lab, &collector(&job), "gone");
    ticks(&lab, 1).await;
    assert_eq!(now(&lab, &job)["status"], "failed", "an attempt that ended while Core was down is settled on its first tick");
}

/// The collector killed: Core asks once, then, once the worker's group
/// empties with no outcome recorded, asks again and settles it itself.
#[tokio::test]
async fn a_job_whose_collector_died_is_settled_by_core_once_its_worker_group_empties() {
    let lab = lab();
    let job = reserved(&lab, "collector", &boot());
    started(&lab, &job, true);
    ticks(&lab, 1).await;
    set(&lab, &collector(&job), "gone");
    ticks(&lab, 10).await;
    assert_eq!(runs(&lab, &job).len(), 2, "asked once when its collector went");
    assert_eq!(now(&lab, &job)["status"], "running", "its worker still runs");
    answer(&lab, &job, "reconcile", outcome(&job, "failed"));
    set(&lab, &worker(&job), "empty");
    ticks(&lab, 1).await;
    assert_eq!(runs(&lab, &job).len(), 3);
    assert_eq!(now(&lab, &job)["status"], "failed", "settled by Core once its worker group empties");
}

/// A cgroup file that can't be read is never taken as running.
#[tokio::test]
async fn an_unreadable_group_is_checked_through_the_helper_not_taken_as_running() {
    let lab = lab();
    let job = reserved(&lab, "unreadable", &boot());
    started(&lab, &job, true);
    ticks(&lab, 3).await;
    assert_eq!(runs(&lab, &job).len(), 1);
    set(&lab, &worker(&job), "unreadable");
    ticks(&lab, 1).await;
    assert_eq!(runs(&lab, &job).len(), 2, "an unreadable group is checked through the helper, not taken as running");
}

/// An attempt of another boot is asked about, never read as running from
/// its files.
#[tokio::test]
async fn a_boot_change_is_asked_about_not_read_as_running() {
    let lab = lab();
    let job = reserved(&lab, "boot", "an-earlier-boot");
    started(&lab, &job, true);
    ticks(&lab, 1).await;
    assert_eq!(now(&lab, &job)["status"], "running");
    answer(&lab, &job, "reconcile", outcome(&job, "interrupted"));
    lab.ws.jobs.watch.rewind(Duration::from_secs(2));
    ticks(&lab, 1).await;
    assert_eq!(now(&lab, &job)["status"], "interrupted", "another boot is asked about, never read as running");
}

/// A cancel is sent once, and again only when its units' groups change.
#[tokio::test]
async fn a_cancel_is_sent_once_and_again_only_when_its_groups_change() {
    let lab = lab();
    let job = reserved(&lab, "cancel", &boot());
    started(&lab, &job, true);
    ticks(&lab, 1).await;
    lab.ws.store.request_job_cancel(Some("a"), &id(&job)).unwrap();
    answer(&lab, &job, "cancel", json!({"status":"settling","reason":"Outcome saved; waiting for worker and collector groups to exit"}));
    ticks(&lab, 10).await;
    let cancels = |lab: &Lab| runs(lab, &job).into_iter().filter(|mode| mode == "cancel").count();
    assert_eq!(cancels(&lab), 1, "a cancel is sent once");
    answer(&lab, &job, "cancel", outcome(&job, "cancelled"));
    set(&lab, &worker(&job), "gone");
    set(&lab, &collector(&job), "gone");
    ticks(&lab, 1).await;
    assert_eq!(cancels(&lab), 2, "and again when its groups change");
    assert_eq!(now(&lab, &job)["status"], "cancelled");
}

/// An unknown outcome that stays so is checked again after 2 s, then 4 s, …,
/// never on every tick.
#[tokio::test]
async fn an_unknown_outcome_is_checked_again_with_backoff_not_every_tick() {
    let lab = lab();
    let job = reserved(&lab, "unknown", &boot());
    let proof = started(&lab, &job, true);
    ticks(&lab, 1).await;
    set(&lab, &collector(&job), "gone");
    answer(&lab, &job, "reconcile", json!({"status":"unresolved","systemd":{"SubState":"running","InvocationID":"another"},
        "supervisor":{"ActiveState":"inactive"},"started":proof,"freezer":null,"command":null}));
    let mut seen = Vec::new();
    for rewind in [0, 0, 2, 2, 2, 8] {
        lab.ws.jobs.watch.rewind(Duration::from_secs(rewind));
        ticks(&lab, 5).await;
        seen.push(runs(&lab, &job).len());
    }
    assert_eq!(now(&lab, &job)["status"], "unknown");
    assert_eq!(seen, [2, 2, 3, 3, 4, 5], "checked again after 2 s, then 4 s, then 8 s, not on every tick");
}

/// A running Job's freezer, for the pause reconciliation, comes from its
/// worker's group, with no helper run.
#[tokio::test]
async fn the_freezer_comes_from_the_worker_group() {
    let lab = lab();
    let job = reserved(&lab, "freezer", &boot());
    started(&lab, &job, true);
    ticks(&lab, 1).await;
    set(&lab, &worker(&job), "frozen");
    let seen = lab.ws.jobs.watch.observe(&lab.ws.data_dir, &now(&lab, &job)).await.unwrap().unwrap();
    assert_eq!((&seen["status"], &seen["freezer"]), (&json!("running"), &json!({"populated":true,"frozen":true})));
    assert_eq!(runs(&lab, &job).len(), 1, "the freezer comes from the worker's group, with no helper run");
}

/// The command's own start (T-14), recorded after the worker's, is taken
/// once.
#[tokio::test]
async fn the_commands_record_is_taken_once() {
    let lab = lab();
    let job = reserved(&lab, "command", &boot());
    started(&lab, &job, false);
    ticks(&lab, 1).await;
    assert!(now(&lab, &job)["result"]["command"].is_null());
    command(&lab, &job);
    started(&lab, &job, true);
    ticks(&lab, 5).await;
    assert_eq!(now(&lab, &job)["result"]["command"]["pid"], 2);
    assert_eq!(runs(&lab, &job).len(), 2, "the command's own start is taken once");
}

/// job_get's usage of a running Job is read from its worker's cgroup, under
/// systemd's names and units (O1), with no `inspect` run.
#[tokio::test]
async fn a_running_jobs_usage_is_read_from_its_cgroup_without_a_helper() {
    let lab = lab();
    let job = reserved(&lab, "usage", &boot());
    started(&lab, &job, true);
    ticks(&lab, 1).await;
    let group = lab.root.join(worker(&job).trim_start_matches('/'));
    for (file, value) in [("memory.current", "1048576\n"), ("memory.peak", "2097152\n"), ("memory.max", "134217728\n"),
        ("memory.swap.max", "0\n"), ("pids.max", "max\n"), ("cpu.stat", "usage_usec 1500\nuser_usec 1000\nsystem_usec 500\n")]
    {
        std::fs::write(group.join(file), value).unwrap();
    }
    let got = call(lab.ws.clone(), None, "job_get".into(), json!({"jobId": id(&job)})).await.unwrap();
    assert_eq!(got["usage"], json!({"MemoryCurrent":"1048576","MemoryPeak":"2097152","MemoryMax":"134217728","MemorySwapMax":"0",
        "TasksMax":"infinity","CPUUsageNSec":"1500000"}));
    assert!(!runs(&lab, &job).contains(&"inspect".to_owned()), "no inspect run: {:?}", runs(&lab, &job));
    set(&lab, &worker(&job), "gone");
    let got = call(lab.ws.clone(), None, "job_get".into(), json!({"jobId": id(&job)})).await.unwrap();
    assert!(got["usage"].is_null(), "null once its cgroup is gone");
}
