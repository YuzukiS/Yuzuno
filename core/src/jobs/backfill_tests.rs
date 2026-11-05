//! T-38: a later job may start ahead of a queue head short of the configured
//! budget, only within what the head's need leaves; nothing passes a head
//! short of host memory; GPU and disk waits keep their own rules.
use super::*;
use crate::{model::AgentDetail, store::Store};

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    // Two Agents without a Project: two queues that take turns.
    for id in ["a", "b"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        store.insert(&agent).unwrap();
    }
    store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Research checks","status":"doing"})).unwrap();
    // The budget of 2026-11-05: 40,960 MiB RAM.
    store.set_job_budget(Resources { cpu_millis: 16000, memory_mi_b: 40960, swap_mi_b: 0 }).unwrap();
    (dir, store)
}
/// A job asking `memory` MiB, so `memory + 64` with its collector.
fn job(s: &Store, name: &str, memory: u64) -> Value {
    job_of(s, "a", name, memory)
}
fn job_of(s: &Store, agent: &str, name: &str, memory: u64) -> Value {
    let request: Submit = serde_json::from_value(json!({"requestId":name,"taskId":"T-1","name":name,"cwd":"/workspace",
        "argv":["/usr/bin/true"],"resources":{"cpuMillis":1000,"memoryMiB":memory,"swapMiB":0}})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":16000,"memoryMiB":40960,"swapMiB":0}});
    s.create_job(Some(agent), request, json!({"cwd":"/workspace"}), machine, json!({"bootId":"boot"})).unwrap()
}
/// RAM held now by the jobs that started ahead of a head, any head.
fn passers(s: &Store) -> u64 {
    s.db.read().unwrap().prepare("SELECT json_extract(data,'$.reservation.memoryMiB') FROM local_jobs
        WHERE reserved=1 AND json_type(data,'$.admission.passed')='object'").unwrap()
        .query_map([], |r| r.get::<_, i64>(0)).unwrap().map(|n| n.unwrap() as u64).sum()
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

#[test]
fn heads_taking_turns_never_let_the_passers_take_the_current_heads_share_and_both_start() {
    // Review 1bbccc2a: which job is the head changes with the projects'
    // turns; the jobs that passed the other head count too.
    let (_dir, s) = setup();
    s.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 10240, swap_mi_b: 0 }).unwrap();
    let running = job_of(&s, "a", "running", 4000);
    assert_eq!(start(&s).unwrap()["id"], running["id"]);
    // Both short of the 6,176 MiB free: 7,064 (a) and 6,564 (b).
    let head_a = job_of(&s, "a", "head a", 7000);
    let head_b = job_of(&s, "b", "head b", 6500);
    for i in 0..4 {
        job_of(&s, "a", &format!("small a{i}"), 1000);
        job_of(&s, "b", &format!("small b{i}"), 1000);
    }
    let mut started = vec![];
    // A pass at a time while nothing ends: every pass holds the current
    // head's share open, whichever head it is.
    while let Some(passed) = start(&s) {
        let mark = &passed["admission"]["passed"];
        let bound = 10240 - mark["headNeed"]["memoryMiB"].as_u64().expect("only passers start here");
        assert!(passers(&s) <= bound, "running passers {} MiB stay within the budget less {}'s need ({bound} MiB)", passers(&s), mark["name"]);
        started.push(passed["name"].clone());
    }
    assert!(started.len() >= 2, "{started:?}");
    // Then jobs end, one at a time: both heads start.
    done(&s, &running);
    let mut heads = vec![];
    for _ in 0..40 {
        match start(&s) {
            Some(job) if job["id"] == head_a["id"] || job["id"] == head_b["id"] => heads.push(job["name"].clone()),
            Some(_) => {}
            None => {
                let oldest: Option<String> = s.db.read().unwrap().query_row(
                    "SELECT id FROM local_jobs WHERE reserved=1 ORDER BY seq LIMIT 1", [], |r| r.get(0)).ok();
                let Some(id) = oldest else { break };
                done(&s, &s.job(&id).unwrap());
            }
        }
        if heads.len() == 2 {
            break;
        }
    }
    assert_eq!(heads.len(), 2, "both heads start: {heads:?}");
}

#[test]
fn the_jobs_that_passed_a_cancelled_head_still_count_against_the_next_one() {
    let (_dir, s) = setup();
    s.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 10240, swap_mi_b: 0 }).unwrap();
    let running = job(&s, "running", 4000);
    assert_eq!(start(&s).unwrap()["id"], running["id"]);
    let first = job(&s, "first head", 7000);
    let small = job(&s, "small", 1000);
    let next = job(&s, "next head", 6500);
    let larger = job(&s, "larger", 3000);
    assert_eq!(start(&s).unwrap()["id"], small["id"], "1,064 MiB passes the first head");
    assert!(start(&s).is_none());
    s.request_job_cancel(None, first["id"].as_str().unwrap()).unwrap();
    // The next head leaves 10,240 − 6,564 − 1,064 = 2,612 MiB: 3,064 does not fit.
    assert!(start(&s).is_none(), "the small job that passed the cancelled head still counts against the next one");
    assert!(read(&s, &next)["reason"].as_str().unwrap().ends_with("Up to 29800 mCPU / 2612 MiB RAM / 0 MiB swap may start ahead of it meanwhile"),
        "{}", read(&s, &next)["reason"]);
    assert!(read(&s, &larger)["reason"].as_str().unwrap().starts_with("Waiting behind next head"));
}
