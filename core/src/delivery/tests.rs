use crate::{github::client::Repository, store::Store};
use serde_json::{Value, json};
fn setup() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.insert(&serde_json::from_value(json!({"agent":{"id":"owner","name":"Owner","cwd":"/tmp","model":"test","color":"sage","threadId":"native","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    let task = s
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"task","title":"Fixed delivery","assigneeAgentId":"owner"}),
        )
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    link(&s, &task, "b");
    (dir, s, task)
}
fn link(s: &Store, task: &str, head: &str) {
    s.github_link_object(
        task,
        &Repository {
            id: 7,
            full_name: "o/r".into(),
        },
        "pull",
        1,
        json!({"baseSha":"a".repeat(40),"headSha":head.repeat(40),"state":"open"}),
    )
    .unwrap();
}
fn input(task: &str) -> Value {
    json!({"requestId":"enable","taskId":task,"linkId":"7:pull:1","baseSha":"a".repeat(40),"headSha":"b".repeat(40),"settings":{"harness":"codex","model":"gpt-6.1-sol"},"maxRounds":2})
}
fn enable(s: &Store, t: &str) -> Value {
    s.collaboration_call(None, "delivery_enable", input(t))
        .unwrap()["flow"]
        .clone()
}
fn get(s: &Store, t: &str) -> Value {
    s.collaboration_call(None, "delivery_get", json!({"taskId":t}))
        .unwrap()["flow"]
        .clone()
}
fn result(s: &Store, t: &str, candidate: Option<Value>, key: &str) -> Value {
    let version = s
        .collaboration_call(None, "task_get", json!({"taskId":t}))
        .unwrap()["task"]["version"]
        .clone();
    let mut v = json!({"requestId":key,"taskId":t,"expectedVersion":version,"summary":"Implementation and checks complete","status":"review"});
    if let Some(c) = candidate {
        v["delivery"] = c;
    }
    v
}
fn internal(s: &Store, t: &str) -> String {
    crate::collaboration_store::task_key(&s.db.read().unwrap(), t)
        .unwrap()
        .0
}
fn start(s: &Store, t: &str, id: &str) -> Value {
    let id_task = internal(s, t);
    let plan = s.delivery_claim(&id_task, "review").unwrap().unwrap();
    let input = serde_json::from_value::<crate::pr_review::Start>(plan.input.clone()).unwrap();
    let (run, created) = s.create_pr_review(Some("owner"), &input, id).unwrap();
    assert!(created);
    s.delivery_finish(&id_task, &plan, Ok(run.clone())).unwrap();
    run
}
fn finish(s: &Store, mut run: Value, conclusion: &str) {
    run["status"] = json!("completed");
    run["conclusion"] = json!(conclusion);
    run["baseSha"] = run["requestedBaseSha"].clone();
    run["headSha"] = run["requestedHeadSha"].clone();
    run["actualHarness"] = run["requestedHarness"].clone();
    run["actualModel"] = run["requestedModel"].clone();
    s.save_pr_review(&run, Some("Retained native report"))
        .unwrap();
}
#[test]
fn explicit_binding_and_result_receipt_are_atomic() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    assert_eq!(f["state"], "awaiting_result");
    assert!(
        s.delivery_claim(&internal(&s, &t), "review")
            .unwrap()
            .is_none()
    );
    s.collaboration_call(None, "task_submit_result", result(&s, &t, None, "ordinary"))
        .unwrap();
    assert_eq!(get(&s, &t)["state"], "awaiting_result");
    let mut bad = f["candidate"].clone();
    bad["headSha"] = json!("c".repeat(40));
    let v = result(&s, &t, Some(bad), "bad");
    assert!(s.collaboration_call(None, "task_submit_result", v).is_err());
    let v = result(&s, &t, Some(f["candidate"].clone()), "submit");
    let first = s
        .collaboration_call(None, "task_submit_result", v.clone())
        .unwrap();
    assert_eq!(
        s.collaboration_call(None, "task_submit_result", v).unwrap(),
        first
    );
    assert_eq!(
        get(&s, &t)["rounds"][0]["resultId"],
        first["task"]["result"]["id"]
    );
    let mut again = input(&t);
    again["requestId"] = json!("other");
    assert!(
        s.collaboration_call(None, "delivery_enable", again)
            .is_err()
    );
}
#[test]
fn manual_and_auto_share_attempt_and_lost_reply_survives_restart() {
    let (dir, s, t) = setup();
    let f = enable(&s, &t);
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "submit"),
    )
    .unwrap();
    let run = start(&s, &t, "native-1");
    let manual:crate::pr_review::Start=serde_json::from_value(json!({"requestId":"manual","taskId":t,"linkId":"7:pull:1","baseSha":"a".repeat(40),"headSha":"b".repeat(40)})).unwrap();
    assert_eq!(
        s.create_pr_review(None, &manual, "duplicate").unwrap(),
        (run.clone(), false)
    );
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.recover_pr_reviews().unwrap();
    assert_eq!(
        s.previous_pr_review(None, &manual).unwrap().unwrap()["id"],
        "native-1"
    );
    assert_eq!(get(&s, &t)["state"], "infrastructure_error");
    assert!(
        s.collaboration_call(None, "delivery_continue", next(&s, &t, "b"))
            .is_err()
    );
    assert!(
        s.delivery_claim(&internal(&s, &t), "review")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        s.list_pr_reviews(&t, None).unwrap()["reviews"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(s.delivery_reconcile(&internal(&s, &t)).unwrap());
    assert!(!s.delivery_reconcile(&internal(&s, &t)).unwrap());
}
fn next(s: &Store, t: &str, head: &str) -> Value {
    let f = get(s, t);
    let mut v = input(t);
    v.as_object_mut().unwrap().remove("maxRounds");
    v["requestId"] = json!(format!("continue-{head}"));
    v["flowId"] = f["id"].clone();
    v["expectedRound"] = json!(f["rounds"].as_array().unwrap().len());
    v["headSha"] = json!(head.repeat(40));
    v
}
#[test]
fn fixes_need_explicit_continuation_and_cannot_reset_cap() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "r1"),
    )
    .unwrap();
    finish(&s, start(&s, &t, "one"), "changes_requested");
    assert_eq!(get(&s, &t)["state"], "waiting_fix");
    s.github_refresh_object(
        "7:pull:1",
        Ok((
            Repository {
                id: 7,
                full_name: "o/r".into(),
            },
            json!({"baseSha":"a".repeat(40),"headSha":"c".repeat(40),"state":"open"}),
        )),
    )
    .unwrap();
    assert_eq!(get(&s, &t)["state"], "candidate_changed");
    assert!(
        s.delivery_claim(&internal(&s, &t), "review")
            .unwrap()
            .is_none()
    );
    s.collaboration_call(None, "delivery_continue", next(&s, &t, "c"))
        .unwrap();
    assert!(
        s.delivery_claim(&internal(&s, &t), "review")
            .unwrap()
            .is_none()
    );
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(get(&s, &t)["candidate"].clone()), "r2"),
    )
    .unwrap();
    finish(&s, start(&s, &t, "two"), "changes_requested");
    assert_eq!(get(&s, &t)["state"], "needs_judgment");
    assert!(
        s.collaboration_call(None, "delivery_continue", next(&s, &t, "c"))
            .is_err()
    );
}
#[test]
fn unknown_attempt_cannot_be_replaced_and_changed_settings_never_start() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "result"),
    )
    .unwrap();
    s.db.write()
        .unwrap()
        .execute(
            "INSERT INTO workspace_meta(key,value) VALUES('review.settings',?1)",
            [json!({"harness":"claude","model":"other"}).to_string()],
        )
        .unwrap();
    assert!(
        s.delivery_claim(&internal(&s, &t), "review")
            .unwrap()
            .is_none()
    );
    assert_eq!(get(&s, &t)["state"], "infrastructure_error");
    assert!(
        s.collaboration_call(None, "delivery_continue", next(&s, &t, "b"))
            .is_err()
    );
}
/// Uses the actual result transaction, native review store, CI subscription/
/// observation store and notifier. Only external model/GitHub answers are fixtures.
#[test]
fn isolated_delivery_wiring_ci_failure_ready_and_head_invalidation() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "result"),
    )
    .unwrap();
    finish(&s, start(&s, &t, "review"), "no_findings");
    let key = internal(&s, &t);
    let plan = s.delivery_claim(&key, "ci").unwrap().unwrap();
    let sub = s
        .ci_subscribe(
            Some("owner"),
            serde_json::from_value(plan.input.clone()).unwrap(),
            Repository {
                id: 7,
                full_name: "o/r".into(),
            },
            "pull",
            1,
        )
        .unwrap();
    // Lost response: claim discovers the committed subscription receipt.
    assert!(s.delivery_claim(&key, "ci").unwrap().is_none());
    let wid = sub["watchId"].as_str().unwrap();
    let observed = |conclusion: &str, head: &str, attempt: &str| crate::ci_monitor::Observed {
        runs: vec![
            json!({"id":format!("github:7:123:{attempt}"),"workflowId":8,"event":"pull_request","repositoryId":7,"runId":"123","attempt":attempt,"headSha":"b".repeat(40),"name":"Checks","rawStatus":"completed","status":conclusion,"conclusion":conclusion,"url":"https://github.com/o/r/actions/runs/123"}),
        ],
        head: Some(head.repeat(40)),
        pr: Some(json!({"baseSha":"a".repeat(40),"state":"open","merged":false})),
        truncated: false,
        checked: chrono::Utc::now().timestamp(),
        wait: 0,
        excluded: 0,
    };
    s.ci_observe(wid, Ok(observed("failure", "b", "1")))
        .unwrap();
    assert_eq!(get(&s, &t)["state"], "ci_failed");
    s.ci_observe(wid, Ok(observed("success", "b", "2")))
        .unwrap();
    assert_eq!(get(&s, &t)["state"], "ready_to_merge");
    s.delivery_reconcile(&key).unwrap();
    assert!(!s.delivery_reconcile(&key).unwrap());
    s.ci_observe(wid, Err("GitHub unavailable".into())).unwrap();
    assert_eq!(get(&s, &t)["state"], "infrastructure_error");
    s.ci_observe(wid, Ok(observed("success", "c", "2")))
        .unwrap();
    assert_eq!(get(&s, &t)["state"], "candidate_changed");
    assert!(s.delivery_claim(&key, "review").unwrap().is_none());
    let mail = s
        .collaboration_call(Some("owner"), "peer_read", json!({"afterSeq":0,"limit":50}))
        .unwrap();
    assert_eq!(
        mail["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["metadata"]["status"] == "ready_to_merge")
            .count(),
        1
    );
}

#[test]
fn review_launch_rechecks_assignment_after_claim_and_cannot_charge() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "result"),
    )
    .unwrap();
    let plan = s
        .delivery_claim(&internal(&s, &t), "review")
        .unwrap()
        .unwrap();
    let current = s
        .collaboration_call(None, "task_get", json!({"taskId":t}))
        .unwrap();
    s.collaboration_call(None,"task_update",json!({"requestId":"unassign","taskId":t,"expectedVersion":current["task"]["version"],"patch":{"assigneeAgentId":null}})).unwrap();
    let input = serde_json::from_value::<crate::pr_review::Start>(plan.input).unwrap();
    assert!(
        s.create_pr_review(Some("owner"), &input, "must-not-start")
            .is_err()
    );
    assert!(
        s.list_pr_reviews(&t, None).unwrap()["reviews"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(get(&s, &t)["state"], "needs_judgment");
}

#[test]
fn manual_unknown_revision_cannot_be_silently_duplicated_at_enable() {
    let (dir, s, t) = setup();
    let input = serde_json::from_value::<crate::pr_review::Start>(
        json!({"taskId":t,"requestId":"manual-unresolved","linkId":"7:pull:1"}),
    )
    .unwrap();
    s.create_pr_review(None, &input, "manual-unresolved")
        .unwrap();
    assert!(
        s.collaboration_call(None, "delivery_enable", self::input(&t))
            .is_err()
    );
    assert!(get(&s, &t).is_null());
    // Restart before source preparation resolved the manual review's revision.
    // It still owns its retained attempt even though its SHAs cannot be adopted.
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.recover_pr_reviews().unwrap();
    let original = s.previous_pr_review(None, &input).unwrap().unwrap();
    assert_eq!(original["status"], "unknown");
    assert!(original["baseSha"].is_null() && original["headSha"].is_null());
    let error = s
        .collaboration_call(None, "delivery_enable", self::input(&t))
        .unwrap_err();
    assert!(error.to_string().contains("reconcile that retained review"));
    assert!(get(&s, &t).is_null());
    let reviews = s.list_pr_reviews(&t, None).unwrap();
    assert_eq!(reviews["reviews"].as_array().unwrap().len(), 1);
    assert_eq!(reviews["reviews"][0]["id"], "manual-unresolved");
}

#[test]
fn setup_retries_are_bounded_and_reuse_the_same_request() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "result"),
    )
    .unwrap();
    let task = internal(&s, &t);
    let mut identity = None;
    for _ in 0..3 {
        let plan = s.delivery_claim(&task, "review").unwrap().unwrap();
        assert_eq!(
            identity.get_or_insert(plan.input["requestId"].clone()),
            &plan.input["requestId"]
        );
        s.delivery_finish(&task, &plan, Err("Reviewer admission unavailable".into()))
            .unwrap();
        s.db.write().unwrap().execute("UPDATE delivery_flows SET data=json_set(data,'$.rounds[0].review.nextTry',0) WHERE task_id=?1",[&task]).unwrap();
    }
    assert!(s.delivery_claim(&task, "review").unwrap().is_none());
    assert_eq!(get(&s, &t)["state"], "infrastructure_error");
    assert!(
        s.list_pr_reviews(&t, None).unwrap()["reviews"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

/// Runs the actual delivery worker, native review launch path, CI service and
/// notifier against a private Store and a local gh fixture. The first review
/// fails source preparation before any model is invoked; the second flow reuses
/// a completed independent-review fixture. No network or paid model calls.
#[cfg(unix)]
#[tokio::test]
async fn runtime_result_wakes_review_and_ci_and_terminal_events_reconcile() {
    use crate::workspace::Workspace;
    use std::{os::unix::fs::PermissionsExt, sync::Arc};
    let (dir, s, t) = setup();
    drop(s);
    let program = dir.path().join("gh-fixture");
    std::fs::write(dir.path().join("head"), "b").unwrap();
    std::fs::write(&program,r##"#!/usr/bin/python3
import json,pathlib,sys
root=pathlib.Path(__file__).parent
head=(root/'head').read_text().strip()*40
ep=next(a for a in sys.argv if a.startswith(('repos/','repositories/')))
with (root/'requests').open('a') as f:f.write(ep+'\n')
if ep in ('repositories/7','repos/o/r'):
 data={'id':7,'full_name':'o/r'}
elif ep=='repos/o/r/pulls/1':
 data={'number':1,'base':{'repo':{'id':7},'sha':'a'*40},'head':{'sha':head},'state':'open','merged':False}
elif ep.startswith('repos/o/r/actions/runs?'):
 data={'total_count':1,'workflow_runs':[{'id':123,'workflow_id':8,'run_attempt':1,'head_sha':'b'*40,'name':'Checks','repository':{'id':7},'event':'pull_request','status':'completed','conclusion':'success'}]}
else:
 print('Fixture source preparation unavailable',file=sys.stderr)
 sys.exit(1)
if '--include' in sys.argv:print('HTTP/2.0 200 OK\r\n\r\n',end='')
print(json.dumps(data))
"##).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut ws = Workspace::new(
        dir.path().into(),
        "/tmp".into(),
        "this-test-must-never-invoke-a-model".into(),
    )
    .unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program.to_string_lossy().into();
    let f = ws
        .collaboration_call(None, "delivery_enable", input(&t))
        .await
        .unwrap()["flow"]
        .clone();
    ws.start_delivery();
    let submitted = result(&ws.store, &t, Some(f["candidate"].clone()), "result");
    ws.collaboration_call(None, "task_submit_result", submitted.clone())
        .await
        .unwrap();
    async fn wait_for(ws: &Arc<Workspace>, t: &str, state: &str) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let flow = get(&ws.store, t);
                if flow["state"] == state && flow["rounds"][0]["ci"]["id"].is_string() {
                    return flow;
                };
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Expected {state}, got {}", get(&ws.store, t)))
    }
    let failed = wait_for(&ws, &t, "infrastructure_error").await;
    assert_eq!(failed["reviewEvidence"]["status"], "failed");
    let original_id = failed["reviewEvidence"]["id"].clone();
    ws.collaboration_call(None, "task_submit_result", submitted)
        .await
        .unwrap();
    super::tick(&ws).await.unwrap();
    assert_eq!(get(&ws.store, &t)["reviewEvidence"]["id"], original_id);
    assert_eq!(
        ws.store.list_pr_reviews(&t, None).unwrap()["reviews"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let t2=ws.collaboration_call(None,"task_create",json!({"requestId":"ready-task","title":"Reuse existing review","assigneeAgentId":"owner"})).await.unwrap()["task"]["id"].as_str().unwrap().to_owned();
    link(&ws.store, &t2, "b");
    let manual=serde_json::from_value::<crate::pr_review::Start>(json!({"requestId":"manual-ready","taskId":t2,"linkId":"7:pull:1","baseSha":"a".repeat(40),"headSha":"b".repeat(40)})).unwrap();
    let (run, _) = ws
        .store
        .create_pr_review(None, &manual, "existing-independent-review")
        .unwrap();
    finish(&ws.store, run, "no_findings");
    let mut enable = input(&t2);
    enable["requestId"] = json!("enable-ready");
    let f = ws
        .collaboration_call(None, "delivery_enable", enable)
        .await
        .unwrap()["flow"]
        .clone();
    ws.collaboration_call(
        None,
        "task_submit_result",
        result(&ws.store, &t2, Some(f["candidate"].clone()), "result-ready"),
    )
    .await
    .unwrap();
    let ready = wait_for(&ws, &t2, "ready_to_merge").await;
    assert_eq!(ready["reviewEvidence"]["id"], "existing-independent-review");
    assert_eq!(ready["ciEvidence"]["runs"][0]["conclusion"], "success");
    super::tick(&ws).await.unwrap();
    let mail = ws
        .store
        .collaboration_call(Some("owner"), "peer_read", json!({"afterSeq":0,"limit":50}))
        .unwrap();
    assert_eq!(
        mail["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["metadata"]["status"] == "ready_to_merge")
            .count(),
        1
    );

    std::fs::write(dir.path().join("head"), "c").unwrap();
    ws.store
        .db
        .write()
        .unwrap()
        .execute(
            "UPDATE ci_cache SET data=json_set(data,'$.fetchedAt',0)",
            [],
        )
        .unwrap();
    crate::ci_monitor::call(ws.clone(), None, "ci_refresh".into(), json!({"taskId":t2}))
        .await
        .unwrap();
    wait_for(&ws, &t2, "candidate_changed").await;
    let current = ws
        .collaboration_call(None, "task_get", json!({"taskId":t2}))
        .await
        .unwrap();
    ws.collaboration_call(None,"task_update",json!({"requestId":"runtime-done","taskId":t2,"expectedVersion":current["task"]["version"],"patch":{"status":"done"}})).await.unwrap();
    super::tick(&ws).await.unwrap();
    let closed = get(&ws.store, &t2);
    assert_eq!(closed["state"], "completed");
    assert_eq!(closed["ciEvidence"]["active"], false);
    let stop = json!({"requestId":"runtime-stop","taskId":t2,"flowId":f["id"]});
    let first = ws
        .collaboration_call(None, "delivery_stop", stop.clone())
        .await
        .unwrap();
    assert_eq!(first["flow"]["terminal"], closed["terminal"]);
    assert_eq!(
        ws.collaboration_call(None, "delivery_stop", stop)
            .await
            .unwrap(),
        first
    );
    assert_eq!(get(&ws.store, &t)["ciEvidence"]["active"], true);
    assert_eq!(
        ws.store.list_pr_reviews(&t2, None).unwrap()["reviews"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        std::fs::read_to_string(dir.path().join("requests"))
            .unwrap()
            .contains("actions/runs?")
    );
}

fn close_task(s: &Store, t: &str, patch: Value, request: &str) {
    let current = s
        .collaboration_call(None, "task_get", json!({"taskId":t}))
        .unwrap();
    s.collaboration_call(None,"task_update",json!({"requestId":request,"taskId":t,"expectedVersion":current["task"]["version"],"patch":patch})).unwrap();
}
fn subscribe_plan(s: &Store, t: &str) -> (super::store::Plan, Value) {
    let plan = s.delivery_claim(&internal(s, t), "ci").unwrap().unwrap();
    let sub = s
        .ci_subscribe(
            Some("owner"),
            serde_json::from_value(plan.input.clone()).unwrap(),
            Repository {
                id: 7,
                full_name: "o/r".into(),
            },
            "pull",
            1,
        )
        .unwrap();
    (plan, sub)
}
fn stopped(s: &Store, t: &str, f: &Value, request: &str) -> Value {
    s.collaboration_call(
        Some("owner"),
        "delivery_stop",
        json!({"requestId":request,"taskId":t,"flowId":f["id"]}),
    )
    .unwrap()["flow"]
        .clone()
}
#[test]
fn terminal_task_stop_is_idempotent_and_preserves_running_review_and_history() {
    for (patch, state) in [
        (json!({"status":"done"}), "completed"),
        (json!({"status":"cancelled"}), "cancelled"),
        (json!({"archived":true}), "archived"),
    ] {
        let (dir, s, t) = setup();
        let f = enable(&s, &t);
        s.collaboration_call(
            None,
            "task_submit_result",
            result(&s, &t, Some(f["candidate"].clone()), "result"),
        )
        .unwrap();
        let review = start(&s, &t, "still-running");
        let (plan, sub) = subscribe_plan(&s, &t);
        s.delivery_finish(&internal(&s, &t), &plan, Ok(sub.clone()))
            .unwrap();
        close_task(&s, &t, patch, "close");
        let final_flow = get(&s, &t);
        assert_eq!(final_flow["state"], state);
        assert_eq!(final_flow["enabled"], false);
        assert_eq!(final_flow["ciEvidence"]["active"], false);
        assert_eq!(final_flow["rounds"][0]["review"]["id"], review["id"]);
        assert_eq!(final_flow["reviewEvidence"]["status"], "preparing");
        assert_eq!(
            stopped(&s, &t, &f, "stop")["terminal"],
            final_flow["terminal"]
        );
        assert_eq!(
            stopped(&s, &t, &f, "stop-again")["terminal"],
            final_flow["terminal"]
        );
        // A reopened task does not reset the final outcome or review cap.
        close_task(&s, &t, json!({"status":"doing","archived":false}), "reopen");
        assert_eq!(get(&s, &t)["terminal"], final_flow["terminal"]);
        assert!(
            s.collaboration_call(None, "delivery_continue", next(&s, &t, "b"))
                .is_err()
        );
        let key = internal(&s, &t);
        assert!(s.delivery_reconcile(&key).unwrap());
        drop(s);
        let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        assert_eq!(get(&s, &t)["terminal"], final_flow["terminal"]);
        assert!(!s.delivery_reconcile(&key).unwrap());
        assert!(s.delivery_claim(&key, "ci").unwrap().is_none());
        assert!(s.delivery_tasks().unwrap().is_empty());
    }
}
#[test]
fn stopping_delivery_immediately_clears_its_live_ci_wait() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "result"),
    )
    .unwrap();
    let (plan, sub) = subscribe_plan(&s, &t);
    s.delivery_finish(&internal(&s, &t), &plan, Ok(sub))
        .unwrap();
    assert_eq!(
        s.live_ci_counts().unwrap()["agents"]["owner"]["discovering"],
        1
    );
    stopped(&s, &t, &f, "stop");
    assert_eq!(s.live_ci_counts().unwrap()["agents"], json!({}));
}

#[test]
fn stop_releases_automatic_interest_only_including_lost_reply_and_legacy_shared_id() {
    for legacy in [false, true] {
        let (_d, s, t) = setup();
        let f = enable(&s, &t);
        s.collaboration_call(
            None,
            "task_submit_result",
            result(&s, &t, Some(f["candidate"].clone()), "result"),
        )
        .unwrap();
        let (plan, auto) = subscribe_plan(&s, &t);
        let mut manual = plan.input.clone();
        manual["requestId"] = json!("manual-shared");
        let manual = s
            .ci_subscribe(
                Some("owner"),
                serde_json::from_value(manual).unwrap(),
                Repository {
                    id: 7,
                    full_name: "o/r".into(),
                },
                "pull",
                1,
            )
            .unwrap();
        assert_eq!(manual["id"], auto["id"]);
        if legacy {
            s.db.write()
                .unwrap()
                .execute("DELETE FROM ci_interests", [])
                .unwrap();
        }
        // Automatic response deliberately not attached to flow yet.
        let stopped = stopped(&s, &t, &f, "stop");
        assert_eq!(stopped["state"], "stopped");
        let sub = s.ci_list(None, Some(&t), None).unwrap()["subscriptions"][0].clone();
        assert_eq!(sub["active"], true);
        let interests = sub["interests"].as_array().unwrap();
        assert!(
            interests
                .iter()
                .any(|i| i["owner"] == "manual" && i["active"] == true)
        );
        assert!(
            interests
                .iter()
                .any(|i| i["owner"].as_str().unwrap().starts_with("delivery:")
                    && i["active"] == false)
        );
        // Late completion preserves the original CI ID, but cannot reactivate
        // the flow or its interest. Explicit unsubscribe still closes all.
        s.delivery_finish(&internal(&s, &t), &plan, Ok(auto.clone()))
            .unwrap();
        assert_eq!(get(&s, &t)["rounds"][0]["ci"]["id"], auto["id"]);
        assert_eq!(get(&s, &t)["terminal"], stopped["terminal"]);
        s.ci_unsubscribe(Some("owner"), auto["id"].as_str().unwrap())
            .unwrap();
        s.ci_subscribe(
            Some("owner"),
            serde_json::from_value(plan.input.clone()).unwrap(),
            Repository {
                id: 7,
                full_name: "o/r".into(),
            },
            "pull",
            1,
        )
        .unwrap();
        assert_eq!(
            s.ci_list(None, Some(&t), None).unwrap()["subscriptions"][0]["active"],
            false
        );
    }
}
#[test]
fn pending_subscription_cannot_commit_after_stop_or_assignment_change() {
    for stop in [false, true] {
        let (_d, s, t) = setup();
        let f = enable(&s, &t);
        s.collaboration_call(
            None,
            "task_submit_result",
            result(&s, &t, Some(f["candidate"].clone()), "result"),
        )
        .unwrap();
        let plan = s.delivery_claim(&internal(&s, &t), "ci").unwrap().unwrap();
        if stop {
            stopped(&s, &t, &f, "stop");
        } else {
            close_task(&s, &t, json!({"assigneeAgentId":null}), "unassign");
        }
        assert!(
            s.ci_subscribe(
                Some("owner"),
                serde_json::from_value(plan.input).unwrap(),
                Repository {
                    id: 7,
                    full_name: "o/r".into()
                },
                "pull",
                1
            )
            .unwrap_err()
            .to_string()
            .contains("authorization changed")
        );
        assert!(
            s.ci_list(None, Some(&t), None).unwrap()["subscriptions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
#[test]
fn observed_merge_freezes_outcome_and_leaves_main_run_verification_independent() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "result"),
    )
    .unwrap();
    let (plan, sub) = subscribe_plan(&s, &t);
    s.delivery_finish(&internal(&s, &t), &plan, Ok(sub.clone()))
        .unwrap();
    let main = s.ci_subscribe(Some("owner"),serde_json::from_value(json!({"requestId":"main","taskId":t,"url":"https://github.com/o/r/actions/runs/900","expectedSha":"c".repeat(40)})).unwrap(),Repository{id:7,full_name:"o/r".into()},"run",900).unwrap();
    s.ci_observe(
        sub["watchId"].as_str().unwrap(),
        Ok(crate::ci_monitor::Observed {
            runs: vec![],
            head: Some("b".repeat(40)),
            pr: Some(json!({"state":"closed","merged":true,"baseSha":"a".repeat(40)})),
            truncated: false,
            checked: chrono::Utc::now().timestamp(),
            wait: 0,
            excluded: 0,
        }),
    )
    .unwrap();
    let final_flow = get(&s, &t);
    assert_eq!(final_flow["state"], "merged");
    assert_eq!(final_flow["ciEvidence"]["active"], false);
    close_task(&s, &t, json!({"status":"done"}), "done");
    assert_eq!(get(&s, &t)["terminal"], final_flow["terminal"]);
    assert_eq!(stopped(&s, &t, &f, "stop")["state"], "merged");
    let subs = s.ci_list(None, Some(&t), None).unwrap();
    assert_eq!(
        subs["subscriptions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == main["id"])
            .unwrap()["active"],
        true
    );
}

/// What T-71 PR #72 R1 (review ca9067d8) recorded: the requested alias, and
/// the full id its native catalog row resolved to and the CLI then ran.
const OPUS_ALIAS: &str = "opus[1m]";
const OPUS: &str = "claude-opus-5-5[1m]";
fn claude(model: &str) -> Value {
    json!({"harness":"claude","model":model})
}
/// A flow authorized for `settings` whose review completed with passing
/// native evidence; `edit` changes that evidence before its terminal save.
fn reviewed(settings: Value, edit: impl FnOnce(&mut Value)) -> (tempfile::TempDir, Store, String) {
    let (d, s, t) = setup();
    s.save_review_settings(&serde_json::from_value(settings.clone()).unwrap())
        .unwrap();
    let mut v = input(&t);
    v["settings"] = settings;
    let f = s.collaboration_call(None, "delivery_enable", v).unwrap()["flow"].clone();
    s.collaboration_call(
        None,
        "task_submit_result",
        result(&s, &t, Some(f["candidate"].clone()), "result"),
    )
    .unwrap();
    let mut run = start(&s, &t, "review");
    run["status"] = json!("completed");
    run["conclusion"] = json!("no_findings");
    run["baseSha"] = run["requestedBaseSha"].clone();
    run["headSha"] = run["requestedHeadSha"].clone();
    run["actualHarness"] = run["requestedHarness"].clone();
    run["resolvedModel"] = json!(OPUS);
    run["actualModel"] = json!(OPUS);
    edit(&mut run);
    s.save_pr_review(&run, Some("Retained native report"))
        .unwrap();
    (d, s, t)
}
fn ci_green(s: &Store, t: &str) {
    let (plan, sub) = subscribe_plan(s, t);
    s.delivery_finish(&internal(s, t), &plan, Ok(sub.clone()))
        .unwrap();
    s.ci_observe(
        sub["watchId"].as_str().unwrap(),
        Ok(crate::ci_monitor::Observed {
            runs: vec![
                json!({"id":"github:7:123:1","workflowId":8,"event":"pull_request","repositoryId":7,"runId":"123","attempt":"1","headSha":"b".repeat(40),"name":"Checks","rawStatus":"completed","status":"success","conclusion":"success","url":"https://github.com/o/r/actions/runs/123"}),
            ],
            head: Some("b".repeat(40)),
            pr: Some(json!({"baseSha":"a".repeat(40),"state":"open","merged":false})),
            truncated: false,
            checked: chrono::Utc::now().timestamp(),
            wait: 0,
            excluded: 0,
        }),
    )
    .unwrap();
}
#[test]
fn claude_alias_passes_with_its_own_native_resolution_across_restart() {
    let (dir, s, t) = reviewed(claude(OPUS_ALIAS), |_| {});
    assert_eq!(get(&s, &t)["state"], "waiting_ci");
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.recover_pr_reviews().unwrap();
    assert_eq!(get(&s, &t)["state"], "waiting_ci");
    ci_green(&s, &t);
    let f = get(&s, &t);
    assert_eq!(f["state"], "ready_to_merge");
    assert_eq!(f["reviewEvidence"]["actualModel"], OPUS);
}
#[test]
fn claude_alias_resolution_never_covers_other_identity_or_revision() {
    let cases: [(&str, fn(&mut Value)); 13] = [
        ("missing resolution", |r| {
            r.as_object_mut().unwrap().remove("resolvedModel");
        }),
        ("null resolution", |r| r["resolvedModel"] = Value::Null),
        ("empty resolution", |r| r["resolvedModel"] = json!("")),
        ("blank resolution and model", |r| {
            r["resolvedModel"] = json!(" ");
            r["actualModel"] = json!(" ");
        }),
        ("non-text resolution", |r| {
            r["resolvedModel"] = json!({"model":OPUS})
        }),
        ("resolution for another model", |r| {
            r["resolvedModel"] = json!("claude-sonnet-5")
        }),
        ("same family, other id", |r| {
            r["actualModel"] = json!("claude-opus-5-5")
        }),
        ("other provider id", |r| {
            r["actualModel"] = json!("us.anthropic.claude-opus-5-5[1m]")
        }),
        ("requested model", |r| r["requestedModel"] = json!("sonnet")),
        ("requested harness", |r| {
            r["requestedHarness"] = json!("codex")
        }),
        ("actual harness", |r| r["actualHarness"] = json!("codex")),
        ("reviewed head", |r| r["headSha"] = json!("c".repeat(40))),
        ("reviewed base", |r| r["baseSha"] = json!("c".repeat(40))),
    ];
    for (case, edit) in cases {
        let (_d, s, t) = reviewed(claude(OPUS_ALIAS), edit);
        assert_eq!(get(&s, &t)["state"], "needs_judgment", "{case}");
        assert!(
            s.delivery_claim(&internal(&s, &t), "ci").unwrap().is_none(),
            "{case}"
        );
    }
}
#[test]
fn exact_models_and_old_records_keep_their_rules() {
    // Recorded before any resolution, or the CLI reported the requested id.
    let (_d, s, t) = reviewed(claude(OPUS), |r| {
        r.as_object_mut().unwrap().remove("resolvedModel");
    });
    assert_eq!(get(&s, &t)["state"], "waiting_ci");
    let (_d, s, t) = reviewed(claude(OPUS_ALIAS), |r| {
        r["resolvedModel"] = Value::Null;
        r["actualModel"] = json!(OPUS_ALIAS);
    });
    assert_eq!(get(&s, &t)["state"], "waiting_ci");
    // Codex has no alias path, even beside a matching resolution.
    let codex = json!({"harness":"codex","model":crate::pr_review::MODEL});
    let (_d, s, t) = reviewed(codex.clone(), |r| {
        r.as_object_mut().unwrap().remove("resolvedModel");
        r["actualModel"] = r["requestedModel"].clone();
    });
    assert_eq!(get(&s, &t)["state"], "waiting_ci");
    let (_d, s, t) = reviewed(codex, |r| {
        r["resolvedModel"] = json!("gpt-6.1");
        r["actualModel"] = json!("gpt-6.1");
    });
    assert_eq!(get(&s, &t)["state"], "needs_judgment");
}
#[test]
fn unfinished_claude_review_with_a_resolution_is_not_completion_after_restart() {
    let (dir, s, t) = reviewed(claude(OPUS_ALIAS), |r| r["status"] = json!("running"));
    assert_eq!(get(&s, &t)["state"], "waiting_review");
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.recover_pr_reviews().unwrap();
    assert_eq!(get(&s, &t)["state"], "infrastructure_error");
}

/// T-131: delivery takes the PR's full 40-character SHAs and says how to get
/// them; a 64-character SHA is not GitHub's and is refused too.
#[test]
fn delivery_refuses_an_abbreviated_sha_with_how_to_get_the_full_one() {
    let (_dir, s, t) = setup();
    for (key, sha) in [("baseSha", "aaaaaaa".to_owned()), ("headSha", "b".repeat(64))] {
        let mut request = input(&t);
        request[key] = json!(sha);
        let error = s.collaboration_call(None, "delivery_enable", request).unwrap_err().to_string();
        assert!(error.starts_with(&format!("{key} must be a full commit SHA, 40 hexadecimal characters, as GitHub shows it")), "{error}");
        assert!(error.contains("git rev-parse") && error.contains("github_links"), "{error}");
    }
    assert!(get(&s, &t).is_null(), "nothing was enabled");
    assert_eq!(enable(&s, &t)["candidate"]["headSha"], "b".repeat(40));
    let tools = crate::delivery::tool_definitions();
    let enable_tool = tools.iter().find(|tool| tool["name"] == "delivery_enable").unwrap();
    assert_eq!(enable_tool["inputSchema"]["properties"]["headSha"]["pattern"], "^[0-9a-fA-F]{40}$");
}

#[test]
fn approval_with_notes_waits_for_ci_and_retains_candidate_and_policy_gates() {
    let approved = |run: &mut Value| {
        run["conclusion"] = json!("approved_with_notes");
        run["policyVersion"] = json!(2);
        run["nativeCorrectness"] = json!("patch is correct");
        run["reasonCodes"] = json!([]);
        run["contextIncomplete"] = json!(false);
        run["findings"] = json!([{"priority":3,"body":"Keep this suggestion"}]);
    };
    let (_dir, store, task) = reviewed(claude(OPUS_ALIAS), approved);
    assert_eq!(get(&store, &task)["state"], "waiting_ci");
    ci_green(&store, &task);
    assert_eq!(get(&store, &task)["state"], "ready_to_merge");
    assert_eq!(store.pr_review_report(&task, "review").unwrap()["findings"][0]["body"], "Keep this suggestion");
    assert_ne!(store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["status"], "done");
    for edit in [
        (|r: &mut Value| r["policyVersion"] = json!(1)) as fn(&mut Value),
        |r| r["contextIncomplete"] = json!(true),
        |r| r["findings"][0]["priority"] = json!(2),
        |r| r["nativeCorrectness"] = json!("unknown"),
        |r| r["headSha"] = json!("c".repeat(40)),
    ] {
        let (_dir, store, task) = reviewed(claude(OPUS_ALIAS), |r| { approved(r); edit(r); });
        assert_eq!(get(&store, &task)["state"], "needs_judgment");
    }
}

/// A delivery reads, authorizes and starts the reviewer of its task's project,
/// as a review requested directly does (T-190).
#[test]
fn a_delivery_uses_the_reviewer_of_its_tasks_project() {
    let (_d, s, t) = setup();
    let project = s.create_project("Delivered", Default::default()).unwrap().id;
    crate::projects::set_task_project(&s.db.write().unwrap(), &internal(&s, &t), Some(&project)).unwrap();
    s.save_project_review_settings(&project, &serde_json::from_value(claude(OPUS_ALIAS)).unwrap()).unwrap();
    let read = s.collaboration_call(None, "delivery_get", json!({"taskId": t})).unwrap();
    assert_eq!(read["settings"], claude(OPUS_ALIAS));
    // The Workspace's (here the built-in) reviewer is not this task's: refused.
    let refused = s.collaboration_call(None, "delivery_enable", input(&t)).unwrap_err().to_string();
    assert!(refused.contains("The review settings for this task changed"), "{refused}");
    let mut v = input(&t);
    v["settings"] = claude(OPUS_ALIAS);
    let f = s.collaboration_call(None, "delivery_enable", v).unwrap()["flow"].clone();
    s.collaboration_call(None, "task_submit_result", result(&s, &t, Some(f["candidate"].clone()), "result")).unwrap();
    let run = start(&s, &t, "review");
    assert_eq!((run["requestedHarness"].clone(), run["requestedModel"].clone()), (json!("claude"), json!(OPUS_ALIAS)));
}
