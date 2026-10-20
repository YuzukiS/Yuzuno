//! A subscription can be shared by manual requests and delivery rounds. Keep
//! their interests separate; stopping one owner must not stop the other.
use super::Subscribe;
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS ci_interests(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES ci_subscriptions(id),owner TEXT NOT NULL,active INTEGER NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ci_interests_subscription ON ci_interests(subscription_id,active);
        CREATE INDEX IF NOT EXISTS ci_interests_owner ON ci_interests(owner,active);")?;
    Ok(())
}
pub(super) fn interests(db: &Connection, id: &str) -> Result<Value> {
    let mut q =
        db.prepare("SELECT data FROM ci_interests WHERE subscription_id=?1 ORDER BY rowid")?;
    let rows = q
        .query_map([id], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!(rows))
}

/// Ownership comes from the flow's durable operation identity, never from a
/// caller-supplied label. Recheck authorization after remote I/O, inside the
/// subscription transaction, so an in-flight setup cannot undo a stop.
pub(super) fn owner(
    db: &Connection,
    actor: Option<&str>,
    task: &str,
    input: &Subscribe,
    validate: bool,
) -> Result<String> {
    let raw: Option<(String, String)> = db.query_row(
        "SELECT f.data,r.value FROM delivery_flows f,json_each(f.data,'$.rounds') r WHERE f.task_id=?1 AND json_extract(f.data,'$.owner.id')=?2 AND json_extract(r.value,'$.ci.requestId')=?3",
        params![task,actor,input.request_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((flow, round)) = raw else {
        return Ok("manual".into());
    };
    let f: Value = serde_json::from_str(&flow)?;
    let r: Value = serde_json::from_str(&round)?;
    if validate {
        let raw: String = db.query_row(
            "SELECT data FROM collaboration_tasks WHERE id=?1",
            [task],
            |r| r.get(0),
        )?;
        let t: Value = serde_json::from_str(&raw)?;
        ensure!(
            f["enabled"] == true
                && f["terminal"].is_null()
                && t["archivedAt"].is_null()
                && t["status"] != "done"
                && t["status"] != "cancelled"
                && t["assigneeAgentId"] == f["owner"]["id"]
                && t["dispatch"]["id"] == f["dispatchId"]
                && f["rounds"]
                    .as_array()
                    .is_some_and(|rs| rs.last() == Some(&r))
                && !r["resultId"].is_null()
                && r["headSha"] == input.expected_sha
                && f["url"] == input.url,
            "Delivery authorization changed before CI subscription committed"
        );
    }
    Ok(format!(
        "delivery:{}:{}",
        f["id"].as_str().unwrap(),
        r["number"]
    ))
}

/// Old releases kept one shared subscription but all request receipts. Recover
/// both owners, including a committed CI request whose reply never reached the
/// flow. Unknown provenance is conservatively manual. Never reactivate an old
/// inactive row or overwrite an existing interest on restart.
pub(super) fn backfill(db: &Connection) -> Result<()> {
    let mut q = db.prepare("SELECT s.id,s.task_id,s.active,s.expires,s.data FROM ci_subscriptions s WHERE NOT EXISTS(SELECT 1 FROM ci_interests i WHERE i.subscription_id=s.id)")?;
    let rows = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (sid, task, active, expires, raw) in rows {
        let sub: Value = serde_json::from_str(&raw)?;
        let mut q = db.prepare("SELECT actor,request_id,input_json FROM collaboration_requests WHERE operation='ci_subscribe' AND json_extract(response_json,'$.subscriptionId')=?1")?;
        let receipts = q
            .query_map([&sid], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if receipts.is_empty() {
            insert(
                db,
                &sid,
                "manual",
                &format!("legacy:{sid}"),
                None,
                active,
                expires,
                &sub["createdAt"],
            )?;
        } else {
            for (actor, request, raw) in receipts {
                let input: Subscribe = serde_json::from_str(&raw)?;
                let owner = owner(db, actor.strip_prefix("agent:"), &task, &input, false)?;
                insert(
                    db,
                    &sid,
                    &owner,
                    &json!([actor, request]).to_string(),
                    Some(&request),
                    active,
                    expires,
                    &sub["createdAt"],
                )?;
            }
        }
    }
    Ok(())
}
fn insert(
    db: &Connection,
    sid: &str,
    owner: &str,
    id: &str,
    request: Option<&str>,
    active: bool,
    expires: i64,
    opened: &Value,
) -> Result<()> {
    let v = json!({"id":id,"subscriptionId":sid,"owner":owner,"requestId":request,"openedAt":opened,"expiresAt":super::stamp(expires),"active":active,
        "closure":if active { Value::Null } else { json!({"reason":"previously_inactive","at":crate::model::now()}) }});
    db.execute("INSERT OR IGNORE INTO ci_interests(id,subscription_id,owner,active,expires,data) VALUES(?1,?2,?3,?4,?5,?6)",params![id,sid,owner,active,expires,v.to_string()])?;
    Ok(())
}
pub(super) fn register(
    db: &Connection,
    sid: &str,
    owner: &str,
    actor: &str,
    request: &str,
    expires: i64,
) -> Result<()> {
    // A fresh request explicitly renews this owner's interest. Retain previous
    // closures and receipts, without growing the active-interest set forever.
    close_where(db, Some(sid), Some(owner), "renewed")?;
    insert(
        db,
        sid,
        owner,
        &json!([actor, request]).to_string(),
        Some(request),
        true,
        expires,
        &json!(crate::model::now()),
    )?;
    project(db, sid)
}
fn close(db: &Connection, id: &str, reason: &str) -> Result<()> {
    db.execute("UPDATE ci_interests SET active=0,data=json_set(data,'$.active',json('false'),'$.closure',json(?2)) WHERE id=?1 AND active=1",params![id,json!({"reason":reason,"at":crate::model::now()}).to_string()])?;
    Ok(())
}
fn close_where(
    db: &Connection,
    sid: Option<&str>,
    owner: Option<&str>,
    reason: &str,
) -> Result<()> {
    let mut q = db.prepare("SELECT id,subscription_id FROM ci_interests WHERE active=1 AND (?1 IS NULL OR subscription_id=?1) AND (?2 IS NULL OR owner=?2)")?;
    let ids = q
        .query_map(params![sid, owner], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, sid) in ids {
        close(db, &id, reason)?;
        project(db, &sid)?;
    }
    Ok(())
}
pub(super) fn stop_subscription(db: &Connection, sid: &str) -> Result<()> {
    close_where(db, Some(sid), None, "explicit_stop")
}
pub(crate) fn close_delivery(
    db: &Connection,
    flow: &str,
    rounds: usize,
    reason: &str,
) -> Result<()> {
    for round in 1..=rounds {
        close_where(db, None, Some(&format!("delivery:{flow}:{round}")), reason)?;
    }
    Ok(())
}
fn project(db: &Connection, sid: &str) -> Result<()> {
    let expires: Option<i64> = db.query_row("SELECT MAX(expires) FROM ci_interests WHERE subscription_id=?1 AND active=1 AND expires>?2",params![sid,chrono::Utc::now().timestamp()], |r| r.get(0))?;
    let closure: Option<String> = db.query_row("SELECT json_extract(data,'$.closure') FROM ci_interests WHERE subscription_id=?1 AND json_type(data,'$.closure')='object' ORDER BY json_extract(data,'$.closure.at') DESC,rowid DESC LIMIT 1",[sid],|r| r.get(0)).optional()?;
    db.execute("UPDATE ci_subscriptions SET active=?2,expires=COALESCE(?3,expires),data=json_set(data,'$.active',json(?4),'$.closure',json(?5)) WHERE id=?1", params![sid,expires.is_some(),expires,if expires.is_some(){"true"}else{"false"},if expires.is_some(){"null".into()}else{closure.unwrap_or_else(|| "null".into())}])?;
    if let Some(expires) = expires {
        db.execute(
            "UPDATE ci_subscriptions SET data=json_set(data,'$.expiresAt',?2) WHERE id=?1",
            params![sid, super::stamp(expires)],
        )?;
    }
    Ok(())
}
fn task_reason(t: &Value) -> Option<&'static str> {
    if t["status"] == "done" {
        Some("task_completed")
    } else if t["status"] == "cancelled" {
        Some("task_cancelled")
    } else if !t["archivedAt"].is_null() {
        Some("task_archived")
    } else {
        None
    }
}

pub(crate) fn reconcile(db: &Connection, task: Option<&str>) -> Result<()> {
    backfill(db)?;
    crate::delivery::store::close_finished(db, task)?;
    let mut q = db.prepare("SELECT i.id,i.subscription_id,i.expires,i.data,t.data,w.data FROM ci_interests i JOIN ci_subscriptions s ON s.id=i.subscription_id JOIN collaboration_tasks t ON t.id=s.task_id JOIN ci_watches w ON w.id=s.watch_id WHERE i.active=1 AND (?1 IS NULL OR s.task_id=?1)")?;
    let rows = q
        .query_map([task], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, sid, expires, interest, task, watch) in rows {
        let i: Value = serde_json::from_str(&interest)?;
        let t: Value = serde_json::from_str(&task)?;
        let w: Value = serde_json::from_str(&watch)?;
        let reason = if expires <= chrono::Utc::now().timestamp() {
            Some("expired")
        } else if w["kind"] == "pull" {
            if w["currentPr"]["merged"] == true || w["currentPr"]["state"] == "merged" {
                Some("pr_merged")
            } else {
                task_reason(&t)
            }
        } else if task_reason(&t).is_some() && verification_finished(db, &sid, &w, &i)? {
            Some("verification_completed")
        } else {
            None
        };
        if let Some(reason) = reason {
            close(db, &id, reason)?;
            project(db, &sid)?;
            if reason == "expired" && w["kind"] == "commit" {
                no_run_notice(db, &sid, &w)?;
            }
        }
    }
    Ok(())
}
/// A commit watch that ended by expiry without any run of its target says so
/// once to each subscription, so an Agent that ended its Turn is not left
/// waiting. It reports what Yuzuno saw, never a pass.
fn no_run_notice(db: &Connection, sid: &str, w: &Value) -> Result<()> {
    let (raw, active): (String, bool) = db.query_row(
        "SELECT data,active FROM ci_subscriptions WHERE id=?1",
        [sid],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let sub: Value = serde_json::from_str(&raw)?;
    let runs: i64 = db.query_row(
        "SELECT COUNT(*) FROM ci_watch_runs WHERE watch_id=?1",
        [w["id"].as_str()],
        |r| r.get(0),
    )?;
    if active || runs > 0 || !sub["noRunNoticeId"].is_null() {
        return Ok(());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let target = format!(
        "commit {} on {} for {} in {}",
        w["expectedSha"].as_str().unwrap_or(""),
        w["branch"].as_str().unwrap_or(""),
        w["event"].as_str().unwrap_or(""),
        w["repository"].as_str().unwrap_or("")
    );
    // What Yuzuno observed, and what could hide a run from it.
    let mut seen = vec![format!(
        "As of the end of its monitoring ({}, expired), Yuzuno observed no matching run of {target} for {}.",
        sub["expiresAt"].as_str().unwrap_or(""),
        sub["taskRef"].as_str().unwrap_or("")
    )];
    let status = if let Some(error) = w["error"].as_str() {
        seen.push(format!(
            "Its last read failed ({error}; {}), so a run may exist that it did not see.",
            w["lastAttemptAt"].as_str().unwrap_or("no attempt")
        ));
        "unknown"
    } else {
        if let Some(n) = w["failedReads"].as_i64().filter(|n| *n > 0) {
            seen.push(format!(
                "{n} read{} of this watch failed (last at {}: {}); later reads succeeded.",
                if n == 1 { "" } else { "s" },
                w["lastFailedRead"]["at"].as_str().unwrap_or(""),
                w["lastFailedRead"]["error"].as_str().unwrap_or("")
            ));
        }
        seen.push(format!(
            "Its last successful read was at {}.",
            w["observedAt"].as_str().unwrap_or("never")
        ));
        "no_run_observed"
    };
    if w["truncated"] == true {
        seen.push("GitHub's run list for it was longer than Yuzuno reads (1,000 runs), so it was incomplete.".into());
    }
    let body = format!(
        "GitHub Actions: {} This is not proof that GitHub never had such a run, and nothing is known to have run or passed. If this commit should have run workflows, check them on GitHub; to keep watching, subscribe again with a new requestId.",
        seen.join(" ")
    );
    let label = format!(
        "{} {} · no run observed",
        w["branch"].as_str().unwrap_or(""),
        w["event"].as_str().unwrap_or("")
    );
    crate::collaboration_store::insert_message(
        db,
        json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},"recipient":sub["agent"],"body":body,"taskId":sub["taskId"],"replyTo":null,"threadId":id,"createdAt":crate::model::now(),"source":{"subscriptionId":sid,"ciNoRun":true},"priority":"normal","metadata":{"kind":"ci","name":label,"status":status,"repositoryId":w["repositoryId"],"expectedSha":w["expectedSha"],"branch":w["branch"],"event":w["event"],"taskId":sub["taskId"],"url":w["url"]}}),
    )?;
    db.execute(
        "UPDATE ci_subscriptions SET data=json_set(data,'$.noRunNoticeId',?2) WHERE id=?1",
        params![sid, id],
    )?;
    Ok(())
}
/// A specific run may be the post-merge main verification. Closing its task
/// must not cut off an active/unknown run or its completion notification. A new
/// request needs an observation made since that request, not an old cached green.
fn verification_finished(db: &Connection, sid: &str, w: &Value, i: &Value) -> Result<bool> {
    if !w["error"].is_null() || w["truncated"] == true || w["observedAt"].is_null() {
        return Ok(false);
    }
    if w["kind"] == "commit" {
        return commit_verification_finished(db, sid, w, i);
    }
    let time = |v: &Value| {
        v.as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    };
    let (Some(observed), Some(opened)) = (time(&w["observedAt"]), time(&i["openedAt"])) else {
        return Ok(false);
    };
    // GitHub cache timestamps currently have second precision. An observation
    // in the same second cannot prove it followed this fractional request time:
    // retain monitoring until the next demonstrably newer observation.
    if observed <= opened {
        return Ok(false);
    }
    let row: Option<(String,bool)> = db.query_row("SELECT r.data,EXISTS(SELECT 1 FROM ci_notifications n WHERE n.subscription_id=?2 AND n.run_id=r.id) FROM ci_watch_runs wr JOIN ci_runs r ON r.id=wr.run_id WHERE wr.watch_id=?1 AND json_extract(r.data,'$.runId')=?3 ORDER BY CAST(json_extract(r.data,'$.attempt') AS INTEGER) DESC LIMIT 1",params![w["id"].as_str(),sid,w["number"].as_u64().map(|n|n.to_string())],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((raw, notified)) = row else {
        return Ok(false);
    };
    let run: Value = serde_json::from_str(&raw)?;
    Ok(notified && run["rawStatus"] == "completed" && run["conclusion"].is_string())
}
/// The product's bounded discovery window: GitHub has no signal that every
/// workflow of a push has appeared, so a commit watch needs this long of
/// quiet observation before it counts as verified. It does not prove that
/// no later workflow will start.
const SETTLE_SECONDS: i64 = 600;
/// A commit watch after its task closed: every run of its target, at its
/// latest attempt, finished and notified to this subscription, and complete,
/// successful observations after the request have seen nothing new for
/// SETTLE_SECONDS (the watch's quietSince; a new run or attempt, a changed
/// status, a failed read or a cut list starts it again). No run at all, an
/// error or a cut list is never a verification.
fn commit_verification_finished(db: &Connection, sid: &str, w: &Value, i: &Value) -> Result<bool> {
    let time = |v: &Value| {
        v.as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    };
    let (Some(observed), Some(opened)) = (time(&w["observedAt"]), time(&i["openedAt"])) else {
        return Ok(false);
    };
    if observed <= opened {
        return Ok(false);
    }
    let mut q = db.prepare("SELECT r.data,EXISTS(SELECT 1 FROM ci_notifications n WHERE n.subscription_id=?2 AND n.run_id=r.id) FROM ci_watch_runs wr JOIN ci_runs r ON r.id=wr.run_id WHERE wr.watch_id=?1")?;
    let rows = q
        .query_map(params![w["id"].as_str(), sid], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // The latest attempt of each run.
    let mut latest: std::collections::BTreeMap<String, (u64, Value, bool)> = Default::default();
    for (raw, notified) in rows {
        let run: Value = serde_json::from_str(&raw)?;
        let attempt = run["attempt"]
            .as_str()
            .and_then(|a| a.parse().ok())
            .unwrap_or(0);
        let key = run["runId"].as_str().unwrap_or("").to_owned();
        if latest.get(&key).is_none_or(|(a, _, _)| attempt > *a) {
            latest.insert(key, (attempt, run, notified));
        }
    }
    if latest.is_empty() {
        return Ok(false);
    }
    for (_, run, notified) in latest.values() {
        if !notified || run["rawStatus"] != "completed" || !run["conclusion"].is_string() {
            return Ok(false);
        }
    }
    // Ten minutes of complete, successful observations that saw nothing new,
    // counted from this request at the earliest: not GitHub's finish times.
    let Some(quiet) = time(&w["quietSince"]) else {
        return Ok(false);
    };
    let from = quiet.timestamp().max(opened.timestamp());
    Ok(observed.timestamp() - from >= SETTLE_SECONDS)
}
