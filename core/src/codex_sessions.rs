//! Explicit, local Codex session adoption. Discovery never attaches a thread or
//! runs a model; its short-lived app-server is closed even on cancellation.
use crate::{
    model::{ensure_agent_open, now, Agent, AgentDetail, AgentSettings, CodexHandoff, ForkLink, HistoryWindow},
    permissions,
    rpc::{Rpc, RpcError},
    store::Store,
    workspace::{permission_config, session_permission_catalog, Workspace},
};
use anyhow::{bail, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};
use tokio::sync::mpsc;

pub const HISTORY_PAGE_SIZE: u64 = 3;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportSession {
    pub thread_id: String,
    pub name: String,
    pub permission_preset: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPreview {
    pub thread_id: String,
    pub name: String,
    pub cwd: String,
    pub preview: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub turn_count: usize,
    pub updated_at: Option<i64>,
    pub existing_agent_id: Option<String>,
    pub warnings: Vec<String>,
    pub permissions: Value,
}

/// One explicit user action. The request ID makes retries and double clicks
/// return that same attempt instead of forking or registering again.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkSession {
    pub request_id: String,
    /// The completed Turn the user saw as the boundary in the preview.
    pub through_turn_id: String,
    pub name: String,
    /// Explicit choice after an unconfirmed attempt: give it up and fork
    /// again. That attempt may have left an unused native session.
    #[serde(default)]
    pub abandon_unconfirmed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkPreview {
    pub source_thread_id: String,
    /// Latest Turn with status completed; None while no Turn has completed.
    pub through_turn_id: Option<String>,
    /// When that Turn completed (Codex time, seconds), so people can tell
    /// which point in the conversation the copy stops at.
    pub through_completed_at: Option<i64>,
    /// The whole history through the boundary, including any earlier
    /// interrupted or failed Turns.
    pub included_turns: usize,
    /// Turns after the boundary (running, interrupted or failed); they stay
    /// with the source.
    pub excluded_turns: usize,
    pub name: String,
    pub cwd: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub permission_preset: Option<String>,
    pub project_id: Option<String>,
    pub forked_to: Option<ForkLink>,
    pub warnings: Vec<String>,
}

/// Expected outcomes are values, not errors, so the GUI can tell a definite
/// failure (safe to try again) from an unknown result (never repeated blindly).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkOutcome {
    /// completed | failed | uncertain
    pub state: String,
    pub request_id: String,
    pub agent: Option<Agent>,
    pub connected: bool,
    pub message: Option<String>,
    pub warnings: Vec<String>,
}

impl ForkOutcome {
    fn ended(state: &str, request_id: &str, message: impl Into<String>) -> Self {
        Self { state: state.into(), request_id: request_id.into(), agent: None, connected: false,
            message: Some(message.into()), warnings: vec![] }
    }
}

#[derive(Clone, Debug)]
struct ForkRow {
    request_id: String,
    source_agent_id: String,
    source_thread_id: String,
    through_turn_id: String,
    state: String,
    fork_thread_id: Option<String>,
    fork_agent_id: Option<String>,
    error: Option<String>,
    /// When the attempt began; kept as evidence for an unconfirmed result.
    #[allow(dead_code)]
    created_unix: i64,
}

/// Newest-first baseline: the boundary is the latest completed Turn. The fork
/// copies everything up to it, earlier interrupted or failed Turns included;
/// anything after it stays with the source.
fn fork_boundary(turns_desc: &[Value]) -> (Option<String>, usize, usize) {
    match turns_desc.iter().position(|turn| turn["status"] == "completed") {
        Some(index) => (turns_desc[index]["id"].as_str().map(str::to_owned), turns_desc.len() - index, index),
        None => (None, 0, turns_desc.len()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub turns: Vec<Value>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    /// A recovery page's (`recovery_page`, reading back) that did not reach
    /// the record's newest Turn: Turns between it and `turns` are not here.
    #[serde(skip)]
    pub unreached: bool,
}

pub(crate) struct ReadSession(pub(crate) Arc<Rpc>);
impl Drop for ReadSession {
    fn drop(&mut self) { self.0.close(); }
}
impl ReadSession {
    pub(crate) async fn open(program: &str) -> Result<Self> {
        let (tx, mut rx) = mpsc::channel(32);
        let rpc = Rpc::spawn(program, &[], tx).await?;
        // Read calls should never ask for approval. Fail any unexpected request
        // closed, and keep draining notifications so the RPC cannot deadlock.
        let weak = Arc::downgrade(&rpc);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                if let Some(id) = event.get("id") {
                    if let Some(rpc) = weak.upgrade() {
                        let _ = rpc.try_send(json!({"id":id,"error":{
                            "code":-32601,"message":"Session preview cannot execute tools or approve requests"}}));
                    }
                }
            }
        });
        let session = Self(rpc);
        session.0.initialize().await?;
        Ok(session)
    }
    pub(crate) async fn close(self) -> Result<()> { self.0.close_and_wait().await }
}

fn validate_thread_id(id: &str) -> Result<()> {
    anyhow::ensure!(uuid::Uuid::parse_str(id).is_ok(), "请填写有效的 Codex 会话 UUID；不接受路径或命令");
    Ok(())
}

async fn metadata(rpc: &Rpc, id: &str) -> Result<Value> {
    let mut response = rpc.request("thread/read", json!({"threadId":id,"includeTurns":false})).await?;
    let thread = response.get_mut("thread").map(Value::take).context("Codex 未返回会话信息")?;
    anyhow::ensure!(thread["id"] == id, "Codex 返回了不同的会话 ID；未导入");
    anyhow::ensure!(thread["cwd"].as_str().is_some_and(|s| !s.is_empty()), "原生会话没有工作目录");
    Ok(thread)
}

// Only IDs/statuses are collected for the import baseline. Full historical
// items stay in Codex; they never become a second copy in the event journal.
async fn baseline(rpc: &Rpc, id: &str) -> Result<Vec<Value>> {
    let mut cursor = None::<String>;
    let mut seen = HashSet::new();
    let mut turns = Vec::new();
    for _ in 0..50 {
        let mut page = rpc.request("thread/turns/list", json!({
            "threadId":id,"cursor":cursor,"limit":100,"sortDirection":"desc","itemsView":"notLoaded"
        })).await?;
        let data = page.get_mut("data").and_then(Value::as_array_mut).context("Codex 历史分页格式无效")?;
        for turn in data.drain(..) {
            let tid = turn["id"].as_str().context("Codex 历史缺少 Turn ID")?;
            if seen.insert(tid.to_owned()) { turns.push(json!({"id":tid,"status":turn["status"]})); }
        }
        let next = page["nextCursor"].as_str().map(str::to_owned);
        if next.is_none() { return Ok(turns); }
        anyhow::ensure!(next != cursor, "Codex 历史分页没有前进");
        cursor = next;
    }
    bail!("此会话超过 5000 个 Turn；请先使用原生 fork 缩小历史，再导入")
}

pub(crate) async fn history_page(rpc: &Rpc, id: &str, cursor: Option<&str>) -> Result<HistoryPage> {
    if let Some(cursor) = cursor {
        anyhow::ensure!(cursor.len() <= 4096 && !cursor.chars().any(char::is_control), "历史游标无效");
    }
    let mut page = rpc.request("thread/turns/list", json!({
        "threadId":id,"cursor":cursor,"limit":HISTORY_PAGE_SIZE,"sortDirection":"desc","itemsView":"full"
    })).await?;
    let mut turns: Vec<Value> = page.get_mut("data").and_then(Value::as_array_mut)
        .context("Codex 历史分页格式无效")?.drain(..).collect();
    anyhow::ensure!(turns.iter().all(|t| t["id"].is_string()), "Codex 历史缺少 Turn ID");
    turns.reverse();
    let next_cursor = page["nextCursor"].as_str().map(str::to_owned);
    anyhow::ensure!(next_cursor.as_deref().is_none() || next_cursor.as_deref() != cursor, "Codex 历史分页没有前进");
    Ok(HistoryPage { turns, has_more: next_cursor.is_some(), next_cursor, unreached: false })
}

/// The earlier native page from `cursor`, or, when that page holds only Turns
/// the record already has, the page from the newest earlier Turn it does not
/// (T-161). A reconnect points the cursor behind the recent page, so the pages
/// right after it repeat Turns saved while the session ran and a reader would
/// see nothing load. They are skipped by Turn ID only, as `baseline` reads
/// them; a Turn another client added between saved ones is still reached first.
async fn unsaved_page(rpc: &Rpc, id: &str, cursor: Option<&str>, saved: &HashSet<&str>) -> Result<HistoryPage> {
    let page = history_page(rpc, id, cursor).await?;
    let unsaved = |turn: &Value| turn["id"].as_str().is_some_and(|tid| !saved.contains(tid));
    if page.turns.is_empty() || page.turns.iter().any(unsaved) { return Ok(page); }
    let mut next = page.next_cursor.clone();
    for _ in 0..50 {
        let Some(current) = next else {
            return Ok(HistoryPage { turns: vec![], next_cursor: None, has_more: false, unreached: false });
        };
        // Codex 0.162 anchors a cursor to a Turn, so a page can start at any
        // Turn. With another form the saved page is returned as before.
        if !anchored_turn_cursor(&current) { return Ok(page); }
        let ids = rpc.request("thread/turns/list", json!({
            "threadId":id,"cursor":current,"limit":100,"sortDirection":"desc","itemsView":"notLoaded"
        })).await?;
        let data = ids["data"].as_array().context("Codex 历史分页格式无效")?;
        if let Some(tid) = data.iter().find(|turn| unsaved(turn)).and_then(|turn| turn["id"].as_str()) {
            return history_page(rpc, id, Some(&json!({"turn_id":tid,"include_anchor":true}).to_string())).await;
        }
        next = ids["nextCursor"].as_str().map(str::to_owned);
        anyhow::ensure!(next.as_deref() != Some(current.as_str()), "Codex 历史分页没有前进");
    }
    Ok(page)
}

/// A cursor of the form Codex 0.162 gives `thread/turns/list` pages.
fn anchored_turn_cursor(cursor: &str) -> bool {
    serde_json::from_str::<Value>(cursor).ok().and_then(|value| value.as_object().map(|fields| {
        fields.len() == 2 && fields.get("turn_id").is_some_and(Value::is_string)
            && fields.get("include_anchor").is_some_and(Value::is_boolean)
    })).unwrap_or(false)
}

/// Unfinished Turns the native history, read to its end, doesn't have
/// (T-198): Codex never saved them. Unlike a timeout, a page beyond the
/// check's range or a failed read, this is the native history's own answer;
/// the caller records it so the user can end them (`MissingTurns`).
#[derive(Debug)]
pub(crate) struct MissingNativeTurns {
    pub turn_ids: Vec<String>,
}
impl std::fmt::Display for MissingNativeTurns {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("原生历史未包含先前未完成的 Turn；状态仍需确认")
    }
}
impl std::error::Error for MissingNativeTurns {}

/// The newest native page, read first without Items: when the record's
/// newest Turns (`held`, oldest first) are its Turns, each ended as it ended
/// natively, the record already has what the page holds and the page is
/// returned without Turns; otherwise it is read whole (`history_page`). A
/// reconnect so never decodes a long Turn the record has whole again (T-140).
async fn newest_page(rpc: &Rpc, id: &str, held: &[(String, Option<String>)]) -> Result<HistoryPage> {
    let ended = |status: Option<&str>| matches!(status, Some("completed" | "failed" | "interrupted"));
    if !held.is_empty() && held.iter().all(|(_, status)| ended(status.as_deref())) {
        let light = rpc.request("thread/turns/list", json!({
            "threadId":id,"cursor":null,"limit":HISTORY_PAGE_SIZE,"sortDirection":"desc","itemsView":"notLoaded"
        })).await?;
        let data = light["data"].as_array().context("Codex 历史分页格式无效")?;
        let same = data.len() == held.len() && data.iter().rev().zip(held).all(|(turn, (tid, status))|
            turn["id"].as_str() == Some(tid.as_str()) && turn["status"].as_str() == status.as_deref());
        if same {
            let next_cursor = light["nextCursor"].as_str().map(str::to_owned);
            return Ok(HistoryPage { turns: vec![], has_more: next_cursor.is_some(), next_cursor, unreached: false });
        }
    }
    history_page(rpc, id, None).await
}

/// The most earlier pages, and the longest time, a recovery page spends
/// reading back to the record's newest Turn (`recovery_page`). Past either it
/// stops reading back (the reconnect goes on with the newest page), and the
/// Turns it did not reach are paged in on demand (`unreached`).
const BACK_PAGES: usize = 100;
const BACK_TIME: std::time::Duration = std::time::Duration::from_secs(10);

/// Refresh the recent window and any cached unfinished Turn that fell outside
/// it while another client advanced the session. Metadata pages locate those
/// specific Turns; only their full pages are loaded. Never infer tool success
/// merely because the current native thread is idle. `held` is the record's
/// newest Turns as stored (`newest_page`). With `back`, the Turns another
/// client added since the record's newest one are read too, page by page back
/// to it, once metadata pages have found it: an Agent whose record is its
/// whole history gets them all, as a whole native history once gave it. A
/// walk that does not find it within BACK_PAGES and BACK_TIME merges none of
/// them and says so (`unreached`), never failing the reconnect. Without
/// `back` (an imported Agent), the newest page only, the rest paged in on
/// demand (`history_page`).
pub(crate) async fn recovery_page(rpc: &Rpc, id: &str, cached: &AgentDetail, held: &[(String, Option<String>)], back: bool)
    -> Result<HistoryPage> {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let mut page = newest_page(rpc, id, held).await?;
        let mut missing: HashSet<String> = cached.turns.iter()
            .filter(|turn| turn["status"] == "inProgress")
            .filter_map(|turn| turn["id"].as_str())
            .filter(|tid| !page.turns.iter().any(|turn| turn["id"] == *tid))
            .map(str::to_owned).collect();
        // The record's newest Turn when the newest page does not reach it,
        // and the earlier pages, all of Turns after it, passed on the way.
        let mut newest = held.last().map(|(tid, _)| tid.clone()).filter(|tid| back && page.has_more
            && !page.turns.is_empty() && !page.turns.iter().any(|turn| turn["id"] == tid.as_str()));
        let mut between: Vec<String> = Vec::new();
        let walk_until = std::time::Instant::now() + BACK_TIME;
        let mut cursor = page.next_cursor.clone();
        for _ in 0..1700 {
            if newest.is_some() && (between.len() >= BACK_PAGES || std::time::Instant::now() >= walk_until) {
                newest = None;
                between.clear();
                page.unreached = true;
            }
            if missing.is_empty() && newest.is_none() { return Ok(distinct(page)); }
            let Some(current) = cursor.clone() else {
                if newest.take().is_some() {
                    page.unreached = true;
                }
                if missing.is_empty() { return Ok(distinct(page)); }
                let mut turn_ids: Vec<String> = missing.into_iter().collect();
                turn_ids.sort();
                return Err(MissingNativeTurns { turn_ids }.into());
            };
            let metadata = rpc.request("thread/turns/list", json!({
                "threadId":id,"cursor":current,"limit":HISTORY_PAGE_SIZE,"sortDirection":"desc","itemsView":"notLoaded"
            })).await?;
            let turns = metadata["data"].as_array().context("Codex 历史分页格式无效")?;
            if turns.iter().any(|turn| turn["id"].as_str().is_some_and(|tid| missing.contains(tid))) {
                let mut recovered = history_page(rpc, id, Some(current.as_str())).await?.turns;
                for turn in &recovered { if let Some(tid) = turn["id"].as_str() { missing.remove(tid); } }
                recovered.append(&mut page.turns);
                page.turns = recovered;
            }
            if let Some(tid) = newest.clone() {
                if turns.iter().any(|turn| turn["id"] == tid.as_str()) {
                    // Found: the Turns after it on this page, then the pages
                    // passed, oldest first, before the newest page; all of
                    // them within BACK_TIME, or none.
                    newest = None;
                    let mut added = history_page(rpc, id, Some(current.as_str())).await?.turns;
                    if let Some(at) = added.iter().position(|turn| turn["id"] == tid.as_str()) {
                        added.drain(..=at);
                    }
                    let mut whole = true;
                    for passed in between.drain(..).rev() {
                        if std::time::Instant::now() >= walk_until {
                            whole = false;
                            break;
                        }
                        added.append(&mut history_page(rpc, id, Some(passed.as_str())).await?.turns);
                    }
                    if whole {
                        added.append(&mut page.turns);
                        page.turns = added;
                    } else {
                        page.unreached = true;
                    }
                } else {
                    between.push(current.clone());
                }
            }
            let next = metadata["nextCursor"].as_str().map(str::to_owned);
            anyhow::ensure!(next.is_none() || next.as_deref() != Some(current.as_str()), "Codex 历史分页没有前进");
            cursor = next;
        }
        if newest.is_some() {
            page.unreached = true;
        }
        if missing.is_empty() { return Ok(distinct(page)); }
        bail!("未完成 Turn 超出本次历史核对范围；不会猜测执行结果")
    }).await.context("历史核对超时；先前未完成的 Turn 状态仍需确认")?
}

/// `page` with each Turn once (the first, in order): a page read for an
/// unfinished Turn and again for the Turns after the record's newest.
fn distinct(mut page: HistoryPage) -> HistoryPage {
    let mut seen = HashSet::new();
    page.turns.retain(|turn| seen.insert(turn["id"].as_str().map(str::to_owned)));
    page
}

impl Workspace {
    pub async fn preview_codex_session(&self, thread_id: &str) -> Result<SessionPreview> {
        let _admission = self.admission.enter_completion()?;
        validate_thread_id(thread_id)?;
        let _permit = self.session_reads.try_acquire().context("正在读取另一份原生历史，请稍后重试")?;
        let session = ReadSession::open(&self.program).await?;
        let thread = metadata(&session.0, thread_id).await?;
        let turns = baseline(&session.0, thread_id).await?;
        let cwd = thread["cwd"].as_str().unwrap().to_owned();
        let permissions = session_permission_catalog(&session.0, &cwd, &AgentSettings::default()).await;
        let mut warnings = Vec::new();
        if !std::path::Path::new(&cwd).is_dir() { warnings.push("原工作目录当前不可访问；恢复前需要把目录放回原位置。".into()); }
        let model = thread["model"].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        if model.is_none() { warnings.push("原生接口未返回模型，无法安全保留原模型；当前不能导入。".into()); }
        let thread_key = thread_id.to_owned();
        let existing_agent_id = self.stored(move |store| store.local_codex_agent(&thread_key)).await?;
        let preview = SessionPreview {
            thread_id: thread_id.into(), name: thread["name"].as_str().unwrap_or("Codex session").into(),
            cwd, preview: thread["preview"].as_str().unwrap_or("").chars().take(1200).collect(),
            model, reasoning_effort: thread["reasoningEffort"].as_str().map(str::to_owned),
            turn_count: turns.len(), updated_at: thread["updatedAt"].as_i64(),
            existing_agent_id, warnings, permissions,
        };
        session.close().await?;
        Ok(preview)
    }

    pub async fn import_codex_session(&self, input: ImportSession) -> Result<Agent> {
        let _admission = self.admission.enter_work()?;
        validate_thread_id(&input.thread_id)?;
        anyhow::ensure!(!input.name.trim().is_empty() && input.name.len() <= 100, "请填写名称（最多 100 字节）");
        anyhow::ensure!(["ask", "auto", "full", "config"].contains(&input.permission_preset.as_str()), "请选择有效的后续权限");
        // One read/import at a time bounds subprocess and memory use. The SQL
        // transaction below independently enforces duplicate-session adoption.
        let _permit = self.session_reads.try_acquire().context("正在读取另一份原生历史，请稍后重试")?;
        let thread_key = input.thread_id.clone();
        if let Some(agent) = self.stored(move |store| store.local_codex_agent(&thread_key)?
            .map(|id| store.agent(&id)).transpose()).await? { return Ok(agent); }
        let session = ReadSession::open(&self.program).await?;
        let thread = metadata(&session.0, &input.thread_id).await?;
        let mut baseline = baseline(&session.0, &input.thread_id).await?;
        let page = history_page(&session.0, &input.thread_id, None).await?;
        // Source activity can advance between the metadata and item pages.
        // Every terminal Turn actually displayed at import is historical too.
        for turn in &page.turns {
            if !baseline.iter().any(|old| old["id"] == turn["id"]) {
                baseline.push(json!({"id":turn["id"],"status":turn["status"]}));
            }
        }
        let cwd = thread["cwd"].as_str().unwrap().to_owned();
        let model = thread["model"].as_str().filter(|s| !s.is_empty()).context("原生接口未返回原模型；请更新 Codex 后重试，不会用默认模型替代")?.to_owned();
        let settings = AgentSettings { context_window: None, auto_compact_token_limit: None,
            reasoning_effort: thread["reasoningEffort"].as_str().map(str::to_owned),
            permission_preset: Some(input.permission_preset), ..AgentSettings::default()
        };
        let (config, requirements) = permission_config(&session.0, &cwd).await?;
        permissions::resolve(&settings, &config, &cwd)?.check_requirements(&requirements)?;
        session.close().await?;
        let mut detail = AgentDetail {
            agent: Agent {
                id: uuid::Uuid::new_v4().to_string(), name: input.name.trim().into(), goal: String::new(),
                work_summary: None, project_id: None, cwd, model, settings, color: "sage".into(), harness: "codex".into(),
                claude_session_id: None, thread_id: Some(input.thread_id), status: "offline".into(),
                opencode_session_id: None,
                closed_at: None, disconnected_at: None, disconnect_unconfirmed: false, created_at: now(), updated_at: now(), unread_count: 0, pending_count: 0,
                last_message: None, last_seq: 0, reviewed_seq: 0, rev: 0, error: None, remote: None,
                connection_state: "disconnected".into(),
            },
            history: Some(HistoryWindow { loaded_count: page.turns.len(), has_more: page.has_more, next_cursor: page.next_cursor }),
            turns: page.turns, pending: vec![], artifacts: vec![], context_usage: None, message_receipts: vec![], claude_runtime: None,
            codex_handoff: None,
        };
        detail.refresh_snapshot_evidence();
        let agent = self.stored(move |store| store.insert_codex_import(&detail, &baseline)).await?;
        self.changed(&agent.id);
        Ok(agent)
    }

    pub async fn codex_session_history(&self, agent_id: &str, cursor: Option<&str>) -> Result<HistoryPage> {
        let _admission = self.admission.enter_completion()?;
        let id = agent_id.to_owned();
        // The saved Turns' IDs only, not the Turns (T-140).
        // An imported Agent's, or one whose reconnect left native Turns it
        // did not reach (`recovery_page`).
        let (agent, ids, paged) = self.stored(move |store| Ok((store.agent(&id)?, store.turn_ids(&id)?,
            store.is_codex_import(&id)? || store.view(&id, crate::store::Sel::Meta)?.history.is_some_and(|h| h.has_more)))).await?;
        anyhow::ensure!(agent.harness == "codex" && agent.remote.is_none()
            && paged, "此 Agent 没有可分页的本机导入历史");
        let _permit = self.session_reads.try_acquire().context("正在读取另一份原生历史，请稍后重试")?;
        let session = ReadSession::open(&self.program).await?;
        let thread = agent.thread_id.as_deref().context("缺少原生会话 ID")?;
        let saved: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut result = unsaved_page(&session.0, thread, cursor, &saved).await?;
        session.close().await?;
        let (agent_id, shown) = (agent_id.to_owned(), result.turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect::<Vec<_>>());
        let receipts = self.stored(move |store| store.receipts_for(&agent_id, &shown)).await?;
        crate::message_content::restore(&mut result.turns, &receipts, true);
        Ok(result)
    }
}

/// The model a fork must keep: the Agent's own, else the source's saved one.
fn fork_model(agent: &Agent, thread: &Value) -> Result<String> {
    Some(agent.model.as_str()).filter(|m| !m.is_empty())
        .or_else(|| thread["model"].as_str().filter(|m| !m.is_empty()))
        .map(str::to_owned)
        .context("原会话没有可保留的模型；不会用默认模型 fork")
}

/// Codex reports times in seconds; tolerate milliseconds.
fn unix_seconds(value: &Value) -> i64 {
    let raw = value.as_i64().unwrap_or(0);
    if raw > 100_000_000_000 { raw / 1000 } else { raw }
}

/// Codex 0.162.1 cannot locate a fork whose response was lost: thread/list
/// omits a fork until it has its own Turn and then reports forkedFromId as
/// null (measured in T-4). An unconfirmed attempt therefore stays unconfirmed.
const UNCONFIRMED_FORK: &str = "Codex 无法确认这次 fork 是否已创建，Yuzuno 不会自动重试。可以明确选择再 fork 一次：这可能在 Codex 中留下一个未使用的会话，但不会多出 Agent。";
const DELETED_FORK: &str = "这次 fork 的 Agent 已从 Workspace 删除；原会话未改变。可以重新确认 fork，这会创建新的原生会话和新的 Agent。";

/// The fork read back fine but is not the copy the user confirmed. Unlike a
/// read error this is definite, so the attempt fails instead of being retried.
#[derive(Debug)]
struct HistoryMismatch(String);
impl std::fmt::Display for HistoryMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
}
impl std::error::Error for HistoryMismatch {}

/// The fork must hold exactly the source's Turns through the boundary, with
/// the same IDs and statuses. Returns the fork baseline and its first page.
async fn verified_fork_history(rpc: &Rpc, row: &ForkRow, fork_id: &str) -> Result<(Vec<Value>, HistoryPage)> {
    let mismatch = |message: String| -> Result<(Vec<Value>, HistoryPage)> { Err(HistoryMismatch(message).into()) };
    let fork = metadata(rpc, fork_id).await?;
    if fork["forkedFromId"] != row.source_thread_id.as_str() {
        return mismatch(format!("会话 {fork_id} 不是原会话的直接 fork；未登记"));
    }
    let mut source = baseline(rpc, &row.source_thread_id).await?;
    source.reverse();
    let Some(end) = source.iter().position(|turn| turn["id"] == row.through_turn_id.as_str()) else {
        return mismatch("原会话中找不到所选的历史边界 Turn".into());
    };
    let mut copied = baseline(rpc, fork_id).await?;
    copied.reverse();
    if copied.as_slice() != &source[..=end] {
        return mismatch(format!("fork {fork_id} 的历史与原会话在边界前不一致（原 {} 个 Turn，fork {} 个）；未登记",
            end + 1, copied.len()));
    }
    let page = history_page(rpc, fork_id, None).await?;
    Ok((copied, page))
}

impl Workspace {
    async fn set_fork(&self, request_id: &str, state: &'static str, fork: Option<&str>, error: Option<&str>) -> Result<()> {
        let (request, fork, error) = (request_id.to_owned(), fork.map(str::to_owned), error.map(str::to_owned));
        self.stored(move |store| store.set_fork_state(&request, state, fork.as_deref(), error.as_deref())).await
    }
}

/// The window reader shares its record snapshot with provenance reads.
pub(crate) fn annotate_imported_questions_in(db: &rusqlite::Connection, detail: &mut AgentDetail) -> Result<()> {
    if detail.agent.harness != "codex" { return Ok(()); }
    let mut candidates = detail.turns.iter_mut().filter(|turn| turn["items"].as_array().is_some_and(|items|
        items.iter().any(|item| item["type"] == "agentMessage" && item["delivery"] == "async"
            && item["questions"].as_array().is_some_and(|questions| !questions.is_empty())))).peekable();
    if candidates.peek().is_none() { return Ok(()); }
    let mut query = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM codex_import_turns WHERE agent_id=?1 AND turn_id=?2)")?;
    for turn in candidates {
        let imported: bool = query.query_row(params![detail.agent.id, turn["id"].as_str()], |row| row.get(0))?;
        if imported { turn["_yuzunoImportedQuestions"] = true.into(); }
        else if let Some(object) = turn.as_object_mut() { object.remove("_yuzunoImportedQuestions"); }
    }
    Ok(())
}

impl Store {
    /// Only a local Codex session another client is known to own can fork,
    /// and only while Yuzuno itself is not attached to it.
    fn fork_source(&self, agent_id: &str) -> Result<AgentDetail> {
        let detail = self.view(agent_id, crate::store::Sel::Meta)?;
        let agent = &detail.agent;
        ensure_agent_open(agent)?;
        anyhow::ensure!(agent.harness == "codex" && agent.remote.is_none(), "只能 fork 本机 Codex 会话");
        anyhow::ensure!(agent.thread_id.is_some(), "此 Agent 还没有原生会话");
        anyhow::ensure!(agent.connection_state != "connected", "Yuzuno 已连接此会话，不需要 fork");
        anyhow::ensure!(detail.codex_handoff.as_ref().is_some_and(|h| h.writer_conflict_at.is_some()),
            "只有在原会话被其他客户端占用时才提供 fork；请先尝试重新连接");
        Ok(detail)
    }
}

impl Workspace {
    /// Read-only: shows what an explicit fork would keep. Starts no Turn.
    pub async fn preview_codex_fork(&self, agent_id: &str) -> Result<ForkPreview> {
        let _admission = self.admission.enter_completion()?;
        let id = agent_id.to_owned();
        let source = self.stored(move |store| store.fork_source(&id)).await?;
        let agent = source.agent;
        let thread_id = agent.thread_id.clone().unwrap();
        let _permit = self.session_reads.try_acquire().context("正在读取另一份原生历史，请稍后重试")?;
        let session = ReadSession::open(&self.program).await?;
        let thread = metadata(&session.0, &thread_id).await?;
        let turns = baseline(&session.0, &thread_id).await?;
        let (through_turn_id, included_turns, excluded_turns) = fork_boundary(&turns);
        // The boundary is among the newest Turns; one metadata page finds it.
        let recent = session.0.request("thread/turns/list", json!({
            "threadId":thread_id,"limit":100,"sortDirection":"desc","itemsView":"notLoaded"
        })).await?;
        let through_completed_at = recent["data"].as_array().into_iter().flatten()
            .find(|turn| through_turn_id.as_deref().is_some_and(|id| turn["id"] == id))
            .map(|turn| unix_seconds(&turn["completedAt"])).filter(|at| *at > 0);
        session.close().await?;
        // A link to a deleted Agent is not a continuation (see delete_agent).
        let (link, id) = (source.codex_handoff.and_then(|h| h.forked_to), agent_id.to_owned());
        let (forked_to, project_id) = self.stored(move |store| Ok((
            match link {
                Some(link) if store.agent_exists(&link.agent_id)? => Some(link),
                _ => None,
            },
            store.agent_project(&id)?,
        ))).await?;
        let mut warnings = Vec::new();
        if through_turn_id.is_none() { warnings.push("原会话还没有已完成的 Turn，暂时无法 fork。".into()); }
        if !std::path::Path::new(&agent.cwd).is_dir() { warnings.push("工作目录当前不可访问；fork 后需要把目录放回原位置才能继续。".into()); }
        Ok(ForkPreview {
            source_thread_id: thread_id, through_turn_id, through_completed_at, included_turns, excluded_turns,
            model: fork_model(&agent, &thread)?, name: agent.name, cwd: agent.cwd,
            reasoning_effort: agent.settings.reasoning_effort, permission_preset: agent.settings.permission_preset,
            project_id, forked_to, warnings,
        })
    }

    /// One explicit fork. The original session and Agent are never changed
    /// except for a link to the continuation. Retrying the same request (or
    /// clicking again for the same boundary) settles that same attempt.
    pub async fn fork_codex_session(self: &Arc<Self>, agent_id: &str, input: ForkSession) -> Result<ForkOutcome> {
        let _admission = self.admission.enter_work()?;
        anyhow::ensure!(uuid::Uuid::parse_str(&input.request_id).is_ok(), "fork 请求编号无效");
        anyhow::ensure!(!input.through_turn_id.is_empty() && input.through_turn_id.len() <= 200
            && !input.through_turn_id.chars().any(char::is_control), "fork 历史边界无效");
        let name = input.name.trim().to_owned();
        anyhow::ensure!(!name.is_empty() && name.len() <= 100, "请填写名称（最多 100 字节）");
        // The source gate also serializes against its reconnect and send.
        let gate = self.gate(agent_id).await;
        let held = gate.lock().await;
        let (source_id, request_id, through_turn_id, abandon_unconfirmed) = (agent_id.to_owned(),
            input.request_id.clone(), input.through_turn_id.clone(), input.abandon_unconfirmed);
        let mut row = self.stored(move |store| Ok(match store.fork_row(&request_id)? {
            Some(row) => {
                anyhow::ensure!(row.source_agent_id == source_id && row.through_turn_id == through_turn_id,
                    "同一 fork 请求不能改变来源或历史边界");
                row
            }
            None => {
                let source = store.fork_source(&source_id)?;
                let thread = source.agent.thread_id.as_deref().unwrap();
                match store.live_fork(&source_id, &through_turn_id)? {
                    // Only the user's explicit choice gives up an unconfirmed attempt.
                    Some(earlier) if abandon_unconfirmed && matches!(earlier.state.as_str(), "sending" | "uncertain") => {
                        store.set_fork_state(&earlier.request_id, "abandoned", None, earlier.error.as_deref())?;
                        store.begin_fork(&request_id, &source_id, thread, &through_turn_id)?
                    }
                    // Normally released when that Agent was deleted; a record
                    // left behind must not block this explicit new request.
                    Some(earlier) if earlier.state == "completed" && !store.fork_agent_exists(&earlier)? => {
                        store.set_fork_state(&earlier.request_id, "released", None, earlier.error.as_deref())?;
                        store.begin_fork(&request_id, &source_id, thread, &through_turn_id)?
                    }
                    Some(earlier) => earlier,
                    None => store.begin_fork(&request_id, &source_id, thread, &through_turn_id)?,
                }
            }
        })).await?;
        let permit = self.session_reads.try_acquire().context("正在读取另一份原生历史，请稍后重试")?;
        let mut warnings = Vec::new();
        let mut created = false;
        loop {
            match row.state.as_str() {
                "requested" => self.send_fork(&mut row, &mut warnings).await?,
                // Sent but never confirmed (a lost response, or a crash after
                // the wire write): never assumed failed, never sent again.
                "sending" | "uncertain" => {
                    let detail = row.error.clone().unwrap_or_else(|| "上次 fork 请求发送后没有收到结果".into());
                    return Ok(ForkOutcome::ended("uncertain", &row.request_id, format!("{detail}。{UNCONFIRMED_FORK}")));
                }
                "forked" => { self.register_fork(&mut row, &name, &mut warnings).await?; created = true; }
                "failed" => return Ok(ForkOutcome::ended("failed", &row.request_id,
                    row.error.clone().unwrap_or_else(|| "fork 失败".into()))),
                "completed" => {
                    let completed = row.clone();
                    if self.stored(move |store| store.fork_agent_exists(&completed)).await? { break; }
                    self.set_fork(&row.request_id, "released", None, row.error.as_deref()).await?;
                    row.state = "released".into();
                }
                // Its Agent was deleted, so this request no longer continues
                // anything. Only a new request forks again.
                "released" => return Ok(ForkOutcome::ended("failed", &row.request_id, DELETED_FORK)),
                other => bail!("未知的 fork 状态 {other}"),
            }
        }
        drop(permit);
        drop(held);
        let fork_id = row.fork_agent_id.clone().context("fork 记录缺少新 Agent")?;
        // Attach without a prompt so the user can continue at once. A failed
        // attach leaves the registered fork Offline; nothing is retried here.
        // The outcome needs the Agent only, read as listed (T-140).
        let connected = if created {
            match self.reconnect_settled(&fork_id, &_admission).await {
                Ok(()) => self.listed(&fork_id).await?.connection_state == "connected",
                Err(error) => { warnings.push(format!("fork 已登记，但连接失败：{error}")); false }
            }
        } else {
            self.listed(&fork_id).await?.connection_state == "connected"
        };
        Ok(ForkOutcome {
            state: "completed".into(), request_id: row.request_id, agent: Some(self.listed(&fork_id).await?),
            connected, message: None, warnings,
        })
    }

    async fn send_fork(&self, row: &mut ForkRow, warnings: &mut Vec<String>) -> Result<()> {
        let source = self.send_view(&row.source_agent_id).await?;
        let agent = &source.agent;
        let session = ReadSession::open(&self.program).await?;
        let thread = metadata(&session.0, &row.source_thread_id).await?;
        let model = fork_model(agent, &thread)?;
        // Only a completed Turn is a boundary; nothing is sent otherwise.
        let turns = baseline(&session.0, &row.source_thread_id).await?;
        if !turns.iter().any(|turn| turn["id"] == row.through_turn_id.as_str() && turn["status"] == "completed") {
            let _ = session.close().await;
            let message = "所选历史边界不是原会话中已完成的 Turn；没有 fork，原会话未改变".to_owned();
            self.set_fork(&row.request_id, "failed", None, Some(&message)).await?;
            row.state = "failed".into();
            row.error = Some(message);
            return Ok(());
        }
        let mut params = json!({"threadId":row.source_thread_id,"lastTurnId":row.through_turn_id,
            "excludeTurns":true,"cwd":agent.cwd,"model":model});
        crate::codex_context::check(&session.0, &agent.cwd, &agent.settings).await?;
        crate::codex_context::apply(&agent.settings, &mut params);
        // The explicitly chosen permissions, resolved exactly as for a start.
        let (config, requirements) = if agent.settings.permission_preset.is_some() {
            permission_config(&session.0, &agent.cwd).await?
        } else { (Value::Null, Value::Null) };
        let permissions = permissions::resolve(&agent.settings, &config, &agent.cwd)?;
        permissions.check_requirements(&requirements)?;
        permissions.apply(&mut params, false);
        // thread/fork has no profile field; resume re-applies the profile.
        params.as_object_mut().unwrap().remove("permissions");
        // Recorded before the wire write: after a crash the attempt stays
        // unconfirmed and is never sent again by itself.
        self.set_fork(&row.request_id, "sending", None, None).await?;
        row.state = "sending".into();
        let response = session.0.request_within("thread/fork", params, std::time::Duration::from_secs(120)).await;
        let _ = session.close().await;
        match response {
            Ok(response) => {
                let fork = response["thread"]["id"].as_str()
                    .filter(|id| *id != row.source_thread_id)
                    .context("Codex 没有返回新的 fork 会话 ID")?.to_owned();
                if response["model"].as_str().is_some_and(|m| m != model) {
                    warnings.push(format!("Codex 为 fork 报告了模型 {}；继续时仍使用 {model}", response["model"]));
                }
                self.set_fork(&row.request_id, "forked", Some(&fork), None).await?;
                row.state = "forked".into();
                row.fork_thread_id = Some(fork);
            }
            Err(error) if error.downcast_ref::<RpcError>().is_some() => {
                // Codex refused; nothing was created, so trying again is safe.
                let message = format!("Codex 拒绝了 fork，原会话未改变：{error}");
                self.set_fork(&row.request_id, "failed", None, Some(&message)).await?;
                row.state = "failed".into();
                row.error = Some(message);
            }
            Err(error) => {
                let message = format!("fork 结果未确认：{error}");
                self.set_fork(&row.request_id, "uncertain", None, Some(&message)).await?;
                row.state = "uncertain".into();
                row.error = Some(message);
            }
        }
        Ok(())
    }

    /// Verifies the fork's history and registers one Agent for it, keeping the
    /// source's name choice, Project, folder, model, effort and permissions.
    async fn register_fork(&self, row: &mut ForkRow, name: &str, warnings: &mut Vec<String>) -> Result<()> {
        let fork_thread = row.fork_thread_id.clone().context("fork 记录缺少会话 ID")?;
        let (thread, request) = (fork_thread.clone(), row.request_id.clone());
        let existing = self.stored(move |store| {
            let Some(existing) = store.local_codex_agent(&thread)? else { return Ok(None) };
            store.set_fork_state(&request, "completed", Some(&thread), None)?;
            store.link_fork_agent(&request, &existing)?;
            Ok(Some(existing))
        }).await?;
        if let Some(existing) = existing {
            row.state = "completed".into();
            row.fork_agent_id = Some(existing);
            return Ok(());
        }
        let source = self.send_view(&row.source_agent_id).await?;
        let session = ReadSession::open(&self.program).await?;
        let verified = verified_fork_history(&session.0, row, &fork_thread).await;
        let model = metadata(&session.0, &row.source_thread_id).await.and_then(|t| fork_model(&source.agent, &t));
        let _ = session.close().await;
        let (baseline, page) = match verified {
            Ok(history) => history,
            Err(error) if error.is::<HistoryMismatch>() => {
                // The native fork exists but is not trustworthy; say so and
                // leave it unregistered. A new attempt may fork again.
                let message = format!("{error}。原会话未改变；未经核对的 fork {fork_thread} 保留在 Codex 中，未加入 Workspace。");
                self.set_fork(&row.request_id, "failed", Some(&fork_thread), Some(&message)).await?;
                row.state = "failed".into();
                row.error = Some(message);
                return Ok(());
            }
            // A failed read proves nothing about the fork. It stays "forked":
            // retrying checks the same fork again and never forks twice.
            Err(error) => bail!("fork {fork_thread} 已创建，但暂时无法核对其历史：{error}。重试会再次核对这个 fork，不会重新 fork"),
        };
        let at = now();
        let link = |agent_id: &str, thread_id: &str| ForkLink {
            agent_id: agent_id.into(), thread_id: thread_id.into(), through_turn_id: row.through_turn_id.clone(),
            turn_count: baseline.len(), at: at.clone(),
        };
        let agent_id = uuid::Uuid::new_v4().to_string();
        let mut detail = AgentDetail {
            agent: Agent {
                id: agent_id.clone(), name: name.into(), goal: String::new(), work_summary: None, project_id: None,
                cwd: source.agent.cwd.clone(), model: model?, settings: source.agent.settings.clone(),
                color: source.agent.color.clone(), harness: "codex".into(), claude_session_id: None, opencode_session_id: None,
                thread_id: Some(fork_thread.clone()), status: "offline".into(), closed_at: None, disconnected_at: None, disconnect_unconfirmed: false,
                created_at: at.clone(), updated_at: at.clone(), unread_count: 0, pending_count: 0, last_message: None,
                last_seq: 0, reviewed_seq: 0, rev: 0, error: None, remote: None, connection_state: "disconnected".into(),
            },
            history: Some(HistoryWindow { loaded_count: page.turns.len(), has_more: page.has_more, next_cursor: page.next_cursor }),
            turns: page.turns, pending: vec![], artifacts: vec![], context_usage: None, message_receipts: vec![],
            claude_runtime: None,
            codex_handoff: Some(CodexHandoff { forked_from: Some(link(&source.agent.id, &row.source_thread_id)), ..Default::default() }),
        };
        detail.refresh_snapshot_evidence();
        let forked_to = link("", &fork_thread);
        let (source_id, request) = (source.agent.id.clone(), row.request_id.clone());
        let (agent, project, project_kept) = self.stored(move |store| {
            let project = store.agent_project(&source_id)?;
            let (agent, project_kept) = store.insert_codex_fork(&detail, &baseline, project.as_deref(), &request)?;
            Ok((agent, project, project_kept))
        }).await?;
        if project.is_some() && !project_kept {
            warnings.push("原 Project 已归档，fork 未加入该 Project。".into());
        }
        let forked_to = ForkLink { agent_id: agent.id.clone(), ..forked_to };
        self.record_update(&source.agent.id, "codex/forkedTo", json!({"agentId":agent.id,"threadId":fork_thread}), crate::store::Sel::Meta, move |d| {
            d.codex_handoff.get_or_insert_with(Default::default).forked_to = Some(forked_to);
        }).await?;
        self.changed(&source.agent.id);
        self.changed(&agent.id);
        row.state = "completed".into();
        row.fork_agent_id = Some(agent.id);
        Ok(())
    }
}

pub(crate) fn migrate(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS codex_imports(
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL UNIQUE, awaiting_handoff INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS codex_import_turns(
        agent_id TEXT NOT NULL REFERENCES codex_imports(agent_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL, PRIMARY KEY(agent_id,turn_id));
        CREATE TABLE IF NOT EXISTS codex_forks(
        request_id TEXT PRIMARY KEY, source_agent_id TEXT NOT NULL, source_thread_id TEXT NOT NULL,
        through_turn_id TEXT NOT NULL, state TEXT NOT NULL, fork_thread_id TEXT, fork_agent_id TEXT,
        error TEXT, created_unix INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS codex_forks_one_live ON codex_forks(source_agent_id,through_turn_id)
        WHERE state IN ('requested','sending','uncertain','forked','completed');")?;
    Ok(())
}

/// The states held by codex_forks_one_live; failed, abandoned and released
/// attempts leave the boundary free for a new explicit request.
const LIVE_FORK_STATES: &str = "('requested','sending','uncertain','forked','completed')";

/// Deleting an Agent releases the fork attempts it took part in, as source or
/// as the registered fork, inside the delete transaction.
pub(crate) fn release_forks(tx: &rusqlite::Transaction, agent_id: &str) -> Result<()> {
    tx.execute(&format!("UPDATE codex_forks SET state='released'
        WHERE (source_agent_id=?1 OR fork_agent_id=?1) AND state IN {LIVE_FORK_STATES}"), [agent_id])?;
    Ok(())
}

const FORK_COLUMNS: &str = "request_id,source_agent_id,source_thread_id,through_turn_id,state,fork_thread_id,fork_agent_id,error,created_unix";

fn fork_from_row(r: &rusqlite::Row) -> rusqlite::Result<ForkRow> {
    Ok(ForkRow { request_id: r.get(0)?, source_agent_id: r.get(1)?, source_thread_id: r.get(2)?,
        through_turn_id: r.get(3)?, state: r.get(4)?, fork_thread_id: r.get(5)?, fork_agent_id: r.get(6)?,
        error: r.get(7)?, created_unix: r.get(8)? })
}

impl Store {
    pub fn local_codex_agent(&self, thread_id: &str) -> Result<Option<String>> {
        let db = self.db.read()?;
        Ok(db.query_row("SELECT id FROM agents WHERE json_extract(data,'$.agent.threadId')=?1
            AND COALESCE(json_extract(data,'$.agent.harness'),'codex')='codex'
            AND json_extract(data,'$.agent.remote') IS NULL LIMIT 1", [thread_id], |r| r.get(0)).optional()?)
    }
    pub fn is_codex_import(&self, id: &str) -> Result<bool> {
        Ok(self.db.read()?.query_row("SELECT EXISTS(SELECT 1 FROM codex_imports WHERE agent_id=?1)", [id], |r| r.get(0))?)
    }
    pub fn codex_handoff_pending(&self, id: &str) -> Result<bool> {
        Ok(self.db.read()?.query_row("SELECT EXISTS(SELECT 1 FROM codex_imports WHERE agent_id=?1 AND awaiting_handoff=1)", [id], |r| r.get(0))?)
    }
    pub(crate) fn activate_codex_import(&self, id: &str) -> Result<()> {
        self.db.write()?.execute("UPDATE codex_imports SET awaiting_handoff=0 WHERE agent_id=?1", [id])?;
        Ok(())
    }
    fn fork_row(&self, request_id: &str) -> Result<Option<ForkRow>> {
        Ok(self.db.read()?.query_row(&format!("SELECT {FORK_COLUMNS} FROM codex_forks WHERE request_id=?1"),
            [request_id], fork_from_row).optional()?)
    }
    /// A live or completed attempt for this source and boundary, if any.
    fn live_fork(&self, source_agent_id: &str, through_turn_id: &str) -> Result<Option<ForkRow>> {
        Ok(self.db.read()?.query_row(&format!("SELECT {FORK_COLUMNS} FROM codex_forks
            WHERE source_agent_id=?1 AND through_turn_id=?2 AND state IN {LIVE_FORK_STATES}"),
            [source_agent_id, through_turn_id], fork_from_row).optional()?)
    }
    pub(crate) fn agent_exists(&self, id: &str) -> Result<bool> {
        Ok(self.db.read()?.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)", [id], |r| r.get(0))?)
    }
    fn fork_agent_exists(&self, row: &ForkRow) -> Result<bool> {
        row.fork_agent_id.as_deref().map_or(Ok(false), |id| self.agent_exists(id))
    }
    /// Open or closed Agents whose continuation link points at this one.
    pub(crate) fn forked_to(&self, agent_id: &str) -> Result<Vec<String>> {
        let db = self.db.read()?;
        let mut query = db.prepare("SELECT id FROM agents WHERE json_extract(data,'$.codexHandoff.forkedTo.agentId')=?1")?;
        let ids = query.query_map([agent_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }
    fn begin_fork(&self, request_id: &str, source_agent_id: &str, source_thread_id: &str, through_turn_id: &str) -> Result<ForkRow> {
        let created = chrono::Utc::now().timestamp();
        self.db.write()?.execute(&format!("INSERT INTO codex_forks({FORK_COLUMNS}) VALUES(?1,?2,?3,?4,'requested',NULL,NULL,NULL,?5)"),
            params![request_id, source_agent_id, source_thread_id, through_turn_id, created])?;
        Ok(ForkRow { request_id: request_id.into(), source_agent_id: source_agent_id.into(),
            source_thread_id: source_thread_id.into(), through_turn_id: through_turn_id.into(), state: "requested".into(),
            fork_thread_id: None, fork_agent_id: None, error: None, created_unix: created })
    }
    fn set_fork_state(&self, request_id: &str, state: &str, fork_thread_id: Option<&str>, error: Option<&str>) -> Result<()> {
        self.db.write()?.execute("UPDATE codex_forks SET state=?2, fork_thread_id=COALESCE(?3,fork_thread_id), error=?4
            WHERE request_id=?1", params![request_id, state, fork_thread_id, error])?;
        Ok(())
    }
    fn link_fork_agent(&self, request_id: &str, agent_id: &str) -> Result<()> {
        self.db.write()?.execute("UPDATE codex_forks SET fork_agent_id=?2 WHERE request_id=?1", [request_id, agent_id])?;
        Ok(())
    }
    /// Registers a verified fork in one transaction: the Agent, its native
    /// history baseline (no unread for copied Turns), Project membership when
    /// still assignable, and the completed request. Returns whether the
    /// Project was kept.
    fn insert_codex_fork(&self, detail: &AgentDetail, baseline: &[Value], project_id: Option<&str>, request_id: &str) -> Result<(Agent, bool)> {
        // Serialized before the writer is taken.
        let rows = crate::record_rows::split(detail)?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let thread_id = detail.agent.thread_id.as_deref().context("fork 缺少原生会话 ID")?;
        crate::record_rows::insert(&tx, &detail.agent.id, &rows)?;
        // The explicit fork authorizes continuing; no separate handoff gate.
        tx.execute("INSERT INTO codex_imports(agent_id,thread_id,awaiting_handoff) VALUES(?1,?2,0)", params![detail.agent.id, thread_id])?;
        for turn in baseline {
            if matches!(turn["status"].as_str(), Some("completed" | "failed" | "interrupted")) {
                tx.execute("INSERT OR IGNORE INTO codex_import_turns(agent_id,turn_id) VALUES(?1,?2)", params![detail.agent.id, turn["id"].as_str()])?;
            }
        }
        let project_kept = match project_id {
            Some(project) if !crate::projects::is_archived(&tx, project)? => {
                crate::projects::set_agent_project_in(&tx, &detail.agent.id, Some(project))?;
                true
            }
            _ => false,
        };
        tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'thread/forked',?2,?3)",
            params![detail.agent.id, json!({"threadId":thread_id,"historicalTurns":baseline.len(),
                "forkedFrom":detail.codex_handoff.as_ref().and_then(|h| h.forked_from.as_ref())}).to_string(), now()])?;
        tx.execute("UPDATE codex_forks SET state='completed', fork_agent_id=?2, error=NULL WHERE request_id=?1",
            params![request_id, detail.agent.id])?;
        tx.commit()?;
        let mut agent = detail.agent.clone();
        if project_kept { agent.project_id = project_id.map(str::to_owned); }
        Ok((agent, project_kept))
    }
    fn insert_codex_import(&self, detail: &AgentDetail, baseline: &[Value]) -> Result<Agent> {
        // Serialized before the writer is taken.
        let rows = crate::record_rows::split(detail)?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let thread_id = detail.agent.thread_id.as_deref().context("导入缺少原生会话 ID")?;
        let existing: Option<String> = tx.query_row("SELECT id FROM agents WHERE json_extract(data,'$.agent.threadId')=?1
            AND COALESCE(json_extract(data,'$.agent.harness'),'codex')='codex'
            AND json_extract(data,'$.agent.remote') IS NULL LIMIT 1", [thread_id], |r| r.get(0)).optional()?;
        if let Some(existing) = existing {
            // As listed, with its rail summary. The duplicate check can race
            // creation or a membership change. Membership stays in its link
            // table, including on this return path.
            let mut agent = self.brief_in(&tx, &existing)?.context("Agent 不存在")?.agent;
            agent.project_id = crate::projects::agent_project(&tx, &agent.id)?;
            return Ok(agent);
        }
        crate::record_rows::insert(&tx, &detail.agent.id, &rows)?;
        tx.execute("INSERT INTO codex_imports(agent_id,thread_id) VALUES(?1,?2)", params![detail.agent.id, thread_id])?;
        for turn in baseline {
            if matches!(turn["status"].as_str(), Some("completed" | "failed" | "interrupted")) {
                tx.execute("INSERT OR IGNORE INTO codex_import_turns(agent_id,turn_id) VALUES(?1,?2)", params![detail.agent.id, turn["id"].as_str()])?;
            }
        }
        // The imported history is already read. No synthetic completions,
        // mailbox delivery, or transcript-sized journal entries are created.
        tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'thread/imported',?2,?3)",
            params![detail.agent.id,json!({"threadId":thread_id,"historicalTurns":baseline.len()}).to_string(),now()])?;
        tx.commit()?;
        Ok(detail.agent.clone())
    }
}
