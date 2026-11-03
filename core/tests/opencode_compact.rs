//! An OpenCode Agent's `/compact` (T-10, contract on T-10 #3109) through the
//! Workspace, against the stand-in `opencode serve`
//! (tests/fixtures/opencode_server.py, run by /usr/bin/python3): OpenCode's
//! own compaction (`POST /session/:id/summarize`), recorded before it is
//! asked for, bound to the one compaction message it writes, done only once
//! that message's summary completed and the session is idle, and never sent
//! again. While one goes on, or its end is unknown, or OpenCode still holds
//! one unfinished, nothing new is sent. No OpenCode, account, model or
//! network service is used.
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
const SUMMARY: &str = "The conversation so far, in short.";

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

    /// The compaction requests OpenCode was sent.
    fn summarized(&self) -> Vec<Value> {
        self.calls().into_iter().filter(|c| c["method"] == "POST" && c["path"].as_str().unwrap().ends_with("/summarize")).collect()
    }

    /// Prompts and commands OpenCode was sent.
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

    async fn summarize(&self, mode: &str) {
        self.control("mode", json!({"summarize":mode})).await;
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

/// Whether neither a message nor a second compaction is taken now, saying
/// `why`, with nothing sent to OpenCode for either.
async fn refuses_new_writes(lab: &Lab, why: &str) {
    let (sent, summarized) = (lab.sent().len(), lab.summarized().len());
    let error = lab.send("refused", "Anything new?").await.unwrap_err().to_string();
    assert!(error.contains(why), "{error}");
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains(why) && error.contains("没有执行 /compact"), "{error}");
    assert_eq!((lab.sent().len(), lab.summarized().len()), (sent, summarized), "{:#?}", lab.calls());
}

/// A compaction is recorded before it is asked for, with the chosen model
/// and without a variant, which OpenCode 1.19.3 takes none of. It is bound
/// to the one new compaction message asked for: not to one the session held
/// before. Its summary, written before the run, does not end it; while it
/// runs nothing new is taken. It ends once the summary completed and the
/// session is idle, the summary its item's text, what was measured last
/// known and not 0. Read again from the whole record, nothing repeats.
#[tokio::test]
async fn a_compaction_runs_once_and_ends_only_with_its_completed_summary() {
    let lab = lab(true).await;
    let session = lab.session();
    // One the session held already, asked for and of the same model.
    let earlier = lab.control("compaction", json!({"sessionID":session,"auto":false})).await;
    lab.summarize("hold").await;
    let started = lab.ws.opencode_compact(ID).await.unwrap();
    assert_eq!(started["accepted"], true, "{started}");
    let kinds = lab.kinds();
    assert!(kinds.contains(&"opencode/compactRequested".to_owned()), "{kinds:?}");
    let asked = lab.summarized();
    assert_eq!(asked.len(), 1, "{asked:#?}");
    assert_eq!(asked[0]["body"], json!({"providerID":"deepseek","modelID":"deepseek-flash","auto":false}));
    let d = lab.until("its summary, written before the run", |d| compaction(d)["_opencodeCompact"]["summary"].is_object()).await;
    let turn = compaction(&d);
    let attempt = &turn["_opencodeCompact"];
    assert_eq!(attempt["known"], json!([earlier["id"]]), "{attempt:#}");
    assert!(attempt["message"].is_string() && attempt["message"] != earlier["id"], "{attempt:#}");
    assert_eq!((turn["status"].as_str(), attempt["state"].as_str()), (Some("inProgress"), Some("pending")), "{turn:#}");
    assert_eq!(turn["_yuzunoCompactionId"], format!("{}:compaction", turn["id"].as_str().unwrap()));
    assert_eq!(d.agent.status, "working");
    refuses_new_writes(&lab, "正在压缩").await;

    lab.control("finishSummary", json!({"sessionID":session,"text":SUMMARY})).await;
    let d = lab.until("the compaction's end", |d| compaction(d)["status"] == "completed").await;
    let turn = compaction(&d);
    assert_eq!(turn["items"], json!([{"id":format!("{}:compaction", turn["id"].as_str().unwrap()),"type":"contextCompaction","trigger":"manual","text":SUMMARY}]));
    assert!(turn.get("_yuzunoCompactionId").is_none() && turn.get("error").is_none(), "{turn:#}");
    assert_eq!(turn["_opencodeCompact"]["nativePending"], false);
    let usage = d.context_usage.clone().unwrap();
    assert!(usage.stale && usage.used_tokens == 400, "{usage:?}");

    // The event stream breaks: the whole record, read again, repeats nothing.
    let resynced = lab.kinds().iter().filter(|k| *k == "opencode/resynced").count();
    lab.control("drop", json!({})).await;
    lab.until("the record read again", |_| lab.kinds().iter().filter(|k| *k == "opencode/resynced").count() > resynced).await;
    let d = lab.detail();
    assert_eq!(compactions(&d).len(), 1);
    assert_eq!(compaction(&d)["items"].as_array().unwrap().len(), 1);
    assert_eq!(compaction(&d)["status"], "completed");
    assert_eq!(lab.summarized().len(), 1);
}

/// With no model chosen, the one the session's newest message went with,
/// as OpenCode lists it; with none known, nothing is asked. A revert waiting
/// in the session (which summarize would apply), a session OpenCode is not
/// idle in, or a session that cannot be read: nothing is sent either.
#[tokio::test]
async fn nothing_is_asked_for_without_a_known_model_or_a_readable_idle_session_with_no_revert() {
    let lab = lab(false).await;
    let session = lab.session();
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("还不知道这个会话用的是哪个模型"), "{error}");
    lab.control("store", json!({"sessionID":session,"messageID":"msg_earlier","text":"Hello"})).await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("还不知道这个会话用的是哪个模型"), "{error}");
    assert!(lab.summarized().is_empty());

    lab.ws.opencode_set_model(ID, MODEL.into()).await.unwrap();
    lab.control("revert", json!({"sessionID":session})).await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("尚未处理的回退"), "{error}");

    let lab = self::lab(true).await;
    let session = lab.session();
    lab.control("busy", json!({"sessionID":session})).await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("不是空闲状态"), "{error}");
    lab.control("idle", json!({"sessionID":session})).await;
    lab.control("mode", json!({"fail":{format!("/session/{session}"):500}})).await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("没有读到 OpenCode 会话现在的状态"), "{error}");
    assert!(lab.summarized().is_empty(), "{:#?}", lab.calls());
    assert!(compactions(&lab.detail()).is_empty());
}

/// The model the session's newest message went with, when none is chosen.
#[tokio::test]
async fn with_no_model_chosen_the_sessions_newest_message_names_it() {
    let lab = lab(false).await;
    let session = lab.session();
    lab.control("compaction", json!({"sessionID":session,"model":{"providerID":"openrouter","modelID":"anthropic/claude-x"},"auto":true})).await;
    lab.ws.opencode_compact(ID).await.unwrap();
    assert_eq!(lab.summarized()[0]["body"], json!({"providerID":"openrouter","modelID":"anthropic/claude-x","auto":false}));
    lab.until("its end", |d| compaction(d)["status"] == "completed").await;
}

/// Neither a compaction OpenCode started itself (`auto`) nor two new ones
/// asked for confirm this one: its end is unknown, never guessed, and
/// nothing new is taken.
#[tokio::test]
async fn a_compaction_of_opencodes_own_or_two_new_ones_never_confirm_this_one() {
    for (mode, why) in [("auto", "没有找到这次压缩"), ("double", "不止一条新的压缩")] {
        let lab = lab(true).await;
        lab.summarize(mode).await;
        // Its start may be seen before the second one is written.
        let _ = lab.ws.opencode_compact(ID).await;
        let d = lab.until("its end found unknown", |d| compaction(d)["_opencodeCompact"]["state"] == "unknown").await;
        let turn = compaction(&d);
        assert_eq!(turn["status"], "outcomeUnknown", "{mode}: {turn:#}");
        assert!(turn["error"]["message"].as_str().unwrap().contains(why), "{mode}: {turn:#}");
        assert!(turn["_opencodeCompact"]["message"].is_null() || mode == "double", "{mode}: {turn:#}");
        refuses_new_writes(&lab, "无法确认").await;
        assert_eq!(lab.summarized().len(), 1, "{mode}");
    }
}

/// An answer lost on the way changes nothing: OpenCode's record ends the
/// compaction. OpenCode gone while it ran: what its record holds, read by
/// the next process, is a compaction never finished, which keeps anything
/// new out; nothing is ever sent again.
#[tokio::test]
async fn a_lost_answer_or_a_process_gone_mid_run_is_read_from_the_record_and_never_sent_again() {
    let lab = lab(true).await;
    lab.summarize("drop").await;
    lab.ws.opencode_compact(ID).await.unwrap();
    lab.until("its end", |d| compaction(d)["status"] == "completed").await;
    lab.until("its lost answer", |d| compaction(d)["_opencodeCompact"]["answer"]["kind"] == "unknown").await;
    assert_eq!(compaction(&lab.detail())["status"], "completed");
    assert_eq!(lab.summarized().len(), 1);

    let lab = self::lab(true).await;
    lab.summarize("hold").await;
    lab.ws.opencode_compact(ID).await.unwrap();
    lab.control("die", json!({})).await;
    let d = lab.until("the connection's end", |d| d.agent.connection_state == "disconnected").await;
    assert_eq!(compaction(&d)["_opencodeCompact"]["state"], "unknown", "{:#}", compaction(&d));
    refuses_new_writes(&lab, "无法确认").await;
    lab.ws.reconnect(ID).await.unwrap();
    let d = lab.detail();
    let turn = compaction(&d);
    assert_eq!((turn["status"].as_str(), turn["_opencodeCompact"]["nativePending"].as_bool()), (Some("outcomeUnknown"), Some(true)), "{turn:#}");
    assert!(turn["error"]["message"].as_str().unwrap().contains("进程已经更换"), "{turn:#}");
    refuses_new_writes(&lab, "无法确认").await;
    assert_eq!(lab.summarized().len(), 1, "{:#?}", lab.calls());
}

/// A 400 with nothing in OpenCode's record refused it: nothing was written,
/// and a later `/compact` is asked again. A 404, or a 400 after its message
/// was written, does not: what the record holds decides, here unknown.
#[tokio::test]
async fn a_refusal_counts_only_before_anything_was_written() {
    let lab = lab(true).await;
    lab.summarize("refuse").await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("OpenCode 拒绝了 /compact（HTTP 400）"), "{error}");
    let d = lab.detail();
    assert_eq!((compaction(&d)["status"].as_str(), compaction(&d)["_opencodeCompact"]["state"].as_str()), (Some("failed"), Some("refused")));
    lab.summarize("run").await;
    lab.ws.opencode_compact(ID).await.unwrap();
    lab.until("the next one's end", |d| compaction(d)["status"] == "completed").await;
    assert_eq!(lab.summarized().len(), 2);

    for mode in ["refuse-404", "refuse-late"] {
        let lab = self::lab(true).await;
        lab.summarize(mode).await;
        // A message written before the 400 may be seen as its start.
        let _ = lab.ws.opencode_compact(ID).await;
        let d = lab.until("its end found unknown", |d| compaction(d)["_opencodeCompact"]["state"] == "unknown").await;
        assert_eq!(compaction(&d)["status"], "outcomeUnknown", "{mode}: {:#}", compaction(&d));
        assert_eq!(compaction(&d)["_opencodeCompact"]["message"].is_string(), mode == "refuse-late", "{mode}");
        refuses_new_writes(&lab, "无法确认").await;
        assert_eq!(lab.summarized().len(), 1, "{mode}");
    }
}

/// A start not seen within the window is unknown to the caller: the
/// request goes on, the Turn waits for what OpenCode says, nothing is sent
/// again and nothing new is taken.
#[tokio::test]
async fn a_start_not_seen_in_time_is_unknown_and_never_sent_again() {
    let lab = lab(true).await;
    lab.summarize("silent").await;
    let error = lab.ws.opencode_compact(ID).await.unwrap_err().to_string();
    assert!(error.contains("还没有确认开始压缩"), "{error}");
    let d = lab.detail();
    assert_eq!((compaction(&d)["status"].as_str(), compaction(&d)["_opencodeCompact"]["state"].as_str()), (Some("inProgress"), Some("pending")));
    refuses_new_writes(&lab, "正在压缩").await;
    assert_eq!(lab.summarized().len(), 1);
}

/// Stopped while it runs: one abort, the compaction stopped as OpenCode
/// says, and, as OpenCode still holds it unfinished, nothing new taken.
#[tokio::test]
async fn a_stopped_compaction_keeps_new_messages_out_while_opencode_holds_it() {
    let lab = lab(true).await;
    lab.summarize("hold").await;
    lab.ws.opencode_compact(ID).await.unwrap();
    lab.until("its summary", |d| compaction(d)["_opencodeCompact"]["summary"].is_object()).await;
    lab.ws.interrupt(ID).await.unwrap();
    let d = lab.until("its stop", |d| compaction(d)["status"] == "interrupted").await;
    let turn = compaction(&d);
    assert_eq!((turn["_opencodeCompact"]["state"].as_str(), turn["_opencodeCompact"]["nativePending"].as_bool()), (Some("stopped"), Some(true)), "{turn:#}");
    assert!(turn["error"]["message"].as_str().unwrap().contains("仍未完成"), "{turn:#}");
    let aborted = lab.calls().iter().filter(|c| c["method"] == "POST" && c["path"].as_str().unwrap().ends_with("/abort")).count();
    assert_eq!(aborted, 1);
    refuses_new_writes(&lab, "还留着上一次没有完成的压缩").await;
    assert_eq!(lab.summarized().len(), 1);
}

/// A compaction request still going holds nothing of its connection: once
/// that connection ends, so does its OpenCode process, as for any request.
#[tokio::test]
async fn a_request_still_going_keeps_no_opencode_process_alive_after_its_connection_ends() {
    let lab = lab(true).await;
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(lab.root().join("start.json")).unwrap()).unwrap();
    let pid = seen["pid"].as_u64().unwrap();
    // Running, or a zombie not yet reaped, which runs nothing.
    let alive = || std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat.rsplit_once(") ").is_some_and(|(_, rest)| !rest.starts_with('Z'))
    });
    lab.summarize("hold").await;
    lab.ws.opencode_compact(ID).await.unwrap();
    // The event stream breaks and cannot be opened again: the connection ends.
    lab.control("refuseEvents", json!({"seconds":30})).await;
    lab.control("drop", json!({})).await;
    lab.until("the connection's end", |d| d.agent.connection_state == "disconnected").await;
    for _ in 0..200 {
        if !alive() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!alive(), "OpenCode {pid} still runs while the compaction's request is held open");
    assert_eq!(compaction(&lab.detail())["_opencodeCompact"]["state"], "unknown");
}

/// The composer's `/compact` route runs an OpenCode Agent's own compaction.
#[tokio::test]
async fn the_compact_route_runs_an_opencode_agents_own_compaction() {
    let lab = lab(true).await;
    let router = server::router_on_port(lab.ws.clone(), lab.dir.path().join("assets"), 4999);
    let request = Request::builder().method("POST").uri(format!("/api/agents/{ID}/compact"))
        .header("host", "localhost:4999").header("x-yuzuno-client", "desktop").body(Body::empty()).unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    lab.until("its end", |d| compaction(d)["status"] == "completed").await;
    assert_eq!(lab.summarized().len(), 1);
}
