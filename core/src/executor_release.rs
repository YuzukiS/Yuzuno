//! Releasing an executor (T-34, executor model phase 1; docs/executor-model.md):
//! once its work is accepted, the Agent that dispatched it from a template,
//! or the user, closes it for good.
//!
//! A release is a close: its runtime stops as Close stops it, and the
//! `agent/closed` row it writes says it was a release and who made it. The
//! transaction that writes that row archives the executor's `agent_roles`
//! row (`follow_close`, called from store.rs `change_locked`), where T-35's
//! `executor_slots::follow_agent` releases its slot, so the close, the
//! archive and the slot commit or fail together. An executor closed before
//! is archived in its own transaction. A released executor is not reopened;
//! the user can still delete it. Releasing changes nothing of its task, its
//! dispatch or its result: accepting the work is recorded on the task.
use crate::{
    collaboration_store::{actor_context, executor_dispatch::actor_key},
    model::{now, Agent},
    server::ApiError,
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

/// The `reason` of a release's `agent/closed` row.
const RELEASED: &str = "released";

/// Why a released executor's Reopen is refused.
pub(crate) const REOPEN_REFUSED: &str =
    "executor_released: a released executor stays closed; dispatch the task again for new work";

pub(crate) fn tool_definition() -> Value {
    json!({
        "name":"executor_release",
        "description":"Release an executor once its work is accepted: Core closes it for good. Only the Agent that dispatched it from an executor template, or the user, may release it. Its runtime stops as on Close, its executor slot is freed, and it is never reopened. Its task, dispatch and result stay as they are: releasing does not accept the work, so record that on the task. Refused while Core prepares an update, as Close is. Releasing a released executor answers with the same releasedAt.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["requestId","agentId"],"properties":{
            "requestId":{"type":"string","minLength":1,"maxLength":128,"description":"Stable retry key. Reuse only when retrying exactly this operation and payload."},
            "agentId":{"type":"string","minLength":1,"description":"The executor, as peers_list or the task's dispatch names it."}}}
    })
}

pub async fn call(ws: Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let input = input.as_object().context("invalid_input: expected an object")?;
    if let Some(key) = input.keys().find(|key| !matches!(key.as_str(), "requestId" | "agentId")) {
        bail!("invalid_input: unknown field {key}");
    }
    let request = input.get("requestId").and_then(Value::as_str).unwrap_or_default();
    ensure!((1..=128).contains(&request.len()), "invalid_input: requestId is 1 to 128 bytes");
    let agent = input.get("agentId").and_then(Value::as_str).filter(|id| !id.is_empty())
        .context("invalid_input: agentId is required")?;
    ws.release_executor(actor.as_deref(), agent).await
}

/// When `agent` was released: `None` unless it is a released executor.
pub(crate) fn released_at(db: &Connection, agent: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT archived_at FROM agent_roles WHERE agent_id=?1 AND kind='executor'", [agent], |r| r.get(0))
        .optional()?
        .flatten())
}

/// Every released executor and when, for listing them all at once.
pub(crate) fn released(db: &Connection) -> Result<HashMap<String, String>> {
    let mut query = db.prepare("SELECT agent_id,archived_at FROM agent_roles WHERE kind='executor' AND archived_at IS NOT NULL")?;
    let rows = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A release's close archives its executor, at its close's time, in the
/// transaction that records the close (store.rs `change_locked`).
pub(crate) fn follow_close(db: &Connection, agent: &Agent, kind: &str, data: &Value) -> Result<()> {
    if kind == "agent/closed" && data["reason"] == RELEASED {
        let at = agent.closed_at.as_deref().context("a release closes its executor")?;
        db.execute(
            "UPDATE agent_roles SET archived_at=?2,state='released',updated_at=?2 WHERE agent_id=?1 AND kind='executor' AND archived_at IS NULL",
            params![agent.id, at],
        )?;
    }
    Ok(())
}

/// Who releases `agent`, as the receipts key them, and when it was released
/// if it was. Refused unless it is an executor and `actor` is the user or
/// the Agent that dispatched it.
fn releaser(store: &Store, actor: Option<&str>, agent: &str) -> Result<(String, Option<String>)> {
    let db = store.db.read()?;
    let (actor, _) = actor_context(store, &db, actor)?;
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)", [agent], |r| r.get(0))?;
    ensure!(exists, "agent_not_found: no Agent has this ID");
    let row: Option<(Option<String>, Option<String>)> = db
        .query_row("SELECT created_by,archived_at FROM agent_roles WHERE agent_id=?1 AND kind='executor'", [agent], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let Some((dispatcher, released)) = row else {
        bail!("not_executor: only an executor Core made from a template is released; close any other Agent instead");
    };
    let by = actor_key(&actor);
    ensure!(
        actor.kind != "agent" || dispatcher.as_deref() == Some(by.as_str()),
        "not_dispatcher: only the Agent that dispatched this executor from a template, or the user, can release it"
    );
    Ok((by, released))
}

/// An executor closed before its release, archived in its own transaction;
/// false if it was archived already.
fn archive_closed(store: &Store, agent: &str) -> Result<bool> {
    let at = now();
    Ok(store.db.write()?.execute(
        "UPDATE agent_roles SET archived_at=?2,state='released',updated_at=?2 WHERE agent_id=?1 AND kind='executor' AND archived_at IS NULL",
        params![agent, at],
    )? > 0)
}

impl Workspace {
    /// `executor_release` by the Agent `actor`, or by the user (None).
    pub(crate) async fn release_executor(self: &Arc<Self>, actor: Option<&str>, id: &str) -> Result<Value> {
        // Refused while an update drains, as Close is.
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (caller, agent) = (actor.map(str::to_owned), id.to_owned());
        let (by, released) = self.stored(move |store| releaser(store, caller.as_deref(), &agent)).await?;
        if released.is_none() {
            if self.listed(id).await?.closed_at.is_none() {
                self.close_agent_locked(id, json!({"reason":RELEASED,"by":by})).await?;
            }
            // Closed before, or by another close meanwhile.
            let agent = id.to_owned();
            if self.stored(move |store| archive_closed(store, &agent)).await? {
                self.changed(id);
            }
        }
        let agent = self.listed(id).await?;
        Ok(json!({"agentId":agent.id,"closedAt":agent.closed_at,"releasedAt":agent.released_at}))
    }
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/release", post(release))
}

/// The user's release, from Agent management.
async fn release(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.release_executor(None, &id).await?))
}

#[cfg(test)]
#[path = "executor_release_tests.rs"]
mod tests;
