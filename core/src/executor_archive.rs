//! What an executor's archive changes (T-36, executor model phase 3;
//! docs/executor-model.md). A release archives an executor
//! (`agent_roles.archived_at`); from then on it takes no more mail or work:
//!
//! - Core's own mail to it (a Job's, CI's, a review's, a PR operation's
//!   result) goes to the Agent that dispatched it, naming it ([`redirect`],
//!   at the one place mail is written). An executor the user dispatched has
//!   no Agent to send it to: its mail stays its own, as a closed Agent's does.
//! - An Agent's or the user's mail to it, and a dispatch naming it, is
//!   refused with `executor_archived` and its task ([`refuse_mail`]).
//!
//! - Its task-status proposals are its dispatcher's to decide
//!   ([`proposal_decider`]).
//!
//! Whether archived or not, an executor never sets its own task done: its
//! dispatcher, or the user, decides that ([`refuse_own_done`]).
use crate::collaboration_store::{task_key, TaskActor};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// An archived executor: its name, its task's public ID (T-n) and the Agent
/// that dispatched it (`None` when the user did).
struct Archived {
    name: String,
    task: Option<String>,
    dispatcher: Option<String>,
}

fn name(db: &Connection, agent: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT json_extract(data,'$.agent.name') FROM agents WHERE id=?1", [agent], |r| r.get::<_, Option<String>>(0))
        .optional()?
        .flatten())
}

/// `agent`, if it is an archived executor.
fn archived(db: &Connection, agent: &str) -> Result<Option<Archived>> {
    let row: Option<(Option<String>, Option<String>)> = db
        .query_row(
            "SELECT task_id,created_by FROM agent_roles WHERE agent_id=?1 AND kind='executor' AND archived_at IS NOT NULL",
            [agent],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((task, created_by)) = row else { return Ok(None) };
    let task = match task {
        Some(task) => task_key(db, &task).ok().map(|(_, seq)| format!("T-{seq}")),
        None => None,
    };
    let dispatcher = created_by.and_then(|by| by.strip_prefix("agent:").map(str::to_owned));
    Ok(Some(Archived { name: name(db, agent)?.unwrap_or_else(|| agent.to_owned()), task, dispatcher }))
}

/// Core's own mail to an archived executor goes to the Agent that dispatched
/// it, which the mail names as its original recipient (`originalRecipient`
/// and its first line). Mail from an Agent or the user is never redirected:
/// [`refuse_mail`] refused it before it was written. The dispatcher may be
/// closed: the mail waits for it, as all mail does.
pub(crate) fn redirect(db: &Connection, message: &mut Value) -> Result<()> {
    if matches!(message["sender"]["kind"].as_str(), Some("agent" | "user")) {
        return Ok(());
    }
    // An update's request to end the recipient's own Turn means nothing to another Agent.
    if message["metadata"]["kind"] == "update_wait" {
        return Ok(());
    }
    let Some(recipient) = message["recipient"]["id"].as_str() else { return Ok(()) };
    let Some(executor) = archived(db, recipient)? else { return Ok(()) };
    let Some(dispatcher) = executor.dispatcher else { return Ok(()) };
    let Some(dispatcher_name) = name(db, &dispatcher)? else { return Ok(()) };
    let task = executor.task.as_deref().map(|task| format!(" of {task}")).unwrap_or_default();
    let body = message["body"].as_str().unwrap_or_default();
    message["body"] = json!(format!(
        "Sent to {}, the archived executor{task} you dispatched; it takes no more mail, so it comes to you.\n\n{body}",
        executor.name
    ));
    message["originalRecipient"] = message["recipient"].take();
    message["recipient"] = json!({"kind":"agent","id":dispatcher,"name":dispatcher_name});
    Ok(())
}

/// Mail and dispatches to an archived executor are refused, naming its task
/// and who to write to instead.
pub(crate) fn refuse_mail(db: &Connection, to: &str) -> Result<()> {
    let Some(executor) = archived(db, to)? else { return Ok(()) };
    let task = executor.task.as_deref().unwrap_or("its task");
    let instead = match executor.dispatcher.as_deref().map(|id| name(db, id)).transpose()?.flatten() {
        Some(dispatcher) => format!("write to {dispatcher}, who dispatched it, or dispatch the task again"),
        None => "dispatch the task again for new work".into(),
    };
    bail!(
        "executor_archived: {} is archived since {task}'s work was released, and takes no more mail or work (taskId {task}); {instead}",
        executor.name
    )
}

/// Who decides a released executor's task-status proposal (result_publish's
/// TaskStatus, task_proposals.rs), or `None` unless `agent` is one: the Agent
/// that dispatched it, named, or `Some(None)` for the user, when the user
/// dispatched it or its dispatcher is closed or no longer exists.
pub(crate) fn proposal_decider(db: &Connection, agent: &str) -> Result<Option<Option<String>>> {
    let Some(executor) = archived(db, agent)? else { return Ok(None) };
    Ok(Some(match executor.dispatcher {
        // A closed dispatcher cannot answer either: the user decides (#622 R1 note).
        Some(dispatcher) if open(db, &dispatcher)? => name(db, &dispatcher)?,
        _ => None,
    }))
}

fn open(db: &Connection, agent: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND json_extract(data,'$.agent.closedAt') IS NULL)",
        [agent],
        |r| r.get(0),
    )?)
}

/// An executor never sets its own task done, with task_update or with its
/// result (task_submit_result): it submits its result as review, and its
/// dispatcher, or the user, decides. Other statuses are its to set.
pub(crate) fn refuse_own_done(db: &Connection, actor: &TaskActor, task: &str) -> Result<()> {
    if actor.kind != "agent" {
        return Ok(());
    }
    let own: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_roles WHERE agent_id=?1 AND kind='executor' AND task_id=?2)",
        params![actor.id, task],
        |r| r.get(0),
    )?;
    if own {
        bail!(
            "executor_done_refused: an executor does not set its own task done; submit your result with task_submit_result \
             and status review, and the Agent that dispatched you, or the user, decides"
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "executor_archive_tests.rs"]
mod tests;
