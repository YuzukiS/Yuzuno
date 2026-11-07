//! OpenCode commands (T-10, T-61 slice 3) through the Workspace, against the
//! stand-in `opencode serve` (tests/fixtures/opencode_server.py, run by
//! /usr/bin/python3) as OpenCode 2.x: listed from its own list (`GET
//! /api/command`) with nothing of its configuration kept, and a message
//! naming one run as that command (`POST /api/session/:id/command`),
//! recorded before it is sent, its Turn following the message 2.x admits
//! for it under an ID of 2.x's own, and never sent again. No OpenCode,
//! account, model or network service is used.
#![cfg(target_os = "linux")]

#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use axum::{body::{to_bytes, Body}, http::Request};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, OnceLock}, time::Duration};
use tower::ServiceExt;
use yuzuno_workspace::{model::{AgentDetail, MessageInput, MessageReceipt}, server, workspace::Workspace};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");
const ID: &str = "oc";
/// What the stand-in's configuration holds beside its commands' names and
/// descriptions: provider keys, options and headers, and the templates' paths.
const SECRETS: [&str; 4] = ["fixture-secret-key", "fixture-secret-option", "fixture-secret-header", "fixture-template-secret"];

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

fn agent(id: &str, cwd: &str, harness: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":id, "name":"OpenCode", "cwd":cwd, "model":"", "color":"sage", "harness":harness,
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

/// A Workspace with one OpenCode Agent, connected. `collaboration` turns
/// Workspace MCP on first, as a test that serves the HTTP router needs.
async fn lab(collaboration: bool) -> Lab {
    program();
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir_all(dir.path().join("data/opencode").join(ID)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    if collaboration {
        ws.start_collaboration(4999);
    }
    ws.store.insert(&agent(ID, &work.to_string_lossy(), "opencode")).unwrap();
    let d = ws.reconnect(ID).await.unwrap();
    assert_eq!(d.agent.connection_state, "connected");
    Lab { dir, ws }
}

impl Lab {
    fn root(&self) -> PathBuf {
        self.dir.path().join("data/opencode").join(ID)
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root().join("calls.jsonl")).unwrap_or_default()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    /// The requests that sent something: prompts and commands.
    fn sent(&self) -> Vec<Value> {
        self.calls().into_iter().filter(|c| c["method"] == "POST"
            && ["/prompt", "/command"].iter().any(|end| c["path"].as_str().unwrap().ends_with(end))).collect()
    }

    fn detail(&self) -> AgentDetail {
        self.ws.store.detail(ID).unwrap()
    }

    fn session(&self) -> String {
        self.detail().agent.opencode_session_id.unwrap()
    }

    async fn control(&self, name: &str, body: Value) -> Value {
        let seen: Value = serde_json::from_str(&std::fs::read_to_string(self.root().join("start.json")).unwrap()).unwrap();
        let port = seen["port"].as_u64().unwrap();
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

    async fn send(&self, client: &str, text: &str, images: &[String]) -> anyhow::Result<MessageReceipt> {
        let input: MessageInput = serde_json::from_value(json!({"clientMessageId":client,"text":text,"images":images})).unwrap();
        self.ws.send_message(ID, input).await
    }

    /// The Turn's answer, then idle: OpenCode's record ends it.
    async fn complete(&self, turn_id: &str) {
        self.control("reply", json!({"sessionID":self.session(),"text":"Done."})).await;
        self.until("completion", |d| turn(d, turn_id)["status"] == "completed").await;
    }

    /// The data of each journal row of `kind`, oldest first.
    fn journaled(&self, kind: &str) -> Vec<Value> {
        let db = rusqlite::Connection::open(self.dir.path().join("data/workspace.sqlite")).unwrap();
        let mut query = db.prepare("SELECT data FROM journal WHERE agent_id=?1 AND kind=?2 ORDER BY seq").unwrap();
        query.query_map([ID, kind], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap)
            .map(|data| serde_json::from_str(&data).unwrap()).collect()
    }

    /// The command requests the stand-in received, in order: `{sessionID, name, text, keys}`.
    async fn commands(&self) -> Vec<Value> {
        self.control("commands", json!({})).await["seen"].as_array().unwrap().clone()
    }

    /// The stand-in's sessions, as it keeps them.
    fn sessions(&self) -> Value {
        let state: Value = serde_json::from_str(&std::fs::read_to_string(self.root().join("state.json")).unwrap()).unwrap();
        state["sessions"].clone()
    }

    fn kinds(&self) -> Vec<String> {
        let db = rusqlite::Connection::open(self.dir.path().join("data/workspace.sqlite")).unwrap();
        let mut query = db.prepare("SELECT kind FROM journal WHERE agent_id=?1 ORDER BY seq").unwrap();
        query.query_map([ID], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
    }
}

fn turn<'a>(d: &'a AgentDetail, id: &str) -> &'a Value {
    d.turns.iter().find(|t| t["id"] == id).unwrap_or_else(|| panic!("no turn {id}: {:#?}", d.turns))
}

/// Every file under `dir`, read whole, for anything of `/config` that is
/// neither a command's name nor its description.
fn holds_a_secret(dir: &std::path::Path) -> Option<(PathBuf, &'static str)> {
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

fn reason(view: impl serde::Serialize) -> Value {
    let view = serde_json::to_value(view).unwrap();
    json!([view["state"], view["reason"]])
}

async fn get(router: &axum::Router, uri: &str) -> (u16, Value) {
    let request = Request::builder().uri(uri).header("host", "localhost:4999").header("x-yuzuno-client", "desktop")
        .body(Body::empty()).unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let body = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// The route lists the commands OpenCode 2.x offers (`GET /api/command`,
/// T-61 slice 3) in the slash menu's shape: by name, with a single-line
/// description, and nothing 2.x does not list of one. Nothing of OpenCode's
/// configuration (provider keys, options, templates, a command's model or
/// agent) is returned or kept anywhere in Core's data, after a command has
/// run too, and 1.19.3's `/config` is never read. An Agent with no OpenCode
/// running, a closed one, or a list OpenCode does not answer lists nothing,
/// and says why.
#[tokio::test]
async fn commands_are_listed_from_2xs_own_list_and_nothing_of_opencodes_configuration_is_kept() {
    let lab = lab(true).await;
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4999);
    let (status, view) = get(&router, &format!("/api/agents/{ID}/opencode/commands")).await;
    assert_eq!(status, 200, "{view}");
    let observed = view["observedAt"].clone();
    assert!(chrono::DateTime::parse_from_rfc3339(observed.as_str().unwrap()).is_ok(), "{observed}");
    let command = |name: &str, description: &str| json!({"name":name,"description":description,"argumentHint":"<arguments>",
        "aliases":[],"source":"custom"});
    assert_eq!(view, json!({"state":"ready","reason":"listed","source":"session","sessionId":lab.session(),"observedAt":observed,
        "commands":[
            command("delegate", "Ask a sub-agent"),
            command("explain", "Explain one thing"),
            command("pinned", "Uses its own model"),
            command("review", "Review a change"),
            command("status", ""),
        ],"total":5,"truncated":false,"skillsKnown":true}));
    let listed = view.to_string();
    for kept in ["fixture-secret", "fixture-template", "template", "Investigate", "deepseek", "openrouter", "reviewer"] {
        assert!(!listed.contains(kept), "{kept} in {listed}");
    }

    // One run, its answer, and then nothing of the configuration is anywhere in Core's data.
    let ran = lab.send("c1", "/explain closures", &[]).await.unwrap().turn_id.unwrap();
    lab.complete(&ran).await;
    let record = serde_json::to_string(&lab.detail()).unwrap();
    assert!(!record.contains("fixture-secret") && !record.contains("fixture-template"), "{record}");
    assert_eq!(holds_a_secret(&lab.dir.path().join("data")), None);

    // A list OpenCode does not answer: failed, with no native text.
    lab.control("mode", json!({"fail":{"/api/command":500}})).await;
    let (_, failed) = get(&router, &format!("/api/agents/{ID}/opencode/commands")).await;
    assert_eq!(failed, json!({"state":"failed","reason":"read_failed","source":null,"sessionId":null,"observedAt":null,
        "commands":[],"total":0,"truncated":false,"skillsKnown":false}));
    lab.control("mode", json!({"fail":{}})).await;

    // Another harness gets no OpenCode list.
    lab.ws.store.insert(&agent("codex1", &lab.dir.path().to_string_lossy(), "codex")).unwrap();
    let (status, _) = get(&router, "/api/agents/codex1/opencode/commands").await;
    assert!(status >= 400, "{status}");

    // Closed: unavailable, and nothing read.
    lab.ws.close_agent(ID).await.unwrap();
    let reads = || lab.calls().iter().filter(|c| c["path"] == "/api/command").count();
    let before = reads();
    assert_eq!(reason(lab.ws.opencode_commands(ID).await.unwrap()), json!(["unavailable", "closed"]));
    assert_eq!(reads(), before);
    assert_eq!(lab.calls().iter().filter(|c| c["path"] == "/config").count(), 0, "1.19.3's /config is never read");

    // No OpenCode running for it: unavailable, and none is started to list.
    let ws = Workspace::new(lab.dir.path().join("data2"), lab.dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(ID, &lab.dir.path().to_string_lossy(), "opencode")).unwrap();
    assert_eq!(reason(ws.opencode_commands(ID).await.unwrap()), json!(["unavailable", "disconnected"]));
    assert!(!lab.dir.path().join("data2/opencode").join(ID).join("start.json").exists(), "no OpenCode was started");
}

/// `/<name> [arguments]` for a command OpenCode lists runs through 2.x's
/// route (T-61 slice 3, D-13 (a)): recorded before the request, the Agent's
/// model made the session's first, as for a message, sent as its name and
/// text only, and once. Its Turn follows the message 2.x admitted for it
/// under an ID of 2.x's own: delivered then, and answered and ended by what
/// answers that message. Any other text, an unlisted name included, is a
/// prompt.
#[tokio::test]
async fn a_listed_command_runs_through_2xs_route_and_its_turn_follows_the_message_2x_admitted() {
    let lab = lab(false).await;
    let session = lab.session();
    lab.ws.opencode_set_choice(ID, "deepseek/deepseek-flash".into(), Some(Some("max".into()))).await.unwrap();

    let receipt = lab.send("c1", "/explain closures", &[]).await.unwrap();
    assert_eq!(receipt.status, "accepted", "{receipt:?}");
    let first = receipt.turn_id.unwrap();
    let sent = lab.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["path"], format!("/api/session/{session}/command"));
    assert_eq!(sent[0]["body"], json!({"name":"explain","text":"closures"}), "2.x's command takes its name and text only");
    let calls = lab.calls();
    let model = format!("/api/session/{session}/model");
    let switched = calls.iter().position(|c| c["method"] == "POST" && c["path"] == model.as_str()).expect("the Agent's model made the session's");
    let commanded = calls.iter().position(|c| c["path"] == sent[0]["path"]).unwrap();
    assert!(switched < commanded, "the model first, as for a message");
    assert_eq!(calls[switched]["body"], json!({"model":{"id":"deepseek-flash","providerID":"deepseek","variant":"max"}}));
    let kinds = lab.kinds();
    let requested = kinds.iter().position(|k| k == "opencode/turnRequested").unwrap();
    let admitted = kinds.iter().position(|k| k == "opencode/session.inbox.enqueued").unwrap();
    assert!(requested < admitted, "recorded before it was sent: {kinds:?}");
    let recorded = &lab.journaled("opencode/turnRequested")[0];
    assert_eq!((&recorded["command"], &recorded["arguments"], &recorded["model"], &recorded["variant"]),
        (&json!("explain"), &json!("closures"), &json!("deepseek/deepseek-flash"), &json!("max")));
    assert!(recorded.get("commandModel").is_none(), "2.x lists no command's model: {recorded}");
    let d = lab.detail();
    let ran = turn(&d, &first);
    let native = ran["_opencodeCommand"]["native"].as_str().unwrap_or_else(|| panic!("followed: {ran:#}")).to_owned();
    assert!(native.as_str() > first.as_str(), "2.x's own ID, admitted after the Turn's: {native}");
    assert_eq!((&ran["_opencodeCommand"]["awaiting"], &ran["_opencodeConfirmed"], &ran["status"]), (&json!(false), &json!(true), &json!("inProgress")));
    assert_eq!(ran["items"][0]["content"], json!([{"type":"text","text":"/explain closures"}]),
        "the conversation shows what was sent, not the template");
    lab.complete(&first).await;
    let d = lab.detail();
    let ended = turn(&d, &first);
    assert!(ended["_opencodeAnswers"].as_object().is_some_and(|a| !a.is_empty() && a.values().all(|a| a["parent"] == native.as_str())),
        "answered by what answers 2.x's message: {ended:#}");
    assert!(ended["items"].as_array().unwrap().iter().any(|i| i["type"] == "agentMessage" && i["text"] == "Done."), "{ended:#}");

    // The same message again: its receipt, and nothing sent again.
    let again = lab.send("c1", "/explain closures", &[]).await.unwrap();
    assert_eq!((again.status.as_str(), again.turn_id.as_deref()), ("accepted", Some(first.as_str())));
    assert_eq!(lab.sent().len(), 1, "sent once");

    // Anything else is a prompt: an unlisted name, a "/" alone, text before a name.
    for (client, text) in [("c4", "/nope x"), ("c5", "/"), ("c6", "see /explain")] {
        let id = lab.send(client, text, &[]).await.unwrap().turn_id.unwrap();
        let sent = lab.sent().pop().unwrap();
        assert!(sent["path"].as_str().unwrap().ends_with("/prompt"), "{text}: {sent}");
        assert_eq!(sent["body"]["text"], text);
        assert_eq!(lab.journaled("opencode/turnRequested").pop().unwrap()["command"], Value::Null);
        lab.complete(&id).await;
    }
    assert_eq!(lab.commands().await.len(), 1, "one command reached 2.x's route");
    lab.ws.close_agent(ID).await.unwrap();
}

/// What 2.x refused or failed is refused with 2.x's own words, once a whole
/// read finds nothing of it admitted (T-61 slice 3): a refusal before it
/// runs, or a 500 of what it does. Its Turn, recorded before the request,
/// failed; its receipt rejected; never sent again. A command with no answer
/// is unknown, and its Turn follows what 2.x admits for it later. A list
/// OpenCode does not answer refuses `/<name>` rather than sending it as text,
/// and `/goal` and `/schedule`, which start work of their own later, are
/// refused before anything is recorded (D-16 (a)).
#[tokio::test]
async fn a_command_2x_refuses_is_refused_before_anything_runs_and_never_sent_again() {
    let lab = lab(false).await;
    let session = lab.session();
    let path = format!("/api/session/{session}/command");

    // Refused before it runs.
    lab.control("mode", json!({"fail":{path.clone():404}})).await;
    let refused = lab.send("c1", "/explain x", &[]).await.unwrap();
    assert_eq!(refused.status, "rejected");
    assert!(refused.error.as_deref().unwrap().contains("OpenCode 没有执行 /explain（HTTP 404）：fixture failure"), "{refused:?}");
    let d = lab.detail();
    assert_eq!(turn(&d, refused.turn_id.as_deref().unwrap())["status"], "failed", "its Turn, recorded before the request, failed");
    assert_eq!(d.agent.status, "idle");
    lab.control("mode", json!({"fail":{}})).await;

    // What it does failed, with nothing admitted: refused, in 2.x's words.
    lab.control("mode", json!({"command":"fail"})).await;
    let failed = lab.send("c2", "/explain y", &[]).await.unwrap();
    assert_eq!(failed.status, "rejected", "{failed:?}");
    assert!(failed.error.as_deref().unwrap().contains("（HTTP 500）：fixture: the command failed"), "{failed:?}");
    assert_eq!(turn(&lab.detail(), failed.turn_id.as_deref().unwrap())["status"], "failed");
    assert_eq!(lab.journaled("opencode/promptRefused").len(), 2);

    // No answer and nothing admitted: unknown, and sent once. An idle
    // OpenCode alone decides nothing for it.
    lab.control("mode", json!({"command":"drop"})).await;
    let unknown = lab.send("c3", "/explain z", &[]).await.unwrap();
    assert_eq!(unknown.status, "uncertain", "{unknown:?}");
    let dropped = unknown.turn_id.clone().unwrap();
    assert_eq!(lab.journaled("opencode/deliveryUnconfirmed").len(), 1);
    let again = lab.send("c3", "/explain z", &[]).await.unwrap();
    assert_eq!(again.status, "uncertain");
    assert_eq!(lab.sent().len(), 3, "each was sent once");
    lab.control("idle", json!({"sessionID":session})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(turn(&lab.detail(), &dropped)["status"], "inProgress");

    // 2.x admits it after all, under its own ID: the Turn follows that
    // message, its receipt accepted under its client ID, its answer ends it.
    let late = yuzuno_workspace::opencode::MessageId::new();
    lab.control("store", json!({"sessionID":session,"messageID":late.as_str(),"text":"Explain z briefly."})).await;
    lab.until("the late confirmation", |d| d.message_receipts.iter().any(|r| r.input.client_message_id == "c3" && r.status == "accepted")).await;
    assert_eq!(turn(&lab.detail(), &dropped)["_opencodeCommand"]["native"], late.as_str());
    lab.control("mode", json!({"command":"run"})).await;
    lab.complete(&dropped).await;
    assert_eq!(lab.sent().len(), 3, "still sent once");

    // A list OpenCode does not answer: nothing is sent, not even as text.
    lab.control("mode", json!({"fail":{"/api/command":500}})).await;
    let unread = lab.send("c4", "/explain w", &[]).await.unwrap();
    assert_eq!(unread.status, "rejected");
    assert!(unread.error.as_deref().unwrap().contains("没有读到 OpenCode 的命令"), "{unread:?}");
    assert_eq!(lab.sent().len(), 3, "nothing more was sent");
    lab.control("mode", json!({"fail":{}})).await;

    // `/goal` and `/schedule`, offered by this OpenCode: refused before a receipt or Turn, nothing sent.
    let mut config = lab.control("mode", json!({})).await["config"].clone();
    config["command"]["goal"] = json!({"template":"$ARGUMENTS","description":"Work towards a goal"});
    config["command"]["schedule"] = json!({"template":"$ARGUMENTS"});
    lab.control("mode", json!({"config":config})).await;
    let (turns, receipts) = (lab.detail().turns.len(), lab.detail().message_receipts.len());
    for (client, text) in [("c5", "/goal ship it"), ("c6", "/schedule daily")] {
        let refused = lab.send(client, text, &[]).await.unwrap_err().to_string();
        assert!(refused.contains("会在之后自行开始新的工作") && refused.contains("草稿保留"), "{text}: {refused}");
    }
    assert_eq!((lab.detail().turns.len(), lab.detail().message_receipts.len()), (turns, receipts), "no Turn or receipt was recorded");
    assert_eq!(lab.sent().len(), 3, "nothing more was sent");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A command can admit its message before what it does fails (a plugin's):
/// 2.x then answers 500 with the run going on. The Turn follows that message,
/// and the run's own end decides it; nothing is refused (T-61 slice 3).
#[tokio::test]
async fn a_command_that_fails_after_2x_admitted_its_message_is_followed_not_refused() {
    let lab = lab(false).await;
    let session = lab.session();
    lab.control("mode", json!({"command":"fail-after"})).await;
    let receipt = lab.send("c1", "/explain x", &[]).await.unwrap();
    assert_eq!(receipt.status, "accepted", "{receipt:?}");
    let ran = receipt.turn_id.unwrap();
    let d = lab.detail();
    assert!(turn(&d, &ran)["_opencodeCommand"]["native"].is_string(), "followed: {:#}", turn(&d, &ran));
    assert_eq!(turn(&d, &ran)["status"], "inProgress", "its run's end is 2.x's to tell");
    assert!(lab.journaled("opencode/promptRefused").is_empty(), "nothing was refused");
    lab.control("mode", json!({"command":"run"})).await;
    lab.control("reply", json!({"sessionID":session,"text":"Done."})).await;
    lab.until("completion", |d| turn(d, &ran)["status"] == "completed").await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// A command that names a model of its own makes it the session's, as 2.x
/// does, and it stays so after the command (T-61 slice 3, D-17 (a)): the
/// next message makes the Agent's chosen model the session's again first.
#[tokio::test]
async fn a_command_with_its_own_model_keeps_it_and_the_next_message_switches_back() {
    let lab = lab(false).await;
    let session = lab.session();
    lab.ws.opencode_set_choice(ID, "deepseek/deepseek-flash".into(), Some(None)).await.unwrap();
    let pinned = lab.send("c1", "/pinned", &[]).await.unwrap().turn_id.unwrap();
    assert_eq!(lab.sent().pop().unwrap()["body"], json!({"name":"pinned","text":""}));
    lab.complete(&pinned).await;
    assert_eq!((&lab.sessions()[&session]["model"]["providerID"], &lab.sessions()[&session]["model"]["id"]),
        (&json!("openrouter"), &json!("anthropic/claude-x")), "the command's own model stays the session's");

    let model = format!("/api/session/{session}/model");
    let switches = || lab.calls().into_iter().filter(|c| c["method"] == "POST" && c["path"] == model.as_str()).collect::<Vec<_>>();
    let before = switches().len();
    let next = lab.send("c2", "and now?", &[]).await.unwrap().turn_id.unwrap();
    let after = switches();
    assert_eq!(after.len(), before + 1, "switched back before the next message");
    assert_eq!(after.last().unwrap()["body"], json!({"model":{"id":"deepseek-flash","providerID":"deepseek"}}));
    let calls = lab.calls();
    let switched = calls.iter().rposition(|c| c["method"] == "POST" && c["path"] == model.as_str()).unwrap();
    let prompted = calls.iter().rposition(|c| c["path"].as_str().unwrap().ends_with("/prompt")).unwrap();
    assert!(switched < prompted, "the switch first");
    lab.complete(&next).await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// A command 2.x ran that admitted nothing and left the session idle (as
/// `/goal pause` does) ends its Turn as completed, saying so, once
/// CONFIRM_LIMIT and a whole read find nothing of it (T-61 slice 3, D-14
/// (a)). The Agent is idle; the next message goes.
#[tokio::test]
async fn a_command_that_starts_nothing_ends_its_turn_saying_so() {
    let lab = lab(false).await;
    lab.control("mode", json!({"command":"nothing"})).await;
    let receipt = lab.send("c1", "/explain x", &[]).await.unwrap();
    assert_eq!(receipt.status, "accepted", "{receipt:?}");
    let ran = receipt.turn_id.unwrap();
    let d = lab.detail();
    assert_eq!(turn(&d, &ran)["status"], "completed");
    assert_eq!(turn(&d, &ran)["notice"], json!({"kind":"command_no_turn","detail":"explain"}), "a notice the web words");
    assert_eq!(turn(&d, &ran)["error"], Value::Null, "nothing failed");
    assert_eq!(d.agent.status, "idle");
    assert_eq!(lab.journaled("opencode/commandRanNothing").len(), 1);
    lab.control("mode", json!({"command":"run"})).await;
    let next = lab.send("c2", "/explain y", &[]).await.unwrap().turn_id.unwrap();
    lab.complete(&next).await;
    assert_eq!(lab.sent().len(), 2, "each sent once");
    lab.ws.close_agent(ID).await.unwrap();
}

/// A sub-agent's command admits nothing in the Agent's session: 2.x makes a
/// session for it and runs it there in the background (T-61 slice 3, D-15
/// (a)). Its Turn ends at 2.x's answer, completed, saying so; its sub-agent's
/// permission requests still come to this Agent, and are answered in that
/// sub-agent's session.
#[tokio::test]
async fn a_sub_agent_command_ends_its_turn_at_once_and_its_requests_still_come_to_the_agent() {
    let lab = lab(false).await;
    let session = lab.session();
    let receipt = lab.send("c1", "/delegate the  failing test ", &[]).await.unwrap();
    assert_eq!(receipt.status, "accepted", "{receipt:?}");
    let ran = receipt.turn_id.unwrap();
    assert_eq!(lab.sent().pop().unwrap()["body"], json!({"name":"delegate","text":"the  failing test"}));
    let d = lab.detail();
    assert_eq!(turn(&d, &ran)["status"], "completed");
    assert_eq!(turn(&d, &ran)["notice"], json!({"kind":"command_subagent","detail":"reviewer"}), "named by its sub-agent: {:#}", turn(&d, &ran));
    assert_eq!(turn(&d, &ran)["error"], Value::Null, "nothing failed");
    assert_eq!(lab.journaled("opencode/commandInBackground").len(), 1);
    assert_eq!(d.agent.status, "idle");

    let child = lab.sessions().as_object().unwrap().values().find(|s| s["parentID"] == session.as_str())
        .expect("the sub-agent's session")["id"].as_str().unwrap().to_owned();
    let asked = lab.control("ask", json!({"sessionID":child})).await;
    let d = lab.until("the sub-agent's request", |d| !d.pending.is_empty()).await;
    let p = d.pending[0].clone();
    assert_eq!((p.method.as_str(), &p.params["id"]), ("opencode/permission", &asked["id"]));
    assert_eq!(p.params["_opencodeSession"], child);
    lab.ws.respond(&p.id, json!({"decision":"once"})).await.unwrap();
    let reply = format!("/api/session/{child}/permission/{}/reply", asked["id"].as_str().unwrap());
    assert_eq!(lab.calls().into_iter().filter(|c| c["path"] == reply.as_str()).count(), 1, "answered once, in the sub-agent's session");
    lab.until("the answered request", |d| d.pending.is_empty()).await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// What 2.x hands the session from a sub-agent later (a synthetic
/// `<subagent>` message, D-15 (a)) is never a command's input, even while a
/// command Turn still waits for what 2.x admitted for it: the message 2.x
/// admits for the command is (T-61 slice 3).
#[tokio::test]
async fn a_sub_agents_result_is_never_taken_as_a_commands_input() {
    let lab = lab(false).await;
    let session = lab.session();
    lab.control("mode", json!({"command":"drop"})).await;
    let waiting = lab.send("c1", "/explain x", &[]).await.unwrap();
    assert_eq!(waiting.status, "uncertain", "{waiting:?}");
    let ran = waiting.turn_id.unwrap();
    // A sub-agent's result, admitted and delivered by 2.x as 2.2.5 sends it (probe p1 fecf3048), then the command's own message.
    let result = yuzuno_workspace::opencode::MessageId::new();
    let now = chrono::Utc::now().timestamp_millis();
    lab.control("event", json!({"type":"session.inbox.enqueued","created":now,"properties":{"sessionID":session,"inboxID":result.as_str(),
        "item":{"type":"synthetic","delivery":"steer","payload":{"text":"<subagent state=\"completed\">Seen.</subagent>",
        "metadata":{"source":"subagent","state":"completed"}}}}})).await;
    lab.control("event", json!({"type":"session.inbox.delivered","created":now + 1,"properties":{"sessionID":session,"inboxID":result.as_str()}})).await;
    let own = yuzuno_workspace::opencode::MessageId::new();
    lab.control("store", json!({"sessionID":session,"messageID":own.as_str(),"text":"Explain x briefly."})).await;
    lab.until("the command's message", |d| d.message_receipts.iter().any(|r| r.input.client_message_id == "c1" && r.status == "accepted")).await;
    assert_eq!(turn(&lab.detail(), &ran)["_opencodeCommand"]["native"], own.as_str(), "the command's own message, not the sub-agent's result");
    lab.control("mode", json!({"command":"run"})).await;
    lab.complete(&ran).await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// A delivery whose admission this connection never saw is not taken as a
/// command's input: what 2.x queued there is not known from it (T-61 slice
/// 3). The message 2.x then admits for the command, seen, is.
#[tokio::test]
async fn a_delivery_whose_admission_was_not_seen_is_not_taken_as_a_commands_input() {
    let lab = lab(false).await;
    let session = lab.session();
    lab.control("mode", json!({"command":"drop"})).await;
    let waiting = lab.send("c1", "/explain x", &[]).await.unwrap();
    assert_eq!(waiting.status, "uncertain", "{waiting:?}");
    let ran = waiting.turn_id.unwrap();
    let unseen = yuzuno_workspace::opencode::MessageId::new();
    lab.control("event", json!({"type":"session.inbox.delivered","created":chrono::Utc::now().timestamp_millis(),
        "properties":{"sessionID":session,"inboxID":unseen.as_str()}})).await;
    let own = yuzuno_workspace::opencode::MessageId::new();
    lab.control("store", json!({"sessionID":session,"messageID":own.as_str(),"text":"Explain x briefly."})).await;
    lab.until("the command's message", |d| d.message_receipts.iter().any(|r| r.input.client_message_id == "c1" && r.status == "accepted")).await;
    assert_eq!(turn(&lab.detail(), &ran)["_opencodeCommand"]["native"], own.as_str(), "the message seen admitted, not the unseen delivery");
    lab.control("mode", json!({"command":"run"})).await;
    lab.complete(&ran).await;
    lab.ws.close_agent(ID).await.unwrap();
}

fn png() -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(4, 4, image::Rgb([10, 0, 0])).write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

/// A command takes no images: `/<name>` with images is refused before its
/// receipt is recorded and nothing is sent, so the composer keeps the draft
/// and its images. The same images with text that names no command go as a
/// prompt does.
#[tokio::test]
async fn a_command_with_images_is_refused_before_anything_is_recorded() {
    let lab = lab(true).await;
    let session = lab.session();
    let mut providers = lab.control("mode", json!({})).await["providers"].clone();
    for provider in providers["providers"].as_array_mut().unwrap().iter_mut().filter(|p| p["id"] == "deepseek") {
        provider["models"]["deepseek-flash"]["capabilities"] = json!({"input":{"text":true,"image":true}});
    }
    lab.control("mode", json!({"providers":providers})).await;
    lab.ws.opencode_set_model(ID, "deepseek/deepseek-flash".into()).await.unwrap();
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4999);
    let request = Request::builder().method("POST").uri(format!("/api/agents/{ID}/images"))
        .header("host", "localhost:4999").header("x-yuzuno-client", "desktop").body(Body::from(png())).unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), 200);
    let image: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let images = vec![image["id"].as_str().unwrap().to_owned()];

    let refused = lab.send("c1", "/review this", &images).await.unwrap_err().to_string();
    assert!(refused.contains("OpenCode 命令不能附带图片") && refused.contains("草稿保留"), "{refused}");
    assert!(lab.sent().is_empty(), "nothing was sent");
    assert!(lab.detail().message_receipts.is_empty(), "no receipt was recorded");
    assert!(lab.detail().turns.is_empty(), "no Turn was recorded");

    let id = lab.send("c2", "review this", &images).await.unwrap().turn_id.unwrap();
    let sent = lab.sent();
    assert_eq!(sent.len(), 1);
    assert!(sent[0]["path"].as_str().unwrap().ends_with("/prompt"));
    lab.control("reply", json!({"sessionID":session,"text":"Seen."})).await;
    lab.until("completion", |d| turn(d, &id)["status"] == "completed").await;
    lab.ws.close_agent(ID).await.unwrap();
}

/// A 500 refuses a command only once a whole read of the session finds
/// nothing of it admitted (T-61 slice 3). With that read failing, what
/// became of it is unknown: its Turn is not failed, nothing is sent again,
/// and its Turn follows what 2.x admitted once that shows.
#[tokio::test]
async fn a_failed_command_whose_session_cannot_be_read_is_unknown_not_refused() {
    let lab = lab(false).await;
    let session = lab.session();
    lab.control("mode", json!({"command":"fail","fail":{format!("/api/session/{session}/inbox"):500}})).await;
    let unknown = lab.send("c1", "/explain y", &[]).await.unwrap();
    assert_eq!(unknown.status, "uncertain", "{unknown:?}");
    let ran = unknown.turn_id.clone().unwrap();
    assert_eq!(turn(&lab.detail(), &ran)["status"], "inProgress", "not failed: it may have run");
    assert!(lab.journaled("opencode/promptRefused").is_empty(), "nothing was recorded as refused");
    assert_eq!(lab.sent().len(), 1, "sent once");

    lab.control("mode", json!({"command":"run","fail":{}})).await;
    let late = yuzuno_workspace::opencode::MessageId::new();
    lab.control("store", json!({"sessionID":session,"messageID":late.as_str(),"text":"Explain y briefly."})).await;
    lab.until("the late confirmation", |d| d.message_receipts.iter().any(|r| r.input.client_message_id == "c1" && r.status == "accepted")).await;
    lab.complete(&ran).await;
    assert_eq!(lab.sent().len(), 1, "still sent once");
    lab.ws.close_agent(ID).await.unwrap();
}
