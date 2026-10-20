//! Explicit GitHub PR writes. Accepted operations outlive callers; checks never
//! replay a remote write, and terminal records reuse Core's system mailbox.
mod remote;
pub(crate) mod store;
#[cfg(test)]
mod tests;

use crate::{server::ApiError, workspace::Workspace};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path, Query, State as AppState},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;

pub(crate) struct State {
    slots: Arc<Semaphore>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(2)),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Submit {
    request_id: String,
    task_id: String,
    repository_id: i64,
    action: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: Option<bool>,
    number: Option<u64>,
    notify_agent_id: Option<String>,
}
impl Submit {
    fn validate(&self) -> Result<()> {
        request_key(&self.request_id)?;
        ensure!(self.repository_id > 0, "Choose a linked GitHub repository");
        ensure!(
            matches!(self.action.as_str(), "create" | "update"),
            "Choose create or update"
        );
        ensure!(
            branch(&self.base) && branch(&self.head) && self.base != self.head,
            "Use distinct pushed base/head branch names in the selected repository"
        );
        ensure!(
            !self.title.trim().is_empty()
                && self.title.len() <= 256
                && !self.title.contains(['\n', '\r', '\0']),
            "Title must contain 1–256 bytes on one line"
        );
        ensure!(
            self.body.len() <= 60_000 && !self.body.contains('\0'),
            "PR body must be at most 60,000 bytes without NUL"
        );
        ensure!(
            self.number.is_none_or(|n| n > 0 && n <= i32::MAX as u64),
            "Invalid PR number"
        );
        if self.action == "create" {
            ensure!(
                self.draft.is_some(),
                "Choose draft or ready when creating a PR"
            );
        } else {
            ensure!(
                self.number.is_some(),
                "Updating requires an explicit PR number"
            );
            ensure!(
                self.draft.is_none(),
                "Updates change title/body only; omit draft to retain the PR's current state"
            );
        }
        Ok(())
    }
}
fn request_key(key: &str) -> Result<()> {
    ensure!(
        !key.trim().is_empty() && key.len() <= 128,
        "requestId must contain 1–128 bytes"
    );
    Ok(())
}
fn branch(s: &str) -> bool {
    !s.is_empty()
        && s != "@"
        && s.len() <= 240
        && !s.starts_with(['-', '/', '.'])
        && !s.ends_with(['/', '.'])
        && !s.ends_with(".lock")
        && !s.contains("..")
        && !s.contains("@{")
        && !s.contains("//")
        && !s
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
        && s.split('/')
            .all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Check {
    request_id: String,
    task_id: String,
    operation_id: String,
    number: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    task_id: String,
    before: Option<i64>,
    through: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    task_id: String,
    operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckBody {
    request_id: String,
    task_id: String,
    number: Option<u64>,
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/pr-operations", get(list).post(submit))
        .route("/api/pr-operations/{id}", get(detail))
        .route("/api/pr-operations/{id}/check", post(check))
}
async fn list(
    AppState(ws): AppState<Arc<Workspace>>,
    Query(scope): Query<Scope>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        ws.collaboration_call(
            None,
            "github_pr_list",
            json!({"taskId":scope.task_id,"before":scope.before,"through":scope.through}),
        )
        .await?,
    ))
}
async fn detail(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
    Query(scope): Query<Scope>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        ws.collaboration_call(
            None,
            "github_pr_get",
            json!({"taskId":scope.task_id,"operationId":id}),
        )
        .await?,
    ))
}
async fn submit(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<Submit>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        ws.collaboration_call(None, "github_pr_submit", serde_json::to_value(input)?)
            .await?,
    ))
}
async fn check(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(input): Json<CheckBody>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.collaboration_call(None, "github_pr_check", json!({"operationId":id,"requestId":input.request_id,"taskId":input.task_id,"number":input.number})).await?))
}

pub async fn call(
    ws: Arc<Workspace>,
    actor: Option<String>,
    operation: String,
    input: Value,
) -> Result<Value> {
    let validate = actor.clone();
    ws.stored(move |s| s.collaboration_call(validate.as_deref(), "projects_list", json!({})))
        .await?;
    if operation == "github_pr_submit" || operation == "github_pr_check" {
        return launch(ws, actor, operation, input).await;
    }
    let _permit = ws.admission.enter_completion()?;
    match operation.as_str() {
        "github_pr_list" => {
            let i: Scope = serde_json::from_value(input)?;
            ensure!(
                i.before.is_none() || i.through.is_none(),
                "Choose before or through, not both"
            );
            ws.stored(move |s| s.list_pr_operations(&i.task_id, i.before, i.through))
                .await
        }
        "github_pr_get" => {
            let i: Reference = serde_json::from_value(input)?;
            ws.stored(move |s| s.pr_operation(&i.task_id, &i.operation_id))
                .await
        }
        _ => anyhow::bail!("Unknown PR operation"),
    }
}

async fn launch(
    ws: Arc<Workspace>,
    actor: Option<String>,
    operation: String,
    input: Value,
) -> Result<Value> {
    let (task, key, selected, check_only) = if operation == "github_pr_submit" {
        let i: Submit = serde_json::from_value(input.clone())?;
        i.validate()?;
        (i.task_id, i.request_id, i.number, false)
    } else {
        let i: Check = serde_json::from_value(input.clone())?;
        request_key(&i.request_id)?;
        ensure!(
            i.number.is_none_or(|n| n > 0 && n <= i32::MAX as u64),
            "Invalid selected PR number"
        );
        (i.task_id, i.request_id, i.number, true)
    };
    let admission = ws.admission.enter_work()?;
    let lookup = (
        actor.clone(),
        operation.clone(),
        task.clone(),
        key.clone(),
        input.clone(),
    );
    if let Some(value) = ws
        .stored(move |s| {
            s.previous_pr_operation(
                lookup.0.as_deref(),
                &lookup.1,
                &lookup.2,
                &lookup.3,
                &lookup.4,
            )
        })
        .await?
    {
        return Ok(value);
    }
    let slot = ws
        .pr_operations
        .slots
        .clone()
        .try_acquire_owned()
        .context("Two PR operations are active; retry after completion")?;
    let (mut record, created) = ws
        .stored(move |s| {
            if check_only {
                s.check_pr_operation(actor.as_deref(), serde_json::from_value(input)?)
            } else {
                s.create_pr_operation(actor.as_deref(), serde_json::from_value(input)?)
            }
        })
        .await?;
    if !created {
        return Ok(record);
    }
    let response = record.clone();
    ws.changes
        .send(json!({"prOperations":true,"collaboration":true}));
    tokio::spawn(async move {
        let _admission = admission;
        let _slot = slot;
        let result = remote::execute(&ws, &mut record, check_only, selected).await;
        if let Err(error) = result {
            record["status"] = json!(if check_only || record["writeStarted"] == true {
                "unknown"
            } else {
                "failed"
            });
            record["error"] = json!(error.to_string());
        }
        record["finishedAt"] = json!(crate::model::now());
        let data = record.clone();
        if let Err(error) = ws.stored(move |s| s.finish_pr_operation(data)).await {
            eprintln!("PR operation {} persistence failed: {error}", record["id"]);
        }
        ws.changes
            .send(json!({"prOperations":true,"collaboration":true}));
        ws.collaboration_wakeup.notify_one();
    });
    Ok(response)
}

pub(super) async fn progress(ws: &Workspace, record: &Value) -> Result<()> {
    let data = record.clone();
    ws.stored(move |s| s.progress_pr_operation(&data)).await?;
    ws.changes.send(json!({"prOperations":true}));
    Ok(())
}
pub(crate) fn tool_definitions() -> Vec<Value> {
    let text = json!({"type":"string"});
    let task = json!({"type":"string","description":crate::collaboration_store::TASK_ID});
    let number = json!({"type":"integer","minimum":1});
    let def = |name: &str, description: &str, properties: Value, required: &[&str]| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    vec![
        def(
            "github_pr_submit",
            "Explicitly create or update a GitHub PR using already pushed base/head branches in one linked repository. Returns a durable operationId immediately; Core continues after your Turn and notifies you through the normal system mailbox. Do not poll or sleep waiting. Create reuses a matching open PR without modifying it; supply number to select an existing candidate. Update requires number and changes only title/body; omit draft. Create requires draft. Retry an identical request with the same requestId. Unknown results must be checked, not blindly resubmitted. Never commits, pushes, merges, starts a review or completes a task.",
            json!({"requestId":text,"taskId":task,"repositoryId":number,"action":{"type":"string","enum":["create","update"]},"base":text,"head":text,"title":text,"body":text,"draft":{"type":"boolean"},"number":number}),
            &[
                "requestId",
                "taskId",
                "repositoryId",
                "action",
                "base",
                "head",
                "title",
                "body",
            ],
        ),
        def(
            "github_pr_list",
            "List persisted PR operations and available linked repositories for a task. Use nextBefore while hasMore. Remote PR outcome and task association are separate facts.",
            json!({"taskId":task,"before":number}),
            &["taskId"],
        ),
        def(
            "github_pr_get",
            "Read the durable PR operation shown in the GUI, including submitted content, remote PR identity, association and recovery evidence.",
            json!({"taskId":task,"operationId":text}),
            &["taskId", "operationId"],
        ),
        def(
            "github_pr_check",
            "Explicitly check an uncertain PR outcome or repair its task association. Never repeats a remote create/update. Returns immediately and reports via the original operation recipient's system mailbox. Select number only from a matching candidate list. Reuse requestId for identical retries.",
            json!({"requestId":text,"taskId":task,"operationId":text,"number":number}),
            &["requestId", "taskId", "operationId"],
        ),
    ]
}
