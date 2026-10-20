//! Run explicitly in a managed Job. Real Core tool calls and host workers,
//! all inside that Job's cgroup: no nested systemd units/resource manager.
//! The unchanged supervisor/launcher is deliberately outside this test's claim.
use super::*;
use std::path::{Path, PathBuf};

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn resources_here() -> (Resources, String) {
    assert!(
        std::env::var("YUZUNO_JOB_ID").is_ok(),
        "Run this acceptance inside a managed Job"
    );
    let raw = std::fs::read_to_string("/proc/self/cgroup").unwrap();
    let group = raw.trim().split_once("::").unwrap().1.to_owned();
    let path = Path::new("/sys/fs/cgroup").join(group.trim_start_matches('/'));
    let memory: u64 = std::fs::read_to_string(path.join("memory.max"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let cpu: Vec<u64> = std::fs::read_to_string(path.join("cpu.max"))
        .unwrap()
        .split_whitespace()
        .map(|v| v.parse().unwrap())
        .collect();
    assert_eq!(
        std::fs::read_to_string(path.join("pids.max"))
            .unwrap()
            .trim(),
        "512"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("memory.swap.max"))
            .unwrap()
            .trim(),
        "0"
    );
    (
        Resources {
            cpu_millis: cpu[0] * 1000 / cpu[1],
            memory_mi_b: memory / 1048576,
            swap_mi_b: 0,
        },
        group,
    )
}

fn workspace(root: &Path, work: &Path, resources: &Resources) -> Arc<Workspace> {
    let ws = Workspace::new(
        root.join("data"),
        work.display().to_string(),
        "/usr/bin/false".into(),
    )
    .unwrap();
    // The harness drives reservation/worker/outcome once per attempt. The
    // production background scheduler must not create independent services.
    ws.jobs.started.set(()).unwrap();
    if ws.store.listed_agent("a").is_none() {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Fixture","cwd":work,
            "model":"fixture","color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&agent).unwrap();
        ws.store
            .collaboration_call(
                None,
                "task_create",
                json!({"requestId":"task","title":"Analysis gate acceptance","status":"doing"}),
            )
            .unwrap();
        ws.store
            .set_job_budget(Resources {
                cpu_millis: resources.cpu_millis + 100,
                memory_mi_b: resources.memory_mi_b + 64,
                swap_mi_b: 0,
            })
            .unwrap();
    }
    ws
}

async fn tool(ws: &Arc<Workspace>, name: &str, args: Value) -> Value {
    // The Agent MCP endpoint uses this same runtime dispatcher. Exercise its
    // job_* routing as well as the Jobs implementation.
    ws.collaboration_call(Some("a"), name, args)
        .await
        .unwrap()
}

fn spec(work: &Path, resources: &Resources, key: &str, needs: &[&str], gate: bool) -> Value {
    json!({"key":key,"needs":needs,"cwd":work,"argv":["/usr/bin/python3","fixture.py",format!("{key}.json")],
        "resources":resources,"guardGit":true,"inputs":["config.json"],"waitForAnalysis":gate,
        "artifacts":[{"path":format!("{key}.json"),"format":"json"}],"timeoutSeconds":30})
}

async fn submit(ws: &Arc<Workspace>, name: &str, stages: Value) -> Value {
    tool(
        ws,
        "job_run_submit",
        json!({"requestId":name,"taskId":"T-1","name":name,"stages":stages}),
    )
    .await
}

fn analysis(run: &Value, key: &str) -> Value {
    run["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == key)
        .unwrap()["analysis"]
        .clone()
}

fn decide(run: &Value, key: &str, choice: &str) -> Value {
    let gate = analysis(run, key);
    json!({"runId":run["id"],"stage":key,"gateId":gate["id"],"attemptId":gate["attemptId"],
        "requestId":format!("{}:{choice}",gate["id"].as_str().unwrap()),"decision":choice})
}

async fn execute_one(ws: &Arc<Workspace>, group: &str) -> Value {
    let job = ws
        .store
        .reserve_next_job(None, None, None)
        .unwrap()
        .expect("An eligible stage");
    let id = job["id"].as_str().unwrap();
    let folder = ws.data_dir.join("jobs").join(id);
    std::fs::create_dir_all(&folder).unwrap();
    let spec = folder.join("spec.json");
    std::fs::write(&spec, serde_json::to_vec(&job).unwrap()).unwrap();
    let helper = host::helper(&ws.data_dir).await.unwrap();
    let child = tokio::process::Command::new("/usr/bin/python3")
        .arg(helper)
        .arg("worker")
        .arg(spec)
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), child)
        .await
        .unwrap()
        .unwrap();
    let proof = read_json(&folder.join("started.json"));
    assert_eq!(
        proof["controlGroup"], group,
        "A fixture must never leave the outer Job cgroup"
    );
    assert_eq!(proof["attempt"], job["attempt"]);
    let reports = host::reports(&ws.data_dir, &job).await.unwrap();
    let rejected = folder.join("input-changed.json");
    let status = if rejected.exists() {
        "rejected"
    } else if output.status.success()
        && reports["artifacts"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(|a| a["ok"] == true))
    {
        "succeeded"
    } else {
        "failed"
    };
    let reason = if rejected.exists() {
        read_json(&rejected)["reason"].clone()
    } else {
        json!(status)
    };
    let evidence = json!({"jobId":job["id"],"attempt":job["attempt"],"status":status,"reason":reason,
        "started":proof,"artifacts":reports["artifacts"],"cost":reports["cost"],"progress":reports["progress"],
        "evidence":{"acceptanceWorkerExitCode":output.status.code(),"stderr":String::from_utf8_lossy(&output.stderr),
            "boundary":"Real host worker inside outer managed Job; no per-stage systemd service or collector"}});
    ws.store.update_job_evidence(id, evidence).unwrap();
    ws.store.job(id).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a managed Job cgroup; see acceptance/stage-analysis/README.md"]
async fn real_workers_preserve_gate_and_frozen_inputs_inside_managed_job() {
    let report =
        PathBuf::from(std::env::var("T125_ACCEPTANCE_REPORT").expect("Report path required"));
    std::fs::create_dir_all(report.parent().unwrap()).unwrap();
    let root = tempfile::Builder::new()
        .prefix("lab-")
        .tempdir_in(report.parent().unwrap())
        .unwrap()
        .keep();
    let work = root.join("work");
    std::fs::create_dir(&work).unwrap();
    std::fs::write(work.join("fixture.py"), "import json,os,pathlib,sys\np=pathlib.Path(sys.argv[1])\np.write_text(json.dumps({'output':str(p),'config':json.loads(pathlib.Path('config.json').read_text())}))\nwith pathlib.Path('starts.jsonl').open('a') as f:f.write(json.dumps({'output':str(p),'attempt':os.environ['YUZUNO_JOB_ATTEMPT']})+'\\n')\nprint('fixture completed '+str(p))\n").unwrap();
    std::fs::write(work.join("config.json"), "{\"seed\":1}").unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["add", "fixture.py", "config.json"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ],
    ] {
        assert!(std::process::Command::new("git")
            .args(args)
            .current_dir(&work)
            .status()
            .unwrap()
            .success());
    }
    let (resources, group) = resources_here();
    let mut ws = workspace(&root, &work, &resources);
    let mut train = spec(&work, &resources, "train", &[], true);
    train["exclusive"] = json!(true);
    let run = submit(
        &ws,
        "branches",
        json!([
            train.clone(),
            spec(&work, &resources, "eval", &["train"], false),
            spec(&work, &resources, "side", &[], false)
        ]),
    )
    .await;
    let first = execute_one(&ws, &group).await;
    assert_eq!(first["status"], "succeeded");
    assert_eq!(first["reserved"], false);
    let log = host::logs(&ws.data_dir, &first, None).await.unwrap();
    assert!(log["text"]
        .as_str()
        .unwrap()
        .contains("fixture completed train.json"));
    let side = execute_one(&ws, &group).await;
    assert_eq!(side["run"]["stage"], "side");
    assert_eq!(side["status"], "succeeded");
    assert!(!work.join("eval.json").exists());
    let waiting = tool(&ws, "job_run_get", json!({"runId":run["id"]})).await;
    assert_eq!(waiting["status"], "waiting_analysis");
    assert!(ws.store.active_jobs().unwrap().is_empty());
    assert!(ws
        .store
        .reserve_next_job(None, None, None)
        .unwrap()
        .is_none());
    assert_eq!(
        mail(&ws.store)
            .iter()
            .filter(|m| m["metadata"]["status"] == "waiting_analysis")
            .count(),
        1
    );
    drop(ws);
    ws = workspace(&root, &work, &resources);
    assert!(!ws.store.advance_runs().unwrap());
    let recovered = tool(&ws, "job_run_get", json!({"runId":run["id"]})).await;
    assert_eq!(analysis(&recovered, "train"), analysis(&waiting, "train"));
    assert!(ws
        .store
        .reserve_next_job(None, None, None)
        .unwrap()
        .is_none());
    let request = decide(&recovered, "train", "continue");
    tool(&ws, "job_run_decide", request.clone()).await;
    tool(&ws, "job_run_decide", request).await;
    let eval = execute_one(&ws, &group).await;
    assert_eq!(eval["status"], "succeeded");
    assert_eq!(
        eval["guardChecks"][0]["artifacts"][0]["sha256"],
        first["result"]["artifacts"][0]["sha256"]
    );
    let completed = tool(&ws, "job_run_get", json!({"runId":run["id"]})).await;
    assert_eq!(completed["status"], "succeeded");
    assert_eq!(
        std::fs::read_to_string(work.join("starts.jsonl"))
            .unwrap()
            .lines()
            .count(),
        3
    );

    // Reuse goes through the production file/digest verifier and still gets a
    // new run-owned decision, without executing another train command.
    train["reuse"] = first["id"].clone();
    let reused = submit(&ws, "reuse", json!([train.clone()])).await;
    assert_eq!(reused["status"], "waiting_analysis");
    assert_ne!(
        analysis(&reused, "train")["id"],
        analysis(&waiting, "train")["id"]
    );
    assert!(ws
        .store
        .reserve_next_job(None, None, None)
        .unwrap()
        .is_none());
    let cancelled = tool(&ws, "job_run_decide", decide(&reused, "train", "cancel")).await;
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(
        ws.store.job(first["id"].as_str().unwrap()).unwrap()["status"],
        "succeeded"
    );

    // A decision cannot bless changed artifacts or source/declared inputs.
    let original_artifact = std::fs::read(work.join("train.json")).unwrap();
    let mut rejected = Vec::new();
    for (name, file, replacement) in [
        ("artifact", "train.json", "{}"),
        ("input", "config.json", "{\"seed\":2}"),
    ] {
        let candidate = submit(
            &ws,
            name,
            json!([
                train.clone(),
                spec(&work, &resources, name, &["train"], false)
            ]),
        )
        .await;
        std::fs::write(work.join(file), replacement).unwrap();
        tool(
            &ws,
            "job_run_decide",
            decide(&candidate, "train", "continue"),
        )
        .await;
        let attempt = execute_one(&ws, &group).await;
        assert_eq!(attempt["status"], "rejected", "{}", attempt["result"]);
        assert!(!work.join(format!("{name}.json")).exists());
        rejected.push(attempt);
        tool(&ws, "job_run_cancel", json!({"runId":candidate["id"]})).await;
        std::fs::write(work.join("train.json"), &original_artifact).unwrap();
        std::fs::write(work.join("config.json"), "{\"seed\":1}").unwrap();
    }
    let report_value = json!({"outerJobId":std::env::var("YUZUNO_JOB_ID").unwrap(),"controlGroup":group,"resources":resources,
        "scope":"Production Core tool calls and real host workers within one managed Job cgroup; no per-stage systemd launcher/collector, GPU, model or external API tested",
        "lab":root,"checks":["verified worker limits", "real output/log/artifact", "independent branch", "idle gate/no reservations", "restart/offline", "idempotent continue", "frozen digest propagation", "fresh reuse gate", "gate cancellation", "changed artifact rejected", "changed Git/input rejected"],
        "run":completed,"reused":cancelled,"first":first,"independent":side,"eval":eval,"rejected":rejected});
    std::fs::write(&report, serde_json::to_vec_pretty(&report_value).unwrap()).unwrap();
    println!("Analysis gate acceptance passed: {}", report.display());
}
