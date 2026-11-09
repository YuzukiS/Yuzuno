//! Each executor's lifecycle as the sidebar, its task's card and Home show
//! it (T-36 S3). The states, and the order their rules apply in, are
//! docs/executor-model.md "An executor's lifecycle": the first rule that
//! holds names the state, and [`state`] follows that table rule by rule.
//!
//! Read only. It reads what the rest of Core records: the executor's role
//! (`agent_roles`), its release (`executor_archiving`), its slot
//! (`executor_slots`, its place in the queue from `executor_slots::views`),
//! its Agent's close and its task (status, blocker, newest dispatch,
//! result). It writes nothing and holds nothing; where one of those changes
//! without its Agent changing, [`Workspace::executor_changed`] tells clients
//! to read it again.
use crate::workspace::Workspace;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;

impl Workspace {
    /// Executor `id`'s lifecycle may show differently now: its Agent
    /// (`agent.changed`: the sidebar, Home) and the task board
    /// (`workspace.changed` "executors") are read again.
    pub(crate) fn executor_changed(&self, id: &str) {
        self.changed(id);
        self.changes.publish(&json!({"type":"workspace.changed","scope":"executors"}));
    }
}

/// Whether a task write `call` (its answer `value`) can move its executor's
/// lifecycle (#647 R1 333f9680): a result, a dispatch or a claim always
/// can; an update only when it sets the status or the blocker. A
/// progress-only update never does, so it announces nothing.
pub(crate) fn moves(call: &str, value: &Value) -> bool {
    match call {
        "task_submit_result" | "task_dispatch" | "task_claim" => true,
        "task_update" => value["activity"]["changes"]
            .as_object()
            .is_some_and(|changes| changes.contains_key("status") || changes.contains_key("blocker")),
        _ => false,
    }
}

/// An executor's role row: its Agent, its task (internal ID), its dispatch,
/// who dispatched it (`agent:<id>` or `user`), its template and when it was
/// made.
struct Role {
    agent: String,
    task: Option<String>,
    dispatch: Option<String>,
    created_by: Option<String>,
    archived_at: Option<String>,
    template: Option<String>,
    created_at: String,
}

/// What its task says now.
struct TaskNow {
    seq: i64,
    title: String,
    /// Its short name (T-43), none until a lead or the user gives one.
    short_name: Option<String>,
    status: String,
    blocker: String,
    updated_at: String,
    /// The dispatch its newest result was submitted on, and when.
    result: Option<(String, String)>,
    /// The ID of its newest dispatch.
    newest_dispatch: Option<String>,
}

const ROLE: &str = "SELECT agent_id,task_id,dispatch_id,created_by,archived_at,template_id,created_at FROM agent_roles WHERE kind='executor'";

fn role(r: &rusqlite::Row) -> rusqlite::Result<Role> {
    Ok(Role {
        agent: r.get(0)?,
        task: r.get(1)?,
        dispatch: r.get(2)?,
        created_by: r.get(3)?,
        archived_at: r.get(4)?,
        template: r.get(5)?,
        created_at: r.get(6)?,
    })
}

/// Every executor's lifecycle, by its Agent's ID (the Agent listing's
/// `executor`).
pub(crate) fn all(db: &Connection) -> Result<HashMap<String, Value>> {
    let mut query = db.prepare(ROLE)?;
    let roles = query.query_map([], role)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = HashMap::with_capacity(roles.len());
    for role in roles {
        out.insert(role.agent.clone(), lifecycle(db, &role)?);
    }
    Ok(out)
}

/// One executor's lifecycle, with its task (internal ID) and its dispatch;
/// None when `agent` is no executor (T-43 S3: its Overview).
pub(crate) fn of(db: &Connection, agent: &str) -> Result<Option<(Value, Option<String>, Option<String>)>> {
    let role = db.query_row(&format!("{ROLE} AND agent_id=?1"), [agent], role).optional()?;
    role.map(|role| Ok((lifecycle(db, &role)?, role.task.clone(), role.dispatch.clone()))).transpose()
}

/// The lifecycle of each listed task's executor, by task ID (a task view's
/// `executor`): the executor its newest dispatch went to, when one did.
pub(crate) fn for_tasks(db: &Connection, tasks: &[&str]) -> Result<HashMap<String, Value>> {
    let mut out = HashMap::new();
    for task in tasks {
        let Some(dispatch) = newest_dispatch(db, task)? else { continue };
        let role = db
            .query_row(&format!("{ROLE} AND task_id=?1 AND dispatch_id=?2"), [*task, dispatch.as_str()], role)
            .optional()?;
        if let Some(role) = role {
            out.insert((*task).to_owned(), lifecycle(db, &role)?);
        }
    }
    Ok(out)
}

fn newest_dispatch(db: &Connection, task: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT json_extract(data,'$.dispatch.id') FROM collaboration_task_activity
             WHERE task_id=?1 AND json_extract(data,'$.kind')='dispatched' ORDER BY seq DESC LIMIT 1",
            [task],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn task_now(db: &Connection, task: &str) -> Result<Option<TaskNow>> {
    let row: Option<(i64, String)> =
        db.query_row("SELECT seq,data FROM collaboration_tasks WHERE id=?1", [task], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let Some((seq, data)) = row else { return Ok(None) };
    let data: Value = serde_json::from_str(&data)?;
    let text = |key: &str| data[key].as_str().unwrap_or_default().to_owned();
    let result = data["result"]["dispatchId"]
        .as_str()
        .map(|dispatch| (dispatch.to_owned(), data["result"]["reportedAt"].as_str().unwrap_or_default().to_owned()));
    Ok(Some(TaskNow {
        seq,
        title: text("title"),
        short_name: data["shortName"].as_str().map(str::to_owned),
        status: text("status"),
        blocker: text("blocker"),
        updated_at: text("updatedAt"),
        result,
        newest_dispatch: newest_dispatch(db, task)?,
    }))
}

/// The facts the rules read, gathered for one executor.
pub(crate) struct Facts {
    pub archived_at: Option<String>,
    /// Being released: since when, and what it waits for.
    pub archiving: Option<(String, String)>,
    pub closed: bool,
    /// Its slot: state, reason, since.
    pub slot: Option<(String, Option<String>, String)>,
    pub task_status: String,
    pub task_blocker: String,
    pub task_updated_at: String,
    /// Its task's newest dispatch is its own.
    pub holds_newest_dispatch: bool,
    /// When its task's newest result was submitted on its own dispatch.
    pub result_at: Option<String>,
}

/// The state, since when, and why (docs/executor-model.md "An executor's
/// lifecycle", in the table's order).
pub(crate) fn state(f: &Facts) -> (&'static str, Option<String>, Option<String>) {
    let slot = f.slot.as_ref();
    let slot_since = slot.map(|(_, _, since)| since.clone());
    // 1. Released and closed for good.
    if let Some(at) = &f.archived_at {
        return ("archived", Some(at.clone()), None);
    }
    // 2. Released, waiting for its work to end or its close to be confirmed.
    if let Some((since, reason)) = &f.archiving {
        return ("archiving", Some(since.clone()), Some(reason.clone()));
    }
    // 3. A start that stopped short: held open with its reason (uncertain,
    //    or a reopened executor's), or closed while its task is blocked on it.
    if let Some((_, Some(reason), since)) = slot.filter(|(state, reason, _)| state == "starting" && reason.is_some() && !f.closed) {
        return ("failed", Some(since.clone()), Some(reason.clone()));
    }
    if f.closed && f.task_status == "blocked" && f.holds_newest_dispatch {
        return ("failed", Some(f.task_updated_at.clone()), Some(f.task_blocker.clone()).filter(|b| !b.is_empty()));
    }
    // 4. Closed otherwise: its own close, or its start's that Core rebuilt.
    if f.closed {
        return ("closed", None, None);
    }
    // 5–6. Waiting for a slot, or starting in it.
    match slot.map(|(state, _, _)| state.as_str()) {
        Some("waiting") => return ("queued", slot_since, None),
        Some("starting") => return ("starting", slot_since, None),
        _ => {}
    }
    // 7. Its result is in, and the task waits on its review.
    if let Some(at) = f.result_at.as_ref().filter(|_| f.task_status == "review") {
        return ("delivering", Some(at.clone()), None);
    }
    // 8. At work.
    ("running", slot_since, None)
}

fn lifecycle(db: &Connection, role: &Role) -> Result<Value> {
    let closed: bool = db
        .query_row(
            "SELECT json_extract(data,'$.agent.closedAt') IS NOT NULL FROM agents WHERE id=?1",
            [&role.agent],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(true);
    let archiving: Option<(String, String)> = db
        .query_row("SELECT since,reason FROM executor_archiving WHERE agent_id=?1", [&role.agent], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let slot: Option<(String, Option<String>, String)> = db
        .query_row("SELECT state,reason,since FROM executor_slots WHERE agent_id=?1", [&role.agent], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    let task = match &role.task {
        Some(task) => task_now(db, task)?,
        None => None,
    };
    let own = |dispatch: Option<&str>| role.dispatch.is_some() && dispatch == role.dispatch.as_deref();
    let facts = Facts {
        archived_at: role.archived_at.clone(),
        archiving,
        closed,
        slot,
        task_status: task.as_ref().map(|t| t.status.clone()).unwrap_or_default(),
        task_blocker: task.as_ref().map(|t| t.blocker.clone()).unwrap_or_default(),
        task_updated_at: task.as_ref().map(|t| t.updated_at.clone()).unwrap_or_default(),
        holds_newest_dispatch: task.as_ref().is_some_and(|t| own(t.newest_dispatch.as_deref())),
        result_at: task.as_ref().and_then(|t| t.result.clone()).filter(|(dispatch, _)| own(Some(dispatch.as_str()))).map(|(_, at)| at),
    };
    let (state, since, reason) = state(&facts);
    let dispatcher = match role.created_by.as_deref().and_then(|by| by.strip_prefix("agent:")) {
        Some(id) => {
            let name: Option<String> = db
                .query_row("SELECT json_extract(data,'$.agent.name') FROM agents WHERE id=?1", [id], |r| r.get(0))
                .optional()?
                .flatten();
            json!({"kind":"agent","id":id,"name":name})
        }
        None => json!({"kind":"user"}),
    };
    let mut view = json!({"state":state,"agentId":role.agent,"dispatcher":dispatcher,"dispatchedAt":role.created_at});
    // Its dispatch row: the template it was made from, as its materials name
    // it (T-43 S2: the sidebar shows its label), whether that template is
    // fixed, and why routing chose what it did (YN-57 S4a). None for one made
    // before its dispatch row was kept.
    let dispatched: Option<(Option<String>, Option<String>, Option<String>)> = db
        .query_row(
            "SELECT json_extract(template_json,'$.label'), json_extract(template_json,'$.routing'), route_json
             FROM executor_dispatches WHERE agent_id=?1 ORDER BY rowid DESC LIMIT 1",
            [&role.agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some(id) = &role.template {
        let label = dispatched.as_ref().and_then(|(label, _, _)| label.clone());
        view["template"] = json!({"id":id,"label":label});
    }
    if let Some((_, routing, route)) = &dispatched {
        if let Some(route) = route_summary(db, &role.agent, routing.as_deref(), route.as_deref())? {
            view["route"] = route;
        }
    }
    if let Some(task) = &task {
        // By the key it has now, as its executor's name, Home's live
        // references and task_get name it (T-43 S2, g8); `T-<n>` only
        // while it has none.
        let key = role.task.as_deref().map(|id| crate::task_keys::current(db, id)).transpose()?.flatten();
        view["task"] = json!({"id":key.unwrap_or_else(|| format!("T-{}", task.seq)),"title":task.title});
        // Its short name too (T-43), what the sidebar's row says it is
        // doing; only where it has one, so an answer without it is as before.
        if let Some(short) = &task.short_name {
            view["task"]["shortName"] = json!(short);
        }
        // An executor at work whose task is blocked: the blocker, for Home
        // and the card's title (its state stays what it is).
        if task.status == "blocked" && !closed && !task.blocker.is_empty() {
            view["blocked"] = json!(task.blocker);
        }
    }
    if let Some(since) = since {
        view["since"] = json!(since);
    }
    if let Some(reason) = reason {
        view["reason"] = json!(reason);
    }
    if state == "queued" {
        if let Some(task) = &role.task {
            let position = crate::executor_slots::views(db, &[task.as_str()])?
                .remove(task.as_str())
                .filter(|slot| slot["agentId"] == role.agent.as_str())
                .map(|slot| slot["position"].clone());
            if let Some(position) = position.filter(|p| !p.is_null()) {
                view["position"] = position;
            }
        }
    }
    Ok(view)
}

/// What routing gave an executor (YN-57 S4a), for its row's card, from its
/// dispatch's record of why (`route_json`) and what it starts with:
/// - `chosen`: the candidate (`candidate`, its `label` when it has one), the
///   harness, model and effort the executor runs with, and its account or key
///   (`credential`: `login`; `apiKey` with `keyId`; `pool` with `account`, its
///   `fingerprint` and, as the record gives it, `number`; `codexHome` with `id`);
/// - `waiting` for a candidate, with the soonest time a candidate's reason
///   gives (`earliest`) when there is one;
/// - `unrouted` and why: `off` (routing was off at its dispatch), `fixed` (its
///   template is fixed), or `routingOff` / `noCandidate` (released after
///   waiting).
/// Never a key's value or an account's email: a key by its id, an account by
/// its number and fingerprint.
fn route_summary(db: &Connection, agent: &str, routing: Option<&str>, route: Option<&str>) -> Result<Option<Value>> {
    let Some(raw) = route else {
        return Ok(Some(json!({"kind":"unrouted","why": if routing == Some("fixed") { "fixed" } else { "off" }})));
    };
    let Ok(route) = serde_json::from_str::<Value>(raw) else { return Ok(None) };
    if let Some(why) = route["released"].as_str() {
        return Ok(Some(json!({"kind":"unrouted","why":why})));
    }
    if route["waiting"] == true {
        let mut out = json!({"kind":"waiting"});
        if let Some(at) = route["earliest"]["at"].as_str() {
            out["earliest"] = json!(at);
        }
        return Ok(Some(out));
    }
    let Some(chosen) = route["chosen"].as_str() else { return Ok(None) };
    let (harness, model, effort): (Option<String>, Option<String>, Option<String>) = db
        .query_row(
            "SELECT COALESCE(json_extract(data,'$.agent.harness'),'codex'), json_extract(data,'$.agent.model'),
                    json_extract(data,'$.agent.settings.reasoningEffort') FROM agents WHERE id=?1",
            [agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .unwrap_or((None, None, None));
    let profile: Option<String> = db
        .query_row("SELECT profile FROM agent_runtime_profiles WHERE agent_id=?1", [agent], |r| r.get(0))
        .optional()?;
    let credential = match profile.and_then(|p| serde_json::from_str::<crate::routing_launch::RuntimeProfile>(&p).ok()) {
        None => json!({"kind":"login"}),
        Some(crate::routing_launch::RuntimeProfile::ApiKey { key_id }) => json!({"kind":"apiKey","keyId":key_id}),
        Some(crate::routing_launch::RuntimeProfile::CodexHome { id }) => json!({"kind":"codexHome","id":id}),
        Some(crate::routing_launch::RuntimeProfile::ClaudeAccount { fingerprint }) => {
            let number = Some(&route["account"]).filter(|a| a["fingerprint"] == fingerprint.as_str()).map(|a| a["number"].clone()).unwrap_or(Value::Null);
            json!({"kind":"pool","account":{"fingerprint":fingerprint,"number":number}})
        }
    };
    let mut out = json!({"kind":"chosen","candidate":chosen,"harness":harness,"model":model.unwrap_or_default(),"credential":credential});
    if let Some(effort) = effort.filter(|e| !e.is_empty()) {
        out["effort"] = json!(effort);
    }
    let label = route["candidates"].as_array().and_then(|list| list.iter().find(|c| c["id"] == chosen)).and_then(|c| c["label"].as_str());
    if let Some(label) = label.filter(|l| !l.trim().is_empty()) {
        out["label"] = json!(label);
    }
    Ok(Some(out))
}

#[cfg(test)]
#[path = "executor_lifecycle_tests.rs"]
pub(crate) mod tests;
