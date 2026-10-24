//! Backups and restores a running Core makes from Settings (T-192, slice 2).
//!
//! Each is an operation with an id, a kind (backup, check, restore), a state
//! (running, succeeded, failed, stopped, interrupted) and the step it reached.
//! It is idempotent by its requestId: the same request returns the same
//! operation, a different one under the same id is refused, and only one runs
//! at a time. Operations are kept in `backup-operations.json` in the
//! Workspace folder (never in a backup). One a stopped Core left running is
//! interrupted when Core next starts, and the folder it was writing beside
//! its destination is removed.
//!
//! Changes are made only on Core's own port (`changes`); the phone entry reads
//! (`router`). Nothing here replaces or switches the running Workspace, or
//! starts a Core on a restored copy: a restore writes a new or empty folder,
//! and its result says how to use it and what it does not have.
use super::{Control, Stopped};
use crate::{server::ApiError, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{Path as UrlPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// The journal's name in the Workspace folder.
pub const JOURNAL: &str = "backup-operations.json";
/// Finished operations kept in the journal.
const KEEP: usize = 20;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub request_id: String,
    pub kind: String,
    pub state: String,
    pub step: String,
    pub request: Value,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub result: Option<Value>,
    /// The folder written beside the destination while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch: Option<PathBuf>,
}

pub struct Backups {
    file: PathBuf,
    state: Mutex<Vec<Operation>>,
    running: Mutex<Option<(String, Arc<Control>)>>,
}

/// Why an operation was not started.
#[derive(Debug)]
pub enum Refusal {
    Busy(String),
    Conflict,
    Invalid(anyhow::Error),
}

impl Backups {
    /// Reads the journal in `data`. An operation a stopped Core left running
    /// is interrupted, and the folder it was writing is removed.
    pub fn open(data: &Path) -> Self {
        let file = data.join(JOURNAL);
        let mut operations: Vec<Operation> = std::fs::read(&file).ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let mut changed = false;
        for op in operations.iter_mut().filter(|op| op.state == "running") {
            if let Some(scratch) = op.scratch.take() {
                let ours = scratch.file_name().and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with('.') && n.ends_with(&format!("-{}", op.id)));
                if ours && std::fs::symlink_metadata(&scratch).is_ok_and(|m| m.is_dir()) {
                    let _ = std::fs::remove_dir_all(&scratch);
                }
            }
            op.state = "interrupted".into();
            op.error = Some("Core stopped while this ran; nothing it was writing was kept".into());
            op.finished_at = Some(now());
            changed = true;
        }
        let backups = Self { file, state: Mutex::new(operations), running: Mutex::new(None) };
        if changed {
            let _ = backups.save();
        }
        backups
    }

    fn save(&self) -> Result<()> {
        let operations = self.state.lock().unwrap().clone();
        crate::updates::package::atomic_json(&self.file, &operations)
    }

    /// The operation with this id, its step read live while it runs.
    pub fn get(&self, id: &str) -> Option<Operation> {
        let mut op = self.state.lock().unwrap().iter().find(|op| op.id == id).cloned()?;
        if let Some((running, ctl)) = &*self.running.lock().unwrap() {
            if *running == op.id {
                op.step = ctl.step().into();
            }
        }
        Some(op)
    }

    pub fn recent(&self) -> Vec<Operation> {
        let ids: Vec<String> = self.state.lock().unwrap().iter().rev().take(10).map(|op| op.id.clone()).collect();
        ids.iter().filter_map(|id| self.get(id)).collect()
    }

    pub fn current(&self) -> Option<Operation> {
        let id = self.running.lock().unwrap().as_ref().map(|(id, _)| id.clone())?;
        self.get(&id)
    }

    /// Asks the running operation `id` to stop; it stops at its next step or file.
    pub fn stop(&self, id: &str) -> bool {
        match &*self.running.lock().unwrap() {
            Some((running, ctl)) if running == id => {
                ctl.stop();
                true
            }
            _ => false,
        }
    }

    /// Starts `work` as a new operation, or returns the one this request
    /// already started. `scratch` is where it will write beside its
    /// destination, named after the operation (see Control::named).
    pub fn start(
        self: &Arc<Self>,
        kind: &str,
        request_id: &str,
        request: Value,
        scratch: impl FnOnce(&str) -> Option<PathBuf>,
        work: impl FnOnce(&Control) -> Result<Value> + Send + 'static,
    ) -> Result<Operation, Refusal> {
        let valid = !request_id.is_empty() && request_id.len() <= 128 && !request_id.chars().any(char::is_control);
        if !valid {
            return Err(Refusal::Invalid(anyhow::anyhow!("requestId must be 1 to 128 characters")));
        }
        let ctl;
        let op = {
            let mut running = self.running.lock().unwrap();
            let mut state = self.state.lock().unwrap();
            if let Some(same) = state.iter().find(|op| op.request_id == request_id) {
                return if same.kind == kind && same.request == request { Ok(same.clone()) } else { Err(Refusal::Conflict) };
            }
            if let Some((id, _)) = &*running {
                return Err(Refusal::Busy(id.clone()));
            }
            let id = uuid::Uuid::new_v4().simple().to_string();
            let op = Operation {
                scratch: scratch(&id),
                id: id.clone(),
                request_id: request_id.into(),
                kind: kind.into(),
                state: "running".into(),
                step: "start".into(),
                request,
                started_at: now(),
                finished_at: None,
                error: None,
                result: None,
            };
            state.push(op.clone());
            let finished: Vec<usize> = state.iter().enumerate().filter(|(_, op)| op.state != "running").map(|(i, _)| i).collect();
            if finished.len() > KEEP {
                let old: std::collections::BTreeSet<usize> = finished[..finished.len() - KEEP].iter().copied().collect();
                let mut index = 0;
                state.retain(|_| {
                    let keep = !old.contains(&index);
                    index += 1;
                    keep
                });
            }
            ctl = Arc::new(Control::named(&id));
            *running = Some((id, ctl.clone()));
            op
        };
        if let Err(error) = self.save() {
            self.finish(&op.id, Err(error.context("Cannot record the operation")));
            return Err(Refusal::Invalid(anyhow::anyhow!("Cannot record the operation in {}", self.file.display())));
        }
        let backups = self.clone();
        let id = op.id.clone();
        tokio::task::spawn_blocking(move || {
            let outcome = work(&ctl);
            backups.finish(&id, outcome);
        });
        Ok(op)
    }

    fn finish(&self, id: &str, outcome: Result<Value>) {
        let step = self.running.lock().unwrap().as_ref().filter(|(r, _)| r == id).map(|(_, ctl)| ctl.step().to_owned());
        {
            let mut state = self.state.lock().unwrap();
            if let Some(op) = state.iter_mut().find(|op| op.id == id) {
                if let Some(step) = step {
                    op.step = step;
                }
                op.finished_at = Some(now());
                op.scratch = None;
                match outcome {
                    Ok(result) => {
                        op.state = "succeeded".into();
                        op.result = Some(result);
                    }
                    Err(error) => {
                        op.state = if error.chain().any(|e| e.is::<Stopped>()) { "stopped" } else { "failed" }.into();
                        op.error = Some(format!("{error:#}"));
                    }
                }
            }
        }
        let mut running = self.running.lock().unwrap();
        if running.as_ref().is_some_and(|(r, _)| r == id) {
            *running = None;
        }
        drop(running);
        let _ = self.save();
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// An absolute path given by a client, as a path on the Core host.
fn absolute(field: &str, value: &str) -> Result<PathBuf> {
    ensure!(!value.is_empty() && value.len() <= 4096 && !value.contains('\0'), "{field} must name a folder on the computer that runs Core");
    let path = PathBuf::from(value);
    ensure!(path.is_absolute(), "{field} must be an absolute path on the computer that runs Core");
    Ok(path)
}

/// Where an operation named `id` writes beside `target`.
fn scratch_beside(target: &Path, kind: &str, id: &str) -> Option<PathBuf> {
    let (parent, full) = super::beside(target).ok()?;
    let name = full.file_name()?.to_str()?.to_owned();
    Some(parent.join(format!(".{name}.{kind}-{id}")))
}

/// The read-only routes, on Core's port and the phone entry.
pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/workspace/backup", get(status))
        .route("/api/workspace/backup/operations/{id}", get(operation))
}

/// The routes that start or stop work: on Core's own port only.
pub fn changes() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/workspace/backups", post(start_backup))
        .route("/api/workspace/backups/check", post(start_check))
        .route("/api/workspace/restore/precheck", post(precheck))
        .route("/api/workspace/restores", post(start_restore))
        .route("/api/workspace/backup/operations/{id}/stop", post(stop))
}

/// Whether a backup can start now, and why not; the size it will roughly
/// be; the running operation and the recent ones. `canChange` is false
/// through the phone entry, which may only read.
async fn status(State(ws): State<Arc<Workspace>>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let can_change = !headers.contains_key("tailscale-user-login");
    let data = ws.data_dir.clone();
    let checks = ws.stored(move |store| {
        let db = store.db.read()?;
        Ok((super::wal_only(&db).is_ok(), super::unfinished_jobs(&db)?, store.workspace_id()?))
    }).await?;
    let (wal, unfinished, workspace_id) = checks;
    let estimate = tokio::task::spawn_blocking(move || estimate(&data)).await??;
    let mut refusals = Vec::new();
    if !wal {
        refusals.push(json!({"code":"no_wal","detail":super::NO_WAL}));
    }
    if !unfinished.is_empty() {
        refusals.push(json!({"code":"unfinished_jobs","detail":format!("{} Job(s) have not ended; back up once they have", unfinished.len())}));
    }
    let current = ws.backups.current();
    if let Some(op) = &current {
        refusals.push(json!({"code":"busy","detail":format!("A {} is running", op.kind)}));
    }
    Ok(Json(json!({
        "canChange": can_change,
        "workspaceId": workspace_id,
        "canBackUp": refusals.is_empty(),
        "refusals": refusals,
        "unfinishedJobs": unfinished.iter().map(|(id, name)| json!({"id":id,"name":name})).collect::<Vec<_>>(),
        "estimateBytes": estimate,
        "current": current,
        "recent": ws.backups.recent(),
        "notCovered": super::NOT_COVERED,
        "replaceRunningWorkspace": "Replacing the Workspace this Core uses needs Core stopped; it is not offered here",
    })))
}

/// Roughly what a backup holds: the database and Core's own folders.
fn estimate(data: &Path) -> Result<u64> {
    fn size(path: &Path) -> u64 {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_file() => meta.len(),
            Ok(meta) if meta.is_dir() => std::fs::read_dir(path).map(|entries| {
                entries.filter_map(|e| e.ok()).map(|e| size(&e.path())).sum()
            }).unwrap_or(0),
            _ => 0,
        }
    }
    Ok(size(&data.join(super::DATABASE)) + super::INCLUDED.iter().map(|folder| size(&data.join(folder))).sum::<u64>())
}

async fn operation(State(ws): State<Arc<Workspace>>, UrlPath(id): UrlPath<String>) -> Response {
    match ws.backups.get(&id) {
        Some(op) => Json(op).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error":"No such backup operation"}))).into_response(),
    }
}

fn started(result: Result<Operation, Refusal>) -> Response {
    match result {
        Ok(op) => (StatusCode::ACCEPTED, Json(json!({"operation": op}))).into_response(),
        Err(Refusal::Busy(id)) => (StatusCode::CONFLICT,
            Json(json!({"error":"A backup, check or restore is already running","code":"backup_busy","operationId":id}))).into_response(),
        Err(Refusal::Conflict) => (StatusCode::CONFLICT,
            Json(json!({"error":"This requestId was used for a different request","code":"idempotency_conflict"}))).into_response(),
        Err(Refusal::Invalid(error)) => (StatusCode::BAD_REQUEST, Json(json!({"error":format!("{error:#}")}))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupRequest {
    request_id: String,
    to: String,
}

async fn start_backup(State(ws): State<Arc<Workspace>>, Json(body): Json<BackupRequest>) -> Response {
    let to = match absolute("to", &body.to) {
        Ok(to) => to,
        Err(error) => return started(Err(Refusal::Invalid(error))),
    };
    let request = json!({"to": body.to});
    let (data, store, target) = (ws.data_dir.clone(), ws.store.clone(), to.clone());
    started(ws.backups.start("backup", &body.request_id, request, |id| scratch_beside(&to, "partial", id), move |ctl| {
        let manifest = super::running(&data, &store, &target, ctl)?;
        Ok(summary(&manifest, &target))
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckRequest {
    request_id: String,
    path: String,
}

async fn start_check(State(ws): State<Arc<Workspace>>, Json(body): Json<CheckRequest>) -> Response {
    let path = match absolute("path", &body.path) {
        Ok(path) => path,
        Err(error) => return started(Err(Refusal::Invalid(error))),
    };
    let request = json!({"path": body.path});
    started(ws.backups.start("check", &body.request_id, request, |_| None, move |ctl| {
        ctl.at("verify")?;
        let manifest = super::verify(&path)?;
        Ok(summary(&manifest, &path))
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreRequest {
    request_id: String,
    from: String,
    to: String,
}

async fn start_restore(State(ws): State<Arc<Workspace>>, Json(body): Json<RestoreRequest>) -> Response {
    let (from, to) = match (absolute("from", &body.from), absolute("to", &body.to)) {
        (Ok(from), Ok(to)) => (from, to),
        (Err(error), _) | (_, Err(error)) => return started(Err(Refusal::Invalid(error))),
    };
    let request = json!({"from": body.from, "to": body.to});
    let (data, target) = (ws.data_dir.clone(), to.clone());
    started(ws.backups.start("restore", &body.request_id, request, |id| scratch_beside(&to, "restoring", id), move |ctl| {
        let restored = super::restore_with(&from, &target, Some(data.as_path()), ctl)?;
        let mut result = serde_json::to_value(&restored)?;
        result["nextSteps"] = json!(next_steps(&restored.restored_to));
        Ok(result)
    }))
}

/// How the restored folder is used: by a Core of its own, started outside
/// this page, never alongside a Core on the Workspace it was backed up from.
fn next_steps(folder: &Path) -> Vec<String> {
    vec![
        format!("Stop the Core that uses the original Workspace, then start a Core with --data-dir {}", folder.display()),
        "The restored Workspace keeps the original's Workspace ID and the IDs of its Agents' native sessions; the native histories those IDs refer to were not backed up. Never run Cores on both at once.".into(),
        "This page does not switch to the restored Workspace or start a Core on it.".into(),
    ]
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrecheckRequest {
    from: String,
    to: String,
}

/// Whether a backup could be restored into a folder here, from its manifest,
/// the target and free space; nothing is written. The restore itself checks
/// every file again.
async fn precheck(State(ws): State<Arc<Workspace>>, Json(body): Json<PrecheckRequest>) -> Result<Json<Value>, ApiError> {
    let from = absolute("from", &body.from)?;
    let to = absolute("to", &body.to)?;
    let data = ws.data_dir.clone();
    let running = ws.stored(|store| store.workspace_id()).await?;
    let answer = tokio::task::spawn_blocking(move || -> Result<Value> {
        let manifest = super::read_manifest(&from)?;
        ensure!(manifest.database.schema == crate::updates::package::STORAGE,
            "The backup has schema {}; this Core reads schema {}", manifest.database.schema, crate::updates::package::STORAGE);
        ensure!(manifest.database.record_layouts.iter().all(|layout| *layout <= crate::updates::storage::RECORD_LAYOUT),
            "The backup has record layouts this Core does not read");
        let (parent, target, existing) = super::restore_target(&to)?;
        let from = std::fs::canonicalize(&from)?;
        let data = std::fs::canonicalize(&data)?;
        ensure!(!target.starts_with(&from) && !from.starts_with(&target), "The backup and the restored Workspace cannot be inside each other");
        ensure!(!target.starts_with(&data) && !data.starts_with(&target), "A backup is not restored into or around the Workspace this Core uses");
        let bytes = manifest.files.iter().map(|file| file.bytes).sum::<u64>().saturating_add(manifest.database.bytes);
        super::room(&parent, bytes.saturating_add(super::MARGIN))?;
        let same = manifest.workspace_id == running;
        let mut notes = vec!["The restore reads and checks every file again before anything is put in place.".to_owned()];
        if same {
            notes.push("This backup is of the Workspace this Core uses: the restored copy keeps its Workspace ID and the IDs of its Agents' native sessions (not the native histories, which are not backed up), so it must never run alongside this Core.".into());
        }
        Ok(json!({"ok":true,"workspaceId":manifest.workspace_id,"createdAt":manifest.created_at,"createdBy":manifest.created_by,
            "agents":manifest.database.agents,"files":manifest.files.len(),"bytes":bytes,
            "target":if existing {"empty"} else {"new"},"sameIdentity":same,"notes":notes}))
    }).await?;
    // The reason travels with the refusal: the page shows it as it is.
    Ok(Json(answer.map_err(|error| anyhow::anyhow!("This backup cannot be restored there; nothing was changed: {error:#}"))?))
}

async fn stop(State(ws): State<Arc<Workspace>>, UrlPath(id): UrlPath<String>) -> Response {
    if ws.backups.stop(&id) {
        (StatusCode::ACCEPTED, Json(json!({"stopping":true}))).into_response()
    } else {
        (StatusCode::CONFLICT, Json(json!({"error":"That operation is not running","code":"not_running"}))).into_response()
    }
}

/// What a backup holds, as Settings shows it.
fn summary(manifest: &super::Manifest, path: &Path) -> Value {
    json!({
        "path": path,
        "workspaceId": manifest.workspace_id,
        "createdAt": manifest.created_at,
        "createdBy": manifest.created_by,
        "agents": manifest.database.agents,
        "files": manifest.files.len(),
        "bytes": manifest.files.iter().map(|file| file.bytes).sum::<u64>() + manifest.database.bytes,
        "excluded": manifest.excluded,
        "notCovered": manifest.not_covered,
    })
}
