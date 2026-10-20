//! OpenCode Agents (T-110): an Agent's record driven by its own `opencode
//! serve` (see `opencode`). Local Agents only, and nothing creates one yet:
//! HTTP create and models refuse the harness and the UI offers none.
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
//! Not yet: sub-agent sessions (OpenCode's `task` tool) are not followed, so
//! a request one of them makes is not shown and its Turn waits until it is
//! interrupted; no message joins a running Turn; no images, forms or remote
//! machines.
use crate::{
    model::{ensure_agent_open, now, AgentDetail, PendingRequest},
    opencode::{self, Events, Launch, Mcp, MessageId, Reply, Server, Snapshot, Submission},
    rpc::OutcomeUnknown,
    workspace::Workspace,
};
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
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
}

/// The `opencode` this Core starts (`YUZUNO_OPENCODE_BIN`, else from PATH).
fn program() -> PathBuf {
    std::env::var_os("YUZUNO_OPENCODE_BIN").map(PathBuf::from).unwrap_or_else(|| "opencode".into())
}

impl Workspace {
    fn opencode_current(&self, id: &str, generation: u64) -> Option<Connection> {
        self.opencodes.lock().unwrap().get(id).filter(|c| c.generation == generation).cloned()
    }

    pub(crate) async fn opencode_reconnect_accepted(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit) -> Result<AgentDetail> {
        permit.validate(&self.admission)?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        ensure_agent_open(&self.detail(id).await?.agent)?;
        if let Err(error) = self.opencode_ensure(id).await {
            self.failed(id, &error).await;
            return Err(error);
        }
        self.detail(id).await
    }

    /// Under the Agent gate: the live connection, or a new OpenCode process
    /// for the Agent's session (created on the first connection).
    pub(crate) async fn opencode_ensure(self: &Arc<Self>, id: &str) -> Result<Connection> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
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
                self.update_record(id, "opencode/connectFailed", json!({"error":message}), |d| {
                    d.agent.connection_state = "disconnected".into();
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
        let snapshot = server.snapshot(&session).await?;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let c = Connection { generation, server: server.clone(), session: session.clone() };
        let owned = self.owner(id).await;
        self.opencodes.lock().unwrap().insert(id.into(), c.clone());
        let (agent, data) = (id.to_owned(), json!({"sessionId":session,"generation":generation,"version":opencode::VERSION}));
        let ready = self.stored_owned(owned, move |store| store.update(&agent, "opencode/ready", &data, move |d| {
            d.agent.connection_state = "connected".into();
            d.agent.status = "idle".into();
            d.agent.error = None;
            restarted(d);
            apply_snapshot(d, generation, &session, &snapshot);
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
        let snapshot = c.server.snapshot(&c.session).await?;
        let owned = self.owner(id).await;
        if self.opencode_current(id, c.generation).is_none() {
            return Ok(());
        }
        let (agent, generation, session) = (id.to_owned(), c.generation, c.session.clone());
        let data = json!({"generation":generation,"messages":snapshot.messages.as_array().map_or(0, Vec::len),
            "status":snapshot.status,"permissions":snapshot.permissions.len(),"questions":snapshot.questions.len()});
        self.stored_owned(owned, move |store| store.update(&agent, "opencode/resynced", &data, move |d| {
            apply_snapshot(d, generation, &session, &snapshot);
            refresh_status(d);
        }).map(drop)).await?;
        self.changed(id);
        Ok(())
    }

    /// One event, off the async workers, under the Agent's ownership lock,
    /// applied only while its connection is the Agent's current one.
    pub(crate) async fn dispatch_opencode_event(self: &Arc<Self>, id: &str, generation: u64, event: Value) {
        let _event = self.admission.enter_event();
        let owned = self.owner(id).await;
        let (ws, id) = (self.clone(), id.to_owned());
        let handled = crate::db::blocking(move || {
            let _owned = owned;
            ws.opencode_event(&id, generation, &event);
            Ok(())
        });
        if let Err(error) = handled.await {
            eprintln!("Workspace OpenCode event not handled: {error}");
        }
    }

    fn opencode_event(&self, id: &str, generation: u64, event: &Value) {
        let Some(c) = self.opencode_current(id, generation) else { return };
        // Another session's (a sub-agent's, say) is not this Agent's.
        if opencode::session_of(event) != Some(c.session.as_str()) {
            return;
        }
        let kind = event["type"].as_str().unwrap_or("unknown");
        let journal = format!("opencode/{kind}");
        let written = match kind {
            // Text as it streams: the completed part replaces it.
            "message.part.delta" => return,
            kind if projected(kind) => self.store.record_event(id, &journal, event, |d| {
                project(d, generation, &c.session, event);
                refresh_status(d);
            }).map(drop),
            // Kept as evidence; it changes nothing here.
            _ => self.store.update_meta(id, &journal, event, |_| {}).map(drop),
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
        let _ = self.stored_owned(owned, move |store| store.update(&agent, "runtime/error", &data, move |d| {
            let busy = d.turns.iter().any(|t| t["status"] == "inProgress");
            ended(d, &message);
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
        self.opencode_send_locked(id, text, None).await
    }

    /// Before a receipt is recorded (send_message): what an OpenCode Agent
    /// takes is a new message while it is idle, with Workspace MCP ready.
    pub(crate) async fn opencode_admit(self: &Arc<Self>, id: &str, input: &crate::model::MessageInput, detail: &AgentDetail) -> Result<()> {
        ensure!(input.question.is_none() && input.clarification.is_none() && input.expected_turn_id.is_none(),
            "OpenCode Agent 目前只接受空闲时的新消息；草稿保留");
        ensure!(!busy(detail), "OpenCode 正在执行或等待回应；这条消息没有发送，草稿保留");
        self.opencode_ensure(id).await?;
        self.require_collaboration(id).await
    }

    /// Under the Agent gate: one new prompt while OpenCode is idle. Ok means
    /// OpenCode stored it under its ID; a send whose outcome is unknown is an
    /// `OutcomeUnknown`, and is never sent again.
    pub(crate) async fn opencode_send_locked(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>) -> Result<Value> {
        let mut sent = false;
        let result = self.opencode_send_once(id, text, client_id, &mut sent).await;
        if let (Err(error), false, Some(client)) = (&result, sent, client_id) {
            // It was never sent, or OpenCode refused it. Its receipt says so,
            // even if a connection that ended meanwhile settled it as unknown.
            let (client, message) = (client.to_owned(), error.to_string());
            let recorded = self.record_meta(id, "opencode/notSent", json!({"clientMessageId":client,"error":message}), move |m| {
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
        result
    }

    /// `sent`: whether OpenCode may have taken the prompt (asked, and not refused).
    async fn opencode_send_once(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>, sent: &mut bool) -> Result<Value> {
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        ensure!(!busy(&d), "OpenCode 正在执行或等待回应；这条消息没有发送");
        let c = self.opencode_ensure(id).await?;
        self.require_collaboration(id).await?;
        ensure!(self.opencode_current(id, c.generation).is_some(), "OpenCode 连接已变化，消息未发送；草稿保留");
        let message = MessageId::new();
        let turn = message.as_str().to_owned();
        // Recorded before it is sent: its ID is the only way to learn what
        // became of it.
        let (requested, client, content) = (turn.clone(), client_id.map(str::to_owned), json!([{"type":"text","text":text}]));
        self.record_update(id, "opencode/turnRequested", json!({"turnId":turn,"messageId":turn,"clientMessageId":client_id,"text":text}), move |d| {
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
        let submitted = c.server.submit(&c.session, &message, &text).await;
        let refused = match &submitted {
            Ok(Submission::Refused(status)) => Some(format!("OpenCode 拒绝了这条消息（HTTP {}），它没有收下：{}", status.code, status.body)),
            // Refused here, before any request.
            Err(error) => Some(format!("消息没有发送：{error}")),
            Ok(Submission::Accepted | Submission::Unknown(_)) => None,
        };
        if let Some(message) = refused {
            *sent = false;
            let (failed, error) = (turn.clone(), message.clone());
            self.record_update(id, "opencode/promptRefused", json!({"turnId":turn,"error":message}), move |d| {
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
        self.record_update(id, "opencode/deliveryUnconfirmed", json!({"turnId":turn,"submission":detail}), move |d| {
            d.turn_mut(&unconfirmed)["deliveryUnconfirmed"] = true.into();
        }).await?;
        self.changed(id);
        Err(OutcomeUnknown(format!("OpenCode 没有按这条消息的编号确认收到它（{detail}）；不会重发。若它已收下，结果仍会显示在这一轮。")).into())
    }

    /// Whether OpenCode stored the message sent under `message`, by its own
    /// record or the event that confirmed it, within CONFIRM_LIMIT.
    async fn opencode_confirm(&self, id: &str, c: &Connection, message: &MessageId) -> bool {
        let deadline = Instant::now() + CONFIRM_LIMIT;
        loop {
            let confirmed = self.send_view(id).await.is_ok_and(|d| d.turns.iter().any(|t| t["id"] == message.as_str() && t["_opencodeConfirmed"] == true));
            if confirmed || c.server.message(&c.session, message).await.is_ok_and(|m| m.is_some()) {
                let turn = message.as_str().to_owned();
                let _ = self.record_update(id, "opencode/messageConfirmed", json!({"turnId":turn}), move |d| confirm(d, &turn)).await;
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
        self.record_update(id, "opencode/interruptRequested", json!({"turnId":turn}), move |d| {
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
            let d = store.detail(&agent)?;
            ensure_agent_open(&d.agent)?;
            let Some(p) = d.pending.iter().find(|p| p.id == request).cloned() else {
                return Ok(None);
            };
            ensure!(!p.stale && p.params["_responseSent"] != true, "这个请求已经回答或已失效；不会再次发送");
            let c = connection.context("OpenCode 连接已断开，回答没有发送")?;
            // Only the process and session that asked can take the answer.
            ensure!(p.params["_runtimeGeneration"] == c.generation && p.params["_opencodeSession"] == c.session.as_str(),
                "这个请求属于已经结束的 OpenCode 连接；不会把回答发给新的进程");
            let answer = answer(&p, &reply)?;
            store.update(&agent, "request/replied", &json!({"requestId":request}), |d| {
                if let Some(p) = d.pending.iter_mut().find(|p| p.id == request) {
                    p.params["_responseSent"] = true.into();
                }
            })?;
            Ok(Some((p, c, answer)))
        }).await?;
        let Some((p, c, answer)) = checked else { return Ok(false) };
        let native = p.params["id"].as_str().unwrap_or_default();
        let sent = match &answer {
            Answer::Permission(reply) => c.server.reply_permission(&c.session, native, *reply).await,
            Answer::Question(answers) => c.server.reply_question(&c.session, native, answers).await,
            Answer::RejectQuestion => c.server.reject_question(&c.session, native).await,
        };
        let request = request_id.to_owned();
        match sent {
            Ok(()) => {
                let owned = self.owner(id).await;
                if self.opencode_current(id, c.generation).is_some() {
                    let agent = id.to_owned();
                    self.stored_owned(owned, move |store| store.update(&agent, "opencode/requestAnswered", &json!({"requestId":request}), |d| {
                        d.pending.retain(|p| p.id != request);
                        refresh_status(d);
                    }).map(drop)).await?;
                }
            }
            Err(error) => {
                // A sent answer whose fate is unknown never becomes a button again.
                let message = error.to_string();
                self.update_record(id, "opencode/requestAnswerFailed", json!({"requestId":request_id,"error":message}), move |d| {
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
    /// and whatever did not end by itself is left unknown, never resent.
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
        // Let OpenCode end cleanly when nothing else holds it; else dropping
        // the last holder ends its group.
        match Arc::try_unwrap(c.server) {
            Ok(server) => server.shutdown().await?,
            Err(server) => drop(server),
        }
        self.update_record(id, "opencode/closed", json!({"generation":generation}), |d| {
            ended(d, "OpenCode 关闭前没有确认这一轮结束；结果未确认，不会重发。原 Session 与历史保留。");
            d.agent.connection_state = "disconnected".into();
        }).await?;
        self.changed(id);
        Ok(())
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
            // follows does, from what the Turn's own messages say.
            d.agent.error = Some(format!("OpenCode 报告了会话错误：{}", error_text(&p["error"])));
            if let Some(turn) = running(d) {
                turn["_opencodeSessionError"] = p["error"].clone();
            }
        }
        "permission.asked" => ask(d, PERMISSION, generation, session, p),
        "question.asked" => ask(d, QUESTION, generation, session, p),
        "permission.replied" | "question.replied" | "question.rejected" => {
            let request = p["requestID"].clone();
            d.pending.retain(|r| !(r.params["id"] == request && r.params["_runtimeGeneration"] == generation));
        }
        _ => {}
    }
}

/// What a snapshot holds, applied as the events it stands for would be; each
/// part and message replaces its own, so applying one again changes nothing.
fn apply_snapshot(d: &mut AgentDetail, generation: u64, session: &str, snapshot: &Snapshot) {
    for entry in snapshot.messages.as_array().into_iter().flatten() {
        message(d, &entry["info"]);
        for p in entry["parts"].as_array().into_iter().flatten() {
            part(d, p);
        }
    }
    // This process's requests are what it has pending now; it answered or
    // dropped the others while no stream was open.
    let pending: Vec<&Value> = snapshot.permissions.iter().chain(&snapshot.questions).map(|r| &r["id"]).collect();
    d.pending.retain(|r| r.params["_runtimeGeneration"] != generation || pending.contains(&&r.params["id"]));
    for request in &snapshot.permissions {
        ask(d, PERMISSION, generation, session, request);
    }
    for request in &snapshot.questions {
        ask(d, QUESTION, generation, session, request);
    }
    status(d, &snapshot.status);
}

fn message(d: &mut AgentDetail, info: &Value) {
    let Some(id) = info["id"].as_str() else { return };
    match info["role"].as_str() {
        Some("user") => confirm(d, id),
        Some("assistant") => {
            let Some(turn) = info["parentID"].as_str().and_then(|parent| d.turns.iter_mut().find(|t| t["id"] == parent)) else {
                return;
            };
            if !turn["_opencodeAnswers"].is_object() {
                turn["_opencodeAnswers"] = json!({});
            }
            turn["_opencodeAnswers"][id] = json!({"completed":info["time"]["completed"],"error":info["error"],"finish":info["finish"]});
        }
        _ => {}
    }
}

/// OpenCode stored the prompt sent under `turn`: it was delivered.
fn confirm(d: &mut AgentDetail, turn: &str) {
    let Some(entry) = d.turns.iter_mut().find(|t| t["id"] == turn) else { return };
    entry["_opencodeConfirmed"] = true.into();
    if let Some(receipt) = d.message_receipts.iter_mut().find(|r| r.turn_id.as_deref() == Some(turn)) {
        if receipt.status != "rejected" {
            receipt.status = "accepted".into();
            receipt.error = None;
        }
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
    if let Some(error) = answers.iter().map(|a| &a["error"]).find(|e| e.is_object()) {
        let interrupted = error["name"] == "MessageAbortedError";
        turn["status"] = if interrupted { "interrupted" } else { "failed" }.into();
        turn["error"] = json!({"message":error_text(error),"native":error});
    } else if !answers.is_empty() && answers.iter().all(|a| a["completed"].is_number()) {
        turn["status"] = "completed".into();
    } else {
        unknown(turn, "OpenCode 回到空闲，但没有为这条消息留下完成的回答；结果未确认，不会重发。");
        return;
    }
    settle_tools(turn);
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

fn ask(d: &mut AgentDetail, method: &str, generation: u64, session: &str, request: &Value) {
    let Some(native) = request["id"].as_str() else { return };
    if d.pending.iter().any(|p| !p.stale && p.params["id"] == native && p.params["_runtimeGeneration"] == generation) {
        return;
    }
    let mut params = request.clone();
    params["_runtimeGeneration"] = generation.into();
    params["_opencodeSession"] = session.into();
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
