//! Cargo build output on this Core's host (T-169, YN-65): which folders are
//! Cargo's, what keeps one, and removing it. Task workspaces
//! (task_workspaces.rs) preview and remove what the user selects with it.
//!
//! Only Cargo profile output is ever removed: a directory with `.cargo-lock`
//! and `.fingerprint` directly inside a Cargo target directory. A target
//! directory is Cargo's by its `CACHEDIR.TAG`, or, where it existed before
//! Cargo ran (scripts/source_build.py and Job scripts make it, and Cargo then
//! writes no tag), by the rustc information Cargo keeps there
//! (`.rustc_info.json`). A name, being ignored by Git or being old never makes
//! anything removable. The walk never follows links and stops at other Git
//! working trees; Git, a running build, a process using it, a mount, a link,
//! a Job, an Agent at work or a Job record naming it keeps a folder; removal renames it aside
//! under its build lock and removes it without following links. Remote
//! machines and Windows are not handled.
use crate::{store::Store, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use rusqlite::params;
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

pub(crate) const GIT_SECONDS: u64 = 8;
const GIT_BYTES: usize = 64 * 1024;
/// The discovery walk: how deep, how many directories, how long.
const WALK_DEPTH: usize = 6;
const WALK_DIRS: usize = 50_000;
const WALK_TIME: Duration = Duration::from_secs(5);
const CACHEDIR_SIGNATURE: &str = "Signature: 8a477f597d28d172789f06886806bc55";
/// A real .rustc_info.json is a few KiB; a larger file is not Cargo's.
const RUSTC_INFO_BYTES: u64 = 1 << 20;
pub(crate) const REMOVING: &str = ".yuzuno-removing-";
const BUILDING: &str = "Cargo is building here now";
/// Build locks a newer Cargo keeps beside .cargo-lock in a profile directory.
const NEWER_LOCKS: [&str; 2] = [".cargo-build-lock", ".cargo-artifact-lock"];
/// The processes named in one reason list; the rest are counted.
const MAX_PROCESSES: usize = 3;

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
pub(crate) async fn git(dir: &Path, args: &[&str]) -> Result<std::result::Result<String, String>> {
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

pub(crate) async fn git_ok(dir: &Path, args: &[&str]) -> Result<String> {
    git(dir, args).await?.map_err(|why| anyhow::anyhow!("git {} failed: {why}", args.join(" ")))
}

impl Store {
    /// Local Agents whose folder is the workspace, inside it, or above it.
    pub(crate) fn workspace_agents(&self, root: &Path) -> Result<Vec<Value>> {
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
    pub(crate) fn workspace_live_jobs(&self, root: &Path) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT id, json_extract(data,'$.name'), status, json_extract(data,'$.cwd'), json_extract(data,'$.taskRef'),
                    json_extract(data,'$.env.CARGO_TARGET_DIR'), json_extract(data,'$.taskId')
             FROM local_jobs WHERE (reserved=1 OR status IN ('queued','waiting')) AND json_extract(data,'$.executor') IS NULL
             ORDER BY seq LIMIT 1000",
        )?;
        let rows = q.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?))
        })?;
        let mut jobs = Vec::new();
        for row in rows {
            let (id, name, status, cwd, task, target, task_id) = row?;
            let target = target.map(|t| cwd.as_deref().map_or(PathBuf::from(&t), |c| Path::new(c).join(&t))).map(real);
            let cwd = cwd.map(|c| real(PathBuf::from(c)));
            if cwd.as_deref().is_some_and(|c| inside(c, root)) || target.as_deref().is_some_and(|t| inside(t, root)) {
                let mut job = json!({"id": id, "name": name, "status": status, "taskId": task_id, "taskRef": task});
                // The key its task has now (T-56); the internal ID stays out of the answer.
                crate::task_keys::refresh(&db, &mut job);
                job.as_object_mut().unwrap().remove("taskId");
                jobs.push(job);
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
}

/// Mount points on this host, from /proc/self/mountinfo; None where it
/// cannot be read (not Linux), so nothing is removed unchecked.
pub(crate) fn mounts() -> Option<Vec<PathBuf>> {
    let unescape = |s: &str| s.replace("\\040", " ").replace("\\011", "\t").replace("\\012", "\n").replace("\\134", "\\");
    let text = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
    Some(text.lines().filter_map(|line| line.split(' ').nth(4).map(|p| PathBuf::from(unescape(p)))).collect())
}

/// Cargo's own files say dir is a Cargo target directory: its CACHEDIR.TAG,
/// or, in one made before Cargo ran and so without a tag, the rustc
/// information Cargo keeps there.
fn cargo_target(dir: &Path) -> bool {
    let tagged = std::fs::read_to_string(dir.join("CACHEDIR.TAG"))
        .is_ok_and(|text| text.starts_with(CACHEDIR_SIGNATURE) && text.to_ascii_lowercase().contains("cargo"));
    tagged || rustc_info(&dir.join(".rustc_info.json"))
}

/// Cargo's rustc information cache: a small regular file holding one JSON
/// object with its `rustc_fingerprint` and an object of `outputs`.
fn rustc_info(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && m.len() <= RUSTC_INFO_BYTES)
        && std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|info| info["rustc_fingerprint"].is_u64() && info["outputs"].is_object())
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
        if cargo_target(&dir) {
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
pub(crate) fn measure(dir: &Path, seen: &mut HashSet<(u64, u64)>, budget: &mut usize, deadline: Instant) -> Value {
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
pub(crate) async fn local_protections(root: &Path, candidate: &Path) -> Vec<String> {
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
                Err(std::fs::TryLockError::WouldBlock) => reasons.push(BUILDING.to_owned()),
                Err(std::fs::TryLockError::Error(error)) => reasons.push(format!("Its build lock cannot be checked: {error}")),
            },
            Err(error) => reasons.push(format!("Its build lock cannot be opened: {error}")),
        }
        // Cargo 1.97 also holds these while it compiles; an older Cargo has none.
        for name in NEWER_LOCKS {
            match std::fs::File::open(candidate.join(name)) {
                Ok(lock) => match lock.try_lock() {
                    Ok(()) => {
                        let _ = lock.unlock();
                    }
                    Err(std::fs::TryLockError::WouldBlock) => {
                        if !reasons.iter().any(|r| r == BUILDING) {
                            reasons.push(BUILDING.to_owned());
                        }
                    }
                    Err(std::fs::TryLockError::Error(error)) => reasons.push(format!("Its build lock {name} cannot be checked: {error}")),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => reasons.push(format!("Its build lock {name} cannot be opened: {error}")),
            }
        }
        match process_users(&candidate) {
            Ok(users) => {
                let more = users.len().saturating_sub(MAX_PROCESSES);
                reasons.extend(users.into_iter().take(MAX_PROCESSES));
                if more > 0 {
                    reasons.push(format!("{more} more processes use it"));
                }
            }
            Err(why) => reasons.push(format!("The processes using it cannot be checked: {why}")),
        }
        reasons
    })
    .await
    .unwrap_or_else(|error| vec![format!("It could not be checked: {error}")]);
    reasons.extend(fs_reasons);
    reasons
}

/// What this host's processes have in dir, one line each: their working
/// folder or root, the program they run, a file they have open or mapped
/// (/proc). `cargo test` and `cargo run` hold no Cargo lock while the program
/// runs, so this is what sees it. Core's own process is left out; a process
/// of another user that this one may not read is not seen. An error where
/// /proc cannot be read at all, so nothing is removed unchecked.
pub(crate) fn process_users(dir: &Path) -> std::result::Result<Vec<String>, String> {
    let entries = std::fs::read_dir("/proc").map_err(|error| format!("/proc cannot be read: {error}"))?;
    let within = |path: &Path| path.starts_with(dir);
    let me = std::process::id();
    let mut users = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
        if pid == me {
            continue;
        }
        let proc = entry.path();
        let linked = |name: &str| std::fs::read_link(proc.join(name)).is_ok_and(|path| within(&path));
        let how = if linked("cwd") {
            Some("its working folder is there")
        } else if linked("root") {
            Some("its root folder is there")
        } else if linked("exe") {
            Some("it runs a program from there")
        } else if std::fs::read_dir(proc.join("fd"))
            .is_ok_and(|fds| fds.flatten().any(|fd| std::fs::read_link(fd.path()).is_ok_and(|path| within(&path))))
        {
            Some("it has a file open there")
        } else if std::fs::read_to_string(proc.join("maps")).is_ok_and(|maps| {
            // A mapped file's path is the rest of its line, from its first '/'.
            maps.lines().filter_map(|line| line.find('/').map(|at| &line[at..])).any(|path| within(Path::new(path)))
        }) {
            Some("it has a file mapped from there")
        } else {
            None
        };
        if let Some(how) = how {
            let name = std::fs::read_to_string(proc.join("comm")).map(|c| c.trim().to_owned()).unwrap_or_default();
            users.push(format!("Process {pid} ({name}) uses it: {how}"));
        }
    }
    users.sort();
    Ok(users)
}

/// Why candidate must stay, from Core's own records: who works in the
/// workspace now and which Job records name the candidate.
pub(crate) async fn record_protections(ws: &Arc<Workspace>, root: &Path, candidate: &Path) -> Vec<String> {
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

pub(crate) fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    meta.mtime() as i128 * 1_000_000_000 + meta.mtime_nsec() as i128
}

pub(crate) fn free_bytes(path: &Path) -> Option<u64> {
    rustix::fs::statvfs(path).ok().map(|s| s.f_bavail.saturating_mul(s.f_frsize))
}

/// Removes one selected candidate after every check passes again: the
/// folder is renamed aside while its build lock is held, checked to be the
/// one previewed, then removed without following links.
pub(crate) async fn remove_one(ws: &Arc<Workspace>, root: &Path, candidate: &Value) -> Value {
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

#[cfg(test)]
mod tests;
