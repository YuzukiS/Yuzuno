//! The research loop on runs (T-17 slice 4): a run follows a method record of
//! its own task, an analysis decision cites the record that explains it, and
//! a task's recorded spend adds up every attempt once. Synthetic records only.
use super::*;
use rusqlite::params;

/// A research record on T-1 (or `task`), returning its activity.
fn record(s: &Store, task: &str, key: &str, research: Value) -> i64 {
    s.collaboration_call(Some("a"), "task_comment", json!({"requestId":key,"taskId":task,"body":format!("Note {key}"),"research":research}))
        .unwrap()["activity"]["seq"]
        .as_i64()
        .unwrap()
}

fn method(text: &str) -> Value {
    json!({"type":"method","id":"timing","title":"Timing protocol","text":text,"field":"systems"})
}

fn followed(s: &Store, request: &str, method: i64) -> Result<Value> {
    let input: RunSubmit = serde_json::from_value(json!({"requestId":request,"taskId":"T-1","name":"Fixture run",
        "method":{"activitySeq":method},"stages":[stage("time", &[])]})).unwrap();
    let prepared = prepare(&input);
    s.create_run(Some("a"), input, prepared, machine(), json!({"bootId":"boot"}))
}

fn runs(s: &Store) -> i64 {
    s.db.read().unwrap().query_row("SELECT COUNT(*) FROM local_job_runs", [], |r| r.get(0)).unwrap()
}

#[test]
fn a_run_follows_a_method_record_of_its_own_task_and_a_new_version_leaves_it_as_it_was() {
    let (_dir, s) = setup();
    let first = record(&s, "T-1", "m1", method("Ten iterations in one process."));
    let run = followed(&s, "follows", first).unwrap();
    assert_eq!(run["method"], json!({"activitySeq":first,"id":"timing","title":"Timing protocol","version":1}));
    assert_eq!(run["methodNow"], json!({"state":"readable","revisedBy":null,"latestActivitySeq":first}));
    // A new method version is a record, not a new run: the run still names
    // the version it followed and says a newer one exists.
    let mut revised = method("Ten fresh processes.");
    revised["revises"] = json!({"activitySeq":first,"reason":"Iterations in one process are not independent runs."});
    let second = record(&s, "T-1", "m2", revised);
    let again = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(again["method"], run["method"]);
    assert_eq!(again["methodNow"], json!({"state":"readable","revisedBy":second,"latestActivitySeq":second}));
    assert_eq!(followed(&s, "follows", first).unwrap()["id"], run["id"], "a retry is the same run");
    // Only a method record of the run's own task.
    let claim = record(&s, "T-1", "c1", json!({"type":"claim","id":"faster","title":"B is faster","text":"About 4%.","status":"open"}));
    s.collaboration_call(None, "task_create", json!({"requestId":"other","title":"Another study"})).unwrap();
    let elsewhere = record(&s, "T-2", "m-other", method("Another task's method."));
    let before = runs(&s);
    for (name, seq) in [("a claim", claim), ("another task's method", elsewhere), ("no activity", 999_999)] {
        let refused = followed(&s, name, seq).unwrap_err().to_string();
        assert!(refused.contains("is not a method record of T-1"), "{name}: {refused}");
    }
    assert_eq!(runs(&s), before, "a refused run writes nothing");
}

#[test]
fn an_analysis_decision_cites_the_record_that_explains_it_and_decides_nothing_by_itself() {
    let (_dir, s) = setup();
    let mut gated = stage("time", &[]);
    gated["waitForAnalysis"] = json!(true);
    let run = create(&s, "gated", json!([gated, stage("report", &["time"])]));
    let time = start(&s);
    assert!(success(&s, &time, "aaa"));
    let run = s.run(run["id"].as_str().unwrap()).unwrap();
    let gate = run["stages"][0]["analysis"].clone();
    assert_eq!(gate["state"], "waiting");
    let observation = record(&s, "T-1", "o1", json!({"type":"observation","id":"ranking-flips","title":"Ranking flips with link order",
        "text":"Reordering the link step reverses which layout is faster.",
        "next":{"action":"stop","text":"The measurement makes the advantage; time fresh processes before any further stage."}}));
    let decide = |request: &str, choice: &str, seq: i64| -> Result<Value> {
        s.decide_run(Some("a"), &serde_json::from_value(json!({"requestId":request,"runId":run["id"],"stage":"time",
            "gateId":gate["id"],"attemptId":gate["attemptId"],"decision":choice,"reason":"See the observation.",
            "record":{"activitySeq":seq}})).unwrap())
    };
    s.collaboration_call(None, "task_create", json!({"requestId":"other","title":"Another study"})).unwrap();
    let elsewhere = record(&s, "T-2", "o-other", json!({"type":"observation","id":"other","title":"Elsewhere","text":"Not this task."}));
    let refused = decide("elsewhere", "continue", elsewhere).unwrap_err().to_string();
    assert!(refused.contains("is not a research record of T-1"), "{refused}");
    assert_eq!(s.run(run["id"].as_str().unwrap()).unwrap()["stages"][0]["analysis"]["state"], "waiting", "nothing decided");
    let decided = decide("stop", "cancel", observation).unwrap();
    let gate = &decided["stages"][0]["analysis"];
    assert_eq!(gate["state"], "cancelled");
    assert_eq!(gate["record"]["activitySeq"], observation);
    assert_eq!(gate["record"]["record"], json!({"kind":"research","type":"observation","id":"ranking-flips","title":"Ranking flips with link order"}));
    assert_eq!(gate["record"]["next"]["action"], "stop");
    assert_eq!(gate["recordNow"], json!({"state":"readable","revisedBy":null,"latestActivitySeq":observation}));
    assert_eq!(decide("stop", "cancel", observation).unwrap()["id"], run["id"], "a retry is the same decision");
    // The record proposed a stop; it is the decision that stopped the run.
    assert_eq!(latest(&s, &run, "report")["status"], "cancelled");
}

/// A synthetic finished or live attempt of `task` with the recorded `cost`.
fn attempt(s: &Store, task: &str, id: &str, status: &str, cost: Value) {
    let task = crate::collaboration_store::task_key(&s.db.read().unwrap(), task).unwrap().0;
    let data = json!({"id":id,"taskId":task,"agentId":"a","attempt":format!("{id}-attempt"),"status":status,
        "resources":{"cpuMillis":1000,"memoryMiB":64,"swapMiB":0},"result":{"cost":cost}});
    s.db.write().unwrap().execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'a',?3,?4)",
        params![id, task, status, data.to_string()]).unwrap();
}

#[test]
fn a_tasks_recorded_spend_counts_each_attempt_once_and_keeps_unknown_apart() {
    let (_dir, s) = setup();
    s.collaboration_call(None, "task_create", json!({"requestId":"other","title":"Another study"})).unwrap();
    let paid = |usd: f64, unknown: i64| json!({"entries":1,"knownUsd":usd,"unknownEntries":unknown,"invalidLines":0,
        "incompleteLines":0,"truncated":false,"sources":["synthetic"],"complete":unknown == 0});
    attempt(&s, "T-1", "first", "failed", paid(0.25, 1));
    attempt(&s, "T-1", "retry", "succeeded", paid(1.5, 0));
    attempt(&s, "T-1", "never-recorded", "cancelled", Value::Null);
    attempt(&s, "T-1", "live", "running", Value::Null);
    attempt(&s, "T-2", "elsewhere", "succeeded", paid(100.0, 0));
    // A run whose first stage reused an earlier result: it ran nothing.
    let task = crate::collaboration_store::task_key(&s.db.read().unwrap(), "T-1").unwrap().0;
    s.db.write().unwrap().execute("INSERT INTO local_job_runs(id,task_id,agent_id,data) VALUES('run-1',?1,'a',?2)",
        params![task, json!({"id":"run-1","stages":[{"key":"build","reusedFrom":{"jobId":"retry"}},{"key":"time"}]}).to_string()]).unwrap();
    let cost = s.task_cost("T-1").unwrap();
    assert_eq!(cost["attempts"], 4, "each attempt once, the failed one and its retry both");
    assert_eq!(cost["byStatus"], json!({"cancelled":1,"failed":1,"running":1,"succeeded":1}));
    assert_eq!(cost["usd"], json!({"knownUsd":1.75,"attemptsReporting":2,"attemptsNotRecorded":1,"attemptsWithUnknown":1,
        "unknownEntries":1,"invalidLines":0,"attemptsRunning":1,"complete":false}));
    assert_eq!(cost["compute"], json!({"cpuSeconds":0.0,"attemptsWithCpu":0,"attemptsWithoutCpu":3,"workerWallSeconds":0.0,
        "attemptsWithWall":0,"attemptsWithoutWall":3,"attemptsMeasured":0,"attemptsUnmeasured":3}),
        "no worker evidence: unmeasured, not zero seconds measured");
    assert_eq!((cost["runs"].clone(), cost["reusedStages"].clone()), (json!(1), json!(1)));
    assert_eq!(cost["gpu"], json!({"attemptsReserving":0,"measured":false}), "GPU use is not measured");
    assert!(cost["scope"].as_str().unwrap().contains("never as zero"));
    assert_eq!(s.task_cost("T-2").unwrap()["usd"]["knownUsd"], 100.0, "another task's spend stays its own");
    assert!(tool_definitions().iter().any(|tool| tool["name"] == "job_cost"));
}

/// What the Jobs host makes of a usage file of each shape: its own
/// `usage_summary`, run on synthetic files. A missing file is no summary.
fn usage_summaries() -> Value {
    let dir = tempfile::tempdir().unwrap();
    let host = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/jobs/host.py");
    let script = r#"
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('job_host', sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
files = {'missing': None, 'empty': '', 'blank': '  \n\t\n\n', 'zero': '{"usd": 0, "source": "synthetic"}\n',
         'unknown': '{"source": "synthetic"}\n', 'unreadable': 'not json\n', 'paid': '{"usd": 1.5, "source": "synthetic"}\n'}
summaries = {}
for name, text in files.items():
    folder = Path(sys.argv[2]) / name
    folder.mkdir()
    if text is not None:
        (folder / 'usage.jsonl').write_text(text)
    summaries[name] = host.usage_summary(folder)
print(json.dumps(summaries))
"#;
    let output = std::process::Command::new("/usr/bin/python3").arg("-c").arg(script).arg(&host).arg(dir.path())
        .output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn an_empty_usage_file_recorded_no_spend_and_an_entry_of_zero_dollars_is_a_known_zero() {
    let (_dir, s) = setup();
    for key in ["two", "three"] {
        s.collaboration_call(None, "task_create", json!({"requestId":key,"title":"Another study"})).unwrap();
    }
    let summaries = usage_summaries();
    assert_eq!(summaries["missing"], Value::Null);
    for name in ["empty", "blank"] {
        assert_eq!((summaries[name]["entries"].clone(), summaries[name]["knownUsd"].as_f64(), summaries[name]["complete"].clone()),
            (json!(0), Some(0.0), json!(true)), "the host calls a {name} file complete, with no entries");
    }
    for name in ["missing", "empty", "blank", "zero", "unknown", "unreadable", "paid"] {
        attempt(&s, "T-1", name, "succeeded", summaries[name].clone());
    }
    // A summary without an entry count says nothing it can be trusted for.
    attempt(&s, "T-1", "uncounted", "succeeded", json!({"knownUsd":0,"complete":true}));
    assert_eq!(s.task_cost("T-1").unwrap()["usd"], json!({"knownUsd":1.5,"attemptsReporting":3,"attemptsNotRecorded":3,
        "attemptsWithUnknown":3,"unknownEntries":1,"invalidLines":1,"attemptsRunning":0,"complete":false}),
        "missing, empty and blank recorded none; zero, unknown and paid reported; unknown, unreadable and uncounted are unknown");
    // On their own: an entry of $0 is a complete known $0, an empty file is not.
    attempt(&s, "T-2", "zero-only", "succeeded", summaries["zero"].clone());
    attempt(&s, "T-3", "empty-only", "succeeded", summaries["empty"].clone());
    assert_eq!(s.task_cost("T-2").unwrap()["usd"], json!({"knownUsd":0.0,"attemptsReporting":1,"attemptsNotRecorded":0,
        "attemptsWithUnknown":0,"unknownEntries":0,"invalidLines":0,"attemptsRunning":0,"complete":true}));
    assert_eq!(s.task_cost("T-3").unwrap()["usd"], json!({"knownUsd":0.0,"attemptsReporting":0,"attemptsNotRecorded":1,
        "attemptsWithUnknown":0,"unknownEntries":0,"invalidLines":0,"attemptsRunning":0,"complete":false}));
}

/// A finished attempt of `task` with its worker's final evidence, shaped as
/// the collector records it, with these CPU and monotonic start/exit counters.
fn metered(task: &str, id: &str, cpu: Value, start: Value, end: Value) -> Value {
    let attempt = format!("{id}-attempt");
    json!({"id":id,"taskId":task,"agentId":"a","attempt":attempt,"bootId":"boot","status":"succeeded",
        "resources":{"cpuMillis":1000,"memoryMiB":64,"swapMiB":0},
        "result":{"jobId":id,"attempt":attempt,"bootId":"boot","status":"succeeded",
            "started":{"jobId":id,"attempt":attempt,"bootId":"boot","invocationId":"invocation","at":100.0},
            "evidence":{"systemd":{"InvocationID":"invocation","MainPID":"0","SubState":"exited","Result":"success",
                "MemoryPeak":"67108864","CPUUsageNSec":cpu,
                "ExecMainStartTimestampMonotonic":start,"ExecMainExitTimestampMonotonic":end}}}})
}

fn insert_job(s: &Store, job: &Value) {
    s.db.write().unwrap().execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'a',?3,?4)",
        params![job["id"].as_str().unwrap(), job["taskId"].as_str().unwrap(), job["status"].as_str().unwrap(), job.to_string()]).unwrap();
}

#[test]
fn cpu_and_wall_time_are_each_added_where_an_attempt_measured_them() {
    let (_dir, s) = setup();
    let task = crate::collaboration_store::task_key(&s.db.read().unwrap(), "T-1").unwrap().0;
    let (start, end) = (json!("1000000"), json!("4000000"));
    for job in [
        metered(&task, "both", json!("1500000000"), start.clone(), end.clone()),
        metered(&task, "cpu-missing", Value::Null, start.clone(), end.clone()),
        metered(&task, "cpu-sentinel", json!(u64::MAX.to_string()), start.clone(), end.clone()),
        // An exit before the start is no wall time; the CPU time still counts.
        metered(&task, "wall-invalid", json!("2000000000"), json!("5000000"), json!("1000000")),
        metered(&task, "neither", json!("[not set]"), Value::Null, Value::Null),
        metered(&task, "cpu-zero", json!("0"), start.clone(), end.clone()),
    ] {
        insert_job(&s, &job);
    }
    // Evidence a local summary does not meter: a remote attempt, and one whose
    // evidence names another attempt. Their counters are never added.
    let mut remote = metered(&task, "remote", json!("9000000000"), start.clone(), end.clone());
    remote["executor"] = json!({"kind":"ssh","machineId":"synthetic"});
    let mut other = metered(&task, "other", json!("9000000000"), start, end);
    other["result"]["attempt"] = json!("someone-else");
    insert_job(&s, &remote);
    insert_job(&s, &other);
    let cost = s.task_cost("T-1").unwrap();
    assert_eq!(cost["attempts"], 8);
    assert_eq!(cost["compute"], json!({"cpuSeconds":3.5,"attemptsWithCpu":3,"attemptsWithoutCpu":5,
        "workerWallSeconds":12.0,"attemptsWithWall":4,"attemptsWithoutWall":4,"attemptsMeasured":2,"attemptsUnmeasured":6}),
        "CPU from both, wall-invalid and an explicit zero; wall from both, cpu-missing, cpu-sentinel and cpu-zero; remote and other add nothing");
}

#[test]
fn only_an_attempt_admitted_with_its_own_gpu_reservation_counts_as_reserving_one() {
    let (_dir, s) = setup();
    let task = crate::collaboration_store::task_key(&s.db.read().unwrap(), "T-1").unwrap().0;
    let request = json!({"count":1,"memoryMiB":1024,"mode":"exclusive"});
    let held = json!([{"uuid":"GPU-synthetic","memoryMiB":1024,"mode":"exclusive"}]);
    // As runs::new_attempt makes a retry: no start, the earlier reservation
    // still in the copied record until its own admission replaces it.
    for (id, status, gpu) in [
        ("queued", "queued", json!({"gpu":request})),
        ("cancelled-queued", "cancelled", json!({"gpu":request,"cancelRequestedAt":"2026-11-01T00:00:00Z"})),
        ("retry-waiting", "waiting", json!({"gpu":request,"gpuReservation":held,"retryOf":"admitted","startedAt":null})),
        ("admitted", "failed", json!({"gpu":request,"gpuReservation":held,"startedAt":"2026-11-01T00:00:00Z"})),
        ("no-gpu", "succeeded", json!({"startedAt":"2026-11-01T00:00:00Z"})),
    ] {
        let mut data = json!({"id":id,"taskId":task,"agentId":"a","attempt":format!("{id}-attempt"),"status":status,
            "resources":{"cpuMillis":1000,"memoryMiB":64,"swapMiB":0}});
        data.as_object_mut().unwrap().extend(gpu.as_object().unwrap().clone());
        s.db.write().unwrap().execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'a',?3,?4)",
            params![id, task, status, data.to_string()]).unwrap();
    }
    let cost = s.task_cost("T-1").unwrap();
    assert_eq!(cost["gpu"], json!({"attemptsReserving":1,"measured":false}),
        "a request, a cancel before admission and a retry's copied reservation are not this attempt's");
    assert_eq!(cost["attempts"], 5);
}

#[test]
fn past_five_thousand_runs_the_spend_says_its_run_counts_are_partial() {
    let (_dir, s) = setup();
    attempt(&s, "T-1", "one", "succeeded", json!({"entries":1,"knownUsd":0.5,"unknownEntries":0,"invalidLines":0,
        "incompleteLines":0,"truncated":false,"sources":[],"complete":true}));
    let task = crate::collaboration_store::task_key(&s.db.read().unwrap(), "T-1").unwrap().0;
    let add = |from: usize, to: usize| {
        let mut db = s.db.write().unwrap();
        let tx = db.transaction().unwrap();
        for n in from..to {
            let id = format!("run-{n}");
            tx.execute("INSERT INTO local_job_runs(id,task_id,agent_id,data) VALUES(?1,?2,'a',?3)",
                params![id, task, json!({"id":id,"stages":[{"key":"build","reusedFrom":{"jobId":"one"}}]}).to_string()]).unwrap();
        }
        tx.commit().unwrap();
    };
    let counts = |cost: &Value| (cost["runs"].clone(), cost["reusedStages"].clone(), cost["runsTruncated"].clone(),
        cost["attemptsTruncated"].clone(), cost["truncated"].clone());
    add(0, 5000);
    assert_eq!(counts(&s.task_cost("T-1").unwrap()), (json!(5000), json!(5000), json!(false), json!(false), json!(false)));
    add(5000, 5001);
    let past = s.task_cost("T-1").unwrap();
    assert_eq!(counts(&past), (json!(5000), json!(5000), json!(true), json!(false), json!(true)),
        "the newest 5000 runs are read, and the read says its run counts are partial");
    assert_eq!((past["usd"]["complete"].clone(), past["limit"].clone()), (json!(true), json!(5000)),
        "every attempt was read: only the run counts are partial");
}

/// A run whose stages each finished with the usage summary the host wrote for
/// one file of `usage_summaries()` (`None`: no file at all), one at a time.
fn run_with_usage(s: &Store, request: &str, files: &[(&str, Option<Value>)]) -> Value {
    let keys: Vec<&str> = files.iter().map(|(key, _)| *key).collect();
    let run = create(s, request, json!(keys.iter().map(|key| stage(key, &[])).collect::<Vec<_>>()));
    for _ in files {
        let job = start(s);
        let key = job["run"]["stage"].as_str().unwrap().to_owned();
        let mut extra = json!({"artifacts":[artifact(&format!("{key}.json"), "aaa")]});
        if let Some(cost) = files.iter().find(|(k, _)| *k == key).unwrap().1.clone() {
            extra["cost"] = cost;
        }
        assert!(finish(s, &job, "succeeded", json!({"Result":"success","ExecMainStatus":"0"}), extra), "{key}");
    }
    s.run(run["id"].as_str().unwrap()).unwrap()
}

#[test]
fn a_runs_cost_reads_usage_as_a_tasks_does_and_its_known_amount_and_limit_are_unchanged() {
    let (_dir, s) = setup();
    let u = usage_summaries();
    let file = |name: &str| Some(u[name].clone());
    let run = run_with_usage(&s, "mixed", &[
        ("missing", None), ("empty", file("empty")), ("blank", file("blank")), ("zero", file("zero")),
        ("unknown", file("unknown")), ("unreadable", file("unreadable")), ("paid", file("paid")),
        ("uncounted", Some(json!({"knownUsd":0,"complete":true}))),
    ]);
    let cost = &run["cost"];
    assert_eq!((cost["knownUsd"].clone(), cost["attemptsReporting"].clone(), cost["attemptsNotRecorded"].clone(),
        cost["attemptsWithUnknown"].clone(), cost["unknownEntries"].clone(), cost["invalidLines"].clone(),
        cost["attemptsRunning"].clone(), cost["complete"].clone()),
        (json!(1.5), json!(3), json!(3), json!(3), json!(1), json!(1), json!(0), json!(false)),
        "missing, empty and blank recorded none; zero, unknown and paid reported; unknown, unreadable and uncounted are unknown");
    assert!(cost["scope"].as_str().unwrap().contains("recorded none"));
    let told = mail(&s).into_iter().find(|m| m["body"].as_str().unwrap_or("").contains("Recorded cost")).unwrap();
    assert!(told["body"].as_str().unwrap().contains("Recorded cost $1.5000 plus 2 entries of unknown cost; 3 attempts recorded none."),
        "{}", told["body"]);
    // On their own: an entry of $0 is a complete known $0; an empty file is none.
    let zero = run_with_usage(&s, "zero", &[("zero", file("zero"))]);
    assert_eq!((zero["cost"]["knownUsd"].clone(), zero["cost"]["attemptsReporting"].clone(), zero["cost"]["complete"].clone()),
        (json!(0.0), json!(1), json!(true)));
    let empty = run_with_usage(&s, "empty", &[("empty", file("empty"))]);
    assert_eq!((empty["cost"]["attemptsReporting"].clone(), empty["cost"]["attemptsNotRecorded"].clone(), empty["cost"]["complete"].clone()),
        (json!(0), json!(1), json!(false)));
    assert!(mail(&s).iter().any(|m| m["body"].as_str().unwrap_or("").contains("No usage was recorded.")));
}
