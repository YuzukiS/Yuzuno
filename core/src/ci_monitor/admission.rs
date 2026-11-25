//! Which new CI monitoring Core takes on (R-39): only what it monitors now
//! counts, never what it monitored before. Ended subscriptions and recorded
//! runs are history; they do not keep a new subscription or a new result out.
use crate::collaboration_store::{self as collaboration, TaskActor};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

/// The most live CI targets still waiting for something (YN-193: no run
/// yet on a current commit, or a run not finished), as before for all of
/// them, and the most live targets in all. Finished ones are read every
/// DONE_SECONDS, so 50 waiting at ACTIVE_SECONDS and 50 finished ask the
/// monitor about 10% more often than 50 waiting did.
pub(super) const WAITING_TARGETS: i64 = 50;
pub(super) const LIVE_TARGETS: i64 = 100;
/// The most subscriptions active at once: the 2000 Core has held subscriptions
/// to since monitoring began, counted over the active ones only (R-39). Before,
/// every subscription ever made counted, so a Workspace with none active could
/// refuse every new one.
pub(super) const ACTIVE_SUBSCRIPTIONS: i64 = 2000;

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS ci_subscriptions_active ON ci_subscriptions(active,expires);
        -- A target an Agent's task could not start monitoring for, said once
        -- on the task until a subscription to it is made (R-39).
        CREATE TABLE IF NOT EXISTS ci_refusals(task_id TEXT NOT NULL,watch_id TEXT NOT NULL,agent_id TEXT NOT NULL,
            reason TEXT NOT NULL,at TEXT NOT NULL,activity_seq INTEGER,PRIMARY KEY(task_id,watch_id,agent_id));",
    )?;
    Ok(())
}

/// Why watch `wid` cannot get this subscription now, or None when it can.
/// `renewing`: this Agent and task already have an active subscription to it,
/// which a new request renews and does not add to.
pub(super) fn refusal(db: &Connection, wid: &str, renewing: bool, now: i64) -> Result<Option<String>> {
    let live: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM ci_subscriptions WHERE watch_id=?1 AND active=1 AND expires>?2)",
        params![wid, now],
        |r| r.get(0),
    )?;
    if !live {
        // The live watches, and those of them still waiting for something:
        // a run not finished, or no run yet on a commit that is still
        // current (YN-193). A watch whose runs all finished, or an older PR
        // head with nothing of it still running, is read every five minutes.
        let (waiting, all): (i64, i64) = db.query_row(
            "SELECT COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM ci_watch_runs wr JOIN ci_runs r ON r.id=wr.run_id WHERE wr.watch_id=w.id
                   AND (json_extract(r.data,'$.rawStatus') IS NOT 'completed' OR json_type(r.data,'$.conclusion') IS NOT 'text'))
                 OR (NOT EXISTS(SELECT 1 FROM ci_watch_runs wr WHERE wr.watch_id=w.id) AND COALESCE(json_extract(w.data,'$.state'),'')<>'older_commit')),
               COUNT(*)
             FROM ci_watches w WHERE EXISTS(SELECT 1 FROM ci_subscriptions s WHERE s.watch_id=w.id AND s.active=1 AND s.expires>?1)",
            [now],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if waiting >= WAITING_TARGETS || all >= LIVE_TARGETS {
            return Ok(Some(format!(
                "At most {WAITING_TARGETS} distinct CI targets still waiting for a run to finish (now {waiting}), and {LIVE_TARGETS} in all \
                 (now {all}), can be monitored at once. A target whose runs all finished, or an older PR head with nothing of it \
                 still running, does not count toward the {WAITING_TARGETS}. ci_unsubscribe a subscription you no longer need."
            )));
        }
    }
    if renewing {
        return Ok(None);
    }
    let active: i64 = db.query_row(
        "SELECT COUNT(*) FROM ci_subscriptions WHERE active=1 AND expires>?1",
        [now],
        |r| r.get(0),
    )?;
    Ok((active >= ACTIVE_SUBSCRIPTIONS).then(|| {
        format!(
            "At most {ACTIVE_SUBSCRIPTIONS} CI subscriptions can be active at once (now {active}); ended ones do not count. \
             ci_unsubscribe a subscription you no longer need."
        )
    }))
}

/// What the task is told when Core refused to start monitoring `url` for
/// `agent`, in its own write after the refused one: once for this task,
/// target and Agent until a subscription to it is made, so a retry, a
/// delivery round's next try or a refresh does not say it again. Answers
/// whether it was said now.
pub(super) fn notice(
    db: &mut Connection,
    task: &str,
    wid: &str,
    agent: &TaskActor,
    url: &str,
    sha: &str,
    reason: &str,
) -> Result<bool> {
    let tx = db.transaction()?;
    let said: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM ci_refusals WHERE task_id=?1 AND watch_id=?2 AND agent_id=?3",
            params![task, wid, agent.id],
            |r| r.get(0),
        )
        .optional()?;
    if said.is_some() {
        return Ok(false);
    }
    let body = format!(
        "Core could not start CI monitoring of {url} at {sha} for {} on this task: {reason} No CI completion mail will come for it \
         until a subscription is made. Who takes over: {} follows this CI in its own session (github_refresh, then github_links or \
         ci_get for the run), or subscribes again with a new requestId once a monitored target has finished or been unsubscribed \
         (ci_list lists them). Said once for this target and Agent until a subscription to it is made.",
        agent.name, agent.name
    );
    let core = TaskActor { kind: "system".into(), id: "core".into(), name: "Yuzuno Core".into() };
    let activity = collaboration::activity(
        &tx,
        task,
        "comment",
        &core,
        &json!({"ciRefusal":{"watchId":wid,"agentId":agent.id}}),
        json!({"body": body}),
    )?;
    tx.execute(
        "INSERT INTO ci_refusals(task_id,watch_id,agent_id,reason,at,activity_seq) VALUES(?1,?2,?3,?4,?5,?6)",
        params![task, wid, agent.id, reason, crate::model::now(), activity["seq"].as_i64()],
    )?;
    tx.commit()?;
    Ok(true)
}

/// A subscription to `wid` was made: a later refusal is news again.
pub(super) fn admitted(db: &Connection, task: &str, wid: &str, agent: &str) -> Result<()> {
    db.execute(
        "DELETE FROM ci_refusals WHERE task_id=?1 AND watch_id=?2 AND agent_id=?3",
        params![task, wid, agent],
    )?;
    Ok(())
}
