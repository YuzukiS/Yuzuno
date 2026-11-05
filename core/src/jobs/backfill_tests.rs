//! T-38: a later job may start ahead of a queue head short of the configured
//! budget, only within what the head's need leaves; nothing passes a head
//! short of host memory; GPU and disk waits keep their own rules.
use super::*;
use crate::{model::AgentDetail, store::Store};

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
    store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Research checks","status":"doing"})).unwrap();
    // The budget of 2026-11-05: 40,960 MiB RAM.
    store.set_job_budget(Resources { cpu_millis: 16000, memory_mi_b: 40960, swap_mi_b: 0 }).unwrap();
    (dir, store)
}
/// A job asking `memory` MiB, so `memory + 64` with its collector.
fn job(s: &Store, name: &str, memory: u64) -> Value {
    let request: Submit = serde_json::from_value(json!({"requestId":name,"taskId":"T-1","name":name,"cwd":"/workspace",
        "argv":["/usr/bin/true"],"resources":{"cpuMillis":1000,"memoryMiB":memory,"swapMiB":0}})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":16000,"memoryMiB":40960,"swapMiB":0}});
    s.create_job(Some("a"), request, json!({"cwd":"/workspace"}), machine, json!({"bootId":"boot"})).unwrap()
}
fn start(s: &Store) -> Option<Value> {
    s.reserve_next_job(None, None, None).unwrap()
}
fn done(s: &Store, job: &Value) {
    s.update_job_evidence(job["id"].as_str().unwrap(),
        json!({"jobId":job["id"],"attempt":job["attempt"],"status":"succeeded","reason":"success","evidence":{}})).unwrap();
}
fn read(s: &Store, job: &Value) -> Value {
    s.job(job["id"].as_str().unwrap()).unwrap()
}

#[test]
fn a_later_job_starts_ahead_of_a_head_short_of_the_budget_only_within_what_its_need_leaves() {
    let (_dir, s) = setup();
    // An earlier stage holds 16,448 MiB; the check at the head needs 24,640
    // of the 24,512 left.
    let running = job(&s, "earlier stage", 16384);
    assert_eq!(start(&s).unwrap()["id"], running["id"]);
    let head = job(&s, "check", 24576);
    let small = job(&s, "k5", 12288);
    let second = job(&s, "w10", 4096);
    // 12,352 MiB fits in the 16,320 the head's need leaves.
    let passed = start(&s).expect("the 12,352 MiB job starts ahead of the head");
    assert_eq!(passed["id"], small["id"]);
    assert_eq!(passed["admission"]["passed"]["jobId"], head["id"], "marked with the head it passed");
    assert_eq!(passed["admission"]["passed"]["room"]["memoryMiB"], 16320);
    assert_eq!(passed["reason"], "Capacity reserved ahead of check, which waits for shared RAM reservation: this job's 1100 mCPU / 12352 MiB RAM / 0 MiB swap fits in the 14900 mCPU / 16320 MiB RAM / 0 MiB swap left beside it; verifying and launching one attempt");
    assert_eq!(read(&s, &head)["reason"], "Waiting for shared RAM reservation: needs 24640 MiB including collector, 24512 MiB available; short 128 MiB. Up to 14900 mCPU / 16320 MiB RAM / 0 MiB swap may start ahead of it meanwhile");
    assert_eq!(read(&s, &head)["status"], "queued", "the head keeps its place");
    // 12,352 + 4,160 > 16,320: the second does not pass.
    assert!(start(&s).is_none(), "the 4,160 MiB job does not pass: 12,352 + 4,160 > 16,320");
    assert_eq!(read(&s, &second)["reason"], "Waiting behind check, which waits for shared RAM reservation: this job needs 1100 mCPU / 4160 MiB RAM / 0 MiB swap; 13800 mCPU / 3968 MiB RAM / 0 MiB swap may start ahead of it now");
    assert_eq!(read(&s, &head)["reason"], "Waiting for shared RAM reservation: needs 24640 MiB including collector, 12160 MiB available; short 12480 MiB. Up to 13800 mCPU / 3968 MiB RAM / 0 MiB swap may start ahead of it meanwhile");
    // The earlier stage ends: the head starts first, before the waiting job.
    done(&s, &running);
    assert_eq!(start(&s).unwrap()["id"], head["id"], "the head starts once the running job ends");
    assert!(read(&s, &head)["admission"].is_null());
}

#[test]
fn nothing_passes_a_head_short_of_host_memory() {
    let (_dir, s) = setup();
    // The budget would take both; the host has 20,000 MiB free after headroom.
    let head = job(&s, "big", 24576);
    let small = job(&s, "small", 4096);
    assert!(s.reserve_next_job(Some(20000), None, None).unwrap().is_none(), "host memory is not held for anyone");
    assert!(read(&s, &head)["reason"].as_str().unwrap().starts_with("Waiting for host memory while preserving Core/desktop headroom"));
    assert_eq!(read(&s, &small)["reason"], "Waiting behind big, which waits for host memory first; jobs do not pass it");
}

#[test]
fn a_head_waiting_for_disk_space_bounds_nothing_behind_it() {
    let (_dir, s) = setup();
    let low = job(&s, "low disk", 24576);
    // More than the 16,320 MiB a budget head of this size would leave.
    let next = job(&s, "next", 20480);
    let verdicts = [
        DiskCheck { job_id: low["id"].as_str().unwrap().into(), verdict: disk::Verdict::Wait("Waiting for disk space: test reason".into()) },
        DiskCheck { job_id: next["id"].as_str().unwrap().into(), verdict: disk::Verdict::Start },
    ];
    let started = s.reserve_next_job(None, None, Some(&verdicts)).unwrap().expect("a disk wait is passed as before");
    assert_eq!(started["id"], next["id"]);
    assert!(started["admission"].is_null(), "a disk wait is not a backfill head");
}
