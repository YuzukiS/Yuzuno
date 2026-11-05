//! A task dispatched from an executor template, as the runtime does it (T-34,
//! executor model phase 1; docs/executor-model.md; its rows are
//! collaboration_store/executor_dispatch.rs). The executor is created first,
//! as POST /api/agents creates an Agent, without starting its runtime; the
//! task is then dispatched to it in the store's own transaction, its mail
//! queued, and it waits for an executor slot; the scheduler starts its runtime
//! when one is free (executor_slots.rs, T-35), and the mail is delivered once
//! it is connected. A failure after the executor exists closes it.
use crate::{
    collaboration_store::executor_dispatch::{Dispatch, Next, Plan},
    updates::admission::Permit,
    workspace::{Birth, Workspace},
};
use anyhow::{anyhow, ensure, Context, Result};
use serde_json::Value;
use std::{path::Path, sync::Arc};

/// Why a template dispatch is refused while an update drains, when an
/// ordinary one is not: it creates an Agent, work an update waits for. The
/// permit comes before the row is read, so a retry of one already made is
/// refused too, and gets its recorded answer after the update (Lead 5080).
const UPDATING: &str = "workspace_updating: Workspace is preparing an update, and a dispatch from an executor template waits for it, as creating an Agent does. Retry the same request once the update is done: a dispatch it already made returns its recorded answer, and one it had not made goes ahead then. A dispatch to an existing Agent is not refused";

impl Workspace {
    /// `task_dispatch` with `executor` instead of `toAgentId`.
    pub(crate) async fn executor_dispatch(self: &Arc<Self>, actor: Option<&str>, input: Value) -> Result<Value> {
        // Taken as POST /api/agents takes it, before anything is written.
        let permit = self.admission.enter_work().map_err(|_| anyhow!(UPDATING))?;
        ensure!(input.get("toAgentId").is_none(), "invalid_input: give toAgentId or executor, not both");
        let who = actor.map(str::to_owned);
        let next = self.stored(move |store| store.executor_dispatch_begin(who.as_deref(), input)).await?;
        let dispatch = match next {
            Next::Dispatch(dispatch) => dispatch,
            Next::Create(plan) => {
                if let Err(error) = self.create_executor(&plan).await {
                    return Err(self.executor_failed(&plan.dispatch, error, &permit).await);
                }
                plan.dispatch
            }
        };
        let answer = match self.admission.enter_completion() {
            Ok(completion) => self.collaboration_stored(completion, actor, "task_dispatch", dispatch.input.clone()).await,
            Err(error) => Err(error),
        };
        match answer {
            Ok(answer) => {
                drop(permit);
                // Its slot, when one is free; a retry of a dispatch whose
                // start a stopped Core missed waits for one again too.
                self.spawn_executor_slots_pass();
                Ok(answer)
            }
            Err(error) => Err(self.executor_failed(&dispatch, error, &permit).await),
        }
    }

    async fn create_executor(self: &Arc<Self>, plan: &Plan) -> Result<()> {
        // Core makes no folder (task_workspaces.rs is the user's alone).
        let cwd = plan.folders.iter().find(|f| Path::new(f).is_absolute() && Path::new(f).is_dir()).cloned().with_context(|| {
            format!("no_folder: an executor works in a folder on this host, and {} is not one", plan.folders.join(", nor "))
        })?;
        let birth = Birth { id: plan.dispatch.agent_id.clone(), then: plan.then() };
        crate::server::create_executor(self, &plan.template, plan.name.clone(), cwd, plan.project_id.clone(), birth).await?;
        Ok(())
    }

    /// The dispatch failed: its row says why, and the executor it made is
    /// closed, not deleted. Returns `error`, for the caller.
    async fn executor_failed(self: &Arc<Self>, dispatch: &Dispatch, error: anyhow::Error, permit: &Permit) -> anyhow::Error {
        let (actor, request, why) = (dispatch.actor.clone(), dispatch.request_id.clone(), format!("{error:#}"));
        match self.stored(move |store| store.executor_dispatch_failed(&actor, &request, &why)).await {
            Ok(Some(agent)) => {
                if let Err(closing) = self.close_agent_admitted(&agent, permit).await {
                    eprintln!("Executor {agent}: its dispatch failed, and it could not be closed: {closing:#}");
                }
            }
            Ok(None) => {}
            Err(recording) => eprintln!("Executor dispatch {}: could not record that it failed: {recording:#}", dispatch.request_id),
        }
        error
    }
}
