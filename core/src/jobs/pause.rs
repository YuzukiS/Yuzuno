//! Pause and resume a running Job (T-107).
//!
//! Pausing freezes the attempt's worker cgroup through systemd (host.py
//! `pause`); the collector is a separate unit and keeps watching. The Job
//! keeps `status: running`, `reserved: true` and every reservation (CPU,
//! memory, swap, GPU), so admission, runs and retries treat it as running.
//! `job.pause` records the user's intent and what the host confirmed:
//!
//!   intent: "pause" | "resume"
//!   state:  requested | paused | resuming | failed | unknown
//!
//! and is removed again once a resume is confirmed. A Job is `paused` only
//! after the worker cgroup's own cgroup.events reads frozen; a request alone
//! is `requested`. Work already submitted to a GPU still finishes. The
//! timeout keeps counting while paused: systemd cannot extend a running
//! unit's RuntimeMaxSec, and a paused Job that reaches it is stopped.
//! Only the user pauses or resumes; Core never resumes a Job by itself,
//! also not after a restart.
//!
//! A Job on an SSH machine (T-108) is paused the same way there: its
//! attempt's own transient scope is frozen through that account's systemd
//! and read back from its cgroup (remote_job.py `control`), and the
//! machine's status replies settle a lost answer. Only an attempt that runs
//! in a scope of its own can be paused (remote.rs `pause_refusal`); Windows
//! has no pause.
use super::{
    changed, host,
    store::{get, notify_message, save},
};
use crate::{collaboration_store as collaboration, model::now, store::Store, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Arc;

/// Earlier pauses of an attempt kept on the Job, newest last.
const HISTORY: usize = 20;

/// The user's pause or resume of one Job: the intent is saved first, then
/// the host acts on this attempt's own worker, then its answer is saved.
pub(super) async fn control(
    ws: &Arc<Workspace>,
    actor: Option<String>,
    id: String,
    resume: bool,
) -> Result<Value> {
    ensure!(
        actor.is_none(),
        "Only the user can pause or resume a job; its Agent sees the pause in job_get and its mailbox"
    );
    // One control operation or reconciliation pass at a time.
    let _gate = ws.jobs.gate.lock().await;
    let (job, act) = ws
        .stored({
            let id = id.clone();
            move |s| s.request_job_pause(&id, resume)
        })
        .await?;
    if !act {
        return Ok(job);
    }
    let mode = if resume { "resume" } else { "pause" };
    // A remote attempt's own scope, frozen on its machine (remote.rs);
    // request_job_pause refused every other remote job.
    let answer = if job["executor"]["kind"] == super::remote::SSH {
        super::remote::control(ws, &job, mode).await
    } else {
        host::control(&ws.data_dir, &job, mode)
            .await
            .unwrap_or_else(|error| {
                json!({"state":"unknown","reason":format!("The host helper did not confirm the {mode}: {error:#}")})
            })
    };
    let attempt = job["attempt"].clone();
    let job = ws
        .stored(move |s| s.record_job_pause(&id, &attempt, resume, &answer))
        .await?;
    changed(ws);
    Ok(job)
}

/// The reason a device pause closes a GPU to new jobs with. Resume reopens
/// the GPU only when its close still has exactly this reason and is the
/// user's: a close made before or after the pause stays.
const DEVICE_REASON: &str = "Paused by the user";

/// The user's pause or resume of GPU work on one device (T-106 devices): stop
/// new jobs from being admitted to it, then pause the running jobs that
/// hold it; resume those jobs, then reopen what the pause itself closed.
pub(super) async fn device(
    ws: &Arc<Workspace>,
    actor: Option<String>,
    uuid: String,
    resume: bool,
) -> Result<Value> {
    ensure!(actor.is_none(), "Only the user can pause or resume GPU work");
    let find = |view: &Value, uuid: &str| {
        view["devices"]
            .as_array()
            .and_then(|all| all.iter().find(|d| d["uuid"] == uuid))
            .cloned()
            .context("GPU not known on this machine")
    };
    let before = find(&ws.stored(|s| s.gpu_devices()).await?, &uuid)?;
    if !resume && closes(&before) {
        let id = uuid.clone();
        ws.stored(move |s| s.set_gpu_admission(&id, false, Some(DEVICE_REASON.into()), None))
            .await?;
        changed(ws);
    }
    let ids = before["reservations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|held| held["jobId"].as_str().map(str::to_owned))
        .collect();
    let jobs = each_job(ids, |id| {
        let ws = Arc::clone(ws);
        async move {
            let job = ws.stored({ let id = id.clone(); move |s| s.job(&id) }).await?;
            if acts_on(&job, resume) {
                control(&ws, None, id, resume).await
            } else {
                Ok(job)
            }
        }
    })
    .await;
    let after = find(&ws.stored(|s| s.gpu_devices()).await?, &uuid)?;
    if resume && reopens(&after) {
        let id = uuid.clone();
        ws.stored(move |s| s.set_gpu_admission(&id, true, None, None)).await?;
        changed(ws);
    }
    let device = find(&ws.stored(|s| s.gpu_devices()).await?, &uuid)?;
    Ok(json!({"device":device,"jobs":jobs}))
}

/// Act on each job in turn and report every one, with its error if it has
/// one: a job that ended or changed meanwhile does not stop a device pause
/// or resume halfway.
pub(super) async fn each_job<F, Fut>(ids: Vec<String>, mut act: F) -> Vec<Value>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    let mut out = Vec::new();
    for id in ids {
        out.push(match act(id.clone()).await {
            Ok(job) => json!({"id":job["id"],"name":job["name"],"status":job["status"],"pause":job["pause"]}),
            Err(error) => json!({"id":id,"error":format!("{error:#}")}),
        });
    }
    out
}

/// A device pause closes the GPU only when it is open: an earlier close keeps
/// its own reason and owner.
pub(super) fn closes(device: &Value) -> bool {
    device["admission"] != "closed"
}
/// A device resume reopens only the close its pause made.
pub(super) fn reopens(device: &Value) -> bool {
    device["admission"] == "closed" && device["closedBy"] == "user" && device["closedReason"] == DEVICE_REASON
}
/// A device pause pauses its running jobs that are not paused yet; a device
/// resume resumes only the jobs the user paused.
pub(super) fn acts_on(job: &Value, resume: bool) -> bool {
    job["status"] == "running"
        && if resume {
            job["pause"]["intent"] == "pause"
        } else {
            job["pause"]["state"] != "paused"
        }
}

/// When the attempt is stopped if still running: its start plus its timeout,
/// or the shared end of a service's retries (deadlineAtUnix) if earlier,
/// as host.py `run_time` cuts it at launch.
fn deadline(job: &Value) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let started = chrono::DateTime::parse_from_rfc3339(job["startedAt"].as_str()?).ok()?;
    let seconds = i64::try_from(job["timeoutSeconds"].as_u64()?).ok()?;
    let own = started + chrono::Duration::seconds(seconds);
    let shared = job["deadlineAtUnix"]
        .as_f64()
        .filter(|end| end.is_finite())
        .and_then(|end| chrono::DateTime::from_timestamp_millis((end * 1000.0) as i64))
        .map(|end| end.fixed_offset());
    Some(shared.filter(|end| *end < own).unwrap_or(own))
}

/// A length of time as a person reads it: "1 h 05 min", "20 min 34 s", "45 s".
fn span(seconds: i64) -> String {
    let seconds = seconds.max(0);
    let (hours, minutes, rest) = (seconds / 3600, seconds % 3600 / 60, seconds % 60);
    match (hours, minutes) {
        (0, 0) => format!("{rest} s"),
        (0, _) => format!("{minutes} min {rest:02} s"),
        _ => format!("{hours} h {minutes:02} min"),
    }
}

/// How far the attempt had got at the pause and what remains of its time
/// (T-50): elapsed is from its start, remaining is to its deadline, both at
/// `at`, the moment the pause was confirmed. Remaining keeps shrinking while
/// it is paused.
fn time_left(job: &Value, at: chrono::DateTime<chrono::FixedOffset>) -> Option<String> {
    let started = chrono::DateTime::parse_from_rfc3339(job["startedAt"].as_str()?).ok()?;
    let end = deadline(job)?;
    let (elapsed, remaining) = ((at - started).num_seconds(), (end - at).num_seconds());
    let left = if remaining > 0 {
        format!("{} remained", span(remaining))
    } else {
        "no time remained".to_owned()
    };
    Some(format!(
        ": at the pause it had run {} of its {} timeout and {left} (it is stopped at {} if still running)",
        span(elapsed),
        span(job["timeoutSeconds"].as_i64().unwrap_or_default()),
        end.to_rfc3339()
    ))
}

/// Tell the Job's Agent, once per change, so a silent Job is not taken for a
/// failed one and is not resubmitted.
fn tell(db: &Connection, job: &Value, event: &str) -> Result<()> {
    let task = job["taskId"].as_str().context("Missing task")?;
    let public_task = collaboration::task_number(db, &collaboration::task_key(db, task)?.0)?;
    let name = job["name"].as_str().unwrap_or("");
    let id = job["id"].as_str().unwrap_or("");
    // A remote attempt's scope is frozen on its machine (remote.rs).
    let (what, kept) = match job["executor"]["machineName"].as_str() {
        Some(machine) => (format!("Job {name} ({id}) on {machine}"), "its memory and the machine's reservation are kept"),
        None => (format!("Local job {name} ({id})"), "its memory, GPU memory and reservation are kept"),
    };
    let body = if event == "paused" {
        let at = job["pause"]["confirmedAt"]
            .as_str()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .unwrap_or_else(|| chrono::Utc::now().fixed_offset());
        format!("{what} was paused by the user. Its processes are frozen; {kept}, and its timeout still counts while it is paused{}. Only the user resumes it. Do not resubmit it or read its silence as a failure. Task {public_task}. job_get(jobId={id}) shows the pause.",
            time_left(job, at).unwrap_or_default())
    } else {
        format!("{what} was resumed by the user; the same processes continue. Network connections or leases may have expired while it was paused. Task {public_task}.")
    };
    let run = job["run"]["id"].as_str().unwrap_or("");
    notify_message(db, &job["agent"], task, job, event, name, run, body)?;
    Ok(())
}

fn confirm_paused(db: &Connection, job: &mut Value, reason: &str, evidence: &Value) -> Result<()> {
    let first = job["pause"]["state"] != "paused";
    job["pause"]["state"] = json!("paused");
    job["pause"]["reason"] = json!(reason);
    job["pause"]["evidence"] = evidence.clone();
    if job["pause"]["confirmedAt"].is_null() {
        job["pause"]["confirmedAt"] = json!(now());
    }
    if first {
        tell(db, job, "paused")?;
    }
    Ok(())
}

fn confirm_resumed(db: &Connection, job: &mut Value) -> Result<()> {
    let pause = job["pause"].take();
    let mut earlier = job["pauses"].as_array().cloned().unwrap_or_default();
    earlier.push(json!({"requestedAt":pause["requestedAt"],"confirmedAt":pause["confirmedAt"],"resumedAt":now()}));
    let skip = earlier.len().saturating_sub(HISTORY);
    job["pauses"] = json!(earlier.split_off(skip));
    if let Some(fields) = job.as_object_mut() {
        fields.remove("pause");
    }
    tell(db, job, "resumed")
}

impl Store {
    /// Validate a pause or resume and save the user's intent before the host
    /// acts. False: nothing for the host to do (already paused, or running).
    pub(super) fn request_job_pause(&self, id: &str, resume: bool) -> Result<(Value, bool)> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        let verb = if resume { "resumed" } else { "paused" };
        ensure!(
            job["reserved"] == true && job["status"] == "running",
            "Only a running job can be {verb}; this one is {}",
            job["status"].as_str().unwrap_or("unknown")
        );
        // On another machine: only an attempt in a scope of its own there.
        if let Some(why) = super::remote::pause_refusal(&job) {
            anyhow::bail!(why);
        }
        ensure!(
            job["cancelRequestedAt"].is_null(),
            "Cancellation was requested; the job is being stopped"
        );
        ensure!(
            !super::checkpoint::stopping(&job),
            "The job is being stopped at a checkpoint (checkpoint.rs); it ends instead"
        );
        let state = job["pause"]["state"].as_str().map(str::to_owned);
        // Repeating a confirmed pause or resume is a no-op.
        if resume && state.is_none() || !resume && state.as_deref() == Some("paused") {
            return Ok((job, false));
        }
        if job["pause"].is_null() {
            job["pause"] = json!({});
        }
        let pause = &mut job["pause"];
        pause["intent"] = json!(if resume { "resume" } else { "pause" });
        if resume {
            pause["state"] = json!("resuming");
            pause["resumeRequestedAt"] = json!(now());
            pause["reason"] = json!("Resume requested; waiting for the host to thaw the job");
        } else {
            pause["state"] = json!("requested");
            pause["requestedAt"] = json!(now());
            pause["reason"] = json!("Pause requested; waiting for every process in the job to stop");
        }
        save(&tx, &job)?;
        tx.commit()?;
        Ok((job, true))
    }

    /// The host's answer to a pause or resume of this attempt.
    pub(super) fn record_job_pause(
        &self,
        id: &str,
        attempt: &Value,
        resume: bool,
        answer: &Value,
    ) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        ensure!(
            job["attempt"] == *attempt,
            "The job has a different attempt now; this answer is not recorded"
        );
        let reason = answer["reason"].as_str().unwrap_or("The host gave no reason");
        let evidence = answer["evidence"].clone();
        match (resume, answer["state"].as_str().unwrap_or("unknown")) {
            (false, "paused") => confirm_paused(&tx, &mut job, reason, &evidence)?,
            (true, "running") => confirm_resumed(&tx, &mut job)?,
            (_, outcome) => {
                job["pause"]["state"] = json!(match outcome {
                    "pausing" => "requested",
                    "resuming" => "resuming",
                    "notPaused" | "notResumed" => "failed",
                    _ => "unknown",
                });
                job["pause"]["reason"] = json!(reason);
                job["pause"]["evidence"] = evidence;
            }
        }
        save(&tx, &job)?;
        tx.commit()?;
        Ok(job)
    }

    /// What the worker cgroup reports on each pass over running Jobs, also
    /// after a Core restart. Confirms a pending pause or resume, and says so
    /// when the Job was frozen or thawed outside Yuzuno. Never thaws or
    /// freezes anything itself. True when the Job changed.
    pub(super) fn reconcile_job_pause(&self, id: &str, attempt: &Value, freezer: &Value) -> Result<bool> {
        self.reconcile_pause(id, attempt, None, freezer)
    }

    /// The same for a remote attempt, whose freezer a status call read without
    /// the jobs gate (remote.rs answered): a pause or resume of the user's may
    /// have changed the job while that call was out, so the reading is applied
    /// only while the job's pause and earlier pauses are as they were when the
    /// call was sent (`seen`); otherwise the next status call reads it again.
    pub(super) fn reconcile_remote_pause(&self, seen: &Value, freezer: &Value) -> Result<bool> {
        let id = seen["id"].as_str().context("Missing job")?;
        self.reconcile_pause(id, &seen["attempt"], Some(seen), freezer)
    }

    fn reconcile_pause(&self, id: &str, attempt: &Value, seen: Option<&Value>, freezer: &Value) -> Result<bool> {
        let Some(frozen) = freezer["frozen"].as_bool() else {
            return Ok(false);
        };
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        if job["attempt"] != *attempt || job["status"] != "running" {
            return Ok(false);
        }
        if seen.is_some_and(|seen| job["pause"] != seen["pause"] || job["pauses"] != seen["pauses"]) {
            return Ok(false);
        }
        let intent = job["pause"]["intent"].as_str().map(str::to_owned);
        let state = job["pause"]["state"].as_str().map(str::to_owned);
        match (intent.as_deref(), state.as_deref(), frozen) {
            (Some("pause"), Some("paused"), true) | (Some("resume"), _, true) => return Ok(false),
            (Some("pause"), _, true) => confirm_paused(
                &tx,
                &mut job,
                "Paused: every process in the job is frozen; memory and GPU memory are kept",
                freezer,
            )?,
            (None, _, true) => {
                job["pause"] = json!({"intent":"pause","requestedAt":null});
                confirm_paused(&tx, &mut job, "Frozen outside Yuzuno; resume it here when it should continue", freezer)?;
            }
            (Some("resume"), _, false) => confirm_resumed(&tx, &mut job)?,
            (Some("pause"), Some("paused"), false) => {
                job["pause"]["state"] = json!("unknown");
                job["pause"]["reason"] = json!("Running again although it was paused: it was thawed outside Yuzuno. Pause it again, or resume to clear this.");
            }
            _ => return Ok(false),
        }
        save(&tx, &job)?;
        tx.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod span_tests {
    #[test]
    fn lengths_read_in_seconds_minutes_and_hours() {
        for (seconds, words) in [(-3, "0 s"), (0, "0 s"), (45, "45 s"), (60, "1 min 00 s"), (1234, "20 min 34 s"),
            (3599, "59 min 59 s"), (3600, "1 h 00 min"), (3900, "1 h 05 min"), (90061, "25 h 01 min")] {
            assert_eq!(super::span(seconds), words, "{seconds} s");
        }
    }
}
