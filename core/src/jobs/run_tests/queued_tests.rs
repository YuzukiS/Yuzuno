//! YN-30: a run whose work is only queued reads "queued", not "running", and
//! says which stage is first in the queue and what it waits for, as admission
//! gives that attempt's reason now. Synthetic records only.
use super::*;

fn queue(s: &Store, run: &Value) -> Value {
    s.run(run["id"].as_str().unwrap()).unwrap()["queue"].clone()
}
fn listed(s: &Store) -> Value {
    s.list_runs(Some("a"), Some("T-1"), None, None, false).unwrap()["runs"][0].clone()
}
fn live(s: &Store, run: &Value) -> Value {
    let db = s.db.read().unwrap();
    crate::jobs::run_live_ref(&db, run["id"].as_str().unwrap()).unwrap().unwrap()
}

#[test]
fn a_run_with_only_queued_work_is_queued_and_says_what_it_waits_for() {
    let (_dir, s) = setup();
    let run = create(&s, "queued", json!([stage("prep", &[]), stage("train", &["prep"])]));
    let prep = attempts(&run, "prep")[0]["id"].clone();
    // Submitted: nothing runs yet, and admission has not looked at it.
    assert_eq!(run["status"], "queued");
    assert_eq!(run["queue"], json!({"stage":"prep","jobId":prep,"waitingFor":"capacity",
        "reason":"Waiting for shared machine capacity"}));

    // Admission holds it for host memory: the run says so wherever it is read.
    assert!(s.reserve_next_job(Some(16), None, None).unwrap().is_none());
    let waiting = queue(&s, &run);
    assert_eq!((waiting["stage"].as_str(), waiting["waitingFor"].as_str()), (Some("prep"), Some("memory")), "{waiting}");
    assert!(waiting["reason"].as_str().unwrap().starts_with("Waiting for host memory"), "{waiting}");
    let row = listed(&s);
    assert_eq!((row["status"].as_str(), row["queue"].clone()), (Some("queued"), waiting.clone()));
    let shown = live(&s, &run);
    assert_eq!((shown["status"].as_str(), shown["waitingFor"].as_str()), (Some("queued"), Some("memory")), "{shown}");

    // Started: the run runs, and has no queue field.
    let started = start(&s);
    assert_eq!(started["id"], prep);
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "running");
    assert!(view.get("queue").is_none(), "{view}");
    assert!(listed(&s).get("queue").is_none());
    assert!(live(&s, &run).get("waitingFor").is_none());

    // Its next stage released and queued: queued again, now for train.
    assert!(success(&s, &started, "aaa"));
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "queued");
    assert_eq!(view["queue"]["stage"], "train");

    // Cancelled while queued: cancelled, not queued, with no queue field.
    let cancelled = s.request_run_cancel(Some("a"), run["id"].as_str().unwrap()).unwrap();
    assert_eq!(cancelled["status"], "cancelled", "{cancelled}");
    assert!(cancelled.get("queue").is_none());
}

#[test]
fn a_queued_gpu_stage_waits_for_a_gpu_and_a_running_branch_keeps_the_run_running() {
    let (_dir, s) = setup();
    // One device, too full for the stage: it waits for a GPU.
    s.record_gpu_sample(json!({"source":"fixture","devices":[{"index":0,
        "uuid":"GPU-00000000-1111-2222-3333-444444444444","name":"Fixture GPU",
        "memoryTotalMiB":8192,"memoryFreeMiB":32,"memoryUsedMiB":8160,"utilizationPercent":99}]}))
        .unwrap();
    let mut train = stage("train", &[]);
    train["gpu"] = json!({"memoryMiB":128});
    let run = create(&s, "gpu", json!([train, stage("other", &[])]));
    // Admission starts the CPU-only stage and holds the GPU one.
    let other = start(&s);
    assert_eq!(other["run"]["stage"], "other");
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "running", "one branch runs, so the run runs");
    assert!(view.get("queue").is_none());
    // That branch done, only the GPU stage is left, queued.
    assert!(success(&s, &other, "bbb"));
    let waiting = queue(&s, &run);
    assert_eq!((waiting["stage"].as_str(), waiting["waitingFor"].as_str()), (Some("train"), Some("gpu")), "{waiting}");
    assert!(waiting["reason"].as_str().unwrap().starts_with("Waiting for a GPU"), "{waiting}");
    assert_eq!(live(&s, &run)["waitingFor"], "gpu");
}

#[test]
fn a_failed_stage_beside_a_queued_one_leaves_the_run_queued_until_nothing_can_start() {
    let (_dir, s) = setup();
    let run = create(&s, "mixed", json!([stage("first", &[]), stage("other", &[])]));
    let first = start(&s);
    assert_eq!(first["run"]["stage"], "first");
    assert!(finish(&s, &first, "failed", exit("1"), json!({})));
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "queued", "other can still start");
    assert_eq!(view["queue"]["stage"], "other");
    let other = start(&s);
    assert!(finish(&s, &other, "failed", exit("1"), json!({})));
    let view = s.run(run["id"].as_str().unwrap()).unwrap();
    assert_eq!(view["status"], "failed");
    assert!(view.get("queue").is_none());
}

#[test]
fn each_admission_reason_has_its_kind_and_an_unknown_one_is_plain_capacity() {
    use super::runs::waiting_for;
    for (reason, kind) in [
        ("Waiting for a GPU: GPU-0 has 32 MiB free of 8192 MiB", "gpu"),
        ("Waiting for a GPU: no NVIDIA device is present in the current sample", "gpu"),
        ("Waiting for GPU GPU-1, which is not present in the current sample", "gpu"),
        ("Waiting for a current GPU sample: no sample yet. GPU jobs start only on a current sample; CPU jobs are not held", "gpu"),
        ("Waiting for shared RAM reservation: needs 1088 MiB including collector, 64 MiB available; short 1024 MiB", "memory"),
        ("Waiting for shared swap reservation: needs 64 MiB, 0 MiB available; short 64 MiB", "memory"),
        ("Waiting for host memory while preserving Core/desktop headroom: needs 128 MiB", "memory"),
        ("Waiting for shared CPU quota: needs 4100 mCPU including collector, 100 mCPU available; short 4000 mCPU", "cpu"),
        ("Waiting for an execution/collector slot", "slot"),
        ("Waiting for disk space: the filesystem of its working directory /w has 1 GiB free", "disk"),
        ("Waiting for the exclusive job to finish and its process groups to be cleared", "exclusive"),
        ("Waiting for an earlier exclusive job in FIFO order", "exclusive"),
        ("Waiting for running jobs to finish and their process groups to be cleared", "exclusive"),
        ("Waiting for outstanding reservations to fit the lowered budget: reserved 1 mCPU", "budget"),
        ("Waiting for shared machine capacity", "capacity"),
        ("", "capacity"),
        ("Something Core says later", "capacity"),
    ] {
        assert_eq!(waiting_for(reason), kind, "{reason}");
    }
}
