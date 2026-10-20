use super::*;
use crate::store::Store;
use rusqlite::{params, OptionalExtension};

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
            let detail = self.detail(&agent.id)?;
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
                "Workspace update {} (operation {}) is waiting for your current Turn to finish, until {}. At your next safe native opportunity, save necessary progress and references on the existing task, then end this Turn. Do not start another task, wait in a polling loop, or send a receipt-only reply. Ending the Turn does not complete the task. Do not kill long-running tools, shells or Jobs to satisfy this request. This request applies only while updateWait.active is true and only to the original Turn {}. After yielding, stay idle; the user chooses when to continue. Cancellation or expiry releases this request and never replays prior user input.",
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
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT m.data,m.delivery_state,m.delivery_detail,r.read_at
            FROM collaboration_messages m LEFT JOIN collaboration_message_reads r
            ON r.message_seq=m.seq AND r.reader_id=m.recipient_id
            WHERE json_extract(m.data,'$.metadata.kind')='update_wait'
            AND json_extract(m.data,'$.metadata.operationId')=?1 ORDER BY m.seq",
        )?;
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
}
