//! YN-112: the user renames an Agent, and every way of making one checks a
//! name by the same rule (`model::agent_name`).
use super::*;
use crate::model::{agent_name, AgentDetail, AGENT_NAME_MAX};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use tower::ServiceExt;

/// What Core says of a name the rule refuses, on every path.
const REFUSED: &str = "请填写名称（最多 100 字节，不含控制字符）";

fn lab() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/synthetic/work".into(), "unused-codex".into()).unwrap();
    (dir, ws)
}

fn agent(ws: &Workspace, id: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
        "cwd":"/synthetic/work","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
}

fn renames(ws: &Workspace, id: &str) -> Vec<Value> {
    let db = ws.store.db.read().unwrap();
    let mut query = db.prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind='agent/renamed' ORDER BY seq").unwrap();
    query.query_map([id], |r| r.get::<_, String>(0)).unwrap().map(|row| serde_json::from_str(&row.unwrap()).unwrap()).collect()
}

/// The `agent.changed` announcements of `id` waiting in `events`.
fn announced(events: &mut crate::events::Subscription, id: &str) -> usize {
    std::iter::from_fn(|| events.try_next())
        .filter_map(|entry| serde_json::from_str::<Value>(&entry.data).ok())
        .filter(|event| event["type"] == "agent.changed" && event["agentId"] == id)
        .count()
}

/// One request as the page on Core's own port makes it.
async fn local(app: &axum::Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let builder = Request::builder().method(method).uri(uri).header("host", "127.0.0.1:4317")
        .header("x-yuzuno-client", "desktop").header("content-type", "application/json");
    send(app, builder, body).await
}

async fn send(app: &axum::Router, builder: axum::http::request::Builder, body: Option<Value>) -> (StatusCode, Value) {
    let request = builder.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 22).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())))
}

#[test]
fn the_name_rule_trims_and_refuses_an_empty_long_or_control_name() {
    assert_eq!(agent_name("  Mori · 前端  ").unwrap(), "Mori · 前端");
    assert_eq!(agent_name("a  b").unwrap(), "a  b", "spaces inside are kept");
    // 33 Chinese characters and one letter: exactly 100 bytes, also with
    // whitespace around it, which is not counted.
    let full = format!("{}a", "汉".repeat(33));
    assert_eq!(full.len(), AGENT_NAME_MAX);
    assert_eq!(agent_name(&format!("  {full}\t ")).unwrap(), full);
    for refused in ["", "   ", "\t", &format!("{full}b"), "a\tb", "a\nb", "a\u{1b}b", "a\u{7f}b", "a\u{85}b"] {
        assert_eq!(agent_name(refused).unwrap_err().to_string(), REFUSED, "{refused:?}");
    }
}

/// Each of the eight ways Core makes an Agent refuses a name the rule
/// refuses, with the rule's own words: before YN-112 none of them checked
/// control characters, so each of these got past its name check.
#[tokio::test]
async fn every_way_of_making_an_agent_refuses_a_name_the_rule_refuses() {
    let (_dir, ws) = lab();
    let bad = "Mori\tfront";
    let request = uuid::Uuid::new_v4().to_string();
    let settings = crate::model::AgentSettings::default;
    let said = |result: Result<String>| result.expect_err("refused").to_string();
    let ways = [
        ("Codex", said(ws.create_on_with(bad.into(), String::new(), "/synthetic/work".into(), "m".into(), None, None, settings(), None)
            .await.map(|a| a.id))),
        ("Claude Code", said(ws.claude_create_on_with(bad.into(), String::new(), "/synthetic/work".into(), "m".into(), None, None, settings(), None)
            .await.map(|a| a.id))),
        ("OpenCode", said(ws.opencode_create_on(bad.into(), "/synthetic/work".into(), "m".into(), None, None, None).await.map(|a| a.id))),
        ("Codex import", said(ws.import_codex_session_outcome(serde_json::from_value(
            json!({"threadId":"thread","name":bad,"permissionPreset":"ask"})).unwrap()).await.map(|(a, _)| a.id))),
        ("Codex fork", said(ws.fork_codex_session("source", serde_json::from_value(
            json!({"requestId":request,"throughTurnId":"turn","name":bad})).unwrap()).await.map(|_| String::new()))),
        ("Claude Code import", said(ws.claude_session_import(serde_json::from_value(
            json!({"sessionId":"session","name":bad,"projectId":null,"cwd":"/synthetic/work"})).unwrap()).await.map(|i| i.agent.id))),
        ("OpenCode fork", said(ws.opencode_fork("source", serde_json::from_value(
            json!({"requestId":request,"turnId":"turn","name":bad})).unwrap()).await.map(|v| v.to_string()))),
        ("OpenCode import", said(ws.opencode_import_create(serde_json::from_value(
            json!({"requestId":request,"name":bad,"cwd":"/synthetic/work"})).unwrap()).await.map(|v| v.to_string()))),
    ];
    for (way, error) in ways {
        assert_eq!(error, REFUSED, "{way}");
    }
    assert!(ws.store.agents().unwrap().is_empty(), "nothing was made");
    // Whitespace around a name no longer counts towards its length: a full
    // name with spaces around it passes the name check and fails only where
    // the folder is checked.
    let padded = format!("  {}a  ", "汉".repeat(33));
    let error = ws.create_on_with(padded, String::new(), "/synthetic/missing".into(), "m".into(), None, None, settings(), None)
        .await.unwrap_err().to_string();
    assert_ne!(error, REFUSED);
}

/// A rename keeps the Agent's ID, trims the name, writes one journal row of
/// `agent/renamed` and tells every open page; an unchanged name writes and
/// announces nothing; a refused name or body changes nothing; a closed
/// Agent is renamed too; the phone entry renames as Core's own port does.
#[tokio::test]
async fn a_rename_keeps_the_id_writes_one_row_and_tells_every_page() {
    let (dir, ws) = lab();
    agent(&ws, "a");
    let app = crate::server::router(ws.clone(), dir.path().join("assets"));
    let mut events = ws.changes.subscribe(None);

    let (status, renamed) = local(&app, "PATCH", "/api/agents/a", Some(json!({"name":"  Mori · 前端  "}))).await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!((renamed["id"].clone(), renamed["name"].clone()), (json!("a"), json!("Mori · 前端")));
    assert_eq!(renames(&ws, "a"), [json!({"name":"Mori · 前端"})]);
    assert_eq!(announced(&mut events, "a"), 1, "open pages read the list again");
    let (_, listed) = local(&app, "GET", "/api/workspace", None).await;
    assert_eq!(listed["agents"][0]["name"], "Mori · 前端");

    // The same name, however it is spaced: nothing written or announced.
    let (status, same) = local(&app, "PATCH", "/api/agents/a", Some(json!({"name":"Mori · 前端 "}))).await;
    assert_eq!((status, same["name"].clone()), (StatusCode::OK, json!("Mori · 前端")));
    assert_eq!(renames(&ws, "a").len(), 1);
    assert_eq!(announced(&mut events, "a"), 0);

    // Refused: the rule's words, and nothing changes.
    for name in ["", "  ", "a\tb", &format!("{}ab", "汉".repeat(33))] {
        let (status, refused) = local(&app, "PATCH", "/api/agents/a", Some(json!({"name":name}))).await;
        assert_eq!((status, refused["error"].clone()), (StatusCode::BAD_REQUEST, json!(REFUSED)), "{name:?}");
    }
    // Only a name: another field is refused before anything is read.
    let (status, _) = local(&app, "PATCH", "/api/agents/a", Some(json!({"name":"Other","id":"b"}))).await;
    assert!(status.is_client_error() && status != StatusCode::NOT_FOUND, "{status}");
    let (status, _) = local(&app, "PATCH", "/api/agents/a", Some(json!({}))).await;
    assert!(status.is_client_error() && status != StatusCode::NOT_FOUND, "{status}");
    // No such Agent: refused, and none is made.
    let (status, _) = local(&app, "PATCH", "/api/agents/nobody", Some(json!({"name":"Ghost"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(ws.store.agents().unwrap().len(), 1);
    assert_eq!(renames(&ws, "a").len(), 1);
    assert_eq!(ws.store.agent("a").unwrap().name, "Mori · 前端");
    assert_eq!(announced(&mut events, "a"), 0);

    // A closed Agent keeps its place in the list, and can be renamed.
    ws.store.update("a", "agent/closed", &json!({}), |d| d.agent.closed_at = Some("then".into())).unwrap();
    let (status, closed) = local(&app, "PATCH", "/api/agents/a", Some(json!({"name":"Mori (old)"}))).await;
    assert_eq!((status, closed["name"].clone()), (StatusCode::OK, json!("Mori (old)")));

    // The phone entry serves the same route (the user's rule: a phone
    // changes every setting), with its own checks.
    let origin = "https://core.example-tailnet.ts.net:8444";
    let phone = crate::server::remote_router(ws.clone(), dir.path().join("assets"), None,
        crate::server::RemoteEntry::new(origin, "person@example.com").unwrap());
    let builder = Request::builder().method("PATCH").uri("/api/agents/a").header("host", "core.example-tailnet.ts.net:8444")
        .header("origin", origin).header("tailscale-user-login", "person@example.com")
        .header("x-yuzuno-client", "desktop").header("content-type", "application/json");
    let (status, answer) = send(&phone, builder, Some(json!({"name":"Mori on the phone"}))).await;
    assert_eq!((status, answer["name"].clone()), (StatusCode::OK, json!("Mori on the phone")), "{answer}");
    assert_eq!(renames(&ws, "a").len(), 3);
}

/// Tasks, mail and Home name an Agent by its ID, so a rename breaks none of
/// them. What reads the Agent now shows the new name (peers_list, Home's
/// live Jobs); a record of who it was then (mail it sent, a task's
/// assignee as assigned) keeps the name it had, and what is written after
/// the rename has the new one.
#[tokio::test]
async fn links_by_id_survive_a_rename_and_old_records_keep_the_name_they_had() {
    let (dir, ws) = lab();
    agent(&ws, "lead");
    agent(&ws, "worker");
    let project = ws.store.create_project("Lab", std::collections::BTreeMap::from([("local".into(), "/synthetic/project".into())]))
        .unwrap().id;
    ws.store.set_agent_project("worker", Some(&project)).unwrap();
    let store = &ws.store;
    let task = store.collaboration_call(None, "task_create",
        json!({"requestId":"task","title":"Train","assigneeAgentId":"worker","projectId":project})).unwrap();
    let task_id = task["task"]["id"].as_str().unwrap().to_owned();
    store.collaboration_call(Some("worker"), "peer_send", json!({"requestId":"before","toAgentId":"lead","body":"Started"})).unwrap();
    // A live Job of the worker's, filed under that task, with the name it had.
    let internal: String = store.db.read().unwrap().query_row("SELECT id FROM collaboration_tasks", [], |r| r.get(0)).unwrap();
    store.db.write().unwrap().execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('job-1',?1,'worker','queued',?2)",
        rusqlite::params![internal, json!({"name":"train","agent":{"name":"Agent worker"}}).to_string()]).unwrap();

    let app = crate::server::router(ws.clone(), dir.path().join("assets"));
    let (status, _) = local(&app, "PATCH", "/api/agents/worker", Some(json!({"name":"Trainer"}))).await;
    assert_eq!(status, StatusCode::OK);

    let peers = store.collaboration_call(Some("lead"), "peers_list", json!({})).unwrap();
    let worker = peers["peers"].as_array().unwrap().iter().find(|p| p["id"] == "worker").unwrap();
    assert_eq!(worker["name"], "Trainer");
    let (_, home) = local(&app, "GET", "/api/home", None).await;
    let jobs: Vec<Value> = home["projects"].as_array().unwrap().iter().flat_map(|p| p["jobs"].as_array().unwrap().clone()).collect();
    assert_eq!((jobs[0]["agentId"].clone(), jobs[0]["agentName"].clone()), (json!("worker"), json!("Trainer")));

    // The task still names the same Agent, by its ID.
    let held = crate::collaboration_store::load_task(&store.db.read().unwrap(), &internal).unwrap();
    assert_eq!(held.assignee_agent_id.as_deref(), Some("worker"));
    store.collaboration_call(Some("lead"), "task_get", json!({"taskId":task_id})).unwrap();
    // Mail still reaches it by its ID; what it sent before keeps its old
    // name, what it sends now has the new one.
    store.collaboration_call(Some("lead"), "peer_send", json!({"requestId":"after","toAgentId":"worker","body":"Thanks"})).unwrap();
    let inbox = store.collaboration_call(Some("worker"), "peer_read", json!({})).unwrap();
    assert_eq!(inbox["messages"][0]["body"], "Thanks");
    store.collaboration_call(Some("worker"), "peer_send", json!({"requestId":"later","toAgentId":"lead","body":"Done"})).unwrap();
    let senders: Vec<(Value, Value)> = store.collaboration_call(Some("lead"), "peer_read", json!({})).unwrap()["messages"]
        .as_array().unwrap().iter().map(|m| (m["sender"]["id"].clone(), m["sender"]["name"].clone())).collect();
    assert_eq!(senders, [(json!("worker"), json!("Agent worker")), (json!("worker"), json!("Trainer"))]);
}
