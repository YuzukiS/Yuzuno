//! A Job-run service's opt-in bounded recovery (T-14, design v3.4). The user
//! starts a run with automatic retry; if that run, or one of its own
//! retries, ends in a confirmed crash, one ordinary Job from the same retained
//! launch is queued after a fixed delay. At most three, all inside the run's
//! fixed end time. Anything else ends recovery with its reason, and from there
//! the service is manual as before.
//!
//! The recovery period lives in the service's intent (`recovery`): its
//! generation is the revision of the user start that armed it, its root the
//! Job that start made. A retry carries `recoveryOf` naming both, so only
//! Jobs of that lineage are ever eligible; another run never inherits it.
use super::store::{get, insert_job, save};
use crate::{model::now, service_jobs::Link, store::Store};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) const MAX_RETRIES: i64 = 3;
pub(crate) const SCHEDULE: [i64; 3] = [30, 120, 600];
/// No retry is queued or launched with less than this left before the end
/// time: it would be stopped within seconds. The host checks it again.
pub(crate) const MIN_REMAINING_SECONDS: i64 = 60;

/// The period a user start with automatic retry arms. `deadlineAt` is fixed
/// later, once, at the root's first recorded start.
pub(super) fn armed(generation: i64, root: &str, instance: &str) -> Value {
    json!({"generation":generation,"rootJobId":root,"maxRetries":MAX_RETRIES,"schedule":SCHEDULE,
        "minRemainingSeconds":MIN_REMAINING_SECONDS,"deadlineAt":null,"deadlineAtUnix":null,
        "scheduled":0,"started":0,"state":"active","retryJobId":null,"notBefore":null,
        "lastFailure":null,"haltedReason":null,"haltedAt":null,"coreInstance":instance})
}

/// An active period closed with this state and reason; any other value is
/// kept as it is (a period already closed keeps its own reason).
pub(super) fn closed(recovery: &Value, state: &str, reason: &str) -> Value {
    if recovery["state"] != "active" {
        return recovery.clone();
    }
    let mut value = recovery.clone();
    value["state"] = json!(state);
    value["haltedReason"] = json!(reason);
    value["haltedAt"] = json!(now());
    value["notBefore"] = Value::Null;
    value
}

/// Whether this Job belongs to the period: its root, or one of its retries.
pub(super) fn in_lineage(recovery: &Value, job: &Value) -> bool {
    !recovery.is_null()
        && (job["id"] == recovery["rootJobId"]
            || (job["recoveryOf"]["rootJobId"] == recovery["rootJobId"]
                && job["recoveryOf"]["generation"] == recovery["generation"]))
}

fn link_of(db: &Connection, job: &str) -> Result<Option<Link>> {
    Ok(db
        .query_row("SELECT service_id,health_path FROM project_service_jobs WHERE job_id=?1", [job],
            |r| Ok(Link { service_id: r.get(0)?, health_path: r.get(1)? }))
        .optional()?)
}

/// How a Job ended, for recovery: a crash worth retrying, or the reason it
/// is not.
enum End {
    Crash(Value),
    Ended(Option<&'static str>),
    Halted(&'static str),
}

const SIGNALS: [(i64, &str); 9] = [(1, "SIGHUP"), (2, "SIGINT"), (4, "SIGILL"), (6, "SIGABRT"), (7, "SIGBUS"),
    (8, "SIGFPE"), (9, "SIGKILL"), (11, "SIGSEGV"), (15, "SIGTERM")];

/// Read only from the Job's recorded evidence, as run-stage retries are
/// (`runs::auto_retry`): systemd's `Result` and the host's own markers.
fn end_of(job: &Value) -> End {
    let evidence = &job["result"]["evidence"];
    // An unconfirmed outcome stays unconfirmed, marker or not.
    if job["status"] == "unknown" {
        return End::Halted("unknown_outcome");
    }
    // The shared end time, recorded by the host before it stopped the run
    // or instead of starting it, decides whatever exit status followed.
    match evidence["deadline"]["kind"].as_str() {
        Some("stop") => return End::Ended(Some("lifetime_reached")),
        Some("notStarted") => return End::Ended(Some("insufficient_time")),
        _ => {}
    }
    if job["cancelRequestedAt"].is_string() {
        return End::Halted("cancelled");
    }
    match job["status"].as_str() {
        Some("succeeded") => End::Ended(None),
        Some("cancelled") => End::Halted("cancelled"),
        Some("interrupted") => End::Halted("host_restart"),
        Some("rejected") => End::Halted(match evidence["recoveryRefusal"].as_str() {
            Some("core_restart") => "core_restart",
            Some("insufficient_time") => return End::Ended(Some("insufficient_time")),
            _ if job["reason"].as_str().is_some_and(|r| r.starts_with("Guarded inputs changed")) => "inputs_changed",
            _ => "launch_refused",
        }),
        Some("failed") => {
            let at = job["finishedAt"].clone();
            let result = evidence["systemd"]["Result"].as_str();
            match result {
                Some("timeout") => return End::Ended(Some("lifetime_reached")),
                Some("oom-kill") => return End::Halted("oom"),
                Some("exit-code" | "signal" | "core-dump") => {}
                _ => return End::Halted("launch_refused"),
            }
            // The unit's main process is the host's wrapper. A crash is only
            // the command's own exit as the wrapper recorded it for this
            // attempt (`command`); a wrapper that failed before creating the
            // command says at which stage (`notLaunched`). Without either,
            // nothing shows the command crashed, so nothing is retried.
            if let Some(stage) = evidence["notLaunched"]["stage"].as_str() {
                return End::Halted(if stage == "inputs" { "inputs_changed" } else { "launch_refused" });
            }
            match (result, evidence["command"]["exitCode"].as_i64()) {
                (Some("exit-code"), Some(code)) if code > 0 => {
                    End::Crash(json!({"kind":"exit","code":code,"jobId":job["id"],"endedAt":at}))
                }
                (Some("signal"), Some(code)) if code < 0 => {
                    let name = SIGNALS.iter().find(|(n, _)| *n == -code).map(|(_, s)| s.to_string())
                        .unwrap_or_else(|| format!("signal {}", -code));
                    End::Crash(json!({"kind":"signal","signal":name,"jobId":job["id"],"endedAt":at}))
                }
                (Some("core-dump"), Some(code)) if code < 0 => End::Crash(json!({"kind":"core_dump","jobId":job["id"],"endedAt":at})),
                _ => End::Halted("unknown_outcome"),
            }
        }
        _ => End::Halted("launch_refused"),
    }
}

fn unix(at: &Value) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(at.as_str()?).ok().map(|t| t.timestamp_millis() as f64 / 1000.0)
}

fn at(seconds: f64) -> String {
    chrono::DateTime::from_timestamp_millis((seconds * 1000.0) as i64).map(|t| t.to_rfc3339()).unwrap_or_else(now)
}

fn now_unix() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64 / 1000.0
}

/// The end time is fixed once: from the root's start as first recorded, plus
/// the lifetime the user chose. A later rewrite of `startedAt` (the worker's
/// own clock) never moves it.
fn fix_deadline(recovery: &mut Value, root: &Value) -> bool {
    if !recovery["deadlineAtUnix"].is_null() {
        return false;
    }
    let (Some(start), Some(timeout)) = (unix(&root["startedAt"]), root["timeoutSeconds"].as_f64()) else {
        return false;
    };
    recovery["deadlineAtUnix"] = json!(start + timeout);
    recovery["deadlineAt"] = json!(at(start + timeout));
    true
}

/// After a service Job's evidence is recorded, in that same transaction
/// (`update_job_evidence`, a refusal before launch, or a cancel before
/// reservation), with the Job already saved in its new state. Only a Job of
/// the active period's lineage that is the service's current Job is
/// considered.
pub(super) fn after_outcome(store: &Store, tx: &Connection, job: &mut Value) -> Result<()> {
    let Some(link) = link_of(tx, job["id"].as_str().unwrap_or_default())? else {
        return Ok(());
    };
    let mut intent = super::service_control::intent(tx, &link.service_id)?;
    if intent["recoveryMode"] != "bounded" || intent["appliesToJobId"] != job["id"] || !in_lineage(&intent["recovery"], job) {
        return Ok(());
    }
    let recovery = &mut intent["recovery"];
    let retry = job["recoveryOf"]["retry"].as_i64();
    match job["status"].as_str() {
        Some("running") => {
            let fixed = retry.is_none() && fix_deadline(recovery, job);
            let ran = retry.is_some_and(|k| recovery["started"].as_i64().unwrap_or(0) < k);
            if let Some(k) = retry.filter(|_| ran) {
                recovery["started"] = json!(k);
            }
            if fixed || ran {
                super::service_control::write_intent(tx, &link.service_id, &intent)?;
            }
            return Ok(());
        }
        Some("starting" | "queued" | "cancelling") => return Ok(()),
        _ => {}
    }
    if retry.is_none() {
        fix_deadline(recovery, job);
    }
    // A retry can start and end between two observations: the host's start
    // receipt then arrives with the outcome, and it still counts as started.
    // `startedAt` alone is no proof (reservation sets it), and a rejected
    // attempt never started its command.
    let receipt = job["result"]["started"].is_object() && job["status"] != "rejected";
    if let Some(k) = retry.filter(|k| receipt && recovery["started"].as_i64().unwrap_or(0) < *k) {
        recovery["started"] = json!(k);
    }
    let end = end_of(job);
    let (state, reason, failure) = match end {
        End::Crash(failure) => match schedule(store, tx, job, recovery, &link, &failure) {
            Ok(None) => {
                intent["appliesToJobId"] = intent["recovery"]["retryJobId"].clone();
                super::service_control::write_intent(tx, &link.service_id, &intent)?;
                return Ok(());
            }
            Ok(Some((state, reason))) => {
                job["reason"] = json!(format!("{}. Not retried automatically: {}", job["reason"].as_str().unwrap_or("Ended"), match reason {
                    "exhausted" => "all automatic retries of this run are used",
                    "insufficient_time" => "less than 60 s would remain before the run's end time",
                    "core_restart" => "Core restarted since this run was started; recovery is manual after a restart",
                    _ => "this Job already has a retry",
                }));
                save(tx, job)?;
                // Exhausted is a state of its own, not a halt.
                (state, (state != "exhausted").then_some(reason), Some(failure))
            }
            Err(error) => {
                job["reason"] = json!(format!("{}. Not retried automatically: {error:#}", job["reason"].as_str().unwrap_or("Ended")));
                save(tx, job)?;
                ("halted", Some("launch_refused"), Some(failure))
            }
        },
        End::Ended(reason) => ("ended", reason, None),
        End::Halted(reason) => ("halted", Some(reason), None),
    };
    let recovery = &mut intent["recovery"];
    if let Some(failure) = failure {
        recovery["lastFailure"] = failure;
    }
    recovery["state"] = json!(state);
    recovery["haltedReason"] = json!(reason);
    recovery["haltedAt"] = json!(now());
    recovery["notBefore"] = Value::Null;
    intent["recoveryMode"] = json!("manual");
    super::service_control::write_intent(tx, &link.service_id, &intent)
}

/// A confirmed crash: the next retry, if the budget, the time left and this
/// Core allow one. `Ok(None)` when it was queued; otherwise why not. The
/// insertion runs under a savepoint: a refusal leaves no partial retry, and
/// the outcome being recorded still commits.
fn schedule(store: &Store, tx: &Connection, job: &mut Value, recovery: &mut Value, link: &Link, failure: &Value)
    -> Result<Option<(&'static str, &'static str)>> {
    let scheduled = recovery["scheduled"].as_i64().unwrap_or(0);
    if scheduled >= recovery["maxRetries"].as_i64().unwrap_or(MAX_RETRIES) {
        return Ok(Some(("exhausted", "exhausted")));
    }
    if recovery["coreInstance"] != json!(store.instance) {
        return Ok(Some(("halted", "core_restart")));
    }
    if !job["retriedBy"].is_null() {
        return Ok(Some(("halted", "launch_refused")));
    }
    let end = recovery["deadlineAtUnix"].as_f64().context("The recovery period has no end time")?;
    let k = scheduled + 1;
    let delay = recovery["schedule"][(k - 1) as usize].as_i64().unwrap_or(SCHEDULE[(k - 1) as usize]);
    let not_before = now_unix() + delay as f64;
    if end - not_before < MIN_REMAINING_SECONDS as f64 {
        return Ok(Some(("ended", "insufficient_time")));
    }
    tx.execute_batch("SAVEPOINT recovery")?;
    let inserted = (|| -> Result<Value> {
        crate::service_jobs::check_available(tx, job["taskId"].as_str().unwrap_or_default(), link)?;
        let retry = new_retry(store, tx, job, recovery, k, not_before, end)?;
        crate::service_jobs::insert(tx, retry["id"].as_str().unwrap_or_default(), link)?;
        Ok(retry)
    })();
    let retry = match inserted {
        Ok(retry) => {
            tx.execute_batch("RELEASE recovery")?;
            retry
        }
        Err(error) => {
            tx.execute_batch("ROLLBACK TO recovery; RELEASE recovery")?;
            return Err(error);
        }
    };
    recovery["scheduled"] = json!(k);
    recovery["retryJobId"] = retry["id"].clone();
    recovery["notBefore"] = retry["notBefore"].clone();
    recovery["lastFailure"] = failure.clone();
    job["retriedBy"] = retry["id"].clone();
    job["reason"] = json!(format!("{}. Automatic retry {k} of {} is job {}, not before {}",
        job["reason"].as_str().unwrap_or("Ended"), recovery["maxRetries"], retry["id"].as_str().unwrap_or(""),
        retry["notBefore"].as_str().unwrap_or("")));
    save(tx, job)?;
    Ok(None)
}

/// The retry: the ended Job's own command and frozen inputs (its guard is
/// checked again at launch, a change rejects it), queued, with its delay and
/// the period's end. Like a run stage's next attempt (`runs::new_attempt`).
fn new_retry(store: &Store, tx: &Connection, previous: &Value, recovery: &Value, k: i64, not_before: f64, end: f64) -> Result<Value> {
    let mut job = previous.clone();
    if let Some(map) = job.as_object_mut() {
        for key in ["cursor", "retriedBy", "gpuReservation", "pause", "checkpointStop", "resumeOf"] {
            map.remove(key);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let root = get(tx, recovery["rootJobId"].as_str().unwrap_or_default())?;
    let base = root["requestId"].as_str().unwrap_or("").split('/').next().unwrap_or("").to_owned();
    job["id"] = json!(id);
    job["attempt"] = json!(uuid::Uuid::new_v4().to_string());
    job["requestId"] = json!(format!("{base}/retry/{k}"));
    job["retryOf"] = previous["id"].clone();
    job["recoveryOf"] = json!({"serviceId":recovery_service(tx, previous)?,"generation":recovery["generation"],
        "rootJobId":recovery["rootJobId"],"retry":k,"coreInstance":store.instance});
    job["notBefore"] = json!(at(not_before));
    job["notBeforeUnix"] = json!(not_before);
    job["deadlineAt"] = recovery["deadlineAt"].clone();
    job["deadlineAtUnix"] = json!(end);
    job["guardChecks"] = Value::Null;
    // The identity stays the predecessor's: a standalone Job's is complete at
    // submission (no upstream), and a retry has the same command, frozen
    // inputs and artifacts. The timeout is not part of it.
    job["status"] = json!("queued");
    job["reserved"] = json!(false);
    job["reason"] = json!(format!("Automatic retry {k} of {}: not before {}", recovery["maxRetries"], at(not_before)));
    job["createdAt"] = json!(now());
    job["startedAt"] = Value::Null;
    job["finishedAt"] = Value::Null;
    job["cancelRequestedAt"] = Value::Null;
    job["notifications"] = json!({});
    job["result"] = Value::Null;
    job["unit"] = json!(format!("yuzuno-job-{id}.service"));
    job["supervisorUnit"] = json!(format!("yuzuno-job-{id}-collector.service"));
    insert_job(tx, job)
}

fn recovery_service(tx: &Connection, job: &Value) -> Result<String> {
    Ok(link_of(tx, job["id"].as_str().unwrap_or_default())?.context("The service link is missing")?.service_id)
}

/// At reservation, before anything is held: a retry queued by an earlier
/// Core never starts, and none starts with too little time left. Otherwise
/// its timeout is cut to what remains (the host cuts again just before
/// launch, and stops it at the end time).
pub(super) fn reservation(store: &Store, job: &mut Value) -> Option<(&'static str, &'static str)> {
    if !job["recoveryOf"].is_object() {
        return None;
    }
    if job["recoveryOf"]["coreInstance"] != json!(store.instance) {
        return Some(("core_restart",
            "Not started: Core restarted after this automatic retry was queued; after a restart recovery is manual"));
    }
    let end = job["deadlineAtUnix"].as_f64()?;
    let remaining = end - now_unix();
    if remaining < MIN_REMAINING_SECONDS as f64 {
        return Some(("insufficient_time",
            "Not started: less than 60 s remain before the end time this service run shares with its automatic retries"));
    }
    let cut = (remaining.ceil() as i64).min(job["timeoutSeconds"].as_i64().unwrap_or(i64::MAX)).max(1);
    job["timeoutSeconds"] = json!(cut);
    None
}

/// An ordinary submission that becomes the service's next Job takes over: a
/// period that was on, or that ended, is closed as superseded. That run
/// never inherits it.
pub(super) fn superseded(tx: &Connection, service: &str, job: &Value) -> Result<()> {
    let mut intent = super::service_control::intent(tx, service)?;
    let recovery = &intent["recovery"];
    if recovery.is_null() || recovery["state"] == "off" || in_lineage(recovery, job) {
        return Ok(());
    }
    let recovery = &mut intent["recovery"];
    recovery["state"] = json!("ended");
    recovery["haltedReason"] = json!("superseded");
    recovery["haltedAt"] = json!(now());
    recovery["notBefore"] = Value::Null;
    intent["recoveryMode"] = json!("manual");
    super::service_control::write_intent(tx, service, &intent)
}

fn outcome(job: &Value) -> Value {
    let evidence = &job["result"]["evidence"];
    if evidence["deadline"]["kind"] == "stop" && job["status"] != "unknown" {
        return json!("lifetime");
    }
    match job["status"].as_str() {
        Some("failed") => match end_of(job) {
            End::Crash(f) if f["kind"] == "exit" => json!(format!("exit:{}", f["code"])),
            End::Crash(f) if f["kind"] == "signal" => json!(format!("signal:{}", f["signal"].as_str().unwrap_or("unknown"))),
            End::Crash(_) => json!("core_dump"),
            End::Ended(Some("lifetime_reached")) => json!("lifetime"),
            End::Halted("oom") => json!("oom"),
            _ => json!("failed"),
        },
        Some(status @ ("succeeded" | "cancelled" | "rejected" | "unknown" | "interrupted")) => json!(status),
        _ => Value::Null,
    }
}

/// The service's recovery as the panel reads it. While a period is on, its
/// state follows the current Job: the root running is `armed`, a queued retry
/// `waiting`, a reserved or running one `retry`.
pub(super) fn view(db: &Connection, intent: &Value, current: Option<&Value>) -> Result<Value> {
    let recovery = &intent["recovery"];
    let launch = current.and_then(|job| match job["status"].as_str() {
        Some("queued") => Some("queued"),
        Some("starting") => Some("starting"),
        Some("running") => Some("running"),
        Some("unknown") => Some("unknown"),
        Some("cancelling") => Some("stopping"),
        _ => None,
    });
    let queue_reason = current.filter(|job| job["status"] == "queued").map(|job| job["reason"].clone()).unwrap_or(Value::Null);
    if recovery.is_null() {
        return Ok(json!({"mode":"manual","state":"off","launch":launch,"queueReason":queue_reason,
            "retry":{"scheduled":0,"started":0,"max":0},"schedule":SCHEDULE,"deadlineAt":null,"retryJobId":null,
            "notBefore":null,"lastFailure":null,"haltedReason":null,"haltedAt":null,"attempts":[],"observedAt":now()}));
    }
    let active = intent["recoveryMode"] == "bounded" && recovery["state"] == "active";
    let state = if active {
        match current.filter(|job| in_lineage(recovery, job)) {
            Some(job) if job["recoveryOf"].is_object() && job["status"] == "queued" => "waiting",
            Some(job) if job["recoveryOf"].is_object() => "retry",
            _ => "armed",
        }
    } else {
        recovery["state"].as_str().unwrap_or("off")
    };
    let mut lineage = db.prepare(
        "SELECT data FROM local_jobs WHERE id=?1 OR (json_extract(data,'$.recoveryOf.rootJobId')=?1
           AND json_extract(data,'$.recoveryOf.generation')=?2) ORDER BY seq DESC LIMIT 5")?;
    let attempts = lineage
        .query_map(params![recovery["rootJobId"].as_str().unwrap_or_default(), recovery["generation"].as_i64().unwrap_or(-1)],
            |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .rev()
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|job| json!({"retry":job["recoveryOf"]["retry"].as_i64().unwrap_or(0),"jobId":job["id"],
            "startedAt":job["startedAt"],"endedAt":job["finishedAt"],"outcome":outcome(&job)}))
        .collect::<Vec<_>>();
    Ok(json!({"mode":if active { "bounded" } else { "manual" },"state":state,"launch":launch,"queueReason":queue_reason,
        "retry":{"scheduled":recovery["scheduled"],"started":recovery["started"],"max":recovery["maxRetries"]},
        "schedule":recovery["schedule"],"deadlineAt":recovery["deadlineAt"],"retryJobId":recovery["retryJobId"],
        "notBefore":if state == "waiting" { recovery["notBefore"].clone() } else { Value::Null },
        "lastFailure":recovery["lastFailure"],"haltedReason":recovery["haltedReason"],"haltedAt":recovery["haltedAt"],
        "attempts":attempts,"observedAt":now()}))
}
