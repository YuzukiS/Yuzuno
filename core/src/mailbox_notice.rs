//! Small, immutable delivery summaries. Never classify message prose or read
//! the latest Job/CI state: a doorbell describes what was reserved at that time.
use crate::model::{Agent, AgentDetail};
use anyhow::Result;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::HashMap;

fn name(value: &Value) -> Option<String> {
    let text = value
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then(|| text.chars().take(320).collect())
}

fn identity(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
}

/// Called only at the shared insertion boundary. Public peer_send rejects
/// metadata; even an internal message with a peer author cannot claim a Job.
pub(crate) fn message_notice(message: &Value) -> Value {
    let sender = &message["sender"];
    if matches!(sender["kind"].as_str(), Some("agent" | "user")) {
        return json!({"kind":"peer","name":name(&sender["name"]),"status":"","key":message["id"]});
    }
    let metadata = &message["metadata"];
    let kind = metadata["kind"].as_str().unwrap_or("");
    let status = metadata["status"].as_str().unwrap_or("");
    if sender["kind"] == "system" && sender["id"] == "core" {
        let identity = match kind {
            // A reused Job may gate several runs. Each run's decision must
            // remain a distinct event even when job and attempt are identical.
            "job" if status == "waiting_analysis"
                && identity(&metadata["jobId"]).is_some()
                && identity(&metadata["attempt"]).is_some() => identity(&metadata["gateId"]),
            "job"
                if matches!(
                    status,
                    "succeeded" | "failed" | "cancelled" | "interrupted" | "rejected" | "unknown"
                ) && identity(&metadata["attempt"]).is_some() =>
            {
                // Run completion can reuse the same successful attempt. Its
                // result belongs to this run; ordinary Jobs have no runId.
                identity(&metadata["jobId"]).map(|job| identity(&metadata["runId"]).unwrap_or(job))
            }
            "ci" if matches!(
                status,
                "passed" | "failed" | "cancelled" | "skipped" | "pending" | "unknown"
            ) =>
            {
                identity(&metadata["runId"])
            }
            // The PR flow: a code review run ending, and a PR create/update
            // operation ending (pr_review and pr_operations stores).
            "review" if matches!(status, "completed" | "failed" | "cancelled" | "unknown") => {
                identity(&metadata["reviewId"])
            }
            "pr" if matches!(
                status,
                "completed" | "failed" | "unknown" | "needs_selection"
            ) =>
            {
                identity(&metadata["operationId"])
            }
            _ => None,
        };
        if let Some(identity) = identity {
            // Lifecycle alone cannot prove OOM or timeout. T47 snapshots the
            // matching attempt's machine evidence; unknown stays unknown.
            // A completed review is told by its conclusion, a completed PR
            // operation by what it did.
            let status = match (kind, status, metadata["systemdResult"].as_str()) {
                ("job", "failed", Some("oom-kill")) => "oom",
                ("job", "failed", Some("timeout")) => "timed_out",
                ("review", "completed", _) => match metadata["conclusion"].as_str() {
                    Some("no_findings") => "no_findings",
                    Some("approved_with_notes") => "approved_with_notes",
                    Some("changes_requested") => "changes_requested",
                    _ => "unknown",
                },
                ("pr", "completed", _) => match metadata["action"].as_str() {
                    Some("create") => "created",
                    Some("update") => "updated",
                    _ => "completed",
                },
                _ => status,
            };
            return json!({"kind":kind,"name":name(&metadata["name"]),"status":status,
                "key":json!([kind,identity,metadata["attempt"],status]).to_string()});
        }
    }
    json!({"kind":"system","name":name(&sender["name"]),"status":"","key":message["id"]})
}

/// The messages one delivery reserves: the recipient's pending, unread mail of
/// one priority up to `through`.
const ELIGIBLE: &str = "FROM collaboration_messages m WHERE recipient_id=?1 AND seq<=?2 AND delivery_state='pending'
          AND COALESCE(json_extract(data,'$.priority'),'normal')=?3
          AND COALESCE(json_extract(data,'$.metadata.kind'),'')!='update_wait'
          AND NOT EXISTS(SELECT 1 FROM collaboration_message_reads r WHERE r.message_seq=m.seq AND r.reader_id=m.recipient_id)";
/// At most this many members are named in a snapshot; a viewer reads no more.
const MEMBERS: i64 = 50;

/// Aggregate exactly the eligible reservation under its IMMEDIATE transaction.
/// SQL reads only the pending recipient/priority range, never message bodies in
/// Rust. Two groups and a remainder keep the stored/public snapshot bounded.
/// `memberSeqs` names the reserved messages themselves (the first fifty), so a
/// viewer shows exactly them rather than everything in the sequence range,
/// which can hold older delivered mail that was never read.
pub(crate) fn snapshot(
    db: &Connection,
    recipient: &str,
    through: i64,
    priority: &str,
    detail: &Value,
) -> Result<Value> {
    let mut query = db.prepare(&format!("WITH eligible AS (
        SELECT seq,COALESCE(json_extract(data,'$.notice.kind'),'workspace') kind,
          COALESCE(json_extract(data,'$.notice.status'),'') status,
          json_extract(data,'$.notice.name') name,
          COALESCE(json_extract(data,'$.notice.key'),id) event_key
        {ELIGIBLE}
        ), groups AS (
          SELECT kind,status,COUNT(DISTINCT event_key) count,COUNT(*) messages,MIN(seq) first_seq,
            CASE WHEN COUNT(name)=COUNT(*) AND COUNT(DISTINCT name)=1 THEN MIN(name) END name
          FROM eligible GROUP BY kind,status
        ) SELECT kind,status,count,messages,name,SUM(count) OVER(),SUM(messages) OVER(),MIN(first_seq) OVER()
          FROM groups ORDER BY first_seq LIMIT 2"))?;
    let rows = query.query_map(params![recipient, through, priority], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
        ))
    })?;
    let (mut groups, mut total, mut messages, mut first) = (Vec::new(), 0, 0, through + 1);
    for row in rows {
        let (kind, status, count, _raw, name, all, raw, min) = row?;
        groups.push(json!({"kind":kind,"status":status,"count":count,"name":name}));
        total = all;
        messages = raw;
        first = min;
    }
    let shown: i64 = groups
        .iter()
        .map(|group| group["count"].as_i64().unwrap_or(0))
        .sum();
    let members = db
        .prepare(&format!("SELECT seq {ELIGIBLE} ORDER BY seq LIMIT ?4"))?
        .query_map(params![recipient, through, priority, MEMBERS], |row| {
            row.get::<_, i64>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(
        json!({"version":1,"recipientId":recipient,"priority":priority,
        "afterSeq":detail["afterSeq"].as_i64().unwrap_or(first-1),"throughSeq":through,
        "messageCount":messages,"count":total,"groups":groups,"remainingCount":total-shown,
        "memberSeqs":members}),
    )
}

/// Query only native bindings present in the loaded conversation. Expression
/// indexes avoid the old scan of every historical message on each detail read.
pub(crate) fn annotate(db: &Connection, detail: &mut AgentDetail) -> Result<()> {
    annotate_turns(db, &detail.agent, &mut detail.turns)
}

pub(crate) fn annotate_turns(db: &Connection, agent: &Agent, conversation: &mut [Value]) -> Result<()> {
    let mut clients = HashMap::new();
    let mut turns = HashMap::new();
    for (t, turn) in conversation.iter_mut().enumerate() {
        if let Some(id) = turn["id"].as_str() {
            turns.insert(id.to_owned(), t);
        }
        if let Some(object) = turn.as_object_mut() {
            object.remove("_yuzunoMailbox");
        }
        for (i, item) in turn["items"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(object) = item.as_object_mut() {
                object.remove("_yuzunoMailbox");
            }
            if item["type"] == "userMessage" {
                if let Some(id) = item["clientId"].as_str() {
                    clients.insert(id.to_owned(), (t, i));
                }
            }
        }
    }
    // A turn-end Brief reminder is Core's own input, not mail: marked from
    // its own rows (`_yuzunoSource:"brief-reminder"`).
    crate::brief_turns::annotate(db, &agent.id, conversation)?;
    if clients.is_empty() && turns.is_empty() {
        return Ok(());
    }
    let mut query = db.prepare("SELECT DISTINCT delivery_detail,delivery_state FROM collaboration_messages INDEXED BY collaboration_messages_client
        WHERE recipient_id=?1 AND json_extract(delivery_detail,'$.clientMessageId') IN (SELECT value FROM json_each(?2))
          AND delivery_state IN ('delivered','sending','uncertain')
        UNION SELECT DISTINCT delivery_detail,delivery_state FROM collaboration_messages INDEXED BY collaboration_messages_turn
        WHERE recipient_id=?1 AND json_extract(delivery_detail,'$.turnId') IN (SELECT value FROM json_each(?3))
          AND delivery_state='delivered' AND (json_extract(delivery_detail,'$.mode') IS NULL OR json_extract(delivery_detail,'$.mode')='start')")?;
    let rows = query.query_map(
        params![
            agent.id,
            json!(clients.keys().collect::<Vec<_>>()).to_string(),
            json!(turns.keys().collect::<Vec<_>>()).to_string()
        ],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    for row in rows {
        let (raw, state) = row?;
        let source: Value = serde_json::from_str(&raw)?;
        if let Some(session) = source["sessionId"].as_str() {
            if agent
                .thread_id
                .as_deref()
                .or(agent.claude_session_id.as_deref())
                .is_some_and(|current| current != session)
            {
                continue;
            }
        }
        let notice = source
            .get("mailbox")
            .cloned()
            .unwrap_or_else(|| json!({"version":0,"priority":source["priority"]}));
        if state == "delivered" && source["mode"].as_str().is_none_or(|mode| mode == "start") {
            if let Some(t) = source["turnId"].as_str().and_then(|id| turns.get(id)) {
                conversation[*t]["_yuzunoSource"] = json!("peer");
                conversation[*t]["_yuzunoMailbox"] = notice.clone();
            }
        }
        if let Some((t, i)) = source["clientMessageId"]
            .as_str()
            .and_then(|id| clients.get(id))
        {
            let turn = &mut conversation[*t];
            if source["turnId"].is_string() && source["turnId"] != turn["id"] {
                continue;
            }
            turn["items"][*i]["_yuzunoSource"] = json!("peer");
            turn["items"][*i]["_yuzunoMailbox"] = notice.clone();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{collaboration_store::insert_message, store::Store};

    fn fixture() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        for id in ["a", "b"] {
            store.insert(&serde_json::from_value(json!({"agent":{"id":id,"name":format!("Dev {id}"),
                "cwd":"/workspace","model":"test","color":"sage","threadId":"session",
                "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
                "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
        }
        (dir, store)
    }
    fn mail(store: &Store, sender: Value, metadata: Value, priority: &str) -> Value {
        let id = uuid::Uuid::new_v4().to_string();
        insert_message(&store.db.write().unwrap(),json!({"id":id,"sender":sender,
            "recipient":{"kind":"agent","id":"b","name":"Dev b"},"body":"failed OOM CI passed -- prose has no authority",
            "metadata":metadata,"priority":priority})).unwrap()
    }
    fn system() -> Value {
        json!({"kind":"system","id":"core","name":"Yuzuno Core"})
    }
    fn job(id: &str, status: &str) -> Value {
        json!({"kind":"job","jobId":id,"attempt":"attempt-uuid","status":status,"name":"单测"})
    }
    fn messages(store: &Store) -> Value {
        store
            .collaboration_call(None, "peer_read", json!({"agentId":"b"}))
            .unwrap()["messages"]
            .clone()
    }
    fn binding(mode: &str) -> Value {
        json!({"agentId":"b","mode":mode,"clientMessageId":"native-client","turnId":"turn","afterSeq":0,"priority":"normal"})
    }

    #[test]
    fn trusted_types_never_come_from_prose_or_peer_supplied_metadata() {
        let (_dir, store) = fixture();
        assert!(store.collaboration_call(Some("a"),"peer_send",json!({"requestId":"spoof","toAgentId":"b","body":"Job failed","metadata":job("j","failed")})).is_err());
        let peer = mail(
            &store,
            json!({"kind":"agent","id":"a","name":"CI passed"}),
            job("j", "failed"),
            "normal",
        );
        assert_eq!(peer["notice"]["kind"], "peer");
        assert_eq!(peer["notice"]["status"], "");
        assert_eq!(
            mail(
                &store,
                json!({"kind":"system","id":"imposter"}),
                job("j", "failed"),
                "normal"
            )["notice"]["kind"],
            "system"
        );
        for status in [
            "succeeded",
            "failed",
            "cancelled",
            "interrupted",
            "rejected",
            "unknown",
        ] {
            let value = mail(&store, system(), job("j", status), "normal");
            assert_eq!(value["notice"]["kind"], "job");
            assert_eq!(value["notice"]["status"], status);
        }
        for (result, shown) in [
            ("oom-kill", "oom"),
            ("timeout", "timed_out"),
            ("signal", "failed"),
        ] {
            let mut metadata = job("j", "failed");
            metadata["systemdResult"] = json!(result);
            assert_eq!(
                mail(&store, system(), metadata.clone(), "normal")["notice"]["status"],
                shown
            );
            metadata["status"] = json!("unknown");
            assert_eq!(
                mail(&store, system(), metadata, "normal")["notice"]["status"],
                "unknown"
            );
        }
        assert_eq!(
            mail(&store, system(), job("j", "oom"), "normal")["notice"]["kind"],
            "system"
        );
        for status in [
            "passed",
            "failed",
            "cancelled",
            "skipped",
            "pending",
            "unknown",
        ] {
            let value = mail(
                &store,
                system(),
                json!({"kind":"ci","runId":"github-run-7","attempt":1,"name":"PR #27","status":status}),
                "normal",
            );
            assert_eq!(value["notice"]["kind"], "ci");
            assert_eq!(value["notice"]["status"], status);
        }
        assert_eq!(
            mail(&store, system(), job("j", "invented"), "normal")["notice"]["kind"],
            "system"
        );
        assert_eq!(
            mail(&store, system(), Value::Null, "normal")["notice"]["kind"],
            "system"
        );
    }

    #[test]
    fn pr_flow_notices_name_the_review_or_operation() {
        let (_dir, store) = fixture();
        for (status, conclusion, shown) in [
            ("completed", "no_findings", "no_findings"),
            ("completed", "approved_with_notes", "approved_with_notes"),
            ("unknown", "unknown", "unknown"),
            ("completed", "changes_requested", "changes_requested"),
            ("completed", "unknown", "unknown"),
            ("failed", "unknown", "failed"),
            ("cancelled", "unknown", "cancelled"),
        ] {
            let value = mail(
                &store,
                system(),
                json!({"kind":"review","reviewId":"r1","status":status,"conclusion":conclusion,"name":"PR #32"}),
                "normal",
            );
            assert_eq!(value["notice"]["kind"], "review");
            assert_eq!(value["notice"]["status"], shown);
            assert_eq!(value["notice"]["name"], "PR #32");
        }
        for (status, action, shown) in [
            ("completed", "create", "created"),
            ("completed", "update", "updated"),
            ("failed", "update", "failed"),
            ("unknown", "create", "unknown"),
            ("needs_selection", "update", "needs_selection"),
        ] {
            let value = mail(
                &store,
                system(),
                json!({"kind":"pr","operationId":"op","status":status,"action":action,"name":"PR #19"}),
                "normal",
            );
            assert_eq!(value["notice"]["kind"], "pr");
            assert_eq!(value["notice"]["status"], shown);
        }
        // Not from Core, still running, or without its record: generic.
        let review = json!({"kind":"review","reviewId":"r","status":"completed"});
        assert_eq!(
            mail(&store, json!({"kind":"system","id":"imposter"}), review, "normal")["notice"]["kind"],
            "system"
        );
        assert_eq!(
            mail(&store, system(), json!({"kind":"review","reviewId":"r","status":"running"}), "normal")["notice"]["kind"],
            "system"
        );
        assert_eq!(
            mail(&store, system(), json!({"kind":"pr","status":"completed"}), "normal")["notice"]["kind"],
            "system"
        );
    }

    #[test]
    fn reservation_is_immutable_bounded_and_filters_priority_read_and_later_mail() {
        let (_dir, store) = fixture();
        let first = mail(&store, system(), job("already-read", "failed"), "normal");
        store
            .collaboration_call(Some("b"), "peer_read", json!({}))
            .unwrap();
        mail(&store, system(), job("j1", "succeeded"), "normal");
        mail(&store, system(), job("j1", "succeeded"), "normal"); // same event is one visible result
        mail(&store, system(), job("j2", "failed"), "normal");
        mail(&store, system(), job("urgent", "unknown"), "urgent");
        let last = mail(
            &store,
            json!({"kind":"agent","id":"a","name":"Dev a"}),
            Value::Null,
            "normal",
        );
        let through = last["seq"].as_i64().unwrap();
        assert_eq!(
            store
                .set_peer_delivery_for_priority("b", through, "normal", "sending", binding("steer"))
                .unwrap(),
            4
        );
        let frozen = messages(&store)[1]["delivery"]["detail"]["mailbox"].clone();
        assert_eq!(frozen["messageCount"], 4);
        assert_eq!(frozen["count"], 3);
        assert_eq!(frozen["groups"].as_array().unwrap().len(), 2);
        assert_eq!(frozen["groups"][0]["status"], "succeeded");
        assert_eq!(frozen["groups"][0]["count"], 1);
        assert_eq!(frozen["groups"][1]["status"], "failed");
        assert_eq!(frozen["remainingCount"], 1);
        assert_eq!(frozen["throughSeq"], through);
        // The members are named: not the mail already read, not the urgent one.
        let seq = first["seq"].as_i64().unwrap();
        assert_eq!(frozen["memberSeqs"], json!([seq + 1, seq + 2, seq + 3, through]));
        assert_eq!(frozen["priority"], "normal");
        assert_eq!(frozen["recipientId"], "b");
        let later = mail(&store, system(), job("j3", "cancelled"), "normal");
        // A later job result or even renamed stored metadata cannot rewrite a delivered snapshot.
        store.db.write().unwrap().execute("UPDATE collaboration_messages SET data=json_set(data,'$.notice.status','unknown') WHERE seq=?1",[first["seq"].as_i64().unwrap()+1]).unwrap();
        store
            .set_peer_delivery(
                "b",
                through,
                "delivered",
                json!({"turnId":"turn","sessionId":"session"}),
            )
            .unwrap();
        let read = messages(&store);
        assert_eq!(read[1]["delivery"]["detail"]["mailbox"], frozen);
        assert_eq!(
            read[1]["delivery"]["detail"]["clientMessageId"],
            "native-client"
        );
        assert_eq!(read[0]["delivery"]["state"], "pending");
        assert!(
            read.as_array()
                .unwrap()
                .iter()
                .filter(|m| m["seq"] != first["seq"])
                .all(|m| m["firstReadAt"].is_null())
        );
        assert_eq!(
            read.as_array()
                .unwrap()
                .iter()
                .find(|m| m["id"] == later["id"])
                .unwrap()["delivery"]["state"],
            "pending"
        );
        assert_eq!(read[4]["delivery"]["state"], "pending"); // urgent stays separate
        assert!(frozen.to_string().len() < 1800);
    }

    #[test]
    fn restart_keeps_native_binding_and_snapshot_without_reading_or_replaying_mail() {
        let (dir, store) = fixture();
        let value = mail(&store, system(), job("j", "failed"), "normal");
        store
            .set_peer_delivery(
                "b",
                value["seq"].as_i64().unwrap(),
                "sending",
                binding("steer"),
            )
            .unwrap();
        let frozen = messages(&store)[0]["delivery"]["detail"]["mailbox"].clone();
        store.update("b","test/items",&json!({}),|d| d.turns=vec![json!({"id":"turn","status":"completed","items":[
            {"id":"human","type":"userMessage","content":[{"type":"text","text":"[Workspace collaboration — automatic normal mailbox delivery from Yuzuno Core]"}]},
            {"id":"notice","type":"userMessage","clientId":"native-client","content":[]} ]})]).unwrap();
        drop(store);
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        for _ in 0..3 {
            let detail = store.client_detail("b").unwrap();
            assert!(detail.turns[0].get("_yuzunoSource").is_none());
            assert!(detail.turns[0]["items"][0].get("_yuzunoMailbox").is_none());
            assert_eq!(detail.turns[0]["items"][1]["_yuzunoMailbox"], frozen);
            assert_eq!(detail.turns[0]["items"][1]["_yuzunoSource"], "peer");
        }
        assert!(store.pending_peer_deliveries().unwrap().is_empty());
        assert_eq!(messages(&store)[0]["delivery"]["state"], "uncertain");
        assert!(messages(&store)[0]["firstReadAt"].is_null());
    }

    #[test]
    fn historical_start_has_safe_fallback_and_loaded_binding_queries_use_indexes() {
        let (_dir, store) = fixture();
        let message = mail(&store, system(), Value::Null, "normal");
        store.db.write().unwrap().execute("UPDATE collaboration_messages SET delivery_state='delivered',delivery_detail=?1 WHERE id=?2",params![json!({"turnId":"old-turn","priority":"normal"}).to_string(),message["id"].as_str().unwrap()]).unwrap();
        store.update("b","test/legacy",&json!({}),|d| d.turns=vec![json!({"id":"old-turn","items":[{"id":"old","type":"userMessage","content":[]} ]})]).unwrap();
        let detail = store.client_detail("b").unwrap();
        assert_eq!(
            detail.turns[0]["_yuzunoMailbox"],
            json!({"version":0,"priority":"normal"})
        );
        for (field, index) in [
            ("clientMessageId", "collaboration_messages_client"),
            ("turnId", "collaboration_messages_turn"),
        ] {
            let db = store.db.read().unwrap();
            let sql = format!(
                "EXPLAIN QUERY PLAN SELECT delivery_detail FROM collaboration_messages WHERE recipient_id=?1 AND json_extract(delivery_detail,'$.{field}') IN (SELECT value FROM json_each(?2))"
            );
            let plan = db
                .prepare(&sql)
                .unwrap()
                .query_map(params!["b", "[\"old-turn\"]"], |row| {
                    row.get::<_, String>(3)
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
                .join("\n");
            assert!(plan.contains(index), "{plan}");
        }
    }
}
