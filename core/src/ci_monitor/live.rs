//! Small, read-only Agent rail projection of existing monitoring facts.
//! Active subscriptions alone are not evidence of unfinished CI.
use crate::store::Store;
use anyhow::Result;
use serde_json::{Value, json};
use std::collections::BTreeMap;

// Normal monitoring checks active runs every 30s. A stalled monitor, cooldown,
// or lost response must not leave an old queued/running fact looking current.
const FRESH_SECONDS: i64 = 120;
// A newly subscribed target can legitimately precede Actions run discovery.
// After this grace period, show Check CI rather than waiting indefinitely.
const DISCOVERY_SECONDS: i64 = 600;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum State {
    Check,
    Discovering,
    /// A commit watch with no run yet, still monitored on schedule: waiting
    /// for a run to appear has no deadline and asks nothing of anyone.
    WaitingForRun,
    Running,
    Finished,
}
#[derive(Clone)]
struct Fact {
    attempt: u64,
    state: State,
    /// For WaitingForRun: the watch's last successful read.
    checked: Option<i64>,
}

fn epoch(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|t| t.timestamp())
}
fn fresh(v: &Value, now: i64) -> bool {
    epoch(v).is_some_and(|t| t <= now + 5 && now - t <= FRESH_SECONDS)
}

impl Store {
    pub(crate) fn live_ci_counts(&self) -> Result<Value> {
        self.live_ci_counts_at(chrono::Utc::now().timestamp())
    }

    fn live_ci_counts_at(&self, now: i64) -> Result<Value> {
        let db = self.db.read()?;
        // All live interests, not the paged list's newest subscriptions/runs.
        // agent_id is the durable notification recipient (including a user
        // explicitly subscribing for that Agent), never a task's assignee.
        let mut q = db.prepare(
            "SELECT s.agent_id,s.watch_id,MAX(i.data ->> '$.openedAt'),w.data,w.failures
          FROM ci_subscriptions s JOIN ci_interests i ON i.subscription_id=s.id
          JOIN ci_watches w ON w.id=s.watch_id JOIN collaboration_tasks t ON t.id=s.task_id
          WHERE s.active=1 AND s.expires>?1 AND i.active=1 AND i.expires>?1
          AND (w.data ->> '$.kind' IN ('run','commit') OR
            (t.data ->> '$.status' NOT IN ('done','cancelled') AND t.data ->> '$.archivedAt' IS NULL
             AND COALESCE(w.data ->> '$.currentPr.merged',0)=0
             AND COALESCE(w.data ->> '$.currentPr.state','') NOT IN ('merged','closed')))
          GROUP BY s.agent_id,s.watch_id",
        )?;
        let scopes = q
            .query_map([now], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut runs_by_watch: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut agents: BTreeMap<String, BTreeMap<String, Fact>> = BTreeMap::new();
        for (agent, wid, opened, raw, failures) in scopes {
            let w: Value = serde_json::from_str(&raw)?;
            if w["currentHeadSha"] != w["expectedSha"] || w["state"] == "older_commit" {
                continue;
            }
            if !runs_by_watch.contains_key(&wid) {
                // Project only small run facts, once per distinct live watch;
                // no job/step/log bodies or per-Agent remote requests.
                let mut q = db.prepare(
                    "SELECT json_object('id',r.data ->> '$.id','runId',r.data ->> '$.runId',
                    'repositoryId',r.data ->> '$.repositoryId','attempt',r.data ->> '$.attempt',
                    'headSha',r.data ->> '$.headSha','rawStatus',r.data ->> '$.rawStatus',
                    'conclusion',r.data ->> '$.conclusion','observedAt',r.data ->> '$.observedAt')
                    FROM ci_watch_runs wr JOIN ci_runs r ON r.id=wr.run_id WHERE wr.watch_id=?1",
                )?;
                let runs = q
                    .query_map([&wid], |r| r.get::<_, String>(0))?
                    .map(|r| Ok(serde_json::from_str(&r?)?))
                    .collect::<Result<Vec<Value>>>()?;
                runs_by_watch.insert(wid.clone(), runs);
            }
            let healthy = failures < 8
                && w["error"].is_null()
                && matches!(w["state"].as_str(), Some("watching" | "waiting_for_run"))
                && (fresh(&w["observedAt"], now)
                    || (w["observedAt"].is_null() && fresh(&json!(opened), now)));
            let mut facts: BTreeMap<String, Fact> = BTreeMap::new();
            for r in &runs_by_watch[&wid] {
                if r["headSha"] != w["expectedSha"] {
                    continue;
                }
                let key = format!("run:{}:{}", r["repositoryId"], r["runId"]);
                let attempt = r["attempt"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let state = if r["rawStatus"] == "completed" && r["conclusion"].is_string() {
                    State::Finished
                } else if healthy
                    && fresh(&r["observedAt"], now)
                    && matches!(
                        r["rawStatus"].as_str(),
                        Some("queued" | "in_progress" | "waiting" | "pending" | "requested")
                    )
                {
                    State::Running
                } else {
                    State::Check
                };
                merge(
                    &mut facts,
                    key,
                    Fact {
                        attempt,
                        state,
                        checked: None,
                    },
                );
            }
            if facts.is_empty() && w["kind"] == "commit" {
                // Healthy waiting for a commit's first run: its reads succeed
                // and are on schedule (the pace slows to ten minutes while no
                // run exists), so this is not stale and not a failure.
                let on_schedule = epoch(&w["observedAt"]).is_some_and(|at| at <= now + 5)
                    && epoch(&w["nextPollAt"]).is_some_and(|due| now <= due + FRESH_SECONDS);
                let waiting = failures < 8
                    && w["error"].is_null()
                    && w["truncated"] != true
                    && w["state"] == "waiting_for_run"
                    && (on_schedule || (w["observedAt"].is_null() && fresh(&json!(opened), now)));
                facts.insert(
                    format!("target:{wid}"),
                    Fact {
                        attempt: 0,
                        state: if waiting { State::WaitingForRun } else { State::Check },
                        checked: epoch(&w["observedAt"]),
                    },
                );
            } else if facts.is_empty() {
                let discovery = healthy
                    && w["truncated"] != true
                    && epoch(&json!(opened))
                        .is_some_and(|at| at <= now + 5 && now - at < DISCOVERY_SECONDS);
                facts.insert(
                    format!("target:{wid}"),
                    Fact {
                        attempt: 0,
                        state: if discovery {
                            State::Discovering
                        } else {
                            State::Check
                        },
                        checked: None,
                    },
                );
            } else if w["truncated"] == true {
                // Known runs are still useful, but a bounded/incomplete read
                // cannot establish that all workflows have finished.
                facts.insert(
                    format!("target:{wid}"),
                    Fact {
                        attempt: 0,
                        state: State::Check,
                        checked: None,
                    },
                );
            }
            let target = agents.entry(agent).or_default();
            for (key, fact) in facts {
                merge(target, key, fact);
            }
        }
        let mut result = serde_json::Map::new();
        for (id, facts) in agents {
            let count = |state| facts.values().filter(|f| f.state == state).count();
            let (running, discovering, waiting, check) = (
                count(State::Running),
                count(State::Discovering),
                count(State::WaitingForRun),
                count(State::Check),
            );
            // The oldest last successful read among the commits waiting for
            // their first run: "still monitored, last checked".
            let checked = facts
                .values()
                .filter(|f| f.state == State::WaitingForRun)
                .filter_map(|f| f.checked)
                .min()
                .map(super::stamp);
            if running + discovering + waiting + check > 0 {
                let mut counts = json!({"running":running,"discovering":discovering,"check":check});
                // Only when there is one, so older readers see what they did.
                if waiting > 0 {
                    counts["waitingForRun"] = json!(waiting);
                    counts["waitingCheckedAt"] = json!(checked);
                }
                result.insert(id, counts);
            }
        }
        Ok(json!({"agents":result}))
    }
}

// One actual run across tasks, watches, and attempts. A newer attempt replaces
// any previous unfinished attempt; a shared fresh observation wins over a
// broken watch of that same attempt. Terminal facts retire the whole run.
fn merge(target: &mut BTreeMap<String, Fact>, key: String, value: Fact) {
    let old = target.entry(key).or_insert_with(|| value.clone());
    if value.attempt > old.attempt || (value.attempt == old.attempt && value.state > old.state) {
        *old = value;
    }
}

#[cfg(test)]
#[path = "live_tests.rs"]
mod tests;
