//! YN-34 S3b3: one real DeepSeek executor through routing, in a lab Core.
//!
//! Ignored by default. It needs:
//! - a real OpenCode (`YUZUNO_OPENCODE_BIN`);
//! - the user-approved lab key file (`YN34_DEEPSEEK_KEY_FILE`, 0600).
//!
//! The lab Core is this test's Workspace, serving Core's own routes on a free
//! loopback port: dispatch, the executor slot pass, mail delivery and the
//! executor's MCP are Core's own.
//!
//! The key is read once, only into the lab's key store. It is compared in
//! memory and never printed. Run it in a lab Job with `XDG_CONFIG_HOME` and
//! `TMPDIR` in a lab folder of its own, so the user's OpenCode configuration
//! is not read and the lab's key store is removed with that folder.
use crate::{
    routing_keys::{Provider, Secret, Store as KeyStore},
    routing_launch::RuntimeProfile,
    workspace::Workspace,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, time::Duration};

async fn until<T>(what: &str, seconds: u64, mut check: impl FnMut() -> Option<T>) -> T {
    for _ in 0..seconds * 10 {
        if let Some(value) = check() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out after {seconds} s waiting for {what}");
}

/// Process `pid`'s environment entries; empty when it cannot be read.
fn environ(pid: u32) -> Vec<Vec<u8>> {
    std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default().split(|b| *b == 0).map(<[u8]>::to_vec).collect()
}

/// Each live process's parent, from /proc.
fn parents() -> BTreeMap<u32, u32> {
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        // After the command's closing parenthesis: state, then the parent's pid.
        let Some(rest) = stat.rsplit_once(')').map(|(_, r)| r) else { continue };
        if let Some(ppid) = rest.split_whitespace().nth(1).and_then(|p| p.parse().ok()) {
            out.insert(pid, ppid);
        }
    }
    out
}

fn descends_from(parents: &BTreeMap<u32, u32>, mut pid: u32, root: u32) -> bool {
    for _ in 0..64 {
        if pid == root {
            return true;
        }
        match parents.get(&pid) {
            Some(&parent) if parent != pid && parent != 0 => pid = parent,
            _ => return false,
        }
    }
    false
}

/// Every file below `dir`, but for the routing keys' own folder.
fn files_outside_secrets(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.file_name().is_some_and(|n| n == crate::routing_keys::DIR) && path.parent() == Some(dir) {
            continue;
        }
        match entry.file_type() {
            Ok(t) if t.is_dir() => files_outside_secrets(&path, out),
            Ok(t) if t.is_file() => out.push(path),
            _ => {}
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a real OpenCode and the lab DeepSeek key: run in a lab Job with YUZUNO_OPENCODE_BIN and YN34_DEEPSEEK_KEY_FILE"]
async fn a_routed_deepseek_executor_does_one_real_turn_and_submits_its_result_with_its_key_in_its_own_process_only() {
    let key_file = std::env::var("YN34_DEEPSEEK_KEY_FILE").expect("YN34_DEEPSEEK_KEY_FILE names the lab key file");
    let key = std::fs::read_to_string(&key_file).expect("the lab key file can be read").trim().to_owned();
    assert!(key.len() >= 16, "the lab key file holds a key");
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), work.display().to_string(), "unused-codex".into()).unwrap();
    KeyStore::of(&ws.data_dir).put_local("deepseek", Provider::Deepseek, Secret::new(key.clone())).unwrap();
    let project = ws.store.create_project("Lab", BTreeMap::from([("local".into(), work.display().to_string())])).unwrap().id;
    ws.store.save_routing_policy(0, json!({"enabled": true, "whenNone": "wait", "candidates": [
        {"id": "c-deepseek", "label": "DeepSeek flash", "enabled": true, "harness": "opencode", "model": "deepseek/deepseek-flash",
         "credential": {"kind": "apiKey", "keyId": "deepseek"}, "conditions": [], "unknown": "skip"}]})).unwrap().unwrap();
    let task = ws.store.collaboration_call(None, "task_create", json!({"requestId": "yn34 e2e task", "title": "Routing check", "projectId": project}))
        .unwrap()["task"]["id"].as_str().unwrap().to_owned();

    // The lab Core serves its own routes on a free loopback port: its MCP, mail delivery and executor slots run.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = crate::server::router_on_port(ws.clone(), dir.path().join("web"), port);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    eprintln!("lab Core on 127.0.0.1:{port}");

    // 1. A general executor's dispatch is routed to DeepSeek on its key.
    let body = "This is a routing check in a lab. Do only this: submit your result for this task with task_submit_result, \
                with the summary \"ok\" and this message's dispatchId; then stop. Do not read files or run commands.";
    ws.executor_dispatch(None, json!({"requestId": "yn34 e2e dispatch", "taskId": task, "expectedVersion": 1, "executor": {}, "body": body}))
        .await.expect("the dispatch");
    let (agent, route): (String, String) = ws.store.db.read().unwrap().query_row(
        "SELECT agent_id, route_json FROM executor_dispatches WHERE request_id='yn34 e2e dispatch'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let route: Value = serde_json::from_str(&route).unwrap();
    eprintln!("route: {route}");
    assert_eq!(route["chosen"], "c-deepseek", "routing chose DeepSeek");
    let detail = ws.store.detail(&agent).unwrap();
    assert_eq!((detail.agent.harness.as_str(), detail.agent.model.as_str()), ("opencode", "deepseek/deepseek-flash"));
    assert_eq!(ws.store.runtime_profile(&agent).unwrap(), Some(RuntimeProfile::ApiKey { key_id: "deepseek".into() }));

    // 2. The slot pass starts it; its own opencode serve holds the key, and nothing else of this Core does.
    until("the executor connected", 180, || (ws.store.detail(&agent).ok()?.agent.connection_state == "connected").then_some(())).await;
    let pid = ws.opencodes.lock().unwrap().get(&agent).and_then(|c| c.server.pid()).expect("its opencode serve's pid");
    let wanted = format!("DEEPSEEK_API_KEY={key}").into_bytes();
    assert!(environ(pid).contains(&wanted), "its own opencode serve holds the key");
    let core = std::process::id();
    let tree = parents();
    let holders: Vec<u32> = tree.keys().copied().filter(|p| descends_from(&tree, *p, core))
        .filter(|p| environ(*p).iter().any(|e| e.windows(key.len()).any(|w| w == key.as_bytes()))).collect();
    assert!(!holders.contains(&core), "Core's own environment does not hold the key");
    let outside: Vec<u32> = holders.iter().copied().filter(|p| !descends_from(&tree, *p, pid)).collect();
    assert!(outside.is_empty(), "only its opencode serve and what that started hold the key; also {outside:?}");
    eprintln!("the key is in {} process(es), all its opencode serve ({pid}) or below it", holders.len());

    // 3. Its first turn, from the assignment's mail: it ends, and the executor's result is on the task.
    let turn = until("the executor's first turn", 120, || ws.store.detail(&agent).ok()?.turns.first().cloned()).await;
    let turn_id = turn["id"].as_str().unwrap().to_owned();
    let ended = until("the first turn's end", 240, || {
        let d = ws.store.detail(&agent).ok()?;
        let t = d.turns.iter().find(|t| t["id"] == turn_id.as_str())?.clone();
        (t["status"] != "inProgress").then_some(t)
    }).await;
    let said: Vec<&str> = ended["items"].as_array().into_iter().flatten()
        .filter(|i| i["type"] == "agentMessage").filter_map(|i| i["text"].as_str()).collect();
    let tools: Vec<String> = ended["items"].as_array().into_iter().flatten()
        .filter(|i| i["type"] != "agentMessage" && i["type"] != "userMessage")
        .map(|i| format!("{}:{}", i["type"].as_str().unwrap_or("?"), i["tool"].as_str().or(i["name"].as_str()).unwrap_or(""))).collect();
    eprintln!("first turn {}: said {said:?}; items {tools:?}", ended["status"]);
    assert_eq!(ended["status"], "completed", "the real turn completed");
    let result = ws.store.collaboration_call(None, "task_get", json!({"taskId": task})).unwrap()["task"]["result"].clone();
    eprintln!("result: {result}");
    assert!(result.is_object(), "the executor submitted its result");
    let turns = ws.store.detail(&agent).unwrap().turns.len();
    eprintln!("turns: {turns}");

    // 4. Its spend counts toward the key's day; the key is in no record of the lab Core.
    let spend = ws.store.spend_on(crate::routing_readings::today()).unwrap();
    eprintln!("spend today: {:.6} USD on deepseek (what OpenCode reported)", spend.by_key.get("deepseek").copied().unwrap_or(0.0));
    ws.close_agent(&agent).await.unwrap();
    let mut files = Vec::new();
    files_outside_secrets(&data, &mut files);
    let found: Vec<String> = files.iter()
        .filter(|p| std::fs::read(p).is_ok_and(|bytes| bytes.windows(key.len()).any(|w| w == key.as_bytes())))
        .map(|p| p.display().to_string()).collect();
    assert!(found.is_empty(), "no file of the lab Core but its key store holds the key: {found:?}");
    eprintln!("{} files of the lab Core read; none holds the key", files.len());
    server.abort();
}
