//! An executor whose start from its slot failed (T-35 S2,
//! docs/executor-model.md): what Core does about it. The store's side is
//! collaboration_store/executor_start.rs.
//!
//! A start ends without its runtime in one of two ways. **Definite**: the
//! runtime refused (an ensure error that is not OutcomeUnknown), or the start
//! was cut off by the Workspace's time limit and closing the executor
//! confirmed its runtime ended; on another machine, either only when nothing
//! was launched there or a stop confirmed it ended (`remote_start_stopped`,
//! T-35 S3b). **Uncertain**: the runtime may be running after all. Then the executor keeps its slot as starting, with why, and the
//! dispatcher gets one mail; Core neither closes nor rebuilds it, for two
//! executors must never work in one folder (D4; Lead 2, mail 5367).
//!
//! After a definite failure, a fresh dispatch's executor is closed and kept,
//! its close carrying the record of its settling (executor_slots.rs
//! `follow_agent`), and rebuilt once: a new dispatch of the
//! same request by the same dispatcher (D3), whose executor keeps the queue
//! place of the one it replaces. When that one fails too, or no rebuild can
//! be made, the task is blocked, by Core, with every reason, and an Agent
//! dispatcher gets one mail. A rebuild an update's drain refuses waits, and a
//! later pass makes it. An executor the user reopened keeps S1's rule: it
//! stays open with its slot and the reason, for the user's Connect or Close.
use crate::{
    collaboration_store::executor_start::{rebuild_request, Made},
    executor_dispatch::WaitsForUpdate,
    executor_slots::START_FAILED,
    updates::admission::Permit,
    workspace::Workspace,
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

/// How a start from the slot ended without its runtime, and why.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Failure {
    Definite(String),
    Uncertain(String),
}

/// A start cut off by the time limit: a definite failure only when closing
/// the executor confirmed its runtime ended (`closed`). Otherwise its runtime
/// may run on: uncertain, held, never rebuilt, so that no second executor
/// ever works in its folder.
pub(crate) fn cut_off(closed: &Result<()>, limit: Duration) -> Failure {
    match closed {
        Ok(()) => Failure::Definite(closed_when_cut(limit)),
        Err(error) => Failure::Uncertain(format!("{}, and Core could not confirm its runtime stopped: {error:#}", cut(limit))),
    }
}

/// Why a start the time limit cut off ended.
pub(crate) fn cut(limit: Duration) -> String {
    format!("its start did not finish within {} s, the Workspace's limit", limit.as_secs())
}

/// Why, once Core closed it: what its close records (`cut_off`'s definite).
pub(crate) fn closed_when_cut(limit: Duration) -> String {
    format!("{}; Core closed it", cut(limit))
}

impl Workspace {
    /// Closes a fresh executor whose start failed, its close carrying why:
    /// in the close's own transaction its slot says why and, when its
    /// template dispatch is still its task's, the record of its settling is
    /// written (executor_slots.rs `follow_agent`, T-35 S3b). Both commit, or
    /// neither: an error leaves it open, its slot starting.
    pub(crate) async fn close_start_failed(self: &Arc<Self>, id: &str, permit: &Permit, why: &str) -> Result<()> {
        permit.validate(&self.admission)?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        self.close_agent_locked(id, json!({"reason": START_FAILED, "why": why})).await.map(drop)
    }

    /// Settles a start from the slot that ended without its runtime.
    /// `closed`: a cut-off start Core already closed, its runtime confirmed
    /// ended (or never launched) and its record carried by that close.
    pub(crate) async fn settle_start(self: &Arc<Self>, id: &str, permit: &Permit, failure: Failure, closed: bool) -> Result<()> {
        let agent = id.to_owned();
        let attempt = self.stored(move |store| store.executor_slot_attempt(&agent)).await?;
        let why = match failure {
            Failure::Uncertain(why) => return self.hold_uncertain(id, why).await,
            Failure::Definite(why) => why,
        };
        // Reopened by the user: S1's rule, open with its slot and the reason.
        if attempt.unwrap_or(1) > 1 {
            if !closed {
                let (agent, reason) = (id.to_owned(), why.clone());
                self.stored(move |store| store.executor_slot_not_started(&agent, false, &reason)).await?;
            }
            return Ok(());
        }
        if !closed {
            // On another machine its runtime may have been launched: a stop
            // that confirms it ended comes first (Lead 2, mail 5898).
            if let Err(error) = self.remote_start_stopped(id).await {
                let held = format!("{why}, and Core could not confirm its runtime stopped: {error:#}");
                return self.hold_uncertain(id, held).await;
            }
            // Its runtime ended; closing is what releases its slot, and the
            // close carries the record. A close that can't confirm the runtime
            // stopped, or can't be written, leaves it uncertain.
            if let Err(error) = self.close_start_failed(id, permit, &why).await {
                let held = format!("{why}, and Core could not close it: {error:#}");
                return self.hold_uncertain(id, held).await;
            }
        }
        // Not made by a template dispatch Core can repeat, or its task moved
        // on: its close wrote no record, and it stays closed, as in S1. A
        // store error here leaves the record, for a pass to finish.
        let agent = id.to_owned();
        let Some(made) = self.stored(move |store| store.executor_settling(&agent)).await? else { return Ok(()) };
        self.finish(made, id, why).await
    }

    /// After a settling executor's close: blocks its task when the executor
    /// was itself a rebuild (rebuilt once), else rebuilds it. Its record says
    /// which at once: a rebuild's is done in the transaction of its dispatch.
    async fn finish(self: &Arc<Self>, made: Made, id: &str, why: String) -> Result<()> {
        let agent = id.to_owned();
        match self.stored(move |store| store.executor_rebuilt_from(&agent)).await? {
            Some((first, first_why)) => {
                let reasons = vec![(first, first_why), (id.to_owned(), why)];
                self.block_start(&made, id, reasons, None).await
            }
            None => self.rebuild(made, id, why).await,
        }
    }

    /// An uncertain start: its slot is held as starting with why, and an
    /// Agent dispatcher gets one mail. Nothing is closed or rebuilt, and a
    /// record of its settling goes.
    async fn hold_uncertain(self: &Arc<Self>, id: &str, why: String) -> Result<()> {
        let agent = id.to_owned();
        self.stored(move |store| store.executor_rebuild_discard(&agent)).await?;
        let (agent, reason) = (id.to_owned(), why.clone());
        self.stored(move |store| store.executor_slot_not_started(&agent, true, &reason)).await?;
        let agent = id.to_owned();
        let Some(made) = self.stored(move |store| store.executor_made(&agent)).await? else { return Ok(()) };
        let Some(dispatcher) = made.dispatcher().map(str::to_owned) else { return Ok(()) };
        let name = self.agent_name(id).await;
        let number = self.task_number(&made.task_id).await;
        let body = format!("{number}: its executor {name} may have started: Core could not confirm its start ({why}). \
            It keeps its executor slot, and Core neither closes nor rebuilds it. Connect it to check; Close frees its slot.");
        let (task, agent) = (made.task_id.clone(), id.to_owned());
        self.stored(move |store| store.executor_start_mail(&task, &agent, &dispatcher, "uncertain", body)).await?;
        Ok(())
    }

    /// The one rebuild: a new dispatch of the same request by the same
    /// dispatcher, made as it was (executor_dispatch.rs); its record is done,
    /// and its executor keeps the queue place of the one it replaces, in that
    /// dispatch's transaction. Refused while an update drains, it stays
    /// pending; one Core can't make otherwise blocks the task with why.
    async fn rebuild(self: &Arc<Self>, made: Made, from: &str, why: String) -> Result<()> {
        let (task, agent) = (made.task_id.clone(), from.to_owned());
        if !self.stored(move |store| store.executor_still_dispatched(&task, &agent)).await? {
            let agent = from.to_owned();
            return self.stored(move |store| store.executor_rebuild_failed(&agent, "task_moved_on: the task no longer waits on this executor")).await;
        }
        let task = made.task_id.clone();
        let version = self.stored(move |store| {
            Ok(store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"current"}))?["current"]["version"].clone())
        }).await?;
        let mut input = made.input.clone();
        input["requestId"] = json!(rebuild_request(from));
        input["expectedVersion"] = version;
        // On the machine the first one was made on, so it works in the same
        // folder (T-35 S3a), whatever its template says now.
        input["executor"]["machineId"] = json!(made.machine);
        #[cfg(test)]
        {
            let write = self.executor_slots.before_rebuild_dispatch.lock().unwrap().take();
            if let Some(write) = write {
                write();
            }
        }
        let dispatcher = made.dispatcher().map(str::to_owned);
        let error = match self.executor_dispatch(dispatcher.as_deref(), input).await {
            Ok(_) => {
                self.wake_executor_slots();
                return Ok(());
            }
            Err(error) => error,
        };
        // Nothing of it was written: a pass after the update, or the next
        // start, makes it (R1 dde34160).
        if error.downcast_ref::<WaitsForUpdate>().is_some() {
            return Ok(());
        }
        // The task changed between that read and the dispatch, which wrote
        // nothing: the next pass makes it, with the version then (R5
        // 902c2e9b). One refused later, past the executor's creation, has a
        // failed dispatch on record, and blocks the task as any other.
        let from_agent = from.to_owned();
        if format!("{error:#}").starts_with("version_conflict:")
            && self.stored(move |store| store.executor_rebuild_unbegun(&from_agent)).await?
        {
            return Ok(());
        }
        let reasons = vec![(from.to_owned(), why)];
        self.block_start(&made, from, reasons, Some(format!("{error:#}"))).await
    }

    /// The rebuilds a pass finishes: pending, their executor closed, and no
    /// dispatch of them begun (an update drained, or Core stopped before it).
    /// Each in a task of its own under a work permit, unless its settling is
    /// still in flight; while an update drains, none.
    pub(crate) async fn finish_rebuilds(self: &Arc<Self>, started: &mut Vec<tokio::task::JoinHandle<()>>) {
        let Ok(rows) = self.stored(|store| store.executor_rebuilds_waiting()).await else { return };
        for (from, why) in rows {
            if !self.executor_slots.in_flight.lock().unwrap().insert(from.clone()) {
                continue;
            }
            let Ok(permit) = self.admission.enter_work() else {
                self.executor_slots.in_flight.lock().unwrap().remove(&from);
                return;
            };
            let ws = self.clone();
            started.push(tokio::spawn(async move {
                let agent = from.clone();
                let finished = match ws.stored(move |store| store.executor_made(&agent)).await {
                    Ok(Some(made)) => ws.finish(made, &from, why).await,
                    // Its dispatch is no longer its: nothing to rebuild.
                    Ok(None) => {
                        let agent = from.clone();
                        ws.stored(move |store| store.executor_rebuild_failed(&agent, "task_moved_on: its dispatch is no longer the task's")).await
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = finished {
                    eprintln!("Executor {from}: {error:#}");
                }
                ws.executor_slots.in_flight.lock().unwrap().remove(&from);
                drop(permit);
                ws.wake_executor_slots();
            }));
        }
    }

    /// Blocks the task that `agent` is still the executor of, from Core,
    /// with every executor's reason, and `rebuild`: why no rebuild was made.
    /// The record of `agent`'s settling fails with it, in its transaction.
    async fn block_start(self: &Arc<Self>, made: &Made, agent: &str, reasons: Vec<(String, String)>, rebuild: Option<String>) -> Result<()> {
        let mut said = Vec::new();
        let mut executors = Vec::new();
        for (id, why) in &reasons {
            let name = self.agent_name(id).await;
            said.push(format!("{name}: {why}"));
            executors.push(json!({"agentId":id,"name":name,"reason":why}));
        }
        let number = self.task_number(&made.task_id).await;
        let (blocker, body) = match &rebuild {
            None => (
                format!("Its executor did not start, nor the one Core rebuilt for it. {}. Both are closed and kept; dispatch it again once the cause is fixed.", said.join(". ")),
                format!("{number} is blocked: its executor did not start, nor the one Core rebuilt for it. {}. Both are closed and kept; dispatch it again once the cause is fixed.", said.join(". ")),
            ),
            Some(error) => (
                format!("Its executor did not start, and Core could not rebuild it. {}. The rebuild: {error}. Dispatch it again once the cause is fixed.", said.join(". ")),
                format!("{number} is blocked: its executor did not start ({}), and Core could not rebuild it: {error}. Dispatch it again once the cause is fixed.", said.join(". ")),
            ),
        };
        let detail: Value = json!({"executors":executors,"rebuildError":rebuild});
        let (task, agent, dispatcher) = (made.task_id.clone(), agent.to_owned(), made.dispatcher().map(str::to_owned));
        self.stored(move |store| store.executor_start_blocked(&task, &agent, dispatcher.as_deref(), &blocker, detail, body)).await?;
        Ok(())
    }

    /// Before a failed start's close, cut off or refused (T-35 S3a/S3b,
    /// Lead 2 mails 5775, 5872 and 5898): on another machine, Ok only when
    /// nothing was launched there or a stop confirmed it ended. Nothing was
    /// launched when the start never asked (`launch_requested`, committed
    /// before the request went: a tunnel or admission refusal). Once it asked,
    /// for a Codex executor, exactly the runtime instance it recorded must be
    /// confirmed stopped: none recorded is no confirmation, for the helper
    /// calls what it can't find stopped. For a Claude Code executor, the host
    /// instance it recorded must answer `host_stop` (as Disconnect asks it)
    /// through this start's own connection to that instance: none recorded,
    /// or no such connection, is no confirmation. Ok at once on this Core
    /// host, where the dropped start ended its own process; that is read from
    /// the slot's row (R1 ec161975).
    pub(crate) async fn remote_start_stopped(self: &Arc<Self>, id: &str) -> Result<()> {
        let agent = id.to_owned();
        if self.stored(move |store| store.executor_slot_machine(&agent)).await?.is_none_or(|m| m == "local") {
            return Ok(());
        }
        let agent = self.listed(id).await?;
        let Some(remote) = agent.remote else { return Ok(()) };
        if !remote.launch_requested {
            return Ok(());
        }
        let machine = remote.machine.name.clone();
        if agent.harness == "claude" {
            let instance = remote.host_instance.as_deref().with_context(|| {
                format!("Core asked {machine} to start Claude's host, and no host answered, so nothing confirmed it stopped")
            })?;
            let connection = self.claudes.lock().unwrap().get(id)
                .filter(|c| c.remote_instance.as_deref() == Some(instance)).map(|c| c.bridge.clone());
            let bridge = connection.with_context(|| {
                format!("this start has no connection to Claude's host {instance} on {machine}, so nothing confirmed it stopped")
            })?;
            let answer = bridge.request(json!({"op":"host_stop"})).await?;
            ensure!(answer["stopped"] == true, "Claude's host {instance} on {machine} didn't confirm it stopped: {answer}");
            return Ok(());
        }
        let runtime = remote.runtime.as_ref().with_context(|| {
            format!("Core asked {machine} to start its runtime, and none was recorded, so no stop could confirm it ended")
        })?;
        let workspace = self.stored(|store| store.workspace_id()).await?;
        crate::remote::stop_runtime_instance(&remote.machine, &workspace, id, runtime).await
    }

    /// A remote start is about to ask its machine to launch the runtime
    /// (`kind`: Codex's `runtime/ensuring`, Claude Code's
    /// `claude/hostEnsuring`): recorded and committed first, so a failed
    /// start knows whether anything could have been launched there
    /// (`remote_start_stopped`, Lead 2 mail 5898).
    pub(crate) async fn launch_requested(&self, id: &str, kind: &str) -> Result<()> {
        #[cfg(test)]
        if self.executor_slots.fault_before_launch.load(std::sync::atomic::Ordering::Relaxed) {
            anyhow::bail!("a test's refusal before the machine was asked to launch anything");
        }
        self.record_meta(id, kind, json!({}), |m| {
            if let Some(remote) = &mut m.agent.remote {
                remote.launch_requested = true;
            }
        }).await
    }

    async fn agent_name(&self, id: &str) -> String {
        self.listed(id).await.map_or_else(|_| id.to_owned(), |a| a.name)
    }

    async fn task_number(&self, task: &str) -> String {
        let task = task.to_owned();
        self.stored(move |store| Ok(store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"current"}))?["current"]["taskId"]
            .as_str().unwrap_or("The task").to_owned())).await.unwrap_or_else(|_| "The task".into())
    }
}

#[cfg(test)]
#[path = "executor_start_tests.rs"]
mod tests;
