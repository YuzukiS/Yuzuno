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
//! The limit (YN-2 S5, the user's decision): each machine's own
//! (`executors.slots.machine:<id>`), 3 unless saved. Every machine has one
//! and none is unlimited, so the Workspace's total is their sum. The
//! Workspace's record (`executors.slots`) keeps the start time limit, and the
//! number older Cores read; a Project's and a template's limits from before
//! stay stored for them, unused here. It counts executors only, apart from
//! the Jobs' machine slots.
//!
//! A fresh executor's start the runtime refused closes it (kept, to see what
//! happened) and frees its slot; that close carries the record of its
//! settling, written in the close's own transaction (`follow_agent`, T-35
//! S3b), so the two commit or fail together. One whose outcome is unknown (its runtime
//! may be running), or a reopened executor's that failed, keeps its slot as
//! `starting` with why, open, and waits for the user.
use crate::{
    executor_start::{closed_when_cut, cut, cut_off, Failure},
    jobs::queue::{self, Queued},
    model::now,
    server::ApiError,
    store::Store,
    updates::admission::Permit,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Context, Result};
use axum::{extract::{Path, Query, State as AxumState}, routing::{get, put}, Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, sync::{Arc, Mutex, OnceLock}, time::Duration};

/// Executors running at once on a machine, unless the user saved another number for it.
pub(crate) const DEFAULT_SLOTS: i64 = 3;
pub(crate) const MAX_SLOTS: i64 = 64;
const KEY: &str = "executors.slots";

/// What the first open of S5 did, once (`machines_only`).
const MACHINES_ONLY: &str = "executors.slots.machines";

/// What a save of a Project's or the Workspace's number gets now (S5).
const SETTING_REMOVED: &str =
    "setting_removed: executors at once is each machine's; set it in Settings → Machines";

pub(crate) fn machine_key(machine: &str) -> String {
    format!("executors.slots.machine:{machine}")
}

/// The `reason` of a close that a failed start makes, with its `why`: the
/// close then writes the slot's reason and the record of the start's
/// settling in its own transaction (`follow_agent`, T-35 S3b, R2 2eb2935b).
pub(crate) const START_FAILED: &str = "executor_start_failed";

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
            -- Its starts from the queue: 1 for a fresh dispatch, more once reopened.
            attempt INTEGER NOT NULL DEFAULT 1, reason TEXT);
        CREATE INDEX IF NOT EXISTS executor_slots_task ON executor_slots(task_id);
        CREATE INDEX IF NOT EXISTS executor_slots_state ON executor_slots(state);
        CREATE TABLE IF NOT EXISTS executor_queue_state(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);",
    )?;
    // S2: the executor a rebuilt one replaced. S1's table may exist without it.
    let has: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('executor_slots') WHERE name='rebuilt_from')", [], |r| r.get(0))?;
    if !has {
        db.execute_batch("ALTER TABLE executor_slots ADD COLUMN rebuilt_from TEXT")?;
    }
    machines_only(db)
}

/// YN-2 S5, once: the Workspace's number on executors at once, when the
/// user saved one, becomes this Core host's limit if it has none of its own;
/// a machine's saved limit stays as it is, also above the old total. The
/// Project and template limits, and the Workspace record, stay stored for
/// older Cores, unused here. The marker records what it did: a journal for
/// no Agent, since none changed.
fn machines_only(db: &Connection) -> Result<()> {
    let done: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM workspace_meta WHERE key=?1)", [MACHINES_ONLY], |r| r.get(0))?;
    if done {
        return Ok(());
    }
    let workspace = limit_at(db, KEY)?.slots;
    let local = limit_at(db, &machine_key("local"))?;
    if let (Some(n), None) = (workspace, local.slots) {
        save_limit(db, &machine_key("local"), local.version, Some(n), None)?;
    }
    let mut machines = serde_json::Map::new();
    let mut defaulted = Vec::new();
    for (id, _) in machine_names(db)? {
        let (limit, saved) = machine_limit(db, &id)?;
        machines.insert(id.clone(), json!(limit));
        if !saved {
            defaulted.push(id);
        }
    }
    let stored = |like: &str| -> Result<Vec<(String, String)>> {
        Ok(db.prepare("SELECT key, value FROM workspace_meta WHERE key LIKE ?1 ORDER BY key")?
            .query_map([like], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?)
    };
    let mut projects = serde_json::Map::new();
    for (key, raw) in stored("executors.slots.project:%")? {
        if let Some(n) = serde_json::from_str::<Value>(&raw).ok().and_then(|v| v["slots"].as_i64()) {
            projects.insert(key.trim_start_matches("executors.slots.project:").to_owned(), json!(n));
        }
    }
    let mut templates = serde_json::Map::new();
    for (key, raw) in stored("executors.templates%")? {
        let Ok(list) = serde_json::from_str::<Value>(&raw) else { continue };
        for template in list["templates"].as_array().into_iter().flatten() {
            if let (Some(id), Some(n)) = (template["id"].as_str(), template["maxConcurrent"].as_i64()) {
                let list = key.trim_start_matches("executors.templates").trim_start_matches(".project:");
                templates.insert(if list.is_empty() { id.to_owned() } else { format!("{list}/{id}") }, json!(n));
            }
        }
    }
    let record = json!({"version": 1, "at": now(), "workspaceSlots": workspace,
        "coreHost": {"before": local.slots, "after": machine_limit(db, "local")?.0},
        "machines": machines, "defaulted": defaulted,
        "ignoredProjectLimits": projects, "ignoredTemplateLimits": templates});
    db.execute("INSERT INTO workspace_meta(key,value) VALUES(?1,?2)", params![MACHINES_ONLY, record.to_string()])?;
    eprintln!("YN-2 S5: executors at once is each machine's now: {record}");
    Ok(())
}

/// A saved limit: its version, moved on by every save, and its number; none
/// when it is not set. The Workspace's also keeps how long a start may take
/// (S2). Read leniently: a value this Core can't use is unset.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Limit {
    version: i64,
    slots: Option<i64>,
    start_limit: Option<i64>,
}

/// How long an executor's start may take before it is cut off, in seconds,
/// unless the user saved another: the Workspace's own wall-clock limit.
pub(crate) const DEFAULT_START_LIMIT: i64 = 300;
const START_LIMITS: std::ops::RangeInclusive<i64> = 30..=3600;

fn limit_at(db: &Connection, key: &str) -> Result<Limit> {
    let raw: Option<String> = db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [key], |r| r.get(0)).optional()?;
    let Some(value) = raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
        return Ok(Limit::default());
    };
    Ok(Limit {
        version: value["version"].as_i64().unwrap_or(0),
        slots: value["slots"].as_i64().filter(|n| (1..=MAX_SLOTS).contains(n)),
        start_limit: value["startLimitSeconds"].as_i64().filter(|n| START_LIMITS.contains(n)),
    })
}

/// `start_limit`: the Workspace's only; none keeps the one saved.
fn save_limit(db: &Connection, key: &str, expected: i64, slots: Option<i64>, start_limit: Option<i64>) -> Result<Limit> {
    let current = limit_at(db, key)?;
    ensure!(current.version == expected, "version_conflict: these executor slots changed; reload before saving");
    if let Some(n) = slots {
        ensure!((1..=MAX_SLOTS).contains(&n), "invalid_input: executors at once is a whole number from 1 to {MAX_SLOTS}");
    }
    if let Some(n) = start_limit {
        ensure!(START_LIMITS.contains(&n), "invalid_input: a start's time limit is a whole number of seconds from 30 to 3600");
    }
    let saved = Limit { version: current.version + 1, slots, start_limit: start_limit.or(current.start_limit) };
    let mut value = json!({"version": saved.version, "slots": slots});
    if let Some(limit) = saved.start_limit {
        value["startLimitSeconds"] = json!(limit);
    }
    db.execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(saved)
}

/// How long a start may take before it is cut off.
pub(crate) fn start_limit(db: &Connection) -> Result<Duration> {
    let seconds = limit_at(db, KEY)?.start_limit.unwrap_or(DEFAULT_START_LIMIT);
    Ok(Duration::from_secs(seconds as u64))
}

/// A machine's limit on executors at once: the one saved for it, else the
/// default; and whether one is saved.
pub(crate) fn machine_limit(db: &Connection, machine: &str) -> Result<(i64, bool)> {
    let saved = limit_at(db, &machine_key(machine))?.slots;
    Ok((saved.unwrap_or(DEFAULT_SLOTS), saved.is_some()))
}

/// This Core host and every registered machine, by id, with its name.
fn machine_names(db: &Connection) -> Result<Vec<(String, String)>> {
    let mut machines = vec![("local".to_owned(), "this Core host".to_owned())];
    let mut q = db.prepare("SELECT data FROM machines ORDER BY id")?;
    for raw in q.query_map([], |r| r.get::<_, String>(0))? {
        let machine: crate::remote::RemoteMachine = serde_json::from_str(&raw?)?;
        machines.push((machine.id, machine.name));
    }
    Ok(machines)
}

/// A machine's name as Core's texts say it: this Core host, a registered
/// machine's name, or its id once it is gone.
fn machine_name(db: &Connection, machine: &str) -> Result<String> {
    if machine == "local" {
        return Ok("this Core host".to_owned());
    }
    let raw: Option<String> = db.query_row("SELECT data FROM machines WHERE id=?1", [machine], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|raw| serde_json::from_str::<crate::remote::RemoteMachine>(&raw).ok()).map_or_else(|| machine.to_owned(), |m| m.name))
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

/// The executor a pass takes: starting, and its Project the one served last.
fn take(tx: &Connection, agent: &str, key: &str) -> Result<()> {
    tx.execute(
        "UPDATE executor_slots SET state='starting',since=?2,reason=NULL WHERE agent_id=?1 AND state='waiting'",
        params![agent, now()],
    )?;
    tx.execute(
        "INSERT INTO executor_queue_state(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        [json!({"lastProject": key}).to_string()],
    )?;
    Ok(())
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

/// The executors holding a slot on `machine` (starting or running) and that
/// machine's limit: a dispatch choosing its machine reads them
/// (collaboration_store/executor_choice.rs, T-35 S3b).
pub(crate) fn machine_slots(db: &Connection, machine: &str) -> Result<(i64, i64)> {
    let held: i64 = db.query_row(
        "SELECT COUNT(*) FROM executor_slots WHERE machine_id=?1 AND state IN ('starting','running')", [machine], |r| r.get(0))?;
    Ok((held, machine_limit(db, machine)?.0))
}

/// What holds a slot now (starting or running), by machine.
fn holding(db: &Connection) -> Result<HashMap<String, i64>> {
    Ok(db.prepare("SELECT machine_id, COUNT(*) FROM executor_slots WHERE state IN ('starting','running') GROUP BY machine_id")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// A slot row as a task shows it: its executor, state, machine and reason.
type SlotRow = (String, String, String, Option<String>);

/// An executor's slot row as the task card shows it, and its place in the
/// queue (1 first) while it waits.
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
    let Some((agent, state, machine, reason)) = row else { return Ok(None) };
    let mut view = json!({"agentId": agent, "state": state, "machine": machine});
    if state == "waiting" {
        view["position"] = json!(positions.get(&agent));
        // What it waits for (S5): a slot on its machine, and how full that is.
        let (running, limit) = machine_slots(db, &machine)?;
        view["waitsFor"] = json!({"machine": machine, "name": machine_name(db, &machine)?, "running": running, "limit": limit});
    }
    if let Some(reason) = reason {
        view["reason"] = json!(reason);
    }
    // Chosen by `auto` (T-35 S3b): the record of the choice, its numbers too.
    let choice: Option<String> = db.query_row(
        "SELECT choice_json FROM executor_dispatches WHERE agent_id=?1 AND choice_json IS NOT NULL", [&agent], |r| r.get(0))
        .optional()?;
    if let Some(choice) = choice {
        view["choice"] = serde_json::from_str(&choice)?;
    }
    Ok(Some(view))
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
/// end of the queue. One from before slots existed gets its row then. A
/// failed start's close (`data` says START_FAILED) gives its slot why, and
/// writes the record of its settling here too (T-35 S3b, R2 2eb2935b): a
/// closed executor's record is then always there for a pass, or the next
/// start, to finish.
pub(crate) fn follow_agent(db: &Connection, agent: &crate::model::Agent, kind: &str, data: &Value) -> Result<()> {
    if agent.closed_at.is_some() {
        let failed = (kind == "agent/closed" && data["reason"] == START_FAILED)
            .then(|| data["why"].as_str().unwrap_or("its start failed"));
        // Recorded before the slot is released, both in this transaction.
        if let Some(why) = failed {
            crate::collaboration_store::executor_start::settling_in(db, &agent.id, why)?;
        }
        db.execute(
            "UPDATE executor_slots SET state='released',since=?2,reason=?3 WHERE agent_id=?1 AND state!='released'",
            params![agent.id, now(), failed.unwrap_or("closed")],
        )?;
    } else if kind == "agent/reopened" {
        let seq: i64 = db.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM executor_slots", [], |r| r.get(0))?;
        let machine = agent.remote.as_ref().map_or("local", |remote| remote.machine.id.as_str());
        let at = now();
        db.execute(
            "UPDATE executor_slots SET state='waiting',seq=?2,since=?3,queued_at=?3,reason=NULL,attempt=attempt+1
             WHERE agent_id=?1 AND state='released'",
            params![agent.id, seq, at],
        )?;
        db.execute(
            "INSERT INTO executor_slots(agent_id,seq,task_id,project_id,machine_id,template_id,state,since,queued_at,attempt)
             SELECT r.agent_id, ?2, COALESCE(r.task_id,''), r.project_id, ?3, COALESCE(r.template_id,''), 'waiting', ?4, ?4, 2
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
    /// queue order whose machine has room under its limit (S5: the only one),
    /// and sets it starting. Returns it, for its runtime to start.
    /// `in_flight`: the executors passes are starting or settling. The one
    /// taken joins them before its row reads starting, so no other pass
    /// settles a start this one is making (R2 de2313b7).
    pub(crate) fn executor_slot_next(&self, in_flight: &Mutex<HashSet<String>>) -> Result<Option<String>> {
        if !pending(&*self.db.read()?)? {
            return Ok(None);
        }
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        release_closed(&tx)?;
        settle_connected(&tx)?;
        let held = holding(&tx)?;
        let mut limits: HashMap<String, i64> = HashMap::new();
        let mut chosen = None;
        for (waiting, key) in queue_order(&tx)? {
            let limit = match limits.get(&waiting.machine) {
                Some(limit) => *limit,
                None => {
                    let limit = machine_limit(&tx, &waiting.machine)?.0;
                    limits.insert(waiting.machine.clone(), limit);
                    limit
                }
            };
            if held.get(&waiting.machine).copied().unwrap_or(0) < limit && in_flight.lock().unwrap().insert(waiting.agent.clone()) {
                chosen = Some((waiting, key));
                break;
            }
        }
        let took = match &chosen {
            Some((waiting, key)) => take(&tx, &waiting.agent, key),
            None => Ok(()),
        }
        .and_then(|()| Ok(tx.commit()?));
        if took.is_err() {
            if let Some((waiting, _)) = &chosen {
                in_flight.lock().unwrap().remove(&waiting.agent);
            }
        }
        took?;
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

    /// Its start ended without the runtime. A fresh dispatch's first start
    /// is `released` with why, and the caller closes the executor (true).
    /// One whose runtime may be running after all (`uncertain`), or a later
    /// start (a reopened executor's), keeps its slot as `starting` with why,
    /// open, for the user's Connect or Close (false).
    pub(crate) fn executor_slot_not_started(&self, agent: &str, uncertain: bool, why: &str) -> Result<bool> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let attempt: Option<i64> = tx
            .query_row("SELECT attempt FROM executor_slots WHERE agent_id=?1 AND state='starting'", [agent], |r| r.get(0))
            .optional()?;
        let Some(attempt) = attempt else { return Ok(false) };
        let close = !uncertain && attempt <= 1;
        tx.execute(
            "UPDATE executor_slots SET state=CASE WHEN ?3 THEN 'released' ELSE 'starting' END,since=?4,reason=?2
             WHERE agent_id=?1 AND state='starting'",
            params![agent, why, close, now()],
        )?;
        tx.commit()?;
        Ok(close)
    }

    /// Its row's `attempt`: 1 for a fresh dispatch, more once reopened; none
    /// for an Agent without a row.
    pub(crate) fn executor_slot_attempt(&self, agent: &str) -> Result<Option<i64>> {
        Ok(self.db.read()?.query_row("SELECT attempt FROM executor_slots WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?)
    }

    /// The machine an executor's slot is on: `local` or a registered
    /// machine's id; none for an Agent without a row.
    pub(crate) fn executor_slot_machine(&self, agent: &str) -> Result<Option<String>> {
        Ok(self.db.read()?.query_row("SELECT machine_id FROM executor_slots WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?)
    }

    /// The executors starting without a reason: started, or being started,
    /// with nothing yet settled (S2's P3-1 check reads them).
    pub(crate) fn executor_slots_starting_unsettled(&self) -> Result<Vec<String>> {
        Ok(self.db.read()?
            .prepare("SELECT agent_id FROM executor_slots WHERE state='starting' AND reason IS NULL ORDER BY seq")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Refuses to start an executor waiting in the queue: only the scheduler
    /// starts it, when a slot is free. Any other Agent, and an executor
    /// holding its slot, may start.
    pub(crate) fn executor_slot_gate(&self, agent: &str) -> Result<()> {
        let db = self.db.read()?;
        let row: Option<(String, String)> = db
            .query_row("SELECT state, machine_id FROM executor_slots WHERE agent_id=?1", [agent], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((_, machine)) = row.filter(|(state, _)| state == "waiting") {
            let place = positions(&db)?.get(agent).map(|n| format!("; number {n} in the queue")).unwrap_or_default();
            let (running, limit) = machine_slots(&db, &machine)?;
            let name = machine_name(&db, &machine)?;
            return Err(WaitsForSlot(format!(
                "executor_queued: this executor waits for a slot on {name} ({running} of {limit} running there{place}); it starts when one is free. To run more at once there, raise that machine's Executors at once in Settings → Machines"
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

    /// The limits and what holds or waits for a slot, for Settings: each
    /// machine's limit (S5: the only one), this Core host's first, their sum,
    /// and the Workspace's start time limit. A Project's id is ignored: a
    /// Project has no limit of its own any more.
    fn executor_slots_view(&self, _project: Option<&str>) -> Result<Value> {
        let db = self.db.read()?;
        let workspace = limit_at(&db, KEY)?;
        let counts: HashMap<String, i64> = db
            .prepare("SELECT state, COUNT(*) FROM executor_slots WHERE state!='released' GROUP BY state")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let count = |state: &str| counts.get(state).copied().unwrap_or(0);
        let mut listed = Vec::new();
        let mut total = 0;
        for (id, name) in machine_names(&db)? {
            let own = limit_at(&db, &machine_key(&id))?;
            let (held, slots) = machine_slots(&db, &id)?;
            total += slots;
            listed.push(json!({"id": id, "name": name, "version": own.version, "slots": slots, "saved": own.slots.is_some(),
                "default": DEFAULT_SLOTS, "executors": held}));
        }
        Ok(json!({
            "workspace": {"version": workspace.version,
                "startLimitSeconds": workspace.start_limit.unwrap_or(DEFAULT_START_LIMIT)},
            "limits": {"min": 1, "max": MAX_SLOTS, "default": DEFAULT_SLOTS,
                "startLimitSeconds": {"min": START_LIMITS.start(), "max": START_LIMITS.end(), "default": DEFAULT_START_LIMIT}},
            "machines": listed,
            "total": total,
            "inUse": {"waiting": count("waiting"), "starting": count("starting"), "running": count("running")},
        }))
    }

    /// A machine's own limit on executors at once, or none for the default
    /// (T-35 S3b, S5): this Core host's (`local`) or a registered machine's.
    /// Lowering it under the executors running there stops none: no more
    /// start there until fewer hold a slot.
    fn save_machine_slots(&self, machine: &str, expected: i64, slots: Option<i64>) -> Result<()> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let registered: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM machines WHERE id=?1)", [machine], |r| r.get(0))?;
        ensure!(machine == "local" || registered, "machine_not_found: no registered machine is {machine}; the Machines list names them");
        save_limit(&tx, &machine_key(machine), expected, slots, None)?;
        tx.commit()?;
        Ok(())
    }

    /// The Workspace's start time limit (S2). Its number on executors at
    /// once is no longer set (S5): a save naming one is refused, and the one
    /// stored stays, for older Cores.
    fn save_start_limit(&self, expected: i64, slots: Option<i64>, start_limit: Option<i64>) -> Result<()> {
        ensure!(slots.is_none(), "{SETTING_REMOVED}");
        let start_limit = start_limit
            .context("invalid_input: a start's time limit is a whole number of seconds from 30 to 3600")?;
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let kept = limit_at(&tx, KEY)?.slots;
        save_limit(&tx, KEY, expected, kept, Some(start_limit))?;
        tx.commit()?;
        Ok(())
    }
}

/// The scheduler's state: woken by what can free a slot or add a waiting
/// executor, and otherwise every few seconds.
#[derive(Default)]
pub(crate) struct State {
    /// Shared with the loop, which holds it, not its Workspace, while it
    /// waits (R3 deaeac79): only a pass holds the Workspace.
    wakeup: Arc<tokio::sync::Notify>,
    started: OnceLock<()>,
    /// The executors whose start a pass began and has not settled (S2): a
    /// pass settles another start that ended without its runtime only when
    /// it is not one of these. Shared with the take that adds one.
    pub(crate) in_flight: Arc<Mutex<HashSet<String>>>,
    /// A test's start time limit, below the 30 s a user can save.
    #[cfg(test)]
    pub(crate) start_limit: std::sync::Mutex<Option<Duration>>,
    /// A test's meeting point for passes settling one ended start: each
    /// waits there, up to a second, once it has read the Agent.
    #[cfg(test)]
    pub(crate) settle_meet: std::sync::Mutex<Option<Arc<tokio::sync::Barrier>>>,
    /// A test that runs every pass itself: no dispatch spawns one.
    #[cfg(test)]
    pub(crate) quiet: std::sync::atomic::AtomicBool,
    /// A test's meeting point for a pass that has just taken a slot, before
    /// it starts that executor: it waits there, up to five seconds.
    #[cfg(test)]
    pub(crate) take_meet: std::sync::Mutex<Option<Arc<tokio::sync::Barrier>>>,
    /// A test's write between a rebuild's read of the task's version and
    /// its dispatch, run once.
    #[cfg(test)]
    pub(crate) before_rebuild_dispatch: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// A test's store errors: the start's reads of its time limit and its
    /// attempt fail (`fault_reads`).
    #[cfg(test)]
    pub(crate) fault_reads: std::sync::atomic::AtomicBool,
    /// A test's remote start refused before it asks its machine to launch
    /// anything (a tunnel or admission refusal, executor_start.rs
    /// `launch_requested`).
    #[cfg(test)]
    pub(crate) fault_before_launch: std::sync::atomic::AtomicBool,
    /// A test's reads of this Core host's default Jobs budget by a dispatch,
    /// how many failed, and a read that fails (a Core host that isn't Linux).
    #[cfg(test)]
    pub(crate) budget_reads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    pub(crate) budget_read_failures: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    pub(crate) fail_budget_read: std::sync::atomic::AtomicBool,
}

/// How often a pass runs with nothing waking it: connected executors become
/// running, and closes made elsewhere free their slots.
const TICK: Duration = Duration::from_secs(5);

impl Workspace {
    /// A pass in a task of its own. Its future is boxed under a declared
    /// type: a rebuild dispatches from inside a pass (executor_start.rs), so
    /// the dispatch that spawns a pass must not hold that pass's own type.
    pub(crate) fn spawn_executor_slots_pass(self: &Arc<Self>) {
        #[cfg(test)]
        if self.executor_slots.quiet.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let ws = self.clone();
        let pass: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
            Box::pin(async move { ws.executor_slots_pass().await; });
        tokio::spawn(pass);
    }

    /// Something may have freed a slot or queued an executor.
    pub(crate) fn wake_executor_slots(&self) {
        self.executor_slots.wakeup.notify_one();
    }

    /// The scheduler, started once with Core's services; holds only a Weak owner.
    pub fn start_executor_slots(self: &Arc<Self>) {
        if self.executor_slots.started.set(()).is_err() {
            return;
        }
        let (weak, wakeup) = (Arc::downgrade(self), self.executor_slots.wakeup.clone());
        tokio::spawn(async move {
            loop {
                // Waits holding only the Weak: a dropped Workspace ends the loop.
                tokio::select! {
                    _ = wakeup.notified() => {},
                    _ = tokio::time::sleep(TICK) => {},
                }
                let Some(ws) = weak.upgrade() else { break };
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
        self.settle_ended_starts(&mut started).await;
        self.finish_rebuilds(&mut started).await;
        loop {
            let Ok(permit) = self.admission.enter_work() else { break };
            let in_flight = self.executor_slots.in_flight.clone();
            match self.stored(move |store| store.executor_slot_next(&in_flight)).await {
                Ok(Some(agent)) => {
                    #[cfg(test)]
                    {
                        let meet = self.executor_slots.take_meet.lock().unwrap().clone();
                        if let Some(meet) = meet {
                            let _ = tokio::time::timeout(Duration::from_secs(5), meet.wait()).await;
                        }
                    }
                    started.push(self.start_in_slot(agent, permit));
                }
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
            let outcome = ws.start_and_settle(&id, &permit).await;
            if let Err(error) = outcome {
                eprintln!("Executor {id}: {error:#}");
            }
            ws.executor_slots.in_flight.lock().unwrap().remove(&id);
            drop(permit);
            ws.wake_executor_slots();
        })
    }

    /// Starts its runtime within the Workspace's time limit, then records it
    /// running, or settles a start that ended without it
    /// (executor_start.rs `settle_start`).
    async fn start_and_settle(self: &Arc<Self>, id: &str, permit: &Permit) -> Result<()> {
        // A store error here must not leave the slot starting with nothing
        // settled (R6 135c4a8c): the default limit holds, and the start
        // counts as a fresh executor's first.
        let limit = match self.start_limit().await {
            Ok(limit) => limit,
            Err(error) => {
                eprintln!("Executor {id}: its start time limit could not be read, so the default holds: {error:#}");
                Duration::from_secs(DEFAULT_START_LIMIT.unsigned_abs())
            }
        };
        let agent = id.to_owned();
        let read = self.stored(move |store| store.executor_slot_attempt(&agent)).await;
        #[cfg(test)]
        let read = if self.executor_slots.fault_reads.load(std::sync::atomic::Ordering::Relaxed) { Err(anyhow::anyhow!("a test's store error")) } else { read };
        let attempt = match read {
            Ok(attempt) => attempt.unwrap_or(1),
            Err(error) => {
                eprintln!("Executor {id}: its start's attempt could not be read, so it counts as the first: {error:#}");
                1
            }
        };
        let started = tokio::time::timeout(limit, async {
            let gate = self.gate(id).await;
            let _held = gate.lock().await;
            self.start_slot_runtime(id, attempt).await
        }).await;
        match started {
            Ok(Ok(true)) => {
                let agent = id.to_owned();
                self.stored(move |store| store.executor_slot_started(&agent)).await
                    .context("it started, and its slot could not be recorded")
            }
            // Already started, closed, or left to the user: a later pass settles it.
            Ok(Ok(false)) => Ok(()),
            Ok(Err(error)) => {
                self.failed(id, &error).await;
                // Its runtime may be running after all: the slot stays its, for the user.
                let uncertain = self.listed(id).await.is_ok_and(|a| a.status == "uncertain");
                let why = format!("{error:#}");
                let failure = if uncertain { Failure::Uncertain(why) } else { Failure::Definite(why) };
                self.settle_start(id, permit, failure, false).await
            }
            // Cut off: definite only when the close confirms its runtime
            // ended. The close carries the record of its settling, in its own
            // transaction (T-35 S3b, R2 2eb2935b).
            Err(_) => {
                let cut = cut(limit);
                // Reopened by the user: S1's rule, the limit does not close it.
                // It stays open with its slot and why; the user closes it (R2 de2313b7).
                if attempt > 1 {
                    self.failed(id, &anyhow::anyhow!(cut.clone())).await;
                    return self.settle_start(id, permit, Failure::Definite(cut), false).await;
                }
                // On another machine, dropping the start ended nothing there: a
                // stop that confirms its runtime ended comes first, unless it
                // never asked to launch one (Lead 2 Q5, mail 5898).
                let closed = match self.remote_start_stopped(id).await {
                    Ok(()) => self.close_start_failed(id, permit, &closed_when_cut(limit)).await,
                    Err(error) => Err(error),
                };
                let failure = cut_off(&closed, limit);
                if let Failure::Uncertain(why) = &failure {
                    self.failed(id, &crate::rpc::OutcomeUnknown(why.clone()).into()).await;
                }
                self.settle_start(id, permit, failure, closed.is_ok()).await
            }
        }
    }

    async fn start_limit(&self) -> Result<Duration> {
        #[cfg(test)]
        if self.executor_slots.fault_reads.load(std::sync::atomic::Ordering::Relaxed) {
            anyhow::bail!("a test's store error");
        }
        #[cfg(test)]
        if let Some(limit) = *self.executor_slots.start_limit.lock().unwrap() {
            return Ok(limit);
        }
        self.stored(|store| start_limit(&*store.db.read()?)).await
    }

    /// R1 1ec1008a P3-1: a starting executor no pass is starting, open and
    /// disconnected after a start that failed (the user's own Connect that
    /// won its gate, say), settles as a definite failure with its error.
    async fn settle_ended_starts(self: &Arc<Self>, started: &mut Vec<tokio::task::JoinHandle<()>>) {
        let Ok(rows) = self.stored(|store| store.executor_slots_starting_unsettled()).await else { return };
        let release = |id: &str| { self.executor_slots.in_flight.lock().unwrap().remove(id); };
        for id in rows {
            // The one check: a pass that did not add it leaves it to the one
            // that did, or to the pass starting it (R1 dde34160).
            if !self.executor_slots.in_flight.lock().unwrap().insert(id.clone()) {
                continue;
            }
            let Ok(agent) = self.listed(&id).await else { release(&id); continue };
            #[cfg(test)]
            {
                let meet = self.executor_slots.settle_meet.lock().unwrap().clone();
                if let Some(meet) = meet {
                    let _ = tokio::time::timeout(Duration::from_secs(1), meet.wait()).await;
                }
            }
            if agent.closed_at.is_some() || agent.connection_state != "disconnected" || agent.status != "error" {
                release(&id);
                continue;
            }
            let Ok(permit) = self.admission.enter_work() else { release(&id); return };
            let (ws, why) = (self.clone(), agent.error.unwrap_or_else(|| "its start failed".into()));
            started.push(tokio::spawn(async move {
                if let Err(error) = ws.settle_start(&id, &permit, Failure::Definite(why), false).await {
                    eprintln!("Executor {id}: {error:#}");
                }
                ws.executor_slots.in_flight.lock().unwrap().remove(&id);
                drop(permit);
                ws.wake_executor_slots();
            }));
        }
    }

    /// Starts the runtime of an executor whose slot is starting: true once it
    /// started; false when there is nothing to start (closed, already
    /// connecting or connected, or disconnected by the user, who reconnects it).
    /// `attempt`: a reopened executor (more than 1) starts as a Reconnect
    /// starts it; for Codex that also reconciles its thread (`reconcile`, R3
    /// deaeac79), which Claude's and OpenCode's ensure already are.
    async fn start_slot_runtime(self: &Arc<Self>, id: &str, attempt: i64) -> Result<bool> {
        let agent = self.listed(id).await?;
        if agent.closed_at.is_some() || agent.disconnected_at.is_some() || agent.connection_state != "disconnected" {
            return Ok(false);
        }
        match agent.harness.as_str() {
            "claude" => self.claude_ensure(id).await.map(drop)?,
            "opencode" => self.opencode_ensure(id).await.map(drop)?,
            _ if attempt > 1 => self.reconcile(id).await?,
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
    /// A machine's: whole numbers 1 to 64, or none for the default. Named
    /// for the Workspace or a Project, it is refused (S5).
    #[serde(default)]
    slots: Option<Value>,
    /// The Workspace's only: whole seconds, 30 to 3600; none keeps it.
    #[serde(default)]
    start_limit_seconds: Option<Value>,
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

fn start_limit_of(input: &Save) -> Result<Option<i64>> {
    match &input.start_limit_seconds {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_i64().filter(|n| START_LIMITS.contains(n)) {
            Some(n) if value.is_i64() || value.is_u64() => Ok(Some(n)),
            _ => bail!("invalid_input: a start's time limit is a whole number of seconds from 30 to 3600"),
        },
    }
}

async fn get_slots(AxumState(ws): AxumState<Arc<Workspace>>, Query(query): Query<ForProject>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.stored(move |s| s.executor_slots_view(query.project_id.as_deref())).await?))
}

async fn put_slots(AxumState(ws): AxumState<Arc<Workspace>>, Json(input): Json<Save>) -> Result<Json<Value>, ApiError> {
    let (slots, start_limit) = (slots_of(&input)?, start_limit_of(&input)?);
    let view = ws.stored(move |s| {
        s.save_start_limit(input.expected_version, slots, start_limit)?;
        s.executor_slots_view(None)
    }).await?;
    ws.changes.send(json!({"executorSlots": true}));
    ws.wake_executor_slots();
    Ok(Json(view))
}

/// A Project's own number from an older page (S5): refused, whatever it sends.
async fn put_project_slots() -> Result<Json<Value>, ApiError> {
    Err(anyhow::anyhow!(SETTING_REMOVED).into())
}

/// A machine's own limit: `slots` (1 to 64), or null to clear it. A start
/// time limit is the Workspace's alone.
async fn put_machine_slots(
    AxumState(ws): AxumState<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(input): Json<Save>,
) -> Result<Json<Value>, ApiError> {
    let (slots, start_limit) = (slots_of(&input)?, start_limit_of(&input)?);
    if start_limit.is_some() {
        return Err(anyhow::anyhow!("invalid_input: a start's time limit is the Workspace's, not a machine's").into());
    }
    let view = ws.stored(move |s| {
        s.save_machine_slots(&id, input.expected_version, slots)?;
        s.executor_slots_view(None)
    }).await?;
    ws.changes.send(json!({"executorSlots": true}));
    ws.wake_executor_slots();
    Ok(Json(view))
}

/// Only the user changes the limits: browser routes, never a collaboration operation.
pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/executor-slots", get(get_slots).put(put_slots))
        .route("/api/projects/{id}/executor-slots", put(put_project_slots))
        .route("/api/machines/{id}/executor-slots", put(put_machine_slots))
}

#[cfg(test)]
#[path = "executor_slots_tests.rs"]
mod tests;
