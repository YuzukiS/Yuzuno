//! Core's merge queue (T-37, executor model phase 4). A lead or the user
//! releases one reviewed PR head; Core checks on fresh GitHub reads that CI
//! tested exactly what a merge would land on main, building a batch to run CI
//! on the current main when it did not, merges the PR as a merge commit pinned
//! to that head, checks what landed, follows main's push CI, and records the
//! evidence on the task. Core writes to GitHub only while the user's switch
//! for the repository is on; `writes` holds every write it can make.
mod checks;
mod landing;
mod remote;
pub(crate) mod store;
#[cfg(test)]
mod tests;
mod writes;

use crate::commit_sha::{self, Form};
use crate::{server::ApiError, workspace::Workspace};
use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{Path, Query, State as AppState},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};

#[derive(Default)]
pub(crate) struct State {
    started: OnceLock<()>,
    pub wake: Arc<tokio::sync::Notify>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Enqueue {
    pub request_id: String,
    pub task_id: String,
    pub pull_url: String,
    pub head_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_workflows: Option<Vec<String>>,
}
impl Enqueue {
    fn validate(&self) -> Result<()> {
        request_key(&self.request_id)?;
        ensure!(
            self.head_sha.len() == 40 && self.head_sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
            "invalid_input: headSha must be the full 40-character lowercase commit SHA"
        );
        ensure!(
            self.note.as_ref().is_none_or(|n| n.len() <= 2000 && !n.contains('\0')),
            "invalid_input: note must be at most 2,000 bytes"
        );
        let names = self.require_workflows.as_deref().unwrap_or_default();
        ensure!(
            names.len() <= 8
                && names.iter().all(|n| !n.trim().is_empty() && n.len() <= 100 && !n.chars().any(char::is_control)),
            "invalid_input: requireWorkflows names at most 8 workflows, each 1–100 characters"
        );
        Ok(())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Change {
    pub request_id: String,
    pub entry_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Scope {
    pub entry_id: Option<String>,
    pub task_id: Option<String>,
    pub repository_id: Option<i64>,
    pub state: Option<String>,
}
fn request_key(key: &str) -> Result<()> {
    ensure!(
        !key.trim().is_empty() && key.len() <= 128,
        "invalid_input: requestId must contain 1–128 bytes"
    );
    Ok(())
}

impl Workspace {
    pub(crate) fn start_merge_queue(self: &Arc<Self>) {
        if self.merge_queue.started.set(()).is_err() {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(ws) = weak.upgrade() else { break };
                if let Err(error) = tick(&ws).await {
                    eprintln!("Merge queue: {error:#}");
                }
                let wake = ws.merge_queue.wake.clone();
                drop(ws);
                tokio::select! { _ = wake.notified() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {} }
            }
        });
    }
}

/// Move every due entry on once. Each step reads GitHub afresh; its outcome is
/// recorded only if no cancel or retry moved the entry on meanwhile. An entry
/// whose check held merges in the same pass, and a merged one is followed up
/// at once.
pub(super) async fn tick(ws: &Arc<Workspace>) -> Result<()> {
    let due = ws.stored(|s| s.merge_due()).await?;
    let due_was_empty = due.is_empty();
    let mut announced = false;
    for entry in due {
        let id = entry["id"].as_str().context("A merge entry has no id")?.to_owned();
        let attempt = entry["attempt"].as_i64().unwrap_or(0);
        let mut merging = None;
        let mut merged = None;
        match entry["state"].as_str() {
            Some("queued" | "waiting" | "ready") => {
                // Read again: a check earlier in this pass that ended a pause,
                // or an unpause, may have re-anchored it since merge_due.
                let key = id.clone();
                let entry = ws.stored(move |s| s.merge_entry(&key)).await?;
                if entry["attempt"].as_i64() != Some(attempt) || !matches!(entry["state"].as_str(), Some("queued" | "waiting" | "ready")) {
                    continue;
                }
                let checked_from = store::anchor(&entry);
                let outcome = remote::check(ws, &entry).await.map_err(|e| format!("{e:#}"));
                let cooldown = ws.stored(crate::ci_monitor::read_cooldown).await.unwrap_or(0);
                let key = id.clone();
                let recorded = ws.stored(move |s| s.merge_record(&key, attempt, &checked_from, outcome, cooldown)).await?;
                announced |= recorded.announced;
                merging = recorded.merge;
            }
            Some("merging") => merging = Some(entry.clone()),
            Some("merged") => merged = Some(entry.clone()),
            _ => {
                let outcome = remote::cleanup(ws, &entry).await.map_err(|e| format!("{e:#}"));
                let key = id.clone();
                ws.stored(move |s| s.merge_cleaned(&key, outcome)).await?;
            }
        }
        if let Some(e) = merging {
            announced = true;
            let outcome = landing::land(ws, &e).await.map_err(|e| format!("{e:#}"));
            let cooldown = ws.stored(crate::ci_monitor::read_cooldown).await.unwrap_or(0);
            let key = id.clone();
            merged = ws.stored(move |s| s.merge_answered(&key, attempt, outcome, cooldown)).await?;
        }
        if let Some(e) = merged {
            let outcome = remote::follow(ws, &e).await.map_err(|e| format!("{e:#}"));
            let key = id.clone();
            announced |= ws.stored(move |s| s.merge_followed(&key, attempt, outcome)).await?;
        }
    }
    if !due_was_empty {
        ws.changes.send(json!({"mergeQueue":true}));
    }
    if announced {
        ws.changes.send(json!({"collaboration":true}));
        ws.collaboration_wakeup.notify_one();
    }
    Ok(())
}

async fn enqueue(ws: &Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let i: Enqueue = serde_json::from_value(input)?;
    i.validate()?;
    let (who, request) = (actor.clone(), i.clone());
    let plan = match ws.stored(move |s| s.merge_release_plan(who.as_deref(), &request)).await? {
        Ok(plan) => plan,
        Err(existing) => return Ok(existing),
    };
    let (pr, main) = remote::release_reads(ws, &plan.repository, plan.number).await?;
    let entry = ws.stored(move |s| s.merge_enqueue(actor.as_deref(), &i, &pr, &main)).await?;
    ws.changes.send(json!({"mergeQueue":true,"collaboration":true}));
    ws.collaboration_wakeup.notify_one();
    ws.merge_queue.wake.notify_one();
    Ok(entry)
}

pub async fn call(ws: Arc<Workspace>, actor: Option<String>, operation: String, input: Value) -> Result<Value> {
    let _permit = ws.admission.enter_completion()?;
    match operation.as_str() {
        "merge_enqueue" => enqueue(&ws, actor, input).await,
        "merge_get" | "merge_list" => {
            let i: Scope = serde_json::from_value(input)?;
            ws.stored(move |s| if operation == "merge_get" { s.merge_get(&i) } else { s.merge_list(&i) }).await
        }
        "merge_cancel" | "merge_retry" => {
            let i: Change = serde_json::from_value(input)?;
            request_key(&i.request_id)?;
            // A retry counts main CI only from the main it reads now; only the
            // releaser or the user may cause that read.
            let main = if operation == "merge_retry" {
                let (who, key) = (actor.clone(), i.entry_id.clone());
                let entry = ws.stored(move |s| s.merge_change_allowed(who.as_deref(), &key)).await?;
                match entry["state"].as_str() {
                    Some("stopped") => Some(
                        remote::main_now(&ws, entry["repository"].as_str().unwrap_or(""), entry["baseBranch"].as_str().unwrap_or("main")).await?,
                    ),
                    _ => None,
                }
            } else {
                None
            };
            let answer = ws.stored(move |s| s.merge_change(actor.as_deref(), &operation, &i, main.as_deref())).await?;
            ws.changes.send(json!({"mergeQueue":true,"collaboration":true}));
            ws.collaboration_wakeup.notify_one();
            ws.merge_queue.wake.notify_one();
            Ok(answer)
        }
        "merge_unpause" => {
            let i: Unpause = serde_json::from_value(input)?;
            request_key(&i.request_id)?;
            // A retry with the same requestId gets the first answer back, before
            // the precondition (the queue is no longer paused) or any GitHub read.
            let (who, key, reason) = (actor.clone(), i.request_id.clone(), i.reason.clone());
            if let Some(answer) = ws.stored(move |s| s.merge_unpause_receipt(who.as_deref(), i.repository_id, &key, reason.as_deref())).await? {
                return Ok(answer);
            }
            let who = actor.clone();
            let (repo, base) = ws.stored(move |s| s.merge_unpause_allowed(who.as_deref(), i.repository_id)).await?;
            let main = remote::main_now(&ws, &repo, &base).await?;
            let answer = ws
                .stored(move |s| s.merge_unpause(actor.as_deref(), i.repository_id, &i.request_id, i.reason.as_deref(), &main))
                .await?;
            ws.changes.send(json!({"mergeQueue":true,"collaboration":true}));
            ws.collaboration_wakeup.notify_one();
            ws.merge_queue.wake.notify_one();
            Ok(answer)
        }
        _ => bail!("Unknown merge queue operation"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Unpause {
    request_id: String,
    repository_id: i64,
    reason: Option<String>,
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/merge-queue", get(list).post(release))
        .route("/api/merge-queue/repositories/{id}", get(repository).put(switch))
        .route("/api/merge-queue/repositories/{id}/unpause", post(unpause))
        .route("/api/merge-queue/{id}", get(detail))
        .route("/api/merge-queue/{id}/cancel", post(cancel))
        .route("/api/merge-queue/{id}/retry", post(retry))
}
async fn list(AppState(ws): AppState<Arc<Workspace>>, Query(scope): Query<Scope>) -> Result<Json<Value>, ApiError> {
    let input = json!({"taskId":scope.task_id,"repositoryId":scope.repository_id,"state":scope.state});
    Ok(Json(ws.collaboration_call(None, "merge_list", strip(input)).await?))
}
async fn detail(AppState(ws): AppState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.collaboration_call(None, "merge_get", json!({"entryId":id})).await?))
}
async fn release(AppState(ws): AppState<Arc<Workspace>>, Json(input): Json<Enqueue>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.collaboration_call(None, "merge_enqueue", serde_json::to_value(input)?).await?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeBody {
    request_id: String,
    reason: Option<String>,
}
async fn cancel(AppState(ws): AppState<Arc<Workspace>>, Path(id): Path<String>, Json(b): Json<ChangeBody>) -> Result<Json<Value>, ApiError> {
    let input = strip(json!({"requestId":b.request_id,"entryId":id,"reason":b.reason}));
    Ok(Json(ws.collaboration_call(None, "merge_cancel", input).await?))
}
async fn retry(AppState(ws): AppState<Arc<Workspace>>, Path(id): Path<String>, Json(b): Json<ChangeBody>) -> Result<Json<Value>, ApiError> {
    let input = strip(json!({"requestId":b.request_id,"entryId":id,"reason":b.reason}));
    Ok(Json(ws.collaboration_call(None, "merge_retry", input).await?))
}
async fn unpause(AppState(ws): AppState<Arc<Workspace>>, Path(id): Path<i64>, Json(b): Json<ChangeBody>) -> Result<Json<Value>, ApiError> {
    let input = strip(json!({"requestId":b.request_id,"repositoryId":id,"reason":b.reason}));
    Ok(Json(ws.collaboration_call(None, "merge_unpause", input).await?))
}
/// The repository switch is the user's only: an HTTP route, never an MCP tool.
async fn repository(AppState(ws): AppState<Arc<Workspace>>, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| s.merge_repository(id)).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Switch {
    enabled: Option<bool>,
    landing: Option<String>,
}
async fn switch(AppState(ws): AppState<Arc<Workspace>>, Path(id): Path<i64>, Json(b): Json<Switch>) -> Result<Json<Value>, ApiError> {
    if b.enabled.is_none() && b.landing.is_none() {
        return Err(anyhow::anyhow!("invalid_input: give enabled, landing or both").into());
    }
    // A landing this Core does not have is refused before anything is saved.
    let landing = b.landing.as_deref().map(landing::Landing::chosen).transpose()?;
    let answer = ws
        .stored(move |s| {
            let mut answer = Value::Null;
            if let Some(landing) = landing {
                answer = s.merge_set_landing(id, landing)?;
            }
            if let Some(enabled) = b.enabled {
                answer = s.merge_set_enabled(id, enabled)?;
            }
            Ok(answer)
        })
        .await?;
    ws.changes.send(json!({"mergeQueue":true}));
    ws.merge_queue.wake.notify_one();
    Ok(Json(answer))
}
fn strip(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, v| !v.is_null());
    }
    value
}

pub(crate) fn tool_definitions() -> Vec<Value> {
    let text = json!({"type":"string"});
    let task = json!({"type":"string","description":crate::collaboration_store::TASK_ID});
    let head = commit_sha::schema(Form::GitHub, false, "The exact PR head the review pair covered; the merge is pinned to it.");
    let def = |name: &str, description: &str, properties: Value, required: &[&str]| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    vec![
        def(
            "merge_enqueue",
            "Release one reviewed PR head into Core's merge queue. Only the task's dispatching lead, or the user, may release; the task's executor may not, and the user must first turn the queue on for the repository. That switch is the user's own, in Projects → repositories; no Agent tool reaches it. While the queue is off, Core writes nothing to GitHub. Releasing states that the project's review pair is complete: Core checks that the last completed review round of this PR reviewed exactly headSha and passes the review policy, and refuses otherwise. Core then checks on fresh GitHub reads that the PR is open at headSha and has no merge conflict (a conflicting PR stops at once with conflict: GitHub runs no CI for it), main CI since the release is not red, every workflow run on the head finished green, and every CI job checked out exactly the merge of the current main and the head. If CI tested an older main, Core opens a CI-only batch PR on the current main and waits for its CI. Once every check holds, Core merges the PR as a merge commit pinned to headSha, checks that the merge commit is main plus the head with the tested tree, removes its batch, and follows main's push CI. The outcome and its evidence are written to the task and mailed to you and the task's executor. Core never reruns CI. Retry an identical request with the same requestId.",
            json!({"requestId":text,"taskId":task,"pullUrl":{"type":"string","description":"https://github.com/<owner>/<repo>/pull/<number>, linked to the task"},"headSha":head,
                "note":{"type":"string","maxLength":2000},"requireWorkflows":{"type":"array","maxItems":8,"items":{"type":"string","maxLength":100},"description":"Workflows that must also have run green on the head besides CI, for example Desktop macOS."}}),
            &["requestId", "taskId", "pullUrl", "headSha"],
        ),
        def(
            "merge_get",
            "Read one merge entry, by entryId or a task's newest: its state (queued, waiting, ready, merging, merged, done, stopped, cancelled), reason, history and evidence record.",
            json!({"entryId":text,"taskId":task}),
            &[],
        ),
        def(
            "merge_list",
            "List merge entries newest first (at most 50), optionally for one repository, state or task.",
            json!({"taskId":task,"repositoryId":{"type":"integer","minimum":1},"state":{"type":"string","enum":["queued","waiting","ready","merging","merged","done","stopped","cancelled"]}}),
            &[],
        ),
        def(
            "merge_cancel",
            "Cancel a queued, waiting or ready merge entry. Only the Agent that released it, or the user.",
            json!({"requestId":text,"entryId":text,"reason":{"type":"string","maxLength":2000}}),
            &["requestId", "entryId"],
        ),
        def(
            "merge_retry",
            "Check a stopped merge entry again from the start on fresh reads. Core reads main now, and from then on counts only main CI since that main. It never reruns CI: rerun a red job by other means first. Only the Agent that released it, or the user.",
            json!({"requestId":text,"entryId":text,"reason":{"type":"string","maxLength":2000}}),
            &["requestId", "entryId"],
        ),
        def(
            "merge_unpause",
            "Unpause a repository's merge queue after red main CI, a failed or unverifiable post-check, or a merge whose outcome is unknown (merge_unknown: check whether the PR landed first). Core reads main now and re-anchors every waiting entry there, so their main CI counts from that main on. If main is still the red commit of a main_red pause, the unpause accepts that red run: waiting entries no longer count it, and each still needs green CI on that main before it merges. Only a lead of a Project the repository is linked to, or the user. Retry an identical request with the same requestId.",
            json!({"requestId":text,"repositoryId":{"type":"integer","minimum":1},"reason":{"type":"string","maxLength":2000}}),
            &["requestId", "repositoryId"],
        ),
    ]
}
