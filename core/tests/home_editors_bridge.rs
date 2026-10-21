//! T-117: real user HTTP policy -> Core -> real ClaudeBridge Stop hook.
//! Only the SDK stream is scripted; no model, account or daily Core is used.
#![cfg(unix)]
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, time::Duration};
use yuzuno_workspace::{model::AgentDetail, server, workspace::Workspace};

async fn until(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !check() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.expect("fixture checkpoint timed out");
}

fn json_file(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// A running Claude Stop hook still asks Core's real policy, after the user
/// revokes and grants editing; since T-154 the answer is never to hold the
/// Turn for a Brief update, editor or not.
#[tokio::test]
async fn running_claude_stop_asks_real_core_policy_and_is_never_held_for_the_brief() {
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/home_editors_bridge.mjs"));
    let lab = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let ws = Workspace::new(lab.path().join("data"), lab.path().to_string_lossy().into(), "unused".into()).unwrap();
    let project = ws.store.create_project("Editor policy fixture", BTreeMap::new()).unwrap().id;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert_ne!(port, 4317);
    ws.start_collaboration(port);
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{
        "id":"claude-policy","name":"Claude policy fixture","cwd":lab.path(),"model":"sonnet","harness":"claude",
        "color":"sage","status":"offline","threadId":null,"createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store.set_agent_project("claude-policy", Some(&project)).unwrap();
    let app = server::router_on_port(ws.clone(), lab.path().join("no-ui"), port);
    let serving = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    ws.reconnect("claude-policy").await.unwrap();
    let client = reqwest::Client::new();
    let endpoint = format!("http://127.0.0.1:{port}/api/projects/{project}/home-editors");

    for (n, ids) in [(1, json!([])), (2, json!(["claude-policy"]))] {
        let sent = ws.send("claude-policy", format!("fixture turn {n}")).await.unwrap();
        until(|| lab.path().join(format!("ready-{n}")).is_file()).await;
        assert_eq!(ws.store.agent("claude-policy").unwrap().status, "working");
        let response = client.put(&endpoint).header("X-Yuzuno-Client", "desktop")
            .json(&json!({"expectedVersion":n-1,"editorAgentIds":ids})).send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let policy: Value = response.json().await.unwrap();
        assert_eq!(policy["editorAgentIds"], ids);
        std::fs::write(lab.path().join(format!("release-{n}")), "go").unwrap();
        let stopped = lab.path().join(format!("stop-{n}.json"));
        until(|| stopped.is_file()).await;
        let decision = json_file(&stopped);
        assert!(decision["decision"].is_null(), "the Turn ends without a hold: {decision}");
        let replies: Vec<Value> = std::fs::read_to_string(lab.path().join("policy-replies.jsonl")).unwrap()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(replies.len(), n as usize);
        assert_eq!(replies.last().unwrap()["required"], json!(false));
        assert_eq!(replies.last().unwrap()["turnId"], sent["turnId"]);
        // A logged input alone could time out without being consumed by the
        // production bridge. Require its matching acceptance response too.
        let accepted: Vec<Value> = std::fs::read_to_string(lab.path().join("policy-accepted.jsonl")).unwrap()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(accepted.len(), n as usize);
        let reply_id = &replies.last().unwrap()["id"];
        let ack = accepted.iter().find(|row| &row["id"] == reply_id).expect("matching bridge acknowledgment");
        assert_eq!(ack["result"]["accepted"], true);
        until(|| ws.store.agent("claude-policy").unwrap().status != "working").await;
        let home: Value = client.get(format!("http://127.0.0.1:{port}/api/home"))
            .header("X-Yuzuno-Client", "desktop").send().await.unwrap().json().await.unwrap();
        assert_eq!(home["projects"][0]["missing"], json!([]), "no Turn is marked as missing an update");
    }
    ws.close_agent("claude-policy").await.unwrap();
    serving.abort();
}
