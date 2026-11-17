//! A run that stops on a stage that did not succeed (YN-194): one more mail
//! when its other stages ended after that stage's own, and its stages that
//! can no longer start marked stalled and left out of what still goes on.
use super::*;

/// The run's mail of one status, oldest first.
fn mail_of(s: &Store, status: &str) -> Vec<Value> {
    mail(s).into_iter().filter(|m| m["metadata"]["status"] == status).collect()
}
/// The rail's count of Agent a's unfinished Jobs.
fn going(s: &Store) -> i64 {
    s.live_job_counts().unwrap()["agents"]["a"]["active"].as_i64().unwrap_or(0)
}
/// job_list's live page for Agent a, by Job ID.
fn live_ids(s: &Store) -> Vec<Value> {
    let page = s.list_jobs_for(Some("a"), json!({"limit":50})).unwrap();
    page["liveJobIds"].as_array().unwrap().clone()
}

#[test]
fn a_run_whose_other_stage_ends_after_the_failure_is_told_once_that_it_stopped() {
    let (_dir, s) = setup();
    let run = create(&s, "stops", json!([stage("first", &[]), stage("other", &[]), stage("after", &["first"])]));
    let id = run["id"].as_str().unwrap();
    let first = start(&s);
    assert_eq!(first["run"]["stage"], "first");
    assert!(finish(&s, &first, "failed", exit("1"), json!({})));
    // other can still start: the run goes on, and the failure has its own mail.
    assert_eq!(s.run(id).unwrap()["status"], "queued");
    assert_eq!(mail_of(&s, "failed").len(), 1);
    assert!(mail_of(&s, "stopped").is_empty());
    let after = latest(&s, &run, "after");
    assert_eq!(after["status"], "waiting");
    assert_eq!(after["stalled"], "upstream", "it cannot start without a retry");
    assert!(!live_ids(&s).contains(&after["id"]), "not live: {:?}", live_ids(&s));

    let other = start(&s);
    assert_eq!(other["run"]["stage"], "other");
    assert!(success(&s, &other, "bbb"));
    let view = s.run(id).unwrap();
    assert_eq!(view["status"], "failed");
    let stopped = mail_of(&s, "stopped");
    assert_eq!(stopped.len(), 1, "{stopped:?}");
    let body = stopped[0]["body"].as_str().unwrap();
    for part in ["stopped: first attempt 1 failed", "after wait for it", "job_run_retry", "job_run_cancel", "Workspace move"] {
        assert!(body.contains(part), "{part}: {body}");
    }
    assert_eq!(stopped[0]["metadata"]["runId"], run["id"]);
    // Said once: more reads and the safety net add nothing.
    s.run(id).unwrap();
    assert!(!s.advance_runs().unwrap());
    assert_eq!(mail_of(&s, "stopped").len(), 1);
    // The stalled stage is in neither the rail's count nor the live page.
    assert_eq!(going(&s), 0);
    let row = &attempts(&s.run(id).unwrap(), "after")[0];
    assert_eq!(row["stalled"], "upstream");

    // A retry releases the mark; a failure that ends last is told by itself.
    s.retry_stage(Some("a"), "again", id, "first").unwrap();
    let after = latest(&s, &run, "after");
    assert!(after.get("stalled").is_none(), "{after}");
    assert!(live_ids(&s).contains(&after["id"]));
    let again = start(&s);
    assert_eq!(again["run"]["stage"], "first");
    assert!(finish(&s, &again, "failed", exit("1"), json!({})));
    assert_eq!(s.run(id).unwrap()["status"], "failed");
    assert_eq!(mail_of(&s, "failed").len(), 2);
    assert_eq!(mail_of(&s, "stopped").len(), 1, "the second failure ended last");
    assert_eq!(latest(&s, &run, "after")["stalled"], "upstream");
}

#[test]
fn a_failure_that_ends_last_is_told_only_by_its_own_mail() {
    let (_dir, s) = setup();
    let run = create(&s, "both", json!([stage("first", &[]), stage("other", &[])]));
    let first = start(&s);
    assert!(finish(&s, &first, "failed", exit("1"), json!({})));
    let other = start(&s);
    assert!(finish(&s, &other, "failed", exit("2"), json!({})));
    assert_eq!(s.run(run["id"].as_str().unwrap()).unwrap()["status"], "failed");
    assert_eq!(mail_of(&s, "failed").len(), 2);
    assert!(mail_of(&s, "stopped").is_empty(), "each failure was told by its own mail");
}

#[test]
fn a_stage_behind_a_stalled_one_is_stalled_too_and_a_cancel_ends_them() {
    let (_dir, s) = setup();
    let run = create(&s, "chain", json!([stage("a1", &[]), stage("a2", &["a1"]), stage("a3", &["a2"])]));
    let id = run["id"].as_str().unwrap();
    let first = start(&s);
    assert!(finish(&s, &first, "failed", exit("1"), json!({})));
    for key in ["a2", "a3"] {
        assert_eq!(latest(&s, &run, key)["stalled"], "upstream", "{key}");
    }
    assert_eq!(going(&s), 0);
    // The budget still counts what is waiting that can start: none here.
    assert_eq!(s.job_budget_view(machine()).unwrap()["waitingCount"], 0);
    s.request_run_cancel(Some("a"), id).unwrap();
    for key in ["a2", "a3"] {
        assert_eq!(latest(&s, &run, key)["status"], "cancelled", "{key}");
    }
}

#[test]
fn a_run_that_stopped_before_the_mark_existed_is_marked_when_the_database_opens() {
    let (dir, s) = setup();
    let run = create(&s, "old", json!([stage("first", &[]), stage("after", &["first"])]));
    let first = start(&s);
    assert!(finish(&s, &first, "failed", exit("1"), json!({})));
    // As a Core before YN-194 left it: waiting, without the mark.
    let mut after = latest(&s, &run, "after");
    after.as_object_mut().unwrap().remove("stalled");
    super::super::store::save(&s.db.write().unwrap(), &after).unwrap();
    assert_eq!(going(&s), 1);
    drop(s);
    let reopened = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(latest(&reopened, &run, "after")["stalled"], "upstream");
    assert_eq!(going(&reopened), 0);
}
