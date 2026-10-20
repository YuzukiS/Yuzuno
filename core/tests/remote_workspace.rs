use serde_json::json;
use yuzuno_workspace::{model::AgentDetail, remote::RemoteMachine, store::Store};

fn detail() -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"agent-a","name":"Mikan","goal":"Recover work","cwd":"/tmp","model":"","color":"sage","threadId":"thread-a","status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

#[test]
fn legacy_workspace_gains_stable_identity_and_keeps_machine_configuration() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("workspace.sqlite");
    let identity;
    {
        let store = Store::open(&path).unwrap();
        let legacy = detail();
        assert!(legacy.agent.remote.is_none());
        assert_eq!(legacy.agent.connection_state, "disconnected");
        store.insert(&legacy).unwrap();
        identity = store.workspace_id().unwrap();
        store.add_machine(&RemoteMachine { id:"mac".into(), name:"Mac mini".into(), target:"test-mac".into(), codex:"/opt/homebrew/bin/codex".into(), default_cwd:"/Users/test/project".into(), ..Default::default() }).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.workspace_id().unwrap(), identity);
    assert_eq!(store.machine("mac").unwrap().target, "test-mac");
    assert_eq!(store.detail("agent-a").unwrap().agent.id, "agent-a");
}

#[test]
fn recovered_completion_and_late_live_event_make_one_unread_result() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    store.insert(&detail()).unwrap();
    let completed = json!({"id":"turn-a","status":"completed","items":[{"id":"answer-a","type":"agentMessage","phase":"final_answer","text":"Offline work completed."}]});
    store.update("agent-a", "thread/reconciled", &json!({}), |d| {
        d.turns.push(completed.clone());
    }).unwrap();
    store.record_recovered_completion("agent-a", &completed).unwrap();
    store.record_recovered_completion("agent-a", &completed).unwrap();
    let event = json!({"turn":completed});
    store.update("agent-a", "turn/completed", &event, |d| d.apply("turn/completed", &event)).unwrap();
    let d = store.detail("agent-a").unwrap();
    assert_eq!(d.agent.unread_count, 1);
    assert_eq!(d.turns.len(), 1);
    let catchup = store.catchup().unwrap();
    assert_eq!(catchup["items"].as_array().unwrap().iter().filter(|i| i["kind"] == "result").count(), 1);
    assert_eq!(catchup["items"][0]["itemId"], "answer-a");
    store.review("agent-a", d.agent.last_seq).unwrap();
    store.record_recovered_completion("agent-a", &completed).unwrap();
    assert_eq!(store.detail("agent-a").unwrap().agent.unread_count, 0);
}

#[test]
fn remote_identity_and_read_state_survive_core_restart_but_connection_does_not() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("workspace.sqlite");
    {
        let store = Store::open(&path).unwrap();
        let mut d = detail();
        d.agent.remote = Some(serde_json::from_value(json!({"machine":{"id":"mac","name":"Mac mini","target":"test-mac","codex":"/opt/homebrew/bin/codex","defaultCwd":"/Users/test"},"runtime":null})).unwrap());
        d.agent.connection_state = "connected".into();
        d.agent.reviewed_seq = 3;
        store.insert(&d).unwrap();
    }
    let store = Store::open(&path).unwrap();
    let d = store.detail("agent-a").unwrap();
    assert_eq!(d.agent.remote.unwrap().machine.id, "mac");
    assert_eq!(d.agent.thread_id.as_deref(), Some("thread-a"));
    assert_eq!(d.agent.reviewed_seq, 3);
    assert_eq!(d.agent.connection_state, "disconnected");
    assert_eq!(d.agent.status, "offline");
}

#[test]
fn native_resolved_does_not_dismiss_stale_request_from_another_connection() {
    let mut d = detail();
    for generation in [1, 2] {
        d.pending.push(serde_json::from_value(json!({
            "id":format!("request-{generation}"),"agentId":"agent-a",
            "method":"item/commandExecution/requestApproval","createdAt":"",
            "stale":generation==1,"params":{"_rpcId":0,"_runtimeGeneration":generation}
        })).unwrap());
    }
    d.apply("serverRequest/resolved", &json!({"requestId":0,"_runtimeGeneration":2}));
    assert_eq!(d.pending.len(), 1);
    assert_eq!(d.pending[0].params["_runtimeGeneration"], 1);
}

#[test]
fn snapshot_saved_before_crash_can_still_gain_its_missing_completion_record() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("workspace.sqlite");
    let completed = json!({"id":"offline","status":"completed","items":[
        {"id":"answer","type":"agentMessage","phase":"final_answer","text":"Recovered after crash"}]});
    {
        let store = Store::open(&path).unwrap();
        let mut d = detail(); d.turns.push(completed.clone()); store.insert(&d).unwrap();
    }
    let store = Store::open(&path).unwrap();
    store.record_recovered_completion("agent-a", &completed).unwrap();
    assert_eq!(store.detail("agent-a").unwrap().agent.unread_count, 1);
    assert_eq!(store.catchup().unwrap()["items"][0]["itemId"], "answer");
}

#[test]
fn metadata_does_not_hide_item_changes_or_invent_new_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    store.insert(&detail()).unwrap();
    let requested = store.rev("agent-a");
    store.update("agent-a", "thread/status/changed", &json!({"status":{"type":"active"}}), |_| {}).unwrap();
    assert!(store.changed_items_since("agent-a", requested).unwrap().items.is_empty());
    assert!(!store.has_error_since("agent-a", 0).unwrap());
    store.update("agent-a", "item/agentMessage/delta", &json!({"itemId":"changed","delta":"next"}), |_| {}).unwrap();
    assert_eq!(store.changed_items_since("agent-a", requested).unwrap().items.into_iter().collect::<Vec<_>>(), vec!["changed"]);
}
