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
    assert_eq!(cost["compute"], json!({"cpuSeconds":0.0,"workerWallSeconds":0.0,"attemptsMeasured":0,"attemptsUnmeasured":3}),
        "no worker evidence: unmeasured, not zero seconds measured");
    assert_eq!((cost["runs"].clone(), cost["reusedStages"].clone()), (json!(1), json!(1)));
    assert_eq!(cost["gpu"], json!({"attemptsReserving":0,"measured":false}), "GPU use is not measured");
    assert!(cost["scope"].as_str().unwrap().contains("never as zero"));
    assert_eq!(s.task_cost("T-2").unwrap()["usd"]["knownUsd"], 100.0, "another task's spend stays its own");
    assert!(tool_definitions().iter().any(|tool| tool["name"] == "job_cost"));
}
