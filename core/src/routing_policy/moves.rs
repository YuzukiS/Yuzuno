//! A started Claude executor moved off a claude-swap account that left its
//! pool, once it is idle (YN-138).
//!
//! At each slot pass, while routing is on: a Claude executor of this Core host,
//! connected and not disconnected by the user, whose route chose a pool
//! candidate and whose account has left it (left.rs `account_left`), is moved
//! when the readings, fresh and available, give another account of the pool
//! (`pick_other`). None to move to leaves it connected as it is.
//!
//! The move waits for it to be idle: under a work permit and its gate, read
//! again, no Turn running, request shown, approval waited for, background task
//! or sub-agent still able to report, and its status idle or error. Then its
//! bridge is detached as an update detaches one (`detach_idle_claude`: the
//! bridge confirms it is idle, its events are drained, only this generation is
//! closed) and started again (`claude_ensure`), whose start moves its account
//! (routing_launch.rs `move_account`) and resumes its session there. A Turn
//! under way is never cut short: a later pass, at most a tick later, moves it
//! once it has ended. A start that fails is the executor's failure, as a
//! Reconnect's is.
use super::evaluate::{pick_other, Assume, Gathered};
use super::left::account_left;
use crate::{routing_launch::RuntimeProfile, store::Store, workspace::Workspace};
use anyhow::Result;
use chrono::Utc;
use serde_json::Value;
use std::sync::Arc;

/// A Claude executor on a claude-swap account: its id, account and route.
pub(crate) struct OnAccount {
    pub agent: String,
    pub fingerprint: String,
    pub route: Value,
}

impl Store {
    /// The routed executors with a claude-swap account that are connected on this
    /// Core host, open and not disconnected by the user; or the one `agent` names.
    pub(crate) fn routing_on_accounts(&self, agent: Option<&str>) -> Result<Vec<OnAccount>> {
        let db = self.db.read()?;
        let mut statement = db.prepare(
            "SELECT p.agent_id, p.profile, d.route_json, a.data
             FROM agent_runtime_profiles p JOIN executor_dispatches d ON d.agent_id=p.agent_id JOIN agents a ON a.id=p.agent_id
             WHERE d.route_json IS NOT NULL AND json_extract(p.profile,'$.kind')='claudeAccount' AND (?1 IS NULL OR p.agent_id=?1)")?;
        let rows = statement.query_map([agent], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::new();
        for (agent, profile, route, data) in rows {
            let (Ok(RuntimeProfile::ClaudeAccount { fingerprint }), Ok(route), Ok(data)) =
                (serde_json::from_str(&profile), serde_json::from_str::<Value>(&route), serde_json::from_str::<Value>(&data)) else { continue };
            let a = &data["agent"];
            if a["harness"] == "claude" && a["closedAt"].is_null() && a["remote"].is_null() && a["connectionState"] == "connected"
                && a["disconnectedAt"].is_null() {
                out.push(OnAccount { agent, fingerprint, route });
            }
        }
        Ok(out)
    }
}

/// The pool candidate `route` chose, when its account `fingerprint` has left
/// it and the readings give another account of it now.
fn movable(policy: &Value, gathered: &Gathered, on: &OnAccount) -> bool {
    let Some(chosen) = on.route["chosen"].as_str() else { return false };
    let Some(pool) = policy["candidates"].as_array().into_iter().flatten()
        .find(|c| c["id"] == chosen && c["credential"]["kind"] == "pool") else { return false };
    if account_left(policy, &on.route, &on.fingerprint, &gathered.cswap).is_none() {
        return false;
    }
    let assume = Assume::default();
    let inputs = gathered.inputs(Utc::now(), Some("local"), &[], Some("claude"), None, &assume);
    pick_other(pool, &inputs, &on.fingerprint).is_some()
}

impl Workspace {
    /// Moves each started Claude executor whose claude-swap account left its pool
    /// to another account of the pool, once it is idle (see the module's note).
    pub(crate) async fn move_off_left_accounts(self: &Arc<Self>) {
        let read = self.stored(|store| Ok((store.routing_policy()?, store.routing_on_accounts(None)?))).await;
        let (stored, listed) = match read {
            Ok((stored, listed)) if stored.policy["enabled"] == true && !listed.is_empty() => (stored, listed),
            Ok(_) => return,
            Err(error) => {
                eprintln!("Routing: the executors on claude-swap accounts could not be read: {error:#}");
                return;
            }
        };
        let gathered = match self.routing_gathered().await {
            Ok(gathered) => gathered,
            Err(error) => {
                eprintln!("Routing: its readings could not be gathered, so no executor is moved to another account: {error:#}");
                return;
            }
        };
        // Only a fresh, available reading says another account has quota now:
        // without one, nothing is stopped for a move its start might refuse.
        let cswap = &gathered.cswap;
        if cswap.is_null() || cswap["stale"] == true || cswap.get("unavailable").is_some_and(|u| !u.is_null()) {
            return;
        }
        for on in listed {
            if !movable(&stored.policy, &gathered, &on) {
                continue;
            }
            match self.move_when_idle(&on.agent, &stored.policy, &gathered).await {
                Ok(true) => eprintln!("Routing: executor {} was moved to another claude-swap account of its pool", on.agent),
                Ok(false) => {}
                Err(error) => eprintln!("Routing: executor {} could not be moved to another account: {error:#}", on.agent),
            }
        }
    }

    /// One executor's move, if it is idle now: whether it was detached and started again.
    async fn move_when_idle(self: &Arc<Self>, id: &str, policy: &Value, gathered: &Gathered) -> Result<bool> {
        // While an update drains, none.
        let Ok(_permit) = self.admission.enter_work() else { return Ok(false) };
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        // Read again under its gate: its start, a Reconnect or another pass may have moved it.
        let agent = id.to_owned();
        let Some(on) = self.stored(move |store| Ok(store.routing_on_accounts(Some(&agent))?.pop())).await? else { return Ok(false) };
        if !movable(policy, gathered, &on) {
            return Ok(false);
        }
        let detail = self.disconnect_view(id).await?;
        let a = &detail.agent;
        let busy = crate::updates::lifecycle::blocked_activity(a, crate::store::Activity::of(&detail)).is_some()
            || !detail.pending.is_empty()
            || !matches!(a.status.as_str(), "idle" | "error")
            || detail.turns.iter().any(crate::disconnect::claude_task_running);
        if busy || a.remote.is_some() || a.disconnected_at.is_some() {
            return Ok(false);
        }
        let Some(connection) = self.claudes.lock().unwrap().get(id).cloned() else { return Ok(false) };
        if self.background_shells.claude_active(id, connection.generation).is_some_and(|count| count > 0) {
            return Ok(false);
        }
        // The bridge confirms it is idle, or this is refused with the connection kept.
        self.detach_idle_claude(id, &connection).await?;
        match self.claude_ensure(id).await {
            Ok(_) => Ok(true),
            Err(error) => {
                self.failed(id, &error).await;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
#[path = "moves_tests.rs"]
mod tests;
