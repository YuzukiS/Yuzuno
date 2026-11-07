use super::*;
use std::path::Path;

fn user(id: &str, text: &str) -> Value {
    json!({"id": id, "type": "user", "text": text, "time": {"created": 1}})
}

fn answer(id: &str, content: Value) -> Value {
    json!({"id": id, "type": "assistant", "agent": "build", "model": {"id": "m", "providerID": "p"}, "content": content,
        "time": {"created": 2, "completed": 3}, "finish": "stop"})
}

fn idle(id: &str, outcome: &str) -> Value {
    json!({"id": id, "type": "idle", "outcome": outcome, "time": {"created": 4}})
}

fn export(messages: Vec<Value>) -> Value {
    json!({"info": {"id": "ses_file", "projectID": "prj", "title": "Old", "cost": 0.5,
        "tokens": {"input": 3, "output": 4, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "time": {"created": 1, "updated": 5, "idle": 4}, "outcome": "succeeded", "location": {"directory": "/work"}}, "messages": messages})
}

/// U1: a file Core can't import as it is is refused before anything is kept,
/// saying why: not an export, 1.x's shape (naming the 2.x command), sanitized,
/// a child session, a held revert, an unsettled or unknown message, a move to
/// another folder, no message, or a run left going.
#[test]
fn classify_refuses_1x_sanitized_child_revert_unsettled_location_unknown() {
    let whole = vec![user("msg_1", "hi"), answer("msg_a", json!([{"type": "text", "text": "done"}])), idle("msg_i", "succeeded")];
    classify(&export(whole.clone())).expect("an export as 2.x writes it");
    let refused = |file: Value, said: &str| {
        let error = classify(&file).err().map(|e| e.to_string()).unwrap_or_default();
        assert!(error.contains(said) && error.contains("没有导入"), "{said:?}: {error}");
    };
    refused(json!([1]), "不是 OpenCode 2.x 导出的会话");
    refused(json!({"info": {"id": "ses_1", "directory": "/work"}, "messages": [{"info": {"id": "msg_1"}, "parts": []}]}), "opencode session export");
    let mut sanitized = export(whole.clone());
    sanitized["messages"][0]["text"] = json!("[redacted:message-text:msg_1]");
    refused(sanitized, "--sanitize");
    let mut child = export(whole.clone());
    child["info"]["parentID"] = json!("ses_parent");
    refused(child, "子会话");
    let mut reverted = export(whole.clone());
    reverted["info"]["revert"] = json!({"messageID": "msg_1"});
    refused(reverted, "回退");
    let mut unsettled = export(whole.clone());
    unsettled["messages"][1]["time"].as_object_mut().unwrap().remove("completed");
    refused(unsettled, "还没有结束");
    let mut unknown = export(whole.clone());
    unknown["messages"][1]["type"] = json!("weird");
    refused(unknown, "不认识");
    let mut moved = whole.clone();
    moved.insert(1, json!({"id": "msg_l", "type": "location-switched", "location": {"directory": "/other"}, "time": {"created": 1}}));
    refused(export(moved), "换过目录");
    refused(export(vec![]), "没有消息");
    refused(export(whole[..1].to_vec()), "最后一轮还没有结束");
}

/// U2: the digest is the file's content, however its keys are ordered or
/// spaced.
#[test]
fn digest_ignores_key_order_and_whitespace() {
    let a: Value = serde_json::from_str(r#"{"info": {"id": "ses_1", "title": "T"}, "messages": [{"id": "msg_1", "type": "user"}]}"#).unwrap();
    let b: Value = serde_json::from_str("{\"messages\":[{\"type\":\"user\",\"id\":\"msg_1\"}],\n  \"info\":{\"title\":\"T\",\"id\":\"ses_1\"}}").unwrap();
    assert_eq!(digest(&a), digest(&b));
    let mut c = a.clone();
    c["info"]["title"] = json!("U");
    assert_ne!(digest(&a), digest(&c), "another content, another digest");
}

/// U3: the Turns are the session's prompts as Core would have recorded them
/// live: each with its answer's items, its shells, and the end its idle
/// says; a compaction asked for is a `/compact` Turn, an automatic one none;
/// each marked as imported.
#[test]
fn turns_come_from_native_segments() {
    let tool = json!({"type": "tool", "id": "call_1", "name": "read", "state": {"status": "completed", "input": {"path": "a"},
        "content": [{"type": "text", "text": "x"}]}, "time": {"created": 2, "completed": 3}});
    let shell = json!({"id": "msg_sh", "type": "shell", "shellID": "sh_1", "command": "ls", "status": "completed", "exit": 0,
        "output": {"output": "a\n", "cursor": 2, "size": 2, "truncated": false}, "time": {"created": 3, "completed": 3}});
    let failing = json!({"id": "msg_b", "type": "assistant", "agent": "build", "model": {"id": "m", "providerID": "p"},
        "content": [{"type": "text", "text": "oops"}], "time": {"created": 6, "completed": 7},
        "error": {"type": "provider", "message": "the provider failed"}});
    let messages = vec![
        user("msg_1", "first"), answer("msg_a", json!([{"type": "text", "text": "done"}, tool])), shell, idle("msg_i1", "succeeded"),
        json!({"id": "msg_c", "type": "compaction", "status": "completed", "reason": "manual", "summary": "## Objective", "time": {"created": 5}}),
        idle("msg_i2", "succeeded"),
        json!({"id": "msg_auto", "type": "compaction", "status": "completed", "reason": "auto", "summary": "auto", "time": {"created": 5}}),
        user("msg_2", "second"), failing, idle("msg_i3", "failed"),
    ];
    let mark = json!({"requestId": "r", "sessionId": "ses_file"});
    let turns = imported_turns(&messages, &mark).unwrap();
    let ids: Vec<&str> = turns.iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["msg_1", "compact_msg_c", "msg_2"], "a prompt each, the compaction asked for, not the automatic one");
    let first = &turns[0];
    assert_eq!((&first["status"], &first["_opencodeConfirmed"]), (&json!("completed"), &json!(true)), "{first}");
    assert_eq!(first["items"][0]["content"][0]["text"], "first", "the prompt's own text");
    assert!(first["_opencodeAnswers"].get("msg_a").is_some() && first["_opencodeShells"].get("msg_sh").is_some(), "{first}");
    let kinds: Vec<&str> = first["items"].as_array().unwrap().iter().map(|i| i["type"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"agentMessage") && kinds.contains(&"opencodeTool") && kinds.contains(&"commandExecution"), "{kinds:?}");
    assert_eq!((&turns[1]["_opencodeCompact"]["input"], &turns[1]["status"]), (&json!("msg_c"), &json!("completed")));
    assert_eq!(turns[2]["status"], "failed", "ended as its answer says: {}", turns[2]);
    for turn in &turns {
        assert_eq!(turn["_yuzunoImported"], mark, "{turn}");
    }
}

/// U4 (D-39 (a)): the file's agent is kept only if the new OpenCode lists it
/// as a primary agent one can choose; none is none; any other refuses.
#[test]
fn agent_rule_keeps_a_visible_primary_and_refuses_a_subagent() {
    let listed = vec![("build".to_owned(), "primary".to_owned(), false), ("plan".to_owned(), "all".to_owned(), false),
        ("general".to_owned(), "subagent".to_owned(), false), ("title".to_owned(), "primary".to_owned(), true)];
    assert_eq!(kept_agent(&json!("plan"), &listed).unwrap().as_deref(), Some("plan"));
    assert_eq!(kept_agent(&Value::Null, &listed).unwrap(), None);
    for refused in ["general", "title", "missing"] {
        assert!(kept_agent(&json!(refused), &listed).unwrap_err().to_string().contains(refused), "{refused}");
    }
}

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");

/// One `opencode` for the whole test process, as the Agent tests have it,
/// with OpenCode Agents switched on.
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
        std::env::set_var("YUZUNO_EXPERIMENTAL_OPENCODE", "1");
        program
    });
}

/// A Workspace with an OpenCode Agent `oc` in `cwd`, connected to the stand-in.
#[cfg(target_os = "linux")]
async fn lab(dir: &Path, cwd: &Path) -> Arc<Workspace> {
    program();
    let ws = Workspace::new(dir.join("data"), dir.to_string_lossy().into(), "unused".into()).unwrap();
    let detail: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":"oc", "name":"OpenCode", "cwd":cwd.to_string_lossy(), "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
    std::fs::create_dir_all(dir.join("data/opencode/oc")).unwrap();
    ws.reconnect("oc").await.unwrap();
    ws
}

async fn control(data: &Path, agent: &str, name: &str, body: Value) -> Value {
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode").join(agent).join("start.json")).unwrap()).unwrap();
    reqwest::Client::builder().no_proxy().build().unwrap()
        .post(format!("http://127.0.0.1:{}/__fixture/{name}", seen["port"])).json(&body)
        .timeout(Duration::from_secs(20)).send().await.unwrap().json().await.unwrap()
}

fn asked(data: &Path, agent: &str, method: &str, path: &str) -> usize {
    std::fs::read_to_string(data.join("opencode").join(agent).join("calls.jsonl")).unwrap_or_default().lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|c| c["method"] == method && c["path"].as_str().is_some_and(|p| p.ends_with(path))).count()
}

fn held(data: &Path, agent: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(data.join("opencode").join(agent).join("state.json")).unwrap_or_else(|_| "{}".into())).unwrap()
}

fn plan_new(data: &Path, modes: Value) {
    std::fs::write(data.join("opencode/fixture-new.json"), modes.to_string()).unwrap();
}

async fn turn_on(ws: &Arc<Workspace>, data: &Path, agent: &str, text: &str) -> String {
    ws.opencode_send(agent, text.into()).await.unwrap();
    let session = ws.opencodes.lock().unwrap().get(agent).cloned().unwrap().session;
    let id = ws.store.detail(agent).unwrap().turns.last().unwrap()["id"].as_str().unwrap().to_owned();
    control(data, agent, "reply", json!({"sessionID": session, "text": "done", "parentID": id})).await;
    for _ in 0..400 {
        let d = ws.store.detail(agent).unwrap();
        if d.agent.status == "idle" && d.turns.iter().any(|t| t["id"] == id && t["status"] == "completed") {
            return id;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("Turn {id} did not complete");
}

/// The source's session exported as `opencode session export` writes it:
/// its info and every settled message.
async fn exported(ws: &Arc<Workspace>) -> Value {
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    let messages: Vec<Value> = c.server.messages(&c.session).await.unwrap().as_array().unwrap().iter()
        .filter(|m| transfer::settled(m)).cloned().collect();
    json!({"info": c.server.session(&c.session).await.unwrap(), "messages": messages})
}

/// A lab with two answered Turns and the export of its session: the
/// Workspace, its data folder, the work folder, the Turns and the file.
#[cfg(target_os = "linux")]
async fn source(root: &Path) -> (Arc<Workspace>, std::path::PathBuf, std::path::PathBuf, Vec<String>, Value) {
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(root, &cwd).await;
    let data = root.join("data");
    let first = turn_on(&ws, &data, "oc", "first").await;
    let second = turn_on(&ws, &data, "oc", "second").await;
    let file = exported(&ws).await;
    (ws, data, cwd, vec![first, second], file)
}

fn create(request: &Value, name: &str, cwd: &Path) -> Create {
    Create { request_id: request.as_str().unwrap().into(), name: name.into(), cwd: cwd.to_string_lossy().into() }
}

/// I1: an uploaded export becomes a new Agent in the chosen folder: its
/// OpenCode started once on its own database holds the file's messages
/// under a new session ID with this request's marker, the Turns are the
/// file's prompts, marked imported (Rewind refuses them), and the Agent goes
/// on by itself.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_uploaded_export_becomes_a_new_agent_with_a_new_session_id() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, turns, file) = source(&root).await;
    let preview = ws.opencode_import_upload(serde_json::to_vec(&file).unwrap()).await.unwrap();
    assert_eq!((&preview["turns"], &preview["sourceSession"], &preview["existing"]), (&json!(2), &file["info"]["id"], &Value::Null), "{preview}");
    let request = preview["requestId"].clone();
    assert!(data.join("opencode/imports").join(request.as_str().unwrap()).join("source.json").is_file(), "the file kept");
    let outcome = ws.opencode_import_create(create(&request, "Imported", &cwd)).await.unwrap();
    assert_eq!((&outcome["state"], &outcome["importOutcome"]), (&json!("completed"), &json!("created")), "{outcome}");
    let target = outcome["agent"]["id"].as_str().unwrap().to_owned();
    let d = ws.store.detail(&target).unwrap();
    let session = d.agent.opencode_session_id.clone().unwrap();
    assert!(session.starts_with("ses_") && file["info"]["id"] != session.as_str(), "a new session ID: {session}");
    assert_eq!((d.agent.cwd.as_str(), d.agent.name.as_str(), d.agent.model.as_str()), (cwd.to_str().unwrap(), "Imported", ""));
    let stored = held(&data, &target);
    assert_eq!(stored["imported"][&session], file["messages"], "the file's messages, as they are");
    assert_eq!(stored["sessions"][&session]["metadata"], json!({"yuzuno": {"import": request}}));
    assert_eq!(ws.store.turn_ids(&target).unwrap(), turns, "the file's prompts, under their own IDs");
    for turn in ws.store.stored_turns(&target).unwrap() {
        assert_eq!(turn["status"], "completed", "{turn}");
        assert_eq!(turn["_yuzunoImported"]["requestId"], request, "{turn}");
    }
    assert_eq!(asked(&data, &target, "POST", "/api/experimental/session/import"), 1);
    assert_eq!(ws.listed(&target).await.unwrap().connection_state, "connected");
    let error = ws.opencode_revert_preview(&target, &turns[0]).await.unwrap_err().to_string();
    assert!(error.contains("从导出的文件导入的"), "{error}");
    let next = turn_on(&ws, &data, &target, "next").await;
    assert_eq!(ws.store.turn_ids(&target).unwrap().last(), Some(&next));
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// I2 (D-42 (a)): the same file again is the Agent it made; the same session
/// exported again after more work is a new copy, and its preview names the
/// earlier one; the Agent deleted, the same file is imported anew.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_same_file_again_returns_the_existing_agent_and_a_reexport_makes_a_new_copy() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, _, file) = source(&root).await;
    let first = ws.opencode_import_upload(serde_json::to_vec(&file).unwrap()).await.unwrap();
    let made = ws.opencode_import_create(create(&first["requestId"], "Imported", &cwd)).await.unwrap();
    let target = made["agent"]["id"].as_str().unwrap().to_owned();
    // The same file, spaced otherwise: that Agent.
    let again = ws.opencode_import_upload(serde_json::to_vec_pretty(&file).unwrap()).await.unwrap();
    assert_eq!(again["existing"]["id"], json!(target), "{again}");
    let outcome = ws.opencode_import_create(create(&again["requestId"], "Again", &cwd)).await.unwrap();
    assert_eq!((&outcome["importOutcome"], &outcome["agent"]["id"]), (&json!("existing"), &json!(target)), "{outcome}");
    // Exported again after another Turn: a new copy, the earlier one named.
    turn_on(&ws, &data, "oc", "third").await;
    let later = exported(&ws).await;
    let preview = ws.opencode_import_upload(serde_json::to_vec(&later).unwrap()).await.unwrap();
    assert_eq!((&preview["existing"], &preview["earlierCopies"][0]["agentId"]), (&Value::Null, &json!(target)), "{preview}");
    let copy = ws.opencode_import_create(create(&preview["requestId"], "Later", &cwd)).await.unwrap();
    assert_eq!(copy["importOutcome"], "created", "{copy}");
    let other = copy["agent"]["id"].as_str().unwrap().to_owned();
    assert_ne!(other, target);
    assert_eq!(ws.store.turn_ids(&other).unwrap().len(), 3);
    // The first Agent deleted: the same file is imported anew.
    ws.delete_agent(&target).await.unwrap();
    let anew = ws.opencode_import_upload(serde_json::to_vec(&file).unwrap()).await.unwrap();
    assert!(anew["existing"].is_null(), "{anew}");
    let made = ws.opencode_import_create(create(&anew["requestId"], "Anew", &cwd)).await.unwrap();
    assert_eq!(made["importOutcome"], "created", "{made}");
    ws.close_agent(made["agent"]["id"].as_str().unwrap()).await.unwrap();
    ws.close_agent(&other).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// I3: an import whose answer was lost goes on with the same request, finds
/// the copy, and writes nothing twice; one that fails (a 500) fails, and one
/// the new OpenCode changed fails; the same file is then free to import.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_lost_create_is_continued_to_one_session_and_a_failed_or_changed_one_fails() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, _, file) = source(&root).await;
    plan_new(&data, json!({"import": "lost"}));
    let preview = ws.opencode_import_upload(serde_json::to_vec(&file).unwrap()).await.unwrap();
    let outcome = ws.opencode_import_create(create(&preview["requestId"], "Imported", &cwd)).await.unwrap();
    assert_eq!(outcome["state"], "uncertain", "{outcome}");
    let continued = ws.opencode_import_create(create(&preview["requestId"], "Imported", &cwd)).await.unwrap();
    assert_eq!(continued["state"], "completed", "{continued}");
    let target = continued["agent"]["id"].as_str().unwrap().to_owned();
    assert_eq!(asked(&data, &target, "POST", "/api/experimental/session/import"), 1, "written once");
    assert_eq!(held(&data, &target)["sessions"].as_object().unwrap().len(), 1, "one session");
    ws.delete_agent(&target).await.unwrap();
    for (mode, said) in [("fail", "可以重新导入"), ("tamper", "第 1 条消息")] {
        plan_new(&data, json!({"import": mode}));
        let preview = ws.opencode_import_upload(serde_json::to_vec(&file).unwrap()).await.unwrap();
        let outcome = ws.opencode_import_create(create(&preview["requestId"], "Imported", &cwd)).await.unwrap();
        assert_eq!(outcome["state"], "failed", "{mode}: {outcome}");
        assert!(outcome["message"].as_str().unwrap().contains(said), "{mode}: {outcome}");
    }
    plan_new(&data, json!({}));
    let preview = ws.opencode_import_upload(serde_json::to_vec(&file).unwrap()).await.unwrap();
    let made = ws.opencode_import_create(create(&preview["requestId"], "Imported", &cwd)).await.unwrap();
    assert_eq!(made["state"], "completed", "the file is free again: {made}");
    ws.close_agent(made["agent"]["id"].as_str().unwrap()).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// I4: the upload's cap is its own, past the JSON limit: a file of 1 MiB is
/// taken, one past CAP refused; a file Core can't import is refused, keeping
/// nothing.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_upload_cap_is_the_routes_and_a_refused_file_keeps_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, _, file) = source(&root).await;
    let mut big = serde_json::to_vec(&file).unwrap();
    big.resize(1 << 20, b' ');
    ws.opencode_import_upload(big).await.expect("1 MiB is taken");
    let error = ws.opencode_import_upload(vec![b' '; CAP + 1]).await.unwrap_err().to_string();
    assert!(error.contains("64 MiB"), "{error}");
    let before = std::fs::read_dir(data.join("opencode/imports")).unwrap().count();
    let mut child = file.clone();
    child["info"]["parentID"] = json!("ses_parent");
    let error = ws.opencode_import_upload(serde_json::to_vec(&child).unwrap()).await.unwrap_err().to_string();
    assert!(error.contains("子会话"), "{error}");
    assert_eq!(std::fs::read_dir(data.join("opencode/imports")).unwrap().count(), before, "nothing kept");
    ws.close_agent("oc").await.unwrap();
}

/// D-39 (a): a file whose agent is a sub-agent of the new OpenCode fails the
/// import; one whose agent is a primary keeps it in the copy.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_files_agent_is_kept_only_as_a_primary() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, _data, cwd, _, file) = source(&root).await;
    let mut sub = file.clone();
    sub["info"]["agent"] = json!("general");
    let preview = ws.opencode_import_upload(serde_json::to_vec(&sub).unwrap()).await.unwrap();
    let outcome = ws.opencode_import_create(create(&preview["requestId"], "Sub", &cwd)).await.unwrap();
    assert_eq!(outcome["state"], "failed", "{outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("general"), "{outcome}");
    let mut plan = file.clone();
    plan["info"]["agent"] = json!("plan");
    let preview = ws.opencode_import_upload(serde_json::to_vec(&plan).unwrap()).await.unwrap();
    let outcome = ws.opencode_import_create(create(&preview["requestId"], "Plan", &cwd)).await.unwrap();
    assert_eq!(outcome["state"], "completed", "{outcome}");
    let target = outcome["agent"]["id"].as_str().unwrap().to_owned();
    let c = ws.opencodes.lock().unwrap().get(&target).cloned().unwrap();
    assert_eq!(c.server.session(&c.session).await.unwrap()["agent"], "plan");
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// D-37: an imported Agent's Turns can be forked; the fork's copies keep
/// saying they were imported (and that they were copied), so Rewind refuses
/// them there too.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_imported_turn_is_forked_with_its_marks() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, _data, cwd, turns, file) = source(&root).await;
    let preview = ws.opencode_import_upload(serde_json::to_vec(&file).unwrap()).await.unwrap();
    let made = ws.opencode_import_create(create(&preview["requestId"], "Imported", &cwd)).await.unwrap();
    let imported = made["agent"]["id"].as_str().unwrap().to_owned();
    let request = serde_json::from_value(json!({"requestId": uuid::Uuid::new_v4().to_string(), "turnId": turns[0], "name": "Forked"})).unwrap();
    let forked = ws.opencode_fork(&imported, request).await.unwrap();
    assert_eq!(forked["state"], "completed", "{forked}");
    let target = forked["agent"]["id"].as_str().unwrap().to_owned();
    let copied = ws.store.stored_turns(&target).unwrap();
    assert_eq!(copied.len(), 1);
    assert!(copied[0]["_yuzunoImported"].is_object() && copied[0]["_yuzunoCopiedFrom"]["agentId"] == imported.as_str(), "{}", copied[0]);
    assert!(ws.opencode_revert_preview(&target, &turns[0]).await.is_err());
    ws.close_agent(&target).await.unwrap();
    ws.close_agent(&imported).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}
