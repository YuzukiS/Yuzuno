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
/// and passes under the project's review policy, and that no completed round
/// at that head found a P0–P2 issue (YN-12 item 1, YN-18 S2d): such a finding
/// is fixed only by a new head, never by another round of the same head.
/// `at_reviewed` is every completed round of the PR at the head the last round
/// reviewed.
///
/// The last round may have reviewed an earlier head when the entry holds the
/// proof (`reviewMerges`, YN-33) that the released head is that head plus
/// merges that need no review of their own; `merged` is then every completed
/// round, on any PR of the repository, at each merged-in head the proof calls
/// reviewed, which must still pass with no P0–P2 finding.
pub(super) fn review(entry: &Value, latest: Option<&Value>, running: bool, at_reviewed: &[Value], merged: &[(String, Vec<Value>)]) -> Check<Value> {
    if running {
        return wait("A review round of this PR is still running; the last completed round decides");
    }
    let Some(r) = latest else {
        return stop("review_not_passing", "This PR has no completed review round");
    };
    let proof = &entry["reviewMerges"];
    let via_merges = r["headSha"] != entry["headSha"];
    if via_merges && !(proof["head"] == entry["headSha"] && proof["reviewedHead"] == r["headSha"]) {
        return stop(
            "review_not_passing",
            format!("The last completed review round ({}) reviewed {}, not the released head {}",
                r["id"].as_str().unwrap_or("?"), short(&r["headSha"]), short(&entry["headSha"])),
        );
    }
    let which = if via_merges { format!("the reviewed head {}", short(&r["headSha"])) } else { "this head".to_owned() };
    if !crate::pr_review::policy::passes(r) {
        return stop(
            "review_not_passing",
            format!("The last completed review round ({}) at {which} concluded {}, which does not pass under the review policy",
                r["id"].as_str().unwrap_or("?"), r["conclusion"].as_str().unwrap_or("unknown")),
        );
    }
    let blocking = |round: &Value| {
        round["findings"].as_array().into_iter().flatten().filter(|f| f["priority"].as_u64().is_some_and(|p| p <= 2)).count()
    };
    if let Some(earlier) = at_reviewed.iter().filter(|o| o["headSha"] == r["headSha"]).find(|o| blocking(o) > 0) {
        return stop(
            "review_not_passing",
            format!("Review round {} ({}) at {which} found {} P0–P2 issue(s); a later round of the same head does not clear them, so a new head needs a passing round of its own",
                earlier["round"], earlier["id"].as_str().unwrap_or("?"), blocking(earlier)),
        );
    }
    let mut passed = json!({"id":r["id"],"round":r["round"],"conclusion":r["conclusion"],"headSha":r["headSha"],
        "coverage":format!("{}/{}", r["coverage"]["coveredFileCount"], r["coverage"]["fileCount"]),"passes":true});
    if via_merges {
        for m in proof["merges"].as_array().into_iter().flatten().filter(|m| m["why"]["kind"] == "reviewed") {
            let other = m["mergedIn"].as_str().unwrap_or("");
            let rounds = merged.iter().find(|(sha, _)| sha == other).map(|(_, r)| r.as_slice()).unwrap_or_default();
            if let Some(bad) = rounds.iter().find(|o| blocking(o) > 0) {
                return stop(
                    "review_not_passing",
                    format!("Merge {} brings in {}, where review round {} found {} P0–P2 issue(s)",
                        short(&m["commit"]), short(&m["mergedIn"]), bad["id"].as_str().unwrap_or("?"), blocking(bad)),
                );
            }
            if !rounds.iter().any(crate::pr_review::policy::passes) {
                return stop(
                    "review_not_passing",
                    format!("Merge {} brings in {}, which no longer has a passing review round", short(&m["commit"]), short(&m["mergedIn"])),
                );
            }
        }
        passed["releasedHead"] = entry["headSha"].clone();
        passed["merges"] = proof["merges"].clone();
    }
    Ok(passed)
}

/// The repository's landing policy (YN-18 S2d), set by the user: `strict`,
/// the default, or `relaxed`.
pub(super) const STRICT: &str = "strict";
pub(super) const RELAXED: &str = "relaxed";
pub(super) fn relaxed(repository: &Value) -> bool {
    repository["policy"] == RELAXED
}

/// Main is not red, as the relaxed policy reads it (the user's rule of
/// 2026-11-07): the newest finished push run of CI on the base branch (not
/// superseded) succeeded, and no newer one is red. A run waiting to start
/// (held by its concurrency group) waits, so each merge keeps a main run of
/// its own. A red main waits, never stops: the entry merges once main is green
/// again. A run an unpause accepted (`accepted`, by id) is listed and skipped.
/// `runs` are newest first.
pub(super) fn main_not_red(runs: &[Value], accepted: &[Value]) -> Check<Value> {
    let mut seen = Vec::new();
    for run in runs.iter().filter(|r| r["name"] == CI) {
        let conclusion = run["conclusion"].as_str().unwrap_or("");
        let skipped = accepted.contains(&run["id"]);
        seen.push(json!({"run":run["id"],"headSha":run["head_sha"],"status":run["status"],"conclusion":run["conclusion"],"accepted":skipped}));
        if skipped {
            continue;
        }
        if matches!(run["status"].as_str(), Some("pending" | "waiting")) {
            return wait(format!("Main CI run {} on {} waits to start; Core merges once it has, so each merge keeps a main run of its own", run["id"], short(&run["head_sha"])));
        }
        if matches!(conclusion, "failure" | "timed_out" | "startup_failure" | "action_required") {
            return wait(format!("Main CI run {} on {} concluded {conclusion}; under the relaxed policy the entry waits until main CI is green again", run["id"], short(&run["head_sha"])));
        }
        if run["status"] == "completed" && conclusion != "cancelled" {
            return Ok(json!(seen));
        }
    }
    wait("No finished main CI run among the newest ones yet")
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

/// The red runs an unpause accepted at `main`, from the repository's pause
/// journal. Acceptance belongs to that main: every entry anchored there skips
/// them, whether an unpause re-anchored it, it was retried, or it was released
/// there afterwards; an entry anchored at another main carries none.
pub(super) fn accepted_runs(repository: &Value, main: &str) -> Vec<Value> {
    repository["pauses"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["acceptedRun"]["headSha"] == main)
        .map(|p| p["acceptedRun"]["id"].clone())
        .collect()
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

/// Whether the newest run of a workflow among `runs` is still going (YN-33):
/// the entry is then read again soon.
pub(super) fn running(runs: &[Value]) -> bool {
    runs.iter().any(|run| {
        run["status"] != "completed" && !runs.iter().any(|newer| newer["name"] == run["name"] && newer["id"].as_u64() > run["id"].as_u64())
    })
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

/// GitHub already knows the PR conflicts with its base (YN-18 S2c, T-37 lab
/// finding F2). GitHub starts no CI for such a PR, so the entry stops at once,
/// on the first read of the PR, instead of waiting for runs that never come.
/// While GitHub is still computing (`mergeable` null) nothing is decided here.
pub(super) fn conflicting(pr: &Value) -> Check<()> {
    if pr["mergeable"] == false || pr["mergeable_state"] == "dirty" {
        return stop(
            "conflict",
            format!(
                "GitHub reports that the PR cannot merge into its base {}: it has merge conflicts, and GitHub runs no CI for it",
                pr["base"]["ref"].as_str().unwrap_or("branch")
            ),
        );
    }
    Ok(())
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

/// What the PR's merge ref says about CI on the current main (design §4.1;
/// YN-18 S2c for the last two).
#[derive(Debug, PartialEq)]
pub(super) enum Slot {
    /// The merge of the current main and the head, with its tree: the tree a
    /// merge would land, and the slot gate if CI checked out exactly it.
    Fresh(String),
    /// The merge of another main (named) and the head. CI checks out the merge
    /// ref, and GitHub only moves it forward, so CI on the PR cannot have
    /// tested the current main. GitHub may never move it (T-37 lab finding F1:
    /// over 19 minutes), so this waits for nothing once that main is known to
    /// be an older one.
    Stale(String),
    /// No merge ref GitHub has computed for the current main and the head yet.
    Missing(String),
}
pub(super) fn slot(merge: Option<&Value>, main: &str, head: &str) -> Slot {
    let Some(merge) = merge else {
        return Slot::Missing("GitHub has not computed the PR's merge ref yet".into());
    };
    let p = parents(merge);
    match p[..] {
        [m, h] if m == main && h == head => match tree_of(merge) {
            Some(tree) => Slot::Fresh(tree.to_owned()),
            None => Slot::Missing("The PR's merge ref has no readable tree".into()),
        },
        [older, h] if h == head => Slot::Stale(older.to_owned()),
        _ => Slot::Missing(format!("The PR's merge ref {} is not a merge of a main and the head", short(&merge["sha"]))),
    }
}

/// How long an entry waits for GitHub to compute a merge ref it does not
/// have, or to move one whose main is not known to be older, before Core
/// builds the batch with its own merge (seconds).
pub(super) const SLOT_GRACE: i64 = 120;

/// Whether an entry whose merge ref is not the slot goes to the batch now.
/// `older` says the ref's main is an ancestor of the current main: CI cannot
/// have tested the current main, so it goes at once. Otherwise it goes once
/// the ref has looked like this for `SLOT_GRACE` (`waited`, in seconds). The
/// batch is Core's own merge of the head into the current main, so it needs
/// nothing from GitHub's merge ref. `Ok` says why the batch is built.
pub(super) fn batch_now(slot: &Slot, older: bool, waited: i64, main: &str) -> Check<String> {
    let current = &main[..12.min(main.len())];
    match slot {
        Slot::Fresh(_) => wait("The PR's merge ref is the merge of the current main and the head"),
        Slot::Stale(ref_main) if older => Ok(format!(
            "The PR's merge ref is the merge of the older main {} and the head, which GitHub has not moved to the current main {current}, so CI on the PR cannot have tested the current main",
            &ref_main[..12.min(ref_main.len())]
        )),
        _ if waited >= SLOT_GRACE => Ok(format!(
            "GitHub has had no merge ref of the current main {current} and the head for {} minutes, so CI on the PR cannot be shown to have tested it",
            SLOT_GRACE / 60
        )),
        Slot::Stale(ref_main) => wait(format!(
            "The PR's merge ref is the merge of main {}, which is not known to be older than the current main {current}; Core builds a batch with its own merge if GitHub has not moved it within {} minutes",
            &ref_main[..12.min(ref_main.len())],
            SLOT_GRACE / 60
        )),
        Slot::Missing(detail) => wait(format!(
            "{detail}; Core builds a batch with its own merge if GitHub has none within {} minutes",
            SLOT_GRACE / 60
        )),
    }
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

/// The most steps one chain of batches holds (YN-18 S2e, decision 4): at
/// most this many of Core's draft PRs per repository, one chain at a time.
pub(super) const CHAIN_STEPS: usize = 4;

/// Every CI job of a chain step's batch checked out a merge of that batch
/// commit whose tree is the step's tree (tree-ci-check.sh's test). After the
/// steps ahead landed, main is no longer the main the batch was built on, so
/// the merge's first parent may be either; the tree is what CI tested and
/// what the merge must land.
pub(super) fn chain_checkouts(jobs: &[Checkout], commit: &str, tree: &str) -> Check<Vec<Value>> {
    let mut proved = Vec::new();
    for c in jobs.iter().filter(|c| c.job["conclusion"] != "skipped") {
        let name = c.job["name"].as_str().unwrap_or("?");
        let Some(checked) = c.commit.as_ref().filter(|_| c.line.is_some()) else {
            return stop("checkout_unproven", format!("Job {} ({name}) shows no checkout of a merge commit in {} bytes of its log", c.job["id"], c.bytes));
        };
        if parents(checked).get(1) != Some(&commit) || tree_of(checked) != Some(tree) {
            return stop(
                "checkout_mismatch",
                format!("Job {} ({name}) checked out {}, which is not a merge of the chain step {} with its tree {}",
                    c.job["id"], short(&checked["sha"]), &commit[..12.min(commit.len())], &tree[..12.min(tree.len())]),
            );
        }
        proved.push(json!({"id":c.job["id"],"name":name,"conclusion":c.job["conclusion"],"checkout":checked["sha"],
            "checkoutTree":tree,"logSha256":c.sha256,"logBytes":c.bytes,"truncated":c.truncated}));
    }
    if proved.is_empty() {
        return stop("checkout_unproven", "No CI job on the chain step ran, so nothing shows what was tested");
    }
    Ok(proved)
}

/// The repository's pause (design §5). While it holds, entries wait and none
/// merges. A `main_red` pause clears itself once main has moved past the red
/// commit and CI on the new main finished green: `Ok(Some(..))` says so, with
/// what cleared it, and the store re-anchors every waiting entry there.
pub(super) fn pause(paused: &Value, base: &str, main: &str, runs: &[Value]) -> Check<Option<Value>> {
    if paused.is_null() {
        return Ok(None);
    }
    let reason = paused["reason"].as_str().unwrap_or("paused");
    // Only an entry on the base the pause was recorded on reads that branch's
    // newer green main; another branch's green head says nothing about it.
    if reason == "main_red" && paused["base"] == base && paused["main"] != main {
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
