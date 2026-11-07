//! A Project's handover document (T-34, executor model phase 1;
//! docs/executor-model.md): what the Project already knows, in Markdown, for
//! an executor that starts cold. A dispatch from a template gives it to the
//! executor in its materials.
//!
//! A lead of the Project writes it with `handover_update` (handover_tools.rs,
//! YN-2 S3); the user reads it, sees who changed it last, and writes their own
//! through these browser routes. Each save is a row with who wrote it, when
//! and an optional note; the document is the latest row. Its number is an
//! internal revision, which a save is checked against and a retry answers
//! with, never shown as a version: no history is listed or restored (the
//! user's decision for YN-2 S3). The rows stay, as older Cores read them. A
//! Project's rows go with it.
use crate::{model::now, server::ApiError, store::Store, workspace::Workspace};
use anyhow::{ensure, Result};
use axum::{extract::{Path, State}, routing::get, Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const MAX_BYTES: usize = 32 * 1024;
/// A note with a save, in characters (YN-2 S3).
pub(crate) const MAX_NOTE: usize = 200;

/// Runs on every open, as `agent_roles` does: idempotent, not gated on a
/// schema number. Every Core enables foreign keys, so a deleted Project takes
/// its versions; the clean-up covers a manual edit without them.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_handover_versions(
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            version INTEGER NOT NULL, markdown TEXT NOT NULL,
            written_by TEXT NOT NULL, written_by_name TEXT NOT NULL,
            approved_by TEXT, reason TEXT, at TEXT NOT NULL,
            PRIMARY KEY(project_id, version));
        DELETE FROM project_handover_versions WHERE project_id NOT IN (SELECT id FROM projects);",
    )?;
    // The request a lead's write answers (YN-2 S3), so a retry gets the same
    // version. Older Cores name their columns, and leave it as it is.
    let has: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('project_handover_versions') WHERE name='request_id')", [], |r| r.get(0))?;
    if !has {
        db.execute_batch("ALTER TABLE project_handover_versions ADD COLUMN request_id TEXT")?;
    }
    db.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS project_handover_versions_request
        ON project_handover_versions(project_id, written_by, request_id) WHERE request_id IS NOT NULL")?;
    crate::handover_tools::migrate(db)
}

/// A new revision, as the user's save or a lead's write makes it; `note`
/// goes in the `reason` column older Cores read.
pub(crate) fn insert_version(db: &Connection, project: &str, version: i64, markdown: &str, written_by: &str, name: &str,
    reason: Option<&str>, request: Option<&str>) -> Result<()> {
    db.execute(
        "INSERT INTO project_handover_versions(project_id, version, markdown, written_by, written_by_name, approved_by, reason, at, request_id)
         VALUES(?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8)",
        params![project, version, markdown, written_by, name, reason, now(), request],
    )?;
    Ok(())
}

/// The first character a handover may not hold, by line and column (from
/// 1): anything below U+0020 but a line break (LF or CR, as pasted from
/// Windows) or a tab, and U+007F. Kept out, its JSON is at most twice its size.
fn first_control(markdown: &str) -> Option<(usize, usize, char)> {
    let (mut line, mut column) = (1, 0);
    for c in markdown.chars() {
        if c == '\n' {
            (line, column) = (line + 1, 0);
            continue;
        }
        column += 1;
        if (c < ' ' && !matches!(c, '\r' | '\t')) || c == '\u{7f}' {
            return Some((line, column, c));
        }
    }
    None
}

/// A document a save or a proposal may hold: at most 32 KiB of text.
pub(crate) fn check_markdown(markdown: &str) -> Result<()> {
    ensure!(markdown.len() <= MAX_BYTES, "A handover document is at most 32 KiB; this one is {} bytes", markdown.len());
    if let Some((line, column, c)) = first_control(markdown) {
        anyhow::bail!("A handover document is text: no control characters but line breaks and tabs; U+{:04X} at line {line}, column {column}", c as u32);
    }
    Ok(())
}

/// A save's note: at most 200 characters of text, with line breaks.
pub(crate) fn check_note(note: &str) -> Result<()> {
    ensure!(note.chars().count() <= MAX_NOTE && !note.chars().any(|c| c.is_control() && c != '\n'),
        "A note is at most {MAX_NOTE} characters of text");
    Ok(())
}

/// A note as given: trimmed, and none when empty.
pub(crate) fn note_of(note: Option<&str>) -> Result<Option<&str>> {
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    if let Some(note) = note {
        check_note(note)?;
    }
    Ok(note)
}

/// The document as a dispatch gives it: its version and text, or None while
/// the Project has none (or only an empty one).
pub(crate) fn current_in(db: &Connection, project: &str) -> Result<Option<(i64, String)>> {
    let latest: Option<(i64, String)> = db
        .query_row(
            "SELECT version, markdown FROM project_handover_versions WHERE project_id=?1 ORDER BY version DESC LIMIT 1",
            [project], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    Ok(latest.filter(|(_, markdown)| !markdown.trim().is_empty()))
}

/// Who wrote revision `version` of `project`'s document, when, and their
/// note; none for a revision there isn't.
pub(crate) fn modified(db: &Connection, project: &str, version: i64) -> Result<Option<Value>> {
    Ok(db.query_row(
        "SELECT written_by, written_by_name, at, reason FROM project_handover_versions WHERE project_id=?1 AND version=?2",
        params![project, version],
        |r| Ok(json!({"by": {"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?}, "at": r.get::<_, String>(2)?,
            "note": r.get::<_, Option<String>>(3)?})),
    ).optional()?)
}

/// The document as the user's page and handover_get read it: its text, its
/// revision (`version`: what a save is checked against) and who changed it
/// last (`lastModified`, none before the first save).
pub(crate) fn read_in(db: &Connection, project: &str) -> Result<Value> {
    crate::projects::ensure_exists(db, project)?;
    let latest: Option<(i64, String)> = db
        .query_row("SELECT version, markdown FROM project_handover_versions WHERE project_id=?1 ORDER BY version DESC LIMIT 1",
            [project], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let (version, markdown) = latest.unwrap_or_default();
    Ok(json!({
        "projectId": project,
        "version": version,
        "markdown": markdown,
        "lastModified": modified(db, project, version)?,
        "limit": MAX_BYTES,
    }))
}

impl Store {
    /// The document, its revision and who changed it last.
    pub(crate) fn handover(&self, project: &str) -> Result<Value> {
        read_in(&*self.db.read()?, project)
    }

    /// The user's save: a new revision, checked against the one read in the
    /// same transaction, with an optional note. An archived Project's
    /// document doesn't change.
    pub(crate) fn save_handover(&self, project: &str, expected: i64, markdown: &str, note: Option<&str>) -> Result<Value> {
        check_markdown(markdown)?;
        let note = note_of(note)?;
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        crate::projects::ensure_assignable(&tx, project)?;
        let current: i64 = tx.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM project_handover_versions WHERE project_id=?1", [project], |r| r.get(0))?;
        ensure!(current == expected, "version_conflict: this Project's handover changed; reload before saving");
        insert_version(&tx, project, current + 1, markdown, "user", "You", note, None)?;
        let saved = read_in(&tx, project)?;
        tx.commit()?;
        Ok(saved)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    expected_version: i64,
    markdown: String,
    /// `reason` from a page before YN-2 S3.
    #[serde(default, alias = "reason")]
    note: Option<String>,
}

async fn get_handover(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| s.handover(&id)).await?))
}

async fn put_handover(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<Save>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let project = id.clone();
    let saved = ws.stored(move |s| s.save_handover(&project, input.expected_version, &input.markdown, input.note.as_deref())).await?;
    ws.changes.send(json!({"handover": true, "projectId": id}));
    Ok(Json(saved))
}

/// The user's routes: browser routes, never a collaboration operation.
pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/projects/{id}/handover", get(get_handover).put(put_handover))
}

#[cfg(test)]
#[path = "handover_tests.rs"]
mod tests;
