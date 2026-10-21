//! A dispatch identifies a particular assignment, not a task version. Its
//! immutable activity snapshot also prevents a former executor from silently
//! becoming an unbound collaborator by omitting the dispatch identity.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDispatch {
    pub id: String,
    pub requested_by: TaskActor,
    pub notification_recipient: Option<TaskActor>,
    pub executor: TaskActor,
    pub source: Value,
    pub dispatched_at: String,
    pub active: bool,
    pub invalidated_at: Option<String>,
    pub invalidated_reason: Option<String>,
}

impl TaskDispatch {
    pub(super) fn new(actor: &TaskActor, source: &Value, executor: &TaskActor) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            requested_by: actor.clone(),
            notification_recipient: (actor.kind == "agent").then(|| actor.clone()),
            executor: executor.clone(),
            source: source.clone(),
            dispatched_at: now(),
            active: true,
            invalidated_at: None,
            invalidated_reason: None,
        }
    }
}

/// The task's newest dispatch, read through collaboration_activity_dispatched.
pub(super) const LATEST_DISPATCH: &str = "SELECT seq,json_extract(data,'$.dispatch') FROM collaboration_task_activity
     WHERE task_id=?1 AND json_extract(data,'$.kind')='dispatched' ORDER BY seq DESC LIMIT 1";
/// The edits after it that can end it (archived, cancelled, another assignee),
/// read through collaboration_activity_dispatch_end: the task's other history
/// (notes, mail, results, other edits) is never read for it.
pub(super) const DISPATCH_ENDS: &str = "SELECT json_extract(data,'$.changes'),COALESCE(json_extract(data,'$.dispatchInvalidatedAt'),json_extract(data,'$.at'))
     FROM collaboration_task_activity WHERE task_id=?1 AND seq>?2
     AND json_extract(data,'$.kind') IN ('updated','claimed') AND (json_type(data,'$.changes.archived') IS NOT NULL
     OR json_extract(data,'$.changes.status')='cancelled' OR json_type(data,'$.changes.assigneeAgentId') IS NOT NULL)
     ORDER BY seq";

/// Append-only activity is the authority. An older Core may rewrite the typed
/// task JSON without our cached field, but it preserves dispatched activities
/// and records subsequent assignment/status edits in the same transaction.
pub(super) fn project(db: &Connection, task: &SharedTask) -> Result<Option<TaskDispatch>> {
    let latest: Option<(i64, Option<String>)> = db
        .query_row(
            LATEST_DISPATCH,
            [&task.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((seq, Some(raw))) = latest else {
        // An untracked legacy re-dispatch must never inherit a previous ID.
        return Ok(None);
    };
    let mut dispatch: TaskDispatch = serde_json::from_str(&raw)?;
    let mut query = db.prepare(DISPATCH_ENDS)?;
    let rows = query.query_map(params![task.id, seq], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (patch, at) = row?;
        let patch: Value = serde_json::from_str(&patch)?;
        let reason = if patch["archived"] == true {
            Some("task_archived")
        } else if patch["status"] == "cancelled" {
            Some("task_cancelled")
        } else if patch
            .get("assigneeAgentId")
            .is_some_and(|id| id != &json!(dispatch.executor.id))
        {
            Some("assignee_changed")
        } else {
            None
        };
        if let Some(reason) = reason {
            dispatch.active = false;
            dispatch.invalidated_at = Some(at);
            dispatch.invalidated_reason = Some(reason.into());
            break;
        }
    }
    // Also fail closed if data was edited without a corresponding activity.
    if dispatch.active
        && (task.archived_at.is_some()
            || task.status == "cancelled"
            || task.assignee_agent_id.as_deref() != Some(dispatch.executor.id.as_str()))
    {
        dispatch.active = false;
        dispatch.invalidated_at = Some(task.updated_at.clone());
        dispatch.invalidated_reason = Some("task_state_changed".into());
    }
    Ok(Some(dispatch))
}

pub(super) fn invalidate(task: &mut SharedTask, previous_assignee: Option<&str>) {
    let reason = if task.archived_at.is_some() {
        Some("task_archived")
    } else if task.status == "cancelled" {
        Some("task_cancelled")
    } else if task.assignee_agent_id.as_deref() != previous_assignee {
        Some("assignee_changed")
    } else {
        None
    };
    if let (Some(dispatch), Some(reason)) = (task.dispatch.as_mut(), reason) {
        if dispatch.active {
            dispatch.active = false;
            dispatch.invalidated_at = Some(now());
            dispatch.invalidated_reason = Some(reason.into());
        }
    }
}

pub(super) fn validate(
    db: &Connection,
    task: &SharedTask,
    actor: &TaskActor,
    input: &Value,
) -> Result<Option<TaskDispatch>> {
    if input.get("dispatchId").is_some() {
        let id = required_text(input, "dispatchId", 128)?;
        let dispatch = task
            .dispatch
            .as_ref()
            .context("stale_dispatch: task has no current dispatch")?;
        ensure!(dispatch.id == id && dispatch.active
            && task.archived_at.is_none() && task.status != "cancelled"
            && task.assignee_agent_id.as_deref() == Some(dispatch.executor.id.as_str()),
            "stale_dispatch: this assignment was superseded or invalidated; current task was not changed");
        ensure!(
            actor.kind == "agent" && actor.id == dispatch.executor.id,
            "dispatch_actor_mismatch: only this dispatch's executor can report its result"
        );
        return Ok(Some(dispatch.clone()));
    }
    if actor.kind == "agent" {
        let was_executor: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM collaboration_task_activity WHERE task_id=?1
             AND json_extract(data,'$.dispatch.id') IS NOT NULL AND json_extract(data,'$.kind')='dispatched')
             AND EXISTS(SELECT 1 FROM collaboration_task_activity WHERE task_id=?1
             AND json_extract(data,'$.changes.assigneeAgentId')=?2 AND json_extract(data,'$.kind')='dispatched')",
            params![task.id, actor.id], |r| r.get(0))?;
        ensure!(!was_executor && !task.dispatch.as_ref().is_some_and(|d| d.executor.id == actor.id),
            "dispatch_id_required: use the dispatchId from your original assignment message; never infer the latest dispatch from expectedVersion");
    }
    // Pre-upgrade assignments have no identity to infer. GUI users and Agents
    // who have not executed a tracked dispatch retain their unbound contract.
    Ok(None)
}

pub(super) fn notification(
    store: &Store,
    db: &Connection,
    dispatch: Option<&TaskDispatch>,
) -> Result<Value> {
    let Some(dispatch) = dispatch else {
        return Ok(json!({"state":"not_requested","reason":"unbound_result"}));
    };
    let Some(recipient) = &dispatch.notification_recipient else {
        return Ok(json!({"state":"not_requested","reason":"user_dispatch"}));
    };
    let reason = match store.brief_in(db, &recipient.id)? {
        None => Some("recipient_deleted"),
        Some(brief) if brief.agent.closed_at.is_some() => Some("recipient_closed"),
        Some(_) => None,
    };
    Ok(
        json!({"messageId":uuid::Uuid::new_v4().to_string(),"recipient":recipient,
        "state":if reason.is_some() { "error" } else { "pending" },"reason":reason}),
    )
}

pub(super) fn notify(store: &Store, db: &Connection, task: &SharedTask, event: &Value) -> Result<Option<Value>> {
    let result = task.result.as_ref().context("Missing submitted result")?;
    let notification = &result["notification"];
    let Some(message_id) = notification["messageId"].as_str() else {
        return Ok(None);
    };
    let number = task_number(task.seq);
    let seq = event["seq"]
        .as_i64()
        .context("Missing result activity sequence")?;
    let summary = result["summary"].as_str().unwrap_or_default();
    let excerpt = summary.chars().take(1_200).collect::<String>();
    let mut body = format!("{number}: {} ({}) submitted a result with status {}. Result {} for dispatch {}.\n{}{}\nRead task_get(taskId={number}, afterSeq={}) for this result's full summary, evidence links and original author/source. Submission is the author's report, not independent review, acceptance, merging or deployment.",
        result["reportedBy"]["name"].as_str().unwrap_or("Agent"),
        result["reportedBy"]["id"].as_str().unwrap_or("unknown"), task.status,
        result["id"].as_str().unwrap_or_default(), result["dispatchId"].as_str().unwrap_or_default(),
        excerpt, if excerpt.len() < summary.len() { "…" } else { "" }, seq - 1);
    // The recipient may be the one who keeps the Project's Home: advice only.
    // A failed lookup leaves the advice out; it never fails the result.
    if let Some(recipient) = notification["recipient"]["id"].as_str() {
        match crate::project_brief::home_hint(store, db, &task.id, recipient) {
            Ok(Some(hint)) => {
                body.push('\n');
                body.push_str(hint);
            }
            Ok(None) => {}
            Err(error) => eprintln!("Home hint for {number}'s result mail: {error:#}"),
        }
    }
    let message = insert_message(
        db,
        json!({"id":message_id,"seq":0,
        "sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
        "recipient":notification["recipient"],"body":body,"taskId":task.id,
        "replyTo":null,"threadId":message_id,"createdAt":now(),"priority":"normal",
        "source":result["source"],"reportedBy":result["reportedBy"],
        "dispatchId":result["dispatchId"],"resultId":result["id"],"resultActivitySeq":seq,
        "metadata":{"kind":"task_result","status":task.status,"resultId":result["id"]}}),
    )?;
    if notification["state"] == "error" {
        db.execute("UPDATE collaboration_messages SET delivery_state='error',delivery_detail=?2 WHERE id=?1",
            params![message_id, json!({"reason":notification["reason"],"at":now()}).to_string()])?;
        return Ok(Some(load_message(db, message_id)?));
    }
    Ok(Some(message))
}

#[cfg(test)]
mod tests;
