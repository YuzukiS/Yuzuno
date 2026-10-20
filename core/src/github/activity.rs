//! Recent activity of a Project's linked repositories, for Home's panel
//! header: default-branch commits, open PRs with GitHub's own check rollup,
//! and recent Actions runs. Reads only, through the Core host's gh. A per
//! repository cache bounds GitHub traffic: answers stay fresh for TTL,
//! attempts are at least MIN_INTERVAL apart, concurrent readers share one
//! read, and a failure keeps the last good answer marked stale.
use super::client::parse;
use crate::{model::now, server::ApiError, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{Path, State},
    Json,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// How long one answer is shown without asking GitHub again.
pub(crate) const TTL: Duration = Duration::from_secs(120);
/// No repository is read more often than this, failed reads included.
pub(crate) const MIN_INTERVAL: Duration = Duration::from_secs(30);
/// After a rate limit, every repository waits at least this long (the same
/// five minutes as github_refresh); GitHub's Retry-After or reset can extend it.
pub(crate) const RATE_COOLDOWN: Duration = Duration::from_secs(300);
/// Items per list, per repository.
pub(crate) const LIMIT: usize = 5;

/// One fixed read-only query: the default branch's latest commits and the
/// most recently updated open PRs with their head commit's check rollup.
const QUERY: &str = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){databaseId nameWithOwner defaultBranchRef{name target{... on Commit{history(first:5){nodes{oid messageHeadline committedDate author{name user{login}}}}}}} pullRequests(states:OPEN,first:5,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{number title isDraft headRefOid author{login} commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}}}}}";

/// A read that did not answer. `until` ends a rate-limit cooldown.
pub(crate) struct Failure {
    pub(crate) message: String,
    pub(crate) until: Option<Instant>,
}
impl Failure {
    /// Only Core's own classified messages reach the screen; gh diagnostics
    /// and anything unexpected become a fixed sentence.
    pub(crate) fn from_error(error: &anyhow::Error) -> Self {
        let text = error.to_string();
        let class = text.split(':').next().unwrap_or("");
        let message = match class {
            "timeout" => "timeout: GitHub did not answer in time".to_owned(),
            "rate_limited" | "not_authenticated" | "not_found" | "forbidden" | "gh_missing"
            | "gh_unavailable" | "response_too_large" | "invalid_response" | "unavailable"
            | "busy" => text.chars().take(200).collect(),
            _ => "unavailable: GitHub could not complete the read".to_owned(),
        };
        let until = message
            .starts_with("rate_limited")
            .then(|| Instant::now() + RATE_COOLDOWN);
        Self { message, until }
    }
    fn new(message: &str) -> Self {
        Self {
            message: message.into(),
            until: None,
        }
    }
}

#[derive(Default)]
struct Slot {
    /// The last good answer, with observedAt and the runs ETag.
    good: Option<Value>,
    good_at: Option<Instant>,
    error: Option<String>,
    attempted: Option<Instant>,
}

#[derive(Default)]
pub struct Cache {
    slots: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<Slot>>>>,
    /// A rate limit is per GitHub account, so it pauses every repository.
    cooldown: Mutex<Option<Instant>>,
}
impl Cache {
    /// The repository's activity as of `now`. `fetch` runs only when the
    /// answer is older than TTL (or failed), the last attempt is at least
    /// MIN_INTERVAL old and no rate-limit cooldown is running. It gets the
    /// last good answer and returns new data and/or a failure; data with a
    /// failure is a partial answer. Readers of one repository wait for the
    /// read already under way rather than starting another.
    pub(crate) async fn read<F, Fut>(&self, id: i64, now: Instant, fetch: F) -> Value
    where
        F: FnOnce(Option<Value>) -> Fut,
        Fut: Future<Output = (Option<Value>, Option<Failure>)>,
    {
        let slot = self.slots.lock().unwrap().entry(id).or_default().clone();
        let mut slot = slot.lock().await;
        let since = |t: Option<Instant>| t.map(|t| now.saturating_duration_since(t));
        let fresh = slot.error.is_none() && since(slot.good_at).is_some_and(|d| d < TTL);
        let recent = since(slot.attempted).is_some_and(|d| d < MIN_INTERVAL);
        let cooling = self.cooldown.lock().unwrap().is_some_and(|t| t > now);
        if !fresh && !recent {
            if cooling {
                if !slot
                    .error
                    .as_deref()
                    .is_some_and(|e| e.starts_with("rate_limited"))
                {
                    slot.error =
                        Some("rate_limited: GitHub rate limit reached; retry later".into());
                }
            } else {
                slot.attempted = Some(now);
                let (data, failure) = fetch(slot.good.clone()).await;
                if let Some(data) = data {
                    slot.good = Some(data);
                    slot.good_at = Some(now);
                }
                slot.error = failure.as_ref().map(|f| f.message.clone());
                if let Some(until) = failure.and_then(|f| f.until) {
                    let mut cooldown = self.cooldown.lock().unwrap();
                    *cooldown = Some(cooldown.map_or(until, |t| t.max(until)));
                }
            }
        }
        let mut view = slot
            .good
            .clone()
            .unwrap_or_else(|| json!({"observedAt":null,"commits":[],"pulls":[],"runs":[]}));
        if let Some(map) = view.as_object_mut() {
            map.remove("runsEtag");
        }
        if let Some(error) = &slot.error {
            view["error"] = json!(error);
        }
        view["stale"] = json!(slot.error.is_some() || since(slot.good_at).is_none_or(|d| d >= TTL));
        view
    }

    /// Tests: every answer and attempt happened `by` earlier.
    #[cfg(test)]
    pub(crate) fn age(&self, by: Duration) {
        for slot in self.slots.lock().unwrap().values() {
            let mut guard = slot.try_lock().unwrap();
            let slot = &mut *guard;
            for t in [&mut slot.good_at, &mut slot.attempted] {
                *t = t.and_then(|t| t.checked_sub(by));
            }
        }
    }
}

fn text(value: &Value, limit: usize) -> Option<String> {
    value
        .as_str()
        .map(|s| s.lines().next().unwrap_or("").chars().take(limit).collect())
}
fn time(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .map_or(Value::Null, |s| json!(s))
}
/// A GitHub state word such as completed or in_progress; anything else is unknown.
fn word(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
        .map(str::to_owned)
}
fn sha(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The GraphQL `data` for repository `id`: its current name, default branch,
/// commits and open PRs. Links are built from validated parts, never taken
/// from the response.
pub(crate) fn parse_repository(id: i64, data: &Value) -> Result<Value> {
    let repo = &data["repository"];
    ensure!(
        repo.is_object(),
        "not_found: GitHub object was not found or this account cannot access it"
    );
    ensure!(
        repo["databaseId"].as_i64() == Some(id),
        "invalid_response: Repository identity changed"
    );
    let full = parse(
        repo["nameWithOwner"]
            .as_str()
            .context("invalid_response: Missing repository name")?,
        false,
    )?
    .repo;
    let branch = repo["defaultBranchRef"]["name"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 255);
    let commits: Vec<Value> = repo["defaultBranchRef"]["target"]["history"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let sha = sha(&c["oid"])?;
            let author = text(&c["author"]["user"]["login"], 100)
                .or_else(|| text(&c["author"]["name"], 100));
            Some(json!({"sha":sha,"title":text(&c["messageHeadline"],240).unwrap_or_default(),"author":author,"at":time(&c["committedDate"]),"url":format!("https://github.com/{full}/commit/{sha}")}))
        })
        .take(LIMIT)
        .collect();
    let pulls: Vec<Value> = repo["pullRequests"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let number = p["number"].as_u64().filter(|n| *n > 0 && *n <= i32::MAX as u64)?;
            let mut pull = json!({"number":number,"title":text(&p["title"],240).unwrap_or_default(),"author":text(&p["author"]["login"],100),"url":format!("https://github.com/{full}/pull/{number}"),"draft":p["isDraft"]==true});
            // The rollup counts only when it belongs to the PR's current head.
            let head = &p["commits"]["nodes"][0]["commit"];
            if sha(&head["oid"]).is_some() && head["oid"] == p["headRefOid"] {
                let state = match head["statusCheckRollup"]["state"].as_str() {
                    Some("SUCCESS") => Some("success"),
                    Some("FAILURE" | "ERROR") => Some("failure"),
                    Some("PENDING" | "EXPECTED") => Some("pending"),
                    _ => None,
                };
                if let Some(state) = state {
                    pull["ci"] = json!({"state":state});
                }
            }
            Some(pull)
        })
        .take(LIMIT)
        .collect();
    let mut value = json!({"fullName":full,"url":format!("https://github.com/{full}"),"commits":commits,"pulls":pulls,"pullsTotal":repo["pullRequests"]["totalCount"].as_u64()});
    if let Some(branch) = branch {
        value["defaultBranch"] = json!(branch);
    }
    Ok(value)
}

/// One page of `repos/{full}/actions/runs`, newest first.
pub(crate) fn parse_runs(id: i64, full: &str, page: &Value) -> Result<Vec<Value>> {
    let rows = page["workflow_runs"]
        .as_array()
        .context("invalid_response: Missing Actions runs")?;
    let mut runs = Vec::new();
    for r in rows.iter().take(LIMIT) {
        let Some(run) = r["id"].as_u64().filter(|v| *v > 0 && *v <= i64::MAX as u64) else {
            continue;
        };
        ensure!(
            r["repository"]["id"].as_i64() == Some(id),
            "invalid_response: Actions repository identity changed"
        );
        let at = match time(&r["run_started_at"]) {
            Value::Null => time(&r["created_at"]),
            at => at,
        };
        runs.push(json!({"id":run,"name":text(&r["name"],240).unwrap_or_else(||"Workflow".into()),"branch":text(&r["head_branch"],255),"status":word(&r["status"]).unwrap_or_else(||"unknown".into()),"conclusion":word(&r["conclusion"]),"at":at,"url":format!("https://github.com/{full}/actions/runs/{run}")}));
    }
    Ok(runs)
}

/// GitHub's own wait after a failed conditional read, when it gave one.
fn wait(headers: &Value) -> Option<Instant> {
    let epoch = chrono::Utc::now().timestamp();
    let retry = headers["retry-after"]
        .as_str()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let reset = if headers["x-ratelimit-remaining"] == "0" {
        headers["x-ratelimit-reset"]
            .as_str()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
            - epoch
    } else {
        0
    };
    let seconds = retry.max(reset);
    (seconds > 0).then(|| Instant::now() + Duration::from_secs(seconds.min(3600) as u64))
}

/// Reads one repository: the GraphQL query, then its Actions runs as a
/// conditional read (an unchanged page costs no rate limit). Failed runs
/// keep the previous runs beside fresh commits and PRs.
async fn fetch(
    ws: &Arc<Workspace>,
    id: i64,
    full: String,
    previous: Option<Value>,
) -> (Option<Value>, Option<Failure>) {
    // Reads cannot start across the update admission fence.
    let Ok(_permit) = ws.admission.enter_work() else {
        return (
            None,
            Some(Failure::new("busy: Yuzuno is preparing an update")),
        );
    };
    let Ok(Ok(_slot)) =
        tokio::time::timeout(Duration::from_secs(10), ws.github.slots.acquire()).await
    else {
        return (
            None,
            Some(Failure::new("busy: GitHub reads are busy; retry shortly")),
        );
    };
    let read = async {
        let Some((owner, name)) = full.split_once('/') else {
            return (
                None,
                Some(Failure::new(
                    "invalid_response: Invalid stored repository name",
                )),
            );
        };
        let data = match ws
            .github
            .client
            .graphql(QUERY, json!({"owner":owner,"name":name}))
            .await
            .and_then(|data| parse_repository(id, &data))
        {
            Ok(data) => data,
            Err(e) => return (None, Some(Failure::from_error(&e))),
        };
        let current = data["fullName"].as_str().unwrap_or(&full).to_owned();
        let mut value = data;
        value["observedAt"] = json!(now());
        let endpoint =
            format!("repos/{current}/actions/runs?per_page={LIMIT}&exclude_pull_requests=true");
        let etag = previous
            .as_ref()
            .filter(|p| p["fullName"] == current.as_str())
            .and_then(|p| p["runsEtag"].as_str().map(str::to_owned));
        let kept = || {
            previous
                .as_ref()
                .filter(|p| p["fullName"] == current.as_str())
                .map(|p| (p["runs"].clone(), p["runsEtag"].clone()))
                .unwrap_or((json!([]), Value::Null))
        };
        let failure = match ws
            .github
            .client
            .conditional(&endpoint, etag.as_deref())
            .await
        {
            Ok(response) if response["error"].is_null() && response["code"] == 304 => {
                (value["runs"], value["runsEtag"]) = kept();
                None
            }
            Ok(response) if response["error"].is_null() => {
                match parse_runs(id, &current, &response["value"]) {
                    Ok(runs) => {
                        value["runs"] = json!(runs);
                        value["runsEtag"] = response["headers"]["etag"].clone();
                        None
                    }
                    Err(e) => Some(Failure::from_error(&e)),
                }
            }
            Ok(response) => {
                let mut failure = Failure::from_error(&anyhow::anyhow!(
                    "{}",
                    response["error"].as_str().unwrap_or("unavailable")
                ));
                if matches!(response["code"].as_u64(), Some(429)) && failure.until.is_none() {
                    failure.until = Some(Instant::now() + RATE_COOLDOWN);
                }
                if let Some(until) = wait(&response["headers"]) {
                    failure.until = Some(failure.until.map_or(until, |t| t.max(until)));
                }
                Some(failure)
            }
            Err(e) => Some(Failure::from_error(&e)),
        };
        let failure = failure.map(|mut f| {
            (value["runs"], value["runsEtag"]) = kept();
            f.message = format!("Actions runs: {}", f.message);
            f
        });
        (Some(value), failure)
    };
    // Each gh read has its own deadline; the whole repository also has one.
    tokio::time::timeout(Duration::from_secs(25), read)
        .await
        .unwrap_or_else(|_| {
            (
                None,
                Some(Failure::new("timeout: GitHub did not answer in time")),
            )
        })
}

/// Every repository linked to the Project, read in parallel under the shared
/// GitHub slots. A Project without linked repositories has an empty list.
pub(crate) async fn project(ws: &Arc<Workspace>, project: String) -> Result<Value> {
    let page = ws
        .stored(move |s| s.github_list(Some(&project), None))
        .await?;
    let linked: Vec<(i64, String)> = page["repositories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| Some((r["id"].as_i64()?, r["fullName"].as_str()?.to_owned())))
        .collect();
    let reads = linked.into_iter().map(|(id, full)| async move {
        let mut repo = json!({"id":id,"fullName":full,"url":format!("https://github.com/{full}")});
        let view = ws
            .github
            .activity
            .read(id, Instant::now(), |previous| fetch(ws, id, full, previous))
            .await;
        for (key, value) in view.as_object().into_iter().flatten() {
            if !value.is_null() || !repo.get(key).is_some_and(|v| !v.is_null()) {
                repo[key] = value.clone();
            }
        }
        repo
    });
    let repositories = futures_util::future::join_all(reads).await;
    Ok(json!({"observedAt":now(),"repositories":repositories}))
}

pub(super) async fn route(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(project(&ws, id).await?))
}
