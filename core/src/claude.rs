//! Claude Code integration through the official Agent SDK bridge. Native events
//! are retained in the journal; these projections serve the GUI, not a common
//! Harness protocol. Claude session IDs are never Codex thread IDs.
use crate::{
    conversation_time,
    model::{ensure_agent_open, now, Agent, AgentDetail, ContextUsage, PendingRequest, RemoteAgent},
    remote::RemoteMachine,
    rpc::OutcomeUnknown,
    workspace::Workspace,
};
use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot, watch, Mutex},
    time::{timeout, Duration},
};

type Reply = oneshot::Sender<Result<Value>>;

/// Modes a user may choose, and the only ones a session starts or resumes in.
/// Auto delegates prompts to Claude's own classifier; it never bypasses native
/// checks the way bypassPermissions/dontAsk do. A mode Claude switches to
/// within a session (plan, or accept edits granted for the session) is shown
/// but ends with that session.
const SELECTABLE_PERMISSION_MODES: [&str; 2] = ["default", "auto"];
/// Reasoning effort levels the Agent SDK accepts; each model lists its own.
const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const NATIVE_PERMISSION_MODES: [&str; 6] = [
    "default",
    "auto",
    "acceptEdits",
    "plan",
    "dontAsk",
    "bypassPermissions",
];

#[derive(Debug)]
pub(crate) struct Rejected(String);
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Rejected {}

pub(crate) struct Bridge {
    tx: mpsc::Sender<Value>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    next: AtomicU64,
    shutdown: watch::Sender<bool>,
    stopped: watch::Receiver<Option<bool>>,
    /// Recent bridge/CLI stderr. Diagnostic only, never protocol.
    diagnostics: Arc<std::sync::Mutex<String>>,
    /// Becomes true once stderr reaches end of file (the process ended).
    stderr_closed: watch::Receiver<bool>,
    /// The bridge's process (its Claude CLI runs under it), for Machine Load.
    pid: Option<u32>,
}

const DIAGNOSTIC_BYTES: usize = 8 * 1024;
const DIAGNOSTIC_SHOWN_BYTES: usize = 1200;

fn diagnostic_message(base: &str, tail: &str) -> String {
    format!("{base}\nClaude 诊断输出（末尾）：\n{tail}")
}

/// Keep the newest bytes of a stream, cut on a character boundary.
fn keep_tail(text: &mut String, limit: usize) {
    if text.len() > limit {
        let mut start = text.len() - limit;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text.drain(..start);
    }
}

/// Bound the input as well as the retained tail: diagnostics need not contain
/// newlines, and a native process can keep stderr open for the whole session.
async fn drain_diagnostics(
    mut reader: impl AsyncRead + Unpin,
    sink: Arc<std::sync::Mutex<String>>,
) {
    let mut chunk = [0_u8; 4096];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let mut tail = sink.lock().unwrap();
                tail.push_str(&String::from_utf8_lossy(&chunk[..count]));
                keep_tail(&mut tail, DIAGNOSTIC_BYTES);
            }
        }
    }
}

/// Explain a runtime failure with the end of Claude's own output, preserving
/// whether the outcome is unknown or a definite rejection.
fn with_diagnostics(error: anyhow::Error, diagnostics: Option<String>) -> anyhow::Error {
    let Some(tail) = diagnostics else {
        return error;
    };
    let message = diagnostic_message(&error.to_string(), &tail);
    if error.downcast_ref::<OutcomeUnknown>().is_some() {
        OutcomeUnknown(message).into()
    } else if error.downcast_ref::<Rejected>().is_some() {
        Rejected(message).into()
    } else {
        anyhow!(message)
    }
}

impl Bridge {
    pub(crate) async fn spawn(events: impl Into<crate::backlog::EventSender>) -> Result<Arc<Self>> {
        Self::spawn_mode(events, None).await
    }

    pub(crate) async fn spawn_review(events: impl Into<crate::backlog::EventSender>, cwd: &std::path::Path) -> Result<Arc<Self>> {
        Self::spawn_mode(events, Some(cwd)).await
    }

    async fn spawn_mode(events: impl Into<crate::backlog::EventSender>, review_cwd: Option<&std::path::Path>) -> Result<Arc<Self>> {
        let events = events.into();
        let program = std::env::var("YUZUNO_NODE").unwrap_or_else(|_| "node".into());
        // A release without the SDK runs its prepared copy (T-159).
        let script = crate::claude_sdk::bridge_script(std::env::var_os("YUZUNO_CLAUDE_BRIDGE")).await?;
        anyhow::ensure!(
            script.is_file(),
            "找不到 Claude SDK bridge；请设置 YUZUNO_CLAUDE_BRIDGE 并安装其依赖"
        );
        // Authentication belongs to the installed Claude CLI. Do not inspect,
        // copy or normalize its credential/config directory here.
        let mut command = Command::new(program);
        command.arg(script);
        if let Some(cwd) = review_cwd {
            command.arg("--review").current_dir(cwd);
        }
        Self::from_command(events, command, "无法启动 Claude SDK bridge；请检查 Node 和官方 SDK 依赖")
    }

    /// A bridge on another machine: SSH carries the same protocol to the
    /// Agent's host there (remote::claude_attach_command), or, for one
    /// bounded request, to a bridge of its own (remote::claude_direct_command).
    /// Its stderr is SSH's and the attach helper's, never the remote CLI's.
    pub(crate) fn spawn_command(events: impl Into<crate::backlog::EventSender>, command: Command) -> Result<Arc<Self>> {
        Self::from_command(events.into(), command, "无法通过 SSH 连接远程 Claude Runtime")
    }

    fn from_command(events: crate::backlog::EventSender, mut command: Command, failure: &'static str) -> Result<Arc<Self>> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context(failure)?;
        let mut stdin = child.stdin.take().context("Claude bridge stdin 不可用")?;
        let stdout = child.stdout.take().context("Claude bridge stdout 不可用")?;
        let stderr = child.stderr.take().context("Claude bridge stderr 不可用")?;
        let diagnostics = Arc::new(std::sync::Mutex::new(String::new()));
        let sink = diagnostics.clone();
        let (stderr_closed_tx, stderr_closed) = watch::channel(false);
        // Drain raw bytes continuously: a chatty CLI never blocks on a full
        // pipe, and invalid UTF-8 never closes the pipe under the bridge.
        tokio::spawn(async move {
            drain_diagnostics(stderr, sink).await;
            let _ = stderr_closed_tx.send(true);
        });
        let (tx, mut rx) = mpsc::channel::<Value>(128);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (stopped_tx, stopped) = watch::channel(None);
        let pending: Arc<Mutex<HashMap<u64, Reply>>> = Arc::new(Mutex::new(HashMap::new()));
        let bridge = Arc::new(Self {
            tx,
            pending: pending.clone(),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics,
            stderr_closed,
            pid: child.id(),
        });
        tokio::spawn(async move {
            let write = async {
                while let Some(message) = rx.recv().await {
                    let mut line = serde_json::to_vec(&message)?;
                    line.push(b'\n');
                    stdin.write_all(&line).await?;
                    stdin.flush().await?;
                }
                Result::<()>::Ok(())
            };
            let read = async {
                let mut lines = BufReader::new(stdout).lines();
                while let Some(line) = lines.next_line().await? {
                    let message = crate::rpc::parse_message(line)
                        .await
                        .context("Claude bridge 协议消息无法解析")?;
                    if message["type"] == "response" {
                        if let Some(id) =
                            message["id"].as_str().and_then(|id| id.parse::<u64>().ok())
                        {
                            if let Some(reply) = pending.lock().await.remove(&id) {
                                let result = if let Some(error) =
                                    message.get("error").filter(|v| !v.is_null())
                                {
                                    Err(Rejected(
                                        error
                                            .as_str()
                                            .or_else(|| error["message"].as_str())
                                            .unwrap_or("Claude 拒绝请求")
                                            .into(),
                                    )
                                    .into())
                                } else {
                                    Ok(message["result"].clone())
                                };
                                let _ = reply.send(result);
                            }
                        }
                    } else {
                        events
                            .send(message)
                            .await
                            .context("Claude 事件接收器已关闭")?;
                    }
                }
                Result::<()>::Ok(())
            };
            let outcome = tokio::select! { r=write=>r, r=read=>r, _=shutdown_rx.changed()=>Ok(()) };
            // Closing stdin lets the bridge close its SDK query and owned CLI.
            drop(stdin);
            // The SDK closes its own CLI and awaits its exit. Allow that
            // cleanup to finish before claiming the runtime has stopped.
            let graceful = matches!(
                timeout(Duration::from_secs(8), child.wait()).await,
                Ok(Ok(_))
            );
            if !graceful {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            let reason = outcome
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "Claude SDK 连接已结束".into());
            for (_, sender) in pending.lock().await.drain() {
                let _ = sender.send(Err(OutcomeUnknown(reason.clone()).into()));
            }
            let _ = events
                .send(json!({"type":"disconnected","error":reason}))
                .await;
            let _ = stopped_tx.send(Some(graceful));
        });
        Ok(bridge)
    }

    pub(crate) async fn request(&self, mut command: Value) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        command["id"] = id.to_string().into();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if self.tx.send(command).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err(anyhow!("Claude bridge 已关闭，请求未发送"));
        }
        match timeout(Duration::from_secs(35), rx).await {
            Ok(Ok(value)) => value,
            _ => {
                self.pending.lock().await.remove(&id);
                Err(OutcomeUnknown("Claude 请求的接受结果未知；不会自动重发".into()).into())
            }
        }
    }
    fn close(&self) {
        let _ = self.shutdown.send(true);
    }

    /// The bridge's process ID while it was started by this Bridge.
    pub(crate) fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn diagnostics(&self) -> Option<String> {
        let mut tail = self.diagnostics.lock().unwrap().trim().to_owned();
        keep_tail(&mut tail, DIAGNOSTIC_SHOWN_BYTES);
        (!tail.is_empty()).then_some(tail)
    }

    /// The tail once stderr has closed, or briefly later if the process is
    /// still alive, so its last lines (usually the cause) are not missed.
    async fn settled_diagnostics(&self) -> Option<String> {
        let mut closed = self.stderr_closed.clone();
        let _ = timeout(Duration::from_millis(500), closed.wait_for(|closed| *closed)).await;
        self.diagnostics()
    }

    pub(crate) async fn close_and_wait(&self) -> Result<()> {
        self.close();
        let mut stopped = self.stopped.clone();
        timeout(Duration::from_secs(10), async {
            loop {
                if let Some(graceful) = *stopped.borrow_and_update() {
                    anyhow::ensure!(
                        graceful,
                        "Claude bridge 未正常退出，无法确认原生 CLI 已停止"
                    );
                    return Ok(());
                }
                stopped.changed().await.context("Claude 退出状态丢失")?;
            }
        })
        .await
        .context("等待 Claude runtime 退出超时")?
    }
}

/// This Core's Claude runtime on the machine, uploaded once per content
/// digest (remote::claude_install). Returns the digest it runs from.
/// Also the Node and PATH the helper found there, for a direct bridge.
async fn claude_remote_install(machine: &RemoteMachine) -> Result<(String, crate::remote::ClaudeTools)> {
    // A release without the SDK uploads its prepared copy (T-159).
    let root = crate::claude_sdk::runtime_root(std::env::var_os("YUZUNO_CLAUDE_BRIDGE")).await?;
    let (digest, archive) = tokio::task::spawn_blocking(move || crate::remote::claude_runtime_cached(&root)).await??;
    let tools = crate::remote::claude_install(machine, &digest, &archive).await?;
    Ok((digest, tools))
}

#[derive(Clone)]
pub(crate) struct Connection {
    /// Bound to the exact remote host accepted by claude_ensure.
    pub(crate) remote_instance: Option<String>,
    pub generation: u64,
    pub(crate) bridge: Arc<Bridge>,
    pub(crate) events: Option<Arc<crate::updates::events::EventBarrier>>,
}

impl Workspace {
    /// Model discovery uses the installed Claude CLI's official initialization
    /// catalog. It sends no user prompt and never persists a native session.
    pub async fn claude_catalog(&self) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        self.claude_catalog_for(&self.default_cwd).await
    }

    async fn claude_catalog_for(&self, cwd: &str) -> Result<Value> {
        let (tx, rx) = mpsc::channel(256);
        let bridge = Bridge::spawn(tx).await?;
        Self::catalog_from(bridge, rx, cwd).await
    }

    /// The catalog from the machine's own CLI, through a bridge of its own
    /// that ends with its SSH session.
    async fn claude_catalog_remote(&self, machine: &RemoteMachine, cwd: &str) -> Result<Value> {
        let (digest, tools) = claude_remote_install(machine).await?;
        let (tx, rx) = mpsc::channel(256);
        let bridge = Bridge::spawn_command(tx, crate::remote::claude_direct_command(machine, &digest, &tools)?)?;
        Self::catalog_from(bridge, rx, cwd).await
    }

    async fn catalog_from(bridge: Arc<Bridge>, mut rx: mpsc::Receiver<Value>, cwd: &str) -> Result<Value> {
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let result = async {
            bridge
                .request(json!({"op":"start","cwd":cwd,"catalogOnly":true}))
                .await?;
            bridge.request(json!({"op":"models"})).await
        }
        .await;
        let cleanup = bridge.close_and_wait().await;
        let catalog = match result {
            Ok(catalog) => catalog,
            Err(error) => return Err(with_diagnostics(error, bridge.settled_diagnostics().await)),
        };
        cleanup?;
        Ok(catalog)
    }

    pub async fn claude_agent_catalog(&self, id: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let d = self.detail(id).await?;
        anyhow::ensure!(d.agent.harness == "claude", "Agent 不是 Claude");
        ensure_agent_open(&d.agent)?;
        self.claude_catalog_for_agent(&d.agent).await
    }

    async fn claude_catalog_for_agent(&self, agent: &Agent) -> Result<Value> {
        let existing = self.claudes.lock().unwrap().get(&agent.id).cloned();
        if let Some(c) = existing {
            c.bridge.request(json!({"op":"models"})).await
        } else if let Some(remote) = &agent.remote {
            self.claude_catalog_remote(&remote.machine, &agent.cwd).await
        } else {
            self.claude_catalog_for(&agent.cwd).await
        }
    }

    pub async fn claude_update_model(&self, id: &str, model: String) -> Result<AgentDetail> {
        self.claude_update_settings(id, model, None).await
    }

    /// Saves the model and reasoning effort together, both checked against
    /// what this Claude runtime lists for that model. `effort`: None keeps the
    /// saved choice, Some(None) returns to Claude Code's own default.
    pub async fn claude_update_settings(
        &self,
        id: &str,
        model: String,
        effort: Option<Option<String>>,
    ) -> Result<AgentDetail> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let d = self.detail(id).await?;
        anyhow::ensure!(d.agent.harness == "claude", "Agent 不是 Claude");
        ensure_agent_open(&d.agent)?;
        let model = model.trim();
        anyhow::ensure!(
            model.len() <= 200 && !model.contains('\0'),
            "Claude 模型名称无效"
        );
        let effort = match effort {
            Some(choice) => choice.filter(|level| !level.is_empty()),
            None => d.agent.settings.reasoning_effort.clone(),
        };
        if let Some(level) = &effort {
            anyhow::ensure!(EFFORT_LEVELS.contains(&level.as_str()), "Claude 推理强度无效");
        }
        if !model.is_empty() || effort.is_some() {
            let catalog = self.claude_catalog_for_agent(&d.agent).await?;
            if !model.is_empty() {
                validate_model(&catalog, model)?;
            }
            if let Some(level) = &effort {
                validate_effort(&catalog, model, level)?;
            }
        }
        // Save only. The live SDK query is deliberately untouched during an
        // active turn; claude_send applies both before the next send.
        let selected = model.to_owned();
        let event = json!({"model":model,"effort":effort});
        let result =
            self
                .update_record(id, "claude/modelSelected", event, move |d| {
                    d.agent.model = selected;
                    d.agent.settings.reasoning_effort = effort;
                }).await?;
        self.changed(id);
        Ok(result)
    }

    /// Unlike the model, a permission mode is applied to the live session at
    /// once, so it also governs later tool calls of a running turn. It is saved
    /// only after Claude accepts it; a stopped runtime receives it on start.
    pub async fn claude_set_permission_mode(&self, id: &str, mode: &str) -> Result<AgentDetail> {
        let _permit = self.admission.enter_work()?;
        anyhow::ensure!(
            SELECTABLE_PERMISSION_MODES.contains(&mode),
            "Claude 权限模式无效"
        );
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let d = self.detail(id).await?;
        anyhow::ensure!(d.agent.harness == "claude", "Agent 不是 Claude");
        ensure_agent_open(&d.agent)?;
        let live = self.claudes.lock().unwrap().get(id).cloned();
        if let Some(c) = live {
            c.bridge
                .request(json!({"op":"set_permission_mode","permissionMode":mode}))
                .await?;
        }
        let selected = mode.to_owned();
        let result = self.update_record(
            id,
            "claude/permissionModeSelected",
            json!({"permissionMode":mode}),
            move |d| d.agent.settings.permission_mode = Some(selected),
        ).await?;
        self.changed(id);
        Ok(result)
    }

    /// Caller holds the per-Agent lifecycle gate: an explicit Close or delete
    /// (update drain detaches only an idle runtime itself). Retain native
    /// session identity and history. A running turn is interrupted first; if
    /// Claude does not confirm that it ended (nothing may name the prompt's
    /// result), the user's Close still ends this connection, and only once the
    /// process has exited is what was running kept as unknown, never completed.
    pub(crate) async fn claude_close_runtime(&self, id: &str) -> Result<()> {
        let connection = self.claudes.lock().unwrap().get(id).cloned();
        let Some(c) = connection else {
            return Ok(());
        };
        // Each Turn's status, as the send view has it (T-140).
        let d = self.send_view(id).await?;
        let mut unconfirmed = false;
        if d.turns.iter().any(|turn| turn["status"] == "inProgress") {
            let ended = match self.claude_interrupt(id).await {
                Ok(()) => match timeout(STOP_CONFIRMATION, async {
                    loop {
                        let busy = self
                            .send_view(id)
                            .await?
                            .turns
                            .iter()
                            .any(|t| t["status"] == "inProgress");
                        if !busy || !self.claudes.lock().unwrap().contains_key(id) {
                            return Result::<()>::Ok(());
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                {
                    Ok(result) => {
                        result?;
                        true
                    }
                    Err(_) => false,
                },
                // Its exit already recorded the outcome if it is gone.
                Err(_) => !self.claudes.lock().unwrap().contains_key(id),
            };
            unconfirmed = !ended;
        }
        let generation = c.generation;
        {
            let _owned = self.owner(id).await;
            let mut connections = self.claudes.lock().unwrap();
            if connections
                .get(id)
                .is_some_and(|v| v.generation == c.generation)
            {
                connections.remove(id);
            }
        }
        // Fence all queued native events before the lifecycle owner updates or
        // deletes the record. Closing the SDK does not delete its transcript.
        if let Err(error) = c.bridge.close_and_wait().await {
            // Retain an unconfirmed shutdown handle so a second close cannot
            // mistake the absent connection for successful cleanup. Advance
            // its generation to keep old exit events fenced out as well.
            let mut retained = c;
            retained.generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
            let _owned = self.owner(id).await;
            self.claudes
                .lock()
                .unwrap()
                .entry(id.into())
                .or_insert(retained);
            return Err(error);
        }
        if unconfirmed {
            // The process has exited and its generation is fenced: nothing
            // can report this work any more. Nothing is sent again.
            let message = "Claude 未确认停止，关闭时结束了它的连接；这次执行的结果未确认，不会重发。原 Session 与历史保留。";
            self.update_record(id, "claude/stopUnconfirmed", json!({"generation":generation}), move |d| {
                for turn in &mut d.turns {
                    if turn["status"] == "inProgress" {
                        mark_unknown(turn);
                        turn["error"] = json!({"message":message});
                    }
                }
                for pending in &mut d.pending {
                    pending.stale = true;
                }
                settle_unconfirmed_messages(d);
                settle_subagents(d);
                d.agent.connection_state = "disconnected".into();
            }).await?;
            self.changed(id);
        } else if self.detail(id).await?.turns.iter().any(running_subagents) {
            // Its turns ended, but sub-agents and other tasks running in the
            // background cannot report any more either.
            self.update_record(id, "claude/subAgentsEnded", json!({"generation":generation}), settle_subagents).await?;
            self.changed(id);
        }
        Ok(())
    }

    pub async fn claude_create(
        self: &Arc<Self>,
        name: String,
        legacy_goal: String,
        cwd: String,
        model: String,
        project_id: Option<String>,
    ) -> Result<Agent> {
        self.claude_create_on(name, legacy_goal, cwd, model, None, project_id).await
    }

    /// A Claude Agent on Core's machine, or on a saved remote machine over
    /// SSH: then its folder, runtime, session and login are that machine's.
    pub async fn claude_create_on(
        self: &Arc<Self>,
        name: String,
        _legacy_goal: String,
        cwd: String,
        model: String,
        machine_id: Option<String>,
        project_id: Option<String>,
    ) -> Result<Agent> {
        let permit = self.admission.enter_work()?;
        if name.trim().is_empty() || name.len() > 100 {
            bail!("请填写名称（最多 100 字节）");
        }
        if let Some(project) = project_id.clone() {
            self.stored(move |store| store.ensure_project_assignable(&project)).await?;
        }
        let machine = match machine_id.filter(|id| id != "local") {
            Some(id) => Some(self.stored(move |store| store.machine(&id)).await?),
            None => None,
        };
        let cwd = match &machine {
            Some(machine) => crate::remote::canonicalize(machine, &cwd).await?,
            None => {
                let cwd = std::fs::canonicalize(cwd).context("工作目录不存在或无法读取")?;
                anyhow::ensure!(cwd.is_dir(), "工作目录必须是文件夹");
                cwd.to_string_lossy().into_owned()
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        let colors = ["yuzu", "sage", "rose", "sky"];
        let count = self.stored(|store| store.agents()).await?.len();
        let agent = Agent {
            id: id.clone(),
            name: name.trim().into(),
            goal: String::new(),
            work_summary: None,
            project_id,
            cwd,
            model,
            settings: Default::default(),
            color: colors[count % colors.len()].into(),
            harness: "claude".into(),
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
            remote: machine.map(RemoteAgent::new),
            connection_state: "disconnected".into(),
            closed_at: None,
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
            // A close/delete may win the gate before this background startup.
            // It is a user action, not a runtime failure to append afterward.
            if !ws
                .detail(&id)
                .await
                .is_ok_and(|d| d.agent.closed_at.is_none())
            {
                return;
            }
            if let Err(error) = ws.claude_ensure(&id).await {
                ws.failed(&id, &error).await;
            }
        });
        Ok(agent)
    }

    pub(crate) async fn claude_ensure(self: &Arc<Self>, id: &str) -> Result<Connection> {
        // Only the Agent and its Turns' statuses are read (send_view): a long
        // record is not copied for a check (T-140).
        ensure_agent_open(&self.send_view(id).await?.agent)?;
        let existing = self.claudes.lock().unwrap().get(id).cloned();
        if let Some(c) = existing {
            return Ok(c);
        }
        let d = self.send_view(id).await?;
        if d.agent.claude_session_id.is_none() && !d.turns.is_empty() {
            bail!(
                "Claude 上次任务已发送但原生 Session ID 未确认；不会创建另一个 Session 或重发任务"
            );
        }
        self
            .record_meta(id, "claude/connecting", json!({}), |m| {
                m.agent.connection_state = "connecting".into()
            }).await?;
        self.changed(id);
        let (tx, mut rx) = mpsc::channel(256);
        let events = crate::updates::events::EventBarrier::new(tx.clone());
        let backlog = Arc::new(crate::backlog::Backlog::default());
        let sender = crate::backlog::EventSender::observed(tx, backlog.clone());
        let spawned = match &d.agent.remote {
            Some(remote) => self.claude_remote_bridge(&remote.machine, id, sender).await,
            None => Bridge::spawn(sender).await.map(|bridge| (bridge, None)),
        };
        let (bridge, remote_instance) = match spawned {
            Ok(b) => b,
            Err(error) => {
                self
                    .update_record(id, "claude/connectFailed", json!({}), |d| {
                        d.agent.connection_state = "disconnected".into()
                    }).await?;
                return Err(error);
            }
        };
        let c = Connection {
            remote_instance,
            generation: self.next_generation.fetch_add(1, Ordering::Relaxed),
            bridge,
            events: Some(events.clone()),
        };
        {
            let _owned = self.owner(id).await;
            self.claudes.lock().unwrap().insert(id.into(), c.clone());
            self.backlogs.track(id, c.generation, backlog.clone());
        }
        let ws = self.clone();
        let agent_id = id.to_owned();
        let generation = c.generation;
        let event_barrier = Arc::downgrade(&events);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let native = crate::backlog::is_native(&event);
                if let Some(barrier) = event_barrier.upgrade() {
                    if barrier.acknowledge(&event) { continue; }
                    if barrier.is_closing() && matches!(event["type"].as_str(), Some("exit" | "disconnected")) {
                        let _event = ws.admission.enter_event();
                        ws.update_claude_detached(&agent_id, generation).await;
                        if native { backlog.applied(); }
                        continue;
                    }
                }
                let _event = ws.admission.enter_event();
                ws.dispatch_claude_event(&agent_id, generation, event).await;
                if native { backlog.applied(); }
            }
        });
        let mut start = start_params(&d.agent);
        if let Some(remote) = &d.agent.remote {
            // The machine reaches Workspace MCP through Core's reverse forward,
            // as a remote Codex does; the URL below is then its own loopback.
            if let Err(error) = self.ensure_collaboration_tunnel(&remote.machine).await {
                c.bridge.close();
                return Err(error);
            }
        }
        if let Some(config) = self.collaboration_http_config(&d.agent).await? {
            start["collaborationMcp"] = config;
            start["capabilityNotice"] = crate::guide::session_notice().into();
            // The turn-end Brief check (brief_turns): the bridge's Stop hook
            // asks once per turn, and appends the rules to its system prompt.
            // Membership is read here: a project change applies from the next
            // start, while Core's own turn-end record follows it at once.
            start["brief"] = crate::brief_turns::claude_start_option(self, &d.agent.id).await?;
        }
        let started = match c.bridge.request(start).await {
            Ok(started) => started,
            Err(error) => {
                // This query failed to start; end its process first so stderr
                // closes and its last lines can be read without waiting.
                c.bridge.close();
                let error = with_diagnostics(error, c.bridge.settled_diagnostics().await);
                let owned = self.owner(id).await;
                let removed = {
                    let mut connections = self.claudes.lock().unwrap();
                    let current = connections
                        .get(id)
                        .is_some_and(|v| v.generation == c.generation);
                    if current {
                        connections.remove(id);
                    }
                    current
                };
                if removed {
                    let (agent, message) = (id.to_owned(), error.to_string());
                    self.stored_owned(owned, move |store| store.update(
                        &agent,
                        "claude/connectFailed",
                        &json!({"error":message}),
                        |d| {
                            d.agent.connection_state = "disconnected".into();
                        },
                    )).await?;
                }
                return Err(error);
            }
        };
        let owned = self.owner(id).await;
        anyhow::ensure!(
            self.claudes.lock().unwrap()
                .get(id)
                .is_some_and(|v| v.generation == c.generation),
            "Claude 在初始化时断开了连接"
        );
        let agent = id.to_owned();
        let session = d.agent.claude_session_id.clone();
        self.stored_owned(owned, move |store| store.update(
            &agent,
            "claude/ready",
            &json!({"sessionId":session,
                "account":started["account"],"version":started["version"],
                "provenance":started["provenance"]}),
            |d| {
                d.agent.connection_state = "connected".into();
                d.agent.status = "idle".into();
                d.agent.error = None;
                started_runtime(d.claude_runtime.get_or_insert_with(Default::default), &started);
                // Resume is historical only: no promise of continuing an old tool.
                for turn in &mut d.turns {
                    if turn["status"] == "inProgress" {
                        mark_unknown(turn);
                    }
                }
                // Old SDK callbacks cannot survive a new query. Their raw request
                // and disconnect evidence remain in the journal.
                d.pending.clear();
                // Nor can it confirm what an earlier query never reported reading.
                settle_unconfirmed_messages(d);
                // Nor report on an earlier query's sub-agents.
                settle_subagents(d);
            },
        )).await?;
        // What Claude saved of the resumed session while Yuzuno was not
        // reading it (Core stopped, or the session went on in a terminal).
        // Before the connection is used, so nothing new interleaves with it;
        // a failure to read it never blocks the connection.
        if let Some(session) = d.agent.claude_session_id.as_deref() {
            if let Err(error) = self.claude_backfill(id, &c, session).await {
                let message = error.to_string();
                self.update_record(id, "claude/historyFailed", json!({"sessionId":session,"error":message}), |_| {}).await?;
            }
        }
        self.collaboration_started(id, c.generation).await;
        self.changed(id);
        Ok(c)
    }

    /// The Agent's bridge on its machine: its runtime installed there, its
    /// host found or started (refused while an earlier turn still runs there
    /// without Yuzuno), and SSH joined to that host.
    async fn claude_remote_bridge(&self, machine: &RemoteMachine, id: &str, events: crate::backlog::EventSender) -> Result<(Arc<Bridge>, Option<String>)> {
        let (digest, _tools) = claude_remote_install(machine).await?;
        let workspace = self.stored(|store| store.workspace_id()).await?;
        let host = crate::remote::claude_ensure(machine, &workspace, id, &digest).await?;
        let bridge = Bridge::spawn_command(events, crate::remote::claude_attach_command(machine, &host)?)?;
        Ok((bridge, Some(host.instance_id)))
    }

    /// Adds what Claude saved of `session` that the record lacks
    /// (claude_history): every saved message's identity first, page by page,
    /// then only the messages needed, page by page, applied in one update.
    async fn claude_backfill(self: &Arc<Self>, id: &str, c: &Connection, session: &str) -> Result<()> {
        let read = c.bridge.request(json!({"op":"history_read","sessionId":session})).await?;
        let read_id = read["readId"].as_str().context("Claude 历史读取没有返回编号")?.to_owned();
        let outcome = async {
            let mut entries: Vec<crate::claude_history::Entry> = Vec::new();
            let mut from = 0u64;
            loop {
                let page = c.bridge.request(json!({"op":"history_index","readId":read_id,"from":from})).await?;
                entries.extend(serde_json::from_value::<Vec<crate::claude_history::Entry>>(page["entries"].clone())?);
                match page["next"].as_u64() {
                    Some(next) if next > from => from = next,
                    _ => break,
                }
            }
            let d = self.detail(id).await?;
            let plan = crate::claude_history::plan(&d, &entries);
            if plan.unmatched {
                self.update_record(id, "claude/historyUnmatched", json!({"sessionId":session,"saved":entries.len()}), |_| {}).await?;
                return Ok(());
            }
            if plan.steps.is_empty() {
                return Ok(());
            }
            let mut wanted: Vec<usize> = plan.steps.iter().filter_map(|s| s.offset()).collect();
            let mut messages = HashMap::new();
            while !wanted.is_empty() {
                let page = c.bridge.request(json!({"op":"history_messages","readId":read_id,"offsets":wanted})).await?;
                let delivered = page["messages"].as_array().cloned().unwrap_or_default();
                anyhow::ensure!(!delivered.is_empty(), "Claude 历史读取没有返回消息");
                for message in delivered {
                    if let Some(offset) = message["offset"].as_u64() {
                        messages.insert(offset as usize, message["message"].clone());
                    }
                }
                wanted.retain(|offset| !messages.contains_key(offset));
            }
            let (summary, now) = (json!({"sessionId":session,"saved":entries.len(),"planned":plan.steps.len()}), Utc::now());
            self.update_record(id, "claude/history", summary, move |d| {
                crate::claude_history::apply(d, &plan, &entries, &messages, now);
            }).await?;
            Ok(())
        }.await;
        let _ = c.bridge.request(json!({"op":"history_close","readId":read_id})).await;
        outcome
    }

    pub async fn claude_reconnect(self: &Arc<Self>, id: &str) -> Result<AgentDetail> {
        let _permit = self.admission.enter_work()?;
        self.claude_reconnect_accepted(id, &_permit).await
    }

    pub(crate) async fn claude_reconnect_accepted(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit) -> Result<AgentDetail> {
        self.claude_reconnect_gated(id, permit, true).await?.context("record")
    }

    /// Reconnects a Claude Agent under its gate; with `read`, returns the
    /// record as the reconnect left it, read under the same gate. Whether it
    /// is open is checked on the Agent as listed, not its history (T-140).
    pub(crate) async fn claude_reconnect_gated(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit, read: bool) -> Result<Option<AgentDetail>> {
        permit.validate(&self.admission)?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        ensure_agent_open(&self.listed(id).await?)?;
        if let Err(error) = self.claude_ensure(id).await {
            self.failed(id, &error).await;
            return Err(error);
        }
        if read { Ok(Some(self.detail(id).await?)) } else { Ok(None) }
    }

    pub async fn claude_send(self: &Arc<Self>, id: &str, text: String) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        if text.trim().is_empty() || text.len() > 100_000 {
            bail!("消息不能为空，且不能超过 100 KB");
        }
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        self.claude_send_locked(id, text).await
    }

    /// Called under the Agent gate. Only stage an advisory notification in an
    /// existing query; the SDK hook receipt, not this enqueue, records delivery.
    pub(crate) async fn claude_notify_mailbox_locked(
        self: &Arc<Self>,
        id: &str,
        text: &str,
        expected_turn_id: &str,
        client_id: &str,
    ) -> Result<Value> {
        let detail = self
            .detail(id)
            .await
            .map_err(|error| Rejected(error.to_string()))?;
        ensure_agent_open(&detail.agent).map_err(|error| Rejected(error.to_string()))?;
        if detail.agent.connection_state != "connected"
            || !detail
                .turns
                .iter()
                .any(|turn| turn["id"] == expected_turn_id && turn["status"] == "inProgress")
        {
            return Err(Rejected("Claude mailbox notification targets a stale turn".into()).into());
        }
        let connection =
            self.claudes.lock().unwrap().get(id).cloned().ok_or_else(|| {
                Rejected("Claude mailbox notification has no active runtime".into())
            })?;
        let response = connection
            .bridge
            .request(json!({
                "op":"notify_mailbox", "expectedTurnId":expected_turn_id,
                "clientMessageId":client_id, "text":text
            }))
            .await?;
        if !self
            .claudes
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|current| current.generation == connection.generation)
        {
            return Err(OutcomeUnknown(
                "Claude mailbox notification lost its runtime before acknowledgement".into(),
            )
            .into());
        }
        Ok(response)
    }

    pub(crate) async fn claude_admit_form(self: &Arc<Self>, id: &str) -> Result<()> {
        let detail = self.detail(id).await?;
        anyhow::ensure!(detail.agent.status != "uncertain"
            && !(detail.agent.connection_state != "connected" && detail.turns.iter().any(|t| t["status"] == "inProgress")),
            "The previous Claude turn is unconfirmed. Reconnect before submitting the form; your answers are kept");
        self.claude_admit_message(id).await
    }

    pub(crate) async fn claude_admit_message(self: &Arc<Self>, id: &str) -> Result<()> {
        self.claude_ensure(id).await?;
        self.require_collaboration(id).await
    }

    pub(crate) async fn claude_answer_form_locked(self: &Arc<Self>, id: &str, input: &crate::model::MessageInput) -> Result<Value> {
        let detail = self.detail(id).await?;
        if let Some(turn) = detail.turns.iter().rev().find(|t| t["status"] == "inProgress") {
            anyhow::ensure!(turn["_yuzunoSource"] != "native", "Wait for Claude to finish this recovered turn before submitting the form");
            self.claude_steer_locked(id, &input.text, turn["id"].as_str().context("Missing Claude turn ID")?, &input.client_message_id, &input.images).await
        } else {
            // This start has a durable message/requested receipt. Keep the same
            // unknown-outcome distinction as ordinary Claude sends.
            let sent = self.claude_send_input_locked(id, input.text.clone(), Some(input)).await?;
            let turn_id = sent["turnId"].as_str().context("Missing accepted Claude turn ID")?.to_owned();
            let client_id = input.client_message_id.clone();
            // Bind the optimistic input only after the native bridge accepted
            // it; an unacknowledged start must never confirm its own receipt.
            self.record_update(id, "message/bound", json!({"clientMessageId":client_id,"turnId":turn_id}), move |d| {
                if let Some(turn) = d.turns.iter_mut().find(|t| t["id"] == turn_id) {
                    if let Some(item) = turn["items"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["type"] == "userMessage")) {
                        item["clientId"] = client_id.into();
                    }
                }
            }).await?;
            Ok(sent)
        }
    }

    pub(crate) async fn claude_send_locked(
        self: &Arc<Self>,
        id: &str,
        text: String,
    ) -> Result<Value> {
        self.claude_send_input_locked(id, text, None).await
    }

    async fn claude_send_input_locked(
        self: &Arc<Self>, id: &str, text: String, input: Option<&crate::model::MessageInput>,
    ) -> Result<Value> {
        // What a send checks, as send_message reads it: the Agent, Turn
        // statuses and pending requests, not a copy of every Item (T-140).
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        if d.agent.connection_state == "connected"
            && (d.turns.iter().any(|t| t["status"] == "inProgress")
                || d.pending.iter().any(|p| !p.stale))
        {
            bail!("Claude 正在执行或等待审批；请先中断或回应请求");
        }
        let images = input.map_or(&[][..], |input| &input.images[..]);
        // A user sends explicitly after seeing the preserved historical status.
        // No old prompt is ever replayed when creating the resumed SDK query.
        let c = self.claude_ensure(id).await?;
        let (image_refs, shown) = self.claude_images(id, images, &c).await?;
        // A setting saved while a response was running takes effect only here,
        // between turns. A rejected control request never enqueues the prompt.
        // Effort goes first: a model change echoes a replayed frame that the
        // bridge holds as an open turn until the prompt claims it, and an
        // effort set before the switch carries over to the new model.
        c.bridge
            .request(json!({"op":"set_effort","effort":saved_effort(&d.agent)}))
            .await?;
        c.bridge
            .request(json!({"op":"set_model","model":d.agent.model}))
            .await?;
        anyhow::ensure!(self.claudes.lock().unwrap().get(id).is_some_and(|v| v.generation == c.generation),
            "Claude 连接已变化，消息未发送；草稿保留");
        let turn_id = uuid::Uuid::new_v4().to_string();
        let (requested, content) = (turn_id.clone(), user_content(&text, shown));
        let blocks = input.and_then(|input| input.text_blocks.clone());
        self.record_update(id, "claude/turnRequested", json!({"turnId":turn_id,"text":text,"images":images}), move |d| {
            let turn = d.turn_mut(&requested);
            turn["status"] = "inProgress".into();
            // The prompt is sent with its turn's id as its uuid, recorded
            // first: Claude's saved history names it (claude_history).
            turn["items"] = json!([{"id":format!("{requested}:input"),"type":"userMessage","content":content,"nativeUuid":requested}]);
            if let Some(blocks) = blocks { turn["items"][0][crate::message_content::BLOCKS] = serde_json::to_value(blocks).expect("text boundaries"); }
            // The prompt is sent as the Turn starts, at the same moment.
            let started = turn["_yuzunoStartedAt"].as_i64();
            conversation_time::stamp_message(&mut turn["items"][0], started, "core");
            d.agent.status = "working".into();
            d.agent.error = None;
        }).await?;
        self.changed(id);
        let mut send = json!({"op":"send","turnId":turn_id,"uuid":turn_id,"text":text});
        if !image_refs.is_empty() { send["images"] = image_refs.into(); }
        match c
            .bridge
            .request(send)
            .await
        {
            Ok(_) => {
                if !self.claudes.lock().unwrap()
                    .get(id)
                    .is_some_and(|v| v.generation == c.generation)
                {
                    return Err(OutcomeUnknown(
                        "Claude 已接受任务但连接已结束；请检查原 Session，不要重复发送".into(),
                    )
                    .into());
                }
                Ok(json!({"turnId":turn_id}))
            }
            Err(error) => {
                let ambiguous = error.downcast_ref::<Rejected>().is_none();
                if ambiguous {
                    let _owned = self.owner(id).await;
                    let mut connections = self.claudes.lock().unwrap();
                    if connections
                        .get(id)
                        .is_some_and(|value| value.generation == c.generation)
                    {
                        connections.remove(id);
                        c.bridge.close();
                    }
                }
                let (message, rejected) = (error.to_string(), !ambiguous);
                self.update_record(
                    id,
                    "runtime/error",
                    json!({"message":message,"turnId":turn_id}),
                    move |d| {
                        let turn = d.turn_mut(&turn_id);
                        if rejected {
                            turn["status"] = "failed".into();
                            turn["error"] = json!({"message":message});
                            d.agent.status = "error".into();
                        } else {
                            mark_unknown(turn);
                            d.agent.status = "uncertain".into();
                            d.agent.connection_state = "disconnected".into();
                            for pending in &mut d.pending {
                                pending.stale = true;
                            }
                            settle_subagents(d);
                        }
                        d.agent.error = Some(message);
                    },
                ).await?;
                self.changed(id);
                Err(error)
            }
        }
    }

    /// Called under the Agent gate (send_message): a follow-up to the user's
    /// running turn, sent as Claude Code takes a message typed while it works.
    /// Ok means it is queued at Claude, not read: a `message_delivery` event
    /// reports Claude naming it (see the bridge's `append`).
    pub(crate) async fn claude_steer_locked(
        self: &Arc<Self>,
        id: &str,
        text: &str,
        expected: &str,
        client_id: &str,
        images: &[String],
    ) -> Result<Value> {
        let d = self.detail(id).await?;
        ensure_agent_open(&d.agent)?;
        if d.agent.connection_state != "connected" {
            bail!("Claude 连接已结束；补充消息未发送，草稿保留");
        }
        if native_turn(expected) || !d.turns.iter().any(|t| t["id"] == expected && t["status"] == "inProgress") {
            bail!("原 Turn 已结束或发生变化；消息仍保留，请确认后作为新消息发送");
        }
        let c = self.claudes.lock().unwrap().get(id).cloned().context("Claude 连接已断开，补充消息未发送")?;
        let (image_refs, shown) = self.claude_images(id, images, &c).await?;
        anyhow::ensure!(self.claudes.lock().unwrap().get(id).is_some_and(|v| v.generation == c.generation),
            "Claude 连接已变化，补充消息未发送；草稿保留");
        // Should the turn end first, the follow-up runs as this turn.
        let follow_up = uuid::Uuid::new_v4().to_string();
        // Sent with a uuid its client id gives, so saved history names it.
        let mut append = json!({"op":"append","expectedTurnId":expected,"clientMessageId":client_id,
            "followUpTurnId":follow_up,"uuid":crate::claude_history::follow_up_uuid(client_id),"text":text});
        if !image_refs.is_empty() { append["images"] = image_refs.into(); }
        c.bridge.request(append).await?;
        if !self.claudes.lock().unwrap().get(id).is_some_and(|v| v.generation == c.generation) {
            return Err(OutcomeUnknown("Claude 收到补充消息后连接随即结束；不会自动重发".into()).into());
        }
        self.show_follow_up(id, expected, client_id, user_content(text, shown)).await?;
        Ok(json!({"turnId":expected,"queued":true}))
    }

    /// The images of a Claude message, off the async workers: checked and
    /// fitted to Claude's budget for the bridge, and as its item shows them
    /// (see `input_images::claude_images` and `history_images`).
    async fn claude_images(&self, id: &str, images: &[String], c: &Connection) -> Result<(Vec<Value>, Vec<Value>)> {
        if images.is_empty() {
            return Ok((vec![], vec![]));
        }
        let agent = self.send_view(id).await?.agent;
        if agent.remote.is_some() {
            let workspace = self.stored(|store| store.workspace_id()).await?;
            let instance = c.remote_instance.as_deref().context("远程 Claude 运行实例尚未确认，图片未发送")?;
            let refs = crate::remote_images::transfer(self.data_dir.clone(), &workspace, &agent,
                c.generation, instance, images).await?;
            let current = self.send_view(id).await?.agent;
            anyhow::ensure!(self.claudes.lock().unwrap().get(id).is_some_and(|v| v.generation == c.generation)
                && crate::remote_images::destination(&agent) == crate::remote_images::destination(&current),
                "远程 Claude 图片目标已变化，消息未发送；草稿保留");
            let (root, id, images) = (self.data_dir.clone(), id.to_owned(), images.to_vec());
            let shown = tokio::task::spawn_blocking(move || crate::input_images::history_images(&root, &id, &images)).await?;
            return Ok((refs, shown));
        }
        let (root, id, images) = (self.data_dir.clone(), id.to_owned(), images.to_vec());
        tokio::task::spawn_blocking(move || {
            let refs = crate::input_images::claude_images(&root, &id, &images)?;
            Ok((refs, crate::input_images::history_images(&root, &id, &images)))
        }).await?
    }

    /// Shows a follow-up Claude has queued where it was sent, marked unread:
    /// a turn started by a typed prompt names a folded message only on its
    /// result. The connection may have ended since it was checked; its
    /// receipt is then already unknown, and the item says the same.
    async fn show_follow_up(self: &Arc<Self>, id: &str, turn: &str, client_id: &str, content: Value) -> Result<()> {
        let (turn, client, at) = (turn.to_owned(), client_id.to_owned(), Utc::now());
        self.update_record(id, "claude/followUpQueued", json!({"clientMessageId":client_id,"turnId":turn}), move |d| {
            if !d.turns.iter().any(|t| t["items"].as_array().is_some_and(|items| items.iter().any(|i| i["clientId"] == client.as_str()))) {
                let unknown = d.message_receipts.iter().any(|r| r.input.client_message_id == client && r.status == "unknown");
                let mut item = follow_up_item(&turn, &client, content, at);
                item["_yuzunoDelivery"] = if unknown { "unknown" } else { "queued" }.into();
                d.turn_at(&turn, at)["items"].as_array_mut().expect("turn items").push(item);
            }
        }).await?;
        self.changed(id);
        Ok(())
    }

    pub async fn claude_interrupt(&self, id: &str) -> Result<()> {
        let _permit = self.admission.enter_completion()?;
        let d = self.detail(id).await?;
        ensure_agent_open(&d.agent)?;
        let turn_id = d
            .turns
            .iter()
            .rev()
            .find(|t| t["status"] == "inProgress")
            .and_then(|t| t["id"].as_str())
            .context("没有正在执行的 Claude Turn")?;
        let c = self
            .claudes
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("Claude 连接已断开，无法确认中断")?;
        let interrupted = turn_id.to_owned();
        self.update_record(
            id,
            "claude/interruptRequested",
            json!({"turnId":turn_id}),
            move |d| {
                d.turn_mut(&interrupted)["interruptRequested"] = true.into();
            },
        ).await?;
        self.changed(id); // perf-sse: clients no longer poll for it
        c.bridge.request(json!({"op":"interrupt"})).await?;
        // Native result, not interrupt ACK, determines the terminal state.
        Ok(())
    }

    /// Stops the one task of Claude's the user picked (a background shell,
    /// monitor, workflow or sub-agent), by its task id: never the Turn,
    /// another task or the session. Claude acknowledges a stop of any id,
    /// ended or unknown alike (CLI 2.1.280, T-25 probe), so the task must be
    /// in the latest snapshot of running tasks this connection sent, and only
    /// its own end says it stopped. False: a stop already sent for it is
    /// still waiting for that end, and nothing is sent again.
    pub async fn claude_stop_task(&self, id: &str, task_id: &str) -> Result<bool> {
        let _permit = self.admission.enter_completion()?;
        let d = self.detail(id).await?;
        ensure_agent_open(&d.agent)?;
        anyhow::ensure!(d.agent.harness == "claude", "只有 Claude Agent 有可单独停止的后台任务");
        let (turn_id, item_id, key, record) = task_of(&d, task_id).context("这个 Agent 没有这个后台任务")?;
        anyhow::ensure!(subagent_running(&record), "这个任务已经结束，或它的状态已无法确认");
        let c = self.claudes.lock().unwrap().get(id).cloned().context("Claude 连接已断开，无法停止这个任务")?;
        match self.background_shells.claude_running(id, c.generation, task_id) {
            Some(true) => {}
            Some(false) => bail!("Claude 当前报告的运行中任务里没有它，不能确认它还在运行"),
            None => bail!("这次连接中 Claude 还没有报告正在运行的任务，暂时不能停止"),
        }
        if stop_pending(&record) {
            return Ok(false);
        }
        let data = |error: Option<&str>| json!({"taskId":task_id,"turnId":turn_id,"itemId":item_id,"generation":c.generation,"error":error});
        // Checked and claimed in one record update: of two stops at once, the
        // one whose update claimed it is sent, the other is not (R2). The flag
        // says which, not the time it wrote, which two requests can share.
        let claimed = Arc::new(AtomicBool::new(false));
        let (turn, item, flag, at) = (turn_id.clone(), item_id.clone(), claimed.clone(), Utc::now().to_rfc3339());
        self.update_record(id, "claude/taskStopRequested", data(None), move |d| {
            if let Some(record) = task_record_mut(d, &turn, &item, key) {
                flag.store(claim_stop(record, &at), Ordering::SeqCst);
            }
        }).await?;
        if !claimed.load(Ordering::SeqCst) {
            return Ok(false);
        }
        self.changed(id);
        if let Err(error) = c.bridge.request(json!({"op":"stop_task","taskId":task_id})).await {
            let (turn, item, text) = (turn_id.clone(), item_id.clone(), format!("{error:#}"));
            self.update_record(id, "claude/taskStopFailed", data(Some(&text)), move |d| {
                if let Some(record) = task_record_mut(d, &turn, &item, key) {
                    record["stopError"] = text.into();
                }
            }).await?;
            self.changed(id);
            return Err(error);
        }
        Ok(true)
    }

    pub(crate) async fn claude_respond(
        &self,
        id: &str,
        request_id: &str,
        response: &Value,
    ) -> Result<bool> {
        // Checked and recorded under the ownership lock, like a disconnect;
        // the native reply below is sent without it.
        let owned = self.owner(id).await;
        let connection = self.claudes.lock().unwrap().get(id).cloned();
        let (agent, request, reply) = (id.to_owned(), request_id.to_owned(), response.clone());
        let checked = self.stored_owned(owned, move |store| {
            let d = store.detail(&agent)?;
            ensure_agent_open(&d.agent)?;
            let Some(p) = d.pending.iter().find(|p| p.id == request) else {
                return Ok(None);
            };
            let c = connection.context("Claude 连接已断开，请求未发送")?;
            validate_permission(p, c.generation, &reply)?;
            store.update(
                &agent,
                "request/replied",
                &json!({"requestId":request}),
                |d| {
                    if let Some(p) = d.pending.iter_mut().find(|p| p.id == request) {
                        p.params["_responseSent"] = true.into();
                    }
                },
            )?;
            Ok(Some((p.clone(), c)))
        }).await?;
        let Some((p, c)) = checked else {
            return Ok(false);
        };
        let mut command = json!({"op":"respond","requestId":p.params["requestId"],
            "decision":response["decision"],"updatedInput":response.get("updatedInput").unwrap_or(&p.params["input"])});
        for key in ["scope", "message"] {
            if let Some(value) = response.get(key) {
                command[key] = value.clone();
            }
        }
        let result = c.bridge.request(command).await;
        match result {
            Ok(_) => {
                let owned = self.owner(id).await;
                if self.claudes.lock().unwrap()
                    .get(id)
                    .is_some_and(|v| v.generation == c.generation)
                {
                    let (agent, request) = (id.to_owned(), request_id.to_owned());
                    self.stored_owned(owned, move |store| store.update(
                        &agent,
                        "claude/permissionResolved",
                        &json!({"requestId":request}),
                        |d| {
                            d.pending.retain(|p| p.id != request);
                            refresh_status(d);
                        },
                    )).await?;
                }
            }
            Err(error) => {
                // Once queued, uncertain authorization must never become an
                // enabled button again. Rejected callbacks are stale evidence.
                let (request, message) = (request_id.to_owned(), error.to_string());
                self.update_record(
                    id,
                    "claude/permissionResponseFailed",
                    json!({"requestId":request_id,"error":message}),
                    move |d| {
                        if let Some(p) = d.pending.iter_mut().find(|p| p.id == request) {
                            p.stale = true;
                        }
                        d.agent.error = Some(message);
                    },
                ).await?;
                self.changed(id);
                return Err(error);
            }
        }
        self.changed(id);
        Ok(true)
    }

    /// One bridge event, handled like a Codex event (see
    /// `Workspace::dispatch_event`): off the async workers, under this
    /// Agent's ownership lock only.
    async fn dispatch_claude_event(self: &Arc<Self>, id: &str, generation: u64, message: Value) {
        let owned = self.owner(id).await;
        let (ws, id) = (self.clone(), id.to_owned());
        let permit = self.admission.enter_event();
        let handled = crate::db::blocking(move || {
            let _permit = permit;
            let _owned = owned;
            ws.claude_event(&id, generation, message);
            Ok(())
        });
        if let Err(error) = handled.await {
            eprintln!("Workspace Claude event not handled: {error}");
        }
    }

    /// Blocking; called by `dispatch_claude_event` with the ownership lock held.
    fn claude_event(self: &Arc<Self>, id: &str, generation: u64, message: Value) {
        if !self.claudes.lock().unwrap()
            .get(id)
            .is_some_and(|v| v.generation == generation)
        {
            return;
        }
        match message["type"].as_str() {
            Some("message_delivery") => {
                let (Some(client_id), Some(turn_id), Some(status)) = (
                    message["clientMessageId"].as_str(),
                    message["turnId"].as_str(),
                    message["status"].as_str(),
                ) else {
                    return;
                };
                if !matches!(status, "accepted" | "next") {
                    return;
                }
                let at = Utc::now();
                let _ = self.store.record_event(id, "claude/messageDelivery", &message, |d| {
                    deliver_message(d, &self.data_dir, client_id, turn_id, status, at)
                });
            }
            Some("effort") => {
                // What the turn actually ran at, from Claude's Stop hook.
                let Some(level) = message["level"].as_str().filter(|l| EFFORT_LEVELS.contains(l)) else {
                    return;
                };
                let applied = json!({"level": level, "turnId": message["turnId"]});
                let _ = self.store.record_event(id, "claude/effortApplied", &message, |d| {
                    d.claude_runtime.get_or_insert_with(Default::default).effort = Some(applied);
                });
                self.changed(id);
            }
            Some("brief_policy") => {
                let (Some(request), Some(turn)) = (message["requestId"].as_str(), message["turnId"].as_str()) else { return };
                let required = match crate::project_brief::agent_must_update_brief(&self.store, id) {
                    Ok(project) => project.is_some(),
                    Err(error) => {
                        eprintln!("Workspace Claude Brief policy: {error:#}");
                        return;
                    }
                };
                // This handler already checked the bridge generation under
                // Agent ownership. A nonnumeric command ID cannot consume a
                // normal request's reply slot. No user/Agent tool can grant it.
                if let Some(runtime) = self.claudes.lock().unwrap().get(id).filter(|v| v.generation == generation) {
                    let _ = runtime.bridge.tx.try_send(json!({"id":format!("brief-policy-{request}"),
                        "op":"brief_policy","requestId":request,"turnId":turn,"required":required}));
                }
            }
            Some("brief") => {
                // The bridge's Stop hook: `blocked` while it holds a stop, then
                // the turn's own outcome before its result frame. Only Core's
                // receipt counts as an update (brief_turns).
                let (Some(turn_id), Some(outcome)) = (message["turnId"].as_str(), message["outcome"].as_str()) else {
                    return;
                };
                if let Err(error) = crate::brief_turns::record_bridge_outcome(self, id, turn_id, outcome) {
                    eprintln!("Workspace Claude brief outcome: {error:#}");
                }
                // Journaled with the record's metadata, without copying it.
                let _ = self.store.update_meta(id, "claude/brief", &message, |_| {});
            }
            Some("mailbox_delivery") => {
                let (Some(client_id), Some(turn_id), Some(status)) = (
                    message["clientMessageId"].as_str(),
                    message["turnId"].as_str(),
                    message["status"].as_str(),
                ) else {
                    return;
                };
                if !matches!(status, "injected" | "deferred") {
                    return;
                }
                let Ok(detail) = self.store.send_view(id) else {
                    return;
                };
                if let Err(error) = self.store.record_peer_hook_delivery(
                    id,
                    client_id,
                    turn_id,
                    detail.agent.claude_session_id.as_deref(),
                    status,
                ) {
                    eprintln!("Workspace Claude mailbox receipt: {error}");
                    return;
                }
                let _ = self.store.update_meta(id, "peer/hookDelivery", &message, |_| {});
                let _ = self.changes.send(json!({"collaboration":true}));
                self.collaboration_wakeup.notify_one();
            }
            Some("event") => {
                let event = &message["event"];
                let turn_id = message["turnId"].as_str();
                // A process-level snapshot, often between Turns. The record
                // keeps it as evidence only, so a changed count is announced here.
                if event["type"] == "system" && event["subtype"] == "background_tasks_changed"
                    && self.background_shells.record_claude(id, generation, event)
                {
                    self.changed(id);
                }
                let kind = format!("claude/{}", event["type"].as_str().unwrap_or("unknown"));
                match crate::store::route(&kind, &message) {
                    crate::store::Route::Ignored => return,
                    crate::store::Route::Synchronous if event["type"] == "result" => {
                        // Only the ended Turn and the usage-limit check are taken
                        // from the committed record, not a copy of all of it (T-140).
                        let result = self.store.update_picking(
                            id,
                            &kind,
                            &message,
                            |d| project_event(d, turn_id, event),
                            |d| {
                                let ended = turn_id.and_then(|tid| {
                                    d.turns.iter().find(|t| {
                                        t["id"] == tid
                                            && matches!(
                                                t["status"].as_str(),
                                                Some("completed" | "failed" | "interrupted")
                                            )
                                    }).cloned()
                                });
                                (ended, crate::claude_quota::result_stop(d))
                            },
                        );
                        if let Ok((ended, stop)) = result {
                            if let Some(turn) = ended {
                                // Common read-state journal; raw SDK result is
                                // kept separately and never fabricated.
                                let _ = self.store.record_recovered_completion(id, &turn);
                            }
                            crate::claude_quota::observe_result(self, id, stop);
                        }
                    }
                    crate::store::Route::Synchronous => {
                        let _ = self.store.record_event(id, &kind, &message, |d| project_event(d, turn_id, event));
                    }
                    route => {
                        // Progress inside the Turn: applied in memory and
                        // announced by the stream ticker (or only journaled,
                        // for evidence); see store::Route. One that changed
                        // status anyway is announced now.
                        let streamed = self.store.record_stream(id, route, &kind, &message).unwrap_or_default();
                        // perf-sse: send what it changed, still under the event lock.
                        if let Some(rev) = streamed.rev { self.streamed_claude(id, turn_id, event, rev); }
                        self.start_stream_ticker();
                        if streamed.urgent { self.changed(id); }
                        return;
                    }
                }
            }
            Some("permission") => {
                let Some(native_id) = message["requestId"].as_str() else {
                    return;
                };
                // The Turn the request belongs to, or None to ignore it.
                let decide = |detail: &AgentDetail| -> Option<String> {
                    // A background sub-agent's call while no turn runs asks with
                    // no turn: it belongs to the turn of the sub-agent's call,
                    // which has ended. No turn is opened for it, so nothing is
                    // left running once it is answered.
                    let subagent = message["turnId"].is_null().then(|| subagent_request_turn(detail, &message)).flatten();
                    let tid = message["turnId"].as_str().map(str::to_owned).or_else(|| subagent.clone())?;
                    // A turn of Claude's own may ask before it shows anything.
                    let open = subagent.is_some()
                        || detail
                            .turns
                            .iter()
                            .find(|t| t["id"] == tid.as_str())
                            .map_or(native_turn(&tid), |t| t["status"] == "inProgress");
                    open.then_some(tid)
                };
                // Read where it is held (a Turn is running), without copying a
                // long record; otherwise from its rows (T-140).
                let decided = match self.store.peek(id, decide) {
                    Some(decided) => decided,
                    None => match self.store.detail(id) {
                        Ok(detail) => decide(&detail),
                        Err(_) => return,
                    },
                };
                let Some(tid) = decided else {
                    return;
                };
                let tid = tid.as_str();
                let mut params = message.clone();
                params["turnId"] = tid.into();
                params["_runtimeGeneration"] = generation.into();
                params["_responseSent"] = false.into();
                let request = PendingRequest {
                    id: uuid::Uuid::new_v4().to_string(),
                    agent_id: id.into(),
                    method: "claude/canUseTool".into(),
                    params,
                    created_at: now(),
                    stale: false,
                };
                let _ = self.store.record_event(id, "request", &message, |d| {
                    if !d.turns.iter().any(|t| t["id"] == tid) {
                        open_native_turn(d, tid, Utc::now(), false);
                    }
                    if !d.pending.iter().any(|p| {
                        !p.stale
                            && p.params["requestId"] == native_id
                            && p.params["_runtimeGeneration"] == generation
                    }) {
                        d.pending.push(request);
                    }
                    refresh_status(d);
                });
            }
            Some("permission_cancelled") => {
                let _ = self
                    .store
                    .record_event(id, "claude/permissionCancelled", &message, |d| {
                        d.pending.retain(|p| {
                            p.params["requestId"] != message["requestId"]
                                || p.params["_runtimeGeneration"] != generation
                        });
                        refresh_status(d);
                    });
            }
            Some("exit" | "disconnected") => {
                let removed = self.claudes.lock().unwrap().remove(id);
                if let Some(c) = &removed {
                    c.bridge.close();
                }
                let base = message["error"].as_str().unwrap_or("Claude 连接已结束；执行完成情况未获确认，恢复只使用原生 Session 历史").to_owned();
                let _ = self.store.update(id, "runtime/error", &message, |d| {
                    d.agent.connection_state = "disconnected".into();
                    let busy = d.turns.iter().any(|t| t["status"] == "inProgress");
                    for turn in &mut d.turns { if turn["status"] == "inProgress" { mark_unknown(turn); } }
                    d.agent.status = if busy { "uncertain" } else { "offline" }.into();
                    d.agent.error = Some(match &d.agent.remote {
                        // remote-host.mjs: the turn goes on there without Yuzuno.
                        Some(remote) if message["hostBusy"] != true => format!(
                            "与 {} 的连接已断开。正在执行的一轮会在那台机器上继续，等待中的批准会被拒绝（不会代为批准）；那一轮结束后重连，会从同一原生 Session 恢复它保存的历史，而不是逐条重放。（{base}）",
                            remote.machine.name),
                        _ => base.clone(),
                    });
                    for p in &mut d.pending { p.stale = true; }
                    settle_unconfirmed_messages(d);
                    settle_subagents(d);
                    if let Some(runtime) = &mut d.claude_runtime {
                        runtime.permission_mode = None;
                    }
                });
                // Core's own closes remove the connection first, so any exit
                // reaching here is unexpected. Explain it with Claude's last
                // output once stderr has drained; the state above never waits.
                if let Some(c) = removed {
                    let ws = self.clone();
                    let agent_id = id.to_owned();
                    let event_writer = ws.admission.enter_event();
                    tokio::spawn(async move {
                        let _event_writer = event_writer;
                        let Some(tail) = c.bridge.settled_diagnostics().await else {
                            return;
                        };
                        let _ = ws.update_record(&agent_id, "runtime/diagnostics", json!({"stderr":tail}), move |d| {
                            // Never during a reconnect, after a close, or over
                            // a newer error.
                            if d.agent.connection_state == "disconnected"
                                && d.agent.closed_at.is_none()
                                && d.agent.error.as_deref() == Some(base.as_str())
                            {
                                d.agent.error = Some(diagnostic_message(&base, &tail));
                            }
                        }).await;
                        ws.changed(&agent_id);
                    });
                }
            }
            _ => {
                // Journaled only: nothing of the record changes, so it is
                // committed as metadata, without copying the Turns (T-140).
                let _ = self.store.update_meta(id, "claude/bridgeEvent", &message, |_| {});
            }
        }
        self.changed(id);
    }
}

/// The user's saved effort, if it is one the SDK accepts. None leaves Claude
/// Code's own setting (the user's Claude settings, else the model default).
fn saved_effort(agent: &Agent) -> Option<&str> {
    agent
        .settings
        .reasoning_effort
        .as_deref()
        .filter(|level| EFFORT_LEVELS.contains(level))
}

/// A level is saved only for a model this runtime says takes it. The empty
/// model is Claude Code's default, listed by the SDK as `default`.
fn validate_effort(catalog: &Value, model: &str, level: &str) -> Result<()> {
    let wanted = if model.is_empty() { "default" } else { model };
    let entry = catalog["models"].as_array().and_then(|models| {
        models
            .iter()
            .find(|entry| entry["model"] == wanted || entry["resolvedModel"] == wanted)
    });
    let Some(entry) = entry else {
        bail!("无法确认所选 Claude 模型支持的推理强度，请先选择具体模型");
    };
    anyhow::ensure!(
        entry["supportsEffort"] == true,
        "所选 Claude 模型不接受推理强度；请选择“Claude Code 默认”"
    );
    anyhow::ensure!(
        entry["supportedEffortLevels"]
            .as_array()
            .is_some_and(|levels| levels.iter().any(|l| l == level)),
        "所选 Claude 模型不支持推理强度 {level}；请重新选择"
    );
    Ok(())
}

fn validate_model(catalog: &Value, model: &str) -> Result<()> {
    anyhow::ensure!(
        catalog["models"].as_array().is_some_and(|models| models
            .iter()
            .any(|entry| { entry["model"] == model || entry["resolvedModel"] == model })),
        "当前 Claude runtime 未提供该模型，请刷新模型列表后选择"
    );
    Ok(())
}

fn validate_permission(p: &PendingRequest, generation: u64, response: &Value) -> Result<()> {
    anyhow::ensure!(
        !p.stale && p.params["_runtimeGeneration"].as_u64() == Some(generation),
        "这是旧连接的历史请求，不能授权"
    );
    anyhow::ensure!(
        p.params["_responseSent"] != true,
        "回答已提交，请勿重复提交"
    );
    anyhow::ensure!(
        matches!(response["decision"].as_str(), Some("allow" | "deny")),
        "Claude 审批必须是 allow 或 deny"
    );
    anyhow::ensure!(
        response.get("updatedInput").is_none_or(Value::is_object),
        "Claude updatedInput 必须是对象"
    );
    anyhow::ensure!(
        response
            .get("scope")
            .is_none_or(|scope| matches!(scope.as_str(), Some("once" | "session"))),
        "审批范围只能是本次或本会话"
    );
    if response["scope"] == "session" {
        anyhow::ensure!(response["decision"] == "allow", "只有允许可以应用于本会话");
        // The bridge decided once what a session approval grants and sent it
        // with the request; requests from an older bridge offer none.
        anyhow::ensure!(
            p.params["sessionPermissions"]
                .as_array()
                .is_some_and(|updates| !updates.is_empty()),
            "Claude 没有为此操作提供本会话权限"
        );
    }
    if let Some(message) = response.get("message") {
        anyhow::ensure!(response["decision"] == "deny", "理由只能随拒绝一起发送");
        anyhow::ensure!(
            message.as_str().is_some_and(|text| text.len() <= 2000),
            "拒绝理由必须是文本，最多 2000 字节"
        );
    }
    if response["decision"] == "allow" {
        if let Some(proposed) = response.get("updatedInput") {
            if p.params["toolName"] != "AskUserQuestion" {
                anyhow::ensure!(proposed == &p.params["input"], "审批不能改变原生工具输入");
            } else {
                let mut original = p.params["input"]
                    .as_object()
                    .context("原生问题输入无效")?
                    .clone();
                let mut updated = proposed.as_object().unwrap().clone();
                original.remove("answers");
                let answers = updated.remove("answers").context("请填写问题答案")?;
                anyhow::ensure!(updated == original, "回答只能补充答案，不能改变原生问题");
                let answers = answers.as_object().context("问题答案必须是对象")?;
                anyhow::ensure!(!answers.is_empty(), "请填写问题答案");
                for (question, answer) in answers {
                    anyhow::ensure!(
                        original["questions"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|q| q["question"] == *question),
                        "答案不属于当前原生问题"
                    );
                    anyhow::ensure!(
                        answer
                            .as_str()
                            .is_some_and(|value| !value.trim().is_empty()),
                        "答案不能为空"
                    );
                }
            }
        }
    }
    Ok(())
}

/// What a bridge's `start` reported about this session's runtime.
fn started_runtime(runtime: &mut crate::model::ClaudeRuntime, started: &Value) {
    // The account is what this login reports now; none (e.g. an
    // API key) must not keep showing a previous subscription.
    let account = started.get("account").filter(|v| v.is_object()).cloned();
    if account != runtime.account {
        runtime.rate_limits = None;
        runtime.rate_limits_at = None;
    }
    runtime.account = account;
    // Older CLIs omit the version here; system/init reports it too.
    if let Some(version) = started["version"].as_str() {
        runtime.version = Some(version.into());
    }
    // This start's executable may differ from the last one's (PATH changed);
    // an older bridge reports none, so none is shown.
    runtime.provenance = started.get("provenance").filter(|v| v.is_object()).cloned();
    // A new session's mode is unknown until it reports one.
    runtime.permission_mode = None;
}

/// Thinking blocks seen only complete sort after streamed ones (small indexes).
const FINAL_THINKING_KEY: u64 = 1_000_000;

/// Per-turn working copies that are useless once the turn has ended.
pub(crate) fn drop_turn_scratch(turn: &mut Value) {
    if let Some(turn) = turn.as_object_mut() {
        for key in ["_claudeThinking", "_claudeThinkingConfirmed", "_claudeRequestUsage", "_claudeContextTokens"] {
            turn.remove(key);
        }
    }
}

fn mark_unknown(turn: &mut Value) {
    drop_turn_scratch(turn);
    turn["status"] = "outcomeUnknown".into();
    turn["error"] =
        json!({"message":"连接结束前未收到原生完成结果；Session 恢复不会重放未确认的工具。"});
    settle_open_tools(turn);
}

/// A turn ended: its tool calls still open will not report, so their state
/// is unknown. A sub-agent still running (in the background) goes on after
/// the turn, and so do its own calls; `settle_subagents` ends them with the
/// runtime.
pub(crate) fn settle_open_tools(turn: &mut Value) {
    let Some(items) = turn["items"].as_array_mut() else {
        return;
    };
    let running: Vec<String> = items
        .iter()
        .filter(|i| subagent_running(&i["subAgent"]))
        .filter_map(|i| i["id"].as_str().map(str::to_owned))
        .collect();
    for item in items {
        let running_child = item["parentToolUseId"].as_str().is_some_and(|p| running.iter().any(|r| r == p));
        if item["status"] == "inProgress" && !running_child {
            item["status"] = "unknown".into();
        }
    }
}

fn refresh_status(d: &mut AgentDetail) {
    if d.pending
        .iter()
        .any(|p| !p.stale && p.params["_responseSent"] != true)
    {
        d.agent.status = "waiting".into();
    } else if d.turns.iter().any(|t| t["status"] == "inProgress") {
        d.agent.status = "working".into();
    } else if d.agent.status == "waiting" || d.agent.status == "working" {
        d.agent.status = "idle".into();
    }
}

fn item_mut<'a>(turn: &'a mut Value, id: &str, initial: Value) -> &'a mut Value {
    let items = turn["items"].as_array_mut().expect("turn items");
    let idx = items.iter().position(|i| i["id"] == id).unwrap_or_else(|| {
        items.push(initial);
        items.len() - 1
    });
    &mut items[idx]
}

fn text_item(turn: &mut Value, message_id: &str, text: &str, append: bool) {
    let item = item_mut(
        turn,
        message_id,
        json!({"id":message_id,"type":"agentMessage","text":"","nativeMessageId":message_id}),
    );
    if append {
        let mut body = item["text"].as_str().unwrap_or("").to_owned();
        body.push_str(text);
        item["text"] = body.into();
    } else {
        item["text"] = text.into();
    }
}

fn start_params(agent: &Agent) -> Value {
    // Claude Code's file checkpoints, so a later restore can be previewed
    // (claude_checkpoints); sessions started without them have none.
    let mut params = json!({"op":"start","cwd":agent.cwd,"fileCheckpointing":true});
    if !agent.model.is_empty() {
        params["model"] = agent.model.clone().into();
    }
    if let Some(session) = &agent.claude_session_id {
        params["sessionId"] = session.clone().into();
    }
    if let Some(effort) = saved_effort(agent) {
        params["effort"] = effort.into();
    }
    if let Some(mode) = agent
        .settings
        .permission_mode
        .as_deref()
        .filter(|mode| SELECTABLE_PERMISSION_MODES.contains(mode))
    {
        params["permissionMode"] = mode.into();
    }
    params
}

// SDK assistant messages contain one completed block, not necessarily the
// complete native message. Keep streaming blocks by index and confirm each once.
fn stream_text(turn: &mut Value, mid: &str, index: &str, delta: &str) {
    if !turn["_claudeTextBlocks"].is_object() {
        turn["_claudeTextBlocks"] = json!({});
    }
    if !turn["_claudeTextBlocks"][mid].is_array() {
        turn["_claudeTextBlocks"][mid] = json!([]);
    }
    let blocks = turn["_claudeTextBlocks"][mid].as_array_mut().unwrap();
    let pos = blocks
        .iter()
        .position(|b| b["index"] == index)
        .unwrap_or_else(|| {
            blocks.push(json!({"index":index,"text":"","confirmed":false}));
            blocks.len() - 1
        });
    let mut text = blocks[pos]["text"].as_str().unwrap_or("").to_owned();
    text.push_str(delta);
    blocks[pos]["text"] = text.into();
    render_text(turn, mid);
}
fn render_text(turn: &mut Value, mid: &str) {
    let text = turn["_claudeTextBlocks"][mid]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("");
    text_item(turn, mid, &text, false);
}
fn confirm_text(turn: &mut Value, mid: &str, texts: &[&str], uuid: Option<&str>) {
    if !turn["_claudeTextBlocks"].is_object() {
        turn["_claudeTextBlocks"] = json!({});
    }
    if !turn["_claudeTextBlocks"][mid].is_array() {
        turn["_claudeTextBlocks"][mid] = json!([]);
    }
    if let Some(uuid) = uuid {
        if !turn["_claudeAssistantSeen"].is_object() {
            turn["_claudeAssistantSeen"] = json!({});
        }
        if turn["_claudeAssistantSeen"][uuid] == true {
            return;
        }
        turn["_claudeAssistantSeen"][uuid] = true.into();
    }
    let blocks = turn["_claudeTextBlocks"][mid].as_array_mut().unwrap();
    for text in texts {
        // The completed block replaces what its stream built. Streamed text
        // is never journaled, so after a restart the record may hold only
        // the start of it, written before the rest arrived.
        let streamed = blocks
            .iter()
            .position(|b| b["confirmed"] != true && b["text"] == *text)
            .or_else(|| {
                // An empty block (content_block_start before any delta) is
                // the start of every text, so it never matches by prefix.
                blocks.iter().position(|b| {
                    b["confirmed"] != true
                        && b["text"].as_str().is_some_and(|partial| !partial.is_empty() && text.starts_with(partial))
                })
            });
        if let Some(index) = streamed {
            blocks[index]["text"] = (*text).into();
            blocks[index]["confirmed"] = true.into();
        } else {
            blocks.push(json!({"text":text,"confirmed":true}));
        }
    }
    render_text(turn, mid);
}

/// Thinking shares the existing reasoning-summary item, one per native
/// message. Omitted (empty) thinking creates no item.
fn stream_thinking(turn: &mut Value, mid: &str, index: &str, delta: &str) {
    if delta.is_empty() {
        return;
    }
    if !turn["_claudeThinking"].is_object() {
        turn["_claudeThinking"] = json!({});
    }
    if !turn["_claudeThinking"][mid].is_object() {
        turn["_claudeThinking"][mid] = json!({});
    }
    let mut text = turn["_claudeThinking"][mid][index]
        .as_str()
        .unwrap_or("")
        .to_owned();
    text.push_str(delta);
    turn["_claudeThinking"][mid][index] = text.into();
    render_thinking(turn, mid);
}
/// A completed thinking block, possibly already streamed; never repeated.
fn confirm_thinking(turn: &mut Value, mid: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let parts: Vec<(String, String)> = turn["_claudeThinking"][mid]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, part)| Some((key.clone(), part.as_str()?.to_owned())))
        .collect();
    let confirm = |turn: &mut Value, key: &str| {
        if !turn["_claudeThinkingConfirmed"].is_object() {
            turn["_claudeThinkingConfirmed"] = json!({});
        }
        if !turn["_claudeThinkingConfirmed"][mid].is_object() {
            turn["_claudeThinkingConfirmed"][mid] = json!({});
        }
        turn["_claudeThinkingConfirmed"][mid][key] = true.into();
    };
    if let Some((key, _)) = parts.iter().find(|(_, part)| part == text) {
        confirm(turn, key);
        return;
    }
    // It replaces the start of it that streamed, unconfirmed, into a block
    // index (see confirm_text); streamed thinking is never journaled.
    let streamed = parts.iter().find(|(key, part)| {
        key.parse::<u64>().is_ok_and(|index| index < FINAL_THINKING_KEY)
            && turn["_claudeThinkingConfirmed"][mid][key.as_str()] != true
            && !part.is_empty()
            && text.starts_with(part.as_str())
    });
    if let Some((key, _)) = streamed {
        turn["_claudeThinking"][mid][key.as_str()] = text.into();
        confirm(turn, key);
        render_thinking(turn, mid);
        return;
    }
    // Numeric keys after any streamed block index keep arrival order.
    let key = (FINAL_THINKING_KEY + parts.len() as u64).to_string();
    stream_thinking(turn, mid, &key, text);
}
fn render_thinking(turn: &mut Value, mid: &str) {
    let mut parts: Vec<(u64, String)> = turn["_claudeThinking"][mid]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(index, text)| {
            let text = text.as_str()?.trim();
            (!text.is_empty()).then(|| (index.parse().unwrap_or(u64::MAX), text.to_owned()))
        })
        .collect();
    if parts.is_empty() {
        return;
    }
    parts.sort_by_key(|(index, _)| *index);
    let id = format!("{mid}:thinking");
    let item = item_mut(
        turn,
        &id,
        json!({"id":id,"type":"reasoning","summary":[],"nativeMessageId":mid}),
    );
    item["summary"] = parts.into_iter().map(|(_, text)| Value::from(text)).collect();
}

/// Context held after one model request: everything it read plus its output.
/// As in Claude Code's own merge, a missing or zero field in the final usage
/// falls back to the value the request reported when it started.
fn context_tokens(start: &Value, delta: &Value) -> Option<u64> {
    let field = |key: &str| {
        delta[key]
            .as_u64()
            .filter(|tokens| *tokens > 0)
            .or_else(|| start[key].as_u64())
    };
    Some(
        field("input_tokens")?
            + field("cache_creation_input_tokens").unwrap_or(0)
            + field("cache_read_input_tokens").unwrap_or(0)
            + field("output_tokens").unwrap_or(0),
    )
}
/// Usage from this turn's latest request against the known context window.
fn measure_context(d: &mut AgentDetail, tid: &str, at: DateTime<Utc>) {
    let used = d.turn_at(tid, at)["_claudeContextTokens"].as_u64();
    let window = d.claude_runtime.as_ref().and_then(|r| r.context_window);
    if let Some(usage) = used
        .zip(window)
        .and_then(|(used, window)| ContextUsage::measured(used, window, tid, at))
    {
        d.context_usage = Some(usage);
    }
}
/// modelUsage is keyed exactly as system/init names the main model. Without
/// that name, only an unambiguous single entry is used.
fn context_window(model_usage: &Value, model: Option<&str>) -> Option<u64> {
    let entries = model_usage.as_object()?;
    let window = |entry: &Value| entry["contextWindow"].as_u64().filter(|window| *window > 0);
    if let Some(entry) = model.and_then(|model| entries.get(model)) {
        return window(entry);
    }
    // Names can differ (an alias, a [1m] suffix, a provider ID). Accept only
    // an unambiguous match on the canonical model, or a single entry.
    if let Some(model) = model {
        let base = model.split('[').next().unwrap_or(model);
        let matches: Vec<_> = entries
            .iter()
            .filter(|(key, entry)| {
                entry["canonicalModel"] == base || key.split('[').next() == Some(base)
            })
            .collect();
        if matches.len() == 1 {
            return window(matches[0].1);
        }
    }
    match entries.len() {
        1 => entries.values().next().and_then(window),
        _ => None,
    }
}

/// Plan usage across reports. Each report may describe every window
/// (unifiedWindows) or only its own; a single-window report updates that window
/// and keeps the others. Top-level status fields always come from the latest.
fn merge_rate_limits(previous: Option<&Value>, info: &Value) -> Value {
    let mut merged = info.clone();
    if info["unifiedWindows"].is_object() {
        return merged;
    }
    let mut windows = previous
        .map(|previous| previous["unifiedWindows"].clone())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if let (Some(kind), Some(utilization)) = (info["rateLimitType"].as_str(), info["utilization"].as_f64()) {
        windows[kind] = json!({"utilization":utilization,"resetsAt":info["resetsAt"]});
    }
    if windows.as_object().is_some_and(|windows| !windows.is_empty()) {
        merged["unifiedWindows"] = windows;
    }
    merged
}

pub(crate) fn project_event(d: &mut AgentDetail, turn_id: Option<&str>, event: &Value) {
    project_event_at(d, turn_id, event, Utc::now());
}

// Claude's native sub-agents. A sub-agent is the Agent tool call that started
// it: that Item carries `subAgent`, kept current from the task events Claude
// reports for it. The tool calls a sub-agent makes are Items of the same Turn
// whose `parentToolUseId` names that call, so nested sub-agents form a tree.
// The installed CLI (2.1.280) puts no `agent_id` on a sub-agent's frames: a
// frame's `parent_tool_use_id` and a task event's `tool_use_id` are the
// identity. A sub-agent's own text and thinking stay out of the conversation.
//
// Other tasks Claude runs in the background (a shell started with
// run_in_background, a monitor, a workflow, an MCP task) keep a
// `backgroundTask` record on their call the same way: the same events,
// statuses and late-frame rules. A task started in the foreground keeps none
// unless it moves to the background. With CLI 2.1.280 a shell reports only
// its start, its end and a summary; there is no progress.

/// Task events Core keeps a sub-agent current with.
const TASK_EVENTS: [&str; 4] = ["task_started", "task_progress", "task_updated", "task_notification"];
/// Bounds for what a sub-agent's Item keeps of its goal and result; the
/// Agent call's own input and output stay as Claude sent them.
const SUBAGENT_PROMPT_CHARS: usize = 4_000;
const SUBAGENT_RESULT_CHARS: usize = 16_000;
const BACKGROUND_DESCRIPTION_CHARS: usize = 1_000;
/// How long a stop Claude acknowledged waits for the task's own end before
/// it can be sent again: the end came within milliseconds in the T-25 probe.
const TASK_STOP_WAIT_SECS: i64 = 15;

fn task_event(event: &Value) -> bool {
    event["type"] == "system" && event["subtype"].as_str().is_some_and(|s| TASK_EVENTS.contains(&s))
}

/// A sub-agent's frame or a task event: its Turn is the one holding the call
/// that started it (`event_turn`).
pub(crate) fn subagent_event(event: &Value) -> bool {
    event["parent_tool_use_id"].is_string() || task_event(event)
}

/// The tool call that started what an event belongs to: a sub-agent frame's
/// parent, or the call a task event names.
fn subagent_call(event: &Value) -> Option<&str> {
    if let Some(parent) = event["parent_tool_use_id"].as_str() {
        return Some(parent);
    }
    task_event(event).then(|| event["tool_use_id"].as_str()).flatten()
}

fn holds(turn: &Value, item: impl Fn(&Value) -> bool) -> bool {
    turn["items"].as_array().is_some_and(|items| items.iter().any(item))
}

/// The Turn an event belongs to. A sub-agent's frame or task event belongs to
/// the Turn holding the call that started it, wherever Claude's stream put it:
/// in the Turn running now (a background sub-agent outlives its own Turn) or
/// in none, once that Turn ended. A task event naming no call finds its
/// sub-agent by task id. Without either, the event's own Turn, if any.
pub(crate) fn event_turn(d: &AgentDetail, turn_id: Option<&str>, event: &Value) -> Option<String> {
    let found = |matches: &dyn Fn(&Value) -> bool| {
        let own = turn_id.and_then(|tid| d.turns.iter().find(|t| t["id"] == tid)).filter(|t| holds(t, matches));
        own.or_else(|| d.turns.iter().rev().find(|t| holds(t, matches)))
            .and_then(|t| t["id"].as_str().map(str::to_owned))
    };
    if let Some(call) = subagent_call(event) {
        if let Some(tid) = found(&|item| item["id"] == call) {
            return Some(tid);
        }
    } else if task_event(event) {
        if let Some(task) = event["task_id"].as_str() {
            if let Some(tid) = found(&|item| has_task(item, task)) {
                return Some(tid);
            }
        }
    }
    turn_id.map(str::to_owned)
}

/// The turn a background sub-agent's permission request belongs to when it
/// asks while no turn runs: the turn holding the call it asks about (the
/// sub-agent's frames always come first), else the newest turn, so the
/// request is still shown and can be answered.
fn subagent_request_turn(d: &AgentDetail, message: &Value) -> Option<String> {
    let call = message["toolUseId"].as_str();
    let holding = call.and_then(|call| d.turns.iter().rev().find(|t| holds(t, |item| item["id"] == call)));
    holding.or_else(|| d.turns.last()).and_then(|t| t["id"].as_str().map(str::to_owned))
}

fn agent_tool(item: &Value) -> bool {
    matches!(item["name"].as_str(), Some("Agent" | "Task"))
}

fn bounded(text: &str, chars: usize) -> (String, bool) {
    match text.char_indices().nth(chars) {
        Some((cut, _)) => (format!("{}…", &text[..cut]), true),
        None => (text.to_owned(), false),
    }
}

fn subagent_terminal(status: &Value) -> bool {
    matches!(status.as_str(), Some("completed" | "failed" | "stopped"))
}

/// A task's status as a sub-agent's: pending, running, paused, completed,
/// failed or stopped (a killed task, too).
fn task_status(status: &str) -> &str {
    match status {
        "killed" => "stopped",
        other => other,
    }
}

/// A sub-agent that can still report: not ended, not given up as unknown.
pub(crate) fn subagent_running(sub: &Value) -> bool {
    sub.is_object() && !subagent_terminal(&sub["status"]) && sub["status"] != "unknown"
}

/// A sub-agent that ended will not finish its tool calls still open.
fn settle_subagent_tools(turn: &mut Value, call: &str) {
    for item in turn["items"].as_array_mut().into_iter().flatten() {
        if item["parentToolUseId"] == call && item["status"] == "inProgress" {
            item["status"] = "unknown".into();
        }
    }
}

/// Applies one task event to the sub-agent or background task it names. A
/// task running in the foreground, other than a sub-agent, leaves its tool
/// call as it is: the call is its record.
fn project_task(turn: &mut Value, event: &Value, at: DateTime<Utc>) {
    let Some(call) = project_subagent(turn, event, at) else {
        return;
    };
    settle_subagent_tools(turn, &call);
}

/// The records a task event keeps current on the call that started it.
pub(crate) const TASK_RECORDS: [&str; 2] = ["subAgent", "backgroundTask"];

/// The Item of `turn` a task event is about: the call it names, else the
/// sub-agent or background task with its task id.
pub(crate) fn task_call<'a>(turn: &'a Value, event: &Value) -> Option<&'a Value> {
    let items = turn["items"].as_array()?;
    match (event["tool_use_id"].as_str(), event["task_id"].as_str()) {
        (Some(call), _) => items.iter().find(|item| item["id"] == call),
        (None, Some(task)) => items.iter().find(|item| has_task(item, task)),
        (None, None) => None,
    }
}

/// Whether the call started this task: its record names it, or, for a task
/// that started in the foreground, the id kept so that a later move to the
/// background (whose frames name no call) finds it.
fn has_task(item: &Value, task: &str) -> bool {
    item["foregroundTaskId"] == task || TASK_RECORDS.iter().any(|key| item[*key]["taskId"] == task)
}

/// A stop sent for this task still waits for its end: sent within the wait,
/// and not refused.
fn stop_pending(record: &Value) -> bool {
    record["stopRequestedAt"].as_str().and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| record["stopError"].is_null() && Utc::now().signed_duration_since(at).num_seconds() < TASK_STOP_WAIT_SECS)
}

/// Claims a task's stop for one request: true when no stop is waiting and
/// this one is recorded at `at`; false when one already waits. Run inside one
/// record update, so two requests claim once even at the same instant.
fn claim_stop(record: &mut Value, at: &str) -> bool {
    if stop_pending(record) {
        return false;
    }
    record["stopRequestedAt"] = at.into();
    record.as_object_mut().map(|r| r.remove("stopError"));
    true
}

/// A task's record on its call in its Turn, to change.
fn task_record_mut<'a>(d: &'a mut AgentDetail, turn: &str, item: &str, key: &str) -> Option<&'a mut Value> {
    let item = d.turns.iter_mut().find(|t| t["id"] == turn)?["items"].as_array_mut()?.iter_mut().find(|i| i["id"] == item)?;
    Some(&mut item[key]).filter(|record| record.is_object())
}

/// The Turn, call, record kind and record of the task with this id; the
/// newest, should Claude ever reuse one.
fn task_of(d: &AgentDetail, task: &str) -> Option<(String, String, &'static str, Value)> {
    d.turns.iter().rev().find_map(|turn| {
        turn["items"].as_array()?.iter().rev().find_map(|item| {
            let key = TASK_RECORDS.into_iter().find(|key| item[*key]["taskId"] == task)?;
            Some((turn["id"].as_str()?.to_owned(), item["id"].as_str()?.to_owned(), key, item[key].clone()))
        })
    })
}

/// Which record of its call a task keeps: `subAgent` for a sub-agent,
/// `backgroundTask` for any other task Claude runs in the background (a
/// shell, a monitor, a workflow, an MCP task), None for one in the
/// foreground. A shell moved to the background later gets its record then.
fn task_record(item: &Value, event: &Value) -> Option<&'static str> {
    if let Some(key) = TASK_RECORDS.iter().find(|key| item[**key].is_object()) {
        return Some(key);
    }
    match event["subtype"].as_str() {
        Some("task_started") if event["task_type"] == "local_agent" || (event["task_type"].is_null() && agent_tool(item)) => {
            Some("subAgent")
        }
        // CLI 2.1.280 sets is_backgrounded on shells and sub-agents only; the
        // other kinds it starts are background work by nature.
        Some("task_started") => (event["is_backgrounded"] == true
            || (event["is_backgrounded"].is_null() && event["task_type"].as_str().is_some_and(|t| t != "local_bash")))
            .then_some("backgroundTask"),
        Some("task_updated") if event["patch"]["is_backgrounded"] == true && !agent_tool(item) => Some("backgroundTask"),
        _ => None,
    }
}

/// The call whose sub-agent or background task the event ended, if it did.
fn project_subagent(turn: &mut Value, event: &Value, at: DateTime<Utc>) -> Option<String> {
    let task = event["task_id"].as_str();
    let call = task_call(turn, event)?["id"].as_str()?.to_owned();
    let item = turn["items"].as_array_mut()?.iter_mut().find(|item| item["id"] == call.as_str())?;
    let started = event["subtype"] == "task_started";
    if started && event["is_backgrounded"] == false && event["task_type"] != "local_agent" && !agent_tool(item) {
        if let Some(task) = task {
            item["foregroundTaskId"] = task.into();
        }
    }
    let key = task_record(item, event)?;
    if !item[key].is_object() {
        item[key] = json!({"status":"running","startedAt":at.to_rfc3339()});
        if key == "backgroundTask" {
            // Moved to the background after it started: what it runs.
            if let Some(command) = item["input"]["command"].as_str().or(item["input"]["description"].as_str()) {
                item[key]["description"] = bounded(command, BACKGROUND_DESCRIPTION_CHARS).0.into();
            }
        }
    }
    let sub = &mut item[key];
    if key == "backgroundTask" {
        for (from, to) in [("task_type", "type"), ("workflow_name", "workflowName"), ("ambient", "ambient"), ("output_file", "outputFile")] {
            if !event[from].is_null() {
                sub[to] = event[from].clone();
            }
        }
    }
    // A frame of an older run of this task is late: it says nothing now. A
    // newer run is the task resumed.
    if let Some(run) = event["run_id"].as_str() {
        match sub["runId"].as_str() {
            Some(current) if run < current => return None,
            Some(current) if run > current => {
                sub["status"] = "running".into();
                sub.as_object_mut().map(|s| s.remove("endedAt"));
            }
            _ => {}
        }
        sub["runId"] = run.into();
    }
    if let Some(task) = task {
        sub["taskId"] = task.into();
    }
    for (from, to) in [("subagent_type", "type"), ("description", "description")] {
        if let Some(value) = event[from].as_str().filter(|v| !v.is_empty()) {
            // A shell's description is its command, which its call holds whole.
            let value = if key == "backgroundTask" { bounded(value, BACKGROUND_DESCRIPTION_CHARS).0 } else { value.to_owned() };
            if from == "description" && !started {
                // A progress event's description is what it is doing now.
                sub["activity"] = value.into();
            } else {
                sub[to] = value.into();
            }
        }
    }
    let usage = &event["usage"];
    if usage.is_object() {
        sub["usage"] = json!({"tokens":usage["total_tokens"],"toolUses":usage["tool_uses"],"durationMs":usage["duration_ms"]});
    }
    match event["subtype"].as_str() {
        Some("task_started") => {
            if let Some(prompt) = event["prompt"].as_str() {
                let (prompt, cut) = bounded(prompt, SUBAGENT_PROMPT_CHARS);
                sub["prompt"] = prompt.into();
                sub["promptTruncated"] = cut.into();
            }
            for (from, to) in [("is_backgrounded", "background"), ("spawn_depth", "depth"), ("parent_task_id", "parentTaskId")] {
                if !event[from].is_null() {
                    sub[to] = event[from].clone();
                }
            }
            if !subagent_terminal(&sub["status"]) {
                sub["status"] = "running".into();
            }
        }
        Some("task_progress") => {
            if let Some(tool) = event["last_tool_name"].as_str() {
                sub["lastToolName"] = tool.into();
            }
            if let Some(summary) = event["summary"].as_str() {
                sub["progress"] = summary.into();
            }
        }
        Some("task_updated") => {
            let patch = &event["patch"];
            if let Some(status) = patch["status"].as_str().map(task_status) {
                // Terminal only from its notification or the task's own end;
                // a late "running" never reopens a finished sub-agent.
                if subagent_terminal(&status.into()) || !subagent_terminal(&sub["status"]) {
                    sub["status"] = status.into();
                }
                if subagent_terminal(&sub["status"]) && sub["endedAt"].is_null() {
                    sub["endedAt"] = at.to_rfc3339().into();
                }
            }
            if let Some(error) = patch["error"].as_str() {
                sub["error"] = error.into();
            }
            if let Some(background) = patch["is_backgrounded"].as_bool() {
                sub["background"] = background.into();
            }
        }
        Some("task_notification") => {
            if let Some(status) = event["status"].as_str().map(task_status) {
                sub["status"] = status.into();
            }
            if let Some(summary) = event["summary"].as_str() {
                let (result, cut) = bounded(summary, SUBAGENT_RESULT_CHARS);
                sub["result"] = result.into();
                sub["resultTruncated"] = cut.into();
            }
            if let Some(reason) = event["reason"].as_str() {
                sub["reason"] = reason.into();
            }
            if sub["endedAt"].is_null() {
                sub["endedAt"] = at.to_rfc3339().into();
            }
        }
        _ => {}
    }
    subagent_terminal(&sub["status"]).then_some(call)
}

/// The Agent call's own result. A sub-agent launched in the background (or
/// remotely) returns at once: the call is done, the sub-agent is not. A
/// foreground call returns when its sub-agent ended. What task events did not
/// say (an older CLI, a lost event) comes from here.
fn project_agent_result(item: &mut Value, result: &Value, failed: bool, at: DateTime<Utc>) {
    if !agent_tool(item) {
        return;
    }
    if !result.is_object() {
        // A failed call carries text only; a foreground sub-agent ended with it.
        if let Some(sub) = item.get_mut("subAgent").filter(|sub| failed && sub.is_object() && sub["background"] != true) {
            if !subagent_terminal(&sub["status"]) {
                sub["status"] = "failed".into();
                sub["endedAt"] = at.to_rfc3339().into();
            }
        }
        // The call returned, but without the result object (Claude's saved
        // history keeps none) nothing says how its sub-agent ended: one
        // launched in the background returns at once, and a foreground call
        // returns when its sub-agent ended or when it was moved to the
        // background. Unknown until something reports it; in the background
        // only when the call's own input says so.
        if !failed && !item["subAgent"].is_object() {
            item["subAgent"] = json!({"status":"unknown"});
            if item["input"]["run_in_background"] == true {
                item["subAgent"]["background"] = true.into();
            }
        }
        return;
    }
    if !item["subAgent"].is_object() {
        item["subAgent"] = json!({"status":"running"});
    }
    let input = item["input"].clone();
    let sub = &mut item["subAgent"];
    if sub["description"].is_null() {
        sub["description"] = result.get("description").or(input.get("description")).cloned().unwrap_or_default();
    }
    if sub["prompt"].is_null() {
        if let Some(prompt) = result["prompt"].as_str().or(input["prompt"].as_str()) {
            let (prompt, cut) = bounded(prompt, SUBAGENT_PROMPT_CHARS);
            sub["prompt"] = prompt.into();
            sub["promptTruncated"] = cut.into();
        }
    }
    if matches!(result["status"].as_str(), Some("async_launched" | "remote_launched")) || result["isAsync"] == true {
        sub["background"] = true.into();
        if result["status"] == "remote_launched" {
            sub["remote"] = true.into();
        }
        return;
    }
    if sub["type"].is_null() && result["agentType"].is_string() {
        sub["type"] = result["agentType"].clone();
    }
    if sub["result"].is_null() {
        let text: Vec<&str> = result["content"].as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect();
        if !text.is_empty() {
            let (text, cut) = bounded(&text.join("\n"), SUBAGENT_RESULT_CHARS);
            sub["result"] = text.into();
            sub["resultTruncated"] = cut.into();
        }
    }
    if sub["usage"].is_null() && result["totalTokens"].is_number() {
        sub["usage"] = json!({"tokens":result["totalTokens"],"toolUses":result["totalToolUseCount"],"durationMs":result["totalDurationMs"]});
    }
    if !subagent_terminal(&sub["status"]) {
        sub["status"] = if failed {
            "failed"
        } else if result["status"] == "completed" {
            "completed"
        } else {
            "unknown"
        }
        .into();
    }
    if sub["endedAt"].is_null() {
        sub["endedAt"] = at.to_rfc3339().into();
    }
}

fn running_subagents(turn: &Value) -> bool {
    holds(turn, |item| TASK_RECORDS.iter().any(|key| subagent_running(&item[*key])))
}

/// The runtime that ran Claude's sub-agents and background tasks is gone:
/// none still running can report any more. Their outcome is unknown, never
/// assumed finished.
fn settle_subagents(d: &mut AgentDetail) {
    for turn in &mut d.turns {
        let mut settled = Vec::new();
        for item in turn["items"].as_array_mut().into_iter().flatten() {
            for key in TASK_RECORDS {
                if subagent_running(&item[key]) {
                    item[key]["status"] = "unknown".into();
                    item[key]["reason"] = "runtime_ended".into();
                    settled.extend(item["id"].as_str().filter(|_| key == "subAgent").map(str::to_owned));
                }
            }
        }
        for call in settled {
            settle_subagent_tools(turn, &call);
        }
    }
}

/// The SDK events `project_event_at` changes a record for. For every other
/// one (system notices other than init, compaction, a reported mode and
/// task events, thinking-token counts, tool heartbeats, command lifecycle, a
/// subagent's partial stream, kinds it does not know) it only checks the
/// session and re-derives status, which a normalized record already has;
/// store::route never applies those. Keep this in step with the arms below.
pub(crate) fn acts_on(event: &Value) -> bool {
    match event["type"].as_str() {
        Some("stream_event") => !event["parent_tool_use_id"].is_string(),
        Some("assistant" | "user" | "result") => true,
        Some("rate_limit_event") => event["rate_limit_info"].is_object(),
        Some("system") => {
            matches!(event["subtype"].as_str(), Some("init" | "compact_boundary"))
                || task_event(event)
                || event["permissionMode"].as_str().is_some_and(|mode| NATIVE_PERMISSION_MODES.contains(&mode))
        }
        _ => false,
    }
}

/// Only SDK assistant text is conversation. Native user messages carrying
/// tool_result are execution evidence, never a second user prompt.
/// `at` is the event's journal time; nothing here reads the clock, so
/// replaying the journal (store::restore) rebuilds the same record.
pub(crate) fn project_event_at(d: &mut AgentDetail, turn_id: Option<&str>, event: &Value, at: DateTime<Utc>) {
    if let Some(session) = event["session_id"].as_str().filter(|id| !id.is_empty()) {
        if d.agent.claude_session_id.is_none() {
            d.agent.claude_session_id = Some(session.into());
        } else if d.agent.claude_session_id.as_deref() != Some(session) {
            d.agent.status = "uncertain".into();
            d.agent.error = Some("Claude 返回了其他 Session ID，已保留原始记录而未替换身份".into());
            return;
        }
    }
    // The session reports its actual mode on start and on every change,
    // including a plan exit or auto mode being unavailable. Show that, but
    // never let it replace the user's choice used to start the next session.
    if event["type"] == "system" {
        if let Some(mode) = event["permissionMode"]
            .as_str()
            .filter(|mode| NATIVE_PERMISSION_MODES.contains(mode))
        {
            d.claude_runtime.get_or_insert_with(Default::default).permission_mode = Some(mode.into());
        }
    }
    match (event["type"].as_str(), event["subtype"].as_str()) {
        (Some("system"), Some("init")) => {
            let runtime = d.claude_runtime.get_or_insert_with(Default::default);
            if let Some(version) = event["claude_code_version"].as_str() {
                runtime.version = Some(version.into());
            }
            if let Some(model) = event["model"].as_str().filter(|model| !model.is_empty()) {
                if runtime.model.as_deref() != Some(model) {
                    // Another main model may have another window; the next
                    // result reports it. Until then, usage is last known only.
                    runtime.model = Some(model.into());
                    runtime.context_window = None;
                    if let Some(usage) = &mut d.context_usage {
                        usage.stale = true;
                    }
                }
            }
        }
        (Some("system"), Some("compact_boundary")) => {
            if let Some(usage) = &mut d.context_usage {
                usage.stale = true;
            }
            // The compaction Claude Code reports, a manual /compact or its
            // own, shown as an Item of the turn it ran in, as Codex's are.
            // Its figures are Claude Code's own; the same event adds it once.
            let current = turn_id.map(str::to_owned).or_else(|| {
                d.turns.iter().rev().find(|t| t["status"] == "inProgress").and_then(|t| t["id"].as_str()).map(str::to_owned)
            });
            if let (Some(turn), Some(id)) = (current, event["uuid"].as_str()) {
                let meta = &event["compact_metadata"];
                let items = d.turn_at(&turn, at)["items"].as_array_mut().expect("turn items");
                if !items.iter().any(|item| item["id"] == id) {
                    items.push(json!({"id":id,"type":"contextCompaction","trigger":meta["trigger"],
                        "preTokens":meta["pre_tokens"],"postTokens":meta["post_tokens"]}));
                }
            }
            // A pre-compaction figure must not be re-measured as fresh later
            // in the same turn; only the next request's usage replaces it.
            for turn in &mut d.turns {
                if let Some(turn) = turn.as_object_mut() {
                    turn.remove("_claudeContextTokens");
                    turn.remove("_claudeRequestUsage");
                }
            }
        }
        (Some("rate_limit_event"), _) if event["rate_limit_info"].is_object() => {
            let runtime = d.claude_runtime.get_or_insert_with(Default::default);
            runtime.rate_limits = Some(merge_rate_limits(runtime.rate_limits.as_ref(), &event["rate_limit_info"]));
            runtime.rate_limits_at = Some(at.to_rfc3339());
        }
        _ => {}
    }
    if event["type"] == "stream_event" && event["parent_tool_use_id"].is_string() {
        return;
    }
    let resolved = event_turn(d, turn_id, event);
    let Some(tid) = resolved.as_deref() else {
        return;
    };
    // An event cannot manufacture a task the user never submitted. A turn of
    // Claude's own appears once Claude says or does something in it.
    if !d.turns.iter().any(|t| t["id"] == tid) {
        if !(native_turn(tid) && opens_native_turn(event)) {
            return;
        }
        let named = event.get("user_message_uuid").is_some() || event.get("user_message_uuids").is_some();
        open_native_turn(d, tid, at, named);
    }
    match event["type"].as_str() {
        Some("stream_event") => {
            let e = &event["event"];
            if e["type"] == "message_delta" {
                // Final usage of one main-thread request; the assistant event
                // carries only the usage known when the message started.
                let start = d.turn_at(tid, at)["_claudeRequestUsage"].clone();
                if let Some(used) = context_tokens(&start, &e["usage"]) {
                    d.turn_at(tid, at)["_claudeContextTokens"] = used.into();
                    measure_context(d, tid, at);
                }
            }
            let turn = d.turn_at(tid, at);
            match e["type"].as_str() {
                Some("message_start") => {
                    turn["_claudeMessageId"] = e["message"]["id"].clone();
                    turn["_claudeBlocks"] = json!({});
                    turn["_claudeRequestUsage"] = e["message"]["usage"].clone();
                }
                Some("content_block_start") => {
                    let block = &e["content_block"];
                    let index = e["index"].as_u64().unwrap_or(0).to_string();
                    if block["type"] == "thinking" {
                        if let Some(mid) = turn["_claudeMessageId"].as_str().map(str::to_owned) {
                            stream_thinking(turn, &mid, &index, block["thinking"].as_str().unwrap_or(""));
                        }
                    } else if block["type"] == "tool_use" {
                        if let Some(tool_id) = block["id"].as_str() {
                            turn["_claudeBlocks"][&index] = json!({"id":tool_id,"inputJson":""});
                            item_mut(
                                turn,
                                tool_id,
                                json!({"id":tool_id,"type":"claudeToolUse","name":block["name"],"input":block["input"],"status":"inProgress"}),
                            );
                        }
                    } else if block["type"] == "text" {
                        if let Some(mid) = turn["_claudeMessageId"].as_str().map(str::to_owned) {
                            stream_text(turn, &mid, &index, block["text"].as_str().unwrap_or(""));
                            conversation_time::stamp_item(turn, &mid, at.timestamp_millis(), "core");
                        }
                    }
                }
                Some("content_block_delta") => {
                    if e["delta"]["type"] == "thinking_delta" {
                        if let Some(mid) = turn["_claudeMessageId"].as_str().map(str::to_owned) {
                            let index = e["index"].as_u64().unwrap_or(0).to_string();
                            stream_thinking(turn, &mid, &index, e["delta"]["thinking"].as_str().unwrap_or(""));
                        }
                    } else if e["delta"]["type"] == "text_delta" {
                        if let Some(mid) = turn["_claudeMessageId"].as_str().map(str::to_owned) {
                            let index = e["index"].as_u64().unwrap_or(0).to_string();
                            stream_text(
                                turn,
                                &mid,
                                &index,
                                e["delta"]["text"].as_str().unwrap_or(""),
                            );
                            conversation_time::stamp_item(turn, &mid, at.timestamp_millis(), "core");
                        }
                    } else if e["delta"]["type"] == "input_json_delta" {
                        let index = e["index"].as_u64().unwrap_or(0).to_string();
                        if let Some(tool_id) = turn["_claudeBlocks"][&index]["id"]
                            .as_str()
                            .map(str::to_owned)
                        {
                            let mut input = turn["_claudeBlocks"][&index]["inputJson"]
                                .as_str()
                                .unwrap_or("")
                                .to_owned();
                            input.push_str(e["delta"]["partial_json"].as_str().unwrap_or(""));
                            turn["_claudeBlocks"][&index]["inputJson"] = input.clone().into();
                            if let Ok(value) = serde_json::from_str::<Value>(&input) {
                                let item = item_mut(
                                    turn,
                                    &tool_id,
                                    json!({"id":tool_id,"type":"claudeToolUse","status":"inProgress"}),
                                );
                                item["input"] = value;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        Some("assistant") => {
            let message = &event["message"];
            let Some(mid) = message["id"].as_str() else {
                return;
            };
            let turn = d.turn_at(tid, at);
            // A subagent's text and thinking are not the main conversation;
            // its partial stream is already skipped above. Its tool calls
            // are its own (`parentToolUseId`).
            let parent = event["parent_tool_use_id"].as_str();
            let subagent = parent.is_some();
            let mut texts = Vec::new();
            for block in message["content"].as_array().into_iter().flatten() {
                if block["type"] == "text" && !subagent {
                    if let Some(text) = block["text"].as_str() {
                        texts.push(text);
                    }
                } else if block["type"] == "thinking" && !subagent {
                    confirm_thinking(turn, mid, block["thinking"].as_str().unwrap_or(""));
                } else if block["type"] == "tool_use" {
                    if let Some(tool_id) = block["id"].as_str() {
                        let item = item_mut(
                            turn,
                            tool_id,
                            json!({"id":tool_id,"type":"claudeToolUse","status":"inProgress"}),
                        );
                        item["name"] = block["name"].clone();
                        item["input"] = block["input"].clone();
                        item["nativeMessageId"] = mid.into();
                        if let Some(parent) = parent {
                            item["parentToolUseId"] = parent.into();
                        }
                    }
                }
            }
            // Every assistant frame is one saved message of Claude's
            // (claude_history matches saved history by these uuids). Text
            // frames are recorded by confirm_text, which also skips a repeat.
            if texts.is_empty() {
                if let Some(uuid) = event["uuid"].as_str() {
                    if !turn["_claudeAssistantSeen"].is_object() {
                        turn["_claudeAssistantSeen"] = json!({});
                    }
                    turn["_claudeAssistantSeen"][uuid] = true.into();
                }
            }
            if !texts.is_empty() {
                confirm_text(turn, mid, &texts, event["uuid"].as_str());
                conversation_time::stamp_item(turn, mid, at.timestamp_millis(), "core");
                if let Some(item) = turn["items"]
                    .as_array_mut()
                    .and_then(|items| items.iter_mut().find(|i| i["id"] == mid))
                {
                    item["_yuzunoCompletedText"] = item["text"].clone();
                }
                d.agent.last_message = turn["items"]
                    .as_array()
                    .and_then(|items| items.iter().find(|i| i["id"] == mid))
                    .and_then(|i| i["text"].as_str())
                    .map(str::to_owned);
            }
        }
        Some("user") => {
            let blocks = event["message"]["content"].as_array();
            // The tool's own result object belongs to the frame's one result;
            // a frame answering several calls is one no call can claim, so
            // each goes without it.
            let single = blocks.is_some_and(|b| b.iter().filter(|b| b["type"] == "tool_result").count() == 1);
            let unclaimed = Value::Null;
            let result = if single { &event["tool_use_result"] } else { &unclaimed };
            for block in blocks.into_iter().flatten() {
                if block["type"] != "tool_result" {
                    continue;
                }
                let Some(tool_id) = block["tool_use_id"].as_str() else {
                    continue;
                };
                let turn = d.turn_at(tid, at);
                let item = item_mut(
                    turn,
                    tool_id,
                    json!({"id":tool_id,"type":"claudeToolUse","name":"Tool"}),
                );
                item["output"] = block["content"].clone();
                item["status"] = if block["is_error"] == true {
                    "failed"
                } else {
                    "completed"
                }
                .into();
                if let Some(parent) = event["parent_tool_use_id"].as_str() {
                    item["parentToolUseId"] = parent.into();
                }
                project_agent_result(item, result, block["is_error"] == true, at);
                let ended = subagent_terminal(&item["subAgent"]["status"]);
                let artifact = if block["is_error"] != true
                    && matches!(item["name"].as_str(), Some("Write" | "Edit" | "MultiEdit"))
                {
                    item["input"]["file_path"].as_str().map(str::to_owned)
                } else {
                    None
                };
                if ended {
                    settle_subagent_tools(d.turn_at(tid, at), tool_id);
                }
                if let Some(path) = artifact {
                    d.add_artifact(&path, Some(tool_id));
                }
            }
        }
        Some("system") if task_event(event) => project_task(d.turn_at(tid, at), event, at),
        Some("result") => {
            let model = d.claude_runtime.as_ref().and_then(|r| r.model.clone());
            if let Some(window) = context_window(&event["modelUsage"], model.as_deref()) {
                d.claude_runtime.get_or_insert_with(Default::default).context_window = Some(window);
                measure_context(d, tid, at);
            }
            let turn = d.turn_at(tid, at);
            // Usage is measured and thinking lives in the reasoning item.
            drop_turn_scratch(turn);
            if let Some(origin) = event["origin"]["kind"].as_str().filter(|_| native_turn(tid)) {
                turn["_yuzunoOrigin"] = origin.into();
                if origin != "human" {
                    // Claude says it started this turn itself.
                    turn.as_object_mut().map(|turn| turn.remove("_yuzunoUnmatched"));
                }
            }
            let failed = event["is_error"] == true;
            let interrupted = failed
                && (event["terminal_reason"] == "aborted_tools"
                    || event["subtype"] == "interrupted");
            turn["status"] = if interrupted {
                "interrupted"
            } else if failed {
                "failed"
            } else {
                "completed"
            }
            .into();
            if let Some(ms) = event["duration_ms"].as_i64().filter(|ms| *ms >= 0) {
                turn["_yuzunoDurationMs"] = ms.into();
            }
            conversation_time::mark_turn_completed(turn, at.timestamp_millis());
            let message = event["errors"]
                .as_array()
                .map(|errors| {
                    errors
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| event["result"].as_str().unwrap_or("Claude 执行失败").into());
            turn["error"] = if failed && !interrupted {
                json!({"message":message})
            } else {
                Value::Null
            };
            if !failed {
                if let Some(final_text) = event["result"].as_str() {
                    if let Some(item) = turn["items"].as_array_mut().and_then(|items| {
                        items.iter_mut().rev().find(|item| {
                            item["type"] == "agentMessage"
                                && item["text"]
                                    .as_str()
                                    .is_some_and(|text| text.trim() == final_text.trim())
                        })
                    }) {
                        item["phase"] = "final_answer".into();
                    }
                }
            }
            // Final result text repeats the assistant message; never append it
            // again as a fabricated message. Unresolved tool state stays unknown.
            settle_open_tools(turn);
            d.pending.retain(|p| p.params["turnId"] != tid);
            d.agent.status = if failed && !interrupted {
                "error"
            } else {
                "idle"
            }
            .into();
            // A turn of Claude's own ending well says nothing about the
            // prompt's error, which may still stand.
            if failed && !interrupted {
                d.agent.error = Some(message);
            } else if !native_turn(tid) {
                d.agent.error = None;
            }
            end_native_turns(d, tid);
        }
        _ => {}
    }
    refresh_status(d);
}

/// How long Close waits for Claude to confirm that an interrupted turn ended.
const STOP_CONFIRMATION: Duration = if cfg!(test) { Duration::from_millis(300) } else { Duration::from_secs(10) };

/// The bridge's prefix for a native turn it does not show as a prompt's:
/// Claude continuing after a background task's notice, a restart's rescue,
/// or output nothing matched to a prompt.
const NATIVE_TURN: &str = "native-";

pub(crate) fn native_turn(id: &str) -> bool {
    id.starts_with(NATIVE_TURN)
}

/// Claude's own output, which makes a turn of its own visible: a reply
/// starting, or a tool's result. Its init, status or result alone do not,
/// so an empty notice turn stays evidence only.
fn opens_native_turn(event: &Value) -> bool {
    if event["parent_tool_use_id"].is_string() {
        return false;
    }
    let content = event["message"]["content"].as_array();
    match event["type"].as_str() {
        Some("stream_event") => event["event"]["type"] == "message_start",
        Some("assistant") => content.is_some_and(|blocks| !blocks.is_empty()),
        Some("user") => content.is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result")),
        _ => false,
    }
}

/// `named`: the event names a prompt (another one's; the bridge sends a
/// turn naming this Agent's prompt as that prompt's turn).
fn open_native_turn(d: &mut AgentDetail, tid: &str, at: DateTime<Utc>, named: bool) {
    // With a prompt of this Agent in progress, output nothing names could be
    // its reply as well as Claude's own: unmatched until a result says.
    let unmatched = !named
        && d.turns.iter().any(|t| t["status"] == "inProgress" && t["id"].as_str().is_some_and(|id| !native_turn(id)));
    let turn = d.turn_at(tid, at);
    turn["_yuzunoSource"] = "native".into();
    if unmatched {
        turn["_yuzunoUnmatched"] = true.into();
    }
}

/// A Claude message as its conversation item shows it: the text, if any,
/// then its images (`input_images::history_images`).
fn user_content(text: &str, images: Vec<Value>) -> Value {
    let text = (!text.is_empty()).then(|| json!({"type":"text","text":text}));
    Value::Array(text.into_iter().chain(images).collect())
}

fn follow_up_item(turn_id: &str, client_id: &str, content: Value, at: DateTime<Utc>) -> Value {
    let mut item = json!({"id":format!("{turn_id}:{client_id}"),"type":"userMessage","clientId":client_id,
        "content":content});
    conversation_time::stamp_message(&mut item, Some(at.timestamp_millis()), "core");
    item
}

/// A follow-up sent while Claude worked: "accepted" when Claude named it in
/// `turn_id` (it read it there), "next" when its turn ended first and Claude
/// runs it as the next turn, `turn_id`, created here and still running. It
/// stays where it was sent if Claude read it there, else moves to that turn;
/// it is marked unread (`_yuzunoDelivery`) until Claude names it.
fn deliver_message(d: &mut AgentDetail, root: &std::path::Path, client_id: &str, turn_id: &str, status: &str, at: DateTime<Utc>) {
    let Some((text, images)) = d
        .message_receipts
        .iter()
        .find(|r| r.input.client_message_id == client_id)
        .map(|r| (r.input.text.clone(), r.input.images.clone()))
    else {
        return;
    };
    let agent = d.agent.id.clone();
    if native_turn(turn_id) && !d.turns.iter().any(|t| t["id"] == turn_id) {
        open_native_turn(d, turn_id, at, true);
    }
    let here = d.turn_at(turn_id, at)["items"].as_array().is_some_and(|items| items.iter().any(|i| i["clientId"] == client_id));
    if !here {
        let moved = d.turns.iter_mut().find_map(|t| {
            let items = t["items"].as_array_mut()?;
            let index = items.iter().position(|i| i["clientId"] == client_id)?;
            Some(items.remove(index))
        });
        let item = moved.unwrap_or_else(|| {
            follow_up_item(turn_id, client_id, user_content(&text, crate::input_images::history_images(root, &agent, &images)), at)
        });
        d.turn_at(turn_id, at)["items"].as_array_mut().expect("turn items").push(item);
    }
    if let Some(item) = d.turn_at(turn_id, at)["items"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["clientId"] == client_id)) {
        if status == "accepted" {
            item.as_object_mut().map(|item| item.remove("_yuzunoDelivery"));
        } else {
            item["_yuzunoDelivery"] = "queued".into();
        }
    }
    if let Some(receipt) = d.message_receipts.iter_mut().find(|r| r.input.client_message_id == client_id) {
        receipt.turn_id = Some(turn_id.into());
        if status == "accepted" {
            receipt.status = "accepted".into();
            receipt.error = None;
        }
    }
    refresh_status(d);
}

/// Messages a Claude connection never reported reading. Once it is gone, or
/// another has replaced it, nothing can confirm them, and nothing sends them
/// again: their delivery is unknown, which holds up no later message.
fn settle_unconfirmed_messages(d: &mut AgentDetail) {
    for receipt in &mut d.message_receipts {
        if matches!(receipt.status.as_str(), "sending" | "queued" | "uncertain") {
            receipt.status = "unknown".into();
            receipt.error = Some("Claude 的连接结束前没有确认处理这条消息；不会重发".into());
        }
    }
    for item in d.turns.iter_mut().flat_map(|t| t["items"].as_array_mut().into_iter().flatten()) {
        if item["_yuzunoDelivery"] == "queued" {
            item["_yuzunoDelivery"] = "unknown".into();
        }
    }
}

/// Claude runs one native turn at a time, so when one ends, a turn of its
/// own still open has ended without a result of its own (a prompt folded
/// into it took over the rest, say). Nothing reported how it ended, so its
/// outcome is unknown, never completed.
fn end_native_turns(d: &mut AgentDetail, ended: &str) {
    for turn in &mut d.turns {
        if turn["status"] != "inProgress" || !turn["id"].as_str().is_some_and(|id| native_turn(id) && id != ended) {
            continue;
        }
        mark_unknown(turn);
        turn["error"] = json!({"message":"Claude 没有为这段输出报告单独的结束结果，其结果未确认。"});
    }
}

/// YUZUNO_CLAUDE_BRIDGE and YUZUNO_NODE belong to the whole test process
/// and a bridge reads them as it starts, so a library test that sets them
/// holds this until it ends (restoring them first).
#[cfg(test)]
pub(crate) static BRIDGE_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mailbox_local_refusals_are_safe_to_defer_without_starting_a_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(
            temp.path().into(),
            temp.path().to_string_lossy().into(),
            "unused".into(),
        )
        .unwrap();
        ws.store.insert(&detail()).unwrap();
        for (agent_id, turn_id) in [("missing", "t"), ("a", "old-turn"), ("a", "t")] {
            let error = ws
                .claude_notify_mailbox_locked(agent_id, "mailbox notice", turn_id, "mail1")
                .await
                .unwrap_err();
            assert!(error.downcast_ref::<Rejected>().is_some(), "{error}");
        }
        ws.store
            .update("a", "test/closed", &json!({}), |detail| {
                detail.agent.closed_at = Some(now());
            })
            .unwrap();
        let error = ws
            .claude_notify_mailbox_locked("a", "mailbox notice", "t", "mail2")
            .await
            .unwrap_err();
        assert!(error.downcast_ref::<Rejected>().is_some());
        assert!(ws.claudes.lock().unwrap().is_empty());
        assert_eq!(ws.store.detail("a").unwrap().turns.len(), 1);
    }

    #[tokio::test]
    async fn choosing_a_model_while_working_only_saves_the_next_turn_selection() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(
            temp.path().into(),
            temp.path().to_string_lossy().into(),
            "unused".into(),
        )
        .unwrap();
        let mut d = detail();
        d.agent.claude_session_id = Some("same-session".into());
        ws.store.insert(&d).unwrap();
        let (tx, mut commands) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert(
            "a".into(),
            Connection {
                remote_instance: None,
                generation: 1,
                bridge: bridge.clone(),
                events: None,
            },
        );
        let native = tokio::spawn(async move {
            let command = commands.recv().await.unwrap();
            assert_eq!(command["op"], "models");
            let id = command["id"].as_str().unwrap().parse().unwrap();
            bridge
                .pending
                .lock()
                .await
                .remove(&id)
                .unwrap()
                .send(Ok(json!({"models":[{"model":"next-native-model"}]})))
                .unwrap();
            commands
        });
        let updated = ws
            .claude_update_model("a", "next-native-model".into())
            .await
            .unwrap();
        let mut commands = native.await.unwrap();
        assert!(matches!(
            commands.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(updated.agent.model, "next-native-model");
        assert_eq!(
            updated.agent.claude_session_id.as_deref(),
            Some("same-session")
        );
        assert_eq!(updated.turns[0]["status"], "inProgress");
        assert_eq!(updated.agent.status, "working");
    }

    /// As CLI 2.1.280 lists them: `default` and Sonnet take efforts, Haiku none.
    fn effort_catalog() -> Value {
        json!({"models":[
            {"model":"default","resolvedModel":"claude-opus-5-5[1m]","supportsEffort":true,
             "supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"model":"sonnet","resolvedModel":"claude-sonnet-5","supportsEffort":true,
             "supportedEffortLevels":["low","medium","high"]},
            {"model":"haiku","resolvedModel":"claude-haiku-4-5","supportsEffort":false,"supportedEffortLevels":[]}]})
    }

    /// A live Claude connection whose bridge answers every `models` request
    /// with `effort_catalog()` and counts the requests.
    fn catalog_bridge(ws: &Arc<Workspace>) -> Arc<std::sync::atomic::AtomicUsize> {
        let (tx, mut commands) = mpsc::channel::<Value>(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert(
            "a".into(),
            Connection { remote_instance: None, generation: 1, bridge: bridge.clone(), events: None },
        );
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = asked.clone();
        tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                assert_eq!(command["op"], "models");
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let id = command["id"].as_str().unwrap().parse().unwrap();
                let reply = bridge.pending.lock().await.remove(&id).unwrap();
                let _ = reply.send(Ok(effort_catalog()));
            }
        });
        asked
    }

    #[test]
    fn an_effort_is_valid_only_for_a_model_that_lists_it() {
        let catalog = effort_catalog();
        assert!(validate_effort(&catalog, "sonnet", "high").is_ok());
        assert!(validate_effort(&catalog, "claude-sonnet-5", "low").is_ok(), "the resolved name too");
        assert!(validate_effort(&catalog, "", "max").is_ok(), "the empty model is the SDK's default row");
        assert!(validate_effort(&catalog, "sonnet", "max").unwrap_err().to_string().contains("max"));
        assert!(validate_effort(&catalog, "haiku", "low").unwrap_err().to_string().contains("不接受"));
        assert!(validate_effort(&catalog, "unknown", "low").is_err());
        assert!(validate_effort(&json!({"models":[]}), "", "low").is_err());
    }

    #[test]
    fn a_saved_effort_starts_the_session_and_none_leaves_claude_code_its_own() {
        let mut d = detail();
        assert!(start_params(&d.agent).get("effort").is_none());
        d.agent.settings.reasoning_effort = Some("high".into());
        assert_eq!(start_params(&d.agent)["effort"], "high");
        d.agent.settings.reasoning_effort = Some("turbo".into());
        assert!(start_params(&d.agent).get("effort").is_none(), "an unknown level is never sent");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn model_and_effort_are_saved_together_and_a_refused_pair_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().into(), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        ws.store.insert(&detail()).unwrap();
        let asked = catalog_bridge(&ws);
        let saved = |ws: &Arc<Workspace>| {
            let a = ws.store.detail("a").unwrap().agent;
            (a.model, a.settings.reasoning_effort)
        };
        ws.claude_update_settings("a", "sonnet".into(), Some(Some("high".into()))).await.unwrap();
        assert_eq!(saved(&ws), ("sonnet".into(), Some("high".into())));
        // A level the model does not list is refused; nothing is half-saved.
        let error = ws.claude_update_settings("a", "sonnet".into(), Some(Some("max".into()))).await.unwrap_err();
        assert!(error.to_string().contains("max"));
        assert_eq!(saved(&ws), ("sonnet".into(), Some("high".into())));
        // Switching to a model without effort keeps no incompatible choice.
        let error = ws.claude_update_settings("a", "haiku".into(), None).await.unwrap_err();
        assert!(error.to_string().contains("不接受"));
        assert_eq!(saved(&ws), ("sonnet".into(), Some("high".into())));
        ws.claude_update_settings("a", "haiku".into(), Some(None)).await.unwrap();
        assert_eq!(saved(&ws), ("haiku".into(), None));
        // An unknown level is refused before Claude is asked anything.
        let before = asked.load(std::sync::atomic::Ordering::SeqCst);
        assert!(ws.claude_update_settings("a", "sonnet".into(), Some(Some("turbo".into()))).await.is_err());
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), before);
        // The old model-only path keeps the saved effort and checks it.
        ws.claude_update_settings("a", "sonnet".into(), Some(Some("low".into()))).await.unwrap();
        ws.claude_update_model("a", "".into()).await.unwrap();
        assert_eq!(saved(&ws), ("".into(), Some("low".into())), "the default model takes low");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_effort_claude_reports_for_a_turn_is_kept_apart_from_the_choice() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().into(), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail();
        d.agent.settings.reasoning_effort = Some("max".into());
        ws.store.insert(&d).unwrap();
        catalog_bridge(&ws);
        let applied = |ws: &Arc<Workspace>| {
            ws.store.detail("a").unwrap().claude_runtime.and_then(|r| r.effort)
        };
        ws.claude_event("a", 1, json!({"type":"effort","turnId":"t","level":"high"}));
        assert_eq!(applied(&ws), Some(json!({"level":"high","turnId":"t"})));
        assert_eq!(ws.store.detail("a").unwrap().agent.settings.reasoning_effort.as_deref(), Some("max"),
            "a downgrade Claude reports never rewrites the user's choice");
        ws.claude_event("a", 1, json!({"type":"effort","turnId":"t2","level":"unheard-of"}));
        ws.claude_event("a", 2, json!({"type":"effort","turnId":"t3","level":"low"}));
        assert_eq!(applied(&ws), Some(json!({"level":"high","turnId":"t"})), "unknown levels and old connections change nothing");
    }

    /// The client answering a permission prompt goes away while the reply is
    /// being recorded (the writer is held elsewhere): the reply recorded as
    /// sent is still sent to Claude, and resolved when Claude acknowledges.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_permission_reply_whose_request_is_dropped_still_reaches_claude() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail();
        d.agent.status = "waiting".into();
        d.pending.push(permission());
        ws.store.insert(&d).unwrap();
        let (tx, mut commands) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge: bridge.clone(), events: None });
        let app = crate::server::router_on_port(ws.clone(), temp.path().to_owned(), 4440);
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let store = ws.store.clone();
        let writer = std::thread::spawn(move || {
            let _db = store.db.write().unwrap();
            held_tx.send(()).unwrap();
            let _ = release_rx.recv();
        });
        held_rx.recv().unwrap();
        let request = axum::http::Request::post("/api/requests/action-token/respond")
            .header("host", "127.0.0.1:4440").header("x-yuzuno-client", "desktop")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(r#"{"response":{"decision":"allow"}}"#)).unwrap();
        let answered = timeout(Duration::from_millis(300), tower::ServiceExt::oneshot(app, request)).await;
        assert!(answered.is_err(), "the reply was meant to be waiting for the writer");
        release_tx.send(()).unwrap();
        writer.join().unwrap();
        let command = timeout(Duration::from_secs(10), commands.recv()).await
            .expect("the recorded reply was never sent to Claude").unwrap();
        assert_eq!(command["op"], "respond");
        assert_eq!(command["requestId"], "native-permission");
        assert_eq!(command["decision"], "allow");
        assert_eq!(ws.store.detail("a").unwrap().pending[0].params["_responseSent"], true);
        let id = command["id"].as_str().unwrap().parse().unwrap();
        bridge.pending.lock().await.remove(&id).unwrap().send(Ok(json!({}))).unwrap();
        timeout(Duration::from_secs(10), async {
            while !ws.store.detail("a").unwrap().pending.is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("Claude's acknowledgement was not recorded");
    }

    #[tokio::test]
    async fn unconfirmed_shutdown_stays_unconfirmed_on_retry_and_fences_old_events() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(
            temp.path().into(),
            temp.path().to_string_lossy().into(),
            "unused".into(),
        )
        .unwrap();
        let mut d = detail();
        d.agent.status = "idle".into();
        d.agent.claude_session_id = Some("native-preserved".into());
        d.turns[0]["status"] = "completed".into();
        ws.store.insert(&d).unwrap();
        let (tx, _commands) = mpsc::channel(1);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(Some(false));
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert(
            "a".into(),
            Connection {
                remote_instance: None,
                generation: 42,
                bridge,
                events: None,
            },
        );
        assert!(ws.claude_close_runtime("a").await.is_err());
        let retained_generation = ws.claudes.lock().unwrap()["a"].generation;
        assert_ne!(retained_generation, 42);
        ws.dispatch_claude_event("a", 42, json!({"type":"disconnected","error":"late exit"}))
            .await;
        assert!(ws.claudes.lock().unwrap().contains_key("a"));
        assert!(ws.claude_close_runtime("a").await.is_err());
        let saved = ws.store.detail("a").unwrap();
        assert_eq!(
            saved.agent.claude_session_id.as_deref(),
            Some("native-preserved")
        );
        assert!(saved.agent.closed_at.is_none());
    }

    #[test]
    fn model_validation_uses_native_catalog_and_resolved_aliases() {
        let catalog = json!({"models":[{"model":"native-alias","resolvedModel":"native-full-id"}]});
        assert!(validate_model(&catalog, "native-alias").is_ok());
        assert!(validate_model(&catalog, "native-full-id").is_ok());
        assert!(validate_model(&catalog, "invented-id").is_err());
        assert!(validate_model(&json!({"models":[]}), "native-alias").is_err());
    }

    #[test]
    fn legacy_purpose_is_never_injected_into_new_or_resumed_session() {
        let mut agent = detail().agent;
        agent.goal = "Do not inject historical purpose".into();
        let fresh = start_params(&agent);
        assert!(fresh.get("goal").is_none());
        assert!(fresh.get("systemPrompt").is_none());
        agent.claude_session_id = Some("preserved-native-session".into());
        let resumed = start_params(&agent);
        assert_eq!(resumed["sessionId"], "preserved-native-session");
        assert!(resumed.get("goal").is_none());
    }

    #[test]
    fn new_and_resumed_sessions_keep_file_checkpoints() {
        let mut agent = detail().agent;
        assert_eq!(start_params(&agent)["fileCheckpointing"], true);
        agent.claude_session_id = Some("preserved-native-session".into());
        assert_eq!(start_params(&agent)["fileCheckpointing"], true);
    }

    #[test]
    fn sessions_start_in_the_chosen_mode_and_native_reports_are_shown_separately() {
        let mut d = detail();
        assert!(start_params(&d.agent).get("permissionMode").is_none());
        d.agent.settings.permission_mode = Some("auto".into());
        assert_eq!(start_params(&d.agent)["permissionMode"], "auto");
        let observed = |d: &AgentDetail| d.claude_runtime.as_ref().and_then(|r| r.permission_mode.clone());
        // Accept edits granted for one session is shown, but never resumed.
        project_event(
            &mut d,
            None,
            &json!({"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits"}),
        );
        assert_eq!(observed(&d).as_deref(), Some("acceptEdits"));
        assert_eq!(d.agent.settings.permission_mode.as_deref(), Some("auto"));
        assert_eq!(start_params(&d.agent)["permissionMode"], "auto");
        project_event(
            &mut d,
            None,
            &json!({"type":"system","subtype":"init","permissionMode":"invented"}),
        );
        assert_eq!(observed(&d).as_deref(), Some("acceptEdits"));
        d.agent.claude_session_id = Some("original".into());
        project_event(
            &mut d,
            None,
            &json!({"type":"system","subtype":"status","session_id":"another","permissionMode":"default"}),
        );
        assert_eq!(observed(&d).as_deref(), Some("acceptEdits"));
        // Older records may hold a reported mode as the choice; never start in it.
        for legacy in ["acceptEdits", "plan", "bypassPermissions"] {
            d.agent.settings.permission_mode = Some(legacy.into());
            assert!(start_params(&d.agent).get("permissionMode").is_none());
        }
    }

    fn detail() -> AgentDetail {
        serde_json::from_value(json!({"agent": {
            "id":"a","name":"Claude","goal":"test","cwd":"/tmp","model":"haiku","color":"sage",
            "harness":"claude","threadId":null,"status":"working","createdAt":"now","updatedAt":"now",
            "unreadCount":0,"pendingCount":0,"lastMessage":null,"lastSeq":0,"reviewedSeq":0,"error":null,"connectionState":"connected"
        },"turns":[{"id":"t","status":"inProgress","items":[{"id":"input","type":"userMessage","content":[{"type":"text","text":"task"}]}]}],"pending":[],"artifacts":[]})).unwrap()
    }

    fn permission() -> PendingRequest {
        PendingRequest {
            id: "action-token".into(),
            agent_id: "a".into(),
            method: "claude/canUseTool".into(),
            params: json!({"requestId":"native-permission","turnId":"t","_runtimeGeneration":7,"_responseSent":false,"input":{"command":"pwd"}}),
            created_at: now(),
            stale: false,
        }
    }

    #[test]
    fn legacy_agent_defaults_to_codex_without_claude_session() {
        let mut value = serde_json::to_value(detail()).unwrap();
        value["agent"].as_object_mut().unwrap().remove("harness");
        value["agent"]
            .as_object_mut()
            .unwrap()
            .remove("claudeSessionId");
        value["agent"]["threadId"] = "native-codex-thread".into();
        let saved: AgentDetail = serde_json::from_value(value).unwrap();
        assert_eq!(saved.agent.harness, "codex");
        assert!(saved.agent.claude_session_id.is_none());
        assert_eq!(
            saved.agent.thread_id.as_deref(),
            Some("native-codex-thread")
        );
    }

    #[test]
    fn stream_and_full_assistant_message_share_native_anchor_without_duplicate_text() {
        let mut d = detail();
        for event in [
            json!({"type":"stream_event","session_id":"session-1","event":{"type":"message_start","message":{"id":"msg-1"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}}),
            json!({"type":"assistant","message":{"id":"msg-1","content":[{"type":"text","text":"Hello world"}]}}),
            json!({"type":"result","session_id":"session-1","is_error":false,"result":"Hello world"}),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        let items = d.turns[0]["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1]["id"], "msg-1");
        assert_eq!(items[1]["text"], "Hello world");
        assert_eq!(d.agent.claude_session_id.as_deref(), Some("session-1"));
        assert!(d.agent.thread_id.is_none());
        assert_eq!(d.turns[0]["status"], "completed");
    }

    #[test]
    fn completed_blocks_replace_partial_streamed_text_instead_of_repeating_it() {
        // As a record written mid-stream holds it after a restart: streamed
        // text is not journaled, so only its start survived.
        let mut d = detail();
        for event in [
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg-1"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check the "}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello "}}}),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        for event in [
            json!({"type":"assistant","uuid":"b-0","message":{"id":"msg-1","content":[{"type":"thinking","thinking":"Check the config."}]}}),
            json!({"type":"assistant","uuid":"b-1","message":{"id":"msg-1","content":[{"type":"text","text":"Hello world"}]}}),
            json!({"type":"assistant","uuid":"b-2","message":{"id":"msg-1","content":[{"type":"text","text":" Done."}]}}),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        let items = d.turns[0]["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1]["summary"], json!(["Check the config."]));
        assert_eq!(items[2]["text"], "Hello world Done.");
        // A completed block whose stream was lost entirely is shown once.
        let mut lost = detail();
        project_event(&mut lost, Some("t"), &json!({"type":"assistant","uuid":"b-0","message":{"id":"msg-2","content":[{"type":"text","text":"Whole"}]}}));
        assert_eq!(lost.turns[0]["items"][1]["text"], "Whole");
    }

    #[test]
    fn a_completed_block_never_lands_in_an_empty_block_by_prefix() {
        // Block 0 started (content_block_start, no text yet); block 1 has
        // streamed its start. A record written then holds both.
        let mut d = detail();
        for event in [
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg-1"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Wor"}}}),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        project_event(&mut d, Some("t"), &json!({"type":"assistant","uuid":"b-1","message":{"id":"msg-1","content":[{"type":"text","text":"World"}]}}));
        assert_eq!(d.turns[0]["items"][1]["text"], "World");
    }

    #[test]
    fn sdk_events_store_route_keeps_as_evidence_change_nothing() {
        let mut d = detail();
        d.agent.claude_session_id = Some("s".into());
        let before = serde_json::to_value(&d).unwrap();
        for event in [
            json!({"type":"system","subtype":"status","status":"requesting","session_id":"s"}),
            json!({"type":"system","subtype":"thinking_tokens","estimated_tokens":3,"session_id":"s"}),
            json!({"type":"tool_progress","tool_use_id":"tool","session_id":"s"}),
            json!({"type":"command_lifecycle","state":"queued","session_id":"s"}),
            json!({"type":"stream_event","parent_tool_use_id":"agent","session_id":"s","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sub"}}}),
            json!({"type":"auth_status","session_id":"s"}),
            json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"x","task_type":"local_agent"}],"session_id":"s"}),
        ] {
            assert!(!acts_on(&event), "{event}");
            project_event(&mut d, Some("t"), &event);
            assert_eq!(serde_json::to_value(&d).unwrap(), before, "{event}");
        }
        for event in [json!({"type":"assistant"}), json!({"type":"stream_event","event":{}}), json!({"type":"result"}),
                      json!({"type":"system","subtype":"init"}), json!({"type":"rate_limit_event","rate_limit_info":{}}),
                      json!({"type":"system","subtype":"task_started"}), json!({"type":"system","subtype":"task_progress"}),
                      json!({"type":"system","subtype":"task_updated"}), json!({"type":"system","subtype":"task_notification"})] {
            assert!(acts_on(&event), "{event}");
        }
    }

    // Claude's sub-agents, in frames as CLI 2.1.280 sends them (recorded by
    // the T-26 probe): a sub-agent's frames name its Agent call as
    // parent_tool_use_id and carry no agent_id; its task events name the call
    // as tool_use_id, except task_updated, which names only the task.
    fn agent_call(id: &str, description: &str) -> Value {
        json!({"type":"assistant","uuid":format!("u-{id}"),"parent_tool_use_id":null,"message":{"id":format!("msg-{id}"),"content":[
            {"type":"tool_use","id":id,"name":"Agent","input":{"description":description,"prompt":format!("Do: {description}"),"subagent_type":"general-purpose"}}]}})
    }
    fn sub_call(parent: &str, id: &str, tool: &str) -> Value {
        json!({"type":"assistant","uuid":format!("u-{id}"),"parent_tool_use_id":parent,"subagent_type":"general-purpose",
            "message":{"id":format!("msg-{id}"),"content":[{"type":"tool_use","id":id,"name":tool,"input":{"file_path":"x.txt"}}]}})
    }
    fn sub_text(parent: &str, id: &str, text: &str) -> Value {
        json!({"type":"assistant","uuid":format!("u-{id}"),"parent_tool_use_id":parent,"message":{"id":format!("msg-{id}"),"content":[{"type":"text","text":text}]}})
    }
    fn tool_result(parent: Option<&str>, id: &str, output: Value, result: Value) -> Value {
        json!({"type":"user","parent_tool_use_id":parent,"message":{"content":[{"type":"tool_result","tool_use_id":id,"content":output}]},"tool_use_result":result})
    }
    fn task(subtype: &str, task: &str, call: Option<&str>, extra: Value) -> Value {
        let mut event = json!({"type":"system","subtype":subtype,"task_id":task});
        if let Some(call) = call {
            event["tool_use_id"] = call.into();
        }
        event.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        event
    }
    fn started(id: &str, call: &str, background: bool, description: &str) -> Value {
        task("task_started", id, Some(call), json!({"task_type":"local_agent","subagent_type":"general-purpose","is_backgrounded":background,
            "spawn_depth":1,"description":description,"prompt":format!("Do: {description}")}))
    }
    fn finished(id: &str, call: &str, status: &str, summary: &str) -> [Value; 2] {
        [task("task_updated", id, None, json!({"patch":{"status":status,"end_time":1}})),
         task("task_notification", id, Some(call), json!({"status":status,"summary":summary,"output_file":"/o",
            "usage":{"total_tokens":27800,"tool_uses":3,"duration_ms":8079}}))]
    }
    fn turn_item<'a>(d: &'a AgentDetail, turn: &str, id: &str) -> &'a Value {
        d.turns.iter().find(|t| t["id"] == turn).and_then(|t| t["items"].as_array()?.iter().find(|i| i["id"] == id)).unwrap_or(&Value::Null)
    }
    const DONE: &str = "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"Done.\"}";

    #[test]
    fn parallel_and_background_subagents_keep_their_own_calls_status_and_result() {
        let mut d = detail();
        let foreground = |agent: &str, text: &str| json!({"status":"completed","agentId":agent,"agentType":"general-purpose",
            "content":[{"type":"text","text":text}],"prompt":"p","totalTokens":26137,"totalToolUseCount":1,"totalDurationMs":2802});
        let mut events = vec![
            agent_call("agent-a", "List and read files in ./a"),
            started("task-a", "agent-a", false, "List and read files in ./a"),
            json!({"type":"user","parent_tool_use_id":"agent-a","message":{"content":[{"type":"text","text":"Do: List and read files in ./a"}]}}),
            agent_call("agent-b", "Read b.txt"),
            started("task-b", "agent-b", false, "Read b.txt"),
            agent_call("agent-c", "Read c.txt"),
            started("task-c", "agent-c", true, "Read c.txt"),
            tool_result(None, "agent-c", json!([{"type":"text","text":"Async agent launched"}]),
                json!({"status":"async_launched","isAsync":true,"agentId":"c","description":"Read c.txt","prompt":"Do: Read c.txt","outputFile":"/o"})),
            task("task_progress", "task-a", Some("agent-a"), json!({"description":"Running List files in directory a","last_tool_name":"Bash",
                "usage":{"total_tokens":26223,"tool_uses":1,"duration_ms":3457}})),
            sub_call("agent-a", "a-ls", "Bash"),
            sub_call("agent-b", "b-read", "Read"),
            tool_result(Some("agent-b"), "b-read", json!("bravo"), json!({})),
            tool_result(Some("agent-a"), "a-ls", json!("a.txt\na2.txt"), json!({})),
            sub_call("agent-c", "c-read", "Read"),
            sub_text("agent-b", "b-text", "b.txt is bravo"),
        ];
        events.extend(finished("task-b", "agent-b", "completed", "b.txt is bravo"));
        events.push(tool_result(None, "agent-b", json!([{"type":"text","text":"b.txt is bravo"}]), foreground("b", "b.txt is bravo")));
        events.extend(finished("task-a", "agent-a", "completed", "a.txt: alpha 1"));
        events.push(tool_result(None, "agent-a", json!([{"type":"text","text":"a.txt: alpha 1"}]), foreground("a", "a.txt: alpha 1")));
        events.push(json!({"type":"assistant","uuid":"final","message":{"id":"msg-final","content":[{"type":"text","text":"Done."}]}}));
        events.push(serde_json::from_str(DONE).unwrap());
        for event in &events {
            project_event(&mut d, Some("t"), event);
        }
        for (call, parent) in [("a-ls", "agent-a"), ("b-read", "agent-b"), ("c-read", "agent-c")] {
            assert_eq!(turn_item(&d, "t", call)["parentToolUseId"], parent, "{call}");
        }
        let a = &turn_item(&d, "t", "agent-a")["subAgent"];
        assert_eq!((a["taskId"].clone(), a["status"].clone(), a["type"].clone(), a["description"].clone(), a["prompt"].clone()),
            (json!("task-a"), json!("completed"), json!("general-purpose"), json!("List and read files in ./a"), json!("Do: List and read files in ./a")));
        assert_eq!((a["background"].clone(), a["lastToolName"].clone(), a["activity"].clone(), a["result"].clone()),
            (json!(false), json!("Bash"), json!("Running List files in directory a"), json!("a.txt: alpha 1")));
        assert_eq!(a["usage"], json!({"tokens":27800,"toolUses":3,"durationMs":8079}));
        assert_eq!(turn_item(&d, "t", "agent-b")["subAgent"]["result"], "b.txt is bravo");
        // The turn ended; the background sub-agent did not, nor did its call.
        let c = &turn_item(&d, "t", "agent-c");
        assert_eq!((c["status"].clone(), c["subAgent"]["status"].clone(), c["subAgent"]["background"].clone()),
            (json!("completed"), json!("running"), json!(true)));
        assert_eq!(turn_item(&d, "t", "c-read")["status"], "inProgress");
        // A sub-agent's text is not the conversation.
        assert!(d.turns[0]["items"].as_array().unwrap().iter().all(|i| i["text"] != "b.txt is bravo"));
        assert_eq!(d.agent.last_message.as_deref(), Some("Done."));
        // It reports after its turn ended, in no turn.
        project_event(&mut d, None, &tool_result(Some("agent-c"), "c-read", json!("charlie"), json!({})));
        for event in finished("task-c", "agent-c", "completed", "c.txt is charlie") {
            project_event(&mut d, None, &event);
        }
        assert_eq!(d.turns.len(), 1, "no turn of Claude's own opened for it");
        assert_eq!((turn_item(&d, "t", "c-read")["status"].clone(), turn_item(&d, "t", "c-read")["parentToolUseId"].clone()),
            (json!("completed"), json!("agent-c")));
        let c = &turn_item(&d, "t", "agent-c")["subAgent"];
        assert_eq!((c["status"].clone(), c["result"].clone()), (json!("completed"), json!("c.txt is charlie")));
        assert!(c["endedAt"].is_string());
    }

    #[test]
    fn subagent_events_land_in_the_turn_of_their_call_wherever_the_stream_puts_them() {
        let mut d = detail();
        project_event(&mut d, Some("t"), &agent_call("agent-1", "Read c.txt"));
        project_event(&mut d, Some("t"), &started("task-1", "agent-1", true, "Read c.txt"));
        project_event(&mut d, Some("t"), &serde_json::from_str(DONE).unwrap());
        // The next prompt's turn runs when the background sub-agent reports.
        d.turns.push(json!({"id":"t2","status":"inProgress","items":[]}));
        project_event(&mut d, Some("t2"), &sub_call("agent-1", "c-read", "Read"));
        project_event(&mut d, Some("t2"), &task("task_progress", "task-1", Some("agent-1"), json!({"last_tool_name":"Read"})));
        assert_eq!(turn_item(&d, "t", "c-read")["parentToolUseId"], "agent-1");
        assert_eq!(turn_item(&d, "t", "agent-1")["subAgent"]["lastToolName"], "Read");
        assert_eq!(d.turns[1]["items"], json!([]));
        assert_eq!(event_turn(&d, Some("t2"), &sub_call("agent-1", "x", "Read")).as_deref(), Some("t"));
        // A task event naming only its task finds it too.
        assert_eq!(event_turn(&d, None, &task("task_updated", "task-1", None, json!({}))).as_deref(), Some("t"));
        // A parent Core never saw: nothing is invented, no turn is opened.
        let before = serde_json::to_value(&d).unwrap();
        project_event(&mut d, None, &sub_call("unseen", "u-1", "Read"));
        project_event(&mut d, None, &started("task-u", "unseen", false, "Unseen"));
        project_event(&mut d, Some("native-x"), &sub_call("unseen", "u-2", "Read"));
        assert_eq!(serde_json::to_value(&d).unwrap(), before);
        // Inside a running turn, its call stays visible there, still naming it.
        project_event(&mut d, Some("t2"), &sub_call("unseen", "u-3", "Read"));
        assert_eq!(turn_item(&d, "t2", "u-3")["parentToolUseId"], "unseen");
    }

    #[test]
    fn a_runtime_ending_leaves_running_subagents_unknown_never_finished() {
        let mut d = detail();
        for event in [agent_call("agent-1", "Read c.txt"), started("task-1", "agent-1", true, "Read c.txt"),
                      sub_call("agent-1", "c-read", "Read"), serde_json::from_str(DONE).unwrap()] {
            project_event(&mut d, Some("t"), &event);
        }
        d.turns.push(json!({"id":"t2","status":"inProgress","items":[]}));
        for event in [agent_call("agent-2", "Read b.txt"), started("task-2", "agent-2", false, "Read b.txt"), sub_call("agent-2", "b-read", "Read")] {
            project_event(&mut d, Some("t2"), &event);
        }
        // Stopped: its open call will not finish.
        project_event(&mut d, Some("t2"), &task("task_updated", "task-2", None, json!({"patch":{"status":"killed","end_time":1}})));
        assert_eq!(turn_item(&d, "t2", "b-read")["status"], "unknown");
        project_event(&mut d, Some("t2"), &finished("task-2", "agent-2", "stopped", "")[1]);
        assert_eq!(turn_item(&d, "t2", "agent-2")["subAgent"]["status"], "stopped");
        assert_eq!(turn_item(&d, "t2", "b-read")["status"], "unknown");
        assert_eq!(turn_item(&d, "t", "agent-1")["subAgent"]["status"], "running");
        settle_subagents(&mut d);
        let sub = &turn_item(&d, "t", "agent-1")["subAgent"];
        assert_eq!((sub["status"].clone(), sub["reason"].clone()), (json!("unknown"), json!("runtime_ended")));
        assert_eq!(turn_item(&d, "t", "c-read")["status"], "unknown");
        assert_eq!(turn_item(&d, "t2", "agent-2")["subAgent"]["status"], "stopped", "an ended one keeps how it ended");
    }

    #[test]
    fn late_task_events_never_reopen_a_sub_agent_or_rewrite_a_newer_run() {
        let mut d = detail();
        project_event(&mut d, Some("t"), &agent_call("agent-1", "Read c.txt"));
        let run = |event: Value, run: &str| {
            let mut event = event;
            event["run_id"] = run.into();
            event
        };
        project_event(&mut d, Some("t"), &run(started("task-1", "agent-1", true, "Read c.txt"), "r1"));
        project_event(&mut d, Some("t"), &run(task("task_progress", "task-1", Some("agent-1"), json!({"last_tool_name":"Read"})), "r1"));
        for event in finished("task-1", "agent-1", "completed", "charlie") {
            project_event(&mut d, Some("t"), &run(event, "r1"));
        }
        project_event(&mut d, Some("t"), &run(task("task_updated", "task-1", None, json!({"patch":{"status":"running"}})), "r1"));
        project_event(&mut d, Some("t"), &run(task("task_progress", "task-1", Some("agent-1"), json!({"last_tool_name":"Bash"})), "r0"));
        let sub = &turn_item(&d, "t", "agent-1")["subAgent"];
        assert_eq!((sub["status"].clone(), sub["lastToolName"].clone()), (json!("completed"), json!("Read")));
        // A newer run is the task resumed.
        project_event(&mut d, Some("t"), &run(task("task_updated", "task-1", None, json!({"patch":{"status":"running"}})), "r2"));
        let sub = &turn_item(&d, "t", "agent-1")["subAgent"];
        assert_eq!((sub["status"].clone(), sub["runId"].clone(), sub["endedAt"].clone()), (json!("running"), json!("r2"), Value::Null));
    }

    #[test]
    fn foreground_tasks_leave_their_call_alone_and_a_cli_without_task_events_still_shows_the_sub_agent() {
        let mut d = detail();
        project_event(&mut d, Some("t"), &json!({"type":"assistant","uuid":"u","message":{"id":"m","content":[
            {"type":"tool_use","id":"bash-1","name":"Bash","input":{"command":"sleep 9"}}]}}));
        project_event(&mut d, Some("t"), &task("task_started", "shell-1", Some("bash-1"), json!({"task_type":"local_bash","description":"sleep 9"})));
        project_event(&mut d, Some("t"), &task("task_notification", "shell-1", Some("bash-1"), json!({"status":"completed","summary":"done"})));
        assert!(turn_item(&d, "t", "bash-1")["subAgent"].is_null());
        assert!(turn_item(&d, "t", "bash-1")["backgroundTask"].is_null(), "a shell not reported in the background keeps no record");
        // Only the Agent call's own result.
        project_event(&mut d, Some("t"), &agent_call("agent-1", "Read b.txt"));
        project_event(&mut d, Some("t"), &sub_call("agent-1", "b-read", "Read"));
        project_event(&mut d, Some("t"), &tool_result(None, "agent-1", json!([{"type":"text","text":"bravo"}]),
            json!({"status":"completed","agentType":"Explore","content":[{"type":"text","text":"bravo"}],"prompt":"Do: Read b.txt",
                "totalTokens":10,"totalToolUseCount":1,"totalDurationMs":20})));
        let sub = &turn_item(&d, "t", "agent-1")["subAgent"];
        assert_eq!((sub["status"].clone(), sub["type"].clone(), sub["result"].clone(), sub["description"].clone()),
            (json!("completed"), json!("Explore"), json!("bravo"), json!("Read b.txt")));
        assert_eq!(sub["usage"], json!({"tokens":10,"toolUses":1,"durationMs":20}));
        assert_eq!(turn_item(&d, "t", "b-read")["status"], "unknown", "its call never reported and never will");
        // A failed call ends its foreground sub-agent.
        project_event(&mut d, Some("t"), &agent_call("agent-2", "Read z.txt"));
        project_event(&mut d, Some("t"), &started("task-2", "agent-2", false, "Read z.txt"));
        project_event(&mut d, Some("t"), &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent-2","content":"Error","is_error":true}]},
            "tool_use_result":"Error: failed"}));
        assert_eq!(turn_item(&d, "t", "agent-2")["subAgent"]["status"], "failed");
    }

    /// T-26 report: one message started a background Agent and a Bash call
    /// side by side; the Agent returned async_launched and no task_started
    /// came. As CLI 2.1.280 streams it: both blocks, one assistant frame per
    /// block, one user frame per result.
    #[test]
    fn a_background_agent_beside_a_bash_call_without_task_started_runs_in_the_background() {
        let mut d = detail();
        let start = |index: u64, id: &str, name: &str| json!({"type":"stream_event","event":{"type":"content_block_start","index":index,
            "content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}});
        let block = |uuid: &str, content: Value| json!({"type":"assistant","uuid":uuid,"parent_tool_use_id":null,"message":{"id":"m","content":[content]}});
        let agent = json!({"type":"tool_use","id":"agent-bg","name":"Agent","input":{"description":"Survey the notes","prompt":"Do: survey",
            "subagent_type":"general-purpose","run_in_background":true}});
        let bash = json!({"type":"tool_use","id":"bash-1","name":"Bash","input":{"command":"ls"}});
        for event in [json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m","usage":{}}}}),
                      start(0, "agent-bg", "Agent"), start(1, "bash-1", "Bash"), block("u-agent", agent), block("u-bash", bash),
                      tool_result(None, "agent-bg", json!([{"type":"text","text":"Async agent launched"}]),
                          json!({"status":"async_launched","isAsync":true,"agentId":"x","description":"Survey the notes","prompt":"Do: survey","outputFile":"/o"})),
                      tool_result(None, "bash-1", json!("a.txt"), json!({"stdout":"a.txt","stderr":"","interrupted":false}))] {
            project_event(&mut d, Some("t"), &event);
        }
        let agent = turn_item(&d, "t", "agent-bg");
        assert_eq!((agent["name"].clone(), agent["status"].clone(), agent["subAgent"]["status"].clone(), agent["subAgent"]["background"].clone()),
            (json!("Agent"), json!("completed"), json!("running"), json!(true)));
        assert_eq!(agent["subAgent"]["description"], "Survey the notes");
        assert_eq!((turn_item(&d, "t", "bash-1")["status"].clone(), turn_item(&d, "t", "bash-1")["subAgent"].clone()), (json!("completed"), Value::Null));
    }

    /// T-26 (#66): one user frame can answer several calls. Its result object
    /// is the frame's, so it belongs to none of them in particular; each
    /// Agent call there goes without it, as one filled from saved history
    /// does, and keeps what was already reported of its sub-agent.
    #[test]
    fn a_frame_answering_several_calls_gives_its_result_object_to_none_of_them() {
        let mut d = detail();
        let mut background = agent_call("agent-bg", "Survey the notes");
        background["message"]["content"][0]["input"]["run_in_background"] = true.into();
        let mut events = vec![background, agent_call("agent-fg", "Check the notes"), agent_call("agent-done", "Read a.txt"),
            agent_call("agent-err", "Read z.txt"), bash_call("bash-1", "ls", false),
            started("task-done", "agent-done", false, "Read a.txt"), started("task-err", "agent-err", false, "Read z.txt")];
        events.extend(finished("task-done", "agent-done", "completed", "alpha"));
        for event in &events {
            project_event(&mut d, Some("t"), event);
        }
        let result = |id: &str, error: bool| json!({"type":"tool_result","tool_use_id":id,"content":format!("{id} returned"),"is_error":error});
        project_event(&mut d, Some("t"), &json!({"type":"user","parent_tool_use_id":null,"message":{"content":[
            result("agent-bg", false), result("agent-fg", false), result("agent-done", false), result("agent-err", true), result("bash-1", false)]},
            "tool_use_result":{"status":"completed","agentType":"Explore","content":[{"type":"text","text":"whose report"}],"totalTokens":1}}));
        let sub = |d: &AgentDetail, id: &str| turn_item(d, "t", id)["subAgent"].clone();
        assert_eq!((sub(&d, "agent-bg"), sub(&d, "agent-fg")), (json!({"status":"unknown","background":true}), json!({"status":"unknown"})),
            "the frame's result object is no one call's: their ends are unknown");
        assert_eq!((sub(&d, "agent-done")["status"].clone(), sub(&d, "agent-done")["result"].clone()), (json!("completed"), json!("alpha")),
            "what was reported stays");
        assert_eq!(sub(&d, "agent-err")["status"], "failed", "a failed call ends its foreground sub-agent");
        assert_eq!((turn_item(&d, "t", "bash-1")["status"].clone(), sub(&d, "bash-1")), (json!("completed"), Value::Null));
        // A report of its end is what completes one.
        project_event(&mut d, Some("t"), &task("task_notification", "task-fg", Some("agent-fg"), json!({"status":"completed","summary":"fine"})));
        assert_eq!((sub(&d, "agent-fg")["status"].clone(), sub(&d, "agent-fg")["result"].clone()), (json!("completed"), json!("fine")));
    }

    /// A stop goes to Claude only for the task the user picked, only while
    /// the latest snapshot of this connection lists it as running, and once
    /// until that task ends or the wait runs out; a refused or failed stop
    /// changes nothing else, and the failure stays on the task.
    #[tokio::test]
    async fn a_task_stop_names_one_running_task_of_this_connection_and_is_sent_once() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let (tx, mut commands) = mpsc::channel(8);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown: watch::channel(false).0,
            stopped: watch::channel(None).1,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(false).1,
            pid: None,
        });
        // Answers every stop as Claude does, except one that fails.
        let (answering, (sent_tx, mut sent)) = (bridge.clone(), mpsc::unbounded_channel::<Value>());
        tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                let id: u64 = command["id"].as_str().unwrap().parse().unwrap();
                let reply = if command["taskId"] == "b-fail" { Err(anyhow!("stop refused")) } else { Ok(json!({"requested":true})) };
                answering.pending.lock().await.remove(&id).unwrap().send(reply).unwrap();
                sent_tx.send(command).unwrap();
            }
        });
        let mut d = detail();
        d.turns[0]["status"] = "completed".into();
        for (call, task, status) in [("toolu-1", "b1", "running"), ("toolu-2", "b2", "running"), ("toolu-3", "b-done", "stopped"), ("toolu-4", "b-fail", "running"), ("toolu-5", "b-race", "running")] {
            d.turns[0]["items"].as_array_mut().unwrap().push(json!({"id":call,"type":"claudeToolUse","name":"Bash","status":"completed",
                "input":{"command":"sleep 60","run_in_background":true},
                "backgroundTask":{"taskId":task,"type":"local_bash","status":status,"background":true}}));
        }
        ws.store.insert(&d).unwrap();
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge, events: None });
        let error = |r: Result<bool>| r.unwrap_err().to_string();
        let snapshot = |tasks: &[&str]| json!({"type":"system","subtype":"background_tasks_changed",
            "tasks":tasks.iter().map(|t| json!({"task_id":t,"task_type":"local_bash","description":"sleep 60"})).collect::<Vec<_>>()});
        // No snapshot from this connection yet; one from an older connection is no evidence.
        assert!(error(ws.claude_stop_task("a", "b1").await).contains("还没有报告"));
        ws.background_shells.record_claude("a", 6, &snapshot(&["b1", "b2"]));
        assert!(error(ws.claude_stop_task("a", "b1").await).contains("还没有报告"));
        ws.background_shells.record_claude("a", 7, &snapshot(&["b1", "b2", "b-fail", "b-race"]));
        assert!(error(ws.claude_stop_task("a", "nope").await).contains("没有这个后台任务"));
        assert!(error(ws.claude_stop_task("a", "b-done").await).contains("已经结束"));
        assert!(ws.claude_stop_task("a", "b1").await.unwrap());
        let command = sent.recv().await.unwrap();
        assert_eq!((command["op"].clone(), command["taskId"].clone()), (json!("stop_task"), json!("b1")));
        // Clicked again while that stop waits for the task's end: nothing is sent.
        assert!(!ws.claude_stop_task("a", "b1").await.unwrap());
        let record = |task: &str| task_of(&ws.store.detail("a").unwrap(), task).unwrap().3;
        assert!(record("b1")["stopRequestedAt"].is_string() && record("b1")["status"] == "running", "requested is not stopped");
        assert!(record("b2")["stopRequestedAt"].is_null(), "the other task is untouched");
        // Two stops at once (a double click, two clients): one is sent (R2).
        let (one, other) = tokio::join!(ws.claude_stop_task("a", "b-race"), ws.claude_stop_task("a", "b-race"));
        assert_eq!([one.unwrap(), other.unwrap()].iter().filter(|sent| **sent).count(), 1);
        assert_eq!(sent.recv().await.unwrap()["taskId"], "b-race");
        assert!(sent.try_recv().is_err(), "the other stop sent nothing");
        // Not in the latest snapshot: it may have ended already.
        ws.background_shells.record_claude("a", 7, &snapshot(&["b1", "b-fail"]));
        assert!(error(ws.claude_stop_task("a", "b2").await).contains("没有它"));
        // A stop Claude refuses stays on that task, which may be tried again.
        assert!(error(ws.claude_stop_task("a", "b-fail").await).contains("stop refused"));
        assert_eq!(sent.recv().await.unwrap()["taskId"], "b-fail");
        assert!(record("b-fail")["stopError"].as_str().unwrap().contains("stop refused"));
        assert!(error(ws.claude_stop_task("a", "b-fail").await).contains("stop refused"));
        assert_eq!(sent.recv().await.unwrap()["taskId"], "b-fail");
        assert!(sent.try_recv().is_err(), "nothing else was sent");
        // The connection ends: nothing can be stopped through it.
        ws.claudes.lock().unwrap().remove("a");
        assert!(error(ws.claude_stop_task("a", "b1").await).contains("连接已断开"));
    }

    /// Two requests at the very same instant (the same time string) claim a
    /// stop once; a refused stop may be claimed again, and a pending one
    /// expires after the wait.
    #[test]
    fn a_stop_is_claimed_once_even_by_two_requests_at_the_same_instant() {
        let at = Utc::now().to_rfc3339();
        let mut record = json!({"taskId":"b1","type":"local_bash","status":"running"});
        assert!(claim_stop(&mut record, &at));
        assert!(!claim_stop(&mut record, &at), "the second request at the same instant claims nothing");
        assert_eq!(record["stopRequestedAt"], at.as_str());
        record["stopError"] = "stop refused".into();
        assert!(claim_stop(&mut record, &at), "a refused stop may be tried again");
        assert!(record["stopError"].is_null());
        let long_ago = (Utc::now() - chrono::Duration::seconds(TASK_STOP_WAIT_SECS + 1)).to_rfc3339();
        record["stopRequestedAt"] = long_ago.into();
        assert!(claim_stop(&mut record, &at), "after the wait a stop may be sent again");
    }

    fn bash_call(id: &str, command: &str, background: bool) -> Value {
        let mut input = json!({"command":command});
        if background {
            input["run_in_background"] = true.into();
        }
        json!({"type":"assistant","uuid":format!("u-{id}"),"message":{"id":format!("m-{id}"),"content":[
            {"type":"tool_use","id":id,"name":"Bash","input":input}]}})
    }
    fn shell_started(id: &str, call: &str, command: &str, background: bool) -> Value {
        task("task_started", id, Some(call), json!({"description":command,"is_backgrounded":background,"task_type":"local_bash"}))
    }

    /// Two shells Claude runs in the background, as CLI 2.1.280 reports them
    /// (the T-25 probe's frames): each keeps a `backgroundTask` on its own
    /// Bash call. One stopped after the Turn ended stays stopped; the other
    /// finishes later, while a Turn of Claude's own runs, and still lands on
    /// its call.
    #[test]
    fn background_shells_keep_their_own_record_through_and_after_their_turn() {
        let mut d = detail();
        let launched = |call: &str, id: &str| tool_result(None, call, json!(format!("Command running in background with ID: {id}.")), json!({}));
        for event in [
            bash_call("toolu-a", "sleep 25; echo alpha-done", true), shell_started("b4b36jo7p", "toolu-a", "sleep 25; echo alpha-done", true),
            launched("toolu-a", "b4b36jo7p"),
            bash_call("toolu-b", "sleep 50; echo beta-done", true), shell_started("bownir676", "toolu-b", "sleep 50; echo beta-done", true),
            launched("toolu-b", "bownir676"), serde_json::from_str(DONE).unwrap(),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        assert_eq!(d.turns[0]["status"], "completed");
        for (call, id, command) in [("toolu-a", "b4b36jo7p", "sleep 25; echo alpha-done"), ("toolu-b", "bownir676", "sleep 50; echo beta-done")] {
            let item = turn_item(&d, "t", call);
            let task = &item["backgroundTask"];
            assert_eq!((item["status"].clone(), task["taskId"].clone(), task["type"].clone(), task["status"].clone(), task["description"].clone(), task["background"].clone()),
                (json!("completed"), json!(id), json!("local_bash"), json!("running"), json!(command), json!(true)), "{call}");
            assert!(item["subAgent"].is_null() && task["startedAt"].is_string());
        }
        // After the Turn: stopped (`killed`, then its notification).
        project_event(&mut d, None, &task("task_updated", "bownir676", None, json!({"patch":{"status":"killed","end_time":1}})));
        assert_eq!(turn_item(&d, "t", "toolu-b")["backgroundTask"]["status"], "stopped");
        project_event(&mut d, None, &task("task_notification", "bownir676", Some("toolu-b"),
            json!({"status":"stopped","output_file":"/tmp/b.output","summary":"sleep 50; echo beta-done"})));
        let beta = &turn_item(&d, "t", "toolu-b")["backgroundTask"];
        assert_eq!((beta["status"].clone(), beta["outputFile"].clone(), beta["result"].clone()),
            (json!("stopped"), json!("/tmp/b.output"), json!("sleep 50; echo beta-done")));
        assert!(beta["endedAt"].is_string());
        assert_eq!(turn_item(&d, "t", "toolu-a")["backgroundTask"]["status"], "running", "stopping one leaves the other");
        // The other ends while a Turn of Claude's own runs.
        d.turns.push(json!({"id":"native-x","status":"inProgress","items":[]}));
        project_event(&mut d, Some("native-x"), &task("task_updated", "b4b36jo7p", None, json!({"patch":{"status":"completed","end_time":2}})));
        project_event(&mut d, Some("native-x"), &task("task_notification", "b4b36jo7p", Some("toolu-a"),
            json!({"status":"completed","output_file":"/tmp/a.output","summary":"Background command \"sleep 25; echo alpha-done\" completed (exit code 0)"})));
        let alpha = &turn_item(&d, "t", "toolu-a")["backgroundTask"];
        assert_eq!((alpha["status"].clone(), alpha["result"].clone()),
            (json!("completed"), json!("Background command \"sleep 25; echo alpha-done\" completed (exit code 0)")));
        assert_eq!(d.turns[1]["items"], json!([]), "nothing of it lands in Claude's own Turn");
        // A late "running" never reopens either.
        project_event(&mut d, None, &task("task_updated", "bownir676", None, json!({"patch":{"status":"running"}})));
        assert_eq!(turn_item(&d, "t", "toolu-b")["backgroundTask"]["status"], "stopped");
    }

    /// A shell moved to the background after it started gets its record
    /// then, described by its own command; a monitor (no is_backgrounded) is
    /// background work by nature; a runtime ending leaves those still running
    /// unknown, and an ended one as it ended.
    #[test]
    fn shells_moved_to_the_background_and_other_kinds_are_background_tasks_too() {
        let mut d = detail();
        project_event(&mut d, Some("t"), &bash_call("toolu-f", "npm run dev", false));
        project_event(&mut d, Some("t"), &shell_started("fg1", "toolu-f", "npm run dev", false));
        assert!(turn_item(&d, "t", "toolu-f")["backgroundTask"].is_null());
        assert!(task_of(&d, "fg1").is_none(), "a foreground task is not one to stop from the list");
        project_event(&mut d, Some("t"), &task("task_updated", "fg1", None, json!({"patch":{"is_backgrounded":true}})));
        let moved = &turn_item(&d, "t", "toolu-f")["backgroundTask"];
        assert_eq!((moved["status"].clone(), moved["background"].clone(), moved["description"].clone(), moved["taskId"].clone()),
            (json!("running"), json!(true), json!("npm run dev"), json!("fg1")));
        project_event(&mut d, Some("t"), &json!({"type":"assistant","uuid":"u-m","message":{"id":"m-m","content":[
            {"type":"tool_use","id":"toolu-m","name":"Monitor","input":{"description":"watch the build"}}]}}));
        project_event(&mut d, Some("t"), &task("task_started", "mon1", Some("toolu-m"), json!({"description":"watch the build","task_type":"monitor","ambient":true})));
        let monitor = &turn_item(&d, "t", "toolu-m")["backgroundTask"];
        assert_eq!((monitor["type"].clone(), monitor["ambient"].clone(), monitor["status"].clone()), (json!("monitor"), json!(true), json!("running")));
        project_event(&mut d, Some("t"), &task("task_notification", "mon1", None, json!({"status":"failed","summary":"exit 1"})));
        assert_eq!(event_turn(&d, None, &task("task_progress", "fg1", None, json!({}))).as_deref(), Some("t"), "found by its task id");
        assert_eq!(turn_item(&d, "t", "toolu-m")["backgroundTask"]["status"], "failed");
        settle_subagents(&mut d);
        let moved = &turn_item(&d, "t", "toolu-f")["backgroundTask"];
        assert_eq!((moved["status"].clone(), moved["reason"].clone()), (json!("unknown"), json!("runtime_ended")));
        assert_eq!(turn_item(&d, "t", "toolu-m")["backgroundTask"]["status"], "failed");
        assert_eq!(task_of(&d, "fg1").map(|(turn, item, key, _)| (turn, item, key)), Some(("t".into(), "toolu-f".into(), "backgroundTask")));
        assert!(task_of(&d, "nope").is_none());
    }

    #[test]
    fn message_times_come_from_event_times_and_result_keeps_the_sdk_duration() {
        let at = |ms: i64| DateTime::<Utc>::from_timestamp_millis(ms).unwrap();
        let assistant = json!({"type":"assistant","message":{"id":"msg-1","content":[{"type":"text","text":"Hi there"}]}});
        let mut d = detail();
        project_event_at(&mut d, Some("t"), &json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg-1"}}}), at(1_000));
        project_event_at(&mut d, Some("t"), &json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}), at(1_000));
        assert_eq!(d.turns[0]["items"][1]["_yuzunoTime"], json!({"at":1_000,"source":"core"}));
        for (event, ms) in [
            (json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}}), 2_000),
            (assistant.clone(), 3_000),
            (json!({"type":"result","is_error":false,"result":"Hi there","duration_ms":4_200}), 5_000),
        ] {
            project_event_at(&mut d, Some("t"), &event, at(ms));
        }
        let turn = &d.turns[0];
        assert_eq!(turn["items"][1]["_yuzunoTime"]["at"], 1_000, "later blocks never move the time");
        assert_eq!(turn["_yuzunoDurationMs"], 4_200);
        assert_eq!(turn["_yuzunoCompletedAt"], 5_000);
        // Streamed text is not journaled. A record that lost it is rebuilt
        // from the journaled block, timed by that event on every replay.
        let replay = || {
            let mut d = detail();
            project_event_at(&mut d, Some("t"), &assistant, at(3_000));
            d.turns[0]["items"][1]["_yuzunoTime"].clone()
        };
        assert_eq!(replay(), json!({"at":3_000,"source":"core"}));
        assert_eq!(replay(), replay());
        let mut stopped = detail();
        project_event_at(&mut stopped, Some("t"), &json!({"type":"result","is_error":true,"subtype":"interrupted","duration_ms":900}), at(6_000));
        assert_eq!(stopped.turns[0]["status"], "interrupted");
        assert_eq!((stopped.turns[0]["_yuzunoDurationMs"].clone(), stopped.turns[0]["_yuzunoCompletedAt"].clone()), (json!(900), json!(6_000)));
    }

    #[test]
    fn each_completed_block_of_one_native_message_preserves_earlier_text() {
        let mut d = detail();
        for event in [
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg-1"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First. "}}}),
            json!({"type":"assistant","uuid":"block-1","message":{"id":"msg-1","content":[{"type":"text","text":"First. "}]}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Second."}}}),
            json!({"type":"assistant","uuid":"block-2","message":{"id":"msg-1","content":[{"type":"text","text":"Second."}]}}),
            json!({"type":"assistant","uuid":"block-2","message":{"id":"msg-1","content":[{"type":"text","text":"Second."}]}}),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        assert_eq!(d.turns[0]["items"][1]["text"], "First. Second.");
        assert_eq!(d.turns[0]["items"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn nested_partial_events_do_not_corrupt_parent_stream_state() {
        let mut d = detail();
        for event in [
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"parent-msg"}}}),
            json!({"type":"stream_event","parent_tool_use_id":"subagent-tool","event":{"type":"message_start","message":{"id":"child-msg"}}}),
            json!({"type":"stream_event","parent_tool_use_id":"subagent-tool","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Child"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Parent"}}}),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        assert_eq!(d.turns[0]["items"][1]["id"], "parent-msg");
        assert_eq!(d.turns[0]["items"][1]["text"], "Parent");
    }

    #[test]
    fn successful_completion_wins_race_with_interrupt_request() {
        let mut d = detail();
        d.turns[0]["interruptRequested"] = true.into();
        project_event(
            &mut d,
            Some("t"),
            &json!({"type":"result","is_error":false,"result":"Done"}),
        );
        assert_eq!(d.turns[0]["status"], "completed");
        assert_eq!(d.agent.status, "idle");
    }

    #[test]
    fn native_tool_results_update_tool_and_never_create_a_user_prompt() {
        let mut d = detail();
        project_event(
            &mut d,
            Some("t"),
            &json!({"type":"assistant","message":{"id":"msg-tool","content":[
            {"type":"text","text":"Writing a note."},{"type":"tool_use","id":"tool-native","name":"Write","input":{"file_path":"/tmp/note.md","content":"hi"}}]}}),
        );
        project_event(
            &mut d,
            Some("t"),
            &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-native","content":"Written","is_error":false}]}}),
        );
        let items = d.turns[0]["items"].as_array().unwrap();
        assert_eq!(
            items.iter().filter(|i| i["type"] == "userMessage").count(),
            1
        );
        let tool = items.iter().find(|i| i["id"] == "tool-native").unwrap();
        assert_eq!(tool["status"], "completed");
        assert_eq!(tool["input"]["file_path"], "/tmp/note.md");
        assert_eq!(tool["output"], "Written");
        assert_eq!(
            d.artifacts[0].source_item_id.as_deref(),
            Some("tool-native")
        );
    }

    #[test]
    fn partial_json_tool_stream_merges_with_native_full_input_and_result() {
        let mut d = detail();
        for event in [
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg-1"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"Bash","input":{}}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"pwd\"}"}}}),
            json!({"type":"assistant","message":{"id":"msg-1","content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"pwd"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"/tmp"}]}}),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        assert_eq!(d.turns[0]["items"].as_array().unwrap().len(), 2);
        assert_eq!(d.turns[0]["items"][1]["input"]["command"], "pwd");
        assert_eq!(d.turns[0]["items"][1]["status"], "completed");
    }

    #[test]
    fn interruption_requires_native_result_and_does_not_invent_tool_completion() {
        let mut d = detail();
        d.turns[0]["interruptRequested"] = true.into();
        d.turns[0]["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"tool-1","type":"claudeToolUse","status":"inProgress"}));
        d.pending.push(permission());
        assert_eq!(d.turns[0]["status"], "inProgress");
        project_event(
            &mut d,
            Some("t"),
            &json!({"type":"result","is_error":true,"terminal_reason":"aborted_tools","errors":["Interrupted"]}),
        );
        assert_eq!(d.turns[0]["status"], "interrupted");
        assert_eq!(d.turns[0]["items"][1]["status"], "unknown");
        assert_eq!(d.agent.status, "idle");
        assert!(d.pending.is_empty());
    }

    #[test]
    fn disconnected_turn_is_unknown_without_fabricating_completion() {
        let mut d = detail();
        d.turns[0]["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"tool-1","type":"claudeToolUse","status":"inProgress"}));
        mark_unknown(&mut d.turns[0]);
        assert_eq!(d.turns[0]["status"], "outcomeUnknown");
        assert_eq!(d.turns[0]["items"][1]["status"], "unknown");
        assert!(d.turns[0]["items"][1].get("output").is_none());
    }

    #[test]
    fn session_mismatch_never_rebinds_identity_or_projects_other_conversation() {
        let mut d = detail();
        d.agent.claude_session_id = Some("original".into());
        project_event(
            &mut d,
            Some("t"),
            &json!({"type":"assistant","session_id":"another","message":{"id":"message","content":[{"type":"text","text":"other account"}]}}),
        );
        assert_eq!(d.agent.claude_session_id.as_deref(), Some("original"));
        assert_eq!(d.agent.status, "uncertain");
        assert_eq!(d.turns[0]["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn malformed_permission_input_is_rejected_before_submitting_native_callback() {
        let mut p = permission();
        p.params["toolName"] = "Bash".into();
        assert!(validate_permission(
            &p,
            7,
            &json!({"decision":"allow","updatedInput":{"command":"rm -rf elsewhere"}})
        )
        .is_err());
        assert!(validate_permission(
            &p,
            7,
            &json!({"decision":"allow","updatedInput":{"command":"pwd"}})
        )
        .is_ok());
        p.params["toolName"] = "AskUserQuestion".into();
        p.params["input"] =
            json!({"questions":[{"question":"Which option?","options":[{"label":"A"}]}]});
        let mut updated = p.params["input"].clone();
        updated["answers"] = json!({"Which option?":"A"});
        assert!(
            validate_permission(&p, 7, &json!({"decision":"allow","updatedInput":updated})).is_ok()
        );
        updated["questions"][0]["question"] = "Different question".into();
        assert!(
            validate_permission(&p, 7, &json!({"decision":"allow","updatedInput":updated}))
                .is_err()
        );
        assert_eq!(p.params["_responseSent"], false);
    }

    #[test]
    fn stale_replayed_and_invalid_approvals_cannot_authorize_a_tool() {
        let mut p = permission();
        let allow = json!({"decision":"allow"});
        assert!(validate_permission(&p, 7, &allow).is_ok());
        assert!(validate_permission(&p, 8, &allow).is_err());
        p.stale = true;
        assert!(validate_permission(&p, 7, &allow).is_err());
        p.stale = false;
        p.params["_responseSent"] = true.into();
        assert!(validate_permission(&p, 7, &allow).is_err());
        p.params["_responseSent"] = false.into();
        assert!(validate_permission(&p, 7, &json!({"decision":"accept"})).is_err());
        assert!(
            validate_permission(&p, 7, &json!({"decision":"allow","updatedInput":"shell"}))
                .is_err()
        );
        assert!(validate_permission(&p, 7, &json!({"decision":"deny"})).is_ok());
    }

    fn delta_usage(input: u64, cache_read: u64, output: u64) -> Value {
        json!({"type":"stream_event","event":{"type":"message_delta","usage":{
            "input_tokens":input,"cache_creation_input_tokens":0,
            "cache_read_input_tokens":cache_read,"output_tokens":output}}})
    }

    #[test]
    fn a_compaction_claude_code_reports_is_an_item_of_its_turn_once() {
        // Turn "t" is running. As Claude Code 2.1.280 reports a manual
        // /compact: no turn on the frame.
        let mut d = detail();
        let boundary = json!({"type":"system","subtype":"compact_boundary","uuid":"boundary-1",
            "compact_metadata":{"trigger":"manual","pre_tokens":34_307,"post_tokens":3_802,"duration_ms":7_959}});
        project_event(&mut d, None, &boundary);
        project_event(&mut d, None, &boundary);
        let items: Vec<_> = d.turns[0]["items"].as_array().unwrap().iter().filter(|i| i["type"] == "contextCompaction").cloned().collect();
        assert_eq!(items, [json!({"id":"boundary-1","type":"contextCompaction","trigger":"manual","preTokens":34_307,"postTokens":3_802})]);
        // With no turn running there is nothing to attach it to.
        let mut idle = detail();
        idle.turns[0]["status"] = json!("completed");
        project_event(&mut idle, None, &boundary);
        assert!(idle.turns[0]["items"].as_array().unwrap().iter().all(|i| i["type"] != "contextCompaction"));
    }

    #[test]
    fn context_usage_uses_main_request_and_the_init_model_window() {
        let mut d = detail();
        let init = json!({"type":"system","subtype":"init","model":"opus[1m]","claude_code_version":"2.1.280"});
        project_event(&mut d, None, &init);
        project_event(&mut d, Some("t"), &delta_usage(2, 369_998, 1000));
        // The window is unknown until a native result reports it.
        assert!(d.context_usage.is_none());
        let mut subagent = delta_usage(900_000, 0, 0);
        subagent["parent_tool_use_id"] = "agent-tool".into();
        project_event(&mut d, Some("t"), &subagent);
        project_event(&mut d, Some("t"), &json!({"type":"result","is_error":false,"result":"",
            "modelUsage":{"haiku":{"contextWindow":200_000},"opus[1m]":{"contextWindow":1_000_000}}}));
        let usage = d.context_usage.clone().unwrap();
        assert_eq!((usage.used_tokens, usage.window_tokens), (371_000, 1_000_000));
        assert!(!usage.stale);
        let runtime = d.claude_runtime.clone().unwrap();
        assert_eq!(runtime.version.as_deref(), Some("2.1.280"));
        assert_eq!(runtime.context_window, Some(1_000_000));

        project_event(&mut d, None, &json!({"type":"system","subtype":"compact_boundary"}));
        assert!(d.context_usage.as_ref().unwrap().stale);
        project_event(&mut d, Some("t"), &delta_usage(5, 49_995, 0));
        assert_eq!(d.context_usage.as_ref().unwrap().used_percent, 5.0);
        // A different main model keeps the old figure only as last known.
        project_event(&mut d, None, &json!({"type":"system","subtype":"init","model":"sonnet"}));
        assert!(d.context_usage.as_ref().unwrap().stale);
        assert_eq!(d.claude_runtime.as_ref().unwrap().context_window, None);
        assert_eq!(context_window(&json!({"a":{"contextWindow":1},"b":{"contextWindow":2}}), None), None);
    }

    #[test]
    fn each_start_replaces_the_reported_provenance_and_an_older_bridge_shows_none() {
        // A record from before provenance still reads.
        let mut runtime: crate::model::ClaudeRuntime =
            serde_json::from_value(json!({"version":"2.1.280"})).unwrap();
        assert!(runtime.provenance.is_none());
        let first = json!({"version":"2.1.280","provenance":{
            "cli":{"path":"/a/lib/claude.exe","found":"/a/bin/claude","source":"path","version":"2.1.280","versionSource":"init"},
            "sdk":{"version":"0.3.296","builtInCli":"2.1.296"},"compatibility":"verified"}});
        started_runtime(&mut runtime, &first);
        assert_eq!(runtime.provenance, Some(first["provenance"].clone()));
        assert_eq!(serde_json::to_value(&runtime).unwrap()["provenance"], first["provenance"]);
        // Reconnected after PATH changed: the new executable, not the last one.
        let moved = json!({"provenance":{
            "cli":{"path":"/b/claude","found":"/b/claude","source":"path","version":"2.1.290","versionSource":"--version"},
            "sdk":{"version":"0.3.296","builtInCli":"2.1.296"},"compatibility":"unverified"}});
        started_runtime(&mut runtime, &moved);
        assert_eq!(runtime.provenance, Some(moved["provenance"].clone()));
        // An older bridge reports none, or something else: nothing is shown.
        for older in [json!({"version":"2.1.280"}), json!({"provenance":"2.1.280"})] {
            started_runtime(&mut runtime, &older);
            assert!(runtime.provenance.is_none());
        }
    }

    #[test]
    fn missing_final_usage_falls_back_to_the_request_start_and_compaction_stays_stale() {
        let mut d = detail();
        d.claude_runtime = Some(crate::model::ClaudeRuntime {
            model: Some("m".into()), context_window: Some(200_000), ..Default::default()
        });
        project_event(&mut d, Some("t"), &json!({"type":"stream_event","event":{"type":"message_start",
            "message":{"id":"msg-1","usage":{"input_tokens":4,"cache_read_input_tokens":179_196,"output_tokens":1}}}}));
        // Zero or null input/cache in the final usage means "not provided".
        project_event(&mut d, Some("t"), &json!({"type":"stream_event","event":{"type":"message_delta",
            "usage":{"input_tokens":0,"cache_read_input_tokens":null,"output_tokens":800}}}));
        assert_eq!(d.context_usage.as_ref().unwrap().used_tokens, 180_000);
        // Compaction later in the same turn: the result must not re-measure the
        // pre-compaction request as fresh.
        project_event(&mut d, None, &json!({"type":"system","subtype":"compact_boundary"}));
        project_event(&mut d, Some("t"), &json!({"type":"result","is_error":false,"result":"",
            "modelUsage":{"m":{"contextWindow":200_000}}}));
        let usage = d.context_usage.as_ref().unwrap();
        assert!(usage.stale);
        assert_eq!(usage.used_tokens, 180_000);
    }

    #[test]
    fn single_window_limit_reports_merge_and_complete_reports_replace() {
        let five = json!({"status":"rejected","rateLimitType":"five_hour","utilization":0.9,"resetsAt":100});
        let merged = merge_rate_limits(None, &five);
        let seven = json!({"status":"allowed","rateLimitType":"seven_day","utilization":0.3,"resetsAt":900});
        let merged = merge_rate_limits(Some(&merged), &seven);
        // The nearly exhausted 5-hour window is not erased by a 7-day report.
        assert_eq!(merged["unifiedWindows"]["five_hour"]["utilization"], 0.9);
        assert_eq!(merged["unifiedWindows"]["seven_day"]["utilization"], 0.3);
        assert_eq!(merged["status"], "allowed");
        let complete = json!({"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.1}}});
        assert_eq!(merge_rate_limits(Some(&merged), &complete), complete);
    }

    #[test]
    fn context_window_tolerates_differently_named_models_only_when_unambiguous() {
        let usage = json!({"haiku-x":{"canonicalModel":"haiku","contextWindow":200_000},
            "claude-opus-5-5[1m]":{"canonicalModel":"claude-opus-5-5","contextWindow":1_000_000}});
        assert_eq!(context_window(&usage, Some("claude-opus-5-5[1m]")), Some(1_000_000));
        assert_eq!(context_window(&usage, Some("claude-opus-5-5")), Some(1_000_000));
        assert_eq!(context_window(&usage, Some("opus")), None);
        assert_eq!(context_window(&json!({"x":{"contextWindow":5}}), Some("other")), Some(5));
    }

    #[test]
    fn thinking_seen_only_complete_keeps_arrival_order() {
        let mut d = detail();
        for n in 0..12 {
            project_event(&mut d, Some("t"), &json!({"type":"assistant","message":{"id":"msg",
                "content":[{"type":"thinking","thinking":format!("part {n}")}]}}));
        }
        let summary = d.turns[0]["items"][1]["summary"].as_array().unwrap().clone();
        let expected: Vec<Value> = (0..12).map(|n| format!("part {n}").into()).collect();
        assert_eq!(summary, expected);
    }

    #[test]
    fn subagent_text_and_thinking_stay_out_of_the_main_conversation() {
        let mut d = detail();
        project_event(&mut d, Some("t"), &json!({"type":"assistant","parent_tool_use_id":"agent-tool",
            "message":{"id":"child","content":[{"type":"thinking","thinking":"Child plan."},{"type":"text","text":"Child report."}]}}));
        assert_eq!(d.turns[0]["items"].as_array().unwrap().len(), 1);
        assert!(d.agent.last_message.is_none());
    }

    #[test]
    fn thinking_streams_into_one_reasoning_item_without_duplicates() {
        let mut d = detail();
        for event in [
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg-1"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check the "}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"config."}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}}),
            json!({"type":"assistant","uuid":"block-1","message":{"id":"msg-1","content":[{"type":"thinking","thinking":"Check the config.","signature":"sig"}]}}),
            json!({"type":"assistant","uuid":"block-2","message":{"id":"msg-1","content":[{"type":"text","text":"Done."}]}}),
        ] {
            project_event(&mut d, Some("t"), &event);
        }
        let items = d.turns[0]["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1]["type"], "reasoning");
        assert_eq!(items[1]["summary"], json!(["Check the config."]));
        assert_eq!(items[2]["text"], "Done.");
        // The raw thinking copy is dropped once the turn ends.
        project_event(&mut d, Some("t"), &json!({"type":"result","is_error":false,"result":"Done."}));
        assert!(d.turns[0].get("_claudeThinking").is_none());
        assert_eq!(d.turns[0]["items"][1]["summary"], json!(["Check the config."]));

        // Omitted thinking (empty text) creates no blank reasoning card.
        let mut omitted = detail();
        project_event(&mut omitted, Some("t"), &json!({"type":"assistant","message":{"id":"msg-2",
            "content":[{"type":"thinking","thinking":"","signature":"sig"}]}}));
        assert_eq!(omitted.turns[0]["items"].as_array().unwrap().len(), 1);
        // A completed block that was never streamed is still shown once.
        project_event(&mut omitted, Some("t"), &json!({"type":"assistant","message":{"id":"msg-2",
            "content":[{"type":"thinking","thinking":"Summarized.","signature":"sig"}]}}));
        project_event(&mut omitted, Some("t"), &json!({"type":"assistant","message":{"id":"msg-2",
            "content":[{"type":"thinking","thinking":"Summarized.","signature":"sig"}]}}));
        assert_eq!(omitted.turns[0]["items"][1]["summary"], json!(["Summarized."]));
    }

    #[test]
    fn latest_rate_limit_is_kept_even_between_turns() {
        let mut d = detail();
        let info = json!({"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.04}}});
        project_event(&mut d, None, &json!({"type":"rate_limit_event","rate_limit_info":info}));
        let runtime = d.claude_runtime.unwrap();
        assert_eq!(runtime.rate_limits, Some(info));
        assert!(runtime.rate_limits_at.is_some());
    }

    #[test]
    fn session_approval_requires_the_bridge_offer_and_reasons_only_deny() {
        let mut p = permission();
        p.params["toolName"] = "Bash".into();
        let session = json!({"decision":"allow","scope":"session"});
        assert!(validate_permission(&p, 7, &session).is_err());
        // Raw suggestions alone are not an offer; only the bridge's list is.
        p.params["suggestions"] = json!([{"type":"addRules","behavior":"allow","destination":"localSettings",
            "rules":[{"toolName":"Bash","ruleContent":"pwd"}]}]);
        assert!(validate_permission(&p, 7, &session).is_err());
        p.params["sessionPermissions"] = json!([]);
        assert!(validate_permission(&p, 7, &session).is_err());
        p.params["sessionPermissions"] = json!([{"type":"addRules","behavior":"allow","destination":"session",
            "rules":[{"toolName":"Bash","ruleContent":"pwd"}]}]);
        assert!(validate_permission(&p, 7, &session).is_ok());
        assert!(validate_permission(&p, 7, &json!({"decision":"deny","scope":"session"})).is_err());
        assert!(validate_permission(&p, 7, &json!({"decision":"allow","scope":"forever"})).is_err());
        assert!(validate_permission(&p, 7, &json!({"decision":"deny","message":"Use ls"})).is_ok());
        assert!(validate_permission(&p, 7, &json!({"decision":"allow","message":"Use ls"})).is_err());
        let long = "x".repeat(2001);
        assert!(validate_permission(&p, 7, &json!({"decision":"deny","message":long})).is_err());
    }

    #[tokio::test]
    async fn diagnostics_drain_long_output_without_newlines_before_stderr_closes() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let sink = Arc::new(std::sync::Mutex::new(String::new()));
        let drain = tokio::spawn(drain_diagnostics(reader, sink.clone()));
        let writer = tokio::spawn(async move {
            let block = [b'x'; 4096];
            for _ in 0..256 {
                writer.write_all(&block).await.unwrap();
            }
            writer.write_all(b"diagnostic tail").await.unwrap();
            writer // Keep stderr open: a newline or EOF must not be required.
        }).await.unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                if sink.lock().unwrap().ends_with("diagnostic tail") { break; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("diagnostic tail should be readable before EOF");
        assert!(sink.lock().unwrap().len() <= DIAGNOSTIC_BYTES);
        drop(writer);
        drain.await.unwrap();
    }

    #[test]
    fn diagnostics_explain_failures_without_changing_their_certainty() {
        let tail = Some("Not logged in".to_owned());
        let unknown = with_diagnostics(OutcomeUnknown("timed out".into()).into(), tail.clone());
        assert!(unknown.downcast_ref::<OutcomeUnknown>().is_some());
        assert!(unknown.to_string().ends_with("Not logged in"));
        let rejected = with_diagnostics(Rejected("exited".into()).into(), tail);
        assert!(rejected.downcast_ref::<Rejected>().is_some());
        let plain = with_diagnostics(anyhow!("plain"), None);
        assert_eq!(plain.to_string(), "plain");
        let mut text = "前".repeat(10);
        keep_tail(&mut text, 7);
        assert_eq!(text, "前前");
    }

    #[test]
    fn a_turn_of_claudes_own_shows_once_it_acts_and_ends_with_the_next_result() {
        let at = |ms: i64| DateTime::<Utc>::from_timestamp_millis(ms).unwrap();
        let mut d = detail();
        // Init, status, a subagent's frame or an empty result is no turn.
        for event in [
            json!({"type":"system","subtype":"init","model":"opus"}),
            json!({"type":"system","subtype":"status","status":"requesting"}),
            json!({"type":"assistant","parent_tool_use_id":"task","message":{"id":"sub","content":[{"type":"text","text":"sub"}]}}),
            json!({"type":"result","is_error":false,"num_turns":0,"result":"","origin":{"kind":"task-notification"}}),
        ] {
            project_event_at(&mut d, Some("native-empty"), &event, at(1_000));
        }
        assert_eq!(d.turns.len(), 1);
        let call = json!({"type":"assistant","message":{"id":"m",
            "content":[{"type":"tool_use","id":"tool","name":"Bash","input":{"command":"cat out"}}]}});
        project_event_at(&mut d, Some("native-n"), &call, at(2_000));
        assert_eq!((d.turns[1]["id"].clone(), d.turns[1]["_yuzunoSource"].clone()), (json!("native-n"), json!("native")));
        assert_eq!((d.turns[1]["status"].clone(), d.turns[1]["_yuzunoStartedAt"].clone()), (json!("inProgress"), json!(2_000)));
        assert!(d.turns[1]["items"].as_array().unwrap().iter().all(|item| item["type"] != "userMessage"));
        // The prompt "t" is in progress and nothing named this output.
        assert_eq!(d.turns[1]["_yuzunoUnmatched"], true);
        project_event_at(&mut d, Some("native-n"), &json!({"type":"result","is_error":false,"result":"",
            "origin":{"kind":"task-notification"}}), at(2_500));
        assert_eq!((d.turns[1]["status"].clone(), d.turns[1]["_yuzunoOrigin"].clone()), (json!("completed"), json!("task-notification")));
        assert!(d.turns[1].get("_yuzunoUnmatched").is_none(), "Claude said it started the turn");
        assert_eq!(d.agent.status, "working", "the prompt is still in progress");
        // Left open, as when a prompt folded into it took over the rest: the
        // prompt's result ends it too, but nothing reported how, so its
        // outcome is unknown, not completed, and nothing confirmed whose it was.
        project_event_at(&mut d, Some("native-m"), &json!({"type":"assistant","message":{"id":"m2",
            "content":[{"type":"tool_use","id":"tool-2","name":"Bash","input":{}}]}}), at(2_800));
        project_event_at(&mut d, Some("t"), &json!({"type":"result","is_error":false,"result":"done","duration_ms":10}), at(3_000));
        assert_eq!((d.turns[0]["status"].clone(), d.turns[2]["status"].clone()), (json!("completed"), json!("outcomeUnknown")));
        assert_eq!(d.turns[2]["items"][0]["status"], "unknown");
        assert!(d.turns[2]["error"]["message"].as_str().unwrap().contains("未确认"));
        assert_eq!(d.turns[2]["_yuzunoUnmatched"], true);
        assert_eq!(d.agent.status, "idle");
        // A failed prompt's error is not cleared by a turn of Claude's own ending well.
        project_event_at(&mut d, Some("t"), &json!({"type":"result","is_error":true,"errors":["boom"]}), at(3_100));
        project_event_at(&mut d, Some("native-q"), &call, at(3_200));
        project_event_at(&mut d, Some("native-q"), &json!({"type":"result","is_error":false,"result":"",
            "origin":{"kind":"task-notification"}}), at(3_300));
        assert_eq!(d.agent.error.as_deref(), Some("boom"));
        // With no prompt in progress, output of a turn of Claude's own is just that.
        project_event_at(&mut d, Some("native-o"), &call, at(4_000));
        assert!(d.turns.last().unwrap().get("_yuzunoUnmatched").is_none());
    }

    /// Claude never names the prompt's result (a producer reporting neither a
    /// prompt uuid nor an origin), so the prompt's turn stays running and an
    /// interrupt acknowledgement proves nothing. The user's Close interrupts,
    /// waits, then ends the connection: only once the process has exited is
    /// the turn kept as unknown, never completed, with the session kept; late
    /// events of that connection change nothing. An exit not confirmed keeps
    /// the turn and a connection to try closing again.
    #[tokio::test]
    async fn closing_ends_a_turn_claude_never_confirmed_only_after_its_exit() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let fake = |exited: bool| {
            let (tx, commands) = mpsc::channel(8);
            let (shutdown, shutdown_rx) = watch::channel(false);
            let (stopped_tx, stopped) = watch::channel(None);
            let bridge = Arc::new(Bridge {
                tx,
                pending: Arc::new(Mutex::new(HashMap::new())),
                next: AtomicU64::new(1),
                shutdown,
                stopped,
                diagnostics: Default::default(),
                stderr_closed: watch::channel(true).1, pid: None,
            });
            // Acknowledges the interrupt (no result follows), then exits, or not, when closed.
            let answering = bridge.clone();
            tokio::spawn(async move {
                let (mut commands, mut shutdown_rx) = (commands, shutdown_rx);
                let command: Value = commands.recv().await.unwrap();
                assert_eq!(command["op"], "interrupt");
                let id: u64 = command["id"].as_str().unwrap().parse().unwrap();
                answering.pending.lock().await.remove(&id).unwrap()
                    .send(Ok(json!({"interrupted":true,"receipt":{"still_queued":[]}}))).unwrap();
                shutdown_rx.changed().await.unwrap();
                stopped_tx.send(Some(exited)).unwrap();
                tokio::time::sleep(Duration::from_secs(30)).await;
            });
            bridge
        };
        for (agent, exited) in [("a", true), ("b", false)] {
            let mut d = detail();
            d.agent.id = agent.into();
            d.agent.claude_session_id = Some(format!("session-{agent}"));
            let mut request = permission();
            request.agent_id = agent.into();
            d.pending.push(request);
            ws.store.insert(&d).unwrap();
            ws.claudes.lock().unwrap().insert(agent.into(), Connection { remote_instance: None, generation: 7, bridge: fake(exited), events: None });
        }
        ws.claude_close_runtime("a").await.unwrap();
        let d = ws.store.detail("a").unwrap();
        assert_eq!((d.turns[0]["status"].clone(), d.turns[0]["interruptRequested"].clone()), (json!("outcomeUnknown"), json!(true)));
        assert!(d.turns[0]["error"]["message"].as_str().unwrap().contains("不会重发"));
        assert!(d.pending.iter().all(|p| p.stale));
        assert_eq!((d.agent.connection_state.as_str(), d.agent.claude_session_id.as_deref()), ("disconnected", Some("session-a")));
        assert!(!ws.claudes.lock().unwrap().contains_key("a"));
        ws.dispatch_claude_event("a", 7, json!({"type":"event","turnId":"t","event":{"type":"result","is_error":false,"result":"late"}})).await;
        assert_eq!(ws.store.detail("a").unwrap().turns[0]["status"], "outcomeUnknown", "a late result of that connection is fenced out");

        assert!(ws.claude_close_runtime("b").await.is_err(), "the exit was not confirmed");
        assert_eq!(ws.store.detail("b").unwrap().turns[0]["status"], "inProgress");
        assert!(ws.claudes.lock().unwrap().contains_key("b"), "a connection is kept to try again");
    }

    /// Closing after its turns ended still ends Claude's process: a sub-agent
    /// running in the background can no longer report, so it is unknown.
    #[tokio::test]
    async fn closing_leaves_a_background_subagent_unknown_never_finished() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail();
        for event in [agent_call("agent-1", "Read c.txt"), started("task-1", "agent-1", true, "Read c.txt"),
                      sub_call("agent-1", "c-read", "Read"), serde_json::from_str(DONE).unwrap()] {
            project_event(&mut d, Some("t"), &event);
        }
        assert_eq!(turn_item(&d, "t", "agent-1")["subAgent"]["status"], "running");
        ws.store.insert(&d).unwrap();
        let (tx, _commands) = mpsc::channel::<Value>(8);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        tokio::spawn(async move {
            shutdown_rx.changed().await.unwrap();
            stopped_tx.send(Some(true)).unwrap();
        });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge, events: None });
        ws.claude_close_runtime("a").await.unwrap();
        let d = ws.store.detail("a").unwrap();
        let sub = &turn_item(&d, "t", "agent-1")["subAgent"];
        assert_eq!((sub["status"].clone(), sub["reason"].clone()), (json!("unknown"), json!("runtime_ended")));
        assert_eq!(turn_item(&d, "t", "c-read")["status"], "unknown");
        assert_eq!(d.turns[0]["status"], "completed", "the ended turn is unchanged");
    }

    /// A background sub-agent asks for permission after its turn ended
    /// (review 54aeb60f): the request is shown with the turn of the call it
    /// asks about, no turn is opened for it, and once it is answered nothing
    /// is left running to hold the next prompt back.
    #[tokio::test]
    async fn a_background_subagents_permission_opens_no_turn_and_leaves_nothing_running() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail();
        d.agent.claude_session_id = Some("s".into());
        for event in [agent_call("agent-1", "Run the build"), started("task-1", "agent-1", true, "Run the build"),
                      serde_json::from_str(DONE).unwrap()] {
            project_event(&mut d, Some("t"), &event);
        }
        ws.store.insert(&d).unwrap();
        let (tx, _commands) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge, events: None });
        // As the bridge sends them: the sub-agent's call as a session frame,
        // then its request with no turn.
        ws.dispatch_claude_event("a", 7, json!({"type":"event","turnId":null,"event":sub_call("agent-1", "make", "Bash")})).await;
        ws.dispatch_claude_event("a", 7, json!({"type":"permission","turnId":null,"requestId":"ask-make","toolName":"Bash",
            "input":{"command":"make"},"toolUseId":"make","sessionPermissions":[]})).await;
        let d = ws.store.detail("a").unwrap();
        assert_eq!(d.turns.len(), 1, "no turn is opened for it");
        assert_eq!((d.pending.len(), d.pending[0].params["turnId"].clone()), (1, json!("t")));
        assert_eq!(turn_item(&d, "t", "make")["parentToolUseId"], "agent-1");
        assert_eq!(d.agent.status, "waiting");
        // Answered (here: withdrawn by Claude), nothing runs any more.
        ws.dispatch_claude_event("a", 7, json!({"type":"permission_cancelled","requestId":"ask-make"})).await;
        let d = ws.store.detail("a").unwrap();
        assert!(d.pending.is_empty() && d.turns.iter().all(|t| t["status"] != "inProgress"));
        assert_eq!(d.agent.status, "idle");
        // A request naming no call Core has is still shown, with the newest turn.
        ws.dispatch_claude_event("a", 7, json!({"type":"permission","turnId":null,"requestId":"ask-unknown","toolName":"Bash",
            "input":{},"toolUseId":"unseen","sessionPermissions":[]})).await;
        let d = ws.store.detail("a").unwrap();
        assert_eq!((d.turns.len(), d.pending[0].params["turnId"].clone()), (1, json!("t")));
    }

    /// T-37 on these events: a result goes only to a Turn Core can vouch
    /// for. Output Claude has not said is its own is no such Turn, and after
    /// a close a call for the old Turn never reaches the next one.
    #[tokio::test]
    async fn results_go_only_to_confirmed_turns_through_native_output_and_close() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail();
        d.agent.claude_session_id = Some("s".into());
        ws.store.insert(&d).unwrap();
        let (tx, mut commands) = mpsc::channel::<Value>(8);
        let (shutdown, mut shutdown_rx) = watch::channel(false);
        let (stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        // Acknowledges the close's interrupt, then exits.
        let answering = bridge.clone();
        tokio::spawn(async move {
            let command = commands.recv().await.unwrap();
            assert_eq!(command["op"], "interrupt");
            let id: u64 = command["id"].as_str().unwrap().parse().unwrap();
            answering.pending.lock().await.remove(&id).unwrap()
                .send(Ok(json!({"interrupted":true,"receipt":{"still_queued":[]}}))).unwrap();
            shutdown_rx.changed().await.unwrap();
            stopped_tx.send(Some(true)).unwrap();
        });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge, events: None });
        let event = |turn: Option<&str>, native: &str, event: Value| {
            json!({"type":"event","turnId":turn,"nativeTurnId":native,"event":event})
        };
        let spec = json!({"root":"r","elements":{"r":{"type":"Result","props":{"title":"Shown","summary":"Once."}}}});
        let publish = |request: &str, turn: &str| {
            let (ws, input) = (ws.clone(), json!({"requestId":request,"expectedTurnId":turn,"spec":spec}));
            async move { ws.result_publish("a", input).await }
        };
        let refused = |answer: anyhow::Result<Result<Value, Value>>| answer.unwrap_err().to_string();
        let accepted = publish("prompt", "t").await.unwrap().unwrap();
        assert_eq!(accepted["turnId"], "t");
        // Output nothing names while the prompt runs: the prompt's reply or
        // Claude's own. Neither Turn is vouched for until a result says.
        ws.dispatch_claude_event("a", 7, event(Some("native-x"), "native-x", json!({"type":"assistant","session_id":"s",
            "message":{"id":"msg-x","content":[{"type":"text","text":"A background task finished."}]}}))).await;
        assert_eq!(ws.store.detail("a").unwrap().turns[1]["_yuzunoUnmatched"], true);
        for turn in ["t", "native-x"] {
            assert!(refused(publish(&format!("during-{turn}"), turn).await).starts_with("no_active_turn"), "{turn}");
        }
        let notified = json!({"kind":"task-notification"});
        for message in [
            event(Some("t"), "native-b", json!({"type":"result","subtype":"success","session_id":"s",
                "is_error":false,"duration_ms":10,"result":"Done."})),
            event(Some("native-x"), "native-x", json!({"type":"result","subtype":"success","session_id":"s",
                "is_error":false,"duration_ms":10,"result":"","origin":notified})),
            event(Some("native-y"), "native-y", json!({"type":"assistant","session_id":"s",
                "message":{"id":"msg-y","content":[{"type":"text","text":"Continuing on my own."}]}})),
        ] {
            ws.dispatch_claude_event("a", 7, message).await;
        }
        // Claude's own Turn with no prompt in progress is vouched for.
        let own = publish("own", "native-y").await.unwrap().unwrap();
        assert_eq!(own["turnId"], "native-y");
        assert!(refused(publish("late", "t").await).starts_with("stale_turn"));
        ws.claude_close_runtime("a").await.unwrap();
        assert_eq!(ws.store.detail("a").unwrap().turns[2]["status"], "outcomeUnknown");
        assert!(refused(publish("closed", "native-y").await).starts_with("no_active_turn"));
        // The next Turn, after a reconnect: the old one's calls stay its own.
        ws.store.update("a", "test/next", &json!({}), |d| {
            d.turns.push(json!({"id":"t2","status":"inProgress","items":[]}));
            d.agent.status = "working".into();
            d.agent.connection_state = "connected".into();
        }).unwrap();
        assert!(refused(publish("after", "native-y").await).starts_with("stale_turn"));
        assert_eq!(publish("own", "native-y").await.unwrap().unwrap(), own, "a retry replays its first answer");
        let d = ws.store.detail("a").unwrap();
        let mut detail = ws.store.client_detail("a").unwrap();
        crate::results::attach(&ws.store.db.read().unwrap(), &mut detail).unwrap();
        let shown: Vec<_> = detail.turns.iter().map(|t| t["_yuzunoResults"].as_array().map_or(0, Vec::len)).collect();
        assert_eq!((d.turns.len(), shown), (4, vec![1, 0, 1, 0]));
    }

    /// The bridge's messages for CLI 2.1.280's recorded order (its T-20
    /// tests), through the store as live: an empty notice turn adds nothing,
    /// the prompt's reply stays in its turn, and Claude's later continuation
    /// is a turn of its own that holds sends while it runs, may ask for
    /// approval, and is kept for a reload.
    #[tokio::test]
    async fn claudes_continuation_is_recorded_as_its_own_turn() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail();
        d.agent.claude_session_id = Some("s".into());
        ws.store.insert(&d).unwrap();
        let (tx, _commands) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge, events: None });
        let event = |turn: Option<&str>, native: &str, event: Value| {
            json!({"type":"event","turnId":turn,"nativeTurnId":native,"event":event})
        };
        let notified = json!({"kind":"task-notification"});
        for message in [
            event(None, "native-a", json!({"type":"system","subtype":"init","session_id":"s","model":"opus"})),
            event(Some("native-a"), "native-a", json!({"type":"result","subtype":"success","session_id":"s",
                "is_error":false,"num_turns":0,"duration_ms":50,"result":"","origin":notified})),
            event(Some("t"), "native-b", json!({"type":"assistant","session_id":"s",
                "message":{"id":"msg-b","content":[{"type":"text","text":"Started in the background."}]}})),
            event(Some("t"), "native-b", json!({"type":"result","subtype":"success","session_id":"s",
                "is_error":false,"duration_ms":4178,"result":"Started in the background."})),
            event(None, "native-c", json!({"type":"system","subtype":"init","session_id":"s","model":"opus"})),
            event(Some("native-c"), "native-c", json!({"type":"stream_event","session_id":"s",
                "event":{"type":"message_start","message":{"id":"msg-c"}}})),
            event(Some("native-c"), "native-c", json!({"type":"assistant","session_id":"s","message":{"id":"msg-c",
                "content":[{"type":"tool_use","id":"tool-c","name":"Bash","input":{"command":"cat out"}}]}})),
        ] {
            ws.dispatch_claude_event("a", 7, message).await;
        }
        let d = ws.store.detail("a").unwrap();
        assert_eq!(d.turns.len(), 2, "the empty notice turn adds none");
        assert_eq!((d.turns[0]["status"].clone(), d.turns[0]["_yuzunoDurationMs"].clone()), (json!("completed"), json!(4178)));
        assert_eq!(d.turns[0]["items"][1]["text"], "Started in the background.");
        assert_eq!((d.turns[1]["id"].clone(), d.turns[1]["_yuzunoSource"].clone()), (json!("native-c"), json!("native")));
        assert_eq!((d.turns[1]["status"].clone(), d.agent.status.clone()), (json!("inProgress"), "working".to_owned()));
        assert!(d.turns[1].get("_yuzunoUnmatched").is_none(), "no prompt was in progress");
        let refused = ws.claude_send_locked("a", "next".into()).await.unwrap_err();
        assert!(refused.to_string().contains("正在执行"), "{refused}");
        ws.dispatch_claude_event("a", 7, json!({"type":"permission","turnId":"native-c","nativeTurnId":"native-c",
            "requestId":"ask-c","toolName":"Bash","input":{"command":"cat out"},"toolUseId":"tool-c","sessionPermissions":[]})).await;
        let d = ws.store.detail("a").unwrap();
        assert_eq!((d.pending.len(), d.pending[0].params["nativeTurnId"].clone()), (1, json!("native-c")));
        assert_eq!(d.agent.status, "waiting");
        for message in [
            json!({"type":"permission_cancelled","requestId":"ask-c"}),
            event(Some("native-c"), "native-c", json!({"type":"result","subtype":"success","session_id":"s",
                "is_error":false,"duration_ms":1497,"result":"It finished.","origin":notified})),
        ] {
            ws.dispatch_claude_event("a", 7, message).await;
        }
        let check = |d: &AgentDetail| {
            assert_eq!(d.turns.len(), 2);
            assert_eq!((d.turns[1]["status"].clone(), d.turns[1]["_yuzunoOrigin"].clone()), (json!("completed"), json!("task-notification")));
            assert_eq!((d.turns[1]["_yuzunoDurationMs"].clone(), d.turns[1]["items"][0]["status"].clone()), (json!(1497), json!("unknown")));
            assert_eq!((d.agent.status.as_str(), d.pending.len()), ("idle", 0));
        };
        check(&ws.store.detail("a").unwrap());
        // Written, not only held: the turn first seen in a streamed event too.
        let stored: Vec<(String, Value)> = {
            let db = ws.store.db.read().unwrap();
            let mut rows = db.prepare("SELECT turn_id, data FROM agent_turns WHERE agent_id='a' ORDER BY ord").unwrap();
            rows.query_map([], |r| Ok((r.get(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap())))
                .unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(stored.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["t", "native-c"]);
        assert_eq!((stored[1].1["status"].clone(), stored[1].1["_yuzunoSource"].clone()), (json!("completed"), json!("native")));
        // A permission for a turn already over, or never Claude's own, adds nothing.
        for turn in ["native-c", "unknown-turn"] {
            ws.dispatch_claude_event("a", 7, json!({"type":"permission","turnId":turn,"requestId":"late",
                "toolName":"Bash","input":{},"sessionPermissions":[]})).await;
        }
        assert!(ws.store.detail("a").unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn pasted_content_uses_durable_claude_idle_and_working_receipts() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut original = detail();
        original.agent.status = "idle".into(); original.turns[0]["status"] = "completed".into();
        original.agent.claude_session_id = Some("claude-paste-session".into());
        ws.store.insert(&original).unwrap();
        let (tx, mut commands) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge { tx, pending: Arc::new(Mutex::new(HashMap::new())), next: AtomicU64::new(1),
            shutdown, stopped, diagnostics: Default::default(), stderr_closed: watch::channel(true).1, pid: None });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge: bridge.clone(), events: None });
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let calls = seen.clone(); let replying = bridge.clone();
        tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                let command: Value = command;
                calls.lock().unwrap().push(command.clone());
                let id: u64 = command["id"].as_str().unwrap().parse().unwrap();
                replying.pending.lock().await.remove(&id).unwrap().send(Ok(json!({"queued":command["op"] == "append"}))).unwrap();
            }
        });
        let body = "中文👩‍💻e\u{301}\r\n".repeat(12);
        let text = format!("before {body} between {body} after\r\n");
        let len = body.encode_utf16().count();
        let blocks = json!([{"id":"one","start":7,"end":7+len},{"id":"two","start":16+len,"end":16+len*2}]);
        let input = |client: &str, expected: Option<&str>| serde_json::from_value::<crate::model::MessageInput>(json!({
            "clientMessageId":client,"text":text,"textBlocks":blocks,"expectedTurnId":expected})).unwrap();
        let start = ws.send_message("a", input("start",None)).await.unwrap();
        assert_eq!(start.status,"accepted"); assert!(start.binding.is_some());
        let turn = start.turn_id.unwrap();
        let follow = ws.send_message("a", input("follow",Some(&turn))).await.unwrap();
        assert_eq!(follow.status,"queued");
        ws.dispatch_claude_event("a",7,json!({"type":"message_delivery","clientMessageId":"follow","status":"accepted","turnId":turn})).await;
        let detail = ws.store.detail("a").unwrap();
        let messages: Vec<_> = detail.turns.iter().flat_map(|t| t["items"].as_array().unwrap()).filter(|i| i["clientId"] == "start" || i["clientId"] == "follow").collect();
        assert_eq!(messages.len(),2);
        for message in messages { assert_eq!(crate::message_content::text(message),text); assert_eq!(message[crate::message_content::BLOCKS],blocks); }
        assert_eq!(ws.send_message("a", input("start",None)).await.unwrap().status,"accepted");
        let requests = seen.lock().unwrap();
        let submitted: Vec<_> = requests.iter().filter(|c| c["op"] == "send" || c["op"] == "append").collect();
        assert_eq!(submitted.len(),2);
        for command in submitted { assert_eq!(command["text"],text); assert!(command.get("textBlocks").is_none()); }
    }

    /// Follow-ups while Claude works (T-21), through send_message's receipts
    /// and the bridge's delivery events: queued is not read, Claude naming it
    /// Forms share the existing start/append paths while preserving receipts.
    #[tokio::test]
    async fn claude_forms_use_real_start_and_queued_receipts_without_confirming_unknown_starts() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut original = detail(); original.agent.claude_session_id = Some("claude-form-session".into());
        ws.store.insert(&original).unwrap();
        let (tx, mut commands) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge { tx, pending: Arc::new(Mutex::new(HashMap::new())), next: AtomicU64::new(1),
            shutdown, stopped, diagnostics: Default::default(), stderr_closed: watch::channel(true).1, pid: None });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge: bridge.clone(), events: None });
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let calls = seen.clone(); let replying = bridge.clone();
        tokio::spawn(async move {
            let mut starts = 0;
            while let Some(command) = commands.recv().await {
                let command: Value = command;
                calls.lock().unwrap().push(command.clone());
                let op = command["op"].as_str().unwrap();
                assert!(["set_model", "set_effort", "send", "append"].contains(&op));
                if op == "send" { starts += 1; }
                let reply = if op == "send" && starts == 2 {
                    Err(OutcomeUnknown("start acknowledgement lost".into()).into())
                } else { Ok(json!({"queued":op == "append"})) };
                let id: u64 = command["id"].as_str().unwrap().parse().unwrap();
                replying.pending.lock().await.remove(&id).unwrap().send(reply).unwrap();
            }
        });
        let spec = json!({"root":"r","elements":{
            "r":{"type":"Result","props":{"title":"Setup","summary":"Answer once"},"children":["f"]},
            "f":{"type":"Clarification","props":{"id":"setup","title":"Setup","fields":[{"id":"directory","type":"text","label":"Directory","required":true}]}}
        }});
        let publish = |turn: &str, request: &str| json!({"requestId":request,"expectedTurnId":turn,"spec":spec});
        let make_input = |client: &str, result: &str, text: String| serde_json::from_value::<crate::model::MessageInput>(json!({
            "clientMessageId":client,"text":text,"clarification":{"resultId":result,"formId":"setup","answers":{"directory":"test"}}
        })).unwrap();
        let first = ws.result_publish("a", publish("t", "first")).await.unwrap().unwrap();
        let result = first["resultId"].as_str().unwrap();
        let answer = json!({"resultId":result,"formId":"setup","answers":{"directory":"test"}});
        let text = ws.results.check_answers(&spec, &answer).await.unwrap();
        ws.store.update("a", "test/idle", &json!({}), |d| { d.turns[0]["status"] = "completed".into(); d.agent.status = "idle".into(); }).unwrap();
        let input = make_input("form-start", result, text);
        let started = ws.send_message("a", input.clone()).await.unwrap();
        assert_eq!(started.status, "accepted");
        assert_eq!(ws.send_message("a", input).await.unwrap().status, "accepted");
        let turn = started.turn_id.unwrap();
        assert!(ws.store.detail("a").unwrap().turns.iter().find(|t| t["id"] == turn).unwrap()["items"].as_array().unwrap().iter().any(|i| i["clientId"] == "form-start"));
        let second = ws.result_publish("a", publish(&turn, "second")).await.unwrap().unwrap();
        let result = second["resultId"].as_str().unwrap();
        let answer = json!({"resultId":result,"formId":"setup","answers":{"directory":"test"}});
        let text = ws.results.check_answers(&spec, &answer).await.unwrap();
        assert_eq!(ws.send_message("a", make_input("form-append", result, text)).await.unwrap().status, "queued");
        ws.dispatch_claude_event("a", 7, json!({"type":"message_delivery","clientMessageId":"form-append","status":"accepted","turnId":turn})).await;
        let third = ws.result_publish("a", publish(&turn, "third")).await.unwrap().unwrap();
        let result = third["resultId"].as_str().unwrap();
        let answer = json!({"resultId":result,"formId":"setup","answers":{"directory":"test"}});
        let text = ws.results.check_answers(&spec, &answer).await.unwrap();
        ws.store.update("a", "test/idle", &json!({}), |d| { for turn in &mut d.turns { turn["status"] = "completed".into(); } d.agent.status = "idle".into(); }).unwrap();
        let input = make_input("form-lost", result, text);
        assert_eq!(ws.send_message("a", input.clone()).await.unwrap().status, "uncertain");
        assert_eq!(ws.send_message("a", input).await.unwrap().status, "uncertain");
        let detail = ws.store.detail("a").unwrap();
        assert!(detail.turns.iter().flat_map(|t| t["items"].as_array().unwrap()).all(|i| i["clientId"] != "form-lost"));
        assert_eq!(seen.lock().unwrap().iter().filter(|c| c["op"] == "send").count(), 2);
        // Each start configures effort, then model, then sends (T-23).
        let ops: Vec<String> = seen.lock().unwrap().iter().map(|c| c["op"].as_str().unwrap().to_owned()).collect();
        assert_eq!(&ops[..3], ["set_effort", "set_model", "send"]);
        assert_eq!(seen.lock().unwrap().iter().filter(|c| c["op"] == "append").count(), 1);
        assert!(detail.pending.is_empty());
        assert_eq!(detail.agent.reviewed_seq, 0);
    }

    /// Confirms a follow-up in the turn that read it, starts a queued follow-up
    /// as its own turn, and never resends a repeat or a lost connection's input.
    #[tokio::test]
    async fn claude_follow_ups_are_confirmed_by_claude_and_never_resent() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        ws.store.insert(&detail()).unwrap();
        let (tx, mut commands) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge: bridge.clone(), events: None });
        // The bridge queues c1 and c3, and refuses c2 (its turn had ended there).
        let answering = bridge.clone();
        let sent = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = sent.clone();
        tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                let command: Value = command;
                assert_eq!(command["op"], "append");
                seen.lock().unwrap().push(command["clientMessageId"].as_str().unwrap().to_owned());
                let id: u64 = command["id"].as_str().unwrap().parse().unwrap();
                let reply = if command["clientMessageId"] == "c2" {
                    Err(Rejected("The turn to add to has already ended".into()).into())
                } else {
                    Ok(json!({"queued":true,"uuid":"u","turnId":"t"}))
                };
                answering.pending.lock().await.remove(&id).unwrap().send(reply).unwrap();
            }
        });
        let input = |id: &str, text: &str| -> crate::model::MessageInput {
            serde_json::from_value(json!({"clientMessageId":id,"text":text,"expectedTurnId":"t"})).unwrap()
        };
        let delivered = |client: &str, status: &str, turn: &str| {
            json!({"type":"message_delivery","clientMessageId":client,"status":status,"turnId":turn})
        };

        let queued = ws.send_message("a", input("c1", "also check the tests")).await.unwrap();
        assert_eq!((queued.status.as_str(), queued.turn_id.as_deref()), ("queued", Some("t")), "queued is not read");
        // Shown where it was sent, marked unread.
        let shown = |d: &AgentDetail, turn: &str, client: &str| d.turns.iter().find(|t| t["id"] == turn)
            .and_then(|t| t["items"].as_array().unwrap().iter().find(|i| i["clientId"] == client).cloned());
        assert_eq!(shown(&ws.store.detail("a").unwrap(), "t", "c1").unwrap()["_yuzunoDelivery"], "queued");
        // T-65: a follow-up waiting at Claude holds up none after it.
        let second = ws.send_message("a", input("c9", "another")).await.unwrap();
        assert_eq!(second.status, "queued");
        assert_eq!(shown(&ws.store.detail("a").unwrap(), "t", "c9").unwrap()["_yuzunoDelivery"], "queued");
        for client in ["c1", "c9"] {
            ws.dispatch_claude_event("a", 7, delivered(client, "accepted", "t")).await;
        }
        let d = ws.store.detail("a").unwrap();
        let item = shown(&d, "t", "c1").unwrap();
        assert_eq!((item["type"].clone(), item["content"][0]["text"].clone()), (json!("userMessage"), json!("also check the tests")));
        assert!(item.get("_yuzunoDelivery").is_none(), "read");
        assert!(shown(&d, "t", "c9").unwrap().get("_yuzunoDelivery").is_none());
        assert_eq!(d.message_receipts.iter().map(|r| r.status.as_str()).collect::<Vec<_>>(), ["accepted", "accepted"]);
        // A repeated click returns the same receipt and sends nothing again.
        assert_eq!(ws.send_message("a", input("c1", "also check the tests")).await.unwrap().status, "accepted");
        ws.dispatch_claude_event("a", 7, delivered("c1", "accepted", "t")).await;
        assert_eq!(ws.store.detail("a").unwrap().turns[0]["items"].as_array().unwrap().len(), 3, "no second copy");

        let refused = ws.send_message("a", input("c2", "too late")).await.unwrap();
        assert_eq!(refused.status, "rejected", "the draft is kept, not sent");

        let next = ws.send_message("a", input("c3", "then do this")).await.unwrap();
        assert_eq!(next.status, "queued");
        // Its turn ended first: Claude runs it as its own turn.
        ws.dispatch_claude_event("a", 7, json!({"type":"event","turnId":"t","event":{"type":"result","is_error":false,"result":"done"}})).await;
        ws.dispatch_claude_event("a", 7, json!({"type":"message_delivery","clientMessageId":"c3","status":"next",
            "turnId":"follow-3","previousTurnId":"t"})).await;
        let d = ws.store.detail("a").unwrap();
        let follow = d.turns.iter().find(|t| t["id"] == "follow-3").unwrap();
        assert_eq!((follow["status"].clone(), follow["items"][0]["clientId"].clone()), (json!("inProgress"), json!("c3")));
        assert_eq!(follow["items"][0]["_yuzunoDelivery"], "queued", "moved, still unread");
        assert!(shown(&d, "t", "c3").is_none(), "no longer shown in the turn that ended");
        let receipt = d.message_receipts.iter().find(|r| r.input.client_message_id == "c3").unwrap();
        assert_eq!((receipt.status.as_str(), receipt.turn_id.as_deref()), ("queued", Some("follow-3")));
        assert_eq!(d.agent.status, "working");
        // The connection ends before Claude names it: unknown, never resent.
        ws.dispatch_claude_event("a", 7, json!({"type":"exit"})).await;
        let d = ws.store.detail("a").unwrap();
        let receipt = d.message_receipts.iter().find(|r| r.input.client_message_id == "c3").unwrap();
        assert_eq!(receipt.status, "unknown");
        assert_eq!(d.turns.iter().find(|t| t["id"] == "follow-3").unwrap()["status"], "outcomeUnknown");
        assert_eq!(shown(&d, "follow-3", "c3").unwrap()["_yuzunoDelivery"], "unknown");
        // Unknown holds up nothing: this one is refused only because its turn
        // ended, before anything is sent (T-65).
        let after = ws.send_message("a", input("c4", "after")).await.unwrap_err();
        assert!(after.is::<crate::collaboration_credentials::MessageNotSubmitted>() && after.to_string().contains("原 Turn 已结束"), "{after}");
        assert_eq!(*sent.lock().unwrap(), ["c1", "c9", "c2", "c3"], "c1's repeat never reached Claude");
        // Refused before anything is sent: the client hears nothing was
        // submitted, keeps its draft and shows no delivery to confirm.
        // This id was submitted with other content: a plain refusal, so the
        // client keeps the id it may have sent with (T-65 R2).
        let changed = ws.send_message("a", input("c1", "something else")).await.unwrap_err();
        assert!(!changed.is::<crate::collaboration_credentials::MessageNotSubmitted>() && changed.to_string().contains("不同的内容"), "{changed}");
        ws.store.update("a", "test/uncertain", &json!({}), |d| d.message_receipts[0].status = "uncertain".into()).unwrap();
        let held = ws.send_message("a", input("c5", "held back")).await.unwrap_err();
        assert!(held.is::<crate::collaboration_credentials::MessageNotSubmitted>() && held.to_string().contains("尚未确认"), "{held}");
        assert_eq!(sent.lock().unwrap().len(), 4);
        // T-65 R2: a retry of a submitted message gets its receipt even after
        // the Agent was closed, never "not submitted", which would drop the id.
        ws.store.update("a", "test/closed", &json!({}), |d| d.agent.closed_at = Some("closed".into())).unwrap();
        let receipts = ws.store.detail("a").unwrap().message_receipts.len();
        let retried = ws.send_message("a", input("c9", "another")).await.unwrap();
        assert_eq!((retried.input.client_message_id.as_str(), retried.status.as_str()), ("c9", "accepted"));
        assert_eq!((sent.lock().unwrap().len(), ws.store.detail("a").unwrap().message_receipts.len()), (4, receipts),
            "nothing is sent or recorded again");
        let fresh = ws.send_message("a", input("c6", "new while closed")).await.unwrap_err();
        assert!(fresh.is::<crate::collaboration_credentials::MessageNotSubmitted>(), "{fresh}");
    }

    /// T-21 R1: Claude acknowledged a follow-up and the connection check
    /// passed, but the connection ended before the follow-up was shown. Shown
    /// after that, it is unknown like its receipt, never "waiting for Claude to confirm".
    #[tokio::test]
    async fn a_follow_up_shown_after_its_connection_ended_is_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail();
        d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"c","text":"also this",
            "expectedTurnId":"t"},"status":"sending","turnId":null,"error":null})).unwrap());
        ws.store.insert(&d).unwrap();
        let (tx, _commands) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge, events: None });
        ws.dispatch_claude_event("a", 7, json!({"type":"exit"})).await;
        ws.show_follow_up("a", "t", "c", user_content("also this", vec![])).await.unwrap();
        let d = ws.store.detail("a").unwrap();
        assert_eq!(d.message_receipts[0].status, "unknown");
        let items = d.turns[0]["items"].as_array().unwrap();
        let shown: Vec<_> = items.iter().filter(|i| i["clientId"] == "c").map(|i| i["_yuzunoDelivery"].clone()).collect();
        assert_eq!(shown, [json!("unknown")]);
    }

    /// T-31: a Claude message's images reach the bridge as references to the
    /// files Core checked, never as image data, and show in the conversation
    /// as the same managed references as a Codex message, for a new turn and
    /// for a follow-up with no text.
    #[tokio::test]
    async fn claude_images_go_to_the_bridge_as_checked_files_and_show_in_the_conversation() {
        use sha2::{Digest, Sha256};
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().join("data"), temp.path().to_string_lossy().into(), "unused".into()).unwrap();
        let mut d = detail();
        d.turns[0]["status"] = "completed".into();
        d.agent.status = "idle".into();
        d.agent.claude_session_id = Some("s".into());
        ws.store.insert(&d).unwrap();
        let save = |agent: &str, red: u8| {
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::RgbImage::from_pixel(8, 8, image::Rgb([red, 0, 0])).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            let bytes = bytes.into_inner();
            let id = format!("{:x}.png", Sha256::digest(&bytes));
            let path = crate::input_images::image_path(&ws.data_dir, agent, &id).unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            (id, path, bytes)
        };
        let (red, red_path, red_bytes) = save("a", 200);
        let (blue, blue_path, _) = save("a", 20);
        let (other, _, _) = save("b", 90);
        let (tx, mut commands) = mpsc::channel::<Value>(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let (_stopped_tx, stopped) = watch::channel(None);
        let bridge = Arc::new(Bridge {
            tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next: AtomicU64::new(1),
            shutdown,
            stopped,
            diagnostics: Default::default(),
            stderr_closed: watch::channel(true).1, pid: None,
        });
        ws.claudes.lock().unwrap().insert("a".into(), Connection { remote_instance: None, generation: 7, bridge: bridge.clone(), events: None });
        let answering = bridge.clone();
        let sent = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let seen = sent.clone();
        tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                let id: u64 = command["id"].as_str().unwrap().parse().unwrap();
                let reply = match command["op"].as_str() {
                    Some("send") => json!({"queued":true,"turnId":command["turnId"]}),
                    Some("append") => json!({"queued":true,"uuid":"u","turnId":command["expectedTurnId"]}),
                    _ => json!({}),
                };
                seen.lock().unwrap().push(command);
                answering.pending.lock().await.remove(&id).unwrap().send(Ok(reply)).unwrap();
            }
        });
        let input = |value: Value| -> crate::model::MessageInput { serde_json::from_value(value).unwrap() };
        let item = |client: &str| ws.store.detail("a").unwrap().turns.iter()
            .flat_map(|t| t["items"].as_array().cloned().unwrap_or_default()).find(|i| i["clientId"] == client).unwrap();
        let local = |path: &std::path::Path| json!({"type":"localImage","path":path});

        let first = ws.send_message("a", input(json!({"clientMessageId":"m1","text":"What color?","images":[red]}))).await.unwrap();
        assert_eq!(first.status, "accepted");
        let send = sent.lock().unwrap().iter().find(|c| c["op"] == "send").cloned().unwrap();
        assert_eq!(send["images"], json!([{"path":red_path.canonicalize().unwrap(),"mediaType":"image/png",
            "sha256":format!("{:x}", Sha256::digest(&red_bytes)),"bytes":red_bytes.len()}]), "a checked file, not its data");
        assert_eq!(item("m1")["content"], json!([{"type":"text","text":"What color?"}, local(&red_path.canonicalize().unwrap())]));

        let turn = first.turn_id.clone().unwrap();
        let follow = ws.send_message("a", input(json!({"clientMessageId":"m2","text":"","images":[blue],"expectedTurnId":turn}))).await.unwrap();
        assert_eq!(follow.status, "queued");
        let append = sent.lock().unwrap().iter().find(|c| c["op"] == "append").cloned().unwrap();
        assert_eq!((append["text"].clone(), append["images"][0]["path"].clone()), (json!(""), json!(blue_path.canonicalize().unwrap())));
        let shown = item("m2");
        assert_eq!((shown["content"].clone(), shown["_yuzunoDelivery"].clone()),
            (json!([local(&blue_path.canonicalize().unwrap())]), json!("queued")));
        ws.dispatch_claude_event("a", 7, json!({"type":"message_delivery","clientMessageId":"m2","status":"accepted","turnId":turn})).await;

        // Another Agent's image is refused before anything reaches Claude.
        let count = sent.lock().unwrap().len();
        let refused = ws.send_message("a", input(json!({"clientMessageId":"m3","text":"and this","images":[other],"expectedTurnId":turn}))).await.unwrap();
        assert_eq!(refused.status, "rejected", "{:?}", refused.error);
        assert_eq!(sent.lock().unwrap().len(), count);
        // The same message id with other images is not the same message.
        let changed = ws.send_message("a", input(json!({"clientMessageId":"m1","text":"What color?","images":[blue]}))).await.unwrap_err();
        assert!(changed.to_string().contains("不同的内容"), "{changed}");
    }
}
