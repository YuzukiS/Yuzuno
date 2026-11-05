//! A request suggested from what earlier runs used (T-38 C).
//!
//! When a task has run the same Job before (the same name, or the same argv),
//! its newest runs with a complete worker measurement (resource_summary)
//! suggest a request: the largest peak memory × 1.5, rounded up to 512 MiB and
//! at least 1 GiB; the largest average CPU cores × 1.5, rounded up to 100 mCPU.
//! It is shown beside job_submit and job_run_submit answers and in the submit
//! form, and only shown: nothing changes a Job's request. Without such a run
//! there is no suggestion. Remote runs are not measured here, so they do not
//! count.
use super::resource_summary;
use crate::{collaboration_store as collaboration, store::Store, workspace::Workspace};
use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// The newest Jobs of a task read for a suggestion.
const SCAN: i64 = 50;
/// The measured runs, newest first, a suggestion is based on.
const RUNS: usize = 5;

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
    /// The suggestion for a submission like `query`, from its task's newest
    /// measured runs with the same name or argv; Null without one. Jobs of
    /// `except` (a Job ID, or a run ID for its stages) are not counted.
    pub(super) fn resource_suggestion(&self, query: &Query, except: Option<&str>) -> Result<Value> {
        let db = self.db.read()?;
        // An unknown task has no history.
        let Ok((task, _)) = collaboration::task_key(&db, &query.task_id) else {
            return Ok(Value::Null);
        };
        let mut q = db.prepare_cached("SELECT data FROM local_jobs WHERE task_id=?1 ORDER BY seq DESC LIMIT ?2")?;
        let mut runs = Vec::new();
        for row in q.query_map(rusqlite::params![task, SCAN], |r| r.get::<_, String>(0))? {
            let job: Value = serde_json::from_str(&row?)?;
            let own = except.is_some_and(|id| job["id"] == id || job["run"]["id"] == id);
            let same = job["name"] == query.name.as_str() || (!query.argv.is_empty() && job["argv"] == json!(query.argv));
            if own || !same {
                continue;
            }
            let summary = resource_summary::attempt(&job);
            if summary["measurement"] == "complete" {
                runs.push(json!({"jobId":job["id"],"name":job["name"],"status":job["status"],"finishedAt":job["finishedAt"],
                    "memoryPeakMiB":summary["actual"]["memoryPeakMiB"],"averageCpuCores":summary["actual"]["averageCpuCores"]}));
                if runs.len() == RUNS {
                    break;
                }
            }
        }
        Ok(suggest(runs))
    }
}

/// The suggestion from measured runs (newest first); Null without any.
pub(super) fn suggest(runs: Vec<Value>) -> Value {
    let largest = |key: &str| runs.iter().filter_map(|r| r[key].as_f64()).reduce(f64::max);
    let Some(peak) = largest("memoryPeakMiB") else {
        return Value::Null;
    };
    let cores = largest("averageCpuCores");
    let count = runs.len();
    let memory = (up_to(peak * 1.5, 512.0) as u64).max(1024);
    let cpu = cores.map(|c| (up_to(c * 1.5 * 1000.0, 100.0) as u64).max(100));
    let (used, asked) = match (cores, cpu) {
        (Some(c), Some(m)) => (format!(" RAM and {c:.2} average CPU cores"), format!("{memory} MiB RAM and {m} mCPU")),
        _ => (" RAM".to_owned(), format!("{memory} MiB RAM")),
    };
    json!({
        "memoryMiB": memory,
        "cpuMillis": cpu,
        "memoryPeakMiB": peak,
        "averageCpuCores": cores,
        "basedOn": runs,
        "note": format!("A suggestion only; nothing was changed. This task's {} newest measured run(s) with the same name or command peaked at {peak:.0} MiB{used}; half again as much, rounded up (RAM to 512 MiB, at least 1 GiB; CPU to 100 mCPU), is {asked}.", count),
    })
}

/// `value` rounded up to a multiple of `step`, ignoring float noise below a
/// thousandth (1.2 cores × 1500 is 1800.0000000000002).
fn up_to(value: f64, step: f64) -> f64 {
    ((value * 1000.0).round() / 1000.0 / step).ceil() * step
}

/// `answer` with the suggestion for `query` beside it, when there is one. A
/// failed read leaves it out: the submission itself has already happened.
pub(super) async fn beside(ws: &Arc<Workspace>, mut answer: Value, query: Query) -> Value {
    let except = answer["id"].as_str().map(str::to_owned);
    if let Ok(suggestion) = ws.stored(move |s| s.resource_suggestion(&query, except.as_deref())).await {
        if !suggestion.is_null() {
            answer["suggestion"] = suggestion;
        }
    }
    answer
}

/// A run's answer with a suggestion for each stage that has one.
pub(super) async fn beside_run(ws: &Arc<Workspace>, mut run: Value, stages: Vec<(String, Query)>) -> Value {
    let except = run["id"].as_str().map(str::to_owned);
    let mut out = Vec::new();
    for (stage, query) in stages {
        let except = except.clone();
        if let Ok(suggestion) = ws.stored(move |s| s.resource_suggestion(&query, except.as_deref())).await {
            if !suggestion.is_null() {
                let mut suggestion = suggestion;
                suggestion["stage"] = json!(stage);
                out.push(suggestion);
            }
        }
    }
    if !out.is_empty() {
        run["suggestions"] = json!(out);
    }
    run
}
