//! Which of Core's quiet notices an Agent wants to wake it anyway (YN-68 S2).
//!
//! Core decides each mail's wake-up as it writes it (`mail_wake.rs`). By
//! default its quiet notices start no Turn. An Agent may say, for itself
//! only, that every notice should wake it (`mode: "all"`, as before quiet
//! notices existed), or that those of a few tasks should (`wakeForTasks`,
//! for example a merge a release waits for). A setting applies to mail
//! written after it; a task done, cancelled or archived no longer counts.
use super::*;

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS agent_mail_preferences(
    agent_id TEXT PRIMARY KEY, mode TEXT NOT NULL, tasks TEXT NOT NULL, updated_at TEXT NOT NULL);";

/// At most this many tasks in `wakeForTasks`.
pub(crate) const TASKS: usize = 10;
const DEFAULT_MODE: &str = "actions";

/// Whether an input sets something, rather than reading.
pub(super) fn writes(input: &Value) -> bool {
    input.get("mode").is_some() || input.get("wakeForTasks").is_some()
}

/// The `mail_preferences` operation: reads the caller's preferences, or sets
/// the fields it gives (the others keep their value).
pub(super) fn call(db: &Connection, actor: &TaskActor, input: &Value) -> Result<Value> {
    allowed(input, &["requestId", "mode", "wakeForTasks"])?;
    ensure!(actor.kind == "agent", "invalid_input: mail_preferences is an Agent's own; call it as that Agent");
    ensure!(
        writes(input) || input.get("requestId").is_none(),
        "invalid_input: give mode or wakeForTasks to set them, or neither (and no requestId) to read"
    );
    let (mut mode, mut tasks, mut updated) = stored(db, &actor.id)?;
    if writes(input) {
        if let Some(value) = input.get("mode") {
            mode = match value.as_str() {
                Some(m @ ("actions" | "all")) => m.to_owned(),
                _ => bail!("invalid_input: mode must be actions or all"),
            };
        }
        if let Some(value) = input.get("wakeForTasks") {
            let list = value.as_array().context("invalid_input: wakeForTasks must be a list of tasks")?;
            ensure!(list.len() <= TASKS, "invalid_input: wakeForTasks names at most {TASKS} tasks");
            let mut ids = Vec::new();
            for reference in list {
                let reference = reference.as_str().context("invalid_input: wakeForTasks must be a list of tasks")?;
                let (id, _) = task_key(db, reference)?;
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            tasks = ids;
        }
        updated = Some(now());
        db.execute(
            "INSERT INTO agent_mail_preferences(agent_id,mode,tasks,updated_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(agent_id) DO UPDATE SET mode=excluded.mode,tasks=excluded.tasks,updated_at=excluded.updated_at",
            params![actor.id, mode, json!(tasks).to_string(), updated],
        )?;
    }
    let keys = tasks.iter().map(|id| task_shown(db, id)).collect::<Vec<_>>();
    Ok(json!({"preferences":{"mode":mode,"wakeForTasks":keys,"updatedAt":updated},
        "applies":"to mail written from now on; mail already in your mailbox keeps its wake"}))
}

/// An Agent's mode, its tasks' internal IDs and when it set them; the default
/// when it never did.
fn stored(db: &Connection, agent: &str) -> Result<(String, Vec<String>, Option<String>)> {
    let row: Option<(String, String, String)> = db
        .query_row(
            "SELECT mode,tasks,updated_at FROM agent_mail_preferences WHERE agent_id=?1",
            [agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(match row {
        Some((mode, tasks, at)) => (mode, serde_json::from_str(&tasks)?, Some(at)),
        None => (DEFAULT_MODE.to_owned(), Vec::new(), None),
    })
}

/// Whether `agent`'s preferences make a quiet notice about `task` (its
/// internal ID, if any) ring: mode all, or an open task it named.
pub(crate) fn rings(db: &Connection, agent: &str, task: Option<&SharedTask>) -> Result<bool> {
    let (mode, tasks, _) = stored(db, agent)?;
    Ok(mode == "all"
        || task.is_some_and(|task| {
            tasks.contains(&task.id) && task.archived_at.is_none() && !matches!(task.status.as_str(), "done" | "cancelled")
        }))
}

/// The tool, at most 2048 UTF-16 units of description (Claude Code's cut).
pub(crate) fn tool_definition(task_reference: &Value) -> Value {
    json!({"name":"mail_preferences",
        "description":"Read or set which of Core's quiet notices wake you; without requestId it reads. Core decides each mail's wake as it writes it (peer_read shows it). Quiet notices ask nothing of you: a PR merged while its task's executor still works, main CI green on it to anyone but that executor, a merge queue unpaused, executor templates changed, a released executor's success on a task that is closed. By default (mode actions) they start no Turn and come with your next wake-up. mode all makes every notice wake you, as before. wakeForTasks: up to 10 tasks whose quiet notices wake you anyway, e.g. a merge a release cut waits for; it replaces the list, and a task done, cancelled or archived no longer counts. A setting applies to mail written after it. Results, failures, refusals, pauses, red CI and questions always wake you.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":[],"properties":{
            "requestId":{"type":"string","minLength":1,"maxLength":128,"description":"Required to set; a new one for each change. Omit to read."},
            "mode":{"type":"string","enum":["actions","all"]},
            "wakeForTasks":{"type":"array","maxItems":TASKS,"items":task_reference}}}})
}

#[cfg(test)]
mod tests;
