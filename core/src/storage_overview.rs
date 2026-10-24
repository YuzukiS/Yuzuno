//! Data & storage overview (T-193 slice 1): what this Workspace keeps in its
//! data folder on the Core host, and what lives elsewhere.
//!
//! `GET /api/storage` reads without walking any folder: the database files
//! and SQLite's page counts, each top-level name of the data folder with what
//! it is, its size if it is a file, and whether a Workspace backup copies it
//! (`workspace_backup`'s own lists), Job counts, and the Agents whose native
//! sessions their CLIs keep outside the Workspace. A folder's size is not
//! measured here: it is said to be unknown, never 0. Read only: nothing here
//! removes or changes a file.
use crate::{server::ApiError, store::Store, workspace::Workspace, workspace_backup};
use anyhow::Result;
use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use std::{collections::BTreeMap, os::unix::fs::MetadataExt, path::Path, sync::Arc};

/// Names Core makes in the data folder, and what each holds. Any other name
/// is listed as unknown.
const KNOWN: &[(&str, &str)] = &[
    ("workspace.sqlite", "database"),
    ("workspace.sqlite-wal", "databaseLog"),
    ("workspace.sqlite-shm", "databaseIndex"),
    ("workspace.sqlite-journal", "databaseJournal"),
    ("workspace.lock", "lock"),
    ("input-images", "inputImages"),
    ("brief-attachments", "briefAttachments"),
    ("pr-reviews", "reviews"),
    ("jobs", "jobs"),
    ("claude-runtime", "claudeRuntime"),
    ("opencode", "opencode"),
    ("desktop-updates", "desktopDownloads"),
];
/// The one-off database copy record_rows makes before converting old Agents
/// (`record_rows::backup_path`): `workspace.before-record-rows-<UTC>[-n].sqlite`.
const EARLIER_COPY: (&str, &str) = ("workspace.before-record-rows-", ".sqlite");

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/storage", get(overview))
}

async fn overview(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    let data = ws.data_dir.clone();
    Ok(Json(ws.stored(move |store| read(store, &data)).await?))
}

/// What the data folder holds, read without walking it.
pub(crate) fn read(store: &Store, data: &Path) -> Result<Value> {
    let read_at = crate::model::now();
    let (pages, jobs) = {
        let db = store.db.read()?;
        let pragma = |name: &str| db.query_row(&format!("PRAGMA {name}"), [], |r| r.get::<_, i64>(0)).ok();
        let pages = json!({"pageSize": pragma("page_size"), "pages": pragma("page_count"), "freePages": pragma("freelist_count")});
        let total: Option<i64> = db.query_row("SELECT COUNT(*) FROM local_jobs", [], |r| r.get(0)).ok();
        let unfinished = crate::data_dir::unfinished_jobs(&db).ok();
        (pages, json!({"total": total, "unfinished": unfinished}))
    };
    let mut entries = Vec::new();
    let mut unreadable = None;
    match std::fs::read_dir(data) {
        Ok(names) => {
            for entry in names {
                match entry {
                    Ok(entry) => entries.push(describe(&entry.path(), &entry.file_name().to_string_lossy())),
                    Err(error) => unreadable = Some(error.to_string()),
                }
            }
        }
        Err(error) => unreadable = Some(error.to_string()),
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({
        "format": 1,
        "readAt": read_at,
        "dataDir": data.to_string_lossy(),
        "entries": entries,
        "unreadable": unreadable,
        "database": pages,
        "jobs": jobs,
        "native": native(&store.agents()?),
        "notInBackup": workspace_backup::NOT_COVERED,
    }))
}

/// One top-level name: what it is, its size if it is a file (stat only), and
/// whether a Workspace backup copies it, as `workspace_backup` decides.
fn describe(path: &Path, name: &str) -> Value {
    let what = KNOWN.iter().find(|(known, _)| *known == name).map(|(_, what)| *what).or_else(|| {
        (name.starts_with(EARLIER_COPY.0) && name.ends_with(EARLIER_COPY.1)).then_some("earlierDatabaseCopy")
    });
    let mut value = json!({"name": name, "what": what.unwrap_or("unknown")});
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => value["kind"] = json!("link"),
        Ok(meta) if meta.is_dir() => value["kind"] = json!("folder"),
        Ok(meta) if meta.is_file() => {
            value["kind"] = json!("file");
            value["bytes"] = json!(meta.len());
            value["diskBytes"] = json!(meta.blocks() * 512);
            value["modifiedAt"] = json!(meta.modified().ok().map(|at| chrono::DateTime::<chrono::Utc>::from(at).to_rfc3339()));
        }
        Ok(_) => value["kind"] = json!("special"),
        Err(error) => {
            value["kind"] = json!("unreadable");
            value["error"] = json!(error.to_string());
        }
    }
    let (backup, reason) = if name == "workspace.sqlite" {
        ("copied", None)
    } else if let Some((_, reason)) = workspace_backup::EXCLUDED.iter().find(|(excluded, _)| *excluded == name) {
        ("excluded", Some(*reason))
    } else if workspace_backup::INCLUDED.contains(&name) && value["kind"] == "folder" {
        ("copied", None)
    } else {
        ("notCopied", None)
    };
    value["backup"] = json!(backup);
    value["backupReason"] = json!(reason);
    value
}

/// The Agents whose native sessions their CLI keeps outside the Workspace,
/// by harness and machine. Codex and Claude keep them in their own folders on
/// that machine; OpenCode's are in this data folder (`opencode/`).
fn native(agents: &[crate::model::Agent]) -> Value {
    let mut groups: BTreeMap<(String, Option<String>), (u64, u64)> = BTreeMap::new();
    for agent in agents {
        let session = match agent.harness.as_str() {
            "claude" => agent.claude_session_id.is_some(),
            "opencode" => agent.opencode_session_id.is_some(),
            _ => agent.thread_id.is_some(),
        };
        if !session {
            continue;
        }
        let machine = agent.remote.as_ref().map(|remote| remote.machine.name.clone());
        let group = groups.entry((agent.harness.clone(), machine)).or_default();
        group.0 += 1;
        group.1 += u64::from(agent.closed_at.is_some());
    }
    json!(groups.into_iter().map(|((harness, machine), (agents, closed))| json!({
        "harness": harness, "machine": machine, "agents": agents, "closed": closed,
    })).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests;
