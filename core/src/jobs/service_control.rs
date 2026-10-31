//! Explicit user choices for a local managed service. Job admission and process
//! control stay in Jobs; an intent is never evidence that a process has exited.
use super::{host, store, Submit};
use crate::{model::now, service_jobs::Link, services::Service, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    request_id: String,
    expected_job_id: String,
    expected_intent_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_seconds: Option<u64>,
}

impl Request {
    fn validate(&self, action: &str) -> Result<()> {
        ensure!(!self.request_id.trim().is_empty() && self.request_id.len() <= 128,
            "invalid_input: requestId must contain 1–128 bytes");
        ensure!(!self.expected_job_id.is_empty() && self.expected_job_id.len() <= 128 && self.expected_intent_revision >= 0,
            "invalid_input: expectedJobId and a nonnegative expectedIntentRevision are required");
        match action {
            "stop" => ensure!(self.source_job_id.is_none() && self.timeout_seconds.is_none(), "invalid_input: stop takes no launch settings"),
            "start" => {
                ensure!(self.source_job_id.as_deref() == Some(self.expected_job_id.as_str()),
                    "invalid_input: sourceJobId must be the expected current Job");
                ensure!(self.timeout_seconds.is_some_and(|n| (1..=604800).contains(&n)),
                    "invalid_input: timeoutSeconds must be 1–604800");
            }
            _ => bail!("invalid_input: unknown service action"),
        }
        Ok(())
    }
}

/// Only this module constructs it. serde skips this on Submit, including when
/// a malicious job_submit tries to provide a serviceControl field.
#[derive(Clone, Debug)]
pub(super) struct StartGuard {
    pub(super) service_id: String,
    pub(super) request: Request,
    source: Value,
    health_path: Option<String>,
    /// The submission this guard was made for, as requested: create_job takes
    /// it only with exactly that submission.
    prepared: Value,
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS project_service_intents(
        service_id TEXT PRIMARY KEY REFERENCES project_services(id) ON DELETE CASCADE,
        data TEXT NOT NULL);
        DELETE FROM project_service_intents WHERE service_id NOT IN (SELECT id FROM project_services);")?;
    Ok(())
}

fn intent(db: &Connection, service: &str) -> Result<Value> {
    let raw: Option<String> = db.query_row("SELECT data FROM project_service_intents WHERE service_id=?1", [service], |r| r.get(0)).optional()?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw)?,
        None => json!({"revision":0,"desiredState":"unspecified","recoveryMode":"manual",
            "requestedAt":null,"requestedBy":null,"appliesToJobId":null,"sourceJobId":null,"requestId":null}),
    })
}

pub(crate) fn ensure_not_stopped(db: &Connection, service: &str) -> Result<()> {
    ensure!(intent(db, service)?["desiredState"] != "stopped",
        "service_stopped: the user chose to keep this service stopped; only an explicit user start can clear that choice");
    Ok(())
}

struct Current { job: Value, link: Link }

fn current(db: &Connection, service: &str) -> Result<Current> {
    let raw: Option<String> = db.query_row("SELECT data FROM project_services WHERE id=?1", [service], |r| r.get(0)).optional()?;
    let service: Service = serde_json::from_str(&raw.context("source_unavailable: the service no longer exists")?)?;
    ensure!(service.machine_id == crate::services::LOCAL, "source_unavailable: lifecycle actions support this Core's local services only");
    let (id, health_path): (String, Option<String>) = db.query_row(
        "SELECT job_id,health_path FROM project_service_jobs WHERE service_id=?1 ORDER BY seq DESC LIMIT 1", [&service.id],
        |r| Ok((r.get(0)?, r.get(1)?))).optional()?.context("source_unavailable: an external service has no managed launch")?;
    let job = store::get(db, &id).context("source_unavailable: the current Job record is missing")?;
    Ok(Current { job, link:Link {service_id:service.id, health_path} })
}

fn payload(service: &str, request: &Request) -> Result<Value> {
    let mut value = serde_json::to_value(request)?;
    value["serviceId"] = json!(service);
    Ok(value)
}

pub(super) fn previous(db: &Connection, service: &str, action: &str, request: &Request) -> Result<Option<Value>> {
    let row: Option<(String, String)> = db.query_row(
        "SELECT input_json,response_json FROM collaboration_requests WHERE actor='user' AND operation=?1 AND request_id=?2",
        params![format!("service_{action}"),request.request_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((input, output)) = row else { return Ok(None) };
    ensure!(serde_json::from_str::<Value>(&input)? == payload(service, request)?,
        "service_control_conflict: requestId was used for a different service action payload; this request performed nothing");
    Ok(Some(serde_json::from_str(&output)?))
}

fn compare(db: &Connection, service: &str, request: &Request) -> Result<Current> {
    ensure!(intent(db, service)?["revision"] == request.expected_intent_revision,
        "stale_service_state: the service intent changed; read the service again before choosing an action");
    let current = current(db, service)?;
    ensure!(current.job["id"] == request.expected_job_id,
        "stale_service_state: this service now refers to another Job; no action was taken on it");
    Ok(current)
}

fn save_intent(db: &Connection, service: &str, request: &Request, state: &str, job: &str) -> Result<Value> {
    let revision = request.expected_intent_revision.checked_add(1).context("Service intent revision exhausted")?;
    let value = json!({"revision":revision,"desiredState":state,"recoveryMode":"manual","requestedAt":now(),
        "requestedBy":{"kind":"user"},"appliesToJobId":job,"sourceJobId":request.source_job_id,"requestId":request.request_id});
    db.execute("INSERT INTO project_service_intents(service_id,data) VALUES(?1,?2)
        ON CONFLICT(service_id) DO UPDATE SET data=excluded.data", params![service,value.to_string()])?;
    Ok(value)
}

fn receipt(db: &Connection, service: &str, action: &str, request: &Request, intent: Value, job: &Value) -> Result<Value> {
    // The durable acknowledgment is the state at this action, not a refreshed
    // Job record. Retried responses never expose env, argv or private paths.
    let output = json!({"serviceId":service,"requestId":request.request_id,"action":action,
        "intent":intent,"jobId":job["id"],"status":job["status"]});
    db.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES('user',?1,?2,?3,?4)",
        params![format!("service_{action}"),request.request_id,payload(service,request)?.to_string(),output.to_string()])?;
    Ok(output)
}

fn stop(store: &Store, service: &str, request: &Request) -> Result<Value> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    if let Some(value) = previous(&tx, service, "stop", request)? { return Ok(value); }
    let current = compare(&tx, service, request)?;
    let saved = save_intent(&tx, service, request, "stopped", &request.expected_job_id)?;
    let job = store::request_cancel_in(store, &tx, None, current.job["id"].as_str().context("Missing Job identity")?)?;
    let answer = receipt(&tx, service, "stop", request, saved, &job)?;
    tx.commit()?;
    Ok(answer)
}

const FIELDS: &[&str] = &["name","cwd","argv","env","resources","exclusive","timeoutSeconds","guardGit","inputs","outputs"];

/// Reconstruct only the retained submission, never Core's environment. Missing
/// old fields are not replaced by new defaults; the caller needs a new job_submit.
fn submission(current: &Current, request: &Request) -> Result<Submit> {
    let job = &current.job;
    ensure!(job["executor"].is_null() && job["run"].is_null() && job["checkpointFrom"].is_null() && job["checkpoint"].is_null()
        && job["machineId"].is_null() && job["service"].is_object(),
        "source_unavailable: the source is not a standalone local service launch");
    ensure!(job["target"].is_null() || job["target"]["kind"] == "local", "source_unavailable: the source targets another machine");
    ensure!(FIELDS.iter().all(|key| job.get(*key).is_some_and(|v| !v.is_null()))
        && job["snapshot"]["cwd"].is_string() && job["snapshot"].get("git").is_some() && job["snapshot"]["files"].is_array(),
        "source_unavailable: the retained launch settings or original input snapshot are incomplete; submit a new Job explicitly");
    let mut value = json!({"requestId":uuid::Uuid::new_v4().to_string(),"taskId":job["taskId"],"agentId":job["agentId"]});
    for key in FIELDS.iter().copied().chain(["artifacts","gpu"]) {
        if let Some(field) = job.get(key) { value[key] = field.clone(); }
    }
    value["timeoutSeconds"] = json!(request.timeout_seconds.unwrap_or_else(|| job["timeoutSeconds"].as_u64().unwrap_or(0)));
    value["service"] = json!({"serviceId":current.link.service_id,"healthPath":current.link.health_path});
    let mut input: Submit = serde_json::from_value(value).context("source_unavailable: retained launch settings cannot be reused")?;
    input.validate().context("source_unavailable: retained launch settings are no longer valid")?;
    input.service_link = Some(current.link.clone());
    Ok(input)
}

fn source_identity(current: &Current) -> Value {
    let mut value = json!({"taskId":current.job["taskId"],"agentId":current.job["agentId"],
        "snapshot":current.job["snapshot"],"service":current.job["service"],"healthPath":current.link.health_path});
    for key in FIELDS.iter().copied().chain(["artifacts","gpu","machineId","executor","target","run","checkpointFrom"]) {
        value[key] = current.job[key].clone();
    }
    value
}

fn available(store: &Store, db: &Connection, current: &Current, request: &Request) -> Result<Submit> {
    ensure!(matches!(current.job["status"].as_str(), Some("succeeded"|"failed"|"cancelled"|"interrupted"|"rejected"))
        && current.job["reserved"] == false && current.job["finishedAt"].is_string(),
        "service_busy: this Job has not conclusively ended without a reservation; no new run can start");
    let input = submission(current, request)?;
    crate::service_jobs::check_available(db, &input.task_id, &current.link)
        .context("service_busy: a service Job may still occupy this service, or its task/project no longer matches")?;
    let agent = store.brief_in(db, input.agent_id.as_deref().context("source_unavailable: the source Agent is missing")?)?
        .context("source_unavailable: the source Agent no longer exists")?.agent;
    ensure!(agent.closed_at.is_none(), "source_unavailable: the source Agent is closed");
    let task: String = db.query_row("SELECT data FROM collaboration_tasks WHERE id=?1", [&input.task_id], |r| r.get(0))?;
    ensure!(serde_json::from_str::<Value>(&task)?["archivedAt"].is_null(), "source_unavailable: the source task is archived");
    Ok(input)
}

pub(super) fn check_start(store: &Store, db: &Connection, guard: &StartGuard) -> Result<()> {
    let current = compare(db, &guard.service_id, &guard.request)?;
    ensure!(source_identity(&current) == guard.source && current.link.health_path == guard.health_path,
        "stale_service_state: retained source settings changed during preparation; no Job was created");
    available(store, db, &current, &guard.request)?;
    Ok(())
}

pub(super) fn check_snapshot(original: &Value, snapshot: &Value) -> Result<()> {
    ensure!(["cwd","git","files"].iter().all(|key| snapshot[*key] == original[*key]),
        "guarded_inputs_changed: the original guarded inputs or working directory changed; submit a new Job explicitly");
    Ok(())
}

/// In create_job's transaction: the submission is the one this guard was made
/// for, serving its service, and the inputs read for it are the source's.
pub(super) fn check_prepared(guard: &StartGuard, input: &Submit, snapshot: &Value) -> Result<()> {
    let link = input.service_link.as_ref();
    ensure!(link.is_some_and(|l| l.service_id == guard.service_id && l.health_path == guard.health_path)
        && input.as_requested()? == guard.prepared,
        "stale_service_state: the prepared launch is not the one checked for this service; no Job was created");
    check_snapshot(&guard.source["snapshot"], snapshot)
}

pub(super) fn started(db: &Connection, guard: &StartGuard, job: &Value) -> Result<()> {
    let saved = save_intent(db, &guard.service_id, &guard.request, "running", job["id"].as_str().context("Missing Job identity")?)?;
    receipt(db, &guard.service_id, "start", &guard.request, saved, job)?;
    Ok(())
}

/// A current record's capability, not a promise about future filesystem or
/// capacity checks. The actual start repeats CAS inside create_job's transaction.
pub(crate) fn projection(store: &Store, db: &Connection, service: &str) -> Result<Value> {
    let intent = intent(db, service)?;
    let current = current(db, service);
    let source = current.as_ref().ok().map(|c| c.job["id"].clone());
    let ready = current.and_then(|current| {
        let request = Request {request_id:"capability".into(), expected_job_id:current.job["id"].as_str().unwrap_or_default().into(),
            expected_intent_revision:intent["revision"].as_i64().unwrap_or(0), source_job_id:None,timeout_seconds:None};
        available(store, db, &current, &request).map(|_| ())
    });
    let (code, reason) = match ready {
        Ok(()) => (None,None),
        Err(error) => { let message = error.to_string(); (Some(message.split(':').next().unwrap_or("source_unavailable").to_owned()),Some(message)) },
    };
    Ok(json!({"intent":intent,"canStart":code.is_none(),"startBlockedCode":code,"startBlockedReason":reason,"sourceJobId":source}))
}

/// Only browser routes call this; explicit rejection remains even if a future
/// caller accidentally tries to expose it to an Agent. The server owns this
/// future after a lost HTTP reply, just as ordinary Job submission does.
pub(crate) async fn control(ws: Arc<Workspace>, actor: Option<String>, service: String, action: String, request: Request) -> Result<Value> {
    ensure!(actor.is_none(), "service_control_forbidden: lifecycle controls are for the user");
    request.validate(&action)?;
    let _permit = if action == "start" { ws.admission.enter_work()? } else { ws.admission.enter_completion()? };
    let (id, op, retry) = (service.clone(), action.clone(), request.clone());
    if let Some(receipt) = ws.stored(move |s| previous(&*s.db.read()?, &id, &op, &retry)).await? { return Ok(receipt); }
    ws.start_jobs();
    if action == "stop" {
        let answer = ws.stored(move |s| stop(s, &service, &request)).await?;
        super::changed(&ws); ws.jobs.wake.notify_one();
        return Ok(answer);
    }
    let (id, planned) = (service.clone(), request.clone());
    let (input, original) = match ws.stored(move |s| prepare(s, &id, &planned)).await? {
        Prepared::Receipt(receipt) => return Ok(receipt),
        Prepared::Start(input, original) => (input, original),
    };
    let helper = host::helper(&ws.data_dir).await?;
    let capability = host::invoke(&helper, "capabilities", None, None).await?;
    let machine = host::machine_info().await?;
    let snapshot = host::invoke(&helper, "snapshot", None, Some(serde_json::to_value(&input)?)).await
        .context("source_unavailable: the original working directory or guarded inputs cannot be read; no Job was created")?;
    let answer = ws.stored(move |s| commit_start(s, &service, &request, input, &original, snapshot, machine, capability)).await?;
    super::changed(&ws);
    ws.jobs.wake.notify_one();
    Ok(answer)
}

enum Prepared {
    /// This same request has meanwhile committed: its retry is its receipt.
    Receipt(Value),
    Start(Submit, Current),
}

/// The submission a start would make, from the current record: read-only,
/// in one read so that a retry racing its own original (the receipt not yet
/// there when control() looked) never reads that original's new revision as
/// stale.
fn prepare(store: &Store, service: &str, request: &Request) -> Result<Prepared> {
    let db = store.db.read()?;
    // A WAL read already holds one snapshot; the shared writer reads in
    // autocommit, so it gets one here (as record_rows does).
    let _snapshot = if db.is_autocommit() { Some(db.unchecked_transaction()?) } else { None };
    if let Some(receipt) = previous(&db, service, "start", request)? {
        return Ok(Prepared::Receipt(receipt));
    }
    let current = compare(&db, service, request)?;
    let input = available(store, &db, &current, request)?;
    Ok(Prepared::Start(input, current))
}

/// With the inputs read on the host: one new Job, its link, intent and
/// receipt in create_job's transaction, which checks everything again.
#[allow(clippy::too_many_arguments)]
fn commit_start(store: &Store, service: &str, request: &Request, mut input: Submit, original: &Current,
    snapshot: Value, machine: Value, capability: Value) -> Result<Value> {
    check_snapshot(&original.job["snapshot"], &snapshot)?;
    let prepared = input.as_requested()?;
    input.service_control = Some(StartGuard {
        service_id: service.to_owned(),
        request: request.clone(),
        source: source_identity(original),
        health_path: original.link.health_path.clone(),
        prepared,
    });
    store.create_job(None, input, snapshot, machine, capability)?;
    previous(&*store.db.read()?, service, "start", request)?.context("The service action receipt is unavailable")
}

#[cfg(test)]
#[path = "service_control_tests.rs"]
mod tests;
