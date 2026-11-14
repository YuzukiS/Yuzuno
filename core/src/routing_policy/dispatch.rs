//! Routing at dispatch and at an executor's first start (YN-34 S3b2).
//!
//! - **At dispatch,** in the dispatch's own transaction, when routing is on
//!   and the template is not `routing: fixed`: the evaluator's choice gives
//!   the executor its harness, model and effort, and the account or key it
//!   starts with (its runtime profile, set once it exists). The record of why
//!   is kept on the dispatch (`route_json`).
//! - **When none can be chosen,** the executor is made with the harness of
//!   the first candidate that could run there, a stand-in, and waits: the slot
//!   pass leaves it in the queue, and at each pass reads routing again, among
//!   every candidate its machine can run, until one holds (YN-66). Nothing of
//!   it has run, so one of another harness is given it in place: its Agent
//!   record is made again as a dispatch choosing that candidate makes it, under
//!   its gate, and its route, written last, lets it start.
//! - **A rebuild** (a definite start failure) leaves out the candidates the
//!   executor it replaces was started with, so each is tried once.
//! - **One routed but not started yet whose candidate, account or key has left**
//!   (left.rs) waits again (YN-138): in one transaction, while its slot still
//!   waits, its route says `waiting` and `left`, and its runtime profile is
//!   removed. The same pass then reads routing for it among every candidate,
//!   as for one that waited from its dispatch; none it could ever be given
//!   releases it onto the host's own login.
use super::evaluate::{evaluate, has_machine_condition, machine_allows, serves, Assume, Gathered};
use super::left::{left, Left};
use crate::{executor_templates::Template, routing_launch::RuntimeProfile};
use anyhow::Result;
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Arc;

/// What routing gave a dispatch.
pub(crate) struct Routed {
    pub template: Template,
    pub route: Value,
    pub profile: Option<RuntimeProfile>,
    /// "local" when the chosen candidate runs on this Core host only, or, with no
    /// machine named (`auto` or unset), has a machine condition (YN-139).
    pub machine: Option<String>,
}

/// The candidates the executor a rebuild replaces was started with, and those it already left out.
fn failed_before(tx: &Connection, request_id: &str) -> Result<Vec<String>> {
    let Some(from) = request_id.strip_prefix("rebuild:") else { return Ok(Vec::new()) };
    let raw: Option<Option<String>> = tx.query_row("SELECT route_json FROM executor_dispatches WHERE agent_id=?1", [from], |r| r.get(0)).optional()?;
    let Some(Some(raw)) = raw else { return Ok(Vec::new()) };
    let route: Value = serde_json::from_str(&raw)?;
    let mut out: Vec<String> = route["excluded"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    if let Some(chosen) = route["chosen"].as_str() {
        out.push(chosen.to_owned());
    }
    Ok(out)
}

/// A template made to start as `candidate` says: its harness, model and effort,
/// and the template's permission level as that harness's own permission (YN-56).
/// No level, or one the harness doesn't keep (the evaluator passes over such a
/// candidate), is that harness's defaults for new Agents.
pub(crate) fn apply(template: &Template, candidate: &Value) -> Template {
    let mut t = template.clone();
    let harness = candidate["harness"].as_str().unwrap_or("codex").to_owned();
    let model = candidate["model"].as_str().filter(|m| !m.is_empty()).map(str::to_owned);
    t.model = model;
    t.reasoning_effort = if harness == "codex" { candidate["reasoningEffort"].as_str().map(str::to_owned) } else { None };
    let native = template.permission_level.as_deref().and_then(|level| crate::permission_levels::native(level, &harness));
    t.permission_preset = native.filter(|_| harness == "codex").map(str::to_owned);
    t.permission_mode = native.filter(|_| harness == "claude").map(str::to_owned);
    t.harness = Some(harness);
    t
}

fn host_only(candidate: &Value) -> bool {
    candidate["credential"]["kind"] != "login" || candidate["harness"] == "opencode"
}

/// Whether a dispatch to `machine` that gives its executor `candidate` fixes it on this
/// Core host: a host-only one; or, with no machine named (`auto` or unset), one with a
/// machine condition (YN-139), which held for this Core host, so `auto` choosing another
/// machine after routing can't take it where its condition leaves it out.
fn here(candidate: &Value, machine: Option<&str>) -> bool {
    host_only(candidate) || (machine.is_none() && has_machine_condition(candidate))
}

/// The tier a dispatch wants and whose it is (YN-70): `template`, `lead` or `user`.
pub(crate) type Tier<'a> = Option<(&'a str, &'a str)>;

/// Routing for a dispatch, in its transaction: None while routing is off, for
/// a `fixed` template, or with no candidate at all. Only candidates that serve
/// `tier` are chosen, or stand in while it waits.
pub(crate) fn route(tx: &Connection, gathered: &Gathered, template: &Template, request_id: &str, machine: Option<&str>, tier: Tier)
    -> Result<Option<Routed>> {
    if template.fixed() {
        return Ok(None);
    }
    let stored = super::stored_in(tx)?;
    if stored.policy["enabled"] != true {
        return Ok(None);
    }
    let exclude = failed_before(tx, request_id)?;
    let level = template.permission_level.as_deref();
    // `auto` or unset chooses its machine after routing: any candidate may run.
    let machine = machine.filter(|m| *m != super::super::collaboration_store::executor_choice::AUTO);
    let assume = Assume::default();
    // Harnesses its machine can't run (OpenCode while it is off here, Codex on a contained
    // machine) are passed over, as at a waiting executor's start, rather than chosen and
    // then refused with the whole dispatch (YN-70, from YN-66). Unset is this Core host.
    let unavailable = unavailable(tx, machine.unwrap_or("local"))?;
    let mut inputs = gathered.inputs(Utc::now(), machine, &exclude, None, level, &assume);
    inputs.unavailable = &unavailable;
    (inputs.tier, inputs.tier_source) = (tier.map(|(tier, _)| tier), tier.map(|(_, source)| source));
    let route = evaluate(stored.version, &stored.policy, "dispatch", &inputs);
    let mut record = route.record;
    record["excluded"] = json!(exclude);
    if let Some(candidate) = route.chosen {
        let machine = here(&candidate, machine).then(|| "local".to_owned());
        return Ok(Some(Routed { template: apply(template, &candidate), route: record, profile: route.profile, machine }));
    }
    // None now: the first enabled candidate that could run there, keeps the
    // template's permission level and serves its tier, stands in for its
    // harness while it waits. One that doesn't serve the tier would pin it to
    // this Core host for nothing (a host-only one's machine is fixed here). One
    // whose machine condition leaves the machine out never holds there, so it
    // stands in for none (YN-139).
    let first = stored.policy["candidates"].as_array().into_iter().flatten()
        .find(|c| c["enabled"] == true && !exclude.iter().any(|e| c["id"] == e.as_str())
            && (!host_only(c) || machine.is_none_or(|m| m == "local"))
            && machine_allows(c, machine)
            && crate::permission_levels::keeps(level, c["harness"].as_str().unwrap_or_default())
            && !unavailable.contains(&c["harness"].as_str().unwrap_or_default())
            && serves(c, tier.map(|(tier, _)| tier)));
    let Some(first) = first else {
        return Ok(None);
    };
    record["waiting"] = json!(true);
    let mut waiting = apply(template, first);
    waiting.model = None;
    waiting.reasoning_effort = None;
    let machine = here(first, machine).then(|| "local".to_owned());
    Ok(Some(Routed { template: waiting, route: record, profile: None, machine }))
}

/// Whether `agent`'s dispatch waits for a candidate: the slot pass leaves it queued.
pub(crate) fn waiting(tx: &Connection, agent: &str) -> Result<bool> {
    let raw: Option<Option<String>> = tx.query_row("SELECT route_json FROM executor_dispatches WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?;
    Ok(raw.flatten().and_then(|r| serde_json::from_str::<Value>(&r).ok()).is_some_and(|r| r["waiting"] == true))
}

/// An executor waiting for a candidate, as a slot pass reads it.
pub(crate) struct WaitingExecutor {
    pub agent: String,
    /// The harness it is made with: its stand-in's, until a candidate is chosen (YN-66).
    pub harness: String,
    pub machine: String,
    pub project: Option<String>,
    pub route: Value,
    /// Nothing of it ever ran: no session, thread, Turn, request, receipt or
    /// runtime, so its harness may still change (YN-66).
    pub unstarted: bool,
    /// Harnesses its machine can't run: OpenCode while this Core has it off,
    /// Codex on a contained machine (`remote_machine` in collaboration_store).
    pub unavailable: Vec<&'static str>,
}

impl WaitingExecutor {
    /// The candidates its rebuild leaves out, as its dispatch's route keeps them.
    pub(crate) fn excluded(&self) -> Vec<String> {
        self.route["excluded"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    }

    /// Its permission level (YN-56), as its dispatch's route keeps it. Each
    /// filter of its dispatch's evaluation is read again here, but its harness.
    pub(crate) fn level(&self) -> Option<&str> {
        self.route["level"].as_str()
    }

    /// Its tier and whose it is (YN-70), as its dispatch's route keeps them.
    pub(crate) fn tier(&self) -> Option<&str> {
        self.route["tier"].as_str()
    }

    pub(crate) fn tier_source(&self) -> Option<&str> {
        self.route["tierSource"].as_str()
    }

    /// Only candidates of this harness: its own, once something of it ran.
    pub(crate) fn harness_only(&self) -> Option<&str> {
        (!self.unstarted).then_some(self.harness.as_str())
    }
}

/// Whether nothing of an Agent (`data`, its record's metadata) ever ran.
fn unstarted(data: &Value, turns: bool, receipts: bool) -> bool {
    let agent = &data["agent"];
    let remote = &agent["remote"];
    !turns && !receipts && agent["closedAt"].is_null() && agent["threadId"].is_null()
        && agent["claudeSessionId"].is_null() && agent["opencodeSessionId"].is_null()
        && agent.get("connectionState").is_none_or(|state| state == "disconnected")
        && remote["runtime"].is_null() && remote["launchRequested"] != true && remote["hostInstance"].is_null()
        && data["pending"].as_array().is_none_or(Vec::is_empty)
}

/// The harnesses `machine` can't run now (YN-66).
fn unavailable(db: &Connection, machine: &str) -> Result<Vec<&'static str>> {
    let mut out = Vec::new();
    if !crate::opencode_agent::enabled() {
        out.push("opencode");
    }
    if machine != "local" {
        let raw: Option<String> = db.query_row("SELECT data FROM machines WHERE id=?1", [machine], |r| r.get(0)).optional()?;
        if raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).is_some_and(|m| m["contained"] == true) {
            out.push("codex");
        }
    }
    Ok(out)
}

/// The executors waiting for a candidate, or the one `agent` names while it still does.
fn waiting_where(db: &Connection, agent: Option<&str>) -> Result<Vec<WaitingExecutor>> {
    let mut statement = db.prepare(
        "SELECT d.agent_id, d.machine_id, d.project_id, d.route_json, a.data,
                EXISTS(SELECT 1 FROM agent_turns t WHERE t.agent_id=d.agent_id),
                EXISTS(SELECT 1 FROM agent_receipts r WHERE r.agent_id=d.agent_id)
         FROM executor_dispatches d JOIN agents a ON a.id=d.agent_id JOIN executor_slots s ON s.agent_id=d.agent_id
         WHERE d.route_json IS NOT NULL AND s.state='waiting' AND (?1 IS NULL OR d.agent_id=?1)")?;
    let rows = statement.query_map([agent], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?,
        r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, bool>(5)?, r.get::<_, bool>(6)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::new();
    for (agent, machine, project, route, data, turns, receipts) in rows {
        let (Ok(route), Ok(data)) = (serde_json::from_str::<Value>(&route), serde_json::from_str::<Value>(&data)) else { continue };
        if route["waiting"] != true {
            continue;
        }
        let harness = data["agent"]["harness"].as_str().unwrap_or("codex").to_owned();
        let unavailable = unavailable(db, &machine)?;
        out.push(WaitingExecutor { agent, harness, unstarted: unstarted(&data, turns, receipts), machine, project, route, unavailable });
    }
    Ok(out)
}

/// The executors waiting for a candidate.
pub(crate) fn waiting_list(db: &Connection) -> Result<Vec<WaitingExecutor>> {
    waiting_where(db, None)
}

/// An executor routed at its dispatch, queued for a slot, nothing of which ran (YN-138).
pub(crate) struct QueuedRouted {
    pub agent: String,
    pub route: Value,
    pub profile: Option<RuntimeProfile>,
}

/// The executors routed, queued for a slot and not started: not waiting for a
/// candidate, not released onto the host's login. Or the one `agent` names while it still is.
fn left_queued(db: &Connection, agent: Option<&str>) -> Result<Vec<QueuedRouted>> {
    let mut statement = db.prepare(
        "SELECT d.agent_id, d.route_json, a.data, p.profile,
                EXISTS(SELECT 1 FROM agent_turns t WHERE t.agent_id=d.agent_id),
                EXISTS(SELECT 1 FROM agent_receipts r WHERE r.agent_id=d.agent_id)
         FROM executor_dispatches d JOIN agents a ON a.id=d.agent_id JOIN executor_slots s ON s.agent_id=d.agent_id
              LEFT JOIN agent_runtime_profiles p ON p.agent_id=d.agent_id
         WHERE d.route_json IS NOT NULL AND s.state='waiting' AND (?1 IS NULL OR d.agent_id=?1)")?;
    let rows = statement.query_map([agent], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
        r.get::<_, Option<String>>(3)?, r.get::<_, bool>(4)?, r.get::<_, bool>(5)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::new();
    for (agent, route, data, profile, turns, receipts) in rows {
        let (Ok(route), Ok(data)) = (serde_json::from_str::<Value>(&route), serde_json::from_str::<Value>(&data)) else { continue };
        if route["waiting"] == true || !route["released"].is_null() || !unstarted(&data, turns, receipts) {
            continue;
        }
        // A profile this Core can't read is not judged: its start says why.
        let Ok(profile) = profile.map(|p| serde_json::from_str::<RuntimeProfile>(&p)).transpose() else { continue };
        out.push(QueuedRouted { agent, route, profile });
    }
    Ok(out)
}

/// Makes `agent`, routed by `route`, wait for a candidate again because what it was
/// given has left, in one transaction and only while its slot still waits: its
/// route says `waiting` and `left` (with the candidate and account it had), and its
/// runtime profile is removed, so no start uses that account or key. Whether it did:
/// a pass that took it to start first leaves it as it is.
fn mark_left(db: &mut Connection, agent: &str, left: &Left, route: &Value) -> Result<bool> {
    let mut route = route.clone();
    let mut why = left.reason();
    why["at"] = json!(Utc::now().to_rfc3339());
    why["from"] = route["chosen"].clone();
    if !route["account"].is_null() {
        why["fromAccount"] = route["account"].clone();
    }
    route["waiting"] = json!(true);
    route["left"] = why;
    let tx = db.transaction()?;
    let written = tx.execute(
        "UPDATE executor_dispatches SET route_json=?2
         WHERE agent_id=?1 AND EXISTS(SELECT 1 FROM executor_slots WHERE agent_id=?1 AND state='waiting')",
        rusqlite::params![agent, route.to_string()])? > 0;
    if written {
        tx.execute("DELETE FROM agent_runtime_profiles WHERE agent_id=?1", [agent])?;
    }
    tx.commit()?;
    Ok(written)
}

/// Why an executor waiting for a candidate starts without one: routing is off, or no
/// candidate it could ever be given is left, so none could be chosen (#805 R1 P2). A
/// candidate it can be given is what `evaluate` would not pass over for it whatever the
/// readings: enabled; not `excluded` for it (a rebuild's); of a harness its machine runs
/// (YN-66), and its own once something of it ran; not this Core host's only while it
/// waits on another machine (#805 R2 P3); with no machine condition that leaves its
/// machine out (YN-139); of a harness that keeps its permission level; and serving its
/// tier (YN-70).
pub(crate) fn release_reason(policy: &Value, waiting: &WaitingExecutor) -> Option<Value> {
    let excluded = waiting.excluded();
    let possible = |c: &Value| {
        let harness = c["harness"].as_str().unwrap_or_default();
        c["enabled"] == true && waiting.harness_only().is_none_or(|own| own == harness)
            && !excluded.iter().any(|e| c["id"] == e.as_str())
            && !(waiting.machine != "local" && host_only(c))
            && machine_allows(c, Some(waiting.machine.as_str()))
            && !waiting.unavailable.contains(&harness)
            && crate::permission_levels::keeps(waiting.level(), harness)
            && serves(c, waiting.tier())
    };
    let (code, message, zh) = if policy["enabled"] != true {
        ("routingOff", "Routing was turned off while it waited, so it starts as it would without routing",
            "它等待期间路由已关闭，所以按没有路由时的方式启动")
    } else if !policy["candidates"].as_array().into_iter().flatten().any(possible) {
        ("noCandidate", "No candidate it could be given is left, so it starts as it would without routing",
            "已没有能给它的候选，所以按没有路由时的方式启动")
    } else {
        return None;
    };
    Some(json!({"code": code, "message": message, "messageZh": zh}))
}

/// Releases `waiting` when `release_reason` names why: it starts in turn on the host's
/// own login, as its template says, and its route says why. Whether it did.
fn release(db: &Connection, policy: &Value, waiting: &WaitingExecutor) -> Result<bool> {
    let Some(mut reason) = release_reason(policy, waiting) else { return Ok(false) };
    reason["at"] = json!(Utc::now().to_rfc3339());
    let mut route = waiting.route.clone();
    route["waiting"] = json!(false);
    route["released"] = reason;
    set_route(db, &waiting.agent, &route)?;
    Ok(true)
}

/// Releases each waiting executor `release_reason` names. Answers the ones released.
pub(crate) fn release_waiting(db: &Connection) -> Result<Vec<String>> {
    let policy = super::stored_in(db)?.policy;
    let mut released = Vec::new();
    for waiting in waiting_list(db)? {
        if release(db, &policy, &waiting)? {
            released.push(waiting.agent);
        }
    }
    Ok(released)
}

pub(crate) fn set_route(db: &Connection, agent: &str, route: &Value) -> Result<()> {
    db.execute("UPDATE executor_dispatches SET route_json=?2 WHERE agent_id=?1", rusqlite::params![agent, route.to_string()])?;
    Ok(())
}

/// The newest dispatches routing chose for: `{dispatchId, taskId, agentId, executorName?, route}`; the name
/// while the executor's record is kept.
pub(crate) fn choices(db: &Connection, limit: usize) -> Result<Vec<Value>> {
    let mut statement = db.prepare(
        "SELECT d.dispatch_id, d.task_id, d.agent_id, d.route_json, json_extract(a.data,'$.agent.name')
         FROM executor_dispatches d LEFT JOIN agents a ON a.id=d.agent_id
         WHERE d.route_json IS NOT NULL ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?1")?;
    let rows = statement.query_map([limit as i64], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
        r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().map(|(dispatch, task, agent, route, name)| {
        let mut choice = json!({"dispatchId": dispatch, "taskId": task, "agentId": agent,
            "route": serde_json::from_str::<Value>(&route).unwrap_or(Value::Null)});
        if let Some(name) = name {
            choice["executorName"] = name.into();
        }
        choice
    }).collect())
}

impl crate::store::Store {
    pub(crate) fn routing_waiting(&self) -> Result<Vec<WaitingExecutor>> {
        waiting_list(&*self.db.read()?)
    }

    /// `agent`, while it waits for a candidate.
    pub(crate) fn routing_waiting_one(&self, agent: &str) -> Result<Option<WaitingExecutor>> {
        Ok(waiting_where(&*self.db.read()?, Some(agent))?.pop())
    }

    pub(crate) fn release_routing_waiting(&self) -> Result<Vec<String>> {
        release_waiting(&*self.db.write()?)
    }

    pub(crate) fn release_routing_one(&self, policy: &Value, waiting: &WaitingExecutor) -> Result<bool> {
        release(&*self.db.write()?, policy, waiting)
    }

    pub(crate) fn set_routing_route(&self, agent: &str, route: &Value) -> Result<()> {
        set_route(&*self.db.write()?, agent, route)
    }

    pub(crate) fn routing_left_queued(&self) -> Result<Vec<QueuedRouted>> {
        left_queued(&*self.db.read()?, None)
    }

    /// `agent`, while it is routed, queued and not started.
    pub(crate) fn routing_left_queued_one(&self, agent: &str) -> Result<Option<QueuedRouted>> {
        Ok(left_queued(&*self.db.read()?, Some(agent))?.pop())
    }

    pub(crate) fn mark_routing_left(&self, agent: &str, left: &Left, route: &Value) -> Result<bool> {
        mark_left(&mut *self.db.write()?, agent, left, route)
    }

    pub(crate) fn routing_choices(&self, limit: usize) -> Result<Vec<Value>> {
        choices(&*self.db.read()?, limit)
    }
}

impl crate::workspace::Workspace {
    /// What routing reads for a dispatch, while routing is on. A read that
    /// fails dispatches as the template says, with the reason logged.
    pub(crate) async fn routing_for_dispatch(&self) -> Option<Gathered> {
        let on = self.stored(|store| store.routing_policy()).await.map(|p| p.policy["enabled"] == true).unwrap_or(false);
        if !on {
            return None;
        }
        match self.routing_gathered().await {
            Ok(gathered) => Some(gathered),
            Err(error) => {
                eprintln!("Routing: its readings could not be gathered, so this dispatch is as its template says: {error:#}");
                None
            }
        }
    }

    /// Reads routing again for each executor waiting for a candidate, among
    /// every candidate its machine can run (YN-66). One that no candidate could
    /// ever take is released (`release_reason`); else the first that holds gives
    /// it its harness, model, effort, permission and account or key
    /// (`start_as`), and it joins the queue to start. Each under its gate: a
    /// start and another pass routing or releasing it wait for this one, which
    /// reads it again there.
    ///
    /// First, while routing is on, each executor routed but not started whose
    /// candidate, account or key has left waits again (YN-138, `mark_left`), so
    /// this pass routes it with the others.
    pub(crate) async fn route_waiting(self: &Arc<Self>) {
        let gathered = self.route_left_queued().await;
        let listed = match self.stored(|store| store.routing_waiting()).await {
            Ok(listed) if !listed.is_empty() => listed,
            Ok(_) => return,
            Err(error) => {
                eprintln!("Routing: the executors waiting for a candidate could not be read: {error:#}");
                return;
            }
        };
        let stored = match self.stored(|store| store.routing_policy()).await {
            Ok(stored) => stored,
            Err(error) => {
                eprintln!("Routing: the policy could not be read for the executors waiting for a candidate: {error:#}");
                return;
            }
        };
        // Once for the pass. Without it one none can take is still released.
        let gathered = match gathered {
            Some(gathered) => Some(gathered),
            None => self.routing_gathered().await.map_err(|error| {
                eprintln!("Routing: its readings could not be gathered for the executors waiting for a candidate: {error:#}");
            }).ok(),
        };
        #[cfg(test)]
        self.route_meet("unlocked").await;
        for listed in listed {
            let gate = self.gate(&listed.agent).await;
            let _held = gate.lock().await;
            if let Err(error) = self.route_one_waiting(&listed.agent, &stored, gathered.as_ref()).await {
                eprintln!("Routing: executor {} could not be routed: {error:#}", listed.agent);
            }
        }
    }

    /// Makes each executor routed but not started whose candidate, account or key
    /// has left wait for a candidate again (YN-138), each under its gate, read
    /// again there. Only while routing is on and its readings could be gathered:
    /// what isn't known decides nothing. Answers the readings, when it gathered them.
    async fn route_left_queued(self: &Arc<Self>) -> Option<Gathered> {
        let read = self.stored(|store| Ok((store.routing_left_queued()?, store.routing_policy()?))).await;
        let (queued, stored) = match read {
            Ok((queued, stored)) if !queued.is_empty() && stored.policy["enabled"] == true => (queued, stored),
            Ok(_) => return None,
            Err(error) => {
                eprintln!("Routing: the executors queued to start could not be read: {error:#}");
                return None;
            }
        };
        let gathered = match self.routing_gathered().await {
            Ok(gathered) => gathered,
            Err(error) => {
                eprintln!("Routing: its readings could not be gathered, so no queued executor is routed again: {error:#}");
                return None;
            }
        };
        let keys: Vec<String> = gathered.keys.iter().map(|(id, _, _)| id.clone()).collect();
        for queued in queued {
            let gate = self.gate(&queued.agent).await;
            let _held = gate.lock().await;
            let id = queued.agent.clone();
            let again = match self.stored(move |store| store.routing_left_queued_one(&id)).await {
                Ok(Some(again)) => again,
                Ok(None) => continue,
                Err(error) => {
                    eprintln!("Routing: executor {} could not be read again: {error:#}", queued.agent);
                    continue;
                }
            };
            let Some(why) = left(&stored.policy, &again.route, again.profile.as_ref(), &keys, &gathered.codex_homes, &gathered.cswap) else {
                continue;
            };
            let (id, route, code) = (again.agent.clone(), again.route, why.code);
            match self.stored(move |store| store.mark_routing_left(&id, &why, &route)).await {
                Ok(true) => {
                    eprintln!("Routing: executor {} is routed again before its start ({code})", again.agent);
                    self.changed(&again.agent);
                }
                Ok(false) => {}
                Err(error) => eprintln!("Routing: executor {} could not be routed again: {error:#}", again.agent),
            }
        }
        Some(gathered)
    }

    /// One waiting executor's routing, under its gate.
    async fn route_one_waiting(self: &Arc<Self>, agent: &str, stored: &super::Stored, gathered: Option<&Gathered>) -> Result<()> {
        // Read again under its gate: another pass may have routed or released it since the list.
        let id = agent.to_owned();
        let Some(waiting) = self.stored(move |store| store.routing_waiting_one(&id)).await? else { return Ok(()) };
        let waiting = Arc::new(waiting);
        let (policy, held) = (stored.policy.clone(), waiting.clone());
        if self.stored(move |store| store.release_routing_one(&policy, &held)).await? {
            eprintln!("Routing: executor {agent} waited for a candidate none can be; it starts as it would without routing");
            return Ok(());
        }
        let Some(gathered) = gathered else { return Ok(()) };
        let excluded = waiting.excluded();
        let assume = Assume::default();
        let mut inputs = gathered.inputs(Utc::now(), Some(&waiting.machine), &excluded, waiting.harness_only(), waiting.level(), &assume);
        inputs.unavailable = &waiting.unavailable;
        (inputs.tier, inputs.tier_source) = (waiting.tier(), waiting.tier_source());
        let route = evaluate(stored.version, &stored.policy, "start", &inputs);
        let mut record = route.record;
        record["excluded"] = json!(excluded);
        // What it was given before, when that left (YN-138): kept on each record
        // after, so its start says what it was changed from.
        if !waiting.route["left"].is_null() {
            record["left"] = waiting.route["left"].clone();
        }
        match route.chosen {
            Some(candidate) => self.start_as(&waiting, &candidate, route.profile, record).await,
            None => {
                record["waiting"] = json!(true);
                let id = agent.to_owned();
                self.stored(move |store| store.set_routing_route(&id, &record)).await
            }
        }
    }

    /// `waiting` given `candidate` at its start: its Agent record's harness, model
    /// and settings as a dispatch choosing that candidate makes them (YN-66), its
    /// account or key, and an OpenCode executor's permission level, then its route,
    /// last, which lets a slot pass start it. A candidate it can't be made as now
    /// (its model can't be checked, say) leaves it waiting, with why, for the next pass.
    async fn start_as(self: &Arc<Self>, waiting: &WaitingExecutor, candidate: &Value, profile: Option<RuntimeProfile>, mut record: Value) -> Result<()> {
        let agent = waiting.agent.clone();
        let base = Template { permission_level: waiting.level().map(str::to_owned), ..Template::general() };
        let born = match crate::server::executor_born(self, &apply(&base, candidate), &waiting.machine, waiting.project.clone()).await {
            Ok(born) => born,
            Err(error) => {
                record["chosen"] = Value::Null;
                record["waiting"] = json!(true);
                record["applyFailed"] = json!({"candidate": candidate["id"], "message": format!("{error:#}"), "at": Utc::now().to_rfc3339()});
                return self.stored(move |store| store.set_routing_route(&agent, &record)).await;
            }
        };
        #[cfg(test)]
        self.route_meet("locked").await;
        // One whose candidate, account or key left (YN-138) was changed from that
        // candidate, and why; one that waited from its dispatch from none.
        let left = &waiting.route["left"];
        let mut changed = if left.is_null() {
            json!({"from": null, "reason": "It waited for a candidate, and this one holds now"})
        } else {
            json!({"from": left["from"], "reason": {"code": left["code"], "message": left["message"], "messageZh": left["messageZh"]}})
        };
        if !left["fromAccount"].is_null() {
            changed["fromAccount"] = left["fromAccount"].clone();
        }
        let mut event = json!({"candidate": candidate["id"], "model": born.model, "harness": born.harness});
        if born.harness != waiting.harness {
            changed["harnessFrom"] = json!(waiting.harness);
            event["harnessFrom"] = json!(waiting.harness);
        }
        record["changedAtStart"] = changed;
        // As a dispatch's executor keeps it (collaboration_store/executor_dispatch.rs `Plan::then`).
        // Read-only on every harness: each start applies it (permission_levels.rs, YN-74 ④b).
        let level = waiting.level().filter(|level| born.harness == "opencode" || *level == crate::permission_levels::READ_ONLY).map(str::to_owned);
        let crate::server::Born { harness, model, settings } = born;
        self.record_meta(&agent, "routing/chosen", event, move |m| {
            m.agent.harness = harness;
            m.agent.model = model;
            m.agent.settings = settings;
        }).await?;
        let id = agent.clone();
        self.stored(move |store| {
            store.set_runtime_profile(&id, profile.as_ref())?;
            store.set_permission_level(&id, level.as_deref())?;
            store.set_routing_route(&id, &record)
        }).await?;
        self.changed(&agent);
        Ok(())
    }

    /// A test's meeting point for a pass routing a waiting executor: `unlocked`,
    /// once it has read the waiting executors, before it takes any gate; `locked`,
    /// under an executor's gate, once it knows what the chosen candidate makes it,
    /// before it writes any of it. The first pass to come there takes it, and
    /// meets the test twice: as it arrives, and to go on (each up to five seconds).
    #[cfg(test)]
    async fn route_meet(&self, at: &str) {
        let meet = {
            let mut held = self.executor_slots.route_meet.lock().unwrap();
            if held.as_ref().is_some_and(|(want, _)| *want == at) { held.take() } else { None }
        };
        if let Some((_, meet)) = meet {
            for _ in 0..2 {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), meet.wait()).await;
            }
        }
    }
}

#[cfg(test)]
#[path = "start_tests.rs"]
mod start_tests;
