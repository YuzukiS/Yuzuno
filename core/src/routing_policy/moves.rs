//! A started Claude executor moved off a claude-swap account that left its
//! pool, once it is idle (YN-138).
//!
//! At each slot pass, while routing is on: a Claude executor of this Core host,
//! connected and not disconnected by the user, whose route chose a pool
//! candidate and whose account has left it (left.rs `account_left`), is moved
//! when the readings, fresh and available, give another account of the pool
//! (`pick_other`). None to move to leaves it connected as it is.
//!
//! Each move runs in a task of its own, under a work permit: the pass never
//! waits for a restart, and a later pass leaves one being moved. The move takes
//! its gate only if it is free, then reads it again: no Turn running, request
//! shown, approval waited for, background task or sub-agent still able to
//! report, and its status idle or error. A gate another operation holds skips
//! it for this pass, which starts no move of it at all; the next pass tries
//! again. Only its detach and restart run within the Workspace's start time
//! limit, as a slot start does. Its bridge is detached as an update detaches
//! one (`detach_idle_claude`: the bridge confirms it is idle, its events are
//! drained, only this generation is closed) and started again
//! (`claude_ensure`), whose start moves its account
//! (routing_launch.rs `move_account`) and resumes its session there. A Turn
//! under way is never cut short: a later pass, at most a tick later, moves it
//! once it has ended. A start that fails, or a detach-and-restart the limit
//! cuts off, is the executor's failure, as a Reconnect's is.
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
    /// to another account of the pool, once it is idle (see the module's note):
    /// each in a task of its own, which this answers, for a caller that waits for
    /// them (tests). The pass never waits for a restart.
    pub(crate) async fn move_off_left_accounts(self: &Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        let mut moves = Vec::new();
        let read = self.stored(|store| Ok((store.routing_policy()?, store.routing_on_accounts(None)?))).await;
        let (stored, listed) = match read {
            Ok((stored, listed)) if stored.policy["enabled"] == true && !listed.is_empty() => (stored, listed),
            Ok(_) => return moves,
            Err(error) => {
                eprintln!("Routing: the executors on claude-swap accounts could not be read: {error:#}");
                return moves;
            }
        };
        let gathered = match self.routing_gathered().await {
            Ok(gathered) => Arc::new(gathered),
            Err(error) => {
                eprintln!("Routing: its readings could not be gathered, so no executor is moved to another account: {error:#}");
                return moves;
            }
        };
        // Only a fresh, available reading says another account has quota now:
        // without one, nothing is stopped for a move its start might refuse.
        let cswap = &gathered.cswap;
        if cswap.is_null() || cswap["stale"] == true || cswap.get("unavailable").is_some_and(|u| !u.is_null()) {
            return moves;
        }
        let policy = Arc::new(stored.policy);
        for on in listed {
            if !movable(&policy, &gathered, &on) {
                continue;
            }
            // While an update drains, none; one being moved already is left to its task.
            let Ok(permit) = self.admission.enter_work() else { break };
            if !self.executor_slots.moving.lock().unwrap().insert(on.agent.clone()) {
                continue;
            }
            moves.push(self.spawn_move(on.agent, permit, policy.clone(), gathered.clone()));
        }
        moves
    }

    /// One executor's move in a task of its own, under its work permit, its
    /// detach and restart within the Workspace's start time limit, as a slot
    /// start is (executor_slots.rs `start_and_settle`). A detach and restart
    /// cut off by the limit is its failure, shown to the user as a Reconnect's
    /// would be, and nothing else is done to it: a started executor is never
    /// closed for it.
    fn spawn_move(self: &Arc<Self>, id: String, permit: crate::updates::admission::Permit, policy: Arc<Value>, gathered: Arc<Gathered>)
        -> tokio::task::JoinHandle<()> {
        let ws = self.clone();
        tokio::spawn(async move {
            let limit = ws.start_limit().await.unwrap_or_else(|error| {
                eprintln!("Executor {id}: its start time limit could not be read, so the default holds: {error:#}");
                std::time::Duration::from_secs(crate::executor_slots::DEFAULT_START_LIMIT.unsigned_abs())
            });
            match ws.move_when_idle(&id, &policy, &gathered, limit).await {
                Ok(MoveEnd::Moved) => eprintln!("Routing: executor {id} was moved to another claude-swap account of its pool"),
                Ok(MoveEnd::NotIdle) => {}
                Ok(MoveEnd::CutOff(seconds)) => {
                    let why = anyhow::anyhow!("Its move to another claude-swap account of its pool did not finish within {seconds} s, \
                        so it was cut off: reconnect it / 它换到同一账号池里另一个 claude-swap 账号没有在 {seconds} 秒内完成，已中止：请重新连接它");
                    eprintln!("Routing: executor {id}: {why}");
                    ws.failed(&id, &why).await;
                }
                Err(error) => eprintln!("Routing: executor {id} could not be moved to another account: {error:#}"),
            }
            ws.executor_slots.moving.lock().unwrap().remove(&id);
            drop(permit);
        })
    }

    /// One executor's move if it is idle now: whether it was detached and
    /// started again. Its gate is taken only if it is free, so a gate another
    /// operation holds leaves it to a later pass, and only the detach and
    /// restart run within `limit`; a live executor is never marked failed for
    /// work it did not start.
    async fn move_when_idle(self: &Arc<Self>, id: &str, policy: &Value, gathered: &Gathered, limit: std::time::Duration) -> Result<MoveEnd> {
        let gate = self.gate(id).await;
        let Ok(_held) = gate.try_lock() else { return Ok(MoveEnd::NotIdle) };
        // Read again under its gate: its start, a Reconnect or another pass may have moved it.
        let agent = id.to_owned();
        let Some(on) = self.stored(move |store| Ok(store.routing_on_accounts(Some(&agent))?.pop())).await? else { return Ok(MoveEnd::NotIdle) };
        if !movable(policy, gathered, &on) {
            return Ok(MoveEnd::NotIdle);
        }
        let detail = self.disconnect_view(id).await?;
        let a = &detail.agent;
        let busy = crate::updates::lifecycle::blocked_activity(a, crate::store::Activity::of(&detail)).is_some()
            || !detail.pending.is_empty()
            || !matches!(a.status.as_str(), "idle" | "error")
            || detail.turns.iter().any(crate::disconnect::claude_task_running);
        if busy || a.remote.is_some() || a.disconnected_at.is_some() {
            return Ok(MoveEnd::NotIdle);
        }
        let Some(connection) = self.claudes.lock().unwrap().get(id).cloned() else { return Ok(MoveEnd::NotIdle) };
        if self.background_shells.claude_active(id, connection.generation).is_some_and(|count| count > 0) {
            return Ok(MoveEnd::NotIdle);
        }
        let restart = async {
            // The bridge confirms it is idle, or this is refused with the connection kept.
            match self.detach_idle_claude(id, &connection).await {
                Ok(()) => {}
                Err(why) => return Restart::Refused(why),
            }
            match self.claude_ensure(id).await {
                Ok(_) => Restart::Moved,
                Err(why) => Restart::Failed(why),
            }
        };
        match tokio::time::timeout(limit, restart).await {
            Ok(Restart::Moved) => Ok(MoveEnd::Moved),
            Ok(Restart::Refused(why)) => Err(why),
            Ok(Restart::Failed(why)) => {
                self.failed(id, &why).await;
                Err(why)
            }
            Err(_) => Ok(MoveEnd::CutOff(limit.as_secs())),
        }
    }
}

/// How one move ended: moved, left as it is now, or the start time limit cut
/// its detach and restart off.
enum MoveEnd {
    Moved,
    NotIdle,
    CutOff(u64),
}

/// How the bounded part of a move ended: started again, refused before the
/// detach (nothing is touched), or its start failed.
enum Restart {
    Moved,
    Refused(anyhow::Error),
    Failed(anyhow::Error),
}

#[cfg(test)]
#[path = "moves_tests.rs"]
mod tests;
