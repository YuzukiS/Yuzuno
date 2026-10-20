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
