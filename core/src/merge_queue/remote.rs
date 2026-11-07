//! GitHub I/O of the queue, in the order `checks` decides on it: a later,
//! costlier read (job logs) or a write happens only when everything before it
//! held. Each read takes one GitHub slot and gives it back; job-log downloads
//! take none, so a check never holds the CI monitor's reads up.
use super::checks::{self, Answer, Check, Checkout, Hold};
use super::writes::{self, Write};
use crate::workspace::Workspace;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// At most this many pages of a paged list are read (100 items each).
const PAGES: u64 = 10;

/// One read through the CI monitor's shared read (its ETag cache and
/// cooldown), holding a GitHub slot only while it runs.
pub(super) async fn read(ws: &Arc<Workspace>, endpoint: String) -> Result<Value> {
    let _slot = ws.github.slots.acquire().await?;
    crate::ci_monitor::shared_read(ws, endpoint).await
}
/// Every page of a list, up to `PAGES`: its items, GitHub's `total_count`,
/// and whether GitHub named a page past the last one read.
pub(super) async fn pages(ws: &Arc<Workspace>, endpoint: String, key: &str) -> Result<(Vec<Value>, Option<u64>, bool)> {
    let (mut items, mut total, mut next, mut page) = (Vec::new(), None, Some(endpoint), 1);
    while let Some(at) = next.take() {
        let (value, more) = {
            let _slot = ws.github.slots.acquire().await?;
            crate::ci_monitor::shared_page(ws, at, page).await?
        };
        total = total.or(value["total_count"].as_u64());
        items.extend(array(&value, key));
        if page == PAGES {
            return Ok((items, total, more.is_some()));
        }
        (next, page) = (more, page + 1);
    }
    Ok((items, total, false))
}
/// A branch name as one URL path segment.
pub(super) fn segment(s: &str) -> String {
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
pub(super) fn array(value: &Value, key: &str) -> Vec<Value> {
    value[key].as_array().cloned().unwrap_or_default()
}
fn short(sha: &str) -> &str {
    &sha[..12.min(sha.len())]
}

/// What one entry is: its repository, PR and released head.
struct Target {
    id: String,
    attempt: i64,
    repository: i64,
    repo: String,
    number: u64,
    head: String,
    base: String,
}
fn target(entry: &Value) -> Result<Target> {
    Ok(Target {
        id: entry["id"].as_str().context("The entry has no id")?.to_owned(),
        attempt: entry["attempt"].as_i64().unwrap_or(0),
        repository: entry["repositoryId"].as_i64().context("The entry has no repository id")?,
        repo: entry["repository"].as_str().context("The entry has no repository")?.to_owned(),
        number: entry["number"].as_u64().context("The entry has no PR number")?,
        head: entry["headSha"].as_str().context("The entry has no head")?.to_owned(),
        base: entry["baseBranch"].as_str().context("The entry has no base branch")?.to_owned(),
    })
}

/// The evidence read so far, and the decision: `Ok(())` means every gate
/// check held and the entry may merge now.
pub(super) async fn check(ws: &Arc<Workspace>, entry: &Value) -> Result<(Value, Check<()>)> {
    let t = target(entry)?;
    let (repo, number, head) = (t.repo.clone(), t.number, t.head.clone());
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
    hold!(checks::conflicting(&pr));
    let released = head.clone();
    let (latest, running, at_head) = ws.stored(move |s| s.merge_review(&link, &released)).await?;
    evidence["review"] = hold!(checks::review(entry, latest.as_ref(), running, &at_head));

    let by_ref = read(ws, format!("repos/{repo}/git/ref/heads/{}", t.base)).await?;
    let by_branch = read(ws, format!("repos/{repo}/branches/{}", segment(&t.base))).await?;
    let main = hold!(checks::main_agrees(
        by_ref["object"]["sha"].as_str().unwrap_or(""),
        by_branch["commit"]["sha"].as_str().unwrap_or("")
    ));
    let main_commit = read(ws, format!("repos/{repo}/git/commits/{main}")).await?;
    let mut since = entry["mainAtRelease"].as_str().unwrap_or(&main).to_owned();
    let mut anchored = entry["mainAnchoredAt"].as_str().or(entry["release"]["at"].as_str()).unwrap_or("").to_owned();
    let main_runs = read(ws, format!("repos/{repo}/actions/runs?branch={}&event=push&per_page=20", segment(&t.base))).await?;
    let main_runs = array(&main_runs, "workflow_runs");
    let repository = t.repository;
    let queue = ws.stored(move |s| s.merge_repository(repository)).await?;
    let paused = queue["paused"].clone();
    if let Some(cleared) = hold!(checks::pause(&paused, &t.base, &main, &main_runs)) {
        // The pause ended at this main: the store re-anchors the entry here, so
        // main health counts from here too, not from before the red run.
        (since, anchored) = (main.clone(), crate::model::now());
        evidence["pauseCleared"] = cleared;
    }
    evidence["main"] = json!({"atRelease":since,"anchoredAt":anchored,"before":main,"beforeTree":checks::tree_of(&main_commit)});
    let relaxed = checks::relaxed(&queue);
    evidence["policy"] = json!(if relaxed { checks::RELAXED } else { checks::STRICT });
    let accepted = checks::accepted_runs(&queue, &since);
    if relaxed {
        // The relaxed policy (YN-18 S2d): main CI not red now; a red main waits.
        let current = checks::accepted_runs(&queue, &main);
        evidence["main"]["ci"] = hold!(checks::main_not_red(&main_runs, &[accepted, current].concat()));
    } else {
        let (seen, red) = checks::main_runs_since(&main_runs, &since, &anchored, &accepted);
        evidence["main"]["ci"] = json!(seen);
        if let Some(red) = red {
            evidence["mainRed"] = red.clone();
            hold!(checks::main_health(&main_runs, &since, &anchored, &accepted));
        }
    }

    let required: Vec<String> = serde_json::from_value(entry["requireWorkflows"].clone()).unwrap_or_default();
    let (runs, total, more) =
        pages(ws, format!("repos/{repo}/actions/runs?head_sha={head}&event=pull_request&per_page=100&page=1"), "workflow_runs").await?;
    hold!(checks::complete("workflow runs on the head", runs.len(), total, more));
    let newest = hold!(checks::head_runs(&runs, &required));
    // GitHub's merge verdict from before the runs finished may be stale: read the PR again.
    let pr = read(ws, format!("repos/{repo}/pulls/{number}")).await?;
    hold!(checks::pull(entry, &pr));
    let pending = if matches!(pr["mergeable_state"].as_str(), Some("unstable" | "blocked")) {
        let check_runs = read(ws, format!("repos/{repo}/commits/{head}/check-runs?per_page=100")).await?;
        let status = read(ws, format!("repos/{repo}/commits/{head}/status")).await?;
        checks::pending(&check_runs, &status)
    } else {
        None
    };
    hold!(checks::mergeable(&pr, pending.as_deref()));

    if relaxed {
        return relaxed_gate(ws, &t, entry, &main, &newest, evidence).await;
    }

    // A batch built on this main is the gate; one on an older main is retired.
    let batch = &entry["batch"];
    if batch["main"] == main.as_str() && batch["pr"].is_u64() && batch["commit"].is_string() {
        let (gate, decision) = batch_gate(ws, &t, &main, batch, &required).await?;
        evidence["gate"] = gate;
        hold!(decision);
        evidence["wouldMerge"] = json!({"method":"merge","sha":head,"endpoint":format!("repos/{repo}/pulls/{number}/merge")});
        return Ok((evidence, Ok(())));
    }

    let merge = match read(ws, format!("repos/{repo}/git/ref/pull/{number}/merge")).await {
        Ok(r) => match r["object"]["sha"].as_str() {
            Some(sha) => Some(read(ws, format!("repos/{repo}/git/commits/{sha}")).await?),
            None => None,
        },
        Err(e) if e.to_string().starts_with("not_found") => None,
        Err(e) => return Err(e),
    };
    let tree = match checks::slot(merge.as_ref(), &main, &head) {
        checks::Slot::Fresh(tree) => tree,
        slot => {
            // Not the slot (YN-18 S2c, T-37 lab finding F1). The batch is Core's
            // own merge and needs nothing from GitHub's merge ref, so the entry
            // never waits for GitHub to move a ref on an older main, and waits
            // only briefly for one GitHub has not computed.
            let older = match &slot {
                checks::Slot::Stale(ref_main) => match older_main(ws, &repo, ref_main, &main).await {
                    Err(e) if e.to_string().starts_with("rate_limited") => return Err(e),
                    compared => compared,
                },
                _ => Ok(false),
            };
            // The grace runs from the first check that saw no slot for this
            // main, head and attempt.
            let now = chrono::Utc::now().timestamp();
            let seen = &entry["lastEvidence"]["mergeRef"];
            let since = if seen["main"] == main.as_str() && seen["head"] == head.as_str() && seen["attempt"] == t.attempt {
                seen["since"].as_i64().unwrap_or(now)
            } else {
                now
            };
            evidence["mergeRef"] = json!({"state":if matches!(slot, checks::Slot::Stale(_)) { "stale" } else { "missing" },
                "sha":merge.as_ref().map(|m| m["sha"].clone()),"parents":merge.as_ref().map(checks::parents),
                "main":main,"head":head,"attempt":t.attempt,"since":since,
                "olderMain":older.as_ref().ok(),"compareError":older.as_ref().err().map(|e| format!("{e:#}"))});
            match checks::batch_now(&slot, *older.as_ref().unwrap_or(&false), now - since, &main) {
                Ok(why) => return open_batch(ws, &t, entry, &main, evidence, why).await,
                Err(hold) => {
                    // Checked again when the grace ends, not after the backoff.
                    evidence["mergeRef"]["checkAgainAt"] = json!(since + checks::SLOT_GRACE);
                    return Ok((evidence, Err(hold)));
                }
            }
        }
    };
    let merge = merge.context("The PR's merge ref vanished")?;
    let ci = newest.iter().find(|r| r["name"] == checks::CI).context("The CI run vanished")?;
    let proofs = hold!(job_proofs(ws, &repo, ci).await?);
    let proved = match checks::checkouts(&proofs, &main, &head, &tree) {
        Ok(proved) => proved,
        Err(Hold::Stop("needs_batch", detail)) => return open_batch(ws, &t, entry, &main, evidence, detail).await,
        Err(other) => return Ok((evidence, Err(other))),
    };
    evidence["gate"] = json!({"kind":"slot","tree":tree,
        "mergeRef":{"sha":merge["sha"],"parents":checks::parents(&merge),"tree":tree},
        "runs":newest.iter().map(|r| json!({"workflow":r["name"],"run":r["id"],"attempt":r["run_attempt"],"conclusion":r["conclusion"],
            "jobs":if r["id"] == ci["id"] { json!(proved) } else { json!([]) }})).collect::<Vec<_>>()});
    evidence["wouldMerge"] = json!({"method":"merge","sha":head,"endpoint":format!("repos/{repo}/pulls/{number}/merge")});
    Ok((evidence, Ok(())))
}

/// The relaxed policy's gate (YN-18 S2d): the PR's own CI is green at the
/// head (checked before), on whatever main it tested, and Core's own merge of
/// the head into the current main is clean. That merge is the probe: Core's
/// branch at main with the head merged in and no PR, so no CI; its tree is the
/// tree the merge must land, which the post-check compares. A probe or batch
/// already on this main is reused; one on an older main is retired first.
async fn relaxed_gate(ws: &Arc<Workspace>, t: &Target, entry: &Value, main: &str, newest: &[Value], mut evidence: Value) -> Result<(Value, Check<()>)> {
    let (probe, made) = build_batch(ws, t, entry, main, false).await?;
    evidence["batch"] = probe.clone();
    if let Err(hold) = made {
        return Ok((evidence, Err(hold)));
    }
    let tree = probe["tree"].as_str().context("The probe has no tree")?;
    evidence["gate"] = json!({"kind":"relaxed","tree":tree,
        "probe":{"branch":probe["branch"],"commit":probe["commit"],"tree":tree,"main":main},
        "runs":newest.iter().map(|r| json!({"workflow":r["name"],"run":r["id"],"attempt":r["run_attempt"],"conclusion":r["conclusion"],"headSha":r["head_sha"]})).collect::<Vec<_>>()});
    evidence["wouldMerge"] = json!({"method":"merge","sha":t.head,"endpoint":format!("repos/{}/pulls/{}/merge", t.repo, t.number)});
    Ok((evidence, Ok(())))
}

/// Build the entry's batch on `main` and wait for CI on it (design §3,
/// batching). `why` says why CI on the PR itself does not count.
async fn open_batch(ws: &Arc<Workspace>, t: &Target, entry: &Value, main: &str, mut evidence: Value, why: String) -> Result<(Value, Check<()>)> {
    let (batch, made) = build_batch(ws, t, entry, main, true).await?;
    evidence["batch"] = batch.clone();
    if let Err(hold) = made {
        return Ok((evidence, Err(hold)));
    }
    let detail = format!(
        "{why}. Core opened batch #{} on {} (main {} + the head, tree {}); it waits for CI on it",
        batch["pr"],
        batch["branch"].as_str().unwrap_or("?"),
        short(main),
        short(batch["tree"].as_str().unwrap_or("?"))
    );
    Ok((evidence, Err(Hold::Wait(detail))))
}

/// Whether `older` is an ancestor of `main`, from GitHub's compare of the two
/// (their merge base is `older`). One read, holding a GitHub slot.
async fn older_main(ws: &Arc<Workspace>, repo: &str, older: &str, main: &str) -> Result<bool> {
    let cooldown = ws.stored(crate::ci_monitor::read_cooldown).await?;
    ensure!(cooldown <= chrono::Utc::now().timestamp(), "rate_limited: GitHub reads are cooling down until {cooldown}");
    let _slot = ws.github.slots.acquire().await?;
    let compared = ws.github.client.comparison_identity(repo, older, main).await?;
    Ok(compared["mergeBase"] == older)
}

/// Every job of a CI run attempt, each with its log's checkout line resolved
/// to a commit. Logs are downloaded without a GitHub slot.
async fn job_proofs(ws: &Arc<Workspace>, repo: &str, ci: &Value) -> Result<Check<Vec<Checkout>>> {
    let attempt = ci["run_attempt"].as_u64().unwrap_or(1);
    let (jobs, total, more) =
        pages(ws, format!("repos/{repo}/actions/runs/{}/attempts/{attempt}/jobs?per_page=100&page=1", ci["id"]), "jobs").await?;
    if let Err(hold) = checks::complete(&format!("jobs of CI run {}", ci["id"]), jobs.len(), total, more) {
        return Ok(Err(hold));
    }
    let mut proofs = Vec::new();
    for job in jobs {
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
    Ok(Ok(proofs))
}

/// CI on the entry's batch: the batch PR is still Core's own, open at the batch
/// commit, every workflow run on that commit is green, and every CI job
/// checked out the merge of main and the batch commit, whose tree is the
/// batch tree, the tree a merge of the head would land.
async fn batch_gate(ws: &Arc<Workspace>, t: &Target, main: &str, b: &Value, required: &[String]) -> Result<(Value, Check<()>)> {
    let (repo, branch) = (&t.repo, b["branch"].as_str().unwrap_or(""));
    let (commit, tree) = (b["commit"].as_str().unwrap_or(""), b["tree"].as_str().unwrap_or(""));
    let mut gate = json!({"kind":"batch","tree":tree,"batch":{"branch":branch,"commit":commit,"pr":b["pr"],"main":main}});
    let pull = read(ws, format!("repos/{repo}/pulls/{}", b["pr"])).await?;
    if pull["head"]["ref"] != branch || pull["state"] != "open" || pull["head"]["sha"] != commit {
        return Ok((gate, Err(Hold::Stop("batch_changed", format!(
            "Core's batch PR #{} is no longer open at its batch commit {} on {branch}", b["pr"], short(commit))))));
    }
    let (runs, total, more) =
        pages(ws, format!("repos/{repo}/actions/runs?head_sha={commit}&event=pull_request&per_page=100&page=1"), "workflow_runs").await?;
    if let Err(hold) = checks::complete("workflow runs on the batch", runs.len(), total, more) {
        return Ok((gate, Err(hold)));
    }
    let newest = match checks::head_runs(&runs, required) {
        Ok(newest) => newest,
        Err(hold) => return Ok((gate, Err(hold))),
    };
    let ci = newest.iter().find(|r| r["name"] == checks::CI).context("The batch's CI run vanished")?;
    let proofs = match job_proofs(ws, repo, ci).await? {
        Ok(proofs) => proofs,
        Err(hold) => return Ok((gate, Err(hold))),
    };
    let proved = match checks::checkouts(&proofs, main, commit, tree) {
        Ok(proved) => proved,
        Err(hold) => return Ok((gate, Err(hold))),
    };
    gate["runs"] = json!(newest.iter().map(|r| json!({"workflow":r["name"],"run":r["id"],"attempt":r["run_attempt"],"conclusion":r["conclusion"],
        "jobs":if r["id"] == ci["id"] { json!(proved) } else { json!([]) }})).collect::<Vec<_>>());
    Ok((gate, Ok(())))
}

/// Build the entry's batch on `main` (design §3, batching), resuming whatever
/// an earlier, interrupted check of it already wrote. Each step is recorded on
/// the entry before the next write, so nothing Core made is ever forgotten.
/// Without `pull` it stops before the draft PR: the relaxed policy's probe,
/// Core's own merge of the head into main that runs no CI (YN-18 S2d). A probe
/// becomes a batch if the policy turns strict on the same main.
async fn build_batch(ws: &Arc<Workspace>, t: &Target, entry: &Value, main: &str, pull: bool) -> Result<(Value, Check<()>)> {
    let old = &entry["batch"];
    if old.is_object() && old["main"] != main {
        let retired = cleanup(ws, entry).await?;
        let (id, attempt) = (t.id.clone(), t.attempt);
        ws.stored(move |s| s.merge_batch_retired(&id, attempt, retired)).await?;
    }
    let branch = writes::branch(&t.id);
    let mut b = if old["main"] == main { old.clone() } else {
        json!({"kind":"probe","branch":branch,"main":main,"createdAt":crate::model::now(),"ref":false,"commit":null,"tree":null,"pr":null,"closed":false,"deleted":false})
    };
    let save = |b: Value| {
        let (id, attempt) = (t.id.clone(), t.attempt);
        async move {
            ensure!(ws.stored(move |s| s.merge_batch(&id, attempt, b)).await?, "merge_moved_on: the entry was cancelled or retried meanwhile");
            Ok::<_, anyhow::Error>(())
        }
    };
    save(b.clone()).await?;
    let (repo, repository) = (t.repo.as_str(), t.repository);
    if b["ref"] != true {
        // Recorded before the request: if its answer is lost, the branch may
        // exist, and the cleanup removes it.
        b["ref"] = json!("pending");
        save(b.clone()).await?;
        let (code, answer) = writes::write(ws, repository, repo, Write::CreateBranch { branch: &branch, main }).await?;
        match code {
            201 => {}
            422 => {
                let at = read(ws, format!("repos/{repo}/git/ref/heads/{branch}")).await?;
                ensure!(at["object"]["sha"].is_string(), "GitHub refused to create {branch}: {}", answer["message"]);
            }
            _ => bail!("GitHub answered {code} creating {branch}: {}", answer["message"]),
        }
        b["ref"] = json!(true);
        save(b.clone()).await?;
    }
    if !b["commit"].is_string() {
        let at = read(ws, format!("repos/{repo}/git/ref/heads/{branch}")).await?["object"]["sha"].as_str().unwrap_or("").to_owned();
        let commit = if at != main {
            // An interrupted earlier check already merged the head here.
            read(ws, format!("repos/{repo}/git/commits/{at}")).await?
        } else {
            let message = if pull {
                format!("{branch}: main {} + #{} at {} (CI only, do not merge)", short(main), t.number, short(&t.head))
            } else {
                format!("{branch}: main {} + #{} at {} (merge check only, no PR; do not merge)", short(main), t.number, short(&t.head))
            };
            let (code, answer) = writes::write(ws, repository, repo, Write::MergeIntoBranch { branch: &branch, head: &t.head, message }).await?;
            match code {
                201 => answer,
                409 => {
                    b["cleanup"] = json!("pending");
                    save(b.clone()).await?;
                    return Ok((b, Err(Hold::Stop("conflict", format!(
                        "GitHub could not merge the head into main {}: {}", short(main), answer["message"].as_str().unwrap_or("merge conflict"))))));
                }
                204 => {
                    b["cleanup"] = json!("pending");
                    save(b.clone()).await?;
                    return Ok((b, Err(Hold::Stop("nothing_to_merge", format!("Main {} already contains the head", short(main))))));
                }
                _ => bail!("GitHub answered {code} merging the head into {branch}: {}", answer["message"]),
            }
        };
        if checks::parents(&commit) != [main, t.head.as_str()] {
            b["cleanup"] = json!("pending");
            save(b.clone()).await?;
            return Ok((b, Err(Hold::Stop("batch_changed", format!(
                "{branch} holds {}, which is not the merge of main {} and the head", commit["sha"], short(main))))));
        }
        b["commit"] = commit["sha"].clone();
        b["tree"] = json!(checks::tree_of(&commit));
        save(b.clone()).await?;
    }
    if !pull {
        return Ok((b, Ok(())));
    }
    if !b["pr"].is_u64() {
        let title = format!("queue: #{} at {} on main {} (CI only, do not merge)", t.number, short(&t.head), short(main));
        let body = format!(
            "**CI only. Do not merge or review this PR.** Yuzuno Core's merge queue opened it to run CI on main {main} with #{} at {} merged in. Core closes it and deletes `{branch}` once #{} is merged or the entry ends.",
            t.number, t.head, t.number
        );
        let (code, answer) = writes::write(ws, repository, repo, Write::OpenBatchPull { branch: &branch, base: &t.base, title, body }).await?;
        let number = match code {
            201 => answer["number"].as_u64(),
            422 => {
                let owner = repo.split('/').next().unwrap_or("");
                let open = read(ws, format!("repos/{repo}/pulls?head={owner}:{}&state=open&per_page=5", segment(&branch))).await?;
                open.as_array().and_then(|l| l.first()).and_then(|p| p["number"].as_u64())
            }
            _ => None,
        };
        b["pr"] = json!(number.with_context(|| format!("GitHub answered {code} opening the batch PR: {}", answer["message"]))?);
        b["kind"] = json!("batch");
        save(b.clone()).await?;
    }
    Ok((b, Ok(())))
}

/// What the merge request came to (design §3, merging).
#[derive(Debug)]
pub(super) enum MergeOutcome {
    Merged(String),
    Refused(String),
    /// The one request got no certain answer: it may have merged.
    Unknown(String),
    /// Main moved, or the landing policy changed, since the check, so nothing
    /// was sent: check again.
    Moved(String),
    /// Nothing was sent (the switch is off): check again later.
    Held(String),
    /// Nothing was sent: the repository's queue was paused meanwhile.
    Paused(String),
    /// GitHub's rate limit refused the request: nothing merged, send it again
    /// after the cooldown.
    Limited(String),
    /// The request never reached GitHub (gh could not start, no login, no
    /// connection): nothing merged, try again shortly.
    NotSent(String),
}

/// Send the merge, once. Right before it, Core reads the PR and main again:
/// the request pins the head but not the base, so a main that moved since the
/// check would get a merge CI never tested. Open at the head on the expected
/// main allows the request. A certain answer is the outcome. An uncertain one
/// is never sent again or reconciled: the entry stops with merge_unknown and
/// the repository's queue pauses until a person has looked.
pub(super) async fn merge(ws: &Arc<Workspace>, entry: &Value) -> Result<MergeOutcome> {
    let t = target(entry)?;
    let expected = entry["merge"]["expectedMain"].as_str().context("The merge has no expected main")?.to_owned();
    if entry["merge"]["attempts"].as_i64().unwrap_or(0) > 0 {
        // Journaled before an earlier run of Core stopped, with no answer
        // recorded: it may have been sent.
        return Ok(MergeOutcome::Unknown("A merge request was journaled and may have been sent, but no answer to it was recorded".into()));
    }
    if let Some(found) = reconcile(ws, &t, &expected).await? {
        return Ok(found);
    }
    let (id, attempt) = (t.id.clone(), t.attempt);
    match ws.stored(move |s| s.merge_put_journal(&id, attempt)).await? {
        super::store::Journal::Journaled => {}
        super::store::Journal::NotMerging => bail!("merge_moved_on: the entry is no longer merging"),
        super::store::Journal::Paused(detail) => return Ok(MergeOutcome::Paused(detail)),
        super::store::Journal::PolicyChanged(detail) => return Ok(MergeOutcome::Moved(detail)),
    }
    match writes::write(ws, t.repository, &t.repo, Write::Merge { number: t.number, head: &t.head }).await {
        Ok((code, body)) => {
            if let Err(e) = limited(code, &body) {
                return Ok(MergeOutcome::Limited(e.to_string()));
            }
            Ok(match checks::merge_answer(code, &body) {
                Answer::Merged(sha) => MergeOutcome::Merged(sha),
                Answer::Refused(detail) => MergeOutcome::Refused(detail),
            })
        }
        Err(e) if e.to_string().starts_with("merge_queue_disabled") => Ok(MergeOutcome::Held(e.to_string())),
        Err(e) if e.to_string().starts_with("not_sent") => Ok(MergeOutcome::NotSent(format!("{e:#}"))),
        Err(e) => Ok(MergeOutcome::Unknown(format!("The merge request got no certain answer: {e:#}"))),
    }
}

/// The PR and main as GitHub has them now, before the merge request: None
/// means the PR is open at the head on the expected main, so the request may
/// go. Nothing was sent yet, so a merged PR is someone else's merge.
async fn reconcile(ws: &Arc<Workspace>, t: &Target, expected: &str) -> Result<Option<MergeOutcome>> {
    let pr = read(ws, format!("repos/{}/pulls/{}", t.repo, t.number)).await?;
    if pr["merged"] == true {
        return Ok(Some(MergeOutcome::Refused(format!(
            "The PR was merged outside the queue, as {}",
            pr["merge_commit_sha"].as_str().unwrap_or("?")
        ))));
    }
    if pr["state"] != "open" {
        return Ok(Some(MergeOutcome::Refused("The PR was closed without a merge".into())));
    }
    if pr["head"]["sha"] != t.head.as_str() {
        return Ok(Some(MergeOutcome::Refused(format!("The PR head moved to {}", pr["head"]["sha"]))));
    }
    let main = read(ws, format!("repos/{}/git/ref/heads/{}", t.repo, t.base)).await?["object"]["sha"].as_str().unwrap_or("").to_owned();
    if main != expected {
        return Ok(Some(MergeOutcome::Moved(format!("Main moved to {} since the check, so no merge was sent; every check runs again", short(&main)))));
    }
    Ok(None)
}

/// After a merge: the post-check (once), the batch cleanup, and main's push CI
/// on the merge commit.
pub(super) struct Followed {
    pub post: Option<Check<()>>,
    pub merge_commit: Value,
    pub cleanup: Option<Value>,
    pub main_ci: Option<Value>,
}
pub(super) async fn follow(ws: &Arc<Workspace>, entry: &Value) -> Result<Followed> {
    let t = target(entry)?;
    let m = &entry["merge"];
    let sha = m["sha"].as_str().context("The merge has no commit")?;
    let mut followed = Followed { post: None, merge_commit: Value::Null, cleanup: None, main_ci: None };
    if m["post"].is_null() {
        let commit = read(ws, format!("repos/{}/git/commits/{sha}", t.repo)).await?;
        followed.post = Some(checks::post_check(
            &commit,
            m["expectedMain"].as_str().unwrap_or(""),
            &t.head,
            m["tree"].as_str().unwrap_or(""),
        ));
        followed.merge_commit = json!({"sha":commit["sha"],"parents":checks::parents(&commit),"tree":checks::tree_of(&commit)});
    }
    if entry["batch"].is_object() && entry["batch"]["cleanup"] != "done" {
        // A failed removal is recorded and retried later; it never holds up
        // the post-check or the main CI read.
        followed.cleanup = Some(cleanup(ws, entry).await.unwrap_or_else(|e| json!({"error":format!("{e:#}"),"at":crate::model::now()})));
    }
    let runs = read(ws, format!("repos/{}/actions/runs?branch={}&event=push&head_sha={sha}&per_page=20", t.repo, segment(&t.base))).await?;
    followed.main_ci = array(&runs, "workflow_runs").into_iter().find(|r| r["name"] == checks::CI && r["head_sha"] == sha);
    Ok(followed)
}

/// Close Core's own batch PR and delete Core's own batch branch, whichever of
/// them it made and has not yet removed. The PR is closed only if its head is
/// still the entry's own branch.
pub(super) async fn cleanup(ws: &Arc<Workspace>, entry: &Value) -> Result<Value> {
    // Only who owns the batch: a revert stopped before its PR has no head yet.
    struct Owner {
        id: String,
        repository: i64,
        repo: String,
    }
    let t = Owner {
        id: entry["id"].as_str().context("The entry has no id")?.to_owned(),
        repository: entry["repositoryId"].as_i64().context("The entry has no repository id")?,
        repo: entry["repository"].as_str().context("The entry has no repository")?.to_owned(),
    };
    let b = &entry["batch"];
    let branch = b["branch"].as_str().context("The batch has no branch")?;
    ensure!(
        branch == writes::branch(&t.id) || branch == writes::revert_branch(&t.id),
        "merge_write_refused: the batch branch is not this entry's own"
    );
    // A branch whose creation may have happened ("pending") is deleted too;
    // GitHub's 404 or 422 then says it never existed.
    let made = b["ref"] == true || b["ref"] == "pending";
    let (mut closed, mut deleted) = (b["closed"] == true || !b["pr"].is_u64(), b["deleted"] == true || !made);
    if !closed {
        let pull = read(ws, format!("repos/{}/pulls/{}", t.repo, b["pr"])).await?;
        ensure!(pull["head"]["ref"] == branch, "merge_write_refused: PR #{} is not Core's batch PR for {branch}", b["pr"]);
        if pull["state"] == "open" {
            let number = b["pr"].as_u64().unwrap_or(0);
            let (code, answer) = writes::write(ws, t.repository, &t.repo, Write::CloseBatchPull { number }).await?;
            limited(code, &answer)?;
            ensure!(code == 200, "GitHub answered {code} closing batch PR #{number}: {}", answer["message"]);
        }
        closed = true;
    }
    if !deleted {
        let (code, answer) = writes::write(ws, t.repository, &t.repo, Write::DeleteBranch { branch }).await?;
        limited(code, &answer)?;
        ensure!(matches!(code, 204 | 404 | 422), "GitHub answered {code} deleting {branch}: {}", answer["message"]);
        deleted = true;
    }
    Ok(json!({"closed":closed,"deleted":deleted,"at":crate::model::now()}))
}

/// A write GitHub's rate limit refused is a wait for later, not a failure.
fn limited(code: u16, answer: &Value) -> Result<()> {
    let message = answer["message"].as_str().unwrap_or("");
    ensure!(
        code != 429 && !(code == 403 && message.to_lowercase().contains("rate limit")),
        "rate_limited: GitHub answered {code}: {message}"
    );
    Ok(())
}

/// At release: the PR's base branch and head, and the main of that moment.
pub(super) async fn release_reads(ws: &Arc<Workspace>, repo: &str, number: u64) -> Result<(Value, String)> {
    let pr = read(ws, format!("repos/{repo}/pulls/{number}")).await?;
    let base = pr["base"]["ref"].as_str().context("The PR has no base branch")?.to_owned();
    // The queue merges into the default branch only: one pause and one main
    // per repository. Refused before anything of another branch is read.
    let default = pr["base"]["repo"]["default_branch"].as_str().unwrap_or("");
    ensure!(
        !default.is_empty() && base == default,
        "merge_not_default_branch: the merge queue merges only into the repository's default branch ({}); this PR's base is {base}",
        if default.is_empty() { "not known" } else { default }
    );
    let main = base_commit(ws, repo, &base).await?;
    Ok((pr, main))
}

/// At a retry or an unpause: the main the entries are anchored to from then on.
pub(super) async fn main_now(ws: &Arc<Workspace>, repo: &str, base: &str) -> Result<String> {
    base_commit(ws, repo, base).await
}

async fn base_commit(ws: &Arc<Workspace>, repo: &str, base: &str) -> Result<String> {
    Ok(read(ws, format!("repos/{repo}/git/ref/heads/{base}")).await?["object"]["sha"]
        .as_str()
        .context("The base branch has no commit")?
        .to_owned())
}
