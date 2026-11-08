//! Routing at dispatch and at an executor's first start (YN-34 S3b2).
//!
//! - **At dispatch,** in the dispatch's own transaction, when routing is on
//!   and the template is not `routing: fixed`: the evaluator's choice gives
//!   the executor its harness, model and effort, and the account or key it
//!   starts with (its runtime profile, set once it exists). The record of why
//!   is kept on the dispatch (`route_json`).
//! - **When none can be chosen,** the executor is made with the harness of
//!   the first candidate that could run there, and waits: the slot pass
//!   leaves it in the queue, and at each pass reads routing again, among the
//!   candidates of its harness only, until one holds. An executor's harness
//!   is fixed at its dispatch.
//! - **A rebuild** (a definite start failure) leaves out the candidates the
//!   executor it replaces was started with, so each is tried once.
use super::evaluate::{evaluate, Assume, Gathered};
use crate::{executor_templates::Template, routing_launch::RuntimeProfile};
use anyhow::Result;
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

/// What routing gave a dispatch.
pub(crate) struct Routed {
    pub template: Template,
    pub route: Value,
    pub profile: Option<RuntimeProfile>,
    /// "local" when the chosen candidate runs on this Core host only.
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
/// and the permission field of that harness only.
pub(crate) fn apply(template: &Template, candidate: &Value) -> Template {
    let mut t = template.clone();
    let harness = candidate["harness"].as_str().unwrap_or("codex").to_owned();
    let model = candidate["model"].as_str().filter(|m| !m.is_empty()).map(str::to_owned);
    t.model = model;
    t.reasoning_effort = if harness == "codex" { candidate["reasoningEffort"].as_str().map(str::to_owned) } else { None };
    if harness != "codex" {
        t.permission_preset = None;
    }
    if harness != "claude" {
        t.permission_mode = None;
    }
    if harness != template.harness {
        // Another harness's permissions are not this one's: its own defaults.
        t.permission_preset = None;
        t.permission_mode = None;
    }
    t.harness = harness;
    t
}

fn host_only(candidate: &Value) -> bool {
    candidate["credential"]["kind"] != "login" || candidate["harness"] == "opencode"
}

/// Routing for a dispatch, in its transaction: None while routing is off, for
/// a `fixed` template, or with no candidate at all.
pub(crate) fn route(tx: &Connection, gathered: &Gathered, template: &Template, request_id: &str, machine: Option<&str>) -> Result<Option<Routed>> {
    if template.routing.as_deref() == Some("fixed") {
        return Ok(None);
    }
    let stored = super::stored_in(tx)?;
    if stored.policy["enabled"] != true {
        return Ok(None);
    }
    let exclude = failed_before(tx, request_id)?;
    // `auto` or unset chooses its machine after routing: any candidate may run.
    let machine = machine.filter(|m| *m != super::super::collaboration_store::executor_choice::AUTO);
    let assume = Assume::default();
    let route = evaluate(stored.version, &stored.policy, "dispatch", &gathered.inputs(Utc::now(), machine, &exclude, None, None, &assume));
    let mut record = route.record;
    record["excluded"] = json!(exclude);
    if let Some(candidate) = route.chosen {
        let machine = host_only(&candidate).then(|| "local".to_owned());
        return Ok(Some(Routed { template: apply(template, &candidate), route: record, profile: route.profile, machine }));
    }
    // None now: the first enabled candidate that could run there gives the
    // executor its harness, and it waits for one of that harness.
    let first = stored.policy["candidates"].as_array().into_iter().flatten()
        .find(|c| c["enabled"] == true && !exclude.iter().any(|e| c["id"] == e.as_str())
            && (!host_only(c) || machine.is_none_or(|m| m == "local")));
    let Some(first) = first else {
        return Ok(None);
    };
    record["waiting"] = json!(true);
    let mut waiting = apply(template, first);
    waiting.model = None;
    waiting.reasoning_effort = None;
    let machine = host_only(first).then(|| "local".to_owned());
    Ok(Some(Routed { template: waiting, route: record, profile: None, machine }))
}

/// Whether `agent`'s dispatch waits for a candidate: the slot pass leaves it queued.
pub(crate) fn waiting(tx: &Connection, agent: &str) -> Result<bool> {
    let raw: Option<Option<String>> = tx.query_row("SELECT route_json FROM executor_dispatches WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?;
    Ok(raw.flatten().and_then(|r| serde_json::from_str::<Value>(&r).ok()).is_some_and(|r| r["waiting"] == true))
}

/// The executors waiting for a candidate: (agent, harness, machine, route).
pub(crate) fn waiting_list(db: &Connection) -> Result<Vec<(String, String, String, Value)>> {
    let mut statement = db.prepare(
        "SELECT d.agent_id, d.machine_id, d.route_json, COALESCE(json_extract(a.data,'$.agent.harness'),'codex')
         FROM executor_dispatches d JOIN agents a ON a.id=d.agent_id JOIN executor_slots s ON s.agent_id=d.agent_id
         WHERE d.route_json IS NOT NULL AND s.state='waiting'")?;
    let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().filter_map(|(agent, machine, route, harness)| {
        let route: Value = serde_json::from_str(&route).ok()?;
        (route["waiting"] == true).then_some((agent, harness, machine, route))
    }).collect())
}

/// Why an executor waiting for a candidate starts without one: routing is off, or no
/// candidate it could ever be given is left, so none could be chosen (#805 R1 P2). A
/// candidate it can be given is enabled, of its harness, not `excluded` for it (a
/// rebuild's), and, when it waits on another machine, not this Core host's only (#805 R2 P3):
/// what `evaluate` would pass over for it otherwise.
pub(crate) fn release_reason(policy: &Value, harness: &str, excluded: &[String], machine: &str) -> Option<Value> {
    let possible = |c: &Value| c["enabled"] == true && c["harness"] == harness
        && !excluded.iter().any(|e| c["id"] == e.as_str())
        && !(machine != "local" && host_only(c));
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

/// Releases each waiting executor `release_reason` names: it starts in turn on the host's
/// own login, as its template says, and its route says why. Answers the ones released.
pub(crate) fn release_waiting(db: &Connection) -> Result<Vec<String>> {
    let policy = super::stored_in(db)?.policy;
    let mut released = Vec::new();
    for (agent, harness, machine, mut route) in waiting_list(db)? {
        let excluded: Vec<String> = route["excluded"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
        if let Some(mut reason) = release_reason(&policy, &harness, &excluded, &machine) {
            reason["at"] = json!(Utc::now().to_rfc3339());
            route["waiting"] = json!(false);
            route["released"] = reason;
            set_route(db, &agent, &route)?;
            released.push(agent);
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
    pub(crate) fn routing_waiting(&self) -> Result<Vec<(String, String, String, Value)>> {
        waiting_list(&*self.db.read()?)
    }

    pub(crate) fn release_routing_waiting(&self) -> Result<Vec<String>> {
        release_waiting(&*self.db.write()?)
    }

    pub(crate) fn set_routing_route(&self, agent: &str, route: &Value) -> Result<()> {
        set_route(&*self.db.write()?, agent, route)
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
    /// the candidates of its harness; the first that holds gives it its
    /// model, effort and account or key, and it joins the queue to start.
    /// One that no candidate could ever take is released first (`release_waiting`).
    pub(crate) async fn route_waiting(self: &std::sync::Arc<Self>) {
        match self.stored(|store| store.release_routing_waiting()).await {
            Ok(released) => {
                for agent in released {
                    eprintln!("Routing: executor {agent} waited for a candidate none can be; it starts as it would without routing");
                }
            }
            Err(error) => eprintln!("Routing: the executors waiting for a candidate could not be released: {error:#}"),
        }
        let waiting = match self.stored(|store| store.routing_waiting()).await {
            Ok(waiting) if !waiting.is_empty() => waiting,
            Ok(_) => return,
            Err(error) => {
                eprintln!("Routing: the executors waiting for a candidate could not be read: {error:#}");
                return;
            }
        };
        let (Ok(stored), Ok(gathered)) = (self.stored(|store| store.routing_policy()).await, self.routing_gathered().await) else { return };
        for (agent, harness, machine, old) in waiting {
            let exclude: Vec<String> = old["excluded"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            let assume = Assume::default();
            // Its permission level, as its dispatch's route kept it.
            let level = old["level"].as_str();
            let route = evaluate(stored.version, &stored.policy, "start",
                &gathered.inputs(Utc::now(), Some(&machine), &exclude, Some(&harness), level, &assume));
            let mut record = route.record;
            record["excluded"] = json!(exclude);
            let applied: Result<()> = async {
                if let Some(candidate) = route.chosen {
                    record["changedAtStart"] = json!({"from": null, "reason": "It waited for a candidate, and this one holds now"});
                    let model = candidate["model"].as_str().unwrap_or_default().to_owned();
                    let effort = if harness == "codex" { candidate["reasoningEffort"].as_str().map(str::to_owned) } else { None };
                    let profile = route.profile;
                    let id = agent.clone();
                    self.stored(move |store| store.set_runtime_profile(&id, profile.as_ref())).await?;
                    self.record_meta(&agent, "routing/chosen", json!({"candidate": candidate["id"], "model": model}), move |m| {
                        m.agent.model = model;
                        if effort.is_some() {
                            m.agent.settings.reasoning_effort = effort;
                        }
                    }).await?;
                } else {
                    record["waiting"] = json!(true);
                }
                let (id, route) = (agent.clone(), record);
                self.stored(move |store| store.set_routing_route(&id, &route)).await
            }.await;
            if let Err(error) = applied {
                eprintln!("Routing: executor {agent} could not be routed: {error:#}");
            }
        }
    }
}
