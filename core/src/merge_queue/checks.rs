//! Each gate decision over one fresh read, as plain functions. Nothing here
//! reads GitHub or the database; `remote` reads, these decide, `store` records.
use serde_json::{Value, json};

/// The workflow every gate needs, in the PR's own runs and on main.
pub(super) const CI: &str = "CI";
/// At most this many bytes of one job log are read (design §4.1).
pub(super) const LOG_LIMIT: usize = 4 * 1024 * 1024;

/// Why an entry cannot move on now.
#[derive(Debug, PartialEq)]
pub(super) enum Hold {
    /// Not yet decidable: GitHub is still working, or a run is still going.
    Wait(String),
    /// Decided against: a reason code and what was seen.
    Stop(&'static str, String),
}
pub(super) type Check<T> = Result<T, Hold>;

fn stop<T>(reason: &'static str, detail: impl Into<String>) -> Check<T> {
    Err(Hold::Stop(reason, detail.into()))
}
fn wait<T>(detail: impl Into<String>) -> Check<T> {
    Err(Hold::Wait(detail.into()))
}
fn short(sha: &Value) -> String {
    sha.as_str().unwrap_or("?").chars().take(12).collect()
}

/// The PR is still the candidate that was released: open, ready, unmerged, at
/// the released head and on the released base branch.
pub(super) fn pull(entry: &Value, pr: &Value) -> Check<()> {
    if pr["merged"] == true || !pr["merged_at"].is_null() {
        return stop("pr_not_open", "The PR is already merged");
    }
    if pr["state"] != "open" {
        return stop("pr_not_open", format!("The PR is {}", pr["state"].as_str().unwrap_or("not open")));
    }
    if pr["draft"] == true {
        return stop("pr_not_open", "The PR is a draft");
    }
    if pr["head"]["sha"] != entry["headSha"] {
        return stop(
            "head_moved",
            format!("The PR head is now {}, not the released head {}", short(&pr["head"]["sha"]), short(&entry["headSha"])),
        );
    }
    if pr["base"]["ref"] != entry["baseBranch"] {
        return stop(
            "base_changed",
            format!("The PR now targets {}, not {}", pr["base"]["ref"].as_str().unwrap_or("?"), entry["baseBranch"].as_str().unwrap_or("?")),
        );
    }
    Ok(())
}

/// Releasing is the lead's statement that the review pair is complete; Core
/// checks that the last completed round of this PR reviewed exactly this head
/// and passes under the project's review policy.
pub(super) fn review(entry: &Value, latest: Option<&Value>, running: bool) -> Check<Value> {
    if running {
        return wait("A review round of this PR is still running; the last completed round decides");
    }
    let Some(r) = latest else {
        return stop("review_not_passing", "This PR has no completed review round");
    };
    if r["headSha"] != entry["headSha"] {
        return stop(
            "review_not_passing",
            format!("The last completed review round ({}) reviewed {}, not the released head {}",
                r["id"].as_str().unwrap_or("?"), short(&r["headSha"]), short(&entry["headSha"])),
        );
    }
    if !crate::pr_review::policy::passes(r) {
        return stop(
            "review_not_passing",
            format!("The last completed review round ({}) at this head concluded {}, which does not pass under the review policy",
                r["id"].as_str().unwrap_or("?"), r["conclusion"].as_str().unwrap_or("unknown")),
        );
    }
    Ok(json!({"id":r["id"],"round":r["round"],"conclusion":r["conclusion"],"headSha":r["headSha"],
        "coverage":format!("{}/{}", r["coverage"]["coveredFileCount"], r["coverage"]["fileCount"]),"passes":true}))
}

/// Two reads of the base branch (its ref and the branch API) name one commit.
pub(super) fn main_agrees(by_ref: &str, by_branch: &str) -> Check<String> {
    if by_ref.len() != 40 || by_ref != by_branch {
        return wait(format!("The base branch moved between reads ({} and {})", by_ref.get(..12).unwrap_or(by_ref), by_branch.get(..12).unwrap_or(by_branch)));
    }
    Ok(by_ref.to_owned())
}

/// Main is healthy (user option 1, 2026-10-24): no push run of CI on the base
/// branch since the entry's anchor concluded failure, timed_out or
/// startup_failure. The anchor is the main read at release, or at the last
/// retry, and the time of that read. The anchor commit's own runs count; a run
/// of an older commit created before the anchor does not, nor does a run an
/// unpause accepted. Running, queued, superseded (cancelled) and green runs
/// are fine. `runs` are newest first.
pub(super) fn main_health(runs: &[Value], since: &str, anchored_at: &str, accepted: &[Value]) -> Check<Value> {
    match main_runs_since(runs, since, anchored_at, accepted) {
        (_, Some(run)) => stop(
            "main_red",
            format!("Main CI run {} on {} concluded {}", run["id"], short(&run["head_sha"]), run["conclusion"].as_str().unwrap_or("?")),
        ),
        (seen, None) => Ok(json!(seen)),
    }
}

/// The main CI runs `main_health` counts, newest first, and the first red one.
/// A run an unpause accepted (`accepted`, by id) is listed but never counts.
pub(super) fn main_runs_since(runs: &[Value], since: &str, anchored_at: &str, accepted: &[Value]) -> (Vec<Value>, Option<Value>) {
    // GitHub's run times have whole seconds: a run of the anchor's own second counts.
    let anchor = chrono::DateTime::parse_from_rfc3339(anchored_at).ok().map(|t| t.timestamp());
    let mut seen = Vec::new();
    for run in runs.iter().filter(|r| r["name"] == CI) {
        let at_anchor = run["head_sha"] == since;
        let created = run["created_at"].as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|t| t.timestamp());
        if !at_anchor && matches!((created, anchor), (Some(c), Some(a)) if c < a) {
            continue;
        }
        let conclusion = run["conclusion"].as_str().unwrap_or("");
        if accepted.contains(&run["id"]) {
            seen.push(json!({"run":run["id"],"headSha":run["head_sha"],"createdAt":run["created_at"],"status":run["status"],"conclusion":run["conclusion"],"accepted":true}));
            if at_anchor {
                break;
            }
            continue;
        }
        seen.push(json!({"run":run["id"],"headSha":run["head_sha"],"createdAt":run["created_at"],"status":run["status"],"conclusion":run["conclusion"]}));
        if matches!(conclusion, "failure" | "timed_out" | "startup_failure") {
            return (seen, Some(json!({"id":run["id"],"headSha":run["head_sha"],"conclusion":conclusion})));
        }
        if at_anchor {
            break;
        }
    }
    (seen, None)
}

/// The newest run of each workflow on the head. Every one has finished green
/// (success, skipped or neutral), and CI plus each required workflow ran.
pub(super) fn head_runs(runs: &[Value], required: &[String]) -> Check<Vec<Value>> {
    let mut newest: Vec<&Value> = Vec::new();
    for run in runs {
        match newest.iter_mut().find(|r| r["name"] == run["name"]) {
            Some(r) if r["id"].as_u64() < run["id"].as_u64() => *r = run,
            Some(_) => {}
            None => newest.push(run),
        }
    }
    newest.sort_by_key(|r| r["id"].as_u64());
    for run in &newest {
        if run["status"] != "completed" {
            return wait(format!("{} run {} on the head is {}", run["name"].as_str().unwrap_or("?"), run["id"], run["status"].as_str().unwrap_or("?")));
        }
    }
    for run in &newest {
        let conclusion = run["conclusion"].as_str().unwrap_or("none");
        if !matches!(conclusion, "success" | "skipped" | "neutral") {
            return stop(
                "ci_red",
                format!("{} run {} attempt {} on the head concluded {conclusion}", run["name"].as_str().unwrap_or("?"), run["id"], run["run_attempt"]),
            );
        }
    }
    for name in std::iter::once(CI).chain(required.iter().map(String::as_str)) {
        if !newest.iter().any(|r| r["name"] == name) {
            return wait(format!("No run of workflow {name} on the head yet"));
        }
    }
    Ok(newest.into_iter().cloned().collect())
}

/// GitHub's own merge verdict, judged on a read of the PR taken after the
/// head's runs finished. `pending` names a check run or commit status on the
/// head that has not finished: while one does, `unstable` and `blocked` may
/// still clear, so they wait instead of stopping.
pub(super) fn mergeable(pr: &Value, pending: Option<&str>) -> Check<()> {
    match pr["mergeable"].as_bool() {
        None => wait("GitHub is still computing whether the PR can merge"),
        Some(false) => stop("conflict", "GitHub reports that the PR cannot merge into its base"),
        Some(true) => match pr["mergeable_state"].as_str() {
            Some("clean" | "has_hooks") => Ok(()),
            Some("unknown") | None => wait("GitHub is still computing the PR's merge state"),
            Some("dirty") => stop("conflict", "GitHub reports the PR's merge state as dirty"),
            Some(state @ ("unstable" | "blocked")) if pending.is_some() => wait(format!(
                "GitHub reports the PR as {state} while {} on the head has not finished",
                pending.unwrap_or("a check")
            )),
            Some("unstable") => stop("ci_red", "GitHub reports the PR as unstable: a check on its head is not passing"),
            Some(other) => stop("merge_blocked", format!("GitHub reports the PR's merge state as {other}")),
        },
    }
}

/// The first check run or commit status on the head that has not finished, by
/// name, from `commits/{head}/check-runs` and `commits/{head}/status`.
pub(super) fn pending(check_runs: &Value, status: &Value) -> Option<String> {
    let runs = check_runs["check_runs"].as_array().into_iter().flatten();
    let statuses = status["statuses"].as_array().into_iter().flatten();
    runs.filter(|r| r["status"] != "completed")
        .map(|r| format!("check run {}", r["name"].as_str().unwrap_or("?")))
        .chain(statuses.filter(|s| s["state"] == "pending").map(|s| format!("status {}", s["context"].as_str().unwrap_or("?"))))
        .next()
}

/// The PR's merge ref is the merge of the current main and the head; its tree
/// is the tree a merge would land.
pub(super) fn slot(merge: Option<&Value>, main: &str, head: &str) -> Check<String> {
    let Some(merge) = merge else {
        return wait("GitHub has not computed the PR's merge ref yet");
    };
    if parents(merge) != [main, head] {
        return wait(format!(
            "The PR's merge ref {} is not yet the merge of the current main {} and the head",
            short(&merge["sha"]),
            &main[..12]
        ));
    }
    tree_of(merge).map(str::to_owned).ok_or(Hold::Wait("The PR's merge ref has no readable tree".into()))
}

pub(super) fn parents(commit: &Value) -> Vec<&str> {
    commit["parents"]
        .as_array()
        .map(|p| p.iter().filter_map(|c| c["sha"].as_str()).collect())
        .unwrap_or_default()
}
/// A commit's tree as `git/commits` (`tree.sha`) or `commits` (`commit.tree.sha`) reports it.
pub(super) fn tree_of(commit: &Value) -> Option<&str> {
    commit["tree"]["sha"].as_str().or(commit["commit"]["tree"]["sha"].as_str())
}

/// The checkout line a job log carries: `HEAD is now at <merge> Merge <head> into <base>`.
pub(super) fn checkout_line(log: &[u8]) -> Option<(String, String, String)> {
    let text = String::from_utf8_lossy(log);
    for line in text.lines() {
        let Some((_, rest)) = line.split_once("HEAD is now at ") else { continue };
        let words: Vec<&str> = rest.split_whitespace().collect();
        if let [merge, "Merge", head, "into", base, ..] = words[..] {
            let hex = |s: &str| s.len() >= 7 && s.bytes().all(|b| b.is_ascii_hexdigit());
            if hex(merge) && head.len() == 40 && base.len() == 40 && hex(head) && hex(base) {
                return Some((merge.into(), head.into(), base.into()));
            }
        }
    }
    None
}

/// One CI job as read: its log's checkout line resolved to a commit.
pub(super) struct Checkout {
    pub job: Value,
    pub line: Option<(String, String, String)>,
    pub commit: Option<Value>,
    pub sha256: String,
    pub bytes: usize,
    pub truncated: bool,
}

/// Every CI job that ran checked out exactly the merge of the current main
/// and the head, with the tree the merge would land (design §4.1). A job that
/// tested an older main means CI has to run again on the current one.
pub(super) fn checkouts(jobs: &[Checkout], main: &str, head: &str, tree: &str) -> Check<Vec<Value>> {
    let mut proved = Vec::new();
    for c in jobs.iter().filter(|c| c.job["conclusion"] != "skipped") {
        let name = c.job["name"].as_str().unwrap_or("?");
        let Some(commit) = c.commit.as_ref().filter(|_| c.line.is_some()) else {
            return stop(
                "checkout_unproven",
                format!("Job {} ({name}) shows no checkout of a merge commit in {} bytes of its log{}",
                    c.job["id"], c.bytes, if c.truncated { " (read stopped at the 4 MiB limit)" } else { "" }),
            );
        };
        let p = parents(commit);
        if p.get(1) == Some(&head) && p.first() != Some(&main) {
            return stop(
                "needs_batch",
                format!("Job {} ({name}) tested the head merged into main {}, not the current main {}; CI must run on the current main",
                    c.job["id"], p.first().map(|s| &s[..12.min(s.len())]).unwrap_or("?"), &main[..12]),
            );
        }
        if p != [main, head] || tree_of(commit) != Some(tree) {
            return stop(
                "checkout_mismatch",
                format!("Job {} ({name}) checked out {}, which is not the merge of the current main and the head with tree {}",
                    c.job["id"], short(&commit["sha"]), &tree[..12]),
            );
        }
        proved.push(json!({"id":c.job["id"],"name":name,"conclusion":c.job["conclusion"],"checkout":commit["sha"],
            "checkoutTree":tree,"logSha256":c.sha256,"logBytes":c.bytes,"truncated":c.truncated}));
    }
    if proved.is_empty() {
        return stop("checkout_unproven", "No CI job on the head ran, so nothing shows what was tested");
    }
    Ok(proved)
}

/// The repository's pause (design §5). While it holds, entries wait and none
/// merges. A `main_red` pause clears itself once main has moved past the red
/// commit and CI on the new main finished green: `Ok(Some(..))` says so, with
/// what cleared it, and the store re-anchors every waiting entry there.
pub(super) fn pause(paused: &Value, main: &str, runs: &[Value]) -> Check<Option<Value>> {
    if paused.is_null() {
        return Ok(None);
    }
    let reason = paused["reason"].as_str().unwrap_or("paused");
    if reason == "main_red" && paused["main"] != main {
        let green = runs.iter().find(|r| r["name"] == CI && r["head_sha"] == main);
        if let Some(run) = green.filter(|r| r["status"] == "completed" && r["conclusion"] == "success") {
            return Ok(Some(json!({"by":"a newer green main","main":main,"run":run["id"]})));
        }
    }
    wait(format!(
        "The repository's merge queue is paused ({reason}) since {}: {}. It waits until a lead or the user unpauses it{}",
        paused["at"].as_str().unwrap_or("?"),
        paused["detail"].as_str().unwrap_or(""),
        if reason == "main_red" { ", or CI on a newer main is green" } else { "" }
    ))
}

/// Every item of a paged list was read: GitHub's `total_count` is no more
/// than the items Core holds. Otherwise what was not read proves nothing.
pub(super) fn complete(what: &str, read: usize, total: Option<u64>, more: bool) -> Check<()> {
    if more || total.is_some_and(|t| t as usize > read) {
        return stop(
            "checkout_unproven",
            format!("Core read {read} of {} {what}; the rest prove nothing, so the entry cannot merge", total.map_or("more".into(), |t| t.to_string())),
        );
    }
    Ok(())
}

/// GitHub's answer to the merge PUT (design §3, ready → merging).
#[derive(Debug, PartialEq)]
pub(super) enum Answer {
    Merged(String),
    Refused(String),
}
pub(super) fn merge_answer(code: u16, body: &Value) -> Answer {
    match (code, body["merged"].as_bool(), body["sha"].as_str()) {
        (200, Some(true), Some(sha)) if sha.len() == 40 => Answer::Merged(sha.to_owned()),
        _ => Answer::Refused(format!("GitHub answered {code}: {}", body["message"].as_str().unwrap_or("no message"))),
    }
}

/// After a merge: main's new commit is (main before, head) with the tree CI
/// tested. Anything else landed something CI did not test.
pub(super) fn post_check(commit: &Value, main: &str, head: &str, tree: &str) -> Check<()> {
    if parents(commit) != [main, head] {
        return stop(
            "post_check_failed",
            format!("The merge commit {} has parents {:?}, not main {} and the head", short(&commit["sha"]), parents(commit), &main[..12.min(main.len())]),
        );
    }
    if tree_of(commit) != Some(tree) {
        return stop(
            "post_check_failed",
            format!("The merge commit {} has tree {}, not the tested tree {}", short(&commit["sha"]), tree_of(commit).unwrap_or("?"), &tree[..12.min(tree.len())]),
        );
    }
    Ok(())
}
