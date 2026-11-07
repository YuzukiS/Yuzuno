//! A Job's CPU as a range (T-64): the grant at its start, the raises while
//! it runs, and the request that carries them.
use super::cpu::{grant, raises, Raise, Range, Running};
use super::*;
use crate::{model::AgentDetail, store::Store};

const ELASTIC: Range = Range { min: 2000, max: 16000, policy: CpuPolicy::Elastic };
const FIXED: Range = Range { policy: CpuPolicy::Fixed, ..ELASTIC };

fn running(id: &str, range: Range, current: u64) -> Running {
    Running { id: id.into(), range, current }
}
fn raise(id: &str, from: u64, to: u64) -> Raise {
    Raise { id: id.into(), from, to }
}

#[test]
fn an_idle_budget_grants_the_maximum() {
    assert_eq!(grant(ELASTIC, 32000, 0), 16000);
}

#[test]
fn anything_queued_grants_the_minimum() {
    assert_eq!(grant(ELASTIC, 32000, 1), 2000);
    assert_eq!(grant(ELASTIC, 32000, 7), 2000);
}

#[test]
fn a_fixed_policy_grants_the_minimum() {
    assert_eq!(grant(FIXED, 32000, 0), 2000);
}

#[test]
fn the_grant_is_clamped_at_what_the_free_budget_leaves_after_its_collector() {
    assert_eq!(grant(ELASTIC, 6100, 0), 6000);
    // Never below the minimum admission reserved, never above the maximum.
    assert_eq!(grant(ELASTIC, 2000, 0), 2000);
    assert_eq!(grant(ELASTIC, 0, 0), 2000);
    assert_eq!(grant(ELASTIC, 16100, 0), 16000);
    assert_eq!(grant(ELASTIC, 1_000_000, 0), 16000);
}

#[test]
fn an_older_caller_runs_at_its_one_value_and_its_request_reads_as_before() {
    let old = json!({"cpuMillis":3000,"memoryMiB":4096,"swapMiB":0});
    let requested: Requested = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(requested.cpu(), Range { min: 3000, max: 3000, policy: CpuPolicy::Elastic });
    assert_eq!(requested.point(), Resources { cpu_millis: 3000, memory_mi_b: 4096, swap_mi_b: 0 });
    // Its idempotency record and identity see the same request as before.
    assert_eq!(serde_json::to_value(&requested).unwrap(), old);
    for free in [0, 3100, 32000] {
        assert_eq!(grant(requested.cpu(), free, 0), 3000);
    }
}

#[test]
fn a_range_reads_with_either_name_for_its_minimum_and_keeps_its_fields() {
    let range: Requested = serde_json::from_value(json!({"cpuMillisMin":2000,"cpuMillisMax":16000,"memoryMiB":4096,"swapMiB":0})).unwrap();
    assert_eq!(range.cpu(), ELASTIC);
    assert_eq!(range.point().cpu_millis, 2000, "admission reserves the minimum");
    let kept = serde_json::to_value(&range).unwrap();
    assert_eq!(kept, json!({"cpuMillis":2000,"cpuMillisMax":16000,"memoryMiB":4096,"swapMiB":0}));
    // The record Core keeps reads back as the same request (a retry, a stage).
    assert_eq!(serde_json::from_value::<Requested>(kept).unwrap(), range);
    let fixed: Requested = serde_json::from_value(json!({"cpuMillis":2000,"cpuMillisMax":16000,"cpuPolicy":"fixed","memoryMiB":64,"swapMiB":0})).unwrap();
    assert_eq!(fixed.cpu(), FIXED);
}

#[test]
fn a_request_with_both_names_or_neither_or_an_unknown_policy_is_refused() {
    let both = serde_json::from_value::<Requested>(json!({"cpuMillis":2000,"cpuMillisMin":2000,"memoryMiB":64,"swapMiB":0})).unwrap_err();
    assert!(both.to_string().contains("give cpuMillis or cpuMillisMin, not both"), "{both}");
    let neither = serde_json::from_value::<Requested>(json!({"cpuMillisMax":2000,"memoryMiB":64,"swapMiB":0})).unwrap_err();
    assert!(neither.to_string().contains("resources needs cpuMillis, or cpuMillisMin"), "{neither}");
    assert!(serde_json::from_value::<Requested>(json!({"cpuMillis":2000,"cpuPolicy":"burst","memoryMiB":64,"swapMiB":0})).is_err());
    assert!(serde_json::from_value::<Requested>(json!({"cpuMillis":2000,"cpuMillisTop":4000,"memoryMiB":64,"swapMiB":0})).is_err());
}

fn submit(resources: Value, machine: Option<&str>) -> Submit {
    let mut value = json!({"requestId":"r","taskId":"T-1","name":"Build","cwd":"/workspace","argv":["/usr/bin/true"],"resources":resources});
    if let Some(machine) = machine {
        value["machineId"] = json!(machine);
        value["guardGit"] = json!(false);
    }
    serde_json::from_value(value).unwrap()
}

#[test]
fn a_maximum_below_the_minimum_or_past_the_bound_or_on_another_machine_is_refused() {
    let low = submit(json!({"cpuMillisMin":4000,"cpuMillisMax":2000,"memoryMiB":64,"swapMiB":0}), None).validate().unwrap_err();
    assert!(low.to_string().contains("cpuMillisMax must be at least cpuMillisMin (4000)"), "{low}");
    let high = submit(json!({"cpuMillisMin":4000,"cpuMillisMax":256001,"memoryMiB":64,"swapMiB":0}), None).validate().unwrap_err();
    assert!(high.to_string().contains("at most 256000 millicores"), "{high}");
    let remote = submit(json!({"cpuMillisMin":2000,"cpuMillisMax":4000,"memoryMiB":64,"swapMiB":0}), Some("lab-ssh")).validate().unwrap_err();
    assert!(remote.to_string().contains("A CPU range up to cpuMillisMax is for this Core's host only"), "{remote}");
    // The same value twice is no range: a remote machine takes it.
    submit(json!({"cpuMillisMin":2000,"cpuMillisMax":2000,"memoryMiB":64,"swapMiB":0}), Some("lab-ssh")).validate().unwrap();
    submit(json!({"cpuMillisMin":2000,"cpuMillisMax":16000,"cpuPolicy":"fixed","memoryMiB":64,"swapMiB":0}), None).validate().unwrap();
}

#[test]
fn a_raise_goes_only_up_to_the_maximum() {
    assert_eq!(raises(32000, 0, &[running("a", ELASTIC, 2000)]), vec![raise("a", 2000, 16000)]);
    assert_eq!(raises(3000, 0, &[running("a", ELASTIC, 2000)]), vec![raise("a", 2000, 5000)]);
    assert!(raises(32000, 0, &[running("a", ELASTIC, 16000)]).is_empty(), "at its maximum");
    assert!(raises(0, 0, &[running("a", ELASTIC, 2000)]).is_empty(), "nothing free");
    // However the budget and the Jobs stand, a raise never lowers a grant
    // nor passes a maximum, and never hands out more than is free.
    for free in [0, 50, 100, 3000, 14000, 40000] {
        for current in [2000, 2100, 9000, 15999, 16000] {
            let jobs = [running("a", ELASTIC, current), running("b", Range { min: 100, max: 8000, policy: CpuPolicy::Elastic }, 100)];
            let planned = raises(free, 0, &jobs);
            for r in &planned {
                let job = jobs.iter().find(|j| j.id == r.id).unwrap();
                assert!(r.to > r.from && r.from == job.current && r.to <= job.range.max, "{r:?}");
            }
            assert!(planned.iter().map(|r| r.to - r.from).sum::<u64>() <= free);
        }
    }
}

#[test]
fn nothing_is_raised_while_anything_is_queued() {
    assert!(raises(32000, 1, &[running("a", ELASTIC, 2000)]).is_empty());
}

#[test]
fn the_oldest_takes_what_is_free_first_and_fixed_jobs_stay_as_they_are() {
    let jobs = [running("fixed", FIXED, 2000), running("older", ELASTIC, 2000), running("younger", ELASTIC, 2000)];
    assert_eq!(raises(5000, 0, &jobs), vec![raise("older", 2000, 7000)]);
    assert_eq!(raises(20000, 0, &jobs), vec![raise("older", 2000, 16000), raise("younger", 2000, 8000)]);
}

// ---- through admission, the Store and job_budget -------------------------

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
    store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"CPU checks","status":"doing"})).unwrap();
    store.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 32768, swap_mi_b: 0 }).unwrap();
    (dir, store)
}
fn queue(s: &Store, id: &str, resources: Value) -> Value {
    let mut request = submit(resources, None);
    request.request_id = id.into();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":32000,"memoryMiB":32768,"swapMiB":0}});
    s.create_job(Some("a"), request, json!({"cwd":"/workspace"}), machine, json!({"bootId":"boot"})).unwrap()
}
fn start(s: &Store) -> Value {
    let job = s.reserve_next_job(Some(30000), None, None).unwrap().unwrap();
    let id = job["id"].as_str().unwrap();
    let running = json!({"jobId":job["id"],"attempt":job["attempt"],"status":"running","reason":"test","evidence":{"InvocationID":"one"}});
    assert!(s.update_job_evidence(id, running).unwrap());
    s.job(id).unwrap()
}
fn range() -> Value {
    json!({"cpuMillisMin":2000,"cpuMillisMax":16000,"memoryMiB":1024,"swapMiB":0})
}

#[test]
fn admission_reserves_the_minimum_and_records_the_grant_with_its_inputs() {
    let (_dir, s) = setup();
    let queued = queue(&s, "build", range());
    assert_eq!(queued["reservation"]["cpuMillis"], 2100, "the minimum and its collector");
    let job = start(&s);
    assert_eq!(job["reservation"]["cpuMillis"], 2100, "the grant reserves nothing more");
    assert_eq!(job["cpuRequested"], json!({"min":2000,"max":16000,"policy":"elastic"}));
    assert_eq!((&job["cpuGrantedAtStart"], &job["cpuCurrent"]), (&json!(16000), &json!(16000)));
    let inputs = &job["cpuGrant"];
    assert_eq!((&inputs["budgetCpuMillis"], &inputs["heldCpuMillis"], &inputs["freeCpuMillis"]), (&json!(32000), &json!(0), &json!(32000)));
    assert_eq!((&inputs["headroomCpuMillis"], &inputs["queueLength"], &inputs["maxActive"]), (&json!(100), &json!(0), &json!(4)));
    assert!(inputs["at"].is_string());
    // What it holds now leaves the next Job less: 32000 − 16100.
    queue(&s, "second", range());
    let second = start(&s);
    assert_eq!(second["cpuGrant"]["heldCpuMillis"], 16100);
    assert_eq!(second["cpuGrantedAtStart"], 15800);
}

#[test]
fn a_job_reserved_while_another_waits_starts_at_its_minimum_and_an_older_caller_at_its_value() {
    let (_dir, s) = setup();
    queue(&s, "first", range());
    queue(&s, "second", json!({"cpuMillis":3000,"memoryMiB":1024,"swapMiB":0}));
    let first = start(&s);
    assert_eq!((&first["cpuGrantedAtStart"], &first["cpuGrant"]["queueLength"]), (&json!(2000), &json!(1)));
    let second = start(&s);
    assert_eq!(second["cpuRequested"], json!({"min":3000,"max":3000,"policy":"elastic"}));
    assert_eq!(second["cpuGrantedAtStart"], 3000);
    assert!(second["resources"].get("cpuMillisMax").is_none(), "{}", second["resources"]);
}

#[test]
fn a_running_elastic_job_is_raised_once_nothing_waits_and_the_raise_is_recorded() {
    let (_dir, s) = setup();
    queue(&s, "first", range());
    queue(&s, "waiting", range());
    let first = start(&s);
    assert_eq!(first["cpuCurrent"], 2000);
    assert!(s.cpu_raises().unwrap().is_empty(), "a Job still queued: nothing is raised");
    let second = start(&s);
    // Nothing queued now: the first takes what the second left free.
    let planned = s.cpu_raises().unwrap();
    let free = 32000 - (2000 + 100) - (second["cpuCurrent"].as_u64().unwrap() + 100);
    assert_eq!(planned.len(), 1);
    let (job, raise, seen) = &planned[0];
    assert_eq!((job["id"].clone(), raise.from, raise.to, *seen), (first["id"].clone(), 2000, (2000 + free).min(16000), free));
    let answer = json!({"state":"raised","reason":"read back","evidence":{"cpuMillisBefore":2000,"cpuMillisAfter":raise.to}});
    s.record_cpu_raise(raise, &first["attempt"], *seen, &answer, None).unwrap();
    let raised = s.job(first["id"].as_str().unwrap()).unwrap();
    assert_eq!(raised["cpuCurrent"], raise.to);
    assert_eq!(raised["cpuGrantedAtStart"], 2000, "the start grant stays as it was");
    let change = &raised["cpuChanges"][0];
    assert_eq!((&change["fromCpuMillis"], &change["toCpuMillis"], &change["queueLength"]), (&json!(2000), &json!(raise.to), &json!(0)));
    assert_eq!(change["evidence"]["cpuMillisAfter"], raise.to);
}

#[test]
fn a_refused_raise_is_kept_and_not_asked_again_for_the_same_value() {
    let (_dir, s) = setup();
    queue(&s, "first", range());
    queue(&s, "waiting", json!({"cpuMillis":28000,"memoryMiB":1024,"swapMiB":0}));
    let first = start(&s);
    let big = start(&s);
    // The big one ends: its 28100 free again.
    let ended = json!({"jobId":big["id"],"attempt":big["attempt"],"status":"succeeded","reason":"test","evidence":{"InvocationID":"one"}});
    s.update_job_evidence(big["id"].as_str().unwrap(), ended).unwrap();
    let planned = s.cpu_raises().unwrap();
    let (_, raise, seen) = &planned[0];
    assert_eq!((raise.from, raise.to), (2000, 16000));
    let refused = json!({"state":"notRaised","reason":"systemd did not raise the CPU quota: test"});
    s.record_cpu_raise(raise, &first["attempt"], *seen, &refused, None).unwrap();
    let job = s.job(first["id"].as_str().unwrap()).unwrap();
    assert_eq!((&job["cpuCurrent"], &job["cpuRaiseRefusal"]["to"], &job["cpuRaiseRefusal"]["state"]), (&json!(2000), &json!(16000), &json!("notRaised")));
    assert!(job["cpuChanges"].is_null());
    assert!(s.cpu_raises().unwrap().is_empty(), "not asked again for the same value");
}

#[test]
fn job_budget_names_what_is_free_of_the_cpu_what_waits_and_what_runs_as_hints() {
    let (_dir, s) = setup();
    queue(&s, "first", range());
    start(&s);
    queue(&s, "waiting", range());
    let view = s.job_budget_view(json!({"suggestedBudget":{"cpuMillis":32000,"memoryMiB":32768,"swapMiB":0}})).unwrap();
    assert_eq!((&view["cpuMillisFree"], &view["queueLength"], &view["running"]), (&json!(32000 - 16100), &json!(1), &json!(1)));
    assert!(view["cpuHint"].as_str().unwrap().contains("not an entitlement"));
}
