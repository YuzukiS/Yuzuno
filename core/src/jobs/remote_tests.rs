//! The remote Linux executor (remote.rs, remote_job.py) end to end through
//! its own reconciliation tick, over stand-ins for OpenSSH that run the
//! remote command on this host with a private HOME and machine identity:
//! one that answers, one that cannot connect, one whose start reply is lost
//! after the start ran, one that loses a start before it arrives, one whose
//! name now reaches another machine, one on a machine that restarted, and
//! accounts whose login script prints to stdout or forges replies, or that
//! have no usable python3.
use super::*;
use crate::{model::AgentDetail, remote::RemoteMachine};
use std::path::PathBuf;

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    work: PathBuf,
    ssh: String,
    down: String,
    lossy: String,
    dropping: String,
    other: String,
    rebooted: String,
    /// The account's login script prints to stdout before the command runs.
    banner: String,
    /// The machine has no python3.
    nopython: String,
    /// Its python3 is too old for the helper.
    oldpython: String,
    /// A login script prints forged replies and the helper never runs.
    forged: String,
    /// The helper is killed there (exit 137).
    crashy: String,
}

impl Drop for Lab {
    fn drop(&mut self) {
        // No command of a failed test is left running: what is left of each
        // attempt's group, checked as the helper checks it, in any root.
        for entry in walk(&self.dir.path().join("home")) {
            if entry.ends_with("started.json") {
                let Ok(started) = std::fs::read_to_string(&entry) else { continue };
                let Ok(started) = serde_json::from_str::<Value>(&started) else { continue };
                for pid in members(&started) {
                    let _ = std::process::Command::new("kill")
                        .args(["-KILL", &pid.to_string()])
                        .stderr(std::process::Stdio::null())
                        .status();
                }
            }
        }
    }
}

/// Live processes of a recorded process group: same group and session,
/// started no earlier than its leader.
fn members(started: &Value) -> Vec<i64> {
    let (Some(pgid), Some(birth)) = (started["pgid"].as_i64(), started["starttime"].as_u64()) else {
        return Vec::new();
    };
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let pid: i64 = entry.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let fields: Vec<&str> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
            let live = !matches!(fields[0], "Z" | "X");
            let (group, session, start) = (fields[2].parse::<i64>().ok()?, fields[3].parse::<i64>().ok()?, fields[19].parse::<u64>().ok()?);
            (live && group == pgid && session == pgid && start >= birth).then_some(pid)
        })
        .collect()
}

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(walk(&path));
        } else {
            found.push(path);
        }
    }
    found
}

fn script(path: PathBuf, body: String) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

/// Skip ssh's options and the destination; what is left is the remote command.
const ARGS: &str = "while [ $# -gt 0 ]; do case \"$1\" in -T) shift;; -o) shift 2;; *) break;; esac; done\nshift\n";

fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let (home, work) = (dir.path().join("home"), dir.path().join("work"));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    // This PC's budget, which its Windows jobs hold too (job_submit stores the
    // host's suggested one before a first Windows job).
    ws.store.set_job_budget(Resources { cpu_millis: 8000, memory_mi_b: 16384, swap_mi_b: 0 }).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Remote research","status":"doing"}))
        .unwrap();
    ws.store
        .add_machine(&RemoteMachine {
            id: "m1".into(),
            name: "lab box".into(),
            target: "lab-box".into(),
            codex: "codex".into(),
            default_cwd: work.to_string_lossy().into_owned(),
            limit_mode: Some("limited".into()),
            ..Default::default()
        })
        .unwrap();
    let path = |name: &str| dir.path().join(name);
    std::fs::write(path("machine-a"), "0123456789abcdef0123456789abcdef\n").unwrap();
    std::fs::write(path("machine-b"), "fedcba9876543210fedcba9876543210\n").unwrap();
    std::fs::write(path("boot-b"), format!("{}\n", uuid::Uuid::new_v4())).unwrap();
    // What the account can enforce there: nothing (no systemd user manager),
    // whatever this host has; the lab machine runs in the limited mode.
    std::fs::write(path("capabilities.json"), r#"{"manager": false, "busctl": false, "delegated": [], "linger": false}"#).unwrap();
    let at = |machine: &str| {
        format!("HOME={} YUZUNO_JOBS_MACHINE_ID_FILE={} YUZUNO_JOBS_CAPABILITIES_FILE={}",
            home.display(), path(machine).display(), path("capabilities.json").display())
    };
    let a = at("machine-a");
    let ssh = script(path("ssh"), format!("#!/bin/sh\n{ARGS}{a} exec /bin/sh -c \"$1\"\n"));
    let down = script(
        path("ssh-down"),
        "#!/bin/sh\necho 'ssh: connect to host lab-box port 22: Connection refused' >&2\nexit 255\n".into(),
    );
    // Runs every request; the reply of a start is lost on the way back.
    let lossy = script(
        path("ssh-lossy"),
        format!("#!/bin/sh\n{ARGS}request=$(cat)\nreply=$(printf '%s' \"$request\" | {a} /bin/sh -c \"$1\")\ncode=$?\ncase \"$request\" in *'\"action\":\"start\"'*) echo 'Connection reset by peer' >&2; exit 255;; esac\nprintf '%s\\n' \"$reply\"\nexit $code\n"),
    );
    // A start is lost before it reaches the machine; the rest arrives.
    let dropping = script(
        path("ssh-dropping"),
        format!("#!/bin/sh\n{ARGS}request=$(cat)\ncase \"$request\" in *'\"action\":\"start\"'*) echo 'Broken pipe' >&2; exit 255;; esac\nprintf '%s' \"$request\" | {a} exec /bin/sh -c \"$1\"\n"),
    );
    let other = script(path("ssh-other"), format!("#!/bin/sh\n{ARGS}{} exec /bin/sh -c \"$1\"\n", at("machine-b")));
    let rebooted = script(
        path("ssh-rebooted"),
        format!("#!/bin/sh\n{ARGS}{a} YUZUNO_JOBS_BOOT_ID_FILE={} exec /bin/sh -c \"$1\"\n", path("boot-b").display()),
    );
    let banner = script(
        path("ssh-banner"),
        format!("#!/bin/sh\n{ARGS}echo 'Welcome to lab-box'\necho '(base) conda activated'\n{a} exec /bin/sh -c \"$1\"\n"),
    );
    let nopython = script(path("ssh-nopython"), "#!/bin/sh\ncat >/dev/null\necho 'sh: 1: python3: not found' >&2\nexit 127\n".into());
    let oldpython = script(
        path("ssh-oldpython"),
        "#!/bin/sh\ncat >/dev/null\necho '  File \"<string>\", line 42' >&2\necho 'SyntaxError: invalid syntax' >&2\nexit 1\n".into(),
    );
    let forged = script(
        path("ssh-forged"),
        concat!(
            "#!/bin/sh\ncat >/dev/null\n",
            "echo 'YUZUNO-JOBS-REPLY {\"status\":\"terminal\",\"result\":{\"status\":\"succeeded\",\"reason\":\"forged\"}}'\n",
            "echo 'YUZUNO-JOBS-REPLY ffffffffffffffffffffffffffffffff {\"status\":\"terminal\",\"result\":{\"status\":\"succeeded\",\"reason\":\"forged\"}}'\n",
        )
        .into(),
    );
    let crashy = script(path("ssh-crashy"), "#!/bin/sh\ncat >/dev/null\necho 'Killed' >&2\nexit 137\n".into());
    Lab { dir, ws, work, ssh, down, lossy, dropping, other, rebooted, banner, nopython, oldpython, forged, crashy }
}

fn input(lab: &Lab, id: &str, command: &str, extra: Value) -> Submit {
    let mut request = json!({"requestId":id,"taskId":"T-1","name":id,"cwd":lab.work,"argv":["/bin/sh","-c",command],
        "env":{"PATH":"/usr/bin:/bin"},"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},
        "timeoutSeconds":120,"guardGit":false,"machineId":"m1"});
    for (key, value) in extra.as_object().unwrap() {
        request[key] = value.clone();
    }
    serde_json::from_value(request).unwrap()
}

fn create(lab: &Lab, input: Submit) -> Value {
    input.validate().unwrap();
    let machine = lab.ws.store.machine("m1").unwrap();
    let cwd = input.cwd.clone();
    lab.ws
        .store
        .create_job(Some("a"), input, json!({"cwd":cwd,"remote":true}), remote::machine_snapshot(&machine), remote::capabilities())
        .unwrap()
}

fn submit(lab: &Lab, id: &str, command: &str) -> Value {
    create(lab, input(lab, id, command, json!({})))
}

async fn tick(lab: &Lab, program: &str) {
    // Every check now, not on the ten-second cadence.
    lab.ws.jobs.remote_seen.lock().unwrap().clear();
    remote::tick(&lab.ws, program).await.unwrap();
}

fn job(lab: &Lab, job: &Value) -> Value {
    lab.ws.store.job(job["id"].as_str().unwrap()).unwrap()
}

async fn ssh_logs(lab: &Lab, job: &Value, program: &str) -> anyhow::Result<Value> {
    remote::logs_with(&lab.ws, job, None, &remote::Programs { ssh: program, windows: None }).await
}

fn cancel(lab: &Lab, of: &Value) {
    lab.ws.store.request_job_cancel(Some("a"), of["id"].as_str().unwrap()).unwrap();
}

async fn until(lab: &Lab, program: &str, of: &Value, done: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..100 {
        tick(lab, program).await;
        let now = job(lab, of);
        if done(&now) {
            return now;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no settled state: {}", job(lab, of));
}

/// The attempt's folder on the stand-in machine: under the root it was sent
/// to, or the machine's default before it was sent.
fn folder(lab: &Lab, of: &Value) -> PathBuf {
    let now = job(lab, of);
    let root = now["remote"]["root"].as_str().unwrap_or(crate::remote::DEFAULT_ROOT);
    in_home(lab, root).join("jobs").join(of["id"].as_str().unwrap()).join(of["attempt"].as_str().unwrap())
}

/// A root on the stand-in machine: `~/` is its home.
fn in_home(lab: &Lab, root: &str) -> PathBuf {
    match root.strip_prefix("~/") {
        Some(rest) => lab.dir.path().join("home").join(rest),
        None => PathBuf::from(root),
    }
}

fn read(path: PathBuf) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

async fn pid_in(lab: &Lab, name: &str) -> i32 {
    for _ in 0..50 {
        if let Ok(text) = std::fs::read_to_string(lab.work.join(name)) {
            if let Ok(pid) = text.trim().parse() {
                return pid;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{name} was not written");
}

/// Running: present and not a zombie waiting to be reaped.
fn alive(pid: i64) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|stat| stat.rsplit_once(") ").map(|(_, rest)| !rest.starts_with(['Z', 'X'])))
        .unwrap_or(false)
}

async fn gone(pid: i64) -> bool {
    for _ in 0..50 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

fn starts(lab: &Lab) -> usize {
    std::fs::read_to_string(lab.work.join("runs.txt")).map(|text| text.lines().count()).unwrap_or(0)
}

#[tokio::test]
async fn a_remote_job_runs_there_once_and_its_outcome_and_output_come_from_the_machine() {
    let lab = lab();
    // With no remote job a pass reports so, and the loop waits to be woken.
    assert!(!remote::tick(&lab.ws, &lab.ssh).await.unwrap());
    let first = submit(&lab, "first", "echo begin; echo once >> runs.txt; sleep 1; echo end");
    assert_eq!(first["executor"], json!({"kind":"ssh","machineId":"m1","machineName":"lab box"}));
    assert_eq!(first["capabilities"]["gpu"], "unavailable");
    tick(&lab, &lab.ssh).await;
    let running = job(&lab, &first);
    assert_eq!(running["status"], "running", "{running}");
    assert!(running["reason"].as_str().unwrap().starts_with("Running on lab box in its own process group"));
    // Pinned to the machine that answered, with the request digest, before the start.
    let remote = &running["remote"];
    assert_eq!(remote["hostId"].as_str().unwrap().len(), 32);
    assert_eq!(remote["acknowledged"], true);
    let intent = read(folder(&lab, &first).join("intent.json"));
    assert_eq!(intent["hostId"], remote["hostId"]);
    assert_eq!(intent["digest"], remote["digest"]);
    assert_eq!(intent["workspaceKey"], json!(lab.ws.store.workspace_id().unwrap()));
    assert_eq!(intent["machineId"], "m1");
    assert!(remote::tick(&lab.ws, &lab.ssh).await.unwrap(), "a job holds a slot: keep checking");
    let done = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!((done["status"].as_str(), done["result"]["evidence"]["result"]["exitCode"].as_i64()), (Some("succeeded"), Some(0)));
    assert_eq!(starts(&lab), 1);
    assert!(!remote::tick(&lab.ws, &lab.ssh).await.unwrap(), "nothing left: idle again");
    let log = ssh_logs(&lab, &done, &lab.ssh).await.unwrap();
    assert_eq!(log["text"], "begin\nend\n");
    assert!(log.get("hostId").is_none());
}

#[tokio::test]
async fn a_machine_with_its_own_data_root_keeps_every_attempt_there_and_writes_nothing_else() {
    let lab = lab();
    std::fs::create_dir(lab.dir.path().join("home/jobs-lab")).unwrap();
    let machine = RemoteMachine { data_root: Some("~/jobs-lab/.yuzuno".into()), ..lab.ws.store.machine("m1").unwrap() };
    lab.ws.store.update_machine(&machine).unwrap();
    let first = submit(&lab, "rooted", "echo begin; echo once >> runs.txt; echo end");
    let done = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(done["status"], "succeeded", "{done}");
    // Pinned with the machine: the absolute folder its helper resolved.
    assert_eq!(done["remote"]["root"].as_str().map(PathBuf::from), Some(in_home(&lab, "~/jobs-lab/.yuzuno")));
    let attempt = in_home(&lab, "~/jobs-lab/.yuzuno").join("jobs").join(first["id"].as_str().unwrap()).join(first["attempt"].as_str().unwrap());
    assert!(attempt.join("intent.json").is_file() && attempt.join("result.json").is_file());
    assert_eq!(ssh_logs(&lab, &done, &lab.ssh).await.unwrap()["text"], "begin\nend\n");
    let home: Vec<_> = std::fs::read_dir(lab.dir.path().join("home")).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(home, ["jobs-lab"], "nothing in the home folder outside that root");
    // A root whose parent does not exist there: refused before anything starts.
    lab.ws.store.update_machine(&RemoteMachine { data_root: Some("~/missing/.yuzuno".into()), ..machine }).unwrap();
    let refused = submit(&lab, "parentless", "echo once >> runs.txt");
    let ended = until(&lab, &lab.ssh, &refused, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert!(ended["reason"].as_str().unwrap().contains("the data root's parent must exist"), "{ended}");
    assert!(!lab.dir.path().join("home/missing").exists());
    assert_eq!(starts(&lab), 1);
    // A request without a usable root is refused by the helper itself.
    let mut request = remote::bound_for_tests(&done, &lab.ws.store.workspace_id().unwrap(), "status");
    for bad in [json!("~/../x"), Value::Null] {
        request["root"] = bad.clone();
        let reply = remote::invoke(&lab.ssh, &lab.ws.store.machine("m1").unwrap(), request.clone()).await;
        assert!(matches!(&reply, remote::Reply::Refused(why) if why.contains("root must")), "{bad}: {reply:?}");
    }
}

#[tokio::test]
async fn an_attempt_sent_before_roots_were_recorded_is_still_found_in_the_legacy_root() {
    let lab = lab();
    // As an older Core left it: started in ~/.yuzuno-next, no root recorded.
    let machine = lab.ws.store.machine("m1").unwrap();
    lab.ws.store.update_machine(&RemoteMachine { data_root: Some(crate::remote::LEGACY_ROOT.into()), ..machine.clone() }).unwrap();
    let first = submit(&lab, "legacy", "echo begin; echo once >> runs.txt; sleep 60");
    until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    let id = first["id"].as_str().unwrap();
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE local_jobs SET data=json_remove(data,'$.remote.root') WHERE id=?1", [id]).unwrap();
    lab.ws.store.update_machine(&machine).unwrap();
    assert!(job(&lab, &first)["remote"]["root"].is_null());
    assert_eq!(remote::attempt_root(&job(&lab, &first)), crate::remote::LEGACY_ROOT);
    // Checked there: still running, never absent, fenced or started again.
    tick(&lab, &lab.ssh).await;
    let checked = job(&lab, &first);
    assert_eq!(checked["status"], "running", "{checked}");
    cancel(&lab, &first);
    let cancelled = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(cancelled["status"], "cancelled", "{cancelled}");
    assert_eq!(ssh_logs(&lab, &cancelled, &lab.ssh).await.unwrap()["text"], "begin\n");
    assert_eq!(starts(&lab), 1);
    let legacy = in_home(&lab, crate::remote::LEGACY_ROOT).join("jobs").join(id).join(first["attempt"].as_str().unwrap());
    assert!(legacy.join("result.json").is_file());
    assert!(!in_home(&lab, crate::remote::DEFAULT_ROOT).exists(), "nothing of it in the new root");
    // A job sent now goes to the machine's root, the default.
    let next = submit(&lab, "next", "true");
    let done = until(&lab, &lab.ssh, &next, |j| j["reserved"] == false).await;
    assert_eq!(done["remote"]["root"].as_str().map(PathBuf::from), Some(in_home(&lab, crate::remote::DEFAULT_ROOT)));
    assert!(folder(&lab, &next).join("result.json").is_file());
    // Pinned by an older Core, sent by this one: the machine's root as configured.
    let pinned = submit(&lab, "pinned", "true");
    let id = pinned["id"].as_str().unwrap();
    let reserved = lab.ws.store.reserve_remote(id).unwrap().unwrap();
    let hello = remote::invoke(&lab.ssh, &machine, json!({"action": "hello"})).await;
    let remote::Reply::Answer(hello) = hello else { panic!("{hello:?}") };
    assert!(hello.get("root").is_none(), "no root asked, none reported");
    lab.ws.store.remote_note(id, &reserved["attempt"], json!({"hostId": hello["hostId"], "digest": remote::digest(&remote::spec(&reserved))}), None).unwrap();
    let done = until(&lab, &lab.ssh, &pinned, |j| j["reserved"] == false).await;
    assert_eq!((done["status"].as_str(), done["remote"]["root"].as_str()), (Some("succeeded"), Some(crate::remote::DEFAULT_ROOT)), "{done}");
}

#[tokio::test]
async fn a_remote_job_takes_its_machine_as_registered_when_it_is_inserted_and_starts_nowhere_else() {
    let lab = lab();
    // The submission read the machine before; it is removed before the insert.
    let stale = remote::machine_snapshot(&lab.ws.store.machine("m1").unwrap());
    let saved: String = lab.ws.store.db.read().unwrap().query_row("SELECT data FROM machines WHERE id='m1'", [], |r| r.get(0)).unwrap();
    lab.ws.store.db.write().unwrap().execute("DELETE FROM machines WHERE id='m1'", []).unwrap();
    let request = input(&lab, "late", "echo once >> runs.txt", json!({}));
    let error = lab
        .ws
        .store
        .create_job(Some("a"), request, json!({"cwd":lab.work,"remote":true}), stale, remote::capabilities())
        .unwrap_err()
        .to_string();
    assert!(error.contains("machineId is not a registered SSH machine"), "{error}");
    assert_eq!(lab.ws.store.list_jobs(None, None, None).unwrap()["jobs"].as_array().unwrap().len(), 0, "nothing was queued");
    lab.ws.store.db.write().unwrap().execute("INSERT INTO machines(id,data) VALUES('m1',?1)", [&saved]).unwrap();
    // Accepted, it records the SSH destination it was accepted for; a new
    // destination before anything was sent ends it unstarted, never there.
    let first = submit(&lab, "moved", "echo once >> runs.txt");
    assert_eq!(first["machine"]["target"], "lab-box");
    lab.ws
        .store
        .db
        .write()
        .unwrap()
        .execute("UPDATE machines SET data=json_set(data,'$.target','other-box') WHERE id='m1'", [])
        .unwrap();
    let ended = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert!(ended["reason"].as_str().unwrap().contains("SSH destination changed after this job was submitted"), "{ended}");
    assert!(ended["remote"]["startSentAt"].is_null());
    assert_eq!(starts(&lab), 0);
    assert!(!folder(&lab, &first).exists(), "nothing reached the machine");
}

#[tokio::test]
async fn a_remote_jobs_declared_resources_and_reservation_are_not_this_hosts() {
    let lab = lab();
    lab.ws
        .store
        .set_job_budget(Resources { cpu_millis: 1000, memory_mi_b: 512, swap_mi_b: 0 })
        .unwrap();
    // Far beyond this host's budget: accepted, as it is recorded, not admitted here.
    let big = create(&lab, input(&lab, "big", "sleep 2", json!({"resources":{"cpuMillis":64000,"memoryMiB":262144,"swapMiB":0}})));
    tick(&lab, &lab.ssh).await;
    assert_eq!(job(&lab, &big)["status"], "running");
    // A local job still gets this host's whole budget, and the local scan
    // never picks up a remote job.
    let local: Submit = serde_json::from_value(json!({"requestId":"local","taskId":"T-1","name":"local","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":800,"memoryMiB":256,"swapMiB":0}})).unwrap();
    let local = lab
        .ws
        .store
        .create_job(Some("a"), local, json!({"cwd":"/workspace"}), json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":1000,"memoryMiB":512,"swapMiB":0}}), json!({"bootId":"boot"}))
        .unwrap();
    let started = lab.ws.store.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(started["id"], local["id"]);
    assert!(lab.ws.store.reserve_next_job(None, None, None).unwrap().is_none());
    // Its working directory is on the machine: this host's disk check skips it.
    assert_eq!(lab.ws.store.live_job_cwds().unwrap(), ["/workspace"]);
    until(&lab, &lab.ssh, &big, |j| j["reserved"] == false).await;
}

#[tokio::test]
async fn a_lost_start_reply_leaves_it_unknown_and_the_same_attempt_is_found_never_started_twice() {
    let lab = lab();
    let first = submit(&lab, "lossy", "echo once >> runs.txt; sleep 2");
    // The machine started it, but the reply never came back.
    tick(&lab, &lab.lossy).await;
    let unknown = job(&lab, &first);
    assert_eq!((unknown["status"].as_str(), unknown["reserved"].as_bool()), (Some("unknown"), Some(true)));
    assert!(unknown["reason"].as_str().unwrap().starts_with("No acknowledgement from lab box for this start"));
    assert!(unknown["remote"]["startSentAt"].is_string());
    assert!(unknown["remote"]["acknowledged"].is_null());
    let running = until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    assert_eq!(running["attempt"], first["attempt"]);
    assert_eq!(running["remote"]["acknowledged"], true);
    until(&lab, &lab.ssh, &first, |j| j["status"] == "succeeded").await;
    assert_eq!(starts(&lab), 1);
}

#[tokio::test]
async fn a_start_that_never_arrived_is_fenced_so_not_started_is_certain() {
    let lab = lab();
    let first = submit(&lab, "dropped", "echo once >> runs.txt");
    tick(&lab, &lab.dropping).await;
    let unknown = job(&lab, &first);
    assert_eq!((unknown["status"].as_str(), unknown["reserved"].as_bool()), (Some("unknown"), Some(true)));
    let rejected = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(rejected["status"], "rejected", "{rejected}");
    assert!(rejected["reason"].as_str().unwrap().contains("the start never reached it"));
    assert!(folder(&lab, &first).join("fenced.json").exists());
    // The same start arriving late is refused: nothing runs.
    let machine = lab.ws.store.machine("m1").unwrap();
    let workspace = lab.ws.store.workspace_id().unwrap();
    let mut late = remote::bound_for_tests(&rejected, &workspace, "start");
    for (key, value) in remote::spec(&rejected).as_object().unwrap() {
        late[key] = value.clone();
    }
    match remote::invoke(&lab.ssh, &machine, late).await {
        remote::Reply::Refused(message) => assert!(message.contains("gave up on this start"), "{message}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(starts(&lab), 0);
}

#[tokio::test]
async fn a_core_that_stopped_between_steps_resumes_without_starting_twice_or_guessing() {
    let lab = lab();
    // Stopped after pinning the machine, before the start left: it is sent now, once.
    let pinned = submit(&lab, "pinned", "echo once >> runs.txt");
    let id = pinned["id"].as_str().unwrap();
    // The reserved job: its slot fixed the machine's mode, which its spec carries.
    let reserved = lab.ws.store.reserve_remote(id).unwrap().unwrap();
    let host = match remote::invoke(&lab.ssh, &lab.ws.store.machine("m1").unwrap(), json!({"action":"hello"})).await {
        remote::Reply::Answer(reply) => reply["hostId"].clone(),
        other => panic!("{other:?}"),
    };
    let digest = remote::digest(&remote::spec(&reserved));
    lab.ws.store.remote_note(id, &pinned["attempt"], json!({"hostId":host,"digest":digest}), None).unwrap();
    // Nothing new starts there while Core drains for an update.
    lab.ws.admission.begin_drain("t108-drain").unwrap();
    tick(&lab, &lab.ssh).await;
    let held = job(&lab, &pinned);
    assert_eq!((held["status"].as_str(), held["remote"]["startSentAt"].is_null()), (Some("starting"), true), "{held}");
    assert_eq!(starts(&lab), 0);
    lab.ws.admission.reopen("t108-drain").unwrap();
    let done = until(&lab, &lab.ssh, &pinned, |j| j["reserved"] == false).await;
    assert_eq!(done["status"], "succeeded", "{done}");
    assert_eq!(starts(&lab), 1);
    // Stopped after recording the start, before it left: never re-sent, and
    // the fenced check shows it was not started.
    let marked = submit(&lab, "marked", "echo again >> runs.txt");
    let id = marked["id"].as_str().unwrap();
    lab.ws.store.reserve_remote(id).unwrap().unwrap();
    lab.ws
        .store
        .remote_note(id, &marked["attempt"], json!({"hostId":host,"digest":digest,"startSentAt":crate::model::now()}), None)
        .unwrap();
    let rejected = until(&lab, &lab.ssh, &marked, |j| j["reserved"] == false).await;
    assert_eq!(rejected["status"], "rejected", "{rejected}");
    assert_eq!(starts(&lab), 1);
}

#[tokio::test]
async fn an_unreachable_machine_keeps_the_slot_is_told_once_and_the_same_attempt_is_checked_again() {
    let lab = lab();
    let first = submit(&lab, "steady", "sleep 3");
    tick(&lab, &lab.ssh).await;
    assert_eq!(job(&lab, &first)["status"], "running");
    tick(&lab, &lab.down).await;
    let unknown = job(&lab, &first);
    assert_eq!((unknown["status"].as_str(), unknown["reserved"].as_bool()), (Some("unknown"), Some(true)));
    assert!(unknown["reason"].as_str().unwrap().starts_with("lab box did not answer"));
    assert!(unknown["result"]["evidence"]["error"].as_str().unwrap().contains("Connection refused"));
    let told = unknown["notifications"]["unknown"].clone();
    assert!(told.is_string());
    tick(&lab, &lab.down).await;
    assert_eq!(job(&lab, &first)["notifications"]["unknown"], told, "told once");
    let again = until(&lab, &lab.ssh, &first, |j| j["status"] != "unknown").await;
    assert!(matches!(again["status"].as_str(), Some("running" | "succeeded")), "{again}");
    until(&lab, &lab.ssh, &first, |j| j["status"] == "succeeded").await;
}

#[tokio::test]
async fn a_name_that_now_reaches_another_machine_never_passes_for_the_attempt_or_releases_it() {
    let lab = lab();
    let first = submit(&lab, "pinned", "sleep 60");
    until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    let leader = read(folder(&lab, &first).join("started.json"))["pid"].as_i64().unwrap();
    tick(&lab, &lab.other).await;
    let unknown = job(&lab, &first);
    assert_eq!((unknown["status"].as_str(), unknown["reserved"].as_bool()), (Some("unknown"), Some(true)));
    assert!(unknown["reason"].as_str().unwrap().starts_with("lab box now reaches a different machine"), "{unknown}");
    // Cancel cannot reach the attempt there: it stays held, and nothing is stopped.
    cancel(&lab, &first);
    tick(&lab, &lab.other).await;
    tick(&lab, &lab.other).await;
    let held = job(&lab, &first);
    assert_eq!((held["status"].as_str(), held["reserved"].as_bool()), (Some("unknown"), Some(true)));
    assert!(alive(leader));
    // The name reaches the machine again: the cancel goes through.
    let cancelled = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(cancelled["status"], "cancelled", "{cancelled}");
    assert!(gone(leader).await);
}

#[tokio::test]
async fn a_dead_supervisor_and_a_child_left_by_the_leader_keep_the_slot_until_cancel_stops_them() {
    let lab = lab();
    let first = submit(&lab, "orphan", "sleep 60 & echo $! > child.pid; while [ ! -e go ]; do sleep 0.05; done");
    until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    let child = pid_in(&lab, "child.pid").await as i64;
    let supervisor = read(folder(&lab, &first).join("supervisor.json"))["pid"].as_i64().unwrap();
    let leader = read(folder(&lab, &first).join("started.json"))["pid"].as_i64().unwrap();
    std::process::Command::new("kill").args(["-KILL", &supervisor.to_string()]).status().unwrap();
    assert!(gone(supervisor).await);
    tick(&lab, &lab.ssh).await;
    let lost = job(&lab, &first);
    assert_eq!((lost["status"].as_str(), lost["reserved"].as_bool()), (Some("unknown"), Some(true)));
    assert!(lost["reason"].as_str().unwrap().contains("its command is still running"), "{lost}");
    let told = lost["notifications"]["unknown"].clone();
    // The leader exits; its sleep child is still there: no outcome, no release.
    std::fs::write(lab.work.join("go"), "").unwrap();
    assert!(gone(leader).await);
    tick(&lab, &lab.ssh).await;
    let left = job(&lab, &first);
    assert_eq!((left["status"].as_str(), left["reserved"].as_bool()), (Some("unknown"), Some(true)));
    assert!(left["reason"].as_str().unwrap().contains("1 process(es) of its group are still running"), "{left}");
    assert!(alive(child));
    tick(&lab, &lab.ssh).await;
    assert_eq!(job(&lab, &first)["reason"], left["reason"]);
    assert!(told.is_string());
    cancel(&lab, &first);
    let cancelled = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(cancelled["status"], "cancelled", "{cancelled}");
    assert!(cancelled["reason"].as_str().unwrap().contains("its supervisor was gone"));
    assert!(gone(child).await);
}

#[tokio::test]
async fn a_restarted_machine_interrupts_the_attempt_and_an_unclear_record_keeps_the_slot() {
    let lab = lab();
    let first = submit(&lab, "reboot", "sleep 60");
    until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    let interrupted = until(&lab, &lab.rebooted, &first, |j| j["reserved"] == false).await;
    assert_eq!(interrupted["status"], "interrupted", "{interrupted}");
    assert!(interrupted["reason"].as_str().unwrap().contains("machine restarted"));
    let unclear = submit(&lab, "unclear", "sleep 60");
    until(&lab, &lab.ssh, &unclear, |j| j["status"] == "running").await;
    std::fs::write(folder(&lab, &unclear).join("intent.json"), "{").unwrap();
    tick(&lab, &lab.ssh).await;
    let held = job(&lab, &unclear);
    assert_eq!((held["status"].as_str(), held["reserved"].as_bool()), (Some("unknown"), Some(true)));
    assert!(held["reason"].as_str().unwrap().contains("record on lab box is unclear"), "{held}");
    cancel(&lab, &unclear);
    tick(&lab, &lab.ssh).await;
    assert_eq!(job(&lab, &unclear)["reserved"], true, "an unclear record is never released");
}

#[tokio::test]
async fn a_record_lost_after_it_was_acknowledged_keeps_the_slot_even_when_cancelled() {
    let lab = lab();
    let first = submit(&lab, "lost", "sleep 60");
    until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    // Its supervisor and command stopped and its folder removed there, by hand.
    let supervisor = read(folder(&lab, &first).join("supervisor.json"))["pid"].as_i64().unwrap();
    std::process::Command::new("kill").args(["-KILL", &supervisor.to_string()]).status().unwrap();
    assert!(gone(supervisor).await);
    let started = read(folder(&lab, &first).join("started.json"));
    for pid in members(&started) {
        std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).status().unwrap();
    }
    std::fs::remove_dir_all(folder(&lab, &first)).unwrap();
    tick(&lab, &lab.ssh).await;
    let lost = job(&lab, &first);
    assert_eq!((lost["status"].as_str(), lost["reserved"].as_bool()), (Some("unknown"), Some(true)));
    assert!(lost["reason"].as_str().unwrap().contains("gone although the machine had acknowledged it"), "{lost}");
    // A cancel is no fence: never "nothing was started", never released.
    cancel(&lab, &first);
    tick(&lab, &lab.ssh).await;
    tick(&lab, &lab.ssh).await;
    let held = job(&lab, &first);
    assert_eq!((held["status"].as_str(), held["reserved"].as_bool()), (Some("unknown"), Some(true)), "{held}");
    assert!(!folder(&lab, &first).exists(), "nothing was written there");
}

#[tokio::test]
async fn cancel_stops_the_attempts_process_tree_on_the_machine() {
    let lab = lab();
    let first = submit(&lab, "tree", "sleep 60 & echo $! > child.pid; sleep 60");
    until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    let child = pid_in(&lab, "child.pid").await as i64;
    cancel(&lab, &first);
    let cancelled = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(cancelled["status"], "cancelled", "{cancelled}");
    assert!(!alive(child), "the backgrounded child of the command is gone too");
    // A cancel before anything was sent there needs no machine at all.
    let early = submit(&lab, "early", "echo never >> runs.txt");
    lab.ws.store.reserve_remote(early["id"].as_str().unwrap()).unwrap().unwrap();
    cancel(&lab, &early);
    let cancelled = until(&lab, &lab.down, &early, |j| j["reserved"] == false).await;
    assert_eq!(cancelled["status"], "cancelled", "{cancelled}");
    assert_eq!(starts(&lab), 0);
}

#[tokio::test]
async fn failures_and_refusals_are_outcomes_and_slots_are_per_machine() {
    let lab = lab();
    let failing = submit(&lab, "failing", "echo DONE; exit 4");
    let done = until(&lab, &lab.ssh, &failing, |j| j["reserved"] == false).await;
    assert_eq!((done["status"].as_str(), done["reason"].as_str()), (Some("failed"), Some("exit-code 4")));
    // An empty later argument, as Core accepts it, reaches the command.
    let empty = create(&lab, input(&lab, "empty", "", json!({"argv":["/bin/sh","-c","printf '[%s]' \"$1\"","sh",""]})));
    let ran = until(&lab, &lab.ssh, &empty, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ran["status"], "succeeded", "{ran}");
    assert_eq!(ssh_logs(&lab, &ran, &lab.ssh).await.unwrap()["text"], "[]");
    // A working directory missing there: refused, nothing started, nothing held.
    let missing = create(&lab, input(&lab, "missing", "true", json!({"cwd":"/nonexistent/folder"})));
    let refused = until(&lab, &lab.ssh, &missing, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(refused["status"], "rejected");
    assert!(refused["reason"].as_str().unwrap().contains("does not exist on this machine"), "{refused}");
    let jobs: Vec<Value> = (0..3).map(|i| submit(&lab, &format!("slot{i}"), "sleep 2")).collect();
    tick(&lab, &lab.ssh).await;
    let states: Vec<String> = jobs.iter().map(|j| job(&lab, j)["status"].as_str().unwrap().to_owned()).collect();
    assert_eq!(states, ["running", "running", "queued"]);
    assert_eq!(job(&lab, &jobs[2])["reason"], "Waiting for a slot on lab box: 2 of 2 in use");
    until(&lab, &lab.ssh, &jobs[2], |j| j["status"] == "succeeded").await;
}

#[tokio::test]
async fn remote_requests_are_checked_and_pause_and_stages_are_unavailable() {
    let lab = lab();
    for (extra, message) in [
        (json!({"gpu":{"memoryMiB":1000}}), "GPU admission is not available"),
        (json!({"exclusive":true}), "exclusive applies to this host"),
        (json!({"guardGit":true}), "set guardGit to false"),
        (json!({"outputs":["a.txt"]}), "on a remote machine they stay there, so declare them as artifacts instead"),
        // On Windows, paths of that PC with its separators (T-108).
        (json!({"machineId":"windows","cwd":"C:\\work","inputs":["..\\a.txt"]}), "inputs on Windows are drive paths"),
        (json!({"machineId":"windows","cwd":"C:\\work","inputs":["\\a.txt"]}), "inputs on Windows are drive paths"),
        (json!({"machineId":"windows","cwd":"C:\\work","inputs":["D:a.txt"]}), "inputs on Windows are drive paths"),
        (json!({"machineId":"windows","cwd":"C:\\work","artifacts":[{"path":"C:\\a.json"}]}), "artifacts on Windows are paths relative to cwd"),
        (json!({"machineId":"windows","cwd":"C:\\work","artifacts":[{"path":"out\\..\\..\\a.json"}]}), "artifacts on Windows are paths relative to cwd"),
        (json!({"machineId":"windows","cwd":"C:\\work","artifacts":[{"path":"a.json:stream"}]}), "artifacts on Windows are paths relative to cwd"),
    ] {
        let error = input(&lab, "bad", "true", extra).validate().unwrap_err().to_string();
        assert!(error.contains(message), "{error}");
    }
    // On an SSH machine inputs and artifacts are files there (T-108).
    input(&lab, "ok", "true", json!({"inputs":["a.txt"],"artifacts":[{"path":"a.json","format":"json"}]})).validate().unwrap();
    // And on Windows, files of that PC.
    input(&lab, "ok", "true", json!({"machineId":"windows","cwd":"C:\\work","inputs":["a.txt","data\\b.bin","D:\\shared\\c.txt"],
        "artifacts":[{"path":"out\\result.json","format":"json"},{"path":"out/lines.jsonl","format":"jsonl"}]})).validate().unwrap();
    let run: runs::RunSubmit = serde_json::from_value(json!({"requestId":"run","taskId":"T-1","name":"Remote run",
        "stages":[{"key":"a","cwd":"/workspace","argv":["/usr/bin/true"],"machineId":"m1",
            "resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0}}]}))
    .unwrap();
    let error = run.validate().unwrap_err().to_string();
    assert!(error.contains("machineId (a remote machine) is not available for runs of stages"), "{error}");
    let first = submit(&lab, "pausable", "sleep 5");
    until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    // No scope of its own on this machine (the lab's account holds nothing).
    let error = lab.ws.store.request_job_pause(first["id"].as_str().unwrap(), false).unwrap_err().to_string();
    assert!(error.starts_with("Pause is not available for this job on lab box: it runs without a scope of its own there"), "{error}");
    cancel(&lab, &first);
    until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
}

#[tokio::test]
async fn machine_edits_and_removal_wait_for_the_remote_jobs_that_run_there() {
    let lab = lab();
    let first = submit(&lab, "guarded", "sleep 3");
    let moved = || RemoteMachine { target: "other-box".into(), ..lab.ws.store.machine("m1").unwrap() };
    // Queued, then running: neither removed nor pointed elsewhere (T-111's
    // guards, which count jobs by executor.machineId).
    for state in ["queued", "running"] {
        if state == "running" {
            until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
        }
        assert_eq!(job(&lab, &first)["status"], state);
        let error = lab.ws.store.remove_machine("m1").unwrap_err().to_string();
        assert!(error.contains("Jobs still run on this machine"), "{state}: {error}");
        let error = lab.ws.store.update_machine(&moved()).unwrap_err().to_string();
        assert!(error.contains("change its SSH destination once they finish"), "{state}: {error}");
    }
    // A new name is fine; the job keeps the name it was accepted with.
    lab.ws.store.update_machine(&RemoteMachine { name: "lab box 2".into(), ..lab.ws.store.machine("m1").unwrap() }).unwrap();
    // Unknown (the machine does not answer) still holds the machine.
    tick(&lab, &lab.down).await;
    assert_eq!(job(&lab, &first)["status"], "unknown");
    assert!(lab.ws.store.remove_machine("m1").unwrap_err().to_string().contains("Jobs still run on this machine"));
    let done = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(done["status"], "succeeded", "{done}");
    // Finished: the machine can change and go; a later submission is refused
    // in its own insert transaction.
    lab.ws.store.update_machine(&moved()).unwrap();
    lab.ws.store.remove_machine("m1").unwrap();
    let error = lab
        .ws
        .store
        .create_job(Some("a"), input(&lab, "after", "true", json!({})), json!({"cwd":lab.work,"remote":true}), Value::Null, remote::capabilities())
        .unwrap_err()
        .to_string();
    assert!(error.contains("not a registered SSH machine"), "{error}");
}

#[tokio::test]
async fn a_machine_that_cannot_run_the_helper_is_not_started() {
    let lab = lab();
    // No python3, or one too old for the helper: final at hello, nothing sent.
    for (name, program) in [("nopython", &lab.nopython), ("oldpython", &lab.oldpython)] {
        let refused = submit(&lab, name, "echo never >> runs.txt");
        let ended = until(&lab, program, &refused, |j| j["reserved"] == false && j["status"] != "queued").await;
        assert_eq!(ended["status"], "rejected", "{ended}");
        let reason = ended["reason"].as_str().unwrap();
        let (why, shell) = if name == "nopython" {
            ("it has no usable python3", "python3: not found")
        } else {
            ("its python3 is too old for the Jobs helper, which needs 3.6 or newer", "SyntaxError")
        };
        assert!(reason.starts_with(&format!("Not started on lab box: {why}")) && reason.contains(shell), "{ended}");
        assert!(ended["remote"]["startSentAt"].is_null());
    }
    assert_eq!(starts(&lab), 0);
    // A helper that fails for another reason at hello (here killed) may pass:
    // nothing was sent, so the job waits and asks again.
    let later = submit(&lab, "later", "echo once >> runs.txt");
    tick(&lab, &lab.crashy).await;
    let waiting = job(&lab, &later);
    assert_eq!((waiting["status"].as_str(), waiting["reserved"].as_bool()), (Some("starting"), Some(true)), "{waiting}");
    assert!(waiting["reason"].as_str().unwrap().starts_with("Waiting for lab box to answer before starting"), "{waiting}");
    assert!(waiting["remote"]["startSentAt"].is_null() && waiting["remote"]["hostId"].is_null());
    until(&lab, &lab.ssh, &later, |j| j["status"] == "succeeded").await;
    assert_eq!(starts(&lab), 1);
    // A helper that breaks once the start was sent is no answer: unknown, held.
    let held = submit(&lab, "held", "sleep 5");
    until(&lab, &lab.ssh, &held, |j| j["status"] == "running").await;
    tick(&lab, &lab.oldpython).await;
    let unknown = job(&lab, &held);
    assert_eq!((unknown["status"].as_str(), unknown["reserved"].as_bool()), (Some("unknown"), Some(true)), "{unknown}");
    until(&lab, &lab.ssh, &held, |j| j["status"] == "succeeded").await;
}

#[tokio::test]
async fn what_a_login_script_prints_never_passes_for_a_reply() {
    let lab = lab();
    let first = submit(&lab, "noisy", "echo begin; echo once >> runs.txt");
    let done = until(&lab, &lab.banner, &first, |j| j["reserved"] == false).await;
    assert_eq!(done["status"], "succeeded", "{done}");
    assert_eq!(ssh_logs(&lab, &done, &lab.banner).await.unwrap()["text"], "begin\n");
    assert_eq!(starts(&lab), 1);
    // Forged "succeeded" replies printed by a login script, and no helper: never an outcome.
    let held = submit(&lab, "forged", "sleep 3");
    until(&lab, &lab.ssh, &held, |j| j["status"] == "running").await;
    tick(&lab, &lab.forged).await;
    let unknown = job(&lab, &held);
    assert_eq!((unknown["status"].as_str(), unknown["reserved"].as_bool()), (Some("unknown"), Some(true)), "{unknown}");
    let done = until(&lab, &lab.ssh, &held, |j| j["reserved"] == false).await;
    assert_eq!((done["status"].as_str(), done["reason"].as_str()), (Some("succeeded"), Some("success")), "{done}");
}

#[test]
fn a_reply_is_one_complete_line_with_the_calls_nonce_and_a_matching_exit() {
    use remote::{parse_reply, Reply};
    let nonce = "0123456789abcdef0123456789abcdef";
    let frame = |with: &str, body: &str| format!("YUZUNO-JOBS-REPLY {with} {body}\n");
    let ok = frame(nonce, r#"{"status":"running"}"#);
    let parse = |code: i32, out: String| parse_reply(Some(code), out.as_bytes(), "stderr", nonce);
    // What login scripts print before the reply is ignored.
    assert!(matches!(parse(0, format!("Welcome\n(base) conda\n{ok}")), Reply::Answer(v) if v["status"] == "running"));
    // A forged line, unmarked by this call's nonce, is never a reply and never displaces it.
    let other = frame("ffffffffffffffffffffffffffffffff", r#"{"status":"terminal"}"#);
    for forged in [String::from("YUZUNO-JOBS-REPLY {\"status\":\"terminal\"}\n"), other] {
        assert!(matches!(parse(0, forged.clone()), Reply::Broken(_)), "{forged}");
        assert!(matches!(parse(0, forged.clone() + &ok), Reply::Answer(v) if v["status"] == "running"), "{forged}");
        assert!(matches!(parse(0, ok.clone() + &forged), Reply::Answer(v) if v["status"] == "running"), "{forged}");
    }
    // Two replies, a cut-off last line, JSON cut short or not an object: none.
    assert!(matches!(parse(0, ok.clone() + &ok), Reply::Broken(m) if m.contains("more than one reply")));
    assert!(matches!(parse(0, ok.trim_end().to_owned()), Reply::Broken(_)));
    assert!(matches!(parse(0, frame(nonce, r#"{"status":"run"#)), Reply::Broken(_)));
    assert!(matches!(parse(0, frame(nonce, "[1]")), Reply::Broken(_)));
    // The exit status must match: an answer only with 0, a refusal only with 3.
    let refusal = frame(nonce, r#"{"error":"nothing was started"}"#);
    assert!(matches!(parse(3, refusal.clone()), Reply::Refused(m) if m == "nothing was started"));
    assert!(matches!(parse(0, refusal), Reply::Broken(_)));
    assert!(matches!(parse(3, ok.clone()), Reply::Broken(_)));
    assert!(matches!(parse(1, ok.clone()), Reply::Broken(m) if m.contains("exited 1")));
    // Only the shell's "no python3" (127, 126) or a SyntaxError (too old) means
    // the machine cannot run the helper; any other failure may pass.
    assert!(matches!(parse(127, String::new()), Reply::Unusable(m) if m.starts_with("it has no usable python3")));
    assert!(matches!(parse(126, String::new()), Reply::Unusable(_)));
    let too_old = parse_reply(Some(1), b"", "  File \"<string>\", line 4\nSyntaxError: invalid syntax", nonce);
    assert!(matches!(too_old, Reply::Unusable(m) if m.starts_with("its python3 is too old")));
    assert!(matches!(parse(137, String::new()), Reply::Broken(m) if m.contains("exited 137")));
    // Not reached, or ended by a signal: no answer rather than a broken helper.
    assert!(matches!(parse(255, ok.clone()), Reply::NoAnswer(_)));
    assert!(matches!(parse_reply(None, ok.as_bytes(), "", nonce), Reply::NoAnswer(_)));
    // Over the reply limit: none, whatever it holds.
    assert!(matches!(parse(0, "x".repeat(256 * 1024) + &ok), Reply::Broken(m) if m.contains("KiB")));
}

#[test]
fn the_remote_helper_on_its_own() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../acceptance/remote-jobs/helper_test.py");
    let output = std::process::Command::new("/usr/bin/python3").arg(script).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

/// A stand-in for the native Windows helper, run with the request on stdin.
fn windows_helper(lab: &Lab, name: &str, body: &str) -> String {
    let source = lab.dir.path().join(format!("{name}.py"));
    std::fs::write(&source, body).unwrap();
    script(lab.dir.path().join(name), format!("#!/bin/sh\nexec /usr/bin/python3 {}\n", source.display()))
}

/// Answers hello as a machine of its own and refuses everything else, so
/// nothing is ever started.
const HELLO_ONLY: &str = r#"
import json, sys
request = json.load(sys.stdin)
mark = "YUZUNO-JOBS-REPLY %s " % request["replyNonce"]
if request.get("action") == "hello":
    print(mark + json.dumps({"status": "hello", "protocol": 1, "hostId": "w" * 64, "bootId": "2026-10-18T00:00:00Z"}))
    sys.exit(0)
print(mark + json.dumps({"error": "this stand-in starts nothing"}))
sys.exit(3)
"#;

#[tokio::test]
async fn a_windows_helper_of_another_protocol_never_gets_a_start() {
    let lab = lab();
    let older = windows_helper(&lab, "windows-older", &HELLO_ONLY.replace("\"protocol\": 1", "\"protocol\": 0"));
    let queued = create_windows(&lab, windows_input("older", r"C:\work"));
    let ended = until(&lab, &older, &queued, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert_eq!(ended["reason"],
        "Not started on Windows on this PC: its helper speaks protocol 0, and this Core needs 1; nothing was sent there", "{ended}");
    assert!(ended["remote"]["startSentAt"].is_null() && ended["remote"]["hostId"].is_null(), "{ended}");
}

/// Answers inspect as windows_job.cs does: each input's final path on
/// Windows, or a problem (paths naming one: "missing…", "linux…" for a reply
/// with a Linux path).
const INSPECTING: &str = r#"
import json, sys
request = json.load(sys.stdin)
mark = "YUZUNO-JOBS-REPLY %s " % request["replyNonce"]
if request.get("action") != "inspect":
    print(mark + json.dumps({"error": "this stand-in only inspects"}))
    sys.exit(3)
files = []
for path in request["inputs"]:
    if path.startswith("missing"):
        files.append({"path": path, "problem": "missing"})
    else:
        final = "/home/u/" + path if path.startswith("linux") else request["cwd"] + "\\" + path
        files.append({"path": path, "absolutePath": final, "sha256": "a" * 64, "bytes": 1})
print(mark + json.dumps({"status": "inspected", "cwd": request["cwd"], "files": files, "totalBytes": len(files), "hostId": "w" * 64}))
"#;

/// Inputs on Windows are files of that PC, read by its own helper at submit
/// (inspect), never on this host or through /mnt: frozen with the final path
/// Windows gave, and the submit refused when one cannot be. The start then
/// carries them and the declared artifacts (v3).
#[tokio::test]
async fn windows_inputs_are_frozen_by_its_own_helper_and_go_with_the_start() {
    let lab = lab();
    let helper = remote::WindowsHelper::trusting(&windows_helper(&lab, "windows-inspect", INSPECTING));
    let programs = remote::Programs { ssh: &lab.ssh, windows: Some(&helper) };
    let snapshot = remote::remote_snapshot(&lab.ws, &programs, "windows", r"C:\work", &["a.txt".into()]).await.unwrap();
    assert_eq!((snapshot["frozenOn"]["kind"].as_str(), snapshot["hostId"].as_str()), (Some("windows"), Some("w".repeat(64).as_str())));
    assert_eq!(snapshot["files"][0]["absolutePath"], r"C:\work\a.txt");
    let error = remote::remote_snapshot(&lab.ws, &programs, "windows", r"C:\work", &["missing.txt".into()]).await.unwrap_err().to_string();
    assert_eq!(error, "Inputs on Windows on this PC cannot be frozen, so nothing was submitted: missing.txt: missing");
    let error = remote::remote_snapshot(&lab.ws, &programs, "windows", r"C:\work", &["linux.txt".into()]).await.unwrap_err().to_string();
    assert!(error.ends_with("its reply does not name each input with its digest"), "{error}");
    // No helper in this Core: nothing is read anywhere, and nothing is submitted.
    let none = remote::Programs { ssh: &lab.ssh, windows: None };
    let error = remote::remote_snapshot(&lab.ws, &none, "windows", r"C:\work", &["a.txt".into()]).await.unwrap_err().to_string();
    assert!(error.starts_with("The inputs could not be read on Windows on this PC, so nothing was submitted"), "{error}");
    // The start carries the frozen inputs and the artifacts, so its digest is v3.
    let mut input = windows_input("io", r"C:\work");
    input.inputs = vec!["a.txt".into()];
    input.artifacts = serde_json::from_value(json!([{"path": "out\\r.json", "format": "json"}])).unwrap();
    input.validate().unwrap();
    let job = lab.ws.store.create_job(Some("a"), input, snapshot, Value::Null, remote::windows_capabilities()).unwrap();
    // Bound at submit, as on an SSH machine: an older Core never starts it unchecked.
    assert!(job["remote"]["prebound"].is_object(), "{job}");
    let spec = remote::spec(&job);
    assert_eq!(job["remote"]["digest"].as_str(), Some(remote::digest(&spec).as_str()));
    assert_eq!(spec["inputs"], json!([{"path": "a.txt", "absolutePath": r"C:\work\a.txt", "sha256": "a".repeat(64)}]));
    assert_eq!(spec["artifacts"], json!([{"path": "out\\r.json", "format": "json", "minBytes": 1}]));
    let mut without = spec.clone();
    without.as_object_mut().unwrap().retain(|key, _| key != "inputs" && key != "artifacts");
    assert_ne!(remote::digest(&spec), remote::digest(&without));
}

/// One pass with this Core's Windows helper, or none.
async fn windows_tick(lab: &Lab, helper: Option<&remote::WindowsHelper>) {
    lab.ws.jobs.remote_seen.lock().unwrap().clear();
    remote::tick_with(&lab.ws, &remote::Programs { ssh: &lab.ssh, windows: helper }).await.unwrap();
}

#[tokio::test]
async fn only_the_trusted_windows_helper_is_ever_run() {
    let lab = lab();
    // None in this Core's release: nothing is run, and that is final.
    let none = create_windows(&lab, windows_input("none", r"C:\work"));
    windows_tick(&lab, None).await;
    let ended = job(&lab, &none);
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert_eq!(ended["reason"], "Not started on Windows on this PC: this Core has no Windows Jobs helper (its release ships none, or a development Core was not given YUZUNO_WINDOWS_JOBS_HELPER with YUZUNO_WINDOWS_JOBS_HELPER_SHA256)", "{ended}");
    // A file whose bytes are not the trusted ones is never run either.
    let ran = lab.dir.path().join("ran");
    let changed = windows_helper(&lab, "windows-changed", &format!("open({:?}, 'w').close()\n{HELLO_ONLY}", ran.display().to_string()));
    let other = remote::WindowsHelper { path: changed.clone(), sha256: "0".repeat(64), interop: true };
    let refused = create_windows(&lab, windows_input("changed", r"C:\work"));
    windows_tick(&lab, Some(&other)).await;
    let ended = job(&lab, &refused);
    assert_eq!(ended["status"], "rejected", "{ended}");
    let reason = ended["reason"].as_str().unwrap();
    assert!(reason.starts_with(&format!(
        "Not started on Windows on this PC: the Windows Jobs helper at {changed} is not the one this Core trusts (SHA-256 ")), "{ended}");
    assert!(reason.ends_with(&format!("expected {}); it was not run", "0".repeat(64))), "{ended}");
    assert!(!ran.exists(), "a helper with other bytes was run");
    // The trusted one is run, and the record keeps what Core checked apart from what it says of itself.
    let digest = |path: &str| format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(std::fs::read(path).unwrap()));
    let trusted = create_windows(&lab, windows_input("trusted", r"C:\work"));
    windows_tick(&lab, Some(&remote::WindowsHelper::trusting(&changed))).await;
    let ended = job(&lab, &trusted);
    assert!(ran.exists());
    assert_eq!(ended["remote"]["helper"], json!({"sha256": digest(&changed), "protocol": 1, "reportedSha256": null, "os": null}), "{ended}");
    // A path counts only with a well-formed digest.
    let sha = Some("A".repeat(64));
    assert_eq!(remote::configured_helper(Some("/h.exe".into()), sha.clone()).unwrap().sha256, "a".repeat(64));
    for (path, sha256) in [(None, sha.clone()), (Some(String::new()), sha), (Some("/h.exe".into()), None),
        (Some("/h.exe".into()), Some("a".repeat(63))), (Some("/h.exe".into()), Some("g".repeat(64)))] {
        assert!(remote::configured_helper(path.clone(), sha256.clone()).is_none(), "{path:?} {sha256:?}");
    }
}

/// Answers hello, and that the attempt runs; nothing is started.
const RUNNING: &str = r#"
import json, sys
request = json.load(sys.stdin)
mark = "YUZUNO-JOBS-REPLY %s " % request["replyNonce"]
host = "w" * 64
if request.get("action") == "hello":
    reply = {"status": "hello", "protocol": 1, "hostId": host, "bootId": "b"}
else:
    reply = {"status": "running", "hostId": host, "bootId": "b",
             "started": {"pid": 42, "jobObject": "Local\\yuzuno-job-test", "startedAtUnix": 1, "bootId": "b"}}
print(mark + json.dumps(reply))
"#;

#[tokio::test]
async fn a_windows_helper_changed_under_a_running_attempt_leaves_it_unknown() {
    let lab = lab();
    let path = windows_helper(&lab, "windows-running", RUNNING);
    let trusted = remote::WindowsHelper::trusting(&path);
    let queued = create_windows(&lab, windows_input("swapped", r"C:\work"));
    windows_tick(&lab, Some(&trusted)).await;
    let running = job(&lab, &queued);
    assert_eq!(running["status"], "running", "{running}");
    // Other bytes at the same path: never run, so the attempt is unknown and keeps its slot.
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.extend_from_slice(b"# changed\n");
    std::fs::write(&path, bytes).unwrap();
    windows_tick(&lab, Some(&trusted)).await;
    let now = job(&lab, &queued);
    assert_eq!((now["status"].as_str(), now["reserved"].as_bool()), (Some("unknown"), Some(true)), "{now}");
    assert!(now["result"]["evidence"]["error"].as_str().unwrap().contains("is not the one this Core trusts"), "{now}");
}

/// A helper of another protocol: whatever it is asked about this attempt,
/// it answers unclear and changes nothing (windows_job.cs SameProtocol).
const OTHER_PROTOCOL: &str = r#"
import json, sys
request = json.load(sys.stdin)
mark = "YUZUNO-JOBS-REPLY %s " % request["replyNonce"]
print(mark + json.dumps({"status": "unclear", "hostId": "w" * 64, "bootId": "b",
    "reason": "it was started by a Windows Jobs helper of protocol 1, and this helper speaks 2; nothing there was changed"}))
"#;

/// Answers hello; a start runs into a crash, with no reply.
const START_CRASHES: &str = r#"
import json, sys
request = json.load(sys.stdin)
if request.get("action") == "hello":
    print("YUZUNO-JOBS-REPLY %s " % request["replyNonce"] + json.dumps({"status": "hello", "protocol": 1, "hostId": "w" * 64, "bootId": "b"}))
    sys.exit(0)
sys.exit(1)
"#;

#[tokio::test]
async fn a_windows_attempt_whose_start_was_sent_is_never_ended_by_a_helper_fault() {
    let lab = lab();
    let running = windows_helper(&lab, "windows-running", RUNNING);
    let trusted = remote::WindowsHelper::trusting(&running);
    let off = remote::WindowsHelper { interop: false, ..trusted.clone() };
    let other = remote::WindowsHelper::trusting(&windows_helper(&lab, "windows-other", OTHER_PROTOCOL));
    let queued = create_windows(&lab, windows_input("faults", r"C:\work"));
    windows_tick(&lab, Some(&trusted)).await;
    assert_eq!(job(&lab, &queued)["status"], "running");
    let sent_at = job(&lab, &queued)["remote"]["startSentAt"].clone();
    assert!(sent_at.is_string());
    // No helper, interop off, a helper of another protocol: unknown, the same attempt
    // and its slot kept; once the helper can be used again it is that attempt, running.
    for (fault, helper) in [("no helper", None), ("interop off", Some(&off)), ("another protocol", Some(&other))] {
        windows_tick(&lab, helper).await;
        let now = job(&lab, &queued);
        assert_eq!((now["status"].as_str(), now["reserved"].as_bool()), (Some("unknown"), Some(true)), "{fault}: {now}");
        assert_eq!((&now["attempt"], &now["remote"]["startSentAt"]), (&queued["attempt"], &sent_at), "{fault}");
        windows_tick(&lab, Some(&trusted)).await;
        let again = job(&lab, &queued);
        assert_eq!((again["status"].as_str(), &again["attempt"]), (Some("running"), &queued["attempt"]), "{fault}: {again}");
    }
    windows_tick(&lab, Some(&off)).await;
    let now = job(&lab, &queued);
    assert!(now["result"]["evidence"]["error"].as_str().unwrap().contains("WSL interop is off"), "{now}");
    // A cancel answered by a helper of another protocol releases nothing.
    cancel(&lab, &queued);
    windows_tick(&lab, Some(&other)).await;
    let now = job(&lab, &queued);
    assert_eq!((now["status"].as_str(), now["reserved"].as_bool()), (Some("unknown"), Some(true)), "{now}");
    assert!(now["reason"].as_str().unwrap().contains("helper of protocol 1, and this helper speaks 2"), "{now}");
    // A start sent but never acknowledged: a helper fault leaves it unknown, never "not started".
    let crashing = remote::WindowsHelper::trusting(&windows_helper(&lab, "windows-crashing", START_CRASHES));
    let sent = create_windows(&lab, windows_input("sent", r"C:\work"));
    windows_tick(&lab, Some(&crashing)).await;
    let unacknowledged = job(&lab, &sent);
    assert_eq!(unacknowledged["status"], "unknown", "{unacknowledged}");
    assert!(unacknowledged["remote"]["startSentAt"].is_string() && unacknowledged["remote"]["acknowledged"].is_null());
    for (fault, helper) in [("no helper", None), ("interop off", Some(&off))] {
        windows_tick(&lab, helper).await;
        let now = job(&lab, &sent);
        assert_eq!((now["status"].as_str(), now["reserved"].as_bool()), (Some("unknown"), Some(true)), "{fault}: {now}");
        assert_eq!(now["remote"]["startSentAt"], unacknowledged["remote"]["startSentAt"], "{fault}");
    }
}

fn windows_input(id: &str, cwd: &str) -> Submit {
    serde_json::from_value(json!({"requestId":id,"taskId":"T-1","name":id,"cwd":cwd,"argv":["cmd.exe","/c","echo","hi"],
        "resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},"timeoutSeconds":120,"guardGit":false,"machineId":"windows"}))
    .unwrap()
}

fn create_windows(lab: &Lab, input: Submit) -> Value {
    input.validate().unwrap();
    let cwd = input.cwd.clone();
    lab.ws
        .store
        .create_job(Some("a"), input, json!({"cwd":cwd,"remote":true}), Value::Null, remote::windows_capabilities())
        .unwrap()
}

#[tokio::test]
async fn a_windows_attempt_is_pinned_to_the_root_its_helper_reports_and_an_older_one_stays_in_its_own() {
    let lab = lab();
    let calls = lab.dir.path().join("calls.jsonl");
    let source = lab.dir.path().join("windows-rooted.py");
    std::fs::write(&source, format!(r#"
import json, sys
request = json.load(sys.stdin)
with open({calls:?}, "a") as log:
    log.write(json.dumps({{"action": request.get("action"), "argv": sys.argv[1:]}}) + "\n")
mark = "YUZUNO-JOBS-REPLY %s " % request["replyNonce"]
if request.get("action") == "hello":
    print(mark + json.dumps({{"status": "hello", "protocol": 1, "hostId": "w" * 64, "bootId": "b",
                             "dataRoot": "C:\\Users\\me\\AppData\\Local\\YuzunoData\\windows-jobs"}}))
    sys.exit(0)
print(mark + json.dumps({{"error": "this stand-in starts nothing"}}))
sys.exit(3)
"#, calls = calls.display().to_string())).unwrap();
    let helper = script(lab.dir.path().join("windows-rooted"), format!("#!/bin/sh\nexec /usr/bin/python3 {} \"$@\"\n", source.display()));
    let logged = || -> Vec<Value> {
        std::fs::read_to_string(&calls).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    };
    let queued = create_windows(&lab, windows_input("rooted", r"C:\work"));
    let ended = until(&lab, &helper, &queued, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    let absolute = r"C:\Users\me\AppData\Local\YuzunoData\windows-jobs";
    assert_eq!(ended["remote"]["root"], absolute, "{ended}");
    assert_eq!(logged(), [
        json!({"action": "hello", "argv": ["--root", r"%LOCALAPPDATA%\YuzunoData\windows-jobs"]}),
        json!({"action": "start", "argv": ["--root", absolute]}),
    ]);
    // Sent by an older Core: no root recorded, so its old default root.
    std::fs::remove_file(&calls).unwrap();
    let older = create_windows(&lab, windows_input("older", r"C:\work"));
    let id = older["id"].as_str().unwrap();
    let reserved = lab.ws.store.reserve_remote(id).unwrap().unwrap();
    lab.ws.store.remote_note(id, &reserved["attempt"], json!({"hostId": "w".repeat(64), "digest": remote::digest(&remote::spec(&reserved)),
        "startSentAt": crate::model::now()}), None).unwrap();
    tick(&lab, &helper).await;
    let held = job(&lab, &older);
    assert_eq!((held["status"].as_str(), held["reserved"].as_bool()), (Some("unknown"), Some(true)), "{held}");
    assert!(held["remote"]["root"].is_null());
    assert_eq!(logged(), [json!({"action": "status", "argv": ["--root", r"%LOCALAPPDATA%\yuzuno-next"]})]);
}

#[tokio::test]
async fn a_windows_job_is_recorded_for_windows_and_goes_through_its_helper() {
    let lab = lab();
    // A Windows drive path, and no Linux PATH or LANG added to its environment.
    let mut input = windows_input("win", r"C:\work");
    input.default_env();
    assert!(input.env.is_empty(), "{:?}", input.env);
    let queued = create_windows(&lab, input);
    assert_eq!(queued["executor"], json!({"kind":"windows","machineId":"windows","machineName":"Windows on this PC"}));
    assert_eq!(queued["machine"]["kind"], "windows");
    assert_eq!(queued["capabilities"]["executor"], "windows");
    assert_eq!(queued["capabilities"]["gpu"], "unavailable");
    assert!(queued["unit"].is_null(), "{queued}");
    // Pinned by the helper's own identity; its refusal of the start means nothing was started.
    let helper = windows_helper(&lab, "windows-helper", HELLO_ONLY);
    let ended = until(&lab, &helper, &queued, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert_eq!(ended["remote"]["hostId"], "w".repeat(64));
    assert_eq!(ended["reason"], "Not started on Windows on this PC: this stand-in starts nothing", "{ended}");
}

#[tokio::test]
async fn a_windows_helper_that_cannot_run_ends_a_hello_but_a_crash_waits() {
    let lab = lab();
    // Missing (or interop off): nothing reached Windows, so this is final.
    let missing = lab.dir.path().join("no-such-helper.exe").to_string_lossy().into_owned();
    let refused = create_windows(&lab, windows_input("missing", r"C:\work"));
    let ended = until(&lab, &missing, &refused, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    let reason = ended["reason"].as_str().unwrap();
    assert!(reason.starts_with("Not started on Windows on this PC: the Windows Jobs helper cannot be run from this Core's WSL"), "{ended}");
    assert!(ended["remote"]["startSentAt"].is_null());
    // A helper that exits without a reply may pass: wait, nothing sent.
    let crashy = windows_helper(&lab, "windows-crashy", "import sys\nsys.stdin.read()\nsys.exit(1)\n");
    let waiting = create_windows(&lab, windows_input("crashy", r"C:\work"));
    tick(&lab, &crashy).await;
    let now = job(&lab, &waiting);
    assert_eq!((now["status"].as_str(), now["reserved"].as_bool()), (Some("starting"), Some(true)), "{now}");
    assert!(now["reason"].as_str().unwrap().starts_with("Waiting for Windows on this PC to answer before starting"), "{now}");
    assert!(now["remote"]["startSentAt"].is_null());
    // Later, a helper that answers: the same job goes on (and here is refused cleanly).
    let helper = windows_helper(&lab, "windows-helper", HELLO_ONLY);
    let ended = until(&lab, &helper, &waiting, |j| j["reserved"] == false).await;
    assert_eq!(ended["status"], "rejected", "{ended}");
}

#[test]
fn a_windows_job_needs_a_windows_drive_path_and_a_linux_job_a_linux_one() {
    for cwd in [r"C:\work", "D:/data/run", r"c:\"] {
        windows_input("ok", cwd).validate().unwrap();
    }
    for cwd in ["/home/user/work", r"\\server\share", r"C:work", "C:", "", "C:\\work\u{7}"] {
        let error = windows_input("bad", cwd).validate().unwrap_err().to_string();
        assert!(error.starts_with("cwd must be an absolute Windows directory"), "{cwd}: {error}");
    }
    let mut linux = windows_input("linux", r"C:\work");
    linux.machine_id = Some("m1".into());
    assert!(linux.validate().unwrap_err().to_string().starts_with("cwd must be an absolute local directory"));
    let windows = remote::parse_windows_reply;
    let nonce = "0123456789abcdef0123456789abcdef";
    let ok = format!("YUZUNO-JOBS-REPLY {nonce} {{\"status\":\"running\"}}\n");
    assert!(matches!(windows(Some(0), ok.as_bytes(), "", nonce), remote::Reply::Answer(_)));
    // No SSH and no shell: 255 and 127 are a helper that did not answer, not "unreachable" or "no python3".
    for code in [255, 127, 1] {
        assert!(matches!(windows(Some(code), b"", "", nonce), remote::Reply::Broken(m) if m.contains("on Windows exited")), "{code}");
    }
    assert!(matches!(windows(None, ok.as_bytes(), "", nonce), remote::Reply::NoAnswer(_)));
}

/// The digest Core and the helper compute (remote_job.py `digest`): the same
/// values the helper gives, v1 for a spec without limits (what an attempt
/// recorded before limits keeps) and v2 binding them.
#[test]
fn the_digest_matches_the_helper_and_binds_limits_only_in_v2() {
    let spec = json!({"argv":["/bin/sh","-c","echo hi"],"cwd":"/work","env":{"PATH":"/usr/bin:/bin","A":"b"},"timeoutSeconds":60});
    assert_eq!(remote::digest(&spec), "cc35275e639972268a349ca5e7544352b15dc5cb2a908465704a452ec3825891");
    let mut limited = spec.clone();
    limited["limits"] = json!({"mode":"limited","cpuMillis":500,"memoryMiB":64,"swapMiB":0});
    assert_eq!(remote::digest(&limited), "53ae20cba4271ecb76b7c725d4b6645818f377a27d6b4f90ee0c50e9e0be33c8");
    limited["limits"]["mode"] = json!("strict");
    assert_ne!(remote::digest(&limited), "53ae20cba4271ecb76b7c725d4b6645818f377a27d6b4f90ee0c50e9e0be33c8");
    let mut null = spec.clone();
    null["limits"] = Value::Null;
    assert_eq!(remote::digest(&null), remote::digest(&spec));
}

/// v3 binds an SSH attempt's frozen inputs and declared artifacts; v1 and v2
/// stay what they were. The same vectors as the helper's own test
/// (acceptance/remote-jobs/helper_test.py), v1 and v2 also computed by the
/// helper before inputs and artifacts.
#[test]
fn the_digest_v3_matches_the_helper_and_leaves_v1_and_v2_as_they_were() {
    let base = json!({"argv":["true"],"cwd":"/w","env":{},"timeoutSeconds":5});
    assert_eq!(remote::digest(&base), "9fd6c28e5279171ad00e05426404968e28d63227503f7d147a3a41a5c78ad84b");
    let mut limited = base.clone();
    limited["limits"] = json!({"mode":"strict","cpuMillis":500,"memoryMiB":64,"swapMiB":0});
    assert_eq!(remote::digest(&limited), "206e040dcf5f2adf8433f931d68dd450a5f7a30dec60129ae8e9538314b11d81");
    let io = |mut spec: Value| {
        spec["inputs"] = json!([{"path":"in.txt","absolutePath":"/w/in.txt","sha256":"a".repeat(64)}]);
        spec["artifacts"] = json!([{"path":"out.json","format":"json","minBytes":1}]);
        spec
    };
    assert_eq!(remote::digest(&io(base.clone())), "09a436e958f0430dc2f7578eab4d6e9c2805c2c3bc8942e9a942f78d269b369e");
    assert_eq!(remote::digest(&io(limited)), "03a9297c3650f42ee3f5e5e374206e2d315e156144c52231ab8baeb96c42c795");
    // Empty lists are no inputs or artifacts: v1 as before.
    let mut empty = base.clone();
    (empty["inputs"], empty["artifacts"]) = (json!([]), json!([]));
    assert_eq!(remote::digest(&empty), "9fd6c28e5279171ad00e05426404968e28d63227503f7d147a3a41a5c78ad84b");
    let mut changed = io(base);
    changed["inputs"][0]["sha256"] = json!("b".repeat(64));
    assert_ne!(remote::digest(&changed), "09a436e958f0430dc2f7578eab4d6e9c2805c2c3bc8942e9a942f78d269b369e");
}

fn host_a() -> String {
    let full = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"yuzuno-jobs-host-v1:0123456789abcdef0123456789abcdef"));
    full[..32].to_owned()
}

fn sha(text: &str) -> String {
    format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(text.as_bytes()))
}

async fn frozen(lab: &Lab, program: &str, inputs: &[&str]) -> anyhow::Result<Value> {
    let inputs: Vec<String> = inputs.iter().map(|p| p.to_string()).collect();
    remote::remote_snapshot(&lab.ws, &remote::Programs { ssh: program, windows: None }, "m1", &lab.work.to_string_lossy(), &inputs).await
}

/// As job_submit: the job with what was frozen on the machine.
fn create_frozen(lab: &Lab, input: Submit, snapshot: Value) -> Value {
    input.validate().unwrap();
    let machine = lab.ws.store.machine("m1").unwrap();
    lab.ws.store.create_job(Some("a"), input, snapshot, remote::machine_snapshot(&machine), remote::capabilities()).unwrap()
}

/// Inputs are files on the machine: frozen there at submit, by SHA-256 with
/// the machine that answered, from the job's cwd there (T-108). Nothing of
/// this host is read; a missing input, or a machine that does not answer,
/// refuses the submit.
#[tokio::test]
async fn inputs_are_frozen_on_the_machine_at_submit_and_one_that_cannot_be_refuses_it() {
    let lab = lab();
    std::fs::write(lab.work.join("in.txt"), "frozen\n").unwrap();
    let snapshot = frozen(&lab, &lab.ssh, &["in.txt"]).await.unwrap();
    assert_eq!(snapshot["hostId"], json!(host_a()));
    assert_eq!(snapshot["files"][0]["absolutePath"], json!(lab.work.join("in.txt").canonicalize().unwrap()));
    assert_eq!(snapshot["files"][0]["sha256"], json!(sha("frozen\n")));
    assert!(snapshot["scope"].as_str().unwrap().starts_with("Inputs are files on lab box, frozen there by SHA-256"));
    let error = frozen(&lab, &lab.ssh, &["in.txt", "none.txt"]).await.unwrap_err().to_string();
    assert_eq!(error, "Inputs on lab box cannot be frozen, so nothing was submitted: none.txt: missing");
    let error = frozen(&lab, &lab.down, &["in.txt"]).await.unwrap_err().to_string();
    assert!(error.starts_with("The inputs could not be read on lab box, so nothing was submitted: "), "{error}");
    // Without inputs nothing is asked of the machine.
    let none = frozen(&lab, &lab.down, &[]).await.unwrap();
    assert_eq!(none["scope"], "Nothing is frozen on the remote machine: Core does not see its files");
    assert!(none.get("files").is_none());
    // A repeated submit (a lost reply) is the job first inserted, with what
    // was frozen then, not another reading.
    let first = create_frozen(&lab, input(&lab, "same", "true", json!({"inputs":["in.txt"]})), snapshot.clone());
    std::fs::write(lab.work.join("in.txt"), "changed\n").unwrap();
    let again = frozen(&lab, &lab.ssh, &["in.txt"]).await.unwrap();
    let repeated = create_frozen(&lab, input(&lab, "same", "true", json!({"inputs":["in.txt"]})), again);
    assert_eq!((repeated["id"].clone(), repeated["snapshot"].clone()), (first["id"].clone(), snapshot.clone()));
    // The machine pointed elsewhere while its inputs were read (no job of it
    // unfinished, so it may be): nothing is inserted.
    let lab = self::lab();
    std::fs::write(lab.work.join("in.txt"), "frozen\n").unwrap();
    let read = frozen(&lab, &lab.ssh, &["in.txt"]).await.unwrap();
    lab.ws.store.update_machine(&RemoteMachine { target: "other-box".into(), ..lab.ws.store.machine("m1").unwrap() }).unwrap();
    let moved = input(&lab, "moved", "true", json!({"inputs":["in.txt"]}));
    let error = lab.ws.store.create_job(Some("a"), moved.clone(), read, Value::Null, remote::capabilities()).unwrap_err().to_string();
    assert_eq!(error, "lab box was changed while its inputs were being read there, so nothing was submitted; submit it again");
    assert!(lab.ws.store.previous_job(Some("a"), &moved).unwrap().is_none());
}

/// Frozen inputs and declared artifacts go with the start (v3): the command
/// runs with unchanged inputs, and its artifacts are checked on the machine
/// and recorded with the attempt and the machine they were checked on.
#[tokio::test]
async fn inputs_and_artifacts_go_with_the_start_and_are_checked_on_the_machine() {
    let lab = lab();
    std::fs::write(lab.work.join("in.txt"), "frozen\n").unwrap();
    let snapshot = frozen(&lab, &lab.ssh, &["in.txt"]).await.unwrap();
    let job = create_frozen(&lab, input(&lab, "io", "cat in.txt > out.txt; printf '{\"n\":1}\\n' > out.jsonl",
        json!({"inputs":["in.txt"],"artifacts":[{"path":"out.txt"},{"path":"out.jsonl","format":"jsonl"}]})), snapshot);
    let ended = until(&lab, &lab.ssh, &job, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!((ended["status"].as_str(), ended["reason"].as_str()), (Some("succeeded"), Some("success")), "{ended}");
    let artifacts = ended["result"]["artifacts"].as_array().unwrap();
    assert!(artifacts.iter().all(|a| a["ok"] == true && a["preExisting"] == false), "{ended}");
    assert_eq!(artifacts[0]["sha256"], json!(sha("frozen\n")));
    assert_eq!(artifacts[1]["lines"], 1);
    assert_eq!(ended["result"]["artifactsOn"], json!({"machineId":"m1","name":"lab box","hostId":host_a()}));
    // Pinned as v3 with what the start carried, which the machine kept.
    let spec = remote::spec(&ended);
    assert_eq!(ended["remote"]["digest"], json!(remote::digest(&spec)));
    let kept = read(folder(&lab, &ended).join("spec.json"));
    assert_eq!((kept["inputs"].clone(), kept["artifacts"].clone()), (spec["inputs"].clone(), spec["artifacts"].clone()));
    assert_eq!(kept["inputs"][0]["sha256"], json!(sha("frozen\n")));
    // Its artifacts are on that machine: none is served from this host.
    assert_eq!(super::remote_artifact_refusal(&ended).unwrap(),
        "This artifact is on lab box; Core checks it there and does not copy it, so it cannot be downloaded here");
    // What the job records of the executor says so, and claims no more: a
    // file already at the path is noted, not refused (R1 P3).
    let said = ended["capabilities"]["artifacts"].as_str().unwrap();
    assert!(said.contains("noted, not judged") && !said.contains("written by this attempt"), "{said}");
}

/// An input changed while queued stops the start before the command runs; a
/// failed command and a failed artifact are told apart.
#[tokio::test]
async fn a_changed_input_stops_the_start_and_a_failed_command_is_not_an_artifact_failure() {
    let lab = lab();
    std::fs::write(lab.work.join("in.txt"), "v1\n").unwrap();
    let snapshot = frozen(&lab, &lab.ssh, &["in.txt"]).await.unwrap();
    let changed = create_frozen(&lab, input(&lab, "changed", "touch ran", json!({"inputs":["in.txt"]})), snapshot);
    std::fs::write(lab.work.join("in.txt"), "v2\n").unwrap();
    let ended = until(&lab, &lab.ssh, &changed, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert_eq!(ended["reason"], "Inputs changed on this machine while queued (in.txt (its content changed)); command was not started");
    assert!(!lab.work.join("ran").exists());
    let failing = create(&lab, input(&lab, "failing", "printf x > out.txt; exit 3", json!({"artifacts":[{"path":"out.txt"}]})));
    let failed = until(&lab, &lab.ssh, &failing, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!((failed["status"].as_str(), failed["reason"].as_str()), (Some("failed"), Some("exit-code 3")), "{failed}");
    assert!(failed["result"].get("artifacts").is_none(), "{failed}");
    let missing = create(&lab, input(&lab, "missing", "true", json!({"artifacts":[{"path":"none.txt"}]})));
    let failed = until(&lab, &lab.ssh, &missing, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(failed["status"], "failed", "{failed}");
    assert_eq!(failed["reason"], "Exit 0, but declared artifacts failed verification: none.txt: missing");
    assert_eq!(failed["result"]["artifacts"][0]["problem"], "missing");
}

/// Inputs frozen on one machine never start on another the name now reaches.
#[tokio::test]
async fn inputs_frozen_on_one_machine_never_start_on_another() {
    let lab = lab();
    std::fs::write(lab.work.join("in.txt"), "frozen\n").unwrap();
    let snapshot = frozen(&lab, &lab.ssh, &["in.txt"]).await.unwrap();
    let job = create_frozen(&lab, input(&lab, "moved", "touch ran", json!({"inputs":["in.txt"]})), snapshot);
    let ended = until(&lab, &lab.other, &job, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert_eq!(ended["reason"], "Not started on lab box: it now reaches a different machine than the one its inputs were frozen on at submit; nothing was sent there");
    assert!(!lab.work.join("ran").exists());
}

/// A start whose reply is lost is the same attempt when the machine answers
/// again, with its inputs and artifacts: it never runs twice.
#[tokio::test]
async fn a_lost_start_reply_with_inputs_and_artifacts_is_still_the_same_attempt() {
    let lab = lab();
    std::fs::write(lab.work.join("in.txt"), "frozen\n").unwrap();
    let snapshot = frozen(&lab, &lab.ssh, &["in.txt"]).await.unwrap();
    let first = create_frozen(&lab, input(&lab, "lossy", "echo run >> runs.txt; cp in.txt out.txt",
        json!({"inputs":["in.txt"],"artifacts":[{"path":"out.txt"}]})), snapshot);
    tick(&lab, &lab.lossy).await;
    assert_eq!(job(&lab, &first)["status"], "unknown");
    let ended = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!((ended["status"].as_str(), ended["attempt"].clone()), (Some("succeeded"), first["attempt"].clone()), "{ended}");
    assert_eq!(starts(&lab), 1);
    assert_eq!(ended["result"]["artifacts"][0]["sha256"], json!(sha("frozen\n")));
}

/// Windows on this PC and this Core's host are one physical machine (T-108):
/// their jobs hold one budget, never counted twice nor added together, and
/// each side waits for what the other holds.
#[tokio::test]
async fn windows_and_this_hosts_jobs_share_one_budget() {
    let lab = lab();
    lab.ws.store.set_job_budget(Resources { cpu_millis: 1000, memory_mi_b: 512, swap_mi_b: 0 }).unwrap();
    // Beyond the shared budget: refused at once, nothing queued.
    let mut big = windows_input("big", r"C:\work");
    big.resources.cpu_millis = 2000;
    let refused = lab
        .ws
        .store
        .create_job(Some("a"), big, json!({"cwd":"C:\\work","remote":true}), Value::Null, remote::windows_capabilities())
        .unwrap_err();
    assert!(refused.to_string().contains("which its Linux and Windows jobs share"), "{refused}");
    // A running Windows job (600 mCPU / 192 MiB with its collector) holds it.
    let trusted = remote::WindowsHelper::trusting(&windows_helper(&lab, "windows-running", RUNNING));
    let first = create_windows(&lab, windows_input("first", r"C:\work"));
    windows_tick(&lab, Some(&trusted)).await;
    assert_eq!(job(&lab, &first)["status"], "running");
    // A local job of the same size waits for this host's budget...
    let local: Submit = serde_json::from_value(json!({"requestId":"local","taskId":"T-1","name":"local","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0}})).unwrap();
    let local = lab
        .ws
        .store
        .create_job(Some("a"), local, json!({"cwd":"/workspace"}), json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":1000,"memoryMiB":512,"swapMiB":0}}), json!({"bootId":"boot"}))
        .unwrap();
    assert!(lab.ws.store.reserve_next_job(None, None, None).unwrap().is_none());
    let waiting = job(&lab, &local);
    assert!(waiting["reason"].as_str().unwrap().starts_with("Waiting for shared CPU quota: needs 600 mCPU including collector, 400 mCPU available"), "{waiting}");
    // ...and so does a second Windows job, with a slot free on Windows.
    let second = create_windows(&lab, windows_input("second", r"C:\work"));
    windows_tick(&lab, Some(&trusted)).await;
    let second = job(&lab, &second);
    assert_eq!((second["status"].as_str(), second["reserved"].as_bool()), (Some("queued"), Some(false)), "{second}");
    assert_eq!(second["reason"], "Waiting for this PC's Jobs budget, which its Linux and Windows jobs share: needs 600 mCPU / 192 MiB RAM / 0 MiB swap including collector; 400 mCPU / 320 MiB RAM / 0 MiB swap free", "{second}");
}

/// A Windows job queued before this host stored a Jobs budget (a Workspace
/// with no local job yet, or a job an older Core queued) gets the host's
/// suggested budget from the tick instead of stalling the queue; one the whole
/// budget cannot hold says so; and a job whose reservation fails does not hold
/// up the jobs after it (T-108 review R1).
#[tokio::test]
async fn a_windows_job_without_a_stored_budget_or_beyond_it_does_not_stall_the_queue() {
    let lab = lab();
    let trusted = remote::WindowsHelper::trusting(&windows_helper(&lab, "windows-running", RUNNING));
    let first = create_windows(&lab, windows_input("first", r"C:\work"));
    lab.ws.store.db.write().unwrap().execute("DELETE FROM local_job_settings", []).unwrap();
    windows_tick(&lab, Some(&trusted)).await;
    assert_eq!(job(&lab, &first)["status"], "running");
    assert!(store::budget(&lab.ws.store.db.read().unwrap(), None).is_ok(), "the tick stored the host's suggested budget");
    // Lowered below what a queued job needs: it waits and says why.
    let queued = create_windows(&lab, windows_input("queued", r"C:\work"));
    lab.ws.store.set_job_budget(Resources { cpu_millis: 300, memory_mi_b: 512, swap_mi_b: 0 }).unwrap();
    windows_tick(&lab, Some(&trusted)).await;
    let waiting = job(&lab, &queued);
    let reason = waiting["reason"].as_str().unwrap();
    assert_eq!(waiting["status"], "queued");
    assert!(reason.starts_with("Cannot start under this PC's Jobs budget") && reason.ends_with("Raise the budget or cancel this job"), "{reason}");
    // A budget that cannot be read fails only that job's reservation: an SSH
    // job queued after it still starts.
    lab.ws.store.db.write().unwrap().execute("UPDATE local_job_settings SET data='{'", []).unwrap();
    let ssh = submit(&lab, "after", "sleep 30");
    windows_tick(&lab, Some(&trusted)).await;
    assert_eq!(job(&lab, &queued)["status"], "queued");
    assert_ne!(job(&lab, &ssh)["status"], "queued", "{}", job(&lab, &ssh));
}

/// Windows' own ceiling (T-108): two at once unless the user sets 1–64 in
/// this host's Jobs settings. It is only a ceiling inside the shared budget:
/// raising it starts the next attempt, lowering or clearing it stops nothing
/// that holds a slot, and an unknown attempt keeps its slot.
#[tokio::test]
async fn windows_has_its_own_ceiling_inside_the_shared_budget() {
    let lab = lab();
    let trusted = remote::WindowsHelper::trusting(&windows_helper(&lab, "windows-running", RUNNING));
    let [a, b, c] = ["a", "b", "c"].map(|id| create_windows(&lab, windows_input(id, r"C:\work")));
    windows_tick(&lab, Some(&trusted)).await;
    let status = |of: &Value| job(&lab, of)["status"].as_str().unwrap().to_owned();
    assert_eq!([status(&a), status(&b), status(&c)], ["running", "running", "queued"]);
    assert_eq!(job(&lab, &c)["reason"], "Waiting for a slot on Windows on this PC: 2 of 2 in use");
    // Raised: the third starts.
    assert_eq!(lab.ws.store.set_windows_max_jobs(Some(3)).unwrap(), Some(3));
    windows_tick(&lab, Some(&trusted)).await;
    assert_eq!(status(&c), "running");
    // Lowered below what runs: nothing is stopped; a new one waits.
    lab.ws.store.set_windows_max_jobs(Some(1)).unwrap();
    let d = create_windows(&lab, windows_input("d", r"C:\work"));
    windows_tick(&lab, Some(&trusted)).await;
    assert_eq!([status(&a), status(&b), status(&c), status(&d)], ["running", "running", "running", "queued"]);
    assert_eq!(job(&lab, &d)["reason"], "Waiting for a slot on Windows on this PC: 3 of 1 in use");
    // An unknown attempt keeps its slot.
    assert!(lab.ws.store.job_unknown(a["id"].as_str().unwrap(), "this test lost track of it").unwrap());
    lab.ws.store.set_windows_max_jobs(None).unwrap();
    windows_tick(&lab, Some(&trusted)).await;
    assert_eq!(job(&lab, &a)["reserved"], true);
    assert_eq!(job(&lab, &d)["reason"], "Waiting for a slot on Windows on this PC: 3 of 2 in use");
    // The budget view tells the ceiling, whether it was set and what holds it.
    let view = lab.ws.store.job_budget_view(json!({"suggestedBudget":{"cpuMillis":8000,"memoryMiB":16384,"swapMiB":0}})).unwrap();
    assert_eq!(view["windows"], json!({"maxJobs":2,"set":false,"defaultMaxJobs":2,"activeCount":3,"sharesThisBudget":true}));
}

/// An older Core ignores Windows' ceiling, so setting one keeps such Cores out
/// of the Workspace (T-137's guard), as a machine's Jobs limits do.
#[tokio::test]
async fn a_set_windows_ceiling_keeps_older_cores_out() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let mode = || std::fs::metadata(dir.path().join("data/workspace.lock")).unwrap().permissions().mode() & 0o777;
    // Open (writable by its owner) while nothing here is what an older Core
    // would mishandle; closed is read-only (0400).
    let open = mode();
    assert!(open & 0o200 != 0 && open != 0o400, "{open:o}");
    // Out of range: refused, nothing stored, the lock left as it was.
    for wrong in [0, 65] {
        let refused = ws.store.set_windows_max_jobs(Some(wrong)).unwrap_err();
        assert!(refused.to_string().contains("must be 1–64"), "{refused}");
    }
    assert_eq!((store::windows_max_jobs(&ws.store.db.read().unwrap()).unwrap(), mode()), (None, open));
    ws.store.set_windows_max_jobs(Some(1)).unwrap();
    assert_eq!((store::windows_max_jobs(&ws.store.db.read().unwrap()).unwrap(), mode()), (Some(1), 0o400));
}

/// A machine's mode is bound into each attempt when its slot is taken (T-108):
/// strict starts nothing on a machine that cannot hold the declared limits,
/// and limited runs there and records what is only declared.
#[tokio::test]
async fn a_strict_machine_that_cannot_hold_the_limits_starts_nothing_and_limited_says_what_is_declared() {
    let lab = lab();
    let strict = RemoteMachine { limit_mode: Some("strict".into()), ..lab.ws.store.machine("m1").unwrap() };
    lab.ws.store.update_machine(&strict).unwrap();
    let refused = submit(&lab, "strict", "touch ran");
    let ended = until(&lab, &lab.ssh, &refused, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert_eq!(ended["executor"]["limitMode"], "strict", "{ended}");
    let reason = ended["reason"].as_str().unwrap();
    assert!(reason.starts_with("Not started on lab box: This machine cannot hold strict limits, so nothing was started: "), "{reason}");
    assert!(reason.contains("CPU cannot be limited here") && reason.contains("memory cannot be limited here"), "{reason}");
    assert!(!lab.work.join("ran").exists());
    assert!(!folder(&lab, &ended).join("intent.json").exists());
    // Chosen for the machine, limited runs with what it holds (nothing here).
    let limited = RemoteMachine { limit_mode: Some("limited".into()), ..lab.ws.store.machine("m1").unwrap() };
    lab.ws.store.update_machine(&limited).unwrap();
    let ran = submit(&lab, "limited", "echo ran");
    let ended = until(&lab, &lab.ssh, &ran, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!((ended["status"].as_str(), ended["executor"]["limitMode"].as_str()), (Some("succeeded"), Some("limited")), "{ended}");
    let limits = &ended["result"]["evidence"]["result"]["limits"];
    assert_eq!((limits["memory"].as_str(), limits["cpu"].as_str(), &limits["held"]), (Some("declared"), Some("declared"), &Value::Null), "{ended}");
    assert_eq!((limits["cpuMillis"].as_i64(), limits["memoryMiB"].as_i64()), (Some(500), Some(128)), "{ended}");
}

/// A machine's own ceiling and budget admit its attempts (T-108); a Job that
/// could never fit its budget is refused at once.
#[tokio::test]
async fn a_machines_ceiling_and_budget_admit_its_attempts() {
    let lab = lab();
    let one = RemoteMachine { max_jobs: Some(1), ..lab.ws.store.machine("m1").unwrap() };
    lab.ws.store.update_machine(&one).unwrap();
    let first = submit(&lab, "first", "sleep 30");
    let second = submit(&lab, "second", "sleep 30");
    tick(&lab, &lab.ssh).await;
    assert_eq!(job(&lab, &first)["status"], "running");
    assert_eq!(job(&lab, &second)["reason"], "Waiting for a slot on lab box: 1 of 1 in use");
    // Three slots, but 1000 mCPU / 1024 MiB: the first (600 / 192 with its supervisor) leaves too little.
    let budgeted = RemoteMachine { max_jobs: Some(3), budget: Some(crate::remote::MachineBudget { cpu_millis: 1000, memory_mib: 1024 }), ..lab.ws.store.machine("m1").unwrap() };
    lab.ws.store.update_machine(&budgeted).unwrap();
    tick(&lab, &lab.ssh).await;
    let waiting = job(&lab, &second);
    assert_eq!(waiting["status"], "queued");
    assert_eq!(waiting["reason"], "Waiting for lab box's Jobs budget: needs 600 mCPU / 192 MiB RAM including its supervisor; 400 mCPU / 832 MiB RAM free of 1000 mCPU / 1024 MiB RAM", "{waiting}");
    let too_big = input(&lab, "too-big", "true", json!({"resources":{"cpuMillis":2000,"memoryMiB":128,"swapMiB":0}}));
    too_big.validate().unwrap();
    let error = lab.ws.store.create_job(Some("a"), too_big, json!({"cwd":lab.work,"remote":true}), Value::Null, remote::capabilities()).unwrap_err();
    assert!(error.to_string().starts_with("Job can never fit this machine's Jobs budget (1000 mCPU / 1024 MiB RAM"), "{error}");
    cancel(&lab, &first);
    cancel(&lab, &second);
    until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
}

/// A running attempt says what its helper froze when it started it (T-108):
/// memory held in its scope, CPU only declared and the session dependence on
/// a limited Linux machine; both held by a Windows Job Object; an attempt
/// started without limits keeps saying they are not enforced.
#[test]
fn a_running_reason_says_the_limits_the_attempt_was_started_with() {
    let reason = |kind: &str, started: Value| {
        let job = json!({"id":"j","attempt":"a","executor":{"kind":kind,"machineName":"lab_host"}});
        remote::evidence(&job, &json!({"status":"running","started":started})).unwrap()["reason"].as_str().unwrap().to_owned()
    };
    let scoped = json!({"pgid":42,"startedAtUnix":1,"bootId":"b","limits":{"mode":"limited","cpuMillis":500,"memoryMiB":64,"swapMiB":0,
        "memory":"limited","swap":"limited","cpu":"declared","facts":{"linger":true},"held":{"memory.max":"67108864"}}});
    assert_eq!(reason("ssh", scoped), "Running on lab_host in its own process group (42); memory held at 64 MiB in its own systemd scope; CPU declared only, not limited");
    // No swap accounting there: memory is held, swap only declared.
    let unswapped = json!({"pgid":45,"limits":{"mode":"limited","cpuMillis":500,"memoryMiB":64,"swapMiB":0,
        "memory":"limited","swap":"declared","cpu":"limited","facts":{"linger":true}}});
    assert_eq!(reason("ssh", unswapped), "Running on lab_host in its own process group (45); memory held at 64 MiB in its own systemd scope, swap declared only (that kernel does not account it); CPU held at 500 mCPU");
    // Nothing the account can hold: declared, without blaming linger.
    let declared = json!({"pgid":43,"limits":{"mode":"limited","cpuMillis":500,"memoryMiB":64,"swapMiB":0,"memory":"declared","cpu":"declared","facts":{"linger":false},
        "caveats":["memory is declared only, not limited: this account's systemd user manager does not answer"]}});
    assert_eq!(reason("ssh", declared), "Running on lab_host in its own process group (43); memory declared only, not limited; CPU declared only, not limited");
    // limited on an account that does not linger: no scope, all declared, and why.
    let unlingering = json!({"pgid":46,"limits":{"mode":"limited","cpuMillis":500,"memoryMiB":64,"swapMiB":0,"memory":"declared","swap":"declared","cpu":"declared",
        "facts":{"linger":false},"caveats":["nothing is held in a scope: this account does not linger, so its systemd user manager may stop"]}});
    assert_eq!(reason("ssh", unlingering), "Running on lab_host in its own process group (46); memory declared only, not limited; CPU declared only, not limited; nothing is held in a scope because this account does not linger");
    let windows = json!({"pid":7,"jobObject":"Local\\\\yuzuno-job-a","limits":{"mode":"strict","cpuMillis":500,"memoryMiB":128,"swapMiB":0,"memory":"limited","cpu":"limited"}});
    assert_eq!(reason("windows", windows), "Running on lab_host in its own Job Object (process 7); committed memory held at 128 MiB by its Job Object; CPU held at 500 mCPU");
    // Started without limits: an older Core's attempt or the legacy mode.
    assert_eq!(reason("ssh", json!({"pgid":44})), "Running on lab_host in its own process group (44); declared CPU and RAM are recorded, not enforced there: this machine keeps the record-only mode it had before limits (choose strict or limited for it on the Machines page)");
}

/// A machine with no mode (registered before T-108, or set back to it) keeps
/// the behaviour it had before limits: its attempts are reserved as legacy and
/// carry no limits (digest v1), so nothing is held and nothing is refused for
/// lack of it; an attempt an older Core reserved (no mode at all) is the same.
/// Windows always carries its limits (T-108 review R1, Lead seq 4179), except
/// an attempt an older Core already pinned without them (review R2).
#[tokio::test]
async fn a_machine_without_a_mode_keeps_the_record_only_behaviour_it_had_before_limits() {
    let lab = lab();
    let legacy = RemoteMachine { limit_mode: None, ..lab.ws.store.machine("m1").unwrap() };
    lab.ws.store.update_machine(&legacy).unwrap();
    let ran = submit(&lab, "legacy", "echo ran");
    let ended = until(&lab, &lab.ssh, &ran, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!((ended["status"].as_str(), ended["executor"]["limitMode"].as_str()), (Some("succeeded"), Some("legacy")), "{ended}");
    assert!(remote::spec(&ended).get("limits").is_none(), "no limits in the request");
    assert_eq!(ended["remote"]["digest"], json!(remote::digest(&remote::spec(&ended))));
    assert!(ended["result"]["evidence"]["result"]["limits"].is_null(), "{ended}");
    // An attempt an older Core reserved has no mode: it carries no limits either.
    let older = json!({"argv":["true"],"cwd":"/","env":{},"timeoutSeconds":5,"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},"executor":{"kind":"ssh"}});
    assert!(remote::spec(&older).get("limits").is_none());
    // Windows without a recorded mode is strict: its Job Object holds the limits.
    let windows = json!({"argv":["true"],"cwd":"C:\\","env":{},"timeoutSeconds":5,"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},"executor":{"kind":"windows"}});
    assert_eq!(remote::spec(&windows)["limits"]["mode"], "strict");
    // Pinned by this Core, its digest is v2 and its start carries the limits.
    let mut pinned = windows.clone();
    pinned["remote"] = json!({"digest": remote::digest(&remote::spec(&windows))});
    assert_eq!(remote::spec(&pinned)["limits"]["mode"], "strict");
    // Pinned by an older Core with the v1 digest of the request without limits,
    // the start is sent as it was pinned, or the helper would refuse it (review R2).
    let v1 = remote::digest(&json!({"argv":["true"],"cwd":"C:\\","env":{},"timeoutSeconds":5}));
    let mut older = windows.clone();
    older["remote"] = json!({"digest": v1});
    assert!(remote::spec(&older).get("limits").is_none());
    assert_eq!(remote::digest(&remote::spec(&older)), v1);
    // Running, it says its CPU and RAM are only declared, never held.
    let mut running = older.clone();
    running["id"] = json!("j");
    running["attempt"] = json!("a");
    running["executor"]["machineName"] = json!("Windows");
    let said = remote::evidence(&running, &json!({"status":"running","started":{"pid":8,"jobObject":"Local\\\\yuzuno-job-a"}})).unwrap();
    assert_eq!(said["reason"], "Running on Windows in its own Job Object (process 8); declared CPU and RAM are not enforced there");
    assert!(said["started"]["limits"].is_null(), "{said}");
    // Any other stored digest keeps the limits: the start then differs from
    // it and the helper refuses it; nothing is pinned again to hide that.
    let mut wrong = windows.clone();
    wrong["remote"] = json!({"digest": "0".repeat(64)});
    assert_eq!(remote::spec(&wrong)["limits"]["mode"], "strict");
    assert_ne!(remote::digest(&remote::spec(&wrong)), wrong["remote"]["digest"].as_str().unwrap());
}

/// A job with inputs or artifacts is bound when it is submitted (review of
/// the rollback path, Lead seq 4509): its digest, with the mode its limits
/// take then, is recorded and marked prebound. Queued and not yet pinned, it
/// can never be started with an older Core's shorter request: such a Core
/// records a digest only where none is, and the machine refuses a start whose
/// request does not match it, before anything is written there. This Core
/// still starts it as bound, and jobs without either are pinned at their start
/// exactly as before.
#[tokio::test]
async fn a_job_with_inputs_or_artifacts_is_bound_at_submit_so_an_older_request_never_runs_it() {
    let lab = lab();
    let limited = RemoteMachine { limit_mode: Some("limited".into()), ..lab.ws.store.machine("m1").unwrap() };
    lab.ws.store.update_machine(&limited).unwrap();
    let bound = create(&lab, input(&lab, "bound", "echo ran >> ran.txt; printf '[1]' > out.json",
        json!({"artifacts": [{"path": "out.json", "format": "json"}]})));
    assert!(bound["remote"]["prebound"].is_object(), "{bound}");
    assert_eq!(bound["executor"]["limitMode"], "limited", "{bound}");
    let pinned = bound["remote"]["digest"].as_str().unwrap().to_owned();
    assert_eq!(remote::digest(&remote::spec(&bound)), pinned);
    // A Core from before inputs and artifacts sends its own request (no
    // artifacts) with the digest it finds: the machine refuses it, writes
    // nothing for the attempt, and nothing runs.
    let machine = lab.ws.store.machine("m1").unwrap();
    let mut older = remote::bound_for_tests(&bound, &lab.ws.store.workspace_id().unwrap(), "start");
    older["expectHost"] = json!(host_a());
    for (key, value) in remote::spec(&bound).as_object().unwrap() {
        if key != "artifacts" && key != "inputs" {
            older[key] = value.clone();
        }
    }
    match remote::invoke(&lab.ssh, &machine, older).await {
        remote::Reply::Refused(message) => assert!(message.contains("digest does not match"), "{message}"),
        other => panic!("an older request was not refused: {other:?}"),
    }
    // Its root is the legacy one (no root recorded yet): nothing there either.
    let id = bound["id"].as_str().unwrap();
    assert!(!folder(&lab, &bound).exists() && !in_home(&lab, crate::remote::LEGACY_ROOT).join("jobs").join(id).exists());
    assert!(!lab.work.join("ran.txt").exists());
    // A slot taken keeps what was bound, and an older Core's pin never
    // replaces the bound digest.
    let reserved = lab.ws.store.reserve_remote(id).unwrap().unwrap();
    assert_eq!(reserved["executor"]["limitMode"], "limited", "{reserved}");
    let noted = lab.ws.store.remote_note(id, &bound["attempt"], json!({"digest": "0".repeat(64)}), None).unwrap().unwrap();
    assert_eq!(noted["remote"]["digest"], pinned.as_str());
    // This Core starts it as bound, once, and checks its artifact.
    let ended = until(&lab, &lab.ssh, &bound, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!((ended["status"].as_str(), ended["executor"]["limitMode"].as_str()), (Some("succeeded"), Some("limited")), "{ended}");
    assert_eq!(ended["remote"]["digest"], pinned.as_str());
    assert_eq!(std::fs::read_to_string(lab.work.join("ran.txt")).unwrap(), "ran\n");
    assert_eq!(ended["result"]["artifacts"][0]["ok"], true, "{ended}");
    // The machine's mode changed while one waits: neither run as bound nor
    // bound again, but not started, saying to submit it again.
    let waiting = create(&lab, input(&lab, "rebound", "touch ran-rebound",
        json!({"artifacts": [{"path": "out.json", "format": "json"}]})));
    let strict = RemoteMachine { limit_mode: Some("strict".into()), ..lab.ws.store.machine("m1").unwrap() };
    lab.ws.store.update_machine(&strict).unwrap();
    let ended = until(&lab, &lab.ssh, &waiting, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["status"], "rejected", "{ended}");
    assert_eq!(ended["reason"], "Not started: lab box's limits mode changed from limited to strict after this job was submitted, and its request was bound with the mode it had then; nothing was sent there. Submit it again to run it in the strict mode");
    assert_eq!((ended["remote"]["digest"].as_str(), ended["remote"]["startSentAt"].as_str()), (waiting["remote"]["digest"].as_str(), None), "{ended}");
    assert!(!lab.work.join("ran-rebound").exists());
    // Without inputs or artifacts nothing is bound at submit: pinned at its
    // start, with the mode the machine has then, as before.
    let plain = submit(&lab, "plain", "true");
    assert!(plain["remote"].is_null() && plain["executor"]["limitMode"].is_null(), "{plain}");
    let ended = until(&lab, &lab.ssh, &plain, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!(ended["executor"]["limitMode"], "strict", "{ended}");
    assert!(ended["remote"]["prebound"].is_null(), "{ended}");
}

/// A job bound at submit goes through what any remote job does, with one
/// attempt and the digest it was bound with: its requestId retried returns it
/// as it is; its machine cannot be re-pointed while it waits; a start lost
/// before it arrives is final and a start whose reply is lost is the same
/// attempt, run once; a cancel while it waits ends it with nothing sent.
#[tokio::test]
async fn a_job_bound_at_submit_keeps_one_attempt_and_its_digest_through_retries_lost_starts_and_cancels() {
    let lab = lab();
    let artifacts = json!({"artifacts": [{"path": "o.json", "format": "json"}]});
    let command = "echo run >> runs.txt; printf '[1]' > o.json";
    let bound = create(&lab, input(&lab, "retried", command, artifacts.clone()));
    let digest = bound["remote"]["digest"].clone();
    assert!(bound["remote"]["prebound"].is_object() && digest.is_string(), "{bound}");
    let again = lab.ws.store.previous_job(Some("a"), &input(&lab, "retried", command, artifacts.clone())).unwrap().unwrap();
    assert_eq!((&again["id"], &again["attempt"], &again["remote"]["digest"]), (&bound["id"], &bound["attempt"], &digest));
    let moved = RemoteMachine { target: "elsewhere".into(), ..lab.ws.store.machine("m1").unwrap() };
    let error = lab.ws.store.update_machine(&moved).unwrap_err().to_string();
    assert!(error.contains("Jobs still run on this machine"), "{error}");
    // The start's reply is lost after it ran: unknown, then the same attempt, once.
    let unknown = until(&lab, &lab.lossy, &bound, |j| j["status"] == "unknown").await;
    assert_eq!((&unknown["attempt"], &unknown["remote"]["digest"]), (&bound["attempt"], &digest));
    let ended = until(&lab, &lab.ssh, &bound, |j| j["reserved"] == false).await;
    assert_eq!((ended["status"].as_str(), &ended["attempt"], &ended["remote"]["digest"]), (Some("succeeded"), &bound["attempt"], &digest));
    assert_eq!(std::fs::read_to_string(lab.work.join("runs.txt")).unwrap(), "run\n");
    // A start lost before it arrived is never sent again: not started, final.
    let dropped = create(&lab, input(&lab, "dropped", "touch ran-dropped", artifacts.clone()));
    until(&lab, &lab.dropping, &dropped, |j| j["status"] == "unknown").await;
    let ended = until(&lab, &lab.ssh, &dropped, |j| j["reserved"] == false).await;
    assert_eq!((ended["status"].as_str(), &ended["remote"]["digest"]), (Some("rejected"), &dropped["remote"]["digest"]), "{ended}");
    assert!(ended["reason"].as_str().unwrap().contains("the start never reached it"), "{ended}");
    assert!(!lab.work.join("ran-dropped").exists());
    // Cancelled while it waits: nothing is sent, and the digest stays.
    let waiting = create(&lab, input(&lab, "cancelled", "touch ran-cancelled", artifacts));
    cancel(&lab, &waiting);
    let ended = until(&lab, &lab.ssh, &waiting, |j| j["reserved"] == false && j["status"] != "queued").await;
    assert_eq!((ended["status"].as_str(), &ended["remote"]["digest"]), (Some("cancelled"), &waiting["remote"]["digest"]), "{ended}");
    assert!(ended["remote"]["startSentAt"].is_null() && !lab.work.join("ran-cancelled").exists(), "{ended}");
}

/// A wake that arrives while a pass of the remote loop runs (here: a
/// submission stored after the pass read the jobs) gets a pass of its own
/// after it, even when that pass found nothing to do, without another
/// submission, cancel or the loop's idle timeout (T-108 w1: a job waited 61 s
/// for the next submission).
#[tokio::test]
async fn a_wake_during_a_pass_that_found_nothing_runs_another_pass() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let lab = lab();
    let wake = Arc::new(tokio::sync::Notify::new());
    let (entered, release, second) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()));
    let passes = Arc::new(AtomicUsize::new(0));
    let (counted, first_in, first_out, next) = (passes.clone(), entered.clone(), release.clone(), second.clone());
    let looping = tokio::spawn(remote::run(Arc::downgrade(&lab.ws), wake.clone(), false, move |_ws| {
        let (n, first_in, first_out, next) = (counted.fetch_add(1, Ordering::SeqCst), first_in.clone(), first_out.clone(), next.clone());
        async move {
            if n == 0 {
                // It has read that there is no remote job; the submission comes now.
                first_in.notify_one();
                first_out.notified().await;
            } else {
                next.notify_one();
            }
            Ok(false)
        }
    }));
    wake.notify_one();
    entered.notified().await;
    wake.notify_one();
    release.notify_one();
    let again = tokio::time::timeout(Duration::from_secs(10), second.notified()).await;
    looping.abort();
    assert!(again.is_ok(), "the wake that came during the pass got no pass of its own ({} pass(es))", passes.load(Ordering::SeqCst));
}

/// Pause on another machine (T-108): only an attempt that runs in a scope of
/// its own there, as its start's evidence names it; Windows has no pause.
#[test]
fn only_an_attempt_in_a_scope_of_its_own_can_be_paused() {
    assert_eq!(remote::pause_refusal(&json!({"executor": null})), None);
    let ssh = |held: Value| json!({"executor": {"kind": "ssh", "machineName": "lab box"},
        "result": {"started": {"limits": {"mode": "limited", "held": held}}}});
    assert_eq!(remote::pause_refusal(&ssh(json!({"unit": "yuzuno-remote-job-a.scope"}))), None);
    for bare in [ssh(Value::Null), json!({"executor": {"kind": "ssh", "machineName": "lab box"}})] {
        assert!(remote::pause_refusal(&bare).unwrap().starts_with(
            "Pause is not available for this job on lab box: it runs without a scope of its own there"));
    }
    assert_eq!(remote::pause_refusal(&json!({"executor": {"kind": "windows", "machineName": "Windows on this PC"}})).unwrap(),
        "Pause is not available for jobs on Windows on this PC: this executor has no pause, so nothing was changed");
}

/// A stand-in machine that answers every request with `reply`, echoing the
/// call's nonce as the helper does; `<name>.asked` exists once it was called.
fn replying(lab: &Lab, name: &str, reply: &Value) -> String {
    let file = lab.dir.path().join(format!("{name}.json"));
    std::fs::write(&file, reply.to_string()).unwrap();
    script(lab.dir.path().join(name), format!(
        "#!/bin/sh\n: > {}.asked\nexec python3 -c 'import json,sys; r=json.load(sys.stdin); print(\"YUZUNO-JOBS-REPLY \" + r[\"replyNonce\"] + \" \" + open(sys.argv[1]).read().strip())' {}\n",
        lab.dir.path().join(name).display(), file.display()))
}

async fn ask_pause(lab: &Lab, job: &Value, program: &str) -> Value {
    remote::control_with(&lab.ws, job, "pause", &remote::Programs { ssh: program, windows: None }).await
}

/// The running attempt's status as a machine reports it in a scope of its own
/// there, with what it read of that scope's freezer, if anything.
fn scoped_status(running: &Value, freezer: Value) -> Value {
    let started = &running["result"]["started"];
    let unit = format!("yuzuno-remote-job-{}.scope", running["attempt"].as_str().unwrap());
    let mut limits = started["limits"].clone();
    limits["held"] = json!({"unit": unit, "cgroup": format!("/user.slice/{unit}")});
    let mut reply = json!({"status": "running", "hostId": host_a(), "processes": 1,
        "started": {"startedAtUnix": started["at"], "pgid": started["pgid"], "bootId": started["bootId"], "limits": limits}});
    if !freezer.is_null() {
        reply["freezer"] = freezer;
    }
    reply
}

/// Drive a reconciliation pass until the stand-in machine `name` was asked,
/// then a while longer: its reply must still wait for the jobs gate.
async fn waits_for_gate<F: std::future::Future<Output = ()>>(lab: &Lab, name: &str, pass: &mut std::pin::Pin<Box<F>>) {
    let asked = lab.dir.path().join(format!("{name}.asked"));
    let ended = || format!("the pass ended while the jobs gate was held ({name} asked: {}): its status reply did not wait for the user's pause or resume",
        asked.exists());
    for _ in 0..100 {
        if asked.exists() {
            break;
        }
        assert!(tokio::time::timeout(Duration::from_millis(50), pass.as_mut()).await.is_err(), "{}", ended());
    }
    assert!(asked.exists(), "{name} was never asked");
    assert!(tokio::time::timeout(Duration::from_millis(500), pass.as_mut()).await.is_err(), "{}", ended());
}

/// The machine's answer to a pause or resume is recorded as for local jobs.
/// One that does not come back is unknown, never paused or running, until
/// what the machine reports of the scope (its freezer) settles it.
#[tokio::test]
async fn a_remote_pause_is_what_the_machine_answered_and_its_status_settles_one_left_open() {
    let lab = lab();
    let first = submit(&lab, "pausable", "sleep 30");
    let running = until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    let id = first["id"].as_str().unwrap();
    // The helper there refuses too: no scope of its own, nothing changed.
    let answer = ask_pause(&lab, &running, &lab.ssh).await;
    assert_eq!(answer["state"], "notPaused", "{answer}");
    assert!(answer["reason"].as_str().unwrap().contains(
        "Pause freezes only an attempt's own scope, and this attempt runs without a scope of its own on this machine"), "{answer}");
    let answer = ask_pause(&lab, &running, &lab.down).await;
    assert_eq!(answer["state"], "unknown", "{answer}");
    assert!(answer["reason"].as_str().unwrap().starts_with("lab box did not confirm the pause: "), "{answer}");
    let answer = ask_pause(&lab, &running, &lab.other).await;
    assert_eq!((answer["state"].as_str(), answer["reason"].as_str()),
        (Some("notPaused"), Some("lab box now reaches a different machine; nothing was paused there")));
    // Where the machine reports the attempt in a scope of its own (as one that
    // holds its limits), the user's pause goes as pause::control sends it.
    let unit = format!("yuzuno-remote-job-{}.scope", running["attempt"].as_str().unwrap());
    let status = |freezer: Value| scoped_status(&running, freezer);
    // Core keeps the first running report: this one, once the machine
    // answers again after a lost connection.
    tick(&lab, &lab.down).await;
    assert_eq!(job(&lab, &first)["status"], "unknown");
    tick(&lab, &replying(&lab, "ssh-scoped", &status(Value::Null))).await;
    assert_eq!(remote::pause_refusal(&job(&lab, &first)), None);
    let (asked, act) = lab.ws.store.request_job_pause(id, false).unwrap();
    assert!(act);
    assert_eq!(asked["pause"]["state"], "requested");
    let frozen = json!({"status": "control", "state": "paused", "hostId": host_a(),
        "reason": "Paused: every process in its scope on this machine is frozen; its memory and the machine's reservation are kept",
        "evidence": {"unit": unit, "freezer": {"populated": true, "frozen": true}}});
    let answer = ask_pause(&lab, &asked, &replying(&lab, "ssh-paused", &frozen)).await;
    assert_eq!(answer["state"], "paused", "{answer}");
    let paused = lab.ws.store.record_job_pause(id, &running["attempt"], false, &answer).unwrap();
    assert_eq!((paused["pause"]["state"].as_str(), paused["status"].as_str(), paused["reserved"].as_bool()),
        (Some("paused"), Some("running"), Some(true)));
    let mail = lab.ws.store.collaboration_call(Some("a"), "peer_read", json!({})).unwrap()["messages"].clone();
    let told = mail.as_array().unwrap().iter().find(|m| m["metadata"]["status"] == "paused").unwrap().clone();
    assert!(told["body"].as_str().unwrap().starts_with(&format!("Job pausable ({id}) on lab box was paused by the user")), "{told}");
    // Its status now reports the scope running: thawed outside Yuzuno, said so.
    let thawed = || json!({"populated": true, "frozen": false});
    tick(&lab, &replying(&lab, "ssh-thawed", &status(thawed()))).await;
    let now = job(&lab, &first);
    assert_eq!(now["pause"]["state"], "unknown", "{now}");
    assert!(now["pause"]["reason"].as_str().unwrap().contains("thawed outside Yuzuno"), "{now}");
    // Frozen again, as the machine reads it: paused once more.
    tick(&lab, &replying(&lab, "ssh-frozen", &status(json!({"populated": true, "frozen": true})))).await;
    assert_eq!(job(&lab, &first)["pause"]["state"], "paused");
    // A resume whose reply is lost is unknown, never running, until the
    // machine reports the scope thawed: then it is resumed.
    let (asked, act) = lab.ws.store.request_job_pause(id, true).unwrap();
    assert!(act);
    let lost = remote::control_with(&lab.ws, &asked, "resume", &remote::Programs { ssh: &lab.down, windows: None }).await;
    let unsure = lab.ws.store.record_job_pause(id, &running["attempt"], true, &lost).unwrap();
    assert_eq!((unsure["pause"]["state"].as_str(), unsure["pause"]["intent"].as_str()), (Some("unknown"), Some("resume")));
    tick(&lab, &replying(&lab, "ssh-thawed", &status(thawed()))).await;
    let resumed = job(&lab, &first);
    assert!(resumed.get("pause").is_none(), "{resumed}");
    assert_eq!(resumed["pauses"].as_array().unwrap().len(), 1, "{resumed}");
    // Cancel still reaches the attempt.
    cancel(&lab, &first);
    let ended = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(ended["status"], "cancelled", "{ended}");
}

/// A status reply that read the scope while the user's pause or resume was
/// out (review R1): it waits for that operation's answer to be recorded, as
/// pause.rs control holds the jobs gate from intent to answer, and a reading
/// taken before the operation changed the job is not applied. Each resume is
/// confirmed and told once, and a reading from before one never calls the
/// resumed job frozen outside Yuzuno.
#[tokio::test]
async fn a_status_read_around_a_resume_settles_it_once() {
    let lab = lab();
    let first = submit(&lab, "pausable", "sleep 30");
    let running = until(&lab, &lab.ssh, &first, |j| j["status"] == "running").await;
    let (id, attempt) = (first["id"].as_str().unwrap(), &running["attempt"]);
    tick(&lab, &lab.down).await;
    tick(&lab, &replying(&lab, "ssh-scoped", &scoped_status(&running, Value::Null))).await;
    let paused = json!({"state": "paused", "evidence": {},
        "reason": "Paused: every process in its scope on this machine is frozen; its memory and the machine's reservation are kept"});
    let pause = || {
        assert!(lab.ws.store.request_job_pause(id, false).unwrap().1);
        lab.ws.store.record_job_pause(id, attempt, false, &paused).unwrap()
    };
    let resume = || {
        assert!(lab.ws.store.request_job_pause(id, true).unwrap().1);
        lab.ws.store.record_job_pause(id, attempt, true, &json!({"state": "running"})).unwrap()
    };
    assert_eq!(pause()["pause"]["state"], "paused");

    // The scope reads thawed while the user's resume is out: the reply waits
    // for the resume's answer, and the resume is confirmed once.
    let gate = lab.ws.jobs.gate.lock().await;
    assert!(lab.ws.store.request_job_pause(id, true).unwrap().1);
    let thawed = replying(&lab, "ssh-thawed", &scoped_status(&running, json!({"populated": true, "frozen": false})));
    let mut pass = Box::pin(tick(&lab, &thawed));
    waits_for_gate(&lab, "ssh-thawed", &mut pass).await;
    let answered = lab.ws.store.record_job_pause(id, attempt, true, &json!({"state": "running"})).unwrap();
    assert!(answered.get("pause").is_none(), "{answered}");
    drop(gate);
    pass.await;
    let now = job(&lab, &first);
    assert!(now.get("pause").is_none(), "{now}");
    assert_eq!(now["pauses"].as_array().unwrap().len(), 1, "{now}");
    assert!(now["pauses"][0]["requestedAt"].is_string() && now["pauses"][0]["confirmedAt"].is_string(), "{now}");

    // Paused again; a status call reads the scope still frozen, and its reply
    // comes back after the user's resume was answered: it is not applied.
    assert_eq!(pause()["pause"]["state"], "paused");
    let gate = lab.ws.jobs.gate.lock().await;
    let frozen = replying(&lab, "ssh-frozen", &scoped_status(&running, json!({"populated": true, "frozen": true})));
    let mut pass = Box::pin(tick(&lab, &frozen));
    waits_for_gate(&lab, "ssh-frozen", &mut pass).await;
    assert!(resume().get("pause").is_none());
    drop(gate);
    pass.await;
    let now = job(&lab, &first);
    assert!(now.get("pause").is_none(), "{now}");
    assert_eq!(now["pauses"].as_array().unwrap().len(), 2, "{now}");
    // The next reading, taken after the resume, is applied as usual.
    tick(&lab, &frozen).await;
    let now = job(&lab, &first);
    assert_eq!((now["pause"]["state"].as_str(), now["pause"]["requestedAt"].as_str()), (Some("paused"), None), "{now}");
    assert!(now["pause"]["reason"].as_str().unwrap().starts_with("Frozen outside Yuzuno"), "{now}");

    // Told once per change: two pauses by the user, one frozen outside it,
    // two resumes.
    let mail = lab.ws.store.collaboration_call(Some("a"), "peer_read", json!({})).unwrap()["messages"].clone();
    let told = |status: &str| mail.as_array().unwrap().iter().filter(|m| m["metadata"]["status"] == status).count();
    assert_eq!((told("paused"), told("resumed")), (3, 2), "{mail}");
    cancel(&lab, &first);
    let ended = until(&lab, &lab.ssh, &first, |j| j["reserved"] == false).await;
    assert_eq!(ended["status"], "cancelled", "{ended}");
}
