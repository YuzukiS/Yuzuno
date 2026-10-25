//! Explicit import of a Claude Code session saved on the Core host (T-27).
//!
//! A reader bridge (runtimes/claude/sessions.mjs) lists and previews saved
//! sessions through the SDK's session readers, one bounded page or one chosen
//! session at a time. It starts no query, so no hook runs, no model is called
//! and no session is resumed, forked or written.
//!
//! An import is one request naming the session, the Agent's name, its
//! Project (or none) and the folder the user confirmed. What Claude saved is
//! read into a new Agent bound to that session (`claude_history::plan_import`),
//! left disconnected: the user's first message resumes the session through
//! `claude_ensure`, which adds whatever was saved since, and no earlier
//! prompt is sent again. A session already bound to a local Agent gives that
//! Agent, checked again in the transaction that inserts, so a retry or a
//! concurrent import never makes a second one.
//!
//! Claude Code keeps no lock on a session and reports no owner, so whether
//! another Claude Code is using one is not known and is said to be unknown.
//! Nothing here removes a lock or stops a process.
use crate::{
    claude::Bridge,
    claude_history::{self, Entry},
    model::{now, Agent, AgentDetail},
    server::ApiError,
    store::Store,
    workspace::Workspace,
};
use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::{Query, State as ApiState},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
use tokio::sync::mpsc;

const PAGE: u64 = 20;
const MAX_PAGE: u64 = 50;
const NOT_FOUND: &str = "本机的 Claude Code 中找不到这个会话";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListSessions {
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub limit: Option<u64>,
    /// Also SDK and daemon sessions (Yuzuno's own Agents' among them).
    #[serde(default)]
    pub programmatic: bool,
    /// Only this folder's sessions (and its git worktrees').
    #[serde(default)]
    pub dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewSession {
    pub session_id: String,
}

/// One explicit user action: everything the user confirmed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportSession {
    pub session_id: String,
    pub name: String,
    pub project_id: Option<String>,
    /// The folder the preview showed; the session must still be saved under it.
    pub cwd: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub agent: Agent,
    /// The session was already this Agent's: nothing was read or created.
    pub existing: bool,
    /// Saved messages read, and turns made of them.
    pub saved: usize,
    pub turns: usize,
    /// Saved conversation with no turn to go in (before its first prompt).
    pub left_out: usize,
    /// The saved chain starts at a compaction summary.
    pub compacted: bool,
}

/// A session id as Claude Code names its files: a lowercase hyphenated UUID.
fn native_session(id: &str) -> Result<String> {
    let parsed = uuid::Uuid::try_parse(id.trim()).ok().filter(|_| id.trim().len() == 36);
    Ok(parsed.context("请输入 Claude Code 的会话 ID（UUID）")?.hyphenated().to_string())
}

/// A bridge that starts no query, for reading saved sessions; closed after use.
struct Reader(Arc<Bridge>);

impl Reader {
    async fn open() -> Result<Self> {
        let (tx, mut rx) = mpsc::channel(16);
        let bridge = Bridge::spawn(tx).await?;
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        Ok(Self(bridge))
    }

    /// One request, then the reader closes whatever came of it.
    async fn once(self, command: Value) -> Result<Value> {
        let result = self.0.request(command).await;
        let closed = self.0.close_and_wait().await;
        let value = result?;
        closed?;
        Ok(value)
    }
}

impl Workspace {
    /// One read of saved native history at a time, shared with Codex imports:
    /// it bounds subprocesses and memory.
    async fn session_read(&self) -> Result<tokio::sync::SemaphorePermit<'_>> {
        tokio::time::timeout(Duration::from_secs(20), self.session_reads.acquire())
            .await
            .map_err(|_| anyhow!("正在读取另一份原生历史，请稍后重试"))?
            .map_err(|_| anyhow!("原生历史读取已关闭"))
    }

    /// A page of saved sessions, newest first, each with the local Agent it
    /// is already bound to, if any.
    pub async fn claude_sessions(&self, query: ListSessions) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let limit = query.limit.filter(|l| *l > 0).unwrap_or(PAGE).min(MAX_PAGE);
        let mut command = json!({"op":"sessions_list","offset":query.offset,"limit":limit,"programmatic":query.programmatic});
        if let Some(dir) = query.dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            anyhow::ensure!(Path::new(dir).is_absolute(), "请填写绝对路径的文件夹");
            command["dir"] = dir.into();
        }
        let page = {
            let _read = self.session_read().await?;
            Reader::open().await?.once(command).await?
        };
        let mut page = page;
        let ids: Vec<String> = page["sessions"].as_array().into_iter().flatten()
            .filter_map(|s| s["sessionId"].as_str().map(str::to_owned)).collect();
        let bound = self.stored(move |store| store.local_claude_agents(&ids)).await?;
        for session in page["sessions"].as_array_mut().into_iter().flatten() {
            let agent = session["sessionId"].as_str().and_then(|id| bound.get(id)).cloned();
            session["existingAgentId"] = agent.into();
        }
        Ok(page)
    }

    /// What a person needs to recognize one session before importing it.
    pub async fn claude_session_preview(&self, session_id: &str) -> Result<Value> {
        let session = native_session(session_id)?;
        let _permit = self.admission.enter_work()?;
        let mut preview = {
            let _read = self.session_read().await?;
            Reader::open().await?.once(json!({"op":"session_preview","sessionId":session})).await?
        };
        anyhow::ensure!(preview["session"].is_object(), NOT_FOUND);
        let folder = preview["session"]["cwd"].as_str().map(str::to_owned);
        preview["folderExists"] = folder.as_deref().is_some_and(|cwd| Path::new(cwd).is_dir()).into();
        let key = session.clone();
        preview["existingAgentId"] = self.stored(move |store| store.local_claude_agent(&key)).await?.into();
        // Claude Code keeps no lock and reports no owner: never "free".
        preview["occupancy"] = "unknown".into();
        Ok(preview)
    }

    pub async fn claude_session_import(&self, input: ImportSession) -> Result<Imported> {
        let session = native_session(&input.session_id)?;
        let name = input.name.trim().to_owned();
        anyhow::ensure!(!name.is_empty() && name.len() <= 100, "请填写名称（最多 100 字节）");
        let _permit = self.admission.enter_work()?;
        if let Some(project) = input.project_id.clone() {
            self.stored(move |store| store.ensure_project_assignable(&project)).await?;
        }
        let key = session.clone();
        if let Some(agent) = self.stored(move |store| store.local_claude_agent(&key)?
            .map(|id| Ok(store.detail(&id)?.agent)).transpose()).await? {
            return Ok(Imported { agent, existing: true, saved: 0, turns: 0, left_out: 0, compacted: false });
        }
        let confirmed = std::fs::canonicalize(&input.cwd).context("工作目录不存在或无法读取")?;
        let colors = ["yuzu", "sage", "rose", "sky"];
        let count = self.stored(|store| store.agents()).await?.len();
        let mut detail = AgentDetail {
            agent: Agent {
                id: uuid::Uuid::new_v4().to_string(), name, goal: String::new(), work_summary: None, project_id: None,
                cwd: String::new(), model: String::new(), settings: Default::default(), color: colors[count % colors.len()].into(),
                harness: "claude".into(), claude_session_id: Some(session.clone()), opencode_session_id: None, thread_id: None, status: "offline".into(),
                created_at: now(), updated_at: now(), unread_count: 0, pending_count: 0, last_message: None, last_seq: 0,
                reviewed_seq: 0, rev: 0, error: None, remote: None, connection_state: "disconnected".into(), closed_at: None, disconnected_at: None,
            },
            turns: vec![], history: None, pending: vec![], artifacts: vec![], context_usage: None,
            message_receipts: vec![], claude_runtime: None, codex_handoff: None,
        };
        let read = {
            let _read = self.session_read().await?;
            let reader = Reader::open().await?;
            let read = read_saved(&reader.0, &session, &confirmed, &detail).await;
            let closed = reader.0.close_and_wait().await;
            let read = read?;
            closed?;
            read
        };
        let (cwd, entries, messages, plan) = read;
        // As Claude saved it: resuming finds the session by this folder.
        detail.agent.cwd = cwd;
        let (left_out, compacted) = claude_history::import_gaps(&entries, &plan);
        claude_history::apply(&mut detail, &plan, &entries, &messages, Utc::now());
        detail.refresh_snapshot_evidence();
        // Imported, not running: nothing is connected until the user sends.
        detail.agent.status = "offline".into();
        detail.agent.connection_state = "disconnected".into();
        let turns = detail.turns.len();
        let journal = json!({"sessionId":session,"saved":entries.len(),"turns":turns,"leftOut":left_out,"compacted":compacted});
        let project = input.project_id;
        let (agent, created) = self.stored(move |store| store.insert_claude_import(&detail, project.as_deref(), &journal)).await?;
        if created {
            self.changed(&agent.id);
        }
        Ok(Imported { agent, existing: !created, saved: if created { entries.len() } else { 0 },
            turns: if created { turns } else { 0 }, left_out: if created { left_out } else { 0 }, compacted: created && compacted })
    }
}

/// Every saved message's identity and the messages an import shows, read as
/// `claude::claude_backfill` reads them, from the folder Claude saved the
/// session under, which must be the one the user confirmed.
async fn read_saved(reader: &Bridge, session: &str, confirmed: &Path, empty: &AgentDetail)
    -> Result<(String, Vec<Entry>, HashMap<usize, Value>, claude_history::Plan)> {
    let info = reader.request(json!({"op":"session_info","sessionId":session})).await?;
    anyhow::ensure!(info["session"].is_object(), NOT_FOUND);
    let Some(cwd) = info["session"]["cwd"].as_str() else {
        bail!("Claude 没有记录这个会话的工作目录，无法在 Yuzuno 中继续");
    };
    let saved = std::fs::canonicalize(cwd).with_context(|| format!("这个会话的工作目录已不存在：{cwd}"))?;
    anyhow::ensure!(saved.is_dir() && saved == confirmed, "这个会话保存在 {cwd}，与确认的目录不同；请重新预览后确认");
    let read = reader.request(json!({"op":"session_history_read","sessionId":session,"dir":cwd})).await?;
    let read_id = read["readId"].as_str().context("Claude 历史读取没有返回编号")?.to_owned();
    let outcome = async {
        let mut entries: Vec<Entry> = Vec::new();
        let mut from = 0u64;
        loop {
            let page = reader.request(json!({"op":"history_index","readId":read_id,"from":from})).await?;
            entries.extend(serde_json::from_value::<Vec<Entry>>(page["entries"].clone())?);
            match page["next"].as_u64() {
                Some(next) if next > from => from = next,
                _ => break,
            }
        }
        let plan = claude_history::plan_import(empty, &entries);
        let mut wanted: Vec<usize> = plan.steps.iter().filter_map(|s| s.offset()).collect();
        let mut messages = HashMap::new();
        while !wanted.is_empty() {
            let page = reader.request(json!({"op":"history_messages","readId":read_id,"offsets":wanted})).await?;
            let delivered = page["messages"].as_array().cloned().unwrap_or_default();
            anyhow::ensure!(!delivered.is_empty(), "Claude 历史读取没有返回消息");
            for message in delivered {
                if let Some(offset) = message["offset"].as_u64() {
                    messages.insert(offset as usize, message["message"].clone());
                }
            }
            wanted.retain(|offset| !messages.contains_key(offset));
        }
        Ok((cwd.to_owned(), entries, messages, plan))
    }
    .await;
    let _ = reader.request(json!({"op":"history_close","readId":read_id})).await;
    outcome
}

/// The local Claude Agent bound to this native session, if any (closed ones too).
fn bound_agent(db: &Connection, session: &str) -> Result<Option<String>> {
    Ok(db.query_row("SELECT id FROM agents WHERE json_extract(data,'$.agent.claudeSessionId')=?1
        AND json_extract(data,'$.agent.harness')='claude' AND json_extract(data,'$.agent.remote') IS NULL LIMIT 1",
        [session], |r| r.get(0)).optional()?)
}

impl Store {
    pub fn local_claude_agent(&self, session: &str) -> Result<Option<String>> {
        let db = self.db.read()?;
        bound_agent(&db, session)
    }

    fn local_claude_agents(&self, sessions: &[String]) -> Result<HashMap<String, String>> {
        let db = self.db.read()?;
        let mut bound = HashMap::new();
        for session in sessions {
            if let Some(agent) = bound_agent(&db, session)? {
                bound.insert(session.clone(), agent);
            }
        }
        Ok(bound)
    }

    /// Inserts the imported Agent, in its Project, unless the session is
    /// bound by now: then that Agent, and `false`.
    fn insert_claude_import(&self, detail: &AgentDetail, project: Option<&str>, journal: &Value) -> Result<(Agent, bool)> {
        let rows = crate::record_rows::split(detail)?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let session = detail.agent.claude_session_id.as_deref().context("导入缺少原生会话 ID")?;
        if let Some(existing) = bound_agent(&tx, session)? {
            let mut agent = self.brief_in(&tx, &existing)?.context("Agent 不存在")?.agent;
            agent.project_id = crate::projects::agent_project(&tx, &agent.id)?;
            return Ok((agent, false));
        }
        crate::record_rows::insert(&tx, &detail.agent.id, &rows)?;
        if let Some(project) = project {
            crate::projects::set_agent_project_in(&tx, &detail.agent.id, Some(project))?;
        }
        // The saved history is already in the record: no transcript-sized
        // journal entry, no completion or mailbox delivery.
        tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'claude/imported',?2,?3)",
            params![detail.agent.id, journal.to_string(), now()])?;
        tx.commit()?;
        let mut agent = detail.agent.clone();
        agent.project_id = project.map(str::to_owned);
        Ok((agent, true))
    }
}

async fn list(ApiState(ws): ApiState<Arc<Workspace>>, Query(query): Query<ListSessions>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.claude_sessions(query).await?))
}

async fn preview(ApiState(ws): ApiState<Arc<Workspace>>, Json(input): Json<PreviewSession>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.claude_session_preview(&input.session_id).await?))
}

async fn import(ApiState(ws): ApiState<Arc<Workspace>>, Json(input): Json<ImportSession>) -> Result<Json<Imported>, ApiError> {
    Ok(Json(ws.claude_session_import(input).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/claude/sessions", get(list))
        .route("/api/claude/sessions/preview", post(preview))
        .route("/api/claude/sessions/import", post(import))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_id_is_a_uuid_in_claude_codes_own_form() {
        assert_eq!(native_session(" 7F7263B1-4654-49FE-97D9-2DA71F7CDA47 ").unwrap(), "7f7263b1-4654-49fe-97d9-2da71f7cda47");
        for bad in ["", "../etc/passwd", "7f7263b1465449fe97d92da71f7cda47", "urn:uuid:7f7263b1-4654-49fe-97d9-2da71f7cda47"] {
            assert!(native_session(bad).is_err(), "{bad}");
        }
    }
}
