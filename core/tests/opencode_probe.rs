//! Lab probes of a real OpenCode 2.x (T-32), ignored unless asked for:
//! `YUZUNO_OPENCODE_PROBE` names the executable, and whoever runs it gives
//! OpenCode a private XDG_CONFIG_HOME, with HOME as it is (Core gives it its
//! own data, state and cache folders). Through Core's own path, on loopback,
//! with no prompt and no provider. Slice 2 (Lead 4669): start, password and
//! stop. Slice 3a (Lead 4870): every route and envelope Core connects with,
//! run where no request can leave the host. Slice 3b (Lead 4983): a
//! session's messages, inbox and events read through Core's mapping, there
//! too.
#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, time::{Duration, Instant}};
use yuzuno_workspace::opencode::{session_of, supported, Events, Launch, MessageId, Server, EVENT_IDLE_LIMIT, TEARDOWN};
use yuzuno_workspace::opencode_v2::{admitted, is_v2, read_messages, Cursor};

fn ended(pid: u64) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
    }
}

#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE"]
async fn a_real_opencode_2x_starts_answers_only_its_password_and_ends_within_its_teardown() {
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let launch = Launch::new(program, directory, &root, dir.path().join("cache"));
    let started = Instant::now();
    let server = Server::start(&launch).await.unwrap();
    println!("probe: listening and ready after {:?}; /api/info says version {}", started.elapsed(), server.version());
    assert!(supported(server.version()), "{}", server.version());

    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let info = format!("{}/api/info", server.base());
    assert_eq!(http.get(&info).send().await.unwrap().status(), 401, "no password: refused");
    assert_eq!(http.get(&info).basic_auth("opencode", Some("guess")).send().await.unwrap().status(), 401, "another password: refused");
    println!("probe: /api/info without the password, and with another one: 401");

    let pid = u64::from(server.pid().unwrap());
    let stopping = Instant::now();
    server.shutdown().await.unwrap();
    let took = stopping.elapsed();
    println!("probe: shutdown took {took:?}");
    assert!(took < TEARDOWN + Duration::from_secs(1), "shutdown took {took:?}");
    assert!(ended(pid), "OpenCode ended and was reaped");
    let made: Vec<String> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    println!("probe: its database folder holds {made:?}");
    assert!(launch.database.exists(), "its database is where Core put it (OPENCODE_DB)");
}

/// OpenCode's own password, from its environment: only a process of the same
/// account reads it there, as this probe is.
fn password_of(pid: u32) -> String {
    let environ = std::fs::read(format!("/proc/{pid}/environ")).unwrap();
    environ.split(|b| *b == 0).find_map(|entry| entry.strip_prefix(b"OPENCODE_PASSWORD="))
        .map(|value| String::from_utf8(value.to_vec()).unwrap()).expect("OpenCode was started with OPENCODE_PASSWORD")
}

/// The events of `session` until one `done` says it is finished, within `limit`; every type seen is kept.
async fn events_until(events: &mut Events, session: &str, limit: Duration, seen: &mut Vec<String>, done: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(limit, async {
        loop {
            let event = events.next().await.unwrap().expect("the stream ended");
            seen.push(event["type"].as_str().unwrap_or("?").to_owned());
            if session_of(&event) == Some(session) && done(&event) {
                return event;
            }
        }
    }).await.unwrap_or_else(|_| panic!("no such event within {limit:?}; seen {seen:?}"))
}

fn tree(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            found.push(path.strip_prefix(root).unwrap().display().to_string());
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    found.sort();
    found
}

#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, and no network"]
async fn a_real_opencode_2x_serves_every_route_and_envelope_core_connects_with() {
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root, cache) = (dir.path().join("work"), dir.path().join("db"), dir.path().join("cache"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let directory = directory.canonicalize().unwrap();
    let launch = Launch::new(program, directory.clone(), &root, cache.clone());
    let server = Server::start(&launch).await.unwrap();
    println!("probe: ready; /api/info says version {}", server.version());
    let mut seen = Vec::new();

    // The stream: subscribe reads up to its server.connected; then a session, made in the Agent's folder.
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    let info = server.session(&session).await.unwrap();
    println!("probe: session {session}; its location {}", info["location"]);
    assert_eq!(info["location"]["directory"], directory.to_str().unwrap(), "made in the folder named in its body");
    let created = events_until(&mut events, &session, Duration::from_secs(10), &mut seen, |e| e["type"] == "session.created").await;
    println!("probe: session.created data keys {:?}", created["data"].as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()));

    // A message with no model: one shell command (POST /api/session/:id/shell, 204), its events, then the page.
    let (http, password) = (reqwest::Client::builder().no_proxy().build().unwrap(), password_of(server.pid().unwrap()));
    let shell = http.post(format!("{}/api/session/{session}/shell", server.base()))
        .basic_auth("opencode", Some(&password)).json(&json!({"command": "echo probe-3a"}))
        .send().await.unwrap();
    println!("probe: shell answered {}", shell.status());
    assert!(shell.status().is_success(), "{}", shell.status());
    events_until(&mut events, &session, Duration::from_secs(30), &mut seen, |e| e["type"].as_str().is_some_and(|t| t.contains("shell") && t.ends_with(".ended"))).await;
    let messages = server.messages(&session).await.unwrap();
    let kinds: Vec<&str> = messages.as_array().unwrap().iter().filter_map(|m| m["type"].as_str()).collect();
    println!("probe: events seen {seen:?}; messages {kinds:?}");
    assert!(kinds.contains(&"shell"), "the shell message is in the page: {messages}");
    // 2.x's active list is an object keyed by session ID, empty while nothing runs: a shell is no execution, and its
    // 204 comes once it has ended (core/src/session/session.ts), so the busy entry waits for a probe with a prompt.
    let active = http.get(format!("{}/api/session/active", server.base())).basic_auth("opencode", Some(&password)).send().await.unwrap()
        .json::<Value>().await.unwrap();
    println!("probe: /api/session/active answers {active}");
    assert!(active["data"].is_object(), "an object keyed by session: {active}");
    let status = server.session_status(&session).await.unwrap();
    let children = server.children(&session).await.unwrap();
    let snapshot = server.snapshot(&session, &[]).await.unwrap();
    println!("probe: status {status}; children {}; pending permissions {} and forms {}", children.len(), snapshot.permissions.len(), snapshot.questions.len());
    assert_eq!(status, json!({"type": "idle"}), "not running once its shell has ended");
    assert!(children.is_empty() && snapshot.permissions.is_empty() && snapshot.questions.is_empty());

    // No credential is in the Agent's database: its data folder is its own, so 2.x had no 1.x auth.json to import
    // (T-32 comment 4142). Only the count is read out, since this route answers the secrets themselves.
    let credentials = http.get(format!("{}/api/credential", server.base())).basic_auth("opencode", Some(&password)).send().await.unwrap();
    assert!(credentials.status().is_success(), "{}", credentials.status());
    let stored = credentials.json::<Value>().await.unwrap()["data"].as_array().map(Vec::len);
    println!("probe: credentials in the Agent's database: {stored:?}");
    assert_eq!(stored, Some(0), "no credential in the Agent's database");

    // A 1.19.3 route answers the web UI's page, which Core refuses as no API answer.
    let old = server.path().await.unwrap_err().to_string();
    println!("probe: GET /path: {old}");
    assert!(old.contains("not JSON: not an answer of the OpenCode 2.x API"), "{old}");

    // 35 s with nothing else said: its comment heartbeat keeps the stream past Core's 30 s limit.
    let until = Instant::now() + Duration::from_secs(35);
    loop {
        match tokio::time::timeout(until.saturating_duration_since(Instant::now()), events.next()).await {
            Err(_) => break,
            Ok(Ok(Some(event))) => seen.push(event["type"].as_str().unwrap_or("?").to_owned()),
            Ok(other) => panic!("the stream did not stay open for 35 s: {other:?}"),
        }
    }
    println!("probe: the stream stayed open for 35 s past the {EVENT_IDLE_LIMIT:?} limit");

    let pid = u64::from(server.pid().unwrap());
    server.shutdown().await.unwrap();
    assert!(ended(pid), "OpenCode ended and was reaped");
    println!("probe: its own folder holds {:?}", tree(&root));
    println!("probe: the shared cache holds {:?}", tree(&cache));
    assert!(tree(&root).iter().any(|p| p.starts_with("xdg/data/opencode")), "its data went to the Agent's own folder");
}

/// A session with a shell command and a synthetic message under an ID Core
/// chose, held back (`resume: false`): no execution, so no model and no
/// provider. What 2.x stores, lists in its inbox and streams of them is read
/// through Core's mapping (opencode_v2): the raw shapes it takes, the ID it
/// is admitted under (Lead 4983, note 3), and which reading the messages
/// get (2.x's, which the refusals of compaction, rewind and fork key on).
/// A model's answer, its steps and busy are slice 4's (stub provider).
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, and no network"]
async fn a_real_opencode_2x_session_reads_through_cores_mapping() {
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let launch = Launch::new(program, directory.canonicalize().unwrap(), &root, dir.path().join("cache"));
    let server = Server::start(&launch).await.unwrap();
    println!("probe: ready; /api/info says version {}", server.version());
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    let (http, password) = (reqwest::Client::builder().no_proxy().build().unwrap(), password_of(server.pid().unwrap()));
    let post = |route: &str, body: Value| http.post(format!("{}/api/session/{session}/{route}", server.base()))
        .basic_auth("opencode", Some(&password)).json(&body).send();
    let mut seen = Vec::new();
    let mut ours = Vec::new();

    let shell = post("shell", json!({"command": "echo probe-3b"})).await.unwrap();
    assert!(shell.status().is_success(), "{}", shell.status());
    ours.push(events_until(&mut events, &session, Duration::from_secs(30), &mut seen,
        |e| e["type"].as_str().is_some_and(|t| t.contains("shell") && t.ends_with(".ended"))).await);

    // A synthetic message under Core's own ID, held back.
    let chosen = MessageId::new();
    let synthetic = post("synthetic", json!({"id": chosen.as_str(), "text": "probe-3b synthetic", "resume": false})).await.unwrap();
    let status = synthetic.status();
    let answered: Value = synthetic.json().await.unwrap();
    println!("probe: synthetic answered {status}: {answered}");
    assert!(status.is_success(), "{status}: {answered}");
    assert_eq!(answered["data"]["id"], chosen.as_str(), "admitted under the ID Core chose");
    let enqueued = events_until(&mut events, &session, Duration::from_secs(10), &mut seen,
        |e| e["type"] == "session.inbox.enqueued").await;
    println!("probe: {enqueued}");
    assert_eq!(enqueued["data"]["inboxID"], chosen.as_str(), "its event names the ID Core chose");
    assert_eq!(enqueued["data"]["item"]["type"], "synthetic");
    ours.push(enqueued);
    // Whatever else it says of the session within 3 s (a delivery, say).
    let until = Instant::now() + Duration::from_secs(3);
    while let Ok(Ok(Some(event))) = tokio::time::timeout(until.saturating_duration_since(Instant::now()), events.next()).await {
        seen.push(event["type"].as_str().unwrap_or("?").to_owned());
        if session_of(&event) == Some(session.as_str()) {
            ours.push(event);
        }
    }
    println!("probe: events seen {seen:?}");

    // Live: what each of the session's events reads as.
    let mut cursor = Cursor::default();
    for event in &ours {
        let read: Vec<String> = cursor.read(event).iter().map(|e| e["type"].as_str().unwrap_or("?").to_owned()).collect();
        println!("probe: {} reads as {read:?}", event["type"]);
    }

    // Whole: its messages and inbox, as a snapshot takes them.
    let snapshot = server.snapshot(&session, &[]).await.unwrap();
    println!("probe: messages {}", snapshot.messages);
    println!("probe: inbox {}", snapshot.inbox);
    let messages = snapshot.messages.as_array().unwrap();
    assert!(messages.iter().all(|m| m["id"].as_str().is_some_and(|id| id.starts_with("msg_")) && m["type"].is_string()
        && m["time"]["created"].is_number()), "each with its ID, type and time: {}", snapshot.messages);
    assert!(is_v2(&snapshot.messages), "read as 2.x's");
    let kinds: Vec<&str> = messages.iter().filter_map(|m| m["type"].as_str()).collect();
    assert!(kinds.contains(&"shell"), "{kinds:?}");
    let listed = snapshot.inbox.as_array().unwrap().iter().any(|item| item["id"] == chosen.as_str());
    let stored = messages.iter().any(|m| m["id"] == chosen.as_str());
    println!("probe: the held-back synthetic is in the inbox: {listed}; in the messages: {stored}");
    assert!(listed != stored, "either admitted and waiting, or delivered: listed {listed}, stored {stored}");
    let read = read_messages(&snapshot.messages);
    println!("probe: read as {} messages {:?}; open turn {:?}; turn ends {}; steps under way {}", read.messages.len(),
        read.messages.iter().map(|m| (m["info"]["id"].as_str().unwrap_or("?").to_owned(), m["info"]["role"].clone())).collect::<Vec<_>>(),
        read.open, read.ended.len(), read.steps.len());
    assert!(read.ended.is_empty() && read.steps.is_empty(), "no execution: no turn's end and no step");
    assert!(admitted(&snapshot.inbox).is_empty(), "a synthetic message is not a user's message sent");

    let pid = u64::from(server.pid().unwrap());
    server.shutdown().await.unwrap();
    assert!(ended(pid), "OpenCode ended and was reaped");
}
