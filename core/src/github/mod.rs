//! Explicit GitHub links. GUI and authenticated MCP share this service. Network
//! reads are bounded and coalesced; task status and native sessions are untouched.
pub(crate) mod activity;
pub(crate) mod client;
pub(crate) mod store;
#[cfg(test)]
mod tests;
use crate::workspace::Workspace;
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub struct SyncState {
    jobs: Mutex<HashMap<String, (bool, Instant)>>,
    pub(crate) slots: tokio::sync::Semaphore,
    pub(crate) client: client::Client,
    /// Home's repository activity, cached per repository.
    pub(crate) activity: activity::Cache,
}
impl Default for SyncState {
    fn default() -> Self {
        Self {
            jobs: Mutex::default(),
            slots: tokio::sync::Semaphore::new(2),
            client: Default::default(),
            activity: Default::default(),
        }
    }
}

/// GET /api/projects/{id}/repo-activity: Home reads it lazily, apart from /api/home.
pub fn router() -> axum::Router<Arc<Workspace>> {
    axum::Router::new().route(
        "/api/projects/{id}/repo-activity",
        axum::routing::get(activity::route),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    project_id: Option<String>,
    task_id: Option<String>,
    action: Option<String>,
    input: Option<String>,
    repository_id: Option<i64>,
    link_id: Option<String>,
}
fn scope(input: &Input) -> Result<()> {
    ensure!(
        input.project_id.is_some() != input.task_id.is_some(),
        "Choose exactly one projectId or taskId"
    );
    Ok(())
}
fn keys(page: &Value, project: bool) -> Vec<String> {
    if project {
        page["repositories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r["id"].as_i64().map(|id| format!("repo:{id}")))
            .collect()
    } else {
        page["links"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| l["id"].as_str().map(str::to_owned))
            .collect()
    }
}
async fn list(ws: &Workspace, project: Option<String>, task: Option<String>) -> Result<Value> {
    let is_project = project.is_some();
    let mut page = ws
        .stored(move |s| s.github_list(project.as_deref(), task.as_deref()))
        .await?;
    let jobs = ws.github.jobs.lock().unwrap();
    page["refreshing"] = json!(keys(&page, is_project)
        .iter()
        .any(|k| jobs.get(k).is_some_and(|s| s.0)));
    page["refreshIntervalSeconds"] = json!(120);
    Ok(page)
}

pub async fn call(
    ws: Arc<Workspace>,
    actor: Option<String>,
    operation: String,
    value: Value,
) -> Result<Value> {
    let input: Input = serde_json::from_value(value).context("Invalid GitHub link parameters")?;
    scope(&input)?;
    ensure!(
        matches!(
            operation.as_str(),
            "github_repositories" | "github_links" | "github_refresh"
        ),
        "Unknown GitHub operation"
    );
    if operation == "github_repositories" {
        ensure!(input.project_id.is_some(), "projectId is required");
    }
    if operation == "github_links" {
        ensure!(input.task_id.is_some(), "taskId is required");
    }
    let action = input.action.as_deref().unwrap_or("list");
    ensure!(
        matches!(action, "list" | "link" | "unlink"),
        "action must be list, link or unlink"
    );
    if operation == "github_refresh" {
        ensure!(
            input.action.is_none()
                && input.input.is_none()
                && input.link_id.is_none()
                && input.repository_id.is_none(),
            "Refresh accepts only a scope"
        );
    }
    let _permit = if action == "list" && operation != "github_refresh" {
        ws.admission.enter_completion()?
    } else {
        ws.admission.enter_work()?
    };
    // Same fixed-actor validation as the other collaboration operations.
    ws.stored(move |s| s.collaboration_call(actor.as_deref(), "projects_list", json!({})))
        .await?;
    let page = list(&ws, input.project_id.clone(), input.task_id.clone()).await?;
    if operation == "github_refresh" {
        for key in keys(&page, input.project_id.is_some()) {
            schedule(&ws, key);
        }
    } else if action == "link" {
        let target = client::parse(
            input
                .input
                .as_deref()
                .context("Paste a repository or Issue/PR URL")?,
            input.task_id.is_some(),
        )?;
        let _slot = tokio::time::timeout(Duration::from_secs(2), ws.github.slots.acquire())
            .await
            .context("busy: GitHub reads are busy; try linking again shortly")??;
        let fetch = async {
            let repo = ws.github.client.repository(&target.repo).await?;
            if let Some(task) = input.task_id.clone() {
                let kind = target.kind.context("Missing object kind")?;
                let number = target.number.context("Missing object number")?;
                let snapshot = ws.github.client.object(&repo, &kind, number).await?;
                ws.stored(move |s| s.github_link_object(&task, &repo, &kind, number, snapshot))
                    .await?;
            } else {
                let project = input.project_id.clone().context("Missing project")?;
                ws.stored(move |s| s.github_link_repo(&project, &repo))
                    .await?;
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(25), fetch)
            .await
            .context("timeout: GitHub link lookup timed out")??;
        ws.changes.send(json!({"collaboration":true}));
        ws.delivery.wake.notify_one();
    } else if action == "unlink" {
        if let Some(task) = input.task_id.clone() {
            let id = input.link_id.context("linkId is required")?;
            ws.stored(move |s| s.github_unlink_object(&task, &id))
                .await?;
        } else {
            let project = input.project_id.clone().context("Missing project")?;
            let repo = input.repository_id.context("repositoryId is required")?;
            ws.stored(move |s| s.github_unlink_repo(&project, repo))
                .await?;
        }
        ws.changes.send(json!({"collaboration":true}));
        ws.delivery.wake.notify_one();
    }
    list(&ws, input.project_id, input.task_id).await
}

fn schedule(ws: &Arc<Workspace>, key: String) {
    {
        let mut jobs = ws.github.jobs.lock().unwrap();
        jobs.retain(|_, (busy, until)| *busy || *until > Instant::now());
        if jobs.contains_key(&key) {
            return;
        }
        jobs.insert(key.clone(), (true, Instant::now()));
    }
    let weak = Arc::downgrade(ws);
    tokio::spawn(async move {
        let Some(ws) = weak.upgrade() else { return };
        let result = async {
            let _slot = ws.github.slots.acquire().await?;
            // Queued refreshes cannot start across the update admission fence.
            let _permit = ws.admission.enter_work()?;
            let fetch = async {
                if let Some(id) = key.strip_prefix("repo:") {
                    let id = id.parse::<i64>()?;
                    let result = ws.github.client.repository(&id.to_string()).await;
                    let rate = result
                        .as_ref()
                        .err()
                        .is_some_and(|e| e.to_string().contains("rate_limited"));
                    ws.stored(move |s| {
                        s.github_refresh_repo(id, result.map_err(|e| e.to_string()))
                    })
                    .await?;
                    Ok::<_, anyhow::Error>(rate)
                } else {
                    let parts: Vec<_> = key.split(':').collect();
                    ensure!(parts.len() == 3, "Invalid stored GitHub object key");
                    let id = parts[0].parse::<i64>()?;
                    let number = parts[2].parse::<u64>()?;
                    let result = async {
                        let repo = ws.github.client.repository(&id.to_string()).await?;
                        ensure!(repo.id == id, "Repository identity changed");
                        let v = ws.github.client.object(&repo, parts[1], number).await?;
                        Ok::<_, anyhow::Error>((repo, v))
                    }
                    .await;
                    let rate = result
                        .as_ref()
                        .err()
                        .is_some_and(|e| e.to_string().contains("rate_limited"));
                    let object = key.clone();
                    ws.stored(move |s| {
                        s.github_refresh_object(&object, result.map_err(|e| e.to_string()))
                    })
                    .await?;
                    Ok(rate)
                }
            };
            // Each gh read has its own deadline; the complete refresh also has one.
            match tokio::time::timeout(Duration::from_secs(25), fetch).await {
                Ok(r) => r,
                Err(_) => {
                    let object = key.clone();
                    ws.stored(move |s| {
                        let error =
                            "timeout: GitHub refresh timed out; last snapshot is kept".to_string();
                        if let Some(id) = object.strip_prefix("repo:") {
                            s.github_refresh_repo(id.parse()?, Err(error))
                        } else {
                            s.github_refresh_object(&object, Err(error))
                        }
                    })
                    .await?;
                    Ok(false)
                }
            }
        }
        .await;
        ws.github.jobs.lock().unwrap().insert(
            key,
            (
                false,
                Instant::now()
                    + Duration::from_secs(if matches!(result, Ok(true)) { 300 } else { 30 }),
            ),
        );
        ws.changes.send(json!({"collaboration":true}));
        ws.delivery.wake.notify_one();
    });
}

pub fn tool_definitions() -> Vec<Value> {
    let string = json!({"type":"string"});
    let task = json!({"type":"string","description":crate::collaboration_store::TASK_ID});
    let action = json!({"type":"string","enum":["list","link","unlink"],"default":"list"});
    vec![
        json!({"name":"github_repositories","description":"List, explicitly link, or unlink GitHub.com repositories for a Project. Uses the Core host's gh authentication; GitHub reads only. Input is owner/repo or its HTTPS URL. Unlink removes only the Project association, retaining task links. No cwd inference.","inputSchema":{"type":"object","properties":{"projectId":string,"action":action,"input":string,"repositoryId":{"type":"integer","minimum":1}},"required":["projectId"],"additionalProperties":false}}),
        json!({"name":"github_links","description":"List, explicitly link, or unlink existing GitHub.com Issue/PR URLs on a task. Multiple PRs allowed; Issues optional. A task links at most 30, closed and merged ones included; a task's answer gives capacity (linkedCount, limit, remaining), and links lists them all. Project tasks require the repo already linked to that Project. This never changes GitHub or task status, and does not certify review/deployment. Cached facts retain SHA and observation time; stale snapshots are marked.","inputSchema":{"type":"object","properties":{"taskId":task,"action":action,"input":string,"linkId":string},"required":["taskId"],"additionalProperties":false}}),
        json!({"name":"github_refresh","description":"Queue bounded, coalesced GitHub reads for exactly one task's links or one Project's repositories. Returns cached facts plus refreshing. Call the corresponding list operation to see completion; minimum cooldown 30 seconds, rate-limit cooldown 5 minutes. Failed reads keep the last snapshot and error. No remote writes.","inputSchema":{"type":"object","properties":{"projectId":string,"taskId":task},"additionalProperties":false}}),
    ]
}
