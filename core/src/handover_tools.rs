//! The Agent tools for a Project's handover document (T-34; YN-2 S3;
//! docs/executor-model.md): `handover_get`, for the Project's members, and
//! `handover_update`, for its leads, which saves the whole document at once
//! with the lead's name and an optional note. The Project's settings show
//! the user who changed it last (handover.rs). An executor reads the document
//! in its materials and with `handover_get`.
//!
//! Before YN-2 S3 a lead proposed a version for the user to approve on Home
//! (`project_handover_proposals`). The table is kept as it is, for older
//! Cores. At open, a proposal still waiting (from before, or one an older
//! Core took since) is superseded, and its lead, if open, gets one mail with
//! its text, to write it with handover_update if it is still needed.
use crate::{
    handover::{check_markdown, modified, note_of, read_in},
    model::now,
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Arc;

/// With the versions' table (handover::migrate): idempotent, on every open.
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
    settle_waiting(db)
}

/// The note a superseded proposal keeps.
const SUPERSEDED: &str = "Leads write the handover directly now (handover_update); this proposal was not applied.";

/// Each proposal still waiting is superseded, and its lead, if open, is
/// told so in one mail with the proposal's text. In one transaction.
fn settle_waiting(db: &Connection) -> Result<()> {
    let waiting: Vec<(String, String, String, String, String, String)> = db
        .prepare("SELECT id, project_id, proposer_id, proposer_name, created_at, markdown FROM project_handover_proposals WHERE state='pending'")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if waiting.is_empty() {
        return Ok(());
    }
    let tx = db.unchecked_transaction()?;
    for (id, project, proposer, proposer_name, created, markdown) in waiting {
        tx.execute("UPDATE project_handover_proposals SET state='superseded', decided_at=?2, note=?3 WHERE id=?1 AND state='pending'",
            params![id, now(), SUPERSEDED])?;
        let open: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND json_extract(data,'$.agent.closedAt') IS NULL)", [&proposer], |r| r.get(0))?;
        if !open {
            continue;
        }
        let name: String = tx.query_row("SELECT json_extract(data,'$.name') FROM projects WHERE id=?1", [&project], |r| r.get(0))?;
        let body = format!(
            "Your handover proposal {id} for the Project {name}, from {created}, was not applied: leads write the handover directly now, \
             with handover_update, and the user no longer approves it. If it is still needed, read the handover with handover_get \
             and write it with handover_update. Your proposal's text:\n\n{markdown}");
        let mail_id = uuid::Uuid::new_v4().to_string();
        crate::collaboration_store::insert_message(&tx, json!({"id":mail_id,"seq":0,
            "sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
            "recipient":{"kind":"agent","id":proposer,"name":proposer_name},"body":body,"taskId":null,
            "replyTo":null,"threadId":mail_id,"createdAt":now(),"priority":"normal","source":{"handoverProposal":id},
            "metadata":{"kind":"handover","name":name,"status":"superseded","projectId":project,"proposalId":id}}))?;
    }
    tx.commit()?;
    Ok(())
}

pub(crate) fn current_version(db: &Connection, project: &str) -> Result<i64> {
    Ok(db.query_row("SELECT COALESCE(MAX(version), 0) FROM project_handover_versions WHERE project_id=?1",
        [project], |r| r.get(0))?)
}

// ---- The Agent tools ----

pub(crate) fn tool_definition(name: &str) -> Value {
    let project = json!({"type":"string","description":"Project ID from projects_list. Omit for your own Project."});
    let (description, properties, required): (&str, Value, &[&str]) = match name {
        "handover_get" => (
            "Read your Project's handover document: the Markdown an executor of the Project starts with, its version (pass it to handover_update as expectedVersion), who changed it last, when and with what note (lastModified), and canWrite: whether you may write it (a lead of the Project). For members of the Project.",
            json!({"projectId": project}),
            &[],
        ),
        "handover_update" => (
            "Write your Project's handover document, against the version you read (handover_get): a write on a document that changed meanwhile is refused. For leads of the Project only; executors and other members read it. It is saved at once, and every executor dispatched from then on gets it; no one approves it. The Project's settings show the user who changed it last, when, and your note. Write the whole document: what an executor that starts cold must know of the Project.",
            json!({"requestId":{"type":"string","maxLength":128},"projectId":project,
                "expectedVersion":{"type":"integer","minimum":0,"description":"The version handover_get returned."},
                "markdown":{"type":"string","description":"The whole document, at most 32 KiB: text with line breaks and tabs, no other control characters."},
                "note":{"type":"string","description":"Optional: what changed, at most 200 characters; the user sees it with your change."},
                "reason":{"type":"string","description":"The older name of note; give one of them."}}),
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
        "handover_update" => {
            let actor = actor.context("agent_only: handover_update is for a Project's leads; the user changes the handover in the Project's settings")?;
            let permit = ws.admission.enter_work()?;
            let (store, ws2) = (ws.store.clone(), ws.clone());
            // A dropped MCP request still completes the write and its announcement together.
            tokio::spawn(async move {
                let _permit = permit;
                let (answer, project) = crate::db::blocking(move || update(&store, &actor, &input)).await?;
                ws2.changes.send(json!({"handover": true, "projectId": project}));
                Ok(answer)
            }).await.context("The handover write ended unexpectedly")?
        }
        // A client that still lists the tool from before YN-2 S3.
        "handover_propose" => bail!("tool_replaced: handover_propose was replaced by handover_update: a lead of the Project writes the handover directly, and no one approves it. Read it with handover_get first"),
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

/// Whether `agent` may write `project`'s handover now: it leads it, and the
/// Project is not archived.
fn may_write(db: &Connection, agent: &str, project: &str) -> Result<bool> {
    Ok(crate::agent_roles::leads(db, agent, project)? && !crate::projects::is_archived(db, project)?)
}

fn get(store: &Store, actor: Option<&str>, input: &Value) -> Result<Value> {
    allowed(input, &["projectId"])?;
    let db = store.db.read()?;
    let project = project_of(&db, actor, input)?;
    crate::projects::ensure_exists(&db, &project)?;
    if let Some(actor) = actor {
        ensure!(member(&db, actor, &project)?, "not_member: only a member of this Project reads its handover");
    }
    let mut answer = read_in(&db, &project)?;
    answer["canWrite"] = json!(match actor {
        Some(actor) => may_write(&db, actor, &project)?,
        None => false,
    });
    Ok(answer)
}

/// The lead `actor`'s new version, in one transaction with its checks.
/// Returns the answer and the Project to announce.
fn update(store: &Store, actor: &str, input: &Value) -> Result<(Value, String)> {
    allowed(input, &["requestId", "projectId", "expectedVersion", "markdown", "note", "reason"])?;
    let request = input.get("requestId").and_then(Value::as_str).filter(|r| !r.is_empty() && r.len() <= 128)
        .context("invalid_input: requestId is required, at most 128 characters")?;
    let expected = input.get("expectedVersion").and_then(Value::as_i64).context("invalid_input: expectedVersion is required")?;
    let markdown = input.get("markdown").and_then(Value::as_str).context("invalid_input: markdown is required")?;
    // `reason` is the older name of `note` (YN-2 S3); both may be given only alike.
    let (note, reason) = (input.get("note").and_then(Value::as_str), input.get("reason").and_then(Value::as_str));
    ensure!(note.is_none() || reason.is_none() || note == reason, "invalid_input: give note, or reason, its older name; not both");
    let note = note_of(note.or(reason))?;
    check_markdown(markdown)?;
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    let project = project_of(&tx, Some(actor), input)?;
    crate::projects::ensure_exists(&tx, &project)?;
    let answer = |tx: &Connection, version: i64| -> Result<Value> {
        Ok(json!({"projectId": project, "version": version, "lastModified": modified(tx, &project, version)?,
            "currentVersion": current_version(tx, &project)?,
            "saved": "Saved. The Project's settings show the user who changed it last, when, and your note."}))
    };
    // A retry with the same requestId: the same version, as it is now.
    let earlier: Option<(i64, String, Option<String>)> = tx.query_row(
        "SELECT version, markdown, reason FROM project_handover_versions WHERE project_id=?1 AND written_by=?2 AND request_id=?3",
        params![project, actor, request], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
    if let Some((version, saved, saved_reason)) = earlier {
        ensure!(saved == markdown && saved_reason.as_deref() == note, "idempotency_conflict: requestId already has a different payload");
        return Ok((answer(&tx, version)?, project));
    }
    crate::projects::ensure_assignable(&tx, &project)?;
    ensure!(crate::agent_roles::leads(&tx, actor, &project)?,
        "not_lead: only a lead of this Project writes its handover; read it with handover_get, and tell a lead or the user what it should say");
    let current = current_version(&tx, &project)?;
    ensure!(current == expected,
        "version_conflict: this Project's handover is at version {current}, not {expected}; read it again with handover_get and write on version {current}");
    let name = crate::collaboration_store::agent_actor(store, &tx, actor)?.name;
    crate::handover::insert_version(&tx, &project, current + 1, markdown, actor, &name, note, Some(request))?;
    let written = answer(&tx, current + 1)?;
    tx.commit()?;
    Ok((written, project))
}

#[cfg(test)]
#[path = "handover_tools_tests.rs"]
mod tests;
