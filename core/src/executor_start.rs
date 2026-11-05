//! An executor whose start from its slot failed (T-35 S2,
//! docs/executor-model.md): what Core does about it. The store's side is
//! collaboration_store/executor_start.rs.
//!
//! A start ends without its runtime in one of two ways. **Definite**: the
//! runtime refused (an ensure error that is not OutcomeUnknown), or the start
//! was cut off by the Workspace's time limit and closing the executor
//! confirmed its runtime ended. **Uncertain**: the runtime may be running
//! after all. Then the executor keeps its slot as starting, with why, and the
//! dispatcher gets one mail; Core neither closes nor rebuilds it, for two
//! executors must never work in one folder (D4; Lead 2, mail 5367).
//!
//! After a definite failure, a fresh dispatch's executor is closed and kept,
//! and rebuilt once: a new dispatch of the same request by the same
//! dispatcher (D3), whose executor keeps the queue place of the one it
//! replaces. When that one fails too, or no rebuild can be made, the task is
//! blocked, by Core, with every reason, and an Agent dispatcher gets one
//! mail. An executor the user reopened keeps S1's rule: it stays open with
//! its slot and the reason, for the user's Connect or Close.
use crate::{
    collaboration_store::executor_start::{rebuild_request, Made},
    updates::admission::Permit,
    workspace::Workspace,
};
use anyhow::Result;
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
    let why = format!("its start did not finish within {} s, the Workspace's limit", limit.as_secs());
    match closed {
        Ok(()) => Failure::Definite(format!("{why}; Core closed it")),
        Err(error) => Failure::Uncertain(format!("{why}, and Core could not confirm its runtime stopped: {error:#}")),
    }
}

impl Workspace {
    /// Settles a start from the slot that ended without its runtime.
    /// `closed`: a cut-off start whose close confirmed its runtime ended.
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
            // Its runtime ended; closing is what releases its slot. A close
            // that can't confirm the runtime stopped leaves it uncertain.
            if let Err(error) = self.close_agent_admitted(id, permit).await {
                let held = format!("{why}, and Core could not close it: {error:#}");
                return self.hold_uncertain(id, held).await;
            }
        }
        let (agent, reason) = (id.to_owned(), why.clone());
        self.stored(move |store| store.executor_slot_released_because(&agent, &reason)).await?;
        let agent = id.to_owned();
        let Some(made) = self.stored(move |store| store.executor_made(&agent)).await? else {
            // Not made by a template dispatch Core can repeat: closed, as in S1.
            return Ok(());
        };
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
    /// Agent dispatcher gets one mail. Nothing is closed or rebuilt.
    async fn hold_uncertain(self: &Arc<Self>, id: &str, why: String) -> Result<()> {
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
    /// dispatcher, made as it was (executor_dispatch.rs). Its executor keeps
    /// the queue place of the one it replaces. One Core can't make blocks
    /// the task with why.
    async fn rebuild(self: &Arc<Self>, made: Made, from: &str, why: String) -> Result<()> {
        let (task, agent) = (made.task_id.clone(), from.to_owned());
        if !self.stored(move |store| store.executor_still_dispatched(&task, &agent)).await? {
            return Ok(());
        }
        let (record, agent, reason) = (made.clone(), from.to_owned(), why.clone());
        self.stored(move |store| store.executor_rebuild_begin(&record, &agent, &reason)).await?;
        let task = made.task_id.clone();
        let version = self.stored(move |store| {
            Ok(store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"current"}))?["current"]["version"].clone())
        }).await?;
        let mut input = made.input.clone();
        input["requestId"] = json!(rebuild_request(from));
        input["expectedVersion"] = version;
        let dispatcher = made.dispatcher().map(str::to_owned);
        match self.executor_dispatch(dispatcher.as_deref(), input).await {
            Ok(answer) => {
                let to = answer["agentId"].as_str().unwrap_or_default().to_owned();
                let dispatch = answer["task"]["dispatch"]["id"].as_str().unwrap_or_default().to_owned();
                let from = from.to_owned();
                self.stored(move |store| store.executor_rebuild_done(&from, &to, &dispatch)).await?;
                self.wake_executor_slots();
                Ok(())
            }
            Err(error) => {
                let (agent, message) = (from.to_owned(), format!("{error:#}"));
                self.stored(move |store| store.executor_rebuild_failed(&agent, &message)).await?;
                let reasons = vec![(from.to_owned(), why)];
                self.block_start(&made, from, reasons, Some(format!("{error:#}"))).await
            }
        }
    }

    /// Blocks the task that `agent` is still the executor of, from Core,
    /// with every executor's reason, and `rebuild`: why no rebuild was made.
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
