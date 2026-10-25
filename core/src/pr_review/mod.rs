//! Manual, fixed-revision PR reviews. This is deliberately separate from
//! collaborative Agents: no mailbox credentials or task mutation tools exist.
mod claude;
mod continuation;
mod evidence;
mod incremental;
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
            get(settings::get).post(settings::set).delete(settings::reset),
        )
        .route(
            "/api/projects/{id}/review-settings",
            get(settings::get_project).post(settings::set_project).delete(settings::reset_project),
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
    /// A completed earlier round of this PR at another head: this round
    /// reads only what changed since and carries its findings
    /// (incremental.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_review_id: Option<String>,
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
    if operation == "review_continue" {
        return launch_continuation(ws, actor, serde_json::from_value(input)?).await;
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

async fn launch(ws: Arc<Workspace>, actor: Option<String>, mut input: Start) -> Result<Value> {
    ensure!(
        !input.request_id.trim().is_empty() && input.request_id.len() <= 128,
        "requestId must contain 1–128 bytes"
    );
    let admission = ws.admission.enter_work()?;
    // An abbreviated base or head becomes the full SHA in the link's
    // repository first, so a retry finds the round it started (T-164).
    let link = input.link_id.clone();
    let mut repo = None;
    for (key, value) in [("baseSha", &mut input.base_sha), ("headSha", &mut input.head_sha)] {
        let Some(short) = value.clone().filter(|v| crate::commit_sha::abbreviated(v)) else { continue };
        if repo.is_none() {
            repo = Some(link_repository(&ws, &link, key, &short).await?);
        }
        *value = Some(crate::commit_sha::resolve(&ws, repo.as_deref().unwrap(), key, &short).await?);
    }
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
    fixed_sha_problem(input.base_sha.as_deref(), input.head_sha.as_deref(), true)
        .map_or(Ok(()), |problem| Err(anyhow::anyhow!("{problem} No review was started.")))?;
    let slot = ws
        .pr_reviews
        .slots
        .clone()
        .try_acquire_owned()
        .context("Two PR reviews are already running; retry when one finishes")?;
    let id = uuid::Uuid::new_v4().to_string();
    let create_id = id.clone();
    let create = input.clone();
    let (run, created) = ws
        .stored(move |s| s.create_pr_review(actor.as_deref(), &create, &create_id))
        .await?;
    if !created {
        return Ok(run);
    }
    announce(&ws);
    Ok(spawn(ws, admission, slot, id, run, input.base_sha, input.head_sha, None))
}

/// A bounded continuation of one completed round of the same snapshot: a
/// new native run, admitted from the parent's stored record before it
/// exists, within what the parent left of its budget (continuation.rs).
async fn launch_continuation(ws: Arc<Workspace>, actor: Option<String>, input: continuation::Continue) -> Result<Value> {
    ensure!(
        !input.request_id.trim().is_empty() && input.request_id.len() <= 128,
        "requestId must contain 1–128 bytes"
    );
    let admission = ws.admission.enter_work()?;
    let lookup = input.clone();
    let lookup_actor = actor.clone();
    if let Some(run) = ws
        .stored(move |s| s.previous_pr_review_continuation(lookup_actor.as_deref(), &lookup))
        .await?
    {
        return Ok(run);
    }
    fixed_sha_problem(Some(&input.base_sha), Some(&input.head_sha), false)
        .map_or(Ok(()), |problem| Err(anyhow::anyhow!("{problem} No continuation was started.")))?;
    let slot = ws
        .pr_reviews
        .slots
        .clone()
        .try_acquire_owned()
        .context("Two PR reviews are already running; retry when one finishes")?;
    let id = uuid::Uuid::new_v4().to_string();
    let create_id = id.clone();
    let create = input.clone();
    let (run, parent, created) = ws
        .stored(move |s| s.create_pr_review_continuation(actor.as_deref(), &create, &create_id))
        .await?;
    if !created {
        return Ok(run);
    }
    announce(&ws);
    Ok(spawn(ws, admission, slot, id, run, Some(input.base_sha), Some(input.head_sha), parent))
}

#[allow(clippy::too_many_arguments)]
fn spawn(
    ws: Arc<Workspace>,
    admission: crate::updates::admission::Permit,
    slot: tokio::sync::OwnedSemaphorePermit,
    id: String,
    mut run: Value,
    base_sha: Option<String>,
    head_sha: Option<String>,
    parent: Option<Value>,
) -> Value {
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
        // A continuation's operation gets exactly the milliseconds its parent
        // left of the 900 s; nothing is rounded up.
        let budget = parent
            .as_ref()
            .and_then(|_| run["continuation"]["reservation"]["milliseconds"].as_u64())
            .map_or(Duration::from_millis(continuation::MAX_MILLISECONDS), Duration::from_millis);
        let started = std::time::Instant::now();
        let operation = async {
            tokio::fs::create_dir_all(&directory).await?;
            let (mut evidence, mut context) = source::collect(
                &ws.github.client,
                &mut run,
                &directory,
                base_sha.as_deref(),
                head_sha.as_deref(),
            )
            .await?;
            if let Some(parent) = &parent {
                evidence = prepare_continuation(&ws, parent, &mut run, &mut context).await.inspect_err(|_| {
                    policy::execution_reason(&mut run, "continuation_refused");
                })?;
            } else if run["kind"] == "incremental" {
                evidence = prepare_incremental(&ws, &mut run, &mut context, &evidence).await.inspect_err(|_| {
                    policy::execution_reason(&mut run, "incremental_refused");
                })?;
            }
            tokio::fs::write(directory.join("source.json"), &evidence).await?;
            run["phase"] = json!(format!(
                "Starting isolated {} reviewer",
                run["requestedHarness"].as_str().unwrap_or("unknown")
            ));
            // Persisted before any native process exists: without it, no
            // model can have started for this run.
            run["nativeStartedAt"] = json!(now());
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
            result=tokio::time::timeout(budget,operation)=>match result {
                Ok(r)=>r, Err(_)=>Err(anyhow::anyhow!("Review deadline exceeded; completion is unknown")),
            },
        };
        // What the operation used, before the check after the review: its
        // own time, calls and bytes, and the native harness's usage report.
        if continuation::ledger(&run) {
            run["ledger"]["operationMs"] = json!(started.elapsed().as_millis() as u64);
            run["ledger"]["calls"] = json!(run["contextReads"].as_array().map_or(0, Vec::len));
            run["ledger"]["bytes"] = json!(run["contextBytes"].as_u64().unwrap_or(0));
            run["ledger"]["nativeUsage"] = continuation::native_usage(&run, &raw);
            if parent.is_some() {
                run["ledger"]["cumulative"] = continuation::cumulative(&run);
            } else if run["kind"] == "incremental" {
                run["ledger"]["cumulative"] = incremental::cumulative(&run);
            }
        }
        // Owned process only. No existing Agent or shared app-server is touched.
        let cleanup = if let Some(bridge) = claude {
            bridge.close_and_wait().await
        } else if let Some(rpc) = rpc {
            rpc.close_and_wait().await
        } else {
            Ok(())
        };
        let succeeded = outcome.is_ok();
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
            if run["reasonCodes"].as_array().is_none_or(|codes| !codes.iter().any(|code| code == "invalid_report" || code == "execution_failed" || code == "continuation_refused" || code == "incremental_refused")) {
                policy::execution_reason(&mut run, reason);
            }
            run["error"] = json!(if cancelled {
                "Cancelled by user".to_owned()
            } else {
                error.to_string()
            });
        }
        let shut_down = cleanup.is_ok();
        if let Err(error) = cleanup {
            run["status"] = json!("unknown");
            run["conclusion"] = json!("unknown");
            run["error"] = json!(format!("Reviewer shutdown could not be confirmed: {error}"));
            policy::execution_reason(&mut run, "execution_unconfirmed");
        }
        // A native run that completed and whose process shut down is durable
        // first: its report and usage are stored, marked as confirmed, before
        // anything that can be stopped. A restart from here on finishes it as
        // completed with the check after the review interrupted.
        if succeeded && shut_down && run["status"] == "completed" {
            if continuation::ledger(&run) {
                run["ledger"]["nativeCompletion"] = json!("confirmed");
            }
            let mut stored = run.clone();
            stored["status"] = json!("running");
            stored["phase"] = json!("Checking what the review left uncovered");
            if let Err(error) = persist(&ws, &stored, Some(&raw)).await {
                eprintln!("Review {id} completed-report persistence failed: {error}");
            }
            // Outside its deadline and its cancellation: what it left
            // uncovered is checked within a bound of its own. Running out of
            // time or a cancellation only stops that check; the completed
            // result stands and gains nothing but scope.
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
    response
}

/// Everything a continuation relies on, checked before any model starts:
/// the re-fetched snapshot is the parent's, every response the parent
/// delivered still has its recorded hash, and every unread path can be
/// delivered within the reserved bytes. Its evidence replaces the manifest.
async fn prepare_continuation(
    ws: &Workspace,
    parent: &Value,
    run: &mut Value,
    context: &mut source::ContextStore,
) -> Result<String> {
    run["phase"] = json!("Checking the earlier round's snapshot and receipts");
    continuation::same_snapshot(parent, run)?;
    let parent_id = parent["id"].as_str().context("Parent review id missing")?;
    continuation::verify_receipts(parent, &ws.data_dir.join("pr-reviews").join(parent_id)).await?;
    let reservation = run["continuation"]["reservation"].clone();
    let (proofs, failures) = continuation::inherited(parent);
    context.inherit(proofs, failures);
    context.reserve(
        reservation["calls"].as_u64().unwrap_or(0) as usize,
        reservation["bytes"].as_u64().unwrap_or(0) as usize,
    );
    context.refresh(run);
    let outside = source::scope::permanent_gaps(&run["scope"]);
    let evidence = continuation::evidence(run, &outside, json!({"maxCalls":reservation["calls"],"maxContextBytes":reservation["bytes"],"deadlineMilliseconds":reservation["milliseconds"],"reservedFrom":"the earlier round's remaining budget"}))?;
    context.set_evidence_bytes(evidence.len());
    run["evidenceBytes"] = json!(evidence.len());
    // The ledger counts this evidence even if the reviewer reads nothing.
    context.refresh(run);
    continuation::check_targets(run, context).await?;
    Ok(evidence)
}

/// A review of a new head relying on an earlier round, checked before any
/// model starts: only that round's proofs of paths identical on both sides
/// carry over, and only after its retained responses still match their
/// hashes. The reviewer is told what to read and what that round found.
async fn prepare_incremental(
    ws: &Workspace,
    run: &mut Value,
    context: &mut source::ContextStore,
    collected: &str,
) -> Result<String> {
    run["phase"] = json!("Comparing with the earlier round's snapshot");
    let task = run["taskId"].as_str().context("Review task missing")?.to_owned();
    let earlier = run["previousReviewId"].as_str().context("Earlier review id missing")?.to_owned();
    let previous = ws.stored(move |s| s.pr_review_report(&task, &earlier)).await?;
    let proofs = incremental::compare(&previous, run)?;
    if !proofs.is_empty() {
        let id = previous["id"].as_str().context("Earlier review id missing")?;
        continuation::verify_receipts(&previous, &ws.data_dir.join("pr-reviews").join(id)).await?;
    }
    context.inherit(proofs, Vec::new());
    context.refresh(run);
    let evidence = incremental::evidence(collected, run)?;
    context.set_evidence_bytes(evidence.len());
    run["evidenceBytes"] = json!(evidence.len());
    context.refresh(run);
    Ok(evidence)
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

/// The repository a linkId (`{repositoryId}:{kind}:{number}`) names, where
/// review_start resolves an abbreviated SHA.
async fn link_repository(ws: &Arc<Workspace>, link: &str, key: &str, short: &str) -> Result<String> {
    let id = link.split(':').next().and_then(|id| id.parse::<i64>().ok());
    let name = match id {
        Some(id) => ws.stored(move |s| s.github_repository_name(id)).await?,
        None => None,
    };
    name.with_context(|| format!("invalid_input: {key} {short} is abbreviated, and linkId {link:?} names no saved \
        repository to resolve it in; give the full SHA. No review was started. {}", crate::commit_sha::HOW))
}

/// The PR's base and head as GitHub shows them: 40 lowercase hexadecimal
/// characters (source.rs compares them exactly). `resolved`: an abbreviation
/// would have been resolved, so the rejection names both forms.
fn fixed_sha_problem(base: Option<&str>, head: Option<&str>, resolved: bool) -> Option<String> {
    [("baseSha", base), ("headSha", head)].into_iter().find_map(|(key, sha)| {
        let sha = sha?;
        if !crate::commit_sha::Form::GitHub.accepts(sha) {
            Some(if resolved {
                crate::commit_sha::problem_resolved(key, sha, crate::commit_sha::Form::GitHub)
            } else {
                crate::commit_sha::problem(key, sha, crate::commit_sha::Form::GitHub)
            })
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
    // review_start also takes an abbreviation, resolved in the link's repository (T-164).
    let resolved = |purpose: &str| {
        let mut schema = crate::commit_sha::schema_resolved(crate::commit_sha::Form::GitHub, false, purpose, "of the linked PR's repository");
        schema["pattern"] = json!("^[0-9a-f]{4,40}$");
        schema
    };
    let task = json!({"type":"string","description":crate::collaboration_store::TASK_ID});
    let definition = |name: &str, description: &str, properties: Value, required: &[&str]| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    vec![
      definition("review_start","Explicitly request an independent read-only review with the review Harness/model settings for its task (its project's, else the Workspace's, else built in) of a task-linked PR. Returns reviewId immediately; Core continues after your turn ends and sends a normal system mailbox notification to you at completion/failure/cancellation. Finish your turn after acceptance; do not poll or sleep waiting for the review. Reuse requestId only for an identical retry, including after a lost reply. A new requestId is a new paid review round. Review findings, CI and task completion are separate; this does not merge, run source code or change task status.",json!({"requestId":text,"taskId":task,"linkId":text,
        "baseSha":resolved("Optional: the PR's own base as github_links shows it (snapshot.baseSha), in lowercase; not the current tip of the target branch, which may have moved on. A malformed one is refused before any round starts; one that is no longer the PR's ends its round before a reviewer runs."),
        "headSha":resolved("Optional: the PR head as github_links shows it, in lowercase. A malformed one is refused before any round starts; one that is no longer the PR's ends its round before a reviewer runs."),
        "acknowledgeUnreviewable":{"type":"boolean","description":"Optional. When the latest completed round of this exact base and head found changed paths no round can cover (unsupported, too large, or excluded by the base's .yuzuno/review-scope.json), a new round is refused before it is created. true reviews the other paths anyway. It only acknowledges that those paths stay unreviewed: not an approval, not a lifted round limit, and the result is judged the same way."},
        "previousReviewId":{"type":"string","description":"Optional: a completed full round of this PR at another head, to review this head incrementally. It is a new round with its own normal budget and cost, and it counts toward the PR's two started rounds shared with continuations. Only that round's proofs of changed paths identical on both sides under the same merge base carry over; every other changed path is read again. Each of its findings stays, and keeps blocking if P0-P2, unless this round marks it fixed with fix paths that changed since that head and that it read completely itself. Refused before any model starts for a round that isn't completed with a confirmed native completion and a ledger, is a continuation or incremental round, used another reviewer or policy, or reviewed this same head (use review_continue)."}}), &["requestId","taskId","linkId"]),
      definition("review_continue","Explicitly request a bounded continuation of one completed review round of the same fixed snapshot, for the changed paths it left unread (not_read or read_failed in its scope). It is a new isolated reviewer run with its own record, round number and cost, not a resumed session, and it never refills a budget: it gets only what the parent round left of its 160 calls, 1.5 MB and 900 000 ms. A PR gets at most two started review rounds when one is a continuation, counted across tasks; rounds that can't be shown to have started nothing count. Core admits it from the parent's stored record before it exists and refuses, without starting any model, a parent that isn't completed with a confirmed native completion, predates usage ledgers, is itself a continuation or already has one, stopped at a terminal limit, has nothing left to read, or whose snapshot, policy or reviewer settings changed. Before the reviewer starts Core re-fetches the snapshot and checks it is the parent's, that every response the parent delivered still matches its recorded hash, and that the unread paths can be delivered within the remaining budget. Under an authorized delivery of this candidate it must be one of the delivery's attempts (delivery_continue first). The parent's report, findings and receipts stay unchanged; the continuation's coverage, scope and conclusion are over both rounds, each covered path naming the review that read it, and a blocking finding from either round blocks. Returns reviewId at once and notifies you at the end; do not poll. Reuse requestId only for an identical retry.",json!({"requestId":text,"taskId":task,"reviewId":{"type":"string","description":"The completed round to continue."},
        "baseSha":fixed("The parent round's fixed base, in lowercase."),
        "headSha":fixed("The parent round's fixed head, in lowercase."),
        "acknowledgeUnreviewable":{"type":"boolean","description":"Optional. Required when the parent also found paths no review of this snapshot can cover; it only acknowledges that they stay unreviewed, so the result can't pass."}}), &["requestId","taskId","reviewId","baseSha","headSha"]),
      definition("review_list","List retained review runs for an existing task, newest first. Use nextBefore while hasMore. Outdated compares both fixed base and head; null means the current version is unverified.",json!({"taskId":task,"before":{"type":"integer"}}), &["taskId"]),
      definition("review_get","Read the same durable review shown in task details, including original report, model, fixed range, findings, policyVersion, coveragePolicyVersion, per-file coverage evidence, reasonCodes and, from coverage policy 3, scope: every changed path with its frozen revision, blob and modes and one state (covered with its evidenceKind, excluded, unsupported with its reason such as binary, symlink or submodule, budget_exhausted as diff_exceeds_context or context_exhausted, read_failed, or not_read). A continuation's (review_continue) coverage, scope and conclusion are over both rounds, and each covered path names the review that read it. An incremental round (review_start with previousReviewId) keeps the earlier round's unsettled findings with their origin and lists the ones it settled, with their fix paths, in settledFindings. Links, submodules and paths the base's .yuzuno/review-scope.json excludes are known before the reviewer starts; binary or non-UTF-8 sources and diffs larger than the review context are recorded when the reviewer meets them or by Core's bounded check after it finishes. They keep the review incomplete; another round of the same head can't cover them. A complete correct review with only P3 suggestions can be approved_with_notes; unknown is never passing and approval never merges the PR. Your default view \"summary\" has the conclusion, findings, coverage and scope counts and every path not covered, and for a continuation or incremental round the round it follows and the findings it settled; view \"full\" adds the original report, context reads and per-file evidence.",json!({"taskId":task,"reviewId":text,"view":{"type":"string","enum":["summary","full"]}}), &["taskId","reviewId"]),
      definition("review_evidence_add","Record evidence for one changed path of a review that couldn't cover it (for example a prebuilt binary): a source review, build provenance, an artifact hash, a signature or a behaviour test, by reference to another review or Job of this task, a CI run of the reviewed repository (its ci_list runKey), or an https link. It is bound to that review's frozen base, head, merge base and the path's blobs and modes, and shown beside reviews as bound to this candidate only when all of them match; after a new head it shows as another candidate's. Core records the reference without fetching or checking it, and the note is yours; nothing here verifies the evidence or changes any review's conclusion, scope or whether it passes. To bind it to a newer review, add it again with previousEvidenceId; the old record stays. Reuse requestId only to retry the same call.",json!({"requestId":text,"taskId":task,"reviewId":text,"path":text,
        "kind":{"type":"string","enum":evidence::KINDS},
        "reference":{"type":"object","additionalProperties":false,"description":"Exactly one of reviewId, jobId, ciRunKey or url.","properties":{"reviewId":text,"jobId":text,"ciRunKey":text,"url":{"type":"string","maxLength":500}}},
        "artifactSha256":{"type":"string","pattern":"^[0-9a-f]{64}$","description":"SHA-256 of the artifact the evidence is about, as you register it; required for artifact_hash. When Core read the path's head content, it records only whether this value equals that content's SHA-256. It never fetches or checks the artifact the reference points to."},
        "note":{"type":"string","maxLength":500},
        "previousEvidenceId":text}), &["requestId","taskId","reviewId","path","kind","reference"]),
      definition("review_cancel","Request cancellation of this Core-owned review only; retain its record and any report. Repeating cancellation is safe. Does not cancel the task or its author Agent.",json!({"taskId":task,"reviewId":text}), &["taskId","reviewId"]),
    ]
}
