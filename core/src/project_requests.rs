//! Talking to a Project (YN-86 §4.1, §4.2, §4.4; slice S3a-1): what the user
//! says to a Project on its page, and the front desk it goes to. Core keeps
//! each message as request R-n of the Project, exactly as the user wrote it
//! with its pasted blocks, and sends it to the front desk as one message:
//! Core's head, then the user's words as they are. A follow-up to a request
//! is kept the same way and goes to whoever answers for the request. Core
//! never reads or judges the words: what is a new request and what is a
//! follow-up is the user's explicit choice. The front desk routes a request
//! to cards with project_route (routes.rs, slice S3a-2); its progress is read
//! from its cards' tasks (progress.rs), the user reassigns a card
//! (reassign.rs), and the user alone confirms a request done (`confirm`,
//! YN-184).
mod front_desk;
mod owed;
pub(crate) mod pending;
mod progress;
mod reassign;
pub(crate) mod routes;
pub(crate) use front_desk::lead_left;
pub(crate) use pending::desk_changed;
pub(crate) use progress::handoffs;

use crate::{
    collaboration_credentials::MessageNotSubmitted,
    github::installed::Installed,
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
    // images: the images the user attached on Home (YN-134), a JSON array of
    // their IDs; NULL without any. Older Cores ignore the column.
    for table in ["project_requests", "project_request_replies"] {
        let has: bool = db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='images')"), [], |r| r.get(0))?;
        if !has {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN images TEXT"))?;
        }
    }
    // files: the files the user attached on Home (YN-145), a JSON array of
    // their references; NULL without any. Older Cores ignore the column.
    for table in ["project_requests", "project_request_replies"] {
        let has: bool = db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name='files')"), [], |r| r.get(0))?;
        if !has {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN files TEXT"))?;
        }
    }
    // confirmed_at: when the user last confirmed the request done (YN-184),
    // written by `confirm` only; NULL until then. Older Cores ignore it.
    let has: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('project_requests') WHERE name='confirmed_at')", [], |r| r.get(0))?;
    if !has {
        db.execute_batch("ALTER TABLE project_requests ADD COLUMN confirmed_at TEXT")?;
    }
    // from_*: the proposal a request was opened from (YN-237 ④), on the
    // user's "new": the request it was proposed under, the Ask by its
    // identity on Home, the version the user answered and its key. NULL for
    // every request the user wrote; written once, by `keep_proposal`. Older
    // Cores ignore them.
    for (column, kind) in [("from_request_id", "TEXT"), ("from_section_id", "INTEGER"), ("from_version", "INTEGER"), ("from_key", "TEXT")] {
        let has: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('project_requests') WHERE name=?1)", [column], |r| r.get(0))?;
        if !has {
            db.execute_batch(&format!("ALTER TABLE project_requests ADD COLUMN {column} {kind}"))?;
        }
    }
    // When this Workspace's Core first asked the user to confirm requests
    // (YN-184), kept once: a request settled before it is done as the rule
    // before made it, with no confirmation written in the user's name.
    db.execute("INSERT OR IGNORE INTO workspace_meta(key,value) VALUES(?1,?2)", params![progress::CONFIRM_FROM, crate::model::now()])?;
    routes::migrate(db)?;
    pending::migrate(db)
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
    /// Images the user attached on Home (YN-134), by their IDs in the
    /// Project's images written on Home (input_images::home_dir). Each Agent
    /// the message goes to is given its own copy (`send`).
    #[serde(default)]
    pub images: Vec<String>,
    /// Files the user attached on Home (YN-145), by their references in the
    /// Project's files written on Home (input_files::home_dir). Each Agent the
    /// message goes to is given its own copy (`send`).
    #[serde(default)]
    pub files: Vec<crate::input_files::FileRef>,
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
         Route or answer it with project_route; the user's words travel as they are:"
    )
}

/// What the front desk reads before the words of a request a proposal opened
/// (YN-237 ④): that the user chose to make it a request, from which Ask under
/// which request; then the proposal's words, as the user accepted them.
pub(crate) fn proposal_head(workspace: &str, project: &str, project_id: &str, n: i64, under: i64, key: &str) -> String {
    format!(
        "Request R-{n} to the project {project} (Workspace {workspace}, Project {project_id}), opened by Core when the user chose \
         \"new request\" on the proposal `{key}` made under R-{under}; the two requests are linked both ways. Route or answer it \
         with project_route; the proposal's words, as the user accepted them:"
    )
}

/// What the front desk reads before a follow-up's words (R-45, the user's
/// choice on YN-233: only the front desk replies): the follow-up by its
/// number m; that it replies for the project where the user reads it, by
/// that number; and the request's tasks with who answers for each now,
/// whom it asks for material itself. Each name at most a line (MAX_LINE).
/// `desk` is None for an Agent that is not the front desk now (a follow-up
/// sent again under its client ID to whom it first went, before R-45): only
/// its number.
pub(crate) fn follow_up_head(workspace: &str, project: &str, project_id: &str, n: i64, m: i64, desk: Option<&[(String, String)]>) -> String {
    let Some(tasks) = desk else {
        return format!(
            "Follow-up #{m} to request R-{n} from the user, in the project {project} (Workspace {workspace}, Project {project_id}); \
             the user's words travel as they are:"
        );
    };
    let tasks = if tasks.is_empty() {
        String::new()
    } else {
        let line = |name: &str| match name.char_indices().nth(routes::MAX_LINE) {
            Some((at, _)) => format!("{}…", &name[..at]),
            None if name.is_empty() => "no one now".to_owned(),
            None => name.to_owned(),
        };
        let each = tasks.iter().map(|(task, who)| format!("{task} ({})", line(who))).collect::<Vec<_>>().join(", ");
        format!(" Its tasks and who answers for each now: {each}; ask them yourself for what you need (task_comment with notifyAgentId, \
            or peer_send), never send the user to them.")
    };
    format!(
        "Follow-up #{m} to request R-{n} from the user, in the project {project} (Workspace {workspace}, Project {project_id}). You reply \
         for the project, where the user reads it: project_route with request R-{n}, your note as the reply and replyTo [{m}] (no title \
         or routes needed); a card, result or report is no reply.{tasks} The user's words travel as they are:"
    )
}

/// Checks the images a message to a Project names (YN-134), before its lock
/// is taken: each in the Project's images written on Home, unchanged, and
/// within a message's count and total. Refused, nothing is kept or sent.
async fn check_images(ws: &Workspace, project: &str, images: &[String]) -> Result<()> {
    if images.is_empty() {
        return Ok(());
    }
    let (root, project, images) = (ws.data_dir.clone(), project.to_owned(), images.to_vec());
    tokio::task::spawn_blocking(move || crate::input_images::check_home(&root, &project, &images))
        .await?
        .map_err(|error| not_submitted(format!("home_images: {error}. Nothing was sent, and your message is kept.")))
}

/// Checks the files a message to a Project names (YN-145), before its lock is
/// taken: each in the Project's files written on Home, unchanged, and within
/// a message's count and total. Refused, nothing is kept or sent.
async fn check_files(ws: &Workspace, project: &str, files: &[crate::input_files::FileRef]) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let (root, project, files) = (ws.data_dir.clone(), project.to_owned(), files.to_vec());
    tokio::task::spawn_blocking(move || crate::input_files::check_home(&root, &project, &files))
        .await?
        .map_err(|error| not_submitted(format!("home_files: {error}. Nothing was sent, and your message is kept.")))
}

/// Refuses a message with files when one of the Agents it goes to takes no
/// files (YN-145), read in the caller's transaction: nothing is kept or sent.
fn refuse_files(db: &Connection, to: &[String], files: &[crate::input_files::FileRef]) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    for agent in to {
        let (name, harness): (Option<String>, Option<String>) = db
            .query_row("SELECT json_extract(data,'$.agent.name'),json_extract(data,'$.agent.harness') FROM agents WHERE id=?1", [agent],
                |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .unwrap_or_default();
        if !crate::input_files::takes_files(harness.as_deref().unwrap_or("codex")) {
            return Err(not_submitted(format!(
                "files_unsupported: {} answers for this request and can't receive files; Codex, Claude and OpenCode Agents can. \
                 Nothing was sent, and your message is kept.",
                name.unwrap_or_else(|| agent.clone())
            )));
        }
    }
    Ok(())
}

/// Why a message's files could not go to its Agent (YN-145): it takes no
/// files, or they could not be copied to it. Nothing was sent; `send` refuses
/// the message.
#[derive(Debug)]
pub(crate) struct FilesRefused(pub String);

impl std::fmt::Display for FilesRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "home_files: {}. Nothing was sent, and your message is kept.", self.0)
    }
}

impl std::error::Error for FilesRefused {}

/// The reason a refused message's files could not go, if that is why.
pub(crate) fn files_refused(error: &anyhow::Error) -> Option<&str> {
    let inner = error.downcast_ref::<MessageNotSubmitted>().map_or(error, |refused| &refused.0);
    inner.downcast_ref::<FilesRefused>().map(|refused| refused.0.as_str())
}

/// Gives `agent` its own copy of a new message's files (input_files::adopt),
/// when it takes files; refused (`FilesRefused`), nothing is sent.
pub(crate) async fn adopt_files(ws: &Workspace, project: &str, agent: &str, files: &[crate::input_files::FileRef]) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let refused = |reason: String| anyhow::Error::new(MessageNotSubmitted(anyhow::Error::new(FilesRefused(reason))));
    let to = agent.to_owned();
    let found = ws.stored(move |store| store.agent(&to)).await?;
    if !crate::input_files::takes_files(&found.harness) {
        return Err(refused(format!("{} can't receive files", found.name)));
    }
    // A remote Agent's files are copied to its own folder here and carried to
    // its machine at the send (F4); an OpenCode or dsh Agent cannot be on one,
    // so its files still make the hand-off go on without them.
    if found.remote.is_some() && !matches!(found.harness.as_str(), "codex" | "claude") {
        return Err(refused(format!(
            "{} is on another machine, where only Codex and Claude Agents can receive files",
            found.name
        )));
    }
    let (root, project, agent, files) = (ws.data_dir.clone(), project.to_owned(), agent.to_owned(), files.to_vec());
    tokio::task::spawn_blocking(move || crate::input_files::adopt(&root, &project, &agent, &files))
        .await?
        .map_err(|error| refused(error.to_string()))
}

/// Refuses a message with images when one of the Agents it goes to takes no
/// images (YN-134), read in the caller's transaction: nothing is kept or sent.
fn refuse_images(db: &Connection, to: &[String], images: &[String]) -> Result<()> {
    if images.is_empty() {
        return Ok(());
    }
    for agent in to {
        let (name, harness): (Option<String>, Option<String>) = db
            .query_row("SELECT json_extract(data,'$.agent.name'),json_extract(data,'$.agent.harness') FROM agents WHERE id=?1", [agent],
                |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .unwrap_or_default();
        // An Agent record without a harness is a Codex one (model::Agent).
        if !crate::input_images::takes_images(harness.as_deref().unwrap_or("codex")) {
            return Err(not_submitted(format!(
                "images_unsupported: {} answers for this request and can't receive images; Codex, Claude and OpenCode Agents can. \
                 Nothing was sent, and your message is kept.",
                name.unwrap_or_else(|| agent.clone())
            )));
        }
    }
    Ok(())
}

/// Why a message's images could not go to its Agent (YN-134): it takes no
/// images, or they could not be copied to it. Nothing was sent; `send`
/// refuses the message, and a route's hand-off sends the words without them.
#[derive(Debug)]
pub(crate) struct ImagesRefused(pub String);

impl std::fmt::Display for ImagesRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "home_images: {}. Nothing was sent, and your message is kept.", self.0)
    }
}

impl std::error::Error for ImagesRefused {}

/// The reason a refused message's images could not go, if that is why.
pub(crate) fn images_refused(error: &anyhow::Error) -> Option<&str> {
    let inner = error.downcast_ref::<MessageNotSubmitted>().map_or(error, |refused| &refused.0);
    inner.downcast_ref::<ImagesRefused>().map(|refused| refused.0.as_str())
}

/// Gives `agent` its own copy of a new message's images (input_images::adopt),
/// when it takes images; refused (`ImagesRefused`), nothing is sent. A dsh
/// whose initialize said it takes none (dsh_agent.rs §3.9) is refused here
/// too, so a hand-off goes on without them (YN-173).
pub(crate) async fn adopt_images(ws: &Workspace, project: &str, agent: &str, images: &[String]) -> Result<()> {
    if images.is_empty() {
        return Ok(());
    }
    let refused = |reason: String| anyhow::Error::new(MessageNotSubmitted(anyhow::Error::new(ImagesRefused(reason))));
    let to = agent.to_owned();
    let found = ws.stored(move |store| store.agent(&to)).await?;
    if !crate::input_images::takes_images(&found.harness) || (found.harness == "dsh" && ws.dsh_takes_images(agent) == Some(false)) {
        return Err(refused(format!("{} can't receive images", found.name)));
    }
    let (root, project, agent, images) = (ws.data_dir.clone(), project.to_owned(), agent.to_owned(), images.to_vec());
    tokio::task::spawn_blocking(move || crate::input_images::adopt(&root, &project, &agent, &images))
        .await?
        .map_err(|error| refused(error.to_string()))
}

/// One message: `head`, a blank line, then the user's `words` byte for byte,
/// their pasted blocks moved past the head, and the images they attached.
pub(crate) fn message(client: &str, head: &str, words: &str, blocks: Option<&[TextBlock]>, images: &[String], turn: Option<String>)
    -> MessageInput {
    let shift = head.encode_utf16().count() + 2;
    MessageInput {
        client_message_id: client.into(),
        text: format!("{head}\n\n{words}"),
        text_blocks: blocks.map(|blocks| {
            blocks.iter().map(|block| TextBlock { id: block.id.clone(), start: block.start + shift, end: block.end + shift }).collect()
        }),
        images: images.to_vec(),
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
    /// The images the user attached (YN-134), by ID; none for most.
    images: Vec<String>,
    /// The files the user attached (YN-145); none for most.
    files: Vec<crate::input_files::FileRef>,
    /// When the user last confirmed it done (YN-184), or None.
    confirmed_at: Option<String>,
}

const REQUEST: &str = "id,n,text,text_blocks,title,created_at,front_agent_id,message_id,state,images,files,confirmed_at";

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
        images: stored_images(r.get(9)?),
        files: stored_files(r.get(10)?),
        confirmed_at: r.get(11)?,
    })
}

/// Blocks as kept: what Core validated, so a row it cannot read is shown without them.
fn blocks(raw: Option<String>) -> Option<Vec<TextBlock>> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
}

fn kept_blocks(blocks: &Option<Vec<TextBlock>>) -> Result<Option<String>> {
    Ok(blocks.as_ref().map(serde_json::to_string).transpose()?)
}

/// Images as kept (YN-134): what Core checked, so a row it cannot read shows none.
fn stored_images(raw: Option<String>) -> Vec<String> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

/// NULL without images, as rows written before them.
fn kept_images(images: &[String]) -> Result<Option<String>> {
    Ok((!images.is_empty()).then(|| serde_json::to_string(images)).transpose()?)
}

/// Files as kept (YN-145): what Core checked, so a row it cannot read shows none.
fn stored_files(raw: Option<String>) -> Vec<crate::input_files::FileRef> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

/// NULL without files, as rows written before them.
fn kept_files(files: &[crate::input_files::FileRef]) -> Result<Option<String>> {
    Ok((!files.is_empty()).then(|| serde_json::to_string(files)).transpose()?)
}

/// The Workspace, and the Project's name and whether it is archived, for one message.
struct Place {
    workspace: String,
    name: String,
    archived: bool,
}

/// Read in the caller's transaction, never beside it.
fn place(db: &Connection, project: &str, words: &Words) -> Result<Place> {
    let place = place_of(db, project)?;
    if words.workspace_id != place.workspace {
        return Err(not_submitted(
            "workspace_changed: this message was begun on another Workspace's page. Nothing was sent, and your message is kept.".into(),
        ));
    }
    Ok(place)
}

/// The Workspace's ID and the Project's name and archived state, whatever Workspace a message was begun on.
fn place_of(db: &Connection, project: &str) -> Result<Place> {
    let workspace: String = db.query_row("SELECT value FROM workspace_meta WHERE key='workspaceId'", [], |r| r.get(0))?;
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
/// Agent is in now, its images first copied to the Agent (`adopt_images`,
/// YN-134; never again for a retry). Another message under that client ID,
/// one whose receipt names another `origin`, is not this one: refused,
/// nothing sent. Refused before it was sent, `Err` says so.
async fn send(ws: &Arc<Workspace>, project: &str, agent: &str, client: &str, files: &[crate::input_files::FileRef],
    files_may_differ: bool, origin: Value, compose: impl FnOnce(Option<String>) -> MessageInput) -> Result<MessageReceipt> {
    let (to, id) = (agent.to_owned(), client.to_owned());
    let wanted = files.to_vec();
    let (input, sent_files) = match ws.stored(move |store| store.receipt(&to, &id)).await? {
        // A retry is the same message: its words, images and files as they
        // were. A route's hand-off may have dropped its files on the first
        // try, so a route matches on its origin whatever files it carried,
        // and keeps the files that first message carried.
        Some(previous) if previous.origin.as_ref() == Some(&origin) && (files_may_differ || previous.files == wanted) =>
            (previous.input, previous.files),
        Some(_) => return Err(not_submitted("This clientMessageId was already used for another message. Nothing was sent.".into())),
        None => {
            let input = compose(follow_up_turn(&ws.send_view(agent).await.map_err(|error| not_submitted(error.to_string()))?));
            adopt_images(ws, project, agent, &input.images).await?;
            adopt_files(ws, project, agent, files).await?;
            (input, files.to_vec())
        }
    };
    ws.send_message_from(agent, input, Vec::new(), sent_files, Some(origin)).await
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
    check_images(ws, project, &words.images).await?;
    check_files(ws, project, &words.files).await?;
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
            ensure!(found.text == said.text && found.text_blocks == said.text_blocks && found.images == said.images
                && found.files == said.files, "This clientMessageId was already used for another message");
            return Ok((place, found));
        }
        refuse_archived(&place)?;
        let front = front_desk_now(&tx, &id)?;
        refuse_images(&tx, std::slice::from_ref(&front), &said.images)?;
        refuse_files(&tx, std::slice::from_ref(&front), &said.files)?;
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
            images: said.images,
            files: said.files,
            confirmed_at: None,
        };
        tx.execute(
            "INSERT INTO project_requests(id,project_id,n,text,text_blocks,created_at,front_agent_id,message_id,state,images,files)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![request.id, id, request.n, request.text, kept_blocks(&request.text_blocks)?, request.created_at,
                request.front_agent_id, request.message_id, request.state, kept_images(&request.images)?, kept_files(&request.files)?],
        )?;
        tx.commit()?;
        Ok((place, request))
    }).await?;
    let origin = json!({"kind":ORIGIN,"projectId":project,"requestId":request.id,"request":request.n,"workspaceId":place.workspace});
    // One a proposal opened (YN-237 ④), sent again from Home: its own head.
    let opened_from = ws.stored({
        let id = request.id.clone();
        move |store| from_of(&*store.db.read()?, &id)
    }).await?;
    let head = match &opened_from {
        Some(from) => proposal_head(&place.workspace, &place.name, project, request.n, from.n, &from.key),
        None => request_head(&place.workspace, &place.name, project, request.n),
    };
    let sent = send(ws, project, &request.front_agent_id, &request.message_id, &request.files, false, origin, |turn| {
        message(&request.message_id, &head, &request.text, request.text_blocks.as_deref(), &request.images, turn)
    }).await;
    match sent {
        Ok(receipt) => {
            announce(ws, project);
            let shown = ws.stored({
                let project = project.to_owned();
                move |store| view(&*store.db.read()?, &project, request, Installed::current().as_ref())
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

/// A request nothing was sent for: never kept. Not one with a follow-up, a
/// receipt of its message (`MINE`), or one a proposal opened (YN-237 ④: the
/// user's choice made it, and Home offers Send again).
fn forget_request(db: &Connection, id: &str, agent: &str, client: &str) -> Result<()> {
    db.execute(
        &format!("DELETE FROM project_requests WHERE id=?1
           AND NOT EXISTS(SELECT 1 FROM project_request_replies WHERE request_id=?1) AND from_request_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM agent_receipts WHERE agent_id=?2 AND client_id=?3 AND {MINE})"),
        params![id, agent, client, Option::<i64>::None],
    )?;
    Ok(())
}

/// Whether `project` has request R-`n` (a proposal names the one it was
/// made under: project_brief/update.rs `rules`).
pub(crate) fn has_request(db: &Connection, project: &str, n: i64) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM project_requests WHERE project_id=?1 AND n=?2)", params![project, n], |r| r.get(0))?)
}

/// A lead's proposal the user chose to make a request (YN-237 ④): the
/// request it was made under (`under`, R-n), the Ask by its identity on Home
/// (`identity`), the version answered and its key, and what the new request
/// says (`title`, `text`), as that version of the Ask had them.
#[derive(Clone, Debug)]
pub(crate) struct Proposal {
    pub under: i64,
    pub identity: i64,
    pub version: i64,
    pub key: String,
    pub title: String,
    pub text: String,
}

/// A request a proposal opened, as `keep_proposal` kept it, for `send_proposal`.
pub(crate) struct Opened {
    request: Request,
    under: i64,
    key: String,
    workspace: String,
    name: String,
}

impl Opened {
    pub(crate) fn n(&self) -> i64 {
        self.request.n
    }
}

/// The message ID of the request a proposal opens: one per Ask and version
/// answered, so the same reply again, its retry or another window's finds
/// the one request (UNIQUE(project_id, message_id)), never a second.
fn proposal_message(identity: i64, version: i64) -> String {
    format!("proposal:{identity}:{version}")
}

/// The words of the request a proposal opens, under its one message ID (`proposal_message`).
fn proposal_words(proposal: &Proposal) -> Words {
    Words {
        workspace_id: String::new(), text: proposal.text.clone(), text_blocks: None,
        client_message_id: proposal_message(proposal.identity, proposal.version), images: vec![], files: vec![],
    }
}

/// Where the request a proposal opens stands (YN-237 ④): kept before, or, to keep now, its front desk and the ID of
/// the request it was made under. Refused (`not_submitted`): the Project archived, no front desk, or the request it was
/// made under gone.
enum Opens {
    Kept(Request),
    New { front: String, under: String },
}

fn opening(db: &Connection, project: &str, place: &Place, proposal: &Proposal, message_id: &str) -> Result<Opens> {
    let found = db
        .query_row(&format!("SELECT {REQUEST} FROM project_requests WHERE project_id=?1 AND message_id=?2"),
            params![project, message_id], request_row)
        .optional()?;
    if let Some(found) = found {
        return Ok(Opens::Kept(found));
    }
    refuse_archived(place)?;
    let front = front_desk_now(db, project)?;
    let under: String = db
        .query_row("SELECT id FROM project_requests WHERE project_id=?1 AND n=?2", params![project, proposal.under], |r| r.get(0))
        .optional()?
        .ok_or_else(|| not_submitted(format!(
            "proposal_request_unknown: this Project no longer has request R-{}, which the proposal was made under. Nothing was sent.",
            proposal.under)))?;
    Ok(Opens::New { front, under })
}

/// Whether the request a proposal opens can be kept (YN-237 ④), checked on the user's "new" before the reply is sent
/// (project_brief/home.rs `ask_reply`), keeping nothing: refused as `keep_proposal` would be, and the reply then sends
/// nothing and is kept, so it never tells the lead of a request Core could not open.
pub(crate) async fn may_open(ws: &Arc<Workspace>, project: &str, proposal: &Proposal) -> Result<()> {
    let words = proposal_words(proposal);
    check(&words)?;
    let (id, wanted) = (project.to_owned(), proposal.clone());
    ws.stored(move |store| {
        let db = store.db.read()?;
        let place = place_of(&db, &id)?;
        opening(&db, &id, &place, &wanted, &words.client_message_id).map(drop)
    }).await
}

/// Keeps the request a proposal opens (YN-237 ④), once the user's "new" has
/// reached its lead (project_brief/home.rs `ask_reply`): a reply refused or
/// failed keeps nothing, so the user may answer again, "merge" or "later"
/// included, with no request left behind. The Project's next request, its
/// words the proposal's, its title the proposal's, its front desk the
/// Project's now, linked to the request it was made under. Kept once
/// (`proposal_message`): found again, it is returned as it was. Refused as
/// `may_open` is, keeping nothing.
pub(crate) async fn keep_proposal(ws: &Arc<Workspace>, project: &str, proposal: &Proposal) -> Result<Opened> {
    let words = proposal_words(proposal);
    check(&words)?;
    let gate = lock(ws, project).await;
    let _held = gate.lock().await;
    let (id, wanted) = (project.to_owned(), proposal.clone());
    let (workspace, name, request) = ws.stored(move |store| {
        let mut writer = store.db.write()?;
        let tx = writer.transaction()?;
        let place = place_of(&tx, &id)?;
        let (front, under) = match opening(&tx, &id, &place, &wanted, &words.client_message_id)? {
            Opens::Kept(found) => return Ok((place.workspace, place.name, found)),
            Opens::New { front, under } => (front, under),
        };
        let n: i64 = tx.query_row("SELECT COALESCE(MAX(n),0)+1 FROM project_requests WHERE project_id=?1", [&id], |r| r.get(0))?;
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(), n, text: words.text, text_blocks: None, title: Some(wanted.title.clone()),
            created_at: crate::model::now(), front_agent_id: front, message_id: words.client_message_id, state: "open".into(),
            images: vec![], files: vec![], confirmed_at: None,
        };
        tx.execute(
            "INSERT INTO project_requests(id,project_id,n,text,title,created_at,front_agent_id,message_id,state,
               from_request_id,from_section_id,from_version,from_key)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![request.id, id, request.n, request.text, request.title, request.created_at, request.front_agent_id, request.message_id,
                request.state, under, wanted.identity, wanted.version, wanted.key],
        )?;
        tx.commit()?;
        Ok((place.workspace, place.name, request))
    }).await?;
    announce(ws, project);
    Ok(Opened { request, under: proposal.under, key: proposal.key.clone(), workspace, name })
}

/// Sends the request a proposal opened to its front desk (YN-237 ④), after
/// the user's reply: its head, then the proposal's words. Sent again it is
/// the same message (`send`). Not sent now (the front desk closed, a Turn
/// refused it), the request stays kept, not confirmed delivered, and Home
/// offers Send again (`submit` with its words and message ID).
pub(crate) async fn send_proposal(ws: &Arc<Workspace>, project: &str, opened: Opened) -> Result<MessageReceipt> {
    let Opened { request, under, key, workspace, name } = opened;
    let origin = json!({"kind":ORIGIN,"projectId":project,"requestId":request.id,"request":request.n,"workspaceId":workspace});
    let head = proposal_head(&workspace, &name, project, request.n, under, &key);
    let sent = send(ws, project, &request.front_agent_id, &request.message_id, &[], false, origin, |turn| {
        message(&request.message_id, &head, &request.text, None, &[], turn)
    }).await;
    announce(ws, project);
    sent
}

/// Whether `agent` is an executor still waiting for its slot: it takes no
/// message from Home before it starts (executor_slots.rs `executor_slot_gate`),
/// only mail, which reaches it once it has.
pub(super) fn waits_for_slot(db: &Connection, agent: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM executor_slots WHERE agent_id=?1 AND state='waiting')", [agent], |r| r.get(0))?)
}

/// Who a follow-up goes to: the front desk as it is now, which replies for
/// the project (R-45, the user's choice on YN-233: only the front desk
/// replies to the user); the Agents answering for the request's cards are
/// its to ask (`follow_up_head`). None: refused as a request is.
fn follow_up_to(db: &Connection, project: &str) -> Result<Vec<String>> {
    Ok(vec![front_desk_now(db, project)?])
}

/// The request's tasks, each by its key, with the name of who answers for
/// it now ("" for none), in the order its routes came.
fn request_tasks(db: &Connection, request: &str) -> Result<Vec<(String, String)>> {
    progress::routed_tasks(db, request)?
        .into_iter()
        .map(|task| {
            let who = match crate::project_brief::responsible_agent(db, &task)? {
                Some(agent) => routes::agent(db, &agent)?["name"].as_str().unwrap_or_default().to_owned(),
                None => String::new(),
            };
            Ok((crate::collaboration_store::task_shown(db, &task), who))
        })
        .collect()
}

/// `POST /api/projects/{id}/requests/{n}/replies` (YN-86 §4.4): the user's
/// follow-up to request R-n, kept as they wrote it and sent to the front
/// desk (`follow_up_to`), under its client ID. The same clientMessageId again is the same follow-up, sent to the same
/// Agents; with other words it is refused. Refused before it was sent to
/// anyone, nothing is kept.
pub(crate) async fn follow_up(ws: &Arc<Workspace>, project: &str, n: i64, words: Words) -> Result<Value> {
    check(&words)?;
    check_images(ws, project, &words.images).await?;
    check_files(ws, project, &words.files).await?;
    let gate = lock(ws, project).await;
    let _held = gate.lock().await;
    let (id, said) = (project.to_owned(), words.clone());
    let (place, request, reply, tasks, desk) = ws.stored(move |store| {
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
            ensure!(found.text == said.text && found.text_blocks == said.text_blocks && found.images == said.images
                && found.files == said.files, "This clientMessageId was already used for another message");
            let (tasks, desk) = (request_tasks(&tx, &request.id)?, front_desk::in_project(&tx, &id)?.effective_agent_id);
            return Ok((place, request, found, tasks, desk));
        }
        refuse_archived(&place)?;
        let to = follow_up_to(&tx, &id)?;
        // Every Agent it goes to takes its images and files, or none is sent any of it.
        refuse_images(&tx, &to, &said.images)?;
        refuse_files(&tx, &to, &said.files)?;
        let m: i64 = tx.query_row("SELECT COALESCE(MAX(n),0)+1 FROM project_request_replies WHERE request_id=?1", [&request.id], |r| r.get(0))?;
        let reply = Reply { n: m, text: said.text, text_blocks: said.text_blocks, at: crate::model::now(), message_id: said.client_message_id,
            delivered_to: to, images: said.images, files: said.files };
        tx.execute(
            "INSERT INTO project_request_replies(request_id,n,text,text_blocks,at,message_id,delivered_to,images,files)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![request.id, reply.n, reply.text, kept_blocks(&reply.text_blocks)?, reply.at, reply.message_id,
                serde_json::to_string(&reply.delivered_to)?, kept_images(&reply.images)?, kept_files(&reply.files)?],
        )?;
        let (tasks, desk) = (request_tasks(&tx, &request.id)?, front_desk::in_project(&tx, &id)?.effective_agent_id);
        tx.commit()?;
        Ok((place, request, reply, tasks, desk))
    }).await?;
    let origin = json!({"kind":ORIGIN,"projectId":project,"requestId":request.id,"request":request.n,"reply":reply.n,"workspaceId":place.workspace});
    let mut receipts = Vec::new();
    for agent in &reply.delivered_to {
        let reads = (desk.as_deref() == Some(agent.as_str())).then_some(tasks.as_slice());
        let head = follow_up_head(&place.workspace, &place.name, project, request.n, reply.n, reads);
        let sent = send(ws, project, agent, &reply.message_id, &reply.files, false, origin.clone(), |turn| {
            message(&reply.message_id, &head, &reply.text, reply.text_blocks.as_deref(), &reply.images, turn)
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
    /// The images the user attached (YN-134), by ID.
    images: Vec<String>,
    /// The files the user attached (YN-145).
    files: Vec<crate::input_files::FileRef>,
}

const REPLY: &str = "n,text,text_blocks,at,message_id,delivered_to,images,files";

fn reply_row(r: &rusqlite::Row) -> rusqlite::Result<Reply> {
    Ok(Reply {
        n: r.get(0)?,
        text: r.get(1)?,
        text_blocks: blocks(r.get(2)?),
        at: r.get(3)?,
        message_id: r.get(4)?,
        delivered_to: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
        images: stored_images(r.get(6)?),
        files: stored_files(r.get(7)?),
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

/// A follow-up as the page reads it: each Agent it went to with how its
/// message stands and its name now ("" once deleted, R-45), which the page
/// shows in a tip, as the project's.
fn reply_view(db: &Connection, request: &str, reply: Reply) -> Result<Value> {
    let delivered_to = reply.delivered_to.iter()
        .map(|agent| {
            let name = routes::agent(db, agent)?["name"].clone();
            Ok(json!({"agentId":agent,"name":name,"delivery":delivery(db, request, agent, &reply.message_id, Some(reply.n))?}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"n":reply.n,"text":reply.text,"textBlocks":reply.text_blocks,"images":reply.images,"files":reply.files,"at":reply.at,
        "messageId":reply.message_id,"deliveredTo":delivered_to}))
}

/// A request as the Project's page reads it: the user's words and blocks as
/// kept, its title once the front desk gave it one, its message's delivery,
/// and its follow-ups, oldest first; then what routing made of it
/// (progress.rs): the front desk's notes, its routes, its cards and their
/// progress, and Core's lines for the conversation.
fn view(db: &Connection, project: &str, request: Request, installed: Option<&Installed>) -> Result<Value> {
    let replies = db
        .prepare_cached(&format!("SELECT {REPLY} FROM project_request_replies WHERE request_id=?1 ORDER BY n"))?
        .query_map([&request.id], reply_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|reply| reply_view(db, &request.id, reply))
        .collect::<Result<Vec<_>>>()?;
    let mut shown = json!({
        "id":request.id,"n":request.n,"text":request.text,"textBlocks":request.text_blocks,"images":request.images,"files":request.files,"title":request.title,
        "createdAt":request.created_at,"frontAgentId":request.front_agent_id,"messageId":request.message_id,
        "delivery":delivery(db, &request.id, &request.front_agent_id, &request.message_id, None)?,"replies":replies,
    });
    progress::show(db, project, &request.id, request.n, request.confirmed_at.as_deref(), installed, &mut shown)?;
    // YN-237 ④: the proposal it was opened from, if one was, and the requests opened from proposals made under it.
    shown["from"] = from_of(db, &request.id)?.map_or(Value::Null, |from| from.json());
    shown["proposals"] = json!(opened_under(db, &request.id)?.iter().map(Opening::json).collect::<Vec<_>>());
    Ok(shown)
}

/// One end of a proposal's link (YN-237 ④): the other request by number,
/// and the Ask it came from, by its key, identity on Home and the version
/// the user answered.
struct Opening {
    n: i64,
    key: String,
    section_id: Option<i64>,
    version: Option<i64>,
    at: String,
}

impl Opening {
    fn json(&self) -> Value {
        json!({"n":self.n,"key":self.key,"sectionId":self.section_id,"version":self.version,"at":self.at})
    }
}

/// The request `request` was opened from, if a proposal opened it.
fn from_of(db: &Connection, request: &str) -> Result<Option<Opening>> {
    Ok(db
        .query_row(
            "SELECT f.n,q.from_key,q.from_section_id,q.from_version,q.created_at FROM project_requests q
             JOIN project_requests f ON f.id=q.from_request_id WHERE q.id=?1",
            [request],
            |r| Ok(Opening { n: r.get(0)?, key: r.get::<_, Option<String>>(1)?.unwrap_or_default(), section_id: r.get(2)?, version: r.get(3)?,
                at: r.get(4)? }),
        )
        .optional()?)
}

/// The requests opened from proposals made under `request`, oldest first.
fn opened_under(db: &Connection, request: &str) -> Result<Vec<Opening>> {
    Ok(db
        .prepare_cached("SELECT n,from_key,from_section_id,from_version,created_at FROM project_requests WHERE from_request_id=?1 ORDER BY n")?
        .query_map([request], |r| {
            Ok(Opening { n: r.get(0)?, key: r.get::<_, Option<String>>(1)?.unwrap_or_default(), section_id: r.get(2)?, version: r.get(3)?,
                at: r.get(4)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// What the user's page sends to confirm a request done (YN-184).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Confirm {
    /// The Workspace whose page the user confirmed on.
    pub workspace_id: String,
}

/// `POST /api/projects/{id}/requests/{n}/confirm` (YN-184): the user
/// confirms that request R-n is done. Only while it waits for them (its
/// cards' tasks all ended, or answered with no card): Core keeps the time,
/// and the request is done until something changes after it (progress.rs).
/// Again once done, nothing changes. Only the user's page sends it
/// (`router`); no Agent tool reads or writes a confirmation.
pub(crate) async fn confirm(ws: &Arc<Workspace>, project: &str, n: i64, input: Confirm) -> Result<Value> {
    let id = project.to_owned();
    let (shown, kept) = ws.stored(move |store| {
        let mut writer = store.db.write()?;
        let tx = writer.transaction()?;
        let workspace: String = tx.query_row("SELECT value FROM workspace_meta WHERE key='workspaceId'", [], |r| r.get(0))?;
        ensure!(input.workspace_id == workspace, "workspace_changed: this page is another Workspace's. Nothing was confirmed.");
        let (name, archived) = crate::projects::project_labels(&tx)?.remove(&id).context("project_not_found: no Project has this ID")?;
        ensure!(!archived, "project_archived: {name} is archived; unarchive it to confirm its requests. Nothing was confirmed.");
        let request = tx
            .query_row(&format!("SELECT {REQUEST} FROM project_requests WHERE project_id=?1 AND n=?2"), params![id, n], request_row)
            .optional()?
            .with_context(|| format!("request_not_found: this Project has no request R-{n}. Nothing was confirmed."))?;
        let installed = Installed::current();
        let shown = view(&tx, &id, request.clone(), installed.as_ref())?;
        match shown["state"].as_str().unwrap_or_default() {
            "done" => return Ok((shown, false)),
            "ended" | "answered" => {}
            "doing" => anyhow::bail!("request_not_ready: R-{n} still has a card going on. Nothing was confirmed."),
            _ => anyhow::bail!("request_not_ready: R-{n} has no card or answer yet. Nothing was confirmed."),
        }
        let at = crate::model::now();
        tx.execute("UPDATE project_requests SET confirmed_at=?2 WHERE id=?1", params![request.id, at])?;
        let shown = view(&tx, &id, Request { confirmed_at: Some(at), ..request }, installed.as_ref())?;
        tx.commit()?;
        Ok((shown, true))
    }).await?;
    if kept {
        announce(ws, project);
    }
    Ok(json!({"request":shown}))
}

/// `GET /api/projects/{id}/requests?before=&limit=`: the Project's requests,
/// newest first, `limit` (at most 50, 20 by default) of those numbered
/// below `before`, against the release this Core runs (`page_for`); the
/// first page with the older ones it keeps (`kept`).
pub(crate) fn page(db: &Connection, project: &str, before: Option<i64>, limit: Option<usize>) -> Result<Value> {
    page_for(db, project, before, limit, Installed::current().as_ref())
}

/// The most requests a page lists (`page_for`), and the most older ones a
/// first page keeps beside its own (`kept`): a first read views at most
/// twice as many.
const PAGE_MAX: usize = 50;

/// `page` against `installed` (R-38 §2.6): `installedRelease`, the release
/// this Core runs (null for a source build), and `mergedAfterInstalled`, how
/// many PRs linked to the Project's tasks are merged and kept as not in it
/// (null without a release, or while any merged one is not known yet). Only
/// what Core keeps is read: never the network.
///
/// `kept` (YN-237): on the first page (no `before`) with more requests
/// below it, the older ones still going on or bound to a live card
/// (`kept_below`), newest first; none on another page. They are not the
/// page's: `hasMore` and the next page's `before` go by `requests` alone,
/// so a client that reads only `requests` pages as it always did.
pub(crate) fn page_for(db: &Connection, project: &str, before: Option<i64>, limit: Option<usize>, installed: Option<&Installed>)
    -> Result<Value> {
    crate::projects::ensure_exists(db, project)?;
    let limit = limit.unwrap_or(20).clamp(1, PAGE_MAX);
    let mut rows = db
        .prepare_cached(&format!("SELECT {REQUEST} FROM project_requests WHERE project_id=?1 AND n<?2 ORDER BY n DESC LIMIT ?3"))?
        .query_map(params![project, before.unwrap_or(i64::MAX), limit as i64 + 1], request_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let kept = match (before, rows.last()) {
        (None, Some(lowest)) if more => kept_below(db, project, lowest.n)?,
        _ => vec![],
    };
    let shown = |rows: Vec<Request>| rows.into_iter().map(|request| view(db, project, request, installed)).collect::<Result<Vec<_>>>();
    let (requests, kept) = (shown(rows)?, shown(kept)?);
    let after = match installed {
        Some(installed) => crate::github::installed::merged_after(db, project, installed)?,
        None => None,
    };
    Ok(json!({"requests":requests,"hasMore":more,"kept":kept,"installedRelease":installed.map(Installed::json),"mergedAfterInstalled":after}))
}

/// The requests numbered below `below` that the first page keeps beside its
/// own (YN-237: a card shows in its request's block whatever page that
/// request is on, and a request going on is always read), newest first, at
/// most PAGE_MAX: each routed to a task that has not ended (done, cancelled
/// or archived) or that a live section is the card of
/// (`project_brief::live_card_tasks`, an unresolved Ask outliving its task
/// among them); or routed nowhere yet and never confirmed, waiting for its
/// front desk. One that only waits for the user to confirm it, its tasks
/// ended and its cards gone, stays on its own page.
fn kept_below(db: &Connection, project: &str, below: i64) -> Result<Vec<Request>> {
    let bound: Vec<String> = crate::project_brief::live_card_tasks(db, project)?.into_iter().collect();
    Ok(db
        .prepare_cached(&format!(
            "SELECT {REQUEST} FROM project_requests q WHERE q.project_id=?1 AND q.n<?2 AND (
               EXISTS(SELECT 1 FROM project_routes r JOIN collaboration_tasks t ON t.id=r.task_id
                 WHERE r.request_id=q.id AND r.state='{done}' AND r.kind IN ('{card}','{existing}')
                 AND ((COALESCE(json_extract(t.data,'$.status'),'') NOT IN ('done','cancelled') AND json_extract(t.data,'$.archivedAt') IS NULL)
                   OR t.id IN (SELECT value FROM json_each(?3))))
               OR (q.confirmed_at IS NULL AND NOT EXISTS(SELECT 1 FROM project_routes r WHERE r.request_id=q.id AND r.state='{done}')))
             ORDER BY q.n DESC LIMIT ?4",
            done = routes::DONE, card = routes::CARD, existing = routes::EXISTING,
        ))?
        .query_map(params![project, below, serde_json::to_string(&bound)?, PAGE_MAX as i64], request_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The user's routes: on Core's own port and on the phone entry, as the rest
/// of Home. No Agent tool reads or writes them (the front desk routes with
/// project_route, routes.rs), and an Agent's credential (any Authorization
/// header) is refused: a card's reassignment is the user's alone, and so are
/// a request's confirmation (YN-184) and the images written on Home
/// (input_images.rs, YN-134).
pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/projects/{id}/front-desk", get(get_front_desk).put(put_front_desk))
        .route("/api/projects/{id}/images", post(crate::input_images::home_upload_route))
        .route("/api/projects/{id}/images/{image_id}", get(crate::input_images::home_read_route))
        .route("/api/projects/{id}/files", post(crate::input_files::home_upload_route))
        .route("/api/projects/{id}/files/{file_id}/{name}", get(crate::input_files::home_read_route))
        .route("/api/projects/{id}/requests", get(list).post(post_request))
        .route("/api/projects/{id}/requests/{n}/replies", post(post_reply))
        .route("/api/projects/{id}/requests/{n}/confirm", post(post_confirm))
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

async fn post_confirm(State(ws): State<Arc<Workspace>>, Path((id, n)): Path<(String, i64)>, Json(input): Json<Confirm>) -> ApiResult<Json<Value>> {
    Ok(Json(confirm(&ws, &id, n, input).await?))
}

#[cfg(test)]
#[path = "project_requests/tests.rs"]
mod tests;
