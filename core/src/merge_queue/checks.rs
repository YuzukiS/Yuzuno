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
        return wait(format!("The base branch moved between reads ({} and {})", &by_ref.get(..12).unwrap_or(by_ref), &by_branch.get(..12).unwrap_or(by_branch)));
    }
    Ok(by_ref.to_owned())
}

/// Main is healthy (user option 1, 2026-10-24): no push run of CI on the base
/// branch since the main seen at release concluded failure, timed_out or
/// startup_failure. Running, queued, superseded (cancelled) and green runs are
/// fine. `runs` are newest first.
pub(super) fn main_health(runs: &[Value], since: &str) -> Check<Value> {
    let mut seen = Vec::new();
    for run in runs.iter().filter(|r| r["name"] == CI) {
        let conclusion = run["conclusion"].as_str().unwrap_or("");
        seen.push(json!({"run":run["id"],"headSha":run["head_sha"],"status":run["status"],"conclusion":run["conclusion"]}));
        if matches!(conclusion, "failure" | "timed_out" | "startup_failure") {
            return stop(
                "main_red",
                format!("Main CI run {} on {} concluded {conclusion}", run["id"], short(&run["head_sha"])),
            );
        }
        if run["head_sha"] == since {
            break;
        }
    }
    Ok(json!(seen))
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

/// GitHub's own merge verdict for the PR, read after the runs finished.
pub(super) fn mergeable(pr: &Value) -> Check<()> {
    match pr["mergeable"].as_bool() {
        None => wait("GitHub is still computing whether the PR can merge"),
        Some(false) => stop("conflict", "GitHub reports that the PR cannot merge into its base"),
        Some(true) => match pr["mergeable_state"].as_str() {
            Some("clean" | "has_hooks") => Ok(()),
            Some("unknown") | None => wait("GitHub is still computing the PR's merge state"),
            Some("dirty") => stop("conflict", "GitHub reports the PR's merge state as dirty"),
            Some("unstable") => stop("ci_red", "GitHub reports the PR as unstable: a check on its head is not passing"),
            Some(other) => stop("merge_blocked", format!("GitHub reports the PR's merge state as {other}")),
        },
    }
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
