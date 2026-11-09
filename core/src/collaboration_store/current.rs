//! A task as an Agent needs it to decide what to do now (T-153): its state,
//! version, the identities it acts with, a short result and the delivery that
//! is current, read without going through its history. History is a page of
//! activities on request; the whole record stays `view: "full"`. Each row
//! keeps what decides now and leaves out what is empty or said elsewhere
//! (YN-69): a merged or closed PR is a short row, github_links has it whole.
use super::{dispatch_materials, task_number, SharedTask};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// Longer text is cut here, and the reply says so and where the whole is.
const TEXT: usize = 1500;
/// The newest CI subscriptions of the task shown in its delivery.
const SUBSCRIPTIONS: i64 = 6;
/// The queries of the current view, each read through an index (see
/// current_tests.rs): none reads the task's history or other tasks' records.
pub(super) const LATEST_ACTIVITY: &str = "SELECT data FROM collaboration_task_activity WHERE task_id=?1 ORDER BY seq DESC LIMIT 1";
pub(super) const LATEST_REVIEW: &str = "SELECT data FROM pr_reviews WHERE task_id=?1 AND link_id=?2 ORDER BY rowid DESC LIMIT 1";
/// A review records the harness it started (actualHarness) once a reviewer
/// runs; one that failed while preparing (a wrong fixed base, say) has none.
pub(super) const LATEST_REVIEWER_RUN: &str = "SELECT data FROM pr_reviews WHERE task_id=?1 AND link_id=?2 AND json_extract(data,'$.actualHarness') IS NOT NULL ORDER BY rowid DESC LIMIT 1";
pub(super) const REVIEW_COUNTS: &str = "SELECT COUNT(*),COUNT(json_extract(data,'$.actualHarness')) FROM pr_reviews WHERE task_id=?1 AND link_id=?2";
pub(super) const NEWEST_SUBSCRIPTIONS: &str = "SELECT id,watch_id FROM ci_subscriptions WHERE task_id=?1 ORDER BY rowid DESC LIMIT ?2";
pub(super) const SUBSCRIPTION_COUNT: &str = "SELECT COUNT(*) FROM ci_subscriptions WHERE task_id=?1";
// CROSS JOIN keeps the watch's own runs the outer loop: never every run's.
pub(super) const LATEST_RUN: &str = "SELECT r.data FROM ci_watch_runs w CROSS JOIN ci_runs r ON r.id=w.run_id WHERE w.watch_id=?1 ORDER BY r.seq DESC LIMIT 1";
/// The result mail's delivery now, by its unique id (T-203).
pub(super) const MESSAGE_STATE: &str = "SELECT delivery_state FROM collaboration_messages WHERE id=?1";
/// A result is a report as it was submitted; what happened to the task after it
/// is the rest of the view (T-203).
const RESULT_NOTE: &str = "The latest result as reported at reportedAt, never rewritten: statusAtReport and \
    taskVersionAtReport are the task's then, editsSinceReport the saved task versions since (null: not recorded), \
    notification the mail's state then and notificationNow now; status, progress and blocker are the task now. \
    task_result_get reads the whole report";
/// Said once for every PR and watch of the delivery (YN-69: it was each PR's ci.source).
const DELIVERY_NOTE: &str = "Read from Core's records, each with the time Core observed it (observedAt; lastAttemptAt \
    and error only after a refresh failed). A PR's ci is all of this head's checks as GitHub reported them when Core \
    last read the PR (github_refresh reads them again); its watchedRuns are single workflow runs on its head, not all \
    of its checks. Merged and closed PRs are short rows: github_links has each whole. Unknown, stale or unobserved is \
    not passing; nothing here merges, approves or completes anything";
const MORE: &str = "task_get view \"activity\" (afterSeq, limit) pages the history; view \"full\" is the whole record with \
    executions and materials; dispatchId reads the fixed materials; review_get reads a review; github_links reads \
    each linked PR whole";

/// `text`, or its first TEXT characters and a note of what was left out.
fn short(text: &str) -> Value {
    match text.char_indices().nth(TEXT) {
        None => json!(text),
        Some((cut, _)) => json!(format!("{}… [{} more characters: view \"full\"]", &text[..cut], text[cut..].chars().count())),
    }
}

/// `value` without its null fields: an empty field says nothing (YN-69).
fn present(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.retain(|_, v| !v.is_null());
    }
    value
}

/// A PR that is merged or closed: there is nothing left to decide on it.
fn finished(state: &Value) -> bool {
    matches!(state.as_str(), Some("merged" | "closed"))
}

fn actor(value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    json!({"kind": value["kind"], "id": value["id"], "name": value["name"]})
}

/// The current view. Its reads are the task row, the newest activity (by
/// index), the PR links, each link's newest review and the newest CI
/// subscriptions with their newest run: none grows with the task's history.
pub(super) fn current(db: &Connection, task: &SharedTask) -> Result<Value> {
    let latest: Option<String> = db
        .query_row(LATEST_ACTIVITY, [&task.id],
            |r| r.get(0),
        )
        .optional()?;
    let latest = latest.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()?.map(|a| {
        json!({"seq": a["seq"], "kind": a["kind"], "at": a["at"], "actor": a["actor"]["name"]})
    });
    let task_value = serde_json::to_value(task)?;
    let dispatch = task_value.get("dispatch").filter(|d| !d.is_null()).map(|d| {
        json!({"id": d["id"], "active": d["active"], "dispatchedAt": d["dispatchedAt"],
            "executor": actor(&d["executor"]), "requestedBy": actor(&d["requestedBy"]),
            "invalidatedAt": d["invalidatedAt"], "invalidatedReason": d["invalidatedReason"]})
    });
    let result = match task.result.as_ref() {
        None => None,
        Some(r) => {
            let delivery: Option<String> = match r["notification"]["messageId"].as_str() {
                Some(id) => db.query_row(MESSAGE_STATE, [id], |row| row.get(0)).optional()?,
                None => None,
            };
            Some(json!({"id": r["id"], "dispatchId": r["dispatchId"], "reportedAt": r["reportedAt"],
                "reportedBy": actor(&r["reportedBy"]), "summary": short(r["summary"].as_str().unwrap_or_default()),
                "links": r["links"], "notification": r["notification"]["state"], "notificationNow": delivery,
                "statusAtReport": r["status"], "taskVersionAtReport": r["taskVersion"],
                "editsSinceReport": r["taskVersion"].as_i64().map(|v| task.version - v), "note": RESULT_NOTE}))
        }
    };
    let project = crate::projects::task_projects(db, &[task.id.as_str()])?.remove(&task.id);
    let mut view = json!({"current": {
        "taskId": task_number(db, &task.id)?,
        "title": task.title,
        "shortName": task.short_name,
        "status": task.status,
        "version": task.version,
        "projectId": project,
        "assignee": task.assignee.as_ref().map(|a| json!({"kind": a.kind, "id": a.id, "name": a.name})),
        "progress": short(&task.progress),
        "blocker": short(&task.blocker),
        "archivedAt": task.archived_at,
        "updatedAt": task.updated_at,
        "updatedBy": task.updated_by.name,
        "dispatch": dispatch,
        "materialsRegistered": !dispatch_materials::registered(db, &task.id)?.is_null(),
        "result": result,
        "latestActivity": latest,
        "delivery": delivery(db, &task.id)?,
        // Its mail whose wake-up failed, is tried again or is uncertain (T-50).
        "mailProblems": super::mail_delivery::task_problems(db, &task.id, super::MAIL_PROBLEMS)?,
        "more": MORE,
    }});
    // Its executor's slot, when it holds or waits for one (T-35).
    if let Some(mut slot) = crate::executor_slots::views(db, &[task.id.as_str()])?.remove(&task.id) {
        if slot["route"].is_object() {
            slot["route"] = route(&slot["route"]);
        }
        view["current"]["executorSlot"] = slot;
    }
    Ok(view)
}

/// Routing's record (YN-34) as an Agent decides with it: the candidate chosen,
/// with which account, and each candidate's state and reasons. The Chinese
/// texts, readings and per-candidate account lists stay in the record, which
/// the GUI and view "full" read (YN-69).
fn route(route: &Value) -> Value {
    let mut out = route.clone();
    if let Some(candidates) = route["candidates"].as_array() {
        out["candidates"] = candidates.iter().map(|c| {
            let mut row = present(json!({"id": c["id"], "label": c["label"], "harness": c["harness"], "model": c["model"],
                "state": c["state"]}));
            let reasons: Vec<Value> = c["reasons"].as_array().into_iter().flatten()
                .map(|r| present(json!({"code": r["code"], "message": r["message"], "params": r["params"]}))).collect();
            if !reasons.is_empty() {
                row["reasons"] = json!(reasons);
            }
            row
        }).collect();
    }
    out
}

/// One page of the task's history, oldest first after `after`, read through
/// the (task_id, seq) index: a stable cursor that nothing written later moves.
pub(super) fn activity(db: &Connection, task: &SharedTask, after: i64, limit: i64) -> Result<Value> {
    let mut q = db.prepare(
        "SELECT data FROM collaboration_task_activity WHERE task_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
    )?;
    let mut activities = q
        .query_map(params![task.id, after, limit + 1], |r| r.get::<_, String>(0))?
        .map(|raw| Ok(serde_json::from_str::<Value>(&raw?)?))
        .collect::<Result<Vec<_>>>()?;
    let has_more = activities.len() as i64 > limit;
    activities.truncate(limit as usize);
    let next = activities.last().and_then(|a| a["seq"].as_i64()).unwrap_or(after);
    Ok(json!({"taskId": task_number(db, &task.id)?, "version": task.version, "activities": activities,
        "nextAfterSeq": next, "hasMore": has_more}))
}

/// What is current about delivering the task, from the records Core already
/// keeps: each linked PR's fixed head and base with that head's CI as last
/// observed, the newest review of the link, and the newest CI subscriptions
/// with the newest run each one saw. Nothing is decided here; an unknown,
/// stale or unobserved state is shown as it is.
pub(super) fn delivery(db: &Connection, task: &str) -> Result<Value> {
    let links = crate::github::store::task_summaries(db, &[task])?.remove(task).unwrap_or_default();
    let mut pulls = Vec::new();
    let mut issues = Vec::new();
    for link in &links {
        let snapshot = &link["snapshot"];
        if link["kind"] != "pull" {
            issues.push(json!({"repository": link["repository"], "number": link["number"], "state": snapshot["state"]}));
            continue;
        }
        let head = snapshot["headSha"].clone();
        let link_id = link["id"].as_str().unwrap_or_default();
        let read = |sql: &str| -> Result<Option<Value>> {
            let raw: Option<String> = db.query_row(sql, params![task, link_id], |r| r.get(0)).optional()?;
            Ok(raw.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()?)
        };
        let latest = read(LATEST_REVIEW)?;
        if finished(&snapshot["state"]) {
            let mut row = present(json!({"linkId": link["id"], "number": link["number"], "url": link["url"],
                "title": snapshot["title"], "state": snapshot["state"], "headSha": head}));
            if let Some(r) = &latest {
                row["latestReview"] = json!({"reviewId": r["id"], "conclusion": r["conclusion"],
                    "forCurrentHead": !head.is_null() && r["headSha"] == head});
            }
            pulls.push(row);
            continue;
        }
        let ci = &snapshot["ci"];
        // A CI state of another commit says nothing about this head.
        let ci = if ci.is_null() {
            json!({"state": "unknown", "note": "not observed"})
        } else if ci["headSha"] != head {
            present(json!({"state": "unknown", "note": "last observed for another commit", "headSha": ci["headSha"],
                "observedAt": ci["observedAt"]}))
        } else {
            present(json!({"state": ci["state"], "complete": ci["complete"], "headSha": ci["headSha"], "observedAt": ci["observedAt"]}))
        };
        // Round numbers count every attempt; reviewerRuns counts those that
        // started a reviewer. When the newest attempt never started one, the
        // newest that did is shown beside it: a failed preparation is not a
        // round of review, and does not hide the one before it.
        let (attempts, runs): (i64, i64) =
            db.query_row(REVIEW_COUNTS, params![task, link_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let earlier = match &latest {
            Some(r) if r["actualHarness"].is_null() && runs > 0 => Some(read(LATEST_REVIEWER_RUN)?),
            Some(r) if r["actualHarness"].is_null() => Some(None),
            _ => None,
        };
        let mut row = json!({"linkId": link["id"], "repositoryId": link["repositoryId"], "repository": link["repository"], "number": link["number"],
            "url": link["url"], "title": snapshot["title"], "state": snapshot["state"], "headSha": head,
            "baseSha": snapshot["baseSha"], "baseBranch": snapshot["baseBranch"],
            // Its diff's size as GitHub counted it at observedAt; left out before Core read it (T-43 S3).
            "changes": snapshot["changes"],
            // When Core read the PR from GitHub, not the PR's own updated_at; a
            // failed refresh sets error and the attempt's time, never observedAt.
            "observedAt": snapshot["observedAt"], "stale": link["stale"], "error": link["error"], "ci": ci,
            "reviews": {"attempts": attempts, "reviewerRuns": runs},
            "latestReview": latest.as_ref().map(|r| review(r, &head))});
        if !link["error"].is_null() {
            row["lastAttemptAt"] = link["lastAttemptAt"].clone();
        }
        pulls.push(present(row));
        if let Some(earlier) = earlier {
            pulls.last_mut().unwrap()["latestReviewerRun"] = json!(earlier.as_ref().map(|r| review(r, &head)));
        }
    }
    let mut q = db.prepare(NEWEST_SUBSCRIPTIONS)?;
    let rows = q
        .query_map(params![task, SUBSCRIPTIONS], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut subscriptions = Vec::new();
    // Each shown watch's newest run as recorded, for the PRs' watchedRuns.
    let mut runs_seen: Vec<Value> = Vec::new();
    for (id, watch) in rows {
        let sub = crate::ci_monitor::store::subscription(db, &id)?;
        let run: Option<String> = db
            .query_row(LATEST_RUN, [&watch],
                |r| r.get(0),
            )
            .optional()?;
        let run = run.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()?;
        let w = &sub["watch"];
        subscriptions.push(present(json!({"subscriptionId": id, "agent": sub["agent"]["name"], "active": sub["active"],
            "closure": sub["closure"]["reason"], "expiresAt": sub["expiresAt"],
            "watch": present(json!({"kind": w["kind"], "number": w["number"], "branch": w["branch"], "event": w["event"],
                "expectedSha": w["expectedSha"], "currentHeadSha": w["currentHeadSha"], "state": w["state"],
                "observedAt": w["observedAt"], "error": w["error"], "url": w["url"]})),
            // Its newest run: its repository, branch, event and attempt are the
            // watch's and its url's (YN-69); its head is said, never inferred.
            "latestRun": run.as_ref().map(|r| present(json!({"runKey": r["id"], "name": r["name"], "status": r["status"],
                "conclusion": r["conclusion"], "headSha": r["headSha"], "observedAt": r["observedAt"], "url": r["url"]})))})));
        runs_seen.extend(run);
    }
    // What this task's CI watches saw on a PR's head, beside its checks and
    // never in their place: one workflow's run is not every check of the PR.
    // A run belongs to a PR only in the PR's own repository: the same commit
    // can be the head of an upstream PR and of its fork's (the repository the
    // run ran in, not a fork's head repository).
    for pull in pulls.iter_mut().filter(|pull| !finished(&pull["state"])) {
        let mut runs: Vec<Value> = Vec::new();
        for run in &runs_seen {
            if !pull["headSha"].is_null() && run["headSha"] == pull["headSha"]
                && !pull["repositoryId"].is_null() && run["repositoryId"] == pull["repositoryId"]
                && !runs.iter().any(|seen| seen["runKey"] == run["id"]) {
                runs.push(json!({"runKey": run["id"], "name": run["name"], "status": run["status"],
                    "conclusion": run["conclusion"], "attempt": run["attempt"], "observedAt": run["observedAt"]}));
            }
        }
        pull["watchedRuns"] = json!(runs);
    }
    let more: i64 = db.query_row(SUBSCRIPTION_COUNT, [task], |r| r.get(0))?;
    Ok(json!({"pullRequests": pulls, "issues": issues, "ciSubscriptions": subscriptions,
        "ciSubscriptionsShown": format!("{} newest of {more}", subscriptions.len()),
        "note": DELIVERY_NOTE}))
}

/// A review as the delivery summary shows it: what it concluded on which
/// head, whether a reviewer ran at all, and its findings by priority.
fn review(r: &Value, head: &Value) -> Value {
    let mut findings = serde_json::Map::new();
    for finding in r["findings"].as_array().into_iter().flatten() {
        let key = format!("P{}", finding["priority"].as_i64().unwrap_or(-1));
        let count = findings.get(&key).and_then(Value::as_i64).unwrap_or(0) + 1;
        findings.insert(key, json!(count));
    }
    // Which harness and model reviewed are review_get's (YN-69); an
    // acknowledgement that paths stay unreviewed is shown when it was made.
    present(json!({"reviewId": r["id"], "round": r["round"], "status": r["status"], "conclusion": r["conclusion"],
        "reviewerStarted": r.get("actualHarness").map(|h| !h.is_null()), "error": r["error"].as_str().map(short),
        "headSha": r["headSha"], "baseSha": r["baseSha"], "forCurrentHead": !head.is_null() && r["headSha"] == *head,
        "findings": findings, "scopeCounts": r["scope"]["counts"], "contextIncomplete": r["contextIncomplete"],
        "acknowledgedUnreviewable": r["acknowledgedUnreviewable"].as_bool().filter(|a| *a), "finishedAt": r["finishedAt"]}))
}

#[cfg(test)]
#[path = "current_tests.rs"]
mod tests;
