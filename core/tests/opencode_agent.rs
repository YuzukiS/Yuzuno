//! OpenCode Agents (T-110 S1b) through the Workspace, against the stand-in
//! `opencode serve` (tests/fixtures/opencode_server.py, run by
//! /usr/bin/python3): the record as the store keeps it and readers read it.
//! No OpenCode, account, model or network service is used. This Core has not
//! turned OpenCode on, so nothing creates an OpenCode Agent and each test
//! inserts one, as other tests do (tests/opencode_entry.rs creates them).
#![cfg(target_os = "linux")]

#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use axum::{body::{to_bytes, Body}, http::Request};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, OnceLock}, time::Duration};
use tower::ServiceExt;
use yuzuno_workspace::{model::{AgentDetail, MessageInput}, server, workspace::Workspace};
use yuzuno_workspace::opencode_login::{KeyLogin, OAuthLogin};

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

    /// The models made the session's (`POST /api/session/:id/model`, T-32 slice 4a), in order: each body.
    fn switches(&self) -> Vec<Value> {
        self.posts(&format!("/api/session/{}/model", self.session())).into_iter().map(|c| c["body"].clone()).collect()
    }

    fn prompts(&self) -> Vec<Value> {
        self.calls().into_iter().filter(|c| c["path"].as_str().unwrap().ends_with("/prompt")).collect()
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

    /// A message added to the running Turn `running` ("send while working").
    async fn add(&self, client: &str, text: &str, running: &str) -> anyhow::Result<yuzuno_workspace::model::MessageReceipt> {
        let input: MessageInput = serde_json::from_value(json!({"clientMessageId":client,"text":text,"expectedTurnId":running})).unwrap();
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

/// An OpenCode Agent made with 1.19.3, the release Core pinned before T-32
/// (a record with a session and no `opencodeVersion`), is kept to read: it is never started,
/// so that 2.x never opens, and so migrates, its database; asking it for
/// anything says why, and its conversation stays in Core's record.
#[tokio::test]
async fn an_agent_made_with_1x_is_kept_to_read_and_never_started() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    let mut old = agent(&work.to_string_lossy());
    old.agent.opencode_version = None;
    old.agent.opencode_major = None;
    old.agent.opencode_session_id = Some("ses_made_with_1x".into());
    old.turns = vec![json!({"id": "msg_1", "status": "completed", "items": [
        {"id": "u1", "type": "userMessage", "content": [{"type": "text", "text": "Kept"}]},
        {"id": "a1", "type": "agentMessage", "text": "Read."}]})];
    ws.store.insert(&old).unwrap();
    let why = "是用 OpenCode 1.19.3 创建的，只能阅读";
    let reconnected = ws.reconnect(ID).await.map(|_| ()).expect_err("not reconnected").to_string();
    let started = dir.path().join("data/opencode").join(ID).join("start.json");
    assert!(!started.exists(), "OpenCode never started for it");
    assert!(reconnected.contains(why), "{reconnected}");
    let sent = ws.send(ID, "next".into()).await.map(|_| ()).expect_err("not sent").to_string();
    assert!(sent.contains(why), "{sent}");
    assert!(!started.exists(), "nor for a message");
    let kept = ws.store.detail(ID).unwrap();
    assert_eq!(kept.turns.len(), 1, "its conversation stays readable");
    assert_eq!(kept.agent.opencode_session_id.as_deref(), Some("ses_made_with_1x"));
}

/// An Agent whose 1.19.3 started and made its database, but whose session
/// never reached the record, has nothing of Core's in it. 2.x never opens
/// that database: it is moved aside, never deleted, and 2.x starts on a new
/// one (R2 f9cbccce of #575). No login goes with it: its credentials are
/// scrubbed before it is moved, its other rows kept (T-32 slice 4b, D6).
#[tokio::test]
async fn a_database_no_recorded_session_is_in_is_moved_aside_before_2x_starts() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let root = dir.path().join("data/opencode").join(ID);
    std::fs::create_dir_all(&root).unwrap();
    {
        let made = rusqlite::Connection::open(root.join("opencode.db")).unwrap();
        made.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT); INSERT INTO session VALUES ('ses_old');
            CREATE TABLE credential (id TEXT, value TEXT); INSERT INTO credential VALUES ('crd_1', 'fixture-set-aside-secret');").unwrap();
    }
    std::fs::create_dir(root.join("set-aside-1")).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&work.to_string_lossy())).unwrap();
    let d = ws.reconnect(ID).await.unwrap();
    assert_eq!(d.agent.connection_state, "connected");
    let holds = |path: &std::path::Path, text: &[u8]| std::fs::read(path).is_ok_and(|bytes| bytes.windows(text.len()).any(|w| w == text));
    assert!(!holds(&root.join("opencode.db"), b"ses_old"), "2.x never opens the database no recorded session is in");
    let aside = root.join("set-aside-2");
    {
        let kept = rusqlite::Connection::open(aside.join("opencode.db")).unwrap();
        assert_eq!(kept.query_row("SELECT id FROM session", [], |r| r.get::<_, String>(0)).unwrap(), "ses_old", "kept beside it, its sessions whole");
        assert_eq!(kept.query_row("SELECT count(*) FROM credential", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "no login left in it");
    }
    for entry in std::fs::read_dir(&aside).unwrap() {
        let path = entry.unwrap().path();
        assert!(!holds(&path, b"fixture-set-aside-secret"), "no login's bytes beside it: {}", path.display());
    }
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(root.join("start.json")).unwrap()).unwrap();
    assert_eq!(seen["database"], &*root.join("opencode.db").to_string_lossy(), "2.x got the same path, now free");
    let kept = ws.store.detail(ID).unwrap();
    assert_eq!(kept.agent.opencode_major.as_deref(), Some("2"), "made by 2.x now");
    assert!(kept.agent.opencode_session_id.is_some());
    let db = rusqlite::Connection::open(dir.path().join("data/workspace.sqlite")).unwrap();
    let said: Vec<Value> = db.prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind='opencode/setAside'").unwrap()
        .query_map([ID], |r| r.get::<_, String>(0)).unwrap().map(|data| serde_json::from_str(&data.unwrap()).unwrap()).collect();
    assert_eq!(said, vec![json!({"folder": aside})], "the record says where it went");
}

/// A WAL left without its database can't be read as one, and never stops a
/// start (R1 dd77b02d of #621): overwritten with zeros and removed before
/// 2.x starts, nothing of it moved aside, and the record notes it.
#[tokio::test]
async fn a_wal_left_without_its_database_is_overwritten_and_removed_and_2x_starts() {
    program();
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let root = dir.path().join("data/opencode").join(ID);
    std::fs::create_dir_all(&root).unwrap();
    let left = b"pages of fixture-orphan-secret";
    std::fs::write(root.join("opencode.db-wal"), left).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&work.to_string_lossy())).unwrap();
    let started = ws.reconnect(ID).await.map(|d| d.agent.connection_state).map_err(|e| e.to_string());
    assert_eq!(started.as_deref(), Ok("connected"), "the start proceeds past a WAL left without its database");
    assert!(!root.join("set-aside-1").exists(), "nothing of it moved aside");
    assert_eq!(file_holding(&root, "fixture-orphan-secret"), None, "none of its bytes left in the Agent's folder");
    let db = rusqlite::Connection::open(dir.path().join("data/workspace.sqlite")).unwrap();
    let said: Vec<Value> = db.prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind='opencode/leftoverDestroyed'").unwrap()
        .query_map([ID], |r| r.get::<_, String>(0)).unwrap().map(|data| serde_json::from_str(&data.unwrap()).unwrap()).collect();
    assert_eq!(said, vec![json!({"file":"opencode.db-wal","bytes":left.len(),"why":"orphan_wal"})], "the record notes what was destroyed");
    ws.close_agent(ID).await.unwrap();
}

/// An Agent's OpenCode keeps its data and state in the Agent's own folder
/// and its downloads in the cache Core's Agents share, never the user's;
/// its config stays the user's. It checks for no update and fetches no
/// models list of its own (T-32, Lead 4870).
#[tokio::test]
async fn an_agents_opencode_keeps_its_data_and_state_its_own_and_fetches_nothing_of_its_own() {
    let lab = lab(&[], false).await;
    let opencode = lab.dir.path().join("data/opencode");
    let own = opencode.join(ID).join("xdg");
    let path = |p: PathBuf| json!(p.to_string_lossy());
    assert_eq!(lab.seen()["env"], json!({
        "XDG_DATA_HOME": path(own.join("data")), "XDG_STATE_HOME": path(own.join("state")),
        "XDG_CACHE_HOME": path(opencode.join("cache")), "XDG_CONFIG_HOME": std::env::var("XDG_CONFIG_HOME").ok(),
        "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_MODELS_FETCH": "1",
    }), "its folders and switches as Core started it");
    use std::os::unix::fs::PermissionsExt;
    for folder in [opencode.join(ID), opencode.join("cache")] {
        assert_eq!(std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777, 0o700, "{} is Core's alone", folder.display());
    }
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
    assert_eq!(prompts[0]["body"], json!({"id":first,"text":"hello"}), "no model, agent, tools or permission rule is sent");
    assert!(lab.switches().is_empty(), "OpenCode's own model: the session's is left as it is");
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

    // A failed step names its answer: the Turn ends as it says. (1.19.3's
    // session error while a run went on, which decided nothing, has no 2.x
    // counterpart: 2.x reports one only with the execution's end. T-32 slice 3b.)
    let third = lab.send("c3", "fail").await.unwrap().turn_id.unwrap();
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

/// The conversation window the web reads (`conversation_window::project`, not
/// the HTTP route, whose router starts collaboration): the client IDs of its
/// user messages are what a delivery preview waits for.
fn window_client_ids(d: &AgentDetail) -> Value {
    use yuzuno_workspace::conversation_window::{project, Query};
    let mut d = d.clone();
    let query = Query { view: Some("window".into()), before: None, after: None, turn_id: None, item_id: None };
    let metadata = project(&mut d, &query).unwrap_or_else(|_| panic!("no window"));
    metadata["nativeClientIds"].clone()
}

/// A message OpenCode stored is its Turn's user message, under the client ID
/// it was sent with, as a Codex or Claude message is (T-120): the delivery
/// preview, waiting for that ID, gives way to it, and the receipt is bound to
/// it, which restores its pasted text blocks onto it. Stored only later, it
/// gets the ID then. One refused stays refused, even if OpenCode later shows
/// it stored, and one not confirmed stays uncertain: neither gets the ID. All
/// of it is in the rows: the Workspace opened again reads it the same.
#[tokio::test]
async fn a_stored_message_is_its_turns_user_message_under_its_client_id() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let blocks = json!([{"id":"b","start":0,"end":5}]);
    let input: MessageInput = serde_json::from_value(json!({"clientMessageId":"c1","text":"hello world","textBlocks":blocks})).unwrap();
    let receipt = lab.ws.send_message(ID, input).await.unwrap();
    assert_eq!(receipt.status, "accepted");
    let first = receipt.turn_id.unwrap();
    let d = lab.detail();
    let users = items(turn(&d, &first), "userMessage");
    assert_eq!((users.len(), &users[0]["clientId"]), (1, &json!("c1")));
    assert_eq!(users[0]["_yuzunoTextBlocks"], blocks, "its pasted text blocks, restored by its receipt");
    let binding = d.message_receipts[0].binding.as_ref().map(|b| (b.turn_id.clone(), b.user_index));
    assert_eq!(binding, Some((first.clone(), 0)), "the receipt is bound to it");
    assert_eq!(window_client_ids(&d), json!(["c1"]));
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &first)["status"] == "completed").await;

    // Refused (HTTP 400): rejected, and no client ID, even once OpenCode
    // shows a message of that ID stored.
    let mut fail = serde_json::Map::new();
    fail.insert(format!("/api/session/{session}/prompt"), json!(400));
    lab.control("mode", json!({"fail":fail})).await;
    let refused = lab.send("c3", "no").await.unwrap();
    assert_eq!(refused.status, "rejected");
    let third = refused.turn_id.unwrap();
    lab.control("mode", json!({"fail":{}})).await;
    lab.control("store", json!({"sessionID":session,"messageID":third,"text":"no"})).await;
    let d = lab.until("the stored refusal", |d| turn(d, &third)["_opencodeConfirmed"] == true).await;
    assert_eq!(d.message_receipts[1].status, "rejected");
    assert!(items(turn(&d, &third), "userMessage")[0].get("clientId").is_none());

    // Answered, but not stored: uncertain, and its message has no client ID.
    lab.control("mode", json!({"prompt":"unstored"})).await;
    let lost = lab.send("c2", "later").await.unwrap();
    assert_eq!(lost.status, "uncertain");
    let second = lost.turn_id.unwrap();
    let d = lab.detail();
    assert!(items(turn(&d, &second), "userMessage")[0].get("clientId").is_none());
    assert_eq!(window_client_ids(&d), json!(["c1"]), "its preview still says it is unconfirmed");

    // OpenCode reports it stored after all: accepted, under its client ID.
    lab.control("store", json!({"sessionID":session,"messageID":second,"text":"later"})).await;
    let d = lab.until("the late confirmation", |d| d.message_receipts[2].status == "accepted").await;
    assert_eq!(items(turn(&d, &second), "userMessage")[0]["clientId"], "c2");
    assert_eq!(window_client_ids(&d), json!(["c1", "c2"]));
    assert_eq!(lab.prompts().len(), 3, "each message once");

    // Read again from the rows, by the Workspace opened again.
    let old = lab.seen()["pid"].as_u64().unwrap();
    let Lab { dir, ws } = lab;
    drop(ws);
    assert!(ends(old).await, "OpenCode ended with the Workspace");
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let d = ws.store.detail(ID).unwrap();
    let message = |turn_id: &str| items(turn(&d, turn_id), "userMessage")[0].clone();
    assert_eq!((&message(&first)["clientId"], &message(&first)["_yuzunoTextBlocks"]), (&json!("c1"), &blocks));
    assert_eq!(message(&second)["clientId"], "c2");
    assert!(message(&third).get("clientId").is_none());
    let bound: Vec<_> = d.message_receipts.iter()
        .map(|r| (r.input.client_message_id.as_str(), r.status.as_str(), r.binding.as_ref().map(|b| b.turn_id.clone()))).collect();
    assert_eq!(bound, [("c1", "accepted", Some(first.clone())), ("c3", "rejected", None), ("c2", "accepted", Some(second.clone()))]);
    assert_eq!(window_client_ids(&d), json!(["c1", "c2"]));
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
    assert_eq!(lab.posts(&format!("/api/session/{session}/interrupt")).len(), 2, "interrupted through 2.x's own route");
    assert!(lab.ws.interrupt(ID).await.is_err(), "nothing runs");
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn an_abort_is_read_in_the_order_opencode_reports_it() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let aborted_answer = |d: &AgentDetail, id: &str| turn(d, id)["_opencodeAnswers"].as_object()
        .is_some_and(|a| a.values().any(|x| x["error"]["name"] == "MessageAbortedError"));
    // 2.x reports an abort with the execution's end, `session.execution.interrupted`
    // (T-32 slice 3b); 1.19.3's orders of the aborted answer and the idle have
    // no 2.x counterpart. Its aborted answer comes first, then that end.
    let _ = aborted_answer;
    for order in ["answer-first", "native"] {
        lab.control("mode", json!({"abortOrder":order})).await;
        let first = lab.send(&format!("c1-{order}"), "long").await.unwrap().turn_id.unwrap();
        lab.ws.interrupt(ID).await.unwrap();
        let d = lab.until("the reported abort", |d| turn(d, &first)["status"] != "inProgress").await;
        assert_eq!(turn(&d, &first)["status"], "interrupted", "{order}");
        assert_eq!(turn(&d, &first)["error"]["native"]["name"], "MessageAbortedError", "{order}");
        assert_eq!(d.agent.error, None, "an interrupt is not an error of the Agent");
    }

    // A run that completed before the interrupt reached it: completed, and nothing to abort.
    lab.control("mode", json!({"abortOrder":"native"})).await;
    let third = lab.send("c3", "quick").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    let d = lab.until("the answer", |d| turn(d, &third)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &third)["status"], "completed");
    assert!(lab.ws.interrupt(ID).await.is_err(), "nothing runs");

    // An execution that failed, with no answer: failed, with its error, not interrupted.
    let fourth = lab.send("c4", "fail").await.unwrap().turn_id.unwrap();
    lab.control("error", json!({"sessionID":session})).await;
    lab.control("idle", json!({"sessionID":session})).await;
    let d = lab.until("the failed end", |d| turn(d, &fourth)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &fourth)["status"], "failed");
    assert!(d.agent.error.is_some(), "a failed execution is an error of the Agent");
    assert_eq!(lab.posts(&format!("/api/session/{session}/interrupt")).len(), 2);
    lab.ws.close_agent(ID).await.unwrap();
}

#[tokio::test]
async fn a_run_halted_with_an_error_ends_as_opencode_reports_it() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let answered = |d: &AgentDetail, id: &str| turn(d, id)["_opencodeAnswers"].as_object()
        .is_some_and(|a| a.values().any(|x| x["error"].is_object()));
    // 2.x ends a run that failed with `session.execution.failed`, carrying
    // its error: the Turn fails with it, whatever its type (T-32 slice 3b).
    // 1.19.3's errors that decided nothing while a run went on have no 2.x
    // counterpart, nor has an answer after the run's end.
    let _ = answered;
    for (n, name) in ["APIError", "ProviderAuthError", "ContextOverflowError", "UnknownError"].into_iter().enumerate() {
        let id = lab.send(&format!("f{n}"), "work").await.unwrap().turn_id.unwrap();
        lab.control("halt", json!({"sessionID":session,"name":name,"message":"provider said no"})).await;
        let d = lab.until("the halted end", |d| turn(d, &id)["status"] != "inProgress").await;
        assert_eq!(turn(&d, &id)["status"], "failed", "{name}");
        assert_eq!(turn(&d, &id)["error"]["message"], "provider said no", "{name}");
        assert_eq!(turn(&d, &id)["error"]["native"]["name"], "ExecutionFailed", "{name}");
        assert_eq!(turn(&d, &id)["error"]["native"]["data"]["type"], name, "2.x's own type, kept");
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

/// Closing an Agent whose server something else still holds (a request
/// still out, here a read of its models) waits for 2.x's teardown, within
/// TEARDOWN. 2.x closes what it serves first, so that request fails and lets
/// go of the server, and only then ends what its tools run: no kill of the
/// group by the last holder cuts that short (R1 070d0f95 of #575).
#[tokio::test]
async fn closing_waits_for_the_teardown_even_while_a_request_still_holds_the_server() {
    let lab = lab(&[("tool", "1"), ("teardown", "2"), ("closeStreamsFirst", "1")], false).await;
    let (tool, pid) = (lab.seen()["tool"].as_u64().unwrap(), lab.seen()["pid"].as_u64().unwrap());
    lab.control("mode", json!({"slow": {"/api/model": 30}})).await;
    let ws = lab.ws.clone();
    let read = tokio::spawn(async move { ws.opencode_agent_catalog(ID).await.map(drop) });
    for _ in 0..200 {
        if lab.calls().iter().any(|c| c["path"] == "/api/model") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(lab.calls().iter().any(|c| c["path"] == "/api/model"), "the read is out, holding the server");
    lab.ws.close_agent(ID).await.unwrap();
    let ended = ends(tool).await;
    if !ended {
        // Not left behind by a red run: its session is its own group.
        let _ = std::process::Command::new("kill").args(["-KILL", &format!("-{tool}")]).status();
    }
    assert!(ended, "the tool's process ended in OpenCode's own teardown, not cut short by a kill of its group");
    assert!(ends(pid).await, "OpenCode ended");
    assert!(read.await.unwrap().is_err(), "the read was cut by OpenCode's teardown");
}

/// An Agent's database is made by its first 2.x server (T-32): the version
/// that server reported is kept with its session, and stays when a later 2.x
/// runs it. Its models say which OpenCode it runs, and note one newer than
/// the verified release.
#[tokio::test]
async fn the_version_an_agents_database_was_made_with_is_kept_and_a_newer_one_is_noted() {
    let lab = lab(&[("version", "2.9.1")], false).await;
    assert_eq!(lab.detail().agent.opencode_version.as_deref(), Some("2.9.1"), "kept with its session");
    assert_eq!(lab.detail().agent.opencode_major.as_deref(), Some("2"), "with the major Core parsed from it");
    let catalog = lab.ws.opencode_agent_catalog(ID).await.unwrap();
    assert_eq!(catalog["opencode"], json!({"version": "2.9.1", "verified": "2.2.5", "note": "newer than the verified 2.2.5"}));
    let Lab { dir, ws } = lab;
    drop(ws);
    // A later start, with the verified release: the version it was made with stays; nothing is noted.
    std::fs::write(dir.path().join("data/opencode").join(ID).join("version"), "2.2.5").unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let lab = Lab { dir, ws };
    assert_eq!(lab.ws.reconnect(ID).await.unwrap().agent.opencode_version.as_deref(), Some("2.9.1"), "the one it was made with");
    let catalog = lab.ws.opencode_agent_catalog(ID).await.unwrap();
    assert_eq!(catalog["opencode"], json!({"version": "2.2.5", "verified": "2.2.5"}));
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
    assert_eq!(lab.posts("/api/session").iter().filter(|c| c["path"] == "/api/session").count(), 1, "no second session");
    lab.ws.close_agent(ID).await.unwrap();
}

/// After Core restarts with a Turn running, a message to that Agent is not a
/// message to a busy OpenCode: it connects the same session again, which
/// settles the Turn, and it is not sent; sent again, it goes. Each Agent
/// comes back only when asked, with its own session, process and Workspace
/// MCP credential. Before the restart, a busy Agent refuses as ever.
#[tokio::test]
async fn after_a_restart_a_message_connects_the_session_again_and_goes_only_when_sent_again() {
    const OTHER: &str = "oc2";
    fn seen(root: &std::path::Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(root.join("start.json")).unwrap()).unwrap()
    }
    fn calls(root: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(root.join("calls.jsonl")).unwrap_or_default()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }
    fn prompts(root: &std::path::Path) -> usize {
        calls(root).iter().filter(|c| c["path"].as_str().unwrap().ends_with("/prompt")).count()
    }
    /// The credential each Workspace MCP registration handed OpenCode, in order.
    fn credentials(root: &std::path::Path) -> Vec<Value> {
        calls(root).into_iter().filter(|c| c["method"] == "POST" && c["path"] == "/mcp")
            .map(|c| c["body"]["config"]["headers"]["Authorization"].clone()).collect()
    }
    async fn send_to(ws: &Arc<Workspace>, agent_id: &str, client: &str) -> anyhow::Result<yuzuno_workspace::model::MessageReceipt> {
        let input: MessageInput = serde_json::from_value(json!({"clientMessageId":client,"text":"after"})).unwrap();
        ws.send_message(agent_id, input).await
    }

    let lab = lab(&[], true).await;
    let (a_root, b_root) = (lab.root(), lab.dir.path().join("data/opencode").join(OTHER));
    std::fs::create_dir_all(&b_root).unwrap();
    let mut other = agent(&lab.dir.path().join("work").to_string_lossy());
    other.agent.id = OTHER.into();
    lab.ws.store.insert(&other).unwrap();
    assert_eq!(lab.ws.reconnect(OTHER).await.unwrap().agent.connection_state, "connected");
    let (a_session, b_session) = (lab.session(), lab.ws.store.detail(OTHER).unwrap().agent.opencode_session_id.unwrap());
    let a_running = lab.send("a1", "work").await.unwrap().turn_id.unwrap();
    let b_running = send_to(&lab.ws, OTHER, "b1").await.unwrap().turn_id.unwrap();
    // Connected and busy: refused as before, and nothing else happens.
    let busy = lab.send("a-busy", "more").await.unwrap_err();
    assert!(busy.to_string().contains("OpenCode 正在执行或等待回应"), "{busy}");
    assert_eq!(prompts(&a_root), 1);
    let (a_pid, b_pid) = (seen(&a_root)["pid"].as_u64().unwrap(), seen(&b_root)["pid"].as_u64().unwrap());
    let (a_before, b_before) = (credentials(&a_root), credentials(&b_root));
    let Lab { dir, ws } = lab;
    // As when Core stops: the Workspace goes, and each OpenCode with it.
    drop(ws);
    assert!(ends(a_pid).await && ends(b_pid).await, "OpenCode ended with the Workspace");

    let ws = Workspace::new(dir.path().join("data"), dir.path().join("work").to_string_lossy().into(), "unused".into()).unwrap();
    ws.start_collaboration(4999);
    let lab = Lab { dir, ws };
    let d = lab.detail();
    assert_eq!((d.agent.connection_state.as_str(), d.agent.status.as_str()), ("disconnected", "offline"));
    assert_eq!(turn(&d, &a_running)["status"], "inProgress", "opening the Workspace changes no Turn");

    // The first message: the same session again, its Turn settled, and the
    // message not sent: no receipt, no prompt, no second session.
    let checked = lab.send("a2", "after").await.unwrap_err();
    assert!(checked.to_string().contains("已重新核对原会话；本次消息没有发送"), "{checked}");
    let d = lab.detail();
    assert_eq!(d.agent.connection_state, "connected");
    assert_eq!(d.agent.opencode_session_id.as_deref(), Some(a_session.as_str()), "the same session");
    assert_ne!(seen(&a_root)["pid"].as_u64().unwrap(), a_pid);
    assert_eq!(turn(&d, &a_running)["status"], "outcomeUnknown");
    let clients: Vec<&str> = d.message_receipts.iter().map(|r| r.input.client_message_id.as_str()).collect();
    assert_eq!(clients, ["a1"], "nothing recorded for the message not sent");
    assert_eq!(prompts(&a_root), 1, "not sent");
    assert_eq!(lab.posts("/api/session").iter().filter(|c| c["path"] == "/api/session").count(), 1, "no second session");
    // Sent again, it goes.
    let receipt = lab.send("a2", "after").await.unwrap();
    assert_eq!(receipt.status, "accepted");
    assert_eq!(prompts(&a_root), 2);

    // The other Agent was left as it was, until a message (through `send`) asks.
    let b = lab.ws.store.detail(OTHER).unwrap();
    assert_eq!(b.agent.connection_state, "disconnected");
    assert_eq!(turn(&b, &b_running)["status"], "inProgress");
    assert_eq!(seen(&b_root)["pid"].as_u64().unwrap(), b_pid, "no OpenCode was started for it");
    let checked = lab.ws.send(OTHER, "after".into()).await.unwrap_err();
    assert!(checked.to_string().contains("已重新核对原会话；本次消息没有发送"), "{checked}");
    let b = lab.ws.store.detail(OTHER).unwrap();
    assert_eq!(b.agent.opencode_session_id.as_deref(), Some(b_session.as_str()), "its own session");
    assert_eq!(turn(&b, &b_running)["status"], "outcomeUnknown");
    assert_eq!(prompts(&b_root), 1, "not sent");
    let b_now = seen(&b_root)["pid"].as_u64().unwrap();
    assert!(b_now != b_pid && b_now != seen(&a_root)["pid"].as_u64().unwrap(), "a process of its own");
    // Each was handed a new credential of its own.
    let (a_after, b_after) = (credentials(&a_root), credentials(&b_root));
    assert_eq!((a_after.len(), b_after.len()), (a_before.len() + 1, b_before.len() + 1));
    let (a_new, b_new) = (a_after.last().unwrap(), b_after.last().unwrap());
    assert!(a_new.is_string() && a_new != b_new && !a_before.contains(a_new) && !b_before.contains(b_new));
    assert!(lab.ws.collaboration_status(ID).await.unwrap().ready && lab.ws.collaboration_status(OTHER).await.unwrap().ready);
    let sent = send_to(&lab.ws, OTHER, "b2").await.unwrap().turn_id.unwrap();
    let created = lab.ws.store.collaboration_call(Some(OTHER), "task_create", json!({"requestId":"from-b","title":"From B"})).unwrap();
    assert_eq!(created["activity"]["source"], json!({"agentId":OTHER,"turnId":sent,"sessionId":b_session}));
    assert_eq!(prompts(&b_root), 2);
    lab.ws.close_agent(ID).await.unwrap();
    lab.ws.close_agent(OTHER).await.unwrap();
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

/// A sub-agent OpenCode starts (its `task` tool) asks in a session of its own
/// (T-10). Its requests are shown with the sub-agent that asks and answered
/// in that session; nothing else of it ends the Agent's Turn, and another
/// session's requests are not the Agent's.
#[tokio::test]
async fn a_sub_agents_requests_are_shown_with_it_and_answered_in_its_own_session() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let running = lab.send("c1", "work").await.unwrap().turn_id.unwrap();
    let child = lab.control("child", json!({"parentID":session,"title":"Find the files (@explore subagent)","agent":"explore"})).await;
    let child = child["id"].as_str().unwrap().to_owned();
    let other = lab.control("child", json!({"parentID":"ses_elsewhere","title":"another client's"})).await;
    lab.control("ask", json!({"sessionID":other["id"]})).await;
    let asked = lab.control("ask", json!({"sessionID":child})).await;
    let d = lab.until("the sub-agent's request", |d| !d.pending.is_empty()).await;
    assert_eq!(d.pending.len(), 1, "another session's request is not this Agent's: {:#?}", d.pending);
    let p = d.pending[0].clone();
    assert_eq!((p.method.as_str(), &p.params["id"]), ("opencode/permission", &asked["id"]));
    assert_eq!(p.params["_opencodeSession"], child);
    assert_eq!(p.params["_opencodeChild"], json!({"title":"Find the files (@explore subagent)","agent":"explore"}));
    assert_eq!(p.params["turnId"], running, "the Agent's running Turn asked it");
    assert_eq!(d.agent.status, "waiting");

    // The same event again adds nothing, and the sub-agent's idle ends no Turn.
    lab.control("event", json!({"type":"permission.asked","properties":asked})).await;
    lab.control("idle", json!({"sessionID":child})).await;
    let question = lab.control("question", json!({"sessionID":child})).await;
    let d = lab.until("the sub-agent's question", |d| d.pending.iter().any(|p| p.params["id"] == question["id"])).await;
    assert_eq!(d.pending.iter().filter(|p| p.params["id"] == asked["id"]).count(), 1);
    assert_eq!(turn(&d, &running)["status"], "inProgress");

    // Answered in the session that asked, once.
    lab.ws.respond(&p.id, json!({"decision":"once"})).await.unwrap();
    let answered = lab.posts("/permission/");
    assert_eq!((answered[0]["path"].as_str().unwrap(), &answered[0]["body"]),
        (format!("/permission/{}/reply", asked["id"].as_str().unwrap()).as_str(), &json!({"reply":"once"})));
    assert!(lab.ws.respond(&p.id, json!({"decision":"once"})).await.is_err(), "answered already");
    let q = d.pending.iter().find(|p| p.params["id"] == question["id"]).unwrap();
    assert_eq!(q.params["_opencodeSession"], child);
    lab.ws.respond(&q.id, json!({"answers":[["A"]]})).await.unwrap();
    assert_eq!(lab.posts("/question/").last().unwrap()["path"], format!("/question/{}/reply", question["id"].as_str().unwrap()));
    lab.until("the answered requests", |d| d.pending.is_empty()).await;

    // A request of a sub-agent whose run ended is not answered.
    lab.control("ask", json!({"sessionID":child})).await;
    let gone = lab.until("the next request", |d| !d.pending.is_empty()).await.pending[0].clone();
    lab.control("close", json!({"sessionID":child})).await;
    assert!(lab.ws.respond(&gone.id, json!({"decision":"once"})).await.is_err());
    assert_eq!(lab.posts("/permission/").len(), 1, "only the first permission answer was sent");

    // The Agent's own session ends its Turn.
    assert_eq!(turn(&lab.detail(), &running)["status"], "inProgress");
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("the Turn's end", |d| turn(d, &running)["status"] == "completed").await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// A sub-agent that starts and asks while no event stream is open is found
/// again with the snapshot: OpenCode lists it among the session's children,
/// and its request comes with it (T-10).
#[tokio::test]
async fn a_sub_agent_that_asked_while_no_stream_was_open_is_found_again() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    lab.send("c1", "work").await.unwrap();
    lab.control("refuseEvents", json!({"seconds":0.4})).await;
    lab.control("drop", json!({})).await;
    let child = lab.control("child", json!({"parentID":session,"title":"Check (@general subagent)","agent":"general","announce":false})).await;
    let asked = lab.control("ask", json!({"sessionID":child["id"]})).await;
    let d = lab.until("the request read again", |d| !d.pending.is_empty()).await;
    assert!(journal(&lab).iter().any(|k| k == "opencode/resynced"));
    let p = &d.pending[0];
    assert_eq!(p.params["id"], asked["id"]);
    assert_eq!(p.params["_opencodeSession"], child["id"]);
    assert_eq!(p.params["_opencodeChild"], json!({"title":"Check (@general subagent)","agent":"general"}));
    lab.ws.respond(&p.id, json!({"decision":"reject"})).await.unwrap();
    assert_eq!(lab.posts("/permission/")[0]["body"], json!({"reply":"reject"}));
    lab.ws.close_agent(ID).await.unwrap();
}

/// Every file under `dir`, read whole, for a secret the stand-in's providers hold.
fn holds_a_secret(dir: &std::path::Path) -> Option<(PathBuf, &'static str)> {
    const SECRETS: [&str; 4] = ["fixture-secret-key", "fixture-secret-option", "fixture-secret-header", "FIXTURE_SECRET_ENV"];
    for entry in std::fs::read_dir(dir).unwrap().map(Result::unwrap) {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = holds_a_secret(&path) {
                return Some(found);
            }
        } else if let Ok(bytes) = std::fs::read(&path) {
            if let Some(secret) = SECRETS.iter().find(|s| bytes.windows(s.len()).any(|w| w == s.as_bytes())) {
                return Some((path, secret));
            }
        }
    }
    None
}

/// A model OpenCode's configured providers list (`/api/model`) is
/// chosen for the Agent's next messages (T-10) and goes with each of them;
/// OpenCode's default sends none, as before; one OpenCode no longer lists is
/// refused before anything is sent. Only a model's names are kept, never a
/// provider's key, options or headers.
#[tokio::test]
async fn a_model_opencode_lists_goes_with_the_next_messages_and_nothing_else_of_its_providers_is_kept() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let catalog = lab.ws.opencode_agent_catalog(ID).await.unwrap();
    assert_eq!(catalog["models"], json!([
        {"id":"deepseek/deepseek-flash","model":"deepseek/deepseek-flash","displayName":"DeepSeek · DeepSeek Flash","description":null,
         "variants":["high","max"]},
        {"id":"openrouter/anthropic/claude-x","model":"openrouter/anthropic/claude-x","displayName":"OpenRouter · Claude X","description":"beta",
         "variants":[]},
    ]));

    // Only a model OpenCode lists is saved.
    let refused = lab.ws.opencode_set_model(ID, "nope/model".into()).await.unwrap_err().to_string();
    assert!(refused.contains("设置未保存"), "{refused}");
    assert_eq!(lab.detail().agent.model, "");
    let chosen = lab.ws.opencode_set_model(ID, " openrouter/anthropic/claude-x ".into()).await.unwrap();
    assert_eq!(chosen.model, "openrouter/anthropic/claude-x");

    // It is made the session's before the next message (2.x's prompt carries none), named as OpenCode names it.
    let first = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    assert_eq!(lab.switches(), [json!({"model":{"id":"anthropic/claude-x","providerID":"openrouter"}})], "made the session's before its first message");
    assert_eq!(lab.prompts()[0]["body"], json!({"id":first,"text":"hello"}));
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &first)["status"] == "completed").await;
    // Already the session's: not made so again (D3).
    let same = lab.send("c1b", "more").await.unwrap().turn_id.unwrap();
    assert_eq!(lab.switches().len(), 1, "the session's model already");
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &same)["status"] == "completed").await;

    // OpenCode's default again: no model is sent, as before any was chosen.
    lab.ws.opencode_set_model(ID, String::new()).await.unwrap();
    let second = lab.send("c2", "again").await.unwrap().turn_id.unwrap();
    assert_eq!(lab.prompts()[2]["body"], json!({"id":second,"text":"again"}));
    assert_eq!(lab.switches().len(), 1, "OpenCode's own default: the session's is left as it is");
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &second)["status"] == "completed").await;

    // A chosen model OpenCode no longer lists: refused before anything is sent.
    lab.ws.opencode_set_model(ID, "deepseek/deepseek-flash".into()).await.unwrap();
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    providers["providers"].as_array_mut().unwrap().retain(|p| p["id"] != "deepseek");
    lab.control("mode", json!({"providers":providers})).await;
    let gone = lab.send("c3", "third").await.unwrap_err().to_string();
    assert!(gone.contains("不在 OpenCode 当前的配置中") && gone.contains("没有发送"), "{gone}");
    assert_eq!((lab.prompts().len(), lab.switches().len()), (3, 1), "nothing was sent or switched");
    let d = lab.detail();
    assert!(d.message_receipts.iter().all(|r| r.input.client_message_id != "c3"), "no receipt was recorded");
    assert_eq!(d.agent.model, "deepseek/deepseek-flash", "the choice stays the user's");

    // Nothing else of a provider's record was kept, in the record or anywhere in Core's data.
    let data = lab.dir.path().join("data");
    let record = serde_json::to_string(&lab.detail()).unwrap();
    assert!(!record.contains("fixture-secret") && !record.contains("FIXTURE_SECRET"));
    assert_eq!(holds_a_secret(&data), None);
    lab.ws.close_agent(ID).await.unwrap();

    // An Agent with no connection has no models to read, and saves none.
    let ws = Workspace::new(lab.dir.path().join("data2"), lab.dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(&lab.dir.path().to_string_lossy())).unwrap();
    assert!(ws.opencode_agent_catalog(ID).await.unwrap_err().to_string().contains("尚未连接"));
    assert!(ws.opencode_set_model(ID, "deepseek/deepseek-flash".into()).await.unwrap_err().to_string().contains("尚未连接"));
    assert_eq!(ws.opencode_set_model(ID, String::new()).await.unwrap().model, "", "OpenCode's default needs no list");
}

/// A chosen model's variant (T-10), by the name OpenCode lists it under,
/// goes with the next messages; without one nothing is sent for it, as
/// before. One the model does not list, or a variant without a model, is
/// refused on saving, and one OpenCode no longer lists refuses the message
/// before anything is sent: OpenCode itself would apply nothing for it and
/// say nothing. What a variant sets is never kept.
#[tokio::test]
async fn a_variant_the_chosen_model_lists_goes_with_the_next_messages() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let choose = |model: &str, variant: Option<&str>| lab.ws.opencode_set_choice(ID, model.into(), Some(variant.map(str::to_owned)));
    for (model, variant, refusal) in [
        ("deepseek/deepseek-flash", "low", "设置未保存"),
        ("openrouter/anthropic/claude-x", "high", "设置未保存"),
        ("", "high", "设置未保存"),
    ] {
        let refused = choose(model, Some(variant)).await.unwrap_err().to_string();
        assert!(refused.contains(refusal), "{model} {variant}: {refused}");
    }
    let d = lab.detail();
    assert_eq!((d.agent.model.as_str(), d.agent.settings.reasoning_effort.as_deref()), ("", None), "nothing was saved");
    let chosen = choose("deepseek/deepseek-flash", Some("max")).await.unwrap();
    assert_eq!((chosen.model.as_str(), chosen.settings.reasoning_effort.as_deref()), ("deepseek/deepseek-flash", Some("max")));
    // Choosing the model alone keeps it.
    assert_eq!(lab.ws.opencode_set_model(ID, "deepseek/deepseek-flash".into()).await.unwrap().settings.reasoning_effort.as_deref(), Some("max"));

    let first = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    assert_eq!(lab.switches(), [json!({"model":{"id":"deepseek-flash","providerID":"deepseek","variant":"max"}})], "with its variant");
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &first)["status"] == "completed").await;

    // OpenCode's own variant again: none is sent.
    choose("deepseek/deepseek-flash", None).await.unwrap();
    let second = lab.send("c2", "again").await.unwrap().turn_id.unwrap();
    assert_eq!(lab.switches(), [json!({"model":{"id":"deepseek-flash","providerID":"deepseek","variant":"max"}}),
        json!({"model":{"id":"deepseek-flash","providerID":"deepseek"}})], "the same model, without the variant");
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &second)["status"] == "completed").await;

    // A variant OpenCode no longer lists: refused before anything is sent.
    choose("deepseek/deepseek-flash", Some("max")).await.unwrap();
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    for provider in providers["providers"].as_array_mut().unwrap().iter_mut().filter(|p| p["id"] == "deepseek") {
        provider["models"]["deepseek-flash"]["variants"].as_object_mut().unwrap().remove("max");
    }
    lab.control("mode", json!({"providers":providers})).await;
    let gone = lab.send("c3", "third").await.unwrap_err().to_string();
    assert!(gone.contains("所选变体 max") && gone.contains("没有发送"), "{gone}");
    assert_eq!((lab.prompts().len(), lab.switches().len()), (2, 2), "nothing was sent or switched");
    assert!(lab.detail().message_receipts.iter().all(|r| r.input.client_message_id != "c3"), "no receipt was recorded");
    // What a variant sets (here, a fake key among its options) is nowhere in Core's data.
    assert_eq!(holds_a_secret(&lab.dir.path().join("data")), None);
    lab.ws.close_agent(ID).await.unwrap();
}

fn png(width: u32, height: u32, color: u8) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(width, height, image::Rgb([color, 0, 0])).write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

/// A message's images go to OpenCode inline (T-10): file parts after its
/// text, each this Agent's own image as it was saved, sized as for Claude,
/// while the conversation shows the originals. Only a chosen model OpenCode
/// lists as reading images gets them. With OpenCode's own default, or a
/// model that doesn't read them, nothing is sent and no receipt is kept,
/// where OpenCode itself would put a line of text in each image's place and
/// take the message. The same message again under its client ID is sent once.
/// What OpenCode sends back of the images is journaled without their bytes.
#[tokio::test]
async fn images_go_inline_only_to_a_chosen_model_that_reads_them() {
    let lab = lab(&[], true).await;
    let session = lab.session();
    // The stand-in's DeepSeek model reads images; its OpenRouter one doesn't say so.
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    for provider in providers["providers"].as_array_mut().unwrap().iter_mut().filter(|p| p["id"] == "deepseek") {
        provider["models"]["deepseek-flash"]["capabilities"] = json!({"input":{"text":true,"image":true}});
    }
    lab.control("mode", json!({"providers":providers})).await;

    // Saved through the upload route, as the composer saves them; one for another Agent.
    let mut other = agent(&lab.dir.path().to_string_lossy());
    other.agent.id = "oc2".into();
    lab.ws.store.insert(&other).unwrap();
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4999);
    let upload = |agent: &str, bytes: Vec<u8>| {
        let request = Request::builder().method("POST").uri(format!("/api/agents/{agent}/images"))
            .header("host", "localhost:4999").header("x-yuzuno-client", "desktop").body(Body::from(bytes)).unwrap();
        let router = router.clone();
        async move {
            let response = router.oneshot(request).await.unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
            serde_json::from_slice::<Value>(&body).unwrap()["id"].as_str().unwrap().to_owned()
        }
    };
    let small = upload(ID, png(4, 4, 10)).await;
    let wide = upload(ID, png(2400, 600, 80)).await;
    let foreign = upload("oc2", png(4, 4, 200)).await;
    let both = vec![small.clone(), wide.clone()];
    let send = |client: &str, text: &str, images: &[String]| {
        let input: MessageInput = serde_json::from_value(json!({"clientMessageId":client,"text":text,"images":images})).unwrap();
        let ws = lab.ws.clone();
        async move { ws.send_message(ID, input).await }
    };

    // OpenCode's own default, then a chosen model that doesn't read images:
    // refused before anything is sent, and no receipt is kept.
    let default = send("c1", "look", &both).await.unwrap_err().to_string();
    assert!(default.contains("默认模型") && default.contains("没有发送"), "{default}");
    lab.ws.opencode_set_model(ID, "openrouter/anthropic/claude-x".into()).await.unwrap();
    let text_only = send("c1", "look", &both).await.unwrap_err().to_string();
    assert!(text_only.contains("openrouter/anthropic/claude-x 在 OpenCode 的配置中不能读图片") && text_only.contains("没有发送"), "{text_only}");
    assert!(lab.prompts().is_empty(), "nothing was sent");
    assert!(lab.detail().message_receipts.is_empty(), "no receipt was recorded");

    // A model that reads them: the text, then each image inline under its ID.
    lab.ws.opencode_set_model(ID, "deepseek/deepseek-flash".into()).await.unwrap();
    let receipt = send("c1", "look", &both).await.unwrap();
    assert_eq!(receipt.status, "accepted");
    let first = receipt.turn_id.clone().unwrap();
    // 2.x's prompt (T-32 slice 4a): the text, then each image as a `data:` URI under its ID.
    let body = lab.prompts()[0]["body"].clone();
    assert_eq!(body["text"], "look");
    let parts = body["files"].as_array().unwrap().clone();
    assert_eq!(parts.len(), 2);
    for (part, id) in parts.iter().zip(&both) {
        assert!(part["uri"].as_str().unwrap().starts_with("data:image/png;base64,"), "{part}");
        assert_eq!(part["name"], json!(id));
    }
    let inline = |part: &Value| {
        use base64::Engine;
        let data = part["uri"].as_str().unwrap().strip_prefix("data:image/png;base64,").unwrap();
        base64::engine::general_purpose::STANDARD.decode(data).unwrap()
    };
    let saved = lab.dir.path().join("data/input-images").join(ID).canonicalize().unwrap();
    assert_eq!(inline(&parts[0]), std::fs::read(saved.join(&small)).unwrap(), "a small image as it was saved");
    let fitted = image::load_from_memory(&inline(&parts[1])).unwrap();
    assert_eq!((fitted.width(), fitted.height()), (2000, 500), "a wide one fitted as for Claude");
    let shown = |id: &str| json!({"type":"localImage","path":saved.join(id)});
    let d = lab.detail();
    assert_eq!(items(turn(&d, &first), "userMessage")[0]["content"],
        json!([{"type":"text","text":"look"}, shown(&small), shown(&wide)]), "the conversation shows the originals");
    assert_eq!(d.message_receipts[0].input.images, both, "the receipt keeps which images it sent");

    // OpenCode sends the stored message back, its file parts whole. The
    // journal keeps each as what it is, never its bytes, and no image's
    // bytes are anywhere in Core's database.
    let journaled = || {
        let db = rusqlite::Connection::open(lab.dir.path().join("data/workspace.sqlite")).unwrap();
        // 2.x sends the stored message's files back in its inbox event, as base64 `data` (T-32 slice 3b).
        let mut query = db.prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind='opencode/session.inbox.enqueued'").unwrap();
        query.query_map([ID], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap)
            .flat_map(|data| serde_json::from_str::<Value>(&data).unwrap()["data"]["item"]["payload"]["files"].as_array().cloned().unwrap_or_default())
            .collect::<Vec<_>>()
    };
    for _ in 0..400 {
        if journaled().len() == 2 { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let kept = journaled();
    assert_eq!(kept.len(), 2, "both file parts came back and were journaled");
    for (kept, sent) in kept.iter().zip(&parts) {
        let uri = sent["uri"].as_str().unwrap();
        let data = uri.split_once(',').unwrap().1.as_bytes();
        assert_eq!((&kept["name"], &kept["data"]), (&sent["name"], &json!(format!("image/png,… ({} characters not kept)", data.len()))));
        for entry in std::fs::read_dir(lab.dir.path().join("data")).unwrap().map(Result::unwrap) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("workspace.sqlite") {
                let bytes = std::fs::read(entry.path()).unwrap();
                assert!(!bytes.windows(data.len()).any(|w| w == data), "{name} holds the bytes of {}", sent["filename"]);
            }
        }
    }

    // The same message again: its receipt, and nothing sent again. Other
    // images under that client ID are refused.
    let again = send("c1", "look", &both).await.unwrap();
    assert_eq!((again.status.as_str(), again.turn_id.as_deref()), ("accepted", Some(first.as_str())));
    let changed = send("c1", "look", &both[..1]).await.unwrap_err().to_string();
    assert!(changed.contains("同一消息编号不能提交不同的内容"), "{changed}");
    assert_eq!(lab.prompts().len(), 1, "sent once");
    lab.control("reply", json!({"sessionID":session,"text":"Seen."})).await;
    lab.until("completion", |d| turn(d, &first)["status"] == "completed").await;

    // Images alone: an empty text, as 2.x's prompt takes it.
    let second = send("c2", "", &both[1..]).await.unwrap().turn_id.unwrap();
    let body = lab.prompts()[1]["body"].clone();
    assert_eq!((&body["text"], body["files"].as_array().unwrap().len(), &body["files"][0]["name"]), (&json!(""), 1, &json!(wide)));
    assert_eq!(items(turn(&lab.detail(), &second), "userMessage")[0]["content"], json!([shown(&wide)]));
    lab.control("reply", json!({"sessionID":session,"text":"Seen."})).await;
    lab.until("completion", |d| turn(d, &second)["status"] == "completed").await;

    // Another Agent's image, or one changed since it was saved: refused by
    // the check every Agent's images pass, and nothing is sent.
    std::fs::write(saved.join(&small), png(4, 4, 11)).unwrap();
    for (client, image, refusal) in [("c3", &foreign, "Saved image is missing"), ("c4", &small, "Saved image changed")] {
        let refused = send(client, "this one", std::slice::from_ref(image)).await.unwrap();
        assert_eq!((refused.status.as_str(), refused.turn_id.as_deref()), ("rejected", None), "{client}");
        assert!(refused.error.as_deref().unwrap_or_default().contains(refusal), "{client}: {:?}", refused.error);
    }
    assert_eq!(lab.prompts().len(), 2, "neither was sent");
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
    assert_eq!(failed.posts("/api/session")[0]["body"], json!({"title":"OpenCode","location":{"directory":failed.detail().agent.cwd}}));
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
    assert!(lab.posts("/global/dispose").is_empty(), "2.x has no dispose: its teardown after SIGTERM ended the tool");
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

/// The user message of `turn_id` sent under the client ID `client`.
fn input_of<'a>(d: &'a AgentDetail, turn_id: &str, client: &str) -> &'a Value {
    items(turn(d, turn_id), "userMessage").into_iter().find(|i| i["clientId"] == client)
        .unwrap_or_else(|| panic!("no user message {client} in {turn_id}: {:#?}", turn(d, turn_id)))
}

/// A message added while OpenCode works (T-10) goes as a prompt under an ID
/// of its own, recorded in the running Turn before it is sent and confirmed
/// by the message OpenCode stores under it, with the Agent's model and
/// variant. OpenCode's run answers the newest message (here, the stand-in's
/// answer goes to the last prompt), and the one Turn ends on that answer:
/// no Turn of its own. The same message again is its receipt, sent once.
#[tokio::test]
async fn a_message_added_while_opencode_works_joins_the_running_turn_once() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    lab.ws.opencode_set_choice(ID, "deepseek/deepseek-flash".into(), Some(Some("max".into()))).await.unwrap();
    let first = lab.send("c1", "Fix the build").await.unwrap().turn_id.unwrap();
    lab.until("the run", |d| d.agent.status == "working").await;

    let added = lab.add("c2", "Also run the tests", &first).await.unwrap();
    assert_eq!((added.status.as_str(), added.turn_id.as_deref()), ("accepted", Some(first.as_str())), "{added:?}");
    let d = lab.detail();
    let joined = input_of(&d, &first, "c2");
    let message = joined["nativeMessageId"].as_str().unwrap().to_owned();
    assert!(message.starts_with("msg_") && message != first, "{message}");
    assert_eq!(joined["content"], json!([{"type":"text","text":"Also run the tests"}]));
    let prompts = lab.prompts();
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[1]["body"], json!({"id":message,"text":"Also run the tests"}));
    assert_eq!(lab.switches(), [json!({"model":{"id":"deepseek-flash","providerID":"deepseek","variant":"max"}})],
        "made the session's once, before the first message: the added one finds it so");
    let kinds = journal(&lab);
    let requested = kinds.iter().position(|k| k == "opencode/inputRequested").unwrap();
    let confirmed = kinds.iter().position(|k| k == "opencode/inputConfirmed").unwrap();
    assert!(requested < confirmed, "recorded before it was sent: {kinds:?}");
    assert_eq!(d.turns.len(), 1, "no Turn of its own");
    assert_eq!(turn(&d, &first)["status"], "inProgress");

    // The same message again: its receipt, and nothing sent again.
    let again = lab.add("c2", "Also run the tests", &first).await.unwrap();
    assert_eq!((again.status.as_str(), again.turn_id.as_deref()), ("accepted", Some(first.as_str())));
    assert_eq!(lab.prompts().len(), 2, "sent once");

    // OpenCode's answer to the newest message ends the one Turn.
    lab.control("reply", json!({"sessionID":session,"text":"Built, and the tests pass."})).await;
    let d = lab.until("completion", |d| turn(d, &first)["status"] == "completed").await;
    let replies = items(turn(&d, &first), "agentMessage");
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["text"], "Built, and the tests pass.");
    assert_eq!(items(turn(&d, &first), "userMessage").len(), 2);
    assert_eq!(d.agent.status, "idle");
    assert_eq!(d.message_receipts.iter().map(|r| (r.input.client_message_id.as_str(), r.status.as_str())).collect::<Vec<_>>(),
        [("c1", "accepted"), ("c2", "accepted")]);
    lab.ws.close_agent(ID).await.unwrap();
}

/// A new message whose model can't be made the session's (T-32 slice 4a,
/// R3 4051b7d4) is rejected before its Turn is recorded, as an added one is:
/// no Turn of it, nothing sent, its draft kept, and a whole read says the
/// same; the next one, once the switch works, goes.
#[tokio::test]
async fn a_message_whose_model_switch_fails_is_rejected_with_no_turn() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let before = lab.detail().turns.len();
    lab.ws.opencode_set_choice(ID, "deepseek/deepseek-flash".into(), Some(Some("max".into()))).await.unwrap();
    let mut fail = serde_json::Map::new();
    fail.insert(format!("/api/session/{session}/model"), json!(500));
    lab.control("mode", json!({"fail":fail})).await;
    let failed = lab.send("c1", "Fix the build").await.unwrap();
    assert_eq!(lab.detail().turns.len(), before, "no Turn of it");
    assert_eq!(failed.status, "rejected", "{failed:?}");
    assert!(failed.error.as_deref().unwrap().contains("没有把所选模型设为 OpenCode 会话的模型；这条消息没有发送，草稿保留"), "{failed:?}");
    assert!(!journal(&lab).iter().any(|k| k == "opencode/turnRequested"), "never recorded as asked");
    assert!(lab.prompts().is_empty(), "never sent");
    // A whole read after the stream reopens says the same.
    let reads = resyncs(&lab);
    lab.control("refuseEvents", json!({"seconds":0.5})).await;
    lab.control("drop", json!({})).await;
    lab.until("the read after the stream reopened", |_| resyncs(&lab) > reads).await;
    assert_eq!(lab.detail().turns.len(), before, "a whole read says the same");

    // Once the switch works, the next one goes.
    lab.control("mode", json!({"fail":{}})).await;
    let sent = lab.send("c2", "Fix the build").await.unwrap();
    assert_eq!(sent.status, "accepted", "{sent:?}");
    assert_eq!(lab.prompts().len(), 1, "sent once");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A message added while OpenCode works whose model can't be made the
/// session's (T-32 slice 4a, R1 276dd516) is rejected before anything of it
/// enters the Turn, its draft kept, and a whole read after says the same;
/// the next one added goes on from the Turn's own last input.
#[tokio::test]
async fn an_added_message_whose_model_switch_fails_leaves_the_turn_as_it_was() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let first = lab.send("c1", "Fix the build").await.unwrap().turn_id.unwrap();
    lab.until("the run", |d| d.agent.status == "working").await;
    let before = turn(&lab.detail(), &first).clone();
    // Another model, chosen while it runs: the added message is to switch first, and the switch fails.
    lab.ws.opencode_set_choice(ID, "deepseek/deepseek-flash".into(), Some(Some("max".into()))).await.unwrap();
    let mut fail = serde_json::Map::new();
    fail.insert(format!("/api/session/{session}/model"), json!(500));
    lab.control("mode", json!({"fail":fail})).await;
    let failed = lab.add("c2", "Also run the tests", &first).await.unwrap();
    assert_eq!(failed.status, "rejected", "{failed:?}");
    assert!(failed.error.as_deref().unwrap().contains("没有把所选模型设为 OpenCode 会话的模型；这条消息没有发送，草稿保留"), "{failed:?}");
    let unchanged = |d: &AgentDetail| {
        let now = turn(d, &first);
        (now["_opencodeInputs"].clone(), now["_opencodeLastInput"].clone(), items(now, "userMessage").len())
    };
    let was = (before["_opencodeInputs"].clone(), before["_opencodeLastInput"].clone(), 1);
    assert_eq!(unchanged(&lab.detail()), was, "nothing of it entered the Turn");
    assert!(!journal(&lab).iter().any(|k| k == "opencode/inputRequested"), "never recorded as added");
    assert_eq!(lab.prompts().len(), 1, "never sent");
    // A whole read after the stream reopens says the same.
    let reads = resyncs(&lab);
    lab.control("refuseEvents", json!({"seconds":0.5})).await;
    lab.control("drop", json!({})).await;
    lab.until("the read after the stream reopened", |_| resyncs(&lab) > reads).await;
    assert_eq!(unchanged(&lab.detail()), was, "a whole read says the same");

    // The next one, once the switch works, goes on from the Turn's own last input.
    lab.control("mode", json!({"fail":{}})).await;
    let added = lab.add("c3", "Also run the tests", &first).await.unwrap();
    assert_eq!(added.status, "accepted", "{added:?}");
    let d = lab.detail();
    let message = input_of(&d, &first, "c3")["nativeMessageId"].as_str().unwrap().to_owned();
    assert_eq!(turn(&d, &first)["_opencodeInputs"][&message]["previous"], before["_opencodeLastInput"], "after the Turn's own last input");
    let switch = json!({"model":{"id":"deepseek-flash","providerID":"deepseek","variant":"max"}});
    assert_eq!(lab.switches(), [switch.clone(), switch], "the switch that failed, then the one that worked");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A message is added only to the Agent's running Turn it names, with its
/// prompt stored and nothing waiting for the user, and never as a command:
/// otherwise it is refused before its receipt, the draft kept, and nothing
/// is sent.
#[tokio::test]
async fn a_message_is_added_only_to_the_running_turn_it_names() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let refused = |text: anyhow::Result<yuzuno_workspace::model::MessageReceipt>| text.unwrap_err().to_string();

    // Idle: no running Turn.
    let done = lab.send("c1", "One").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &done)["status"] == "completed").await;
    let finished = refused(lab.add("c2", "More", &done).await);
    assert!(finished.contains("原 Turn 已结束或发生变化"), "{finished}");

    // Running, but another Turn named; a command; a request waiting.
    let running = lab.send("c3", "Two").await.unwrap().turn_id.unwrap();
    let other = refused(lab.add("c4", "More", &done).await);
    assert!(other.contains("原 Turn 已结束或发生变化"), "{other}");
    let command = refused(lab.add("c5", "/explain closures", &running).await);
    assert!(command.contains("OpenCode 命令只能在空闲时发送"), "{command}");
    lab.control("ask", json!({"sessionID":session})).await;
    lab.until("the request", |d| !d.pending.is_empty()).await;
    let waiting = refused(lab.add("c6", "More", &running).await);
    assert!(waiting.contains("请先回答"), "{waiting}");

    let d = lab.detail();
    assert_eq!(lab.prompts().len(), 2, "none of them was sent");
    assert!(d.message_receipts.iter().all(|r| !["c2", "c4", "c5", "c6"].contains(&r.input.client_message_id.as_str())), "no receipt was recorded");
    assert_eq!(items(turn(&d, &running), "userMessage").len(), 1);
    lab.ws.close_agent(ID).await.unwrap();
}

/// An added message OpenCode refuses leaves the Turn as it was; one it never
/// confirms is unknown and is not sent again, and the Turn waits for it on
/// an idle that says nothing about it, ending once OpenCode's record has it
/// and its newest message is answered.
#[tokio::test]
async fn an_added_message_opencode_refuses_or_never_confirms_is_not_sent_again() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let first = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();

    // Refused (HTTP 400): rejected; the Turn goes on without it.
    let mut fail = serde_json::Map::new();
    fail.insert(format!("/api/session/{session}/prompt"), json!(400));
    lab.control("mode", json!({"fail":fail})).await;
    let refused = lab.add("c2", "Refused", &first).await.unwrap();
    assert_eq!(refused.status, "rejected", "{refused:?}");
    assert!(refused.error.as_deref().unwrap().contains("OpenCode 拒绝了这条补充消息（HTTP 400）"), "{refused:?}");
    let d = lab.detail();
    assert_eq!(items(turn(&d, &first), "userMessage").len(), 1, "not shown in the Turn");
    assert_eq!(turn(&d, &first)["status"], "inProgress");
    lab.control("mode", json!({"fail":{}})).await;

    // Answered but never stored: unknown, sent once; an idle decides nothing.
    lab.control("mode", json!({"prompt":"unstored"})).await;
    let unknown = lab.add("c3", "Later", &first).await.unwrap();
    assert_eq!(unknown.status, "uncertain", "{unknown:?}");
    let d = lab.detail();
    let pending_input = input_of_native(&d, &first, "Later");
    assert_eq!(pending_input["deliveryUnconfirmed"], true);
    let message = pending_input["nativeMessageId"].as_str().unwrap().to_owned();
    lab.control("mode", json!({"prompt":"store"})).await;
    lab.control("idle", json!({"sessionID":session})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(turn(&lab.detail(), &first)["status"], "inProgress", "its added message is not stored yet");

    // OpenCode's record has it after all: accepted, and the answer to it ends the Turn.
    lab.control("store", json!({"sessionID":session,"messageID":message,"text":"Later"})).await;
    lab.until("the late confirmation", |d| d.message_receipts.iter().any(|r| r.input.client_message_id == "c3" && r.status == "accepted")).await;
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &first)["status"] == "completed").await;
    assert_eq!(lab.prompts().len(), 3, "each sent once: the first, the refused one and the unknown one");

    // A 400 decides by OpenCode's record, as for a command (#435): stored
    // (here announced too) is delivered; a record that cannot be read leaves
    // it unknown, sent once, and never refused.
    let second = lab.send("c4", "Again").await.unwrap().turn_id.unwrap();
    lab.control("mode", json!({"prompt":"store-then-400"})).await;
    let kept = lab.add("c5", "Kept", &second).await.unwrap();
    assert_eq!((kept.status.as_str(), kept.turn_id.as_deref()), ("accepted", Some(second.as_str())), "{kept:?}");
    let mut fail = serde_json::Map::new();
    fail.insert(format!("/api/session/{session}/prompt"), json!(400));
    lab.control("mode", json!({"fail":fail,"failMessageReads":true})).await;
    let unread = lab.add("c6", "Unread", &second).await.unwrap();
    assert_eq!(unread.status, "uncertain", "{unread:?}");
    assert_eq!(journal(&lab).iter().filter(|k| *k == "opencode/inputRefused").count(), 1, "only the refusal above");
    assert_eq!(input_of_native(&lab.detail(), &second, "Unread")["deliveryUnconfirmed"], true, "kept in the Turn, unconfirmed");
    assert_eq!(lab.prompts().len(), 6, "each sent once");
    lab.control("mode", json!({"fail":{},"failMessageReads":false,"prompt":"store"})).await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// The user message of `turn_id` whose text is `text`.
fn input_of_native<'a>(d: &'a AgentDetail, turn_id: &str, text: &str) -> &'a Value {
    items(turn(d, turn_id), "userMessage").into_iter().find(|i| i["content"][0]["text"] == text)
        .unwrap_or_else(|| panic!("no user message {text:?} in {turn_id}: {:#?}", turn(d, turn_id)))
}

/// An interrupt aborts the one run: the Turn ends interrupted with the
/// messages added to it.
#[tokio::test]
async fn an_interrupt_ends_the_turn_with_its_added_messages() {
    let lab = lab(&[], false).await;
    let first = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();
    lab.add("c2", "And this", &first).await.unwrap();
    lab.control("busy", json!({"sessionID":lab.session()})).await;
    lab.ws.interrupt(ID).await.unwrap();
    let d = lab.until("the interrupt", |d| turn(d, &first)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &first)["status"], "interrupted");
    assert_eq!(items(turn(&d, &first), "userMessage").len(), 2);
    assert_eq!(lab.prompts().len(), 2);
    lab.ws.close_agent(ID).await.unwrap();
}

/// OpenCode may go on under a user message of its own after an added one
/// (an auto-compaction's "continue", 1.19.3 `session/compaction.ts`): its
/// answers then name that message, not the added one. The Turn does not wait
/// for an answer that will not come: idle ends it, here as unknown, since no
/// answer names any of its own messages.
#[tokio::test]
async fn an_added_message_opencode_goes_on_past_still_ends_the_turn_on_idle() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let first = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();
    let added = lab.add("c2", "And this", &first).await.unwrap();
    assert_eq!(added.status, "accepted");
    // OpenCode's own message, later than the added one, then its answer to that.
    lab.control("store", json!({"sessionID":session,"messageID":"msg_fffffffffffffffffffffffffff","text":"Continue if you have next steps"})).await;
    lab.control("reply", json!({"sessionID":session,"text":"Continued."})).await;
    let d = lab.until("the end of the Turn", |d| turn(d, &first)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &first)["status"], "outcomeUnknown", "ended by idle, not left running");
    assert_eq!(d.agent.status, "idle");
    lab.ws.close_agent(ID).await.unwrap();
}

/// An interrupt that ends the run before its next step answers the added
/// message (R1 77fcdc6b): the aborted answer is the earlier message's, and
/// that ends the Turn interrupted, not left running.
#[tokio::test]
async fn an_added_message_unanswered_when_the_run_is_aborted_ends_the_turn_interrupted() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let first = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();
    lab.add("c2", "And this", &first).await.unwrap();
    // The aborted answer names the first message, as when the abort comes before the next step.
    lab.control("reply", json!({"sessionID":session,"parentID":first,
        "error":{"name":"MessageAbortedError","data":{"message":"The operation was aborted."}}})).await;
    let d = lab.until("the end of the Turn", |d| turn(d, &first)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &first)["status"], "interrupted");
    assert_eq!(d.agent.status, "idle");
    lab.ws.close_agent(ID).await.unwrap();
}

/// The run ends while an added message is being sent, and OpenCode then
/// refuses that message (R1 77fcdc6b): the idle that came while it was
/// unconfirmed decided nothing, so OpenCode's status is read after the
/// refusal, and the Turn ends as its own messages' answers say.
#[tokio::test]
async fn an_added_message_refused_after_the_run_ended_still_ends_the_turn() {
    let lab = lab(&[], false).await;
    let first = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();
    lab.control("mode", json!({"prompt":"idle-then-400"})).await;
    let refused = lab.add("c2", "Too late", &first).await.unwrap();
    assert_eq!(refused.status, "rejected", "{refused:?}");
    let d = lab.until("the end of the Turn", |d| turn(d, &first)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &first)["status"], "completed");
    assert_eq!(d.agent.status, "idle");
    lab.control("mode", json!({"prompt":"store"})).await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// The Agent's context usage as a `(used, window, Turn, stale)` tuple.
fn usage_of(d: &AgentDetail) -> Option<(u64, u64, String, bool)> {
    d.context_usage.as_ref().map(|u| (u.used_tokens, u.window_tokens, u.turn_id.clone(), u.stale))
}

/// How often Core read OpenCode's configured providers.
fn providers_reads(lab: &Lab) -> usize {
    lab.calls().iter().filter(|c| c["method"] == "GET" && c["path"] == "/api/model").count()
}

/// A new message, and OpenCode's answer to it with `info` (its tokens, model
/// or summary flag), until its Turn ends: that Turn, and the usage then.
async fn answered(lab: &Lab, client: &str, info: Value) -> (String, Option<(u64, u64, String, bool)>) {
    let id = lab.send(client, "next").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":lab.session(),"text":"Done.","info":info})).await;
    let d = lab.until("its end", |d| turn(d, &id)["status"] != "inProgress").await;
    (id, usage_of(&d))
}

/// Whether the usage has stayed `expected` after `what`, once events had time to arrive.
async fn unchanged(lab: &Lab, what: &str, expected: &Option<(u64, u64, String, bool)>) {
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(&usage_of(&lab.detail()), expected, "{what}");
}

/// An OpenCode Agent's context usage (T-10, contract on T-10 #757): the
/// newest completed answer of its own session, against the window of the
/// model that answered, whatever model is chosen. Used is OpenCode's `total`
/// when it is a positive whole number, else its stored parts each once,
/// reasoning among them; anything else is unknown and keeps what was known
/// as last known, never 0%. An answer of a sub-agent, an older one replayed
/// and a compaction's summary don't measure; a compaction makes it last
/// known. Answers don't read the catalog, and no provider secret is kept.
#[tokio::test]
async fn context_usage_is_the_newest_answer_against_its_own_models_window() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    // DeepSeek's model has a window of 2000, OpenRouter's none (0); a catalog read notes them.
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    for provider in providers["providers"].as_array_mut().unwrap() {
        let window = if provider["id"] == "deepseek" { 2000 } else { 0 };
        for (_, model) in provider["models"].as_object_mut().unwrap() {
            model["limit"]["context"] = json!(window);
        }
    }
    lab.control("mode", json!({"providers":providers})).await;
    lab.ws.opencode_agent_catalog(ID).await.unwrap();
    lab.ws.opencode_set_model(ID, "openrouter/anthropic/claude-x".into()).await.unwrap();
    let flash = |tokens: Value| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":tokens});
    let parts = |input: u64, output: u64, reasoning: u64, read: u64, write: u64|
        json!({"input":input,"output":output,"reasoning":reasoning,"cache":{"read":read,"write":write}});

    // OpenCode's total, against the answering model's window, not the chosen one's.
    let mut tokens = parts(1, 1, 0, 0, 0);
    tokens["total"] = json!(500);
    let (first, measured) = answered(&lab, "c1", flash(tokens)).await;
    assert_eq!(measured, Some((500, 2000, first, false)));
    assert_eq!(lab.detail().context_usage.unwrap().used_percent, 25.0);
    // No total: each part once, reasoning too (OpenCode's overflow estimate would say 170).
    let (second, measured) = answered(&lab, "c2", flash(parts(100, 50, 30, 15, 5))).await;
    assert_eq!(measured, Some((200, 2000, second, false)));
    // A total of 0: the parts.
    let mut tokens = parts(1, 2, 3, 4, 5);
    tokens["total"] = json!(0);
    let (third, measured) = answered(&lab, "c3", flash(tokens)).await;
    let known = Some((15, 2000, third.clone(), false));
    assert_eq!(measured, known);

    // Unknown, never 0%: what was known stays, as last known.
    let last_known = Some((15, 2000, third.clone(), true));
    let mut invalid_total = parts(1, 1, 1, 1, 1);
    invalid_total["total"] = json!(-5);
    let mut fractional_total = parts(1, 1, 1, 1, 1);
    fractional_total["total"] = json!(1.5);
    let mut missing_part = parts(1, 1, 1, 1, 1);
    missing_part["cache"].as_object_mut().unwrap().remove("write");
    let too_large = json!({"input":u64::MAX,"output":1,"reasoning":0,"cache":{"read":0,"write":0}});
    for (client, info) in [
        ("c4", flash(invalid_total)), ("c5", flash(fractional_total)), ("c6", flash(missing_part)),
        ("c7", flash(too_large)), ("c8", flash(parts(0, 0, 0, 0, 0))),
        ("c9", json!({"providerID":"openrouter","modelID":"anthropic/claude-x","tokens":{"total":100}})),
        ("c10", json!({"tokens":{"total":100}})),
    ] {
        assert_eq!(answered(&lab, client, info).await.1, last_known, "{client}");
    }
    let (eleventh, measured) = answered(&lab, "c11", flash(json!({"total":700}))).await;
    let fresh = Some((700, 2000, eleventh.clone(), false));
    assert_eq!(measured, fresh);

    // A sub-agent's answer, and an older answer replayed, change nothing.
    let child = lab.control("child", json!({"parentID":session,"title":"a sub-agent"})).await["id"].as_str().unwrap().to_owned();
    lab.control("reply", json!({"sessionID":child,"text":"Found.","info":flash(json!({"total":9}))})).await;
    unchanged(&lab, "a sub-agent's answer", &fresh).await;
    let event = |info: Value| json!({"type":"message.updated","properties":{"sessionID":session,"info":info}});
    let older = json!({"id":"msg_older","sessionID":session,"role":"assistant","parentID":eleventh,
        "time":{"created":1,"completed":1},"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":9}});
    lab.control("event", event(older)).await;
    unchanged(&lab, "an older answer", &fresh).await;

    // A compaction: what was measured is last known until a normal answer measures again.
    let now = chrono::Utc::now().timestamp_millis();
    let summary = json!({"id":"msg_summary","sessionID":session,"role":"assistant","parentID":"msg_compaction","summary":true,
        "time":{"created":now},"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":1900}});
    lab.control("event", event(summary)).await;
    lab.until("the compaction", |d| d.context_usage.as_ref().is_some_and(|u| u.stale)).await;
    assert_eq!(usage_of(&lab.detail()), Some((700, 2000, eleventh, true)));
    let (twelfth, measured) = answered(&lab, "c12", flash(json!({"total":800}))).await;
    let fresh = Some((800, 2000, twelfth, false));
    assert_eq!(measured, fresh);
    // An older compaction replayed doesn't make it last known: 2.x's own
    // event, timed when OpenCode made it (T-32 slice 3b).
    lab.control("event", json!({"type":"session.compaction.ended","created":1,"properties":{"sessionID":session,"reason":"auto",
        "text":"","tokens":{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}})).await;
    unchanged(&lab, "an older summary", &fresh).await;

    // An answer's events read no catalog; no provider secret is anywhere in Core's data.
    let reads = providers_reads(&lab);
    let id = lab.send("c13", "next").await.unwrap().turn_id.unwrap();
    let sent = providers_reads(&lab);
    lab.control("reply", json!({"sessionID":session,"text":"Done.","info":flash(json!({"total":900}))})).await;
    lab.until("its end", |d| turn(d, &id)["status"] != "inProgress").await;
    assert!(sent >= reads);
    assert_eq!(providers_reads(&lab), sent, "the answer and its parts read no catalog");
    assert_eq!(holds_a_secret(&lab.dir.path().join("data")), None);
    lab.ws.close_agent(ID).await.unwrap();
}

/// What makes the usage last known, and what alone makes it fresh again
/// (T-10, contract on T-10 #757). After a message is added to a running
/// Turn, a late answer to the earlier one doesn't measure; the answer to the
/// newest does. An answer whose model the list didn't have is measured after
/// one read of the catalog, unless a new input came meanwhile, and a model
/// still unlisted is never read for again. A model chosen, a lost connection
/// and a Core restart make it last known; a snapshot of the same answer
/// doesn't make it fresh, a newer answer does.
#[tokio::test]
async fn context_usage_is_fresh_again_only_from_a_newer_answer_to_the_latest_input() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let flash = |total: u64| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":total}});
    let (first, measured) = answered(&lab, "c1", flash(100)).await;
    assert_eq!(measured, Some((100, 1000, first, false)));

    // A message added to the running Turn: the late answer to the first input stays unmeasured.
    let running = lab.send("c2", "Fix the build").await.unwrap().turn_id.unwrap();
    lab.until("the run", |d| d.agent.status == "working").await;
    lab.add("c3", "Also run the tests", &running).await.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Fixed.","parentID":running,"idle":false,"info":flash(300)})).await;
    lab.until("the late answer", |d| turn(d, &running)["_opencodeAnswers"].as_object().is_some_and(|a| a.len() == 1)).await;
    assert_eq!(usage_of(&lab.detail()).map(|u| (u.0, u.3)), Some((100, true)), "last known");
    lab.control("reply", json!({"sessionID":session,"text":"Tested.","info":flash(400)})).await;
    let d = lab.until("the end", |d| turn(d, &running)["status"] != "inProgress").await;
    assert_eq!(usage_of(&d), Some((400, 1000, running, false)), "the newest input's answer");

    // A model the list didn't have: one catalog read, then that same answer.
    let listing = |name: &str, window: u64| {
        let lab = &lab;
        let name = name.to_owned();
        async move {
            let mut providers = lab.control("mode", json!({})).await["providers"].clone();
            let deepseek = providers["providers"].as_array_mut().unwrap().iter_mut().find(|p| p["id"] == "deepseek").unwrap();
            let mut model = deepseek["models"]["deepseek-flash"].clone();
            model["id"] = json!(name);
            model["limit"]["context"] = json!(window);
            deepseek["models"][&name] = model;
            lab.control("mode", json!({"providers":providers})).await;
        }
    };
    listing("deepseek-pro", 8000).await;
    let reads = providers_reads(&lab);
    let pro = |total: u64| json!({"providerID":"deepseek","modelID":"deepseek-pro","tokens":{"total":total}});
    let (fourth, _) = answered(&lab, "c4", pro(1000)).await;
    let d = lab.until("the window read", |d| d.context_usage.as_ref().is_some_and(|u| !u.stale)).await;
    assert_eq!(usage_of(&d), Some((1000, 8000, fourth.clone(), false)));
    assert_eq!(providers_reads(&lab), reads + 1, "one read");

    // A model OpenCode doesn't list: one read, and never another for it.
    let ghost = json!({"providerID":"ghost","modelID":"never","tokens":{"total":50}});
    answered(&lab, "c5", ghost.clone()).await;
    for _ in 0..80 {
        if providers_reads(&lab) == reads + 2 { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    answered(&lab, "c6", ghost).await;
    unchanged(&lab, "an unlisted model", &Some((1000, 8000, fourth.clone(), true))).await;
    assert_eq!(providers_reads(&lab), reads + 2, "one read for it, not one per answer");

    // A new input while the read is under way: the answer that asked for it isn't measured.
    listing("deepseek-late", 3000).await;
    lab.control("mode", json!({"slow":{"/api/model":1.0}})).await;
    let late = json!({"providerID":"deepseek","modelID":"deepseek-late","tokens":{"total":60}});
    answered(&lab, "c7", late).await;
    let next = lab.send("c8", "next").await.unwrap().turn_id.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    lab.control("mode", json!({"slow":{}})).await;
    assert_eq!(providers_reads(&lab), reads + 3);
    assert_eq!(usage_of(&lab.detail()), Some((1000, 8000, fourth, true)), "the read came after a new input");
    lab.control("reply", json!({"sessionID":session,"text":"Done.","info":flash(70)})).await;
    let d = lab.until("its end", |d| turn(d, &next)["status"] != "inProgress").await;
    assert_eq!(usage_of(&d), Some((70, 1000, next.clone(), false)));

    // A model chosen: last known.
    lab.ws.opencode_set_model(ID, "deepseek/deepseek-flash".into()).await.unwrap();
    assert_eq!(usage_of(&lab.detail()), Some((70, 1000, next.clone(), true)));
    let (ninth, measured) = answered(&lab, "c9", flash(80)).await;
    assert_eq!(measured, Some((80, 1000, ninth.clone(), false)));

    // A lost connection: last known; the snapshot of the same answer leaves it so; a newer answer doesn't.
    let old = lab.seen()["pid"].as_u64().unwrap();
    lab.control("die", json!({})).await;
    lab.until("the lost connection", |d| d.agent.connection_state == "disconnected").await;
    assert!(ends(old).await);
    assert_eq!(usage_of(&lab.detail()), Some((80, 1000, ninth.clone(), true)));
    lab.ws.reconnect(ID).await.unwrap();
    assert_eq!(usage_of(&lab.detail()), Some((80, 1000, ninth, true)), "the same answer, read again");
    let (tenth, measured) = answered(&lab, "c10", flash(90)).await;
    assert_eq!(measured, Some((90, 1000, tenth.clone(), false)));

    // Core restarted: last known.
    let old = lab.seen()["pid"].as_u64().unwrap();
    let Lab { dir, ws } = lab;
    drop(ws);
    assert!(ends(old).await, "OpenCode ended with the Workspace");
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let d = ws.store.detail(ID).unwrap();
    assert_eq!(usage_of(&d), Some((90, 1000, tenth, true)));
}

/// R1 cca110b3: after a compaction, the answer OpenCode gives under its own
/// continuation message is the newest of the Turn, and measures under it.
#[tokio::test]
async fn context_usage_measures_the_answer_to_a_compactions_continuation() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let flash = |tokens: Value| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":tokens});
    let running = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Working.","idle":false,"info":flash(json!({"total":100}))})).await;
    lab.until("the first answer", |d| d.context_usage.is_some()).await;

    // A compaction, then OpenCode's own continuation under a later message of its own.
    let now = chrono::Utc::now().timestamp_millis();
    lab.control("event", json!({"type":"message.updated","properties":{"sessionID":session,"info":{
        "id":"msg_summary","sessionID":session,"role":"assistant","parentID":"msg_compaction","summary":true,
        "time":{"created":now},"tokens":{"total":900}}}})).await;
    lab.until("the compaction", |d| d.context_usage.as_ref().is_some_and(|u| u.stale)).await;
    let continued = "msg_fffffffffffffffffffffffffff";
    lab.control("store", json!({"sessionID":session,"messageID":continued,"text":"Continue if you have next steps"})).await;
    lab.control("reply", json!({"sessionID":session,"text":"Continued.","parentID":continued,"info":flash(json!({"total":300}))})).await;
    let d = lab.until("the continuation's answer", |d| d.context_usage.as_ref().is_some_and(|u| !u.stale)).await;
    assert_eq!(usage_of(&d), Some((300, 1000, running, false)), "measured under its Turn");
    lab.ws.close_agent(ID).await.unwrap();
}

/// R1 cca110b3: an answer waiting for a catalog read is no longer the newest
/// once a newer answer to the same input completes, even one that can't be
/// measured: however late the read comes, it measures nothing.
#[tokio::test]
async fn context_usage_an_answer_waiting_for_the_catalog_yields_to_a_newer_one() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let flash = |tokens: Value| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":tokens});
    let running = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Working.","idle":false,"info":flash(json!({"total":100}))})).await;
    lab.until("the first answer", |d| d.context_usage.is_some()).await;

    // An answer whose model waits for a slow catalog read, then a newer one that can't be measured.
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    let deepseek = providers["providers"].as_array_mut().unwrap().iter_mut().find(|p| p["id"] == "deepseek").unwrap();
    let mut slow = deepseek["models"]["deepseek-flash"].clone();
    slow["id"] = json!("deepseek-slow");
    slow["limit"]["context"] = json!(5000);
    deepseek["models"]["deepseek-slow"] = slow;
    lab.control("mode", json!({"providers":providers,"slow":{"/api/model":1.0}})).await;
    lab.control("reply", json!({"sessionID":session,"text":"Slow.","idle":false,
        "info":{"providerID":"deepseek","modelID":"deepseek-slow","tokens":{"total":500}}})).await;
    lab.control("reply", json!({"sessionID":session,"text":"Done.","info":flash(json!({"total":-1}))})).await;
    lab.until("the end", |d| turn(d, &running)["status"] != "inProgress").await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    lab.control("mode", json!({"slow":{}})).await;
    assert_eq!(usage_of(&lab.detail()), Some((100, 1000, running, true)), "the newest answer was unmeasurable: last known");
    lab.ws.close_agent(ID).await.unwrap();
}

/// R2 63d96eab: an answer older than one already seen never measures, even
/// arriving after it: a newer answer that couldn't be measured is still the
/// newest, so the older one doesn't wait for a catalog read either.
#[tokio::test]
async fn context_usage_an_older_answer_arriving_after_a_newer_one_never_measures() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let running = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();
    lab.control("reply", json!({"sessionID":session,"text":"Working.","idle":false,
        "info":{"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":100}}})).await;
    lab.until("the first answer", |d| d.context_usage.is_some()).await;
    // A model OpenCode lists now, which this connection's list doesn't have yet.
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    let deepseek = providers["providers"].as_array_mut().unwrap().iter_mut().find(|p| p["id"] == "deepseek").unwrap();
    let mut later = deepseek["models"]["deepseek-flash"].clone();
    later["id"] = json!("deepseek-later");
    later["limit"]["context"] = json!(5000);
    deepseek["models"]["deepseek-later"] = later;
    lab.control("mode", json!({"providers":providers})).await;
    let reads = providers_reads(&lab);

    // The newer answer first, unmeasurable; then the older one, naming that
    // model: 2.x's steps of the running Turn, each ended when OpenCode timed
    // it (T-32 slice 3b). Its events come in order, so this is a replay.
    let now = chrono::Utc::now().timestamp_millis();
    for (id, at, model, tokens) in [("msg_newer", now + 2000, "deepseek-flash", Value::Null),
        ("msg_older", now + 1000, "deepseek-later", json!({"input":500,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}))] {
        lab.control("event", json!({"type":"session.step.started","created":at,"properties":{"sessionID":session,"assistantMessageID":id,
            "model":{"id":model,"providerID":"deepseek"}}})).await;
        lab.control("event", json!({"type":"session.step.ended","created":at,"properties":{"sessionID":session,"assistantMessageID":id,
            "finish":"stop","tokens":tokens}})).await;
    }
    unchanged(&lab, "an older answer after a newer one", &Some((100, 1000, running, true))).await;
    assert_eq!(providers_reads(&lab), reads, "the older answer read no catalog");
    lab.ws.close_agent(ID).await.unwrap();
}

/// How many times OpenCode's session was read again whole after its stream broke.
fn resyncs(lab: &Lab) -> usize {
    journal(lab).iter().filter(|k| *k == "opencode/resynced").count()
}

/// R3 eb8dff5f: an answer considered once, measured or not, never measures
/// when the record is read again. One that waited for its model's window
/// while a new Turn began stays unmeasured after a resync, whose snapshot
/// holds it with its window now known: the new Turn's usage is last known
/// until its own answer.
#[tokio::test]
async fn context_usage_an_answer_read_again_after_a_resync_never_measures() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let flash = |total: u64| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":total}});
    let (first, measured) = answered(&lab, "c1", flash(100)).await;
    assert_eq!(measured, Some((100, 1000, first.clone(), false)));
    // A model OpenCode lists that this connection's list doesn't have, read slowly.
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    let deepseek = providers["providers"].as_array_mut().unwrap().iter_mut().find(|p| p["id"] == "deepseek").unwrap();
    let mut waiting = deepseek["models"]["deepseek-flash"].clone();
    waiting["id"] = json!("deepseek-wait");
    waiting["limit"]["context"] = json!(4000);
    deepseek["models"]["deepseek-wait"] = waiting;
    lab.control("mode", json!({"providers":providers,"slow":{"/api/model":1.0}})).await;
    answered(&lab, "c2", json!({"providerID":"deepseek","modelID":"deepseek-wait","tokens":{"total":500}})).await;
    // A new Turn while the read is under way: the waiting answer is dropped.
    let third = lab.send("c3", "next").await.unwrap().turn_id.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    lab.control("mode", json!({"slow":{}})).await;
    let last_known = Some((100, 1000, first.clone(), true));
    assert_eq!(usage_of(&lab.detail()), last_known);

    // The stream breaks; the snapshot read again holds the waiting answer, its window known now.
    let before = resyncs(&lab);
    lab.control("drop", json!({})).await;
    for _ in 0..200 {
        if resyncs(&lab) > before { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(&lab) > before, "read again");
    assert_eq!(usage_of(&lab.detail()), last_known, "the answer read again doesn't measure");
    lab.control("reply", json!({"sessionID":session,"text":"Done.","info":flash(300)})).await;
    let d = lab.until("its end", |d| turn(d, &third)["status"] != "inProgress").await;
    assert_eq!(usage_of(&d), Some((300, 1000, third, false)), "the new Turn's own answer");
    lab.ws.close_agent(ID).await.unwrap();
}

/// R3 eb8dff5f: of two answers to the same input completing in the same
/// millisecond, the later ID is the newer. A newer one that can't be
/// measured makes the usage last known; a newer one that can measures.
#[tokio::test]
async fn context_usage_a_newer_answer_in_the_same_millisecond_counts() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let running = lab.send("c1", "Start").await.unwrap().turn_id.unwrap();
    let at = chrono::Utc::now().timestamp_millis() + 1000;
    let answer = |id: &str, tokens: Value| json!({"type":"message.updated","properties":{"sessionID":session,"info":{
        "id":id,"sessionID":session,"role":"assistant","parentID":running,"time":{"created":at,"completed":at},
        "providerID":"deepseek","modelID":"deepseek-flash","tokens":tokens}}});
    lab.control("event", answer("msg_same_a", json!({"total":100}))).await;
    lab.until("the first answer", |d| d.context_usage.is_some()).await;
    assert_eq!(usage_of(&lab.detail()), Some((100, 1000, running.clone(), false)));
    lab.control("event", answer("msg_same_b", json!({"total":-1}))).await;
    lab.until("the newer, unmeasurable answer", |d| d.context_usage.as_ref().is_some_and(|u| u.stale)).await;
    assert_eq!(usage_of(&lab.detail()), Some((100, 1000, running.clone(), true)), "last known");
    lab.control("event", answer("msg_same_c", json!({"total":200}))).await;
    lab.until("the newest answer", |d| d.context_usage.as_ref().is_some_and(|u| !u.stale)).await;
    assert_eq!(usage_of(&lab.detail()), Some((200, 1000, running, false)));
    lab.ws.close_agent(ID).await.unwrap();
}

/// R4 46270ae8: a compaction makes last known only what is older than it.
/// When a resync replays its summary while a newer answer waits for its
/// model's window, that answer keeps waiting, and measures when the window
/// comes.
#[tokio::test]
async fn context_usage_a_replayed_summary_leaves_a_newer_waiting_answer_waiting() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let flash = |total: u64| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":total}});
    let (first, measured) = answered(&lab, "c1", flash(100)).await;
    assert_eq!(measured, Some((100, 1000, first.clone(), false)));
    // A compaction OpenCode stores, so that a resync reads its summary again.
    lab.control("reply", json!({"sessionID":session,"text":"Summary.","parentID":"msg_compaction","idle":false,
        "info":{"providerID":"deepseek","modelID":"deepseek-flash","summary":true,"tokens":{"total":900}}})).await;
    lab.until("the compaction", |d| d.context_usage.as_ref().is_some_and(|u| u.stale)).await;

    // A newer answer, whose model this connection's list doesn't have, waits for a slow read.
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    let deepseek = providers["providers"].as_array_mut().unwrap().iter_mut().find(|p| p["id"] == "deepseek").unwrap();
    let mut waiting = deepseek["models"]["deepseek-flash"].clone();
    waiting["id"] = json!("deepseek-wait");
    waiting["limit"]["context"] = json!(4000);
    deepseek["models"]["deepseek-wait"] = waiting;
    lab.control("mode", json!({"providers":providers,"slow":{"/api/model":3.0}})).await;
    let (second, _) = answered(&lab, "c2", json!({"providerID":"deepseek","modelID":"deepseek-wait","tokens":{"total":500}})).await;

    // The stream breaks; the resync replays the summary while the read is under way.
    let before = resyncs(&lab);
    lab.control("drop", json!({})).await;
    for _ in 0..200 {
        if resyncs(&lab) > before { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(&lab) > before, "read again");
    assert_eq!(usage_of(&lab.detail()), Some((100, 1000, first, true)), "the read hasn't come back yet");
    let d = lab.until("the window read", |d| d.context_usage.as_ref().is_some_and(|u| !u.stale)).await;
    lab.control("mode", json!({"slow":{}})).await;
    let measured = Some((500, 4000, second, false));
    assert_eq!(usage_of(&d), measured, "the newer answer kept waiting, and measured");
    // Read again, twice more: the summary and the answer replayed change nothing.
    for _ in 0..2 {
        let before = resyncs(&lab);
        lab.control("drop", json!({})).await;
        for _ in 0..200 {
            if resyncs(&lab) > before { break; }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(resyncs(&lab) > before, "read again");
        assert_eq!(usage_of(&lab.detail()), measured, "replayed once more");
    }
    lab.ws.close_agent(ID).await.unwrap();
}

/// R4 46270ae8, the other side: a compaction newer than an answer waiting
/// for its model's window drops that answer; the catalog read that follows
/// measures nothing, and what was measured stays last known. Both come while
/// no stream is open, so the resync reads the catalog before it returns, and
/// an event after it is handled only once that read and any write are done.
#[tokio::test]
async fn context_usage_a_newer_compaction_drops_an_answer_waiting_for_the_catalog() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let flash = |total: u64| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":total}});
    let (first, measured) = answered(&lab, "c1", flash(100)).await;
    assert_eq!(measured, Some((100, 1000, first.clone(), false)));
    // A model this connection's list doesn't have.
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    let deepseek = providers["providers"].as_array_mut().unwrap().iter_mut().find(|p| p["id"] == "deepseek").unwrap();
    let mut slow = deepseek["models"]["deepseek-flash"].clone();
    slow["id"] = json!("deepseek-slow");
    slow["limit"]["context"] = json!(5000);
    deepseek["models"]["deepseek-slow"] = slow;
    lab.control("mode", json!({"providers":providers})).await;

    // The stream breaks and can't reopen at once; meanwhile an answer of that model, then a compaction newer than it.
    let second = lab.send("c2", "next").await.unwrap().turn_id.unwrap();
    let subscribed = |lab: &Lab| lab.calls().iter().filter(|c| c["method"] == "GET" && c["path"] == "/api/event").count();
    let (reads, before, opened) = (providers_reads(&lab), resyncs(&lab), subscribed(&lab));
    lab.control("refuseEvents", json!({"seconds":0.4})).await;
    lab.control("drop", json!({})).await;
    for _ in 0..200 {
        if subscribed(&lab) > opened { break; }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(subscribed(&lab) > opened, "the stream ended, and opening it again was refused");
    lab.control("reply", json!({"sessionID":session,"text":"Slow.","idle":false,
        "info":{"providerID":"deepseek","modelID":"deepseek-slow","tokens":{"total":500}}})).await;
    lab.control("reply", json!({"sessionID":session,"text":"Summary.","parentID":"msg_compaction",
        "info":{"providerID":"deepseek","modelID":"deepseek-flash","summary":true,"tokens":{"total":900}}})).await;
    for _ in 0..200 {
        if resyncs(&lab) > before { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(&lab) > before, "read again");
    // Events of the new stream are handled once the resync, its catalog read included, has returned.
    // 2.x's execution end, as Core journals it (T-32 slice 3b).
    let statuses = |lab: &Lab| journal(lab).iter().filter(|k| k.starts_with("opencode/session.execution.")).count();
    let handled = statuses(&lab);
    lab.control("idle", json!({"sessionID":session})).await;
    for _ in 0..200 {
        if statuses(&lab) > handled { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(statuses(&lab) > handled, "an event after the resync");
    assert!(providers_reads(&lab) > reads, "the catalog was read");
    let d = lab.detail();
    assert_eq!(turn(&d, &second)["status"], "completed");
    assert_eq!(usage_of(&d), Some((100, 1000, first, true)), "the read measured nothing");

    // That resync read both from its snapshot, not from events after it: one more holds as many messages.
    let held = |lab: &Lab| -> Vec<u64> {
        let db = rusqlite::Connection::open(lab.dir.path().join("data/workspace.sqlite")).unwrap();
        let mut query = db.prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind='opencode/resynced' ORDER BY seq").unwrap();
        query.query_map([ID], |r| r.get::<_, String>(0)).unwrap()
            .map(|data| serde_json::from_str::<Value>(&data.unwrap()).unwrap()["messages"].as_u64().unwrap()).collect()
    };
    let again = resyncs(&lab);
    lab.control("drop", json!({})).await;
    for _ in 0..200 {
        if resyncs(&lab) > again { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(&lab) > again, "read once more");
    let counts = held(&lab);
    // The idle after it is a message of 2.x's own (T-32 slice 3b): the only one more.
    assert_eq!(counts[before] + 1, counts[counts.len() - 1], "the first resync's snapshot held the answer and the compaction");
    lab.ws.close_agent(ID).await.unwrap();
}

/// R5 0aa6e52c: an answer to an earlier Turn says nothing of now, however
/// late it comes, after a resync or a reconnect too. With an earlier Turn
/// measured and a newer Turn's answer unmeasurable, a late answer to the
/// earlier Turn, newer than what was measured and older than that answer,
/// changes nothing; a newer valid answer measures.
#[tokio::test]
async fn context_usage_a_late_answer_of_an_earlier_turn_never_measures() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let flash = |total: Value| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":total}});
    let (first, measured) = answered(&lab, "c1", flash(json!(100))).await;
    assert_eq!(measured, Some((100, 1000, first.clone(), false)));
    let last_known = Some((100, 1000, first.clone(), true));
    let second = lab.send("c2", "next").await.unwrap().turn_id.unwrap();
    let newer = lab.control("reply", json!({"sessionID":session,"text":"Done.","info":flash(json!(-1))})).await;
    let d = lab.until("its end", |d| turn(d, &second)["status"] != "inProgress").await;
    assert_eq!(usage_of(&d), last_known, "the newer Turn's answer can't be measured");

    // A late answer to the earlier Turn, between what was measured and the
    // newer Turn's answer, stored as OpenCode would.
    let measured_at = chrono::DateTime::parse_from_rfc3339(&d.context_usage.as_ref().unwrap().updated_at).unwrap().timestamp_millis();
    let at = measured_at + 1;
    assert!(at < newer["time"]["completed"].as_i64().unwrap(), "{at} before the newer answer");
    let mut late = flash(json!(900));
    late["time"] = json!({"created":at,"completed":at});
    // Each answer's record change, the one that measures it or not, is journaled.
    // 2.x's step end, as Core journals it (T-32 slice 3b).
    let updates = |lab: &Lab| journal(lab).iter().filter(|k| *k == "opencode/session.step.ended").count();
    let handled = updates(&lab);
    lab.control("reply", json!({"sessionID":session,"text":"Late.","parentID":first,"idle":false,"info":late})).await;
    for _ in 0..200 {
        if updates(&lab) > handled { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(updates(&lab) > handled, "the late answer handled");
    assert_eq!(usage_of(&lab.detail()), last_known, "a late answer to an earlier Turn measures nothing");

    // A newer valid answer measures.
    let (third, measured) = answered(&lab, "c3", flash(json!(300))).await;
    let fresh = Some((300, 1000, third.clone(), false));
    assert_eq!(measured, fresh);

    // Read again, the late answer among the stored ones: nothing changes.
    let before = resyncs(&lab);
    lab.control("drop", json!({})).await;
    for _ in 0..200 {
        if resyncs(&lab) > before { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(&lab) > before, "read again");
    assert_eq!(usage_of(&lab.detail()), fresh, "after a resync");

    // A lost connection makes it last known; the new connection reads every
    // stored answer again, with nothing of the old one's memory, and that
    // changes nothing.
    let old = lab.seen()["pid"].as_u64().unwrap();
    lab.control("die", json!({})).await;
    lab.until("the lost connection", |d| d.agent.connection_state == "disconnected").await;
    assert!(ends(old).await);
    let last_known = Some((300, 1000, third, true));
    assert_eq!(usage_of(&lab.detail()), last_known);
    lab.ws.reconnect(ID).await.unwrap();
    assert_eq!(usage_of(&lab.detail()), last_known, "after a reconnect");
    lab.ws.close_agent(ID).await.unwrap();
}

/// R5 0aa6e52c, the latest input's side: once a newer Turn is asked, a late
/// answer to the earlier one, newer than any answer considered, still says
/// nothing of now. What was measured stays last known until the new
/// input's own answer.
#[tokio::test]
async fn context_usage_a_late_answer_after_a_new_input_never_measures() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let flash = |total: Value| json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":total}});
    let (first, measured) = answered(&lab, "c1", flash(json!(100))).await;
    assert_eq!(measured, Some((100, 1000, first.clone(), false)));
    let second = lab.send("c2", "next").await.unwrap().turn_id.unwrap();
    let d = lab.detail();
    let last_known = Some((100, 1000, first.clone(), true));
    assert_eq!(usage_of(&d), last_known, "a new input");

    // Newer than the measured answer, the newest considered.
    let at = chrono::DateTime::parse_from_rfc3339(&d.context_usage.as_ref().unwrap().updated_at).unwrap().timestamp_millis() + 1;
    let mut late = flash(json!(900));
    late["time"] = json!({"created":at,"completed":at});
    // 2.x's step end, as Core journals it (T-32 slice 3b).
    let updates = |lab: &Lab| journal(lab).iter().filter(|k| *k == "opencode/session.step.ended").count();
    let handled = updates(&lab);
    // 2.x: the end of a step this connection never saw start (one of the
    // earlier Turn's, before the new input), its tokens as OpenCode counted
    // them (T-32 slice 3b). Its events come in order, so this is a replay.
    let _ = late;
    lab.control("event", json!({"type":"session.step.ended","created":at,"properties":{"sessionID":session,"assistantMessageID":"msg_late",
        "finish":"stop","tokens":{"input":900,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}})).await;
    for _ in 0..200 {
        if updates(&lab) > handled { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(updates(&lab) > handled, "the late answer handled");
    assert_eq!(usage_of(&lab.detail()), last_known, "a late answer to the earlier Turn measures nothing");

    // The new input's own answer measures.
    lab.control("reply", json!({"sessionID":session,"text":"Done.","info":flash(json!(300))})).await;
    let d = lab.until("its end", |d| turn(d, &second)["status"] != "inProgress").await;
    assert_eq!(usage_of(&d), Some((300, 1000, second, false)));
    lab.ws.close_agent(ID).await.unwrap();
}

/// What R6's two tests share: a measured first answer, then a compaction
/// 100 ms after it whose summary OpenCode doesn't store (so a reconnect
/// can't read it again). The first Turn, what is last known after the
/// compaction, and a time between the two.
async fn measured_then_compacted(lab: &Lab) -> (String, Option<(u64, u64, String, bool)>, i64) {
    let session = lab.session();
    let flash = json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":100}});
    let (first, measured) = answered(lab, "c1", flash).await;
    assert_eq!(measured, Some((100, 1000, first.clone(), false)));
    let measured_at = chrono::DateTime::parse_from_rfc3339(&lab.detail().context_usage.as_ref().unwrap().updated_at)
        .unwrap().timestamp_millis();
    let compacted_at = measured_at + 100;
    lab.control("event", json!({"type":"message.updated","properties":{"sessionID":session,"info":{
        "id":"msg_summary","sessionID":session,"role":"assistant","parentID":"msg_compaction","summary":true,
        "time":{"created":compacted_at,"completed":compacted_at},"tokens":{"total":900}}}})).await;
    let d = lab.until("the compaction", |d| d.context_usage.as_ref().is_some_and(|u| u.stale)).await;
    let last_known = Some((100, 1000, first.clone(), true));
    assert_eq!(usage_of(&d), last_known);
    (first, last_known, measured_at + 50)
}

/// R6 b6556a88: a compaction is a boundary for answers. An answer to the
/// latest input that completed before it, never considered, newer than the
/// last one that was, arrives after it: it measures nothing, then or when a
/// new connection reads it again. An answer after the compaction measures.
#[tokio::test]
async fn context_usage_a_late_answer_from_before_a_compaction_never_measures() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let (first, last_known, before) = measured_then_compacted(&lab).await;

    // The late answer, stored as OpenCode would; its record change is journaled.
    // 2.x's step end, as Core journals it (T-32 slice 3b).
    let updates = |lab: &Lab| journal(lab).iter().filter(|k| *k == "opencode/session.step.ended").count();
    let handled = updates(&lab);
    lab.control("reply", json!({"sessionID":session,"text":"Late.","parentID":first,"idle":false,"info":{
        "providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":900},"time":{"created":before,"completed":before}}})).await;
    for _ in 0..200 {
        if updates(&lab) > handled { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(updates(&lab) > handled, "the late answer handled");
    assert_eq!(usage_of(&lab.detail()), last_known, "an answer from before the compaction measures nothing");

    // A new connection reads the stored late answer again, without the
    // summary: the boundary is kept with the Agent, so nothing changes.
    let old = lab.seen()["pid"].as_u64().unwrap();
    lab.control("die", json!({})).await;
    lab.until("the lost connection", |d| d.agent.connection_state == "disconnected").await;
    assert!(ends(old).await);
    lab.ws.reconnect(ID).await.unwrap();
    assert_eq!(usage_of(&lab.detail()), last_known, "after a reconnect");

    // An answer after the compaction measures.
    let flash = json!({"providerID":"deepseek","modelID":"deepseek-flash","tokens":{"total":300}});
    let (next, measured) = answered(&lab, "c2", flash).await;
    assert_eq!(measured, Some((300, 1000, next, false)));
    lab.ws.close_agent(ID).await.unwrap();
}

/// R6 b6556a88, the catalog's side: an answer from before a compaction whose
/// model this connection's list doesn't have starts no catalog read. The
/// read is decided once the answer's record change is written, before the
/// next event is handled; that event is the barrier.
#[tokio::test]
async fn context_usage_a_late_answer_from_before_a_compaction_reads_no_catalog() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    // A model OpenCode lists that this connection's list doesn't have.
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    let deepseek = providers["providers"].as_array_mut().unwrap().iter_mut().find(|p| p["id"] == "deepseek").unwrap();
    let mut unlisted = deepseek["models"]["deepseek-flash"].clone();
    unlisted["id"] = json!("deepseek-unlisted");
    unlisted["limit"]["context"] = json!(5000);
    deepseek["models"]["deepseek-unlisted"] = unlisted;
    lab.control("mode", json!({"providers":providers})).await;
    let (first, last_known, before) = measured_then_compacted(&lab).await;

    let reads = providers_reads(&lab);
    // 2.x's step end, as Core journals it (T-32 slice 3b).
    let updates = |lab: &Lab| journal(lab).iter().filter(|k| *k == "opencode/session.step.ended").count();
    // 2.x's execution end, as Core journals it (T-32 slice 3b).
    let statuses = |lab: &Lab| journal(lab).iter().filter(|k| k.starts_with("opencode/session.execution.")).count();
    let handled = updates(&lab);
    lab.control("reply", json!({"sessionID":session,"text":"Late.","parentID":first,"idle":false,"info":{
        "providerID":"deepseek","modelID":"deepseek-unlisted","tokens":{"total":500},"time":{"created":before,"completed":before}}})).await;
    for _ in 0..200 {
        if updates(&lab) > handled { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(updates(&lab) > handled, "the late answer handled");
    // An event after it is handled once that answer's handling, a catalog read decided or not, is done.
    let status = statuses(&lab);
    lab.control("idle", json!({"sessionID":session})).await;
    for _ in 0..200 {
        if statuses(&lab) > status { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(statuses(&lab) > status, "an event after the late answer");
    // A read started then would reach OpenCode at once; none did, and nothing measured.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(providers_reads(&lab), reads, "no catalog read for an answer from before the compaction");
    assert_eq!(usage_of(&lab.detail()), last_known);
    lab.ws.close_agent(ID).await.unwrap();
}

/// 2.x's text as it streams: its deltas, gathered for a quarter of a second
/// of OpenCode's own time, grow the answer's item, which its end then
/// replaces whole (T-32 slice 3b). The item is `<answer>:<ordinal>`.
#[tokio::test]
async fn an_answers_text_streams_into_its_item_and_its_end_replaces_it() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let id = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    let t = chrono::Utc::now().timestamp_millis();
    let event = |kind: &str, at: i64, data: Value| {
        let mut properties = json!({"sessionID": session, "assistantMessageID": "msg_s1"});
        properties.as_object_mut().unwrap().extend(data.as_object().unwrap().clone());
        json!({"type": kind, "created": at, "properties": properties})
    };
    let text = |d: &AgentDetail| turn(d, &id)["items"].as_array().into_iter().flatten()
        .find(|i| i["id"] == "msg_s1:0").map(|i| i["text"].clone());
    for (kind, at, data) in [
        ("session.step.started", t, json!({"model": {"id": "m", "providerID": "p"}})),
        ("session.text.started", t, json!({"ordinal": 0})),
        ("session.text.delta", t + 10, json!({"ordinal": 0, "delta": "Hel"})),
        ("session.text.delta", t + 300, json!({"ordinal": 0, "delta": "lo"})),
    ] {
        lab.control("event", event(kind, at, data)).await;
    }
    lab.until("the text streamed", |d| text(d) == Some(json!("Hello"))).await;
    lab.control("event", event("session.text.delta", t + 310, json!({"ordinal": 0, "delta": " wor"}))).await;
    lab.control("event", event("session.text.ended", t + 320, json!({"ordinal": 0, "text": "Hello world"}))).await;
    lab.until("the whole text", |d| text(d) == Some(json!("Hello world"))).await;
    lab.control("event", event("session.step.ended", t + 330, json!({"finish": "stop", "tokens": null}))).await;
    lab.control("idle", json!({"sessionID": session})).await;
    let d = lab.until("its end", |d| turn(d, &id)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &id)["status"], "completed");
    let streamed = journal(&lab).iter().filter(|k| *k == "opencode/session.text.delta").count();
    assert_eq!(streamed, 1, "one journal row for the deltas written together, none for one still gathering");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A whole read in mid-step: 2.x stores no text until its entry ends, so the
/// read finds the entry empty, and the text streamed so far is kept (T-32
/// slice 3b; a limit, Lead 4983 note 4).
#[tokio::test]
async fn a_whole_read_in_mid_step_keeps_the_text_streamed_so_far() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let id = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    let t = chrono::Utc::now().timestamp_millis();
    let event = |kind: &str, at: i64, data: Value| {
        let mut properties = json!({"sessionID": session, "assistantMessageID": "msg_s1"});
        properties.as_object_mut().unwrap().extend(data.as_object().unwrap().clone());
        json!({"type": kind, "created": at, "properties": properties})
    };
    let text = |d: &AgentDetail| turn(d, &id)["items"].as_array().into_iter().flatten()
        .find(|i| i["id"] == "msg_s1:0").map(|i| i["text"].clone());
    for (kind, at, data) in [
        ("session.step.started", t, json!({"model": {"id": "m", "providerID": "p"}})),
        ("session.text.started", t, json!({"ordinal": 0})),
        ("session.text.delta", t + 10, json!({"ordinal": 0, "delta": "Hel"})),
        ("session.text.delta", t + 300, json!({"ordinal": 0, "delta": "lo"})),
    ] {
        lab.control("event", event(kind, at, data)).await;
    }
    lab.until("the text streamed", |d| text(d) == Some(json!("Hello"))).await;
    // The stream breaks; OpenCode holds the answer as 2.x does in mid-step, its text entry empty.
    let before = resyncs(&lab);
    lab.control("refuseEvents", json!({"seconds":1.0})).await;
    lab.control("drop", json!({})).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    lab.control("reply", json!({"sessionID":session,"text":"","completed":false,"idle":false,"info":{"id":"msg_s1"}})).await;
    for _ in 0..400 {
        if resyncs(&lab) > before { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(&lab) > before, "read whole");
    assert_eq!(text(&lab.detail()), Some(json!("Hello")), "the text streamed so far is kept");
    lab.ws.close_agent(ID).await.unwrap();
}

/// OpenCode 2.x's own permission request and form (T-32 slice 4a): shown at
/// once with why Yuzuno can't answer them yet, so their run is seen to wait
/// on them, and an answer is refused before anything is sent.
#[tokio::test]
async fn a_2x_request_is_shown_waiting_for_an_answer_yuzuno_cannot_give_yet() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let running = lab.send("c1", "work").await.unwrap().turn_id.unwrap();
    lab.control("event", json!({"type":"permission.asked","properties":{"id":"per_v2","sessionID":session,"action":"bash","resources":["ls"]}})).await;
    lab.control("event", json!({"type":"form.created","properties":{"form":{"id":"frm_v2","sessionID":session,"title":"Pick one",
        "fields":[{"key":"a","type":"string"}]}}})).await;
    let d = lab.until("both requests", |d| d.pending.len() == 2).await;
    assert_eq!(d.agent.status, "waiting");
    for p in &d.pending {
        let note = p.params["_opencodeNotYet"].as_str().unwrap_or_default();
        assert!(note.contains("not yet on OpenCode 2.x") && note.contains("只能中断这一轮"), "shown waiting for an answer Yuzuno can't give yet: {p:?}");
        assert_eq!(p.params["turnId"], running.as_str());
        let answered = lab.ws.respond(&p.id, json!({"decision":"reject"})).await.map_err(|e| e.to_string());
        assert!(answered.as_ref().is_err_and(|e| e.contains("not yet on OpenCode 2.x")), "an answer refused as not yet: {answered:?}");
    }
    assert!(lab.posts("/permission/").is_empty() && lab.posts("/question/").is_empty(), "no answer was sent");
    // 2.x's form ends as Core's question does: no longer waiting.
    lab.control("event", json!({"type":"form.cancelled","properties":{"id":"frm_v2","sessionID":session}})).await;
    lab.until("the form's end", |d| d.pending.iter().all(|p| p.params["id"] != "frm_v2")).await;
    // Interrupting is the way on: the run's end ends the permission request, which 2.x answers with no event.
    lab.control("event", json!({"type":"session.execution.interrupted","properties":{"sessionID":session,"reason":"user"}})).await;
    lab.until("the run's end ending its request", |d| d.pending.is_empty() && d.agent.status != "waiting").await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// A shell command run in OpenCode while a Turn runs (T-32 slice 4a, D2):
/// that Turn's command item, read whole the same; it answers nothing.
#[tokio::test]
async fn a_shell_command_shows_in_its_turn_as_a_command_item_live_and_read_whole() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let running = lab.send("c1", "work").await.unwrap().turn_id.unwrap();
    let shell = lab.control("shell", json!({"sessionID":session,"command":"ls","output":"a.txt\n"})).await;
    let shell = shell.as_str().unwrap().to_owned();
    let item = |d: &AgentDetail| turn(d, &running)["items"].as_array().into_iter().flatten().find(|i| i["id"] == shell.as_str()).cloned();
    let d = lab.until("the command item", |d| item(d).is_some_and(|i| i["status"] == "completed")).await;
    let live = item(&d).unwrap();
    assert_eq!((&live["type"], &live["command"], &live["aggregatedOutput"], &live["exitCode"]),
        (&json!("commandExecution"), &json!("ls"), &json!("a.txt\n"), &json!(0)), "shown as a command item: {live}");
    let before = resyncs(&lab);
    lab.control("drop", json!({})).await;
    for _ in 0..400 {
        if resyncs(&lab) > before { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(&lab) > before, "read whole");
    let d = lab.detail();
    assert_eq!(item(&d), Some(live), "read whole as live");
    assert_eq!(turn(&d, &running)["status"], "inProgress", "a shell command answers nothing");
    lab.ws.close_agent(ID).await.unwrap();
}

/// Until a whole read's stream is open again: the stream breaks, it is
/// refused for a second, and `meanwhile` happens with no stream to see it.
async fn read_whole_meanwhile(lab: &Lab, meanwhile: Value) {
    let before = resyncs(lab);
    lab.control("refuseEvents", json!({"seconds":1.0})).await;
    lab.control("drop", json!({})).await;
    // The broken stream has ended: the stand-in's looks for the break every 20 ms.
    tokio::time::sleep(Duration::from_millis(200)).await;
    lab.control("reply", meanwhile).await;
    for _ in 0..400 {
        if resyncs(lab) > before { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(lab) > before, "read whole");
}

/// A whole read while an answer's step is under way, then the step's end on
/// the stream, which names neither its model nor its start: the answer ends
/// with those the read found, so its context usage is measured, not left
/// stale with the answer taken as considered (T-32 slice 3b, R1 98de4ffb).
#[tokio::test]
async fn a_step_under_way_at_a_whole_read_ends_with_its_model_and_is_measured() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let id = lab.send("c1", "hello").await.unwrap().turn_id.unwrap();
    read_whole_meanwhile(&lab, json!({"sessionID":session,"text":"","completed":false,"idle":false,
        "info":{"id":"msg_s1","providerID":"deepseek","modelID":"deepseek-flash"}})).await;
    let t = chrono::Utc::now().timestamp_millis();
    lab.control("event", json!({"type":"session.step.ended","created":t,"properties":{"sessionID":session,"assistantMessageID":"msg_s1",
        "finish":"stop","tokens":{"total":300}}})).await;
    let d = lab.until("the usage measured", |d| usage_of(d).is_some_and(|u| !u.3)).await;
    assert_eq!(usage_of(&d), Some((300, 1000, id.clone(), false)));
    assert_eq!(d.opencode_usage_seen.as_ref().map(|s| s.answer.as_str()), Some("msg_s1"), "the answer considered is the one measured");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A whole read while a sub-agent's tool runs, then the tool's end on the
/// stream, which names neither the tool nor its input: the tool keeps those
/// the read found, so the sub-agent it names is still learnt from it, here
/// the only way it is (T-32 slice 3b, R1 98de4ffb).
#[tokio::test]
async fn a_tool_under_way_at_a_whole_read_ends_with_its_name_and_input() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let id = lab.send("c1", "work").await.unwrap().turn_id.unwrap();
    // Not among the Agent's children OpenCode lists, and never announced: only its tool names it.
    let child = lab.control("child", json!({"parentID":"ses_elsewhere","title":"unlisted","announce":false})).await;
    let child = child["id"].as_str().unwrap().to_owned();
    let input = json!({"description":"Find the files","subagent_type":"explore","prompt":"find"});
    read_whole_meanwhile(&lab, json!({"sessionID":session,"completed":false,"idle":false,"info":{"id":"msg_s2"},
        "parts":[{"type":"tool","tool":"task","callID":"call_1","state":{"status":"running","input":input,"metadata":{"sessionId":child}}}]})).await;
    let tool = |d: &AgentDetail| turn(d, &id)["items"].as_array().into_iter().flatten().find(|i| i["id"] == "call_1").cloned();
    assert_eq!(tool(&lab.detail()).map(|t| t["name"].clone()), Some(json!("subagent")), "the read restored it");
    let t = chrono::Utc::now().timestamp_millis();
    lab.control("event", json!({"type":"session.tool.success","created":t,"properties":{"sessionID":session,"assistantMessageID":"msg_s2",
        "id":"call_1","content":[{"type":"text","text":"Found."}],"metadata":{"sessionID":child},"executed":true}})).await;
    let d = lab.until("the tool's end", |d| tool(d).is_some_and(|t| t["status"] == "completed")).await;
    let ended = tool(&d).unwrap();
    assert_eq!((&ended["name"], &ended["input"]), (&json!("subagent"), &input), "the tool keeps its name and input");
    // The sub-agent it names is the Agent's: its request is shown with it.
    let asked = lab.control("ask", json!({"sessionID":child})).await;
    let d = lab.until("the sub-agent's request", |d| d.pending.iter().any(|p| p.params["id"] == asked["id"])).await;
    let p = d.pending.iter().find(|p| p.params["id"] == asked["id"]).unwrap();
    assert_eq!(p.params["_opencodeChild"], json!({"title":"Find the files","agent":"explore"}), "learnt from its tool");
    lab.ws.close_agent(ID).await.unwrap();
}

/// Two user messages in one turn, the answers interleaved: each answer is
/// the newest one's before it, as 2.x delivers a message steered in at its
/// next step (T-32 slice 3b, Lead 4983 note 2), and a whole read of the
/// turn says the same. A Core-chosen ID is the one 2.x delivers each under
/// (note 3). The added message is confirmed once 2.x admits it, before it is
/// delivered.
#[tokio::test]
async fn interleaved_answers_each_answer_the_newest_user_message_before_them() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let first = lab.send("c1", "Fix the build").await.unwrap().turn_id.unwrap();
    lab.until("the run", |d| d.agent.status == "working").await;
    lab.control("reply", json!({"sessionID":session,"text":"Looking.","parentID":first,"idle":false})).await;
    // Only 2.x's event of its admission can confirm it: OpenCode's record of the message cannot be read, in its
    // inbox (read first) nor among its messages.
    let mut fail = serde_json::Map::new();
    fail.insert(format!("/api/session/{session}/inbox"), json!(500));
    lab.control("mode", json!({"failMessageReads":true,"fail":fail})).await;
    let receipt = lab.add("c2", "Also run the tests", &first).await.unwrap();
    assert_eq!(receipt.status, "accepted", "confirmed once 2.x admits it: {receipt:?}");
    lab.control("mode", json!({"failMessageReads":false,"fail":{}})).await;
    let added = lab.detail().turns.iter().find(|t| t["id"] == first.as_str()).unwrap()["_opencodeLastInput"].as_str().unwrap().to_owned();
    let delivered = || {
        let db = rusqlite::Connection::open(lab.dir.path().join("data/workspace.sqlite")).unwrap();
        let ids: Vec<String> = db.prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind='opencode/session.inbox.delivered' ORDER BY seq").unwrap()
            .query_map([ID], |r| r.get::<_, String>(0)).unwrap()
            .map(|data| serde_json::from_str::<Value>(&data.unwrap()).unwrap()["data"]["inboxID"].as_str().unwrap().to_owned()).collect();
        ids
    };
    assert_eq!(delivered(), [first.as_str()], "admitted, not yet delivered");
    // A step already under way when it was sent answers the first message; the next ones, the added one.
    lab.control("reply", json!({"sessionID":session,"text":"Still the build.","parentID":first,"idle":false})).await;
    lab.control("reply", json!({"sessionID":session,"text":"Running tests.","parentID":added,"idle":false})).await;
    lab.control("reply", json!({"sessionID":session,"text":"All pass.","parentID":added})).await;
    let d = lab.until("its end", |d| turn(d, &first)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &first)["status"], "completed");
    let answers = turn(&d, &first)["_opencodeAnswers"].as_object().unwrap().clone();
    let parents: Vec<&str> = answers.values().map(|a| a["parent"].as_str().unwrap()).collect();
    assert_eq!(parents, [first.as_str(), first.as_str(), added.as_str(), added.as_str()], "{answers:#?}");
    // Each message was delivered under the ID Core chose for it.
    assert_eq!(delivered(), [first.clone(), added.clone()], "delivered under the IDs Core chose");
    // A whole read of the session says the same of each answer.
    let before = resyncs(&lab);
    lab.control("drop", json!({})).await;
    for _ in 0..200 {
        if resyncs(&lab) > before { break; }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(resyncs(&lab) > before, "read again");
    assert_eq!(turn(&lab.detail(), &first)["_opencodeAnswers"].as_object().unwrap(), &answers, "the same answers, read whole");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A message 2.x admits into its inbox, to be delivered at the run's next
/// step, with no event Core sees, while OpenCode's record of it can't be
/// read: Core's own look for it finds nothing in time, so it is unknown. The
/// whole read once the stream reopens finds it in the inbox, and that
/// confirms it (T-32 slice 3b; the record unreadable in the inbox too since
/// Core reads the inbox first, R5 728f7e52).
#[tokio::test]
async fn a_message_admitted_while_the_stream_is_broken_is_confirmed_from_the_inbox() {
    let lab = lab(&[], false).await;
    let session = lab.session();
    let first = lab.send("c1", "Fix the build").await.unwrap().turn_id.unwrap();
    lab.until("the run", |d| d.agent.status == "working").await;
    // Nothing but a whole read can confirm it: no event of its admission, and OpenCode's record of it unreadable.
    let mut fail = serde_json::Map::new();
    fail.insert(format!("/api/session/{session}/inbox"), json!(500));
    lab.control("mode", json!({"prompt":"store-unannounced","failMessageReads":true,"fail":fail})).await;
    let receipt = lab.add("c2", "Also run the tests", &first).await.unwrap();
    assert_eq!(receipt.status, "uncertain", "nothing confirmed it in time: {receipt:?}");
    lab.control("mode", json!({"prompt":"store","failMessageReads":false,"fail":{}})).await;
    let before = resyncs(&lab);
    lab.control("refuseEvents", json!({"seconds":0.3})).await;
    lab.control("drop", json!({})).await;
    let confirmed = |d: &AgentDetail| {
        let t = turn(d, &first);
        t["_opencodeLastInput"].as_str().is_some_and(|added| t["_opencodeInputs"][added]["confirmed"] == true)
    };
    let d = lab.until("confirmed by the read after the stream reopened", confirmed).await;
    assert!(resyncs(&lab) > before, "read again");
    let added = turn(&d, &first)["_opencodeLastInput"].as_str().unwrap().to_owned();
    // Delivered at the next step, which answers it, and that ends the turn.
    lab.control("reply", json!({"sessionID":session,"text":"Tests pass.","parentID":added})).await;
    let d = lab.until("its end", |d| turn(d, &first)["status"] != "inProgress").await;
    assert_eq!(turn(&d, &first)["status"], "completed");
    lab.ws.close_agent(ID).await.unwrap();
}

fn holds_bytes(path: &std::path::Path, text: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| bytes.windows(text.len()).any(|w| w == text.as_bytes()))
}

/// A file under `dir`, read whole, that holds `text`.
fn file_holding(dir: &std::path::Path, text: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().path()).find_map(|path| match path.is_dir() {
        true => file_holding(&path, text),
        false => holds_bytes(&path, text).then_some(path),
    })
}

fn key_login(integration: &str, key: &str, label: Option<&str>) -> KeyLogin {
    KeyLogin { integration: integration.into(), key: key.into(), label: label.map(str::to_owned), answer: None }
}

/// An OpenCode Agent is logged in with a key through its own OpenCode (T-32
/// slice 4b, the user's decision 4142): listed by its label, never by its
/// value. The key reaches that OpenCode, and Core keeps it nowhere: not its
/// database or WAL, the Agent's record, any answer, or an error, which says
/// OpenCode's status and kind only, even when OpenCode's answer echoes it.
/// Core never reads a credential back. Logged out, it is gone from OpenCode.
#[tokio::test]
async fn an_agent_logs_in_with_a_key_through_its_own_opencode_and_core_keeps_it_nowhere() {
    const KEY: &str = "fixture-login-key-Zq81";
    let lab = lab(&[], false).await;
    let view = serde_json::to_value(lab.ws.opencode_logins(ID).await.unwrap()).unwrap();
    assert_eq!((&view["state"], &view["version"]), (&json!("ready"), &json!("2.2.5")), "{view}");
    let listed = |view: &Value| view["integrations"].as_array().unwrap().iter().find(|i| i["id"] == "openrouter").cloned().unwrap();
    assert_eq!(listed(&view)["methods"][0]["kind"], "key", "a configured provider takes a key");
    assert!(!view.to_string().contains("fixture-secret"), "nothing secret of OpenCode's list is passed on: {view}");

    let after = serde_json::to_value(lab.ws.opencode_login_key(ID, key_login("openrouter", KEY, Some("work"))).await.unwrap()).unwrap();
    let connections: Vec<(Value, Value)> = listed(&after)["connections"].as_array().unwrap().iter()
        .map(|c| (c["kind"].clone(), c["label"].clone())).collect();
    assert_eq!(connections, [(json!("credential"), json!("work"))], "logged in, shown by its label");
    assert!(lab.control("logins", json!({})).await["credentials"].to_string().contains(KEY), "the key reached the Agent's own OpenCode");

    lab.control("mode", json!({"loginRefuse": true})).await;
    let refused = lab.ws.opencode_login_key(ID, key_login("openrouter", KEY, None)).await.unwrap_err().to_string();
    assert!(refused.contains("HTTP 400") && refused.contains("integration_authorization"), "its status and kind: {refused}");
    lab.control("mode", json!({"loginRefuse": false})).await;

    let record = serde_json::to_string(&lab.detail()).unwrap();
    for (what, text) in [("the login's answer", after.to_string()), ("the refusal", refused), ("the Agent's record", record)] {
        assert!(!text.contains(KEY), "the key is in {what}");
    }
    for name in ["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm"] {
        assert!(!holds_bytes(&lab.dir.path().join("data").join(name), KEY), "the key is in {name}");
    }
    let rows: Vec<String> = rusqlite::Connection::open(lab.dir.path().join("data/workspace.sqlite")).unwrap()
        .prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind='opencode/loggedIn'").unwrap()
        .query_map([ID], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(rows.iter().map(|r| serde_json::from_str::<Value>(r).unwrap()).collect::<Vec<_>>(),
        [json!({"integration":"openrouter","method":"key","label":"work"})], "the journal keeps which integration and label only");
    assert!(lab.calls().iter().all(|c| !(c["method"] == "GET" && c["path"].as_str().unwrap().starts_with("/api/credential"))),
        "Core never reads a credential back");

    let credential = listed(&after)["connections"][0]["id"].as_str().unwrap().to_owned();
    let out = serde_json::to_value(lab.ws.opencode_logout(ID, &credential).await.unwrap()).unwrap();
    assert!(listed(&out)["connections"].as_array().unwrap().is_empty(), "logged out");
    assert_eq!(lab.control("logins", json!({})).await["credentials"], json!({}), "gone from the Agent's OpenCode");
    assert!(journal(&lab).iter().any(|k| k == "opencode/loggedOut"));
    lab.ws.close_agent(ID).await.unwrap();
}

/// A device sign-in is shown, link and instructions, and logs in once its
/// provider completes it; a code one completes with the code it gave. One
/// whose page sends the browser back to this computer is cancelled at
/// OpenCode at once and its link never shown (D7): sign in from OpenCode
/// itself.
#[tokio::test]
async fn a_device_sign_in_is_shown_and_one_that_sends_the_browser_back_here_is_cancelled_unshown() {
    let lab = lab(&[], false).await;
    let browser = "https://auth.example.com/authorize?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
    lab.control("mode", json!({
        "integrations": [{"id":"example","name":"Example","methods":[
            {"type":"oauth","id":"example/device","label":"Device"},
            {"type":"oauth","id":"example/browser","label":"Browser"},
            {"type":"oauth","id":"example/code","label":"Code"}]}],
        "oauth": {"example/device": {"url":"https://example.com/login/device","instructions":"Enter code WXYZ-0001"},
            "example/browser": {"url": browser}, "example/code": {"url":"https://example.com/code","mode":"code"}}})).await;
    let start = |method: &str| lab.ws.opencode_login_oauth(ID, OAuthLogin { integration: "example".into(), method: method.into(), answer: None });
    let logins = || async { lab.control("logins", json!({})).await };

    let device = start("example/device").await.unwrap();
    assert_eq!((&device["url"], &device["instructions"], &device["mode"]),
        (&json!("https://example.com/login/device"), &json!("Enter code WXYZ-0001"), &json!("auto")), "a device sign-in is shown");
    let attempt = device["attemptId"].as_str().unwrap().to_owned();
    assert_eq!(lab.ws.opencode_login_oauth_status(ID, "example", &attempt).await.unwrap()["status"], "pending");
    lab.control("oauthComplete", json!({"attemptID": attempt})).await;
    assert_eq!(lab.ws.opencode_login_oauth_status(ID, "example", &attempt).await.unwrap()["status"], "complete");
    assert_eq!(logins().await["credentials"].as_object().unwrap().len(), 1, "logged in by it");

    let refused = start("example/browser").await.map(|shown| shown.to_string()).unwrap_or_else(|e| format!("refused: {e}"));
    assert!(refused.starts_with("refused: ") && refused.contains("请在 OpenCode 里登录") && !refused.contains("auth.example.com"),
        "cancelled, its link never shown: {refused}");
    assert_eq!(logins().await["cancelled"].as_array().unwrap().len(), 1, "its attempt cancelled at OpenCode");
    assert!(journal(&lab).iter().any(|k| k == "opencode/loginNotOffered"));

    let code = start("example/code").await.unwrap();
    assert_eq!(code["mode"], "code");
    lab.ws.opencode_login_oauth_complete(ID, "example", code["attemptId"].as_str().unwrap(), "CODE-42").await.unwrap();
    assert_eq!(logins().await["credentials"].as_object().unwrap().len(), 2, "logged in with its code");
    lab.ws.close_agent(ID).await.unwrap();
}

/// Logging in needs the Agent's OpenCode at 2.0.20 or newer (D4): an older
/// one is told to update, naming both versions, and nothing reaches it. It
/// needs the Agent connected (D9): a closed or disconnected one can't.
#[tokio::test]
async fn a_login_needs_the_agent_connected_and_its_opencode_at_2_0_20() {
    let lab = lab(&[("version", "2.0.16")], false).await;
    let note = "update OpenCode to log in here: this Agent runs 2.0.16; logging in needs 2.0.20 or newer";
    let view = serde_json::to_value(lab.ws.opencode_logins(ID).await.unwrap()).unwrap();
    assert_eq!((&view["state"], &view["reason"]), (&json!("update"), &json!(note)), "told to update, naming both versions");
    let refused = lab.ws.opencode_login_key(ID, key_login("openrouter", "fixture-floor-key", None)).await.map(|_| String::new())
        .unwrap_or_else(|e| e.to_string());
    assert_eq!(refused, note, "a login refused, naming both versions");
    assert!(lab.calls().iter().all(|c| !c["path"].as_str().unwrap().starts_with("/api/integration")), "nothing reached it");
    lab.control("die", json!({})).await;
    lab.until("the lost connection", |d| d.agent.connection_state == "disconnected").await;
    let view = serde_json::to_value(lab.ws.opencode_logins(ID).await.unwrap()).unwrap();
    assert_eq!((&view["state"], &view["reason"]), (&json!("unavailable"), &json!("disconnected")));
    let refused = lab.ws.opencode_login_key(ID, key_login("openrouter", "fixture-floor-key", None)).await.unwrap_err().to_string();
    assert!(refused.contains("连接后才能登录"), "{refused}");
    lab.ws.close_agent(ID).await.unwrap();
    let view = serde_json::to_value(lab.ws.opencode_logins(ID).await.unwrap()).unwrap();
    assert_eq!((&view["state"], &view["reason"]), (&json!("unavailable"), &json!("closed")));
}

/// A deleted OpenCode Agent's database stays with its files, and no login
/// stays in it (D6): scrubbed once its server is stopped, its other rows
/// kept.
#[tokio::test]
async fn an_opencode_agent_deleted_keeps_its_database_with_no_login_in_it() {
    let lab = lab(&[], false).await;
    let db = lab.root().join("opencode.db");
    rusqlite::Connection::open(&db).unwrap().execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT);
        INSERT INTO session VALUES ('ses_kept'); CREATE TABLE credential (id TEXT, value TEXT);
        INSERT INTO credential VALUES ('crd_1', '{\"type\":\"api\",\"key\":\"fixture-deleted-key\"}');").unwrap();
    lab.ws.delete_agent(ID).await.unwrap();
    for name in ["opencode.db", "opencode.db-wal", "opencode.db-shm"] {
        assert!(!holds_bytes(&lab.root().join(name), "fixture-deleted-key"), "no login left after the delete: {name}");
    }
    let kept = rusqlite::Connection::open(&db).unwrap();
    assert_eq!(kept.query_row("SELECT id FROM session", [], |r| r.get::<_, String>(0)).unwrap(), "ses_kept", "its database kept");
}

/// An OpenCode Agent whose database is still in use is not deleted (R1
/// dd77b02d of #621): the delete is refused, to be tried again, and the
/// database is left as it is.
#[tokio::test]
async fn an_opencode_agent_whose_database_is_in_use_is_not_deleted() {
    let lab = lab(&[], false).await;
    let holder = rusqlite::Connection::open(lab.root().join("opencode.db")).unwrap();
    holder.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE credential (id TEXT, value TEXT);
        INSERT INTO credential VALUES ('crd_1', 'fixture-held-key'); BEGIN IMMEDIATE;").unwrap();
    let refused = lab.ws.delete_agent(ID).await.map(|_| String::new()).unwrap_or_else(|e| e.to_string());
    assert!(refused.contains("仍被占用") && refused.contains("稍后再试") && refused.contains("Agent 没有删除"),
        "a database still in use refuses the delete: {refused}");
    assert!(lab.ws.store.agents().unwrap().iter().any(|a| a.id == ID), "still there");
    holder.execute_batch("ROLLBACK").unwrap();
    assert_eq!(holder.query_row("SELECT count(*) FROM credential", [], |r| r.get::<_, i64>(0)).unwrap(), 1, "its database left as it is");
}

/// An OpenCode Agent whose `opencode.db` can't be read as a database is still
/// deleted (R1 dd77b02d of #621): that file and the WAL beside it are
/// overwritten with zeros and removed, and none of their bytes is left in
/// the Agent's folder.
#[tokio::test]
async fn an_opencode_agent_whose_database_is_not_one_is_deleted_with_it_overwritten_and_removed() {
    let lab = lab(&[], false).await;
    let root = lab.root();
    std::fs::write(root.join("opencode.db"), b"not a database: fixture-unread-key").unwrap();
    std::fs::write(root.join("opencode.db-wal"), b"pages of fixture-unread-key").unwrap();
    let deleted = lab.ws.delete_agent(ID).await.map_err(|e| e.to_string());
    assert_eq!(deleted, Ok(()), "a database that is not one never refuses the delete");
    assert!(!lab.ws.store.agents().unwrap().iter().any(|a| a.id == ID), "deleted");
    for name in ["opencode.db", "opencode.db-wal"] {
        assert!(!root.join(name).exists(), "overwritten and removed: {name}");
    }
    assert_eq!(file_holding(&root, "fixture-unread-key"), None, "none of their bytes left in the Agent's folder");
}

/// The login is on Core's own page only: served to it, refused to another
/// site's page (`local_browser_boundary`).
#[tokio::test]
async fn the_login_is_served_to_cores_own_page_only() {
    let lab = lab(&[], false).await;
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4317);
    let request = |origin: &str| Request::builder().method("GET").uri(format!("/api/agents/{ID}/opencode/login"))
        .header("host", "localhost:4317").header("origin", origin).body(Body::empty()).unwrap();
    let own = router.clone().oneshot(request("http://localhost:4317")).await.unwrap();
    assert!(own.status().is_success(), "{}", own.status());
    let other = router.clone().oneshot(request("https://example.com")).await.unwrap();
    assert!(!other.status().is_success(), "another site's page is refused: {}", other.status());
    lab.ws.close_agent(ID).await.unwrap();
}
