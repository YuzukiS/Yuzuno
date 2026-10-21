//! OpenCode Agents (T-110 S1b) through the Workspace, against the stand-in
//! `opencode serve` (tests/fixtures/opencode_server.py, run by
//! /usr/bin/python3): the record as the store keeps it and readers read it.
//! No OpenCode, account, model or network service is used. This Core has not
//! turned OpenCode on, so nothing creates an OpenCode Agent and each test
//! inserts one, as other tests do (tests/opencode_entry.rs creates them).
#![cfg(target_os = "linux")]

use axum::{body::{to_bytes, Body}, http::Request};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, OnceLock}, time::Duration};
use tower::ServiceExt;
use yuzuno_workspace::{model::{AgentDetail, MessageInput}, server, workspace::Workspace};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");
const ID: &str = "oc";

/// One `opencode` for the whole test process: YUZUNO_OPENCODE_BIN is the
/// process's, and every Agent's stand-in keeps its state in its own folder.
fn program() -> &'static PathBuf {
    static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
    PROGRAM.get_or_init(|| {
        use std::os::unix::fs::PermissionsExt;
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        let program = dir.path().join("opencode");
        std::fs::write(&program, format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("YUZUNO_OPENCODE_BIN", &program);
        program
    })
}

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
}

fn agent(cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":ID, "name":"OpenCode", "cwd":cwd, "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

/// A Workspace with one OpenCode Agent, connected. `switches` are left for
/// the stand-in before it starts; `collaboration` turns Workspace MCP on.
async fn lab(switches: &[(&str, &str)], collaboration: bool) -> Lab {
    program();
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let root = dir.path().join("data/opencode").join(ID);
    std::fs::create_dir_all(&root).unwrap();
    for (name, value) in switches {
        std::fs::write(root.join(name), value).unwrap();
    }
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    if collaboration {
        ws.start_collaboration(4999);
    }
    ws.store.insert(&agent(&work.to_string_lossy())).unwrap();
    let d = ws.reconnect(ID).await.unwrap();
    assert_eq!(d.agent.connection_state, "connected");
    Lab { dir, ws }
}

impl Lab {
    fn root(&self) -> PathBuf {
        self.dir.path().join("data/opencode").join(ID)
    }

    fn seen(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.root().join("start.json")).unwrap()).unwrap()
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root().join("calls.jsonl")).unwrap_or_default()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn posts(&self, prefix: &str) -> Vec<Value> {
        self.calls().into_iter()
            .filter(|c| c["method"] == "POST" && c["path"].as_str().unwrap().starts_with(prefix)).collect()
    }

    fn prompts(&self) -> Vec<Value> {
        self.calls().into_iter().filter(|c| c["path"].as_str().unwrap().ends_with("/prompt_async")).collect()
    }

    fn detail(&self) -> AgentDetail {
        self.ws.store.detail(ID).unwrap()
    }

    fn session(&self) -> String {
        self.detail().agent.opencode_session_id.unwrap()
    }

    async fn control(&self, name: &str, body: Value) -> Value {
        let port = self.seen()["port"].as_u64().unwrap();
        reqwest::Client::builder().no_proxy().build().unwrap()
            .post(format!("http://127.0.0.1:{port}/__fixture/{name}")).json(&body)
            .timeout(Duration::from_secs(20)).send().await.unwrap().json().await.unwrap()
    }

    async fn until(&self, what: &str, done: impl Fn(&AgentDetail) -> bool) -> AgentDetail {
        for _ in 0..400 {
            let d = self.detail();
            if done(&d) {
                return d;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {what}: {:#?}", self.detail());
    }

    async fn send(&self, client: &str, text: &str) -> anyhow::Result<yuzuno_workspace::model::MessageReceipt> {
        let input: MessageInput = serde_json::from_value(json!({"clientMessageId":client,"text":text})).unwrap();
        self.ws.send_message(ID, input).await
    }
}

fn turn<'a>(d: &'a AgentDetail, id: &str) -> &'a Value {
    d.turns.iter().find(|t| t["id"] == id).unwrap_or_else(|| panic!("no turn {id}: {:#?}", d.turns))
}

fn items<'a>(turn: &'a Value, kind: &str) -> Vec<&'a Value> {
    turn["items"].as_array().unwrap().iter().filter(|i| i["type"] == kind).collect()
}

/// No such process, or a zombie its parent has yet to reap.
fn ended(pid: u64) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
    }
}

async fn ends(pid: u64) -> bool {
    for _ in 0..200 {
        if ended(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

fn journal(lab: &Lab) -> Vec<String> {
    let db = rusqlite::Connection::open(lab.dir.path().join("data/workspace.sqlite")).unwrap();
    let mut query = db.prepare("SELECT kind FROM journal WHERE agent_id=?1 ORDER BY seq").unwrap();
    query.query_map([ID], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
}

#[tokio::test]
async fn a_message_is_sent_once_under_its_kept_id_and_ends_only_on_its_answer() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    assert!(session.starts_with("ses_"));

    // Delivered: OpenCode stored the message under the ID it was sent with.
    let receipt = lab.send("c1", "hello").await.unwrap();
    assert_eq!(receipt.status, "accepted");
    let first = receipt.turn_id.unwrap();
    assert!(first.starts_with("msg_"), "{first}");
    let prompts = lab.prompts();
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0]["body"], json!({"messageID":first,"parts":[{"type":"text","text":"hello"}]}),
        "no model, agent, tools or permission rule is sent");
    let kinds = journal(&lab);
    let requested = kinds.iter().position(|k| k == "opencode/turnRequested").unwrap();
    let confirmed = kinds.iter().position(|k| k == "opencode/messageConfirmed").unwrap();
    assert!(requested < confirmed, "the ID was recorded before it was sent: {kinds:?}");
    let d = lab.until("the run", |d| d.agent.status == "working").await;
    assert_eq!(turn(&d, &first)["status"], "inProgress", "busy, and nothing decided yet");

    // Its answer, then idle: completed.
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    let d = lab.until("completion", |d| turn(d, &first)["status"] == "completed").await;
    let replies = items(turn(&d, &first), "agentMessage");
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["text"], "Done.");
    assert_eq!(d.agent.status, "idle");

    // Idle with no answer to the prompt is not success.
    let second = lab.send("c2", "again").await.unwrap().turn_id.unwrap();
    lab.control("idle", json!({"sessionID":session})).await;
    let d = lab.until("the bare idle", |d| turn(d, &second)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &second)["status"], "outcomeUnknown");

    // A session error names no message: the Turn goes on until its own answer says.
    let third = lab.send("c3", "fail").await.unwrap().turn_id.unwrap();
    lab.control("error", json!({"sessionID":session})).await;
    let d = lab.until("the session error", |d| d.agent.error.is_some()).await;
    assert_eq!(turn(&d, &third)["status"], "inProgress");
    lab.control("reply", json!({"sessionID":session,"error":{"name":"APIError","data":{"message":"overloaded"}}})).await;
    let d = lab.until("the failure", |d| turn(d, &third)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &third)["status"], "failed");
    assert_eq!(turn(&d, &third)["error"]["message"], "overloaded");
    assert_eq!(lab.prompts().len(), 3, "each message once");

    // The same client message ID returns its first receipt; nothing is sent again.
    assert_eq!(lab.send("c1", "hello").await.unwrap().turn_id.as_deref(), Some(first.as_str()));
    assert_eq!(lab.prompts().len(), 3);
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn answers_go_only_to_the_session_and_process_that_asked() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    lab.send("c1", "work").await.unwrap();
    let asked = lab.control("ask", json!({"sessionID":session})).await;
    let d = lab.until("the request", |d| !d.pending.is_empty()).await;
    assert_eq!(d.agent.status, "waiting");
    let p = d.pending[0].clone();
    assert_eq!((p.method.as_str(), &p.params["id"]), ("opencode/permission", &asked["id"]));
    assert_eq!(p.params["patterns"], json!(["ls"]), "kept as OpenCode sent it");

    // `always` is not offered; once is, and goes to that request only.
    assert!(lab.ws.respond(&p.id, json!({"decision":"always"})).await.is_err());
    assert!(lab.posts("/permission/").is_empty());
    lab.ws.respond(&p.id, json!({"decision":"once"})).await.unwrap();
    let answered = lab.posts("/permission/");
    assert_eq!((answered[0]["path"].as_str().unwrap(), &answered[0]["body"]),
        (format!("/permission/{}/reply", asked["id"].as_str().unwrap()).as_str(), &json!({"reply":"once"})));
    lab.until("the answered request", |d| d.pending.is_empty()).await;

    let question = lab.control("question", json!({"sessionID":session})).await;
    let d = lab.until("the question", |d| !d.pending.is_empty()).await;
    assert!(lab.ws.respond(&d.pending[0].id, json!({"answers":[]})).await.is_err(), "one answer per question");
    lab.ws.respond(&d.pending[0].id, json!({"answers":[["A"]]})).await.unwrap();
    assert_eq!(lab.posts("/question/").last().unwrap()["path"], format!("/question/{}/reply", question["id"].as_str().unwrap()));

    // A request of a process that has ended is never answered to the next one.
    lab.control("ask", json!({"sessionID":session})).await;
    let stale = lab.until("the next request", |d| !d.pending.is_empty()).await.pending[0].clone();
    let old = lab.seen()["pid"].as_u64().unwrap();
    lab.control("die", json!({})).await;
    let d = lab.until("the lost connection", |d| d.agent.connection_state == "disconnected").await;
    assert!(d.pending.iter().all(|p| p.stale));
    assert!(d.turns.iter().all(|t| t["status"] != "inProgress"));
    assert!(ends(old).await);
    lab.ws.reconnect(ID).await.unwrap();
    assert_ne!(lab.seen()["pid"].as_u64().unwrap(), old);
    assert!(lab.ws.respond(&stale.id, json!({"decision":"once"})).await.is_err());
    assert_eq!(lab.posts("/permission/").len(), 1, "only the first answer was sent");
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn abort_asks_and_only_the_end_it_reports_ends_the_turn() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    // An abort whose run ends with no answer saying it was aborted: unknown.
    lab.control("mode", json!({"abortEvidence":false})).await;
    let first = lab.send("c1", "long").await.unwrap().turn_id.unwrap();
    lab.ws.interrupt(ID).await.unwrap();
    let d = lab.until("the bare end", |d| turn(d, &first)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &first)["status"], "outcomeUnknown");
    assert_eq!(turn(&d, &first)["interruptRequested"], true);
    // One whose answer says so: interrupted.
    lab.control("mode", json!({"abortEvidence":true})).await;
    let second = lab.send("c2", "long").await.unwrap().turn_id.unwrap();
    lab.ws.interrupt(ID).await.unwrap();
    let d = lab.until("the reported end", |d| turn(d, &second)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &second)["status"], "interrupted");
    assert_eq!(lab.posts(&format!("/session/{session}/abort")).len(), 2);
    assert!(lab.ws.interrupt(ID).await.is_err(), "nothing runs");
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn an_abort_is_read_in_the_order_opencode_reports_it() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let aborted_answer = |d: &AgentDetail, id: &str| turn(d, id)["_opencodeAnswers"].as_object()
        .is_some_and(|a| a.values().any(|x| x["error"]["name"] == "MessageAbortedError"));
    // OpenCode 1.19.3: the session's abort and idle come before the aborted answer.
    lab.control("mode", json!({"abortOrder":"native"})).await;
    let first = lab.send("c1", "long").await.unwrap().turn_id.unwrap();
    lab.ws.interrupt(ID).await.unwrap();
    let d = lab.until("the reported abort", |d| turn(d, &first)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &first)["status"], "interrupted");
    assert_eq!(turn(&d, &first)["error"]["native"]["name"], "MessageAbortedError");
    assert_eq!(d.agent.error, None, "an interrupt is not an error of the Agent");
    // The aborted answer arrives after; it changes nothing.
    let d = lab.until("the late answer", |d| aborted_answer(d, &first)).await;
    assert_eq!(turn(&d, &first)["status"], "interrupted");

    // Idle with no reported abort, the aborted answer only after: still unknown.
    lab.control("mode", json!({"abortOrder":"late"})).await;
    let second = lab.send("c2", "long").await.unwrap().turn_id.unwrap();
    lab.ws.interrupt(ID).await.unwrap();
    let d = lab.until("the bare idle", |d| turn(d, &second)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &second)["status"], "outcomeUnknown");
    let d = lab.until("the late answer", |d| aborted_answer(d, &second)).await;
    assert_eq!(turn(&d, &second)["status"], "outcomeUnknown", "not decided again after the Turn ended");

    // A run that completed before the interrupt reached it: completed, and nothing to abort.
    lab.control("mode", json!({"abortOrder":"native"})).await;
    let third = lab.send("c3", "quick").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    let d = lab.until("the answer", |d| turn(d, &third)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &third)["status"], "completed");
    assert!(lab.ws.interrupt(ID).await.is_err(), "nothing runs");

    // A session error that is not an abort, then idle without an answer: unknown, not interrupted.
    let fourth = lab.send("c4", "fail").await.unwrap().turn_id.unwrap();
    lab.control("error", json!({"sessionID":session})).await;
    lab.until("the session error", |d| d.agent.error.is_some()).await;
    lab.control("idle", json!({"sessionID":session})).await;
    let d = lab.until("the bare idle", |d| turn(d, &fourth)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &fourth)["status"], "outcomeUnknown");
    assert_eq!(lab.posts(&format!("/session/{session}/abort")).len(), 2);
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn a_run_halted_with_an_error_ends_as_opencode_reports_it() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let answered = |d: &AgentDetail, id: &str| turn(d, id)["_opencodeAnswers"].as_object()
        .is_some_and(|a| a.values().any(|x| x["error"].is_object()));
    // OpenCode 1.19.3 halts a run with these only when it ends: the session's
    // error and idle first, the answer carrying it after.
    for (n, name) in ["APIError", "ProviderAuthError", "MessageOutputLengthError"].into_iter().enumerate() {
        let id = lab.send(&format!("f{n}"), "work").await.unwrap().turn_id.unwrap();
        lab.control("halt", json!({"sessionID":session,"name":name,"message":"provider said no"})).await;
        let d = lab.until("the halted end", |d| turn(d, &id)["status"] != "inProgress").await;
        assert_eq!(turn(&d, &id)["status"], "failed", "{name}");
        assert_eq!(turn(&d, &id)["error"]["message"], "provider said no", "{name}");
        assert_eq!(turn(&d, &id)["error"]["native"]["name"], name);
        let d = lab.until("the late answer", |d| answered(d, &id)).await;
        assert_eq!(turn(&d, &id)["status"], "failed", "{name}: the answer after changes nothing");
    }
    // These are also reported while a run goes on (auto-compaction, a file
    // that could not be read): they decide nothing.
    for (n, name) in ["ContextOverflowError", "UnknownError"].into_iter().enumerate() {
        let id = lab.send(&format!("u{n}"), "work").await.unwrap().turn_id.unwrap();
        lab.control("halt", json!({"sessionID":session,"name":name})).await;
        let d = lab.until("the bare end", |d| turn(d, &id)["status"] != "inProgress").await;
        assert_eq!(turn(&d, &id)["status"], "outcomeUnknown", "{name}");
        let d = lab.until("the late answer", |d| answered(d, &id)).await;
        assert_eq!(turn(&d, &id)["status"], "outcomeUnknown", "{name}: not decided again after the Turn ended");
    }
    // A completed Turn: an error OpenCode reports afterwards belongs to no Turn.
    let done = lab.send("c1", "quick").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("the answer", |d| turn(d, &done)["status"] != "inProgress").await;
    lab.control("error", json!({"sessionID":session,"name":"APIError","message":"late"})).await;
    let d = lab.until("the late error", |d| d.agent.error.as_deref().is_some_and(|e| e.contains("late"))).await;
    assert_eq!(turn(&d, &done)["status"], "completed");
    assert!(turn(&d, &done)["_opencodeSessionError"].is_null(), "recorded on no Turn");
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn reopening_the_workspace_keeps_the_session_and_never_resends() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let receipt = lab.send("c1", "cut short").await.unwrap();
    let running = receipt.turn_id.unwrap();
    let old = lab.seen()["pid"].as_u64().unwrap();
    let Lab { dir, ws } = lab;
    // As when Core stops: the Workspace goes, and OpenCode with it.
    drop(ws);
    assert!(ends(old).await, "OpenCode ended with the Workspace");

    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let lab = Lab { dir, ws };
    let d = lab.ws.reconnect(ID).await.unwrap();
    assert_eq!(d.agent.connection_state, "connected");
    assert_eq!(d.agent.opencode_session_id.as_deref(), Some(session.as_str()), "the same session");
    assert_ne!(lab.seen()["pid"].as_u64().unwrap(), old);
    assert_eq!(lab.seen()["database"], json!(lab.root().join("opencode.db")));
    assert_eq!(turn(&d, &running)["status"], "outcomeUnknown", "its result is unknown, not resumed");
    assert_eq!(d.message_receipts[0].status, "accepted", "it was delivered");
    assert_eq!(lab.prompts().len(), 1, "never sent again");
    assert_eq!(lab.posts("/session").iter().filter(|c| c["path"] == "/session").count(), 1, "no second session");
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn a_broken_stream_is_reconciled_from_a_snapshot_once() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let first = lab.send("c1", "work").await.unwrap().turn_id.unwrap();
    // The stream breaks and cannot reopen at once; the answer comes meanwhile.
    lab.control("refuseEvents", json!({"seconds":0.4})).await;
    lab.control("drop", json!({})).await;
    lab.control("reply", json!({"sessionID":session,"text":"Missed it."})).await;
    let d = lab.until("the snapshot", |d| turn(d, &first)["status"] == "completed").await;
    assert_eq!(items(turn(&d, &first), "agentMessage").len(), 1);
    assert_eq!(d.agent.connection_state, "connected");
    // Again: the same snapshot changes nothing.
    lab.control("drop", json!({})).await;
    let resynced = |kinds: &[String]| kinds.iter().filter(|k| *k == "opencode/resynced").count();
    for _ in 0..200 {
        if resynced(&journal(&lab)) == 2 { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(resynced(&journal(&lab)), 2);
    let d = lab.detail();
    assert_eq!(turn(&d, &first)["status"], "completed");
    assert_eq!(items(turn(&d, &first), "agentMessage").len(), 1);
    assert_eq!(lab.prompts().len(), 1);
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn mcp_must_be_connected_before_a_message_goes_and_writes_name_the_session() {
    // OpenCode reports the Workspace MCP server failed: nothing is sent.
    let failed = lab(&[("mcp", "failed")], true).await;
    let added = failed.posts("/mcp");
    let config = &added[0]["body"]["config"];
    assert_eq!((config["type"].as_str(), config["oauth"].as_bool()), (Some("remote"), Some(false)));
    assert!(config["url"].as_str().unwrap().ends_with(&format!("/mcp/{ID}")));
    assert!(config["headers"]["Authorization"].as_str().unwrap().starts_with("Bearer "));
    let status = failed.ws.collaboration_status(ID).await.unwrap();
    assert!(!status.ready && status.error.unwrap().contains("failed"));
    let refused = failed.send("c1", "hello").await.unwrap_err();
    assert!(refused.to_string().contains("协作连接"), "{refused}");
    assert!(failed.prompts().is_empty());
    assert!(failed.detail().message_receipts.is_empty(), "refused before any receipt");
    // No permission rule anywhere: not on the session, not in a prompt.
    assert!(failed.calls().iter().all(|c| c["method"] != "PATCH"));
    assert_eq!(failed.posts("/session")[0]["body"], json!({"title":"OpenCode"}));
    failed.ws.close_agent(ID).await.unwrap();

    // Connected: ready, and what the Agent writes names its session and Turn.
    let ready = lab(&[], true).await;
    assert!(ready.ws.collaboration_status(ID).await.unwrap().ready);
    let running = ready.send("c1", "hello").await.unwrap().turn_id.unwrap();
    let created = ready.ws.store.collaboration_call(Some(ID), "task_create", json!({"requestId":"r1","title":"From OpenCode"})).unwrap();
    assert_eq!(created["activity"]["source"], json!({"agentId":ID,"turnId":running,"sessionId":ready.session()}));
    ready.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn http_create_and_models_refuse_opencode_unless_core_turned_it_on() {
    let lab = lab(&[], false).await;
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4317);
    let request = |method: &str, uri: &str, body: Value| Request::builder().method(method).uri(uri)
        .header("host", "localhost:4317").header("x-yuzuno-client", "desktop")
        .header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
    for (method, uri, body) in [
        ("POST", "/api/agents", json!({"name":"O","harness":"opencode","cwd":lab.dir.path()})),
        ("GET", "/api/models?harness=opencode", Value::Null),
    ] {
        let response = router.clone().oneshot(request(method, uri, body)).await.unwrap();
        let status = response.status();
        let text = String::from_utf8(to_bytes(response.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap();
        assert!(!status.is_success() && text.contains("未知 Harness"), "{uri}: {status} {text}");
    }
    let response = router.clone().oneshot(request("GET", "/api/workspace", Value::Null)).await.unwrap();
    let workspace: Value = serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(workspace["opencode"]["enabled"], false, "the UI offers none");
    assert_eq!(lab.ws.store.agents().unwrap().len(), 1);
    lab.ws.close_agent(ID).await.unwrap();
}

/// What an OpenCode tool runs is in a session of its own, out of OpenCode's
/// group: closing the Agent, and a Core that stops normally, ask OpenCode to
/// end it first. Only that Agent's OpenCode is asked, and the end of its
/// stream that follows is neither a break nor a reason to connect again.
#[tokio::test]
async fn closing_or_stopping_core_ends_what_opencodes_tools_run_and_only_that_agents() {
    const OTHER: &str = "oc2";
    let lab = lab(&[("tool", "1")], false).await;
    let session = lab.session();
    let other_root = lab.dir.path().join("data/opencode").join(OTHER);
    std::fs::create_dir_all(&other_root).unwrap();
    std::fs::write(other_root.join("tool"), "1").unwrap();
    let mut other = agent(&lab.dir.path().join("work").to_string_lossy());
    other.agent.id = OTHER.into();
    lab.ws.store.insert(&other).unwrap();
    assert_eq!(lab.ws.reconnect(OTHER).await.unwrap().agent.connection_state, "connected");
    let pid = |seen: &Value, key: &str| seen[key].as_u64().unwrap();
    let other_seen: Value = serde_json::from_str(&std::fs::read_to_string(other_root.join("start.json")).unwrap()).unwrap();
    let kinds = |agent: &str| {
        let db = rusqlite::Connection::open(lab.dir.path().join("data/workspace.sqlite")).unwrap();
        let mut query = db.prepare("SELECT kind FROM journal WHERE agent_id=?1 ORDER BY seq").unwrap();
        query.query_map([agent], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect::<Vec<_>>()
    };
    let breaks = |kinds: &[String]| kinds.iter().filter(|k| matches!(k.as_str(),
        "opencode/resynced" | "runtime/error" | "opencode/connecting" | "opencode/ready")).count();

    let before = kinds(ID);
    lab.ws.close_agent(ID).await.unwrap();
    assert!(ends(pid(&lab.seen(), "tool")).await, "the tool's process outlived the close");
    assert!(ends(pid(&lab.seen(), "pid")).await);
    assert_eq!(lab.posts("/global/dispose").len(), 1);
    // Long enough for a reaction to the stream's end to be recorded.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let after = kinds(ID);
    assert!(after.contains(&"opencode/closed".to_owned()));
    assert_eq!(breaks(&after), breaks(&before), "{:?}", &after[before.len()..]);
    let d = lab.detail();
    assert_eq!(d.agent.connection_state, "disconnected");
    assert_eq!(d.agent.opencode_session_id.as_deref(), Some(session.as_str()), "the session is kept");

    // The other Agent's OpenCode and its tool were not touched.
    assert!(!ended(pid(&other_seen, "tool")) && !ended(pid(&other_seen, "pid")));
    assert_eq!(lab.ws.store.detail(OTHER).unwrap().agent.connection_state, "connected");

    // Core stops normally: it is asked too, and nothing is recorded for it.
    let before = kinds(OTHER);
    lab.ws.opencode_stop_all().await;
    assert!(ends(pid(&other_seen, "tool")).await, "the tool's process outlived Core's stop");
    assert!(ends(pid(&other_seen, "pid")).await);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(kinds(OTHER), before);
}

/// `view=summary` for an OpenCode Agent: only the Agent, from the same
/// connection and session; nothing is sent again and the history stays.
#[tokio::test]
async fn a_summary_reconnect_answers_with_the_agent_only() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let sent = lab.send("c1", "work").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("the answer", |d| d.turns.iter().any(|t| t["id"] == sent.as_str() && t["status"] == "completed")).await;
    let pid = lab.seen()["pid"].as_u64().unwrap();
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4317);
    let request = Request::post(format!("/api/agents/{ID}/reconnect?view=summary")).header("host", "localhost:4317")
        .header("x-yuzuno-client", "desktop").header("content-type", "application/json").body(Body::from("{}")).unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert!(response.status().is_success());
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(body.as_object().unwrap().keys().collect::<Vec<_>>(), ["agent"], "{body}");
    assert_eq!(body["agent"]["connectionState"], "connected");
    assert_eq!(body["agent"]["opencodeSessionId"], session.as_str());
    assert_eq!(lab.seen()["pid"].as_u64().unwrap(), pid, "the same OpenCode");
    assert_eq!(lab.prompts().len(), 1, "never sent again");
    let d = lab.detail();
    assert_eq!(turn(&d, &sent)["status"], "completed");
    assert_eq!(items(turn(&d, &sent), "agentMessage").len(), 1);
    lab.ws.close_agent(ID).await.unwrap();
}

/// A closed OpenCode Agent is refused a reconnect before any OpenCode starts;
/// reopening reconnects it to the same session, and nothing is sent again.
#[tokio::test]
async fn a_closed_opencode_agent_is_refused_before_anything_starts() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    lab.ws.close_agent(ID).await.unwrap();
    let pid = lab.seen()["pid"].as_u64().unwrap();
    for refused in [lab.ws.reconnect(ID).await.map(drop), lab.ws.reconnect_summary(ID).await.map(drop)] {
        let error = refused.unwrap_err();
        assert!(error.to_string().contains("已关闭"), "{error}");
    }
    assert_eq!(lab.seen()["pid"].as_u64().unwrap(), pid, "no OpenCode was started");
    let reopened = lab.ws.reopen_agent_summary(ID).await.unwrap();
    assert!(reopened.closed_at.is_none());
    assert_eq!(reopened.opencode_session_id.as_deref(), Some(session.as_str()), "the same session");
    assert_ne!(lab.seen()["pid"].as_u64().unwrap(), pid, "a new OpenCode for it");
    assert_eq!(lab.detail().agent.connection_state, "connected");
    assert!(lab.prompts().is_empty(), "nothing was sent");
    lab.ws.close_agent(ID).await.unwrap();
}
