//! A Job's CPU as a range (T-64, direction C): the Agent asks for a minimum
//! and a maximum, and Core decides what it gets, by one rule recorded on the
//! Job.
//!
//! - Admission reserves the minimum and its collector, as it reserved
//!   `cpuMillis` before: a range never makes a Job wait longer.
//! - At the start the Job is granted `clamp(free − headroom, min, max)`: free
//!   is the budget less what every Job holding it has now (its current grant
//!   and its collector; a Job with no grant, its reservation), and headroom
//!   is the Job's own collector. With anything else queued, or policy
//!   `fixed`, the grant is the minimum.
//! - The grant is the worker's CPUQuota (cgroup cpu.max), checked before the
//!   command starts; its CPUWeight follows the minimum (host.py
//!   `cpu_weight`: 2000 mCPU is systemd's default of 100).
//! - While it runs, an elastic Job is only ever raised: when nothing is
//!   queued and the budget frees, the oldest first, up to its maximum, with
//!   `systemctl --user set-property --runtime` and cpu.max read back
//!   (host.py `raise_cpu`). Nothing is lowered: a Job queued later starts at
//!   its own minimum, and when Jobs contend their weights share the CPU.
//! - The Job reads its grant: YUZUNO_JOB_CPU_MILLIS at its start, and the file
//!   YUZUNO_JOB_CPU_FILE names, which Core rewrites after each raise, never
//!   before cpu.max allows it. Tools that size themselves from cpu.max (Rust,
//!   Cargo, libtest, Ninja) read it when a process starts: a raise helps the
//!   next process, not one already running.
use super::{changed, host, store::{get, save}, CpuPolicy, Requested, COLLECTOR_CPU};
use crate::{model::now, store::Store, workspace::Workspace};
use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// Raises kept on the Job, newest last.
const HISTORY: usize = 20;

/// What a Job asked for: its minimum, its maximum and its policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Range {
    pub min: u64,
    pub max: u64,
    pub policy: CpuPolicy,
}

/// The CPU a Job starts with, in millicores: what `free` leaves after its
/// own collector, within its range; its minimum when `queued` other Jobs
/// wait or its policy is fixed.
pub(super) fn grant(range: Range, free: u64, queued: usize) -> u64 {
    if range.policy == CpuPolicy::Fixed || queued > 0 {
        return range.min;
    }
    free.saturating_sub(COLLECTOR_CPU).clamp(range.min, range.max)
}

/// A running Job a raise may grow.
pub(super) struct Running {
    pub id: String,
    pub range: Range,
    pub current: u64,
}

/// One raise: a Job's grant from `from` to `to`.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Raise {
    pub id: String,
    pub from: u64,
    pub to: u64,
}

/// The raises one tick makes, none while `queued` Jobs wait: each elastic Job
/// in `running`'s order (the oldest start first) takes what is still free,
/// up to its maximum. Nothing is lowered.
pub(super) fn raises(free: u64, queued: usize, running: &[Running]) -> Vec<Raise> {
    let mut free = if queued > 0 { 0 } else { free };
    let mut raises = Vec::new();
    for job in running {
        if job.range.policy == CpuPolicy::Fixed || job.current >= job.range.max || free == 0 {
            continue;
        }
        let to = job.range.max.min(job.current + free);
        free -= to - job.current;
        raises.push(Raise { id: job.id.clone(), from: job.current, to });
    }
    raises
}

/// What the Jobs holding this host's budget hold of its CPU now: each one's
/// current grant and its collector, or, without a grant (a Windows Job, or
/// one reserved before T-64), its reservation.
pub(super) fn held(db: &Connection) -> Result<u64> {
    let mut q = db.prepare_cached(
        "SELECT json_extract(data,'$.cpuCurrent'), json_extract(data,'$.reservation.cpuMillis') FROM local_jobs
         WHERE reserved=1 AND (json_extract(data,'$.executor') IS NULL OR json_extract(data,'$.executor.kind')='windows')",
    )?;
    let mut total = 0u64;
    for row in q.query_map([], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?)))? {
        total += match row? {
            (Some(current), _) => current.max(0) as u64 + COLLECTOR_CPU,
            (None, reservation) => reservation.unwrap_or(0).max(0) as u64,
        };
    }
    Ok(total)
}

/// The grant of a local Job being reserved now, and the inputs of the rule,
/// on the Job: `cpuRequested`, `cpuGrantedAtStart`, `cpuGrant`, `cpuCurrent`.
pub(super) fn record_grant(db: &Connection, job: &mut Value, budget: u64, queued: usize, max_active: usize) -> Result<()> {
    let requested: Requested = serde_json::from_value(job["resources"].clone())?;
    let range = requested.cpu();
    let held = held(db)?;
    let free = budget.saturating_sub(held);
    let granted = grant(range, free, queued);
    job["cpuRequested"] = json!(range);
    job["cpuGrantedAtStart"] = json!(granted);
    job["cpuGrant"] = json!({"budgetCpuMillis": budget, "heldCpuMillis": held, "freeCpuMillis": free,
        "headroomCpuMillis": COLLECTOR_CPU, "queueLength": queued, "maxActive": max_active, "at": now()});
    job["cpuCurrent"] = json!(granted);
    Ok(())
}

/// Raise the running elastic Jobs the budget has room for, when nothing is
/// queued. Called from the Jobs tick, which holds the control gate.
pub(super) async fn raise(ws: &Arc<Workspace>) -> Result<()> {
    let planned = ws.stored(|s| s.cpu_raises()).await?;
    for (job, raise, free) in planned {
        let answer = host::raise_cpu(&ws.data_dir, &job, raise.to).await.unwrap_or_else(|error| {
            json!({"state":"unknown","reason":format!("The host helper did not confirm the raise: {error:#}")})
        });
        // The Job reads its grant only once cpu.max allows it.
        let file = if answer["state"] == "raised" {
            host::write_cpu_file(&ws.data_dir, &job, raise.to).await.err().map(|error| format!("{error:#}"))
        } else {
            None
        };
        let attempt = job["attempt"].clone();
        ws.stored(move |s| s.record_cpu_raise(&raise, &attempt, free, &answer, file)).await?;
        changed(ws);
    }
    Ok(())
}

impl Store {
    /// The raises due now, each with its Job and what was free: none while
    /// anything is queued, or with no budget saved yet. A raise that failed
    /// is not asked again for the same value.
    pub(super) fn cpu_raises(&self) -> Result<Vec<(Value, Raise, u64)>> {
        let db = self.db.read()?;
        if !super::queue::queued(&db)?.is_empty() {
            return Ok(Vec::new());
        }
        let Ok(budget) = super::store::budget(&db, None) else {
            return Ok(Vec::new());
        };
        let free = budget.cpu_millis.saturating_sub(held(&db)?);
        let mut q = db.prepare(
            "SELECT data FROM local_jobs WHERE reserved=1 AND status='running' AND json_extract(data,'$.executor') IS NULL
             AND json_type(data,'$.cpuCurrent')='integer' ORDER BY json_extract(data,'$.startedAt'), seq",
        )?;
        let mut jobs = Vec::new();
        for row in q.query_map([], |r| r.get::<_, String>(0))? {
            let job: Value = serde_json::from_str(&row?)?;
            if job["cancelRequestedAt"].is_null() {
                jobs.push(job);
            }
        }
        let running: Vec<Running> = jobs
            .iter()
            .filter_map(|job| {
                let range: Range = Range {
                    min: job["cpuRequested"]["min"].as_u64()?,
                    max: job["cpuRequested"]["max"].as_u64()?,
                    policy: serde_json::from_value(job["cpuRequested"]["policy"].clone()).ok()?,
                };
                Some(Running { id: job["id"].as_str()?.to_owned(), range, current: job["cpuCurrent"].as_u64()? })
            })
            .collect();
        Ok(raises(free, 0, &running)
            .into_iter()
            .filter_map(|raise| {
                let job = jobs.iter().find(|j| j["id"] == raise.id.as_str())?.clone();
                (job["cpuRaiseRefusal"]["to"].as_u64() != Some(raise.to)).then_some((job, raise, free))
            })
            .collect())
    }

    /// The host's answer to a raise: a confirmed one becomes the Job's
    /// `cpuCurrent`, with the change in `cpuChanges`; anything else is kept
    /// as the last refusal, the grant as it was.
    pub(super) fn record_cpu_raise(&self, raise: &Raise, attempt: &Value, free: u64, answer: &Value, file: Option<String>) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, &raise.id)?;
        if job["attempt"] != *attempt || job["reserved"] != true {
            return Ok(());
        }
        if answer["state"] == "raised" {
            let mut change = json!({"at": now(), "fromCpuMillis": raise.from, "toCpuMillis": raise.to,
                "freeCpuMillis": free, "queueLength": 0, "evidence": answer["evidence"]});
            if answer["confirmedByRetry"] == true {
                change["confirmedByRetry"] = json!(true);
            }
            if let Some(error) = file {
                change["cpuFileError"] = json!(error);
            }
            let mut changes = job["cpuChanges"].as_array().cloned().unwrap_or_default();
            changes.push(change);
            let skip = changes.len().saturating_sub(HISTORY);
            job["cpuChanges"] = json!(changes.split_off(skip));
            job["cpuCurrent"] = json!(raise.to);
            if let Some(fields) = job.as_object_mut() {
                fields.remove("cpuRaiseRefusal");
            }
        } else {
            job["cpuRaiseRefusal"] = json!({"at": now(), "fromCpuMillis": raise.from, "to": raise.to,
                "state": answer["state"].as_str().unwrap_or("unknown"),
                "reason": answer["reason"].as_str().unwrap_or("The host gave no reason"), "evidence": answer["evidence"]});
        }
        save(&tx, &job)?;
        tx.commit().context("The raise was not recorded")?;
        Ok(())
    }
}
