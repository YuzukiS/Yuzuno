//! Cleaning a released executor's Cargo build output (YN-65).
//!
//! The user's policy decides, and only the user changes it, in Settings →
//! Data & storage (there is no MCP tool): off unless turned on. Once on,
//! `keepDays` after an executor was released and closed (executor_release.rs;
//! setting its task done releases it too), a pass removes the Cargo `debug`
//! profile output of the folders Core's own records show were that
//! executor's, on this Core's host:
//!
//! - the folder it worked in;
//! - the folders its Jobs ran in, and the target directories its Jobs named
//!   in `CARGO_TARGET_DIR`;
//! - worktrees its task registered, and worktrees on the head branch of a
//!   pull request linked to its task.
//!
//! A folder counts as a Git worktree of its task's Project: inside that
//! Project's folder on this host, of the same repository, neither the
//! Project's folder itself (nor its own `target/`), nor inside another
//! Project's folder or Core's data folder. Only `debug` profiles holding
//! nothing Cargo does not make are taken (build_output.rs's rule finds them),
//! and each is removed only once build_output.rs's checks pass at that moment,
//! as the user's own cleanup of a task's workspace removes one. Worktrees,
//! branches, sources, uncommitted changes, other profiles and everything beside
//! a profile stay.
//!
//! What keeps a profile for now (a build, a process, a Job, an Agent in that
//! folder, another open executor of the task) is tried again every hour for
//! seven days; what keeps it for good (Git, a Job record naming it, files Cargo
//! does not make, a link, a mount) is recorded once. Each executor's outcome is
//! kept for Settings, and its task's activity says once what Core removed and
//! kept. Executors on other machines are not handled.
use crate::{
    build_output::{discover, foreign_entries, git_ok, inside, local_protections, measure, mtime_ns, record_protections, remove_one},
    collaboration_store::{self as collaboration, TaskActor},
    model::now,
    server::ApiError,
    store::Store,
    workspace::Workspace,
};
use anyhow::{ensure, Result};
use axum::{
    extract::State as AppState,
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

/// A pass every hour; the first a minute after Core starts.
const TICK: Duration = Duration::from_secs(3600);
const FIRST: Duration = Duration::from_secs(60);
/// What keeps a profile for now is tried again after an hour, for a week.
const RETRY_MINUTES: i64 = 60;
const GIVE_UP_DAYS: i64 = 7;
pub(crate) const MAX_KEEP_DAYS: u32 = 30;
const DEFAULT_KEEP_DAYS: u32 = 1;
/// Executors one pass takes, oldest release first.
const PER_PASS: i64 = 10;
/// Executors' outcomes Settings shows.
const RECENT: i64 = 20;
/// Bounds of one profile's size estimate, and of the whole backlog preview.
const SIZE_ENTRIES: usize = 2_000_000;
const SIZE_TIME: Duration = Duration::from_secs(20);
const PREVIEW_TIME: Duration = Duration::from_secs(20);
const PREVIEW_EXECUTORS: i64 = 500;
const PREVIEW_ITEMS: usize = 30;
/// The only profile removed automatically.
const PROFILE: &str = "debug";
const SHARED: &str = "Another executor of its task is still open";

pub(crate) const SCOPE: &str = "Off unless you turn it on. Then, the chosen number of days after an executor is released, Core removes the Cargo debug build output of the worktrees its records show were that executor's, on this Core's host, once every check passes at that moment. Worktrees, branches, sources, other profiles and anything Cargo did not make stay; what is in use is tried again every hour for a week. Executors on other machines are not handled.";

#[derive(Default)]
pub(crate) struct State {
    wakeup: Arc<tokio::sync::Notify>,
    started: OnceLock<()>,
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS build_cleanup_policy(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS build_cleanups(
            agent_id TEXT PRIMARY KEY, task_id TEXT, state TEXT NOT NULL CHECK(state IN ('waiting','done','gaveUp')),
            next_try_at TEXT, updated_at TEXT NOT NULL, data TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS build_cleanups_updated ON build_cleanups(updated_at);",
    )?;
    Ok(())
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/build-cleanup", get(read).put(change))
        .route("/api/build-cleanup/backlog", post(backlog))
}

/// The user's policy. `since`: executors released before it are left alone
/// (None: every released executor).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Policy {
    pub enabled: bool,
    pub keep_days: u32,
    pub since: Option<String>,
    pub version: i64,
    pub changed_at: Option<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Policy { enabled: false, keep_days: DEFAULT_KEEP_DAYS, since: None, version: 0, changed_at: None }
    }
}

pub(crate) fn policy(db: &Connection) -> Result<Policy> {
    let raw: Option<String> = db.query_row("SELECT data FROM build_cleanup_policy WHERE id=1", [], |r| r.get(0)).optional()?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => Policy::default(),
    })
}

/// A change the user saves, against the version read. `earlier`: also the
/// executors released before it was turned on.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Change {
    pub enabled: bool,
    pub keep_days: u32,
    #[serde(default)]
    pub earlier: bool,
    pub expected_version: i64,
}

pub(crate) fn change_policy(db: &Connection, change: Change) -> Result<Policy> {
    let current = policy(db)?;
    ensure!(
        change.expected_version == current.version,
        "version_conflict: the build output cleanup was changed since it was read (now version {}); read it again",
        current.version
    );
    ensure!(change.keep_days <= MAX_KEEP_DAYS, "invalid_input: keepDays is 0 to {MAX_KEEP_DAYS}");
    let since = match (current.enabled, change.enabled, change.earlier) {
        (_, true, true) => None,
        (false, true, false) => Some(now()),
        _ => current.since.clone(),
    };
    let next = Policy { enabled: change.enabled, keep_days: change.keep_days, since, version: current.version + 1, changed_at: Some(now()) };
    db.execute(
        "INSERT INTO build_cleanup_policy(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        [serde_json::to_string(&next)?],
    )?;
    Ok(next)
}

/// What a release's answer says of its build output (executor_release.rs).
pub(crate) fn release_note(policy: &Policy, closed_at: Option<&str>, remote: bool) -> Value {
    if !policy.enabled {
        return json!({"enabled": false});
    }
    if remote {
        return json!({"enabled": true, "note": "It ran on another machine: its build output is not cleaned there."});
    }
    let closed = closed_at.and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok());
    if let (Some(closed), Some(since)) = (closed, policy.since.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())) {
        if closed < since {
            return json!({"enabled": true, "note": "It was released before the cleanup was turned on, which takes only later releases."});
        }
    }
    let due = closed.map(|at| (at + chrono::Duration::days(policy.keep_days.into())).to_rfc3339());
    json!({"enabled": true, "keepDays": policy.keep_days, "dueAt": due,
        "note": "Core removes the Cargo debug build output of the worktrees its records show were this executor's, from dueAt (counted from its close), once every check passes."})
}

/// A released executor as the pass needs it.
#[derive(Clone, Debug)]
struct Released {
    agent: String,
    name: String,
    cwd: String,
    remote: bool,
    task: Option<String>,
    archived_at: String,
}

/// Released executors whose days are over and that are not cleaned yet (or
/// whose wait is over), oldest first. With `everyone`, also those released
/// before `since` or within their days (the backlog preview).
fn released(store: &Store, policy: &Policy, limit: i64, everyone: bool) -> Result<Vec<Released>> {
    let cutoff = if everyone { now() } else { (chrono::Utc::now() - chrono::Duration::days(policy.keep_days.into())).to_rfc3339() };
    let since = if everyone { None } else { policy.since.clone() };
    let rows: Vec<(String, Option<String>, String)> = {
        let db = store.db.read()?;
        let mut q = db.prepare(
            "SELECT r.agent_id, r.task_id, r.archived_at FROM agent_roles r
             WHERE r.kind='executor' AND r.archived_at IS NOT NULL AND r.archived_at<=?1 AND (?2 IS NULL OR r.archived_at>=?2)
               AND NOT EXISTS(SELECT 1 FROM build_cleanups c WHERE c.agent_id=r.agent_id
                   AND (?3 OR c.state<>'waiting' OR c.next_try_at>?4))
             ORDER BY r.archived_at LIMIT ?5",
        )?;
        let rows = q.query_map(params![cutoff, since, everyone, now(), limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut out = Vec::new();
    for (agent, task, archived_at) in rows {
        let Ok(found) = store.agent(&agent) else { continue };
        out.push(Released { agent, name: found.name, cwd: found.cwd, remote: found.remote.is_some(), task, archived_at });
    }
    Ok(out)
}

/// What Core's records say of an executor's folders, before any is checked.
#[derive(Debug, Default)]
struct Evidence {
    project_dir: Option<String>,
    /// Folders that may be inside its worktrees, each with how it is known.
    folders: Vec<(String, &'static str)>,
    /// Target directories its Jobs named.
    targets: Vec<(String, &'static str)>,
    branches: Vec<String>,
    other_projects: Vec<String>,
    /// Another executor of its task is still open.
    shared: bool,
}

fn evidence(store: &Store, executor: &Released) -> Result<Evidence> {
    let projects = store.projects()?;
    let db = store.db.read()?;
    let mut found = Evidence::default();
    let project: Option<String> = match &executor.task {
        Some(task) => db.query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [task], |r| r.get(0)).optional()?,
        None => None,
    };
    found.project_dir = project.as_deref().and_then(|p| projects.iter().find(|q| q.id == p)).and_then(|p| p.default_dirs.get("local").cloned());
    found.other_projects = projects
        .iter()
        .filter(|p| Some(&p.id) != project.as_ref())
        .filter_map(|p| p.default_dirs.get("local").cloned())
        .collect();
    found.folders.push((executor.cwd.clone(), "it worked there"));
    let mut q = db.prepare(
        "SELECT json_extract(data,'$.cwd'), json_extract(data,'$.env.CARGO_TARGET_DIR') FROM local_jobs
         WHERE agent_id=?1 AND COALESCE(json_extract(data,'$.target.kind'),'local')='local' ORDER BY seq DESC LIMIT 2000",
    )?;
    let jobs = q.query_map([&executor.agent], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)))?;
    for job in jobs {
        let (cwd, target) = job?;
        if let Some(target) = target.filter(|t| !t.is_empty()) {
            let target = match &cwd {
                Some(cwd) if !Path::new(&target).is_absolute() => Path::new(cwd).join(&target).to_string_lossy().into_owned(),
                _ => target,
            };
            found.targets.push((target, "its Jobs built there"));
        }
        if let Some(cwd) = cwd {
            found.folders.push((cwd, "its Jobs ran there"));
        }
    }
    if let Some(task) = &executor.task {
        let mut q = db.prepare("SELECT json_extract(data,'$.path') FROM task_workspaces WHERE task_id=?1")?;
        for path in q.query_map([task], |r| r.get::<_, Option<String>>(0))? {
            if let Some(path) = path? {
                found.folders.push((path, "registered on its task"));
            }
        }
        let mut q = db.prepare(
            "SELECT json_extract(o.data,'$.snapshot.headBranch') FROM github_task_links l JOIN github_objects o ON o.id=l.object_id
             WHERE l.task_id=?1 AND o.kind='pull'",
        )?;
        for branch in q.query_map([task], |r| r.get::<_, Option<String>>(0))? {
            if let Some(branch) = branch?.filter(|b| !b.is_empty()) {
                found.branches.push(branch);
            }
        }
        found.shared = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_roles WHERE kind='executor' AND task_id=?1 AND archived_at IS NULL AND agent_id<>?2)",
            params![task, executor.agent],
            |r| r.get(0),
        )?;
    }
    found.folders.sort();
    found.folders.dedup();
    found.targets.sort();
    found.targets.dedup();
    found.branches.sort();
    found.branches.dedup();
    Ok(found)
}

/// A folder to look in: `scan` is searched for Cargo profiles, Git's checks
/// run in `git_root`, and Jobs and Agents are looked for in `scan`.
#[derive(Clone, Debug)]
struct Root {
    scan: PathBuf,
    git_root: PathBuf,
    how: BTreeSet<&'static str>,
    /// Known only through its task's pull request while another executor of
    /// the task is open.
    shared: bool,
}

fn canonical(path: &str) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The roots the evidence names that pass every rule, and the project folder.
async fn roots(ws: &Arc<Workspace>, found: Evidence) -> Option<(PathBuf, Vec<Root>)> {
    let project = canonical(found.project_dir.as_deref()?)?;
    let common = git_ok(&project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await.ok()?;
    let common = common.trim().to_owned();
    let own_target = project.join("target");
    let data = std::fs::canonicalize(&ws.data_dir).unwrap_or_else(|_| ws.data_dir.clone());
    let others: Vec<PathBuf> = found.other_projects.iter().filter_map(|p| canonical(p)).filter(|p| p != &project).collect();
    let allowed = |path: &Path| {
        inside(path, &project) && path != project && !inside(path, &data) && !others.iter().any(|other| inside(path, other))
    };
    let mut roots: BTreeMap<PathBuf, Root> = BTreeMap::new();
    let mut add = |scan: PathBuf, git_root: PathBuf, how: &'static str, shared: bool| {
        let root = roots.entry(scan.clone()).or_insert(Root { scan, git_root, how: BTreeSet::new(), shared });
        root.how.insert(how);
        root.shared &= shared;
    };
    // A worktree of the Project's repository, by a folder inside it.
    async fn worktree_of(folder: &Path, common: &str) -> Option<PathBuf> {
        let top = git_ok(folder, &["rev-parse", "--show-toplevel"]).await.ok()?;
        let top = std::fs::canonicalize(top.trim()).ok()?;
        let theirs = git_ok(&top, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await.ok()?;
        (theirs.trim() == common).then_some(top)
    }
    for (folder, how) in &found.folders {
        let Some(folder) = canonical(folder) else { continue };
        if !inside(&folder, &project) {
            continue;
        }
        if let Some(top) = worktree_of(&folder, &common).await.filter(|top| allowed(top)) {
            add(top.clone(), top, *how, false);
        }
    }
    if !found.branches.is_empty() {
        if let Ok(list) = git_ok(&project, &["worktree", "list", "--porcelain"]).await {
            let mut path = None;
            for line in list.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = Some(PathBuf::from(p));
                } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                    let Some(tree) = path.as_ref().and_then(|p| std::fs::canonicalize(p).ok()) else { continue };
                    if found.branches.iter().any(|b| b == branch) && allowed(&tree) {
                        add(tree.clone(), tree, "on its pull request's branch", found.shared);
                    }
                }
            }
        }
    }
    for (target, how) in &found.targets {
        let Some(target) = canonical(target) else { continue };
        if target == own_target || !allowed(&target) {
            continue;
        }
        if let Some(top) = worktree_of(&target, &common).await {
            add(target, top, *how, false);
        }
    }
    Some((project, roots.into_values().collect()))
}

/// A reason that will not change by waiting: recorded once.
fn lasting(reason: &str) -> bool {
    ["Git tracks", "Git sees", "It is reached through a link", "A filesystem is mounted", "Job records name", "Part of it is on another", "It holds "]
        .iter()
        .any(|start| reason.starts_with(start))
}

/// What became of one profile.
fn outcome(project: &Path, path: &Path, how: &BTreeSet<&'static str>, state: &str, reasons: Vec<String>, bytes: Option<u64>) -> Value {
    json!({"path": path.strip_prefix(project).unwrap_or(path), "how": how, "state": state, "reasons": reasons, "bytes": bytes})
}

/// Cleans one released executor's profiles, as far as every check allows.
async fn clean(ws: &Arc<Workspace>, executor: &Released) -> Result<Value> {
    if executor.remote {
        return Ok(json!({"note": "It ran on another machine: not handled.", "results": []}));
    }
    let found = ws.stored({
        let executor = executor.clone();
        move |s| evidence(s, &executor)
    })
    .await?;
    let Some((project, roots)) = roots(ws, found).await else {
        return Ok(json!({"note": "Its task's Project has no folder on this host, or that folder is not a Git checkout.", "results": []}));
    };
    let (mut results, mut done) = (Vec::new(), HashSet::new());
    for root in &roots {
        let scan = root.scan.clone();
        let (paths, _, _) = tokio::task::spawn_blocking(move || discover(&scan)).await?;
        for path in paths.into_iter().filter(|p| p.file_name().is_some_and(|n| n == PROFILE)) {
            if !done.insert(path.clone()) {
                continue;
            }
            let foreign = {
                let path = path.clone();
                tokio::task::spawn_blocking(move || foreign_entries(&path)).await?
            };
            if !foreign.is_empty() {
                results.push(outcome(&project, &path, &root.how, "kept", vec![format!("It holds what Cargo does not make: {}", foreign.join(", "))], None));
                continue;
            }
            let mut reasons = local_protections(&root.git_root, &path).await;
            reasons.extend(record_protections(ws, &root.scan, &path).await);
            let users = ws.stored({
                let scan = root.scan.clone();
                move |s| s.workspace_agents(&scan)
            })
            .await?;
            // A working one is record_protections' reason already; the executor itself is closed.
            for agent in users.iter().filter(|a| a["relation"] == "inside" && a["working"] != true && a["id"] != executor.agent.as_str()) {
                reasons.push(format!("Agent {} works in this folder", agent["name"].as_str().unwrap_or("")));
            }
            if root.shared {
                reasons.push(SHARED.to_owned());
            }
            let (bytes, meta) = {
                let path = path.clone();
                tokio::task::spawn_blocking(move || {
                    let (mut budget, deadline) = (SIZE_ENTRIES, Instant::now() + SIZE_TIME);
                    let size = measure(&path, &mut HashSet::new(), &mut budget, deadline);
                    (size["bytes"].as_u64().unwrap_or(0) + size["sharedBytes"].as_u64().unwrap_or(0), std::fs::symlink_metadata(&path).ok())
                })
                .await?
            };
            if !reasons.is_empty() {
                let state = if reasons.iter().all(|r| lasting(r)) { "kept" } else { "waiting" };
                results.push(outcome(&project, &path, &root.how, state, reasons, Some(bytes)));
                continue;
            }
            let Some(meta) = meta else { continue };
            let candidate = json!({"id": "auto", "path": path, "relative": path.strip_prefix(&project).unwrap_or(&path),
                "dev": meta.dev(), "ino": meta.ino(), "mtimeNs": mtime_ns(&meta).to_string(), "protected": []});
            let removed = remove_one(ws, &root.git_root, &root.scan, &candidate).await;
            let state = match removed["state"].as_str() {
                Some("removed") => "removed",
                Some("partial") | Some("failed") => "failed",
                _ => "waiting",
            };
            let reasons = removed["reason"].as_str().map(|r| vec![r.to_owned()]).unwrap_or_default();
            results.push(outcome(&project, &path, &root.how, state, reasons, Some(bytes)));
        }
    }
    let roots: Vec<Value> = roots
        .iter()
        .map(|r| json!({"path": r.scan.strip_prefix(&project).unwrap_or(&r.scan), "how": r.how}))
        .collect();
    let freed: u64 = results.iter().filter(|r| r["state"] == "removed").filter_map(|r| r["bytes"].as_u64()).sum();
    Ok(json!({"project": project, "roots": roots, "results": results, "removedBytes": freed}))
}

fn core() -> TaskActor {
    TaskActor { kind: "system".into(), id: "core".into(), name: "Yuzuno Core".into() }
}

fn gib(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / (1u64 << 30) as f64)
}

/// The task activity a finished cleanup leaves, once: what was removed and
/// what was kept, by path.
fn comment(executor: &Released, record: &Value) -> Option<String> {
    let results = record["results"].as_array()?;
    let removed: Vec<&Value> = results.iter().filter(|r| r["state"] == "removed").collect();
    let kept: Vec<&Value> = results.iter().filter(|r| r["state"] != "removed").collect();
    if removed.is_empty() && kept.is_empty() {
        return None;
    }
    let path = |r: &Value| r["path"].as_str().unwrap_or("").to_owned();
    let mut body = format!("Build output cleanup (Settings → Data & storage) for its released executor {}:", executor.name);
    if !removed.is_empty() {
        let names: Vec<String> = removed.iter().map(|r| path(r)).collect();
        body.push_str(&format!(" Core removed {} Cargo debug folder(s), about {}: {}.", removed.len(),
            gib(record["removedBytes"].as_u64().unwrap_or(0)), names.join(", ")));
    }
    for r in kept {
        let reasons: Vec<&str> = r["reasons"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        body.push_str(&format!(" Kept {}: {}.", path(r), reasons.join("; ")));
    }
    Some(body)
}

/// Saves an executor's outcome: waiting (tried again in an hour, for a week
/// from its first try), done, or given up; a finished one also on its task.
fn save(store: &Store, executor: &Released, mut record: Value) -> Result<String> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    let first: Option<String> = tx
        .query_row("SELECT json_extract(data,'$.firstTriedAt') FROM build_cleanups WHERE agent_id=?1", [&executor.agent], |r| r.get(0))
        .optional()?
        .flatten();
    let first = first.unwrap_or_else(now);
    let waiting = record["results"].as_array().is_some_and(|r| r.iter().any(|r| r["state"] == "waiting"));
    let expired = chrono::DateTime::parse_from_rfc3339(&first).is_ok_and(|at| chrono::Utc::now() - at.with_timezone(&chrono::Utc) > chrono::Duration::days(GIVE_UP_DAYS));
    let state = match (waiting, expired) {
        (false, _) => "done",
        (true, false) => "waiting",
        (true, true) => "gaveUp",
    };
    let next = (state == "waiting").then(|| (chrono::Utc::now() + chrono::Duration::minutes(RETRY_MINUTES)).to_rfc3339());
    record["executor"] = json!({"id": executor.agent, "name": executor.name, "releasedAt": executor.archived_at});
    record["firstTriedAt"] = json!(first);
    record["triedAt"] = json!(now());
    if let Some(task) = &executor.task {
        record["taskId"] = json!(collaboration::task_number(&tx, task).ok());
    }
    tx.execute(
        "INSERT INTO build_cleanups(agent_id,task_id,state,next_try_at,updated_at,data) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(agent_id) DO UPDATE SET task_id=excluded.task_id,state=excluded.state,next_try_at=excluded.next_try_at,
           updated_at=excluded.updated_at,data=excluded.data",
        params![executor.agent, executor.task, state, next, now(), record.to_string()],
    )?;
    if state != "waiting" {
        if let (Some(task), Some(body)) = (&executor.task, comment(executor, &record)) {
            collaboration::activity(&tx, task, "comment", &core(), &json!({"buildCleanup": {"agentId": executor.agent}}), json!({"body": body}))?;
        }
    }
    tx.commit()?;
    Ok(state.to_owned())
}

impl Workspace {
    /// One pass: the released executors that are due, oldest first. Nothing
    /// while the policy is off or Core prepares an update.
    pub(crate) async fn build_cleanup_pass(self: &Arc<Self>) -> Result<usize> {
        let policy = self.stored(|s| policy(&*s.db.read()?)).await?;
        if !policy.enabled {
            return Ok(0);
        }
        let due = self.stored(move |s| released(s, &policy, PER_PASS, false)).await?;
        let mut handled = 0;
        for executor in due {
            let Ok(_permit) = self.admission.enter_work() else { break };
            let record = clean(self, &executor).await?;
            let store = self.store.clone();
            tokio::task::spawn_blocking(move || save(&store, &executor, record)).await??;
            handled += 1;
        }
        Ok(handled)
    }

    /// An executor was closed, or the policy changed: a pass runs now.
    pub(crate) fn wake_build_cleanup(&self) {
        self.build_cleanup.wakeup.notify_one();
    }

    /// The loop: a pass a minute after Core starts, then each hour and on
    /// each wake-up.
    pub fn start_build_cleanup(self: &Arc<Self>) {
        if self.build_cleanup.started.set(()).is_err() {
            return;
        }
        let (weak, wakeup) = (Arc::downgrade(self), self.build_cleanup.wakeup.clone());
        tokio::spawn(async move {
            tokio::time::sleep(FIRST).await;
            loop {
                let Some(ws) = weak.upgrade() else { break };
                if let Err(error) = ws.build_cleanup_pass().await {
                    eprintln!("[build-cleanup] pass failed: {error:#}");
                }
                drop(ws);
                tokio::select! {
                    _ = wakeup.notified() => {},
                    _ = tokio::time::sleep(TICK) => {},
                }
            }
        });
    }
}

/// The policy, the latest outcomes and how many wait.
fn overview(store: &Store) -> Result<Value> {
    let db = store.db.read()?;
    let policy = policy(&db)?;
    let mut q = db.prepare(
        "SELECT state, next_try_at, updated_at, data FROM build_cleanups
         WHERE json_array_length(json_extract(data,'$.results'))>0 ORDER BY updated_at DESC LIMIT ?1",
    )?;
    let rows = q.query_map([RECENT], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
    let mut recent = Vec::new();
    for row in rows {
        let (state, next, updated, data) = row?;
        let data: Value = serde_json::from_str(&data)?;
        recent.push(json!({"state": state, "nextTryAt": next, "updatedAt": updated, "executor": data["executor"], "taskId": data["taskId"],
            "results": data["results"], "removedBytes": data["removedBytes"]}));
    }
    let waiting: i64 = db.query_row("SELECT COUNT(*) FROM build_cleanups WHERE state='waiting'", [], |r| r.get(0))?;
    Ok(json!({"policy": policy, "maxKeepDays": MAX_KEEP_DAYS, "recent": recent, "waiting": waiting, "scope": SCOPE}))
}

async fn read(AppState(ws): AppState<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(overview).await?))
}

async fn change(AppState(ws): AppState<Arc<Workspace>>, Json(input): Json<Change>) -> Result<Json<Value>, ApiError> {
    ws.stored(move |s| change_policy(&*s.db.write()?, input)).await?;
    ws.wake_build_cleanup();
    Ok(Json(ws.stored(overview).await?))
}

async fn backlog(AppState(ws): AppState<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(preview_backlog(&ws).await?))
}

/// What turning it on for executors released before would take, as far as
/// PREVIEW_TIME allows: debug profiles of their folders, with their size.
/// Nothing is checked or removed here; a removal checks everything again.
pub(crate) async fn preview_backlog(ws: &Arc<Workspace>) -> Result<Value> {
    let started = Instant::now();
    let all = ws.stored(|s| {
        let policy = policy(&*s.db.read()?)?;
        released(s, &policy, PREVIEW_EXECUTORS, true)
    })
    .await?;
    let (mut items, mut kept, mut checked, mut seen) = (Vec::new(), 0usize, 0usize, HashSet::new());
    for executor in all.iter().filter(|e| !e.remote) {
        if started.elapsed() > PREVIEW_TIME {
            break;
        }
        checked += 1;
        let found = ws.stored({
            let executor = executor.clone();
            move |s| evidence(s, &executor)
        })
        .await?;
        let Some((project, roots)) = roots(ws, found).await else { continue };
        for root in roots {
            let scan = root.scan.clone();
            let (paths, _, _) = tokio::task::spawn_blocking(move || discover(&scan)).await?;
            for path in paths.into_iter().filter(|p| p.file_name().is_some_and(|n| n == PROFILE)) {
                if !seen.insert(path.clone()) {
                    continue;
                }
                let (foreign, size) = {
                    let path = path.clone();
                    tokio::task::spawn_blocking(move || {
                        let (mut budget, deadline) = (SIZE_ENTRIES, Instant::now() + SIZE_TIME);
                        (foreign_entries(&path), measure(&path, &mut HashSet::new(), &mut budget, deadline))
                    })
                    .await?
                };
                if !foreign.is_empty() {
                    kept += 1;
                    continue;
                }
                let bytes = size["bytes"].as_u64().unwrap_or(0) + size["sharedBytes"].as_u64().unwrap_or(0);
                items.push(json!({"executor": executor.name, "path": path.strip_prefix(&project).unwrap_or(&path), "bytes": bytes}));
            }
        }
    }
    let bytes: u64 = items.iter().filter_map(|i| i["bytes"].as_u64()).sum();
    let folders = items.len();
    items.sort_by(|a, b| b["bytes"].as_u64().cmp(&a["bytes"].as_u64()));
    items.truncate(PREVIEW_ITEMS);
    Ok(json!({"executors": all.len(), "checked": checked, "complete": checked == all.iter().filter(|e| !e.remote).count(),
        "folders": folders, "bytes": bytes, "kept": kept, "items": items,
        "note": "Read only: nothing was checked for use or removed. A removal checks every folder again at that moment."}))
}

#[cfg(test)]
mod tests;
