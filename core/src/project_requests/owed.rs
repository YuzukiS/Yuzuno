//! What a route owes of its request's images and files (YN-173). An Agent
//! that has not started takes no message from Home (executor_slots.rs
//! `executor_slot_gate`), and a task description or a mail carries neither,
//! so a request routed to a new executor's card, or to a card whose executor
//! still waits for its slot, records them owed to the card (routes.rs).
//! Once the Agent answering for the card has started, Core sends them as a
//! hand-off to a running Agent sends them (`routes::hand_off`): copied to it
//! then (`input_images::adopt`, `input_files::adopt`), with every check and
//! quota, for the harness and machine it started with, which routing may
//! have changed at its start (routing_policy/dispatch.rs `start_as`). The
//! collaboration worker runs this before mail (collaboration_runtime.rs).
use super::{
    routes::{self, Carrier, Opening, RouteRow, CARD, DONE},
    waits_for_slot,
};
use crate::{model::AgentDetail, workspace::Workspace};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::sync::Arc;

/// What a route owes, as its `attachments` column says: owed until it goes;
/// sent once its message has a receipt; gone when its card's task ended
/// first (nothing copied or sent); failed when even the message without them
/// was refused.
pub(super) const OWED: &str = "owed";
pub(super) const SENT: &str = "sent";
pub(super) const GONE: &str = "gone";
pub(super) const FAILED: &str = "failed";

/// The tries of a hand-off refused for a reason other than its images or
/// files (which go without them, `routes::hand_off`): after these, it goes
/// without any of them, the line saying why.
const TRIES: i64 = 3;

/// The least time between two tries, in seconds.
const SPACING: i64 = 60;

/// An owed route of a routing that is done, and who answers for its card
/// now, unless that Agent still waits for its slot.
struct Owed {
    row: RouteRow,
    task: String,
    ended: bool,
    agent: Option<String>,
}

/// The owed routes, oldest first: one read of the partial index when none is.
fn owed(db: &Connection) -> Result<Vec<Owed>> {
    let mut found = Vec::new();
    for row in routes::rows(db, "attachments='owed' AND state=?1 ORDER BY at, rowid", [DONE])? {
        let Some(task) = row.task_id.clone() else { continue };
        let ended = crate::project_brief::task_ended(db, &task)?;
        let agent = match crate::project_brief::responsible_agent(db, &task)? {
            Some(agent) if !waits_for_slot(db, &agent)? => Some(agent),
            _ => None,
        };
        found.push(Owed { row, task, ended, agent });
    }
    Ok(found)
}

/// Whether `detail`'s Agent takes the message now, as a hand-off reaches a
/// running Agent, and whether it has had no Turn yet; None: not yet. It is
/// open and connected, and no message of its has an unknown outcome (which
/// holds every next one back, workspace.rs). Codex, Claude and OpenCode take
/// it into a running Turn, so they get it once their first has begun (their
/// dispatch's mail begins it) or ended; dsh takes no message while a Turn
/// runs (dsh_agent.rs `dsh_admit`), so it gets it while idle.
fn ready(detail: &AgentDetail) -> Option<bool> {
    let agent = &detail.agent;
    if agent.closed_at.is_some() || agent.connection_state != "connected" {
        return None;
    }
    if detail.message_receipts.iter().any(|receipt| matches!(receipt.status.as_str(), "sending" | "uncertain")) {
        return None;
    }
    let busy = matches!(agent.status.as_str(), "working" | "waiting") || detail.turns.iter().any(|turn| turn["status"] == "inProgress");
    let first = detail.turns.is_empty();
    match agent.harness.as_str() {
        "dsh" => (!busy).then_some(first),
        _ => (busy || !first).then_some(first),
    }
}

/// Whether the last try was at least `SPACING` ago.
fn spaced(note: &Value) -> bool {
    let at = note["at"].as_str().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok());
    at.is_none_or(|at| chrono::Utc::now().signed_duration_since(at).num_seconds() >= SPACING)
}

impl Workspace {
    /// Sends each owed route's images and files to the Agent answering for
    /// its card, once it has started and takes them (`ready`); a card whose
    /// task ended first is owed them no more. Nothing while an update drains.
    pub(crate) async fn deliver_owed_attachments(self: &Arc<Self>) -> Result<()> {
        let Ok(_permit) = self.admission.enter_work() else { return Ok(()) };
        let owed = self.stored(|store| owed(&*store.db.read()?)).await?;
        for owed in owed {
            let id = owed.row.id.clone();
            if let Err(error) = self.deliver_owed(owed).await {
                eprintln!("Route {id}: its request's images and files could not be sent: {error:#}");
            }
        }
        Ok(())
    }

    async fn deliver_owed(self: &Arc<Self>, owed: Owed) -> Result<()> {
        let Owed { row, task, ended, agent } = owed;
        if ended {
            return self.settle_owed(&row, GONE, None).await;
        }
        let Some(agent) = agent else { return Ok(()) };
        let Ok(detail) = self.send_view(&agent).await else { return Ok(()) };
        let Some(first) = ready(&detail) else { return Ok(()) };
        if row.attachments_note.as_ref().is_some_and(|note| !spaced(note)) {
            return Ok(());
        }
        // One at a time with project_route's own calls on this request
        // (routes.rs `call`), which may hand it off too: under the same gate,
        // and read again under it. Both send under the route's client ID, so
        // one message is ever sent (`send`).
        let request = row.request_id.clone().context("a route of the user's owes nothing")?;
        let gate = self.gate(&format!("project-route:{request}")).await;
        let Ok(_held) = gate.try_lock() else { return Ok(()) };
        let (id, bound) = (row.id.clone(), task.clone());
        let read = self.stored(move |store| {
            let db = store.db.read()?;
            let Some(row) = routes::rows(&db, "id=?1", [&id])?.pop() else { return Ok(None) };
            let ctx = routes::ctx_of(&db, &row)?;
            Ok(Some((row, ctx, crate::collaboration_store::task_shown(&db, &bound))))
        }).await?;
        let Some((row, ctx, key)) = read.filter(|(row, _, _)| row.attachments.as_deref() == Some(OWED)) else { return Ok(()) };
        let note = row.attachments_note.clone().unwrap_or_else(|| json!({}));
        let tries = note["tries"].as_i64().unwrap_or(0);
        // Its tries spent: the message goes without any of them, saying why.
        let unsent = (tries >= TRIES).then(|| note["error"].as_str().unwrap_or("it was refused").to_owned());
        let head;
        let opening = match row.kind.as_str() {
            CARD => Opening::Attachments { task: &key, words: Carrier::Description, first },
            _ if row.target_agent_id.as_deref() == Some(agent.as_str()) => Opening::Attachments { task: &key, words: Carrier::Mail, first },
            // The card was reassigned before it went: the Agent answering for
            // it now never had the front desk's mail, so the words go too.
            _ => {
                head = routes::hand_off_head(&ctx, &key);
                Opening::Words(&head)
            }
        };
        match routes::hand_off(self, &ctx, &row, &agent, opening, unsent.as_deref()).await {
            Ok(()) => {
                let mut sent = json!({"to":agent,"tries":tries});
                if unsent.is_some() {
                    sent["unsent"] = json!(true);
                    sent["error"] = note["error"].clone();
                }
                self.settle_owed(&row, SENT, Some(sent)).await
            }
            Err(error) if unsent.is_some() => {
                self.settle_owed(&row, FAILED, Some(json!({"to":agent,"tries":tries,"unsent":true,"error":format!("{error:#}")}))).await
            }
            Err(error) => {
                let tried = json!({"tries":tries + 1,"at":crate::model::now(),"error":format!("{error:#}")});
                let id = row.id.clone();
                self.stored(move |store| {
                    store.db.write()?.execute("UPDATE project_routes SET attachments_note=?2 WHERE id=?1 AND attachments='owed'",
                        params![id, tried.to_string()])?;
                    Ok(())
                }).await?;
                Err(error)
            }
        }
    }

    /// What the route owed is settled: sent, gone or failed, with its note.
    async fn settle_owed(self: &Arc<Self>, row: &RouteRow, state: &'static str, note: Option<Value>) -> Result<()> {
        let id = row.id.clone();
        let project = self.stored(move |store| {
            let db = store.db.write()?;
            db.execute("UPDATE project_routes SET attachments=?2,attachments_note=COALESCE(?3,attachments_note) WHERE id=?1 AND attachments='owed'",
                params![id, state, note.map(|note| note.to_string())])?;
            Ok(db.query_row("SELECT project_id FROM project_routes WHERE id=?1", [&id], |r| r.get::<_, String>(0))?)
        }).await?;
        super::announce(self, &project);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(harness: &str, status: &str, turns: Value) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":"x","name":"X","cwd":"/synthetic","model":"m","color":"sage","harness":harness,
            "status":status,"connectionState":"connected","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,
            "reviewedSeq":0},"turns":turns,"pending":[],"artifacts":[]}))
        .unwrap()
    }

    /// Codex, Claude and OpenCode wait for the Turn their dispatch's mail
    /// begins, then take it into that Turn or a new one; dsh only while idle.
    #[test]
    fn an_agent_takes_its_owed_message_into_a_turn_or_dsh_while_idle() {
        let running = json!([{"id":"t1","status":"inProgress"}]);
        let ended = json!([{"id":"t1","status":"completed"}]);
        for harness in ["codex", "claude", "opencode"] {
            assert_eq!(ready(&detail(harness, "idle", json!([]))), None, "{harness}: before its first Turn");
            assert_eq!(ready(&detail(harness, "working", running.clone())), Some(false), "{harness}: into its Turn");
            assert_eq!(ready(&detail(harness, "idle", ended.clone())), Some(false), "{harness}: a new Turn");
        }
        assert_eq!(ready(&detail("dsh", "idle", json!([]))), Some(true), "dsh: before its first Turn, saying where its dispatch is");
        assert_eq!(ready(&detail("dsh", "working", running)), None, "dsh: not while a Turn runs");
        assert_eq!(ready(&detail("dsh", "idle", ended)), Some(false));
        let mut away = detail("codex", "idle", json!([{"id":"t1","status":"completed"}]));
        away.agent.connection_state = "disconnected".into();
        assert_eq!(ready(&away), None, "not connected");
    }

    #[test]
    fn a_try_waits_a_minute_after_the_last() {
        assert!(spaced(&json!({})));
        assert!(!spaced(&json!({"at":chrono::Utc::now().to_rfc3339()})));
        assert!(spaced(&json!({"at":(chrono::Utc::now() - chrono::Duration::seconds(SPACING)).to_rfc3339()})));
    }
}
