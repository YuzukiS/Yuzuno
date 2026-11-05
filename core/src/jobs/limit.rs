//! Lower a running Job's memory limit (T-38 B).
//!
//! The user, or the Agent that submitted the Job, lowers its memory limit
//! while it runs, so the budget it frees can start queued work at once. Only
//! down, never below what its cgroup uses now plus 256 MiB (host.py `limit`
//! checks that against the cgroup itself), and never raised again. systemd
//! applies the new MemoryMax to the worker unit at once (`systemctl --user
//! set-property --runtime`), and the cgroup's memory.max, read back, confirms
//! it; only then are the Job's request and reservation lowered, in one
//! transaction with the audit on the Job (`limitChanges`) and a line in its
//! task's activity. Swap stays as reserved. A Job killed for memory afterwards
//! fails with a reason naming the lowered limit (store.rs `oom_after_limit`).
//! A Job on another machine is refused: neither remote helper has such an
//! action.
use super::{changed, host, ids, store::{get, save}, Resources};
use crate::{collaboration_store as collaboration, model::now, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::sync::Arc;

/// Earlier lowerings kept on the Job, newest last.
const HISTORY: usize = 20;

/// Lower one running Job's memory limit to `memory_mib`.
pub(super) async fn lower(ws: &Arc<Workspace>, actor: Option<String>, id: String, memory_mib: u64) -> Result<Value> {
    // One control operation or reconciliation pass at a time.
    let _gate = ws.jobs.gate.lock().await;
    let job = ws
        .stored({
            let actor = actor.clone();
            move |s| s.check_job_limit(actor.as_deref(), &id, memory_mib)
        })
        .await?;
    let answer = host::limit(&ws.data_dir, &job, memory_mib).await.unwrap_or_else(|error| {
        json!({"state":"unknown","reason":format!("The host helper did not confirm the new limit: {error:#}")})
    });
    let id = job["id"].as_str().context("Missing job")?.to_owned();
    let attempt = job["attempt"].clone();
    let job = ws
        .stored(move |s| s.record_job_limit(actor.as_deref(), &id, &attempt, memory_mib, &answer))
        .await?;
    changed(ws);
    // What it freed can start queued work now.
    ws.jobs.wake.notify_one();
    Ok(job)
}

impl Store {
    /// Whether `actor` (the user, or the Agent that submitted it) may lower
    /// this Job's memory limit to `memory_mib`, before the host is asked.
    pub(super) fn check_job_limit(&self, actor: Option<&str>, id: &str, memory_mib: u64) -> Result<Value> {
        let id = self.resolve_id(ids::Kind::Job, id)?;
        let db = self.db.read()?;
        let job = get(&db, &id)?;
        if let Some(agent) = actor {
            ensure!(job["agentId"] == agent, "Only the user or the Agent that submitted the job can lower its memory limit");
        }
        ensure!(
            job["reserved"] == true && job["status"] == "running",
            "Only a running job's memory limit can be lowered; this one is {}",
            job["status"].as_str().unwrap_or("unknown")
        );
        if job["executor"].is_object() {
            let machine = job["executor"]["machineName"].as_str().or(job["machine"]["name"].as_str()).unwrap_or("its machine");
            bail!("Lowering a running job's memory limit is not supported on {machine}: its helper has no such action. Nothing was changed.");
        }
        ensure!(job["cancelRequestedAt"].is_null(), "Cancellation was requested; the job is being stopped");
        let resources: Resources = serde_json::from_value(job["resources"].clone())?;
        ensure!(
            memory_mib < resources.memory_mi_b,
            "{memory_mib} MiB is not below the job's {} MiB: a memory limit is only lowered, never raised",
            resources.memory_mi_b
        );
        Ok(job)
    }

    /// The host's answer: a confirmed new limit lowers the Job's request and
    /// reservation, with the audit on the Job and the task; anything else is
    /// kept as the last refusal, with the request as it was.
    pub(super) fn record_job_limit(
        &self,
        actor: Option<&str>,
        id: &str,
        attempt: &Value,
        memory_mib: u64,
        answer: &Value,
    ) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        ensure!(job["attempt"] == *attempt, "The job has a different attempt now; this answer is not recorded");
        let (by, source) = collaboration::actor_context(self, &tx, actor)?;
        let state = answer["state"].as_str().unwrap_or("unknown");
        let reason = answer["reason"].as_str().unwrap_or("The host gave no reason");
        if state == "limited" && job["reserved"] == true {
            let mut resources: Resources = serde_json::from_value(job["resources"].clone())?;
            let from = resources.memory_mi_b;
            resources.memory_mi_b = memory_mib;
            job["reservation"] = json!(resources.reservation());
            job["resources"] = json!(resources);
            let mut changes = job["limitChanges"].as_array().cloned().unwrap_or_default();
            changes.push(json!({"by":by,"at":now(),"fromMiB":from,"toMiB":memory_mib,"evidence":answer["evidence"]}));
            let skip = changes.len().saturating_sub(HISTORY);
            job["limitChanges"] = json!(changes.split_off(skip));
            if let Some(fields) = job.as_object_mut() {
                fields.remove("limitRefusal");
            }
            let task = job["taskId"].as_str().context("Missing task")?.to_owned();
            collaboration::activity(&tx, &task, "comment", &by, &source, json!({
                "body": format!("Memory limit of job {} ({}) lowered from {from} MiB to {memory_mib} MiB by {}; its reservation is lowered with it. Swap stays as reserved.",
                    job["name"].as_str().unwrap_or(""), job["id"].as_str().unwrap_or(""), by.name),
                "jobId": job["id"]}))?;
        } else {
            job["limitRefusal"] = json!({"by":by,"at":now(),"toMiB":memory_mib,"state":state,"reason":reason,"evidence":answer["evidence"]});
        }
        save(&tx, &job)?;
        tx.commit()?;
        Ok(job)
    }
}

/// The reason of a Job killed for memory after its limit was lowered: it
/// names the lowered limit, who lowered it and when. None without a lowering.
pub(super) fn oom_after_limit(job: &Value) -> Option<String> {
    let last = job["limitChanges"].as_array()?.last()?;
    Some(format!(
        "Out of memory at the lowered limit of {} MiB: {} lowered it from {} MiB at {}",
        last["toMiB"],
        last["by"]["name"].as_str().unwrap_or("someone"),
        last["fromMiB"],
        last["at"].as_str().unwrap_or("an unknown time")
    ))
}
