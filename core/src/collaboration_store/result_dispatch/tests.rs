use super::*;
use crate::model::AgentDetail;

fn legacy_change(store: &Store, kind: &str, patch: Value) {
    let mut db = store.db.write().unwrap();
    let tx = db.transaction().unwrap();
    let (id, _) = task_key(&tx, "T-1").unwrap();
    let raw: String = tx
        .query_row(
            "SELECT data FROM collaboration_tasks WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    let mut data: Value = serde_json::from_str(&raw).unwrap();
    data.as_object_mut().unwrap().remove("dispatch");
    data["version"] = json!(data["version"].as_i64().unwrap() + 1);
    data["updatedAt"] = json!(now());
    for (key, value) in patch.as_object().unwrap() {
        if key == "archived" {
            data["archivedAt"] = if value == &json!(true) {
                json!(now())
            } else {
                Value::Null
            };
        } else {
            data[key] = value.clone();
        }
    }
    tx.execute(
        "UPDATE collaboration_tasks SET version=?2,data=?3 WHERE id=?1",
        params![id, data["version"].as_i64(), data.to_string()],
    )
    .unwrap();
    activity(
        &tx,
        &id,
        kind,
        &TaskActor {
            kind: "user".into(),
            id: "user".into(),
            name: "You".into(),
        },
        &Value::Null,
        json!({"changes":patch}),
    )
    .unwrap();
    tx.commit().unwrap();
}

fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["lead", "dev", "other"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":id,
            "cwd":"/workspace","model":"test","color":"sage","threadId":format!("session-{id}"),
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
        .unwrap();
        store.insert(&agent).unwrap();
    }
    store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"create","title":"Deliver the same goal"}),
        )
        .unwrap();
    (dir, store)
}

fn task(store: &Store) -> Value {
    store
        .collaboration_call(None, "task_get", json!({"taskId":"T-1"}))
        .unwrap()
}

fn dispatch(store: &Store, author: Option<&str>, to: &str, request: &str) -> Value {
    store
        .collaboration_call(
            author,
            "task_dispatch",
            json!({"requestId":request,"taskId":"T-1",
        "expectedVersion":task(store)["task"]["version"],"toAgentId":to}),
        )
        .unwrap()
}

fn submission(store: &Store, dispatch: &Value, request: &str) -> Value {
    json!({"requestId":request,"taskId":"T-1","expectedVersion":task(store)["task"]["version"],
        "dispatchId":dispatch["message"]["dispatchId"],"summary":"已完成 targeted verification",
        "links":[{"label":"Evidence","url":"https://example.test/evidence"}]})
}

fn mail(store: &Store, recipient: &str) -> Value {
    store
        .collaboration_call(None, "peer_read", json!({"agentId":recipient}))
        .unwrap()["messages"]
        .clone()
}

#[test]
fn result_revision_notifies_once_per_submission_and_survives_restart() {
    let (dir, store) = fixture();
    let dispatch = dispatch(&store, Some("lead"), "dev", "dispatch");
    assert_eq!(
        dispatch["message"]["dispatchId"],
        dispatch["task"]["dispatch"]["id"]
    );
    store
        .update("dev", "test/turn", &json!({}), |d| {
            d.turns
                .push(json!({"id":"original-turn","status":"inProgress","items":[]}));
        })
        .unwrap();
    let input = submission(&store, &dispatch, "result-1");
    let first = store
        .collaboration_call(Some("dev"), "task_submit_result", input.clone())
        .unwrap();
    let message = &first["message"];
    assert_eq!(first["task"]["status"], "review");
    assert_eq!(message["sender"]["kind"], "system");
    assert_eq!(message["notice"]["kind"], "system");
    assert_eq!(message["recipient"]["id"], "lead");
    assert_eq!(message["reportedBy"]["id"], "dev");
    assert_eq!(message["source"]["turnId"], "original-turn");
    assert_eq!(message["priority"], "normal");
    assert_eq!(message["resultId"], first["activity"]["result"]["id"]);
    assert!(message["body"].as_str().unwrap().contains("已完成"));
    assert!(message["body"]
        .as_str()
        .unwrap()
        .contains("not independent review"));
    assert_eq!(
        first["activity"]["result"]["links"][0]["url"],
        "https://example.test/evidence"
    );
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    assert_eq!(
        store
            .collaboration_call(Some("dev"), "task_submit_result", input)
            .unwrap(),
        first
    );
    assert_eq!(mail(&store, "lead").as_array().unwrap().len(), 1);
    assert_eq!(store.pending_peer_deliveries().unwrap().len(), 2);
    let revision = submission(&store, &dispatch, "result-2");
    let second = store
        .collaboration_call(Some("dev"), "task_submit_result", revision)
        .unwrap();
    assert_ne!(first["message"]["id"], second["message"]["id"]);
    assert_ne!(
        first["activity"]["result"]["id"],
        second["activity"]["result"]["id"]
    );
    assert_eq!(mail(&store, "lead").as_array().unwrap().len(), 2);
    // A retained activity, not only the mutable latest result, is addressable.
    let original = store
        .collaboration_call(
            None,
            "task_get",
            json!({"taskId":"T-1",
        "afterSeq":first["activity"]["seq"].as_i64().unwrap()-1,"limit":1}),
        )
        .unwrap();
    assert_eq!(original["activities"][0]["result"], first["task"]["result"]);
}

#[test]
fn redispatch_rejects_old_executor_even_with_fresh_version_or_omitted_identity() {
    let (_dir, store) = fixture();
    let original = dispatch(&store, Some("lead"), "dev", "first");
    for (to, key) in [("dev", "same-agent-again"), ("other", "different-agent")] {
        let next = dispatch(&store, Some("lead"), to, key);
        assert_ne!(
            original["message"]["dispatchId"],
            next["message"]["dispatchId"]
        );
        let before = task(&store);
        let mut input = submission(&store, &original, key);
        assert!(store
            .collaboration_call(Some("dev"), "task_submit_result", input.clone())
            .unwrap_err()
            .to_string()
            .starts_with("stale_dispatch:"));
        input.as_object_mut().unwrap().remove("dispatchId");
        assert!(store
            .collaboration_call(Some("dev"), "task_submit_result", input)
            .unwrap_err()
            .to_string()
            .starts_with("dispatch_id_required:"));
        assert_eq!(task(&store), before);
        assert_eq!(mail(&store, "lead"), json!([]));
    }
}

#[test]
fn invalidated_assignment_stays_invalid_after_reopen_or_reassignment_back() {
    for (patch, restore) in [
        (json!({"status":"cancelled"}), json!({"status":"doing"})),
        (json!({"archived":true}), json!({"archived":false})),
        (
            json!({"assigneeAgentId":"other"}),
            json!({"assigneeAgentId":"dev"}),
        ),
        (
            json!({"assigneeAgentId":null}),
            json!({"assigneeAgentId":"dev"}),
        ),
    ] {
        let (_dir, store) = fixture();
        let original = dispatch(&store, Some("lead"), "dev", "dispatch");
        for (i, patch) in [patch, restore].into_iter().enumerate() {
            store
                .collaboration_call(
                    None,
                    "task_update",
                    json!({"requestId":format!("edit-{i}"),
                "taskId":"T-1","expectedVersion":task(&store)["task"]["version"],"patch":patch}),
                )
                .unwrap();
            let before = task(&store);
            assert_eq!(before["task"]["dispatch"]["active"], false);
            assert!(store
                .collaboration_call(
                    Some("dev"),
                    "task_submit_result",
                    submission(&store, &original, "late")
                )
                .unwrap_err()
                .to_string()
                .starts_with("stale_dispatch:"));
            assert_eq!(before, task(&store));
        }
    }
}

#[test]
fn non_assignment_updates_do_not_invalidate_dispatch() {
    let (_dir, store) = fixture();
    let d = dispatch(&store, Some("lead"), "dev", "dispatch");
    store
        .collaboration_call(
            None,
            "task_update",
            json!({"requestId":"progress","taskId":"T-1","expectedVersion":2,
        "patch":{"progress":"Ready","assigneeAgentId":"dev"}}),
        )
        .unwrap();
    let result = store
        .collaboration_call(
            Some("dev"),
            "task_submit_result",
            submission(&store, &d, "result"),
        )
        .unwrap();
    assert_eq!(result["message"]["recipient"]["id"], "lead");
}

#[test]
fn unbound_collaborator_and_gui_remain_supported_without_guessing_recipient() {
    let (_dir, store) = fixture();
    let d = dispatch(&store, Some("lead"), "dev", "dispatch");
    for author in [Some("other"), None] {
        let input = submission(&store, &d, "unbound");
        assert!(store
            .collaboration_call(author, "task_submit_result", input.clone())
            .unwrap_err()
            .to_string()
            .starts_with("dispatch_actor_mismatch:"));
        let mut unbound = input;
        unbound.as_object_mut().unwrap().remove("dispatchId");
        let result = store
            .collaboration_call(author, "task_submit_result", unbound)
            .unwrap();
        assert_eq!(
            result["task"]["result"]["notification"]["state"],
            "not_requested"
        );
        assert!(result.get("message").is_none());
    }
    assert_eq!(mail(&store, "lead"), json!([]));
    let d = dispatch(&store, None, "dev", "gui-dispatch");
    let result = store
        .collaboration_call(
            Some("dev"),
            "task_submit_result",
            submission(&store, &d, "gui-result"),
        )
        .unwrap();
    assert_eq!(
        result["task"]["result"]["notification"]["reason"],
        "user_dispatch"
    );
    assert!(result.get("message").is_none());
}

#[test]
fn legacy_task_and_dispatch_receipts_keep_their_original_contract() {
    let (dir, store) = fixture();
    // Old activity has assignment but no tracked dispatch identity.
    let key = task_key(&store.db.read().unwrap(), "T-1").unwrap().0;
    activity(
        &store.db.write().unwrap(),
        &key,
        "dispatched",
        &TaskActor {
            kind: "user".into(),
            id: "user".into(),
            name: "You".into(),
        },
        &Value::Null,
        json!({"changes":{"assigneeAgentId":"dev","status":"doing"}}),
    )
    .unwrap();
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let result = store
        .collaboration_call(
            Some("dev"),
            "task_submit_result",
            json!({"requestId":"legacy","taskId":"T-1",
        "expectedVersion":1,"summary":"Legacy client result","status":"done"}),
        )
        .unwrap();
    assert_eq!(result["task"]["status"], "done");
    assert!(result.get("message").is_none());
}

#[test]
fn closed_or_deleted_recipient_preserves_result_and_explicit_delivery_error() {
    for delete in [false, true] {
        let (_dir, store) = fixture();
        let d = dispatch(&store, Some("lead"), "dev", "dispatch");
        store
            .update("lead", "closed", &json!({}), |detail| {
                detail.agent.closed_at = Some(now());
            })
            .unwrap();
        if delete {
            store.delete_closed_agent("lead").unwrap();
        }
        let input = submission(&store, &d, "result");
        let result = store
            .collaboration_call(Some("dev"), "task_submit_result", input.clone())
            .unwrap();
        assert_eq!(result["task"]["result"]["notification"]["state"], "error");
        assert_eq!(
            result["message"]["delivery"]["detail"]["reason"],
            if delete {
                "recipient_deleted"
            } else {
                "recipient_closed"
            }
        );
        assert_eq!(mail(&store, "lead").as_array().unwrap().len(), 1);
        assert!(!store
            .pending_peer_deliveries()
            .unwrap()
            .iter()
            .any(|d| d["agentId"] == "lead"));
        assert_eq!(
            store
                .collaboration_call(Some("dev"), "task_submit_result", input)
                .unwrap(),
            result
        );
    }
}

#[test]
fn failure_at_mail_or_receipt_rolls_back_result_activity_and_message() {
    for table in ["collaboration_messages", "collaboration_requests"] {
        let (_dir, store) = fixture();
        let d = dispatch(&store, Some("lead"), "dev", "dispatch");
        let before = task(&store);
        let input = submission(&store, &d, "result");
        store.db.write().unwrap().execute_batch(&format!("CREATE TRIGGER fail_insert BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'injected write failure'); END;")).unwrap();
        assert!(store
            .collaboration_call(Some("dev"), "task_submit_result", input.clone())
            .is_err());
        assert_eq!(task(&store), before);
        assert_eq!(mail(&store, "lead"), json!([]));
        store
            .db
            .write()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_insert")
            .unwrap();
        store
            .collaboration_call(Some("dev"), "task_submit_result", input)
            .unwrap();
        assert_eq!(mail(&store, "lead").as_array().unwrap().len(), 1);
    }
}

#[test]
fn legacy_json_rewrite_recovers_identity_and_original_recipient_from_activity() {
    let (dir, store) = fixture();
    let d = dispatch(&store, Some("lead"), "dev", "dispatch");
    legacy_change(&store, "updated", json!({"progress":"old build progress"}));
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    assert_eq!(task(&store)["task"]["dispatch"], d["task"]["dispatch"]);
    let listed = store
        .collaboration_call(None, "task_list", json!({}))
        .unwrap();
    assert_eq!(listed["tasks"][0]["dispatch"], d["task"]["dispatch"]);
    let result = store
        .collaboration_call(
            Some("dev"),
            "task_submit_result",
            submission(&store, &d, "result"),
        )
        .unwrap();
    assert_eq!(result["message"]["recipient"]["id"], "lead");
}

#[test]
fn legacy_reassignment_cancellation_and_archive_do_not_restore_old_dispatch() {
    for (patch, restore) in [
        (
            json!({"assigneeAgentId":"other"}),
            json!({"assigneeAgentId":"dev"}),
        ),
        (json!({"status":"cancelled"}), json!({"status":"doing"})),
        (json!({"archived":true}), json!({"archived":false})),
    ] {
        let (_dir, store) = fixture();
        let d = dispatch(&store, Some("lead"), "dev", "dispatch");
        legacy_change(&store, "updated", patch);
        legacy_change(&store, "updated", restore);
        assert_eq!(task(&store)["task"]["dispatch"]["active"], false);
        let input = submission(&store, &d, "stale");
        assert!(store
            .collaboration_call(Some("dev"), "task_submit_result", input)
            .unwrap_err()
            .to_string()
            .starts_with("stale_dispatch:"));
    }
}

#[test]
fn legacy_redispatch_is_ambiguous_but_history_never_locks_other_tasks() {
    let (_dir, store) = fixture();
    let d = dispatch(&store, Some("lead"), "dev", "dispatch");
    legacy_change(
        &store,
        "dispatched",
        json!({"assigneeAgentId":"other","status":"doing"}),
    );
    assert!(task(&store)["task"].get("dispatch").is_none());
    for actor in ["dev", "other"] {
        let mut input = submission(&store, &d, "late");
        assert!(store
            .collaboration_call(Some(actor), "task_submit_result", input.clone())
            .unwrap_err()
            .to_string()
            .starts_with("stale_dispatch:"));
        input.as_object_mut().unwrap().remove("dispatchId");
        assert!(store
            .collaboration_call(Some(actor), "task_submit_result", input)
            .unwrap_err()
            .to_string()
            .starts_with("dispatch_id_required:"));
    }
    store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"other-task","title":"Unrelated goal"}),
        )
        .unwrap();
    let result = store.collaboration_call(Some("dev"), "task_submit_result", json!({"requestId":"unrelated","taskId":"T-2","expectedVersion":1,"summary":"Independent collaboration"})).unwrap();
    assert_eq!(result["task"]["status"], "review");
    assert!(result.get("message").is_none());
}

#[test]
fn concurrent_identical_submissions_commit_only_one_result_and_notification() {
    let (_dir, store) = fixture();
    let d = dispatch(&store, Some("lead"), "dev", "dispatch");
    let input = submission(&store, &d, "same-result");
    let store = std::sync::Arc::new(store);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let (store, barrier, input) = (store.clone(), barrier.clone(), input.clone());
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .collaboration_call(Some("dev"), "task_submit_result", input)
                    .unwrap()
            })
        })
        .collect();
    let replies: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(replies[0], replies[1]);
    assert_eq!(mail(&store, "lead").as_array().unwrap().len(), 1);
    assert_eq!(
        task(&store)["activities"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["kind"] == "result")
            .count(),
        1
    );
}
