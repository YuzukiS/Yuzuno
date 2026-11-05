//! A lead's proposal for its Project's handover document (T-34 S3b;
//! docs/executor-model.md). A lead of the Project proposes a whole new
//! document with `handover_propose`; nothing is written until the user
//! approves it on Home. Approved, it is a normal version written by the
//! proposer and approved by the user; rejected, nothing changes. Either way
//! one mail tells the proposer, with the user's note.
//!
//! A Project has at most one pending proposal. A lead's new proposal
//! supersedes its own pending one, which stays as `superseded`; another
//! lead's is refused until the user decides. While a proposal waits, Home's
//! Needs you lists it as a `handover` item named by its proposer.
use crate::{
    handover::{check_markdown, check_text, read_in},
    model::now,
    project_brief,
    server::ApiError,
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Context, Result};
use axum::{extract::{Path, State}, Json};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// With the versions' table (handover::migrate): idempotent, on every open.
/// One pending proposal per Project, and one proposal per proposer and
/// requestId; a deleted Project's proposals go with it.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_handover_proposals(
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            proposer_id TEXT NOT NULL, proposer_name TEXT NOT NULL,
            base_version INTEGER NOT NULL, markdown TEXT NOT NULL, reason TEXT,
            request_id TEXT NOT NULL, created_at TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','superseded')),
            decided_at TEXT, decision_request_id TEXT, note TEXT, version INTEGER);
        CREATE UNIQUE INDEX IF NOT EXISTS project_handover_proposals_pending
            ON project_handover_proposals(project_id) WHERE state='pending';
        CREATE UNIQUE INDEX IF NOT EXISTS project_handover_proposals_request
            ON project_handover_proposals(proposer_id, request_id);
        DELETE FROM project_handover_proposals WHERE project_id NOT IN (SELECT id FROM projects);",
    )?;
    Ok(())
}

struct Proposal {
    id: String,
    project: String,
    proposer_id: String,
    proposer_name: String,
    base_version: i64,
    markdown: String,
    reason: Option<String>,
    created_at: String,
    state: String,
    decided_at: Option<String>,
    decision_request: Option<String>,
    note: Option<String>,
    version: Option<i64>,
}

const COLUMNS: &str = "id, project_id, proposer_id, proposer_name, base_version, markdown, reason, created_at, state,
    decided_at, decision_request_id, note, version";

fn row(r: &Row) -> rusqlite::Result<Proposal> {
    Ok(Proposal {
        id: r.get(0)?, project: r.get(1)?, proposer_id: r.get(2)?, proposer_name: r.get(3)?, base_version: r.get(4)?,
        markdown: r.get(5)?, reason: r.get(6)?, created_at: r.get(7)?, state: r.get(8)?, decided_at: r.get(9)?,
        decision_request: r.get(10)?, note: r.get(11)?, version: r.get(12)?,
    })
}

fn find(db: &Connection, project: &str, id: &str) -> Result<Option<Proposal>> {
    Ok(db.query_row(&format!("SELECT {COLUMNS} FROM project_handover_proposals WHERE project_id=?1 AND id=?2"),
        params![project, id], row).optional()?)
}

fn pending(db: &Connection, project: &str) -> Result<Option<Proposal>> {
    Ok(db.query_row(&format!("SELECT {COLUMNS} FROM project_handover_proposals WHERE project_id=?1 AND state='pending'"),
        [project], row).optional()?)
}

/// A proposal as a list shows it: who, on which version, why and what became
/// of it; the text only where it is asked for.
fn summary(p: &Proposal) -> Value {
    json!({"id": p.id, "projectId": p.project, "proposer": {"id": p.proposer_id, "name": p.proposer_name},
        "baseVersion": p.base_version, "reason": p.reason, "bytes": p.markdown.len(), "at": p.created_at,
        "state": p.state, "decidedAt": p.decided_at, "note": p.note, "version": p.version})
}

fn current_version(db: &Connection, project: &str) -> Result<i64> {
    Ok(db.query_row("SELECT COALESCE(MAX(version), 0) FROM project_handover_versions WHERE project_id=?1",
        [project], |r| r.get(0))?)
}

/// The pending proposal of `project`, as Home and the settings page show it.
pub(crate) fn pending_summary(db: &Connection, project: &str) -> Result<Option<Value>> {
    Ok(pending(db, project)?.map(|p| summary(&p)))
}

/// Every pending proposal, as push notifications name it (T-200): never its text.
pub(crate) struct Waiting {
    pub project: String,
    pub id: String,
    pub proposer_name: String,
}

pub(crate) fn waiting(store: &Store) -> Result<Vec<Waiting>> {
    let db = store.db.read()?;
    let mut query = db.prepare(
        "SELECT project_id, id, proposer_name FROM project_handover_proposals
         WHERE state='pending' AND project_id IN (SELECT id FROM projects) ORDER BY created_at")?;
    let rows = query.query_map([], |r| Ok(Waiting { project: r.get(0)?, id: r.get(1)?, proposer_name: r.get(2)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ---- The Agent tools ----

pub(crate) fn tool_definition(name: &str) -> Value {
    let project = json!({"type":"string","description":"Project ID from projects_list. Omit for your own Project."});
    let (description, properties, required): (&str, Value, &[&str]) = match name {
        "handover_get" => (
            "Read your Project's handover document (T-34): the Markdown a dispatch from an executor template gives its executor, its version, the latest versions' authors and reasons, and the proposal waiting for the user, if any. For members of the Project.",
            json!({"projectId": project}),
            &[],
        ),
        "handover_propose" => (
            "Propose a whole new handover document for your Project, against the version you read (handover_get). For leads of the Project only. It writes nothing: the user approves or rejects it on Home, and one mail tells you which, with the user's note. A Project has one pending proposal; your new one replaces your own pending one.",
            json!({"requestId":{"type":"string","maxLength":128},"projectId":project,
                "expectedVersion":{"type":"integer","minimum":0,"description":"The version handover_get returned."},
                "markdown":{"type":"string","description":"The whole document, at most 32 KiB: text with line breaks and tabs, no other control characters."},
                "reason":{"type":"string","description":"Why this change, at most 1,000 bytes; the user sees it with the proposal."}}),
            &["requestId", "expectedVersion", "markdown"],
        ),
        _ => panic!("unknown handover tool {name}"),
    };
    json!({"name":name,"description":description,
        "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
}

pub async fn call(ws: Arc<Workspace>, actor: Option<String>, operation: String, input: Value) -> Result<Value> {
    ensure!(input.is_object(), "invalid_input: expected an object");
    match operation.as_str() {
        "handover_get" => ws.stored(move |store| get(store, actor.as_deref(), &input)).await,
        "handover_propose" => {
            let actor = actor.context("agent_only: handover_propose is for a Project's leads; the user changes the handover in the Project's settings")?;
            let permit = ws.admission.enter_work()?;
            let (store, ws2) = (ws.store.clone(), ws.clone());
            // A dropped MCP request still completes the proposal and its announcement together.
            tokio::spawn(async move {
                let _permit = permit;
                let (answer, project) = crate::db::blocking(move || propose(&store, &actor, &input)).await?;
                project_brief::announce(&ws2, Some(&project));
                Ok(answer)
            }).await.context("The handover proposal ended unexpectedly")?
        }
        _ => bail!("unknown_operation: {operation}"),
    }
}

fn allowed(input: &Value, keys: &[&str]) -> Result<()> {
    if let Some(key) = input.as_object().into_iter().flat_map(|o| o.keys()).find(|k| !keys.contains(&k.as_str())) {
        bail!("invalid_input: unknown field {key}");
    }
    Ok(())
}

/// `projectId`, or the caller's own Project.
fn project_of(db: &Connection, actor: Option<&str>, input: &Value) -> Result<String> {
    if let Some(project) = input.get("projectId").and_then(Value::as_str) {
        return Ok(project.to_owned());
    }
    let actor = actor.context("invalid_input: name the projectId")?;
    db.query_row("SELECT project_id FROM project_agents WHERE agent_id=?1", [actor], |r| r.get(0)).optional()?
        .context("not_member: you are in no Project; name the projectId")
}

fn member(db: &Connection, agent: &str, project: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM project_agents WHERE agent_id=?1 AND project_id=?2)",
        params![agent, project], |r| r.get(0))?)
}

fn get(store: &Store, actor: Option<&str>, input: &Value) -> Result<Value> {
    allowed(input, &["projectId"])?;
    let db = store.db.read()?;
    let project = project_of(&db, actor, input)?;
    crate::projects::ensure_exists(&db, &project)?;
    if let Some(actor) = actor {
        ensure!(member(&db, actor, &project)?, "not_member: only a member of this Project reads its handover");
    }
    let mut answer = read_in(&db, &project, None)?;
    answer["proposal"] = json!(pending_summary(&db, &project)?);
    Ok(answer)
}

/// The lead `actor`'s proposal, in one transaction with its checks. Returns
/// the answer and the Project to announce.
fn propose(store: &Store, actor: &str, input: &Value) -> Result<(Value, String)> {
    allowed(input, &["requestId", "projectId", "expectedVersion", "markdown", "reason"])?;
    let request = input.get("requestId").and_then(Value::as_str).filter(|r| !r.is_empty() && r.len() <= 128)
        .context("invalid_input: requestId is required, at most 128 characters")?;
    let expected = input.get("expectedVersion").and_then(Value::as_i64).context("invalid_input: expectedVersion is required")?;
    let markdown = input.get("markdown").and_then(Value::as_str).context("invalid_input: markdown is required")?;
    let reason = input.get("reason").and_then(Value::as_str).map(str::trim).filter(|r| !r.is_empty());
    check_markdown(markdown)?;
    if let Some(reason) = reason {
        check_text(reason, "A reason")?;
    }
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    let project = project_of(&tx, Some(actor), input)?;
    let answer = |p: &Proposal| json!({"proposal": summary(p),
        "writes": "Nothing until the user approves it on Home; one mail tells you the decision."});
    // A retry with the same requestId: the same proposal, as it is now.
    let earlier: Option<Proposal> = tx.query_row(
        &format!("SELECT {COLUMNS} FROM project_handover_proposals WHERE proposer_id=?1 AND request_id=?2"),
        params![actor, request], row).optional()?;
    if let Some(earlier) = earlier {
        ensure!(earlier.project == project && earlier.base_version == expected && earlier.markdown == markdown
            && earlier.reason.as_deref() == reason, "idempotency_conflict: requestId already has a different payload");
        return Ok((answer(&earlier), project));
    }
    crate::projects::ensure_assignable(&tx, &project)?;
    ensure!(crate::agent_roles::leads(&tx, actor, &project)?,
        "not_lead: only a lead of this Project proposes a handover; the user changes it in the Project's settings");
    let current = current_version(&tx, &project)?;
    ensure!(current == expected,
        "version_conflict: this Project's handover is at version {current}, not {expected}; read it again with handover_get and propose on version {current}");
    if let Some(held) = pending(&tx, &project)? {
        ensure!(held.proposer_id == actor,
            "proposal_pending: {}'s proposal from {} waits for the user's decision; propose again once it is decided",
            held.proposer_name, held.created_at);
        tx.execute("UPDATE project_handover_proposals SET state='superseded', decided_at=?2 WHERE id=?1",
            params![held.id, now()])?;
    }
    let name = crate::collaboration_store::agent_actor(store, &tx, actor)?.name;
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO project_handover_proposals(id, project_id, proposer_id, proposer_name, base_version, markdown, reason,
            request_id, created_at, state) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')",
        params![id, project, actor, name, current, markdown, reason, request, now()],
    )?;
    let made = find(&tx, &project, &id)?.context("the proposal just made")?;
    tx.commit()?;
    Ok((answer(&made), project))
}

// ---- The user's routes ----

/// One proposal, with the text it would replace, for the user's decision.
pub(crate) fn detail(store: &Store, project: &str, id: &str) -> Result<Value> {
    let db = store.db.read()?;
    crate::projects::ensure_exists(&db, project)?;
    let p = find(&db, project, id)?.context("proposal_not_found: this Project has no such handover proposal")?;
    let base: String = db.query_row(
        "SELECT markdown FROM project_handover_versions WHERE project_id=?1 AND version=?2",
        params![project, p.base_version], |r| r.get(0)).optional()?.unwrap_or_default();
    let current = current_version(&db, project)?;
    let mut shown = summary(&p);
    shown["markdown"] = json!(p.markdown);
    Ok(json!({"proposal": shown, "base": {"version": p.base_version, "markdown": base},
        "currentVersion": current, "stale": current != p.base_version}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Decision {
    request_id: String,
    action: String,
    expected_version: i64,
    #[serde(default)]
    note: Option<String>,
}

/// The mail a decision sends its proposer.
struct Mail {
    to: (String, String),
    body: String,
    metadata: Value,
}

/// The user's decision on proposal `id`, checked against both the document
/// and the proposal in one transaction: the document is still the version
/// the user read (`expectedVersion`), and, to approve, still the version the
/// proposal was made on; the proposal is still pending. A retry with the same
/// requestId gets the same answer.
fn decide(store: &Store, project: &str, id: &str, input: &Decision) -> Result<(Value, Option<Mail>)> {
    ensure!(!input.request_id.is_empty() && input.request_id.len() <= 128, "invalid_input: requestId is required, at most 128 characters");
    let approve = match input.action.as_str() {
        "approve" => true,
        "reject" => false,
        other => bail!("invalid_input: action is approve or reject, not {other}"),
    };
    let note = input.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if let Some(note) = note {
        check_text(note, "A note")?;
    }
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    crate::projects::ensure_exists(&tx, project)?;
    let p = find(&tx, project, id)?.context("proposal_not_found: this Project has no such handover proposal")?;
    let decided = |p: &Proposal, tx: &Connection| -> Result<Value> {
        let mut answer = json!({"proposal": summary(p)});
        answer["handover"] = read_in(tx, project, None)?;
        Ok(answer)
    };
    if p.decision_request.as_deref() == Some(input.request_id.as_str()) {
        ensure!(p.state == if approve { "approved" } else { "rejected" }, "idempotency_conflict: requestId already has a different payload");
        return Ok((decided(&p, &tx)?, None));
    }
    match p.state.as_str() {
        "pending" => {}
        "superseded" => bail!("proposal_superseded: {} replaced this proposal with a newer one; decide on that one", p.proposer_name),
        state => bail!("proposal_decided: this proposal was already {state}"),
    }
    let current = current_version(&tx, project)?;
    ensure!(current == input.expected_version,
        "version_conflict: this Project's handover changed after you read the proposal; reload it before deciding");
    let project_name: String = tx.query_row("SELECT json_extract(data,'$.name') FROM projects WHERE id=?1", [project], |r| r.get(0))?;
    let said = note.map(|n| format!("\n\nTheir note: {n}")).unwrap_or_default();
    let (state, version, body) = if approve {
        ensure!(current == p.base_version,
            "version_conflict: the handover changed since this proposal (made on version {}, now version {current}); nothing was written. Reject it to tell {} to propose again on version {current}",
            p.base_version, p.proposer_name);
        crate::projects::ensure_assignable(&tx, project)?;
        let version = current + 1;
        tx.execute(
            "INSERT INTO project_handover_versions(project_id, version, markdown, written_by, written_by_name, approved_by, reason, at)
             VALUES(?1, ?2, ?3, ?4, ?5, 'user', ?6, ?7)",
            params![project, version, p.markdown, p.proposer_id, p.proposer_name, p.reason, now()],
        )?;
        ("approved", Some(version), format!(
            "The user approved your handover proposal {} for the Project {project_name}: it is version {version} of the handover now.{said}", p.id))
    } else {
        let again = if current != p.base_version {
            format!(" It was made on version {}; read the handover again with handover_get and propose on version {current} if the change is still needed.", p.base_version)
        } else {
            String::new()
        };
        ("rejected", None, format!(
            "The user rejected your handover proposal {} for the Project {project_name}; the handover stays at version {current}.{again}{said}", p.id))
    };
    tx.execute(
        "UPDATE project_handover_proposals SET state=?2, decided_at=?3, decision_request_id=?4, note=?5, version=?6 WHERE id=?1",
        params![p.id, state, now(), input.request_id, note, version],
    )?;
    let after = find(&tx, project, id)?.context("the proposal just decided")?;
    let answer = decided(&after, &tx)?;
    let mail = Mail { to: (p.proposer_id.clone(), p.proposer_name.clone()), body,
        metadata: json!({"kind":"handover","name":project_name,"status":state,"projectId":project,"proposalId":p.id}) };
    send(&tx, &mail)?;
    tx.commit()?;
    Ok((answer, Some(mail)))
}

/// One mail from Core to the proposer, in the decision's transaction.
fn send(db: &Connection, mail: &Mail) -> Result<()> {
    let id = uuid::Uuid::new_v4().to_string();
    crate::collaboration_store::insert_message(db, json!({"id":id,"seq":0,
        "sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
        "recipient":{"kind":"agent","id":mail.to.0,"name":mail.to.1},"body":mail.body,"taskId":null,
        "replyTo":null,"threadId":id,"createdAt":now(),"priority":"normal","source":{"handoverProposal":mail.metadata["proposalId"]},
        "metadata":mail.metadata}))?;
    Ok(())
}

pub(crate) async fn get_proposal(State(ws): State<Arc<Workspace>>, Path((project, id)): Path<(String, String)>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| detail(s, &project, &id)).await?))
}

pub(crate) async fn post_decision(State(ws): State<Arc<Workspace>>, Path((project, id)): Path<(String, String)>,
    Json(input): Json<Decision>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let at = project.clone();
    let (answer, mail) = ws.stored(move |s| decide(s, &at, &id, &input)).await?;
    if mail.is_some() {
        ws.collaboration_wakeup.notify_one();
        let _ = ws.changes.send(json!({"collaboration":true,"tasks":false}));
    }
    project_brief::announce(&ws, Some(&project));
    Ok(Json(answer))
}

#[cfg(test)]
#[path = "handover_proposals_tests.rs"]
mod tests;
