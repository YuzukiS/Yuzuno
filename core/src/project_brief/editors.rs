//! Who edits a Project's Home (YN-2 S4): its leads (agent_roles.rs). Every
//! other member, an executor too, is Ask-only: it writes its own Asks and may
//! remove its own older sections. The user chooses leads: an Agent the user
//! creates or adds to the Project leads it unless the user removes it, and
//! no Agent can make itself or another a lead. The list older Cores kept
//! (`project_brief_editors`, T-36) stays as it is, for them; it is no longer
//! read here or written.
use super::*;
use serde::Serialize;

/// The Project's Home editors as answers show them (`contentEditors`): its
/// leads and their version, in the shape older readers know.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Policy {
    pub version: i64,
    pub editor_agent_ids: Vec<String>,
    pub rule: &'static str,
}

impl Policy {
    pub fn includes(&self, agent: &str) -> bool {
        self.editor_agent_ids.iter().any(|id| id == agent)
    }
}

pub(super) fn policy(db: &Connection, project: &str) -> Result<Policy> {
    let leads = crate::agent_roles::leads_in(db, project)?;
    Ok(Policy { version: leads.version, editor_agent_ids: leads.lead_agent_ids, rule: "leads" })
}

/// Read from the caller's snapshot/transaction: a lead of `project`, open,
/// while the Project is not archived.
pub(super) fn can_edit(store: &Store, db: &Connection, project: &str, agent: &str) -> Result<bool> {
    Ok(crate::agent_roles::leads(db, agent, project)?
        && !crate::projects::is_archived(db, project)?
        && store.brief_in(db, agent)?.is_some_and(|a| a.agent.closed_at.is_none()))
}

pub(super) fn get(store: &Store, project: &str) -> Result<Policy> {
    let db = store.db.read()?;
    crate::projects::ensure_exists(&db, project)?;
    policy(&db, project)
}

/// The separate Home editors setting is gone (YN-2 S4): a save from an older
/// page is refused, and the stored list is kept for older Cores.
pub(super) const SETTING_REMOVED: &str =
    "setting_removed: Home editors are the Project's leads; choose leads in the Project's settings";
