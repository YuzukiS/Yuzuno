//! T-38 C: a request suggested from the task's earlier measured runs of the
//! same name or argv. Only shown: no Job's request changes.
use super::{
    store::save,
    suggestion::{suggest, Query},
    *,
};
use crate::{model::AgentDetail, store::Store, workspace::Workspace};

const MIB: u64 = 1_048_576;

fn agent(id: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/workspace","model":"test","color":"sage",
        "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]}))
    .unwrap()
}
fn tasks(s: &Store) {
    s.insert(&agent("a")).unwrap();
    for title in ["Calibration", "Other work"] {
        s.collaboration_call(None, "task_create", json!({"requestId":title,"title":title,"status":"doing"})).unwrap();
    }
}
fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    tasks(&store);
    (dir, store)
}
/// A submission as job_submit stores it, its environment defaulted.
fn request(task: &str, request_id: &str, name: &str, argv: &[&str], memory: u64) -> Value {
    json!({"requestId":request_id,"taskId":task,"name":name,"cwd":"/workspace","argv":argv,
        "env":{"PATH":"/usr/local/bin:/usr/bin:/bin","LANG":"C.UTF-8"},"guardGit":false,
        "resources":{"cpuMillis":4000,"memoryMiB":memory,"swapMiB":0}})
}
fn submit(s: &Store, task: &str, request_id: &str, name: &str, argv: &[&str], memory: u64) -> Value {
    let input: Submit = serde_json::from_value(request(task, request_id, name, argv, memory)).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}});
    s.create_job(Some("a"), input, json!({"cwd":"/workspace"}), machine, json!({"bootId":"boot"})).unwrap()
}
/// Finished with a complete worker measurement: `peak` MiB at its peak and
/// `milli_cores` on average over a 10 s worker wall time.
fn finish(s: &Store, job: &Value, peak: u64, milli_cores: u64) {
    let mut job = s.job(id(job)).unwrap();
    job["status"] = json!("succeeded");
    job["reserved"] = json!(false);
    job["bootId"] = json!("boot");
    job["result"] = json!({"jobId":job["id"],"attempt":job["attempt"],"bootId":"boot","status":"succeeded",
        "started":{"jobId":job["id"],"attempt":job["attempt"],"bootId":"boot","invocationId":"invocation","at":100.0},
        "evidence":{"systemd":{"InvocationID":"invocation","MainPID":"0","SubState":"exited","Result":"success","ExecMainStatus":"0",
            "MemoryPeak":(peak * MIB).to_string(),"CPUUsageNSec":(milli_cores * 10_000_000).to_string(),
            "ExecMainStartTimestampMonotonic":"1000000","ExecMainExitTimestampMonotonic":"11000000"}}});
    save(&s.db.write().unwrap(), &job).unwrap();
}
fn id(job: &Value) -> &str {
    job["id"].as_str().unwrap()
}
fn query(task: &str, name: &str, argv: &[&str]) -> Query {
    Query { task_id: task.into(), name: name.into(), argv: argv.iter().map(|a| a.to_string()).collect() }
}
fn based_on(suggestion: &Value) -> Vec<String> {
    suggestion["basedOn"].as_array().unwrap().iter().map(|r| r["jobId"].as_str().unwrap().to_owned()).collect()
}

/// The K4 calibration of 2026-11-04 asked for 20 GiB and 4 CPUs, and peaked
/// at 2.6 GiB on 1.2 cores.
#[test]
fn a_run_that_peaked_at_2_6_gib_on_1_2_cores_suggests_4_gib_and_1800_mcpu() {
    let (_dir, s) = setup();
    let k4 = submit(&s, "T-1", "k4", "K4 calibration", &["python3", "calib.py"], 20480);
    finish(&s, &k4, 2662, 1200);
    let got = s.resource_suggestion(&query("T-1", "K4 calibration", &["python3", "calib.py"]), None).unwrap();
    assert_eq!((got["memoryMiB"].clone(), got["cpuMillis"].clone()), (json!(4096), json!(1800)), "{got}");
    assert_eq!((got["memoryPeakMiB"].clone(), got["averageCpuCores"].clone()), (json!(2662.0), json!(1.2)));
    assert_eq!(based_on(&got), [id(&k4)]);
    assert_eq!(got["note"], "A suggestion only; nothing was changed. This task's 1 newest measured run(s) with the same name or command \
        peaked at 2662 MiB RAM and 1.20 average CPU cores; half again as much, rounded up (RAM to 512 MiB, at least 1 GiB; CPU to 100 mCPU), \
        is 4096 MiB RAM and 1800 mCPU.");
}

#[test]
fn only_the_tasks_measured_runs_with_the_same_name_or_the_same_argv_count() {
    let (_dir, s) = setup();
    let by_name = submit(&s, "T-1", "by-name", "check", &["./check.sh", "--quick"], 4096);
    finish(&s, &by_name, 1000, 500);
    let by_argv = submit(&s, "T-1", "by-argv", "check (renamed)", &["./check.sh"], 4096);
    finish(&s, &by_argv, 2000, 500);
    let neither = submit(&s, "T-1", "neither", "train", &["./train.sh"], 16384);
    finish(&s, &neither, 9000, 3000);
    let elsewhere = submit(&s, "T-2", "elsewhere", "check", &["./check.sh"], 16384);
    finish(&s, &elsewhere, 8000, 3000);
    // Not measured: still queued, and finished without its peak.
    submit(&s, "T-1", "queued", "check", &["./check.sh"], 30000);
    let partial = submit(&s, "T-1", "partial", "check", &["./check.sh"], 30000);
    finish(&s, &partial, 7000, 3000);
    s.db.write().unwrap().execute("UPDATE local_jobs SET data=json_remove(data,'$.result.evidence.systemd.MemoryPeak') WHERE id=?1", [id(&partial)]).unwrap();
    let got = s.resource_suggestion(&query("T-1", "check", &["./check.sh"]), None).unwrap();
    assert_eq!(based_on(&got), [id(&by_argv), id(&by_name)], "newest first; {got}");
    assert_eq!((got["memoryPeakMiB"].clone(), got["memoryMiB"].clone()), (json!(2000.0), json!(3072)));
    // The same name alone, and the same argv alone.
    assert_eq!(based_on(&s.resource_suggestion(&query("T-1", "check", &["./other.sh"]), None).unwrap()), [id(&by_name)]);
    assert_eq!(based_on(&s.resource_suggestion(&query("T-1", "renamed", &["./check.sh"]), None).unwrap()), [id(&by_argv)]);
    // A Job's own attempts, by its ID, are left out.
    assert_eq!(based_on(&s.resource_suggestion(&query("T-1", "check", &["./check.sh"]), Some(id(&by_argv))).unwrap()), [id(&by_name)]);
    // No such run, or no such task: no suggestion.
    assert!(s.resource_suggestion(&query("T-1", "new", &["./new.sh"]), None).unwrap().is_null());
    assert!(s.resource_suggestion(&query("T-99", "check", &["./check.sh"]), None).unwrap().is_null());
}

#[test]
fn the_five_newest_measured_runs_count_with_their_largest_peak_and_cores() {
    let (_dir, s) = setup();
    let oldest = submit(&s, "T-1", "sweep-0", "sweep", &["./sweep.sh"], 40960);
    finish(&s, &oldest, 30000, 8000);
    let mut newer = Vec::new();
    for (i, (peak, cores)) in [(1000, 2000), (1400, 500), (1100, 900), (1200, 1000), (1300, 1100)].into_iter().enumerate() {
        let job = submit(&s, "T-1", &format!("sweep-{}", i + 1), "sweep", &["./sweep.sh"], 4096);
        finish(&s, &job, peak, cores);
        newer.push(id(&job).to_owned());
    }
    let got = s.resource_suggestion(&query("T-1", "sweep", &["./sweep.sh"]), None).unwrap();
    newer.reverse();
    assert_eq!(based_on(&got), newer, "the oldest run's 30000 MiB is not one of the five newest");
    // 1,400 × 1.5 = 2,100 → 2,560 MiB; 2.0 × 1.5 = 3 cores.
    assert_eq!((got["memoryMiB"].clone(), got["cpuMillis"].clone()), (json!(2560), json!(3000)));
}

#[test]
fn the_rounding_has_its_floor_and_ignores_float_noise() {
    let run = |peak: f64, cores: Value| json!({"jobId":"j","memoryPeakMiB":peak,"averageCpuCores":cores});
    let pair = |v: Value| (v["memoryMiB"].clone(), v["cpuMillis"].clone());
    assert_eq!(pair(suggest(vec![run(100.0, json!(0.01))])), (json!(1024), json!(100)), "at least 1 GiB and 100 mCPU");
    assert_eq!(pair(suggest(vec![run(1024.0, json!(1.2))])), (json!(1536), json!(1800)), "1.2 × 1500 is not 1,900 mCPU");
    assert_eq!(pair(suggest(vec![run(1365.4, json!(2.0))])), (json!(2560), json!(3000)), "2,048.1 MiB rounds up to 2,560");
    // A run too short for an average CPU: memory only.
    let memory_only = suggest(vec![run(3000.0, Value::Null)]);
    assert_eq!(pair(memory_only.clone()), (json!(4608), Value::Null));
    assert!(memory_only["note"].as_str().unwrap().ends_with("peaked at 3000 MiB RAM; half again as much, rounded up (RAM to 512 MiB, at least 1 GiB; CPU to 100 mCPU), is 4608 MiB RAM."),
        "{memory_only}");
    assert!(suggest(Vec::new()).is_null());
}

/// Through job_submit: the answer carries the suggestion beside the Job, and
/// the Job's request stays as it was sent. A retry of the same requestId
/// returns before the host is asked, so no systemd is needed; the lab check
/// acceptance/t38-suggest/check.py submits for real.
#[tokio::test]
async fn job_submit_answers_with_the_suggestion_beside_the_job_and_its_request_stays_as_sent() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.jobs.started.set(()).unwrap();
    tasks(&ws.store);
    let earlier = submit(&ws.store, "T-1", "earlier", "K4 calibration", &["python3", "calib.py"], 20480);
    finish(&ws.store, &earlier, 2662, 1200);
    let next = submit(&ws.store, "T-1", "next", "K4 calibration", &["python3", "calib.py"], 20480);
    let answer = call(ws.clone(), Some("a".into()), "job_submit".into(), request("T-1", "next", "K4 calibration", &["python3", "calib.py"], 20480))
        .await
        .unwrap();
    assert_eq!(answer["id"], next["id"]);
    assert_eq!((answer["suggestion"]["memoryMiB"].clone(), answer["suggestion"]["cpuMillis"].clone()), (json!(4096), json!(1800)));
    assert_eq!(based_on(&answer["suggestion"]), [id(&earlier)], "not the job itself");
    assert_eq!(answer["resources"], json!({"cpuMillis":4000,"memoryMiB":20480,"swapMiB":0}), "never applied");
    let stored = ws.store.job(id(&next)).unwrap();
    assert_eq!(stored["resources"]["memoryMiB"], 20480);
    assert!(stored.get("suggestion").is_none(), "only beside the answer, not kept on the Job");
    // The submit form asks the same without submitting.
    let form = call(ws.clone(), None, "job_suggestion".into(), json!({"taskId":"T-1","name":"K4 calibration","argv":["python3","other.py"]})).await.unwrap();
    assert_eq!(form["suggestion"]["memoryMiB"], 4096);
    let none = call(ws.clone(), None, "job_suggestion".into(), json!({"taskId":"T-1","name":"first of its kind"})).await.unwrap();
    assert_eq!(none, json!({"suggestion":null}));
}
