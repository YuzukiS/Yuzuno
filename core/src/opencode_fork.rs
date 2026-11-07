//! Forking an OpenCode Agent into a new one (T-10 Fork; contract on T-10
//! #3527, Lead 3525; moved to OpenCode 2.x in T-61 slice 7, D-28 F-A). The
//! new Agent works in the same folder, with its own OpenCode process and
//! database, and holds the conversation through one of the source's
//! completed Turns. The source Agent and its session are never written.
//!
//! Core reads the source's session and every page of its messages under
//! the source's gate, while it is idle, and fixes the copy: every message up
//! to the idle that ended the Turn's last run (`opencode_fork_check::cut`),
//! under a new session ID Core chooses, with a marker naming this request.
//! The source goes on then. The new Agent's OpenCode is started once on its
//! own empty database in the same folder, the copy is written there through
//! 2.x's import (`opencode_transfer`), read back and compared field by
//! field, and only then is the new Agent registered and attached to that
//! same process. 2.x's import keeps every message's ID, so the copied Turns
//! name the same messages they did (`opencode_fork_check::copy`).
//!
//! One request, kept in `opencode_forks` from before it is asked, is never
//! asked anew from that Turn (Lead 4195), by this request or another. One
//! whose import answer never came is uncertain: the same request goes on
//! from it (D-33), reading what the new Agent's OpenCode holds first and
//! writing only if it holds nothing, so that it is never written twice (a
//! second write of the same ID is refused, 409). That uncertainty is the
//! attempt's alone: the source Agent goes on.
//!
//! The new Agent has no login of the source's (D-31): its OpenCode starts
//! on an empty database, and no credential is ever copied. Its copied Turns
//! cannot be rewound (D-32): their snapshots are in the source's store.
use super::*;
use crate::opencode_fork_check as check;
use crate::opencode_transfer::{self as transfer, Payload, Written};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How long the import is waited for before the attempt is left uncertain.
/// (Shorter in tests.)
const WATCH: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 120 });
/// At most this much of the source is fixed for one fork.
const FROZEN_LIMIT: usize = 64 << 20;
/// States an attempt holds its boundary in: one live attempt per Turn. Each
/// as 1.19.3's fork named it, so that the index made then still holds:
/// `forked` is an attempt whose copy the new Agent's OpenCode holds, and
/// `chained` is only 1.19.3's.
const LIVE: &str = "('sending','uncertain','forked','verified','chained','completed')";
/// What an attempt fixes, in this form since 2.x (an earlier one is 1.19.3's).
const FROZEN_VERSION: u32 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    turn_id: String,
}

/// Which attempt a read is about: one request, or the live one for a Turn.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Which {
    request_id: Option<String>,
    turn_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    request_id: String,
    turn_id: String,
    name: String,
}

/// One fork attempt as kept.
#[derive(Clone, Debug)]
struct Row {
    request_id: String,
    source_agent_id: String,
    through_turn_id: String,
    target_agent_id: String,
    name: String,
    state: String,
    /// The new session's ID, chosen before anything is asked.
    fork_session: Option<String>,
    error: Option<String>,
    /// A digest of the copy it fixed: what is written must be it.
    prefix_sha: String,
}

/// What an attempt fixed before it asked: the copy, and what the new Agent
/// is made from.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frozen {
    #[serde(default)]
    version: u32,
    /// The source's session.
    session: String,
    cwd: String,
    /// The project 2.x holds the folder for, which the new Agent's OpenCode must too.
    project: String,
    payload: Payload,
    /// The source's Turns through the fork's, as stored.
    turns: Vec<Value>,
    agent: Value,
}

/// A source read under its gate, for a fork through one Turn.
struct Read {
    session: String,
    generation: u64,
    detail: AgentDetail,
    info: Value,
    folder: String,
    project: String,
    prefix: Vec<Value>,
    kept: usize,
    later: usize,
}

impl Workspace {
    /// What a fork through `turn` would keep, read without a write (contract
    /// 1): refused, saying why, unless one could start now.
    pub async fn opencode_fork_preview(self: &Arc<Self>, id: &str, turn: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let read = self.opencode_fork_read(id, turn).await?;
        Ok(json!({
            "turnId": turn, "keptTurns": read.kept, "laterTurns": read.later, "messages": read.prefix.len(),
            "cwd": read.detail.agent.cwd, "name": format!("{} (fork)", read.detail.agent.name),
            "model": read.detail.agent.model, "variant": read.detail.agent.settings.reasoning_effort,
        }))
    }

    /// An attempt as it stands, read without a write (contract 3): by its
    /// request, or the live one for a Turn, so that a page that lost its
    /// request finds that attempt rather than asking again.
    pub(crate) async fn opencode_fork_seen(self: &Arc<Self>, id: &str, which: Which) -> Result<Value> {
        let source = id.to_owned();
        let row = self.stored(move |s| match (&which.request_id, &which.turn_id) {
            (Some(request), _) => Ok(s.opencode_fork_row(request)?.filter(|row| row.source_agent_id == source)),
            (None, Some(turn)) => s.opencode_live_fork(&source, turn),
            (None, None) => bail!("fork 请求编号或 Turn 必须有一个"),
        }).await?;
        let Some(row) = row else { return Ok(json!({"state":"none"})) };
        Ok(match row.state.as_str() {
            "sending" | "uncertain" => outcome(&row, "uncertain", row.error.clone().unwrap_or_else(|| UNCERTAIN.into())),
            "failed" | "released" => outcome(&row, "failed", row.error.clone().unwrap_or_else(|| "fork 没有完成".into())),
            "completed" => match self.listed(&row.target_agent_id).await {
                Ok(agent) => json!({"state":"completed","requestId":row.request_id,"connected":agent.connection_state == "connected","agent":agent,"warnings":[]}),
                Err(_) => outcome(&row, "failed", "fork 出的 Agent 已删除".into()),
            },
            _ => outcome(&row, "pending", row.error.clone().map(|e| format!("{e}。")).unwrap_or_default()
                + "这次 fork 还没有登记完；继续会接着核对和登记同一份副本，不会再写一次"),
        })
    }

    /// Everything a fork through `turn` needs, read now (contract 1, 2).
    async fn opencode_fork_read(self: &Arc<Self>, id: &str, turn: &str) -> Result<Read> {
        self.ensure_rewind_settled(id).await?;
        // Its Turns as stored, payloads included and with nothing a read adds
        // for clients (the Agent's own mail, results, origins), with the
        // requests and receipts of its open view.
        let (agent, wanted) = (id.to_owned(), turn.to_owned());
        let detail = self.stored(move |store| {
            let mut detail = store.view(&agent, Sel::Open)?;
            detail.turns = store.stored_turns(&agent)?;
            ensure!(detail.turns.iter().any(|t| t["id"] == wanted.as_str()), "这个 Agent 没有这个 Turn；没有 fork");
            Ok(detail)
        }).await?;
        ensure_agent_open(&detail.agent)?;
        ensure!(detail.agent.harness == "opencode", "Agent 不是 OpenCode");
        ensure!(detail.agent.remote.is_none(), "OpenCode Agent 目前只支持 Core 所在的本机");
        if let Some(blocked) = compaction_blocks(&detail, "没有 fork") {
            bail!(blocked);
        }
        ensure!(!detail.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")),
            "上一条消息的发送结果尚未确认，请先重连核对；没有 fork");
        ensure!(!busy(&detail), "OpenCode 正在执行或等待回应；fork 只在空闲时进行");
        let c = self.opencodes.lock().unwrap().get(id).cloned().context("OpenCode Agent 尚未连接；连接后才能 fork")?;
        let unread = "没有读到 OpenCode 会话现在的状态；没有 fork";
        let info = c.server.session(&c.session).await.context(unread)?;
        ensure!(info["revert"].is_null(), "OpenCode 会话里有一次尚未处理的回退；没有 fork");
        ensure!(info["parentID"].is_null() && info["fork"].is_null(), "OpenCode 会话是另一个会话的子会话或分叉；没有 fork");
        // Core's own marker (a fork's or an import's, T-61 slices 7 and 8) is replaced by the copy's; anything else can't be carried.
        let own = info["metadata"].is_null() || info["metadata"].as_object().is_some_and(|m| m.keys().all(|k| k == "yuzuno"));
        ensure!(own, "OpenCode 会话带有别处写的 metadata，fork 无法照样带到新会话；没有 fork");
        ensure!(c.server.session_status(&c.session).await.context(unread)?["type"] == "idle", "OpenCode 会话不是空闲状态；没有 fork");
        let listed = c.server.messages(&c.session).await.context(unread)?;
        let list = listed.as_array().context(unread)?.clone();
        // The folder as OpenCode resolves it, and the project it holds it for: the session's.
        let cwd = detail.agent.cwd.clone();
        let folder = tokio::task::spawn_blocking(move || std::fs::canonicalize(cwd)).await?.context("这个 Agent 的目录无法读取；没有 fork")?
            .to_str().context("这个 Agent 的目录不是 UTF-8；没有 fork")?.to_owned();
        let location = c.server.location(&folder).await.context(unread)?;
        let named = location["directory"].as_str().map(PathBuf::from);
        let directory = tokio::task::spawn_blocking(move || named.and_then(|d| std::fs::canonicalize(d).ok())).await?;
        ensure!(directory.as_deref() == Some(Path::new(&folder)), "OpenCode 的工作目录不是这个 Agent 的目录；没有 fork");
        let project = location["project"]["id"].as_str().context("OpenCode 没有说它的项目；没有 fork")?.to_owned();
        ensure!(info["projectID"] == project.as_str(), "OpenCode 会话不属于它现在的项目；没有 fork");
        let end = check::cut(&detail.turns, &list, turn)?;
        let index = detail.turns.iter().position(|t| t["id"] == turn).unwrap_or_default();
        ensure!(self.opencode_current(id, c.generation).is_some(), "OpenCode 连接已变化；没有 fork");
        Ok(Read {
            session: c.session.clone(), generation: c.generation, kept: index + 1, later: detail.turns.len() - index - 1,
            detail, info, folder, project, prefix: list[..end].to_vec(),
        })
    }

    /// One fork, as `request` asks (see the module). In a task of its own:
    /// a client that goes away drops only its wait for the outcome. Asked
    /// again with the same request, it goes on from where that attempt is,
    /// and never writes the copy twice.
    pub async fn opencode_fork(self: &Arc<Self>, id: &str, request: Request) -> Result<Value> {
        let permit = self.admission.enter_work()?;
        ensure!(uuid::Uuid::parse_str(&request.request_id).is_ok(), "fork 请求编号无效");
        ensure!(!request.turn_id.is_empty() && request.turn_id.len() <= 200 && !request.turn_id.chars().any(char::is_control), "fork 的 Turn 无效");
        let name = request.name.trim().to_owned();
        ensure!(!name.is_empty() && name.len() <= 100, "请填写名称（最多 100 字节）");
        let (ws, id) = (self.clone(), id.to_owned());
        tokio::spawn(async move {
            let _permit = permit;
            ws.opencode_fork_run(&id, Request { name, ..request }).await
        })
        .await?
    }

    async fn opencode_fork_run(self: &Arc<Self>, id: &str, request: Request) -> Result<Value> {
        let (source, key, turn) = (id.to_owned(), request.request_id.clone(), request.turn_id.clone());
        let mut row = match self.stored(move |s| s.opencode_fork_row(&key)).await? {
            Some(row) => {
                ensure!(row.source_agent_id == source && row.through_turn_id == turn, "同一 fork 请求不能改变来源或 Turn");
                row
            }
            None => self.opencode_fork_begin(id, &request).await?,
        };
        // From here on, the attempt's own gate: retries of one request run one at a time.
        let gate = self.gate(&row.target_agent_id).await;
        let _held = gate.lock().await;
        let key = row.request_id.clone();
        row = self.stored(move |s| s.opencode_fork_row(&key)).await?.context("fork 记录不见了")?;
        let mut warnings = Vec::new();
        // The new Agent's OpenCode, once started for this run: what it reads back is what it is attached to.
        let mut started = None;
        loop {
            if matches!(row.state.as_str(), "sending" | "uncertain" | "forked" | "verified") && !self.opencode_fork_current(&row)? {
                self.opencode_fork_state(&mut row, "failed", Some(EARLIER.into())).await?;
                continue;
            }
            match row.state.as_str() {
                "sending" | "uncertain" => {
                    self.opencode_fork_import(&mut row, &mut started).await?;
                    if row.state == "uncertain" {
                        return Ok(outcome(&row, "uncertain", row.error.clone().unwrap_or_else(|| UNCERTAIN.into())));
                    }
                }
                "failed" | "released" => return Ok(outcome(&row, "failed", row.error.clone().unwrap_or_else(|| "fork 没有完成".into()))),
                "forked" => self.opencode_fork_verify(&mut row, &mut started).await?,
                "verified" => self.opencode_fork_target(&mut row, &mut started, &mut warnings).await?,
                "chained" => self.opencode_fork_state(&mut row, "failed", Some(EARLIER.into())).await?,
                "completed" => break,
                other => bail!("未知的 fork 状态 {other}"),
            }
        }
        let agent = self.listed(&row.target_agent_id).await?;
        let connected = agent.connection_state == "connected";
        Ok(json!({"state":"completed","requestId":row.request_id,"agent":agent,"connected":connected,"warnings":warnings}))
    }

    /// The attempt's start, under the source's gate (contract 3): another
    /// live attempt for the same Turn is answered as it stands, whatever
    /// request asks; otherwise the source is read and what it holds is fixed
    /// and kept, under the session ID the copy will have. Nothing is asked
    /// of the source's OpenCode but reads: the source goes on once this
    /// returns.
    async fn opencode_fork_begin(self: &Arc<Self>, id: &str, request: &Request) -> Result<Row> {
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (source, turn) = (id.to_owned(), request.turn_id.clone());
        if let Some(earlier) = self.stored(move |s| s.opencode_live_fork(&source, &turn)).await? {
            // Its Agent deleted, a completed fork no longer continues anything (as with Codex).
            if !(earlier.state == "completed" && self.listed(&earlier.target_agent_id).await.is_err()) {
                return Ok(earlier);
            }
            let key = earlier.request_id.clone();
            self.stored(move |s| s.opencode_set_fork(&key, "released", None, Some("fork 出的 Agent 已删除"))).await?;
        }
        let read = self.opencode_fork_read(id, &request.turn_id).await?;
        let index = read.detail.turns.iter().position(|t| t["id"] == request.turn_id.as_str()).unwrap_or_default();
        let payload = fork_payload(&read, &request.name, &request.request_id)?;
        let frozen = Frozen {
            version: FROZEN_VERSION, session: read.session.clone(), cwd: read.detail.agent.cwd.clone(), project: read.project.clone(),
            payload, turns: read.detail.turns[..=index].to_vec(), agent: serde_json::to_value(&read.detail.agent)?,
        };
        let bytes = serde_json::to_vec(&frozen)?;
        ensure!(bytes.len() <= FROZEN_LIMIT, "要 fork 的内容超过 {} MiB；没有 fork", FROZEN_LIMIT >> 20);
        let row = Row {
            request_id: request.request_id.clone(), source_agent_id: id.into(), through_turn_id: request.turn_id.clone(),
            target_agent_id: uuid::Uuid::new_v4().to_string(), name: request.name.clone(), state: "sending".into(),
            fork_session: Some(frozen.payload.id().to_owned()), error: None, prefix_sha: check::digest(&serde_json::to_value(&frozen.payload)?)?,
        };
        let folder = self.opencode_fork_folder(&row.request_id)?;
        write_private(&folder.join("frozen.json"), &bytes)?;
        self.opencode_fork_reserve(&row)?;
        ensure!(self.opencode_current(id, read.generation).is_some(), "OpenCode 连接已变化；没有 fork");
        let kept = row.clone();
        self.stored(move |s| s.opencode_begin_fork(&kept)).await?;
        Ok(row)
    }

    /// The new Agent's OpenCode started once on its own empty database in
    /// the same folder (or the one this run started), and the copy written
    /// there once (rule R5): only if it lists no session at all. One that
    /// lists only this very copy, with this request's marker, holds it
    /// already (an earlier write whose answer was lost); anything else fails
    /// the fork, written over by nothing. The import's answer:
    /// - 200, or 409 for this ID: it holds a session under it (only a read
    ///   tells which);
    /// - any error answer: the fork fails, so that the Turn is free to be
    ///   forked anew (#736 R1); a session it may have written stays in this
    ///   attempt's folder (D-36), and a new attempt writes into its own;
    /// - none within WATCH: uncertain, and the same request goes on from
    ///   there (D-33). Gone on from there, its new OpenCode read to hold
    ///   nothing, none a second time fails it as well: an import that never
    ///   answers never holds the Turn.
    async fn opencode_fork_import(self: &Arc<Self>, row: &mut Row, started: &mut Option<Started>) -> Result<()> {
        let frozen = self.opencode_fork_fixed(row)?;
        self.opencode_fork_reserved(row)?;
        let server = self.opencode_fork_server(row, &frozen, started).await?;
        if let Err(error) = transfer::place(&server, &frozen.payload, &frozen.project).await {
            return self.opencode_fork_state(row, "failed", Some(format!("{error:#}"))).await;
        }
        let (anew, again) = ("可以重新 fork，新的一次会写进它自己的目录", "重试会接着核对新 Agent 的 OpenCode，不会写第二次");
        match transfer::write_once(&server, &frozen.payload, WATCH, row.state == "uncertain", anew, again).await? {
            Written::Held => self.opencode_fork_state(row, "forked", None).await,
            Written::Failed(why) => self.opencode_fork_state(row, "failed", Some(why)).await,
            Written::Uncertain(why) => self.opencode_fork_state(row, "uncertain", Some(format!("{why}。原 Agent 照常可用"))).await,
        }
    }

    /// The copy as the new Agent's OpenCode holds it, read back whole and
    /// compared with what was fixed (rule R6): any difference fails the
    /// fork, and the new Agent's folder is kept (D-36). A failed read proves
    /// nothing: it stays written, and is read again next time.
    async fn opencode_fork_verify(self: &Arc<Self>, row: &mut Row, started: &mut Option<Started>) -> Result<()> {
        let frozen = self.opencode_fork_fixed(row)?;
        self.opencode_fork_reserved(row)?;
        let server = self.opencode_fork_server(row, &frozen, started).await?;
        match transfer::read_copy(&server, &frozen.payload, &frozen.project).await? {
            Ok(()) => self.opencode_fork_state(row, "verified", None).await,
            Err(error) => self.opencode_fork_state(row, "failed",
                Some(format!("{error:#}；没有登记，新 Agent 的目录留着，原 Agent 未改变"))).await,
        }
    }

    /// Contract 6: the copy verified, the new Agent registered with the
    /// source's Turns as copied, and attached to the very process the copy
    /// was read back from (or one started now, on a later run).
    async fn opencode_fork_target(self: &Arc<Self>, row: &mut Row, started: &mut Option<Started>, warnings: &mut Vec<String>) -> Result<()> {
        let frozen = self.opencode_fork_fixed(row)?;
        self.opencode_fork_reserved(row)?;
        let session = frozen.payload.id().to_owned();
        let root = self.data_dir.canonicalize().unwrap_or_else(|_| self.data_dir.clone());
        let mut images = Images { root, from: row.source_agent_id.clone(), to: row.target_agent_id.clone(), files: Vec::new() };
        let from = json!({"agentId": row.source_agent_id, "sessionId": frozen.session, "requestId": row.request_id});
        let turns = check::copy(&frozen.turns, &session, &from, &mut images)?;
        tokio::task::spawn_blocking(move || images.copy()).await??;
        let server = self.opencode_fork_server(row, &frozen, started).await?;
        let detail = self.opencode_fork_detail(row, &frozen, &session, turns, server.version())?;
        let (source, request) = (row.source_agent_id.clone(), row.request_id.clone());
        let (agent, project_kept, project) = self.stored(move |s| {
            let project = s.agent_project(&source)?;
            let (agent, kept) = s.opencode_insert_fork(&detail, project.as_deref(), &request, &source)?;
            Ok((agent, kept, project))
        }).await?;
        if project.is_some() && !project_kept {
            warnings.push("原 Project 已归档，fork 未加入该 Project。".into());
        }
        row.state = "completed".into();
        self.changed(&row.source_agent_id);
        self.changed(&agent.id);
        if project_kept {
            // The fork leads the source's Project (YN-2 S4).
            self.projects_changed();
        }
        // Attached to the very process the copy was read back from. A failed
        // attach leaves the registered Agent offline; nothing is retried here.
        if let Err(error) = self.opencode_ensure_on(&agent.id, started.take()).await {
            warnings.push(format!("fork 已登记，但连接失败：{error}"));
        }
        Ok(())
    }

    /// The new Agent's OpenCode for this run: the one it started, or one
    /// started now on its own folder.
    async fn opencode_fork_server(self: &Arc<Self>, row: &Row, frozen: &Frozen, started: &mut Option<Started>) -> Result<Arc<opencode::Server>> {
        if started.is_none() {
            *started = Some(self.opencode_start(&row.target_agent_id, &frozen.cwd).await
                .context("新 Agent 的 OpenCode 没有启动；重试会接着进行，不会写第二次")?);
        }
        started.as_ref().map(|started| started.server.clone()).context("新 Agent 的 OpenCode 没有启动")
    }

    fn opencode_fork_detail(&self, row: &Row, frozen: &Frozen, session: &str, turns: Vec<Value>, version: &str) -> Result<AgentDetail> {
        let source: crate::model::Agent = serde_json::from_value(frozen.agent.clone())?;
        let at = now();
        Ok(AgentDetail {
            agent: crate::model::Agent {
                id: row.target_agent_id.clone(), name: row.name.clone(), goal: String::new(), work_summary: None, project_id: None, kind: None, released_at: None, released_by: None, executor: None,
                cwd: frozen.cwd.clone(), model: source.model.clone(), settings: source.settings.clone(), color: source.color.clone(),
                harness: "opencode".into(), claude_session_id: None, opencode_session_id: Some(session.into()),
                opencode_version: Some(version.into()), opencode_major: crate::opencode::major(version), thread_id: None,
                status: "offline".into(), closed_at: None, disconnected_at: None, disconnect_unconfirmed: false,
                created_at: at.clone(), updated_at: at, unread_count: 0, pending_count: 0, open_questions: 0, last_turn_end: None, last_message: None,
                last_seq: 0, reviewed_seq: 0, rev: 0, error: None, remote: None, connection_state: "disconnected".into(),
            },
            history: None, turns, pending: vec![], artifacts: vec![], context_usage: None, message_receipts: vec![],
            claude_runtime: None, codex_handoff: None, opencode_usage_seen: None,
        })
    }

    async fn opencode_fork_state(&self, row: &mut Row, state: &str, error: Option<String>) -> Result<()> {
        let (key, kept, message) = (row.request_id.clone(), state.to_owned(), error.clone());
        self.stored(move |s| s.opencode_set_fork(&key, &kept, None, message.as_deref())).await?;
        row.state = state.into();
        row.error = error;
        Ok(())
    }

    /// Where an attempt keeps what it fixed: Core's own, not the user's.
    fn opencode_fork_folder(&self, request: &str) -> Result<PathBuf> {
        ensure!(uuid::Uuid::parse_str(request).is_ok(), "fork 请求编号无效");
        let folder = self.data_dir.join("opencode").join("forks").join(request);
        std::fs::create_dir_all(&folder)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(folder)
    }

    /// Whether what the attempt fixed is of this form: one 1.19.3's fork
    /// fixed cannot go on here.
    fn opencode_fork_current(&self, row: &Row) -> Result<bool> {
        let fixed: Value = read_private(&self.opencode_fork_folder(&row.request_id)?.join("frozen.json"))?;
        Ok(fixed["version"] == FROZEN_VERSION)
    }

    /// What the attempt fixed, as it fixed it: its digest the kept one.
    fn opencode_fork_fixed(&self, row: &Row) -> Result<Frozen> {
        let frozen: Frozen = read_private(&self.opencode_fork_folder(&row.request_id)?.join("frozen.json"))?;
        ensure!(frozen.version == FROZEN_VERSION, "{EARLIER}");
        ensure!(check::digest(&serde_json::to_value(&frozen.payload)?)? == row.prefix_sha
            && row.fork_session.as_deref() == Some(frozen.payload.id()), "fork 记下的内容与当时不同；没有登记");
        Ok(frozen)
    }

    /// The new Agent's folder, taken for this attempt alone before anything
    /// is asked (Lead 3529): made new, with the attempt it is for.
    fn opencode_fork_reserve(&self, row: &Row) -> Result<()> {
        let folder = self.data_dir.join("opencode").join(&row.target_agent_id);
        transfer::reserve(&folder, "fork.json", &json!({"requestId": row.request_id, "sourceAgentId": row.source_agent_id,
            "database": folder.join("opencode.db")})).context("没有 fork")
    }

    /// The new Agent's folder is still this attempt's, as reserved.
    fn opencode_fork_reserved(&self, row: &Row) -> Result<()> {
        let marker = transfer::reserved(&self.data_dir.join("opencode").join(&row.target_agent_id), "fork.json")?;
        ensure!(marker["requestId"] == row.request_id.as_str() && marker["sourceAgentId"] == row.source_agent_id.as_str(),
            "新 Agent 的目录不是为这次 fork 预留的；没有登记");
        Ok(())
    }
}

/// An attempt left without the import's answer.
const UNCERTAIN: &str = "新 Agent 的 OpenCode 还没有确认写入这份副本；再次 fork 同一个请求会接着核对，不会写第二次，原 Agent 照常可用";
/// An attempt 1.19.3's fork began.
const EARLIER: &str = "这次 fork 是之前的 Core 在 OpenCode 1.19.3 上开始的，不能在 2.x 上接着进行；原 Agent 未改变，可以重新 fork";

/// The copy a fork writes (D-28): every message through the cut, as read,
/// under a new session ID with this request's marker; the session's own
/// settings as they stood at the cut (the agent and model of the copy's
/// newest selection, else the session's); no usage (D-34, as 2.x's own fork);
/// its times those of the source's start and of the cut's idle, and that
/// idle's outcome. No fork, revert or parent: the copy is a session of its own.
fn fork_payload(read: &Read, name: &str, request: &str) -> Result<Payload> {
    let idle = read.prefix.last().filter(|m| m["type"] == "idle").context("这个 Turn 之后的运行还没有结束；没有 fork")?;
    let info = &read.info;
    let mut sent = json!({
        "id": transfer::session_id(), "projectID": info["projectID"], "title": name,
        "location": {"directory": read.folder}, "metadata": {"yuzuno": {"fork": request}},
        "cost": 0, "tokens": transfer::no_tokens(),
        "time": {"created": info["time"]["created"], "updated": idle["time"]["created"], "idle": idle["time"]["created"]},
        "outcome": idle["outcome"], "permissions": info["permissions"],
    });
    for (field, kind) in [("agent", "agent-switched"), ("model", "model-switched")] {
        sent[field] = transfer::selected(&read.prefix, kind, field, &info[field]);
    }
    transfer::without_nulls(&mut sent);
    ensure!(sent["time"]["created"].is_number(), "OpenCode 会话没有说它何时开始；没有 fork");
    Ok(Payload { info: sent, messages: read.prefix.clone(), directory: read.folder.clone() })
}

/// The pasted images the copied messages show, each the new Agent's own
/// copy: the web reads one through its owner's route, and the source may go.
struct Images {
    root: PathBuf,
    from: String,
    to: String,
    files: Vec<String>,
}

impl check::ImagePaths for Images {
    /// The new Agent's path for an image of the source's; refused for any
    /// other (none is carried as it is).
    fn path(&mut self, path: &str) -> Result<String> {
        let path = std::path::Path::new(path);
        let id = path.file_name().and_then(|n| n.to_str()).context("图片路径无法读取；没有 fork")?;
        let own = crate::input_images::image_path(&self.root, &self.from, id)?;
        ensure!(own == path, "图片不是原 Agent 保存的；没有 fork");
        self.files.push(id.to_owned());
        Ok(crate::input_images::image_path(&self.root, &self.to, id)?.to_string_lossy().into_owned())
    }
}

impl Images {
    /// Each image, and what is kept beside it (its thumbnail, the copy fitted
    /// for OpenCode), copied into the new Agent's folder. Blocking.
    fn copy(self) -> Result<()> {
        if self.files.is_empty() {
            return Ok(());
        }
        let (from, to) = (self.root.join("input-images").join(&self.from), self.root.join("input-images").join(&self.to));
        std::fs::create_dir_all(&to)?;
        for id in &self.files {
            let hash = id.split('.').next().unwrap_or_default();
            for entry in std::fs::read_dir(&from)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == *id || name.starts_with(&format!("{hash}.")) {
                    ensure!(entry.file_type()?.is_file(), "图片 {name} 不是文件；没有 fork");
                    std::fs::copy(entry.path(), to.join(&name)).with_context(|| format!("没能复制图片 {name}；没有 fork"))?;
                }
            }
        }
        Ok(())
    }
}


fn outcome(row: &Row, state: &str, message: String) -> Value {
    json!({"state":state,"requestId":row.request_id,"message":message,"warnings":[]})
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn read_private<T: serde::de::DeserializeOwned>(path: &std::path::Path) -> Result<T> {
    Ok(serde_json::from_slice(&std::fs::read(path).with_context(|| format!("读不到 fork 记下的 {}", path.display()))?)?)
}

/// Contract 8 has no web view yet: the routes.
pub(crate) fn router() -> axum::Router<Arc<Workspace>> {
    use axum::{extract::{Path, Query, State}, routing::post, Json};
    async fn preview(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(p): Json<Target>) -> Result<Json<Value>, crate::server::ApiError> {
        Ok(Json(ws.opencode_fork_preview(&id, &p.turn_id).await?))
    }
    async fn fork(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(p): Json<Request>) -> Result<Json<Value>, crate::server::ApiError> {
        Ok(Json(ws.opencode_fork(&id, p).await?))
    }
    async fn seen(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Query(which): Query<Which>) -> Result<Json<Value>, crate::server::ApiError> {
        Ok(Json(ws.opencode_fork_seen(&id, which).await?))
    }
    axum::Router::new()
        .route("/api/agents/{id}/opencode/fork/preview", post(preview))
        .route("/api/agents/{id}/opencode/fork", post(fork).get(seen))
}

/// The table as 1.19.3's fork made it: `fork_session` is the copy's session
/// now, `prefix_sha` the digest of the copy, `chain_sha` only 1.19.3's.
pub(crate) fn migrate(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch(&format!("CREATE TABLE IF NOT EXISTS opencode_forks(
        request_id TEXT PRIMARY KEY, source_agent_id TEXT NOT NULL, through_turn_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, state TEXT NOT NULL, fork_session TEXT, error TEXT,
        prefix_sha TEXT NOT NULL, chain_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS opencode_forks_one_live ON opencode_forks(source_agent_id,through_turn_id)
        WHERE state IN {LIVE};"))?;
    Ok(())
}

const COLUMNS: &str = "request_id,source_agent_id,through_turn_id,target_agent_id,name,state,fork_session,error,prefix_sha";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        request_id: r.get(0)?, source_agent_id: r.get(1)?, through_turn_id: r.get(2)?, target_agent_id: r.get(3)?,
        name: r.get(4)?, state: r.get(5)?, fork_session: r.get(6)?, error: r.get(7)?, prefix_sha: r.get(8)?,
    })
}

impl crate::store::Store {
    fn opencode_fork_row(&self, request: &str) -> Result<Option<Row>> {
        use rusqlite::OptionalExtension;
        Ok(self.db.read()?.query_row(&format!("SELECT {COLUMNS} FROM opencode_forks WHERE request_id=?1"), [request], row).optional()?)
    }
    fn opencode_live_fork(&self, source: &str, turn: &str) -> Result<Option<Row>> {
        use rusqlite::OptionalExtension;
        Ok(self.db.read()?.query_row(&format!("SELECT {COLUMNS} FROM opencode_forks WHERE source_agent_id=?1 AND through_turn_id=?2
            AND state IN {LIVE}"), [source, turn], row).optional()?)
    }
    fn opencode_begin_fork(&self, row: &Row) -> Result<()> {
        let at = now();
        self.db.write()?.execute(&format!("INSERT INTO opencode_forks({COLUMNS},chain_sha,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'sending',?6,NULL,?7,NULL,?8,?8)"),
            rusqlite::params![row.request_id, row.source_agent_id, row.through_turn_id, row.target_agent_id, row.name, row.fork_session, row.prefix_sha, at])?;
        Ok(())
    }
    fn opencode_set_fork(&self, request: &str, state: &str, session: Option<&str>, error: Option<&str>) -> Result<()> {
        self.db.write()?.execute("UPDATE opencode_forks SET state=?2, fork_session=COALESCE(?3,fork_session), error=?4, updated_at=?5 WHERE request_id=?1",
            rusqlite::params![request, state, session, error, now()])?;
        Ok(())
    }
    /// Registers a verified fork in one transaction: the Agent with its
    /// Turns, its Project membership when still assignable, a record of where
    /// it came from on both Agents, and the completed attempt. Whether the
    /// Project was kept.
    fn opencode_insert_fork(&self, detail: &AgentDetail, project: Option<&str>, request: &str, source: &str) -> Result<(crate::model::Agent, bool)> {
        let rows = crate::record_rows::split(detail)?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let current: String = tx.query_row("SELECT state FROM opencode_forks WHERE request_id=?1", [request], |r| r.get(0))?;
        ensure!(current == "verified", "fork 已不在等待登记；没有登记第二次");
        crate::record_rows::insert(&tx, &detail.agent.id, &rows)?;
        let kept = match project {
            Some(project) if !crate::projects::is_archived(&tx, project)? => {
                crate::projects::set_agent_project_in(&tx, &detail.agent.id, Some(project))?;
                // The user's fork leads the source's Project, even when the
                // source is an executor: the fork is a standing Agent (YN-2 S4).
                crate::agent_roles::user_added(&tx, &detail.agent.id, project)?;
                true
            }
            _ => false,
        };
        let session = detail.agent.opencode_session_id.clone().unwrap_or_default();
        tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'opencode/forked',?2,?3)",
            rusqlite::params![detail.agent.id, json!({"sessionId":session,"forkedFrom":source,"requestId":request,"historicalTurns":detail.turns.len()}).to_string(), now()])?;
        tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'opencode/forkedTo',?2,?3)",
            rusqlite::params![source, json!({"agentId":detail.agent.id,"sessionId":session,"requestId":request}).to_string(), now()])?;
        tx.execute("UPDATE opencode_forks SET state='completed', error=NULL, updated_at=?2 WHERE request_id=?1", rusqlite::params![request, now()])?;
        tx.commit()?;
        let mut agent = detail.agent.clone();
        if kept {
            agent.project_id = project.map(str::to_owned);
        }
        Ok((agent, kept))
    }
}

#[cfg(test)]
#[path = "opencode_fork_tests.rs"]
mod tests;
