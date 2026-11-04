use super::*;
use crate::opencode_revert_files::{Launcher, Roots, Started, State};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");

/// One `opencode` for the whole test process, as the Agent tests have it.
#[cfg(target_os = "linux")]
fn program() {
    static PROGRAM: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    PROGRAM.get_or_init(|| {
        use std::os::unix::fs::PermissionsExt;
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        let program = dir.path().join("opencode");
        std::fs::write(&program, format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
        program
    });
}

fn agent(cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":"oc", "name":"OpenCode", "cwd":cwd, "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

/// The stand-in's control, on its own port (`start.json`).
async fn control(data: &Path, name: &str, body: Value) -> Value {
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode/oc/start.json")).unwrap()).unwrap();
    reqwest::Client::builder().no_proxy().build().unwrap()
        .post(format!("http://127.0.0.1:{}/__fixture/{name}", seen["port"])).json(&body)
        .timeout(Duration::from_secs(20)).send().await.unwrap().json().await.unwrap()
}

/// What the stand-in was asked, by method and path.
fn asked(data: &Path) -> Vec<(String, String)> {
    std::fs::read_to_string(data.join("opencode/oc/calls.jsonl")).unwrap_or_default().lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .map(|call| (call["method"].as_str().unwrap_or_default().to_owned(), call["path"].as_str().unwrap_or_default().to_owned()))
        .collect()
}

/// A Workspace with an OpenCode Agent in `cwd`, connected to the stand-in.
async fn lab(dir: &Path, cwd: &Path) -> Arc<Workspace> {
    program();
    let ws = Workspace::new(dir.join("data"), dir.to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&cwd.to_string_lossy())).unwrap();
    ws.reconnect("oc").await.unwrap();
    ws
}

/// A Turn sent and answered (with `answer`'s extra fields, such as patch
/// parts): its ID, once Core has it completed.
async fn turn(ws: &Arc<Workspace>, data: &Path, text: &str, answer: Value) -> String {
    ws.opencode_send("oc", text.into()).await.unwrap();
    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    let id = ws.store.detail("oc").unwrap().turns.last().unwrap()["id"].as_str().unwrap().to_owned();
    let mut reply = json!({"sessionID": session, "text": "done", "parentID": id});
    reply.as_object_mut().unwrap().extend(answer.as_object().unwrap().clone());
    control(data, "reply", reply).await;
    for _ in 0..400 {
        let d = ws.store.detail("oc").unwrap();
        if d.agent.status == "idle" && d.turns.iter().any(|t| t["id"] == id && t["status"] == "completed") {
            return id;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("Turn {id} did not complete: {:#?}", ws.store.detail("oc").unwrap().turns);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_preview_with_no_file_to_send_back_needs_no_snapshot_says_what_leaves_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    let before = serde_json::to_value(&ws.store.detail("oc").unwrap().turns).unwrap();

    let preview = ws.opencode_revert_preview("oc", &first).await.unwrap();
    assert_eq!((&preview["removedTurns"], &preview["keptTurns"], &preview["files"], &preview["draft"]),
        (&json!(2), &json!(0), &json!([]), &json!("first")), "{preview}");
    let preview = ws.opencode_revert_preview("oc", &second).await.unwrap();
    assert_eq!((&preview["removedTurns"], &preview["keptTurns"]), (&json!(1), &json!(1)));
    assert!(!asked(&data).iter().any(|(method, path)| method == "POST" && path.ends_with("/revert")), "nothing asked: {:?}", asked(&data));
    assert_eq!(serde_json::to_value(&ws.store.detail("oc").unwrap().turns).unwrap(), before, "nothing written");

    let error = ws.opencode_revert_preview("oc", "msg_not_ours").await.unwrap_err().to_string();
    assert!(error.contains("没有这个 Turn"), "{error}");
    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    control(&data, "revert", json!({"sessionID": session})).await;
    let error = ws.opencode_revert_preview("oc", &first).await.unwrap_err().to_string();
    assert!(error.contains("已有一次尚未处理的回退"), "{error}");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn files_to_send_back_with_an_opencode_started_through_a_script_refuse_and_say_why() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let file = cwd.join("a.txt").to_string_lossy().into_owned();
    let first = turn(&ws, &data, "first", json!({"patches": [{"hash": "a".repeat(40), "files": [file]}]})).await;
    let error = ws.opencode_revert_preview("oc", &first).await.unwrap_err().to_string();
    assert!(error.contains("无法事先核对") && error.contains("not a native executable"), "{error}");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn each_file_to_send_back_is_read_from_opencodes_own_snapshot_and_from_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(cwd.join("a.txt"), "a0\n").unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    // Where OpenCode keeps this worktree's snapshots, in a data folder of this test's own, with one taken as
    // OpenCode takes them (add everything, write the tree), then the file changed as its run would.
    let path = c.server.path().await.unwrap();
    let opencode_data = root.join("xdg-data/opencode");
    let store = crate::opencode_revert_files::store(opencode_data.to_str().unwrap(), "fixtureproject", path["worktree"].as_str().unwrap()).unwrap();
    std::fs::create_dir_all(store.parent().unwrap()).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").current_dir(&cwd).arg("--git-dir").arg(&store).arg("--work-tree").arg(&cwd)
            .args(args).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    };
    git(&["init", "-q"]);
    git(&["config", "core.autocrlf", "false"]);
    git(&["add", "-A", "."]);
    let tree = git(&["write-tree"]).trim().to_owned();
    std::fs::write(cwd.join("a.txt"), "a1\n").unwrap();
    let file = cwd.join("a.txt").to_string_lossy().into_owned();
    let first = turn(&ws, &data, "first", json!({"patches": [{"hash": tree, "files": [file]}]})).await;

    // As if Core had started a native OpenCode: the stand-in's process runs Python itself (its script execs it).
    let launcher = Launcher::resolve(Path::new("/usr/bin/python3"), None).unwrap();
    let roots = Roots { home: path["home"].as_str().unwrap().into(), state: path["state"].as_str().unwrap().into(),
        config: path["config"].as_str().unwrap().into(), data: opencode_data.to_string_lossy().into_owned() };
    ws.opencodes.lock().unwrap().get_mut("oc").unwrap().files = Arc::new(Ok(Started { launcher, roots }));

    let preview = ws.opencode_revert_preview("oc", &first).await.unwrap();
    let state = |bytes: &[u8]| serde_json::to_value(State::File {
        size: bytes.len() as u64, sha256: Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect(), executable: false,
    }).unwrap();
    assert_eq!(preview["files"], json!([{"path": file, "expected": state(b"a0\n"), "current": state(b"a1\n")}]), "{preview}");
    assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "a1\n", "nothing written");
    assert!(!asked(&data).iter().any(|(method, path)| method == "POST" && path.ends_with("/revert")));
    ws.close_agent("oc").await.unwrap();
}
