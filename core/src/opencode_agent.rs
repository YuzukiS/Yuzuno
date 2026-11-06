//! OpenCode Agents (T-110): an Agent's record driven by its own `opencode
//! serve` (see `opencode`). Local Agents only. One is created only by a Core
//! started with `YUZUNO_EXPERIMENTAL_OPENCODE=1`, which is off by default
//! until this is checked against a real OpenCode; otherwise HTTP create and
//! models refuse the harness and the UI offers none. The switch decides only
//! creation: an existing OpenCode Agent works either way.
//!
//! A Turn is one prompt, named by the message ID it is sent under and
//! recorded before it is sent. What became of it is taken from OpenCode's own
//! record of that ID: the stored user message confirms delivery, and once the
//! session is idle the assistant messages answering it (their `parentID`) say
//! how it ended. A 204, an idle status alone, or a session error that names no
//! message decides nothing, and nothing is ever sent again.
//!
//! Requests (permissions, questions) are kept as OpenCode sent them, with the
//! connection generation and session that asked; an answer goes only to that
//! process and session. No permission rule is added and `always` is not
//! offered: what asks is OpenCode's own configuration.
//!
//! Sub-agents (T-10): OpenCode's `task` tool runs one in a session of its
//! own, under the session that called it (`parentID`, 1.19.3 `tool/task.ts`).
//! A session is this Agent's sub-agent once OpenCode says so: its
//! `session.created` names one of the Agent's sessions as its parent, a
//! `task` call's part names it (`metadata.sessionId` under
//! `parentSessionId`), or the session's `children` list it. Its permission
//! and question requests are the Agent's, shown with the sub-agent that asks
//! and answered in its session. Nothing else of it is followed: its messages,
//! status and errors change no Turn, which the Agent's own session alone
//! decides. Any other session's events are not this Agent's.
//!
//! A form's answers (`clarification`) are an ordinary new message, checked as
//! for any harness before its receipt is recorded.
//!
//! A model (T-10) is OpenCode's own default unless one is chosen for the
//! Agent from what its OpenCode's configured providers list (`/api/model`),
//! and so is that model's variant (`variants`, such as `high`). 2.x's prompt
//! carries no model (T-32 slice 4a): a chosen one is made the session's
//! (`POST /api/session/:id/model`) before a message whenever the session's
//! is another or not known yet, and one OpenCode no longer lists refuses the
//! message before anything is sent. Only names are kept, never what else a
//! provider's record holds (its key, options or headers) or what a variant
//! sets.
//!
//! A message's images (T-10) go with it inline, as file parts after its
//! text, and only to a chosen model OpenCode lists as reading images
//! (`capabilities.input.image`): OpenCode would give any other model a line
//! of text in place of each image (`unsupportedParts`,
//! `provider/transform.ts`) and still take the message, and which model its
//! own default is can't be known before it answers. Either is refused before
//! anything is sent.
//!
//! A command (T-10) OpenCode's configuration defines (`/config`'s `command`)
//! runs when the user sends `/<name> [arguments]` for it: a Turn as a prompt
//! is, recorded under its message ID before it is sent (`POST
//! /session/:id/command`) and confirmed by the message OpenCode stores under
//! it. That request is answered only when the run ends, so it goes in the
//! background and its answer decides nothing once the message exists. A
//! command's own model, or its agent's, is OpenCode's choice over the
//! Agent's, whose model and variant go only with one that names none. It
//! takes no images. Text from anyone else is always a prompt.
//!
//! A message the user adds to the running Turn (T-10, "send while working")
//! goes as a prompt under a message ID of its own, recorded in that Turn
//! before it is sent: OpenCode 1.19.3 stores it at once and its running run
//! answers it from the next step (one run, answering the newest message).
//! The Turn's answers are those to any of its messages, and it ends once
//! every one of them is stored and the newest is answered, or OpenCode went
//! on under a later message of its own (an auto-compaction's). Only while its
//! prompt is stored, no interrupt is asked and no request waits for the user;
//! never a command.
//!
//! A `/compact` (T-10, contract on T-10 #3109) is OpenCode's own compaction
//! of the Agent's session (`POST /session/:id/summarize`, `auto: false`), a
//! model run, never a prompt: a Turn of its own, recorded before the request
//! with the model asked for and the compaction messages the session already
//! held. OpenCode writes the compaction's user message under an ID of its own
//! choosing, so the Turn is its only new `auto: false` compaction message of
//! that model, and the compaction's summary is the `summary` answer naming it
//! (`parentID`). Done once that summary completed and the session is idle;
//! the request's answer, which comes only when the run ends, and a summary
//! written before the run (as OpenCode writes it) decide nothing alone. While
//! a compaction is going on, or its end is unknown, or OpenCode still holds
//! one that did not finish, nothing new is sent to the Agent. Its summary is
//! the compaction item's text. The model OpenCode runs it with may still be
//! its own compaction agent's, whatever was asked.
//!
//! Not yet: no model is chosen when the Agent is created, and no OpenCode
//! `agent` at all; a sub-agent's own conversation is not shown, nor are
//! background sub-agents (OpenCode's experimental flag); a sub-agent of a
//! sub-agent (`subagent_depth` above OpenCode's default of 1) is followed as
//! it starts but not found again after the event stream breaks; no remote
//! machines.
use crate::{
    model::{ensure_agent_open, now, AgentDetail, ContextUsage, PendingRequest, UsageSeen},
    opencode::{self, CommandChoice, CompactAnswer, Events, Launch, Mcp, MessageId, ModelChoice, Reply, Server, Snapshot, Submission},
    rpc::OutcomeUnknown,
    store::{Sel, Store},
    workspace::Workspace,
};
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Weak},
    time::Duration,
};
use tokio::time::{timeout, Instant};

const PERMISSION: &str = "opencode/permission";
const QUESTION: &str = "opencode/question";
/// How long a send looks for the message OpenCode was given, by its ID.
const CONFIRM_LIMIT: Duration = Duration::from_secs(5);
/// How long a close waits for an aborted run to end.
const STOP_LIMIT: Duration = Duration::from_secs(10);
/// Waits before each attempt to open the event stream again.
const RESUBSCRIBE: [Duration; 3] = [Duration::from_millis(100), Duration::from_millis(500), Duration::from_secs(2)];
/// The Workspace MCP server's name in an Agent's OpenCode: its tools are
/// `yuzuno_<tool>` there.
const MCP_NAME: &str = "yuzuno";
/// How long a Workspace MCP server OpenCode lists as still connecting is
/// waited for: as long as Core lets it take to connect, and a little more.
const MCP_SETTLE: Duration = Duration::from_secs(opencode::MCP_STARTUP.as_secs() + 2);

/// An Agent's OpenCode process, started but not yet attached (T-10 Fork),
/// with where its snapshots are known to be kept, or why not.
pub(crate) struct Started {
    pub server: Arc<Server>,
    pub files: std::result::Result<crate::opencode_revert_files::Started, String>,
}

/// One Agent's live OpenCode process and the session it drives there.
#[derive(Clone)]
pub(crate) struct Connection {
    pub generation: u64,
    pub server: Arc<Server>,
    pub session: String,
    /// The sub-agent sessions OpenCode started under `session` (or under one
    /// of them) on this process, by ID, with what OpenCode says each is
    /// (`title`, `agent`). Their requests are the Agent's to answer.
    pub children: Arc<std::sync::Mutex<BTreeMap<String, Value>>>,
    /// What measuring the Agent's context needs from this connection (T-10).
    usage: Arc<std::sync::Mutex<Usage>>,
    /// Removals asked of OpenCode on this connection's session and recorded
    /// (T-10, giving up a compaction): a whole read begun before the latest
    /// is never published (`opencode_resync`), so it never undoes one.
    removals: Arc<std::sync::atomic::AtomicU64>,
    /// Where this OpenCode keeps its snapshots can be known from how it was
    /// started (T-10 Revert), or why not.
    pub files: Arc<std::result::Result<crate::opencode_revert_files::Started, String>>,
    /// How this connection's 2.x events read in Core's shapes (T-32 slice 3b).
    cursor: Arc<std::sync::Mutex<crate::opencode_v2::Cursor>>,
    /// The sign-in attempts journaled as logged in through this connection
    /// (T-32 slice 4b, R3 b2b46a5f of #621): 2.x keeps its attempts in
    /// memory, so an attempt is this process's alone.
    pub logins: Arc<std::sync::Mutex<HashSet<String>>>,
}

/// In memory only, for one connection (T-10, contract on T-10 #757): each
/// listed model's context window by its name, nothing else of a provider's
/// record, and at most one answer waiting for its model's window.
#[derive(Default)]
struct Usage {
    windows: HashMap<String, u64>,
    /// Moved on by what makes a measurement stale: a new input, a model or
    /// variant chosen, a compaction. An answer waiting from before it is
    /// not measured.
    epoch: u64,
    pending: Option<Pending>,
    /// Models the catalog was read again for, once each.
    refreshed: HashSet<String>,
    /// A model to read the catalog again for, once the change that found it
    /// is recorded.
    wanted: Option<String>,
}

/// An answer whose model this connection's list didn't have: what measuring
/// it needs, and nothing more.
struct Pending {
    epoch: u64,
    answer: String,
    turn: String,
    parent: String,
    at: i64,
    used: u64,
    model: String,
}

impl Usage {
    /// An answer completed at `at`, measured or not, is newer than one
    /// waiting from before it: that one is no longer the newest (R1 cca110b3).
    fn superseded(&mut self, at: i64) {
        if self.pending.as_ref().is_some_and(|pending| at >= pending.at) {
            self.pending = None;
        }
    }
}

impl Connection {
    fn new(generation: u64, server: Arc<Server>, session: String, children: BTreeMap<String, Value>,
        files: std::result::Result<crate::opencode_revert_files::Started, String>) -> Self {
        Self { generation, server, session, children: Arc::new(std::sync::Mutex::new(children)), usage: Arc::default(), removals: Arc::default(),
            files: Arc::new(files), cursor: Arc::default(), logins: Arc::default() }
    }

    /// Each listed model's context window, as OpenCode lists them now.
    fn windows(&self, models: &[ModelChoice]) {
        self.usage.lock().unwrap().windows = models.iter().map(|m| (m.id(), m.context)).collect();
    }

    /// A compaction at `at` (ms): what was measured before it no longer
    /// holds, nor does an answer waiting from before it. One newer than it
    /// keeps waiting, as when a resync replays the summary (R4 46270ae8).
    fn compacted(&self, at: i64) {
        let mut usage = self.usage.lock().unwrap();
        if usage.pending.as_ref().is_none_or(|pending| pending.at <= at) {
            usage.epoch += 1;
            usage.pending = None;
        }
    }

    /// What was measured no longer holds; an answer waiting from before is dropped.
    fn unmeasured(&self) {
        let mut usage = self.usage.lock().unwrap();
        usage.epoch += 1;
        usage.pending = None;
    }

    fn wanted(&self) -> Option<String> {
        self.usage.lock().unwrap().wanted.take()
    }

    /// Whether `session` is the Agent's: its own or one of its sub-agents'.
    fn owns(&self, session: &str) -> bool {
        session == self.session || self.children.lock().unwrap().contains_key(session)
    }

    /// What OpenCode says the sub-agent `session` is; None for the Agent's own.
    fn child(&self, session: &str) -> Option<Value> {
        self.children.lock().unwrap().get(session).cloned()
    }

    /// Adopts `child` as a sub-agent if OpenCode started it under one of the
    /// Agent's sessions; what is already known about it is kept, and
    /// filled in where OpenCode now says more.
    fn adopt(&self, child: &str, parent: &str, about: Value) {
        if child.is_empty() || child == self.session || !self.owns(parent) {
            return;
        }
        let mut children = self.children.lock().unwrap();
        let known = children.entry(child.to_owned()).or_insert_with(|| json!({}));
        for (key, value) in about.as_object().into_iter().flatten() {
            if !value.is_null() && known.get(key).is_none_or(Value::is_null) {
                known[key] = value.clone();
            }
        }
    }

    fn known_children(&self) -> Vec<String> {
        self.children.lock().unwrap().keys().cloned().collect()
    }

    /// A sub-agent session OpenCode says it started under one of the Agent's:
    /// its `session.created` or `session.updated`, or a `task` call's part.
    fn learn(&self, kind: &str, event: &Value) {
        let p = &event["data"];
        match kind {
            "session.created" | "session.updated" => {
                let info = &p["info"];
                if let (Some(child), Some(parent)) = (info["id"].as_str(), info["parentID"].as_str()) {
                    self.adopt(child, parent, about(info));
                }
            }
            "message.part.updated" => {
                let part = &p["part"];
                let metadata = &part["state"]["metadata"];
                if part["type"] == "tool" && part["tool"] == "task" {
                    if let (Some(child), Some(parent)) = (metadata["sessionId"].as_str(), metadata["parentSessionId"].as_str()) {
                        let title = part["state"]["title"].as_str().or(part["state"]["input"]["description"].as_str());
                        self.adopt(child, parent, json!({"title":title,"agent":part["state"]["input"]["subagent_type"]}));
                    }
                }
                // 2.x's sub-agent tool names the session it runs as it starts (core/src/tool/plugin/subagent.ts),
                // under the session of the answer it is part of.
                if part["type"] == "tool" && part["tool"] == "subagent" {
                    if let (Some(child), Some(parent)) = (metadata["sessionID"].as_str(), p["sessionID"].as_str()) {
                        let input = &part["state"]["input"];
                        self.adopt(child, parent, json!({"title":input["description"],"agent":input["subagent_type"].as_str().or(input["agent"].as_str())}));
                    }
                }
            }
            _ => {}
        }
    }
}

/// What a session's info says it is, for a request's card.
fn about(info: &Value) -> Value {
    json!({"title":info["title"],"agent":info["agent"]})
}

/// The sub-agents OpenCode lists under `session`, one level down: as deep as
/// OpenCode goes unless configured otherwise (`subagent_depth`, 1).
async fn sub_agents(server: &Server, session: &str) -> Result<BTreeMap<String, Value>> {
    let mut found = BTreeMap::new();
    for child in server.children(session).await? {
        if let Some(id) = child["id"].as_str() {
            found.insert(id.to_owned(), about(&child));
        }
    }
    Ok(found)
}

/// Moves the OpenCode database in an Agent's `folder` into a new
/// `set-aside-N` folder beside it, its WAL and other files first, so that a
/// new database never meets an old WAL; that folder, or None when there is
/// no database. A failed move fails the start, so OpenCode never starts
/// with part of one left. What the scrub overwrote and removed instead, as
/// what can't be read as a database, is listed beside it.
fn set_aside(folder: &std::path::Path) -> Result<(Option<PathBuf>, Vec<crate::opencode_login::Destroyed>)> {
    let present = || -> Vec<&str> { ["opencode.db-wal", "opencode.db-shm", "opencode.db-journal", "opencode.db"].into_iter()
        .filter(|name| folder.join(name).symlink_metadata().is_ok()).collect() };
    if present().is_empty() {
        return Ok((None, Vec::new()));
    }
    // No login leaves with it (T-32 slice 4b, D6): its credentials are scrubbed first, with no server running yet.
    // SQLite may remove its WAL and index as it closes, so what is moved is what is left after.
    let destroyed = crate::opencode_login::scrub(&folder.join("opencode.db"))
        .map_err(|error| anyhow!("OpenCode 数据库的登录凭据没有清除（{error:#}）；数据库没有挪开，OpenCode 没有启动"))?;
    let files = present();
    if files.is_empty() {
        return Ok((None, destroyed));
    }
    let mut n = 1;
    let aside = loop {
        let path = folder.join(format!("set-aside-{n}"));
        match std::fs::create_dir(&path) {
            Ok(()) => break path,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(error) => return Err(error).with_context(|| format!("{} 无法创建；OpenCode 没有启动", path.display())),
        }
    };
    for name in files {
        std::fs::rename(folder.join(name), aside.join(name)).with_context(|| format!("没有记下 Session 的 OpenCode 数据库 {name} 无法移到 {}；OpenCode 没有启动", aside.display()))?;
    }
    Ok((Some(aside), destroyed))
}

/// The `opencode` this Core starts (`YUZUNO_OPENCODE_BIN`, else from PATH).
fn program() -> PathBuf {
    std::env::var_os("YUZUNO_OPENCODE_BIN").map(PathBuf::from).unwrap_or_else(|| "opencode".into())
}

/// Whether this Core creates OpenCode Agents. The UI reads it from Core.
pub fn enabled() -> bool {
    std::env::var_os("YUZUNO_EXPERIMENTAL_OPENCODE").is_some_and(|v| v == "1")
}

/// What `/api/models?harness=opencode` answers: no list, since an Agent
/// starts with OpenCode's own default (its configuration's); its models are
/// its own OpenCode's (`opencode_agent_catalog`).
pub fn catalog() -> Value {
    json!({"models":[],"opencode":{"version":opencode::VERIFIED}})
}

/// A model as the Agent settings offer it: named `<provider>/<model>`, shown
/// with the provider's and the model's names and, unless active, its status,
/// with the names of its variants.
fn offered(model: &ModelChoice) -> Value {
    let id = model.id();
    json!({"id":id,"model":id,"displayName":format!("{} · {}", model.provider_name, model.name),
        "description":(model.status != "active").then(|| model.status.clone()),"variants":model.variants})
}

/// The model chosen for an Agent, as its OpenCode lists it now; None for
/// OpenCode's own default. One it no longer lists is refused.
async fn chosen(server: &Server, model: &str) -> Result<Option<ModelChoice>> {
    if model.is_empty() {
        return Ok(None);
    }
    let listed = server.models().await.context("没有读到 OpenCode 的模型；这条消息没有发送，草稿保留")?;
    let found = listed.into_iter().find(|m| m.id() == model);
    found.map(Some).with_context(|| format!("所选模型 {model} 已不在 OpenCode 当前的配置中；这条消息没有发送，草稿保留。请在设置里另选模型"))
}

/// Makes the Agent's chosen model and variant the session's before a message
/// (T-32 slice 4a, D3): 2.x's prompt carries none. Only when the session's,
/// as OpenCode says now (`GET /api/session/:id`), is another or none yet;
/// never without a chosen one, so OpenCode's own default stays. Each switch
/// is a `model-switched` message of 2.x's.
async fn choose_for(c: &Connection, model: Option<&ModelChoice>, variant: Option<&str>) -> Result<()> {
    let Some(model) = model else { return Ok(()) };
    let current = c.server.session(&c.session).await.context("没有读到 OpenCode 会话当前的模型；这条消息没有发送，草稿保留")?;
    let current = &current["model"];
    // 2.x reads a model without a variant as its "default" one, and switches as it does
    // (core/src/session/info.ts, session.ts switchModel).
    let same_variant = current["variant"].as_str().unwrap_or("default") == variant.unwrap_or("default");
    if current["id"] == model.model.as_str() && current["providerID"] == model.provider.as_str() && same_variant {
        return Ok(());
    }
    c.server.switch_model(&c.session, model, variant).await.context("没有把所选模型设为 OpenCode 会话的模型；这条消息没有发送，草稿保留")
}

/// The variant chosen for an Agent, as its chosen model lists it now; None
/// for OpenCode's own. One the model no longer lists is refused: OpenCode
/// would apply nothing for it (`llm/request.ts`) and say nothing.
fn chosen_variant(model: Option<&ModelChoice>, variant: Option<&str>) -> Result<Option<String>> {
    let Some(variant) = variant.filter(|v| !v.is_empty()) else { return Ok(None) };
    let model = model.context("所选变体需要先选定模型；这条消息没有发送，草稿保留。请在设置里选择模型")?;
    ensure!(model.variants.iter().any(|v| v == variant),
        "所选变体 {variant} 已不在 OpenCode 为 {} 列出的变体中；这条消息没有发送，草稿保留。请在设置里另选", model.id());
    Ok(Some(variant.to_owned()))
}

/// The model a compaction is asked to run with (T-10): the one chosen for the
/// Agent's next messages, as its OpenCode lists it now; with none chosen,
/// the one the session's newest user message went with, if OpenCode still
/// lists it. With neither, nothing is sent: no model is guessed. OpenCode
/// may still run the compaction with its compaction agent's own model
/// (`compaction.ts`), whatever was asked.
async fn compact_model(server: &Server, d: &AgentDetail, messages: &Value) -> Result<(String, String)> {
    let unread = "没有读到 OpenCode 的模型；没有执行 /compact";
    if !d.agent.model.is_empty() {
        let listed = server.models().await.context(unread)?;
        let model = listed.into_iter().find(|m| m.id() == d.agent.model)
            .with_context(|| format!("所选模型 {} 已不在 OpenCode 当前的配置中；没有执行 /compact。请在设置里另选模型", d.agent.model))?;
        return Ok((model.provider, model.model));
    }
    let newest = messages.as_array().into_iter().flatten().rev().map(|m| &m["info"]).find(|info| info["role"] == "user");
    let (provider, model) = newest.and_then(|info| info["model"]["providerID"].as_str().zip(info["model"]["modelID"].as_str()))
        .context("还不知道这个会话用的是哪个模型：请先在设置里选定模型，或先发一条消息；没有执行 /compact")?;
    let listed = server.models().await.context(unread)?;
    ensure!(listed.iter().any(|m| m.provider == provider && m.model == model),
        "会话上一条消息用的模型 {provider}/{model} 已不在 OpenCode 当前的配置中；没有执行 /compact。请在设置里选定模型");
    Ok((provider.to_owned(), model.to_owned()))
}

/// Images go only to a chosen model that reads them, as OpenCode lists it now.
/// A command can carry no images here (T-10).
const IMAGES_WITH_COMMAND: &str = "OpenCode 命令不能附带图片；这条消息没有发送，草稿保留";
/// How long a command's start is waited for: its answer comes only when its run ends.
const COMMAND_START: Duration = Duration::from_secs(15);

/// The command a message names as `/<name> [arguments]`, if OpenCode's
/// configuration defines `<name>` now (T-10); None for any other text,
/// which is a prompt. A list it cannot read refuses the message rather than
/// sending a command's name to the model as text.
async fn listed_command(server: &Server, text: &str) -> Result<Option<(CommandChoice, String)>> {
    let Some(rest) = text.strip_prefix('/') else { return Ok(None) };
    let (name, arguments) = rest.split_once(char::is_whitespace).map_or((rest, ""), |(name, arguments)| (name, arguments.trim()));
    if name.is_empty() {
        return Ok(None);
    }
    let commands = server.commands().await.context("没有读到 OpenCode 的命令；这条消息没有发送，草稿保留")?;
    Ok(commands.into_iter().find(|c| c.name == name).map(|c| (c, arguments.to_owned())))
}

/// A command runs as a Turn of its own, so it is not added to a running one.
const COMMAND_WHILE_RUNNING: &str = "OpenCode 命令只能在空闲时发送；补充消息未发送，草稿保留";

/// Whether a message may be added to `expected` (T-10): the Agent's running
/// Turn, its prompt and every message added to it stored, no interrupt asked
/// of it, and no request waiting for the user (answered first, as OpenCode's
/// run waits on it).
fn joinable(d: &AgentDetail, expected: &str) -> Result<()> {
    let running = d.turns.iter().rev().find(|t| t["status"] == "inProgress").filter(|t| t["id"] == expected);
    let turn = running.context("原 Turn 已结束或发生变化；消息仍保留，请确认后作为新消息发送")?;
    let stored = turn["_opencodeConfirmed"] == true
        && turn["_opencodeInputs"].as_object().is_none_or(|inputs| inputs.values().all(|i| i["confirmed"] == true));
    ensure!(stored, "这一轮的消息尚未确认送达；补充消息未发送，草稿保留");
    ensure!(turn["interruptRequested"] != true, "这一轮正在中断；补充消息未发送，草稿保留");
    ensure!(!d.pending.iter().any(|p| !p.stale), "OpenCode 正在等待你的回应；请先回答，再补充消息。草稿保留");
    Ok(())
}

/// Why a compaction keeps the Agent from taking anything new (T-10), if one
/// does: one going on or not yet confirmed, one whose end could not be
/// known, or one OpenCode still holds unfinished. OpenCode's next run takes
/// up an unfinished compaction under the newest user message
/// (`message-v2.ts` latest, `prompt.ts` compaction), so a message sent then
/// may only be compacted, not answered. `what` says what was not done.
pub(crate) fn compaction_blocks(d: &AgentDetail, what: &str) -> Option<String> {
    let c = d.turns.iter().rev().map(|t| &t["_opencodeCompact"])
        .find(|c| matches!(c["state"].as_str(), Some("pending" | "unknown")) || c["nativePending"] == true)?;
    Some(match c["state"].as_str() {
        Some("pending") => format!("OpenCode 正在压缩这段对话，或压缩的结果尚未确认；{what}"),
        Some("unknown") => format!("上一次 /compact 的结果无法确认，请先重新连接核对；{what}"),
        _ => format!("OpenCode 里还留着上一次没有完成的压缩：现在发出的内容会先被它拿去压缩，可能得不到回答；{what}"),
    })
}

/// The IDs of the session's compaction messages (T-10): user messages with a
/// `compaction` part, whoever asked for them.
fn compaction_messages(messages: &Value) -> Vec<String> {
    messages.as_array().into_iter().flatten()
        .filter(|m| m["info"]["role"] == "user" && m["parts"].as_array().is_some_and(|parts| parts.iter().any(|p| p["type"] == "compaction")))
        .filter_map(|m| m["info"]["id"].as_str().map(str::to_owned)).collect()
}

fn takes_images(model: Option<&ModelChoice>) -> Result<()> {
    let model = model.context("发送图片需要先在设置里选定一个能读图片的模型：无法事先确认 OpenCode 自己的默认模型能否读图片；这条消息没有发送，草稿和图片保留")?;
    ensure!(model.image, "所选模型 {} 在 OpenCode 的配置中不能读图片；这条消息没有发送，草稿和图片保留。请在设置里另选能读图片的模型", model.id());
    Ok(())
}

impl Workspace {
    /// An Agent's models (`/api/agents/:id/models`): what its own OpenCode's
    /// configured providers offer now, read from the running connection.
    pub async fn opencode_agent_catalog(self: &Arc<Self>, id: &str) -> Result<Value> {
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode Agent 尚未连接；连接后才能读取它的模型")?;
        let models = c.server.models().await?;
        c.windows(&models);
        // Which OpenCode it runs, and, as a note, when that is newer than the one checked against (T-32).
        let version = c.server.version();
        let mut native = json!({"version":version,"verified":opencode::VERIFIED});
        if opencode::newer_than_verified(version) {
            native["note"] = json!(opencode::newer_note());
        }
        Ok(json!({"models":models.iter().map(offered).collect::<Vec<_>>(),"opencode":native}))
    }

    /// Chooses the model for an Agent's next messages, keeping its variant.
    pub async fn opencode_set_model(self: &Arc<Self>, id: &str, model: String) -> Result<crate::model::Agent> {
        self.opencode_set_choice(id, model, None).await
    }

    /// Chooses the model and its variant for an Agent's next messages: ""
    /// and None for OpenCode's own, else what its OpenCode lists now; a
    /// variant needs a model that lists it. `variant` absent keeps the saved
    /// one, null clears it. Saved only; a running Turn keeps what it was sent
    /// with. Under the Agent gate, as the other harnesses' settings: a close
    /// or reconnect waits for it, and it for them.
    pub async fn opencode_set_choice(self: &Arc<Self>, id: &str, model: String, variant: Option<Option<String>>) -> Result<crate::model::Agent> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let agent = self.listed(id).await?;
        ensure!(agent.harness == "opencode", "Agent 不是 OpenCode");
        ensure_agent_open(&agent)?;
        let model = model.trim().to_owned();
        let variant = match variant {
            Some(chosen) => chosen.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()),
            None => agent.settings.reasoning_effort.clone(),
        };
        if !model.is_empty() {
            let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode Agent 尚未连接；连接后才能选择它的模型")?;
            let listed = c.server.models().await?;
            c.windows(&listed);
            let found = listed.iter().find(|m| m.id() == model).with_context(|| format!("OpenCode 当前配置的模型里没有 {model}；设置未保存"))?;
            if let Some(variant) = &variant {
                ensure!(found.variants.iter().any(|v| v == variant), "OpenCode 没有为 {model} 列出变体 {variant}；设置未保存");
            }
        } else {
            ensure!(variant.is_none(), "变体需要先选定模型；设置未保存");
        }
        let (selected, kept) = (model.clone(), variant.clone());
        self.record_meta(id, "opencode/modelSelected", json!({"model":model,"variant":variant}), move |m| {
            m.agent.model = selected;
            m.agent.settings.reasoning_effort = kept;
            // Another model, or variant, answers next; what was measured is last known.
            if let Some(usage) = m.context_usage.as_mut() {
                usage.stale = true;
            }
        }).await?;
        if let Some(c) = self.opencodes.lock().unwrap().get(id) {
            c.unmeasured();
        }
        self.changed(id);
        self.listed(id).await
    }

    /// A new OpenCode Agent on this Core host; an executor with `birth` (T-34).
    pub async fn opencode_create_on(
        self: &Arc<Self>, name: String, cwd: String, model: String,
        machine_id: Option<String>, project_id: Option<String>, birth: Option<crate::workspace::Birth>,
    ) -> Result<crate::model::Agent> {
        // An executor is made under its dispatch's work permit (T-34, R3
        // d51396b7): asking for another here would let an update that starts
        // meanwhile fail a dispatch its refusal says can be retried.
        let permit = if birth.is_some() { None } else { Some(self.admission.enter_work()?) };
        ensure!(enabled(), "OpenCode Agent 尚未开放");
        if name.trim().is_empty() || name.len() > 100 {
            bail!("请填写名称（最多 100 字节）");
        }
        ensure!(machine_id.as_deref().is_none_or(|id| id == "local"), "OpenCode Agent 目前只支持 Core 所在的本机");
        ensure!(model.is_empty(), "OpenCode Agent 使用 OpenCode 自己配置的默认模型，这里不能选择");
        if let Some(project) = project_id.clone() {
            self.stored(move |store| store.ensure_project_assignable(&project)).await?;
        }
        let cwd = std::fs::canonicalize(cwd).context("工作目录不存在或无法读取")?;
        ensure!(cwd.is_dir(), "工作目录必须是文件夹");
        let (id, then) = crate::workspace::Birth::of(birth);
        let colors = ["yuzu", "sage", "rose", "sky"];
        let count = self.stored(|store| store.agents()).await?.len();
        let agent = crate::model::Agent {
            id: id.clone(),
            name: name.trim().into(),
            goal: String::new(),
            work_summary: None,
            project_id,
            kind: None,
            released_at: None,
            released_by: None,
            executor: None,
            cwd: cwd.to_string_lossy().into_owned(),
            model,
            settings: Default::default(),
            color: colors[count % colors.len()].into(),
            harness: "opencode".into(),
            claude_session_id: None,
            opencode_session_id: None,
            opencode_version: None,
            opencode_major: None,
            thread_id: None,
            status: "offline".into(),
            created_at: now(),
            updated_at: now(),
            unread_count: 0,
            pending_count: 0, open_questions: 0, last_turn_end: None,
            last_message: None,
            last_seq: 0,
            reviewed_seq: 0,
            rev: 0,
            error: None,
            remote: None,
            connection_state: "disconnected".into(),
            closed_at: None, disconnected_at: None, disconnect_unconfirmed: false,
        };
        let detail = AgentDetail {
            agent: agent.clone(),
            turns: vec![],
            history: None,
            pending: vec![],
            artifacts: vec![],
            context_usage: None,
            message_receipts: vec![],
            claude_runtime: None,
            codex_handoff: None,
            opencode_usage_seen: None,
        };
        let born = then.is_some();
        self.stored(move |store| store.insert_created_then(&detail, then)).await?;
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
            if let Err(error) = ws.opencode_ensure(&id).await {
                ws.failed(&id, &error).await;
            }
        });
        Ok(agent)
    }

    fn opencode_current(&self, id: &str, generation: u64) -> Option<Connection> {
        self.opencodes.lock().unwrap().get(id).filter(|c| c.generation == generation).cloned()
    }

    pub(crate) async fn opencode_reconnect_accepted(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit) -> Result<AgentDetail> {
        self.opencode_reconnect_gated(id, permit, true).await?.context("record")
    }

    /// Reconnects an OpenCode Agent under its gate; with `read`, returns the
    /// record as the reconnect left it, read under the same gate. Whether it
    /// is open is checked on the Agent as listed, not its history (T-140).
    pub(crate) async fn opencode_reconnect_gated(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit, read: bool) -> Result<Option<AgentDetail>> {
        permit.validate(&self.admission)?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let agent = self.listed(id).await?;
        ensure_agent_open(&agent)?;
        match self.opencode_ensure(id).await {
            // The Workspace MCP checked again on the same process, a failed
            // one tried again (T-61 slice 1): its readiness shows on the
            // record, and a reconnect is not refused for it.
            Ok(c) => { let _ = self.opencode_mcp(id, &agent, &c, true).await; }
            Err(error) => {
                self.failed(id, &error).await;
                return Err(error);
            }
        }
        if read { Ok(Some(self.answer(id).await?)) } else { Ok(None) }
    }

    /// Under the Agent gate: the live connection, or a new OpenCode process
    /// for the Agent's session (created on the first connection).
    pub(crate) async fn opencode_ensure(self: &Arc<Self>, id: &str) -> Result<Connection> {
        self.opencode_ensure_on(id, None).await
    }

    /// `opencode_ensure`, attaching `started` (a fork's target, T-10 Fork),
    /// already serving this Agent's folder with its own database, rather
    /// than starting another process.
    pub(crate) async fn opencode_ensure_on(self: &Arc<Self>, id: &str, started: Option<Started>) -> Result<Connection> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        crate::model::ensure_not_disconnected(&d.agent)?;
        crate::model::ensure_opencode_current(&d.agent)?;
        if let Some(c) = self.opencodes.lock().unwrap().get(id).cloned() {
            return Ok(c);
        }
        ensure!(d.agent.remote.is_none(), "OpenCode Agent 目前只支持 Core 所在的本机");
        if d.agent.opencode_session_id.is_none() && !d.turns.is_empty() {
            bail!("OpenCode 上次任务已发送但原生 Session 未确认；不会创建另一个 Session 或重发任务");
        }
        // An executor waiting for a slot starts only from the queue (T-35).
        self.executor_slot_admits(id).await?;
        self.record_meta(id, "opencode/connecting", json!({}), |m| m.agent.connection_state = "connecting".into()).await?;
        self.changed(id);
        let connected = match started {
            Some(started) => self.opencode_attach(id, &d, started).await,
            None => self.opencode_connect(id, &d).await,
        };
        match connected {
            Ok(c) => Ok(c),
            Err(error) => {
                let message = error.to_string();
                self.record_meta(id, "opencode/connectFailed", json!({"error":message}), |m| {
                    m.agent.connection_state = "disconnected".into();
                }).await?;
                self.changed(id);
                Err(error)
            }
        }
    }

    async fn opencode_connect(self: &Arc<Self>, id: &str, d: &AgentDetail) -> Result<Connection> {
        // With no session recorded, nothing Core sent is in a database already
        // in its folder: an earlier start made it, 1.19.3 among them, and its
        // session never reached the record. 2.x would apply its own schema to
        // it (2.2.5 core/src/database/migration.ts), so it is moved aside,
        // never deleted, and 2.x makes a new one (R2 f9cbccce of #575).
        if d.agent.opencode_session_id.is_none() {
            let folder = self.data_dir.join("opencode").join(id);
            let (aside, destroyed) = tokio::task::spawn_blocking(move || set_aside(&folder)).await??;
            for leftover in destroyed {
                self.record_meta(id, "opencode/leftoverDestroyed", json!(leftover), |_| {}).await?;
            }
            if let Some(aside) = aside {
                self.record_meta(id, "opencode/setAside", json!({"folder": aside}), |_| {}).await?;
            }
        }
        let started = self.opencode_start(id, &d.agent.cwd).await?;
        self.opencode_attach(id, d, started).await
    }

    /// This Agent's OpenCode process, started and nothing else (T-10 Fork):
    /// its own folder and database, serving `cwd`, from the executable
    /// `opencode` resolves to now. Until it is attached, the caller is its
    /// only owner: dropping it ends its process group.
    pub(crate) async fn opencode_start(&self, id: &str, cwd: &str) -> Result<Started> {
        // Its own folder, and the cache Core's Agents share (T-32): OpenCode
        // keeps its data and state in the one, its downloads in the other.
        let (folder, cache) = (self.data_dir.join("opencode").join(id), self.data_dir.join("opencode").join("cache"));
        for made in [&folder, &cache] {
            std::fs::create_dir_all(made)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(made, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        // What `opencode` resolves to now: a native executable is started by
        // that very file, so what was checked is what runs (T-10 Revert).
        // Read from the disk on the blocking pool, as what it checks next is (R5 of #534).
        let named = program();
        let (wanted, path) = (named.clone(), std::env::var_os("PATH"));
        let launcher = tokio::task::spawn_blocking(move || crate::opencode_revert_files::Launcher::resolve(&wanted, path.as_deref())).await?;
        let start = match &launcher {
            Ok(crate::opencode_revert_files::Launcher::Native { path, .. }) => path.clone(),
            _ => named,
        };
        let launch = Launch::new(start, cwd.into(), &folder, cache);
        let server = Arc::new(Server::start(&launch).await?);
        let pid = server.pid();
        // OpenCode's folders as it was started: Core's environment with the Agent's own on top.
        let given: Vec<(&'static str, std::ffi::OsString)> = launch.environment().into_iter().map(|(name, value)| (name, value.to_owned())).collect();
        let var = move |name: &str| given.iter().find(|(set, _)| *set == name).map(|(_, value)| value.clone()).or_else(|| std::env::var_os(name));
        let files = tokio::task::spawn_blocking(move || crate::opencode_revert_files::Started::of(launcher, pid, var,
            std::env::vars_os().map(|(name, _)| name), dirs::home_dir)).await?;
        Ok(Started { server, files })
    }

    /// Wires a started process to the Agent: its session (created on the
    /// first connection), its Workspace MCP, its events, its record. Until it
    /// is in `opencodes`, `started` is its only owner: an error below drops
    /// it, which ends its process group.
    async fn opencode_attach(self: &Arc<Self>, id: &str, d: &AgentDetail, started: Started) -> Result<Connection> {
        let Started { server, files } = started;
        let session = match &d.agent.opencode_session_id {
            Some(session) => session.clone(),
            None => {
                // Its database is made by this server: the version it was made with is kept with its session (T-32).
                let session = server.create_session(&d.agent.name).await?["id"].as_str().unwrap_or_default().to_owned();
                let (kept, version) = (session.clone(), server.version().to_owned());
                self.record_meta(id, "opencode/session", json!({"sessionId":session,"version":version}), move |m| {
                    m.agent.opencode_session_id = Some(kept);
                    m.agent.opencode_major = opencode::major(&version);
                    m.agent.opencode_version = Some(version);
                }).await?;
                session
            }
        };
        // The Agent's Workspace MCP credential is handed to OpenCode first;
        // readiness is announced only after OpenCode reports reaching it.
        let mcp = match self.collaboration_http_config(&d.agent).await? {
            Some(config) => Some(workspace_mcp(&server, &config, false).await),
            None => None,
        };
        // Subscribed before the snapshot, so nothing between them is missed.
        let events = server.subscribe(opencode::EVENT_IDLE_LIMIT).await?;
        let children = sub_agents(&server, &session).await?;
        let snapshot = server.snapshot(&session, &children.keys().cloned().collect::<Vec<_>>()).await?;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let c = Connection::new(generation, server.clone(), session.clone(), children.clone(), files);
        // Each listed model's context window, read once as it connects (T-10).
        if let Ok(models) = server.models().await {
            c.windows(&models);
        }
        let owned = self.owner(id).await;
        self.opencodes.lock().unwrap().insert(id.into(), c.clone());
        let (agent, data) = (id.to_owned(), json!({"sessionId":session,"generation":generation,"version":server.version()}));
        let usage = c.clone();
        // Compared as before, since it changes Turns, without returning a copy
        // of the record nobody reads (T-140).
        let ready = self.stored_owned(owned, move |store| store.record_event(&agent, "opencode/ready", &data, Sel::Tail(TAIL), move |d| {
            d.agent.connection_state = "connected".into();
            d.agent.status = "idle".into();
            d.agent.error = None;
            restarted(d);
            apply_snapshot(d, generation, &session, &snapshot, &children, &usage);
            refresh_status(d);
        }).map(drop)).await;
        if let Err(error) = ready {
            let _owned = self.owner(id).await;
            let mut connections = self.opencodes.lock().unwrap();
            if connections.get(id).is_some_and(|c| c.generation == generation) {
                connections.remove(id);
            }
            return Err(error);
        }
        // The snapshot's newest answer named a model the list didn't have.
        if let Some(model) = c.wanted() {
            let (ws, agent, usage) = (self.clone(), id.to_owned(), c.clone());
            tokio::spawn(async move { ws.opencode_context_window(&agent, &usage, model).await });
        }
        if let Some(state) = mcp {
            self.opencode_mcp_reported(id, generation, state).await;
        }
        self.opencode_watch(id, generation, events, Arc::downgrade(&server));
        self.changed(id);
        Ok(c)
    }

    /// The connection's event stream, read until its generation is gone. It
    /// holds neither the Workspace nor the server, so dropping the Workspace
    /// ends OpenCode and then this.
    /// Before a message, and on a reconnect (`retry`), with Workspace MCP on:
    /// the Agent's Workspace MCP handed to its OpenCode again
    /// (`workspace_mcp`), so that one OpenCode dropped with the Agent's folder
    /// is back before the message goes (T-61 slice 1); readiness as OpenCode
    /// then reports it; and the message refused unless it is ready.
    async fn opencode_mcp(&self, id: &str, agent: &crate::model::Agent, c: &Connection, retry: bool) -> Result<()> {
        if let Some(config) = self.collaboration_http_config(agent).await? {
            let state = workspace_mcp(&c.server, &config, retry).await;
            self.opencode_mcp_reported(id, c.generation, state).await;
        }
        self.require_collaboration(id).await
    }

    /// Readiness of connection `generation`, as its OpenCode reported the
    /// Workspace MCP server: ready only once connected.
    async fn opencode_mcp_reported(&self, id: &str, generation: u64, state: Mcp) {
        match state {
            Mcp::Connected => self.collaboration_started(id, generation).await,
            Mcp::NotConnected(native) => self.collaboration_refused(id, generation, &native).await,
            Mcp::Pending => self.collaboration_refused(id, generation, &json!({"status":"pending"})).await,
            Mcp::Absent => self.collaboration_refused(id, generation, &json!({"status":"notListed"})).await,
        }
    }

    fn opencode_watch(self: &Arc<Self>, id: &str, generation: u64, mut events: Events, server: Weak<Server>) {
        let (ws, id) = (Arc::downgrade(self), id.to_owned());
        tokio::spawn(async move {
            loop {
                let next = events.next().await;
                let Some(workspace) = ws.upgrade() else { return };
                match next {
                    Ok(Some(event)) => workspace.dispatch_opencode_event(&id, generation, event).await,
                    ended => {
                        if workspace.opencode_current(&id, generation).is_none() {
                            return;
                        }
                        let reason = match ended {
                            Err(error) => error.to_string(),
                            _ => "OpenCode 结束了事件流".into(),
                        };
                        match workspace.opencode_resubscribe(&id, generation, &server).await {
                            Some(again) => events = again,
                            None => {
                                workspace.opencode_disconnected(&id, generation, &reason).await;
                                return;
                            }
                        }
                    }
                }
            }
        });
    }

    async fn opencode_resubscribe(&self, id: &str, generation: u64, server: &Weak<Server>) -> Option<Events> {
        for wait in RESUBSCRIBE {
            tokio::time::sleep(wait).await;
            let server = server.upgrade()?;
            let c = self.opencode_current(id, generation)?;
            let Ok(events) = server.subscribe(opencode::EVENT_IDLE_LIMIT).await else { continue };
            // What happened while no stream was open, read after the new one opened.
            if self.opencode_resync(id, &c).await.is_ok() {
                return Some(events);
            }
        }
        None
    }

    async fn opencode_resync(&self, id: &str, c: &Connection) -> Result<()> {
        for (child, info) in sub_agents(&c.server, &c.session).await? {
            c.adopt(&child, &c.session, info);
        }
        // A read begun before a removal was recorded is stale: it is read
        // again, never published over what that removal found (Lead 3895).
        // The removal is recorded with the ownership lock held, as this is
        // published, so the two never cross.
        let mut tries = 0;
        let (snapshot, owned) = loop {
            let mark = c.removals.load(std::sync::atomic::Ordering::SeqCst);
            let snapshot = c.server.snapshot(&c.session, &c.known_children()).await?;
            let owned = self.owner(id).await;
            if c.removals.load(std::sync::atomic::Ordering::SeqCst) == mark {
                break (snapshot, owned);
            }
            drop(owned);
            tries += 1;
            ensure!(tries < 3, "OpenCode's record changed while it was read, each time");
        };
        let children = c.children.lock().unwrap().clone();
        if self.opencode_current(id, c.generation).is_none() {
            return Ok(());
        }
        let (agent, generation, session) = (id.to_owned(), c.generation, c.session.clone());
        let data = json!({"generation":generation,"messages":snapshot.messages.as_array().map_or(0, Vec::len),
            "status":snapshot.status,"permissions":snapshot.permissions.len(),"questions":snapshot.questions.len()});
        let usage = c.clone();
        self.stored_owned(owned, move |store| store.record_event(&agent, "opencode/resynced", &data, Sel::Tail(TAIL), move |d| {
            apply_snapshot(d, generation, &session, &snapshot, &children, &usage);
            refresh_status(d);
        }).map(drop)).await?;
        self.changed(id);
        if let Some(model) = c.wanted() {
            self.opencode_context_window(id, c, model).await;
        }
        Ok(())
    }

    /// The catalog read again for a model an answer named that this
    /// connection's list didn't have (T-10): once for each such model, and
    /// then that answer measured, if it's still the newest of the Turn's
    /// latest input and nothing has made it stale since. Otherwise the
    /// answer stays unmeasured.
    async fn opencode_context_window(&self, id: &str, c: &Connection, model: String) {
        let Ok(models) = c.server.models().await else { return };
        c.windows(&models);
        let (window, pending) = {
            let mut usage = c.usage.lock().unwrap();
            let window = usage.windows.get(&model).copied();
            match usage.pending.take() {
                Some(pending) if pending.model == model && pending.epoch == usage.epoch => (window, pending),
                other => {
                    usage.pending = other;
                    return;
                }
            }
        };
        let Some(window) = window else { return };
        let owned = self.owner(id).await;
        if self.opencode_current(id, c.generation).is_none() {
            return;
        }
        let (agent, data, usage) = (id.to_owned(), json!({"model":model,"window":window}), c.clone());
        let turn = pending.turn.clone();
        let _ = self.stored_owned(owned, move |store| store.record_event(&agent, "opencode/contextWindow", &data, Sel::Turns(vec![turn]), move |d| {
            // Checked as it is written: still the newest answer considered in
            // this session, to the latest input of the newest Turn, and
            // nothing since made it stale.
            let current = usage.usage.lock().unwrap().epoch == pending.epoch;
            let turn = d.turns.last().filter(|t| t["id"] == pending.turn.as_str());
            let latest = turn.and_then(latest_input) == Some(pending.parent.as_str());
            let newest = seen(d, &usage.session) == Some((pending.at, pending.answer.as_str()));
            if current && latest && newest {
                if let Some(at) = chrono::DateTime::from_timestamp_millis(pending.at) {
                    if let Some(measured) = ContextUsage::measured(pending.used, window, &pending.turn, at) {
                        d.context_usage = Some(measured);
                    }
                }
            }
        }).map(drop)).await;
        self.changed(id);
    }

    /// One event, off the async workers, under the Agent's ownership lock,
    /// applied only while its connection is the Agent's current one.
    pub(crate) async fn dispatch_opencode_event(self: &Arc<Self>, id: &str, generation: u64, event: Value) {
        let _event = self.admission.enter_event();
        let owned = self.owner(id).await;
        let (ws, agent) = (self.clone(), id.to_owned());
        let handled = crate::db::blocking(move || {
            let _owned = owned;
            ws.opencode_event(&agent, generation, &event);
            Ok(())
        });
        if let Err(error) = handled.await {
            eprintln!("Workspace OpenCode event not handled: {error}");
        }
        // An answer's model this connection didn't list: read the catalog
        // again, off the event stream.
        if let Some(c) = self.opencode_current(id, generation) {
            if let Some(model) = c.wanted() {
                let (ws, id) = (self.clone(), id.to_owned());
                tokio::spawn(async move { ws.opencode_context_window(&id, &c, model).await });
            }
        }
    }

    fn opencode_event(&self, id: &str, generation: u64, event: &Value) {
        let Some(c) = self.opencode_current(id, generation) else { return };
        let Some(session) = opencode::session_of(event) else { return };
        let kind = event["type"].as_str().unwrap_or("unknown");
        // 1.19.3's text as it streams: the completed part replaces it.
        if kind == "message.part.delta" {
            return;
        }
        // What it stands for in the shapes Core reads (T-32 slice 3b): a
        // 2.x event read as 1.19.3's were, a 1.19.3 one as it is.
        let read = c.cursor.lock().unwrap().read(event);
        for one in &read {
            c.learn(type_of(one), one);
        }
        // 2.x's text as it streams is written once gathered (opencode_v2),
        // journaled as the text it wrote; not one row per delta.
        let streamed = kind.ends_with(".delta");
        if streamed && read.is_empty() {
            return;
        }
        let journal = format!("opencode/{kind}");
        let kept = match &read[..] {
            [gathered] if streamed => journaled(gathered),
            _ => journaled(event),
        };
        if session != c.session {
            // A sub-agent's requests are the Agent's to answer; nothing else
            // of it changes the record. Any other session's is not the Agent's.
            let Some(child) = c.child(session) else { return };
            let asked: Vec<&Value> = read.iter().filter(|one| requested(type_of(one))).collect();
            if asked.is_empty() {
                return;
            }
            let written = self.store.record_event(id, &journal, &kept, Sel::Open, |d| {
                for one in &asked {
                    request(d, generation, session, Some(&child), one);
                }
                refresh_status(d);
            });
            if let Err(error) = written {
                eprintln!("Workspace OpenCode event not recorded: {error:#}");
            }
            self.changed(id);
            return;
        }
        let applied: Vec<&Value> = read.iter().filter(|one| projected(type_of(one)) || type_of(one) == "message.part.delta").collect();
        let written = if applied.is_empty() {
            // Kept as evidence; it changes nothing here.
            self.store.update_meta(id, &journal, &kept, |_| {}).map(drop)
        } else {
            applied.iter().try_fold(Vec::new(), |mut turns, one| {
                turns.extend(event_turns(&self.store, id, one)?);
                Ok::<_, anyhow::Error>(turns)
            }).and_then(|turns| self.store.record_event(id, &journal, &kept, Sel::Turns(turns), |d| {
                for one in &applied {
                    project(d, generation, &c.session, one);
                    if type_of(one) == "message.updated" {
                        measure(d, &c, &one["data"]["info"]);
                    }
                }
                refresh_status(d);
            }).map(drop))
        };
        if let Err(error) = written {
            eprintln!("Workspace OpenCode event not recorded: {error:#}");
        }
        self.changed(id);
    }

    async fn opencode_disconnected(&self, id: &str, generation: u64, reason: &str) {
        let owned = self.owner(id).await;
        let removed = {
            let mut connections = self.opencodes.lock().unwrap();
            if connections.get(id).is_some_and(|c| c.generation == generation) { connections.remove(id) } else { None }
        };
        // Dropped once this ends, which ends its process group.
        let Some(_removed) = removed else { return };
        let message = format!("OpenCode 连接已结束（{reason}）；执行完成情况未获确认，不会重发。重连会从同一 Session 读取它保存的历史。");
        let (agent, data) = (id.to_owned(), json!({"error":message,"generation":generation}));
        let _ = self.stored_owned(owned, move |store| store.record_event(&agent, "runtime/error", &data, Sel::Open, move |d| {
            let busy = d.turns.iter().any(|t| t["status"] == "inProgress");
            ended(d, &message);
            stale(d);
            d.agent.connection_state = "disconnected".into();
            d.agent.status = if busy { "uncertain" } else { "offline" }.into();
            d.agent.error = Some(message);
        }).map(drop)).await;
        self.changed(id);
    }

    /// `send` for an OpenCode Agent.
    pub(crate) async fn opencode_send(self: &Arc<Self>, id: &str, text: String) -> Result<Value> {
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
        self.opencode_after_restart(id, &d).await?;
        self.opencode_send_locked(id, text, None).await
    }

    /// Before a receipt is recorded (send_message): what an OpenCode Agent
    /// takes is a new message while it is idle, with Workspace MCP ready.
    pub(crate) async fn opencode_admit(self: &Arc<Self>, id: &str, input: &crate::model::MessageInput, detail: &AgentDetail) -> Result<()> {
        // A form's answers are a new message too, checked before (send_message).
        ensure!(input.question.is_none(), "OpenCode Agent 目前只接受空闲时的新消息；草稿保留");
        if let Some(expected) = &input.expected_turn_id {
            return self.opencode_admit_input(id, input, detail, expected).await;
        }
        if let Some(blocked) = compaction_blocks(detail, "这条消息没有发送，草稿保留") {
            bail!(blocked);
        }
        self.opencode_after_restart(id, detail).await?;
        ensure!(!busy(detail), "OpenCode 正在执行或等待回应；这条消息没有发送，草稿保留");
        let c = self.opencode_ensure(id).await?;
        // A chosen model or variant OpenCode no longer lists: refused before a receipt.
        let model = chosen(&c.server, &detail.agent.model).await?;
        chosen_variant(model.as_ref(), detail.agent.settings.reasoning_effort.as_deref())?;
        if !input.images.is_empty() {
            takes_images(model.as_ref())?;
            ensure!(listed_command(&c.server, &input.text).await?.is_none(), IMAGES_WITH_COMMAND);
        }
        self.opencode_mcp(id, &detail.agent, &c, false).await
    }

    /// Before the receipt of a message added to the running Turn `expected`
    /// (T-10): only on the connection that runs it, never one started for it.
    async fn opencode_admit_input(self: &Arc<Self>, id: &str, input: &crate::model::MessageInput, detail: &AgentDetail, expected: &str) -> Result<()> {
        if let Some(blocked) = compaction_blocks(detail, "补充消息未发送，草稿保留") {
            bail!(blocked);
        }
        joinable(detail, expected)?;
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode 连接已断开；补充消息未发送，草稿保留")?;
        let model = chosen(&c.server, &detail.agent.model).await?;
        chosen_variant(model.as_ref(), detail.agent.settings.reasoning_effort.as_deref())?;
        if !input.images.is_empty() {
            takes_images(model.as_ref())?;
        }
        ensure!(listed_command(&c.server, &input.text).await?.is_none(), COMMAND_WHILE_RUNNING);
        self.opencode_mcp(id, &detail.agent, &c, false).await
    }

    /// Under the Agent gate, before a message: what a restart of Core leaves
    /// (`Store::open`), the Agent offline with no connection and its last Turn
    /// still marked running, is not a busy OpenCode. As for Codex
    /// (`confirm_previous_turn`), its own session is connected again, which
    /// settles that Turn, and this message is not sent: nothing is recorded
    /// for it, and the user sends it again once they have seen that Turn. An
    /// Agent connected now goes on as before.
    async fn opencode_after_restart(self: &Arc<Self>, id: &str, detail: &AgentDetail) -> Result<()> {
        let restarted = detail.agent.status == "offline" && detail.turns.iter().any(|t| t["status"] == "inProgress")
            && !self.opencodes.lock().unwrap().contains_key(id);
        if !restarted {
            return Ok(());
        }
        self.opencode_ensure(id).await?;
        bail!("已重新核对原会话；本次消息没有发送。请查看恢复的执行结果，再决定是否发送新任务");
    }

    /// Under the Agent gate: one new prompt while OpenCode is idle. Ok means
    /// OpenCode stored it under its ID; a send whose outcome is unknown is an
    /// `OutcomeUnknown`, and is never sent again.
    pub(crate) async fn opencode_send_locked(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>) -> Result<Value> {
        self.opencode_send_images_locked(id, text, client_id, &[], false).await
    }

    /// As `opencode_send_locked`, with the message's images (T-10). With
    /// `commands`, a message the user sent as `/<name> [arguments]` for a
    /// command OpenCode defines runs as that command; other callers' text is
    /// always a prompt.
    pub(crate) async fn opencode_send_images_locked(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>, images: &[String], commands: bool) -> Result<Value> {
        let mut sent = false;
        let result = self.opencode_send_once(id, text, client_id, images, commands, &mut sent).await;
        if let (Err(error), false, Some(client)) = (&result, sent, client_id) {
            self.opencode_not_sent(id, client, error.to_string()).await;
        }
        result
    }

    /// It was never sent, or OpenCode refused it. Its receipt says so, even
    /// if a connection that ended meanwhile settled it as unknown.
    async fn opencode_not_sent(&self, id: &str, client: &str, message: String) {
        let client = client.to_owned();
        let named = client.clone();
        let recorded = self.record_receipt(id, "opencode/notSent", json!({"clientMessageId":client,"error":message}), &named, move |m| {
            if let Some(receipt) = m.message_receipts.iter_mut().find(|r| r.input.client_message_id == client) {
                if matches!(receipt.status.as_str(), "sending" | "unknown") {
                    receipt.status = "rejected".into();
                    receipt.error = Some(message);
                }
            }
        }).await;
        if let Err(error) = recorded {
            eprintln!("Workspace OpenCode receipt not corrected: {error:#}");
        }
        self.changed(id);
    }

    /// Under the Agent gate: a message the user adds to the running Turn
    /// `expected` (T-10). OpenCode 1.19.3 stores a prompt sent while its run
    /// goes on, and that run answers it from its next step: `prompt` stores
    /// it and joins the running run (`SessionRunState.ensureRunning`), whose
    /// loop answers the newest user message. It is recorded in that Turn
    /// before it is sent, under a message ID of its own, confirmed by the
    /// message OpenCode stores under it, and never sent again.
    pub(crate) async fn opencode_add_input_locked(self: &Arc<Self>, id: &str, text: &str, expected: &str, client_id: &str, images: &[String]) -> Result<Value> {
        let mut sent = false;
        let result = self.opencode_add_input_once(id, text, expected, client_id, images, &mut sent).await;
        if let (Err(error), false) = (&result, sent) {
            self.opencode_not_sent(id, client_id, error.to_string()).await;
        }
        result
    }

    async fn opencode_add_input_once(self: &Arc<Self>, id: &str, text: &str, expected: &str, client_id: &str, images: &[String], sent: &mut bool) -> Result<Value> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        if let Some(blocked) = compaction_blocks(&d, "补充消息未发送，草稿保留") {
            bail!(blocked);
        }
        joinable(&d, expected)?;
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode 连接已断开；补充消息未发送，草稿保留")?;
        self.opencode_mcp(id, &d.agent, &c, false).await?;
        let model = chosen(&c.server, &d.agent.model).await?;
        let variant = chosen_variant(model.as_ref(), d.agent.settings.reasoning_effort.as_deref())?;
        ensure!(listed_command(&c.server, text).await?.is_none(), COMMAND_WHILE_RUNNING);
        let (files, shown) = if images.is_empty() { (vec![], vec![]) } else {
            takes_images(model.as_ref())?;
            let (root, agent, images) = (self.data_dir.clone(), id.to_owned(), images.to_vec());
            tokio::task::spawn_blocking(move || anyhow::Ok((crate::input_images::opencode_images(&root, &agent, &images)?,
                crate::input_images::history_images(&root, &agent, &images)))).await??
        };
        // The model is made the session's before anything of the message enters the Turn (R1 276dd516): a read or
        // switch that fails leaves the Turn as it was.
        choose_for(&c, model.as_ref(), variant.as_deref()).await?;
        ensure!(self.opencode_current(id, c.generation).is_some(), "OpenCode 连接已变化，补充消息未发送；草稿保留");
        let message = MessageId::new();
        let input = message.as_str().to_owned();
        let words = (!text.is_empty()).then(|| json!({"type":"text","text":text}));
        let content = Value::Array(words.into_iter().chain(shown).collect());
        let (turn, added, client) = (expected.to_owned(), input.clone(), client_id.to_owned());
        // A new input: what was measured before it is last known (T-10).
        c.unmeasured();
        // Added only while that Turn still runs: one that ended meanwhile
        // takes nothing, and the message is not sent.
        self.record_update(id, "opencode/inputRequested", json!({"turnId":expected,"messageId":input,"clientMessageId":client_id,
            "text":text,"images":images,"model":model.as_ref().map(ModelChoice::id),"variant":variant}),
            Sel::Turns(vec![turn.clone()]), move |d| {
            stale(d);
            let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str() && t["status"] == "inProgress") else { return };
            if !entry["_opencodeInputs"].is_object() {
                entry["_opencodeInputs"] = json!({});
            }
            let previous = entry["_opencodeLastInput"].clone();
            entry["_opencodeInputs"][&added] = json!({"clientMessageId":client,"confirmed":false,"previous":previous});
            entry["_opencodeLastInput"] = added.clone().into();
            let mut item = json!({"id":format!("{added}:input"),"type":"userMessage","content":content,"nativeMessageId":added});
            crate::conversation_time::stamp_message(&mut item, Some(crate::conversation_time::now_ms()), "core");
            if !entry["items"].is_array() {
                entry["items"] = json!([]);
            }
            entry["items"].as_array_mut().expect("turn items").push(item);
            if let Some(receipt) = d.message_receipts.iter_mut().find(|r| r.input.client_message_id == client) {
                receipt.turn_id = Some(turn.clone());
            }
        }).await?;
        self.changed(id);
        let held = self.send_view(id).await?.turns.iter().any(|t| t["id"] == expected && t["_opencodeInputs"].get(&input).is_some());
        ensure!(held, "原 Turn 已结束或发生变化；消息仍保留，请确认后作为新消息发送");
        *sent = true;
        let mut submitted = c.server.submit_with(&c.session, &message, text, &files).await;
        // A 400 refuses it only when OpenCode's record, read after it, has no
        // message under its ID, as for a command (#435): an event that already
        // confirmed it makes it delivered, and a record that could not be read
        // leaves it unknown.
        if let Ok(Submission::Refused(status)) = &submitted {
            let confirmed = self.send_view(id).await.is_ok_and(|d| d.turns.iter()
                .any(|t| t["id"] == expected && t["_opencodeInputs"][&input]["confirmed"] == true));
            let stored = if confirmed { Some(true) } else { c.server.message(&c.session, &message).await.ok().map(|m| m.is_some()) };
            match stored {
                Some(true) => submitted = Ok(Submission::Accepted),
                Some(false) => {}
                None => submitted = Ok(Submission::Unknown(format!("{status}, and its record of the message could not be read"))),
            }
        }
        let refused = match &submitted {
            Ok(Submission::Refused(status)) => Some(format!("OpenCode 拒绝了这条补充消息（HTTP {}），它没有收下：{}", status.code, status.body)),
            Err(error) => Some(format!("补充消息没有发送：{error}")),
            Ok(Submission::Accepted | Submission::Unknown(_)) => None,
        };
        if let Some(error) = refused {
            // Not taken: the Turn goes on without it.
            *sent = false;
            let (turn, removed) = (expected.to_owned(), input.clone());
            self.record_update(id, "opencode/inputRefused", json!({"turnId":expected,"messageId":input,"error":error}),
                Sel::Turns(vec![turn.clone()]), move |d| {
                let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str()) else { return };
                let previous = entry["_opencodeInputs"][&removed]["previous"].clone();
                if let Some(inputs) = entry["_opencodeInputs"].as_object_mut() {
                    inputs.remove(&removed);
                }
                if entry["_opencodeLastInput"] == removed.as_str() {
                    entry["_opencodeLastInput"] = previous;
                }
                let shown = format!("{removed}:input");
                if let Some(items) = entry["items"].as_array_mut() {
                    items.retain(|i| i["id"] != shown.as_str());
                }
            }).await?;
            self.changed(id);
            // An idle that came while it was unconfirmed decided nothing, and
            // none may follow: OpenCode's status now says whether the run ended.
            if c.server.session_status(&c.session).await.is_ok_and(|now| now["type"] == "idle") {
                let turn = expected.to_owned();
                let _ = self.record_update(id, "opencode/statusRead", json!({"turnId":expected,"status":{"type":"idle"}}),
                    Sel::Turns(vec![turn]), |d| {
                    status(d, &json!({"type":"idle"}));
                    refresh_status(d);
                }).await;
                self.changed(id);
            }
            bail!(error);
        }
        if self.opencode_confirm_input(id, &c, expected, &message).await {
            return Ok(json!({"turnId":expected}));
        }
        let detail = match &submitted { Ok(Submission::Unknown(reason)) => reason.clone(), _ => "HTTP 204".into() };
        let (turn, unconfirmed) = (expected.to_owned(), input.clone());
        self.record_update(id, "opencode/inputUnconfirmed", json!({"turnId":expected,"messageId":input,"submission":detail}),
            Sel::Turns(vec![turn.clone()]), move |d| {
            let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str()) else { return };
            entry["_opencodeInputs"][&unconfirmed]["deliveryUnconfirmed"] = true.into();
            let shown = format!("{unconfirmed}:input");
            if let Some(item) = entry["items"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["id"] == shown.as_str())) {
                item["deliveryUnconfirmed"] = true.into();
            }
        }).await?;
        self.changed(id);
        Err(OutcomeUnknown(format!("OpenCode 没有按这条补充消息的编号确认收到它（{detail}）；不会重发。若它已收下，结果仍会显示在这一轮。")).into())
    }

    /// Whether OpenCode stored the message added to `turn` under `message`,
    /// by its own record or the event that confirmed it, within CONFIRM_LIMIT.
    async fn opencode_confirm_input(&self, id: &str, c: &Connection, turn: &str, message: &MessageId) -> bool {
        let deadline = Instant::now() + CONFIRM_LIMIT;
        loop {
            let confirmed = self.send_view(id).await.is_ok_and(|d| d.turns.iter()
                .any(|t| t["id"] == turn && t["_opencodeInputs"][message.as_str()]["confirmed"] == true));
            if confirmed || c.server.message(&c.session, message).await.is_ok_and(|m| m.is_some()) {
                let input = message.as_str().to_owned();
                let _ = self.record_update(id, "opencode/inputConfirmed", json!({"turnId":turn,"messageId":input}),
                    Sel::Turns(vec![turn.to_owned()]), move |d| confirm_input(d, &input)).await;
                self.changed(id);
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// `sent`: whether OpenCode may have taken the prompt (asked, and not refused).
    async fn opencode_send_once(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>, images: &[String], commands: bool, sent: &mut bool) -> Result<Value> {
        // Also what a send that does not come through `send_message` meets (T-10 Revert).
        self.ensure_rewind_settled(id).await?;
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        if let Some(blocked) = compaction_blocks(&d, "这条消息没有发送") {
            bail!(blocked);
        }
        ensure!(!busy(&d), "OpenCode 正在执行或等待回应；这条消息没有发送");
        let c = self.opencode_ensure(id).await?;
        self.opencode_mcp(id, &d.agent, &c, false).await?;
        // The model and variant it goes with, as OpenCode lists them now (or its own).
        let model = chosen(&c.server, &d.agent.model).await?;
        let variant = chosen_variant(model.as_ref(), d.agent.settings.reasoning_effort.as_deref())?;
        // A command OpenCode defines, as `/<name> [arguments]` (T-10): run as
        // that command, with no images.
        let command = if commands { listed_command(&c.server, &text).await? } else { None };
        ensure!(command.is_none() || images.is_empty(), IMAGES_WITH_COMMAND);
        // Its images, for that model only, each this Agent's own and as it
        // was saved, read off the async workers: what OpenCode is given and
        // what the conversation shows.
        let (files, shown) = if images.is_empty() { (vec![], vec![]) } else {
            takes_images(model.as_ref())?;
            let (root, agent, images) = (self.data_dir.clone(), id.to_owned(), images.to_vec());
            tokio::task::spawn_blocking(move || anyhow::Ok((crate::input_images::opencode_images(&root, &agent, &images)?,
                crate::input_images::history_images(&root, &agent, &images)))).await??
        };
        // A prompt's model is made the session's before its Turn is recorded (R3 4051b7d4), as an added message's
        // is: a read or switch that fails rejects it, with no Turn. A command's model goes with the command.
        if command.is_none() {
            choose_for(&c, model.as_ref(), variant.as_deref()).await?;
        }
        ensure!(self.opencode_current(id, c.generation).is_some(), "OpenCode 连接已变化，消息未发送；草稿保留");
        let message = MessageId::new();
        let turn = message.as_str().to_owned();
        // Recorded before it is sent: its ID is the only way to learn what
        // became of it.
        let words = (!text.is_empty()).then(|| json!({"type":"text","text":text}));
        let (requested, client, content) = (turn.clone(), client_id.map(str::to_owned), Value::Array(words.into_iter().chain(shown).collect()));
        let (named, arguments, own_model) = command.as_ref().map_or((None, None, None), |(c, a)| (Some(c.name.clone()), Some(a.clone()), c.model.clone()));
        // A new input: what was measured before it is last known (T-10).
        c.unmeasured();
        self.record_update(id, "opencode/turnRequested", json!({"turnId":turn,"messageId":turn,"clientMessageId":client_id,"text":text,
            "images":images,"model":model.as_ref().map(ModelChoice::id),"variant":variant,
            "command":named,"arguments":arguments,"commandModel":own_model}),
            Sel::Turns(vec![turn.clone()]), move |d| {
            stale(d);
            let entry = d.turn_mut(&requested);
            entry["status"] = "inProgress".into();
            entry["items"] = json!([{"id":format!("{requested}:input"),"type":"userMessage","content":content,"nativeMessageId":requested}]);
            let started = entry["_yuzunoStartedAt"].as_i64();
            crate::conversation_time::stamp_message(&mut entry["items"][0], started, "core");
            if let Some(receipt) = client.and_then(|client| d.message_receipts.iter_mut().find(|r| r.input.client_message_id == client)) {
                receipt.turn_id = Some(requested.clone());
            }
            d.agent.status = "working".into();
            d.agent.error = None;
        }).await?;
        self.changed(id);
        *sent = true;
        let submitted = match &command {
            // A command's own model is OpenCode's choice over the Agent's:
            // the Agent's model and variant go only with one that names none.
            Some((command, arguments)) => {
                let (model, variant) = if command.model.is_some() { (None, None) } else { (model.as_ref().map(ModelChoice::id), variant.as_deref()) };
                self.opencode_command_started(id, &c, &message, &command.name, arguments, model.as_deref(), variant).await
            }
            None => c.server.submit_with(&c.session, &message, &text, &files).await,
        };
        let refused = match &submitted {
            // 2.x has no 1.19.3 route to run a command: it answers 405 (T-32 slice 4a), until the commands slice.
            Ok(Submission::Refused(status)) if status.code == 405 && command.is_some() =>
                Some(format!("{}；命令没有执行", crate::opencode_v2::NOT_YET)),
            Ok(Submission::Refused(status)) => Some(format!("OpenCode 拒绝了这条消息（HTTP {}），它没有收下：{}", status.code, status.body)),
            // Refused here, before any request.
            Err(error) => Some(format!("消息没有发送：{error}")),
            Ok(Submission::Accepted | Submission::Unknown(_)) => None,
        };
        if let Some(message) = refused {
            *sent = false;
            let (failed, error) = (turn.clone(), message.clone());
            self.record_update(id, "opencode/promptRefused", json!({"turnId":turn,"error":message}), Sel::Turns(vec![turn.clone()]), move |d| {
                let entry = d.turn_mut(&failed);
                entry["status"] = "failed".into();
                entry["error"] = json!({"message":error});
                d.agent.status = "idle".into();
            }).await?;
            self.changed(id);
            bail!(message);
        }
        // Accepted (204) or no answer at all: only the stored message says it
        // arrived, looked for by the ID it was sent under.
        if self.opencode_confirm(id, &c, &message).await {
            return Ok(json!({"turnId":turn}));
        }
        let detail = match &submitted { Ok(Submission::Unknown(reason)) => reason.clone(), _ => "HTTP 204".into() };
        let unconfirmed = turn.clone();
        self.record_update(id, "opencode/deliveryUnconfirmed", json!({"turnId":turn,"submission":detail}), Sel::Turns(vec![turn.clone()]), move |d| {
            d.turn_mut(&unconfirmed)["deliveryUnconfirmed"] = true.into();
        }).await?;
        self.changed(id);
        Err(OutcomeUnknown(format!("OpenCode 没有按这条消息的编号确认收到它（{detail}）；不会重发。若它已收下，结果仍会显示在这一轮。")).into())
    }

    /// Starts a command under `message` (T-10), its request held open for
    /// the run (`Server::command`), and says what is known of its start:
    /// refused when OpenCode answered 400 and its record, read after that
    /// answer, has no message under that ID (as for an unknown command,
    /// refused before it runs); accepted once OpenCode stored the message, or
    /// answered; otherwise unknown: after COMMAND_START, or when that record
    /// could not be read. A 400 once the message exists is the run's own
    /// failure, which OpenCode's record of the Turn tells, as for a prompt.
    async fn opencode_command_started(&self, id: &str, c: &Connection, message: &MessageId, name: &str, arguments: &str,
        model: Option<&str>, variant: Option<&str>) -> Result<Submission> {
        let request = c.server.command(&c.session, message, name, arguments, model, variant)?;
        let (tx, mut answer) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = tx.send(request.await);
        });
        // Whether OpenCode holds the message: by the event that confirmed
        // it, else by its record; None when that record could not be read.
        let stored = || async {
            if self.send_view(id).await.is_ok_and(|d| d.turns.iter().any(|t| t["id"] == message.as_str() && t["_opencodeConfirmed"] == true)) {
                return Some(true);
            }
            c.server.message(&c.session, message).await.ok().map(|m| m.is_some())
        };
        let deadline = Instant::now() + COMMAND_START;
        loop {
            match answer.try_recv() {
                Ok(Submission::Refused(status)) => {
                    return Ok(match stored().await {
                        Some(true) => Submission::Accepted,
                        Some(false) => Submission::Refused(status),
                        None => Submission::Unknown(format!("{status}, and its record of the message could not be read")),
                    });
                }
                Ok(other) => return Ok(other),
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    return Ok(Submission::Unknown("the command's request ended without an answer".into()));
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
            }
            if stored().await == Some(true) {
                return Ok(Submission::Accepted);
            }
            if Instant::now() >= deadline {
                return Ok(Submission::Unknown("no answer yet: a command's request is answered when its run ends".into()));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Whether OpenCode stored the message sent under `message`, by its own
    /// record or the event that confirmed it, within CONFIRM_LIMIT.
    async fn opencode_confirm(&self, id: &str, c: &Connection, message: &MessageId) -> bool {
        let deadline = Instant::now() + CONFIRM_LIMIT;
        loop {
            let confirmed = self.send_view(id).await.is_ok_and(|d| d.turns.iter().any(|t| t["id"] == message.as_str() && t["_opencodeConfirmed"] == true));
            if confirmed || c.server.message(&c.session, message).await.is_ok_and(|m| m.is_some()) {
                let turn = message.as_str().to_owned();
                let _ = self.record_update(id, "opencode/messageConfirmed", json!({"turnId":turn}), Sel::Turns(vec![turn.clone()]), move |d| confirm(d, &turn)).await;
                self.changed(id);
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub(crate) async fn opencode_interrupt(&self, id: &str) -> Result<()> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        let turn = d.turns.iter().rev().find(|t| t["status"] == "inProgress").and_then(|t| t["id"].as_str())
            .context("没有正在执行的 OpenCode Turn")?.to_owned();
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode 连接已断开，无法确认中断")?;
        let requested = turn.clone();
        self.record_update(id, "opencode/interruptRequested", json!({"turnId":turn}), Sel::Turns(vec![turn.clone()]), move |d| {
            d.turn_mut(&requested)["interruptRequested"] = true.into();
        }).await?;
        self.changed(id);
        c.server.abort(&c.session).await?;
        // OpenCode's own end of the run, not this answer, ends the Turn.
        Ok(())
    }

    /// The user's `/compact` for an OpenCode Agent (T-10, contract on T-10
    /// #3109): OpenCode's own compaction of the Agent's session, under the
    /// Agent gate, on the connection already serving it, only while the
    /// Agent and the session are idle and nothing earlier waits to be
    /// confirmed. Read first, with nothing sent if any read fails: the
    /// session, refused while a revert waits in it (`summarize` would apply
    /// it first, deleting messages), its status and its messages. Recorded
    /// before the request (`compactRequested`): the model asked for and the
    /// compaction messages already there, so only a new one can be this
    /// compaction's. The request goes in the background, as a command's
    /// does; what is known of its start within COMMAND_START is the answer
    /// here, and nothing is ever sent again.
    pub async fn opencode_compact(self: &Arc<Self>, id: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        // A revert whose outcome is not known may still be applied by it (T-10 Revert).
        self.ensure_rewind_settled(id).await?;
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        ensure!(d.agent.harness == "opencode", "Agent 不是 OpenCode");
        if let Some(blocked) = compaction_blocks(&d, "没有执行 /compact") {
            bail!(blocked);
        }
        ensure!(!d.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")),
            "上一条消息的发送结果尚未确认，请先重连核对；没有执行 /compact");
        self.opencode_after_restart(id, &d).await?;
        ensure!(!busy(&d), "OpenCode 正在执行或等待回应；/compact 只在空闲时执行，没有执行");
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode Agent 尚未连接；连接后才能压缩，没有执行 /compact")?;
        let unread = "没有读到 OpenCode 会话现在的状态；没有执行 /compact";
        let session = c.server.session(&c.session).await.context(unread)?;
        // A revert the session holds is applied with its next message, and a
        // compaction would apply it first: only a message clears it from
        // here (R3 of #534).
        ensure!(session["revert"].is_null(),
            "OpenCode 会话里的回退要到这个会话收到下一条消息时才会删去被回退的消息，压缩会先把它应用掉；请先发一条消息，再压缩。没有执行 /compact");
        ensure!(c.server.session_status(&c.session).await.context(unread)?["type"] == "idle", "OpenCode 会话不是空闲状态；没有执行 /compact");
        let messages = c.server.messages(&c.session).await.context(unread)?;
        ensure!(!crate::opencode_v2::is_v2(&messages), "{}；没有执行 /compact", crate::opencode_v2::NOT_YET);
        let (provider, model) = compact_model(&c.server, &d, &messages).await?;
        let known = compaction_messages(&messages);
        ensure!(self.opencode_current(id, c.generation).is_some(), "OpenCode 连接已变化；没有执行 /compact");
        let turn = format!("compact_{}", uuid::Uuid::new_v4());
        let item = format!("{turn}:compaction");
        let attempt = json!({"state":"pending","session":c.session,"generation":c.generation,"providerID":provider,"modelID":model,
            "known":known,"candidates":{},"message":null,"summary":null,"answer":null});
        let (requested, data) = (turn.clone(), json!({"turnId":turn,"attempt":attempt}));
        self.record_update(id, "opencode/compactRequested", data, Sel::Turns(vec![turn.clone()]), move |d| {
            let entry = d.turn_mut(&requested);
            entry["status"] = "inProgress".into();
            entry["items"] = json!([{"id":item,"type":"contextCompaction","trigger":"manual"}]);
            entry["_yuzunoCompactionId"] = item.into();
            entry["_opencodeCompact"] = attempt;
            d.agent.status = "working".into();
            d.agent.error = None;
        }).await?;
        self.changed(id);
        let request = c.server.summarize(&c.session, &provider, &model)?;
        let (done, checked) = tokio::sync::oneshot::channel();
        // Only the generation, and the Workspace weakly: holding the
        // connection would hold its server, and so its process, until the
        // request ends. The request itself goes on until OpenCode answers.
        let (ws, agent, attempted, generation, session) = (Arc::downgrade(self), id.to_owned(), turn.clone(), c.generation, c.session.clone());
        tokio::spawn(async move {
            let answer = request.await;
            if let Some(ws) = ws.upgrade() {
                ws.opencode_compact_answered(&agent, generation, &session, &attempted, answer).await;
            }
            let _ = done.send(());
        });
        self.opencode_compact_started(id, &turn, checked).await
    }

    /// The user's giving up of a compaction OpenCode still holds unfinished
    /// (T-10, contract on T-10 #3150 and Lead 3773): only that compaction's
    /// own compaction part is removed, so that OpenCode's next run does not
    /// take it up under a new message. Its message, its summary (whose text,
    /// if any, may still reach the model, as an aborted answer's does) and
    /// every file stay; nothing is summarized, prompted or aborted.
    ///
    /// Under the Agent gate, and only with proof that its request ended
    /// where it went (200 and `true`): a whole read of the session must find
    /// it idle, the part still that message's, no summary of it that ended
    /// (then it is a compaction that happened), and nothing else left for
    /// OpenCode to take up (removing this part would not let a message in).
    /// New messages are let in again only once a whole read after the
    /// removal finds the session idle, the part gone and nothing left to take
    /// up. A lost answer is read for, never sent again; a part already gone
    /// is not asked for again. Another client of the same OpenCode could
    /// still change the session between the read and the removal.
    pub async fn opencode_compact_abandon(self: &Arc<Self>, id: &str, turn: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        let attempt = d.turns.iter().find(|t| t["id"] == turn).map(|t| t["_opencodeCompact"].clone()).filter(Value::is_object)
            .context("没有这次压缩")?;
        ensure!(attempt["nativePending"] == true || attempt["state"] == "unknown", "这次压缩没有留在 OpenCode 里的待办；不需要放弃");
        let (Some(message), Some(part)) = (attempt["message"].as_str().map(str::to_owned), attempt["part"].as_str().map(str::to_owned))
            else { bail!("不知道 OpenCode 里哪一条是这次压缩；不能放弃，没有删除任何内容") };
        ensure!(attempt["answer"]["kind"] == "ended" && attempt["answer"]["generation"] == attempt["generation"]
            && attempt["answer"]["session"] == attempt["session"],
            "还没有这次压缩的请求已经结束的证据（OpenCode 对它回答 200 和 true）；不能放弃，没有删除任何内容");
        ensure!(!d.turns.iter().any(|t| t["status"] == "inProgress" && t["id"] != turn), "OpenCode 正在执行；不能放弃，没有删除任何内容");
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode 未连接；连接后才能放弃，没有删除任何内容")?;
        ensure!(attempt["session"] == c.session.as_str(), "OpenCode 会话已变化；不能放弃，没有删除任何内容");
        // A whole read, by the same connection from start to end.
        let read = |what: &'static str| {
            let c = c.clone();
            async move {
                let messages = c.server.messages(&c.session).await.context(what)?;
                let idle = c.server.session_status(&c.session).await.context(what)?["type"] == "idle";
                anyhow::Ok((messages, idle))
            }
        };
        let unread = "没有读到 OpenCode 会话现在的状态；没有删除任何内容";
        let (messages, idle) = read(unread).await?;
        ensure!(self.opencode_current(id, c.generation).is_some(), "OpenCode 连接已变化；没有删除任何内容");
        ensure!(idle, "OpenCode 会话不是空闲状态；不能放弃，没有删除任何内容");
        let ended = summary_ended(&messages, &message);
        let (present, others) = (holds_part(&messages, &message, &part), pending_tasks(&messages).into_iter().filter(|p| *p != part).count());
        if ended {
            bail!("这次压缩在 OpenCode 里已经完成；没有删除任何内容。请重新连接核对");
        }
        ensure!(others == 0, "OpenCode 里还有其他待办的压缩或子任务；放弃这一次也不能让新消息进来，没有删除任何内容");
        let (attempted, data) = (turn.to_owned(), json!({"turnId":turn,"messageId":message,"partId":part,"present":present}));
        self.record_update(id, "opencode/compactAbandonRequested", data, Sel::Turns(vec![turn.to_owned()]), move |d| {
            if let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == attempted.as_str()) {
                entry["_opencodeCompact"]["abandonRequested"] = now().into();
            }
        }).await?;
        self.changed(id);
        // A part already gone is not asked for again; the read below decides.
        let removed = if present { Some(c.server.delete_part(&c.session, &message, &part).await) } else { None };
        let unread = "没有读到删除后的 OpenCode 会话；仍不发送新消息，可以再试一次";
        let after = read(unread).await;
        let current = self.opencode_current(id, c.generation).is_some();
        let outcome = match &after {
            Ok((messages, idle)) if current && *idle && !holds_part(messages, &message, &part) && pending_tasks(messages).is_empty()
                && !summary_ended(messages, &message) => Ok(()),
            Ok((messages, _)) if holds_part(messages, &message, &part) => Err("删除后，OpenCode 的记录里仍有这次压缩的待办；仍不发送新消息".to_owned()),
            Ok((_, false)) => Err("删除后 OpenCode 会话不是空闲状态；仍不发送新消息".to_owned()),
            Ok(_) if !current => Err("删除后 OpenCode 连接已变化；仍不发送新消息".to_owned()),
            Ok(_) => Err("删除后，OpenCode 里仍有待办，或这次压缩已经完成；仍不发送新消息。请重新连接核对".to_owned()),
            Err(error) => Err(format!("{error:#}")),
        };
        let removal = match &removed {
            None => json!("alreadyGone"),
            Some(Ok(())) => json!("answered"),
            Some(Err(error)) => json!({"error":format!("{error:#}")}),
        };
        let (attempted, settled) = (turn.to_owned(), outcome.clone());
        let data = json!({"turnId":turn,"removal":removal,"error":outcome.as_ref().err()});
        let kind = if outcome.is_ok() { "opencode/compactAbandoned" } else { "opencode/compactAbandonUnconfirmed" };
        // Recorded with the ownership lock held, after marking the removal:
        // a whole read begun before it is then never published over this
        // (`opencode_resync`), and one published already is followed by this.
        let owned = self.owner(id).await;
        c.removals.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let agent = id.to_owned();
        self.stored_owned(owned, move |store| store.record_event(&agent, kind, &data, Sel::Turns(vec![attempted.clone()]), move |d| {
            let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == attempted.as_str()) else { return };
            if settled.is_ok() {
                entry["_opencodeCompact"]["state"] = "abandoned".into();
                entry["_opencodeCompact"]["nativePending"] = false.into();
                entry["_opencodeCompact"]["abandonedAt"] = now().into();
            }
        }).map(drop)).await?;
        self.changed(id);
        match outcome {
            Ok(()) => Ok(json!({"abandoned":true,"turnId":turn})),
            Err(why) => bail!(why),
        }
    }

    /// What is known of a compaction's start (T-10): accepted once OpenCode
    /// wrote its compaction message, or the record read after its request's
    /// answer says it ran; refused when that read says OpenCode refused it;
    /// otherwise unknown, after COMMAND_START, with the request still going
    /// and the Turn still waiting for what OpenCode says.
    async fn opencode_compact_started(&self, id: &str, turn: &str, mut checked: tokio::sync::oneshot::Receiver<()>) -> Result<Value> {
        let deadline = Instant::now() + COMMAND_START;
        loop {
            let answered = !matches!(checked.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty));
            let d = self.send_view(id).await?;
            let entry = d.turns.iter().find(|t| t["id"] == turn).cloned().unwrap_or_default();
            let attempt = &entry["_opencodeCompact"];
            if attempt["state"] == "refused" {
                bail!("{}", entry["error"]["message"].as_str().unwrap_or("OpenCode 拒绝了 /compact"));
            }
            if attempt["state"] == "unknown" {
                return Err(OutcomeUnknown(entry["error"]["message"].as_str().unwrap_or("压缩的结果未确认，不会重发").to_owned()).into());
            }
            if attempt["message"].is_string() || attempt["state"] == "completed" {
                return Ok(json!({"accepted":true,"turnId":turn}));
            }
            if answered {
                return Err(OutcomeUnknown("OpenCode 回答了 /compact，但它的记录里没有找到这次压缩；结果未确认，不会重发".into()).into());
            }
            if Instant::now() >= deadline {
                return Err(OutcomeUnknown("OpenCode 还没有确认开始压缩；不会重发。若它已开始，结果会显示在这一轮".into()).into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// A compaction request's answer (T-10), kept with its Turn, then
    /// OpenCode's whole record of the session read again while the connection
    /// it went on is still the Agent's: the answer alone says neither that it
    /// ran nor how it ended.
    async fn opencode_compact_answered(&self, id: &str, generation: u64, session: &str, turn: &str, answer: CompactAnswer) {
        // `ended`: 200 and `true` from the process it went to, its handler
        // returned there; the only proof here that its run has ended.
        let answer = match &answer {
            CompactAnswer::Ended => json!({"kind":"ended","status":200,"body":true,"generation":generation,"session":session,"at":now()}),
            CompactAnswer::Refused(status) => json!({"kind":"refused","code":status.code,"body":status.body,"generation":generation,"session":session,"at":now()}),
            CompactAnswer::Unknown(reason) => json!({"kind":"unknown","detail":reason,"generation":generation,"session":session,"at":now()}),
        };
        let (attempt, kept, asked) = (turn.to_owned(), answer.clone(), session.to_owned());
        let recorded = self.record_update(id, "opencode/compactAnswered", json!({"turnId":turn,"answer":answer}), Sel::Turns(vec![turn.to_owned()]), move |d| {
            // Only the attempt it answers: the one sent to that process and session under this Turn.
            let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == attempt.as_str() && t["_opencodeCompact"].is_object()) else { return };
            let of = &entry["_opencodeCompact"];
            if of["generation"] == generation && of["session"] == asked.as_str() {
                entry["_opencodeCompact"]["answer"] = kept;
            }
        }).await;
        if let Err(error) = recorded {
            eprintln!("Workspace OpenCode compaction answer not recorded: {error:#}");
        }
        self.changed(id);
        if let Some(c) = self.opencode_current(id, generation) {
            if let Err(error) = self.opencode_resync(id, &c).await {
                eprintln!("Workspace OpenCode compaction not checked: {error:#}");
            }
        }
    }

    /// An answer to one of this Agent's OpenCode requests; false if it has
    /// no such request.
    pub(crate) async fn opencode_respond(&self, id: &str, request_id: &str, response: &Value) -> Result<bool> {
        let owned = self.owner(id).await;
        let connection = self.opencodes.lock().unwrap().get(id).cloned();
        let (agent, request, reply) = (id.to_owned(), request_id.to_owned(), response.clone());
        let checked = self.stored_owned(owned, move |store| {
            ensure_agent_open(&store.agent(&agent)?)?;
            let Some(p) = store.pending(&agent)?.into_iter().find(|p| p.id == request) else {
                return Ok(None);
            };
            ensure!(!p.stale && p.params["_responseSent"] != true, "这个请求已经回答或已失效；不会再次发送");
            let c = connection.context("OpenCode 连接已断开，回答没有发送")?;
            // Only the process and session that asked can take the answer:
            // the Agent's own, or one of its sub-agents' on this process.
            let asked = p.params["_opencodeSession"].as_str().unwrap_or_default();
            ensure!(p.params["_runtimeGeneration"] == c.generation && c.owns(asked),
                "这个请求属于已经结束的 OpenCode 连接；不会把回答发给新的进程");
            if let Some(not_yet) = p.params["_opencodeNotYet"].as_str() {
                bail!("{not_yet}");
            }
            let answer = answer(&p, &reply)?;
            store.update_meta(&agent, "request/replied", &json!({"requestId":request}), |m| {
                if let Some(p) = m.pending.iter_mut().find(|p| p.id == request) {
                    p.params["_responseSent"] = true.into();
                }
            })?;
            Ok(Some((p, c, answer)))
        }).await?;
        let Some((p, c, answer)) = checked else { return Ok(false) };
        let native = p.params["id"].as_str().unwrap_or_default();
        // OpenCode checks it is pending in that same session before answering.
        let asked = p.params["_opencodeSession"].as_str().unwrap_or_default();
        let sent = match &answer {
            Answer::Permission(reply) => c.server.reply_permission(asked, native, *reply).await,
            Answer::Question(answers) => c.server.reply_question(asked, native, answers).await,
            Answer::RejectQuestion => c.server.reject_question(asked, native).await,
        };
        let request = request_id.to_owned();
        match sent {
            Ok(()) => {
                let owned = self.owner(id).await;
                if self.opencode_current(id, c.generation).is_some() {
                    let agent = id.to_owned();
                    self.stored_owned(owned, move |store| store.record_event(&agent, "opencode/requestAnswered", &json!({"requestId":request}), Sel::Open, |d| {
                        d.pending.retain(|p| p.id != request);
                        refresh_status(d);
                    }).map(drop)).await?;
                }
            }
            Err(error) => {
                // A sent answer whose fate is unknown never becomes a button again.
                let message = error.to_string();
                self.record_update(id, "opencode/requestAnswerFailed", json!({"requestId":request_id,"error":message}), Sel::Open, move |d| {
                    if let Some(p) = d.pending.iter_mut().find(|p| p.id == request) {
                        p.stale = true;
                    }
                    d.agent.error = Some(message);
                    refresh_status(d);
                }).await?;
                self.changed(id);
                return Err(error);
            }
        }
        self.changed(id);
        Ok(true)
    }

    /// Ends the Agent's OpenCode process: a running Turn is aborted first,
    /// and whatever did not end by itself is left unknown, never resent. The
    /// connection goes before OpenCode is asked to end what its tools run, so
    /// the end of its stream that follows is not read as a break.
    pub(crate) async fn opencode_close_runtime(&self, id: &str) -> Result<()> {
        let Some(c) = self.opencodes.lock().unwrap().get(id).cloned() else {
            return Ok(());
        };
        if busy(&self.send_view(id).await?) && c.server.abort(&c.session).await.is_ok() {
            let _ = timeout(STOP_LIMIT, async {
                while self.opencode_current(id, c.generation).is_some() && self.send_view(id).await.is_ok_and(|d| d.turns.iter().any(|t| t["status"] == "inProgress")) {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }).await;
        }
        {
            let _owned = self.owner(id).await;
            let mut connections = self.opencodes.lock().unwrap();
            if connections.get(id).is_some_and(|v| v.generation == c.generation) {
                connections.remove(id);
            }
        }
        let generation = c.generation;
        stop(c.server).await?;
        self.record_update(id, "opencode/closed", json!({"generation":generation}), Sel::Open, |d| {
            ended(d, "OpenCode 关闭前没有确认这一轮结束；结果未确认，不会重发。原 Session 与历史保留。");
            d.agent.connection_state = "disconnected".into();
        }).await?;
        self.changed(id);
        Ok(())
    }

    /// When Core stops normally: every Agent's OpenCode is stopped as a close
    /// stops it, all at once, so within one stop's bound. Their connections
    /// go first. Nothing is recorded: the next Core connects again to the
    /// same session (`restarted`). A process started after this, or one
    /// still held elsewhere, ends with the Workspace instead (`Server`).
    pub async fn opencode_stop_all(&self) {
        let connections: Vec<Connection> = std::mem::take(&mut *self.opencodes.lock().unwrap()).into_values().collect();
        futures_util::future::join_all(connections.into_iter().map(|c| async move {
            if let Err(error) = stop(c.server).await {
                eprintln!("OpenCode did not stop with Core: {error:#}");
            }
        })).await;
    }
}

/// Lets OpenCode end cleanly (`shutdown`) when nothing else holds it. Else
/// it is signalled to end, and this stop holds it until it has exited,
/// within TEARDOWN as `shutdown` waits: 2.x closes its event stream early in
/// its teardown, so the task reading it lets go first, and were this the
/// last hold, its drop (SIGKILL to the group) would cut short the teardown
/// that ends what its tools run (R1 070d0f95 of #575). The last holder reaps it.
async fn stop(server: Arc<Server>) -> Result<()> {
    match Arc::try_unwrap(server) {
        Ok(server) => server.shutdown().await,
        Err(server) => {
            server.terminate();
            if !server.ended_within(opencode::TEARDOWN).await {
                eprintln!("OpenCode did not end within {:?} of SIGTERM; what still holds it ends its group", opencode::TEARDOWN);
            }
            Ok(())
        }
    }
}

/// The remote MCP server OpenCode is given for this Agent, and whether it
/// reached it. A failed request is reported, not raised: readiness is
/// separate from the connection, which still serves reading and stopping.
/// The Agent's Workspace MCP handed to its OpenCode, and how OpenCode then
/// lists it (T-61 slice 1). It is added each time with the same
/// configuration: 2.x changes nothing for a server it holds, and adds back
/// one it dropped with the Agent's folder, which it unloads after an hour
/// without session events and on a reload (2.2.5
/// core/src/location-activity.ts). `retry` (a reconnect) also has it try a
/// server it lists as failed again, which the same configuration does not.
/// One still connecting is waited for, at most MCP_SETTLE. Nothing OpenCode
/// answers is kept with the bearer in it.
async fn workspace_mcp(server: &Server, config: &Value, retry: bool) -> Mcp {
    let url = config["url"].as_str().unwrap_or_default();
    let Some(bearer) = config["headers"]["Authorization"].as_str().and_then(|h| h.strip_prefix("Bearer ")) else {
        return Mcp::NotConnected(json!({"status":"unknown","error":"Workspace MCP credential is missing"}));
    };
    let refused = |error: anyhow::Error| Mcp::NotConnected(json!({"status":"refused","error":error.to_string()}));
    if let Err(error) = server.add_mcp(MCP_NAME, url, bearer).await {
        return without(refused(error), bearer);
    }
    let mut state = settled(server).await;
    let failed = |state: &Mcp| matches!(state, Mcp::NotConnected(native) if matches!(native["status"].as_str(), Some("failed" | "needs_auth")));
    if retry && failed(&state) {
        if let Err(error) = server.connect_mcp(MCP_NAME).await {
            return without(refused(error), bearer);
        }
        state = settled(server).await;
    }
    without(state, bearer)
}

/// The Workspace MCP server as OpenCode lists it once it is no longer
/// connecting, or after MCP_SETTLE.
async fn settled(server: &Server) -> Mcp {
    let deadline = Instant::now() + MCP_SETTLE;
    loop {
        match server.mcp(MCP_NAME).await {
            Ok(Mcp::Pending) if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(100)).await,
            Ok(Mcp::Pending) => return Mcp::NotConnected(json!({"status":"pending",
                "error":format!("still connecting after {} s", MCP_SETTLE.as_secs())})),
            // Added, and not listed: a managed MCP policy of its configuration may remove it.
            Ok(Mcp::Absent) => return Mcp::NotConnected(json!({"status":"notListed",
                "error":"OpenCode does not list it after adding it; an MCP policy in its configuration may remove it"})),
            Ok(state) => return state,
            Err(error) => return Mcp::NotConnected(json!({"status":"unknown","error":error.to_string()})),
        }
    }
}

/// `state` with the bearer taken out of anything OpenCode said.
fn without(state: Mcp, bearer: &str) -> Mcp {
    match state {
        Mcp::NotConnected(mut native) => {
            if let Some(error) = native["error"].as_str().filter(|error| !bearer.is_empty() && error.contains(bearer)) {
                native["error"] = error.replace(bearer, "[redacted]").into();
            }
            Mcp::NotConnected(native)
        }
        state => state,
    }
}

fn busy(d: &AgentDetail) -> bool {
    d.turns.iter().any(|t| t["status"] == "inProgress") || d.pending.iter().any(|p| !p.stale)
}

/// How many of the newest Turns a connection's snapshot of the session is
/// applied to (T-140): the snapshot holds the whole native session; a Turn
/// older than these settled while Core read its events.
const TAIL: usize = 8;

/// The Turns an event names: a message's own (a prompt's ID is its Turn's)
/// and the one its answer belongs to (`parentID`); for a part, the Turn its
/// message answers, which may have ended before the part arrives (read under
/// the Agent's ownership, as the change is made). The open and newest ones
/// come with them (`Sel::Turns`).
fn event_turns(store: &Store, id: &str, event: &Value) -> Result<Vec<String>> {
    let info = &event["data"]["info"];
    let mut turns: Vec<String> = [&info["id"], &info["parentID"]].into_iter().filter_map(Value::as_str).map(str::to_owned).collect();
    // A message added to a running Turn, or an answer to one (T-10).
    for message in [&info["id"], &info["parentID"]].into_iter().filter_map(Value::as_str) {
        turns.extend(store.turn_holding(id, "_opencodeInputs", message)?);
    }
    // A part, or 2.x's text streamed into one (T-32 slice 3b).
    if let Some(message) = event["data"]["part"]["messageID"].as_str().or(event["data"]["messageID"].as_str()) {
        turns.extend(store.turn_holding(id, "_opencodeAnswers", message)?);
    }
    Ok(turns)
}

fn type_of(event: &Value) -> &str {
    event["type"].as_str().unwrap_or_default()
}

/// An event as the journal keeps it: each `data:` URL in it (a file part's
/// `url`, such as an image sent inline, which OpenCode sends back in the
/// stored message's `message.part.updated`) as its media type and length
/// only (T-10). Image bytes stay in Core's managed files, never in its
/// database.
fn journaled(event: &Value) -> Cow<'_, Value> {
    // 2.x sends a file's bytes as its own base64 `data` beside its `mime`
    // (schema/src/prompt.ts), not as a `data:` URL (T-32 slice 3b).
    fn bytes(map: &serde_json::Map<String, Value>, key: &str) -> bool {
        key == "data" && map.get("mime").is_some_and(Value::is_string) && map[key].is_string()
    }
    fn inline(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(key, v)| (key == "url" && v.as_str().is_some_and(|u| u.starts_with("data:")))
                || bytes(map, key) || inline(v)),
            Value::Array(items) => items.iter().any(inline),
            _ => false,
        }
    }
    fn strip(value: &mut Value) {
        match value {
            Value::Object(map) => {
                let mime = map.get("mime").and_then(Value::as_str).map(str::to_owned);
                for (key, v) in map.iter_mut() {
                    match v.as_str() {
                        Some(url) if key == "url" && url.starts_with("data:") => {
                            let kind = url.split_once(',').map_or("data:", |(kind, _)| kind);
                            *v = format!("{kind},… ({} characters not kept)", url.len()).into();
                        }
                        Some(data) if key == "data" && mime.is_some() => {
                            *v = format!("{},… ({} characters not kept)", mime.as_deref().unwrap_or_default(), data.len()).into();
                        }
                        _ => strip(v),
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    if !inline(event) {
        return Cow::Borrowed(event);
    }
    let mut kept = event.clone();
    strip(&mut kept);
    Cow::Owned(kept)
}

/// Event types this module applies to the record.
fn projected(kind: &str) -> bool {
    matches!(kind, "message.updated" | "message.part.updated" | "session.status" | "session.error"
        | "permission.asked" | "permission.replied" | "question.asked" | "question.replied" | "question.rejected")
}

fn project(d: &mut AgentDetail, generation: u64, session: &str, event: &Value) {
    let p = &event["data"];
    match event["type"].as_str().unwrap_or_default() {
        "message.updated" => message(d, &p["info"]),
        "message.part.updated" => part(d, &p["part"]),
        // 2.x's text as it streams (T-32 slice 3b), into the item of the answer it is part of.
        "message.part.delta" => {
            let Some(message) = p["messageID"].as_str() else { return };
            let Some(turn) = d.turns.iter_mut().find(|t| t["_opencodeAnswers"].get(message).is_some()) else { return };
            if !turn["items"].is_array() {
                turn["items"] = json!([]);
            }
            crate::opencode_v2::apply_delta(turn["items"].as_array_mut().expect("turn items"), p);
        }
        "session.status" => status(d, &p["status"]),
        "session.error" => {
            // It names no message, so it decides no Turn: the idle that
            // follows does, from what the Turn's own messages say, or from
            // an abort reported here before those say it (see `settle`).
            // An abort is how an interrupt ends, not an error of the Agent.
            if p["error"]["name"] != "MessageAbortedError" {
                d.agent.error = Some(format!("OpenCode 报告了会话错误：{}", error_text(&p["error"])));
            }
            if let Some(turn) = running(d) {
                turn["_opencodeSessionError"] = p["error"].clone();
            }
        }
        kind if requested(kind) => request(d, generation, session, None, event),
        _ => {}
    }
}

/// Request events: asked, answered or rejected.
fn requested(kind: &str) -> bool {
    matches!(kind, "permission.asked" | "permission.replied" | "question.asked" | "question.replied" | "question.rejected")
}

/// A request event of `session`: the Agent's own, or its sub-agent `child`'s.
fn request(d: &mut AgentDetail, generation: u64, session: &str, child: Option<&Value>, event: &Value) {
    let p = &event["data"];
    match event["type"].as_str().unwrap_or_default() {
        "permission.asked" => ask(d, PERMISSION, generation, session, child, p),
        "question.asked" => ask(d, QUESTION, generation, session, child, p),
        "permission.replied" | "question.replied" | "question.rejected" => {
            let request = p["requestID"].clone();
            d.pending.retain(|r| !(r.params["id"] == request && r.params["_runtimeGeneration"] == generation));
        }
        _ => {}
    }
}

/// The Agent's context usage from an answer of its own session (T-10,
/// contract on T-10 #757): the newest completed answer to the latest input
/// of its newest Turn, against the window of the model that answered. A
/// compaction makes what was measured before it last known, and no answer
/// older than it measures after it; an answer that can't be measured makes
/// it last known too, never 0. An answer replayed, or no newer than the
/// newest one or compaction considered in the session (`seen`), changes nothing. An
/// answer whose model the connection's list didn't have waits, alone, for
/// one read of the catalog (`wanted`).
fn measure(d: &mut AgentDetail, c: &Connection, info: &Value) {
    if info["role"] != "assistant" {
        return;
    }
    if info["summary"] == true {
        // A compaction's summary counts what was there before it. It is also
        // a boundary, kept as the session's newest considered (`seen`): an
        // answer that completed before it, however late it arrives, after a
        // reconnect too, measures nothing and reads no catalog (R6 b6556a88).
        let at = info["time"]["completed"].as_i64().or_else(|| info["time"]["created"].as_i64());
        if let Some(at) = at.filter(|at| measured_before(d, *at)) {
            stale(d);
            c.compacted(at);
            let summary = info["id"].as_str().unwrap_or_default();
            if seen(d, &c.session).is_none_or(|seen| (at, summary) > seen) {
                d.opencode_usage_seen = Some(UsageSeen { session: c.session.clone(), at, answer: summary.to_owned() });
            }
        }
        return;
    }
    let (Some(at), Some(parent), Some(answer)) = (info["time"]["completed"].as_i64(), info["parentID"].as_str(), info["id"].as_str())
        else { return };
    let Some(index) = d.turns.iter().position(|t| t["id"] == parent || t["_opencodeInputs"].get(parent).is_some() || t["_opencodeFollowed"] == parent)
        else { return };
    // An answer to an earlier input, completed late, says nothing of now:
    // one to an earlier Turn (every change holds the newest one, last; R5
    // 0aa6e52c), or to an earlier input of its Turn.
    if index + 1 != d.turns.len() || latest_input(&d.turns[index]) != Some(parent) {
        return;
    }
    // Once considered, measured or not, an answer never measures here
    // again, nor does one older than it, whatever its Turn: a replay of the
    // record, after a reconnect too, or a late answer (R3 eb8dff5f, R5
    // 0aa6e52c). What was measured is shown; it is not this boundary. Of two
    // that completed in the same millisecond, the later ID is the newer
    // (OpenCode's IDs ascend).
    if seen(d, &c.session).is_some_and(|seen| (at, answer) <= seen) {
        return;
    }
    let Some(turn) = d.turns[index]["id"].as_str().map(str::to_owned) else { return };
    d.opencode_usage_seen = Some(UsageSeen { session: c.session.clone(), at, answer: answer.to_owned() });
    let used = context_used(&info["tokens"]);
    let model = info["providerID"].as_str().zip(info["modelID"].as_str()).map(|(provider, model)| format!("{provider}/{model}"));
    let mut usage = c.usage.lock().unwrap();
    usage.superseded(at);
    let (Some(used), Some(model), Some(time)) = (used, model, chrono::DateTime::from_timestamp_millis(at)) else {
        stale(d);
        return;
    };
    match usage.windows.get(&model).copied() {
        Some(window) => match ContextUsage::measured(used, window, &turn, time) {
            Some(measured) => d.context_usage = Some(measured),
            // A window of 0: unknown.
            None => stale(d),
        },
        None => {
            stale(d);
            // The newest answer, waiting alone for its window.
            let epoch = usage.epoch;
            usage.pending = Some(Pending { epoch, answer: answer.to_owned(), turn, parent: parent.to_owned(), at, used, model: model.clone() });
            if usage.refreshed.insert(model.clone()) {
                usage.wanted = Some(model);
            }
        }
    }
}

/// The context an answer used, in Yuzuno's report (T-10): OpenCode's own
/// `total` when it is a positive whole number, else the parts it stores
/// apart (`session.ts`: input without the cache, output without reasoning),
/// each once, as OpenCode's app adds them. A `total` that is there but no
/// whole number, a part missing or no whole number, a sum too large, or 0
/// is unknown.
fn context_used(tokens: &Value) -> Option<u64> {
    match &tokens["total"] {
        Value::Null => {}
        total => match total.as_u64()? {
            0 => {}
            total => return Some(total),
        },
    }
    let parts = [&tokens["input"], &tokens["output"], &tokens["reasoning"], &tokens["cache"]["read"], &tokens["cache"]["write"]];
    let used = parts.into_iter().try_fold(0u64, |sum, part| sum.checked_add(part.as_u64()?))?;
    (used > 0).then_some(used)
}

/// A Turn's latest input: its newest added message, else its prompt, or a
/// later user message of OpenCode's own that it went on under, such as a
/// compaction's continuation (`followed`; OpenCode's IDs ascend).
fn latest_input(turn: &Value) -> Option<&str> {
    let input = turn["_opencodeLastInput"].as_str().or_else(|| turn["id"].as_str());
    match (input, turn["_opencodeFollowed"].as_str()) {
        (Some(input), Some(after)) if after > input => Some(after),
        (input, _) => input,
    }
}

/// The newest answer of `session` considered for the context usage, measured
/// or not, or a newer compaction's summary, as when it completed and its ID;
/// none of another session.
fn seen<'a>(d: &'a AgentDetail, session: &str) -> Option<(i64, &'a str)> {
    d.opencode_usage_seen.as_ref().filter(|seen| seen.session == session).map(|seen| (seen.at, seen.answer.as_str()))
}

/// Whether `at` (ms) is after what was last measured, or nothing was.
fn measured_before(d: &AgentDetail, at: i64) -> bool {
    d.context_usage.as_ref()
        .and_then(|usage| chrono::DateTime::parse_from_rfc3339(&usage.updated_at).ok())
        .is_none_or(|measured| at > measured.timestamp_millis())
}

/// What was measured is last known.
fn stale(d: &mut AgentDetail) {
    if let Some(usage) = &mut d.context_usage {
        usage.stale = true;
    }
}

/// What a snapshot holds, applied as the events it stands for would be; each
/// part and message replaces its own, so applying one again changes nothing.
fn apply_snapshot(d: &mut AgentDetail, generation: u64, session: &str, snapshot: &Snapshot, children: &BTreeMap<String, Value>, c: &Connection) {
    // 2.x's messages read as 1.19.3's were (T-32 slice 3b); the live stream
    // goes on from the turn this read finds open. 1.19.3-shaped ones, as the
    // stand-in's 1.19.3 mode sends, are read as they are.
    let (entries, ended) = if crate::opencode_v2::is_v2(&snapshot.messages) {
        let read = crate::opencode_v2::read_messages(&snapshot.messages);
        let mut cursor = c.cursor.lock().unwrap();
        cursor.resumed(session, &read, &snapshot.inbox);
        for request in snapshot.permissions.iter().chain(&snapshot.questions) {
            cursor.asked(request);
        }
        (read.messages, read.ended)
    } else {
        (snapshot.messages.as_array().cloned().unwrap_or_default(), Vec::new())
    };
    for entry in &entries {
        message(d, &entry["info"]);
        for p in entry["parts"].as_array().into_iter().flatten() {
            part(d, p);
        }
        measure(d, c, &entry["info"]);
    }
    // What 2.x admitted and has not taken into the turn yet: stored, so delivered.
    for info in crate::opencode_v2::admitted(&snapshot.inbox) {
        message(d, &info);
    }
    // How a turn that ended while no stream was open ended, as its idle message says (2.x).
    for end in &ended {
        let Some(error) = &end.error else { continue };
        if let Some(turn) = d.turns.iter_mut().find(|t| t["status"] == "inProgress"
            && (t["id"] == end.user.as_str() || t["_opencodeInputs"].get(&end.user).is_some())) {
            turn["_opencodeSessionError"] = error.clone();
        }
    }
    // This process's requests are what it has pending now; it answered or
    // dropped the others while no stream was open.
    let pending: Vec<&Value> = snapshot.permissions.iter().chain(&snapshot.questions).map(|r| &r["id"]).collect();
    d.pending.retain(|r| r.params["_runtimeGeneration"] != generation || pending.contains(&&r.params["id"]));
    // Each in the session that asked, the Agent's or a sub-agent's.
    for (method, requests) in [(PERMISSION, &snapshot.permissions), (QUESTION, &snapshot.questions)] {
        for request in requests {
            let asked = request["sessionID"].as_str().unwrap_or(session);
            ask(d, method, generation, asked, children.get(asked), request);
        }
    }
    status(d, &snapshot.status);
    // The whole session read (T-10): what became of a compaction its events
    // alone could not tell, by this process or one before it.
    let idle = snapshot.status["type"] == "idle";
    let pending = pending_tasks(&snapshot.messages);
    for turn in d.turns.iter_mut().filter(|t| t["_opencodeCompact"].is_object()) {
        let live = turn["_opencodeCompact"]["generation"] == generation;
        settle_compaction(turn, idle, true, live);
        // Whether OpenCode still holds one that ended unfinished, given up
        // or not: whether its part is among those OpenCode's next run takes
        // up, as this read finds them. Never its old summary (Lead 3803),
        // nor its part merely left in the record once a later answer
        // finished (Lead 3816).
        let attempt = &mut turn["_opencodeCompact"];
        if let (Some(part), Some("stopped" | "failed" | "unknown" | "abandoned")) = (attempt["part"].as_str(), attempt["state"].as_str()) {
            let held = pending.iter().any(|p| p == part);
            attempt["nativePending"] = held.into();
        }
    }
}

fn message(d: &mut AgentDetail, info: &Value) {
    let Some(id) = info["id"].as_str() else { return };
    match info["role"].as_str() {
        Some("user") => {
            confirm(d, id);
            confirm_input(d, id);
            compaction_message(d, info);
            followed(d, id);
        }
        Some("assistant") => {
            if compaction_summary(d, info) {
                return;
            }
            // Its Turn: the one whose prompt it answers, or whose added message (T-10).
            let Some(parent) = info["parentID"].as_str() else { return };
            let Some(turn) = d.turns.iter_mut().find(|t| t["id"] == parent || t["_opencodeInputs"].get(parent).is_some()) else {
                return;
            };
            if !turn["_opencodeAnswers"].is_object() {
                turn["_opencodeAnswers"] = json!({});
            }
            turn["_opencodeAnswers"][id] = json!({"completed":info["time"]["completed"],"error":info["error"],"finish":info["finish"],"parent":parent});
        }
        // A shell command of 2.x's (T-32 slice 4a, D2): its Turn's, as the message before it says; no answer.
        Some("shell") => {
            let Some(parent) = info["parentID"].as_str() else { return };
            let Some(turn) = d.turns.iter_mut().find(|t| t["id"] == parent || t["_opencodeInputs"].get(parent).is_some()) else {
                return;
            };
            if !turn["_opencodeShells"].is_object() {
                turn["_opencodeShells"] = json!({});
            }
            turn["_opencodeShells"][id] = parent.into();
        }
        _ => {}
    }
}

/// OpenCode stored the prompt sent under `turn`: it was delivered. The
/// Turn's user message is then that message in the conversation, and carries
/// its client ID as a Codex or Claude one does (T-120): a delivery preview
/// waits for that ID, and the receipt is bound by it. A refused message stays
/// refused, and its user message gets no ID.
fn confirm(d: &mut AgentDetail, turn: &str) {
    let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn) else { return };
    entry["_opencodeConfirmed"] = true.into();
    // The receipts of messages added to it (T-10) are bound to it too.
    let added: Vec<Value> = entry["_opencodeInputs"].as_object().map(|i| i.values().map(|v| v["clientMessageId"].clone()).collect()).unwrap_or_default();
    if let Some(receipt) = d.message_receipts.iter_mut()
        .find(|r| r.turn_id.as_deref() == Some(turn) && !added.contains(&Value::from(r.input.client_message_id.clone()))) {
        if receipt.status != "rejected" {
            receipt.status = "accepted".into();
            receipt.error = None;
            let input = format!("{turn}:input");
            if let Some(message) = entry["items"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["id"] == input.as_str())) {
                message["clientId"] = receipt.input.client_message_id.clone().into();
            }
        }
    }
}

/// OpenCode stored the message added to a running Turn under `input` (T-10):
/// it was delivered, and its user message carries its client ID, as a
/// prompt's does (`confirm`).
fn confirm_input(d: &mut AgentDetail, input: &str) {
    let Some(entry) = d.turns.iter_mut().find(|t| t["_opencodeInputs"].get(input).is_some()) else { return };
    entry["_opencodeInputs"][input]["confirmed"] = true.into();
    let client = entry["_opencodeInputs"][input]["clientMessageId"].as_str().unwrap_or_default().to_owned();
    if let Some(receipt) = d.message_receipts.iter_mut().find(|r| r.input.client_message_id == client) {
        if receipt.status != "rejected" {
            receipt.status = "accepted".into();
            receipt.error = None;
            let shown = format!("{input}:input");
            if let Some(message) = entry["items"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["id"] == shown.as_str())) {
                message["clientId"] = client.into();
            }
        }
    }
}

/// A user message of OpenCode's own after the newest message added to the
/// running Turn (T-10): an auto-compaction's, or the "continue" or replay
/// that follows one (`session/compaction.ts`). The run goes on under it, and
/// its answers name it, so the Turn does not wait for one to the added
/// message. OpenCode's message IDs ascend. Noted after a prompt alone too:
/// its answers are the newest of the Turn's context usage (T-10).
fn followed(d: &mut AgentDetail, id: &str) {
    if d.turns.iter().any(|t| t["id"] == id || t["_opencodeInputs"].get(id).is_some()) {
        return;
    }
    let Some(turn) = running(d).filter(|t| t["_opencodeCompact"].is_null()) else { return };
    if turn["_opencodeLastInput"].as_str().or_else(|| turn["id"].as_str()).is_some_and(|last| id > last) {
        turn["_opencodeFollowed"] = id.into();
    }
}

/// A part of an assistant message answering one of the Agent's prompts, as
/// the Turn's item of the same ID.
fn part(d: &mut AgentDetail, part: &Value) {
    let (Some(message), Some(id)) = (part["messageID"].as_str(), part["id"].as_str()) else { return };
    if compaction_part(d, message, id, part) {
        return;
    }
    let Some(turn) = d.turns.iter_mut().find(|t| t["_opencodeAnswers"].get(message).is_some() || t["_opencodeShells"].get(message).is_some())
        else { return };
    let item = match part["type"].as_str() {
        Some("shell") => json!({"id":id,"type":"commandExecution","command":part["command"],"status":part["status"],
            "aggregatedOutput":part["output"],"exitCode":part["exit"],"nativeMessageId":message}),
        Some("text") if part["synthetic"] != true => json!({"id":id,"type":"agentMessage","text":part["text"],"nativeMessageId":message}),
        Some("reasoning") => json!({"id":id,"type":"reasoning","summary":[part["text"]],"nativeMessageId":message}),
        Some("tool") => {
            let state = &part["state"];
            let output = if state["status"] == "error" { &state["error"] } else { &state["output"] };
            json!({"id":id,"type":"opencodeTool","name":part["tool"],"callId":part["callID"],"input":state["input"],
                "output":output,"status":tool_status(state["status"].as_str()),"nativeMessageId":message})
        }
        _ => return,
    };
    if !turn["items"].is_array() {
        turn["items"] = json!([]);
    }
    let items = turn["items"].as_array_mut().expect("turn items");
    match items.iter_mut().find(|i| i["id"] == item["id"]) {
        Some(existing) => {
            // 2.x stores no text until its entry ends, so a read in mid-step,
            // or its entry's start, says "" of text already streamed: that is kept (T-32 slice 3b).
            let mut item = item;
            for slot in ["/text", "/summary/0"] {
                if item.pointer(slot) == Some(&json!("")) && existing.pointer(slot).is_some_and(|t| t.as_str().is_some_and(|t| !t.is_empty())) {
                    *item.pointer_mut(slot).expect("slot") = existing.pointer(slot).expect("kept").clone();
                }
            }
            *existing = item;
        }
        None => items.push(item),
    }
}

/// The compaction and sub-agent parts OpenCode 1.19.3 would take up at its
/// next run (`MessageV2.latest`, message-v2.ts:595-610): those of messages
/// after its newest finished answer, by creation time, then ID. Its own
/// `filterCompacted` first leaves out what came before the newest finished
/// compaction, whose summary is itself a finished answer, so this is the same.
fn pending_tasks(messages: &Value) -> Vec<String> {
    let after = |a: &Value, b: &Value| match (a["time"]["created"].as_i64(), b["time"]["created"].as_i64()) {
        (x, y) if x != y => x > y,
        _ => a["id"].as_str() > b["id"].as_str(),
    };
    let list = messages.as_array().map(Vec::as_slice).unwrap_or_default();
    let finished = list.iter().map(|m| &m["info"])
        .filter(|i| i["role"] == "assistant" && i["finish"].as_str().is_some_and(|f| !f.is_empty()))
        .fold(None, |newest: Option<&Value>, i| if newest.is_some_and(|n| !after(i, n)) { newest } else { Some(i) });
    list.iter().filter(|m| finished.is_none_or(|f| after(&m["info"], f)))
        .flat_map(|m| m["parts"].as_array().into_iter().flatten())
        .filter(|p| matches!(p["type"].as_str(), Some("compaction" | "subtask")))
        .filter_map(|p| p["id"].as_str().map(str::to_owned)).collect()
}

/// Whether `message` still holds the compaction part `part` (T-10).
fn holds_part(messages: &Value, message: &str, part: &str) -> bool {
    messages.as_array().into_iter().flatten().filter(|m| m["info"]["id"] == message)
        .flat_map(|m| m["parts"].as_array().into_iter().flatten()).any(|p| p["id"] == part && p["type"] == "compaction")
}

/// Whether a summary of `message` ended as OpenCode's `filterCompacted` takes
/// a compaction's boundary: finished, with no error (T-10).
fn summary_ended(messages: &Value, message: &str) -> bool {
    messages.as_array().into_iter().flatten().map(|m| &m["info"]).any(|i| i["role"] == "assistant" && i["parentID"] == message
        && i["summary"] == true && i["finish"].as_str().is_some_and(|f| !f.is_empty()) && i["error"].is_null())
}

/// The newest compaction Turn still finding out what became of it (T-10):
/// pending, or unknown.
fn compacting(d: &mut AgentDetail) -> Option<&mut Value> {
    d.turns.iter_mut().rev().find(|t| matches!(t["_opencodeCompact"]["state"].as_str(), Some("pending" | "unknown")))
}

/// A user message of the session while a compaction finds out what became of
/// it (T-10): a candidate for its compaction message unless the session held
/// it before the request, noting whether it went with the model asked for.
fn compaction_message(d: &mut AgentDetail, info: &Value) {
    let Some(id) = info["id"].as_str() else { return };
    let Some(turn) = compacting(d) else { return };
    let attempt = &mut turn["_opencodeCompact"];
    if attempt["known"].as_array().is_some_and(|known| known.iter().any(|k| k == id)) {
        return;
    }
    let asked = info["model"]["providerID"] == attempt["providerID"] && info["model"]["modelID"] == attempt["modelID"];
    attempt["candidates"][id]["model"] = asked.into();
    bind(attempt);
}

/// A part of the session while a compaction finds out what became of it, or
/// of its summary (T-10): a compaction part says whether its message is a
/// compaction asked for (`auto: false`) or one OpenCode started itself; a
/// text part of the summary is the compaction item's text. Whether it was
/// one of these.
fn compaction_part(d: &mut AgentDetail, message: &str, id: &str, part: &Value) -> bool {
    if part["type"] == "compaction" {
        if let Some(turn) = compacting(d) {
            let attempt = &mut turn["_opencodeCompact"];
            if !attempt["known"].as_array().is_some_and(|known| known.iter().any(|k| k == message)) {
                attempt["candidates"][message]["auto"] = part["auto"].clone();
                attempt["candidates"][message]["part"] = id.into();
                bind(attempt);
            }
        }
        return true;
    }
    let Some(turn) = d.turns.iter_mut().rev().find(|t| t["_opencodeCompact"]["summary"]["id"] == message) else { return false };
    if part["type"] == "text" && part["synthetic"] != true {
        turn["_opencodeCompact"]["text"][id] = part["text"].clone();
        let text: Vec<&str> = turn["_opencodeCompact"]["text"].as_object().into_iter().flatten().filter_map(|(_, t)| t.as_str()).collect();
        let text = text.join("\n\n");
        if let Some(item) = turn["items"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["type"] == "contextCompaction")) {
            item["text"] = text.into();
        }
    }
    true
}

/// The compaction's message (T-10): the one candidate asked for, with the
/// model asked for. Two such are never told apart.
fn bind(attempt: &mut Value) {
    let ours: Vec<String> = attempt["candidates"].as_object().into_iter().flatten()
        .filter(|(_, c)| c["model"] == true && c["auto"] == false).map(|(id, _)| id.clone()).collect();
    match ours.as_slice() {
        [] => {}
        [one] => {
            if attempt["message"].is_null() {
                attempt["part"] = attempt["candidates"][one.as_str()]["part"].clone();
                attempt["message"] = one.as_str().into();
            }
        }
        _ => attempt["ambiguous"] = true.into(),
    }
}

/// An answer naming a compaction's message (T-10): its summary, kept as
/// OpenCode last wrote it. Written before the run, it says nothing until it
/// completes. Whether OpenCode still holds the compaction is never read from
/// it: only a whole read finds that, among the parts OpenCode would take up
/// (`apply_snapshot`). Whether it was one.
fn compaction_summary(d: &mut AgentDetail, info: &Value) -> bool {
    let Some(parent) = info["parentID"].as_str() else { return false };
    let Some(turn) = d.turns.iter_mut().rev().find(|t| t["_opencodeCompact"]["message"] == parent) else { return false };
    if info["summary"] != true {
        return false;
    }
    let attempt = &mut turn["_opencodeCompact"];
    attempt["summary"] = json!({"id":info["id"],"completed":info["time"]["completed"],"finish":info["finish"],"error":info["error"]});
    true
}

/// What a compaction Turn's record tells of it now (T-10, contract on T-10
/// #3109): `idle`, OpenCode said the session is idle; `full`, its whole
/// record was read; `live`, by the process the request went to. Done only
/// once its summary completed and the session is idle. Its summary's error
/// ends it as OpenCode said, or an abort the session reported while it ran.
/// Not found in a whole read of the idle session, it was refused only if
/// OpenCode answered 400, 401 or 403, which it does before its handler
/// runs; any other answer, none, or another process leaves it unknown. Two
/// candidates leave it unknown.
fn settle_compaction(turn: &mut Value, idle: bool, full: bool, live: bool) {
    let attempt = turn["_opencodeCompact"].clone();
    if !matches!(attempt["state"].as_str(), Some("pending" | "unknown")) {
        return;
    }
    if attempt["ambiguous"] == true {
        return compaction_unknown(turn, "OpenCode 的记录里有不止一条新的压缩，无法确认哪一条是这次的；结果未确认，不会重发。");
    }
    let summary = &attempt["summary"];
    if attempt["message"].is_string() {
        if summary["error"].is_object() {
            let interrupted = summary["error"]["name"] == "MessageAbortedError";
            return compaction_ended(turn, if interrupted { "interrupted" } else { "failed" }, &summary["error"], summary["finish"].is_null());
        }
        // A boundary as OpenCode's own `filterCompacted` takes one: finished, no error.
        if idle && summary["finish"].is_string() {
            turn["status"] = "completed".into();
            // Found by a later read after its end was unknown.
            turn.as_object_mut().expect("turn").remove("error");
            compaction_settled(turn, "completed", false);
            return;
        }
        if idle && halted(&turn["_opencodeSessionError"]) == Some("interrupted") {
            let error = turn["_opencodeSessionError"].clone();
            return compaction_ended(turn, "interrupted", &error, true);
        }
        if full && idle {
            let message = if live { "OpenCode 已空闲，但这次压缩没有完成的摘要；结果未确认，不会重发。" }
                else { "这次压缩开始后，OpenCode 进程已经更换，它的记录里没有完成的摘要；结果未确认，不会重发。" };
            compaction_unknown(turn, message);
            turn["_opencodeCompact"]["nativePending"] = true.into();
        }
        return;
    }
    if !(full && idle) {
        return;
    }
    let answer = &attempt["answer"];
    match (answer["kind"].as_str(), answer["code"].as_u64()) {
        (Some("refused"), Some(code @ (400 | 401 | 403))) => {
            turn["status"] = "failed".into();
            turn["error"] = json!({"message":format!("OpenCode 拒绝了 /compact（HTTP {code}），它的记录里没有这次压缩：{}", answer["body"].as_str().unwrap_or_default())});
            compaction_settled(turn, "refused", false);
        }
        // Its request not yet answered, by the process it went to.
        (None, _) if live => {}
        _ => compaction_unknown(turn, "OpenCode 的记录里没有找到这次压缩，也无法确认它没有开始；结果未确认，不会重发。"),
    }
}

/// A compaction ended as OpenCode said (T-10): `native`, its error.
/// `unfinished`: OpenCode still holds it, to be taken up by its next run.
fn compaction_ended(turn: &mut Value, status: &str, native: &Value, unfinished: bool) {
    let mut message = error_text(native);
    if unfinished {
        message.push_str("。OpenCode 里这次压缩仍未完成，在处理它之前不会发送新消息");
    }
    turn["status"] = status.into();
    turn["error"] = json!({"message":message,"native":native});
    compaction_settled(turn, if status == "interrupted" { "stopped" } else { "failed" }, unfinished);
}

/// A compaction whose end is not known (T-10): later reads may still find it.
fn compaction_unknown(turn: &mut Value, message: &str) {
    unknown(turn, message);
    turn["_opencodeCompact"]["state"] = "unknown".into();
    turn.as_object_mut().expect("turn").remove("_yuzunoCompactionId");
}

fn compaction_settled(turn: &mut Value, state: &str, unfinished: bool) {
    turn["_opencodeCompact"]["state"] = state.into();
    turn["_opencodeCompact"]["nativePending"] = unfinished.into();
    turn.as_object_mut().expect("turn").remove("_yuzunoCompactionId");
}

fn tool_status(status: Option<&str>) -> &'static str {
    match status {
        Some("pending" | "running") => "inProgress",
        Some("completed") => "completed",
        Some("error") => "failed",
        _ => "unknown",
    }
}

fn status(d: &mut AgentDetail, status: &Value) {
    if status["type"] == "idle" {
        if let Some(turn) = running(d) {
            if turn["_opencodeCompact"].is_object() {
                settle_compaction(turn, true, false, true);
            } else {
                settle(turn);
            }
        }
    }
}

fn running(d: &mut AgentDetail) -> Option<&mut Value> {
    d.turns.iter_mut().rev().find(|t| t["status"] == "inProgress")
}

/// The end of a Turn once OpenCode is idle, from the assistant messages
/// answering its prompt. Not before its prompt is stored: then nothing ran
/// for it yet.
fn settle(turn: &mut Value) {
    if turn["_opencodeConfirmed"] != true {
        return;
    }
    let answers: Vec<Value> = turn["_opencodeAnswers"].as_object().map(|a| a.values().cloned().collect()).unwrap_or_default();
    // How the run ended when OpenCode said so: an answer's error (an abort,
    // a provider's failure) or the error its halt reported. That ends the
    // Turn whatever its messages added (T-10) have had.
    let ended = answers.iter().any(|a| a["error"].is_object()) || halted(&turn["_opencodeSessionError"]).is_some();
    // Its newest added message answered, or gone past under a later user
    // message of OpenCode's own (`followed`); always so with none added.
    let newest = turn["_opencodeLastInput"].as_str().is_none_or(|last| answers.iter().any(|a| a["parent"] == last)
        || turn["_opencodeFollowed"].as_str().is_some_and(|after| after > last));
    if !ended {
        // A message added to it not stored yet, or the newest one not yet
        // answered: OpenCode's run answers the newest, so an idle alone
        // leaves the Turn going on.
        let unstored = turn["_opencodeInputs"].as_object().is_some_and(|inputs| inputs.values().any(|i| i["confirmed"] != true));
        if unstored || !newest {
            return;
        }
    }
    if let Some(error) = answers.iter().map(|a| &a["error"]).find(|e| e.is_object()) {
        let interrupted = error["name"] == "MessageAbortedError";
        turn["status"] = if interrupted { "interrupted" } else { "failed" }.into();
        turn["error"] = json!({"message":error_text(error),"native":error});
    } else if newest && !answers.is_empty() && answers.iter().all(|a| a["completed"].is_number()) {
        turn["status"] = "completed".into();
    } else if let Some(status) = halted(&turn["_opencodeSessionError"]) {
        // OpenCode (1.19.3) halts a run by reporting the session's error and
        // going idle before it writes the answer that carries it: an error
        // only that halt reports, reported while this Turn ran, is how the
        // Turn ended.
        let error = turn["_opencodeSessionError"].clone();
        turn["status"] = status.into();
        turn["error"] = json!({"message":error_text(&error),"native":error});
    } else {
        unknown(turn, "OpenCode 回到空闲，但没有为这条消息留下完成的回答；结果未确认，不会重发。");
        return;
    }
    settle_tools(turn);
}

/// How a run ended that OpenCode halted with this session error, for the
/// errors only its processor's halt reports to the session (1.19.3, after any
/// retries). ContextOverflowError and UnknownError are also reported when the
/// run goes on (auto-compaction, a file that could not be read): they decide
/// nothing.
fn halted(error: &Value) -> Option<&'static str> {
    match error["name"].as_str()? {
        "MessageAbortedError" => Some("interrupted"),
        "APIError" | "ProviderAuthError" | "MessageOutputLengthError" | crate::opencode_v2::EXECUTION_FAILED => Some("failed"),
        _ => None,
    }
}

fn error_text(error: &Value) -> String {
    error["data"]["message"].as_str().or_else(|| error["name"].as_str()).unwrap_or("未知错误").to_owned()
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
    turn["error"] = json!({"message":message});
    settle_tools(turn);
}

/// A connection gone: nothing it ran can report any more.
fn ended(d: &mut AgentDetail, message: &str) {
    for turn in &mut d.turns {
        if turn["status"] == "inProgress" {
            if turn["_opencodeCompact"].is_object() {
                // Still found by a later read of the session (T-10).
                compaction_unknown(turn, message);
            } else {
                unknown(turn, message);
            }
        }
    }
    for p in &mut d.pending {
        p.stale = true;
    }
    for receipt in &mut d.message_receipts {
        if matches!(receipt.status.as_str(), "sending" | "queued" | "uncertain") {
            receipt.status = "unknown".into();
            receipt.error = Some("OpenCode 的连接结束前没有确认收到这条消息；不会重发".into());
        }
    }
}

/// A new process: what an earlier one ran cannot report, and its requests
/// went with it. Its record of the session (the snapshot after this) may
/// still show what was delivered.
fn restarted(d: &mut AgentDetail) {
    ended(d, "OpenCode 进程已重新启动；这一轮的结果未确认，不会重发。原 Session 与历史保留。");
    d.pending.clear();
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

fn ask(d: &mut AgentDetail, method: &str, generation: u64, session: &str, child: Option<&Value>, request: &Value) {
    let Some(native) = request["id"].as_str() else { return };
    if d.pending.iter().any(|p| !p.stale && p.params["id"] == native && p.params["_runtimeGeneration"] == generation) {
        return;
    }
    let mut params = request.clone();
    params["_runtimeGeneration"] = generation.into();
    params["_opencodeSession"] = session.into();
    if let Some(child) = child {
        // Which sub-agent asks, as OpenCode calls it.
        params["_opencodeChild"] = child.clone();
    }
    params["_responseSent"] = false.into();
    // 2.x's own request: shown with why it can't be answered here yet, so its
    // run is seen to wait on it (T-32 slice 4a, until slice 5).
    if crate::opencode_v2::is_v2_request(request) {
        params["_opencodeNotYet"] = format!("{}；这个请求还不能在 Yuzuno 里回答，只能中断这一轮", crate::opencode_v2::NOT_YET).into();
    }
    if let Some(turn) = d.turns.iter().rev().find(|t| t["status"] == "inProgress").and_then(|t| t["id"].as_str()) {
        params["turnId"] = turn.into();
    }
    d.pending.push(PendingRequest {
        id: uuid::Uuid::new_v4().to_string(),
        agent_id: d.agent.id.clone(),
        method: method.into(),
        params,
        created_at: now(),
        stale: false,
    });
}

enum Answer {
    Permission(Reply),
    Question(Vec<Vec<String>>),
    RejectQuestion,
}

/// `{"decision":"once"|"reject"}` for a permission; `{"answers":[[label…]…]}`
/// (one list per question) or `{"decision":"reject"}` for a question.
fn answer(p: &PendingRequest, response: &Value) -> Result<Answer> {
    match (p.method.as_str(), response["decision"].as_str()) {
        (PERMISSION, Some("once")) => Ok(Answer::Permission(Reply::Once)),
        (PERMISSION, Some("reject")) => Ok(Answer::Permission(Reply::Reject)),
        (PERMISSION, _) => bail!("OpenCode 权限请求只接受 once 或 reject"),
        (QUESTION, Some("reject")) => Ok(Answer::RejectQuestion),
        (QUESTION, None) => {
            let answers: Vec<Vec<String>> = serde_json::from_value(response["answers"].clone())
                .map_err(|_| anyhow!("回答应为每个问题一组选项文字"))?;
            let asked = p.params["questions"].as_array().map_or(0, Vec::len);
            ensure!(answers.len() == asked, "这个请求有 {asked} 个问题，回答了 {} 个", answers.len());
            Ok(Answer::Question(answers))
        }
        _ => bail!("不是可以回答的 OpenCode 请求"),
    }
}

#[path = "opencode_revert.rs"]
mod revert;
pub(crate) use revert::expire_previews as expire_revert_previews;

#[path = "opencode_fork.rs"]
mod fork;
pub(crate) use fork::{migrate as fork_migrate, router as fork_router};

#[cfg(test)]
#[path = "opencode_agent_tests.rs"]
mod tests;
