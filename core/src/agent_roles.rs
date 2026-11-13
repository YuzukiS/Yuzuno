//! What kind of Agent each one is (T-33, executor model phase 0): a Project's
//! lead, a task's executor, or, with no row, a standing Agent the user made.
//! The kind lives in its own table, never in the Agent's JSON: older builds
//! rewrite that JSON and drop fields they do not know (model.rs, `project_id`
//! is kept apart the same way). An Agent the user creates, imports, forks
//! or moves into a Project leads it (YN-2 S4, the user's rule); the user may
//! remove a lead in the Project's settings. Executors are created by a
//! dispatch (phase 1, T-34), which only a lead of the task's Project, or the
//! user, may make, and never lead.
use crate::{collaboration_store::TaskActor, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Result};
use axum::{
    extract::{Path, State},
    routing,
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

pub const LEAD: &str = "lead";
pub const EXECUTOR: &str = "executor";
pub const STANDING: &str = "standing";

/// Runs on every open. Older builds set the same `user_version` and never
/// create these tables, so this is idempotent instead of gated on a schema
/// number. Every Core enables foreign keys, so deleting an Agent removes its
/// row even in older builds; the clean-up covers a manual edit without them.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_roles(
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('lead','executor')),
            -- The Project a lead was chosen for (R1 55e2e216): a lead leads it
            -- only while it is a member there, never wherever it is moved.
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            template_id TEXT, task_id TEXT, dispatch_id TEXT,
            created_by TEXT, state TEXT, archived_at TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            CHECK(kind!='lead' OR project_id IS NOT NULL));
        CREATE INDEX IF NOT EXISTS agent_roles_kind ON agent_roles(kind);
        CREATE TABLE IF NOT EXISTS project_lead_versions(
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            version INTEGER NOT NULL);
        DELETE FROM agent_roles WHERE agent_id NOT IN (SELECT id FROM agents);
        DELETE FROM project_lead_versions WHERE project_id NOT IN (SELECT id FROM projects);",
    )?;
    // Who released an executor (T-34), as the receipts key the caller. Added
    // to the table wherever it is missing; older builds leave it as it is.
    let released_by: bool =
        db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('agent_roles') WHERE name='released_by')", [], |r| r.get(0))?;
    if !released_by {
        db.execute("ALTER TABLE agent_roles ADD COLUMN released_by TEXT", [])?;
    }
    first_leads(db)
}

/// YN-2 S4, at upgrade: a Project whose leads were never saved (version 0)
/// gets every open member that is not an executor as its lead, written once:
/// its version moves on, so the list is the user's from then on. Before S4
/// such a Project's Home was written by those members, so they keep it. A
/// Project with a saved list keeps it as it is.
fn first_leads(db: &Connection) -> Result<()> {
    let mut query = db.prepare(
        "SELECT p.project_id, p.agent_id FROM project_agents p JOIN agents a ON a.id=p.agent_id
         WHERE json_extract(a.data,'$.agent.closedAt') IS NULL
           AND COALESCE((SELECT v.version FROM project_lead_versions v WHERE v.project_id=p.project_id), 0)=0
           AND NOT EXISTS(SELECT 1 FROM agent_roles r WHERE r.agent_id=p.agent_id AND r.kind='executor')
         ORDER BY p.rowid",
    )?;
    let members = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let at = crate::model::now();
    let mut written = BTreeSet::new();
    for (project, agent) in &members {
        if lead_row(db, agent, project, &at)? {
            written.insert(project);
        }
    }
    for project in written {
        bump(db, project)?;
    }
    Ok(())
}

/// A lead row for `agent` in `project`, as the user's save writes it: a lead
/// row an older Core's move left for another Project now names this one; an
/// executor row is never touched. Whether a row changed.
fn lead_row(db: &Connection, agent: &str, project: &str, at: &str) -> Result<bool> {
    Ok(db.execute(
        "INSERT INTO agent_roles(agent_id,kind,project_id,created_by,created_at,updated_at) VALUES(?1,'lead',?2,'user',?3,?3)
         ON CONFLICT(agent_id) DO UPDATE SET project_id=excluded.project_id, updated_at=excluded.updated_at
         WHERE agent_roles.kind='lead' AND agent_roles.project_id IS NOT excluded.project_id",
        params![agent, project, at],
    )? > 0)
}

/// A Project's leads changed outside a save: its version moves on, so a
/// settings page that read the old list reloads before saving.
fn bump(db: &Connection, project: &str) -> Result<()> {
    db.execute(
        "INSERT INTO project_lead_versions(project_id,version) VALUES(?1,1)
         ON CONFLICT(project_id) DO UPDATE SET version=version+1",
        [project],
    )?;
    Ok(())
}

/// The user made `agent` a member of `project`: created it there, imported
/// or forked it into it, or moved it there (YN-2 S4, the user's rule). It
/// leads the Project, unless it is an executor or closed; a saved list gains
/// it. Called at those entry points only, in their transaction after the
/// membership is written, never for an executor's creation or an Agent's
/// own call. Whether the leads changed, for the caller to announce.
pub(crate) fn user_added(db: &Connection, agent: &str, project: &str) -> Result<bool> {
    let open: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1 AND json_extract(data,'$.agent.closedAt') IS NULL)",
        [agent], |r| r.get(0))?;
    if !open || crate::projects::agent_project(db, agent)?.as_deref() != Some(project) {
        return Ok(false);
    }
    let changed = lead_row(db, agent, project, &crate::model::now())?;
    if changed {
        bump(db, project)?;
    }
    Ok(changed)
}

/// The rows that hold now: every executor row, and a lead row only while its
/// Agent is a member of the Project it was chosen for. A lead an older Core
/// moved elsewhere (it keeps no such rows) leads nowhere, never its new Project.
const HOLDING: &str = "(r.kind='executor' OR r.project_id=(SELECT p.project_id FROM project_agents p WHERE p.agent_id=r.agent_id))";

/// The Agent's kind: `lead`, `executor`, or `standing` when no row holds.
pub(crate) fn kind(db: &Connection, agent: &str) -> Result<&'static str> {
    let kind: Option<String> = db
        .query_row(&format!("SELECT r.kind FROM agent_roles r WHERE r.agent_id=?1 AND {HOLDING}"), [agent], |r| r.get(0))
        .optional()?;
    Ok(match kind.as_deref() {
        Some(LEAD) => LEAD,
        Some(EXECUTOR) => EXECUTOR,
        _ => STANDING,
    })
}

/// Every Agent's kind that is not standing, for listing them all at once.
pub(crate) fn kinds(db: &Connection) -> Result<HashMap<String, &'static str>> {
    let mut query = db.prepare(&format!("SELECT r.agent_id,r.kind FROM agent_roles r WHERE {HOLDING}"))?;
    let rows = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut kinds = HashMap::new();
    for row in rows {
        let (agent, kind) = row?;
        kinds.insert(agent, if kind == LEAD { LEAD } else { EXECUTOR });
    }
    Ok(kinds)
}

/// The kind an Agent shows in API answers: `None` for a standing Agent, so
/// its listed JSON is as before.
pub(crate) fn listed_kind(db: &Connection, agent: &str) -> Result<Option<String>> {
    Ok(Some(kind(db, agent)?).filter(|kind| *kind != STANDING).map(str::to_owned))
}

/// Whether `agent` leads `project`: chosen as a lead of that Project and a
/// member of it now.
pub(crate) fn leads(db: &Connection, agent: &str, project: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_roles r JOIN project_agents p ON p.agent_id=r.agent_id
         WHERE r.agent_id=?1 AND r.kind='lead' AND r.project_id=?2 AND p.project_id=?2)",
        params![agent, project],
        |r| r.get(0),
    )?)
}

/// This Core changed `agent`'s Project to `now_in` (projects.rs): a lead of
/// another Project stops leading it, and that Project's leads version moves on
/// so a settings page that read the old list reloads before saving.
pub(crate) fn membership_changed(db: &Connection, agent: &str, now_in: Option<&str>) -> Result<()> {
    let led: Option<String> = db
        .query_row("SELECT project_id FROM agent_roles WHERE agent_id=?1 AND kind='lead'", [agent], |r| r.get(0))
        .optional()?;
    if let Some(led) = led.filter(|led| Some(led.as_str()) != now_in) {
        db.execute("DELETE FROM agent_roles WHERE agent_id=?1 AND kind='lead'", [agent])?;
        bump(db, &led)?;
        // A front desk is one of the Project's leads (YN-86 §4.1).
        crate::project_requests::lead_left(db, agent, &led)?;
    }
    Ok(())
}

/// A Project's leads as the user set them, and the version a save checks.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Leads {
    pub version: i64,
    pub lead_agent_ids: Vec<String>,
}

pub(crate) fn leads_in(db: &Connection, project: &str) -> Result<Leads> {
    let version: i64 = db
        .query_row("SELECT version FROM project_lead_versions WHERE project_id=?1", [project], |r| r.get(0))
        .optional()?
        .unwrap_or(0);
    let mut query = db.prepare(
        "SELECT r.agent_id FROM agent_roles r JOIN project_agents p ON p.agent_id=r.agent_id
         WHERE r.kind='lead' AND r.project_id=?1 AND p.project_id=?1 ORDER BY p.rowid",
    )?;
    let lead_agent_ids = query.query_map([project], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(Leads { version, lead_agent_ids })
}

pub(crate) fn get(store: &Store, project: &str) -> Result<Leads> {
    let db = store.db.read()?;
    crate::projects::ensure_exists(&db, project)?;
    leads_in(&db, project)
}

/// Sets `project`'s leads. Called only by the user's HTTP route, never by a
/// collaboration operation: an Agent cannot make itself or another a lead.
/// Each listed Agent is an open member of the Project and not an executor;
/// the Project's other members lose a lead mark; executor rows are not
/// touched. The whole list is replaced, checked against `expected`.
pub(crate) fn save(store: &Store, project: &str, expected: i64, ids: Vec<String>) -> Result<Leads> {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    crate::projects::ensure_assignable(&tx, project)?;
    let current = leads_in(&tx, project)?;
    ensure!(current.version == expected, "version_conflict: this Project's leads changed; reload before saving");
    ensure!(ids.len() <= 50, "Select at most 50 leads");
    let unique: BTreeSet<_> = ids.iter().collect();
    ensure!(unique.len() == ids.len(), "Each lead must be listed once");
    for agent in &ids {
        let open = store.brief_in(&tx, agent)?.is_some_and(|a| a.agent.closed_at.is_none());
        ensure!(
            open && crate::projects::agent_project(&tx, agent)?.as_deref() == Some(project),
            "invalid_lead: select an open Agent in this Project"
        );
        ensure!(kind(&tx, agent)? != EXECUTOR, "invalid_lead: an executor cannot lead a Project");
    }
    let at = crate::model::now();
    for agent in &current.lead_agent_ids {
        if !ids.contains(agent) {
            tx.execute("DELETE FROM agent_roles WHERE agent_id=?1 AND kind='lead' AND project_id=?2", params![agent, project])?;
            // A front desk is one of the Project's leads (YN-86 §4.1).
            crate::project_requests::lead_left(&tx, agent, project)?;
        }
    }
    for agent in &ids {
        lead_row(&tx, agent, project, &at)?;
    }
    let version = current.version + 1;
    tx.execute(
        "INSERT INTO project_lead_versions(project_id,version) VALUES(?1,?2)
         ON CONFLICT(project_id) DO UPDATE SET version=excluded.version",
        params![project, version],
    )?;
    let saved = leads_in(&tx, project)?;
    tx.commit()?;
    Ok(saved)
}

/// Who may dispatch a task from an executor template (phase 1's
/// `task_dispatch.executor`, T-34): the user, or an Agent that leads the
/// task's Project, read from its `project_tasks` row. A task in no Project
/// is dispatched from a template by the user only.
pub(crate) fn may_dispatch_from_template(db: &Connection, actor: &TaskActor, task: &str) -> Result<()> {
    if actor.kind != "agent" {
        return Ok(());
    }
    let project: Option<String> = db
        .query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [task], |r| r.get(0))
        .optional()?;
    let Some(project) = project else {
        bail!("not_lead: this task is in no Project, so only the user can dispatch it from an executor template");
    };
    ensure!(
        leads(db, &actor.id, &project)?,
        "not_lead: only a lead of this task's Project, or the user, can dispatch it from an executor template"
    );
    Ok(())
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/projects/{id}/leads", routing::get(get_leads).put(put_leads))
}

async fn get_leads(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Value>, crate::server::ApiError> {
    Ok(Json(ws.stored(move |store| Ok(serde_json::to_value(get(store, &id)?)?)).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeadsInput {
    expected_version: i64,
    lead_agent_ids: Vec<String>,
}

async fn put_leads(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(input): Json<LeadsInput>,
) -> Result<Json<Value>, crate::server::ApiError> {
    let project = id.clone();
    let saved = ws.stored(move |store| save(store, &project, input.expected_version, input.lead_agent_ids)).await?;
    // The Agents' listed kind changed: clients read the Workspace again.
    ws.changes.send(json!({"projects":true,"projectId":id}));
    Ok(Json(serde_json::to_value(saved)?))
}

#[cfg(test)]
#[path = "agent_roles_tests.rs"]
mod tests;
