//! The OpenCode transport (T-110 S1a) against a stand-in `opencode serve`
//! (tests/fixtures/opencode_server.py, run by /usr/bin/python3). No OpenCode,
//! account, model or network service is used, and no real configuration read.
#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use yuzuno_workspace::opencode::{
    session_of, Events, HttpStatus, Launch, Mcp, MessageId, Reply, Server, Submission, EVENT_IDLE_LIMIT,
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
    let launch = Launch { program, directory, database: root.join("opencode.db") };
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
    assert_eq!(seen["argv"], json!(["serve", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"]));
    assert_eq!(seen["cwd"], lab.launch.directory.to_str().unwrap());
    assert_eq!(seen["database"], lab.launch.database.to_str().unwrap());
    assert_eq!(seen["pgid"], seen["pid"], "OpenCode leads a process group of its own");
    assert_eq!(seen["username"], "opencode");
    assert!(seen["passwordLength"].as_u64().unwrap() >= 32);
    assert_eq!(seen["passwordInArgv"], false, "the password is in the environment only");

    // Only Core's password opens it.
    let url = format!("http://127.0.0.1:{}/session/status", seen["port"]);
    assert_eq!(http().get(&url).send().await.unwrap().status(), 401);
    assert_eq!(http().get(&url).basic_auth("opencode", Some("guess")).send().await.unwrap().status(), 401);
    session(&server).await;
    let calls = lab.calls();
    assert_eq!(calls.iter().filter(|c| c["authorized"] == false).count(), 2, "only this test's guesses failed");
    let mine: Vec<_> = calls.iter().filter(|c| c["authorized"] == true).collect();
    assert_eq!(mine.iter().map(|c| c["path"].as_str().unwrap()).collect::<Vec<_>>(), ["/global/health", "/session"]);
    assert!(mine.iter().all(|c| c["query"]["directory"] == json!([lab.launch.directory.to_str().unwrap()])),
        "every request names the Agent's folder");

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
        ("version", "1.20.0", "OpenCode 1.20.0 is not supported"),
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

#[tokio::test]
async fn a_204_is_only_accepted_and_rest_errors_keep_their_status() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;

    // Stored when OpenCode answered: accepted, then found by its ID.
    let id = MessageId::new();
    assert_eq!(server.submit(&session, &id, "hello").await.unwrap(), Submission::Accepted);
    let stored = server.message(&session, &id).await.unwrap().unwrap();
    assert_eq!(stored["info"]["id"], id.as_str());
    let sent = lab.posts(&format!("/session/{session}/prompt_async"));
    assert_eq!(sent[0]["body"], json!({"messageID": id.as_str(), "parts": [{"type": "text", "text": "hello"}]}),
        "no model, agent, tools or permission rule is sent");

    // Answered 204 and then not stored: still only accepted. OpenCode's
    // session.error names no message, so it is not that message's failure.
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    lab.control("mode", json!({"prompt": "unstored"})).await;
    let lost = MessageId::new();
    assert_eq!(server.submit(&session, &lost, "hello").await.unwrap(), Submission::Accepted);
    let error = next_of(&mut events, "session.error").await;
    assert_eq!(session_of(&error), Some(session.as_str()));
    assert!(error["properties"].get("messageID").is_none());
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
    lab.control("mode", json!({"fail": {"/session/status": 503}})).await;
    let error = server.snapshot(&session, &[]).await.unwrap_err();
    assert_eq!(error.downcast_ref::<HttpStatus>().unwrap().code, 503);
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_lost_answer_stays_unknown_is_never_sent_again_and_is_found_by_its_id() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let session = session(&server).await;
    let prompts = format!("/session/{session}/prompt_async");

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
    lab.control("event", json!({"type": "message.part.delta", "properties": {"sessionID": session,
        "messageID": "msg_a", "partID": "prt_a", "field": "text", "delta": "Hel"}})).await;
    let status = events.next().await.unwrap().unwrap();
    assert_eq!((status["type"].as_str(), status["properties"]["status"]["type"].as_str()), (Some("session.status"), Some("busy")));
    let delta = events.next().await.unwrap().unwrap();
    assert_eq!((delta["type"].as_str(), delta["properties"]["delta"].as_str()), (Some("message.part.delta"), Some("Hel")));
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
    assert_eq!(session_of(&next_of(&mut events, "question.asked").await), Some(session.as_str()));

    // A silent stream is an error, not an end.
    lab.control("mode", json!({"heartbeat": 0})).await;
    let mut quiet = server.subscribe(Duration::from_millis(500)).await.unwrap();
    let silent = quiet.next().await.unwrap_err().to_string();
    assert!(silent.contains("silent"), "{silent}");
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn mcp_is_ready_only_when_opencode_reports_it_connected() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let url = "http://127.0.0.1:9/mcp/agent";
    assert_eq!(server.add_mcp("yuzuno", url, "token-1").await.unwrap(), Mcp::Connected);
    assert_eq!(server.mcp("yuzuno").await.unwrap(), Mcp::Connected);
    assert_eq!(lab.posts("/mcp")[0]["body"], json!({"name": "yuzuno", "config": {"type": "remote", "url": url,
        "oauth": false, "headers": {"Authorization": "Bearer token-1"}}}));

    for status in ["failed", "needs_auth"] {
        lab.control("mode", json!({"mcp": status})).await;
        match server.add_mcp("yuzuno", url, "token-2").await.unwrap() {
            Mcp::NotConnected(native) => assert_eq!(native["status"], status),
            Mcp::Connected => panic!("{status} is not ready"),
        }
        assert!(matches!(server.mcp("yuzuno").await.unwrap(), Mcp::NotConnected(_)));
    }
    assert_eq!(server.mcp("absent").await.unwrap(), Mcp::NotConnected(Value::Null));
    assert!(lab.calls().iter().all(|c| matches!(c["path"].as_str(), Some("/global/health" | "/mcp"))),
        "nothing else was sent: no permission rule, no configuration");
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn answers_and_abort_stay_within_their_session() {
    let lab = lab();
    let server = Server::start(&lab.launch).await.unwrap();
    let (a, b) = (session(&server).await, session(&server).await);
    let ask_a = lab.control("ask", json!({"sessionID": a})).await["id"].as_str().unwrap().to_owned();
    let ask_b = lab.control("ask", json!({"sessionID": b})).await["id"].as_str().unwrap().to_owned();
    let question_b = lab.control("question", json!({"sessionID": b})).await["id"].as_str().unwrap().to_owned();

    // Another session's request is not answered through this one.
    let error = server.reply_permission(&a, &ask_b, Reply::Once).await.unwrap_err().to_string();
    assert!(error.contains("not pending in session"), "{error}");
    assert!(server.reply_question(&a, &question_b, &[vec!["A".into()]]).await.is_err());
    assert!(server.reject_question(&a, &question_b).await.is_err());
    assert!(lab.posts("/permission/").is_empty() && lab.posts("/question/").is_empty());

    // Abort ends a's run and a's requests only.
    let mut events = server.subscribe(EVENT_IDLE_LIMIT).await.unwrap();
    server.abort(&a).await.unwrap();
    let idle = next_of(&mut events, "session.status").await;
    assert_eq!(session_of(&idle), Some(a.as_str()));
    assert!(server.snapshot(&a, &[]).await.unwrap().permissions.is_empty());
    let now_b = server.snapshot(&b, &[]).await.unwrap();
    assert_eq!((now_b.permissions.len(), now_b.questions.len()), (1, 1));
    let stale = server.reply_permission(&a, &ask_a, Reply::Once).await.unwrap_err().to_string();
    assert!(stale.contains("not pending"), "{stale}");

    // b's own requests are answered in b, each once.
    server.reply_permission(&b, &ask_b, Reply::Once).await.unwrap();
    server.reply_question(&b, &question_b, &[vec!["A".into()]]).await.unwrap();
    let answered: Vec<_> = lab.posts("/permission/").into_iter().chain(lab.posts("/question/"))
        .map(|c| (c["path"].as_str().unwrap().to_owned(), c["body"].clone())).collect();
    assert_eq!(answered, [(format!("/permission/{ask_b}/reply"), json!({"reply": "once"})),
        (format!("/question/{question_b}/reply"), json!({"answers": [["A"]]}))]);

    // A reject is sent as OpenCode's `reject`; OpenCode itself then rejects
    // the rest pending in that session.
    let first = lab.control("ask", json!({"sessionID": b})).await["id"].as_str().unwrap().to_owned();
    lab.control("ask", json!({"sessionID": b})).await;
    server.reply_permission(&b, &first, Reply::Reject).await.unwrap();
    assert_eq!(lab.posts("/permission/").last().unwrap()["body"], json!({"reply": "reject"}));
    assert!(server.snapshot(&b, &[]).await.unwrap().permissions.is_empty());
    server.shutdown().await.unwrap();
}
