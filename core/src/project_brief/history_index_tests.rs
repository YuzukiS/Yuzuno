//! YN-221 S1: Home's history as an index (`GET /api/home?history=index`),
//! its entries read whole (`GET /api/projects/{id}/brief/history?entries=`)
//! and Needs you alone (`GET /api/home/needs`). `check` holds them to the
//! whole Home for whatever a test has built; the tests here add the entries
//! that are not history's and the requests refused.
use super::*;
use axum::{body::Body, http::Request};
use tower::ServiceExt;

/// For the Brief as it is now: Home with its history as an index is Home
/// whole, but for each history entry, which is the whole one without body,
/// attachments and refs, nor an answered ask's kept reply (YN-223), and with
/// `bodyOmitted` and `attachmentCount`; each entry read alone is the whole
/// one; Needs you alone is Home's.
pub(in crate::project_brief) fn check(store: &Store) {
    let full = home::build(store).unwrap();
    let index = home::build_with(store, home::History::Index).unwrap();
    assert_eq!(full["order"], index["order"]);
    assert_eq!(full["needsYou"], index["needsYou"]);
    let (full_panels, index_panels) = (full["projects"].as_array().unwrap(), index["projects"].as_array().unwrap());
    assert_eq!(full_panels.len(), index_panels.len());
    for (whole, indexed) in full_panels.iter().zip(index_panels) {
        let project = whole["project"]["id"].as_str().unwrap();
        let history = whole["brief"]["history"].as_array().unwrap();
        let mut expected = whole.clone();
        expected["brief"]["historyIndex"] = json!(true);
        expected["brief"]["history"] = history.iter().map(|entry| {
            let mut entry = entry.clone();
            let count = entry["attachments"].as_array().unwrap().len();
            for field in ["body", "attachments", "refs"] {
                entry.as_object_mut().unwrap().remove(field);
            }
            if let Some(ask) = entry.get_mut("ask").and_then(Value::as_object_mut) {
                ask.remove("replySnapshot");
            }
            entry["bodyOmitted"] = json!(true);
            entry["attachmentCount"] = json!(count);
            entry
        }).collect();
        assert_eq!(indexed, &expected, "the index is Home's history without bodies");
        let wanted: Vec<(i64, i64)> = history.iter().map(|e| (e["id"].as_i64().unwrap(), e["version"].as_i64().unwrap())).collect();
        for (chunk, entries) in wanted.chunks(home::ENTRIES_AT_ONCE).zip(history.chunks(home::ENTRIES_AT_ONCE)) {
            let read = home::history_entries(store, project, chunk).unwrap();
            assert_eq!(read["missing"], json!([]));
            assert_eq!(read["entries"].as_array().unwrap(), entries, "an entry read whole is Home's");
        }
    }
    assert_eq!(home::needs(store).unwrap()["needsYou"], full["needsYou"], "Needs you alone is Home's");
}

async fn get(app: &axum::Router, uri: &str) -> (u16, Value) {
    let response = app.clone().oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 64 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn entry_of(home: &Value, key: &str) -> (i64, i64) {
    let entry = home["projects"][0]["brief"]["history"].as_array().unwrap().iter().find(|e| e["key"] == key).unwrap();
    (entry["id"].as_i64().unwrap(), entry["version"].as_i64().unwrap())
}

#[tokio::test]
async fn entries_that_are_not_home_history_are_missing_and_malformed_requests_are_refused() {
    let (_dir, ws, project) = lab();
    let mut files = vec![];
    for key in ["kept", "refreshed", "revised", "expired"] {
        files.push(put(key, "report"));
    }
    accept(&ws, "a", input("h1", 0, files)).await;
    let marked: Vec<(String, i64)> = ["kept", "refreshed", "revised", "expired"].iter().map(|k| (k.to_string(), 1)).collect();
    sections::mark_seen(&ws.store, &project, &marked).unwrap();
    accept(&ws, "a", input("h2", 1, vec![put("live", "report")])).await;
    let home = home::build(&ws.store).unwrap();
    let pairs: std::collections::HashMap<&str, (i64, i64)> = ["kept", "refreshed", "revised", "expired"].iter().map(|k| (*k, entry_of(&home, k))).collect();
    let live = home["projects"][0]["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == "live").unwrap().clone();
    let live = (live["id"].as_i64().unwrap(), live["version"].as_i64().unwrap());
    // A card's past issue, a card's earlier version and an entry past
    // history's days are kept by Core but are not Home's history.
    {
        let db = ws.store.db.write().unwrap();
        for (key, change) in [("refreshed", "history_reason='refreshed'"), ("revised", "history_reason='revised'"),
            ("expired", "history_at='2020-01-01T00:00:00+00:00'")] {
            db.execute(&format!("UPDATE project_brief_sections SET {change} WHERE project_id=?1 AND key=?2 AND live=0"), params![project, key]).unwrap();
        }
    }
    // Another Project's entry, asked for under this one.
    let other = ws.store.create_project("Other", std::collections::BTreeMap::new()).unwrap().id;
    ws.store.set_agent_project("d", Some(&other)).unwrap();
    set_leads(&ws, &other, &["d"]);
    accept(&ws, "d", input("o1", 0, vec![put("theirs", "report")])).await;
    sections::mark_seen(&ws.store, &other, &[("theirs".into(), 1)]).unwrap();
    let theirs = home::build(&ws.store).unwrap()["projects"].as_array().unwrap().iter()
        .find(|p| p["project"]["id"] == other).unwrap()["brief"]["history"][0].clone();
    let theirs = (theirs["id"].as_i64().unwrap(), theirs["version"].as_i64().unwrap());
    check(&ws.store);

    let app = router().with_state(ws.clone());
    let ask = |pairs: &[(i64, i64)]| format!("/api/projects/{project}/brief/history?entries={}",
        pairs.iter().map(|(id, version)| format!("{id}:{version}")).collect::<Vec<_>>().join(","));
    let kept = pairs["kept"];
    let (status, read) = get(&app, &ask(&[kept, pairs["refreshed"], pairs["revised"], pairs["expired"], live, theirs, (kept.0, kept.1 + 5)])).await;
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["entries"].as_array().unwrap().iter().map(|e| e["key"].clone()).collect::<Vec<_>>(), vec![json!("kept")]);
    let missing: Vec<(i64, i64)> = read["missing"].as_array().unwrap().iter().map(|m| (m["id"].as_i64().unwrap(), m["version"].as_i64().unwrap())).collect();
    assert_eq!(missing, vec![pairs["refreshed"], pairs["revised"], pairs["expired"], live, theirs, (kept.0, kept.1 + 5)]);
    // An unknown Project has none of them.
    let (status, read) = get(&app, &format!("/api/projects/nope/brief/history?entries={}:{}", kept.0, kept.1)).await;
    assert_eq!((status, read["entries"].clone(), read["missing"].as_array().unwrap().len()), (200, json!([]), 1));
    // At most 50 at once; malformed lists and a missing list are refused.
    let many: Vec<(i64, i64)> = (1..=51).map(|n| (n, 1)).collect();
    for uri in [ask(&many), format!("/api/projects/{project}/brief/history?entries=1-2"),
        format!("/api/projects/{project}/brief/history?entries=x:1"), format!("/api/projects/{project}/brief/history")] {
        let (status, read) = get(&app, &uri).await;
        assert_eq!((status, read["code"].clone()), (400, json!("invalid_input")), "{uri}");
    }
    let (status, read) = get(&app, &ask(&[kept; 51])).await;
    assert_eq!(status, 200, "the same entry twice is one: {read}");
    assert_eq!(read["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn home_refuses_an_unknown_history_form_and_the_phone_entry_serves_the_new_reads() {
    let (dir, ws, project) = lab();
    accept(&ws, "a", input("p1", 0, vec![put("result", "report"), put("decide", "ask")])).await;
    sections::mark_seen(&ws.store, &project, &[("result".into(), 1)]).unwrap();
    let app = router().with_state(ws.clone());
    let (status, read) = get(&app, "/api/home?history=bogus").await;
    assert_eq!((status, read["code"].clone()), (400, json!("invalid_input")));
    // The header asks for the same index, at Home's own address.
    let by_header = |value: &str| Request::builder().uri("/api/home").header("x-yuzuno-history", value).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(by_header("index")).await.unwrap();
    assert_eq!(response.status(), 200);
    let indexed: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 64 << 20).await.unwrap()).unwrap();
    let (_, by_query) = get(&app, "/api/home?history=index").await;
    assert_eq!((indexed["projects"].clone(), indexed["needsYou"].clone()), (by_query["projects"].clone(), by_query["needsYou"].clone()));
    assert_eq!(app.clone().oneshot(by_header("whole")).await.unwrap().status(), 400);
    // Each form is checked on its own: a good one never covers a bad one.
    let both = |uri: &str, value: &str| Request::builder().uri(uri).header("x-yuzuno-history", value).body(Body::empty()).unwrap();
    for (uri, value) in [("/api/home?history=index", "whole"), ("/api/home?history=whole", "index")] {
        assert_eq!(app.clone().oneshot(both(uri, value)).await.unwrap().status(), 400, "{uri} with {value}");
    }
    let response = app.clone().oneshot(both("/api/home?history=index", "index")).await.unwrap();
    assert_eq!(response.status(), 200, "both, saying the same");
    let agreed: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 64 << 20).await.unwrap()).unwrap();
    assert_eq!(agreed["projects"][0]["brief"]["historyIndex"], true);
    let (status, whole) = get(&app, "/api/home").await;
    assert_eq!(status, 200);
    assert!(whole["projects"][0]["brief"].get("historyIndex").is_none(), "without the parameter Home is as it was");
    assert!(whole["projects"][0]["brief"]["history"][0]["body"].is_object());

    let entry = crate::server::RemoteEntry::new("https://core.example-tailnet.ts.net:8444", "person@example.com").unwrap();
    let phone = crate::server::remote_router(ws.clone(), dir.path().join("assets"), None, entry);
    let read = |uri: &str| Request::builder().uri(uri).header("host", "core.example-tailnet.ts.net:8444")
        .header("tailscale-user-login", "person@example.com").body(Body::empty()).unwrap();
    let body = |response: axum::response::Response| async move {
        let status = response.status().as_u16();
        (status, serde_json::from_slice::<Value>(&axum::body::to_bytes(response.into_body(), 64 << 20).await.unwrap()).unwrap())
    };
    let (status, indexed) = body(phone.clone().oneshot(read("/api/home?history=index")).await.unwrap()).await;
    assert_eq!(status, 200, "{indexed}");
    assert_eq!(indexed["projects"][0]["brief"]["historyIndex"], true);
    assert_eq!(indexed["projects"][0]["brief"]["history"][0]["bodyOmitted"], true);
    let (id, version) = entry_of(&indexed, "result");
    let (status, read_whole) = body(phone.clone().oneshot(read(&format!("/api/projects/{project}/brief/history?entries={id}:{version}"))).await.unwrap()).await;
    assert_eq!(status, 200);
    assert_eq!(read_whole["entries"][0], whole["projects"][0]["brief"]["history"][0]);
    let (status, needs) = body(phone.oneshot(read("/api/home/needs")).await.unwrap()).await;
    assert_eq!(status, 200);
    assert_eq!(needs["needsYou"], whole["needsYou"]);
    assert_eq!(needs["needsYou"][0]["sectionKey"], "decide");
}

#[tokio::test]
async fn needs_you_alone_keeps_home_order_and_leaves_out_deferred_asks() {
    let (_dir, ws, project) = lab();
    let second = ws.store.create_project("Second", std::collections::BTreeMap::new()).unwrap().id;
    ws.store.set_agent_project("d", Some(&second)).unwrap();
    set_leads(&ws, &second, &["d"]);
    accept(&ws, "a", input("n1", 0, vec![put("first", "ask"), put("later", "ask")])).await;
    accept(&ws, "d", input("n3", 0, vec![put("theirs", "ask")])).await;
    let later = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    sections::defer(&ws.store, &project, "later", Some(&later)).unwrap();
    home::set_order(&ws.store, &[second.clone(), project.clone()]).unwrap();
    let needs = home::needs(&ws.store).unwrap()["needsYou"].clone();
    let keys: Vec<_> = needs.as_array().unwrap().iter().map(|n| n["sectionKey"].clone()).collect();
    assert_eq!(keys, vec![json!("theirs"), json!("first")], "Project Priority, a deferred ask left out");
    check(&ws.store);
}

#[tokio::test]
async fn each_kind_of_history_entry_is_the_same_in_the_index_and_read_alone() {
    let (dir, ws, project) = lab();
    let data = dir.path().join("loss.csv");
    std::fs::write(&data, "step,loss\n1,2\n").unwrap();
    let mut report = put("result", "report");
    report["attachments"] = json!([{"name":"loss.csv","path":data}]);
    accept(&ws, "a", input("h1", 0, vec![report, put("gone", "report"), put("pick", "ask"), put("load", "status")])).await;
    // A seen report with its attachment, a removed section, an ask resolved
    // after a reply that carried images.
    sections::mark_seen(&ws.store, &project, &[("result".into(), 1)]).unwrap();
    accept(&ws, "a", input("h2", version(&ws, &project), vec![op("remove", "gone")])).await;
    assert!(sections::mark_replied_form(&ws.store, &project, "pick", 1, "Left", None, &["synthetic.png".into()], &[]).unwrap());
    accept(&ws, "a", input("h3", version(&ws, &project), vec![op("resolve", "pick")])).await;
    let home = home::build(&ws.store).unwrap();
    let reasons: Vec<_> = home["projects"][0]["brief"]["history"].as_array().unwrap().iter().map(|e| e["historyReason"].clone()).collect();
    assert_eq!(reasons, vec![json!("resolved"), json!("removed"), json!("seen")]);
    assert_eq!(home["projects"][0]["brief"]["history"][2]["attachments"].as_array().unwrap().len(), 1);
    check(&ws.store);
    let indexed = home::build_with(&ws.store, home::History::Index).unwrap();
    assert_eq!(indexed["projects"][0]["brief"]["history"][2]["attachmentCount"], 1);
    assert_eq!(indexed["projects"][0]["brief"]["history"][0]["ask"]["replyImages"], json!(["synthetic.png"]));
    // More entries than one read takes; each is seen before the next is
    // written, within the Brief's topics.
    for n in 0..55 {
        accept(&ws, "b", input(&format!("m{n}"), version(&ws, &project), vec![put(&format!("note-{n}"), "report")])).await;
        sections::mark_seen(&ws.store, &project, &[(format!("note-{n}"), 1)]).unwrap();
    }
    assert_eq!(home::build(&ws.store).unwrap()["projects"][0]["brief"]["history"].as_array().unwrap().len(), 58);
    check(&ws.store);
}

/// A Markdown body of about `bytes` bytes of prose.
fn prose(n: usize, bytes: usize) -> Value {
    let words = ["the", "index", "keeps", "each", "entry", "while", "its", "body", "waits", "for", "a", "click", "on", "Home"];
    let mut text = format!("Entry {n}. ");
    let mut i = n;
    while text.len() < bytes {
        text.push_str(words[i % words.len()]);
        text.push(if i % 17 == 0 { '\n' } else { ' ' });
        i += 7;
    }
    body(&text)
}

/// One change by lead a, at the Brief's version now.
async fn seed(ws: &Arc<Workspace>, project: &str, request: String, change: Value) {
    let version = version(ws, project);
    accept(ws, "a", input(&request, version, vec![change])).await;
}

/// Median of seven builds, in milliseconds, and the bytes of one.
fn timed(store: &Store, history: home::History) -> (f64, usize) {
    let mut times = vec![];
    let mut bytes = 0;
    for _ in 0..7 {
        let started = std::time::Instant::now();
        let built = home::build_with(store, history).unwrap();
        bytes = serde_json::to_vec(&built).unwrap().len();
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (times[3], bytes)
}

/// YN-221 S1: Home's bytes and build time with its history whole and as an
/// index, on one Project whose 30 days of history is R-26's size (541
/// entries, 2.37 MB: about 4.4 KB each), 60% seen reports, 30% ended tasks'
/// cards with an earlier version each, 10% resolved asks, beside 20 live
/// sections; and one read of 20 entries whole. Run explicitly:
/// `cargo test --lib project_brief::tests::history_index_tests::home_measure -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "YN-221 S1 measurement of Home's history whole and as an index; run explicitly"]
async fn home_measure() {
    const ENTRIES: usize = 541;
    const BODY: usize = 4_300;
    let (_dir, ws, project) = lab();
    let (reports, cards) = (ENTRIES * 6 / 10, ENTRIES * 3 / 10);
    let asks = ENTRIES - reports - cards;
    for i in 0..reports {
        let mut change = put(&format!("report-{i}"), "report");
        change["body"] = prose(i, BODY);
        seed(&ws, &project, format!("r{i}"), change).await;
        sections::mark_seen(&ws.store, &project, &[(format!("report-{i}"), 1)]).unwrap();
    }
    for i in 0..asks {
        let mut change = put(&format!("ask-{i}"), "ask");
        change["body"] = prose(i, BODY);
        seed(&ws, &project, format!("a{i}"), change).await;
        assert!(sections::mark_replied_live(&ws.store, &project, &format!("ask-{i}"), "Left").unwrap());
        seed(&ws, &project, format!("a{i}r"), op("resolve", &format!("ask-{i}"))).await;
    }
    for i in 0..cards {
        let created = ws.store.collaboration_call(None, "task_create",
            json!({"requestId":format!("task {i}"),"title":format!("Task {i}"),"projectId":project,"status":"doing"})).unwrap();
        let task = created["task"]["id"].as_str().unwrap().to_owned();
        let key = task.to_lowercase();
        for round in 0..2 {
            let mut change = put(&key, "status");
            change["task"] = json!(task);
            change["body"] = prose(i * 2 + round, BODY);
            seed(&ws, &project, format!("c{i}.{round}"), change).await;
        }
        let version: i64 = {
            let db = ws.store.db.read().unwrap();
            let (internal, _) = crate::collaboration_store::task_key(&db, &task).unwrap();
            db.query_row("SELECT version FROM collaboration_tasks WHERE id=?1", [internal], |r| r.get(0)).unwrap()
        };
        ws.store.collaboration_call(None, "task_update", json!({"requestId":format!("done {i}"),"taskId":task,
            "expectedVersion":version,"patch":{"status":"done"}})).unwrap();
    }
    // 20 live sections in 5 topics, within the Brief's 12 topics and 4
    // sub-topics each.
    for i in 0..20 {
        let key = if i % 4 == 0 { format!("live-{}", i / 4) } else { format!("live-{}/part-{}", i / 4, i % 4) };
        let mut change = put(&key, "report");
        change["body"] = prose(i, BODY);
        seed(&ws, &project, format!("l{i}"), change).await;
    }
    let whole = home::build(&ws.store).unwrap();
    let history = whole["projects"][0]["brief"]["history"].as_array().unwrap().clone();
    assert_eq!(history.len(), ENTRIES, "every seeded entry is history");
    let (full_ms, full_bytes) = timed(&ws.store, home::History::Full);
    let (index_ms, index_bytes) = timed(&ws.store, home::History::Index);
    let history_bytes = serde_json::to_vec(&history).unwrap().len();
    let wanted: Vec<(i64, i64)> = history.iter().take(20).map(|e| (e["id"].as_i64().unwrap(), e["version"].as_i64().unwrap())).collect();
    let started = std::time::Instant::now();
    let entries = home::history_entries(&ws.store, &project, &wanted).unwrap();
    let entries_ms = started.elapsed().as_secs_f64() * 1000.0;
    let entries_bytes = serde_json::to_vec(&entries).unwrap().len();
    let needs_bytes = serde_json::to_vec(&home::needs(&ws.store).unwrap()).unwrap().len();
    let ratio = index_bytes as f64 / full_bytes as f64;
    let row = json!({"entries":ENTRIES,"live":20,"bodyBytes":BODY,"full":{"bytes":full_bytes,"historyBytes":history_bytes,"buildMsMedian7":full_ms},
        "index":{"bytes":index_bytes,"buildMsMedian7":index_ms},"ratio":ratio,
        "entries20":{"bytes":entries_bytes,"ms":entries_ms},"needs":{"bytes":needs_bytes}});
    println!("{row}");
    if let Ok(path) = std::env::var("YN221_S1_MEASURE_OUT") {
        std::fs::write(path, format!("{row}\n")).unwrap();
    }
    check(&ws.store);
    assert!(ratio <= 0.30, "the index is over 30% of Home whole: {row}");
}

// YN-223: an answered Ask in History keeps the reply as the user gave it to the version it answered. Home read whole
// and the entry opened from the index show it alike; the index never carries it, nor reads History's for it.
#[tokio::test]
async fn a_resolved_asks_kept_reply_comes_with_its_entry_read_whole_never_with_the_index() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask"), put("open", "ask")])).await;
    let given = json!({"format":1,"projectName":"Code","sectionKind":"ask","title":"About decide","question":"Which way?",
        "options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}],"choice":{"id":"left","label":"Left"},"text":"Go","form":null});
    let live = json!({"format":1,"projectName":"Code","sectionKind":"ask","title":"About open","question":"Which way?",
        "options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}],"choice":{"id":"right","label":"Right"},"text":null,"form":null});
    assert!(sections::mark_replied_form(&ws.store, &project, "decide", 1, "Left: Go", sections::Marked { snapshot: Some(&given), ..Default::default() }).unwrap());
    assert!(sections::mark_replied_form(&ws.store, &project, "open", 1, "Right", sections::Marked { snapshot: Some(&live), ..Default::default() }).unwrap());
    accept(&ws, "a", input("q2", 1, vec![op("resolve", "decide")])).await;
    let full = home::build(&ws.store).unwrap();
    let whole = full["projects"][0]["brief"]["history"].as_array().unwrap().iter().find(|e| e["key"] == "decide").unwrap().clone();
    assert_eq!((whole["ask"]["state"].clone(), whole["ask"]["replySnapshot"].clone()), (json!("resolved"), given));
    let index = home::build_with(&ws.store, home::History::Index).unwrap();
    let indexed = index["projects"][0]["brief"]["history"].as_array().unwrap().iter().find(|e| e["key"] == "decide").unwrap().clone();
    assert_eq!(indexed["bodyOmitted"], true);
    assert!(indexed["ask"].get("replySnapshot").is_none(), "never on the index: {indexed}");
    // A live answered Ask keeps it beside the index, as Home read whole has it.
    let open = index["projects"][0]["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == "open").unwrap().clone();
    assert_eq!(open["ask"]["replySnapshot"], live);
    // Opened from the index: the entry read whole, its reply as given included, as Home read whole shows it.
    let read = home::history_entries(&ws.store, &project, &[entry_of(&index, "decide")]).unwrap();
    assert_eq!(read["missing"], json!([]));
    assert_eq!(read["entries"][0], whole, "the entry opened from the index is Home's");
    check(&ws.store);
}
