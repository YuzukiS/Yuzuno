//! User-owned project policy. A missing/null list is compatibility mode;
//! an explicitly empty list makes every member Ask-only. Agents cannot set it.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Policy {
    pub version: i64,
    pub editor_agent_ids: Option<Vec<String>>,
}

impl Policy {
    pub fn includes(&self, agent: &str) -> bool {
        self.editor_agent_ids.as_ref().is_none_or(|ids| ids.iter().any(|id| id == agent))
    }
}

pub(super) fn policy(db: &Connection, project: &str) -> Result<Policy> {
    let saved: Option<(i64, String)> = db.query_row(
        "SELECT version,editor_ids FROM project_brief_editors WHERE project_id=?1",
        [project], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?;
    match saved {
        Some((version, raw)) => Ok(Policy { version, editor_agent_ids: serde_json::from_str(&raw)? }),
        None => Ok(Policy { version: 0, editor_agent_ids: None }),
    }
}

/// Both the membership and list are read from the caller's snapshot/transaction.
pub(super) fn can_edit(store: &Store, db: &Connection, project: &str, agent: &str) -> Result<bool> {
    Ok(crate::projects::agent_project(db, agent)?.as_deref() == Some(project)
        && !crate::projects::is_archived(db, project)?
        && store.brief_in(db, agent)?.is_some_and(|a| a.agent.closed_at.is_none())
        && policy(db, project)?.includes(agent))
}

pub(super) fn get(store: &Store, project: &str) -> Result<Policy> {
    let db = store.db.read()?;
    crate::projects::ensure_exists(&db, project)?;
    policy(&db, project)
}

/// Called only by the user HTTP route, never a collaboration operation.
pub(super) fn save(store: &Store, project: &str, expected: i64, ids: Option<Vec<String>>) -> Result<Policy> {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    crate::projects::ensure_assignable(&tx, project)?;
    let current = policy(&tx, project)?;
    ensure!(current.version == expected, "version_conflict: Home content editors changed; reload before saving");
    if let Some(ids) = &ids {
        ensure!(ids.len() <= 500, "Select at most 500 Home content editors");
        let unique: BTreeSet<_> = ids.iter().collect();
        ensure!(unique.len() == ids.len(), "Each Home content editor must be listed once");
        for agent in ids {
            ensure!(crate::projects::agent_project(&tx, agent)?.as_deref() == Some(project)
                && store.brief_in(&tx, agent)?.is_some_and(|a| a.agent.closed_at.is_none()),
                "invalid_editor: select an open Agent in this Project");
        }
    }
    let next = Policy { version: current.version + 1, editor_agent_ids: ids };
    tx.execute("INSERT INTO project_brief_editors(project_id,version,editor_ids) VALUES(?1,?2,?3)
        ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,editor_ids=excluded.editor_ids",
        params![project, next.version, serde_json::to_string(&next.editor_agent_ids)?])?;
    tx.commit()?;
    Ok(next)
}
