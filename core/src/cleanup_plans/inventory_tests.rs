//! YN-74 ④a (design 7, ④a): `cleanup_inventory`'s command is Core's alone;
//! it runs to an inventory of its schema on this host and on an SSH machine
//! (a stand-in on this host); and without a usable python3 nothing is
//! submitted, so there is never an empty inventory.
use super::inventory::{self, Prepared, FOLDER, JOB_NAME};
use super::*;
use crate::remote::RemoteMachine;

/// ssh's options and the destination skipped; what is left is the command.
const SSH_ARGS: &str = "while [ $# -gt 0 ]; do case \"$1\" in -T) shift;; -o) shift 2;; *) break;; esac; done\nshift\n";

fn stand_in(lab: &Lab, name: &str, body: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    // Not lab.root()/other, which is the Other Project's folder.
    let path = lab.root().join(format!("stand-in-{name}"));
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.display().to_string()
}

async fn take(lab: &Lab, actor: Option<&str>, input: Value) -> Result<Value> {
    lab.ws.collaboration_call(actor, "cleanup_inventory", input).await
}

fn inventory_jobs(lab: &Lab) -> i64 {
    lab.ws.store.db.read().unwrap()
        // The lab's own seeded inventory `inv` aside.
        .query_row("SELECT COUNT(*) FROM local_jobs WHERE json_extract(data,'$.name')=?1 AND id<>'inv'", [JOB_NAME], |r| r.get(0)).unwrap()
}

fn job(lab: &Lab, id: &str) -> Value {
    let data: String = lab.ws.store.db.read().unwrap().query_row("SELECT data FROM local_jobs WHERE id=?1", [id], |r| r.get(0)).unwrap();
    serde_json::from_str(&data).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    serde_json::from_value(value.clone()).unwrap()
}

/// The task's Project gets a folder on machine `m1`.
fn folder_on(lab: &Lab, machine: &str, folder: &Path) {
    let demo = lab.ws.store.projects().unwrap().into_iter().find(|p| p.name == "Demo").unwrap();
    lab.ws.store.update_project(&demo.id, crate::projects::ProjectChange {
        name: None, key: None, archived: None,
        default_dirs: BTreeMap::from([(machine.to_owned(), Some(folder.display().to_string()))]),
    }).unwrap();
}

/// A worktree with a commit of its own, and a cache folder in the scratch root.
fn workspace(lab: &Lab) -> (PathBuf, PathBuf) {
    let tree = lab.project.join(".worktrees/ahead");
    git(&lab.project, &["worktree", "add", "-q", "-b", "feat/ahead", &tree.display().to_string()]);
    std::fs::write(tree.join("mine.txt"), "mine\n").unwrap();
    git(&tree, &["add", "mine.txt"]);
    git(&tree, &["commit", "-q", "-m", "mine"]);
    let cache = lab.scratch.join("job-1/.pytest_cache");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join("CACHEDIR.TAG"), TAG_PYTEST).unwrap();
    (tree, cache)
}

#[tokio::test]
async fn the_command_is_core_s_and_runs_here_to_an_inventory_of_its_schema() {
    let lab = lab();
    let (tree, cache) = workspace(&lab);
    // Nothing of the command is the caller's, and only the task's executor asks.
    for extra in [json!({"argv": ["/bin/sh"]}), json!({"cwd": "/"}), json!({"env": {"PATH": "/tmp"}}), json!({"project": "/"})] {
        let mut input = json!({"requestId": "x", "taskId": "T-1"});
        input.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let error = take(&lab, Some("ex"), input).await.unwrap_err().to_string();
        assert!(error.starts_with("invalid_input:"), "{error}");
    }
    for who in [Some("lead"), Some("stranger"), None] {
        let error = take(&lab, who, json!({"requestId": "x", "taskId": "T-1"})).await.unwrap_err().to_string();
        assert!(error.starts_with("not_executor:"), "{who:?}: {error}");
    }
    for machine in ["windows", "agent"] {
        let error = take(&lab, Some("ex"), json!({"requestId": "x", "taskId": "T-1", "machineId": machine})).await.unwrap_err().to_string();
        assert!(error.starts_with("unsupported_machine:"), "{error}");
    }
    let error = take(&lab, Some("ex"), json!({"requestId": "x", "taskId": "T-1", "machineId": "m9"})).await.unwrap_err().to_string();
    assert!(error.starts_with("unknown_machine:"), "{error}");
    assert_eq!(inventory_jobs(&lab), 0);

    // The job_submit Core makes, short of the systemd user manager a local Job needs.
    let Prepared::New { actor, submit, .. } = inventory::prepare(&lab.ws, Some("ex".into()), json!({"requestId": "inv-1", "taskId": "T-1"}))
        .await.unwrap() else { panic!("a first call is new") };
    assert_eq!(actor, "ex");
    let python = inventory::local_python("python3").await.unwrap();
    assert!(python.executable.starts_with('/'), "{python:?}");
    let out = submit["artifacts"][0]["path"].as_str().unwrap().to_owned();
    assert!(out.ends_with(".json") && !out.contains('/'), "{out}");
    let rules = super::rules::table(&super::rules::enabled(&Settings::default(), None));
    let roots = vec![lab.ws.data_dir.join("t").display().to_string()];
    let expected = inventory::command(&python.executable, &lab.project.display().to_string(), &[lab.scratch.display().to_string()], &[], &roots, &rules, &out);
    assert_eq!(strings(&submit["argv"]), expected);
    assert_eq!(strings(&submit["argv"])[1..4], ["-I".to_owned(), "-c".to_owned(), inventory::loader().to_owned()]);
    assert_eq!(submit["cwd"], json!(lab.ws.data_dir.join(FOLDER)));
    assert_eq!((&submit["name"], &submit["guardGit"], submit.get("machineId")), (&json!(JOB_NAME), &json!(false), None));
    assert_eq!(submit["artifacts"], json!([{"path": out, "format": "json"}]));
    assert_eq!(submit["env"], json!({"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}));
    assert_eq!(submit["requestId"], "cleanup-inventory/inv-1");

    // Run as the Job runs it: its argv, cwd and env alone.
    let argv = strings(&submit["argv"]);
    let cwd = PathBuf::from(submit["cwd"].as_str().unwrap());
    let mut command = std::process::Command::new(&argv[0]);
    command.args(&argv[1..]).current_dir(&cwd).env_clear();
    for (key, value) in submit["env"].as_object().unwrap() {
        command.env(key, value.as_str().unwrap());
    }
    let done = command.output().unwrap();
    assert!(done.status.success(), "{}", String::from_utf8_lossy(&done.stderr));
    let file: Value = serde_json::from_slice(&std::fs::read(cwd.join(&out)).unwrap()).unwrap();
    assert_eq!((file["schema"].as_str(), file["version"].as_u64(), file["complete"].as_bool()),
        (Some("yuzuno.cleanup-inventory"), Some(1), Some(true)));
    let ahead = file["worktrees"].as_array().unwrap().iter().find(|w| w["path"] == tree.display().to_string()).unwrap();
    assert_eq!((ahead["git"]["uniqueCommits"].as_u64(), ahead["git"]["merged"].as_bool()), (Some(1), Some(false)));
    assert!(file["cacheDirs"].as_array().unwrap().iter().any(|c| c["path"] == cache.display().to_string() && c["rule"] == "cachedir-tag"),
        "{}", file["cacheDirs"]);
    // Nothing of it is in the Project's folder.
    assert_eq!(git(&lab.project, &["status", "--porcelain", "--untracked-files=all"]), "");
}

#[tokio::test]
async fn without_a_usable_python3_here_nothing_is_submitted() {
    let lab = lab();
    let cases = [
        (lab.root().join("no-python3").display().to_string(), "inventory_unavailable: python3 not found on this Core's host"),
        (stand_in(&lab, "apple", "#!/bin/sh\necho 'xcode-select: note: No developer tools were found, requesting install.' >&2\nexit 1\n"),
            "inventory_unavailable: python3 on this Core's host is Apple's stand-in"),
        (stand_in(&lab, "old", "#!/bin/sh\necho 'YUZUNO-PYTHON {\"version\": [2, 7, 18], \"executable\": \"/usr/bin/python\"}'\n"),
            "inventory_unavailable: python3 on this Core's host is 2.7.18, older than the 3.6"),
        (stand_in(&lab, "other", "#!/bin/sh\necho 'Python 3.12.3'\n"), "inventory_unavailable: python3 on this Core's host did not answer as Python 3 does"),
        (stand_in(&lab, "twice", "#!/bin/sh\necho 'YUZUNO-PYTHON {\"version\": [3, 12, 3]}'\necho 'YUZUNO-PYTHON {\"version\": [3, 12, 3]}'\n"),
            "inventory_unavailable: python3 on this Core's host did not answer as Python 3 does"),
        (stand_in(&lab, "broken", "#!/bin/sh\necho 'boom' >&2\nexit 2\n"), "inventory_unavailable: python3 on this Core's host exited 2: boom"),
    ];
    for (program, expected) in cases {
        *lab.ws.cleanup.python.lock().unwrap() = Some(program);
        let error = take(&lab, Some("ex"), json!({"requestId": "r", "taskId": "T-1"})).await.unwrap_err().to_string();
        assert!(error.starts_with(expected), "{error}");
    }
    assert_eq!(inventory_jobs(&lab), 0, "nothing submitted");
    let folder = lab.ws.data_dir.join(FOLDER);
    assert!(!folder.exists() || std::fs::read_dir(&folder).unwrap().next().is_none(), "nothing written");
}

#[tokio::test]
async fn on_an_ssh_machine_it_runs_there_with_the_python3_that_answered() {
    let lab = lab();
    crate::jobs::hold_loops_for_tests(&lab.ws);
    let root = lab.root();
    let there = root.join("m1-home");
    std::fs::create_dir_all(&there).unwrap();
    std::fs::write(root.join("machine-id"), "0123456789abcdef0123456789abcdef\n").unwrap();
    std::fs::write(root.join("capabilities.json"), r#"{"manager": false, "busctl": false, "delegated": [], "linger": false}"#).unwrap();
    let env = format!("HOME={} YUZUNO_JOBS_MACHINE_ID_FILE={} YUZUNO_JOBS_CAPABILITIES_FILE={}",
        there.display(), root.join("machine-id").display(), root.join("capabilities.json").display());
    let ssh = stand_in(&lab, "ssh", &format!("#!/bin/sh\n{SSH_ARGS}{env} exec /bin/sh -c \"$1\"\n"));
    let down = stand_in(&lab, "ssh-down", "#!/bin/sh\necho 'ssh: connect to host lab-box port 22: Connection refused' >&2\nexit 255\n");
    let nopython = stand_in(&lab, "ssh-nopython", "#!/bin/sh\ncat >/dev/null\necho 'sh: 1: python3: not found' >&2\nexit 127\n");
    let apple = stand_in(&lab, "ssh-apple",
        "#!/bin/sh\ncat >/dev/null\necho 'xcode-select: note: No developer tools were found, requesting install.' >&2\nexit 1\n");
    lab.ws.store.add_machine(&RemoteMachine {
        id: "m1".into(), name: "lab box".into(), target: "lab-box".into(), codex: "codex".into(),
        default_cwd: there.display().to_string(), limit_mode: Some("limited".into()), ..Default::default()
    }).unwrap();
    let ask = |request: &str| json!({"requestId": request, "taskId": "T-1", "machineId": "m1"});
    *lab.ws.cleanup.ssh.lock().unwrap() = Some(ssh.clone());
    let error = take(&lab, Some("ex"), ask("r0")).await.unwrap_err().to_string();
    assert!(error.starts_with("no_project_folder:") && error.contains("m1"), "{error}");
    // The stand-in machine is this host: the Project's folder there is the same one.
    folder_on(&lab, "m1", &lab.project);
    for (program, expected) in [
        (&nopython, "inventory_unavailable: python3 cannot run on lab box: it has no usable python3 (sh: 1: python3: not found"),
        (&apple, "inventory_unavailable: python3 cannot run on lab box: its python3 is Apple's stand-in"),
        (&down, "inventory_unavailable: lab box did not answer: SSH: ssh: connect to host lab-box"),
    ] {
        *lab.ws.cleanup.ssh.lock().unwrap() = Some(program.clone());
        let error = take(&lab, Some("ex"), ask("r1")).await.unwrap_err().to_string();
        assert!(error.starts_with(expected), "{error}");
    }
    assert_eq!(inventory_jobs(&lab), 0, "nothing submitted");

    *lab.ws.cleanup.ssh.lock().unwrap() = Some(ssh.clone());
    let answer = take(&lab, Some("ex"), ask("r1")).await.unwrap();
    let id = answer["jobId"].as_str().unwrap().to_owned();
    let queued = job(&lab, &id);
    assert_eq!((queued["target"]["machineId"].as_str(), queued["name"].as_str()), (Some("m1"), Some(JOB_NAME)), "{queued}");
    let argv = strings(&queued["argv"]);
    let out = format!("{FOLDER}/{}", answer["artifact"].as_str().unwrap().rsplit('/').next().unwrap());
    assert!(argv[0].starts_with('/'), "the python3 that answered, by its path: {argv:?}");
    // Settings' scratch roots and protected paths are this host's: none are sent.
    let rules = super::rules::table(&super::rules::enabled(&Settings::default(), None));
    assert_eq!(argv, inventory::command(&argv[0], &lab.project.display().to_string(), &[], &[], &[], &rules, &out));
    assert_eq!(queued["cwd"], json!(there.join(".yuzuno")), "the data root its hello named");
    let dir = Path::new(&argv[0]).parent().unwrap().display().to_string();
    assert_eq!(queued["env"]["PATH"], json!(format!("{dir}:/usr/local/bin:/usr/bin:/bin")));
    // A retry is the same Job, asked of nobody; the same requestId elsewhere is another call.
    *lab.ws.cleanup.ssh.lock().unwrap() = Some(down.clone());
    assert_eq!(take(&lab, Some("ex"), ask("r1")).await.unwrap()["jobId"], json!(id));
    let error = take(&lab, Some("ex"), json!({"requestId": "r1", "taskId": "T-1"})).await.unwrap_err().to_string();
    assert!(error.starts_with("idempotency_conflict:"), "{error}");
    assert_eq!(inventory_jobs(&lab), 1);

    let mut done = Value::Null;
    for _ in 0..200 {
        crate::jobs::remote_tick_for_tests(&lab.ws, &ssh).await.unwrap();
        done = job(&lab, &id);
        if done["reserved"] == false && matches!(done["status"].as_str(), Some("succeeded" | "failed" | "cancelled" | "rejected")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(done["status"], "succeeded", "{done}");
    let artifact = &done["result"]["artifacts"][0];
    assert_eq!((artifact["path"].as_str(), artifact["ok"].as_bool()), (Some(out.as_str()), Some(true)), "{done}");
    let file: Value = serde_json::from_slice(&std::fs::read(there.join(".yuzuno").join(&out)).unwrap()).unwrap();
    assert_eq!(file["schema"], "yuzuno.cleanup-inventory");
    assert!(file["worktrees"].as_array().unwrap().iter().any(|w| w["path"] == lab.project.display().to_string() && w["main"] == true));
    assert!(file["scratch"].as_array().unwrap().is_empty());
    // A plan from it is registered, with every item refused (design 5).
    let mut input = plan_input("from-m1", vec![group("g", "delete")], vec![item("x", "g", "entry", &lab.scratch.join("x"))]);
    input["inventory"] = json!({"jobId": id, "attempt": done["result"]["attempt"], "path": out, "sha256": artifact["sha256"]});
    let plan = submit_as(&lab, Some("ex"), input).await.unwrap();
    assert_eq!(plan["machine"], "lab box");
    assert_eq!(refused(&item_states(&lab, &plan).await, "x"), "remote");
}

#[test]
fn the_probe_is_read_by_its_exit_status_and_its_one_line() {
    let ok = inventory::read_probe(Some(0), b"banner\nYUZUNO-PYTHON {\"version\": [3, 6, 0], \"executable\": \"/opt/py/bin/python3\"}\n", "").unwrap();
    assert_eq!(ok, inventory::Python { version: "3.6.0".into(), executable: "/opt/py/bin/python3".into() });
    let unnamed = inventory::read_probe(Some(0), b"YUZUNO-PYTHON {\"version\": [3, 12, 1], \"executable\": \"\"}\n", "").unwrap();
    assert_eq!(unnamed.executable, "python3", "found by the Job's PATH");
    for (code, out, err, expected) in [
        (Some(127), &b""[..], "sh: python3: not found", "python3 on this Core's host cannot be run"),
        (Some(1), &b""[..], "xcrun: error: invalid active developer path", "python3 on this Core's host is Apple's stand-in"),
        (Some(0), &b"YUZUNO-PYTHON {\"version\": [3, 5, 9]}\n"[..], "", "python3 on this Core's host is 3.5.9, older than the 3.6"),
        (Some(0), &b"YUZUNO-PYTHON {}\n"[..], "", "python3 on this Core's host did not say its version"),
        (None, &b""[..], "", "python3 on this Core's host was ended by a signal"),
    ] {
        let why = inventory::read_probe(code, out, err).unwrap_err();
        assert!(why.starts_with(expected), "{why}");
    }
}


/// YN-74 ④b (Lead mail 10783): a read-only executor reads its own task's Jobs
/// and no other; job_get and job_logs refuse another task's with not_own_job.
#[tokio::test]
async fn a_read_only_executor_reads_only_its_own_task_s_jobs() {
    let lab = lab();
    lab.ws.store.collaboration_call(None, "task_create", json!({"requestId": "other", "title": "Other work", "status": "doing"})).unwrap();
    let (own, other) = ("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
    {
        let db = lab.ws.store.db.write().unwrap();
        for (id, key) in [(own, "T-1"), (other, "T-2")] {
            let (task, _) = collaboration::task_key(&db, key).unwrap();
            let data = json!({"id": id, "taskId": task, "agentId": "lead", "attempt": ATTEMPT, "status": "succeeded",
                "target": {"kind": "local"}, "result": {"attempt": ATTEMPT, "artifacts": []}});
            db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'lead','succeeded',?3)", params![id, task, data.to_string()]).unwrap();
        }
    }
    let read = |tool: &'static str, job: &'static str| {
        let ws = lab.ws.clone();
        async move { ws.collaboration_call(Some("ex"), tool, json!({"jobId": job})).await.map_err(|e| e.to_string()) }
    };
    // Before it is read-only, it reads both, as any Agent does.
    assert!(read("job_get", other).await.is_ok());
    lab.ws.store.set_permission_level("ex", Some(crate::permission_levels::READ_ONLY)).unwrap();
    for tool in ["job_get", "job_logs"] {
        let error = read(tool, other).await.unwrap_err();
        assert!(error.starts_with("not_own_job:") && error.contains(other), "{tool}: {error}");
        // By a unique prefix, as mail names it, too.
        let error = read(tool, "22222222").await.unwrap_err();
        assert!(error.starts_with("not_own_job:"), "{tool}: {error}");
        if let Err(error) = read(tool, own).await {
            assert!(!error.starts_with("not_own_job"), "its own task's Job: {tool}: {error}");
        }
    }
    assert_eq!(read("job_get", own).await.unwrap()["id"], own);
    // Another Agent, not read-only, still reads it.
    assert!(lab.ws.collaboration_call(Some("lead"), "job_get", json!({"jobId": other})).await.is_ok());
}

/// YN-78 S2b-1: the complete protected-root set travels in the job's command.
/// When it cannot fit, the inventory is refused, never shortened.
#[tokio::test]
async fn a_protection_set_too_large_for_a_job_command_is_refused() {
    let lab = lab();
    let workspace = lab.ws.store.workspace_id().unwrap();
    {
        let db = lab.ws.store.db.write().unwrap();
        let mut insert = db.prepare(
            "INSERT INTO executor_temp_dirs(workspace_id,agent_id,path,dev,ino,created_at) VALUES(?1,?2,?3,0,0,'now')",
        ).unwrap();
        for i in 0..40 {
            let agent = format!("agent-{i:04}");
            // Few enough entries to reach the byte limit first, with paths
            // long enough to pass 16 KiB.
            let root = format!("/synthetic/roots/{i}/{}", "x".repeat(600));
            insert.execute(params![workspace, agent, format!("{root}/t/agent")]).unwrap();
        }
    }
    let error = take(&lab, Some("ex"), json!({"requestId": "big", "taskId": "T-1"})).await.unwrap_err().to_string();
    assert!(error.starts_with("inventory_unavailable:") && error.contains("16384"), "{error}");
    assert_eq!(inventory_jobs(&lab), 0, "nothing submitted");
}

/// YN-78 S2b-1: a Job's argv also holds at most 128 entries. Many short roots
/// exceed that long before 16 KiB, and are refused, never truncated.
#[tokio::test]
async fn a_short_but_numerous_protection_set_is_refused_by_the_entry_limit() {
    let lab = lab();
    let workspace = lab.ws.store.workspace_id().unwrap();
    {
        let db = lab.ws.store.db.write().unwrap();
        let mut insert = db.prepare(
            "INSERT INTO executor_temp_roots(workspace_id,path,origin,registered_at) VALUES(?1,?2,'default','now')",
        ).unwrap();
        // With the default root this makes 60 roots: 10 fixed entries plus 120
        // `--root path` entries, over 128, and well under 16 KiB.
        for i in 0..59 {
            insert.execute(params![workspace, format!("/r{i}")]).unwrap();
        }
    }
    let error = take(&lab, Some("ex"), json!({"requestId": "many-short", "taskId": "T-1"})).await.unwrap_err().to_string();
    assert!(error.starts_with("inventory_unavailable:") && error.contains("entries") && error.contains("128"), "{error}");
    assert_eq!(inventory_jobs(&lab), 0, "nothing submitted");
}

/// ③a: the script travels packed (a Job's argv holds 16 KiB); the loader
/// unpacks exactly the repository's file, and a long command still fits.
#[test]
fn the_loader_unpacks_exactly_the_script_and_the_command_fits_a_job() {
    use base64::Engine as _;
    use std::io::Read as _;
    let loader = inventory::loader();
    let packed = loader.split('\'').nth(1).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD.decode(packed).unwrap();
    let mut unpacked = String::new();
    flate2::read::ZlibDecoder::new(&bytes[..]).read_to_string(&mut unpacked).unwrap();
    assert_eq!(unpacked, inventory::SOURCE);
    let all: BTreeSet<&'static str> = super::rules::ids().into_iter().map(|(id, _)| id).collect();
    let roots: Vec<String> = (0..5).map(|i| format!("/synthetic/scratch/root-number-{i}/with/a/longer/path")).collect();
    let argv = inventory::command("/opt/homebrew/opt/python@3.12/bin/python3.12", "/synthetic/home/someone/work/a-project-folder", &roots, &roots, &roots,
        &super::rules::table(&all), "cleanup-inventories/0123456789abcdef0123456789abcdef.json");
    let bytes: usize = argv.iter().map(String::len).sum();
    assert!(argv.len() <= 128, "every rule on, five scratch roots, protected paths and temporary roots: {} entries", argv.len());
    assert!(bytes <= 16384, "every rule on, five scratch roots, protected paths and temporary roots: {bytes} bytes");
}
