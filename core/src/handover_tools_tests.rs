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

#[allow(dead_code)]
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

fn write(request: &str, expected: i64, markdown: &str) -> Value {
    json!({"requestId":request,"expectedVersion":expected,"markdown":markdown,"reason":"Say how to test"})
}

fn error_of(result: Result<Value>) -> String {
    result.err().map_or_else(|| "accepted".to_owned(), |e| format!("{e:#}"))
}

/// Home's Needs you, as the browser reads it, and its Projects' panels.
async fn home(ws: &Arc<Workspace>) -> Value {
    let request = axum::http::Request::builder().uri("/api/home").body(axum::body::Body::empty()).unwrap();
    let response = crate::project_brief::router().with_state(ws.clone()).oneshot(request).await.unwrap();
    serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1 << 22).await.unwrap()).unwrap()
}

fn mail_to(store: &Store, agent: &str) -> Vec<String> {
    let db = store.db.read().unwrap();
    let mut query = db.prepare("SELECT json_extract(data,'$.body') FROM collaboration_messages WHERE recipient_id=?1 ORDER BY rowid").unwrap();
    query.query_map([agent], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

/// YN-2 S3: a lead of the Project writes the handover at once: a new version
/// with its name and reason, no approval, nothing on Home. Every member reads
/// it, and says whether it may write it.
#[tokio::test]
async fn a_lead_writes_the_handover_at_once_with_its_name_and_reason() {
    let (_dir, ws, p) = fixture();
    let mut events = ws.changes.subscribe(None);
    let written = ws.collaboration_call(Some("lead"), "handover_update", write("first", 1, "# Lab\nBuild with make, then test."))
        .await.unwrap_or_else(|e| panic!("a lead writes the handover at once: {e:#}"));
    assert_eq!((written["written"]["version"].clone(), written["written"]["writtenBy"].clone(), written["written"]["reason"].clone()),
        (json!(2), json!({"id":"lead","name":"Agent lead"}), json!("Say how to test")), "{written}");
    assert_eq!(written["written"]["approvedBy"], Value::Null, "no one approves it");
    let announced: Value = serde_json::from_str(&events.try_next().expect("the write is announced").data).unwrap();
    assert_eq!((announced["handover"].clone(), announced["projectId"].clone()), (json!(true), json!(p)));

    let read = ws.collaboration_call(Some("exec"), "handover_get", json!({})).await.unwrap();
    assert_eq!((read["version"].clone(), read["markdown"].clone()), (json!(2), json!("# Lab\nBuild with make, then test.")),
        "an executor reads the new version");
    assert_eq!(read["history"][0]["writtenBy"], json!({"id":"lead","name":"Agent lead"}));
    assert_eq!(read["canWrite"], false, "an executor reads only");
    assert_eq!(ws.collaboration_call(Some("member"), "handover_get", json!({})).await.unwrap()["canWrite"], false);
    assert_eq!(ws.collaboration_call(Some("lead2"), "handover_get", json!({})).await.unwrap()["canWrite"], true, "any lead of the Project writes it");
    let home = home(&ws).await;
    assert!(!home["needsYou"].as_array().unwrap().iter().any(|n| n["kind"] == "handover"), "nothing waits on Home: {home}");
    assert!(home["projects"].as_array().unwrap().iter().all(|panel| panel.get("handoverProposal").is_none()), "no proposal card");
    // The user sees it in the Project's settings, and writes after it.
    let saved = ws.store.save_handover(&p, 2, "# Lab\nThe user's.", Some("Mine")).unwrap();
    assert_eq!((saved["version"].clone(), saved["history"][1]["writtenBy"]["id"].clone()), (json!(3), json!("lead")));
}

/// YN-2 S3: a retry with the same requestId and payload answers the same
/// version; another payload under it is refused, and nothing is written.
#[tokio::test]
async fn a_retry_of_a_leads_write_is_the_same_version_and_another_payload_is_refused() {
    let (_dir, ws, p) = fixture();
    let first = ws.collaboration_call(Some("lead"), "handover_update", write("same", 1, "# Lab\nOne.")).await.unwrap();
    let again = ws.collaboration_call(Some("lead"), "handover_update", write("same", 1, "# Lab\nOne.")).await.unwrap();
    assert_eq!(again["written"], first["written"], "a retry gets the same version");
    let refused = error_of(ws.collaboration_call(Some("lead"), "handover_update", write("same", 2, "# Lab\nTwo.")).await);
    assert!(refused.starts_with("idempotency_conflict:"), "{refused}");
    let versions: i64 = ws.store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM project_handover_versions WHERE project_id=?1", [&p], |r| r.get(0)).unwrap();
    assert_eq!(versions, 2, "the first save and the lead's one write");
    // Another lead's write under the same requestId is its own.
    let other = ws.collaboration_call(Some("lead2"), "handover_update", write("same", 2, "# Lab\nTwo.")).await.unwrap();
    assert_eq!(other["written"]["version"], 3);
}

/// YN-2 S3: only a lead of the Project writes it, against the version it
/// read, with a reason; an executor, another member, the user's tool call
/// and an archived Project's are refused before anything is written.
#[tokio::test]
async fn only_a_lead_writes_the_handover_and_every_member_reads_it() {
    let (_dir, ws, p) = fixture();
    let without_reason = json!({"requestId":"r","expectedVersion":1,"markdown":"# Lab"});
    let cases = [
        (Some("member"), write("m", 1, "# Member"), "not_lead: only a lead of this Project writes its handover"),
        (Some("exec"), write("e", 1, "# Executor"), "not_lead: only a lead of this Project writes its handover"),
        (Some("outsider"), write("o", 1, "# Outsider"), "not_member: you are in no Project"),
        (None, write("u", 1, "# User"), "agent_only: handover_update is for a Project's leads"),
        (Some("lead"), without_reason, "invalid_input: reason is required"),
        (Some("lead"), write("stale", 0, "# Lab"), "version_conflict: this Project's handover is at version 1, not 0"),
    ];
    for (actor, input, says) in cases {
        let got = error_of(ws.collaboration_call(actor, "handover_update", input.clone()).await);
        assert!(got.starts_with(says), "{actor:?} {input} should be refused with {says}; got {got}");
    }
    let mut outsider = write("o2", 1, "# Outsider");
    outsider["projectId"] = json!(p);
    assert!(error_of(ws.collaboration_call(Some("outsider"), "handover_update", outsider).await).starts_with("not_lead:"));
    let archive = crate::projects::ProjectChange { name: None, key: None, default_dirs: Default::default(), archived: Some(true) };
    ws.store.update_project(&p, archive).unwrap();
    let archived = error_of(ws.collaboration_call(Some("lead"), "handover_update", write("a", 1, "# Lab")).await);
    assert!(!archived.starts_with("accepted"), "an archived Project's handover doesn't change: {archived}");
    assert_eq!(ws.collaboration_call(Some("lead"), "handover_get", json!({})).await.unwrap()["canWrite"], false, "nor may it be written");
    assert_eq!(ws.store.handover(&p, None).unwrap()["version"], 1, "nothing was written");
}

/// YN-2 S3: handover_propose, from a client that still lists it, is refused
/// naming handover_update, and writes nothing.
#[tokio::test]
async fn handover_propose_is_refused_naming_handover_update() {
    let (_dir, ws, p) = fixture();
    let refused = error_of(ws.collaboration_call(Some("lead"), "handover_propose",
        json!({"requestId":"p","expectedVersion":1,"markdown":"# Lab\nProposed.","reason":"Old way"})).await);
    assert!(refused.starts_with("tool_replaced: handover_propose was replaced by handover_update"), "{refused}");
    let proposals: i64 = ws.store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM project_handover_proposals WHERE project_id=?1", [&p], |r| r.get(0)).unwrap();
    assert_eq!(proposals, 0);
}

/// YN-2 S3: at open, a proposal still waiting from before is superseded with
/// a note, and its open lead is mailed once, with its text; a closed lead's
/// is superseded too, with no mail. Its text stays in the table.
#[test]
fn a_waiting_proposal_is_superseded_at_open_and_its_lead_is_mailed_its_text_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let store = Store::open(&path).unwrap();
    let p = store.create_project("Lab", BTreeMap::new()).unwrap().id;
    let q = store.create_project("Field", BTreeMap::new()).unwrap().id;
    for id in ["lead", "gone"] {
        store.insert(&agent_detail(id)).unwrap();
    }
    store.update("gone", "agent/closed", &json!({}), |d| d.agent.closed_at = Some(now())).unwrap();
    store.save_handover(&p, 0, "# Lab", None).unwrap();
    for (id, project, proposer) in [("waiting", &p, "lead"), ("closed", &q, "gone")] {
        store.db.write().unwrap().execute(
            "INSERT INTO project_handover_proposals(id, project_id, proposer_id, proposer_name, base_version, markdown, reason, request_id, created_at, state)
             VALUES(?1, ?2, ?3, ?4, 1, ?5, 'Shorter', ?1, '2026-11-05T00:00:00Z', 'pending')",
            params![id, project, proposer, format!("Agent {proposer}"), format!("# Lab\nProposed by {proposer}.")]).unwrap();
    }
    drop(store);
    let store = Store::open(&path).unwrap();
    let state = |id: &str| -> (String, Option<String>, String) { store.db.read().unwrap().query_row(
        "SELECT state, note, markdown FROM project_handover_proposals WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap() };
    assert_eq!(state("waiting"), ("superseded".into(), Some(SUPERSEDED.into()), "# Lab\nProposed by lead.".into()),
        "a waiting proposal is superseded at open, its text kept");
    assert_eq!(state("closed").0, "superseded");
    let mail = mail_to(&store, "lead");
    assert_eq!(mail.len(), 1, "its lead is told once: {mail:?}");
    assert!(mail[0].contains("was not applied") && mail[0].contains("handover_update") && mail[0].contains("(it is at version 1)")
        && mail[0].contains("# Lab\nProposed by lead."), "{}", mail[0]);
    assert!(mail_to(&store, "gone").is_empty(), "a closed lead gets no mail");
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(mail_to(&store, "lead").len(), 1, "opening again mails no one");
}

/// YN-2 S3: over MCP, a lead writes and a member is refused; no Agent tool
/// proposes or decides any more.
#[tokio::test]
async fn through_mcp_a_lead_writes_the_handover_and_a_member_is_refused() {
    use rmcp::{model::CallToolRequestParams, transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport}, ServiceExt as _};
    let (_dir, ws, _p) = fixture();
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
    for name in ["handover_get", "handover_update"] {
        assert!(tools.iter().any(|t| t.name == name), "{name} is offered to Agents");
    }
    assert!(!tools.iter().any(|t| t.name == "handover_propose" || t.name.contains("decision") || t.name.contains("approve")),
        "no Agent tool proposes or decides");
    let refused = member.call_tool(call("handover_update", write("m", 1, "# Member"))).await.unwrap();
    assert_eq!(refused.is_error, Some(true));
    assert!(refused.structured_content.unwrap()["error"].as_str().unwrap().starts_with("not_lead:"), "a member is refused over MCP");
    let written = lead.call_tool(call("handover_update", write("l", 1, "# Lab\nNew."))).await.unwrap().structured_content.unwrap();
    assert_eq!(written["written"]["version"], 2, "{written}");
    let _ = lead.cancel().await;
    let _ = member.cancel().await;
    server.abort();
}
