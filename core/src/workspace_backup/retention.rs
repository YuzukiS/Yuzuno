//! What keeping only the latest backups in one folder would do (T-196,
//! slice 2): a preview, read only. Nothing is deleted and nothing is turned
//! on; there is no automatic clean-up.
//!
//! It looks only at the folder the user names, and only at its first-level
//! entries, without following links. Each folder with a manifest is read as
//! `read_manifest` reads one, nothing more: no backup's files are checked, so
//! a backup is never called verified here, and its size is the one its
//! manifest declares, an estimate. The newest backups of this Workspace are
//! kept; older ones could be removed, unless something protects them:
//! - a backup of another Workspace, one whose manifest can't be read, or one
//!   whose time can't be read is protected or unknown, never removable;
//! - a folder a running backup, check or restore uses, or one a running or
//!   interrupted operation was writing (`.name.partial-…`, `.restoring-…`);
//! - the only backup with a successful check on record, while none of those
//!   kept has one. A past check is a reason to keep a backup, not proof it is
//!   whole now.
//!
//! Only on Core's own port: it lists folders on the computer that runs Core.
use super::online::{self, Operation};
use crate::{server::ApiError, workspace::Workspace};
use anyhow::{ensure, Result};
use axum::{extract::State, routing::post, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

/// First-level entries looked at; the rest are counted, not read.
pub const MAX_ENTRIES: usize = 500;
/// A manifest larger than this is not read in a preview.
const MANIFEST_LIMIT: u64 = 4 * 1024 * 1024;
pub const MAX_KEEP: usize = 100;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    /// keep, remove, protected, unknown or ignored (not a backup).
    pub verdict: &'static str,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// As its manifest declares: an estimate, not a measurement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_bytes: Option<u64>,
    /// The last successful check of it this Core has on record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub folder: PathBuf,
    pub keep: usize,
    pub entries: Vec<Entry>,
    /// Entries beyond MAX_ENTRIES, not looked at.
    pub not_inspected: usize,
    /// What the removable ones' manifests declare.
    pub removable_estimate_bytes: u64,
}

fn entry(name: &str, path: PathBuf, verdict: &'static str, reason: impl Into<String>) -> Entry {
    Entry { name: name.into(), path, verdict, reason: reason.into(), workspace_id: None, created_at: None, estimate_bytes: None, last_checked_at: None }
}

fn same(value: &Value, path: &Path) -> bool {
    value.as_str().is_some_and(|text| Path::new(text) == path)
}

/// The preview of keeping the latest `keep` backups of Workspace `workspace`
/// in `folder`, given this Core's operations. Reads only.
pub fn preview(folder: &Path, keep: usize, workspace: &str, operations: &[Operation]) -> Result<Preview> {
    ensure!((1..=MAX_KEEP).contains(&keep), "Keep at least 1 and at most {MAX_KEEP} backups");
    ensure!(folder.is_absolute(), "The folder must be an absolute path on the computer that runs Core");
    let meta = fs::symlink_metadata(folder);
    ensure!(meta.as_ref().is_ok_and(|m| m.is_dir()), "{} is not a folder on the computer that runs Core (a link is not followed)", folder.display());
    let mut names: Vec<String> = Vec::new();
    let mut unreadable = 0usize;
    for item in fs::read_dir(folder)? {
        match item.ok().and_then(|item| item.file_name().into_string().ok()) {
            Some(name) => names.push(name),
            None => unreadable += 1,
        }
    }
    names.sort();
    let not_inspected = names.len().saturating_sub(MAX_ENTRIES) + unreadable;
    names.truncate(MAX_ENTRIES);

    let running: Vec<&Operation> = operations.iter().filter(|op| op.state == "running").collect();
    let used_by = |path: &Path| {
        running.iter().find(|op| {
            ["from", "path", "to"].iter().any(|key| same(&op.request[*key], path))
                || op.scratch.as_deref() == Some(path)
        }).map(|op| op.kind.clone())
    };
    let last_check = |path: &Path| {
        operations.iter()
            .filter(|op| op.kind == "check" && op.state == "succeeded" && same(&op.request["path"], path))
            .filter_map(|op| op.finished_at.clone())
            .max()
    };

    let mut entries = Vec::new();
    let mut candidates: Vec<(DateTime<Utc>, Entry)> = Vec::new();
    for name in &names {
        let path = folder.join(name);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            entries.push(entry(name, path, "unknown", "It can't be read"));
            continue;
        };
        if meta.file_type().is_symlink() {
            entries.push(entry(name, path, "unknown", "A link; not followed"));
            continue;
        }
        if !meta.is_dir() {
            entries.push(entry(name, path, "ignored", "Not a folder, so not a backup"));
            continue;
        }
        if name.starts_with('.') && (name.contains(".partial-") || name.contains(".restoring-")) {
            entries.push(entry(name, path, "protected", "Written by a backup or restore that is running or was interrupted; left alone"));
            continue;
        }
        if let Some(kind) = used_by(&path) {
            entries.push(entry(name, path, "protected", format!("A running {kind} uses it")));
            continue;
        }
        let manifest = path.join(super::MANIFEST);
        match fs::symlink_metadata(&manifest) {
            Err(_) => {
                entries.push(entry(name, path, "ignored", "No manifest.json, so not a Workspace backup"));
                continue;
            }
            Ok(m) if !m.is_file() || m.len() > MANIFEST_LIMIT => {
                entries.push(entry(name, path, "unknown", "Its manifest is not a file of at most 4 MiB, so it was not read"));
                continue;
            }
            Ok(_) => {}
        }
        let read = match super::read_manifest(&path) {
            Ok(read) => read,
            Err(error) => {
                entries.push(entry(name, path, "unknown", format!("Its manifest can't be read: {error:#}")));
                continue;
            }
        };
        let mut found = entry(name, path.clone(), "unknown", "");
        found.workspace_id = Some(read.workspace_id.clone());
        found.created_at = Some(read.created_at.clone());
        found.estimate_bytes = Some(read.database.bytes.saturating_add(read.files.iter().map(|f| f.bytes).sum::<u64>()));
        found.last_checked_at = last_check(&path);
        if read.workspace_id != workspace {
            found.verdict = "protected";
            found.reason = "A backup of another Workspace".into();
            entries.push(found);
            continue;
        }
        match DateTime::parse_from_rfc3339(&read.created_at) {
            Ok(at) => candidates.push((at.with_timezone(&Utc), found)),
            Err(_) => {
                found.reason = "Its time can't be read, so its place among the latest is unknown".into();
                entries.push(found);
            }
        }
    }

    // Newest first; the same time by name, newest name first.
    candidates.sort_by(|(a, x), (b, y)| b.cmp(a).then_with(|| y.name.cmp(&x.name)));
    let kept_checked = candidates.iter().take(keep).any(|(_, e)| e.last_checked_at.is_some());
    let mut protected_checked = kept_checked;
    for (index, (_, mut found)) in candidates.into_iter().enumerate() {
        if index < keep {
            found.verdict = "keep";
            found.reason = format!("One of the latest {keep}");
        } else if !protected_checked && found.last_checked_at.is_some() {
            found.verdict = "protected";
            found.reason = "The only backup with a successful check on record; kept until one of the latest is checked".into();
            protected_checked = true;
        } else {
            found.verdict = "remove";
            found.reason = format!("Older than the latest {keep}");
        }
        entries.push(found);
    }
    let removable_estimate_bytes = entries.iter().filter(|e| e.verdict == "remove").filter_map(|e| e.estimate_bytes).sum();
    Ok(Preview { folder: folder.into(), keep, entries, not_inspected, removable_estimate_bytes })
}

/// The preview route: on Core's own port only.
pub fn changes() -> Router<Arc<Workspace>> {
    Router::new().route("/api/workspace/backup/retention/preview", post(preview_route))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewRequest {
    folder: String,
    keep: usize,
}

async fn preview_route(State(ws): State<Arc<Workspace>>, Json(body): Json<PreviewRequest>) -> Result<Json<Preview>, ApiError> {
    let folder = online::absolute("folder", &body.folder)?;
    let workspace = ws.stored(|store| store.workspace_id()).await?;
    let operations = ws.backups.all();
    let answer = tokio::task::spawn_blocking(move || preview(&folder, body.keep, &workspace, &operations)).await?;
    // The reason travels with the refusal: the page shows it as it is.
    Ok(Json(answer.map_err(|error| anyhow::anyhow!("{error:#}"))?))
}
