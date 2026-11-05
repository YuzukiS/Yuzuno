//! One gate check: fresh reads in the order `checks` decides on them, so a
//! later, costlier read (job logs) happens only when everything before it held.
use super::checks::{self, Check, Checkout};
use crate::workspace::Workspace;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Through the CI monitor's shared read: its ETag cache and cooldown.
async fn read(ws: &Arc<Workspace>, endpoint: String) -> Result<Value> {
    crate::ci_monitor::shared_read(ws, endpoint).await
}
/// A branch name as one URL path segment.
fn segment(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn array(value: &Value, key: &str) -> Vec<Value> {
    value[key].as_array().cloned().unwrap_or_default()
}

/// The evidence read so far, and the decision: `Ok(())` means ready.
pub(super) async fn check(ws: &Arc<Workspace>, entry: &Value) -> Result<(Value, Check<()>)> {
    let _slot = ws.github.slots.acquire().await?;
    let repo = entry["repository"].as_str().context("The entry has no repository")?.to_owned();
    let number = entry["number"].as_u64().context("The entry has no PR number")?;
    let head = entry["headSha"].as_str().context("The entry has no head")?.to_owned();
    let base = entry["baseBranch"].as_str().context("The entry has no base branch")?.to_owned();
    let link = entry["linkId"].as_str().context("The entry has no PR link")?.to_owned();
    let mut evidence = json!({"checkedAt":crate::model::now()});
    macro_rules! hold {
        ($decision:expr) => {
            match $decision {
                Ok(value) => value,
                Err(hold) => return Ok((evidence, Err(hold))),
            }
        };
    }
    let pr = read(ws, format!("repos/{repo}/pulls/{number}")).await?;
    hold!(checks::pull(entry, &pr));
    let (latest, running) = ws.stored(move |s| s.merge_review(&link)).await?;
    let review = hold!(checks::review(entry, latest.as_ref(), running));
    evidence["review"] = review;

    let by_ref = read(ws, format!("repos/{repo}/git/ref/heads/{base}")).await?;
    let by_branch = read(ws, format!("repos/{repo}/branches/{}", segment(&base))).await?;
    let main = hold!(checks::main_agrees(
        by_ref["object"]["sha"].as_str().unwrap_or(""),
        by_branch["commit"]["sha"].as_str().unwrap_or("")
    ));
    let main_commit = read(ws, format!("repos/{repo}/git/commits/{main}")).await?;
    let since = entry["mainAtRelease"].as_str().unwrap_or(&main).to_owned();
    evidence["main"] = json!({"atRelease":since,"before":main,"beforeTree":checks::tree_of(&main_commit)});
    let main_runs = read(ws, format!("repos/{repo}/actions/runs?branch={}&event=push&per_page=20", segment(&base))).await?;
    let main_ci = hold!(checks::main_health(&array(&main_runs, "workflow_runs"), &since));
    evidence["main"]["ci"] = main_ci;

    let runs = read(ws, format!("repos/{repo}/actions/runs?head_sha={head}&event=pull_request&per_page=100")).await?;
    let required: Vec<String> = serde_json::from_value(entry["requireWorkflows"].clone()).unwrap_or_default();
    let newest = hold!(checks::head_runs(&array(&runs, "workflow_runs"), &required));
    hold!(checks::mergeable(&pr));

    let merge = match read(ws, format!("repos/{repo}/git/ref/pull/{number}/merge")).await {
        Ok(r) => match r["object"]["sha"].as_str() {
            Some(sha) => Some(read(ws, format!("repos/{repo}/git/commits/{sha}")).await?),
            None => None,
        },
        Err(e) if e.to_string().starts_with("not_found") => None,
        Err(e) => return Err(e),
    };
    let tree = hold!(checks::slot(merge.as_ref(), &main, &head));
    let merge = merge.context("The PR's merge ref vanished")?;

    let ci = newest.iter().find(|r| r["name"] == checks::CI).context("The CI run vanished")?;
    let attempt = ci["run_attempt"].as_u64().unwrap_or(1);
    let jobs = read(ws, format!("repos/{repo}/actions/runs/{}/attempts/{attempt}/jobs?per_page=100", ci["id"])).await?;
    let mut proofs = Vec::new();
    for job in array(&jobs, "jobs") {
        if job["conclusion"] == "skipped" {
            proofs.push(Checkout { job, line: None, commit: None, sha256: String::new(), bytes: 0, truncated: false });
            continue;
        }
        let cooldown = ws.stored(crate::ci_monitor::read_cooldown).await?;
        ensure!(
            cooldown <= chrono::Utc::now().timestamp(),
            "rate_limited: GitHub reads are cooling down until {cooldown}"
        );
        let (log, truncated) = ws
            .github
            .client
            .log_prefix(&format!("repos/{repo}/actions/jobs/{}/logs", job["id"]), checks::LOG_LIMIT)
            .await?;
        let line = checks::checkout_line(&log);
        let commit = match &line {
            Some((merge, _, _)) => Some(read(ws, format!("repos/{repo}/commits/{merge}")).await?),
            None => None,
        };
        proofs.push(Checkout { sha256: format!("{:x}", Sha256::digest(&log)), bytes: log.len(), truncated, line, commit, job });
    }
    let proved = hold!(checks::checkouts(&proofs, &main, &head, &tree));
    evidence["gate"] = json!({"kind":"slot","tree":tree,
        "mergeRef":{"sha":merge["sha"],"parents":checks::parents(&merge),"tree":tree},
        "runs":newest.iter().map(|r| json!({"workflow":r["name"],"run":r["id"],"attempt":r["run_attempt"],"conclusion":r["conclusion"],
            "jobs":if r["id"] == ci["id"] { json!(proved) } else { json!([]) }})).collect::<Vec<_>>()});
    evidence["wouldMerge"] = json!({"method":"merge","sha":head,"endpoint":format!("repos/{repo}/pulls/{number}/merge")});
    Ok((evidence, Ok(())))
}

/// At release: the PR's base branch and head, and the main of that moment.
pub(super) async fn release_reads(ws: &Arc<Workspace>, repo: &str, number: u64) -> Result<(Value, String)> {
    let _slot = ws.github.slots.acquire().await?;
    let pr = read(ws, format!("repos/{repo}/pulls/{number}")).await?;
    let base = pr["base"]["ref"].as_str().context("The PR has no base branch")?.to_owned();
    let main = read(ws, format!("repos/{repo}/git/ref/heads/{base}")).await?["object"]["sha"]
        .as_str()
        .context("The base branch has no commit")?
        .to_owned();
    Ok((pr, main))
}
