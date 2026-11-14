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
//! answer within STOP_LIMIT its end is unknown, as Claude's is.
//!
//! A request past dsh's sandbox (`session/request_permission`) is refused by
//! Core at every level, reject-once (§3.6, S2a): S2b asks the user at Ask.
//!
//! A start (§3.8): a new dsh, `session/resume` of the Agent's session (or
//! `session/new` for its first), then its model and effort set again. What
//! an earlier dsh ran and did not answer is unknown: dsh keeps that Turn as
//! interrupted in its own session, and Core as outcomeUnknown here.
//!
//! The Agent's folder for dsh, `<data>/dsh/<agent>`, is Core's own and goes
//! with the Agent when it is deleted (`remove_folder`).
//!
//! Not yet (S2b): Workspace MCP, the session notice and the Brief's rules in
//! `$DSH_HOME/AGENTS.md`, mail and Brief reminder Turns, the user's answers
//! to requests, model and effort settings and catalogs, images.
use crate::{
    backlog::{Backlog, EventSender},
    dsh::{self, Access, Dsh},
    model::{ensure_agent_open, now, Agent, AgentDetail, ContextUsage, MessageInput},
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
    let home = data.join("dsh-version");
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
    let read = async {
        std::fs::create_dir_all(home)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))?;
        }
        dsh::installed(program, home).await
    };
    match read.await {
        Ok((version, standing)) => json!({"available": true, "version": version.to_string(), "label": standing.note()}),
        Err(_) => json!({"available": false, "version": null, "label": null}),
    }
}

// ---------------------------------------------------------------- the record

/// Whether the Agent runs a Turn or waits for an answer.
fn busy(d: &AgentDetail) -> bool {
    matches!(d.agent.status.as_str(), "working" | "waiting") || (d.agent.status != "offline" && d.turns.iter().any(|t| t["status"] == "inProgress"))
}

fn refresh_status(d: &mut AgentDetail) {
    if d.turns.iter().any(|t| t["status"] == "inProgress") {
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

/// A tool call's Item as dsh starts it (§3.4): `bash` a command, `mcp__<server>__<tool>`
/// an MCP call, any other the tool's name with its input and output as dsh gives them.
fn tool_item(id: &str, call: &str, update: &Value) -> Value {
    let name = update["title"].as_str().unwrap_or("tool");
    if let Some((server, tool)) = name.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
        json!({"id": id, "type": "mcpToolCall", "callId": call, "server": server, "tool": tool, "arguments": update["rawInput"],
            "result": null, "status": "inProgress"})
    } else if name == "bash" || update["kind"] == "execute" {
        json!({"id": id, "type": "commandExecution", "callId": call, "command": command_of(&update["rawInput"]), "aggregatedOutput": "",
            "exitCode": null, "status": "inProgress"})
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
            Some("commandExecution") => item["command"] = command_of(&update["rawInput"]),
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

    pub(crate) async fn dsh_reconnect_accepted(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit) -> Result<AgentDetail> {
        self.dsh_reconnect_gated(id, permit, true).await?.context("record")
    }

    /// Reconnects a dsh Agent under its gate: its live dsh, or a new one
    /// resuming its session; with `read`, the record as that left it.
    pub(crate) async fn dsh_reconnect_gated(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit, read: bool) -> Result<Option<AgentDetail>> {
        permit.validate(&self.admission)?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        ensure_agent_open(&self.listed(id).await?)?;
        if let Err(error) = self.dsh_ensure(id).await {
            self.failed(id, &error).await;
            return Err(error);
        }
        if read { Ok(Some(self.answer(id).await?)) } else { Ok(None) }
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
        let directory = PathBuf::from(&d.agent.cwd);
        let launch = dsh::Launch {
            program,
            folder: dsh::folder(&self.data_dir, id)?,
            writable: dsh::writable_roots(&directory).await,
            directory,
            access: level.access(),
            instructions: String::new(),
            key: Some(key),
            endpoint,
        };
        let (tx, rx) = mpsc::channel(256);
        let backlog = Arc::new(Backlog::default());
        let events = EventSender::observed(tx, backlog.clone());
        let dsh = Arc::new(Dsh::start(&launch, events.clone()).await?);
        let opened = match &d.agent.dsh_session_id {
            Some(session) => dsh.request("session/resume", json!({"sessionId": session, "cwd": d.agent.cwd, "mcpServers": []}), SESSION_LIMIT).await,
            None => dsh.request("session/new", json!({"cwd": d.agent.cwd, "mcpServers": []}), SESSION_LIMIT).await,
        };
        let answer = opened.context("dsh start check 5 of 5 (its session)")?;
        dsh::check_session(&answer).context("dsh start check 5 of 5 (its session)")?;
        let session = match &d.agent.dsh_session_id {
            Some(session) => session.clone(),
            None => answer["sessionId"].as_str().filter(|s| !s.is_empty()).context("dsh's session/new named no session")?.to_owned(),
        };
        // The Agent's model and effort, set again at each start (§3.8, §3.9).
        let effort = d.agent.settings.reasoning_effort.clone().unwrap_or_default();
        for (option, wanted) in [("model", d.agent.model.as_str()), ("reasoning_effort", effort.as_str())] {
            if wanted.is_empty() {
                continue;
            }
            let value = option_value(&answer["configOptions"], option, wanted)
                .with_context(|| format!("dsh 不提供 {option}「{wanted}」，请重新选择。dsh offers no {option} {wanted}: choose another."))?;
            dsh.request("session/set_config_option", json!({"sessionId": session, "configId": option, "value": value}), SESSION_LIMIT).await
                .with_context(|| format!("dsh did not take {option} {wanted}"))?;
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let c = Connection { generation, dsh: dsh.clone(), session: session.clone(), events, prompt: Arc::default(), native: Arc::default() };
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

    /// A request past dsh's sandbox, refused by Core (§3.6, S2a): reject-once,
    /// else, when dsh offers no such option, the request cancelled. The answer
    /// goes first, whatever becomes of its record: nothing is ever allowed.
    async fn dsh_refuse(&self, id: &str, c: &Connection, message: Value) {
        let params = &message["params"];
        let reject = params["options"].as_array().into_iter().flatten().find(|o| o["kind"] == "reject_once").and_then(|o| o["optionId"].as_str());
        let outcome = match reject {
            Some(option) => json!({"outcome": {"outcome": "selected", "optionId": option}}),
            None => json!({"outcome": {"outcome": "cancelled"}}),
        };
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
        let written = self.stored_owned(owned, move |store| store.record_event(&agent, "dsh/turnEnded", &data, Sel::Turns(vec![turn.clone()]), move |d| {
            let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str()) else { return };
            // Its own end, or one an unanswered interrupt left unknown.
            if !matches!(entry["status"].as_str(), Some("inProgress" | "outcomeUnknown")) {
                return;
            }
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
        }).map(drop)).await;
        if let Err(error) = written {
            eprintln!("Workspace dsh Turn end not recorded: {error:#}");
        }
        self.changed(id);
    }

    /// An interrupt dsh has not answered within STOP_LIMIT (§3.5): its Turn's
    /// end is unknown. A later answer still ends it, and until then no new
    /// prompt goes (`dsh_send_locked`).
    async fn dsh_stop_unconfirmed(&self, id: &str, c: &Connection, params: &Value) {
        let Some(turn) = params["turnId"].as_str().map(str::to_owned) else { return };
        if c.prompt.lock().unwrap().as_deref() != Some(turn.as_str()) {
            return;
        }
        let message = "dsh 在 10 秒内没有确认中断；这一轮的结果未确认，不会重发。dsh did not confirm the interrupt within 10 s; this Turn's end is unknown.";
        let written = self.record_update(id, "dsh/stopUnconfirmed", params.clone(), Sel::Turns(vec![turn.clone()]), move |d| {
            if let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str() && t["status"] == "inProgress") {
                unknown(entry, message);
            }
            refresh_status(d);
        }).await;
        if let Err(error) = written {
            eprintln!("Workspace dsh interrupt not recorded: {error:#}");
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

    /// Before a receipt is recorded (send_message): what a dsh Agent takes is
    /// a new message while it is idle; a form's answers are one too.
    pub(crate) async fn dsh_admit(self: &Arc<Self>, id: &str, input: &MessageInput, detail: &AgentDetail) -> Result<()> {
        ensure!(input.expected_turn_id.is_none(), BUSY);
        ensure!(input.question.is_none(), "dsh Agent 只接受新消息；草稿保留。A dsh Agent takes new messages only; the draft is kept.");
        ensure!(!busy(detail), BUSY);
        self.dsh_ensure(id).await.map(drop)
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
        self.dsh_send_locked(id, text, None).await
    }

    /// Under the Agent gate: one new prompt while dsh is idle (§3.4), its Turn
    /// recorded before it is sent. Ok once it is sent; dsh's answer ends it.
    pub(crate) async fn dsh_send_locked(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>) -> Result<Value> {
        self.ensure_rewind_settled(id).await?;
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        ensure!(!busy(&d), BUSY);
        let c = self.dsh_ensure(id).await?;
        ensure!(c.prompt.lock().unwrap().is_none(), BUSY);
        ensure!(self.dsh_current(id, c.generation).is_some(), "dsh 连接已变化，消息未发送；草稿保留");
        let turn = uuid::Uuid::new_v4().to_string();
        let (requested, client, words) = (turn.clone(), client_id.map(str::to_owned), text.clone());
        self.record_update(id, "dsh/turnRequested", json!({"turnId": turn, "clientMessageId": client_id, "text": text}),
            Sel::Turns(vec![turn.clone()]), move |d| {
            let entry = d.turn_mut(&requested);
            entry["status"] = "inProgress".into();
            if let Some(client) = &client {
                entry["_dshClient"] = client.clone().into();
            }
            entry["items"] = json!([{"id": format!("{requested}:input"), "type": "userMessage", "content": [{"type": "text", "text": words}]}]);
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
        let call = match c.dsh.call("session/prompt", json!({"sessionId": c.session, "prompt": [{"type": "text", "text": text}]})).await {
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
        c.dsh.notify("session/cancel", json!({"sessionId": c.session})).await?;
        let events = c.events.clone();
        tokio::spawn(async move {
            tokio::time::sleep(STOP_LIMIT).await;
            let _ = events.send(json!({"method": STOP_UNCONFIRMED, "params": {"turnId": turn}})).await;
        });
        Ok(())
    }

    /// Under the Agent gate (a close): a running Turn interrupted and given
    /// STOP_LIMIT to end, then dsh stopped (`Dsh::shutdown`, its group with it).
    pub(crate) async fn dsh_close_runtime(&self, id: &str) -> Result<()> {
        let Some(c) = self.dshs.lock().unwrap().get(id).cloned() else { return Ok(()) };
        let running = c.prompt.lock().unwrap().is_some();
        if running && c.dsh.notify("session/cancel", json!({"sessionId": c.session})).await.is_ok() {
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
