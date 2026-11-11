use super::*;
use crate::{github::client::Repository, store::Store};

fn setup() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let task = s
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"create","title":"Deliver PR"}),
        )
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.github_link_object(
        &task,
        &Repository {
            id: 7,
            full_name: "owner/repo".into(),
        },
        "pull",
        1,
        json!({"baseSha":"a".repeat(40),"headSha":"b".repeat(40)}),
    )
    .unwrap();
    (dir, s, task)
}

#[test]
fn history_survives_retry_restart_and_does_not_change_task() {
    let (dir, s, task) = setup();
    let original = s
        .collaboration_call(None, "task_get", json!({"taskId":task}))
        .unwrap()["task"]
        .clone();
    let (mut run, _) = s
        .create_pr_review(None, &input(&task, "first"), "first")
        .unwrap();
    assert_eq!(run["coveragePolicyVersion"], source::COVERAGE_VERSION);
    assert!(s
        .create_pr_review(None, &input(&task, "duplicate"), "duplicate")
        .is_err());
    run["status"] = json!("failed");
    s.save_pr_review(&run, Some("original incomplete output"))
        .unwrap();
    assert!(s.save_pr_review(&run, Some("overwrite")).is_err());
    s.create_pr_review(None, &input(&task, "retry"), "retry")
        .unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.recover_pr_reviews().unwrap();
    let page = s.list_pr_reviews(&task, None).unwrap();
    assert_eq!(page["reviews"][0]["status"], "unknown");
    assert_eq!(page["reviews"][0]["conclusion"], "unknown");
    assert_eq!(
        s.pr_review_report(&task, "first").unwrap()["rawReport"],
        "original incomplete output"
    );
    let task_after = s
        .collaboration_call(None, "task_get", json!({"taskId":task}))
        .unwrap()["task"]
        .clone();
    assert_eq!(task_after["version"], original["version"]);
    assert_eq!(task_after["status"], original["status"]);
    assert!(s.pr_review_report("missing", "first").is_err());
}

#[test]
fn outdated_uses_both_frozen_shas_and_is_independent_of_cache_stale() {
    let run = json!({"baseSha":"a","headSha":"b"});
    assert_eq!(
        store::outdated(&run, &json!({"baseSha":"a","headSha":"b","stale":true})),
        false
    );
    assert_eq!(
        store::outdated(&run, &json!({"baseSha":"c","headSha":"b"})),
        true
    );
    assert_eq!(
        store::outdated(&run, &json!({"baseSha":"a","headSha":"c"})),
        true
    );
    assert!(store::outdated(&run, &json!({"headSha":"b"})).is_null());
}

#[test]
fn conclusions_require_explicit_native_output_and_verified_locations() {
    let run = json!({"headSha":"b","mergeBaseSha":"a","files":[{"path":"src/a.rs","status":"modified","lines":5}]});
    for correctness in ["", "PASS", "uncertain"] {
        let mut report = valid_report();
        report["overall_correctness"] = json!(correctness);
        assert!(
            reviewer::normalize(&report, &run)
                .unwrap_err()
                .to_string()
                .contains("overall_correctness")
        );
    }
    assert_eq!(
        reviewer::normalize(&valid_report(), &run).unwrap()["conclusion"],
        "no_findings"
    );
    let mut report = valid_report();
    report["overall_correctness"] = json!("patch is incorrect");
    report["findings"] = json!([valid_finding()]);
    assert_eq!(
        reviewer::normalize(&report, &run).unwrap()["findings"][0]["revision"],
        "b"
    );
    report["findings"][0]["code_location"]["absolute_file_path"] = json!("../../etc/passwd");
    assert!(reviewer::normalize(&report, &run).is_err());
}

fn input(task: &str, key: &str) -> Start {
    Start {
        task_id: task.into(),
        link_id: "7:pull:1".into(),
        request_id: key.into(),
        notify_agent_id: None,
        base_sha: None,
        head_sha: None,
        acknowledge_unreviewable: None,
        previous_review_id: None,
        beyond_round_limit: None,
    }
}

#[test]
fn idempotency_is_durable_and_settings_are_frozen_per_round() {
    let (dir, s, task) = setup();
    let request = input(&task, "stable-key");
    let (mut first, created) = s.create_pr_review(None, &request, "first").unwrap();
    assert!(created);
    s.save_review_settings(&settings::Settings {
        harness: "claude".into(),
        model: "native-choice".into(),
    })
    .unwrap();
    let (retry, created) = s
        .create_pr_review(None, &request, "must-not-start")
        .unwrap();
    assert!(!created);
    assert_eq!(retry["id"], "first");
    assert_eq!(retry["requestedModel"], MODEL);
    let mut conflicting = request.clone();
    conflicting.head_sha = Some("c".repeat(40));
    assert!(s
        .previous_pr_review(None, &conflicting)
        .unwrap_err()
        .to_string()
        .contains("idempotency_conflict"));
    first["status"] = json!("cancelled");
    s.save_pr_review(&first, None).unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(
        s.previous_pr_review(None, &request).unwrap().unwrap()["status"],
        "cancelled"
    );
    let (next, _) = s
        .create_pr_review(None, &input(&task, "new-round"), "second")
        .unwrap();
    assert_eq!(next["round"], 2);
    assert_eq!(next["requestedHarness"], "claude");
    assert_eq!(next["requestedModel"], "native-choice");
    assert_eq!(
        s.list_pr_reviews(&task, None).unwrap()["reviews"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn context_paths_are_fixed_and_incomplete_context_cannot_pass() {
    let output = valid_report();
    assert_eq!(
        reviewer::normalize(&output, &json!({"contextIncomplete":true})).unwrap()["conclusion"],
        "unknown"
    );
}

fn valid_report() -> Value {
    json!({"findings":[],"overall_correctness":"patch is correct","overall_explanation":"Reviewed all fixed diffs","overall_confidence_score":0.85})
}

fn valid_finding() -> Value {
    json!({"title":"Bug","body":"Reason","priority":1,"code_location":{"absolute_file_path":"src/a.rs","line_range":{"start":2,"end":3}}})
}

fn report_run() -> Value {
    json!({"status":"running","policyVersion":policy::VERSION,"reasonCodes":[],"conclusion":"unknown","findings":[],"headSha":"head","mergeBaseSha":"base","files":[{"path":"src/a.rs","status":"modified","lines":5,"sourceBlob":"blob"}]})
}

#[test]
fn report_priorities_and_valid_conclusions_keep_their_meaning() {
    let mut output = valid_report();
    let mut run = report_run();
    for priority in 0..=3 {
        let mut finding = valid_finding();
        finding["priority"] = json!(priority);
        output["findings"] = json!([finding]);
        output["overall_correctness"] = json!("patch is incorrect");
        let result = reviewer::normalize(&output, &run).unwrap();
        assert_eq!(result["conclusion"], "changes_requested");
        assert_eq!(result["findings"][0]["priority"], priority);
        assert_eq!(result["findings"][0]["revision"], "head");
        assert_eq!(result["findings"][0]["blobSha"], "blob");
        output["overall_correctness"] = json!("patch is correct");
        assert_eq!(
            reviewer::normalize(&output, &run).unwrap()["conclusion"],
            if priority == 3 { "approved_with_notes" } else { "unknown" }
        );
    }
    run["files"][0]["status"] = json!("removed");
    assert_eq!(
        reviewer::normalize(&output, &run).unwrap()["findings"][0]["revision"],
        "base"
    );
    output["findings"] = json!([]);
    for (correctness, conclusion) in [
        ("patch is correct", "no_findings"),
        ("patch is incorrect", "changes_requested"),
        ("unknown", "unknown"),
    ] {
        output["overall_correctness"] = json!(correctness);
        assert_eq!(
            reviewer::normalize(&output, &run).unwrap()["conclusion"],
            conclusion
        );
    }
    output["overall_correctness"] = json!("patch is correct");
    run["contextIncomplete"] = json!(true);
    reviewer::complete_report(&output, &mut run);
    assert_eq!(run["conclusion"], "unknown");
    assert!(
        run["error"]
            .as_str()
            .unwrap()
            .contains("coverage is incomplete")
    );
}

#[test]
fn report_invalid_priorities_name_the_exact_finding_and_allowed_values() {
    for priority in [
        json!(4),
        json!(-1),
        json!(1.5),
        json!("P2"),
        json!("2"),
        json!(null),
        json!(true),
    ] {
        let mut output = valid_report();
        let mut bad = valid_finding();
        bad["priority"] = priority.clone();
        output["findings"] = json!([valid_finding(), bad]);
        let original = output.clone();
        let mut run = report_run();
        reviewer::complete_report(&output, &mut run);
        let error = run["error"].as_str().unwrap();
        assert!(error.contains("findings[1].priority"), "{error}");
        assert!(
            error.contains("integer in 0..=3 (P0, P1, P2 or P3)"),
            "{error}"
        );
        assert!(error.contains(&format!("received {priority}")), "{error}");
        assert_eq!(run["status"], "unknown");
        assert_eq!(run["conclusion"], "unknown");
        assert_eq!(run["findings"], json!([]), "no partial or filtered report");
        assert_eq!(output, original, "do not clamp the original severity");
    }
}

#[test]
fn report_required_fields_and_bad_types_cannot_become_clean() {
    let mut complete = valid_report();
    complete["findings"] = json!([valid_finding()]);
    for (parent, fields) in [
        (
            "",
            vec![
                "findings",
                "overall_correctness",
                "overall_explanation",
                "overall_confidence_score",
            ],
        ),
        (
            "/findings/0",
            vec!["title", "body", "priority", "code_location"],
        ),
        (
            "/findings/0/code_location",
            vec!["absolute_file_path", "line_range"],
        ),
        ("/findings/0/code_location/line_range", vec!["start", "end"]),
    ] {
        for field in fields {
            let mut output = complete.clone();
            output
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            let mut run = report_run();
            reviewer::complete_report(&output, &mut run);
            let error = run["error"].as_str().unwrap();
            assert!(
                error.contains(field) && error.contains("received missing"),
                "{error}"
            );
            if !parent.is_empty() {
                assert!(error.contains("findings[0]"), "{error}");
            }
            assert_eq!(run["status"], "unknown");
            assert_eq!(run["conclusion"], "unknown");
        }
    }
    for (pointer, value, diagnostic) in [
        ("/findings", json!({}), "findings"),
        ("/overall_correctness", json!(42), "overall_correctness"),
        ("/overall_explanation", json!(null), "overall_explanation"),
        (
            "/overall_confidence_score",
            json!("high"),
            "overall_confidence_score",
        ),
        ("/findings/0", json!(null), "findings[0]"),
        ("/findings/0/title", json!("  "), "findings[0].title"),
        (
            "/findings/0/body",
            json!("x".repeat(20001)),
            "findings[0].body",
        ),
        (
            "/findings/0/code_location",
            json!([]),
            "findings[0].code_location",
        ),
        (
            "/findings/0/code_location/absolute_file_path",
            json!("../outside"),
            "absolute_file_path",
        ),
        (
            "/findings/0/code_location/line_range",
            json!(null),
            "line_range",
        ),
        (
            "/findings/0/code_location/line_range/start",
            json!(0),
            "line_range.start",
        ),
        (
            "/findings/0/code_location/line_range/end",
            json!("3"),
            "line_range.end",
        ),
        (
            "/findings/0/code_location/line_range/end",
            json!(1),
            "line_range",
        ),
        (
            "/findings/0/code_location/line_range/end",
            json!(6),
            "line_range",
        ),
    ] {
        let mut output = complete.clone();
        *output.pointer_mut(pointer).unwrap() = value;
        let mut run = report_run();
        reviewer::complete_report(&output, &mut run);
        let error = run["error"].as_str().unwrap();
        assert!(error.contains(diagnostic), "{pointer}: {error}");
        assert!(error.len() < 400, "bounded diagnostic: {pointer}");
        assert_eq!(run["conclusion"], "unknown");
    }
}

#[test]
fn report_priority4_incident_survives_storage_for_both_native_envelopes() {
    // Exact structured_output from T-103 PR107 R1:
    // 387c5c9f-8837-471f-af4a-6238c94b6c7b (complete source coverage).
    let report: Value = serde_json::from_str(include_str!("fixtures/priority4.json")).unwrap();
    let (dir, store, task) = setup();
    let mut originals = Vec::new();
    for harness in ["codex", "claude"] {
        let (mut run, _) = store
            .create_pr_review(None, &input(&task, harness), harness)
            .unwrap();
        run["status"] = json!("running");
        run["files"] =
            json!([{"path":".github/scripts/web_tests.py","status":"modified","lines":136}]);
        let raw = if harness == "claude" {
            json!({"type":"result","subtype":"success","structured_output":report}).to_string()
        } else {
            report.to_string()
        };
        reviewer::complete_report(&report, &mut run);
        assert_eq!(run["status"], "unknown");
        assert!(
            run["error"]
                .as_str()
                .unwrap()
                .contains("findings[0].priority")
        );
        store.save_pr_review(&run, Some(&raw)).unwrap();
        originals.push((harness, raw));
    }
    drop(store);
    let reopened = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    for (harness, raw) in originals {
        let saved = reopened.pr_review_report(&task, harness).unwrap();
        assert_eq!(saved["rawReport"], raw);
        assert_eq!(saved["conclusion"], "unknown");
        let native: Value = serde_json::from_str(&raw).unwrap();
        let original = if harness == "claude" {
            &native["structured_output"]
        } else {
            &native
        };
        assert_eq!(original["findings"][0]["priority"], 4);
        assert_eq!(original, &report);
    }
}

#[test]
fn report_schema_and_shared_prompt_constrain_priority_and_source_lines() {
    let schema = reviewer::output_schema();
    let finding = &schema["properties"]["findings"]["items"]["properties"];
    assert_eq!(finding["priority"]["type"], "integer");
    assert_eq!(finding["priority"]["enum"], json!([0, 1, 2, 3]));
    for bound in ["start", "end"] {
        assert_eq!(
            finding["code_location"]["properties"]["line_range"]["properties"][bound]["minimum"],
            1
        );
    }
    let prompt = reviewer::prompt("fixed evidence");
    assert!(prompt.contains("source_diff for EVERY changed path"));
    let added_prompt = reviewer::prompt(r#"{"coveragePolicyVersion":2}"#);
    assert!(added_prompt.contains("full_added_source coverage, not a delivered diff"));
    assert!(!added_prompt.contains("source_diff for EVERY changed path"));
    assert!(!added_prompt.contains("knownOutsideScope"));
    let scoped = reviewer::prompt(r#"{"coveragePolicyVersion":3,"knownOutsideScope":[{"path":"helper.exe","state":"unsupported","reason":"binary"}]}"#);
    assert!(scoped.contains("full_added_source coverage, not a delivered diff"));
    assert!(scoped.contains("knownOutsideScope lists changed paths") && scoped.contains("Do not request them"));
    for constraint in [
        "0=P0",
        "1=P1",
        "2=P2",
        "3=P3",
        "Never output priority 4",
        "overall_confidence_score",
        "repository-relative",
    ] {
        assert!(prompt.contains(constraint), "{constraint}");
    }
}

/// YN-55: a binary image, icon or font asset the source tools refuse is
/// checked at release by its content hash (merge_queue/binaries.rs), so the
/// reviewer judges everything else instead of answering unknown for it alone.
/// Every other unreadable path still makes the verdict unknown, and rounds
/// before coverage policy 3 keep their instructions.
#[test]
fn binary_assets_alone_leave_the_verdict_to_what_the_reviewer_read() {
    // The refusal the source tools return for such a file (source.rs text_of).
    let refusal = "\"Binary source cannot be inspected as text\"";
    for (round, evidence) in [
        ("full", r#"{"coveragePolicyVersion":3}"#),
        ("incremental", r#"{"coveragePolicyVersion":3,"incrementalOf":{"reviewId":"r1"}}"#),
        ("continuation", r#"{"coveragePolicyVersion":3,"continuationOf":{"reviewId":"r1"}}"#),
    ] {
        let prompt = reviewer::prompt(evidence);
        assert!(
            prompt.contains("Binary image, icon and font files are the one exception to every rule here that makes an unreadable path unknown"),
            "{round}: the exception is missing"
        );
        assert!(prompt.contains(refusal), "{round}: the exception names the source tools' refusal");
        assert!(prompt.contains("outside your verdict") && prompt.contains("by content hash and format when the PR is released"), "{round}");
        assert!(prompt.contains("name them in overall_explanation"), "{round}: the binaries are still listed");
        // Not read, not UTF-8, a failed read or a budget: still unknown.
        assert!(
            prompt.contains("Any other path you could not read keeps overall_correctness unknown: one you did not read, one refused as not UTF-8 text, a failed read or an exhausted budget."),
            "{round}: the other gaps stay unknown"
        );
        assert!(prompt.contains("If necessary source or budget is unavailable, return overall_correctness unknown"), "{round}");
    }
    for evidence in ["fixed evidence", r#"{"coveragePolicyVersion":2}"#] {
        assert!(!reviewer::prompt(evidence).contains("Binary image, icon and font files"), "{evidence}");
    }
}

#[test]
fn terminal_and_restart_notifications_are_atomic_deduplicated_and_system_authored() {
    let (dir, s, task) = setup();
    let agent: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"dev","name":"Dev","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    s.insert(&agent).unwrap();
    let (mut run, _) = s
        .create_pr_review(Some("dev"), &input(&task, "native"), "native")
        .unwrap();
    assert_eq!(run["notificationRecipient"]["id"], "dev");
    // Closure after acceptance must neither lose notification nor revive Dev.
    s.update("dev", "agent/closed", &json!({}), |d| {
        d.agent.closed_at = Some("later".into())
    })
    .unwrap();
    run["status"] = json!("cancelled");
    s.save_pr_review(&run, Some("partial")).unwrap();
    assert!(s.save_pr_review(&run, None).is_err());
    let mail = s
        .collaboration_call(None, "peer_read", json!({"agentId":"dev"}))
        .unwrap();
    assert_eq!(mail["messages"].as_array().unwrap().len(), 1);
    let m = &mail["messages"][0];
    assert_eq!(m["sender"]["kind"], "system");
    assert_eq!(m["sender"]["id"], "core");
    assert_eq!(m["priority"], "normal");
    assert_eq!(m["taskId"], task);
    // The mailbox notice names it as a code review, not a bare System notice.
    assert_eq!(m["notice"]["kind"], "review");
    assert_eq!(m["notice"]["status"], "cancelled");
    assert!(m["body"]
        .as_str()
        .unwrap()
        .contains("review_get(taskId=T-1, reviewId=native)"));
    assert_eq!(
        s.pr_review_report(&task, "native").unwrap()["notificationId"],
        m["id"]
    );
    assert!(s.agent("dev").unwrap().closed_at.is_some());
    let mut next = input(&task, "restart");
    next.notify_agent_id = Some("dev".into());
    s.create_pr_review(None, &next, "restart").unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.recover_pr_reviews().unwrap();
    s.recover_pr_reviews().unwrap();
    let mail = s
        .collaboration_call(None, "peer_read", json!({"agentId":"dev"}))
        .unwrap();
    assert_eq!(mail["messages"].as_array().unwrap().len(), 2);
    assert!(mail["messages"][1]["body"]
        .as_str()
        .unwrap()
        .contains("unknown"));
    assert_eq!(
        s.pr_review_report(&task, "restart").unwrap()["status"],
        "unknown"
    );
}

// Replay the same fixed GitHub endpoints used by production, without executing
// repository source or starting either paid reviewer.
#[test]
fn workspace_index_pages_filters_by_requester_and_keeps_tasks_apart() {
    let (_dir, s, first) = setup();
    let agent: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"dev","name":"Dev","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    s.insert(&agent).unwrap();
    let second = s
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"create-second","title":"Second PR"}),
        )
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let repo = Repository {
        id: 7,
        full_name: "owner/repo".into(),
    };
    s.github_link_object(
        &second,
        &repo,
        "pull",
        2,
        json!({"baseSha":"a".repeat(40),"headSha":"b".repeat(40)}),
    )
    .unwrap();
    // Two reviews run at once on different tasks; each row keeps its own task.
    let (mut parallel_a, _) = s
        .create_pr_review(Some("dev"), &input(&first, "parallel-a"), "parallel-a")
        .unwrap();
    let mut other = input(&second, "parallel-b");
    other.link_id = "7:pull:2".into();
    let (mut parallel_b, _) = s.create_pr_review(None, &other, "parallel-b").unwrap();
    let page = s.index_pr_reviews(None, None, None, None, None).unwrap();
    let rows = page["reviews"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], "parallel-b");
    assert_eq!(rows[0]["taskRef"], "T-2");
    assert_eq!(rows[0]["taskTitle"], "Second PR");
    assert_eq!(rows[0]["number"], 2);
    assert_eq!(rows[1]["id"], "parallel-a");
    assert_eq!(rows[1]["taskRef"], "T-1");
    assert_eq!(rows[1]["requestedBy"]["id"], "dev");
    // Summaries only: the report and findings are read from the task when opened.
    for row in rows {
        assert!(row.get("rawReport").is_none() && row.get("findings").is_none());
        assert!(row.get("source").is_none() && row.get("notificationRecipient").is_none());
    }

    // A failure before any model ran, a model run with findings, an unknown end.
    parallel_b["status"] = json!("failed");
    parallel_b["error"] = json!("Patch is incomplete");
    s.save_pr_review(&parallel_b, None).unwrap();
    parallel_a["status"] = json!("completed");
    parallel_a["conclusion"] = json!("changes_requested");
    parallel_a["baseSha"] = json!("a".repeat(40));
    parallel_a["headSha"] = json!("b".repeat(40));
    parallel_a["actualModel"] = json!(MODEL);
    parallel_a["findings"] = json!([{"title":"one"},{"title":"two"}]);
    s.save_pr_review(&parallel_a, Some("full report")).unwrap();
    let (mut unknown, _) = s
        .create_pr_review(None, &input(&first, "lost"), "lost")
        .unwrap();
    unknown["status"] = json!("unknown");
    unknown["error"] = json!("Review deadline exceeded; completion is unknown");
    s.save_pr_review(&unknown, None).unwrap();
    // The user asked for this one and only notified Dev: Dev did not request it.
    let mut notified = input(&first, "for-dev");
    notified.notify_agent_id = Some("dev".into());
    let (mut clean, _) = s.create_pr_review(None, &notified, "for-dev").unwrap();
    clean["status"] = json!("completed");
    clean["conclusion"] = json!("no_findings");
    clean["baseSha"] = json!("a".repeat(40));
    clean["headSha"] = json!("b".repeat(40));
    s.save_pr_review(&clean, Some("clean")).unwrap();

    let page = s.index_pr_reviews(None, None, None, None, None).unwrap();
    let by_id = |id: &str| {
        page["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(by_id("parallel-b")["status"], "failed");
    assert_eq!(by_id("parallel-b")["actualModel"], Value::Null);
    assert_eq!(by_id("parallel-b")["outdated"], Value::Null);
    assert_eq!(by_id("parallel-a")["conclusion"], "changes_requested");
    assert_eq!(by_id("parallel-a")["findingsCount"], 2);
    assert_eq!(by_id("parallel-a")["outdated"], false);
    assert_eq!(by_id("lost")["status"], "unknown");
    assert_eq!(by_id("lost")["conclusion"], "unknown");
    assert_eq!(by_id("for-dev")["conclusion"], "no_findings");
    assert_eq!(by_id("for-dev")["requestedBy"]["kind"], "user");

    let mine = s.index_pr_reviews(Some("dev"), None, None, None, None).unwrap();
    let ids: Vec<_> = mine["reviews"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(ids, vec![json!("parallel-a")]);
    let task = s.index_pr_reviews(None, None, Some("T-2"), None, None).unwrap();
    let ids: Vec<_> = task["reviews"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(ids, vec![json!("parallel-b")]);
    assert!(s.index_pr_reviews(None, None, Some("T-99"), None, None).is_err());
    // A deep link reads its one review directly, however old, never by paging.
    let one = s
        .index_pr_reviews(None, None, Some("T-1"), Some("parallel-a"), None)
        .unwrap();
    assert_eq!(one["reviews"].as_array().unwrap().len(), 1);
    assert_eq!(one["reviews"][0]["findingsCount"], 2);
    assert_eq!(one["hasMore"], false);
    assert_eq!(
        s.index_pr_reviews(None, None, Some("T-2"), Some("parallel-a"), None)
            .unwrap()["reviews"],
        json!([])
    );
    assert_eq!(
        s.pr_review_report(&first, "parallel-a").unwrap()["cursor"],
        one["reviews"][0]["cursor"]
    );
    assert_eq!(
        s.index_pr_reviews(Some("nobody"), None, None, None, None)
            .unwrap()["reviews"],
        json!([])
    );

    // Older records without a requester stay in the Workspace list only.
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE pr_reviews SET data=json_remove(data,'$.requestedBy') WHERE id='parallel-a'",
            [],
        )
        .unwrap();
    assert_eq!(
        s.index_pr_reviews(Some("dev"), None, None, None, None).unwrap()["reviews"],
        json!([])
    );
    let page = s.index_pr_reviews(None, None, None, None, None).unwrap();
    let legacy = page["reviews"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "parallel-a")
        .unwrap();
    assert_eq!(legacy["requestedBy"], Value::Null);

    // A new base or head on the linked PR makes earlier rounds outdated.
    s.github_refresh_object(
        "7:pull:1",
        Ok((
            repo.clone(),
            json!({"baseSha":"a".repeat(40),"headSha":"c".repeat(40)}),
        )),
    )
    .unwrap();
    let page = s.index_pr_reviews(None, None, None, None, None).unwrap();
    let outdated = |id: &str| {
        page["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap()["outdated"]
            .clone()
    };
    assert_eq!(outdated("parallel-a"), true);
    assert_eq!(outdated("for-dev"), true);
    assert_eq!(outdated("parallel-b"), Value::Null);
    s.github_refresh_object(
        "7:pull:1",
        Ok((
            repo.clone(),
            json!({"baseSha":"d".repeat(40),"headSha":"b".repeat(40)}),
        )),
    )
    .unwrap();
    let page = s.index_pr_reviews(None, None, None, None, None).unwrap();
    assert_eq!(
        page["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "for-dev")
            .unwrap()["outdated"],
        true
    );
}

#[test]
fn workspace_index_pages_twenty_at_a_time_without_repeats() {
    let (_dir, s, task) = setup();
    for i in 0..45 {
        let key = format!("round-{i}");
        let (mut run, _) = s.create_pr_review(None, &input(&task, &key), &key).unwrap();
        run["status"] = json!("cancelled");
        s.save_pr_review(&run, None).unwrap();
    }
    let mut seen = Vec::new();
    let mut before = None;
    for expected in [20, 20, 5] {
        let page = s.index_pr_reviews(None, None, None, None, before).unwrap();
        let rows = page["reviews"].as_array().unwrap();
        assert_eq!(rows.len(), expected);
        assert_eq!(page["hasMore"], expected == 20);
        seen.extend(rows.iter().map(|r| r["id"].as_str().unwrap().to_owned()));
        before = page["nextBefore"].as_i64();
    }
    assert_eq!(seen.len(), 45);
    assert_eq!(seen[0], "round-44");
    assert_eq!(seen[44], "round-0");
    seen.dedup();
    assert_eq!(seen.len(), 45);
    let empty = s.index_pr_reviews(None, None, None, None, Some(1)).unwrap();
    assert_eq!(empty["reviews"], json!([]));
    assert_eq!(empty["hasMore"], false);
    assert_eq!(empty["nextBefore"], Value::Null);
}

/// T-131: a base or head that cannot be the PR's is refused before a round
/// exists, so it never counts as a round or reaches a reviewer; a corrected
/// retry with the same requestId is a new request, not a conflict.
#[tokio::test]
async fn a_malformed_fixed_sha_starts_no_round() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let task = ws.store.collaboration_call(None, "task_create", json!({"requestId":"create","title":"Deliver PR"})).unwrap()["task"]["id"]
        .as_str().unwrap().to_owned();
    ws.store.github_link_object(&task, &Repository { id: 7, full_name: "owner/repo".into() }, "pull", 1,
        json!({"baseSha":"a".repeat(40),"headSha":"b".repeat(40)})).unwrap();
    let start = |base: &str, head: &str| json!({"requestId":"r1","taskId":task,"linkId":"7:pull:1","baseSha":base,"headSha":head});
    for (base, head, says) in [
        ("aaa".to_owned(), "b".repeat(40), "baseSha must be a full commit SHA, 40 hexadecimal characters"),
        ("a".repeat(40), "b".repeat(64), "headSha must be a full commit SHA, 40 hexadecimal characters"),
        ("a".repeat(40), "main".to_owned(), "not all hexadecimal"),
        ("A".repeat(40), "b".repeat(40), "baseSha must be lowercase"),
    ] {
        let error = ws.collaboration_call(None, "review_start", start(&base, &head)).await.unwrap_err().to_string();
        assert!(error.contains(says) && error.ends_with("No review was started."), "{error}");
        assert_eq!(ws.store.list_pr_reviews(&task, None).unwrap()["reviews"], json!([]));
        let receipts: i64 = ws.store.db.read().unwrap()
            .query_row("SELECT COUNT(*) FROM collaboration_requests WHERE operation='review_start'", [], |r| r.get(0)).unwrap();
        assert_eq!(receipts, 0, "nothing is recorded for a retry to find");
    }
    // Full lowercase SHAs pass the check unchanged; the PR comparison and
    // the round follow as before (store tests above).
    for (base, head) in [(None, None), (Some("a".repeat(40)), Some("b".repeat(40)))] {
        let input: Start = serde_json::from_value(json!({"requestId":"r","taskId":task,"linkId":"7:pull:1","baseSha":base,"headSha":head})).unwrap();
        assert_eq!(fixed_sha_problem(input.base_sha.as_deref(), input.head_sha.as_deref(), true), None);
    }
}

#[test]
fn nonblocking_suggestions_preserve_findings_and_never_override_uncertainty() {
    let mut report = valid_report();
    let mut finding = valid_finding();
    finding["priority"] = json!(3);
    report["findings"] = json!([finding]);
    let mut run = report_run();
    reviewer::complete_report(&report, &mut run);
    assert_eq!(run["conclusion"], "approved_with_notes");
    assert_eq!(run["findings"][0]["body"], "Reason");
    assert_eq!(run["findings"][0]["priority"], 3);
    assert_eq!(run["policyVersion"], 3);
    assert!(policy::passes(&run));
    // A stored policy-2 approval is read as it was written.
    let mut stored = run.clone();
    stored["policyVersion"] = json!(2);
    assert!(policy::passes(&stored));
    for (correctness, incomplete, priority, conclusion, reason) in [
        ("patch is correct", true, 3, "unknown", "coverage_incomplete"),
        ("unknown", false, 3, "unknown", "model_unknown"),
        ("patch is correct", false, 2, "unknown", "verdict_conflict"),
        ("patch is incorrect", false, 3, "changes_requested", ""),
    ] {
        let mut run = report_run();
        run["contextIncomplete"] = json!(incomplete);
        report["overall_correctness"] = json!(correctness);
        report["findings"][0]["priority"] = json!(priority);
        reviewer::complete_report(&report, &mut run);
        assert_eq!(run["conclusion"], conclusion);
        assert!(!policy::passes(&run));
        if !reason.is_empty() {
            assert!(run["reasonCodes"].as_array().unwrap().contains(&json!(reason)));
        }
    }
    // An unknown older report with the same findings is never reclassified.
    let mut old = run.clone();
    old["policyVersion"] = json!(1);
    assert!(!policy::passes(&old));
    old["conclusion"] = json!("unknown");
    assert!(!policy::passes(&old));
    for status in ["running", "unknown", "failed", "cancelled"] {
        let mut interrupted = run.clone();
        interrupted["status"] = json!(status);
        assert!(!policy::passes(&interrupted));
    }
}

#[test]
fn review_reason_codes_separate_coverage_unsupported_and_invalid_report() {
    let mut run = report_run();
    run["contextIncomplete"] = json!(true);
    run["coverage"] = json!({"failedRequests":[{"resolved":false,"kind":"unsupported_source"}]});
    reviewer::complete_report(&valid_report(), &mut run);
    assert_eq!(run["reasonCodes"], json!(["coverage_incomplete", "unsupported_source"]));
    let mut invalid = report_run();
    reviewer::complete_report(&json!({"findings":[]}), &mut invalid);
    assert_eq!(invalid["status"], "unknown");
    assert_eq!(invalid["reasonCodes"], json!(["invalid_report"]));
    assert!(!policy::passes(&invalid));
    policy::execution_reason(&mut invalid, "execution_unconfirmed");
    assert_eq!(invalid["reasonCodes"], json!(["invalid_report", "execution_unconfirmed"]));
}

#[test]
fn old_terminal_reports_keep_their_policy_and_raw_output_after_restart() {
    let (dir, store, task) = setup();
    let (mut old, _) = store.create_pr_review(None, &input(&task, "old-policy"), "old").unwrap();
    old.as_object_mut().unwrap().remove("policyVersion");
    old.as_object_mut().unwrap().remove("reasonCodes");
    old["status"] = json!("completed");
    old["conclusion"] = json!("unknown");
    old["findings"] = json!([{"priority":3,"body":"Old note"}]);
    store.save_pr_review(&old, Some("original legacy report")).unwrap();
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    store.recover_pr_reviews().unwrap();
    let retained = store.pr_review_report(&task, "old").unwrap();
    assert_eq!(retained["conclusion"], "unknown");
    assert!(retained.get("policyVersion").is_none());
    assert_eq!(retained["rawReport"], "original legacy report");
    let (new, _) = store.create_pr_review(None, &input(&task, "new-policy"), "new").unwrap();
    assert_eq!(new["policyVersion"], policy::VERSION);
    assert_eq!(new["coveragePolicyVersion"], 3);
    store.recover_pr_reviews().unwrap();
    assert_eq!(store.pr_review_report(&task, "new").unwrap()["reasonCodes"], json!(["execution_unconfirmed"]));
}

/// A completed native round of base a… / head b… whose scope recorded the
/// given paths (state, reason) with frozen blobs.
fn completed_round(store: &Store, task: &str, key: &str, head: &str, paths: &[(&str, &str, Option<&str>)]) -> Value {
    completed_round_as(store, task, key, head, paths, |_| {})
}
fn completed_round_as(store: &Store, task: &str, key: &str, head: &str, paths: &[(&str, &str, Option<&str>)], edit: impl FnOnce(&mut Value)) -> Value {
    let (mut run, created) = store.create_pr_review(None, &input(task, key), key).unwrap();
    assert!(created);
    let base = "a".repeat(40);
    run["status"] = json!("completed");
    run["actualHarness"] = json!("claude");
    run["baseSha"] = json!(base);
    run["headSha"] = json!(head);
    run["mergeBaseSha"] = json!("c".repeat(40));
    let paths: Vec<_> = paths
        .iter()
        .map(|(path, state, reason)| json!({"path":path,"status":"added","head":{"blobSha":format!("{:0>40}", path.len()),"mode":"100644"},
            "state":state,"reason":reason,"facts":[{"kind":"unsupported","side":"head","reason":reason,"contentSha256":"e".repeat(64)}]}))
        .collect();
    run["scope"] = json!({"version":1,"baseSha":base,"headSha":head,"mergeBaseSha":"c".repeat(40),"coveragePolicyVersion":3,
        "policy":{"state":"absent"},"paths":paths});
    edit(&mut run);
    store.save_pr_review(&run, Some("report")).unwrap();
    run
}

#[test]
fn a_round_is_refused_before_it_exists_when_this_candidate_already_showed_paths_no_round_can_cover() {
    let (_dir, store, task) = setup();
    let head = "b".repeat(40);
    let first = completed_round(&store, &task, "r1", &head, &[("helper/tool.exe", "unsupported", Some("binary")), ("src/a.rs", "covered", None)]);
    let refused = store.create_pr_review(None, &input(&task, "r2"), "r2").unwrap_err().to_string();
    assert!(refused.contains("Round 1") && refused.contains("helper/tool.exe (unsupported, binary)") && refused.contains("acknowledgeUnreviewable"), "{refused}");
    assert!(!refused.contains("src/a.rs"));
    // Nothing was created or counted: the next accepted round is round 2.
    assert_eq!(store.list_pr_reviews(&task, None).unwrap()["reviews"].as_array().unwrap().len(), 1);
    // A retry of the first request still answers with the first round.
    let (again, created) = store.create_pr_review(None, &input(&task, "r1"), "ignored").unwrap();
    assert!(!created);
    assert_eq!(again["id"], first["id"]);
    // Explicit acknowledgement reviews the rest, and is recorded as such.
    let mut acknowledged = input(&task, "r3");
    acknowledged.acknowledge_unreviewable = Some(true);
    let (third, created) = store.create_pr_review(None, &acknowledged, "r3").unwrap();
    assert!(created);
    assert_eq!((third["round"].as_i64(), &third["acknowledgedUnreviewable"]), (Some(2), &json!(true)));
}

#[test]
fn the_repeat_guard_reads_only_explicit_scope_records_of_the_same_candidate() {
    for (case, edit) in [
        ("another head", (|r: &mut Value| r["headSha"] = json!("d".repeat(40))) as fn(&mut Value)),
        ("an older coverage policy", |r| r["coveragePolicyVersion"] = json!(2)),
        ("no recorded scope", |r| { r.as_object_mut().unwrap().remove("scope"); }),
        ("no native run", |r| r["actualHarness"] = Value::Null),
        ("nothing permanent", |r| r["scope"]["paths"][0]["state"] = json!("not_read")),
    ] {
        let (_dir, store, task) = setup();
        completed_round_as(&store, &task, "r1", &"b".repeat(40), &[("helper/tool.exe", "unsupported", Some("binary"))], edit);
        assert!(store.create_pr_review(None, &input(&task, "r2"), "r2").is_ok(), "{case}");
    }
    // Excluded and too-large paths can't be covered by another round either.
    for (state, reason) in [("excluded", None), ("budget_exhausted", Some("diff_exceeds_context"))] {
        let (_dir, store, task) = setup();
        completed_round(&store, &task, "r1", &"b".repeat(40), &[("data/big.txt", state, reason)]);
        assert!(store.create_pr_review(None, &input(&task, "r2"), "r2").is_err(), "{state}");
    }
}

#[test]
fn evidence_is_bound_to_one_candidate_and_never_changes_a_review() {
    let (_dir, store, task) = setup();
    let first = completed_round(&store, &task, "r1", &"b".repeat(40), &[("helper/tool.exe", "unsupported", Some("binary"))]);
    let add = |key: &str, extra: Value| {
        let mut body = json!({"requestId":key,"taskId":task,"reviewId":first["id"],"path":"helper/tool.exe","kind":"build_provenance",
            "reference":{"url":"https://github.com/owner/repo/actions/runs/1"},"note":"Built from helper/src by the release job"});
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        store.add_review_evidence(None, body)
    };
    let recorded = add("e1", json!({})).unwrap();
    assert_eq!(recorded["candidate"]["headSha"], "b".repeat(40));
    assert_eq!(recorded["candidate"]["head"]["blobSha"], first["scope"]["paths"][0]["head"]["blobSha"]);
    assert_eq!(add("e1", json!({})).unwrap()["id"], recorded["id"], "a retry is the same record");
    assert!(add("e1", json!({"note":"changed"})).is_err(), "a reused requestId with other content");
    let hashed = add("e2", json!({"kind":"artifact_hash","artifactSha256":"e".repeat(64),"reference":{"ciRunKey":"github:7:123:1"}})).unwrap();
    assert_eq!(hashed["artifactMatchesHeadContent"], true);
    let other = add("e3", json!({"kind":"artifact_hash","artifactSha256":"f".repeat(64),"reference":{"reviewId":first["id"]}})).unwrap();
    assert_eq!(other["artifactMatchesHeadContent"], false, "a changed artifact hash doesn't match what was reviewed");
    for (key, extra) in [
        ("bad-url", json!({"reference":{"url":"http://example.com/x"}})),
        ("credentials", json!({"reference":{"url":"https://user:pass@example.com/x"}})),
        ("two-refs", json!({"reference":{"url":"https://example.com/x","ciRunKey":"github:7:1:1"}})),
        ("other-repo-ci", json!({"reference":{"ciRunKey":"github:8:123:1"}})),
        ("malformed-ci", json!({"reference":{"ciRunKey":"39297617576"}})),
        ("unknown-job", json!({"reference":{"jobId":"00000000-0000-0000-0000-000000000000"}})),
        ("unknown-review", json!({"reference":{"reviewId":"nope"}})),
        ("outside-path", json!({"path":"src/not-changed.rs"})),
        ("hash-missing", json!({"kind":"artifact_hash"})),
        ("hash-format", json!({"artifactSha256":"E".repeat(64)})),
        ("kind", json!({"kind":"approval"})),
        ("previous", json!({"previousEvidenceId":"nope"})),
    ] {
        assert!(add(key, extra).is_err(), "{key}");
    }
    // Shown with its review as bound to this candidate; the review is unchanged.
    let report = store.pr_review_report(&task, first["id"].as_str().unwrap()).unwrap();
    assert_eq!(report["evidence"].as_array().unwrap().len(), 3);
    assert!(report["evidence"].as_array().unwrap().iter().all(|e| e["binding"] == "this_candidate"));
    assert_eq!((&report["conclusion"], &report["reasonCodes"], &report["scope"]), (&first["conclusion"], &first["reasonCodes"], &first["scope"]));
    // A new head is another candidate: the same evidence doesn't apply to it,
    // even for a path with the same blob, until it is added again explicitly.
    let mut ack = input(&task, "r2");
    ack.acknowledge_unreviewable = Some(true);
    let (mut second, _) = store.create_pr_review(None, &ack, "r2").unwrap();
    let mut scope = first["scope"].clone();
    scope["headSha"] = json!("d".repeat(40));
    second["status"] = json!("completed");
    second["baseSha"] = first["baseSha"].clone();
    second["headSha"] = json!("d".repeat(40));
    second["mergeBaseSha"] = first["mergeBaseSha"].clone();
    second["scope"] = scope;
    store.save_pr_review(&second, Some("report")).unwrap();
    let later = store.pr_review_report(&task, "r2").unwrap();
    assert!(later["evidence"].as_array().unwrap().iter().all(|e| e["binding"] == "other_candidate"));
    let moved = store
        .add_review_evidence(None, json!({"requestId":"e4","taskId":task,"reviewId":"r2","path":"helper/tool.exe","kind":"build_provenance",
            "reference":{"url":"https://github.com/owner/repo/actions/runs/1"},"previousEvidenceId":recorded["id"]}))
        .unwrap();
    assert_eq!(moved["reassociatedFrom"], recorded["id"]);
    let later = store.pr_review_report(&task, "r2").unwrap();
    assert_eq!(later["evidence"].as_array().unwrap().iter().filter(|e| e["binding"] == "this_candidate").count(), 1);
    assert_eq!(store.pr_review_report(&task, first["id"].as_str().unwrap()).unwrap()["evidence"].as_array().unwrap().len(), 4, "the old record stays");
}

/// A new review takes the reviewer of its task's project (T-190), fixed in
/// it when it is created: a later change, a retried request and the task's
/// list keep each review as it started.
#[test]
fn a_review_takes_its_tasks_projects_reviewer_when_created_and_keeps_it() {
    let (_dir, s, task) = setup();
    let internal = crate::collaboration_store::task_key(&s.db.read().unwrap(), &task).unwrap().0;
    let end = |run: &Value| {
        let mut run = run.clone();
        run["status"] = json!("cancelled");
        s.save_pr_review(&run, None).unwrap();
    };
    let reviewer = |run: &Value| (run["requestedHarness"].clone(), run["requestedModel"].clone());
    s.save_review_settings(&settings::Settings { harness: "claude".into(), model: "workspace-choice".into() }).unwrap();
    let (outside, _) = s.create_pr_review(None, &input(&task, "outside"), "outside").unwrap();
    assert_eq!(reviewer(&outside), (json!("claude"), json!("workspace-choice")), "no project: the Workspace's");
    end(&outside);
    let project = s.create_project("Reviewed", Default::default()).unwrap().id;
    crate::projects::set_task_project(&s.db.write().unwrap(), &internal, Some(&project)).unwrap();
    s.save_project_review_settings(&project, &settings::Settings { harness: "claude".into(), model: "project-choice".into() }).unwrap();
    assert_eq!(s.list_pr_reviews(&task, None).unwrap()["settings"], json!({"harness":"claude","model":"project-choice","source":"project"}));
    let (inside, _) = s.create_pr_review(None, &input(&task, "inside"), "inside").unwrap();
    assert_eq!(reviewer(&inside), (json!("claude"), json!("project-choice")));
    // The project's reviewer changes: the started review, and a retry of its request, keep theirs.
    s.save_project_review_settings(&project, &settings::Settings { harness: "codex".into(), model: MODEL.into() }).unwrap();
    let (retry, created) = s.create_pr_review(None, &input(&task, "inside"), "not-started").unwrap();
    assert!(!created);
    assert_eq!((retry["id"].clone(), reviewer(&retry)), (json!("inside"), (json!("claude"), json!("project-choice"))));
    let listed = s.list_pr_reviews(&task, None).unwrap();
    let stored = listed["reviews"].as_array().unwrap().iter().find(|r| r["id"] == "inside").unwrap().clone();
    assert_eq!(reviewer(&stored), (json!("claude"), json!("project-choice")));
    end(&inside);
    let (next, _) = s.create_pr_review(None, &input(&task, "next"), "next").unwrap();
    assert_eq!(reviewer(&next), (json!("codex"), json!(MODEL)), "a new review takes the change");
    end(&next);
    // Cleared: the task inherits the Workspace's again.
    s.clear_project_review_settings(&project).unwrap();
    let (again, _) = s.create_pr_review(None, &input(&task, "again"), "again").unwrap();
    assert_eq!(reviewer(&again), (json!("claude"), json!("workspace-choice")));
}

// A conversation's work dock lists its Agent's own reviews (T-25): those it
// requested, those sent to it, and those on a task assigned to it; never
// another Agent's. The Jobs list's requester scope is unchanged.
#[test]
fn an_agents_dock_lists_reviews_it_asked_for_was_sent_or_has_on_its_tasks() {
    let (_dir, s, first) = setup();
    for (id, name) in [("dev", "Dev"), ("lead", "Lead"), ("other", "Other")] {
        let agent: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":name,"cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        s.insert(&agent).unwrap();
    }
    let repo = Repository {
        id: 7,
        full_name: "owner/repo".into(),
    };
    // Each review on a PR of its own: one task unassigned, one Dev's, one Other's.
    let task = |key: &str, title: &str, assignee: Option<&str>, number: u64| {
        let mut create = json!({"requestId":key,"title":title});
        if let Some(id) = assignee {
            create["assigneeAgentId"] = json!(id);
        }
        let id = s.collaboration_call(None, "task_create", create).unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        s.github_link_object(&id, &repo, "pull", number,
            json!({"baseSha":"a".repeat(40),"headSha":"b".repeat(40)}))
            .unwrap();
        id
    };
    let devs = task("create-dev", "Dev's PR", Some("dev"), 2);
    let others = task("create-other", "Other's PR", Some("other"), 3);
    let unassigned = task("create-free", "Nobody's PR", None, 4);
    let on = |task: &str, number: u64, key: &str| {
        let mut start = input(task, key);
        start.link_id = format!("7:pull:{number}");
        start
    };
    // The Lead asks for a review of its own (on the setup task) and one of Dev's PR.
    s.create_pr_review(Some("lead"), &input(&first, "asked"), "asked").unwrap();
    s.create_pr_review(Some("lead"), &on(&devs, 2, "on-devs-task"), "on-devs-task").unwrap();
    // The user asks for one and sends it to Dev; Other asks for one on its own PR.
    let mut sent = on(&unassigned, 4, "sent-to-dev");
    sent.notify_agent_id = Some("dev".into());
    s.create_pr_review(None, &sent, "sent-to-dev").unwrap();
    s.create_pr_review(Some("other"), &on(&others, 3, "elsewhere"), "elsewhere").unwrap();

    let ids = |agent: Option<&str>, involving: Option<&str>| {
        s.index_pr_reviews(agent, involving, None, None, None).unwrap()["reviews"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(None, Some("dev")), ["sent-to-dev", "on-devs-task"]);
    assert_eq!(ids(None, Some("lead")), ["on-devs-task", "asked"]);
    assert_eq!(ids(None, Some("other")), ["elsewhere"]);
    assert!(ids(None, Some("nobody")).is_empty());
    // The requester scope still names only what an Agent itself asked for.
    assert!(ids(Some("dev"), None).is_empty());
    assert_eq!(ids(Some("lead"), None), ["on-devs-task", "asked"]);
    // Rows are the same summaries as the Jobs list's.
    let row = &s.index_pr_reviews(None, Some("dev"), None, None, None).unwrap()["reviews"][1];
    assert_eq!(row["taskRef"], "T-2");
    assert_eq!(row["number"], 2);
    assert_eq!(row["requestedBy"]["id"], "lead");
    assert!(row.get("findings").is_none() && row.get("notificationRecipient").is_none());
}

/// A synthetic Agent for round-limit tests.
fn agent(s: &Store, id: &str, name: &str) {
    let detail: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":name,"cwd":"/workspace","model":"test",
        "color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    s.insert(&detail).unwrap();
}

/// The setup task's PR link, for a second task that names the same PR.
fn link_same_pr(s: &Store, task: &str) {
    s.github_link_object(
        task,
        &Repository { id: 7, full_name: "owner/repo".into() },
        "pull",
        1,
        json!({"baseSha":"a".repeat(40),"headSha":"b".repeat(40)}),
    )
    .unwrap();
}

/// A task in a project, dispatched by Lead to Dev, with PR #1 linked.
fn dispatched_task() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let project = s.create_project("Review limit", Default::default()).unwrap();
    s.github_link_repo(&project.id, &Repository { id: 7, full_name: "owner/repo".into() }).unwrap();
    for (id, name) in [("lead", "Lead"), ("lead2", "Lead 2"), ("dev", "Dev")] {
        agent(&s, id, name);
    }
    s.set_agent_project("lead", Some(&project.id)).unwrap();
    s.set_agent_project("lead2", Some(&project.id)).unwrap();
    crate::agent_roles::save(&s, &project.id, 0, vec!["lead".into(), "lead2".into()]).unwrap();
    let task = s
        .collaboration_call(None, "task_create", json!({"requestId":"dispatch-task","title":"Review rounds","projectId":project.id,"assigneeAgentId":"dev"}))
        .unwrap()["task"]
        .clone();
    let id = task["id"].as_str().unwrap().to_owned();
    s.collaboration_call(Some("lead"), "task_dispatch", json!({"requestId":"dispatch","taskId":id,"expectedVersion":task["version"],"toAgentId":"dev"}))
        .unwrap();
    link_same_pr(&s, &id);
    (dir, s, id)
}

/// A full round that completed, which always counts.
fn completed_full_round(s: &Store, task: &str, key: &str) -> Value {
    let (mut run, _) = s.create_pr_review(None, &input(task, key), key).unwrap();
    run["status"] = json!("completed");
    run["conclusion"] = json!("no_findings");
    s.save_pr_review(&run, None).unwrap();
    run
}

/// A failed round whose record shows it reached no verdict, or one that
/// never started: as round_limit.rs reads them (`read_source` false means it
/// read only the change manifest).
fn failed_round(s: &Store, task: &str, key: &str, native: bool, read_source: bool) -> Value {
    let (mut run, _) = s.create_pr_review(None, &input(task, key), key).unwrap();
    run["status"] = json!("failed");
    run["reasonCodes"] = json!(["execution_failed"]);
    run["conclusion"] = json!("unknown");
    if native {
        run["nativeStartedAt"] = json!("2026-11-09T00:25:15Z");
        run["contextReads"] = if read_source {
            json!([{"number":1,"tool":"review_changes"},{"number":2,"tool":"source_read"}])
        } else {
            json!([{"number":1,"tool":"review_changes"}])
        };
    }
    s.save_pr_review(&run, None).unwrap();
    run
}

fn table_counts(s: &Store) -> (i64, i64, i64) {
    let db = s.db.read().unwrap();
    let one = |sql: &str| db.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    (
        one("SELECT COUNT(*) FROM pr_reviews"),
        one("SELECT COUNT(*) FROM collaboration_requests WHERE operation='review_start'"),
        one("SELECT COUNT(*) FROM collaboration_task_activity"),
    )
}

#[test]
fn a_full_round_counts_toward_the_prs_two_started_rounds_across_tasks() {
    let (_dir, s, task) = setup();
    agent(&s, "dev", "Dev");
    completed_full_round(&s, &task, "r1");
    completed_full_round(&s, &task, "r2");
    let before = table_counts(&s);
    let refused = s.create_pr_review(Some("dev"), &input(&task, "r3"), "r3").unwrap_err().to_string();
    assert!(refused.starts_with("round_limit:"), "{refused}");
    assert!(refused.contains("a full round would be one more than the 2 it may use"), "{refused}");
    assert!(refused.contains("active dispatcher (beyondRoundLimit: true) or the user can start one more"), "{refused}");
    assert!(refused.ends_with("No review was started."), "{refused}");
    assert_eq!(table_counts(&s), before, "a refused round writes no record, receipt or activity");
    // Idempotency comes first: an accepted request still returns its round.
    let (again, created) = s.create_pr_review(None, &input(&task, "r2"), "ignored").unwrap();
    assert!(!created);
    assert_eq!(again["id"], "r2");
    // The count is per PR across tasks, wherever the earlier rounds were made.
    let other = s
        .collaboration_call(None, "task_create", json!({"requestId":"same-pr","title":"Same PR"}))
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    link_same_pr(&s, &other);
    let refused = s.create_pr_review(Some("dev"), &input(&other, "r4"), "r4").unwrap_err().to_string();
    assert!(refused.contains("already has 2 review rounds"), "{refused}");
}

#[test]
fn only_a_round_that_reached_no_verdict_leaves_the_full_round_limit() {
    let (_dir, s, task) = setup();
    agent(&s, "dev", "Dev");
    // Never started twice, plus one harness failure after reading only the
    // manifest: none counts, and the note names the one without a report.
    failed_round(&s, &task, "early1", false, false);
    failed_round(&s, &task, "early2", false, false);
    failed_round(&s, &task, "manifest", true, false);
    completed_full_round(&s, &task, "r4");
    completed_full_round(&s, &task, "r5");
    let refused = s.create_pr_review(Some("dev"), &input(&task, "r6"), "r6").unwrap_err().to_string();
    assert!(refused.starts_with("round_limit:"), "{refused}");
    assert!(refused.contains("1 more ended without a report and doesn't count"), "{refused}");
    // A source-reading harness failure is free only for the PR's first one.
    let (_dir, s, task) = setup();
    agent(&s, "dev", "Dev");
    completed_full_round(&s, &task, "done");
    failed_round(&s, &task, "read1", true, true);
    let stamp = s.pr_review_report(&task, "read1").unwrap()["roundLimit"].clone();
    assert_eq!(stamp["counts"], false, "{stamp}");
    failed_round(&s, &task, "read2", true, true);
    assert_eq!(s.pr_review_report(&task, "read2").unwrap()["roundLimit"]["counts"], true);
    let refused = s.create_pr_review(Some("dev"), &input(&task, "next"), "next").unwrap_err().to_string();
    assert!(refused.contains("already has 2 review rounds"), "{refused}");
    // A restart turns an unfinished round unknown, which counts.
    let (dir, s, task) = setup();
    agent(&s, "dev", "Dev");
    completed_full_round(&s, &task, "done2");
    let (mut running, _) = s.create_pr_review(None, &input(&task, "interrupted"), "interrupted").unwrap();
    running["status"] = json!("running");
    s.save_pr_review(&running, None).unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.recover_pr_reviews().unwrap();
    assert_eq!(s.pr_review_report(&task, "interrupted").unwrap()["status"], "unknown");
    let refused = s.create_pr_review(Some("dev"), &input(&task, "again"), "again").unwrap_err().to_string();
    assert!(refused.contains("already has 2 review rounds"), "{refused}");
}

#[test]
fn only_the_active_dispatcher_or_the_user_can_start_a_round_beyond_the_limit() {
    let (_dir, s, task) = dispatched_task();
    completed_full_round(&s, &task, "r1");
    completed_full_round(&s, &task, "r2");
    // The dispatcher must say so explicitly.
    let refused = s.create_pr_review(Some("lead"), &input(&task, "r3"), "r3").unwrap_err().to_string();
    assert!(refused.starts_with("round_limit:"), "{refused}");
    // An inactive dispatcher's flag is refused too.
    let version = s
        .collaboration_call(Some("lead"), "task_get", json!({"taskId":task}))
        .unwrap()["task"]["version"]
        .clone();
    s.collaboration_call(Some("lead2"), "task_dispatch", json!({"requestId":"dispatch-2","taskId":task,"expectedVersion":version,"toAgentId":"dev"}))
        .unwrap();
    let mut by_old = input(&task, "old-dispatch");
    by_old.beyond_round_limit = Some(true);
    let refused = s.create_pr_review(Some("lead"), &by_old, "old-dispatch").unwrap_err().to_string();
    assert!(refused.contains("beyondRoundLimit is only for the agent that dispatched this task's active dispatch"), "{refused}");
}

#[test]
fn beyond_the_limit_records_who_started_it_and_the_user_stays_unlimited() {
    let (_dir, s, task) = dispatched_task();
    completed_full_round(&s, &task, "r1");
    completed_full_round(&s, &task, "r2");
    let mut asked = input(&task, "r3");
    asked.beyond_round_limit = Some(true);
    let (run, created) = s.create_pr_review(Some("lead"), &asked, "r3").unwrap();
    assert!(created);
    assert_eq!(run["beyondRoundLimit"]["startedBefore"], 2);
    assert_eq!(run["beyondRoundLimit"]["by"]["id"], "lead");
    assert_eq!(run["beyondRoundLimit"]["by"]["kind"], "agent");
    let mut done = run.clone();
    done["status"] = json!("completed");
    done["conclusion"] = json!("no_findings");
    s.save_pr_review(&done, None).unwrap();
    let page = s
        .collaboration_call(None, "task_get", json!({"taskId":task,"view":"activity","limit":200}))
        .unwrap();
    assert!(
        page["activities"].as_array().unwrap().iter().filter_map(|a| a["body"].as_str())
            .any(|b| b.contains("It is beyond this PR's 2 started rounds, started by Lead.")),
        "{page}"
    );
    // The user's own round over the limit opens and is marked as the user's.
    let (user, created) = s.create_pr_review(None, &input(&task, "user-over"), "user-over").unwrap();
    assert!(created);
    assert_eq!(user["beyondRoundLimit"]["startedBefore"], 3);
    assert_eq!(user["beyondRoundLimit"]["by"]["kind"], "user");
    let mut done = user.clone();
    done["status"] = json!("completed");
    done["conclusion"] = json!("no_findings");
    s.save_pr_review(&done, None).unwrap();
    // The flag never applies to an incremental round.
    let mut incremental = input(&task, "incremental-flag");
    incremental.previous_review_id = Some("r1".into());
    incremental.beyond_round_limit = Some(true);
    let refused = s.create_pr_review(Some("lead"), &incremental, "incremental-flag").unwrap_err().to_string();
    assert!(refused.contains("beyondRoundLimit applies only to a full round"), "{refused}");
}

#[test]
fn an_invalid_beyond_flag_is_refused_before_the_limit_too() {
    let (_dir, s, task) = dispatched_task();
    // The executor isn't the dispatcher, with no round used yet.
    let mut by_executor = input(&task, "executor-flag");
    by_executor.beyond_round_limit = Some(true);
    let refused = s.create_pr_review(Some("dev"), &by_executor, "executor-flag").unwrap_err().to_string();
    assert!(refused.contains("beyondRoundLimit is only for the agent that dispatched this task's active dispatch"), "{refused}");
    // A stale dispatch's requester is refused after the task is reassigned.
    let version = s
        .collaboration_call(Some("lead"), "task_get", json!({"taskId":task}))
        .unwrap()["task"]["version"]
        .clone();
    s.collaboration_call(Some("lead2"), "task_dispatch", json!({"requestId":"reassign","taskId":task,"expectedVersion":version,"toAgentId":"dev"}))
        .unwrap();
    let mut by_inactive = input(&task, "inactive-flag");
    by_inactive.beyond_round_limit = Some(true);
    let refused = s.create_pr_review(Some("lead"), &by_inactive, "inactive-flag").unwrap_err().to_string();
    assert!(refused.contains("beyondRoundLimit is only for the agent that dispatched this task's active dispatch"), "{refused}");
}

#[test]
fn two_concurrent_full_rounds_past_the_limit_reserve_only_one() {
    let (_dir, s, task) = setup();
    agent(&s, "dev", "Dev");
    completed_full_round(&s, &task, "r1");
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| s.create_pr_review(Some("dev"), &input(&task, "race-a"), "race-a").is_ok());
        let b = scope.spawn(|| s.create_pr_review(Some("dev"), &input(&task, "race-b"), "race-b").is_ok());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_ne!(a, b, "only one round may pass the limit");
    assert_eq!(s.list_pr_reviews(&task, None).unwrap()["reviews"].as_array().unwrap().len(), 2);
}

#[test]
fn a_start_without_the_new_flag_serializes_as_before() {
    let (_dir, _s, task) = setup();
    let plain = serde_json::to_value(input(&task, "plain")).unwrap();
    assert!(plain.get("beyondRoundLimit").is_none(), "{plain}");
    let parsed: Start = serde_json::from_value(json!({"requestId":"plain","taskId":task,"linkId":"7:pull:1"})).unwrap();
    assert!(parsed.beyond_round_limit.is_none());
}

/// YN-12 S2: the dispatcher's copy of an executor's own round.
mod copy;
