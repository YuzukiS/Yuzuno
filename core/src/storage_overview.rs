//! Data & storage overview (T-193 slice 1): what this Workspace keeps in its
//! data folder on the Core host, and what lives elsewhere.
//!
//! `GET /api/storage` reads without walking any folder: the database files
//! and SQLite's page counts, each top-level name of the data folder with what
//! it is and whether a Workspace backup copies it (`workspace_backup`'s own
//! lists), record counts, and the Agents whose native sessions their CLIs keep
//! outside the Workspace. Folder sizes come only from a measurement the user
//! starts (`POST /api/storage/measure`): one walk at a time per data folder,
//! over the folders Core makes there and nothing else, bounded by entries and
//! time and stoppable (`POST /api/storage/measure/stop`). It never follows a
//! link or leaves the folder's device; those, unreadable entries and the
//! folders a bound left unread are counted, never shown as 0. Read only:
//! nothing here removes or changes a file.
use crate::{server::ApiError, store::Store, workspace::Workspace, workspace_backup};
use anyhow::Result;
use axum::{extract::State, routing::{get, post}, Json, Router};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

/// A measurement's bounds: entries read, and time.
pub(crate) const ENTRIES: usize = 1_000_000;
pub(crate) const TIME: Duration = Duration::from_secs(30);

/// Names Core makes in the data folder, and what each holds. A folder here is
/// measured; any other name is listed as unknown and never walked.
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
    Router::new()
        .route("/api/storage", get(overview))
        .route("/api/storage/measure", post(measure))
        .route("/api/storage/measure/stop", post(stop))
}

async fn overview(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    let data = ws.data_dir.clone();
    Ok(Json(ws.stored(move |store| read(store, &data)).await?))
}

async fn measure(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"measurement": start(&ws.data_dir, ENTRIES, TIME)})))
}

async fn stop(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"measurement": request_stop(&ws.data_dir)})))
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
        "measurement": view(data),
        "bounds": {"entries": ENTRIES, "seconds": TIME.as_secs()},
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

/// A measurement of one data folder: started by the user, kept in memory
/// until the next one.
struct Run {
    id: String,
    started_at: String,
    stop: AtomicBool,
    state: Mutex<Progress>,
}

#[derive(Default)]
struct Progress {
    folders: Vec<Value>,
    current: Option<String>,
    entries: usize,
    ended: Option<(String, &'static str)>,
}

/// Keyed by data folder: each Workspace in this process has its own.
static RUNS: LazyLock<Mutex<HashMap<PathBuf, Arc<Run>>>> = LazyLock::new(Default::default);

/// Starts a measurement unless one is running; either way, says where it is.
pub(crate) fn start(data: &Path, entries: usize, time: Duration) -> Value {
    let run = {
        let mut runs = RUNS.lock().unwrap();
        if let Some(run) = runs.get(data).filter(|run| run.state.lock().unwrap().ended.is_none()) {
            return describe_run(run);
        }
        let run = Arc::new(Run {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: crate::model::now(),
            stop: AtomicBool::new(false),
            state: Mutex::default(),
        });
        runs.insert(data.to_path_buf(), run.clone());
        run
    };
    let (folder, walker) = (data.to_path_buf(), run.clone());
    let spawned = std::thread::Builder::new()
        .name("storage-measure".into())
        .spawn(move || walk_all(&folder, &walker, entries, time));
    if spawned.is_err() {
        run.state.lock().unwrap().ended = Some((crate::model::now(), "failed"));
    }
    describe_run(&run)
}

/// Asks a running measurement to stop at its next entry.
pub(crate) fn request_stop(data: &Path) -> Value {
    let run = RUNS.lock().unwrap().get(data).cloned();
    run.map(|run| {
        run.stop.store(true, Ordering::Relaxed);
        describe_run(&run)
    })
    .unwrap_or(Value::Null)
}

/// The latest measurement of this data folder, or null if none was made.
pub(crate) fn view(data: &Path) -> Value {
    RUNS.lock().unwrap().get(data).map(|run| describe_run(run)).unwrap_or(Value::Null)
}

fn describe_run(run: &Run) -> Value {
    let progress = run.state.lock().unwrap();
    let (ended_at, state) = match &progress.ended {
        Some((at, state)) => (Some(at.clone()), *state),
        None => (None, "running"),
    };
    json!({
        "id": run.id,
        "state": state,
        "startedAt": run.started_at,
        "endedAt": ended_at,
        "current": progress.current,
        "entries": progress.entries,
        "folders": progress.folders,
    })
}

/// Every folder Core makes in the data folder, one after another, sharing
/// one budget of entries and time.
fn walk_all(data: &Path, run: &Run, entries: usize, time: Duration) {
    let deadline = Instant::now() + time;
    let mut budget = entries;
    let mut seen = HashSet::new();
    let folders: Vec<&str> = KNOWN
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| std::fs::symlink_metadata(data.join(name)).is_ok_and(|meta| meta.is_dir()))
        .collect();
    let mut limited = false;
    for name in folders {
        if run.stop.load(Ordering::Relaxed) || budget == 0 || Instant::now() > deadline {
            limited |= !run.stop.load(Ordering::Relaxed);
            run.state.lock().unwrap().folders.push(json!({"name": name, "measured": false}));
            continue;
        }
        run.state.lock().unwrap().current = Some(name.to_owned());
        let mut folder = walk(&data.join(name), &mut budget, deadline, &run.stop, &mut seen, |read| {
            run.state.lock().unwrap().entries += read;
        });
        limited |= folder["complete"] == false && !run.stop.load(Ordering::Relaxed);
        folder["name"] = json!(name);
        folder["measured"] = json!(true);
        let mut state = run.state.lock().unwrap();
        state.folders.push(folder);
        state.current = None;
    }
    // Stopped by the user, cut short by a bound, or read whole.
    let ended = if run.stop.load(Ordering::Relaxed) { "stopped" } else if limited { "limited" } else { "done" };
    run.state.lock().unwrap().ended = Some((crate::model::now(), ended));
}

/// One folder: files, logical and disk bytes (each hard-linked file once),
/// with what was not followed or not read counted apart.
fn walk(
    dir: &Path,
    budget: &mut usize,
    deadline: Instant,
    stop: &AtomicBool,
    seen: &mut HashSet<(u64, u64)>,
    progress: impl Fn(usize),
) -> Value {
    let (mut files, mut bytes, mut disk) = (0u64, 0u64, 0u64);
    let (mut links, mut other_device, mut unreadable, mut special) = (0u64, 0u64, 0u64, 0u64);
    let mut complete = true;
    let device = std::fs::symlink_metadata(dir).map(|meta| meta.dev()).ok();
    let mut stack = vec![dir.to_path_buf()];
    let mut read = 0usize;
    'walk: while let Some(next) = stack.pop() {
        let Ok(names) = std::fs::read_dir(&next) else {
            unreadable += 1;
            continue;
        };
        for entry in names {
            if *budget == 0 || Instant::now() > deadline || stop.load(Ordering::Relaxed) {
                complete = false;
                break 'walk;
            }
            *budget -= 1;
            read += 1;
            if read % 4096 == 0 {
                progress(4096);
            }
            let Ok(entry) = entry else {
                unreadable += 1;
                continue;
            };
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                unreadable += 1;
                continue;
            };
            if meta.file_type().is_symlink() {
                links += 1;
            } else if Some(meta.dev()) != device {
                other_device += 1;
            } else if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                if meta.nlink() > 1 && !seen.insert((meta.dev(), meta.ino())) {
                    continue;
                }
                files += 1;
                bytes += meta.len();
                disk += meta.blocks() * 512;
            } else {
                special += 1;
            }
        }
    }
    progress(read % 4096);
    json!({
        "files": files, "bytes": bytes, "diskBytes": disk, "complete": complete,
        "links": links, "otherDevice": other_device, "unreadable": unreadable, "special": special,
    })
}

#[cfg(test)]
mod tests;
