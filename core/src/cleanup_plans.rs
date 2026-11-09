//! Workspace cleanup plans (YN-74; design YN-72 v3, section 2).
//!
//! Removing anything a cleanup decides goes through Core alone. A task's
//! executor registers a plan (`cleanup_plan_submit`): groups, each with a
//! decision (delete, rebuildable, keep, ask), and items, each of a kind:
//!
//! - `entry`: a first-level entry of a scratch root the user set in Settings;
//! - `cache-dir`: a folder a rule recognizes as rebuildable (this Core's
//!   rules: a Cargo target folder, of which only Cargo's own profiles go, and
//!   a CACHEDIR.TAG), inside this Project's folder or a worktree of it, where
//!   Git must ignore it, or inside a scratch root;
//! - `worktree`: a worktree this Project's repository lists (`git worktree
//!   list`), wherever it is, unless it is the main one or locked.
//!
//! What is never removed whatever the settings say (`check::FIXED`) is fixed
//! here; the user's protected paths are a setting. A group's decision must
//! fit its items' kinds, or the whole plan is refused: a rebuildable group
//! holds only cache-dir items, and a worktree goes only in a delete group or
//! one that keeps or asks. Each item is checked when the plan is registered;
//! what fails is refused with why, and the rest is recorded as it is then.
//! Core then summarizes each group from those checks alone (`summary`), and
//! the plan's sha256 covers its items, their checks and that summary.
//!
//! A plan is valid for `planHours` (Settings), and a newer plan of its task
//! cancels it. Only the user's approval of its groups on Home, read by Core
//! itself, lets its executor apply it (`apply`).
use crate::{
    collaboration_store::{self as collaboration, TaskActor},
    model::now,
    server::ApiError,
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Context as _, Result};
use axum::{
    extract::{Path as UrlPath, State as AppState},
    routing::get,
    Json, Router,
};
use futures_util::StreamExt as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

mod apply;
mod check;
mod inventory;
mod rules;
mod settings;
mod summary;
mod worktrees;

pub(crate) use check::HostEnv;
pub(crate) use settings::Settings;

/// Groups one plan holds: a Brief ask's field offers at most 12 options, and
/// the user approves the plan's groups with one.
pub(crate) const MAX_GROUPS: usize = 12;
pub(crate) const DECISIONS: [&str; 4] = ["delete", "rebuildable", "keep", "ask"];
pub(crate) const KINDS: [&str; 3] = ["entry", "cache-dir", "worktree"];
/// Items one plan's checks run at once.
const PARALLEL: usize = 8;
/// Refused items a registration's answer names; cleanup_plan_get pages the rest.
const ANSWER_REFUSED: usize = 20;
const PAGE: usize = 20;
const MAX_PAGE: usize = 100;

/// Test switches: the host's limits, its mounts (None inside: they cannot
/// be read), and the decision/kind check (design 7).
#[derive(Default)]
pub(crate) struct State {
    #[cfg(test)]
    pub env: std::sync::Mutex<Option<HostEnv>>,
    #[cfg(test)]
    pub mounts: std::sync::Mutex<Option<Option<Vec<PathBuf>>>>,
    #[cfg(test)]
    pub skip_kind_check: std::sync::atomic::AtomicBool,
    /// The processes using a folder cannot be read (as without /proc).
    #[cfg(test)]
    pub processes_unavailable: std::sync::atomic::AtomicBool,
    /// The python3 this host's inventory probe runs (a stand-in).
    #[cfg(test)]
    pub python: std::sync::Mutex<Option<String>>,
    /// The OpenSSH program a remote inventory's probe calls (a stand-in).
    #[cfg(test)]
    pub ssh: std::sync::Mutex<Option<String>>,
}

impl State {
    fn env(&self) -> HostEnv {
        #[cfg(test)]
        if let Some(env) = self.env.lock().unwrap().clone() {
            return env;
        }
        HostEnv::of_process()
    }

    fn mounts(&self) -> Option<Vec<PathBuf>> {
        #[cfg(test)]
        if let Some(mounts) = self.mounts.lock().unwrap().clone() {
            return mounts;
        }
        crate::build_output::mounts()
    }

    fn processes_unavailable(&self) -> bool {
        #[cfg(test)]
        if self.processes_unavailable.load(std::sync::atomic::Ordering::SeqCst) {
            return true;
        }
        false
    }

    fn python_program(&self) -> String {
        #[cfg(test)]
        if let Some(program) = self.python.lock().unwrap().clone() {
            return program;
        }
        "python3".to_owned()
    }

    fn ssh_program(&self) -> String {
        #[cfg(test)]
        if let Some(program) = self.ssh.lock().unwrap().clone() {
            return program;
        }
        crate::jobs::SSH_PROGRAM.to_owned()
    }

    fn kind_check(&self) -> bool {
        #[cfg(test)]
        if self.skip_kind_check.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        true
    }
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS cleanup_settings(scope TEXT PRIMARY KEY, data TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS cleanup_plans(
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT, author_agent TEXT NOT NULL, request_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('submitted','applying','applied','expired','cancelled')),
            sha256 TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT, approval TEXT,
            data TEXT NOT NULL, UNIQUE(author_agent, request_id));
         CREATE INDEX IF NOT EXISTS cleanup_plans_task ON cleanup_plans(task_id, created_at);
         CREATE TABLE IF NOT EXISTS cleanup_items(
            plan_id TEXT NOT NULL REFERENCES cleanup_plans(id) ON DELETE CASCADE, item_id TEXT NOT NULL, seq INTEGER NOT NULL,
            group_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
            pre TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','removed','kept','refused','partial','failed','restored')),
            result TEXT, snapshot TEXT, ref TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(plan_id, item_id));",
    )?;
    Ok(())
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/cleanup/settings", get(settings::http_read).put(settings::http_change))
        .route("/api/tasks/{task}/cleanup-plan", get(http_plan))
        .route("/api/cleanup/plans/{plan}/items/{item}/restore", axum::routing::post(http_restore))
}

pub(crate) const TOOLS: [&str; 5] = ["cleanup_inventory", "cleanup_plan_submit", "cleanup_plan_get", "cleanup_apply", "cleanup_restore"];

pub(crate) fn tool_definitions() -> Vec<Value> {
    let request = json!({"type":"string","minLength":1,"maxLength":128,"description":"Stable retry key. Reuse only when retrying exactly this operation and payload."});
    let text = |max: u32| json!({"type":"string","maxLength":max});
    let id = json!({"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$"});
    vec![
        inventory::tool_definition(),
        json!({"name":"cleanup_plan_submit",
            "description":"Register a workspace cleanup plan for your own task, as its executor; nothing is removed. groups (1-12) each have a decision: delete (entry and worktree items), rebuildable (only cache-dir items a rule recognizes), keep or ask (any kind; never executed). A decision that does not fit its items' kinds refuses the whole plan. items: entry, a first-level entry of a scratch root in Settings; cache-dir, a folder a rule on for this Project recognizes (a CACHEDIR.TAG; Cargo's target folder, of which only what Cargo makes goes; an ecosystem's folder beside its manifest, such as node_modules with a lockfile: Settings lists them), Git-ignored with nothing tracked inside this Project's folder or a worktree of it, or inside a scratch root; worktree, one this Project's repository lists (git worktree list), not the main one, not locked. Core checks each item now: never Core's data, $HOME or its first level, $XDG_CACHE_HOME, ~/Library on macOS, another Project, this Project's folder or main worktree, links, mounts, other users' files, or a protected path; nothing written within freshDays (an entry: evidenceDays). An item failing a check is refused with why. Core then summarizes each group from its checks alone, not from your labels: the user approves groups by that summary. inventory names the artifact of this task's cleanup_inventory Job the plan comes from (no other Job is one); a plan from another machine's inventory is registered with every item refused. The answer has planId, sha256 (over the items, their checks and the summary), each group's summary and up to 20 refused items. Valid for planHours (Settings); a newer plan of the task cancels it. At most maxItems items (Settings) and 128 KiB.",
            "inputSchema":{"type":"object","additionalProperties":false,"required":["requestId","taskId","title","inventory","groups","items"],"properties":{
                "requestId":request,
                "taskId":{"type":"string","description":collaboration::TASK_ID},
                "title":{"type":"string","minLength":1,"maxLength":200},
                "inventory":{"type":"object","additionalProperties":false,"required":["jobId","attempt","path","sha256"],"properties":{
                    "jobId":{"type":"string"},"attempt":{"type":"string"},"path":{"type":"string"},"sha256":{"type":"string"}}},
                "groups":{"type":"array","minItems":1,"maxItems":MAX_GROUPS,"items":{"type":"object","additionalProperties":false,"required":["id","label","decision"],"properties":{
                    "id":id,"label":{"type":"string","minLength":1,"maxLength":120},"decision":{"type":"string","enum":DECISIONS},"reason":text(500)}}},
                "items":{"type":"array","minItems":1,"maxItems":settings::MAX_ITEMS,"items":{"type":"object","additionalProperties":false,"required":["id","group","kind","path"],"properties":{
                    "id":id,"group":{"type":"string"},"kind":{"type":"string","enum":KINDS},"rule":{"type":"string","maxLength":48,"description":"cache-dir only: the rule you expect; Core decides."},
                    "path":{"type":"string","minLength":1,"maxLength":4096},"reason":text(500),"saveDiff":{"type":"boolean","description":"worktree only: keep its git diff in its snapshot."}}}}}}}),
        json!({"name":"cleanup_plan_get",
            "description":"Read a cleanup plan: its state (submitted, applying, applied, expired, cancelled), sha256, expiry and each group with your label and reason beside Core's own summary of it (kinds, bytes, worktrees, commits found on no remote branch, changes, snapshots, refusals, categories, warnings, largest paths). view items pages its items with each one's state, Core's category and why it was refused. Its task's executor, a lead of its Project or the user may read it.",
            "inputSchema":{"type":"object","additionalProperties":false,"required":["planId"],"properties":{
                "planId":{"type":"string"},"view":{"type":"string","enum":["summary","items"],"default":"summary"},
                "afterItem":{"type":"string","description":"items: the item after which the page starts (nextAfterItem)."},
                "limit":{"type":"integer","minimum":1,"maximum":MAX_PAGE,"default":PAGE}}}}),
        apply::tool_definition(),
        worktrees::restore_definition(),
    ]
}

pub(crate) async fn call(ws: Arc<Workspace>, actor: Option<String>, operation: String, input: Value) -> Result<Value> {
    match operation.as_str() {
        "cleanup_inventory" => inventory::inventory(&ws, actor, input).await,
        "cleanup_plan_submit" => submit(&ws, actor, input).await,
        "cleanup_apply" => apply::apply(&ws, actor, input).await,
        "cleanup_restore" => worktrees::restore(&ws, actor, input).await,
        "cleanup_plan_get" => {
            let get: GetInput = serde_json::from_value(input).map_err(|e| anyhow::anyhow!("invalid_input: {e}"))?;
            ws.stored(move |s| plan_get(s, actor.as_deref(), &get)).await
        }
        _ => bail!("unknown_tool: {operation}"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitInput {
    request_id: String,
    task_id: String,
    title: String,
    inventory: Inventory,
    groups: Vec<GroupInput>,
    items: Vec<ItemInput>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inventory {
    job_id: String,
    attempt: String,
    path: String,
    sha256: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupInput {
    id: String,
    label: String,
    decision: String,
    #[serde(default)]
    reason: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemInput {
    id: String,
    group: String,
    kind: String,
    #[serde(default)]
    rule: Option<String>,
    path: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    save_diff: Option<bool>,
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn chars(text: &str, max: usize) -> bool {
    text.chars().count() <= max
}

/// The plan's shape and, unless switched off in a test, that each group's
/// decision fits its items' kinds (design 2.3a).
fn validate(input: &SubmitInput, kind_check: bool) -> Result<()> {
    ensure!((1..=128).contains(&input.request_id.len()), "invalid_input: requestId is 1 to 128 bytes");
    ensure!(!input.title.trim().is_empty() && chars(&input.title, 200), "invalid_input: title is 1 to 200 characters");
    ensure!((1..=MAX_GROUPS).contains(&input.groups.len()), "invalid_input: a plan has 1 to {MAX_GROUPS} groups");
    ensure!(!input.items.is_empty(), "invalid_input: a plan has at least one item");
    let mut groups = BTreeMap::new();
    for group in &input.groups {
        ensure!(valid_id(&group.id), "invalid_input: group id {:?} is 1 to 64 letters, digits, _ . or -", group.id);
        ensure!(!group.label.trim().is_empty() && chars(&group.label, 120), "invalid_input: group {} needs a label of 1 to 120 characters", group.id);
        ensure!(chars(&group.reason, 500), "invalid_input: group {}'s reason is at most 500 characters", group.id);
        ensure!(DECISIONS.contains(&group.decision.as_str()), "invalid_input: group {}'s decision is one of {}", group.id, DECISIONS.join(", "));
        ensure!(groups.insert(group.id.as_str(), group.decision.as_str()).is_none(), "invalid_input: group id {} is used twice", group.id);
    }
    let (mut ids, mut paths) = (HashSet::new(), HashSet::new());
    for item in &input.items {
        ensure!(valid_id(&item.id), "invalid_input: item id {:?} is 1 to 64 letters, digits, _ . or -", item.id);
        ensure!(ids.insert(item.id.as_str()), "invalid_input: item id {} is used twice", item.id);
        ensure!(paths.insert(item.path.as_str()), "invalid_input: item {} repeats another item's path", item.id);
        let Some(decision) = groups.get(item.group.as_str()) else { bail!("invalid_input: item {} names no group of the plan", item.id) };
        ensure!(KINDS.contains(&item.kind.as_str()), "invalid_input: item {}'s kind is one of {}", item.id, KINDS.join(", "));
        ensure!(!item.path.is_empty() && item.path.len() <= 4096, "invalid_input: item {}'s path is 1 to 4096 bytes", item.id);
        ensure!(chars(&item.reason, 500), "invalid_input: item {}'s reason is at most 500 characters", item.id);
        ensure!(item.rule.is_none() || item.kind == "cache-dir", "invalid_input: item {}: only a cache-dir item names a rule", item.id);
        ensure!(item.rule.as_deref().is_none_or(|r| (1..=48).contains(&r.len())), "invalid_input: item {}'s rule is 1 to 48 bytes", item.id);
        ensure!(item.save_diff.is_none() || item.kind == "worktree", "invalid_input: item {}: only a worktree item takes saveDiff", item.id);
        if kind_check {
            let fits = match *decision {
                "rebuildable" => item.kind == "cache-dir",
                "delete" => matches!(item.kind.as_str(), "entry" | "worktree"),
                _ => true,
            };
            ensure!(
                fits,
                "kind_mismatch: item {} ({}) is in group {} whose decision is {}: a rebuildable group holds only cache-dir items a rule recognizes, a delete group entry and worktree items, and keep or ask any. Nothing was registered.",
                item.id, item.kind, item.group, decision
            );
        }
    }
    Ok(())
}

fn sha256(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// What one registration needs from the records before any item is checked.
struct Prepared {
    task: String,
    project: String,
    project_dir: Option<String>,
    others: Vec<String>,
    settings: Settings,
    author: TaskActor,
    source: Value,
    inventory: Value,
    /// The machine of the inventory's Job, when it is not this Core's host.
    remote: Option<String>,
}

enum Earlier {
    Answer(Value),
    New(Box<Prepared>),
}

/// The plan its author registered with this requestId, if any.
fn earlier(db: &Connection, author: &str, request: &str, digest: &str) -> Result<Option<Value>> {
    let row: Option<(String, String)> = db
        .query_row("SELECT id, json_extract(data,'$.requestDigest') FROM cleanup_plans WHERE author_agent=?1 AND request_id=?2",
            params![author, request], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((id, same)) = row else { return Ok(None) };
    ensure!(same == digest, "idempotency_conflict: requestId already registered another cleanup plan");
    Ok(Some(submit_answer(db, &id)?))
}

fn prepare(store: &Store, actor: &str, input: &SubmitInput, digest: &str) -> Result<Earlier> {
    let db = store.db.read()?;
    let (task, _) = collaboration::task_key(&db, &input.task_id)?;
    let own: Option<Option<String>> = db
        .query_row("SELECT task_id FROM agent_roles WHERE agent_id=?1 AND kind='executor' AND archived_at IS NULL", [actor], |r| r.get(0))
        .optional()?;
    ensure!(own.flatten().as_deref() == Some(task.as_str()),
        "not_executor: only {}'s own open executor registers a cleanup plan for it", input.task_id);
    if let Some(answer) = earlier(&db, actor, &input.request_id, digest)? {
        return Ok(Earlier::Answer(answer));
    }
    let settings = settings::read(&db)?;
    ensure!(input.items.len() <= settings.max_items as usize, "invalid_input: a plan holds at most {} items (Settings)", settings.max_items);
    let applying: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM cleanup_plans WHERE task_id=?1 AND state='applying')", [&task], |r| r.get(0))?;
    ensure!(!applying, "plan_applying: a plan of this task is being applied; register the next one when it has finished");
    let project: Option<String> = db.query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task], |r| r.get(0)).optional()?;
    let project = project.context("no_project: the task is in no Project, so no folder of it can be cleaned")?;
    // Through the connection held: without WAL a second read would ask for the writer again (db.rs).
    let projects = crate::projects::all(&db)?;
    let project_dir = projects.iter().find(|p| p.id == project).and_then(|p| p.default_dirs.get("local").cloned());
    let others = projects.iter().filter(|p| p.id != project).filter_map(|p| p.default_dirs.get("local").cloned()).collect();
    let reference = json!({"jobId": input.inventory.job_id, "attempt": input.inventory.attempt, "path": input.inventory.path,
        "sha256": input.inventory.sha256});
    let inventory = collaboration::result_outcome::matched(&db, &task, "inventory", &reference)?;
    let job: Value = db
        .query_row("SELECT data FROM local_jobs WHERE id=?1", [&input.inventory.job_id], |r| r.get::<_, String>(0))
        .optional()?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let target = job["target"]["kind"].as_str().unwrap_or("local");
    // Only an inventory Core took of this Project's folder on that machine
    // (inventory.rs `core_inventory`, the same check as a retry's).
    let machine = if target == "local" { "local" } else { job["target"]["machineId"].as_str().unwrap_or_default() };
    let folder = projects.iter().find(|p| p.id == project).and_then(|p| p.default_dirs.get(machine).cloned());
    let folder = folder.with_context(|| format!("invalid_input: inventory: the task's Project has no folder on the inventory's machine {machine}"))?;
    inventory::core_inventory(&job, &folder).map_err(|why| anyhow::anyhow!("invalid_input: inventory: {why}"))?;
    let remote = (target != "local").then(|| inventory["machineName"].as_str().unwrap_or("another machine").to_owned());
    let (author, source) = collaboration::actor_context(store, &db, Some(actor))?;
    Ok(Earlier::New(Box::new(Prepared { task, project, project_dir, others, settings, author, source, inventory: reference, remote })))
}

async fn submit(ws: &Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let digest = sha256(&input.to_string());
    let parsed: SubmitInput = serde_json::from_value(input).map_err(|e| anyhow::anyhow!("invalid_input: {e}"))?;
    validate(&parsed, ws.cleanup.kind_check())?;
    let actor = actor.context("not_executor: only a task's own executor registers a cleanup plan for it")?;
    let parsed = Arc::new(parsed);
    let prepared = ws.stored({
        let (actor, parsed, digest) = (actor.clone(), parsed.clone(), digest.clone());
        move |s| prepare(s, &actor, &parsed, &digest)
    })
    .await?;
    let prepared = match prepared {
        Earlier::Answer(answer) => return Ok(answer),
        Earlier::New(prepared) => prepared,
    };
    let items: Vec<check::Item> = parsed
        .items
        .iter()
        .map(|i| check::Item { id: i.id.clone(), group: i.group.clone(), kind: i.kind.clone(), rule: i.rule.clone(),
            path: i.path.clone(), save_diff: i.save_diff == Some(true) })
        .collect();
    let checked: Vec<check::Checked> = match &prepared.remote {
        Some(machine) => items
            .iter()
            .map(|_| check::Checked {
                refusal: Some(("remote", format!("On {machine}: Core checks and removes only on its own host for now"))),
                pre: json!({"category": "refused"}),
            })
            .collect(),
        None => {
            let dir = prepared.project_dir.clone().context("project_folder_missing: its task's Project has no folder on this host")?;
            let ctx = Arc::new(check::context(ws.cleanup.env(), ws.cleanup.mounts(), &ws.data_dir, &dir, Some(&prepared.project), &prepared.others,
                prepared.settings.clone()).await?);
            let checks = items.iter().cloned().map(|item| {
                let ctx = ctx.clone();
                async move { check::preflight(&ctx, &item).await }
            });
            futures_util::stream::iter(checks).buffered(PARALLEL).collect().await
        }
    };
    ws.stored(move |s| register(s, &actor, &parsed, &digest, *prepared, items, checked)).await
}

#[allow(clippy::too_many_arguments)]
fn register(store: &Store, actor: &str, input: &SubmitInput, digest: &str, prepared: Prepared, items: Vec<check::Item>,
    checked: Vec<check::Checked>) -> Result<Value> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    // A retry that raced this one registered it already.
    if let Some(answer) = earlier(&tx, actor, &input.request_id, digest)? {
        return Ok(answer);
    }
    expire(&tx)?;
    let stored: Vec<summary::Stored> = items
        .iter()
        .zip(&checked)
        .map(|(item, checked)| summary::Stored {
            id: item.id.clone(),
            group: item.group.clone(),
            kind: item.kind.clone(),
            path: item.path.clone(),
            refusal: checked.refusal.as_ref().map(|(c, w)| ((*c).to_owned(), w.clone())),
            pre: checked.pre.clone(),
        })
        .collect();
    let groups: Vec<(String, String)> = input.groups.iter().map(|g| (g.id.clone(), g.decision.clone())).collect();
    let summaries = summary::all(&groups, &stored, prepared.settings.summary_paths as usize);
    let id = uuid::Uuid::new_v4().to_string();
    let created = now();
    let expires = (chrono::Utc::now() + chrono::Duration::hours(prepared.settings.plan_hours.into())).to_rfc3339();
    let decisions: BTreeMap<&str, &str> = input.groups.iter().map(|g| (g.id.as_str(), g.decision.as_str())).collect();
    let rows: Vec<Value> = input
        .items
        .iter()
        .zip(&stored)
        .map(|(given, s)| {
            json!({"id": s.id, "group": s.group, "decision": decisions[s.group.as_str()], "kind": s.kind, "path": s.path,
                "rule": given.rule, "reason": given.reason, "saveDiff": given.save_diff == Some(true),
                "state": if s.refusal.is_some() { "refused" } else { "pending" },
                "refusal": s.refusal.as_ref().map(|(code, why)| json!({"code": code, "why": why})), "pre": s.pre})
        })
        .collect();
    // What the sha256 fixes: the plan as registered, its checks and Core's summary.
    let task_key = collaboration::task_number(&tx, &prepared.task)?;
    let fixed = json!({"planId": id, "taskId": task_key, "title": input.title,
        "inventory": prepared.inventory, "machine": prepared.remote, "groups": input.groups, "items": rows,
        "summary": summaries, "createdAt": created, "expiresAt": expires});
    let sha = sha256(&fixed.to_string());
    let data = json!({"title": input.title, "taskKey": task_key, "inventory": prepared.inventory, "machine": prepared.remote, "groups": input.groups,
        "summary": summaries, "requestDigest": digest, "settingsVersion": prepared.settings.version,
        "sha256Of": "planId, taskId, title, inventory, machine, groups, items, summary, createdAt, expiresAt"});
    // A newer plan of the task cancels the plans waiting for approval.
    let superseded: Vec<String> = {
        let mut q = tx.prepare("SELECT id FROM cleanup_plans WHERE task_id=?1 AND state='submitted'")?;
        let rows = q.query_map([&prepared.task], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for old in &superseded {
        tx.execute(
            "UPDATE cleanup_plans SET state='cancelled', data=json_set(data,'$.cancelled',json(?2)) WHERE id=?1",
            params![old, json!({"at": created, "why": "A newer plan of its task was registered", "planId": id}).to_string()],
        )?;
    }
    tx.execute(
        "INSERT INTO cleanup_plans(id,task_id,project_id,author_agent,request_id,state,sha256,created_at,expires_at,data)
         VALUES(?1,?2,?3,?4,?5,'submitted',?6,?7,?8,?9)",
        params![id, prepared.task, prepared.project, actor, input.request_id, sha, created, expires, data.to_string()],
    )?;
    for (seq, row) in rows.iter().enumerate() {
        tx.execute(
            "INSERT INTO cleanup_items(plan_id,item_id,seq,group_id,kind,path,decision,reason,pre,state,result,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id, row["id"].as_str(), seq as i64, row["group"].as_str(), row["kind"].as_str(), row["path"].as_str(),
                row["decision"].as_str(), row["reason"].as_str(), row["pre"].to_string(), row["state"].as_str(),
                row["refusal"].to_string(), created],
        )?;
    }
    let refused = rows.iter().filter(|r| r["state"] == "refused").count();
    let body = format!(
        "Cleanup plan {id} registered by {}: {} item(s) in {} group(s), {refused} refused by Core's checks (sha256 {sha}). Nothing is removed by registering it.{}",
        prepared.author.name, rows.len(), input.groups.len(),
        if superseded.is_empty() { String::new() } else { format!(" It cancels {} earlier plan(s) of this task.", superseded.len()) }
    );
    collaboration::activity(&tx, &prepared.task, "comment", &prepared.author, &json!({"cleanupPlan": {"planId": id}, "agent": prepared.source}),
        json!({"body": body}))?;
    let answer = submit_answer(&tx, &id)?;
    tx.commit()?;
    Ok(answer)
}

/// Plans past their expiry are expired.
fn expire(db: &Connection) -> Result<()> {
    db.execute("UPDATE cleanup_plans SET state='expired' WHERE state='submitted' AND expires_at<=?1", [now()])?;
    Ok(())
}

/// A plan's record: its row and data.
struct Plan {
    id: String,
    task: String,
    project: Option<String>,
    author: String,
    state: String,
    sha256: String,
    created_at: String,
    expires_at: String,
    data: Value,
}

fn plan(db: &Connection, id: &str) -> Result<Option<Plan>> {
    db.query_row(
        "SELECT id,task_id,project_id,author_agent,state,sha256,created_at,expires_at,data FROM cleanup_plans WHERE id=?1",
        [id],
        |r| {
            Ok(Plan {
                id: r.get(0)?, task: r.get(1)?, project: r.get(2)?, author: r.get(3)?, state: r.get(4)?, sha256: r.get(5)?,
                created_at: r.get(6)?, expires_at: r.get(7)?, data: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or(Value::Null),
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// The plan as every reader sees it: its state and each group with its
/// author's label and reason beside Core's summary of it.
fn header(db: &Connection, plan: &Plan) -> Result<Value> {
    let summaries = plan.data["summary"].as_array().cloned().unwrap_or_default();
    let groups: Vec<Value> = plan.data["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| {
            let core = summaries.iter().find(|s| s["group"] == g["id"]).cloned().unwrap_or(Value::Null);
            json!({"id": g["id"], "decision": g["decision"], "authorLabel": g["label"], "authorReason": g["reason"], "summary": core})
        })
        .collect();
    let counts: (i64, i64) = db.query_row(
        "SELECT COUNT(*), COALESCE(SUM(state='refused'),0) FROM cleanup_items WHERE plan_id=?1", [&plan.id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(json!({"planId": plan.id, "taskId": collaboration::task_shown(db, &plan.task), "title": plan.data["title"], "state": plan.state,
        "sha256": plan.sha256, "createdAt": plan.created_at, "expiresAt": plan.expires_at, "machine": plan.data["machine"],
        "items": counts.0, "refused": counts.1, "groups": groups, "cancelled": plan.data["cancelled"],
        "approval": approval(db, &plan.id)?, "applied": plan.data["applied"]}))
}

fn submit_answer(db: &Connection, id: &str) -> Result<Value> {
    let plan = plan(db, id)?.context("plan_not_found")?;
    let mut answer = header(db, &plan)?;
    // Each group's largest paths are cleanup_plan_get's, to keep this short.
    for group in answer["groups"].as_array_mut().into_iter().flatten() {
        if let Some(summary) = group["summary"].as_object_mut() {
            summary.remove("largest");
        }
    }
    let mut q = db.prepare("SELECT item_id, path, result FROM cleanup_items WHERE plan_id=?1 AND state='refused' ORDER BY seq LIMIT ?2")?;
    let refused = q
        .query_map(params![id, ANSWER_REFUSED as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .map(|row| row.map(|(item, path, result)| {
            let result: Value = serde_json::from_str(&result).unwrap_or(Value::Null);
            json!({"item": item, "path": path, "code": result["code"], "why": result["why"]})
        }))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    answer["refusedItems"] = json!(refused);
    answer["note"] = json!("Nothing was removed. The user approves groups by Core's summary of each; cleanup_plan_get view items reads every item.");
    Ok(answer)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetInput {
    plan_id: String,
    #[serde(default)]
    view: Option<String>,
    #[serde(default)]
    after_item: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

/// Its task's open executor, a lead of its Project, or the user.
fn may_read(db: &Connection, actor: Option<&str>, plan: &Plan) -> Result<()> {
    let Some(actor) = actor else { return Ok(()) };
    let executor: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_roles WHERE agent_id=?1 AND kind='executor' AND task_id=?2 AND archived_at IS NULL)",
        params![actor, plan.task], |r| r.get(0))?;
    let lead = match &plan.project {
        Some(project) => crate::agent_roles::leads(db, actor, project)?,
        None => false,
    };
    ensure!(executor || lead || actor == plan.author,
        "not_allowed: only the plan's task's executor, a lead of its Project or the user reads a cleanup plan");
    Ok(())
}

fn plan_get(store: &Store, actor: Option<&str>, input: &GetInput) -> Result<Value> {
    let db = store.db.write()?;
    expire(&db)?;
    let plan = plan(&db, &input.plan_id)?.context("plan_not_found: no cleanup plan has this ID")?;
    may_read(&db, actor, &plan)?;
    let mut answer = header(&db, &plan)?;
    match input.view.as_deref().unwrap_or("summary") {
        "summary" => {}
        "items" => {
            let limit = input.limit.unwrap_or(PAGE);
            ensure!((1..=MAX_PAGE).contains(&limit), "invalid_input: limit is 1 to {MAX_PAGE}");
            let after: i64 = match &input.after_item {
                Some(item) => db
                    .query_row("SELECT seq FROM cleanup_items WHERE plan_id=?1 AND item_id=?2", params![plan.id, item], |r| r.get(0))
                    .optional()?
                    .context("invalid_input: afterItem names no item of this plan")?,
                None => -1,
            };
            let mut q = db.prepare(
                "SELECT item_id, group_id, kind, path, decision, state, pre, result, snapshot FROM cleanup_items
                 WHERE plan_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
            )?;
            let mut items = q
                .query_map(params![plan.id, after, limit as i64 + 1], |r| {
                    let pre: Value = serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or(Value::Null);
                    let result: Value = r.get::<_, Option<String>>(7)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
                    Ok(json!({"item": r.get::<_, String>(0)?, "group": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?,
                        "path": r.get::<_, String>(3)?, "decision": r.get::<_, String>(4)?, "state": r.get::<_, String>(5)?,
                        "category": pre["category"], "rule": pre["rule"], "basis": pre["basis"], "bytes": pre["bytes"],
                        "worktree": pre["worktree"], "snapshot": pre["snapshot"], "refusal": result.clone(), "result": result,
                        "snapshotKept": r.get::<_, Option<String>>(8)?.and_then(|t| serde_json::from_str::<Value>(&t).ok())}))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let more = items.len() > limit;
            items.truncate(limit);
            answer["nextAfterItem"] = json!(items.last().filter(|_| more).map(|i| i["item"].clone()));
            answer["hasMore"] = json!(more);
            answer["itemsPage"] = json!(items);
        }
        other => bail!("invalid_input: view is summary or items, not {other}"),
    }
    Ok(answer)
}

/// What Core recorded of a plan's approval, without its request digest.
fn approval(db: &Connection, id: &str) -> Result<Value> {
    let raw: Option<String> = db.query_row("SELECT approval FROM cleanup_plans WHERE id=?1", [id], |r| r.get(0))?;
    let mut approval: Value = raw.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or(Value::Null);
    if let Some(object) = approval.as_object_mut() {
        object.remove("requestDigest");
    }
    Ok(approval)
}

impl Workspace {
    /// Once at start: plans a stopped Core left applying are finished, what
    /// was not reached kept, and their executors told. Then every hour,
    /// snapshots past `snapshotDays` are deleted (refs stay).
    pub(crate) fn start_cleanup(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            if let Some(ws) = weak.upgrade() {
                match ws.stored(apply::recover).await {
                    Ok(0) => {}
                    Ok(n) => {
                        eprintln!("[cleanup] {n} plan(s) left applying by a stopped Core were finished; nothing was retried");
                        ws.collaboration_wakeup.notify_one();
                    }
                    Err(error) => eprintln!("[cleanup] recovery failed: {error:#}"),
                }
            }
            loop {
                let Some(ws) = weak.upgrade() else { break };
                let data = ws.data_dir.clone();
                if let Err(error) = ws.stored(move |s| worktrees::expire_snapshots(s, &data)).await {
                    eprintln!("[cleanup] snapshot expiry failed: {error:#}");
                }
                drop(ws);
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        });
    }
}

/// The plan of a task the user could approve now (Home's gate card, design
/// 2.4): its newest plan while it is submitted and not expired. `planned`:
/// the task has had a plan, so a gate ask of it with a `groups` field is a
/// cleanup approval even when none is waiting now.
fn current_plan(store: &Store, task: &str) -> Result<Value> {
    let db = store.db.write()?;
    expire(&db)?;
    let (task, _) = collaboration::task_key(&db, task)?;
    let id: Option<String> = db
        .query_row("SELECT id FROM cleanup_plans WHERE task_id=?1 AND state='submitted' ORDER BY created_at DESC LIMIT 1", [&task], |r| r.get(0))
        .optional()?;
    let planned: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM cleanup_plans WHERE task_id=?1)", [&task], |r| r.get(0))?;
    Ok(match id.map(|id| plan(&db, &id)).transpose()?.flatten() {
        Some(plan) => json!({"plan": header(&db, &plan)?, "planned": true}),
        None => json!({"plan": null, "planned": planned,
            "note": "This task has no cleanup plan waiting for approval: none, or it expired, was cancelled or was applied."}),
    })
}

async fn http_plan(AppState(ws): AppState<Arc<Workspace>>, UrlPath(task): UrlPath<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| current_plan(s, &task)).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreBody {
    request_id: String,
}

/// The user's restore from Settings.
async fn http_restore(AppState(ws): AppState<Arc<Workspace>>, UrlPath((plan, item)): UrlPath<(String, String)>, Json(body): Json<RestoreBody>)
    -> Result<Json<Value>, ApiError> {
    Ok(Json(worktrees::restore(&ws, None, json!({"requestId": body.request_id, "planId": plan, "itemId": item})).await?))
}

#[cfg(test)]
mod tests;
