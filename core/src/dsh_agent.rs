//! dsh Agents (YN-119 design v1 §3.4–§3.10, slice S2a): an Agent's record
//! driven by its own `dsh --profile acp` (`dsh`, the process layer, S1).
//! Local Agents only, each with a DeepSeek routing key of its own (§3.10).
//!
//! A Turn is one `session/prompt`, recorded under Core's own ID before it is
//! sent (`dsh/turnRequested`) and ended by dsh's answer to that request, its
//! `stopReason`. That answer goes through the connection's event queue, after
//! every update dsh sent before it, so no step of a Turn lands after its end.
//! dsh's `session/update`s are journaled as dsh sent them (`dsh/update`) and
//! read into Codex-shaped Items of the Turn its open prompt runs (`apply`), as
//! OpenCode's are (opencode_v2.rs). Each step arrives whole: dsh streams no
//! text. An update while no prompt is open (a Turn dsh starts by itself once
//! a background task ends, ACP README) goes to a Turn of its own,
//! `native-<id>`, shown as completed: nothing tells when such a Turn ends.
//!
//! ACP runs one prompt at a time: a message added to a running Turn is
//! refused, and so is a new one until dsh has answered the last (§3.5).
//!
//! An interrupt is `session/cancel`: dsh's `cancelled` ends the Turn; with no
//! answer within STOP_LIMIT its end is unknown, as Claude's is, and that dsh
//! is ended, since ACP's next prompt would wait for this one's answer: the
//! next message or a reconnect resumes the session in a new dsh.
//!
//! A request past dsh's sandbox (`session/request_permission`, §3.6) is the
//! user's at Ask you first: a `dsh/permission` card, answered allow-once or
//! reject-once (`dsh_respond`). At Auto-approve Core refuses it, reject-once,
//! and at Full access dsh asks nothing. An interrupt or a close answers an
//! open one `cancelled`, as ACP asks of a client that cancels.
//!
//! With the Workspace MCP (§3.7), both `session/new` and `session/resume`
//! name it (`mcpServers`, its Bearer credential in that request alone), and
//! `$DSH_HOME/AGENTS.md` holds the session notice and, for a Project's Agent
//! the Brief check applies to, the Brief's rules (§3.1), as Claude's system
//! prompt and Codex's developer instructions do.
//!
//! A start (§3.8): a new dsh, `session/resume` of the Agent's session (or
//! `session/new` for its first), then its model and effort set again. What
//! an earlier dsh ran and did not answer is unknown: dsh keeps that Turn as
//! interrupted in its own session, and Core as outcomeUnknown here.
//!
//! The Agent's folder for dsh, `<data>/dsh/<agent>`, is Core's own and goes
//! with the Agent when it is deleted (`remove_folder`).
//!
//! A Turn's end is journaled as a `turn/completed` too, as Claude's is: an
//! unread result, and what the Brief check reads (brief_turns).
//!
//! The Agent's model and effort are set on its session between Turns, and
//! again at each start; its level, dsh's sandbox, takes a new dsh, which
//! resumes the session (§3.6, §3.9, `dsh_settings`). What it may choose is
//! what its dsh offers (`model_rows`), or, before it has one, what a dsh of
//! Core's own lists (`dsh_catalog`). Images go as ACP image blocks, to a dsh
//! that says it takes them.
use crate::{
    backlog::{Backlog, EventSender},
    dsh::{self, Access, Dsh},
    model::{ensure_agent_open, now, Agent, AgentDetail, ContextUsage, MessageInput, PendingRequest},
    routing_launch::RuntimeProfile,
    rpc::RpcError,
    store::Sel,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

/// Why a dsh Agent without a DeepSeek key does not start (§3.10).
pub(crate) const NO_KEY: &str = "dsh 需要一个 DeepSeek 密钥：设置 → 路由密钥。dsh needs a DeepSeek key: Settings → Routing keys.";
/// Why a message is not sent while a Turn runs (§3.5): ACP takes one prompt at a time.
const BUSY: &str = "dsh 一轮结束前不能追加，请等它结束或先中断；草稿保留。dsh takes no message until its Turn ends: wait, or interrupt it first. The draft is kept.";
/// Why a message's images are not sent: its dsh's initialize said it takes none (§3.9).
const NO_IMAGES: &str = "这个 dsh 不接收图片，消息未发送；草稿保留。This dsh takes no images: the message was not sent.";
/// How long an interrupt waits for dsh's answer before its Turn's end is
/// unknown (§3.5), and a close for a running Turn to end before dsh is
/// stopped: Claude's STOP_CONFIRMATION, 10 s.
const STOP_LIMIT: Duration = Duration::from_secs(10);
/// How long `session/new`, `session/resume` and each `set_config_option`
/// may take: as `initialize` (dsh.rs START_LIMIT, 30 s).
const SESSION_LIMIT: Duration = Duration::from_secs(30);
/// How long what `/api/workspace` says of dsh stands before it is read again
/// in the background: the catalog cache's 60 s (§3.9).
const STATUS_FRESH: Duration = Duration::from_secs(60);
/// dsh's reasoning efforts (llm-deepseek models.ts; §1, §3.9). None is the provider's own.
pub(crate) const EFFORTS: [&str; 4] = ["off", "low", "high", "max"];
/// Core's own messages in a connection's event queue: a prompt's answer, and
/// an interrupt dsh did not answer within STOP_LIMIT.
const PROMPT_ENDED: &str = "yuzuno/promptEnded";
const STOP_UNCONFIRMED: &str = "yuzuno/stopUnconfirmed";
/// A request past dsh's sandbox, the user's to answer (§3.6).
pub(crate) const PERMISSION: &str = "dsh/permission";
/// What the user may answer one with: dsh offers allow-once and reject-once only.
const DECISIONS: [&str; 2] = ["accept", "decline"];
/// How long dsh's model list for a new Agent stands, and how long reading it
/// may take: OpenCode's catalog's 60 s and the design's 20 s (§3.9).
const CATALOG_FRESH: Duration = Duration::from_secs(60);
const CATALOG_LIMIT: Duration = Duration::from_secs(20);
/// The key a dsh started only to list its models is given: dsh needs one to
/// start, and lists its models without calling any.
const CATALOG_KEY: &str = "sk-yuzuno-catalog-placeholder";

/// The permission levels dsh keeps (§3.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Level {
    /// Ask you first: dsh's workspace-write sandbox, asking before going past it.
    Ask,
    /// Auto-approve: the same sandbox; Core refuses whatever goes past it, with
    /// no model review (Q2).
    Auto,
    /// Full access: danger-full-access, nothing asks.
    Full,
}

impl Level {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }

    /// What dsh is started with for it (S1's Access).
    pub(crate) fn access(self) -> Access {
        match self {
            Self::Ask | Self::Auto => Access::Workspace,
            Self::Full => Access::Full,
        }
    }
}

/// How dsh keeps permission level `id` (§3.6), also for routing (S3): None
/// for read-only, which dsh does not keep (its sandbox limits no network, nor
/// web_fetch or MCP), and for what is no level.
pub(crate) fn level_of(id: &str) -> Option<Level> {
    match id {
        "ask" => Some(Level::Ask),
        "auto" => Some(Level::Auto),
        "full" => Some(Level::Full),
        _ => None,
    }
}

fn not_kept(level: &str) -> String {
    format!("dsh 只支持先问你、自动审批和完全放开，不支持「{level}」：它在任何级别都不限网络。dsh keeps Ask you first, Auto-approve and Full access, not {level}: its network is open at every level.")
}

/// One Agent's running dsh and the ACP session it drives.
#[derive(Clone)]
pub(crate) struct Connection {
    pub generation: u64,
    pub dsh: Arc<Dsh>,
    pub session: String,
    /// The level this dsh was started at: what becomes of a request past its sandbox.
    level: Level,
    /// dsh's session options as it last gave them (§3.9): the models and efforts it offers.
    options: Arc<Mutex<Value>>,
    /// Whether this dsh takes images in a prompt: `promptCapabilities.image` at its initialize (§3.9).
    images: bool,
    /// Into this connection's own event queue (`PROMPT_ENDED`, `STOP_UNCONFIRMED`).
    events: EventSender,
    /// The Turn whose prompt dsh has not answered yet.
    prompt: Arc<Mutex<Option<String>>>,
    /// The Turn updates go to while no prompt is open.
    native: Arc<Mutex<Option<String>>>,
}

// ---------------------------------------------------------------- what Core says of dsh

/// What the dsh this Core would start is (`/api/workspace`, §6 S2a):
/// `{available, version, label}`, label being its note against the verified
/// release, if any. Read with `dsh --version` (§5.1) once, then again in the
/// background once STATUS_FRESH has gone by, answering with the last read.
pub(crate) async fn status(data: &Path) -> Value {
    static STATUS: Mutex<Option<(PathBuf, Instant, Value)>> = Mutex::new(None);
    static READING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let program = dsh::program();
    let read = {
        let status = STATUS.lock().unwrap();
        status.as_ref().filter(|(of, ..)| *of == program).map(|(_, at, value)| (at.elapsed() >= STATUS_FRESH, value.clone()))
    };
    let home = version_home(data);
    match read {
        Some((stale, value)) => {
            if stale && !READING.swap(true, Ordering::SeqCst) {
                tokio::spawn(async move {
                    let value = installed(&program, &home).await;
                    *STATUS.lock().unwrap() = Some((program, Instant::now(), value));
                    READING.store(false, Ordering::SeqCst);
                });
            }
            value
        }
        None => {
            let value = installed(&program, &home).await;
            *STATUS.lock().unwrap() = Some((program, Instant::now(), value.clone()));
            value
        }
    }
}

/// `dsh --version` of `program`, in `home`, a folder of Core's own (0700).
pub(crate) async fn installed(program: &Path, home: &Path) -> Value {
    match version_in(program, home).await {
        Ok((version, standing)) => json!({"available": true, "version": version.to_string(), "label": standing.note()}),
        Err(_) => json!({"available": false, "version": null, "label": null}),
    }
}

/// The folder `dsh --version` runs in when Core reads which dsh it would
/// start: `<data>/dsh-version`, Core's own.
pub(crate) fn version_home(data: &Path) -> PathBuf {
    data.join("dsh-version")
}

/// `dsh --version` of `program` in `home` (0700), and how each start judges
/// that version (§5.1), or why it can't be read: what `/api/workspace`
/// (`installed`) and the machine check (machines.rs) say of dsh.
pub(crate) async fn version_in(program: &Path, home: &Path) -> Result<(dsh::Version, dsh::Standing)> {
    std::fs::create_dir_all(home)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))?;
    }
    dsh::installed(program, home).await
}

// ---------------------------------------------------------------- the record

/// Whether the Agent runs a Turn or waits for an answer.
fn busy(d: &AgentDetail) -> bool {
    matches!(d.agent.status.as_str(), "working" | "waiting") || (d.agent.status != "offline" && d.turns.iter().any(|t| t["status"] == "inProgress"))
}

fn refresh_status(d: &mut AgentDetail) {
    if d.pending.iter().any(|p| !p.stale && p.params["_responseSent"] != true) {
        d.agent.status = "waiting".into();
    } else if d.turns.iter().any(|t| t["status"] == "inProgress") {
        d.agent.status = "working".into();
    } else if matches!(d.agent.status.as_str(), "waiting" | "working") {
        d.agent.status = "idle".into();
    }
}

/// A tool call still open when its Turn ended will not report.
fn settle_tools(turn: &mut Value) {
    for item in turn["items"].as_array_mut().into_iter().flatten() {
        if item["status"] == "inProgress" {
            item["status"] = "unknown".into();
        }
    }
}

fn unknown(turn: &mut Value, message: &str) {
    turn["status"] = "outcomeUnknown".into();
    turn["error"] = json!({"message": message});
    settle_tools(turn);
}

/// A dsh gone: nothing it ran can report any more, and no message it was
/// sent is sent again.
fn ended(d: &mut AgentDetail, message: &str) {
    for turn in &mut d.turns {
        if turn["status"] == "inProgress" {
            unknown(turn, message);
        }
    }
    for p in &mut d.pending {
        p.stale = true;
    }
    for receipt in &mut d.message_receipts {
        if matches!(receipt.status.as_str(), "sending" | "queued" | "uncertain") {
            receipt.status = "unknown".into();
            receipt.error = Some("dsh 结束前没有确认收到这条消息；不会重发".into());
        }
    }
}

const RESTARTED: &str = "dsh 已重新启动；上一个 dsh 没有回答这一轮，结果未确认，不会重发。会话已恢复。dsh started again: the earlier one never answered this Turn, so its end is unknown; it is not sent again.";
const CLOSED: &str = "dsh 关闭前没有确认这一轮结束；结果未确认，不会重发。dsh was stopped before this Turn's end was confirmed; it is not sent again.";

/// How a prompt ended (§3.4), from what `PROMPT_ENDED` carries: its
/// `stopReason`, dsh's error, or `unknown` when dsh ended first.
fn end_of(params: &Value) -> (&'static str, Option<String>) {
    if let Some(reason) = params["unknown"].as_str() {
        return ("outcomeUnknown", Some(format!("dsh 结束前没有回答这一轮（{reason}）；结果未确认，不会重发。")));
    }
    if params["error"].is_object() {
        return ("failed", Some(params["error"]["message"].as_str().unwrap_or("dsh answered with an error").to_owned()));
    }
    match params["stopReason"].as_str() {
        Some("cancelled") => ("interrupted", None),
        Some("refusal") => ("failed", Some("模型拒绝回答（refusal）。The model refused to answer.".into())),
        // end_turn, and max_tokens or max_turn_requests, which are kept on the Turn.
        _ => ("completed", None),
    }
}

/// The updates that become Items of a Turn (§3.4); the others (plans,
/// commands, modes, the session's own notes) change no Turn.
fn itemized(update: &Value) -> bool {
    matches!(update["sessionUpdate"].as_str(), Some("agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update"))
}

/// One `session/update` read into `turn` of `d` at `at` (§3.4): its Items,
/// or the context it reports (with no Turn, for the newest one).
fn apply(d: &mut AgentDetail, turn: Option<&str>, update: &Value, at: chrono::DateTime<chrono::Utc>) {
    let kind = update["sessionUpdate"].as_str().unwrap_or_default();
    if kind == "usage_update" {
        let newest = d.turns.last().and_then(|t| t["id"].as_str()).unwrap_or_default().to_owned();
        if let (Some(used), Some(size)) = (update["used"].as_u64(), update["size"].as_u64()) {
            d.context_usage = ContextUsage::measured(used, size, turn.unwrap_or(&newest), at);
        }
        return;
    }
    let Some(turn) = turn.filter(|_| itemized(update)) else { return };
    delivered(d, turn);
    let entry = d.turn_at(turn, at);
    if !entry["items"].is_array() {
        entry["items"] = json!([]);
    }
    let items = entry["items"].as_array_mut().expect("turn items");
    match kind {
        "agent_message_chunk" | "agent_thought_chunk" => {
            // Text only: an image or resource block is shown by its type.
            let content = &update["content"];
            let text = match content["type"].as_str() {
                Some("text") => content["text"].as_str().unwrap_or_default().to_owned(),
                Some(other) => format!("[{other}]"),
                None => return,
            };
            let thought = kind == "agent_thought_chunk";
            let message = update["messageId"].as_str().unwrap_or("message");
            let id = format!("{turn}:{}:{message}", if thought { "thought" } else { "message" });
            match items.iter_mut().find(|item| item["id"] == id.as_str()) {
                // Chunks of one message are one Item (§3.4).
                Some(item) if thought => {
                    let joined = format!("{}{text}", item["summary"][0].as_str().unwrap_or_default());
                    item["summary"] = json!([joined]);
                }
                Some(item) => {
                    let joined = format!("{}{text}", item["text"].as_str().unwrap_or_default());
                    item["text"] = joined.into();
                }
                None if thought => items.push(json!({"id": id, "type": "reasoning", "summary": [text]})),
                None => items.push(json!({"id": id, "type": "agentMessage", "text": text})),
            }
        }
        "tool_call" | "tool_call_update" => {
            let Some(call) = update["toolCallId"].as_str() else { return };
            let id = format!("{turn}:tool:{call}");
            let index = match items.iter().position(|item| item["id"] == id.as_str()) {
                Some(index) => index,
                None => {
                    items.push(tool_item(&id, call, update));
                    items.len() - 1
                }
            };
            tool_update(&mut items[index], update);
        }
        // Plans, commands, modes and the session's own notes change no Item.
        _ => {}
    }
}

/// dsh took the Turn's prompt (an update for it, or its answer): its user
/// message carries the client ID it was sent under, as a Codex, Claude or
/// OpenCode one does once delivered, which binds its receipt (T-120). A
/// prompt dsh refused, or never answered, gets none.
fn delivered(d: &mut AgentDetail, turn: &str) {
    let input = format!("{turn}:input");
    let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn) else { return };
    let Some(client) = entry["_dshClient"].as_str().map(str::to_owned) else { return };
    if let Some(item) = entry["items"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["id"] == input.as_str())) {
        if item["clientId"].is_null() {
            item["clientId"] = client.into();
        }
    }
}

/// The card of a request past the sandbox (§3.6), in the shape the web's
/// approval card reads (`command`, `reason`, `cwd`, `availableDecisions`):
/// the command, its sandbox permissions and why, from the request's own tool
/// call when it carries them, else from the call dsh started before it.
fn asked(d: &AgentDetail, turn: Option<&str>, generation: u64, cwd: &str, message: &Value) -> PendingRequest {
    let params = &message["params"];
    let call = params["toolCall"]["toolCallId"].as_str().unwrap_or_default();
    let item = turn.and_then(|turn| d.turns.iter().find(|t| t["id"] == turn))
        .and_then(|t| t["items"].as_array()).and_then(|items| items.iter().find(|i| i["callId"] == call));
    let own = &params["toolCall"]["rawInput"];
    let input = if own.is_object() { own.clone() } else { item.map_or(Value::Null, |i| i["_dshInput"].clone()) };
    let command = match command_of(&input) {
        Value::Null => item.map_or(Value::Null, |i| i["command"].clone()),
        command => command,
    };
    let tool = params["toolCall"]["title"].as_str().or_else(|| item.and_then(|i| i["name"].as_str()));
    let mut card = json!({
        "toolCallId": call, "command": command, "reason": input["justification"], "sandboxPermissions": input["sandbox_permissions"],
        "tool": tool, "input": input, "cwd": cwd, "options": params["options"], "availableDecisions": DECISIONS,
        "_dshRequest": message["id"], "_runtimeGeneration": generation, "_responseSent": false,
    });
    if let Some(turn) = turn {
        card["turnId"] = turn.into();
    }
    PendingRequest { id: uuid::Uuid::new_v4().to_string(), agent_id: d.agent.id.clone(), method: PERMISSION.into(), params: card, created_at: now(), stale: false }
}

/// What refuses a request (§3.6): its reject-once option, else, when dsh
/// offers none, the request cancelled.
fn refusal(options: &Value) -> Value {
    match options.as_array().into_iter().flatten().find(|o| o["kind"] == "reject_once").and_then(|o| o["optionId"].as_str()) {
        Some(option) => json!({"outcome": {"outcome": "selected", "optionId": option}}),
        None => json!({"outcome": {"outcome": "cancelled"}}),
    }
}

/// The Item of tool call `call` in `turn`.
fn tool_item_of<'a>(d: &'a mut AgentDetail, turn: &str, call: &str) -> Option<&'a mut Value> {
    let id = format!("{turn}:tool:{call}");
    d.turns.iter_mut().find(|t| t["id"] == turn).and_then(|t| t["items"].as_array_mut())
        .and_then(|items| items.iter_mut().find(|i| i["id"] == id.as_str()))
}

/// ACP's `mcpServers` for the Workspace MCP (§3.7): an http server whose
/// credential is a header, from `collaboration_http_config`.
fn mcp_servers(config: &Value) -> Value {
    let headers: Vec<Value> = config["headers"].as_object().into_iter().flatten()
        .map(|(name, value)| json!({"name": name, "value": value})).collect();
    json!([{"type": "http", "name": "yuzuno", "url": config["url"], "headers": headers}])
}

/// A tool call's Item as dsh starts it (§3.4): `bash` a command, `mcp__<server>__<tool>`
/// an MCP call, any other the tool's name with its input and output as dsh gives them.
fn tool_item(id: &str, call: &str, update: &Value) -> Value {
    let name = update["title"].as_str().unwrap_or("tool");
    if let Some((server, tool)) = name.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
        json!({"id": id, "type": "mcpToolCall", "callId": call, "server": server, "tool": tool, "arguments": update["rawInput"],
            "result": null, "status": "inProgress"})
    } else if name == "bash" || update["kind"] == "execute" {
        json!({"id": id, "type": "commandExecution", "callId": call, "command": command_of(&update["rawInput"]), "aggregatedOutput": "",
            "exitCode": null, "status": "inProgress", "_dshInput": update["rawInput"]})
    } else {
        json!({"id": id, "type": "dshTool", "callId": call, "name": name, "kind": update["kind"], "input": update["rawInput"],
            "output": null, "status": "inProgress"})
    }
}

fn command_of(input: &Value) -> Value {
    match &input["command"] {
        Value::String(command) => command.clone().into(),
        Value::Array(parts) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ").into(),
        _ => Value::Null,
    }
}

/// What a `tool_call` or `tool_call_update` says of its call: its status
/// (ACP pending, in_progress, completed, failed), its input once known, its output.
fn tool_update(item: &mut Value, update: &Value) {
    if let Some(status) = update["status"].as_str() {
        item["status"] = match status {
            "completed" => "completed",
            "failed" => "failed",
            _ => "inProgress",
        }.into();
    }
    if !update["rawInput"].is_null() {
        match item["type"].as_str() {
            Some("commandExecution") => {
                item["command"] = command_of(&update["rawInput"]);
                item["_dshInput"] = update["rawInput"].clone();
            }
            Some("mcpToolCall") => item["arguments"] = update["rawInput"].clone(),
            _ => item["input"] = update["rawInput"].clone(),
        }
    }
    let output = output_of(update);
    if output.is_null() {
        return;
    }
    match item["type"].as_str() {
        Some("commandExecution") => {
            item["aggregatedOutput"] = match &output {
                Value::String(text) => text.clone().into(),
                other => other["stdout"].as_str().or_else(|| other["output"].as_str()).map_or_else(|| other.to_string(), str::to_owned).into(),
            };
            if let Some(code) = output["exitCode"].as_i64().or_else(|| output["exit_code"].as_i64()) {
                item["exitCode"] = code.into();
            }
        }
        Some("mcpToolCall") if item["status"] == "failed" => item["error"] = json!({"message": output}),
        Some("mcpToolCall") => item["result"] = output,
        _ => item["output"] = output,
    }
}

/// A call's output: its `rawOutput`, else the text of its `content`.
fn output_of(update: &Value) -> Value {
    if !update["rawOutput"].is_null() {
        return update["rawOutput"].clone();
    }
    let texts: Vec<&str> = update["content"].as_array().into_iter().flatten()
        .filter_map(|block| block["content"]["text"].as_str().or_else(|| block["text"].as_str())).collect();
    if texts.is_empty() { Value::Null } else { texts.join("\n").into() }
}

/// The value of configuration option `id` that names `wanted` (§3.9): one of
/// its values, or a value whose last part is `wanted` (dsh's model values are
/// `["<provider>","<model>"]`, a model being chosen by its name too).
fn option_value(options: &Value, id: &str, wanted: &str) -> Option<String> {
    fn values<'a>(choices: &'a Value, out: &mut Vec<&'a str>) {
        for choice in choices.as_array().into_iter().flatten() {
            match choice["value"].as_str() {
                Some(value) => out.push(value),
                None => values(&choice["options"], out),
            }
        }
    }
    let option = options.as_array()?.iter().find(|option| option["id"] == id)?;
    let mut found = Vec::new();
    values(&option["options"], &mut found);
    let named = |value: &str| serde_json::from_str::<Vec<String>>(value).ok().and_then(|parts| parts.last().cloned()).is_some_and(|last| last == wanted);
    found.iter().find(|value| **value == wanted).or_else(|| found.iter().find(|value| named(value))).map(|value| (*value).to_owned())
}

/// The models option `options` offers as model rows (`/api/models`, §3.9):
/// each by its name, the last part of dsh's `["<provider>","<model>"]` value
/// (what an Agent keeps and `option_value` takes again), else by that value
/// where a name is not one model's alone; the session's current one is the
/// default.
pub(crate) fn model_rows(options: &Value) -> Vec<Value> {
    fn choices<'a>(list: &'a Value, group: Option<&'a str>, out: &mut Vec<(&'a Value, Option<&'a str>)>) {
        for choice in list.as_array().into_iter().flatten() {
            if choice["value"].is_string() {
                out.push((choice, group));
            } else {
                choices(&choice["options"], choice["name"].as_str().or(group), out);
            }
        }
    }
    let Some(option) = options.as_array().and_then(|options| options.iter().find(|o| o["id"] == "model")) else { return Vec::new() };
    let mut found = Vec::new();
    choices(&option["options"], None, &mut found);
    let short = |value: &str| serde_json::from_str::<Vec<String>>(value).ok().and_then(|parts| parts.last().cloned());
    let names: Vec<Option<String>> = found.iter().map(|(choice, _)| choice["value"].as_str().and_then(short)).collect();
    found.iter().zip(&names).map(|((choice, group), name)| {
        let value = choice["value"].as_str().unwrap_or_default();
        let alone = name.as_ref().filter(|name| names.iter().filter(|other| other.as_ref() == Some(*name)).count() == 1);
        let id = alone.cloned().unwrap_or_else(|| value.to_owned());
        json!({"id": id, "model": id, "displayName": choice["name"].as_str().unwrap_or(&id), "description": choice["description"],
            "isDefault": option["currentValue"] == choice["value"], "provider": group, "value": value})
    }).collect()
}

/// dsh's models for a new Agent (§3.9): a dsh of Core's own in a new folder
/// of `<data>/dsh-catalog`, with a placeholder key, through initialize (the
/// five start checks) and `session/new`; then stopped, and its folder removed.
async fn catalog_read(data: &Path, program: PathBuf, endpoint: Option<String>) -> Result<Value> {
    let folder = data.join("dsh-catalog").join(uuid::Uuid::new_v4().to_string());
    let directory = folder.join("work");
    let read = async {
        std::fs::create_dir_all(&directory)?;
        let launch = dsh::Launch {
            program, folder: folder.clone(), directory: directory.clone(), access: Level::Ask.access(), writable: Vec::new(),
            instructions: String::new(), key: Some(crate::routing_keys::Secret::new(CATALOG_KEY.into())), endpoint,
        };
        // What it says as the session opens is read by nobody.
        let (tx, _rx) = mpsc::channel(256);
        let dsh = Dsh::start(&launch, EventSender::observed(tx, Arc::new(Backlog::default()))).await?;
        let answer = dsh.request("session/new", json!({"cwd": directory, "mcpServers": []}), SESSION_LIMIT).await;
        let _ = dsh.shutdown().await;
        let answer = answer?;
        dsh::check_session(&answer)?;
        Ok(json!({"models": model_rows(&answer["configOptions"]), "version": dsh.version().to_string()}))
    };
    let result = read.await;
    let _ = std::fs::remove_dir_all(&folder);
    result
}

// ---------------------------------------------------------------- the Agent's folder

/// Removes `<data>/dsh/<agent>` (§3.8), Core's own folder of the Agent, once
/// its dsh has stopped. Only that folder: `<data>/dsh` must be a folder of
/// the data folder itself, not a link elsewhere, and what is at the Agent's
/// name is removed as what it is, a link alone and never what it names.
pub(crate) fn remove_folder(data: &Path, agent: &str) -> Result<()> {
    let folder = dsh::folder(data, agent)?;
    let parent = folder.parent().context("The dsh folder has no parent")?;
    match std::fs::symlink_metadata(parent) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(meta) => ensure!(meta.is_dir() && !meta.file_type().is_symlink(), "{} is not Core's own folder", parent.display()),
    }
    let (root, inside) = (std::fs::canonicalize(data)?, std::fs::canonicalize(parent)?);
    ensure!(inside == root.join("dsh"), "{} is not inside the data folder {}", inside.display(), root.display());
    match std::fs::symlink_metadata(&folder) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(meta) if meta.is_dir() => Ok(std::fs::remove_dir_all(&folder)?),
        Ok(_) => Ok(std::fs::remove_file(&folder)?),
    }
}

// ---------------------------------------------------------------- the Workspace

impl Workspace {
    /// The dsh program and model address this Core starts: `YUZUNO_DSH_BIN`
    /// (`dsh::program`), and `YUZUNO_DSH_BASE_URL`, a stand-in model for lab
    /// probes (none: dsh's own address for DeepSeek).
    fn dsh_program(&self) -> (PathBuf, Option<String>) {
        #[cfg(test)]
        if let Some(found) = self.dsh_test.lock().unwrap().clone() {
            return found;
        }
        (dsh::program(), std::env::var("YUZUNO_DSH_BASE_URL").ok().filter(|url| !url.is_empty()))
    }

    pub(crate) fn dsh_current(&self, id: &str, generation: u64) -> Option<Connection> {
        self.dshs.lock().unwrap().get(id).filter(|c| c.generation == generation).cloned()
    }

    /// A new dsh Agent on this Core host (§3.10), at `level` (Ask you first
    /// unless one is given) with the DeepSeek key `profile` names, both kept
    /// beside its record as an executor's are (`agent_permission_levels`,
    /// `agent_runtime_profiles`), where each start reads them again. An
    /// executor with `birth` gets them from its dispatch.
    #[allow(clippy::too_many_arguments)]
    pub async fn dsh_create_on(
        self: &Arc<Self>, name: String, cwd: String, model: String, effort: Option<String>,
        machine_id: Option<String>, project_id: Option<String>, birth: Option<crate::workspace::Birth>,
        level: Option<String>, profile: Option<RuntimeProfile>,
    ) -> Result<Agent> {
        let name = crate::model::agent_name(&name)?;
        let permit = if birth.is_some() { None } else { Some(self.admission.enter_work()?) };
        ensure!(machine_id.as_deref().is_none_or(|machine| machine == "local"),
            "dsh Agent 目前只在 Core 所在的本机运行。dsh Agents run on this Core host only.");
        let level = match level {
            Some(level) => level_of(&level).with_context(|| not_kept(&level))?,
            None => Level::Ask,
        };
        if let Some(effort) = &effort {
            ensure!(EFFORTS.contains(&effort.as_str()), "dsh 的推理强度是 off、low、high 或 max，不是 {effort}。dsh's reasoning effort is off, low, high or max.");
        }
        match &profile {
            Some(RuntimeProfile::ApiKey { key_id }) => {
                let (data, key) = (self.data_dir.clone(), key_id.clone());
                let keys = tokio::task::spawn_blocking(move || crate::routing_keys::Store::of(&data).keys()).await??;
                ensure!(keys.iter().any(|k| k.id == key && k.set && k.provider == crate::routing_keys::Provider::Deepseek),
                    "路由密钥 {key_id} 不是已设置的 DeepSeek 密钥。Routing key {key_id} is not a DeepSeek key that is set.");
            }
            Some(_) => bail!("dsh Agent 只用 DeepSeek 路由密钥运行。A dsh Agent runs with a DeepSeek routing key only."),
            None if birth.is_none() => bail!("{NO_KEY}"),
            None => {}
        }
        if let Some(project) = project_id.clone() {
            self.stored(move |store| store.ensure_project_assignable(&project)).await?;
        }
        let cwd = std::fs::canonicalize(cwd).context("工作目录不存在或无法读取")?;
        ensure!(cwd.is_dir(), "工作目录必须是文件夹");
        let (id, then) = crate::workspace::Birth::of(birth);
        let colors = ["yuzu", "sage", "rose", "sky"];
        let count = self.stored(|store| store.agents()).await?.len();
        let settings = crate::model::AgentSettings { reasoning_effort: effort, permission_level: Some(level.id().into()), ..Default::default() };
        let agent: Agent = serde_json::from_value(json!({
            "id": id, "name": name, "cwd": cwd, "model": model.trim(), "settings": settings,
            "color": colors[count % colors.len()], "harness": "dsh", "threadId": null, "status": "offline",
            "createdAt": now(), "updatedAt": now(), "unreadCount": 0, "pendingCount": 0, "lastSeq": 0, "reviewedSeq": 0,
            "connectionState": "disconnected",
        }))?;
        // Kept apart from the record (`project_agents`), so never read from JSON: set as OpenCode's create sets it.
        let mut agent = agent;
        agent.project_id = project_id;
        let detail = AgentDetail {
            agent: agent.clone(), turns: vec![], history: None, pending: vec![], artifacts: vec![], context_usage: None,
            message_receipts: vec![], claude_runtime: None, codex_handoff: None, opencode_usage_seen: None,
        };
        let born = then.is_some();
        let kept = id.clone();
        self.stored(move |store| {
            store.insert_created_then(&detail, then)?;
            store.set_permission_level(&kept, Some(level.id()))?;
            if let Some(profile) = &profile {
                store.set_runtime_profile(&kept, Some(profile))?;
            }
            Ok(())
        }).await?;
        self.changed(&id);
        if born {
            return Ok(agent);
        }
        let ws = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let gate = ws.gate(&id).await;
            let _held = gate.lock().await;
            // A close or delete that won the gate first is the user's.
            if !ws.listed(&id).await.is_ok_and(|agent| agent.closed_at.is_none()) {
                return;
            }
            if let Err(error) = ws.dsh_ensure(&id).await {
                ws.failed(&id, &error).await;
            }
        });
        Ok(agent)
    }

    /// Called under the Agent gate (`reconnect_gated`): a dsh Agent's
    /// reconnect steps, its live dsh or a new one resuming its session; a
    /// failed start is recorded as its failure.
    pub(crate) async fn dsh_reattach(self: &Arc<Self>, id: &str) -> Result<()> {
        ensure_agent_open(&self.listed(id).await?)?;
        if let Err(error) = self.dsh_ensure(id).await {
            self.failed(id, &error).await;
            return Err(error);
        }
        Ok(())
    }

    /// Under the Agent gate: the live connection, or a new dsh for the
    /// Agent's session (made by its first start).
    pub(crate) async fn dsh_ensure(self: &Arc<Self>, id: &str) -> Result<Connection> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        crate::model::ensure_not_disconnected(&d.agent)?;
        if let Some(c) = self.dshs.lock().unwrap().get(id).cloned() {
            return Ok(c);
        }
        ensure!(d.agent.remote.is_none(), "dsh Agent 目前只在 Core 所在的本机运行。dsh Agents run on this Core host only.");
        // An executor waiting for a slot starts only from the queue (T-35).
        self.executor_slot_admits(id).await?;
        self.record_meta(id, "dsh/connecting", json!({}), |m| m.agent.connection_state = "connecting".into()).await?;
        self.changed(id);
        match self.dsh_connect(id, &d).await {
            Ok(c) => Ok(c),
            Err(error) => {
                let message = format!("{error:#}");
                self.record_meta(id, "dsh/connectFailed", json!({"error": message}), |m| m.agent.connection_state = "disconnected".into()).await?;
                self.changed(id);
                Err(error)
            }
        }
    }

    /// A new dsh for the Agent (§3.1, §3.8): its level and key read again,
    /// the five start checks (§3.3; the fifth here), its model and effort set.
    /// Until it is in `dshs`, this is its only owner: an error drops it, which
    /// ends its process group.
    async fn dsh_connect(self: &Arc<Self>, id: &str, d: &AgentDetail) -> Result<Connection> {
        let (program, endpoint) = self.dsh_program();
        let level = { let agent = id.to_owned(); self.stored(move |store| store.permission_level(&agent)).await? };
        let level = match level.as_deref() {
            None => Level::Ask,
            Some(level) => level_of(level).with_context(|| not_kept(level))?,
        };
        let key = self.dsh_launch(id).await?;
        // The Workspace MCP and what goes with it (§3.1, §3.7), as Claude's start has them.
        let (servers, instructions) = match self.collaboration_http_config(&d.agent).await? {
            Some(config) => {
                let mut instructions = crate::guide::session_notice().to_owned();
                if let Some(rules) = crate::brief_turns::start_hard_rules(self, id).await? {
                    instructions = format!("{instructions}\n\n{rules}");
                }
                (mcp_servers(&config), instructions)
            }
            None => (json!([]), String::new()),
        };
        let attached = servers.as_array().is_some_and(|servers| !servers.is_empty());
        let directory = PathBuf::from(&d.agent.cwd);
        let launch = dsh::Launch {
            program,
            folder: dsh::folder(&self.data_dir, id)?,
            writable: dsh::writable_roots(&directory).await,
            directory,
            access: level.access(),
            instructions,
            key: Some(key),
            endpoint,
        };
        let (tx, rx) = mpsc::channel(256);
        let backlog = Arc::new(Backlog::default());
        let events = EventSender::observed(tx, backlog.clone());
        let dsh = Arc::new(Dsh::start(&launch, events.clone()).await?);
        let opened = match &d.agent.dsh_session_id {
            Some(session) => dsh.request("session/resume", json!({"sessionId": session, "cwd": d.agent.cwd, "mcpServers": servers}), SESSION_LIMIT).await,
            None => dsh.request("session/new", json!({"cwd": d.agent.cwd, "mcpServers": servers}), SESSION_LIMIT).await,
        };
        let answer = opened.context("dsh start check 5 of 5 (its session)")?;
        dsh::check_session(&answer).context("dsh start check 5 of 5 (its session)")?;
        let session = match &d.agent.dsh_session_id {
            Some(session) => session.clone(),
            None => answer["sessionId"].as_str().filter(|s| !s.is_empty()).context("dsh's session/new named no session")?.to_owned(),
        };
        // The Agent's model and effort, set again at each start (§3.8, §3.9).
        let mut options = answer["configOptions"].clone();
        let effort = d.agent.settings.reasoning_effort.clone().unwrap_or_default();
        for (option, wanted) in [("model", d.agent.model.as_str()), ("reasoning_effort", effort.as_str())] {
            if wanted.is_empty() {
                continue;
            }
            let value = option_value(&options, option, wanted)
                .with_context(|| format!("dsh 不提供 {option}「{wanted}」，请重新选择。dsh offers no {option} {wanted}: choose another."))?;
            let set = dsh.request("session/set_config_option", json!({"sessionId": session, "configId": option, "value": value}), SESSION_LIMIT).await
                .with_context(|| format!("dsh did not take {option} {wanted}"))?;
            if set["configOptions"].is_array() {
                options = set["configOptions"].clone();
            }
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let images = dsh.initialized()["agentCapabilities"]["promptCapabilities"]["image"] == true;
        let c = Connection { generation, dsh: dsh.clone(), session: session.clone(), level, options: Arc::new(Mutex::new(options)), images, events,
            prompt: Arc::default(), native: Arc::default() };
        let owned = self.owner(id).await;
        self.dshs.lock().unwrap().insert(id.into(), c.clone());
        self.backlogs.track(id, generation, backlog.clone());
        let (agent, version, standing) = (id.to_owned(), dsh.version().to_string(), dsh.standing());
        let data = json!({"sessionId": session, "generation": generation, "version": version, "standing": standing.label(),
            "note": standing.note(), "resumed": d.agent.dsh_session_id.is_some(), "level": level.id(), "pid": dsh.pid()});
        let ready = self.stored_owned(owned, move |store| store.record_event(&agent, "dsh/ready", &data, Sel::Open, move |d| {
            d.agent.dsh_session_id = Some(session);
            d.agent.dsh_version = Some(version);
            d.agent.connection_state = "connected".into();
            d.agent.status = "idle".into();
            d.agent.error = None;
            ended(d, RESTARTED);
            d.pending.clear();
        }).map(drop)).await;
        if let Err(error) = ready {
            let _owned = self.owner(id).await;
            let mut connections = self.dshs.lock().unwrap();
            if connections.get(id).is_some_and(|c| c.generation == generation) {
                connections.remove(id);
            }
            return Err(error);
        }
        self.dsh_watch(id, generation, rx, backlog);
        // dsh took the session with the Workspace MCP named: ready, as a Claude start is.
        if attached {
            self.collaboration_started(id, generation).await;
        }
        self.changed(id);
        Ok(c)
    }

    /// The connection's event queue, read in order until it ends. It holds
    /// no Workspace, so dropping the Workspace ends dsh and then this.
    fn dsh_watch(self: &Arc<Self>, id: &str, generation: u64, mut rx: mpsc::Receiver<Value>, backlog: Arc<Backlog>) {
        let (ws, id) = (Arc::downgrade(self), id.to_owned());
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let Some(ws) = ws.upgrade() else { break };
                ws.dsh_event(&id, generation, message).await;
                backlog.applied();
            }
        });
    }

    async fn dsh_event(self: &Arc<Self>, id: &str, generation: u64, message: Value) {
        let _event = self.admission.enter_event();
        let Some(c) = self.dsh_current(id, generation) else { return };
        match message["method"].as_str().unwrap_or_default() {
            "session/update" => self.dsh_update(id, &c, message).await,
            "session/request_permission" if c.level == Level::Ask => self.dsh_ask(id, &c, message).await,
            "session/request_permission" => self.dsh_refuse(id, &c, message).await,
            PROMPT_ENDED => self.dsh_prompt_ended(id, &c, &message["params"]).await,
            STOP_UNCONFIRMED => self.dsh_stop_unconfirmed(id, &c, &message["params"]).await,
            "yuzuno/disconnected" => {
                let reason = message["params"]["message"].as_str().unwrap_or("dsh has ended").to_owned();
                self.dsh_disconnected(id, generation, &reason).await;
            }
            // A request Core does not serve: it offered dsh no file system or
            // terminal. Answered as dsh answers a method it does not know.
            _ => {
                if let Some(request) = message.get("id").filter(|id| !id.is_null()) {
                    let _ = c.dsh.respond_error(request.clone(), -32601, "Method not found").await;
                }
            }
        }
    }

    /// One `session/update`, journaled as dsh sent it and read into the Turn
    /// its open prompt runs, else into the connection's native Turn.
    async fn dsh_update(&self, id: &str, c: &Connection, mut message: Value) {
        let shown = itemized(&message["params"]["update"]);
        let (turn, native) = match c.prompt.lock().unwrap().clone() {
            Some(turn) => (Some(turn), false),
            None if shown => (Some(c.native.lock().unwrap().get_or_insert_with(|| format!("native-{}", uuid::Uuid::new_v4())).clone()), true),
            // Nothing of a Turn: journaled, and the context it may report kept.
            None => (None, false),
        };
        let owned = self.owner(id).await;
        if self.dsh_current(id, c.generation).is_none() {
            return;
        }
        let (agent, params) = (id.to_owned(), message["params"].take());
        let update = params["update"].clone();
        let sel = turn.clone().map_or(Sel::Open, |turn| Sel::Turns(vec![turn]));
        let written = self.stored_owned(owned, move |store| store.record_event(&agent, "dsh/update", &params, sel, move |d| {
            let at = chrono::Utc::now();
            apply(d, turn.as_deref(), &update, at);
            if let (true, Some(turn)) = (native, &turn) {
                let entry = d.turn_at(turn, at);
                entry["status"] = "completed".into();
                entry["_dshNative"] = true.into();
                crate::conversation_time::mark_turn_completed(entry, at.timestamp_millis());
            }
        }).map(drop)).await;
        if let Err(error) = written {
            eprintln!("Workspace dsh update not recorded: {error:#}");
        }
        self.changed(id);
    }

    /// A request past dsh's sandbox at Ask you first (§3.6): a card of the
    /// command dsh's tool call gave, its sandbox permissions and why, for the
    /// user to allow once or refuse (`dsh_respond`). Journaled as a request,
    /// as Claude's is.
    async fn dsh_ask(&self, id: &str, c: &Connection, message: Value) {
        let turn = c.prompt.lock().unwrap().clone();
        let (generation, cwd) = (c.generation, self.listed(id).await.map(|a| a.cwd).unwrap_or_default());
        let held = turn.clone().map_or_else(Vec::new, |turn| vec![turn]);
        let kept = message.clone();
        let written = self.record_update(id, "request", message.clone(), Sel::Turns(held), move |d| {
            let request = asked(d, turn.as_deref(), generation, &cwd, &kept);
            if !d.pending.iter().any(|p| !p.stale && p.params["_dshRequest"] == kept["id"] && p.params["_runtimeGeneration"] == generation) {
                d.pending.push(request);
            }
            refresh_status(d);
        }).await;
        if let Err(error) = written {
            // Not kept, so nobody could answer it: refused, as at Auto-approve.
            eprintln!("Workspace dsh request not recorded, refused: {error:#}");
            let reject = refusal(&message["params"]["options"]);
            let _ = c.dsh.respond(message["id"].clone(), reject).await;
        }
        self.changed(id);
    }

    /// A request past dsh's sandbox, refused by Core (§3.6): at Auto-approve,
    /// reject-once, else, when dsh offers no such option, the request
    /// cancelled. The answer goes first, whatever becomes of its record:
    /// nothing is ever allowed.
    async fn dsh_refuse(&self, id: &str, c: &Connection, message: Value) {
        let params = &message["params"];
        let outcome = refusal(&params["options"]);
        let sent = c.dsh.respond(message["id"].clone(), outcome.clone()).await;
        let call = params["toolCall"]["toolCallId"].as_str().unwrap_or_default().to_owned();
        let turn = c.prompt.lock().unwrap().clone();
        let data = json!({"toolCallId": call, "answer": outcome, "sent": sent.is_ok()});
        let refused = turn.clone().map_or_else(Vec::new, |turn| vec![turn]);
        let written = self.record_update(id, "dsh/requestRefused", data, Sel::Turns(refused), move |d| {
            let Some(turn) = turn else { return };
            let id = format!("{turn}:tool:{call}");
            if let Some(item) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str())
                .and_then(|t| t["items"].as_array_mut()).and_then(|items| items.iter_mut().find(|i| i["id"] == id.as_str())) {
                item["permission"] = json!({"answer": "refused", "by": "core"});
            }
        }).await;
        if let Err(error) = written {
            eprintln!("Workspace dsh refusal not recorded: {error:#}");
        }
        self.changed(id);
    }

    async fn dsh_prompt_ended(&self, id: &str, c: &Connection, params: &Value) {
        let Some(turn) = params["turnId"].as_str().map(str::to_owned) else { return };
        {
            let mut prompt = c.prompt.lock().unwrap();
            if prompt.as_deref() == Some(turn.as_str()) {
                *prompt = None;
            }
        }
        // dsh ended before it answered: its disconnect, next in the queue, settles the Turn.
        if !params["unknown"].is_null() {
            return;
        }
        let (status, error) = end_of(params);
        let owned = self.owner(id).await;
        if self.dsh_current(id, c.generation).is_none() {
            return;
        }
        let (agent, data, stop) = (id.to_owned(), params.clone(), params["stopReason"].clone());
        let (named, picked) = (vec![turn.clone()], turn.clone());
        let end = move |d: &mut AgentDetail| {
            // What it asked can no longer be answered.
            d.pending.retain(|p| p.params["turnId"] != turn.as_str());
            // Its own end, or one an unanswered interrupt left unknown.
            let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str() && matches!(t["status"].as_str(), Some("inProgress" | "outcomeUnknown"))) else {
                refresh_status(d);
                return;
            };
            let answered = !stop.is_null();
            entry["status"] = status.into();
            match error {
                Some(message) => entry["error"] = json!({"message": message}),
                None => if let Some(fields) = entry.as_object_mut() { fields.remove("error"); },
            }
            if !stop.is_null() {
                entry["stopReason"] = stop;
            }
            settle_tools(entry);
            crate::conversation_time::mark_turn_completed(entry, chrono::Utc::now().timestamp_millis());
            if answered {
                delivered(d, &turn);
            }
            refresh_status(d);
        };
        // Its end as the record has it, when it is one a completion is journaled for.
        let completion = move |d: &AgentDetail, _: Option<String>| d.turns.iter().find(|t| t["id"] == picked.as_str())
            .filter(|t| matches!(t["status"].as_str(), Some("completed" | "failed" | "interrupted")))
            .map(|t| json!({"id": t["id"], "status": t["status"]}));
        let written = self.stored_owned(owned, move |store| {
            let (_, ended) = store.change(&agent, "dsh/turnEnded", &data, Sel::Turns(named), end, completion)?;
            // Read state and the Brief check (brief_turns), once per Turn, as Claude's.
            if let Some(turn) = ended {
                store.record_recovered_completion(&agent, &turn)?;
            }
            Ok(())
        }).await;
        if let Err(error) = written {
            eprintln!("Workspace dsh Turn end not recorded: {error:#}");
        }
        self.changed(id);
    }

    /// An interrupt dsh has not answered within STOP_LIMIT (§3.5): its Turn's
    /// end is unknown, and that dsh is ended (`dsh_end_unanswered`): kept, it
    /// would take no prompt again, since ACP's next one waits for this one's
    /// answer (R1 9c3aa8f5). An answer that comes first still ends the Turn.
    async fn dsh_stop_unconfirmed(self: &Arc<Self>, id: &str, c: &Connection, params: &Value) {
        let Some(turn) = params["turnId"].as_str().map(str::to_owned) else { return };
        if c.prompt.lock().unwrap().as_deref() != Some(turn.as_str()) {
            return;
        }
        let secs = STOP_LIMIT.as_secs();
        let message = format!("dsh 在 {secs} 秒内没有确认中断；这一轮的结果未确认，不会重发。dsh did not confirm the interrupt within {secs} s; this Turn's end is unknown.");
        let unknown_turn = turn.clone();
        let written = self.record_update(id, "dsh/stopUnconfirmed", params.clone(), Sel::Turns(vec![turn.clone()]), move |d| {
            let turn = unknown_turn;
            if let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str() && t["status"] == "inProgress") {
                unknown(entry, &message);
            }
            refresh_status(d);
        }).await;
        if let Err(error) = written {
            eprintln!("Workspace dsh interrupt not recorded: {error:#}");
        }
        self.changed(id);
        // Under the Agent gate, which an event never waits for (lock order 1 on Workspace).
        let (ws, id, generation) = (self.clone(), id.to_owned(), c.generation);
        tokio::spawn(async move {
            let _event = ws.admission.enter_event();
            let gate = ws.gate(&id).await;
            let _held = gate.lock().await;
            ws.dsh_end_unanswered(&id, generation, &turn).await;
        });
    }

    /// Under the Agent gate: connection `generation`, whose prompt `turn` did
    /// not answer an interrupt, removed and its dsh stopped as a close stops
    /// it (its group with it), and only then the Agent offline, so that no new
    /// dsh resumes the session while this one still runs. Nothing is sent again.
    async fn dsh_end_unanswered(&self, id: &str, generation: u64, turn: &str) {
        let removed = {
            let _owned = self.owner(id).await;
            let mut connections = self.dshs.lock().unwrap();
            // Answered meanwhile, closed or replaced: nothing to end.
            let unanswered = connections.get(id)
                .is_some_and(|c| c.generation == generation && c.prompt.lock().unwrap().as_deref() == Some(turn));
            if unanswered { connections.remove(id) } else { None }
        };
        let Some(c) = removed else { return };
        let ending = match c.dsh.shutdown().await {
            Ok((ending, _)) => format!("{ending:?}"),
            Err(error) => format!("{error:#}"),
        };
        let secs = STOP_LIMIT.as_secs();
        let message = format!("dsh 在 {secs} 秒内没有确认中断，Core 已结束这个 dsh；执行完成情况未获确认，不会重发。下一条消息或重连会在新的 dsh 里恢复同一会话。\
            dsh did not confirm the interrupt within {secs} s and was stopped; what it ran is unconfirmed and is not sent again. \
            The next message or a reconnect resumes the session in a new dsh.");
        let data = json!({"turnId": turn, "generation": generation, "ending": ending});
        let written = self.record_update(id, "dsh/endedUnanswered", data, Sel::Open, move |d| {
            ended(d, &message);
            d.agent.connection_state = "disconnected".into();
            d.agent.status = "offline".into();
            d.agent.error = Some(message);
        }).await;
        if let Err(error) = written {
            eprintln!("Workspace dsh end not recorded: {error:#}");
        }
        self.changed(id);
    }

    async fn dsh_disconnected(&self, id: &str, generation: u64, reason: &str) {
        let owned = self.owner(id).await;
        let removed = {
            let mut connections = self.dshs.lock().unwrap();
            if connections.get(id).is_some_and(|c| c.generation == generation) { connections.remove(id) } else { None }
        };
        // Dropped once this ends, which ends its process group.
        let Some(c) = removed else { return };
        // What stays in its group ended, so that its stderr ends and its last words can be quoted.
        let _ = c.dsh.shutdown_within(Duration::from_millis(500)).await;
        let said = c.dsh.last_words().await;
        let said = if said.is_empty() { said } else { format!("; dsh said: {said}") };
        let message = format!("dsh 连接已结束（{reason}{said}）；执行完成情况未获确认，不会重发。重连会恢复同一会话。dsh ended; what it ran is unconfirmed and is not sent again.");
        let (agent, data) = (id.to_owned(), json!({"error": message, "generation": generation}));
        let _ = self.stored_owned(owned, move |store| store.record_event(&agent, "runtime/error", &data, Sel::Open, move |d| {
            let busy = d.turns.iter().any(|t| t["status"] == "inProgress");
            ended(d, &message);
            d.agent.connection_state = "disconnected".into();
            d.agent.status = if busy { "uncertain" } else { "offline" }.into();
            d.agent.error = Some(message);
        }).map(drop)).await;
        self.changed(id);
    }

    /// Whether this dsh Agent's running dsh takes images in a prompt, as its
    /// initialize said (§3.9); none while no dsh runs for it (YN-173: a
    /// hand-off to it goes on without them, project_requests.rs).
    pub(crate) fn dsh_takes_images(&self, id: &str) -> Option<bool> {
        self.dshs.lock().unwrap().get(id).map(|c| c.images)
    }

    /// Before a receipt is recorded (send_message): what a dsh Agent takes is
    /// a new message while it is idle; a form's answers are one too.
    pub(crate) async fn dsh_admit(self: &Arc<Self>, id: &str, input: &MessageInput, detail: &AgentDetail) -> Result<()> {
        ensure!(input.expected_turn_id.is_none(), BUSY);
        ensure!(input.question.is_none(), "dsh Agent 只接受新消息；草稿保留。A dsh Agent takes new messages only; the draft is kept.");
        ensure!(!busy(detail), BUSY);
        let c = self.dsh_ensure(id).await?;
        // Refused before a receipt is made, as OpenCode's model that reads none is.
        ensure!(input.images.is_empty() || c.images, NO_IMAGES);
        self.require_collaboration(id).await
    }

    /// `send` for a dsh Agent.
    pub(crate) async fn dsh_send(self: &Arc<Self>, id: &str, text: String) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        if text.trim().is_empty() || text.len() > 100_000 {
            bail!("消息不能为空，且不能超过 100 KB");
        }
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let d = self.send_view(id).await?;
        if d.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")) {
            bail!("上一条消息的发送结果尚未确认，请先重连核对；不会自动重复发送");
        }
        self.dsh_send_locked(id, text, None, &[]).await
    }

    /// Under the Agent gate: one new prompt while dsh is idle (§3.4), its Turn
    /// recorded before it is sent. Ok once it is sent; dsh's answer ends it.
    pub(crate) async fn dsh_send_locked(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>, images: &[String]) -> Result<Value> {
        self.ensure_rewind_settled(id).await?;
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        ensure!(!busy(&d), BUSY);
        let c = self.dsh_ensure(id).await?;
        ensure!(c.prompt.lock().unwrap().is_none(), BUSY);
        ensure!(self.dsh_current(id, c.generation).is_some(), "dsh 连接已变化，消息未发送；草稿保留");
        // Its images (§3.9), each this Agent's own and as it was saved, read off the async workers:
        // what dsh is given, and what the conversation shows.
        let (blocks, shown) = if images.is_empty() { (Vec::new(), Vec::new()) } else {
            ensure!(c.images, NO_IMAGES);
            let (root, agent, images) = (self.data_dir.clone(), id.to_owned(), images.to_vec());
            tokio::task::spawn_blocking(move || anyhow::Ok((crate::input_images::dsh_images(&root, &agent, &images)?,
                crate::input_images::history_images(&root, &agent, &images)))).await??
        };
        let turn = uuid::Uuid::new_v4().to_string();
        let (requested, client, words) = (turn.clone(), client_id.map(str::to_owned), text.clone());
        self.record_update(id, "dsh/turnRequested", json!({"turnId": turn, "clientMessageId": client_id, "text": text, "images": images}),
            Sel::Turns(vec![turn.clone()]), move |d| {
            let entry = d.turn_mut(&requested);
            entry["status"] = "inProgress".into();
            if let Some(client) = &client {
                entry["_dshClient"] = client.clone().into();
            }
            let mut content = vec![json!({"type": "text", "text": words})];
            content.extend(shown);
            entry["items"] = json!([{"id": format!("{requested}:input"), "type": "userMessage", "content": content}]);
            let started = entry["_yuzunoStartedAt"].as_i64();
            crate::conversation_time::stamp_message(&mut entry["items"][0], started, "core");
            if let Some(receipt) = client.and_then(|client| d.message_receipts.iter_mut().find(|r| r.input.client_message_id == client)) {
                receipt.turn_id = Some(requested.clone());
            }
            d.agent.status = "working".into();
            d.agent.error = None;
        }).await?;
        self.changed(id);
        *c.prompt.lock().unwrap() = Some(turn.clone());
        *c.native.lock().unwrap() = None;
        let mut prompt = vec![json!({"type": "text", "text": text})];
        prompt.extend(blocks);
        let call = match c.dsh.call("session/prompt", json!({"sessionId": c.session, "prompt": prompt})).await {
            Ok(call) => call,
            // Refused before it was written: dsh has ended.
            Err(error) => {
                *c.prompt.lock().unwrap() = None;
                let message = format!("消息没有发送：{error:#}");
                let (failed, said) = (turn.clone(), message.clone());
                self.record_update(id, "dsh/promptRefused", json!({"turnId": turn, "error": message}), Sel::Turns(vec![turn.clone()]), move |d| {
                    if let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == failed.as_str()) {
                        entry["status"] = "failed".into();
                        entry["error"] = json!({"message": said});
                    }
                    refresh_status(d);
                }).await?;
                self.changed(id);
                bail!(message);
            }
        };
        // Its answer ends the Turn, after every update dsh sent before it.
        let (events, ended) = (c.events.clone(), turn.clone());
        tokio::spawn(async move {
            let params = match call.answer().await {
                Ok(answer) => json!({"turnId": ended, "stopReason": answer["stopReason"]}),
                Err(error) => match error.downcast_ref::<RpcError>() {
                    Some(refused) => json!({"turnId": ended, "error": {"code": refused.code, "message": refused.message}}),
                    None => json!({"turnId": ended, "unknown": format!("{error:#}")}),
                },
            };
            let _ = events.send(json!({"method": PROMPT_ENDED, "params": params})).await;
        });
        Ok(json!({"turnId": turn}))
    }

    /// The user's interrupt (§3.5): `session/cancel`. dsh's answer ends the
    /// Turn; without one within STOP_LIMIT its end is unknown.
    pub(crate) async fn dsh_interrupt(&self, id: &str) -> Result<()> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        let turn = d.turns.iter().rev().find(|t| t["status"] == "inProgress").and_then(|t| t["id"].as_str())
            .context("没有正在执行的 dsh Turn")?.to_owned();
        let c = self.dshs.lock().unwrap().get(id).cloned().context("dsh 连接已断开，无法确认中断")?;
        let requested = turn.clone();
        self.record_update(id, "dsh/interruptRequested", json!({"turnId": turn}), Sel::Turns(vec![turn.clone()]), move |d| {
            if let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == requested.as_str()) {
                entry["interruptRequested"] = true.into();
            }
        }).await?;
        self.changed(id);
        // Claimed first, so the prompt's end, which drops them, can't come between.
        let open = self.dsh_claim_requests(id, &c).await;
        let cancel = c.dsh.notify("session/cancel", json!({"sessionId": c.session})).await;
        // Answered whether or not the cancel went: a claimed request nobody else may answer is never left (#988 R1).
        self.dsh_answer_cancelled(id, &c, open).await;
        cancel?;
        let events = c.events.clone();
        tokio::spawn(async move {
            tokio::time::sleep(STOP_LIMIT).await;
            let _ = events.send(json!({"method": STOP_UNCONFIRMED, "params": {"turnId": turn}})).await;
        });
        Ok(())
    }

    /// The user's answer to a `dsh/permission` card (§3.6), under the Agent
    /// gate (`Workspace::respond`): `accept` sends dsh's allow-once option,
    /// `decline` its reject-once, only to the dsh that asked. Marked sent
    /// before it goes, so it never goes twice; one whose fate is unknown is
    /// never a button again. False: the Agent holds no such request.
    pub(crate) async fn dsh_respond(&self, id: &str, request_id: &str, response: &Value) -> Result<bool> {
        let owned = self.owner(id).await;
        let connection = self.dshs.lock().unwrap().get(id).cloned();
        let (agent, request, reply) = (id.to_owned(), request_id.to_owned(), response.clone());
        let checked = self.stored_owned(owned, move |store| {
            ensure_agent_open(&store.agent(&agent)?)?;
            let Some(p) = store.pending(&agent)?.into_iter().find(|p| p.id == request) else { return Ok(None) };
            ensure!(p.method == PERMISSION, "不是可以回答的 dsh 请求。This is no dsh request to answer.");
            ensure!(!p.stale && p.params["_responseSent"] != true, "这个请求已经回答或已失效；不会再次发送");
            let c = connection.context("dsh 连接已断开，回答没有发送")?;
            ensure!(p.params["_runtimeGeneration"] == c.generation, "这个请求属于已经结束的 dsh；不会把回答发给新的 dsh");
            let decision = reply["decision"].as_str().filter(|d| DECISIONS.contains(d))
                .context("dsh 的请求只接受 accept（允许一次）或 decline（拒绝）")?.to_owned();
            let kind = if decision == "accept" { "allow_once" } else { "reject_once" };
            let option = p.params["options"].as_array().into_iter().flatten().find(|o| o["kind"] == kind)
                .and_then(|o| o["optionId"].as_str()).map(str::to_owned)
                .with_context(|| format!("dsh 没有为这个请求提供 {kind}。dsh offers no {kind} for this request."))?;
            store.update_meta(&agent, "request/replied", &json!({"requestId": request, "decision": decision}), |m| {
                if let Some(p) = m.pending.iter_mut().find(|p| p.id == request) {
                    p.params["_responseSent"] = true.into();
                }
            })?;
            Ok(Some((p, c, decision, option)))
        }).await?;
        let Some((p, c, decision, option)) = checked else { return Ok(false) };
        let sent = c.dsh.respond(p.params["_dshRequest"].clone(), json!({"outcome": {"outcome": "selected", "optionId": option}})).await;
        let (request, turn, call) = (request_id.to_owned(), p.params["turnId"].as_str().map(str::to_owned), p.params["toolCallId"].as_str().unwrap_or_default().to_owned());
        let shown = turn.clone().map_or_else(Vec::new, |turn| vec![turn]);
        match sent {
            Ok(()) => {
                let answer = if decision == "accept" { "allowed" } else { "refused" };
                self.record_update(id, "dsh/requestAnswered", json!({"requestId": request_id, "decision": decision}), Sel::Turns(shown), move |d| {
                    d.pending.retain(|p| p.id != request);
                    if let Some(item) = turn.and_then(|turn| tool_item_of(d, &turn, &call)) {
                        item["permission"] = json!({"answer": answer, "by": "user"});
                    }
                    refresh_status(d);
                }).await?;
            }
            Err(error) => {
                let message = format!("回答没有送达 dsh，是否生效无法确认：{error:#}");
                let said = message.clone();
                self.record_update(id, "dsh/requestAnswerFailed", json!({"requestId": request_id, "error": message}), Sel::Open, move |d| {
                    if let Some(p) = d.pending.iter_mut().find(|p| p.id == request) {
                        p.stale = true;
                    }
                    d.agent.error = Some(said);
                    refresh_status(d);
                }).await?;
                self.changed(id);
                return Err(error);
            }
        }
        self.changed(id);
        Ok(true)
    }

    /// Before a `session/cancel`: the requests connection `c`'s dsh still
    /// waits on, marked sent so that nobody answers them but the cancel.
    async fn dsh_claim_requests(&self, id: &str, c: &Connection) -> Vec<PendingRequest> {
        let owned = self.owner(id).await;
        let (agent, generation) = (id.to_owned(), c.generation);
        let claimed = self.stored_owned(owned, move |store| {
            let open: Vec<PendingRequest> = store.pending(&agent)?.into_iter()
                .filter(|p| p.method == PERMISSION && !p.stale && p.params["_responseSent"] != true && p.params["_runtimeGeneration"] == generation)
                .collect();
            if !open.is_empty() {
                let ids: Vec<String> = open.iter().map(|p| p.id.clone()).collect();
                store.update_meta(&agent, "dsh/requestsCancelling", &json!({"requestIds": ids}), |m| {
                    for p in m.pending.iter_mut().filter(|p| ids.contains(&p.id)) {
                        p.params["_responseSent"] = true.into();
                    }
                })?;
            }
            Ok(open)
        }).await;
        claimed.unwrap_or_else(|error| {
            eprintln!("Workspace dsh requests not cancelled: {error:#}");
            Vec::new()
        })
    }

    /// After a `session/cancel`: each request `dsh_claim_requests` took
    /// answered `cancelled`, as ACP asks, once, and its card gone.
    async fn dsh_answer_cancelled(&self, id: &str, c: &Connection, open: Vec<PendingRequest>) {
        if open.is_empty() {
            return;
        }
        for p in &open {
            let _ = c.dsh.respond(p.params["_dshRequest"].clone(), json!({"outcome": {"outcome": "cancelled"}})).await;
        }
        let ids: Vec<String> = open.iter().map(|p| p.id.clone()).collect();
        let data = json!({"requestIds": ids});
        let written = self.record_update(id, "dsh/requestsCancelled", data, Sel::Open, move |d| {
            d.pending.retain(|p| !ids.contains(&p.id));
            refresh_status(d);
        }).await;
        if let Err(error) = written {
            eprintln!("Workspace dsh requests' cancel not recorded: {error:#}");
        }
        self.changed(id);
    }

    /// The user's model, effort and level for a dsh Agent (`POST
    /// /api/agents/:id/settings`, §3.6, §3.9), between Turns only. A model or
    /// effort its live dsh doesn't offer is refused, nothing saved; one it
    /// offers is set on its session now, then saved for each start. A level
    /// is dsh's sandbox, fixed as dsh starts: saved, then a new dsh resumes
    /// the session under it. dsh keeps a session's effort once set, so one
    /// can't go back to the provider's own.
    pub async fn dsh_settings(self: &Arc<Self>, id: &str, model: String, effort: Option<Option<String>>, level: Option<String>) -> Result<Agent> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        ensure!(d.agent.harness == "dsh", "这不是 dsh Agent。This is not a dsh Agent.");
        ensure!(!busy(&d), "dsh 一轮进行中不能改模型、推理强度或权限；请等它结束或先中断。A dsh Agent's settings change between Turns: wait for this one to end, or interrupt it.");
        let model = model.trim().to_owned();
        ensure!(!model.is_empty() || d.agent.model.is_empty(), "dsh 的模型不能留空；请选一个。Choose a model for dsh.");
        let effort = match effort {
            Some(chosen) => chosen.map(|e| e.trim().to_owned()).filter(|e| !e.is_empty()),
            None => d.agent.settings.reasoning_effort.clone(),
        };
        if let Some(effort) = &effort {
            ensure!(EFFORTS.contains(&effort.as_str()), "dsh 的推理强度是 off、low、high 或 max，不是 {effort}。dsh's reasoning effort is off, low, high or max.");
        }
        ensure!(effort.is_some() || d.agent.settings.reasoning_effort.is_none() || d.agent.dsh_session_id.is_none(),
            "dsh 的会话设过推理强度后不能回到默认；请选 off、low、high 或 max。Once set, a dsh session keeps an effort: choose off, low, high or max.");
        let level = match level {
            Some(level) => Some(level_of(&level).with_context(|| not_kept(&level))?),
            None => None,
        };
        let live = self.dshs.lock().unwrap().get(id).cloned();
        let restart = live.as_ref().is_some_and(|c| level.is_some_and(|level| level != c.level));
        if let Some(c) = live.as_ref().filter(|_| !restart) {
            let options = c.options.lock().unwrap().clone();
            let mut sets = Vec::new();
            if !model.is_empty() && model != d.agent.model {
                sets.push(("model", option_value(&options, "model", &model)
                    .with_context(|| format!("dsh 不提供模型「{model}」；设置未保存。dsh offers no model {model}: nothing was saved."))?));
            }
            if let Some(effort) = effort.as_ref().filter(|effort| Some(*effort) != d.agent.settings.reasoning_effort.as_ref()) {
                sets.push(("reasoning_effort", option_value(&options, "reasoning_effort", effort)
                    .with_context(|| format!("dsh 不提供推理强度「{effort}」；设置未保存。dsh offers no effort {effort}: nothing was saved."))?));
            }
            for (option, value) in sets {
                let set = c.dsh.request("session/set_config_option", json!({"sessionId": c.session, "configId": option, "value": value}), SESSION_LIMIT).await
                    .with_context(|| format!("dsh 没有接受 {option}；设置未保存。dsh did not take {option}: nothing was saved."))?;
                if set["configOptions"].is_array() {
                    *c.options.lock().unwrap() = set["configOptions"].clone();
                }
            }
        }
        let (agent, kept_model, kept_effort, kept_level) = (id.to_owned(), model.clone(), effort.clone(), level.map(Level::id));
        self.stored(move |store| {
            if let Some(level) = kept_level {
                store.set_permission_level(&agent, Some(level))?;
            }
            store.update_meta(&agent, "dsh/settings", &json!({"model": kept_model, "effort": kept_effort, "level": kept_level}), |m| {
                m.agent.model = kept_model;
                m.agent.settings.reasoning_effort = kept_effort;
                if let Some(level) = kept_level {
                    m.agent.settings.permission_level = Some(level.into());
                }
                if let Some(usage) = m.context_usage.as_mut() {
                    usage.stale = true;
                }
            }).map(drop)
        }).await?;
        self.changed(id);
        if let (Some(c), true) = (live, restart) {
            self.dsh_stop_idle(id, &c).await?;
            self.dsh_ensure(id).await?;
        }
        self.listed(id).await
    }

    /// Under the Agent gate: connection `c`, idle, removed and its dsh stopped
    /// (its group with it), recorded as a stop Core chose: a level's new dsh,
    /// or the user's disconnect (disconnect.rs).
    pub(crate) async fn dsh_stop_idle(&self, id: &str, c: &Connection) -> Result<()> {
        ensure!(c.prompt.lock().unwrap().is_none(), "dsh 一轮进行中；没有停止。A dsh Turn is running; dsh was not stopped.");
        {
            let _owned = self.owner(id).await;
            let mut connections = self.dshs.lock().unwrap();
            if connections.get(id).is_some_and(|v| v.generation == c.generation) {
                connections.remove(id);
            }
        }
        let (ending, _) = c.dsh.shutdown().await.context("dsh did not end")?;
        self.record_meta(id, "dsh/stopped", json!({"generation": c.generation, "ending": format!("{ending:?}")}), |m| {
            m.agent.connection_state = "disconnected".into();
            if m.agent.status == "idle" {
                m.agent.status = "offline".into();
            }
        }).await?;
        self.changed(id);
        Ok(())
    }

    /// The models a dsh Agent may choose (`GET /api/agents/:id/models`,
    /// §3.9): those its live dsh offers, else those a dsh of Core's own lists.
    pub async fn dsh_agent_models(&self, id: &str) -> Result<Value> {
        let live = self.dshs.lock().unwrap().get(id).cloned();
        match live {
            Some(c) => {
                let options = c.options.lock().unwrap().clone();
                Ok(json!({"models": model_rows(&options), "version": c.dsh.version().to_string()}))
            }
            None => self.dsh_catalog().await,
        }
    }

    /// dsh's models for a new Agent (`GET /api/models?harness=dsh`, §3.9),
    /// read by `catalog_read` within CATALOG_LIMIT, one read at a time, and
    /// kept CATALOG_FRESH for the dsh this Core starts.
    pub async fn dsh_catalog(&self) -> Result<Value> {
        static CATALOG: tokio::sync::Mutex<Option<(PathBuf, Instant, Value)>> = tokio::sync::Mutex::const_new(None);
        let (program, endpoint) = self.dsh_program();
        let mut kept = CATALOG.lock().await;
        if let Some((_, _, value)) = kept.as_ref().filter(|(of, at, _)| *of == program && at.elapsed() < CATALOG_FRESH) {
            return Ok(value.clone());
        }
        let value = tokio::time::timeout(CATALOG_LIMIT, catalog_read(&self.data_dir, program.clone(), endpoint)).await
            .map_err(|_| anyhow::anyhow!("dsh 没有在 20 秒内列出它的模型。dsh did not list its models within 20 s."))?
            .context("dsh 的模型目录读不到。dsh's models could not be read")?;
        *kept = Some((program, Instant::now(), value.clone()));
        Ok(value)
    }

    /// Under the Agent gate (a close): a running Turn interrupted and given
    /// STOP_LIMIT to end, then dsh stopped (`Dsh::shutdown`, its group with it).
    pub(crate) async fn dsh_close_runtime(&self, id: &str) -> Result<()> {
        let Some(c) = self.dshs.lock().unwrap().get(id).cloned() else { return Ok(()) };
        let running = c.prompt.lock().unwrap().is_some();
        let open = if running { self.dsh_claim_requests(id, &c).await } else { Vec::new() };
        let cancelled = running && c.dsh.notify("session/cancel", json!({"sessionId": c.session})).await.is_ok();
        self.dsh_answer_cancelled(id, &c, open).await;
        if cancelled {
            // Until its end is recorded: the connection is removed only after.
            let _ = tokio::time::timeout(STOP_LIMIT, async {
                while self.dsh_current(id, c.generation).is_some()
                    && self.send_view(id).await.is_ok_and(|d| d.turns.iter().any(|t| t["status"] == "inProgress")) {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }).await;
        }
        {
            let _owned = self.owner(id).await;
            let mut connections = self.dshs.lock().unwrap();
            if connections.get(id).is_some_and(|v| v.generation == c.generation) {
                connections.remove(id);
            }
        }
        let (ending, _) = c.dsh.shutdown().await.context("dsh did not end; the Agent was not closed")?;
        self.record_update(id, "dsh/closed", json!({"generation": c.generation, "ending": format!("{ending:?}")}), Sel::Open, |d| {
            ended(d, CLOSED);
            d.agent.connection_state = "disconnected".into();
        }).await?;
        self.changed(id);
        Ok(())
    }

    /// When Core stops normally: every Agent's dsh stopped as a close stops
    /// it, all at once. Nothing is recorded: the next Core resumes the same
    /// sessions, and what was running is then unknown (`RESTARTED`).
    pub async fn dsh_stop_all(&self) {
        let connections: Vec<Connection> = std::mem::take(&mut *self.dshs.lock().unwrap()).into_values().collect();
        futures_util::future::join_all(connections.into_iter().map(|c| async move {
            if let Err(error) = c.dsh.shutdown().await {
                eprintln!("dsh did not stop with Core: {error:#}");
            }
        })).await;
    }
}

#[cfg(test)]
#[path = "dsh_agent_tests.rs"]
mod tests;
