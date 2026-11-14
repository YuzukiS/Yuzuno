//! A macOS Core's own Jobs (YN-108 M2c): the built-in machine `mac`, This
//! Mac, reached by remote.rs's local transport with the Mac's own python3,
//! in the limited mode, within this Core's Jobs budget and maxActive.
//!
//! On Linux, `host::NOT_LINUX` makes the Core look like a macOS one, and a
//! stand-in for `/usr/bin/python3` runs the real helper here with a machine
//! identity and no systemd user manager of the test's own. On macOS
//! (core-macos.yml) the same tests run the real thing: `/usr/bin/xcode-select`,
//! `/usr/bin/python3` and the helper's Darwin code. Either way the Core's data
//! folder has a space in its path, as a Mac's default one under
//! "Application Support" does, so its attempts' root has one too.
use super::*;
use crate::model::AgentDetail;
use sha2::Digest;
use std::path::PathBuf;

const HELPER: &str = include_str!("remote_job.py");

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    data: PathBuf,
    work: PathBuf,
    python: String,
    xcode_select: String,
}
impl Drop for Lab {
    fn drop(&mut self) {
        host::NOT_LINUX.lock().unwrap().retain(|d| d != &self.data);
    }
}
impl Lab {
    fn programs(&self) -> remote::Programs<'_> {
        let mac = remote::MacTools { python: &self.python, xcode_select: &self.xcode_select };
        remote::Programs { ssh: remote::SSH, windows: None, mux: None, mac }
    }
    async fn call(&self, actor: Option<&str>, operation: &str, input: Value) -> Result<Value> {
        call(self.ws.clone(), actor.map(str::to_owned), operation.into(), input).await
    }
    async fn tick(&self) {
        // Every check now, not on the ten-second cadence.
        self.ws.jobs.remote_seen.lock().unwrap().clear();
        remote::tick_with(&self.ws, &self.programs()).await.unwrap();
    }
    fn job(&self, of: &Value) -> Value {
        self.ws.store.job(of["id"].as_str().unwrap()).unwrap()
    }
    async fn until(&self, of: &Value, done: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..200 {
            self.tick().await;
            let now = self.job(of);
            if done(&now) {
                return now;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("no settled state: {}", self.job(of));
    }
    fn saved_jobs(&self) -> i64 {
        self.ws.store.db.read().unwrap().query_row("SELECT count(*) FROM local_jobs", [], |r| r.get(0)).unwrap()
    }
    /// This Core's root for This Mac's attempts.
    fn root(&self) -> PathBuf {
        std::path::absolute(&self.ws.data_dir).unwrap().join("local-jobs")
    }
}

fn script(path: PathBuf, body: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let support = dir.path().join("Application Support");
    let (data, work) = (support.join("yuzuno"), dir.path().join("work"));
    std::fs::create_dir_all(&support).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused".into()).unwrap();
    // No scheduler: each test makes its passes itself, with its own programs.
    ws.jobs.started.set(()).unwrap();
    host::NOT_LINUX.lock().unwrap().push(data.clone());
    ws.store.set_job_budget(Resources { cpu_millis: 8000, memory_mi_b: 16384, swap_mi_b: 0 }).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage",
        "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Mac jobs","status":"doing"})).unwrap();
    let (python, xcode_select) = if cfg!(target_os = "macos") {
        (remote::MAC_TOOLS.python.to_owned(), remote::MAC_TOOLS.xcode_select.to_owned())
    } else {
        // The real helper on this Linux host, as a Mac's python3 runs it:
        // a machine identity of the test's own, and no systemd user manager.
        let path = |name: &str| dir.path().join(name);
        std::fs::create_dir_all(path("home")).unwrap();
        std::fs::write(path("machine-id"), "0123456789abcdef0123456789abcdef\n").unwrap();
        std::fs::write(path("capabilities.json"), r#"{"manager": false, "busctl": false, "delegated": [], "linger": false}"#).unwrap();
        let python = script(path("python3"), &format!(
            "#!/bin/sh\nexec /usr/bin/env HOME='{}' YUZUNO_JOBS_MACHINE_ID_FILE='{}' YUZUNO_JOBS_CAPABILITIES_FILE='{}' python3 \"$@\"\n",
            path("home").display(), path("machine-id").display(), path("capabilities.json").display()));
        (python, script(path("xcode-select"), "#!/bin/sh\necho /Library/Developer/CommandLineTools\n"))
    };
    Lab { dir, ws, data, work, python, xcode_select }
}

/// A job_submit as an Agent sends it, naming no machine.
fn job(lab: &Lab, id: &str, command: &str, extra: Value) -> Value {
    let mut request = json!({"requestId":id,"taskId":"T-1","name":id,"cwd":lab.work,"argv":["/bin/sh","-c",command],
        "env":{"PATH":"/usr/bin:/bin"},"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},
        "timeoutSeconds":120,"guardGit":false});
    for (key, value) in extra.as_object().unwrap() {
        request[key] = value.clone();
    }
    request
}

async fn gone(pid: i64) -> bool {
    for _ in 0..50 {
        if !crate::test_platform::running(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

async fn pid_in(lab: &Lab, name: &str) -> i64 {
    for _ in 0..100 {
        if let Some(pid) = std::fs::read_to_string(lab.work.join(name)).ok().and_then(|text| text.trim().parse().ok()) {
            return pid;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{name} was not written");
}

#[tokio::test]
async fn a_macos_core_runs_its_job_on_this_mac_in_the_limited_mode_and_checks_its_artifact_there() {
    let lab = lab();
    let sent = job(&lab, "first", "echo ok; printf '{\"ok\":true}' > out.json", json!({"artifacts":[{"path":"out.json","format":"json"}]}));
    let queued = lab.call(Some("a"), "job_submit", sent.clone()).await.unwrap();
    assert_eq!(queued["target"], json!({"requested":null,"kind":"mac","machineId":"mac","machineName":"This Mac"}));
    assert_eq!(queued["executor"], json!({"kind":"mac","machineId":"mac","machineName":"This Mac","limitMode":"limited"}));
    assert_eq!(queued["capabilities"], remote::mac_capabilities());
    assert_eq!((queued["status"].as_str(), queued["reason"].as_str()), (Some("queued"), Some("Waiting for a slot on This Mac")));
    // A retry sent as before is the same Job.
    assert_eq!(lab.call(Some("a"), "job_submit", sent).await.unwrap()["id"], queued["id"]);
    let done = lab.until(&queued, |j| j["reserved"] == false).await;
    assert_eq!(done["status"], "succeeded", "{done}");
    assert_eq!(done["result"]["evidence"]["result"]["limits"]["mode"], "limited", "{done}");
    assert_eq!(done["result"]["artifacts"][0]["ok"], true, "{done}");
    // In this Core's data folder, its name's space and all.
    let root = lab.root();
    assert!(root.to_string_lossy().contains("Application Support/"), "{}", root.display());
    assert_eq!(done["remote"]["root"].as_str(), Some(root.to_str().unwrap()), "{done}");
    let attempt = root.join("jobs").join(done["id"].as_str().unwrap()).join(done["attempt"].as_str().unwrap());
    assert!(attempt.join("intent.json").is_file() && attempt.join("result.json").is_file());
    assert_eq!(done["remote"]["platform"], if cfg!(target_os = "macos") { "Darwin" } else { "Linux" }, "{done}");
    let log = remote::logs_with(&lab.ws, &done, None, &lab.programs()).await.unwrap();
    assert_eq!(log["text"], "ok\n");
    // No Core before data roots ran on macOS: none is kept out for it
    // (older_cores.rs), so the Workspace lock is not made read-only.
    if !rustix::process::geteuid().is_root() {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(lab.ws.data_dir.join("workspace.lock")).unwrap().permissions().mode();
        assert_ne!(mode & 0o777, 0o400, "the Workspace lock stays writable");
    }
}

#[tokio::test]
async fn a_cancel_stops_the_attempts_process_group_on_this_mac() {
    let lab = lab();
    let queued = lab.call(Some("a"), "job_submit", job(&lab, "cancelled", "sleep 30 & echo $! > child.pid; wait", json!({}))).await.unwrap();
    lab.until(&queued, |j| j["status"] == "running").await;
    let child = pid_in(&lab, "child.pid").await;
    assert!(crate::test_platform::running(child));
    lab.call(Some("a"), "job_cancel", json!({"jobId": queued["id"]})).await.unwrap();
    let cancelled = lab.until(&queued, |j| j["reserved"] == false).await;
    assert_eq!(cancelled["status"], "cancelled", "{cancelled}");
    assert!(gone(child).await, "the command's child in its group is stopped too");
}

#[tokio::test]
async fn a_job_on_this_mac_past_its_timeout_is_stopped() {
    let lab = lab();
    let queued = lab.call(Some("a"), "job_submit", job(&lab, "overdue", "sleep 30 & echo $! > child.pid; wait", json!({"timeoutSeconds": 2}))).await.unwrap();
    lab.until(&queued, |j| j["status"] == "running").await;
    let child = pid_in(&lab, "child.pid").await;
    let ended = lab.until(&queued, |j| j["reserved"] == false).await;
    assert_eq!(ended["status"], "failed", "{ended}");
    assert!(ended["reason"].as_str().unwrap().starts_with("timeout after 2 s; its process group was stopped"), "{ended}");
    assert!(gone(child).await);
}

#[tokio::test]
async fn without_the_command_line_tools_nothing_is_run_on_this_mac() {
    let mut lab = lab();
    let ran = lab.dir.path().join("python-ran");
    lab.xcode_select = script(lab.dir.path().join("no-tools"),
        "#!/bin/sh\necho 'xcode-select: error: unable to get active developer directory' >&2\nexit 2\n");
    lab.python = script(lab.dir.path().join("stand-in"), &format!("#!/bin/sh\n: > '{}'\nexit 1\n", ran.display()));
    let queued = lab.call(Some("a"), "job_submit", job(&lab, "no-tools", "echo ok", json!({}))).await.unwrap();
    let ended = lab.until(&queued, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    let reason = ended["reason"].as_str().unwrap();
    assert!(reason.starts_with("Not started on This Mac: Jobs on This Mac need the Xcode Command Line Tools"), "{reason}");
    // Inputs are not read either: nothing is submitted.
    let error = remote::remote_snapshot(&lab.ws, &lab.programs(), "mac", &lab.work.to_string_lossy(), &["a.txt".into()]).await.unwrap_err();
    assert!(error.to_string().contains("Jobs on This Mac need the Xcode Command Line Tools"), "{error}");
    assert!(!ran.exists(), "python3 was never run");
}

#[tokio::test]
async fn inputs_on_this_mac_are_frozen_there_at_submit_and_go_with_the_start() {
    let lab = lab();
    std::fs::write(lab.work.join("a.txt"), "frozen\n").unwrap();
    let snapshot = remote::remote_snapshot(&lab.ws, &lab.programs(), "mac", &lab.work.to_string_lossy(), &["a.txt".into()]).await.unwrap();
    assert_eq!(snapshot["frozenOn"], json!({"id":"mac","name":"This Mac","kind":"mac"}));
    assert_eq!(snapshot["files"][0]["sha256"], json!(format!("{:x}", sha2::Sha256::digest(b"frozen\n"))), "{snapshot}");
    let mut input: Submit = serde_json::from_value(job(&lab, "inputs", "cat a.txt", json!({"inputs":["a.txt"],"machineId":"mac"}))).unwrap();
    input.validate().unwrap();
    input.default_env();
    let created = lab.ws.store.create_job(Some("a"), input, snapshot, Value::Null, remote::mac_capabilities()).unwrap();
    assert!(created["remote"]["prebound"].is_object(), "{created}");
    let done = lab.until(&created, |j| j["reserved"] == false).await;
    assert_eq!(done["status"], "succeeded", "{done}");
    assert_eq!(remote::logs_with(&lab.ws, &done, None, &lab.programs()).await.unwrap()["text"], "frozen\n");
}

#[tokio::test]
async fn on_a_macos_core_this_host_is_this_mac_and_what_needs_linux_is_refused_before_anything_is_saved() {
    let lab = lab();
    for (named, requested) in [(json!("local"), json!("local")), (json!("agent"), json!("agent")), (json!("mac"), json!("mac"))] {
        let id = format!("named-{}", named.as_str().unwrap());
        let queued = lab.call(Some("a"), "job_submit", job(&lab, &id, "true", json!({"machineId": named}))).await.unwrap();
        assert_eq!(queued["target"], json!({"requested":requested,"kind":"mac","machineId":"mac","machineName":"This Mac"}), "{queued}");
    }
    let before = lab.saved_jobs();
    for (extra, refusal) in [
        (json!({"guardGit": true}), "guardGit is not available on This Mac, where a macOS Core runs its Jobs in the limited mode, in this version; set guardGit to false"),
        (json!({"gpu": {"memoryMiB": 1024}}), "GPU admission is not available on This Mac"),
        (json!({"resources": {"cpuMillis": 500, "cpuMillisMax": 2000, "memoryMiB": 128, "swapMiB": 0}}), "A CPU range up to cpuMillisMax needs a Linux host's cgroup"),
        (json!({"exclusive": true}), "exclusive is not available on This Mac"),
        (json!({"outputs": ["out.txt"]}), "outputs are not available on This Mac"),
        (json!({"service": {"name": "lab", "port": 8080}}), "service is not available on a macOS Core in this version"),
        (json!({"checkpoint": {"graceSeconds": 10, "stoppedExitCode": 75}}), "Stop at a checkpoint is not available on a macOS Core"),
    ] {
        let error = lab.call(Some("a"), "job_submit", job(&lab, "refused", "true", extra.clone())).await.unwrap_err().to_string();
        assert!(error.contains(refusal), "{extra}: {error}");
    }
    // A run's stages and a checkpoint's resume need a Linux host's Jobs.
    let run = json!({"requestId":"run","taskId":"T-1","name":"Run","stages":[{"key":"prep","cwd":lab.work,"argv":["/usr/bin/true"],
        "resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0}}]});
    let error = lab.call(Some("a"), "job_run_submit", run).await.unwrap_err().to_string();
    assert_eq!(error, host::local_host(&lab.data).unwrap_err().to_string());
    assert!(error.starts_with("Runs of stages and checkpoints need Linux with a systemd user manager, and this Core runs on macOS"), "{error}");
    assert_eq!(lab.saved_jobs(), before, "nothing saved for them");
    // The budget is this Mac's to read and change; it says the Mac is here.
    let view = lab.call(None, "job_budget", json!({})).await.unwrap();
    assert_eq!(view["mac"], json!({"available": true, "limits": "declared"}));
    assert_eq!(view["queuedCount"], 3, "{view}");
    let saved = set_budget(AppState(lab.ws.clone()), Json(BudgetSave { cpu_millis: 4000, memory_mi_b: 4096, swap_mi_b: 0, max_active: None })).await;
    assert!(saved.is_ok());
    assert_eq!(lab.call(None, "job_budget", json!({})).await.unwrap()["budget"], json!({"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}));
}

#[tokio::test]
async fn this_macs_jobs_take_this_cores_budget_and_its_max_active() {
    let lab = lab();
    let s = &lab.ws.store;
    s.set_job_budget_with(Resources { cpu_millis: 1000, memory_mi_b: 1024, swap_mi_b: 0 }, Some(Some(1))).unwrap();
    // More than the whole budget: refused at submit, never queued.
    let error = lab.call(Some("a"), "job_submit", job(&lab, "huge", "true", json!({"resources":{"cpuMillis":2000,"memoryMiB":128,"swapMiB":0}})))
        .await.unwrap_err().to_string();
    assert!(error.contains("Job can never fit this Mac's Jobs budget"), "{error}");
    let first = lab.call(Some("a"), "job_submit", job(&lab, "first", "true", json!({}))).await.unwrap();
    let second = lab.call(Some("a"), "job_submit", job(&lab, "second", "true", json!({}))).await.unwrap();
    let id = |job: &Value| job["id"].as_str().unwrap().to_owned();
    assert!(s.reserve_remote(&id(&first)).unwrap().is_some());
    // maxActive is 1, and the first holds it.
    assert!(s.reserve_remote(&id(&second)).unwrap().is_none());
    assert_eq!(lab.job(&second)["reason"], "Waiting for a slot on This Mac: 1 of its 1 Jobs at once (maxActive) in use");
    let view = lab.call(None, "job_budget", json!({})).await.unwrap();
    assert_eq!((view["activeCount"].as_i64(), view["queuedCount"].as_i64()), (Some(1), Some(1)), "{view}");
    assert_eq!(view["reserved"], json!({"cpuMillis":600,"memoryMiB":192,"swapMiB":0}), "with its supervisor");
    // Room for two at once, but not in the budget: the second waits for it.
    s.set_job_budget_with(Resources { cpu_millis: 1000, memory_mi_b: 1024, swap_mi_b: 0 }, Some(Some(4))).unwrap();
    assert!(s.reserve_remote(&id(&second)).unwrap().is_none());
    assert_eq!(lab.job(&second)["reason"],
        "Waiting for this Mac's Jobs budget: needs 600 mCPU / 192 MiB RAM / 0 MiB swap including its supervisor; 400 mCPU / 832 MiB RAM / 0 MiB swap free");
    // What a Job on This Mac is told, and why it cannot be paused.
    let capabilities = remote::mac_capabilities();
    assert_eq!((capabilities["executor"].as_str(), capabilities["platform"].as_str(), capabilities["gpu"].as_str()), (Some("mac"), Some("macOS"), Some("unavailable")));
    assert!(capabilities.get("slots").is_none(), "its slots are this Core's maxActive");
    assert_eq!(remote::pause_refusal(&lab.job(&first)).unwrap(),
        "Pause is not available for jobs on This Mac: macOS gives an attempt no scope of its own (it has no cgroup), and pause freezes only an attempt's own scope; nothing was changed");
}

/// The helper takes a data root with spaces inside a name, as a Mac's
/// "Application Support", and none at either end of one.
#[tokio::test]
async fn the_helper_takes_a_data_root_with_spaces_inside_a_name_but_not_at_either_end() {
    use std::io::Write;
    let lab = lab();
    let hello = |root: &str| {
        let mut child = std::process::Command::new(&lab.python)
            .arg("-c")
            .arg(HELPER)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let nonce = "0123456789abcdef0123456789abcdef";
        let request = json!({"action": "hello", "root": root, "replyNonce": nonce});
        child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        let reply = text.lines().find_map(|line| line.strip_prefix(&format!("YUZUNO-JOBS-REPLY {nonce} "))).unwrap().to_owned();
        (out.status.code(), serde_json::from_str::<Value>(&reply).unwrap())
    };
    for root in ["/srv/Application Support/yuzuno/local-jobs", "/srv/two  spaces/data", "/srv/plain/data"] {
        let (code, reply) = hello(root);
        assert_eq!((code, reply["root"].as_str()), (Some(0), Some(root)), "{root}: {reply}");
    }
    for root in ["/srv/ leading/data", "/srv/trailing /data", "/srv/ /data"] {
        let (code, reply) = hello(root);
        assert_eq!(code, Some(3), "{root}: {reply}");
        assert!(reply["error"].as_str().unwrap().starts_with("root must be ~/<folder> or an absolute folder of plain names"), "{reply}");
    }
}

/// This Mac's facts, as a macOS Core reads them for its Jobs budget.
#[cfg(target_os = "macos")]
#[tokio::test]
async fn this_macs_budget_comes_from_the_mac_itself() {
    let info = host::machine_info().await.unwrap();
    let (cpus, total) = (info["logicalCpus"].as_u64().unwrap(), info["memoryTotalMiB"].as_u64().unwrap());
    assert!(cpus > 0 && total > 1024, "{info}");
    let id = info["id"].as_str().unwrap();
    assert!(id.starts_with("local-") && id.len() == 6 + 64, "{info}");
    assert_eq!(info["bootId"].as_str().map(str::len), Some(36), "{info}");
    assert!(info["memoryAvailableMiB"].is_null(), "{info}");
    assert_eq!(info["suggestedBudget"], json!(host::budget_defaults(cpus, total).0));
    // The same machine and boot each time.
    let again = host::machine_info().await.unwrap();
    assert_eq!((&again["id"], &again["bootId"]), (&info["id"], &info["bootId"]));
    // A Workspace with no budget saved yet starts from it.
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    assert_eq!(local_budget_default(&ws).await.unwrap(), Some(info["suggestedBudget"].clone()));
}
