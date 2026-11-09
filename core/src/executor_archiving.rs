//! Releasing an executor whose work is still going (T-36 S2, executor model
//! phase 3; docs/executor-model.md).
//!
//! A release (executor_release.rs) first makes the executor `archiving`:
//! Core stops the executor's own CI watches, holds its queued Jobs (they
//! are refused at its close, jobs/store.rs), and it starts nothing new
//! ([`refuse_while_archiving`]). It is closed for good only once nothing of
//! its is still going: no Job running, no delivery flow under way, no pull
//! request operation in flight ([`waits`]). Until then it stays archiving,
//! with what it waits for as its reason. A pass tries again as soon as a
//! Job, a delivery flow, CI or a PR operation changes
//! ([`Workspace::wake_archive_passes`], called where those wake
//! collaboration), every 5 s besides, and after Core starts
//! ([`Workspace::start_archive_passes`]). A close that fails (a remote
//! close not confirmed) stays archiving as well, its error as the reason,
//! tried again after a wait that doubles up to five minutes.
//!
//! The close that archives it ([`follow_archive`], in that close's
//! transaction) hands its live Brief sections and Asks to the Agent that
//! dispatched it, as a claim would, so Home's replies and resolve go there,
//! and tells that Agent of each task-status proposal it left undecided. One
//! the user dispatched keeps its sections, orphaned as a closed Agent's are.
use crate::{
    collaboration_store::{insert_message, task_key},
    model::{now, Agent},
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

/// How often a pass looks at the executors being released.
const TICK: std::time::Duration = std::time::Duration::from_secs(5);
/// The wait before a failed close is tried again, doubled per failure.
const FIRST_WAIT: i64 = 30;
const MAX_WAIT: i64 = 300;

/// The operations that start new work, refused to an executor being released.
const STARTS_WORK: [&str; 8] = ["job_submit", "job_run_submit", "ci_subscribe", "github_pr_submit", "review_start", "delivery_enable", "cleanup_apply", "cleanup_inventory"];

#[derive(Default)]
pub(crate) struct State {
    wakeup: Arc<tokio::sync::Notify>,
    started: OnceLock<()>,
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS executor_archiving(
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            released_by TEXT NOT NULL, since TEXT NOT NULL, reason TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, next_try_at TEXT);
        DELETE FROM executor_archiving WHERE agent_id NOT IN (SELECT id FROM agents);",
    )?;
    Ok(())
}

/// An executor being released: who released it (as the receipts key the
/// caller), since when, and what it waits for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Archiving {
    pub(crate) by: String,
    pub(crate) since: String,
    pub(crate) reason: String,
    pub(crate) attempts: i64,
}

pub(crate) fn archiving(db: &Connection, agent: &str) -> Result<Option<Archiving>> {
    Ok(db
        .query_row("SELECT released_by,since,reason,attempts FROM executor_archiving WHERE agent_id=?1", [agent], |r| {
            Ok(Archiving { by: r.get(0)?, since: r.get(1)?, reason: r.get(2)?, attempts: r.get(3)? })
        })
        .optional()?)
}

/// The release's start, in one transaction: the executor is archiving and
/// its own CI watches are stopped (what they saw stays). False if it was
/// archiving already.
pub(crate) fn begin(store: &Store, agent: &str, by: &str) -> Result<bool> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    if archiving(&tx, agent)?.is_some() {
        return Ok(false);
    }
    let at = now();
    tx.execute(
        "INSERT INTO executor_archiving(agent_id,released_by,since,reason) VALUES(?1,?2,?3,'')",
        params![agent, by, at],
    )?;
    tx.execute("UPDATE agent_roles SET state='archiving',updated_at=?2 WHERE agent_id=?1 AND kind='executor'", params![agent, at])?;
    crate::ci_monitor::lifecycle::close_agent_subscriptions(&tx, agent, "executor_released")?;
    tx.commit()?;
    Ok(true)
}

/// What a release of `agent` still waits for, in words; empty when nothing.
/// Its queued Jobs are not waited for: they are held, and refused once it is
/// closed.
pub(crate) fn waits(db: &Connection, agent: &str) -> Result<Vec<String>> {
    let mut out = vec![];
    let mut running = db.prepare(
        "SELECT id,COALESCE(json_extract(data,'$.name'),'') FROM local_jobs WHERE agent_id=?1 AND reserved=1 ORDER BY seq",
    )?;
    let jobs = running
        .query_map([agent], |r| Ok(format!("{} ({})", r.get::<_, String>(1)?, r.get::<_, String>(0)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !jobs.is_empty() {
        let what = if jobs.len() == 1 { "a Job is still running" } else { "Jobs are still running" };
        out.push(format!("{what}: {}", jobs.join(", ")));
    }
    let mut flows = db.prepare(
        "SELECT task_id, json_extract(data,'$.taskRef') FROM delivery_flows
         WHERE json_extract(data,'$.owner.id')=?1 AND json_type(data,'$.terminal') IS NOT 'object'",
    )?;
    let flows = flows
        .query_map([agent], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (task, stored) in flows {
        // Its task's key now (T-56), else the one the flow stored.
        let task = crate::task_keys::current(db, &task).ok().flatten().or(stored);
        out.push(format!("its delivery flow for {} is still under way (stop it, or let it end)", task.as_deref().unwrap_or("its task")));
    }
    let operations: i64 = db.query_row(
        "SELECT COUNT(*) FROM pr_operations WHERE status IN ('accepted','running') AND json_extract(data,'$.requestedBy.id')=?1",
        [agent],
        |r| r.get(0),
    )?;
    if operations > 0 {
        out.push(format!("{operations} pull request operation{} still in flight", if operations == 1 { " is" } else { "s are" }));
    }
    Ok(out)
}

/// What a release waits for now, said on its row; a failed close also
/// counts as an attempt, with the time it is tried again. True when the row
/// changed: the same wait said again is not written, nor announced by the
/// caller (T-36 S3, #635's closing round 9ab74ebf).
fn note(store: &Store, agent: &str, reason: &str, failed: bool) -> Result<bool> {
    let db = store.db.write()?;
    if failed {
        let attempts: i64 =
            db.query_row("SELECT attempts FROM executor_archiving WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?.unwrap_or(0);
        let wait = (FIRST_WAIT << attempts.min(4)).min(MAX_WAIT);
        let next = (chrono::Utc::now() + chrono::Duration::seconds(wait)).to_rfc3339();
        db.execute(
            "UPDATE executor_archiving SET reason=?2,attempts=attempts+1,next_try_at=?3 WHERE agent_id=?1",
            params![agent, reason, next],
        )?;
        return Ok(true);
    }
    let changed = db.execute(
        "UPDATE executor_archiving SET reason=?2,next_try_at=NULL WHERE agent_id=?1 AND (reason IS NOT ?2 OR next_try_at IS NOT NULL)",
        params![agent, reason],
    )?;
    Ok(changed > 0)
}

/// Whether `operation` starts new work, which an executor being released may not.
pub(crate) fn starts_work(operation: &str) -> bool {
    STARTS_WORK.contains(&operation)
}

/// An executor being released starts nothing new; it can still report
/// (peer_send, task_comment, task_submit_result).
pub(crate) fn refuse_while_archiving(db: &Connection, agent: &str, operation: &str) -> Result<()> {
    if !STARTS_WORK.contains(&operation) {
        return Ok(());
    }
    if let Some(release) = archiving(db, agent)? {
        bail!(
            "executor_archiving: you are being released (since {}) and start nothing new; {operation} is refused. \
             Report with peer_send, task_comment or task_submit_result",
            release.since
        );
    }
    Ok(())
}

/// In the transaction that archives `agent` (executor_release.rs
/// `follow_close`, or its own for an executor closed before): it is no
/// longer archiving, its live Brief sections and Asks are the dispatcher's,
/// as a claim makes them, and the dispatcher is told of each task-status
/// proposal it left undecided. A closed dispatcher is handed neither: the
/// sections stay orphaned, an editor's to claim, and the proposals are the
/// user's (executor_archive.rs `proposal_decider`).
pub(crate) fn follow_archive(db: &Connection, agent: &Agent) -> Result<()> {
    db.execute("DELETE FROM executor_archiving WHERE agent_id=?1", [&agent.id])?;
    let row: Option<(Option<String>, Option<String>)> = db
        .query_row("SELECT created_by,task_id FROM agent_roles WHERE agent_id=?1 AND kind='executor'", [&agent.id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let Some((created_by, task)) = row else { return Ok(()) };
    let Some(dispatcher) = created_by.as_deref().and_then(|by| by.strip_prefix("agent:")) else { return Ok(()) };
    // It can't answer them, nor reply on Home (#635 R1 2f82a185).
    if !crate::executor_archive::open(db, dispatcher)? {
        return Ok(());
    }
    let name: Option<String> = db
        .query_row("SELECT json_extract(data,'$.agent.name') FROM agents WHERE id=?1", [dispatcher], |r| r.get(0))
        .optional()?
        .flatten();
    let Some(name) = name else { return Ok(()) };
    let at = now();
    // Recorded as a write of the handed-over keys (YN-14 follow-up).
    crate::project_brief::hand_over(db, &agent.id, dispatcher, &name)?;
    let task = task.as_deref().and_then(|t| task_key(db, t).ok()).map(|(id, _)| crate::collaboration_store::task_shown(db, &id));
    for proposal in crate::task_proposals::undecided(db, &agent.id)? {
        let id = uuid::Uuid::new_v4().to_string();
        let body = format!(
            "{} (the executor{} you dispatched, now released) left a task status proposal undecided: {} to {}, because \"{}\". \
             It is yours to decide: set the task's status with task_update if you agree.",
            agent.name,
            task.as_deref().map(|t| format!(" of {t}")).unwrap_or_default(),
            proposal["taskId"].as_str().unwrap_or("its task"),
            proposal["status"].as_str().unwrap_or(""),
            proposal["reason"].as_str().unwrap_or("")
        );
        insert_message(
            db,
            json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
                "recipient":{"kind":"agent","id":dispatcher,"name":name},"body":body,"taskId":task,"replyTo":null,"threadId":id,
                "createdAt":at,"source":{"resultId":proposal["resultId"]},"priority":"normal",
                "metadata":{"kind":"executor_proposal","resultId":proposal["resultId"],"executorId":agent.id}}),
        )?;
    }
    Ok(())
}

impl Workspace {
    /// Under `id`'s gate: closes the executor being released if nothing of
    /// its is still going, or says what it waits for. A close that fails is
    /// kept as the reason, tried again later. True once it is archived.
    pub(crate) async fn archive_or_wait(self: &Arc<Self>, id: &str, by: &str) -> Result<bool> {
        let agent = id.to_owned();
        let waiting = self.stored(move |store| waits(&*store.db.read()?, &agent)).await?;
        let agent = id.to_owned();
        if !waiting.is_empty() {
            let reason = format!("Waiting to close: {}.", waiting.join("; "));
            if self.stored(move |store| note(store, &agent, &reason, false)).await? {
                self.executor_changed(id);
            }
            return Ok(false);
        }
        if let Err(error) = self.archive_now(id, by).await {
            let reason = format!("The close could not be confirmed, so it is tried again: {error:#}");
            self.stored(move |store| note(store, &agent, &reason, true)).await?;
            self.executor_changed(id);
            return Ok(false);
        }
        Ok(true)
    }

    /// Every executor being released whose wait is over, each under its gate.
    pub(crate) async fn archive_pass(self: &Arc<Self>) {
        let due = self
            .stored(|store| {
                let db = store.db.read()?;
                let mut query = db.prepare(
                    "SELECT agent_id,released_by FROM executor_archiving WHERE next_try_at IS NULL OR next_try_at<=?1 ORDER BY since",
                )?;
                let rows = query.query_map([chrono::Utc::now().to_rfc3339()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await;
        let Ok(due) = due else { return };
        for (agent, by) in due {
            let Ok(_permit) = self.admission.enter_work() else { return };
            let gate = self.gate(&agent).await;
            let _held = gate.lock().await;
            let _ = self.archive_or_wait(&agent, &by).await;
        }
    }

    /// A Job, a delivery flow, CI or a PR operation changed: what a release
    /// waits for may have ended, so a pass runs now rather than at its tick.
    pub(crate) fn wake_archive_passes(&self) {
        self.executor_archiving.wakeup.notify_one();
    }

    /// The loop that finishes releases: a pass on each wake-up and every 5 s
    /// besides, so one archiving when Core stopped goes on after it starts.
    pub fn start_archive_passes(self: &Arc<Self>) {
        if self.executor_archiving.started.set(()).is_err() {
            return;
        }
        let (weak, wakeup) = (Arc::downgrade(self), self.executor_archiving.wakeup.clone());
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = wakeup.notified() => {},
                    _ = tokio::time::sleep(TICK) => {},
                }
                let Some(ws) = weak.upgrade() else { break };
                ws.archive_pass().await;
                drop(ws);
            }
        });
    }

}

#[cfg(test)]
#[path = "executor_archiving_tests.rs"]
pub(crate) mod tests;
