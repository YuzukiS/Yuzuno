//! A Task's workspaces (T-169): Git working trees on this Core's host that
//! the user registered or created for the Task, what uses them, and the
//! cleanup of generated Cargo output the user selects there.
//!
//! Only the user reaches this module, through the web UI: there is no MCP
//! tool, nothing runs in the background, and a Task's materials or an Agent's
//! folder never register a workspace by themselves. A registration authorizes
//! looking; each removal needs a fresh preview, the user's selection and every
//! check repeated at that moment. Only Cargo profile output (a directory with
//! `.cargo-lock` and `.fingerprint` directly inside a Cargo `CACHEDIR.TAG`
//! directory) is ever removed; a name, being ignored by Git or being old
//! never makes anything removable, and branches and worktrees are never
//! removed. Remote machines and Windows are not handled.
use crate::{collaboration_store as collaboration, model::now, server::ApiError, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{Path as UrlPath, State as AppState},
    routing::{delete, get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};

/// A task's internal id, its public reference, its workspace records and the
/// repositories linked to it or its Project.
pub(crate) type Listed = (String, String, Vec<Value>, Vec<(i64, String)>);

const PER_TASK: i64 = 8;
const GIT_SECONDS: u64 = 8;
const GIT_BYTES: usize = 64 * 1024;
const PREVIEW_MINUTES: i64 = 10;
/// The discovery walk: how deep, how many directories, how long.
const WALK_DEPTH: usize = 6;
const WALK_DIRS: usize = 50_000;
const WALK_TIME: Duration = Duration::from_secs(5);
/// The size estimate of every candidate together.
const SIZE_ENTRIES: usize = 2_000_000;
const SIZE_TIME: Duration = Duration::from_secs(20);
const CACHEDIR_SIGNATURE: &str = "Signature: 8a477f597d28d172789f06886806bc55";
const REMOVING: &str = ".yuzuno-removing-";

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_workspaces(
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS task_workspaces_task ON task_workspaces(task_id);",
    )?;
    Ok(())
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/tasks/{task}/workspaces", get(list).post(register))
        .route("/api/tasks/{task}/workspaces/create", post(create))
        .route("/api/tasks/{task}/workspaces/{id}", delete(forget))
        .route("/api/tasks/{task}/workspaces/{id}/cleanup/preview", post(preview))
        .route("/api/tasks/{task}/workspaces/{id}/cleanup", post(execute))
}

/// A directory as this host names and identifies it now.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Identity {
    pub path: PathBuf,
    pub dev: u64,
    pub ino: u64,
}

pub(crate) fn identify(path: &Path) -> Result<Identity> {
    ensure!(path.is_absolute(), "The path must be absolute on this Core's host");
    let canonical = std::fs::canonicalize(path).with_context(|| format!("{} cannot be resolved", path.display()))?;
    let meta = std::fs::symlink_metadata(&canonical)?;
    ensure!(meta.is_dir(), "{} is not a folder", canonical.display());
    Ok(Identity { path: canonical, dev: meta.dev(), ino: meta.ino() })
}

/// The same directory at the same recorded path, reached without a link.
fn unchanged(record: &Value) -> Result<Identity> {
    let path = PathBuf::from(record["path"].as_str().context("Workspace has no path")?);
    let now = identify(&path)?;
    ensure!(
        now.path == path && Some(now.dev) == record["dev"].as_u64() && Some(now.ino) == record["ino"].as_u64(),
        "{} is no longer the folder that was registered (it was moved, replaced or reached through a link)",
        path.display()
    );
    Ok(now)
}

/// path as this host resolves it now, or as given where it does not resolve
/// (a folder that was removed): roots are compared resolved.
fn real(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

/// path is root or below it.
pub(crate) fn inside(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// At most limit bytes of reader, and whether there was more. The rest is
/// read and dropped: a writer left blocked on a full pipe would never exit.
async fn bounded(mut reader: impl tokio::io::AsyncRead + Unpin, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let (mut kept, mut more) = (Vec::new(), false);
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            return Ok((kept, more));
        }
        let room = limit.saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..n.min(room)]);
        more |= n > room;
    }
}

/// One bounded Git command in dir: no hooks, no fsmonitor, no optional
/// locks, no prompts. Returns stdout, or the reason it failed.
async fn git(dir: &Path, args: &[&str]) -> Result<std::result::Result<String, String>> {
    let mut child = Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C"])
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Git could not be started on this Core's host")?;
    let out = child.stdout.take().context("Missing Git output")?;
    let err = child.stderr.take().context("Missing Git errors")?;
    let run = async {
        let (a, b, status) = tokio::join!(bounded(out, GIT_BYTES), bounded(err, 4096), child.wait());
        let ((stdout, more), (stderr, _)) = (a?, b?);
        Ok::<_, anyhow::Error>((status?, stdout, more, stderr))
    };
    let (status, stdout, more, stderr) = tokio::time::timeout(Duration::from_secs(GIT_SECONDS), run)
        .await
        .map_err(|_| anyhow::anyhow!("Git did not answer within {GIT_SECONDS} s"))??;
    ensure!(!more, "Git's answer exceeded {} KiB", GIT_BYTES / 1024);
    Ok(if status.success() {
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&stderr).trim().chars().take(600).collect())
    })
}

async fn git_ok(dir: &Path, args: &[&str]) -> Result<String> {
    git(dir, args).await?.map_err(|why| anyhow::anyhow!("git {} failed: {why}", args.join(" ")))
}

/// owner/name of a GitHub remote URL, or None.
pub(crate) fn github_name(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| {
            let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
            let rest = rest.split_once('@').map_or(rest, |(_, host)| host);
            rest.strip_prefix("github.com/")
        })?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let parts: Vec<&str> = rest.split('/').collect();
    (parts.len() == 2 && parts.iter().all(|p| !p.is_empty())).then(|| rest.to_owned())
}

/// What Git says about a working tree now.
async fn git_facts(root: &Path) -> Result<Value> {
    let top = git_ok(root, &["rev-parse", "--show-toplevel"]).await?;
    let common = git_ok(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
    let branch = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?.ok().map(|b| b.trim().to_owned());
    let head = git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await?.ok().map(|h| h.trim().to_owned());
    let origin = git(root, &["remote", "get-url", "origin"]).await?.ok().map(|o| o.trim().to_owned());
    let status = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"]).await;
    let changes = match status {
        Ok(Ok(text)) => {
            let (mut modified, mut untracked) = (0, 0);
            let mut entries = text.split('\0');
            while let Some(entry) = entries.next() {
                if entry.len() < 4 {
                    continue;
                }
                if entry.starts_with("??") {
                    untracked += 1;
                } else {
                    modified += 1;
                    // A rename or copy is followed by its source path.
                    if entry[..2].contains(['R', 'C']) {
                        entries.next();
                    }
                }
            }
            json!({"modified": modified, "untracked": untracked, "complete": true})
        }
        Ok(Err(why)) => json!({"complete": false, "reason": why}),
        Err(error) => json!({"complete": false, "reason": error.to_string()}),
    };
    Ok(json!({"toplevel": top.trim(), "commonDir": common.trim(), "branch": branch, "head": head,
        "origin": origin.as_deref().and_then(github_name), "changes": changes}))
}

impl Store {
    fn workspace_task(&self, db: &Connection, reference: &str) -> Result<(String, String)> {
        let (id, number) = collaboration::task_key(db, reference)?;
        Ok((id, format!("T-{number}")))
    }

    /// The repositories linked to the Task or its Project.
    fn workspace_repositories(db: &Connection, task: &str) -> Result<Vec<(i64, String)>> {
        let mut q = db.prepare(
            "SELECT r.id, json_extract(r.data,'$.fullName') FROM github_repositories r
             WHERE r.id IN (SELECT p.repo_id FROM github_project_repos p JOIN project_tasks t ON t.project_id=p.project_id WHERE t.task_id=?1)
                OR r.id IN (SELECT o.repo_id FROM github_task_links l JOIN github_objects o ON o.id=l.object_id WHERE l.task_id=?1)
             ORDER BY r.id LIMIT 50",
        )?;
        let rows = q.query_map([task], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub(crate) fn task_workspaces(&self, reference: &str) -> Result<Listed> {
        let db = self.db.read()?;
        let (task, public) = self.workspace_task(&db, reference)?;
        let mut q = db.prepare("SELECT data FROM task_workspaces WHERE task_id=?1 ORDER BY rowid")?;
        let records = q
            .query_map([&task], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        let repositories = Self::workspace_repositories(&db, &task)?;
        Ok((task, public, records, repositories))
    }

    fn task_workspace(&self, task: &str, id: &str) -> Result<Value> {
        let db = self.db.read()?;
        let data: String = db
            .query_row("SELECT data FROM task_workspaces WHERE id=?1 AND task_id=?2", params![id, task], |r| r.get(0))
            .optional()?
            .context("No such workspace for this task")?;
        Ok(serde_json::from_str(&data)?)
    }

    fn insert_task_workspace(&self, task: &str, record: &Value) -> Result<()> {
        let db = self.db.write()?;
        let count: i64 = db.query_row("SELECT COUNT(*) FROM task_workspaces WHERE task_id=?1", [task], |r| r.get(0))?;
        ensure!(count < PER_TASK, "A task keeps at most {PER_TASK} workspaces; forget one first");
        let same: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_workspaces WHERE task_id=?1 AND json_extract(data,'$.path')=?2)",
            params![task, record["path"].as_str()],
            |r| r.get(0),
        )?;
        ensure!(!same, "This folder is already registered for this task");
        db.execute(
            "INSERT INTO task_workspaces(id,task_id,data) VALUES(?1,?2,?3)",
            params![record["id"].as_str(), task, record.to_string()],
        )?;
        Ok(())
    }

    fn forget_task_workspace(&self, task: &str, id: &str) -> Result<bool> {
        Ok(self.db.write()?.execute("DELETE FROM task_workspaces WHERE id=?1 AND task_id=?2", params![id, task])? > 0)
    }

    fn save_task_workspace_preview(&self, task: &str, id: &str, preview: &Value) -> Result<()> {
        let db = self.db.write()?;
        let changed = db.execute(
            "UPDATE task_workspaces SET data=json_set(data,'$.preview',json(?3)) WHERE id=?1 AND task_id=?2",
            params![id, task, preview.to_string()],
        )?;
        ensure!(changed == 1, "No such workspace for this task");
        Ok(())
    }

    /// A preview is used once: taking it clears it, so two removals can
    /// never run from the same preview.
    fn take_task_workspace_preview(&self, task: &str, id: &str, preview: &str) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let data: String = tx
            .query_row("SELECT data FROM task_workspaces WHERE id=?1 AND task_id=?2", params![id, task], |r| r.get(0))
            .optional()?
            .context("No such workspace for this task")?;
        let mut record: Value = serde_json::from_str(&data)?;
        let stored = record["preview"].take();
        ensure!(stored["id"] == preview, "This preview was already used or replaced; preview again");
        let expired = stored["expiresAt"]
            .as_str()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .is_none_or(|at| at < chrono::Utc::now());
        tx.execute("UPDATE task_workspaces SET data=?3 WHERE id=?1 AND task_id=?2", params![id, task, record.to_string()])?;
        tx.commit()?;
        ensure!(!expired, "This preview expired after {PREVIEW_MINUTES} minutes; preview again");
        Ok(stored)
    }

    /// Local Agents whose folder is the workspace, inside it, or above it.
    fn workspace_agents(&self, root: &Path) -> Result<Vec<Value>> {
        Ok(self
            .agents()?
            .into_iter()
            .filter(|a| a.remote.is_none() && a.closed_at.is_none())
            .filter_map(|a| {
                let cwd = real(PathBuf::from(&a.cwd));
                let relation = if inside(&cwd, root) { "inside" } else if root.starts_with(&cwd) { "above" } else { return None };
                Some(json!({"id": a.id, "name": a.name, "status": a.status, "relation": relation,
                    "working": a.status != "idle"}))
            })
            .collect())
    }

    /// Queued and running Jobs on this host that use root: their folder is
    /// inside it, or their CARGO_TARGET_DIR is.
    fn workspace_live_jobs(&self, root: &Path) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT id, json_extract(data,'$.name'), status, json_extract(data,'$.cwd'), json_extract(data,'$.taskRef'),
                    json_extract(data,'$.env.CARGO_TARGET_DIR')
             FROM local_jobs WHERE (reserved=1 OR status IN ('queued','waiting')) AND json_extract(data,'$.executor') IS NULL
             ORDER BY seq LIMIT 1000",
        )?;
        let rows = q.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?))
        })?;
        let mut jobs = Vec::new();
        for row in rows {
            let (id, name, status, cwd, task, target) = row?;
            let target = target.map(|t| cwd.as_deref().map_or(PathBuf::from(&t), |c| Path::new(c).join(&t))).map(real);
            let cwd = cwd.map(|c| real(PathBuf::from(c)));
            if cwd.as_deref().is_some_and(|c| inside(c, root)) || target.as_deref().is_some_and(|t| inside(t, root)) {
                jobs.push(json!({"id": id, "name": name, "status": status, "taskRef": task}));
            }
        }
        Ok(jobs)
    }

    /// Job records, finished ones included, that name path: an artifact, an
    /// output, a folder or a setting there is evidence to keep.
    fn workspace_job_references(&self, path: &Path) -> Result<Vec<String>> {
        let raw = path.to_string_lossy().into_owned();
        let escaped = serde_json::to_string(&raw)?;
        let escaped = escaped.trim_matches('"').to_owned();
        let db = self.db.read()?;
        let mut q = db.prepare("SELECT id FROM local_jobs WHERE instr(data, ?1) > 0 OR instr(data, ?2) > 0 ORDER BY seq DESC LIMIT 5")?;
        let ids = q.query_map(params![raw, escaped], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }

    fn task_job_count(&self, task: &str) -> Result<i64> {
        Ok(self.db.read()?.query_row("SELECT COUNT(*) FROM local_jobs WHERE task_id=?1", [task], |r| r.get(0))?)
    }
}

fn matched(origin: &Value, repositories: &[(i64, String)]) -> Option<i64> {
    let origin = origin.as_str()?;
    repositories.iter().find(|(_, name)| name.eq_ignore_ascii_case(origin)).map(|(id, _)| *id)
}

/// A registered workspace as it is now: same folder, its Git state, who uses it.
async fn inspect(ws: &Arc<Workspace>, task: &str, record: &Value, repositories: &[(i64, String)]) -> Value {
    let mut view = record.clone();
    if let Some(map) = view.as_object_mut() {
        map.remove("preview");
    }
    let root = match tokio::task::spawn_blocking({
        let record = record.clone();
        move || unchanged(&record)
    })
    .await
    {
        Ok(Ok(identity)) => identity.path,
        Ok(Err(error)) => {
            view["state"] = json!("changed");
            view["problem"] = json!(error.to_string());
            return view;
        }
        Err(error) => {
            view["state"] = json!("unknown");
            view["problem"] = json!(error.to_string());
            return view;
        }
    };
    view["state"] = json!("present");
    view["git"] = match git_facts(&root).await {
        Ok(mut facts) => {
            facts["repositoryId"] = json!(matched(&facts["origin"], repositories));
            facts["sameRepository"] = json!(facts["commonDir"] == record["gitCommonDir"]);
            facts
        }
        Err(error) => json!({"problem": error.to_string()}),
    };
    let users = ws
        .stored({
            let root = root.clone();
            let task = task.to_owned();
            move |s| Ok(json!({"agents": s.workspace_agents(&root)?, "liveJobs": s.workspace_live_jobs(&root)?,
                "taskJobs": s.task_job_count(&task)?}))
        })
        .await;
    view["users"] = users.unwrap_or_else(|error| json!({"problem": error.to_string()}));
    view["checkedAt"] = json!(now());
    view
}

async fn list(AppState(ws): AppState<Arc<Workspace>>, UrlPath(task): UrlPath<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(list_workspaces(ws, task).await?))
}

async fn list_workspaces(ws: Arc<Workspace>, task: String) -> Result<Value> {
    let (id, public, records, repositories) = ws.stored(move |s| s.task_workspaces(&task)).await?;
    let mut views = Vec::with_capacity(records.len());
    for record in &records {
        views.push(inspect(&ws, &id, record, &repositories).await);
    }
    Ok(json!({"taskId": public, "machine": {"id": "local", "name": "Core host"},
        "repositories": repositories.iter().map(|(id, name)| json!({"id": id, "fullName": name})).collect::<Vec<_>>(),
        "workspaces": views,
        "scope": "Folders registered or created for this task on this Core's host. Checking reads Git state and who uses each folder; nothing is changed. Remote machines and Windows are not handled."}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Register {
    path: String,
}

/// A record for root, a Git working tree's top folder.
async fn record_for(root: &Identity, repositories: &[(i64, String)], origin: &str, extra: Value) -> Result<Value> {
    let facts = git_facts(&root.path).await?;
    ensure!(
        facts["toplevel"].as_str() == Some(&*root.path.to_string_lossy()),
        "{} is not the top folder of a Git working tree (Git reports {})",
        root.path.display(),
        facts["toplevel"].as_str().unwrap_or("none")
    );
    let mut record = json!({"id": uuid::Uuid::new_v4().to_string(), "machineId": "local", "path": root.path,
        "dev": root.dev, "ino": root.ino, "gitCommonDir": facts["commonDir"], "branch": facts["branch"],
        "head": facts["head"], "repository": facts["origin"], "repositoryId": matched(&facts["origin"], repositories),
        "origin": origin, "by": "user", "at": now(), "preview": null});
    if let (Some(record), Some(extra)) = (record.as_object_mut(), extra.as_object()) {
        record.extend(extra.clone());
    }
    Ok(record)
}

async fn register(
    AppState(ws): AppState<Arc<Workspace>>,
    UrlPath(task): UrlPath<String>,
    Json(input): Json<Register>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(register_workspace(ws, task, input).await?))
}

async fn register_workspace(ws: Arc<Workspace>, task: String, input: Register) -> Result<Value> {
    let (id, _, _, repositories) = ws.stored({
        let task = task.clone();
        move |s| s.task_workspaces(&task)
    })
    .await?;
    let path = PathBuf::from(input.path.trim());
    let root = tokio::task::spawn_blocking(move || identify(&path)).await??;
    let record = record_for(&root, &repositories, "registered", json!({})).await?;
    ws.stored({
        let (id, record) = (id.clone(), record.clone());
        move |s| s.insert_task_workspace(&id, &record)
    })
    .await?;
    Ok(inspect(&ws, &id, &record, &repositories).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    /// An existing checkout of a repository linked to the task or its Project.
    repository: String,
    branch: String,
    #[serde(default)]
    base: Option<String>,
    path: String,
}

async fn create(
    AppState(ws): AppState<Arc<Workspace>>,
    UrlPath(task): UrlPath<String>,
    Json(input): Json<Create>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(create_worktree(ws, task, input).await?))
}

async fn create_worktree(ws: Arc<Workspace>, task: String, input: Create) -> Result<Value> {
    let (id, _, _, repositories) = ws.stored({
        let task = task.clone();
        move |s| s.task_workspaces(&task)
    })
    .await?;
    let checkout = PathBuf::from(input.repository.trim());
    let checkout = tokio::task::spawn_blocking(move || identify(&checkout)).await??;
    let facts = git_facts(&checkout.path).await?;
    ensure!(
        facts["toplevel"].as_str() == Some(&*checkout.path.to_string_lossy()),
        "{} is not the top folder of a Git checkout",
        checkout.path.display()
    );
    let Some(repository) = matched(&facts["origin"], &repositories) else {
        bail!(
            "The checkout's origin ({}) is not a repository linked to this task or its Project",
            facts["origin"].as_str().unwrap_or("not a GitHub remote")
        );
    };
    let branch = input.branch.trim().to_owned();
    ensure!(!branch.is_empty() && !branch.starts_with('-'), "Name a new branch");
    git_ok(&checkout.path, &["check-ref-format", "--branch", &branch])
        .await
        .map_err(|_| anyhow::anyhow!("{branch} is not a valid branch name"))?;
    let exists = git(&checkout.path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await?.is_ok();
    ensure!(!exists, "Branch {branch} already exists; choose a new name");
    let base = input.base.as_deref().map(str::trim).filter(|b| !b.is_empty()).unwrap_or("origin/main").to_owned();
    ensure!(!base.starts_with('-'), "Name a base commit or branch");
    let base_sha = git_ok(&checkout.path, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")])
        .await
        .map_err(|_| anyhow::anyhow!("{base} is not a commit in this checkout"))?
        .trim()
        .to_owned();
    let target = PathBuf::from(input.path.trim());
    let target = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        ensure!(target.is_absolute(), "The new folder's path must be absolute");
        let name = target.file_name().context("Name the new folder")?.to_owned();
        let parent = identify(target.parent().context("The new folder needs a parent folder")?)?;
        let target = parent.path.join(name);
        ensure!(
            matches!(std::fs::symlink_metadata(&target), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
            "{} already exists; choose a new folder",
            target.display()
        );
        Ok(target)
    })
    .await??;
    let target_text = target.to_string_lossy().into_owned();
    if let Err(why) = git(&checkout.path, &["worktree", "add", "-b", &branch, &target_text, &base_sha]).await? {
        bail!("Git did not create the worktree, so nothing was registered: {why}");
    }
    // Registered only once Git's own view of it matches what was asked.
    let verified = async {
        let root = identify(&target)?;
        ensure!(root.path == target, "The new folder resolves elsewhere");
        let created = git_facts(&root.path).await?;
        ensure!(created["commonDir"] == facts["commonDir"], "The new worktree belongs to another repository");
        ensure!(created["branch"].as_str() == Some(&branch), "The new worktree is not on {branch}");
        ensure!(created["head"].as_str() == Some(&base_sha), "The new worktree is not at {base_sha}");
        record_for(&root, &repositories, "created",
            json!({"base": base, "baseSha": base_sha, "createdFrom": checkout.path, "repositoryId": repository})).await
    }
    .await;
    let record = verified.map_err(|error| {
        anyhow::anyhow!("Git created {} but it did not verify, so it was not registered and was left as it is: {error}", target.display())
    })?;
    ws.stored({
        let (id, record) = (id.clone(), record.clone());
        move |s| s.insert_task_workspace(&id, &record)
    })
    .await
    .map_err(|error| anyhow::anyhow!("Git created {} but it could not be registered: {error}", target.display()))?;
    Ok(inspect(&ws, &id, &record, &repositories).await)
}

async fn forget(
    AppState(ws): AppState<Arc<Workspace>>,
    UrlPath((task, id)): UrlPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(forget_workspace(ws, task, id).await?))
}

async fn forget_workspace(ws: Arc<Workspace>, task: String, id: String) -> Result<Value> {
    let removed = ws
        .stored(move |s| {
            let (task, _) = s.workspace_task(&*s.db.read()?, &task)?;
            s.forget_task_workspace(&task, &id)
        })
        .await?;
    Ok(json!({"forgotten": removed, "note": "Only the registration was removed; no file or branch was touched."}))
}

/// Mount points on this host, from /proc/self/mountinfo; None where it
/// cannot be read (not Linux), so nothing is removed unchecked.
fn mounts() -> Option<Vec<PathBuf>> {
    let unescape = |s: &str| s.replace("\\040", " ").replace("\\011", "\t").replace("\\012", "\n").replace("\\134", "\\");
    let text = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
    Some(text.lines().filter_map(|line| line.split(' ').nth(4).map(|p| PathBuf::from(unescape(p)))).collect())
}

fn cargo_tag(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("CACHEDIR.TAG"))
        .is_ok_and(|text| text.starts_with(CACHEDIR_SIGNATURE) && text.to_ascii_lowercase().contains("cargo"))
}

fn is_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn is_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

/// Bookkeeping Cargo keeps beside its profiles; neither removed nor reported.
const CARGO_FILES: [&str; 5] = ["CACHEDIR.TAG", ".rustc_info.json", ".future-incompat-report.json", ".package-cache", ".package-cache-mutate"];

/// Cargo profile output under root, and what was kept, by a bounded walk
/// that never follows links and stops at other Git working trees.
pub(crate) fn discover(root: &Path) -> (Vec<PathBuf>, Vec<Value>, Value) {
    let started = Instant::now();
    let (mut candidates, mut kept) = (Vec::new(), Vec::new());
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let (mut visited, mut complete) = (0usize, true);
    let relative = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().into_owned();
    while let Some((dir, depth)) = stack.pop() {
        if visited >= WALK_DIRS || started.elapsed() > WALK_TIME {
            complete = false;
            break;
        }
        visited += 1;
        if dir != root && std::fs::symlink_metadata(dir.join(".git")).is_ok() {
            kept.push(json!({"path": relative(&dir), "reason": "Another Git working tree: not part of this workspace"}));
            continue;
        }
        if cargo_tag(&dir) {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if CARGO_FILES.contains(&name.as_str()) || name.starts_with(REMOVING) {
                    continue;
                }
                if is_dir(&path) && is_file(&path.join(".cargo-lock")) && is_dir(&path.join(".fingerprint")) {
                    candidates.push(path);
                } else {
                    kept.push(json!({"path": relative(&path), "reason": "Not recognized as Cargo build output: it may be yours"}));
                }
            }
            continue;
        }
        if depth >= WALK_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            // file_type does not follow a link: a linked folder is not entered.
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    candidates.sort();
    let bounds = json!({"visitedFolders": visited, "complete": complete, "maxDepth": WALK_DEPTH,
        "maxFolders": WALK_DIRS, "maxSeconds": WALK_TIME.as_secs(),
        "skipped": ".git, node_modules and other Git working trees are not searched"});
    (candidates, kept, bounds)
}

/// Allocated bytes below dir, each hard-linked file once; bytes of files
/// with other links are reported apart, as they may stay on disk.
fn measure(dir: &Path, seen: &mut HashSet<(u64, u64)>, budget: &mut usize, deadline: Instant) -> Value {
    let (mut bytes, mut shared, mut files, mut complete, mut other_device) = (0u64, 0u64, 0u64, true, false);
    let device = std::fs::symlink_metadata(dir).map(|m| m.dev()).ok();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else { continue };
        for entry in entries.flatten() {
            if *budget == 0 || Instant::now() > deadline {
                complete = false;
                break;
            }
            *budget -= 1;
            let Ok(link) = std::fs::symlink_metadata(entry.path()) else { continue };
            if Some(link.dev()) != device {
                other_device = true;
                continue;
            }
            if link.is_dir() {
                stack.push(entry.path());
                continue;
            }
            files += 1;
            let size = link.blocks() * 512;
            if link.nlink() > 1 {
                if seen.insert((link.dev(), link.ino())) {
                    shared += size;
                }
            } else {
                bytes += size;
            }
        }
        if !complete {
            break;
        }
    }
    json!({"bytes": bytes, "sharedBytes": shared, "files": files, "complete": complete, "otherDevice": other_device})
}

/// Why candidate must stay, from the facts any process could change: files
/// Git cares about, a running build, a mount, a link.
async fn local_protections(root: &Path, candidate: &Path) -> Vec<String> {
    let mut reasons = Vec::new();
    let relative = candidate.strip_prefix(root).unwrap_or(candidate).to_string_lossy().into_owned();
    match git(root, &["ls-files", "-z", "--", &relative]).await {
        Ok(Ok(text)) if !text.is_empty() => reasons.push("Git tracks files here".to_owned()),
        Ok(Ok(_)) => {}
        Ok(Err(why)) => reasons.push(format!("Git could not list it: {why}")),
        Err(error) => reasons.push(format!("Git could not list it: {error}")),
    }
    match git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", "--", &relative]).await {
        Ok(Ok(text)) if !text.is_empty() => reasons.push("Git sees files here that are not ignored".to_owned()),
        Ok(Ok(_)) => {}
        Ok(Err(why)) => reasons.push(format!("Git could not check it: {why}")),
        Err(error) => reasons.push(format!("Git could not check it: {error}")),
    }
    let candidate = candidate.to_path_buf();
    let fs_reasons = tokio::task::spawn_blocking(move || {
        let mut reasons = Vec::new();
        match std::fs::canonicalize(&candidate) {
            Ok(real) if real == candidate => {}
            _ => reasons.push("It is reached through a link or no longer resolves".to_owned()),
        }
        match mounts() {
            Some(mounts) if mounts.iter().any(|m| m != &candidate && m.starts_with(&candidate)) => {
                reasons.push("A filesystem is mounted inside it".to_owned());
            }
            Some(_) => {}
            None => reasons.push("Mounts cannot be checked on this host".to_owned()),
        }
        match std::fs::File::open(candidate.join(".cargo-lock")) {
            Ok(lock) => match lock.try_lock() {
                Ok(()) => {
                    let _ = lock.unlock();
                }
                Err(std::fs::TryLockError::WouldBlock) => reasons.push("Cargo is building here now".to_owned()),
                Err(std::fs::TryLockError::Error(error)) => reasons.push(format!("Its build lock cannot be checked: {error}")),
            },
            Err(error) => reasons.push(format!("Its build lock cannot be opened: {error}")),
        }
        reasons
    })
    .await
    .unwrap_or_else(|error| vec![format!("It could not be checked: {error}")]);
    reasons.extend(fs_reasons);
    reasons
}

/// Why candidate must stay, from Core's own records: who works in the
/// workspace now and which Job records name the candidate.
async fn record_protections(ws: &Arc<Workspace>, root: &Path, candidate: &Path) -> Vec<String> {
    let (root, candidate) = (root.to_path_buf(), candidate.to_path_buf());
    ws.stored(move |s| {
        let mut reasons = Vec::new();
        for job in s.workspace_live_jobs(&root)? {
            reasons.push(format!("Job {} ({}) is {} in this worktree", job["name"].as_str().unwrap_or(""),
                job["id"].as_str().unwrap_or(""), job["status"].as_str().unwrap_or("")));
        }
        for agent in s.workspace_agents(&root)? {
            if agent["relation"] == "inside" && agent["working"] == true {
                reasons.push(format!("Agent {} is working in this worktree", agent["name"].as_str().unwrap_or("")));
            }
        }
        let jobs = s.workspace_job_references(&candidate)?;
        if !jobs.is_empty() {
            reasons.push(format!("Job records name this folder and are kept as evidence: {}", jobs.join(", ")));
        }
        Ok(reasons)
    })
    .await
    .unwrap_or_else(|error: anyhow::Error| vec![format!("Core's records could not be checked: {error}")])
}

fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    meta.mtime() as i128 * 1_000_000_000 + meta.mtime_nsec() as i128
}

fn free_bytes(path: &Path) -> Option<u64> {
    rustix::fs::statvfs(path).ok().map(|s| s.f_bavail.saturating_mul(s.f_frsize))
}

async fn preview(
    AppState(ws): AppState<Arc<Workspace>>,
    UrlPath((task, id)): UrlPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(preview_cleanup(ws, task, id).await?))
}

async fn preview_cleanup(ws: Arc<Workspace>, task: String, id: String) -> Result<Value> {
    let (task, record) = ws
        .stored(move |s| {
            let (task, _) = s.workspace_task(&*s.db.read()?, &task)?;
            let record = s.task_workspace(&task, &id)?;
            Ok((task, record))
        })
        .await?;
    let root = tokio::task::spawn_blocking({
        let record = record.clone();
        move || unchanged(&record)
    })
    .await??;
    let head = git_facts(&root.path).await?["head"].clone();
    let (paths, kept, bounds) = tokio::task::spawn_blocking({
        let root = root.path.clone();
        move || discover(&root)
    })
    .await?;
    let sizes = tokio::task::spawn_blocking({
        let paths = paths.clone();
        move || {
            let (mut seen, mut budget, deadline) = (HashSet::new(), SIZE_ENTRIES, Instant::now() + SIZE_TIME);
            paths.iter().map(|p| measure(p, &mut seen, &mut budget, deadline)).collect::<Vec<_>>()
        }
    })
    .await?;
    let mut candidates = Vec::new();
    for (index, (path, size)) in paths.iter().zip(sizes).enumerate() {
        let Ok(meta) = std::fs::symlink_metadata(path) else { continue };
        let mut protected = local_protections(&root.path, path).await;
        protected.extend(record_protections(&ws, &root.path, path).await);
        if size["otherDevice"] == true {
            protected.push("Part of it is on another filesystem".to_owned());
        }
        candidates.push(json!({"id": format!("c{index}"), "path": path,
            "relative": path.strip_prefix(&root.path).unwrap_or(path),
            "kind": "Cargo build output (a profile directory: rebuilt by the next build)",
            "dev": meta.dev(), "ino": meta.ino(), "mtimeNs": mtime_ns(&meta).to_string(),
            "estimate": size, "protected": protected}));
    }
    let preview = json!({"id": uuid::Uuid::new_v4().to_string(), "at": now(),
        "expiresAt": (chrono::Utc::now() + chrono::Duration::minutes(PREVIEW_MINUTES)).to_rfc3339(),
        "root": {"path": root.path, "dev": root.dev, "ino": root.ino, "head": head},
        "candidates": candidates, "kept": kept, "bounds": bounds, "freeBytes": free_bytes(&root.path),
        "scope": "Only Cargo profile output is offered. Sizes are estimates of allocated space, each hard-linked file once; files with other links may stay on disk. Removing needs this preview within 10 minutes, your selection, and every check passing again at that moment."});
    ws.stored({
        let (task, id, preview) = (task.clone(), record["id"].as_str().unwrap_or("").to_owned(), preview.clone());
        move |s| s.save_task_workspace_preview(&task, &id, &preview)
    })
    .await?;
    Ok(preview)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Execute {
    preview_id: String,
    candidates: Vec<String>,
}

/// Removes one selected candidate after every check passes again: the
/// folder is renamed aside while its build lock is held, checked to be the
/// one previewed, then removed without following links.
async fn remove_one(ws: &Arc<Workspace>, root: &Path, candidate: &Value) -> Value {
    let path = PathBuf::from(candidate["path"].as_str().unwrap_or(""));
    let mut result = json!({"id": candidate["id"], "relative": candidate["relative"]});
    let refuse = |mut result: Value, why: String| {
        result["state"] = json!("refused");
        result["reason"] = json!(why);
        result
    };
    if !candidate["protected"].as_array().is_none_or(|p| p.is_empty()) {
        return refuse(result, "It was protected in the preview".to_owned());
    }
    let same = std::fs::symlink_metadata(&path).is_ok_and(|m| {
        m.is_dir() && Some(m.dev()) == candidate["dev"].as_u64() && Some(m.ino()) == candidate["ino"].as_u64()
            && candidate["mtimeNs"].as_str() == Some(&mtime_ns(&m).to_string())
    });
    if !same {
        return refuse(result, "It changed since the preview; preview again".to_owned());
    }
    let mut protected = local_protections(root, &path).await;
    protected.extend(record_protections(ws, root, &path).await);
    if !protected.is_empty() {
        return refuse(result, protected.join("; "));
    }
    let (dev, ino) = (candidate["dev"].as_u64(), candidate["ino"].as_u64());
    let outcome = tokio::task::spawn_blocking(move || -> std::result::Result<String, (String, String)> {
        let lock = std::fs::File::open(path.join(".cargo-lock")).map_err(|e| ("refused".to_owned(), format!("Its build lock cannot be opened: {e}")))?;
        lock.try_lock().map_err(|_| ("refused".to_owned(), "Cargo started building here".to_owned()))?;
        let parent = path.parent().ok_or(("refused".to_owned(), "It has no parent folder".to_owned()))?;
        let aside = parent.join(format!("{REMOVING}{}", uuid::Uuid::new_v4()));
        std::fs::rename(&path, &aside).map_err(|e| ("refused".to_owned(), format!("It could not be moved aside: {e}")))?;
        let moved = std::fs::symlink_metadata(&aside).is_ok_and(|m| m.is_dir() && Some(m.dev()) == dev && Some(m.ino()) == ino);
        if !moved {
            let back = std::fs::rename(&aside, &path);
            return Err(("refused".to_owned(), format!("It was replaced while being removed; {}",
                if back.is_ok() { "it was put back".to_owned() } else { format!("it is left at {}", aside.display()) })));
        }
        drop(lock);
        std::fs::remove_dir_all(&aside)
            .map(|()| "removed".to_owned())
            .map_err(|e| ("partial".to_owned(), format!("Removing it stopped: {e}; what remains is at {}", aside.display())))
    })
    .await
    .unwrap_or_else(|error| Err(("failed".to_owned(), error.to_string())));
    match outcome {
        Ok(state) => result["state"] = json!(state),
        Err((state, why)) => {
            result["state"] = json!(state);
            result["reason"] = json!(why);
        }
    }
    result
}

async fn execute(
    AppState(ws): AppState<Arc<Workspace>>,
    UrlPath((task, id)): UrlPath<(String, String)>,
    Json(input): Json<Execute>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(remove_selected(ws, task, id, input).await?))
}

async fn remove_selected(ws: Arc<Workspace>, task: String, id: String, input: Execute) -> Result<Value> {
    ensure!(!input.candidates.is_empty(), "Select what to remove");
    let (record, preview) = ws
        .stored(move |s| {
            let (task, _) = s.workspace_task(&*s.db.read()?, &task)?;
            let record = s.task_workspace(&task, &id)?;
            let preview = s.take_task_workspace_preview(&task, &id, &input.preview_id)?;
            Ok((record, preview))
        })
        .await?;
    let root = tokio::task::spawn_blocking({
        let record = record.clone();
        move || unchanged(&record)
    })
    .await??;
    ensure!(
        preview["root"]["dev"].as_u64() == Some(root.dev) && preview["root"]["ino"].as_u64() == Some(root.ino),
        "The workspace changed since the preview; preview again"
    );
    let head = git_facts(&root.path).await?["head"].clone();
    ensure!(head == preview["root"]["head"], "The workspace's HEAD moved since the preview; preview again");
    let before = free_bytes(&root.path);
    let mut results = Vec::new();
    for wanted in &input.candidates {
        let Some(candidate) = preview["candidates"].as_array().and_then(|all| all.iter().find(|c| c["id"] == *wanted)) else {
            results.push(json!({"id": wanted, "state": "refused", "reason": "Not in this preview"}));
            continue;
        };
        results.push(remove_one(&ws, &root.path, candidate).await);
    }
    let after = free_bytes(&root.path);
    Ok(json!({"results": results, "freeBytesBefore": before, "freeBytesAfter": after,
        "freedBytes": before.zip(after).map(|(b, a)| (a as i128 - b as i128).to_string()),
        "note": "Freed is the filesystem's free space after minus before: other programs writing or deleting at the same time change it too."}))
}

#[cfg(test)]
mod tests;
