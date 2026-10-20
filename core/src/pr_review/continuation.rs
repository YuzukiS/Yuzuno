//! A bounded continuation of one completed review of the same frozen
//! snapshot. It is a new native run with its own record and round, never a
//! resumed session: neither harness keeps one (Codex is ephemeral, Claude
//! doesn't persist), so nothing here claims to continue the earlier model.
//!
//! It runs only on what the parent round left of its budget, reads only the
//! paths the parent didn't cover, and keeps the parent's proofs, findings
//! and receipts as they are. Everything it may rely on is checked against
//! the parent's immutable record before any model starts.
use super::{policy, source};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
#[cfg(test)]
mod tests;

/// Runs recorded by this Core carry a ledger: what the operation used
/// (calls, bytes, time, the native harness's own usage report) and each
/// retained response's SHA-256. Without it nothing a run spent or read can
/// be proved, so it can't be continued.
pub(super) const LEDGER_VERSION: u64 = 1;
/// A review operation's whole time budget, shared with its continuation.
pub(super) const MAX_MILLISECONDS: u64 = 900_000;
/// Less than this left of the parent's time can't fetch the snapshot and
/// read anything; such a continuation is refused before it exists.
const MIN_MILLISECONDS: u64 = 60_000;
/// Started review rounds of one PR, a continuation included, across tasks.
pub(super) const MAX_STARTED_ROUNDS: i64 = 2;

pub(super) fn ledger(run: &Value) -> bool {
    run["ledger"]["version"] == LEDGER_VERSION
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Continue {
    pub(super) request_id: String,
    pub(super) task_id: String,
    /// The completed round to continue.
    pub(super) review_id: String,
    pub(super) base_sha: String,
    pub(super) head_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) acknowledge_unreviewable: Option<bool>,
}

fn round(parent: &Value) -> String {
    format!("Round {} ({})", parent["round"], parent["id"].as_str().unwrap_or_default())
}

/// Whether a parent round can be continued, from its stored record alone:
/// its targets and the budget it leaves, or why not. No model is involved.
pub(super) fn admit(parent: &Value, input: &Continue, settings: &Value) -> Result<Value, String> {
    let named = round(parent);
    if parent["kind"] == "continuation" {
        return Err(format!("{named} is itself a continuation; a review chain gets at most one."));
    }
    if parent["status"] != "completed" || parent["actualHarness"].is_null() || parent["finishedAt"].is_null() {
        return Err(format!(
            "{named} ended {}; only a completed round whose reviewer finished and shut down can be continued. Reconcile it with its retained record instead.",
            parent["status"].as_str().unwrap_or("unknown")
        ));
    }
    if !ledger(parent) || !parent["ledger"]["operationMs"].is_u64() {
        return Err(format!("{named} has no usage ledger or response hashes (it predates continuations), so what it spent and read can't be proved."));
    }
    if parent["ledger"]["nativeCompletion"] != "confirmed" {
        return Err(format!("{named} has no record that its native run completed and shut down before its report was stored."));
    }
    if parent["baseSha"] != input.base_sha.as_str() || parent["headSha"] != input.head_sha.as_str() {
        return Err(format!("{named} reviewed another base or head; a continuation is only for the same frozen snapshot. A new head needs its own review."));
    }
    let scope = &parent["scope"];
    if scope["version"] != source::scope::VERSION
        || scope["baseSha"] != parent["baseSha"]
        || scope["headSha"] != parent["headSha"]
        || parent["coveragePolicyVersion"] != source::COVERAGE_VERSION
        || parent["policyVersion"] != policy::VERSION
    {
        return Err(format!("{named} was judged under another coverage or review policy, or has no recorded scope."));
    }
    if parent["requestedHarness"] != settings["harness"] || parent["requestedModel"] != settings["model"] {
        return Err(format!("The review harness or model changed since {named}; a continuation keeps the parent's reviewer."));
    }
    if let Some(limit) = parent["coverage"]["terminalLimit"].as_str() {
        return Err(format!("{named} stopped at a terminal limit: {limit}. A continuation can't extend a spent budget or repeat a stopped request."));
    }
    let paths = scope["paths"].as_array().cloned().unwrap_or_default();
    let targets: Vec<Value> = paths
        .iter()
        .filter(|p| matches!(p["state"].as_str(), Some("not_read" | "read_failed")))
        .map(|p| json!({"path":p["path"],"state":p["state"]}))
        .collect();
    let target = |path: &Value| targets.iter().any(|t| t["path"] == *path);
    let failures = parent["coverage"]["failedRequests"].as_array().cloned().unwrap_or_default();
    if failures.iter().any(|f| f["resolved"] != true && !target(&f["requested"]["path"])) {
        return Err(format!("{named} has unresolved requests outside the changed paths it left unread; a continuation can't fill them."));
    }
    if targets.is_empty() {
        return Err(format!("{named} left no changed path a continuation could read: {}.", scope["counts"]));
    }
    let gaps = source::scope::permanent_gaps(scope);
    if !gaps.is_empty() && input.acknowledge_unreviewable != Some(true) {
        let names: Vec<_> = gaps.iter().take(10).filter_map(|g| g["path"].as_str()).collect();
        return Err(format!(
            "{named} also found {} changed path{} no review of this snapshot can cover ({}), so the continuation can't make it complete. Pass acknowledgeUnreviewable: true to continue anyway; that only acknowledges them.",
            gaps.len(), if gaps.len() == 1 { "" } else { "s" }, names.join(", ")
        ));
    }
    let reads = parent["contextReads"].as_array().cloned().unwrap_or_default();
    if reads.iter().any(|r| !r["responseSha256"].is_string() || !r["number"].is_u64()) {
        return Err(format!("{named} has responses without a recorded hash; what it read can't be verified."));
    }
    let calls = source::MAX_CALLS.saturating_sub(reads.len());
    let bytes = source::MAX_CONTEXT.saturating_sub(parent["contextBytes"].as_u64().unwrap_or(u64::MAX) as usize);
    let milliseconds = MAX_MILLISECONDS.saturating_sub(parent["ledger"]["operationMs"].as_u64().unwrap_or(u64::MAX));
    if calls < targets.len() || bytes == 0 || milliseconds < MIN_MILLISECONDS {
        return Err(format!(
            "{named} left {calls} calls, {bytes} bytes and {milliseconds} ms of its budget, too little for {} unread path{}. Budgets are never refilled; whoever decides can authorize a new full round.",
            targets.len(), if targets.len() == 1 { "" } else { "s" }
        ));
    }
    Ok(json!({"targets":targets,"reservation":{"calls":calls,"bytes":bytes,"milliseconds":milliseconds}}))
}

/// What the child keeps of its parent: identity, conclusion, findings,
/// targets, the reservation and the parent's ledger.
pub(super) fn record(parent: &Value, admitted: &Value) -> Value {
    json!({"parentReviewId":parent["id"],"parentRound":parent["round"],"parentConclusion":parent["conclusion"],
        "parentNativeCorrectness":parent["nativeCorrectness"],"parentExplanation":parent["explanation"],
        "parentFindings":parent["findings"],"parentReasonCodes":parent["reasonCodes"],"parentLedger":parent["ledger"],
        "parentCoverage":{"coveredFileCount":parent["coverage"]["coveredFileCount"],"fileCount":parent["coverage"]["fileCount"]},
        "targets":admitted["targets"],"reservation":admitted["reservation"]})
}

/// The re-fetched snapshot must be the parent's: merge base, every changed
/// path with both sides' blob and mode, and the policy it was judged by.
pub(super) fn same_snapshot(parent: &Value, run: &Value) -> Result<()> {
    let named = round(parent);
    for key in ["baseSha", "headSha", "mergeBaseSha"] {
        ensure!(run[key] == parent[key], "The re-fetched snapshot's {key} differs from {named}'s; nothing was started.");
    }
    let (old, new) = (&parent["scope"], &run["scope"]);
    for key in ["state", "revision", "blobSha"] {
        ensure!(new["policy"][key] == old["policy"][key], "The base's scope policy differs from the one {named} was judged by ({key}); nothing was started.");
    }
    let identity = |scope: &Value| -> Vec<Value> {
        scope["paths"].as_array().into_iter().flatten()
            .map(|p| json!([p["path"], p["status"], p["head"], p["mergeBase"]]))
            .collect()
    };
    ensure!(
        identity(old) == identity(new),
        "The re-fetched changed paths, blobs or modes differ from {named}'s; nothing was started."
    );
    Ok(())
}

/// Every response the parent delivered is still the one it recorded.
pub(super) async fn verify_receipts(parent: &Value, directory: &Path) -> Result<()> {
    let named = round(parent);
    for receipt in parent["contextReads"].as_array().into_iter().flatten() {
        let number = receipt["number"].as_u64().context("Receipt without a number")?;
        let body = tokio::fs::read(directory.join(format!("context-{number}.json")))
            .await
            .map_err(|_| anyhow::anyhow!("{named}'s retained response {number} is missing; what it read can't be verified, and nothing was started."))?;
        ensure!(
            receipt["responseSha256"] == format!("{:x}", Sha256::digest(&body)).as_str(),
            "{named}'s retained response {number} doesn't match its recorded hash; nothing was started."
        );
    }
    Ok(())
}

/// The parent's covered proofs, and its unresolved requests, each named by
/// the parent's review. Only the same path, revision and blob ever count.
pub(super) fn inherited(parent: &Value) -> (Vec<Value>, Vec<Value>) {
    let mark = |mut v: Value| {
        v["byReview"] = parent["id"].clone();
        v
    };
    let proofs = parent["coverage"]["coveredFiles"].as_array().into_iter().flatten().cloned().map(mark).collect();
    let failures = parent["coverage"]["failedRequests"].as_array().into_iter().flatten()
        .filter(|f| f["resolved"] != true)
        .cloned()
        .map(mark)
        .collect();
    (proofs, failures)
}

/// What the continuing reviewer is given instead of the whole PR's manifest:
/// the earlier round's conclusion and findings, what it covered, the paths
/// left to read and the reserved budget. All of it counts as context bytes.
pub(super) fn evidence(run: &Value, outside: &[Value], budgets: Value) -> Result<String> {
    let c = &run["continuation"];
    let targets: Vec<_> = c["targets"].as_array().into_iter().flatten()
        .filter_map(|t| run["files"].as_array()?.iter().find(|f| f["path"] == t["path"]))
        .map(|f| json!({"path":f["path"],"status":f["status"],"sourceRevision":f["sourceRevision"],"sourceBlob":f["sourceBlob"]}))
        .collect();
    let covered: Vec<_> = run["coverage"]["coveredFiles"].as_array().into_iter().flatten()
        .map(|p| json!({"path":p["path"],"evidenceKind":p["evidenceKind"],"byReview":p["byReview"]}))
        .collect();
    Ok(serde_json::to_string(&json!({"baseSha":run["baseSha"],"headSha":run["headSha"],"mergeBaseSha":run["mergeBaseSha"],
        "coveragePolicyVersion":run["coveragePolicyVersion"],
        "continuationOf":{"reviewId":c["parentReviewId"],"round":c["parentRound"],"overallCorrectness":c["parentNativeCorrectness"],
            "explanation":c["parentExplanation"],"findings":c["parentFindings"]},
        "alreadyCovered":covered,"targets":targets,"knownOutsideScope":outside,"totalFiles":run["fileCount"],
        "sourceAccess":"fixed Git objects; no checkout; rename represented as delete/add","budgets":budgets}))?)
}

/// Core checks every target before any model starts: each can be delivered
/// as text, and the bytes of all their diff pages, as the budget counts
/// them, fit the reserved bytes with the continuation's own evidence.
pub(super) async fn check_targets(run: &mut Value, context: &mut source::ContextStore) -> Result<()> {
    let reserved = run["continuation"]["reservation"]["bytes"].as_u64().unwrap_or(0) as usize;
    let mut total = 0;
    let targets: Vec<String> = run["continuation"]["targets"].as_array().into_iter().flatten()
        .filter_map(|t| t["path"].as_str().map(str::to_owned))
        .collect();
    for path in &targets {
        total += context
            .measure(run, path, reserved)
            .await
            .map_err(|error| anyhow::anyhow!("Unread path {path} can't be delivered as text ({error}); nothing was started."))?;
    }
    ensure!(
        context.bytes() + total <= reserved,
        "The unread paths' diff pages ({total} bytes) and the continuation's evidence don't fit the {reserved} bytes the parent round left; nothing was started."
    );
    Ok(())
}

/// The native harness's own usage report, as recorded: Claude's result
/// carries a cost and token usage; Codex reports neither for this turn, so
/// it is unknown, never zero.
pub(super) fn native_usage(run: &Value, raw: &str) -> Value {
    if run["actualHarness"] == "claude" {
        if let Ok(result) = serde_json::from_str::<Value>(raw) {
            if result["total_cost_usd"].is_number() {
                return json!({"state":"reported","basis":"the harness's own estimate in its result, not a bill","totalCostUsd":result["total_cost_usd"],"usage":result["usage"],"modelUsage":result["modelUsage"]});
            }
        }
        return json!({"state":"unknown","reason":"The Claude result carried no cost"});
    }
    if run["actualHarness"].is_null() {
        return json!({"state":"none","reason":"No native reviewer started"});
    }
    json!({"state":"unknown","reason":"Codex reports no cost for a review turn"})
}

/// A child's ledger: its own use, and with the parent's what the chain used.
pub(super) fn cumulative(run: &Value) -> Value {
    let parent = &run["continuation"]["parentLedger"];
    let own = &run["ledger"];
    let sum = |key: &str| own[key].as_u64().zip(parent[key].as_u64()).map(|(a, b)| a + b);
    let cost = match (own["nativeUsage"]["state"].as_str(), parent["nativeUsage"]["state"].as_str()) {
        (Some("reported"), Some("reported")) => json!({"state":"reported","basis":"the sum of each run's own harness estimate, not a bill","totalCostUsd":
            own["nativeUsage"]["totalCostUsd"].as_f64().unwrap_or(0.0) + parent["nativeUsage"]["totalCostUsd"].as_f64().unwrap_or(0.0)}),
        _ => json!({"state":"unknown"}),
    };
    json!({"calls":sum("calls"),"bytes":sum("bytes"),"operationMs":sum("operationMs"),"nativeUsage":cost})
}

/// The chain's verdict over the union. The parent's findings are carried as
/// they are (same snapshot: nothing is resolved by not being repeated) and
/// the child's are new; a blocking finding from either round blocks.
pub(super) fn conclude(run: &mut Value) {
    let c = run["continuation"].clone();
    let origin = |review: &Value, carried: bool| json!({"reviewId":review,"carried":carried});
    let mut findings: Vec<Value> = c["parentFindings"].as_array().into_iter().flatten().cloned()
        .map(|mut f| {
            f["origin"] = origin(&c["parentReviewId"], true);
            f
        })
        .collect();
    for f in run["findings"].as_array().into_iter().flatten() {
        let mut f = f.clone();
        f["origin"] = origin(&run["id"], false);
        findings.push(f);
    }
    let blocking = findings.iter().any(|f| f["priority"].as_u64().is_some_and(|p| p < 3))
        || c["parentNativeCorrectness"] == "patch is incorrect";
    let settle = |conclusion: &Value| -> Value {
        match conclusion.as_str() {
            _ if blocking && !conclusion.is_null() => json!("changes_requested"),
            Some("no_findings") if !findings.is_empty() => json!("approved_with_notes"),
            _ => conclusion.clone(),
        }
    };
    run["conclusion"] = settle(&run["conclusion"]);
    if !run["scopeConclusion"].is_null() {
        run["scopeConclusion"] = settle(&run["scopeConclusion"]);
    }
    run["findings"] = json!(findings);
}
