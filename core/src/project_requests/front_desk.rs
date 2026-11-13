//! A Project's front desk (YN-86 §4.1): the lead the user's requests to the
//! Project go to, shown to the user as "the project". The user chooses it
//! among the Project's leads in its settings, as the leads themselves are
//! chosen: only the user's page saves it, and no Agent tool does, so an Agent
//! cannot make itself the front desk. With none chosen, a Project with one
//! lead has that lead, unsaved; one with several has none until the user
//! chooses. A front desk that stops leading the Project is cleared
//! (agent_roles.rs calls `lead_left`), and one that no longer leads for any
//! other reason (a deleted Agent, an older Core's move) is never taken.
use crate::{agent_roles, store::Store};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Runs on every open: idempotent, as `agent_roles::migrate`. A deleted
/// Agent leaves the Project with none chosen; the clean-up covers a manual
/// edit without foreign keys.
pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_front_desk(
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
            version INTEGER NOT NULL,
            updated_at TEXT NOT NULL);
        UPDATE project_front_desk SET agent_id=NULL WHERE agent_id NOT IN (SELECT id FROM agents);
        DELETE FROM project_front_desk WHERE project_id NOT IN (SELECT id FROM projects);",
    )?;
    Ok(())
}

/// A Project's front desk, and the version a save checks.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrontDesk {
    pub version: i64,
    /// The lead the user chose, while it leads the Project.
    pub agent_id: Option<String>,
    /// Who the Project's requests go to now: the lead chosen, else the
    /// Project's only lead. None when it has several leads and none is
    /// chosen, or no lead.
    pub effective_agent_id: Option<String>,
}

pub(crate) fn in_project(db: &Connection, project: &str) -> Result<FrontDesk> {
    let (stored, version) = db
        .query_row("SELECT agent_id, version FROM project_front_desk WHERE project_id=?1", [project], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?))
        })
        .optional()?
        .unwrap_or((None, 0));
    let agent_id = match stored {
        Some(agent) if agent_roles::leads(db, &agent, project)? => Some(agent),
        _ => None,
    };
    let effective_agent_id = match &agent_id {
        Some(agent) => Some(agent.clone()),
        None => {
            let leads = agent_roles::leads_in(db, project)?.lead_agent_ids;
            (leads.len() == 1).then(|| leads[0].clone())
        }
    };
    Ok(FrontDesk { version, agent_id, effective_agent_id })
}

pub(crate) fn get(store: &Store, project: &str) -> Result<FrontDesk> {
    let db = store.db.read()?;
    crate::projects::ensure_exists(&db, project)?;
    in_project(&db, project)
}

/// Sets `project`'s front desk, or clears it with `None`. Called only by the
/// user's HTTP route. The Agent chosen is an open lead of the Project; the
/// save is checked against `expected`.
pub(crate) fn save(store: &Store, project: &str, expected: i64, agent: Option<String>) -> Result<FrontDesk> {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    crate::projects::ensure_assignable(&tx, project)?;
    let current = in_project(&tx, project)?;
    ensure!(current.version == expected, "version_conflict: this Project's front desk changed; reload before saving");
    if let Some(agent) = &agent {
        let open = store.brief_in(&tx, agent)?.is_some_and(|a| a.agent.closed_at.is_none());
        ensure!(open && agent_roles::leads(&tx, agent, project)?, "invalid_front_desk: choose an open lead of this Project");
    }
    tx.execute(
        "INSERT INTO project_front_desk(project_id,agent_id,version,updated_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(project_id) DO UPDATE SET agent_id=excluded.agent_id, version=excluded.version, updated_at=excluded.updated_at",
        params![project, agent, expected + 1, crate::model::now()],
    )?;
    let saved = in_project(&tx, project)?;
    tx.commit()?;
    Ok(saved)
}

/// `agent` stopped leading `project` (agent_roles.rs: the user's save of the
/// leads, or the Agent moved out of the Project): if it was the front desk,
/// none is chosen now, and the version moves on so a settings page that read
/// it reloads before saving. In the caller's transaction. Whether it was.
pub(crate) fn lead_left(db: &Connection, agent: &str, project: &str) -> Result<bool> {
    Ok(db.execute(
        "UPDATE project_front_desk SET agent_id=NULL, version=version+1, updated_at=?3 WHERE project_id=?1 AND agent_id=?2",
        params![project, agent, crate::model::now()],
    )? > 0)
}
