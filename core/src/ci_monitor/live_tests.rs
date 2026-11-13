use super::*;
use crate::{
    ci_monitor::{Observed, Subscribe, client},
    model::AgentDetail,
};
use rusqlite::params;

fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    for id in ["a", "b"] {
        s.insert(&serde_json::from_value::<AgentDetail>(json!({"agent":{"id":id,"name":id,"cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    }
    for n in 1..=2 {
        s.collaboration_call(
            None,
            "task_create",
            json!({"requestId":format!("task-{n}"),"title":"Fixture","status":"doing"}),
        )
        .unwrap();
    }
    (dir, s)
}
fn sub(s: &Store, agent: &str, task: &str, kind: &str, number: u64) -> Value {
    s.ci_subscribe(
        Some(agent),
        Subscribe {
            request_id: uuid::Uuid::new_v4().to_string(),
            task_id: task.into(),
            agent_id: None,
            url: format!(
                "https://github.com/o/r/{}/{number}",
                if kind == "pull" {
                    "pull"
                } else {
                    "actions/runs"
                }
            ),
            expected_sha: "a".repeat(40),
            branch: None,
            event: None,
            sent_sha: None,
        },
        crate::github::client::Repository {
            id: 123,
            full_name: "o/r".into(),
        },
        kind,
        number,
    )
    .unwrap()
}
fn run(id: u64, attempt: u64, state: &str, conclusion: Value) -> Value {
    client::run(&json!({"id":id,"run_attempt":attempt,"head_sha":"a".repeat(40),"name":"CI","status":state,"conclusion":conclusion,"repository":{"id":123}}),123,"o/r").unwrap()
}
fn observe(s: &Store, sub: &Value, runs: Vec<Value>) {
    s.ci_observe(
        sub["watchId"].as_str().unwrap(),
        Ok(Observed {
            runs,
            head: Some("a".repeat(40)),
            pr: None,
            truncated: false,
            checked: chrono::Utc::now().timestamp(),
            wait: 0,
            excluded: 0,
        }),
    )
    .unwrap();
}
fn counts(s: &Store) -> Value {
    s.live_ci_counts().unwrap()["agents"].clone()
}
fn expected(r: u64, d: u64, c: u64) -> Value {
    json!({"running":r,"discovering":d,"check":c})
}

/// One merge entry the queue is following after its merge: the state the
/// projection sees, with no subscription of anyone's.
fn queue_entry(s: &Store, id: &str, task: &str, by: Value, sha: &str, state: &str, main_ci: Value, main_run: Value) {
    let at = chrono::Utc::now().to_rfc3339();
    // The entry stores the task's own id, not the key the test names it by.
    let task = crate::collaboration_store::task_key(&s.db.read().unwrap(), task).unwrap().0;
    let e = json!({"id":id,"entryId":id,"taskId":task,"taskReference":"T-1","repositoryId":123,"repository":"o/r",
        "number":11,"headSha":"b".repeat(40),"baseBranch":"main",
        "release":{"by":by,"requestId":format!("r-{id}"),"at":at},
        "state":state,"reason":null,"detail":null,"updatedAt":at,
        "merge":{"sha":sha,"mainCi":main_ci,"mainRun":main_run,"mergedAt":at},"nextCheck":chrono::Utc::now().timestamp() + 120});
    s.db.write()
        .unwrap()
        .execute(
            "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,123,11,?3,0,?4)",
            params![id, task, state, e.to_string()],
        )
        .unwrap();
}
fn set_main_run(s: &Store, id: &str, run: Value) {
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE merge_entries SET data=json_set(data,'$.merge.mainRun',json(?1)) WHERE id=?2",
            params![run.to_string(), id],
        )
        .unwrap();
}
fn running_sha(sha: &str, number: u64) -> Value {
    client::run(
        &json!({"id":number,"run_attempt":1,"head_sha":sha,"name":"CI","event":"push","head_branch":"main",
            "status":"in_progress","conclusion":null,"repository":{"id":123},"head_repository":{"id":123}}),
        123,
        "o/r",
    )
    .unwrap()
}

#[test]
fn the_merge_queues_main_ci_follow_counts_for_the_agent_that_released_it() {
    let (_dir, s) = setup();
    let sha = "c".repeat(40);
    let who = json!({"kind":"agent","id":"a","name":"a"});
    // Merged, main's push CI not concluded: the releaser waits for its first
    // run, as a commit watch with no run yet does.
    queue_entry(&s, "q1", "T-1", who.clone(), &sha, "merged", Value::Null, Value::Null);
    let a = counts(&s)["a"].clone();
    assert_eq!(a["waitingForRun"], 1, "a merged entry following main CI is a wait: {a}");
    assert_eq!(a["running"], 0, "{a}");
    assert!(a["waitingCheckedAt"].is_string(), "the queue's last read is shown: {a}");
    assert!(counts(&s)["b"].is_null(), "only the releaser waits");
    // The queue saw main's push CI running: the same wait is running CI now.
    set_main_run(&s, "q1", json!({"run":95,"attempt":1,"status":"in_progress","url":"https://github.com/o/r/actions/runs/95","observedAt":chrono::Utc::now().to_rfc3339()}));
    let a = counts(&s)["a"].clone();
    assert_eq!(a["running"], 1, "a run the queue follows is running CI: {a}");
    assert!(a.get("waitingForRun").is_none(), "{a}");
    // The conversation's CI read carries the same item, with its run.
    let page = s.ci_list(Some("a"), None, None).unwrap();
    let queued = page["mergeQueue"].as_array().expect("the CI page lists the queue's follow");
    assert_eq!(queued.len(), 1, "{page}");
    assert_eq!(
        (queued[0]["entryId"].clone(), queued[0]["state"].clone(), queued[0]["run"]["id"].clone()),
        (json!("q1"), json!("running"), json!(95)),
        "{page}"
    );
    // Main CI has a conclusion: the entry is done and nobody waits on it.
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE merge_entries SET state='done',data=json_set(data,'$.state','done','$.merge.mainCi',json('{\"run\":95,\"conclusion\":\"success\"}')) WHERE id='q1'",
            [],
        )
        .unwrap();
    assert!(counts(&s)["a"].is_null(), "a concluded main CI is not a wait");
    // A release by the user is for no Agent.
    queue_entry(&s, "q2", "T-1", json!({"kind":"user","id":"me","name":"Me"}), &"d".repeat(40), "merged", Value::Null, Value::Null);
    assert!(counts(&s)["a"].is_null(), "the user released it: no Agent waits");
    // The same commit already watched by the releaser is counted once.
    let sha = "e".repeat(40);
    queue_entry(&s, "q3", "T-1", who, &sha, "merged", Value::Null, Value::Null);
    let commit = s
        .ci_subscribe(
            Some("a"),
            Subscribe {
                request_id: uuid::Uuid::new_v4().to_string(),
                task_id: "T-2".into(),
                agent_id: None,
                url: format!("https://github.com/o/r/commit/{sha}"),
                expected_sha: sha.clone(),
                branch: Some("main".into()),
                event: Some("push".into()),
                sent_sha: None,
            },
            crate::github::client::Repository { id: 123, full_name: "o/r".into() },
            "commit",
            0,
        )
        .unwrap();
    s.ci_observe(
        commit["watchId"].as_str().unwrap(),
        Ok(Observed {
            runs: vec![running_sha(&sha, 96)],
            head: Some(sha.clone()),
            pr: None,
            truncated: false,
            checked: chrono::Utc::now().timestamp(),
            wait: 0,
            excluded: 0,
        }),
    )
    .unwrap();
    let a = counts(&s)["a"].clone();
    assert_eq!(a["running"], 1, "the same commit is counted once: {a}");
    assert!(a.get("waitingForRun").is_none(), "the queue entry does not add a second wait: {a}");
    assert!(
        s.ci_list(Some("a"), None, None).unwrap()["mergeQueue"]
            .as_array()
            .is_some_and(|items| items.is_empty()),
        "the same commit is listed once, by its subscription"
    );
}

#[test]
fn a_stale_or_failing_queue_follow_is_a_check_not_a_wait() {
    let (_dir, s) = setup();
    let sha = "c".repeat(40);
    queue_entry(&s, "q1", "T-1", json!({"kind":"agent","id":"a","name":"a"}), &sha, "merged", Value::Null, Value::Null);
    assert_eq!(counts(&s)["a"]["waitingForRun"], 1);
    // The queue is overdue by well past its grace: not a wait.
    let old = (chrono::Utc::now() - chrono::Duration::seconds(600)).to_rfc3339();
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE merge_entries SET next_check=0,data=json_set(data,'$.nextCheck',0,'$.updatedAt',?1) WHERE id='q1'",
            [&old],
        )
        .unwrap();
    let a = counts(&s)["a"].clone();
    assert_eq!(a["check"], 1, "an overdue queue follow needs checking: {a}");
    assert!(a.get("waitingForRun").is_none(), "{a}");
    // A failed queue read is a check even when the entry itself was just written.
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE merge_entries SET data=json_set(data,'$.readFailures',1,'$.nextCheck',strftime('%s','now')+120,'$.updatedAt',?1) WHERE id='q1'",
            [chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    assert_eq!(counts(&s)["a"]["check"], 1, "a failed queue read needs checking");
    // A running run no longer being read is not current either.
    let seen = (chrono::Utc::now() - chrono::Duration::seconds(300)).to_rfc3339();
    let now = chrono::Utc::now().to_rfc3339();
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE merge_entries SET data=json_set(data,'$.readFailures',0,'$.nextCheck',strftime('%s','now')+60,'$.updatedAt',?1,'$.merge.mainRun',json(?2)) WHERE id='q1'",
            params![&now, json!({"run":95,"attempt":1,"status":"in_progress","url":"https://github.com/o/r/actions/runs/95","observedAt":seen}).to_string()],
        )
        .unwrap();
    let a = counts(&s)["a"].clone();
    assert_eq!(a["check"], 1, "a running run the queue stopped reading is a check: {a}");
    assert_eq!(a["running"], 0, "{a}");
}

#[test]
fn recipient_isolation_shared_tasks_runs_and_latest_attempt() {
    let (_dir, s) = setup();
    let a = sub(&s, "a", "T-1", "pull", 7);
    let _same = sub(&s, "a", "T-2", "pull", 7);
    let direct = sub(&s, "a", "T-2", "run", 42);
    assert!(counts(&s)["b"].is_null());
    observe(
        &s,
        &a,
        vec![
            run(42, 1, "queued", Value::Null),
            run(43, 1, "in_progress", Value::Null),
        ],
    );
    observe(&s, &direct, vec![run(42, 1, "queued", Value::Null)]);
    assert_eq!(counts(&s)["a"], expected(2, 0, 0));
    let b = sub(&s, "b", "T-1", "pull", 7);
    assert_eq!(counts(&s)["b"], expected(2, 0, 0));
    // A newer terminal attempt retires a cached unfinished older attempt,
    // including links from another watch, and leaves the other workflow.
    observe(&s, &direct, vec![run(42, 2, "completed", json!("success"))]);
    assert_eq!(counts(&s)["a"], expected(1, 0, 0));
    observe(
        &s,
        &b,
        vec![
            run(42, 2, "completed", json!("success")),
            run(43, 1, "completed", json!("cancelled")),
        ],
    );
    assert_eq!(counts(&s), json!({}));
    observe(&s, &a, vec![run(42, 3, "in_progress", Value::Null)]);
    assert_eq!(counts(&s)["a"], expected(1, 0, 0));
}

#[test]
fn discovery_has_a_deadline_and_no_old_sha_stop_or_expiry_waits() {
    let (_dir, s) = setup();
    let a = sub(&s, "a", "T-1", "pull", 7);
    assert_eq!(counts(&s)["a"], expected(0, 1, 0));
    observe(&s, &a, vec![]);
    let later = chrono::Utc::now().timestamp() + 601;
    assert_eq!(
        s.live_ci_counts_at(later).unwrap()["agents"]["a"],
        expected(0, 0, 1)
    );
    s.ci_observe(
        a["watchId"].as_str().unwrap(),
        Ok(Observed {
            runs: vec![],
            head: Some("b".repeat(40)),
            pr: None,
            truncated: false,
            checked: chrono::Utc::now().timestamp(),
            wait: 0,
            excluded: 0,
        }),
    )
    .unwrap();
    assert_eq!(counts(&s), json!({}));
    observe(&s, &a, vec![run(42, 1, "queued", Value::Null)]);
    s.ci_unsubscribe(Some("a"), a["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(counts(&s), json!({}));
    let a = sub(&s, "a", "T-1", "pull", 7);
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE ci_interests SET expires=0 WHERE subscription_id=?1",
            [a["id"].as_str().unwrap()],
        )
        .unwrap();
    assert_eq!(
        counts(&s),
        json!({}),
        "live subscription projection cannot override expired interests"
    );
}

#[test]
fn terminal_error_paused_stale_unknown_and_truncated_facts() {
    let (_dir, s) = setup();
    let a = sub(&s, "a", "T-1", "pull", 7);
    for end in ["success", "failure", "cancelled", "timed_out", "skipped"] {
        observe(&s, &a, vec![run(42, 1, "completed", json!(end))]);
        assert_eq!(counts(&s), json!({}), "terminal {end}");
    }
    observe(&s, &a, vec![run(42, 1, "in_progress", Value::Null)]);
    assert_eq!(
        s.live_ci_counts_at(chrono::Utc::now().timestamp() + 121)
            .unwrap()["agents"]["a"],
        expected(0, 0, 1)
    );
    for _ in 0..8 {
        s.ci_observe(
            a["watchId"].as_str().unwrap(),
            Err("network failure".into()),
        )
        .unwrap();
        assert_eq!(counts(&s)["a"], expected(0, 0, 1));
    }
    observe(&s, &a, vec![run(42, 1, "mystery", Value::Null)]);
    assert_eq!(counts(&s)["a"], expected(0, 0, 1));
    observe(&s, &a, vec![run(42, 1, "completed", Value::Null)]);
    assert_eq!(counts(&s)["a"], expected(0, 0, 1));
    s.ci_observe(
        a["watchId"].as_str().unwrap(),
        Ok(Observed {
            runs: vec![run(42, 1, "completed", json!("success"))],
            head: None,
            pr: None,
            truncated: true,
            checked: chrono::Utc::now().timestamp(),
            wait: 0,
            excluded: 0,
        }),
    )
    .unwrap();
    assert_eq!(
        counts(&s)["a"],
        expected(0, 0, 1),
        "incomplete run discovery cannot establish all done"
    );
}

#[test]
fn task_closure_clears_pr_waits_but_retains_explicit_post_merge_run() {
    let (_dir, s) = setup();
    let pr = sub(&s, "a", "T-1", "pull", 7);
    let direct = sub(&s, "b", "T-1", "run", 42);
    observe(&s, &pr, vec![run(42, 1, "queued", Value::Null)]);
    observe(&s, &direct, vec![run(42, 1, "queued", Value::Null)]);
    assert_eq!(counts(&s)["a"], expected(1, 0, 0));
    assert_eq!(counts(&s)["b"], expected(1, 0, 0));
    let current = s
        .collaboration_call(None, "task_get", json!({"taskId":"T-1"}))
        .unwrap();
    s.collaboration_call(None, "task_update", json!({"requestId":"close", "taskId":"T-1", "expectedVersion":current["task"]["version"], "patch":{"status":"done"}})).unwrap();
    assert!(counts(&s)["a"].is_null());
    assert_eq!(counts(&s)["b"], expected(1, 0, 0));
    observe(&s, &direct, vec![run(42, 1, "completed", json!("success"))]);
    assert_eq!(counts(&s), json!({}));
}

#[test]
fn live_projection_is_read_only_and_not_limited_by_history_pages() {
    let (_dir, s) = setup();
    let a = sub(&s, "a", "T-1", "pull", 7);
    observe(&s, &a, vec![run(42, 1, "queued", Value::Null)]);
    let history = (100..175)
        .map(|n| run(n, 1, "completed", json!("success")))
        .collect();
    observe(&s, &a, history);
    {
        let db = s.db.write().unwrap();
        for n in 0..210 {
            let wid = format!("old-{n}");
            db.execute(
                "INSERT INTO ci_watches(id,next_poll,data) VALUES(?1,0,'{}')",
                [&wid],
            )
            .unwrap();
            db.execute("INSERT INTO ci_subscriptions(id,watch_id,agent_id,task_id,active,expires,data) VALUES(?1,?1,'a',?2,0,0,?3)",params![wid,a["taskId"].as_str().unwrap(),json!({"id":wid,"watchId":wid}).to_string()]).unwrap();
        }
    }
    let before = s.db.read().unwrap().total_changes();
    assert_eq!(counts(&s)["a"], expected(1, 0, 0));
    assert_eq!(s.db.read().unwrap().total_changes(), before);
    assert!(s.ci_list(Some("a"), None, None).unwrap()["subscriptionsTruncated"] == true);
    assert_eq!(counts(&s)["a"], expected(1, 0, 0));
}
