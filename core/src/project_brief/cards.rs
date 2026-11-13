//! Cards (YN-86 S2a, docs/home-v1.md "卡片、任务与负责人"): a section bound
//! to a task, who answers for it now, and what happens to it when the task
//! ends.
//!
//! A section is the card of a task when it names one (`task`, kept in the
//! row's `task_id`, set only by a lead), or when its topic's section does
//! (a sub-topic under a bound card), or implicitly: an ask whose gate names
//! the task, or a section an executor of the task owns. Implicit bindings
//! are read, never written, so older sections keep their stored data; they
//! show a card but never archive a section or grant a write.
//!
//! Who answers for a card is read each time, never stored, as Live
//! References are (refs.rs): the task's newest executor not yet released,
//! else its assignee, else nobody. So a new dispatch of the same task makes
//! its new executor responsible with nothing to update.
use super::{sections::Row, *};
use std::collections::HashMap;

/// A task is over for its cards once it is done, cancelled or archived.
fn ended(status: &str, archived: bool) -> bool {
    archived || matches!(status, "done" | "cancelled")
}

/// The task a reference (YN-90, T-12 or its internal ID) names in
/// `project`: its internal ID, or why a section can't be bound to it.
pub(super) fn bindable(db: &Connection, project: &str, reference: &str) -> Result<Result<String, String>> {
    let Ok((id, _)) = crate::collaboration_store::task_key(db, reference) else {
        return Ok(Err(format!("No task is {reference}. Name a task of this Project by its key, e.g. YN-90 or T-12.")));
    };
    let shown = crate::collaboration_store::task_shown(db, &id);
    let home: Option<String> = db
        .query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&id], |r| r.get(0))
        .optional()?;
    if home.as_deref() != Some(project) {
        return Ok(Err(format!("{shown} is not a task of this Project; a section is bound only to a task of its own Project.")));
    }
    let archived: bool = db.query_row(
        "SELECT json_extract(data,'$.archivedAt') IS NOT NULL FROM collaboration_tasks WHERE id=?1",
        [&id],
        |r| r.get(0),
    )?;
    if archived {
        return Ok(Err(format!("{shown} is archived; bind the section to a task that is not.")));
    }
    Ok(Ok(id))
}

/// The task `row` names itself, else its topic's section names (the live
/// one, else the newest that left): what archives it and what an executor's
/// sub-topic write is checked against. None for a section bound implicitly
/// or not at all.
pub(super) fn explicit(db: &Connection, row: &Row) -> Result<Option<String>> {
    if row.task_id.is_some() {
        return Ok(row.task_id.clone());
    }
    let Some((topic, _)) = row.key.split_once('/') else { return Ok(None) };
    topic_task(db, &row.project_id, topic)
}

fn topic_task(db: &Connection, project: &str, topic: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT task_id FROM project_brief_sections WHERE project_id=?1 AND key=?2 ORDER BY live DESC, seq DESC LIMIT 1",
            params![project, topic],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// The task an executor works on (internal ID), released or not.
fn executor_task(db: &Connection, agent: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT task_id FROM agent_roles WHERE agent_id=?1 AND kind='executor'", [agent], |r| r.get::<_, Option<String>>(0))
        .optional()?
        .flatten())
}

/// The task's newest executor not yet released, if it has one.
pub(super) fn current_executor(db: &Connection, task: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT agent_id FROM agent_roles WHERE kind='executor' AND task_id=?1 AND archived_at IS NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [task],
            |r| r.get(0),
        )
        .optional()?)
}

/// Who answers for a task's card now, as the card shows them.
pub(super) struct Responsible {
    pub agent: String,
    pub name: String,
    /// executor, lead or agent (a standing Agent).
    pub kind: &'static str,
    /// An executor's lifecycle state (executor_lifecycle.rs), else the
    /// Agent's status, or closed.
    pub state: String,
}

impl Responsible {
    pub fn json(&self) -> Value {
        json!({"agentId":self.agent,"name":self.name,"kind":self.kind,"state":self.state})
    }
}

/// The task's newest executor not yet released; else its assignee, when
/// that Agent still exists; else nobody.
pub(super) fn responsible(db: &Connection, task: &str) -> Result<Option<Responsible>> {
    let agent = match current_executor(db, task)? {
        Some(agent) => Some(agent),
        None => db
            .query_row("SELECT json_extract(data,'$.assigneeAgentId') FROM collaboration_tasks WHERE id=?1", [task], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten(),
    };
    let Some(agent) = agent else { return Ok(None) };
    let listed: Option<(Option<String>, bool, Option<String>)> = db
        .query_row(
            "SELECT json_extract(data,'$.agent.name'),json_extract(data,'$.agent.closedAt') IS NOT NULL,json_extract(data,'$.agent.status')
             FROM agents WHERE id=?1",
            [&agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((name, closed, status)) = listed else { return Ok(None) };
    let kind = match crate::agent_roles::kind(db, &agent)? {
        crate::agent_roles::EXECUTOR => "executor",
        crate::agent_roles::LEAD => "lead",
        _ => "agent",
    };
    let state = match crate::executor_lifecycle::of(db, &agent)? {
        Some((lifecycle, _, _)) => lifecycle["state"].as_str().unwrap_or("closed").to_owned(),
        None if closed => "closed".to_owned(),
        None => status.unwrap_or_else(|| "offline".into()),
    };
    Ok(Some(Responsible { agent, name: name.unwrap_or_default(), kind, state }))
}

/// Whether `agent` may write the report or status sub-topic `key` under
/// the exception for a card's responsible executor: `key`'s topic has a
/// live section bound to a task by its own `task`, and `agent` is that
/// task's current executor (its newest one not yet released). Never through
/// an implicit binding, so no executor opens itself a topic to write in.
pub(super) fn may_write_sub(db: &Connection, project: &str, key: &str, agent: &str) -> Result<bool> {
    let Some((topic, _)) = key.split_once('/') else { return Ok(false) };
    let task: Option<String> = db
        .query_row(
            "SELECT task_id FROM project_brief_sections WHERE project_id=?1 AND key=?2 AND live=1",
            params![project, topic],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let Some(task) = task else { return Ok(false) };
    Ok(current_executor(db, &task)?.as_deref() == Some(agent))
}

/// A sub-topic an executor of its card's task wrote there (Home shows it
/// with its card, not among the team's sections): `row`'s topic is bound
/// to a task by its own `task`, and `row`'s owner is an executor of it.
pub(super) fn on_card(db: &Connection, row: &Row) -> Result<bool> {
    let Some((topic, _)) = row.key.split_once('/') else { return Ok(false) };
    let Some(task) = topic_task(db, &row.project_id, topic)? else { return Ok(false) };
    Ok(executor_task(db, &row.owner_id)?.as_deref() == Some(task.as_str()))
}

/// The cards of one read: each task's card read once, through the caller's
/// connection.
pub(super) struct Cards<'a> {
    db: &'a Connection,
    tasks: HashMap<String, Option<Value>>,
}

impl<'a> Cards<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db, tasks: HashMap::new() }
    }

    /// The task `row` is the card of, explicitly or implicitly.
    pub fn binding(&self, row: &Row) -> Result<Option<String>> {
        if let Some(task) = explicit(self.db, row)? {
            return Ok(Some(task));
        }
        let gate = row.data["ask"]["gate"]["taskId"].as_str().filter(|_| row.kind == "ask");
        if let Some(gate) = gate {
            if let Ok((task, _)) = crate::collaboration_store::task_key(self.db, gate.trim()) {
                return Ok(Some(task));
            }
        }
        executor_task(self.db, &row.owner_id)
    }

    /// `card` of web/src/home/types.ts: {task: {id, title, shortName,
    /// status, archived}, responsible: {agentId, name, kind, state} | null}.
    /// None for a section that is no task's card, whose JSON stays as it was.
    pub fn of(&mut self, row: &Row) -> Result<Option<Value>> {
        let Some(task) = self.binding(row)? else { return Ok(None) };
        if let Some(card) = self.tasks.get(&task) {
            return Ok(card.clone());
        }
        let card = self.read(&task)?;
        self.tasks.insert(task, card.clone());
        Ok(card)
    }

    fn read(&self, task: &str) -> Result<Option<Value>> {
        let raw: Option<String> =
            self.db.query_row("SELECT data FROM collaboration_tasks WHERE id=?1", [task], |r| r.get(0)).optional()?;
        let Some(raw) = raw else { return Ok(None) };
        let data: Value = serde_json::from_str(&raw)?;
        let key = crate::collaboration_store::task_shown(self.db, task);
        let responsible = responsible(self.db, task)?.map(|who| who.json());
        Ok(Some(json!({
            "task":{"id":key,"title":data["title"],"shortName":data["shortName"],"status":data["status"],
                "archived":!data["archivedAt"].is_null()},
            "responsible":responsible,
        })))
    }
}

/// A section's JSON gains `card` only when it is a task's card.
pub(super) fn show(section: &mut Value, card: Option<Value>) {
    if let Some(card) = card {
        section["card"] = card;
    }
}

/// Whether the task (internal ID) is over for its cards.
pub(super) fn task_ended(db: &Connection, task: &str) -> Result<bool> {
    let row: Option<(Option<String>, bool)> = db
        .query_row(
            "SELECT json_extract(data,'$.status'),json_extract(data,'$.archivedAt') IS NOT NULL FROM collaboration_tasks WHERE id=?1",
            [task],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row.is_some_and(|(status, archived)| ended(status.as_deref().unwrap_or_default(), archived)))
}

/// Puts `row` into history as archived: its task ended (YN-86 S2a).
pub(super) fn archive(db: &Connection, row: &Row, at: &str) -> Result<()> {
    db.execute(
        "UPDATE project_brief_sections SET live=0,history_reason='archived',history_at=?2 WHERE seq=?1 AND live=1",
        params![row.seq, at],
    )?;
    sections::record_ending(db, row, row.version, "archived", at)
}

/// In the transaction that ends the task `task` (internal ID): done,
/// cancelled or archived (collaboration_store.rs `save_task`). Every live
/// section bound to it by its own `task` or its topic's leaves the live
/// Brief as archived, except a report the user has not read in its current
/// version, which stays until they open it (`mark_opened`) or mark it seen,
/// and an unresolved ask, which leaves only when its owner resolves it.
/// Implicit bindings archive nothing. No section, version, Seen or opened
/// mark changes, nor the Brief's version, as with a Seen mark; a release
/// later hands what stays to the executor's dispatcher (`hand_over`).
pub(crate) fn task_closed(db: &Connection, task: &str) -> Result<()> {
    let rows = sections::bound_to(db, task)?;
    let at = now();
    let mut marks: HashMap<String, (HashMap<String, (i64, String)>, HashMap<i64, (i64, String)>)> = HashMap::new();
    for row in &rows {
        let keep = match row.kind.as_str() {
            "ask" => row.unresolved_ask(),
            "report" => {
                if !marks.contains_key(&row.project_id) {
                    let read = (sections::seen(db, &row.project_id)?, sections::opened(db, &row.project_id)?);
                    marks.insert(row.project_id.clone(), read);
                }
                let (seen, opened) = &marks[&row.project_id];
                sections::read_version(row, seen, opened).is_none_or(|version| version < row.version)
            }
            _ => false,
        };
        if !keep {
            archive(db, row, &at)?;
        }
    }
    Ok(())
}
