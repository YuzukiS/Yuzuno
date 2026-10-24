use super::*;
use crate::model::AgentDetail;
use std::{fs, os::unix::fs::symlink};

fn agent(id: &str, harness: &str, session: bool, closed: bool, machine: Option<&str>) -> AgentDetail {
    let mut agent = json!({"id": id, "name": format!("Agent {id}"), "cwd": "/workspace", "model": "test",
        "color": "sage", "harness": harness, "status": "idle", "createdAt": "now", "updatedAt": "now",
        "unreadCount": 0, "pendingCount": 0, "lastSeq": 0, "reviewedSeq": 0});
    if session {
        let key = match harness { "claude" => "claudeSessionId", "opencode" => "opencodeSessionId", _ => "threadId" };
        agent[key] = json!(format!("session-{id}"));
    }
    if closed {
        agent["closedAt"] = json!("now");
    }
    if let Some(name) = machine {
        agent["remote"] = json!({"machine": {"id": "m1", "name": name, "target": "lab", "codex": "codex", "defaultCwd": "/w"}});
    }
    serde_json::from_value(json!({"agent": agent, "turns": [], "pending": [], "artifacts": []})).unwrap()
}

fn write(path: &Path, bytes: usize) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, vec![b'x'; bytes]).unwrap();
}

fn entry<'a>(overview: &'a Value, name: &str) -> &'a Value {
    overview["entries"].as_array().unwrap().iter().find(|e| e["name"] == name).unwrap_or_else(|| panic!("{name}: {overview}"))
}

fn folder<'a>(measurement: &'a Value, name: &str) -> &'a Value {
    measurement["folders"].as_array().unwrap().iter().find(|f| f["name"] == name).unwrap_or_else(|| panic!("{name}: {measurement}"))
}

/// A data folder with Core's own folders, an unknown one, an earlier database
/// copy and a link out of it to a large file elsewhere.
fn fixture() -> (tempfile::TempDir, Arc<Workspace>, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused".into()).unwrap();
    write(&data.join("input-images/a/one.png"), 1000);
    fs::hard_link(data.join("input-images/a/one.png"), data.join("input-images/a/same.png")).unwrap();
    write(&tmp.path().join("outside/big.bin"), 1 << 20);
    symlink(tmp.path().join("outside/big.bin"), data.join("input-images/a/elsewhere.png")).unwrap();
    write(&data.join("jobs/j1/log-0.bin"), 2000);
    write(&data.join("claude-runtime/key/runtime.js"), 500);
    write(&data.join("someone-elses/notes.txt"), 300);
    write(&data.join("workspace.before-record-rows-20260101T000000Z.sqlite"), 700);
    symlink(tmp.path().join("outside"), data.join("elsewhere")).unwrap();
    (tmp, ws, data)
}

fn until_ended(data: &Path) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let measurement = view(data);
        if measurement["state"] != "running" {
            return measurement;
        }
        assert!(Instant::now() < deadline, "the measurement ends: {measurement}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_overview_names_each_entry_without_walking_it_and_says_what_a_backup_copies() {
    let (_tmp, ws, data) = fixture();
    for detail in [
        agent("c1", "codex", true, false, None),
        agent("c2", "codex", true, true, None),
        agent("c3", "codex", false, false, None),
        agent("k1", "claude", true, false, Some("lab box")),
        agent("o1", "opencode", true, false, None),
    ] {
        ws.store.insert(&detail).unwrap();
    }
    let overview = read(&ws.store, &data).unwrap();
    assert_eq!(overview["format"], 1);
    assert_eq!(overview["dataDir"], data.to_string_lossy().as_ref());
    // Folders are named, never walked: no size until a measurement.
    for (name, what, backup) in [
        ("input-images", "inputImages", "copied"),
        ("jobs", "jobs", "copied"),
        ("claude-runtime", "claudeRuntime", "excluded"),
        ("someone-elses", "unknown", "notCopied"),
    ] {
        let e = entry(&overview, name);
        assert_eq!((e["what"].as_str(), e["kind"].as_str(), e["backup"].as_str()), (Some(what), Some("folder"), Some(backup)), "{e}");
        assert!(e.get("bytes").is_none() && e.get("diskBytes").is_none(), "{name} is not walked: {e}");
    }
    assert_eq!(entry(&overview, "claude-runtime")["backupReason"], "A cache of the Claude runtime, which Core rebuilds");
    let copy = entry(&overview, "workspace.before-record-rows-20260101T000000Z.sqlite");
    assert_eq!((copy["what"].as_str(), copy["kind"].as_str(), copy["bytes"].as_u64(), copy["backup"].as_str()),
        (Some("earlierDatabaseCopy"), Some("file"), Some(700), Some("notCopied")));
    let link = entry(&overview, "elsewhere");
    assert_eq!((link["kind"].as_str(), link["backup"].as_str()), (Some("link"), Some("notCopied")));
    assert!(link.get("bytes").is_none(), "a link is not followed: {link}");
    let database = entry(&overview, "workspace.sqlite");
    assert_eq!((database["what"].as_str(), database["backup"].as_str()), (Some("database"), Some("copied")));
    assert!(database["bytes"].as_u64().unwrap() > 0 && database["diskBytes"].is_u64());
    assert!(overview["database"]["pages"].as_i64().unwrap() > 0 && overview["database"]["pageSize"].as_i64().unwrap() > 0);
    assert!(overview["database"]["freePages"].is_i64());
    assert_eq!(overview["jobs"], json!({"total": 0, "unfinished": 0}));
    // Agents with a native session, by harness and machine; c3 has none yet.
    assert_eq!(overview["native"], json!([
        {"harness": "claude", "machine": "lab box", "agents": 1, "closed": 0},
        {"harness": "codex", "machine": null, "agents": 2, "closed": 1},
        {"harness": "opencode", "machine": null, "agents": 1, "closed": 0},
    ]));
    assert_eq!(overview["notInBackup"], json!(workspace_backup::NOT_COVERED));
    assert_eq!(overview["measurement"], Value::Null, "reading starts no measurement");
}

#[test]
fn a_measurement_reads_only_cores_own_folders_and_never_follows_a_link() {
    let (_tmp, ws, data) = fixture();
    let started = start(&data, ENTRIES, TIME);
    assert!(started["id"].is_string());
    let measurement = until_ended(&data);
    assert_eq!(measurement["state"], "done", "{measurement}");
    assert_eq!(measurement["id"], started["id"]);
    let images = folder(&measurement, "input-images");
    // One file and its hard link, counted once; the link to 1 MiB elsewhere is counted apart.
    assert_eq!((images["files"].as_u64(), images["bytes"].as_u64(), images["links"].as_u64(), images["complete"].as_bool()),
        (Some(1), Some(1000), Some(1), Some(true)), "{images}");
    assert!(images["diskBytes"].is_u64());
    let jobs = folder(&measurement, "jobs");
    assert_eq!((jobs["files"].as_u64(), jobs["bytes"].as_u64()), (Some(1), Some(2000)));
    assert_eq!(folder(&measurement, "claude-runtime")["bytes"], 500);
    let names: Vec<&str> = measurement["folders"].as_array().unwrap().iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["input-images", "jobs", "claude-runtime"], "only Core's own folders, in its order");
    // The overview carries the latest measurement.
    assert_eq!(read(&ws.store, &data).unwrap()["measurement"]["id"], started["id"]);
}

#[test]
fn a_measurement_stops_at_its_bounds_or_when_asked_and_runs_once_at_a_time() {
    let (_tmp, _ws, data) = fixture();
    for n in 0..20 {
        write(&data.join(format!("input-images/b/{n}.png")), 10);
    }
    // Ten entries: input images are cut short, and the folders after them are not read.
    start(&data, 10, TIME);
    let measurement = until_ended(&data);
    assert_eq!(measurement["state"], "limited", "{measurement}");
    assert_eq!(folder(&measurement, "input-images")["complete"], false);
    assert_eq!(folder(&measurement, "jobs"), &json!({"name": "jobs", "measured": false}));
    assert!(folder(&measurement, "jobs").get("bytes").is_none(), "a folder not read has no size");

    // Asked to stop: nothing more is read.
    let run = Run { id: "stopped".into(), started_at: "now".into(), stop: AtomicBool::new(true), state: Mutex::default() };
    walk_all(&data, &run, ENTRIES, TIME);
    let stopped = describe_run(&run);
    assert_eq!(stopped["state"], "stopped");
    assert!(stopped["folders"].as_array().unwrap().iter().all(|f| f["measured"] == false), "{stopped}");

    // While one runs, starting again answers with it instead of a second walk.
    let running = Arc::new(Run { id: "running".into(), started_at: "now".into(), stop: AtomicBool::new(false), state: Mutex::default() });
    RUNS.lock().unwrap().insert(data.clone(), running.clone());
    assert_eq!(start(&data, ENTRIES, TIME)["id"], "running");
    assert_eq!(request_stop(&data)["id"], "running");
    assert!(running.stop.load(Ordering::Relaxed), "stop reaches the running walk");
    RUNS.lock().unwrap().remove(&data);
}
