//! A template executor whose start from its slot failed (T-35 S2,
//! docs/executor-model.md): the store's side. The runtime's is
//! executor_start.rs.
//!
//! The first definite failure of a fresh dispatch's executor is rebuilt
//! once: a new dispatch of the same request by the same dispatcher, made as
//! that request was. Its record here is written pending before Core closes
//! the executor, done with the Agent and dispatch it made (in that dispatch's
//! own transaction), or failed with why. A second failure, or a rebuild Core
//! can't make, blocks the task. Core writes that itself, as a system actor,
//! and mails the dispatcher when it is an Agent.
use super::{activity, executor_dispatch::actor_key, insert_message, load_task, save_task, task_number, SharedTask, TaskActor};
use crate::{model::now, store::Store};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// Runs on every open, with the collaboration tables.
pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS executor_rebuilds(
            from_agent TEXT PRIMARY KEY,
            -- The dispatch it replaces: its dispatcher, request, task and dispatch.
            actor TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, from_dispatch TEXT,
            reason TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','done','failed')),
            to_agent TEXT, to_dispatch TEXT, error TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS executor_rebuilds_to ON executor_rebuilds(to_agent);
        CREATE INDEX IF NOT EXISTS executor_rebuilds_dispatch ON executor_rebuilds(from_dispatch);",
    )?;
    Ok(())
}

/// Core, writing what neither the user nor an Agent did.
fn core() -> TaskActor {
    TaskActor { kind: "system".into(), id: "core".into(), name: "Yuzuno Core".into() }
}

/// The requestId of a rebuild: one per executor it replaces.
pub(crate) fn rebuild_request(agent: &str) -> String {
    format!("rebuild:{agent}")
}

/// The template dispatch that made an executor, once dispatched: who
/// dispatched it, its request and the task.
#[derive(Clone, Debug)]
pub(crate) struct Made {
    /// `user`, or `agent:<id>`.
    pub(crate) actor: String,
    pub(crate) request_id: String,
    pub(crate) input: Value,
    pub(crate) task_id: String,
    pub(crate) dispatch_id: Option<String>,
    /// The machine it runs on: `local`, or a registered machine's id.
    pub(crate) machine: String,
}

impl Made {
    /// The dispatcher as task_dispatch takes it: none for the user.
    pub(crate) fn dispatcher(&self) -> Option<&str> {
        self.actor.strip_prefix("agent:")
    }
}

/// Whether `agent` is still the task's current executor: its dispatch is
/// active, and the task is neither ended nor archived.
fn still_its(task: &SharedTask, agent: &str) -> bool {
    task.dispatch.as_ref().is_some_and(|d| d.active && d.executor.id == agent)
        && task.archived_at.is_none()
        && !matches!(task.status.as_str(), "done" | "cancelled")
}

/// One system mail to the dispatcher, about this task. False, with nothing
/// sent, when that Agent no longer exists: Agents can be deleted, and their
/// executors' rows outlive them, so a missing dispatcher must not undo the
/// write the mail is part of (R3 f6885381).
fn mail(store: &Store, db: &Connection, task: &SharedTask, dispatcher: &str, agent: &str, status: &str, body: String) -> Result<bool> {
    let Some(brief) = store.brief_in(db, dispatcher)? else { return Ok(false) };
    let recipient = TaskActor { kind: "agent".into(), id: brief.agent.id, name: brief.agent.name };
    let id = uuid::Uuid::new_v4().to_string();
    insert_message(db, json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
        "recipient":recipient,"body":body,"taskId":task.id,"replyTo":null,"threadId":id,"createdAt":now(),
        "priority":"normal","source":{"executorAgentId":agent},
        "metadata":{"kind":"executor","status":status,"agentId":agent,"name":task_number(task.seq)}}))?;
    Ok(true)
}

impl Store {
    /// The dispatch that made this executor, once it was dispatched.
    pub(crate) fn executor_made(&self, agent: &str) -> Result<Option<Made>> {
        let row: Option<(String, String, String, String, Option<String>, String)> = self.db.read()?.query_row(
            "SELECT actor, request_id, input_json, task_id, dispatch_id, machine_id FROM executor_dispatches WHERE agent_id=?1 AND state='dispatched'",
            [agent], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).optional()?;
        row.map(|(actor, request_id, input, task_id, dispatch_id, machine)| {
            Ok(Made { actor, request_id, input: serde_json::from_str(&input)?, task_id, dispatch_id, machine })
        }).transpose()
    }

    /// Whether `agent` is still its task's current executor.
    pub(crate) fn executor_still_dispatched(&self, task: &str, agent: &str) -> Result<bool> {
        let db = self.db.read()?;
        Ok(still_its(&load_task(&db, task)?, agent))
    }

    /// The executor a rebuild made `agent` to replace, and why: none when no
    /// rebuild made it.
    pub(crate) fn executor_rebuilt_from(&self, agent: &str) -> Result<Option<(String, String)>> {
        Ok(self.db.read()?.query_row(
            "SELECT from_agent, reason FROM executor_rebuilds WHERE to_agent=?1 AND state='done'",
            [agent], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
    }

    /// A failed start is being settled: recorded, pending, before Core closes
    /// the executor, so a stop after the close leaves this row for a pass or
    /// the next start to finish (R1 dde34160). Written again, it keeps the
    /// latest reason while pending.
    pub(crate) fn executor_rebuild_begin(&self, made: &Made, agent: &str, reason: &str) -> Result<()> {
        let at = now();
        self.db.write()?.execute(
            "INSERT INTO executor_rebuilds(from_agent,actor,request_id,task_id,from_dispatch,reason,state,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,'pending',?7,?7)
             ON CONFLICT(from_agent) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at
             WHERE executor_rebuilds.state='pending'",
            params![agent, made.actor, made.request_id, made.task_id, made.dispatch_id, reason, at],
        )?;
        Ok(())
    }

    /// Its start may have happened after all: Core neither closes nor
    /// rebuilds it, so its pending record goes.
    pub(crate) fn executor_rebuild_discard(&self, agent: &str) -> Result<()> {
        self.db.write()?.execute("DELETE FROM executor_rebuilds WHERE from_agent=?1 AND state='pending'", [agent])?;
        Ok(())
    }

    /// The pending rebuilds a pass finishes: their executor is closed, and
    /// no dispatch of the rebuild was begun (an update drained, or Core
    /// stopped before it). Each with its reason.
    pub(crate) fn executor_rebuilds_waiting(&self) -> Result<Vec<(String, String)>> {
        Ok(self.db.read()?
            .prepare(
                "SELECT r.from_agent, r.reason FROM executor_rebuilds r JOIN agents a ON a.id=r.from_agent
                 WHERE r.state='pending' AND json_extract(a.data,'$.agent.closedAt') IS NOT NULL
                   AND NOT EXISTS(SELECT 1 FROM executor_dispatches d WHERE d.actor=r.actor AND d.request_id='rebuild:'||r.from_agent)
                 ORDER BY r.created_at",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Whether no dispatch of `from`'s rebuild was begun: a refusal before
    /// anything was written can be retried with the same requestId.
    pub(crate) fn executor_rebuild_unbegun(&self, from: &str) -> Result<bool> {
        Ok(self.db.read()?.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM executor_rebuilds r JOIN executor_dispatches d
                ON d.actor=r.actor AND d.request_id='rebuild:'||r.from_agent WHERE r.from_agent=?1)",
            [from], |r| r.get(0))?)
    }

    /// No rebuild is made, and why (its task moved on).
    pub(crate) fn executor_rebuild_failed(&self, from: &str, error: &str) -> Result<()> {
        self.db.write()?.execute(
            "UPDATE executor_rebuilds SET state='failed',error=?2,updated_at=?3 WHERE from_agent=?1 AND state='pending'",
            params![from, error, now()],
        )?;
        Ok(())
    }

    /// Blocks the task that `agent` is still the current executor of, from
    /// Core: its status `blocked`, `blocker` why, the activity naming the
    /// dispatcher, the executors and their reasons (`detail`), and, for an
    /// Agent dispatcher, one mail. False when the task has moved on.
    pub(crate) fn executor_start_blocked(&self, task: &str, agent: &str, dispatcher: Option<&str>, blocker: &str,
        detail: Value, mail_body: String) -> Result<bool> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let blocked = block(self, &tx, task, agent, dispatcher, blocker, detail, mail_body)?;
        tx.commit()?;
        Ok(blocked)
    }

    /// One mail to an Agent dispatcher about its task's executor (an
    /// uncertain start, D4), while that executor is still the task's and
    /// that Agent still exists.
    pub(crate) fn executor_start_mail(&self, task: &str, agent: &str, dispatcher: &str, status: &str, body: String) -> Result<bool> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let task = load_task(&tx, task)?;
        if !still_its(&task, agent) {
            return Ok(false);
        }
        let sent = mail(self, &tx, &task, dispatcher, agent, status, body)?;
        tx.commit()?;
        Ok(sent)
    }

    /// At startup, after the dispatches a stopped Core left unfinished have
    /// failed (`recover_executor_dispatches`), each pending record by where
    /// Core stopped:
    /// - before it closed the executor: the record goes, and the start waits
    ///   again (`recover_executor_slots`), to be settled anew if it fails;
    /// - after the close, before a rebuild's dispatch began: it stays, and
    ///   the first pass finishes it (`executor_rebuilds_waiting`);
    /// - while the rebuild's dispatch was being made: it is completed when
    ///   that dispatch was made, else the task is blocked, "Core restarted
    ///   while it rebuilt" it, as it would otherwise wait on a closed executor.
    pub(crate) fn recover_executor_rebuilds(&self) -> Result<()> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let pending: Vec<(String, String, String, bool)> = tx
            .prepare(
                "SELECT r.from_agent, r.actor, r.task_id, json_extract(a.data,'$.agent.closedAt') IS NOT NULL
                 FROM executor_rebuilds r LEFT JOIN agents a ON a.id=r.from_agent WHERE r.state='pending'",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<bool>>(3)?.unwrap_or(false))))?
            .collect::<rusqlite::Result<_>>()?;
        for (from, actor, task, closed) in pending {
            if !closed {
                tx.execute("DELETE FROM executor_rebuilds WHERE from_agent=?1", [&from])?;
                continue;
            }
            let made: Option<(String, Option<String>, String)> = tx.query_row(
                "SELECT agent_id, dispatch_id, state FROM executor_dispatches WHERE actor=?1 AND request_id=?2",
                params![actor, rebuild_request(&from)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
            match made {
                None => continue,
                Some((to, Some(dispatch), state)) if state == "dispatched" => {
                    complete(self, &tx, &from, &to, &dispatch)?;
                    continue;
                }
                Some(_) => {}
            }
            let why = "core_restarted: Core restarted while it rebuilt this task's executor, so no executor works on it";
            tx.execute(
                "UPDATE executor_rebuilds SET state='failed',error=?2,updated_at=?3 WHERE from_agent=?1",
                params![from, why, now()],
            )?;
            let dispatcher = actor.strip_prefix("agent:");
            let blocker = format!("Its executor did not start, and Core restarted while it rebuilt it. {why}. Dispatch it again.");
            let number = task_number(load_task(&tx, &task)?.seq);
            let body = format!("{number} is blocked: its executor did not start, and Core restarted while it rebuilt it, so no executor works on it. Dispatch it again.");
            block(self, &tx, &task, &from, dispatcher, &blocker, json!({"executors":[{"agentId":from}],"reason":why}), body)?;
        }
        tx.commit()?;
        Ok(())
    }
}

/// In the transaction that dispatches a task to a template executor: when
/// that dispatch is a rebuild (`rebuild:<agent>` by the same actor, with that
/// agent's rebuild pending), its record is done here, and the executor takes
/// the first one's place in the queue, before any pass can start it. So a
/// rebuilt executor that fails at once is known as one, and never rebuilt
/// again (R1 dde34160).
pub(super) fn rebuilt(store: &Store, tx: &Connection, actor: &TaskActor, request: &str, to: &str, dispatch: &str) -> Result<()> {
    let Some(from) = request.strip_prefix("rebuild:") else { return Ok(()) };
    let pending: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM executor_rebuilds WHERE from_agent=?1 AND actor=?2 AND state='pending')",
        params![from, actor_key(actor)], |r| r.get(0))?;
    if pending {
        complete(store, tx, from, to, dispatch)?;
    }
    Ok(())
}

/// A rebuild's record done with the executor `to` it made (its dispatch
/// `dispatch`), which keeps the queue place of the one it replaces; the task
/// says so, from Core. In the caller's transaction.
fn complete(store: &Store, tx: &Connection, from: &str, to: &str, dispatch: &str) -> Result<()> {
    let (task, reason): (String, String) = tx.query_row(
        "SELECT task_id, reason FROM executor_rebuilds WHERE from_agent=?1", [from], |r| Ok((r.get(0)?, r.get(1)?)))
        .context("no rebuild of this executor")?;
    tx.execute(
        "UPDATE executor_rebuilds SET state='done',to_agent=?2,to_dispatch=?3,updated_at=?4 WHERE from_agent=?1",
        params![from, to, dispatch, now()],
    )?;
    tx.execute(
        "UPDATE executor_slots SET seq=(SELECT seq FROM executor_slots WHERE agent_id=?2),
            queued_at=(SELECT queued_at FROM executor_slots WHERE agent_id=?2), rebuilt_from=?2
         WHERE agent_id=?1 AND EXISTS(SELECT 1 FROM executor_slots WHERE agent_id=?2)",
        params![to, from],
    )?;
    let name = |id: &str| store.brief_in(tx, id).ok().flatten().map_or_else(|| id.to_owned(), |b| b.agent.name);
    let body = format!("Its executor {} did not start: {reason}. Core closed it, kept it, and rebuilt it once as {} (dispatch {dispatch}), \
        which keeps its place in the queue.", name(from), name(to));
    activity(tx, &task, "comment", &core(), &json!({"executorRebuild":{"from":from,"to":to}}), json!({"body":body}))?;
    Ok(())
}

/// `executor_start_blocked`, in the caller's transaction. The pending record
/// of `agent`'s settling, if any, fails with it: blocked, or its task moved
/// on, nothing is left for a pass to finish.
#[allow(clippy::too_many_arguments)]
fn block(store: &Store, tx: &Connection, task: &str, agent: &str, dispatcher: Option<&str>, blocker: &str,
    detail: Value, mail_body: String) -> Result<bool> {
    let mut current = load_task(tx, task)?;
    let blocked = still_its(&current, agent);
    tx.execute(
        "UPDATE executor_rebuilds SET state='failed',error=?2,updated_at=?3 WHERE from_agent=?1 AND state='pending'",
        params![agent, if blocked { blocker } else { "task_moved_on: the task no longer waits on this executor" }, now()],
    )?;
    if !blocked {
        return Ok(false);
    }
    current.status = "blocked".into();
    current.blocker = blocker.to_owned();
    let actor = core();
    save_task(tx, &mut current, &actor)?;
    let mut detail = detail;
    detail["dispatcher"] = json!(dispatcher.map_or_else(|| json!({"kind":"user"}), |id| json!({"kind":"agent","id":id})));
    // A dispatching Agent deleted since gets no mail; the task is blocked
    // all the same, and its activity says the mail was not sent.
    if let Some(dispatcher) = dispatcher {
        if !mail(store, tx, &current, dispatcher, agent, "blocked", mail_body)? {
            detail["mail"] = json!("not_sent: the dispatching Agent no longer exists");
        }
    }
    activity(tx, &current.id, "updated", &actor, &json!({"executorStart":detail}),
        json!({"changes":{"status":"blocked","blocker":blocker},"taskVersion":current.version}))?;
    Ok(true)
}

/// What task_get with a superseded dispatch's id adds: the rebuild that
/// superseded it, and why (E1).
pub(super) fn superseded(db: &Connection, dispatch: &str) -> Result<Option<Value>> {
    Ok(db.query_row(
        "SELECT to_dispatch, to_agent, reason FROM executor_rebuilds WHERE from_dispatch=?1 AND state='done'",
        [dispatch], |r| Ok(json!({"byDispatchId":r.get::<_, String>(0)?,"byAgentId":r.get::<_, String>(1)?,
            "reason":format!("Its executor did not start: {}. Core rebuilt it as a new dispatch.", r.get::<_, String>(2)?)})),
    ).optional()?)
}
