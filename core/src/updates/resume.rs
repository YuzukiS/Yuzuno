//! Continue after an update (YN-131). An update asks each Agent with a Turn
//! in progress to yield it (notices.rs); this undoes that pause. Once the
//! update the journal holds has ended (installed, rolled back, cancelled,
//! timed out or failed) and this Core accepts work again, each Agent that
//! yielded because the update asked it to gets one fixed message through the
//! ordinary message path, to continue that work:
//! - it read the update's pause message while the request applied: before
//!   the update's deadline and before it ended (`paused_for`);
//! - its original Turn completed, and no Turn after it began with a person's
//!   input or mail (Core's own, such as a Brief reminder or a card's refresh,
//!   do not count: they are waited for);
//! - it is still open, not being released, not disconnected, in the same
//!   session.
//!
//! Its client message ID is this prefix and the operation ID, so one update
//! sends it at most once to an Agent, across restarts too. Nothing earlier is
//! sent again. The outcome for each Agent is kept on its pause message
//! (`delivery_detail.resume`), not in the journal, whose `Operation` an
//! earlier release's helper still reads and which refuses unknown fields.
//! A send that failed or whose delivery is unconfirmed is not tried again.
use super::{
    notices::{session, Starter},
    state::{Operation, Phase},
};
use crate::{
    collaboration_credentials::MessageNotSubmitted,
    model::{AgentDetail, MessageInput, MessageReceipt},
    store::Store,
    workspace::Workspace,
};
use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;

#[cfg(all(test, unix))]
mod tests;

/// The client ID of a continue: this prefix and the update's operation ID.
pub(crate) const CLIENT_PREFIX: &str = "update-resume-";
/// Its receipt's `origin.kind`; the conversation marks its input `update`.
pub(crate) const ORIGIN: &str = "update_resume";

/// An update that has ended: no Agent waits for it any more.
fn ended(phase: Phase) -> bool {
    matches!(phase, Phase::Complete | Phase::RolledBack | Phase::Failed | Phase::Cancelled)
}

/// Whether the Agent read this pause message while it asked it to pause:
/// before the deadline and before the update ended. Read later, the message
/// said the request had expired, so the Agent did not yield for it.
pub(crate) fn paused_for(op: &Operation, message: &Value) -> bool {
    let at = |text: &str| chrono::DateTime::parse_from_rfc3339(text).ok();
    match (message["firstReadAt"].as_str().and_then(at), at(&op.deadline), at(&op.updated_at)) {
        (Some(read), Some(deadline), Some(ended)) => read < deadline.min(ended),
        _ => false,
    }
}

/// How the update ended, as the continue says it.
fn ending(op: &Operation) -> String {
    match op.phase {
        Phase::Complete => format!("release {} is installed", op.candidate.release_id),
        Phase::RolledBack => format!(
            "the new release could not start, so the previous release {} is running again",
            op.previous.release_id
        ),
        Phase::Cancelled => "the update was cancelled; the same release keeps running".into(),
        _ => "it stopped before finishing; this Workspace keeps running".into(),
    }
}

/// The continue, for the model to read: fixed, like the pause message.
pub(crate) fn text(op: &Operation) -> String {
    format!("[Yuzuno · continue after update] Workspace update {} (operation {}) has ended: {}. Your previous Turn ended because this update asked you to pause, so Yuzuno sent this one message. Continue the work you paused, on its existing task. First check what already finished (the task, Jobs, CI, reviews, mail); don't repeat completed steps or tool calls that already ran. If that work was already finished, or it waits for someone else's reply or result, end this Turn without a receipt-only reply.",
        op.release_id, op.id, ending(op))
}

/// Why a continue was not sent, from the check made with the Agent's gate
/// held (`guard`). `Later`: Core's own work began; it is decided again.
#[derive(Debug)]
pub(crate) enum ResumeSkipped {
    Skip(&'static str),
    Later,
}
impl std::fmt::Display for ResumeSkipped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Skip(reason) => write!(f, "Continue after update not sent: {reason}"),
            Self::Later => write!(f, "Continue after update not sent yet: the Agent is busy"),
        }
    }
}
impl std::error::Error for ResumeSkipped {}

fn refused(error: &anyhow::Error) -> Option<&ResumeSkipped> {
    error.downcast_ref::<MessageNotSubmitted>()?.0.downcast_ref::<ResumeSkipped>()
}

/// A person's input or mail: someone has told the Agent what to do since.
fn by_someone(input: Option<&str>) -> bool {
    input.is_some_and(|by| crate::input_origin::navigable(by) || by == "peer")
}

fn unsettled(d: &AgentDetail) -> bool {
    d.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain"))
}

/// What Core read of a paused Agent to decide.
pub(super) struct Seen {
    /// The send view: metadata, unsettled receipts, open and newest Turns.
    pub detail: AgentDetail,
    pub archiving: bool,
    pub handoff: bool,
    /// From the original Turn on; None if the Agent has no such Turn.
    pub turns: Option<Vec<Starter>>,
}

#[derive(Debug, PartialEq)]
pub(super) enum Decision {
    Skip(&'static str),
    Wait,
    /// Send, while this is still the Agent's newest Turn.
    Send(String),
}

/// What to do for one pause message the Agent was paused by; the first
/// rule that applies decides.
pub(super) fn decide(message: &Value, seen: &Seen) -> Decision {
    let (d, target) = (&seen.detail, &message["metadata"]);
    if d.agent.closed_at.is_some() {
        return Decision::Skip("closed");
    }
    if seen.archiving {
        return Decision::Skip("released");
    }
    if d.agent.disconnected_at.is_some() {
        return Decision::Skip("disconnected");
    }
    if target["harness"].as_str() != Some(d.agent.harness.as_str()) || target["sessionId"].as_str() != session(d) {
        return Decision::Skip("session_changed");
    }
    let Some(turns) = seen.turns.as_deref().filter(|turns| !turns.is_empty()) else {
        return Decision::Skip("turn_not_completed");
    };
    match turns[0].status.as_deref() {
        // Cancelled or timed out while it was finishing: wait for its end.
        Some("inProgress") => return Decision::Wait,
        Some("completed") => {}
        // Stopped by someone, or failed (a usage limit has its own continue).
        _ => return Decision::Skip("turn_not_completed"),
    }
    let later = &turns[1..];
    if later.iter().any(|t| by_someone(t.input.as_deref())) {
        return Decision::Skip("newer_input");
    }
    if later.iter().any(|t| t.status.as_deref() == Some("inProgress"))
        || d.agent.connection_state == "connecting"
        || unsettled(d)
        || seen.handoff
        || matches!(d.agent.status.as_str(), "working" | "waiting")
    {
        return Decision::Wait;
    }
    Decision::Send(turns[turns.len() - 1].id.clone())
}

/// The last check, on the view the send reads with the Agent's gate held:
/// the same session, and `newest` still its newest Turn, ended. Anything
/// that began since with a person's input or mail ends this continue; Core's
/// own work, or a send still unconfirmed, puts it off.
fn guard(d: &AgentDetail, target: &Value, newest: &str) -> Result<()> {
    let refuse = |why| Err(anyhow::Error::new(why));
    if target["harness"].as_str() != Some(d.agent.harness.as_str()) || target["sessionId"].as_str() != session(d) {
        return refuse(ResumeSkipped::Skip("session_changed"));
    }
    let open = d.turns.iter().any(|t| t["status"] == "inProgress");
    if !open && d.turns.last().and_then(|t| t["id"].as_str()) == Some(newest) {
        return if unsettled(d) { refuse(ResumeSkipped::Later) } else { Ok(()) };
    }
    let first = |t: &Value| -> Option<String> {
        t["items"].as_array()?.iter().find(|i| i["type"] == "userMessage")?["_yuzunoInput"].as_str().map(str::to_owned)
    };
    let newer = d.turns.iter().filter(|t| t["id"].as_str() != Some(newest)).any(|t| by_someone(first(t).as_deref()));
    refuse(if newer { ResumeSkipped::Skip("newer_input") } else { ResumeSkipped::Later })
}

fn seen(store: &Store, agent: &str, turn: &str) -> Result<Option<Seen>> {
    if !crate::record_rows::exists(&*store.db.read()?, agent)? {
        return Ok(None);
    }
    let turns = store.turn_starters_since(agent, turn)?;
    let detail = store.send_view(agent)?;
    let archiving = crate::executor_archiving::archiving(&*store.db.read()?, agent)?.is_some();
    let handoff = store.codex_handoff_pending(agent)?;
    Ok(Some(Seen { detail, archiving, handoff, turns }))
}

/// A pause message's `resume`: its state, and why, which Turn or what error.
fn outcome(state: &str, reason: Option<&str>, turn: Option<&str>, error: Option<&str>) -> Value {
    let mut value = json!({"state":state,"at":crate::model::now()});
    for (key, field) in [("reason", reason), ("turnId", turn), ("error", error)] {
        if let Some(field) = field {
            value[key] = json!(field);
        }
    }
    value
}

/// As an automatic continue settles from its receipt (claude_quota.rs).
fn from_receipt(receipt: &MessageReceipt) -> Value {
    let (state, error) = crate::claude_quota::receipt_state(&receipt.status, receipt.error.as_deref());
    outcome(state, None, receipt.turn_id.as_deref().filter(|_| state == "sent"), error.as_deref())
}

impl Workspace {
    /// The update the journal holds, once it has ended and this Core
    /// accepts work again; an earlier update is never looked at.
    fn ended_update(&self) -> Result<Option<Operation>> {
        if self.admission.snapshot().operation_id.is_some() {
            return Ok(None);
        }
        let Some(layout) = self.update_notice_layout.get() else {
            return Ok(None);
        };
        Ok(layout.journal()?.operation.filter(|op| ended(op.phase)))
    }

    /// One step of the collaboration worker: each pause message of the
    /// ended update without an outcome is decided, and sent if it is due.
    /// Once all have one, this is one indexed read.
    pub(crate) async fn resume_after_update(self: &Arc<Self>) -> Result<()> {
        let ws = self.clone();
        let Some(op) = crate::db::blocking(move || ws.ended_update()).await? else {
            return Ok(());
        };
        let id = op.id.clone();
        let messages = self.stored(move |store| store.update_resume_candidates(&id)).await?;
        futures_util::stream::iter(messages)
            .for_each_concurrent(2, |message| {
                let op = &op;
                async move {
                    if let Err(error) = self.resume_one(op, message).await {
                        eprintln!("Continue after update: {error:#}");
                    }
                }
            })
            .await;
        Ok(())
    }

    async fn set_resume(&self, key: &str, from: Option<&'static str>, to: Option<Value>) -> Result<bool> {
        let key = key.to_owned();
        self.stored(move |store| store.set_update_resume(&key, from, to)).await
    }

    async fn resume_one(self: &Arc<Self>, op: &Operation, message: Value) -> Result<()> {
        let key = message["id"].as_str().context("Update message missing")?.to_owned();
        let agent = message["recipient"]["id"].as_str().context("Update recipient missing")?.to_owned();
        if message["delivery"]["detail"]["resume"]["state"] == "sending" {
            // Core stopped while sending it: its receipt says whether it went.
            // Without one nothing was sent, and it is decided again.
            let (id, client) = (agent.clone(), format!("{CLIENT_PREFIX}{}", op.id));
            let settled = self.stored(move |store| store.receipt(&id, &client)).await?.as_ref().map(from_receipt);
            let done = settled.is_some();
            if !self.set_resume(&key, Some("sending"), settled).await? || done {
                return Ok(());
            }
        }
        let skip = |reason| self.set_resume(&key, None, Some(outcome("skipped", Some(reason), None, None)));
        if !paused_for(op, &message) {
            return skip("not_paused").await.map(drop);
        }
        let (id, turn) = (agent.clone(), message["metadata"]["turnId"].as_str().unwrap_or_default().to_owned());
        let Some(seen) = self.stored(move |store| seen(store, &id, &turn)).await? else {
            return skip("deleted").await.map(drop);
        };
        let newest = match decide(&message, &seen) {
            Decision::Skip(reason) => return skip(reason).await.map(drop),
            Decision::Wait => return Ok(()),
            Decision::Send(newest) => newest,
        };
        self.send_resume(op, &key, &agent, message["metadata"].clone(), newest).await
    }

    /// Claims the message (`sending`), sends the continue through the
    /// ordinary path with `guard`, and records what happened.
    pub(super) async fn send_resume(self: &Arc<Self>, op: &Operation, key: &str, agent: &str, target: Value, newest: String) -> Result<()> {
        if !self.set_resume(key, None, Some(outcome("sending", None, None, None))).await? {
            return Ok(());
        }
        let client = format!("{CLIENT_PREFIX}{}", op.id);
        let input = MessageInput { client_message_id: client.clone(), text: text(op), text_blocks: None,
            images: vec![], expected_turn_id: None, question: None, clarification: None };
        let origin = json!({"kind":ORIGIN,"operationId":op.id,"releaseId":op.release_id,"phase":op.phase});
        let sent = self.send_message_guarded(agent, input, Vec::new(), Some(origin), move |d| guard(d, &target, &newest)).await;
        let to = match sent {
            Ok(receipt) => Some(from_receipt(&receipt)),
            Err(error) => match refused(&error) {
                Some(ResumeSkipped::Skip(reason)) => Some(outcome("skipped", Some(reason), None, None)),
                Some(ResumeSkipped::Later) => None,
                // Refused before it was recorded, or failed after: a receipt
                // says which, and how it ended.
                None => {
                    let (id, client) = (agent.to_owned(), client);
                    Some(match self.stored(move |store| store.receipt(&id, &client)).await {
                        Ok(Some(receipt)) => from_receipt(&receipt),
                        _ => outcome("failed", None, None, Some(&error.to_string())),
                    })
                }
            },
        };
        self.set_resume(key, Some("sending"), to).await?;
        Ok(())
    }

    /// The update card's rows (`Controller::status`): each Agent the update
    /// paused, with its continue's outcome (`pending` until it has one).
    /// Only the pause messages are read.
    pub(crate) fn update_resume_status(&self, op: &Operation) -> Result<Value> {
        let mut rows = vec![];
        for message in self.store.update_pause_messages(&op.id)? {
            let resume = &message["delivery"]["detail"]["resume"];
            if matches!(resume["reason"].as_str(), Some("not_paused" | "deleted"))
                || (resume.is_null() && !paused_for(op, &message))
            {
                continue;
            }
            let state = match resume["state"].as_str() {
                None | Some("sending") => "pending",
                Some(state) => state,
            };
            let mut row = json!({"agentId":message["recipient"]["id"],"name":message["recipient"]["name"],"state":state});
            for key in ["reason", "error", "turnId"] {
                if !resume[key].is_null() {
                    row[key] = resume[key].clone();
                }
            }
            rows.push(row);
        }
        Ok(json!(rows))
    }
}
