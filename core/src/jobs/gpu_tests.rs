//! GPU admission and the fair scan: devices by UUID, exclusive by default,
//! shared only after the user opts in, memory checked conservatively against
//! the latest sample, GPU waiters holding only their device, CPU work never
//! held behind a GPU waiter, projects taking turns, long waiters first, the
//! global exclusive barrier kept. Store-level; sampling itself is in the
//! helper tests and the real CUDA lab.
use super::*;
use crate::{model::AgentDetail, store::Store};
use std::sync::Barrier;

const GPU0: &str = "GPU-00000000-1111-2222-3333-444444444444";
const GPU1: &str = "GPU-55555555-6666-7777-8888-999999999999";

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
            json!({"requestId":"task","title":"GPU research","status":"doing"}),
        )
        .unwrap();
    store
        .set_job_budget(Resources {
            cpu_millis: 4000,
            memory_mi_b: 4096,
            swap_mi_b: 0,
        })
        .unwrap();
    (dir, store)
}
fn machine() -> Value {
    json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}})
}
fn card(uuid: &str, index: u64, free: u64) -> Value {
    json!({"index":index,"uuid":uuid,"name":"Test GPU","memoryTotalMiB":32607,"memoryFreeMiB":free,"memoryUsedMiB":32607 - free,"utilizationPercent":40})
}
fn sample(s: &Store, devices: Value) {
    s.record_gpu_sample(json!({"source":"test","devices":devices}))
        .unwrap();
}
fn job(s: &Store, id: &str, agent: &str, cpu: u64, gpu: Option<Value>) -> Result<Value> {
    let mut request = json!({"requestId":id,"taskId":"T-1","name":id,"cwd":"/workspace","argv":["/usr/bin/true"],
        "resources":{"cpuMillis":cpu,"memoryMiB":128,"swapMiB":0}});
    if let Some(gpu) = gpu {
        request["gpu"] = gpu;
    }
    let input: Submit = serde_json::from_value(request).unwrap();
    input.validate()?;
    s.create_job(
        Some(agent),
        input,
        json!({"cwd":"/workspace"}),
        machine(),
        json!({"bootId":"boot"}),
    )
}
fn gpu(s: &Store, id: &str, memory: u64, mode: &str) -> Value {
    job(
        s,
        id,
        "a",
        200,
        Some(json!({"memoryMiB":memory,"mode":mode})),
    )
    .unwrap()
}
fn cpu(s: &Store, id: &str, agent: &str, millis: u64) -> Value {
    job(s, id, agent, millis, None).unwrap()
}
fn start(s: &Store) -> Option<Value> {
    s.reserve_next_job(None, None, None).unwrap()
}
fn done(s: &Store, job: &Value) {
    s.update_job_evidence(job["id"].as_str().unwrap(),
        json!({"jobId":job["id"],"attempt":job["attempt"],"status":"succeeded","reason":"success","evidence":{}})).unwrap();
}
fn reason(s: &Store, job: &Value) -> String {
    s.job(job["id"].as_str().unwrap()).unwrap()["reason"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn two_gpu_jobs_racing_for_one_device_admit_exactly_one() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000)]));
    let first = gpu(&s, "g1", 4096, "exclusive");
    let second = gpu(&s, "g2", 4096, "exclusive");
    let barrier = Arc::new(Barrier::new(4));
    let admitted: Vec<Value> = (0..4)
        .map(|_| {
            let (s, barrier) = (s.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                s.reserve_next_job(None, None, None).unwrap()
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .filter_map(|t| t.join().unwrap())
        .collect();
    assert_eq!(admitted.len(), 1);
    assert_eq!(admitted[0]["id"], first["id"]);
    assert_eq!(
        admitted[0]["gpuReservation"],
        json!([{"uuid":GPU0,"index":0,"name":"Test GPU","memoryMiB":4096,"mode":"exclusive"}])
    );
    assert!(
        reason(&s, &second).contains("is in use by managed job g1"),
        "{}",
        reason(&s, &second)
    );
    done(&s, &first);
    assert_eq!(start(&s).unwrap()["id"], second["id"]);
}

#[test]
fn sharing_needs_the_users_opt_in_and_memory_is_checked_conservatively() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 12000)]));
    let g1 = gpu(&s, "g1", 4000, "shared");
    assert!(start(&s).is_none());
    assert!(reason(&s, &g1).contains("not open for sharing"));
    s.set_gpu_sharing(GPU0, Some(true), None).unwrap();
    assert_eq!(start(&s).unwrap()["id"], g1["id"]);
    let g2 = gpu(&s, "g2", 4000, "shared");
    assert_eq!(start(&s).unwrap()["id"], g2["id"]);
    // 12000 free when sampled, less 8000 reserved, less 1024 kept free:
    // 2976 MiB for a new job, not one more.
    let g3 = gpu(&s, "g3", 2977, "shared");
    let (none, changed) = s.reserve_next(None, None, None).unwrap();
    assert!(none.is_none() && changed);
    let told = reason(&s, &g3);
    assert!(
        told.contains("has too little free memory for 2977 MiB once 8000 MiB reserved by managed jobs and 1024 MiB kept free are set aside"),
        "{told}"
    );
    // A resample whose free memory moved but still does not fit leaves the
    // waiting job as it is: no rewrite, no change to announce.
    sample(&s, json!([card(GPU0, 0, 11900)]));
    let (none, changed) = s.reserve_next(None, None, None).unwrap();
    assert!(none.is_none() && !changed);
    assert_eq!(reason(&s, &g3), told);
    s.request_job_cancel(None, g3["id"].as_str().unwrap())
        .unwrap();
    sample(&s, json!([card(GPU0, 0, 12000)]));
    let g4 = gpu(&s, "g4", 2976, "shared");
    assert_eq!(start(&s).unwrap()["id"], g4["id"]);
    // An exclusive request does not join shared holders.
    let x = gpu(&s, "x", 1000, "exclusive");
    assert!(start(&s).is_none());
    assert!(reason(&s, &x).contains("in use by managed job g1, g2, g4"));
}

#[test]
fn without_a_current_sample_gpu_jobs_wait_and_cpu_jobs_do_not() {
    let (_dir, s) = setup();
    let g = gpu(&s, "g", 1000, "exclusive");
    let c = cpu(&s, "c", "a", 200);
    assert_eq!(start(&s).unwrap()["id"], c["id"]);
    assert!(reason(&s, &g)
        .contains("Waiting for a current GPU sample: no GPU sample has been taken yet"));
    s.record_gpu_sample(json!({"error":"libnvidia-ml.so.1 not loadable","devices":[]}))
        .unwrap();
    assert!(start(&s).is_none());
    assert!(reason(&s, &g).contains("GPU sampling failed: libnvidia-ml.so.1 not loadable"));
    sample(&s, json!([card(GPU0, 0, 16000)]));
    // A sample older than the limit is not used.
    let old = (chrono::Utc::now() - chrono::Duration::seconds(gpu::STALE_SECS + 30)).to_rfc3339();
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE local_job_gpu_sample SET data=json_set(data,'$.observedAt',?1)",
            [old],
        )
        .unwrap();
    assert!(start(&s).is_none());
    assert!(reason(&s, &g).contains("older than 60 s"));
    sample(&s, json!([card(GPU0, 0, 16000)]));
    assert_eq!(start(&s).unwrap()["id"], g["id"]);
}

#[test]
fn cpu_work_passes_a_gpu_waiter_but_nothing_passes_a_cpu_waiter() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000)]));
    let g1 = gpu(&s, "g1", 4096, "exclusive");
    assert_eq!(start(&s).unwrap()["id"], g1["id"]);
    let g2 = gpu(&s, "g2", 4096, "exclusive");
    let c1 = cpu(&s, "c1", "a", 200);
    assert_eq!(
        start(&s).unwrap()["id"],
        c1["id"],
        "CPU work is not held behind a GPU waiter"
    );
    assert!(reason(&s, &g2).contains("in use by managed job g1"));
    // A job short of the shared CPU budget holds everything after it.
    let big = cpu(&s, "big", "a", 3800);
    let small = cpu(&s, "small", "a", 200);
    assert!(start(&s).is_none());
    assert!(reason(&s, &big).contains("Waiting for shared CPU quota"));
    assert_eq!(
        reason(&s, &small),
        "Waiting behind big, which needs the shared CPU/RAM budget first; jobs do not pass it"
    );
}

#[test]
fn an_earlier_gpu_waiter_holds_its_device_against_later_gpu_jobs() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000)]));
    s.set_gpu_sharing(GPU0, Some(true), None).unwrap();
    let g1 = gpu(&s, "g1", 8000, "shared");
    assert_eq!(start(&s).unwrap()["id"], g1["id"]);
    let g2 = gpu(&s, "g2", 10000, "shared");
    let g3 = gpu(&s, "g3", 2000, "shared");
    assert!(start(&s).is_none());
    assert!(reason(&s, &g2).contains(
        "has too little free memory for 10000 MiB once 8000 MiB reserved by managed jobs"
    ));
    assert!(
        reason(&s, &g3).contains("held for an earlier job waiting for it"),
        "{}",
        reason(&s, &g3)
    );
    done(&s, &g1);
    assert_eq!(start(&s).unwrap()["id"], g2["id"]);
    assert_eq!(start(&s).unwrap()["id"], g3["id"]);
}

#[test]
fn projects_take_turns_and_a_long_waiting_job_goes_first() {
    let (_dir, s) = setup();
    s.set_job_budget(Resources {
        cpu_millis: 400,
        memory_mi_b: 512,
        swap_mi_b: 0,
    })
    .unwrap();
    let a1 = cpu(&s, "a1", "a", 200);
    let a2 = cpu(&s, "a2", "a", 200);
    let a3 = cpu(&s, "a3", "a", 200);
    let b1 = cpu(&s, "b1", "b", 200);
    let first = start(&s).unwrap();
    assert_eq!(first["id"], a1["id"]);
    done(&s, &first);
    let second = start(&s).unwrap();
    assert_eq!(second["id"], b1["id"], "the other project's turn");
    done(&s, &second);
    // a3 has waited past the aging limit: it goes before a2.
    let old = (chrono::Utc::now() - chrono::Duration::seconds(queue::AGING_SECS + 60)).to_rfc3339();
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE local_jobs SET data=json_set(data,'$.createdAt',?1) WHERE id=?2",
            rusqlite::params![old, a3["id"].as_str()],
        )
        .unwrap();
    assert_eq!(start(&s).unwrap()["id"], a3["id"]);
    let _ = a2;
}

#[test]
fn the_global_exclusive_barrier_is_not_bypassed_by_gpu_or_cpu_work() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000)]));
    let running = cpu(&s, "running", "a", 200);
    assert_eq!(start(&s).unwrap()["id"], running["id"]);
    let mut request: Submit = serde_json::from_value(json!({"requestId":"x","taskId":"T-1","name":"x","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":200,"memoryMiB":128,"swapMiB":0}})).unwrap();
    request.exclusive = true;
    let x = s
        .create_job(
            Some("b"),
            request,
            json!({"cwd":"/workspace"}),
            machine(),
            json!({"bootId":"boot"}),
        )
        .unwrap();
    let g = gpu(&s, "g", 1000, "exclusive");
    let c = cpu(&s, "c", "a", 200);
    assert!(start(&s).is_none());
    assert!(reason(&s, &x).contains("running jobs"));
    assert!(reason(&s, &g).contains("earlier exclusive job"));
    assert!(reason(&s, &c).contains("earlier exclusive job"));
    done(&s, &running);
    assert_eq!(start(&s).unwrap()["id"], x["id"]);
    assert!(start(&s).is_none());
    assert!(reason(&s, &g).contains("exclusive job to finish"));
}

#[test]
fn reservations_stay_through_unknown_and_cancelling_and_go_with_the_job() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000)]));
    let g1 = gpu(&s, "g1", 4096, "exclusive");
    let held = start(&s).unwrap();
    let g2 = gpu(&s, "g2", 4096, "exclusive");
    s.job_unknown(g1["id"].as_str().unwrap(), "test: outcome unknown")
        .unwrap();
    assert!(start(&s).is_none());
    s.request_job_cancel(None, g1["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        s.job(g1["id"].as_str().unwrap()).unwrap()["status"],
        "cancelling"
    );
    assert!(start(&s).is_none());
    assert!(reason(&s, &g2).contains("in use by managed job g1"));
    // A paused job (T-107) keeps reserved=true and so keeps its device too.
    s.db.write().unwrap().execute(
        "UPDATE local_jobs SET data=json_set(data,'$.pause',json('{\"state\":\"paused\"}')) WHERE id=?1", [g1["id"].as_str()]).unwrap();
    assert!(start(&s).is_none());
    s.update_job_evidence(g1["id"].as_str().unwrap(),
        json!({"jobId":held["id"],"attempt":held["attempt"],"status":"cancelled","reason":"cancelled","evidence":{}})).unwrap();
    assert_eq!(start(&s).unwrap()["id"], g2["id"]);
}

#[test]
fn closing_a_device_stops_only_new_admission_and_survives_a_restart() {
    let (dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000), card(GPU1, 1, 16000)]));
    let g1 = gpu(&s, "g1", 4096, "exclusive");
    assert_eq!(start(&s).unwrap()["gpuReservation"][0]["uuid"], GPU0);
    s.set_gpu_admission(GPU1, false, Some("a game is running".into()), None)
        .unwrap();
    let g2 = gpu(&s, "g2", 4096, "exclusive");
    assert!(start(&s).is_none());
    let told = reason(&s, &g2);
    assert!(
        told.contains("is in use by managed job g1")
            && told.contains("closed to new jobs (a game is running)"),
        "{told}"
    );
    // Lowering the budget or reopening storage keeps the setting and the reservation.
    s.set_job_budget(Resources {
        cpu_millis: 200,
        memory_mi_b: 128,
        swap_mi_b: 0,
    })
    .unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(
        s.job(g1["id"].as_str().unwrap()).unwrap()["gpuReservation"][0]["uuid"],
        GPU0
    );
    let devices = s.gpu_devices().unwrap();
    assert_eq!(devices["devices"][1]["admission"], "closed");
    assert_eq!(devices["devices"][0]["reservations"][0]["name"], "g1");
    s.set_job_budget(Resources {
        cpu_millis: 4000,
        memory_mi_b: 4096,
        swap_mi_b: 0,
    })
    .unwrap();
    sample(&s, json!([card(GPU0, 0, 16000), card(GPU1, 1, 16000)]));
    s.set_gpu_admission(GPU1, true, None, None).unwrap();
    assert_eq!(start(&s).unwrap()["gpuReservation"][0]["uuid"], GPU1);
}

#[test]
fn an_agent_cannot_reopen_or_replace_a_close_the_user_made() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000)]));
    let device = |s: &Store| s.gpu_devices().unwrap()["devices"][0].clone();
    s.set_gpu_admission(GPU0, false, Some("a game is running".into()), None)
        .unwrap();
    assert_eq!(device(&s)["closedBy"], "user");
    let error = s
        .set_gpu_admission(GPU0, true, None, Some("a"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("only the user can open it again"), "{error}");
    // An Agent closing it too changes nothing: it stays the user's close.
    s.set_gpu_admission(GPU0, false, Some("agent cleanup".into()), Some("a"))
        .unwrap();
    assert_eq!(
        (
            device(&s)["closedBy"].clone(),
            device(&s)["closedReason"].clone()
        ),
        (json!("user"), json!("a game is running"))
    );
    let g = gpu(&s, "g", 1000, "exclusive");
    assert!(start(&s).is_none());
    s.set_gpu_admission(GPU0, true, None, None).unwrap();
    assert_eq!(start(&s).unwrap()["id"], g["id"]);
    // A close an Agent made, an Agent can undo; the user can as well.
    s.set_gpu_admission(GPU0, false, Some("agent cleanup".into()), Some("a"))
        .unwrap();
    assert_eq!(device(&s)["closedBy"], "agent");
    s.set_gpu_admission(GPU0, true, None, Some("b")).unwrap();
    assert_eq!(
        (
            device(&s)["admission"].clone(),
            device(&s)["closedBy"].clone()
        ),
        (json!("open"), Value::Null)
    );
}

#[test]
fn a_known_gpu_missing_from_the_current_sample_is_named_not_counted_empty() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000), card(GPU1, 1, 16000)]));
    sample(&s, json!([card(GPU0, 0, 16000)]));
    let pinned = job(
        &s,
        "pinned",
        "a",
        200,
        Some(json!({"memoryMiB":1000,"devices":[GPU1]})),
    )
    .unwrap();
    let any = gpu(&s, "any", 1000, "exclusive");
    assert_eq!(start(&s).unwrap()["gpuReservation"][0]["uuid"], GPU0);
    let told = reason(&s, &pinned);
    assert_eq!(
        told,
        format!("Waiting for GPU {GPU1}, which is not present in the current sample")
    );
    assert_eq!(
        s.job(any["id"].as_str().unwrap()).unwrap()["gpuReservation"][0]["uuid"],
        GPU0
    );
    assert!(s.gpu_devices().unwrap()["devices"][1]["memoryFreeMiB"].is_null());
}

#[test]
fn a_full_slot_count_or_a_lowered_budget_is_told_to_every_waiting_job() {
    let (_dir, s) = setup();
    let running: Vec<Value> = (0..4)
        .map(|i| cpu(&s, &format!("r{i}"), "a", 200))
        .collect();
    for _ in &running {
        start(&s).unwrap();
    }
    let (w1, w2) = (cpu(&s, "w1", "a", 200), cpu(&s, "w2", "b", 200));
    assert!(start(&s).is_none());
    for w in [&w1, &w2] {
        assert_eq!(reason(&s, w), "Waiting for an execution/collector slot");
    }
    done(&s, &running[0]);
    s.set_job_budget(Resources {
        cpu_millis: 400,
        memory_mi_b: 4096,
        swap_mi_b: 0,
    })
    .unwrap();
    assert!(start(&s).is_none());
    for w in [&w1, &w2] {
        assert!(
            reason(&s, w)
                .starts_with("Waiting for outstanding reservations to fit the lowered budget"),
            "{}",
            reason(&s, w)
        );
    }
}

#[test]
fn a_request_no_device_can_hold_is_refused_and_requests_are_validated() {
    let (_dir, s) = setup();
    // Before any sample, the host is unknown: accepted, it waits.
    assert!(job(&s, "early", "a", 200, Some(json!({"memoryMiB":40000}))).is_ok());
    sample(&s, json!([card(GPU0, 0, 16000)]));
    let error = job(&s, "huge", "a", 200, Some(json!({"memoryMiB":41677})))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("can never fit") && error.contains("31583 MiB"),
        "{error}"
    );
    // Within the total but above what admission can ever give (32607 MiB
    // less 1024 kept free): refused too, not left to hold the device.
    let error = job(&s, "edge", "a", 200, Some(json!({"memoryMiB":31584})))
        .unwrap_err()
        .to_string();
    assert!(error.contains("can never fit"), "{error}");
    assert!(job(&s, "largest", "a", 200, Some(json!({"memoryMiB":31583}))).is_ok());
    let error = job(
        &s,
        "two",
        "a",
        200,
        Some(json!({"memoryMiB":1000,"count":2})),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("can never fit"));
    let error = job(
        &s,
        "other",
        "a",
        200,
        Some(json!({"memoryMiB":1000,"devices":[GPU1]})),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("not known on this machine"));
    for bad in [
        json!({"memoryMiB":10}),
        json!({"memoryMiB":1000,"count":0}),
        json!({"memoryMiB":1000,"devices":["0"]}),
        json!({"memoryMiB":1000,"count":2,"devices":[GPU0]}),
        json!({"memoryMiB":1000,"mode":"any"}),
    ] {
        let parsed: Result<Submit, _> = serde_json::from_value(
            json!({"requestId":"v","taskId":"T-1","name":"v","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":200,"memoryMiB":128,"swapMiB":0},"gpu":bad}),
        );
        assert!(parsed.map_or(true, |p| p.validate().is_err()), "{bad}");
    }
    let tools = tool_definitions();
    let submit = tools.iter().find(|t| t["name"] == "job_submit").unwrap();
    assert!(submit["inputSchema"]["properties"]["gpu"]["properties"]["memoryMiB"].is_object());
    let run = tools
        .iter()
        .find(|t| t["name"] == "job_run_submit")
        .unwrap();
    assert!(run["inputSchema"]["properties"]["stages"]["items"]["properties"]["gpu"].is_object());
    assert!(tools.iter().any(|t| t["name"] == "job_gpu_admission"));
}

#[test]
fn the_budget_view_shows_devices_samples_and_what_managed_jobs_hold() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 16000)]));
    let g1 = gpu(&s, "g1", 4096, "exclusive");
    start(&s).unwrap();
    let view = s.job_budget_view(machine()).unwrap();
    let device = &view["gpus"]["devices"][0];
    assert_eq!(
        (
            device["uuid"].as_str(),
            device["memoryFreeMiB"].as_u64(),
            device["admission"].as_str()
        ),
        (Some(GPU0), Some(16000), Some("open"))
    );
    assert_eq!(device["reservations"][0]["jobId"], g1["id"]);
    assert!(view["gpus"]["problem"].is_null());
    assert!(view["gpus"]["scope"]
        .as_str()
        .unwrap()
        .contains("No memory isolation"));
}

#[test]
fn host_gpu_sampling_and_device_injection() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../acceptance/local-jobs/gpu_host_test.py");
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

#[test]
fn a_job_that_can_no_longer_fit_holds_nothing_from_later_gpu_jobs() {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 32000)]));
    let big = gpu(&s, "big", 31000, "exclusive");
    let small = gpu(&s, "small", 1000, "exclusive");
    // 32000 free less 1024 kept free: big waits, and holds the device.
    assert!(start(&s).is_none());
    assert!(reason(&s, &small).contains("held for an earlier job waiting for it"));
    // Raising the memory kept free leaves big unable ever to fit: it says so
    // and no longer keeps the device from the small job.
    s.set_gpu_sharing(GPU0, None, Some(2048)).unwrap();
    assert_eq!(
        start(&s).map(|j| j["id"].clone()),
        Some(small["id"].clone()),
        "the small job starts"
    );
    assert!(
        reason(&s, &big).contains("can never hold 31000 MiB: 32607 MiB in all, 2048 MiB kept free"),
        "{}",
        reason(&s, &big)
    );
}

#[test]
fn a_multi_gpu_request_that_can_no_longer_be_met_holds_no_device_automatic() {
    multi_gpu_request_that_can_no_longer_be_met(false);
}

#[test]
fn a_multi_gpu_request_that_can_no_longer_be_met_holds_no_device_named() {
    multi_gpu_request_that_can_no_longer_be_met(true);
}

/// Automatic choice (`named` false) or the two devices named.
fn multi_gpu_request_that_can_no_longer_be_met(named: bool) {
    let (_dir, s) = setup();
    sample(&s, json!([card(GPU0, 0, 32000), card(GPU1, 1, 32000)]));
    let mut request = json!({"memoryMiB":31000,"count":2});
    if named {
        request["devices"] = json!([GPU0, GPU1]);
    }
    let big = job(&s, "big", "a", 200, Some(request)).unwrap();
    let small = job(
        &s,
        "small",
        "a",
        200,
        Some(json!({"memoryMiB":1000,"devices":[GPU0]})),
    )
    .unwrap();
    // 32000 free less 1024 kept free on each: big waits, and holds both.
    assert!(start(&s).is_none(), "named={named}");
    assert!(reason(&s, &small).contains("held for an earlier job waiting for it"));
    // GPU1 alone can no longer hold 31000 MiB, so big can never get two
    // devices: it keeps neither from the small job on GPU0.
    s.set_gpu_sharing(GPU1, None, Some(2048)).unwrap();
    assert_eq!(
        start(&s).map(|j| j["id"].clone()),
        Some(small["id"].clone()),
        "the small job starts (named={named})"
    );
    let told = reason(&s, &big);
    assert!(
        told.contains("can never get 2 GPU(s) with 31000 MiB each")
            && told.contains("can never hold 31000 MiB: 32607 MiB in all, 2048 MiB kept free"),
        "{told}"
    );
    // A request that still fits in principle keeps its fair wait.
    let fits = job(
        &s,
        "fits",
        "a",
        200,
        Some(json!({"memoryMiB":30000,"count":2})),
    )
    .unwrap();
    let later = job(
        &s,
        "later",
        "a",
        200,
        Some(json!({"memoryMiB":1000,"devices":[GPU1]})),
    )
    .unwrap();
    assert!(start(&s).is_none());
    assert!(
        reason(&s, &fits).contains("in use by managed job small"),
        "{}",
        reason(&s, &fits)
    );
    assert!(reason(&s, &later).contains("held for an earlier job waiting for it"));
}
