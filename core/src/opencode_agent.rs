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
//! Agent from what its OpenCode's configured providers list
//! (`/config/providers`), and so is that model's variant (`model.variants`,
//! such as `high`); a chosen one goes with each new message (`prompt_async`'s
//! `model` and `variant`), and one OpenCode no longer lists refuses the
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
//! Not yet: no model is chosen when the Agent is created, and no OpenCode
//! `agent` at all; a sub-agent's own conversation is not shown, nor are
//! background sub-agents (OpenCode's experimental flag); a sub-agent of a
//! sub-agent (`subagent_depth` above OpenCode's default of 1) is followed as
//! it starts but not found again after the event stream breaks; no remote
//! machines.
use crate::{
    model::{ensure_agent_open, now, AgentDetail, ContextUsage, PendingRequest},
    opencode::{self, CommandChoice, Events, Launch, Mcp, MessageId, ModelChoice, Reply, Server, Snapshot, Submission},
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
    turn: String,
    parent: String,
    at: i64,
    used: u64,
    model: String,
}

impl Connection {
    fn new(generation: u64, server: Arc<Server>, session: String, children: BTreeMap<String, Value>) -> Self {
        Self { generation, server, session, children: Arc::new(std::sync::Mutex::new(children)), usage: Arc::default() }
    }

    /// Each listed model's context window, as OpenCode lists them now.
    fn windows(&self, models: &[ModelChoice]) {
        self.usage.lock().unwrap().windows = models.iter().map(|m| (m.id(), m.context)).collect();
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
        let p = &event["properties"];
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
    json!({"models":[],"opencode":{"version":opencode::VERSION}})
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
        Ok(json!({"models":models.iter().map(offered).collect::<Vec<_>>(),"opencode":{"version":opencode::VERSION}}))
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

    pub async fn opencode_create_on(
        self: &Arc<Self>, name: String, cwd: String, model: String,
        machine_id: Option<String>, project_id: Option<String>,
    ) -> Result<crate::model::Agent> {
        let permit = self.admission.enter_work()?;
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
        let id = uuid::Uuid::new_v4().to_string();
        let colors = ["yuzu", "sage", "rose", "sky"];
        let count = self.stored(|store| store.agents()).await?.len();
        let agent = crate::model::Agent {
            id: id.clone(),
            name: name.trim().into(),
            goal: String::new(),
            work_summary: None,
            project_id,
            cwd: cwd.to_string_lossy().into_owned(),
            model,
            settings: Default::default(),
            color: colors[count % colors.len()].into(),
            harness: "opencode".into(),
            claude_session_id: None,
            opencode_session_id: None,
            thread_id: None,
            status: "offline".into(),
            created_at: now(),
            updated_at: now(),
            unread_count: 0,
            pending_count: 0,
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
        };
        self.stored(move |store| store.insert_created(&detail)).await?;
        self.changed(&id);
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
        ensure_agent_open(&self.listed(id).await?)?;
        if let Err(error) = self.opencode_ensure(id).await {
            self.failed(id, &error).await;
            return Err(error);
        }
        if read { Ok(Some(self.answer(id).await?)) } else { Ok(None) }
    }

    /// Under the Agent gate: the live connection, or a new OpenCode process
    /// for the Agent's session (created on the first connection).
    pub(crate) async fn opencode_ensure(self: &Arc<Self>, id: &str) -> Result<Connection> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        crate::model::ensure_not_disconnected(&d.agent)?;
        if let Some(c) = self.opencodes.lock().unwrap().get(id).cloned() {
            return Ok(c);
        }
        ensure!(d.agent.remote.is_none(), "OpenCode Agent 目前只支持 Core 所在的本机");
        if d.agent.opencode_session_id.is_none() && !d.turns.is_empty() {
            bail!("OpenCode 上次任务已发送但原生 Session 未确认；不会创建另一个 Session 或重发任务");
        }
        self.record_meta(id, "opencode/connecting", json!({}), |m| m.agent.connection_state = "connecting".into()).await?;
        self.changed(id);
        match self.opencode_connect(id, &d).await {
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
        let folder = self.data_dir.join("opencode").join(id);
        std::fs::create_dir_all(&folder)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))?;
        }
        let launch = Launch { program: program(), directory: d.agent.cwd.clone().into(), database: folder.join("opencode.db") };
        // Until it is in `opencodes`, this is its only owner: an error below
        // drops it, which ends its process group.
        let server = Arc::new(Server::start(&launch).await?);
        let session = match &d.agent.opencode_session_id {
            Some(session) => session.clone(),
            None => {
                let session = server.create_session(&d.agent.name).await?["id"].as_str().unwrap_or_default().to_owned();
                let kept = session.clone();
                self.record_meta(id, "opencode/session", json!({"sessionId":session}), move |m| {
                    m.agent.opencode_session_id = Some(kept);
                }).await?;
                session
            }
        };
        // The Agent's Workspace MCP credential is handed to OpenCode first;
        // readiness is announced only after OpenCode reports reaching it.
        let mcp = match self.collaboration_http_config(&d.agent).await? {
            Some(config) => Some(add_mcp(&server, &config).await),
            None => None,
        };
        // Subscribed before the snapshot, so nothing between them is missed.
        let events = server.subscribe(opencode::EVENT_IDLE_LIMIT).await?;
        let children = sub_agents(&server, &session).await?;
        let snapshot = server.snapshot(&session, &children.keys().cloned().collect::<Vec<_>>()).await?;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let c = Connection::new(generation, server.clone(), session.clone(), children.clone());
        // Each listed model's context window, read once as it connects (T-10).
        if let Ok(models) = server.models().await {
            c.windows(&models);
        }
        let owned = self.owner(id).await;
        self.opencodes.lock().unwrap().insert(id.into(), c.clone());
        let (agent, data) = (id.to_owned(), json!({"sessionId":session,"generation":generation,"version":opencode::VERSION}));
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
        match mcp {
            Some(Mcp::Connected) => self.collaboration_started(id, generation).await,
            Some(Mcp::NotConnected(native)) => self.collaboration_refused(id, generation, &native).await,
            None => {}
        }
        self.opencode_watch(id, generation, events, Arc::downgrade(&server));
        self.changed(id);
        Ok(c)
    }

    /// The connection's event stream, read until its generation is gone. It
    /// holds neither the Workspace nor the server, so dropping the Workspace
    /// ends OpenCode and then this.
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
        let snapshot = c.server.snapshot(&c.session, &c.known_children()).await?;
        let children = c.children.lock().unwrap().clone();
        let owned = self.owner(id).await;
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
            let current = usage.usage.lock().unwrap().epoch == pending.epoch;
            let latest = d.turns.iter().find(|t| t["id"] == pending.turn.as_str()).and_then(latest_input) == Some(pending.parent.as_str());
            if current && latest && measured_before(d, pending.at) {
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
        c.learn(kind, event);
        let journal = format!("opencode/{kind}");
        let kept = journaled(event);
        if session != c.session {
            // A sub-agent's requests are the Agent's to answer; nothing else
            // of it changes the record. Any other session's is not the Agent's.
            let Some(child) = c.child(session) else { return };
            if !requested(kind) {
                return;
            }
            let written = self.store.record_event(id, &journal, &kept, Sel::Open, |d| {
                request(d, generation, session, Some(&child), event);
                refresh_status(d);
            });
            if let Err(error) = written {
                eprintln!("Workspace OpenCode event not recorded: {error:#}");
            }
            self.changed(id);
            return;
        }
        let written = match kind {
            // Text as it streams: the completed part replaces it.
            "message.part.delta" => return,
            kind if projected(kind) => event_turns(&self.store, id, event).and_then(|turns| {
                self.store.record_event(id, &journal, &kept, Sel::Turns(turns), |d| {
                    project(d, generation, &c.session, event);
                    if kind == "message.updated" {
                        measure(d, &c, &event["properties"]["info"]);
                    }
                    refresh_status(d);
                }).map(drop)
            }),
            // Kept as evidence; it changes nothing here.
            _ => self.store.update_meta(id, &journal, &kept, |_| {}).map(drop),
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
        self.require_collaboration(id).await
    }

    /// Before the receipt of a message added to the running Turn `expected`
    /// (T-10): only on the connection that runs it, never one started for it.
    async fn opencode_admit_input(self: &Arc<Self>, id: &str, input: &crate::model::MessageInput, detail: &AgentDetail, expected: &str) -> Result<()> {
        joinable(detail, expected)?;
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode 连接已断开；补充消息未发送，草稿保留")?;
        let model = chosen(&c.server, &detail.agent.model).await?;
        chosen_variant(model.as_ref(), detail.agent.settings.reasoning_effort.as_deref())?;
        if !input.images.is_empty() {
            takes_images(model.as_ref())?;
        }
        ensure!(listed_command(&c.server, &input.text).await?.is_none(), COMMAND_WHILE_RUNNING);
        self.require_collaboration(id).await
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
        joinable(&d, expected)?;
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode 连接已断开；补充消息未发送，草稿保留")?;
        self.require_collaboration(id).await?;
        let model = chosen(&c.server, &d.agent.model).await?;
        let variant = chosen_variant(model.as_ref(), d.agent.settings.reasoning_effort.as_deref())?;
        ensure!(listed_command(&c.server, text).await?.is_none(), COMMAND_WHILE_RUNNING);
        let (files, shown) = if images.is_empty() { (vec![], vec![]) } else {
            takes_images(model.as_ref())?;
            let (root, agent, images) = (self.data_dir.clone(), id.to_owned(), images.to_vec());
            tokio::task::spawn_blocking(move || anyhow::Ok((crate::input_images::opencode_images(&root, &agent, &images)?,
                crate::input_images::history_images(&root, &agent, &images)))).await??
        };
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
        let mut submitted = c.server.submit_with(&c.session, &message, text, &files, model.as_ref(), variant.as_deref()).await;
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
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        ensure!(!busy(&d), "OpenCode 正在执行或等待回应；这条消息没有发送");
        let c = self.opencode_ensure(id).await?;
        self.require_collaboration(id).await?;
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
            None => c.server.submit_with(&c.session, &message, &text, &files, model.as_ref(), variant.as_deref()).await,
        };
        let refused = match &submitted {
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

/// Lets OpenCode end cleanly when nothing else holds it; else it is only asked
/// to end what its tools run, and dropping the last holder ends its group.
/// Either way a refused or unanswered dispose does not stop the stop.
async fn stop(server: Arc<Server>) -> Result<()> {
    match Arc::try_unwrap(server) {
        Ok(server) => server.shutdown().await,
        Err(server) => {
            if let Err(error) = server.dispose().await {
                eprintln!("OpenCode did not end what its tools run before it was stopped: {error:#}");
            }
            Ok(())
        }
    }
}

/// The remote MCP server OpenCode is given for this Agent, and whether it
/// reached it. A failed request is reported, not raised: readiness is
/// separate from the connection, which still serves reading and stopping.
async fn add_mcp(server: &Server, config: &Value) -> Mcp {
    let url = config["url"].as_str().unwrap_or_default();
    let Some(bearer) = config["headers"]["Authorization"].as_str().and_then(|h| h.strip_prefix("Bearer ")) else {
        return Mcp::NotConnected(json!({"error":"Workspace MCP credential is missing"}));
    };
    match server.add_mcp("yuzuno", url, bearer).await {
        Ok(state) => state,
        Err(error) => Mcp::NotConnected(json!({"error":error.to_string()})),
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
    let info = &event["properties"]["info"];
    let mut turns: Vec<String> = [&info["id"], &info["parentID"]].into_iter().filter_map(Value::as_str).map(str::to_owned).collect();
    // A message added to a running Turn, or an answer to one (T-10).
    for message in [&info["id"], &info["parentID"]].into_iter().filter_map(Value::as_str) {
        turns.extend(store.turn_holding(id, "_opencodeInputs", message)?);
    }
    if let Some(message) = event["properties"]["part"]["messageID"].as_str() {
        turns.extend(store.turn_holding(id, "_opencodeAnswers", message)?);
    }
    Ok(turns)
}

/// An event as the journal keeps it: each `data:` URL in it (a file part's
/// `url`, such as an image sent inline, which OpenCode sends back in the
/// stored message's `message.part.updated`) as its media type and length
/// only (T-10). Image bytes stay in Core's managed files, never in its
/// database.
fn journaled(event: &Value) -> Cow<'_, Value> {
    fn inline(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(key, v)| (key == "url" && v.as_str().is_some_and(|u| u.starts_with("data:"))) || inline(v)),
            Value::Array(items) => items.iter().any(inline),
            _ => false,
        }
    }
    fn strip(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, v) in map.iter_mut() {
                    match v.as_str() {
                        Some(url) if key == "url" && url.starts_with("data:") => {
                            let kind = url.split_once(',').map_or("data:", |(kind, _)| kind);
                            *v = format!("{kind},… ({} characters not kept)", url.len()).into();
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
    let p = &event["properties"];
    match event["type"].as_str().unwrap_or_default() {
        "message.updated" => message(d, &p["info"]),
        "message.part.updated" => part(d, &p["part"]),
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
    let p = &event["properties"];
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
/// contract on T-10 #757): the newest completed answer to its Turn's latest
/// input, against the window of the model that answered. A compaction makes
/// what was measured before it last known; an answer that can't be measured
/// does too, never 0. An answer replayed, or older than what was measured,
/// changes nothing. An answer whose model the connection's list didn't have
/// waits, alone, for one read of the catalog (`wanted`).
fn measure(d: &mut AgentDetail, c: &Connection, info: &Value) {
    if info["role"] != "assistant" {
        return;
    }
    if info["summary"] == true {
        // A compaction's summary counts what was there before it.
        let at = info["time"]["completed"].as_i64().or_else(|| info["time"]["created"].as_i64());
        if at.is_some_and(|at| measured_before(d, at)) {
            stale(d);
            c.unmeasured();
        }
        return;
    }
    let (Some(at), Some(parent)) = (info["time"]["completed"].as_i64(), info["parentID"].as_str()) else { return };
    let Some(turn) = d.turns.iter().find(|t| t["id"] == parent || t["_opencodeInputs"].get(parent).is_some()) else { return };
    // An answer to an earlier input, completed late, says nothing of now.
    if latest_input(turn) != Some(parent) || !measured_before(d, at) {
        return;
    }
    let Some(turn) = turn["id"].as_str().map(str::to_owned) else { return };
    let used = context_used(&info["tokens"]);
    let model = info["providerID"].as_str().zip(info["modelID"].as_str()).map(|(provider, model)| format!("{provider}/{model}"));
    let (Some(used), Some(model), Some(time)) = (used, model, chrono::DateTime::from_timestamp_millis(at)) else {
        stale(d);
        return;
    };
    let mut usage = c.usage.lock().unwrap();
    match usage.windows.get(&model).copied() {
        Some(window) => match ContextUsage::measured(used, window, &turn, time) {
            Some(measured) => {
                d.context_usage = Some(measured);
                usage.pending = None;
            }
            // A window of 0: unknown.
            None => stale(d),
        },
        None => {
            stale(d);
            let epoch = usage.epoch;
            usage.pending = Some(Pending { epoch, turn, parent: parent.to_owned(), at, used, model: model.clone() });
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

/// A Turn's latest input: its newest added message, else its prompt.
fn latest_input(turn: &Value) -> Option<&str> {
    turn["_opencodeLastInput"].as_str().or_else(|| turn["id"].as_str())
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
    for entry in snapshot.messages.as_array().into_iter().flatten() {
        message(d, &entry["info"]);
        for p in entry["parts"].as_array().into_iter().flatten() {
            part(d, p);
        }
        measure(d, c, &entry["info"]);
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
}

fn message(d: &mut AgentDetail, info: &Value) {
    let Some(id) = info["id"].as_str() else { return };
    match info["role"].as_str() {
        Some("user") => {
            confirm(d, id);
            confirm_input(d, id);
            followed(d, id);
        }
        Some("assistant") => {
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
/// message. OpenCode's message IDs ascend.
fn followed(d: &mut AgentDetail, id: &str) {
    if d.turns.iter().any(|t| t["id"] == id || t["_opencodeInputs"].get(id).is_some()) {
        return;
    }
    let Some(turn) = running(d) else { return };
    if turn["_opencodeLastInput"].as_str().is_some_and(|last| id > last) {
        turn["_opencodeFollowed"] = id.into();
    }
}

/// A part of an assistant message answering one of the Agent's prompts, as
/// the Turn's item of the same ID.
fn part(d: &mut AgentDetail, part: &Value) {
    let (Some(message), Some(id)) = (part["messageID"].as_str(), part["id"].as_str()) else { return };
    let Some(turn) = d.turns.iter_mut().find(|t| t["_opencodeAnswers"].get(message).is_some()) else { return };
    let item = match part["type"].as_str() {
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
        Some(existing) => *existing = item,
        None => items.push(item),
    }
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
            settle(turn);
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
        "APIError" | "ProviderAuthError" | "MessageOutputLengthError" => Some("failed"),
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
            unknown(turn, message);
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

#[cfg(test)]
#[path = "opencode_agent_tests.rs"]
mod tests;
