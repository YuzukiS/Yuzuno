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
//! - A dispatcher's copy of a review its executor started (YN-12 S2,
//!   `pr_review/store.rs`), once the review completed, whatever its
//!   conclusion, while that executor is at work on the open task: the
//!   executor was told too and takes the next step. A copy of one that
//!   failed, was cancelled or is unknown rings, and so does any copy once
//!   the task is closed or the executor is not at work.
//!
//! A revert, a red, cancelled or unobserved main CI, a stop, a pause, a
//! result, a refusal, a failure and an unknown outcome always ring.
//!
//! An Agent may ask for its quiet notices to ring after all, every one or
//! those of a few open tasks (`mail_preferences`, S2); such a notice says
//! why ([`WANTED`]). The doorbell that brings quiet notices counts them and
//! gives a line a task of what they say ([`digest`]).
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
        // Its recipient asked to be woken by it (mail_preferences); a
        // preference Core cannot read wakes it too.
        Ok(Some(_)) if wanted(db, message).unwrap_or(true) => (RING, Some(WANTED)),
        Ok(Some(why)) => (QUIET, Some(why)),
        Ok(None) if message["metadata"]["kind"] == crate::session_baseline::KIND && from_core(message) => (JOIN, None),
        Ok(None) | Err(_) => (RING, None),
    }
}

/// Why a notice that would be quiet rings: its recipient's preferences.
pub(crate) const WANTED: &str = "a quiet notice your mail_preferences ask to be woken by";

/// Why a dispatcher's copy of a completed review is quiet.
pub(crate) const COPY: &str = "a copy of a review your executor started and was told of; it takes the next step";

/// Whether the recipient's preferences make this quiet notice ring.
fn wanted(db: &Connection, message: &Value) -> Result<bool> {
    let recipient = message["recipient"]["id"].as_str().unwrap_or("");
    let task = match message["taskId"].as_str().filter(|id| !id.is_empty()) {
        Some(id) => Some(load_task(db, id)?),
        None => None,
    };
    crate::collaboration_store::mail_preferences::rings(db, recipient, task.as_ref())
}

/// At most this many lines in a doorbell's digest of its quiet notices,
/// and this many events on one line.
const DIGEST_LINES: usize = 8;
const DIGEST_EVENTS: usize = 4;

/// The digest a doorbell gives of the quiet notices it brings (`recipient`'s
/// pending, unread mail of `priority` up to `through`): one line a task, in
/// the order they came, "Workspace" for those of no task, each event once
/// (by its notice key) with its time, at most [`DIGEST_LINES`] lines.
pub(crate) fn digest(db: &Connection, recipient: &str, through: i64, priority: &str) -> Result<Vec<String>> {
    let mut q = db.prepare(
        "SELECT data FROM collaboration_messages m WHERE recipient_id=?1 AND seq<=?2 AND delivery_state='pending'
           AND COALESCE(json_extract(data,'$.priority'),'normal')=?3 AND json_extract(data,'$.wake')='quiet'
           AND NOT EXISTS(SELECT 1 FROM collaboration_message_reads r WHERE r.message_seq=m.seq AND r.reader_id=m.recipient_id)
         ORDER BY seq",
    )?;
    let mut tasks: Vec<(Option<String>, Vec<String>, Vec<String>)> = Vec::new();
    for raw in q.query_map(rusqlite::params![recipient, through, priority], |r| r.get::<_, String>(0))? {
        let message: Value = serde_json::from_str(&raw?)?;
        let task = message["taskId"].as_str().filter(|id| !id.is_empty()).map(str::to_owned);
        let key = message["notice"]["key"].as_str().unwrap_or_default().to_owned();
        let at = message["createdAt"]
            .as_str()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .map(|at| at.with_timezone(&chrono::Utc).format(" %H:%MZ").to_string())
            .unwrap_or_default();
        let event = format!("{}{at}", event(&message));
        let entry = match tasks.iter_mut().position(|(t, ..)| *t == task) {
            Some(i) => &mut tasks[i],
            None => {
                tasks.push((task, Vec::new(), Vec::new()));
                tasks.last_mut().unwrap()
            }
        };
        if !entry.1.contains(&key) {
            entry.1.push(key);
            entry.2.push(event);
        }
    }
    let more = tasks.len().saturating_sub(DIGEST_LINES);
    let mut lines: Vec<String> = tasks
        .into_iter()
        .take(DIGEST_LINES)
        .map(|(task, _, events)| {
            let shown = task.map(|id| crate::collaboration_store::task_shown(db, &id)).unwrap_or_else(|| "Workspace".into());
            let rest = events.len().saturating_sub(DIGEST_EVENTS);
            let mut text = events.into_iter().take(DIGEST_EVENTS).collect::<Vec<_>>().join("; ");
            if rest > 0 {
                text.push_str(&format!("; {rest} more"));
            }
            format!("- {shown}: {text}")
        })
        .collect();
    if more > 0 {
        lines.push(format!("- and {more} more task{} in the mailbox", if more == 1 { "" } else { "s" }));
    }
    Ok(lines)
}

/// One quiet notice in a few words: its name and what happened. The name
/// may come from outside (a PR's or a Job's), and goes into a harness's
/// input: it is the notice's, whitespace collapsed to single spaces as
/// `mailbox_notice` keeps it (and so here again), cut to 60 characters, so
/// that it can't break the digest's lines (#845 R1 6b0f8a5a).
fn event(message: &Value) -> String {
    let metadata = &message["metadata"];
    let raw = message["notice"]["name"].as_str().or(metadata["name"].as_str()).unwrap_or("");
    let name: String = raw.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
    let what = match (metadata["kind"].as_str().unwrap_or(""), metadata["status"].as_str().unwrap_or("")) {
        ("merge", "merged") => "merged",
        ("merge", "done") => "main CI success",
        ("merge", "unpaused") => "merge queue unpaused",
        ("executorTemplates", "changed") => return "executor templates changed".into(),
        ("job", "succeeded") => "Job succeeded",
        ("ci", "passed") => "CI passed",
        // By the notice's status, a completed review's conclusion
        // (mailbox_notice.rs): completed alone never means it passed.
        ("review", status) => match message["notice"]["status"].as_str().filter(|s| !s.is_empty()).unwrap_or(status) {
            "no_findings" | "approved_with_notes" => "review passed",
            told => return format!("{name} review {told}").trim().to_owned(),
        },
        ("pr", "completed") => "PR done",
        (_, status) => return format!("{name} {status}").trim().to_owned(),
    };
    format!("{name} {what}").trim().to_owned()
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
    // The dispatcher's copy of a review its executor started (YN-12 S2): the
    // executor was told too and takes the next step, while it is at work.
    if kind == "review" && metadata["copyFor"] == "dispatcher" {
        let requester = metadata["requester"].as_str().filter(|id| !id.is_empty());
        let at_work = requester.is_some() && executor_at_work(db, &task)?.as_deref() == requester;
        return Ok((status == "completed" && at_work).then_some(COPY));
    }
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
