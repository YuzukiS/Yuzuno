//! Which of Core's notices wake their recipient (YN-68).
//!
//! Every mail is saved and read the same way. What differs is its wake-up,
//! decided once, as it is written ([`classify`], from `insert_message`), and
//! kept on the message as `wake`:
//!
//! - `ring`: it starts a Turn for an idle recipient, as all mail did before.
//!   The default: mail from an Agent or the user, urgent mail, every kind and
//!   status not named below, and anything Core cannot read.
//! - `quiet`: one of Core's notices that asks nothing of its recipient. It
//!   never starts a Turn and never goes into a running one: it waits in the
//!   mailbox and comes with the recipient's next wake-up, whose text counts
//!   it (`pending_peer_deliveries`, `deliver_peer_batch`). `peer_read` lists
//!   it like any other mail, with its `wake`, and can read only those.
//! - `join`: Core's session notice (YN-5): it starts no Turn, but goes into
//!   a running one.
//!
//! Quiet, and only while someone else is told the next step:
//!
//! - A PR merged, while its task has an executor at work: that executor is
//!   woken when main's CI on the merge ends.
//! - Main's CI green on a merge, to anyone but that executor, while there is
//!   one: it reports with its result, which rings. Without an executor at
//!   work (none, or released), both ring for the lead (Dev Lead 2, mail
//!   10300): that is how the lead knows the task can close.
//! - The merge queue unpaused: the entries that waited go on by themselves.
//! - Executor templates changed: other leads are told, nothing more.
//! - A released executor's success passed to its dispatcher (a Job, a CI
//!   run, a review that passed, a PR operation, a merge), once its task is
//!   done, cancelled or archived. While the task is open it rings: nobody
//!   else is waiting for it.
//!
//! A revert, a red, cancelled or unobserved main CI, a stop, a pause, a
//! result, a refusal, a failure and an unknown outcome always ring.
use crate::collaboration_store::{load_task, SharedTask};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::Value;

pub(crate) const RING: &str = "ring";
pub(crate) const QUIET: &str = "quiet";
pub(crate) const JOIN: &str = "join";

/// The wake-up of `message`, as it is about to be written (after
/// `executor_archive::redirect`), and why, for a quiet one. Whatever Core
/// cannot read rings.
pub(crate) fn classify(db: &Connection, message: &Value) -> (&'static str, Option<&'static str>) {
    match decide(db, message) {
        Ok(Some(why)) => (QUIET, Some(why)),
        Ok(None) if message["metadata"]["kind"] == crate::session_baseline::KIND && from_core(message) => (JOIN, None),
        Ok(None) | Err(_) => (RING, None),
    }
}

fn from_core(message: &Value) -> bool {
    message["sender"]["kind"] == "system" && message["sender"]["id"] == "core"
}

/// Why `message` is quiet, or None when it rings.
fn decide(db: &Connection, message: &Value) -> Result<Option<&'static str>> {
    if !from_core(message) || message["priority"].as_str().unwrap_or("normal") != "normal" {
        return Ok(None);
    }
    let metadata = &message["metadata"];
    let (kind, status) = (metadata["kind"].as_str().unwrap_or(""), metadata["status"].as_str().unwrap_or(""));
    match (kind, status) {
        ("executorTemplates", "changed") => return Ok(Some("executor templates changed; nothing to do")),
        ("merge", "unpaused") => return Ok(Some("the merge queue runs again; waiting entries go on by themselves")),
        _ => {}
    }
    let task = match message["taskId"].as_str().filter(|id| !id.is_empty()) {
        Some(id) => load_task(db, id)?,
        None => return Ok(None),
    };
    let revert = metadata["entryKind"] == "revert";
    let green = kind == "merge" && status == "done" && metadata["reason"].is_null() && metadata["mainCi"] == "success" && !revert;
    let merged = kind == "merge" && status == "merged" && !revert;
    if merged || green {
        if let Some(executor) = executor_at_work(db, &task)? {
            let recipient = message["recipient"]["id"].as_str().unwrap_or("");
            if merged {
                return Ok(Some("merged; the task's executor is woken when main CI on the merge ends"));
            }
            if executor != recipient {
                return Ok(Some("main CI green; the task's executor is woken to report it"));
            }
        }
    }
    let success = merged
        || green
        || match (kind, status) {
            ("job", "succeeded") | ("ci", "passed") | ("pr", "completed") => true,
            ("review", "completed") => matches!(metadata["conclusion"].as_str(), Some("no_findings" | "approved_with_notes")),
            _ => false,
        };
    if success && message.get("originalRecipient").is_some_and(|r| !r.is_null()) && closed(&task) {
        return Ok(Some("a released executor's success, on a task that is closed"));
    }
    Ok(None)
}

fn closed(task: &SharedTask) -> bool {
    task.archived_at.is_some() || matches!(task.status.as_str(), "done" | "cancelled")
}

/// The Agent the task is assigned to, while the task is open and that Agent
/// is open and not a released (archived) executor.
fn executor_at_work(db: &Connection, task: &SharedTask) -> Result<Option<String>> {
    if closed(task) {
        return Ok(None);
    }
    let Some(agent) = task.assignee_agent_id.as_deref() else { return Ok(None) };
    let released: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_roles WHERE agent_id=?1 AND kind='executor' AND archived_at IS NOT NULL)",
        [agent],
        |r| r.get(0),
    )?;
    Ok((!released && crate::executor_archive::open(db, agent)?).then(|| agent.to_owned()))
}

#[cfg(test)]
mod tests;
