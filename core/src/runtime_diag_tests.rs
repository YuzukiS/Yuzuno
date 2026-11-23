//! YN-221 S7a: the runtime counters and /api/diagnostics/runtime.
use super::*;
use crate::workspace::Workspace;
use axum::{body::to_bytes, routing::get, Router};
use futures_util::StreamExt;
use tower::ServiceExt;

fn lab() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/synthetic/work".into(), "unused-codex".into()).unwrap();
    (dir, ws)
}

const LOCAL_HEADERS: [(&str, &str); 2] = [("host", "127.0.0.1:4317"), ("x-yuzuno-client", "desktop")];

fn request(uri: &str, headers: &[(&str, &str)]) -> Request {
    let mut builder = axum::http::Request::builder().uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::empty()).unwrap()
}

async fn read(app: &Router, uri: &str, headers: &[(&str, &str)]) -> (StatusCode, Vec<u8>) {
    let response = app.clone().oneshot(request(uri, headers)).await.unwrap();
    let status = response.status();
    (status, to_bytes(response.into_body(), 64 << 20).await.unwrap().to_vec())
}

fn row<'a>(report: &'a Value, entry: &str, method: &str, route: &str) -> &'a Value {
    report["http"].as_array().unwrap().iter().find(|r| r["entry"] == entry && r["method"] == method && r["route"] == route)
        .unwrap_or_else(|| panic!("no row {entry} {method} {route}: {report}"))
}

#[tokio::test]
async fn requests_count_under_their_route_template_status_and_visibility_and_no_path_or_query_is_kept() {
    let (dir, ws) = lab();
    let app = crate::server::router(ws.clone(), dir.path().join("assets"));
    let (one, two) = ("0f6b9b1e-3c5d-4c1a-9a51-7d2f5e8c4b10", "6a1e2d3c-4b5a-4f69-8e7d-1c2b3a4d5e6f");
    read(&app, &format!("/api/agents/{one}"), &LOCAL_HEADERS).await;
    read(&app, &format!("/api/agents/{two}?view=private-query-text"), &LOCAL_HEADERS).await;
    let hidden = [LOCAL_HEADERS[0], LOCAL_HEADERS[1], (VISIBILITY_HEADER, "hidden")];
    let (status, health) = read(&app, "/api/health", &hidden).await;
    assert_eq!(status, StatusCode::OK);
    read(&app, "/some/page/private-path", &LOCAL_HEADERS).await;
    let (status, body) = read(&app, "/api/diagnostics/runtime", &LOCAL_HEADERS).await;
    assert_eq!(status, StatusCode::OK);
    let text = String::from_utf8(body).unwrap();
    for secret in [one, two, "private-query-text", "private-path"] {
        assert!(!text.contains(secret), "{secret} is not kept: {text}");
    }
    let report: Value = serde_json::from_str(&text).unwrap();
    assert_eq!((report["format"].clone(), report["startedAt"].as_str()), (json!(1), Some(ws.http_counts.started_at())));
    let agents = row(&report, LOCAL, "GET", "/api/agents/{id}");
    assert_eq!(agents["count"], 2, "two IDs, one template: {agents}");
    assert_eq!(agents["visibility"]["unknown"], 2);
    let health_row = row(&report, LOCAL, "GET", "/api/health");
    assert_eq!((health_row["count"].clone(), health_row["status"]["2xx"].clone(), health_row["visibility"]["hidden"].clone()), (json!(1), json!(1), json!(1)));
    // Read whole: what it declared, what it sent and that it ended are the body's own length.
    assert_eq!((health_row["bytesDeclared"].as_u64(), health_row["bytesSent"].as_u64()), (Some(health.len() as u64), Some(health.len() as u64)));
    assert_eq!((health_row["bodiesCompleted"].clone(), health_row["bodiesDropped"].clone()), (json!(1), json!(0)));
    let wall: u64 = health_row["wallMs"].as_object().unwrap().values().map(|v| v.as_u64().unwrap()).sum();
    assert_eq!(wall, 1, "one time, in one bucket");
    assert_eq!(row(&report, LOCAL, "GET", FALLBACK)["count"], 1, "a page is the fallback's");
}

#[tokio::test]
async fn a_body_dropped_before_its_end_is_counted_apart_from_one_sent_whole() {
    let routes = Router::new().route("/big", get(|| async { "x".repeat(4096) }));
    let http = Arc::new(Http::default());
    let app = routes.layer(axum::middleware::from_fn_with_state((http.clone(), LOCAL), count));
    let (_, body) = read(&app, "/big", &[]).await;
    assert_eq!(body.len(), 4096);
    drop(app.clone().oneshot(request("/big", &[])).await.unwrap());
    let report = json!({"http": http.report()});
    let big = row(&report, LOCAL, "GET", "/big");
    assert_eq!((big["count"].clone(), big["bytesDeclared"].clone(), big["bytesSent"].clone()), (json!(2), json!(8192), json!(4096)));
    assert_eq!((big["bodiesCompleted"].clone(), big["bodiesDropped"].clone()), (json!(1), json!(1)));
}

#[tokio::test]
async fn published_messages_count_by_kind_and_streams_by_what_they_opened_and_sent() {
    let events = Arc::new(crate::events::Events::new());
    events.send(json!({"mergeQueue":true}));
    events.send(json!({"collaboration":true}));
    events.send(json!({"agentId":"a"}));
    events.publish(&json!({"type":"something.new"}));
    let counts = events.counts();
    let kinds: Vec<(String, u64)> = counts["published"].as_array().unwrap().iter()
        .map(|k| (k["kind"].as_str().unwrap().to_owned(), k["count"].as_u64().unwrap())).collect();
    assert_eq!(kinds, vec![("agent.changed".into(), 1), ("workspace.changed:collaboration".into(), 1),
        ("workspace.changed:workspace".into(), 1), ("other".into(), 1)]);
    assert!(counts["published"][0]["bytes"].as_u64().unwrap() > 0);
    let mut stream = Box::pin(events.stream(None));
    stream.next().await.unwrap().unwrap();
    let counts = events.counts();
    assert_eq!(counts["streams"], json!({"opened":1,"open":1,"frames":1}));
    assert_eq!(counts["subscribers"], 1);
    drop(stream);
    assert_eq!(events.counts()["streams"]["open"], 0);
}

#[tokio::test]
async fn the_phone_entry_counts_under_its_own_name_and_the_report_has_the_processes_cpu_and_threads() {
    let (dir, ws) = lab();
    let entry = crate::server::RemoteEntry::new("https://core.example-tailnet.ts.net:8444", "person@example.com").unwrap();
    let phone = crate::server::remote_router(ws.clone(), dir.path().join("assets"), None, entry);
    let headers = [("host", "core.example-tailnet.ts.net:8444"), ("tailscale-user-login", "person@example.com")];
    read(&phone, "/api/health", &headers).await;
    let (status, body) = read(&phone, "/api/diagnostics/runtime", &headers).await;
    assert_eq!(status, StatusCode::OK);
    let report: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(row(&report, PHONE, "GET", "/api/health")["count"], 1);
    if cfg!(target_os = "linux") {
        assert!(report["process"]["cpuNs"].as_u64().unwrap() > 0, "{report}");
        let groups = report["threads"]["groups"].as_array().unwrap();
        assert!(report["threads"]["available"] == true && !groups.is_empty(), "{report}");
        assert!(groups.iter().all(|g| g["count"].as_u64().unwrap() >= 1));
    }
}

#[test]
fn labels_past_the_limit_count_together() {
    let http = Http::default();
    for n in 0..ROUTES_KEPT + 5 {
        http.record((LOCAL, "GET", format!("/r/{n}")), StatusCode::OK, 2, Duration::from_millis(1), Some(1));
    }
    let report = http.report();
    assert_eq!(report.len(), ROUTES_KEPT + 1);
    assert_eq!(report.iter().find(|r| r["route"] == OTHER).unwrap()["count"], 5);
}

/// YN-221 S7a: what counting costs a request, on 10,000 requests of a
/// small JSON answer with and without the count, each in 5 alternating
/// rounds; ns per request, the median round. Run explicitly:
/// `cargo test --lib runtime_diag::tests::count_cost -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "YN-221 S7a measurement of the count's cost per request; run explicitly"]
async fn count_cost() {
    const REQUESTS: u32 = 10_000;
    let routes = || Router::new().route("/api/health", get(|| async { axum::Json(json!({"ok":true,"product":"yuzuno"})) }));
    let plain = routes();
    let counted = routes().layer(axum::middleware::from_fn_with_state((Arc::new(Http::default()), LOCAL), count));
    async fn round(app: &Router) -> f64 {
        let started = Instant::now();
        for _ in 0..REQUESTS {
            let response = app.clone().oneshot(request("/api/health", &[])).await.unwrap();
            to_bytes(response.into_body(), 1 << 16).await.unwrap();
        }
        started.elapsed().as_nanos() as f64 / f64::from(REQUESTS)
    }
    round(&plain).await;
    round(&counted).await;
    let (mut without, mut with) = (vec![], vec![]);
    for _ in 0..5 {
        without.push(round(&plain).await);
        with.push(round(&counted).await);
    }
    let median = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[2] };
    let (without, with) = (median(&mut without), median(&mut with));
    let row = json!({"requests":REQUESTS,"rounds":5,"nsPerRequestWithout":without,"nsPerRequestWith":with,"extraNs":with - without});
    println!("{row}");
    if let Ok(path) = std::env::var("YN221_S7A_MEASURE_OUT") {
        std::fs::write(path, format!("{row}\n")).unwrap();
    }
}
