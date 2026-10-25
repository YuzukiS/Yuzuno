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
//! A space budget (slice 5) is optional, and only ever adds to what could
//! be removed: of the latest `keep`, only as many are kept as fit in it
//! together, by the sizes their manifests declare; the newest is kept
//! whatever the budget. A size that can't be trusted makes that backup, and
//! every older one among the latest, impossible to judge. When what stays
//! (the newest, protected backups) declares more than the budget, the
//! preview says so; nothing protected is offered instead. Sizes are those
//! the manifests declare, not disk use; no backup's files are read for them.
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
/// The largest space budget: 1 PiB.
pub const MAX_BUDGET: u64 = 1 << 50;
/// What the sizes are, said with every preview.
pub const SIZE_BASIS: &str = "Sizes are what each backup's manifest declares for its database and files. Disk use can differ (the file system's blocks, compression, links); nothing is measured on disk.";

/// Which backups to keep: the latest `keep`, and with a budget, only as many
/// of those as fit in it together. The newest is kept whatever the budget,
/// and a budget never keeps one the count would not.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rule {
    pub keep: usize,
    pub budget_bytes: Option<u64>,
}

impl From<usize> for Rule {
    fn from(keep: usize) -> Self {
        Rule { keep, budget_bytes: None }
    }
}

/// Whether this Workspace's backups that stay fit in the budget.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub bytes: u64,
    /// met, over (can't be reached without removing what stays), or unknown.
    pub state: &'static str,
    pub reason: String,
    /// What this Workspace's backups that stay declare, those with a size.
    pub kept_estimate_bytes: u64,
}

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
    /// Removable ones whose declared size can't be trusted (not in the sum).
    pub removable_unknown_sizes: usize,
    pub size_basis: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
}

fn entry(name: &str, path: PathBuf, verdict: &'static str, reason: impl Into<String>) -> Entry {
    Entry { name: name.into(), path, verdict, reason: reason.into(), workspace_id: None, created_at: None, estimate_bytes: None, last_checked_at: None, manifest_sha256: None }
}

fn same(value: &Value, path: &Path) -> bool {
    value.as_str().is_some_and(|text| Path::new(text) == path)
}

/// The size a manifest declares, where it can be trusted: a database of no
/// bytes, or sizes too large to add up, can't be.
fn declared_size(read: &super::Manifest) -> Option<u64> {
    if read.database.bytes == 0 {
        return None;
    }
    read.files.iter().try_fold(read.database.bytes, |total, file| total.checked_add(file.bytes))
}

fn size_text(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    let units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value < 10.0 { format!("{value:.1} {}", units[unit]) } else { format!("{value:.0} {}", units[unit]) }
}

/// The preview of keeping, as `rule` says, the backups of Workspace
/// `workspace` in `folder`, given this Core's operations. Reads only.
pub fn preview(folder: &Path, rule: impl Into<Rule>, workspace: &str, operations: &[Operation]) -> Result<Preview> {
    preview_within(folder, rule, workspace, operations, MAX_ENTRIES)
}

pub(crate) fn preview_within(folder: &Path, rule: impl Into<Rule>, workspace: &str, operations: &[Operation], limit: usize) -> Result<Preview> {
    let rule: Rule = rule.into();
    let keep = rule.keep;
    ensure!((1..=MAX_KEEP).contains(&keep), "Keep at least 1 and at most {MAX_KEEP} backups");
    ensure!(rule.budget_bytes.is_none_or(|bytes| (1..=MAX_BUDGET).contains(&bytes)), "A space budget must be more than 0 and at most 1 PiB");
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
        found.estimate_bytes = declared_size(&read);
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
    // What stays whatever the budget is set aside first: this Workspace's
    // backups (and folders that may be its) already protected or unknown, by
    // the sizes they declare. Then the budget is shared out among the latest.
    let reserved = entries.iter().filter(|e| stays_regardless(e, workspace)).filter_map(|e| e.estimate_bytes).fold(0u64, u64::saturating_add);
    let mut verdicts = share(&candidates, rule, Some(reserved));
    // The only checked backup, kept when none of those kept is: with a budget,
    // its size is set aside too, and the budget shared out again. That keeps
    // fewer, none of them checked, so the same one stays protected.
    let protected = only_checked(&candidates, &verdicts);
    if let (Some(index), Some(_)) = (protected, rule.budget_bytes) {
        let size = candidates[index].1.estimate_bytes;
        verdicts = share(&candidates, rule, size.map(|size| reserved.saturating_add(size)));
    }
    let protected = only_checked(&candidates, &verdicts);
    let newest_bytes = candidates.first().and_then(|(_, e)| e.estimate_bytes);
    for (index, ((_, mut found), (verdict, reason))) in candidates.into_iter().zip(verdicts).enumerate() {
        if protected == Some(index) {
            found.verdict = "protected";
            found.reason = "The only backup with a successful check on record; kept until one of the latest is checked".into();
        } else {
            found.verdict = verdict;
            found.reason = reason;
        }
        entries.push(found);
    }
    let removable = || entries.iter().filter(|e| e.verdict == "remove");
    let removable_estimate_bytes = removable().filter_map(|e| e.estimate_bytes).fold(0u64, u64::saturating_add);
    let removable_unknown_sizes = removable().filter(|e| e.estimate_bytes.is_none()).count();
    let budget = rule.budget_bytes.map(|bytes| budget_outcome(&entries, workspace, bytes, newest_bytes));
    Ok(Preview { folder: folder.into(), keep, entries, unreadable_names, removable_estimate_bytes, removable_unknown_sizes, size_basis: SIZE_BASIS, budget })
}

/// An entry already judged that stays whatever is kept, and may be this
/// Workspace's: protected or unknown, and not another Workspace's.
fn stays_regardless(entry: &Entry, workspace: &str) -> bool {
    matches!(entry.verdict, "protected" | "unknown") && entry.workspace_id.as_deref().is_none_or(|id| id == workspace)
}

/// The verdicts for `candidates` (newest first) under `rule`: the latest
/// `keep`, and with a budget only as many as fit in it with `reserved`
/// (None: something that stays has no size to trust). The newest is kept
/// whatever the budget; once one doesn't fit, the older ones go too; once a
/// size can't be trusted, whether the older ones fit can't be judged.
fn share(candidates: &[(DateTime<Utc>, Entry)], rule: Rule, reserved: Option<u64>) -> Vec<(&'static str, String)> {
    let keep = rule.keep;
    let mut total = reserved;
    let mut beyond = false;
    candidates.iter().enumerate().map(|(index, (_, found))| {
        let size = found.estimate_bytes;
        // With a budget, sizes decide: one with no size to trust is never
        // offered for removal, beyond the count or past the budget alike.
        // (The newest is kept whatever its size.)
        if rule.budget_bytes.is_some() && index > 0 && size.is_none() {
            total = None;
            return ("unknown", "Its declared size can't be trusted, so under a space budget it can't be judged, and it is not offered for removal".to_string());
        }
        if index >= keep {
            ("remove", format!("Older than the latest {keep}"))
        } else if let Some(budget) = rule.budget_bytes {
            if index == 0 {
                total = total.zip(size).map(|(t, s)| t.saturating_add(s));
                ("keep", "The newest backup: kept whatever the space budget".into())
            } else if beyond {
                ("remove", "Older than a backup beyond the space budget".into())
            } else {
                match total.zip(size) {
                    Some((t, s)) if t.saturating_add(s) <= budget => {
                        total = Some(t + s);
                        ("keep", format!("One of the latest {keep}, within the space budget"))
                    }
                    Some(_) => {
                        beyond = true;
                        ("remove", format!("Beyond the space budget: with what stays, it would declare more than {}", size_text(budget)))
                    }
                    None => {
                        total = None;
                        ("unknown", "Its declared size, or that of something that stays, can't be trusted, so whether it fits the space budget can't be judged".into())
                    }
                }
            }
        } else {
            ("keep", format!("One of the latest {keep}"))
        }
    }).collect()
}

/// The backup the only-check rule protects: the newest one with a successful
/// check on record that would go, when none that stays has one.
fn only_checked(candidates: &[(DateTime<Utc>, Entry)], verdicts: &[(&'static str, String)]) -> Option<usize> {
    let checked = |index: usize| candidates[index].1.last_checked_at.is_some();
    if (0..candidates.len()).any(|i| verdicts[i].0 != "remove" && checked(i)) {
        return None;
    }
    (0..candidates.len()).find(|&i| verdicts[i].0 == "remove" && checked(i))
}

/// Whether what stays fits in `bytes`: this Workspace's backups that are not
/// removable, by their declared sizes. Another Workspace's backups are not
/// counted; an entry that stays with no size to trust (and may be this
/// Workspace's) makes it unknown.
fn budget_outcome(entries: &[Entry], workspace: &str, bytes: u64, newest_bytes: Option<u64>) -> Budget {
    let stays = |e: &&Entry| matches!(e.verdict, "keep" | "protected" | "unknown") && e.workspace_id.as_deref().is_none_or(|id| id == workspace);
    let kept_estimate_bytes = entries.iter().filter(stays).filter_map(|e| e.estimate_bytes).fold(0u64, u64::saturating_add);
    let without_size = entries.iter().filter(stays).filter(|e| e.estimate_bytes.is_none()).count();
    let (budget, kept) = (size_text(bytes), size_text(kept_estimate_bytes));
    let (state, reason) = if without_size > 0 {
        let stay = if without_size == 1 { "that stays has" } else { "that stay have" };
        ("unknown", format!("{without_size} {stay} no size that can be trusted, so whether this Workspace's backups fit in {budget} can't be confirmed; those with a size declare {kept}"))
    } else if kept_estimate_bytes <= bytes {
        ("met", format!("this Workspace's backups that stay declare {kept} of {budget}"))
    } else {
        let mut why = Vec::new();
        if let Some(newest) = newest_bytes {
            why.push(format!("the newest backup, always kept, declares {}", size_text(newest)));
        }
        for verdict in ["protected", "unknown"] {
            let sizes: Vec<u64> = entries.iter().filter(|e| e.verdict == verdict && e.workspace_id.as_deref() == Some(workspace)).filter_map(|e| e.estimate_bytes).collect();
            if sizes.is_empty() {
                continue;
            }
            let (count, total) = (sizes.len(), size_text(sizes.iter().fold(0u64, |a, b| a.saturating_add(*b))));
            let (one, more) = if verdict == "protected" { ("protected backup declares", "protected backups declare") } else { ("backup that can't be judged declares", "backups that can't be judged declare") };
            why.push(format!("{count} {} {total}", if count == 1 { one } else { more }));
        }
        ("over", format!("what stays declares {kept}, more than {budget} ({}). Nothing protected or always kept is offered instead", why.join("; ")))
    };
    Budget { bytes, state, reason, kept_estimate_bytes }
}

/// The backup `name` in `folder`, judged again now: it must still be one
/// `rule` could remove, with the manifest it had in the preview. The folder
/// must have been read whole.
pub(crate) fn judge(folder: &Path, rule: impl Into<Rule>, name: &str, manifest_sha256: &str, workspace: &str, operations: &[Operation], limit: usize) -> Result<(Preview, Entry)> {
    let preview = preview_within(folder, rule, workspace, operations, limit)?;
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
pub(crate) fn remove(folder: &Path, rule: impl Into<Rule>, name: &str, manifest_sha256: &str, workspace: &str, operations: impl Fn() -> Vec<Operation>, ctl: &Control, limit: usize) -> Result<Value> {
    let rule: Rule = rule.into();
    ctl.at("preview")?;
    let (preview, target) = judge(folder, rule, name, manifest_sha256, workspace, &operations(), limit)?;
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
    judge(folder, rule, name, manifest_sha256, workspace, &operations(), limit)?;
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
    #[serde(default)]
    budget_bytes: Option<u64>,
}

async fn preview_route(State(ws): State<Arc<Workspace>>, Json(body): Json<PreviewRequest>) -> Result<Json<Preview>, ApiError> {
    let folder = online::absolute("folder", &body.folder)?;
    let workspace = ws.stored(|store| store.workspace_id()).await?;
    let operations = ws.backups.all();
    let rule = Rule { keep: body.keep, budget_bytes: body.budget_bytes };
    let answer = tokio::task::spawn_blocking(move || preview(&folder, rule, &workspace, &operations)).await?;
    // The reason travels with the refusal: the page shows it as it is.
    Ok(Json(answer.map_err(|error| anyhow::anyhow!("{error:#}"))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveRequest {
    request_id: String,
    folder: String,
    keep: usize,
    #[serde(default)]
    budget_bytes: Option<u64>,
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
    let rule = Rule { keep: body.keep, budget_bytes: body.budget_bytes };
    if !operations.iter().any(|op| op.request_id == body.request_id) {
        let (f, n, h, w) = (folder.clone(), body.name.clone(), body.manifest_sha256.clone(), workspace.clone());
        let judged = tokio::task::spawn_blocking(move || judge(&f, rule, &n, &h, &w, &operations, MAX_ENTRIES)).await?;
        if let Err(error) = judged {
            return Err(anyhow::anyhow!("{error:#}; nothing was removed").into());
        }
    }
    let mut request = json!({"folder": folder, "keep": body.keep, "name": body.name, "manifestSha256": body.manifest_sha256});
    // Only with a budget, so a count-only request is the one it always was.
    if let Some(bytes) = body.budget_bytes {
        request["budgetBytes"] = json!(bytes);
    }
    let backups = ws.backups.clone();
    let (name, sha256) = (body.name.clone(), body.manifest_sha256.clone());
    Ok(online::started(ws.backups.start("remove", &body.request_id, request, |_| None, move |ctl| {
        remove(&folder, rule, &name, &sha256, &workspace, || backups.all(), ctl, MAX_ENTRIES)
    })))
}
