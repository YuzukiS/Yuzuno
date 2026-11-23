//! YN-221 S3: `/api/workspace?listing=slim` and `/api/agents/{id}/listing`.
use super::*;
use crate::{model::AgentDetail, workspace::Workspace};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use rusqlite::params;
use std::sync::Arc;
use tower::ServiceExt;

fn lab() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/synthetic/work".into(), "unused-codex".into()).unwrap();
    (dir, ws)
}

fn agent(ws: &Workspace, id: &str, extra: Value) {
    let mut fields = json!({"id":id,"name":format!("Agent {id}"),"goal":"Keep the build green","cwd":"/synthetic/work","model":"test",
        "color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":3,
        "reviewedSeq":1,"lastMessage":"m".repeat(1500)});
    for (key, value) in extra.as_object().unwrap() {
        fields[key] = value.clone();
    }
    let detail: AgentDetail = serde_json::from_value(json!({"agent":fields,"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
}

/// Executor `id` of a new task, its slot `slot`; released when `released`.
fn executor(ws: &Workspace, id: &str, slot: &str, released: bool, extra: Value) {
    agent(ws, id, extra);
    let (_, task) = crate::executor_lifecycle::tests::task(&ws.store, &format!("Work of {id}"));
    crate::executor_lifecycle::tests::role(&ws.store, id, &task, "user", &format!("dispatch-{id}"), slot, None);
    if released {
        ws.store.db.write().unwrap().execute("UPDATE agent_roles SET archived_at='2026-11-20T00:00:00Z',released_by='user' WHERE agent_id=?1",
            params![id]).unwrap();
    }
}

/// A lead, a working executor, a released one (one more on a machine), a
/// closed Agent and an Agent on a machine.
fn seeded() -> (tempfile::TempDir, Arc<Workspace>) {
    let (dir, ws) = lab();
    let machine = json!({"id":"mini","name":"Mac mini","target":"tester@192.0.2.10","codex":"codex","defaultCwd":"/srv/work"});
    agent(&ws, "lead", json!({}));
    executor(&ws, "working", "running", false, json!({"status":"working"}));
    executor(&ws, "released", "running", true, json!({"closedAt":"then"}));
    executor(&ws, "released-remote", "running", true, json!({"closedAt":"then","remote":{"machine":machine,"runtime":null}}));
    agent(&ws, "closed", json!({"closedAt":"then"}));
    agent(&ws, "remote", json!({"remote":{"machine":machine,"runtime":null}}));
    (dir, ws)
}

async fn get(app: &Router, uri: &str, headers: &[(&str, &str)]) -> (StatusCode, Value) {
    let mut builder = Request::builder().uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app.clone().oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 64 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

const LOCAL: [(&str, &str); 2] = [("host", "127.0.0.1:4317"), ("x-yuzuno-client", "desktop")];

fn rows(list: &Value) -> Vec<Value> {
    list["agents"].as_array().unwrap().clone()
}

#[tokio::test]
async fn a_slim_list_keeps_released_executors_to_their_listed_fields_and_every_other_row_whole() {
    let (dir, ws) = seeded();
    let app = crate::server::router(ws.clone(), dir.path().join("assets"));
    let (status, full) = get(&app, "/api/workspace", &LOCAL).await;
    assert_eq!(status, StatusCode::OK);
    assert!(full.get("listing").is_none(), "without the parameter the list is as it was");
    let (status, slim_list) = get(&app, "/api/workspace?listing=slim", &LOCAL).await;
    assert_eq!((status, &slim_list["listing"]), (StatusCode::OK, &json!("slim")));
    let mut expected = full.clone();
    expected["listing"] = json!("slim");
    expected["agents"] = json!(rows(&full).into_iter().map(slim).collect::<Vec<_>>());
    assert_eq!(slim_list, expected, "the same list, released executors slim");
    for row in rows(&slim_list) {
        let id = row["id"].as_str().unwrap();
        let whole = rows(&full).into_iter().find(|a| a["id"] == id).unwrap();
        if id.starts_with("released") {
            let mut keys: Vec<&str> = row.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort();
            let mut allowed: Vec<&str> = SLIM_FIELDS.iter().copied().filter(|f| whole.get(*f).is_some()).chain(["executor", "listing"]).collect();
            if id == "released-remote" {
                allowed.push("remote");
            }
            allowed.sort();
            assert_eq!(keys, allowed, "{id}");
            assert!(whole.get("lastMessage").is_some() && row.get("lastMessage").is_none() && row.get("goal").is_none(), "{id}");
            assert_eq!(row["executor"]["state"], "archived", "{id}");
            assert!(row["executor"].get("tempDir").is_none() && row["executor"]["route"].get("credential").is_none(), "{id}");
            if id == "released-remote" {
                assert_eq!(row["remote"], json!({"machine":{"id":"mini","name":"Mac mini"}}));
            }
        } else {
            assert_eq!(row, whole, "{id}: a row that is no released executor is whole");
        }
    }
    let (status, refused) = get(&app, "/api/workspace?listing=bogus", &LOCAL).await;
    assert_eq!((status, &refused["code"]), (StatusCode::BAD_REQUEST, &json!("invalid_input")));
    // The header asks for the same list, at the list's own address.
    let (status, by_header) = get(&app, "/api/workspace", &[LOCAL[0], LOCAL[1], ("x-yuzuno-listing", "slim")]).await;
    assert_eq!((status, by_header), (StatusCode::OK, slim_list));
    let (status, refused) = get(&app, "/api/workspace", &[LOCAL[0], LOCAL[1], ("x-yuzuno-listing", "whole")]).await;
    assert_eq!((status, &refused["code"]), (StatusCode::BAD_REQUEST, &json!("invalid_input")));
}

#[tokio::test]
async fn one_agents_listing_is_its_row_in_the_whole_list_on_both_entries() {
    let (dir, ws) = seeded();
    let app = crate::server::router(ws.clone(), dir.path().join("assets"));
    let (_, full) = get(&app, "/api/workspace", &LOCAL).await;
    let entry = crate::server::RemoteEntry::new("https://core.example-tailnet.ts.net:8444", "person@example.com").unwrap();
    let phone = crate::server::remote_router(ws.clone(), dir.path().join("assets"), None, entry);
    let on_phone = [("host", "core.example-tailnet.ts.net:8444"), ("tailscale-user-login", "person@example.com")];
    for whole in rows(&full) {
        let id = whole["id"].as_str().unwrap().to_owned();
        let (status, row) = get(&app, &format!("/api/agents/{id}/listing"), &LOCAL).await;
        assert_eq!((status, &row), (StatusCode::OK, &whole), "{id}");
        let (status, row) = get(&phone, &format!("/api/agents/{id}/listing"), &on_phone).await;
        assert_eq!((status, &row), (StatusCode::OK, &whole), "{id} on the phone entry");
    }
    let (status, slim_list) = get(&phone, "/api/workspace?listing=slim", &on_phone).await;
    assert_eq!((status, &slim_list["listing"]), (StatusCode::OK, &json!("slim")));
    let (status, missing) = get(&app, "/api/agents/nobody/listing", &LOCAL).await;
    assert_eq!((status, &missing["code"]), (StatusCode::NOT_FOUND, &json!("agent_not_found")));
}

/// YN-221 S3: `/api/workspace`'s bytes and handler time whole and slim, with
/// R-26's 305 released executors (813 KB of the 847 KB list: about 2.7 KB
/// each, mostly a 1.5 KB last message and the lifecycle) beside 20 Agents
/// at work. Run explicitly:
/// `cargo test --lib workspace_listing::tests::workspace_measure -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "YN-221 S3 measurement of the Agent list whole and slim; run explicitly"]
async fn workspace_measure() {
    let (dir, ws) = lab();
    for n in 0..305 {
        executor(&ws, &format!("released-{n}"), "running", true, json!({"closedAt":"then","workSummary":null}));
    }
    for n in 0..20 {
        agent(&ws, &format!("active-{n}"), json!({}));
    }
    let app = crate::server::router(ws.clone(), dir.path().join("assets"));
    let mut measured = json!({});
    for (name, uri) in [("full", "/api/workspace"), ("slim", "/api/workspace?listing=slim")] {
        let mut times = vec![];
        let mut bytes = 0;
        for _ in 0..7 {
            let started = std::time::Instant::now();
            let response = app.clone().oneshot(Request::builder().uri(uri).header("host", "127.0.0.1:4317")
                .header("x-yuzuno-client", "desktop").body(Body::empty()).unwrap()).await.unwrap();
            bytes = to_bytes(response.into_body(), 64 << 20).await.unwrap().len();
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        measured[name] = json!({"bytes":bytes,"msMedian7":times[3]});
    }
    let ratio = measured["slim"]["bytes"].as_f64().unwrap() / measured["full"]["bytes"].as_f64().unwrap();
    measured["ratio"] = json!(ratio);
    measured["released"] = json!(305);
    measured["active"] = json!(20);
    println!("{measured}");
    if let Ok(path) = std::env::var("YN221_S3_MEASURE_OUT") {
        std::fs::write(path, format!("{measured}\n")).unwrap();
    }
    assert!(ratio <= 0.35, "the slim list is over 35% of the whole: {measured}");
}
