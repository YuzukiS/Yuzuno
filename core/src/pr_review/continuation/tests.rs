//! Continuations with a controlled fake reviewer: parents are stored records
//! and the reviewer's report is given, so no model is ever started.
use super::*;
use crate::{github::client::Repository, pr_review::reviewer, store::Store};

const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C: &str = "cccccccccccccccccccccccccccccccccccccccc";

fn settings() -> Value {
    json!({"harness":"codex","model":"gpt-6.1-sol"})
}

/// A completed round of A → B that covered a.rs and left b.rs unread, with
/// a ledger, hashed receipts and one P3 finding.
fn parent() -> Value {
    json!({"id":"parent","round":1,"status":"completed","actualHarness":"codex","actualModel":"gpt-6.1-sol","finishedAt":"2026-10-19T20:00:00Z",
        "requestedHarness":"codex","requestedModel":"gpt-6.1-sol","baseSha":A,"headSha":B,"mergeBaseSha":C,
        "coveragePolicyVersion":source::COVERAGE_VERSION,"policyVersion":policy::VERSION,"conclusion":"unknown","nativeCorrectness":"unknown",
        "explanation":"b.rs was not read","reasonCodes":["coverage_incomplete"],
        "findings":[{"title":"Naming","body":"Prefer a clearer name","priority":3,"path":"a.rs","startLine":1,"endLine":1}],
        "ledger":{"version":LEDGER_VERSION,"operationMs":300_000,"calls":2,"bytes":5_000,"nativeUsage":{"state":"unknown"},"nativeCompletion":"confirmed"},
        "contextReads":[{"number":1,"responseSha256":"1".repeat(64)},{"number":2,"responseSha256":"2".repeat(64)}],"contextBytes":5_000,
        "coverage":{"fileCount":2,"coveredFileCount":1,"terminalLimit":null,"failedRequests":[],"unresolvedRequests":0,
            "coveredFiles":[{"path":"a.rs","revision":B,"blobSha":"1".repeat(40),"deliveredVia":"source_diff","evidenceKind":"complete_diff"}]},
        "scope":{"version":1,"baseSha":A,"headSha":B,"mergeBaseSha":C,"coveragePolicyVersion":3,"policy":{"state":"absent"},
            "paths":[{"path":"a.rs","status":"modified","state":"covered"},{"path":"b.rs","status":"added","state":"not_read"}],
            "counts":{"covered":1,"not_read":1}}})
}

fn ask(review: &str, key: &str) -> Continue {
    serde_json::from_value(json!({"requestId":key,"taskId":"T-1","reviewId":review,"baseSha":A,"headSha":B})).unwrap()
}

#[test]
fn admission_reads_only_the_parents_stored_record() {
    let admitted = admit(&parent(), &ask("parent", "c1"), &settings()).unwrap();
    assert_eq!(admitted["targets"], json!([{"path":"b.rs","state":"not_read"}]));
    // What the parent left, never a fresh budget.
    assert_eq!(admitted["reservation"], json!({"calls":158,"bytes":1_495_000,"milliseconds":600_000}));
    let refused = |edit: fn(&mut Value), says: &str| {
        let mut p = parent();
        edit(&mut p);
        let error = admit(&p, &ask("parent", "c1"), &settings()).unwrap_err();
        assert!(error.contains(says), "{says}: {error}");
    };
    refused(|p| p["kind"] = json!("continuation"), "itself a continuation");
    for status in ["unknown", "failed", "cancelled", "running"] {
        let mut p = parent();
        p["status"] = json!(status);
        assert!(admit(&p, &ask("parent", "c1"), &settings()).unwrap_err().contains(&format!("ended {status}")));
    }
    refused(|p| p["actualHarness"] = Value::Null, "only a completed round");
    refused(|p| { p.as_object_mut().unwrap().remove("ledger"); }, "no usage ledger");
    refused(|p| { p["ledger"].as_object_mut().unwrap().remove("operationMs"); }, "no usage ledger");
    refused(|p| { p["ledger"].as_object_mut().unwrap().remove("nativeCompletion"); }, "no record that its native run completed");
    refused(|p| p["headSha"] = json!("d".repeat(40)), "another base or head");
    refused(|p| p["coveragePolicyVersion"] = json!(2), "another coverage or review policy");
    refused(|p| p["policyVersion"] = json!(2), "another coverage or review policy");
    refused(|p| { p.as_object_mut().unwrap().remove("scope"); }, "no recorded scope");
    refused(|p| p["requestedModel"] = json!("other"), "harness or model changed");
    refused(|p| p["coverage"]["terminalLimit"] = json!("Review context budget exhausted (160 calls / 1.5 MB); remaining coverage is incomplete"), "terminal limit");
    refused(|p| p["coverage"]["terminalLimit"] = json!("Repeated source tool failure: source_read ..."), "terminal limit");
    refused(|p| p["coverage"]["failedRequests"] = json!([{"resolved":false,"tool":"source_search","requested":{"query":"x"}}]), "unresolved requests outside");
    refused(|p| p["scope"]["paths"][1]["state"] = json!("covered"), "no changed path a continuation could read");
    refused(|p| p["contextReads"][1].as_object_mut().unwrap().remove("responseSha256").map_or((), |_| ()), "without a recorded hash");
    // A spent budget is never refilled.
    refused(|p| p["contextReads"] = json!((1..=160).map(|n| json!({"number":n,"responseSha256":"0".repeat(64)})).collect::<Vec<_>>()), "too little");
    refused(|p| p["contextBytes"] = json!(1_500_000), "too little");
    // Exact milliseconds: 59 999 ms left is less than the minute it needs.
    refused(|p| p["ledger"]["operationMs"] = json!(840_001), "too little");
    let mut exact = parent();
    exact["ledger"]["operationMs"] = json!(300_001);
    assert_eq!(admit(&exact, &ask("parent", "c1"), &settings()).unwrap()["reservation"]["milliseconds"], 599_999);
    // Paths no review of the snapshot can cover need an acknowledgement.
    let mut gap = parent();
    gap["scope"]["paths"] = json!([{"path":"a.rs","state":"covered"},{"path":"b.rs","state":"not_read"},{"path":"tool.exe","state":"unsupported","reason":"binary"}]);
    assert!(admit(&gap, &ask("parent", "c1"), &settings()).unwrap_err().contains("tool.exe"));
    let mut acknowledged = ask("parent", "c1");
    acknowledged.acknowledge_unreviewable = Some(true);
    assert_eq!(admit(&gap, &acknowledged, &settings()).unwrap()["targets"].as_array().unwrap().len(), 1);
    // A failed read of a changed path left unread is a target, not a refusal.
    let mut failed = parent();
    failed["scope"]["paths"][1]["state"] = json!("read_failed");
    failed["coverage"]["failedRequests"] = json!([{"resolved":false,"kind":"source_unavailable","tool":"source_diff","requested":{"path":"b.rs","offset":0}}]);
    assert_eq!(admit(&failed, &ask("parent", "c1"), &settings()).unwrap()["targets"], json!([{"path":"b.rs","state":"read_failed"}]));
}

fn setup() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.insert(&serde_json::from_value(json!({"agent":{"id":"owner","name":"Owner","cwd":"/tmp","model":"test","color":"sage","threadId":"native","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    let task = s
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Deliver PR","assigneeAgentId":"owner"}))
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.github_link_object(&task, &Repository { id: 7, full_name: "o/r".into() }, "pull", 1, json!({"baseSha":A,"headSha":B,"state":"open"})).unwrap();
    (dir, s, task)
}

/// Stores a created round as the completed parent above.
fn complete(store: &Store, mut run: Value) -> Value {
    let template = parent();
    for (key, value) in template.as_object().unwrap() {
        if !matches!(key.as_str(), "id" | "round") {
            run[key] = value.clone();
        }
    }
    store.save_pr_review(&run, Some("parent report")).unwrap();
    run
}

fn start(task: &str, key: &str) -> crate::pr_review::Start {
    serde_json::from_value(json!({"requestId":key,"taskId":task,"linkId":"7:pull:1","baseSha":A,"headSha":B})).unwrap()
}

fn on(task: &str, review: &str, key: &str) -> Continue {
    let mut input = ask(review, key);
    input.task_id = task.into();
    input
}

#[test]
fn one_continuation_per_parent_is_reserved_once_and_a_retry_is_the_same_one() {
    let (_dir, store, task) = setup();
    let (run, _) = store.create_pr_review(None, &start(&task, "r1"), "p1").unwrap();
    assert_eq!(run["ledger"]["version"], LEDGER_VERSION, "new rounds carry a ledger");
    let first = complete(&store, run);
    let (child, held, created) = store.create_pr_review_continuation(None, &on(&task, "p1", "c1"), "child").unwrap();
    assert!(created);
    assert_eq!(held.unwrap()["id"], "p1");
    assert_eq!((child["kind"].as_str(), child["parentReviewId"].as_str(), child["round"].as_i64()), (Some("continuation"), Some("p1"), Some(2)));
    assert_eq!(child["continuation"]["reservation"], json!({"calls":158,"bytes":1_495_000,"milliseconds":600_000}));
    assert_eq!(child["continuation"]["parentFindings"], first["findings"]);
    assert!(child["nativeStartedAt"].is_null());
    // The same request is the same child; nothing else is reserved.
    let (again, _, created) = store.create_pr_review_continuation(None, &on(&task, "p1", "c1"), "other").unwrap();
    assert!(!created);
    assert_eq!(again["id"], "child");
    let mut changed = on(&task, "p1", "c1");
    changed.acknowledge_unreviewable = Some(true);
    assert!(store.create_pr_review_continuation(None, &changed, "other").unwrap_err().to_string().contains("idempotency_conflict"));
    // A second request, even after the child ends, is refused.
    assert!(store.create_pr_review_continuation(None, &on(&task, "p1", "c2"), "second").unwrap_err().to_string().contains("already running"));
    let mut ended = store.pr_review_report(&task, "child").unwrap();
    ended["status"] = json!("completed");
    ended["nativeStartedAt"] = json!("2026-10-19T20:10:00Z");
    store.save_pr_review(&ended, Some("child report")).unwrap();
    let refused = store.create_pr_review_continuation(None, &on(&task, "p1", "c3"), "third").unwrap_err().to_string();
    assert!(refused.contains("already has continuation round 2") && refused.contains("isn't refilled"), "{refused}");
    // A continuation can't be continued, and the parent stays as it was.
    let chained = store.create_pr_review_continuation(None, &on(&task, "child", "c4"), "fourth").unwrap_err().to_string();
    assert!(chained.contains("itself a continuation") && chained.ends_with("No continuation was started."), "{chained}");
    let stored = store.pr_review_report(&task, "p1").unwrap();
    assert_eq!((&stored["findings"], &stored["coverage"], &stored["scope"], &stored["rawReport"]), (&first["findings"], &first["coverage"], &first["scope"], &json!("parent report")));
    assert_eq!(store.list_pr_reviews(&task, None).unwrap()["reviews"].as_array().unwrap().len(), 2);
}

#[test]
fn a_restart_or_a_lost_reply_never_starts_a_second_model() {
    let (dir, store, task) = setup();
    let (run, _) = store.create_pr_review(None, &start(&task, "r1"), "p1").unwrap();
    complete(&store, run);
    // Ended before its native start was recorded: provably no model ran, so
    // the parent's one continuation is still there.
    let (mut child, _, _) = store.create_pr_review_continuation(None, &on(&task, "p1", "c1"), "refused").unwrap();
    child["status"] = json!("failed");
    child["error"] = json!("The re-fetched changed paths, blobs or modes differ; nothing was started.");
    store.save_pr_review(&child, None).unwrap();
    let (mut child, _, created) = store.create_pr_review_continuation(None, &on(&task, "p1", "c2"), "started").unwrap();
    assert!(created && child["round"] == 3);
    child["nativeStartedAt"] = json!("2026-10-19T20:10:00Z");
    child["status"] = json!("running");
    store.save_pr_review(&child, None).unwrap();
    drop(store);
    // Core restarts: the running child is unknown and never relaunched.
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    store.recover_pr_reviews().unwrap();
    let recovered = store.pr_review_report(&task, "started").unwrap();
    assert_eq!((recovered["status"].as_str(), recovered["reasonCodes"].clone()), (Some("unknown"), json!(["execution_unconfirmed"])));
    // The lost reply's retry reads it back; a new request is refused.
    let (again, _, created) = store.create_pr_review_continuation(None, &on(&task, "p1", "c2"), "ignored").unwrap();
    assert!(!created && again["status"] == "unknown");
    assert!(store.create_pr_review_continuation(None, &on(&task, "p1", "c3"), "third").unwrap_err().to_string().contains("already has continuation round 3"));
    // An unknown child counts even without a recorded native start.
    let (dir2, store2, task2) = setup();
    let (run, _) = store2.create_pr_review(None, &start(&task2, "r1"), "p1").unwrap();
    complete(&store2, run);
    store2.create_pr_review_continuation(None, &on(&task2, "p1", "c1"), "pending").unwrap();
    drop(store2);
    let store2 = Store::open(&dir2.path().join("workspace.sqlite")).unwrap();
    store2.recover_pr_reviews().unwrap();
    assert!(store2.create_pr_review_continuation(None, &on(&task2, "p1", "c2"), "next").unwrap_err().to_string().contains("already has continuation"));
}

fn delivery(task: &str, key: &str, extra: Value) -> Value {
    let mut v = json!({"requestId":key,"taskId":task,"linkId":"7:pull:1","baseSha":A,"headSha":B,"settings":settings()});
    for (k, value) in extra.as_object().unwrap() {
        v[k] = value.clone();
    }
    v
}

#[test]
fn under_a_delivery_a_continuation_is_one_of_its_authorized_attempts() {
    let (_dir, store, task) = setup();
    let flow = store.collaboration_call(None, "delivery_enable", delivery(&task, "enable", json!({"maxRounds":2}))).unwrap()["flow"].clone();
    // The delivery's first attempt is the parent.
    let (run, _) = store.create_pr_review(Some("owner"), &start(&task, "r1"), "p1").unwrap();
    complete(&store, run);
    let refused = store.create_pr_review_continuation(None, &on(&task, "p1", "c1"), "child").unwrap_err().to_string();
    assert!(refused.contains("delivery_continue"), "{refused}");
    assert_eq!(store.list_pr_reviews(&task, None).unwrap()["reviews"].as_array().unwrap().len(), 1, "nothing was created");
    // Authorized as the delivery's second attempt, it takes that attempt.
    store.collaboration_call(None, "delivery_continue", delivery(&task, "continue", json!({"flowId":flow["id"],"expectedRound":1}))).unwrap();
    let (child, _, created) = store.create_pr_review_continuation(None, &on(&task, "p1", "c1"), "child").unwrap();
    assert!(created);
    let flow = store.collaboration_call(None, "delivery_get", json!({"taskId":task})).unwrap()["flow"].clone();
    assert_eq!(flow["rounds"][1]["review"]["id"], child["id"]);
    // The cap stays: no third attempt, continued or not.
    assert!(store.collaboration_call(None, "delivery_continue", delivery(&task, "again", json!({"flowId":flow["id"],"expectedRound":2}))).is_err());
}

/// A child run whose union coverage is complete, with the fake reviewer's
/// report on its targets.
fn child(parent: &Value) -> Value {
    let admitted = admit(parent, &ask("parent", "c1"), &settings()).unwrap();
    json!({"id":"child","kind":"continuation","status":"running","policyVersion":policy::VERSION,"reasonCodes":[],"conclusion":"unknown","findings":[],
        "headSha":B,"mergeBaseSha":C,"contextIncomplete":false,"continuation":record(parent, &admitted),
        "files":[{"path":"a.rs","status":"modified","lines":5,"sourceBlob":"1".repeat(40)},{"path":"b.rs","status":"added","lines":5,"sourceBlob":"2".repeat(40)}]})
}

fn report(correctness: &str, findings: Value) -> Value {
    json!({"findings":findings,"overall_correctness":correctness,"overall_explanation":"Read b.rs; the earlier note stands","overall_confidence_score":0.8})
}

#[test]
fn the_chain_verdict_keeps_every_finding_and_a_blocking_one_from_either_round_blocks() {
    let parent = parent();
    let blocker = json!({"title":"Bug","body":"Breaks callers","priority":1,"code_location":{"absolute_file_path":"b.rs","line_range":{"start":2,"end":3}}});
    // The parent's P3 note is carried, so a clean continuation approves with notes.
    let mut run = child(&parent);
    reviewer::complete_report(&report("patch is correct", json!([])), &mut run);
    assert_eq!(run["conclusion"], "approved_with_notes");
    assert_eq!(run["findings"][0]["origin"], json!({"reviewId":"parent","carried":true}));
    assert!(policy::passes(&run));
    // A new blocking finding blocks; both rounds' findings stay, by origin.
    let mut run = child(&parent);
    reviewer::complete_report(&report("patch is incorrect", json!([blocker])), &mut run);
    assert_eq!(run["conclusion"], "changes_requested");
    assert_eq!(run["findings"].as_array().unwrap().iter().map(|f| f["origin"]["reviewId"].clone()).collect::<Vec<_>>(), [json!("parent"), json!("child")]);
    // A parent's blocking finding isn't resolved by not being repeated.
    let mut blocked = parent.clone();
    blocked["findings"][0]["priority"] = json!(2);
    let mut run = child(&blocked);
    reviewer::complete_report(&report("patch is correct", json!([])), &mut run);
    assert_eq!(run["conclusion"], "changes_requested");
    assert!(!policy::passes(&run));
    let mut incorrect = parent.clone();
    incorrect["nativeCorrectness"] = json!("patch is incorrect");
    let mut run = child(&incorrect);
    reviewer::complete_report(&report("patch is correct", json!([])), &mut run);
    assert_eq!(run["conclusion"], "changes_requested");
    // An incomplete union or an unknown verdict never passes.
    let mut run = child(&parent);
    run["contextIncomplete"] = json!(true);
    reviewer::complete_report(&report("patch is correct", json!([])), &mut run);
    assert_eq!(run["conclusion"], "unknown");
    let mut run = child(&parent);
    reviewer::complete_report(&report("unknown", json!([])), &mut run);
    assert_eq!(run["conclusion"], "unknown");
    assert!(!policy::passes(&run));
}

#[test]
fn native_usage_is_recorded_as_reported_or_unknown_never_zero() {
    let claude = json!({"actualHarness":"claude"});
    let reported = native_usage(&claude, r#"{"total_cost_usd":0.42,"usage":{"input_tokens":10},"modelUsage":{"m":{}}}"#);
    assert_eq!((reported["totalCostUsd"].as_f64(), reported["basis"].as_str()), (Some(0.42), Some("the harness's own estimate in its result, not a bill")));
    assert_eq!(native_usage(&claude, r#"{"result":"x"}"#)["state"], "unknown");
    assert_eq!(native_usage(&json!({"actualHarness":"codex"}), "{}")["state"], "unknown");
    assert_eq!(native_usage(&json!({}), "")["state"], "none");
    // The chain's total is known only when both rounds reported theirs.
    let mut run = json!({"ledger":{"calls":3,"bytes":700,"operationMs":2_000,"nativeUsage":{"state":"reported","totalCostUsd":0.25}},
        "continuation":{"parentLedger":{"calls":2,"bytes":5_000,"operationMs":300_000,"nativeUsage":{"state":"reported","totalCostUsd":0.5}}}});
    assert_eq!(cumulative(&run), json!({"calls":5,"bytes":5_700,"operationMs":302_000,"nativeUsage":{"state":"reported","basis":"the sum of each run's own harness estimate, not a bill","totalCostUsd":0.75}}));
    run["continuation"]["parentLedger"]["nativeUsage"] = json!({"state":"unknown"});
    assert_eq!(cumulative(&run)["nativeUsage"], json!({"state":"unknown"}));
}

#[test]
fn a_pr_gets_at_most_two_started_rounds_whichever_task_they_belong_to() {
    // Round 1 and a manual round 2: a continuation of round 2 would be a third.
    let (_dir, store, task) = setup();
    let (run, _) = store.create_pr_review(None, &start(&task, "r1"), "p1").unwrap();
    complete(&store, run);
    let (run, _) = store.create_pr_review(None, &start(&task, "r2"), "p2").unwrap();
    complete(&store, run);
    let refused = store.create_pr_review_continuation(None, &on(&task, "p2", "c1"), "child").unwrap_err().to_string();
    assert!(refused.contains("already has 2 review rounds that started or may have started"), "{refused}");
    assert_eq!(store.list_pr_reviews(&task, None).unwrap()["reviews"].as_array().unwrap().len(), 2, "nothing was created");
    // The same PR's round under another task counts too.
    let (_dir, store, task) = setup();
    let other = store.collaboration_call(None, "task_create", json!({"requestId":"other","title":"Same PR"})).unwrap()["task"]["id"].as_str().unwrap().to_owned();
    store.github_link_object(&other, &Repository { id: 7, full_name: "o/r".into() }, "pull", 1, json!({"baseSha":A,"headSha":B,"state":"open"})).unwrap();
    let (run, _) = store.create_pr_review(None, &start(&other, "elsewhere"), "elsewhere").unwrap();
    complete(&store, run);
    let (run, _) = store.create_pr_review(None, &start(&task, "r1"), "p1").unwrap();
    complete(&store, run);
    assert!(store.create_pr_review_continuation(None, &on(&task, "p1", "c1"), "child").unwrap_err().to_string().contains("across tasks"));
    // An older round without a ledger that failed can't prove nothing ran.
    let (_dir, store, task) = setup();
    let (mut old, _) = store.create_pr_review(None, &start(&task, "old"), "old").unwrap();
    old.as_object_mut().unwrap().remove("ledger");
    old["status"] = json!("failed");
    store.save_pr_review(&old, None).unwrap();
    let (run, _) = store.create_pr_review(None, &start(&task, "r2"), "p2").unwrap();
    complete(&store, run);
    assert!(store.create_pr_review_continuation(None, &on(&task, "p2", "c1"), "child").unwrap_err().to_string().contains("already has 2"));
    // A round recorded with a ledger that failed before its native start did not run.
    let (_dir, store, task) = setup();
    let (mut early, _) = store.create_pr_review(None, &start(&task, "early"), "early").unwrap();
    early["status"] = json!("failed");
    store.save_pr_review(&early, None).unwrap();
    let (run, _) = store.create_pr_review(None, &start(&task, "r2"), "p2").unwrap();
    complete(&store, run);
    assert!(store.create_pr_review_continuation(None, &on(&task, "p2", "c1"), "child").unwrap().2);
}

#[test]
fn a_confirmed_native_report_survives_a_restart_during_the_check_after_the_review() {
    let (dir, store, task) = setup();
    let (run, _) = store.create_pr_review(None, &start(&task, "r1"), "p1").unwrap();
    // Stored as Core stores it once the native run completed and shut down,
    // before the check after the review.
    let mut stored = run.clone();
    for (key, value) in parent().as_object().unwrap() {
        if !matches!(key.as_str(), "id" | "round") {
            stored[key] = value.clone();
        }
    }
    stored["status"] = json!("running");
    stored["finishedAt"] = Value::Null;
    store.save_pr_review(&stored, Some("native report")).unwrap();
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    store.recover_pr_reviews().unwrap();
    let recovered = store.pr_review_report(&task, "p1").unwrap();
    assert_eq!((recovered["status"].as_str(), recovered["scope"]["checkAfterReview"].as_str()), (Some("completed"), Some("interrupted")));
    assert_eq!((&recovered["rawReport"], &recovered["reasonCodes"]), (&json!("native report"), &json!(["coverage_incomplete"])));
    assert!(recovered["finishedAt"].is_string());
    // Without the confirmation it is unknown, as before.
    let (run, _) = store.create_pr_review(None, &start(&task, "r2"), "p2").unwrap();
    let mut unconfirmed = run.clone();
    unconfirmed["status"] = json!("running");
    store.save_pr_review(&unconfirmed, None).unwrap();
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    store.recover_pr_reviews().unwrap();
    assert_eq!(store.pr_review_report(&task, "p2").unwrap()["status"], "unknown");
}

#[test]
fn two_concurrent_requests_reserve_the_parent_once() {
    let (_dir, store, task) = setup();
    let (run, _) = store.create_pr_review(None, &start(&task, "r1"), "p1").unwrap();
    complete(&store, run);
    let (a, b) = std::thread::scope(|s| {
        let a = s.spawn(|| store.create_pr_review_continuation(None, &on(&task, "p1", "c1"), "child-a").map(|r| r.2));
        let b = s.spawn(|| store.create_pr_review_continuation(None, &on(&task, "p1", "c2"), "child-b").map(|r| r.2));
        (a.join().unwrap(), b.join().unwrap())
    });
    // Exactly one reserved the parent's budget; the other started nothing.
    assert_eq!([&a, &b].iter().filter(|r| matches!(r, Ok(true))).count(), 1, "{a:?} {b:?}");
    assert_eq!([&a, &b].iter().filter(|r| r.is_err()).count(), 1, "{a:?} {b:?}");
    let reviews = store.list_pr_reviews(&task, None).unwrap()["reviews"].clone();
    assert_eq!(reviews.as_array().unwrap().iter().filter(|r| r["kind"] == "continuation").count(), 1);
    // Both retries answer as before: the winner's child, the loser's refusal
    // left nothing to return, so it is refused again.
    let winner = if a.is_ok() { ("c1", "child-a") } else { ("c2", "child-b") };
    let (again, _, created) = store.create_pr_review_continuation(None, &on(&task, "p1", winner.0), "other").unwrap();
    assert!(!created && again["id"] == winner.1);
}
