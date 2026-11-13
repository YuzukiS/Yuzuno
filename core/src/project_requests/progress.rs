//! What routing made of a request (YN-86 §4.3, §4.5; slice S3a-2), read each
//! time from its routes and its cards' tasks, never stored: the cards it
//! went to and who answers for each now, its progress (how many of their
//! tasks ended), Core's lines for the conversation, and on each card where
//! it came from (`card.handoffs`). None of it carries the user's words:
//! they stay on the request, shown only in the conversation.
use super::routes::{self, RouteRow};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// A route that put the request on a card: a new card, or one it joined.
fn to_card(row: &RouteRow) -> bool {
    row.state == routes::DONE && matches!(row.kind.as_str(), routes::CARD | routes::EXISTING)
}

/// The tasks (internal IDs) of the cards `request` was routed to, each once,
/// in the order of its routes.
pub(super) fn routed_tasks(db: &Connection, request: &str) -> Result<Vec<String>> {
    Ok(tasks(&routes::of_request(db, request)?))
}

fn tasks(rows: &[RouteRow]) -> Vec<String> {
    let mut tasks: Vec<String> = Vec::new();
    for task in rows.iter().filter(|row| to_card(row)).filter_map(|row| row.task_id.clone()) {
        if !tasks.contains(&task) {
            tasks.push(task);
        }
    }
    tasks
}

/// A task as a request's card shows it: its key, status, and whether it
/// ended (done, cancelled or archived, as cards.rs ends a card).
struct Task {
    key: String,
    status: String,
    archived_at: Option<String>,
}

impl Task {
    fn ended(&self) -> bool {
        self.archived_at.is_some() || matches!(self.status.as_str(), "done" | "cancelled")
    }
}

fn task(db: &Connection, id: &str) -> Result<Option<Task>> {
    let row: Option<(Option<String>, Option<String>)> = db
        .query_row(
            "SELECT json_extract(data,'$.status'),json_extract(data,'$.archivedAt') FROM collaboration_tasks WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(status, archived_at)| Task {
        key: crate::collaboration_store::task_shown(db, id),
        status: status.unwrap_or_default(),
        archived_at,
    }))
}

/// When the task ended: its newest write that set it done or cancelled,
/// else (archived while open) when it was archived.
fn ended_at(db: &Connection, id: &str, task: &Task) -> Result<Option<String>> {
    if matches!(task.status.as_str(), "done" | "cancelled") {
        let at: Option<String> = db
            .query_row(
                "SELECT json_extract(data,'$.at') FROM collaboration_task_activity
                 WHERE task_id=?1 AND json_extract(data,'$.changes.status') IN ('done','cancelled') ORDER BY seq DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        if at.is_some() {
            return Ok(at);
        }
    }
    Ok(task.archived_at.clone())
}

/// The lowest request number routed to the task's card: the request whose
/// conversation shows Core's lines about it, so each shows once.
fn first_request(db: &Connection, task: &str) -> Result<Option<i64>> {
    Ok(db
        .query_row(
            &format!(
                "SELECT MIN(q.n) FROM project_routes r JOIN project_requests q ON q.id=r.request_id
                 WHERE r.task_id=?1 AND r.state='{}' AND r.kind IN ('{}','{}')",
                routes::DONE,
                routes::CARD,
                routes::EXISTING
            ),
            [task],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
}

/// What `view` (project_requests.rs) adds to a request once the front desk
/// has seen it (YN-86 §4.5):
/// - `notes`: the front desk's short replies, oldest first;
/// - `routes`: its routes and the user's reassignments of its cards, by time;
/// - `cards`: one per task it went to, as Home shows the card and who
///   answers for it now; `progress`: how many of their tasks ended;
/// - `state`: waiting (no card yet), doing, or done (every card's task ended);
/// - `lines`: Core's lines in the conversation, one per fact: each Ask on
///   one of its cards (`ask`, with its state), and each card's task that
///   ended (`done`). A card several requests went to has its lines on the
///   first of them only.
pub(super) fn show(db: &Connection, project: &str, request: &str, n: i64, shown: &mut Value) -> Result<()> {
    shown["notes"] = json!(notes(db, request)?);
    let rows = routes::of_request(db, request)?;
    let tasks = tasks(&rows);
    let mut events: Vec<(String, Value)> = Vec::new();
    for row in &rows {
        events.push((row.at.clone(), routes::json(db, row)?));
    }
    for id in &tasks {
        for row in routes::reassignments(db, id)? {
            events.push((row.at.clone(), routes::json(db, &row)?));
        }
    }
    events.sort_by(|a, b| a.0.cmp(&b.0));
    shown["routes"] = json!(events.into_iter().map(|(_, event)| event).collect::<Vec<_>>());
    let (mut cards, mut lines, mut ended) = (vec![], vec![], 0);
    for id in &tasks {
        let Some(task) = task(db, id)? else { continue };
        if task.ended() {
            ended += 1;
        }
        // The card: where its newest route to it put it.
        let section = rows.iter().rev().find(|row| to_card(row) && row.task_id.as_deref() == Some(id.as_str())).and_then(|row| row.section_id);
        let card = match section {
            Some(identity) => crate::project_brief::card_by_identity(db, project, identity)?,
            None => None,
        };
        cards.push(json!({
            "sectionId":section,"key":card.as_ref().map(|c| c.key.clone()),"title":card.as_ref().map(|c| c.title.clone()),
            "live":card.as_ref().is_some_and(|c| c.live),
            "task":{"id":task.key,"status":task.status,"archived":task.archived_at.is_some()},
            "responsible":crate::project_brief::responsible_json(db, id)?,
        }));
        if first_request(db, id)? != Some(n) {
            continue;
        }
        for mut ask in crate::project_brief::asks_of(db, project, id)? {
            ask["kind"] = json!("ask");
            ask["task"] = json!(task.key);
            ask["cardSectionId"] = json!(section);
            lines.push(ask);
        }
        if task.ended() {
            let status = if matches!(task.status.as_str(), "done" | "cancelled") { task.status.as_str() } else { "archived" };
            lines.push(json!({"kind":"done","task":task.key,"status":status,"at":ended_at(db, id, &task)?,"cardSectionId":section,
                "title":card.as_ref().map(|c| c.title.clone())}));
        }
    }
    lines.sort_by(|a, b| a["at"].as_str().unwrap_or_default().cmp(b["at"].as_str().unwrap_or_default()));
    let count = cards.len();
    shown["state"] = json!(match (count, ended) {
        (0, _) => "waiting",
        (count, ended) if ended == count => "done",
        _ => "doing",
    });
    shown["progress"] = json!({"cards":count,"ended":ended});
    shown["cards"] = json!(cards);
    shown["lines"] = json!(lines);
    Ok(())
}

fn notes(db: &Connection, request: &str) -> Result<Vec<Value>> {
    let rows = db
        .prepare_cached("SELECT note,by_agent_id,at FROM project_request_notes WHERE request_id=?1 ORDER BY n")?
        .query_map([request], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(note, by, at)| Ok(json!({"note":note,"by":routes::agent(db, &by)?,"at":at})))
        .collect()
}

/// `card.handoffs` (YN-86 §4.3, §4.5) of the task's card: the requests
/// routed to it (`merged`: joined to it by an existing route), each once by
/// number, and what happened to it, oldest first: its routes and the user's
/// reassignments. None when no route came to it. Never the user's words:
/// `messageId` is the request's own, for the page to find them.
pub(crate) fn handoffs(db: &Connection, task: &str) -> Result<Option<Value>> {
    let rows = routes::of_task(db, task)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut requests: Vec<Value> = Vec::new();
    let mut events = Vec::new();
    for row in &rows {
        events.push(routes::json(db, row)?);
        let Some(request) = row.request_id.as_deref().filter(|_| to_card(row)) else { continue };
        let found: Option<(i64, Option<String>, String, String)> = db
            .query_row(
                "SELECT n,title,created_at,message_id FROM project_requests WHERE id=?1",
                params![request],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((n, title, at, message)) = found else { continue };
        if requests.iter().any(|shown| shown["n"] == n) {
            continue;
        }
        requests.push(json!({"n":n,"title":title,"at":at,"merged":row.kind == routes::EXISTING,"messageId":message}));
    }
    Ok(Some(json!({"requests":requests,"events":events})))
}
