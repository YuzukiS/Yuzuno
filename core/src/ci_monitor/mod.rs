//! Explicit, bounded GitHub Actions monitoring. This is a remote Jobs source,
//! never an executor, local resource reservation, or task-completion mechanism.
mod client;
mod live;
pub(crate) mod lifecycle;
pub(crate) mod store;
#[cfg(test)]
mod tests;
use crate::{server::ApiError, workspace::Workspace};
use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{Path, Query, State as AppState},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{Mutex, Notify};

/// Unfinished runs are checked every 30 seconds and finished ones every five
/// minutes. This is the product's choice, not a GitHub rule: GitHub's
/// x-poll-interval, Retry-After and rate-limit reset still come first.
pub(super) const ACTIVE_SECONDS: i64 = 30;
pub(super) const DONE_SECONDS: i64 = 300;
/// A scheduled check reuses run reads younger than this, which watches of one
/// PR share. It stays below ACTIVE_SECONDS, so a due watch reads anew.
const SHARED_SECONDS: i64 = 25;
/// A manual refresh reuses a check finished this recently, or after it was
/// asked for, so repeated clicks and other windows do not ask GitHub again.
const RECENT_SECONDS: i64 = 10;
/// One manual refresh checks at most this many watches, one at a time.
const REFRESH_WATCHES: usize = 5;

#[derive(Default)]
pub(crate) struct State {
    started: OnceLock<()>,
    gate: Mutex<()>,
    wake: Arc<Notify>,
    // Short, bounded reuse of failed one-off reads, including auth/network
    // failures which have no successful body in the shared ETag cache.
    run_failures: Mutex<std::collections::HashMap<String, (i64, String)>>,
}
/// One observation of a watch. `checked` is when GitHub answered the oldest
/// run read behind it (a 304 counts as an answer); `wait` is when GitHub's
/// own poll interval allows the next read.
pub(crate) struct Observed {
    pub(crate) runs: Vec<Value>,
    pub(crate) head: Option<String>,
    pub(crate) pr: Option<Value>,
    pub(crate) truncated: bool,
    pub(crate) checked: i64,
    pub(crate) wait: i64,
    /// Runs GitHub listed for a commit watch that are not its target (another
    /// branch, event or repository): left out, only counted.
    pub(crate) excluded: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Subscribe {
    request_id: String,
    task_id: String,
    agent_id: Option<String>,
    url: String,
    expected_sha: String,
    /// A commit URL's target: GitHub's exact head branch and event. Required
    /// for a commit URL, refused for a PR or run URL. Absent fields keep old
    /// receipts byte-identical for requestId replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    event: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    agent_id: Option<String>,
    task_id: Option<String>,
    before: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    run_key: String,
    #[serde(default = "first")]
    page: u64,
}
fn first() -> u64 {
    1
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stop {
    subscription_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Refresh {
    agent_id: Option<String>,
    task_id: Option<String>,
    run_key: Option<String>,
    /// The run's jobs pages on screen, read again from the first.
    #[serde(default = "first")]
    pages: u64,
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/ci", get(list).post(subscribe))
        .route("/api/ci/live", get(live_counts))
        .route("/api/ci/refresh", post(refresh_now))
        .route("/api/ci/{id}", get(report))
        .route("/api/ci/subscriptions/{id}/stop", post(stop))
}
async fn live_counts(
    AppState(ws): AppState<Arc<Workspace>>,
) -> Result<Json<Value>, ApiError> {
    // Read local monitoring facts only; this endpoint never starts a monitor
    // or asks GitHub to refresh. The existing monitor publishes Jobs changes.
    Ok(Json(ws.stored(|s| s.live_ci_counts()).await?))
}
async fn refresh_now(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(call(ws, None, "ci_refresh".into(), input).await?))
}
async fn list(
    AppState(ws): AppState<Arc<Workspace>>,
    Query(q): Query<List>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(
            ws,
            None,
            "ci_list".into(),
            json!({"agentId":q.agent_id,"taskId":q.task_id,"before":q.before}),
        )
        .await?,
    ))
}
async fn subscribe(
    AppState(ws): AppState<Arc<Workspace>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(call(ws, None, "ci_subscribe".into(), input).await?))
}
#[derive(Deserialize)]
struct Page {
    #[serde(default = "first")]
    page: u64,
}
async fn report(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
    Query(p): Query<Page>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(
            ws,
            None,
            "ci_get".into(),
            json!({"runKey":id,"page":p.page}),
        )
        .await?,
    ))
}
async fn stop(
    AppState(ws): AppState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        call(
            ws,
            None,
            "ci_unsubscribe".into(),
            json!({"subscriptionId":id}),
        )
        .await?,
    ))
}

pub async fn call(
    ws: Arc<Workspace>,
    actor: Option<String>,
    operation: String,
    input: Value,
) -> Result<Value> {
    let identity = actor.clone();
    ws.stored(move |s| s.collaboration_call(identity.as_deref(), "projects_list", json!({})))
        .await?;
    let _admission = if operation == "ci_subscribe" {
        ws.admission.enter_work()?
    } else {
        ws.admission.enter_completion()?
    };
    ws.start_ci_monitor();
    match operation.as_str() {
        "ci_list" => {
            let q: List = serde_json::from_value(input)?;
            ws.stored(move |s| s.ci_list(q.agent_id.as_deref(), q.task_id.as_deref(), q.before))
                .await
        }
        "ci_unsubscribe" => {
            let q: Stop = serde_json::from_value(input)?;
            let v = ws
                .stored(move |s| s.ci_unsubscribe(actor.as_deref(), &q.subscription_id))
                .await?;
            changed(&ws);
            Ok(v)
        }
        "ci_subscribe" => {
            let mut q: Subscribe = serde_json::from_value(input)?;
            ensure!(
                !q.request_id.trim().is_empty() && q.request_id.len() <= 128,
                "requestId must contain 1–128 bytes"
            );
            ensure!(
                client::sha(&q.expected_sha),
                "{}",
                crate::commit_sha::problem("expectedSha", &q.expected_sha, crate::commit_sha::Form::GitHub)
            );
            q.expected_sha = q.expected_sha.to_ascii_lowercase();
            q.url = q.url.trim().to_owned();
            let (repo_name, kind, number) = match client::commit(&q.url)? {
                Some((repo, sha)) => {
                    ensure!(
                        sha == q.expected_sha,
                        "expectedSha must be the commit the URL names"
                    );
                    let branch = q.branch.as_deref().context(
                        "A commit watch needs branch: GitHub's exact head branch of the runs to watch, such as main",
                    )?;
                    ensure!(
                        client::branch(branch),
                        "branch must be an exact branch name of letters, digits, '.', '_', '-' and '/'"
                    );
                    let event = q.event.as_deref().context(
                        "A commit watch needs event: GitHub's exact event of the runs to watch, such as push",
                    )?;
                    ensure!(
                        client::event(event),
                        "event must be an exact GitHub event name, such as push"
                    );
                    (repo, "commit", 0)
                }
                None => {
                    ensure!(
                        q.branch.is_none() && q.event.is_none(),
                        "branch and event apply only to a commit URL"
                    );
                    client::target(&q.url)?
                }
            };
            let prior = q.clone();
            let author = actor.clone();
            if let Some(v) = ws
                .stored(move |s| s.ci_previous(author.as_deref(), &prior))
                .await?
            {
                return Ok(v);
            }
            let _gate = tokio::time::timeout(Duration::from_secs(2), ws.ci.gate.lock())
                .await
                .context("busy: CI reads are busy; retry shortly")?;
            let _slot = tokio::time::timeout(Duration::from_secs(2), ws.github.slots.acquire())
                .await
                .context("busy: GitHub reads are busy; retry shortly")??;
            let operation = async {
                let repo = client::read(&ws, format!("repos/{repo_name}"), 300).await?;
                let id = repo["value"]["id"]
                    .as_i64()
                    .filter(|v| *v > 0)
                    .context("Missing repository identity")?;
                let name = crate::github::client::parse(
                    repo["value"]["full_name"]
                        .as_str()
                        .context("Missing repository name")?,
                    false,
                )?
                .repo;
                let endpoint = match kind {
                    "pull" => format!("repos/{name}/pulls/{number}"),
                    // The commit object only (not its files), to confirm it is
                    // in this repository; it may have no run yet.
                    "commit" => format!("repos/{name}/git/commits/{}", q.expected_sha),
                    _ => format!("repos/{name}/actions/runs/{number}"),
                };
                // A new subscription is explicit about its expected commit. A stale
                // PR cache may not silently subscribe to a newer/older head.
                let raw = client::read(&ws, endpoint, 0).await?;
                if kind == "pull" {
                    ensure!(
                        raw["value"]["number"].as_u64() == Some(number)
                            && raw["value"]["base"]["repo"]["id"].as_i64() == Some(id),
                        "PR identity changed"
                    );
                    ensure!(
                        raw["value"]["head"]["sha"] == q.expected_sha,
                        "PR head changed; choose its actual commit before subscribing"
                    );
                } else if kind == "commit" {
                    ensure!(
                        raw["value"]["sha"] == q.expected_sha,
                        "The commit is not in this repository"
                    );
                } else {
                    let r = client::run(&raw["value"], id, &name)?;
                    ensure!(
                        r["runId"] == number.to_string() && r["headSha"] == q.expected_sha,
                        "Run does not match the expected commit"
                    );
                }
                ws.stored(move |s| {
                    s.ci_subscribe(
                        actor.as_deref(),
                        q,
                        crate::github::client::Repository {
                            id,
                            full_name: name,
                        },
                        kind,
                        number,
                    )
                })
                .await
            };
            let value = tokio::time::timeout(Duration::from_secs(30), operation)
                .await
                .context("timeout: CI subscription lookup timed out")??;
            changed(&ws);
            ws.ci.wake.notify_one();
            Ok(value)
        }
        "ci_get" => {
            let q: Reference = serde_json::from_value(input)?;
            ensure!(
                (1..=10).contains(&q.page),
                "Jobs page must be 1–10 (100 jobs each); use the native run link for larger workflows"
            );
            let key = q.run_key;
            let run = ws.stored(move |s| s.ci_run(&key)).await?;
            let mut response = json!({"run":run,"details":null,"error":null});
            let result = async {
                let _gate = tokio::time::timeout(Duration::from_secs(2), ws.ci.gate.lock())
                    .await
                    .context("busy: CI reads are busy; retry shortly")?;
                let _slot = tokio::time::timeout(Duration::from_secs(2), ws.github.slots.acquire())
                    .await
                    .context("busy: GitHub reads are busy; retry shortly")??;
                Ok::<_, anyhow::Error>(details(&ws, &run, q.page, SHARED_SECONDS).await?.0)
            }
            .await;
            match result {
                Ok(details) => response["details"] = details,
                Err(e) => response["error"] = json!(e.to_string()),
            }
            Ok(response)
        }
        "ci_refresh" => {
            let q: Refresh = serde_json::from_value(input)?;
            ensure!(
                (1..=10).contains(&q.pages),
                "Jobs pages must be 1–10 (100 jobs each); use the native run link for larger workflows"
            );
            refresh(&ws, q).await
        }
        _ => bail!("Unknown CI operation"),
    }
}
fn stamp(epoch: i64) -> String {
    chrono::DateTime::from_timestamp(epoch, 0)
        .unwrap_or_default()
        .to_rfc3339()
}
/// One bounded jobs/steps page of a run, and the cached read behind it.
async fn details(ws: &Arc<Workspace>, run: &Value, page: u64, ttl: i64) -> Result<(Value, Value)> {
    let endpoint = format!(
        "repos/{}/actions/runs/{}/attempts/{}/jobs?per_page=100&page={}",
        run["repository"].as_str().unwrap(),
        run["runId"].as_str().unwrap(),
        run["attempt"].as_str().unwrap(),
        page
    );
    let cached = client::read(ws, endpoint.clone(), ttl).await?;
    let next = client::next_page(cached["link"].as_str().unwrap_or(""), &endpoint, page)?.is_some();
    let mut jobs = client::jobs(&cached["value"], run, page, next)?;
    jobs["observedAt"] = json!(stamp(cached["fetchedAt"].as_i64().unwrap_or(0)));
    jobs["pageLimitReached"] = json!(next && page == 10);
    Ok((jobs, cached))
}

/// Asks GitHub now about the watches behind one run or one view, and about
/// that run's jobs pages on screen. It skips Yuzuno's own cache period but
/// never GitHub's poll interval, Retry-After, rate-limit reset or the shared
/// cooldown. Requests are serial under the CI gate, and whatever GitHub
/// answered since this was asked (or just before) is reused, so a second
/// window or click waiting here gets the first one's answer.
///
/// A known run without an active watch gets one exact-attempt read instead.
/// It never subscribes, renews or resumes a watch, or changes remote CI.
/// A failure leaves the last observation and the schedule as they were.
async fn refresh(ws: &Arc<Workspace>, q: Refresh) -> Result<Value> {
    let asked = chrono::Utc::now().timestamp();
    let Refresh {
        agent_id: agent,
        task_id: task,
        run_key,
        pages: wanted,
    } = q;
    let _gate = tokio::time::timeout(Duration::from_secs(30), ws.ci.gate.lock())
        .await
        .context("busy: CI reads are busy; retry shortly")?;
    let key = run_key.clone();
    let targets = ws
        .stored(move |s| {
            s.ci_refresh_targets(
                agent.as_deref(),
                task.as_deref(),
                key.as_deref(),
                REFRESH_WATCHES,
            )
        })
        .await?;
    let watches = targets["watches"].as_array().cloned().unwrap_or_default();
    let mut response = json!({"status":"nothing","checkedAt":null,"retryAt":null,"error":null,"watches":[],"paused":targets["paused"],"more":targets["more"],"runWatched":targets["runWatched"],"run":null,"details":null});
    if watches.is_empty() && run_key.is_none() {
        return Ok(response);
    }
    let ttl = move || chrono::Utc::now().timestamp() - asked + RECENT_SECONDS;
    let mut outcomes = Vec::new();
    let (mut checked, mut wait) = (i64::MAX, 0_i64);
    let mut observed = false;
    let mut run_changed = false;
    if watches.is_empty() {
        let key = run_key.clone().unwrap();
        let recent_error = {
            let mut failed = ws.ci.run_failures.lock().await;
            failed.retain(|_, (until, _)| *until > chrono::Utc::now().timestamp());
            failed.get(&key).map(|(_, error)| error.clone())
        };
        let seen = if let Some(error) = recent_error {
            Err(anyhow::anyhow!(error))
        } else {
            tokio::time::timeout(Duration::from_secs(30), async {
                let _slot = ws.github.slots.acquire().await?;
                refresh_unwatched_run(ws, &key, ttl()).await
            })
            .await
            .map_err(|_| anyhow::anyhow!("timeout: GitHub did not answer in time"))
            .and_then(|r| r)
        };
        if let Err(error) = &seen {
            let mut failed = ws.ci.run_failures.lock().await;
            if !failed.contains_key(&key) {
                if failed.len() >= 256 {
                    if let Some(oldest) = failed
                        .iter()
                        .min_by_key(|(_, (until, _))| until)
                        .map(|(k, _)| k.clone())
                    {
                        failed.remove(&oldest);
                    }
                }
                failed.insert(
                    key.clone(),
                    (
                        chrono::Utc::now().timestamp() + RECENT_SECONDS,
                        error.to_string(),
                    ),
                );
            }
        }
        outcomes.push(match seen {
            Ok((at, until, changed)) => {
                observed = true;
                run_changed = changed;
                checked = at;
                wait = until;
                json!({"watchId":null,"runKey":key,"status":verdict(at, asked),"checkedAt":stamp(at),"error":null})
            }
            Err(e) => json!({"watchId":null,"runKey":key,"status":"error","checkedAt":null,"error":e.to_string()}),
        });
    }
    for w in &watches {
        let id = w["id"].as_str().unwrap().to_owned();
        let seen = tokio::time::timeout(Duration::from_secs(30), async {
            let _slot = ws.github.slots.acquire().await?;
            observe(ws, w, ttl()).await
        })
        .await
        .map_err(|_| anyhow::anyhow!("timeout: GitHub did not answer in time"))
        .and_then(|r| r);
        let seen = match seen {
            Ok(seen) => {
                let (at, until) = (seen.checked, seen.wait);
                let update = id.clone();
                ws.stored(move |s| s.ci_observe(&update, Ok(seen)))
                    .await
                    .map(|_| (at, until))
            }
            Err(e) => Err(e),
        };
        outcomes.push(match seen {
            Ok((at, until)) => {
                observed = true;
                checked = checked.min(at);
                wait = wait.max(until);
                json!({"watchId":id,"status":verdict(at, asked),"checkedAt":stamp(at),"error":null})
            }
            Err(e) => json!({"watchId":id,"status":"error","checkedAt":null,"error":e.to_string()}),
        });
    }
    // Jobs/steps never stand in for the run's own authoritative status.
    let run_ok = (watches.is_empty() && observed)
        || outcomes
            .iter()
            .zip(&watches)
            .any(|(o, w)| w["linked"] == true && o["status"] != "error");
    if let Some(key) = run_key.filter(|_| run_ok) {
        let run = ws.stored(move |s| s.ci_run(&key)).await?;
        let pages = async {
            let mut pages = Vec::new();
            for page in 1..=wanted {
                let _slot = ws.github.slots.acquire().await?;
                // A changed run needs fresh steps; GitHub's own interval still
                // wins, including when a previous ci_get read them recently.
                let (jobs, cached) =
                    details(ws, &run, page, if run_changed { 0 } else { ttl() }).await?;
                let at = cached["fetchedAt"].as_i64().unwrap_or(0);
                let more = jobs["hasMore"] == true;
                pages.push((jobs, at, at + cached["pollSeconds"].as_i64().unwrap_or(0)));
                if !more {
                    break;
                }
            }
            Ok::<_, anyhow::Error>(pages)
        };
        match tokio::time::timeout(Duration::from_secs(30), pages)
            .await
            .map_err(|_| anyhow::anyhow!("timeout: GitHub did not answer in time"))
            .and_then(|r| r)
        {
            Ok(pages) => {
                // Steps answered earlier, under GitHub's poll interval, say so.
                let oldest = pages.iter().map(|p| p.1).min().unwrap_or(asked);
                for (_, at, until) in &pages {
                    checked = checked.min(*at);
                    wait = wait.max(*until);
                }
                outcomes.push(json!({"watchId":null,"status":verdict(oldest, asked),"checkedAt":stamp(oldest),"error":null}));
                response["details"] = json!(pages.into_iter().map(|p| p.0).collect::<Vec<_>>());
            }
            Err(e) => outcomes.push(json!({"watchId":null,"status":"error","checkedAt":null,"error":format!("Jobs and steps: {e}")})),
        }
        response["run"] = run;
    }
    if observed {
        changed(ws);
    }
    // The worst outcome speaks for the whole check.
    let rank = |s: &str| {
        ["checked", "recent", "github_interval", "cooldown", "error"]
            .iter()
            .position(|v| *v == s)
            .unwrap_or(4)
    };
    let cooldown = ws.stored(|s| s.ci_cooldown_until()).await?;
    let now = chrono::Utc::now().timestamp();
    for o in outcomes
        .iter_mut()
        .filter(|o| o["status"] == "error" && cooldown > now)
    {
        o["status"] = json!("cooldown");
    }
    let worst = outcomes
        .iter()
        .map(|o| o["status"].as_str().unwrap_or("error"))
        .max_by_key(|s| rank(s))
        .unwrap_or("checked")
        .to_owned();
    response["status"] = json!(worst);
    response["error"] = outcomes
        .iter()
        .find_map(|o| o["error"].as_str().map(str::to_owned))
        .map_or(Value::Null, Value::from);
    response["checkedAt"] = if checked == i64::MAX {
        Value::Null
    } else {
        json!(stamp(checked))
    };
    response["retryAt"] = match worst.as_str() {
        "cooldown" => json!(stamp(cooldown)),
        "github_interval" if wait > now => json!(stamp(wait)),
        _ => Value::Null,
    };
    response["watches"] = json!(outcomes);
    Ok(response)
}

/// Read only this recorded attempt, never the latest attempt or a PR's new
/// head. The write changes only existing run facts, not watches or interests.
async fn refresh_unwatched_run(
    ws: &Arc<Workspace>,
    key: &str,
    ttl: i64,
) -> Result<(i64, i64, bool)> {
    let key = key.to_owned();
    let old = ws.stored(move |s| s.ci_run(&key)).await?;
    let repo = old["repositoryId"]
        .as_i64()
        .context("Missing repository ID")?;
    let repository = client::read(ws, format!("repositories/{repo}"), 300).await?;
    ensure!(
        repository["value"]["id"].as_i64() == Some(repo),
        "Repository identity changed"
    );
    let name = crate::github::client::parse(
        repository["value"]["full_name"]
            .as_str()
            .context("Missing repository name")?,
        false,
    )?
    .repo;
    let raw = client::read(
        ws,
        format!(
            "repos/{name}/actions/runs/{}/attempts/{}",
            old["runId"].as_str().context("Missing run ID")?,
            old["attempt"].as_str().context("Missing attempt")?
        ),
        ttl,
    )
    .await?;
    let at = raw["fetchedAt"].as_i64().unwrap_or(0);
    let until = at.saturating_add(raw["pollSeconds"].as_i64().unwrap_or(0));
    let run = run_read(&raw, repo, &name, at)?;
    ensure!(
        run["id"] == old["id"] && run["headSha"] == old["headSha"],
        "Historical attempt identity or commit changed"
    );
    let changed = ws.stored(move |s| s.ci_refresh_run(run)).await?;
    Ok((at, until, changed))
}
/// How fresh a check is, against when it was asked for.
fn verdict(checked: i64, asked: i64) -> &'static str {
    if checked >= asked {
        "checked"
    } else if checked >= asked - RECENT_SECONDS {
        "recent"
    } else {
        // Only GitHub's poll interval keeps an older answer past the ttl.
        "github_interval"
    }
}
fn changed(ws: &Workspace) {
    ws.delivery.wake.notify_one();
    ws.changes
        .publish(&json!({"type":"workspace.changed","scope":"jobs"}));
    ws.collaboration_wakeup.notify_one();
}
impl Workspace {
    pub(crate) fn start_ci_monitor(self: &Arc<Self>) {
        if self.ci.started.set(()).is_err() {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(ws) = weak.upgrade() else { break };
                let pause = match tick(&ws).await {
                    // More may be due: take the next watch after a short
                    // pause, still one at a time.
                    Ok(true) => Duration::from_secs(1),
                    Ok(false) => match ws.stored(|s| s.ci_next_due()).await {
                        Ok(due) => idle(due, chrono::Utc::now().timestamp()),
                        Err(_) => Duration::from_secs(10),
                    },
                    Err(e) => {
                        eprintln!("CI monitoring: {e:#}");
                        Duration::from_secs(10)
                    }
                };
                let wake = ws.ci.wake.clone();
                drop(ws);
                tokio::select! {_=tokio::time::sleep(pause)=>{},_=wake.notified()=>{}}
            }
        });
    }
}
/// Sleeps until the next watch is due, so it is not left waiting for a
/// fixed ten-second beat; at most ten seconds, as before.
fn idle(due: Option<i64>, now: i64) -> Duration {
    Duration::from_secs(due.map_or(10, |due| (due - now).clamp(1, 10)) as u64)
}
/// Observes the most overdue watch, if any. Returns whether there was work.
async fn tick(ws: &Arc<Workspace>) -> Result<bool> {
    let Ok(_admission) = ws.admission.enter_completion() else {
        return Ok(false);
    };
    let _gate = ws.ci.gate.lock().await;
    let flushed = ws.stored(|s| s.ci_flush_notifications()).await?;
    if flushed {
        changed(ws);
    }
    let Some(w) = ws.stored(|s| s.ci_due()).await? else {
        return Ok(flushed);
    };
    let result = tokio::time::timeout(Duration::from_secs(60), async {
        let _slot = ws.github.slots.acquire().await?;
        observe(ws, &w, SHARED_SECONDS).await
    })
    .await
    .map_err(|_| anyhow::anyhow!("timeout: CI observation timed out"))
    .and_then(|r| r)
    .map_err(|e| e.to_string());
    let id = w["id"].as_str().unwrap().to_owned();
    let update_id = id.clone();
    if let Err(e) = ws.stored(move |s| s.ci_observe(&update_id, result)).await {
        ws.stored(move |s| s.ci_observe(&id, Err(e.to_string())))
            .await?;
    }
    changed(ws);
    Ok(true)
}
/// Notes each run read: the oldest GitHub answer and GitHub's poll interval.
#[derive(Default)]
struct Reads {
    checked: Option<i64>,
    wait: i64,
}
impl Reads {
    fn note(&mut self, read: &Value) -> i64 {
        let at = read["fetchedAt"].as_i64().unwrap_or(0);
        self.checked = Some(self.checked.map_or(at, |c| c.min(at)));
        self.wait = self
            .wait
            .max(at.saturating_add(read["pollSeconds"].as_i64().unwrap_or(0)));
        at
    }
}
/// A run as GitHub last answered for it, not as of this observation.
fn run_read(raw: &Value, repo: i64, name: &str, at: i64) -> Result<Value> {
    let mut run = client::run(&raw["value"], repo, name)?;
    run["observedAt"] = json!(stamp(at));
    Ok(run)
}
/// `ttl`: run reads younger than this many seconds are reused.
async fn observe(ws: &Arc<Workspace>, w: &Value, ttl: i64) -> Result<Observed> {
    let mut reads = Reads::default();
    let repo_id = w["repositoryId"]
        .as_i64()
        .context("Missing repository ID")?;
    let repository = client::read(ws, format!("repositories/{repo_id}"), 300).await?;
    ensure!(
        repository["value"]["id"].as_i64() == Some(repo_id),
        "Repository identity changed"
    );
    let name = crate::github::client::parse(
        repository["value"]["full_name"]
            .as_str()
            .context("Missing repository name")?,
        false,
    )?
    .repo;
    let number = w["number"].as_u64().unwrap();
    let mut head = None;
    let mut current_pr = None;
    let mut result = Vec::new();
    let mut truncated = false;
    let mut excluded = 0;
    if w["kind"] == "commit" {
        // Only this commit's runs on this branch for this event, and only
        // this repository's own: GitHub filters, and each row is checked.
        let (sha, branch, event) = (
            w["expectedSha"].as_str().context("Missing watched commit")?,
            w["branch"].as_str().context("Missing watched branch")?,
            w["event"].as_str().context("Missing watched event")?,
        );
        let mut endpoint = format!(
            "repos/{name}/actions/runs?head_sha={sha}&branch={}&event={event}&per_page=100&page=1",
            branch.replace('/', "%2F")
        );
        for page in 1..=10 {
            let raw = client::read(ws, endpoint.clone(), ttl).await?;
            let at = reads.note(&raw);
            let rows = raw["value"]["workflow_runs"]
                .as_array()
                .context("Missing workflow runs")?;
            ensure!(rows.len() <= 100, "Actions runs page exceeded its bound");
            for row in rows {
                let mut run = client::run(row, repo_id, &name)?;
                if run["headSha"] != sha
                    || run["branch"] != branch
                    || run["event"] != event
                    || run["headRepositoryId"].as_i64() != Some(repo_id)
                {
                    excluded += 1;
                    continue;
                }
                run["observedAt"] = json!(stamp(at));
                result.push(run);
            }
            match client::next_page(raw["link"].as_str().unwrap_or(""), &endpoint, page)? {
                Some(next) => {
                    endpoint = next;
                    truncated = page == 10
                }
                None => break,
            }
        }
    } else if w["kind"] == "pull" {
        let pr = client::read(ws, format!("repos/{name}/pulls/{number}"), ttl).await?;
        reads.note(&pr);
        ensure!(
            pr["value"]["number"].as_u64() == Some(number)
                && pr["value"]["base"]["repo"]["id"].as_i64() == Some(repo_id),
            "PR identity changed"
        );
        head = Some(
            pr["value"]["head"]["sha"]
                .as_str()
                .filter(|v| client::sha(v))
                .context("Missing current PR SHA")?
                .to_owned(),
        );
        current_pr = Some(json!({"baseSha":pr["value"]["base"]["sha"],"state":pr["value"]["state"],"merged":pr["value"]["merged"]}));
        let mut endpoint = format!(
            "repos/{name}/actions/runs?head_sha={}&per_page=100&page=1",
            w["expectedSha"].as_str().unwrap()
        );
        for page in 1..=10 {
            let raw = client::read(ws, endpoint.clone(), ttl).await?;
            let at = reads.note(&raw);
            let rows = raw["value"]["workflow_runs"]
                .as_array()
                .context("Missing workflow runs")?;
            ensure!(rows.len() <= 100, "Actions runs page exceeded its bound");
            for row in rows {
                let mut run = client::run(row, repo_id, &name)?;
                run["observedAt"] = json!(stamp(at));
                ensure!(
                    run["headSha"] == w["expectedSha"],
                    "GitHub run filter returned a different commit"
                );
                result.push(run);
            }
            match client::next_page(raw["link"].as_str().unwrap_or(""), &endpoint, page)? {
                Some(next) => {
                    endpoint = next;
                    truncated = page == 10
                }
                None => break,
            }
        }
    } else {
        let raw = client::read(ws, format!("repos/{name}/actions/runs/{number}"), ttl).await?;
        let at = reads.note(&raw);
        let run = run_read(&raw, repo_id, &name, at)?;
        ensure!(run["runId"] == number.to_string(), "Run identity changed");
        result.push(run);
    }
    // A rerun may have replaced a run's current attempt while Core was offline.
    // Reconcile only the bounded previously observed unfinished attempts.
    let id = w["id"].as_str().unwrap().to_owned();
    for old in ws.stored(move |s| s.ci_unfinished(&id)).await? {
        if result.iter().any(|r| r["id"] == old["id"]) {
            continue;
        }
        let raw = client::read(
            ws,
            format!(
                "repos/{name}/actions/runs/{}/attempts/{}",
                old["runId"].as_str().unwrap(),
                old["attempt"].as_str().unwrap()
            ),
            ttl,
        )
        .await?;
        let at = reads.note(&raw);
        let run = run_read(&raw, repo_id, &name, at)?;
        ensure!(
            run["id"] == old["id"],
            "Historical attempt identity changed"
        );
        result.push(run);
    }
    Ok(Observed {
        runs: result,
        head,
        pr: current_pr,
        truncated,
        checked: reads
            .checked
            .unwrap_or_else(|| chrono::Utc::now().timestamp()),
        wait: reads.wait,
        excluded,
    })
}
pub(crate) fn tool_definitions() -> Vec<Value> {
    let string = json!({"type":"string"});
    let task_reference = json!({"type":"string","description":crate::collaboration_store::TASK_ID});
    let make = |name: &str, description: &str, properties: Value, required: Vec<&str>| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    vec![
        make(
            "ci_subscribe",
            "Persistently watch an explicit GitHub.com PR at expectedSha, an Actions run, or a commit's runs on one branch for one event (a commit URL with branch and event, for example a merge commit on main for push, before any run exists), for your Agent and existing task. Core shares bounded reads, monitors for up to seven days and sends each completed run/attempt once through normal system mailbox; you may end your Turn. A commit watch waits for runs to appear (state waiting_for_run), reading less often while none does; it matches only runs of that exact SHA, branch, event and repository, never a PR's run or another branch's; if no matching run was observed by its expiry, one mail says so (with any failed reads), which is not proof that none ran. PR head changes never change the watched SHA. Same SHA reruns remain separate attempts. No workflow trigger/cancel/rerun, local CPU/RAM reservation, task completion or PR approval. Use a stable requestId for lost-reply retries; a new request explicitly renews monitoring. PR candidates close on task closure or observed PR merge; run and commit verification survive task closure until their fresh terminal results are notified (a commit watch also needs ten minutes of complete reads after the request that see nothing new, a bounded window for later workflows). Old request replay never reactivates monitoring.",
            json!({"requestId":string,"taskId":task_reference,"url":{"type":"string","description":"A GitHub.com pull request, Actions run or commit URL (https://github.com/{owner}/{repo}/commit/{sha})."},"expectedSha":crate::commit_sha::schema(
                crate::commit_sha::Form::GitHub, false, "The commit to watch: the PR head, the run's head, or the commit the commit URL names."),
                "branch":{"type":"string","description":"Commit URL only, and required there: GitHub's exact head branch of the runs to watch, for example main."},
                "event":{"type":"string","description":"Commit URL only, and required there: GitHub's exact event of the runs to watch, for example push."}}),
            vec!["requestId", "taskId", "url", "expectedSha"],
        ),
        make(
            "ci_list",
            "Read cached GitHub Actions runs and persistent subscriptions in Jobs. Without agentId or taskId it covers every Agent's subscriptions; runs come newest first, 50 per page (follow nextBefore while hasMore). Includes actual and watched SHA, last observation, errors and expiry. Reading never asks GitHub (ci_refresh does); ci_subscribe mails you when a run finishes.",
            json!({"agentId":string,"taskId":task_reference,"before":{"type":"integer"}}),
            vec![],
        ),
        make(
            "ci_get",
            "Read a known Actions run/attempt (including current runWatched state) and one bounded jobs/steps page (100 jobs, at most 10 pages). The run is Core's last observation, not read from GitHub here; the jobs/steps page comes from a short shared cache, and once that has expired from one conditional GitHub read (a failed read keeps the last observation). To have the run itself checked now use ci_refresh, which still waits for GitHub's poll interval and cooldowns; to be mailed when it finishes use ci_subscribe. Logs/artifacts use native GitHub links. CI success is not PR merge, review approval or task completion.",
            json!({"runKey":string,"page":{"type":"integer","minimum":1,"maximum":10,"default":1}}),
            vec!["runKey"],
        ),
        make(
            "ci_refresh",
            "Ask GitHub now about watched CI instead of waiting for Core's next check (running runs every 30 s, finished ones every 5 min). Checks the active watches behind runKey, or reads that exact known attempt once if its monitoring is stopped, expired or paused; also checks its first `pages` jobs/steps pages. Without runKey, checks active watches behind an Agent/task (at most five). Skips Yuzuno's cache period but honours GitHub's poll interval, Retry-After, rate-limit reset and the shared cooldown; concurrent and repeated requests reuse one answer. Never subscribes, renews, resumes a paused watch, reruns or cancels CI. status is checked, recent, github_interval, cooldown (see retryAt), error (last observation kept), or nothing to check.",
            json!({"agentId":string,"taskId":task_reference,"runKey":string,"pages":{"type":"integer","minimum":1,"maximum":10,"default":1}}),
            vec![],
        ),
        make(
            "ci_unsubscribe",
            "Idempotently stop all manual and delivery interests in your own CI subscription. Retains closure reasons, observed runs and historical mailbox results; other Agents/tasks sharing the watch remain independent. No remote cancellation occurs.",
            json!({"subscriptionId":string}),
            vec!["subscriptionId"],
        ),
    ]
}
