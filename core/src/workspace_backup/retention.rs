//! What keeping only the latest backups in one folder would do (T-196,
//! slice 2): a preview, read only; and (slice 3) removing one old backup the
//! user confirmed, which Core judges again itself. Nothing is turned on and
//! nothing removes backups on its own.
//!
//! It looks only at the folder the user names, and only at its first-level
//! entries, without following links; a folder with more than `MAX_ENTRIES`
//! entries is refused before more names are read. Each folder with a manifest is read as
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
//! Removing one (`remove`) is an operation like a backup: idempotent by its
//! requestId, one at a time. It does not trust the page's preview: it judges
//! the folder again, refuses a backup whose manifest changed since the
//! preview, and reads another backup of this Workspace back whole (`verify`)
//! before anything is removed. The backup is moved aside first
//! (`.name.removing-<id>`) and then removed; a removal that fails or is cut
//! off says what is left, is never finished or repeated on its own, and
//! can't be undone.
//!
//! Only on Core's own port: it lists folders on the computer that runs Core.
use super::online::{self, Operation};
use super::Control;
use crate::{server::ApiError, workspace::Workspace};
use anyhow::{bail, ensure, Result};
use axum::{extract::State, response::Response, routing::post, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

/// First-level entries a folder may have; one with more is refused.
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
    /// Of its manifest as read: a removal names it, and is refused if it changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_sha256: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub folder: PathBuf,
    pub keep: usize,
    pub entries: Vec<Entry>,
    /// Names that are not UTF-8: counted, not judged.
    pub unreadable_names: usize,
    /// What the removable ones' manifests declare.
    pub removable_estimate_bytes: u64,
}

fn entry(name: &str, path: PathBuf, verdict: &'static str, reason: impl Into<String>) -> Entry {
    Entry { name: name.into(), path, verdict, reason: reason.into(), workspace_id: None, created_at: None, estimate_bytes: None, last_checked_at: None, manifest_sha256: None }
}

fn same(value: &Value, path: &Path) -> bool {
    value.as_str().is_some_and(|text| Path::new(text) == path)
}

/// The preview of keeping the latest `keep` backups of Workspace `workspace`
/// in `folder`, given this Core's operations. Reads only.
pub fn preview(folder: &Path, keep: usize, workspace: &str, operations: &[Operation]) -> Result<Preview> {
    preview_within(folder, keep, workspace, operations, MAX_ENTRIES)
}

pub(crate) fn preview_within(folder: &Path, keep: usize, workspace: &str, operations: &[Operation], limit: usize) -> Result<Preview> {
    ensure!((1..=MAX_KEEP).contains(&keep), "Keep at least 1 and at most {MAX_KEEP} backups");
    ensure!(folder.is_absolute(), "The folder must be an absolute path on the computer that runs Core");
    let meta = fs::symlink_metadata(folder);
    ensure!(meta.as_ref().is_ok_and(|m| m.is_dir()), "{} is not a folder on the computer that runs Core (a link is not followed)", folder.display());
    let mut names: Vec<String> = Vec::new();
    let mut unreadable_names = 0usize;
    for (count, item) in fs::read_dir(folder)?.enumerate() {
        ensure!(count < limit, "{} has more than {limit} entries; choose a folder that holds only backups", folder.display());
        match item.ok().and_then(|item| item.file_name().into_string().ok()) {
            Some(name) => names.push(name),
            None => unreadable_names += 1,
        }
    }
    names.sort();

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
        if name.starts_with('.') && name.contains(".removing-") {
            entries.push(entry(name, path, "protected", "Left by a removal that did not finish; left alone"));
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
        found.manifest_sha256 = super::hash_file(&manifest).ok().map(|(_, sha256)| sha256);
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
    Ok(Preview { folder: folder.into(), keep, entries, unreadable_names, removable_estimate_bytes })
}

/// The backup `name` in `folder`, judged again now: it must still be one
/// keeping the latest `keep` could remove, with the manifest it had in the
/// preview. The folder must have been read whole.
pub(crate) fn judge(folder: &Path, keep: usize, name: &str, manifest_sha256: &str, workspace: &str, operations: &[Operation], limit: usize) -> Result<(Preview, Entry)> {
    let preview = preview_within(folder, keep, workspace, operations, limit)?;
    ensure!(preview.unreadable_names == 0, "{} has names that can't be read, so it can't be judged whole", folder.display());
    let Some(target) = preview.entries.iter().find(|e| e.name == name).cloned() else {
        bail!("{name} is no longer in {}", folder.display());
    };
    ensure!(target.verdict == "remove", "{name} is not one that could be removed now: {}", target.reason);
    ensure!(target.manifest_sha256.as_deref() == Some(manifest_sha256), "{name} changed since the preview; preview again");
    Ok((preview, target))
}

/// Removes the backup `name` from `folder`, as the user confirmed: judged
/// again, after another backup of this Workspace there was read back whole.
/// Stop works until the removal itself begins.
pub(crate) fn remove(folder: &Path, keep: usize, name: &str, manifest_sha256: &str, workspace: &str, operations: impl Fn() -> Vec<Operation>, ctl: &Control, limit: usize) -> Result<Value> {
    ctl.at("preview")?;
    let (preview, target) = judge(folder, keep, name, manifest_sha256, workspace, &operations(), limit)?;
    let mut failures = Vec::new();
    let mut checked = None;
    for kept in preview.entries.iter().filter(|e| e.verdict == "keep") {
        ctl.at("verify")?;
        match super::verify(&kept.path) {
            Ok(_) => {
                checked = Some(kept.clone());
                break;
            }
            Err(error) => failures.push(format!("{}: {error:#}", kept.name)),
        }
    }
    let Some(checked) = checked else {
        bail!("No other backup of this Workspace in {} could be read back whole just now ({}); nothing was removed",
            folder.display(), if failures.is_empty() { "none is kept".into() } else { failures.join("; ") });
    };
    // Again, right before: the folder may have changed while the other backup was read.
    ctl.at("recheck")?;
    judge(folder, keep, name, manifest_sha256, workspace, &operations(), limit)?;
    ctl.at("remove")?;
    let aside = folder.join(format!(".{name}.removing-{}", ctl.id));
    fs::rename(&target.path, &aside).map_err(|error| anyhow::anyhow!("Cannot move {name} aside to remove it; nothing was removed: {error}"))?;
    if let Err(error) = fs::remove_dir_all(&aside) {
        bail!("{name} was partly removed; what is left is {}, and it is left as it is: {error}", aside.display());
    }
    Ok(json!({
        "removed": target.path,
        "name": name,
        "backedUpAt": target.created_at,
        "freedEstimateBytes": target.estimate_bytes,
        "keptChecked": checked.path,
        "keptCheckedName": checked.name,
    }))
}

/// The preview route: on Core's own port only.
pub fn changes() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/workspace/backup/retention/preview", post(preview_route))
        .route("/api/workspace/backup/retention/remove", post(remove_route))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveRequest {
    request_id: String,
    folder: String,
    keep: usize,
    name: String,
    manifest_sha256: String,
}

/// Removes one backup the user confirmed. A request the folder as it is now
/// does not allow is refused at once; one it allows starts the operation,
/// which judges again before it removes anything. A request already made
/// gets its operation back (or a conflict), whatever the folder holds now.
async fn remove_route(State(ws): State<Arc<Workspace>>, Json(body): Json<RemoveRequest>) -> Result<Response, ApiError> {
    let folder = online::absolute("folder", &body.folder)?;
    let workspace = ws.stored(|store| store.workspace_id()).await?;
    let operations = ws.backups.all();
    if !operations.iter().any(|op| op.request_id == body.request_id) {
        let (f, n, h, w) = (folder.clone(), body.name.clone(), body.manifest_sha256.clone(), workspace.clone());
        let judged = tokio::task::spawn_blocking(move || judge(&f, body.keep, &n, &h, &w, &operations, MAX_ENTRIES)).await?;
        if let Err(error) = judged {
            return Err(anyhow::anyhow!("{error:#}; nothing was removed").into());
        }
    }
    let request = json!({"folder": folder, "keep": body.keep, "name": body.name, "manifestSha256": body.manifest_sha256});
    let backups = ws.backups.clone();
    let (name, sha256) = (body.name.clone(), body.manifest_sha256.clone());
    Ok(online::started(ws.backups.start("remove", &body.request_id, request, |_| None, move |ctl| {
        remove(&folder, body.keep, &name, &sha256, &workspace, || backups.all(), ctl, MAX_ENTRIES)
    })))
}
