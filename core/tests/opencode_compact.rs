//! An OpenCode Agent's `/compact` (T-10, T-61 slice 4) through the
//! Workspace, against the stand-in `opencode serve`
//! (tests/fixtures/opencode_server.py, run by /usr/bin/python3) as OpenCode
//! 2.x: 2.x's own compaction (`POST /api/session/:id/compact`), recorded
//! before it is asked for under Core's own ID, which 2.x keeps the
//! compaction's message under; ended by what 2.x says of that message once
//! it is idle again; never sent again. While one goes on or its end is
//! unknown, nothing new is sent. No OpenCode, account, model or network
//! service is used.
#![cfg(target_os = "linux")]

#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use axum::{body::Body, http::Request};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::{Arc, OnceLock}, time::Duration};
use tower::ServiceExt;
use yuzuno_workspace::{model::{AgentDetail, MessageInput}, server, workspace::Workspace};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");
const ID: &str = "oc";
const MODEL: &str = "deepseek/deepseek-flash";
/// The summary the stand-in's compaction writes (2.x's start with `## Objective`).
const SUMMARY: &str = "## Objective\nfixture summary";

/// What a test expects of a `/compact` that is to go: 2.x's route admits it
/// under Core's ID (T-61 slice 4).
const ADMITTED: &str = "/compact goes by 2.x's route and is admitted under Core's ID";

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

/// An OpenCode Agent whose context was last measured long ago, at 400 of 1000.
fn agent(id: &str, cwd: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":id, "name":"OpenCode", "cwd":cwd, "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[],
    "contextUsage":{"usedTokens":400,"windowTokens":1000,"usedPercent":40.0,"turnId":"earlier","updatedAt":"2026-01-01T00:00:00Z","stale":false}})).unwrap()
}

/// A Workspace with one OpenCode Agent, connected; with `model`, chosen for
/// its next messages.
async fn lab(model: bool) -> Lab {
    program();
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir_all(dir.path().join("data/opencode").join(ID)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), work.to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.insert(&agent(ID, &work.to_string_lossy())).unwrap();
    let d = ws.reconnect(ID).await.unwrap();
    assert_eq!(d.agent.connection_state, "connected");
    if model {
        ws.opencode_set_model(ID, MODEL.into()).await.unwrap();
    }
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

    /// The compaction requests OpenCode was sent, as its calls log has them.
    fn compacted(&self) -> Vec<Value> {
        self.calls().into_iter().filter(|c| c["method"] == "POST" && c["path"].as_str().unwrap().ends_with("/compact")).collect()
    }

    /// The compaction requests the stand-in received: `{sessionID, id, delivery, keys}`.
    async fn compacts(&self) -> Vec<Value> {
        self.control("compacts", json!({})).await["seen"].as_array().unwrap().clone()
    }

    /// Prompts and commands OpenCode was sent.
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

    async fn compact_mode(&self, mode: &str) {
        self.control("mode", json!({"compact":mode})).await;
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

    async fn send(&self, client: &str, text: &str) -> anyhow::Result<()> {
        let input: MessageInput = serde_json::from_value(json!({"clientMessageId":client,"text":text,"images":[]})).unwrap();
        self.ws.send_message(ID, input).await.map(drop)
    }

    fn kinds(&self) -> Vec<String> {
        let db = rusqlite::Connection::open(self.dir.path().join("data/workspace.sqlite")).unwrap();
        let mut query = db.prepare("SELECT kind FROM journal WHERE agent_id=?1 ORDER BY seq").unwrap();
        query.query_map([ID], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
    }
}

/// The Agent's compaction Turns, oldest first.
fn compactions(d: &AgentDetail) -> Vec<&Value> {
    d.turns.iter().filter(|t| t["_opencodeCompact"].is_object()).collect()
}

fn compaction(d: &AgentDetail) -> &Value {
    compactions(d).last().copied().unwrap_or_else(|| panic!("no compaction Turn: {:#?}", d.turns))
}

fn summary_of(turn: &Value) -> Value {
    turn["items"].as_array().into_iter().flatten().find(|i| i["type"] == "contextCompaction").map(|i| i["text"].clone()).unwrap_or_default()
}

/// Whether neither a message nor a second compaction is taken now, saying
/// `why`, with nothing sent to OpenCode for either.
async fn refuses_new_writes(lab: &Lab, why: &str) {
    let (sent, compacted) = (lab.sent().len(), lab.compacted().len());
    let error = lab.send("refused", "Anything new?").await.unwrap_err().to_string();
    assert!(error.contains(why), "{error}");
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains(why) && error.contains("没有执行 /compact"), "{error}");
    assert_eq!((lab.sent().len(), lab.compacted().len()), (sent, compacted), "{:#?}", lab.calls());
}

/// A compaction is recorded before it is asked for, then asked for once by
/// 2.x's own route under Core's own ID, with the Agent's chosen model made
/// the session's first (D-19 (a)). Its Turn follows what 2.x says of the
/// compaction stored under that ID, and ends once 2.x is idle again:
/// completed, its summary the item's text, what was measured before it
/// stale. No Turn but its own; read again whole, nothing repeats; the next
/// message goes.
#[tokio::test]
async fn a_compaction_is_admitted_under_cores_own_id_and_ends_with_its_summary() {
    let lab = lab(true).await;
    let session = lab.session();
    let answer = lab.ws.opencode_compact(ID).await.expect(ADMITTED);
    let d = lab.until("its end", |d| compaction(d)["status"] == "completed").await;
    let turn = compaction(&d).clone();
    assert_eq!(answer, json!({"accepted":true,"turnId":turn["id"]}));
    let input = turn["_opencodeCompact"]["input"].as_str().expect("asked under Core's own ID").to_owned();
    let compacts = lab.compacts().await;
    assert_eq!(compacts.len(), 1, "asked once: {compacts:?}");
    assert_eq!((&compacts[0]["id"], &compacts[0]["keys"]), (&json!(input), &json!(["id"])), "under Core's ID, and no model");
    let calls = lab.calls();
    let model = format!("/api/session/{session}/model");
    let switched = calls.iter().position(|c| c["method"] == "POST" && c["path"] == model.as_str()).expect("the Agent's model made the session's");
    let compacted = calls.iter().position(|c| c["method"] == "POST" && c["path"] == format!("/api/session/{session}/compact")).unwrap();
    assert!(switched < compacted, "the model first");
    assert_eq!(calls[switched]["body"], json!({"model":{"id":"deepseek-flash","providerID":"deepseek"}}));
    let kinds = lab.kinds();
    assert!(kinds.iter().position(|k| k == "opencode/compactRequested").is_some(), "recorded before it was asked: {kinds:?}");
    assert_eq!(summary_of(&turn), SUMMARY, "its summary, as 2.x wrote it");
    assert_eq!((&turn["_opencodeCompact"]["state"], &turn["_opencodeCompact"]["native"]["model"]["providerID"]),
        (&json!("completed"), &json!("deepseek")), "what 2.x says it ran with");
    assert_eq!(serde_json::to_value(&d).unwrap()["contextUsage"]["stale"], true, "what was measured before it is stale");
    assert_eq!(d.turns.len(), 1, "no Turn but its own: {:#?}", d.turns);
    assert_eq!(d.agent.status, "idle");

    // Read again whole: the same one Turn, as it ended.
    let before = lab.kinds().iter().filter(|k| *k == "opencode/resynced").count();
    lab.control("drop", json!({})).await;
    for _ in 0..400 {
        if lab.kinds().iter().filter(|k| *k == "opencode/resynced").count() > before {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let d = lab.detail();
    assert_eq!(compactions(&d).len(), 1);
    assert_eq!((&compaction(&d)["status"], summary_of(compaction(&d))), (&json!("completed"), json!(SUMMARY)));
    lab.send("c1", "And now?").await.unwrap();
    assert_eq!(lab.compacts().await.len(), 1, "never asked again");
}

/// A compaction that failed fails its Turn with 2.x's own words, though 2.x
/// ends a manual compaction's run as succeeded either way: the summary it
/// could not write, or nothing to compact. The next message goes.
#[tokio::test]
async fn a_failed_compaction_fails_its_turn_though_its_run_ended_well() {
    let lab = lab(true).await;
    for (mode, words) in [("fail", "fixture: the summary failed"), ("unavailable", "fixture: nothing to compact")] {
        lab.compact_mode(mode).await;
        let turn = lab.ws.opencode_compact(ID).await.expect(ADMITTED)["turnId"].as_str().unwrap().to_owned();
        let d = lab.until("its end", |d| d.turns.iter().any(|t| t["id"] == turn.as_str() && t["status"] != "inProgress")).await;
        let ended = d.turns.iter().find(|t| t["id"] == turn.as_str()).unwrap();
        assert_eq!((&ended["status"], &ended["error"]["message"], &ended["_opencodeCompact"]["state"]),
            (&json!("failed"), &json!(words), &json!("failed")), "{mode}: the compaction failed, so its Turn did, in 2.x's words: {ended:#}");
        assert_eq!(d.agent.status, "idle");
    }
    lab.compact_mode("run").await;
    lab.send("c1", "And now?").await.unwrap();
}

/// An interrupted compaction is stopped: 2.x ends it as aborted and its run
/// as interrupted. While it ran nothing new was taken; once stopped, 2.x
/// holds nothing of it back, and the next message goes as any other.
#[tokio::test]
async fn an_interrupted_compaction_is_stopped_and_holds_nothing_back() {
    let lab = lab(true).await;
    lab.compact_mode("hold").await;
    lab.ws.opencode_compact(ID).await.expect(ADMITTED);
    lab.until("its start", |d| compaction(d)["_opencodeCompact"]["native"]["status"] == "running").await;
    refuses_new_writes(&lab, "OpenCode 正在压缩").await;
    lab.ws.interrupt(ID).await.unwrap();
    let d = lab.until("its stop", |d| compaction(d)["status"] != "inProgress").await;
    let stopped = compaction(&d);
    assert_eq!((&stopped["status"], &stopped["_opencodeCompact"]["state"], &stopped["error"]["native"]["type"]),
        (&json!("interrupted"), &json!("stopped"), &json!("aborted")), "interrupted, it is stopped, as 2.x aborted it: {stopped:#}");
    lab.compact_mode("run").await;
    lab.send("c1", "And now?").await.unwrap();
    assert_eq!(lab.sent().len(), 1, "the next message went");
    assert_eq!(lab.compacts().await.len(), 1);
}

/// Neither a compaction 2.x starts itself (automatic) nor another client's
/// is this Turn's, nor any Turn (D-20 (a)): only the one stored under the ID
/// Core asked with ends it.
#[tokio::test]
async fn an_auto_or_another_clients_compaction_never_ends_this_turn() {
    let lab = lab(true).await;
    let session = lab.session();
    // Automatic, with nothing asked for: no Turn, what was measured is stale.
    lab.control("autoCompact", json!({"sessionID":session})).await;
    lab.until("its stale usage", |d| serde_json::to_value(d).unwrap()["contextUsage"]["stale"] == true).await;
    assert!(compactions(&lab.detail()).is_empty() && lab.detail().turns.is_empty(), "no Turn: {:#?}", lab.detail().turns);

    // Ours admitted and waiting, while an automatic one and another client's run and end.
    lab.control("mode", json!({"compact":"late","compactDelay":3})).await;
    lab.ws.opencode_compact(ID).await.expect(ADMITTED);
    lab.control("autoCompact", json!({"sessionID":session})).await;
    let other = yuzuno_workspace::opencode::MessageId::new();
    let now = chrono::Utc::now().timestamp_millis();
    lab.control("event", json!({"type":"session.compaction.started","created":now,
        "properties":{"sessionID":session,"reason":"manual","inputID":other.as_str()}})).await;
    lab.control("event", json!({"type":"session.compaction.ended","created":now + 1,
        "properties":{"sessionID":session,"reason":"manual","text":"another client's summary"}})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let d = lab.detail();
    assert_eq!((&compaction(&d)["status"], &compaction(&d)["_opencodeCompact"]["native"]), (&json!("inProgress"), &Value::Null),
        "neither ended this one: {:#}", compaction(&d));
    let d = lab.until("its own end", |d| compaction(d)["status"] == "completed").await;
    assert_eq!(summary_of(compaction(&d)), SUMMARY, "its own summary");
    assert_eq!(d.turns.len(), 1, "no Turn but its own: {:#?}", d.turns);
}

/// A compaction whose admission went unanswered is looked for by its ID
/// (D-18 (a)): found in the inbox or the messages, it is followed as any
/// admitted one; not found, it is unknown, and nothing new is taken until a
/// reconnect reads the session again. Never sent again.
#[tokio::test]
async fn a_lost_admission_is_found_by_its_id_and_never_sent_again() {
    let lab = lab(true).await;
    for (n, mode) in [(1, "drop"), (2, "500-admitted")] {
        lab.compact_mode(mode).await;
        let answer = lab.ws.opencode_compact(ID).await.unwrap_or_else(|e| panic!("{mode}: found by its ID: {e}"));
        let turn = answer["turnId"].as_str().unwrap().to_owned();
        lab.until("its end", |d| d.turns.iter().any(|t| t["id"] == turn.as_str() && t["status"] == "completed")).await;
        assert_eq!(lab.compacts().await.len(), n, "{mode}: asked once");
    }
    lab.compact_mode("drop-unadmitted").await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("结果未确认，不会重发"), "{error}");
    let d = lab.detail();
    assert_eq!((&compaction(&d)["status"], &compaction(&d)["_opencodeCompact"]["state"]), (&json!("outcomeUnknown"), &json!("unknown")), "its Turn and attempt both unknown");
    assert_eq!(lab.compacts().await.len(), 3);
    refuses_new_writes(&lab, "上一次 /compact 的结果无法确认").await;
    assert_eq!(lab.compacts().await.len(), 3, "never sent again");
}

/// A compaction 2.x answered as admitted but keeps no record of, neither in
/// its inbox nor among its messages while it is idle, is unknown once a
/// whole read of the session finds it so: never left waiting, never sent
/// again.
#[tokio::test]
async fn an_admitted_compaction_2x_keeps_no_record_of_is_unknown_once_read_whole() {
    let lab = lab(true).await;
    lab.compact_mode("forget").await;
    lab.ws.opencode_compact(ID).await.expect(ADMITTED);
    // The event stream ends and comes back: Core reads the session whole again, the same process still there.
    lab.control("drop", json!({})).await;
    let d = lab.until("the end of a compaction 2.x has no record of", |d| compaction(d)["_opencodeCompact"]["state"] == "unknown").await;
    let lost = compaction(&d);
    assert!(lost["status"] == "outcomeUnknown" && lost["error"]["message"].as_str().unwrap_or_default().contains("OpenCode 的记录里没有这次压缩"),
        "unknown, as 2.x has no record of it: {lost:#}");
    assert_eq!(d.agent.connection_state, "connected", "the same connection");
    assert_eq!(lab.compacts().await.len(), 1, "never sent again");
}

/// A compaction cut off with its process (2.x settles the message its
/// earlier process left running as `compaction.interrupted`) is stopped
/// once the session is read again, as an interrupted one is.
#[tokio::test]
async fn a_compaction_cut_off_with_its_process_is_stopped_once_read_again() {
    let lab = lab(true).await;
    lab.compact_mode("hold").await;
    lab.ws.opencode_compact(ID).await.expect(ADMITTED);
    lab.until("its start", |d| compaction(d)["_opencodeCompact"]["native"]["status"] == "running").await;
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(lab.root().join("start.json")).unwrap()).unwrap();
    let pid = seen["pid"].as_u64().unwrap().to_string();
    assert!(std::process::Command::new("kill").args(["-KILL", &pid]).status().unwrap().success());
    lab.until("the connection's end", |d| d.agent.connection_state != "connected").await;
    lab.ws.reconnect(ID).await.unwrap();
    let d = lab.until("its settled end", |d| compaction(d)["_opencodeCompact"]["state"] == "stopped").await;
    assert_eq!((&compaction(&d)["status"], &compaction(&d)["error"]["native"]["type"]),
        (&json!("interrupted"), &json!("compaction.interrupted")), "{:#}", compaction(&d));
    assert_eq!(lab.compacts().await.len(), 0, "the new process was asked nothing");
}

/// Only what 2.x refuses before admitting counts as refused: a session or
/// folder it does not hold, a request it can't read, or another compaction
/// already waiting there (whose own answer takes ours' place). Its Turn
/// failed, saying so. A 409 or any other answer is unknown.
#[tokio::test]
async fn only_a_refusal_before_admission_counts_as_refused() {
    let lab = lab(true).await;
    for (mode, words) in [("refuse-404", "（HTTP 404）"), ("invalid-400", "（HTTP 400）")] {
        lab.compact_mode(mode).await;
        let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
        assert!(error.contains("OpenCode 拒绝了 /compact") && error.contains(words), "{mode}: refused before admission, saying so: {error}");
        let d = lab.detail();
        assert_eq!((&compaction(&d)["status"], &compaction(&d)["_opencodeCompact"]["state"]), (&json!("failed"), &json!("refused")), "{mode}");
        assert_eq!(d.agent.status, "idle");
    }
    lab.compact_mode("conflict-409").await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("结果未确认，不会重发"), "a 409 is unknown: {error}");
    assert_eq!(compaction(&lab.detail())["_opencodeCompact"]["state"], "unknown");

    let lab = self::lab(true).await;
    lab.compact_mode("other-pending").await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("另一个尚未执行的压缩"), "{error}");
    assert_eq!(compaction(&lab.detail())["_opencodeCompact"]["state"], "refused");
}

/// Nothing is asked while 2.x is busy, while the session holds a revert
/// (2.x would commit it first), with no model known (none chosen and none
/// the session's), or when the session can't be read.
#[tokio::test]
async fn nothing_is_asked_while_busy_with_a_revert_held_or_no_model_known() {
    let lab = lab(false).await;
    let session = lab.session();
    let error = lab.ws.opencode_compact(ID).await.expect_err("refused with no model known").to_string();
    assert!(error.contains("无法确定压缩用哪个模型"), "refused with no model known, saying so: {error}");
    lab.ws.opencode_set_model(ID, MODEL.into()).await.unwrap();
    lab.control("revert", json!({"sessionID":session})).await;
    let error = lab.ws.opencode_compact(ID).await.expect_err("refused while the session holds a revert").to_string();
    assert!(error.contains("请先发一条消息"), "refused while the session holds a revert, saying so: {error}");

    let lab = self::lab(true).await;
    let session = lab.session();
    lab.control("busy", json!({"sessionID":session})).await;
    let error = lab.ws.opencode_compact(ID).await.expect_err("refused while 2.x is busy").to_string();
    assert!(error.contains("不是空闲状态"), "refused while 2.x is busy, saying so: {error}");
    lab.control("idle", json!({"sessionID":session})).await;
    lab.control("mode", json!({"fail":{format!("/api/session/{session}"):500}})).await;
    let error = lab.ws.opencode_compact(ID).await.expect_err("refused when the session can't be read").to_string();
    assert!(error.contains("没有读到 OpenCode 会话现在的状态"), "refused when the session can't be read, saying so: {error}");
    assert!(lab.compacted().is_empty() && lab.compacts().await.is_empty(), "{:#?}", lab.calls());
    assert!(compactions(&lab.detail()).is_empty());
}

/// With no model chosen, the session's own is the one 2.x compacts with:
/// nothing is switched first.
#[tokio::test]
async fn with_no_model_chosen_the_sessions_own_model_is_used() {
    let lab = lab(true).await;
    let session = lab.session();
    lab.ws.opencode_compact(ID).await.expect(ADMITTED);
    lab.until("its end", |d| compaction(d)["status"] == "completed").await;
    // The session now has the chosen model; no model is chosen for the next.
    lab.ws.opencode_set_model(ID, String::new()).await.unwrap();
    let switches = || lab.calls().into_iter().filter(|c| c["method"] == "POST" && c["path"] == format!("/api/session/{session}/model")).count();
    let before = switches();
    lab.ws.opencode_compact(ID).await.expect(ADMITTED);
    lab.until("its end", |d| compactions(d).len() == 2 && compaction(d)["status"] == "completed").await;
    assert_eq!(switches(), before, "nothing switched");
    assert_eq!(compaction(&lab.detail())["_opencodeCompact"]["model"], "deepseek/deepseek-flash", "the session's own");
}

/// The route the composer's `/compact` calls runs an OpenCode Agent's own
/// compaction, and answers as `opencode_compact` does.
#[tokio::test]
async fn the_compact_route_runs_an_opencode_agents_own_compaction() {
    let lab = lab(true).await;
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4999);
    let request = Request::builder().method("POST").uri(format!("/api/agents/{ID}/compact"))
        .header("host", "localhost:4999").header("x-yuzuno-client", "desktop").body(Body::empty()).unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), 200, "the route runs an OpenCode Agent's compaction");
    lab.until("its end", |d| compaction(d)["status"] == "completed").await;
    assert_eq!(lab.compacts().await.len(), 1);
}
