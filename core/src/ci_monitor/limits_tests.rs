//! YN-193: the CI monitor's limit of 50 counts only the targets still waiting
//! for something; all live targets are at most 100; an older PR head with
//! nothing of it still running is read every five minutes.
use super::*;
use rusqlite::params;

pub(super) fn sha(n: u64) -> String {
    format!("{n:040x}")
}
pub(super) fn target(s: &Store, n: u64) -> anyhow::Result<Value> {
    let mut request = input(&format!("w{n}"));
    request.expected_sha = sha(n);
    s.ci_subscribe(Some("a"), request, crate::github::client::Repository { id: 123, full_name: "o/r".into() }, "pull", 7)
}
pub(super) fn watch_of(n: u64) -> String {
    format!("123:pull:7:{}", sha(n))
}
/// The watch of target `n` saw one finished run of its head.
pub(super) fn finish(s: &Store, n: u64) {
    let run = client::run(&json!({"id":n,"run_attempt":1,"head_sha":sha(n),"name":"CI","status":"completed","conclusion":"success",
        "repository":{"id":123},"created_at":"2026-10-15T00:00:00Z"}), 123, "o/r").unwrap();
    s.ci_observe(&watch_of(n), Ok(seen(vec![run], Some(sha(n))))).unwrap();
}

#[test]
fn the_ci_limit_counts_targets_still_waiting_and_all_live_targets_are_at_most_100() {
    let (_dir, s) = setup();
    for n in 1..=50 {
        target(&s, n).unwrap();
    }
    let refused = target(&s, 51).unwrap_err().to_string();
    assert!(refused.contains("At most 50 distinct CI targets still waiting for a run to finish (now 50), and 100 in all (now 50)"), "{refused}");
    // Subscribing again to a live target is never refused.
    let mut again = input("again");
    again.expected_sha = sha(1);
    s.ci_subscribe(Some("b"), again, crate::github::client::Repository { id: 123, full_name: "o/r".into() }, "pull", 7).unwrap();
    // A target whose run finished, and an older PR head with no run, wait for nothing.
    finish(&s, 1);
    s.ci_observe(&watch_of(2), Ok(seen(vec![], Some(sha(999))))).unwrap();
    let due: i64 = s.db.read().unwrap().query_row("SELECT next_poll FROM ci_watches WHERE id=?1", [watch_of(2)], |r| r.get(0)).unwrap();
    assert!(due - chrono::Utc::now().timestamp() > 200, "an older head with nothing running is read every five minutes: {due}");
    target(&s, 51).unwrap();
    target(&s, 52).unwrap();
    assert!(target(&s, 53).is_err(), "50 wait again");
    // Every other target finishes; 48 more fill all 100.
    for n in 3..=52 {
        finish(&s, n);
    }
    for n in 53..=100 {
        target(&s, n).unwrap();
    }
    let refused = target(&s, 101).unwrap_err().to_string();
    assert!(refused.contains("(now 48), and 100 in all (now 100)"), "{refused}");
}

/// The internal ID of task `reference`.
pub(super) fn task_id(s: &Store, reference: &str) -> String {
    crate::collaboration_store::task_key(&s.db.read().unwrap(), reference).unwrap().0
}
/// The watch, subscription and request ID of old history entry `i`.
pub(super) fn old_watch(i: usize) -> String {
    format!("123:pull:{}:{}", 1000 + i, sha(i as u64 + 1_000_000))
}
pub(super) fn old_sub(i: usize) -> String {
    format!("old-sub-{i}")
}
/// The request that made old history entry `i`, as its receipt keeps it.
pub(super) fn old_request(i: usize) -> Subscribe {
    let mut request = input(&format!("old-{i}"));
    request.url = format!("https://github.com/o/r/pull/{}", 1000 + i);
    request.expected_sha = sha(i as u64 + 1_000_000);
    request
}
/// Old run attempt `j` of history entry `i`.
pub(super) fn old_run(i: usize, j: usize) -> Value {
    let mut run = client::run(&json!({"id":5_000_000 + j,"run_attempt":1,"head_sha":sha(i as u64 + 1_000_000),"name":"CI",
        "status":"completed","conclusion":"success","workflow_id":77,"event":"pull_request","head_branch":"feature",
        "repository":{"id":123},"created_at":"2026-09-01T00:00:00Z"}), 123, "o/r").unwrap();
    run["observedAt"] = json!("2026-09-01T00:10:00Z");
    run
}
/// A Workspace's CI history as earlier releases left it at both of their
/// limits (R-39): `subs` subscriptions of Agent "a" on task `task`, each on a
/// finished PR watch of its own and ended at `ended` (epoch seconds), with its
/// receipt and closed interest, and `runs` finished attempts spread over them,
/// each mailed to its subscription and that mail delivered.
pub(super) fn old_history(s: &Store, task: &str, subs: usize, runs: usize, ended: i64) {
    let at = super::stamp(ended);
    let mut db = s.db.write().unwrap();
    let tx = db.transaction().unwrap();
    for i in 0..subs {
        let (wid, sid, request) = (old_watch(i), old_sub(i), old_request(i));
        let w = json!({"id":wid,"repositoryId":123,"repository":"o/r","kind":"pull","number":1000 + i,"url":request.url,
            "expectedSha":request.expected_sha,"currentHeadSha":request.expected_sha,"state":"watching","error":null,
            "observedAt":at,"lastAttemptAt":at,"nextPollAt":at,"createdAt":"2026-09-01T00:00:00Z"});
        tx.execute("INSERT INTO ci_watches(id,next_poll,data) VALUES(?1,?2,?3)", params![wid, ended, w.to_string()]).unwrap();
        let sub = json!({"id":sid,"watchId":wid,"agentId":"a","agent":{"kind":"agent","id":"a","name":"a"},"taskId":task,"taskRef":"T-1",
            "source":null,"createdAt":"2026-09-01T00:00:00Z","expiresAt":at,"active":false,"closure":{"reason":"expired","at":at}});
        tx.execute("INSERT INTO ci_subscriptions(id,watch_id,agent_id,task_id,active,expires,data) VALUES(?1,?2,'a',?3,0,?4,?5)",
            params![sid, wid, task, ended, sub.to_string()]).unwrap();
        let interest = json!(["agent:a", request.request_id]).to_string();
        tx.execute("INSERT INTO ci_interests(id,subscription_id,owner,active,expires,data) VALUES(?1,?2,'manual',0,?3,?4)",
            params![interest, sid, ended, json!({"id":interest,"subscriptionId":sid,"owner":"manual","requestId":request.request_id,
                "openedAt":"2026-09-01T00:00:00Z","expiresAt":at,"active":false,"closure":{"reason":"expired","at":at}}).to_string()]).unwrap();
        tx.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES('agent:a','ci_subscribe',?1,?2,?3)",
            params![request.request_id, serde_json::to_value(&request).unwrap().to_string(), json!({"subscriptionId":sid}).to_string()]).unwrap();
    }
    for j in 0..runs {
        let i = j % subs;
        let run = old_run(i, j);
        let rid = run["id"].as_str().unwrap().to_owned();
        tx.execute("INSERT INTO ci_runs(id,data) VALUES(?1,?2)", params![rid, run.to_string()]).unwrap();
        tx.execute("INSERT INTO ci_watch_runs(watch_id,run_id) VALUES(?1,?2)", params![old_watch(i), rid]).unwrap();
        let mid = format!("old-mail-{j}");
        crate::collaboration_store::insert_message(&tx, json!({"id":mid,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
            "recipient":{"kind":"agent","id":"a","name":"a"},"body":"GitHub Actions: passed","taskId":task,"replyTo":null,"threadId":mid,
            "createdAt":at,"source":{"ciRunKey":rid,"subscriptionId":old_sub(i)},"priority":"normal","metadata":{"kind":"ci"}})).unwrap();
        tx.execute("INSERT INTO ci_notifications(subscription_id,run_id,message_id) VALUES(?1,?2,?3)", params![old_sub(i), rid, mid]).unwrap();
    }
    tx.execute("UPDATE collaboration_messages SET delivery_state='delivered' WHERE id LIKE 'old-mail-%'", []).unwrap();
    tx.commit().unwrap();
}
/// How many mails Core wrote about run `key`.
pub(super) fn mails_of(s: &Store, key: &str) -> i64 {
    s.db.read().unwrap().query_row("SELECT COUNT(*) FROM collaboration_messages WHERE json_extract(data,'$.source.ciRunKey')=?1",
        [key], |r| r.get(0)).unwrap()
}
fn count(s: &Store, table: &str) -> i64 {
    s.db.read().unwrap().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
}

/// R-39: an old Workspace at both former history limits (2000 subscriptions,
/// none active, and 10000 recorded attempts) takes a new subscription and
/// records and mails its new results once, also after a restart.
#[test]
fn a_full_history_keeps_out_neither_a_new_subscription_nor_a_new_result() {
    let (dir, s) = setup();
    let task = task_id(&s, "T-1");
    old_history(&s, &task, 2000, 10000, chrono::Utc::now().timestamp() - 30 * 86400);
    assert_eq!((count(&s, "ci_subscriptions"), count(&s, "ci_runs")), (2000, 10000));
    // Before R-39 this was "CI subscription history limit reached (2000)".
    let sub = target(&s, 1).unwrap();
    assert_eq!(sub["active"], true);
    // Before R-39 this observation failed: "CI history limit reached (10000 attempts)".
    finish(&s, 1);
    let key = "github:123:1:1";
    assert_eq!(s.ci_run(key).unwrap()["status"], "passed");
    assert_eq!(mails_of(&s, key), 1);
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    finish(&s, 1);
    assert_eq!(mails_of(&s, key), 1, "the same completion is mailed once, also after a restart");
    let again = client::run(&json!({"id":1,"run_attempt":2,"head_sha":sha(1),"name":"CI","status":"completed","conclusion":"failure",
        "repository":{"id":123},"created_at":"2026-10-15T00:00:00Z"}), 123, "o/r").unwrap();
    s.ci_observe(&watch_of(1), Ok(seen(vec![again], Some(sha(1))))).unwrap();
    assert_eq!(mails_of(&s, "github:123:1:2"), 1, "a new attempt is its own mail");
    assert_eq!((count(&s, "ci_subscriptions"), count(&s, "ci_runs")), (2001, 10002));
    // The old ones still read as they were.
    let old = s.ci_list(None, Some("T-1"), None).unwrap();
    assert_eq!(old["activeSubscriptionCount"], 1);
    assert_eq!(s.ci_run(old_run(0, 0)["id"].as_str().unwrap()).unwrap()["runWatched"], false);
}

/// The 2000 now counts active subscriptions only. A refusal is said on the
/// task once for that target and Agent, however often it is asked again,
/// and is news again after a subscription to it was made.
#[test]
fn active_subscriptions_are_at_most_2000_and_a_refusal_is_said_on_the_task_once() {
    let (_dir, s) = setup();
    let task = task_id(&s, "T-1");
    let mine = target(&s, 1).unwrap();
    {
        // 1999 other Agents' active subscriptions of the same live target.
        let db = s.db.write().unwrap();
        let expires = chrono::Utc::now().timestamp() + 86400;
        for n in 0..1999 {
            db.execute("INSERT INTO ci_subscriptions(id,watch_id,agent_id,task_id,active,expires,data) VALUES(?1,?2,?3,?4,1,?5,'{}')",
                params![format!("full-{n}"), watch_of(1), format!("x{n}"), task, expires]).unwrap();
            db.execute("INSERT INTO ci_interests(id,subscription_id,owner,active,expires,data) VALUES(?1,?1,'manual',1,?2,'{}')",
                params![format!("full-{n}"), expires]).unwrap();
        }
    }
    let comments = || -> Vec<Value> {
        s.collaboration_call(None, "task_get", json!({"taskId":"T-1","view":"full"})).unwrap()["activities"].as_array().unwrap()
            .iter().filter(|a| a["kind"] == "comment" && a["source"]["ciRefusal"].is_object()).cloned().collect()
    };
    let refused = target(&s, 2).unwrap_err().to_string();
    assert!(refused.contains("At most 2000 CI subscriptions can be active at once (now 2000)"), "{refused}");
    let said = comments();
    assert_eq!(said.len(), 1);
    let body = said[0]["body"].as_str().unwrap();
    assert!(body.contains("https://github.com/o/r/pull/7") && body.contains(&sha(2)) && body.contains("Who takes over: a follows this CI"), "{body}");
    assert_eq!(said[0]["actor"]["id"], "core");
    // Asked again with a new requestId: refused, and not said again.
    let mut retry = input("w2-again");
    retry.expected_sha = sha(2);
    assert!(s.ci_subscribe(Some("a"), retry, crate::github::client::Repository { id: 123, full_name: "o/r".into() }, "pull", 7).is_err());
    assert_eq!(comments().len(), 1);
    // Renewing an active subscription adds none and is never refused.
    let mut renew = input("w1-renew");
    renew.expected_sha = sha(1);
    let renewed = s.ci_subscribe(Some("a"), renew, crate::github::client::Repository { id: 123, full_name: "o/r".into() }, "pull", 7).unwrap();
    assert_eq!(renewed["id"], mine["id"]);
    // One ends: the next is admitted, and its refusal record is gone.
    s.db.write().unwrap().execute("UPDATE ci_subscriptions SET active=0 WHERE id='full-0'", []).unwrap();
    target(&s, 2).unwrap();
    assert_eq!(count(&s, "ci_refusals"), 0);
    assert!(target(&s, 3).is_err());
    assert_eq!(comments().len(), 2, "another target is its own notice");
}

/// The same-failure note keeps the newest 10000 failed attempts: a new one
/// takes the oldest one's place instead of no longer being recorded.
#[test]
fn failure_records_keep_the_newest_10000() {
    let (_dir, s) = setup();
    {
        let db = s.db.write().unwrap();
        for n in 0..10000 {
            db.execute("INSERT INTO ci_run_failures(run_id,repository_id,workflow_id,data) VALUES(?1,'123','77','[]')",
                [format!("github:123:{n}:1")]).unwrap();
        }
    }
    let run = client::run(&json!({"id":99_999,"run_attempt":1,"head_sha":sha(1),"name":"CI","status":"completed","conclusion":"failure",
        "workflow_id":77,"repository":{"id":123},"created_at":"2026-10-15T00:00:00Z"}), 123, "o/r").unwrap();
    s.ci_record_failures(&run, &[json!({"job":"Core","key":"Core","step":"Test"})]).unwrap();
    assert_eq!(count(&s, "ci_run_failures"), 10000);
    assert!(s.ci_failures_known("github:123:99999:1").unwrap());
    assert!(!s.ci_failures_known("github:123:0:1").unwrap(), "the oldest gave way");
    // Recording a known attempt again changes nothing.
    s.ci_record_failures(&run, &[]).unwrap();
    assert!(s.ci_failures_known("github:123:1:1").unwrap());
}
