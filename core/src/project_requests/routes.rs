//! `project_route` (YN-86 §4.2, §4.3; slice S3a-2): the front desk routes
//! the user's request R-n to cards, as one recorded step. Only the Project's
//! front desk calls it (front_desk.rs: the lead the user chose, else the
//! only lead), and it does nothing the front desk could not do itself: each
//! route is the front desk's own task_create, task_dispatch, brief_update and
//! peer_send, so every check of those applies as it would to the front desk
//! (a dispatch from a template is a lead's; the user's templates and routing
//! choose the executor; the Brief's rules decide the card). Core adds only
//! what it copies from the record: the user's words, byte for byte.
//!
//! Each route is kept by (request, index): the same route again is the same
//! route, done once; one that failed is tried again where it stopped; a
//! different one at a recorded index is refused. One route failing never
//! undoes another.
use super::{front_desk, message, request_row, send, Request, ORIGIN, REQUEST};
use crate::{commit_sha::{self, Form}, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) const TOOL: &str = "project_route";

/// Route kinds: a new card, an existing card, and the user's reassignment
/// of a card (reassign.rs).
pub(super) const CARD: &str = "card";
pub(super) const EXISTING: &str = "existing";
pub(super) const REASSIGN: &str = "reassign";

/// Route states: recorded and not finished, finished, and stopped by an
/// error (tried again by the same route).
pub(super) const PENDING: &str = "pending";
pub(super) const DONE: &str = "done";
pub(super) const FAILED: &str = "failed";

/// Routes in one request: routes [Route, …1..6] (YN-86 §4.2).
const MAX_ROUTES: usize = 6;

/// title, note and why, in characters as the Brief's validator counts a
/// section's title (UTF-16 units): a card's title is a section's title
/// (project_brief/mod.rs, maxLength 120), and note and why are one short line
/// each beside it (YN-86 §4.1, §4.3).
pub(super) const MAX_LINE: usize = 120;

/// Runs on every open, after project_requests' tables: idempotent.
pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_routes(
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            request_id TEXT REFERENCES project_requests(id) ON DELETE CASCADE,
            idx INTEGER,
            client_id TEXT,
            kind TEXT NOT NULL,
            input TEXT NOT NULL,
            task_id TEXT,
            section_id INTEGER,
            card_key TEXT,
            target_agent_id TEXT,
            from_agent_id TEXT,
            why TEXT NOT NULL,
            by_agent_id TEXT,
            at TEXT NOT NULL,
            state TEXT NOT NULL,
            error TEXT,
            UNIQUE(request_id, idx),
            UNIQUE(project_id, client_id));
        CREATE INDEX IF NOT EXISTS project_routes_task ON project_routes(task_id);
        CREATE TABLE IF NOT EXISTS project_request_notes(
            request_id TEXT NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
            n INTEGER NOT NULL,
            note TEXT NOT NULL,
            by_agent_id TEXT NOT NULL,
            at TEXT NOT NULL,
            PRIMARY KEY(request_id, n));
        DELETE FROM project_routes WHERE project_id NOT IN (SELECT id FROM projects)
            OR (request_id IS NOT NULL AND request_id NOT IN (SELECT id FROM project_requests));
        DELETE FROM project_request_notes WHERE request_id NOT IN (SELECT id FROM project_requests);",
    )?;
    Ok(())
}

pub(crate) fn tool_definition() -> Value {
    let line = |what: &str| json!({"type":"string","minLength":1,"maxLength":MAX_LINE,"description":what});
    json!({
        "name":TOOL,
        "description":"For your Project's front desk only: route the user's request R-n to cards, as one recorded step. Core copies the user's words byte for byte into each new task's description and each hand-off message; you add only title, note and why. Each route is done once per (request, its index): send the same routes again and none is done twice (one that failed is tried again where it stopped), so a call with the routes already done only changes the title. Routes, done in order, one failing never undoing another:\n- card + executor {templateId, tier?, machineId?}, materials?, body?: a new task, dispatched to a new executor as your own task_create and task_dispatch would (the user's templates and routing apply; materials and body go to that dispatch only, checked before the route is recorded), then its card: a status section you own, keyed by the task's key in lowercase and bound to it. For code, give materials.worktree (made inside the Project's folder), a full baseSha and repositoryId, else it starts in the Project's folder (yuzuno_guide topic delivery);\n- card + agentId: a new task and card for an open member of the Project (yourself: no message);\n- existing + cardKey: the request joins a live card bound to a task; its words go to the Agent answering for it.\nWhere: development coordination (code, merges, releases, across cards) to the standing lead's card (existing, or card + agentId); research, design, comparison or audit to card + executor (templates investigation, design, decision-memo); the same matter as an existing card: existing, saying why. Do not research or design yourself; routing to yourself is recorded too.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["request","title","note","routes"],"properties":{
            "request":{"type":"string","description":"R-12, as Core's message names the request."},
            "title":line("A short phrase, like a task title, saying what the request is; not the user's words, not where it goes. The user knows the request by it."),
            "note":line("Your reply in the user's conversation, one or two short sentences."),
            "routes":{"type":"array","minItems":1,"maxItems":MAX_ROUTES,"items":{"type":"object","additionalProperties":false,"required":["kind","why"],"properties":{
                "kind":{"type":"string","enum":[CARD,EXISTING]},
                "why":line("Why this route: shown with it to the user and sent to who takes it."),
                "title":line("card: the new task's and card's title; at most 300 bytes in UTF-8, as a task's title."),
                "shortName":{"type":"string","minLength":1,"maxLength":crate::collaboration_store::SHORT_NAME_CHARS,"description":"card: the task's short name, as task_create's."},
                "executor":{"type":"object","additionalProperties":false,"required":["templateId"],"properties":{
                    "templateId":{"type":"string"},"tier":{"type":"string","enum":crate::executor_templates::TIERS},"machineId":{"type":"string"}}},
                "materials":materials_schema(),
                "body":{"type":"string","description":"card + executor: its dispatch's additional instructions, as task_dispatch's body; at most 16384 bytes in UTF-8."},
                "agentId":{"type":"string","description":"card: an open member of the Project, not an executor."},
                "cardKey":{"type":"string","description":"existing: the card's section key."}}}}}}
    })
}

/// A card route's materials (YN-135): task_dispatch's, except that baseSha
/// and headSha are full SHAs (`materials`).
fn materials_schema() -> Value {
    let mut schema = crate::collaboration_store::materials_schema();
    for (key, purpose) in [("baseSha", "The commit the work starts from."), ("headSha", "The commit to deliver or review.")] {
        schema["properties"][key] = commit_sha::schema(Form::Any, true, &format!("{purpose} Core asks GitHub in repositoryId \
            before the route is recorded: one that is no commit there refuses the call."));
    }
    schema
}

/// The longest additional instructions of a dispatch, in UTF-8 bytes, as
/// its materials take task_dispatch's body (dispatch_materials.rs).
const MAX_BODY: usize = 16_384;

/// A route as kept.
#[derive(Clone, Debug)]
pub(super) struct RouteRow {
    pub id: String,
    pub request_id: Option<String>,
    pub idx: Option<i64>,
    pub kind: String,
    /// The route as given, checked (`route`): what a repeat must equal.
    pub input: Value,
    pub task_id: Option<String>,
    pub section_id: Option<i64>,
    pub card_key: Option<String>,
    pub target_agent_id: Option<String>,
    /// A reassignment's earlier responsible Agent.
    pub from_agent_id: Option<String>,
    pub why: String,
    /// The front desk that routed it; None for the user.
    pub by_agent_id: Option<String>,
    pub at: String,
    pub state: String,
    pub error: Option<String>,
}

const ROUTE: &str = "id,request_id,idx,kind,input,task_id,section_id,card_key,target_agent_id,from_agent_id,why,by_agent_id,at,state,error";

fn route_row(r: &rusqlite::Row) -> rusqlite::Result<RouteRow> {
    Ok(RouteRow {
        id: r.get(0)?,
        request_id: r.get(1)?,
        idx: r.get(2)?,
        kind: r.get(3)?,
        input: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(Value::Null),
        task_id: r.get(5)?,
        section_id: r.get(6)?,
        card_key: r.get(7)?,
        target_agent_id: r.get(8)?,
        from_agent_id: r.get(9)?,
        why: r.get(10)?,
        by_agent_id: r.get(11)?,
        at: r.get(12)?,
        state: r.get(13)?,
        error: r.get(14)?,
    })
}

pub(super) fn rows(db: &Connection, condition: &str, values: impl rusqlite::Params) -> Result<Vec<RouteRow>> {
    Ok(db
        .prepare_cached(&format!("SELECT {ROUTE} FROM project_routes WHERE {condition}"))?
        .query_map(values, route_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// A request's routes, by index.
pub(super) fn of_request(db: &Connection, request: &str) -> Result<Vec<RouteRow>> {
    rows(db, "request_id=?1 ORDER BY idx", [request])
}

/// What came to a task's card, oldest first: the routes that put requests
/// on it and the user's reassignments of it, finished.
pub(super) fn of_task(db: &Connection, task: &str) -> Result<Vec<RouteRow>> {
    rows(db, "task_id=?1 AND state='done' ORDER BY at, rowid", [task])
}

/// The user's finished reassignments of a task's card, oldest first.
pub(super) fn reassignments(db: &Connection, task: &str) -> Result<Vec<RouteRow>> {
    rows(db, "task_id=?1 AND kind='reassign' AND state='done' ORDER BY at, rowid", [task])
}

/// An Agent as a route names it: its ID and name (empty once deleted).
pub(super) fn agent(db: &Connection, id: &str) -> Result<Value> {
    let name: Option<String> = db
        .query_row("SELECT json_extract(data,'$.agent.name') FROM agents WHERE id=?1", [id], |r| r.get(0))
        .optional()?
        .flatten();
    Ok(json!({"agentId":id,"name":name.unwrap_or_default()}))
}

/// A route as the Project's page and a card's handoffs show it: what kind,
/// who made it (null: the user) and who it went to, why, its card and task,
/// and how it stands. Never the user's words.
pub(super) fn json(db: &Connection, row: &RouteRow) -> Result<Value> {
    let request: Option<i64> = match &row.request_id {
        Some(id) => db.query_row("SELECT n FROM project_requests WHERE id=?1", [id], |r| r.get(0)).optional()?,
        None => None,
    };
    let who = |id: &Option<String>| -> Result<Value> { id.as_deref().map(|id| agent(db, id)).transpose().map(|v| v.unwrap_or(Value::Null)) };
    let mut shown = json!({
        "kind":row.kind,"index":row.idx,"request":request,"at":row.at,"state":row.state,"why":row.why,
        "by":who(&row.by_agent_id)?,"to":who(&row.target_agent_id)?,
        "task":row.task_id.as_deref().map(|id| crate::collaboration_store::task_shown(db, id)),
        "cardKey":row.card_key,"sectionId":row.section_id,
    });
    if row.kind == CARD {
        shown["title"] = row.input["title"].clone();
    }
    if row.kind == REASSIGN {
        shown["from"] = who(&row.from_agent_id)?;
    }
    if let Some(error) = &row.error {
        shown["error"] = json!(error);
    }
    Ok(shown)
}

/// One call, checked before anything is read or written.
#[derive(Clone, Debug)]
struct Call {
    n: i64,
    title: String,
    note: String,
    /// Each route as `route` checked it: what is kept and compared.
    routes: Vec<Value>,
}

/// A short line: not only blank, at most MAX_LINE characters once its
/// spaces at either end are gone, as it is kept.
fn line(input: &Value, field: &str, at: &str) -> Result<String> {
    let text = input.get(field).and_then(Value::as_str).with_context(|| format!("invalid_input: {at}{field} is required, as text"))?;
    let text = text.trim();
    ensure!(!text.is_empty(), "invalid_input: {at}{field} is empty; write it in a few words");
    let length = text.encode_utf16().count();
    ensure!(length <= MAX_LINE, "invalid_input: {at}{field} is {length} characters; at most {MAX_LINE}");
    Ok(text.to_owned())
}

/// R-12 (as Core's message names it), or its number.
fn request_number(value: Option<&Value>) -> Result<i64> {
    let number = match value {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(text)) => {
            let text = text.trim();
            text.strip_prefix("R-").or_else(|| text.strip_prefix("r-")).unwrap_or(text).parse().ok()
        }
        _ => None,
    };
    number.filter(|n| *n > 0).context("invalid_input: request is a request's number as Core's message names it, e.g. R-12")
}

fn parse(input: &Value) -> Result<Call> {
    let object = input.as_object().context("invalid_input: expected an object")?;
    if let Some(key) = object.keys().find(|key| !matches!(key.as_str(), "request" | "title" | "note" | "routes")) {
        bail!("invalid_input: unknown argument {key}");
    }
    let n = request_number(input.get("request"))?;
    let title = line(input, "title", "")?;
    let note = line(input, "note", "")?;
    let given = input.get("routes").and_then(Value::as_array).context("invalid_input: routes is a list of routes")?;
    ensure!((1..=MAX_ROUTES).contains(&given.len()), "invalid_input: routes has 1 to {MAX_ROUTES} routes, not {}", given.len());
    let routes = given.iter().enumerate().map(|(index, given)| route(index, given)).collect::<Result<Vec<_>>>()?;
    Ok(Call { n, title, note, routes })
}

/// One route, checked and written as it is kept: its text without spaces
/// at either end, and only the fields its kind has.
fn route(index: usize, given: &Value) -> Result<Value> {
    let at = format!("routes[{index}].");
    let object = given.as_object().with_context(|| format!("invalid_input: {at} is not an object"))?;
    let kind = object.get("kind").and_then(Value::as_str).unwrap_or_default();
    let fields: &[&str] = match kind {
        CARD => &["kind", "why", "title", "shortName", "executor", "agentId", "materials", "body"],
        EXISTING => &["kind", "why", "cardKey"],
        _ => bail!("invalid_input: {at}kind is card or existing"),
    };
    if let Some(key) = object.keys().find(|key| !fields.contains(&key.as_str())) {
        bail!("invalid_input: {at}{key} is not a field of a {kind} route");
    }
    // Required of every route: a new card says why it was made, and a
    // request joined to a card says why it is the same matter (§4.4).
    let why = line(given, "why", &at)?;
    if kind == EXISTING {
        let key = given.get("cardKey").and_then(Value::as_str).map(str::trim).filter(|key| !key.is_empty())
            .with_context(|| format!("invalid_input: {at}cardKey names the card, its section's key"))?;
        return Ok(json!({"kind":kind,"cardKey":key,"why":why}));
    }
    let title = line(given, "title", &at)?;
    // A card's title is its task's too, which holds at most MAX_TITLE bytes.
    let bytes = title.len();
    ensure!(bytes <= crate::collaboration_store::MAX_TITLE,
        "invalid_input: {at}title is {bytes} bytes in UTF-8; a task's title is at most {} (a Chinese character is 3)",
        crate::collaboration_store::MAX_TITLE);
    let short = given.get("shortName").and_then(Value::as_str).map(str::trim).filter(|short| !short.is_empty())
        .with_context(|| format!("invalid_input: {at}shortName is required: what the task is about in a few words"))?;
    let mut card = json!({"kind":kind,"title":title,"shortName":short,"why":why});
    let (materials, body) = (self::materials(&at, object.get("materials"))?, self::body(&at, object.get("body"))?);
    match (object.get("executor"), object.get("agentId")) {
        (Some(executor), None) => {
            card["executor"] = self::executor(&at, executor)?;
            if let Some(materials) = materials {
                card["materials"] = materials;
            }
            if let Some(body) = body {
                card["body"] = json!(body);
            }
        }
        (None, Some(Value::String(agent))) if !agent.trim().is_empty() => {
            // A new executor starts from its dispatch's materials; an Agent
            // already here works in its own folder.
            for (field, given) in [("materials", materials.is_some()), ("body", body.is_some())] {
                ensure!(!given, "invalid_input: {at}{field} goes with executor: a new executor starts from its dispatch's materials, \
                    and an Agent already here works where it is. Nothing was routed");
            }
            card["agentId"] = json!(agent.trim());
        }
        _ => bail!("invalid_input: {at} a card route gives executor for a new executor, or agentId for an Agent already here; one of them"),
    }
    Ok(card)
}

/// A card route's materials (YN-135), as kept: an object, as task_dispatch's,
/// none when it is null or says nothing. Core's shaCheck is no part of it,
/// and its baseSha and headSha are full SHAs: a recorded route never
/// changes, and only GitHub can make one of an abbreviation. The rest is
/// checked before the route is recorded (`record`).
fn materials(at: &str, given: Option<&Value>) -> Result<Option<Value>> {
    let mut materials = match given {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(materials)) => materials.clone(),
        Some(_) => bail!("invalid_input: {at}materials is an object, as task_dispatch's materials"),
    };
    materials.remove("shaCheck");
    if materials.is_empty() {
        return Ok(None);
    }
    for key in ["baseSha", "headSha"] {
        match materials.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(sha)) if Form::Any.accepts(sha) => {}
            Some(sha) => bail!("invalid_input: {at}materials.{}", commit_sha::problem(key, sha.as_str().unwrap_or_default(), Form::Any)),
        }
    }
    Ok(Some(Value::Object(materials)))
}

/// A card route's body (YN-135): its dispatch's additional instructions,
/// without spaces at either end; none when that leaves nothing.
fn body(at: &str, given: Option<&Value>) -> Result<Option<String>> {
    let body = match given {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(body)) => body.trim(),
        Some(_) => bail!("invalid_input: {at}body is text, its dispatch's additional instructions"),
    };
    ensure!(body.len() <= MAX_BODY, "invalid_input: {at}body is {} bytes in UTF-8; a dispatch's additional instructions are at most {MAX_BODY}",
        body.len());
    Ok(Some(body.to_owned()).filter(|body| !body.is_empty()))
}

pub(super) fn executor(at: &str, given: &Value) -> Result<Value> {
    let object = given.as_object().with_context(|| format!("invalid_input: {at}executor is {{templateId, tier?, machineId?}}"))?;
    if let Some(key) = object.keys().find(|key| !matches!(key.as_str(), "templateId" | "tier" | "machineId")) {
        bail!("invalid_input: {at}executor.{key} is not a field; executor is {{templateId, tier?, machineId?}}");
    }
    let template = object.get("templateId").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty())
        .with_context(|| format!("invalid_input: {at}executor.templateId names one of the Workspace's executor templates"))?;
    let mut executor = json!({"templateId":template});
    match object.get("tier") {
        None | Some(Value::Null) => {}
        Some(Value::String(tier)) if crate::executor_templates::TIERS.contains(&tier.as_str()) => executor["tier"] = json!(tier),
        Some(_) => bail!("invalid_input: {at}executor.tier is strong or fast; leave it out for the template's own"),
    }
    match object.get("machineId") {
        None | Some(Value::Null) => {}
        Some(Value::String(machine)) if !machine.trim().is_empty() => executor["machineId"] = json!(machine.trim()),
        Some(_) => bail!("invalid_input: {at}executor.machineId names a machine, as machines_list lists them"),
    }
    Ok(executor)
}

/// The Project whose front desk `actor` is now, or why it routes nothing.
fn desk(db: &Connection, actor: &str) -> Result<String> {
    const WHO: &str = "only a Project's front desk routes its requests: the lead the user chose for it in the Project's settings, \
        or its only lead. Nothing was routed";
    let project = crate::projects::agent_project(db, actor)?.with_context(|| format!("not_front_desk: you are in no Project; {WHO}"))?;
    let desk = front_desk::in_project(db, &project)?.effective_agent_id;
    ensure!(desk.as_deref() == Some(actor), "not_front_desk: you are not your Project's front desk now; {WHO}");
    Ok(project)
}

/// What a call's routes run with: where, the request and who routes it.
struct Ctx {
    workspace: String,
    project: String,
    name: String,
    front: String,
    request: Request,
    /// The routes of this call still to do, by index.
    todo: Vec<RouteRow>,
    /// The indices this call gave.
    given: usize,
}

/// Checks the call against the request's recorded routes and records it, in
/// one transaction under the request's gate: its title, its note when it
/// says something new, and the routes not recorded before. A route given
/// again must be the one recorded at its index.
fn record(store: &Store, actor: &str, call: &Call) -> Result<Ctx> {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    let project = desk(&tx, actor)?;
    let workspace: String = tx.query_row("SELECT value FROM workspace_meta WHERE key='workspaceId'", [], |r| r.get(0))?;
    let (name, archived) = crate::projects::project_labels(&tx)?.remove(&project).context("project_not_found: no Project has this ID")?;
    ensure!(!archived, "project_archived: {name} is archived, and its requests are routed no more. Nothing was routed");
    let request = tx
        .query_row(&format!("SELECT {REQUEST} FROM project_requests WHERE project_id=?1 AND n=?2"), params![project, call.n], request_row)
        .optional()?
        .with_context(|| format!("request_not_found: {name} has no request R-{}. Nothing was routed", call.n))?;
    let known = of_request(&tx, &request.id)?;
    let at = crate::model::now();
    for (index, route) in call.routes.iter().enumerate() {
        match known.iter().find(|row| row.idx == Some(index as i64)) {
            Some(row) => ensure!(
                row.input == *route,
                "route_conflict: routes[{index}] is not the route R-{} has at index {index} ({}, {}), and a recorded route never \
                 changes. Send the recorded routes as they were, and put a new one after them. Nothing was routed",
                call.n, row.kind, row.state
            ),
            None => {
                // Its materials, checked as its dispatch will check them
                // (YN-135): a call they would fail records and makes nothing.
                if let Some(materials) = route.get("materials") {
                    worktree_here(&tx, index, &route["executor"], materials)?;
                    crate::collaboration_store::executor_dispatch::route_materials(&tx, &project, materials)
                        .map_err(|error| anyhow::anyhow!("{error:#} (routes[{index}].materials). Nothing was routed"))?;
                }
                tx.execute(
                    "INSERT INTO project_routes(id,project_id,request_id,idx,kind,input,why,by_agent_id,at,state)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![uuid::Uuid::new_v4().to_string(), project, request.id, index as i64, route["kind"].as_str(),
                        route.to_string(), route["why"].as_str(), actor, at, PENDING],
                )?;
            }
        }
    }
    tx.execute("UPDATE project_requests SET title=?2 WHERE id=?1", params![request.id, call.title])?;
    let last: Option<(i64, String)> = tx
        .query_row("SELECT n,note FROM project_request_notes WHERE request_id=?1 ORDER BY n DESC LIMIT 1", [&request.id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    if last.as_ref().is_none_or(|(_, note)| *note != call.note) {
        tx.execute(
            "INSERT INTO project_request_notes(request_id,n,note,by_agent_id,at) VALUES(?1,?2,?3,?4,?5)",
            params![request.id, last.map_or(1, |(n, _)| n + 1), call.note, actor, at],
        )?;
    }
    let todo = of_request(&tx, &request.id)?
        .into_iter()
        .filter(|row| row.idx.is_some_and(|idx| (idx as usize) < call.routes.len()) && row.state != DONE)
        .collect();
    let front = store.brief_in(&tx, actor)?.map(|brief| brief.agent.name).unwrap_or_default();
    tx.commit()?;
    Ok(Ctx { workspace, project, name, front, request, todo, given: call.routes.len() })
}

/// A route's worktree is a path on this Core host (YN-135, R1 a18614c4): it
/// goes only with an executor that runs here, as its dispatch takes its
/// machine: the route's executor.machineId, else its template's, else this
/// Core host; `auto` chooses this host for a worktree (executor_choice.rs),
/// and routing moves an executor to no other machine (routing_policy/
/// dispatch.rs). An executor on another machine works in its Project's
/// folder there, and its dispatch is refused a worktree (executor_dispatch.rs).
fn worktree_here(db: &Connection, index: usize, executor: &Value, materials: &Value) -> Result<()> {
    if !materials["worktree"].as_str().is_some_and(|worktree| !worktree.trim().is_empty()) {
        return Ok(());
    }
    let (machine, whose) = match executor["machineId"].as_str() {
        Some(machine) => (machine.to_owned(), "its executor.machineId"),
        None => {
            let template = crate::executor_templates::template(db, executor["templateId"].as_str().unwrap_or_default())?;
            match template.and_then(|template| template.machine_id).filter(|machine| !machine.is_empty()) {
                Some(machine) => (machine, "its template's machine"),
                None => ("local".to_owned(), "this Core host"),
            }
        }
    };
    ensure!(
        matches!(machine.as_str(), "local" | crate::collaboration_store::executor_choice::AUTO),
        "folder_not_allowed: routes[{index}].materials.worktree is a path on this Core host, and this executor runs on {machine} \
         ({whose}), where an executor works in its Project's folder there; leave worktree out, or give executor.machineId local. \
         Nothing was routed"
    );
    Ok(())
}

/// `project_route` for the Agent `actor`. Refused whole, nothing done, when
/// the call is malformed, `actor` is not the front desk, or a route differs
/// from the one recorded at its index. Otherwise each route not done yet is
/// done in order, and the answer says how each stands.
pub(crate) async fn call(ws: Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let actor = actor.context("agent_only: project_route is the front desk's; the user acts on the Project's page")?;
    let call = parse(&input)?;
    let (who, n) = (actor.clone(), call.n);
    let request: String = ws
        .stored(move |store| {
            let db = store.db.read()?;
            let project = desk(&db, &who)?;
            db.query_row("SELECT id FROM project_requests WHERE project_id=?1 AND n=?2", params![project, n], |r| r.get(0))
                .optional()?
                .with_context(|| format!("request_not_found: your Project has no request R-{n}. Nothing was routed"))
        })
        .await?;
    // One call at a time per request: a route is never done twice at once.
    let gate = ws.gate(&format!("project-route:{request}")).await;
    let _held = gate.lock().await;
    // Each SHA a route not recorded yet gives is asked of GitHub first, as
    // its dispatch will ask (YN-135): one GitHub says is no commit there
    // refuses the call before anything is recorded; one it can't answer for
    // goes on, and its dispatch asks again. A recorded route is not asked.
    let id = request.clone();
    let recorded: Vec<i64> = ws
        .stored(move |store| Ok(of_request(&*store.db.read()?, &id)?.into_iter().filter_map(|row| row.idx).collect()))
        .await?;
    for (index, route) in call.routes.iter().enumerate() {
        let Some(materials) = route.get("materials").filter(|m| !m["baseSha"].is_null() || !m["headSha"].is_null()) else {
            continue;
        };
        if !recorded.contains(&(index as i64)) {
            commit_sha::resolve_materials(&ws, Some(&actor), "task_create", json!({"materials":materials}))
                .await
                .map_err(|error| anyhow::anyhow!("{error:#} (routes[{index}].materials). Nothing was routed"))?;
        }
    }
    let (who, given) = (actor.clone(), call.clone());
    let ctx = ws.stored(move |store| record(store, &who, &given)).await?;
    for row in &ctx.todo {
        let outcome = match row.kind.as_str() {
            CARD => card(&ws, &actor, &ctx, row).await,
            _ => existing(&ws, &actor, &ctx, row).await,
        };
        let (id, error) = (row.id.clone(), outcome.err().map(|error| format!("{error:#}")));
        ws.stored(move |store| {
            let state = if error.is_some() { FAILED } else { DONE };
            store.db.write()?.execute("UPDATE project_routes SET state=?2,error=?3 WHERE id=?1", params![id, state, error])?;
            Ok(())
        })
        .await?;
    }
    super::announce(&ws, &ctx.project);
    crate::project_brief::announce(&ws, Some(&ctx.project));
    let (id, given) = (ctx.request.id.clone(), ctx.given);
    ws.stored(move |store| {
        let db = store.db.read()?;
        let routes = of_request(&db, &id)?
            .iter()
            .filter(|row| row.idx.is_some_and(|idx| (idx as usize) < given))
            .map(|row| json(&db, row))
            .collect::<Result<Vec<_>>>()?;
        let title: Option<String> = db.query_row("SELECT title FROM project_requests WHERE id=?1", [&id], |r| r.get(0))?;
        Ok(json!({"request":format!("R-{}", n),"title":title,"routes":routes}))
    })
    .await
}

/// The front desk's own call of a task or mail tool, as collaboration_call
/// makes it for the front desk (collaboration_runtime.rs): its materials'
/// SHAs asked of GitHub, then a template dispatch through
/// `executor_dispatch`, anything else through the store, with every check
/// either applies to an Agent's call.
async fn own_call(ws: &Arc<Workspace>, actor: &str, operation: &str, input: Value) -> Result<Value> {
    let input = if matches!(operation, "task_create" | "task_update" | "task_dispatch") {
        commit_sha::resolve_materials(ws, Some(actor), operation, input).await?
    } else {
        input
    };
    if operation == "task_dispatch" && input.get("executor").is_some() {
        return ws.executor_dispatch(Some(actor), input).await;
    }
    let permit = ws.admission.enter_completion()?;
    ws.collaboration_stored(permit, Some(actor), operation, input).await
}

/// A step's result on the route, as soon as it is done, so a retry goes on
/// from the next step.
async fn save(ws: &Arc<Workspace>, id: &str, column: &'static str, value: Value) -> Result<()> {
    debug_assert!(matches!(column, "task_id" | "target_agent_id"));
    let id = id.to_owned();
    ws.stored(move |store| {
        let value: rusqlite::types::Value = match value {
            Value::String(text) => text.into(),
            _ => rusqlite::types::Value::Null,
        };
        store.db.write()?.execute(&format!("UPDATE project_routes SET {column}=?2 WHERE id=?1"), params![id, value])?;
        Ok(())
    })
    .await
}

async fn save_card(ws: &Arc<Workspace>, id: &str, identity: i64, key: &str) -> Result<()> {
    let (id, key) = (id.to_owned(), key.to_owned());
    ws.stored(move |store| {
        store.db.write()?.execute("UPDATE project_routes SET section_id=?2,card_key=?3 WHERE id=?1", params![id, identity, key])?;
        Ok(())
    })
    .await
}

/// A request ID of the front desk's own call for one step of a route: the
/// same for every try of it, so a step done before is answered as it was.
fn step(row: &RouteRow, name: &str) -> String {
    format!("project-route:{}:{name}", row.id)
}

/// Whether `agent` may take a new card: an open member of `project`, not an
/// executor (one works on its own task only).
pub(super) fn may_take(db: &Connection, store: &Store, project: &str, agent: &str) -> Result<()> {
    let open = store.brief_in(db, agent)?.is_some_and(|brief| brief.agent.closed_at.is_none());
    let member = crate::projects::agent_project(db, agent)?.as_deref() == Some(project);
    ensure!(open && member, "not_member: {agent} is not an open Agent of this Project; a card goes to one of its open members");
    ensure!(
        crate::agent_roles::kind(db, agent)? != crate::agent_roles::EXECUTOR,
        "not_member: {agent} is an executor, which works on its own task only; give the card an executor of its own (executor) or a standing member"
    );
    Ok(())
}

/// The longest task description (collaboration_store.rs).
const MAX_DESCRIPTION: usize = crate::collaboration_store::MAX_DESCRIPTION;

/// What a new card's task description says before the user's words.
fn description_head(ctx: &Ctx) -> String {
    format!(
        "Request R-{} from the user to the project {}, routed to this task's card by the front desk {}. \
         The user's words, exactly as written:",
        ctx.request.n, ctx.name, ctx.front
    )
}

/// What follows the user's words in a task description: the front desk's why.
const WHY_PREFIX: &str = "\n\nWhy, in the front desk's words (not the user's): ";

/// The room a task description keeps after the words for the longest why:
/// MAX_LINE UTF-16 units, each at most 3 bytes of UTF-8.
const WHY_ROOM: usize = WHY_PREFIX.len() + 3 * MAX_LINE;

/// Whether a new card's task description holds the user's words whole
/// (Dev Lead 2, seq 12103): Core's head, a blank line and the words, in
/// bytes, within a task description's limit less the room for why.
fn words_fit(ctx: &Ctx) -> bool {
    description_head(ctx).len() + 2 + ctx.request.text.len() <= MAX_DESCRIPTION - WHY_ROOM
}

/// A new card's task description (§4.2): Core's head, a blank line, the
/// user's words byte for byte, then the front desk's why. When the words
/// do not fit (`words_fit`): Core's head says they went to the task's
/// assignee as a message from Home, then why (`whole` false).
fn description(ctx: &Ctx, why: &str) -> (String, bool) {
    let head = description_head(ctx);
    if words_fit(ctx) {
        return (format!("{head}\n\n{}{WHY_PREFIX}{why}", ctx.request.text), true);
    }
    let request = &ctx.request;
    (
        format!(
            "Request R-{} from the user to the project {}, routed to this task's card by the front desk {}. The user's words are \
             {} bytes, more than a task description holds; Core sent them, byte for byte, to this task's assignee as a message \
             from Home.{WHY_PREFIX}{why}",
            request.n, ctx.name, ctx.front, request.text.len()
        ),
        false,
    )
}

/// What the Agent a request is handed to reads before its words, in the
/// message Core sends it from Home (§4.2, §4.3). Only Core's words and what
/// the user named (the Project, the front desk) are in it, never an Agent's
/// (Dev Lead 2, seq 12103): the card is named by its task's key, and the
/// front desk's why goes by its own mail (`tell_why`).
fn hand_off_head(ctx: &Ctx, task: &str) -> String {
    format!(
        "Request R-{} from the user to the project {} (Workspace {}, Project {}), routed by the front desk {} to task {task}, \
         whose card you answer for; the user's words travel as they are:",
        ctx.request.n, ctx.name, ctx.workspace, ctx.project, ctx.front
    )
}

/// Sends the request's words to `agent` as one message from Home, Core's
/// head first, the user's pasted blocks with them (as a follow-up is sent).
async fn hand_off(ws: &Arc<Workspace>, ctx: &Ctx, row: &RouteRow, agent: &str, head: &str) -> Result<()> {
    let client = format!("route-{}", row.id);
    let request = &ctx.request;
    let origin = json!({"kind":ORIGIN,"projectId":ctx.project,"requestId":request.id,"request":request.n,"route":row.idx,
        "workspaceId":ctx.workspace});
    send(ws, agent, &client, origin, |turn| message(&client, head, &request.text, request.text_blocks.as_deref(), turn)).await?;
    Ok(())
}

/// The front desk's why, by mail from it to `agent`, about the card's task.
async fn tell_why(ws: &Arc<Workspace>, actor: &str, ctx: &Ctx, row: &RouteRow, agent: &str, task: &str, card: &str) -> Result<()> {
    let body = format!(
        "Request R-{} of the project {} was routed to {card}, which you answer for; the user's words reached you as a message \
         from Home. Why, in the front desk's words: {}",
        ctx.request.n, ctx.name, row.why
    );
    own_call(ws, actor, "peer_send", json!({"requestId":format!("{}:{agent}", step(row, "why")),
        "toAgentId":agent,"taskId":task,"body":body}))
        .await?;
    Ok(())
}

/// A card route: its task, then the task's executor or assignee, then its
/// card, each the front desk's own call, each saved once done.
async fn card(ws: &Arc<Workspace>, actor: &str, ctx: &Ctx, row: &RouteRow) -> Result<()> {
    let input = &row.input;
    let given = input["agentId"].as_str().map(str::to_owned);
    if let Some(agent) = &given {
        let (project, agent) = (ctx.project.clone(), agent.clone());
        ws.stored(move |store| may_take(&*store.db.read()?, store, &project, &agent)).await?;
    }
    let (text, whole) = description(ctx, &row.why);
    // A new executor takes no message before it starts: its task must hold
    // the words whole.
    if !whole && given.is_none() {
        bail!(
            "words_too_long_for_task: R-{}'s words are {} bytes, and with Core's head and your why they are more than a task \
             description holds ({MAX_DESCRIPTION} bytes); a new executor reads nothing else of them. Route it to an Agent already \
             here (existing, or card with agentId), which gets the words as a message, or ask the user to split it. Nothing was created",
            ctx.request.n, ctx.request.text.len()
        );
    }
    let task = match &row.task_id {
        Some(task) => task.clone(),
        None => {
            let mut create = json!({"requestId":step(row, "task"),"title":input["title"],"shortName":input["shortName"],
                "description":text,"projectId":ctx.project});
            if given.as_deref() == Some(actor) {
                create["assigneeAgentId"] = json!(actor);
                create["status"] = json!("doing");
            }
            let created = own_call(ws, actor, "task_create", create).await?;
            // The answer names the task by its key; the route keeps its internal ID.
            let shown = created["task"]["id"].as_str().context("task_create answered without a task")?.to_owned();
            let task = ws.stored(move |store| Ok(crate::collaboration_store::task_key(&*store.db.read()?, &shown)?.0)).await?;
            save(ws, &row.id, "task_id", json!(task)).await?;
            task
        }
    };
    let id = task.clone();
    let key = ws.stored(move |store| Ok(crate::collaboration_store::task_shown(&*store.db.read()?, &id))).await?;
    let agent = match (&row.target_agent_id, &given) {
        (Some(agent), _) => agent.clone(),
        (None, Some(agent)) => {
            if agent != actor {
                let body = format!("From request R-{} of the project {}, routed by the front desk {}.", ctx.request.n, ctx.name, ctx.front);
                own_call(ws, actor, "task_dispatch", json!({"requestId":step(row, "dispatch"),"taskId":task,
                    "expectedVersion":1,"toAgentId":agent,"body":body}))
                    .await?;
                if !whole {
                    hand_off(ws, ctx, row, agent, &hand_off_head(ctx, &key)).await?;
                }
            }
            save(ws, &row.id, "target_agent_id", json!(agent)).await?;
            agent.clone()
        }
        (None, None) => {
            let mut dispatch = json!({"requestId":step(row, "dispatch"),"taskId":task,"expectedVersion":1,"executor":input["executor"]});
            // Its materials and body as recorded (YN-135): the same on every try.
            for key in ["materials", "body"] {
                if let Some(value) = input.get(key) {
                    dispatch[key] = value.clone();
                }
            }
            let answer = own_call(ws, actor, "task_dispatch", dispatch).await?;
            let agent = answer["agentId"].as_str().context("task_dispatch answered without its executor")?.to_owned();
            save(ws, &row.id, "target_agent_id", json!(agent)).await?;
            agent
        }
    };
    if row.section_id.is_none() {
        let card = key.to_lowercase();
        let named = agent.clone();
        let name = ws.stored(move |store| Ok(agent_name(&*store.db.read()?, &named))).await?;
        let lead = format!("→ {name}: {}", row.why);
        let title = input["title"].as_str().unwrap_or_default();
        let identity = crate::project_brief::put_card(ws, actor, &ctx.project, &card, title, &lead, &task).await?;
        save_card(ws, &row.id, identity, &card).await?;
    }
    Ok(())
}

fn agent_name(db: &Connection, id: &str) -> String {
    agent(db, id).ok().and_then(|agent| agent["name"].as_str().map(str::to_owned)).filter(|name| !name.is_empty()).unwrap_or_else(|| id.to_owned())
}

/// An existing route: the request joins a live card bound to a task that
/// has not ended, and its words go to who answers for the card now, with
/// the front desk's why by mail; nothing is sent when that is the front
/// desk itself. An executor still waiting for its slot takes no message
/// from Home before it starts (R1 5e385a9d): it gets the words and why in
/// one mail from the front desk, which it reads once it starts
/// (`queued_hand_off`). Every check comes before the route records its card.
async fn existing(ws: &Arc<Workspace>, actor: &str, ctx: &Ctx, row: &RouteRow) -> Result<()> {
    let wanted = row.input["cardKey"].as_str().unwrap_or_default().to_owned();
    let project = ctx.project.clone();
    let (card, task, ended, responsible, waiting) = ws
        .stored(move |store| {
            let db = store.db.read()?;
            let card = crate::project_brief::live_card(&db, &project, &wanted)?
                .with_context(|| format!("not_a_card: this Project's Brief has no live section {wanted}"))?;
            let task = card.task.clone().with_context(|| {
                format!("not_a_card: {wanted} is bound to no task, so no Agent answers for it; route to a card bound to one, or make a new card")
            })?;
            let ended = crate::project_brief::task_ended(&db, &task)?;
            let responsible = crate::project_brief::responsible_agent(&db, &task)?;
            let waiting = match &responsible {
                Some(agent) => super::waits_for_slot(&db, agent)?,
                None => false,
            };
            Ok((card, task, ended, responsible, waiting))
        })
        .await?;
    let id = task.clone();
    let key = ws.stored(move |store| Ok(crate::collaboration_store::task_shown(&*store.db.read()?, &id))).await?;
    ensure!(!ended, "card_ended: {}'s task {key} has ended; route it to a card whose work goes on, or make a new card", card.key);
    let agent = responsible.with_context(|| {
        format!("no_responsible: no Agent answers for {}: its task {key} has no executor or assignee; dispatch it first", card.key)
    })?;
    let queued = (waiting && agent != actor).then(|| queued_hand_off(ctx, &row.why, &key)).transpose()?;
    let (route, card_key, identity, bound) = (row.id.clone(), card.key.clone(), card.identity, task.clone());
    ws.stored(move |store| {
        store.db.write()?.execute(
            "UPDATE project_routes SET task_id=?2,section_id=?3,card_key=?4 WHERE id=?1",
            params![route, bound, identity, card_key],
        )?;
        Ok(())
    })
    .await?;
    match queued {
        Some(body) => {
            own_call(ws, actor, "peer_send", json!({"requestId":format!("{}:{agent}", step(row, "words")),
                "toAgentId":agent,"taskId":task,"body":body}))
                .await?;
        }
        None if agent != actor => {
            let shown = format!("card {} (task {key})", card.key);
            hand_off(ws, ctx, row, &agent, &hand_off_head(ctx, &key)).await?;
            tell_why(ws, actor, ctx, row, &agent, &task, &shown).await?;
        }
        None => {}
    }
    save(ws, &row.id, "target_agent_id", json!(agent)).await
}

/// The mail that hands a request to a card's executor still waiting for its
/// slot (`existing`): Core's head, a blank line, the user's words byte for
/// byte, then the front desk's why, as one mail from the front desk (so no
/// Agent's words are ever sent as the user's). Refused, retryable once the
/// executor has started, when that is more than a mail holds.
fn queued_hand_off(ctx: &Ctx, why: &str, task: &str) -> Result<String> {
    let head = format!(
        "Request R-{} from the user to the project {} (Workspace {}, Project {}), routed by the front desk {} to task {task}, \
         whose card you answer for. You had not started yet, so it comes by the front desk's mail; the user's words, exactly \
         as written:",
        ctx.request.n, ctx.name, ctx.workspace, ctx.project, ctx.front
    );
    let body = format!("{head}\n\n{}{WHY_PREFIX}{why}", ctx.request.text);
    ensure!(
        body.len() <= crate::collaboration_store::MAX_MAIL_BODY,
        "executor_queued: who answers for task {task} is an executor still waiting for its slot, which takes no message from Home \
         before it starts, and R-{}'s words with Core's head and your why are {} bytes, more than a mail holds ({}). Route it \
         again once that executor has started (task_get shows its executorSlot); nothing was recorded on the card",
        ctx.request.n,
        body.len(),
        crate::collaboration_store::MAX_MAIL_BODY
    );
    Ok(body)
}

#[cfg(test)]
#[path = "route_tests.rs"]
mod tests;
