//! What became of a mail's native wake-up, and ringing again after a refusal
//! (T-50, elasticLM).
//!
//! The mail itself is saved before Core tries to wake its recipient and stays
//! in the mailbox whatever happens to that wake-up. A wake-up the harness
//! definitely refused (`error`: a start, steer or hook it answered with a
//! refusal, such as Claude's "Effort changes must wait until the current turn
//! finishes" while a turn of its own was still open) used to stay `error`, and
//! nobody was told. Now it goes back to `pending` after a short wait, at most
//! [`RETRIES`] times, so the recipient's next eligible wake-up rings it again
//! with the usual checks and budget. An `uncertain` wake-up may have been
//! accepted and is never repeated, and mail already read is never rung again.
//! Each step is kept in the delivery detail's `retry`, and [`problem`] puts it
//! in words for the Job, the task and the conversation.
use super::skip_acknowledged;
use crate::store::Store;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

/// How many times one refused wake-up is tried again.
pub(crate) const RETRIES: i64 = 3;
/// The wait before the first retry, doubled for each one after it.
const FIRST_WAIT_SECONDS: i64 = 30;

/// Unread mail whose native wake-up was refused, with its recipient (by
/// state first: an index). Whether one is due is [`due`]'s.
const REFUSED: &str = "SELECT seq,recipient_id,delivery_detail FROM collaboration_messages m
    WHERE delivery_state='error' AND json_extract(delivery_detail,'$.mode') IN ('start','steer','hook')
      AND COALESCE(json_extract(data,'$.metadata.kind'),'')!='update_wait'
      AND NOT EXISTS(SELECT 1 FROM collaboration_message_reads r WHERE r.message_seq=m.seq AND r.reader_id=m.recipient_id)";

/// When a refused wake-up may be tried again, if at all: never past
/// [`RETRIES`], and not before its wait has passed since it failed. One
/// recorded before failures carried a time (`failedAt`) is left as it was.
fn due(detail: &Value, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
    let count = detail["retry"]["count"].as_i64().unwrap_or(0);
    let failed = detail["failedAt"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())?
        .with_timezone(&chrono::Utc);
    let wait = chrono::Duration::seconds(FIRST_WAIT_SECONDS << count.clamp(0, RETRIES));
    (count < RETRIES && now >= failed + wait).then_some(count)
}

impl Store {
    /// [`notifications`] for a Job's or run's `notifications`.
    pub(crate) fn mail_notifications(&self, notifications: &Value) -> Result<Value> {
        self::notifications(&self.db.read()?, notifications)
    }

    /// Puts refused wake-ups whose wait has passed back to pending (see the
    /// module), as `pending_peer_deliveries` reads them. Reads first, and
    /// writes only when one is due.
    pub fn retry_refused_peer_deliveries(&self) -> Result<usize> {
        let now = chrono::Utc::now();
        let due_rows = |db: &Connection| -> Result<Vec<(i64, String, i64, Value)>> {
            let mut q = db.prepare(REFUSED)?;
            let rows = q.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
            let mut out = Vec::new();
            for row in rows {
                let (seq, recipient, detail) = row?;
                let detail: Value = serde_json::from_str(&detail)?;
                if let Some(count) = due(&detail, now) {
                    out.push((seq, recipient, count, detail));
                }
            }
            Ok(out)
        };
        if due_rows(&self.db.read()?)?.is_empty() {
            return Ok(0);
        }
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut changed = 0;
        let mut recipients = std::collections::BTreeSet::new();
        for (seq, recipient, count, detail) in due_rows(&tx)? {
            let retry = json!({"count":count + 1,"of":RETRIES,"lastError":detail["error"],"lastMode":detail["mode"],
                "lastFailedAt":detail["failedAt"],"requeuedAt":crate::model::now()});
            changed += tx.execute(
                "UPDATE collaboration_messages SET delivery_state='pending',delivery_detail=?1 WHERE seq=?2 AND delivery_state='error'",
                params![json!({"retry":retry}).to_string(), seq],
            )?;
            recipients.insert(recipient);
        }
        // An acknowledged result stays quiet, as for any pending wake-up.
        for recipient in &recipients {
            skip_acknowledged(&tx, recipient)?;
        }
        tx.commit()?;
        Ok(changed)
    }
}

/// A mail's wake-up in words when it did not simply go through, or None:
/// "delivery failed: <reason>" and what happens next.
pub(crate) fn problem(state: &str, detail: &Value) -> Option<String> {
    let retry = &detail["retry"];
    let tried = retry["count"].as_i64().unwrap_or(0);
    let reason = |value: &Value| value.as_str().map(str::to_owned).unwrap_or_else(|| "no reason was recorded".into());
    match state {
        "error" => {
            let why = reason(if detail["error"].is_string() { &detail["error"] } else { &detail["reason"] });
            let next = if !detail["mode"].is_string() {
                "it is not tried again".to_owned()
            } else if tried >= RETRIES {
                format!("tried again {tried} times, not again")
            } else {
                "it is tried again at the recipient's next wake-up".to_owned()
            };
            Some(format!("delivery failed: {why}; {next}. The mail stays in the mailbox."))
        }
        "pending" | "sending" if retry.is_object() => Some(format!(
            "delivery failed: {}; trying again at the recipient's next wake-up (retry {tried} of {}). The mail stays in the mailbox.",
            reason(&retry["lastError"]),
            retry["of"].as_i64().unwrap_or(RETRIES)
        )),
        "uncertain" => Some(format!(
            "delivery uncertain: {}; the recipient may have received it, so it is not repeated. The mail stays in the mailbox.",
            reason(&detail["error"])
        )),
        _ => None,
    }
}

/// The mail problems of a task, newest first, at most `limit`: its mail
/// whose wake-up failed, is being tried again, or is uncertain.
pub(crate) fn task_problems(db: &Connection, task: &str, limit: usize) -> Result<Vec<Value>> {
    // By state first (an index), so a task with a long history costs nothing more.
    let mut q = db.prepare(
        "SELECT seq,id,data,delivery_state,delivery_detail FROM collaboration_messages
         WHERE delivery_state IN ('error','uncertain','pending','sending') AND json_extract(data,'$.taskId')=?1
         ORDER BY seq DESC",
    )?;
    let rows = q.query_map([task], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, id, data, state, detail) = row?;
        let (message, detail): (Value, Value) = (serde_json::from_str(&data)?, serde_json::from_str(&detail)?);
        if let Some(problem) = entry(seq, &id, &message, &state, &detail) {
            out.push(problem);
            if out.len() == limit {
                break;
            }
        }
    }
    Ok(out)
}

/// One mail's problem as a task or a Job lists it, or None.
pub(crate) fn entry(seq: i64, id: &str, message: &Value, state: &str, detail: &Value) -> Option<Value> {
    let problem = problem(state, detail)?;
    let metadata = &message["metadata"];
    Some(json!({"messageId":id,"seq":seq,"createdAt":message["createdAt"],"recipient":message["recipient"]["name"],
        "kind":metadata["kind"],"status":metadata["status"],"jobId":metadata["jobId"],"runId":metadata["runId"],
        "delivery":state,"problem":problem}))
}

/// Each notification of a Job (or run) by its status: the mail's delivery
/// state and, when it did not simply go through, the problem in words.
pub(crate) fn notifications(db: &Connection, notifications: &Value) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for (status, id) in notifications.as_object().into_iter().flatten() {
        // "run" and "retried" mark a stage whose run mails instead.
        let Some(id) = id.as_str().filter(|id| uuid::Uuid::parse_str(id).is_ok()) else { continue };
        let found: Option<(String, String)> = rusqlite::OptionalExtension::optional(db.query_row(
            "SELECT delivery_state,delivery_detail FROM collaboration_messages WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let Some((state, detail)) = found else { continue };
        let detail: Value = serde_json::from_str(&detail)?;
        out.insert(status.clone(), json!({"messageId":id,"delivery":state,"problem":problem(&state, &detail)}));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests;
