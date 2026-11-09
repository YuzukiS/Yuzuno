//! What an Agent's MCP call answers (T-153). The store keeps, and the GUI
//! reads, whole records and whole idempotency receipts; an Agent gets a task's
//! current view by default, a short receipt for a task write, and a review's
//! summary unless it asks for the full one. A retried write is answered from
//! the stored receipt through the same projection, so it reads the same.
//! A merge entry (YN-69) is its summary: the entry as it is now, its evidence
//! once and its newest history; merge_list lists short rows, 20 a page.
//! YN-69: an Agent's task_list is compact unless it gives compact; its mail
//! leaves out the wake-up's bookkeeping; a full task says its materials once.
use serde_json::{json, Map, Value};

/// What one MCP answer holds (YN-69 S8): 48 KiB of the compact JSON an Agent
/// reads. Longer mail and history pages end early and page on.
pub(crate) const BUDGET: usize = 48 * 1024;
/// OpenCode shows nothing of a tool output line longer than this, and compact
/// JSON is one line (YN-69 S6); collaboration_mcp refuses it such an answer.
pub(crate) const OPENCODE_LINE: usize = 51_200;
/// Said by a peer_read page the store ended early for the budget.
pub(crate) const MAIL_MORE: &str = "This page ends early, at nextAfterSeq, to fit one answer (49152 bytes): peer_read with afterSeq nextAfterSeq reads on";
const HISTORY_MORE: &str = "This page ends early, at nextAfterSeq, to fit one answer (49152 bytes): task_get with view \"activity\" and afterSeq nextAfterSeq reads on";

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
        // The store ends an Agent's mailbox page within one answer, and marks
        // as read only what the page holds (YN-69 S8). An Agent cannot give
        // byteBudget: arguments not in the schema are refused before this.
        "peer_read" => {
            arguments.insert("byteBudget".into(), json!(BUDGET));
            Ok(None)
        }
        // Without keys or part: whole, within the budget (answer).
        "brief_get" => Ok(arguments.get("keys").is_none_or(Value::is_null).then(|| "whole".into())),
        "brief_guide" => Ok(arguments.get("part").is_none_or(Value::is_null).then(|| "whole".into())),
        // Short rows unless the Agent asks for whole ones with compact:false (YN-69).
        "task_list" if !arguments.contains_key("compact") => {
            arguments.insert("compact".into(), json!(true));
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
    } else if tool == "peer_read" {
        mail_within_budget(mailbox(value))
    } else if tool == "task_get" {
        history_within_budget(materials_once(value))
    } else if view == Some("whole") && size(&value) > BUDGET && tool == "brief_get" {
        brief_within_budget(value)
    } else if view == Some("whole") && size(&value) > BUDGET && tool == "brief_guide" {
        guide_within_budget(value)
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

/// A mailbox page as an Agent reads it (YN-69): each message whole, but its
/// delivery is its state alone, not the wake-up's record (Core's, and the
/// GUI's: an Agent's mail problems are task_get's mailProblems); it names no
/// recipient (the reader) and no GUI grouping (notice: its kind, name and
/// status are the sender's and metadata's); a message that starts its own
/// thread and answers none says neither.
fn mailbox(mut page: Value) -> Value {
    for message in page["messages"].as_array_mut().into_iter().flatten() {
        *message = agent_message(message);
    }
    page
}

/// One message as an Agent reads it (see mailbox); the store measures pages by it.
pub(crate) fn agent_message(message: &Value) -> Value {
    let mut message = message.clone();
    let Some(map) = message.as_object_mut() else { return message };
    let state = map.get("delivery").map(|d| d["state"].clone()).unwrap_or(Value::Null);
    map.insert("delivery".into(), json!({"state": state}));
    map.remove("recipient");
    map.remove("notice");
    if map.get("threadId").is_some() && map.get("threadId") == map.get("id") {
        map.remove("threadId");
    }
    if map.get("replyTo").is_some_and(Value::is_null) {
        map.remove("replyTo");
    }
    message
}

/// The bytes of `value` as an Agent reads it: its compact JSON text.
fn size(value: &Value) -> usize {
    value.to_string().len()
}

/// The first `bytes` of `text`, on a character boundary.
fn cut_to(text: &str, bytes: usize) -> &str {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// A mailbox page within one answer (YN-69 S8). The store ends an Agent's
/// page early, at a seq, and marks as read only the messages it returns
/// (collaboration_store peer_read, byteBudget), so no message is dropped
/// here: a page still larger than an answer is one message larger than an
/// answer by itself, whose body is cut, and more says so.
fn mail_within_budget(mut page: Value) -> Value {
    if size(&page) <= BUDGET || page["messages"].as_array().is_none_or(|m| m.len() != 1) {
        return page;
    }
    let mut message = page["messages"][0].clone();
    let body = message["body"].as_str().unwrap_or_default().to_owned();
    let over = size(&page) - BUDGET;
    let kept = cut_to(&body, body.len().saturating_sub(over + 400));
    let left = body[kept.len()..].chars().count();
    message["body"] = json!(format!("{kept}… [{left} more characters: this message is larger than one answer]"));
    page["more"] = json!(format!("Message {} is larger than one answer (49152 bytes) by itself: its body is cut, and the rest of it \
        is not readable through MCP (the app shows it whole). peer_read with afterSeq nextAfterSeq reads on",
        message["id"].as_str().unwrap_or("?")));
    page["messages"] = json!([message]);
    page
}

/// A history page, or a full task, larger than an answer holds (YN-69 S8):
/// the task's own record whole and its activities in order while they fit;
/// nextAfterSeq is the last one shown, and view "activity" pages on. A task
/// whose own record is more than an answer is that record, its history left
/// to view "activity" from its first activity, and says so.
fn history_within_budget(mut answer: Value) -> Value {
    if size(&answer) <= BUDGET || !answer["activities"].is_array() {
        return answer;
    }
    let activities = answer["activities"].as_array().cloned().unwrap_or_default();
    let first = activities.first().and_then(|a| a["seq"].as_i64()).unwrap_or(1);
    answer["activities"] = json!([]);
    answer["hasMore"] = json!(true);
    answer["nextAfterSeq"] = json!(i64::MAX);
    answer["more"] = json!(HISTORY_MORE);
    let base = size(&answer);
    if base > BUDGET {
        answer["nextAfterSeq"] = json!(first - 1);
        answer["more"] = json!(format!("This task's own record is {base} bytes, more than one answer holds (49152): its history is \
            left out. task_get with view \"activity\" and afterSeq {} reads it in pages", first - 1));
        return answer;
    }
    let mut room = BUDGET - base;
    let mut kept = Vec::new();
    for activity in activities {
        let bytes = size(&activity) + 1;
        // One activity larger than an answer by itself is shown alone.
        if bytes > room && !kept.is_empty() {
            break;
        }
        room = room.saturating_sub(bytes);
        kept.push(activity);
    }
    let through = kept.last().and_then(|a| a["seq"].as_i64()).unwrap_or(first - 1);
    answer["activities"] = json!(kept);
    answer["nextAfterSeq"] = json!(through);
    answer
}

/// The refusal an OpenCode Agent gets for an answer it could not see: its
/// size, OpenCode's limit, and how to read it in parts.
pub(crate) fn too_large_for_opencode(tool: &str, bytes: usize) -> String {
    let how = match tool {
        "task_list" => "List short rows with compact:true (the default), or fewer with limit.",
        "review_get" => "Read view \"summary\" (the default).",
        "task_get" => "Read view \"current\", or the history in pages with view \"activity\" (afterSeq, limit); fixed materials \
            this large are for the dispatcher to send in parts.",
        "brief_get" => "Read the index with keys [] and the sections you need with keys [...].",
        "brief_guide" => "Read one part with part.",
        "merge_get" | "merge_list" => "Read view \"summary\" (the default), or fewer with limit.",
        _ => "Read it in parts with this tool's paging (limit, afterSeq or before) or its summary view, as its description says.",
    };
    format!("answer_too_large_for_opencode: this answer is {bytes} bytes of JSON on one line, and OpenCode shows nothing of a \
        tool output line over {OPENCODE_LINE} bytes, so it was not sent. {how}")
}

/// A full task's registered materials once (YN-69): materialsSource says
/// where they are when its value is task.materials; the history stays whole.
fn materials_once(mut answer: Value) -> Value {
    let same = answer["materialsSource"]["value"].is_object() && answer["materialsSource"]["value"] == answer["task"]["materials"];
    if same {
        if let Some(source) = answer["materialsSource"].as_object_mut() {
            source.remove("value");
            source.insert("valueIn".into(), json!("task.materials"));
        }
    }
    answer
}

/// A Brief larger than an answer holds (YN-69 S8): every section's index
/// entry, as brief_get with keys [] lists them, and the caller's own sections
/// whole, newest first, while the answer fits; more names the ones left out.
/// brief_get keys reads any section whole.
fn brief_within_budget(mut brief: Value) -> Value {
    let whole = size(&brief);
    let sections = brief["sections"].as_array().cloned().unwrap_or_default();
    let owned: Vec<String> = brief["you"]["ownsKeys"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    let own: Vec<&str> = owned.iter().map(String::as_str).collect();
    let mut mine: Vec<&Value> = sections.iter().filter(|s| s["key"].as_str().is_some_and(|key| own.contains(&key))).collect();
    mine.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    brief["sections"] = json!([]);
    brief["index"] = sections.iter().map(index_entry).collect();
    // An index that is more than an answer by itself (many sections, long
    // titles) lists each section by key, kind, version, owner and time only.
    let mut compact = false;
    brief["more"] = brief_more(whole, sections.len(), &own, true);
    if size(&brief) > BUDGET {
        compact = true;
        brief["index"] = sections.iter().map(|s| pick(&index_entry(s), &["key", "kind", "version", "updatedAt"])
            .as_object().cloned().map(|mut entry| { entry.insert("owner".into(), json!(s["owner"]["agentId"])); Value::Object(entry) })
            .unwrap_or_default()).collect();
    }
    // Sections are chosen against the longest more there can be (every one
    // of the caller's keys named), so the answer's own more never makes it
    // longer than measured.
    brief["more"] = brief_more(whole, sections.len(), &own, compact);
    let mut room = BUDGET.saturating_sub(size(&brief));
    let mut shown: Vec<Value> = Vec::new();
    let mut left: Vec<&str> = Vec::new();
    for section in mine {
        let bytes = size(section) + 1;
        if bytes <= room {
            room -= bytes;
            shown.push(section.clone());
        } else {
            left.push(section["key"].as_str().unwrap_or_default());
        }
    }
    brief["sections"] = json!(shown);
    brief["more"] = brief_more(whole, sections.len(), &left, compact);
    brief
}

fn brief_more(whole: usize, all: usize, left: &[&str], compact: bool) -> Value {
    let left = if left.is_empty() { String::new() } else { format!("; of your own, these are left out: {}", left.join(", ")) };
    let index = if compact { "index lists all {all} sections by key, kind, version, owner and time only (keys [] lists them whole)" }
        else { "index lists all {all} sections" };
    json!(format!("This Brief is {whole} bytes, more than one answer holds ({BUDGET}): {}, sections holds your own newest \
        that fit{left}. brief_get with keys [...] reads any section whole", index.replace("{all}", &all.to_string())))
}

/// A section's index entry, as sections::index_json lists it for keys [].
fn index_entry(section: &Value) -> Value {
    let mut entry = json!({"key": section["key"], "kind": section["kind"], "title": section["title"], "version": section["version"],
        "owner": section["owner"], "updatedAt": section["updatedAt"], "seen": section["seen"]});
    if section["kind"] == "ask" {
        entry["ask"] = json!({"state": section["ask"]["state"], "repliedAt": section["ask"]["repliedAt"]});
    }
    if section["kind"] == "status" {
        entry["status"] = section["status"].clone();
    }
    if section["time"].is_object() {
        entry["time"] = section["time"].clone();
    }
    entry
}

/// The whole brief_guide when it is more than an answer holds (YN-69 S8): its
/// header and its parts in order while they fit; moreParts names the rest,
/// each of which brief_guide with part reads whole.
fn guide_within_budget(mut answer: Value) -> Value {
    let Some(text) = answer["guide"].as_str().map(str::to_owned) else { return answer };
    let starts: Vec<usize> = text.match_indices("\n## ").map(|(at, _)| at).collect();
    let names: Vec<String> = starts.iter().map(|&at| text[at + 4..].lines().next().unwrap_or_default().trim().to_owned()).collect();
    let mut kept = starts.len();
    loop {
        let end = starts.get(kept).copied().unwrap_or(text.len());
        let rest = &names[kept..];
        answer["guide"] = json!(text[..end]);
        answer["moreParts"] = json!(rest);
        answer["more"] = json!(format!("The whole guide is {} bytes, more than one answer holds ({BUDGET}); \
            brief_guide with part reads each of moreParts whole", text.len()));
        if size(&answer) <= BUDGET || kept == 0 {
            return answer;
        }
        kept -= 1;
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
