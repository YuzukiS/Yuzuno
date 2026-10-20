//! Resource read models must preserve evidence uncertainty and admission semantics.
use super::{resource_summary as resources, *};
use crate::{model::AgentDetail, store::Store};

fn result(job: &Value, status: &str, peak_mib: u64) -> Value {
    json!({"jobId":job["id"],"attempt":job["attempt"],"bootId":job["bootId"],
        "status":status,"finishedAtUnix":9_000_000.0,
        "started":{"jobId":job["id"],"attempt":job["attempt"],"bootId":job["bootId"],"invocationId":"invocation","at":100.0},
        "evidence":{"systemd":{"InvocationID":"invocation","MainPID":"0","SubState":"exited",
            "Result":if status == "succeeded" { "success" } else { "exit-code" },"ExecMainStatus":if status == "succeeded" { "0" } else { "75" },
            "MemoryPeak":(peak_mib * 1_048_576).to_string(),"CPUUsageNSec":"1500000000",
            "ExecMainStartTimestampMonotonic":"1000000","ExecMainExitTimestampMonotonic":"4000000"}}})
}
fn measured(status: &str) -> Value {
    let mut job = json!({"id":"job","attempt":"attempt","bootId":"boot","status":status,
        "resources":{"cpuMillis":2000,"memoryMiB":512,"swapMiB":0}});
    job["result"] = result(&job, status, 64);
    job
}

#[test]
fn worker_monotonic_time_is_used_for_success_and_failure_including_pauses() {
    for status in ["succeeded", "failed"] {
        let mut job = measured(status);
        job["createdAt"] = json!("long before the worker");
        job["finishedAt"] = json!("much later than the worker");
        job["pause"] = json!({"state":"resuming","history":[{"durationSeconds":2}]});
        let value = resources::attempt(&job);
        assert_eq!(value["measurement"], "complete");
        assert_eq!(
            value["actual"],
            json!({"memoryPeakMiB":64.0,"cpuSeconds":1.5,"workerWallSeconds":3.0,"averageCpuCores":0.5})
        );
        assert_eq!(value["declared"], json!({"memoryMiB":512,"cpuCores":2.0}));
        assert!(value["scope"].as_str().unwrap().contains("includes pauses"));
        assert!(resources::mail(&job)
            .contains("peak memory 64.00/512.00 MiB; average CPU 0.50/2.00 cores"));
    }
}

#[test]
fn missing_sentinel_and_bad_counters_stay_unknown_but_real_zero_stays_zero() {
    for invalid in [
        Value::Null,
        json!(u64::MAX),
        json!(u64::MAX.to_string()),
        json!("[not set]"),
        json!("infinity"),
        json!(-1),
        json!(1.5),
        json!("-1"),
    ] {
        let mut job = measured("succeeded");
        job["result"]["evidence"]["systemd"]["MemoryPeak"] = invalid.clone();
        job["result"]["evidence"]["systemd"]["CPUUsageNSec"] = invalid;
        let value = resources::attempt(&job);
        assert_eq!(value["measurement"], "partial");
        assert!(value["actual"]["memoryPeakMiB"].is_null());
        assert!(value["actual"]["cpuSeconds"].is_null());
        assert!(value["actual"]["averageCpuCores"].is_null());
        assert_eq!(value["actual"]["workerWallSeconds"], 3.0);
        assert!(resources::mail(&job).contains("peak memory unknown/512.00"));
    }
    let mut job = measured("succeeded");
    job["result"]["evidence"]["systemd"]["MemoryPeak"] = json!(0);
    job["result"]["evidence"]["systemd"]["CPUUsageNSec"] = json!("0");
    let value = resources::attempt(&job);
    assert_eq!(value["measurement"], "complete");
    assert_eq!(value["actual"]["memoryPeakMiB"], 0.0);
    assert_eq!(value["actual"]["averageCpuCores"], 0.0);
}

#[test]
fn invalid_wall_time_never_falls_back_to_collector_time_or_divides_by_zero() {
    for (start, end) in [
        (json!(0), json!(1)),
        (json!(4), json!(4)),
        (json!(5), json!(4)),
        (json!("n/a"), json!(4)),
        (json!(1), json!(u64::MAX)),
    ] {
        let mut job = measured("failed");
        job["result"]["evidence"]["systemd"]["ExecMainStartTimestampMonotonic"] = start;
        job["result"]["evidence"]["systemd"]["ExecMainExitTimestampMonotonic"] = end;
        let value = resources::attempt(&job);
        assert_eq!(value["measurement"], "partial");
        assert!(value["actual"]["workerWallSeconds"].is_null());
        assert!(value["actual"]["averageCpuCores"].is_null());
        assert_eq!(value["actual"]["cpuSeconds"], 1.5);
    }
}

#[test]
fn only_matching_final_local_invocations_can_be_measured() {
    for path in [
        "/result/jobId",
        "/result/attempt",
        "/result/bootId",
        "/result/started/attempt",
        "/result/started/bootId",
        "/result/started/invocationId",
        "/result/evidence/systemd/MainPID",
        "/result/evidence/systemd/SubState",
    ] {
        let mut job = measured("failed");
        *job.pointer_mut(path).unwrap() = json!("different");
        assert_eq!(
            resources::attempt(&job)["measurement"],
            "unavailable",
            "{path}"
        );
    }
    for status in [
        "queued",
        "running",
        "unknown",
        "cancelled",
        "interrupted",
        "rejected",
    ] {
        let mut job = measured(status);
        if matches!(status, "cancelled" | "interrupted" | "rejected") {
            job["result"]["evidence"] = json!({"groupsEmpty":true,"workerStarted":false});
        }
        let value = resources::attempt(&job);
        assert_eq!(value["measurement"], "unavailable");
        assert!(value["actual"]
            .as_object()
            .unwrap()
            .values()
            .all(Value::is_null));
    }
    let mut remote = measured("succeeded");
    remote["executor"] = json!({"machineName":"Windows or Linux remote"});
    assert_eq!(resources::attempt(&remote)["measurement"], "unavailable");
    assert!(resources::mail(&remote).contains("Remote execution is not metered"));
}

fn budget(cpu: u64, memory: u64) -> Resources {
    Resources {
        cpu_millis: cpu,
        memory_mi_b: memory,
        swap_mi_b: 0,
    }
}
#[test]
fn request_capacity_subtracts_new_collector_once_and_obeys_host_ram() {
    let limit = budget(4000, 8192);
    let available = limit.available(&budget(2000, 4096).reservation());
    let capacity = resources::capacity(
        &limit,
        &available,
        &json!({"hostHeadroomMiB":512,"memoryAvailableMiB":2048}),
    );
    assert_eq!(available, budget(1900, 4032));
    assert_eq!(
        capacity["submission"]["maxRequest"],
        json!({"cpuMillis":3900,"memoryMiB":8128,"swapMiB":0})
    );
    assert_eq!(
        capacity["snapshot"]["maxRequest"],
        json!({"cpuMillis":1800,"memoryMiB":1472,"swapMiB":0})
    );
    assert_eq!(capacity["snapshot"]["meetsMinimum"], true);
    let roomy = resources::capacity(&limit, &available, &json!({"memoryAvailableMiB":100000}));
    assert_eq!(roomy["snapshot"]["maxRequest"]["memoryMiB"], 3968);
}

#[test]
fn capacity_minimum_unknown_host_and_saturated_budget_are_explicit() {
    for (cpu, memory, fits) in [
        (200, 128, true),
        (199, 128, false),
        (200, 127, false),
        (0, 0, false),
    ] {
        let b = budget(cpu, memory);
        let value = resources::capacity(
            &b,
            &b,
            &json!({"hostHeadroomMiB":0,"memoryAvailableMiB":1024}),
        );
        assert_eq!(value["submission"]["meetsMinimum"], fits);
        assert_eq!(value["snapshot"]["meetsMinimum"], fits);
    }
    let b = budget(200, 128);
    let unknown = resources::capacity(&b, &b, &json!({}));
    assert!(unknown["snapshot"]["maxRequest"]["memoryMiB"].is_null());
    assert!(unknown["snapshot"]["meetsMinimum"].is_null());
    assert_eq!(
        resources::capacity(&b, &budget(200, 64), &json!({}))["snapshot"]["meetsMinimum"],
        false
    );
    assert_eq!(
        resources::capacity(&b, &b, &json!({"memoryAvailableMiB":2111}))["snapshot"]
            ["meetsMinimum"],
        false
    );
    assert_eq!(
        resources::capacity(&b, &b, &json!({"memoryAvailableMiB":2176}))["snapshot"]
            ["meetsMinimum"],
        true
    );
    let huge = budget(u64::MAX, u64::MAX);
    assert_eq!(
        resources::capacity(&huge, &huge, &json!({}))["submission"]["maxRequest"],
        json!({"cpuMillis":256000,"memoryMiB":1048576,"swapMiB":0})
    );
}

fn lab() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"task","title":"Resource test","status":"doing"}),
        )
        .unwrap();
    (dir, ws)
}
fn machine() -> Value {
    json!({"id":"local-test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":8192,"swapMiB":0},"memoryAvailableMiB":10000,"hostHeadroomMiB":512})
}
fn mail(s: &Store) -> Vec<Value> {
    s.collaboration_call(Some("a"), "peer_read", json!({"limit":50}))
        .unwrap()["messages"]
        .as_array()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn job_get_and_completion_mail_share_measured_failure_and_budget_keeps_available() {
    let (_dir, ws) = lab();
    let s = &ws.store;
    let input: Submit = serde_json::from_value(json!({"requestId":"job","taskId":"T-1","name":"Measure","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":2000,"memoryMiB":512,"swapMiB":0}})).unwrap();
    let job = s
        .create_job(
            Some("a"),
            input,
            json!({"cwd":"/workspace"}),
            machine(),
            json!({"bootId":"boot"}),
        )
        .unwrap();
    let id = job["id"].as_str().unwrap();
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    let b = s.job_budget_view(machine()).unwrap();
    assert_eq!(
        b["available"],
        json!({"cpuMillis":1900,"memoryMiB":7616,"swapMiB":0})
    );
    assert_eq!(
        b["requestCapacity"]["snapshot"]["maxRequest"],
        json!({"cpuMillis":1800,"memoryMiB":7552,"swapMiB":0})
    );
    assert!(b["requestCapacity"]["snapshot"]["observedAt"].is_string());
    assert!(s
        .update_job_evidence(id, result(&job, "failed", 64))
        .unwrap());
    let view = call(
        ws.clone(),
        Some("a".into()),
        "job_get".into(),
        json!({"jobId":id}),
    )
    .await
    .unwrap();
    assert_eq!(view["resourceSummary"]["actual"]["memoryPeakMiB"], 64.0);
    assert_eq!(view["resourceSummary"]["actual"]["averageCpuCores"], 0.5);
    let messages = mail(s);
    assert_eq!(messages.len(), 1);
    assert!(messages[0]["body"]
        .as_str()
        .unwrap()
        .contains("peak memory 64.00/512.00 MiB; average CPU 0.50/2.00 cores"));
    assert!(!s
        .update_job_evidence(id, result(&job, "failed", 64))
        .unwrap());
    assert_eq!(mail(s).len(), 1, "projection adds no new notification");
}

#[test]
fn run_resources_keep_failed_retries_separate_and_exclude_reused_producers() {
    let (_dir, ws) = lab();
    let s = &ws.store;
    let input: runs::RunSubmit = serde_json::from_value(json!({"requestId":"run","taskId":"T-1","name":"Resources","stages":[
        {"key":"cached","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":2000,"memoryMiB":512,"swapMiB":0}},
        {"key":"work","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":2000,"memoryMiB":512,"swapMiB":0},"retry":{"attempts":2,"exitCodes":[75]}}
    ]})).unwrap();
    // Store boundary: reuse was already verified by preparation. It has no new attempt.
    let prepared = input
        .stages
        .iter()
        .enumerate()
        .map(|(index, stage)| {
            let submit = input.submit(stage);
            let snapshot = json!({"cwd":"/workspace","git":{"head":"fixture"}});
            runs::Prepared {
                identity: runs::spec_identity(&submit, &snapshot, stage.needs()),
                submit,
                snapshot,
                reuse: if index == 0 {
                    Some(json!({"jobId":"old-producer","artifacts":[]}))
                } else {
                    None
                },
                guard_exclude: vec![],
            }
        })
        .collect();
    let run = s
        .create_run(
            Some("a"),
            input,
            prepared,
            machine(),
            json!({"bootId":"boot"}),
        )
        .unwrap();
    let first = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert!(s
        .update_job_evidence(first["id"].as_str().unwrap(), result(&first, "failed", 64))
        .unwrap());
    assert!(
        mail(s).is_empty(),
        "declared retry still suppresses its failure mail"
    );
    let second = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert!(s
        .update_job_evidence(
            second["id"].as_str().unwrap(),
            result(&second, "succeeded", 96)
        )
        .unwrap());
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "succeeded");
    assert_eq!(view["stages"][0]["attempts"], json!([]));
    let attempts = view["stages"][1]["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(
        attempts[0]["resourceSummary"]["actual"]["memoryPeakMiB"],
        64.0
    );
    assert_eq!(
        attempts[1]["resourceSummary"]["actual"]["memoryPeakMiB"],
        96.0
    );
    assert!(
        view["resourceSummary"].is_null(),
        "no sum of peaks across attempts"
    );
    let messages = mail(s);
    assert_eq!(messages.len(), 1);
    let body = messages[0]["body"].as_str().unwrap();
    assert!(body.contains("Resources (2/2 attempts shown"));
    assert!(body.contains("work attempt 1") && body.contains("work attempt 2"));
    assert!(body.contains("64.00/512.00 MiB") && body.contains("96.00/512.00 MiB"));
    assert!(!body.contains("cached attempt"));
    s.advance_runs().unwrap();
    assert_eq!(mail(s).len(), 1);
}

#[test]
fn run_mail_is_bounded_without_aggregating_parallel_peaks() {
    let jobs = (1..=20)
        .map(|n| {
            let mut job = measured("succeeded");
            job["id"] = json!(format!("job-{n}"));
            job["result"]["jobId"] = job["id"].clone();
            job["run"] = json!({"stage":"work","attempt":n});
            job["finishedAt"] = json!(format!("{n:02}"));
            job
        })
        .collect();
    let text = resources::run_mail(&BTreeMap::from([("work".into(), jobs)]));
    assert!(text.contains("12/20 attempts shown"));
    assert!(!text.contains("work attempt 8 ("));
    assert!(text.contains("work attempt 9 (") && text.contains("work attempt 20 ("));
    assert_eq!(text.matches("peak memory 64.00/512.00").count(), 12);
}

#[test]
#[ignore = "Requires captured real synthetic Job evidence in YUZUNO_RESOURCE_FIXTURES"]
fn captured_worker_evidence_has_usable_resource_summary() {
    let path = std::env::var("YUZUNO_RESOURCE_FIXTURES").unwrap();
    let jobs: Vec<Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(jobs.len(), 2);
    for job in jobs {
        let summary = resources::attempt(&job);
        assert_eq!(summary["measurement"], "complete", "{summary}");
        assert!(summary["actual"]["memoryPeakMiB"].as_f64().unwrap() >= 16.0);
        assert!(summary["actual"]["cpuSeconds"].as_f64().unwrap() >= 0.35);
        assert!(summary["actual"]["workerWallSeconds"].as_f64().unwrap() > 0.0);
        println!("{} {} {summary}", job["id"], job["status"]);
    }
}
