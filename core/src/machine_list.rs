//! The machines a dispatch can name, for a lead choosing where an executor
//! runs (YN-37). The machine stays a dispatch's choice (`task_dispatch`
//! executor.machineId); a template's machine is only its default.
//!
//! A machine is named here only by its id and name. Nothing of how Core
//! reaches it is given: no SSH destination, user, port, key, executable,
//! folder or data root, and of its last check only when and whether it was
//! reached, not its error, which can quote the destination.
//!
//! Windows on this PC (jobs::remote `windows`) runs Jobs only, never an
//! executor, so it is not listed.
use crate::{remote::RemoteMachine, workspace::Workspace};
use anyhow::{bail, ensure, Result};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, sync::Arc};

pub(crate) const TOOL: &str = "machines_list";

pub(crate) fn tool_definition() -> Value {
    json!({
        "name": TOOL,
        "description": "List the machines a dispatch can name, to choose where an executor runs: task_dispatch executor {templateId?, machineId} takes a machine's id from here (or auto, for Core to choose). The machine is a dispatch's choice; a template's machine is only its default. Each machine has id; name; kind: local (this Core host, id local) or ssh (a machine Core reaches over SSH); harnesses, those its executors can use (OpenCode on this Core host only, no Codex on a machine that keeps its Agents contained); executors {limit, running, waiting}: its executor slots, set by the user (running counts those starting or running there, waiting those queued for a slot there); connected: whether Core holds a live connection to an Agent there now (always true for this Core host; false means only that none is connected, not that the machine is down); lastCheck {checkedAt, reachable}: the user's newest manual check, or null, which is no live status; projectFolder: whether your Project has a folder there, which an executor on another machine works in (a dispatch there without one is refused). No address, user, port, key or other connection detail is given. Windows on this PC runs Jobs only and is not listed. For leads of a Project only: executors and other members are refused (not_lead). Reading changes nothing. The user adds machines and sets each one's executor limit in Settings → Machines, where each machine's page shows its id to copy.",
        "inputSchema": {"type":"object","properties":{},"required":[],"additionalProperties":false},
    })
}

/// The executor harnesses that can run on a machine: this Core host's (None)
/// or a registered one's. The same rules a dispatch applies
/// (executor_templates::machine_named, executor_dispatch remote_machine).
fn harnesses(remote: Option<&RemoteMachine>, opencode: bool) -> Vec<&'static str> {
    match remote {
        None if opencode => vec!["codex", "claude", "opencode"],
        None => vec!["codex", "claude"],
        Some(machine) if machine.contained => vec!["claude"],
        Some(_) => vec!["codex", "claude"],
    }
}

/// This Core host and every registered machine, in the Machines list's order.
fn machines(db: &Connection) -> Result<Vec<(String, String, Option<RemoteMachine>)>> {
    let mut list = vec![("local".to_owned(), "this Core host".to_owned(), None)];
    let mut q = db.prepare("SELECT data FROM machines ORDER BY rowid")?;
    for raw in q.query_map([], |r| r.get::<_, String>(0))? {
        let machine: RemoteMachine = serde_json::from_str(&raw?)?;
        list.push((machine.id.clone(), machine.name.clone(), Some(machine)));
    }
    Ok(list)
}

/// The machines an executor of `harness` could be dispatched to, as a
/// refusal names them: `local (this Core host), <id> (<name>), …`.
pub(crate) fn usable_for(db: &Connection, harness: &str) -> Result<String> {
    let named: Vec<String> = machines(db)?
        .into_iter()
        .filter(|(_, _, remote)| harnesses(remote.as_ref(), true).contains(&harness))
        .map(|(id, name, _)| format!("{id} ({name})"))
        .collect();
    Ok(named.join(", "))
}

/// Executors holding a slot (starting or running) and waiting for one, by machine.
fn slots(db: &Connection) -> Result<HashMap<String, (i64, i64)>> {
    let mut counts: HashMap<String, (i64, i64)> = HashMap::new();
    let mut q = db.prepare(
        "SELECT machine_id, state, COUNT(*) FROM executor_slots WHERE state IN ('waiting','starting','running') GROUP BY machine_id, state")?;
    for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))? {
        let (machine, state, count) = row?;
        let entry = counts.entry(machine).or_default();
        if state == "waiting" { entry.1 += count } else { entry.0 += count }
    }
    Ok(counts)
}

/// The registered machines where an open Agent is connected now.
fn connected(db: &Connection) -> Result<HashSet<String>> {
    Ok(db.prepare(
        "SELECT DISTINCT json_extract(data,'$.agent.remote.machine.id') FROM agents
         WHERE json_extract(data,'$.agent.remote.machine.id') IS NOT NULL
           AND json_extract(data,'$.agent.closedAt') IS NULL
           AND json_extract(data,'$.agent.connectionState')='connected'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Of each machine's newest manual check, only when and whether it was
/// reached: its error and host facts can name the destination or a path.
fn checks(db: &Connection) -> Result<HashMap<String, Value>> {
    let mut checks = HashMap::new();
    let mut q = db.prepare("SELECT machine_id, data FROM machine_checks")?;
    for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (id, data) = row?;
        // A record this build cannot read is reported as never checked.
        if let Ok(check) = serde_json::from_str::<crate::machines::MachineCheck>(&data) {
            checks.insert(id, json!({"checkedAt": check.checked_at, "reachable": check.reachable}));
        }
    }
    Ok(checks)
}

/// The list for a caller of `project` (None: the user, with no Project of
/// its own, gets no projectFolder).
fn list(db: &Connection, project: Option<&str>, opencode: bool) -> Result<Value> {
    let (slots, connected, mut checks) = (slots(db)?, connected(db)?, checks(db)?);
    let mut listed = Vec::new();
    for (id, name, remote) in machines(db)? {
        let (running, waiting) = slots.get(&id).copied().unwrap_or_default();
        let (limit, _) = crate::executor_slots::machine_limit(db, &id)?;
        let mut item = json!({
            "id": id, "name": name, "kind": if remote.is_some() { "ssh" } else { "local" },
            "harnesses": harnesses(remote.as_ref(), opencode),
            "executors": {"limit": limit, "running": running, "waiting": waiting},
            "connected": remote.is_none() || connected.contains(&id),
            "lastCheck": checks.remove(&id),
        });
        if let Some(project) = project {
            item["projectFolder"] = json!(crate::projects::default_dir(db, project, &id)?.is_some());
        }
        listed.push(item);
    }
    Ok(json!({"machines": listed}))
}

/// The caller's Project, when it leads it; an executor or another member is refused.
fn led_project(db: &Connection, actor: &str) -> Result<String> {
    let project: Option<String> = db.query_row(
        "SELECT project_id FROM project_agents WHERE agent_id=?1", [actor], |r| r.get(0)).optional()?;
    match project {
        Some(project) if crate::agent_roles::leads(db, actor, &project)? => Ok(project),
        _ => bail!("not_lead: only a lead of a Project lists the machines; ask your Project's lead which machine to use"),
    }
}

pub async fn call(ws: Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let input = input.as_object().ok_or_else(|| anyhow::anyhow!("invalid_input: expected an object"))?;
    ensure!(input.is_empty(), "invalid_input: machines_list takes no fields");
    let opencode = crate::opencode_agent::enabled();
    ws.stored(move |store| {
        let db = store.db.read()?;
        let project = match actor.as_deref() {
            Some(actor) => Some(led_project(&db, actor)?),
            None => None,
        };
        list(&db, project.as_deref(), opencode)
    }).await
}

#[cfg(test)]
#[path = "machine_list_tests.rs"]
mod tests;
