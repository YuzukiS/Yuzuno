#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::json;
use yuzuno_workspace::{model::AgentDetail, rpc::RpcError, store::Store};

fn empty() -> AgentDetail {
    serde_json::from_value(json!({
        "agent":{"id":"stable-agent","name":"小柚","goal":"保持身份","cwd":"/tmp","model":"",
            "color":"yuzu","threadId":"native-empty","status":"idle","createdAt":"","updatedAt":"",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]
    }))
    .unwrap()
}

fn attach(store: &Store) {
    store.insert(&empty()).unwrap();
    store
        .update(
            "stable-agent",
            "thread/attached",
            &json!({"threadId":"native-empty",
        "newEmptyThread":true,"turnRequestJournalVersion":1}),
            |_| {},
        )
        .unwrap();
}

#[test]
fn only_the_measured_missing_rollout_error_can_allow_replacement() {
    for (code, message, data, expected) in [
        (
            -32600,
            "no rollout found for thread id native-empty",
            None,
            true,
        ),
        (-32600, "thread not loaded: native-empty", None, false),
        (
            -32600,
            "no rollout found for thread id another-thread",
            None,
            false,
        ),
        (
            -32600,
            "Permission denied while reading rollout",
            None,
            false,
        ),
        (
            -32603,
            "no rollout found for thread id native-empty",
            None,
            false,
        ),
        (
            -32600,
            "no rollout found for thread id native-empty",
            Some(json!({"permissionDenied":true})),
            false,
        ),
    ] {
        let error = RpcError {
            code,
            message: message.into(),
            data,
        };
        assert_eq!(error.confirms_missing_rollout("native-empty"), expected);
    }
}

#[test]
fn unused_empty_thread_reserves_once_and_preserves_workspace_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    {
        let store = Store::open(&path).unwrap();
        attach(&store);
    }
    let store = Store::open(&path).unwrap();
    assert!(store
        .begin_empty_thread_replacement("stable-agent", "native-empty")
        .unwrap());
    let detail = store.detail("stable-agent").unwrap();
    assert_eq!(detail.agent.id, "stable-agent");
    assert_eq!(detail.agent.goal, "保持身份");
    assert_eq!(detail.agent.thread_id.as_deref(), Some("native-empty"));
    assert_eq!(detail.agent.status, "uncertain");
    assert!(!store
        .begin_empty_thread_replacement("stable-agent", "native-empty")
        .unwrap());
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert!(!reopened
        .begin_empty_thread_replacement("stable-agent", "native-empty")
        .unwrap());
}

#[test]
fn a_turn_attempt_or_unknown_outcome_never_becomes_an_unused_thread() {
    for (kind, evidence) in [
        ("turn/requested", json!({"threadId":"native-empty"})),
        ("turn/rejected", json!({"message":"permission denied"})),
        ("turn/accepted", json!({"turn":{"id":"turn"}})),
        ("item/started", json!({"turnId":"turn"})),
        ("request", json!({"turnId":"turn"})),
        ("runtime/error", json!({"outcomeUnknown":true})),
        (
            "thread/replacementRequested",
            json!({"oldThreadId":"native-empty"}),
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workspace.sqlite")).unwrap();
        attach(&store);
        store
            .update("stable-agent", kind, &evidence, |_| {})
            .unwrap();
        assert!(
            !store
                .begin_empty_thread_replacement("stable-agent", "native-empty")
                .unwrap(),
            "{kind}"
        );
    }
}

#[test]
fn existing_turn_or_legacy_unjournaled_creation_prevents_replacement() {
    for legacy in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workspace.sqlite")).unwrap();
        if legacy {
            store.insert(&empty()).unwrap();
            store
                .update(
                    "stable-agent",
                    "thread/attached",
                    &json!({"threadId":"native-empty"}),
                    |_| {},
                )
                .unwrap();
        } else {
            attach(&store);
            store
                .update("stable-agent", "fixture", &json!({}), |detail| {
                    detail
                        .turns
                        .push(json!({"id":"turn","status":"completed","items":[]}));
                })
                .unwrap();
        }
        assert!(!store
            .begin_empty_thread_replacement("stable-agent", "native-empty")
            .unwrap());
    }
}

#[test]
fn second_core_cannot_open_or_change_an_owned_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let first = Store::open(&path).unwrap();
    attach(&first);
    let before = serde_json::to_value(first.detail("stable-agent").unwrap()).unwrap();
    let second = Store::open(&path);
    assert!(second.is_err());
    assert!(second.err().unwrap().to_string().contains("独占锁"));
    assert_eq!(
        serde_json::to_value(first.detail("stable-agent").unwrap()).unwrap(),
        before
    );
    let independent = Store::open(&directory.path().join("other/workspace.sqlite")).unwrap();
    drop(independent);
    drop(first);
    let restarted = Store::open(&path).unwrap();
    assert_eq!(
        restarted.detail("stable-agent").unwrap().agent.status,
        "offline"
    );
}
