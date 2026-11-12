//! YN-12 S2: the end of a round a dispatched executor started itself is
//! copied to the task's active dispatcher; quiet once completed (whatever
//! its conclusion) while the executor is at work, ringing otherwise; never
//! twice to one Agent, as Core's mail is resolved (store.rs `dispatcher_copy`,
//! mail_wake.rs).
use super::*;

/// Core's review mail to `to`, oldest first.
fn review_mail(s: &Store, to: &str) -> Vec<Value> {
    s.collaboration_call(None, "peer_read", json!({"agentId":to,"limit":200})).unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["metadata"]["kind"] == "review")
        .cloned()
        .collect()
}

/// A round `key` that `by` starts on the dispatched task's PR.
fn round(s: &Store, task: &str, by: Option<&str>, key: &str) -> Value {
    let (run, created) = s.create_pr_review(by, &input(task, key), key).unwrap();
    assert!(created);
    run
}

/// `run` ending as `status` with `conclusion`; its stored record.
fn end(s: &Store, task: &str, mut run: Value, status: &str, conclusion: &str) -> Value {
    run["status"] = json!(status);
    run["conclusion"] = json!(conclusion);
    s.save_pr_review(&run, None).unwrap();
    s.pr_review_report(task, run["id"].as_str().unwrap()).unwrap()
}

fn version(s: &Store, task: &str) -> Value {
    s.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["version"].clone()
}

/// `id` released, as a release leaves an executor `by` dispatched: archived
/// and closed (a lead here only made the dispatch; its role is replaced).
fn release(s: &Store, id: &str, by: &str) {
    s.db.write()
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO agent_roles(agent_id,kind,template_id,task_id,created_by,archived_at,created_at,updated_at)
             VALUES(?1,'executor','dev',NULL,?2,'then','now','now')",
            rusqlite::params![id, format!("agent:{by}")],
        )
        .unwrap();
    s.update(id, "agent/closed", &json!({}), |d| d.agent.closed_at = Some("then".into())).unwrap();
}

fn digest(s: &Store, to: &str) -> Vec<String> {
    crate::mail_wake::digest(&s.db.read().unwrap(), to, i64::MAX, "normal").unwrap()
}

#[test]
fn the_dispatcher_gets_one_quiet_copy_of_a_completed_round_its_executor_started() {
    let (_dir, s, task) = dispatched_task();
    let run = round(&s, &task, Some("dev"), "asked");
    let record = end(&s, &task, run, "completed", "changes_requested");
    // The digest says what the copy brings, by its conclusion: completed is
    // never "passed". Read first: a read message leaves the digest.
    let lines = digest(&s, "lead");
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].contains("PR #1 review changes_requested"), "{lines:?}");
    let original = review_mail(&s, "dev");
    let copy = review_mail(&s, "lead");
    assert_eq!((original.len(), copy.len()), (1, 1), "one original and one copy: {original:#?} {copy:#?}");
    assert_eq!(original[0]["wake"], "ring", "the executor's own mail rings as before");
    assert!(original[0]["metadata"].get("copyFor").is_none());
    let copy = &copy[0];
    assert_eq!(copy["wake"], "quiet", "{copy:#}");
    assert_eq!(copy["wakeReason"], crate::mail_wake::COPY);
    assert_eq!(copy["metadata"]["copyFor"], "dispatcher");
    assert_eq!(copy["metadata"]["requester"], "dev");
    assert_eq!(copy["metadata"]["reviewId"], "asked");
    assert_eq!(copy["notice"]["status"], "changes_requested");
    let body = copy["body"].as_str().unwrap();
    let (first, rest) = body.split_once("\n\n").unwrap();
    assert!(first.starts_with("Copy for you as the dispatcher of "), "{first}");
    assert!(
        first.ends_with(": Dev started this round and was sent the result as well; the next step is its own, under your dispatch."),
        "{first}"
    );
    assert_eq!(rest, original[0]["body"].as_str().unwrap(), "then the original's text");
    assert_eq!(record["dispatcherCopy"]["messageId"], copy["id"]);
    assert_eq!(record["dispatcherCopy"]["recipient"]["id"], "lead");
    assert!(review_mail(&s, "lead2").is_empty());
    // A review that passed is told as passed, and its copy is quiet too.
    let run = round(&s, &task, Some("dev"), "passed");
    end(&s, &task, run, "completed", "no_findings");
    let lines = digest(&s, "lead");
    assert!(lines[0].contains("PR #1 review passed"), "{lines:?}");
    let copies = review_mail(&s, "lead");
    assert_eq!(copies.len(), 2);
    assert_eq!(copies[1]["wake"], "quiet");
}

#[test]
fn a_copy_of_a_failed_cancelled_or_unknown_round_rings() {
    let (_dir, s, task) = dispatched_task();
    // A failure before the native start doesn't count toward the PR's rounds;
    // the cancelled and the unknown one do, two in all.
    let run = round(&s, &task, Some("dev"), "failed");
    end(&s, &task, run, "failed", "unknown");
    let run = round(&s, &task, Some("dev"), "cancelled");
    end(&s, &task, run, "cancelled", "unknown");
    round(&s, &task, Some("dev"), "restarted");
    s.recover_pr_reviews().unwrap();
    let copies = review_mail(&s, "lead");
    let told: Vec<_> = copies.iter().map(|m| (m["metadata"]["status"].as_str().unwrap(), m["wake"].as_str().unwrap())).collect();
    assert_eq!(told, [("failed", "ring"), ("cancelled", "ring"), ("unknown", "ring")], "{copies:#?}");
    assert!(copies.iter().all(|m| m.get("wakeReason").is_none()));
    assert_eq!(review_mail(&s, "dev").len(), 3);
}

#[test]
fn no_copy_when_the_dispatcher_or_the_user_started_it() {
    let (_dir, s, task) = dispatched_task();
    let run = round(&s, &task, Some("lead"), "by-lead");
    let record = end(&s, &task, run, "completed", "no_findings");
    assert!(record.get("dispatcherCopy").is_none());
    let mut by_user = input(&task, "by-user");
    by_user.notify_agent_id = Some("dev".into());
    let (run, _) = s.create_pr_review(None, &by_user, "by-user").unwrap();
    let record = end(&s, &task, run, "completed", "no_findings");
    assert!(record.get("dispatcherCopy").is_none());
    assert_eq!(review_mail(&s, "lead").len(), 1, "only its own round's mail");
    assert_eq!(review_mail(&s, "dev").len(), 1, "only the user's round, which names it");
}

#[test]
fn the_copy_goes_to_the_active_dispatch_as_the_round_ends() {
    // Dispatched again to the same executor: the new dispatcher gets it.
    let (_dir, s, task) = dispatched_task();
    let run = round(&s, &task, Some("dev"), "redispatched");
    s.collaboration_call(Some("lead2"), "task_dispatch", json!({"requestId":"again","taskId":task,"expectedVersion":version(&s, &task),"toAgentId":"dev"}))
        .unwrap();
    let record = end(&s, &task, run, "completed", "no_findings");
    assert_eq!(record["dispatcherCopy"]["recipient"]["id"], "lead2");
    assert_eq!(review_mail(&s, "lead2").len(), 1);
    assert!(review_mail(&s, "lead").is_empty(), "the earlier dispatcher gets none");
    // Dispatched to another executor: a late end of the earlier one's round
    // copies no one.
    let (_dir, s, task) = dispatched_task();
    agent(&s, "dev2", "Dev 2");
    let run = round(&s, &task, Some("dev"), "late");
    s.collaboration_call(Some("lead"), "task_dispatch", json!({"requestId":"other","taskId":task,"expectedVersion":version(&s, &task),"toAgentId":"dev2"}))
        .unwrap();
    let record = end(&s, &task, run, "completed", "changes_requested");
    assert!(record.get("dispatcherCopy").is_none());
    assert!(review_mail(&s, "lead").is_empty());
    assert_eq!(review_mail(&s, "dev").len(), 1);
}

#[test]
fn a_released_executors_round_reaches_its_dispatcher_once() {
    let (_dir, s, task) = dispatched_task();
    let run = round(&s, &task, Some("dev"), "released");
    release(&s, "dev", "lead");
    let record = end(&s, &task, run, "completed", "no_findings");
    assert!(record.get("dispatcherCopy").is_none(), "{record:#}");
    let mail = review_mail(&s, "lead");
    assert_eq!(mail.len(), 1, "{mail:#?}");
    assert_eq!(mail[0]["originalRecipient"]["id"], "dev");
    assert!(mail[0]["metadata"].get("copyFor").is_none());
    assert_eq!(mail[0]["wake"], "ring", "the task is open");
}

#[test]
fn where_each_mail_is_passed_on_decides_whether_a_copy_is_written() {
    // The dispatcher is itself a released executor: the copy goes on to the
    // Agent that dispatched it, beside the executor's own.
    let (_dir, s, task) = dispatched_task();
    agent(&s, "boss", "Boss");
    let run = round(&s, &task, Some("dev"), "boss-copy");
    release(&s, "lead", "boss");
    let record = end(&s, &task, run, "completed", "no_findings");
    assert_eq!(record["dispatcherCopy"]["recipient"]["id"], "lead");
    let copy = review_mail(&s, "boss");
    assert_eq!(copy.len(), 1, "{copy:#?}");
    assert_eq!((copy[0]["metadata"]["copyFor"].as_str(), copy[0]["originalRecipient"]["id"].as_str()), (Some("dispatcher"), Some("lead")));
    assert_eq!(review_mail(&s, "dev").len(), 1);
    // Both are released by the same Agent: both reach it, so it gets one.
    let (_dir, s, task) = dispatched_task();
    agent(&s, "boss", "Boss");
    let run = round(&s, &task, Some("dev"), "boss-once");
    release(&s, "lead", "boss");
    release(&s, "dev", "boss");
    let record = end(&s, &task, run, "completed", "no_findings");
    assert!(record.get("dispatcherCopy").is_none(), "{record:#}");
    let mail = review_mail(&s, "boss");
    assert_eq!(mail.len(), 1, "{mail:#?}");
    assert!(mail[0]["metadata"].get("copyFor").is_none());
}

#[test]
fn a_copy_rings_once_the_task_is_closed_or_its_dispatcher_wants_every_notice() {
    let (_dir, s, task) = dispatched_task();
    let run = round(&s, &task, Some("dev"), "after-done");
    s.collaboration_call(None, "task_update", json!({"requestId":"done","taskId":task,"expectedVersion":version(&s, &task),"patch":{"status":"done"}}))
        .unwrap();
    end(&s, &task, run, "completed", "no_findings");
    let copy = review_mail(&s, "lead");
    assert_eq!(copy.len(), 1, "{copy:#?}");
    assert_eq!(copy[0]["wake"], "ring", "nobody is at work on a done task: {:#}", copy[0]);

    let (_dir, s, task) = dispatched_task();
    s.collaboration_call(Some("lead"), "mail_preferences", json!({"requestId":"loud","mode":"all"})).unwrap();
    let run = round(&s, &task, Some("dev"), "wanted");
    end(&s, &task, run, "completed", "no_findings");
    let copy = review_mail(&s, "lead");
    assert_eq!(copy.len(), 1);
    assert_eq!(copy[0]["wake"], "ring");
    assert_eq!(copy[0]["wakeReason"], crate::mail_wake::WANTED);
}

#[test]
fn a_record_without_its_requester_copies_no_one() {
    // A round recorded before `requestedBy` was kept ends as before.
    let (_dir, s, task) = dispatched_task();
    let mut run = round(&s, &task, Some("dev"), "old");
    run.as_object_mut().unwrap().remove("requestedBy");
    let record = end(&s, &task, run, "completed", "no_findings");
    assert!(record.get("dispatcherCopy").is_none());
    assert!(review_mail(&s, "lead").is_empty());
    assert_eq!(review_mail(&s, "dev").len(), 1);
}
