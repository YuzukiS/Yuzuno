//! The OpenCode transport (T-110 S1a) against a stand-in `opencode serve`
//! (tests/fixtures/opencode_server.py, run by /usr/bin/python3). No OpenCode,
//! account, model or network service is used, and no real configuration read.
#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use yuzuno_workspace::opencode::{
    session_of, CommandAnswer, CompactAdmission, Events, HttpStatus, Launch, Mcp, McpRefused, MessageId, Reply, RequestRefused, Server, Submission,
    EVENT_IDLE_LIMIT,
};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");

struct Lab {
    _dir: tempfile::TempDir,
    launch: Launch,
    /// The fixture's folder: OPENCODE_DB's, holding what it saw.
    root: PathBuf,
}

fn lab() -> Lab {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("opencode");
    std::fs::write(&program, format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n")).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let launch = Launch::new(program, directory, &root, dir.path().join("cache"));
    Lab { _dir: dir, launch, root }
}

impl Lab {
    fn switch(&self, name: &str, value: &str) {
        std::fs::write(self.root.join(name), value).unwrap();
    }

    fn seen(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.root.join("start.json")).unwrap()).unwrap()
    }

    fn pids(&self) -> (u64, u64) {
        let seen = self.seen();
        (seen["pid"].as_u64().unwrap(), seen["child"].as_u64().unwrap())
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.join("calls.jsonl")).unwrap_or_default()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn posts(&self, prefix: &str) -> Vec<Value> {
        self.calls().into_iter()
            .filter(|c| c["method"] == "POST" && c["path"].as_str().unwrap().starts_with(prefix)).collect()
    }

    async fn control(&self, name: &str, body: Value) -> Value {
        let port = self.seen()["port"].as_u64().unwrap();
        // Bounded, so a stand-in blocked on its output fails the test.
        http().post(format!("http://127.0.0.1:{port}/__fixture/{name}")).json(&body)
            .timeout(Duration::from_secs(20)).send().await.unwrap().json().await.unwrap()
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// No such process, or a zombie its parent has yet to reap.
fn ended(pid: u64) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
    }
}

async fn ends(pid: u64) -> bool {
    for _ in 0..100 {
        if ended(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

async fn session(server: &Server) -> String {
    server.create_session("fixture").await.unwrap()["id"].as_str().unwrap().to_owned()
}

/// The next event of this type, skipping others.
async fn next_of(events: &mut Events, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.next().await.unwrap().expect("the stream ended");
            if event["type"] == kind {
                return event;
            }
        }
    }).await.unwrap()
}

#[tokio::test]
async fn it_listens_on_loopback_behind_its_own_password_and_shutdown_ends_its_process_group() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let seen = lab.seen();
    assert_eq!(seen["argv"], json!(["serve", "--hostname", "127.0.0.1", "--port", "0"]), "no --mdns: 2.x ends on a flag it does not know");
    assert_eq!(seen["cwd"], lab.launch.directory.to_str().unwrap());
    assert_eq!(seen["database"], lab.launch.database.to_str().unwrap());
    assert_eq!(seen["pgid"], seen["pid"], "OpenCode leads a process group of its own");
    assert_eq!(seen["passwordFrom"], "OPENCODE_PASSWORD", "the name 2.x reads first");
    assert!(seen["passwordLength"].as_u64().unwrap() >= 32);
    assert_eq!(seen["passwordInArgv"], false, "the password is in the environment only");

    // Only Core's password opens it.
    let url = format!("http://127.0.0.1:{}/api/session/active", seen["port"]);
    assert_eq!(http().get(&url).send().await.unwrap().status(), 401);
    assert_eq!(http().get(&url).basic_auth("opencode", Some("guess")).send().await.unwrap().status(), 401);
    session(&server).await;
    let calls = lab.calls();
    assert_eq!(calls.iter().filter(|c| c["authorized"] == false).count(), 2, "only this test's guesses failed");
    let mine: Vec<_> = calls.iter().filter(|c| c["authorized"] == true).collect();
    assert_eq!(mine.iter().map(|c| c["path"].as_str().unwrap()).collect::<Vec<_>>(), ["/api/info", "/api/session"]);
    assert!(mine.iter().all(|c| c["query"] == json!({})), "no 2.x route names a folder in its query");
    assert_eq!(mine[1]["body"]["location"], json!({"directory": lab.launch.directory.to_str().unwrap()}),
        "the session is made in the Agent's folder, named in its body as 2.x takes it");
    assert_eq!(server.version(), "2.2.5", "the version it reported");

    let (pid, child) = lab.pids();
    server.shutdown().await.unwrap();
    assert!(ended(pid), "OpenCode ended and was reaped");
    assert!(ends(child).await, "its own child ended with it");
}

#[tokio::test]
async fn dropping_the_server_ends_its_process_group() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let (pid, child) = lab.pids();
    drop(server);
    assert!(ends(pid).await && ends(child).await);
}

#[tokio::test]
async fn output_that_is_not_utf8_stops_neither_start_nor_the_drain() {
    let lab = lab();
    lab.switch("noise", "1");
    let server = Server::start(&lab.launch).await.unwrap();
    // More than a pipe holds: it is written only while Core keeps draining.
    assert_eq!(lab.control("print", json!({"bytes": 1 << 20})).await, true);
    session(&server).await;
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_server_elsewhere_of_another_version_or_that_exits_early_is_refused_and_ended() {
    for (switch, value, expected) in [
        ("host", "0.0.0.0", "not on this host's loopback"),
        ("version", "1.20.0", "OpenCode 1.20.0 is not supported: Yuzuno speaks the server protocol of OpenCode 2.x (checked against 2.2.5)"),
        ("version", "3.0.0", "OpenCode 3.0.0 is not supported"),
        ("exit", "1", "exited before it was listening"),
    ] {
        let lab = lab();
        lab.switch(switch, value);
        let error = Server::start(&lab.launch).await.err().unwrap_or_else(|| panic!("{switch}: started")).to_string();
        assert!(error.contains(expected), "{switch}: {error}");
        let (pid, child) = lab.pids();
        assert!(ends(pid).await && ends(child).await, "{switch}: what it started has ended");
    }
}

/// A start that fails says why, as far as OpenCode says (T-32): its first
/// lines on stderr, without their escape codes, and which OpenCode it is when
/// `--version` names another. A supported one that says nothing adds nothing.
#[tokio::test]
async fn a_start_that_fails_says_what_opencode_said_and_which_one_it_is() {
    // One not of 2.x that exits saying why: two lines on stderr, the first coloured.
    let refused = lab();
    refused.switch("exit", "1");
    refused.switch("exitStderr", "\u{1b}[31mERROR\u{1b}[0m\nfixture: this OpenCode cannot serve here");
    refused.switch("versionLine", "1.19.3");
    let error = Server::start(&refused.launch).await.err().expect("not started").to_string();
    assert_eq!(error, "OpenCode exited before it was listening (the installed OpenCode says \u{201c}1.19.3\u{201d}; \
        Yuzuno speaks the server protocol of OpenCode 2.x): ERROR / fixture: this OpenCode cannot serve here",
        "says what it said and which OpenCode it is");
    // Another 2.x that exits says what it said, and is not called the wrong one.
    let other = lab();
    other.switch("exit", "1");
    other.switch("exitStderr", "fixture: no");
    other.switch("versionLine", "opencode v2.0.16");
    assert_eq!(Server::start(&other.launch).await.err().expect("not started").to_string(), "OpenCode exited before it was listening: fixture: no");
    // One newer than the verified release is noted, not refused (Lead 4669).
    let newer = lab();
    newer.switch("exit", "1");
    newer.switch("exitStderr", "fixture: no");
    newer.switch("versionLine", "opencode v2.9.0");
    assert_eq!(Server::start(&newer.launch).await.err().expect("not started").to_string(),
        "OpenCode exited before it was listening (the installed OpenCode says \u{201c}opencode v2.9.0\u{201d}, newer than the verified 2.2.5): fixture: no");
    let (pid, child) = refused.pids();
    assert!(ends(pid).await && ends(child).await, "what it started has ended");

    // The supported version, gone without a word: nothing more to say.
    let quiet = lab();
    quiet.switch("exit", "1");
    let error = Server::start(&quiet.launch).await.err().expect("not started").to_string();
    assert_eq!(error, "OpenCode exited before it was listening");
}

/// Any 2.x is spoken to (T-32: the latest 2.x, not one release), and the
/// version it reported is kept with the server.
#[tokio::test]
async fn any_release_of_2x_is_started_and_its_version_kept() {
    let lab = lab();
    lab.switch("version", "2.9.1");
    let server = Server::start(&lab.launch).await.unwrap();
    assert_eq!(server.version(), "2.9.1");
    session(&server).await;
    server.shutdown().await.unwrap();
}

/// 2.x answers `/api/info` with 503 while it starts: Core asks again until it
/// is ready, and only then speaks to it.
#[tokio::test]
async fn a_server_still_starting_is_asked_again_until_it_is_ready() {
    let lab = lab();
    lab.switch("starting", "1");
    let server = Server::start(&lab.launch).await.unwrap();
    let infos = lab.calls().into_iter().filter(|c| c["path"] == "/api/info").count();
    assert!(infos >= 2, "asked {infos} times");
    session(&server).await;
    server.shutdown().await.unwrap();
}

/// A 2.x older than the oldest Core reads (`MIN`, T-32 R2 59b5e3c6) is
/// refused and ended, naming both versions and saying to update it: by the
/// version its `/api/info` reports, and, when it fails before that (an
/// OpenCode before 2.0.6 has no `/api/info`), by what `--version` says. The
/// oldest one Core reads starts.
#[tokio::test]
async fn a_2x_older_than_the_oldest_core_reads_is_refused_naming_both_versions() {
    let older = lab();
    older.switch("version", "2.0.6");
    let error = Server::start(&older.launch).await.err().map(|e| e.to_string());
    assert_eq!(error.as_deref(), Some("OpenCode 2.0.6 is older than 2.0.7, the oldest Core reads; update it"),
        "an older 2.x is refused, naming both versions");
    let (pid, child) = older.pids();
    assert!(ends(pid).await && ends(child).await, "what it started has ended");

    let before_info = lab();
    before_info.switch("exit", "1");
    before_info.switch("exitStderr", "fixture: no");
    before_info.switch("versionLine", "opencode v2.0.5");
    assert_eq!(Server::start(&before_info.launch).await.err().expect("not started").to_string(),
        "OpenCode exited before it was listening (the installed OpenCode says \u{201c}opencode v2.0.5\u{201d}, \
        older than 2.0.7, the oldest Core reads; update it): fixture: no", "one that fails before saying its version is named too");

    let oldest = lab();
    oldest.switch("version", "2.0.7");
    let server = Server::start(&oldest.launch).await.unwrap();
    assert_eq!(server.version(), "2.0.7");
    server.shutdown().await.unwrap();
}

/// A 2.x is ranked by its MAJOR.MINOR.PATCH as semver ranks a release
/// (T-32, R4 eef2b7e2): a pre-release below its release, a build as the
/// release itself; one whose numbers cannot be read is refused, never read in
/// part.
#[tokio::test]
async fn a_2x_version_is_ranked_as_semver_ranks_it_and_one_unreadable_is_refused() {
    let refused = |version: &'static str| async move {
        let lab = lab();
        lab.switch("version", version);
        let error = Server::start(&lab.launch).await.err().map(|e| e.to_string());
        let (pid, child) = lab.pids();
        assert!(ends(pid).await && ends(child).await, "{version}: what it started has ended");
        error
    };
    assert_eq!(refused("2.0.7-rc1").await.as_deref(), Some("OpenCode 2.0.7-rc1 is older than 2.0.7, the oldest Core reads; update it"),
        "a pre-release ranks below its release");
    assert_eq!(refused("2.1.x").await.as_deref(), Some("OpenCode 2.1.x: cannot read its version; 2.0.7 is the oldest Core reads"),
        "a 2.x whose numbers cannot be read is refused, never read in part");
    for version in ["2.0.8-rc1", "2.0.7+build"] {
        let lab = lab();
        lab.switch("version", version);
        let server = Server::start(&lab.launch).await.unwrap_or_else(|e| panic!("{version}: {e:#}"));
        assert_eq!(server.version(), version);
        server.shutdown().await.unwrap();
    }
}

/// A 1.x, which starts and says it listens as 1.x does, is refused at once
/// (not waited past for 2.x's line) and said to be the one installed.
#[tokio::test]
async fn one_that_starts_as_1x_does_is_refused_at_once_and_named() {
    let lab = lab();
    lab.switch("line1x", "1");
    lab.switch("versionLine", "1.19.3");
    let started = std::time::Instant::now();
    let error = Server::start(&lab.launch).await.err().expect("not started").to_string();
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "waited {:?}", started.elapsed());
    assert_eq!(error, "OpenCode started as 1.x does, not as 2.x \
        (the installed OpenCode says \u{201c}1.19.3\u{201d}; Yuzuno speaks the server protocol of OpenCode 2.x)");
    let (pid, child) = lab.pids();
    assert!(ends(pid).await && ends(child).await, "what it started has ended");
}

#[tokio::test]
async fn output_on_stderr_never_blocks_the_server() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    // More than a pipe holds, on stderr: written only while Core keeps draining it.
    assert_eq!(lab.control("print", json!({"bytes": 1 << 20, "stderr": true})).await, true);
    session(&server).await;
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_admitted_prompt_is_accepted_and_rest_errors_keep_their_status() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;

    // Admitted when OpenCode answered (2.x's answer is the message as it
    // admitted it, T-32 slice 4a): accepted, then found by its ID.
    let id = MessageId::new();
    assert_eq!(server.submit(&session, &id, "hello").await.unwrap(), Submission::Accepted);
    let stored = server.message(&session, &id).await.unwrap().unwrap();
    assert_eq!(stored["id"], id.as_str());
    let sent = lab.posts(&format!("/api/session/{session}/prompt"));
    assert_eq!(sent[0]["body"], json!({"id": id.as_str(), "text": "hello"}),
        "no model, agent, tools or permission rule is sent");

    // Answered and then not stored (the stand-in's `unstored`): accepted,
    // and found by its ID as not there.
    lab.control("mode", json!({"prompt": "unstored"})).await;
    let lost = MessageId::new();
    assert_eq!(server.submit(&session, &lost, "hello").await.unwrap(), Submission::Accepted);
    assert_eq!(server.message(&session, &lost).await.unwrap(), None);

    // A 5xx is unknown and a 4xx refused, each with OpenCode's status.
    lab.control("mode", json!({"prompt": "error"})).await;
    match server.submit(&session, &MessageId::new(), "hello").await.unwrap() {
        Submission::Unknown(reason) => assert!(reason.contains("HTTP 500"), "{reason}"),
        other => panic!("{other:?}"),
    }
    match server.submit("ses_missing", &MessageId::new(), "hello").await.unwrap() {
        Submission::Refused(status) => assert_eq!(status.code, 404),
        other => panic!("{other:?}"),
    }
    lab.control("mode", json!({"fail": {"/api/session/active": 503}})).await;
    let error = server.snapshot(&session, &[]).await.unwrap_err();
    assert_eq!(error.downcast_ref::<HttpStatus>().unwrap().code, 503);
    server.shutdown().await.unwrap();
}

/// A message sent while a run goes on waits in 2.x's inbox until a step takes
/// it, and is found there by its ID; an answer admitting another message is
/// no proof; an ID the session holds already, sent by a server started
/// anew, is the one sent (T-32 slice 4a).
#[tokio::test]
async fn a_prompt_is_found_waiting_in_the_inbox_and_only_its_own_admission_accepts_it() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    let first = MessageId::new();
    assert_eq!(server.submit(&session, &first, "hello").await.unwrap(), Submission::Accepted);
    let waiting = MessageId::new();
    assert_eq!(server.submit(&session, &waiting, "also").await.unwrap(), Submission::Accepted);
    let found = server.message(&session, &waiting).await.unwrap();
    assert_eq!(found.as_ref().map(|m| &m["id"]), Some(&json!(waiting.as_str())), "found in its inbox while it waits: {found:?}");

    lab.control("mode", json!({"prompt": "renamed"})).await;
    match server.submit(&session, &MessageId::new(), "hello").await.unwrap() {
        Submission::Unknown(reason) => assert!(reason.contains("admitted msg_"), "{reason}"),
        other => panic!("another message admitted is no proof: {other:?}"),
    }
    server.shutdown().await.unwrap();

    let again = Server::start(&lab.launch).await.unwrap();
    assert_eq!(again.submit(&session, &first, "hello").await.unwrap(), Submission::Accepted, "an ID the session holds already is the one sent");
    again.shutdown().await.unwrap();
}

/// The stand-in keeps the state it saved whole through a SIGTERM in the
/// middle of a save (T-61 S0; CI 42314910718 of #659 met a cut one, and the
/// stand-in then exited before it listened): started again on the same
/// folder, it reads that state and listens. Its saves are made slow here
/// (switch `slowSave`), and one is under way when it is stopped.
#[tokio::test]
async fn the_stand_in_stopped_in_the_middle_of_a_save_starts_again_on_what_it_saved() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    lab.switch("slowSave", "2");
    let port = lab.seen()["port"].as_u64().unwrap();
    let seeded = session.clone();
    // A control that saves, answered only once its save is done: under way when the SIGTERM comes.
    let saving = tokio::spawn(async move {
        http().post(format!("http://127.0.0.1:{port}/__fixture/seed")).json(&json!({"sessionID": seeded, "count": 1}))
            .timeout(Duration::from_secs(20)).send().await
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    server.shutdown().await.unwrap();
    let _ = saving.await;
    std::fs::remove_file(lab.root.join("slowSave")).unwrap();
    let again = Server::start(&lab.launch).await
        .expect("started again on what it saved, after a SIGTERM in the middle of a save");
    again.session(&session).await.expect("the session it saved before is there");
    again.shutdown().await.unwrap();
}

/// A message 2.x delivers between Core's two reads of it is found (T-32
/// slice 4a, R5 728f7e52): the inbox is read before the delivered messages,
/// and delivery only moves a message from the first to the second.
#[tokio::test]
async fn a_message_delivered_between_the_two_reads_of_it_is_found() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    assert_eq!(server.submit(&session, &MessageId::new(), "hello").await.unwrap(), Submission::Accepted);
    let waiting = MessageId::new();
    assert_eq!(server.submit(&session, &waiting, "also").await.unwrap(), Submission::Accepted);
    // It waits in the inbox; 2.x delivers it right after the first read is answered.
    lab.control("mode", json!({"deliverBetweenReads": true})).await;
    let found = server.message(&session, &waiting).await.unwrap();
    assert!(found.is_some(), "found, though delivered between the two reads");
    let reads: Vec<String> = lab.calls().iter().filter(|c| c["method"] == "GET").filter_map(|c| c["path"].as_str())
        .filter(|path| path.ends_with("/inbox") || path.contains("/message/")).map(str::to_owned).collect();
    assert!(reads.first().is_some_and(|path| path.ends_with("/inbox")), "the inbox is read before the delivered messages: {reads:?}");
    assert!(server.message(&session, &waiting).await.unwrap().is_some(), "found once delivered");
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_lost_answer_stays_unknown_is_never_sent_again_and_is_found_by_its_id() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    let prompts = format!("/api/session/{session}/prompt");

    // Stored, then the connection ends without an answer.
    lab.control("mode", json!({"prompt": "store-then-drop"})).await;
    let id = MessageId::new();
    assert!(matches!(server.submit(&session, &id, "hello").await.unwrap(), Submission::Unknown(_)));
    let again = server.submit(&session, &id, "hello").await.unwrap_err().to_string();
    assert!(again.contains("never sent again"), "{again}");
    assert_eq!(lab.posts(&prompts).len(), 1, "sent once, with no retry at any layer");
    let kept = MessageId::parse(id.as_str()).unwrap();
    assert!(server.message(&session, &kept).await.unwrap().is_some(), "found by the ID it kept");

    // Not stored and no answer: not found yet, which proves nothing. Here it
    // is stored later.
    lab.control("mode", json!({"prompt": "drop"})).await;
    let late = MessageId::new();
    assert!(matches!(server.submit(&session, &late, "hello").await.unwrap(), Submission::Unknown(_)));
    assert_eq!(server.message(&session, &late).await.unwrap(), None);
    lab.control("store", json!({"sessionID": session, "messageID": late.as_str(), "text": "hello"})).await;
    assert!(server.message(&session, &late).await.unwrap().is_some());
    assert_eq!(lab.posts(&prompts).len(), 2);
    // OpenCode answers 404 for an unknown session too; that is an error, not "not yet".
    let unknown = server.message("ses_missing", &late).await.unwrap_err();
    assert_eq!(unknown.downcast_ref::<HttpStatus>().unwrap().code, 404);
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn events_arrive_in_order_and_a_broken_stream_is_recovered_by_a_snapshot() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let (session, other) = (session(&server).await, session(&server).await);
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    // Heartbeats (every 0.2 s here) come between the events and are left out.
    tokio::time::sleep(Duration::from_millis(500)).await;
    lab.control("busy", json!({"sessionID": session})).await;
    lab.control("event", json!({"type": "session.text.delta", "properties": {"sessionID": session,
        "assistantMessageID": "msg_a", "ordinal": 0, "delta": "Hel"}})).await;
    let status = events.next().await.unwrap().unwrap();
    assert_eq!(status["type"].as_str(), Some("session.execution.started"), "2.x's busy");
    let delta = events.next().await.unwrap().unwrap();
    assert_eq!((delta["type"].as_str(), delta["data"]["delta"].as_str()), (Some("session.text.delta"), Some("Hel")));
    assert_eq!(session_of(&delta), Some(session.as_str()));

    // The stream breaks. A request asked meanwhile is not an event here...
    lab.control("drop", json!({})).await;
    assert!(events.next().await.unwrap().is_none());
    let asked = lab.control("ask", json!({"sessionID": session})).await;
    lab.control("ask", json!({"sessionID": other})).await;

    // ...but is in the snapshot read after subscribing again, with no other
    // session's request.
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    let snapshot = server.snapshot(&session, &[]).await.unwrap();
    assert_eq!(snapshot.status["type"], "busy");
    assert_eq!(snapshot.permissions, vec![asked]);
    assert!(snapshot.questions.is_empty());
    assert_eq!(server.snapshot(&other, &[]).await.unwrap().status, json!({"type": "idle"}), "an unlisted session is idle");
    lab.control("question", json!({"sessionID": session})).await;
    assert_eq!(session_of(&next_of(&mut events, "form.created").await), Some(session.as_str()));

    // A silent stream is an error, not an end.
    lab.control("mode", json!({"heartbeat": 0})).await;
    let mut quiet = server.subscribe(Duration::from_millis(500)).await.unwrap();
    let silent = quiet.next().await.unwrap_err().to_string();
    assert!(silent.contains("silent"), "{silent}");
    server.shutdown().await.unwrap();
}

/// A Workspace MCP server goes to OpenCode 2.x by its own route (T-61 slice
/// 1): added at runtime to the Agent's folder, named as its sessions name it,
/// with OAuth off and its tools as tools of their own, and listed by its
/// status only. The same configuration again connects nothing anew; another
/// does; a failed one is tried again only when asked. A refusal says its
/// status and kind, never what OpenCode answered.
#[tokio::test]
async fn mcp_goes_to_the_agents_folder_by_2x_s_own_route_and_is_ready_only_when_listed_connected() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let url = "http://127.0.0.1:9/mcp/agent";
    let folder = json!([lab.launch.directory.to_str().unwrap()]);
    let connects = || async { lab.control("mcp", json!({})).await["connects"].as_array().unwrap().len() };
    assert_eq!(server.mcp("yuzuno").await.unwrap(), Mcp::Absent);
    server.add_mcp("yuzuno", url, "token-1").await.unwrap();
    assert_eq!(server.mcp("yuzuno").await.unwrap(), Mcp::Connected);
    let added: Vec<Value> = lab.calls().into_iter().filter(|c| c["method"] == "PUT").collect();
    assert_eq!(added[0]["path"], "/api/experimental/mcp/yuzuno");
    assert_eq!(added[0]["query"]["location[directory]"], folder, "the Agent's folder, named");
    assert_eq!(added[0]["body"], json!({"config": {"type": "remote", "url": url, "oauth": false, "codemode": false,
        "headers": {"Authorization": "Bearer token-1"}, "timeout": {"startup": 10000, "catalog": 10000}}}));
    let listed: Vec<Value> = lab.calls().into_iter().filter(|c| c["path"] == "/api/mcp").collect();
    assert!(listed.iter().all(|c| c["query"]["location[directory]"] == folder));
    server.add_mcp("yuzuno", url, "token-1").await.unwrap();
    assert_eq!(connects().await, 1, "the same configuration again connects nothing anew");

    for status in ["failed", "needs_auth"] {
        lab.control("mode", json!({"mcp": status})).await;
        server.add_mcp("yuzuno", url, &format!("token-{status}")).await.unwrap();
        match server.mcp("yuzuno").await.unwrap() {
            Mcp::NotConnected(native) => assert!(native["status"] == status && native["error"].is_string(), "{native}"),
            other => panic!("{status} is not ready: {other:?}"),
        }
    }
    // Failed, and the same configuration again: nothing is tried again; asked, it is.
    lab.control("mode", json!({"mcp": "connected"})).await;
    let before = connects().await;
    server.add_mcp("yuzuno", url, "token-needs_auth").await.unwrap();
    assert!(matches!(server.mcp("yuzuno").await.unwrap(), Mcp::NotConnected(_)));
    assert_eq!(connects().await, before);
    server.connect_mcp("yuzuno").await.unwrap();
    assert_eq!(server.mcp("yuzuno").await.unwrap(), Mcp::Connected);
    assert_eq!(lab.posts("/api/experimental/mcp/yuzuno/connect")[0]["query"]["location[directory]"], folder);

    lab.control("mode", json!({"mcp": "pending"})).await;
    server.add_mcp("yuzuno", url, "token-3").await.unwrap();
    assert_eq!(server.mcp("yuzuno").await.unwrap(), Mcp::Pending);

    lab.control("mode", json!({"mcpRefuse": true})).await;
    let refused = server.add_mcp("yuzuno", url, "token-4").await.unwrap_err();
    assert_eq!(refused.downcast_ref::<McpRefused>(), Some(&McpRefused { code: 400, kind: Some("InvalidRequestError".into()) }));
    assert!(!refused.to_string().contains("token-4"), "{refused}");
    let unknown = server.connect_mcp("other").await.unwrap_err();
    assert_eq!(unknown.downcast_ref::<McpRefused>(), Some(&McpRefused { code: 404, kind: Some("McpServerNotFoundError".into()) }));
    assert!(lab.calls().iter().all(|c| c["path"] == "/api/info" || c["path"] == "/api/mcp"
            || c["path"].as_str().unwrap().starts_with("/api/experimental/mcp/")),
        "nothing else was sent: no permission rule, no configuration, nothing to 1.19.3's /mcp");
    server.shutdown().await.unwrap();
}

/// 2.x's requests are answered by its own routes, each in the session that
/// asked (T-61 slice 2): through another session, 2.x refuses it as gone
/// (404) and answers nothing; a form answer it can't take is refused and the
/// form stays pending (400). An interrupt ends a's run only, dropping its
/// permission requests and cancelling its forms; a reject rejects the
/// session's others with it.
#[tokio::test]
async fn answers_and_abort_stay_within_their_session() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let (a, b) = (session(&server).await, session(&server).await);
    let ask_a = lab.control("ask", json!({"sessionID": a})).await["id"].as_str().unwrap().to_owned();
    let form_a = lab.control("question", json!({"sessionID": a})).await["id"].as_str().unwrap().to_owned();
    let ask_b = lab.control("ask", json!({"sessionID": b})).await["id"].as_str().unwrap().to_owned();
    let question_b = lab.control("question", json!({"sessionID": b})).await["id"].as_str().unwrap().to_owned();
    let gone = |error: anyhow::Error| matches!(error.downcast_ref::<RequestRefused>(), Some(RequestRefused::Gone { code: 404, .. }));
    let replies = || -> Vec<(String, String, Value)> { lab.calls().into_iter()
        .filter(|c| c["path"].as_str().is_some_and(|p| p.starts_with("/api/session/") && (p.ends_with("/reply") || (c["method"] == "DELETE" && p.contains("/form/")))))
        .map(|c| (c["method"].as_str().unwrap().to_owned(), c["path"].as_str().unwrap().to_owned(), c["body"].clone())).collect() };

    // Another session's request is not answered through this one.
    assert!(gone(server.reply_permission(&a, &ask_b, Reply::Once).await.unwrap_err()), "a permission request through another session is gone");
    assert!(gone(server.reply_form(&a, &question_b, &json!({"q0": "A"})).await.unwrap_err()), "a form through another session is gone");
    assert!(gone(server.cancel_form(&a, &question_b).await.unwrap_err()), "a form declined through another session is gone");
    let now_b = server.snapshot(&b, &[]).await.unwrap();
    assert_eq!((now_b.permissions.len(), now_b.questions.len()), (1, 1), "b's still pending");
    // An answer 2.x can't take: refused with its reason, the form still pending.
    let invalid = server.reply_form(&b, &question_b, &json!({"q9": "x"})).await.unwrap_err();
    assert!(matches!(invalid.downcast_ref::<RequestRefused>(), Some(RequestRefused::Invalid { message }) if message.contains("Unknown form field: q9")),
        "refused with 2.x's reason: {invalid}");
    assert_eq!(server.snapshot(&b, &[]).await.unwrap().questions.len(), 1, "the form stays pending");

    // An interrupt ends a's run: its permission request dropped, its form cancelled, a's only.
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    server.abort(&a).await.unwrap();
    let seen = tokio::time::timeout(Duration::from_secs(10), async {
        let mut seen = Vec::new();
        loop {
            let event = events.next().await.unwrap().expect("the stream ended");
            let end = event["type"].as_str().is_some_and(|kind| kind.starts_with("session.execution.") && kind != "session.execution.started");
            seen.push(event);
            if end {
                return seen;
            }
        }
    }).await.expect("the execution's end");
    assert_eq!(session_of(seen.last().unwrap()), Some(a.as_str()));
    assert!(seen.iter().any(|e| e["type"] == "form.cancelled" && e["data"]["id"] == form_a.as_str()), "a's form cancelled with its run");
    let now_a = server.snapshot(&a, &[]).await.unwrap();
    assert!(now_a.permissions.is_empty() && now_a.questions.is_empty());
    let now_b = server.snapshot(&b, &[]).await.unwrap();
    assert_eq!((now_b.permissions.len(), now_b.questions.len()), (1, 1));
    assert!(gone(server.reply_permission(&a, &ask_a, Reply::Once).await.unwrap_err()), "a's request ended with its run");

    // b's own requests are answered in b, each once, by 2.x's routes.
    let before = replies().len();
    server.reply_permission(&b, &ask_b, Reply::Once).await.unwrap();
    server.reply_form(&b, &question_b, &json!({"q0": "A"})).await.unwrap();
    assert_eq!(replies()[before..], [("POST".to_owned(), format!("/api/session/{b}/permission/{ask_b}/reply"), json!({"decision": "once"})),
        ("POST".to_owned(), format!("/api/session/{b}/form/{question_b}/reply"), json!({"answer": {"q0": "A"}}))]);

    // A reject is sent as 2.x's `reject`; 2.x itself then rejects the rest pending in that session.
    let first = lab.control("ask", json!({"sessionID": b})).await["id"].as_str().unwrap().to_owned();
    lab.control("ask", json!({"sessionID": b})).await;
    server.reply_permission(&b, &first, Reply::Reject).await.unwrap();
    assert_eq!(replies().last().unwrap().2, json!({"decision": "reject"}));
    assert!(server.snapshot(&b, &[]).await.unwrap().permissions.is_empty());
    server.shutdown().await.unwrap();
}

/// A long session is read whole, oldest first, page after page: 2.x gives at
/// most 200 a page, 50 and newest first unless asked, and the next page by a
/// cursor that is not combined with the order (T-32 slice 3a). A snapshot
/// reads them the same way.
#[tokio::test]
async fn a_long_session_is_read_whole_oldest_first_page_by_page() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    let seeded: Vec<String> = serde_json::from_value(lab.control("seed", json!({"sessionID": session, "count": 450})).await).unwrap();
    let read = server.messages(&session).await.unwrap();
    let ids: Vec<&str> = read.as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, seeded, "every message, oldest first");
    let pages: Vec<Value> = lab.calls().into_iter()
        .filter(|c| c["path"] == format!("/api/session/{session}/message")).map(|c| c["query"].clone()).collect();
    assert_eq!(pages.len(), 3, "200, 200, then the 50 left: {pages:?}");
    assert_eq!(pages[0], json!({"order": ["asc"], "limit": ["200"]}));
    assert!(pages[1..].iter().all(|q| q["cursor"].is_array() && q.get("order").is_none() && q["limit"] == json!(["200"])), "{pages:?}");
    assert_eq!(server.snapshot(&session, &[]).await.unwrap().messages.as_array().unwrap().len(), 450);
    server.shutdown().await.unwrap();
}

/// A session's sub-agents are 2.x's sessions with it as their parent,
/// listed oldest first, and only those (T-32 slice 3a).
#[tokio::test]
async fn a_sessions_children_are_listed_by_their_parent() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let (session, other) = (session(&server).await, session(&server).await);
    let mut made = Vec::new();
    for parent in [&session, &other, &session] {
        made.push(lab.control("child", json!({"parentID": parent})).await["id"].as_str().unwrap().to_owned());
    }
    let listed: Vec<String> = server.children(&session).await.unwrap().iter().map(|c| c["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(listed, [made[0].clone(), made[2].clone()]);
    let asked = lab.calls().into_iter().filter(|c| c["method"] == "GET" && c["path"] == "/api/session").map(|c| c["query"].clone()).collect::<Vec<_>>();
    assert_eq!(asked, [json!({"parentID": [session], "order": ["asc"], "limit": ["200"]})]);
    server.shutdown().await.unwrap();
}

/// 2.x answers a GET it has no route for with its web UI's page (200,
/// HTML): Core refuses that, naming the path, rather than reading it as
/// an answer (T-32 slice 3a).
#[tokio::test]
async fn a_web_page_is_refused_as_no_answer_of_the_2x_api() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    lab.control("mode", json!({"html": ["/api/session/active", "/api/event"]})).await;
    let read = server.session_status(&session).await.unwrap_err().to_string();
    assert!(read.contains("OpenCode answered /api/session/active with text/html, not JSON: not an answer of the OpenCode 2.x API"), "{read}");
    let stream = server.subscribe(EVENT_IDLE_LIMIT).await.err().expect("no stream").to_string();
    assert!(stream.contains("OpenCode answered /api/event with text/html, not an event stream"), "{stream}");
    server.shutdown().await.unwrap();
}

/// 2.x's heartbeat is a comment every 15 s, never an event: it keeps a stream
/// that says nothing else open past the 30 s limit, and a stream with neither
/// still breaks at that limit (T-32 slice 3a, Lead 4890). Both at the real
/// EVENT_IDLE_LIMIT, so it is the limit itself that is checked.
#[tokio::test]
async fn a_heartbeat_comment_keeps_a_quiet_stream_open_and_silence_still_breaks_it_at_the_limit() {
    let (beating, quiet) = (lab(), lab());
    let (a, b) = (Server::start(&beating.launch).await.unwrap(), Server::start(&quiet.launch).await.unwrap());
    beating.control("mode", json!({"heartbeat": 15})).await;
    quiet.control("mode", json!({"heartbeat": 0})).await;
    let (mut open, mut silent) = (a.subscribe(EVENT_IDLE_LIMIT).await.unwrap(), b.subscribe(EVENT_IDLE_LIMIT).await.unwrap());
    let started = std::time::Instant::now();
    let kept = async {
        let until = started + Duration::from_secs(35);
        loop {
            let left = until.saturating_duration_since(std::time::Instant::now());
            match tokio::time::timeout(left, open.next()).await {
                Err(_) => return Ok(()),
                Ok(Ok(Some(_))) => continue,
                Ok(other) => return Err(format!("{other:?}")),
            }
        }
    };
    let broke = async { tokio::time::timeout(Duration::from_secs(33), silent.next()).await.map(|next| (next.map(|e| e.is_some()), started.elapsed())) };
    let (kept, broke) = tokio::join!(kept, broke);
    assert_eq!(kept, Ok(()), "comments every 15 s kept the stream open for 35 s with nothing else said");
    let (next, after) = broke.expect("a stream with no comment and no event broke at the limit, not later");
    let error = next.expect_err("a silence is an error, not an end").to_string();
    assert!(error.contains("silent for 30s"), "{error}");
    assert!(after >= EVENT_IDLE_LIMIT, "not before the limit: {after:?}");
    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

/// 2.x's active list is an object keyed by session ID: a list, or any other
/// shape, is refused with the path named, never read as idle (R1 00fe8a2b of
/// #590), whether or not the session is in it.
#[tokio::test]
async fn an_active_list_of_another_shape_is_refused_never_read_as_idle() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    lab.control("busy", json!({"sessionID": session})).await;
    assert_eq!(server.session_status(&session).await.unwrap(), json!({"type": "busy"}));
    lab.control("mode", json!({"activeShape": "list"})).await;
    for asked in [session.clone(), "ses_other".to_owned()] {
        let read = server.session_status(&asked).await;
        assert!(read.as_ref().is_err_and(|e| e.to_string().contains("OpenCode's /api/session/active is a list, not an object keyed by session")),
            "another shape is refused, never read as idle: {read:?}");
    }
    assert!(server.snapshot(&session, &[]).await.is_err(), "nor read into a snapshot");
    server.shutdown().await.unwrap();
}

/// A command goes to 2.x by its own route (T-61 slice 3): its name and text
/// only, no ID and no model, and once for the ID Core keeps of its Turn.
/// 2.x's 204 is done; its 404 for a name it does not define and its 500 for
/// what a command does are refusals, in 2.x's own words; no answer is
/// unknown. 2.x's list names and describes each command, nothing more.
#[tokio::test]
async fn a_command_goes_through_2xs_route_with_its_name_and_text_only() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    let listed = server.commands().await.unwrap();
    assert_eq!(listed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["delegate", "explain", "pinned", "review", "status"]);
    assert_eq!(listed[1].description, "Explain one thing");

    let id = MessageId::new();
    assert_eq!(server.command(&session, &id, "explain", "closures").unwrap().await, CommandAnswer::Done);
    let sent = lab.posts(&format!("/api/session/{session}/command"));
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["body"], json!({"name":"explain","text":"closures"}), "no ID and no model");
    assert!(server.command(&session, &id, "explain", "closures").is_err(), "an ID it was given before is never sent again");
    assert_eq!(lab.posts(&format!("/api/session/{session}/command")).len(), 1);

    assert_eq!(server.command(&session, &MessageId::new(), "nope", "").unwrap().await,
        CommandAnswer::Refused { code: 404, message: "Command not found: nope".into() });
    lab.control("mode", json!({"command":"fail"})).await;
    assert_eq!(server.command(&session, &MessageId::new(), "explain", "x").unwrap().await,
        CommandAnswer::Refused { code: 500, message: "fixture: the command failed".into() });
    lab.control("mode", json!({"command":"drop"})).await;
    assert!(matches!(server.command(&session, &MessageId::new(), "explain", "x").unwrap().await, CommandAnswer::Unknown(_)));
    assert_eq!(lab.calls().iter().filter(|c| c["path"] == format!("/session/{session}/command")).count(), 0, "never 1.19.3's route");
    server.shutdown().await.unwrap();
}

/// A compaction goes to 2.x by its own route (T-61 slice 4): under Core's
/// ID, once, and answered at once. Admitted only when 2.x answers with that
/// compaction; another one already waiting answers in its place; only a 404
/// for the session or a 400 for the request is a refusal before admitting;
/// a 409, a 500 or no answer is unknown, and never sent again.
#[tokio::test]
async fn a_compaction_goes_through_2xs_route_under_cores_id_and_is_admitted_only_as_asked() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    let id = MessageId::new();
    assert_eq!(server.compact(&session, &id).await.unwrap(), CompactAdmission::Admitted);
    let sent = lab.posts(&format!("/api/session/{session}/compact"));
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["body"], json!({"id": id.as_str()}), "Core's ID, and no model");
    assert!(server.compact(&session, &id).await.is_err(), "an ID it was given before is never sent again");
    assert_eq!(lab.posts(&format!("/api/session/{session}/compact")).len(), 1);

    for (mode, expected) in [("refuse-404", "404"), ("invalid-400", "400")] {
        lab.control("mode", json!({"compact": mode})).await;
        match server.compact(&session, &MessageId::new()).await.unwrap() {
            CompactAdmission::Refused { code, message } => assert!(code.to_string() == expected && !message.is_empty(), "{mode}: {code} {message}"),
            other => panic!("{mode}: refused before admitting, not {other:?}"),
        }
    }
    for mode in ["conflict-409", "500", "drop-unadmitted"] {
        lab.control("mode", json!({"compact": mode})).await;
        assert!(matches!(server.compact(&session, &MessageId::new()).await.unwrap(), CompactAdmission::Unknown(_)), "{mode}: unknown");
    }
    lab.control("mode", json!({"compact": "other-pending"})).await;
    let ours = MessageId::new();
    match server.compact(&session, &ours).await.unwrap() {
        CompactAdmission::OtherPending(other) => assert_ne!(other, ours.as_str(), "another's ID"),
        other => panic!("another compaction waiting answers in its place, not {other:?}"),
    }
    assert_eq!(lab.calls().iter().filter(|c| c["path"].as_str().unwrap_or_default().ends_with("/summarize")).count(), 0, "never 1.19.3's route");
    server.shutdown().await.unwrap();
}
