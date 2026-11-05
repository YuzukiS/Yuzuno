use super::*;
use std::path::Path;

fn user(id: &str) -> Value {
    json!({"info":{"id":id,"sessionID":"ses_a","role":"user","time":{"created":1}},
        "parts":[{"id":format!("prt_{id}"),"sessionID":"ses_a","messageID":id,"type":"text","text":id}]})
}

fn answer(id: &str, parent: &str) -> Value {
    json!({"info":{"id":id,"sessionID":"ses_a","role":"assistant","parentID":parent,"time":{"created":2,"completed":3}},
        "parts":[{"id":format!("prt_{id}"),"sessionID":"ses_a","messageID":id,"type":"text","text":"done"}]})
}

fn turn(id: &str, answers: &[&str]) -> Value {
    let answers: serde_json::Map<String, Value> = answers.iter().map(|a| (a.to_string(), json!({"completed":3,"parent":id}))).collect();
    json!({"id":id,"status":"completed","_opencodeConfirmed":true,"_opencodeAnswers":answers,"items":[]})
}

#[test]
fn a_boundary_is_the_next_turns_own_start_and_everything_a_kept_turn_holds_comes_before_it() {
    let list = vec![user("msg_1"), answer("msg_2", "msg_1"), user("msg_3"), answer("msg_4", "msg_3")];
    let turns = vec![turn("msg_1", &["msg_2"]), turn("msg_3", &["msg_4"])];
    assert_eq!(check::boundary(&turns, &list, "msg_1").unwrap(), (Some("msg_3".into()), 2));
    // Through the newest Turn: no cutoff, every message kept.
    assert_eq!(check::boundary(&turns, &list, "msg_3").unwrap(), (None, 4));
    // OpenCode's own follow-up and its answer stay with the Turn they follow.
    let list = vec![user("msg_1"), answer("msg_2", "msg_1"), user("msg_2b"), answer("msg_2c", "msg_2b"), user("msg_3"), answer("msg_4", "msg_3")];
    let mut first = turn("msg_1", &["msg_2"]);
    first["_opencodeFollowed"] = json!("msg_2b");
    let turns = vec![first, turn("msg_3", &["msg_4"])];
    assert_eq!(check::boundary(&turns, &list, "msg_1").unwrap(), (Some("msg_3".into()), 4));
}

/// A completed `/compact` Turn bound to `message`, summarised by `summary`.
fn compact(turn: &str, message: &str, summary: &str, known: &[&str]) -> Value {
    let candidates: serde_json::Map<String, Value> = known.iter().chain([&message]).map(|k| (k.to_string(), json!({"model":true}))).collect();
    json!({"id":turn,"status":"completed","items":[{"id":format!("{turn}:compaction"),"type":"contextCompaction","trigger":"manual","text":"short"}],
        "_opencodeCompact":{"state":"completed","session":"ses_a","generation":1,"known":known,"candidates":candidates,
            "message":message,"part":format!("prt_{message}"),"summary":{"id":summary,"completed":3,"finish":"stop"},
            "text":{format!("prt_{summary}"):"short"}}})
}

fn compaction(id: &str) -> Value {
    let mut message = user(id);
    message["parts"][0]["type"] = json!("compaction");
    message
}

#[test]
fn a_fork_between_two_compactions_ends_at_the_later_ones_own_message() {
    // `/compact` A, a Turn T, then `/compact` B, whose `known` and
    // `candidates` name A's message: what B looked at, not what it owns.
    let mut summary_a = answer("msg_sa", "msg_ca");
    summary_a["info"]["summary"] = json!(true);
    let mut summary_b = answer("msg_sb", "msg_cb");
    summary_b["info"]["summary"] = json!(true);
    let list = vec![compaction("msg_ca"), summary_a, user("msg_t"), answer("msg_ta", "msg_t"), compaction("msg_cb"), summary_b];
    let turns = vec![compact("compact_a", "msg_ca", "msg_sa", &[]), turn("msg_t", &["msg_ta"]), compact("compact_b", "msg_cb", "msg_sb", &["msg_ca"])];
    assert_eq!(check::boundary(&turns, &list, "msg_t").unwrap(), (Some("msg_cb".into()), 4));
    // Through A itself: up to T's own start.
    assert_eq!(check::boundary(&turns, &list, "compact_a").unwrap(), (Some("msg_t".into()), 2));
    // A summary that answers another message is not that compaction's.
    let mut wrong = list.clone();
    wrong[1]["info"]["parentID"] = json!("msg_t");
    let refused = check::boundary(&turns, &wrong, "msg_t").unwrap_err().to_string();
    assert!(refused.contains("压缩与 OpenCode 会话对不上"), "{refused}");
}

#[test]
fn a_boundary_that_cannot_be_proven_refuses_the_fork() {
    let list = vec![user("msg_1"), answer("msg_2", "msg_1"), user("msg_3"), answer("msg_4", "msg_3")];
    // The next Turn's start is not in the session: OpenCode would copy everything.
    let turns = vec![turn("msg_1", &["msg_2"]), turn("msg_9", &["msg_4"])];
    let refused = check::boundary(&turns, &list, "msg_1").unwrap_err().to_string();
    assert!(refused.contains("起点无法确定"), "{refused}");
    // A kept Turn's answer past the boundary.
    let turns = vec![turn("msg_1", &["msg_2", "msg_4"]), turn("msg_3", &[])];
    let refused = check::boundary(&turns, &list, "msg_1").unwrap_err().to_string();
    assert!(refused.contains("越过了 fork 的边界"), "{refused}");
    // A later Turn's answer before it.
    let turns = vec![turn("msg_1", &[]), turn("msg_3", &["msg_2", "msg_4"])];
    let refused = check::boundary(&turns, &list, "msg_1").unwrap_err().to_string();
    assert!(refused.contains("在 fork 的边界之前"), "{refused}");
    // An answer not yet ended, through the newest Turn.
    let mut open = answer("msg_4", "msg_3");
    open["info"]["time"] = json!({"created":2});
    let list = vec![user("msg_1"), answer("msg_2", "msg_1"), user("msg_3"), open];
    let turns = vec![turn("msg_1", &["msg_2"]), turn("msg_3", &["msg_4"])];
    let refused = check::boundary(&turns, &list, "msg_3").unwrap_err().to_string();
    assert!(refused.contains("还没有结束"), "{refused}");
    // An input added to a kept Turn and never confirmed.
    let list = vec![user("msg_1"), answer("msg_2", "msg_1")];
    let mut added = turn("msg_1", &["msg_2"]);
    added["_opencodeInputs"] = json!({"msg_1b":{"confirmed":false,"previous":null}});
    let refused = check::boundary(&[added], &list, "msg_1").unwrap_err().to_string();
    assert!(refused.contains("没有确认送到"), "{refused}");
}

fn copied(source: &Value, id: &str, parent: Option<&str>) -> Value {
    let mut copy = source.clone();
    copy["info"]["id"] = json!(id);
    copy["info"]["sessionID"] = json!("ses_b");
    if let Some(parent) = parent {
        copy["info"]["parentID"] = json!(parent);
    }
    for part in copy["parts"].as_array_mut().unwrap() {
        part["id"] = json!(format!("prt_{id}"));
        part["messageID"] = json!(id);
        part["sessionID"] = json!("ses_b");
    }
    copy
}

#[test]
fn a_fork_pairs_with_what_it_copies_only_as_opencodes_exact_copy() {
    let prefix = [user("msg_1"), answer("msg_2", "msg_1")];
    let fork = vec![copied(&prefix[0], "msg_7", None), copied(&prefix[1], "msg_8", Some("msg_7"))];
    let ids = check::pair(&prefix, &fork, "ses_b").unwrap();
    assert_eq!(ids.get("msg_1").map(String::as_str), Some("msg_7"));
    assert_eq!(ids.get("prt_msg_2").map(String::as_str), Some("prt_msg_8"));
    // OpenCode keeps an old parent it did not map: a reference out of the fork.
    let dangling = vec![copied(&prefix[0], "msg_7", None), copied(&prefix[1], "msg_8", Some("msg_1"))];
    assert!(check::pair(&prefix, &dangling, "ses_b").unwrap_err().to_string().contains("不是原消息"));
    // One message short.
    assert!(check::pair(&prefix, &fork[..1], "ses_b").unwrap_err().to_string().contains("应为 2 条"));
    // A copy whose text differs.
    let mut changed = fork.clone();
    changed[1]["parts"][0]["text"] = json!("other");
    assert!(check::pair(&prefix, &changed, "ses_b").unwrap_err().to_string().contains("不是原部分"));
}

#[test]
fn a_forks_events_are_exactly_its_copy_numbered_from_zero() {
    let prefix = [user("msg_1"), answer("msg_2", "msg_1")];
    let fork = vec![copied(&prefix[0], "msg_7", None), copied(&prefix[1], "msg_8", Some("msg_7"))];
    let info = json!({"id":"ses_b","directory":"/w","projectID":"p","title":"t (fork #1)"});
    let mut events = vec![json!({"id":"evt_0","aggregate_id":"ses_b","seq":0,"type":"session.created.1","data":{"sessionID":"ses_b","info":info}})];
    for message in &fork {
        events.push(json!({"id":format!("evt_{}", events.len()),"aggregate_id":"ses_b","seq":events.len(),"type":"message.updated.1",
            "data":{"sessionID":"ses_b","info":message["info"]}}));
        for part in message["parts"].as_array().unwrap() {
            events.push(json!({"id":format!("evt_{}", events.len()),"aggregate_id":"ses_b","seq":events.len(),"type":"message.part.updated.1",
                "data":{"sessionID":"ses_b","part":part,"time":1}}));
        }
    }
    let chain = check::chain(&events, "ses_b", &info, &fork).unwrap();
    assert_eq!((chain.len(), &chain[0]["aggregateID"], &chain[0]["seq"]), (5, &json!("ses_b"), &json!(0)));
    // A gap.
    let gap: Vec<Value> = events.iter().filter(|e| e["seq"] != 2).cloned().collect();
    assert!(check::chain(&gap, "ses_b", &info, &fork).unwrap_err().to_string().contains("连续编号"));
    // An event the fork did not write.
    let mut other = events.clone();
    other.push(json!({"id":"evt_x","aggregate_id":"ses_b","seq":5,"type":"session.updated.1","data":{"sessionID":"ses_b","info":info}}));
    assert!(check::chain(&other, "ses_b", &info, &fork).unwrap_err().to_string().contains("不是 fork 写的"));
    // Events that make something else than the fork read.
    assert!(check::chain(&events[..4], "ses_b", &info, &fork).unwrap_err().to_string().contains("与读到的 fork 不同"));
}

// With the stand-in of OpenCode 1.19.3 (`tests/fixtures/opencode_server.py`).

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
    let detail: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":"oc", "name":"OpenCode", "cwd":cwd.to_string_lossy(), "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
    std::fs::create_dir_all(dir.join("data/opencode/oc")).unwrap();
    // Fork still reads 1.19.3's messages until its slice (T-32, Lead 4983): the stand-in sends those, to the new Agent's too.
    std::fs::write(dir.join("data/opencode/v1Messages"), "1").unwrap();
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

/// How many times an OpenCode was started for `agent`.
fn starts(data: &Path, agent: &str) -> usize {
    std::fs::read_to_string(data.join("opencode").join(agent).join("starts.jsonl")).unwrap_or_default().lines().count()
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

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_fork_through_a_turn_is_a_new_agent_in_the_same_folder_and_the_source_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, cwd, [first, second, third]) = three(&root).await;
    let source = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    let preview = ws.opencode_fork_preview("oc", &second).await.unwrap();
    assert_eq!((&preview["keptTurns"], &preview["laterTurns"], &preview["messages"]), (&json!(2), &json!(1), &json!(4)), "{preview}");
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "Forked")).await.unwrap();
    assert_eq!(outcome["state"], "completed", "{outcome}");
    let target = outcome["agent"]["id"].as_str().unwrap().to_owned();
    // Asked once, up to the third Turn's own start; its own events read once.
    let forks = asked(&data, "oc", "POST", "/fork");
    assert_eq!(forks.len(), 1);
    assert_eq!(forks[0]["body"], json!({"messageID": third}));
    assert_eq!(asked(&data, "oc", "POST", "/sync/history").len(), 1);
    // The new Agent: the same folder, a session of its own, the two Turns under the copies' IDs.
    let d = ws.store.detail(&target).unwrap();
    assert_eq!((d.agent.cwd.as_str(), d.agent.name.as_str(), d.agent.harness.as_str()), (cwd.to_str().unwrap(), "Forked", "opencode"));
    let session = d.agent.opencode_session_id.clone().unwrap();
    assert_ne!(session, source);
    let ids: Vec<String> = d.turns.iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids.len(), 2);
    assert!(!ids.contains(&first) && !ids.contains(&second), "{ids:?}");
    let texts: Vec<&str> = d.turns.iter().flat_map(|t| t["items"].as_array().unwrap()).filter_map(|i| i["text"].as_str()).collect();
    assert_eq!(texts, ["done", "done"]);
    for turn in &d.turns {
        for item in turn["items"].as_array().unwrap() {
            if let Some(native) = item["nativeMessageId"].as_str() {
                assert!(native == turn["id"] || turn["_opencodeAnswers"].get(native).is_some(), "{item} of {turn}");
            }
        }
    }
    // OpenCode holds the copy in the new Agent's own database, under those IDs.
    let held: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode").join(&target).join("state.json")).unwrap()).unwrap();
    assert!(held["sessions"].get(&session).is_some());
    assert!(ids.iter().all(|id| held["messages"][&session].get(id).is_some()), "{}", held["messages"]);
    // Started once, replayed once, attached to that same process; no empty session made there first.
    assert_eq!(starts(&data, &target), 1);
    assert_eq!(asked(&data, &target, "POST", "/sync/replay").len(), 1);
    assert_eq!(asked(&data, &target, "POST", "/api/session").iter().filter(|c| c["path"] == "/api/session").count(), 0);
    assert_eq!(asked(&data, &target, "GET", "/api/event").len(), 1);
    assert_eq!(ws.listed(&target).await.unwrap().connection_state, "connected");
    // The source as it was; the new Agent goes on by itself.
    assert_eq!(ws.store.turn_ids("oc").unwrap(), vec![first, second.clone(), third]);
    turn_on(&ws, &data, &target, "next", json!({})).await;
    assert_eq!(ws.store.turn_ids(&target).unwrap().len(), 3);
    // Read without a write: that fork, done, by its Turn; another request for the Turn is that one.
    let seen = ws.opencode_fork_seen("oc", Which { request_id: None, turn_id: Some(second.clone()) }).await.unwrap();
    assert_eq!((&seen["state"], &seen["agent"]["id"]), (&json!("completed"), &json!(target)), "{seen}");
    let other = uuid::Uuid::new_v4().to_string();
    assert_eq!(ws.opencode_fork("oc", request(&other, &second, "Forked")).await.unwrap()["agent"]["id"], json!(target));
    assert_eq!(asked(&data, "oc", "POST", "/fork").len(), 1);
    // Its Agent deleted, the Turn can be forked anew.
    ws.delete_agent(&target).await.unwrap();
    let anew = ws.opencode_fork("oc", request(&other, &second, "Forked")).await.unwrap();
    assert_eq!(anew["state"], "completed", "{anew}");
    assert_eq!(asked(&data, "oc", "POST", "/fork").len(), 2);
    assert_eq!(ws.store.opencode_fork_row(&key).unwrap().unwrap().state, "released");
    ws.close_agent(anew["agent"]["id"].as_str().unwrap()).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_fork_whose_answer_never_came_is_uncertain_never_asked_again_and_holds_the_source_back_not_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, ..]) = three(&root).await;
    control(&data, "oc", "mode", json!({"fork": "lost"})).await;
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &first, "F")).await.unwrap();
    assert_eq!(outcome["state"], "uncertain", "{outcome}");
    // Read again without a write, by its request or by its Turn: the same attempt, nothing asked.
    let by = |request: Option<&str>, turn: Option<&str>| Which { request_id: request.map(Into::into), turn_id: turn.map(Into::into) };
    let seen = ws.opencode_fork_seen("oc", by(Some(&key), None)).await.unwrap();
    assert_eq!((&seen["state"], &seen["requestId"]), (&json!("uncertain"), &json!(key)), "{seen}");
    let seen = ws.opencode_fork_seen("oc", by(None, Some(&first))).await.unwrap();
    assert_eq!((&seen["state"], &seen["requestId"]), (&json!("uncertain"), &json!(key)), "{seen}");
    assert_eq!(ws.opencode_fork_seen("oc", by(None, Some("msg_other"))).await.unwrap()["state"], "none");
    assert_eq!(asked(&data, "oc", "POST", "/fork").len(), 1);
    // The source goes on.
    turn_on(&ws, &data, "oc", "after", json!({})).await;
    // The same request, and another for the same Turn: that attempt as it stands, never asked again.
    control(&data, "oc", "mode", json!({"fork": "ok"})).await;
    assert_eq!(ws.opencode_fork("oc", request(&key, &first, "F")).await.unwrap()["state"], "uncertain");
    let other = uuid::Uuid::new_v4().to_string();
    assert_eq!(ws.opencode_fork("oc", request(&other, &first, "F")).await.unwrap()["state"], "uncertain");
    assert_eq!(asked(&data, "oc", "POST", "/fork").len(), 1, "never asked again");
    // Nothing gives it up (Lead 4195): a request that asks to is refused as it is read.
    let refused = serde_json::from_value::<Request>(json!({"requestId": other, "turnId": first, "name": "F", "abandonUnconfirmed": true}));
    assert!(refused.err().map(|e| e.to_string()).unwrap_or_default().contains("abandonUnconfirmed"), "refused as it is read");
    assert_eq!(ws.store.opencode_fork_row(&key).unwrap().unwrap().state, "uncertain");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_fork_that_is_not_opencodes_exact_copy_registers_nothing_and_starts_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [_, second, _]) = three(&root).await;
    // OpenCode keeps an old parent it did not map (`session.ts` fork): a reference out of the fork.
    control(&data, "oc", "mode", json!({"fork": "unmapped"})).await;
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "F")).await.unwrap();
    assert_eq!(outcome["state"], "failed", "{outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("不是原消息"), "{outcome}");
    let row = ws.store.opencode_fork_row(&key).unwrap().unwrap();
    // Its folder reserved for it before anything was asked (Lead 3529), and no OpenCode started there.
    assert!(data.join("opencode").join(&row.target_agent_id).join("fork.json").is_file());
    assert_eq!(starts(&data, &row.target_agent_id), 0, "nothing started for it");
    assert!(ws.listed(&row.target_agent_id).await.is_err(), "nothing registered");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_event_history_past_its_limit_is_refused_and_read_again_on_the_same_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, ..]) = three(&root).await;
    // Another session's event, larger than what is read at most.
    control(&data, "oc", "mode", json!({"history": {"noise": crate::opencode::HISTORY_BYTES + 1}})).await;
    let key = uuid::Uuid::new_v4().to_string();
    let refused = ws.opencode_fork("oc", request(&key, &first, "F")).await.unwrap_err().to_string();
    assert!(refused.contains("larger than"), "{refused}");
    let row = ws.store.opencode_fork_row(&key).unwrap().unwrap();
    assert_eq!(row.state, "verified");
    // Its folder reserved for it before anything was asked (Lead 3529), and no OpenCode started there.
    assert!(data.join("opencode").join(&row.target_agent_id).join("fork.json").is_file());
    assert_eq!(starts(&data, &row.target_agent_id), 0, "nothing started for it");
    control(&data, "oc", "mode", json!({"history": "ok"})).await;
    let outcome = ws.opencode_fork("oc", request(&key, &first, "F")).await.unwrap();
    assert_eq!(outcome["state"], "completed", "{outcome}");
    assert_eq!(asked(&data, "oc", "POST", "/fork").len(), 1, "never forked again");
    let target = outcome["agent"]["id"].as_str().unwrap().to_owned();
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_replay_that_stops_part_way_is_replayed_again_into_the_same_agent_and_one_that_differs_registers_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, second, _]) = three(&root).await;
    let planned = data.join("opencode/fixture-new.json");
    std::fs::write(&planned, json!({"replay": {"failAfter": 2}}).to_string()).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let refused = ws.opencode_fork("oc", request(&key, &second, "F")).await.unwrap_err().to_string();
    assert!(refused.contains("还没有完整的 fork"), "{refused}");
    let row = ws.store.opencode_fork_row(&key).unwrap().unwrap();
    assert_eq!(row.state, "chained");
    assert!(ws.listed(&row.target_agent_id).await.is_err(), "nothing registered");
    std::fs::remove_file(&planned).unwrap();
    let outcome = ws.opencode_fork("oc", request(&key, &second, "F")).await.unwrap();
    assert_eq!(outcome["state"], "completed", "{outcome}");
    assert_eq!(outcome["agent"]["id"], row.target_agent_id.as_str(), "the same Agent");
    // Started once per attempt, the same events replayed again, each stored once.
    assert_eq!(starts(&data, &row.target_agent_id), 2);
    let replays = asked(&data, &row.target_agent_id, "POST", "/sync/replay");
    assert_eq!(replays.len(), 2);
    assert_eq!(replays[0]["body"], replays[1]["body"]);
    let held: Value = serde_json::from_str(&std::fs::read_to_string(data.join("opencode").join(&row.target_agent_id).join("state.json")).unwrap()).unwrap();
    assert_eq!(held["durable"].as_array().unwrap().len(), replays[0]["body"]["events"].as_array().unwrap().len());
    assert_eq!(asked(&data, "oc", "POST", "/fork").len(), 1, "never forked again");
    ws.close_agent(&row.target_agent_id).await.unwrap();

    // A replay that makes something else than the fork: refused, nothing registered.
    std::fs::write(&planned, json!({"replay": "tamper"}).to_string()).unwrap();
    let other = uuid::Uuid::new_v4().to_string();
    let refused = ws.opencode_fork("oc", request(&other, &first, "G")).await.unwrap_err().to_string();
    assert!(refused.contains("与 fork 不同"), "{refused}");
    let row = ws.store.opencode_fork_row(&other).unwrap().unwrap();
    assert_eq!(row.state, "chained");
    assert!(ws.listed(&row.target_agent_id).await.is_err(), "nothing registered");
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_fork_whose_client_goes_away_still_ends_and_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, ..]) = three(&root).await;
    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    control(&data, "oc", "mode", json!({"fork": "hold"})).await;
    let key = uuid::Uuid::new_v4().to_string();
    let call = {
        let (ws, key, first) = (ws.clone(), key.clone(), first.clone());
        tokio::spawn(async move { ws.opencode_fork("oc", request(&key, &first, "F")).await })
    };
    for _ in 0..400 {
        if !asked(&data, "oc", "POST", "/fork").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(asked(&data, "oc", "POST", "/fork").len(), 1, "asked");
    // Its client goes away, which drops the request's handler; then OpenCode answers.
    call.abort();
    let _ = call.await;
    control(&data, "oc", "goOn", json!({"sessionID": session})).await;
    let mut state = String::new();
    for _ in 0..800 {
        state = ws.store.opencode_fork_row(&key).unwrap().unwrap().state;
        if state == "completed" || state == "failed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(state, "completed", "settled and registered though its client went away");
    let target = ws.store.opencode_fork_row(&key).unwrap().unwrap().target_agent_id;
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_forks_old_sub_agents_are_history_only_and_never_the_new_agents() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = lab(&root, &cwd).await;
    let data = root.join("data");
    let source = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    let child = control(&data, "oc", "child", json!({"parentID": source, "title": "helper"})).await["id"].as_str().unwrap().to_owned();
    // An answer whose `task` part names that sub-agent, as OpenCode's task tool's does.
    let task = json!({"type":"tool","tool":"task","callID":"call_task","state":{"status":"completed","input":{},"output":"ok",
        "metadata":{"sessionId":child,"parentSessionId":source},"title":"helper","time":{"start":1,"end":2}}});
    let first = turn_on(&ws, &data, "oc", "first", json!({"parts":[task]})).await;
    assert!(ws.opencodes.lock().unwrap().get("oc").unwrap().known_children().contains(&child));
    let key = uuid::Uuid::new_v4().to_string();
    let outcome = ws.opencode_fork("oc", request(&key, &first, "F")).await.unwrap();
    assert_eq!(outcome["state"], "completed", "{outcome}");
    let target = outcome["agent"]["id"].as_str().unwrap().to_owned();
    // The history request left the source's own sessions out.
    let history = &asked(&data, "oc", "POST", "/sync/history")[0]["body"];
    assert!(history.get(&source).is_some() && history.get(&child).is_some(), "{history}");
    // The new Agent follows no sub-agent: the old one is only named in its history.
    assert!(ws.opencodes.lock().unwrap().get(&target).unwrap().known_children().is_empty());
    control(&data, "oc", "ask", json!({"sessionID": child})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(ws.store.detail(&target).unwrap().pending.is_empty(), "the old sub-agent's request is not the new Agent's");
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_target_database_holding_anything_but_this_forks_own_events_is_never_claimed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, ..]) = three(&root).await;
    let planned = data.join("opencode/fixture-new.json");
    std::fs::write(&planned, json!({"replay": {"failAfter": 2}}).to_string()).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    assert!(ws.opencode_fork("oc", request(&key, &first, "F")).await.is_err());
    std::fs::remove_file(&planned).unwrap();
    let row = ws.store.opencode_fork_row(&key).unwrap().unwrap();
    assert_eq!(row.state, "chained");
    // Something else is in its database now: another session's event.
    let state = data.join("opencode").join(&row.target_agent_id).join("state.json");
    let mut held: Value = serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
    held["durable"].as_array_mut().unwrap().push(json!({"id":"evt_foreign","aggregate_id":"ses_foreign","seq":0,
        "type":"session.created.1","data":{"sessionID":"ses_foreign","info":{"id":"ses_foreign"}}}));
    std::fs::write(&state, held.to_string()).unwrap();
    let outcome = ws.opencode_fork("oc", request(&key, &first, "F")).await.unwrap();
    assert_eq!(outcome["state"], "failed", "{outcome}");
    assert!(outcome["message"].as_str().unwrap().contains("不是这次 fork 的记录"), "{outcome}");
    assert_eq!(asked(&data, &row.target_agent_id, "POST", "/sync/replay").len(), 1, "nothing replayed over it");
    assert!(ws.listed(&row.target_agent_id).await.is_err(), "nothing registered");
    ws.close_agent("oc").await.unwrap();
}

#[test]
fn a_turn_is_carried_only_as_far_as_every_field_of_it_is_known() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let images = || Images { root: root.clone(), from: "src".into(), to: "dst".into(), files: Vec::new() };
    let ids: check::Ids = [("msg_1", "msg_7"), ("msg_2", "msg_8"), ("prt_msg_2", "prt_msg_8")]
        .into_iter().map(|(a, b)| (a.to_owned(), b.to_owned())).collect();
    let mut kept = turn("msg_1", &["msg_2"]);
    kept["items"] = json!([
        {"id":"msg_1:input","type":"userMessage","nativeMessageId":"msg_1","clientId":"c-1","content":[{"type":"text","text":"Start"}],
         "_yuzunoTime":{"at":1,"source":"core"}},
        {"id":"prt_msg_2","type":"agentMessage","nativeMessageId":"msg_2","text":"done"},
    ]);
    kept["interruptRequested"] = json!(true);
    let copy = remap(&[kept.clone()], &ids, "ses_b", &mut images()).unwrap();
    assert_eq!(copy[0]["id"], "msg_7");
    assert_eq!(copy[0]["_opencodeAnswers"], json!({"msg_8":{"completed":3,"parent":"msg_7"}}));
    assert_eq!(copy[0]["items"][0]["id"], "msg_7:input");
    assert!(copy[0]["items"][0].get("clientId").is_none(), "the source's sender is not the new Agent's");
    assert_eq!((&copy[0]["items"][1]["id"], &copy[0]["items"][1]["nativeMessageId"]), (&json!("prt_msg_8"), &json!("msg_8")));
    assert!(copy[0].get("interruptRequested").is_none(), "the source's own run is left behind");
    // What a read adds for clients, or anything else not known, refuses the fork.
    for (at, name) in [("turn", "_yuzunoResults"), ("item", "_yuzunoMailbox"), ("item", "_yuzunoTruncated")] {
        let mut odd = kept.clone();
        match at {
            "turn" => odd[name] = json!([]),
            _ => odd["items"][0][name] = json!({}),
        }
        let refused = remap(&[odd], &ids, "ses_b", &mut images()).unwrap_err().to_string();
        assert!(refused.contains(name) && refused.contains("还不能带过去"), "{refused}");
    }
    // A pasted image: the new Agent's own copy, beside its thumbnail and fitted copy.
    let hash = "a".repeat(64);
    let source = root.join("input-images/src");
    std::fs::create_dir_all(&source).unwrap();
    for name in [format!("{hash}.png"), format!("{hash}.thumb.png"), format!("{hash}.claude.png"), "other.png".into()] {
        std::fs::write(source.join(name), b"png").unwrap();
    }
    let mut pasted = kept.clone();
    pasted["items"][0]["content"] = json!([{"type":"text","text":"See"},{"type":"localImage","path":source.join(format!("{hash}.png"))}]);
    let mut moved = images();
    let copy = remap(&[pasted.clone()], &ids, "ses_b", &mut moved).unwrap();
    assert_eq!(copy[0]["items"][0]["content"][1]["path"], json!(root.join(format!("input-images/dst/{hash}.png"))));
    moved.copy().unwrap();
    let mut copied: Vec<String> = std::fs::read_dir(root.join("input-images/dst")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    copied.sort();
    assert_eq!(copied, [format!("{hash}.claude.png"), format!("{hash}.png"), format!("{hash}.thumb.png")]);
    // One that is not the source's own is never carried.
    pasted["items"][0]["content"][1]["path"] = json!(root.join(format!("input-images/else/{hash}.png")));
    assert!(remap(&[pasted], &ids, "ses_b", &mut images()).unwrap_err().to_string().contains("不是原 Agent 保存的"));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_fork_answered_after_its_watch_settles_that_attempt_and_the_same_request_goes_on_from_what_was_fixed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (ws, data, _, [first, ..]) = three(&root).await;
    let session = ws.opencodes.lock().unwrap().get("oc").cloned().unwrap().session;
    control(&data, "oc", "mode", json!({"fork": "hold"})).await;
    let key = uuid::Uuid::new_v4().to_string();
    // No answer within the watch: uncertain, and the source goes on meanwhile.
    let outcome = ws.opencode_fork("oc", request(&key, &first, "F")).await.unwrap();
    assert_eq!(outcome["state"], "uncertain", "{outcome}");
    turn_on(&ws, &data, "oc", "meanwhile", json!({})).await;
    // Its answer comes now: it settles that very attempt.
    control(&data, "oc", "goOn", json!({"sessionID": session})).await;
    let mut state = String::new();
    for _ in 0..400 {
        state = ws.store.opencode_fork_row(&key).unwrap().unwrap().state;
        if state != "uncertain" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(state, "forked", "settled by its late answer");
    // The same request goes on from there, against what was fixed before the source went on.
    let done = ws.opencode_fork("oc", request(&key, &first, "F")).await.unwrap();
    assert_eq!(done["state"], "completed", "{done}");
    assert_eq!(asked(&data, "oc", "POST", "/fork").len(), 1, "asked once");
    let target = done["agent"]["id"].as_str().unwrap().to_owned();
    assert_eq!(ws.store.turn_ids(&target).unwrap().len(), 1, "only the Turn it was asked through");
    ws.close_agent(&target).await.unwrap();
    ws.close_agent("oc").await.unwrap();
}

/// On a session whose messages are 2.x's, compaction, rewind and fork still
/// read 1.19.3's: each refuses, before doing anything, until its own slice
/// moves it (T-32 slice 3b, Lead 4983 decision A). The stand-in sends 2.x's
/// messages here, as it does by default.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn compaction_rewind_and_fork_refuse_a_session_of_2x_messages() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let (root, cwd) = (dir.path().canonicalize().unwrap(), dir.path().canonicalize().unwrap().join("work"));
    std::fs::create_dir_all(&cwd).unwrap();
    let ws = Workspace::new(root.join("data"), root.to_string_lossy().into(), "unused".into()).unwrap();
    let detail: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":"oc", "name":"OpenCode", "cwd":cwd.to_string_lossy(), "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
    std::fs::create_dir_all(root.join("data/opencode/oc")).unwrap();
    ws.reconnect("oc").await.unwrap();
    let data = root.join("data");
    let turn = turn_on(&ws, &data, "oc", "hello", json!({})).await;
    let not_yet = crate::opencode_v2::NOT_YET;
    let compact = ws.opencode_compact("oc").await.unwrap_err().to_string();
    assert!(compact.contains(not_yet) && compact.contains("没有执行 /compact"), "compaction refuses: {compact}");
    let rewind = ws.opencode_revert_preview("oc", &turn).await.unwrap_err().to_string();
    assert!(rewind.contains(not_yet) && rewind.contains("没有预览回退"), "rewind refuses: {rewind}");
    let fork = ws.opencode_fork("oc", request("fork-2x", &turn, "F")).await.unwrap_err().to_string();
    assert!(fork.contains(not_yet) && fork.contains("没有 fork"), "fork refuses: {fork}");
    assert!(asked(&data, "oc", "POST", "/summarize").is_empty() && asked(&data, "oc", "POST", "/revert").is_empty()
        && asked(&data, "oc", "POST", "/fork").is_empty(), "nothing was asked of OpenCode");
    ws.close_agent("oc").await.unwrap();
}
