//! A review of a new head of a PR that relies on one completed earlier round
//! of another head. It is a new snapshot and a new round with a normal budget
//! of its own; nothing here resumes the earlier reviewer.
//!
//! Only the earlier round's proofs of changed paths that are identical on
//! both sides, with the same merge base, carry over. Every other changed path
//! is read again. None of its findings disappear: one is settled only when
//! this round shows, by its own complete reads of paths that changed since,
//! where it was fixed.
use super::{continuation, policy, source};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::collections::HashMap;
#[cfg(test)]
mod tests;

/// The longest explanation a settled finding keeps.
const MAX_EXPLANATION_BYTES: usize = 20_000;

fn round(previous: &Value) -> String {
    format!("Round {} ({})", previous["round"], previous["id"].as_str().unwrap_or_default())
}

/// Whether a review of `head` may rely on `previous`, from its stored record
/// alone. `head` is the requested or last displayed head, when known; the
/// fetched one is checked again before any model starts.
pub(super) fn admit(previous: &Value, head: Option<&str>, settings: &Value) -> Result<(), String> {
    let named = round(previous);
    if !previous["kind"].is_null() {
        return Err(format!("{named} isn't a full round ({}); an incremental review relies on one full round.", previous["kind"].as_str().unwrap_or("derived")));
    }
    if previous["status"] != "completed" || previous["actualHarness"].is_null() || previous["finishedAt"].is_null() {
        return Err(format!(
            "{named} ended {}; only a completed round whose reviewer finished and shut down can be relied on.",
            previous["status"].as_str().unwrap_or("unknown")
        ));
    }
    if !continuation::ledger(previous) || !previous["ledger"]["operationMs"].is_u64() {
        return Err(format!("{named} has no usage ledger or response hashes, so what it spent and read can't be proved."));
    }
    if previous["ledger"]["nativeCompletion"] != "confirmed" {
        return Err(format!("{named} has no record that its native run completed and shut down before its report was stored."));
    }
    let scope = &previous["scope"];
    if scope["version"] != source::scope::VERSION
        || scope["baseSha"] != previous["baseSha"]
        || scope["headSha"] != previous["headSha"]
        || previous["coveragePolicyVersion"] != source::COVERAGE_VERSION
        || previous["policyVersion"] != policy::VERSION
        || !previous["coverage"]["coveredFiles"].is_array()
    {
        return Err(format!("{named} was judged under another coverage or review policy, or has no recorded scope."));
    }
    if previous["requestedHarness"] != settings["harness"] || previous["requestedModel"] != settings["model"] {
        return Err(format!("The review harness or model changed since {named}; an incremental review keeps its reviewer."));
    }
    if head.is_some_and(|head| previous["headSha"] == head) {
        return Err(format!("{named} reviewed this same head; for the same snapshot use review_continue."));
    }
    let reads = previous["contextReads"].as_array().cloned().unwrap_or_default();
    if reads.iter().any(|r| !r["responseSha256"].is_string() || !r["number"].is_u64()) {
        return Err(format!("{named} has responses without a recorded hash; what it read can't be verified."));
    }
    Ok(())
}

/// What the new round keeps of the earlier one: identity, verdict, findings
/// (by index) and ledger. Its scope and proofs are read again before the
/// reviewer starts.
pub(super) fn record(previous: &Value) -> Value {
    let findings: Vec<Value> = previous["findings"].as_array().into_iter().flatten().enumerate()
        .map(|(index, f)| {
            let mut f = f.clone();
            f["index"] = json!(index);
            f
        })
        .collect();
    json!({"previousReviewId":previous["id"],"previousRound":previous["round"],"previousBaseSha":previous["baseSha"],
        "previousHeadSha":previous["headSha"],"previousMergeBaseSha":previous["mergeBaseSha"],"previousConclusion":previous["conclusion"],
        "previousNativeCorrectness":previous["nativeCorrectness"],"previousExplanation":previous["explanation"],
        "previousFindings":findings,"previousLedger":previous["ledger"]})
}

/// Compares the fetched snapshot with the earlier round's, path by path. A
/// proof carries over only for a path the earlier round covered whose status
/// and both sides' blob and mode are identical, under the same merge base:
/// a new merge base changes what every diff means, so everything is read
/// again. Returns the carried proofs; `run.incremental` names the paths to
/// read, those carried and those that left the PR. Each path to read records
/// whether its head-side object differs from the earlier head's, compared
/// by blob and mode (null when the earlier record can't show it): only such
/// a path can hold a fix.
pub(super) fn compare(previous: &Value, run: &mut Value) -> Result<Vec<Value>> {
    let named = round(previous);
    ensure!(
        run["headSha"] != previous["headSha"],
        "{named} reviewed this same head; for the same snapshot use review_continue. Nothing was started."
    );
    let same_base = run["mergeBaseSha"] == previous["mergeBaseSha"];
    let identity = |p: &Value| json!([p["status"], p["head"], p["mergeBase"]]);
    let before: HashMap<&str, &Value> = previous["scope"]["paths"].as_array().into_iter().flatten()
        .filter_map(|p| Some((p["path"].as_str()?, p)))
        .collect();
    let read_before: HashMap<&str, &Value> = previous["coverage"]["coveredFiles"].as_array().into_iter().flatten()
        .filter_map(|p| Some((p["path"].as_str()?, p)))
        .collect();
    let files = run["files"].as_array().cloned().unwrap_or_default();
    let paths = run["scope"]["paths"].as_array().cloned().unwrap_or_default();
    // Paths no review can read or that the base's policy excludes stay
    // outside this round's scope, as in any round; they aren't targets.
    let outside = source::scope::permanent_gaps(&run["scope"]);
    let (mut proofs, mut carried, mut targets, mut outside_changed) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for p in &paths {
        let path = p["path"].as_str().unwrap_or_default();
        if outside.iter().any(|g| g["path"] == path) {
            if before.get(path).is_none_or(|old| !same_base || identity(old) != identity(p)) {
                outside_changed.push(path);
            }
            continue;
        }
        let why = match before.get(path) {
            None => "new_in_pr",
            Some(_) if !same_base => "merge_base_changed",
            Some(old) if identity(old) != identity(p) => "changed",
            Some(_) => match (read_before.get(path), files.iter().find(|f| f["path"] == path)) {
                (Some(proof), Some(file)) => {
                    let mut proof = (*proof).clone();
                    proof["provedAtRevision"] = proof["revision"].clone();
                    proof["revision"] = file["sourceRevision"].clone();
                    proof["byReview"] = previous["id"].clone();
                    proofs.push(proof);
                    carried.push(json!(path));
                    continue;
                }
                _ => "not_covered_before",
            },
        };
        // The earlier head's object: its own record of the path, or, for a
        // path that wasn't in its PR, the same merge base's.
        let since = match before.get(path) {
            Some(old) => json!(old["head"] != p["head"]),
            None if same_base => json!(p["mergeBase"] != p["head"]),
            None => Value::Null,
        };
        targets.push(json!({"path":path,"status":p["status"],"why":why,"changedSinceEarlierHead":since}));
    }
    let mut left: Vec<&str> = before.keys().copied().filter(|path| !paths.iter().any(|p| p["path"] == *path)).collect();
    left.sort_unstable();
    if same_base && left.is_empty() && targets.iter().all(|t| t["why"] == "not_covered_before") {
        // Nothing a reviewer could read changed. Say exactly that: a change
        // to paths no review can cover is still a change, and they stay
        // unreviewed.
        ensure!(
            outside_changed.is_empty(),
            "Since {named}, this head changes only paths no review can cover: unsupported, too large or excluded by the base's scope policy ({}). A reviewer would have nothing it can read, so nothing was started; those paths stay unreviewed.",
            outside_changed.iter().take(10).copied().collect::<Vec<_>>().join(", ")
        );
        anyhow::bail!("This head changes none of the PR's paths since {named} (same merge base, paths, blobs and modes), so that round's result still describes it. Nothing was started.");
    }
    let incremental = &mut run["incremental"];
    incremental["sameMergeBase"] = json!(same_base);
    incremental["targets"] = json!(targets);
    incremental["carriedPaths"] = json!(carried);
    incremental["leftThePr"] = json!(left);
    Ok(proofs)
}

/// The fetched snapshot's own evidence, with what the reviewer must know of
/// the earlier round. All of it counts as context bytes.
pub(super) fn evidence(collected: &str, run: &Value) -> Result<String> {
    let mut evidence: Value = serde_json::from_str(collected)?;
    let i = &run["incremental"];
    let covered: Vec<_> = run["coverage"]["coveredFiles"].as_array().into_iter().flatten()
        .filter(|p| p["byReview"] == i["previousReviewId"])
        .map(|p| json!({"path":p["path"],"evidenceKind":p["evidenceKind"],"byReview":p["byReview"],"provedAtRevision":p["provedAtRevision"]}))
        .collect();
    evidence["incrementalOf"] = json!({"reviewId":i["previousReviewId"],"round":i["previousRound"],"headSha":i["previousHeadSha"],
        "mergeBaseSha":i["previousMergeBaseSha"],"overallCorrectness":i["previousNativeCorrectness"],"explanation":i["previousExplanation"],
        "findings":i["previousFindings"]});
    evidence["alreadyCovered"] = json!(covered);
    evidence["targets"] = i["targets"].clone();
    evidence["leftThePr"] = i["leftThePr"].clone();
    Ok(serde_json::to_string(&evidence)?)
}

/// The report's extra field for an incremental review: one disposition per
/// earlier finding, by index.
pub(super) fn schema(findings: usize) -> Value {
    json!({"type":"array","maxItems":findings,"items":{"type":"object","additionalProperties":false,"required":["index","disposition","fix_paths","explanation"],"properties":{
        "index":{"type":"integer","minimum":0,"description":"The earlier finding's index in incrementalOf.findings"},
        "disposition":{"type":"string","enum":["fixed","still_valid"]},
        "fix_paths":{"type":"array","items":{"type":"string"},"description":"For fixed: the targets you read completely at this head that contain the fix; empty for still_valid"},
        "explanation":{"type":"string","description":format!("Nonblank, at most {MAX_EXPLANATION_BYTES} UTF-8 bytes")}
    }}})
}

/// Why an earlier finding stays, or the settlement this round's own reads
/// support: `fixed`, once, with fix paths that changed since the earlier
/// head and that this round covered itself, and an explanation.
fn settle(answers: &[&Value], changed: &[&str], read_here: &dyn Fn(&str) -> bool) -> Result<Value, &'static str> {
    let answer = match answers {
        [] => return Err("not answered"),
        [answer] => *answer,
        _ => return Err("answered more than once"),
    };
    if answer["disposition"] != "fixed" {
        return Err("not shown fixed");
    }
    let paths: Vec<&str> = answer["fix_paths"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if paths.is_empty() || answer["fix_paths"].as_array().map_or(0, Vec::len) != paths.len() {
        return Err("fixed without fix paths");
    }
    if !paths.iter().all(|p| changed.contains(p) && read_here(p)) {
        return Err("a fix path didn't change since the earlier head or wasn't read completely by this round");
    }
    let explanation = answer["explanation"].as_str().filter(|e| !e.trim().is_empty() && e.len() <= MAX_EXPLANATION_BYTES).ok_or("fixed without an explanation")?;
    Ok(json!({"disposition":"fixed","fixPaths":paths,"explanation":explanation}))
}

/// The verdict at the new head. Earlier findings are kept with their origin
/// unless settled; settled ones are listed with what settled them. A blocking
/// finding left from either round blocks. The earlier round's own verdict
/// was about its head and isn't carried.
pub(super) fn conclude(run: &mut Value, answers: &Value) {
    let i = run["incremental"].clone();
    let id = run["id"].clone();
    // Only a path whose object differs from the earlier head's can hold a fix.
    let changed: Vec<&str> = i["targets"].as_array().into_iter().flatten()
        .filter(|t| t["changedSinceEarlierHead"] == true)
        .filter_map(|t| t["path"].as_str())
        .collect();
    let covered = run["coverage"]["coveredFiles"].clone();
    let read_here = |path: &str| {
        covered.as_array().into_iter().flatten()
            .any(|c| c["path"] == path && (c["byReview"].is_null() || c["byReview"] == id))
    };
    let mut by_index: HashMap<u64, Vec<&Value>> = HashMap::new();
    for answer in answers.as_array().into_iter().flatten() {
        if let Some(index) = answer["index"].as_u64() {
            by_index.entry(index).or_default().push(answer);
        }
    }
    let (mut findings, mut settled) = (Vec::new(), Vec::new());
    for (index, earlier) in i["previousFindings"].as_array().into_iter().flatten().enumerate() {
        let mut f = earlier.clone();
        f["origin"] = json!({"reviewId":i["previousReviewId"],"carried":true});
        let given = by_index.get(&(index as u64)).map(Vec::as_slice).unwrap_or_default();
        match settle(given, &changed, &read_here) {
            Ok(settlement) => {
                f["settlement"] = settlement;
                f["settlement"]["settledBy"] = id.clone();
                settled.push(f);
            }
            Err(reason) => {
                f["disposition"] = json!({"state":"still_valid","reason":reason});
                findings.push(f);
            }
        }
    }
    for f in run["findings"].as_array().into_iter().flatten() {
        let mut f = f.clone();
        f["origin"] = json!({"reviewId":id,"carried":false});
        findings.push(f);
    }
    let blocking = findings.iter().any(|f| f["priority"].as_u64().is_some_and(|p| p < 3));
    let verdict = |conclusion: &Value| -> Value {
        match conclusion.as_str() {
            _ if blocking && !conclusion.is_null() => json!("changes_requested"),
            Some("no_findings") if !findings.is_empty() => json!("approved_with_notes"),
            _ => conclusion.clone(),
        }
    };
    run["conclusion"] = verdict(&run["conclusion"]);
    if !run["scopeConclusion"].is_null() {
        run["scopeConclusion"] = verdict(&run["scopeConclusion"]);
    }
    run["findings"] = json!(findings);
    run["settledFindings"] = json!(settled);
}

/// This round's own use and, with the earlier round's, the chain's; each
/// run's own usage report (tokens, cost) is kept as recorded, unknown or not.
pub(super) fn cumulative(run: &Value) -> Value {
    let earlier = &run["incremental"]["previousLedger"];
    let own = &run["ledger"];
    let sum = |key: &str| own[key].as_u64().zip(earlier[key].as_u64()).map(|(a, b)| a + b);
    let cost = match (own["nativeUsage"]["state"].as_str(), earlier["nativeUsage"]["state"].as_str()) {
        (Some("reported"), Some("reported")) => json!({"state":"reported","basis":"the sum of each run's own harness estimate, not a bill","totalCostUsd":
            own["nativeUsage"]["totalCostUsd"].as_f64().unwrap_or(0.0) + earlier["nativeUsage"]["totalCostUsd"].as_f64().unwrap_or(0.0)}),
        _ => json!({"state":"unknown"}),
    };
    let each = |id: &Value, ledger: &Value| json!({"reviewId":id,"calls":ledger["calls"],"bytes":ledger["bytes"],"operationMs":ledger["operationMs"],"nativeUsage":ledger["nativeUsage"]});
    json!({"calls":sum("calls"),"bytes":sum("bytes"),"operationMs":sum("operationMs"),"nativeUsage":cost,
        "runs":[each(&run["incremental"]["previousReviewId"], earlier), each(&run["id"], own)]})
}
