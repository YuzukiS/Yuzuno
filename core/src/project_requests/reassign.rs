//! The user's reassignment of a card (YN-86 §4.2, §4.3; slice S3a-2), from
//! the card on Home: `POST /api/projects/{id}/cards/{sectionId}/reassign`,
//! a browser route only (`router`'s no_agent_credential), never an Agent's
//! tool. As the user, Core first dispatches the card's task to its new
//! responsible Agent, an open member of the Project or a new executor from
//! one of the Workspace's templates (the user's routing choosing it), with
//! the card named in the dispatch; then, once that dispatch stands, it
//! releases the card's earlier executor, as the user's own release would.
//! A release that fails leaves the new dispatch as it is, and the same
//! reassignment again releases it. The reassignment is a route of its own
//! (`kind: reassign`, by the user), shown with the card's handoffs and on
//! the requests routed to it.
use super::{
    not_submitted,
    routes::{self, RouteRow, DONE, FAILED, MAX_LINE, PENDING, REASSIGN},
};
use crate::{store::Store, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// What the user's page sends.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Reassign {
    /// The Workspace whose page the user acted on.
    pub workspace_id: String,
    /// The new responsible: {agentId} or {executor: {templateId, tier?, machineId?}}.
    pub to: Value,
    /// Why, in the user's words, sent with the dispatch.
    #[serde(default)]
    pub why: Option<String>,
    /// The page's ID for this reassignment: sent again, it is the same one.
    pub client_request_id: String,
}

/// What a reassignment's answer says of the earlier executor's release
/// (Dev Lead 2, seq 12103; executor_release.rs).
pub(super) const RELEASE_NOTE: &str = "Releasing ends what the earlier executor was doing: Core closes it for good and its runtime \
    stops. While a Job of its runs, its delivery flow is under way or a pull request operation of its is in flight, it is \
    archiving first (release.archiving.reason says what it waits for) and is closed once that ends, never cut off.";

/// The reassignment as kept: what a repeat under its client ID must equal.
fn kept(section: i64, to: &Value, why: &str) -> Value {
    json!({"sectionId":section,"to":to,"why":why})
}

/// Records the reassignment, or finds it recorded under its client ID,
/// checked against the card as it is now: a live card of the Project bound
/// to a task that goes on; the new responsible not the one answering now.
fn begin(store: &Store, project: &str, section: i64, input: &Reassign, to: &Value, why: &str) -> Result<RouteRow> {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    let workspace: String = tx.query_row("SELECT value FROM workspace_meta WHERE key='workspaceId'", [], |r| r.get(0))?;
    ensure!(input.workspace_id == workspace, "workspace_changed: this reassignment was begun on another Workspace's page. Nothing was changed");
    let asked = kept(section, to, why);
    let found = routes::rows(&tx, "project_id=?1 AND client_id=?2", params![project, input.client_request_id])?.pop();
    if let Some(row) = found {
        let given = json!({"sectionId":row.input["sectionId"],"to":row.input["to"],"why":row.input["why"]});
        ensure!(given == asked, "idempotency_conflict: this clientRequestId was already used for another reassignment. Nothing was changed");
        return Ok(row);
    }
    let (name, archived) = crate::projects::project_labels(&tx)?.remove(project).context("project_not_found: no Project has this ID")?;
    ensure!(!archived, "project_archived: {name} is archived; unarchive it to reassign its cards. Nothing was changed");
    let card = crate::project_brief::card_by_identity(&tx, project, section)?
        .filter(|card| card.live)
        .context("card_not_found: this Project's Home has no live card with this ID. Nothing was changed")?;
    let task = card.task.clone().with_context(|| format!("not_a_card: {} is bound to no task, so no Agent answers for it. Nothing was changed", card.key))?;
    ensure!(!crate::project_brief::task_ended(&tx, &task)?, "card_ended: the task of {} has ended. Nothing was changed", card.key);
    let from = crate::project_brief::responsible_agent(&tx, &task)?;
    if let Some(agent) = to["agentId"].as_str() {
        routes::may_take(&tx, store, project, agent)?;
        ensure!(from.as_deref() != Some(agent), "already_responsible: {agent} answers for {} already. Nothing was changed", card.key);
    }
    let version: i64 = tx.query_row("SELECT version FROM collaboration_tasks WHERE id=?1", [&task], |r| r.get(0))?;
    let mut input_json = asked;
    input_json["taskId"] = json!(task);
    input_json["expectedVersion"] = json!(version);
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO project_routes(id,project_id,client_id,kind,input,task_id,section_id,card_key,from_agent_id,why,at,state)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![id, project, input.client_request_id, REASSIGN, input_json.to_string(), task, section, card.key, from, why,
            crate::model::now(), PENDING],
    )?;
    let row = routes::rows(&tx, "id=?1", [&id])?.pop().context("the reassignment was not kept")?;
    tx.commit()?;
    Ok(row)
}

/// `POST /api/projects/{id}/cards/{sectionId}/reassign`. The answer is the
/// reassignment as a card's handoffs show it, and `released`: the earlier
/// executor's release when there was one to make ({agentId, note, release},
/// `release` being executor_release's answer), else null.
pub(super) async fn reassign(ws: &Arc<Workspace>, project: &str, section: i64, input: Reassign) -> Result<Value> {
    ensure!((1..=100).contains(&input.client_request_id.len()), "A reassignment needs a clientRequestId of 1–100 bytes. Nothing was changed");
    let why = input.why.as_deref().map(str::trim).unwrap_or_default().to_owned();
    let length = why.encode_utf16().count();
    ensure!(length <= MAX_LINE, "why is {length} characters; at most {MAX_LINE}. Nothing was changed");
    let to = match (input.to.get("agentId"), input.to.get("executor")) {
        (Some(Value::String(agent)), None) if input.to.as_object().is_some_and(|o| o.len() == 1) && !agent.trim().is_empty() => {
            json!({"agentId":agent.trim()})
        }
        (None, Some(executor)) if input.to.as_object().is_some_and(|o| o.len() == 1) => json!({"executor":routes::executor("to.", executor)?}),
        _ => return Err(not_submitted("to is {agentId} or {executor: {templateId, tier?, machineId?}}. Nothing was changed".into())),
    };
    // One reassignment of a Project's cards at a time.
    let gate = ws.gate(&format!("project-reassign:{project}")).await;
    let _held = gate.lock().await;
    let (place, given, wanted, said) = (project.to_owned(), input.clone(), to.clone(), why.clone());
    let row = ws.stored(move |store| begin(store, &place, section, &given, &wanted, &said)).await?;
    let task = row.task_id.clone().context("a reassignment names its task")?;
    let target = match &row.target_agent_id {
        Some(agent) => agent.clone(),
        None => {
            let card = row.card_key.clone().unwrap_or_default();
            let mut body = format!("Reassigned to you by the user on Home: you now answer for the card {card}.");
            if !row.why.is_empty() {
                body.push_str(&format!(" Why, in the user's words: {}", row.why));
            }
            let mut dispatch = json!({"requestId":format!("project-reassign:{}", row.id),"taskId":task,
                "expectedVersion":row.input["expectedVersion"],"body":body});
            match row.input["to"]["agentId"].as_str() {
                Some(agent) => dispatch["toAgentId"] = json!(agent),
                None => dispatch["executor"] = row.input["to"]["executor"].clone(),
            }
            let dispatched = ws.collaboration_call(None, "task_dispatch", dispatch).await;
            let agent = match dispatched {
                Ok(answer) => answer["agentId"].as_str().or(row.input["to"]["agentId"].as_str()).map(str::to_owned),
                Err(error) => {
                    finish(ws, &row.id, None, Some(format!("{error:#}"))).await?;
                    return Err(error);
                }
            };
            let agent = agent.context("task_dispatch answered without its Agent")?;
            let (id, chosen) = (row.id.clone(), agent.clone());
            ws.stored(move |store| {
                store.db.write()?.execute("UPDATE project_routes SET target_agent_id=?2 WHERE id=?1", params![id, chosen])?;
                Ok(())
            })
            .await?;
            agent
        }
    };
    // Then the earlier executor, released by the user, once the new
    // responsible stands; an Agent that is no executor stays as it is.
    let earlier = match &row.from_agent_id {
        Some(agent) if *agent != target => {
            let known = agent.clone();
            let executor = ws.stored(move |store| Ok(crate::agent_roles::kind(&*store.db.read()?, &known)? == crate::agent_roles::EXECUTOR)).await?;
            executor.then(|| agent.clone())
        }
        _ => None,
    };
    let mut released = Value::Null;
    if let Some(agent) = earlier {
        match ws.release_executor(None, &agent).await {
            Ok(answer) => released = json!({"agentId":agent,"note":RELEASE_NOTE,"release":answer}),
            Err(error) => {
                finish(ws, &row.id, None, Some(format!("release_failed: {agent} was not released: {error:#}"))).await?;
                return Err(error.context(format!("the card has its new responsible Agent, and {agent} was not released; reassign again to release it")));
            }
        }
    }
    finish(ws, &row.id, Some(DONE), None).await?;
    super::announce(ws, project);
    crate::project_brief::announce(ws, Some(project));
    let id = row.id.clone();
    let shown = ws.stored(move |store| {
        let db = store.db.read()?;
        let row = routes::rows(&db, "id=?1", [&id])?.pop().context("the reassignment was not kept")?;
        routes::json(&db, &row)
    })
    .await?;
    Ok(json!({"route":shown,"released":released}))
}

/// Records how the reassignment stands: done, or failed with why (its
/// state stays pending while it can go on).
async fn finish(ws: &Arc<Workspace>, id: &str, state: Option<&'static str>, error: Option<String>) -> Result<()> {
    let id = id.to_owned();
    let state = state.unwrap_or(FAILED);
    ws.stored(move |store| {
        store.db.write()?.execute("UPDATE project_routes SET state=?2,error=?3 WHERE id=?1", params![id, state, error])?;
        Ok(())
    })
    .await
}

