//! Lab probes of a real OpenCode 2.x (T-32), ignored unless asked for:
//! `YUZUNO_OPENCODE_PROBE` names the executable, and whoever runs it gives
//! OpenCode a private XDG_CONFIG_HOME, with HOME as it is (Core gives it its
//! own data, state and cache folders). Through Core's own path, on loopback,
//! with no prompt and no provider. Slice 2 (Lead 4669): start, password and
//! stop. Slice 3a (Lead 4870): every route and envelope Core connects with,
//! run where no request can leave the host. Slice 3b (Lead 4983): a
//! session's messages, inbox and events read through Core's mapping, there
//! too. Slice 4a (Lead 5358): prompts run against a stub provider, also
//! there. Slice 4b (Lead 5656): a login through Core's own calls, and the
//! scrub after, against the stub provider.
#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, time::{Duration, Instant}};
use yuzuno_workspace::opencode::{session_of, supported, Events, FilePart, Launch, MessageId, Server, Submission, EVENT_IDLE_LIMIT, TEARDOWN};
use yuzuno_workspace::opencode_v2::{admitted, is_v2, is_v2_request, read_messages, Cursor};

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
    // The session's events until the one admitting it. 2.2.5 also admits a shell's output into the inbox, as a
    // synthetic message of its own ID for the next execution (p3 e2f44f88), so that is not the one looked for.
    let limit = Duration::from_secs(10);
    tokio::time::timeout(limit, async {
        loop {
            let event = events.next().await.unwrap().expect("the stream ended");
            seen.push(event["type"].as_str().unwrap_or("?").to_owned());
            if session_of(&event) != Some(session.as_str()) {
                continue;
            }
            let ours_admitted = event["type"] == "session.inbox.enqueued" && event["data"]["inboxID"] == chosen.as_str();
            println!("probe: {event}");
            ours.push(event);
            if ours_admitted {
                break;
            }
        }
    }).await.unwrap_or_else(|_| panic!("no event admitting {} within {limit:?}; seen {seen:?}", chosen.as_str()));
    let enqueued = ours.last().unwrap();
    assert_eq!(enqueued["data"]["inboxID"], chosen.as_str(), "its event names the ID Core chose");
    assert_eq!(enqueued["data"]["item"]["type"], "synthetic");
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

/// The stub provider (tests/fixtures/stub_provider.py), on loopback: its
/// port, and the file it logs each request to.
fn stub_provider(dir: &Path) -> (std::process::Child, u16, PathBuf) {
    let log = dir.join("stub-requests.jsonl");
    let mut child = std::process::Command::new("python3")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub_provider.py")).arg(&log)
        .stdout(std::process::Stdio::piped()).spawn().expect("python3 runs the stub provider");
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(child.stdout.take().unwrap()), &mut line).unwrap();
    (child, line.trim().parse().expect("the stub provider's port"), log)
}

/// The events of `session` until its execution ends, within 60 s.
async fn one_run(events: &mut Events, session: &str) -> Vec<Value> {
    let mut ours = Vec::new();
    let found = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let event = events.next().await.unwrap().expect("the stream ended");
            if session_of(&event) != Some(session) {
                continue;
            }
            let end = event["type"].as_str().is_some_and(|t| t.starts_with("session.execution.") && t != "session.execution.started");
            ours.push(event);
            if end {
                return;
            }
        }
    }).await;
    assert!(found.is_ok(), "no end of the run within 60 s; seen {:?}", ours.iter().map(|e| e["type"].clone()).collect::<Vec<_>>());
    ours
}

/// A real OpenCode 2.x runs prompts against a stub provider (T-32 slice 4a,
/// Lead 4963/5358): no network, no real provider, no login of the user's.
/// Sent through Core's own calls (the model made the session's, the prompt
/// under Core's ID, an image as a `data:` URI, an interrupt), and what
/// OpenCode streams and stores is read through Core's mapping, live and
/// whole: running while it runs and idle after; the answers to Core's
/// message; a tool through its states; the turn's end; and 2.x's own
/// permission request and form, which Core can't answer yet (slice 5).
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_runs_prompts_against_a_stub_provider_read_through_cores_mapping() {
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::write(directory.join("a.txt"), "stub file\n").unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    // The work folder's own config: one provider, the stub, with a fake key.
    std::fs::write(directory.join("opencode.json"), json!({"providers": {"stub": {"name": "Stub", "package": "@ai-sdk/openai-compatible",
        "settings": {"baseURL": format!("http://127.0.0.1:{port}/v1"), "apiKey": "fixture-stub-key"}, "models": {"fake": {"name": "Fake", "capabilities": {"tools": true, "input": ["text", "image"]}}}}},
        "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
        .to_string()).unwrap();
    let launch = Launch::new(program, directory.canonicalize().unwrap(), &root, dir.path().join("cache"));
    let server = std::sync::Arc::new(Server::start(&launch).await.unwrap());
    println!("probe: ready; /api/info says version {}", server.version());
    let models = server.models().await.unwrap();
    println!("probe: models {:?}", models.iter().map(|m| m.id()).collect::<Vec<_>>());
    let model = models.iter().find(|m| m.id() == "stub/fake").cloned().expect("the stub's model is listed");
    assert!(model.image, "listed as reading images");
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    server.switch_model(&session, &model, None).await.unwrap();
    let current = server.session(&session).await.unwrap()["model"].clone();
    println!("probe: the session's model {current}");
    assert_eq!((&current["id"], &current["providerID"]), (&json!("fake"), &json!("stub")), "the session's model, as Core made it");
    // With no variant chosen, 2.x reads the session's as its "default" one, which Core takes as none (D3).
    assert_eq!(current["variant"], "default", "no variant reads as the default one");

    // 2.x's own active list while it runs and after (Lead 4963), every 50 ms.
    let (http, password) = (reqwest::Client::builder().no_proxy().build().unwrap(), password_of(server.pid().unwrap()));
    let active = format!("{}/api/session/active", server.base());
    let watched = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let watcher = tokio::spawn({
        let (watched, session, http, active, password) = (watched.clone(), session.clone(), http.clone(), active.clone(), password.clone());
        async move {
            loop {
                if let Ok(answer) = http.get(&active).basic_auth("opencode", Some(&password)).send().await {
                    if let Ok(listed) = answer.json::<Value>().await {
                        let entry = listed["data"][&session].clone();
                        let mut watched = watched.lock().unwrap();
                        if watched.last() != Some(&entry) {
                            watched.push(entry);
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    });

    // A prompt that calls a tool, under Core's ID.
    let mut cursor = Cursor::default();
    let chosen = MessageId::new();
    assert_eq!(server.submit(&session, &chosen, "probe-4a tools").await.unwrap(), Submission::Accepted, "admitted under Core's ID");
    let first = one_run(&mut events, &session).await;
    let kinds: Vec<&str> = first.iter().filter_map(|e| e["type"].as_str()).collect();
    println!("probe: the first run's events {kinds:?}");
    assert_eq!(kinds.last(), Some(&"session.execution.succeeded"), "the run succeeded");
    let delivered: Vec<&Value> = first.iter().filter(|e| e["type"] == "session.inbox.delivered").map(|e| &e["data"]["inboxID"]).collect();
    assert!(delivered.contains(&&json!(chosen.as_str())), "delivered under Core's ID: {delivered:?}");
    let live: Vec<Value> = first.iter().flat_map(|e| cursor.read(e)).collect();
    let answers: Vec<&Value> = live.iter().filter(|e| e["type"] == "message.updated" && e["data"]["info"]["role"] == "assistant")
        .map(|e| &e["data"]["info"]).collect();
    assert!(!answers.is_empty() && answers.iter().all(|a| a["parentID"] == chosen.as_str()), "each step answers Core's message: {answers:?}");
    let tool: Vec<&Value> = live.iter().filter(|e| e["data"]["part"]["type"] == "tool").map(|e| &e["data"]["part"]).collect();
    println!("probe: the tool's states {:?}", tool.iter().map(|p| p["state"]["status"].clone()).collect::<Vec<_>>());
    let done = tool.last().expect("a tool call");
    assert_eq!((&done["tool"], &done["state"]["status"], &done["state"]["input"]["path"]), (&json!("read"), &json!("completed"), &json!("a.txt")));
    let mut text = std::collections::BTreeMap::<String, String>::new();
    for event in &live {
        match event["type"].as_str() {
            Some("message.part.updated") if event["data"]["part"]["type"] == "text" => {
                let part = &event["data"]["part"];
                text.insert(part["id"].as_str().unwrap().to_owned(), part["text"].as_str().unwrap_or_default().to_owned());
            }
            Some("message.part.delta") if event["data"]["type"] == "text" => {
                text.entry(event["data"]["partID"].as_str().unwrap().to_owned()).or_default().push_str(event["data"]["delta"].as_str().unwrap());
            }
            _ => {}
        }
    }
    println!("probe: the texts, live {text:?}");
    assert!(text.values().any(|t| t == "Done."), "the last text, whole");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let seen = watched.lock().unwrap().clone();
    println!("probe: the session in 2.x's active list, while and after {seen:?}");
    assert!(seen.contains(&json!({"type": "running"})), "running while it ran (Lead 4963)");
    assert_eq!(seen.last(), Some(&Value::Null), "not listed after");
    assert_eq!(server.session_status(&session).await.unwrap(), json!({"type": "idle"}), "idle after, as Core reads it");

    // Read whole: the same answers to Core's message, the tool done, the turn's end, the model's note.
    let snapshot = server.snapshot(&session, &[]).await.unwrap();
    let raw: Vec<&str> = snapshot.messages.as_array().unwrap().iter().filter_map(|m| m["type"].as_str()).collect();
    println!("probe: messages {raw:?}");
    assert!(raw.contains(&"model-switched"), "2.x keeps a note of the model Core made the session's");
    let read = read_messages(&snapshot.messages);
    let whole: Vec<&Value> = read.messages.iter().filter(|m| m["info"]["role"] == "assistant").map(|m| &m["info"]).collect();
    let ids = |infos: &[&Value]| {
        let mut ids: Vec<String> = infos.iter().map(|i| i["id"].as_str().unwrap().to_owned()).collect();
        ids.sort();
        ids.dedup();
        ids
    };
    assert_eq!(ids(&whole), ids(&answers), "the same answers, live and whole");
    assert!(whole.iter().all(|a| a["parentID"] == chosen.as_str() && a["time"]["completed"].is_number()), "{whole:?}");
    let parts: Vec<&Value> = read.messages.iter().flat_map(|m| m["parts"].as_array().unwrap()).collect();
    assert!(parts.iter().any(|p| p["type"] == "tool" && p["state"]["status"] == "completed"), "the tool done, whole");
    assert!(parts.iter().any(|p| p["type"] == "text" && p["text"] == "Done."), "the last text, whole");
    assert_eq!(read.ended.iter().map(|e| (e.user.as_str(), e.error.is_none())).collect::<Vec<_>>(), [(chosen.as_str(), true)],
        "the turn's end, under Core's message");
    let requests: Vec<Value> = std::fs::read_to_string(&log).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let main: Vec<&Value> = requests.iter().filter(|r| r["tools"] == true).collect();
    println!("probe: the stub saw {} requests, {} with tools; models {:?}", requests.len(), main.len(),
        requests.iter().map(|r| r["model"].clone()).collect::<Vec<_>>());
    assert!(main.len() >= 2 && main.iter().all(|r| r["model"] == "fake" && r["authorization"] == "Bearer fixture-stub-key"),
        "the stub's model, with its own key");

    // An image, as a `data:` URI.
    let png = {
        let mut out = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(4, 4, image::Rgb([10, 0, 0])).write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    };
    let pictured = MessageId::new();
    let file = FilePart { mime: "image/png", filename: "img-1".into(), data: png };
    assert_eq!(server.submit_with(&session, &pictured, "probe-4a image", &[file]).await.unwrap(), Submission::Accepted, "an image as a data: URI");
    let second = one_run(&mut events, &session).await;
    assert_eq!(second.last().map(|e| e["type"].clone()), Some(json!("session.execution.succeeded")));
    let admitted_as = second.iter().find(|e| e["type"] == "session.inbox.enqueued" && e["data"]["inboxID"] == pictured.as_str())
        .map(|e| e["data"]["item"]["payload"]["files"].clone());
    println!("probe: the image, as 2.x admitted it {admitted_as:?}");
    let pictured_turn = requests_after(&log, requests.len());
    println!("probe: the stub's next requests' user content {pictured_turn:?}");
    assert!(pictured_turn.iter().any(|c| c.contains("image")), "the image reached the provider");
    second.iter().for_each(|e| { cursor.read(e); });

    // 2.x's own permission request and form (until slice 5): told from 1.19.3's, as Core marks them not yet
    // answerable, and read as Core's; each run waits on it until it is interrupted.
    for (prompt, kind, as_core) in [("probe-4a ask", "permission.asked", "permission.asked"), ("probe-4a form", "form.created", "question.asked")] {
        let asking = MessageId::new();
        assert_eq!(server.submit(&session, &asking, prompt).await.unwrap(), Submission::Accepted);
        let (asked, read) = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let event = events.next().await.unwrap().expect("the stream ended");
                if session_of(&event) != Some(session.as_str()) {
                    continue;
                }
                let read = cursor.read(&event);
                if event["type"] == kind {
                    return (event, read);
                }
            }
        }).await.unwrap_or_else(|_| panic!("no {kind} within 30 s"));
        println!("probe: {kind} {}", asked["data"]);
        let request = if kind == "form.created" { &asked["data"]["form"] } else { &asked["data"] };
        assert!(is_v2_request(request), "{kind}: told from 1.19.3's shape");
        assert_eq!(read.iter().map(|e| e["type"].clone()).collect::<Vec<_>>(), [json!(as_core)], "{kind}: read as Core's {as_core}");
        assert_eq!(server.session_status(&session).await.unwrap(), json!({"type": "busy"}), "{kind}: its run waits on it");
        server.abort(&session).await.unwrap();
        let ended = one_run(&mut events, &session).await;
        println!("probe: after {kind}, until the end {:?}", ended.iter().map(|e| e["type"].clone()).collect::<Vec<_>>());
        assert_eq!(ended.last().unwrap()["type"], "session.execution.interrupted", "{kind}: interrupted");
        // The run's end ends it: 2.x keeps no request past its run, and Core's reading ends it too.
        let read: Vec<Value> = ended.iter().flat_map(|e| cursor.read(e)).collect();
        let replied = if kind == "form.created" { "question.replied" } else { "permission.replied" };
        assert!(read.iter().any(|e| e["type"] == replied && e["data"]["requestID"] == request["id"]), "{kind}: ended in Core with its run");
        let after = server.snapshot(&session, &[]).await.unwrap();
        assert!(after.permissions.is_empty() && after.questions.is_empty(), "{kind}: 2.x keeps no request past its run");
    }

    // An interrupt: the run ends interrupted by the user, which Core reads as its aborted answer.
    let slow = MessageId::new();
    assert_eq!(server.submit(&session, &slow, "probe-4a slow").await.unwrap(), Submission::Accepted);
    let mut running = false;
    for _ in 0..100 {
        running = server.session_status(&session).await.unwrap() == json!({"type": "busy"});
        if running { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(running, "the slow run was under way");
    server.abort(&session).await.unwrap();
    let third = one_run(&mut events, &session).await;
    let end = third.last().unwrap();
    println!("probe: the interrupted run's end {end}");
    assert_eq!((&end["type"], &end["data"]["reason"]), (&json!("session.execution.interrupted"), &json!("user")));
    let read: Vec<Value> = third.iter().flat_map(|e| cursor.read(e)).collect();
    assert!(read.iter().any(|e| e["type"] == "session.error" && e["data"]["error"]["name"] == "MessageAbortedError"), "read as Core's aborted answer");

    watcher.abort();
    let _ = watcher.await;
    stub.kill().ok();
    stub.wait().ok();
    let server = std::sync::Arc::try_unwrap(server).ok().expect("the probe's server, alone");
    let pid = u64::from(server.pid().unwrap());
    server.shutdown().await.unwrap();
    assert!(ended(pid), "OpenCode ended and was reaped");
}

/// The newest user message's content kinds in each stub request after the
/// first `seen`, as text (`text`, `image_url`).
fn requests_after(log: &Path, seen: usize) -> Vec<String> {
    std::fs::read_to_string(log).unwrap().lines().skip(seen).map(|l| {
        let request: Value = serde_json::from_str(l).unwrap();
        let user = request["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "user").cloned().unwrap_or_default();
        match &user["content"] {
            Value::Array(parts) => parts.iter().map(|p| p["type"].as_str().unwrap_or("?").to_owned()).collect::<Vec<_>>().join(","),
            other => format!("text:{}", other.as_str().is_some()),
        }
    }).collect()
}

/// A real OpenCode 2.x logged in through Core's own calls (T-32 slice 4b,
/// Lead 5656), against the stub provider: no network, no real provider,
/// none of the user's logins, and only the probe's own folders read. The
/// stub's integration is listed with a key method and nothing secret; a key
/// logged in is listed by its label only and goes with the next prompt,
/// over the config's own key (2.x's precedence); a model switch is taken
/// while a run goes on (R6's third point); logged out, the config's key
/// goes again; logged in again and its server stopped, the key is in the
/// Agent's own database, and the scrub leaves it nowhere there.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_is_logged_in_through_core_and_its_database_scrubbed_after() {
    const CONFIG_KEY: &str = "fixture-config-key-4b";
    const LOGIN_KEY: &str = "fixture-login-key-4b-Qx7";
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    std::fs::write(directory.join("opencode.json"), json!({"providers": {"stub": {"name": "Stub", "package": "@ai-sdk/openai-compatible",
        "settings": {"baseURL": format!("http://127.0.0.1:{port}/v1"), "apiKey": CONFIG_KEY},
        "models": {"fake": {"name": "Fake"}, "fake2": {"name": "Fake 2"}}}}}).to_string()).unwrap();
    let launch = Launch::new(program, directory.canonicalize().unwrap(), &root, dir.path().join("cache"));
    let server = Server::start(&launch).await.unwrap();
    println!("probe: ready; /api/info says version {}", server.version());
    let models = server.models().await.unwrap();
    let model = |id: &str| models.iter().find(|m| m.id() == id).cloned().unwrap_or_else(|| panic!("{id} is listed"));
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    server.switch_model(&session, &model("stub/fake"), None).await.unwrap();
    let stub_entry = |listed: &[Value]| listed.iter().find(|i| i["id"] == "stub").cloned().expect("the stub's integration");
    let authorizations = || -> Vec<String> { std::fs::read_to_string(&log).unwrap().lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["authorization"].as_str().unwrap_or_default().to_owned()).collect() };

    // 1. Listed with a key method, nothing secret in the answer.
    let listed = server.integrations().await.unwrap();
    let entry = stub_entry(&listed);
    println!("probe: the stub's integration {entry}");
    assert!(entry["methods"].as_array().unwrap().iter().any(|m| m["type"] == "key"), "a key method");
    assert!(!Value::Array(listed.clone()).to_string().contains(CONFIG_KEY), "nothing secret in the list");

    // 2. Logged in with a key: listed by its label only.
    server.connect_key("stub", LOGIN_KEY, Some("probe"), None).await.unwrap();
    let listed = server.integrations().await.unwrap();
    let connections = stub_entry(&listed)["connections"].clone();
    println!("probe: its connections {connections}");
    assert!(connections.as_array().unwrap().iter().any(|c| c["type"] == "credential" && c["label"] == "probe"), "listed by its label");
    assert!(!Value::Array(listed).to_string().contains(LOGIN_KEY), "never by its value");
    let credential = connections.as_array().unwrap().iter().find(|c| c["label"] == "probe").unwrap()["id"].as_str().unwrap().to_owned();

    // 3. The next prompt carries the logged-in key, over the config's.
    let seen = authorizations().len();
    assert_eq!(server.submit(&session, &MessageId::new(), "probe-4b hello").await.unwrap(), Submission::Accepted);
    assert_eq!(one_run(&mut events, &session).await.last().unwrap()["type"], "session.execution.succeeded");
    let sent = authorizations();
    println!("probe: the stub saw {:?}", sent[seen..].iter().map(|a| a.replace(LOGIN_KEY, "<login key>").replace(CONFIG_KEY, "<config key>")).collect::<Vec<_>>());
    assert!(!sent[seen..].is_empty() && sent[seen..].iter().all(|a| a == &format!("Bearer {LOGIN_KEY}")), "the logged-in key, over the config's");

    // 4. A model switch while a run goes on is taken (R6's third point), then the run is interrupted.
    assert_eq!(server.submit(&session, &MessageId::new(), "probe-4a slow").await.unwrap(), Submission::Accepted);
    for _ in 0..100 {
        if server.session_status(&session).await.unwrap() == json!({"type": "busy"}) { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(server.session_status(&session).await.unwrap(), json!({"type": "busy"}), "the run goes on");
    server.switch_model(&session, &model("stub/fake2"), None).await.expect("a switch while a run goes on is taken");
    let current = server.session(&session).await.unwrap()["model"].clone();
    println!("probe: the session's model after a switch while it ran {current}");
    assert_eq!(current["id"], "fake2");
    server.abort(&session).await.unwrap();
    assert_eq!(one_run(&mut events, &session).await.last().unwrap()["type"], "session.execution.interrupted");

    // 5. Logged out: the config's key goes again.
    server.delete_credential(&credential).await.unwrap();
    let seen = authorizations().len();
    assert_eq!(server.submit(&session, &MessageId::new(), "probe-4b again").await.unwrap(), Submission::Accepted);
    assert_eq!(one_run(&mut events, &session).await.last().unwrap()["type"], "session.execution.succeeded");
    assert!(authorizations()[seen..].iter().all(|a| a == &format!("Bearer {CONFIG_KEY}")), "logged out: the config's key");

    // 6. Logged in again, its server stopped: the key is in the Agent's own database, and the scrub leaves it nowhere there.
    server.connect_key("stub", LOGIN_KEY, Some("again"), None).await.unwrap();
    let pid = u64::from(server.pid().unwrap());
    server.shutdown().await.unwrap();
    assert!(ended(pid), "OpenCode ended and was reaped");
    stub.kill().ok();
    stub.wait().ok();
    let files = |db: &Path| ["", "-wal", "-shm"].map(|end| PathBuf::from(format!("{}{end}", db.display())));
    let holds = |path: &Path| std::fs::read(path).is_ok_and(|bytes| bytes.windows(LOGIN_KEY.len()).any(|w| w == LOGIN_KEY.as_bytes()));
    let before: Vec<bool> = files(&launch.database).iter().map(|p| holds(p)).collect();
    println!("probe: the key in the Agent's database before the scrub (db, -wal, -shm): {before:?}");
    assert!(before.iter().any(|h| *h), "kept in the Agent's own database");
    yuzuno_workspace::opencode_login::scrub(&launch.database).unwrap();
    let after: Vec<bool> = files(&launch.database).iter().map(|p| holds(p)).collect();
    println!("probe: after the scrub: {after:?}");
    assert!(after.iter().all(|h| !*h), "the scrub leaves it nowhere there");
    let left: i64 = rusqlite::Connection::open(&launch.database).unwrap()
        .query_row("SELECT count(*) FROM credential", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "no credential left");
}
