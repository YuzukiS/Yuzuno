//! What an Agent's MCP call answers (T-153). The store keeps, and the GUI
//! reads, whole records and whole idempotency receipts; an Agent gets a task's
//! current view by default, a short receipt for a task write, and a review's
//! summary unless it asks for the full one. A retried write is answered from
//! the stored receipt through the same projection, so it reads the same.
//! A merge entry (YN-69) is its summary: the entry as it is now, its evidence
//! once and its newest history; merge_list lists short rows, 20 a page.
use serde_json::{json, Map, Value};

/// Task writes whose answer to an Agent is a short receipt.
const WRITES: &[&str] = &["task_create", "task_update", "task_claim", "task_comment", "task_submit_result", "task_dispatch"];
const TASK_MORE: &str = "task_get(taskId) reads the task as it is now";
const REVIEW_MORE: &str = "review_get with view \"full\" adds the original report, context reads and per-file evidence";
/// Merge writes whose answer is the entry (merge_unpause answers with the repository).
const MERGE_WRITES: &[&str] = &["merge_enqueue", "merge_cancel", "merge_retry", "merge_revert"];
const MERGE_MORE: &str = "merge_get with view \"full\" adds lastEvidence (the last check as Core read it) and the whole history";
const MERGE_LIST_MORE: &str = "merge_get(entryId) reads an entry; merge_list with view \"full\" lists each as stored";
/// How many merge entries an Agent's merge_list lists unless it gives a limit.
const MERGE_PAGE: i64 = 20;
/// The newest history an entry's summary keeps.
const MERGE_HISTORY: usize = 10;

/// Before the call: an Agent's task_get without a view reads the current view
/// (or a page of history when it pages); review_get's view is taken out here
/// (the review store knows no views) and returned. Err is the Agent's to fix.
pub(crate) fn prepare(tool: &str, arguments: &mut Map<String, Value>) -> Result<Option<String>, String> {
    match tool {
        "task_get" if !arguments.contains_key("view") && !arguments.contains_key("dispatchId") => {
            let paged = arguments.contains_key("afterSeq") || arguments.contains_key("limit");
            arguments.insert("view".into(), json!(if paged { "activity" } else { "current" }));
            Ok(None)
        }
        "review_get" => take_view(arguments),
        // The merge store knows no views either; an Agent's page is 20 (YN-69).
        "merge_get" | "merge_list" => {
            let view = take_view(arguments)?;
            if tool == "merge_list" && !arguments.contains_key("limit") {
                arguments.insert("limit".into(), json!(MERGE_PAGE));
            }
            Ok(view)
        }
        _ => Ok(None),
    }
}

fn take_view(arguments: &mut Map<String, Value>) -> Result<Option<String>, String> {
    match arguments.remove("view") {
        None => Ok(Some("summary".into())),
        Some(Value::String(view)) if view == "summary" || view == "full" => Ok(Some(view)),
        Some(_) => Err("invalid_input: view is summary or full".into()),
    }
}

/// After the call: what the Agent reads. `view` is what `prepare` took out.
pub(crate) fn answer(tool: &str, value: Value, view: Option<&str>) -> Value {
    let full = view == Some("full");
    if WRITES.contains(&tool) {
        receipt(&value)
    } else if tool == "review_get" && !full {
        review_summary(&value)
    } else if (tool == "merge_get" && !full) || (MERGE_WRITES.contains(&tool) && value.get("lastEvidence").is_some()) {
        merge_summary(&value)
    } else if tool == "merge_list" && !full {
        let mut out = value.clone();
        if let Some(entries) = value["entries"].as_array() {
            out["entries"] = entries.iter().map(merge_row).collect();
            out["more"] = json!(MERGE_LIST_MORE);
        }
        out
    } else {
        value
    }
}

/// A merge entry as an Agent follows it (YN-69): the entry as it is now
/// (state, reason, release, batch, merge and its follow-up), its evidence
/// without the fields that repeat the entry (they are the entry's at the last
/// check, and the entry's own are current), and its newest history.
/// lastEvidence, the last check as Core read it, is view "full"'s.
fn merge_summary(entry: &Value) -> Value {
    let mut out = entry.clone();
    let Some(map) = out.as_object_mut() else { return out };
    map.remove("lastEvidence");
    if let Some(evidence) = map.get_mut("evidence").and_then(Value::as_object_mut) {
        for repeated in ["entry", "repository", "pr", "head", "state", "release", "binaries", "batch", "merge", "grouping", "stop"] {
            evidence.remove(repeated);
        }
    }
    if let Some(history) = map.get_mut("history").and_then(Value::as_array_mut) {
        let count = history.len();
        history.drain(..count.saturating_sub(MERGE_HISTORY));
        map.insert("historyCount".into(), json!(count));
    }
    map.insert("more".into(), json!(MERGE_MORE));
    out
}

/// One row of an Agent's merge_list: which entry, PR and head, where it stands
/// and why, and its merge.
fn merge_row(entry: &Value) -> Value {
    let mut row = pick(entry, &["id", "entryId", "taskId", "taskReference", "repository", "number", "url", "headSha", "state",
        "reason", "detail", "waitingSince", "createdAt", "updatedAt"]);
    if entry["merge"].is_object() {
        row["merge"] = pick(&entry["merge"], &["sha", "mergedAt", "mainCi"]);
    }
    row
}

fn pick(from: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = from.get(*key).filter(|v| !v.is_null()) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

/// A task write's receipt: the whole answer with fields left out, never moved
/// or renamed, so a caller reading `task.id`, `task.version` or
/// `task.result.id` reads the same value. Kept: the task's identity, status
/// and version (what a next write needs), the activity it recorded, and for a
/// result, a dispatch or a mail the identities made. The whole task is one
/// task_get away.
fn receipt(value: &Value) -> Value {
    let task = &value["task"];
    let mut short = pick(task, &["id", "title", "status", "version", "updatedAt"]);
    if task["assignee"].is_object() {
        short["assignee"] = pick(&task["assignee"], &["kind", "id", "name"]);
    }
    if task["dispatch"].is_object() {
        short["dispatch"] = pick(&task["dispatch"], &["id", "active"]);
    }
    if value["activity"]["kind"] == "result" && task["result"].is_object() {
        let result = &task["result"];
        let mut kept = pick(result, &["id", "dispatchId"]);
        if result["notification"].is_object() {
            kept["notification"] = pick(&result["notification"], &["state", "messageId"]);
        }
        short["result"] = kept;
    }
    let mut out = json!({"task": short});
    if value["activity"].is_object() {
        out["activity"] = pick(&value["activity"], &["seq", "kind", "at"]);
    }
    if value["message"].is_object() {
        let message = &value["message"];
        let mut kept = pick(message, &["id", "seq", "dispatchId"]);
        if message["recipient"].is_object() {
            kept["recipient"] = pick(&message["recipient"], &["kind", "id", "name"]);
        }
        if message["delivery"].is_object() {
            kept["delivery"] = pick(&message["delivery"], &["state"]);
        }
        out["message"] = kept;
    }
    for key in ["projectNotice", "claimNotice"] {
        if let Some(notice) = value.get(key) {
            out[key] = notice.clone();
        }
    }
    // A content editor's advice where an outcome goes on Home (T-154), and
    // how the user prefers it presented (T-175).
    for key in ["homeHint", "homePreference"] {
        if let Some(advice) = value.get(key) {
            out[key] = advice.clone();
        }
    }
    out["more"] = json!(TASK_MORE);
    out
}

/// A review's summary: its identity, fixed range, conclusion and findings
/// (whole: they are what the review says), whether a reviewer ran, how much
/// it covered, and every changed path it did not cover with why. A
/// continuation or incremental round also names the round it follows; an
/// incremental one keeps the findings it settled (whole, with their fix
/// paths) and, of the earlier round, what its own conclusion is read against.
/// Its unsettled earlier findings are among `findings`, each with its origin.
fn review_summary(value: &Value) -> Value {
    let mut out = pick(value, &["id", "reviewId", "taskId", "linkId", "number", "repository", "url", "round", "status",
        "phase", "conclusion", "nativeCorrectness", "error", "reasonCodes", "outdated", "baseSha", "headSha",
        "mergeBaseSha", "comparison", "commitCount", "createdAt", "finishedAt", "actualModel", "actualHarness",
        "contextIncomplete", "acknowledgedUnreviewable", "explanation", "findings", "evidence",
        "kind", "parentReviewId", "previousReviewId", "settledFindings", "cursor", "policyVersion", "coveragePolicyVersion",
        "roundLimit"]);
    // Unknown freshness must stay explicit, rather than disappear through pick.
    out["outdated"] = value["outdated"].clone();
    // The earlier round's identity and verdict; its findings are carried in
    // `findings` or `settledFindings`, its ledger and reads stay in "full".
    let earlier = &value["incremental"];
    if earlier.is_object() {
        out["incremental"] = pick(earlier, &["previousReviewId", "previousRound", "previousBaseSha", "previousHeadSha",
            "previousMergeBaseSha", "previousConclusion"]);
    }
    if let Some(name) = value["requestedBy"]["name"].as_str() {
        out["requestedBy"] = json!(name);
    }
    // A review that failed while preparing never started a reviewer: it is
    // not a round of review, however it is numbered.
    if let Some(harness) = value.get("actualHarness") {
        out["reviewerStarted"] = json!(!harness.is_null());
    }
    let coverage = &value["coverage"];
    if coverage.is_object() {
        out["coverage"] = pick(coverage, &["fileCount", "coveredFileCount", "uninspected", "failedRequests",
            "unresolvedRequests", "terminalLimit"]);
    }
    let scope = &value["scope"];
    if scope.is_object() {
        let uncovered: Vec<Value> = scope["paths"].as_array().into_iter().flatten()
            .filter(|path| path["state"] != "covered")
            .map(|path| pick(path, &["path", "state", "status", "facts"]))
            .collect();
        out["scope"] = json!({"counts": scope["counts"], "policy": scope["policy"], "notCovered": uncovered});
    }
    out["more"] = json!(REVIEW_MORE);
    out
}

#[cfg(test)]
#[path = "mcp_views_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mcp_views_measure.rs"]
mod measure;
