//! OpenCode commands (T-10) through the Workspace, against the stand-in
//! `opencode serve` (tests/fixtures/opencode_server.py, run by
//! /usr/bin/python3): listed from OpenCode's configuration (`GET /config`)
//! with nothing else of it kept, and a message naming one run as that
//! command (`POST /session/:id/command`), recorded and confirmed by its
//! message ID as a prompt is, and never sent again. No OpenCode, account,
//! model or network service is used.
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
/// What the stand-in's `/config` holds beside its commands' names and
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
            && ["/prompt_async", "/command"].iter().any(|end| c["path"].as_str().unwrap().ends_with(end))).collect()
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

/// The route lists OpenCode's configured commands in the slash menu's shape,
/// by name, with a single-line description, whether one takes arguments
/// and whether it runs as a sub-agent. Nothing else of `/config` (provider
/// keys, options, templates, a command's model or agent) is returned or kept
/// anywhere in Core's data, after a command has run too. An Agent with no
/// OpenCode running, a closed one, or a `/config` OpenCode does not answer
/// lists nothing, and says why.
#[tokio::test]
async fn commands_are_listed_from_opencodes_configuration_and_nothing_else_of_it_is_kept() {
    let lab = lab(true).await;
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4999);
    let (status, view) = get(&router, &format!("/api/agents/{ID}/opencode/commands")).await;
    assert_eq!(status, 200, "{view}");
    let observed = view["observedAt"].clone();
    assert!(chrono::DateTime::parse_from_rfc3339(observed.as_str().unwrap()).is_ok(), "{observed}");
    let command = |name: &str, description: &str, arguments: bool, subtask: bool| json!({"name":name,"description":description,
        "argumentHint":if arguments { "<arguments>" } else { "" },"aliases":[],"source":"custom","subtask":subtask});
    assert_eq!(view, json!({"state":"ready","reason":"listed","source":"session","sessionId":lab.session(),"observedAt":observed,
        "commands":[
            command("delegate", "Ask a sub-agent", true, true),
            command("explain", "Explain one thing", true, false),
            command("pinned", "Uses its own model", false, false),
            command("review", "Review a change", true, false),
            command("status", "", false, false),
        ],"total":5,"truncated":false,"skillsKnown":true}));
    let listed = view.to_string();
    for kept in ["fixture-secret", "fixture-template", "template", "Investigate", "deepseek", "openrouter", "reviewer"] {
        assert!(!listed.contains(kept), "{kept} in {listed}");
    }

    // One run, its answer, and then nothing of /config is anywhere in Core's data.
    let ran = lab.send("c1", "/explain closures", &[]).await.unwrap().turn_id.unwrap();
    lab.complete(&ran).await;
    let record = serde_json::to_string(&lab.detail()).unwrap();
    assert!(!record.contains("fixture-secret") && !record.contains("fixture-template"), "{record}");
    assert_eq!(holds_a_secret(&lab.dir.path().join("data")), None);

    // A /config OpenCode does not answer: failed, with no native text.
    lab.control("mode", json!({"fail":{"/config":500}})).await;
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
    let reads = lab.calls().iter().filter(|c| c["path"] == "/config").count();
    assert_eq!(reason(lab.ws.opencode_commands(ID).await.unwrap()), json!(["unavailable", "closed"]));
    assert_eq!(lab.calls().iter().filter(|c| c["path"] == "/config").count(), reads);

    // No OpenCode running for it: unavailable, and none is started to list.
    let ws = Workspace::new(lab.dir.path().join("data2"), lab.dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(ID, &lab.dir.path().to_string_lossy(), "opencode")).unwrap();
    assert_eq!(reason(ws.opencode_commands(ID).await.unwrap()), json!(["unavailable", "disconnected"]));
    assert!(!lab.dir.path().join("data2/opencode").join(ID).join("start.json").exists(), "no OpenCode was started");
}

/// `/<name> [arguments]` for a command OpenCode lists runs as that command:
/// recorded under its message ID before the request, confirmed by the
/// message OpenCode stored under it, ended by OpenCode's record, and sent
/// once. The Agent's model and variant go with a command that names no model
/// of its own, by its own `model` or its agent's, and the record says which
/// it named. A sub-agent command's requests come through its child session.
/// Any other text, an unlisted name included, is a prompt.
#[tokio::test]
async fn a_listed_command_runs_under_its_kept_id_with_the_model_opencode_gives_it() {
    let lab = lab(false).await;
    let session = lab.session();
    lab.ws.opencode_set_choice(ID, "deepseek/deepseek-flash".into(), Some(Some("max".into()))).await.unwrap();

    let receipt = lab.send("c1", "/explain closures", &[]).await.unwrap();
    assert_eq!(receipt.status, "accepted");
    let first = receipt.turn_id.unwrap();
    let sent = lab.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["path"], format!("/session/{session}/command"));
    assert_eq!(sent[0]["body"], json!({"messageID":first,"command":"explain","arguments":"closures",
        "model":"deepseek/deepseek-flash","variant":"max"}), "the Agent's model and variant go with a command naming none");
    let kinds = lab.kinds();
    let requested = kinds.iter().position(|k| k == "opencode/turnRequested").unwrap();
    let confirmed = kinds.iter().position(|k| k == "opencode/messageConfirmed").unwrap();
    assert!(requested < confirmed, "the ID was recorded before it was sent: {kinds:?}");
    let recorded = &lab.journaled("opencode/turnRequested")[0];
    assert_eq!((&recorded["command"], &recorded["arguments"], &recorded["commandModel"], &recorded["model"], &recorded["variant"]),
        (&json!("explain"), &json!("closures"), &Value::Null, &json!("deepseek/deepseek-flash"), &json!("max")));
    let d = lab.until("the run", |d| d.agent.status == "working").await;
    assert_eq!(turn(&d, &first)["status"], "inProgress", "the request is still open: its run goes on");
    assert_eq!(turn(&d, &first)["items"][0]["content"], json!([{"type":"text","text":"/explain closures"}]),
        "the conversation shows what was sent, not the template");
    lab.complete(&first).await;

    // The same message again: its receipt, and nothing sent again.
    let again = lab.send("c1", "/explain closures", &[]).await.unwrap();
    assert_eq!((again.status.as_str(), again.turn_id.as_deref()), ("accepted", Some(first.as_str())));
    assert_eq!(lab.sent().len(), 1, "sent once");

    // Its own model, then its agent's: OpenCode runs with that one, and the
    // Agent's model and variant are not sent with it.
    for (client, text, command, arguments, own) in [
        ("c2", "/pinned", "pinned", "", "openrouter/anthropic/claude-x"),
        ("c3", "/delegate the  failing test ", "delegate", "the  failing test", "deepseek/deepseek-flash"),
    ] {
        let id = lab.send(client, text, &[]).await.unwrap().turn_id.unwrap();
        let sent = lab.sent().pop().unwrap();
        assert_eq!(sent["body"], json!({"messageID":id,"command":command,"arguments":arguments}), "{text}");
        assert_eq!(lab.journaled("opencode/turnRequested").pop().unwrap()["commandModel"], own, "{text}");
        if command == "delegate" {
            // Its sub-agent asks through the child session OpenCode started
            // for it, and is answered there.
            let state: Value = serde_json::from_str(&std::fs::read_to_string(lab.root().join("state.json")).unwrap()).unwrap();
            let child = state["sessions"].as_object().unwrap().values().find(|s| s["parentID"] == session.as_str())
                .expect("the sub-agent's session")["id"].as_str().unwrap().to_owned();
            let asked = lab.control("ask", json!({"sessionID":child})).await;
            let d = lab.until("the sub-agent's request", |d| !d.pending.is_empty()).await;
            let p = d.pending[0].clone();
            assert_eq!((p.method.as_str(), &p.params["id"], &p.params["turnId"]), ("opencode/permission", &asked["id"], &json!(id)));
            assert_eq!(p.params["_opencodeSession"], child);
            assert_eq!(p.params["_opencodeChild"], json!({"title":"Ask a sub-agent (@reviewer subagent)","agent":"reviewer"}));
            lab.ws.respond(&p.id, json!({"decision":"once"})).await.unwrap();
            let answered = lab.calls().into_iter().filter(|c| c["path"].as_str().unwrap().starts_with("/permission/")).collect::<Vec<_>>();
            assert_eq!(answered.len(), 1);
            lab.until("the answered request", |d| d.pending.is_empty()).await;
        }
        lab.complete(&id).await;
    }

    // Anything else is a prompt: an unlisted name, a "/" alone, text before a name.
    for (client, text) in [("c4", "/nope x"), ("c5", "/"), ("c6", "see /explain")] {
        let id = lab.send(client, text, &[]).await.unwrap().turn_id.unwrap();
        let sent = lab.sent().pop().unwrap();
        assert!(sent["path"].as_str().unwrap().ends_with("/prompt_async"), "{text}: {sent}");
        assert_eq!(sent["body"]["parts"], json!([{"type":"text","text":text}]));
        assert_eq!(lab.journaled("opencode/turnRequested").pop().unwrap()["command"], Value::Null);
        lab.complete(&id).await;
    }
    lab.ws.close_agent(ID).await.unwrap();
}

/// What becomes of a command OpenCode was asked to run, by what it did: a
/// refusal before its message exists is a refused message (its Turn failed,
/// its receipt rejected); a run that failed after OpenCode stored its
/// message is that Turn, ended by OpenCode's record; a request with no
/// answer and no stored message is unknown until OpenCode's record has the
/// message, and is not sent again. A list
/// OpenCode does not answer refuses `/<name>` rather than sending it as text.
#[tokio::test]
async fn a_command_is_refused_only_before_its_message_exists_and_never_sent_again() {
    let lab = lab(false).await;
    let session = lab.session();
    let path = format!("/session/{session}/command");

    // Refused before anything exists.
    lab.control("mode", json!({"fail":{path.clone():400}})).await;
    let refused = lab.send("c1", "/explain x", &[]).await.unwrap();
    assert_eq!(refused.status, "rejected");
    assert!(refused.error.as_deref().unwrap().contains("OpenCode 拒绝了这条消息（HTTP 400）"), "{refused:?}");
    let d = lab.detail();
    assert_eq!(turn(&d, refused.turn_id.as_deref().unwrap())["status"], "failed", "its Turn, recorded before the request, failed");
    assert_eq!(d.agent.status, "idle");
    lab.control("mode", json!({"fail":{}})).await;

    // Stored, then its run failed: OpenCode answers 400 too, and its record ends the Turn.
    lab.control("mode", json!({"command":"fail"})).await;
    let receipt = lab.send("c2", "/explain y", &[]).await.unwrap();
    assert_eq!(receipt.status, "accepted", "{receipt:?}");
    let ran = receipt.turn_id.unwrap();
    assert_eq!(turn(&lab.detail(), &ran)["status"], "inProgress");
    lab.control("halt", json!({"sessionID":session,"name":"APIError","message":"overloaded"})).await;
    lab.until("the failure", |d| turn(d, &ran)["status"] == "failed").await;

    // No answer and nothing stored: unknown, and sent once. An idle
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

    // OpenCode's record has it after all: accepted under its client ID, and its answer ends the Turn.
    lab.control("store", json!({"sessionID":session,"messageID":dropped,"text":"Explain z briefly."})).await;
    lab.until("the late confirmation", |d| d.message_receipts.iter().any(|r| r.input.client_message_id == "c3" && r.status == "accepted")).await;
    lab.control("mode", json!({"command":"run"})).await;
    lab.complete(&dropped).await;
    assert_eq!(lab.sent().len(), 3, "still sent once");

    // A list OpenCode does not answer: nothing is sent, not even as text.
    lab.control("mode", json!({"fail":{"/config":500}})).await;
    let unread = lab.send("c4", "/explain w", &[]).await.unwrap();
    assert_eq!(unread.status, "rejected");
    assert!(unread.error.as_deref().unwrap().contains("没有读到 OpenCode 的命令"), "{unread:?}");
    assert_eq!(lab.sent().len(), 3, "nothing more was sent");
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
    assert!(sent[0]["path"].as_str().unwrap().ends_with("/prompt_async"));
    lab.control("reply", json!({"sessionID":session,"text":"Seen."})).await;
    lab.until("completion", |d| turn(d, &id)["status"] == "completed").await;
    lab.ws.close_agent(ID).await.unwrap();
}
