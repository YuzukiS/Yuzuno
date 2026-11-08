//! An executor's Overview (T-43 S3, the user's preview): what its session's
//! Overview tab shows, from the records Core already keeps. Its dispatch's
//! materials, its template's steps each with the state its records give,
//! its task's delivery (the PR, its CI and reviews), its own Jobs, the merge
//! entry of its PR, and its newest result. Nothing is decided here beyond
//! reading each step's record: a template's steps are descriptive, and Core
//! keeps no state of them.
use super::{current, dispatch_materials, load_task, task_key, task_number};
use crate::{executor_lifecycle, executor_templates};
use anyhow::Result;
use chrono::{DateTime, FixedOffset};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// How many of its Jobs the Overview lists, newest first.
const JOBS: i64 = 12;

/// What a step's state is read from.
#[derive(Default)]
pub(super) struct Facts {
    /// When it first read its dispatch mail.
    pub read_at: Option<String>,
    /// Each result it handed in on this dispatch, oldest first.
    pub results: Vec<Value>,
    /// Its own Jobs on its task, newest first.
    pub jobs: Vec<Value>,
    /// Its task's PR, as the task's delivery shows it.
    pub pull: Option<Value>,
    /// The merge entry of that PR, newest.
    pub merge: Option<Value>,
    /// It waits for an answer (a request or question pending).
    pub waiting: bool,
    /// Its lifecycle's state (queued, starting, running, delivering, …).
    pub lifecycle: String,
    /// Its own Home Asks for the gates of this task (T-43 S4), oldest
    /// first: {step, projectId, key, version, state (open, replied or
    /// resolved), since, repliedAt}.
    pub asks: Vec<Value>,
}

const RUNNING_JOB: [&str; 5] = ["queued", "waiting", "running", "paused", "waiting_analysis"];
const FAILED_JOB: [&str; 6] = ["failed", "cancelled", "interrupted", "rejected", "unknown", "timed_out"];

fn at(value: &Value) -> Option<DateTime<FixedOffset>> {
    value.as_str().and_then(|text| DateTime::parse_from_rfc3339(text).ok())
}

/// Each step with its state (done, doing, blocked, failed or todo) and the
/// record it was read from, as `ref`.
///
/// A gate ends a stage. The stage after it has begun only once each result
/// asked for before the gate is in (the n-th result step is the n-th result
/// handed in on this dispatch), and its Jobs are those made after the newest
/// of those results; a stage ended by its own result has only the Jobs made
/// before that result (#749 R2: a later stage's Job never changes an earlier
/// stage's step). A stage's records never pass another stage. Materials,
/// work and a gate have no record of their own: each is done once a step
/// after it has begun. The first step not begun is where the executor is:
/// materials, work or a result under way while it runs, a gate or one of
/// those waiting for you while it waits.
pub(super) fn step_states(steps: &[Value], facts: &Facts) -> Vec<Value> {
    let running = matches!(facts.lifecycle.as_str(), "running" | "delivering");
    let pull = facts.pull.as_ref();
    // Each stage's end: the newest result it asked for itself, once that is
    // in; none for the last stage, or one that asked for no result.
    let ends: Vec<Option<DateTime<FixedOffset>>> = {
        let (mut ends, mut asked, mut at_start) = (Vec::new(), 0usize, 0usize);
        for step in steps {
            match step["kind"].as_str() {
                Some("result") => asked += 1,
                Some("gate") => {
                    let own = asked > at_start;
                    ends.push(asked.checked_sub(1).filter(|_| own).and_then(|n| facts.results.get(n)).and_then(|r| at(&r["reportedAt"])));
                    at_start = asked;
                }
                _ => {}
            }
        }
        ends
    };
    let mut stage = 0usize;
    let mut asked = 0usize;
    let mut open = true;
    let mut since: Option<DateTime<FixedOffset>> = None;
    let mut out: Vec<Value> = Vec::with_capacity(steps.len());
    for step in steps {
        let kind = step["kind"].as_str().unwrap_or("");
        if kind == "gate" {
            stage += 1;
            open = open && facts.results.len() >= asked;
            if let Some(result) = asked.checked_sub(1).and_then(|n| facts.results.get(n)) {
                since = at(&result["reportedAt"]).or(since);
            }
        }
        let nth = (kind == "result").then(|| {
            asked += 1;
            asked - 1
        });
        let index = out.len();
        let asked_here: Vec<&Value> = facts.asks.iter().filter(|a| a["step"].as_u64() == Some(index as u64)).collect();
        let (state, reference): (&str, Value) = match kind {
            // A gate the executor asked you about: waiting for you while one
            // of its asks is open, done once each is answered or resolved.
            "gate" if !asked_here.is_empty() => {
                let waiting = asked_here.iter().copied().find(|a| a["state"] == "open");
                let ask = waiting.unwrap_or(asked_here[asked_here.len() - 1]);
                (if waiting.is_some() { "blocked" } else { "done" }, json!({"kind":"ask","projectId":ask["projectId"],"key":ask["key"],
                    "version":ask["version"],"state":ask["state"],"since":ask["since"],"repliedAt":ask["repliedAt"]}))
            }
            _ if !open => ("todo", Value::Null),
            "materials" => match &facts.read_at {
                Some(at) => ("done", json!({"kind":"mail","readAt":at})),
                None => ("todo", Value::Null),
            },
            "result" => match nth.and_then(|n| facts.results.get(n)) {
                Some(r) => ("done", json!({"kind":"result","id":r["id"],"reportedAt":r["reportedAt"]})),
                None => ("todo", Value::Null),
            },
            "job" => {
                let until = ends.get(stage).copied().flatten();
                let within = |job: &&Value| {
                    let made = at(&job["createdAt"]);
                    since.is_none_or(|since| made.is_some_and(|made| made > since)) && until.is_none_or(|until| made.is_some_and(|made| made <= until))
                };
                match facts.jobs.iter().find(within) {
                    None => ("todo", Value::Null),
                    Some(job) => {
                        let status = job["status"].as_str().unwrap_or("");
                        let state = if RUNNING_JOB.contains(&status) {
                            "doing"
                        } else if status == "succeeded" {
                            "done"
                        } else if FAILED_JOB.contains(&status) {
                            "failed"
                        } else {
                            "doing"
                        };
                        (state, json!({"kind":"job","id":job["id"],"name":job["name"],"status":status}))
                    }
                }
            }
            "pr" => match pull {
                Some(p) => ("done", json!({"kind":"pr","number":p["number"],"url":p["url"],"state":p["state"]})),
                None => ("todo", Value::Null),
            },
            "review" => match pull.map(|p| &p["latestReview"]).filter(|r| r.is_object()) {
                None => ("todo", Value::Null),
                Some(review) => {
                    let reference = json!({"kind":"review","id":review["reviewId"],"round":review["round"],
                        "conclusion":review["conclusion"],"forCurrentHead":review["forCurrentHead"]});
                    let current = review["forCurrentHead"] == true;
                    let state = match (review["status"].as_str(), review["conclusion"].as_str()) {
                        (Some("preparing" | "running" | "queued"), _) => "doing",
                        (Some("completed"), Some("no_findings" | "approved_with_notes")) if current => "done",
                        (Some("completed"), Some("changes_requested")) if current => "failed",
                        (Some("failed" | "cancelled"), _) if current => "failed",
                        // A review of an earlier head: this head has none yet.
                        _ => "todo",
                    };
                    (state, reference)
                }
            },
            "ci" => match pull.map(|p| &p["ci"]) {
                None => ("todo", Value::Null),
                Some(ci) => {
                    let state = match ci["state"].as_str() {
                        Some("success") => "done",
                        Some("failure" | "cancelled" | "error") => "failed",
                        Some("pending" | "running" | "queued") => "doing",
                        _ => "todo",
                    };
                    (state, json!({"kind":"ci","state":ci["state"],"headSha":ci["headSha"]}))
                }
            },
            "merge" => {
                let entry = facts.merge.as_ref();
                let state = match entry.and_then(|e| e["state"].as_str()) {
                    Some("merged" | "done") => "done",
                    Some("stopped") => "failed",
                    Some("queued" | "waiting" | "ready" | "merging") => "doing",
                    _ if pull.is_some_and(|p| p["state"] == "merged") => "done",
                    _ => "todo",
                };
                let reference = match entry {
                    Some(e) => json!({"kind":"merge","id":e["id"],"state":e["state"],"reason":e["reason"]}),
                    None if state == "done" => json!({"kind":"pr","number":pull.map(|p| p["number"].clone()),"state":"merged"}),
                    None => Value::Null,
                };
                (state, reference)
            }
            // Work and a gate: settled below, from the steps after them.
            _ => ("todo", Value::Null),
        };
        let mut out_step = step.clone();
        out_step["state"] = json!(state);
        if !reference.is_null() {
            out_step["ref"] = reference;
        }
        out.push(out_step);
    }
    // Materials, work and a gate are done once a step after them has begun
    // (materials whether or not the mail's read was recorded: a dispatch
    // from before reads were kept).
    let begun: Vec<bool> = out.iter().map(|s| s["state"] != "todo").collect();
    for n in 0..out.len() {
        let settles = matches!(out[n]["kind"].as_str(), Some("materials" | "work" | "gate"));
        if settles && out[n]["state"] == "todo" && begun[n + 1..].iter().any(|b| *b) {
            out[n]["state"] = json!("done");
        }
    }
    // Where it is: the first step not begun, unless a gate before it waits
    // for your answer to its ask.
    let asking = |s: &Value| s["state"] == "blocked" && s["ref"]["kind"] == "ask";
    if let Some(step) = out.iter_mut().find(|s| s["state"] == "todo" || asking(s)).filter(|s| !asking(s)) {
        let state = match step["kind"].as_str() {
            Some("gate") if facts.waiting => "blocked",
            Some("materials" | "work" | "result") if facts.waiting => "blocked",
            Some("materials" | "work" | "result") if running => "doing",
            _ => "todo",
        };
        step["state"] = json!(state);
    }
    out
}

/// The steps its executors follow: as its dispatch gave its template, else
/// as its dispatch row kept it, else its delivery mode's (a general
/// executor's, or a dispatch from before templates had steps).
fn steps(db: &Connection, agent: &str, materials: Option<&Value>) -> Result<Vec<Value>> {
    if let Some(steps) = materials.and_then(|m| m["template"]["steps"].as_array()).filter(|s| !s.is_empty()) {
        return Ok(steps.clone());
    }
    let kept: Option<String> = db
        .query_row(
            "SELECT template_json FROM executor_dispatches WHERE agent_id=?1 AND template_json IS NOT NULL ORDER BY rowid DESC LIMIT 1",
            [agent],
            |r| r.get(0),
        )
        .optional()?;
    let kept: Option<Value> = kept.map(|raw| serde_json::from_str(&raw)).transpose()?;
    if let Some(steps) = kept.as_ref().and_then(|t| t["steps"].as_array()).filter(|s| !s.is_empty()) {
        return Ok(steps.clone());
    }
    let delivery = kept
        .as_ref()
        .or(materials.map(|m| &m["template"]))
        .and_then(|t| t["deliveryMode"].as_str())
        .unwrap_or("pr");
    Ok(executor_templates::default_steps(delivery).iter().map(|s| json!(s)).collect())
}

/// When `agent` first read the mail of `dispatch`.
fn read_at(db: &Connection, task: &str, dispatch: &str, agent: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT MIN(r.read_at) FROM collaboration_task_activity a
             JOIN collaboration_messages m ON m.id=json_extract(a.data,'$.messageId')
             JOIN collaboration_message_reads r ON r.message_seq=m.seq AND r.reader_id=?3
             WHERE a.task_id=?1 AND json_extract(a.data,'$.kind')='dispatched' AND json_extract(a.data,'$.dispatch.id')=?2",
            params![task, dispatch, agent],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// Each result handed in on `dispatch`, oldest first: its ID and when.
fn results(db: &Connection, task: &str, dispatch: &str) -> Result<Vec<Value>> {
    let mut query = db.prepare(
        "SELECT json_extract(data,'$.result.id'), json_extract(data,'$.result.reportedAt') FROM collaboration_task_activity
         WHERE task_id=?1 AND json_extract(data,'$.kind')='result' AND json_extract(data,'$.result.dispatchId')=?2 ORDER BY seq",
    )?;
    let rows = query.query_map(params![task, dispatch], |r| Ok(json!({"id":r.get::<_, Option<String>>(0)?,"reportedAt":r.get::<_, Option<String>>(1)?})))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Its own Jobs on its task, newest first, as a summary shows them.
fn jobs(db: &Connection, task: &str, agent: &str) -> Result<Vec<Value>> {
    let mut query = db.prepare("SELECT data FROM local_jobs WHERE task_id=?1 AND agent_id=?2 ORDER BY seq DESC LIMIT ?3")?;
    let rows = query.query_map(params![task, agent, JOBS], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    rows.iter()
        .map(|raw| {
            let job: Value = serde_json::from_str(raw)?;
            Ok(json!({"id":job["id"],"name":job["name"],"status":job["status"],"reason":job["reason"],
                "createdAt":job["createdAt"],"startedAt":job["startedAt"],"finishedAt":job["finishedAt"]}))
        })
        .collect()
}

/// Its own Home Asks for the gates of `task` (T-43 S4, the user's option
/// D), oldest first, each as its newest row says: open, replied, or
/// resolved. An ask names its task by any key it has.
fn gate_asks(db: &Connection, agent: &str, task: &str) -> Result<Vec<Value>> {
    let mut query = db.prepare(
        "SELECT project_id,key,version,live,ask_state,history_reason,COALESCE(ask_since,updated_at),replied_at,
                json_extract(data,'$.ask.gate.taskId'),json_extract(data,'$.ask.gate.step')
         FROM project_brief_sections WHERE owner_id=?1 AND kind='ask' AND json_extract(data,'$.ask.gate.taskId') IS NOT NULL ORDER BY seq",
    )?;
    let rows = query.query_map([agent], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, bool>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, Option<i64>>(9)?,
        ))
    })?;
    let mut asks: Vec<Value> = Vec::new();
    for row in rows {
        let (project, key, version, live, ask_state, history, since, replied, named, step) = row?;
        let Some(step) = step else { continue };
        if named.as_deref().and_then(|named| task_key(db, named).ok()).is_none_or(|(id, _)| id != task) {
            continue;
        }
        let state = match (live, ask_state.as_deref(), history.as_deref()) {
            (true, Some("replied"), _) => "replied",
            (true, Some("resolved"), _) | (false, _, Some("resolved")) => "resolved",
            (true, _, _) => "open",
            // Taken down some other way: no answer of yours.
            (false, _, _) => "removed",
        };
        let ask = json!({"step":step,"projectId":project,"key":key,"version":version,"state":state,"since":since,"repliedAt":replied});
        // Its newest row stands for the key.
        asks.retain(|a| !(a["projectId"] == ask["projectId"] && a["key"] == ask["key"]));
        if state != "removed" {
            asks.push(ask);
        }
    }
    Ok(asks)
}

/// Whether `agent` may ask for the approval of step `step` of `task` (any
/// key it has) with its own Home Ask (T-43 S4): it is the executor of that
/// task's dispatch, and that step of its template is a gate. Err: the
/// problem's code and why.
pub(crate) fn may_ask_gate(db: &Connection, agent: &str, task: &str, step: u64) -> Result<std::result::Result<(), (&'static str, String)>> {
    let id = task_key(db, task).ok().map(|(id, _)| id);
    let role = executor_lifecycle::of(db, agent)?;
    let (Some(id), Some((_, Some(own), dispatch))) = (id, role) else {
        return Ok(Err(("gate_not_yours", format!("You are not the executor of {task}: only a task's executor asks for the approval of its gates."))));
    };
    if own != id {
        return Ok(Err(("gate_not_yours", format!("You are not the executor of {task}: only a task's executor asks for the approval of its gates."))));
    }
    let materials = dispatch.as_deref().and_then(|dispatch| dispatch_materials::read(db, &own, dispatch).ok());
    let steps = steps(db, agent, materials.as_ref())?;
    if usize::try_from(step).ok().and_then(|n| steps.get(n)).is_some_and(|s| s["kind"] == "gate") {
        return Ok(Ok(()));
    }
    let gates: Vec<String> = steps.iter().enumerate().filter(|(_, s)| s["kind"] == "gate").map(|(n, _)| n.to_string()).collect();
    Ok(Err(("gate_step_unknown", match gates.as_slice() {
        [] => format!("Step {step} is not a gate: your template has no gate step."),
        gates => format!("Step {step} is not a gate: steps count from 0, and your template's gates are step {}.", gates.join(", ")),
    })))
}

/// The newest merge entry of `pull`, its repository's and number's.
fn merge(db: &Connection, task: &str, pull: &Value) -> Result<Option<Value>> {
    let (Some(repository), Some(number)) = (pull["repositoryId"].as_i64(), pull["number"].as_i64()) else { return Ok(None) };
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM merge_entries WHERE task_id=?1 AND repository_id=?2 AND number=?3 ORDER BY rowid DESC LIMIT 1",
            params![task, repository, number],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.map(|raw| serde_json::from_str::<Value>(&raw)).transpose()?.map(|e| {
        json!({"id":e["id"],"state":e["state"],"reason":e["reason"],"number":e["number"],"headSha":e["headSha"]})
    }))
}

/// Its task's PR: the open or draft one with the highest number, else the
/// highest-numbered (a sliced task's next PR comes after its merged ones).
fn pull(delivery: &Value) -> Option<Value> {
    let pulls = delivery["pullRequests"].as_array()?;
    let number = |p: &Value| p["number"].as_i64().unwrap_or(0);
    pulls
        .iter()
        .filter(|p| matches!(p["state"].as_str(), Some("open" | "draft")))
        .max_by_key(|p| number(p))
        .or_else(|| pulls.iter().max_by_key(|p| number(p)))
        .cloned()
}

/// The starting materials as the Overview shows them; null when its
/// dispatch kept none (a dispatch from before materials were kept).
fn materials_card(materials: &Value) -> Value {
    let effective = &materials["effective"];
    let repository = materials["repositories"]
        .as_array()
        .and_then(|repos| repos.iter().find(|r| r["id"] == effective["repositoryId"]).or(repos.first()))
        .and_then(|r| r["fullName"].as_str().or(r["name"].as_str()));
    json!({"capturedAt":materials["capturedAt"],"acceptance":effective["acceptance"],"repository":repository,
        "baseSha":effective["baseSha"],"worktree":effective["worktree"],"returnRequirements":effective["returnRequirements"],
        "handoverVersion":materials["handover"]["version"],"contextSummary":materials["contextSummary"]})
}

/// The Overview of `agent`, or None when it is no executor. `waiting`: it
/// waits for an answer now, as its listing says (requests are live state).
pub(crate) fn overview(db: &Connection, agent: &str, waiting: bool) -> Result<Option<Value>> {
    let Some((lifecycle, task, dispatch)) = executor_lifecycle::of(db, agent)? else { return Ok(None) };
    let (Some(task), Some(dispatch)) = (task, dispatch) else {
        return Ok(Some(json!({"agentId":agent,"lifecycle":lifecycle,"task":null,"materials":null,"steps":[],"jobs":[],
            "pullRequest":null,"merge":null,"result":null})));
    };
    let shared = load_task(db, &task)?;
    // Legacy dispatches kept no materials.
    let materials = dispatch_materials::read(db, &task, &dispatch).ok();
    let delivery = current::delivery(db, &task)?;
    let pull = pull(&delivery);
    let merge = pull.as_ref().map(|p| merge(db, &task, p)).transpose()?.flatten();
    let result = shared.result.clone().filter(|r| r["dispatchId"] == dispatch.as_str());
    let facts = Facts {
        read_at: read_at(db, &task, &dispatch, agent)?,
        results: results(db, &task, &dispatch)?,
        jobs: jobs(db, &task, agent)?,
        pull: pull.clone(),
        merge: merge.clone(),
        waiting,
        lifecycle: lifecycle["state"].as_str().unwrap_or("").to_owned(),
        asks: gate_asks(db, agent, &task)?,
    };
    let steps = step_states(&steps(db, agent, materials.as_ref())?, &facts);
    let template = materials.as_ref().map(|m| &m["template"]).filter(|t| t.is_object());
    Ok(Some(json!({
        "agentId": agent,
        "lifecycle": lifecycle,
        "task": {"id": task_number(db, &task)?, "title": shared.title, "status": shared.status},
        "template": template.map(|t| json!({"id":t["id"],"label":t["label"],"deliveryMode":t["deliveryMode"]})),
        "materials": materials.as_ref().map(materials_card),
        "steps": steps,
        "jobs": facts.jobs,
        "pullRequest": pull,
        "merge": merge,
        "result": result.map(|r| json!({"id":r["id"],"summary":r["summary"],"reportedAt":r["reportedAt"],"status":r["status"],"links":r["links"]})),
    })))
}

#[cfg(test)]
#[path = "executor_overview_tests.rs"]
mod tests;
