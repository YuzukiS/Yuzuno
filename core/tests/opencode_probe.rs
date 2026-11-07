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
//! scrub after, against the stub provider. T-61 slice 1 (Lead 6884): the
//! Workspace MCP through the Workspace's own send path, against Yuzuno's own
//! Workspace MCP endpoint on loopback and the stub provider. T-61 slice 2:
//! its requests answered. T-61 slice 3: its commands, as Core's transport
//! reads them and through the Workspace's own send path. T-61 slice 4: its
//! compaction, likewise. T-61 slice 5: its snapshots, where Core's Rewind
//! reads them, and a Rewind previewed through the Workspace.
#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, time::{Duration, Instant}};
use yuzuno_workspace::opencode::{
    session_of, supported, CommandAnswer, CompactAdmission, Events, FilePart, Launch, MessageId, Reply, RequestRefused, Server, Submission, EVENT_IDLE_LIMIT,
    TEARDOWN,
};
use yuzuno_workspace::opencode_v2::{admitted, is_v2, read_messages, Cursor, COMPACTION};
use yuzuno_workspace::store::whole::WholeRecord;

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

/// The stub provider's process, ended when dropped: a probe that fails before
/// its last line leaves no process behind, which would keep its Job's cgroup
/// from emptying and its reservation held (T-61, diag Job 4523e39b).
struct Stub(std::process::Child);

impl std::ops::Deref for Stub {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Stub {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.0.kill().ok();
        self.0.wait().ok();
    }
}

/// The stub provider (tests/fixtures/stub_provider.py), on loopback: its
/// process (ended when dropped), its port, and the file it logs each request to.
fn stub_provider(dir: &Path) -> (Stub, u16, PathBuf) {
    let log = dir.join("stub-requests.jsonl");
    let mut child = std::process::Command::new("python3")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stub_provider.py")).arg(&log)
        .stdout(std::process::Stdio::piped()).spawn().expect("python3 runs the stub provider");
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(child.stdout.take().unwrap()), &mut line).unwrap();
    (Stub(child), line.trim().parse().expect("the stub provider's port"), log)
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

    // 2.x's own permission request and form, read as Core's; each run waits on it until it is interrupted
    // (answering them is T-61 slice 2's probe).
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
        assert!(request["action"].is_string() || request["fields"].is_array(), "{kind}: 2.x's shape");
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
    let authorizations = || -> Vec<String> { std::fs::read_to_string(&log).unwrap_or_default().lines()
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

/// Counts the MCP sessions OpenCode opens at the Workspace MCP endpoint: each
/// `initialize` it sends.
async fn count_initialize(axum::extract::State(count): axum::extract::State<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
    request: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap_or_default();
    if serde_json::from_slice::<Value>(&bytes).is_ok_and(|v| v["method"] == "initialize") {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    next.run(axum::extract::Request::from_parts(parts, axum::body::Body::from(bytes))).await
}

/// Every file below `dir` that holds `needle`.
fn holding(dir: &Path, needle: &[u8]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => found.extend(holding(&path, needle)),
            Ok(kind) if kind.is_file() && std::fs::read(&path).is_ok_and(|bytes| bytes.windows(needle.len()).any(|w| w == needle)) => {
                found.push(path);
            }
            _ => {}
        }
    }
    found
}

/// A real OpenCode 2.x reaches the Workspace MCP through Core (T-61 slice 1,
/// Lead 6884), by the Workspace's own path: reconnect and send, as the UI
/// does, against Yuzuno's own Workspace MCP endpoint on loopback and the stub
/// provider, with no network, no real provider and no login of the user's.
/// Ready once OpenCode lists the server connected; a message goes, and the
/// model is offered `yuzuno_peers_list` as a tool of its own, whose call
/// reaches the endpoint as this Agent; the add before each message opens no
/// session anew; once OpenCode has unloaded the idle folder, the next
/// message adds it back and goes; and the bearer is in no file OpenCode
/// keeps, nor in its configuration or the work folder.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_reaches_the_workspace_mcp_through_cores_send_path() {
    use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};
    use yuzuno_workspace::{model::{AgentDetail, MessageInput}, workspace::Workspace};
    const ID: &str = "probe61agent";
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let work = work.canonicalize().unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    // The work folder's own config: the stub, and a folder unloaded after 2 s
    // without session events (2.x's default is an hour), so that the probe sees it go.
    std::fs::write(work.join("opencode.json"), json!({"providers": {"stub": {"name": "Stub", "package": "@ai-sdk/openai-compatible",
        "settings": {"baseURL": format!("http://127.0.0.1:{port}/v1"), "apiKey": "fixture-stub-key"},
        "models": {"fake": {"name": "Fake", "capabilities": {"tools": true}}}}},
        "experimental": {"location_idle_timeout": "2 seconds"}}).to_string()).unwrap();
    let data = dir.path().join("data");
    let ws = Workspace::new(data.clone(), work.to_string_lossy().into(), "unused".into()).unwrap();
    // Yuzuno's own Workspace MCP endpoint, as Core serves it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mcp_port = listener.local_addr().unwrap().port();
    ws.start_collaboration(mcp_port);
    let opened = Arc::new(AtomicUsize::new(0));
    let app = yuzuno_workspace::collaboration_mcp::router(ws.clone(), mcp_port)
        .layer(axum::middleware::from_fn_with_state(opened.clone(), count_initialize));
    let endpoint = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let agent: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":ID, "name":"OpenCode", "cwd":work, "model":"stub/fake", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    let config = yuzuno_workspace::collaboration_mcp::agent_http_config(&ws, ID, &format!("http://127.0.0.1:{mcp_port}")).unwrap();
    let bearer = config["headers"]["Authorization"].as_str().unwrap().strip_prefix("Bearer ").unwrap().to_owned();
    let requests = || -> Vec<Value> { std::fs::read_to_string(&log).unwrap_or_default().lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()).collect() };
    // Each time the Workspace tool's result, holding this Agent's ID, reached the model: a request whose newest
    // message is that result (the stub calls the tool once per turn; 2.x does not replay old tool output whole).
    let reached = |requests: &[Value]| requests.iter().filter(|r| r["messages"].as_array().and_then(|m| m.last())
        .is_some_and(|m| m["role"] == "tool" && m.to_string().contains(ID))).count();
    let finished = |turn: &str| {
        let (ws, turn) = (ws.clone(), turn.to_owned());
        async move {
            for _ in 0..600 {
                let d = ws.store.detail(ID).unwrap();
                if let Some(t) = d.turns.iter().find(|t| t["id"] == turn.as_str()).filter(|t| t["status"] != "inProgress") {
                    return t["status"].clone();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("the turn did not end within 60 s");
        }
    };
    let send = |client: &str| {
        let (ws, input) = (ws.clone(), serde_json::from_value::<MessageInput>(json!({"clientMessageId":client,"text":"probe-61 mcp"})).unwrap());
        async move { ws.send_message(ID, input).await }
    };

    // 1. Connected through the Workspace: ready once OpenCode lists the server connected.
    let d = ws.reconnect(ID).await.unwrap();
    let shown = ws.collaboration_status(ID).await.unwrap();
    println!("probe: connected {}, Workspace MCP ready {} ({:?}); MCP sessions opened {}", d.agent.connection_state, shown.ready,
        shown.error, opened.load(Ordering::SeqCst));
    assert!(shown.ready, "ready once OpenCode lists it connected: {:?}", shown.error);
    assert_eq!(opened.load(Ordering::SeqCst), 1, "one MCP session as it connected");

    // 2. A message goes, and the model calls the Workspace tool as a tool of its own, as this Agent.
    let receipt = send("p1").await.unwrap_or_else(|refused| panic!("the message was refused: {refused}"));
    let first = receipt.turn_id.unwrap();
    assert_eq!(finished(&first).await, "completed");
    let seen = requests();
    let offered: Vec<String> = seen.iter().filter(|r| r["tools"] == true).flat_map(|r| r["toolNames"].as_array().unwrap().clone())
        .filter_map(|n| n.as_str().map(str::to_owned)).filter(|n| n.starts_with("yuzuno_") || n == "execute").collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    println!("probe: Workspace tools offered to the model {offered:?}");
    assert!(offered.iter().any(|n| n == "yuzuno_peers_list"), "a tool of its own, not behind `execute`");
    assert_eq!(reached(&seen), 1, "the call reached the Workspace MCP as this Agent, and its result the model");
    assert_eq!(opened.load(Ordering::SeqCst), 1, "the add before the message opened no session anew");

    // 3. OpenCode unloads the idle folder (its own log says so), and the server goes with it.
    let agent_dir = data.join("opencode").join(ID);
    let mut unloaded = false;
    for _ in 0..100 {
        if !holding(&agent_dir, b"location services evicted").is_empty() {
            unloaded = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    println!("probe: OpenCode unloaded the idle folder: {unloaded}");
    assert!(unloaded, "OpenCode logs that it unloaded the folder within 100 s");

    // 4. The next message adds it back, and goes; its first step is offered the Workspace tools already (2.x
    // registers a server's tools a moment after it connects: Core waits for that, MCP_TOOLS_SETTLE).
    let before = requests().len();
    let second = send("p2").await.unwrap_or_else(|refused| panic!("refused after OpenCode unloaded the folder: {refused}"));
    assert_eq!(finished(&second.turn_id.unwrap()).await, "completed");
    let first_step = requests()[before..].iter().find(|r| r["tools"] == true).cloned().expect("a step of the next message");
    assert!(first_step["toolNames"].as_array().unwrap().iter().any(|n| n == "yuzuno_peers_list"),
        "the next message's first step is offered the Workspace tools");
    println!("probe: after the folder came back, MCP sessions opened {}; tool results seen {}", opened.load(Ordering::SeqCst), reached(&requests()));
    assert_eq!(opened.load(Ordering::SeqCst), 2, "added back: a new MCP session");
    assert_eq!(reached(&requests()), 2, "and the Workspace tool reached again");
    assert!(ws.collaboration_status(ID).await.unwrap().ready);

    // 5. Its OpenCode stopped: the bearer is in nothing it keeps, nor its configuration or the work folder.
    ws.close_agent(ID).await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
    endpoint.abort();
    let config_home = PathBuf::from(std::env::var_os("XDG_CONFIG_HOME").expect("the probe's private XDG_CONFIG_HOME"));
    for place in [agent_dir.clone(), data.join("opencode").join("cache"), work.clone(), config_home] {
        let found = holding(&place, bearer.as_bytes());
        println!("probe: files holding the bearer below {}: {}", place.display(), found.len());
        assert!(found.is_empty(), "the bearer is kept in {found:?}");
    }
}

/// The events of `session` until one of `kind`, or until its run ends, or
/// `secs` go by: what was seen, and whether `kind` came.
async fn until_kind(events: &mut Events, session: &str, kinds: &[&str], secs: u64) -> (Vec<Value>, bool) {
    let mut seen = Vec::new();
    let found = tokio::time::timeout(Duration::from_secs(secs), async {
        loop {
            let event = events.next().await.unwrap().expect("the stream ended");
            if session_of(&event) != Some(session) {
                continue;
            }
            let hit = event["type"].as_str().is_some_and(|t| kinds.contains(&t));
            seen.push(event);
            if hit {
                return;
            }
        }
    }).await;
    (seen, found.is_ok())
}

const ENDS: [&str; 3] = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"];

fn types(seen: &[Value]) -> Vec<String> {
    seen.iter().map(|e| e["type"].as_str().unwrap_or_default().to_owned()).collect()
}

/// T-61 slice 2, D-7 first (Lead 6921): a real OpenCode 2.x takes Core's
/// answers to its own permission requests and forms, by 2.x's routes, and
/// says how a run ends once one of them was refused (a reject, a declined
/// form): its end's type and reason are printed for D-7, with what a whole
/// read and the active list then show. A request named through another
/// session is refused and stays pending; an answer a form can't take is
/// refused and the form stays pending.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_takes_answers_to_its_requests_and_says_how_a_refused_ones_run_ends() {
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    std::fs::write(directory.join("opencode.json"), json!({"providers": {"stub": {"name": "Stub", "package": "@ai-sdk/openai-compatible",
        "settings": {"baseURL": format!("http://127.0.0.1:{port}/v1"), "apiKey": "fixture-stub-key"}, "models": {"fake": {"name": "Fake", "capabilities": {"tools": true}}}}},
        "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]}).to_string()).unwrap();
    let launch = Launch::new(program, directory.canonicalize().unwrap(), &root, dir.path().join("cache"));
    let server = Server::start(&launch).await.unwrap();
    println!("probe: ready; /api/info says version {}", server.version());
    let models = server.models().await.unwrap();
    let model = models.iter().find(|m| m.id() == "stub/fake").cloned().expect("the stub's model is listed");
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    let other = server.create_session("other").await.unwrap()["id"].as_str().unwrap().to_owned();
    server.switch_model(&session, &model, None).await.unwrap();
    let ask = |prompt: &'static str| { let (server, session) = (&server, session.clone()); async move {
        assert_eq!(server.submit(&session, &MessageId::new(), prompt).await.unwrap(), Submission::Accepted);
    } };
    let tool_results = || -> Vec<String> { std::fs::read_to_string(&log).unwrap_or_default().lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .flat_map(|r| r["messages"].as_array().cloned().unwrap_or_default())
        .filter(|m| m["role"] == "tool").map(|m| m["content"].to_string()).collect() };

    // A and G: a permission request; named through another session it is refused and stays pending; allowed once, its tool runs.
    ask("probe-4a ask").await;
    let (seen, asked) = until_kind(&mut events, &session, &["permission.asked"], 30).await;
    assert!(asked, "no permission.asked within 30 s: {:?}", types(&seen));
    let request = seen.last().unwrap()["data"].clone();
    println!("probe: A asked {request}");
    let id = request["id"].as_str().unwrap().to_owned();
    let wrong = server.reply_permission(&other, &id, Reply::Once).await.unwrap_err();
    println!("probe: G an answer through another session: {wrong}");
    assert!(matches!(wrong.downcast_ref::<RequestRefused>(), Some(RequestRefused::Gone { code: 404, .. })), "refused as gone: {wrong}");
    assert_eq!(server.snapshot(&session, &[]).await.unwrap().permissions.len(), 1, "still pending in its own session");
    server.reply_permission(&session, &id, Reply::Once).await.expect("allowed once: 204");
    let (run, done) = until_kind(&mut events, &session, &ENDS, 60).await;
    println!("probe: A after once {:?}", types(&run));
    assert!(done && run.last().unwrap()["type"] == "session.execution.succeeded", "the run goes on and succeeds");
    assert!(run.iter().any(|e| e["type"] == "permission.replied" && e["data"]["requestID"] == id.as_str()), "permission.replied names it");
    assert!(tool_results().iter().any(|t| t.contains("probe-4a")), "the shell ran and its output reached the model");

    // B: a permission request rejected: how its run ends (D-7).
    ask("probe-4a ask").await;
    let (seen, asked) = until_kind(&mut events, &session, &["permission.asked"], 30).await;
    assert!(asked, "no second permission.asked: {:?}", types(&seen));
    let id = seen.last().unwrap()["data"]["id"].as_str().unwrap().to_owned();
    server.reply_permission(&session, &id, Reply::Reject).await.expect("rejected: 204");
    let (run, done) = until_kind(&mut events, &session, &ENDS, 60).await;
    println!("probe: B after a reject {:?}", types(&run));
    println!("probe: B the run's end {}", if done { run.last().unwrap().to_string() } else { "none within 60 s".into() });
    println!("probe: B status {}, active {}", server.session_status(&session).await.unwrap(), server.snapshot(&session, &[]).await.unwrap().status);
    let read = server.snapshot(&session, &[]).await.unwrap();
    let last = read.messages.as_array().and_then(|m| m.last()).cloned().unwrap_or_default();
    println!("probe: B the whole read's last message: type {} {}", last["type"], last["error"]);

    // D: a form answered by its field's key.
    ask("probe-4a form").await;
    let (seen, asked) = until_kind(&mut events, &session, &["form.created"], 30).await;
    assert!(asked, "no form.created: {:?}", types(&seen));
    let form = seen.last().unwrap()["data"]["form"].clone();
    println!("probe: D form {form}");
    let (form_id, key) = (form["id"].as_str().unwrap().to_owned(), form["fields"][0]["key"].as_str().unwrap().to_owned());
    server.reply_form(&session, &form_id, &json!({key.clone(): "A"})).await.expect("answered: 204");
    let (run, done) = until_kind(&mut events, &session, &ENDS, 60).await;
    println!("probe: D after the answer {:?}", types(&run));
    assert!(done && run.last().unwrap()["type"] == "session.execution.succeeded", "the run goes on and succeeds");
    assert!(run.iter().any(|e| e["type"] == "form.replied" && e["data"]["id"] == form_id.as_str()), "form.replied names it");
    println!("probe: D the question tool's result {:?}", tool_results().last());

    // F: an answer the form can't take is refused and the form stays pending; then it is declined: how its run ends (D-7).
    ask("probe-4a form").await;
    let (seen, asked) = until_kind(&mut events, &session, &["form.created"], 30).await;
    assert!(asked, "no second form.created: {:?}", types(&seen));
    let form_id = seen.last().unwrap()["data"]["form"]["id"].as_str().unwrap().to_owned();
    let invalid = server.reply_form(&session, &form_id, &json!({"q9": "x"})).await.unwrap_err();
    println!("probe: F an answer it can't take: {invalid}");
    assert!(matches!(invalid.downcast_ref::<RequestRefused>(), Some(RequestRefused::Invalid { .. })), "refused as invalid: {invalid}");
    assert_eq!(server.snapshot(&session, &[]).await.unwrap().questions.len(), 1, "the form stays pending");
    server.cancel_form(&session, &form_id).await.expect("declined: 204");
    let (run, done) = until_kind(&mut events, &session, &ENDS, 60).await;
    println!("probe: F after a decline {:?}", types(&run));
    println!("probe: F the run's end {}", if done { run.last().unwrap().to_string() } else { "none within 60 s".into() });
    let read = server.snapshot(&session, &[]).await.unwrap();
    let last = read.messages.as_array().and_then(|m| m.last()).cloned().unwrap_or_default();
    println!("probe: F status {}; the whole read's last message: type {} {}", read.status, last["type"], last["error"]);

    // H: OpenCode started again on the same database after a declined run: whether it takes that run up again (a fact).
    let pid = u64::from(server.pid().unwrap());
    server.shutdown().await.unwrap();
    assert!(ended(pid), "OpenCode ended and was reaped");
    let server = Server::start(&launch).await.unwrap();
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let (seen, resumed) = until_kind(&mut events, &session, &["session.execution.started"], 15).await;
    println!("probe: H after a restart, the declined run {} ({:?})", if resumed { "was taken up again" } else { "was not taken up again within 15 s" }, types(&seen));
    if resumed {
        let (run, _) = until_kind(&mut events, &session, &["permission.asked", "form.created", ENDS[0], ENDS[1], ENDS[2]], 60).await;
        println!("probe: H the run taken up again {:?}", types(&run));
        server.abort(&session).await.ok();
    }
    let pid = u64::from(server.pid().unwrap());
    server.shutdown().await.unwrap();
    assert!(ended(pid), "OpenCode ended and was reaped");
    stub.kill().ok();
    stub.wait().ok();
}

/// T-61 slice 2 through the Workspace (D-2 (a)): a real OpenCode 2.x Agent,
/// connected and sent messages as the UI does, with the Workspace MCP on
/// against Yuzuno's own endpoint, asks for a permission and a question
/// (stub provider), and Yuzuno answers each by 2.x's routes: allowed once,
/// the tool runs and the turn completes; rejected, the turn ends declined
/// and the next message goes; a question answered, the model has the
/// answer; declined, the turn ends declined.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_asks_and_yuzuno_answers_through_the_workspace() {
    use yuzuno_workspace::{model::{AgentDetail, MessageInput}, workspace::Workspace};
    const ID: &str = "probe61requests";
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let work = work.canonicalize().unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    std::fs::write(work.join("opencode.json"), json!({"providers": {"stub": {"name": "Stub", "package": "@ai-sdk/openai-compatible",
        "settings": {"baseURL": format!("http://127.0.0.1:{port}/v1"), "apiKey": "fixture-stub-key"},
        "models": {"fake": {"name": "Fake", "capabilities": {"tools": true}}}}},
        "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]}).to_string()).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mcp_port = listener.local_addr().unwrap().port();
    ws.start_collaboration(mcp_port);
    let app = yuzuno_workspace::collaboration_mcp::router(ws.clone(), mcp_port);
    let endpoint = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let agent: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":ID, "name":"OpenCode", "cwd":work, "model":"stub/fake", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    let tool_results = || -> Vec<String> { std::fs::read_to_string(&log).unwrap_or_default().lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|r| r["messages"].as_array().and_then(|m| m.last()).cloned())
        .filter(|m| m["role"] == "tool").map(|m| m["content"].to_string()).collect() };
    let send = |client: &str, text: &str| {
        let (ws, input) = (ws.clone(), serde_json::from_value::<MessageInput>(json!({"clientMessageId":client,"text":text})).unwrap());
        async move { ws.send_message(ID, input).await.unwrap_or_else(|refused| panic!("the message was refused: {refused}")).turn_id.unwrap() }
    };
    let asked = |method: &'static str| {
        let ws = ws.clone();
        async move {
            for _ in 0..300 {
                if let Some(p) = ws.store.detail(ID).unwrap().pending.into_iter().find(|p| p.method == method && !p.stale) {
                    return p;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("no {method} within 30 s");
        }
    };
    let ended = |turn: String| {
        let ws = ws.clone();
        async move {
            for _ in 0..600 {
                let d = ws.store.detail(ID).unwrap();
                if let Some(t) = d.turns.iter().find(|t| t["id"] == turn.as_str()).filter(|t| t["status"] != "inProgress") {
                    return t.clone();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("the turn did not end within 60 s");
        }
    };
    let d = ws.reconnect(ID).await.unwrap();
    assert!(ws.collaboration_status(ID).await.unwrap().ready, "connected and ready: {}", d.agent.connection_state);

    // A. A permission request allowed once: the tool runs, the turn completes.
    let first = send("p1", "probe-4a ask").await;
    let p = asked("opencode/permission").await;
    println!("probe: A the request as Core keeps it {}", p.params);
    assert_eq!((&p.params["action"], &p.params["resources"]), (&json!("shell"), &json!(["echo probe-4a"])), "2.x's request, as it sent it");
    ws.respond(&p.id, json!({"decision":"once"})).await.expect("allowed once");
    assert_eq!(ended(first).await["status"], "completed", "the tool ran and the turn completed");
    assert!(tool_results().iter().any(|t| t.contains("probe-4a")), "the shell's output reached the model");

    // B. Rejected: the turn ends declined, and the next message goes.
    let second = send("p2", "probe-4a ask").await;
    let p = asked("opencode/permission").await;
    ws.respond(&p.id, json!({"decision":"reject"})).await.expect("rejected");
    let t = ended(second).await;
    println!("probe: B the turn after a reject: {} {}", t["status"], t["error"]);
    assert!(t["status"] == "interrupted" && t["error"]["message"].as_str().unwrap_or_default().contains("declined in Yuzuno"), "ended declined");
    let d = ws.store.detail(ID).unwrap();
    assert!(d.pending.is_empty() && d.agent.status != "working", "nothing left waiting: {}", d.agent.status);
    let third = send("p3", "hello").await;
    assert_eq!(ended(third).await["status"], "completed", "the next message goes and completes");

    // D. A question answered: the model has the answer.
    let fourth = send("p4", "probe-4a form").await;
    let q = asked("opencode/question").await;
    println!("probe: D the question as Core keeps it {}", q.params["questions"]);
    assert_eq!(q.params["questions"][0]["question"], "Which one?", "read as Core's question");
    ws.respond(&q.id, json!({"answers":[["A"]]})).await.expect("answered");
    assert_eq!(ended(fourth).await["status"], "completed");
    let said = tool_results().last().cloned().unwrap_or_default();
    println!("probe: D the question tool's result {said}");
    assert!(said.contains("Which one?") && said.contains("A"), "the answer reached the model");

    // F. A question declined: the turn ends declined.
    let fifth = send("p5", "probe-4a form").await;
    let q = asked("opencode/question").await;
    ws.respond(&q.id, json!({"decision":"reject"})).await.expect("declined");
    let t = ended(fifth).await;
    println!("probe: F the turn after a decline: {} {}", t["status"], t["error"]);
    assert!(t["status"] == "interrupted" && t["error"]["message"].as_str().unwrap_or_default().contains("declined in Yuzuno"), "ended declined");

    ws.close_agent(ID).await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
    endpoint.abort();
}

/// What the commands probes give a real OpenCode 2.x (T-61 slice 3): the stub
/// provider with two models, and three commands of its configuration
/// (2.2.5 schema/src/config/command.ts): one of the session's model, one
/// naming a model of its own, one run as a sub-agent.
fn commands_config(port: u16) -> String {
    let model = json!({"name": "Fake", "capabilities": {"tools": true}});
    json!({"providers": {"stub": {"name": "Stub", "package": "@ai-sdk/openai-compatible",
        "settings": {"baseURL": format!("http://127.0.0.1:{port}/v1"), "apiKey": "fixture-stub-key"},
        "models": {"fake": model, "fake2": model}}},
        "commands": {
            "probe61": {"template": "probe-61 command $ARGUMENTS", "description": "Probe 61"},
            "probe61m": {"template": "probe-61 command $ARGUMENTS", "model": "stub/fake2"},
            "probe61s": {"template": "probe-61 command $ARGUMENTS", "subagent": true},
        }}).to_string()
}

/// The model each stub request after the first `seen` asked for, and whether its newest user message holds `text`.
fn models_after(log: &Path, seen: usize, text: &str) -> Vec<(String, bool)> {
    std::fs::read_to_string(log).unwrap_or_default().lines().skip(seen).map(|l| {
        let request: Value = serde_json::from_str(l).unwrap();
        let user = request["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "user").cloned().unwrap_or_default();
        (request["model"].as_str().unwrap_or_default().to_owned(), user["content"].to_string().contains(text))
    }).collect()
}

/// A real OpenCode 2.x runs commands as Core's transport reads them (T-61
/// slice 3), against the stub provider: its list names and describes each,
/// its configuration's among its own; a command is done at 2.x's 204, its
/// message admitted under an ID of 2.x's own, newer than the one Core kept
/// for it; an unknown name is a 404 and a command whose definition fails
/// (`/goal` with no objective) a 500, each admitting nothing; a sub-agent's
/// command admits nothing in the session, has a session made for it before
/// the answer, and comes back later in a run of 2.x's own (timings printed).
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_runs_commands_as_cores_transport_reads_them() {
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    std::fs::write(directory.join("opencode.json"), commands_config(port)).unwrap();
    let launch = Launch::new(program, directory.canonicalize().unwrap(), &root, dir.path().join("cache"));
    let server = Server::start(&launch).await.unwrap();
    println!("probe: ready; /api/info says version {}", server.version());
    let model = server.models().await.unwrap().into_iter().find(|m| m.id() == "stub/fake").expect("the stub's model is listed");
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    server.switch_model(&session, &model, None).await.unwrap();
    let held = || {
        let (server, session) = (&server, session.clone());
        async move {
            let s = server.snapshot(&session, &[]).await.unwrap();
            (s.inbox.as_array().unwrap().len(), s.messages.as_array().unwrap().len())
        }
    };

    // 1. The list.
    let listed = server.commands().await.unwrap();
    println!("probe: 1 commands {:?}", listed.iter().map(|c| (&c.name, &c.description)).collect::<Vec<_>>());
    let names: Vec<&str> = listed.iter().map(|c| c.name.as_str()).collect();
    for name in ["probe61", "probe61m", "probe61s", "init", "review", "goal"] {
        assert!(names.contains(&name), "{name} is listed: {names:?}");
    }
    assert!(!names.contains(&"schedule"), "schedule only with experimental.schedules: {names:?}");
    assert_eq!(listed.iter().find(|c| c.name == "probe61").unwrap().description, "Probe 61");

    // 4. An unknown name: a 404, in 2.x's words, and nothing admitted.
    let before = held().await;
    let unknown = server.command(&session, &MessageId::new(), "probe61nope", "x").unwrap().await;
    println!("probe: 4 an unknown name: {unknown:?}");
    assert!(matches!(unknown, CommandAnswer::Refused { code: 404, .. }), "{unknown:?}");
    assert_eq!(held().await, before, "nothing admitted");

    // 5. /goal with no objective: a 500 of what it does, and nothing admitted.
    let goal = server.command(&session, &MessageId::new(), "goal", "").unwrap().await;
    println!("probe: 5 /goal with no text: {goal:?}");
    assert!(matches!(goal, CommandAnswer::Refused { code: 500, .. }), "{goal:?}");
    assert_eq!(held().await, before, "nothing admitted");

    // 2. probe61: done, its message admitted under 2.x's own ID, newer than Core's, and run.
    let kept = MessageId::new();
    let asked = Instant::now();
    let done = server.command(&session, &kept, "probe61", "x y").unwrap().await;
    println!("probe: 2 probe61 answered {done:?} after {:?}", asked.elapsed());
    assert_eq!(done, CommandAnswer::Done);
    let run = one_run(&mut events, &session).await;
    println!("probe: 2 its run {:?}", types(&run));
    let admitted = run.iter().find(|e| e["type"] == "session.inbox.enqueued").expect("its message admitted");
    println!("probe: 2 admitted {}", admitted["data"]);
    let native = admitted["data"]["inboxID"].as_str().unwrap();
    assert_eq!(admitted["data"]["item"]["type"], "user", "a user's message");
    assert!(native > kept.as_str(), "2.x's own ID, newer than Core's: {native} vs {}", kept.as_str());
    assert!(admitted["data"]["item"]["payload"].to_string().contains("probe-61 command x y"), "the template, expanded");
    assert_eq!(run.last().unwrap()["type"], "session.execution.succeeded");
    assert!(models_after(&log, 0, "probe-61 command x y").iter().any(|(m, has)| *has && m == "fake"), "the stub saw it, on the session's model");

    // 6. probe61s: a sub-agent's command.
    let children = server.children(&session).await.unwrap().len();
    let before = held().await;
    let asked = Instant::now();
    let sub = server.command(&session, &MessageId::new(), "probe61s", "w").unwrap().await;
    println!("probe: 6 probe61s answered {sub:?} after {:?}", asked.elapsed());
    assert_eq!(sub, CommandAnswer::Done);
    let made = server.children(&session).await.unwrap();
    println!("probe: 6 sub-agent sessions {}", made.len());
    assert_eq!(made.len(), children + 1, "a session made for it before the answer");
    assert_eq!(held().await, before, "nothing admitted in the session at the answer");
    let (seen, back) = until_kind(&mut events, &session, &["session.execution.started"], 90).await;
    println!("probe: 6 a run of 2.x's own started {back} after {:?}; seen {:?}", asked.elapsed(), types(&seen));
    if let Some(item) = seen.iter().find(|e| e["type"] == "session.inbox.enqueued") {
        println!("probe: 6 what came back {}", item["data"]);
        assert_eq!(item["data"]["item"]["type"], "synthetic", "the sub-agent's result comes back as a synthetic message");
    }
    if back {
        let run = one_run(&mut events, &session).await;
        println!("probe: 6 that run {:?}, ended after {:?}", types(&run), asked.elapsed());
    }
    // As 2.x stores the result, and as Core's whole read takes it: never a command's input.
    let messages = server.messages(&session).await.unwrap();
    let stored = messages.as_array().unwrap().iter().filter(|m| m["type"] == "synthetic").cloned().collect::<Vec<_>>();
    println!("probe: 6 the stored synthetic messages {stored:?}");
    assert!(stored.iter().any(|m| m["metadata"]["source"] == "subagent"), "the result is stored with its source");
    let read = read_messages(&messages);
    assert!(read.messages.iter().any(|m| m["info"][yuzuno_workspace::opencode_v2::SUB_AGENTS_RESULT] == true), "read as a sub-agent's result");

    server.shutdown().await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
}

/// A real OpenCode 2.x runs Yuzuno's commands through the Workspace (T-61
/// slice 3, D-2 (c)), against the stub provider: a command's Turn follows
/// the message 2.x admitted for it and completes with the stub's answer; a
/// command's own model is the session's for it, and Core makes the Agent's
/// chosen one the session's again before the next message; a sub-agent's
/// command ends its Turn at 2.x's answer, saying so, and what 2.x runs of it
/// later makes no Turn; `/goal` is refused before anything is sent (D-16).
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_runs_yuzunos_commands_through_the_workspace() {
    use yuzuno_workspace::{model::{AgentDetail, MessageInput}, workspace::Workspace};
    const ID: &str = "probe61commands";
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let work = work.canonicalize().unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    std::fs::write(work.join("opencode.json"), commands_config(port)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mcp_port = listener.local_addr().unwrap().port();
    ws.start_collaboration(mcp_port);
    let app = yuzuno_workspace::collaboration_mcp::router(ws.clone(), mcp_port);
    let endpoint = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let agent: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":ID, "name":"OpenCode", "cwd":work, "model":"stub/fake", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    let send = |client: &str, text: &str| {
        let (ws, input) = (ws.clone(), serde_json::from_value::<MessageInput>(json!({"clientMessageId":client,"text":text})).unwrap());
        async move { ws.send_message(ID, input).await }
    };
    let ended = |turn: String| {
        let ws = ws.clone();
        async move {
            for _ in 0..600 {
                let d = ws.store.detail(ID).unwrap();
                if let Some(t) = d.turns.iter().find(|t| t["id"] == turn.as_str()).filter(|t| t["status"] != "inProgress") {
                    return t.clone();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("the turn did not end within 60 s");
        }
    };
    let requests = || std::fs::read_to_string(&log).unwrap_or_default().lines().count();
    let d = ws.reconnect(ID).await.unwrap();
    assert!(ws.collaboration_status(ID).await.unwrap().ready, "connected and ready: {}", d.agent.connection_state);
    let listed = ws.opencode_commands(ID).await.unwrap();
    let listed = serde_json::to_value(listed).unwrap();
    println!("probe: the menu's commands {}", listed["commands"].as_array().unwrap().iter().map(|c| c["name"].clone()).collect::<Vec<_>>().len());
    assert!(listed["commands"].as_array().unwrap().iter().all(|c| c["name"] != "goal"), "goal is not offered");

    // 2. /probe61: the Turn follows 2.x's message and completes with the stub's answer.
    let seen = requests();
    let first = send("c1", "/probe61 x y").await.expect("sent").turn_id.unwrap();
    let t = ended(first.clone()).await;
    println!("probe: 2 the command's Turn {} {}", t["status"], t["_opencodeCommand"]);
    assert_eq!(t["status"], "completed");
    let native = t["_opencodeCommand"]["native"].as_str().expect("followed 2.x's message");
    assert!(native > first.as_str(), "2.x's own ID, newer than the Turn's: {native}");
    assert!(t["items"].as_array().unwrap().iter().any(|i| i["type"] == "agentMessage" && i["text"] == "Seen."), "the stub's answer: {t:#}");
    assert!(models_after(&log, seen, "probe-61 command x y").iter().any(|(m, has)| *has && m == "fake"), "on the Agent's model");

    // 3. /probe61m: its own model for it; the next message goes on the Agent's again.
    let seen = requests();
    let own = send("c2", "/probe61m z").await.expect("sent").turn_id.unwrap();
    assert_eq!(ended(own).await["status"], "completed");
    let models = models_after(&log, seen, "probe-61 command z");
    println!("probe: 3 the command's requests {models:?}");
    assert!(models.iter().any(|(m, has)| *has && m == "fake2"), "the command's own model");
    let seen = requests();
    let next = send("c3", "hello").await.expect("sent").turn_id.unwrap();
    assert_eq!(ended(next).await["status"], "completed");
    let models = models_after(&log, seen, "hello");
    println!("probe: 3 the next message's requests {models:?}");
    assert!(models.iter().all(|(m, _)| m == "fake") && !models.is_empty(), "the Agent's model again");

    // 6. /probe61s: ended at 2.x's answer, saying so; what 2.x runs of it later makes no Turn.
    let asked = Instant::now();
    let sub = send("c4", "/probe61s w").await.expect("sent").turn_id.unwrap();
    let t = ended(sub.clone()).await;
    println!("probe: 6 the sub-agent command's Turn {} after {:?}: {}", t["status"], asked.elapsed(), t["notice"]);
    assert_eq!(t["status"], "completed");
    assert_eq!(t["notice"]["kind"], "command_subagent", "{t:#}");
    let turns = ws.store.detail(ID).unwrap().turns.len();
    let mut came = false;
    for _ in 0..900 {
        came = models_after(&log, 0, "<subagent").iter().any(|(_, has)| *has);
        if came {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!("probe: 6 2.x gave the sub-agent's result to the session {came} after {:?}", asked.elapsed());
    tokio::time::sleep(Duration::from_secs(3)).await;
    let d = ws.store.detail(ID).unwrap();
    println!("probe: 6 then: {} Turns, the Agent {}", d.turns.len(), d.agent.status);
    assert_eq!(d.turns.len(), turns, "no Turn of Yuzuno's for what 2.x ran on its own");

    // 8. /goal: refused before anything is sent (D-16).
    let seen = requests();
    let refused = send("c5", "/goal ship it").await.expect_err("refused").to_string();
    println!("probe: 8 /goal: {refused}");
    assert!(refused.contains("会在之后自行开始新的工作"));
    assert_eq!(requests(), seen, "nothing reached the model");

    ws.close_agent(ID).await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
    endpoint.abort();
}

/// What Core's translator made of `id`'s compaction from `live` events: each
/// `opencode.compaction` of it, in order.
fn compacted(live: &[Value], id: &MessageId) -> Vec<Value> {
    live.iter().filter(|e| e["type"] == COMPACTION && e["data"]["id"] == id.as_str()).map(|e| e["data"].clone()).collect()
}

/// Whether a stub request after the first `seen` was 2.x's summary prompt.
fn summary_asked(log: &Path, seen: usize) -> bool {
    std::fs::read_to_string(log).unwrap_or_default().lines().skip(seen)
        .any(|l| l.contains("You MUST summarize the conversation above"))
}

/// A real OpenCode 2.x compacts as Core's transport and translator read it
/// (T-61 slice 4), against the stub provider. A compaction asked under
/// Core's ID is admitted under it. With nothing to compact yet it fails in
/// 2.x's words (`compaction.unavailable`), though its run succeeds. After a
/// prompt it runs, its summary the stub's answer to 2.x's summary prompt,
/// and ends. Each is stored under that ID as Core's whole read takes it, and
/// read live as Core's own `opencode.compaction`. Events printed.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_compacts_under_cores_id_as_cores_transport_reads_it() {
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    // The stub's provider, as slice 3's probes configure it (its commands unused here).
    std::fs::write(directory.join("opencode.json"), commands_config(port)).unwrap();
    let launch = Launch::new(program, directory.canonicalize().unwrap(), &root, dir.path().join("cache"));
    let server = Server::start(&launch).await.unwrap();
    println!("probe: ready; /api/info says version {}", server.version());
    let model = server.models().await.unwrap().into_iter().find(|m| m.id() == "stub/fake").expect("the stub's model is listed");
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    server.switch_model(&session, &model, None).await.unwrap();
    let mut cursor = Cursor::default();
    let requests = || std::fs::read_to_string(&log).unwrap_or_default().lines().count();

    // 1. Nothing to compact yet: admitted, then failed in 2.x's words; its run succeeds.
    let empty = MessageId::new();
    let seen = requests();
    let admitted = server.compact(&session, &empty).await.unwrap();
    println!("probe: 1 an empty session's compaction: {admitted:?}");
    assert_eq!(admitted, CompactAdmission::Admitted, "admitted under Core's ID");
    let (run, ended) = until_kind(&mut events, &session, &ENDS, 60).await;
    println!("probe: 1 its events {:?} (ended {ended})", types(&run));
    for e in run.iter().filter(|e| e["type"].as_str().is_some_and(|t| t.starts_with("session.compaction.") || t.starts_with("session.inbox."))) {
        println!("probe: 1 {} {}", e["type"], e["data"]);
    }
    assert!(ended, "its run ended");
    assert_eq!(run.last().unwrap()["type"], "session.execution.succeeded", "its run succeeded");
    let live: Vec<Value> = run.iter().flat_map(|e| cursor.read(e)).collect();
    let read = compacted(&live, &empty);
    println!("probe: 1 read live {read:?}");
    let last = read.last().expect("read live as Core's own compaction event");
    assert_eq!((&last["status"], &last["error"]["type"]), (&json!("failed"), &json!("compaction.unavailable")), "{last}");
    println!("probe: 1 its words {}", last["error"]["message"]);
    let stored = read_messages(&server.messages(&session).await.unwrap()).compactions;
    println!("probe: 1 stored {stored:?}");
    let mine = stored.iter().find(|m| m["id"] == empty.as_str()).expect("stored under Core's ID");
    assert_eq!((&mine["status"], &mine["error"]["type"]), (&json!("failed"), &json!("compaction.unavailable")), "{mine}");
    assert!(!summary_asked(&log, seen), "nothing was asked of the model");

    // 2. A prompt, so there is something to compact.
    assert_eq!(server.submit(&session, &MessageId::new(), "probe-61 compact one").await.unwrap(), Submission::Accepted);
    let run = one_run(&mut events, &session).await;
    assert_eq!(run.last().unwrap()["type"], "session.execution.succeeded");
    run.iter().for_each(|e| { cursor.read(e); });

    // 3. The compaction: admitted, run against the stub's summary, ended, stored.
    let asked = MessageId::new();
    let seen = requests();
    let started = Instant::now();
    let admitted = server.compact(&session, &asked).await.unwrap();
    println!("probe: 3 the compaction: {admitted:?} after {:?}", started.elapsed());
    assert_eq!(admitted, CompactAdmission::Admitted, "admitted under Core's ID");
    let (run, ended) = until_kind(&mut events, &session, &ENDS, 90).await;
    println!("probe: 3 its events {:?} (ended {ended} after {:?})", types(&run), started.elapsed());
    for e in run.iter().filter(|e| e["type"].as_str().is_some_and(|t| t.starts_with("session.compaction.") && t != "session.compaction.delta"
        || t.starts_with("session.inbox."))) {
        println!("probe: 3 {} {}", e["type"], e["data"]);
    }
    assert!(ended, "its run ended");
    assert_eq!(run.last().unwrap()["type"], "session.execution.succeeded", "its run succeeded");
    let begun = run.iter().find(|e| e["type"] == "session.compaction.started").expect("it started");
    assert_eq!(begun["data"]["inputID"], asked.as_str(), "started under Core's ID");
    assert!(summary_asked(&log, seen), "2.x asked the stub for its summary");
    let live: Vec<Value> = run.iter().flat_map(|e| cursor.read(e)).collect();
    let read = compacted(&live, &asked);
    println!("probe: 3 read live {:?}", read.iter().map(|c| c["status"].clone()).collect::<Vec<_>>());
    assert_eq!(read.first().map(|c| c["status"].clone()), Some(json!("running")), "read running first");
    let last = read.last().unwrap();
    assert_eq!(last["status"], "completed", "{last}");
    assert!(last["summary"].as_str().unwrap_or_default().contains("probe-61 compaction summary"), "its summary, live: {last}");
    let stored = read_messages(&server.messages(&session).await.unwrap()).compactions;
    let mine = stored.iter().find(|m| m["id"] == asked.as_str()).expect("stored under Core's ID");
    println!("probe: 3 stored {mine}");
    assert_eq!(mine["status"], "completed");
    assert!(mine["summary"].as_str().unwrap_or_default().contains("probe-61 compaction summary"), "its summary, stored: {mine}");

    // 4. The next prompt runs after it.
    let seen = requests();
    assert_eq!(server.submit(&session, &MessageId::new(), "probe-61 after").await.unwrap(), Submission::Accepted);
    let run = one_run(&mut events, &session).await;
    assert_eq!(run.last().unwrap()["type"], "session.execution.succeeded");
    let carried = std::fs::read_to_string(&log).unwrap_or_default().lines().skip(seen).any(|l| l.contains("probe-61 compaction summary"));
    println!("probe: 4 the next prompt's requests carry the summary: {carried}");

    server.shutdown().await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
}

/// A real OpenCode 2.x compacts through the Workspace (T-61 slice 4, D-2
/// (c)), against the stub provider: with nothing to compact yet, the
/// `/compact` Turn fails in 2.x's words; after a message it completes, its
/// compaction item's text the stub's summary, and its input makes no Turn
/// of its own; the next message goes.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, and no network"]
async fn a_real_opencode_2x_compacts_through_the_workspace() {
    use yuzuno_workspace::{model::{AgentDetail, MessageInput}, workspace::Workspace};
    const ID: &str = "probe61compact";
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let work = work.canonicalize().unwrap();
    let (mut stub, port, _log) = stub_provider(dir.path());
    std::fs::write(work.join("opencode.json"), commands_config(port)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mcp_port = listener.local_addr().unwrap().port();
    ws.start_collaboration(mcp_port);
    let app = yuzuno_workspace::collaboration_mcp::router(ws.clone(), mcp_port);
    let endpoint = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let agent: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":ID, "name":"OpenCode", "cwd":work, "model":"stub/fake", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    let send = |client: &str, text: &str| {
        let (ws, input) = (ws.clone(), serde_json::from_value::<MessageInput>(json!({"clientMessageId":client,"text":text})).unwrap());
        async move { ws.send_message(ID, input).await }
    };
    let ended = |turn: String| {
        let ws = ws.clone();
        async move {
            for _ in 0..900 {
                let d = ws.store.detail(ID).unwrap();
                if let Some(t) = d.turns.iter().find(|t| t["id"] == turn.as_str()).filter(|t| t["status"] != "inProgress") {
                    return t.clone();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("the turn did not end within 90 s");
        }
    };
    let d = ws.reconnect(ID).await.unwrap();
    assert!(ws.collaboration_status(ID).await.unwrap().ready, "connected and ready: {}", d.agent.connection_state);

    // 1. Nothing to compact yet: the Turn fails in 2.x's words.
    let answer = ws.opencode_compact(ID).await.expect("admitted");
    let t = ended(answer["turnId"].as_str().unwrap().to_owned()).await;
    println!("probe: 1 the empty session's /compact Turn {} {} {}", t["status"], t["error"], t["_opencodeCompact"]);
    assert_eq!((&t["status"], &t["_opencodeCompact"]["state"]), (&json!("failed"), &json!("failed")), "{t:#}");
    assert!(t["error"]["message"].as_str().unwrap_or_default().contains("Nothing to compact yet"), "in 2.x's words: {t:#}");

    // 2. A message, then /compact: completed, with the stub's summary.
    let first = send("c1", "probe-61 compact one").await.expect("sent").turn_id.unwrap();
    assert_eq!(ended(first).await["status"], "completed");
    let started = Instant::now();
    let answer = ws.opencode_compact(ID).await.expect("admitted");
    let t = ended(answer["turnId"].as_str().unwrap().to_owned()).await;
    println!("probe: 2 the /compact Turn {} after {:?}: {}", t["status"], started.elapsed(), t["_opencodeCompact"]);
    assert_eq!((&t["status"], &t["_opencodeCompact"]["state"]), (&json!("completed"), &json!("completed")), "{t:#}");
    let item = t["items"].as_array().unwrap().iter().find(|i| i["type"] == "contextCompaction").expect("its compaction item");
    assert!(item["text"].as_str().unwrap_or_default().contains("probe-61 compaction summary"), "the stub's summary: {item}");
    let d = ws.store.detail(ID).unwrap();
    println!("probe: 2 Turns {:?}", d.turns.iter().map(|t| (t["id"].clone(), t["status"].clone())).collect::<Vec<_>>());
    assert_eq!(d.turns.len(), 3, "its input made no Turn of its own");

    // 3. The next message goes.
    let next = send("c2", "probe-61 after").await.expect("the next message goes").turn_id.unwrap();
    assert_eq!(ended(next).await["status"], "completed");

    ws.close_agent(ID).await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
    endpoint.abort();
}

/// A Git repository for the Rewind probes (T-61 slice 5): `repo/work` (the
/// Agent's folder) holds `a.txt` = "one", `repo/sibling.txt` is in the
/// worktree but outside the folder, `outside/x.txt` outside the repository,
/// all committed by a synthetic author; and the stub's provider configured in
/// the folder, every permission allowed so that `write` asks nothing. The
/// folder and the repository, resolved.
fn rewind_repo(dir: &Path, port: u16) -> (PathBuf, PathBuf) {
    let (repo, outside) = (dir.join("repo"), dir.join("outside"));
    std::fs::create_dir_all(repo.join("work")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(repo.join("work/a.txt"), "one\n").unwrap();
    std::fs::write(repo.join("sibling.txt"), "sib\n").unwrap();
    std::fs::write(outside.join("x.txt"), "x\n").unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").current_dir(&repo).args(["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid"])
            .args(args).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "probe"]);
    let mut config: Value = serde_json::from_str(&commands_config(port)).unwrap();
    config["permissions"] = json!([{"action": "*", "resource": "*", "effect": "allow"}]);
    std::fs::write(repo.join("work/opencode.json"), config.to_string()).unwrap();
    (repo.join("work").canonicalize().unwrap(), repo.canonicalize().unwrap())
}

/// The sha256 of a file's bytes, as Core's revert check states it.
fn file_state(bytes: &[u8]) -> yuzuno_workspace::opencode_revert_files::State {
    use sha2::Digest;
    yuzuno_workspace::opencode_revert_files::State::File {
        size: bytes.len() as u64, sha256: sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect(), executable: false,
    }
}

/// A real OpenCode 2.x keeps each step's snapshot where Core's Rewind reads
/// it (T-61 slice 5, D-23 (a)), against the stub provider. A Turn that
/// writes two files of the folder and one outside it: each of its steps has
/// `snapshot.start` and `end`, and its files are the folder's two, relative
/// to the Git top level, never the one outside. The store is in the data
/// folder Core gives it, by 2.x's location's project and the SHA-1 of the
/// resolved top level, its `alternates` naming the repository's objects.
/// From there Core's own check reads each file as the Turn found it, and
/// writes nothing.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, git, and no network"]
async fn a_real_opencode_2x_keeps_each_steps_snapshot_where_cores_rewind_reads_it() {
    use yuzuno_workspace::opencode_revert_files::{self as files, Root, State, BOUNDS};
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("db");
    std::fs::create_dir(&root).unwrap();
    let (mut stub, port, _log) = stub_provider(dir.path());
    let (folder, repo) = rewind_repo(dir.path(), port);
    let launch = Launch::new(program, folder.clone(), &root, dir.path().join("cache"));
    let server = Server::start(&launch).await.unwrap();
    println!("probe: ready; /api/info says version {}", server.version());
    let model = server.models().await.unwrap().into_iter().find(|m| m.id() == "stub/fake").expect("the stub's model is listed");
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    server.switch_model(&session, &model, None).await.unwrap();

    let (turn_a, turn_b) = (MessageId::new(), MessageId::new());
    for (turn, prompt) in [(&turn_a, "probe-61 write"), (&turn_b, "probe-61 three")] {
        assert_eq!(server.submit(&session, turn, prompt).await.unwrap(), Submission::Accepted);
        let run = one_run(&mut events, &session).await;
        println!("probe: {prompt}: its run {:?}", types(&run));
        assert_eq!(run.last().unwrap()["type"], "session.execution.succeeded", "{prompt}");
    }
    let read = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
    assert_eq!((read("repo/work/a.txt"), read("repo/work/new.txt"), read("repo/sibling.txt")),
        ("three\n".into(), "new\n".into(), "changed".into()), "the tools ran");

    // 1. Each step's snapshot.
    let messages = server.messages(&session).await.unwrap();
    let list = messages.as_array().unwrap();
    for m in list.iter().filter(|m| m["type"] == "assistant") {
        println!("probe: 1 step {} snapshot {}", m["id"], m["snapshot"]);
        assert!(m["snapshot"]["start"].is_string() && m["snapshot"]["end"].is_string(), "each step's start and end: {m}");
    }
    let from = list.iter().position(|m| m["id"] == turn_a.as_str()).expect("turn A's message");
    let until = list.iter().position(|m| m["id"] == turn_b.as_str()).expect("turn B's message");
    let mut changed: Vec<String> = list[from..until].iter().filter(|m| m["type"] == "assistant")
        .flat_map(|m| m["snapshot"]["files"].as_array().cloned().unwrap_or_default()).filter_map(|f| f.as_str().map(str::to_owned)).collect();
    changed.sort();
    changed.dedup();
    assert_eq!(changed, ["work/a.txt", "work/new.txt"], "the folder's files, relative to the top level, not sibling.txt");

    // 2. Where the store is, and what Core's check reads from it.
    let location = server.location(folder.to_str().unwrap()).await.unwrap();
    println!("probe: 2 location {location}");
    let info = server.session(&session).await.unwrap();
    let project = location["project"]["id"].as_str().unwrap().to_owned();
    assert_eq!(info["projectID"], project.as_str(), "the session's project is the location's");
    let toplevel = PathBuf::from(location["project"]["directory"].as_str().unwrap()).canonicalize().unwrap();
    assert_eq!(toplevel, repo, "the project's directory is the Git top level");
    assert_eq!(PathBuf::from(location["directory"].as_str().unwrap()).canonicalize().unwrap(), folder, "the folder, resolved");
    let data = launch.data.join("opencode");
    let store = files::store(data.to_str().unwrap(), &project, repo.to_str().unwrap()).unwrap();
    println!("probe: 2 store {}", store.display());
    assert!(store.join("HEAD").is_file(), "the store, in the data folder Core gave it: {}", store.display());
    let alternates = std::fs::read_to_string(store.join("objects/info/alternates")).unwrap_or_default();
    println!("probe: 2 alternates {alternates:?}");
    assert!(alternates.lines().any(|l| Path::new(l.trim()) == repo.join(".git/objects")), "the repository's objects: {alternates:?}");
    let targets = files::targets_v2(list, turn_a.as_str(), repo.to_str().unwrap(), folder.to_str().unwrap()).unwrap();
    println!("probe: 2 targets {targets:?}");
    let root_of = folder.clone();
    let at = tokio::task::spawn_blocking(move || Root::of(&root_of)).await.unwrap().unwrap();
    let (entries, _) = files::plan(&store, &repo, &[], &targets, &folder, at, BOUNDS).await.unwrap();
    let seen: Vec<(String, State, State)> = entries.into_iter().map(|e| (e.target.rel, e.expected, e.current)).collect();
    assert_eq!(seen, vec![
        ("work/a.txt".to_owned(), file_state(b"one\n"), file_state(b"three\n")),
        ("work/new.txt".to_owned(), State::Absent, file_state(b"new\n")),
    ], "each file as the Turn found it, and as it is now");
    assert_eq!((read("repo/work/a.txt"), read("repo/work/new.txt"), read("repo/sibling.txt"), read("outside/x.txt")),
        ("three\n".into(), "new\n".into(), "changed".into(), "x\n".into()), "nothing written");

    server.shutdown().await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
}

/// The sha256 of every file under `dir` but those under `skip`, by path:
/// what a revert must leave as it was.
fn hashes(dir: &Path, skip: &[&Path]) -> std::collections::BTreeMap<PathBuf, String> {
    use sha2::Digest;
    let mut out = std::collections::BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(at) = stack.pop() {
        for entry in std::fs::read_dir(&at).unwrap() {
            let path = entry.unwrap().path();
            if skip.iter().any(|s| path.starts_with(s)) {
                continue;
            }
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let sum = sha2::Sha256::digest(std::fs::read(&path).unwrap()).iter().map(|b| format!("{b:02x}")).collect();
                out.insert(path, sum);
            }
        }
    }
    out
}

/// One prompt of the stub's, under a new ID, run to its end: the ID, and
/// the run's events.
async fn prompt_run(server: &Server, events: &mut Events, session: &str, prompt: &str) -> (MessageId, Vec<Value>) {
    let turn = MessageId::new();
    assert_eq!(server.submit(session, &turn, prompt).await.unwrap(), Submission::Accepted);
    let run = one_run(events, session).await;
    println!("probe: {prompt}: its run {:?}", types(&run));
    assert_eq!(run.last().unwrap()["type"], "session.execution.succeeded", "{prompt}");
    (turn, run)
}

/// A real OpenCode 2.x stages, commits and refuses a revert as Core's
/// transport reads them (T-61 slice 6, D-24, D-26 (a), D-27 (a)), against
/// the stub provider.
/// - Refused before anything changes, and read as refused: a message the
///   session does not hold (404), and a running session (409).
/// - A stage sends back each file of the folder's later steps, nothing
///   else, keeps the revert, and keeps the messages; its answer lists what
///   changed.
/// - Its commit deletes the messages from the Turn on, touching no file,
///   and its `session.revert.committed` is read as Core's own
///   `opencode.reverted`.
/// - A prompt, and a compaction, commit a held revert before they are
///   admitted.
/// - A restore that fails part way (a folder it cannot remove from)
///   answers 500, read as unknown: no revert kept, the file checked out
///   first already back.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, git, and no network"]
async fn a_real_opencode_2x_stages_and_commits_a_revert_as_cores_transport_reads_them() {
    use std::os::unix::fs::PermissionsExt;
    use yuzuno_workspace::opencode::RevertAnswer;
    use yuzuno_workspace::opencode_v2::REVERTED;
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("db");
    std::fs::create_dir(&root).unwrap();
    let (mut stub, port, _log) = stub_provider(dir.path());
    let (folder, repo) = rewind_repo(dir.path(), port);
    let launch = Launch::new(program, folder.clone(), &root, dir.path().join("cache"));
    let server = Server::start(&launch).await.unwrap();
    println!("probe: ready; /api/info says version {}", server.version());
    let model = server.models().await.unwrap().into_iter().find(|m| m.id() == "stub/fake").expect("the stub's model is listed");
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let session = server.create_session("probe").await.unwrap()["id"].as_str().unwrap().to_owned();
    server.switch_model(&session, &model, None).await.unwrap();
    let (turn_a, _) = prompt_run(&server, &mut events, &session, "probe-61 write").await;
    let (turn_b, _) = prompt_run(&server, &mut events, &session, "probe-61 three").await;
    let read = |rel: &str| std::fs::read_to_string(dir.path().join(rel)).ok();
    let some = |text: &str| Some(text.to_owned());
    // Every file outside the Agent's folder (the repository's own Git folder aside, which Git may refresh).
    let (outside, git) = (dir.path().join("outside"), repo.join(".git"));
    let others = || {
        let mut all = hashes(&repo, &[&folder, &git]);
        all.extend(hashes(&outside, &[]));
        all
    };
    let before = others();
    let ids = |list: &Value| list.as_array().unwrap().iter().filter_map(|m| m["id"].as_str().map(str::to_owned)).collect::<Vec<_>>();

    // 6. Refused before anything changes: a message the session does not hold, and a running session.
    let unknown = MessageId::new();
    let answer = server.stage(&session, unknown.as_str()).unwrap().await;
    println!("probe: 6 an unknown message: {answer:?}");
    assert!(matches!(&answer, RevertAnswer::Refused(s) if s.code == 404), "read as refused: {answer:?}");
    let busy = server.create_session("probe-busy").await.unwrap()["id"].as_str().unwrap().to_owned();
    server.switch_model(&busy, &model, None).await.unwrap();
    let slow = MessageId::new();
    assert_eq!(server.submit(&busy, &slow, "probe-4a slow").await.unwrap(), Submission::Accepted);
    let (seen, started) = until_kind(&mut events, &busy, &["session.execution.started"], 30).await;
    assert!(started, "its run started: {:?}", types(&seen));
    let answer = server.stage(&busy, slow.as_str()).unwrap().await;
    println!("probe: 6 a running session: {answer:?}");
    assert!(matches!(&answer, RevertAnswer::Refused(s) if s.code == 409), "read as refused: {answer:?}");
    server.abort(&busy).await.unwrap();
    let (seen, ended) = until_kind(&mut events, &busy, &ENDS, 30).await;
    assert!(ended, "the slow run ended: {:?}", types(&seen));
    assert_eq!((read("repo/work/a.txt"), read("repo/work/new.txt")), (some("three\n"), some("new\n")), "nothing sent back by a refusal");

    // 3. Staged to Turn A: the folder's files back as A found them, nothing else, the messages kept.
    let answer = server.stage(&session, turn_a.as_str()).unwrap().await;
    println!("probe: 3 staged: {answer:?}");
    let RevertAnswer::Answered(staged) = answer else { panic!("answered: {answer:?}") };
    assert_eq!(staged["revert"]["messageID"], turn_a.as_str(), "the session holds the revert to A: {staged}");
    let mut changed: Vec<(String, String)> = staged["revert"]["files"].as_array().unwrap().iter()
        .map(|f| (f["file"].as_str().unwrap_or_default().to_owned(), f["status"].as_str().unwrap_or_default().to_owned())).collect();
    changed.sort();
    assert_eq!(changed, [("work/a.txt".to_owned(), "modified".to_owned()), ("work/new.txt".to_owned(), "deleted".to_owned())], "{staged}");
    assert_eq!((read("repo/work/a.txt"), read("repo/work/new.txt")), (some("one\n"), None), "sent back");
    assert_eq!(others(), before, "nothing outside the folder changed (sibling.txt stays as A's shell left it)");
    assert_eq!(server.session(&session).await.unwrap()["revert"]["messageID"], turn_a.as_str(), "kept in the session");
    let listed = ids(&server.messages(&session).await.unwrap());
    assert!(listed.contains(&turn_a.as_str().to_owned()) && listed.contains(&turn_b.as_str().to_owned()), "the messages stay: {listed:?}");

    // 4. Committed: the messages from A on are deleted, no file is touched, and Core reads its event as its own.
    server.commit(&session).await.unwrap();
    let (seen, committed) = until_kind(&mut events, &session, &["session.revert.committed"], 10).await;
    let event = seen.last().unwrap();
    println!("probe: 4 {} {}", event["type"], event["data"]);
    assert!(committed, "{:?}", types(&seen));
    assert_eq!((&event["data"]["sessionID"], &event["data"]["to"]), (&json!(session), &json!(turn_a.as_str())), "{event}");
    let read_as = Cursor::default().read(event);
    println!("probe: 4 read as {read_as:?}");
    assert!(read_as.iter().any(|e| e["type"] == REVERTED && e["data"]["to"] == turn_a.as_str()), "read as Core's own: {read_as:?}");
    let listed = ids(&server.messages(&session).await.unwrap());
    println!("probe: 4 left {listed:?}");
    assert!(!listed.contains(&turn_a.as_str().to_owned()) && !listed.contains(&turn_b.as_str().to_owned()), "deleted: {listed:?}");
    assert!(server.session(&session).await.unwrap()["revert"].is_null(), "no revert held");
    assert_eq!((read("repo/work/a.txt"), read("repo/work/new.txt")), (some("one\n"), None), "the commit touches no file");

    // 7. A prompt while a revert is held commits it before it is admitted.
    let (turn_c, _) = prompt_run(&server, &mut events, &session, "probe-61 three").await;
    let RevertAnswer::Answered(_) = server.stage(&session, turn_c.as_str()).unwrap().await else { panic!("staged to C") };
    assert_eq!(read("repo/work/a.txt"), some("one\n"));
    let (turn_d, run) = prompt_run(&server, &mut events, &session, "probe-61 three").await;
    let kinds = types(&run);
    let committed = kinds.iter().position(|t| t == "session.revert.committed").expect("committed by the prompt");
    let enqueued = kinds.iter().position(|t| t == "session.inbox.enqueued").expect("the prompt admitted");
    println!("probe: 7 committed at {committed}, admitted at {enqueued}");
    assert!(committed < enqueued, "committed before admitted: {kinds:?}");
    let listed = ids(&server.messages(&session).await.unwrap());
    assert!(!listed.contains(&turn_c.as_str().to_owned()) && listed.contains(&turn_d.as_str().to_owned()), "{listed:?}");

    // 10. A compaction while a revert is held commits it before it is admitted.
    let RevertAnswer::Answered(_) = server.stage(&session, turn_d.as_str()).unwrap().await else { panic!("staged to D") };
    let compaction = MessageId::new();
    assert_eq!(server.compact(&session, &compaction).await.unwrap(), CompactAdmission::Admitted);
    let (run, ended) = until_kind(&mut events, &session, &ENDS, 60).await;
    let kinds = types(&run);
    println!("probe: 10 {kinds:?}");
    assert!(ended, "its run ended");
    let committed = kinds.iter().position(|t| t == "session.revert.committed").expect("committed by the compaction");
    let enqueued = kinds.iter().position(|t| t == "session.inbox.enqueued").expect("the compaction admitted");
    assert!(committed < enqueued, "committed before admitted: {kinds:?}");
    assert!(!ids(&server.messages(&session).await.unwrap()).contains(&turn_d.as_str().to_owned()), "D's message deleted");

    // 8. A restore that fails part way: sub/ can't be removed from, so a.txt goes back and sub/b.txt stays.
    std::fs::create_dir(folder.join("sub")).unwrap();
    let (turn_e, _) = prompt_run(&server, &mut events, &session, "probe-61 nested").await;
    assert_eq!((read("repo/work/a.txt"), read("repo/work/sub/b.txt")), (some("four\n"), some("b\n")));
    std::fs::set_permissions(folder.join("sub"), std::fs::Permissions::from_mode(0o555)).unwrap();
    let answer = server.stage(&session, turn_e.as_str()).unwrap().await;
    std::fs::set_permissions(folder.join("sub"), std::fs::Permissions::from_mode(0o755)).unwrap();
    println!("probe: 8 a restore that fails part way: {answer:?}");
    assert!(matches!(&answer, RevertAnswer::Unknown(why) if why.contains("500")), "read as unknown: {answer:?}");
    assert!(server.session(&session).await.unwrap()["revert"].is_null(), "no revert kept");
    assert_eq!((read("repo/work/a.txt"), read("repo/work/sub/b.txt")), (some("one\n"), some("b\n")),
        "a.txt, checked out first, is back; sub/b.txt stays");
    assert!(ids(&server.messages(&session).await.unwrap()).contains(&turn_e.as_str().to_owned()), "E's message stays");

    server.shutdown().await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
}

/// A Rewind through the Workspace on a real OpenCode 2.x (T-61 slices 5
/// and 6, D-2 (c)), against the stub provider.
/// - Previewed: the files 2.x would send back, each as the Turn found it
///   and as it is now, and the Turns that leave; nothing written.
/// - Confirmed: each file back and checked, the Turns gone from the
///   record, their messages deleted from 2.x's session, nothing asked of
///   the model; the Agent goes on.
/// - A restore that fails part way: unknown, each file listed as it is now,
///   Core's backup named, the Agent held back while any file differs from
///   before, and free once all are as before again.
#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE, python3, git, and no network"]
async fn a_real_opencode_2x_rewind_is_confirmed_through_the_workspace() {
    use std::os::unix::fs::PermissionsExt;
    use yuzuno_workspace::{model::{AgentDetail, MessageInput}, workspace::Workspace};
    const ID: &str = "probe61rewind";
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
    let dir = tempfile::tempdir().unwrap();
    let (mut stub, port, log) = stub_provider(dir.path());
    let (folder, _repo) = rewind_repo(dir.path(), port);
    let ws = Workspace::new(dir.path().join("data"), folder.to_string_lossy().into(), "unused".into()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mcp_port = listener.local_addr().unwrap().port();
    ws.start_collaboration(mcp_port);
    let app = yuzuno_workspace::collaboration_mcp::router(ws.clone(), mcp_port);
    let endpoint = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let agent: AgentDetail = serde_json::from_value(json!({"agent": {
        "id":ID, "name":"OpenCode", "cwd":folder, "model":"stub/fake", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    let send = |client: &str, text: &str| {
        let (ws, input) = (ws.clone(), serde_json::from_value::<MessageInput>(json!({"clientMessageId":client,"text":text})).unwrap());
        async move { ws.send_message(ID, input).await }
    };
    let ended = |turn: String| {
        let ws = ws.clone();
        async move {
            for _ in 0..900 {
                let d = ws.store.detail(ID).unwrap();
                if d.agent.status == "idle" && d.turns.iter().any(|t| t["id"] == turn.as_str() && t["status"] != "inProgress") {
                    return d.turns.iter().find(|t| t["id"] == turn.as_str()).unwrap().clone();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("the turn did not end within 90 s");
        }
    };
    let turn_ids = || ws.store.detail(ID).unwrap().turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect::<Vec<_>>();
    let read = |rel: &str| std::fs::read_to_string(folder.join(rel)).ok();
    let some = |text: &str| Some(text.to_owned());
    ws.reconnect(ID).await.unwrap();
    let a = send("c1", "probe-61 write").await.expect("sent").turn_id.unwrap();
    assert_eq!(ended(a.clone()).await["status"], "completed");
    let b = send("c2", "probe-61 three").await.expect("sent").turn_id.unwrap();
    assert_eq!(ended(b.clone()).await["status"], "completed");
    let requests = std::fs::read_to_string(&log).unwrap_or_default().lines().count();

    // Previewed.
    let preview = ws.opencode_revert_preview(ID, &a).await.expect("a 2.x Rewind is previewed");
    println!("probe: the preview {preview}");
    let state = |s: yuzuno_workspace::opencode_revert_files::State| serde_json::to_value(s).unwrap();
    let path = |rel: &str| folder.join(rel).to_string_lossy().into_owned();
    assert_eq!(preview["files"], json!([
        {"path": path("a.txt"), "expected": state(file_state(b"one\n")), "current": state(file_state(b"three\n"))},
        {"path": path("new.txt"), "expected": state(yuzuno_workspace::opencode_revert_files::State::Absent), "current": state(file_state(b"new\n"))},
    ]), "the folder's files as the Turn found them and as they are: {preview}");
    assert_eq!(preview["removedTurns"], 2, "{preview}");
    assert_eq!((read("a.txt"), read("new.txt")), (some("three\n"), some("new\n")), "nothing written");

    // Confirmed.
    let outcome = ws.opencode_revert_confirm(ID, preview["previewId"].as_str().unwrap()).await.expect("confirmed");
    println!("probe: the confirm {outcome}");
    assert_eq!((&outcome["status"], &outcome["draft"]), (&json!("completed"), &json!("probe-61 write")), "{outcome}");
    assert_eq!(outcome["files"], json!([{"path": path("a.txt"), "outcome": "verified"}, {"path": path("new.txt"), "outcome": "verified"}]), "{outcome}");
    assert_eq!((read("a.txt"), read("new.txt")), (some("one\n"), None), "sent back");
    assert!(turn_ids().is_empty(), "the Turns leave the record: {:?}", turn_ids());
    assert!(ws.pending_rewind(ID).await.unwrap()["attempt"].is_null(), "none left to check");
    assert_eq!(std::fs::read_to_string(&log).unwrap_or_default().lines().count(), requests, "nothing asked of the model");

    // The Agent goes on, and 2.x has deleted the reverted messages: the model is sent none of them.
    std::fs::create_dir(folder.join("sub")).unwrap();
    let nested = send("c3", "probe-61 nested").await.expect("the Agent goes on").turn_id.unwrap();
    assert_eq!(ended(nested.clone()).await["status"], "completed");
    assert_eq!(turn_ids(), vec![nested.clone()]);
    let sent: Vec<String> = std::fs::read_to_string(&log).unwrap().lines().skip(requests)
        .map(|line| serde_json::from_str::<Value>(line).unwrap()["messages"].to_string()).collect();
    assert!(sent.iter().any(|m| m.contains("probe-61 nested")), "the next prompt was asked: {sent:?}");
    assert!(!sent.iter().any(|m| m.contains("probe-61 write") || m.contains("probe-61 three")), "no reverted message is sent: {sent:?}");

    // A restore that fails part way: sub/ can't be removed from.
    let preview = ws.opencode_revert_preview(ID, &nested).await.expect("previewed");
    let key = preview["previewId"].as_str().unwrap().to_owned();
    std::fs::set_permissions(folder.join("sub"), std::fs::Permissions::from_mode(0o555)).unwrap();
    let outcome = ws.opencode_revert_confirm(ID, &key).await;
    std::fs::set_permissions(folder.join("sub"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let outcome = outcome.expect("answered");
    println!("probe: a restore that fails part way {outcome}");
    assert_eq!(outcome["status"], "unknown", "{outcome}");
    assert_eq!(outcome["files"], json!([{"path": path("a.txt"), "outcome": "verified"}, {"path": path("sub/b.txt"), "outcome": "notRestored"}]),
        "a.txt back, sub/b.txt not: {outcome}");
    let backup = dir.path().join("data/opencode").join(ID).join("revert").join(&key);
    assert!(outcome["message"].as_str().unwrap().contains(&backup.display().to_string()), "Core's backup is named: {outcome}");
    assert!(ws.send_message(ID, serde_json::from_value(json!({"clientMessageId":"c4","text":"held"})).unwrap()).await.is_err(), "held back");
    let checked = ws.rewind_check(ID, &key).await.unwrap();
    println!("probe: checked {checked}");
    assert_eq!(checked["status"], "unknown", "a.txt differs from before: {checked}");
    std::fs::write(folder.join("a.txt"), std::fs::read(backup.join("0.bin")).unwrap()).unwrap();
    let checked = ws.rewind_check(ID, &key).await.unwrap();
    println!("probe: checked again {checked}");
    assert_eq!(checked["status"], "unchanged", "all as before: {checked}");
    assert_eq!(turn_ids(), vec![nested]);
    assert!(ws.pending_rewind(ID).await.unwrap()["attempt"].is_null(), "the Agent goes on");

    ws.close_agent(ID).await.unwrap();
    stub.kill().ok();
    stub.wait().ok();
    endpoint.abort();
}
