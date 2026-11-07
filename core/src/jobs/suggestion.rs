//! A request suggested from what earlier runs of the same Job used (T-38 C;
//! YN-6 S2).
//!
//! The same Job is, closest first: this task's Jobs with the same name or the
//! same argv; and only when those give no suggestion, the Jobs of this task's
//! Project with the same argv. cwd, env and name are not compared across
//! tasks: the working directory is each task's own tree, and a name is free
//! text. Never another Project's Jobs, and a task without a Project has only
//! its own.
//!
//! Their newest runs with a complete worker measurement (resource_summary),
//! up to five, count, and only when one of them succeeded: an early failure's
//! peak can be far below what the Job needs. The largest peak among them (a
//! failed or cancelled run needed at least what it reached) gives the memory:
//! the larger of 1.3 × it and it + 1 GiB, rounded up to 512 MiB, the rule
//! executors declare by; the largest average CPU cores × 1.5, rounded up to
//! 100 mCPU, gives the CPU. A run killed at its memory limit is marked.
//!
//! A Job keeps the suggestion it was submitted with (`suggestion`, null with
//! none), with what its own request is beside it (`request`). job_submit and
//! job_run_submit answer with it, job_suggestion and the submit form read one
//! before submitting. It is only shown: nothing changes a Job's request. An
//! Agent sees another Agent's Jobs in it by their numbers and IDs only, never
//! their name, argv, environment or working directory. Remote runs are not
//! measured here, so they do not count.
use super::resource_summary;
use crate::{collaboration_store as collaboration, store::Store, workspace::Workspace};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// The newest Jobs of a task read for a suggestion.
const SCAN: i64 = 50;
/// The newest Jobs of the task's Project read when the task gives none.
const PROJECT_SCAN: i64 = 500;
/// The measured runs, newest first, a suggestion is based on.
const RUNS: usize = 5;
/// A request this many times the suggested memory, and at least
/// `FAR_ABOVE_MIB` more, is far above it.
const FAR_ABOVE: f64 = 1.5;
const FAR_ABOVE_MIB: u64 = 1024;

/// One submission a suggestion is for.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Query {
    pub task_id: String,
    pub name: String,
    #[serde(default)]
    pub argv: Vec<String>,
}

impl Store {
    /// The suggestion for a submission like `query`, as the user sees it;
    /// Null without one. Jobs of `except` (a Job ID, or a run ID for its
    /// stages) are not counted.
    pub(super) fn resource_suggestion(&self, query: &Query, except: Option<&str>) -> Result<Value> {
        read(&*self.db.read()?, query, None, except)
    }
    /// The same for `actor` (None: the user): another Agent's Jobs in it by
    /// their numbers and IDs only.
    pub(super) fn resource_suggestion_for(&self, query: &Query, actor: Option<&str>) -> Result<Value> {
        read(&*self.db.read()?, query, actor, None)
    }
}

/// The suggestion for a submission like `query` by `actor` (None: the user),
/// read in `db` (the caller's transaction at submission); Null without one.
/// Jobs of `except` are not counted.
pub(super) fn read(db: &Connection, query: &Query, actor: Option<&str>, except: Option<&str>) -> Result<Value> {
    // An unknown task has no history.
    let Ok((task, _)) = collaboration::task_key(db, &query.task_id) else {
        return Ok(Value::Null);
    };
    let own = |job: &Value| except.is_some_and(|id| job["id"] == id || job["run"]["id"] == id);
    let argv = (!query.argv.is_empty()).then(|| json!(query.argv));
    let mut runs = Vec::new();
    {
        let mut q = db.prepare_cached("SELECT data FROM local_jobs WHERE task_id=?1 ORDER BY seq DESC LIMIT ?2")?;
        for row in q.query_map(rusqlite::params![task, SCAN], |r| r.get::<_, String>(0))? {
            let job: Value = serde_json::from_str(&row?)?;
            let same = job["name"] == query.name.as_str() || argv.as_ref().is_some_and(|argv| &job["argv"] == argv);
            if own(&job) || !same {
                continue;
            }
            if let Some(run) = measured(&job, actor) {
                runs.push(run);
                if runs.len() == RUNS {
                    break;
                }
            }
        }
    }
    let suggestion = suggest_in(runs, "task");
    let Some(argv) = argv.filter(|_| suggestion.is_null()) else {
        return Ok(suggestion);
    };
    // Else this task's Project: the same argv in its other tasks.
    let project: Option<String> = db
        .query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task], |r| r.get(0))
        .optional()?;
    let Some(project) = project else {
        return Ok(Value::Null);
    };
    let mut runs = Vec::new();
    let mut q = db.prepare_cached(
        "SELECT j.data FROM local_jobs j JOIN project_tasks pt ON pt.task_id=j.task_id
         WHERE pt.project_id=?1 AND j.task_id<>?2 ORDER BY j.seq DESC LIMIT ?3",
    )?;
    for row in q.query_map(rusqlite::params![project, task, PROJECT_SCAN], |r| r.get::<_, String>(0))? {
        let job: Value = serde_json::from_str(&row?)?;
        if own(&job) || job["argv"] != argv {
            continue;
        }
        if let Some(run) = measured(&job, actor) {
            runs.push(run);
            if runs.len() == RUNS {
                break;
            }
        }
    }
    Ok(suggest_in(runs, "project"))
}

/// A Job's run as a suggestion counts it, if its worker was measured whole:
/// its ID, task, ending and numbers, and its name only for `actor`'s own Job
/// (or for the user).
fn measured(job: &Value, actor: Option<&str>) -> Option<Value> {
    let summary = resource_summary::attempt(job);
    if summary["measurement"] != "complete" {
        return None;
    }
    let mut run = json!({"jobId":job["id"],"taskRef":job["taskRef"],"status":job["status"],"finishedAt":job["finishedAt"],
        "memoryPeakMiB":summary["actual"]["memoryPeakMiB"],"averageCpuCores":summary["actual"]["averageCpuCores"]});
    if actor.is_none_or(|actor| job["agentId"] == actor) {
        run["name"] = job["name"].clone();
    }
    if job["result"]["evidence"]["systemd"]["Result"] == "oom-kill" {
        run["hitMemoryLimit"] = json!(true);
    }
    Some(run)
}

/// The suggestion from this task's measured runs (newest first); Null without
/// any, or without a succeeded one among them.
#[cfg(test)]
pub(super) fn suggest(runs: Vec<Value>) -> Value {
    suggest_in(runs, "task")
}

/// The suggestion from measured runs (newest first) of `scope`, `task` or
/// `project`; Null without any, or without a succeeded one among them.
fn suggest_in(runs: Vec<Value>, scope: &str) -> Value {
    if !runs.iter().any(|r| r["status"] == "succeeded") {
        return Value::Null;
    }
    let largest = |key: &str| runs.iter().filter_map(|r| r[key].as_f64()).reduce(f64::max);
    let Some(peak) = largest("memoryPeakMiB") else {
        return Value::Null;
    };
    let cores = largest("averageCpuCores");
    let count = runs.len();
    let memory = (up_to((peak * 1.3).max(peak + 1024.0), 512.0) as u64).max(1024);
    let cpu = cores.map(|c| (up_to(c * 1.5 * 1000.0, 100.0) as u64).max(100));
    let limit = runs.iter().any(|r| r["hitMemoryLimit"] == true);
    let (whose, same) = if scope == "project" {
        ("This Project's other tasks'", "the same command")
    } else {
        ("This task's", "the same name or command")
    };
    let cpu_note = match (cores, cpu) {
        (Some(c), Some(m)) => format!(" Their largest average was {c:.2} CPU cores; half again as much, rounded up to 100 mCPU, is {m} mCPU."),
        _ => String::new(),
    };
    let limit_note = if limit { " One of them was killed at its memory limit, so it needed more than it had." } else { "" };
    json!({
        "memoryMiB": memory,
        "cpuMillis": cpu,
        "memoryPeakMiB": peak,
        "averageCpuCores": cores,
        "scope": scope,
        "hitMemoryLimit": limit,
        "basedOn": runs,
        "note": format!("A suggestion only; nothing was changed. {whose} {count} newest measured run(s) of {same} (at least one succeeded) peaked at {peak:.0} MiB RAM; the larger of 1.3 × that and that + 1 GiB, rounded up to 512 MiB, is {memory} MiB.{cpu_note}{limit_note}"),
    })
}

/// `suggestion` with what a request of `asked` MiB is beside it: far above
/// it, below the peak it is based on, or within.
pub(super) fn with_request(mut suggestion: Value, asked: u64) -> Value {
    let (Some(memory), Some(peak)) = (suggestion["memoryMiB"].as_u64(), suggestion["memoryPeakMiB"].as_f64()) else {
        return suggestion;
    };
    let (verdict, advice) = if asked as f64 > memory as f64 * FAR_ABOVE && asked >= memory + FAR_ABOVE_MIB {
        ("far_above", Some(format!("This Job asks for {asked} MiB, more than 1.5 × the {memory} MiB suggested, and holds all of it in the shared budget while it waits and runs. Nothing was changed: to ask less, cancel it and submit again, or lower it with job_lower_memory once it runs.")))
    } else if (asked as f64) < peak {
        ("below_peak", Some(format!("This Job asks for {asked} MiB, less than the {peak:.0} MiB the same Job peaked at: it may be killed at its memory limit. Nothing was changed.")))
    } else {
        ("within", None)
    };
    suggestion["request"] = json!({"memoryMiB": asked, "verdict": verdict, "advice": advice});
    suggestion
}

/// `value` rounded up to a multiple of `step`, ignoring float noise below a
/// thousandth (2.2 cores × 1.5 × 1000 is 3300.0000000000005).
fn up_to(value: f64, step: f64) -> f64 {
    ((value * 1000.0).round() / 1000.0 / step).ceil() * step
}

/// What a new Job keeps as `suggestion`, read in its insert transaction: the
/// suggestion for its submission by `actor`, with its own request beside
/// it; Null without one.
pub(super) fn for_job(db: &Connection, query: &Query, actor: Option<&str>, memory_mib: u64) -> Result<Value> {
    let suggestion = read(db, query, actor, None)?;
    Ok(if suggestion.is_null() { suggestion } else { with_request(suggestion, memory_mib) })
}

/// `answer` (a Job) with the suggestion it was submitted with. A Job kept
/// one when it was created; one created before that (no `suggestion` key)
/// gets it read now, beside the answer. A failed read leaves it out: the
/// submission itself has already happened.
pub(super) async fn beside(ws: &Arc<Workspace>, mut answer: Value, query: Query) -> Value {
    if answer.get("suggestion").is_some() {
        if answer["suggestion"].is_null() {
            if let Some(fields) = answer.as_object_mut() {
                fields.remove("suggestion");
            }
        }
        return answer;
    }
    let except = answer["id"].as_str().map(str::to_owned);
    let asked = answer["resources"]["memoryMiB"].as_u64();
    if let Ok(suggestion) = ws.stored(move |s| s.resource_suggestion(&query, except.as_deref())).await {
        if !suggestion.is_null() {
            answer["suggestion"] = match asked {
                Some(asked) => with_request(suggestion, asked),
                None => suggestion,
            };
        }
    }
    answer
}

/// A run's answer with a suggestion for each stage that has one: the one the
/// run kept for that stage when it was created, or for a run created before
/// that, read now.
pub(super) async fn beside_run(ws: &Arc<Workspace>, mut run: Value, stages: Vec<(String, Query)>) -> Value {
    let except = run["id"].as_str().map(str::to_owned);
    let mut out = Vec::new();
    for (stage, query) in stages {
        let kept = run["stages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["key"] == stage.as_str())
            .filter(|s| s.get("suggestion").is_some())
            .map(|s| s["suggestion"].clone());
        let suggestion = match kept {
            Some(kept) => kept,
            None => {
                let except = except.clone();
                match ws.stored(move |s| s.resource_suggestion(&query, except.as_deref())).await {
                    Ok(suggestion) => suggestion,
                    Err(_) => Value::Null,
                }
            }
        };
        if !suggestion.is_null() {
            let mut suggestion = suggestion;
            suggestion["stage"] = json!(stage);
            out.push(suggestion);
        }
    }
    if !out.is_empty() {
        run["suggestions"] = json!(out);
    }
    run
}
