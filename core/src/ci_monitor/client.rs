use crate::{model::now, workspace::Workspace};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) fn sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A commit URL, exactly `https://github.com/{owner}/{repo}/commit/{sha}`:
/// its repository and full SHA (lowercase). None for a URL that names no
/// commit; an error for one that does but in any other form (extra or
/// doubled slashes, `.git`, query, fragment, spaces, an abbreviated SHA).
pub(super) fn commit(url: &str) -> Result<Option<(String, String)>> {
    if !url.contains("/commit/") {
        return Ok(None);
    }
    let shape = "Use a commit URL of exactly the form https://github.com/{owner}/{repo}/commit/{40-character SHA}";
    ensure!(url.len() <= 260, "{shape}");
    let parts: Vec<&str> = url
        .strip_prefix("https://github.com/")
        .context(shape)?
        .split('/')
        .collect();
    ensure!(parts.len() == 4 && parts[2] == "commit", "{shape}");
    let named = format!("{}/{}", parts[0], parts[1]);
    let repo = crate::github::client::parse(&named, false)?.repo;
    ensure!(repo == named, "{shape}");
    ensure!(
        sha(parts[3]),
        "A commit URL names the full 40-character commit SHA"
    );
    Ok(Some((repo, parts[3].to_ascii_lowercase())))
}

/// The branch a commit watch matches: GitHub's exact `head_branch`. Kept to
/// characters that need no escaping beyond `/` in a query.
pub(super) fn branch(value: &str) -> bool {
    (1..=200).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        && !value.starts_with(['/', '-'])
        && !value.ends_with('/')
        && !value.contains("//")
        && !value.contains("..")
}

/// The event a commit watch matches: GitHub's exact `event`, such as `push`.
pub(super) fn event(value: &str) -> bool {
    (1..=40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

pub(super) fn target(url: &str) -> Result<(String, &'static str, u64)> {
    if url.contains("/pull/") {
        let parsed = crate::github::client::parse(url, true)?;
        ensure!(
            parsed.kind.as_deref() == Some("pull"),
            "Subscribe to a pull request or Actions run"
        );
        return Ok((parsed.repo, "pull", parsed.number.unwrap()));
    }
    let path = url
        .strip_prefix("https://github.com/")
        .context("Use a GitHub.com pull request, Actions run or commit URL")?;
    let (repo, number) = path
        .split_once("/actions/runs/")
        .context("Use a GitHub.com pull request, Actions run or commit URL")?;
    let repo = crate::github::client::parse(repo, false)?.repo;
    let n = number.parse::<u64>().context("Invalid Actions run ID")?;
    ensure!(
        n > 0 && n <= i64::MAX as u64 && n.to_string() == number,
        "Invalid Actions run ID"
    );
    Ok((repo, "run", n))
}

pub(super) fn status(raw: &Value) -> &'static str {
    match raw["status"].as_str() {
        Some("completed") => match raw["conclusion"].as_str() {
            Some("success") => "passed",
            Some("failure" | "timed_out" | "action_required" | "startup_failure") => "failed",
            Some("cancelled") => "cancelled",
            Some("skipped" | "neutral") => "skipped",
            _ => "unknown",
        },
        Some("in_progress") => "running",
        Some("queued" | "waiting" | "pending" | "requested") => "pending",
        _ => "unknown",
    }
}

pub(super) fn run(raw: &Value, repo: i64, name: &str) -> Result<Value> {
    let id = raw["id"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= i64::MAX as u64)
        .context("Missing Actions run ID")?;
    let attempt = raw["run_attempt"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 100000)
        .context("Missing Actions run attempt")?;
    let head = raw["head_sha"]
        .as_str()
        .filter(|v| sha(v))
        .context("Missing Actions run SHA")?;
    ensure!(
        raw["repository"]["id"].as_i64() == Some(repo),
        "Actions repository identity changed"
    );
    let name_text: String = raw["name"]
        .as_str()
        .unwrap_or("Workflow")
        .chars()
        .take(240)
        .collect();
    Ok(
        json!({"id":format!("github:{repo}:{id}:{attempt}"),"source":"github_actions","workflowId":raw["workflow_id"],"repositoryId":repo,"repository":name,"runId":id.to_string(),"attempt":attempt.to_string(),"headSha":head,"name":name_text,"status":status(raw),"rawStatus":raw["status"],"conclusion":raw["conclusion"],"event":raw["event"],"branch":raw["head_branch"],"headRepositoryId":raw["head_repository"]["id"],"createdAt":raw["created_at"],"startedAt":raw["run_started_at"],"updatedAt":raw["updated_at"],"observedAt":now(),"url":format!("https://github.com/{name}/actions/runs/{id}/attempts/{attempt}")}),
    )
}

pub(super) fn jobs(raw: &Value, run: &Value, page: u64, next: bool) -> Result<Value> {
    let rows = raw["jobs"].as_array().context("Missing Actions jobs")?;
    ensure!(rows.len() <= 100, "Actions jobs page exceeded its bound");
    let mut result = Vec::new();
    for job in rows {
        ensure!(
            job["run_id"].as_u64().map(|v| v.to_string()).as_deref() == run["runId"].as_str(),
            "Job belongs to another run"
        );
        ensure!(
            job["head_sha"] == run["headSha"],
            "Job belongs to another commit"
        );
        if !job["run_attempt"].is_null() {
            ensure!(
                job["run_attempt"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .as_deref()
                    == run["attempt"].as_str(),
                "Job belongs to another attempt"
            );
        }
        let id = job["id"].as_u64().context("Missing job identity")?;
        let steps: Vec<Value> = job["steps"].as_array().into_iter().flatten().take(500).map(|s| json!({"number":s["number"],"name":s["name"].as_str().unwrap_or("").chars().take(240).collect::<String>(),"status":s["status"],"conclusion":s["conclusion"],"startedAt":s["started_at"],"completedAt":s["completed_at"]})).collect();
        result.push(json!({"id":id,"name":job["name"].as_str().unwrap_or("").chars().take(240).collect::<String>(),"status":status(job),"rawStatus":job["status"],"conclusion":job["conclusion"],"startedAt":job["started_at"],"completedAt":job["completed_at"],"url":format!("https://github.com/{}/actions/runs/{}/job/{id}",run["repository"].as_str().unwrap(),run["runId"].as_str().unwrap()),"steps":steps,"stepsTruncated":job["steps"].as_array().is_some_and(|s|s.len()>500)}));
    }
    Ok(
        json!({"jobs":result,"page":page,"hasMore":next,"nextPage":if next {Some(page+1)} else {None},"totalCount":raw["total_count"],"observedAt":now()}),
    )
}

/// Only a same-endpoint next page is accepted. Never send gh credentials to an
/// arbitrary Link target, and never let a remote response grow an unbounded loop.
pub(super) fn next_page(link: &str, endpoint: &str, page: u64) -> Result<Option<String>> {
    for entry in link.split(',') {
        if !entry.contains("rel=\"next\"") {
            continue;
        }
        let url = entry
            .trim()
            .split_once('<')
            .and_then(|(_, s)| s.split_once('>'))
            .map(|(s, _)| s)
            .context("Invalid GitHub pagination link")?;
        let next = url
            .strip_prefix("https://api.github.com/")
            .context("Invalid GitHub pagination host")?;
        let (path, query) = next.split_once('?').context("Missing GitHub page query")?;
        ensure!(
            path == endpoint.split('?').next().unwrap(),
            "GitHub pagination changed endpoint"
        );
        let current: std::collections::BTreeMap<_, _> = endpoint
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("")
            .split('&')
            .filter_map(|p| p.split_once('='))
            .filter(|(k, _)| *k != "page")
            .collect();
        let params: std::collections::BTreeMap<_, _> =
            query.split('&').filter_map(|p| p.split_once('=')).collect();
        ensure!(
            params.get("page").and_then(|v| v.parse::<u64>().ok()) == Some(page + 1),
            "Invalid next GitHub page"
        );
        ensure!(
            params
                .iter()
                .filter(|(k, _)| **k != "page")
                .map(|(k, v)| (*k, *v))
                .collect::<std::collections::BTreeMap<_, _>>()
                == current,
            "GitHub pagination changed filters"
        );
        return Ok(Some(next.to_owned()));
    }
    Ok(None)
}

pub(super) async fn read(ws: &Arc<Workspace>, endpoint: String, ttl: i64) -> Result<Value> {
    let key = endpoint.clone();
    let (cached, cooldown) = ws.stored(move |s| s.ci_cache(&key)).await?;
    let epoch = chrono::Utc::now().timestamp();
    if cached.as_ref().is_some_and(|c| {
        c["fetchedAt"]
            .as_i64()
            .unwrap_or(0)
            .saturating_add(ttl.max(c["pollSeconds"].as_i64().unwrap_or(0)))
            > epoch
    }) {
        return Ok(cached.unwrap());
    }
    ensure!(
        cooldown <= epoch,
        "rate_limited: GitHub reads are cooling down until {cooldown}; last observation retained"
    );
    let etag = cached.as_ref().and_then(|v| v["etag"].as_str());
    let response = ws.github.client.conditional(&endpoint, etag).await?;
    let h = &response["headers"];
    if !response["error"].is_null() {
        let retry = h["retry-after"]
            .as_str()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
            .max(0);
        let reset = if h["x-ratelimit-remaining"] == "0" {
            h["x-ratelimit-reset"]
                .as_str()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0)
        } else {
            0
        };
        let rate = matches!(response["code"].as_u64(), Some(403 | 429));
        if rate || retry > 0 || reset > epoch {
            let until = reset.max(epoch.saturating_add(retry.max(300)));
            ws.stored(move |s| s.ci_cooldown(until)).await?;
        }
        anyhow::bail!(
            "{}",
            response["error"].as_str().unwrap_or("GitHub read failed")
        );
    }
    let mut value = if response["code"] == 304 {
        cached.context("invalid_response: GitHub returned 304 without a cached body")?
    } else {
        json!({"value":response["value"],"link":h["link"],"etag":h["etag"]})
    };
    value["fetchedAt"] = json!(epoch);
    value["pollSeconds"] = json!(
        h["x-poll-interval"]
            .as_str()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
            .max(0)
    );
    let saved = value.clone();
    ws.stored(move |s| s.ci_save_cache(&endpoint, saved))
        .await?;
    Ok(value)
}
