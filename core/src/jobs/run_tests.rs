//! Runs of stages: release only after verified success, bounded declared
//! retries, explicit retry and cancellation, recorded cost, one mail per
//! outcome across restarts. Store-level; the host side is in
//! acceptance/local-jobs/run_host_test.py and the real systemd path in
//! acceptance/research-runs/check.py.
use super::runs::{self, Prepared, RunSubmit};
use super::*;
use crate::{model::AgentDetail, store::Store};

mod analysis_tests;
mod analysis_integration;

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    for id in ["a", "b"] {
        let agent:AgentDetail=serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        store.insert(&agent).unwrap();
    }
    store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"task","title":"Research outcome","status":"doing"}),
        )
        .unwrap();
    (dir, store)
}
fn machine() -> Value {
    json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}})
}
fn stage(key: &str, needs: &[&str]) -> Value {
    json!({"key":key,"needs":needs,"cwd":"/workspace","argv":["/usr/bin/true"],
        "resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0},
        "artifacts":[{"path":format!("{key}.json"),"format":"json"}]})
}
fn input(request: &str, stages: Value) -> RunSubmit {
    serde_json::from_value(
        json!({"requestId":request,"taskId":"T-1","name":"Fixture run","stages":stages}),
    )
    .unwrap()
}
fn prepare(input: &RunSubmit) -> Vec<Prepared> {
    input
        .stages
        .iter()
        .map(|stage| {
            let submit = input.submit(stage);
            let snapshot = json!({"cwd":"/workspace","git":{"head":"abc"},"files":[]});
            let identity = runs::spec_identity(&submit, &snapshot, stage.needs());
            Prepared {
                submit,
                snapshot,
                identity,
                reuse: None,
                guard_exclude: vec![],
            }
        })
        .collect()
}
fn create(s: &Store, request: &str, stages: Value) -> Value {
    let input = input(request, stages);
    let prepared = prepare(&input);
    s.create_run(
        Some("a"),
        input,
        prepared,
        machine(),
        json!({"bootId":"boot"}),
    )
    .unwrap()
}
/// The attempts of one stage, oldest first.
fn attempts(run: &Value, key: &str) -> Vec<Value> {
    run["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == key)
        .unwrap()["attempts"]
        .as_array()
        .unwrap()
        .clone()
}
fn latest(s: &Store, run: &Value, key: &str) -> Value {
    let run = s.run(run["id"].as_str().unwrap()).unwrap();
    let id = attempts(&run, key).last().unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.job(&id).unwrap()
}
fn artifact(path: &str, sha: &str) -> Value {
    json!({"path":path,"format":"json","minBytes":1,"ok":true,"absolutePath":format!("/workspace/{path}"),
        "bytes":12,"mtimeNs":1,"sha256":sha})
}
/// Machine evidence for one attempt, as the collector records it.
fn finish(s: &Store, job: &Value, status: &str, systemd: Value, extra: Value) -> bool {
    let mut evidence = json!({"jobId":job["id"],"attempt":job["attempt"],"status":status,
        "reason":systemd["Result"],"evidence":{"systemd":systemd}});
    for (key, value) in extra.as_object().unwrap() {
        evidence[key] = value.clone();
    }
    s.update_job_evidence(job["id"].as_str().unwrap(), evidence)
        .unwrap()
}
fn success(s: &Store, job: &Value, sha: &str) -> bool {
    let key = job["run"]["stage"].as_str().unwrap();
    finish(
        s,
        job,
        "succeeded",
        json!({"Result":"success","ExecMainStatus":"0"}),
        json!({"artifacts":[artifact(&format!("{key}.json"), sha)]}),
    )
}
fn exit(code: &str) -> Value {
    json!({"Result":"exit-code","ExecMainStatus":code})
}
fn mail(s: &Store) -> Vec<Value> {
    s.collaboration_call(Some("a"), "peer_read", json!({"limit":50}))
        .unwrap()["messages"]
        .as_array()
        .unwrap()
        .clone()
}
fn start(s: &Store) -> Value {
    s.reserve_next_job(None, None, None).unwrap().unwrap()
}

#[test]
fn a_failed_stage_leaves_what_needs_it_waiting_and_never_started() {
    // The synthetic model failure: an upstream run fails, the analysis must not run.
    let (_dir, s) = setup();
    let run = create(
        &s,
        "fail",
        json!([stage("run", &[]), stage("analysis", &["run"])]),
    );
    assert_eq!(run["status"], "running");
    assert_eq!(attempts(&run, "run")[0]["status"], "queued");
    assert_eq!(attempts(&run, "analysis")[0]["status"], "waiting");
    let first = start(&s);
    assert_eq!(first["run"]["stage"], "run");
    // The waiting stage is not in the FIFO queue while its upstream runs.
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    assert!(finish(&s, &first, "failed", exit("1"), json!({})));
    let analysis = latest(&s, &run, "analysis");
    assert_eq!(analysis["status"], "waiting");
    assert!(analysis["reason"]
        .as_str()
        .unwrap()
        .contains("Upstream stage run attempt 1 failed"));
    assert!(analysis["startedAt"].is_null());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "failed");
    // Waiting on a failure is idle: the reconciliation safety net leaves it be.
    assert!(view["idleAt"].is_string());
    assert!(view["settledAt"].is_null());
    assert!(!s.advance_runs().unwrap());
    let messages = mail(&s);
    assert_eq!(messages.len(), 1);
    let body = messages[0]["body"].as_str().unwrap();
    assert!(body.contains("Not started and waiting: analysis"), "{body}");
    assert!(body.contains("job_run_retry"));
    assert_eq!(messages[0]["metadata"]["status"], "failed");
    assert_eq!(messages[0]["metadata"]["runId"], run["id"]);
}

#[test]
fn only_a_verified_success_releases_the_next_stage_with_the_digests_it_read() {
    let (dir, s) = setup();
    let run = create(
        &s,
        "pass",
        json!([stage("train", &[]), stage("eval", &["train"])]),
    );
    let train = start(&s);
    assert!(success(&s, &train, "aaa"));
    assert!(mail(&s).is_empty(), "a stage's success is told by the run");
    let eval = latest(&s, &run, "eval");
    assert_eq!(eval["status"], "queued");
    assert_eq!(eval["upstream"][0]["stage"], "train");
    assert_eq!(eval["upstream"][0]["jobId"], train["id"]);
    assert_eq!(eval["upstream"][0]["artifacts"][0]["sha256"], "aaa");
    let identity = eval["identity"]["sha256"].as_str().unwrap().to_owned();
    assert_eq!(identity.len(), 64);
    let eval = start(&s);
    assert!(success(&s, &eval, "bbb"));
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "succeeded");
    assert!(view["settledAt"].is_string());
    let messages = mail(&s);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["metadata"]["status"], "succeeded");
    assert_eq!(messages[0]["metadata"]["runId"], run["id"]);
    assert!(messages[0]["body"]
        .as_str()
        .unwrap()
        .contains("train attempt 1 succeeded; eval attempt 1 succeeded"));
    // Cancelling a finished run changes nothing.
    let id = run["id"].as_str().unwrap();
    assert_eq!(
        s.request_run_cancel(Some("a"), id).unwrap()["status"],
        "succeeded"
    );
    assert!(s.run(id).unwrap()["cancelRequestedAt"].is_null());
    // The same evidence again, and a restart: nothing reruns, nothing mails twice.
    assert!(!success(&s, &eval, "bbb"));
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert!(!s.advance_runs().unwrap());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    assert_eq!(mail(&s).len(), 1);
    assert_eq!(
        s.collaboration_call(None, "task_get", json!({"taskId":"T-1"}))
            .unwrap()["task"]["status"],
        "doing"
    );
}

#[test]
fn a_released_stage_checks_every_artifact_its_guard_leaves_out() {
    // a -> b -> c: c's Git guard leaves out a's artifacts too, so c checks
    // them against a's attempt, not only b's. A file a later stage declares
    // again is checked against that later attempt.
    let (_dir, s) = setup();
    let mut a = stage("a", &[]);
    a["artifacts"] = json!([{"path":"a.json"},{"path":"shared.json"}]);
    let mut b = stage("b", &["a"]);
    b["artifacts"] = json!([{"path":"b.json"},{"path":"shared.json"}]);
    let run = create(&s, "chain3", json!([a, b, stage("c", &["b"])]));
    let ok = json!({"Result":"success","ExecMainStatus":"0"});
    let first = start(&s);
    finish(
        &s,
        &first,
        "succeeded",
        ok.clone(),
        json!({"artifacts":[artifact("a.json", "aaa"), artifact("shared.json", "s1")]}),
    );
    let second = start(&s);
    finish(
        &s,
        &second,
        "succeeded",
        ok,
        json!({"artifacts":[artifact("b.json", "bbb"), artifact("shared.json", "s2")]}),
    );
    let c = latest(&s, &run, "c");
    assert_eq!(c["status"], "queued");
    assert_eq!(
        c["upstream"].as_array().unwrap().len(),
        1,
        "identity still follows direct needs"
    );
    let checks = c["guardChecks"].as_array().unwrap().clone();
    let digest = |stage: &str, path: &str| {
        checks
            .iter()
            .find(|check| check["stage"] == stage)
            .and_then(|check| {
                check["artifacts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|a| a["path"] == path)
            })
            .map(|a| a["sha256"].clone())
    };
    assert_eq!(digest("a", "a.json"), Some(json!("aaa")));
    assert_eq!(digest("b", "b.json"), Some(json!("bbb")));
    assert_eq!(digest("b", "shared.json"), Some(json!("s2")));
    assert_eq!(digest("a", "shared.json"), None);
    assert_eq!(
        checks.iter().find(|ch| ch["stage"] == "a").unwrap()["jobId"],
        first["id"]
    );
}

#[test]
fn a_declared_retry_is_one_new_attempt_and_keeps_the_failed_attempts_cost() {
    // The Skillevo API case: a disconnect is retryable, its spend is not lost.
    let (dir, s) = setup();
    let mut api = stage("api", &[]);
    api["retry"] = json!({"attempts":3,"exitCodes":[75]});
    let run = create(&s, "retry", json!([api, stage("judge", &["api"])]));
    let first = start(&s);
    let cost = |usd: f64| json!({"cost":{"entries":1,"knownUsd":usd,"unknownEntries":0,"invalidLines":0,"incompleteLines":0,"truncated":false,"sources":["provider usage"],"complete":true}});
    assert!(finish(&s, &first, "failed", exit("75"), cost(0.092326)));
    let old = s.job(first["id"].as_str().unwrap()).unwrap();
    assert_eq!(old["status"], "failed");
    assert!(old["reason"].as_str().unwrap().contains("attempt 2 of 3"));
    assert_eq!(old["result"]["cost"]["knownUsd"], 0.092326);
    assert_eq!(old["notifications"]["failed"], "retried");
    assert!(mail(&s).is_empty());
    let second = latest(&s, &run, "api");
    assert_eq!(second["run"]["attempt"], 2);
    assert_eq!(second["retryOf"], first["id"]);
    assert_ne!(second["attempt"], first["attempt"]);
    assert_eq!(second["status"], "queued");
    // A repeated observation of the first outcome, and a restart, retry nothing more.
    assert!(!finish(&s, &first, "failed", exit("75"), cost(0.092326)));
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.advance_runs().unwrap();
    assert_eq!(
        attempts(&s.run(run["id"].as_str().unwrap()).unwrap(), "api").len(),
        2
    );
    let second = start(&s);
    // Exit 1 is not declared retryable (a code error, a budget stop): told, not rerun.
    assert!(finish(&s, &second, "failed", exit("1"), cost(0.63)));
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(attempts(&view, "api").len(), 2);
    assert_eq!(view["cost"]["knownUsd"], 0.722326);
    assert_eq!(view["cost"]["attemptsReporting"], 2);
    assert_eq!(view["status"], "failed");
    let messages = mail(&s);
    assert_eq!(messages.len(), 1);
    assert!(messages[0]["body"].as_str().unwrap().contains("attempt 2"));
}

#[test]
fn outcomes_not_declared_retryable_are_never_retried() {
    let (_dir, s) = setup();
    let mut work = stage("work", &[]);
    work["retry"] = json!({"attempts":5,"exitCodes":[75]});
    for (request, status, systemd) in [
        (
            "oom",
            "failed",
            json!({"Result":"oom-kill","ExecMainStatus":"9"}),
        ),
        (
            "timeout",
            "failed",
            json!({"Result":"timeout","ExecMainStatus":"15"}),
        ),
        // Exit 0 with artifacts that did not verify: a definite failure.
        (
            "artifact",
            "failed",
            json!({"Result":"success","ExecMainStatus":"0"}),
        ),
        (
            "signal",
            "failed",
            json!({"Result":"signal","ExecMainStatus":"75"}),
        ),
        ("interrupted", "interrupted", json!({})),
        ("rejected", "rejected", json!({})),
        ("cancelled", "cancelled", json!({})),
        ("unknown", "unknown", json!({})),
    ] {
        let run = create(&s, request, json!([work.clone()]));
        let job = start(&s);
        finish(&s, &job, status, systemd, json!({}));
        let view = s.run(run["id"].as_str().unwrap()).unwrap();
        assert_eq!(attempts(&view, "work").len(), 1, "{request}");
        if status == "unknown" {
            // The reservation is held until cancellation confirms the groups.
            s.request_job_cancel(None, job["id"].as_str().unwrap())
                .unwrap();
            finish(&s, &job, "cancelled", json!({}), json!({}));
        }
    }
    let mut host = stage("host", &[]);
    host["retry"] = json!({"attempts":2,"interrupted":true});
    let run = create(&s, "host", json!([host]));
    let job = start(&s);
    finish(&s, &job, "interrupted", json!({}), json!({}));
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        attempts(&view, "host").len(),
        2,
        "a host restart is retried only when declared"
    );
    let again = start(&s);
    finish(&s, &again, "interrupted", json!({}), json!({}));
    assert_eq!(
        attempts(&s.run(run["id"].as_str().unwrap()).unwrap(), "host").len(),
        2,
        "attempts are bounded"
    );
}

#[test]
fn an_explicit_retry_is_idempotent_and_only_for_a_stage_that_ended_without_success() {
    let (_dir, s) = setup();
    let run = create(
        &s,
        "manual",
        json!([stage("prep", &[]), stage("train", &["prep"])]),
    );
    let id = run["id"].as_str().unwrap();
    let prep = start(&s);
    assert!(s
        .retry_stage(Some("a"), "r0", id, "prep")
        .unwrap_err()
        .to_string()
        .contains("latest attempt is starting"));
    finish(&s, &prep, "unknown", json!({}), json!({}));
    assert!(s
        .retry_stage(Some("a"), "r0", id, "prep")
        .unwrap_err()
        .to_string()
        .contains("cancel it first"));
    s.request_job_cancel(Some("a"), prep["id"].as_str().unwrap())
        .unwrap();
    finish(&s, &prep, "cancelled", json!({}), json!({}));
    assert!(s
        .retry_stage(Some("b"), "r1", id, "prep")
        .unwrap_err()
        .to_string()
        .contains("own runs"));
    assert!(s.run(id).unwrap()["idleAt"].is_string());
    let first = s.retry_stage(Some("a"), "r1", id, "prep").unwrap();
    assert!(first["idleAt"].is_null(), "a retry wakes the run");
    let second = s.retry_stage(Some("a"), "r1", id, "prep").unwrap();
    assert_eq!(attempts(&first, "prep").len(), 2);
    assert_eq!(
        attempts(&second, "prep").len(),
        2,
        "a lost reply is retried with the same requestId"
    );
    assert!(s
        .retry_stage(Some("a"), "r1", id, "train")
        .unwrap_err()
        .to_string()
        .contains("idempotency_conflict"));
    let next = start(&s);
    assert_eq!(next["run"]["attempt"], 2);
    assert!(success(&s, &next, "ccc"));
    assert_eq!(
        latest(&s, &run, "train")["status"],
        "queued",
        "what waited on prep starts after its retry succeeds"
    );
    assert!(s
        .retry_stage(Some("a"), "r2", id, "prep")
        .unwrap_err()
        .to_string()
        .contains("latest attempt is succeeded"));
}

#[test]
fn cancelling_a_run_starts_nothing_more_and_tells_it_once() {
    let (dir, s) = setup();
    let run = create(
        &s,
        "cancel",
        json!([stage("a1", &[]), stage("b1", &["a1"]), stage("c1", &["b1"])]),
    );
    let id = run["id"].as_str().unwrap();
    let running = start(&s);
    let view = s.request_run_cancel(Some("a"), id).unwrap();
    assert_eq!(view["status"], "cancelling");
    assert_eq!(attempts(&view, "a1")[0]["status"], "cancelling");
    for key in ["b1", "c1"] {
        let job = latest(&s, &run, key);
        assert_eq!(job["status"], "cancelled");
        assert!(job["startedAt"].is_null());
    }
    assert!(s.request_run_cancel(Some("b"), id).is_err());
    assert!(
        mail(&s).is_empty(),
        "nothing is told before the running stage stops"
    );
    // The running stage finishes before its cancellation lands: kept, not released on.
    assert!(success(&s, &running, "ddd"));
    let view = s.run(id).unwrap();
    assert_eq!(view["status"], "cancelled");
    assert_eq!(latest(&s, &run, "b1")["status"], "cancelled");
    let messages = mail(&s);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["metadata"]["status"], "cancelled");
    assert!(messages[0]["body"]
        .as_str()
        .unwrap()
        .contains("b1 attempt 1 cancelled before it started"));
    assert!(s
        .retry_stage(Some("a"), "late", id, "b1")
        .unwrap_err()
        .to_string()
        .contains("was cancelled"));
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.request_run_cancel(Some("a"), id).unwrap();
    s.advance_runs().unwrap();
    assert_eq!(mail(&s).len(), 1);
}

#[test]
fn a_duplicate_submission_is_the_same_run_and_a_different_one_conflicts() {
    let (_dir, s) = setup();
    let first = create(&s, "same", json!([stage("x", &[])]));
    let again = input("same", json!([stage("x", &[])]));
    let prepared = prepare(&again);
    let second = s
        .create_run(Some("a"), again, prepared, machine(), json!({}))
        .unwrap();
    assert_eq!(first["id"], second["id"]);
    let different = input("same", json!([stage("y", &[])]));
    let prepared = prepare(&different);
    assert!(s
        .create_run(Some("a"), different, prepared, machine(), json!({}))
        .unwrap_err()
        .to_string()
        .contains("idempotency_conflict"));
    let found = s
        .previous_run(Some("a"), &input("same", json!([stage("x", &[])])))
        .unwrap();
    assert_eq!(found.unwrap()["id"], first["id"]);
    assert_eq!(
        s.list_jobs(Some("a"), None, None).unwrap()["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn the_cost_limit_stops_new_attempts_and_says_what_it_cannot_cover() {
    let (_dir, s) = setup();
    let mut api = stage("api", &[]);
    api["retry"] = json!({"attempts":3,"exitCodes":[75]});
    let mut request = input("limit", json!([api, stage("judge", &["api"])]));
    request = serde_json::from_value({
        let mut v = serde_json::to_value(&request).unwrap();
        v["costLimitUsd"] = json!(0.5);
        v
    })
    .unwrap();
    let prepared = prepare(&request);
    let run = s
        .create_run(Some("a"), request, prepared, machine(), json!({}))
        .unwrap();
    let job = start(&s);
    finish(
        &s,
        &job,
        "failed",
        exit("75"),
        json!({"cost":{"knownUsd":0.6,"unknownEntries":1,"invalidLines":0,"incompleteLines":0,"truncated":false,"sources":[],"complete":false}}),
    );
    let old = s.job(job["id"].as_str().unwrap()).unwrap();
    assert!(
        old["reason"]
            .as_str()
            .unwrap()
            .contains("Not retried automatically"),
        "{}",
        old["reason"]
    );
    assert!(old["reason"].as_str().unwrap().contains("may exceed it"));
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(attempts(&view, "api").len(), 1);
    assert_eq!(view["cost"]["unknownEntries"], 1);
    assert_eq!(view["cost"]["complete"], false);
    assert!(s
        .retry_stage(Some("a"), "over", run["id"].as_str().unwrap(), "api")
        .unwrap_err()
        .to_string()
        .contains("soft limit"));
    assert_eq!(mail(&s).len(), 1, "the final failure is told");
}

#[test]
fn waiting_stages_are_live_but_never_hold_up_the_queue() {
    let (_dir, s) = setup();
    s.set_job_budget(Resources {
        cpu_millis: 2000,
        memory_mi_b: 1024,
        swap_mi_b: 0,
    })
    .unwrap();
    let run = create(
        &s,
        "live",
        json!([stage("first", &[]), stage("second", &["first"])]),
    );
    let first = start(&s);
    // A plain job submitted later is not held behind the waiting stage.
    let plain: Submit = serde_json::from_value(json!({"requestId":"plain","taskId":"T-1","name":"Plain","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":100,"memoryMiB":64,"swapMiB":0}})).unwrap();
    let plain = s
        .create_job(
            Some("a"),
            plain,
            json!({"cwd":"/workspace"}),
            machine(),
            json!({}),
        )
        .unwrap();
    assert!(
        plain["identity"]["sha256"].is_string(),
        "a standalone job is identified at submission"
    );
    assert_eq!(start(&s)["id"], plain["id"]);
    let live = s.list_jobs(Some("a"), None, None).unwrap()["liveJobs"]
        .as_array()
        .unwrap()
        .clone();
    assert!(live
        .iter()
        .any(|j| j["status"] == "waiting" && j["run"]["stage"] == "second"));
    assert_eq!(s.live_job_counts().unwrap()["agents"]["a"]["active"], 3);
    // Cancelling a waiting stage starts nothing and the run says why.
    let second = latest(&s, &run, "second");
    let cancelled = s
        .request_job_cancel(Some("a"), second["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert!(cancelled["reason"]
        .as_str()
        .unwrap()
        .contains("waiting for its upstream"));
    assert!(success(&s, &first, "eee"));
    assert_eq!(
        s.run(run["id"].as_str().unwrap()).unwrap()["status"],
        "failed"
    );
}

#[test]
fn a_run_is_validated_before_anything_is_frozen() {
    for (stages, message) in [
        (json!([]), "1–16 stages"),
        (
            json!([stage("a", &["b"]), stage("b", &[])]),
            "not an earlier stage",
        ),
        (json!([stage("a", &["a"])]), "not an earlier stage"),
        (json!([stage("a", &[]), stage("a", &[])]), "used twice"),
        (json!([stage("a b", &[])]), "Stage keys"),
        (
            json!([stage("a", &[]), stage("b", &["a", "a"])]),
            "need twice",
        ),
    ] {
        assert!(
            input("v", stages)
                .validate()
                .unwrap_err()
                .to_string()
                .contains(message),
            "{message}"
        );
    }
    let mut bad = stage("a", &[]);
    bad["retry"] = json!({"attempts":9,"exitCodes":[75]});
    assert!(input("v", json!([bad.clone()]))
        .validate()
        .unwrap_err()
        .to_string()
        .contains("2–5"));
    bad["retry"] = json!({"attempts":2});
    assert!(input("v", json!([bad.clone()]))
        .validate()
        .unwrap_err()
        .to_string()
        .contains("retryable outcomes"));
    bad["retry"] = json!({"attempts":2,"exitCodes":[0]});
    assert!(input("v", json!([bad.clone()])).validate().is_err());
    let mut escape = stage("a", &[]);
    escape["artifacts"] = json!([{"path":"../outside.json"}]);
    assert!(
        format!("{:#}", input("v", json!([escape])).validate().unwrap_err())
            .contains("artifact paths")
    );
    let mut reuse = stage("a", &[]);
    reuse["reuse"] = json!("final.json");
    assert!(input("v", json!([reuse]))
        .validate()
        .unwrap_err()
        .to_string()
        .contains("job ID"));
    assert!(input("v", json!([stage("a", &[]), stage("b", &["a"])]))
        .validate()
        .is_ok());
}

#[test]
fn identity_follows_command_code_artifact_contract_and_needs_but_not_lifecycle() {
    let base = input("i", json!([stage("a", &[])]));
    let submit = base.submit(&base.stages[0]);
    let snapshot = json!({"cwd":"/workspace","git":{"head":"abc"},"files":[{"path":"/workspace/config.yaml","sha256":"c1"}]});
    let identity = runs::spec_identity(&submit, &snapshot, &[]);
    assert_eq!(identity["codeKnown"], true);
    let changed = |edit: &dyn Fn(&mut Submit, &mut Value) -> Vec<String>| {
        let (mut submit, mut snapshot) = (submit.clone(), snapshot.clone());
        let needs = edit(&mut submit, &mut snapshot);
        runs::spec_identity(&submit, &snapshot, &needs)
    };
    let part = |other: &Value, name: &str| other["parts"][name] != identity["parts"][name];
    let config = changed(&|_, snap| {
        snap["files"][0]["sha256"] = json!("c2");
        vec![]
    });
    assert!(part(&config, "code") && config["specSha256"] != identity["specSha256"]);
    let commit = changed(&|_, snap| {
        snap["git"]["head"] = json!("def");
        vec![]
    });
    assert!(part(&commit, "code"));
    let argv = changed(&|sub, _| {
        sub.argv.push("--seed=2".into());
        vec![]
    });
    assert!(part(&argv, "command"));
    let env = changed(&|sub, _| {
        sub.env.insert("OMP_NUM_THREADS".into(), "4".into());
        vec![]
    });
    assert!(part(&env, "command"));
    let contract = changed(&|sub, _| {
        sub.artifacts[0].min_bytes = Some(100);
        vec![]
    });
    assert!(part(&contract, "artifacts"));
    let needs = changed(&|_, _| vec!["prep".into()]);
    assert!(part(&needs, "needs"));
    let lifecycle = changed(&|sub, _| {
        sub.resources.memory_mi_b = 4096;
        sub.timeout_seconds = 60;
        sub.name = "renamed".into();
        vec![]
    });
    assert_eq!(lifecycle["specSha256"], identity["specSha256"]);
    let unknown = runs::spec_identity(
        &submit,
        &json!({"cwd":"/workspace","git":null,"files":[]}),
        &[],
    );
    assert_eq!(unknown["codeKnown"], false);
}

#[test]
fn run_tools_are_listed_with_the_job_tools() {
    let names: Vec<String> = tool_definitions()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect();
    for name in [
        "job_run_submit",
        "job_run_get",
        "job_run_list",
        "job_run_retry",
        "job_run_decide",
        "job_run_cancel",
    ] {
        assert!(names.contains(&name.to_owned()), "{name}");
    }
    let submit = tool_definitions()
        .into_iter()
        .find(|t| t["name"] == "job_run_submit")
        .unwrap();
    let stage = &submit["inputSchema"]["properties"]["stages"]["items"];
    assert_eq!(stage["additionalProperties"], false);
    for field in [
        "key",
        "needs",
        "artifacts",
        "retry",
        "reuse",
        "waitForAnalysis",
        "argv",
        "resources",
    ] {
        assert!(stage["properties"][field].is_object(), "{field}");
    }
    assert!(stage["properties"]["requestId"].is_null());
    let job = tool_definitions()
        .into_iter()
        .find(|t| t["name"] == "job_submit")
        .unwrap();
    assert!(job["inputSchema"]["properties"]["artifacts"].is_object());
}

#[test]
fn only_job_submit_describes_machines_and_keeps_their_limits() {
    let tools = tool_definitions();
    let find = |name: &str| tools.iter().find(|t| t["name"] == name).unwrap().clone();
    let job = find("job_submit")["inputSchema"]["properties"].clone();
    let stage = find("job_run_submit")["inputSchema"]["properties"]["stages"]["items"]["properties"].clone();
    let text = |schema: &Value, field: &str| schema[field]["description"].as_str().unwrap().to_owned();
    // A run's stages run on this host: none of their text is about other machines.
    for field in ["inputs", "artifacts"] {
        assert!(!text(&stage, field).contains("machineId"), "{field}");
        assert!(text(&job, field).starts_with(&text(&stage, field)), "{field}");
        assert!(text(&job, field).contains("With machineId"), "{field}");
    }
    let machine = text(&job, "machineId");
    for kept in ["never on the machine your Agent itself runs on", "Not available with machineId: gpu, exclusive, outputs",
        "guardGit (set it to false)", "never starts it twice", "not processes that leave it", "yuzuno_guide topic jobs"] {
        assert!(machine.contains(kept), "{kept}");
    }
    assert!(text(&job, "artifacts").contains("minBytes (default 1)"));
}

#[test]
fn host_artifact_cost_and_upstream_checks() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../acceptance/local-jobs/run_host_test.py");
    let output = std::process::Command::new("/usr/bin/python3")
        .arg(script)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
