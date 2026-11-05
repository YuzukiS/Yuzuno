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
    lab_with(dir, cwd, &[]).await
}

/// `lab`, with the stand-in's switches left before it starts.
async fn lab_with(dir: &Path, cwd: &Path, switches: &[(&str, &str)]) -> Arc<Workspace> {
    program();
    let ws = Workspace::new(dir.join("data"), dir.to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&cwd.to_string_lossy())).unwrap();
    let own = dir.join("data/opencode/oc");
    std::fs::create_dir_all(&own).unwrap();
    // Rewind still reads 1.19.3's messages until its slice (T-32, Lead 4983): the stand-in sends those.
    std::fs::write(dir.join("data/opencode/v1Messages"), "1").unwrap();
    for (name, value) in switches {
        std::fs::write(own.join(name), value).unwrap();
    }
    ws.reconnect("oc").await.unwrap();
    ws
}

/// How many reverts the stand-in was asked for.
fn reverts(data: &Path) -> usize {
    asked(data).iter().filter(|(method, path)| method == "POST" && path.ends_with("/revert")).count()
}

/// The Agent's Turns, by ID.
fn turn_ids(ws: &Workspace) -> Vec<String> {
    ws.store.turn_ids("oc").unwrap()
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
async fn a_session_not_of_the_project_opencode_holds_the_folder_for_now_is_refused_with_no_file_to_send_back_too() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    // The same folder, now held for another project (as when its repository's first commit or remote changed).
    control(&data, "project", json!({"id": "otherproject"})).await;
    let error = ws.opencode_revert_preview("oc", &first).await.expect_err("a session of another project is refused").to_string();
    assert!(error.contains("不属于它现在的项目"), "{error}");
    assert!(!asked(&data).iter().any(|(method, path)| method == "POST" && path.ends_with("/revert")), "nothing asked: {:?}", asked(&data));
    control(&data, "project", json!({"id": "fixtureproject"})).await;
    assert!(ws.opencode_revert_preview("oc", &first).await.is_ok(), "its own project's session is previewed");
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

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_confirm_reads_again_keeps_its_attempt_asks_once_and_the_turns_it_reverts_leave() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    let preview = ws.opencode_revert_preview("oc", &second).await.unwrap();
    let key = preview["previewId"].as_str().unwrap().to_owned();

    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!((&outcome["status"], &outcome["draft"], &outcome["files"]), (&json!("completed"), &json!("second"), &json!([])), "{outcome}");
    assert_eq!(reverts(&data), 1, "asked once");
    assert_eq!(turn_ids(&ws), vec![first.clone()], "the Turn it reverts leaves");
    assert!(ws.pending_rewind("oc").await.unwrap()["attempt"].is_null(), "none left to check once kept");
    // Asked for by its own ID, as a client that asked for it finds it again: as it settled, its text with it.
    assert_eq!(ws.rewind_attempt_view("oc", Some(&key)).await.unwrap()["attempt"], outcome, "a settled attempt is found by its ID");
    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    assert_eq!(session.server.session(&session.session).await.unwrap()["revert"]["messageID"], json!(second), "kept in the session");
    // Until the next message a compaction would apply it first: refused, saying to send a message.
    let error = ws.opencode_compact("oc").await.expect_err("no compaction while the session holds the revert").to_string();
    assert!(error.contains("请先发一条消息"), "{error}");
    assert!(!asked(&data).iter().any(|(method, path)| method == "POST" && path.ends_with("/summarize")), "nothing asked: {:?}", asked(&data));
    // Asked again for the same preview: that attempt as it stands, nothing asked.
    assert_eq!(ws.opencode_revert_confirm("oc", &key).await.unwrap(), outcome);
    assert_eq!(reverts(&data), 1, "never asked again");
    // The next message goes on, and OpenCode applies the revert then.
    let third = turn(&ws, &data, "third", json!({})).await;
    assert_eq!(turn_ids(&ws), vec![first, third]);
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_confirm_refuses_what_changed_since_its_preview_asks_nothing_and_a_preview_is_used_once() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let preview = ws.opencode_revert_preview("oc", &first).await.unwrap();
    let key = preview["previewId"].as_str().unwrap().to_owned();
    turn(&ws, &data, "second", json!({})).await;
    let error = ws.opencode_revert_confirm("oc", &key).await.expect_err("a session changed since its preview is not reverted").to_string();
    assert!(error.contains("消息在预览之后变了"), "{error}");
    let error = ws.opencode_revert_confirm("oc", &key).await.unwrap_err().to_string();
    assert!(error.contains("已用过或已过期"), "{error}");
    assert_eq!(reverts(&data), 0, "nothing asked");
    assert!(ws.store.rewind_attempt("oc", None).unwrap().is_none(), "no attempt kept");
    assert_eq!(turn_ids(&ws).len(), 2, "nothing removed");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_revert_whose_outcome_is_unknown_holds_back_every_new_input_and_is_never_asked_again() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    control(&data, "mode", json!({"revert": "error"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "unknown", "a 500 says nothing of what it did: {outcome}");
    assert_eq!(outcome["draft"], "", "no text back while not known");
    // What a client opening the Agent again reads to check it: the same attempt, as it stands.
    assert_eq!(ws.pending_rewind("oc").await.unwrap()["attempt"], outcome, "the attempt is found again from what Core keeps");
    for (what, error) in [
        ("send", ws.opencode_send("oc", "next".into()).await.expect_err("a send is held back")),
        ("compact", ws.opencode_compact("oc").await.expect_err("a compaction is held back")),
        ("preview", ws.opencode_revert_preview("oc", &first).await.expect_err("another revert is held back")),
    ] {
        assert!(error.to_string().contains("rewind is unconfirmed"), "{what}: {error:#}");
    }
    assert_eq!(ws.opencode_revert_confirm("oc", &key).await.unwrap()["status"], "unknown");
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap()["status"], "unknown",
        "a request with no answer and no revert held stays unknown");
    assert_eq!(reverts(&data), 1, "never asked again");
    assert_eq!(turn_ids(&ws), vec![first], "nothing removed");
    assert_eq!(reverts(&data), 1, "reading it asks nothing");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_revert_opencode_refuses_before_doing_anything_has_failed_and_holds_nothing_back() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    control(&data, "mode", json!({"revert": "refuse"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "failed", "{outcome}");
    assert_eq!(outcome["draft"], "", "no text back from a revert refused");
    assert!(outcome["message"].as_str().unwrap().contains("SessionBusyError"), "{outcome}");
    assert_eq!(turn_ids(&ws), vec![first]);
    turn(&ws, &data, "next", json!({})).await;
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_answer_after_the_confirm_stopped_watching_settles_its_attempt_when_it_comes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    control(&data, "mode", json!({"revert": "late"})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "unknown", "no answer within the watch: {outcome}");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    control(&data, "goOn", json!({"sessionID": session})).await;
    let mut settled = Value::Null;
    for _ in 0..400 {
        settled = ws.rewind_check("oc", &key).await.unwrap();
        if settled["status"] != "unknown" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(settled["status"], "completed", "settled by its answer: {settled}");
    assert_eq!(settled["draft"], "second", "the text back once kept");
    // Another answer for it now changes nothing.
    let again = ws.opencode_revert_late("oc", &key, RevertAnswer::Unknown("a second answer".into())).await.unwrap();
    assert_eq!(again, settled, "a settled attempt stays as it was settled");
    assert_eq!(reverts(&data), 1, "asked once");
    assert_eq!(turn_ids(&ws), vec![first]);
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_confirm_whose_client_goes_away_once_its_answer_came_still_settles_its_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let (reached_tx, reached) = tokio::sync::oneshot::channel();
    let (proceed, proceed_rx) = tokio::sync::oneshot::channel();
    *HOLD_ANSWERED.lock().unwrap() = Some((key.clone(), reached_tx, proceed_rx));
    let request = {
        let (ws, key) = (ws.clone(), key.clone());
        tokio::spawn(async move { ws.opencode_revert_confirm("oc", &key).await })
    };
    // OpenCode has answered, and its answer has reached the confirm: nothing of it is settled yet.
    tokio::time::timeout(Duration::from_secs(20), reached).await.expect("the answer reached the confirm").unwrap();
    assert_eq!(ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap().state, "sending");
    // Its client goes away, which drops the request's handler.
    request.abort();
    let _ = request.await;
    let _ = proceed.send(());
    let mut state = String::new();
    for _ in 0..400 {
        state = ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap().state;
        if state != "sending" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(state, "completed", "settled by its answer though its client went away");
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap()["draft"], "second", "the text back once kept");
    ws.ensure_rewind_settled("oc").await.expect("the Agent is not held back");
    assert_eq!(reverts(&data), 1, "asked once");
    assert_eq!(turn_ids(&ws), vec![first]);
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_revert_opencode_confirmed_but_core_could_not_record_stays_unknown_until_a_check_records_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    *FAIL_RECORD.lock().unwrap() = Some(key.clone());
    let outcome = ws.opencode_revert_confirm("oc", &key).await;
    // OpenCode answered that the session holds it; only Core's own record failed.
    let kept = ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap();
    assert_eq!(kept.state, "unknown", "a revert OpenCode confirmed is not left sending when its record fails");
    let plan = Plan::of(&kept).unwrap();
    assert!(plan.ended.is_some() && plan.held, "it keeps that the request ended holding the revert");
    let outcome = outcome.expect("the confirm answers with the attempt as it stands");
    assert_eq!(outcome["status"], "unknown", "{outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("没能把它记下"), "{outcome}");
    assert_eq!(turn_ids(&ws), vec![first.clone(), second.clone()], "nothing removed yet");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    // Checked again: recorded now, from the answer it kept, with nothing asked again.
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("completed"), &json!("second")), "recorded when checked: {checked}");
    assert_eq!(turn_ids(&ws), vec![first.clone()], "the Turn it reverts leaves");
    ws.ensure_rewind_settled("oc").await.expect("the Agent is not held back");
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap(), checked, "checked once more, it stays as it was settled");
    assert_eq!(reverts(&data), 1, "asked once");
    let third = turn(&ws, &data, "third", json!({})).await;
    assert_eq!(turn_ids(&ws), vec![first, third]);
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_folder_written_through_a_link_is_the_agents_own_and_another_folder_is_still_refused() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let link = root.join("link");
    std::os::unix::fs::symlink(&work, &link).unwrap();
    // The Agent's folder as written through the link; OpenCode names the folder it resolves to.
    let ws = lab(&root, &link).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    assert_eq!(c.server.path().await.unwrap()["directory"], json!(work.to_string_lossy()), "OpenCode names the resolved folder");
    ws.opencode_revert_preview("oc", &first).await.expect("the same folder through a link is the Agent's own");
    // A folder that is not the Agent's, though it exists: still refused.
    let other = root.join("other");
    std::fs::create_dir_all(&other).unwrap();
    control(&data, "mode", json!({"directory": other.to_string_lossy()})).await;
    let error = ws.opencode_revert_preview("oc", &first).await.expect_err("another folder is refused").to_string();
    assert!(error.contains("不是这个 Agent 的目录"), "{error}");
    assert_eq!(reverts(&data), 0, "nothing asked");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_confirm_core_stopped_before_its_request_went_out_fails_when_checked_and_asks_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    *STOP.lock().unwrap() = Some((key.clone(), Stop::BeforeSent));
    ws.opencode_revert_confirm("oc", &key).await.expect_err("the confirm ends where Core stopped");
    let kept = ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap();
    assert_eq!((kept.state.as_str(), Plan::of(&kept).unwrap().sent), ("sending", false), "kept as Core had it");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!(checked["status"], "failed", "never sent, so failed when checked: {checked}");
    assert!(checked["message"].as_str().unwrap().contains("没有被请求"), "{checked}");
    assert_eq!(checked["draft"], "", "no text back");
    assert_eq!(reverts(&data), 0, "nothing asked");
    assert_eq!(turn_ids(&ws), vec![first, second]);
    ws.ensure_rewind_settled("oc").await.expect("the Agent is not held back");
    turn(&ws, &data, "next", json!({})).await;
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_confirm_core_stopped_after_its_request_went_out_is_reverted_once_the_session_holds_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    *STOP.lock().unwrap() = Some((key.clone(), Stop::AfterSent));
    ws.opencode_revert_confirm("oc", &key).await.expect_err("the confirm ends where Core stopped");
    // OpenCode reverted; Core kept no answer.
    let kept = ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap();
    assert_eq!((kept.state.as_str(), Plan::of(&kept).unwrap().sent), ("sending", true), "kept as Core had it");
    assert_eq!(reverts(&data), 1, "asked once");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("completed"), &json!("second")),
        "reverted when the session holds it: {checked}");
    assert_eq!(turn_ids(&ws), vec![first]);
    ws.ensure_rewind_settled("oc").await.expect("the Agent is not held back");
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap(), checked, "checked once more, it stays as it was settled");
    assert_eq!(reverts(&data), 1, "never asked again");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_request_with_no_answer_kept_and_no_revert_held_stays_unknown_when_checked() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    // OpenCode does nothing of it (a 500), and Core keeps no answer: nothing tells whether it changed files.
    control(&data, "mode", json!({"revert": "error"})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    *STOP.lock().unwrap() = Some((key.clone(), Stop::AfterSent));
    ws.opencode_revert_confirm("oc", &key).await.expect_err("the confirm ends where Core stopped");
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!(checked["status"], "unknown", "a request with no answer kept and no revert held stays unknown: {checked}");
    assert!(checked["message"].as_str().unwrap().contains("无从得知"), "{checked}");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    assert_eq!(reverts(&data), 1, "never asked again");
    assert_eq!(turn_ids(&ws), vec![first, second], "nothing removed");
    ws.close_agent("oc").await.unwrap();
}

/// A lab whose stand-in keeps its snapshots in this test's own data folder
/// (as OpenCode would with that XDG_DATA_HOME), with `a.txt` changed by its
/// first Turn's patch from `a0` to `a1`, and a Started injected as if Core
/// had started a native OpenCode (see each_file_to_send_back_is_read_...).
/// The Workspace, its data folder, the work folder, the file and the Turn.
async fn files_lab(root: &Path) -> (Arc<Workspace>, std::path::PathBuf, std::path::PathBuf, String, String) {
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(cwd.join("a.txt"), "a0\n").unwrap();
    let xdg = root.join("xdg-data");
    std::fs::create_dir_all(&xdg).unwrap();
    std::fs::write(xdg.join(".yuzuno-fixture"), "").unwrap();
    let ws = lab_with(root, &cwd, &[("xdg-data", xdg.to_str().unwrap())]).await;
    let data = root.join("data");
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    let path = c.server.path().await.unwrap();
    let opencode_data = xdg.join("opencode");
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
    let launcher = Launcher::resolve(Path::new("/usr/bin/python3"), None).unwrap();
    let roots = Roots { home: path["home"].as_str().unwrap().into(), state: path["state"].as_str().unwrap().into(),
        config: path["config"].as_str().unwrap().into(), data: opencode_data.to_string_lossy().into_owned() };
    ws.opencodes.lock().unwrap().get_mut("oc").unwrap().files = Arc::new(Ok(Started { launcher, roots }));
    (ws, data, cwd, file, first)
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn each_file_is_backed_up_before_the_revert_is_asked_and_judged_after() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, file, first) = files_lab(&root).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!((&outcome["status"], &outcome["files"]), (&json!("completed"), &json!([{"path": file, "outcome": "verified"}])), "{outcome}");
    assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "a0\n", "sent back");
    let backup = data.join("opencode/oc/revert").join(&key);
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(backup.join("backup.json")).expect("a backup kept before the revert")).unwrap();
    assert_eq!(kept["files"], json!(["0.bin"]), "{kept}");
    assert_eq!(std::fs::read_to_string(backup.join("0.bin")).unwrap(), "a1\n", "what it was, kept before");
    // What it checked is kept with the attempt, and that its request ended.
    let plan = ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap().opencode.unwrap();
    assert_eq!((&plan["entries"][0]["file"], plan["ended"].is_string()), (&json!(file), true), "{plan}");
    assert_eq!(reverts(&data), 1);
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_new_backup_keeps_the_newest_settled_ones_and_leaves_what_is_not_a_settled_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, _, first) = files_lab(&root).await;
    let backups = data.join("opencode/oc/revert");
    std::fs::create_dir_all(&backups).unwrap();
    // Earlier reverts, oldest first, each settled: four with a backup, then a newer one that sent no file back.
    let settled = |id: &str, state: &str, backed: bool| {
        let attempt = Attempt { id: id.into(), agent: "oc".into(), thread: "ses".into(), target: "msg".into(), kept: Vec::new(),
            draft: String::new(), state: "sending".into(), message: None, files: None, opencode: Some(json!({})) };
        ws.store.begin_rewind(&attempt, "[]", "[]").unwrap();
        ws.store.save_rewind(&Attempt { state: state.into(), ..attempt }).unwrap();
        if backed {
            std::fs::create_dir(backups.join(id)).unwrap();
            std::fs::write(backups.join(id).join("0.bin"), "kept").unwrap();
        }
    };
    for (id, state) in [("old1", "completed"), ("old2", "failed"), ("old3", "unchanged"), ("old4", "completed")] {
        settled(id, state, true);
    }
    settled("nofiles", "completed", false);
    // A name no attempt of this Agent has.
    std::fs::create_dir(backups.join("stray")).unwrap();

    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "completed", "{outcome}");
    let left: std::collections::BTreeSet<String> = std::fs::read_dir(&backups).unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
    let wanted: std::collections::BTreeSet<String> = ["old2", "old3", "old4", "stray", key.as_str()].into_iter().map(String::from).collect();
    assert_eq!(left, wanted, "the newest three settled backups, the new one and the stray folder stay; the oldest goes");
    assert!(backups.join(&key).join("backup.json").is_file(), "the new backup is whole");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_request_that_ended_with_no_revert_kept_lets_the_agent_go_on_only_once_all_is_as_before() {
    // With no file to send back: read again, all as before, nothing kept, the Agent goes on.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    control(&data, "mode", json!({"revert": "unmarked"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "unchanged", "{outcome}");
    assert_eq!(outcome["draft"], "", "no text back from a revert nothing was kept of");
    assert_eq!(turn_ids(&ws), vec![first.clone()], "no Turn leaves");
    turn(&ws, &data, "next", json!({})).await;
    ws.close_agent("oc").await.unwrap();

    // Its files sent back with no revert kept: held back, until they are as before again.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, _, first) = files_lab(&root).await;
    control(&data, "mode", json!({"revert": "unmarked-files"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "unknown", "files changed by the request are not taken as unchanged: {outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("请求已结束，但没有确认回退"), "{outcome}");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap()["status"], "unknown", "read again, still not as before");
    std::fs::write(cwd.join("a.txt"), "a1\n").unwrap();
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap()["status"], "unchanged", "read again, all as before");
    assert_eq!(turn_ids(&ws), vec![first]);
    assert_eq!(reverts(&data), 1, "never asked again");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_409_that_is_not_opencodes_busy_refusal_says_nothing_of_what_it_did() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    control(&data, "mode", json!({"revert": "conflict"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "unknown", "a 409 that is not OpenCode's busy refusal says nothing of what it did: {outcome}");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_400_that_may_come_after_the_revert_ran_says_nothing_of_what_it_did() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    // OpenCode reverted, then could not encode its answer: a 400 BadRequest of kind Body.
    control(&data, "mode", json!({"revert": "encode-fail"})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "unknown", "a 400 that may come after the revert ran says nothing of what it did: {outcome}");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    assert_eq!(ws.opencode_revert_confirm("oc", &key).await.unwrap()["status"], "unknown");
    assert_eq!(turn_ids(&ws), vec![first.clone(), second], "nothing removed while unknown");
    // Checked: the session holds this revert, which OpenCode keeps only once its files are sent back (R4 of #534).
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("completed"), &json!("second")), "{checked}");
    assert_eq!(reverts(&data), 1, "never asked again");
    assert_eq!(turn_ids(&ws), vec![first]);
    ws.close_agent("oc").await.unwrap();
}

#[tokio::test]
async fn an_answer_that_arrives_as_the_watch_ends_is_taken_and_one_after_it_stays_with_its_sender() {
    // Within the watch.
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    tx.send(1).unwrap();
    assert_eq!(watched(&mut rx, Duration::from_secs(5), || ()).await, Some(1));
    // Sent just as the watch ended, before the receiver closed: taken, not lost.
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let answer = watched(&mut rx, Duration::ZERO, || tx.send(2).unwrap()).await;
    assert_eq!(answer, Some(2), "an answer that arrives as the watch ends is taken");
    // None by then: the receiver is closed, so a later send fails and its sender keeps the answer.
    let (tx, mut rx) = tokio::sync::oneshot::channel::<i32>();
    assert_eq!(watched(&mut rx, Duration::ZERO, || ()).await, None);
    assert_eq!(tx.send(3), Err(3), "one after it stays with its sender");
}
