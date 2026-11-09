//! Incremental rounds with a controlled fake reviewer: earlier rounds are
//! stored records and the reviewer's report is given, so no model is started.
use super::*;
use crate::{github::client::Repository, pr_review::{continuation::LEDGER_VERSION, reviewer}, store::Store};

const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C: &str = "cccccccccccccccccccccccccccccccccccccccc";
const D: &str = "dddddddddddddddddddddddddddddddddddddddd";

fn settings() -> Value {
    json!({"harness":"codex","model":"gpt-6.1-sol"})
}

/// A completed full round of A → B (merge base C) that covered a.rs and
/// b.rs, with a ledger, hashed receipts, one P1 finding on b.rs and one P3
/// note on a.rs.
fn previous() -> Value {
    json!({"id":"earlier","round":1,"status":"completed","actualHarness":"codex","actualModel":"gpt-6.1-sol","finishedAt":"2026-10-20T06:00:00Z",
        "requestedHarness":"codex","requestedModel":"gpt-6.1-sol","baseSha":A,"headSha":B,"mergeBaseSha":C,
        "coveragePolicyVersion":source::COVERAGE_VERSION,"policyVersion":policy::VERSION,"conclusion":"changes_requested","nativeCorrectness":"patch is incorrect",
        "explanation":"b.rs breaks its caller","reasonCodes":[],
        "findings":[{"title":"Bug","body":"Breaks callers","priority":1,"path":"b.rs","startLine":1,"endLine":1},
            {"title":"Naming","body":"Prefer a clearer name","priority":3,"path":"a.rs","startLine":1,"endLine":1}],
        "ledger":{"version":LEDGER_VERSION,"operationMs":300_000,"calls":3,"bytes":5_000,"nativeUsage":{"state":"reported","totalCostUsd":0.5},"nativeCompletion":"confirmed"},
        "contextReads":[{"number":1,"responseSha256":"1".repeat(64)},{"number":2,"responseSha256":"2".repeat(64)}],"contextBytes":5_000,
        "coverage":{"fileCount":2,"coveredFileCount":2,"terminalLimit":null,"failedRequests":[],"unresolvedRequests":0,
            "coveredFiles":[{"path":"a.rs","revision":B,"blobSha":"1".repeat(40),"deliveredVia":"source_diff","evidenceKind":"complete_diff"},
                {"path":"b.rs","revision":B,"blobSha":"2".repeat(40),"deliveredVia":"source_diff","evidenceKind":"complete_diff"}]},
        "scope":{"version":1,"baseSha":A,"headSha":B,"mergeBaseSha":C,"coveragePolicyVersion":3,"policy":{"state":"absent"},
            "paths":[{"path":"a.rs","status":"modified","state":"covered"},{"path":"b.rs","status":"modified","state":"covered"}],
            "counts":{"covered":2}}})
}

#[test]
fn admission_reads_only_the_earlier_rounds_stored_record() {
    assert!(admit(&previous(), Some(D), &settings()).is_ok());
    // The head may be unknown until the snapshot is fetched; it is checked again then.
    assert!(admit(&previous(), None, &settings()).is_ok());
    let refused = |edit: fn(&mut Value), head: &str, says: &str| {
        let mut p = previous();
        edit(&mut p);
        let error = admit(&p, Some(head), &settings()).unwrap_err();
        assert!(error.contains(says), "{says}: {error}");
    };
    refused(|_| {}, B, "same head; for the same snapshot use review_continue");
    refused(|p| p["kind"] = json!("continuation"), D, "isn't a full round (continuation)");
    refused(|p| p["kind"] = json!("incremental"), D, "isn't a full round (incremental)");
    for status in ["unknown", "failed", "cancelled", "running"] {
        let mut p = previous();
        p["status"] = json!(status);
        assert!(admit(&p, Some(D), &settings()).unwrap_err().contains(&format!("ended {status}")));
    }
    refused(|p| p["actualHarness"] = Value::Null, D, "only a completed round");
    refused(|p| { p.as_object_mut().unwrap().remove("ledger"); }, D, "no usage ledger");
    refused(|p| { p["ledger"].as_object_mut().unwrap().remove("nativeCompletion"); }, D, "no record that its native run completed");
    refused(|p| p["coveragePolicyVersion"] = json!(2), D, "another coverage or review policy");
    refused(|p| p["policyVersion"] = json!(2), D, "another coverage or review policy");
    refused(|p| { p.as_object_mut().unwrap().remove("scope"); }, D, "no recorded scope");
    refused(|p| { p["coverage"].as_object_mut().unwrap().remove("coveredFiles"); }, D, "no recorded scope");
    refused(|p| p["requestedModel"] = json!("other"), D, "harness or model changed");
    refused(|p| { p["contextReads"][1].as_object_mut().unwrap().remove("responseSha256"); }, D, "without a recorded hash");
}

#[test]
fn the_fetched_head_is_checked_again_before_any_model_starts() {
    let mut run = json!({"headSha":B,"mergeBaseSha":C,"scope":{"paths":[]},"files":[]});
    assert!(compare(&previous(), &mut run).unwrap_err().to_string().contains("use review_continue"));
}

#[test]
fn a_head_that_changes_only_paths_no_review_can_cover_is_refused_for_what_it_is() {
    let side = |blob: &str| json!({"blobSha":blob.repeat(40),"mode":"100644"});
    let mut earlier = previous();
    earlier["scope"]["paths"] = json!([
        {"path":"a.rs","status":"modified","state":"covered","head":side("1"),"mergeBase":side("0")},
        {"path":"tool.exe","status":"modified","state":"unsupported","reason":"binary","head":side("5"),"mergeBase":side("0")}]);
    let next = |tool: &str| json!({"headSha":D,"mergeBaseSha":C,
        "scope":{"paths":[{"path":"a.rs","status":"modified","state":"not_read","head":side("1"),"mergeBase":side("0")},
            {"path":"tool.exe","status":"modified","state":"unsupported","reason":"binary","head":side(tool),"mergeBase":side("0")}]},
        "files":[{"path":"a.rs","status":"modified","sourceRevision":D,"sourceBlob":"1".repeat(40)},
            {"path":"tool.exe","status":"modified","sourceRevision":D,"sourceBlob":tool.repeat(40)}]});
    // Only the binary changed: refused, and it says so rather than "nothing changed".
    let refused = compare(&earlier, &mut next("6")).unwrap_err().to_string();
    assert!(refused.contains("changes only paths no review can cover") && refused.contains("tool.exe"), "{refused}");
    assert!(!refused.contains("changes none"), "{refused}");
    // Nothing changed at all: the earlier message stands.
    assert!(compare(&earlier, &mut next("5")).unwrap_err().to_string().contains("changes none of the PR's paths"));
    // A reviewable change beside it starts the round; the binary stays outside its scope.
    let mut run = next("6");
    run["scope"]["paths"][0]["head"] = side("2");
    run["files"][0]["sourceBlob"] = json!("2".repeat(40));
    assert!(compare(&earlier, &mut run).unwrap().is_empty());
    assert_eq!(run["incremental"]["targets"], json!([{"path":"a.rs","status":"modified","why":"changed","changedSinceEarlierHead":true}]));
}

/// An incremental round of A → D after `previous`, as prepared: b.rs changed
/// since B and this round read it; a.rs is carried from the earlier round.
fn round(previous: &Value) -> Value {
    let mut incremental = record(previous);
    incremental["targets"] = json!([{"path":"b.rs","status":"modified","why":"changed","changedSinceEarlierHead":true},
        {"path":"c.rs","status":"added","why":"new_in_pr","changedSinceEarlierHead":true}]);
    incremental["carriedPaths"] = json!(["a.rs"]);
    incremental["leftThePr"] = json!([]);
    json!({"id":"now","kind":"incremental","previousReviewId":previous["id"],"status":"running","policyVersion":policy::VERSION,"reasonCodes":[],"conclusion":"unknown","findings":[],
        "headSha":D,"mergeBaseSha":C,"contextIncomplete":false,"incremental":incremental,
        "coverage":{"coveredFiles":[{"path":"a.rs","evidenceKind":"complete_diff","byReview":"earlier"},
            {"path":"b.rs","evidenceKind":"complete_diff","byReview":"now"},{"path":"c.rs","evidenceKind":"full_added_source","byReview":"now"}]},
        "files":[{"path":"a.rs","status":"modified","lines":5,"sourceBlob":"1".repeat(40)},{"path":"b.rs","status":"modified","lines":5,"sourceBlob":"3".repeat(40)},
            {"path":"c.rs","status":"added","lines":5,"sourceBlob":"4".repeat(40)}]})
}

fn report(correctness: &str, findings: Value, answers: Value) -> Value {
    json!({"findings":findings,"overall_correctness":correctness,"overall_explanation":"Read b.rs and c.rs","overall_confidence_score":0.8,"previous_findings":answers})
}

fn fixed(index: u64, paths: Value) -> Value {
    json!({"index":index,"disposition":"fixed","fix_paths":paths,"explanation":"b.rs now checks its caller's input"})
}

#[test]
fn an_earlier_finding_is_settled_only_by_this_rounds_own_reads_of_what_changed() {
    let earlier = previous();
    // Fixed in b.rs, which changed since B and this round read: settled.
    let mut run = round(&earlier);
    reviewer::complete_report(&report("patch is correct", json!([]), json!([fixed(0, json!(["b.rs"]))])), &mut run);
    assert_eq!(run["status"], "completed", "{}", run["error"]);
    assert_eq!(run["settledFindings"][0]["title"], "Bug");
    assert_eq!(run["settledFindings"][0]["settlement"], json!({"disposition":"fixed","fixPaths":["b.rs"],"explanation":"b.rs now checks its caller's input","settledBy":"now"}));
    // The unanswered P3 note stays, so a clean round approves with notes.
    assert_eq!(run["findings"].as_array().unwrap().len(), 1);
    assert_eq!(run["findings"][0]["origin"], json!({"reviewId":"earlier","carried":true}));
    assert_eq!(run["findings"][0]["disposition"], json!({"state":"still_valid","reason":"not answered"}));
    assert_eq!(run["conclusion"], "approved_with_notes");
    assert!(policy::passes(&run));
    // Anything else leaves the P1 in place, and it blocks.
    let stays = |answers: Value, reason: &str| {
        let mut run = round(&earlier);
        reviewer::complete_report(&report("patch is correct", json!([]), answers), &mut run);
        assert_eq!(run["status"], "completed");
        let bug = run["findings"].as_array().unwrap().iter().find(|f| f["title"] == "Bug").expect("the P1 stays");
        assert_eq!(bug["disposition"]["reason"], reason);
        assert_eq!(run["conclusion"], "changes_requested");
        assert!(!policy::passes(&run));
        assert!(run["settledFindings"].as_array().unwrap().iter().all(|f| f["title"] != "Bug"));
    };
    stays(json!([]), "not answered");
    stays(json!([{"index":0,"disposition":"still_valid","fix_paths":[],"explanation":"Still there"}]), "not shown fixed");
    stays(json!([fixed(0, json!(["b.rs"])), fixed(0, json!(["b.rs"]))]), "answered more than once");
    stays(json!([fixed(0, json!([]))]), "fixed without fix paths");
    stays(json!([fixed(0, json!(["b.rs", 7]))]), "fixed without fix paths");
    // a.rs is carried from the earlier round: unchanged, so it holds no fix.
    stays(json!([fixed(0, json!(["a.rs"]))]), "a fix path didn't change since the earlier head or wasn't read completely by this round");
    stays(json!([fixed(0, json!(["elsewhere.rs"]))]), "a fix path didn't change since the earlier head or wasn't read completely by this round");
    stays(json!([{"index":0,"disposition":"fixed","fix_paths":["b.rs"],"explanation":"  "}]), "fixed without an explanation");
    // A changed path this round didn't read completely holds no proof of a fix.
    let mut run = round(&earlier);
    run["coverage"]["coveredFiles"].as_array_mut().unwrap().retain(|c| c["path"] != "b.rs");
    reviewer::complete_report(&report("patch is correct", json!([]), json!([fixed(0, json!(["b.rs"]))])), &mut run);
    assert_eq!(run["conclusion"], "changes_requested");
    // A path whose object is the earlier head's, or can't be shown to differ
    // from it (a new merge base, a path that wasn't in the earlier PR), can't
    // hold a fix either, however this PR lists it.
    for (why, since) in [("not_covered_before", json!(false)), ("merge_base_changed", json!(false)), ("merge_base_changed", Value::Null)] {
        let mut run = round(&earlier);
        run["incremental"]["targets"][0]["why"] = json!(why);
        run["incremental"]["targets"][0]["changedSinceEarlierHead"] = since;
        reviewer::complete_report(&report("patch is correct", json!([]), json!([fixed(0, json!(["b.rs"]))])), &mut run);
        assert_eq!(run["conclusion"], "changes_requested", "{why}");
    }
}

#[test]
fn the_verdict_is_about_this_head_and_new_findings_join_the_kept_ones() {
    let earlier = previous();
    let blocker = json!({"title":"New bug","body":"c.rs panics","priority":2,"code_location":{"absolute_file_path":"c.rs","line_range":{"start":1,"end":2}}});
    let mut run = round(&earlier);
    reviewer::complete_report(&report("patch is incorrect", json!([blocker]), json!([fixed(0, json!(["b.rs"])), fixed(1, json!(["b.rs"]))])), &mut run);
    assert_eq!(run["conclusion"], "changes_requested");
    assert_eq!(run["settledFindings"].as_array().unwrap().len(), 2);
    assert_eq!(run["findings"].as_array().unwrap().iter().map(|f| f["origin"].clone()).collect::<Vec<_>>(), [json!({"reviewId":"now","carried":false})]);
    // The earlier round's own verdict was about its head and isn't carried.
    let mut run = round(&earlier);
    reviewer::complete_report(&report("patch is correct", json!([]), json!([fixed(0, json!(["b.rs"])), fixed(1, json!(["b.rs"]))])), &mut run);
    assert_eq!(run["conclusion"], "no_findings");
    assert!(policy::passes(&run));
    // Incomplete coverage or an unknown verdict never passes.
    let mut run = round(&earlier);
    run["contextIncomplete"] = json!(true);
    reviewer::complete_report(&report("patch is correct", json!([]), json!([fixed(0, json!(["b.rs"])), fixed(1, json!(["b.rs"]))])), &mut run);
    assert_eq!(run["conclusion"], "unknown");
    assert!(!policy::passes(&run));
    // A report without the answers is invalid, never a clean conclusion.
    let mut run = round(&earlier);
    let mut missing = report("patch is correct", json!([]), json!([]));
    missing.as_object_mut().unwrap().remove("previous_findings");
    reviewer::complete_report(&missing, &mut run);
    assert_eq!(run["status"], "unknown");
    assert!(run["error"].as_str().unwrap().contains("previous_findings: expected a required array"), "{}", run["error"]);
    // A full round's report can't carry the answers.
    let mut full = round(&earlier);
    full.as_object_mut().unwrap().remove("kind");
    reviewer::complete_report(&report("patch is correct", json!([]), json!([])), &mut full);
    assert_eq!(full["status"], "unknown");
}

#[test]
fn the_schema_and_prompt_ask_for_one_answer_per_earlier_finding() {
    let evidence = json!({"incrementalOf":{"reviewId":"earlier","findings":[{"index":0},{"index":1}]},"targets":[],"alreadyCovered":[]}).to_string();
    let schema = reviewer::schema(&evidence);
    assert!(schema["required"].as_array().unwrap().contains(&json!("previous_findings")));
    assert_eq!(schema["properties"]["previous_findings"]["maxItems"], 2);
    assert_eq!(schema["properties"]["previous_findings"]["items"]["properties"]["disposition"]["enum"], json!(["fixed","still_valid"]));
    assert!(reviewer::prompt(&evidence).contains("INCREMENTAL review of a NEW head"));
    // Other rounds keep their schema and prompt.
    assert_eq!(reviewer::schema("{}"), reviewer::output_schema());
    assert!(!reviewer::prompt("{}").contains("INCREMENTAL"));
}

#[test]
fn the_ledger_shows_this_rounds_use_and_the_chains() {
    let mut run = round(&previous());
    run["ledger"] = json!({"version":LEDGER_VERSION,"operationMs":200_000,"calls":4,"bytes":9_000,"nativeUsage":{"state":"reported","totalCostUsd":0.25}});
    let chain = cumulative(&run);
    assert_eq!((&chain["calls"], &chain["bytes"], &chain["operationMs"]), (&json!(7), &json!(14_000), &json!(500_000)));
    assert_eq!(chain["nativeUsage"], json!({"state":"reported","basis":"the sum of each run's own harness estimate, not a bill","totalCostUsd":0.75}));
    // Each run's own report stays as recorded, tokens included.
    assert_eq!(chain["runs"][0], json!({"reviewId":"earlier","calls":3,"bytes":5_000,"operationMs":300_000,"nativeUsage":{"state":"reported","totalCostUsd":0.5}}));
    assert_eq!(chain["runs"][1]["reviewId"], "now");
    // Unknown stays unknown, never zero.
    run["ledger"]["nativeUsage"] = json!({"state":"unknown","reason":"Codex reports no cost for a review turn"});
    let chain = cumulative(&run);
    assert_eq!(chain["nativeUsage"], json!({"state":"unknown"}));
    assert_eq!(chain["runs"][1]["nativeUsage"]["state"], "unknown");
}

fn setup() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let task = s
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Deliver PR"}))
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.github_link_object(&task, &Repository { id: 7, full_name: "o/r".into() }, "pull", 1, json!({"baseSha":A,"headSha":D,"state":"open"})).unwrap();
    (dir, s, task)
}

fn start(task: &str, key: &str, head: &str, previous: Option<&str>) -> crate::pr_review::Start {
    serde_json::from_value(json!({"requestId":key,"taskId":task,"linkId":"7:pull:1","baseSha":A,"headSha":head,"previousReviewId":previous})).unwrap()
}

/// Stores a created round as the completed earlier round above.
fn complete(store: &Store, mut run: Value) {
    for (key, value) in previous().as_object().unwrap() {
        if !matches!(key.as_str(), "id" | "round") {
            run[key] = value.clone();
        }
    }
    store.save_pr_review(&run, Some("earlier report")).unwrap();
}

#[test]
fn an_incremental_round_is_admitted_when_created_and_shares_the_prs_two_rounds() {
    let (_dir, store, task) = setup();
    let (run, _) = store.create_pr_review(None, &start(&task, "r1", B, None), "earlier").unwrap();
    complete(&store, run);
    let (run, created) = store.create_pr_review(None, &start(&task, "r2", D, Some("earlier")), "now").unwrap();
    assert!(created);
    assert_eq!((run["kind"].as_str(), run["previousReviewId"].as_str(), run["round"].as_i64()), (Some("incremental"), Some("earlier"), Some(2)));
    assert_eq!(run["incremental"]["previousFindings"][1]["index"], 1);
    assert_eq!(run["incremental"]["previousLedger"]["calls"], 3);
    // A lost reply repeats the same round; another payload under it is refused.
    let (again, created) = store.create_pr_review(None, &start(&task, "r2", D, Some("earlier")), "other").unwrap();
    assert!(!created && again["id"] == "now");
    assert!(store.create_pr_review(None, &start(&task, "r2", D, None), "other").unwrap_err().to_string().contains("idempotency_conflict"));
    // Two started rounds of this PR: neither another incremental round nor a continuation fits.
    let mut ended = store.pr_review_report(&task, "now").unwrap();
    ended["status"] = json!("unknown");
    store.save_pr_review(&ended, None).unwrap();
    let refused = store.create_pr_review(None, &start(&task, "r3", D, Some("earlier")), "third").unwrap_err().to_string();
    assert!(refused.contains("already has 2 review rounds") && refused.contains("No review was started"), "{refused}");
    let continuation: crate::pr_review::continuation::Continue = serde_json::from_value(json!({"requestId":"c1","taskId":task,"reviewId":"earlier","baseSha":A,"headSha":B})).unwrap();
    assert!(store.create_pr_review_continuation(None, &continuation, "child").is_err());
    assert_eq!(store.list_pr_reviews(&task, None).unwrap()["reviews"].as_array().unwrap().len(), 2, "nothing more was created");
}

#[test]
fn an_incremental_round_that_provably_started_nothing_leaves_the_limit_and_refusals_create_nothing() {
    let (_dir, store, task) = setup();
    let (run, _) = store.create_pr_review(None, &start(&task, "r1", B, None), "earlier").unwrap();
    complete(&store, run);
    // Refused before it exists: same head, or an earlier round that isn't this PR's.
    let same = store.create_pr_review(None, &start(&task, "same", B, Some("earlier")), "x").unwrap_err().to_string();
    assert!(same.contains("use review_continue") && same.contains("No review was started"), "{same}");
    assert!(store.create_pr_review(None, &start(&task, "none", D, Some("missing")), "x").unwrap_err().to_string().contains("belongs to this task's PR"));
    assert_eq!(store.list_pr_reviews(&task, None).unwrap()["reviews"].as_array().unwrap().len(), 1);
    // Refused while preparing, before its native start: it doesn't count.
    let (mut refused, _) = store.create_pr_review(None, &start(&task, "r2", D, Some("earlier")), "refused").unwrap();
    refused["status"] = json!("failed");
    refused["reasonCodes"] = json!(["incremental_refused"]);
    store.save_pr_review(&refused, None).unwrap();
    let (run, created) = store.create_pr_review(None, &start(&task, "r3", D, Some("earlier")), "now").unwrap();
    assert!(created && run["kind"] == "incremental");
}

#[test]
fn after_a_continuation_used_the_second_round_no_incremental_round_fits() {
    let (_dir, store, task) = setup();
    let (mut run, _) = store.create_pr_review(None, &start(&task, "r1", B, None), "earlier").unwrap();
    // Completed with b.rs left unread, so its continuation is admitted.
    for (key, value) in previous().as_object().unwrap() {
        if !matches!(key.as_str(), "id" | "round") {
            run[key] = value.clone();
        }
    }
    run["scope"]["paths"][1]["state"] = json!("not_read");
    run["coverage"]["coveredFiles"].as_array_mut().unwrap().truncate(1);
    store.save_pr_review(&run, None).unwrap();
    let continuation: crate::pr_review::continuation::Continue = serde_json::from_value(json!({"requestId":"c1","taskId":task,"reviewId":"earlier","baseSha":A,"headSha":B})).unwrap();
    assert!(store.create_pr_review_continuation(None, &continuation, "child").unwrap().2);
    let mut child = store.pr_review_report(&task, "child").unwrap();
    child["status"] = json!("unknown");
    store.save_pr_review(&child, None).unwrap();
    // A new head doesn't buy a third round.
    let refused = store.create_pr_review(None, &start(&task, "r3", D, Some("earlier")), "third").unwrap_err().to_string();
    assert!(refused.contains("already has 2 review rounds"), "{refused}");
}

#[test]
fn a_restart_leaves_an_unfinished_incremental_round_unknown_counted_and_never_run_again() {
    let (_dir, store, task) = setup();
    let (run, _) = store.create_pr_review(None, &start(&task, "r1", B, None), "earlier").unwrap();
    complete(&store, run);
    let (mut run, _) = store.create_pr_review(None, &start(&task, "r2", D, Some("earlier")), "now").unwrap();
    run["status"] = json!("running");
    run["nativeStartedAt"] = json!("2026-10-20T06:00:00Z");
    store.save_pr_review(&run, None).unwrap();
    store.recover_pr_reviews().unwrap();
    let after = store.pr_review_report(&task, "now").unwrap();
    assert_eq!((after["status"].as_str(), after["conclusion"].as_str(), after["kind"].as_str()), (Some("unknown"), Some("unknown"), Some("incremental")));
    // Its requestId returns the same record; nothing is started again.
    let (again, created) = store.create_pr_review(None, &start(&task, "r2", D, Some("earlier")), "other").unwrap();
    assert!(!created && again["id"] == "now");
    // It may have started a model, so it counts.
    assert!(store.create_pr_review(None, &start(&task, "r3", D, Some("earlier")), "third").unwrap_err().to_string().contains("already has 2"));
}

const E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/// A round at a new merge base E, which brought in z.rs, changed w.rs and
/// removed v.rs since C. Every path is a target and this round read each
/// completely, and z.rs and w.rs whole at their new objects.
fn base_round(previous: &Value) -> Value {
    let mut run = round(previous);
    run["mergeBaseSha"] = json!(E);
    let i = &mut run["incremental"];
    i["sameMergeBase"] = json!(false);
    i["targets"] = json!(["a.rs", "b.rs", "c.rs"].map(|path| json!({"path":path,"status":"modified","why":"merge_base_changed","changedSinceEarlierHead":false})));
    i["carriedPaths"] = json!([]);
    i["baseChanges"] = json!({"state":"read","from":C,"to":E,"truncated":false,"paths":[
        {"path":"z.rs","status":"A","fromBlob":null,"toBlob":"5".repeat(40)},
        {"path":"w.rs","status":"M","fromBlob":"6".repeat(40),"toBlob":"7".repeat(40)},
        {"path":"v.rs","status":"D","fromBlob":"8".repeat(40),"toBlob":null}]});
    run["coverage"]["coveredFiles"] = json!(["a.rs", "b.rs", "c.rs"].map(|path| json!({"path":path,"evidenceKind":"complete_diff","byReview":"now"})));
    let whole = |path: &str, blob: &str, start: u64, end: u64, total: u64| json!({"tool":"source_read","path":path,"blobSha":blob,"startLine":start,"endLine":end,"totalLines":total});
    run["contextReads"] = json!([whole("z.rs", &"5".repeat(40), 1, 3, 3), whole("w.rs", &"7".repeat(40), 1, 500, 900), whole("w.rs", &"7".repeat(40), 501, 900, 900)]);
    run
}

fn by_base(index: u64, paths: Value) -> Value {
    json!({"index":index,"disposition":"fixed_by_base","fix_paths":[],"base_paths":paths,"explanation":"The new base defines what b.rs calls"})
}

#[test]
fn a_finding_a_new_merge_base_answers_is_settled_only_by_base_paths_this_round_read_whole() {
    let earlier = previous();
    let mut run = base_round(&earlier);
    reviewer::complete_report(&report("patch is correct", json!([]), json!([by_base(0, json!(["z.rs", "w.rs"])), by_base(1, json!(["z.rs"]))])), &mut run);
    assert_eq!(run["status"], "completed", "{}", run["error"]);
    assert_eq!(run["settledFindings"][0]["settlement"], json!({"disposition":"fixed_by_base","fixPaths":[],
        "basePaths":[{"path":"z.rs","fromBlob":null,"toBlob":"5".repeat(40)},{"path":"w.rs","fromBlob":"6".repeat(40),"toBlob":"7".repeat(40)}],
        "explanation":"The new base defines what b.rs calls","settledBy":"now"}));
    assert_eq!(run["conclusion"], "no_findings");
    assert!(policy::passes(&run));
    // Anything else leaves the P1, and it blocks.
    let stays = |edit: &dyn Fn(&mut Value), answers: Value, reason: &str| {
        let mut run = base_round(&earlier);
        edit(&mut run);
        reviewer::complete_report(&report("patch is correct", json!([]), answers), &mut run);
        let bug = run["findings"].as_array().unwrap().iter().find(|f| f["title"] == "Bug").expect("the P1 stays");
        assert_eq!(bug["disposition"]["reason"], reason);
        assert_eq!(run["conclusion"], "changes_requested", "{reason}");
    };
    let none = |_: &mut Value| {};
    let z = || json!([by_base(0, json!(["z.rs"]))]);
    stays(&|r: &mut Value| r["incremental"]["sameMergeBase"] = json!(true), z(), "the merge base didn't change since the earlier round");
    stays(&|r: &mut Value| r["incremental"]["baseChanges"] = json!({"state":"unavailable","error":"Fixed Git objects are unavailable"}), z(), "Core couldn't read what the new merge base changed");
    stays(&|r: &mut Value| { r["incremental"].as_object_mut().unwrap().remove("baseChanges"); }, z(), "Core couldn't read what the new merge base changed");
    // Code that is in the base now: the finding's own file changed there.
    stays(&|r: &mut Value| r["incremental"]["baseChanges"]["paths"].as_array_mut().unwrap().push(json!({"path":"b.rs","status":"M","fromBlob":"9".repeat(40),"toBlob":"a".repeat(40)})),
        z(), "its own path changed in the new merge base, so the code it is about may be there now");
    // Its file left the PR, or this round didn't read it completely.
    stays(&|r: &mut Value| { r["incremental"]["targets"].as_array_mut().unwrap().retain(|t| t["path"] != "b.rs"); r["incremental"]["leftThePr"] = json!(["b.rs"]); },
        z(), "its own path isn't a target this round read completely");
    stays(&|r: &mut Value| r["coverage"]["coveredFiles"].as_array_mut().unwrap().retain(|c| c["path"] != "b.rs"), z(), "its own path isn't a target this round read completely");
    stays(&none, json!([by_base(0, json!([]))]), "fixed by the base without base paths");
    stays(&none, json!([by_base(0, json!(["z.rs", 7]))]), "fixed by the base without base paths");
    stays(&none, json!([by_base(0, json!(["z.rs", "z.rs"]))]), "fixed by the base without base paths");
    // Not something the new merge base brought: unchanged there, removed, or the finding's own file.
    for path in ["a.rs", "v.rs", "elsewhere.rs", "b.rs"] {
        stays(&none, json!([by_base(0, json!([path]))]), "a base path isn't one the new merge base added or changed");
    }
    // Not read whole at its new object.
    stays(&|r: &mut Value| { r["contextReads"].as_array_mut().unwrap().pop(); }, json!([by_base(0, json!(["w.rs"]))]), "a base path wasn't read completely by this round at the new merge base");
    stays(&|r: &mut Value| r["contextReads"][0]["blobSha"] = json!("9".repeat(40)), z(), "a base path wasn't read completely by this round at the new merge base");
    stays(&|r: &mut Value| r["contextReads"][0]["tool"] = json!("source_search"), z(), "a base path wasn't read completely by this round at the new merge base");
    stays(&none, json!([{"index":0,"disposition":"fixed_by_base","fix_paths":[],"base_paths":["z.rs"],"explanation":" "}]), "fixed without an explanation");
    // Answered once only, as any other disposition.
    stays(&none, json!([by_base(0, json!(["z.rs"])), by_base(0, json!(["z.rs"]))]), "answered more than once");
    // The plain fix still needs a path that changed since the earlier head.
    stays(&none, json!([fixed(0, json!(["b.rs"]))]), "a fix path didn't change since the earlier head or wasn't read completely by this round");
}

fn sha(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Every round's instructions and report schema before YN-67 (computed on
/// main at e676b0e8): a round whose merge base didn't change, a round of an
/// older coverage policy and every full or continuation round keep them byte
/// for byte. Change these only with a deliberate prompt change.
const PINNED: &[&str] = &[
    "full-v1 9fab5f526414969bf7d45352766478e4455145edb5b35cd87a7f10593dc48424 52a1bfe7bf683c8245cd54356b802695d48d60f5e3e432cb7e170542154fd9e6",
    "full-v2 11088ad621d9405cd9affdc84950ab957debd02e8d1aebfc20e729e8c4df34b9 52a1bfe7bf683c8245cd54356b802695d48d60f5e3e432cb7e170542154fd9e6",
    "full-v3 4c13c1d4e5335908996127418f6a90fa6d46d27ce26022470ab02ae4922f4eb7 52a1bfe7bf683c8245cd54356b802695d48d60f5e3e432cb7e170542154fd9e6",
    "full-v3-outside bebaa28d8e1ab3f28964f6f7c48dffc094351d4754fae0d6007c6707947a935f 52a1bfe7bf683c8245cd54356b802695d48d60f5e3e432cb7e170542154fd9e6",
    "continuation-v3 698f50af13b97be510e0c5f9e7e213df0ed15b1440ccfdf10c17b0e252314d55 52a1bfe7bf683c8245cd54356b802695d48d60f5e3e432cb7e170542154fd9e6",
    "incremental-same-base 5c5313d6e7438d8c3d2e63b66ac7300d2423a1655d3a70088ae8303aaf714e42 80778ef5583ac70fede2c9f76ef431a3c5c2f6ff0348d5ab389ef68e3ee2b037",
    "incremental-v2-base-changed 9e986e9a83301c214f5511c47e9e9b025cabb12966a57107e518ece21bc75195 80778ef5583ac70fede2c9f76ef431a3c5c2f6ff0348d5ab389ef68e3ee2b037",
];

#[test]
fn only_a_round_whose_merge_base_changed_is_offered_fixed_by_base_and_every_other_prompt_stays_byte_for_byte() {
    let findings = json!([{"index":0},{"index":1}]);
    let moved = json!({"from":C,"to":E,"paths":[{"path":"z.rs","status":"A"}],"listed":1,"total":1});
    let changed = json!({"coveragePolicyVersion":3,"incrementalOf":{"reviewId":"earlier","findings":findings},"mergeBaseChanged":moved}).to_string();
    let variants = [
        ("full-v1", "fixed evidence".to_owned()),
        ("full-v2", json!({"coveragePolicyVersion":2}).to_string()),
        ("full-v3", json!({"coveragePolicyVersion":3}).to_string()),
        ("full-v3-outside", json!({"coveragePolicyVersion":3,"knownOutsideScope":[{"path":"x.bin","state":"unsupported","reason":"binary"}]}).to_string()),
        ("continuation-v3", json!({"coveragePolicyVersion":3,"continuationOf":{"reviewId":"earlier"}}).to_string()),
        ("incremental-same-base", json!({"coveragePolicyVersion":3,"incrementalOf":{"reviewId":"earlier","findings":findings}}).to_string()),
        ("incremental-v2-base-changed", json!({"coveragePolicyVersion":2,"incrementalOf":{"reviewId":"earlier","findings":findings},"mergeBaseChanged":moved}).to_string()),
    ];
    let actual: Vec<String> = variants.iter().map(|(name, e)| format!("{name} {} {}", sha(&reviewer::prompt(e)), sha(&reviewer::schema(e).to_string()))).collect();
    println!("PINNED:\n{}", actual.join("\n"));
    let schema = reviewer::schema(&changed);
    let items = &schema["properties"]["previous_findings"]["items"];
    assert_eq!(items["properties"]["disposition"]["enum"], json!(["fixed","still_valid","fixed_by_base"]));
    assert!(items["required"].as_array().unwrap().contains(&json!("base_paths")));
    let prompt = reviewer::prompt(&changed);
    assert!(prompt.contains("mergeBaseChanged") && prompt.contains("fixed_by_base") && prompt.contains("base_paths"), "{prompt}");
    assert!(prompt.contains("in the base now is not fixed by it"), "{prompt}");
    assert_eq!(actual, PINNED);
}
