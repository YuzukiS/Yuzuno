//! What an Agent's MCP call answers (T-153). The store keeps, and the GUI
//! reads, whole records and whole idempotency receipts; an Agent gets a task's
//! current view by default, a short receipt for a task write, and a review's
//! summary unless it asks for the full one. A retried write is answered from
//! the stored receipt through the same projection, so it reads the same.
use serde_json::{json, Map, Value};

/// Task writes whose answer to an Agent is a short receipt.
const WRITES: &[&str] = &["task_create", "task_update", "task_claim", "task_comment", "task_submit_result", "task_dispatch"];
const TASK_MORE: &str = "task_get(taskId) reads the task as it is now";
const REVIEW_MORE: &str = "review_get with view \"full\" adds the original report, context reads and per-file evidence";

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
        "review_get" => match arguments.remove("view") {
            None => Ok(Some("summary".into())),
            Some(Value::String(view)) if view == "summary" || view == "full" => Ok(Some(view)),
            Some(_) => Err("invalid_input: view is summary or full".into()),
        },
        _ => Ok(None),
    }
}

/// After the call: what the Agent reads.
pub(crate) fn answer(tool: &str, value: Value, review_view: Option<&str>) -> Value {
    if WRITES.contains(&tool) {
        receipt(&value)
    } else if tool == "review_get" && review_view != Some("full") {
        review_summary(&value)
    } else {
        value
    }
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
    if let Some(notice) = value.get("projectNotice") {
        out["projectNotice"] = notice.clone();
    }
    // A content editor's advice where an outcome goes on Home (T-154).
    if let Some(hint) = value.get("homeHint") {
        out["homeHint"] = hint.clone();
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
        "kind", "parentReviewId", "previousReviewId", "settledFindings"]);
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
