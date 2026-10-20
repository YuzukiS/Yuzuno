//! Stop a running Job at a checkpoint, and resume it from there (T-109).
//!
//! A standalone Job on this Core's host may declare `checkpoint`: the signal
//! its command saves on, how long it may take, and the exit code that says it
//! stopped (mod.rs `Checkpoint`). Unlike a pause, the attempt ends and frees
//! its memory; unlike a cancel, it may leave a checkpoint to resume from.
//!
//! The user's stop is saved first as `job.checkpointStop`:
//!
//!   state: requested | signalled | pending | failed | expired
//!          | checkpointed | notResumable
//!
//! then host.py `checkpoint` writes the stop request (a fresh nonce) into the
//! attempt's folder and asks its wrapper to send the declared signal to the
//! command. After the command exits the wrapper checks what it left (host.py
//! `verify_checkpoint`): the declared exit code, a manifest naming this
//! attempt and this request's nonce, and its own SHA-256 of every file. Only
//! then is the end `checkpointed`; any other end is `notResumable`. The
//! reservation is released as for every end, once the attempt's process
//! groups are empty. A command still running `graceSeconds` after the request
//! is cancelled as the user's cancel would; once it has exited, checking its
//! files counts against the Job's timeout instead.
//!
//! Resuming is the user's too: a new Job with the same submission whose
//! `checkpointFrom` names the verified files, and whose wrapper checks them
//! again before the command starts. Core never stops or resumes by itself.
use super::{
    changed, host,
    store::{get, notify_message, save},
    Submit,
};
use crate::{collaboration_store as collaboration, model::now, store::Store, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Arc;

/// What a resumed Job's submission takes from the stopped one.
const SUBMITTED: [&str; 13] = [
    "name", "cwd", "argv", "env", "resources", "exclusive", "timeoutSeconds", "guardGit", "inputs", "outputs",
    "artifacts", "gpu", "checkpoint",
];

/// The user's stop at a checkpoint: the intent is saved first, then the host
/// signals this attempt's own wrapper, then its answer is saved.
pub(super) async fn stop(ws: &Arc<Workspace>, actor: Option<String>, id: String) -> Result<Value> {
    ensure!(
        actor.is_none(),
        "Only the user can stop a job at a checkpoint; its Agent sees the stop in job_get and its mailbox"
    );
    // One control operation or reconciliation pass at a time (pause.rs).
    let _gate = ws.jobs.gate.lock().await;
    let (job, act) = ws
        .stored({
            let id = id.clone();
            move |s| s.request_checkpoint_stop(&id)
        })
        .await?;
    if !act {
        return Ok(job);
    }
    changed(ws);
    let answer = host::control(&ws.data_dir, &job, "checkpoint")
        .await
        .unwrap_or_else(|error| json!({"delivered":false,"reason":format!("The host helper did not confirm the stop: {error:#}")}));
    let attempt = job["attempt"].clone();
    let job = ws
        .stored(move |s| s.record_checkpoint_stop(&id, &attempt, &answer))
        .await?;
    changed(ws);
    Ok(job)
}

/// The user's resume of a Job stopped at a verified checkpoint: a new Job,
/// queued like any other. Repeating it returns the same new Job.
pub(super) async fn resume(ws: &Arc<Workspace>, actor: Option<String>, id: String) -> Result<Value> {
    ensure!(actor.is_none(), "Only the user can resume a job from its checkpoint");
    let job = ws.stored({ let id = id.clone(); move |s| s.job(&id) }).await?;
    if let Some(next) = job["checkpointStop"]["resumedAs"].as_str().map(str::to_owned) {
        return ws.stored(move |s| s.job(&next)).await;
    }
    let from = resumable(&job)?;
    let mut input = submission(&job)?;
    input.checkpoint_from = Some(from);
    input.validate()?;
    let prior = input.clone();
    let job = match ws.stored(move |s| s.previous_job(None, &prior)).await? {
        Some(job) => job,
        None => {
            let helper = host::helper(&ws.data_dir).await?;
            let capability = host::invoke(&helper, "capabilities", None, None).await?;
            let machine = host::machine_info().await?;
            let snapshot = host::invoke(&helper, "snapshot", None, Some(serde_json::to_value(&input)?)).await?;
            ws.stored(move |s| s.create_job(None, input, snapshot, machine, capability)).await?
        }
    };
    let next = job["id"].as_str().context("Missing job identity")?.to_owned();
    let job = ws.stored(move |s| s.link_resumed(&id, &next)).await?;
    changed(ws);
    ws.jobs.wake.notify_one();
    Ok(job)
}

/// The checkpoint a resumed attempt continues from, as its wrapper verified
/// it when the stopped attempt ended.
pub(super) fn resumable(job: &Value) -> Result<Value> {
    ensure!(job["checkpoint"].is_object(), "This job declared no checkpoint");
    ensure!(job["executor"].is_null() && job["run"].is_null(), "Only a standalone job on this Core's host resumes from a checkpoint");
    ensure!(
        job["reserved"] == false && job["finishedAt"].is_string(),
        "The job has not ended yet; it can be resumed once it has stopped at its checkpoint"
    );
    let checked = &job["result"]["checkpoint"];
    ensure!(
        checked["ok"] == true,
        "No verified checkpoint to resume from: {}",
        checked["reason"].as_str().unwrap_or("the job did not stop at a checkpoint")
    );
    Ok(json!({"jobId":job["id"],"attempt":job["attempt"],"dir":checked["dir"],
        "manifestSha256":checked["manifestSha256"],"files":checked["files"]}))
}

/// The stopped Job's own submission again, for its Agent and task, under a
/// request id derived from it: a repeated resume finds the same new Job.
pub(super) fn submission(job: &Value) -> Result<Submit> {
    let mut input = json!({"requestId":format!("checkpoint-resume-{}", job["id"].as_str().context("Missing job identity")?),
        "taskId":job["taskId"],"agentId":job["agentId"]});
    for field in SUBMITTED {
        if !job[field].is_null() {
            input[field] = job[field].clone();
        }
    }
    serde_json::from_value(input).context("The stopped job's submission cannot be read again")
}

/// A Job stopping at a checkpoint is not paused or resumed meanwhile.
pub(super) fn stopping(job: &Value) -> bool {
    matches!(job["checkpointStop"]["state"].as_str(), Some("requested" | "signalled" | "pending" | "failed"))
}

/// Past its stop's grace period, not yet cancelled.
fn expires(job: &Value) -> bool {
    stopping(job)
        && job["cancelRequestedAt"].is_null()
        && job["checkpointStop"]["deadline"]
            .as_str()
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| at <= chrono::Utc::now())
}

/// Cancel each attempt still running past its stop's grace period. One whose
/// command has exited is left alone: its wrapper is checking the checkpoint,
/// which counts against the Job's timeout, not against the grace period.
pub(super) async fn expire(ws: &Arc<Workspace>) -> Result<bool> {
    let mut changed = false;
    for job in ws.stored(|s| s.due_checkpoint_stops()).await? {
        if host::command_exited(&ws.data_dir, &job).await {
            continue;
        }
        let id = job["id"].as_str().context("Missing job identity")?.to_owned();
        let attempt = job["attempt"].clone();
        changed |= ws.stored(move |s| s.expire_checkpoint_stop(&id, &attempt)).await?;
    }
    Ok(changed)
}

/// Tell the Job's Agent, once per change, so a stop the user asked for is
/// not taken for a crash and the Job is not resubmitted.
fn tell(db: &Connection, job: &Value, event: &str, body: String) -> Result<()> {
    let task = job["taskId"].as_str().context("Missing task")?;
    let name = job["name"].as_str().unwrap_or("");
    notify_message(db, &job["agent"], task, job, event, name, "", body)?;
    Ok(())
}

fn task_ref(db: &Connection, job: &Value) -> Result<String> {
    Ok(format!("T-{}", collaboration::task_key(db, job["taskId"].as_str().context("Missing task")?)?.1))
}

/// When a Job that the user stopped at a checkpoint ends: whether it is
/// resumable, in its record and in the reason its Agent is told.
pub(super) fn settle(job: &mut Value) {
    if !job["checkpointStop"].is_object() || job["reserved"] != false {
        return;
    }
    let checked = &job["result"]["checkpoint"];
    if checked["ok"] == true {
        job["checkpointStop"]["state"] = json!("checkpointed");
        job["checkpointStop"]["reason"] = json!("Stopped at a verified checkpoint; only the user resumes it");
        return;
    }
    let why = checked["reason"].as_str().unwrap_or("the attempt ended before any checkpoint was checked").to_owned();
    // Stopped by the user only if the signal reached the command or the stop
    // became a cancel; otherwise it ended on its own and keeps its reason.
    let reached = checked["forward"].is_object() && checked["forward"]["problem"].is_null();
    job["checkpointStop"]["state"] = json!("notResumable");
    if !reached && job["status"] != "cancelled" {
        job["checkpointStop"]["reason"] = json!(format!("The job ended before the stop reached its command ({why})"));
        return;
    }
    job["checkpointStop"]["reason"] = json!(format!("No verified checkpoint: {why}"));
    let reason = job["reason"].as_str().unwrap_or("").to_owned();
    job["reason"] = json!(format!("Stopped at the user's request without a verified checkpoint ({why}); it cannot be resumed. {reason}"));
}

impl Store {
    /// Validate a stop at a checkpoint and save it before the host acts.
    /// False: the stop was delivered already; nothing for the host to do.
    pub(super) fn request_checkpoint_stop(&self, id: &str) -> Result<(Value, bool)> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        ensure!(job["checkpoint"].is_object(), "This job declared no checkpoint; pause or cancel it instead");
        ensure!(
            job["reserved"] == true && job["status"] == "running",
            "Only a running job can be stopped at a checkpoint; this one is {}",
            job["status"].as_str().unwrap_or("unknown")
        );
        ensure!(job["cancelRequestedAt"].is_null(), "Cancellation was requested; the job is being stopped");
        ensure!(job["pause"].is_null(), "Resume the job first: a paused command cannot save a checkpoint");
        if job["checkpointStop"]["state"] == "signalled" {
            return Ok((job, false));
        }
        if job["checkpointStop"].is_null() {
            let grace = job["checkpoint"]["graceSeconds"].as_i64().context("Missing graceSeconds")?;
            let at = chrono::Utc::now();
            job["checkpointStop"] = json!({"requestedAt":at.to_rfc3339(),"graceSeconds":grace,
                "deadline":(at + chrono::Duration::seconds(grace)).to_rfc3339()});
        }
        job["checkpointStop"]["state"] = json!("requested");
        job["checkpointStop"]["reason"] = json!("Stop requested; asking the command to save a checkpoint");
        save(&tx, &job)?;
        tx.commit()?;
        Ok((job, true))
    }

    /// The host's answer to a stop at a checkpoint of this attempt.
    pub(super) fn record_checkpoint_stop(&self, id: &str, attempt: &Value, answer: &Value) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        if job["attempt"] != *attempt || job["checkpointStop"]["state"] != "requested" {
            return Ok(job);
        }
        let first = job["checkpointStop"]["answeredAt"].is_null();
        let (state, reason) = if answer["delivered"] == true {
            ("signalled", format!("Sent {} to the command; it has until {} to save and exit",
                job["checkpoint"]["signal"].as_str().unwrap_or("SIGTERM"), job["checkpointStop"]["deadline"].as_str().unwrap_or("its grace period ends")))
        } else if answer["request"].is_object() {
            ("pending", format!("The stop is saved for the command's wrapper, which sends it when the command starts: {}",
                answer["reason"].as_str().unwrap_or("the command is not running yet")))
        } else {
            ("failed", format!("Not delivered: {}. It is cancelled when its grace period ends; stop it again or cancel it",
                answer["reason"].as_str().unwrap_or("the host gave no reason")))
        };
        job["checkpointStop"]["state"] = json!(state);
        job["checkpointStop"]["reason"] = json!(reason);
        job["checkpointStop"]["answeredAt"] = json!(now());
        job["checkpointStop"]["evidence"] = json!({"thawed":answer["thawed"]});
        if first {
            let name = job["name"].as_str().unwrap_or("");
            let id = job["id"].as_str().unwrap_or("");
            let body = format!("Local job {name} ({id}) is being stopped at a checkpoint by the user: its command is sent {} and has {} s to save and exit {}. \
                Only a checkpoint the wrapper verifies makes it resumable, and only the user resumes it. Do not resubmit it. Task {}. job_get(jobId={id}) shows the stop.",
                job["checkpoint"]["signal"].as_str().unwrap_or("SIGTERM"), job["checkpointStop"]["graceSeconds"],
                job["checkpoint"]["stoppedExitCode"], task_ref(&tx, &job)?);
            tell(&tx, &job, "checkpointStop", body)?;
        }
        save(&tx, &job)?;
        tx.commit()?;
        Ok(job)
    }

    /// Jobs whose stop's grace period has passed while they still hold
    /// their reservation. Whether their command is still running is the
    /// host's to say (host.rs `command_exited`).
    pub(super) fn due_checkpoint_stops(&self) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let ids = db
            .prepare("SELECT id FROM local_jobs WHERE reserved=1 AND json_extract(data,'$.checkpointStop') IS NOT NULL")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut due = Vec::new();
        for id in ids {
            let job = get(&db, &id)?;
            if expires(&job) {
                due.push(job);
            }
        }
        Ok(due)
    }

    /// Cancel this attempt, still running past its stop's grace period, as
    /// the user's cancel would. True when the Job changed.
    pub(super) fn expire_checkpoint_stop(&self, id: &str, attempt: &Value) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        if job["attempt"] != *attempt || job["reserved"] != true || !expires(&job) {
            return Ok(false);
        }
        let grace = job["checkpointStop"]["graceSeconds"].clone();
        job["checkpointStop"]["state"] = json!("expired");
        job["checkpointStop"]["reason"] = json!(format!("Still running {grace} s after the stop; cancelled"));
        job["checkpointStop"]["expiredAt"] = json!(now());
        job["cancelRequestedAt"] = json!(now());
        job["status"] = json!("cancelling");
        job["reason"] = json!(format!("Not stopped at a checkpoint within {grace} s of the user's stop; cancelling it, reservation held until its process groups have exited. It cannot be resumed unless a checkpoint was verified first."));
        save(&tx, &job)?;
        tx.commit()?;
        Ok(true)
    }

    /// Link a stopped Job to the Job that resumes it, once, and tell its Agent.
    pub(super) fn link_resumed(&self, id: &str, next: &str) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        ensure!(get(&tx, next)?["checkpointFrom"]["jobId"] == job["id"], "The new job does not resume this one");
        if job["checkpointStop"]["resumedAs"].is_null() {
            job["checkpointStop"]["resumedAs"] = json!(next);
            job["checkpointStop"]["resumedAt"] = json!(now());
            let body = format!("The user resumed local job {} ({}) from its checkpoint as a new job ({next}), queued like any other; its command gets YUZUNO_RESUME_FROM. Task {}. job_get(jobId={next}) follows it.",
                job["name"].as_str().unwrap_or(""), job["id"].as_str().unwrap_or(""), task_ref(&tx, &job)?);
            tell(&tx, &job, "checkpointResumed", body)?;
            save(&tx, &job)?;
        }
        tx.commit()?;
        drop(db);
        self.job(next)
    }
}

