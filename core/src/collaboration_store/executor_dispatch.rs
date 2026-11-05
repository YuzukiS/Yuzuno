//! A task dispatched from an executor template (T-34, executor model phase
//! 1; docs/executor-model.md): Core creates the Agent the task goes to. Each
//! such dispatch is a row of its own, keyed by its caller and requestId and
//! written before the Agent exists, so a retry finds it and never makes a
//! second Agent:
//! `pending` (checked, the Agent's id chosen) → `created` (the Agent exists,
//! an executor, written in the transaction that inserts its record) →
//! `dispatched` (the task is its, in the store's own task_dispatch
//! transaction); or `failed`, with why, the Agent it made closed but kept.
//! The runtime's side is executor_dispatch.rs. A dispatched executor waits
//! for its slot (executor_slots.rs, T-35) from that same transaction.
use super::{
    actor_context, allowed, check_version, dispatch_materials, load_task, normalize_task_input, optional_text,
    required_text, take_sha_check, task_number, TaskActor,
};
use crate::{executor_templates::Template, model::now, store::{InTransaction, Sel, Store}};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// Runs on every open, as the other collaboration tables do. No column
/// references an Agent: the row stays when its Agent is deleted.
pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS executor_dispatches(
            actor TEXT NOT NULL, request_id TEXT NOT NULL, input_json TEXT NOT NULL,
            task_id TEXT NOT NULL, template_id TEXT NOT NULL, project_id TEXT, machine_id TEXT NOT NULL,
            -- The template the executor is made from, as its dispatch's materials give it.
            template_json TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','created','dispatched','failed')),
            error TEXT, dispatch_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY(actor,request_id));
        CREATE INDEX IF NOT EXISTS executor_dispatches_agent ON executor_dispatches(agent_id);",
    )?;
    Ok(())
}

/// The caller as the collaboration receipts key it.
fn actor_key(actor: &TaskActor) -> String {
    if actor.kind == "agent" { format!("agent:{}", actor.id) } else { "user".into() }
}

/// The store's task_dispatch of this dispatch, once its executor exists.
#[derive(Debug)]
pub(crate) struct Dispatch {
    pub(crate) actor: String,
    pub(crate) request_id: String,
    pub(crate) agent_id: String,
    /// The caller's input, to that Agent: a retry of it is the same request.
    pub(crate) input: Value,
}

/// An executor to create, then dispatch the task to.
#[derive(Debug)]
pub(crate) struct Plan {
    pub(crate) dispatch: Dispatch,
    pub(crate) template: Template,
    pub(crate) name: String,
    /// Where it may work, in order: the dispatch's worktree, then its
    /// Project's folder on this host. The first that is a folder here holds.
    pub(crate) folders: Vec<String>,
    pub(crate) project_id: Option<String>,
    task_id: String,
}

/// What a template dispatch does next.
pub(crate) enum Next {
    Create(Box<Plan>),
    /// Its executor exists: dispatch the task to it, or replay the answer
    /// that did.
    Dispatch(Dispatch),
}

impl Plan {
    /// What creating the executor writes with its record: its role, and the
    /// row moved on to `created`. A row that ended meanwhile (a restart
    /// failed it) leaves no Agent.
    pub(crate) fn then(&self) -> InTransaction {
        let (actor, request, agent) = (self.dispatch.actor.clone(), self.dispatch.request_id.clone(), self.dispatch.agent_id.clone());
        let (project, template, task) = (self.project_id.clone(), self.template.id.clone(), self.task_id.clone());
        Box::new(move |db| {
            let at = now();
            let moved = db.execute(
                "UPDATE executor_dispatches SET state='created',updated_at=?4
                 WHERE actor=?1 AND request_id=?2 AND agent_id=?3 AND state='pending'",
                params![actor, request, agent, at],
            )?;
            ensure!(moved == 1, "dispatch_failed: this dispatch ended while its executor was being created");
            db.execute(
                "INSERT INTO agent_roles(agent_id,kind,project_id,template_id,task_id,created_by,created_at,updated_at)
                 VALUES(?1,'executor',?2,?3,?4,?5,?6,?6)",
                params![agent, project, template, task, actor, at],
            )?;
            Ok(())
        })
    }
}

fn store_input(request: &Value, sha_check: &Value, agent: &str) -> Value {
    let mut input = request.clone();
    input["toAgentId"] = json!(agent);
    if !sha_check.is_null() {
        input["shaCheck"] = sha_check.clone();
    }
    input
}

/// The store's task_dispatch of a template dispatch (its input names
/// `executor`): its row, `created` for this Agent, becomes `dispatched` in the
/// same transaction, so a dispatched task never has a failed executor, and
/// its executor waits for a slot. Returns the template the executor was made
/// from, for its materials.
pub(super) fn dispatched(db: &Connection, actor: &TaskActor, request: &str, agent: &str, dispatch: &str) -> Result<Value> {
    let at = now();
    let row: Option<(String, String, Option<String>, String, String)> = db
        .query_row(
            "SELECT template_json, task_id, project_id, machine_id, template_id FROM executor_dispatches
             WHERE actor=?1 AND request_id=?2 AND agent_id=?3 AND state='created'",
            params![actor_key(actor), request, agent], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .optional()?;
    let moved = db.execute(
        "UPDATE executor_dispatches SET state='dispatched',dispatch_id=?4,updated_at=?5
         WHERE actor=?1 AND request_id=?2 AND agent_id=?3 AND state='created'",
        params![actor_key(actor), request, agent, dispatch, at],
    )?;
    ensure!(moved == 1, "invalid_input: executor names a dispatch from an executor template, whose Agent Core makes; give toAgentId alone to dispatch to an existing Agent");
    db.execute("UPDATE agent_roles SET dispatch_id=?2,updated_at=?3 WHERE agent_id=?1 AND kind='executor'", params![agent, dispatch, at])?;
    let (template, task, project, machine, template_id) = row.context("the dispatch's template is missing")?;
    crate::executor_slots::enqueue(db, agent, &task, project.as_deref(), &machine, &template_id)?;
    Ok(serde_json::from_str(&template)?)
}

impl Store {
    /// A template dispatch's first step, in a transaction of its own. A
    /// known request goes on where it stopped: refused with another payload,
    /// its error when it failed, on to its Agent when that exists. A new one
    /// is checked (the task's version, not archived; who may; the template)
    /// and written `pending` with its Agent's id chosen.
    pub(crate) fn executor_dispatch_begin(&self, actor: Option<&str>, input: Value) -> Result<Next> {
        ensure!(input.is_object(), "invalid_input: expected an object");
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let input = normalize_task_input(&tx, "task_dispatch", input)?;
        // As for every dispatch, what GitHub said of the SHAs is no part of the request (T-31).
        let (request, sha_check) = take_sha_check("task_dispatch", input);
        allowed(&request, &["requestId", "taskId", "expectedVersion", "executor", "body", "priority", "materials"])?;
        let (author, _) = actor_context(self, &tx, actor)?;
        let key = actor_key(&author);
        let request_id = required_text(&request, "requestId", 128)?;
        let known: Option<(String, String, String, Option<String>)> = tx.query_row(
            "SELECT input_json,state,agent_id,error FROM executor_dispatches WHERE actor=?1 AND request_id=?2",
            params![key, request_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional()?;
        if let Some((payload, state, agent_id, error)) = known {
            ensure!(serde_json::from_str::<Value>(&payload)? == request, "idempotency_conflict: requestId already has a different payload");
            let input = store_input(&request, &sha_check, &agent_id);
            return match state.as_str() {
                "created" | "dispatched" => Ok(Next::Dispatch(Dispatch { actor: key, request_id, agent_id, input })),
                "pending" => bail!("dispatch_in_progress: this dispatch is still creating its executor; retry with the same requestId"),
                _ => bail!("{}", error.unwrap_or_else(|| "dispatch_failed: this dispatch failed".into())),
            };
        }
        let used: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM collaboration_requests WHERE actor=?1 AND operation='task_dispatch' AND request_id=?2)",
            params![key, request_id], |r| r.get(0))?;
        ensure!(!used, "idempotency_conflict: requestId already has a different payload");
        let executor = &request["executor"];
        ensure!(executor.is_object(), "invalid_input: executor is {{templateId, machineId?}}");
        allowed(executor, &["templateId", "machineId"])?;
        let template_id = required_text(executor, "templateId", 48)?;
        let machine = optional_text(executor, "machineId", 128)?;
        crate::executor_templates::this_host_only(machine.as_deref().filter(|m| !m.is_empty()))?;
        let task = load_task(&tx, &required_text(&request, "taskId", 128)?)?;
        check_version(&task, &request)?;
        ensure!(task.archived_at.is_none(), "task_archived: unarchive the task first");
        crate::agent_roles::may_dispatch_from_template(&tx, &author, &task.id)?;
        let project: Option<String> = tx
            .query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task.id], |r| r.get(0))
            .optional()?;
        if let Some(project) = &project {
            crate::projects::ensure_assignable(&tx, project)?;
        }
        let (template, source) = crate::executor_templates::template_in(&tx, project.as_deref(), &template_id)?.with_context(|| {
            format!("template_not_found: neither this task's Project nor the Workspace has an executor template {template_id}")
        })?;
        template.validate(crate::opencode_agent::enabled())?;
        let mut folders: Vec<String> = dispatch_materials::worktree(&tx, &task.id, &request)?.into_iter().collect();
        if let Some(project) = &project {
            folders.extend(crate::projects::default_dir(&tx, project, "local")?);
        }
        ensure!(
            !folders.is_empty(),
            "no_folder: an executor works in this dispatch's worktree, or else in its Project's folder on this host, and there is neither; Core makes no folder"
        );
        let agent_id = uuid::Uuid::new_v4().to_string();
        let at = now();
        // What the executor's materials say of its template (T-34, R1 b0046ce0):
        // its instructions reach it with the task, not only its settings.
        let given = json!({"id":template.id,"label":template.label,"source":source,"instructions":template.instructions});
        tx.execute(
            "INSERT INTO executor_dispatches(actor,request_id,input_json,task_id,template_id,project_id,machine_id,template_json,agent_id,state,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,'local',?7,?8,'pending',?9,?9)",
            params![key, request_id, request.to_string(), task.id, template.id, project, given.to_string(), agent_id, at],
        )?;
        tx.commit()?;
        Ok(Next::Create(Box::new(Plan {
            name: template.agent_name(&task_number(task.seq)),
            dispatch: Dispatch { input: store_input(&request, &sha_check, &agent_id), actor: key, request_id, agent_id },
            template,
            folders,
            project_id: project,
            task_id: task.id,
        })))
    }

    /// The dispatch ended without the task being its executor's: the row is
    /// `failed` with `error`. Returns the Agent it made, for the caller to
    /// close (it is kept, to see what happened).
    pub(crate) fn executor_dispatch_failed(&self, actor: &str, request: &str, error: &str) -> Result<Option<String>> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let made: Option<String> = tx
            .query_row(
                "SELECT agent_id FROM executor_dispatches WHERE actor=?1 AND request_id=?2 AND state='created'",
                params![actor, request], |r| r.get(0))
            .optional()?;
        tx.execute(
            "UPDATE executor_dispatches SET state='failed',error=?3,updated_at=?4
             WHERE actor=?1 AND request_id=?2 AND state IN ('pending','created')",
            params![actor, request, error, now()],
        )?;
        tx.commit()?;
        Ok(made)
    }

    /// At startup, before any runtime starts (Workspace::new): a dispatch a
    /// stopped Core left before its task was dispatched fails, and the Agent
    /// it made is closed. A retry of it gets that failure; another requestId
    /// dispatches again.
    pub(crate) fn recover_executor_dispatches(&self) -> Result<()> {
        let made: Vec<String> = {
            let mut writer = self.db.write()?;
            let tx = writer.transaction()?;
            let made = tx
                .prepare("SELECT agent_id FROM executor_dispatches WHERE state='created'")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            tx.execute(
                "UPDATE executor_dispatches SET state='failed',error=?1,updated_at=?2 WHERE state IN ('pending','created')",
                params![RESTARTED, now()],
            )?;
            tx.commit()?;
            made
        };
        for agent in made {
            if self.agent(&agent).is_ok_and(|a| a.closed_at.is_none()) {
                if let Err(error) = self.record_event(&agent, "agent/closed", &json!({}), Sel::Open, crate::workspace::mark_closed) {
                    eprintln!("Executor {agent}: Core restarted during its dispatch, and it could not be closed: {error:#}");
                }
            }
        }
        Ok(())
    }
}

const RESTARTED: &str = "core_restarted: Core restarted while this dispatch was creating its executor, so nothing was dispatched and the executor was closed; dispatch again with a new requestId";

#[cfg(test)]
#[path = "executor_dispatch_tests.rs"]
mod tests;
