//! Forking an OpenCode Agent into a new one (T-10 Fork; contract on T-10
//! #3527, Lead 3525). The new Agent works in the same folder, with its own
//! OpenCode process and database, and holds the conversation through one of
//! the source's completed Turns. The source Agent and its session are never
//! changed.
//!
//! OpenCode forks the session in the source's own database (`POST
//! /session/:id/fork`): a new session there, with every message before the
//! next Turn's start copied under new IDs. Core then reads that session's own
//! durable events (`/sync/history`), checks they are exactly that copy,
//! starts the new Agent's OpenCode once on an empty database, replays them
//! there (`/sync/replay`), reads it all back, and only then registers the new
//! Agent and attaches it to that same process. The copy left in the source's
//! database is not deleted, and nothing shows it.
//!
//! One request, kept in `opencode_forks` from before it is asked, is never
//! asked again: an answer that never came leaves it uncertain, and no fork
//! is asked anew from that Turn (Lead 4195), by this request or another.
//! That uncertainty is the attempt's alone: the source Agent goes on.
//! Everything after the answer is checked or replayed again from what was
//! fixed, never forked again and never registered twice.
use super::*;
use crate::opencode::ForkAnswer;
use crate::opencode_fork_check as check;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// How long the source's gate waits for the fork's answer before it lets
/// the source go on; the request goes on, and an answer after that still
/// settles the attempt. (Shorter in tests.)
const WATCH: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 120 });
/// At most this much of the source is fixed for one fork.
const FROZEN_LIMIT: usize = 64 << 20;
/// States an attempt holds its boundary in: one live attempt per Turn.
const LIVE: &str = "('sending','uncertain','forked','verified','chained','completed')";

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
pub(crate) struct Request {
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
    fork_session: Option<String>,
    error: Option<String>,
    /// Digests of what it fixed: the messages the fork must copy, and the
    /// fork's own events once read (Lead 3529). What is read back must match.
    prefix_sha: String,
    chain_sha: Option<String>,
}

/// What an attempt fixed before it asked: what the fork must copy, and what
/// the new Agent is made from.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frozen {
    session: String,
    cwd: String,
    cutoff: Option<String>,
    messages: Vec<Value>,
    turns: Vec<Value>,
    agent: Value,
    path: Value,
    project: String,
}

/// The fork as verified in the source's database.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Verified {
    info: Value,
    messages: Vec<Value>,
    ids: check::Ids,
}

/// A source read under its gate, for a fork through one Turn.
struct Read {
    session: String,
    generation: u64,
    detail: AgentDetail,
    cutoff: Option<String>,
    messages: Vec<Value>,
    path: Value,
    project: String,
    kept: usize,
    later: usize,
}

impl Workspace {
    /// What a fork through `turn` would keep, read without a write (contract
    /// 1): refused, saying why, unless one could start now.
    pub(crate) async fn opencode_fork_preview(self: &Arc<Self>, id: &str, turn: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let read = self.opencode_fork_read(id, turn).await?;
        Ok(json!({
            "turnId": turn, "keptTurns": read.kept, "laterTurns": read.later, "messages": read.messages.len(),
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
            "sending" | "uncertain" => outcome(&row, "uncertain", row.error.clone().unwrap_or_else(||
                "OpenCode 还没有回答这次 fork；结果确认之前不会再请求一次，原 Agent 照常可用".into())),
            "failed" | "released" => outcome(&row, "failed", row.error.clone().unwrap_or_else(|| "fork 没有完成".into())),
            "completed" => match self.listed(&row.target_agent_id).await {
                Ok(agent) => json!({"state":"completed","requestId":row.request_id,"connected":agent.connection_state == "connected","agent":agent,"warnings":[]}),
                Err(_) => outcome(&row, "failed", "fork 出的 Agent 已删除".into()),
            },
            _ => outcome(&row, "pending", row.error.clone().map(|e| format!("{e}。")).unwrap_or_default()
                + "这次 fork 还没有登记完；继续会接着核对和重放同一份记录，不会重新 fork"),
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
        let session = c.server.session(&c.session).await.context(unread)?;
        ensure!(session["revert"].is_null(), "OpenCode 会话里有一次尚未处理的回退；没有 fork");
        ensure!(session["workspaceID"].as_str().unwrap_or_default().is_empty(), "OpenCode 会话属于一个 OpenCode workspace，fork 还不支持；没有 fork");
        for name in ["permission", "agent", "model"] {
            ensure!(session[name].is_null() || session[name] == json!([]),
                "OpenCode 会话设有自己的 {name}，fork 无法照样带到新会话；没有 fork");
        }
        ensure!(c.server.session_status(&c.session).await.context(unread)?["type"] == "idle", "OpenCode 会话不是空闲状态；没有 fork");
        let listed = c.server.messages(&c.session).await.context(unread)?;
        let list = listed.as_array().context(unread)?.clone();
        let path = c.server.path().await.context(unread)?;
        ensure!(path["directory"] == detail.agent.cwd.as_str(), "OpenCode 的工作目录不是这个 Agent 的目录；没有 fork");
        let project = c.server.project().await.context(unread)?["id"].as_str().context("OpenCode 没有说它的项目；没有 fork")?.to_owned();
        ensure!(session["projectID"] == project.as_str(), "OpenCode 会话不属于它现在的项目；没有 fork");
        let (cutoff, end) = check::boundary(&detail.turns, &list, turn)?;
        let index = detail.turns.iter().position(|t| t["id"] == turn).unwrap_or_default();
        ensure!(self.opencode_current(id, c.generation).is_some(), "OpenCode 连接已变化；没有 fork");
        Ok(Read {
            session: c.session.clone(), generation: c.generation, kept: index + 1, later: detail.turns.len() - index - 1,
            detail, cutoff, messages: list[..end].to_vec(), path, project,
        })
    }

    /// One fork, as `request` asks (see the module). In a task of its own:
    /// a client that goes away drops only its wait for the outcome. Asked
    /// again with the same request, it goes on from where that attempt is,
    /// and never asks OpenCode again.
    pub(crate) async fn opencode_fork(self: &Arc<Self>, id: &str, request: Request) -> Result<Value> {
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
        loop {
            match row.state.as_str() {
                "sending" | "uncertain" => return Ok(outcome(&row, "uncertain", row.error.clone().unwrap_or_else(||
                    "OpenCode 没有回答这次 fork；结果确认之前不会再请求一次，原 Agent 照常可用".into()))),
                "failed" | "released" => return Ok(outcome(&row, "failed", row.error.clone().unwrap_or_else(|| "fork 没有完成".into()))),
                "forked" => self.opencode_fork_verify(&mut row).await?,
                "verified" => self.opencode_fork_chain(&mut row).await?,
                "chained" => self.opencode_fork_target(&mut row, &mut warnings).await?,
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
    /// request asks; otherwise the source is read, what it holds is fixed and
    /// kept, and OpenCode is asked once, watched for WATCH.
    async fn opencode_fork_begin(self: &Arc<Self>, id: &str, request: &Request) -> Result<Row> {
        let gate = self.gate(id).await;
        let held = gate.lock().await;
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
        let frozen = Frozen {
            session: read.session.clone(), cwd: read.detail.agent.cwd.clone(), cutoff: read.cutoff.clone(),
            messages: read.messages.clone(), turns: read.detail.turns[..=index].to_vec(),
            agent: serde_json::to_value(&read.detail.agent)?, path: read.path.clone(), project: read.project.clone(),
        };
        let bytes = serde_json::to_vec(&frozen)?;
        ensure!(bytes.len() <= FROZEN_LIMIT, "要 fork 的内容超过 {} MiB；没有 fork", FROZEN_LIMIT >> 20);
        let row = Row {
            request_id: request.request_id.clone(), source_agent_id: id.into(), through_turn_id: request.turn_id.clone(),
            target_agent_id: uuid::Uuid::new_v4().to_string(), name: request.name.clone(), state: "sending".into(),
            fork_session: None, error: None, prefix_sha: check::digest(&json!(frozen.messages))?, chain_sha: None,
        };
        let folder = self.opencode_fork_folder(&row.request_id)?;
        write_private(&folder.join("frozen.json"), &bytes)?;
        self.opencode_fork_reserve(&row)?;
        let c = self.opencode_current(id, read.generation).context("OpenCode 连接已变化；没有 fork")?;
        // Made now, sent only below: nothing past the kept attempt is refused before it is asked.
        let fork = c.server.fork(&read.session, read.cutoff.as_deref())?;
        let kept = row.clone();
        self.stored(move |s| s.opencode_begin_fork(&kept)).await?;
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let (owner, key) = (Arc::downgrade(self), row.request_id.clone());
        tokio::spawn(async move {
            let answer = fork.await;
            if let Err(answer) = tx.send(answer) {
                if let Some(ws) = owner.upgrade() {
                    if let Err(error) = ws.opencode_fork_answered(&key, answer, true).await {
                        eprintln!("Workspace OpenCode fork {key} answered late, not recorded: {error:#}");
                    }
                }
            }
        });
        let answered = match tokio::time::timeout(WATCH, &mut rx).await {
            Ok(answer) => answer.ok(),
            Err(_) => {
                rx.close();
                rx.try_recv().ok()
            }
        };
        match answered {
            Some(answer) => self.opencode_fork_answered(&row.request_id, answer, false).await?,
            None => {
                let key = row.request_id.clone();
                let message = format!("OpenCode 在 {} 秒内没有回答这次 fork；结果确认之前不会再请求一次，原 Agent 照常可用", WATCH.as_secs());
                self.stored(move |s| s.opencode_settle_fork(&key, &["sending"], "uncertain", None, Some(&message))).await?;
            }
        }
        // The fork only read the source's session: it goes on now.
        drop(held);
        let key = row.request_id.clone();
        self.stored(move |s| s.opencode_fork_row(&key)).await?.context("fork 记录不见了")
    }

    /// The fork's own answer settles its attempt (contract 3): a 200 with a
    /// new session in this folder and no workspace is a fork; one that is not
    /// is a failed one, its session kept; anything else leaves it uncertain.
    /// `late`: after the watch, when only an attempt still unconfirmed is
    /// settled, and only against what it fixed.
    async fn opencode_fork_answered(self: &Arc<Self>, key: &str, answer: ForkAnswer, late: bool) -> Result<()> {
        let from: &[&str] = if late { &["sending", "uncertain"] } else { &["sending"] };
        let (state, session, message) = match answer {
            ForkAnswer::Answered(session) => {
                let id = session["id"].as_str().unwrap_or_default().to_owned();
                let frozen = self.opencode_fork_frozen(key)?;
                if id.is_empty() || id == frozen.session {
                    ("failed", None, Some(format!("OpenCode 的回答不是一个新的会话：{}", session["id"])))
                } else if session["directory"] != frozen.cwd.as_str() || !session["workspaceID"].as_str().unwrap_or_default().is_empty() {
                    ("failed", Some(id), Some("OpenCode fork 出的会话不在这个目录或属于一个 workspace；它留在原 Agent 的 OpenCode 里，没有登记".to_owned()))
                } else {
                    ("forked", Some(id), None)
                }
            }
            ForkAnswer::Unknown(why) => ("uncertain", None, Some(format!("这次 fork 的结果无法确认（{why}）；结果确认之前不会再请求一次，原 Agent 照常可用"))),
        };
        let key = key.to_owned();
        let from: Vec<String> = from.iter().map(|s| s.to_string()).collect();
        self.stored(move |s| {
            let from: Vec<&str> = from.iter().map(String::as_str).collect();
            s.opencode_settle_fork(&key, &from, state, session.as_deref(), message.as_deref())
        }).await
    }

    /// Contract 4: the fork as OpenCode holds it in the source's database,
    /// paired with what was fixed. A failed read proves nothing: it stays
    /// forked, and is read again next time.
    async fn opencode_fork_verify(self: &Arc<Self>, row: &mut Row) -> Result<()> {
        let frozen = self.opencode_fork_fixed(row)?;
        let session = row.fork_session.clone().context("fork 记录缺少会话")?;
        let c = self.opencodes.lock().unwrap().get(&row.source_agent_id).cloned()
            .context("原 Agent 的 OpenCode 未连接；连接后重试，会再次核对这个 fork，不会重新 fork")?;
        let info = c.server.session(&session).await.context("暂时读不到 fork 出的会话；重试会再次核对它")?;
        let messages = c.server.messages(&session).await.context("暂时读不到 fork 出的会话；重试会再次核对它")?
            .as_array().cloned().unwrap_or_default();
        let checked = (|| -> Result<check::Ids> {
            ensure!(info["id"] == session.as_str() && info["directory"] == frozen.cwd.as_str() && info["parentID"].is_null(),
                "fork 出的会话不是一个独立的同目录会话；没有登记");
            ensure!(info["workspaceID"].as_str().unwrap_or_default().is_empty(), "fork 出的会话属于一个 workspace；没有登记");
            check::pair(&frozen.messages, &messages, &session)
        })();
        match checked {
            Ok(ids) => {
                let verified = Verified { info, messages, ids };
                write_private(&self.opencode_fork_folder(&row.request_id)?.join("verified.json"), &serde_json::to_vec(&verified)?)?;
                self.opencode_fork_state(row, "verified", None).await
            }
            Err(error) => self.opencode_fork_state(row, "failed", Some(format!("{error:#}。原 Agent 未改变；这个 fork 留在原 Agent 的 OpenCode 里"))).await,
        }
    }

    /// Contract 5: the fork's own durable events, fixed.
    async fn opencode_fork_chain(self: &Arc<Self>, row: &mut Row) -> Result<()> {
        let verified: Verified = read_private(&self.opencode_fork_folder(&row.request_id)?.join("verified.json"))?;
        let session = row.fork_session.clone().context("fork 记录缺少会话")?;
        let c = self.opencodes.lock().unwrap().get(&row.source_agent_id).cloned()
            .context("原 Agent 的 OpenCode 未连接；连接后重试，会再次读取这个 fork，不会重新 fork")?;
        let (source, fork) = (row.source_agent_id.clone(), session.clone());
        let mut others: Vec<String> = self.stored(move |s| s.opencode_fork_sessions(&source)).await?;
        others.push(c.session.clone());
        others.extend(c.known_children());
        // Never this fork's own: an earlier attempt's list may hold it, and
        // leaving it out would read as a fork with no events.
        others.retain(|s| *s != fork);
        let events = c.server.history_of(&session, &check::known(others)).await?;
        match check::chain(&events, &session, &verified.info, &verified.messages) {
            Ok(chain) => {
                let sha = check::digest(&json!(chain))?;
                write_private(&self.opencode_fork_folder(&row.request_id)?.join("chain.json"), &serde_json::to_vec(&chain)?)?;
                let (key, kept) = (row.request_id.clone(), sha.clone());
                self.stored(move |s| s.opencode_fork_chained(&key, &kept)).await?;
                row.chain_sha = Some(sha);
                self.opencode_fork_state(row, "chained", None).await
            }
            Err(error) => self.opencode_fork_state(row, "failed", Some(format!("{error:#}。原 Agent 未改变"))).await,
        }
    }

    /// Contract 6: the new Agent's OpenCode started once, on its own empty
    /// database in the same folder; the fixed events replayed and read back
    /// whole; then the Agent registered and attached to that same process.
    /// A failed start, replay or read leaves it chained: the same events are
    /// replayed again next time, into the same Agent.
    async fn opencode_fork_target(self: &Arc<Self>, row: &mut Row, warnings: &mut Vec<String>) -> Result<()> {
        let folder = self.opencode_fork_folder(&row.request_id)?;
        let frozen = self.opencode_fork_fixed(row)?;
        let verified: Verified = read_private(&folder.join("verified.json"))?;
        let chain: Vec<Value> = read_private(&folder.join("chain.json"))?;
        ensure!(row.chain_sha.as_deref() == Some(check::digest(&json!(chain))?.as_str()), "fork 记下的事件与当时读到的不同；没有登记");
        let session = row.fork_session.clone().context("fork 记录缺少会话")?;
        self.opencode_fork_reserved(row)?;
        let started = self.opencode_start(&row.target_agent_id, &frozen.cwd).await?;
        // What its database holds already: nothing, or what an earlier
        // attempt of this one replayed of these same events, exactly.
        let held = started.server.history(&serde_json::Map::new()).await
            .context("读不到新 Agent 的 OpenCode 现有的记录；重试会再次核对，不会重新 fork")?;
        let ours = held.len() <= chain.len() && held.iter().zip(&chain).all(|(h, c)| h["aggregate_id"] == session.as_str()
            && h["id"] == c["id"] && h["seq"] == c["seq"] && h["type"] == c["type"] && h["data"] == c["data"]);
        if !ours {
            return self.opencode_fork_state(row, "failed", Some(
                "新 Agent 的 OpenCode 数据库里有不是这次 fork 的记录；没有覆盖，也没有登记".into())).await;
        }
        let path = started.server.path().await?;
        let project = started.server.project().await?["id"].as_str().unwrap_or_default().to_owned();
        if let Err(error) = check::same_place(&(frozen.path.clone(), frozen.project.clone()), &(path, project)) {
            return self.opencode_fork_state(row, "failed", Some(format!("{error:#}"))).await;
        }
        let replayed = started.server.replay(&chain).await;
        let info = started.server.session(&session).await;
        let messages = started.server.messages(&session).await;
        // As the fork reads in the source's own database once it was made
        // (its cost and tokens summed from its parts by OpenCode's own
        // projection): the session and every message and part, whole.
        let same = match (&info, &messages) {
            (Ok(info), Ok(messages)) => *info == verified.info && messages.as_array() == Some(&verified.messages),
            _ => false,
        };
        if !same {
            let why = match replayed {
                Err(error) => format!("{error:#}"),
                Ok(_) => "重放后读到的会话与 fork 不同".into(),
            };
            bail!("新 Agent 的 OpenCode 还没有完整的 fork（{why}）；重试会把同一份记录重放到同一个新 Agent，不会重新 fork");
        }
        let root = self.data_dir.canonicalize().unwrap_or_else(|_| self.data_dir.clone());
        let mut images = Images { root, from: row.source_agent_id.clone(), to: row.target_agent_id.clone(), files: Vec::new() };
        let turns = remap(&frozen.turns, &verified.ids, &session, &mut images)?;
        tokio::task::spawn_blocking(move || images.copy()).await??;
        let detail = self.opencode_fork_detail(row, &frozen, &session, turns, started.server.version())?;
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
        // Attached to the very process the fork was replayed into. A failed
        // attach leaves the registered Agent offline; nothing is retried here.
        if let Err(error) = self.opencode_ensure_on(&agent.id, Some(started)).await {
            warnings.push(format!("fork 已登记，但连接失败：{error}"));
        }
        Ok(())
    }

    fn opencode_fork_detail(&self, row: &Row, frozen: &Frozen, session: &str, turns: Vec<Value>, version: &str) -> Result<AgentDetail> {
        let source: crate::model::Agent = serde_json::from_value(frozen.agent.clone())?;
        let at = now();
        Ok(AgentDetail {
            agent: crate::model::Agent {
                id: row.target_agent_id.clone(), name: row.name.clone(), goal: String::new(), work_summary: None, project_id: None, kind: None,
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

    fn opencode_fork_frozen(&self, request: &str) -> Result<Frozen> {
        read_private(&self.opencode_fork_folder(request)?.join("frozen.json"))
    }

    /// What the attempt fixed, as it fixed it: its digest the kept one.
    fn opencode_fork_fixed(&self, row: &Row) -> Result<Frozen> {
        let frozen = self.opencode_fork_frozen(&row.request_id)?;
        ensure!(check::digest(&json!(frozen.messages))? == row.prefix_sha, "fork 记下的内容与当时不同；没有登记");
        Ok(frozen)
    }

    /// The new Agent's folder, taken for this attempt alone before anything
    /// is asked (Lead 3529): made new, with the attempt it is for.
    fn opencode_fork_reserve(&self, row: &Row) -> Result<()> {
        let folder = self.data_dir.join("opencode").join(&row.target_agent_id);
        std::fs::create_dir_all(folder.parent().context("没有 OpenCode 的数据目录")?)?;
        std::fs::create_dir(&folder).context("新 Agent 的目录已经存在；没有 fork")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut marker = options.open(folder.join("fork.json"))?;
        marker.write_all(&serde_json::to_vec(&json!({"requestId": row.request_id, "sourceAgentId": row.source_agent_id,
            "database": folder.join("opencode.db")}))?)?;
        marker.sync_all()?;
        Ok(())
    }

    /// The new Agent's folder is still this attempt's, as reserved.
    fn opencode_fork_reserved(&self, row: &Row) -> Result<()> {
        let marker: Value = read_private(&self.data_dir.join("opencode").join(&row.target_agent_id).join("fork.json"))?;
        ensure!(marker["requestId"] == row.request_id.as_str() && marker["sourceAgentId"] == row.source_agent_id.as_str(),
            "新 Agent 的目录不是为这次 fork 预留的；没有登记");
        Ok(())
    }
}

/// The pasted images the copied messages show, each the new Agent's own
/// copy: the web reads one through its owner's route, and the source may go.
struct Images {
    root: PathBuf,
    from: String,
    to: String,
    files: Vec<String>,
}

impl Images {
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

/// The source's Turns through the fork's, as the new Agent holds them
/// (contract 8): every native ID they hold is its copy's, by the verified
/// map; what bound them to the source's own run is left behind. A field this
/// does not know refuses the fork rather than being carried.
fn remap(turns: &[Value], ids: &check::Ids, session: &str, images: &mut Images) -> Result<Vec<Value>> {
    let id = |old: &str| -> Result<String> {
        ids.get(old).cloned().with_context(|| format!("fork 里没有 {old} 的副本；没有登记"))
    };
    let mut kept = Vec::new();
    for turn in turns {
        let object = turn.as_object().context("Turn 记录无法读取")?;
        let mut copy = serde_json::Map::new();
        let compact = object.contains_key("_opencodeCompact");
        for (name, value) in object {
            let value = match name.as_str() {
                "id" if compact => value.clone(),
                "id" => json!(id(value.as_str().context("Turn 没有 ID")?)?),
                "items" => {
                    let mut items = Vec::new();
                    for item in value.as_array().into_iter().flatten() {
                        items.push(remap_item(item, &id, images)?);
                    }
                    Value::Array(items)
                }
                "_opencodeInputs" => {
                    let mut inputs = serde_json::Map::new();
                    for (input, state) in value.as_object().into_iter().flatten() {
                        let mut state = state.clone();
                        // A way back for an input still being sent, and its sender's ID: the source's run.
                        if let Some(object) = state.as_object_mut() {
                            object.remove("previous");
                            object.remove("clientMessageId");
                            object.remove("deliveryUnconfirmed");
                        }
                        inputs.insert(id(input)?, state);
                    }
                    Value::Object(inputs)
                }
                "_opencodeLastInput" | "_opencodeFollowed" => json!(id(value.as_str().context("Turn 的消息 ID 无法读取")?)?),
                "_opencodeAnswers" => {
                    let mut answers = serde_json::Map::new();
                    for (answer, state) in value.as_object().into_iter().flatten() {
                        let mut state = state.clone();
                        if let Some(parent) = state["parent"].as_str() {
                            state["parent"] = json!(id(parent)?);
                        }
                        answers.insert(id(answer)?, state);
                    }
                    Value::Object(answers)
                }
                "_opencodeCompact" => remap_compact(value, &id, session)?,
                // As they were: what the Turn was, not what bound it to the source's run.
                "status" | "error" | "_opencodeConfirmed" | "_opencodeSessionError" | "_yuzunoStartedAt" | "_yuzunoCompletedAt"
                | "_yuzunoDurationMs" | "_yuzunoCompactionStartedAt" | "itemsView" => value.clone(),
                "_yuzunoCompactionId" => json!(format!("{}:compaction", object["id"].as_str().unwrap_or_default())),
                // The source's own run: not the new Agent's.
                "interruptRequested" | "deliveryUnconfirmed" => continue,
                other => bail!("Turn {} 里有 fork 还不能带过去的记录 {other}；没有 fork", object["id"]),
            };
            copy.insert(name.clone(), value);
        }
        kept.push(Value::Object(copy));
    }
    Ok(kept)
}

fn remap_item(item: &Value, id: &impl Fn(&str) -> Result<String>, images: &mut Images) -> Result<Value> {
    let object = item.as_object().context("Turn 的内容无法读取")?;
    let mut copy = serde_json::Map::new();
    for (name, value) in object {
        let value = match name.as_str() {
            "id" => {
                let old = value.as_str().context("内容没有 ID")?;
                match old.strip_suffix(":input") {
                    Some(message) => json!(format!("{}:input", id(message)?)),
                    None if object["type"] == "contextCompaction" => value.clone(),
                    None => json!(id(old)?),
                }
            }
            "nativeMessageId" => json!(id(value.as_str().context("内容的消息 ID 无法读取")?)?),
            "clientId" | "deliveryUnconfirmed" => continue,
            "content" => {
                let mut content = value.clone();
                for part in content.as_array_mut().into_iter().flatten() {
                    if part["type"] == "localImage" {
                        part["path"] = json!(images.path(part["path"].as_str().context("图片路径无法读取；没有 fork")?)?);
                    }
                }
                content
            }
            "type" | "text" | "summary" | "name" | "callId" | "input" | "output" | "status" | "trigger"
            | "_yuzunoTime" | "_yuzunoCompletedText" | "_yuzunoTextBlocks" | "_yuzunoInputText" => value.clone(),
            other => bail!("Turn 内容里有 fork 还不能带过去的记录 {other}；没有 fork"),
        };
        copy.insert(name.clone(), value);
    }
    Ok(Value::Object(copy))
}

fn remap_compact(value: &Value, id: &impl Fn(&str) -> Result<String>, session: &str) -> Result<Value> {
    let object = value.as_object().context("压缩记录无法读取")?;
    let mut copy = serde_json::Map::new();
    for (name, value) in object {
        let value = match name.as_str() {
            "message" | "part" => json!(id(value.as_str().context("压缩记录的 ID 无法读取")?)?),
            "session" => json!(session),
            "summary" => {
                let mut summary = value.clone();
                if let Some(answer) = value["id"].as_str() {
                    summary["id"] = json!(id(answer)?);
                }
                summary
            }
            "text" => {
                let mut text = serde_json::Map::new();
                for (part, body) in value.as_object().into_iter().flatten() {
                    text.insert(id(part)?, body.clone());
                }
                Value::Object(text)
            }
            // What it looked at: in the fork, only what it copied.
            "candidates" => {
                let mut candidates = serde_json::Map::new();
                for (message, state) in value.as_object().into_iter().flatten() {
                    let Ok(message) = id(message) else { continue };
                    let mut state = state.clone();
                    if let Some(part) = state["part"].as_str() {
                        match id(part) {
                            Ok(part) => state["part"] = json!(part),
                            Err(_) => { state.as_object_mut().map(|o| o.remove("part")); }
                        }
                    }
                    candidates.insert(message, state);
                }
                Value::Object(candidates)
            }
            // Compaction messages from before it began: in the fork, only those it copied.
            "known" => Value::Array(value.as_array().into_iter().flatten().filter_map(|k| k.as_str().and_then(|k| id(k).ok())).map(Value::from).collect()),
            "state" | "providerID" | "modelID" | "auto" => value.clone(),
            // The source's own run.
            "generation" | "answer" | "nativePending" | "abandonRequested" | "abandonedAt" => continue,
            other => bail!("压缩记录里有 fork 还不能带过去的记录 {other}；没有 fork"),
        };
        copy.insert(name.clone(), value);
    }
    Ok(Value::Object(copy))
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

pub(crate) fn migrate(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch(&format!("CREATE TABLE IF NOT EXISTS opencode_forks(
        request_id TEXT PRIMARY KEY, source_agent_id TEXT NOT NULL, through_turn_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, state TEXT NOT NULL, fork_session TEXT, error TEXT,
        prefix_sha TEXT NOT NULL, chain_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS opencode_forks_one_live ON opencode_forks(source_agent_id,through_turn_id)
        WHERE state IN {LIVE};"))?;
    Ok(())
}

const COLUMNS: &str = "request_id,source_agent_id,through_turn_id,target_agent_id,name,state,fork_session,error,prefix_sha,chain_sha";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        request_id: r.get(0)?, source_agent_id: r.get(1)?, through_turn_id: r.get(2)?, target_agent_id: r.get(3)?,
        name: r.get(4)?, state: r.get(5)?, fork_session: r.get(6)?, error: r.get(7)?, prefix_sha: r.get(8)?, chain_sha: r.get(9)?,
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
    /// The sessions this Agent's earlier forks made in its database.
    fn opencode_fork_sessions(&self, source: &str) -> Result<Vec<String>> {
        let db = self.db.read()?;
        let mut query = db.prepare("SELECT fork_session FROM opencode_forks WHERE source_agent_id=?1 AND fork_session IS NOT NULL")?;
        let sessions = query.query_map([source], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(sessions)
    }
    fn opencode_begin_fork(&self, row: &Row) -> Result<()> {
        let at = now();
        self.db.write()?.execute(&format!("INSERT INTO opencode_forks({COLUMNS},created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'sending',NULL,NULL,?6,NULL,?7,?7)"),
            rusqlite::params![row.request_id, row.source_agent_id, row.through_turn_id, row.target_agent_id, row.name, row.prefix_sha, at])?;
        Ok(())
    }
    /// The fork's own events, fixed: their digest kept, once.
    fn opencode_fork_chained(&self, request: &str, sha: &str) -> Result<()> {
        self.db.write()?.execute("UPDATE opencode_forks SET chain_sha=?2, updated_at=?3 WHERE request_id=?1 AND (chain_sha IS NULL OR chain_sha=?2)",
            rusqlite::params![request, sha, now()])?;
        Ok(())
    }
    fn opencode_set_fork(&self, request: &str, state: &str, session: Option<&str>, error: Option<&str>) -> Result<()> {
        self.db.write()?.execute("UPDATE opencode_forks SET state=?2, fork_session=COALESCE(?3,fork_session), error=?4, updated_at=?5 WHERE request_id=?1",
            rusqlite::params![request, state, session, error, now()])?;
        Ok(())
    }
    /// Settles an attempt by its answer, only from one of `from`: an answer
    /// after another settled it changes nothing.
    fn opencode_settle_fork(&self, request: &str, from: &[&str], state: &str, session: Option<&str>, error: Option<&str>) -> Result<()> {
        let db = self.db.write()?;
        let current: String = db.query_row("SELECT state FROM opencode_forks WHERE request_id=?1", [request], |r| r.get(0))?;
        if from.contains(&current.as_str()) {
            db.execute("UPDATE opencode_forks SET state=?2, fork_session=COALESCE(?3,fork_session), error=?4, updated_at=?5 WHERE request_id=?1",
                rusqlite::params![request, state, session, error, now()])?;
        }
        Ok(())
    }
    /// Registers a replayed fork in one transaction: the Agent with its
    /// Turns, its Project membership when still assignable, a record of where
    /// it came from on both Agents, and the completed attempt. Whether the
    /// Project was kept.
    fn opencode_insert_fork(&self, detail: &AgentDetail, project: Option<&str>, request: &str, source: &str) -> Result<(crate::model::Agent, bool)> {
        let rows = crate::record_rows::split(detail)?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let current: String = tx.query_row("SELECT state FROM opencode_forks WHERE request_id=?1", [request], |r| r.get(0))?;
        ensure!(current == "chained", "fork 已不在等待登记；没有登记第二次");
        crate::record_rows::insert(&tx, &detail.agent.id, &rows)?;
        let kept = match project {
            Some(project) if !crate::projects::is_archived(&tx, project)? => {
                crate::projects::set_agent_project_in(&tx, &detail.agent.id, Some(project))?;
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
