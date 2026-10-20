//! A task status change an Agent proposes in a result (T-39).
//!
//! An Agent proposes it with one TaskStatus component in `result_publish`:
//! an existing task (T-N), a status and a reason. Publishing changes nothing.
//! The card shows the task as Core reads it now; the user may change the
//! status or the reason, then confirms or declines. Only a confirmation
//! changes the task, through the ordinary `task_update` as the user, with the
//! version the user saw: a task that changed meanwhile is refused, never
//! overwritten. The task's activity names the proposal as its source.
//!
//! One proposal changes its task at most once. Each decision is an attempt
//! kept with its requestId: a retry gets its first answer, and another window
//! sees the applied change instead of applying it again. An attempt a stop of
//! Core interrupted is settled from the task's own request receipt: applied
//! if the change was committed, otherwise failed and nothing changed.
//!
//! Only the latest version of a result, from an open Agent, can be decided.
//! The target is always the proposal's, never the request's.
use crate::{
    collaboration_store::{load_task, task_key, STATUSES},
    server::ApiError,
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const COMPONENT: &str = "TaskStatus";
const MAX_REASON: usize = 1000;

/// Decisions run one at a time, so an attempt seen pending while this is
/// held is one a stop of Core interrupted. A decision holds it until its
/// task_update and outcome are recorded, even if its request is dropped (see
/// decide_task_proposal).
static DECIDING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Tests only: holds the decision on one result inside its task_update job,
/// after its attempt is stored as pending, until the test lets it go.
#[cfg(test)]
type Hold = (String, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
#[cfg(test)]
static HOLD_TASK_UPDATE: std::sync::Mutex<Option<Hold>> = std::sync::Mutex::new(None);
#[cfg(test)]
fn hold_task_update(result: &str) {
    let hold = HOLD_TASK_UPDATE.lock().unwrap().take_if(|hold| hold.0 == result);
    if let Some((_, reached, proceed)) = hold {
        let _ = reached.send(());
        // Also goes on when the test drops its sender.
        let _ = proceed.recv();
    }
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS result_task_actions(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, result_id TEXT NOT NULL, request_id TEXT NOT NULL,
        task_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT, reason TEXT, expected_version INTEGER,
        state TEXT NOT NULL, error TEXT, receipt_json TEXT, actor_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(result_id, request_id));
        CREATE UNIQUE INDEX IF NOT EXISTS result_task_actions_once ON result_task_actions(result_id)
        WHERE state IN ('pending','applied','declined');",
    )?;
    Ok(())
}

pub(crate) fn delete_agent(db: &Connection, agent: &str) -> Result<()> {
    db.execute(
        "DELETE FROM result_task_actions WHERE result_id IN (SELECT id FROM interactive_results WHERE agent_id=?1)",
        [agent],
    )?;
    Ok(())
}

/// The result's TaskStatus element, if it has one (a result has at most one).
fn proposal_in(spec: &Value) -> Option<(&str, &Value)> {
    spec["elements"].as_object()?.iter()
        .find(|(_, element)| element["type"] == COMPONENT)
        .map(|(key, element)| (key.as_str(), &element["props"]))
}

/// Problems with a result's proposal that only Core can see, checked when it
/// is published: the task must exist and not already have that status.
pub(crate) fn publish_problems(db: &Connection, spec: &Value) -> Result<Option<Value>> {
    let Some((key, props)) = proposal_in(spec) else { return Ok(None) };
    let reference = props["taskId"].as_str().unwrap_or_default();
    let path = |field: &str| format!("elements.{key}.props.{field}");
    let Ok((id, _)) = task_key(db, reference) else {
        return Ok(Some(json!([{"code":"missing_task","path":path("taskId"),
            "reason":format!("No task {reference} exists. Propose a change only to an existing task; read it with task_get.")}])));
    };
    let task = load_task(db, &id)?;
    if props["status"] == task.status.as_str() {
        return Ok(Some(json!([{"code":"no_change","path":path("status"),
            "reason":format!("{reference} is already {}; propose a different status, or none.", task.status)}])));
    }
    Ok(None)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub request_id: String,
    /// confirm or decline.
    pub action: String,
    pub status: Option<String>,
    pub reason: Option<String>,
    pub expected_version: Option<i64>,
    /// pending, applied, failed or declined.
    pub state: String,
    pub error: Option<String>,
    /// The task's version after the change.
    pub task_version: Option<i64>,
    /// Who decided: always the user ({kind, id, name}).
    pub by: Value,
    pub at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFacts {
    pub id: String,
    pub title: String,
    pub status: String,
    pub version: i64,
    pub blocker: String,
    pub assignee: Option<String>,
    pub archived: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub result_id: String,
    pub agent_id: String,
    /// The proposal as the Agent published it.
    pub proposal: Value,
    /// The task as Core reads it now; None when it no longer exists.
    pub task: Option<TaskFacts>,
    /// Why nothing can be decided here any more, if so.
    pub blocked: Option<String>,
    /// Oldest first; the applied or declined one, if any, is last.
    pub attempts: Vec<Attempt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub request_id: String,
    /// confirm or decline.
    pub action: String,
    pub status: Option<String>,
    pub reason: Option<String>,
    pub expected_version: Option<i64>,
}

struct Loaded {
    agent: String,
    turn: String,
    proposal: Value,
    task_id: String,
    blocked: Option<String>,
}

fn load(store: &Store, db: &Connection, result: &str) -> Result<Loaded> {
    let row: Option<(String, String, String, String, i64)> = db.query_row(
        "SELECT agent_id,turn_id,chain_id,spec_json,version FROM interactive_results WHERE id=?1",
        [result], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).optional()?;
    let (agent, turn, chain, spec, version) = row.context("not_found: No such result")?;
    let spec: Value = serde_json::from_str(&spec)?;
    let (_, props) = proposal_in(&spec).context("not_found: This result proposes no task change")?;
    let latest: i64 = db.query_row("SELECT MAX(version) FROM interactive_results WHERE chain_id=?1", [&chain], |r| r.get(0))?;
    let open = store.brief_in(db, &agent)?.is_some_and(|b| b.agent.closed_at.is_none());
    let reference = props["taskId"].as_str().unwrap_or_default();
    let task_id = task_key(db, reference).map(|(id, _)| id).unwrap_or_default();
    let blocked = if version != latest {
        Some("The Agent replaced this proposal with a newer version; decide that one instead.".into())
    } else if !open {
        Some("The Agent that proposed this is closed, so the proposal can no longer be decided here.".into())
    } else if task_id.is_empty() {
        Some(format!("{reference} no longer exists."))
    } else {
        None
    };
    Ok(Loaded { agent, turn, proposal: props.clone(), task_id, blocked })
}

fn attempt(r: &rusqlite::Row) -> rusqlite::Result<Attempt> {
    let receipt: Option<String> = r.get(8)?;
    let actor: String = r.get(9)?;
    Ok(Attempt {
        request_id: r.get(0)?, action: r.get(1)?, status: r.get(2)?, reason: r.get(3)?, expected_version: r.get(4)?,
        state: r.get(5)?, error: r.get(6)?, at: r.get(7)?,
        task_version: receipt.and_then(|r| serde_json::from_str::<Value>(&r).ok()).and_then(|r| r["taskVersion"].as_i64()),
        by: serde_json::from_str(&actor).unwrap_or(Value::Null),
    })
}

fn attempts(db: &Connection, result: &str) -> Result<Vec<Attempt>> {
    let mut query = db.prepare(
        "SELECT request_id,action,status,reason,expected_version,state,error,updated_at,receipt_json,actor_json
         FROM result_task_actions WHERE result_id=?1 ORDER BY seq")?;
    let rows = query.query_map([result], attempt)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn view(store: &Store, db: &Connection, result: &str) -> Result<View> {
    let loaded = load(store, db, result)?;
    let task = if loaded.task_id.is_empty() { None } else {
        let (_, seq) = task_key(db, &loaded.task_id)?;
        let task = load_task(db, &loaded.task_id)?;
        Some(TaskFacts {
            id: format!("T-{seq}"), title: task.title, status: task.status, version: task.version, blocker: task.blocker,
            assignee: task.assignee.map(|a| a.name), archived: task.archived_at.is_some(),
        })
    };
    Ok(View { result_id: result.into(), agent_id: loaded.agent, proposal: loaded.proposal, task, blocked: loaded.blocked,
        attempts: attempts(db, result)? })
}

/// The task_update requestId of one attempt: stable, and its own.
fn domain_request(result: &str, request: &str) -> String {
    let digest = Sha256::digest(format!("{result}\n{request}"));
    let hex: String = digest.iter().take(24).map(|b| format!("{b:02x}")).collect();
    format!("proposal-{hex}")
}

/// Settles attempts a stop of Core left pending, from task_update's own
/// receipt. Called while DECIDING is held, so none of them is still running.
fn settle(db: &Connection, result: &str) -> Result<()> {
    let pending: Vec<String> = db.prepare("SELECT request_id FROM result_task_actions WHERE result_id=?1 AND state='pending'")?
        .query_map([result], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    for request in pending {
        let receipt: Option<String> = db.query_row(
            "SELECT response_json FROM collaboration_requests WHERE actor='user' AND operation='task_update' AND request_id=?1",
            [domain_request(result, &request)], |r| r.get(0)).optional()?;
        let (state, error, receipt) = match receipt.map(|r| serde_json::from_str::<Value>(&r)).transpose()? {
            Some(answer) => ("applied", None, Some(json!({"taskVersion":answer["task"]["version"],"activitySeq":answer["activity"]["seq"]}))),
            None => ("failed", Some("Core stopped before the task was changed; nothing changed. Confirm again if you still want it."), None),
        };
        db.execute("UPDATE result_task_actions SET state=?3, error=?4, receipt_json=?5, updated_at=?6 WHERE result_id=?1 AND request_id=?2",
            params![result, request, state, error, receipt.map(|r| r.to_string()), crate::model::now()])?;
    }
    Ok(())
}

fn text(value: &Option<String>, max: usize) -> Result<Option<String>> {
    let value = value.as_deref().map(str::trim).filter(|s| !s.is_empty());
    ensure!(value.is_none_or(|s| s.chars().count() <= max), "invalid_input: the reason is at most {max} characters");
    Ok(value.map(str::to_owned))
}

impl Workspace {
    /// The proposal in result `result`, the task as Core reads it now and
    /// every decision so far.
    pub async fn task_proposal(self: &Arc<Self>, result: &str) -> Result<View> {
        let _deciding = DECIDING.lock().await;
        let id = result.to_owned();
        self.stored(move |store| {
            let pending: bool = store.db.read()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM result_task_actions WHERE result_id=?1 AND state='pending')", [&id], |r| r.get(0))?;
            if pending {
                let mut db = store.db.write()?;
                let tx = db.transaction()?;
                settle(&tx, &id)?;
                tx.commit()?;
            }
            let db = store.db.read()?;
            view(store, &db, &id)
        }).await
    }

    /// Records the user's decision on result `result`'s proposal and, for a
    /// confirmation, changes the task. A retry with the same requestId gets
    /// the first answer; once the proposal is applied or declined, nothing
    /// more is changed by it.
    ///
    /// The decision runs to its end on its own task: a dropped request (the
    /// client went away) must not release DECIDING while its task_update still
    /// runs, or a read could settle that attempt as failed before the change
    /// commits.
    pub async fn decide_task_proposal(self: &Arc<Self>, result: &str, decision: Decision) -> Result<View> {
        let permit = self.admission.enter_work()?;
        let (ws, result) = (self.clone(), result.to_owned());
        tokio::spawn(async move {
            let _permit = permit;
            ws.decide(&result, decision).await
        })
        .await?
    }

    async fn decide(self: &Arc<Self>, result: &str, decision: Decision) -> Result<View> {
        ensure!(!decision.request_id.is_empty() && decision.request_id.len() <= 128, "invalid_input: requestId must be 1-128 bytes");
        ensure!(matches!(decision.action.as_str(), "confirm" | "decline"), "invalid_input: action is confirm or decline");
        let confirm = decision.action == "confirm";
        let reason = text(&decision.reason, MAX_REASON)?;
        let status = decision.status.clone().filter(|_| confirm);
        if confirm {
            ensure!(status.as_deref().is_some_and(|s| STATUSES.contains(&s)), "invalid_input: choose one of {}", STATUSES.join(", "));
            ensure!(decision.expected_version.is_some(), "invalid_input: expectedVersion is the task version you saw");
        }
        let expected = decision.expected_version.filter(|_| confirm);
        let _deciding = DECIDING.lock().await;
        let (id, request) = (result.to_owned(), decision.request_id.clone());
        let (chosen, why) = (status.clone(), reason.clone());
        let action = decision.action.clone();
        // Ok(None): answered without changing the task (a replay, a decided
        // proposal or a decline). Ok(Some(..)): the task_update to make.
        let next = self.stored(move |store| {
            let mut db = store.db.write()?;
            let tx = db.transaction()?;
            settle(&tx, &id)?;
            if let Some(previous) = attempts(&tx, &id)?.into_iter().find(|a| a.request_id == request) {
                ensure!(previous.action == action && previous.status == chosen && previous.reason == why
                    && previous.expected_version == expected,
                    "idempotency_conflict: requestId already has a different decision");
                tx.commit()?;
                return Ok(None);
            }
            let loaded = load(store, &tx, &id)?;
            if attempts(&tx, &id)?.iter().any(|a| matches!(a.state.as_str(), "applied" | "declined")) {
                tx.commit()?;
                return Ok(None);
            }
            if let Some(blocked) = &loaded.blocked {
                bail!("not_decidable: {blocked}");
            }
            let task = load_task(&tx, &loaded.task_id)?;
            ensure!(!confirm || expected != Some(task.version) || chosen.as_deref() != Some(task.status.as_str()),
                "no_change: the task is already {}", task.status);
            let user = json!({"kind":"user","id":"user","name":"You"}).to_string();
            let now = crate::model::now();
            tx.execute(
                "INSERT INTO result_task_actions(result_id,request_id,task_id,action,status,reason,expected_version,state,actor_json,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
                params![id, request, loaded.task_id, action, chosen, why, expected, if confirm { "pending" } else { "declined" }, user, now],
            )?;
            tx.commit()?;
            if !confirm {
                return Ok(None);
            }
            let status = chosen.clone().unwrap_or_default();
            let mut patch = json!({"status":status});
            if let (Some(reason), "blocked") = (&why, status.as_str()) {
                patch["blocker"] = json!(reason);
            }
            // Named under proposedBy, so the Agent's Turn is not taken for an
            // execution of the task: the user made this change.
            let source = json!({"via":"taskProposal","resultId":id,"proposedBy":{"agentId":loaded.agent,"turnId":loaded.turn},
                "proposed":loaded.proposal,"reason":why});
            Ok(Some((json!({"requestId":domain_request(&id, &request),"taskId":loaded.task_id,"expectedVersion":expected,"patch":patch}), source)))
        }).await?;
        if let Some((input, source)) = next {
            let ws = self.clone();
            #[cfg(test)]
            let held = result.to_owned();
            let outcome = crate::db::blocking(move || {
                #[cfg(test)]
                hold_task_update(&held);
                let answer = ws.store.collaboration_call_from(None, Some(source), "task_update", input);
                if answer.is_ok() {
                    let _ = ws.changes.send(json!({"collaboration":true}));
                    ws.collaboration_wakeup.notify_one();
                    ws.delivery.wake.notify_one();
                }
                Ok(answer)
            }).await?;
            let (id, request) = (result.to_owned(), decision.request_id.clone());
            self.stored(move |store| {
                let (state, error, receipt) = match outcome {
                    Ok(answer) => ("applied", None, Some(json!({"taskVersion":answer["task"]["version"],"activitySeq":answer["activity"]["seq"]}))),
                    Err(error) => ("failed", Some(format!("{error:#}")), None),
                };
                store.db.write()?.execute(
                    "UPDATE result_task_actions SET state=?3, error=?4, receipt_json=?5, updated_at=?6 WHERE result_id=?1 AND request_id=?2 AND state='pending'",
                    params![id, request, state, error, receipt.map(|r| r.to_string()), crate::model::now()])?;
                Ok(())
            }).await?;
        }
        let id = result.to_owned();
        let shown = self.stored(move |store| {
            let db = store.db.read()?;
            view(store, &db, &id)
        }).await?;
        let _ = self.changes.send(json!({"agentId":shown.agent_id}));
        Ok(shown)
    }
}

async fn read(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.task_proposal(&id).await?))
}

async fn decide(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(decision): Json<Decision>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.decide_task_proposal(&id, decision).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/results/{id}/task-status", get(read).post(decide))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AgentDetail;

    fn agent(id: &str) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":id,"name":"Lead","cwd":"/tmp","model":"test","color":"sage",
            "threadId":format!("session-{id}"),"status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
        .unwrap()
    }

    fn fixture() -> (tempfile::TempDir, Arc<Workspace>) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
        ws.store.insert(&agent("a")).unwrap();
        (dir, ws)
    }

    fn task(ws: &Workspace, title: &str, status: &str) -> (String, i64) {
        let created = ws.store.collaboration_call(None, "task_create", json!({"requestId":title,"title":title})).unwrap();
        let id = created["task"]["id"].as_str().unwrap().to_owned();
        let task = ws.store.collaboration_call(None, "task_update", json!({"requestId":format!("{title}-status"),"taskId":id,
            "expectedVersion":created["task"]["version"],"patch":{"status":status}})).unwrap();
        (id, task["task"]["version"].as_i64().unwrap())
    }

    /// A published result proposing `status` for `task`, as `version` of chain `chain`.
    fn proposal(ws: &Workspace, id: &str, chain: &str, version: i64, task: &str, status: &str) {
        let spec = json!({"root":"r","elements":{
            "r":{"type":"Result","props":{"title":"Status","summary":"Merged; acceptance on another host is open."},"children":["p"]},
            "p":{"type":"TaskStatus","props":{"taskId":task,"status":status,"reason":"Merged, but cross-host acceptance is still open"}}}});
        ws.store.db.write().unwrap().execute(
            "INSERT INTO interactive_results(id,chain_id,version,agent_id,session_id,turn_id,request_id,schema_version,spec_json,defaults_json,raw_json,created_at)
             VALUES(?1,?2,?3,'a','session-a','t1',?1,2,?4,'[]',?4,'now')",
            params![id, chain, version, spec.to_string()]).unwrap();
    }

    fn confirm(request: &str, status: &str, version: i64) -> Decision {
        Decision { request_id: request.into(), action: "confirm".into(), status: Some(status.into()),
            reason: Some("Merged, but cross-host acceptance is still open".into()), expected_version: Some(version) }
    }

    fn current(ws: &Workspace, id: &str) -> Value {
        ws.store.collaboration_call(None, "task_get", json!({"taskId":id})).unwrap()
    }

    #[tokio::test]
    async fn a_confirmation_changes_the_task_once_as_the_user_and_its_activity_names_the_proposal() {
        let (_dir, ws) = fixture();
        let (task_id, version) = task(&ws, "Independent Core", "done");
        proposal(&ws, "r1", "r1", 1, "T-1", "review");
        let shown = ws.task_proposal("r1").await.unwrap();
        let facts = shown.task.as_ref().unwrap();
        assert_eq!((facts.id.as_str(), facts.status.as_str(), facts.version, shown.blocked.as_deref()), ("T-1", "done", version, None));
        assert_eq!(shown.proposal["status"], "review");

        let applied = ws.decide_task_proposal("r1", confirm("c1", "review", version)).await.unwrap();
        let last = applied.attempts.last().unwrap();
        assert_eq!((last.state.as_str(), last.task_version, last.by["kind"].as_str()), ("applied", Some(version + 1), Some("user")));
        let read = current(&ws, &task_id);
        assert_eq!((read["task"]["status"].as_str(), read["task"]["version"].as_i64()), (Some("review"), Some(version + 1)));
        let event = read["activities"].as_array().unwrap().last().unwrap().clone();
        assert_eq!((event["actor"]["kind"].as_str(), event["source"]["via"].as_str(), event["source"]["resultId"].as_str(),
            event["source"]["proposedBy"]["agentId"].as_str()), (Some("user"), Some("taskProposal"), Some("r1"), Some("a")));
        assert_eq!(read["executions"], json!([]), "the Agent's Turn is not an execution of the task");

        // The same request again (a lost reply), and another window's own
        // confirmation: the first answer, and no second change.
        let replay = ws.decide_task_proposal("r1", confirm("c1", "review", version)).await.unwrap();
        assert_eq!(replay.attempts, applied.attempts);
        let other = ws.decide_task_proposal("r1", confirm("c2", "review", version + 1)).await.unwrap();
        assert_eq!(other.attempts, applied.attempts, "an applied proposal applies nothing more");
        assert_eq!(current(&ws, &task_id)["task"]["version"].as_i64(), Some(version + 1));
        let conflict = ws.decide_task_proposal("r1", confirm("c1", "doing", version)).await.unwrap_err();
        assert!(conflict.to_string().starts_with("idempotency_conflict"), "{conflict}");
    }

    #[tokio::test]
    async fn a_task_changed_meanwhile_is_refused_and_the_users_edit_goes_through_on_the_new_version() {
        let (_dir, ws) = fixture();
        let (task_id, version) = task(&ws, "Slice", "doing");
        proposal(&ws, "r1", "r1", 1, "T-1", "review");
        // Someone else changes the task after the user read it.
        ws.store.collaboration_call(None, "task_update", json!({"requestId":"elsewhere","taskId":task_id,"expectedVersion":version,
            "patch":{"progress":"Halfway"}})).unwrap();
        let stale = ws.decide_task_proposal("r1", confirm("c1", "review", version)).await.unwrap();
        let last = stale.attempts.last().unwrap();
        assert_eq!(last.state, "failed");
        assert!(last.error.as_deref().unwrap().starts_with("version_conflict"), "{:?}", last.error);
        assert_eq!(current(&ws, &task_id)["task"]["status"], "doing", "never overwritten");
        // The user reads it again, changes the proposal to blocked and confirms.
        let mut edited = confirm("c2", "blocked", version + 1);
        edited.reason = Some("Waits for the Windows lab".into());
        let applied = ws.decide_task_proposal("r1", edited).await.unwrap();
        assert_eq!(applied.attempts.iter().map(|a| a.state.as_str()).collect::<Vec<_>>(), ["failed", "applied"]);
        let read = current(&ws, &task_id);
        assert_eq!((read["task"]["status"].as_str(), read["task"]["blocker"].as_str()), (Some("blocked"), Some("Waits for the Windows lab")));
        let event = read["activities"].as_array().unwrap().last().unwrap().clone();
        assert_eq!((event["source"]["proposed"]["status"].as_str(), event["source"]["reason"].as_str()),
            (Some("review"), Some("Waits for the Windows lab")), "the original proposal and the user's edit are both kept");
    }

    #[tokio::test]
    async fn a_decline_changes_nothing_and_closes_the_proposal() {
        let (_dir, ws) = fixture();
        let (task_id, version) = task(&ws, "Slice", "doing");
        proposal(&ws, "r1", "r1", 1, "T-1", "done");
        let declined = ws.decide_task_proposal("r1", Decision { request_id: "d1".into(), action: "decline".into(),
            status: None, reason: None, expected_version: None }).await.unwrap();
        assert_eq!(declined.attempts.last().unwrap().state, "declined");
        let after = ws.decide_task_proposal("r1", confirm("c1", "done", version)).await.unwrap();
        assert_eq!(after.attempts, declined.attempts);
        assert_eq!((current(&ws, &task_id)["task"]["status"].as_str(), current(&ws, &task_id)["task"]["version"].as_i64()),
            (Some("doing"), Some(version)));
        // Choosing the status the task already has is no change at all.
        proposal(&ws, "r2", "r2", 1, "T-1", "review");
        let same = ws.decide_task_proposal("r2", confirm("c2", "doing", version)).await.unwrap_err();
        assert!(same.to_string().starts_with("no_change"), "{same}");
    }

    #[tokio::test]
    async fn only_the_latest_version_from_an_open_agent_for_an_existing_task_can_be_decided() {
        let (_dir, ws) = fixture();
        let (_, version) = task(&ws, "Slice", "doing");
        proposal(&ws, "r1", "r1", 1, "T-1", "review");
        proposal(&ws, "r2", "r1", 2, "T-1", "blocked");
        let old = ws.decide_task_proposal("r1", confirm("c1", "review", version)).await.unwrap_err();
        assert!(old.to_string().starts_with("not_decidable: The Agent replaced"), "{old}");
        assert!(ws.task_proposal("r1").await.unwrap().blocked.is_some());
        proposal(&ws, "r3", "r3", 1, "T-9", "review");
        let missing = ws.task_proposal("r3").await.unwrap();
        assert_eq!((missing.task.is_none(), missing.blocked.as_deref()), (true, Some("T-9 no longer exists.")));
        ws.store.update("a", "test/closed", &json!({}), |d| d.agent.closed_at = Some("now".into())).unwrap();
        let closed = ws.decide_task_proposal("r2", confirm("c2", "blocked", version)).await.unwrap_err();
        assert!(closed.to_string().contains("is closed"), "{closed}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_request_keeps_its_decision_until_task_update_ends_and_a_read_waits_for_it() {
        let (_dir, ws) = fixture();
        let (task_id, version) = task(&ws, "Slice", "doing");
        proposal(&ws, "held", "held", 1, "T-1", "review");
        let (reached_tx, reached) = std::sync::mpsc::channel();
        let (proceed, proceed_rx) = std::sync::mpsc::channel();
        *HOLD_TASK_UPDATE.lock().unwrap() = Some(("held".into(), reached_tx, proceed_rx));
        let request = {
            let ws = ws.clone();
            tokio::spawn(async move { ws.decide_task_proposal("held", confirm("c1", "review", version)).await })
        };
        // The decision is inside task_update's job: its attempt is stored as
        // pending, and the task is not changed yet.
        tokio::task::spawn_blocking(move || reached.recv()).await.unwrap().expect("the decision reached task_update");
        let stored: String = ws.store.db.read().unwrap()
            .query_row("SELECT state FROM result_task_actions WHERE result_id='held'", [], |r| r.get(0)).unwrap();
        assert_eq!((stored.as_str(), current(&ws, &task_id)["task"]["version"].as_i64()), ("pending", Some(version)));
        // The client goes away while task_update runs.
        request.abort();
        let _ = request.await;
        // A read now must wait for that decision, not settle it.
        let mut read = {
            let ws = ws.clone();
            tokio::spawn(async move { ws.task_proposal("held").await })
        };
        let early = tokio::time::timeout(std::time::Duration::from_millis(500), &mut read).await;
        let settled_early = early.as_ref().ok().map(|r| format!("{:?}", r.as_ref().map(|v| v.as_ref().map(|v| &v.attempts))));
        proceed.send(()).unwrap();
        assert_eq!(settled_early, None, "a read settled the decision while its task_update still ran");
        let shown = read.await.unwrap().unwrap();
        assert_eq!(shown.attempts.iter().map(|a| (a.state.as_str(), a.task_version)).collect::<Vec<_>>(), [("applied", Some(version + 1))]);
        let changed = current(&ws, &task_id)["task"].clone();
        assert_eq!((changed["status"].as_str(), changed["version"].as_i64()), (Some("review"), Some(version + 1)), "changed exactly once");
        // The same request again gets that answer; another confirmation changes nothing.
        let replay = ws.decide_task_proposal("held", confirm("c1", "review", version)).await.unwrap();
        assert_eq!(replay.attempts, shown.attempts);
        let again = ws.decide_task_proposal("held", confirm("c2", "blocked", version + 1)).await.unwrap();
        assert_eq!(again.attempts, shown.attempts);
        assert_eq!(current(&ws, &task_id)["task"]["version"].as_i64(), Some(version + 1));
    }

    #[tokio::test]
    async fn an_attempt_a_stop_of_core_interrupted_is_settled_from_the_tasks_own_receipt() {
        let (_dir, ws) = fixture();
        let (task_id, version) = task(&ws, "Slice", "doing");
        proposal(&ws, "r1", "r1", 1, "T-1", "review");
        proposal(&ws, "r2", "r2", 1, "T-1", "blocked");
        let pending = |result: &str, request: &str| {
            ws.store.db.write().unwrap().execute(
                "INSERT INTO result_task_actions(result_id,request_id,task_id,action,status,reason,expected_version,state,actor_json,created_at,updated_at)
                 VALUES(?1,?2,?3,'confirm','review',NULL,?4,'pending','{\"kind\":\"user\",\"id\":\"user\",\"name\":\"You\"}','now','now')",
                params![result, request, task_id, version]).unwrap();
        };
        // Stopped after task_update committed: applied.
        pending("r1", "c1");
        ws.store.collaboration_call(None, "task_update", json!({"requestId":domain_request("r1", "c1"),"taskId":task_id,
            "expectedVersion":version,"patch":{"status":"review"}})).unwrap();
        let settled = ws.task_proposal("r1").await.unwrap();
        assert_eq!((settled.attempts[0].state.as_str(), settled.attempts[0].task_version), ("applied", Some(version + 1)));
        // Stopped before: failed, and nothing changed.
        pending("r2", "c2");
        let settled = ws.task_proposal("r2").await.unwrap();
        assert_eq!(settled.attempts[0].state, "failed");
        assert!(settled.attempts[0].error.as_deref().unwrap().contains("nothing changed"));
        assert_eq!(current(&ws, &task_id)["task"]["version"].as_i64(), Some(version + 1));
    }

    #[test]
    fn publishing_a_proposal_needs_an_existing_task_with_another_status() {
        let (_dir, ws) = fixture();
        task(&ws, "Slice", "doing");
        let spec = |task: &str, status: &str| json!({"root":"r","elements":{"r":{"type":"Result","props":{"title":"t","summary":"s"},"children":["p"]},
            "p":{"type":"TaskStatus","props":{"taskId":task,"status":status,"reason":"why"}}}});
        let db = ws.store.db.read().unwrap();
        assert_eq!(publish_problems(&db, &spec("T-1", "review")).unwrap(), None);
        assert_eq!(publish_problems(&db, &spec("T-7", "review")).unwrap().unwrap()[0]["code"], "missing_task");
        let same = publish_problems(&db, &spec("T-1", "doing")).unwrap().unwrap();
        assert_eq!((same[0]["code"].as_str(), same[0]["path"].as_str()), (Some("no_change"), Some("elements.p.props.status")));
    }
}
