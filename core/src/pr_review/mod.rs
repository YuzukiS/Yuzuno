//! Manual, fixed-revision PR reviews. This is deliberately separate from
//! collaborative Agents: no mailbox credentials or task mutation tools exist.
mod claude;
mod evidence;
pub(crate) mod policy;
mod reviewer;
pub(crate) mod settings;
mod source;
pub(crate) mod store;
#[cfg(test)]
mod tests;

use crate::{model::now, server::ApiError, workspace::Workspace};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path, Query, State as AppState},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, watch};

pub const MODEL: &str = "gpt-6.1-sol";
pub(crate) struct State {
    jobs: Mutex<HashMap<String, watch::Sender<bool>>>,
    slots: Arc<Semaphore>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            jobs: Mutex::default(),
            slots: Arc::new(Semaphore::new(2)),
        }
    }
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route(
            "/api/pr-reviews/settings",
            get(settings::get).post(settings::set),
        )
        .route("/api/pr-reviews", get(list).post(start))
        .route("/api/pr-reviews/{id}", get(report))
        .route("/api/pr-reviews/{id}/cancel", post(cancel))
        .route("/api/reviews", get(index))
}
/// The Jobs list's scope: every review, one task's, or those an Agent
/// requested; or one review a link points to.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexScope {
    agent_id: Option<String>,
    task_id: Option<String>,
    review_id: Option<String>,
    before: Option<i64>,
}
async fn index(
    AppState(ws): AppState<Arc<Workspace>>,
    Query(scope): Query<IndexScope>,
) -> Result<Json<Value>, ApiError> {
    let _permit = ws.admission.enter_completion()?;
    Ok(Json(
        ws.stored(move |s| {
            s.index_pr_reviews(
                scope.agent_id.as_deref(),
                scope.task_id.as_deref(),
                scope.review_id.as_deref(),
                scope.before,
            )
        })
        .await?,
    ))
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    task_id: String,
    before: Option<i64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Start {
    request_id: String,
    notify_agent_id: Option<String>,
    task_id: String,
    link_id: String,
    base_sha: Option<String>,
    head_sha: Option<String>,
    /// Review this candidate although an earlier round of it found paths no
    /// round can cover; it acknowledges them, nothing more.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    acknowledge_unreviewable: Option<bool>,
}

async fn list(
    AppState(ws): AppState<Arc<Workspace>>,
    Query(scope): Query<Scope>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        ws.collaboration_call(None, "review_list", serde_json::to_value(scope)?)
            .await?,
    ))
}
async fn report(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
    Query(scope): Query<Scope>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        ws.collaboration_call(
            None,
            "review_get",
            json!({"taskId":scope.task_id,"reviewId":id}),
        )
        .await?,
    ))
}
async fn cancel(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(scope): Json<Scope>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        ws.collaboration_call(
            None,
            "review_cancel",
            json!({"taskId":scope.task_id,"reviewId":id}),
        )
        .await?,
    ))
}
async fn start(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<Start>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        ws.collaboration_call(None, "review_start", serde_json::to_value(input)?)
            .await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    task_id: String,
    review_id: String,
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
    if operation == "review_start" {
        return launch(ws, actor, serde_json::from_value(input)?).await;
    }
    if operation == "review_evidence_add" {
        let _admission = ws.admission.enter_work()?;
        let added = ws.stored(move |s| s.add_review_evidence(actor.as_deref(), input)).await?;
        announce(&ws);
        return Ok(added);
    }
    let _permit = ws.admission.enter_completion()?;
    if operation == "review_list" {
        let input: Scope = serde_json::from_value(input)?;
        return ws
            .stored(move |s| s.list_pr_reviews(&input.task_id, input.before))
            .await;
    }
    ensure!(
        matches!(operation.as_str(), "review_get" | "review_cancel"),
        "Unknown review operation"
    );
    let input: Reference = serde_json::from_value(input)?;
    let id = input.review_id.clone();
    let run = ws
        .stored(move |s| s.pr_review_report(&input.task_id, &input.review_id))
        .await?;
    if operation == "review_get" {
        return Ok(run);
    }
    let mut requested = false;
    if let Some(job) = ws.pr_reviews.jobs.lock().unwrap().get(&id) {
        requested = job.send(true).is_ok();
    }
    Ok(json!({"id":id,"reviewId":id,"status":run["status"],"cancellationRequested":requested}))
}

async fn launch(ws: Arc<Workspace>, actor: Option<String>, input: Start) -> Result<Value> {
    ensure!(
        !input.request_id.trim().is_empty() && input.request_id.len() <= 128,
        "requestId must contain 1–128 bytes"
    );
    let admission = ws.admission.enter_work()?;
    let lookup = input.clone();
    let lookup_actor = actor.clone();
    if let Some(run) = ws
        .stored(move |s| s.previous_pr_review(lookup_actor.as_deref(), &lookup))
        .await?
    {
        return Ok(run);
    }
    // A SHA that cannot be the PR's is refused before a round exists: it
    // could only fail against GitHub's PR after the round was counted.
    fixed_sha_problem(&input).map_or(Ok(()), |problem| Err(anyhow::anyhow!("{problem} No review was started.")))?;
    let slot = ws
        .pr_reviews
        .slots
        .clone()
        .try_acquire_owned()
        .context("Two PR reviews are already running; retry when one finishes")?;
    let id = uuid::Uuid::new_v4().to_string();
    let create_id = id.clone();
    let create = input.clone();
    let (mut run, created) = ws
        .stored(move |s| s.create_pr_review(actor.as_deref(), &create, &create_id))
        .await?;
    if !created {
        return Ok(run);
    }
    announce(&ws);
    let response = run.clone();
    let (tx, mut cancellation) = watch::channel(false);
    ws.pr_reviews.jobs.lock().unwrap().insert(id.clone(), tx);
    tokio::spawn(async move {
        let _admission = admission;
        let _slot = slot;
        let directory = ws.data_dir.join("pr-reviews").join(&id);
        let mut rpc = None;
        let mut claude = None;
        let mut raw = String::new();
        let mut reviewed_context = None;
        let operation = async {
            tokio::fs::create_dir_all(&directory).await?;
            let (evidence, mut context) = source::collect(
                &ws.github.client,
                &mut run,
                &directory,
                input.base_sha.as_deref(),
                input.head_sha.as_deref(),
            )
            .await?;
            tokio::fs::write(directory.join("source.json"), &evidence).await?;
            run["phase"] = json!(format!(
                "Starting isolated {} reviewer",
                run["requestedHarness"].as_str().unwrap_or("unknown")
            ));
            persist(&ws, &run, None).await?;
            let reviewed = if run["requestedHarness"] == "claude" {
                claude::review(
                    &ws,
                    &directory,
                    &evidence,
                    &mut run,
                    &mut raw,
                    &mut claude,
                    &mut context,
                )
                .await
            } else {
                reviewer::review(
                    &ws,
                    &directory,
                    &evidence,
                    &mut run,
                    &mut raw,
                    &mut rpc,
                    &mut context,
                )
                .await
            };
            reviewed_context = Some(context);
            reviewed
        };
        let outcome = tokio::select! {
            biased;
            _=cancellation.changed()=>Err(anyhow::anyhow!("cancelled")),
            result=tokio::time::timeout(Duration::from_secs(900),operation)=>match result {
                Ok(r)=>r, Err(_)=>Err(anyhow::anyhow!("Review deadline exceeded; completion is unknown")),
            },
        };
        // Owned process only. No existing Agent or shared app-server is touched.
        let cleanup = if let Some(bridge) = claude {
            bridge.close_and_wait().await
        } else if let Some(rpc) = rpc {
            rpc.close_and_wait().await
        } else {
            Ok(())
        };
        // Once the reviewer has finished, and outside its deadline and its
        // cancellation: what it left uncovered is checked within a bound of
        // its own. Running out of time or a cancellation only stops that
        // check; the completed result stands and gains nothing but scope.
        if outcome.is_ok() && run["status"] == "completed" {
            if let Some(mut context) = reviewed_context.take() {
                let deadline = std::time::Instant::now() + Duration::from_secs(120);
                let finished = tokio::select! {
                    biased;
                    _ = cancellation.changed() => false,
                    checked = tokio::time::timeout(Duration::from_secs(150), context.postflight(&mut run, deadline)) => checked.is_ok(),
                };
                if !finished {
                    run["scope"]["checkAfterReview"] = json!("stopped");
                }
                reviewer::rescope(&mut run);
            }
        }
        if let Err(error) = outcome {
            let cancelled = *cancellation.borrow();
            run["status"] = json!(if cancelled {
                "cancelled"
            } else if run["status"] == "running" {
                "unknown"
            } else {
                "failed"
            });
            run["conclusion"] = json!("unknown");
            let reason = if cancelled {
                "execution_cancelled"
            } else if run["status"] == "failed" {
                "execution_failed"
            } else {
                "execution_unconfirmed"
            };
            if run["reasonCodes"].as_array().is_none_or(|codes| !codes.iter().any(|code| code == "invalid_report" || code == "execution_failed")) {
                policy::execution_reason(&mut run, reason);
            }
            run["error"] = json!(if cancelled {
                "Cancelled by user".to_owned()
            } else {
                error.to_string()
            });
        }
        if let Err(error) = cleanup {
            run["status"] = json!("unknown");
            run["conclusion"] = json!("unknown");
            run["error"] = json!(format!("Reviewer shutdown could not be confirmed: {error}"));
            policy::execution_reason(&mut run, "execution_unconfirmed");
        }
        // The object cache is temporary, while every delivered page and its
        // fixed revision/blob receipt remains beside the durable report.
        let cache = directory.join("objects.git");
        if cache.exists() {
            if let Err(error) = tokio::fs::remove_dir_all(&cache).await {
                run["sourceCacheCleanupError"] = json!(error.to_string());
            }
        }
        run["finishedAt"] = json!(now());
        run["phase"] = run["status"].clone();
        if let Err(error) = persist(&ws, &run, Some(&raw)).await {
            eprintln!("Review {id} terminal persistence failed: {error}");
        }
        ws.pr_reviews.jobs.lock().unwrap().remove(&id);
        // Retain fixed source evidence with the report, including context reads.
    });
    Ok(response)
}

async fn persist(ws: &Workspace, run: &Value, raw: Option<&str>) -> Result<()> {
    let run = run.clone();
    let raw = raw.map(str::to_owned);
    ws.stored(move |s| s.save_pr_review(&run, raw.as_deref()))
        .await?;
    announce(ws);
    Ok(())
}

/// A review changed: tasks and mail refresh as before, and Jobs lists it.
fn announce(ws: &Workspace) {
    ws.delivery.wake.notify_one();
    ws.changes
        .send(json!({"prReviews":true,"collaboration":true}));
    ws.changes
        .publish(&json!({"type":"workspace.changed","scope":"jobs"}));
    ws.collaboration_wakeup.notify_one();
}

/// The PR's base and head as GitHub shows them: 40 lowercase hexadecimal
/// characters (source.rs compares them exactly).
fn fixed_sha_problem(input: &Start) -> Option<String> {
    [("baseSha", &input.base_sha), ("headSha", &input.head_sha)].into_iter().find_map(|(key, sha)| {
        let sha = sha.as_deref()?;
        if !crate::commit_sha::Form::GitHub.accepts(sha) {
            Some(crate::commit_sha::problem(key, sha, crate::commit_sha::Form::GitHub))
        } else if sha.bytes().any(|b| b.is_ascii_uppercase()) {
            Some(format!("{key} must be lowercase, as GitHub and git rev-parse show it."))
        } else {
            None
        }
    })
}

pub(crate) fn tool_definitions() -> Vec<Value> {
    let text = json!({"type":"string"});
    let fixed = |purpose: &str| {
        let mut schema = crate::commit_sha::schema(crate::commit_sha::Form::GitHub, false, purpose);
        schema["pattern"] = json!("^[0-9a-f]{40}$");
        schema
    };
    let task = json!({"type":"string","description":"Existing task ID returned by Yuzuno, for example T-1. Reuse this task across delivery, review and retries."});
    let definition = |name: &str, description: &str, properties: Value, required: &[&str]| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    vec![
      definition("review_start","Explicitly request an independent read-only review with the Workspace review Harness/model settings of a task-linked PR. Returns reviewId immediately; Core continues after your turn ends and sends a normal system mailbox notification to you at completion/failure/cancellation. Finish your turn after acceptance; do not poll or sleep waiting for the review. Reuse requestId only for an identical retry, including after a lost reply. A new requestId is a new paid review round. Review findings, CI and task completion are separate; this does not merge, run source code or change task status.",json!({"requestId":text,"taskId":task,"linkId":text,
        "baseSha":fixed("Optional: the PR base as github_links shows it, in lowercase. A malformed one is refused before any round starts; one that is no longer the PR's ends its round before a reviewer runs."),
        "headSha":fixed("Optional: the PR head as github_links shows it, in lowercase. A malformed one is refused before any round starts; one that is no longer the PR's ends its round before a reviewer runs."),
        "acknowledgeUnreviewable":{"type":"boolean","description":"Optional. When the latest completed round of this exact base and head found changed paths no round can cover (unsupported, too large, or excluded by the base's .yuzuno/review-scope.json), a new round is refused before it is created. true reviews the other paths anyway. It only acknowledges that those paths stay unreviewed: not an approval, not a lifted round limit, and the result is judged the same way."}}), &["requestId","taskId","linkId"]),
      definition("review_list","List retained review runs for an existing task, newest first. Use nextBefore while hasMore. Outdated compares both fixed base and head; null means the current version is unverified.",json!({"taskId":task,"before":{"type":"integer"}}), &["taskId"]),
      definition("review_get","Read the same durable review shown in task details, including original report, model, fixed range, findings, policyVersion, coveragePolicyVersion, per-file coverage evidence, reasonCodes and, from coverage policy 3, scope: every changed path with its frozen revision, blob and modes and one state (covered with its evidenceKind, excluded, unsupported with its reason such as binary, symlink or submodule, budget_exhausted as diff_exceeds_context or context_exhausted, read_failed, or not_read). Links, submodules and paths the base's .yuzuno/review-scope.json excludes are known before the reviewer starts; binary or non-UTF-8 sources and diffs larger than the review context are recorded when the reviewer meets them or by Core's bounded check after it finishes. They keep the review incomplete; another round of the same head can't cover them. A complete correct review with only P3 suggestions can be approved_with_notes; unknown is never passing and approval never merges the PR.",json!({"taskId":task,"reviewId":text}), &["taskId","reviewId"]),
      definition("review_evidence_add","Record evidence for one changed path of a review that couldn't cover it (for example a prebuilt binary): a source review, build provenance, an artifact hash, a signature or a behaviour test, by reference to another review or Job of this task, a CI run of the reviewed repository (its ci_list runKey), or an https link. It is bound to that review's frozen base, head, merge base and the path's blobs and modes, and shown beside reviews as bound to this candidate only when all of them match; after a new head it shows as another candidate's. Core records the reference without fetching or checking it, and the note is yours; nothing here verifies the evidence or changes any review's conclusion, scope or whether it passes. To bind it to a newer review, add it again with previousEvidenceId; the old record stays. Reuse requestId only to retry the same call.",json!({"requestId":text,"taskId":task,"reviewId":text,"path":text,
        "kind":{"type":"string","enum":evidence::KINDS},
        "reference":{"type":"object","additionalProperties":false,"description":"Exactly one of reviewId, jobId, ciRunKey or url.","properties":{"reviewId":text,"jobId":text,"ciRunKey":text,"url":{"type":"string","maxLength":500}}},
        "artifactSha256":{"type":"string","pattern":"^[0-9a-f]{64}$","description":"SHA-256 of the artifact the evidence is about, as you register it; required for artifact_hash. When Core read the path's head content, it records only whether this value equals that content's SHA-256. It never fetches or checks the artifact the reference points to."},
        "note":{"type":"string","maxLength":500},
        "previousEvidenceId":text}), &["requestId","taskId","reviewId","path","kind","reference"]),
      definition("review_cancel","Request cancellation of this Core-owned review only; retain its record and any report. Repeating cancellation is safe. Does not cancel the task or its author Agent.",json!({"taskId":task,"reviewId":text}), &["taskId","reviewId"]),
    ]
}
