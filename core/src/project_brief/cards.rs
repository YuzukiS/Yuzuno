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

/// The task's assignee (`assigneeAgentId`), if it has one.
fn assignee(db: &Connection, task: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT json_extract(data,'$.assigneeAgentId') FROM collaboration_tasks WHERE id=?1", [task], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten())
}

/// How the one who answers for a task writes its card (YN-212 C1; C3 R1).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Writer {
    /// Its newest executor not yet released (C1): the card, wherever a lead
    /// bound it to the task, and its own binding at the task's key.
    Executor,
    /// While it has no such executor, its assignee when that is no executor,
    /// such as an Agent a card route or a reassignment gave the task to
    /// (C3 R1): only the status or report at the task's key, bound to it.
    Assignee,
}

/// How `agent` writes `task`'s card, if it does. An executor released from
/// the task writes it no more, though it may still be its assignee.
fn writer(db: &Connection, task: &str, agent: &str) -> Result<Option<Writer>> {
    if let Some(executor) = current_executor(db, task)? {
        return Ok((executor == agent).then_some(Writer::Executor));
    }
    let assigned = assignee(db, task)?.as_deref() == Some(agent) && crate::agent_roles::kind(db, agent)? != crate::agent_roles::EXECUTOR;
    Ok(assigned.then_some(Writer::Assignee))
}

/// The task's newest executor not yet released; else its assignee, when
/// that Agent still exists; else nobody.
pub(super) fn responsible(db: &Connection, task: &str) -> Result<Option<Responsible>> {
    let agent = match current_executor(db, task)? {
        Some(agent) => Some(agent),
        None => assignee(db, task)?,
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

/// A task's card itself (YN-212 C1): a topic's own section, not a sub-topic,
/// bound to a task by its own `task`, as a status (while the task goes on)
/// or a report (once it ends). Its Project's leads and the one who answers
/// for its task (`writer`) write it, not only its owner (update.rs
/// rules); an Ask, or a section bound only implicitly, stays its owner's.
pub(super) fn task_card(row: &Row) -> bool {
    row.task_id.is_some() && !row.key.contains('/') && matches!(row.kind.as_str(), "status" | "report")
}

/// A topic's own section bound to a task by its own `task` (YN-212 C1):
/// Home shows it with the lead's sections, whoever wrote it.
pub(super) fn bound_topic(row: &Row) -> bool {
    row.task_id.is_some() && !row.key.contains('/')
}

/// The key a task's card has: its task's key in lower case (yn-90), as
/// project_route names the card it records (project_requests/routes.rs).
pub(crate) fn card_key(db: &Connection, task: &str) -> String {
    crate::collaboration_store::task_shown(db, task).to_lowercase()
}

/// Whether `agent` writes `row` as the one who answers for its task (YN-212
/// C1): `row` is a task's card (`task_card`), and `agent` that task's
/// current executor, or its assignee (`writer`) when `row` is at the task's
/// own key. Another section a lead bound to the task stays the leads'.
pub(super) fn may_write_card(db: &Connection, row: &Row, agent: &str) -> Result<bool> {
    let Some(task) = row.task_id.as_deref().filter(|_| task_card(row)) else { return Ok(false) };
    Ok(match writer(db, task, agent)? {
        Some(Writer::Executor) => true,
        Some(Writer::Assignee) => row.key == card_key(db, task),
        None => false,
    })
}

/// The task the own `task` of the one who answers for it binds (YN-212 C1),
/// by internal ID: `reference` names a task of `project` that is not
/// archived, `agent` writes its card (`writer`: its current executor, else
/// its assignee that is no executor), `key` is its card's key (`card_key`),
/// and the live section under `key`, if there is one, is already bound to
/// it. An assignee binds only a status or a report (`kind`, the section's
/// kind once written), never an Ask. So it puts its task's card at its key
/// and keeps it bound, and binds nothing else. None when any of that is not so.
pub(super) fn own_card_binding(db: &Connection, project: &str, key: &str, reference: &str, agent: &str, kind: &str, live: Option<&Row>)
    -> Result<Option<String>> {
    let Ok(task) = bindable(db, project, reference)? else { return Ok(None) };
    let Some(writer) = writer(db, &task, agent)? else { return Ok(None) };
    if card_key(db, &task) != key || (writer == Writer::Assignee && !matches!(kind, "status" | "report")) {
        return Ok(None);
    }
    if live.is_some_and(|row| row.task_id.as_deref() != Some(task.as_str())) {
        return Ok(None);
    }
    Ok(Some(task))
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
    /// status, archived}, responsible: {agentId, name, kind, state} | null,
    /// handoffs?}: `handoffs` once a request was routed to it (YN-86 S3a-2,
    /// project_requests::handoffs). None for a section that is no task's
    /// card, whose JSON stays as it was.
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
        let mut card = json!({
            "task":{"id":key,"title":data["title"],"shortName":data["shortName"],"status":data["status"],
                "archived":!data["archivedAt"].is_null()},
            "responsible":responsible,
        });
        if let Some(handoffs) = crate::project_requests::handoffs(self.db, task)? {
            card["handoffs"] = handoffs;
        }
        Ok(Some(card))
    }
}

/// A section's JSON gains `card` only when it is a task's card.
pub(super) fn show(section: &mut Value, card: Option<Value>) {
    if let Some(card) = card {
        section["card"] = card;
    }
}

/// Whether the task (internal ID) is over for its cards.
pub(crate) fn task_ended(db: &Connection, task: &str) -> Result<bool> {
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
/// Brief as archived, a report the user has not read yet too (YN-195: Home
/// shows it in Done for its 30 days, no longer counted as new), but an
/// unresolved ask, which leaves only when its owner resolves it. A report
/// an older Core kept live unread still leaves when it is opened
/// (`mark_opened`). Implicit bindings archive nothing. No section, version,
/// Seen or opened mark changes, nor the Brief's version, as with a Seen
/// mark; a release later hands what stays to the executor's dispatcher
/// (`hand_over`).
pub(crate) fn task_closed(db: &Connection, task: &str) -> Result<()> {
    let rows = sections::bound_to(db, task)?;
    let at = now();
    for row in rows.iter().filter(|row| !row.unresolved_ask()) {
        archive(db, row, &at)?;
    }
    Ok(())
}

/// In the transaction that saves the user's choice of `project`'s leads
/// without `agent` (agent_roles.rs `save`): its live reports and statuses
/// there leave the live Brief with reason lead-left (YN-195), into the 30
/// days of history. Still a member, it could neither keep them up to date
/// nor be claimed from, and no lead could remove them. Its Asks stay until
/// it resolves them or they are answered, and so does a card of a task
/// still open, by its own `task` or its topic's: the task's executor writes
/// under it, and it leaves with its task (`task_closed`, review c6e802f3).
/// An Agent that moves to another Project leaves its sections to be
/// claimed, as before. No version changes, nor the Brief's, as with a card
/// archived with its task.
pub(crate) fn lead_left(db: &Connection, agent: &str, project: &str) -> Result<()> {
    let at = now();
    for row in sections::live(db, project)?.iter().filter(|row| row.owner_id == agent && row.kind != "ask") {
        if let Some(task) = explicit(db, row)? {
            if !task_ended(db, &task)? {
                continue;
            }
        }
        db.execute(
            "UPDATE project_brief_sections SET live=0,history_reason='lead-left',history_at=?2 WHERE seq=?1 AND live=1",
            params![row.seq, at],
        )?;
        sections::record_ending(db, row, row.version, "lead-left", &at)?;
    }
    Ok(())
}

/// A section as a request's card (YN-86 §4.5): its identity on Home, key,
/// title, whether it is live, and the task it is the card of (internal ID,
/// read as `Cards::binding` reads it).
pub(crate) struct Card {
    pub identity: i64,
    pub key: String,
    pub title: String,
    pub live: bool,
    pub task: Option<String>,
}

fn card(db: &Connection, row: &Row) -> Result<Card> {
    Ok(Card {
        identity: row.identity,
        key: row.key.clone(),
        title: row.data["title"].as_str().unwrap_or_default().to_owned(),
        live: row.live,
        task: Cards::new(db).binding(row)?,
    })
}

/// The live section `key` of `project`, as a card.
pub(crate) fn live_card(db: &Connection, project: &str, key: &str) -> Result<Option<Card>> {
    sections::live_key(db, project, key)?.map(|row| card(db, &row)).transpose()
}

/// The section with this identity on Home (`Row::identity`): the live one,
/// else its newest entry history still keeps.
pub(crate) fn card_by_identity(db: &Connection, project: &str, identity: i64) -> Result<Option<Card>> {
    sections::by_identity(db, project, identity)?.map(|row| card(db, &row)).transpose()
}

/// The tasks (internal IDs) the live sections of `project` are the cards of, as Home binds them (`Cards::binding`):
/// a request routed to one of them keeps its place on the Project's first page whatever its number
/// (project_requests.rs `kept`, YN-237), so Home draws that card in its request's block.
pub(crate) fn live_card_tasks(db: &Connection, project: &str) -> Result<std::collections::HashSet<String>> {
    let cards = Cards::new(db);
    let mut tasks = std::collections::HashSet::new();
    for row in sections::live(db, project)? {
        if let Some(task) = cards.binding(&row)? {
            tasks.insert(task);
        }
    }
    Ok(tasks)
}

/// Who answers for the task's card now (`responsible`), as a card shows them.
pub(crate) fn responsible_json(db: &Connection, task: &str) -> Result<Option<Value>> {
    Ok(responsible(db, task)?.map(|who| who.json()))
}

/// The Agent who answers for the task's card now (`responsible`).
pub(crate) fn responsible_agent(db: &Connection, task: &str) -> Result<Option<String>> {
    Ok(responsible(db, task)?.map(|who| who.agent))
}

/// The Asks of the task's cards in `project`, each once by its identity on
/// Home: live, and those history keeps. Each says its section, title, state
/// (open, replied or resolved) and since when it asks.
pub(crate) fn asks_of(db: &Connection, project: &str, task: &str) -> Result<Vec<Value>> {
    let cards = Cards::new(db);
    let mut seen = std::collections::HashSet::new();
    let mut asks = vec![];
    for row in sections::live(db, project)?.into_iter().chain(sections::history(db, project)?) {
        if row.kind != "ask" || !seen.insert(row.identity) || cards.binding(&row)?.as_deref() != Some(task) {
            continue;
        }
        let state = if row.live { row.ask_state.clone().unwrap_or_else(|| "open".into()) } else { "resolved".into() };
        asks.push(json!({"sectionId":row.identity,"key":row.key,"title":row.data["title"],"state":state,
            "at":row.ask_since.clone().unwrap_or_else(|| row.updated_at.clone())}));
    }
    Ok(asks)
}

/// The card of task `task` (internal ID) at `key` in `project`, as a request
/// finds it when its route recorded no section (YN-212 C3): the section under
/// `key` bound to that task by its own `task`, the live one, else its newest
/// entry history still keeps, as `card_by_identity` finds one.
pub(crate) fn bound_card(db: &Connection, project: &str, key: &str, task: &str) -> Result<Option<Card>> {
    sections::bound_key(db, project, key, task)?.map(|row| card(db, &row)).transpose()
}

/// Whether `key` of `project` has ever held a section: live, kept in history,
/// or ended (removed, resolved, seen or archived, whose ending outlives its
/// history). A request joins a task whose first card is still to be written
/// only where its key has held none (YN-212 C3).
pub(crate) fn key_used(db: &Connection, project: &str, key: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_brief_sections WHERE project_id=?1 AND key=?2)
         OR EXISTS(SELECT 1 FROM project_brief_endings WHERE project_id=?1 AND key=?2)",
        params![project, key],
        |r| r.get(0),
    )?)
}

/// Whether `row` is a route's placeholder card (YN-212 C3), from before a
/// task's card was its executor's to write: the section a card route
/// recorded, still owned by the front desk that routed it, still as that
/// route put it: a BriefBody of a Markdown lead "→ …" and Live References
/// naming its task alone. Once anyone writes it, it is that task's card.
pub(super) fn placeholder(db: &Connection, row: &Row) -> Result<bool> {
    let Some(task) = row.task_id.as_deref().filter(|_| task_card(row) && row.kind == "status") else { return Ok(false) };
    let routed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_routes WHERE project_id=?1 AND kind='card' AND section_id=?2 AND by_agent_id=?3)",
        params![row.project_id, row.identity, row.owner_id],
        |r| r.get(0),
    )?;
    if !routed {
        return Ok(false);
    }
    let shown = crate::collaboration_store::task_shown(db, task);
    // A history index's row has no body (YN-221 S1): this one's is read.
    let loaded;
    let body = match row.data.get("body") {
        Some(body) => body,
        None => {
            loaded = super::sections::body_of(db, row.seq)?;
            &loaded
        }
    };
    let elements = &body["elements"];
    let root = &elements[body["root"].as_str().unwrap_or_default()];
    let children: Vec<&Value> = root["children"].as_array().into_iter().flatten().map(|id| &elements[id.as_str().unwrap_or_default()]).collect();
    let lead = children.iter().any(|block| block["type"] == "Markdown" && block["props"]["text"].as_str().is_some_and(|text| text.starts_with("→ ")));
    let refs = children.iter().any(|block| {
        block["type"] == "LiveRefs" && block["props"]["items"] == json!([{"kind":"task","id":shown}])
    });
    Ok(root["type"] == "BriefBody" && children.len() == 2 && lead && refs)
}

/// A section's JSON says it is a route's placeholder (`placeholder`), on its
/// `card`, so Home shows it as no card (YN-212 C3).
pub(super) fn mark_placeholder(db: &Connection, row: &Row, section: &mut Value) -> Result<()> {
    if section["card"].is_object() && placeholder(db, row)? {
        section["card"]["placeholder"] = json!(true);
    }
    Ok(())
}
