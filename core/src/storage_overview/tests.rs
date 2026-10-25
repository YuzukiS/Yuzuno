use super::*;
use crate::model::AgentDetail;
use std::{fs, os::unix::fs::symlink, path::PathBuf};

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

/// A data folder with Core's own folders, an unknown one, an earlier database
/// copy and a link out of it.
fn fixture() -> (tempfile::TempDir, Arc<Workspace>, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused".into()).unwrap();
    write(&data.join("input-images/a/one.png"), 1000);
    write(&tmp.path().join("outside/big.bin"), 1 << 20);
    write(&data.join("jobs/j1/log-0.bin"), 2000);
    write(&data.join("claude-runtime/key/runtime.js"), 500);
    write(&data.join("someone-elses/notes.txt"), 300);
    write(&data.join("workspace.before-record-rows-20260101T000000Z.sqlite"), 700);
    write(&data.join("backup-operations.json"), 20);
    symlink(tmp.path().join("outside"), data.join("elsewhere")).unwrap();
    (tmp, ws, data)
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
    // Folders are named, never walked: their size is not given.
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
    let journal = entry(&overview, "backup-operations.json");
    assert_eq!((journal["what"].as_str(), journal["backup"].as_str()), (Some("backupOperations"), Some("excluded")), "{journal}");
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
}
