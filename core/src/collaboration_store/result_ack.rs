//! The Agent a result notified says, by its exact resultId and dispatchId,
//! that it has handled it. Core keeps that fact and skips the result's wake-up
//! if it has not been sent yet. The message, its read marks and the task's
//! history stay; reading, task_get, a done status or a comment never imply it.
use super::*;

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS collaboration_result_acks(
    result_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL, acked_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS collaboration_result_acks_actor ON collaboration_result_acks(actor_id);";

pub(super) fn acknowledge(db: &Connection, actor: &TaskActor, input: &Value) -> Result<Value> {
    allowed(input, &["requestId", "taskId", "resultId", "dispatchId"])?;
    let task = load_task(db, &required_text(input, "taskId", 128)?)?;
    let result_id = required_text(input, "resultId", 128)?;
    let dispatch_id = required_text(input, "dispatchId", 128)?;
    // Any retained result of this task, not only the latest one.
    let raw: Option<String> = db
        .query_row(
            "SELECT json_extract(data,'$.result') FROM collaboration_task_activity
             WHERE task_id=?1 AND json_extract(data,'$.kind')='result' AND json_extract(data,'$.result.id')=?2",
            params![task.id, result_id],
            |r| r.get(0),
        )
        .optional()?;
    let result: Value = serde_json::from_str(
        &raw.context("result_not_found: this task has no result with that resultId")?,
    )?;
    ensure!(
        result["dispatchId"].as_str() == Some(dispatch_id.as_str()),
        "result_dispatch_mismatch: this result was not reported for that dispatchId"
    );
    let notification = &result["notification"];
    let message_id = notification["messageId"].as_str().filter(|_| {
        actor.kind == "agent"
            && notification["recipient"]["kind"] == "agent"
            && notification["recipient"]["id"].as_str() == Some(actor.id.as_str())
    });
    let message_id =
        message_id.context("result_ack_forbidden: only the Agent this result notified can acknowledge it")?;
    let added = db.execute(
        "INSERT INTO collaboration_result_acks(result_id,task_id,dispatch_id,message_id,actor_id,acked_at)
         VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(result_id) DO NOTHING",
        params![result_id, task.id, dispatch_id, message_id, actor.id, now()],
    )?;
    skip_acknowledged(db, &actor.id)?;
    let acked_at: String = db.query_row(
        "SELECT acked_at FROM collaboration_result_acks WHERE result_id=?1",
        [&result_id],
        |r| r.get(0),
    )?;
    let state: String = db.query_row(
        "SELECT delivery_state FROM collaboration_messages WHERE id=?1",
        [message_id],
        |r| r.get(0),
    )?;
    Ok(json!({"acknowledgment":{"taskId":task_number(task.seq),"resultId":result_id,
        "dispatchId":dispatch_id,"acknowledgedAt":acked_at,"alreadyAcknowledged":added == 0},
        "wakeUp":{"messageId":message_id,"state":state}}))
}

/// Skips the not-yet-sent wake-ups of results this recipient acknowledged:
/// only pending mail. A reservation in flight (sending), an unknown outcome
/// (uncertain), a delivered notice or an error keeps its state; if a deferred
/// notice comes back to pending, the next call here skips it.
pub(crate) fn skip_acknowledged(db: &Connection, recipient: &str) -> Result<usize> {
    Ok(db.execute(
        "UPDATE collaboration_messages SET delivery_state='skipped',delivery_detail=json_patch(delivery_detail,?2)
         WHERE recipient_id=?1 AND delivery_state='pending'
           AND id IN (SELECT message_id FROM collaboration_result_acks WHERE actor_id=?1)",
        params![recipient, json!({"reason":"result_acknowledged","at":now()}).to_string()],
    )?)
}

#[cfg(test)]
mod tests;
