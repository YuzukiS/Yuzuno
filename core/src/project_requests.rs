//! Talking to a Project (YN-86 §4.1, §4.2, §4.4; slice S3a-1): what the user
//! says to a Project on its page, and the front desk it goes to. Core keeps
//! each message as request R-n of the Project, exactly as the user wrote it
//! with its pasted blocks, and sends it to the front desk as one message:
//! Core's head, then the user's words as they are. A follow-up to a request
//! is kept the same way and goes to whoever answers for the request. Core
//! never reads or judges the words: what is a new request and what is a
//! follow-up is the user's explicit choice. The front desk routes a request
//! to cards with project_route (routes.rs, slice S3a-2); its progress is read
//! from its cards' tasks (progress.rs), and the user reassigns a card
//! (reassign.rs).
mod front_desk;
mod progress;
mod reassign;
pub(crate) mod routes;
pub(crate) use front_desk::lead_left;
pub(crate) use progress::handoffs;

use crate::{
    collaboration_credentials::MessageNotSubmitted,
    message_content::TextBlock,
    model::{MessageInput, MessageReceipt},
    project_brief::{follow_up_turn, MAX_REPLY},
    server::ApiError,
    workspace::Workspace,
};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{Path, Query, State},
    middleware,
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// The `origin.kind` of a request's and a follow-up's message, on its
/// receipt (T-6): the user wrote it on Home, to the Project.
pub(crate) const ORIGIN: &str = "project_request";

/// Runs on every open: idempotent, as `agent_roles::migrate`. The clean-up
/// covers a manual edit without foreign keys.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    front_desk::migrate(db)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_requests(
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            n INTEGER NOT NULL,
            text TEXT NOT NULL,
            text_blocks TEXT,
            title TEXT,
            created_at TEXT NOT NULL,
            front_agent_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'open',
            UNIQUE(project_id, n),
            UNIQUE(project_id, message_id));
        CREATE TABLE IF NOT EXISTS project_request_replies(
            request_id TEXT NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
            n INTEGER NOT NULL,
            text TEXT NOT NULL,
            text_blocks TEXT,
            at TEXT NOT NULL,
            message_id TEXT NOT NULL,
            delivered_to TEXT NOT NULL,
            PRIMARY KEY(request_id, n),
            UNIQUE(request_id, message_id));
        DELETE FROM project_requests WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM project_request_replies WHERE request_id NOT IN (SELECT id FROM project_requests);",
    )?;
    routes::migrate(db)
}

/// What the user said, as their page sends it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Words {
    /// The Workspace whose page the user wrote on.
    pub workspace_id: String,
    pub text: String,
    /// Pasted blocks, as the composer marks them (UTF-16 offsets into `text`).
    #[serde(default)]
    pub text_blocks: Option<Vec<TextBlock>>,
    /// The page's ID for this message: sent again, it is the same message.
    pub client_message_id: String,
}

/// Refused before anything was kept or sent: the page keeps the words, and
/// sending them again is a new message.
fn not_submitted(message: String) -> anyhow::Error {
    anyhow::Error::new(MessageNotSubmitted(anyhow::anyhow!(message)))
}

/// The words a message to a Project takes: at most `MAX_REPLY` bytes, the
/// limit of a reply from Home, so that Core's head fits beside them in one
/// message (`MAX_MESSAGE_TEXT`); not only blank; their pasted blocks as a
/// conversation's message has them.
fn check(words: &Words) -> Result<()> {
    let bytes = words.text.len();
    if bytes > MAX_REPLY {
        return Err(not_submitted(format!(
            "reply_too_long: this message is {bytes} bytes; a message to a project is at most {MAX_REPLY} bytes in UTF-8, \
             where a Chinese character is 3. Nothing was sent, and your message is kept."
        )));
    }
    if words.text.trim().is_empty() {
        return Err(not_submitted("empty_message: write what to tell the project. Nothing was sent.".into()));
    }
    if words.client_message_id.is_empty() || words.client_message_id.len() > 100 {
        return Err(not_submitted("A message needs a clientMessageId of 1–100 bytes. Nothing was sent.".into()));
    }
    let said = MessageInput {
        client_message_id: words.client_message_id.clone(),
        text: words.text.clone(),
        text_blocks: words.text_blocks.clone(),
        images: vec![],
        expected_turn_id: None,
        question: None,
        clarification: None,
    };
    crate::message_content::validate(&said).map_err(|error| not_submitted(format!("{error}. Nothing was sent.")))
}

/// What the front desk reads before a request's words.
pub(crate) fn request_head(workspace: &str, project: &str, project_id: &str, n: i64) -> String {
    format!(
        "Request R-{n} from the user to the project {project} (Workspace {workspace}, Project {project_id}). \
         Route it with project_route; the user's words travel as they are:"
    )
}

/// What a follow-up's Agent reads before its words.
pub(crate) fn follow_up_head(workspace: &str, project: &str, project_id: &str, n: i64) -> String {
    format!(
        "Follow-up to request R-{n} from the user, in the project {project} (Workspace {workspace}, Project {project_id}); \
         the user's words travel as they are:"
    )
}

/// One message: `head`, a blank line, then the user's `words` byte for byte,
/// their pasted blocks moved past the head.
pub(crate) fn message(client: &str, head: &str, words: &str, blocks: Option<&[TextBlock]>, turn: Option<String>) -> MessageInput {
    let shift = head.encode_utf16().count() + 2;
    MessageInput {
        client_message_id: client.into(),
        text: format!("{head}\n\n{words}"),
        text_blocks: blocks.map(|blocks| {
            blocks.iter().map(|block| TextBlock { id: block.id.clone(), start: block.start + shift, end: block.end + shift }).collect()
        }),
        images: vec![],
        expected_turn_id: turn,
        question: None,
        clarification: None,
    }
}

/// A request as kept.
#[derive(Clone, Debug)]
struct Request {
    id: String,
    n: i64,
    text: String,
    text_blocks: Option<Vec<TextBlock>>,
    title: Option<String>,
    created_at: String,
    front_agent_id: String,
    message_id: String,
    state: String,
}

const REQUEST: &str = "id,n,text,text_blocks,title,created_at,front_agent_id,message_id,state";

fn request_row(r: &rusqlite::Row) -> rusqlite::Result<Request> {
    Ok(Request {
        id: r.get(0)?,
        n: r.get(1)?,
        text: r.get(2)?,
        text_blocks: blocks(r.get(3)?),
        title: r.get(4)?,
        created_at: r.get(5)?,
        front_agent_id: r.get(6)?,
        message_id: r.get(7)?,
        state: r.get(8)?,
    })
}

/// Blocks as kept: what Core validated, so a row it cannot read is shown without them.
fn blocks(raw: Option<String>) -> Option<Vec<TextBlock>> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
}

fn kept_blocks(blocks: &Option<Vec<TextBlock>>) -> Result<Option<String>> {
    Ok(blocks.as_ref().map(serde_json::to_string).transpose()?)
}

/// The Workspace, and the Project's name and whether it is archived, for one message.
struct Place {
    workspace: String,
    name: String,
    archived: bool,
}

/// Read in the caller's transaction, never beside it.
fn place(db: &Connection, project: &str, words: &Words) -> Result<Place> {
    let workspace: String = db.query_row("SELECT value FROM workspace_meta WHERE key='workspaceId'", [], |r| r.get(0))?;
    if words.workspace_id != workspace {
        return Err(not_submitted(
            "workspace_changed: this message was begun on another Workspace's page. Nothing was sent, and your message is kept.".into(),
        ));
    }
    let (name, archived) = crate::projects::project_labels(db)?.remove(project).context("project_not_found: no Project has this ID")?;
    Ok(Place { workspace, name, archived })
}

fn refuse_archived(place: &Place) -> Result<()> {
    if place.archived {
        return Err(not_submitted(format!(
            "project_archived: {} is archived; unarchive it to tell it something. Nothing was sent, and your message is kept.",
            place.name
        )));
    }
    Ok(())
}

/// The front desk a new message goes to, or why there is none.
fn front_desk_now(db: &Connection, project: &str) -> Result<String> {
    front_desk::in_project(db, project)?.effective_agent_id.ok_or_else(|| {
        not_submitted(
            "front_desk_required: this Project has several leads and none is its front desk. Choose one in the Project's \
             settings (Leads). Nothing was sent, and your message is kept."
                .into(),
        )
    })
}

/// Who the Project's requests go to now, as `front_desk::in_project` says.
#[cfg(test)]
pub(crate) fn front_desk_of(store: &crate::store::Store, project: &str) -> Option<String> {
    front_desk::get(store, project).ok()?.effective_agent_id
}

/// One lock per Project for its requests and follow-ups: each takes the
/// next number and sends before the next one does, so a message refused
/// before it was sent leaves no number taken.
async fn lock(ws: &Workspace, project: &str) -> Arc<tokio::sync::Mutex<()>> {
    ws.gate(&format!("project-requests:{project}")).await
}

/// Sends one message of a request to `agent`: the one sent before under its
/// client ID if there is one (a retry), else `compose` for the Turn the
/// Agent is in now. Another message under that client ID, one whose receipt
/// names another `origin`, is not this one: refused, nothing sent. Refused
/// before it was sent, `Err` says so.
async fn send(ws: &Arc<Workspace>, agent: &str, client: &str, origin: Value, compose: impl FnOnce(Option<String>) -> MessageInput)
    -> Result<MessageReceipt> {
    let (to, id) = (agent.to_owned(), client.to_owned());
    let input = match ws.stored(move |store| store.receipt(&to, &id)).await? {
        Some(previous) if previous.origin.as_ref() == Some(&origin) => previous.input,
        Some(_) => return Err(not_submitted("This clientMessageId was already used for another message. Nothing was sent.".into())),
        None => compose(follow_up_turn(&ws.send_view(agent).await.map_err(|error| not_submitted(error.to_string()))?)),
    };
    ws.send_message_from(agent, input, Vec::new(), Some(origin)).await
}

fn announce(ws: &Workspace, project: &str) {
    let _ = ws.changes.send(json!({"type":"workspace.changed","scope":"requests","projectId":project}));
}

/// `POST /api/projects/{id}/requests` (YN-86 §4.2): keeps what the user said
/// as the Project's next request and sends it to its front desk. The same
/// clientMessageId again is the same request, sent to the same Agent, its
/// receipt returned whatever has changed since; with other words it is
/// refused. Refused before it was sent (no front desk, the Agent closed),
/// nothing is kept.
pub(crate) async fn submit(ws: &Arc<Workspace>, project: &str, words: Words) -> Result<Value> {
    check(&words)?;
    let gate = lock(ws, project).await;
    let _held = gate.lock().await;
    let (id, said) = (project.to_owned(), words.clone());
    let (place, request) = ws.stored(move |store| {
        let mut writer = store.db.write()?;
        let tx = writer.transaction()?;
        let place = place(&tx, &id, &said)?;
        let found = tx
            .query_row(&format!("SELECT {REQUEST} FROM project_requests WHERE project_id=?1 AND message_id=?2"),
                params![id, said.client_message_id], request_row)
            .optional()?;
        if let Some(found) = found {
            ensure!(found.text == said.text && found.text_blocks == said.text_blocks, "This clientMessageId was already used for another message");
            return Ok((place, found));
        }
        refuse_archived(&place)?;
        let front = front_desk_now(&tx, &id)?;
        let n: i64 = tx.query_row("SELECT COALESCE(MAX(n),0)+1 FROM project_requests WHERE project_id=?1", [&id], |r| r.get(0))?;
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            n,
            text: said.text,
            text_blocks: said.text_blocks,
            title: None,
            created_at: crate::model::now(),
            front_agent_id: front,
            message_id: said.client_message_id,
            state: "open".into(),
        };
        tx.execute(
            "INSERT INTO project_requests(id,project_id,n,text,text_blocks,created_at,front_agent_id,message_id,state)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![request.id, id, request.n, request.text, kept_blocks(&request.text_blocks)?, request.created_at,
                request.front_agent_id, request.message_id, request.state],
        )?;
        tx.commit()?;
        Ok((place, request))
    }).await?;
    let origin = json!({"kind":ORIGIN,"projectId":project,"requestId":request.id,"request":request.n,"workspaceId":place.workspace});
    let head = request_head(&place.workspace, &place.name, project, request.n);
    let sent = send(ws, &request.front_agent_id, &request.message_id, origin, |turn| {
        message(&request.message_id, &head, &request.text, request.text_blocks.as_deref(), turn)
    }).await;
    match sent {
        Ok(receipt) => {
            announce(ws, project);
            let shown = ws.stored({
                let project = project.to_owned();
                move |store| view(&*store.db.read()?, &project, request)
            }).await?;
            Ok(json!({"request":shown,"receipt":receipt}))
        }
        Err(error) => {
            if error.is::<MessageNotSubmitted>() {
                let (id, agent, client) = (request.id.clone(), request.front_agent_id.clone(), request.message_id.clone());
                ws.stored(move |store| forget_request(&*store.db.write()?, &id, &agent, &client)).await?;
            }
            Err(error)
        }
    }
}

/// A request nothing was sent for: never kept. Not one with a follow-up, or
/// a receipt of its message (`MINE`).
fn forget_request(db: &Connection, id: &str, agent: &str, client: &str) -> Result<()> {
    db.execute(
        &format!("DELETE FROM project_requests WHERE id=?1
           AND NOT EXISTS(SELECT 1 FROM project_request_replies WHERE request_id=?1)
           AND NOT EXISTS(SELECT 1 FROM agent_receipts WHERE agent_id=?2 AND client_id=?3 AND {MINE})"),
        params![id, agent, client, Option::<i64>::None],
    )?;
    Ok(())
}

/// Whether `agent` is an executor still waiting for its slot: it takes no
/// message from Home before it starts (executor_slots.rs `executor_slot_gate`),
/// only mail, which reaches it once it has.
pub(super) fn waits_for_slot(db: &Connection, agent: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM executor_slots WHERE agent_id=?1 AND state='waiting')", [agent], |r| r.get(0))?)
}

/// Who a follow-up goes to (YN-86 §4.4): once the request is routed, each
/// open Agent that answers for one of its cards now (cards.rs: the task's
/// newest executor not yet released, else its assignee), in the order its
/// routes came, but an executor still waiting for its slot, which takes no
/// message before it starts (executor_slots.rs); until then, or when none
/// of its cards has such an Agent, the front desk as it is now.
fn follow_up_to(db: &Connection, project: &str, request: &str) -> Result<Vec<String>> {
    let mut to: Vec<String> = Vec::new();
    for task in progress::routed_tasks(db, request)? {
        let Some(agent) = crate::project_brief::responsible_agent(db, &task)? else { continue };
        let open: bool = db
            .query_row("SELECT json_extract(data,'$.agent.closedAt') IS NULL FROM agents WHERE id=?1", [&agent], |r| r.get(0))
            .optional()?
            .unwrap_or(false);
        if open && !waits_for_slot(db, &agent)? && !to.contains(&agent) {
            to.push(agent);
        }
    }
    if to.is_empty() {
        to.push(front_desk_now(db, project)?);
    }
    Ok(to)
}

/// `POST /api/projects/{id}/requests/{n}/replies` (YN-86 §4.4): the user's
/// follow-up to request R-n, kept as they wrote it and sent to whoever
/// answers for the request (`follow_up_to`), each Agent under the same client
/// ID. The same clientMessageId again is the same follow-up, sent to the same
/// Agents; with other words it is refused. Refused before it was sent to
/// anyone, nothing is kept.
pub(crate) async fn follow_up(ws: &Arc<Workspace>, project: &str, n: i64, words: Words) -> Result<Value> {
    check(&words)?;
    let gate = lock(ws, project).await;
    let _held = gate.lock().await;
    let (id, said) = (project.to_owned(), words.clone());
    let (place, request, reply) = ws.stored(move |store| {
        let mut writer = store.db.write()?;
        let tx = writer.transaction()?;
        let place = place(&tx, &id, &said)?;
        let request = tx
            .query_row(&format!("SELECT {REQUEST} FROM project_requests WHERE project_id=?1 AND n=?2"), params![id, n], request_row)
            .optional()?
            .ok_or_else(|| not_submitted(format!("request_not_found: this Project has no request R-{n}. Nothing was sent.")))?;
        let found = tx
            .query_row(&format!("SELECT {REPLY} FROM project_request_replies WHERE request_id=?1 AND message_id=?2"),
                params![request.id, said.client_message_id], reply_row)
            .optional()?;
        if let Some(found) = found {
            ensure!(found.text == said.text && found.text_blocks == said.text_blocks, "This clientMessageId was already used for another message");
            return Ok((place, request, found));
        }
        refuse_archived(&place)?;
        let to = follow_up_to(&tx, &id, &request.id)?;
        let m: i64 = tx.query_row("SELECT COALESCE(MAX(n),0)+1 FROM project_request_replies WHERE request_id=?1", [&request.id], |r| r.get(0))?;
        let reply = Reply { n: m, text: said.text, text_blocks: said.text_blocks, at: crate::model::now(), message_id: said.client_message_id, delivered_to: to };
        tx.execute(
            "INSERT INTO project_request_replies(request_id,n,text,text_blocks,at,message_id,delivered_to) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![request.id, reply.n, reply.text, kept_blocks(&reply.text_blocks)?, reply.at, reply.message_id,
                serde_json::to_string(&reply.delivered_to)?],
        )?;
        tx.commit()?;
        Ok((place, request, reply))
    }).await?;
    let head = follow_up_head(&place.workspace, &place.name, project, request.n);
    let origin = json!({"kind":ORIGIN,"projectId":project,"requestId":request.id,"request":request.n,"reply":reply.n,"workspaceId":place.workspace});
    let mut receipts = Vec::new();
    for agent in &reply.delivered_to {
        let sent = send(ws, agent, &reply.message_id, origin.clone(), |turn| {
            message(&reply.message_id, &head, &reply.text, reply.text_blocks.as_deref(), turn)
        }).await;
        match sent {
            Ok(receipt) => receipts.push(receipt),
            Err(error) => {
                if receipts.is_empty() && error.is::<MessageNotSubmitted>() {
                    let (id, m, to, client) = (request.id.clone(), reply.n, reply.delivered_to.clone(), reply.message_id.clone());
                    ws.stored(move |store| forget_reply(&*store.db.write()?, &id, m, &to, &client)).await?;
                }
                return Err(error);
            }
        }
    }
    announce(ws, project);
    let shown = ws.stored(move |store| reply_view(&*store.db.read()?, &request.id, reply)).await?;
    Ok(json!({"reply":shown,"receipts":receipts}))
}

/// A follow-up nothing was sent for: never kept. Not one any of its Agents
/// has a receipt of (`MINE`).
fn forget_reply(db: &Connection, request: &str, n: i64, to: &[String], client: &str) -> Result<()> {
    db.execute(
        &format!("DELETE FROM project_request_replies WHERE request_id=?1 AND n=?4
           AND NOT EXISTS(SELECT 1 FROM agent_receipts WHERE client_id=?3 AND agent_id IN (SELECT value FROM json_each(?2)) AND {MINE})"),
        params![request, serde_json::to_string(to)?, client, n],
    )?;
    Ok(())
}

/// A follow-up as kept.
#[derive(Clone, Debug)]
struct Reply {
    n: i64,
    text: String,
    text_blocks: Option<Vec<TextBlock>>,
    at: String,
    message_id: String,
    delivered_to: Vec<String>,
}

const REPLY: &str = "n,text,text_blocks,at,message_id,delivered_to";

fn reply_row(r: &rusqlite::Row) -> rusqlite::Result<Reply> {
    Ok(Reply {
        n: r.get(0)?,
        text: r.get(1)?,
        text_blocks: blocks(r.get(2)?),
        at: r.get(3)?,
        message_id: r.get(4)?,
        delivered_to: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
    })
}

/// A receipt of request ?1's message, or of its follow-up ?4 (NULL for the
/// request's own): the origin Core put on it names them, so another
/// message under the same client ID is never taken for it.
const MINE: &str = "json_extract(data,'$.origin.kind')='project_request' AND json_extract(data,'$.origin.requestId')=?1
    AND json_extract(data,'$.origin.reply') IS ?4";

/// How a message of request `request` stands (its follow-up `reply`, or its
/// own), as its receipt says (`accepted`, `queued`, `sending`, `uncertain`,
/// `rejected`, `unknown`); none without a receipt.
fn delivery(db: &Connection, request: &str, agent: &str, client: &str, reply: Option<i64>) -> Result<Option<String>> {
    Ok(db
        .prepare_cached(&format!("SELECT json_extract(data,'$.status') FROM agent_receipts WHERE agent_id=?2 AND client_id=?3 AND {MINE}"))?
        .query_row(params![request, agent, client, reply], |r| r.get::<_, Option<String>>(0))
        .optional()?
        .flatten())
}

fn reply_view(db: &Connection, request: &str, reply: Reply) -> Result<Value> {
    let delivered_to = reply.delivered_to.iter()
        .map(|agent| Ok(json!({"agentId":agent,"delivery":delivery(db, request, agent, &reply.message_id, Some(reply.n))?})))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"n":reply.n,"text":reply.text,"textBlocks":reply.text_blocks,"at":reply.at,"messageId":reply.message_id,"deliveredTo":delivered_to}))
}

/// A request as the Project's page reads it: the user's words and blocks as
/// kept, its title once the front desk gave it one, its message's delivery,
/// and its follow-ups, oldest first; then what routing made of it
/// (progress.rs): the front desk's notes, its routes, its cards and their
/// progress, and Core's lines for the conversation.
fn view(db: &Connection, project: &str, request: Request) -> Result<Value> {
    let replies = db
        .prepare_cached(&format!("SELECT {REPLY} FROM project_request_replies WHERE request_id=?1 ORDER BY n"))?
        .query_map([&request.id], reply_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|reply| reply_view(db, &request.id, reply))
        .collect::<Result<Vec<_>>>()?;
    let mut shown = json!({
        "id":request.id,"n":request.n,"text":request.text,"textBlocks":request.text_blocks,"title":request.title,
        "createdAt":request.created_at,"frontAgentId":request.front_agent_id,"messageId":request.message_id,
        "delivery":delivery(db, &request.id, &request.front_agent_id, &request.message_id, None)?,"replies":replies,
    });
    progress::show(db, project, &request.id, request.n, &mut shown)?;
    Ok(shown)
}

/// `GET /api/projects/{id}/requests?before=&limit=`: the Project's requests,
/// newest first, `limit` (at most 50, 20 by default) of those numbered
/// below `before`.
pub(crate) fn page(db: &Connection, project: &str, before: Option<i64>, limit: Option<usize>) -> Result<Value> {
    crate::projects::ensure_exists(db, project)?;
    let limit = limit.unwrap_or(20).clamp(1, 50);
    let mut rows = db
        .prepare_cached(&format!("SELECT {REQUEST} FROM project_requests WHERE project_id=?1 AND n<?2 ORDER BY n DESC LIMIT ?3"))?
        .query_map(params![project, before.unwrap_or(i64::MAX), limit as i64 + 1], request_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let requests = rows.into_iter().map(|request| view(db, project, request)).collect::<Result<Vec<_>>>()?;
    Ok(json!({"requests":requests,"hasMore":more}))
}

/// The user's routes: on Core's own port and on the phone entry, as the rest
/// of Home. No Agent tool reads or writes them (the front desk routes with
/// project_route, routes.rs), and an Agent's credential (any Authorization
/// header) is refused: a card's reassignment is the user's alone.
pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/projects/{id}/front-desk", get(get_front_desk).put(put_front_desk))
        .route("/api/projects/{id}/requests", get(list).post(post_request))
        .route("/api/projects/{id}/requests/{n}/replies", post(post_reply))
        .route("/api/projects/{id}/cards/{section}/reassign", post(post_reassign))
        .layer(middleware::from_fn(crate::routing_keys::routes::no_agent_credential))
}

type ApiResult<T> = Result<T, ApiError>;

async fn get_front_desk(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.stored(move |store| Ok(serde_json::to_value(front_desk::get(store, &id)?)?)).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrontDeskInput {
    expected_version: i64,
    agent_id: Option<String>,
}

async fn put_front_desk(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<FrontDeskInput>) -> ApiResult<Json<Value>> {
    let project = id.clone();
    let saved = ws.stored(move |store| front_desk::save(store, &project, input.expected_version, input.agent_id)).await?;
    announce(&ws, &id);
    Ok(Json(serde_json::to_value(saved)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageQuery {
    before: Option<i64>,
    limit: Option<usize>,
}

async fn list(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Query(query): Query<PageQuery>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.stored(move |store| page(&*store.db.read()?, &id, query.before, query.limit)).await?))
}

async fn post_request(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(words): Json<Words>) -> ApiResult<Json<Value>> {
    Ok(Json(submit(&ws, &id, words).await?))
}

async fn post_reassign(State(ws): State<Arc<Workspace>>, Path((id, section)): Path<(String, i64)>, Json(input): Json<reassign::Reassign>)
    -> ApiResult<Json<Value>> {
    Ok(Json(reassign::reassign(&ws, &id, section, input).await?))
}

async fn post_reply(State(ws): State<Arc<Workspace>>, Path((id, n)): Path<(String, i64)>, Json(words): Json<Words>) -> ApiResult<Json<Value>> {
    Ok(Json(follow_up(&ws, &id, n, words).await?))
}

#[cfg(test)]
#[path = "project_requests/tests.rs"]
mod tests;
