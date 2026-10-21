use super::*;
use crate::{model::AgentDetail, store::Store};
use std::sync::Barrier;

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
            json!({"requestId":"task","title":"Existing training outcome","status":"doing"}),
        )
        .unwrap();
    (dir, store)
}
fn input(id: &str) -> Submit {
    serde_json::from_value(json!({"requestId":id,"taskId":"T-1","name":"Small job","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0}})).unwrap()
}
fn machine() -> Value {
    json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}})
}
fn submit(s: &Store, id: &str) -> Value {
    s.create_job(
        Some("a"),
        input(id),
        json!({"cwd":"/workspace"}),
        machine(),
        json!({"bootId":"boot"}),
    )
    .unwrap()
}
fn evidence(job: &Value, status: &str) -> Value {
    json!({"jobId":job["id"],"attempt":job["attempt"],"status":status,"reason":"test OS evidence","evidence":{"InvocationID":"one"}})
}

#[test]
fn a_budget_may_hold_the_whole_host_and_the_default_stays_conservative() {
    // T-160: the budget is the user's, not a share of the host. This host
    // (32 CPU, 40107 MiB RAM, 16384 MiB swap) may be budgeted whole, or more.
    let (default, headroom) = host::budget_defaults(32, 40107);
    assert_eq!(
        default,
        Resources {
            cpu_millis: 4000,
            memory_mi_b: 8192,
            swap_mi_b: 0
        }
    );
    assert_eq!(headroom, 2048);
    for budget in [
        Resources { cpu_millis: 32000, memory_mi_b: 40107, swap_mi_b: 16384 },
        Resources { cpu_millis: 64000, memory_mi_b: 80214, swap_mi_b: 0 },
        BUDGET_MIN,
        BUDGET_MAX,
    ] {
        assert!(validate_budget(&budget).is_ok(), "{budget:?}");
    }
    for budget in [
        Resources { cpu_millis: 199, ..BUDGET_MIN },
        Resources { memory_mi_b: 127, ..BUDGET_MIN },
        Resources { cpu_millis: BUDGET_MAX.cpu_millis + 1, ..BUDGET_MIN },
        Resources { memory_mi_b: BUDGET_MAX.memory_mi_b + 1, ..BUDGET_MIN },
        Resources { swap_mi_b: BUDGET_MAX.swap_mi_b + 1, ..BUDGET_MIN },
    ] {
        let error = validate_budget(&budget).unwrap_err().to_string();
        assert!(error.contains("Budget must be 200–4096000 mCPU, 128–67108864 MiB RAM"), "{error}");
    }
    // The default leaves the headroom on any host.
    for cpus in [1, 2, 4] {
        for total in [256, 512, 2048, 8192] {
            let (default, headroom) = host::budget_defaults(cpus, total);
            assert!((200..=4000).contains(&default.cpu_millis));
            assert!(default.memory_mi_b + headroom <= total);
            assert_eq!(default.swap_mi_b, 0);
        }
    }
}

#[test]
fn a_whole_host_budget_admits_more_than_the_old_shares_and_waits_only_for_free_memory() {
    let (_dir, s) = setup();
    let (default, headroom) = host::budget_defaults(32, 40107);
    let machine = json!({"id":"local-test","suggestedBudget":default,"hostHeadroomMiB":headroom});
    // Above the 24000 mCPU / 20053 MiB an older Core allowed on this host.
    s.set_job_budget(Resources { cpu_millis: 32000, memory_mi_b: 40107, swap_mi_b: 0 }).unwrap();
    let mut request = input("whole-host");
    request.resources = Resources { cpu_millis: 30000, memory_mi_b: 30000, swap_mi_b: 0 };
    let job = s
        .create_job(Some("a"), request, json!({"cwd":"/workspace"}), machine.clone(), json!({}))
        .unwrap();
    assert_eq!(job["reservation"], json!({"cpuMillis":30100,"memoryMiB":30064,"swapMiB":0}));
    let view = s.job_budget_view(machine).unwrap();
    assert_eq!(view["budget"], json!({"cpuMillis":32000,"memoryMiB":40107,"swapMiB":0}));
    assert_eq!(
        view["requestCapacity"]["submission"]["maxRequest"],
        json!({"cpuMillis":31900,"memoryMiB":40043,"swapMiB":0})
    );
    assert_eq!(view["budgetBounds"], json!({"minimum":BUDGET_MIN,"maximum":BUDGET_MAX}));
    // Too little RAM free on the host now: it stays queued and says why.
    assert!(s.reserve_next_job(Some(20000), None, None).unwrap().is_none());
    let reason = s.job(job["id"].as_str().unwrap()).unwrap()["reason"].clone();
    assert!(reason.as_str().unwrap().starts_with("Waiting for host memory"), "{reason}");
    assert!(reason.as_str().unwrap().contains("short 10064 MiB"), "{reason}");
    // Once it is free, the same job starts without being submitted again.
    assert_eq!(
        s.reserve_next_job(Some(31000), None, None).unwrap().unwrap()["id"],
        job["id"]
    );
}

#[test]
fn two_development_jobs_need_collector_capacity_and_budget_edits_resume_same_queue() {
    let (dir, s) = setup();
    let (default, _) = host::budget_defaults(32, 40107);
    let machine = json!({"id":"local-test","suggestedBudget":default});
    let jobs: Vec<_> = (0..3)
        .map(|i| {
            let mut request = input(&format!("development-{i}"));
            request.resources = Resources {
                cpu_millis: 2000,
                memory_mi_b: 4096,
                swap_mi_b: 0,
            };
            s.create_job(
                Some("a"),
                request,
                json!({"cwd":"/workspace"}),
                machine.clone(),
                json!({}),
            )
            .unwrap()
        })
        .collect();
    assert_eq!(
        jobs[0]["reservation"],
        json!({"cpuMillis":2100,"memoryMiB":4160,"swapMiB":0})
    );
    let first = s.reserve_next_job(Some(30000), None, None).unwrap().unwrap();
    assert!(s.reserve_next_job(Some(30000), None, None).unwrap().is_none());
    let second_id = jobs[1]["id"].as_str().unwrap();
    assert!(s.job(second_id).unwrap()["reason"]
        .as_str()
        .unwrap()
        .contains("short 200 mCPU"));
    s.set_job_budget(Resources {
        cpu_millis: 4200,
        memory_mi_b: 8192,
        swap_mi_b: 0,
    })
    .unwrap();
    assert!(s.reserve_next_job(Some(30000), None, None).unwrap().is_none());
    assert!(s.job(second_id).unwrap()["reason"]
        .as_str()
        .unwrap()
        .contains("short 128 MiB"));
    s.set_job_budget(Resources {
        cpu_millis: 6000,
        memory_mi_b: 10240,
        swap_mi_b: 0,
    })
    .unwrap();
    assert!(s.reserve_next_job(Some(4000), None, None).unwrap().is_none());
    assert!(s.job(second_id).unwrap()["reason"]
        .as_str()
        .unwrap()
        .contains("short 160 MiB"));
    assert_eq!(
        s.reserve_next_job(Some(30000), None, None).unwrap().unwrap()["id"],
        jobs[1]["id"]
    );
    assert!(s.reserve_next_job(Some(30000), None, None).unwrap().is_none());
    assert_eq!(
        s.job_budget_view(machine.clone()).unwrap()["activeCount"],
        2
    );
    let unchanged = s.job(first["id"].as_str().unwrap()).unwrap();
    for field in ["resources", "reservation", "snapshot", "attempt"] {
        assert_eq!(unchanged[field], first[field]);
    }
    // Upgrading machine policy or reopening storage must not raise a saved budget.
    s.set_job_budget(default.clone()).unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let mut new_machine = machine.clone();
    new_machine["suggestedBudget"] = json!({"cpuMillis":6000,"memoryMiB":10240,"swapMiB":0});
    assert_eq!(
        s.job_budget_view(new_machine).unwrap()["budget"],
        json!(default)
    );
    assert!(s.reserve_next_job(Some(30000), None, None).unwrap().is_none());
    assert_eq!(s.job_budget_view(machine).unwrap()["activeCount"], 2);
}

#[test]
fn lowering_swap_below_running_reservations_blocks_even_zero_swap_jobs_until_release() {
    let (_dir, s) = setup();
    s.set_job_budget(Resources {
        cpu_millis: 1800,
        memory_mi_b: 576,
        swap_mi_b: 128,
    })
    .unwrap();
    let mut request = input("swapping");
    request.resources.swap_mi_b = 64;
    let first = s
        .create_job(Some("a"), request, json!({}), machine(), json!({}))
        .unwrap();
    let second = submit(&s, "zero-swap");
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    s.set_job_budget(Resources {
        cpu_millis: 1800,
        memory_mi_b: 576,
        swap_mi_b: 0,
    })
    .unwrap();
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    assert_eq!(
        s.job(first["id"].as_str().unwrap()).unwrap()["resources"]["swapMiB"],
        64
    );
    assert!(s.job(second["id"].as_str().unwrap()).unwrap()["reason"]
        .as_str()
        .unwrap()
        .contains("lowered budget"));
    s.update_job_evidence(first["id"].as_str().unwrap(), evidence(&first, "succeeded"))
        .unwrap();
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        second["id"]
    );
}

fn parallel_budget(s: &Store) {
    s.set_job_budget(Resources {
        cpu_millis: 2400,
        memory_mi_b: 768,
        swap_mi_b: 0,
    })
    .unwrap();
}
fn submit_exclusive(s: &Store, id: &str) -> Value {
    let mut request = input(id);
    request.exclusive = true;
    s.create_job(
        Some("a"),
        request,
        json!({"cwd":"/workspace"}),
        machine(),
        json!({"bootId":"boot"}),
    )
    .unwrap()
}

#[test]
fn ordinary_jobs_overlap_but_fifo_exclusive_waits_for_drain_and_blocks_later_work() {
    let (_dir, s) = setup();
    parallel_budget(&s);
    let a = submit(&s, "a");
    let b = submit(&s, "b");
    let exclusive = submit_exclusive(&s, "exclusive");
    let later = submit(&s, "later");
    assert_eq!(a["exclusive"], false);
    assert_eq!(exclusive["reservation"], a["reservation"]);
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        a["id"]
    );
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        b["id"]
    );
    s.update_job_evidence(b["id"].as_str().unwrap(), evidence(&b, "unknown"))
        .unwrap();
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    assert!(s.job(exclusive["id"].as_str().unwrap()).unwrap()["reason"]
        .as_str()
        .unwrap()
        .contains("running jobs"));
    assert!(s.job(later["id"].as_str().unwrap()).unwrap()["reason"]
        .as_str()
        .unwrap()
        .contains("earlier exclusive job"));
    s.update_job_evidence(a["id"].as_str().unwrap(), evidence(&a, "succeeded"))
        .unwrap();
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    s.update_job_evidence(b["id"].as_str().unwrap(), evidence(&b, "succeeded"))
        .unwrap();
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        exclusive["id"]
    );
    let during = submit(&s, "during-exclusive");
    assert_eq!(during["status"], "queued");
    assert!(during["reason"]
        .as_str()
        .unwrap()
        .contains("exclusive job to finish"));
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let live = s.list_jobs(None, None, None).unwrap()["liveJobs"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(
        live.iter().find(|j| j["id"] == exclusive["id"]).unwrap()["exclusive"],
        true
    );
    assert!(live.iter().filter(|j| j["status"] == "queued").all(|j| {
        j["reason"]
            .as_str()
            .unwrap()
            .contains("exclusive job to finish")
    }));
    s.update_job_evidence(
        exclusive["id"].as_str().unwrap(),
        evidence(&exclusive, "failed"),
    )
    .unwrap();
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        later["id"]
    );
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        during["id"]
    );
}

#[test]
fn competing_admission_transactions_cannot_overlap_an_exclusive_reservation() {
    let (_dir, s) = setup();
    parallel_budget(&s);
    let exclusive = submit_exclusive(&s, "exclusive");
    for n in 0..3 {
        submit(&s, &format!("ordinary-{n}"));
    }
    let barrier = Arc::new(Barrier::new(4));
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let s = s.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                s.reserve_next_job(None, None, None).unwrap()
            })
        })
        .collect();
    let admitted: Vec<_> = threads
        .into_iter()
        .filter_map(|t| t.join().unwrap())
        .collect();
    assert_eq!(admitted.len(), 1);
    assert_eq!(admitted[0]["id"], exclusive["id"]);
    assert_eq!(s.job_budget_view(machine()).unwrap()["activeCount"], 1);
}

#[test]
fn cancelling_a_queued_exclusive_removes_its_fifo_barrier_without_stopping_running_jobs() {
    let (_dir, s) = setup();
    parallel_budget(&s);
    let running = submit(&s, "running");
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    let exclusive = submit_exclusive(&s, "queued-exclusive");
    let later = submit(&s, "later");
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let cancelled = s
        .request_job_cancel(Some("a"), exclusive["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["reserved"], false);
    assert_eq!(
        s.job(running["id"].as_str().unwrap()).unwrap()["reserved"],
        true
    );
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        later["id"]
    );
}

#[test]
fn exclusive_cancellation_and_unknown_survive_restart_until_confirmed_terminal_evidence() {
    let (dir, s) = setup();
    parallel_budget(&s);
    let exclusive = submit_exclusive(&s, "exclusive");
    let later = submit(&s, "later");
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    let id = exclusive["id"].as_str().unwrap();
    s.request_job_cancel(Some("a"), id).unwrap();
    assert!(s
        .update_job_evidence(id, evidence(&exclusive, "settling"))
        .is_err());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    s.update_job_evidence(id, evidence(&exclusive, "unknown"))
        .unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let restored = s.job(id).unwrap();
    assert_eq!(restored["exclusive"], true);
    assert_eq!(restored["reserved"], true);
    assert!(restored["cancelRequestedAt"].is_string());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let mut stale = evidence(&exclusive, "cancelled");
    stale["attempt"] = json!("wrong-attempt");
    assert!(s.update_job_evidence(id, stale).is_err());
    let terminal = evidence(&exclusive, "cancelled");
    assert!(s.update_job_evidence(id, terminal.clone()).unwrap());
    assert!(!s.update_job_evidence(id, terminal).unwrap());
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        later["id"]
    );
    let mail = s
        .collaboration_call(Some("a"), "peer_read", json!({}))
        .unwrap();
    let terminal_mail: Vec<_> = mail["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["jobId"] == exclusive["id"] && m["metadata"]["status"] == "cancelled")
        .collect();
    assert_eq!(terminal_mail.len(), 1);
}

#[test]
fn legacy_jobs_and_lost_reply_retries_default_to_ordinary_without_idempotency_conflicts() {
    let (dir, s) = setup();
    let old = submit(&s, "legacy");
    {
        let db = s.db.write().unwrap();
        db.execute(
            "UPDATE local_jobs SET data=json_remove(data,'$.exclusive')",
            [],
        )
        .unwrap();
        db.execute("UPDATE collaboration_requests SET input_json=json_remove(input_json,'$.exclusive') WHERE operation='job_submit'", []).unwrap();
    }
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(
        s.job(old["id"].as_str().unwrap()).unwrap()["exclusive"],
        false
    );
    let retry = submit(&s, "legacy");
    assert_eq!(retry["id"], old["id"]);
    let mut changed = input("legacy");
    changed.exclusive = true;
    assert!(s
        .create_job(Some("a"), changed, json!({}), machine(), json!({}))
        .unwrap_err()
        .to_string()
        .contains("idempotency_conflict"));
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        old["id"]
    );
}

#[test]
fn concurrent_submissions_reserve_only_one_machine_budget() {
    let (_dir, s) = setup();
    let barrier = Arc::new(Barrier::new(5));
    let threads: Vec<_> = (0..4)
        .map(|n| {
            let s = s.clone();
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                submit(&s, &format!("r{n}"));
                s.reserve_next_job(None, None, None).unwrap()
            })
        })
        .collect();
    barrier.wait();
    let jobs: Vec<_> = threads
        .into_iter()
        .filter_map(|t| t.join().unwrap())
        .collect();
    assert_eq!(jobs.len(), 1);
    let budget = s.job_budget_view(machine()).unwrap();
    assert_eq!(budget["activeCount"], 1);
    assert_eq!(budget["queuedCount"], 3);
    assert_eq!(
        budget["reserved"],
        json!({"cpuMillis":600,"memoryMiB":192,"swapMiB":0})
    );
}
#[test]
fn duplicate_submit_returns_one_job_and_different_payload_conflicts() {
    let (_dir, s) = setup();
    let first = submit(&s, "same");
    let again = submit(&s, "same");
    assert_eq!(first["id"], again["id"]);
    let mut different = input("same");
    different.argv = vec!["/usr/bin/false".into()];
    assert!(s
        .create_job(Some("a"), different, json!({}), machine(), json!({}))
        .unwrap_err()
        .to_string()
        .contains("idempotency_conflict"));
    assert_eq!(
        s.list_jobs(None, None, None).unwrap()["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn unknown_keeps_reservation_and_duplicate_observations_do_not_duplicate_mail() {
    let (_dir, s) = setup();
    let job = submit(&s, "first");
    submit(&s, "second");
    s.reserve_next_job(None, None, None).unwrap();
    let id = job["id"].as_str().unwrap();
    assert!(s
        .update_job_evidence(id, evidence(&job, "unknown"))
        .unwrap());
    assert!(!s
        .update_job_evidence(id, evidence(&job, "unknown"))
        .unwrap());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    assert_eq!(
        s.collaboration_call(Some("a"), "peer_read", json!({}))
            .unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut failure = evidence(&job, "failed");
    failure["evidence"]["systemd"] = json!({"Result":"oom-kill"});
    s.update_job_evidence(id, failure.clone()).unwrap();
    assert!(!s.update_job_evidence(id, failure).unwrap());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_some());
    let mail = s
        .collaboration_call(Some("a"), "peer_read", json!({}))
        .unwrap();
    assert_eq!(mail["messages"].as_array().unwrap().len(), 2);
    assert_eq!(mail["messages"][0]["metadata"]["status"], "unknown");
    assert_eq!(
        mail["messages"][1]["metadata"],
        json!({"kind":"job","status":"failed","jobId":job["id"],"attempt":job["attempt"],"name":job["name"],"systemdResult":"oom-kill"})
    );
    assert!(mail["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["sender"]["kind"] == "system" && m["priority"] == "normal"));
    assert_eq!(
        s.collaboration_call(None, "task_get", json!({"taskId":"T-1"}))
            .unwrap()["task"]["status"],
        "doing"
    );
}
#[test]
fn cancellation_is_intent_until_evidence_releases_capacity() {
    let (_dir, s) = setup();
    let a = submit(&s, "active");
    let b = submit(&s, "waiting");
    s.reserve_next_job(None, None, None).unwrap();
    let queued = s
        .request_job_cancel(None, b["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(queued["status"], "cancelled");
    assert_eq!(queued["reserved"], false);
    assert!(s
        .request_job_cancel(Some("b"), a["id"].as_str().unwrap())
        .is_err());
    let cancelling = s
        .request_job_cancel(Some("a"), a["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(cancelling["status"], "cancelling");
    assert_eq!(cancelling["reserved"], true);
    let again = s
        .request_job_cancel(Some("a"), a["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(cancelling["cancelRequestedAt"], again["cancelRequestedAt"]);
    s.update_job_evidence(a["id"].as_str().unwrap(), evidence(&a, "cancelled"))
        .unwrap();
    assert_eq!(s.job_budget_view(machine()).unwrap()["activeCount"], 0);
}

#[test]
fn process_limit_evidence_and_reason_survive_restart_with_one_notification() {
    let (dir, s) = setup();
    let job = submit(&s, "process-limit");
    s.reserve_next_job(None, None, None).unwrap();
    let id = job["id"].as_str().unwrap();
    let mut failure = evidence(&job, "failed");
    failure["reason"] = json!("Process/thread limit reached (512 tasks); pids.events max increased by 1 while the command failed");
    failure["evidence"] = json!({"systemd":{"Result":"exit-code","TasksMax":"512"},
        "pids":{"before":{"max":512,"events":{"max":0}},"after":{"max":512,"peak":512,"events":{"max":1}},"source":"worker-exit"}});
    assert!(s.update_job_evidence(id, failure.clone()).unwrap());
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(s.job(id).unwrap()["result"], failure);
    assert!(!s.update_job_evidence(id, failure.clone()).unwrap());
    let mail = s
        .collaboration_call(Some("a"), "peer_read", json!({}))
        .unwrap();
    let messages = mail["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert!(messages[0]["body"]
        .as_str()
        .unwrap()
        .contains(failure["reason"].as_str().unwrap()));
    assert_eq!(messages[0]["metadata"]["systemdResult"], "exit-code");
    assert_eq!(s.job(id).unwrap()["reserved"], false);
}
#[test]
fn impossible_new_requests_rejected_but_lowered_budget_preserves_queued_jobs() {
    let (_dir, s) = setup();
    let mut too_big = input("big");
    too_big.resources.memory_mi_b = 192;
    assert!(s
        .create_job(Some("a"), too_big, json!({}), machine(), json!({}))
        .unwrap_err()
        .to_string()
        .contains("never fit"));
    let queued = submit(&s, "normal");
    s.set_job_budget(Resources {
        cpu_millis: 500,
        memory_mi_b: 128,
        swap_mi_b: 0,
    })
    .unwrap();
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    s.set_job_budget(Resources {
        cpu_millis: 600,
        memory_mi_b: 192,
        swap_mi_b: 0,
    })
    .unwrap();
    assert_eq!(
        s.reserve_next_job(None, None, None).unwrap().unwrap()["id"],
        queued["id"]
    );
    assert_eq!(
        s.list_jobs(None, None, None).unwrap()["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn durable_queue_and_reservation_survive_store_reopen_without_task_mutation() {
    let (dir, s) = setup();
    let a = submit(&s, "active");
    submit(&s, "waiting");
    s.reserve_next_job(None, None, None).unwrap();
    drop(s);
    let reopened = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(
        reopened.job(a["id"].as_str().unwrap()).unwrap()["status"],
        "starting"
    );
    assert!(reopened.reserve_next_job(None, None, None).unwrap().is_none());
    let mut wrong = evidence(&a, "succeeded");
    wrong["attempt"] = json!("other");
    assert!(reopened
        .update_job_evidence(a["id"].as_str().unwrap(), wrong)
        .is_err());
    reopened
        .update_job_evidence(a["id"].as_str().unwrap(), evidence(&a, "succeeded"))
        .unwrap();
    assert!(reopened.reserve_next_job(None, None, None).unwrap().is_some());
}
#[test]
fn command_contract_bounds_and_tool_schemas_are_explicit() {
    let value = input("one");
    value.validate().unwrap();
    assert_eq!(
        serde_json::to_value(&value.resources).unwrap(),
        json!({"cpuMillis":500,"memoryMiB":128,"swapMiB":0})
    );
    let mut bad = value.clone();
    bad.argv = vec![];
    assert!(bad.validate().is_err());
    let mut bad = value;
    bad.env.insert("BAD=NAME".into(), "value".into());
    assert!(bad.validate().is_err());
    assert_eq!(tool_definitions().len(), 13);
    assert!(tool_definitions()
        .iter()
        .all(|d| d["inputSchema"]["additionalProperties"] == false));
    let definitions = tool_definitions();
    let submit = definitions
        .iter()
        .find(|d| d["name"] == "job_submit")
        .unwrap();
    assert_eq!(
        submit["inputSchema"]["properties"]["exclusive"]["default"],
        false
    );
    let mut request = serde_json::to_value(input("mode")).unwrap();
    request["exclusive"] = json!("yes");
    assert!(serde_json::from_value::<Submit>(request).is_err());
}

#[test]
fn queued_attempt_binds_boot_at_launch_and_does_not_move_to_a_different_machine() {
    let (_dir, s) = setup();
    let a = submit(&s, "queued-before-reboot");
    let mut host = machine();
    host["bootId"] = json!("new-boot");
    assert!(s
        .reserve_next_job(Some(32), Some(host.clone()), None)
        .unwrap()
        .is_none());
    assert!(s.job(a["id"].as_str().unwrap()).unwrap()["reason"]
        .as_str()
        .unwrap()
        .contains("host memory"));
    let active = s.reserve_next_job(Some(1024), Some(host), None).unwrap().unwrap();
    assert_eq!(active["bootId"], "new-boot");
    s.update_job_evidence(a["id"].as_str().unwrap(), evidence(&a, "succeeded"))
        .unwrap();
    let b = submit(&s, "different-host");
    let mut other = machine();
    other["id"] = json!("local-other");
    other["bootId"] = json!("third");
    assert!(s
        .reserve_next_job(Some(1024), Some(other), None)
        .unwrap()
        .is_none());
    assert_eq!(
        s.job(b["id"].as_str().unwrap()).unwrap()["status"],
        "rejected"
    );
    assert_eq!(s.job_budget_view(machine()).unwrap()["activeCount"], 0);
}

#[test]
fn host_evidence_and_git_input_guard_regressions() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../acceptance/local-jobs/host_test.py");
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
fn live_jobs_remain_visible_beyond_history_pages_and_task_filter_is_canonical() {
    let (_dir, s) = setup();
    let running = submit(&s, "old-active");
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    for n in 0..55 {
        submit(&s, &format!("queued-{n}"));
    }
    let list = s.list_jobs(Some("a"), Some("T-1"), None).unwrap();
    assert_eq!(list["jobs"].as_array().unwrap().len(), 50);
    assert_eq!(list["hasMore"], true);
    assert_eq!(list["liveJobs"].as_array().unwrap().len(), 56);
    assert_eq!(list["liveJobs"][0]["id"], running["id"]);
    assert_eq!(
        s.list_jobs(Some("b"), None, None).unwrap()["liveJobs"],
        json!([])
    );
}

#[test]
fn offline_completion_uses_machine_timestamps_instead_of_recovery_time() {
    let (_dir, s) = setup();
    let job = submit(&s, "offline-clock");
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    let mut saved = evidence(&job, "succeeded");
    saved["started"] = json!({"at":1700000000.0});
    saved["finishedAtUnix"] = json!(1700000010.0);
    s.update_job_evidence(job["id"].as_str().unwrap(), saved)
        .unwrap();
    let job = s.job(job["id"].as_str().unwrap()).unwrap();
    let start = chrono::DateTime::parse_from_rfc3339(job["startedAt"].as_str().unwrap()).unwrap();
    let end = chrono::DateTime::parse_from_rfc3339(job["finishedAt"].as_str().unwrap()).unwrap();
    assert_eq!((end - start).num_seconds(), 10);
}

#[tokio::test]
async fn concurrent_helper_preparation_never_exposes_partial_script() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b, c) = tokio::join!(
        host::helper(dir.path()),
        host::helper(dir.path()),
        host::helper(dir.path())
    );
    let a = a.unwrap();
    assert_eq!(a, b.unwrap());
    assert_eq!(a, c.unwrap());
    assert_eq!(std::fs::read(a).unwrap(), include_bytes!("host.py"));
}

#[test]
fn live_counts_follow_each_agents_unfinished_jobs_only() {
    let (_dir, s) = setup();
    let counts = |s: &Store| s.live_job_counts().unwrap()["agents"].clone();
    assert_eq!(counts(&s), json!({}));
    let first = submit(&s, "first");
    let second = submit(&s, "second");
    let other = s
        .create_job(
            Some("b"),
            input("other"),
            json!({"cwd":"/workspace"}),
            machine(),
            json!({"bootId":"boot"}),
        )
        .unwrap();
    assert_eq!(
        counts(&s),
        json!({"a":{"active":2,"unknown":0},"b":{"active":1,"unknown":0}})
    );
    // Starting, running and finishing: only the finished one drops out.
    let started = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(started["id"], first["id"]);
    assert_eq!(counts(&s)["a"]["active"], 2);
    s.update_job_evidence(first["id"].as_str().unwrap(), evidence(&started, "running"))
        .unwrap();
    s.update_job_evidence(first["id"].as_str().unwrap(), evidence(&started, "succeeded"))
        .unwrap();
    assert_eq!(counts(&s)["a"], json!({"active":1,"unknown":0}));
    // Cancelling a queued job ends it at once; Agent b has nothing left.
    s.request_job_cancel(Some("b"), other["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(counts(&s), json!({"a":{"active":1,"unknown":0}}));
    // An unknown outcome still holds its reservation: unfinished, counted apart.
    let started = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(started["id"], second["id"]);
    s.job_unknown(second["id"].as_str().unwrap(), "process state could not be confirmed")
        .unwrap();
    assert_eq!(counts(&s), json!({"a":{"active":1,"unknown":1}}));
}

// T-95: free space where jobs write, and launches that never started.

fn sample(path: &str, role: &'static str, device: u64, total_gib: u64, free_gib: u64) -> disk::Sample {
    disk::Sample {
        path: path.into(),
        role,
        device: Some(device),
        total: Some(total_gib * disk::GIB),
        available: Some(free_gib * disk::GIB),
        error: None,
        permanent: false,
    }
}

#[test]
fn the_disk_reserve_has_a_bounded_default_and_names_the_filesystem_that_is_short() {
    // 10 GiB by default, a tenth of a filesystem under 100 GiB, or the setting.
    assert_eq!(disk::reserve_bytes(1500 * disk::GIB, None), 10 * disk::GIB);
    assert_eq!(disk::reserve_bytes(50 * disk::GIB, None), 5 * disk::GIB);
    assert_eq!(disk::reserve_bytes(50 * disk::GIB, Some(30)), 30 * disk::GIB);
    let at = "2026-10-17T10:21:00Z";
    let data = sample("/data", disk::DATA, 1, 1500, 107);
    let work = sample("/work", disk::WORKDIR, 2, 500, 40);
    assert_eq!(disk::verdict(&[data.clone(), work.clone()], None, at), disk::Verdict::Start);
    // Each path on its own filesystem: a roomy data disk never stands in for a full working one.
    let full = sample("/work", disk::WORKDIR, 2, 500, 3);
    let disk::Verdict::Wait(reason) = disk::verdict(&[data.clone(), full.clone()], None, at) else { panic!("a short disk waits") };
    assert!(reason.contains("working directory /work has 3.0 GiB free; new jobs start at 10.0 GiB or more (read 2026-10-17T10:21:00Z)"), "{reason}");
    assert!(reason.contains("Running jobs are not stopped and nothing is deleted"), "{reason}");
    assert!(matches!(disk::verdict(&[data.clone(), work.clone()], Some(50), at),
        disk::Verdict::Wait(r) if r.contains("working directory /work has 40.0 GiB free; new jobs start at 50.0 GiB")));
    // A read that may work later is unknown, and the job waits for it, saying so.
    let unreadable = disk::Sample { error: Some("no answer within 5 seconds".into()), device: None, total: None, available: None, ..work.clone() };
    let disk::Verdict::Wait(reason) = disk::verdict(&[data.clone(), unreadable.clone()], None, at) else { panic!("waits") };
    assert!(reason.contains("free space of its working directory /work could not be read (no answer within 5 seconds)"), "{reason}");
    // Core's own data folder unreadable, for whatever reason: every job waits.
    let data_gone = disk::Sample { error: Some("Permission denied (os error 13)".into()), permanent: true, device: None, total: None, available: None, ..data.clone() };
    assert!(matches!(disk::verdict(&[data_gone, work.clone()], None, at), disk::Verdict::Wait(r) if r.contains("Core data and job records /data could not be read")));
    // Its own working directory missing: that job is not started, so it never holds the queue.
    let missing = disk::Sample { error: Some("No such file or directory (os error 2)".into()), permanent: true, device: None, total: None, available: None, ..work.clone() };
    assert_eq!(disk::verdict(&[data.clone(), missing], None, at), disk::Verdict::Reject(
        "Not started: its working directory /work cannot be used (No such file or directory (os error 2)). No process was created; submit again with a working directory that exists.".into()));
    // The panel shows each filesystem once, with every path read on it.
    let same = sample("/data/jobs-cwd", disk::WORKDIR, 1, 1500, 107);
    let view = disk::view(&[data, same, full, unreadable], None, at);
    let volumes = view["volumes"].as_array().unwrap();
    assert_eq!(volumes.len(), 3, "{view}");
    assert_eq!(volumes[0]["paths"].as_array().unwrap().len(), 2);
    assert_eq!((volumes[0]["low"].clone(), volumes[1]["low"].clone(), volumes[2]["low"].clone()), (json!(false), json!(true), Value::Null));
    assert_eq!(volumes[2]["error"], "no answer within 5 seconds");
    assert_eq!((view["reserveGiB"].clone(), view["observedAt"].clone()), (Value::Null, json!(at)));
    assert!(view["scope"].as_str().unwrap().contains("not a quota"));
}

#[tokio::test]
async fn real_reads_report_this_filesystem_and_a_missing_path_as_unknown() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("inner")).unwrap();
    let a = disk::sample(dir.path().to_string_lossy().into(), disk::DATA).await;
    let b = disk::sample(dir.path().join("inner").to_string_lossy().into(), disk::WORKDIR).await;
    assert!(a.error.is_none() && a.total.unwrap() > 0 && a.available.unwrap() <= a.total.unwrap(), "{a:?}");
    assert_eq!(a.device, b.device, "one filesystem, one device");
    let gone = disk::sample(dir.path().join("gone").to_string_lossy().into(), disk::WORKDIR).await;
    assert!(gone.device.is_none() && gone.permanent && gone.error.as_deref().is_some_and(|e| e.contains("No such file")), "{gone:?}");
    let file = dir.path().join("file");
    std::fs::write(&file, "").unwrap();
    let not_dir = disk::sample(file.join("x").to_string_lossy().into(), disk::WORKDIR).await;
    assert!(not_dir.permanent, "{not_dir:?}");
}

/// Review 39a920d7: a read that timed out keeps its blocking thread, so a
/// mount that stops answering must not get a new one on every pass.
#[tokio::test]
async fn a_hung_mount_is_read_once_until_it_answers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().into_owned();
    let held = disk::Held::on(&path);
    let first = disk::sample(path.clone(), disk::WORKDIR).await;
    let mut later = Vec::new();
    for _ in 0..3 {
        later.push(disk::sample(path.clone(), disk::WORKDIR).await);
    }
    assert_eq!(held.entered(), 1, "reads started on the hung path");
    assert_eq!(first.error.as_deref(), Some("no answer within 5 seconds"));
    assert!(!first.permanent, "unknown, not unusable: the job waits");
    for again in &later {
        assert_eq!(again.error.as_deref(), Some("its last read has not answered yet"), "{again:?}");
        assert!(!again.permanent && again.device.is_none());
    }
    // Once the filesystem answers, the path is read again.
    drop(held);
    let mut back = disk::sample(path.clone(), disk::WORKDIR).await;
    for _ in 0..100 {
        if back.error.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        back = disk::sample(path.clone(), disk::WORKDIR).await;
    }
    assert!(back.error.is_none() && back.available.is_some(), "{back:?}");
}

#[tokio::test]
async fn callers_reading_a_path_together_share_one_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_string_lossy().into_owned();
    let held = disk::Held::on(&path);
    // The queue and the Jobs panel read Core's data folder at the same time:
    // one read, one answer for both, and neither is told it is unknown.
    let (a, b, ()) = tokio::join!(
        disk::sample(path.clone(), disk::DATA),
        disk::sample(path.clone(), disk::DATA),
        async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            held.release();
        },
    );
    assert_eq!(held.entered(), 1, "reads started");
    assert!(a.error.is_none() && a.available.is_some(), "{a:?}");
    assert_eq!(a, b);
}

#[tokio::test]
async fn at_most_a_fixed_number_of_unanswered_reads_are_out() {
    let reads = disk::Reads::new(2, Duration::from_millis(100));
    let dir = tempfile::tempdir().unwrap();
    let paths: Vec<String> = ["a", "b", "c"]
        .iter()
        .map(|name| {
            std::fs::create_dir(dir.path().join(name)).unwrap();
            dir.path().join(name).to_string_lossy().into_owned()
        })
        .collect();
    let held: Vec<_> = paths.iter().map(|path| disk::Held::on(path)).collect();
    for path in &paths[..2] {
        let stuck = reads.sample(path.clone(), disk::WORKDIR).await;
        assert_eq!(stuck.error.as_deref(), Some("no answer within 0.1 seconds"));
    }
    let third = reads.sample(paths[2].clone(), disk::WORKDIR).await;
    assert_eq!(third.error.as_deref(), Some("2 earlier reads have not answered yet"));
    assert!(!third.permanent, "unknown, so the job waits");
    assert_eq!(held.iter().map(disk::Held::entered).collect::<Vec<_>>(), [1, 1, 0], "threads used");
    // Once the stuck reads return, there is room again.
    drop(held);
    let mut after = reads.sample(paths[2].clone(), disk::WORKDIR).await;
    for _ in 0..100 {
        if after.error.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        after = reads.sample(paths[2].clone(), disk::WORKDIR).await;
    }
    assert!(after.error.is_none() && after.available.is_some(), "{after:?}");
}

#[test]
fn a_low_disk_queue_head_waits_with_its_reason_and_starts_once_space_returns() {
    let (_dir, s) = setup();
    parallel_budget(&s);
    let running = submit(&s, "running");
    assert_eq!(s.reserve_next_job(None, None, None).unwrap().unwrap()["id"], running["id"]);
    s.update_job_evidence(running["id"].as_str().unwrap(), evidence(&running, "running")).unwrap();
    let next = submit(&s, "next");
    let id = next["id"].as_str().unwrap().to_owned();
    let low = super::DiskCheck { job_id: id.clone(), verdict: disk::Verdict::Wait("Waiting for disk space: test reason".into()) };
    assert!(s.reserve_next_job(None, None, Some(std::slice::from_ref(&low))).unwrap().is_none());
    let waiting = s.job(&id).unwrap();
    assert_eq!((waiting["status"].clone(), waiting["reserved"].clone(), waiting["reason"].clone()),
        (json!("queued"), json!(false), json!("Waiting for disk space: test reason")));
    // The running job is untouched.
    assert_eq!(s.job(running["id"].as_str().unwrap()).unwrap()["status"], "running");
    // A verdict read for another head changes nothing.
    let other = super::DiskCheck { job_id: "another".into(), verdict: disk::Verdict::Start };
    assert!(s.reserve_next_job(None, None, Some(std::slice::from_ref(&other))).unwrap().is_none());
    assert_eq!(s.job(&id).unwrap()["status"], "queued");
    // The panel reads the working directory of every live job.
    assert_eq!(s.live_job_cwds().unwrap(), ["/workspace"]);
    // Space is back: the same job starts, once.
    let ok = super::DiskCheck { job_id: id.clone(), verdict: disk::Verdict::Start };
    assert_eq!(s.reserve_next_job(None, None, Some(std::slice::from_ref(&ok))).unwrap().unwrap()["id"], json!(id));
    assert!(s.reserve_next_job(None, None, Some(std::slice::from_ref(&ok))).unwrap().is_none());
}

#[test]
fn the_disk_reserve_setting_is_bounded_kept_and_can_return_to_the_default() {
    let (dir, s) = setup();
    assert_eq!(s.job_disk_reserve().unwrap(), None);
    assert!(s.set_job_disk_reserve(Some(0)).unwrap_err().to_string().contains("1–1024 GiB"));
    assert!(s.set_job_disk_reserve(Some(2000)).is_err());
    assert_eq!(s.set_job_disk_reserve(Some(30)).unwrap(), Some(30));
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(s.job_disk_reserve().unwrap(), Some(30));
    assert_eq!(s.set_job_disk_reserve(None).unwrap(), None);
    assert_eq!(s.job_disk_reserve().unwrap(), None);
}

/// The 2026-10-17 incident (T-32 Job 159e79c0): the disk filled while the
/// launch record was written. Before, the job stayed "unknown", held its
/// reservation, and later read "Core stopped". Now it is not started, for
/// certain: rejected with the real error, reservation released, one notice.
#[tokio::test]
async fn a_launch_record_that_hits_a_full_disk_is_not_started_and_releases_its_reservation() {
    let (dir, s) = setup();
    let data = dir.path().join("core-data");
    let job = submit(&s, "enospc");
    let id = job["id"].as_str().unwrap().to_owned();
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    host::FULL_DISK.lock().unwrap().push(data.join("jobs").join(&id));
    let error = match host::launch(&data, &reserved).await {
        Err(host::LaunchError::NotStarted(error)) => error,
        other => panic!("expected not started, got {other:?}"),
    };
    host::FULL_DISK.lock().unwrap().retain(|p| !p.starts_with(&data));
    assert!(!host::dispatched(&data, &reserved).await.unwrap(), "systemd-run was never reached");
    let reason = not_started_reason(&error);
    assert!(reason.starts_with("Not started: Could not prepare its launch record in "), "{reason}");
    assert!(reason.contains("No space left on device (os error 28). The disk holding Core's data folder is full. No process was created and the reservation is released"), "{reason}");
    assert!(s.job_not_started(&id, &reason).unwrap());
    let after = s.job(&id).unwrap();
    assert_eq!((after["status"].clone(), after["reserved"].clone()), (json!("rejected"), json!(false)));
    assert!(after["finishedAt"].is_string() && after["notifications"]["rejected"].is_string());
    assert!(!after["reason"].as_str().unwrap().contains("Core stopped"));
    // Seen twice, still one notice; the queue goes on.
    assert!(!s.job_not_started(&id, &reason).unwrap());
    let next = submit(&s, "after-enospc");
    assert_eq!(s.reserve_next_job(None, None, None).unwrap().unwrap()["id"], next["id"]);
    // An explicit retry is a new requestId; the old one still names the rejected job.
    assert_eq!(s.previous_job(Some("a"), &input("enospc")).unwrap().unwrap()["id"], json!(id));
}

#[tokio::test]
async fn an_attempt_never_dispatched_is_resolved_as_not_started_not_held_as_unknown() {
    let (dir, s) = setup();
    let data = dir.path().join("core-data");
    // Core stopped between reservation and dispatch: no launch marker.
    let job = submit(&s, "never-dispatched");
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    let seen = host::observe(&data, &reserved).await.unwrap().unwrap();
    assert_eq!(seen["status"], "rejected");
    assert!(seen["reason"].as_str().unwrap().contains("never dispatched (no launch marker in its job folder), so no process was created"));
    assert!(s.update_job_evidence(job["id"].as_str().unwrap(), seen).unwrap());
    assert_eq!(s.job(job["id"].as_str().unwrap()).unwrap()["reserved"], false);
    // Cancelled before dispatch: cancelled, nothing to stop.
    let cancelled = submit(&s, "cancel-before-dispatch");
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    let pending = s.request_job_cancel(Some("a"), cancelled["id"].as_str().unwrap()).unwrap();
    let seen = host::observe(&data, &pending).await.unwrap().unwrap();
    assert_eq!(seen["status"], "cancelled");
    assert!(s.update_job_evidence(cancelled["id"].as_str().unwrap(), seen).unwrap());
    assert_eq!(s.job(cancelled["id"].as_str().unwrap()).unwrap()["reserved"], false);
    // A dispatched attempt is never called "not started": a second launch is unconfirmed.
    let dispatched = submit(&s, "dispatched");
    let reserved = s.reserve_next_job(None, None, None).unwrap().unwrap();
    let folder = data.join("jobs").join(dispatched["id"].as_str().unwrap());
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("dispatched.json"), "{}").unwrap();
    assert!(matches!(host::launch(&data, &reserved).await, Err(host::LaunchError::Unconfirmed(_))));
}

/// Review 2d5d892c: a queued job whose own working directory cannot be used
/// must not hold every later job; it is not started, and the next one goes.
#[test]
fn a_job_whose_working_directory_is_gone_is_not_started_and_the_queue_goes_on() {
    let (_dir, s) = setup();
    let gone = submit(&s, "gone");
    let next = submit(&s, "next");
    let id = gone["id"].as_str().unwrap().to_owned();
    let reject = super::DiskCheck { job_id: id.clone(), verdict: disk::Verdict::Reject("Not started: its working directory /workspace cannot be used (No such file or directory (os error 2)). No process was created; submit again with a working directory that exists.".into()) };
    assert!(s.reserve_next_job(None, None, Some(std::slice::from_ref(&reject))).unwrap().is_none());
    let rejected = s.job(&id).unwrap();
    assert_eq!((rejected["status"].clone(), rejected["reserved"].clone()), (json!("rejected"), json!(false)));
    assert!(rejected["reason"].as_str().unwrap().starts_with("Not started: its working directory"));
    assert!(rejected["finishedAt"].is_string() && rejected["notifications"]["rejected"].is_string());
    let go = super::DiskCheck { job_id: next["id"].as_str().unwrap().into(), verdict: disk::Verdict::Start };
    assert_eq!(s.reserve_next_job(None, None, Some(std::slice::from_ref(&go))).unwrap().unwrap()["id"], next["id"]);
}

/// An Agent running on a remote machine submits like any other (T-108): a Job
/// without machineId belongs to this Core's host, and its record names the
/// machine the Agent runs on, apart from where the Job runs.
#[test]
fn an_agent_on_a_remote_machine_submits_jobs_for_the_core_host() {
    let (_dir, s) = setup();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"r","name":"r","cwd":"/home/someone/work","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0,
        "remote":{"machine":{"id":"m1","name":"lab box","target":"lab-box","codex":"codex","defaultCwd":"/home/someone/work"},"runtime":null}},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    s.insert(&agent).unwrap();
    let job = s
        .create_job(Some("r"), input("from-remote-agent"), json!({"cwd":"/workspace"}), machine(), json!({"bootId":"boot"}))
        .unwrap();
    assert_eq!(job["agentId"], "r");
    assert_eq!(job["agentMachine"], json!({"id":"m1","name":"lab box"}), "{job}");
    assert!(job["executor"].is_null(), "{job}");
    assert_eq!(job["machine"]["id"], "local-test");
    assert!(submit(&s, "from-local-agent")["agentMachine"].is_null());
}
