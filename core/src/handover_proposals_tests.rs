use super::*;
use crate::model::AgentDetail;
use axum::http::StatusCode;
use std::collections::BTreeMap;
use tower::ServiceExt;

fn agent_detail(id: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work","model":"","harness":"claude",
        "color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

/// A Project with its document at version 1, two leads, a member, an
/// executor of its own and an Agent of no Project.
fn fixture() -> (tempfile::TempDir, Arc<Workspace>, String) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let p = ws.store.create_project("Lab", BTreeMap::new()).unwrap().id;
    for id in ["lead", "lead2", "member", "exec", "outsider"] {
        ws.store.insert(&agent_detail(id)).unwrap();
    }
    for id in ["lead", "lead2", "member", "exec"] {
        ws.store.set_agent_project(id, Some(&p)).unwrap();
    }
    crate::agent_roles::save(&ws.store, &p, 0, vec!["lead".into(), "lead2".into()]).unwrap();
    ws.store.db.write().unwrap().execute("INSERT INTO agent_roles(agent_id, kind, project_id, created_at, updated_at) VALUES('exec','executor',?1,'now','now')", [&p]).unwrap();
    ws.store.save_handover(&p, 0, "# Lab\nBuild with make.", Some("First notes")).unwrap();
    (dir, ws, p)
}

async fn route(ws: &Arc<Workspace>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request.body(body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string()))).unwrap();
    let response = crate::handover::router().with_state(ws.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn propose_input(request: &str, expected: i64, markdown: &str) -> Value {
    json!({"requestId":request,"expectedVersion":expected,"markdown":markdown,"reason":"Say how to test"})
}

fn error_of(result: Result<Value>) -> String {
    result.err().map_or_else(|| "accepted".to_owned(), |e| format!("{e:#}"))
}

/// Home's Needs you, as the browser reads it: only the handover items.
async fn needs_you(ws: &Arc<Workspace>) -> Vec<Value> {
    let request = axum::http::Request::builder().uri("/api/home").body(axum::body::Body::empty()).unwrap();
    let response = crate::project_brief::router().with_state(ws.clone()).oneshot(request).await.unwrap();
    let home: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1 << 22).await.unwrap()).unwrap();
    home["needsYou"].as_array().unwrap().iter().filter(|n| n["kind"] == "handover").cloned().collect()
}

fn mail_to(ws: &Arc<Workspace>, agent: &str) -> Vec<String> {
    let db = ws.store.db.read().unwrap();
    let mut query = db.prepare("SELECT json_extract(data,'$.body') FROM collaboration_messages WHERE recipient_id=?1 ORDER BY rowid").unwrap();
    query.query_map([agent], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

fn state_of(ws: &Arc<Workspace>, id: &str) -> String {
    ws.store.db.read().unwrap().query_row("SELECT state FROM project_handover_proposals WHERE id=?1", [id], |r| r.get(0)).unwrap()
}

/// T-34 S3b: a lead of the Project proposes; nothing is written until the
/// user approves on Home. The proposal waits in Needs you, named by its
/// proposer; one pending per Project; a retry is the same proposal.
#[tokio::test]
async fn a_lead_proposes_a_handover_and_nothing_is_written_until_the_user_approves() {
    let (_dir, ws, p) = fixture();
    let read = ws.collaboration_call(Some("lead"), "handover_get", json!({})).await.unwrap();
    assert_eq!((read["version"].clone(), read["proposal"].clone()), (json!(1), Value::Null), "a lead reads its own Project's handover");
    assert!(error_of(ws.collaboration_call(Some("outsider"), "handover_get", json!({"projectId":p})).await).starts_with("not_member:"),
        "an Agent of another Project doesn't read it");
    for (who, code) in [("member", "not_lead:"), ("exec", "not_lead:"), ("outsider", "not_lead:")] {
        let refused = error_of(ws.collaboration_call(Some(who), "handover_propose",
            json!({"requestId":"r","projectId":p,"expectedVersion":1,"markdown":"# Mine"})).await);
        assert!(refused.starts_with(code), "only a lead of the Project proposes ({who}): {refused}");
    }
    assert!(error_of(ws.collaboration_call(None, "handover_propose", propose_input("u", 1, "# User")).await).starts_with("agent_only:"),
        "the user changes the handover in the Project's settings, not by proposing");
    let stale = error_of(ws.collaboration_call(Some("lead"), "handover_propose", propose_input("old", 0, "# Lab")).await);
    assert!(stale.contains("propose on version 1"), "a proposal on an old version says the current one: {stale}");

    let made = ws.collaboration_call(Some("lead"), "handover_propose", propose_input("first", 1, "# Lab\nBuild with make; test with make check.")).await.unwrap();
    let id = made["proposal"]["id"].as_str().unwrap().to_owned();
    assert_eq!(made["proposal"]["state"], "pending");
    assert_eq!(ws.store.handover(&p, None).unwrap()["version"], 1, "a proposal writes nothing");
    let again = ws.collaboration_call(Some("lead"), "handover_propose", propose_input("first", 1, "# Lab\nBuild with make; test with make check.")).await.unwrap();
    assert_eq!(again["proposal"]["id"], json!(id), "a retry with the same requestId is the same proposal");
    assert!(error_of(ws.collaboration_call(Some("lead"), "handover_propose", propose_input("first", 1, "# Other")).await).starts_with("idempotency_conflict:"));
    let listed = needs_you(&ws).await;
    assert_eq!(listed.len(), 1, "the proposal waits in Needs you: {listed:?}");
    assert_eq!((listed[0]["agentId"].clone(), listed[0]["proposalId"].clone(), listed[0]["title"].clone()),
        (json!("lead"), json!(id), json!("Say how to test")), "named by its proposer");
    let held = error_of(ws.collaboration_call(Some("lead2"), "handover_propose", propose_input("mine", 1, "# Lead 2")).await);
    assert!(held.starts_with("proposal_pending: Agent lead's proposal from "), "another lead's proposal waits, naming who holds it: {held}");

    // The same lead's new proposal replaces its own.
    let newer = ws.collaboration_call(Some("lead"), "handover_propose", propose_input("second", 1, "# Lab\nBuild and test with make.")).await.unwrap();
    let newer_id = newer["proposal"]["id"].as_str().unwrap().to_owned();
    assert_eq!(state_of(&ws, &id), "superseded", "the superseded proposal stays in the table");
    assert_eq!(needs_you(&ws).await.iter().map(|n| n["proposalId"].clone()).collect::<Vec<_>>(), vec![json!(newer_id)]);
    let path = format!("/api/projects/{p}/handover/proposals");
    let (_, old) = route(&ws, "POST", &format!("{path}/{id}/decision"), Some(json!({"requestId":"d0","action":"approve","expectedVersion":1}))).await;
    assert!(old["error"].as_str().is_some_and(|e| e.starts_with("proposal_superseded:")), "a superseded proposal is not decided: {old}");

    // The user approves, against the version read.
    let (_, shown) = route(&ws, "GET", &format!("{path}/{newer_id}"), None).await;
    assert_eq!((shown["base"]["markdown"].clone(), shown["proposal"]["markdown"].clone(), shown["stale"].clone()),
        (json!("# Lab\nBuild with make."), json!("# Lab\nBuild and test with make."), json!(false)), "the card shows both texts");
    let (_, misread) = route(&ws, "POST", &format!("{path}/{newer_id}/decision"),
        Some(json!({"requestId":"d1","action":"approve","expectedVersion":0}))).await;
    assert!(misread["error"].as_str().is_some_and(|e| e.starts_with("version_conflict: this Project's handover changed after you read")),
        "a decision on a document read before it changed is refused: {misread}");
    let decision = json!({"requestId":"d2","action":"approve","expectedVersion":1,"note":"Good, thanks"});
    let (status, approved) = route(&ws, "POST", &format!("{path}/{newer_id}/decision"), Some(decision.clone())).await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    let latest = &approved["handover"]["history"][0];
    assert_eq!((approved["handover"]["version"].clone(), latest["writtenBy"]["id"].clone(), latest["approvedBy"].clone(), latest["reason"].clone()),
        (json!(2), json!("lead"), json!("user"), json!("Say how to test")),
        "an approved proposal is a version written by its proposer and approved by the user");
    assert_eq!(approved["handover"]["markdown"], "# Lab\nBuild and test with make.");
    let mail = mail_to(&ws, "lead");
    assert_eq!(mail.len(), 1, "one mail to the proposer: {mail:?}");
    assert!(mail[0].contains("approved") && mail[0].contains("version 2") && mail[0].contains("Their note: Good, thanks"), "{}", mail[0]);
    assert!(needs_you(&ws).await.is_empty(), "a decided proposal leaves Needs you");
    let (_, retried) = route(&ws, "POST", &format!("{path}/{newer_id}/decision"), Some(decision)).await;
    assert_eq!(retried["proposal"]["state"], "approved", "a retry gets the same answer: {retried}");
    assert_eq!(mail_to(&ws, "lead").len(), 1, "and sends no second mail");
    let (_, twice) = route(&ws, "POST", &format!("{path}/{newer_id}/decision"),
        Some(json!({"requestId":"d3","action":"reject","expectedVersion":2}))).await;
    assert!(twice["error"].as_str().is_some_and(|e| e.starts_with("proposal_decided: this proposal was already approved")), "{twice}");
}

/// T-34 S3b: a proposal made on a version the user has since replaced can't
/// be approved; rejected, its mail tells the lead to propose again on the
/// current version. A note is checked as a reason is; an archived Project
/// takes no proposal; a deleted Project's proposals go with it.
#[tokio::test]
async fn a_stale_proposal_is_refused_and_its_rejection_tells_the_lead_to_propose_again() {
    let (_dir, ws, p) = fixture();
    let made = ws.collaboration_call(Some("lead"), "handover_propose", propose_input("first", 1, "# Lab\nProposed.")).await.unwrap();
    let id = made["proposal"]["id"].as_str().unwrap().to_owned();
    ws.store.save_handover(&p, 1, "# Lab\nSaved by the user meanwhile.", None).unwrap();
    let path = format!("/api/projects/{p}/handover/proposals/{id}");
    let (_, shown) = route(&ws, "GET", &path, None).await;
    assert_eq!((shown["stale"].clone(), shown["currentVersion"].clone()), (json!(true), json!(2)));
    let (_, refused) = route(&ws, "POST", &format!("{path}/decision"), Some(json!({"requestId":"a","action":"approve","expectedVersion":2}))).await;
    assert!(refused["error"].as_str().is_some_and(|e| e.starts_with("version_conflict: the handover changed since this proposal")
        && e.contains("propose again on version 2")), "a stale proposal is not approved: {refused}");
    assert_eq!(ws.store.handover(&p, None).unwrap()["version"], 2, "nothing was written");
    for (note, words) in [("x".repeat(1001), "A note is at most 1000 bytes"), ("Bell \u{7}".to_owned(), "A note is at most 1000 bytes")] {
        let (_, bad) = route(&ws, "POST", &format!("{path}/decision"), Some(json!({"requestId":"n","action":"reject","expectedVersion":2,"note":note}))).await;
        assert!(bad["error"].as_str().is_some_and(|e| e.starts_with(words)), "a note is checked as a reason is: {bad}");
    }
    let (status, rejected) = route(&ws, "POST", &format!("{path}/decision"),
        Some(json!({"requestId":"r","action":"reject","expectedVersion":2,"note":"Merge yours with mine"}))).await;
    assert_eq!((status, rejected["proposal"]["state"].clone()), (StatusCode::OK, json!("rejected")), "{rejected}");
    assert_eq!(ws.store.handover(&p, None).unwrap()["version"], 2, "a rejection writes nothing");
    let mail = mail_to(&ws, "lead");
    assert!(mail.len() == 1 && mail[0].contains("rejected") && mail[0].contains("propose on version 2")
        && mail[0].contains("Their note: Merge yours with mine"), "the rejection tells the lead to propose again: {mail:?}");
    assert!(needs_you(&ws).await.is_empty(), "a rejected proposal leaves Needs you");

    ws.store.update_project(&p, crate::projects::ProjectChange { name: None, default_dirs: BTreeMap::new(), archived: Some(true) }).unwrap();
    let archived = error_of(ws.collaboration_call(Some("lead"), "handover_propose", propose_input("late", 2, "# Late")).await);
    assert!(archived.starts_with("project_archived:"), "an archived Project takes no proposal: {archived}");
    ws.store.update_project(&p, crate::projects::ProjectChange { name: None, default_dirs: BTreeMap::new(), archived: Some(false) }).unwrap();
    for id in ["lead", "lead2", "member", "exec"] {
        ws.store.set_agent_project(id, None).unwrap();
    }
    ws.store.delete_project(&p).unwrap_or_else(|e| panic!("a deleted Project's proposals go with it: {e}"));
    let left: i64 = ws.store.db.read().unwrap().query_row("SELECT COUNT(*) FROM project_handover_proposals", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "a deleted Project's proposals go with it");
}

/// T-34 S3b, through the Agents' own MCP endpoint: the lead proposes, a
/// member is refused, and only the user decides, in the browser.
#[tokio::test]
async fn through_mcp_a_lead_proposes_a_member_is_refused_and_the_user_decides() {
    use rmcp::{model::CallToolRequestParams, transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport}, ServiceExt as _};
    let (_dir, ws, p) = fixture();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = crate::collaboration_mcp::router(ws.clone(), port);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let connect = |agent: &str| {
        let config = crate::collaboration_mcp::agent_http_config(&ws, agent, &format!("http://127.0.0.1:{port}")).unwrap();
        let token = config["headers"]["Authorization"].as_str().unwrap().trim_start_matches("Bearer ").to_owned();
        StreamableHttpClientTransport::with_client(
            reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().unwrap(),
            StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp/{agent}")).auth_header(token))
    };
    let call = |name: &'static str, arguments: Value| CallToolRequestParams::new(name).with_arguments(arguments.as_object().unwrap().clone());
    let lead = tokio::time::timeout(std::time::Duration::from_secs(10), ().serve(connect("lead"))).await.unwrap().unwrap();
    let member = tokio::time::timeout(std::time::Duration::from_secs(10), ().serve(connect("member"))).await.unwrap().unwrap();
    let tools = lead.list_all_tools().await.unwrap();
    for name in ["handover_get", "handover_propose"] {
        assert!(tools.iter().any(|t| t.name == name), "{name} is offered to Agents");
    }
    assert!(!tools.iter().any(|t| t.name.contains("decision") || t.name.contains("approve")), "no Agent tool decides");
    let read = lead.call_tool(call("handover_get", json!({}))).await.unwrap().structured_content.unwrap();
    assert_eq!(read["version"], 1);
    let refused = member.call_tool(call("handover_propose", json!({"requestId":"m","expectedVersion":1,"markdown":"# Member"}))).await.unwrap();
    assert_eq!(refused.is_error, Some(true));
    assert!(refused.structured_content.unwrap()["error"].as_str().unwrap().starts_with("not_lead:"), "a member is refused over MCP");
    let made = lead.call_tool(call("handover_propose", json!({"requestId":"l","expectedVersion":1,"markdown":"# Lab\nNew.","reason":"Shorter"})))
        .await.unwrap().structured_content.unwrap();
    assert_eq!((made["proposal"]["state"].clone(), made["writes"].as_str().is_some_and(|w| w.starts_with("Nothing until the user approves"))),
        (json!("pending"), true), "{made}");
    let id = made["proposal"]["id"].as_str().unwrap();
    let (status, approved) = route(&ws, "POST", &format!("/api/projects/{p}/handover/proposals/{id}/decision"),
        Some(json!({"requestId":"u","action":"approve","expectedVersion":1}))).await;
    assert_eq!((status, approved["handover"]["version"].clone()), (StatusCode::OK, json!(2)), "the user decides in the browser: {approved}");
    let _ = lead.cancel().await;
    let _ = member.cancel().await;
    server.abort();
}
