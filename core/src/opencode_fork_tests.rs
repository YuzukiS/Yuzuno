use super::*;
use serde_json::Map;

// A 2.x session's messages as 2.x lists them (schema/src/session-message.ts).
fn user(id: &str) -> Value {
    json!({"id": id, "type": "user", "text": id, "time": {"created": 1}})
}

fn answer(id: &str) -> Value {
    json!({"id": id, "type": "assistant", "agent": "build", "model": {"id": "m", "providerID": "p"}, "content": [], "time": {"created": 1, "completed": 2}})
}

fn idle(id: &str) -> Value {
    json!({"id": id, "type": "idle", "outcome": "succeeded", "time": {"created": 3}})
}

fn model(id: &str) -> Value {
    json!({"id": id, "type": "model-switched", "model": {"id": "m2", "providerID": "p"}, "time": {"created": 1}})
}

/// A prompt's Turn as Core keeps it, answered by `answers`.
fn turn(id: &str, answers: &[&str]) -> Value {
    let answered: Map<String, Value> = answers.iter().map(|a| (a.to_string(), json!({"parent": id, "completed": 2}))).collect();
    json!({"id": id, "status": "completed", "_opencodeConfirmed": true, "items": [], "_opencodeAnswers": answered})
}

/// U1: a fork copies up to the idle that ended the Turn's last run: what
/// Core sets before the next Turn (its model) and the next Turn stay out; an
/// input added to the Turn, and a run 2.x started itself after it, are in.
#[test]
fn the_cut_ends_at_the_idle_that_ended_the_turns_last_run() {
    let list = [model("msg_m0"), user("msg_1"), answer("msg_a1"), idle("msg_i1"), model("msg_m1"), user("msg_2"), answer("msg_a2"), idle("msg_i2")];
    let turns = [turn("msg_1", &["msg_a1"]), turn("msg_2", &["msg_a2"])];
    assert_eq!(check::cut(&turns, &list, "msg_1").unwrap(), 4, "through the first idle, not the model set for the next Turn");
    assert_eq!(check::cut(&turns, &list, "msg_2").unwrap(), 8, "the newest Turn: every message");

    // An input added while it ran, and 2.x's own run after it (a sub-agent's result delivered), are the Turn's.
    let mut first = turn("msg_1", &["msg_a1", "msg_a1b"]);
    first["_opencodeInputs"] = json!({"msg_s": {"confirmed": true}});
    first["_opencodeAnswers"]["msg_a1b"]["parent"] = json!("msg_s");
    let synthetic = json!({"id": "msg_y", "type": "synthetic", "text": "<subagent/>", "time": {"created": 4}});
    let list = [user("msg_1"), answer("msg_a1"), user("msg_s"), answer("msg_a1b"), idle("msg_i1"), synthetic, answer("msg_a1c"), idle("msg_i1b"),
        user("msg_2"), answer("msg_a2"), idle("msg_i2")];
    assert_eq!(check::cut(&[first, turn("msg_2", &["msg_a2"])], &list, "msg_1").unwrap(), 8, "through the idle of 2.x's own run after it");
}

/// U2: a cut that cannot be proven refuses the fork, saying why.
#[test]
fn the_cut_refuses_an_unsettled_or_unknown_message_or_a_location_switch() {
    let turns = [turn("msg_1", &["msg_a1"]), turn("msg_2", &["msg_a2"])];
    let refused = |turns: &[Value], list: &[Value], through: &str, said: &str| {
        let error = check::cut(turns, list, through).expect_err(said).to_string();
        assert!(error.contains(said) && error.contains("没有 fork"), "{said:?}: {error}");
    };
    let whole = vec![user("msg_1"), answer("msg_a1"), idle("msg_i1"), user("msg_2"), answer("msg_a2"), idle("msg_i2")];
    let mut running = turns.clone();
    running[0]["status"] = json!("inProgress");
    refused(&running, &whole, "msg_1", "只能从已完成的 Turn fork");
    let mut unfinished = whole.clone();
    unfinished[1]["time"].as_object_mut().unwrap().remove("completed");
    refused(&turns, &unfinished, "msg_1", "还没有结束");
    let mut odd = whole.clone();
    odd.insert(1, json!({"id": "msg_w", "type": "weird", "time": {"created": 1}}));
    refused(&turns, &odd, "msg_1", "类型 weird 不认识");
    let mut moved = whole.clone();
    moved.insert(1, json!({"id": "msg_l", "type": "location-switched", "location": {"directory": "/elsewhere"}, "time": {"created": 1}}));
    refused(&turns, &moved, "msg_1", "换过目录");
    let mut between = whole.clone();
    between.insert(3, json!({"id": "msg_y", "type": "synthetic", "text": "x", "time": {"created": 4}}));
    refused(&turns, &between, "msg_1", "无法确定它属于哪一段");
    refused(&turns[..1], &whole[..2], "msg_1", "运行还没有结束");
    refused(&turns, &[user("msg_1"), idle("msg_i1"), user("msg_2"), answer("msg_a2"), idle("msg_i2")], "msg_1", "不在 OpenCode 会话里");
    let early = [user("msg_2"), user("msg_1"), answer("msg_a1"), idle("msg_i1"), answer("msg_a2"), idle("msg_i2")];
    refused(&turns, &early, "msg_1", "在 fork 的这个 Turn 之前");
    let mut added = turns.clone();
    added[0]["_opencodeInputs"] = json!({"msg_s": {"confirmed": false}});
    refused(&added, &whole, "msg_1", "没有确认送到");
    let compacting = json!({"id": "compact_1", "status": "completed", "items": [], "_opencodeCompact": {"state": "pending", "input": "msg_c"}});
    refused(&[compacting, turns[0].clone()], &whole, "msg_1", "压缩结果还没有确认");
    let mut unsent = turns.clone();
    unsent[0].as_object_mut().unwrap().remove("_opencodeConfirmed");
    refused(&unsent, &whole, "msg_1", "没有确认送到");
}

/// An Agent's detail with no Turns, as a test makes it.
fn agent_detail(cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":"oc", "name":"OpenCode", "cwd":cwd, "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

/// U3: the copy is a session of its own: a new ID, this request's marker,
/// no usage (D-34), its times and outcome from the source's start and the
/// cut's idle, the model of its newest selection, and nothing null.
#[test]
fn the_copy_chooses_a_new_id_and_marker_and_zero_usage() {
    let info = json!({"id": "ses_source", "projectID": "prj", "title": "Source", "cost": 1.5,
        "tokens": {"input": 9, "output": 9, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "time": {"created": 100, "updated": 900, "idle": 900}, "outcome": "succeeded", "location": {"directory": "/work"},
        "model": {"id": "m", "providerID": "p", "variant": "default"}, "agent": "build", "permissions": null});
    let prefix = vec![user("msg_1"), model("msg_m"), answer("msg_a1"), json!({"id": "msg_i", "type": "idle", "outcome": "failed", "time": {"created": 300}})];
    let read = Read { session: "ses_source".into(), generation: 1, detail: agent_detail("/work"), info, folder: "/work".into(),
        project: "prj".into(), prefix: prefix.clone(), kept: 1, later: 0 };
    let payload = fork_payload(&read, "Forked", "req-1").unwrap();
    let sent = &payload.info;
    assert!(sent["id"].as_str().unwrap().starts_with("ses_") && sent["id"] != "ses_source", "{sent}");
    assert_eq!(payload.id(), sent["id"].as_str().unwrap());
    assert_eq!((&sent["title"], &sent["metadata"], &sent["location"]), (&json!("Forked"), &json!({"yuzuno": {"fork": "req-1"}}), &json!({"directory": "/work"})));
    assert_eq!((&sent["cost"], &sent["tokens"]), (&json!(0), &transfer::no_tokens()), "no usage, as 2.x's own fork");
    assert_eq!(sent["time"], json!({"created": 100, "updated": 300, "idle": 300}), "the source's start, the cut's idle");
    assert_eq!(sent["outcome"], "failed", "the cut's idle's outcome");
    assert_eq!(sent["model"], json!({"id": "m2", "providerID": "p"}), "the copy's newest selection");
    assert_eq!(sent["agent"], "build");
    for absent in ["permissions", "parentID", "fork", "revert", "subpath"] {
        assert!(sent.get(absent).is_none(), "no {absent}: {sent}");
    }
    assert_eq!(payload.messages, prefix);
    assert_eq!(payload.body()["location"], json!({"directory": "/work"}));
    assert_ne!(fork_payload(&read, "Forked", "req-1").unwrap().id(), payload.id(), "each payload its own ID");
}

struct Paths;

impl check::ImagePaths for Paths {
    fn path(&mut self, path: &str) -> Result<String> {
        Ok(path.replace("/src/", "/dst/"))
    }
}

/// U4: a copied Turn keeps every native ID and what it was; drops what tied
/// it to the source's process, session or sends; rewrites its images and its
/// compaction's session; is marked as copied; and a field this does not know
/// refuses the fork.
#[test]
fn the_copy_keeps_ids_rewrites_images_and_refuses_unknown_fields() {
    let prompt = json!({
        "id": "msg_1", "status": "completed", "_opencodeConfirmed": true, "interruptRequested": true, "deliveryUnconfirmed": true,
        "_yuzunoStartedAt": 5, "_opencodeLastInput": "msg_s", "_opencodeFollowed": "msg_y", "_opencodeShells": {"msg_sh": "msg_1"},
        "_opencodeAnswers": {"msg_a": {"parent": "msg_1", "completed": 2, "error": null, "finish": "stop"}},
        "_opencodeInputs": {"msg_s": {"confirmed": true, "previous": "msg_1", "clientMessageId": "c2", "deliveryUnconfirmed": true}},
        "_opencodeSessionError": {"name": "X"}, "error": {"message": "m"}, "_yuzunoCopiedFrom": {"agentId": "older"},
        "items": [
            {"id": "msg_1:input", "type": "userMessage", "nativeMessageId": "msg_1", "clientId": "c1", "deliveryUnconfirmed": true,
             "_yuzunoTime": {"at": 1}, "content": [{"type": "text", "text": "hi"}, {"type": "localImage", "path": "/data/src/a.png"}]},
            {"id": "msg_a:0", "type": "agentMessage", "text": "done", "nativeMessageId": "msg_a"},
            {"id": "msg_sh", "type": "commandExecution", "command": "ls", "status": "completed", "aggregatedOutput": "x", "exitCode": 0, "nativeMessageId": "msg_sh"},
        ]});
    let compact = json!({"id": "compact_1", "status": "completed", "items": [{"id": "compact_1:compaction", "type": "contextCompaction", "trigger": "manual", "text": "s"}],
        "_opencodeCompact": {"state": "completed", "session": "ses_source", "generation": 3, "askedBy": "srv", "answered": 7, "input": "msg_c",
            "model": "p/m", "variant": null, "native": {"status": "completed"}}});
    let legacy = json!({"id": "compact_0", "status": "failed", "items": [], "_opencodeCompact": {"state": "lost", "message": "msg_old", "known": []}});
    let from = json!({"agentId": "oc", "sessionId": "ses_source", "requestId": "req-1"});
    let copied = check::copy(&[prompt, compact, legacy], "ses_new", &from, &mut Paths).unwrap();
    let p = &copied[0];
    assert_eq!((&p["id"], &p["_opencodeLastInput"], &p["_opencodeFollowed"], &p["_opencodeShells"]),
        (&json!("msg_1"), &json!("msg_s"), &json!("msg_y"), &json!({"msg_sh": "msg_1"})), "native IDs as they are");
    assert_eq!(p["_opencodeAnswers"]["msg_a"]["parent"], "msg_1");
    assert_eq!(p["_opencodeInputs"], json!({"msg_s": {"confirmed": true}}), "its sends left behind");
    for gone in ["interruptRequested", "deliveryUnconfirmed"] {
        assert!(p.get(gone).is_none(), "no {gone}");
    }
    assert_eq!(p["_yuzunoCopiedFrom"], from, "marked as this fork's copy, a copy of a copy too");
    let item = &p["items"][0];
    assert!(item.get("clientId").is_none() && item.get("deliveryUnconfirmed").is_none(), "{item}");
    assert_eq!(item["content"][1]["path"], "/data/dst/a.png", "the image is the new Agent's");
    assert_eq!(p["items"][2]["aggregatedOutput"], "x");
    let c = &copied[1]["_opencodeCompact"];
    assert_eq!((&c["session"], &c["input"], &c["state"]), (&json!("ses_new"), &json!("msg_c"), &json!("completed")));
    for gone in ["generation", "askedBy", "answered"] {
        assert!(c.get(gone).is_none(), "no {gone}: {c}");
    }
    assert_eq!(copied[2]["_opencodeCompact"], json!({"state": "lost"}), "one from 1.19.3's time: only that it was lost");

    let refused = |turn: Value, said: &str| {
        let error = check::copy(&[turn], "ses_new", &from, &mut Paths).expect_err(said).to_string();
        assert!(error.contains(said) && error.contains("没有 fork"), "{error}");
    };
    refused(json!({"id": "msg_1", "status": "completed", "_somethingNew": 1}), "_somethingNew");
    refused(json!({"id": "msg_1", "status": "completed", "items": [{"id": "x", "type": "userMessage", "_new": 1}]}), "_new");
    refused(json!({"id": "c", "status": "completed", "_opencodeCompact": {"state": "completed", "input": "msg_c", "_new": 1}}), "_new");
}

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

/// A Workspace with an OpenCode Agent `oc` in `cwd`, connected to the stand-in.
#[cfg(target_os = "linux")]
async fn lab(dir: &Path, cwd: &Path) -> Arc<Workspace> {
    program();
    let ws = Workspace::new(dir.join("data"), dir.to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent_detail(&cwd.to_string_lossy())).unwrap();
    std::fs::create_dir_all(dir.join("data/opencode/oc")).unwrap();
    ws.reconnect("oc").await.unwrap();
    ws
}

/// The stand-in serving `agent`, by its control (`start.json`).
async fn control(data: &Path, agent: &str, name: &str, body: Value) -> Value {
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode").join(agent).join("start.json")).unwrap()).unwrap();
    reqwest::Client::builder().no_proxy().build().unwrap()
        .post(format!("http://127.0.0.1:{}/__fixture/{name}", seen["port"])).json(&body)
        .timeout(Duration::from_secs(20)).send().await.unwrap().json().await.unwrap()
}

/// What `agent`'s stand-ins were asked, every process there in turn.
fn calls(data: &Path, agent: &str) -> Vec<Value> {
    std::fs::read_to_string(data.join("opencode").join(agent).join("calls.jsonl")).unwrap_or_default().lines()
        .map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn asked(data: &Path, agent: &str, method: &str, path: &str) -> Vec<Value> {
    calls(data, agent).into_iter().filter(|c| c["method"] == method && c["path"].as_str().is_some_and(|p| p.ends_with(path))).collect()
}

/// How many requests `agent`'s stand-ins were asked that may write.
fn writes(data: &Path, agent: &str) -> usize {
    calls(data, agent).iter().filter(|c| c["method"] != "GET").count()
}

/// How many times an OpenCode was started for `agent`.
fn starts(data: &Path, agent: &str) -> usize {
    std::fs::read_to_string(data.join("opencode").join(agent).join("starts.jsonl")).unwrap_or_default().lines().count()
}

/// What `agent`'s stand-in keeps, as it saved it.
fn held(data: &Path, agent: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(data.join("opencode").join(agent).join("state.json")).unwrap_or_else(|_| "{}".into())).unwrap()
}

/// How many sessions `agent`'s stand-in keeps.
fn sessions_held(data: &Path, agent: &str) -> usize {
    held(data, agent)["sessions"].as_object().map(Map::len).unwrap_or(0)
}

/// Modes for the next OpenCode started on a new database: a fork's target,
/// whose folder a test cannot know beforehand.
fn plan_new(data: &Path, modes: Value) {
    std::fs::write(data.join("opencode/fixture-new.json"), modes.to_string()).unwrap();
}

/// A Turn sent to `agent` and answered (with `answer`'s extra fields): its ID, once Core has it completed.
async fn turn_on(ws: &Arc<Workspace>, data: &Path, agent: &str, text: &str, answer: Value) -> String {
    ws.opencode_send(agent, text.into()).await.unwrap();
    let session = ws.opencodes.lock().unwrap().get(agent).cloned().unwrap().session;
    let id = ws.store.detail(agent).unwrap().turns.last().unwrap()["id"].as_str().unwrap().to_owned();
    let mut reply = json!({"sessionID": session, "text": "done", "parentID": id});
    reply.as_object_mut().unwrap().extend(answer.as_object().unwrap().clone());
    control(data, agent, "reply", reply).await;
    for _ in 0..400 {
        let d = ws.store.detail(agent).unwrap();
        if d.agent.status == "idle" && d.turns.iter().any(|t| t["id"] == id && t["status"] == "completed") {
            return id;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("Turn {id} did not complete: {:#?}", ws.store.detail(agent).unwrap().turns);
}

fn request(id: &str, turn: &str, name: &str) -> Request {
    Request { request_id: id.into(), turn_id: turn.into(), name: name.into() }
}

/// A lab with three answered Turns: the Workspace, its data folder, the work folder and the Turns.
#[cfg(target_os = "linux")]
async fn three(root: &Path) -> (Arc<Workspace>, std::path::PathBuf, std::path::PathBuf, [String; 3]) {
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(root, &cwd).await;
    let data = root.join("data");
    let first = turn_on(&ws, &data, "oc", "first", json!({})).await;
    let second = turn_on(&ws, &data, "oc", "second", json!({})).await;
    let third = turn_on(&ws, &data, "oc", "third", json!({})).await;
    (ws, data, cwd, [first, second, third])
}

/// The source's session and messages as its OpenCode holds them now.
async fn source_session(ws: &Arc<Workspace>) -> (String, Vec<Value>) {
    let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
    (c.session.clone(), c.server.messages(&c.session).await.unwrap().as_array().unwrap().clone())
}

/// I1: a fork through a Turn is a new Agent in the same folder, holding the
/// Turns through it under their own IDs, its OpenCode started once on its
/// own database with the copy written there once; the source is only read.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_completed_turn_is_forked_into_a_new_agent_without_writing_the_source() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, [first, second, third]) = three(&root).await;
    let (source, messages) = source_session(&ws).await;
    let cut = messages.iter().position(|m| m["id"] == third.as_str()).unwrap();
    let preview = ws.opencode_fork_preview("oc", &second).await.unwrap();
    assert_eq!((&preview["keptTurns"], &preview["laterTurns"], &preview["messages"]), (&json!(2), &json!(1), &json!(cut)), "{preview}");
    let (kept, written) = (std::fs::read(data.join("opencode/oc/state.json")).unwrap(), writes(&data, "oc"));
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap();
    assert_eq!(outcome["state"], "completed", "{outcome}");
    let target = outcome["agent"]["id"].as_str().unwrap().to_owned();
    // The source: only read, its OpenCode's state as it was.
    assert_eq!((writes(&data, "oc"), std::fs::read(data.join("opencode/oc/state.json")).unwrap()), (written, kept), "nothing written to the source");
    // The copy: written once into the new Agent's own OpenCode, every message through the cut as the source lists them.
    let imports = asked(&data, &target, "POST", "/api/experimental/session/import");
    assert_eq!(imports.len(), 1);
    let sent = &imports[0]["body"];
    let session = sent["info"]["id"].as_str().unwrap().to_owned();
    assert!(session.starts_with("ses_") && session != source, "{session}");
    assert_eq!(sent["messages"], json!(messages[..cut]), "the source's messages through the cut, as they are");
    assert_eq!((&sent["info"]["metadata"], &sent["location"]), (&json!({"yuzuno": {"fork": key}}), &json!({"directory": cwd.to_str().unwrap()})));
    assert_eq!(held(&data, &target)["imported"][&session], json!(messages[..cut]), "the new Agent's OpenCode holds that copy");
    // The new Agent: the same folder, the copy's session, the Turns under their own IDs, each marked as copied.
    let d = ws.store.detail(&target).unwrap();
    assert_eq!((d.agent.cwd.as_str(), d.agent.name.as_str(), d.agent.harness.as_str()), (cwd.to_str().unwrap(), "Forked", "opencode"));
    assert_eq!(d.agent.opencode_session_id.as_deref(), Some(session.as_str()));
    assert_eq!(ws.store.turn_ids(&target).unwrap(), vec![first.clone(), second.clone()]);
    for turn in ws.store.stored_turns(&target).unwrap() {
        assert_eq!(turn["_yuzunoCopiedFrom"], json!({"agentId": "oc", "sessionId": source, "requestId": key}), "{turn}");
    }
    // Started once, and attached to that same process; no empty session made there first.
    assert_eq!(starts(&data, &target), 1);
    assert!(asked(&data, &target, "POST", "/api/session").iter().all(|c| c["path"] != "/api/session"), "no session made");
    assert_eq!(asked(&data, &target, "GET", "/api/event").len(), 1);
    assert_eq!(ws.listed(&target).await.unwrap().connection_state, "connected");
    // The source as it was; the new Agent goes on by itself.
    assert_eq!(ws.store.turn_ids("oc").unwrap(), vec![first, second.clone(), third]);
    let next = turn_on(&ws, &data, &target, "next", json!({})).await;
    assert_eq!(ws.store.turn_ids(&target).unwrap().last(), Some(&next));
    assert_eq!(ws.store.turn_ids(&target).unwrap().len(), 3);
    // Read without a write: that fork, done, by its Turn; another request for the Turn is that one.
    let seen = ws.opencode_fork_seen("oc", Which { request_id: None, turn_id: Some(second.clone()) }).await.unwrap();
    assert_eq!((&seen["state"], &seen["agent"]["id"]), (&json!("completed"), &json!(target)), "{seen}");
    let other = uuid::Uuid::new_v4().to_string();
    assert_eq!(ws.opencode_fork("oc", request(&other, &second, "Forked")).await.unwrap()["agent"]["id"], json!(target));
    assert_eq!(asked(&data, &target, "POST", "/api/experimental/session/import").len(), 1, "written once");
    // Its Agent deleted, the Turn can be forked anew.
    ws.delete_agent(&target).await.unwrap();
    let anew = ws.opencode_fork("oc", request(&other, &second, "Forked")).await.unwrap();
    assert_eq!(anew["state"], "completed", "{anew}");
    assert_eq!(ws.store.opencode_fork_row(&key).unwrap().unwrap().state, "released");
    ws.close_agent(anew["agent"]["id"].as_str().unwrap()).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// YN-2 S4: the user's fork leads the source's Project, even when the source
/// is an executor: the fork is a standing Agent of its own. The source stays
/// an executor.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_fork_of_an_executor_leads_the_sources_project() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, _data, _cwd, [_first, second, _third]) = three(&root).await;
    let project = ws.store.create_project("Lab", Default::default()).unwrap().id;
    ws.store.set_agent_project("oc", Some(&project)).unwrap();
    ws.store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at)
         VALUES('oc','executor','reviewer','T-1','lead','running','now','now')", []).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap();
    assert_eq!(outcome["state"], "completed", "{outcome}");
    let target = outcome["agent"]["id"].as_str().unwrap().to_owned();
    assert_eq!(ws.store.agent_project(&target).unwrap().as_deref(), Some(project.as_str()));
    {
        let db = ws.store.db.read().unwrap();
        assert!(crate::agent_roles::leads(&db, &target, &project).unwrap(), "the user's fork of an executor leads the source's Project");
        assert_eq!(crate::agent_roles::kind(&db, "oc").unwrap(), crate::agent_roles::EXECUTOR, "the source stays an executor");
    }
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// I2 (D-33): an import whose answer was lost leaves the fork uncertain and
/// registers nothing; the same request goes on, finds the copy the new
/// Agent's OpenCode holds, and writes nothing twice.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_lost_import_answer_is_continued_to_one_session() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [_, second, _]) = three(&root).await;
    plan_new(&data, json!({"import": "lost"}));
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap();
    assert_eq!(outcome["state"], "uncertain", "{outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("不会写第二次"), "{outcome}");
    let row = ws.store.opencode_fork_row(&key).unwrap().unwrap();
    assert!(ws.listed(&row.target_agent_id).await.is_err(), "nothing registered");
    // The source goes on meanwhile.
    turn_on(&ws, &data, "oc", "fourth", json!({})).await;
    let seen = ws.opencode_fork_seen("oc", Which { request_id: Some(key.clone()), turn_id: None }).await.unwrap();
    assert_eq!(seen["state"], "uncertain", "{seen}");
    // Going on: the copy is there already, so it is read back, not written again.
    let continued = ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap();
    assert_eq!(continued["state"], "completed", "{continued}");
    assert_eq!(continued["agent"]["id"], json!(row.target_agent_id));
    assert_eq!(asked(&data, &row.target_agent_id, "POST", "/api/experimental/session/import").len(), 1, "written once");
    assert_eq!(sessions_held(&data, &row.target_agent_id), 1, "one session");
    assert_eq!(starts(&data, &row.target_agent_id), 2, "started again to go on");
    ws.close_agent(&row.target_agent_id).await.unwrap();

    ws.close_agent("oc").await.unwrap();
}

/// #736 R1: an import that fails every time fails the fork, so the Turn is
/// free to be forked anew, never held by an attempt that can't end: an
/// answer of any error (here a 500), or no answer a second time once the
/// new OpenCode was read to hold nothing. The new Agent's folder is kept,
/// and a new attempt writes into one of its own (D-36).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_import_that_fails_every_time_fails_the_fork_and_frees_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, second, _]) = three(&root).await;
    // An error answer.
    plan_new(&data, json!({"import": "fail"}));
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap();
    assert_eq!(outcome["state"], "failed", "an error answer fails it: {outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("可以重新 fork"), "{outcome}");
    let row = ws.store.opencode_fork_row(&key).unwrap().unwrap();
    assert!(ws.listed(&row.target_agent_id).await.is_err(), "nothing registered");
    assert!(data.join("opencode").join(&row.target_agent_id).join("fork.json").is_file(), "its folder kept");
    plan_new(&data, json!({}));
    let anew = ws.opencode_fork("oc", request(&uuid::Uuid::new_v4().to_string(), &second, "Forked")).await.unwrap();
    assert_eq!(anew["state"], "completed", "the Turn is free: {anew}");
    ws.close_agent(anew["agent"]["id"].as_str().unwrap()).await.unwrap();
    // No answer, twice: the second time, after the new OpenCode was read to hold nothing.
    plan_new(&data, json!({"import": "hold"}));
    let key = uuid::Uuid::new_v4().to_string();
    assert_eq!(ws.opencode_fork("oc", request(&key, &first, "Forked")).await.unwrap()["state"], "uncertain", "once: it may go on");
    let outcome = ws.opencode_fork("oc", request(&key, &first, "Forked")).await.unwrap();
    assert_eq!(outcome["state"], "failed", "no answer again: {outcome}");
    plan_new(&data, json!({}));
    let anew = ws.opencode_fork("oc", request(&uuid::Uuid::new_v4().to_string(), &first, "Forked")).await.unwrap();
    assert_eq!(anew["state"], "completed", "the Turn is free: {anew}");
    ws.close_agent(anew["agent"]["id"].as_str().unwrap()).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// I3: an import still held when the watch ends leaves the fork uncertain;
/// the new Agent's OpenCode ends with that run, so its late answer opens
/// nothing, and the same request goes on from what the new OpenCode holds.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_import_held_past_the_watch_opens_nothing_and_the_same_request_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [_, second, _]) = three(&root).await;
    plan_new(&data, json!({"import": "hold"}));
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap();
    assert_eq!(outcome["state"], "uncertain", "{outcome}");
    let row = ws.store.opencode_fork_row(&key).unwrap().unwrap();
    assert!(ws.listed(&row.target_agent_id).await.is_err(), "nothing registered");
    assert_eq!(sessions_held(&data, &row.target_agent_id), 0, "nothing written");
    plan_new(&data, json!({}));
    let continued = ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap();
    assert_eq!(continued["state"], "completed", "{continued}");
    assert_eq!(sessions_held(&data, &row.target_agent_id), 1, "one session");
    ws.close_agent(&row.target_agent_id).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// I4 and I7 (rule R6): a copy the new Agent's OpenCode does not hold as it
/// was sent, or a session it holds under that ID that is another, fails the
/// fork: nothing registered, the folder kept (D-36), the source unchanged.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_target_that_changes_the_copy_or_holds_another_session_fails_the_fork() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, second, _]) = three(&root).await;
    for (mode, turn, said) in [("tamper", &second, "第 1 条消息"), ("conflict-other", &first, "title")] {
        plan_new(&data, json!({"import": mode}));
        let key = uuid::Uuid::new_v4().to_string();
        let outcome = ws.opencode_fork("oc", request(&key, turn, "Forked")).await.unwrap();
        assert_eq!(outcome["state"], "failed", "{mode}: {outcome}");
        let message = outcome["message"].as_str().unwrap();
        assert!(message.contains(said) && message.contains("没有登记"), "{mode}: {outcome}");
        let row = ws.store.opencode_fork_row(&key).unwrap().unwrap();
        assert!(ws.listed(&row.target_agent_id).await.is_err(), "{mode}: nothing registered");
        assert!(data.join("opencode").join(&row.target_agent_id).join("fork.json").is_file(), "{mode}: its folder kept");
        // Failed, the Turn can be forked anew.
        plan_new(&data, json!({}));
        let again = ws.opencode_fork("oc", request(&uuid::Uuid::new_v4().to_string(), turn, "Forked")).await.unwrap();
        assert_eq!(again["state"], "completed", "{mode}: {again}");
        ws.close_agent(again["agent"]["id"].as_str().unwrap()).await.unwrap();
    }
    assert_eq!(ws.store.turn_ids("oc").unwrap().len(), 3, "the source unchanged");
    ws.close_agent("oc").await.unwrap();
}

/// I5: a fork is refused, before anything is fixed or any OpenCode is
/// started, while the source's session holds a revert or the source runs;
/// the source goes on.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn refusals_come_before_anything_is_fixed_or_started() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, second, _]) = three(&root).await;
    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    let refused = |turn: String, said: &'static str| {
        let ws = ws.clone();
        async move {
            let error = ws.opencode_fork("oc", request(&uuid::Uuid::new_v4().to_string(), &turn, "Forked")).await.expect_err(said).to_string();
            assert!(error.contains(said), "{said:?}: {error}");
        }
    };
    control(&data, "oc", "revert", json!({"sessionID": session})).await;
    refused(second.clone(), "尚未处理的回退").await;
    {
        // Committed as 2.x commits it: its boundary is no message of the session's, so nothing goes.
        let c = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap();
        c.server.commit(&c.session).await.unwrap();
    }
    control(&data, "oc", "busy", json!({"sessionID": session})).await;
    refused(first.clone(), "空闲").await;
    control(&data, "oc", "idle", json!({"sessionID": session})).await;
    assert!(!data.join("opencode/forks").exists() || std::fs::read_dir(data.join("opencode/forks")).unwrap().next().is_none(), "nothing fixed");
    let started: Vec<String> = std::fs::read_dir(data.join("opencode")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| uuid::Uuid::parse_str(n).is_ok()).collect();
    assert!(started.is_empty(), "no OpenCode started for a fork: {started:?}");
    ws.close_agent("oc").await.unwrap();
}

/// I6 (D-32): in the new Agent a Rewind to before a copied Turn is refused
/// with its own words, asking nothing; one to a Turn of its own goes on.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn copied_turns_refuse_rewind_in_the_new_agent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, second, _]) = three(&root).await;
    let outcome = ws.opencode_fork("oc", request(&uuid::Uuid::new_v4().to_string(), &second, "Forked")).await.unwrap();
    let target = outcome["agent"]["id"].as_str().unwrap().to_owned();
    for copied in [&first, &second] {
        let error = ws.opencode_revert_preview(&target, copied).await.expect_err("a copied Turn is not rewound").to_string();
        assert!(error.contains("fork 时从原 Agent 复制来的"), "{error}");
    }
    let own = turn_on(&ws, &data, &target, "own", json!({})).await;
    let preview = ws.opencode_revert_preview(&target, &own).await.expect("one of its own is");
    assert_eq!(preview["removedTurns"], 1, "{preview}");
    assert!(asked(&data, &target, "POST", "/revert/stage").is_empty(), "nothing asked");
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// A fork 1.19.3's fork began (its fixed record of 1.19.3's form) cannot go
/// on: it fails, saying so, and the Turn can be forked anew.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_fork_begun_on_1193_fails_and_the_turn_can_be_forked_anew() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, _data, _, [_, second, _]) = three(&root).await;
    let key = uuid::Uuid::new_v4().to_string();
    let old = Row { request_id: key.clone(), source_agent_id: "oc".into(), through_turn_id: second.clone(), target_agent_id: uuid::Uuid::new_v4().to_string(),
        name: "Old".into(), state: "sending".into(), fork_session: None, error: None, prefix_sha: "0".repeat(64) };
    ws.store.opencode_begin_fork(&old).unwrap();
    ws.store.opencode_set_fork(&key, "chained", Some("ses_old"), None).unwrap();
    write_private(&ws.opencode_fork_folder(&key).unwrap().join("frozen.json"), &serde_json::to_vec(&json!({"session": "ses_x", "messages": []})).unwrap()).unwrap();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "Old")).await.unwrap();
    assert_eq!(outcome["state"], "failed", "{outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("1.19.3"), "{outcome}");
    let anew = ws.opencode_fork("oc", request(&uuid::Uuid::new_v4().to_string(), &second, "Forked")).await.unwrap();
    assert_eq!(anew["state"], "completed", "{anew}");
    ws.close_agent(anew["agent"]["id"].as_str().unwrap()).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// A fork whose client goes away still ends, and is kept: in a task of its
/// own (contract 3).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_fork_whose_client_goes_away_still_ends_and_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [_, second, _]) = three(&root).await;
    plan_new(&data, json!({"import": "hold"}));
    let key = uuid::Uuid::new_v4().to_string();
    let asking = {
        let (ws, key, second) = (ws.clone(), key.clone(), second.clone());
        tokio::spawn(async move { ws.opencode_fork("oc", request(&key, &second, "Forked")).await })
    };
    let mut row = None;
    for _ in 0..400 {
        row = ws.store.opencode_fork_row(&key).unwrap();
        if row.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let row = row.expect("the attempt is kept before it is asked");
    asking.abort();
    let _ = asking.await;
    let mut state = String::new();
    for _ in 0..400 {
        state = ws.store.opencode_fork_row(&key).unwrap().unwrap().state;
        if state != "sending" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(state, "uncertain", "the attempt ended though its client went away");
    plan_new(&data, json!({}));
    assert_eq!(ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap()["state"], "completed");
    ws.close_agent(&row.target_agent_id).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// On 2.x every one of these goes by 2.x's own routes, none of 1.19.3's: a
/// fork, by import into the new Agent's own OpenCode (slice 7); a rewind,
/// staged then committed (slices 5 and 6); a compaction (slice 4).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn on_2x_fork_rewind_and_compaction_go_by_2xs_own_routes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let first = turn_on(&ws, &data, "oc", "hello", json!({})).await;
    let second = turn_on(&ws, &data, "oc", "again", json!({})).await;
    let forked = ws.opencode_fork("oc", request(&uuid::Uuid::new_v4().to_string(), &first, "F")).await.expect("a 2.x fork");
    assert_eq!(forked["state"], "completed", "{forked}");
    let target = forked["agent"]["id"].as_str().unwrap().to_owned();
    let preview = ws.opencode_revert_preview("oc", &second).await.expect("a 2.x rewind is previewed");
    let reverted = ws.opencode_revert_confirm("oc", preview["previewId"].as_str().unwrap()).await.expect("and confirmed");
    assert_eq!(reverted["status"], "completed", "staged, then committed: {reverted}");
    assert_eq!((asked(&data, "oc", "POST", "/revert/stage").len(), asked(&data, "oc", "POST", "/revert/commit").len()), (1, 1),
        "2.x's stage, then its commit");
    // Its model is the Agent's chosen one, made the session's first (D-19 (a)).
    ws.opencode_set_model("oc", "deepseek/deepseek-flash".into()).await.unwrap();
    ws.opencode_compact("oc").await.expect("compaction goes on 2.x");
    assert_eq!(asked(&data, "oc", "POST", "/compact").len(), 1, "by 2.x's own route");
    for (agent, path) in [("oc", "/revert"), ("oc", "/fork"), ("oc", "/summarize"), ("oc", "/sync/history"), (target.as_str(), "/sync/replay")] {
        assert!(asked(&data, agent, "POST", path).is_empty(), "nothing of 1.19.3's: {path}");
    }
    for agent in ["oc", target.as_str()] {
        assert!(asked(&data, agent, "GET", "/path").is_empty() && asked(&data, agent, "GET", "/project/current").is_empty(), "{agent}");
    }
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// D-37 (T-61 slice 8): a fork's own Turn is forked again. Its session holds
/// only Core's marker as metadata, which the new copy replaces with its own.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_forks_turn_is_forked_again() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, _data, _, [first, _, _]) = three(&root).await;
    let forked = ws.opencode_fork("oc", request(&uuid::Uuid::new_v4().to_string(), &first, "F1")).await.unwrap();
    let target = forked["agent"]["id"].as_str().unwrap().to_owned();
    let again = ws.opencode_fork(&target, request(&uuid::Uuid::new_v4().to_string(), &first, "F2")).await.unwrap();
    assert_eq!(again["state"], "completed", "{again}");
    let second = again["agent"]["id"].as_str().unwrap().to_owned();
    assert_eq!(ws.store.stored_turns(&second).unwrap()[0]["_yuzunoCopiedFrom"]["agentId"], json!(target), "copied from the fork");
    ws.close_agent(&second).await.unwrap();
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}
