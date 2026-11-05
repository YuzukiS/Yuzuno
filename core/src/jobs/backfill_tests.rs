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
    job_in(s, "T-1", agent, name, memory)
}
fn job_in(s: &Store, task: &str, agent: &str, name: &str, memory: u64) -> Value {
    let request: Submit = serde_json::from_value(json!({"requestId":name,"taskId":task,"name":name,"cwd":"/workspace",
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
    // turns, so the jobs that passed the other head count too.
    let (_dir, s) = setup();
    s.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 10240, swap_mi_b: 0 }).unwrap();
    // Two Projects, one task each: two queues that take turns.
    s.collaboration_call(None, "task_create", json!({"requestId":"task-2","title":"Other research","status":"doing"})).unwrap();
    for (task, name) in [("T-1", "Project P"), ("T-2", "Project Q")] {
        let project = s.create_project(name, Default::default()).unwrap();
        let db = s.db.write().unwrap();
        let (id, _) = crate::collaboration_store::task_key(&db, task).unwrap();
        crate::projects::set_task_project(&db, &id, Some(project.id.as_str())).unwrap();
    }
    let running = job_in(&s, "T-1", "a", "running", 2000);
    assert_eq!(start(&s).unwrap()["id"], running["id"]);
    // Both short of the 8,176 MiB free, each needing 8,500 MiB: 1,740 MiB
    // may run beside either of them.
    let head_p = job_in(&s, "T-1", "a", "head p", 8436);
    let head_q = job_in(&s, "T-2", "b", "head q", 8436);
    // A small job for each Project, round after round.
    let more = |s: &Store, round: usize| {
        for (task, agent) in [("T-1", "a"), ("T-2", "b")] {
            job_in(s, task, agent, &format!("small {round} of {task}"), 1000);
        }
    };
    more(&s, 0);
    let mut rounds = 1;
    // Q's turn: its head is short, so 1,064 MiB pass it. P's turn: P's head
    // is short too, and the job that passed Q holds 1,064 of the 1,740 MiB
    // beside it, so nothing of 1,064 MiB passes P.
    let first = start(&s).expect("a small job passes the first head");
    assert_eq!(first["admission"]["passed"]["jobId"], head_q["id"]);
    let check = |s: &Store, passed: &Value| {
        let mark = &passed["admission"]["passed"];
        let bound = 10240 - mark["headNeed"]["memoryMiB"].as_u64().expect("only passers start before the heads");
        assert!(passers(s) <= bound, "running passers {} MiB stay within the budget less {}'s need ({bound} MiB)", passers(s), mark["name"]);
    };
    check(&s, &first);
    if let Some(passed) = start(&s) {
        check(&s, &passed);
    }
    assert!(read(&s, &head_p)["reason"].as_str().unwrap().ends_with("Up to 29800 mCPU / 676 MiB RAM / 0 MiB swap may start ahead of it meanwhile"),
        "P's head counts what passed Q: {}", read(&s, &head_p)["reason"]);
    // Then jobs end one at a time while small jobs keep coming: at every
    // admission the passers stay within the budget less the current head's
    // need, and both heads start.
    done(&s, &running);
    let mut heads = vec![];
    for _ in 0..60 {
        match start(&s) {
            Some(job) if job["id"] == head_p["id"] || job["id"] == head_q["id"] => heads.push(job["name"].clone()),
            Some(job) if job["admission"]["passed"].is_object() => check(&s, &job),
            Some(_) => {}
            None => {
                let oldest: Option<String> = s.db.read().unwrap().query_row(
                    "SELECT id FROM local_jobs WHERE reserved=1 ORDER BY seq LIMIT 1", [], |r| r.get(0)).ok();
                let Some(id) = oldest else { break };
                done(&s, &s.job(&id).unwrap());
                if rounds < 6 {
                    more(&s, rounds);
                    rounds += 1;
                }
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
    assert!(read(&s, &first)["admission"].is_null(), "a head cancelled in the queue keeps no mark");
    // The next head leaves 10,240 − 6,564 − 1,064 = 2,612 MiB: 3,064 does not fit.
    assert!(start(&s).is_none(), "the small job that passed the cancelled head still counts against the next one");
    assert!(read(&s, &next)["reason"].as_str().unwrap().ends_with("Up to 29800 mCPU / 2612 MiB RAM / 0 MiB swap may start ahead of it meanwhile"),
        "{}", read(&s, &next)["reason"]);
    assert!(read(&s, &larger)["reason"].as_str().unwrap().starts_with("Waiting behind next head"));
}

/// What provenance's report says of one job's attempt.
fn report_of(job: &Value) -> String {
    let extent = Ok(json!({"segments":1,"oldestOffset":0,"totalBytes":10,"truncated":false}));
    let known = super::provenance::Known::host(std::path::Path::new("/data"), None);
    super::provenance::export(None, &[job.clone()], &[extent], known)["report"].as_str().unwrap().to_owned()
}

#[test]
fn a_retried_stage_that_passed_a_head_starts_its_next_attempt_unmarked_in_its_own_turn() {
    // Review 8a776cd8: the mark belongs to the one start that passed a head.
    let (_dir, s) = setup();
    s.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 10240, swap_mi_b: 0 }).unwrap();
    let running = job(&s, "running", 2000);
    assert_eq!(start(&s).unwrap()["id"], running["id"]);
    // 8,500 MiB of the 8,176 free: the head; 1,740 MiB may run beside it.
    let head = job(&s, "head", 8436);
    // One stage whose exit 75 is retried.
    let input: super::runs::RunSubmit = serde_json::from_value(json!({"requestId":"run","taskId":"T-1","name":"Retried run",
        "stages":[{"key":"api","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":1000,"memoryMiB":1000,"swapMiB":0},
            "retry":{"attempts":2,"exitCodes":[75]}}]})).unwrap();
    let prepared = input.stages.iter().map(|stage| {
        let submit = input.submit(stage);
        let snapshot = json!({"cwd":"/workspace","git":{"head":"abc"},"files":[]});
        let identity = super::runs::spec_identity(&submit, &snapshot, stage.needs());
        super::runs::Prepared { submit, snapshot, identity, reuse: None, guard_exclude: vec![] }
    }).collect();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":16000,"memoryMiB":40960,"swapMiB":0}});
    s.create_run(Some("a"), input, prepared, machine, json!({"bootId":"boot"})).unwrap();
    let first = start(&s).unwrap();
    assert_eq!(first["admission"]["passed"]["jobId"], head["id"], "the first attempt passes the head");
    s.update_job_evidence(first["id"].as_str().unwrap(), json!({"jobId":first["id"],"attempt":first["attempt"],"status":"failed",
        "reason":"exit-code","evidence":{"systemd":{"Result":"exit-code","ExecMainStatus":"75"}}})).unwrap();
    let retry: String = s.db.read().unwrap().query_row(
        "SELECT id FROM local_jobs WHERE json_extract(data,'$.retryOf')=?1", [first["id"].as_str().unwrap()], |r| r.get(0)).unwrap();
    let queued = s.job(&retry).unwrap();
    assert_eq!(queued["status"], "queued");
    assert!(queued.get("admission").is_none(), "the retry is not marked with the head its first attempt passed: {}", queued["admission"]);
    assert!(!report_of(&queued).contains("Started ahead of"));
    // The running job ends: the head starts, then the retry in its own turn.
    done(&s, &running);
    assert_eq!(start(&s).unwrap()["id"], head["id"]);
    let again = start(&s).expect("the retry starts in its turn");
    assert_eq!(again["id"], retry.as_str());
    assert!(again.get("admission").is_none(), "{}", again["admission"]);
    assert_eq!(passers(&s), 0, "nothing running counts as having passed a head");
    assert!(!report_of(&again).contains("Started ahead of"), "{}", report_of(&again));
}

#[test]
fn a_job_reserved_again_in_its_own_turn_keeps_no_mark_from_an_earlier_reservation() {
    let (_dir, s) = setup();
    s.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 10240, swap_mi_b: 0 }).unwrap();
    let running = job(&s, "running", 2000);
    assert_eq!(start(&s).unwrap()["id"], running["id"]);
    let head = job(&s, "head", 8436);
    let small = job(&s, "small", 1000);
    assert_eq!(start(&s).unwrap()["admission"]["passed"]["jobId"], head["id"], "it passes the head first");
    // Back in the queue, as a reservation released before launch leaves it,
    // and the head is gone: the next reservation is in its own turn.
    let mut back = read(&s, &small);
    back["status"] = json!("queued");
    back["reserved"] = json!(false);
    super::store::save(&s.db.write().unwrap(), &back).unwrap();
    s.request_job_cancel(None, head["id"].as_str().unwrap()).unwrap();
    let again = start(&s).expect("it starts in its turn");
    assert_eq!(again["id"], small["id"]);
    assert!(again.get("admission").is_none(), "a reservation in its own turn keeps no mark from an earlier one: {}", again["admission"]);
    assert_eq!(passers(&s), 0);
}

/// Three Projects, one task each, whose keys sort P < Q < R (T-1 in P, T-2
/// in Q, T-3 in R): after P is served the turns go Q, R, P; after R, P, Q, R.
fn three_projects(s: &Store) {
    for (request, title) in [("task-2", "Second research"), ("task-3", "Third research")] {
        s.collaboration_call(None, "task_create", json!({"requestId":request,"title":title,"status":"doing"})).unwrap();
    }
    let mut ids: Vec<String> = ["Project 1", "Project 2", "Project 3"].iter()
        .map(|name| s.create_project(name, Default::default()).unwrap().id).collect();
    ids.sort();
    let db = s.db.write().unwrap();
    for (task, id) in ["T-1", "T-2", "T-3"].iter().zip(&ids) {
        let (key, _) = crate::collaboration_store::task_key(&db, task).unwrap();
        crate::projects::set_task_project(&db, &key, Some(id.as_str())).unwrap();
    }
}

#[test]
fn with_three_projects_every_job_that_starts_while_the_head_waits_is_held_to_its_share() {
    // Review e06d83e8: the head is decided before the scan, so a job whose
    // project's turn comes before the head's is held to it too; and the head
    // keeps its place once it fits.
    let (_dir, s) = setup();
    s.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 10240, swap_mi_b: 0 }).unwrap();
    three_projects(&s);
    let running = job_in(&s, "T-1", "a", "running", 2000);
    assert_eq!(start(&s).unwrap()["id"], running["id"]);
    // P's head needs 8,500 of the 8,176 MiB free: 1,740 MiB may run beside it.
    let head = job_in(&s, "T-1", "a", "head", 8436);
    for round in 0..3 {
        job_in(&s, "T-2", "a", &format!("q{round}"), 1000);
        job_in(&s, "T-3", "a", &format!("r{round}"), 1000);
    }
    // The turns go Q, R, P: Q's and R's jobs come before the head.
    let mut started = vec![];
    while let Some(job) = start(&s) {
        assert_eq!(job["admission"]["passed"]["jobId"], head["id"],
            "every job that starts while the head waits is held to its share and marked: {} is not", job["name"]);
        assert!(passers(&s) <= 10240 - 8500, "running passers {} MiB stay within the 1,740 MiB beside the head", passers(&s));
        started.push(job["name"].clone());
    }
    assert_eq!(started.len(), 1, "one 1,064 MiB job fits the 1,740 MiB beside the head: {started:?}");
    let waiting = read(&s, &head);
    assert!(waiting["reason"].as_str().unwrap().ends_with("Up to 29800 mCPU / 676 MiB RAM / 0 MiB swap may start ahead of it meanwhile"),
        "{}", waiting["reason"]);
    assert!(waiting["admission"]["head"].is_object() && waiting["admission"]["passed"].is_null(), "marked as the head, not as a passer: {}", waiting["admission"]);
    assert_eq!(passers(&s), 1064, "only the job that passed it counts, never the head");
    // The job running before it ends: the head starts next, before R's turn.
    done(&s, &running);
    let head_started = start(&s).unwrap();
    assert_eq!(head_started["id"], head["id"], "the head keeps its place and starts as soon as the job running before it ends");
    assert!(head_started.get("admission").is_none(), "{}", head_started["admission"]);
    assert_eq!(passers(&s), 1064, "the head started in its place is no passer");
    assert!(!report_of(&head_started).contains("Started ahead of"), "{}", report_of(&head_started));
}

#[test]
fn with_three_projects_a_job_short_of_host_memory_is_still_no_backfill_head() {
    let (_dir, s) = setup();
    three_projects(&s);
    let start_within = |s: &Store| s.reserve_next_job(Some(2000), None, None).unwrap();
    // R is served last, so the turns go P, Q, R.
    let running = job_in(&s, "T-3", "a", "running", 500);
    assert_eq!(start_within(&s).unwrap()["id"], running["id"]);
    let before = job_in(&s, "T-1", "a", "before", 500);
    // Within the budget, short of the 2,000 MiB host memory.
    let short = job_in(&s, "T-2", "a", "short of host memory", 3000);
    let after = job_in(&s, "T-3", "a", "after", 500);
    let first = start_within(&s).unwrap();
    assert_eq!(first["id"], before["id"]);
    assert!(first.get("admission").is_none(), "a host-memory wait is not a backfill head: nothing is marked as passing it: {}", first["admission"]);
    // Q's turn: nothing passes it.
    assert!(start_within(&s).is_none());
    assert!(read(&s, &short)["reason"].as_str().unwrap().starts_with("Waiting for host memory"), "{}", read(&s, &short)["reason"]);
    assert_eq!(read(&s, &after)["reason"], "Waiting behind short of host memory, which waits for host memory first; jobs do not pass it");
}

/// Two Jobs that were each the blocked head once (review fe5c0325): two Jobs
/// of P run (2,064 + 3,064 MiB), F of Q needs 5,564 and H of P 7,064, both
/// short. Q's turn makes F the head and a 1,064 MiB job of Q passes it; P's
/// turn makes H the head. Then the first of P's running jobs ends: F fits the
/// 6,112 MiB free, H does not. `f_first` submits F before H.
fn two_former_heads(s: &Store, f_first: bool) -> (Value, Value, Value) {
    s.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 10240, swap_mi_b: 0 }).unwrap();
    three_projects(s);
    let x1 = job_in(s, "T-1", "a", "running 1", 2000);
    assert_eq!(start(s).unwrap()["id"], x1["id"]);
    let x2 = job_in(s, "T-1", "a", "running 2", 3000);
    assert_eq!(start(s).unwrap()["id"], x2["id"]);
    let (f, h) = if f_first {
        let f = job_in(s, "T-2", "a", "former head f", 5500);
        (f, job_in(s, "T-1", "a", "head h", 7000))
    } else {
        let h = job_in(s, "T-1", "a", "head h", 7000);
        (job_in(s, "T-2", "a", "former head f", 5500), h)
    };
    let small = job_in(s, "T-2", "a", "small", 1000);
    let passed = start(s).unwrap();
    assert_eq!((passed["id"].clone(), passed["admission"]["passed"]["jobId"].clone()), (small["id"].clone(), f["id"].clone()));
    assert!(start(s).is_none());
    assert!(read(s, &f)["admission"]["head"].is_object() && read(s, &h)["admission"]["head"].is_object(), "both were the head");
    done(s, &x1);
    (x2, f, h)
}

#[test]
fn a_younger_former_head_that_fits_waits_for_the_older_heads_room() {
    let (_dir, s) = setup();
    let (x2, f, h) = two_former_heads(&s, false);
    // H, submitted before F, is the head: F is held to what H's need leaves.
    assert!(start(&s).is_none(), "a younger former head waits for the current head's room");
    assert!(read(&s, &f)["reason"].as_str().unwrap().starts_with("Waiting behind head h"), "{}", read(&s, &f)["reason"]);
    assert!(read(&s, &f)["admission"]["head"].is_object(), "it keeps its mark");
    done(&s, &x2);
    assert_eq!(start(&s).unwrap()["id"], h["id"], "the older head starts first once the jobs before it end");
}

#[test]
fn an_older_former_head_that_fits_starts_before_the_current_head() {
    let (_dir, s) = setup();
    let (_x2, f, _h) = two_former_heads(&s, true);
    let started = start(&s).unwrap();
    assert_eq!(started["id"], f["id"], "an older blocked head wins");
    assert!(started.get("admission").is_none(), "{}", started["admission"]);
}
