//! T-38 C and YN-6 S2: a request suggested from earlier measured runs of the
//! same Job (this task's of the same name or argv, else its Project's of the
//! same argv), kept on the Job with its request beside it. Only shown: no
//! Job's request changes.
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
    // Room for every request here, up to the 40,960 MiB sweep.
    s.set_job_budget(Resources { cpu_millis: 16000, memory_mi_b: 65536, swap_mi_b: 0 }).unwrap();
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
    assert_eq!(got["note"], "A suggestion only; nothing was changed. This task's 1 newest measured run(s) of the same name or command \
        (at least one succeeded) peaked at 2662 MiB RAM; the larger of 1.3 × that and that + 1 GiB, rounded up to 512 MiB, is 4096 MiB. \
        Their largest average was 1.20 CPU cores; half again as much, rounded up to 100 mCPU, is 1800 mCPU.");
    assert_eq!(got["scope"], "task");
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
    // 1,400 + 1,024 = 2,424 (more than 1,400 × 1.3) → 2,560 MiB; 2.0 × 1.5 = 3 cores.
    assert_eq!((got["memoryMiB"].clone(), got["cpuMillis"].clone()), (json!(2560), json!(3000)));
}

#[test]
fn the_rounding_has_its_floor_and_ignores_float_noise() {
    let run = |peak: f64, cores: Value| json!({"jobId":"j","status":"succeeded","memoryPeakMiB":peak,"averageCpuCores":cores});
    let pair = |v: Value| (v["memoryMiB"].clone(), v["cpuMillis"].clone());
    assert_eq!(pair(suggest(vec![run(100.0, json!(0.01))])), (json!(1536), json!(100)), "1 GiB above the peak, and at least 100 mCPU");
    assert_eq!(pair(suggest(vec![run(1024.0, json!(2.2))])), (json!(2048), json!(3300)), "2.2 × 1.5 × 1000 is 3300.0000000000005, not 3,400 mCPU");
    assert_eq!(pair(suggest(vec![run(3938.5, json!(2.0))])), (json!(5632), json!(3000)), "1.3 × 3,938.5 is 5,120.05: rounds up to 5,632");
    // A run too short for an average CPU: memory only.
    let memory_only = suggest(vec![run(3000.0, Value::Null)]);
    assert_eq!(pair(memory_only.clone()), (json!(4096), Value::Null));
    assert!(memory_only["note"].as_str().unwrap().ends_with("peaked at 3000 MiB RAM; the larger of 1.3 × that and that + 1 GiB, rounded up to 512 MiB, is 4096 MiB."),
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
    assert_eq!(stored["suggestion"], answer["suggestion"], "kept on the Job as answered (YN-6 S2)");
    // The submit form asks the same without submitting.
    let form = call(ws.clone(), None, "job_suggestion".into(), json!({"taskId":"T-1","name":"K4 calibration","argv":["python3","other.py"]})).await.unwrap();
    assert_eq!(form["suggestion"]["memoryMiB"], 4096);
    let none = call(ws.clone(), None, "job_suggestion".into(), json!({"taskId":"T-1","name":"first of its kind"})).await.unwrap();
    assert_eq!(none, json!({"suggestion":null}));
}

// ---- YN-6 S2 -------------------------------------------------------------

/// Finished with a complete worker measurement, as `status` with systemd's
/// `result` (`oom-kill` for a run killed at its memory limit).
fn end(s: &Store, job: &Value, peak: u64, status: &str, result: &str) {
    finish(s, job, peak, 1000);
    let db = s.db.write().unwrap();
    db.execute("UPDATE local_jobs SET status=?2, data=json_set(data,'$.status',?2,'$.result.status',?2,'$.result.evidence.systemd.Result',?3) WHERE id=?1",
        [id(job), status, result]).unwrap();
}
/// T-1 and T-2 in one Project; T-3, added here, in another.
fn projects(s: &Store) {
    s.collaboration_call(None, "task_create", json!({"requestId":"elsewhere","title":"Elsewhere","status":"doing"})).unwrap();
    let one = s.create_project("Calibration work", Default::default()).unwrap();
    let two = s.create_project("Other project", Default::default()).unwrap();
    let db = s.db.write().unwrap();
    for (task, project) in [("T-1", &one.id), ("T-2", &one.id), ("T-3", &two.id)] {
        let (key, _) = crate::collaboration_store::task_key(&db, task).unwrap();
        crate::projects::set_task_project(&db, &key, Some(project.as_str())).unwrap();
    }
}
fn workspace() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    ws.jobs.started.set(()).unwrap();
    tasks(&ws.store);
    (dir, ws)
}

#[test]
fn the_memory_is_1_3x_the_peak_or_1_gib_above_it_whichever_is_more() {
    let (_dir, s) = setup();
    let large = submit(&s, "T-1", "large", "large", &["./large.sh"], 16384);
    finish(&s, &large, 7168, 1000);
    let small = submit(&s, "T-1", "small", "small", &["./small.sh"], 4096);
    finish(&s, &small, 600, 1000);
    let got = s.resource_suggestion(&query("T-1", "large", &["./large.sh"]), None).unwrap();
    assert_eq!(got["memoryMiB"], 9728, "max(1.3 × 7168, 7168 + 1024) = 9318.4, up to 9728: {got}");
    let got = s.resource_suggestion(&query("T-1", "small", &["./small.sh"]), None).unwrap();
    assert_eq!(got["memoryMiB"], 2048, "max(1.3 × 600, 600 + 1024) = 1624, up to 2048: {got}");
}

#[test]
fn no_suggestion_without_a_succeeded_run_among_those_counted() {
    let (_dir, s) = setup();
    let early = submit(&s, "T-1", "early", "check", &["./check.sh"], 8192);
    end(&s, &early, 300, "failed", "exit-code");
    let got = s.resource_suggestion(&query("T-1", "check", &["./check.sh"]), None).unwrap();
    assert!(got.is_null(), "an early failure alone suggests nothing: {got}");
    // With a success among them, a failed run's larger peak still counts.
    let ok = submit(&s, "T-1", "ok", "check", &["./check.sh"], 8192);
    end(&s, &ok, 200, "succeeded", "success");
    let big = submit(&s, "T-1", "big", "check", &["./check.sh"], 8192);
    end(&s, &big, 5000, "failed", "exit-code");
    let got = s.resource_suggestion(&query("T-1", "check", &["./check.sh"]), None).unwrap();
    assert_eq!((got["memoryPeakMiB"].clone(), based_on(&got).len()), (json!(5000.0), 3), "{got}");
}

#[test]
fn a_run_killed_at_its_memory_limit_is_marked() {
    let (_dir, s) = setup();
    let ok = submit(&s, "T-1", "ok", "train", &["./train.sh"], 4096);
    end(&s, &ok, 3000, "succeeded", "success");
    let killed = submit(&s, "T-1", "killed", "train", &["./train.sh"], 4096);
    end(&s, &killed, 4096, "failed", "oom-kill");
    let got = s.resource_suggestion(&query("T-1", "train", &["./train.sh"]), None).unwrap();
    assert_eq!(got["hitMemoryLimit"], true, "a run killed at its limit is marked: {got}");
    assert_eq!(got["basedOn"][0]["hitMemoryLimit"], true, "{got}");
    assert!(got["note"].as_str().unwrap().contains("killed at its memory limit"), "{got}");
}

#[test]
fn a_task_without_its_own_runs_gets_its_projects_runs_of_the_same_argv() {
    let (_dir, s) = setup();
    projects(&s);
    let sibling = submit(&s, "T-2", "sibling", "lib tests", &["cargo", "test", "--lib"], 16384);
    finish(&s, &sibling, 7168, 3000);
    // The same name in the same Project, another argv: not the same Job there.
    let named = submit(&s, "T-2", "named", "new name", &["./other.sh"], 16384);
    finish(&s, &named, 20000, 3000);
    // The same argv in another Project.
    let other = submit(&s, "T-3", "other", "lib tests", &["cargo", "test", "--lib"], 32768);
    finish(&s, &other, 30000, 3000);
    let got = s.resource_suggestion(&query("T-1", "new name", &["cargo", "test", "--lib"]), None).unwrap();
    assert_eq!(based_on(&got), [id(&sibling)], "the Project's run of the same argv counts, and only it: {got}");
    assert_eq!((got["scope"].clone(), got["memoryMiB"].clone()), (json!("project"), json!(9728)));
    // A task with its own runs keeps to them.
    let own = submit(&s, "T-1", "own", "lib tests", &["cargo", "test", "--lib"], 8192);
    finish(&s, &own, 2000, 1000);
    let got = s.resource_suggestion(&query("T-1", "lib tests", &["cargo", "test", "--lib"]), None).unwrap();
    assert_eq!((based_on(&got), got["scope"].clone()), (vec![id(&own).to_owned()], json!("task")));
}

#[tokio::test]
async fn another_agents_job_in_the_hint_shows_no_name_argv_env_or_cwd() {
    let (_dir, ws) = workspace();
    ws.store.insert(&agent("b")).unwrap();
    let mut private = request("T-1", "private", "K4 private-name", &["python3", "calib-private.py"], 20480);
    private["env"]["SECRET_HINT"] = json!("s3cr3t-value");
    private["cwd"] = json!("/workspace/private-tree");
    let input: Submit = serde_json::from_value(private).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}});
    let earlier = ws.store.create_job(Some("a"), input, json!({"cwd":"/workspace/private-tree"}), machine, json!({"bootId":"boot"})).unwrap();
    finish(&ws.store, &earlier, 2662, 1200);
    let asked = json!({"taskId":"T-1","name":"K4 private-name","argv":["python3","calib-private.py"]});
    let theirs = call(ws.clone(), Some("b".into()), "job_suggestion".into(), asked.clone()).await.unwrap();
    assert_eq!(theirs["suggestion"]["memoryMiB"], 4096, "{theirs}");
    let row = &theirs["suggestion"]["basedOn"][0];
    assert_eq!(row["jobId"], earlier["id"]);
    assert!(row.get("name").is_none(), "another Agent's Job by its numbers and IDs only: {row}");
    let text = theirs.to_string();
    for private in ["private-name", "calib-private", "s3cr3t-value", "private-tree"] {
        assert!(!text.contains(private), "{private} in {text}");
    }
    // Its own Agent sees its name.
    let own = call(ws.clone(), Some("a".into()), "job_suggestion".into(), asked).await.unwrap();
    assert_eq!(own["suggestion"]["basedOn"][0]["name"], "K4 private-name");
}

#[tokio::test]
async fn job_submit_keeps_the_suggestion_with_its_request_beside_it() {
    let (_dir, ws) = workspace();
    let earlier = submit(&ws.store, "T-1", "earlier", "K4 calibration", &["python3", "calib.py"], 20480);
    finish(&ws.store, &earlier, 2662, 1200);
    for (request_id, memory, verdict) in [("far", 20480, "far_above"), ("below", 2048, "below_peak"), ("within", 4096, "within")] {
        let job = submit(&ws.store, "T-1", request_id, "K4 calibration", &["python3", "calib.py"], memory);
        let answer = call(ws.clone(), Some("a".into()), "job_submit".into(), request("T-1", request_id, "K4 calibration", &["python3", "calib.py"], memory))
            .await
            .unwrap();
        assert_eq!(answer["id"], job["id"]);
        let beside = &answer["suggestion"]["request"];
        assert_eq!((beside["memoryMiB"].clone(), beside["verdict"].clone()), (json!(memory), json!(verdict)), "its request beside the suggestion: {answer}");
        assert_eq!(beside["advice"].is_string(), verdict != "within", "{beside}");
        assert_eq!(ws.store.job(id(&job)).unwrap()["suggestion"], answer["suggestion"], "kept on the Job");
        assert_eq!(answer["resources"]["memoryMiB"], memory, "never applied");
    }
}

#[test]
fn job_suggestion_is_a_tool_beside_job_submit_within_600_units() {
    let tools = super::tool_definitions();
    let tool = tools.iter().find(|t| t["name"] == "job_suggestion").expect("job_suggestion is listed as a tool");
    assert_eq!(tool["inputSchema"]["required"], json!(["taskId", "name"]));
    let units = tool["description"].as_str().unwrap().encode_utf16().count();
    assert!(units <= 600, "{units} UTF-16 units");
}

#[test]
fn a_run_keeps_each_stages_suggestion_with_its_request() {
    let (_dir, s) = setup();
    let earlier = submit(&s, "T-1", "earlier", "Fixture run · train", &["python3", "train.py"], 4096);
    finish(&s, &earlier, 2662, 1200);
    let input: super::runs::RunSubmit = serde_json::from_value(json!({"requestId":"run","taskId":"T-1","name":"Fixture run","stages":[
        {"key":"train","needs":[],"cwd":"/workspace","argv":["python3","train.py"],"resources":{"cpuMillis":4000,"memoryMiB":20480,"swapMiB":0}},
        {"key":"report","needs":[],"cwd":"/workspace","argv":["python3","report.py"],"resources":{"cpuMillis":200,"memoryMiB":512,"swapMiB":0}}]})).unwrap();
    let prepared = input
        .stages
        .iter()
        .map(|stage| {
            let submit = input.submit(stage);
            let snapshot = json!({"cwd":"/workspace","git":{"head":"abc"},"files":[]});
            let identity = super::runs::spec_identity(&submit, &snapshot, stage.needs());
            super::runs::Prepared { submit, snapshot, identity, reuse: None, guard_exclude: vec![] }
        })
        .collect();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}});
    let run = s.create_run(Some("a"), input, prepared, machine, json!({"bootId":"boot"})).unwrap();
    let train = &run["stages"][0];
    assert_eq!((train["suggestion"]["memoryMiB"].clone(), train["suggestion"]["request"]["verdict"].clone()), (json!(4096), json!("far_above")),
        "the run keeps the train stage's suggestion with its request: {train}");
    assert!(run["stages"][1].get("suggestion").is_some_and(Value::is_null), "a stage with no earlier run keeps none");
    let job = s.job(train["attempts"][0]["id"].as_str().unwrap()).unwrap();
    assert_eq!(job["suggestion"], train["suggestion"], "and so does its Job");
}
