//! Releasing an executor (T-34, executor model phase 1; docs/executor-model.md):
//! once its work is accepted, the Agent that dispatched it from a template,
//! or the user, closes it for good.
//!
//! A release is a close: its runtime stops as Close stops it, and the
//! `agent/closed` row it writes says it was a release and who made it. While
//! anything of the executor's is still going it is archiving first, and is
//! closed once that ends (T-36, executor_archiving.rs). The Agent that
//! dispatched it, a lead of its task's Project, or the user releases it;
//! setting its task done does too. The
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
        "description":"Release an executor once its work is accepted: Core closes it for good. The Agent that dispatched it from an executor template, a lead of its task's Project, or the user may release it; setting its task done releases it too. While a Job of its runs, its delivery flow is under way or a pull request operation of its is in flight, it is archiving: its CI watches stop, its queued Jobs are held (refused at its close), it starts nothing new, and the answer's archiving.reason says what it waits for; Core closes it once that ends. Its runtime then stops as on Close, its executor slot is freed, its Brief sections go to its dispatcher if that Agent is open, and it is never reopened. Its task, dispatch and result stay as they are: releasing does not accept the work, so record that on the task. Refused while Core prepares an update, as Close is. The answer names releasedAt and releasedBy; releasing a released executor answers with the same.",
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

/// When a released executor was released, and by whom (as the receipts key
/// the caller).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Release {
    pub(crate) at: String,
    pub(crate) by: Option<String>,
}

/// `agent`'s release: `None` unless it is a released executor.
pub(crate) fn release_of(db: &Connection, agent: &str) -> Result<Option<Release>> {
    let row: Option<(Option<String>, Option<String>)> = db
        .query_row("SELECT archived_at,released_by FROM agent_roles WHERE agent_id=?1 AND kind='executor'", [agent], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    Ok(row.and_then(|(at, by)| Some(Release { at: at?, by })))
}

/// Every released executor's release, for listing them all at once.
pub(crate) fn releases(db: &Connection) -> Result<HashMap<String, Release>> {
    let mut query =
        db.prepare("SELECT agent_id,archived_at,released_by FROM agent_roles WHERE kind='executor' AND archived_at IS NOT NULL")?;
    let rows = query.query_map([], |r| Ok((r.get(0)?, Release { at: r.get(1)?, by: r.get(2)? })))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The Agent as answered names its release, as `kind` names its kind.
pub(crate) fn show(agent: &mut Agent, release: Option<Release>) {
    (agent.released_at, agent.released_by) = release.map_or((None, None), |r| (Some(r.at), r.by));
}

/// A release's close archives its executor, at its close's time and with who
/// released it, in the transaction that records the close (store.rs
/// `change_locked`).
pub(crate) fn follow_close(db: &Connection, agent: &Agent, kind: &str, data: &Value) -> Result<()> {
    if kind == "agent/closed" && data["reason"] == RELEASED {
        let at = agent.closed_at.as_deref().context("a release closes its executor")?;
        let archived = db.execute(
            "UPDATE agent_roles SET archived_at=?2,state='released',released_by=?3,updated_at=?2
             WHERE agent_id=?1 AND kind='executor' AND archived_at IS NULL",
            params![agent.id, at, data["by"].as_str()],
        )?;
        // Its Brief sections and undecided proposals go to its dispatcher, if open (T-36).
        if archived > 0 {
            crate::executor_archiving::follow_archive(db, agent)?;
        }
    }
    Ok(())
}

/// Who releases `agent`, as the receipts key them, and when it was released
/// if it was. Refused unless it is an executor and `actor` is the user, the
/// Agent that dispatched it, or a lead of its task's Project (T-36: the
/// user's decision of 2026-11-06); a lead of another Project is told so.
fn releaser(store: &Store, actor: Option<&str>, agent: &str) -> Result<(String, Option<String>)> {
    let db = store.db.read()?;
    let (actor, _) = actor_context(store, &db, actor)?;
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)", [agent], |r| r.get(0))?;
    ensure!(exists, "agent_not_found: no Agent has this ID");
    let row: Option<(Option<String>, Option<String>, Option<String>)> = db
        .query_row("SELECT created_by,archived_at,task_id FROM agent_roles WHERE agent_id=?1 AND kind='executor'", [agent], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    let Some((dispatcher, released, task)) = row else {
        bail!("not_executor: only an executor Core made from a template is released; close any other Agent instead");
    };
    let by = actor_key(&actor);
    if actor.kind == "agent" && dispatcher.as_deref() != Some(by.as_str()) {
        may_release_as_lead(&db, &actor.id, task.as_deref())?;
    }
    Ok((by, released))
}

/// An Agent that did not dispatch the executor of `task` releases it only as
/// a lead of that task's Project.
fn may_release_as_lead(db: &Connection, actor: &str, task: Option<&str>) -> Result<()> {
    const WHO: &str = "only the Agent that dispatched this executor, a lead of its task's Project, or the user can release it";
    let project: Option<String> = match task {
        Some(task) => db.query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [task], |r| r.get(0)).optional()?,
        None => None,
    };
    let Some(project) = project else { bail!("not_dispatcher: {WHO}") };
    if crate::agent_roles::leads(db, actor, &project)? {
        return Ok(());
    }
    let elsewhere: Option<String> =
        db.query_row("SELECT project_id FROM agent_roles WHERE agent_id=?1 AND kind='lead'", [actor], |r| r.get(0)).optional()?.flatten();
    let labels = crate::projects::project_labels(db)?;
    let name = |id: &str| labels.get(id).map(|(name, _)| name.clone()).unwrap_or_else(|| id.to_owned());
    match elsewhere.filter(|other| crate::agent_roles::leads(db, actor, other).unwrap_or(false)) {
        Some(other) => bail!(
            "not_project_lead: you lead {}, not {}, this executor's task's Project; {WHO}",
            name(&other),
            name(&project)
        ),
        None => bail!("not_dispatcher: {WHO}"),
    }
}

/// An executor closed before its release, archived by `by` in its own
/// transaction, with what its archive hands its dispatcher; false if it was
/// archived already.
fn archive_closed(store: &Store, agent: &str, by: &str) -> Result<bool> {
    let at = now();
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    let archived = tx.execute(
        "UPDATE agent_roles SET archived_at=?2,state='released',released_by=?3,updated_at=?2
         WHERE agent_id=?1 AND kind='executor' AND archived_at IS NULL",
        params![agent, at, by],
    )? > 0;
    if archived {
        let listed = store.brief_in(&tx, agent)?.map(|brief| brief.agent);
        if let Some(listed) = listed {
            crate::executor_archiving::follow_archive(&tx, &listed)?;
        }
    }
    tx.commit()?;
    Ok(archived)
}

/// The executors of `task` (its internal ID) not yet released.
fn executors_of(db: &Connection, task: &str) -> Result<Vec<String>> {
    let mut query = db.prepare("SELECT agent_id FROM agent_roles WHERE kind='executor' AND task_id=?1 AND archived_at IS NULL")?;
    let rows = query.query_map([task], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
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
            // Archiving first (T-36): its CI watches stop and it starts
            // nothing new; it is closed once nothing of its is still going.
            let (agent, releaser) = (id.to_owned(), by.clone());
            if self.stored(move |store| crate::executor_archiving::begin(store, &agent, &releaser)).await? {
                self.changed(id);
            }
            // Whoever asks again, the release is the first releaser's.
            let agent = id.to_owned();
            let first = self.stored(move |store| crate::executor_archiving::archiving(&*store.db.read()?, &agent)).await?;
            self.archive_or_wait(id, &first.map_or(by, |release| release.by)).await?;
        }
        let agent = self.listed(id).await?;
        let id = agent.id.clone();
        let archiving = self.stored(move |store| crate::executor_archiving::archiving(&*store.db.read()?, &id)).await?;
        let mut answer = json!({"agentId":agent.id,"closedAt":agent.closed_at,"releasedAt":agent.released_at,"releasedBy":agent.released_by});
        if let Some(release) = archiving {
            answer["archiving"] = json!({"since":release.since,"releasedBy":release.by,"reason":release.reason});
        }
        Ok(answer)
    }

    /// Closes the executor being released for good, under its gate: its
    /// close archives it (`follow_close`); one closed before is archived in
    /// its own transaction.
    pub(crate) async fn archive_now(self: &Arc<Self>, id: &str, by: &str) -> Result<()> {
        #[cfg(test)]
        if crate::executor_archiving::tests::close_fails(id) {
            bail!("远程状态尚未确认，Agent 未关闭 (a test's remote close)");
        }
        if self.listed(id).await?.closed_at.is_none() {
            self.close_agent_locked(id, json!({"reason":RELEASED,"by":by})).await?;
        }
        // Closed before, or by another close meanwhile.
        let (agent, by) = (id.to_owned(), by.to_owned());
        if self.stored(move |store| archive_closed(store, &agent, &by)).await? {
            self.changed(id);
        }
        Ok(())
    }

    /// The task `task` (as its receipt names it) was set done by `actor`:
    /// each of its executors not yet released is released, by the same rule
    /// as `executor_release` (T-36). One `actor` may not release keeps on.
    pub(crate) async fn release_on_done(self: &Arc<Self>, actor: Option<String>, task: String) {
        let found = self.stored(move |store| {
            let db = store.db.read()?;
            let (internal, _) = crate::collaboration_store::task_key(&db, &task)?;
            executors_of(&db, &internal)
        }).await;
        for agent in found.unwrap_or_default() {
            if let Err(error) = self.release_executor(actor.as_deref(), &agent).await {
                eprintln!("[executor] not released with its task done: {agent}: {error:#}");
            }
        }
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
