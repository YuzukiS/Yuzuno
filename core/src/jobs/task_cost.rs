//! What a task's Jobs have recorded spending (T-17): a soft rollup of what
//! each attempt already recorded. Each attempt is its own Job, so it counts
//! once, failed, cancelled and retried attempts included; a reused stage runs
//! nothing and adds nothing. Unknown is said apart, never as zero, and a new
//! method or a new run resets nothing. Nothing here limits anything: admission,
//! timeouts and a run's soft cost limit apply as before.
use super::resource_summary;
use crate::{collaboration_store as collaboration, store::Store};
use anyhow::Result;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// The most attempts one read adds up; past it the sums say they are partial.
const LIMIT: usize = 5000;
const FINISHED: &[&str] = &["succeeded", "failed", "cancelled", "interrupted", "rejected"];
pub(super) const DESCRIPTION: &str = "Read what a task's Jobs have recorded spending, every attempt counted once: failed, cancelled and retried attempts included, reused stages not again (they run nothing). usd adds up each attempt's own usage file; an attempt that recorded none, or recorded an unknown amount, is counted apart and never as zero. compute adds up measured CPU time and worker wall time; remote and unmeasured attempts are counted apart. GPU use is not measured: only attempts that reserved a GPU are counted. A soft rollup, not a provider bill or a limit: a new method or run resets nothing, and admission, timeouts and a run's costLimitUsd apply as before.";

impl Store {
    pub(super) fn task_cost(&self, reference: &str) -> Result<Value> {
        let db = self.db.read()?;
        let (task, number) = collaboration::task_key(&db, reference)?;
        let rows = db
            .prepare("SELECT data FROM local_jobs WHERE task_id=?1 ORDER BY seq DESC LIMIT ?2")?
            .query_map(params![task, LIMIT as i64 + 1], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let truncated = rows.len() > LIMIT;
        let mut by_status: BTreeMap<String, usize> = BTreeMap::new();
        let (mut known, mut unknown_entries, mut invalid) = (0.0, 0i64, 0i64);
        let (mut reporting, mut not_recorded, mut unknown_attempts, mut live) = (0, 0, 0, 0);
        let (mut cpu, mut wall, mut measured, mut unmeasured, mut gpu) = (0.0, 0.0, 0, 0, 0);
        for raw in rows.iter().take(LIMIT) {
            let job: Value = serde_json::from_str(raw)?;
            let status = job["status"].as_str().unwrap_or("unknown").to_owned();
            *by_status.entry(status.clone()).or_default() += 1;
            let finished = FINISHED.contains(&status.as_str());
            if !finished {
                live += 1;
            }
            if job["gpu"].is_object() || job["gpuReservation"].is_array() {
                gpu += 1;
            }
            let cost = &job["result"]["cost"];
            if cost.is_object() {
                reporting += 1;
                known += cost["knownUsd"].as_f64().unwrap_or(0.0);
                let unknown = cost["unknownEntries"].as_i64().unwrap_or(0);
                let bad = cost["invalidLines"].as_i64().unwrap_or(0) + cost["incompleteLines"].as_i64().unwrap_or(0);
                unknown_entries += unknown;
                invalid += bad;
                if unknown > 0 || bad > 0 || cost["truncated"] == true || cost["complete"] == false {
                    unknown_attempts += 1;
                }
            } else if finished {
                not_recorded += 1;
            }
            if finished {
                let summary = resource_summary::attempt(&job);
                match (summary["actual"]["cpuSeconds"].as_f64(), summary["actual"]["workerWallSeconds"].as_f64()) {
                    (Some(c), Some(w)) => {
                        cpu += c;
                        wall += w;
                        measured += 1;
                    }
                    _ => unmeasured += 1,
                }
            }
        }
        let runs = db
            .prepare("SELECT data FROM local_job_runs WHERE task_id=?1 ORDER BY seq DESC LIMIT ?2")?
            .query_map(params![task, LIMIT as i64], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut reused = 0;
        for raw in &runs {
            let run: Value = serde_json::from_str(raw)?;
            reused += run["stages"].as_array().into_iter().flatten().filter(|s| s["reusedFrom"].is_object()).count();
        }
        let round = |n: f64, places: f64| (n * places).round() / places;
        let attempts = rows.len().min(LIMIT);
        Ok(json!({"taskId":format!("T-{number}"),"attempts":attempts,"byStatus":by_status,
            "usd":{"knownUsd":round(known, 1e6),"attemptsReporting":reporting,"attemptsNotRecorded":not_recorded,
                "attemptsWithUnknown":unknown_attempts,"unknownEntries":unknown_entries,"invalidLines":invalid,
                "attemptsRunning":live,"complete":not_recorded == 0 && unknown_attempts == 0 && live == 0 && !truncated},
            "compute":{"cpuSeconds":round(cpu, 1e3),"workerWallSeconds":round(wall, 1e3),
                "attemptsMeasured":measured,"attemptsUnmeasured":unmeasured},
            "gpu":{"attemptsReserving":gpu,"measured":false},
            "runs":runs.len(),"reusedStages":reused,"truncated":truncated,"scope":DESCRIPTION}))
    }
}
