use super::{Resources, Submit, MAX_ACTIVE};
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
        CREATE TABLE IF NOT EXISTS local_job_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_job_disk (id INTEGER PRIMARY KEY CHECK(id=1), reserve_gib INTEGER);
        -- The most Windows attempts at once on the PC this Core's WSL runs on;
        -- NULL (or no row) is the default. Kept apart from local_job_settings,
        -- whose document older Cores read strictly.
        CREATE TABLE IF NOT EXISTS local_job_windows (id INTEGER PRIMARY KEY CHECK(id=1), max_jobs INTEGER);")?;
    super::runs::migrate(db)?;
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
    let mut expected = serde_json::to_value(input)?;
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
    Ok(Some(QueueState::read(db)?.view(get(
        db,
        response["jobId"].as_str().context("Invalid job receipt")?,
    )?)))
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
    let public_task = format!("T-{}", collaboration::task_key(db, &task)?.1);
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
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM local_jobs", [], |r| r.get(0))?;
    ensure!(
        count < 5000,
        "Local job history limit reached (5000); this version has no automatic history pruning"
    );
    // Stages waiting for their upstream count as queued work too.
    let waiting: i64 = tx.query_row(
        "SELECT COUNT(*) FROM local_jobs WHERE status IN ('queued','waiting')",
        [],
        |r| r.get(0),
    )?;
    ensure!(waiting < 200, "Local job queue is full (200)");
    let remote = input.machine_id.is_some();
    let windows = input.machine_id.as_deref() == Some(super::remote::WINDOWS);
    let reservation = input.resources.reservation();
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
    value["taskRef"] = json!(format!("T-{}", collaboration::task_key(tx, &task)?.1));
    value["agentId"] = json!(agent_id);
    value["agent"] = json!(recipient);
    // The machine the submitting Agent runs on (null: this Core's host).
    value["agentMachine"] = json!(agent_machine);
    value["requestedBy"] = json!(author);
    value["source"] = source;
    value["machine"] = machine;
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
    tx.execute(
        "INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,?3,?4,?5)",
        params![value["id"].as_str(), value["taskId"].as_str(), value["agentId"].as_str(), value["status"].as_str(), value.to_string()],
    )?;
    value["cursor"] = json!(tx.last_insert_rowid());
    Ok(value)
}

impl Store {
    pub(super) fn previous_job(
        &self,
        actor: Option<&str>,
        input: &Submit,
    ) -> Result<Option<Value>> {
        previous(self, &*self.db.read()?, actor, input)
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
                let need = input.resources.reservation();
                ensure!(need.cpu_millis <= u64::from(limit.cpu_millis) && need.memory_mi_b <= u64::from(limit.memory_mib),
                    "Job can never fit this machine's Jobs budget ({} mCPU / {} MiB RAM, including 64 MiB / 100 millicore for its supervisor); reduce resources or change the machine's budget",
                    limit.cpu_millis, limit.memory_mib);
            }
        }
        let task = collaboration::task_key(&tx, &input.task_id)?.0;
        let mut payload = serde_json::to_value(&input)?;
        payload["taskId"] = json!(task);
        let identity = super::runs::job_identity(&input, &snapshot);
        let mut value = new_job(self, &tx, actor, &input, snapshot, machine, capability)?;
        value["identity"] = identity;
        let value = insert_job(&tx, value)?;
        tx.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'job_submit',?2,?3,?4)",params![actor_key(actor),input.request_id,payload.to_string(),json!({"jobId":value["id"]}).to_string()])?;
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
            .map(|id| get(&db, id).map(|job| summary(queue.view(job))))
            .collect::<Result<Vec<_>>>()?;
        // The bounded live queue must remain visible even when its sequence is
        // older than the newest history page (long jobs can span many completions).
        let mut live = db.prepare("SELECT id FROM local_jobs WHERE (reserved=1 OR status IN ('queued','waiting')) AND (?1 IS NULL OR agent_id=?1) AND (?2 IS NULL OR task_id=?2) ORDER BY reserved DESC,seq LIMIT 204")?;
        let live_ids = live
            .query_map(params![agent, task], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let live_jobs = live_ids
            .iter()
            .map(|id| get(&db, id).map(|job| summary(queue.view(job))))
            .collect::<Result<Vec<_>>>()?;
        Ok(
            json!({"jobs":jobs,"liveJobs":live_jobs,"hasMore":more,"nextBefore":jobs.last().map(|j|j["cursor"].clone())}),
        )
    }
    /// Each Agent's unfinished jobs: queued or still holding a reservation,
    /// the same live set the Jobs list keeps visible, with those whose outcome
    /// is unknown counted apart. One row per Agent; finished history and job
    /// details are not read.
    pub(super) fn live_job_counts(&self) -> Result<Value> {
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT agent_id,COUNT(*),SUM(status='unknown') FROM local_jobs
             WHERE reserved=1 OR status IN ('queued','waiting') GROUP BY agent_id",
        )?;
        let mut agents = serde_json::Map::new();
        for row in q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })? {
            let (agent, active, unknown) = row?;
            agents.insert(agent, json!({"active":active,"unknown":unknown}));
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
    /// Try the queued jobs in admission order and reserve the first that fits:
    /// its own free-space verdict, the shared CPU/RAM/swap budget, a slot,
    /// host memory and the GPUs it declares, all checked and reserved for the
    /// same job in one transaction. A job blocked by the shared budget is not
    /// passed (no backfill around it); a job waiting for a GPU holds only that
    /// device, so CPU work behind it can start. Returns the reserved job and
    /// whether any waiting reason changed.
    pub(super) fn reserve_next(
        &self,
        host_memory_available: Option<u64>,
        host: Option<Value>,
        disk: Option<&[super::DiskCheck]>,
    ) -> Result<(Option<Value>, bool)> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let queued = super::queue::queued(&tx)?;
        if queued.is_empty() {
            return Ok((None, false));
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
        } else if count >= MAX_ACTIVE {
            Some("Waiting for an execution/collector slot".to_owned())
        } else {
            None
        };
        let mut held: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut behind: Option<String> = None;
        let mut changed = false;
        let wait = |job: &mut Value, reason: String, changed: &mut bool| -> Result<()> {
            if job["reason"].as_str() != Some(reason.as_str()) {
                job["reason"] = json!(reason);
                save(&tx, job)?;
                *changed = true;
            }
            Ok(())
        };
        for index in order {
            let candidate = &queued[index];
            let mut job = get(&tx, &candidate.id)?;
            // Unknown, starting and cancelling reservations all still count. Only
            // host reconciliation after group cleanup can release exclusivity.
            if state.exclusive_active {
                break;
            }
            if let Some(name) = &behind {
                wait(&mut job, format!("Waiting behind {name}, which needs the shared CPU/RAM budget first; jobs do not pass it"), &mut changed)?;
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
                    changed = true;
                    continue;
                }
            }
            let agent = self.brief_in(&tx, job["agentId"].as_str().unwrap())?;
            if agent.is_none_or(|v| v.agent.closed_at.is_some()) {
                job["status"] = json!("rejected");
                job["reason"] = json!("Agent closed before launch");
                job["finishedAt"] = json!(now());
                notify(&tx, &mut job)?;
                save(&tx, &job)?;
                super::runs::job_changed(self, &tx, &job)?;
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
            let free = limit.available(&used);
            let shortage = if need.cpu_millis > free.cpu_millis {
                Some(format!("Waiting for shared CPU quota: needs {} mCPU including collector, {} mCPU available; short {} mCPU", need.cpu_millis, free.cpu_millis, need.cpu_millis - free.cpu_millis))
            } else if need.memory_mi_b > free.memory_mi_b {
                Some(format!("Waiting for shared RAM reservation: needs {} MiB including collector, {} MiB available; short {} MiB", need.memory_mi_b, free.memory_mi_b, need.memory_mi_b - free.memory_mi_b))
            } else if need.swap_mi_b > free.swap_mi_b {
                Some(format!(
                    "Waiting for shared swap reservation: needs {} MiB, {} MiB available; short {} MiB",
                    need.swap_mi_b,
                    free.swap_mi_b,
                    need.swap_mi_b - free.swap_mi_b
                ))
            } else if host_memory_available.is_some_and(|n| need.memory_mi_b > n) {
                Some(format!("Waiting for host memory while preserving Core/desktop headroom: needs {} MiB including collector, {} MiB available after headroom; short {} MiB", need.memory_mi_b, host_memory_available.unwrap(), need.memory_mi_b - host_memory_available.unwrap()))
            } else {
                None
            };
            if let Some(reason) = shortage {
                wait(&mut job, reason, &mut changed)?;
                behind = Some(job["name"].as_str().unwrap_or("an earlier job").to_owned());
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
            save(&tx, &job)?;
            super::queue::served(&tx, &candidate.project)?;
            tx.commit()?;
            return Ok((Some(job), true));
        }
        tx.commit()?;
        Ok((None, changed))
    }
    pub(super) fn request_job_cancel(&self, actor: Option<&str>, id: &str) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
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
            notify(&tx, &mut job)?;
        } else if job["reserved"] == true {
            if job["cancelRequestedAt"].is_null() {
                job["cancelRequestedAt"] = json!(now());
            }
            job["status"] = json!("cancelling");
            job["reason"] =
                json!("Cancellation requested; reservation held until process groups have exited");
        }
        save(&tx, &job)?;
        super::runs::job_changed(self, &tx, &job)?;
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
        if status == "running" && (job["status"] == "running" || job["status"] == "cancelling") {
            return Ok(false);
        }
        if status == "unknown" && job["status"] == "unknown" && job["reason"] == evidence["reason"]
        {
            return Ok(false);
        }
        job["status"] = json!(status);
        job["reason"] = evidence["reason"].clone();
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
        let available = limit.available(&used);
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
            json!({"machine":machine,"budget":limit,"budgetBounds":{"minimum":super::BUDGET_MIN,"maximum":super::BUDGET_MAX},"reserved":used,"available":available,"requestCapacity":capacity,"activeCount":count,"queuedCount":queued,"maxActive":MAX_ACTIVE,"windows":windows,"collectorOverhead":{"cpuMillis":super::COLLECTOR_CPU,"memoryMiB":super::COLLECTOR_MEMORY,"swapMiB":0},"gpus":super::gpu::devices_value(&db)?}),
        )
    }
    pub(super) fn set_job_budget(&self, value: Resources) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        // Budget edits affect admission only. Keep accepted jobs and their
        // snapshots intact, even when the new budget is below reservations.
        // The queue resumes once capacity is released or the budget is raised.
        tx.execute("INSERT INTO local_job_settings(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[serde_json::to_string(&value)?])?;
        tx.commit()?;
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
