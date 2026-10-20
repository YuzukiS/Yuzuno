use super::{ACTIVE_SECONDS, DONE_SECONDS, Observed, Subscribe};
use crate::{
    collaboration_store as collaboration, github::client::Repository, model::now, store::Store,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

// Monitoring is current local state, separate from GitHub's last run fact.
// Match any subscriber: another Agent can still be keeping this run fresh.
const RUN_WATCHED: &str = "EXISTS(SELECT 1 FROM ci_watch_runs wr JOIN ci_watches cw ON cw.id=wr.watch_id JOIN ci_subscriptions cs ON cs.watch_id=cw.id WHERE wr.run_id=r.id AND cw.failures<8 AND cs.active=1 AND cs.expires>strftime('%s','now'))";

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS ci_watches(id TEXT PRIMARY KEY, next_poll INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ci_subscriptions(id TEXT PRIMARY KEY,watch_id TEXT NOT NULL REFERENCES ci_watches(id),agent_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),active INTEGER NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(watch_id,agent_id,task_id));
        CREATE INDEX IF NOT EXISTS ci_subscriptions_scope ON ci_subscriptions(agent_id,task_id,active);
        CREATE INDEX IF NOT EXISTS ci_subscriptions_watch ON ci_subscriptions(watch_id,active,expires);
        CREATE INDEX IF NOT EXISTS ci_watches_due ON ci_watches(next_poll);
        CREATE TABLE IF NOT EXISTS ci_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ci_watch_runs(watch_id TEXT NOT NULL REFERENCES ci_watches(id),run_id TEXT NOT NULL REFERENCES ci_runs(id),PRIMARY KEY(watch_id,run_id));
        CREATE TABLE IF NOT EXISTS ci_notifications(subscription_id TEXT NOT NULL REFERENCES ci_subscriptions(id),run_id TEXT NOT NULL REFERENCES ci_runs(id),message_id TEXT NOT NULL,PRIMARY KEY(subscription_id,run_id));
        CREATE TABLE IF NOT EXISTS ci_cache(endpoint TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ci_control(id INTEGER PRIMARY KEY CHECK(id=1),cooldown INTEGER NOT NULL);")?;
    super::lifecycle::migrate(db)?;
    Ok(())
}
fn cooldown(db: &Connection) -> Result<i64> {
    Ok(db
        .query_row("SELECT cooldown FROM ci_control WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or(0))
}
fn actor_key(actor: Option<&str>) -> String {
    actor
        .map(|s| format!("agent:{s}"))
        .unwrap_or_else(|| "user".into())
}
fn watch(db: &Connection, id: &str) -> Result<Value> {
    let raw: String = db
        .query_row("SELECT data FROM ci_watches WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .context("CI watch not found")?;
    Ok(serde_json::from_str(&raw)?)
}
fn subscription(db: &Connection, id: &str) -> Result<Value> {
    let (raw, active, expires): (String, bool, i64) = db
        .query_row(
            "SELECT data,active,expires FROM ci_subscriptions WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .context("CI subscription not found")?;
    let mut v: Value = serde_json::from_str(&raw)?;
    v["active"] = json!(active && expires > chrono::Utc::now().timestamp());
    v["interests"] = super::lifecycle::interests(db, id)?;
    v["watch"] = watch(db, v["watchId"].as_str().unwrap())?;
    Ok(v)
}
fn previous(db: &Connection, actor: Option<&str>, input: &Subscribe) -> Result<Option<Value>> {
    let row: Option<(String,String)> = db.query_row("SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation='ci_subscribe' AND request_id=?2",params![actor_key(actor),input.request_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((old, response)) = row else {
        return Ok(None);
    };
    ensure!(
        serde_json::from_str::<Value>(&old)? == serde_json::to_value(input)?,
        "idempotency_conflict: requestId already names a different CI subscription"
    );
    let response: Value = serde_json::from_str(&response)?;
    Ok(Some(subscription(
        db,
        response["subscriptionId"]
            .as_str()
            .context("Invalid CI receipt")?,
    )?))
}
/// While a commit watch has no run yet: every 30 s for ten minutes after it
/// was created or last asked for (a new request renews it), then every two
/// minutes, and after an hour every ten minutes, so a commit no workflow runs
/// for is not read at the active pace for days.
fn waiting_seconds(db: &Connection, w: &Value) -> Result<i64> {
    let newest: Option<String> = db.query_row(
        "SELECT MAX(json_extract(i.data,'$.openedAt')) FROM ci_interests i JOIN ci_subscriptions s ON s.id=i.subscription_id WHERE s.watch_id=?1 AND i.active=1",
        [w["id"].as_str()],
        |r| r.get(0),
    )?;
    let at = |v: Option<&str>| {
        v.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp())
    };
    let since = at(w["createdAt"].as_str()).max(at(newest.as_deref()));
    let age = since.map_or(0, |t| chrono::Utc::now().timestamp() - t);
    Ok(match age {
        ..600 => ACTIVE_SECONDS,
        600..3600 => 120,
        _ => 600,
    })
}
fn notify(db: &Connection, watch_id: &str) -> Result<bool> {
    let mut q = db.prepare("SELECT s.id,s.data,r.id,r.data FROM ci_subscriptions s JOIN ci_watch_runs w ON w.watch_id=s.watch_id JOIN ci_runs r ON r.id=w.run_id LEFT JOIN ci_notifications n ON n.subscription_id=s.id AND n.run_id=r.id WHERE s.watch_id=?1 AND s.active=1 AND s.expires>?2 AND EXISTS(SELECT 1 FROM ci_watches cw WHERE cw.id=s.watch_id AND cw.failures<8) AND json_extract(r.data,'$.rawStatus')='completed' AND json_type(r.data,'$.conclusion')='text' AND n.message_id IS NULL LIMIT 100")?;
    let rows = q
        .query_map(params![watch_id, chrono::Utc::now().timestamp()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let sent = !rows.is_empty();
    let w = watch(db, watch_id)?;
    for (sid, sub, rid, raw) in rows {
        let sub: Value = serde_json::from_str(&sub)?;
        let run: Value = serde_json::from_str(&raw)?;
        let id = uuid::Uuid::new_v4().to_string();
        let label = if w["kind"] == "pull" {
            format!(
                "PR #{} · {}",
                w["number"],
                run["name"].as_str().unwrap_or("Workflow")
            )
        } else if w["kind"] == "commit" {
            format!(
                "{} {} · {}",
                w["branch"].as_str().unwrap_or(""),
                w["event"].as_str().unwrap_or(""),
                run["name"].as_str().unwrap_or("Workflow")
            )
        } else {
            run["name"].as_str().unwrap_or("Workflow").to_owned()
        };
        let body = format!(
            "GitHub Actions {label}: {} ({}). Run {}, attempt {}, commit {}. Watched commit {} for {}. {} Read ci_get(runKey={rid}) for jobs/steps and native logs/artifacts links. This result does not mean PR merge, review approval, or task completion.",
            run["status"].as_str().unwrap_or("unknown"),
            run["conclusion"].as_str().unwrap_or("unknown conclusion"),
            run["runId"].as_str().unwrap(),
            run["attempt"].as_str().unwrap(),
            run["headSha"].as_str().unwrap(),
            w["expectedSha"].as_str().unwrap(),
            sub["taskRef"].as_str().unwrap(),
            run["url"].as_str().unwrap()
        );
        collaboration::insert_message(
            db,
            json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},"recipient":sub["agent"],"body":body,"taskId":sub["taskId"],"replyTo":null,"threadId":id,"createdAt":now(),"source":{"ciRunKey":rid,"subscriptionId":sid},"priority":"normal","metadata":{"kind":"ci","name":label,"status":run["status"],"repositoryId":run["repositoryId"],"runId":run["runId"],"attempt":run["attempt"],"headSha":run["headSha"],"expectedSha":w["expectedSha"],"prNumber":if w["kind"]=="pull"{w["number"].clone()}else{Value::Null},"branch":w["branch"],"event":w["event"],"taskId":sub["taskId"],"conclusion":run["conclusion"],"url":run["url"]}}),
        )?;
        db.execute(
            "INSERT INTO ci_notifications(subscription_id,run_id,message_id) VALUES(?1,?2,?3)",
            params![sid, rid, id],
        )?;
    }
    Ok(sent)
}

impl Store {
    /// Bounded recovery of committed terminal facts lacking notification receipts.
    /// This also drains large first-subscription batches without holding one huge
    /// mailbox transaction. It runs independently of the next remote poll time.
    pub(super) fn ci_flush_notifications(&self) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let before = tx.total_changes();
        let id: Option<String> = tx.query_row("SELECT s.watch_id FROM ci_subscriptions s JOIN ci_watch_runs w ON w.watch_id=s.watch_id JOIN ci_runs r ON r.id=w.run_id WHERE s.active=1 AND s.expires>?1 AND EXISTS(SELECT 1 FROM ci_watches cw WHERE cw.id=s.watch_id AND cw.failures<8) AND json_extract(r.data,'$.rawStatus')='completed' AND json_type(r.data,'$.conclusion')='text' AND NOT EXISTS(SELECT 1 FROM ci_notifications n WHERE n.subscription_id=s.id AND n.run_id=r.id) LIMIT 1", [chrono::Utc::now().timestamp()], |r| r.get(0)).optional()?;
        let sent = if let Some(id) = id {
            notify(&tx, &id)?
        } else {
            false
        };
        // Also recover lifecycle cleanup after a restart, even with no due run.
        super::lifecycle::reconcile(&tx, None)?;
        let changed = tx.total_changes() > before;
        tx.commit()?;
        Ok(sent || changed)
    }
    pub(super) fn ci_previous(
        &self,
        actor: Option<&str>,
        input: &Subscribe,
    ) -> Result<Option<Value>> {
        let db = self.db.read()?;
        collaboration::actor_context(self, &db, actor)?;
        previous(&db, actor, input)
    }
    pub(crate) fn ci_subscribe(
        &self,
        actor: Option<&str>,
        input: Subscribe,
        repo: Repository,
        kind: &str,
        number: u64,
    ) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        if let Some(v) = previous(&tx, actor, &input)? {
            return Ok(v);
        }
        // Reclaim terminal interests before applying the distinct-watch cap.
        super::lifecycle::reconcile(&tx, None)?;
        let (_, source) = collaboration::actor_context(self, &tx, actor)?;
        let agent_id = actor
            .or(input.agent_id.as_deref())
            .context("Choose an Agent to receive CI results")?;
        ensure!(
            actor.is_none() || input.agent_id.as_deref().is_none_or(|id| id == agent_id),
            "An Agent can subscribe only for itself"
        );
        let agent = self
            .brief_in(&tx, agent_id)?
            .context("Agent not found")?
            .agent;
        ensure!(
            agent.closed_at.is_none() && agent.remote.is_none(),
            "Choose an open local Agent"
        );
        let recipient = collaboration::agent_actor(self, &tx, agent_id)?;
        let (task, seq) = collaboration::task_key(&tx, &input.task_id)?;
        let archived: Option<String> = tx.query_row(
            "SELECT json_extract(data,'$.archivedAt') FROM collaboration_tasks WHERE id=?1",
            [&task],
            |r| r.get(0),
        )?;
        ensure!(
            archived.is_none(),
            "Archived tasks cannot accept new CI subscriptions"
        );
        let owner = super::lifecycle::owner(&tx, actor, &task, &input, true)?;
        let closed: bool = tx.query_row("SELECT json_extract(data,'$.status') IN ('done','cancelled') FROM collaboration_tasks WHERE id=?1", [&task], |r| r.get(0))?;
        ensure!(
            !closed || kind != "pull",
            "Reopen the task to watch a PR candidate; a specific run or commit may still be subscribed for post-merge verification"
        );
        let active: i64 = tx.query_row(
            "SELECT COUNT(DISTINCT watch_id) FROM ci_subscriptions WHERE active=1 AND expires>?1",
            [chrono::Utc::now().timestamp()],
            |r| r.get(0),
        )?;
        // A commit watch is its exact target: commit, branch and event.
        let wid = if kind == "commit" {
            format!(
                "{}:commit:{}:{}:{}",
                repo.id,
                input.event.as_deref().context("Missing event")?,
                input.branch.as_deref().context("Missing branch")?,
                input.expected_sha
            )
        } else {
            format!("{}:{kind}:{number}:{}", repo.id, input.expected_sha)
        };
        let existing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ci_subscriptions WHERE watch_id=?1 AND active=1 AND expires>?2)",params![wid,chrono::Utc::now().timestamp()],|r|r.get(0))?;
        ensure!(
            existing || active < 50,
            "At most 50 distinct CI targets can be monitored at once"
        );
        let mut w = json!({"id":wid,"repositoryId":repo.id,"repository":repo.full_name,"kind":kind,"number":number,"url":input.url,"expectedSha":input.expected_sha,"currentHeadSha":input.expected_sha,"state":"watching","error":null,"observedAt":null,"lastAttemptAt":null,"createdAt":now()});
        if kind == "commit" {
            w["branch"] = json!(input.branch);
            w["event"] = json!(input.event);
            w["state"] = json!("waiting_for_run");
            w["excludedRuns"] = json!(0);
        }
        tx.execute("INSERT INTO ci_watches(id,next_poll,data) VALUES(?1,0,?2) ON CONFLICT(id) DO UPDATE SET next_poll=MIN(next_poll,?3),failures=0",params![wid,w.to_string(),chrono::Utc::now().timestamp()+30])?;
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM ci_subscriptions WHERE watch_id=?1 AND agent_id=?2 AND task_id=?3",
                params![wid, agent_id, task],
                |r| r.get(0),
            )
            .optional()?;
        if id.is_none() {
            let count: i64 =
                tx.query_row("SELECT COUNT(*) FROM ci_subscriptions", [], |r| r.get(0))?;
            ensure!(count < 2000, "CI subscription history limit reached (2000)");
        }
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let expires = chrono::Utc::now() + chrono::Duration::days(7);
        let sub = json!({"id":id,"watchId":wid,"agentId":agent_id,"agent":recipient,"taskId":task,"taskRef":format!("T-{seq}"),"source":source,"createdAt":now(),"expiresAt":expires.to_rfc3339(),"active":true});
        tx.execute("INSERT INTO ci_subscriptions(id,watch_id,agent_id,task_id,active,expires,data) VALUES(?1,?2,?3,?4,1,?5,?6) ON CONFLICT(id) DO UPDATE SET active=1,expires=excluded.expires,data=excluded.data",params![id,wid,agent_id,task,expires.timestamp(),sub.to_string()])?;
        tx.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'ci_subscribe',?2,?3,?4)",params![actor_key(actor),input.request_id,serde_json::to_string(&input)?,json!({"subscriptionId":id}).to_string()])?;
        super::lifecycle::register(
            &tx,
            &id,
            &owner,
            &actor_key(actor),
            &input.request_id,
            expires.timestamp(),
        )?;
        // Existing facts are shared; a new subscriber still receives its terminal result once.
        notify(&tx, &wid)?;
        let result = subscription(&tx, &id)?;
        tx.commit()?;
        Ok(result)
    }
    pub(crate) fn ci_unsubscribe(&self, actor: Option<&str>, id: &str) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let sub = subscription(&tx, id)?;
        ensure!(
            actor.is_none_or(|a| sub["agentId"] == a),
            "An Agent can stop only its own subscription"
        );
        super::lifecycle::backfill(&tx)?;
        super::lifecycle::stop_subscription(&tx, id)?;
        let sub = subscription(&tx, id)?;
        tx.commit()?;
        Ok(sub)
    }
    pub(crate) fn ci_list(
        &self,
        agent: Option<&str>,
        task: Option<&str>,
        before: Option<i64>,
    ) -> Result<Value> {
        let db = self.db.read()?;
        let task = task
            .map(|t| collaboration::task_key(&db, t).map(|v| v.0))
            .transpose()?;
        let mut q=db.prepare("SELECT id FROM ci_subscriptions WHERE (?1 IS NULL OR agent_id=?1) AND (?2 IS NULL OR task_id=?2) ORDER BY rowid DESC LIMIT 201")?;
        let ids = q
            .query_map(params![agent, task], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let more = ids.len() > 200;
        let subscriptions = ids
            .iter()
            .take(200)
            .map(|id| subscription(&db, id))
            .collect::<Result<Vec<_>>>()?;
        // How many in scope are active, listed or not: the list holds the
        // newest 200, so a reader can tell whether every active one is on it.
        let active: i64 = db.query_row(
            "SELECT COUNT(*) FROM ci_subscriptions WHERE (?1 IS NULL OR agent_id=?1) AND (?2 IS NULL OR task_id=?2) AND active=1 AND expires>?3",
            params![agent, task, chrono::Utc::now().timestamp()],
            |r| r.get(0),
        )?;
        let mut q=db.prepare(&format!("SELECT DISTINCT r.seq,r.data,{RUN_WATCHED} FROM ci_runs r JOIN ci_watch_runs w ON w.run_id=r.id JOIN ci_subscriptions s ON s.watch_id=w.watch_id WHERE (?1 IS NULL OR s.agent_id=?1) AND (?2 IS NULL OR s.task_id=?2) AND (?3 IS NULL OR r.seq<?3) ORDER BY r.seq DESC LIMIT 51"))?;
        let mut runs = q
            .query_map(params![agent, task, before], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            })?
            .map(|row| {
                let (seq, raw, watched) = row?;
                let mut v: Value = serde_json::from_str(&raw)?;
                v["cursor"] = json!(seq);
                v["runWatched"] = json!(watched);
                Ok(v)
            })
            .collect::<Result<Vec<_>>>()?;
        let has_more = runs.len() > 50;
        runs.truncate(50);
        let cooldown = cooldown(&db)?;
        let cooldown = (cooldown > chrono::Utc::now().timestamp()).then(|| super::stamp(cooldown));
        Ok(
            json!({"nextBefore":if has_more{runs.last().map(|v|v["cursor"].clone())}else{None},"runs":runs,"hasMore":has_more,"subscriptions":subscriptions,"subscriptionsTruncated":more,"activeSubscriptionCount":active,"cooldownUntil":cooldown,"source":"github_actions"}),
        )
    }
    /// The watches a manual refresh may check, most overdue first: those
    /// behind `run` (whoever subscribed), or else those behind the view. A
    /// stopped or expired subscription is not renewed and a watch paused after
    /// repeated failures is not resumed; both are only counted.
    pub(super) fn ci_refresh_targets(
        &self,
        agent: Option<&str>,
        task: Option<&str>,
        run: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        let db = self.db.read()?;
        let task = task
            .map(|t| collaboration::task_key(&db, t).map(|v| v.0))
            .transpose()?;
        if let Some(run) = run {
            db.query_row("SELECT 1 FROM ci_runs WHERE id=?1", [run], |_| Ok(()))
                .optional()?
                .context("Actions run not found; subscribe to its PR or run first")?;
        }
        let mut q = db.prepare("SELECT w.id,w.failures,?1 IS NOT NULL AS linked FROM ci_watches w WHERE (?1 IS NULL OR EXISTS(SELECT 1 FROM ci_watch_runs r WHERE r.watch_id=w.id AND r.run_id=?1)) AND EXISTS(SELECT 1 FROM ci_subscriptions s WHERE s.watch_id=w.id AND s.active=1 AND s.expires>?2 AND (?1 IS NOT NULL OR ((?3 IS NULL OR s.agent_id=?3) AND (?4 IS NULL OR s.task_id=?4)))) ORDER BY w.next_poll,w.id")?;
        let rows = q
            .query_map(
                params![run, chrono::Utc::now().timestamp(), agent, task],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, bool>(2)?,
                    ))
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let paused = rows.iter().filter(|r| r.1 >= 8).count();
        let mut watches = Vec::new();
        for (id, _, linked) in rows.iter().filter(|r| r.1 < 8).take(limit) {
            let mut w = watch(&db, id)?;
            w["linked"] = json!(linked);
            watches.push(w);
        }
        let more = rows.len() - paused - watches.len();
        let run_watched = run.map(|_| watches.iter().any(|w| w["linked"] == true));
        Ok(json!({"watches":watches,"paused":paused,"more":more,"runWatched":run_watched}))
    }
    pub(super) fn ci_run(&self, id: &str) -> Result<Value> {
        let db = self.db.read()?;
        let (raw, watched): (String, bool) = db
            .query_row(
                &format!("SELECT r.data,{RUN_WATCHED} FROM ci_runs r WHERE r.id=?1"),
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .context("Actions run not found; subscribe to its PR or run first")?;
        let mut run: Value = serde_json::from_str(&raw)?;
        run["runWatched"] = json!(watched);
        Ok(run)
    }
    /// A manual one-off read must not create runs, link watches, reset failure
    /// counts, reschedule, renew subscriptions or emit completion mail.
    pub(super) fn ci_refresh_run(&self, run: Value) -> Result<bool> {
        let db = self.db.write()?;
        let id = run["id"].as_str().context("Missing run key")?;
        let raw: String =
            db.query_row("SELECT data FROM ci_runs WHERE id=?1", [id], |r| r.get(0))?;
        let old: Value = serde_json::from_str(&raw)?;
        ensure!(
            ["id", "repositoryId", "runId", "attempt", "headSha"]
                .into_iter()
                .all(|field| old[field] == run[field]),
            "Historical attempt identity or commit changed"
        );
        // Another observation (for example the former watch's list endpoint)
        // can be newer than this exact endpoint's shared conditional cache.
        let at = |v: &Value| {
            v["observedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.timestamp())
        };
        if at(&old) > at(&run)
            || (at(&old) == at(&run)
                && old["rawStatus"] == "completed"
                && run["rawStatus"] != "completed")
        {
            return Ok(false);
        }
        let changed =
            old["rawStatus"] != run["rawStatus"] || old["conclusion"] != run["conclusion"];
        db.execute(
            "UPDATE ci_runs SET data=?2 WHERE id=?1",
            params![id, run.to_string()],
        )?;
        Ok(changed)
    }
    /// When the next watch is due, no sooner than the shared cooldown ends.
    pub(super) fn ci_next_due(&self) -> Result<Option<i64>> {
        let db = self.db.read()?;
        let due: Option<i64> = db.query_row("SELECT MIN(next_poll) FROM ci_watches w WHERE failures<8 AND EXISTS(SELECT 1 FROM ci_subscriptions s WHERE s.watch_id=w.id AND s.active=1 AND s.expires>?1)", [chrono::Utc::now().timestamp()], |r| r.get(0))?;
        let cooldown = cooldown(&db)?;
        Ok(due.map(|due| due.max(cooldown)))
    }
    pub(super) fn ci_cooldown_until(&self) -> Result<i64> {
        let db = self.db.read()?;
        cooldown(&db)
    }
    pub(super) fn ci_due(&self) -> Result<Option<Value>> {
        let db = self.db.write()?;
        let epoch = chrono::Utc::now().timestamp();
        if cooldown(&db)? > epoch {
            return Ok(None);
        }
        let id:Option<String>=db.query_row("SELECT id FROM ci_watches w WHERE next_poll<=?1 AND failures<8 AND EXISTS(SELECT 1 FROM ci_subscriptions s WHERE s.watch_id=w.id AND s.active=1 AND s.expires>?1) ORDER BY next_poll,id LIMIT 1",[epoch],|r|r.get(0)).optional()?;
        let Some(id) = id else { return Ok(None) };
        db.execute(
            "UPDATE ci_watches SET next_poll=?2 WHERE id=?1",
            params![id, epoch + 60],
        )?;
        Ok(Some(watch(&db, &id)?))
    }
    pub(crate) fn ci_observe(&self, id: &str, result: Result<Observed, String>) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut w = watch(&tx, id)?;
        let mut failures: i64 =
            tx.query_row("SELECT failures FROM ci_watches WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        w["lastAttemptAt"] = json!(now());
        let delay = match result {
            Ok(Observed {
                runs,
                head,
                pr,
                truncated,
                checked,
                excluded,
                ..
            }) => {
                ensure!(runs.len() <= 1010, "CI run observation exceeded its bound");
                // Whether this observation saw anything new: a run or attempt
                // not seen before, or a changed status or conclusion.
                let mut changed = false;
                let mut count: i64 =
                    tx.query_row("SELECT COUNT(*) FROM ci_runs", [], |r| r.get(0))?;
                for run in &runs {
                    ensure!(
                        run["repositoryId"] == w["repositoryId"]
                            && run["headSha"] == w["expectedSha"]
                            && (w["kind"] != "commit"
                                || (run["branch"] == w["branch"] && run["event"] == w["event"])),
                        "CI observation does not match watched repository/commit"
                    );
                    let rid = run["id"].as_str().context("Missing run key")?;
                    let previous: Option<String> = tx
                        .query_row("SELECT data FROM ci_runs WHERE id=?1", [rid], |r| r.get(0))
                        .optional()?;
                    let exists = previous.is_some();
                    ensure!(
                        exists || count < 10000,
                        "CI history limit reached (10000 attempts); last observations retained"
                    );
                    if !exists {
                        count += 1;
                        changed = true;
                    }
                    if let Some(previous) = previous {
                        let previous: Value = serde_json::from_str(&previous)?;
                        if previous["rawStatus"] != run["rawStatus"]
                            || previous["conclusion"] != run["conclusion"]
                        {
                            changed = true;
                            // A visible detail refresh must revalidate the old jobs snapshot
                            // when its run changes state. Keep the body and ETag for 304.
                            let prefix = format!(
                                "repos/{}/actions/runs/{}/attempts/{}/jobs?",
                                run["repository"].as_str().unwrap(),
                                run["runId"].as_str().unwrap(),
                                run["attempt"].as_str().unwrap()
                            );
                            tx.execute("UPDATE ci_cache SET data=json_set(data,'$.fetchedAt',0) WHERE substr(endpoint,1,length(?1))=?1", [prefix])?;
                        }
                    }
                    tx.execute("INSERT INTO ci_runs(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![rid,run.to_string()])?;
                    tx.execute(
                        "INSERT OR IGNORE INTO ci_watch_runs(watch_id,run_id) VALUES(?1,?2)",
                        params![id, rid],
                    )?;
                }
                w["currentPr"] = json!(pr);
                if let Some(head) = head {
                    w["currentHeadSha"] = json!(head);
                }
                // A commit watch says whether any of its runs exists yet.
                let linked: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM ci_watch_runs WHERE watch_id=?1",
                    [id],
                    |r| r.get(0),
                )?;
                w["state"] = json!(if w["currentHeadSha"] != w["expectedSha"] {
                    "older_commit"
                } else if w["kind"] == "commit" && linked == 0 {
                    "waiting_for_run"
                } else {
                    "watching"
                });
                if w["kind"] == "commit" {
                    w["excludedRuns"] = json!(excluded);
                    // The quiet window behind a verification: since when
                    // complete, successful observations have seen nothing
                    // new. A change, a recovery after failed reads or a cut
                    // list starts it again.
                    if truncated {
                        w["quietSince"] = Value::Null;
                    } else if changed || failures > 0 || w["quietSince"].is_null() {
                        w["quietSince"] = json!(super::stamp(checked));
                    }
                }
                // When GitHub answered, not when this was written down.
                w["observedAt"] = json!(super::stamp(checked));
                w["error"] = Value::Null;
                w["truncated"] = json!(truncated);
                failures = 0;
                if w["state"] == "waiting_for_run" {
                    waiting_seconds(&tx, &w)?
                } else if !runs.is_empty() && runs.iter().all(|r| r["rawStatus"] == "completed") {
                    DONE_SECONDS
                } else {
                    ACTIVE_SECONDS
                }
            }
            Err(error) => {
                failures += 1;
                if w["kind"] == "commit" {
                    // Kept after a later success, for the expiry notice.
                    w["quietSince"] = Value::Null;
                    w["failedReads"] = json!(w["failedReads"].as_i64().unwrap_or(0) + 1);
                    w["lastFailedRead"] = json!({"at":now(),"error":error.clone()});
                }
                w["error"] = json!(error);
                w["state"] = json!(if failures >= 8 {
                    "needs_attention"
                } else {
                    "retrying"
                });
                (60_i64 * 2_i64.pow(failures.min(6) as u32)).min(3600)
            }
        };
        let due = chrono::Utc::now().timestamp() + delay;
        w["nextPollAt"] = json!(
            chrono::DateTime::from_timestamp(due, 0)
                .unwrap()
                .to_rfc3339()
        );
        tx.execute(
            "UPDATE ci_watches SET next_poll=?2,failures=?3,data=?4 WHERE id=?1",
            params![id, due, failures, w.to_string()],
        )?;
        notify(&tx, id)?;
        super::lifecycle::reconcile(&tx, None)?;
        tx.commit()?;
        Ok(())
    }
    pub(super) fn ci_unfinished(&self, id: &str) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q=db.prepare("SELECT r.data FROM ci_runs r JOIN ci_watch_runs w ON w.run_id=r.id WHERE w.watch_id=?1 AND (json_extract(r.data,'$.rawStatus') IS NOT 'completed' OR json_type(r.data,'$.conclusion') IS NOT 'text') ORDER BY r.seq DESC LIMIT 10")?;
        let rows = q
            .query_map([id], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect();
        rows
    }
    pub(super) fn ci_cache(&self, endpoint: &str) -> Result<(Option<Value>, i64)> {
        let db = self.db.read()?;
        let raw: Option<String> = db
            .query_row(
                "SELECT data FROM ci_cache WHERE endpoint=?1",
                [endpoint],
                |r| r.get(0),
            )
            .optional()?;
        Ok((
            raw.map(|r| serde_json::from_str(&r)).transpose()?,
            cooldown(&db)?,
        ))
    }
    pub(super) fn ci_cooldown(&self, until: i64) -> Result<()> {
        self.db.write()?.execute("INSERT INTO ci_control(id,cooldown) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET cooldown=MAX(cooldown,excluded.cooldown)",[until])?;
        Ok(())
    }
    pub(super) fn ci_save_cache(&self, endpoint: &str, value: Value) -> Result<()> {
        let db = self.db.write()?;
        db.execute("INSERT INTO ci_cache(endpoint,data) VALUES(?1,?2) ON CONFLICT(endpoint) DO UPDATE SET data=excluded.data",params![endpoint,value.to_string()])?;
        db.execute("DELETE FROM ci_cache WHERE endpoint IN (SELECT endpoint FROM ci_cache ORDER BY json_extract(data,'$.fetchedAt') DESC LIMIT -1 OFFSET 256)",[])?;
        Ok(())
    }
}
