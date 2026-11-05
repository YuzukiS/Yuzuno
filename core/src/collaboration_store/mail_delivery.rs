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

/// Unread mail whose native wake-up was refused, to a recipient still open,
/// with that recipient (by state first: an index). Whether one is due is
/// [`due`]'s. A closed recipient's batches are never rung
/// (`pending_peer_deliveries`), so its refusals are not requeued at all.
const REFUSED: &str = "SELECT seq,recipient_id,delivery_detail FROM collaboration_messages m
    WHERE delivery_state='error' AND json_extract(delivery_detail,'$.mode') IN ('start','steer','hook')
      AND COALESCE(json_extract(data,'$.metadata.kind'),'')!='update_wait'
      AND NOT EXISTS(SELECT 1 FROM collaboration_message_reads r WHERE r.message_seq=m.seq AND r.reader_id=m.recipient_id)
      AND EXISTS(SELECT 1 FROM agents a WHERE a.id=m.recipient_id AND json_extract(a.data,'$.agent.closedAt') IS NULL)";

/// When a wake-up was refused, if Core recorded it: refusals from before
/// it did have none.
fn failed_at(detail: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    detail["failedAt"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.with_timezone(&chrono::Utc))
}

/// Why a wake-up waiting to ring again never will: its recipient is closed
/// (or gone), or has read the mail. Pending mail rings only for an open
/// recipient that has not read it (`pending_peer_deliveries`).
fn stopped(read: bool, closed: bool) -> Option<&'static str> {
    if closed {
        Some("it is not tried again: the recipient is closed")
    } else if read {
        Some("it is not tried again: the recipient has read the mail")
    } else {
        None
    }
}

/// Why Core does not try this refused wake-up again, or None when it does,
/// at the recipient's next wake-up once its wait has passed: the one rule
/// [`due`] acts on and [`problem`] puts in words. Never for mail without a
/// wake-up of its own (a result mail to a closed recipient, an update's
/// notice), mail to a recipient closed since, mail the recipient has read, a
/// refusal from before Core recorded when it happened, or one tried
/// [`RETRIES`] times.
fn not_again(detail: &Value, read: bool, closed: bool, kind: Option<&str>) -> Option<String> {
    let tried = detail["retry"]["count"].as_i64().unwrap_or(0);
    if !matches!(detail["mode"].as_str(), Some("start" | "steer" | "hook")) || kind == Some("update_wait") {
        Some("it is not tried again".to_owned())
    } else if let Some(why) = stopped(read, closed) {
        Some(why.to_owned())
    } else if failed_at(detail).is_none() {
        Some("it is not tried again: it was refused before Core recorded refusal times".to_owned())
    } else if tried >= RETRIES {
        Some(format!("tried again {tried} times, not again"))
    } else {
        None
    }
}

/// When a refused wake-up is tried again: by [`not_again`]'s rule, and not
/// before its wait has passed since it failed. [`REFUSED`] reads only unread
/// mail with a wake-up of its own, to an open recipient.
fn due(detail: &Value, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
    if not_again(detail, false, false, None).is_some() {
        return None;
    }
    let count = detail["retry"]["count"].as_i64().unwrap_or(0);
    let wait = chrono::Duration::seconds(FIRST_WAIT_SECONDS << count.clamp(0, RETRIES));
    (now >= failed_at(detail)? + wait).then_some(count)
}

impl Store {
    /// [`notifications`] for a Job's or run's `notifications`.
    pub(crate) fn mail_notifications(&self, notifications: &Value) -> Result<Value> {
        let db = self.db.read()?;
        self::notifications(&db, notifications)
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
        let none_due = {
            let db = self.db.read()?;
            due_rows(&db)?.is_empty()
        };
        if none_due {
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
/// "delivery failed: <reason>" and what happens next, by the rule Core acts
/// on ([`not_again`]). `read`: the recipient has read the mail; `closed`:
/// the recipient is closed or gone; `kind` is its metadata kind.
pub(crate) fn problem(state: &str, detail: &Value, read: bool, closed: bool, kind: Option<&str>) -> Option<String> {
    let retry = &detail["retry"];
    let tried = retry["count"].as_i64().unwrap_or(0);
    let reason = |value: &Value| value.as_str().map(str::to_owned).unwrap_or_else(|| "no reason was recorded".into());
    match state {
        "error" => {
            let why = reason(if detail["error"].is_string() { &detail["error"] } else { &detail["reason"] });
            let next = not_again(detail, read, closed, kind).unwrap_or_else(|| "it is tried again at the recipient's next wake-up".to_owned());
            Some(format!("delivery failed: {why}; {next}. The mail stays in the mailbox."))
        }
        // Back in pending, it rings only for an open recipient that has not read it.
        "pending" | "sending" if retry.is_object() && stopped(read, closed).is_some() => Some(format!(
            "delivery failed: {}; {}. The mail stays in the mailbox.",
            reason(&retry["lastError"]),
            stopped(read, closed).unwrap_or_default()
        )),
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
    let mut q = db.prepare(&format!(
        "SELECT seq,id,data,delivery_state,delivery_detail,{READ},{CLOSED} FROM collaboration_messages m
         WHERE delivery_state IN ('error','uncertain','pending','sending') AND json_extract(data,'$.taskId')=?1
         ORDER BY seq DESC"
    ))?;
    let rows = q.query_map([task], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?,
            r.get::<_, bool>(5)?, r.get::<_, bool>(6)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, id, data, state, detail, read, closed) = row?;
        let (message, detail): (Value, Value) = (serde_json::from_str(&data)?, serde_json::from_str(&detail)?);
        if let Some(problem) = entry(seq, &id, &message, &state, &detail, read, closed) {
            out.push(problem);
            if out.len() == limit {
                break;
            }
        }
    }
    Ok(out)
}

/// Whether the recipient has read a mail `m`, as a column of a query.
pub(crate) const READ: &str = "EXISTS(SELECT 1 FROM collaboration_message_reads r WHERE r.message_seq=m.seq AND r.reader_id=m.recipient_id)";
/// Whether a mail `m`'s recipient is closed or gone, as a column of a query.
pub(crate) const CLOSED: &str = "NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=m.recipient_id AND json_extract(a.data,'$.agent.closedAt') IS NULL)";

/// One mail's problem as a task or a Job lists it, or None.
pub(crate) fn entry(seq: i64, id: &str, message: &Value, state: &str, detail: &Value, read: bool, closed: bool) -> Option<Value> {
    let metadata = &message["metadata"];
    let problem = problem(state, detail, read, closed, metadata["kind"].as_str())?;
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
        let found: Option<(String, String, bool, bool, Option<String>)> = rusqlite::OptionalExtension::optional(db.query_row(
            &format!("SELECT delivery_state,delivery_detail,{READ},{CLOSED},json_extract(data,'$.metadata.kind') FROM collaboration_messages m WHERE id=?1"),
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ))?;
        let Some((state, detail, read, closed, kind)) = found else { continue };
        let detail: Value = serde_json::from_str(&detail)?;
        out.insert(status.clone(), json!({"messageId":id,"delivery":state,"problem":problem(&state, &detail, read, closed, kind.as_deref())}));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests;
