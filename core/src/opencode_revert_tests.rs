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
    for (name, value) in switches {
        std::fs::write(own.join(name), value).unwrap();
    }
    ws.reconnect("oc").await.unwrap();
    ws
}

/// How many times the stand-in was asked to stage a revert (2.x's
/// `POST /api/session/:id/revert/stage`).
fn reverts(data: &Path) -> usize {
    asked(data).iter().filter(|(method, path)| method == "POST" && path.ends_with("/revert/stage")).count()
}

/// How many times the stand-in was asked to commit one.
fn commits(data: &Path) -> usize {
    asked(data).iter().filter(|(method, path)| method == "POST" && path.ends_with("/revert/commit")).count()
}

/// Whether the stand-in was asked anything of a revert: 2.x's stage, commit
/// or clear, or 1.19.3's revert.
fn any_revert(data: &Path) -> bool {
    asked(data).iter().any(|(_, path)| path.contains("/revert"))
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
    assert!(!any_revert(&data), "nothing asked: {:?}", asked(&data));
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
    assert!(!any_revert(&data), "nothing asked: {:?}", asked(&data));
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
    // A step's snapshot as 2.x keeps it on its message, naming a file relative to the Git top level.
    let first = turn(&ws, &data, "first", json!({"snapshot": {"start": "a".repeat(40), "files": ["a.txt"]}})).await;
    let error = ws.opencode_revert_preview("oc", &first).await.unwrap_err().to_string();
    assert!(error.contains("无法事先核对") && error.contains("not a native executable"), "{error}");
    assert!(!any_revert(&data), "nothing asked");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_confirm_with_no_file_to_send_back_stages_then_commits_and_the_turns_it_reverts_leave() {
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
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "staged once, then committed once");
    assert_eq!(turn_ids(&ws), vec![first.clone()], "the Turn it reverts leaves");
    assert!(ws.pending_rewind("oc").await.unwrap()["attempt"].is_null(), "none left to check once kept");
    // Asked for by its own ID, as a client that asked for it finds it again: as it settled, its text with it.
    assert_eq!(ws.rewind_attempt_view("oc", Some(&key)).await.unwrap()["attempt"], outcome, "a settled attempt is found by its ID");
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    assert!(c.server.session(&c.session).await.unwrap()["revert"].is_null(), "committed: the session holds no revert");
    let messages = c.server.messages(&c.session).await.unwrap();
    assert!(!messages.as_array().unwrap().iter().any(|m| m["id"] == second.as_str()), "its message is deleted: {messages}");
    // Asked again for the same preview: that attempt as it stands, nothing asked.
    assert_eq!(ws.opencode_revert_confirm("oc", &key).await.unwrap(), outcome);
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "never asked again");
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
    assert!(!any_revert(&data), "nothing asked");
    assert!(ws.store.rewind_attempt("oc", None).unwrap().is_none(), "no attempt kept");
    assert_eq!(turn_ids(&ws).len(), 2, "nothing removed");
    ws.close_agent("oc").await.unwrap();
}

/// A 500 from 2.x's stage says nothing of what it did: unknown, and the
/// Agent held back. A check that then finds no revert held, the Turn's
/// message still there and the session's messages as before takes it as
/// unchanged, and the Agent goes on (T-61 slice 6, R2-4).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_revert_whose_outcome_is_unknown_holds_back_every_new_input_until_a_check_finds_all_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    control(&data, "mode", json!({"stage": "500"})).await;
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
    assert_eq!(reverts(&data), 1, "never asked again");
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("unchanged"), &json!("")),
        "no revert held, its message there, all as before: {checked}");
    assert_eq!((reverts(&data), commits(&data)), (1, 0), "nothing asked by the check");
    assert_eq!(turn_ids(&ws), vec![first.clone()], "nothing removed");
    ws.ensure_rewind_settled("oc").await.expect("the Agent is not held back");
    turn(&ws, &data, "next", json!({})).await;
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
    control(&data, "mode", json!({"stage": "busy-409"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "failed", "{outcome}");
    assert_eq!(outcome["draft"], "", "no text back from a revert refused");
    assert!(outcome["message"].as_str().unwrap().contains("SessionBusyError"), "{outcome}");
    assert_eq!((reverts(&data), commits(&data)), (1, 0), "nothing committed");
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
    control(&data, "mode", json!({"stage": "late"})).await;
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
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "staged once, then committed once");
    assert_eq!(turn_ids(&ws), vec![first]);
    ws.close_agent("oc").await.unwrap();
}

/// A check while 2.x's stage is still out takes nothing as unchanged
/// (T-61 slice 6): 2.x sends the files back before it keeps the revert, so
/// a session holding none, with every file as before, says nothing yet.
/// The answer, when it comes, settles it.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_check_while_the_stage_is_still_out_takes_nothing_as_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, first, _) = reverted_lab(&root).await;
    // 2.x takes the request, and does nothing of it yet.
    control(&data, "mode", json!({"stage": "hold"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "unknown", "no answer within the watch: {outcome}");
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!(checked["status"], "unknown", "the request is still out: {checked}");
    assert!(checked["message"].as_str().unwrap().contains("还没有回答"), "{checked}");
    assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "a2\n", "nothing sent back yet");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    // It goes on: the files go back, the revert is kept, then it answers.
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
    assert_eq!((&settled["status"], &settled["draft"]), (&json!("completed"), &json!("first")), "{settled}");
    assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "a0\n", "sent back");
    assert_eq!((reverts(&data), commits(&data)), (1, 1));
    assert!(turn_ids(&ws).is_empty());
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
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "staged once, then committed once");
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
    assert_eq!(commits(&data), 0, "not committed before it is recorded");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    // Checked again: recorded now, from the answer it kept, then committed, with nothing staged again.
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("completed"), &json!("second")), "recorded when checked: {checked}");
    assert_eq!(turn_ids(&ws), vec![first.clone()], "the Turn it reverts leaves");
    ws.ensure_rewind_settled("oc").await.expect("the Agent is not held back");
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap(), checked, "checked once more, it stays as it was settled");
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "staged once, then committed once");
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
    assert_eq!(c.server.location(&link.to_string_lossy()).await.unwrap()["directory"], json!(work.to_string_lossy()),
        "OpenCode names the resolved folder");
    ws.opencode_revert_preview("oc", &first).await.expect("the same folder through a link is the Agent's own");
    // A folder that is not the Agent's, though it exists: still refused.
    let other = root.join("other");
    std::fs::create_dir_all(&other).unwrap();
    control(&data, "mode", json!({"directory": other.to_string_lossy()})).await;
    let error = ws.opencode_revert_preview("oc", &first).await.expect_err("another folder is refused").to_string();
    assert!(error.contains("不是这个 Agent 的目录"), "{error}");
    assert!(!any_revert(&data), "nothing asked");
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
    assert!(!any_revert(&data), "nothing asked");
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
    // 2.x staged it; Core kept no answer.
    let kept = ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap();
    assert_eq!((kept.state.as_str(), Plan::of(&kept).unwrap().sent), ("sending", true), "kept as Core had it");
    assert_eq!((reverts(&data), commits(&data)), (1, 0), "staged once, nothing committed");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("completed"), &json!("second")),
        "reverted when the session holds it: {checked}");
    assert_eq!(turn_ids(&ws), vec![first]);
    ws.ensure_rewind_settled("oc").await.expect("the Agent is not held back");
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap(), checked, "checked once more, it stays as it was settled");
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "committed once it was recorded, never staged again");
    ws.close_agent("oc").await.unwrap();
}

/// An answer lost (the connection ended, or Core stopped while it was out)
/// is settled by what a check reads (T-61 slice 6, R2-4): a session holding
/// this revert, or one holding none whose Turn's message is gone (committed
/// already), is reverted; one holding another revert stays unknown.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_lost_answer_is_settled_by_the_held_revert_or_its_committed_boundary() {
    // The connection ends once 2.x staged it: each file listed as it is now, then the held revert settles it.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, first, _) = reverted_lab(&root).await;
    control(&data, "mode", json!({"stage": "drop"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    let (a, new) = (cwd.join("a.txt").to_string_lossy().into_owned(), cwd.join("new.txt").to_string_lossy().into_owned());
    assert_eq!((&outcome["status"], &outcome["files"]), (&json!("unknown"),
        &json!([{"path": a, "outcome": "verified"}, {"path": new, "outcome": "verified"}])), "each file as it is now: {outcome}");
    let backup = data.join("opencode/oc/revert").join(&key);
    assert!(outcome["message"].as_str().unwrap().contains(&backup.display().to_string()), "Core's backup is named: {outcome}");
    assert_eq!(commits(&data), 0, "nothing committed while unknown");
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("completed"), &json!("first")), "the session holds it: {checked}");
    assert_eq!((reverts(&data), commits(&data)), (1, 1));
    assert!(turn_ids(&ws).is_empty());
    ws.close_agent("oc").await.unwrap();

    // Core stopped while it was out, and another client committed it before the check: its message is gone.
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
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    c.server.commit(&c.session).await.unwrap();
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("completed"), &json!("second")), "committed already: {checked}");
    let plan = Plan::of(&ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap()).unwrap();
    assert_eq!(plan.committed.as_deref(), Some("answered"), "committed already, so not asked again: {:?}", plan.committed);
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "the other client's commit only");
    assert_eq!(turn_ids(&ws), vec![first.clone()]);
    ws.close_agent("oc").await.unwrap();

    // Core stopped while it was out, 2.x did nothing of it, and the session holds another revert now.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    control(&data, "mode", json!({"stage": "500"})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    *STOP.lock().unwrap() = Some((key.clone(), Stop::AfterSent));
    ws.opencode_revert_confirm("oc", &key).await.expect_err("the confirm ends where Core stopped");
    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    control(&data, "revert", json!({"sessionID": session, "messageID": "msg_other"})).await;
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!(checked["status"], "unknown", "another revert held says nothing of this one: {checked}");
    assert!(checked["message"].as_str().unwrap().contains("另一次回退"), "{checked}");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    assert_eq!((reverts(&data), commits(&data)), (1, 0));
    assert_eq!(turn_ids(&ws), vec![first, second], "nothing removed");
    ws.close_agent("oc").await.unwrap();
}

/// A commit whose answer is lost leaves the attempt completed and the
/// record as it is: 2.x commits the revert itself before the next message
/// (T-61 slice 6, R2-5). Until then a compaction, which would commit it
/// first, is refused, saying to send a message.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_lost_commit_answer_leaves_the_revert_to_the_next_message() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    control(&data, "mode", json!({"commit": "500"})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!((&outcome["status"], &outcome["draft"]), (&json!("completed"), &json!("second")), "{outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("收到下一条消息时删去"), "{outcome}");
    let plan = Plan::of(&ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap()).unwrap();
    assert_eq!(plan.committed.as_deref(), Some("unknown"));
    assert_eq!(turn_ids(&ws), vec![first.clone()], "the Turn it reverts leaves");
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    assert_eq!(c.server.session(&c.session).await.unwrap()["revert"]["messageID"], json!(second), "still held in the session");
    let error = ws.opencode_compact("oc").await.expect_err("no compaction while the session holds the revert").to_string();
    assert!(error.contains("请先发一条消息"), "{error}");
    assert_eq!(ws.rewind_check("oc", &key).await.unwrap(), outcome, "checked, it stays as it was settled");
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "the commit is not asked again");
    // The next message: 2.x commits the revert first, then takes it.
    control(&data, "mode", json!({"commit": "ok"})).await;
    let third = turn(&ws, &data, "third", json!({})).await;
    assert!(c.server.session(&c.session).await.unwrap()["revert"].is_null(), "committed by the message");
    let messages = c.server.messages(&c.session).await.unwrap();
    assert!(!messages.as_array().unwrap().iter().any(|m| m["id"] == second.as_str()), "its message is deleted: {messages}");
    assert_eq!(turn_ids(&ws), vec![first, third]);
    assert_eq!(commits(&data), 1, "by 2.x itself, not asked");
    ws.close_agent("oc").await.unwrap();
}

/// A revert another client stages and commits (T-61 slice 6, R2-7, D-25
/// (a)): while it is only staged, a compaction (which would commit it) and a
/// preview are refused and the record keeps every Turn; once committed, 2.x's
/// `session.revert.committed` takes the Turns from its message on out of the
/// record, with nothing of Core's own rewind.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn another_clients_commit_resyncs_the_record() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn(&ws, &data, "first", json!({})).await;
    let second = turn(&ws, &data, "second", json!({})).await;
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    let staged = c.server.stage(&c.session, &second).unwrap().await;
    assert!(matches!(&staged, RevertAnswer::Answered(session) if session["revert"]["messageID"] == second.as_str()), "{staged:?}");
    let error = ws.opencode_compact("oc").await.expect_err("a compaction would commit it").to_string();
    assert!(error.contains("请先发一条消息"), "{error}");
    let error = ws.opencode_revert_preview("oc", &first).await.expect_err("a revert is held").to_string();
    assert!(error.contains("已有一次尚未处理的回退"), "{error}");
    assert_eq!(turn_ids(&ws), vec![first.clone(), second.clone()], "staged only: nothing leaves");
    c.server.commit(&c.session).await.unwrap();
    for _ in 0..400 {
        if turn_ids(&ws) == vec![first.clone()] {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(turn_ids(&ws), vec![first.clone()], "the Turns from its message on leave the record");
    assert!(ws.store.rewind_attempt("oc", None).unwrap().is_none(), "no rewind of Core's own");
    let third = turn(&ws, &data, "third", json!({})).await;
    assert_eq!(turn_ids(&ws), vec![first, third]);
    ws.close_agent("oc").await.unwrap();
}

/// A Workspace with an OpenCode Agent in `root/work`, its stand-in taking
/// each step's snapshot into a data folder of the test's own, as 2.x would
/// with that `XDG_DATA_HOME` (T-61 slice 5); a Started injected as if Core
/// had started a native OpenCode. `a.txt` holds `a0`. The Workspace, its
/// data folder and the work folder.
async fn v2_files_lab(root: &Path) -> (Arc<Workspace>, std::path::PathBuf, std::path::PathBuf) {
    program();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(cwd.join("a.txt"), "a0\n").unwrap();
    let xdg = root.join("xdg-data");
    std::fs::create_dir_all(&xdg).unwrap();
    std::fs::write(xdg.join(".yuzuno-fixture"), "").unwrap();
    let ws = Workspace::new(root.join("data"), root.to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&cwd.to_string_lossy())).unwrap();
    let own = root.join("data/opencode/oc");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(own.join("xdg-data"), xdg.to_str().unwrap()).unwrap();
    ws.reconnect("oc").await.unwrap();
    let launcher = Launcher::resolve(Path::new("/usr/bin/python3"), None).unwrap();
    let roots = Roots { home: "/nowhere".into(), state: "/nowhere".into(), config: "/nowhere".into(),
        data: xdg.join("opencode").to_string_lossy().into_owned() };
    ws.opencodes.lock().unwrap().get_mut("oc").unwrap().files = Arc::new(Ok(Started { launcher, roots }));
    (ws, root.join("data"), cwd)
}

/// `v2_files_lab` with two Turns: `first`, whose run changed `a.txt` to `a1`
/// and made `new.txt`, and `second`, whose run changed `a.txt` to `a2`. The
/// Workspace, its data folder, the work folder and both Turns.
async fn reverted_lab(root: &Path) -> (Arc<Workspace>, std::path::PathBuf, std::path::PathBuf, String, String) {
    let (ws, data, cwd) = v2_files_lab(root).await;
    let first = turn(&ws, &data, "first", json!({"files": {"a.txt": "a1\n", "new.txt": "n\n"}})).await;
    let second = turn(&ws, &data, "second", json!({"files": {"a.txt": "a2\n"}})).await;
    (ws, data, cwd, first, second)
}

/// A confirm on 2.x (T-61 slice 6, D-26 (a)): each file is kept first, then
/// 2.x is asked once to stage the revert and sends each back; each is
/// judged as it is now, the Turns from the one reverted leave the record,
/// and 2.x is asked once to commit it, deleting their messages.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_confirm_stages_once_verifies_each_file_then_commits_and_the_turns_leave() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, first, second) = reverted_lab(&root).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    let (a, new) = (cwd.join("a.txt").to_string_lossy().into_owned(), cwd.join("new.txt").to_string_lossy().into_owned());
    assert_eq!((&outcome["status"], &outcome["draft"], &outcome["message"]), (&json!("completed"), &json!("first"), &json!("已回退")), "{outcome}");
    assert_eq!(outcome["files"], json!([{"path": a, "outcome": "verified"}, {"path": new, "outcome": "verified"}]), "{outcome}");
    assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "a0\n", "sent back");
    assert!(!cwd.join("new.txt").exists(), "the file its run made is gone");
    // Each, as it was, kept before the revert was asked.
    let backup = data.join("opencode/oc/revert").join(&key);
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(backup.join("backup.json")).expect("a backup kept before the revert")).unwrap();
    assert_eq!(kept["files"], json!(["0.bin", "1.bin"]), "{kept}");
    assert_eq!((std::fs::read_to_string(backup.join("0.bin")).unwrap(), std::fs::read_to_string(backup.join("1.bin")).unwrap()),
        ("a2\n".to_owned(), "n\n".to_owned()));
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "staged once, then committed once");
    assert!(turn_ids(&ws).is_empty(), "the Turns it reverts leave");
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    assert!(c.server.session(&c.session).await.unwrap()["revert"].is_null(), "committed: the session holds no revert");
    let messages = c.server.messages(&c.session).await.unwrap();
    assert!(!messages.as_array().unwrap().iter().any(|m| m["id"] == first.as_str() || m["id"] == second.as_str()),
        "their messages are deleted: {messages}");
    // What it checked is kept with the attempt, with that its request ended and was committed.
    let plan = ws.store.rewind_attempt("oc", Some(&key)).unwrap().unwrap().opencode.unwrap();
    assert_eq!((&plan["entries"][0]["file"], plan["ended"].is_string(), &plan["committed"]), (&json!(a), true, &json!("answered")), "{plan}");
    let third = turn(&ws, &data, "third", json!({})).await;
    assert_eq!(turn_ids(&ws), vec![third]);
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_new_backup_keeps_the_newest_settled_ones_and_leaves_what_is_not_a_settled_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, first, _) = reverted_lab(&root).await;
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

/// A restore that failed part way (T-61 slice 6, R2-3, D-27 (a)): 2.x
/// answers 500 having sent back some files and kept no revert. Unknown,
/// each file listed as it is now and Core's backup named, nothing put back
/// on its own; a check keeps it unknown while any file differs from before
/// the revert, and lets the Agent go on once all are as before again.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_restore_that_failed_part_way_stays_unknown_and_says_which_files_moved() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, first, second) = reverted_lab(&root).await;
    control(&data, "mode", json!({"stage": "restore-fail"})).await;
    let key = ws.opencode_revert_preview("oc", &first).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    let (a, new) = (cwd.join("a.txt").to_string_lossy().into_owned(), cwd.join("new.txt").to_string_lossy().into_owned());
    assert_eq!(outcome["status"], "unknown", "{outcome}");
    assert_eq!(outcome["files"], json!([{"path": a, "outcome": "verified"}, {"path": new, "outcome": "notRestored"}]),
        "a.txt went back, new.txt did not: {outcome}");
    let backup = data.join("opencode/oc/revert").join(&key);
    assert!(outcome["message"].as_str().unwrap().contains(&backup.display().to_string()), "Core's backup is named: {outcome}");
    assert_eq!((std::fs::read_to_string(cwd.join("a.txt")).unwrap(), std::fs::read_to_string(cwd.join("new.txt")).unwrap()),
        ("a0\n".to_owned(), "n\n".to_owned()), "nothing put back by Core");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!(checked["status"], "unknown", "a file differs from before: {checked}");
    assert!(checked["message"].as_str().unwrap().contains("要送回的文件与执行前不同"), "{checked}");
    // Put back from Core's backup: all as before, and the Agent goes on.
    std::fs::write(cwd.join("a.txt"), std::fs::read(backup.join("0.bin")).unwrap()).unwrap();
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("unchanged"), &json!("")), "{checked}");
    assert_eq!((reverts(&data), commits(&data)), (1, 0));
    assert_eq!(turn_ids(&ws), vec![first, second], "no Turn leaves");
    ws.ensure_rewind_settled("oc").await.expect("the Agent is not held back");
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
    control(&data, "mode", json!({"stage": "conflict-409"})).await;
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
    // 2.x staged it, then could not encode its answer: a 400 InvalidRequestError of kind Body (before 2.2.0).
    control(&data, "mode", json!({"stage": "body-400"})).await;
    let key = ws.opencode_revert_preview("oc", &second).await.unwrap()["previewId"].as_str().unwrap().to_owned();
    let outcome = ws.opencode_revert_confirm("oc", &key).await.unwrap();
    assert_eq!(outcome["status"], "unknown", "a 400 that may come after the revert ran says nothing of what it did: {outcome}");
    assert!(ws.opencode_send("oc", "next".into()).await.unwrap_err().to_string().contains("rewind is unconfirmed"));
    assert_eq!(ws.opencode_revert_confirm("oc", &key).await.unwrap()["status"], "unknown");
    assert_eq!(turn_ids(&ws), vec![first.clone(), second], "nothing removed while unknown");
    // Checked: the session holds this revert, which 2.x keeps only once its files are sent back.
    let checked = ws.rewind_check("oc", &key).await.unwrap();
    assert_eq!((&checked["status"], &checked["draft"]), (&json!("completed"), &json!("second")), "{checked}");
    assert_eq!((reverts(&data), commits(&data)), (1, 1), "committed once recorded, never staged again");
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

/// A 2.x preview (T-61 slice 5, D-23 (a)) reads each file 2.x would send
/// back from the Agent's own snapshot store, found by 2.x's location for the
/// Agent's folder, and from the folder, and writes nothing. It is refused,
/// reading no file, while a revert waits in the session, while 2.x is busy,
/// when the session is not of the project 2.x holds the folder for now, or
/// when 2.x holds another folder.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_2x_preview_reads_each_file_from_the_agents_store_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, first, _) = reverted_lab(&root).await;
    let state = |bytes: &[u8]| serde_json::to_value(State::File {
        size: bytes.len() as u64, sha256: Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect(), executable: false,
    }).unwrap();
    let (a, new) = (cwd.join("a.txt").to_string_lossy().into_owned(), cwd.join("new.txt").to_string_lossy().into_owned());
    let preview = ws.opencode_revert_preview("oc", &first).await.unwrap();
    assert_eq!(preview["files"], json!([
        {"path": a, "expected": state(b"a0\n"), "current": state(b"a2\n")},
        {"path": new, "expected": serde_json::to_value(State::Absent).unwrap(), "current": state(b"n\n")},
    ]), "each file as its first step after the Turn started, and as it is now: {preview}");
    assert_eq!(preview["removedTurns"], 2, "{preview}");
    let unchanged = || (std::fs::read_to_string(cwd.join("a.txt")).unwrap(), std::fs::read_to_string(cwd.join("new.txt")).unwrap());
    assert_eq!(unchanged(), ("a2\n".to_owned(), "n\n".to_owned()), "nothing written");
    assert!(!any_revert(&data), "no revert asked");

    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    let refused = |said: &'static str| {
        let (ws, first) = (ws.clone(), first.clone());
        async move {
            let error = ws.opencode_revert_preview("oc", &first).await.unwrap_err().to_string();
            assert!(error.contains(said) && error.contains("没有预览回退"), "refused, saying {said:?}: {error}");
        }
    };
    control(&data, "busy", json!({"sessionID": session})).await;
    // Refused by 2.x's status, or by Core's own record of it once its event came: either says it is not idle.
    refused("空闲").await;
    control(&data, "idle", json!({"sessionID": session})).await;
    for _ in 0..400 {
        if ws.store.detail("oc").unwrap().agent.status == "idle" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    control(&data, "project", json!({"id": "otherproject"})).await;
    refused("不属于它现在的项目").await;
    control(&data, "project", json!({"id": "fixtureproject"})).await;
    control(&data, "mode", json!({"directory": root.to_string_lossy()})).await;
    refused("不是这个 Agent 的目录").await;
    control(&data, "mode", json!({"directory": null})).await;
    control(&data, "revert", json!({"sessionID": session})).await;
    refused("已有一次尚未处理的回退").await;
    assert_eq!(unchanged(), ("a2\n".to_owned(), "n\n".to_owned()), "nothing written by a refusal");
    assert!(!any_revert(&data), "no revert asked");
    ws.close_agent("oc").await.unwrap();
}
