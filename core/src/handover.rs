//! A Project's handover document (T-34, executor model phase 1;
//! docs/executor-model.md): what the Project already knows, in Markdown, for
//! an executor that starts cold. A dispatch from a template gives it to the
//! executor in its materials.
//!
//! Each save is a new version, kept with who wrote it, who approved it and
//! why; the document is the latest version. Here only the user writes it,
//! through these browser routes; a lead's proposal that the user approves
//! comes next (S3b). A Project's versions go with it.
use crate::{model::now, server::ApiError, store::Store, workspace::Workspace};
use anyhow::{ensure, Result};
use axum::{extract::{Path, Query, State}, routing::get, Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const MAX_BYTES: usize = 32 * 1024;
const MAX_REASON: usize = 1_000;
/// Versions a read lists; older ones stay, readable by their number.
const HISTORY: i64 = 50;

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

fn version_of(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let markdown: String = row.get(2)?;
    Ok(json!({"version": row.get::<_, i64>(0)?, "writtenBy": {"id": row.get::<_, String>(1)?, "name": row.get::<_, String>(3)?},
        "approvedBy": row.get::<_, Option<String>>(4)?, "reason": row.get::<_, Option<String>>(5)?, "at": row.get::<_, String>(6)?,
        "bytes": markdown.len(), "markdown": markdown}))
}

const COLUMNS: &str = "version, written_by, markdown, written_by_name, approved_by, reason, at";

/// The document and its history, or one past version of it.
fn read_in(db: &Connection, project: &str, version: Option<i64>) -> Result<Value> {
    crate::projects::ensure_exists(db, project)?;
    if let Some(version) = version {
        let past = db
            .query_row(&format!("SELECT {COLUMNS} FROM project_handover_versions WHERE project_id=?1 AND version=?2"),
                params![project, version], version_of)
            .optional()?;
        let past = past.ok_or_else(|| anyhow::anyhow!("version_not_found: this Project's handover has no version {version}"))?;
        return Ok(json!({"projectId": project, "past": past}));
    }
    let mut query = db.prepare(&format!(
        "SELECT {COLUMNS} FROM project_handover_versions WHERE project_id=?1 ORDER BY version DESC LIMIT ?2"))?;
    let mut history: Vec<Value> = query.query_map(params![project, HISTORY], version_of)?.collect::<rusqlite::Result<_>>()?;
    let current = history.first().cloned();
    // The list says who wrote each version and why; the text is the current one's.
    for entry in &mut history {
        entry.as_object_mut().unwrap().remove("markdown");
    }
    Ok(json!({
        "projectId": project,
        "version": current.as_ref().map_or(0, |c| c["version"].as_i64().unwrap_or(0)),
        "markdown": current.as_ref().map_or(json!(""), |c| c["markdown"].clone()),
        "history": history,
        "limit": MAX_BYTES,
    }))
}

impl Store {
    pub(crate) fn handover(&self, project: &str, version: Option<i64>) -> Result<Value> {
        read_in(&*self.db.read()?, project, version)
    }

    /// The user's save: a new version, checked against the version read in
    /// the same transaction. An archived Project's document doesn't change.
    pub(crate) fn save_handover(&self, project: &str, expected: i64, markdown: &str, reason: Option<&str>) -> Result<Value> {
        ensure!(markdown.len() <= MAX_BYTES, "A handover document is at most 32 KiB; this one is {} bytes", markdown.len());
        if let Some((line, column, c)) = first_control(markdown) {
            anyhow::bail!("A handover document is text: no control characters but line breaks and tabs; U+{:04X} at line {line}, column {column}", c as u32);
        }
        let reason = reason.map(str::trim).filter(|r| !r.is_empty());
        if let Some(reason) = reason {
            ensure!(reason.len() <= MAX_REASON && !reason.chars().any(|c| c.is_control() && c != '\n'),
                "A reason is at most {MAX_REASON} bytes of text");
        }
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        crate::projects::ensure_assignable(&tx, project)?;
        let current: i64 = tx.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM project_handover_versions WHERE project_id=?1", [project], |r| r.get(0))?;
        ensure!(current == expected, "version_conflict: this Project's handover changed; reload before saving");
        tx.execute(
            "INSERT INTO project_handover_versions(project_id, version, markdown, written_by, written_by_name, approved_by, reason, at)
             VALUES(?1, ?2, ?3, 'user', 'You', NULL, ?4, ?5)",
            params![project, current + 1, markdown, reason, now()],
        )?;
        let saved = read_in(&tx, project, None)?;
        tx.commit()?;
        Ok(saved)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    #[serde(default)]
    version: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    expected_version: i64,
    markdown: String,
    #[serde(default)]
    reason: Option<String>,
}

async fn get_handover(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Query(read): Query<Read>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| s.handover(&id, read.version)).await?))
}

async fn put_handover(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<Save>) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let project = id.clone();
    let saved = ws.stored(move |s| s.save_handover(&project, input.expected_version, &input.markdown, input.reason.as_deref())).await?;
    ws.changes.send(json!({"handover": true, "projectId": id}));
    Ok(Json(saved))
}

/// The user's routes: a browser route, never a collaboration operation.
pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/projects/{id}/handover", get(get_handover).put(put_handover))
}

#[cfg(test)]
#[path = "handover_tests.rs"]
mod tests;
