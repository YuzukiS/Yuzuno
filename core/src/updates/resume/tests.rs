use super::super::notices::tests::waiting;
use super::*;
use crate::collaboration_runtime::tests::{finish, fixture, working};
use std::path::Path;

/// Agent `a` is working in `original-turn`, and update `id` asked it to
/// pause; with `read`, it read that request while it applied.
async fn paused(id: &str, read: bool) -> (tempfile::TempDir, Arc<Workspace>, Operation) {
    let (dir, ws) = fixture().await;
    working(&ws);
    let op = waiting(dir.path(), &ws, id);
    ws.store.queue_update_pause(&op).unwrap();
    if read {
        read_pause(&ws, &op, true).await;
    }
    (dir, ws, op)
}

async fn read_pause(ws: &Arc<Workspace>, op: &Operation, active: bool) {
    let m = pause(ws, op);
    let read = ws
        .collaboration_call(Some("a"), "peer_read",
            json!({"priority":"urgent","afterSeq":m["seq"].as_i64().unwrap()-1,"limit":1}))
        .await
        .unwrap();
    assert_eq!(read["messages"][0]["updateWait"]["active"], active);
}

fn pause(ws: &Workspace, op: &Operation) -> Value {
    ws.store.update_pause_messages(&op.id).unwrap().remove(0)
}

fn resume(ws: &Workspace, op: &Operation) -> Value {
    pause(ws, op)["delivery"]["detail"]["resume"].clone()
}

/// The update ends in `phase`; with `reopen`, this Core accepts work again.
fn end(ws: &Workspace, op: &Operation, phase: Phase, reopen: bool) {
    ws.update_notice_layout.get().unwrap().edit_operation(&op.id, |o| {
        o.set_phase(phase, None);
        Ok(())
    }).unwrap();
    if reopen {
        ws.admission.reopen(&op.id).unwrap();
    }
}

fn ended_op(ws: &Workspace, op: &Operation) -> Operation {
    ws.update_notice_layout.get().unwrap().journal().unwrap().operation.filter(|o| o.id == op.id).unwrap()
}

fn starts(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join("starts.jsonl"))
        .map(|calls| calls.lines().map(|l| serde_json::from_str(l).unwrap()).collect())
        .unwrap_or_default()
}

/// Ends what still runs (the fake cannot interrupt), then closes `a`.
async fn close(ws: &Arc<Workspace>) {
    let open: Vec<String> = ws.store.detail("a").unwrap().turns.iter()
        .filter(|t| t["status"] == "inProgress").filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
    for id in open {
        finish(ws, &id);
    }
    ws.close_agent("a").await.unwrap();
}

fn turn_end(ws: &Workspace, id: &str, status: &str) {
    let event = json!({"turn":{"id":id,"status":status}});
    ws.store.update("a", "turn/completed", &event, |d| d.apply("turn/completed", &event)).unwrap();
}

/// A Turn after the original one, its first input as the record holds it.
fn later_turn(ws: &Workspace, id: &str, status: &str, client: Option<&str>) {
    let mut item = json!({"id":format!("{id}-input"),"type":"userMessage","content":[{"type":"text","text":"Newer input"}]});
    if let Some(client) = client {
        item["clientId"] = json!(client);
    }
    let (id, status) = (id.to_owned(), status.to_owned());
    ws.store.update("a", "test/turn", &json!({}), move |d| {
        d.turns.retain(|t| t["id"] != id.as_str());
        d.turns.push(json!({"id":id,"status":status,"items":[item]}));
    }).unwrap();
}

#[tokio::test]
async fn a_yielded_agent_gets_one_continue_after_the_update_is_installed() {
    let (dir, ws, op) = paused("installed", true).await;
    finish(&ws, "original-turn");
    end(&ws, &op, Phase::Complete, true);
    ws.resume_after_update().await.unwrap();
    ws.resume_after_update().await.unwrap();
    let calls = starts(dir.path());
    assert_eq!(calls.len(), 1, "{calls:#?}");
    let text = calls[0]["input"][0]["text"].as_str().unwrap();
    assert!(text.starts_with("[Yuzuno · continue after update]") && text.contains("(operation installed)")
        && text.contains("release candidate is installed"), "{text}");
    let client = format!("{CLIENT_PREFIX}installed");
    let receipt = ws.store.receipt("a", &client).unwrap().unwrap();
    assert_eq!(receipt.origin, Some(json!({"kind":ORIGIN,"operationId":"installed","releaseId":"candidate","phase":"complete"})));
    assert!(receipt.input.expected_turn_id.is_none());
    let state = resume(&ws, &op);
    assert_eq!((state["state"].as_str(), state["turnId"].as_str()), (Some("sent"), Some("native-turn")), "{state}");
    // Not a candidate any more: the next rounds read nothing else.
    assert!(ws.store.update_resume_candidates(&op.id).unwrap().is_empty());
    assert_eq!(ws.update_resume_status(&ended_op(&ws, &op)).unwrap(),
        json!([{"agentId":"a","name":"A","state":"sent","turnId":"native-turn"}]));
    // The conversation marks its input as Core's own, not the user's.
    let mut conversation = json!([{"id":"native-turn","items":[{"type":"userMessage","clientId":client}]}]);
    crate::input_origin::annotate(&ws.store.db.read().unwrap(), "a", conversation.as_array_mut().unwrap()).unwrap();
    assert_eq!(conversation[0]["items"][0]["_yuzunoInput"], "update");
    assert!(!crate::input_origin::navigable("update"));
    close(&ws).await;
}

#[tokio::test]
async fn an_agent_that_never_read_the_request_is_not_continued() {
    let (dir, ws, op) = paused("unread", false).await;
    finish(&ws, "original-turn");
    end(&ws, &op, Phase::Complete, true);
    ws.resume_after_update().await.unwrap();
    assert!(starts(dir.path()).is_empty());
    assert_eq!(resume(&ws, &op)["reason"], "not_paused");
    assert_eq!(ws.update_resume_status(&ended_op(&ws, &op)).unwrap(), json!([]));
    close(&ws).await;
}

#[tokio::test]
async fn a_persons_newer_input_ends_it_and_cores_own_turn_does_not() {
    let (dir, ws, op) = paused("newer", true).await;
    finish(&ws, "original-turn");
    later_turn(&ws, "user-turn", "completed", None);
    end(&ws, &op, Phase::Complete, true);
    ws.resume_after_update().await.unwrap();
    assert!(starts(dir.path()).is_empty());
    assert_eq!(resume(&ws, &op)["reason"], "newer_input");
    assert_eq!(ws.update_resume_status(&ended_op(&ws, &op)).unwrap()[0]["state"], "skipped");
    close(&ws).await;

    // A Home card's refresh after the original Turn: waited for, then continued.
    let (dir, ws, op) = paused("refresh", true).await;
    finish(&ws, "original-turn");
    end(&ws, &op, Phase::Complete, true);
    let input = MessageInput { client_message_id: "refresh-1".into(), text: "Refresh the card".into(), text_blocks: None,
        images: vec![], expected_turn_id: None, question: None, clarification: None };
    ws.send_message_from("a", input, Vec::new(), Some(json!({"kind":"schedule"}))).await.unwrap();
    later_turn(&ws, "native-turn", "inProgress", Some("refresh-1"));
    ws.resume_after_update().await.unwrap();
    assert_eq!(starts(dir.path()).len(), 1);
    assert!(resume(&ws, &op).is_null());
    finish(&ws, "native-turn");
    ws.resume_after_update().await.unwrap();
    assert_eq!(starts(dir.path()).len(), 2);
    assert_eq!(resume(&ws, &op)["state"], "sent");
    close(&ws).await;
}

#[tokio::test]
async fn closed_disconnected_and_released_agents_are_skipped() {
    for case in ["closed", "disconnected", "released"] {
        let (dir, ws, op) = paused(case, true).await;
        finish(&ws, "original-turn");
        end(&ws, &op, Phase::Complete, true);
        match case {
            "closed" => { ws.close_agent("a").await.unwrap(); }
            "disconnected" => { ws.disconnect_agent("a").await.unwrap(); }
            _ => {
                ws.store.db.write().unwrap().execute("INSERT INTO executor_archiving(agent_id,released_by,since,reason)
                    VALUES('a','lead',?1,'Done')", [crate::model::now()]).unwrap();
            }
        }
        ws.resume_after_update().await.unwrap();
        assert!(starts(dir.path()).is_empty(), "{case}");
        assert_eq!(resume(&ws, &op)["reason"], case);
        let _ = ws.close_agent("a").await;
    }
}

#[tokio::test]
async fn cancelled_while_its_turn_finishes_it_continues_once_that_turn_ends() {
    let (dir, ws, op) = paused("cancelled", true).await;
    end(&ws, &op, Phase::Cancelled, true);
    ws.resume_after_update().await.unwrap();
    assert!(starts(dir.path()).is_empty());
    assert!(resume(&ws, &op).is_null());
    assert_eq!(ws.update_resume_status(&ended_op(&ws, &op)).unwrap()[0]["state"], "pending");
    finish(&ws, "original-turn");
    ws.resume_after_update().await.unwrap();
    ws.resume_after_update().await.unwrap();
    let calls = starts(dir.path());
    assert_eq!(calls.len(), 1);
    assert!(calls[0]["input"][0]["text"].as_str().unwrap().contains("the update was cancelled"));
    assert_eq!(resume(&ws, &op)["state"], "sent");
    close(&ws).await;
}

#[tokio::test]
async fn a_request_read_only_after_the_cancel_paused_nothing() {
    let (dir, ws, op) = paused("late", false).await;
    end(&ws, &op, Phase::Cancelled, true);
    read_pause(&ws, &op, false).await;
    finish(&ws, "original-turn");
    ws.resume_after_update().await.unwrap();
    assert!(starts(dir.path()).is_empty());
    assert_eq!(resume(&ws, &op)["reason"], "not_paused");
    close(&ws).await;
}

#[tokio::test]
async fn a_send_core_stopped_during_settles_from_its_receipt() {
    // It went: settled from its receipt, never sent again.
    let (dir, ws, op) = paused("went", true).await;
    finish(&ws, "original-turn");
    end(&ws, &op, Phase::Complete, true);
    let key = pause(&ws, &op)["id"].as_str().unwrap().to_owned();
    assert!(ws.store.set_update_resume(&key, None, Some(json!({"state":"sending"}))).unwrap());
    assert!(!ws.store.set_update_resume(&key, None, Some(json!({"state":"sending"}))).unwrap());
    let input = MessageInput { client_message_id: format!("{CLIENT_PREFIX}went"), text: text(&ended_op(&ws, &op)), text_blocks: None,
        images: vec![], expected_turn_id: None, question: None, clarification: None };
    ws.send_message_from("a", input, Vec::new(), Some(json!({"kind":ORIGIN}))).await.unwrap();
    ws.resume_after_update().await.unwrap();
    assert_eq!(starts(dir.path()).len(), 1);
    let state = resume(&ws, &op);
    assert_eq!((state["state"].as_str(), state["turnId"].as_str()), (Some("sent"), Some("native-turn")), "{state}");
    close(&ws).await;

    // It never went: decided again, and sent once.
    let (dir, ws, op) = paused("lost", true).await;
    finish(&ws, "original-turn");
    end(&ws, &op, Phase::Complete, true);
    let key = pause(&ws, &op)["id"].as_str().unwrap().to_owned();
    ws.store.set_update_resume(&key, None, Some(json!({"state":"sending"}))).unwrap();
    ws.resume_after_update().await.unwrap();
    ws.resume_after_update().await.unwrap();
    assert_eq!(starts(dir.path()).len(), 1);
    assert_eq!(resume(&ws, &op)["state"], "sent");
    close(&ws).await;
}

#[tokio::test]
async fn an_original_turn_stopped_or_failed_is_not_continued() {
    for status in ["interrupted", "failed"] {
        let (dir, ws, op) = paused(status, true).await;
        turn_end(&ws, "original-turn", status);
        end(&ws, &op, Phase::Complete, true);
        ws.resume_after_update().await.unwrap();
        assert!(starts(dir.path()).is_empty(), "{status}");
        assert_eq!(resume(&ws, &op)["reason"], "turn_not_completed", "{status}");
        close(&ws).await;
    }
}

#[tokio::test]
async fn nothing_is_sent_while_admission_stays_closed() {
    let (dir, ws, op) = paused("draining", true).await;
    finish(&ws, "original-turn");
    end(&ws, &op, Phase::Complete, false);
    ws.resume_after_update().await.unwrap();
    assert!(starts(dir.path()).is_empty());
    assert!(resume(&ws, &op).is_null());
    ws.admission.reopen(&op.id).unwrap();
    ws.resume_after_update().await.unwrap();
    assert_eq!(starts(dir.path()).len(), 1);
    close(&ws).await;
}

#[tokio::test]
async fn input_arriving_after_the_decision_stops_the_send_under_the_gate() {
    let (dir, ws, op) = paused("raced", true).await;
    finish(&ws, "original-turn");
    end(&ws, &op, Phase::Complete, true);
    let message = pause(&ws, &op);
    // Decided on the original Turn; then the user's message started a Turn.
    later_turn(&ws, "user-turn", "inProgress", None);
    let key = message["id"].as_str().unwrap();
    ws.send_resume(&ended_op(&ws, &op), key, "a", message["metadata"].clone(), "original-turn".into()).await.unwrap();
    assert!(starts(dir.path()).is_empty());
    assert_eq!(resume(&ws, &op)["reason"], "newer_input");
    // Refused before message/requested: no receipt was ever recorded.
    assert!(ws.store.receipt("a", &format!("{CLIENT_PREFIX}raced")).unwrap().is_none());
    close(&ws).await;

    // A Turn of Core's own (no person's input) puts it off instead: it is
    // decided again, and sent once that Turn has ended.
    let (dir, ws, op) = paused("deferred", true).await;
    finish(&ws, "original-turn");
    end(&ws, &op, Phase::Complete, true);
    let message = pause(&ws, &op);
    ws.store.update("a", "test/turn", &json!({}), |d| {
        d.turns.push(json!({"id":"core-turn","status":"inProgress","items":[]}));
    }).unwrap();
    let key = message["id"].as_str().unwrap();
    ws.send_resume(&ended_op(&ws, &op), key, "a", message["metadata"].clone(), "original-turn".into()).await.unwrap();
    assert!(starts(dir.path()).is_empty());
    assert!(resume(&ws, &op).is_null());
    turn_end(&ws, "core-turn", "completed");
    ws.resume_after_update().await.unwrap();
    assert_eq!(starts(dir.path()).len(), 1);
    assert_eq!(resume(&ws, &op)["state"], "sent");
    close(&ws).await;
}

#[test]
fn paused_for_reads_before_the_deadline_and_the_end() {
    let at = |s: i64| (chrono::Utc::now() + chrono::Duration::seconds(s)).to_rfc3339();
    let mut op: Operation = serde_json::from_value(json!({"id":"o","requestId":"r","releaseId":"c","phase":"cancelled",
        "startedAt":at(-100),"updatedAt":at(-10),"deadline":at(100),"error":null,"recoveredSessions":0,"totalSessions":0,
        "previous":{"releaseId":"p","manifestSha256":"a"},"candidate":{"releaseId":"c","manifestSha256":"b"},
        "oldProcess":{"pid":1,"startTicks":1,"executable":"/x"},"helperProcess":null,"newProcess":null,"stoppingProcess":null,
        "recordsProof":null,"workspaceId":"w","token":"t","launch":{"port":1,"dataDir":"/d","cwd":"/c","codex":"x"},"sessions":[]})).unwrap();
    assert!(paused_for(&op, &json!({"firstReadAt":at(-20)})));
    assert!(!paused_for(&op, &json!({"firstReadAt":at(-5)})), "read after it ended");
    assert!(!paused_for(&op, &json!({"firstReadAt":null})));
    op.deadline = at(-30);
    assert!(!paused_for(&op, &json!({"firstReadAt":at(-20)})), "read after the deadline");
}
