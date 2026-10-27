//! A Codex Agent's goal (T-29): Codex's own goal of the Agent's thread
//! (`thread/goal/get|set|clear`), as the Codex CLI's `/goal` shows and
//! changes it. It is that thread's native goal only: nothing here creates a
//! shared task, assigns work or reads anything but the Agent's connection.
//!
//! Reading starts nothing and changes nothing. A change is the user's own
//! (`origin: "user"`, which Codex records as the user's instruction). What
//! Codex 0.162.1 does with it (its goal runtime): an active goal, set or
//! resumed, starts a turn toward it when the thread is idle or is taken into
//! the running turn, which Codex's own events then show; pausing or clearing
//! only stops new work toward it and never interrupts the running turn.
//! Everything runs on the connection already serving
//! the thread: nothing is connected or resumed for it, and nothing is
//! retried. After an error or an unknown result, reading the goal again
//! shows what Codex has.
use crate::{model::ensure_agent_open, rpc::{Rpc, RpcError}, server::ApiError, workspace::{Connection, Workspace}};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{Path, State as ApiState},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

/// Codex's own limit on an objective (`MAX_THREAD_GOAL_OBJECTIVE_CHARS`).
pub const MAX_OBJECTIVE_CHARS: usize = 4_000;

/// The goal as the composer's Goal dialog reads it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// ready, unavailable, unsupported or failed.
    state: &'static str,
    reason: String,
    /// Codex's `ThreadGoal`, or null when the thread has none.
    goal: Value,
}

impl View {
    fn not(state: &'static str, reason: impl Into<String>) -> Self {
        Self { state, reason: reason.into(), goal: Value::Null }
    }
}

/// What the user asks of the goal, as Codex's CLI offers it.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum GoalChange {
    /// A new objective, active at once. Any goal there is cleared first, as
    /// Codex's CLI replaces one, so the new goal starts its own accounting;
    /// an unfinished one only when `replace` says the user confirmed it.
    Set { objective: String, #[serde(default)] replace: bool },
    Pause {},
    Resume {},
    Clear {},
}

/// Unfinished: Codex's CLI asks before replacing one of these.
fn unfinished(goal: &Value) -> bool {
    goal.is_object() && goal["status"] != "complete"
}

/// Why Codex did not answer with the goal, in the user's terms. Only a
/// Codex without the method provably did nothing.
fn failure(error: anyhow::Error, what: &str) -> anyhow::Error {
    match error.downcast_ref::<RpcError>() {
        Some(refused) if refused.code == -32601 => anyhow::anyhow!("这台机器上的 Codex 不提供原生目标（thread/goal）；{what}没有执行"),
        Some(refused) => anyhow::anyhow!("Codex 对{what}返回了错误：{}；请重新打开 /goal 查看目标的实际状态", refused.message),
        None => anyhow::anyhow!("{what}的结果无法确认：{error}；请重新打开 /goal 查看实际状态，不要重复"),
    }
}

async fn read(rpc: &Rpc, thread: &str) -> Result<Value> {
    let response = rpc.request("thread/goal/get", json!({"threadId":thread})).await?;
    ensure!(response.get("goal").is_some_and(|g| g.is_null() || g.is_object()), "Codex returned an invalid goal");
    Ok(response["goal"].clone())
}

async fn set(rpc: &Rpc, thread: &str, change: Value) -> Result<Value> {
    let mut params = json!({"threadId":thread,"origin":"user"});
    params.as_object_mut().unwrap().extend(change.as_object().unwrap().clone());
    let response = rpc.request("thread/goal/set", params).await?;
    ensure!(response["goal"].is_object(), "Codex returned an invalid goal");
    Ok(response["goal"].clone())
}

async fn clear(rpc: &Rpc, thread: &str) -> Result<bool> {
    let response = rpc.request("thread/goal/clear", json!({"threadId":thread,"origin":"user"})).await?;
    response["cleared"].as_bool().context("Codex returned an invalid answer")
}

impl GoalChange {
    /// The objective trimmed, within Codex's own limit.
    fn checked(self) -> Result<Self> {
        Ok(match self {
            Self::Set { objective, replace } => {
                let objective = objective.trim();
                ensure!(!objective.is_empty() && objective.chars().count() <= MAX_OBJECTIVE_CHARS,
                    "目标不能为空，也不能超过 {MAX_OBJECTIVE_CHARS} 个字符；目标没有改变");
                Self::Set { objective: objective.to_owned(), replace }
            }
            other => other,
        })
    }
}

impl Workspace {
    /// This Codex Agent's goal, read on its current connection only.
    pub async fn codex_goal(self: &Arc<Self>, id: &str) -> Result<View> {
        let agent = self.listed(id).await?;
        if agent.harness != "codex" {
            return Ok(View::not("unsupported", "harness"));
        }
        if agent.closed_at.is_some() {
            return Ok(View::not("unavailable", "closed"));
        }
        let Some(thread) = agent.thread_id.clone() else {
            return Ok(View::not("unavailable", "no_thread"));
        };
        let connection = self.rpcs.lock().unwrap().get(id).cloned().filter(|c| !c.closing && agent.connection_state == "connected");
        let Some(connection) = connection else {
            return Ok(View::not("unavailable", "not_connected"));
        };
        Ok(match read(&connection.rpc, &thread).await {
            Ok(goal) => View { state: "ready", reason: "read".into(), goal },
            Err(error) => match error.downcast_ref::<RpcError>() {
                Some(refused) if refused.code == -32601 => View::not("unsupported", "old_protocol"),
                Some(refused) => View::not("failed", refused.message.clone()),
                None => View::not("failed", error.to_string()),
            },
        })
    }

    /// The user's change to this Codex Agent's goal. An unconfirmed rewind
    /// refuses every change, as it does a message: Codex records each one in
    /// the thread's history, and a new or resumed goal may start a turn.
    /// One that may start Codex working (a new objective, resuming) also
    /// waits for an earlier unconfirmed send or control to be checked first;
    /// pausing and clearing stay possible then, as Codex keeps them.
    pub async fn codex_goal_change(self: &Arc<Self>, id: &str, change: GoalChange) -> Result<Value> {
        let change = change.checked()?;
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        self.ensure_rewind_settled(id).await?;
        let detail = self.send_view(id).await?;
        ensure_agent_open(&detail.agent)?;
        ensure!(detail.agent.harness == "codex", "目标是 Codex 会话的原生目标；这个 Agent 不是 Codex");
        let thread = detail.agent.thread_id.clone().context("会话 ID 尚未确认；目标没有改变")?;
        if matches!(change, GoalChange::Set { .. } | GoalChange::Resume {})
            && (detail.agent.status == "uncertain"
                || detail.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain"))) {
            bail!("上一次发送、执行、/compact 或 /review 的结果尚未确认；请先重新连接核对，目标没有改变");
        }
        let connection: Connection = self.rpcs.lock().unwrap().get(id).cloned()
            .filter(|c| !c.closing && detail.agent.connection_state == "connected")
            .context("没有连接到这个原生会话；请先重新连接，目标没有改变")?;
        ensure!(connection.attachment.lock().await.is_none() && !self.codex_context.needs_resume(id, connection.generation),
            "原生会话正在接续；完成后再改变目标");
        ensure!(self.rpcs.lock().unwrap().get(id).is_some_and(|c| c.generation == connection.generation && !c.closing),
            "连接已变化；目标没有改变");
        let rpc = &connection.rpc;
        match change {
            GoalChange::Set { objective, replace } => {
                let current = read(rpc, &thread).await.map_err(|e| failure(e, "读取当前目标"))?;
                ensure!(replace || !unfinished(&current), "这个会话已有未完成的目标；确认替换后再设定，目标没有改变");
                if current.is_object() {
                    clear(rpc, &thread).await.map_err(|e| failure(e, "替换目标（清除原目标）"))?;
                }
                let goal = set(rpc, &thread, json!({"objective":objective,"status":"active"})).await.map_err(|e| {
                    let what = if current.is_object() { "设定新目标（原目标已清除）" } else { "设定目标" };
                    failure(e, what)
                })?;
                Ok(json!({"goal":goal}))
            }
            GoalChange::Pause {} => Ok(json!({"goal":set(rpc, &thread, json!({"status":"paused"})).await.map_err(|e| failure(e, "暂停目标"))?})),
            GoalChange::Resume {} => Ok(json!({"goal":set(rpc, &thread, json!({"status":"active"})).await.map_err(|e| failure(e, "继续目标"))?})),
            GoalChange::Clear {} => {
                let cleared = clear(rpc, &thread).await.map_err(|e| failure(e, "清除目标"))?;
                Ok(json!({"goal":null,"cleared":cleared}))
            }
        }
    }
}

async fn read_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.codex_goal(&id).await?))
}

async fn change_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(change): Json<GoalChange>) -> Result<Json<Value>, ApiError> {
    Ok(Json(ws.codex_goal_change(&id, change).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/codex/goal", get(read_route).post(change_route))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_codexs_own_changes_are_read_and_an_objective_is_held_to_codexs_limit() {
        let read = |v: Value| serde_json::from_value::<GoalChange>(v);
        assert_eq!(read(json!({"action":"set","objective":"Ship it"})).unwrap(), GoalChange::Set { objective: "Ship it".into(), replace: false });
        assert_eq!(read(json!({"action":"pause"})).unwrap(), GoalChange::Pause {});
        for wrong in [json!({"action":"pause","status":"active"}), json!({"action":"set"}), json!({"action":"budget","tokenBudget":5}),
                      json!({"action":"clear","origin":"automatic"}), json!({"action":"set","objective":"x","status":"paused"})] {
            assert!(read(wrong.clone()).is_err(), "{wrong}");
        }
        let set = |objective: String| GoalChange::Set { objective, replace: false }.checked();
        assert_eq!(set("  Ship it\n".into()).unwrap(), GoalChange::Set { objective: "Ship it".into(), replace: false });
        assert!(set(" \n".into()).is_err());
        assert!(set("é".repeat(MAX_OBJECTIVE_CHARS)).is_ok(), "characters, not bytes, as Codex counts");
        assert!(set("x".repeat(MAX_OBJECTIVE_CHARS + 1)).is_err());
        assert!(unfinished(&json!({"status":"paused"})) && !unfinished(&json!({"status":"complete"})) && !unfinished(&Value::Null));
    }
}
