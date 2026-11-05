//! Executor slots (T-35, executor model phase 2; docs/executor-model.md): how
//! many executors run at once, and the queue of those waiting to start.
//!
//! A template dispatch makes its executor and dispatches the task to it, but
//! no longer starts it: its row here is `waiting`. The scheduler starts the
//! next one when a slot is free. In one transaction it picks the next waiting
//! executor in the Jobs queue's order (jobs/queue.rs: those waiting longest
//! first, then Projects in turn), sets it `starting`, and its runtime then
//! starts outside the transaction. Once connected it is `running`.
//!
//! A slot is held from `starting` until the executor is closed, by anyone and
//! in any way. A disconnect or a Core restart keeps it, so a reconnect never
//! passes the limit, and an executor waiting in the queue cannot be started
//! any other way. A close releases the slot in the transaction that closes
//! the executor (`follow_agent`); a reopen queues it again. Every pass also
//! marks `released` the rows of executors that are closed or gone.
//!
//! The limits: the Workspace's (`executors.slots`, 3 unless saved), and
//! optionally a Project's (`executors.slots.project:<id>`) and a machine's
//! (`executors.slots.machine:<id>`); an unset one adds no limit of its own.
//! They count executors only, apart from the Jobs' machine slots.
//!
//! A start the runtime refused closes the executor (kept, to see what
//! happened) and frees its slot. One whose outcome is unknown (its runtime
//! may be running) keeps its slot as `starting`, and waits for the user.
use crate::{
    jobs::queue::{self, Queued},
    model::now,
    server::ApiError,
    store::Store,
    updates::admission::Permit,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Result};
use axum::{extract::{Path, Query, State as AxumState}, routing::{get, put}, Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, OnceLock}, time::Duration};

/// Executors running at once in the Workspace, unless the user saved another number.
pub(crate) const DEFAULT_SLOTS: i64 = 3;
pub(crate) const MAX_SLOTS: i64 = 64;
const KEY: &str = "executors.slots";

fn project_key(project: &str) -> String {
    format!("executors.slots.project:{project}")
}

pub(crate) fn machine_key(machine: &str) -> String {
    format!("executors.slots.machine:{machine}")
}

/// Runs on every open, with the collaboration tables. No column references
/// an Agent: a row stays when its Agent is deleted, and is then released.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS executor_slots(
            agent_id TEXT PRIMARY KEY,
            -- The queue's order: the order executors were dispatched in.
            seq INTEGER NOT NULL,
            task_id TEXT NOT NULL, project_id TEXT, machine_id TEXT NOT NULL, template_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('waiting','starting','running','released')),
            -- Since when it is in this state, and since when it first waited (the queue's aging).
            since TEXT NOT NULL, queued_at TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 1, reason TEXT);
        CREATE INDEX IF NOT EXISTS executor_slots_task ON executor_slots(task_id);
        CREATE INDEX IF NOT EXISTS executor_slots_state ON executor_slots(state);
        CREATE TABLE IF NOT EXISTS executor_queue_state(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);",
    )?;
    Ok(())
}

/// A saved limit: its version, moved on by every save, and its number; none
/// when it is not set. Read leniently: a value this Core can't use is unset.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Limit {
    version: i64,
    slots: Option<i64>,
}

fn limit_at(db: &Connection, key: &str) -> Result<Limit> {
    let raw: Option<String> = db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [key], |r| r.get(0)).optional()?;
    let Some(value) = raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
        return Ok(Limit::default());
    };
    Ok(Limit {
        version: value["version"].as_i64().unwrap_or(0),
        slots: value["slots"].as_i64().filter(|n| (1..=MAX_SLOTS).contains(n)),
    })
}

fn save_limit(db: &Connection, key: &str, expected: i64, slots: Option<i64>) -> Result<Limit> {
    let current = limit_at(db, key)?;
    ensure!(current.version == expected, "version_conflict: these executor slots changed; reload before saving");
    if let Some(n) = slots {
        ensure!((1..=MAX_SLOTS).contains(&n), "invalid_input: executors at once is a whole number from 1 to {MAX_SLOTS}");
    }
    let saved = Limit { version: current.version + 1, slots };
    db.execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, json!({"version": saved.version, "slots": slots}).to_string()],
    )?;
    Ok(saved)
}

fn workspace_slots(db: &Connection) -> Result<i64> {
    Ok(limit_at(db, KEY)?.slots.unwrap_or(DEFAULT_SLOTS))
}

/// The refusal to start an executor waiting in the queue. Nothing started or
/// changed, so it is not the Agent's failure (workspace.rs `record_failure`).
#[derive(Clone, Debug)]
pub(crate) struct WaitsForSlot(String);

impl std::fmt::Display for WaitsForSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WaitsForSlot {}

/// A waiting executor, as the queue orders it.
struct Waiting {
    agent: String,
    project: Option<String>,
    machine: String,
}

/// The waiting executors in queue order (jobs/queue.rs `order`, the Jobs
/// queue's own: aged first, then Projects in turn after the one served last).
/// That order covers a window (`queue::WINDOW`); the rest follow it in the
/// order they were dispatched, so each has a place in the queue.
fn queue_order(db: &Connection) -> Result<Vec<(Waiting, String)>> {
    let now = chrono::Utc::now();
    let mut q = db.prepare(
        "SELECT agent_id, seq, project_id, machine_id, queued_at FROM executor_slots WHERE state='waiting' ORDER BY seq",
    )?;
    let rows = q
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let queued: Vec<Queued> = rows
        .iter()
        .map(|(agent, seq, project, _, queued_at)| Queued {
            id: agent.clone(),
            seq: *seq,
            // Executors without a Project take their turn as one, in the
            // order they were dispatched (each is an Agent of its own).
            project: project.clone().unwrap_or_else(|| NO_PROJECT.to_owned()),
            waited_secs: chrono::DateTime::parse_from_rfc3339(queued_at)
                .map(|at| (now - at.with_timezone(&chrono::Utc)).num_seconds())
                .unwrap_or(0),
            exclusive: false,
            cwd: String::new(),
        })
        .collect();
    let mut order = queue::order(&queued, last_project(db)?.as_deref());
    let ordered: std::collections::HashSet<usize> = order.iter().copied().collect();
    order.extend((0..rows.len()).filter(|i| !ordered.contains(i)));
    Ok(order
        .into_iter()
        .map(|i| {
            let (agent, _, project, machine, _) = &rows[i];
            (Waiting { agent: agent.clone(), project: project.clone(), machine: machine.clone() }, queued[i].project.clone())
        })
        .collect())
}

/// The queue's key for executors without a Project: no Project's ID.
const NO_PROJECT: &str = "workspace";

fn last_project(db: &Connection) -> Result<Option<String>> {
    let raw: Option<String> = db.query_row("SELECT data FROM executor_queue_state WHERE id=1", [], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|r| serde_json::from_str::<Value>(&r).ok()).and_then(|v| v["lastProject"].as_str().map(str::to_owned)))
}

/// Frees the slot of every executor that is closed or gone: a close of any
/// kind, a release included, ends its row here, however it happened.
fn release_closed(db: &Connection) -> Result<usize> {
    Ok(db.execute(
        "UPDATE executor_slots SET state='released',since=?1,reason='closed'
         WHERE state!='released' AND NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=executor_slots.agent_id
           AND json_extract(a.data,'$.agent.closedAt') IS NULL)",
        [now()],
    )?)
}

/// A starting executor that is connected is running.
fn settle_connected(db: &Connection) -> Result<usize> {
    Ok(db.execute(
        "UPDATE executor_slots SET state='running',since=?1,reason=NULL
         WHERE state='starting' AND EXISTS(SELECT 1 FROM agents a WHERE a.id=executor_slots.agent_id
           AND json_extract(a.data,'$.agent.connectionState')='connected')",
        [now()],
    )?)
}

/// Whether a pass has anything to do, read without the writer.
fn pending(db: &Connection) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM executor_slots s WHERE s.state='waiting'
            OR (s.state!='released' AND NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=s.agent_id AND json_extract(a.data,'$.agent.closedAt') IS NULL))
            OR (s.state='starting' AND EXISTS(SELECT 1 FROM agents a WHERE a.id=s.agent_id AND json_extract(a.data,'$.agent.connectionState')='connected')))",
        [],
        |r| r.get(0),
    )?)
}

/// What holds a slot now (starting or running), in all and by Project and by machine.
fn holding(db: &Connection) -> Result<(i64, HashMap<String, i64>, HashMap<String, i64>)> {
    let mut q = db.prepare(
        "SELECT project_id, machine_id, COUNT(*) FROM executor_slots WHERE state IN ('starting','running') GROUP BY project_id, machine_id",
    )?;
    let (mut total, mut projects, mut machines) = (0, HashMap::new(), HashMap::new());
    for row in q.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))? {
        let (project, machine, n) = row?;
        total += n;
        if let Some(project) = project {
            *projects.entry(project).or_insert(0) += n;
        }
        *machines.entry(machine).or_insert(0) += n;
    }
    Ok((total, projects, machines))
}

/// An executor's slot row as the task card shows it, and its place in the
/// queue (1 first) while it waits.
/// A slot row as a task shows it: its executor, state, machine and reason.
type SlotRow = (String, String, String, Option<String>);

fn view_row(db: &Connection, task: &str, positions: &HashMap<String, usize>) -> Result<Option<Value>> {
    let row: Option<SlotRow> = db
        .query_row(
            "SELECT s.agent_id, s.state, s.machine_id, s.reason FROM executor_slots s
             WHERE s.task_id=?1 AND s.state!='released'
               AND EXISTS(SELECT 1 FROM agents a WHERE a.id=s.agent_id AND json_extract(a.data,'$.agent.closedAt') IS NULL)
             ORDER BY s.seq DESC LIMIT 1",
            [task],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    Ok(row.map(|(agent, state, machine, reason)| {
        let mut view = json!({"agentId": agent, "state": state, "machine": machine});
        if state == "waiting" {
            view["position"] = json!(positions.get(&agent));
        }
        if let Some(reason) = reason {
            view["reason"] = json!(reason);
        }
        view
    }))
}

fn positions(db: &Connection) -> Result<HashMap<String, usize>> {
    Ok(queue_order(db)?.into_iter().enumerate().map(|(i, (w, _))| (w.agent, i + 1)).collect())
}

/// Each listed task's executor slot, by task id, for the ones that have one
/// (collaboration_store task_list and task_get).
pub(crate) fn views(db: &Connection, tasks: &[&str]) -> Result<HashMap<String, Value>> {
    let mut out = HashMap::new();
    if tasks.is_empty() {
        return Ok(out);
    }
    let positions = positions(db)?;
    for task in tasks {
        if let Some(view) = view_row(db, task, &positions)? {
            out.insert((*task).to_owned(), view);
        }
    }
    Ok(out)
}

/// An executor's row follows its close and its reopen, in the transaction
/// that writes either (store.rs `change_locked`), so the two commit or fail
/// together: closed, its slot is released; reopened, it waits again, at the
/// end of the queue. One from before slots existed gets its row then.
pub(crate) fn follow_agent(db: &Connection, agent: &crate::model::Agent, kind: &str) -> Result<()> {
    if agent.closed_at.is_some() {
        db.execute(
            "UPDATE executor_slots SET state='released',since=?2,reason='closed' WHERE agent_id=?1 AND state!='released'",
            params![agent.id, now()],
        )?;
    } else if kind == "agent/reopened" {
        let seq: i64 = db.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM executor_slots", [], |r| r.get(0))?;
        let machine = agent.remote.as_ref().map_or("local", |remote| remote.machine.id.as_str());
        let at = now();
        db.execute(
            "UPDATE executor_slots SET state='waiting',seq=?2,since=?3,queued_at=?3,reason=NULL WHERE agent_id=?1 AND state='released'",
            params![agent.id, seq, at],
        )?;
        db.execute(
            "INSERT INTO executor_slots(agent_id,seq,task_id,project_id,machine_id,template_id,state,since,queued_at)
             SELECT r.agent_id, ?2, COALESCE(r.task_id,''), r.project_id, ?3, COALESCE(r.template_id,''), 'waiting', ?4, ?4
             FROM agent_roles r WHERE r.agent_id=?1 AND r.kind='executor'
               AND NOT EXISTS(SELECT 1 FROM executor_slots s WHERE s.agent_id=?1)",
            params![agent.id, seq, machine, at],
        )?;
    }
    Ok(())
}

/// The waiting row of an executor just dispatched, in the transaction that
/// dispatches its task (collaboration_store/executor_dispatch.rs).
pub(crate) fn enqueue(db: &Connection, agent: &str, task: &str, project: Option<&str>, machine: &str, template: &str) -> Result<()> {
    let seq: i64 = db.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM executor_slots", [], |r| r.get(0))?;
    let at = now();
    db.execute(
        "INSERT OR IGNORE INTO executor_slots(agent_id,seq,task_id,project_id,machine_id,template_id,state,since,queued_at)
         VALUES(?1,?2,?3,?4,?5,?6,'waiting',?7,?7)",
        params![agent, seq, task, project, machine, template, at],
    )?;
    Ok(())
}

/// An open executor from before slots: its Agent, task, Project, template and machine.
type OlderExecutor = (String, Option<String>, Option<String>, Option<String>, String);

impl Store {
    /// The scheduler's one transaction: frees the slots of closed executors,
    /// marks connected ones running, then takes the first waiting executor in
    /// queue order whose Project and machine have room, when the Workspace
    /// has, and sets it starting. Returns it, for its runtime to start.
    pub(crate) fn executor_slot_next(&self) -> Result<Option<String>> {
        if !pending(&*self.db.read()?)? {
            return Ok(None);
        }
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        release_closed(&tx)?;
        settle_connected(&tx)?;
        let (total, projects, machines) = holding(&tx)?;
        let mut chosen = None;
        if total < workspace_slots(&tx)? {
            for (waiting, key) in queue_order(&tx)? {
                let room = |used: Option<&i64>, cap: Option<i64>| cap.is_none_or(|cap| used.copied().unwrap_or(0) < cap);
                let project_cap = match &waiting.project {
                    Some(project) => limit_at(&tx, &project_key(project))?.slots,
                    None => None,
                };
                let machine_cap = limit_at(&tx, &machine_key(&waiting.machine))?.slots;
                if room(waiting.project.as_ref().and_then(|p| projects.get(p)), project_cap)
                    && room(machines.get(&waiting.machine), machine_cap)
                {
                    chosen = Some((waiting, key));
                    break;
                }
            }
        }
        if let Some((waiting, key)) = &chosen {
            tx.execute(
                "UPDATE executor_slots SET state='starting',since=?2,reason=NULL WHERE agent_id=?1 AND state='waiting'",
                params![waiting.agent, now()],
            )?;
            tx.execute(
                "INSERT INTO executor_queue_state(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                [json!({"lastProject": key}).to_string()],
            )?;
        }
        tx.commit()?;
        Ok(chosen.map(|(waiting, _)| waiting.agent))
    }

    /// Its runtime started: a starting executor is running.
    pub(crate) fn executor_slot_started(&self, agent: &str) -> Result<()> {
        self.db.write()?.execute(
            "UPDATE executor_slots SET state='running',since=?2,reason=NULL WHERE agent_id=?1 AND state='starting'",
            params![agent, now()],
        )?;
        Ok(())
    }

    /// Its start ended without the runtime: `released` with why (the caller
    /// closes it), or, when the runtime may be running after all, still
    /// holding its slot as `starting` with why, for the user.
    pub(crate) fn executor_slot_not_started(&self, agent: &str, held: bool, why: &str) -> Result<()> {
        self.db.write()?.execute(
            "UPDATE executor_slots SET state=CASE WHEN ?3 THEN 'starting' ELSE 'released' END,since=?4,reason=?2
             WHERE agent_id=?1 AND state='starting'",
            params![agent, why, held, now()],
        )?;
        Ok(())
    }

    /// Refuses to start an executor waiting in the queue: only the scheduler
    /// starts it, when a slot is free. Any other Agent, and an executor
    /// holding its slot, may start.
    pub(crate) fn executor_slot_gate(&self, agent: &str) -> Result<()> {
        let db = self.db.read()?;
        let state: Option<String> =
            db.query_row("SELECT state FROM executor_slots WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?;
        if state.as_deref() == Some("waiting") {
            let place = positions(&db)?.get(agent).map(|n| format!(" (number {n} in the queue)")).unwrap_or_default();
            return Err(WaitsForSlot(format!(
                "executor_queued: this executor waits for an executor slot{place}; it starts when one is free. To run more at once, raise Executors at once in Settings"
            )).into());
        }
        Ok(())
    }

    /// At startup, before any runtime starts: a start a stopped Core left
    /// unfinished waits again (no runtime outlives Core), unless it may be
    /// running after all; executors open from before slots existed hold one,
    /// as running.
    pub(crate) fn recover_executor_slots(&self) -> Result<()> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let at = now();
        tx.execute(
            "UPDATE executor_slots SET state='waiting',since=?1,reason=NULL WHERE state='starting' AND reason IS NULL",
            [&at],
        )?;
        let older: Vec<OlderExecutor> = tx
            .prepare(
                "SELECT r.agent_id, r.task_id, r.project_id, r.template_id,
                        COALESCE(json_extract(a.data,'$.agent.remote.machine.id'),'local')
                 FROM agent_roles r JOIN agents a ON a.id=r.agent_id
                 WHERE r.kind='executor' AND json_extract(a.data,'$.agent.closedAt') IS NULL
                   AND NOT EXISTS(SELECT 1 FROM executor_slots s WHERE s.agent_id=r.agent_id)",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (agent, task, project, template, machine) in older {
            let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM executor_slots", [], |r| r.get(0))?;
            tx.execute(
                "INSERT INTO executor_slots(agent_id,seq,task_id,project_id,machine_id,template_id,state,since,queued_at)
                 VALUES(?1,?2,?3,?4,?5,?6,'running',?7,?7)",
                params![agent, seq, task.unwrap_or_default(), project, machine, template.unwrap_or_default(), at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The limits and what holds or waits for a slot, for Settings.
    fn executor_slots_view(&self, project: Option<&str>) -> Result<Value> {
        let db = self.db.read()?;
        if let Some(project) = project {
            crate::projects::ensure_exists(&db, project)?;
        }
        let workspace = limit_at(&db, KEY)?;
        let counts: HashMap<String, i64> = db
            .prepare("SELECT state, COUNT(*) FROM executor_slots WHERE state!='released' GROUP BY state")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let count = |state: &str| counts.get(state).copied().unwrap_or(0);
        let mut view = json!({
            "workspace": {"version": workspace.version, "slots": workspace.slots.unwrap_or(DEFAULT_SLOTS),
                "saved": workspace.slots.is_some(), "default": DEFAULT_SLOTS},
            "limits": {"min": 1, "max": MAX_SLOTS},
            "inUse": {"waiting": count("waiting"), "starting": count("starting"), "running": count("running")},
        });
        if let Some(project) = project {
            let own = limit_at(&db, &project_key(project))?;
            view["project"] = json!({"id": project, "version": own.version, "slots": own.slots});
        }
        Ok(view)
    }

    fn save_executor_slots(&self, project: Option<&str>, expected: i64, slots: Option<i64>) -> Result<()> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let key = match project {
            Some(project) => {
                crate::projects::ensure_assignable(&tx, project)?;
                project_key(project)
            }
            None => {
                ensure!(slots.is_some(), "invalid_input: the Workspace's executors at once is a whole number from 1 to {MAX_SLOTS}");
                KEY.to_owned()
            }
        };
        save_limit(&tx, &key, expected, slots)?;
        tx.commit()?;
        Ok(())
    }
}

/// The scheduler's state: woken by what can free a slot or add a waiting
/// executor, and otherwise every few seconds.
#[derive(Default)]
pub(crate) struct State {
    wakeup: tokio::sync::Notify,
    started: OnceLock<()>,
}

/// How often a pass runs with nothing waking it: connected executors become
/// running, and closes made elsewhere free their slots.
const TICK: Duration = Duration::from_secs(5);

impl Workspace {
    /// Something may have freed a slot or queued an executor.
    pub(crate) fn wake_executor_slots(&self) {
        self.executor_slots.wakeup.notify_one();
    }

    /// The scheduler, started once with Core's services; holds only a Weak owner.
    pub fn start_executor_slots(self: &Arc<Self>) {
        if self.executor_slots.started.set(()).is_err() {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(ws) = weak.upgrade() else { break };
                tokio::select! {
                    _ = ws.executor_slots.wakeup.notified() => {},
                    _ = tokio::time::sleep(TICK) => {},
                }
                ws.executor_slots_pass().await;
                drop(ws);
            }
        });
    }

    /// Starts waiting executors while slots are free, each in a task of its
    /// own under a work permit of its own; while an update drains, none.
    /// Returns those tasks, for a caller that waits for them (tests).
    pub(crate) async fn executor_slots_pass(self: &Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        let mut started = Vec::new();
        loop {
            let Ok(permit) = self.admission.enter_work() else { break };
            match self.stored(|store| store.executor_slot_next()).await {
                Ok(Some(agent)) => started.push(self.start_in_slot(agent, permit)),
                Ok(None) => break,
                Err(error) => {
                    eprintln!("Executor slots: {error:#}");
                    break;
                }
            }
        }
        started
    }

    fn start_in_slot(self: &Arc<Self>, id: String, permit: Permit) -> tokio::task::JoinHandle<()> {
        let ws = self.clone();
        tokio::spawn(async move {
            let started = {
                let gate = ws.gate(&id).await;
                let _held = gate.lock().await;
                ws.start_slot_runtime(&id).await
            };
            let outcome = match started {
                Ok(true) => {
                    let agent = id.clone();
                    ws.stored(move |store| store.executor_slot_started(&agent)).await
                }
                // Already started, closed, or left to the user: the next pass settles it.
                Ok(false) => Ok(()),
                Err(error) => {
                    ws.failed(&id, &error).await;
                    // Its runtime may be running after all: the slot stays its, for the user.
                    let held = ws.listed(&id).await.is_ok_and(|a| a.status == "uncertain");
                    let (agent, why) = (id.clone(), format!("{error:#}"));
                    let recorded = ws.stored(move |store| store.executor_slot_not_started(&agent, held, &why)).await;
                    if !held {
                        if let Err(closing) = ws.close_agent_admitted(&id, &permit).await {
                            eprintln!("Executor {id}: its start failed, and it could not be closed: {closing:#}");
                        }
                    }
                    recorded
                }
            };
            if let Err(error) = outcome {
                eprintln!("Executor {id}: its slot could not be recorded: {error:#}");
            }
            drop(permit);
            ws.wake_executor_slots();
        })
    }

    /// Starts the runtime of an executor whose slot is starting: true once it
    /// started; false when there is nothing to start (closed, already
    /// connecting or connected, or disconnected by the user, who reconnects it).
    async fn start_slot_runtime(self: &Arc<Self>, id: &str) -> Result<bool> {
        let agent = self.listed(id).await?;
        if agent.closed_at.is_some() || agent.disconnected_at.is_some() || agent.connection_state != "disconnected" {
            return Ok(false);
        }
        match agent.harness.as_str() {
            "claude" => self.claude_ensure(id).await.map(drop)?,
            "opencode" => self.opencode_ensure(id).await.map(drop)?,
            _ => self.ensure(id).await.map(drop)?,
        }
        Ok(true)
    }

    /// `Store::executor_slot_gate`, before any runtime start.
    pub(crate) async fn executor_slot_admits(&self, id: &str) -> Result<()> {
        let agent = id.to_owned();
        self.stored(move |store| store.executor_slot_gate(&agent)).await
    }

    /// Whether a reopened Agent is an executor waiting for its slot again:
    /// the queue starts it, not the reopen (workspace.rs `reopen_agent`).
    pub(crate) async fn reopened_into_queue(&self, id: &str) -> Result<bool> {
        match self.executor_slot_admits(id).await {
            Ok(()) => Ok(false),
            Err(error) if error.downcast_ref::<WaitsForSlot>().is_some() => {
                self.wake_executor_slots();
                Ok(true)
            }
            Err(error) => Err(error),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForProject {
    #[serde(default)]
    project_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    expected_version: i64,
    /// Whole numbers 1 to 64; none for a Project's own limit to stop applying.
    slots: Option<Value>,
}

fn slots_of(input: &Save) -> Result<Option<i64>> {
    match &input.slots {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_i64().filter(|n| (1..=MAX_SLOTS).contains(n)) {
            Some(n) if value.is_i64() || value.is_u64() => Ok(Some(n)),
            _ => bail!("invalid_input: executors at once is a whole number from 1 to {MAX_SLOTS}"),
        },
    }
}

async fn get_slots(AxumState(ws): AxumState<Arc<Workspace>>, Query(query): Query<ForProject>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| s.executor_slots_view(query.project_id.as_deref())).await?))
}

async fn put_slots(AxumState(ws): AxumState<Arc<Workspace>>, Json(input): Json<Save>) -> Result<Json<Value>, ApiError> {
    let slots = slots_of(&input)?;
    let view = ws.stored(move |s| {
        s.save_executor_slots(None, input.expected_version, slots)?;
        s.executor_slots_view(None)
    }).await?;
    ws.changes.send(json!({"executorSlots": true}));
    ws.wake_executor_slots();
    Ok(Json(view))
}

async fn put_project_slots(
    AxumState(ws): AxumState<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(input): Json<Save>,
) -> Result<Json<Value>, ApiError> {
    let slots = slots_of(&input)?;
    let project = id.clone();
    let view = ws.stored(move |s| {
        s.save_executor_slots(Some(&project), input.expected_version, slots)?;
        s.executor_slots_view(Some(&project))
    }).await?;
    ws.changes.send(json!({"executorSlots": true, "projectId": id}));
    ws.wake_executor_slots();
    Ok(Json(view))
}

/// Only the user changes the limits: browser routes, never a collaboration operation.
pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/executor-slots", get(get_slots).put(put_slots))
        .route("/api/projects/{id}/executor-slots", put(put_project_slots))
}

#[cfg(test)]
#[path = "executor_slots_tests.rs"]
mod tests;
