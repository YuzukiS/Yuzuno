use super::super::state::{Launch, Layout, ReleaseRef};
use super::*;
use crate::collaboration_runtime::tests::{finish, fixture, working};

fn waiting(dir: &std::path::Path, ws: &Workspace, id: &str) -> Operation {
    let root = dir.join("managed");
    std::fs::create_dir_all(&root).unwrap();
    let layout = Layout::open(&root).unwrap();
    let _ = ws.update_notice_layout.set(layout.clone());
    let op = Operation {
        id: id.into(),
        request_id: uuid::Uuid::new_v4().to_string(),
        release_id: "candidate".into(),
        phase: Phase::Waiting,
        started_at: crate::model::now(),
        updated_at: crate::model::now(),
        deadline: (chrono::Utc::now() + chrono::Duration::minutes(20)).to_rfc3339(),
        error: None,
        recovered_sessions: 0,
        total_sessions: 0,
        previous: ReleaseRef {
            release_id: "previous".into(),
            manifest_sha256: "a".repeat(64),
        },
        candidate: ReleaseRef {
            release_id: "candidate".into(),
            manifest_sha256: "b".repeat(64),
        },
        old_process: ProcessIdentity::read(std::process::id()).unwrap(),
        helper_process: None,
        new_process: None,
        stopping_process: None,
        records_proof: None,
        workspace_id: ws.store.workspace_id().unwrap(),
        token: "private-test-token".into(),
        launch: Launch {
            port: 4503,
            data_dir: ws.data_dir.clone(),
            cwd: dir.into(),
            codex: "unused".into(),
        },
        sessions: vec![],
    };
    layout
        .edit(|j| {
            j.operation = Some(op.clone());
            Ok(())
        })
        .unwrap();
    ws.admission.begin_drain(id).unwrap();
    op
}

async fn inbox(ws: &Arc<Workspace>) -> Value {
    ws.collaboration_call(Some("a"), "peer_read", json!({"priority":"urgent"}))
        .await
        .unwrap()
}

#[tokio::test]
async fn update_pause_is_one_original_turn_steer_while_ordinary_mail_stays_fenced() {
    let (dir, ws) = fixture().await;
    working(&ws);
    for priority in ["normal", "urgent"] {
        ws.collaboration_call(None,"peer_send",json!({"requestId":priority,"toAgentId":"a","priority":priority,"body":"ordinary work"})).await.unwrap();
    }
    let op = waiting(dir.path(), &ws, "one");
    ws.store.queue_update_pause(&op).unwrap();
    ws.store.queue_update_pause(&op).unwrap();
    assert_eq!(ws.store.update_pause_messages(&op.id).unwrap().len(), 1);
    let batches = ws.store.pending_peer_deliveries().unwrap();
    assert_eq!(batches.len(), 2);
    for batch in batches {
        ws.deliver_peer_batch(&batch).await.unwrap();
    }
    ws.deliver_update_notices().await.unwrap();
    ws.deliver_update_notices().await.unwrap();
    let calls = std::fs::read_to_string(dir.path().join("steers.jsonl")).unwrap();
    assert_eq!(calls.lines().count(), 1);
    let call: Value = serde_json::from_str(calls.lines().next().unwrap()).unwrap();
    assert_eq!(call["expectedTurnId"], "original-turn");
    assert!(call["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains("limit=1"));
    assert!(!dir.path().join("starts.jsonl").exists());
    let mail = ws.store.update_pause_messages(&op.id).unwrap().remove(0);
    assert_eq!(mail["delivery"]["state"], "delivered");
    assert!(mail["firstReadAt"].is_null());
    let read = ws
        .collaboration_call(
            Some("a"),
            "peer_read",
            json!({"priority":"urgent","afterSeq":mail["seq"].as_i64().unwrap()-1,"limit":1}),
        )
        .await
        .unwrap();
    assert_eq!(read["messages"][0]["updateWait"]["active"], true);
    assert_eq!(ws.store.pending_peer_deliveries().unwrap().len(), 2);
    assert!(!ws.update_pause_status(&op).unwrap()[0]["idle"]
        .as_bool()
        .unwrap());
    assert!(ws.admission.enter_work().is_err());
    assert!(ws.admission.enter_completion().is_ok());
    finish(&ws, "original-turn");
    assert_eq!(ws.update_pause_status(&op).unwrap()[0]["idle"], true);
    assert!(ws.admission.try_seal(&op.id).unwrap());
    ws.admission.reopen(&op.id).unwrap();
    ws.close_agent("a").await.unwrap();
}

#[tokio::test]
async fn idle_snapshot_and_turn_boundary_never_start_a_turn_for_pause() {
    let (dir, ws) = fixture().await;
    let op = waiting(dir.path(), &ws, "idle");
    ws.store.queue_update_pause(&op).unwrap();
    working(&ws);
    ws.store.queue_update_pause(&op).unwrap();
    ws.deliver_update_notices().await.unwrap();
    assert!(ws.store.update_pause_messages(&op.id).unwrap().is_empty());
    ws.admission.reopen(&op.id).unwrap();
    let op = waiting(dir.path(), &ws, "active");
    ws.store.queue_update_pause(&op).unwrap();
    finish(&ws, "original-turn");
    ws.deliver_update_notices().await.unwrap();
    assert_eq!(
        ws.store.update_pause_messages(&op.id).unwrap()[0]["delivery"]["detail"]["reason"],
        "original_turn_ended"
    );
    assert!(!dir.path().join("starts.jsonl").exists());
    assert!(!dir.path().join("steers.jsonl").exists());
    ws.admission.reopen(&op.id).unwrap();
    ws.close_agent("a").await.unwrap();
}

#[tokio::test]
async fn cancelled_expired_and_replaced_operations_make_late_reads_inert() {
    for end in ["cancelled", "timeout", "complete", "restart", "replacement"] {
        let (dir, ws) = fixture().await;
        working(&ws);
        let op = waiting(dir.path(), &ws, "first");
        ws.store.queue_update_pause(&op).unwrap();
        let layout = ws.update_notice_layout.get().unwrap();
        layout
            .edit_operation(&op.id, |o| {
                match end {
                    "cancelled" => o.phase = Phase::Cancelled,
                    "timeout" => {
                        o.deadline =
                            (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339()
                    }
                    "complete" => o.phase = Phase::Complete,
                    "restart" => o.old_process.start_ticks += 1,
                    _ => o.id = "new-operation".into(),
                }
                Ok(())
            })
            .unwrap();
        // Even before admission reopen, journal phase and deadline are checked.
        ws.deliver_update_notices().await.unwrap();
        let read = inbox(&ws).await;
        assert_eq!(read["messages"][0]["updateWait"]["active"], false, "{end}");
        assert!(read["messages"][0]["body"]
            .as_str()
            .unwrap()
            .contains("Do not pause"));
        assert_eq!(
            ws.store.update_pause_messages(&op.id).unwrap()[0]["sender"]["kind"],
            "system"
        );
        assert!(ws.store.pending_peer_deliveries().unwrap().is_empty());
        assert!(!dir.path().join("steers.jsonl").exists());
        finish(&ws, "original-turn");
        ws.admission.reopen(&op.id).unwrap();
        ws.close_agent("a").await.unwrap();
    }
}

#[tokio::test]
async fn lost_delivery_is_uncertain_and_never_replayed_or_claimed_idle() {
    let (dir, ws) = fixture().await;
    working(&ws);
    std::fs::write(dir.path().join("steer-mode"), "lost").unwrap();
    let op = waiting(dir.path(), &ws, "unknown");
    ws.store.queue_update_pause(&op).unwrap();
    ws.deliver_update_notices().await.unwrap();
    ws.deliver_update_notices().await.unwrap();
    assert_eq!(
        ws.store.update_pause_messages(&op.id).unwrap()[0]["delivery"]["state"],
        "uncertain"
    );
    assert_eq!(ws.update_pause_status(&op).unwrap()[0]["idle"], false);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("steers.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(!dir.path().join("starts.jsonl").exists());
    finish(&ws, "original-turn");
    ws.admission.reopen(&op.id).unwrap();
    ws.close_agent("a").await.unwrap();
}

#[tokio::test]
async fn hook_receipt_is_only_delivery_and_session_identity_cannot_move() {
    let (dir, ws) = fixture().await;
    working(&ws);
    let op = waiting(dir.path(), &ws, "hook");
    ws.store.queue_update_pause(&op).unwrap();
    let m = ws.store.update_pause_messages(&op.id).unwrap().remove(0);
    ws.store
        .set_update_pause_delivery(
            &m,
            "pending",
            "sending",
            json!({"mode":"hook","clientMessageId":"hook-client","turnId":"original-turn"}),
        )
        .unwrap();
    ws.store
        .record_peer_hook_delivery(
            "a",
            "old-client",
            "original-turn",
            Some("native-thread"),
            "injected",
        )
        .unwrap();
    assert_eq!(
        ws.update_pause_status(&op).unwrap()[0]["delivery"],
        "sending"
    );
    ws.store
        .record_peer_hook_delivery(
            "a",
            "hook-client",
            "original-turn",
            Some("native-thread"),
            "injected",
        )
        .unwrap();
    assert_eq!(
        ws.update_pause_status(&op).unwrap()[0]["delivery"],
        "delivered"
    );
    assert_eq!(ws.update_pause_status(&op).unwrap()[0]["idle"], false);
    ws.store
        .update("a", "test/session", &json!({}), |d| {
            d.agent.thread_id = Some("different-session".into())
        })
        .unwrap();
    assert_eq!(
        inbox(&ws).await["messages"][0]["updateWait"]["active"],
        false
    );
    finish(&ws, "original-turn");
    ws.admission.reopen(&op.id).unwrap();
    ws.close_agent("a").await.unwrap();
}
