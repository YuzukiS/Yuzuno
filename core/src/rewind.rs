//! Explicit native conversation rewind. Archives precede the wire write;
//! an unconfirmed attempt is checked, never sent again. Files are separate.
use crate::{
    model::{ensure_agent_open, now, AgentDetail, HistoryWindow},
    rpc::{Rpc, RpcError},
    server::ApiError,
    store::Store,
    workspace::{Connection, Workspace},
};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock, Mutex, Weak},
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(600);
const MAX_TURNS: usize = 1000;
const MAX_ARCHIVE: usize = 32 * 1024 * 1024;
struct Preview {
    owner: Weak<Workspace>,
    agent: String,
    thread: String,
    target: String,
    generation: u64,
    baseline: Vec<Value>,
    draft: String,
    at: Instant,
}
static PREVIEWS: LazyLock<Mutex<HashMap<String, Preview>>> = LazyLock::new(Default::default);

#[derive(Clone, Serialize, Deserialize)]
struct Attempt {
    id: String,
    agent: String,
    thread: String,
    target: String,
    kept: Vec<String>,
    draft: String,
    state: String,
    message: Option<String>,
}
impl Attempt {
    fn outcome(&self) -> Value {
        json!({"attemptId":self.id,"status":self.state,"message":self.message,"draft":self.draft})
    }
}

pub(crate) fn migrate(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS conversation_rewinds(
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL,
        attempt TEXT NOT NULL, native_archive TEXT NOT NULL, local_archive TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS conversation_rewinds_agent ON conversation_rewinds(agent_id);
        CREATE UNIQUE INDEX IF NOT EXISTS conversation_rewinds_pending ON conversation_rewinds(agent_id) WHERE state IN ('sending','unknown');")?;
    Ok(())
}
impl Store {
    fn rewind_attempt(&self, agent: &str, id: Option<&str>) -> Result<Option<Attempt>> {
        let value: Option<String> = if let Some(id) = id {
            self.db
                .read()?
                .query_row(
                    "SELECT attempt FROM conversation_rewinds WHERE agent_id=?1 AND id=?2",
                    params![agent, id],
                    |r| r.get(0),
                )
                .optional()?
        } else {
            self.db.read()?.query_row("SELECT attempt FROM conversation_rewinds WHERE agent_id=?1 AND state IN ('sending','unknown')", [agent], |r| r.get(0)).optional()?
        };
        value.map(|v| Ok(serde_json::from_str(&v)?)).transpose()
    }
    pub(crate) fn ensure_no_pending_rewind(&self, agent: &str) -> Result<()> {
        ensure!(self.rewind_attempt(agent, None)?.is_none(), "A conversation rewind is unconfirmed. Reconnect to check its outcome before sending; it will not be repeated.");
        Ok(())
    }
    fn save_rewind(&self, attempt: &Attempt) -> Result<()> {
        self.db.write()?.execute(
            "UPDATE conversation_rewinds SET state=?2,attempt=?3 WHERE id=?1",
            params![attempt.id, attempt.state, serde_json::to_string(attempt)?],
        )?;
        Ok(())
    }
}

fn idle(detail: &AgentDetail) -> Result<()> {
    ensure_agent_open(&detail.agent)?;
    ensure!(
        !matches!(
            detail.agent.status.as_str(),
            "working" | "waiting" | "uncertain"
        ) && !detail.turns.iter().any(|t| t["status"] == "inProgress")
            && !detail.pending.iter().any(|p| !p.stale)
            && !detail
                .message_receipts
                .iter()
                .any(|r| matches!(r.status.as_str(), "sending" | "uncertain")),
        "Finish the active turn or pending answer, and confirm delivery before rewinding"
    );
    Ok(())
}
fn ids(turns: &[Value]) -> Result<Vec<String>> {
    let out: Vec<String> = turns
        .iter()
        .map(|t| {
            t["id"]
                .as_str()
                .map(str::to_owned)
                .context("Native history is missing a turn identity")
        })
        .collect::<Result<_>>()?;
    ensure!(
        out.iter().collect::<HashSet<_>>().len() == out.len(),
        "Native history repeated a turn identity"
    );
    Ok(out)
}
fn same_history(a: &[Value], b: &[Value]) -> bool {
    a == b
}
fn native_available(thread: &Value) -> Result<()> {
    ensure!(thread["historyMode"] == "paginated" && thread["ephemeral"] == false,
        "Conversation rewind needs a persistent paginated Codex session; this legacy or temporary session cannot be rewound");
    let version: Vec<u64> = thread["cliVersion"]
        .as_str()
        .unwrap_or_default()
        .split('.')
        .filter_map(|v| v.parse().ok())
        .collect();
    ensure!(
        version.len() == 3 && version.as_slice() >= [0, 162, 1].as_slice(),
        "This Codex version has not been verified for thread/revert (requires 0.162.1 or later)"
    );
    ensure!(
        thread["status"]["type"] == "idle",
        "The native Codex session is not idle"
    );
    Ok(())
}
async fn history(rpc: &Rpc, thread: &str) -> Result<Vec<Value>> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut turns = Vec::new(); let mut cursor: Option<String> = None; let mut seen = HashSet::new();
        loop {
            let page = rpc.request("thread/turns/list", json!({"threadId":thread,"cursor":cursor,"limit":100,"sortDirection":"asc","itemsView":"full"})).await?;
            turns.extend(page["data"].as_array().context("Codex did not return a history page")?.iter().cloned());
            ensure!(turns.len() <= MAX_TURNS && serde_json::to_vec(&turns)?.len() <= MAX_ARCHIVE, "This conversation exceeds the bounded rewind preview; nothing changed");
            ensure!(turns.iter().all(|t| t["status"] != "inProgress" && t["itemsView"] == "full"), "Native history is active or incomplete; nothing changed");
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            match &cursor { None => break, Some(c) => ensure!(seen.insert(c.clone()), "Native history cursor did not advance") }
        }
        ids(&turns)?;
        Ok(turns)
    }).await.context("Native rewind history check timed out")?
}
fn project(detail: &mut AgentDetail, kept: &[String], recent: Vec<Value>, history: HistoryWindow) {
    detail.turns.retain(|t| {
        t["id"]
            .as_str()
            .is_some_and(|id| kept.iter().any(|k| k == id))
    });
    for turn in recent {
        if !detail.turns.iter().any(|t| t["id"] == turn["id"]) {
            detail.turns.push(turn);
        }
    }
    detail.turns.sort_by_key(|t| {
        kept.iter()
            .position(|id| t["id"] == *id)
            .unwrap_or(usize::MAX)
    });
    detail.history = Some(history);
    // Receipts, artifacts, tasks, approvals and execution records remain evidence.
    // No native approval can be pending at admission. Historical questions stay
    // in the archive and task records, rather than inviting a reply to a removed turn.
    detail.pending.retain(|p| {
        p.params["turnId"]
            .as_str()
            .is_none_or(|id| kept.iter().any(|k| k == id))
    });
    detail.agent.last_message = detail
        .turns
        .iter()
        .rev()
        .filter_map(|t| t["items"].as_array())
        .flat_map(|items| items.iter().rev())
        .find(|item| item["type"] == "agentMessage")
        .and_then(|item| item["text"].as_str())
        .map(str::to_owned);
    detail.context_usage = None;
    detail.agent.status = "idle".into();
    detail.agent.connection_state = "connected".into();
}

impl Workspace {
    pub(crate) async fn ensure_rewind_settled(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.stored(move |s| s.ensure_no_pending_rewind(&id)).await
    }
    pub async fn rewind_preview(self: &Arc<Self>, id: &str, target: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let agent = id.to_owned();
        if let Some(attempt) = self.stored(move |s| s.rewind_attempt(&agent, None)).await? {
            return Ok(
                json!({"available":false,"attempt":attempt.outcome(),"reason":"A previous rewind is unconfirmed. Check that attempt; it will not be sent again."}),
            );
        }
        let d = self.detail(id).await?;
        idle(&d)?;
        if d.agent.harness != "codex" {
            let uuid = d
                .turns
                .iter()
                .find(|t| t["id"] == target)
                .and_then(|t| t["items"].as_array())
                .and_then(|items| {
                    items
                        .iter()
                        .find(|i| i["type"] == "userMessage" && i["_yuzunoDelivery"].is_null())
                })
                .and_then(|i| i["nativeUuid"].as_str());
            return Ok(
                json!({"available":false,"fileUserMessageId":uuid,"reason":"The currently integrated Claude SDK/CLI version does not provide a persistent in-place conversation rewind. File restore is available separately."}),
            );
        }
        if d.agent.remote.is_some() {
            return Ok(
                json!({"available":false,"reason":"Conversation rewind over SSH has not been verified in this version. No remote conversation will be changed."}),
            );
        }
        let c = self.ensure(id).await?;
        if let Some(events) = &c.events {
            events.drain().await?;
        }
        let d = self.detail(id).await?;
        idle(&d)?;
        let thread = d
            .agent
            .thread_id
            .clone()
            .context("No native conversation identity is available")?;
        let meta = c
            .rpc
            .request(
                "thread/read",
                json!({"threadId":thread,"includeTurns":false}),
            )
            .await?;
        ensure!(
            meta["thread"]["id"] == thread,
            "Codex returned another conversation"
        );
        if let Err(e) = native_available(&meta["thread"]) {
            return Ok(json!({"available":false,"reason":e.to_string()}));
        }
        let baseline = history(&c.rpc, &thread).await?;
        let index = baseline
            .iter()
            .position(|t| t["id"] == target)
            .context("The selected turn is no longer in native history")?;
        let user = baseline[index]["items"]
            .as_array()
            .and_then(|items| items.iter().find(|i| i["type"] == "userMessage"))
            .context("The native turn has no user-message mapping for rewind")?;
        // Older paginated turns need not be cached in Core. The exact native
        // turn ID determines the boundary, never its displayed row number.
        let local = d
            .turns
            .iter()
            .find(|t| t["id"] == target)
            .and_then(|t| t["items"].as_array())
            .and_then(|items| items.iter().find(|i| i["type"] == "userMessage"));
        let draft = local
            .and_then(|i| i["_yuzunoInputText"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| crate::message_content::text(user));
        let key = uuid::Uuid::new_v4().to_string();
        let response = json!({"available":true,"previewId":key,"beforeTurnId":target,"removedTurns":baseline.len()-index,"keptTurns":index,"draft":draft,"expiresInSeconds":TTL.as_secs()});
        let mut previews = PREVIEWS.lock().unwrap();
        let owner = Arc::downgrade(self);
        previews.retain(|_, p| {
            p.at.elapsed() < TTL
                && p.owner.strong_count() > 0
                && (p.agent != id || !p.owner.ptr_eq(&owner))
        });
        previews.insert(
            key,
            Preview {
                owner,
                agent: id.into(),
                thread,
                target: target.into(),
                generation: c.generation,
                baseline,
                draft,
                at: Instant::now(),
            },
        );
        Ok(response)
    }

    pub async fn rewind_confirm(self: &Arc<Self>, id: &str, key: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (agent, key_owned) = (id.to_owned(), key.to_owned());
        if let Some(attempt) = self
            .stored(move |s| s.rewind_attempt(&agent, Some(&key_owned)))
            .await?
        {
            return Ok(attempt.outcome());
        }
        self.ensure_rewind_settled(id).await?;
        let p = PREVIEWS
            .lock()
            .unwrap()
            .remove(key)
            .filter(|p| p.agent == id && p.owner.ptr_eq(&Arc::downgrade(self)))
            .context("This preview was used or expired; nothing was sent")?;
        ensure!(p.at.elapsed() < TTL, "This preview expired; preview again");
        let d = self.detail(id).await?;
        idle(&d)?;
        ensure!(
            d.agent.thread_id.as_deref() == Some(p.thread.as_str()),
            "The native session changed after the preview"
        );
        let c = self
            .rpcs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .filter(|c| c.generation == p.generation && !c.closing)
            .context("The connection changed after the preview")?;
        if let Some(events) = &c.events {
            events.drain().await?;
        }
        let current = history(&c.rpc, &p.thread).await?;
        ensure!(
            same_history(&p.baseline, &current),
            "Native history changed after the preview; nothing was rewound"
        );
        idle(&self.detail(id).await?)?;
        let index = current
            .iter()
            .position(|t| t["id"] == p.target)
            .context("The selected turn disappeared")?;
        let mut attempt = Attempt {
            id: key.into(),
            agent: id.into(),
            thread: p.thread,
            target: p.target,
            kept: ids(&current[..index])?,
            draft: p.draft,
            state: "sending".into(),
            message: None,
        };
        let (saved, local, native) = (
            attempt.clone(),
            serde_json::to_string(&d)?,
            serde_json::to_string(&current[index..])?,
        );
        ensure!(
            local.len() + native.len() <= MAX_ARCHIVE,
            "Rewind archive exceeds the safe size; nothing was sent"
        );
        self.stored(move |s| {
            s.db.write()?.execute("INSERT INTO conversation_rewinds(id,agent_id,state,attempt,native_archive,local_archive,created_at) VALUES(?1,?2,'sending',?3,?4,?5,?6)", params![saved.id,saved.agent,serde_json::to_string(&saved)?,native,local,now()])?;
            Ok(())
        }).await?;
        // A single native mutation. A timeout/disconnect leaves this durable
        // attempt blocking new input until a read verifies the exact prefix.
        let native = c
            .rpc
            .request(
                "thread/revert",
                json!({"threadId":attempt.thread,"beforeTurnId":attempt.target}),
            )
            .await;
        match native {
            Err(e) if e.downcast_ref::<RpcError>().is_some() => {
                attempt.state = "failed".into();
                attempt.message = Some(e.to_string());
            }
            result => {
                attempt.state = "unknown".into();
                attempt.message = result.err().map(|e| e.to_string());
                let saved = attempt.clone();
                self.stored(move |s| s.save_rewind(&saved)).await?;
                if let Err(e) = self.finish_rewind(id, &c, &mut attempt).await {
                    attempt.message = Some(format!(
                        "Rewind outcome is unconfirmed: {e:#}. It will not be sent again."
                    ));
                }
            }
        }
        let saved = attempt.clone();
        self.stored(move |s| s.save_rewind(&saved)).await?;
        self.changed(id);
        Ok(attempt.outcome())
    }
    async fn finish_rewind(&self, id: &str, c: &Connection, attempt: &mut Attempt) -> Result<()> {
        self.apply_rewind_history(id, c, attempt, false).await
    }
    async fn apply_rewind_history(
        &self,
        id: &str,
        c: &Connection,
        attempt: &mut Attempt,
        accept_current: bool,
    ) -> Result<()> {
        let current = history(&c.rpc, &attempt.thread).await?;
        let current_ids = ids(&current)?;
        let matched = current_ids == attempt.kept;
        ensure!(
            matched || accept_current,
            "Native history does not yet match the requested prefix"
        );
        if let Some(events) = &c.events {
            events.drain().await?;
        }
        let page = crate::codex_sessions::history_page(&c.rpc, &attempt.thread, None).await?;
        ensure!(
            ids(&page.turns)?.iter().all(|id| current_ids.contains(id)),
            "Native history changed while confirming the retained page"
        );
        let owned = self.owner(id).await;
        ensure!(
            self.codex_connection(id)
                .is_some_and(|(g, _)| g == c.generation),
            "The connection changed while confirming rewind"
        );
        let (agent, kept, operation, thread) = (
            id.to_owned(),
            current_ids,
            attempt.id.clone(),
            attempt.thread.clone(),
        );
        self.stored_owned(owned, move |s| {
            let d = s.detail(&agent)?;
            ensure!(
                d.agent.thread_id.as_deref() == Some(thread.as_str()),
                "The session changed while confirming rewind"
            );
            let window = HistoryWindow {
                loaded_count: page.turns.len(),
                has_more: page.has_more,
                next_cursor: page.next_cursor,
            };
            s.update(
                &agent,
                if accept_current {
                    "conversation/rewindResolved"
                } else {
                    "conversation/rewound"
                },
                &json!({"attemptId":operation,"keptTurnIds":kept}),
                move |d| project(d, &kept, page.turns, window),
            )?;
            Ok(())
        })
        .await?;
        attempt.state = if matched { "completed" } else { "resolved" }.into();
        attempt.message = if matched {
            None
        } else {
            Some("Kept the current native history at your request. The original rewind outcome remains unconfirmed; it was not repeated.".into())
        };
        Ok(())
    }
    pub(crate) async fn recover_rewind(&self, id: &str, c: &Connection) -> Result<bool> {
        let agent = id.to_owned();
        let Some(mut attempt) = self.stored(move |s| s.rewind_attempt(&agent, None)).await? else {
            return Ok(false);
        };
        if let Err(e) = self.finish_rewind(id, c, &mut attempt).await {
            attempt.state = "unknown".into();
            attempt.message = Some(format!("{e:#}. Check again or explicitly keep the current native history; the rewind will not be repeated."));
        }
        self.stored(move |s| s.save_rewind(&attempt)).await?;
        self.changed(id);
        Ok(true)
    }
    /// Explicit escape from an unknown outcome. Stop the owned local runtime
    /// before accepting a fresh snapshot, so a delayed revert cannot run later.
    /// No native conversation mutation or model turn is submitted here.
    pub async fn rewind_resolve(self: &Arc<Self>, id: &str, key: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (agent, operation) = (id.to_owned(), key.to_owned());
        let mut a = self
            .stored(move |s| s.rewind_attempt(&agent, Some(&operation)))
            .await?
            .context("No rewind attempt exists")?;
        if !matches!(a.state.as_str(), "sending" | "unknown") {
            return Ok(a.outcome());
        }
        let d = self.detail(id).await?;
        idle(&d)?;
        ensure!(
            d.agent.harness == "codex" && d.agent.remote.is_none(),
            "Resolution requires a local Codex runtime"
        );
        ensure!(
            d.agent.thread_id.as_deref() == Some(a.thread.as_str()),
            "The native session changed; the attempt was not resolved"
        );
        let old = self.rpcs.lock().unwrap().get(id).cloned();
        if let Some(c) = old {
            // A stopped process needs no idle probe. A live process must report
            // idle before we terminate it, preserving any active native work.
            if c.rpc.is_running() {
                let meta = c
                    .rpc
                    .request(
                        "thread/read",
                        json!({"threadId":a.thread,"includeTurns":false}),
                    )
                    .await?;
                ensure!(
                    meta["thread"]["id"] == a.thread,
                    "Native conversation changed"
                );
                native_available(&meta["thread"])?;
            }
            c.rpc.close_and_wait().await?;
            self.remove_connection(id, c.generation).await;
        }
        let c = self.ensure(id).await?;
        let meta = c
            .rpc
            .request(
                "thread/read",
                json!({"threadId":a.thread,"includeTurns":false}),
            )
            .await?;
        ensure!(
            meta["thread"]["id"] == a.thread,
            "Native conversation changed"
        );
        native_available(&meta["thread"])?;
        self.apply_rewind_history(id, &c, &mut a, true).await?;
        let saved = a.clone();
        self.stored(move |s| s.save_rewind(&saved)).await?;
        self.reconcile_connection(id, &c).await?;
        self.changed(id);
        Ok(a.outcome())
    }
    pub async fn rewind_check(self: &Arc<Self>, id: &str, key: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let key_id = key.to_owned();
        let (agent, key) = (id.to_owned(), key.to_owned());
        let Some(mut a) = self
            .stored(move |s| s.rewind_attempt(&agent, Some(&key)))
            .await?
        else {
            return Ok(
                json!({"attemptId":key_id,"status":"failed","draft":"","message":"No native command was admitted for this preview. Close and preview again."}),
            );
        };
        if matches!(a.state.as_str(), "sending" | "unknown") {
            let c = self.ensure(id).await?;
            if let Err(e) = self.finish_rewind(id, &c, &mut a).await {
                a.state = "unknown".into();
                a.message = Some(format!("{e:#}. Nothing was sent again."));
            }
            let saved = a.clone();
            self.stored(move |s| s.save_rewind(&saved)).await?;
            self.changed(id);
        }
        Ok(a.outcome())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    turn_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Confirmation {
    preview_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Check {
    attempt_id: String,
}
async fn preview(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(p): Json<Target>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.rewind_preview(&id, &p.turn_id).await?))
}
async fn confirm(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(p): Json<Confirmation>,
) -> Result<Json<Value>, ApiError> {
    match ws.rewind_confirm(&id, &p.preview_id).await {
        Ok(value) => Ok(Json(value)),
        Err(error) => {
            // No durable attempt means admission refused before any wire write.
            // A persisted attempt must retain its sending/unknown outcome.
            let (agent, key) = (id.clone(), p.preview_id.clone());
            let attempt = ws
                .stored(move |s| s.rewind_attempt(&agent, Some(&key)))
                .await?;
            Ok(Json(attempt.map(|a| a.outcome()).unwrap_or_else(|| json!({
                "attemptId":p.preview_id,"status":"failed","draft":"","message":format!("{error:#}")
            }))))
        }
    }
}
async fn check(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(p): Json<Check>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.rewind_check(&id, &p.attempt_id).await?))
}
async fn resolve(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(p): Json<Check>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.rewind_resolve(&id, &p.attempt_id).await?))
}
pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/agents/{id}/rewind/preview", post(preview))
        .route("/api/agents/{id}/rewind/confirm", post(confirm))
        .route("/api/agents/{id}/rewind/check", post(check))
        .route("/api/agents/{id}/rewind/resolve", post(resolve))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn turn(id: &str) -> Value {
        json!({"id":id,"status":"completed","itemsView":"full","items":[{"id":format!("u-{id}"),"type":"userMessage","content":[{"type":"text","text":format!("original {id}")}]},{"id":format!("a-{id}"),"type":"agentMessage","text":format!("reply {id}")} ]})
    }
    async fn connection(ws: &Arc<Workspace>, path: &std::path::Path, generation: u64) {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(64);
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let rpc = Rpc::spawn(
            "python3",
            &[
                concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/rewind.py").into(),
                path.to_string_lossy().into(),
            ],
            tx,
        )
        .await
        .unwrap();
        ws.rpcs.lock().unwrap().insert(
            "a".into(),
            Connection {
                generation,
                rpc,
                closing: false,
                events: None,
                attachment: Arc::new(tokio::sync::Mutex::new(None)),
            },
        );
    }
    async fn fixture() -> (tempfile::TempDir, Arc<Workspace>) {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("native-fixture");
        std::fs::write(&program, format!("#!/usr/bin/env python3\nimport sys, runpy\nsys.argv = [{:?}, {:?}]\nrunpy.run_path(sys.argv[0], run_name='__main__')\n", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/rewind.py"), dir.path().to_string_lossy())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let ws = Workspace::new(
            dir.path().join("data"),
            dir.path().to_string_lossy().into(),
            program.to_string_lossy().into(),
        )
        .unwrap();
        let d:AgentDetail=serde_json::from_value(json!({"agent":{"id":"a","name":"Fixture","cwd":dir.path(),"model":"fixture","color":"yuzu","harness":"codex","threadId":"native-thread","status":"idle","createdAt":now(),"updatedAt":now(),"unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0,"connectionState":"connected"},"turns":[turn("1"),turn("2"),turn("3"),turn("4")],"pending":[],"artifacts":[]})).unwrap();
        ws.next_generation
            .store(10, std::sync::atomic::Ordering::Relaxed);
        ws.store.insert(&d).unwrap();
        std::fs::write(
            dir.path().join("native.json"),
            serde_json::to_vec(&d.turns).unwrap(),
        )
        .unwrap();
        connection(&ws, dir.path(), 1).await;
        (dir, ws)
    }
    async fn stop(ws: &Arc<Workspace>) {
        let c = ws.rpcs.lock().unwrap().remove("a");
        if let Some(c) = c {
            c.rpc.close_and_wait().await.unwrap();
        }
    }
    fn calls(dir: &tempfile::TempDir, method: &str) -> Vec<Value> {
        std::fs::read_to_string(dir.path().join("calls.jsonl")).unwrap_or_default().lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|r| r["method"] == method).collect()
    }
    #[tokio::test]
    async fn rewind_paged_boundary_is_durable_archived_and_sent_once() {
        let (dir, ws) = fixture().await;
        let p = ws.rewind_preview("a", "2").await.unwrap();
        assert_eq!(
            (p["keptTurns"].as_u64(), p["removedTurns"].as_u64()),
            (Some(1), Some(3))
        );
        assert!(!dir.path().join("writes").exists());
        let key = p["previewId"].as_str().unwrap();
        assert_eq!(
            ws.rewind_confirm("a", key).await.unwrap()["status"],
            "completed"
        );
        assert_eq!(ids(&ws.detail("a").await.unwrap().turns).unwrap(), ["1"]);
        assert_eq!(
            ws.detail("a").await.unwrap().agent.last_message.as_deref(),
            Some("reply 1")
        );
        assert_eq!(
            ws.rewind_confirm("a", key).await.unwrap()["status"],
            "completed"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("writes")).unwrap(),
            "2\n"
        );
        let archive: String = ws
            .store
            .db
            .read()
            .unwrap()
            .query_row(
                "SELECT native_archive FROM conversation_rewinds WHERE id=?1",
                [key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            ids(serde_json::from_str::<Vec<Value>>(&archive)
                .unwrap()
                .as_slice())
            .unwrap(),
            ["2", "3", "4"]
        );
        stop(&ws).await;
        let data = dir.path().join("data");
        drop(ws);
        let reopened =
            Workspace::new(data, dir.path().to_string_lossy().into(), "unused".into()).unwrap();
        assert_eq!(
            ids(&reopened.detail("a").await.unwrap().turns).unwrap(),
            ["1"]
        );
        assert!(reopened.store.ensure_no_pending_rewind("a").is_ok());
    }
    #[tokio::test]
    async fn rewind_refuses_busy_stale_legacy_and_missing_identity_without_writes() {
        let (dir, ws) = fixture().await;
        ws.update_record("a", "test", json!({}), |d| {
            d.turns[3]["status"] = "inProgress".into()
        })
        .await
        .unwrap();
        assert!(ws
            .rewind_preview("a", "2")
            .await
            .unwrap_err()
            .to_string()
            .contains("active turn"));
        ws.update_record("a", "test", json!({}), |d| {
            d.turns[3]["status"] = "completed".into()
        })
        .await
        .unwrap();
        assert!(ws.rewind_preview("a", "missing").await.is_err());
        std::fs::write(dir.path().join("legacy"), "").unwrap();
        assert_eq!(
            ws.rewind_preview("a", "2").await.unwrap()["available"],
            false
        );
        std::fs::remove_file(dir.path().join("legacy")).unwrap();
        let p = ws.rewind_preview("a", "2").await.unwrap();
        std::fs::write(
            dir.path().join("native.json"),
            serde_json::to_vec(&vec![turn("1"), turn("2"), turn("3"), turn("4"), turn("5")])
                .unwrap(),
        )
        .unwrap();
        assert!(ws
            .rewind_confirm("a", p["previewId"].as_str().unwrap())
            .await
            .unwrap_err()
            .to_string()
            .contains("changed after"));
        assert!(!dir.path().join("writes").exists());
        assert_eq!(
            ws.rewind_check("a", p["previewId"].as_str().unwrap())
                .await
                .unwrap()["status"],
            "failed"
        );
        stop(&ws).await;
    }
    #[tokio::test]
    async fn rewind_lost_reply_blocks_input_and_reconnect_checks_without_repeating() {
        let (dir, ws) = fixture().await;
        let p = ws.rewind_preview("a", "1").await.unwrap();
        let key = p["previewId"].as_str().unwrap();
        std::fs::write(dir.path().join("disconnect"), "").unwrap();
        let result = ws.rewind_confirm("a", key).await.unwrap();
        assert_eq!(result["status"], "unknown");
        assert!(ws.ensure_rewind_settled("a").await.is_err());
        assert_eq!(
            ws.rewind_confirm("a", key).await.unwrap()["status"],
            "unknown"
        );
        assert_eq!(ws.detail("a").await.unwrap().turns.len(), 4);
        connection(&ws, dir.path(), 2).await;
        assert_eq!(
            ws.rewind_check("a", key).await.unwrap()["status"],
            "completed"
        );
        assert!(ws.detail("a").await.unwrap().turns.is_empty());
        assert!(ws.detail("a").await.unwrap().agent.last_message.is_none());
        assert!(ws.ensure_rewind_settled("a").await.is_ok());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("writes")).unwrap(),
            "1\n"
        );
        stop(&ws).await;
    }
    #[tokio::test]
    async fn rewind_native_refusal_preserves_history() {
        let (dir, ws) = fixture().await;
        let p = ws.rewind_preview("a", "3").await.unwrap();
        std::fs::write(dir.path().join("refuse"), "").unwrap();
        let r = ws
            .rewind_confirm("a", p["previewId"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(r["status"], "failed");
        assert_eq!(ws.detail("a").await.unwrap().turns.len(), 4);
        assert!(ws.ensure_rewind_settled("a").await.is_ok());
        stop(&ws).await;
    }

    #[tokio::test]
    async fn rewind_unknown_can_keep_unchanged_or_externally_extended_history_without_resend() {
        for changed in [false, true] {
            let (dir, ws) = fixture().await;
            ws.update_record("a", "test/context", json!({}), |d| {
                d.agent.settings.context_window = Some(872000);
                d.agent.settings.auto_compact_token_limit = Some(600000);
                d.agent.settings.reasoning_effort = Some("high".into());
            }).await.unwrap();
            let p = ws.rewind_preview("a", "2").await.unwrap();
            let key = p["previewId"].as_str().unwrap();
            std::fs::write(dir.path().join("disconnect-before"), "").unwrap();
            assert_eq!(
                ws.rewind_confirm("a", key).await.unwrap()["status"],
                "unknown"
            );
            if changed {
                std::fs::write(
                    dir.path().join("native.json"),
                    serde_json::to_vec(&vec![turn("1"), turn("external")]).unwrap(),
                )
                .unwrap();
            }
            connection(&ws, dir.path(), 2).await;
            let c = ws.rpcs.lock().unwrap().get("a").unwrap().clone();
            ws.reconcile_connection("a", &c).await.unwrap();
            assert!(ws.ensure_rewind_settled("a").await.is_err());
            assert_eq!(
                ws.detail("a").await.unwrap().agent.connection_state,
                "connected"
            );
            // Reconciliation can show idle/connected while rewind remains
            // unknown. Neither the editor nor a direct Apply may reload it.
            assert_eq!(ws.agent_catalog("a").await.unwrap()["context"]["canApply"], false);
            let resumes = calls(&dir, "thread/resume").len();
            let unsubscribes = calls(&dir, "thread/unsubscribe").len();
            let error = ws.apply_codex_context("a").await.unwrap_err();
            assert!(error.to_string().contains("rewind is unconfirmed"), "{error:#}");
            assert_eq!(calls(&dir, "thread/resume").len(), resumes);
            assert_eq!(calls(&dir, "thread/unsubscribe").len(), unsubscribes);
            let resolved = ws.rewind_resolve("a", key).await.unwrap();
            assert_eq!(resolved["status"], "resolved");
            assert!(ws.ensure_rewind_settled("a").await.is_ok());
            let resume = calls(&dir, "thread/resume").pop().unwrap();
            assert_eq!(resume["params"]["threadId"], "native-thread");
            assert_eq!(resume["params"]["config"]["model_context_window"], 872000);
            assert_eq!(resume["params"]["config"]["model_auto_compact_token_limit"], 600000);
            assert_eq!(resume["params"]["config"]["model_reasoning_effort"], "high");
            let saved = ws.detail("a").await.unwrap().agent.settings;
            assert_eq!(saved.context_window, Some(872000));
            assert_eq!(saved.auto_compact_token_limit, Some(600000));
            assert_eq!(saved.reasoning_effort.as_deref(), Some("high"));
            assert_eq!(ws.agent_catalog("a").await.unwrap()["context"]["canApply"], true);
            assert_eq!(ws.apply_codex_context("a").await.unwrap()["settingsSubmitted"], true);
            assert_eq!(calls(&dir, "thread/unsubscribe").len(), unsubscribes + 1);
            assert!(calls(&dir, "turn/start").is_empty());
            let expected = if changed {
                vec!["1", "external"]
            } else {
                vec!["1", "2", "3", "4"]
            };
            assert_eq!(ids(&ws.detail("a").await.unwrap().turns).unwrap(), expected);
            assert_eq!(
                std::fs::read_to_string(dir.path().join("writes")).unwrap(),
                "2\n"
            );
            assert_eq!(
                ws.rewind_confirm("a", key).await.unwrap()["status"],
                "resolved"
            );
            stop(&ws).await;
        }
    }
    #[tokio::test]
    async fn rewind_recovery_continues_normal_reconciliation() {
        let (dir, ws) = fixture().await;
        let p = ws.rewind_preview("a", "2").await.unwrap();
        std::fs::write(dir.path().join("disconnect"), "").unwrap();
        assert_eq!(
            ws.rewind_confirm("a", p["previewId"].as_str().unwrap())
                .await
                .unwrap()["status"],
            "unknown"
        );
        connection(&ws, dir.path(), 2).await;
        ws.update_record("a", "test/error", json!({}), |d| {
            d.agent.error = Some("Codex 连接已关闭".into())
        })
        .await
        .unwrap();
        let c = ws.rpcs.lock().unwrap().get("a").unwrap().clone();
        ws.reconcile_connection("a", &c).await.unwrap();
        assert!(ws.detail("a").await.unwrap().agent.error.is_none());
        assert_eq!(ids(&ws.detail("a").await.unwrap().turns).unwrap(), ["1"]);
        assert!(ws.ensure_rewind_settled("a").await.is_ok());
        stop(&ws).await;
    }
    #[tokio::test]
    async fn rewind_http_admission_failure_is_definite_without_a_draft() {
        let (_dir, ws) = fixture().await;
        let result = confirm(
            State(ws.clone()),
            Path("a".into()),
            Json(Confirmation {
                preview_id: "missing".into(),
            }),
        )
        .await
        .ok()
        .expect("definite HTTP result")
        .0;
        assert_eq!(result["status"], "failed");
        assert_eq!(result["draft"], "");
        stop(&ws).await;
    }

    #[tokio::test]
    async fn rewind_target_can_be_older_than_the_cached_window() {
        let (_dir, ws) = fixture().await;
        ws.update_record("a", "test/window", json!({}), |d| {
            d.turns.drain(..2);
        })
        .await
        .unwrap();
        let p = ws.rewind_preview("a", "1").await.unwrap();
        assert_eq!(p["draft"], "original 1");
        assert_eq!(p["removedTurns"], 4);
        assert_eq!(
            ws.rewind_confirm("a", p["previewId"].as_str().unwrap())
                .await
                .unwrap()["status"],
            "completed"
        );
        assert!(ws.detail("a").await.unwrap().turns.is_empty());
        assert!(ws.detail("a").await.unwrap().agent.last_message.is_none());
        stop(&ws).await;
    }
}
