use super::{Resources, Submit, DEFAULT_MAX_ACTIVE, MAX_ACTIVE_RANGE};
use crate::{collaboration_store as collaboration, model::now, store::Store};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS local_jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
        agent_id TEXT NOT NULL, status TEXT NOT NULL, reserved INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS local_jobs_state ON local_jobs(status,seq);
        CREATE INDEX IF NOT EXISTS local_jobs_agent ON local_jobs(agent_id,seq);
        -- A task's Jobs, newest first (job_list by task, job_cost).
        CREATE INDEX IF NOT EXISTS local_jobs_task ON local_jobs(task_id,seq);
        CREATE TABLE IF NOT EXISTS local_job_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_job_disk (id INTEGER PRIMARY KEY CHECK(id=1), reserve_gib INTEGER);
        -- The most Windows attempts at once on the PC this Core's WSL runs on;
        -- NULL (or no row) is the default. Kept apart from local_job_settings,
        -- whose document older Cores read strictly.
        CREATE TABLE IF NOT EXISTS local_job_windows (id INTEGER PRIMARY KEY CHECK(id=1), max_jobs INTEGER);
        -- How many of this host's own Jobs run at once (T-55); NULL (or no
        -- row) is the default. Kept apart from local_job_settings for the same
        -- reason. An older Core ignores it and runs its own four.
        CREATE TABLE IF NOT EXISTS local_job_slots (id INTEGER PRIMARY KEY CHECK(id=1), max_active INTEGER);")?;
    super::runs::migrate(db)?;
    super::history::migrate(db)?;
    super::gpu::migrate(db)?;
    super::queue::migrate(db)
}
pub(super) fn actor_key(actor: Option<&str>) -> String {
    actor
        .map(|s| format!("agent:{s}"))
        .unwrap_or_else(|| "user".into())
}
pub(super) fn get(db: &Connection, id: &str) -> Result<Value> {
    let (seq, raw): (i64, String) = db
        .query_row("SELECT seq,data FROM local_jobs WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .context("Job not found")?;
    let mut value: Value = serde_json::from_str(&raw)?;
    value["cursor"] = json!(seq);
    // Jobs created before exclusive admission are ordinary jobs.
    if value.get("exclusive").is_none() {
        value["exclusive"] = json!(false);
    }
    Ok(value)
}

// One bounded snapshot of the live queue per read/admission transaction. These
// are views of the existing durable reservations, not a second lock or queue.
pub(super) struct QueueState {
    active: i64,
    exclusive_active: bool,
    exclusive_queued: Option<i64>,
}
impl QueueState {
    pub(super) fn read(db: &Connection) -> Result<Self> {
        Ok(db.query_row(
            "SELECT COALESCE(SUM(reserved),0),
                COALESCE(MAX(reserved=1 AND json_extract(data,'$.exclusive')=1),0),
                MIN(CASE WHEN status='queued' AND json_extract(data,'$.exclusive')=1 THEN seq END)
             FROM local_jobs WHERE (reserved=1 OR status='queued') AND json_extract(data,'$.executor') IS NULL",
            [],
            |r| {
                Ok(Self {
                    active: r.get(0)?,
                    exclusive_active: r.get(1)?,
                    exclusive_queued: r.get(2)?,
                })
            },
        )?)
    }
    fn waiting_reason(&self, job: &Value) -> Option<&'static str> {
        if job["status"] != "queued" || job["executor"].is_object() {
            return None;
        }
        if self.exclusive_active {
            return Some(
                "Waiting for the exclusive job to finish and its process groups to be cleared",
            );
        }
        let seq = job["cursor"].as_i64()?;
        if self.exclusive_queued.is_some_and(|exclusive| exclusive < seq) {
            return Some("Waiting for an earlier exclusive job in FIFO order");
        }
        if job["exclusive"] == true && self.active > 0 {
            return Some(
                "Waiting for running jobs to finish and their process groups to be cleared",
            );
        }
        None
    }
    pub(super) fn view(&self, mut job: Value) -> Value {
        if let Some(reason) = self.waiting_reason(&job) {
            job["reason"] = json!(reason);
        }
        job
    }
}

pub(super) fn budget(db: &Connection, fallback: Option<&Value>) -> Result<Resources> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM local_job_settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?;
    match raw {
        Some(raw) => Ok(serde_json::from_str(&raw)?),
        None => Ok(serde_json::from_value(
            fallback
                .context("Machine budget has not been initialized")?
                .clone(),
        )?),
    }
}
/// The most Windows attempts at once the user set, if any (None: the default,
/// WINDOWS_MAX_JOBS). Only a ceiling: they still hold this host's budget.
pub(super) fn windows_max_jobs(db: &Connection) -> Result<Option<u32>> {
    Ok(db
        .query_row("SELECT max_jobs FROM local_job_windows WHERE id=1", [], |r| r.get::<_, Option<u32>>(0))
        .optional()?
        .flatten())
}
/// The most of this host's own Jobs that hold a slot at once: the number the
/// user saved, or DEFAULT_MAX_ACTIVE.
pub(super) fn max_active(db: &Connection) -> Result<usize> {
    Ok(saved_max_active(db)?.map_or(DEFAULT_MAX_ACTIVE, |n| n as usize))
}
fn saved_max_active(db: &Connection) -> Result<Option<u32>> {
    Ok(db
        .query_row("SELECT max_active FROM local_job_slots WHERE id=1", [], |r| r.get::<_, Option<u32>>(0))
        .optional()?
        .flatten())
}
/// What holds this host's budget, and how many of its own jobs hold it. The
/// Windows of the PC this Core's WSL runs on is the same physical machine, so
/// its jobs hold this budget too (never counted twice, never added to it);
/// an SSH machine's jobs hold that machine's own.
pub(super) fn reserved(db: &Connection) -> Result<(Resources, usize)> {
    let mut q = db.prepare(
        "SELECT data FROM local_jobs WHERE reserved=1 AND (json_extract(data,'$.executor') IS NULL
         OR json_extract(data,'$.executor.kind')='windows')",
    )?;
    let mut total = Resources::default();
    let mut count = 0;
    for row in q.query_map([], |r| r.get::<_, String>(0))? {
        let value: Value = serde_json::from_str(&row?)?;
        total.add(&serde_json::from_value::<Resources>(
            value["reservation"].clone(),
        )?);
        // Only this host's own jobs take an execution/collector slot here.
        if value["executor"].is_null() {
            count += 1;
        }
    }
    Ok((total, count))
}
/// The first queued job short of the configured budget (T-38). Its need is
/// held open: a later job starts ahead of it only within `allowance`, the
/// budget less its need and less what every job that started ahead of a
/// head still holds (`passed`), and only within what is free now (`room`).
struct BlockedHead {
    id: String,
    name: String,
    /// What it waits for: the shared CPU quota, RAM or swap reservation.
    waits: &'static str,
    need: Resources,
    allowance: Resources,
}
impl BlockedHead {
    fn new(db: &Connection, id: &str, name: String, waits: &'static str, need: &Resources, limit: &Resources) -> Result<Self> {
        let allowance = limit.available(need).available(&passed(db)?);
        Ok(Self { id: id.to_owned(), name, waits, need: need.clone(), allowance })
    }
    /// What may start ahead of it now.
    fn room(&self, free: &Resources) -> Resources {
        Resources {
            cpu_millis: self.allowance.cpu_millis.min(free.cpu_millis),
            memory_mi_b: self.allowance.memory_mi_b.min(free.memory_mi_b),
            swap_mi_b: self.allowance.swap_mi_b.min(free.swap_mi_b),
        }
    }
}
/// What the jobs that started ahead of a head, any head, still hold. Counting
/// those of every head rather than only the current one's is conservative:
/// it can delay a later pass, never take a head's share (review 1bbccc2a).
fn passed(db: &Connection) -> Result<Resources> {
    let mut q = db.prepare_cached("SELECT data FROM local_jobs WHERE reserved=1 AND json_type(data,'$.admission.passed')='object'")?;
    let mut total = Resources::default();
    for row in q.query_map([], |r| r.get::<_, String>(0))? {
        let value: Value = serde_json::from_str(&row?)?;
        total.add(&serde_json::from_value::<Resources>(value["reservation"].clone())?);
    }
    Ok(total)
}
/// The first dimension of the configured budget `need` does not fit in
/// `free`, with its waiting reason; None when it fits.
fn budget_shortage(need: &Resources, free: &Resources) -> Option<(&'static str, String)> {
    if need.cpu_millis > free.cpu_millis {
        Some(("shared CPU quota", format!("Waiting for shared CPU quota: needs {} mCPU including collector, {} mCPU available; short {} mCPU", need.cpu_millis, free.cpu_millis, need.cpu_millis - free.cpu_millis)))
    } else if need.memory_mi_b > free.memory_mi_b {
        Some(("shared RAM reservation", format!("Waiting for shared RAM reservation: needs {} MiB including collector, {} MiB available; short {} MiB", need.memory_mi_b, free.memory_mi_b, need.memory_mi_b - free.memory_mi_b)))
    } else if need.swap_mi_b > free.swap_mi_b {
        Some(("shared swap reservation", format!("Waiting for shared swap reservation: needs {} MiB, {} MiB available; short {} MiB", need.swap_mi_b, free.swap_mi_b, need.swap_mi_b - free.swap_mi_b)))
    } else {
        None
    }
}
fn triple(r: &Resources) -> String {
    format!("{} mCPU / {} MiB RAM / {} MiB swap", r.cpu_millis, r.memory_mi_b, r.swap_mi_b)
}
/// What job_budget's CPU hints are, and are not (T-64).
const CPU_HINT: &str = "cpuMillisFree (the budget less every running Job's current CPU grant and collector), queueLength (local Jobs queued), cpuWaiting (how many of them only CPU, or nothing, kept from starting at the last admission pass, and since when) and running (local Jobs running) are read now, to choose a CPU range with: they are not an entitlement. A Job's grant is decided when it starts: its minimum while another queued Job waits for CPU, never because of Jobs waiting for RAM, a GPU, disk, a slot or an exclusive Job; and running Jobs are raised only while none waits for CPU.";
pub(super) fn save(db: &Connection, value: &Value) -> Result<()> {
    db.execute(
        "UPDATE local_jobs SET status=?2,reserved=?3,data=?4 WHERE id=?1",
        params![
            value["id"].as_str(),
            value["status"].as_str(),
            value["reserved"].as_bool().unwrap_or(false),
            value.to_string()
        ],
    )?;
    Ok(())
}
/// A Job as a summary shows it: with its task's key now (T-56), which needs
/// the taskId the summary leaves out.
pub(super) fn current_ref(db: &Connection, mut job: Value) -> Value {
    crate::task_keys::refresh(db, &mut job);
    job
}
pub(super) fn summary(job: Value) -> Value {
    let mut result = json!({});
    for field in [
        "id",
        "requestId",
        "name",
        "status",
        "reason",
        "agentId",
        "agent",
        "taskRef",
        "source",
        "resources",
        "exclusive",
        "reservation",
        "createdAt",
        "startedAt",
        "finishedAt",
        "reserved",
        "cursor",
        "run",
        "retryOf",
        "gpu",
        "gpuReservation",
        "pause",
        "timeoutSeconds",
        "executor",
        "agentMachine",
        "checkpoint",
        "checkpointStop",
    ] {
        result[field] = job[field].clone();
    }
    result["resumeOf"] = job["checkpointFrom"]["jobId"].clone();
    result["machine"] = json!({"id":job["machine"]["id"],"name":job["machine"]["name"]});
    result
}
fn previous(
    store: &Store,
    db: &Connection,
    actor: Option<&str>,
    input: &Submit,
) -> Result<Option<Value>> {
    collaboration::actor_context(store, db, actor)?;
    let task = collaboration::task_key(db, &input.task_id)?.0;
    // As sent: a retry names its Job whatever an alias resolved to.
    let mut expected = input.as_requested()?;
    expected["taskId"] = json!(task);
    let row: Option<(String,String)> = db.query_row("SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation='job_submit' AND request_id=?2",params![actor_key(actor),input.request_id],|r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((old, response)) = row else {
        return Ok(None);
    };
    let mut old: Value = serde_json::from_str(&old)?;
    if old.get("exclusive").is_none() {
        old["exclusive"] = json!(false);
    }
    ensure!(
        old == expected,
        "idempotency_conflict: requestId already names a different job submission"
    );
    let response: Value = serde_json::from_str(&response)?;
    Ok(Some(QueueState::read(db)?.view(super::history::replayed(
        db,
        response["jobId"].as_str().context("Invalid job receipt")?,
    )?)))
}
/// A service's automatic retry refused before launch (T-14): never started,
/// its refusal recorded and told, then recovery settles it in the same
/// transaction.
fn refuse_retry(store: &Store, tx: &Connection, job: &mut Value, code: &str, reason: &str) -> Result<()> {
    job["status"] = json!("rejected");
    job["reason"] = json!(reason);
    job["finishedAt"] = json!(now());
    job["result"] = json!({"status":"rejected","reason":reason,
        "evidence":{"coreObservation":true,"notStarted":true,"recoveryRefusal":code}});
    notify(tx, job)?;
    save(tx, job)?;
    super::service_recovery::after_outcome(store, tx, job)
}
fn notify(db: &Connection, job: &mut Value) -> Result<()> {
    let status = job["status"]
        .as_str()
        .context("Missing job status")?
        .to_owned();
    if !matches!(
        status.as_str(),
        "succeeded" | "failed" | "cancelled" | "interrupted" | "rejected" | "unknown"
    ) || job["notifications"][&status].is_string()
    {
        return Ok(());
    }
    // A run tells its stages' successes, retried failures and cancellation once.
    let mut context = String::new();
    if job["run"].is_object() {
        if let Some(handled) = super::runs::stage_notice(db, job, &status)? {
            job["notifications"][&status] = json!(handled);
            return Ok(());
        }
        context = super::runs::mail_context(db, job)?;
    }
    let task = job["taskId"].as_str().context("Missing task")?.to_owned();
    let public_task = collaboration::task_number(db, &collaboration::task_key(db, &task)?.0)?;
    let place = match job["executor"]["machineName"].as_str() {
        Some(machine) => format!("Job on {machine}"),
        None => "Local job".to_owned(),
    };
    let resources = super::resource_summary::mail(job);
    let body = format!("{place} {} ({}) is {status}. Task {public_task}. {}{context}{resources} Read job_get(jobId={}) for retained machine evidence and job_logs for bounded output. This job result does not complete the business task or authorize an automatic rerun.",job["name"].as_str().unwrap_or(""),job["id"].as_str().unwrap_or(""),job["reason"].as_str().unwrap_or(""),job["id"].as_str().unwrap_or(""));
    let name = job["name"].as_str().unwrap_or("").to_owned();
    let run = job["run"]["id"].as_str().unwrap_or("").to_owned();
    let recipient = job["agent"].clone();
    let id = notify_message(db, &recipient, &task, job, &status, &name, &run, body)?;
    job["notifications"][&status] = json!(id);
    Ok(())
}
/// Core's system mail about a job outcome, read by the doorbell as a job.
/// A run's own outcome names its newest finished attempt, without that
/// attempt's machine result.
#[allow(clippy::too_many_arguments)]
pub(super) fn notify_message(
    db: &Connection,
    recipient: &Value,
    task: &str,
    job: &Value,
    status: &str,
    name: &str,
    run: &str,
    body: String,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let author = json!({"kind":"system","id":"core","name":"Yuzuno Core"});
    let systemd = if job["status"] == status {
        job["result"]["evidence"]["systemd"]["Result"].clone()
    } else {
        Value::Null
    };
    let run = if run.is_empty() { Value::Null } else { json!(run) };
    let mut source = json!({"jobId":job["id"],"attempt":job["attempt"]});
    let mut metadata = json!({"kind":"job","status":status,"jobId":job["id"],"attempt":job["attempt"],"name":name,"systemdResult":systemd});
    if !run.is_null() {
        source["runId"] = run.clone();
        metadata["runId"] = run;
    }
    collaboration::insert_message(
        db,
        json!({"id":id,"seq":0,"sender":author,"recipient":recipient,"body":body,"taskId":task,"replyTo":null,"threadId":id,"createdAt":now(),"source":source,"priority":"normal","jobId":job["id"],"metadata":metadata}),
    )?;
    Ok(id)
}

/// A new queued job for this actor: every check of a submission, then its
/// durable record, not yet inserted.
pub(super) fn new_job(
    store: &Store,
    tx: &Connection,
    actor: Option<&str>,
    input: &Submit,
    snapshot: Value,
    machine: Value,
    capability: Value,
) -> Result<Value> {
    let (author, source) = collaboration::actor_context(store, tx, actor)?;
    let agent_id = actor
        .or(input.agent_id.as_deref())
        .context("A job must be associated with an Agent")?;
    ensure!(
        actor.is_none() || input.agent_id.as_deref().is_none_or(|id| id == agent_id),
        "An Agent can submit only its own jobs"
    );
    let agent = store
        .brief_in(tx, agent_id)?
        .context("Agent not found")?
        .agent;
    ensure!(
        agent.closed_at.is_none(),
        "Closed Agents cannot start new jobs"
    );
    // Where the Agent runs is not where its Job runs: an Agent on a remote
    // machine submits like any other, and a Job without machineId runs on
    // this Core's host (its cwd is always explicit, never the Agent's).
    let agent_machine = agent.remote.as_ref().map(|remote| json!({"id": remote.machine.id, "name": remote.machine.name}));
    let recipient = collaboration::agent_actor(store, tx, agent_id)?;
    let task = collaboration::task_key(tx, &input.task_id)?.0;
    let task_data: String = tx.query_row(
        "SELECT data FROM collaboration_tasks WHERE id=?1",
        [&task],
        |r| r.get(0),
    )?;
    let task_data: Value = serde_json::from_str(&task_data)?;
    ensure!(
        task_data["archivedAt"].is_null(),
        "Archived tasks cannot accept new jobs"
    );
    // Room in the Job history is made by each insert's caller (history.rs).
    // Stages waiting for their upstream count as queued work too.
    let waiting: i64 = tx.query_row(
        "SELECT COUNT(*) FROM local_jobs WHERE status IN ('queued','waiting')",
        [],
        |r| r.get(0),
    )?;
    ensure!(waiting < 200, "Local job queue is full (200)");
    let remote = input.machine_id.is_some();
    let windows = input.machine_id.as_deref() == Some(super::remote::WINDOWS);
    let reservation = input.resources.point().reservation();
    // Windows on this PC holds this host's budget (see reserved): it must be
    // able to fit it. job_submit sets the budget first if none is stored.
    if windows {
        let limit = budget(tx, None).context("This PC's Jobs budget is not set yet; nothing was queued")?;
        ensure!(reservation.fits(&limit), "Job can never fit this PC's Jobs budget, which its Linux and Windows jobs share (including 64 MiB / 100 millicore collector overhead); reduce resources or change the machine budget");
    }
    // A remote machine's declared resources are recorded, not admitted here.
    if !remote {
        let limit = budget(tx, Some(&machine["suggestedBudget"]))?;
        tx.execute(
            "INSERT OR IGNORE INTO local_job_settings(id,data) VALUES(1,?1)",
            [serde_json::to_string(&limit)?],
        )?;
        ensure!(reservation.fits(&limit),"Job can never fit this machine budget (including 64 MiB / 100 millicore collector overhead); reduce resources or change the machine budget");
    }
    if let Some(gpu) = &input.gpu {
        if let Some(reason) = super::gpu::never_fits(tx, gpu)? {
            anyhow::bail!("{reason}");
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let mut value = serde_json::to_value(input)?;
    value["id"] = json!(id);
    value["attempt"] = json!(attempt);
    value["taskId"] = json!(task);
    value["taskRef"] = json!(collaboration::task_number(tx, &collaboration::task_key(tx, &task)?.0)?);
    value["agentId"] = json!(agent_id);
    value["agent"] = json!(recipient);
    // The machine the submitting Agent runs on (null: this Core's host).
    value["agentMachine"] = json!(agent_machine);
    value["requestedBy"] = json!(author);
    value["source"] = source;
    value["machine"] = machine;
    // Where it runs: the machine as the submission named it (null: none, so
    // this host) and as Core resolved it then, kept for the Job (T-162).
    let (kind, machine_id) = match input.machine_id.as_deref() {
        None => ("local", super::CORE_HOST),
        Some(super::remote::WINDOWS) => ("windows", super::remote::WINDOWS),
        Some(id) => ("ssh", id),
    };
    value["target"] = json!({"requested": input.named_machine(), "kind": kind, "machineId": machine_id,
        "machineName": value["machine"]["name"]});
    value["capabilities"] = capability.clone();
    value["bootId"] = capability["bootId"].clone();
    value["snapshot"] = snapshot;
    value["cwd"] = value["snapshot"]["cwd"].clone();
    value["status"] = json!("queued");
    value["reserved"] = json!(false);
    value["reservation"] = json!(reservation);
    value["createdAt"] = json!(now());
    value["startedAt"] = Value::Null;
    value["finishedAt"] = Value::Null;
    value["reason"] = json!("Waiting for shared machine capacity");
    value["cancelRequestedAt"] = Value::Null;
    value["notifications"] = json!({});
    value["result"] = Value::Null;
    value["unit"] = json!(format!("yuzuno-job-{id}.service"));
    value["supervisorUnit"] = json!(format!("yuzuno-job-{id}-collector.service"));
    if remote {
        let kind = if value["machine"]["kind"] == "windows" { "windows" } else { "ssh" };
        value["executor"] = json!({"kind": kind, "machineId": value["machine"]["id"], "machineName": value["machine"]["name"]});
        value["reason"] = json!(format!("Waiting for a slot on {}", value["machine"]["name"].as_str().unwrap_or("the remote machine")));
        value["unit"] = Value::Null;
        value["supervisorUnit"] = Value::Null;
        // With inputs or artifacts: bound now, with the mode the machine has
        // now, read in this insert's transaction (remote.rs prebind).
        let mode = match (kind, value["machine"]["id"].as_str()) {
            ("ssh", Some(id)) => super::remote::machine_settings(tx, id)?.and_then(|m| m.limit_mode),
            _ => None,
        };
        super::remote::prebind(&mut value, mode);
    }
    Ok(value)
}

/// Insert a job record; its cursor is its queue position.
pub(super) fn insert_job(tx: &Connection, mut value: Value) -> Result<Value> {
    // Each caller made room first (history::make_room); this only keeps the limit.
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM local_jobs", [], |r| r.get(0))?;
    ensure!(count < super::history::LIMIT, "Local job history limit reached ({})", super::history::LIMIT);
    tx.execute(
        "INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,?3,?4,?5)",
        params![value["id"].as_str(), value["taskId"].as_str(), value["agentId"].as_str(), value["status"].as_str(), value.to_string()],
    )?;
    value["cursor"] = json!(tx.last_insert_rowid());
    Ok(value)
}

/// The existing cancel operation inside a caller-owned transaction. Service
/// intent and cancellation commit together; signalling remains the worker's.
pub(super) fn request_cancel_in(store: &Store, tx: &Connection, actor: Option<&str>, id: &str) -> Result<Value> {
    let mut job = get(tx, id)?;
    ensure!(
        actor.is_none_or(|a| job["agentId"] == a),
        "An Agent can cancel only its own jobs"
    );
    if job["status"] == "queued" || job["status"] == "waiting" {
        job["reason"] = json!(if job["status"] == "waiting" {
            "Cancelled while waiting for its upstream stages; no process started"
        } else {
            "Cancelled before capacity reservation; no process started"
        });
        job["status"] = json!("cancelled");
        job["finishedAt"] = json!(now());
        job["cancelRequestedAt"] = json!(now());
        // A blocked head cancelled in the queue keeps no mark (T-38).
        if let Some(fields) = job.as_object_mut() {
            fields.remove("admission");
        }
        notify(tx, &mut job)?;
    } else if job["reserved"] == true {
        if job["cancelRequestedAt"].is_null() {
            job["cancelRequestedAt"] = json!(now());
        }
        job["status"] = json!("cancelling");
        job["reason"] =
            json!("Cancellation requested; reservation held until process groups have exited");
    }
    save(tx, &job)?;
    super::runs::job_changed(store, tx, &job)?;
    // A service's automatic retry cancelled before reservation is never
    // reconciled again, so its recovery period is settled here (T-14). Stop
    // and opt-out have already closed it; this changes nothing for them.
    if job["status"] == "cancelled" && job["service"].is_object() {
        super::service_recovery::after_outcome(store, tx, &mut job)?;
    }
    Ok(job)
}

impl Store {
    pub(super) fn previous_job(
        &self,
        actor: Option<&str>,
        input: &Submit,
    ) -> Result<Option<Value>> {
        previous(self, &*self.db.read()?, actor, input)
    }
    /// `machineId` `local` or `agent` resolved to the machine it names now.
    /// `local` is this host. `agent` is the machine the authenticated Agent
    /// runs on, read from that Agent's own record and never from the
    /// request: its registered SSH machine, or this host for an Agent here.
    /// The Job keeps what this returns; its retry is matched as it was sent.
    pub(super) fn resolve_machine(&self, actor: Option<&str>, mut input: Submit) -> Result<Submit> {
        let named = input.machine_id.clone().unwrap_or_default();
        let resolved = match named.as_str() {
            super::CORE_HOST => None,
            super::AGENT_MACHINE => {
                let actor = actor.context(
                    "machineId agent is the machine of the Agent that submits, and this submission has none; name the machine, or local for this Core's host",
                )?;
                let db = self.db.read()?;
                let agent = self.brief_in(&db, actor)?.context("agent_not_found: calling Agent does not exist")?.agent;
                match agent.remote {
                    None => None,
                    Some(remote) => {
                        let registered: Option<String> = db
                            .query_row("SELECT data FROM machines WHERE id=?1", [&remote.machine.id], |r| r.get(0))
                            .optional()?;
                        ensure!(registered.is_some(),
                            "machineId agent is the machine this Agent runs on, {}, which is no longer registered in Machines; nothing was submitted",
                            remote.machine.name);
                        Some(remote.machine.id)
                    }
                }
            }
            _ => return Ok(input),
        };
        input.machine_id = resolved;
        input.requested_machine = Some(named);
        Ok(input)
    }
    pub(super) fn create_job(
        &self,
        actor: Option<&str>,
        input: Submit,
        snapshot: Value,
        machine: Value,
        capability: Value,
    ) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        if let Some(guard) = &input.service_control {
            ensure!(actor.is_none(), "service_control_forbidden: lifecycle controls are for the user");
            if let Some(receipt) = super::service_control::previous(&tx, &guard.service_id, "start", &guard.request)? {
                return get(&tx, receipt["jobId"].as_str().context("Missing service action Job")?);
            }
            super::service_control::check_start(self, &tx, guard)?;
            super::service_control::check_prepared(guard, &input, &snapshot)?;
        }
        if let Some(job) = previous(self, &tx, actor, &input)? {
            return Ok(job);
        }
        // A remote Job takes its machine as registered now, read in this
        // transaction: a removal or a new SSH destination (each checked in its
        // own transaction) comes before it and is refused here, or after it and
        // is refused there while this Job is unfinished.
        let machine = match input.machine_id.as_deref() {
            Some(id) => super::remote::registered_machine(&tx, id)?,
            None => machine,
        };
        // Inputs frozen on an SSH machine at submit (T-108): only with the
        // machine still reached as it was when they were read.
        if let Some(frozen) = snapshot.get("frozenOn") {
            ensure!(["id", "kind", "target"].iter().all(|key| frozen[key] == machine[key]),
                "{} was changed while its inputs were being read there, so nothing was submitted; submit it again",
                machine["name"].as_str().unwrap_or("The machine"));
        }
        // An SSH machine with a budget of its own: a Job that could never fit
        // it is refused now rather than waiting forever.
        if let Some(id) = input.machine_id.as_deref().filter(|id| *id != super::remote::WINDOWS) {
            if let Some(limit) = super::remote::machine_settings(&tx, id)?.and_then(|m| m.budget) {
                let need = input.resources.point().reservation();
                ensure!(need.cpu_millis <= u64::from(limit.cpu_millis) && need.memory_mi_b <= u64::from(limit.memory_mib),
                    "Job can never fit this machine's Jobs budget ({} mCPU / {} MiB RAM, including 64 MiB / 100 millicore for its supervisor); reduce resources or change the machine's budget",
                    limit.cpu_millis, limit.memory_mib);
            }
        }
        let task = collaboration::task_key(&tx, &input.task_id)?.0;
        if let Some(link) = &input.service_link {
            if input.service_control.is_some() {
                crate::service_jobs::check_available(&tx, &task, link)?;
            } else {
                crate::service_jobs::check(&tx, &task, link)?;
            }
        }
        let mut payload = input.as_requested()?;
        payload["taskId"] = json!(task);
        let identity = super::runs::job_identity(&input, &snapshot);
        // What earlier runs of the same Job suggest, read before it is in the
        // table and kept with it, its request beside it (YN-6 S2).
        let query = super::suggestion::Query { task_id: input.task_id.clone(), name: input.name.clone(), argv: input.argv.clone() };
        let suggestion = super::suggestion::for_job(&tx, &query, actor, input.resources.memory_mi_b)?;
        super::history::make_room(&tx, 1, &super::history::Keep::default())?;
        let mut value = new_job(self, &tx, actor, &input, snapshot, machine, capability)?;
        value["identity"] = identity;
        value["suggestion"] = suggestion;
        let value = insert_job(&tx, value)?;
        if let Some(link) = &input.service_link {
            crate::service_jobs::insert(&tx, value["id"].as_str().context("Job identity missing")?, link)?;
            // Another run taking over never inherits automatic retry (T-14).
            if input.service_control.is_none() {
                super::service_recovery::superseded(&tx, &link.service_id, &value)?;
            }
        }
        tx.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'job_submit',?2,?3,?4)",params![actor_key(actor),input.request_id,payload.to_string(),json!({"jobId":value["id"]}).to_string()])?;
        if let Some(guard) = &input.service_control {
            super::service_control::started(&tx, guard, &value, &self.instance)?;
        }
        let value = QueueState::read(&tx)?.view(value);
        tx.commit()?;
        Ok(value)
    }

    pub(super) fn job(&self, id: &str) -> Result<Value> {
        let db = self.db.read()?;
        Ok(QueueState::read(&db)?.view(get(&db, id)?))
    }
    pub(super) fn list_jobs(
        &self,
        agent: Option<&str>,
        task: Option<&str>,
        before: Option<i64>,
    ) -> Result<Value> {
        let db = self.db.read()?;
        let queue = QueueState::read(&db)?;
        let task = task
            .map(|t| collaboration::task_key(&db, t).map(|v| v.0))
            .transpose()?;
        let mut q = db.prepare("SELECT id FROM local_jobs WHERE (?1 IS NULL OR agent_id=?1) AND (?2 IS NULL OR task_id=?2) AND seq<?3 ORDER BY seq DESC LIMIT 51")?;
        let ids = q
            .query_map(params![agent, task, before.unwrap_or(i64::MAX)], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = ids.len() > 50;
        let jobs = ids
            .iter()
            .take(50)
            .map(|id| get(&db, id).map(|job| summary(queue.view(current_ref(&db, job)))))
            .collect::<Result<Vec<_>>>()?;
        // The bounded live queue must remain visible even when its sequence is
        // older than the newest history page (long jobs can span many completions).
        let mut live = db.prepare("SELECT id FROM local_jobs WHERE (reserved=1 OR status IN ('queued','waiting')) AND (?1 IS NULL OR agent_id=?1) AND (?2 IS NULL OR task_id=?2) ORDER BY reserved DESC,seq LIMIT 204")?;
        let live_ids = live
            .query_map(params![agent, task], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let live_jobs = live_ids
            .iter()
            .map(|id| get(&db, id).map(|job| summary(queue.view(current_ref(&db, job)))))
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"jobs":jobs,"liveJobs":live_jobs,"hasMore":more,"nextBefore":jobs.last().map(|j|j["cursor"].clone())}),
        )
    }
    /// Each Agent's unfinished jobs: queued or still holding a reservation,
    /// the same live set the Jobs list keeps visible, with those whose outcome
    /// is unknown counted apart, and the name of the oldest of the others
    /// (the rail's "waiting on a Job: …", YN-51). One row per Agent; finished
    /// history and job details are not read.
    pub(super) fn live_job_counts(&self) -> Result<Value> {
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT agent_id,COUNT(*),SUM(status='unknown'),
               (SELECT o.data ->> '$.name' FROM local_jobs o WHERE o.agent_id=j.agent_id
                  AND (o.reserved=1 OR o.status IN ('queued','waiting')) AND o.status!='unknown' ORDER BY o.seq LIMIT 1)
             FROM local_jobs j WHERE reserved=1 OR status IN ('queued','waiting') GROUP BY agent_id",
        )?;
        let mut agents = serde_json::Map::new();
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })? {
            let (agent, active, unknown, name) = row?;
            let mut counts = json!({"active":active,"unknown":unknown});
            if let Some(name) = name {
                counts["name"] = json!(name);
            }
            agents.insert(agent, counts);
        }
        Ok(json!({ "agents": agents }))
    }
    pub(super) fn active_jobs(&self) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare("SELECT id FROM local_jobs WHERE reserved=1 AND json_extract(data,'$.executor') IS NULL ORDER BY seq")?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter().map(|id| get(&db, id)).collect()
    }
    /// The queued Jobs admission tries next, in its order, with their working
    /// directories (each needs its own free-space check).
    pub(super) fn queued_candidates(&self) -> Result<Vec<(String, String)>> {
        let db = self.db.read()?;
        let queued = super::queue::queued(&db)?;
        let last = super::queue::last_project(&db)?;
        Ok(super::queue::order(&queued, last.as_deref())
            .into_iter()
            .map(|i| (queued[i].id.clone(), queued[i].cwd.clone()))
            .collect())
    }
    /// Whether any queued or reserved Job declares a GPU.
    pub(super) fn gpu_jobs_live(&self) -> Result<bool> {
        let db = self.db.read()?;
        Ok(db.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_jobs WHERE (status='queued' OR reserved=1)
             AND json_extract(data,'$.gpu') IS NOT NULL)",
            [],
            |r| r.get(0),
        )?)
    }
    /// The working directories of queued and running Jobs on this host, at
    /// most 16 (a remote job's are on its machine).
    pub(super) fn live_job_cwds(&self) -> Result<Vec<String>> {
        let db = self.db.read()?;
        let mut q = db.prepare("SELECT json_extract(data,'$.cwd') AS cwd FROM local_jobs WHERE (reserved=1 OR status IN ('queued','waiting')) AND cwd IS NOT NULL AND json_extract(data,'$.executor') IS NULL GROUP BY cwd ORDER BY MIN(seq) LIMIT 16")?;
        let cwds = q.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(cwds)
    }
    pub(super) fn job_disk_reserve(&self) -> Result<Option<u64>> {
        let reserve: Option<Option<i64>> = self.db.read()?
            .query_row("SELECT reserve_gib FROM local_job_disk WHERE id=1", [], |r| r.get(0))
            .optional()?;
        Ok(reserve.flatten().and_then(|gib| u64::try_from(gib).ok()))
    }
    /// None returns to the default reserve.
    pub(super) fn set_job_disk_reserve(&self, gib: Option<u64>) -> Result<Option<u64>> {
        if let Some(gib) = gib {
            ensure!((super::disk::MIN_RESERVE_GIB..=super::disk::MAX_RESERVE_GIB).contains(&gib),
                "The disk reserve must be {}–{} GiB", super::disk::MIN_RESERVE_GIB, super::disk::MAX_RESERVE_GIB);
        }
        self.db.write()?.execute(
            "INSERT INTO local_job_disk(id,reserve_gib) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET reserve_gib=excluded.reserve_gib",
            params![gib.map(|g| g as i64)],
        )?;
        Ok(gib)
    }
    pub(super) fn reserve_next_job(
        &self,
        host_memory_available: Option<u64>,
        host: Option<Value>,
        disk: Option<&[super::DiskCheck]>,
    ) -> Result<Option<Value>> {
        Ok(self.reserve_next(host_memory_available, host, disk)?.0)
    }
    /// At Core start, once the Jobs table exists and before the queue runs
    /// (T-14): a service's automatic retry still queued without a reservation
    /// was queued by an earlier Core and never starts. It is rejected now, as
    /// reservation would reject it, not once its delay has passed: until then
    /// it would keep the service from a manual Start. A retry already
    /// reserved, and every other Job, is left as it is.
    pub(crate) fn reject_earlier_core_retries(&self) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut q = tx.prepare("SELECT id FROM local_jobs WHERE status='queued' AND reserved=0
            AND json_extract(data,'$.executor') IS NULL AND json_type(data,'$.recoveryOf')='object' ORDER BY seq")?;
        let ids = q.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(q);
        for id in ids {
            let mut job = get(&tx, &id)?;
            if job["recoveryOf"]["coreInstance"] != json!(self.instance) {
                let (code, reason) = super::service_recovery::EARLIER_CORE;
                refuse_retry(self, &tx, &mut job, code, reason)?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    /// Try the queued jobs in admission order and reserve the first that fits:
    /// its own free-space verdict, the shared CPU/RAM/swap budget, a slot,
    /// host memory and the GPUs it declares, all checked and reserved for the
    /// same job in one transaction.
    ///
    /// The blocked head (T-38) is decided before anything is reserved: the
    /// first job in this order short of the configured budget, wherever the
    /// projects' turns put it (review e06d83e8). Every other job, before or
    /// after it in the order, may start ahead of it only if it fits what is
    /// free now and, in every dimension, it and every job still holding a
    /// reservation it got by starting ahead of a head (any head: which job is
    /// the head can change between passes, with the projects' turns, aging or
    /// a cancel) stay within the budget less this head's need (`BlockedHead`).
    /// The head keeps its place: it is marked `admission.head` while it waits
    /// (never `passed`, so it is never counted as a passer), and once a job so
    /// marked fits, it is tried before the turns, the earliest submitted
    /// first, and starts unmarked; a head cancelled in the queue keeps no mark.
    /// An older blocked head wins: a former head goes first only if it was
    /// submitted before the current head, and a younger one waits for the
    /// current head's room (review fe5c0325).
    /// So no head's share is taken, and the head starts once the jobs running
    /// before it free enough. A job short of host memory
    /// (free less headroom) is not a reservation that can be held open, so
    /// nothing passes it. A job waiting for a GPU holds only that device, a
    /// disk wait is skipped, an exclusive job holds everything, and stages
    /// waiting on upstream are not queued at all.
    ///
    /// The same transaction reads which queued Jobs wait for CPU (YN-6,
    /// `cpu_waiting`): after the job it reserves, for that job's grant, and
    /// when it reserves none, to plan the raises of running elastic Jobs if
    /// none does. Returns the reserved job, whether any waiting reason
    /// changed, and those raises (none when a job was reserved).
    #[allow(clippy::type_complexity)]
    pub(super) fn reserve_next(
        &self,
        host_memory_available: Option<u64>,
        host: Option<Value>,
        disk: Option<&[super::DiskCheck]>,
    ) -> Result<(Option<Value>, bool, Vec<(Value, super::cpu::Raise, u64)>)> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let queued = super::queue::queued(&tx)?;
        if queued.is_empty() {
            return Ok((None, false, Vec::new()));
        }
        let last = super::queue::last_project(&tx)?;
        let order = super::queue::order(&queued, last.as_deref());
        let state = QueueState::read(&tx)?;
        let limit = budget(&tx, None)?;
        let (used, count) = reserved(&tx)?;
        let gpus = super::gpu::view(&tx)?;
        // Conditions that hold every candidate alike: each is told the real
        // cause rather than that it waits behind the first one.
        let global = if !used.fits(&limit) {
            Some(format!("Waiting for outstanding reservations to fit the lowered budget: reserved {} mCPU / {} MiB RAM / {} MiB swap; budget {} mCPU / {} MiB RAM / {} MiB swap",
                used.cpu_millis, used.memory_mi_b, used.swap_mi_b,
                limit.cpu_millis, limit.memory_mi_b, limit.swap_mi_b))
        } else if count >= max_active(&tx)? {
            Some("Waiting for an execution/collector slot".to_owned())
        } else {
            None
        };
        let mut held: std::collections::HashSet<String> = std::collections::HashSet::new();
        // A job short of host memory: nothing passes it.
        let mut behind: Option<String> = None;
        let free = limit.available(&used);
        // Before anything is reserved, in the same order: the head, the first
        // job short of the configured budget, and `first`, a job that was a
        // head and fits now, which goes before the turns. A job the scan below
        // rejects, skips or holds for another cause (a disk wait, an exclusive
        // slot, host memory, a GPU) is not a head.
        let mut head: Option<BlockedHead> = None;
        let mut head_seq: Option<i64> = None;
        let mut first: Option<(i64, usize, String)> = None;
        if global.is_none() && !state.exclusive_active {
            for &index in &order {
                let candidate = &queued[index];
                if candidate.exclusive && state.active > 0 {
                    break;
                }
                let Some(job) = self.tried(&tx, candidate, host.as_ref(), disk, false)? else {
                    continue;
                };
                let need: Resources = serde_json::from_value(job["reservation"].clone())?;
                match budget_shortage(&need, &free) {
                    Some((waits, _)) => {
                        if head.is_none() {
                            let name = job["name"].as_str().unwrap_or("an earlier job").to_owned();
                            head = Some(BlockedHead::new(&tx, &candidate.id, name, waits, &need, &limit)?);
                            head_seq = Some(candidate.seq);
                        }
                    }
                    None => {
                        if job["admission"]["head"].is_object() && first.as_ref().is_none_or(|(seq, _, _)| candidate.seq < *seq) {
                            first = Some((candidate.seq, index, candidate.id.clone()));
                        }
                    }
                }
            }
            // An older blocked head wins: a younger former head waits for the
            // current head's room like any other job (review fe5c0325).
            if first.as_ref().zip(head_seq).is_some_and(|((seq, _, _), head)| *seq > head) {
                first = None;
            }
        }
        let order: Vec<usize> = match &first {
            Some((_, index, _)) => std::iter::once(*index).chain(order.into_iter().filter(|i| i != index)).collect(),
            None => order,
        };
        let first = first.map(|(_, _, id)| id);
        let mut changed = false;
        let wait = |job: &mut Value, reason: String, changed: &mut bool| -> Result<()> {
            if job["reason"].as_str() != Some(reason.as_str()) {
                job["reason"] = json!(reason);
                save(&tx, job)?;
                *changed = true;
            }
            Ok(())
        };
        for &index in &order {
            let candidate = &queued[index];
            let mut job = get(&tx, &candidate.id)?;
            // Unknown, starting and cancelling reservations all still count. Only
            // host reconciliation after group cleanup can release exclusivity.
            if state.exclusive_active {
                break;
            }
            if let Some(name) = &behind {
                wait(&mut job, format!("Waiting behind {name}, which waits for host memory first; jobs do not pass it"), &mut changed)?;
                continue;
            }
            if let Some(host) = &host {
                if host["id"] != job["machine"]["id"] {
                    job["status"] = json!("rejected");
                    job["reason"] =
                        json!("Execution machine identity changed; command was not started");
                    job["finishedAt"] = json!(now());
                    notify(&tx, &mut job)?;
                    save(&tx, &job)?;
                    super::runs::job_changed(self, &tx, &job)?;
                    super::service_recovery::after_outcome(self, &tx, &mut job)?;
                    changed = true;
                    continue;
                }
            }
            let agent = self.brief_in(&tx, job["agentId"].as_str().unwrap())?;
            // An executor being released starts nothing: held, and refused at its close (T-36).
            if agent.as_ref().is_some_and(|v| v.agent.closed_at.is_none())
                && crate::executor_archiving::archiving(&tx, job["agentId"].as_str().unwrap())?.is_some()
            {
                wait(&mut job, "Held: its executor is being released; it is refused once the release closes it".into(), &mut changed)?;
                continue;
            }
            if agent.is_none_or(|v| v.agent.closed_at.is_some()) {
                job["status"] = json!("rejected");
                job["reason"] = json!(if crate::executor_release::release_of(&tx, job["agentId"].as_str().unwrap())?.is_some() {
                    "Its executor was released before launch: it starts nothing more; dispatch the task again for new work"
                } else {
                    "Agent closed before launch"
                });
                job["finishedAt"] = json!(now());
                notify(&tx, &mut job)?;
                save(&tx, &job)?;
                super::runs::job_changed(self, &tx, &job)?;
                super::service_recovery::after_outcome(self, &tx, &mut job)?;
                changed = true;
                continue;
            }
            // A service's automatic retry (T-14): one queued by an earlier Core
            // never starts, nor one with too little of its run's time left;
            // otherwise its timeout is cut to what remains.
            if let Some((code, reason)) = super::service_recovery::reservation(self, &mut job) {
                refuse_retry(self, &tx, &mut job, code, reason)?;
                changed = true;
                continue;
            }
            if candidate.exclusive && state.active > 0 {
                wait(&mut job, "Waiting for running jobs to finish and their process groups to be cleared".to_owned(), &mut changed)?;
                break;
            }
            // Each candidate has its own free-space verdict; one not read this
            // round waits for the next.
            if let Some(disk) = disk {
                match disk.iter().find(|d| d.job_id == candidate.id).map(|d| &d.verdict) {
                    None => continue,
                    Some(super::disk::Verdict::Start) => {}
                    Some(super::disk::Verdict::Wait(reason)) => {
                        wait(&mut job, reason.clone(), &mut changed)?;
                        continue;
                    }
                    // Its own working directory cannot be used: not started, so
                    // the next Job in line is not held behind it.
                    Some(super::disk::Verdict::Reject(reason)) => {
                        job["status"] = json!("rejected");
                        job["reason"] = json!(reason);
                        job["finishedAt"] = json!(now());
                        notify(&tx, &mut job)?;
                        save(&tx, &job)?;
                        super::runs::job_changed(self, &tx, &job)?;
                        super::service_recovery::after_outcome(self, &tx, &mut job)?;
                        changed = true;
                        continue;
                    }
                }
            }
            if let Some(reason) = &global {
                wait(&mut job, reason.clone(), &mut changed)?;
                continue;
            }
            let need: Resources = serde_json::from_value(job["reservation"].clone())?;
            let own_turn = first.as_deref() == Some(candidate.id.as_str());
            if let Some(head) = head.as_ref().filter(|h| h.id != candidate.id && !own_turn) {
                // Beside the blocked head, before or after it in the order:
                // only within what it leaves.
                let room = head.room(&free);
                if !need.fits(&room) {
                    wait(&mut job, format!("Waiting behind {}, which waits for {}: this job needs {}; {} may start ahead of it now",
                        head.name, head.waits, triple(&need), triple(&room)), &mut changed)?;
                    continue;
                }
            }
            // What the job is short of: the configured budget (a dimension it
            // waits for), or host memory (None).
            let shortage = match budget_shortage(&need, &free) {
                Some((waits, reason)) => Some((Some(waits), reason)),
                None if host_memory_available.is_some_and(|n| need.memory_mi_b > n) => Some((None, format!("Waiting for host memory while preserving Core/desktop headroom: needs {} MiB including collector, {} MiB available after headroom; short {} MiB", need.memory_mi_b, host_memory_available.unwrap(), need.memory_mi_b - host_memory_available.unwrap()))),
                None => None,
            };
            if let Some((waits, reason)) = shortage {
                let name = job["name"].as_str().unwrap_or("an earlier job").to_owned();
                let reason = match waits {
                    // Host memory is not held for anyone: nothing passes it.
                    None => {
                        behind = Some(name);
                        reason
                    }
                    Some(waits) => {
                        // The head decided above (or, should the scan meet a
                        // job short of the budget it did not, this one).
                        if head.is_none() {
                            head = Some(BlockedHead::new(&tx, &candidate.id, name, waits, &need, &limit)?);
                        }
                        match head.as_ref().filter(|h| h.id == candidate.id) {
                            Some(blocked) => {
                                // It keeps its place: once it fits, it goes first.
                                if !job["admission"]["head"].is_object() {
                                    job["admission"] = json!({"head": {"since": now()}});
                                    save(&tx, &job)?;
                                    changed = true;
                                }
                                format!("{reason}. Up to {} may start ahead of it meanwhile", triple(&blocked.allowance))
                            }
                            None => reason,
                        }
                    }
                };
                wait(&mut job, reason, &mut changed)?;
                continue;
            }
            let reservation = match serde_json::from_value::<Option<super::gpu::GpuRequest>>(job["gpu"].clone())? {
                None => None,
                Some(request) => match super::gpu::fit(&request, &gpus, &held) {
                    Ok(devices) => Some(devices),
                    Err((reason, wanted)) => {
                        wait(&mut job, reason, &mut changed)?;
                        held.extend(wanted);
                        continue;
                    }
                },
            };
            // What the Jobs holding the budget hold of its CPU before this one
            // holds any: its grant's free (T-64).
            let held_cpu = super::cpu::held(&tx)?;
            job["reserved"] = json!(true);
            // A queued job has not started: bind its attempt to the boot at reservation,
            // not the earlier submission boot. Started attempts never get rebound.
            if let Some(host) = &host {
                job["bootId"] = host["bootId"].clone();
            }
            if let Some(devices) = reservation {
                job["gpuReservation"] = json!(devices);
            }
            job["status"] = json!("starting");
            job["startedAt"] = json!(now());
            job["reason"] = json!("Capacity reserved; verifying and launching one attempt");
            // Started ahead of the blocked head: marked with it, so the jobs
            // that pass it stay within what its need leaves (T-38). Each
            // reservation decides the mark afresh: one in its own turn keeps
            // none from an earlier reservation (review 8a776cd8).
            if let Some(head) = head.as_ref().filter(|_| !own_turn) {
                let room = head.room(&free);
                job["admission"] = json!({"passed": {"jobId": head.id, "name": head.name, "waits": head.waits,
                    "headNeed": head.need, "room": room, "need": need, "at": now()}});
                job["reason"] = json!(format!("Capacity reserved ahead of {}, which waits for {}: this job's {} fits in the {} left beside it; verifying and launching one attempt",
                    head.name, head.waits, triple(&need), triple(&room)));
            } else if let Some(fields) = job.as_object_mut() {
                fields.remove("admission");
            }
            save(&tx, &job)?;
            // Its CPU within what it asked for (T-64): its minimum while
            // another queued Job waits for CPU once this one holds its
            // reservation, slot and GPUs (YN-6), read in this transaction.
            let waiting = self.cpu_waiting(&tx, &queued, &order, Some(&candidate.id), first.as_deref(), host_memory_available, host.as_ref(), disk)?;
            super::cpu::record_grant(&mut job, limit.cpu_millis, held_cpu, queued.len().saturating_sub(1), &waiting, max_active(&tx)?)?;
            save(&tx, &job)?;
            super::queue::served(&tx, &candidate.project)?;
            super::queue::record_cpu_waiting(&tx, &waiting)?;
            tx.commit()?;
            return Ok((Some(job), true, Vec::new()));
        }
        // Nothing starts. With no queued Job waiting for CPU, running elastic
        // Jobs may take what is free (YN-6): planned here, in the transaction
        // that found none, so a Job queued after it is seen by the next pass.
        let waiting = self.cpu_waiting(&tx, &queued, &order, None, first.as_deref(), host_memory_available, host.as_ref(), disk)?;
        super::queue::record_cpu_waiting(&tx, &waiting)?;
        let raises = if waiting.is_empty() { super::cpu::planned(&tx)? } else { Vec::new() };
        tx.commit()?;
        Ok((None, changed, raises))
    }

    /// Whether the scan tries `candidate` at all, with its record when it
    /// does: its own free-space verdict lets it start, it runs on this
    /// machine, its Agent is open and not being released, and (a service's
    /// automatic retry) it may still start. A Job it does not try is rejected,
    /// held or left for the next round there, and is never a head.
    ///
    /// With `unread_starts`, a Job with no free-space verdict this round (one
    /// queued after the round's reads) is tried as if it had one that lets it
    /// start: `cpu_waiting` holds raises one tick too long for such a Job
    /// rather than miss one that fits (YN-6 S1, #676 R1).
    fn tried(&self, tx: &Connection, candidate: &super::queue::Queued, host: Option<&Value>, disk: Option<&[super::DiskCheck]>, unread_starts: bool) -> Result<Option<Value>> {
        if let Some(disk) = disk {
            match disk.iter().find(|d| d.job_id == candidate.id).map(|d| &d.verdict) {
                Some(super::disk::Verdict::Start) => {}
                None if unread_starts => {}
                _ => return Ok(None),
            }
        }
        let job = get(tx, &candidate.id)?;
        let agent = job["agentId"].as_str().unwrap_or("");
        if host.is_some_and(|h| h["id"] != job["machine"]["id"])
            || self.brief_in(tx, agent)?.is_none_or(|v| v.agent.closed_at.is_some())
            || crate::executor_archiving::archiving(tx, agent)?.is_some()
            || super::service_recovery::reservation(self, &mut job.clone()).is_some()
        {
            return Ok(None);
        }
        Ok(Some(job))
    }

    /// The queued Jobs in `order`, other than `except`, that wait for CPU now
    /// (YN-6): only CPU, or nothing, keeps each from starting, so it would
    /// start if its CPU need were zero. One that fits and waits only for its
    /// turn counts. Read in the admission transaction after what it reserved,
    /// with the scan's own checks in the scan's order (`own_turn` is the
    /// former head that goes first, outside any head's room), changing
    /// nothing; a Job queued after the round's free-space reads is read as if
    /// its disk let it start. Not one: a Job the scan does not try, one behind
    /// an exclusive Job or behind a Job short of host memory, or one waiting for a slot or
    /// a lowered budget, for RAM or swap (of what is free, or of what a
    /// blocked head leaves), for host memory or for a GPU. In admission order.
    #[allow(clippy::too_many_arguments)]
    fn cpu_waiting(
        &self,
        tx: &Connection,
        queued: &[super::queue::Queued],
        order: &[usize],
        except: Option<&str>,
        own_turn: Option<&str>,
        host_memory_available: Option<u64>,
        host: Option<&Value>,
        disk: Option<&[super::DiskCheck]>,
    ) -> Result<Vec<String>> {
        let state = QueueState::read(tx)?;
        let limit = budget(tx, None)?;
        let (used, count) = reserved(tx)?;
        if state.exclusive_active || !used.fits(&limit) || count >= max_active(tx)? {
            return Ok(Vec::new());
        }
        let free = limit.available(&used);
        // The Jobs the scan tries, in its order, with what each needs.
        let mut tried = Vec::new();
        for &index in order {
            let candidate = &queued[index];
            if candidate.exclusive && state.active > 0 {
                break;
            }
            if except == Some(candidate.id.as_str()) {
                continue;
            }
            let Some(job) = self.tried(tx, candidate, host, disk, true)? else {
                continue;
            };
            // Rejected by the scan this round: no longer queued.
            if job["status"] != "queued" {
                continue;
            }
            let need: Resources = serde_json::from_value(job["reservation"].clone())?;
            tried.push((job, need));
        }
        // The head as the scan holds it: the first of them short of the budget.
        let head = match tried.iter().find_map(|(job, need)| budget_shortage(need, &free).map(|(waits, _)| (job, need, waits))) {
            Some((job, need, waits)) => Some(BlockedHead::new(tx, job["id"].as_str().unwrap_or(""), String::new(), waits, need, &limit)?),
            None => None,
        };
        let gpus = super::gpu::view(tx)?;
        let mut held: std::collections::HashSet<String> = std::collections::HashSet::new();
        let short_of_host = |need: &Resources| host_memory_available.is_some_and(|n| need.memory_mi_b > n);
        let mut waiting = Vec::new();
        for (job, need) in &tried {
            let id = job["id"].as_str().unwrap_or("");
            let room = match head.as_ref().filter(|h| h.id != id && own_turn != Some(id)) {
                Some(head) => head.room(&free),
                None => free.clone(),
            };
            let gpu: Option<super::gpu::GpuRequest> = serde_json::from_value(job["gpu"].clone())?;
            if need.fits(&room) {
                // As the scan: host memory, then the GPUs.
                if short_of_host(need) {
                    // Nothing passes it.
                    break;
                }
                if let Some(request) = &gpu {
                    if let Err((_, wanted)) = super::gpu::fit(request, &gpus, &held) {
                        held.extend(wanted);
                        continue;
                    }
                }
                // It waits only for its turn.
                waiting.push(id.to_owned());
            } else if (Resources { cpu_millis: 0, ..need.clone() }).fits(&room)
                && !short_of_host(need)
                && gpu.as_ref().is_none_or(|request| super::gpu::fit(request, &gpus, &held).is_ok())
            {
                // Only CPU keeps it.
                waiting.push(id.to_owned());
            }
        }
        Ok(waiting)
    }
    pub(super) fn request_job_cancel(&self, actor: Option<&str>, id: &str) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let job = request_cancel_in(self, &tx, actor, id)?;
        tx.commit()?;
        Ok(job)
    }
    pub(super) fn update_job_evidence(&self, id: &str, evidence: Value) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        if job["reserved"] != true {
            return Ok(false);
        }
        ensure!(
            evidence["jobId"] == job["id"] && evidence["attempt"] == job["attempt"],
            "Machine evidence belongs to a different job attempt"
        );
        let status = evidence["status"]
            .as_str()
            .context("Missing evidence status")?
            .to_owned();
        ensure!(
            matches!(
                status.as_str(),
                "running"
                    | "succeeded"
                    | "failed"
                    | "cancelled"
                    | "interrupted"
                    | "rejected"
                    | "unknown"
            ),
            "Invalid job evidence status"
        );
        if status == "running" && job["status"] == "cancelling" {
            return Ok(false);
        }
        // The command's own start (T-14) can follow the worker's: a later
        // reading that newly carries this attempt's record of it is taken
        // once; any other repeat changes nothing.
        let created = |command: &Value| command["attempt"] == job["attempt"] && command["pid"].is_i64();
        if status == "running"
            && job["status"] == "running"
            && !(created(&evidence["command"]) && !created(&job["result"]["command"]))
        {
            return Ok(false);
        }
        if status == "unknown" && job["status"] == "unknown" && job["reason"] == evidence["reason"]
        {
            return Ok(false);
        }
        job["status"] = json!(status);
        job["reason"] = evidence["reason"].clone();
        // Killed for memory after its limit was lowered (T-38 B): say so.
        if evidence["evidence"]["systemd"]["Result"] == "oom-kill" {
            if let Some(reason) = super::limit::oom_after_limit(&job) {
                job["reason"] = json!(reason);
            }
        }
        if let Some(at) = evidence["started"]["at"]
            .as_f64()
            .filter(|at| at.is_finite())
            .and_then(|at| chrono::DateTime::from_timestamp_millis((at * 1000.0) as i64))
        {
            job["startedAt"] = json!(at.to_rfc3339());
        }
        let finished_at = evidence["finishedAtUnix"]
            .as_f64()
            .filter(|at| at.is_finite())
            .and_then(|at| chrono::DateTime::from_timestamp_millis((at * 1000.0) as i64))
            .map(|at| at.to_rfc3339());
        job["result"] = evidence;
        if matches!(
            status.as_str(),
            "succeeded" | "failed" | "cancelled" | "interrupted" | "rejected"
        ) {
            job["reserved"] = json!(false);
            job["finishedAt"] = json!(finished_at.unwrap_or_else(now));
        }
        super::checkpoint::settle(&mut job);
        if job["run"].is_object() {
            if matches!(status.as_str(), "failed" | "interrupted") {
                super::runs::auto_retry(&tx, &mut job)?;
            }
            save(&tx, &job)?;
            super::runs::job_changed(self, &tx, &job)?;
        }
        // A service run's automatic retry (T-14) reads this Job as ended and
        // unreserved: it is saved so first, then the retry, if any, is added
        // in this same transaction.
        if job["service"].is_object() {
            save(&tx, &job)?;
            super::service_recovery::after_outcome(self, &tx, &mut job)?;
        }
        notify(&tx, &mut job)?;
        save(&tx, &job)?;
        tx.commit()?;
        Ok(true)
    }
    /// Not started, for certain: the reservation is released and the Agent told.
    pub(super) fn job_not_started(&self, id: &str, reason: &str) -> Result<bool> {
        let job = self.job(id)?;
        self.update_job_evidence(id,json!({"jobId":id,"attempt":job["attempt"],"status":"rejected","reason":reason,"evidence":{"coreObservation":true,"notStarted":true}}))
    }
    pub(super) fn job_unknown(&self, id: &str, reason: &str) -> Result<bool> {
        let job = self.job(id)?;
        self.update_job_evidence(id,json!({"jobId":id,"attempt":job["attempt"],"status":"unknown","reason":reason,"evidence":{"coreObservation":true}}))
    }
    pub(super) fn job_budget_view(&self, machine: Value) -> Result<Value> {
        let db = self.db.read()?;
        let limit = budget(&db, Some(&machine["suggestedBudget"]))?;
        let (used, count) = reserved(&db)?;
        let queued: i64 = db.query_row(
            "SELECT COUNT(*) FROM local_jobs WHERE status='queued' AND json_extract(data,'$.executor') IS NULL",
            [],
            |r| r.get(0),
        )?;
        // Jobs that exist but wait for an earlier stage of their run or for
        // its analysis (T-69): in neither the queue nor the running count. Not
        // those stuck behind a failed or unknown stage or the cost limit.
        let waiting = super::runs::waiting_count(&db)?;
        let available = limit.available(&used);
        // Hints for choosing a CPU range (T-64), as the grant rule reads them now.
        let cpu_free = limit.cpu_millis.saturating_sub(super::cpu::held(&db)?);
        // Which queued Jobs wait for CPU, as the last admission pass found
        // (YN-6); none with nothing queued, unknown before any pass.
        let saved = super::queue::saved_cpu_waiting(&db)?;
        let cpu_waiting = if queued == 0 {
            json!({"count": 0, "since": null})
        } else {
            json!({"count": saved["count"], "since": saved["since"]})
        };
        let running: i64 = db.query_row(
            "SELECT COUNT(*) FROM local_jobs WHERE status='running' AND json_extract(data,'$.executor') IS NULL",
            [],
            |r| r.get(0),
        )?;
        let mut capacity = super::resource_summary::capacity(&limit, &available, &machine);
        capacity["snapshot"]["observedAt"] = json!(now());
        let windows_cap = windows_max_jobs(&db)?;
        let windows_active: i64 = db.query_row(
            "SELECT COUNT(*) FROM local_jobs WHERE reserved=1 AND json_extract(data,'$.executor.kind')='windows'",
            [],
            |r| r.get(0),
        )?;
        // Windows on this PC: its own ceiling, inside this same budget.
        let windows = json!({"maxJobs": windows_cap.map_or(super::remote::SLOTS, i64::from), "set": windows_cap.is_some(),
            "defaultMaxJobs": super::remote::SLOTS, "activeCount": windows_active, "sharesThisBudget": true});
        Ok(
            json!({"machine":machine,"budget":limit,"budgetBounds":{"minimum":super::BUDGET_MIN,"maximum":super::BUDGET_MAX},"reserved":used,"available":available,"requestCapacity":capacity,"activeCount":count,"queuedCount":queued,"waitingCount":waiting,"maxActive":max_active(&db)?,"maxActiveSet":saved_max_active(&db)?.is_some(),"maxActiveDefault":DEFAULT_MAX_ACTIVE,"maxActiveBounds":{"minimum":MAX_ACTIVE_RANGE.start(),"maximum":MAX_ACTIVE_RANGE.end()},"cpuMillisFree":cpu_free,"queueLength":queued,"cpuWaiting":cpu_waiting,"running":running,"cpuHint":CPU_HINT,"windows":windows,"collectorOverhead":{"cpuMillis":super::COLLECTOR_CPU,"memoryMiB":super::COLLECTOR_MEMORY,"swapMiB":0},"gpus":super::gpu::devices_value(&db)?}),
        )
    }
    /// A budget save that leaves maxActive as it is (tests; the route takes both).
    #[cfg(test)]
    pub(super) fn set_job_budget(&self, value: Resources) -> Result<Value> {
        self.set_job_budget_with(value, None)
    }
    /// The budget, and with `slots` how many of this host's own Jobs run at
    /// once (None leaves it, Some(None) returns it to the default), in one
    /// transaction (T-55).
    pub(super) fn set_job_budget_with(&self, value: Resources, slots: Option<Option<u32>>) -> Result<Value> {
        ensure!(
            slots.flatten().is_none_or(|n| MAX_ACTIVE_RANGE.contains(&n)),
            "maxActive must be {}–{}, or null for the default ({DEFAULT_MAX_ACTIVE})",
            MAX_ACTIVE_RANGE.start(), MAX_ACTIVE_RANGE.end()
        );
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        // Budget edits affect admission only. Keep accepted jobs and their
        // snapshots intact, even when the new budget is below reservations.
        // The queue resumes once capacity is released or the budget is raised.
        // So does a lower maxActive: an attempt holding a slot keeps it.
        tx.execute("INSERT INTO local_job_settings(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[serde_json::to_string(&value)?])?;
        if let Some(saved) = slots {
            tx.execute(
                "INSERT INTO local_job_slots(id,max_active) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET max_active=excluded.max_active",
                [saved],
            )?;
        }
        tx.commit()?;
        // The answer stays the budget, as before; the view names maxActive.
        Ok(json!(value))
    }
    /// Set (or, with None, clear) the most Windows attempts at once. Like a
    /// budget edit it affects admission only: attempts holding a slot keep it.
    /// An older Core would ignore it, so a set cap keeps them out first.
    pub(super) fn set_windows_max_jobs(&self, max_jobs: Option<u32>) -> Result<Option<u32>> {
        ensure!(
            max_jobs.is_none_or(|n| super::remote::MAX_JOBS_RANGE.contains(&n)),
            "maxJobs for Windows must be 1–64, or null for the default ({})",
            super::remote::SLOTS
        );
        let _kept_out = self.keep_older_cores_out_for(max_jobs.map(|n| format!("Windows Jobs have a concurrency cap ({n})")))?;
        self.db.write()?.execute(
            "INSERT INTO local_job_windows(id,max_jobs) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET max_jobs=excluded.max_jobs",
            [max_jobs],
        )?;
        Ok(max_jobs)
    }
    /// Whether this host's Jobs budget is saved (`init_job_budget`, or the user's).
    pub(super) fn job_budget_saved(&self) -> Result<bool> {
        Ok(self.db.read()?.query_row("SELECT EXISTS(SELECT 1 FROM local_job_settings WHERE id=1)", [], |r| r.get(0))?)
    }

    /// Store this host's suggested budget if none is stored yet, as its first
    /// local job does; a stored budget is never replaced here.
    pub(super) fn init_job_budget(&self, suggested: &Value) -> Result<()> {
        let value: Resources = serde_json::from_value(suggested.clone()).context("This host has no suggested Jobs budget")?;
        self.db.write()?.execute(
            "INSERT OR IGNORE INTO local_job_settings(id,data) VALUES(1,?1)",
            [serde_json::to_string(&value)?],
        )?;
        Ok(())
    }
}
