//! Reclaiming a worktree, and restoring what a cleanup removed (YN-74 ②;
//! design 2.5 step 3, 2.6, cleanup_restore in 2.3).
//!
//! Before a worktree goes, Core pins its HEAD under
//! `refs/yuzuno/reclaimed/<task>/<plan>/<item>` (refs never expire) and keeps
//! a snapshot of what Git would not bring back: its untracked files that are
//! not ignored, the ignored files no cleanup rule recognizes, and, when its
//! item asks for it (`saveDiff`), the diff of the changes Git tracks. A
//! worktree with such changes and no `saveDiff` is never removed. Then it is
//! moved aside, removed without following links, and `git worktree prune`
//! drops Git's record of it; its branch stays. `cleanup_restore` puts it
//! back: `git worktree add` at its path from its branch when that still
//! points at the pinned commit (else detached at the ref), then its
//! snapshot and its diff. Of Git's records only this worktree's own is
//! dropped (`drop_record`), never with `git worktree prune`, which drops
//! every worktree whose folder is away for now, such as one on a drive not
//! mounted (Lead, mail 10748). A scratch entry gets back only the evidence files
//! its snapshot kept. Snapshots are deleted after `snapshotDays` (Settings).
use super::*;
use crate::build_output::{git, git_limited};
use super::check::recognize;

const LIST_BYTES: usize = 16 << 20;
/// A tracked diff larger than this is not kept: the worktree stays.
const DIFF_BYTES: usize = 16 << 20;
const WALK_ENTRIES: usize = 2_000_000;
const WALK_TIME: Duration = Duration::from_secs(20);

/// What a worktree's snapshot would hold: files by their path in it.
#[derive(Debug, Default)]
pub(super) struct Keep {
    pub files: Vec<String>,
    pub bytes: u64,
    pub complete: bool,
}

fn split(text: &str) -> Vec<String> {
    text.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect()
}

/// The files a worktree's snapshot keeps: untracked ones Git does not
/// ignore, and ignored ones under no folder a cleanup rule recognizes. Git
/// names an untracked folder it does not enter (a nested repository) as one
/// `dir/` entry: every file under it is kept (review daaf3749).
pub(super) async fn keep_list(path: &Path, on: &BTreeSet<&'static str>) -> std::result::Result<Keep, String> {
    let untracked = git_limited(path, &["ls-files", "-z", "--others", "--exclude-standard"], LIST_BYTES)
        .await
        .map_err(|e| e.to_string())??;
    let ignored = git_limited(path, &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], LIST_BYTES)
        .await
        .map_err(|e| e.to_string())??;
    let (root, untracked, ignored) = (path.to_path_buf(), split(&untracked), split(&ignored));
    let on = on.clone();
    tokio::task::spawn_blocking(move || {
        let (mut budget, deadline) = (WALK_ENTRIES, Instant::now() + WALK_TIME);
        let mut keep = Keep { complete: true, ..Default::default() };
        let add = |keep: &mut Keep, relative: String, meta: &std::fs::Metadata| {
            keep.bytes += meta.len();
            keep.files.push(relative);
        };
        for relative in untracked.into_iter().chain(ignored) {
            let top = root.join(relative.trim_end_matches('/'));
            let mut stack = vec![top];
            while let Some(at) = stack.pop() {
                if budget == 0 || Instant::now() > deadline {
                    keep.complete = false;
                    break;
                }
                budget -= 1;
                let Ok(meta) = std::fs::symlink_metadata(&at) else { continue };
                if meta.is_dir() {
                    match recognize(&at, &on, true, false) {
                        // Of Cargo's target only its own subtrees are
                        // rebuildable: the rest of it, someone's files or a
                        // clone in tmp, is kept, as a plan's removal keeps
                        // it (Lead activity 8080 P2-2).
                        Ok(Some((super::rules::CARGO, _))) => {
                            let (subtrees, _) = super::check::cargo_profiles(&at);
                            let taken: HashSet<String> = subtrees.iter().filter_map(|s| s["name"].as_str().map(str::to_owned)).collect();
                            if let Ok(entries) = std::fs::read_dir(&at) {
                                stack.extend(entries.flatten().filter(|e| {
                                    let name = e.file_name().to_string_lossy().into_owned();
                                    !taken.contains(&name) && !super::check::CARGO_FILES.contains(&name.as_str())
                                }).map(|e| e.path()));
                            }
                            continue;
                        }
                        // A folder another rule on for this Project recognizes is rebuildable: not kept.
                        Ok(Some(_)) => continue,
                        _ => {}
                    }
                    if let Ok(entries) = std::fs::read_dir(&at) {
                        stack.extend(entries.flatten().map(|e| e.path()));
                    }
                } else if let Ok(relative) = at.strip_prefix(&root) {
                    add(&mut keep, relative.to_string_lossy().into_owned(), &meta);
                }
            }
        }
        keep.files.sort();
        keep
    })
    .await
    .map_err(|e| e.to_string())
}

/// The diff of what Git tracks as changed, against HEAD.
pub(super) async fn tracked_diff(path: &Path) -> std::result::Result<String, String> {
    match git_limited(path, &["diff", "HEAD", "--binary"], DIFF_BYTES).await {
        Ok(Ok(diff)) => Ok(diff),
        Ok(Err(why)) => Err(format!("Git could not diff it: {why}")),
        Err(error) => Err(format!("Its tracked changes cannot be kept: {error}")),
    }
}

/// A worktree's checks when its plan is registered, beyond check.rs's:
/// changes Git tracks need saveDiff, and its snapshot must fit.
pub(super) async fn preflight(path: &Path, save_diff: bool, settings: &Settings, on: &BTreeSet<&'static str>, pre: &mut Value)
    -> Option<(&'static str, String)> {
    let tracked = pre["worktree"]["trackedChanges"].as_u64().unwrap_or(0);
    if tracked > 0 && !save_diff {
        return Some(("trackedChanges", "Git tracks changes in it: keep them in its snapshot (saveDiff) or commit them".into()));
    }
    let keep = match keep_list(path, on).await {
        Ok(keep) => keep,
        Err(why) => return Some(("git", format!("Git could not list what its snapshot keeps: {why}"))),
    };
    if !keep.complete {
        return Some(("tooLarge", "Too large to check within the bounds of a plan".into()));
    }
    let diff = if tracked > 0 {
        match tracked_diff(path).await {
            Ok(diff) => diff.len() as u64,
            Err(why) => return Some(("snapshotTooLarge", why)),
        }
    } else {
        0
    };
    let bytes = keep.bytes + diff;
    pre["snapshot"] = json!({"files": keep.files.len(), "bytes": bytes, "diffBytes": diff});
    if bytes > u64::from(settings.snapshot_max_mib) << 20 {
        return Some(("snapshotTooLarge", format!("Its snapshot would be {:.1} MiB, over the limit of {} MiB (Settings)",
            bytes as f64 / (1u64 << 20) as f64, settings.snapshot_max_mib)));
    }
    None
}

fn sha_of(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!("{:x}", Sha256::digest(std::fs::read(path)?)))
}

/// Writes the snapshot of `root`'s `files` to `out` (tar.gz, links kept as
/// links), with `diff` beside it when there is one.
pub(super) fn write_snapshot(root: &Path, files: &[String], diff: Option<&str>, out: &Path) -> Result<Value> {
    std::fs::create_dir_all(out.parent().context("a snapshot has a folder")?)?;
    let mut record = json!({"at": now(), "files": files.len()});
    if !files.is_empty() {
        let file = std::fs::File::create(out)?;
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::default()));
        tar.follow_symlinks(false);
        let mut bytes = 0u64;
        for relative in files {
            let path = root.join(relative);
            let meta = std::fs::symlink_metadata(&path)?;
            bytes += meta.len();
            tar.append_path_with_name(&path, relative)?;
        }
        let mut written = tar.into_inner()?.finish()?;
        std::io::Write::flush(&mut written)?;
        drop(written);
        record["path"] = json!(out);
        record["sha256"] = json!(sha_of(out)?);
        record["bytes"] = json!(bytes);
    }
    if let Some(diff) = diff.filter(|d| !d.is_empty()) {
        let at = out.with_extension("").with_extension("diff");
        std::fs::write(&at, diff)?;
        record["diff"] = json!({"path": at, "sha256": sha_of(&at)?, "bytes": diff.len()});
    }
    Ok(record)
}

/// `p` without `.` or `..`, its existing part as this host resolves it:
/// the path a worktree's record names may be gone already.
fn settle(p: &Path) -> PathBuf {
    let mut plain = PathBuf::new();
    for part in p.components() {
        match part {
            std::path::Component::ParentDir => {
                plain.pop();
            }
            std::path::Component::CurDir => {}
            other => plain.push(other),
        }
    }
    let mut rest = Vec::new();
    let mut head = plain.clone();
    loop {
        if let Ok(real) = std::fs::canonicalize(&head) {
            return rest.iter().rev().fold(real, |at, name: &std::ffi::OsString| at.join(name));
        }
        match (head.file_name().map(|n| n.to_owned()), head.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                head = parent;
            }
            _ => return plain,
        }
    }
}

/// Drops Git's record of the worktree that was at `path`, and only it: the
/// one folder in `<common>/worktrees/` whose `gitdir` names `<path>/.git`
/// (absolute, or relative to that folder as worktree.useRelativePaths
/// writes it), as `git worktree prune` would for this worktree alone. Kept,
/// with why, while its folder is there, when no record or more than one
/// names it, or when it is locked. Ok(Some(id)): dropped; Ok(None): none.
pub(super) fn drop_record(common: &Path, path: &Path) -> std::result::Result<Option<String>, String> {
    if std::fs::symlink_metadata(path).is_ok() {
        return Err("its folder is still there".into());
    }
    let records = common.join("worktrees");
    let entries = match std::fs::read_dir(&records) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Git's worktree records cannot be read: {error}")),
    };
    let want = settle(&path.join(".git"));
    let mut named = Vec::new();
    for entry in entries.flatten() {
        let record = entry.path();
        if !std::fs::symlink_metadata(&record).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let Ok(gitdir) = std::fs::read_to_string(record.join("gitdir")) else { continue };
        let gitdir = Path::new(gitdir.trim());
        let gitdir = if gitdir.is_absolute() { gitdir.to_path_buf() } else { record.join(gitdir) };
        if settle(&gitdir) == want {
            named.push(record);
        }
    }
    match named.as_slice() {
        [] => Ok(None),
        [record] => {
            if std::fs::symlink_metadata(record.join("locked")).is_ok() {
                return Err(format!("its record {} is locked (git worktree lock)", record.display()));
            }
            let id = record.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            std::fs::remove_dir_all(record).map_err(|e| format!("its record {} could not be removed: {e}", record.display()))?;
            Ok(Some(id))
        }
        more => Err(format!("{} of Git's worktree records name it", more.len())),
    }
}

/// The ref that pins a reclaimed worktree's HEAD.
pub(super) fn ref_name(task: &str, plan: &str, item: &str) -> String {
    let clean = |s: &str| -> String {
        let s: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
        s.trim_matches('-').to_owned()
    };
    format!("refs/yuzuno/reclaimed/{}/{}/{}", clean(task), clean(plan), clean(item))
}

/// Why a worktree was not removed, or only in part: its state or code, why,
/// and what had been made by then (its pinned HEAD, its snapshot), which
/// stay on record whatever happened after (review daaf3749).
pub(super) type NotReclaimed = (&'static str, String, Option<Value>, Option<Value>);

fn before(code: &'static str, why: impl Into<String>) -> NotReclaimed {
    (code, why.into(), None, None)
}

/// What a worktree's removal has made before anything is moved: its HEAD
/// pinned and its snapshot written. An automatic run records both before the
/// first destructive action, so an interruption leaves a restorable item.
#[derive(Clone, Debug)]
pub(super) struct Prepared {
    pub record: Value,
    pub snapshot: Value,
    pub pinned: String,
}

/// Everything before the first destructive action: the snapshot, its HEAD
/// pinned under refs/yuzuno/reclaimed/..., and the record naming both.
#[allow(clippy::too_many_arguments)]
pub(super) async fn prepare(ctx: &check::Context, data: &Path, plan: &str, task: &str, item_id: &str, path: &Path, pre: &Value, now: &Value)
    -> std::result::Result<Prepared, NotReclaimed> {
    let facts = &now["worktree"];
    let save_diff = pre["saveDiff"] == true;
    let tracked = facts["trackedChanges"].as_u64().unwrap_or(0);
    if tracked > 0 && !save_diff {
        return Err(before("trackedChanges", "Git tracks changes in it: keep them in its snapshot (saveDiff) or commit them"));
    }
    let head = facts["head"].as_str().filter(|h| h.len() >= 40).ok_or_else(|| before("git", "Its HEAD is not known"))?.to_owned();
    let keep = keep_list(path, &ctx.on).await.map_err(|why| before("git", format!("Git could not list what its snapshot keeps: {why}")))?;
    if !keep.complete {
        return Err(before("tooLarge", "Too large to check within the bounds of a plan"));
    }
    let diff = if tracked > 0 { Some(tracked_diff(path).await.map_err(|why| before("snapshotTooLarge", why))?) } else { None };
    let bytes = keep.bytes + diff.as_ref().map_or(0, |d| d.len() as u64);
    if bytes > u64::from(ctx.settings.snapshot_max_mib) << 20 {
        return Err(before("snapshotTooLarge", format!("Its snapshot would be {:.1} MiB, over the limit of {} MiB (Settings)",
            bytes as f64 / (1u64 << 20) as f64, ctx.settings.snapshot_max_mib)));
    }
    let out = data.join("cleanup-snapshots").join(plan).join(format!("{item_id}.tar.gz"));
    let snapshot = {
        let (root, files, out) = (path.to_path_buf(), keep.files.clone(), out.clone());
        tokio::task::spawn_blocking(move || write_snapshot(&root, &files, diff.as_deref(), &out))
            .await
            .map_err(|e| before("snapshot", e.to_string()))?
            .map_err(|e| before("snapshot", format!("Its snapshot could not be made: {e:#}")))?
    };
    let pinned = ref_name(task, plan, item_id);
    match git(path, &["update-ref", &pinned, &head]).await {
        Ok(Ok(_)) => {}
        Ok(Err(why)) => return Err(("git", format!("Its HEAD could not be pinned: {why}"), None, Some(snapshot))),
        Err(error) => return Err(("git", format!("Its HEAD could not be pinned: {error}"), None, Some(snapshot))),
    }
    let record = json!({"ref": pinned, "head": head, "branch": facts["branch"]});
    Ok(Prepared { record, snapshot, pinned })
}

/// The first destructive action and what follows it: moved aside, checked to
/// be the same object, removed, and its own Git record dropped.
pub(super) async fn remove_prepared(ctx: &check::Context, path: &Path, pre: &Value, prepared: Prepared)
    -> std::result::Result<(Value, Value), NotReclaimed> {
    let Prepared { mut record, snapshot, pinned } = prepared;
    let (target, dev, ino) = (path.to_path_buf(), pre["dev"].as_u64(), pre["ino"].as_u64());
    let removed = tokio::task::spawn_blocking(move || super::apply::remove_aside(&target, dev, ino))
        .await
        .unwrap_or_else(|e| Err(("failed", e.to_string())));
    // Moved aside, wholly or partly removed: Git's record of it goes
    // either way, and only its own.
    let gone = !matches!(&removed, Err(("refused", _)));
    if gone {
        match drop_record(Path::new(&ctx.common), path) {
            Ok(id) => record["record"] = json!({"dropped": id.is_some(), "id": id}),
            Err(why) => record["record"] = json!({"dropped": false, "kept": why}),
        }
    }
    if let Err((state, why)) = removed {
        return Err((state, format!("{why}; its HEAD stays pinned at {pinned}"), Some(record), Some(snapshot)));
    }
    Ok((record, snapshot))
}

/// Removes a worktree that passed every check: prepared (its HEAD pinned and
/// its snapshot kept), then moved aside and removed.
#[allow(clippy::too_many_arguments)]
pub(super) async fn reclaim(ctx: &check::Context, data: &Path, plan: &str, task: &str, item_id: &str, path: &Path, pre: &Value, now: &Value)
    -> std::result::Result<(Value, Value), NotReclaimed> {
    let prepared = prepare(ctx, data, plan, task, item_id, path, pre, now).await?;
    remove_prepared(ctx, path, pre, prepared).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RestoreInput {
    request_id: String,
    /// A manual plan's id, or an automatic run's id: exactly one.
    #[serde(default)]
    plan_id: Option<String>,
    #[serde(default)]
    run_id: Option<String>,
    item_id: String,
}

pub(super) fn restore_definition() -> Value {
    json!({"name":"cleanup_restore",
        "description":"Put back an item a cleanup removed, wholly or in part, as a lead of its Project (or the user in Settings): a manual cleanup plan names planId, an automatic rule-layer run names runId, and itemId names the item either way. Nothing is put back unless it is a worktree or a scratch entry that was removed or partly removed. A worktree comes back at its path with git worktree add, from its branch when that still points at the commit Core pinned (refs/yuzuno/reclaimed/...) and is checked out nowhere else, else detached at that ref; then its snapshot (untracked and ignored files no rule rebuilds) and its kept diff are put back. A scratch entry gets back only the evidence files its snapshot kept. Refused before anything is made when something is at the path, the snapshot's sha256 changed, or an entry's snapshot expired (snapshotDays, Settings; a worktree's ref never expires); if putting it back fails later, what came back is moved aside so it can be tried again. A retry with the same requestId answers with the same.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["requestId","itemId"],"properties":{
            "requestId":{"type":"string","minLength":1,"maxLength":128,"description":"Stable retry key. Reuse only when retrying exactly this operation and payload."},
            "planId":{"type":"string","description":"The manual cleanup plan's id; give this or runId."},
            "runId":{"type":"string","description":"The automatic rule-layer run's id; give this or planId."},
            "itemId":{"type":"string"}}}})
}

type ItemRow = (String, String, String, Option<String>, Option<String>);
type AutoItemRow = (String, String, String, Option<String>, Option<String>, Option<String>);

enum Origin {
    Plan(String),
    Automatic { run: String, item: String },
}

/// One item a manual plan or an automatic run removed.
struct Removed {
    kind: String,
    path: String,
    state: String,
    result: Value,
    snapshot: Value,
    dir: Option<String>,
    task: Option<String>,
    origin: Origin,
}

/// Unpacks a snapshot after checking it is the one recorded.
fn unpack(snapshot: &Value, into: &Path) -> Result<()> {
    let Some(path) = snapshot["path"].as_str() else { return Ok(()) };
    let path = Path::new(path);
    ensure!(sha_of(path)? == snapshot["sha256"].as_str().unwrap_or_default(), "snapshot_changed: its snapshot is not the one Core kept");
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(std::fs::File::open(path)?));
    archive.set_preserve_permissions(true);
    archive.unpack(into)?;
    Ok(())
}

fn parse(value: Option<String>) -> Value {
    value.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null)
}

pub(super) async fn restore(ws: &Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let input: RestoreInput = serde_json::from_value(input).map_err(|e| anyhow::anyhow!("invalid_input: {e}"))?;
    ensure!((1..=128).contains(&input.request_id.len()), "invalid_input: requestId is 1 to 128 bytes");
    ensure!(input.plan_id.is_some() != input.run_id.is_some(), "invalid_input: give planId for a manual plan, or runId for an automatic run, not both or neither");
    let removed = ws.stored({
        let (actor, plan_id, run_id, item_id) = (actor.clone(), input.plan_id.clone(), input.run_id.clone(), input.item_id.clone());
        move |s| -> Result<Removed> {
            let db = s.db.read()?;
            let projects = crate::projects::all(&db)?;
            match (plan_id, run_id) {
                (Some(plan_id), None) => {
                    let plan = plan(&db, &plan_id)?.context("plan_not_found: no cleanup plan has this ID")?;
                    if let Some(actor) = actor.as_deref() {
                        let lead = match &plan.project {
                            Some(project) => crate::agent_roles::leads(&db, actor, project)?,
                            None => false,
                        };
                        ensure!(lead, "not_allowed: only a lead of the plan's task's Project or the user restores what a cleanup removed");
                    }
                    let row: Option<ItemRow> = db
                        .query_row("SELECT kind,path,state,result,snapshot FROM cleanup_items WHERE plan_id=?1 AND item_id=?2", params![plan_id, item_id],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                        .optional()?;
                    let (kind, path, state, result, snapshot) = row.context("item_not_found: the plan has no such item")?;
                    let dir = projects.iter().find(|p| Some(&p.id) == plan.project.as_ref()).and_then(|p| p.default_dirs.get("local").cloned());
                    Ok(Removed { kind, path, state, result: parse(result), snapshot: parse(snapshot), dir,
                        task: Some(plan.task.clone()), origin: Origin::Plan(plan.id) })
                }
                (None, Some(run_id)) => {
                    let run = db.query_row("SELECT project_id,machine,task_id,state FROM cleanup_automatic_runs WHERE id=?1", [&run_id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?)))
                        .optional()?.context("run_not_found: no automatic run has this ID")?;
                    if let Some(actor) = actor.as_deref() {
                        ensure!(crate::agent_roles::leads(&db, actor, &run.0)?, "not_allowed: only a lead of the run's Project or the user restores what an automatic run removed");
                    }
                    ensure!(run.1 == "local", "remote: an automatic run on another machine cannot be restored here");
                    let row: Option<AutoItemRow> = db
                        .query_row("SELECT kind,path,state,result,snapshot,task_id FROM cleanup_automatic_items WHERE run_id=?1 AND item_id=?2", params![run_id, item_id],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
                        .optional()?;
                    let (kind, path, state, result, snapshot, item_task) = row.context("item_not_found: the run has no such item")?;
                    let dir = projects.iter().find(|p| p.id == run.0).and_then(|p| p.default_dirs.get("local").cloned());
                    Ok(Removed { kind, path, state, result: parse(result), snapshot: parse(snapshot), dir,
                        task: item_task.or(run.2), origin: Origin::Automatic { run: run_id, item: item_id } })
                }
                _ => unreachable!("checked above"),
            }
        }
    })
    .await?;
    if removed.state == "restored" {
        ensure!(removed.result["restored"]["requestId"] == input.request_id.as_str(), "item_restored: it was restored already");
        return Ok(json!({"item": input.item_id, "state": removed.state, "restored": removed.result["restored"]}));
    }
    // Removed, or partly: what went is in its snapshot either way.
    ensure!(matches!(removed.state.as_str(), "removed" | "partial" | "interrupted" | "prepared"),
        "not_removed: only an item a cleanup removed, or an automatic attempt it interrupted, is restored (it is {})", removed.state);
    ensure!(removed.kind == "worktree" || removed.kind == "entry", "not_restorable: a {} item is rebuilt, not restored", removed.kind);
    let target = PathBuf::from(&removed.path);
    ensure!(std::fs::symlink_metadata(&target).is_err(), "path_taken: something is at {} now; move it away first", removed.path);
    // Everything that can be checked before anything is made (review daaf3749).
    let expired = !removed.snapshot["expiredAt"].is_null();
    let usable = removed.snapshot.is_object() && !expired;
    ensure!(removed.kind == "worktree" || usable, "snapshot_expired: its snapshot is gone, so nothing of it can come back");
    if usable {
        for (file, sha) in [(&removed.snapshot["path"], &removed.snapshot["sha256"]), (&removed.snapshot["diff"]["path"], &removed.snapshot["diff"]["sha256"])] {
            if let Some(file) = file.as_str() {
                let actual = sha_of(Path::new(file)).map_err(|e| anyhow::anyhow!("snapshot_changed: its snapshot cannot be read: {e}"))?;
                ensure!(Some(actual.as_str()) == sha.as_str(), "snapshot_changed: its snapshot is not the one Core kept");
            }
        }
    }
    let project = removed.dir.clone().map(PathBuf::from);
    let mut how = Vec::new();
    if removed.kind == "worktree" {
        let project = project.clone().context("project_folder_missing: its Project has no folder on this host")?;
        let pinned = removed.result["ref"].as_str().context("no_ref: Core pinned no commit for it")?;
        let head = removed.result["head"].as_str().unwrap_or_default();
        // A record its reclaim could not drop would refuse the path: only
        // that one goes, never another worktree's.
        let common = git(&project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?
            .map_err(|why| anyhow::anyhow!("project_not_git: {why}"))?;
        let common = PathBuf::from(common.trim());
        if let Err(why) = drop_record(&common, &target) {
            bail!("restore_failed: Git still has a record of a worktree at {}, which Core keeps: {why}", removed.path);
        }
        let branch = removed.result["branch"].as_str().filter(|b| !b.is_empty());
        let tip = match branch {
            Some(b) => git(&project, &["rev-parse", "--verify", "-q", &format!("refs/heads/{b}")]).await?.ok().map(|t| t.trim().to_owned()),
            None => None,
        };
        let listed = git_limited(&project, &["worktree", "list", "--porcelain"], LIST_BYTES).await?.unwrap_or_default();
        let checked_out = |b: &str| listed.lines().any(|l| l == format!("branch refs/heads/{b}"));
        let added = match (branch, tip.as_deref()) {
            (Some(b), Some(tip)) if tip == head && !checked_out(b) => {
                how.push(format!("checked out its branch {b}"));
                git(&project, &["worktree", "add", removed.path.as_str(), b]).await?
            }
            _ => {
                how.push(format!("detached at {pinned}"));
                git(&project, &["worktree", "add", "--detach", removed.path.as_str(), pinned]).await?
            }
        };
        if let Err(why) = added {
            bail!("restore_failed: git worktree add failed: {why}");
        }
    }
    let put_back = async {
        if usable {
            let into = if removed.kind == "entry" { target.parent().map(Path::to_path_buf).context("an entry has a folder")? } else { target.clone() };
            let snap = removed.snapshot.clone();
            tokio::task::spawn_blocking(move || unpack(&snap, &into)).await??;
            if removed.snapshot["path"].is_string() {
                how.push(format!("{} file(s) of its snapshot put back", removed.snapshot["files"]));
            }
            if let Some(diff) = removed.snapshot["diff"]["path"].as_str() {
                match git(&target, &["apply", "--binary", diff]).await? {
                    Ok(_) => how.push("its tracked changes applied again".to_owned()),
                    Err(why) => how.push(format!("its tracked changes could not be applied: {why}")),
                }
            }
        } else if expired {
            how.push("its snapshot had expired: only what Git keeps came back".to_owned());
        }
        Ok::<(), anyhow::Error>(())
    };
    if let Err(error) = put_back.await {
        // What came back moves aside, so the path is free to try again;
        // nothing is removed.
        let aside = target.with_file_name(format!(".yuzuno-restore-failed-{}", uuid::Uuid::new_v4()));
        let moved = std::fs::rename(&target, &aside).is_ok();
        if let (true, Some(project)) = (moved && removed.kind == "worktree", project.as_ref()) {
            // The record of what came back names the path again: only it goes.
            if let Ok(Ok(common)) = git(project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await {
                let _ = drop_record(Path::new(common.trim()), &target);
            }
        }
        let failed = json!({"at": now(), "why": format!("{error:#}"), "aside": moved.then(|| aside.clone())});
        let (store, origin, item_id) = (ws.store.clone(), match &removed.origin {
            Origin::Plan(id) => Origin::Plan(id.clone()),
            Origin::Automatic { run, item } => Origin::Automatic { run: run.clone(), item: item.clone() },
        }, input.item_id.clone());
        let _ = crate::db::blocking(move || -> Result<()> {
            let db = store.db.write()?;
            match origin {
                Origin::Plan(plan) => {
                    db.execute("UPDATE cleanup_items SET result=json_set(COALESCE(result,'{}'),'$.restoreFailed',json(?3)),updated_at=?4
                        WHERE plan_id=?1 AND item_id=?2", params![plan, item_id, failed.to_string(), now()])?;
                }
                Origin::Automatic { run, item } => {
                    db.execute("UPDATE cleanup_automatic_items SET result=json_set(COALESCE(result,'{}'),'$.restoreFailed',json(?3)),updated_at=?4
                        WHERE run_id=?1 AND item_id=?2", params![run, item, failed.to_string(), now()])?;
                }
            }
            Ok(())
        })
        .await;
        bail!("restore_failed: {error:#}; {}", if moved { format!("what came back was moved to {}, so restoring can be tried again", aside.display()) } else { format!("what came back is still at {}", removed.path) });
    }
    let by = actor.clone().map_or_else(|| "user".to_owned(), |a| format!("agent:{a}"));
    let restored = json!({"at": now(), "by": by, "how": how, "requestId": input.request_id});
    let answer = json!({"item": input.item_id, "state": "restored", "path": removed.path, "restored": restored});
    ws.stored(move |s| {
        let mut db = s.db.write()?;
        let tx = db.transaction()?;
        let (author, source) = collaboration::actor_context(s, &tx, actor.as_deref())?;
        let body = format!("Restored {} (item {}): {}.", removed.path, input.item_id,
            restored["how"].as_array().map(|h| h.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")).unwrap_or_default());
        match &removed.origin {
            Origin::Plan(plan_id) => {
                tx.execute("UPDATE cleanup_items SET state='restored',result=json_set(COALESCE(result,'{}'),'$.restored',json(?3)),updated_at=?4
                    WHERE plan_id=?1 AND item_id=?2 AND state IN ('removed','partial')", params![plan_id, input.item_id, restored.to_string(), now()])?;
                collaboration::activity(&tx, removed.task.as_deref().unwrap_or_default(), "comment", &author,
                    &json!({"cleanupPlan": {"planId": plan_id}, "agent": source}), json!({"body": body}))?;
            }
            Origin::Automatic { run, item } => {
                tx.execute("UPDATE cleanup_automatic_items SET state='restored',result=json_set(COALESCE(result,'{}'),'$.restored',json(?3)),updated_at=?4
                    WHERE run_id=?1 AND item_id=?2 AND state IN ('removed','partial','interrupted','prepared')", params![run, item, restored.to_string(), now()])?;
                // No task, no activity: the automatic history keeps it.
                if let Some(task) = removed.task.as_deref().filter(|task| tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM collaboration_tasks WHERE id=?1)", [task], |r| r.get::<_, bool>(0)).unwrap_or(false)) {
                    collaboration::activity(&tx, task, "comment", &author,
                        &json!({"cleanupAutomatic": {"runId": run}, "agent": source}), json!({"body": body}))?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    Ok(answer)
}

/// Snapshots older than `snapshotDays` are deleted; what they were stays on
/// record, and a worktree's ref stays. Only files under Core's own snapshot
/// folder are touched.
pub(super) fn expire_snapshots(store: &Store, data: &Path) -> Result<usize> {
    let folder = data.join("cleanup-snapshots");
    let (days, rows) = {
        let db = store.db.read()?;
        let days = settings::read(&db)?.snapshot_days;
        let mut q = db.prepare("SELECT plan_id,item_id,snapshot,updated_at FROM cleanup_items WHERE snapshot IS NOT NULL AND json_extract(snapshot,'$.expiredAt') IS NULL")?;
        let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
        (days, rows.collect::<rusqlite::Result<Vec<_>>>()?)
    };
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days.into());
    let mut expired = 0;
    for (plan, item, raw, updated) in rows {
        let Ok(snapshot) = serde_json::from_str::<Value>(&raw) else { continue };
        let at = snapshot["at"].as_str().unwrap_or(&updated);
        if !chrono::DateTime::parse_from_rfc3339(at).is_ok_and(|at| at < cutoff) {
            continue;
        }
        for file in [snapshot["path"].as_str(), snapshot["diff"]["path"].as_str()].into_iter().flatten() {
            let file = Path::new(file);
            if file.starts_with(&folder) && file.parent().is_some_and(|p| p.parent() == Some(folder.as_path())) {
                let _ = std::fs::remove_file(file);
            }
        }
        if let Some(dir) = folder.join(&plan).to_str() {
            let _ = std::fs::remove_dir(dir);
        }
        store.db.write()?.execute(
            "UPDATE cleanup_items SET snapshot=json_set(snapshot,'$.expiredAt',?3) WHERE plan_id=?1 AND item_id=?2",
            params![plan, item, now()],
        )?;
        expired += 1;
    }
    // An automatic run's snapshots expire the same way; its ref stays.
    let auto: Vec<(String, String, String, String)> = {
        let db = store.db.read()?;
        let mut q = db.prepare("SELECT run_id,item_id,snapshot,updated_at FROM cleanup_automatic_items
            WHERE snapshot IS NOT NULL AND json_extract(snapshot,'$.expiredAt') IS NULL")?;
        let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for (run, item, raw, updated) in auto {
        let Ok(snapshot) = serde_json::from_str::<Value>(&raw) else { continue };
        let at = snapshot["at"].as_str().unwrap_or(&updated);
        if !chrono::DateTime::parse_from_rfc3339(at).is_ok_and(|at| at < cutoff) {
            continue;
        }
        for file in [snapshot["path"].as_str(), snapshot["diff"]["path"].as_str()].into_iter().flatten() {
            let file = Path::new(file);
            if file.starts_with(&folder) && file.parent().is_some_and(|p| p.parent() == Some(folder.as_path())) {
                let _ = std::fs::remove_file(file);
            }
        }
        if let Some(dir) = folder.join(&run).to_str() {
            let _ = std::fs::remove_dir(dir);
        }
        store.db.write()?.execute(
            "UPDATE cleanup_automatic_items SET snapshot=json_set(snapshot,'$.expiredAt',?3) WHERE run_id=?1 AND item_id=?2",
            params![run, item, now()],
        )?;
        expired += 1;
    }
    Ok(expired)
}
