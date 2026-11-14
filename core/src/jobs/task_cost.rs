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

/// The most attempts, and the most runs, one read adds up; past either the
/// read says which of its counts are partial.
const LIMIT: usize = 5000;
const FINISHED: &[&str] = &["succeeded", "failed", "cancelled", "interrupted", "rejected"];
pub(super) const DESCRIPTION: &str = "Read what a task's Jobs have recorded spending, every attempt counted once: failed, cancelled and retried attempts included, reused stages not again (they run nothing). usd adds up each attempt's own usage file. An attempt whose file is missing, empty or blank recorded none; one with unknown or unreadable entries recorded an unknown amount; both are counted apart and never as zero, while an entry with usd 0 is a known $0. compute adds up measured CPU time and worker wall time, each over the attempts that measured it (attemptsWithCpu, attemptsWithWall): one missing never drops the other, an explicit 0 is measured, and no average is made of the two; remote attempts and evidence that does not identify the attempt are counted without either. GPU use is not measured: only attempts admitted with a GPU reservation of their own are counted, not a request still queued, a cancel before admission or a retry still carrying an earlier attempt's reservation. At most the newest 5000 attempts and 5000 runs are read: attemptsTruncated and runsTruncated say which counts are partial. prunedAttempts and prunedRuns count what was removed from the Job history when it was full (oldest finished first); any makes truncated true and usd incomplete. A soft rollup, not a provider bill or a limit: a new method or run resets nothing, and admission, timeouts and a run's costLimitUsd apply as before.";

impl Store {
    pub(super) fn task_cost(&self, reference: &str) -> Result<Value> {
        let db = self.db.read()?;
        let (task, _) = collaboration::task_key(&db, reference)?;
        let number = collaboration::task_number(&db, &task)?;
        let rows = db
            .prepare("SELECT data FROM local_jobs WHERE task_id=?1 ORDER BY seq DESC LIMIT ?2")?
            .query_map(params![task, LIMIT as i64 + 1], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let truncated = rows.len() > LIMIT;
        let mut by_status: BTreeMap<String, usize> = BTreeMap::new();
        let (mut known, mut unknown_entries, mut invalid) = (0.0, 0i64, 0i64);
        let (mut reporting, mut not_recorded, mut unknown_attempts, mut live) = (0, 0, 0, 0);
        let (mut cpu, mut with_cpu, mut without_cpu) = (0.0, 0, 0);
        let (mut wall, mut with_wall, mut without_wall) = (0.0, 0, 0);
        let (mut measured, mut unmeasured, mut gpu) = (0, 0, 0);
        for raw in rows.iter().take(LIMIT) {
            let job: Value = serde_json::from_str(raw)?;
            let status = job["status"].as_str().unwrap_or("unknown").to_owned();
            *by_status.entry(status.clone()).or_default() += 1;
            let finished = FINISHED.contains(&status.as_str());
            if !finished {
                live += 1;
            }
            // Admission sets an attempt's start and its own reservation
            // together; a retry is created without a start, whatever its
            // earlier attempt's record still carries.
            if !job["startedAt"].is_null() && job["gpuReservation"].as_array().is_some_and(|held| !held.is_empty()) {
                gpu += 1;
            }
            // Only a readable entry records spending: an empty or blank file
            // recorded none, and unreadable lines alone an unknown amount. A
            // summary without an entry count is read as unknown, not as $0.
            let cost = &job["result"]["cost"];
            let entries = cost["entries"].as_i64();
            let unknown = cost["unknownEntries"].as_i64().unwrap_or(0);
            let bad = cost["invalidLines"].as_i64().unwrap_or(0) + cost["incompleteLines"].as_i64().unwrap_or(0);
            let partial = entries.is_none() || unknown > 0 || bad > 0 || cost["truncated"] == true || cost["complete"] == false;
            if !cost.is_object() || (entries == Some(0) && !partial) {
                if finished {
                    not_recorded += 1;
                }
            } else {
                if entries.unwrap_or(0) > 0 {
                    reporting += 1;
                }
                known += cost["knownUsd"].as_f64().unwrap_or(0.0);
                unknown_entries += unknown;
                invalid += bad;
                if partial {
                    unknown_attempts += 1;
                }
            }
            // CPU and wall time are each added where this attempt measured
            // it, as the attempt's own summary keeps them apart.
            if finished {
                let actual = &resource_summary::attempt(&job)["actual"];
                let (c, w) = (actual["cpuSeconds"].as_f64(), actual["workerWallSeconds"].as_f64());
                match c {
                    Some(c) => (cpu, with_cpu) = (cpu + c, with_cpu + 1),
                    None => without_cpu += 1,
                }
                match w {
                    Some(w) => (wall, with_wall) = (wall + w, with_wall + 1),
                    None => without_wall += 1,
                }
                if c.is_some() && w.is_some() {
                    measured += 1;
                } else {
                    unmeasured += 1;
                }
            }
        }
        let runs = db
            .prepare("SELECT data FROM local_job_runs WHERE task_id=?1 ORDER BY seq DESC LIMIT ?2")?
            .query_map(params![task, LIMIT as i64 + 1], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let runs_truncated = runs.len() > LIMIT;
        let mut reused = 0;
        for raw in runs.iter().take(LIMIT) {
            let run: Value = serde_json::from_str(raw)?;
            reused += run["stages"].as_array().into_iter().flatten().filter(|s| s["reusedFrom"].is_object()).count();
        }
        // What left the Job history when it was full (YN-142): not read, so partial.
        let (pruned_attempts, pruned_runs) = Store::pruned_of(&db, &task)?;
        let pruned = pruned_attempts > 0 || pruned_runs > 0;
        let round = |n: f64, places: f64| (n * places).round() / places;
        let attempts = rows.len().min(LIMIT);
        Ok(json!({"taskId":number,"attempts":attempts,"byStatus":by_status,
            "usd":{"knownUsd":round(known, 1e6),"attemptsReporting":reporting,"attemptsNotRecorded":not_recorded,
                "attemptsWithUnknown":unknown_attempts,"unknownEntries":unknown_entries,"invalidLines":invalid,
                "attemptsRunning":live,"complete":not_recorded == 0 && unknown_attempts == 0 && live == 0 && !truncated && pruned_attempts == 0},
            "compute":{"cpuSeconds":round(cpu, 1e3),"attemptsWithCpu":with_cpu,"attemptsWithoutCpu":without_cpu,
                "workerWallSeconds":round(wall, 1e3),"attemptsWithWall":with_wall,"attemptsWithoutWall":without_wall,
                "attemptsMeasured":measured,"attemptsUnmeasured":unmeasured},
            "gpu":{"attemptsReserving":gpu,"measured":false},
            "runs":runs.len().min(LIMIT),"reusedStages":reused,"limit":LIMIT,
            "attemptsTruncated":truncated,"runsTruncated":runs_truncated,"truncated":truncated || runs_truncated || pruned,
            "prunedAttempts":pruned_attempts,"prunedRuns":pruned_runs,
            "scope":DESCRIPTION}))
    }
}
