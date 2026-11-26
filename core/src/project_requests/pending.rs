//! What a Project's front desk still owes the user (R-31 #3, the user's
//! choice: one list, by number): each request R-n not routed or answered
//! yet, and each follow-up R-n #m that no note names in its replyTo. Read
//! each time from the request's own records (the request, its follow-ups,
//! the front desk's notes and routes), never stored, so it outlives a
//! restart and a new front desk as they do, old follow-ups included.
//!
//! A request is handled as progress.rs says it: once a route put it on a
//! card or answered it. A follow-up only by a note that names it (routes.rs
//! replyTo); never by its delivery, a card, a task's progress, result or
//! report, a note that names no follow-up, or one that names another. One
//! note may name several; notes come in any order and may repeat.
//!
//! A lead reads the list with `project_requests_pending` (each item with the
//! user's words and how to reply), and the front desk replies with
//! project_route as before. As a fallback Core tells the front desk of them
//! by mail, each item at most once for each front desk
//! (`project_request_told`):
//! - when one of its Turns ends (the journal's turn/completed, read after a
//!   cursor as brief_turns.rs reads them): the items it has had or never had,
//!   not those still on their way to it, at most one mail a SPACING;
//! - when it becomes the front desk (a change of the Project's leads or front
//!   desk queues a check in its transaction, `desk_changed`): the same, at
//!   once;
//! - when a result comes on a task a request was routed to while that
//!   request has follow-ups waiting (`project_request_result_told`): back to
//!   that request, at most once a SPACING for it, never for a result of its
//!   own.
//! Its own mail ends no Turn with anything new to tell, so it never wakes
//! the front desk again by itself. Nothing is read on a timer: the passes
//! read only what came after their cursors, and the checks queued.
use super::{delivery, front_desk, routes};
use crate::workspace::Workspace;
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) const TOOL: &str = "project_requests_pending";

/// The least time between two mails of a kind to one front desk: Turn-end
/// mails of one Project, result mails of one request.
const SPACING_SECONDS: i64 = 600;
/// Items a mail names one by one; the rest are counted.
const MAIL_ITEMS: usize = 12;
/// Characters of the user's words an item shows in the list and in a mail.
const PREVIEW_CHARS: usize = 200;
const MAIL_PREVIEW_CHARS: usize = 120;
/// Items the list gives at once, whole requests (a request with more than
/// this many owed gives this many of them).
const LIST_ITEMS: usize = 25;
/// Bytes of one item's words a read gives at once (an MCP answer holds 48 KiB).
const WORDS_PAGE: usize = 24_000;
/// Journal and activity rows read per pass.
const BATCH: i64 = 64;
const TURNS_CURSOR: &str = "projectRequests.pendingTurnSeq";
const RESULTS_CURSOR: &str = "projectRequests.pendingResultSeq";

/// Runs on every open, after project_requests' and routes' tables and the
/// journal's and tasks': idempotent. Turn ends and results from before this
/// Core read any are not read.
pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_request_told(
            agent_id TEXT NOT NULL,
            request_id TEXT NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
            m INTEGER NOT NULL,
            why TEXT NOT NULL,
            message_id TEXT NOT NULL,
            at TEXT NOT NULL,
            PRIMARY KEY(agent_id, request_id, m));
        CREATE TABLE IF NOT EXISTS project_request_result_told(
            result_id TEXT NOT NULL,
            request_id TEXT NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            message_id TEXT,
            at TEXT NOT NULL,
            PRIMARY KEY(result_id, request_id));
        CREATE INDEX IF NOT EXISTS project_request_result_told_recent ON project_request_result_told(agent_id, request_id, at);
        CREATE TABLE IF NOT EXISTS project_request_desk_checks(
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            at TEXT NOT NULL);
        DELETE FROM project_request_told WHERE request_id NOT IN (SELECT id FROM project_requests);
        DELETE FROM project_request_result_told WHERE request_id NOT IN (SELECT id FROM project_requests);
        DELETE FROM project_request_desk_checks WHERE project_id NOT IN (SELECT id FROM projects);",
    )?;
    db.execute(
        "INSERT OR IGNORE INTO workspace_meta(key,value) SELECT ?1, CAST(COALESCE(MAX(seq),0) AS TEXT) FROM journal",
        [TURNS_CURSOR],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO workspace_meta(key,value) SELECT ?1, CAST(COALESCE(MAX(seq),0) AS TEXT) FROM collaboration_task_activity",
        [RESULTS_CURSOR],
    )?;
    Ok(())
}

/// A change of `project`'s leads or front desk (agent_roles.rs, front_desk.rs),
/// in its transaction: the next pass tells the front desk it has then what it
/// owes and never had.
pub(crate) fn desk_changed(db: &Connection, project: &str) -> Result<()> {
    db.execute(
        "INSERT INTO project_request_desk_checks(project_id,at) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET at=excluded.at",
        params![project, crate::model::now()],
    )?;
    Ok(())
}

/// One thing the front desk owes: request R-n itself (`m` None) or its
/// follow-up #m.
#[derive(Clone, Debug)]
pub(crate) struct Item {
    pub request_id: String,
    pub n: i64,
    pub title: Option<String>,
    pub m: Option<i64>,
    pub at: String,
    pub text: String,
    /// Who its message went to, with how each stands (as its receipt says).
    pub to: Vec<(String, Option<String>)>,
    /// waiting; unsent (it reached no one: no receipt accepted or queued);
    /// later (a follow-up a note naming no follow-up came after: written
    /// before replyTo, or by an older Core; it may answer it).
    pub state: &'static str,
}

impl Item {
    fn label(&self) -> String {
        match self.m {
            Some(m) => format!("R-{} #{m}", self.n),
            None => format!("R-{}", self.n),
        }
    }

    /// Whether it is still on its way to `agent`: sent to it and not yet taken into a Turn.
    fn on_its_way_to(&self, agent: &str) -> bool {
        self.to.iter().any(|(to, state)| to == agent && matches!(state.as_deref(), Some("queued" | "sending")))
    }
}

fn reached(state: &Option<String>) -> bool {
    matches!(state.as_deref(), Some("accepted" | "queued"))
}

/// Everything `project`'s front desk owes the user, oldest request first, a
/// request before its follow-ups. `from` leaves out the requests numbered
/// below it.
pub(crate) fn pending(db: &Connection, project: &str, from: i64) -> Result<Vec<Item>> {
    type Row = (String, i64, Option<String>, String, String, String, String);
    let requests = db
        .prepare_cached(
            "SELECT id,n,title,text,created_at,front_agent_id,message_id FROM project_requests WHERE project_id=?1 AND n>=?2 ORDER BY n",
        )?
        .query_map(params![project, from], |r| Ok::<Row, _>((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut items = Vec::new();
    for (id, n, title, text, at, front, message) in requests {
        let handled = routes::of_request(db, &id)?.iter().any(|row| {
            row.state == routes::DONE && matches!(row.kind.as_str(), routes::CARD | routes::EXISTING | routes::ANSWER)
        });
        if !handled {
            let state = delivery(db, &id, &front, &message, None)?;
            let unsent = !reached(&state);
            items.push(Item { request_id: id.clone(), n, title: title.clone(), m: None, at, text, to: vec![(front, state)],
                state: if unsent { "unsent" } else { "waiting" } });
        }
        items.extend(follow_ups(db, &id, n, &title)?);
    }
    Ok(items)
}

/// Request `request`'s follow-ups no note names, oldest first.
fn follow_ups(db: &Connection, request: &str, n: i64, title: &Option<String>) -> Result<Vec<Item>> {
    let notes = db
        .prepare_cached("SELECT at,reply_to FROM project_request_notes WHERE request_id=?1")?
        .query_map([request], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut answered = std::collections::BTreeSet::new();
    let mut unnamed = Vec::new();
    for (at, reply_to) in notes {
        match reply_to {
            // A list Core wrote (routes.rs); one it cannot read answers none.
            Some(raw) => answered.extend(serde_json::from_str::<Vec<i64>>(&raw).unwrap_or_default()),
            None => unnamed.push(at),
        }
    }
    type Row = (i64, String, String, String, String);
    let replies = db
        .prepare_cached("SELECT n,text,at,message_id,delivered_to FROM project_request_replies WHERE request_id=?1 ORDER BY n")?
        .query_map([request], |r| Ok::<Row, _>((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut items = Vec::new();
    for (m, text, at, message, delivered_to) in replies {
        if answered.contains(&m) {
            continue;
        }
        let to = serde_json::from_str::<Vec<String>>(&delivered_to)
            .unwrap_or_default()
            .into_iter()
            .map(|agent| Ok((agent.clone(), delivery(db, request, &agent, &message, Some(m))?)))
            .collect::<Result<Vec<_>>>()?;
        let state = if !to.iter().any(|(_, state)| reached(state)) {
            "unsent"
        } else if unnamed.iter().any(|note| *note > at) {
            "later"
        } else {
            "waiting"
        };
        items.push(Item { request_id: request.to_owned(), n, title: title.clone(), m: Some(m), at, text, to, state });
    }
    Ok(items)
}

/// The first `chars` characters of `text`, a longer one ending in "…".
fn preview(text: &str, chars: usize) -> String {
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

/// How the front desk replies to `item`, as project_route takes it.
fn reply_hint(item: &Item) -> String {
    match item.m {
        Some(m) => format!("project_route {{\"request\":\"R-{}\",\"note\":\"<your reply>\",\"replyTo\":[{m}]}}", item.n),
        None => format!("project_route {{\"request\":\"R-{}\",\"title\":…,\"note\":…,\"routes\":[…]}} (a card, an existing card, or answer)", item.n),
    }
}

fn state_note(item: &Item) -> Option<&'static str> {
    match item.state {
        "unsent" => Some("its message reached no one: none was taken or queued"),
        "later" => Some("a note naming no follow-up came after it (written before replyTo, or by an older Core): if it answers this, \
            name it in a note's replyTo"),
        _ => None,
    }
}

pub(crate) fn tool_definition() -> Value {
    json!({
        "name":TOOL,
        "description":"For your Project's leads: what its front desk still owes the user, by number: each request R-n not routed or \
            answered yet, and each follow-up R-n #m no note of the front desk names in its replyTo, oldest first, with the user's words \
            and how to reply. Only a note naming a follow-up answers it: not its delivery, a card, a task's result or report, a note \
            naming no follow-up, or one naming another; one note may name several (replyTo [2,3]). Read from the requests' own records, \
            so it holds after a restart and for a new front desk. The front desk replies with project_route: a follow-up with request, \
            note and replyTo; a request by routing or answering it. Give request (R-12), and followUp for one of its follow-ups, to \
            read that item's whole words, in parts from offset.",
        "inputSchema":{"type":"object","additionalProperties":false,"properties":{
            "request":{"type":"string","description":"R-12: read this request's words whole (or with followUp, that follow-up's), \
                whether or not it is owed."},
            "followUp":{"type":"integer","minimum":1,"description":"With request: its follow-up #m."},
            "offset":{"type":"integer","minimum":0,"description":"With request: the byte offset to read its words from, as nextOffset \
                gave it."},
            "fromRequest":{"type":"integer","minimum":1,"description":"Without request: list only requests numbered from this one, \
                as nextFromRequest gave it."}
        }}
    })
}

/// The Project `actor` leads, or why it may not read its list.
fn led(db: &Connection, actor: &str) -> Result<String> {
    const WHO: &str = "only a Project's leads read what its front desk owes the user";
    let project = crate::projects::agent_project(db, actor)?.with_context(|| format!("not_lead: you are in no Project; {WHO}"))?;
    ensure!(crate::agent_roles::leads(db, actor, &project)?, "not_lead: you do not lead your Project; {WHO}");
    Ok(project)
}

fn number(value: Option<&Value>, what: &str) -> Result<Option<i64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => Ok(Some(value.as_i64().filter(|v| *v >= 0).with_context(|| format!("invalid_input: {what} is a whole number"))?)),
    }
}

fn to_json(db: &Connection, to: &[(String, Option<String>)]) -> Result<Vec<Value>> {
    to.iter()
        .map(|(agent, state)| {
            let mut who = routes::agent(db, agent)?;
            who["delivery"] = json!(state);
            Ok(who)
        })
        .collect()
}

pub(crate) async fn call(ws: Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let actor = actor.context("agent_only: project_requests_pending is a lead's; the user reads the requests on the Project's page")?;
    let object = input.as_object().context("invalid_input: give an object")?;
    if let Some(key) = object.keys().find(|key| !matches!(key.as_str(), "request" | "followUp" | "offset" | "fromRequest")) {
        bail!("invalid_input: {key} is not one of request, followUp, offset, fromRequest");
    }
    let request = match object.get("request") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let text = value.as_str().context("invalid_input: request is R-12")?;
            Some(text.trim().strip_prefix("R-").and_then(|n| n.parse::<i64>().ok()).filter(|n| *n > 0)
                .with_context(|| format!("invalid_input: request is a request's number as R-12, not {text}"))?)
        }
    };
    let (follow_up, offset, from) = (number(object.get("followUp"), "followUp")?, number(object.get("offset"), "offset")?,
        number(object.get("fromRequest"), "fromRequest")?);
    ensure!(request.is_some() || (follow_up.is_none() && offset.is_none()), "invalid_input: followUp and offset go with request");
    ensure!(request.is_none() || from.is_none(), "invalid_input: fromRequest lists; leave it out with request");
    ws.stored(move |store| {
        let db = store.db.read()?;
        let project = led(&db, &actor)?;
        match request {
            Some(n) => read(&db, &project, n, follow_up, offset.unwrap_or(0) as usize),
            None => list(&db, &project, &actor, from.unwrap_or(1)),
        }
    })
    .await
}

fn item_json(db: &Connection, item: &Item) -> Result<Value> {
    let mut row = json!({"request":format!("R-{}", item.n),"title":item.title,"at":item.at,"state":item.state,
        "words":preview(&item.text, PREVIEW_CHARS),"wordsChars":item.text.chars().count(),"to":to_json(db, &item.to)?,
        "reply":reply_hint(item)});
    if let Some(m) = item.m {
        row["followUp"] = json!(m);
    }
    if let Some(note) = state_note(item) {
        row["note"] = json!(note);
    }
    Ok(row)
}

fn list(db: &Connection, project: &str, actor: &str, from: i64) -> Result<Value> {
    let desk = front_desk::in_project(db, project)?.effective_agent_id;
    let items = pending(db, project, from)?;
    let (requests, follow_ups) = (items.iter().filter(|i| i.m.is_none()).count(), items.iter().filter(|i| i.m.is_some()).count());
    // Whole requests, oldest first, while they fit; the first one always.
    let mut numbers: Vec<i64> = items.iter().map(|item| item.n).collect();
    numbers.dedup();
    let (mut shown, mut next) = (Vec::new(), None);
    for n in numbers {
        let of: Vec<&Item> = items.iter().filter(|item| item.n == n).collect();
        if !shown.is_empty() && shown.len() + of.len() > LIST_ITEMS {
            next = Some(n);
            break;
        }
        for item in of.iter().take(LIST_ITEMS) {
            shown.push(item_json(db, item)?);
        }
    }
    let mut answer = json!({
        "projectId":project,
        "frontDesk":desk.as_deref().map(|agent| routes::agent(db, agent)).transpose()?,
        "youAreFrontDesk":desk.as_deref() == Some(actor),
        "owed":{"requests":requests,"followUps":follow_ups},
        "items":shown,
    });
    if let Some(n) = next {
        answer["nextFromRequest"] = json!(n);
    }
    if desk.as_deref() != Some(actor) {
        answer["note"] = json!("Only the front desk replies to the user (project_route); you read this as a lead.");
    }
    Ok(answer)
}

/// Request R-`n` (or its follow-up #`m`) of `project`: its words from byte
/// `offset`, at most WORDS_PAGE bytes, and whether it is owed.
fn read(db: &Connection, project: &str, n: i64, m: Option<i64>, offset: usize) -> Result<Value> {
    let (id, title, text, at): (String, Option<String>, String, String) = db
        .query_row("SELECT id,title,text,created_at FROM project_requests WHERE project_id=?1 AND n=?2", params![project, n],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()?
        .with_context(|| format!("request_not_found: your Project has no request R-{n}"))?;
    let (text, at) = match m {
        None => (text, at),
        Some(m) => db
            .query_row("SELECT text,at FROM project_request_replies WHERE request_id=?1 AND n=?2", params![id, m],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .optional()?
            .with_context(|| format!("follow_up_not_found: R-{n} has no follow-up #{m}"))?,
    };
    ensure!(offset <= text.len(), "invalid_input: offset {offset} is past the words' end ({} bytes)", text.len());
    let start = (0..=offset).rev().find(|at| text.is_char_boundary(*at)).unwrap_or(0);
    let mut end = (start + WORDS_PAGE).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let owed = pending(db, project, n)?.into_iter().find(|item| item.n == n && item.m == m);
    let mut answer = json!({"request":format!("R-{n}"),"title":title,"at":at,"words":&text[start..end],"offset":start,"bytes":text.len(),
        "owed":owed.is_some()});
    if let Some(m) = m {
        answer["followUp"] = json!(m);
    }
    if let Some(item) = &owed {
        answer["state"] = json!(item.state);
        answer["reply"] = json!(reply_hint(item));
        answer["to"] = json!(to_json(db, &item.to)?);
    }
    if end < text.len() {
        answer["nextOffset"] = json!(end);
    }
    Ok(answer)
}

/// The reminder passes' journal and activity positions, kept between passes
/// so an idle one reads nothing but two maxima.
#[derive(Default)]
pub(crate) struct State {
    cursors: tokio::sync::Mutex<Option<(i64, i64)>>,
}

fn saved(db: &Connection, key: &str) -> Result<i64> {
    let value: Option<String> = db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [key], |r| r.get(0)).optional()?;
    Ok(value.and_then(|v| v.parse().ok()).unwrap_or(0))
}

fn save(db: &Connection, key: &str, seq: i64) -> Result<()> {
    db.execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, seq.to_string()],
    )?;
    Ok(())
}

/// What one pass has to look at, read only: how far the journal and the
/// tasks' activity reach, and whether a check is queued or a Turn end or a
/// result came after the cursors. The journal grows with every event; only
/// those rows ask for the writer.
struct Ahead {
    journal: i64,
    activity: i64,
    work: bool,
}

fn ahead(db: &Connection, turns: i64, results: i64) -> Result<Ahead> {
    let journal: i64 = db.query_row("SELECT COALESCE(MAX(seq),0) FROM journal", [], |r| r.get(0))?;
    let activity: i64 = db.query_row("SELECT COALESCE(MAX(seq),0) FROM collaboration_task_activity", [], |r| r.get(0))?;
    let work = db.query_row("SELECT EXISTS(SELECT 1 FROM project_request_desk_checks)", [], |r| r.get::<_, bool>(0))?
        || (journal > turns
            && db.query_row("SELECT EXISTS(SELECT 1 FROM journal WHERE seq>?1 AND seq<=?2 AND kind='turn/completed')",
                params![turns, journal], |r| r.get::<_, bool>(0))?)
        || (activity > results
            && db.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_task_activity WHERE seq>?1 AND seq<=?2 AND json_extract(data,'$.kind')='result')",
                params![results, activity], |r| r.get::<_, bool>(0))?);
    Ok(Ahead { journal, activity, work })
}

/// Why a mail tells of items: a Turn of the front desk ended; it became the
/// front desk; a result came.
#[derive(Clone, Copy, PartialEq)]
enum Why {
    Turn,
    Desk,
}

impl Why {
    fn name(self) -> &'static str {
        match self {
            Why::Turn => "turn",
            Why::Desk => "desk",
        }
    }
}

fn told(db: &Connection, agent: &str, item: &Item) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_request_told WHERE agent_id=?1 AND request_id=?2 AND m=?3)",
        params![agent, item.request_id, item.m.unwrap_or(0)],
        |r| r.get(0),
    )?)
}

fn mark_told(db: &Connection, agent: &str, item: &Item, why: &str, message: &str, at: &str) -> Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO project_request_told(agent_id,request_id,m,why,message_id,at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![agent, item.request_id, item.m.unwrap_or(0), why, message, at],
    )?;
    Ok(())
}

/// Seconds since `at` (RFC 3339); a time Core cannot read is long ago.
fn since(at: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(at).map_or(i64::MAX, |at| chrono::Utc::now().signed_duration_since(at).num_seconds())
}

fn project_name(db: &Connection, project: &str) -> Result<Option<(String, bool)>> {
    Ok(crate::projects::project_labels(db)?.remove(project))
}

fn send(db: &Connection, agent: &str, body: String, metadata: Value, source: Value) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let name = routes::agent(db, agent)?["name"].clone();
    crate::collaboration_store::insert_message(
        db,
        json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
            "recipient":{"kind":"agent","id":agent,"name":name},"body":body,"taskId":null,"replyTo":null,"threadId":id,
            "createdAt":crate::model::now(),"source":source,"priority":"normal","metadata":metadata}),
    )?;
    Ok(id)
}

fn item_line(item: &Item) -> String {
    let what = match (item.m, item.state) {
        (Some(_), "later") => "follow-up, a note naming no follow-up came after it",
        (Some(_), "unsent") => "follow-up that reached no one",
        (Some(_), _) => "follow-up",
        (None, "unsent") => "request that reached no one, not routed or answered",
        (None, _) => "request, not routed or answered",
    };
    format!("- {} ({what}, {}): \u{201c}{}\u{201d}", item.label(), item.at, preview(&item.text, MAIL_PREVIEW_CHARS).replace('\n', " "))
}

/// Tells `desk`, `project`'s front desk, of what it owes and was not told of,
/// in one mail; none when nothing is new, or (a Turn's end) within SPACING of
/// the last. Whether a mail went.
fn tell(db: &Connection, project: &str, desk: &str, why: Why) -> Result<bool> {
    let Some((name, archived)) = project_name(db, project)? else { return Ok(false) };
    if archived {
        return Ok(false);
    }
    let mut fresh = Vec::new();
    for item in pending(db, project, 1)? {
        // On a change of front desk, only what went to someone else: what
        // went to it, it is told of when one of its Turns ends.
        let had = item.to.iter().any(|(to, _)| to == desk);
        if !item.on_its_way_to(desk) && !(why == Why::Desk && had) && !told(db, desk, &item)? {
            fresh.push(item);
        }
    }
    if fresh.is_empty() {
        return Ok(false);
    }
    if why == Why::Turn {
        let last: Option<String> = db.query_row(
            "SELECT MAX(t.at) FROM project_request_told t JOIN project_requests q ON q.id=t.request_id
             WHERE t.agent_id=?1 AND q.project_id=?2 AND t.why IN ('turn','desk')",
            params![desk, project],
            |r| r.get(0),
        )?;
        if last.is_some_and(|at| since(&at) < SPACING_SECONDS) {
            return Ok(false);
        }
    }
    let opening = match why {
        Why::Turn => format!("As {name}'s front desk, you have not replied to these yet:"),
        Why::Desk => format!("As {name}'s front desk, the user is still owed a reply to these, which went to someone else:"),
    };
    let mut lines: Vec<String> = fresh.iter().take(MAIL_ITEMS).map(item_line).collect();
    if fresh.len() > MAIL_ITEMS {
        lines.push(format!("- and {} more.", fresh.len() - MAIL_ITEMS));
    }
    let body = format!(
        "{opening}\n{}\n\nReply where the user reads it: project_route with request R-n, your note and replyTo [m] for a follow-up \
         (one note may name several, replyTo [2,3]); route or answer a request with project_route. A card, a task's result or a \
         report is no reply. project_requests_pending lists every item with the user's whole words. Core tells you of each once.",
        lines.join("\n")
    );
    let items: Vec<Value> = fresh.iter().map(|item| json!({"request":item.n,"followUp":item.m})).collect();
    let message = send(db, desk, body, json!({"kind":"projectRequests","status":"awaitingReply","why":why.name(),"projectId":project,
        "items":items}), json!({"projectRequests":project}))?;
    let at = crate::model::now();
    for item in &fresh {
        mark_told(db, desk, item, why.name(), &message, &at)?;
    }
    Ok(true)
}

/// A result came on `task` (activity `seq`): each request routed to it that
/// still has follow-ups waiting sends its front desk back to it, unless the
/// front desk wrote the result, or was sent back to that request within
/// SPACING. How many mails went.
fn result_came(db: &Connection, task: &str, result: &str, author: Option<&str>, status: &str) -> Result<usize> {
    let requests: Vec<(String, String, i64)> = db
        .prepare_cached(&format!(
            "SELECT DISTINCT q.id,q.project_id,q.n FROM project_routes r JOIN project_requests q ON q.id=r.request_id
             WHERE r.task_id=?1 AND r.state='{}' AND r.kind IN ('{}','{}')",
            routes::DONE, routes::CARD, routes::EXISTING
        ))?
        .query_map([task], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut sent = 0;
    for (request, project, n) in requests {
        let Some(desk) = front_desk::in_project(db, &project)?.effective_agent_id else { continue };
        if author == Some(desk.as_str()) {
            continue;
        }
        let Some((name, archived)) = project_name(db, &project)? else { continue };
        if archived {
            continue;
        }
        let title: Option<String> = db.query_row("SELECT title FROM project_requests WHERE id=?1", [&request], |r| r.get(0))?;
        let waiting: Vec<Item> = follow_ups(db, &request, n, &title)?.into_iter().filter(|item| !item.on_its_way_to(&desk)).collect();
        if waiting.is_empty() {
            continue;
        }
        let last: Option<String> = db.query_row(
            "SELECT MAX(at) FROM project_request_result_told WHERE agent_id=?1 AND request_id=?2 AND message_id IS NOT NULL",
            params![desk, request],
            |r| r.get(0),
        )?;
        let at = crate::model::now();
        if last.is_some_and(|at| since(&at) < SPACING_SECONDS) {
            db.execute("INSERT OR IGNORE INTO project_request_result_told(result_id,request_id,agent_id,message_id,at) VALUES(?1,?2,?3,NULL,?4)",
                params![result, request, desk, at])?;
            continue;
        }
        let key = crate::collaboration_store::task_shown(db, task);
        let numbers: Vec<String> = waiting.iter().filter_map(|item| item.m).map(|m| m.to_string()).collect();
        let lines: Vec<String> = waiting.iter().take(MAIL_ITEMS).map(item_line).collect();
        let body = format!(
            "{key} has a new result ({status}). It was routed from R-{n} in {name}, whose follow-ups still wait for your reply as the \
             front desk:\n{}\n\nGo back to R-{n} and reply there: project_route with request R-{n}, your note and replyTo [{}]. The \
             result itself is no reply to the user.",
            lines.join("\n"),
            numbers.join(",")
        );
        let items: Vec<Value> = waiting.iter().map(|item| json!({"request":item.n,"followUp":item.m})).collect();
        let message = send(db, &desk, body, json!({"kind":"projectRequests","status":"resultArrived","projectId":project,
            "items":items,"taskId":key,"resultId":result}), json!({"projectRequests":project,"resultId":result}))?;
        db.execute("INSERT OR IGNORE INTO project_request_result_told(result_id,request_id,agent_id,message_id,at) VALUES(?1,?2,?3,?4,?5)",
            params![result, request, desk, message, at])?;
        for item in &waiting {
            mark_told(db, &desk, item, "result", &message, &at)?;
        }
        sent += 1;
    }
    Ok(sent)
}

/// One pass in one transaction: the queued checks, then the Turn ends and
/// results after the cursors, up to `journal` and `activity` (at most BATCH
/// of each). How far each read reached, whether more may wait, and whether a
/// mail went.
fn pass(db: &Connection, turns: i64, results: i64, journal: i64, activity: i64) -> Result<(i64, i64, bool, bool)> {
    let mut mailed = false;
    let checks: Vec<String> = db
        .prepare("SELECT project_id FROM project_request_desk_checks ORDER BY at")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for project in checks {
        db.execute("DELETE FROM project_request_desk_checks WHERE project_id=?1", [&project])?;
        if let Some(desk) = front_desk::in_project(db, &project)?.effective_agent_id {
            mailed |= tell(db, &project, &desk, Why::Desk)?;
        }
    }
    let ends: Vec<(i64, String)> = db
        .prepare_cached("SELECT seq,agent_id FROM journal WHERE seq>?1 AND seq<=?2 AND kind='turn/completed' ORDER BY seq LIMIT ?3")?
        .query_map(params![turns, journal, BATCH], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let turns_full = ends.len() as i64 >= BATCH;
    let mut seen = std::collections::BTreeSet::new();
    for (_, agent) in &ends {
        // One look per Agent a pass, however many of its Turns ended.
        if !seen.insert(agent.clone()) {
            continue;
        }
        let Some(project) = crate::projects::agent_project(db, agent)? else { continue };
        if front_desk::in_project(db, &project)?.effective_agent_id.as_deref() == Some(agent.as_str()) {
            mailed |= tell(db, &project, agent, Why::Turn)?;
        }
    }
    type Came = (i64, String, Option<String>, Option<String>, Option<String>);
    let came: Vec<Came> = db
        .prepare_cached(
            "SELECT seq,task_id,json_extract(data,'$.result.id'),json_extract(data,'$.actor.id'),json_extract(data,'$.result.status')
             FROM collaboration_task_activity WHERE seq>?1 AND seq<=?2 AND json_extract(data,'$.kind')='result' ORDER BY seq LIMIT ?3",
        )?
        .query_map(params![results, activity, BATCH], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let results_full = came.len() as i64 >= BATCH;
    for (seq, task, result, author, status) in &came {
        let result = result.clone().unwrap_or_else(|| format!("activity-{seq}"));
        // Read once: a result already looked at (a pass that did not commit, read again) tells nothing again.
        let fresh: bool = !db.query_row("SELECT EXISTS(SELECT 1 FROM project_request_result_told WHERE result_id=?1)", [&result], |r| r.get(0))?;
        if fresh {
            mailed |= result_came(db, task, &result, author.as_deref(), status.as_deref().unwrap_or("result"))? > 0;
        }
    }
    // A full batch reached its last row; else every row up to the maxima.
    let turns = if turns_full { ends.last().map_or(journal, |e| e.0) } else { journal };
    let results = if results_full { came.last().map_or(activity, |c| c.0) } else { activity };
    Ok((turns, results, turns_full || results_full, mailed))
}

impl Workspace {
    /// The reminder passes (see the module's head). Called by the
    /// collaboration loop before mail, so a mail goes in the same round.
    pub(crate) async fn remind_pending_replies(self: &Arc<Self>) -> Result<()> {
        let Ok(_permit) = self.admission.enter_work() else { return Ok(()) };
        let mut cursors = self.pending_replies.cursors.lock().await;
        let (mut turns, mut results) = match *cursors {
            Some(cursors) => cursors,
            None => self.stored(|store| {
                let db = store.db.read()?;
                Ok((saved(&db, TURNS_CURSOR)?, saved(&db, RESULTS_CURSOR)?))
            }).await?,
        };
        loop {
            let (from_turns, from_results) = (turns, results);
            let Ahead { journal, activity, work } = self.stored(move |store| ahead(&*store.db.read()?, from_turns, from_results)).await?;
            if !work {
                // Nothing to tell: the cursors move on in memory only; a
                // restart reads the rows after the saved ones again, which
                // costs a range scan.
                *cursors = Some((journal.max(turns), activity.max(results)));
                return Ok(());
            }
            let (reached, more, mailed) = self.stored(move |store| {
                let mut writer = store.db.write()?;
                let tx = writer.transaction()?;
                let (t, r, more, mailed) = pass(&tx, from_turns, from_results, journal.max(from_turns), activity.max(from_results))?;
                save(&tx, TURNS_CURSOR, t)?;
                save(&tx, RESULTS_CURSOR, r)?;
                tx.commit()?;
                Ok(((t, r), more, mailed))
            }).await?;
            (turns, results) = reached;
            *cursors = Some(reached);
            if mailed {
                self.collaboration_wakeup.notify_one();
            }
            if !more {
                return Ok(());
            }
        }
    }
}

