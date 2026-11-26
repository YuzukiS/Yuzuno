//! What routing made of a request (YN-86 §4.3, §4.5; slice S3a-2), read each
//! time from its routes and its cards' tasks, never stored: the cards it
//! went to and who answers for each now, its progress (how many of their
//! tasks ended), its state (done only once the user confirmed it, YN-184),
//! Core's lines for the conversation, and on each card where it came from
//! (`card.handoffs`). None of it carries the user's words: they stay on the
//! request, shown only in the conversation.
use super::routes::{self, RouteRow};
use crate::github::installed::{self, Installed};
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

/// A task as a request's card shows it: its key, status, whether it ended
/// (done, cancelled or archived, as cards.rs ends a card), its newest
/// result, if any (YN-208): which, its status then and when, and the
/// progress and blocker its lead or executor wrote (R-38), "" when unset.
struct Task {
    key: String,
    status: String,
    archived_at: Option<String>,
    result: Option<Value>,
    progress: String,
    blocker: String,
}

/// At most this many characters of a task's progress or blocker on a request's card (R-38 §4): the card shows its
/// first sentence; the whole stays on the task.
pub(super) const TASK_TEXT_CHARS: usize = 280;

/// `text` as a request's card shows it: trimmed, at most TASK_TEXT_CHARS characters, a longer one ending in "…";
/// null when there is none.
fn clipped(text: &str) -> Value {
    let text = text.trim();
    if text.is_empty() {
        return Value::Null;
    }
    if text.chars().count() <= TASK_TEXT_CHARS {
        return json!(text);
    }
    json!(text.chars().take(TASK_TEXT_CHARS - 1).collect::<String>() + "…")
}

impl Task {
    fn ended(&self) -> bool {
        self.archived_at.is_some() || matches!(self.status.as_str(), "done" | "cancelled")
    }
}

fn task(db: &Connection, id: &str) -> Result<Option<Task>> {
    type Row = (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);
    let row: Option<Row> = db
        .query_row(
            "SELECT json_extract(data,'$.status'),json_extract(data,'$.archivedAt'),
             CASE WHEN json_type(data,'$.result')='object' THEN json_object('id',json_extract(data,'$.result.id'),
             'status',json_extract(data,'$.result.status'),'reportedAt',json_extract(data,'$.result.reportedAt')) END,
             json_extract(data,'$.progress'),json_extract(data,'$.blocker')
             FROM collaboration_tasks WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    row.map(|(status, archived_at, result, progress, blocker)| -> Result<Task> {
        Ok(Task {
            key: crate::collaboration_store::task_shown(db, id),
            status: status.unwrap_or_default(),
            archived_at,
            result: result.map(|raw| serde_json::from_str(&raw)).transpose()?,
            progress: progress.unwrap_or_default(),
            blocker: blocker.unwrap_or_default(),
        })
    })
    .transpose()
}

/// When the task ended: its newest write that set it done or cancelled,
/// else (archived while open) when it was archived.
/// When the task's progress was last written (R-38 §2.5): the newest of its updates that set `progress`, as its
/// activity record keeps it. None without a progress, and none when no update set it (unknown, never guessed).
fn progress_at(db: &Connection, id: &str, task: &Task) -> Result<Option<String>> {
    if task.progress.trim().is_empty() {
        return Ok(None);
    }
    Ok(db
        .query_row(
            "SELECT json_extract(data,'$.at') FROM collaboration_task_activity WHERE task_id=?1
             AND json_extract(data,'$.kind')='updated' AND json_type(data,'$.changes.progress') IS NOT NULL ORDER BY seq DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
}

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

/// The `workspace_meta` key of when this Workspace's Core first asked the
/// user to confirm requests (YN-184; project_requests.rs `migrate`).
pub(super) const CONFIRM_FROM: &str = "requests.confirmFrom";

/// What `view` (project_requests.rs) adds to a request once the front desk
/// has seen it (YN-86 §4.5):
/// - `notes`: the front desk's short replies, oldest first, each with the
///   follow-ups it answers (`replyTo`, R-45) or null;
/// - `routes`: its routes and the user's reassignments of its cards, by time;
/// - `cards`: one per task it went to, as Home shows the card and who
///   answers for it now, with its task's newest result (`result`) and what
///   its results named as delivered (`deliverables`, YN-208), each as it
///   stands now; its task's own progress and blocker, clipped (R-38), and the
///   pull requests it links (`prs`), each with whether its merge commit is in
///   `installed` as kept (github/installed.rs); `progress`: how many of
///   their tasks ended;
/// - `state`: waiting (no card yet), doing, ended (every card's task ended,
///   YN-184), answered (no card, the front desk answered it with an answer
///   route, and no follow-up came after its newest note; YN-136), or done:
///   ended or answered, and confirmed (`confirmed_since`) no earlier than its
///   newest change: a note, a follow-up, a route, a card's task that ended;
/// - `confirmedAt`: the user's newest confirmation, or null;
/// - `lines`: Core's lines in the conversation, one per fact: each Ask on
///   one of its cards (`ask`, with its state), and each card's task that
///   ended (`done`). A card several requests went to has its lines on the
///   first of them only.
pub(super) fn show(db: &Connection, project: &str, request: &str, n: i64, confirmed: Option<&str>, installed: Option<&Installed>,
    shown: &mut Value) -> Result<()> {
    let notes = notes(db, request)?;
    // The request's newest change: a note, a follow-up, a route, a card's task that ended.
    let mut changed: Option<String> = None;
    let mut change = |at: Option<String>| {
        if at.as_deref() > changed.as_deref() {
            changed = at;
        }
    };
    for note in &notes {
        change(note["at"].as_str().map(str::to_owned));
    }
    change(db.query_row("SELECT MAX(at) FROM project_request_replies WHERE request_id=?1", [request], |r| r.get(0))?);
    shown["notes"] = json!(notes);
    let rows = routes::of_request(db, request)?;
    let tasks = tasks(&rows);
    let mut events: Vec<(String, Value)> = Vec::new();
    for row in &rows {
        events.push((row.at.clone(), routes::json(db, row)?));
        if row.state == routes::DONE {
            change(Some(row.at.clone()));
        }
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
        let end = if task.ended() { ended_at(db, id, &task)? } else { None };
        if task.ended() {
            ended += 1;
            change(end.clone());
        }
        // The card: where its newest route to it put it; for a route that put
        // none (YN-212 C3), the section the task's card key holds, bound to
        // the task: none until its first card is written.
        let route = rows.iter().rev().find(|row| to_card(row) && row.task_id.as_deref() == Some(id.as_str()));
        let card = match (route.and_then(|row| row.section_id), route.and_then(|row| row.card_key.as_deref())) {
            (Some(identity), _) => crate::project_brief::card_by_identity(db, project, identity)?,
            (None, Some(key)) => crate::project_brief::bound_card(db, project, key, id)?,
            (None, None) => None,
        };
        let section = route.and_then(|row| row.section_id).or(card.as_ref().map(|c| c.identity));
        cards.push(json!({
            "sectionId":section,"key":card.as_ref().map(|c| c.key.clone()),"title":card.as_ref().map(|c| c.title.clone()),
            "live":card.as_ref().is_some_and(|c| c.live),
            "task":{"id":task.key,"status":task.status,"archived":task.archived_at.is_some(),
                "progress":clipped(&task.progress),"progressAt":progress_at(db, id, &task)?,"blocker":clipped(&task.blocker)},
            "responsible":crate::project_brief::responsible_json(db, id)?,
            // Done, readable and confirmed are three facts (YN-208): the task's
            // status above, its result and deliverables here, the request's
            // confirmedAt below; none is read from another.
            "result":task.result,
            "deliverables":crate::collaboration_store::deliverables::shown(db, project, id)?,
            "prs":{"items":installed::task_pulls(db, id, installed)?},
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
            lines.push(json!({"kind":"done","task":task.key,"status":status,"at":end,"cardSectionId":section,
                "title":card.as_ref().map(|c| c.title.clone())}));
        }
    }
    lines.sort_by(|a, b| a["at"].as_str().unwrap_or_default().cmp(b["at"].as_str().unwrap_or_default()));
    let count = cards.len();
    let state = match (count, ended) {
        (0, _) if answered(db, request, &rows)? => "answered",
        (0, _) => "waiting",
        (count, ended) if ended == count => "ended",
        _ => "doing",
    };
    let confirmed_since = confirmed_since(db, confirmed)?;
    let done = matches!(state, "ended" | "answered") && confirmed_since.is_some() && confirmed_since >= changed;
    shown["state"] = json!(if done { "done" } else { state });
    shown["confirmedAt"] = json!(confirmed);
    shown["progress"] = json!({"cards":count,"ended":ended});
    shown["cards"] = json!(cards);
    shown["lines"] = json!(lines);
    Ok(())
}

/// Since when a settled request counts as confirmed (YN-184): the user's
/// confirmation, or, for one settled before this Core first asked for
/// confirmations, that time (`CONFIRM_FROM`), whichever is later. All are
/// model::now()'s, compared as text as `lines` are.
fn confirmed_since(db: &Connection, confirmed: Option<&str>) -> Result<Option<String>> {
    let from: Option<String> = db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [CONFIRM_FROM], |r| r.get(0)).optional()?;
    Ok(from.into_iter().chain(confirmed.map(str::to_owned)).max())
}

/// A request with no card is answered (YN-136) when the front desk answered
/// it with an answer route and the user said nothing more after its newest
/// note: a follow-up reopens it for the front desk, and the front desk's next
/// note (a new answer, an identical one being no new note) settles it again.
/// Both times are model::now()'s, compared as text as `lines` are.
fn answered(db: &Connection, request: &str, rows: &[RouteRow]) -> Result<bool> {
    if !rows.iter().any(|row| row.kind == routes::ANSWER && row.state == routes::DONE) {
        return Ok(false);
    }
    let note: Option<String> = db.query_row("SELECT MAX(at) FROM project_request_notes WHERE request_id=?1", [request], |r| r.get(0))?;
    let reply: Option<String> = db.query_row("SELECT MAX(at) FROM project_request_replies WHERE request_id=?1", [request], |r| r.get(0))?;
    Ok(match (note, reply) {
        (Some(note), Some(reply)) => note > reply,
        (Some(_), None) => true,
        (None, _) => false,
    })
}

/// The front desk's notes, oldest first: each by its number, with the
/// follow-ups it answers (`replyTo`, R-45) by theirs, or null for a note
/// that named none (every note from before replyTo).
fn notes(db: &Connection, request: &str) -> Result<Vec<Value>> {
    type Row = (i64, String, String, String, Option<String>);
    let rows = db
        .prepare_cached("SELECT n,note,by_agent_id,at,reply_to FROM project_request_notes WHERE request_id=?1 ORDER BY n")?
        .query_map([request], |r| Ok::<Row, _>((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(n, note, by, at, reply_to)| {
            let reply_to: Value = reply_to.map(|raw| serde_json::from_str(&raw)).transpose()?.unwrap_or(Value::Null);
            Ok(json!({"n":n,"note":note,"by":routes::agent(db, &by)?,"at":at,"replyTo":reply_to}))
        })
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
