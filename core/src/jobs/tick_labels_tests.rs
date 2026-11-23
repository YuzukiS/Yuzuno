//! YN-221: the Jobs tick's steps each under a label of their own, nested in
//! the service's `svc jobs` (runtime_diag's nesting: a parent counts only what
//! none of its children took). The real tick, as watch_tests.rs runs it: a
//! cgroup tree of the test's own and a stand-in helper, no systemd. The
//! measurement (#[ignore]) prints what each step costs per tick under a
//! history of runs and Jobs, Jobs running and a queue waiting; it reads every
//! label that starts with `svc jobs`, so the same file measures a Core from
//! before the split too.
use super::*;
use crate::model::AgentDetail;
use std::path::PathBuf;

const STUB: &str = r#"import pathlib, sys
spec = pathlib.Path(sys.argv[2])
answer = spec.parent / ('answer-' + sys.argv[1] + '.json')
print(answer.read_text() if answer.exists() else '{}')
"#;

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    root: PathBuf,
}

impl Drop for Lab {
    fn drop(&mut self) {
        host::CGROUPS.lock().unwrap().retain(|(dir, _)| *dir != self.ws.data_dir);
        host::HELPERS.lock().unwrap().retain(|(dir, _)| *dir != self.ws.data_dir);
    }
}

fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/workspace".into(), "unused".into()).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Tick labels","status":"doing"})).unwrap();
    let root = dir.path().join("cgroup");
    let stub = dir.path().join("stub-helper.py");
    std::fs::write(&stub, STUB).unwrap();
    host::CGROUPS.lock().unwrap().push((ws.data_dir.clone(), root.clone()));
    host::HELPERS.lock().unwrap().push((ws.data_dir.clone(), stub));
    Lab { _dir: dir, ws, root }
}

fn boot() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim().to_owned()
}

fn submit(lab: &Lab, name: &str, memory: u64) -> Value {
    let input: Submit = serde_json::from_value(json!({"requestId":name,"taskId":"T-1","name":name,"cwd":"/workspace","argv":["/usr/bin/sleep","600"],
        "resources":{"cpuMillis":500,"memoryMiB":memory,"swapMiB":0}})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":8192,"swapMiB":0}});
    lab.ws.store.create_job(Some("a"), input, json!({"cwd":"/workspace"}), machine, json!({"bootId": boot()})).unwrap()
}

fn write(path: PathBuf, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value.to_string()).unwrap();
}

fn live(lab: &Lab, group: &str) {
    let dir = lab.root.join(group.trim_start_matches('/'));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
}

/// A Job reserved and running: its records as its collector and worker write them, both groups live.
fn running(lab: &Lab, name: &str) {
    submit(lab, name, 128);
    let job = lab.ws.store.reserve_next_job(None, None, None).unwrap().unwrap();
    let dir = host::folder(&lab.ws.data_dir, &job).unwrap();
    let (attempt, boot) = (&job["attempt"], &job["bootId"]);
    let id = job["id"].as_str().unwrap();
    let (worker, collector) = (format!("/yn221/{id}-worker"), format!("/yn221/{id}-collector"));
    write(dir.join("dispatched.json"), &json!({"jobId":job["id"],"attempt":attempt,"bootId":boot}));
    write(dir.join("spec.json"), &job);
    write(dir.join("launch.json"), &json!({"attempt":attempt,"bootId":boot,"at":1.0,"controlGroup":collector}));
    let proof = json!({"jobId":job["id"],"attempt":attempt,"bootId":boot,"invocationId":"invocation","controlGroup":worker,"pid":1,"at":1.0});
    write(dir.join("started.json"), &proof);
    write(dir.join("command.json"), &json!({"attempt":attempt,"pid":2,"startedAt":1.0}));
    live(lab, &worker);
    live(lab, &collector);
    write(dir.join("answer-reconcile.json"), &json!({"status":"unresolved","systemd":{"SubState":"running","InvocationID":"invocation"},
        "supervisor":{"ActiveState":"active"},"started":proof,"freezer":{"populated":true,"frozen":false},
        "command":{"attempt":attempt,"pid":2,"startedAt":1.0}}));
}

/// A history of `runs` settled runs and `jobs` finished Jobs, of about `bytes` each.
fn history(lab: &Lab, runs: usize, jobs: usize, bytes: usize) {
    let mut db = lab.ws.store.db.write().unwrap();
    let tx = db.transaction().unwrap();
    let task: String = tx.query_row("SELECT id FROM collaboration_tasks LIMIT 1", [], |r| r.get(0)).unwrap();
    let pad = "x".repeat(bytes);
    for i in 0..runs {
        let data = json!({"id": format!("run-{i}"), "settledAt": "2026-11-20T00:00:00Z", "stages": [{"key": "build", "note": pad}]});
        tx.execute("INSERT INTO local_job_runs(id,task_id,agent_id,data) VALUES(?1,?2,'a',?3)", rusqlite::params![format!("run-{i}"), task, data.to_string()]).unwrap();
    }
    for i in 0..jobs {
        let data = json!({"id": format!("hist-{i}"), "status": "succeeded", "cwd": "/w", "createdAt": "2026-11-20T00:00:00Z", "result": {"note": pad}});
        tx.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES(?1,?2,'a','succeeded',0,?3)",
            rusqlite::params![format!("hist-{i}"), task, data.to_string()]).unwrap();
    }
    tx.commit().unwrap();
}

/// Every `svc jobs…` label: asyncNs, polls, storeNs, storeJobs.
fn jobs_labels(ws: &Workspace) -> std::collections::BTreeMap<String, [u64; 4]> {
    let report = crate::runtime_diag::report(ws);
    report["cpu"]["labels"].as_array().cloned().unwrap_or_default().iter()
        .filter_map(|l| {
            let name = l["label"].as_str()?;
            name.starts_with("svc jobs").then(|| {
                let n = |k: &str| l[k].as_u64().unwrap_or(0);
                (name.to_owned(), [n("asyncNs"), n("polls"), n("storeNs"), n("storeJobs")])
            })
        })
        .collect()
}

/// `n` ticks as the service runs them: under its own label.
async fn ticks(lab: &Lab, n: usize) {
    for _ in 0..n {
        crate::runtime_diag::scope("svc jobs", tick(&lab.ws)).await.unwrap();
    }
}

/// A lab with a Job running and one queued behind it that cannot start.
async fn busy_lab() -> Lab {
    let lab = lab();
    running(&lab, "running");
    // Too big for what the running one leaves.
    submit(&lab, "queued", 8_000);
    lab
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_step_of_the_tick_counts_its_store_work_under_its_own_label() {
    if !crate::runtime_diag::cpu_enabled() {
        return; // This process was started with the clocks off; the test below covers that.
    }
    let lab = busy_lab().await;
    let before = jobs_labels(&lab.ws);
    ticks(&lab, 3).await;
    let after = jobs_labels(&lab.ws);
    let grew = |label: &str| after.get(label).map_or(0, |a| a[3]) > before.get(label).map_or(0, |b| b[3]);
    // The store work each step asks for runs on the blocking pool under the step's label.
    for label in [TICK_EVIDENCE, TICK_RUNS, TICK_ADMISSION, "svc jobs"] {
        assert!(grew(label), "{label} counted store work: {before:?} → {after:?}");
    }
    // Only these four, all fixed names: nothing of a Job's id or name.
    assert!(after.keys().all(|name| ["svc jobs", TICK_EVIDENCE, TICK_RUNS, TICK_ADMISSION].contains(&name.as_str())), "{after:?}");
}

/// Run by the test below in a process of its own with `YUZUNO_DIAG_CPU=0`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "run with YUZUNO_DIAG_CPU=0 by with_the_clocks_off_the_tick_counts_nothing"]
async fn tick_clocks_off_child() {
    assert!(!crate::runtime_diag::cpu_enabled(), "YUZUNO_DIAG_CPU=0 turns the clocks off");
    let lab = busy_lab().await;
    ticks(&lab, 3).await;
    assert!(jobs_labels(&lab.ws).is_empty(), "nothing counted with the clocks off");
}

#[test]
fn with_the_clocks_off_the_tick_counts_nothing() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "jobs::tick_labels_tests::tick_clocks_off_child", "--ignored", "--nocapture", "--test-threads=1"])
        .env("YUZUNO_DIAG_CPU", "0")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success() && text.contains("1 passed"), "{text}\n{}", String::from_utf8_lossy(&output.stderr));
}

/// The process's own CPU so far (all its threads), from the kernel.
fn process_cpu_ns() -> u64 {
    crate::runtime_diag::process_cpu_ns().unwrap_or(0)
}

/// What each step of the tick costs per tick: a history of 600 runs and 5,000
/// finished Jobs of about 4 KB, 4 Jobs running and 21 queued that cannot start.
/// With YUZUNO_DIAG_CPU=0 it says only the tick's wall time and the process's
/// CPU, for the clocks' own cost.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "a measurement: cargo test --release jobs::tick_labels_tests::jobs_tick_cost -- --ignored --nocapture"]
async fn jobs_tick_cost() {
    let lab = lab();
    history(&lab, 600, 5_000, 4_000);
    for i in 0..4 {
        running(&lab, &format!("running-{i}"));
    }
    for i in 0..21 {
        submit(&lab, &format!("queued-{i}"), 8_000);
    }
    // The first ticks settle the starts (the helper asked once each); the rest are what a steady queue costs.
    ticks(&lab, 3).await;
    let n = 100;
    let before = jobs_labels(&lab.ws);
    let (cpu0, wall0) = (process_cpu_ns(), std::time::Instant::now());
    ticks(&lab, n).await;
    let (cpu1, wall) = (process_cpu_ns(), wall0.elapsed());
    let after = jobs_labels(&lab.ws);
    let per_tick = |ns: u64| (ns as f64 / 1e6 / n as f64 * 1000.0).round() / 1000.0;
    let steps: Vec<Value> = after.iter().map(|(name, a)| {
        let b = before.get(name).copied().unwrap_or_default();
        json!({"label": name, "asyncMsPerTick": per_tick(a[0] - b[0]), "storeMsPerTick": per_tick(a[2] - b[2]),
            "pollsPerTick": (a[1] - b[1]) as f64 / n as f64, "storeJobsPerTick": (a[3] - b[3]) as f64 / n as f64})
    }).collect();
    let labelled: u64 = after.iter().map(|(name, a)| {
        let b = before.get(name).copied().unwrap_or_default();
        (a[0] - b[0]) + (a[2] - b[2])
    }).sum();
    let process = cpu1 - cpu0;
    println!("{}", json!({"clocks": crate::runtime_diag::cpu_enabled(), "ticks": n, "running": 4, "queued": 21, "historyRuns": 600, "historyJobs": 5000,
        "wallMsPerTick": (wall.as_secs_f64() * 1000.0 / n as f64 * 1000.0).round() / 1000.0,
        "processCpuMsPerTick": per_tick(process), "labelledMsPerTick": per_tick(labelled),
        "unattributedMsPerTick": per_tick(process.saturating_sub(labelled)), "steps": steps}));
}
