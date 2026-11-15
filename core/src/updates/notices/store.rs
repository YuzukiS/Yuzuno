use super::*;
use crate::store::{Sel, Store};
use rusqlite::{params, OptionalExtension};

/// A Turn from an update's original Turn on (resume.rs): its ID, its status
/// and, after the original, who its first input came from (`_yuzunoInput`,
/// as the conversation marks it; None without a user message).
#[derive(Debug)]
pub(crate) struct Starter {
    pub id: String,
    pub status: Option<String>,
    pub input: Option<String>,
}

impl Store {
    /// A single transaction retains the original targets even when there were
    /// none. Re-entering Apply/recovery must not capture a later Turn instead.
    pub(crate) fn queue_update_pause(&self, op: &Operation) -> Result<()> {
        let saved: Option<String> = self
            .db
            .read()?
            .query_row(
                "SELECT value FROM workspace_meta WHERE key='updatePauseSnapshot'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if saved.as_deref() == Some(&op.id) {
            return Ok(());
        }
        let mut targets = vec![];
        for agent in self.agents()? {
            if agent.closed_at.is_some() || !matches!(agent.status.as_str(), "working" | "waiting")
            {
                continue;
            }
            let detail = self.send_view(&agent.id)?;
            if let Some(turn) = active_turn(&detail) {
                if let Some(session) = session(&detail) {
                    targets.push((agent, turn.to_owned(), session.to_owned()));
                }
            }
        }
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT value FROM workspace_meta WHERE key='updatePauseSnapshot'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if saved.as_deref() == Some(&op.id) {
            return Ok(());
        }
        for (agent, turn, session) in targets {
            let id = format!("update-pause-{}-{}", op.id, agent.id);
            let body = format!(
                "Workspace update {} (operation {}) is waiting for your current Turn to finish, until {}. At your next safe native opportunity, save necessary progress and references on the existing task, then end this Turn. Do not start another task, wait in a polling loop, or send a receipt-only reply. Ending the Turn does not complete the task. Do not kill long-running tools, shells or Jobs to satisfy this request. This request applies only while updateWait.active is true and only to the original Turn {}. After yielding, stay idle: when the update ends, Yuzuno Core sends you one message to continue this work. Do not poll or wait for it. Cancellation or expiry releases this request and never replays prior user input.",
                op.release_id, op.id, op.deadline, turn);
            crate::collaboration_store::insert_message(
                &tx,
                json!({
                    "id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
                    "recipient":{"kind":"agent","id":agent.id,"name":agent.name},
                    "body":body,"taskId":null,"replyTo":null,"threadId":id,
                    "createdAt":super::super::state::now(),"priority":"urgent",
                    "source":{"operationId":op.id},
                    "metadata":{"kind":"update_wait","operationId":op.id,"releaseId":op.release_id,
                        "deadline":op.deadline,"turnId":turn,"sessionId":session,"harness":agent.harness}
                }),
            )?;
        }
        tx.execute(
            "INSERT INTO workspace_meta(key,value) VALUES('updatePauseSnapshot',?1)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&op.id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn update_pause_messages(&self, operation: &str) -> Result<Vec<Value>> {
        self.pause_messages(operation, "")
    }

    /// This update's pause messages whose continue (resume.rs) has no
    /// outcome yet, or was being sent when Core stopped.
    pub(crate) fn update_resume_candidates(&self, operation: &str) -> Result<Vec<Value>> {
        self.pause_messages(operation, "AND COALESCE(json_extract(m.delivery_detail,'$.resume.state'),'sending')='sending'")
    }

    fn pause_messages(&self, operation: &str, only: &str) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare(&format!(
            "SELECT m.data,m.delivery_state,m.delivery_detail,r.read_at
            FROM collaboration_messages m LEFT JOIN collaboration_message_reads r
            ON r.message_seq=m.seq AND r.reader_id=m.recipient_id
            WHERE json_extract(m.data,'$.metadata.kind')='update_wait'
            AND json_extract(m.data,'$.metadata.operationId')=?1 {only} ORDER BY m.seq",
        ))?;
        let rows = q.query_map([operation], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (raw, state, detail, read) = row?;
            let mut value: Value = serde_json::from_str(&raw)?;
            value["delivery"] =
                json!({"state":state,"detail":serde_json::from_str::<Value>(&detail)?});
            value["firstReadAt"] = json!(read);
            Ok(value)
        })
        .collect()
    }

    /// Reserve one system control message, never a range containing peer mail.
    /// Native unknown outcomes stay uncertain and are never automatically retried.
    pub(crate) fn set_update_pause_delivery(
        &self,
        message: &Value,
        from: &str,
        state: &str,
        detail: Value,
    ) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let changed = tx.execute(
            "UPDATE collaboration_messages SET delivery_state=?1,
            delivery_detail=json_patch(delivery_detail,?2) WHERE id=?3 AND delivery_state=?4
            AND json_extract(data,'$.metadata.kind')='update_wait'",
            params![state, detail.to_string(), message["id"].as_str(), from],
        )?;
        tx.commit()?;
        Ok(changed == 1)
    }

    /// Moves a pause message's continue (`delivery_detail.resume`, resume.rs)
    /// from `from` (None: it has none yet) to `to` (None removes it), only
    /// if it is still `from`. False if it was not: someone else moved it.
    pub(crate) fn set_update_resume(&self, message: &str, from: Option<&str>, to: Option<Value>) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let changed = tx.execute(
            "UPDATE collaboration_messages SET delivery_detail=CASE WHEN ?1 IS NULL
                THEN json_remove(delivery_detail,'$.resume') ELSE json_set(delivery_detail,'$.resume',json(?1)) END
            WHERE id=?2 AND json_extract(data,'$.metadata.kind')='update_wait'
            AND (CASE WHEN ?3 IS NULL THEN json_extract(delivery_detail,'$.resume') IS NULL
                ELSE json_extract(delivery_detail,'$.resume.state') IS ?3 END)",
            params![to.map(|v| v.to_string()), message, from],
        )?;
        tx.commit()?;
        Ok(changed == 1)
    }

    /// The Agent's Turns from `turn` on, oldest first (`Starter`); only the
    /// later ones are read, and only their first inputs are looked at. None
    /// if the Agent has no such Turn.
    pub(crate) fn turn_starters_since(&self, agent: &str, turn: &str) -> Result<Option<Vec<Starter>>> {
        let states = {
            let db = self.db.read()?;
            let Some(before) = crate::record_rows::turns_before(&db, agent, turn)? else {
                return Ok(None);
            };
            let count = crate::record_rows::turn_count(&db, agent)?;
            crate::record_rows::newest_turn_states(&db, agent, count.saturating_sub(before))?
        };
        anyhow::ensure!(states.first().is_some_and(|(id, _)| id == turn), "Turns changed while read");
        let later: Vec<String> = states[1..].iter().map(|(id, _)| id.clone()).collect();
        // Read after the guard above is dropped: `view` takes a reader itself.
        let turns = if later.is_empty() { vec![] } else { self.view(agent, Sel::Turns(later))?.turns };
        Ok(Some(states.into_iter().enumerate().map(|(at, (id, status))| {
            let input = (at > 0).then(|| turns.iter().find(|t| t["id"] == id.as_str())).flatten()
                .and_then(|t| t["items"].as_array()?.iter().find(|i| i["type"] == "userMessage"))
                .and_then(|i| i["_yuzunoInput"].as_str().map(str::to_owned));
            Starter { id, status, input }
        }).collect()))
    }
}
