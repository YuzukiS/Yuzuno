//! YN-12 S4: a delivery round is one head, and an attempt one paid review
//! of a fixed base and head. Reviews, CI and mail are Store records and
//! fixtures: no reviewer, model, GitHub call or remote command runs.
use super::*;
use crate::github::client::Repository;

fn sha(c: &str) -> String {
    c.repeat(40)
}

/// Points the task's PR link at `base` → `head`.
fn refresh(s: &Store, base: &str, head: &str) {
    s.github_refresh_object(
        "7:pull:1",
        Ok((Repository { id: 7, full_name: "o/r".into() }, json!({"baseSha":sha(base),"headSha":sha(head),"state":"open"}))),
    )
    .unwrap();
}

/// `delivery_continue` to `base` → `head`, under its own request.
fn cont(s: &Store, t: &str, base: &str, head: &str, key: &str) -> anyhow::Result<Value> {
    let mut v = next(s, t, head);
    v["baseSha"] = json!(sha(base));
    v["requestId"] = json!(key);
    s.collaboration_call(None, "delivery_continue", v).map(|v| v["flow"].clone())
}

fn refused(s: &Store, t: &str, base: &str, head: &str, key: &str) -> String {
    let before = raw(s, t);
    let error = cont(s, t, base, head, key).unwrap_err().to_string();
    assert_eq!(raw(s, t), before, "a refused continue writes nothing: {error}");
    error
}

/// A result for the delivery's current candidate.
fn submit(s: &Store, t: &str, key: &str) -> Value {
    let candidate = get(s, t)["candidate"].clone();
    s.collaboration_call(None, "task_submit_result", result(s, t, Some(candidate), key)).unwrap()
}

/// Ends a round failed before its native start: it reached no verdict and
/// doesn't count (round_limit.rs).
fn not_started(s: &Store, mut run: Value) {
    run["status"] = json!("failed");
    run["error"] = json!("Source preparation failed before the reviewer started");
    s.save_pr_review(&run, None).unwrap();
}

/// Ends a round as its harness failing before any report, after reading
/// source (`read`) or only the change manifest.
fn no_report(s: &Store, mut run: Value, status: &str, read: bool) {
    run["status"] = json!(status);
    run["reasonCodes"] = json!(["execution_failed"]);
    run["conclusion"] = json!("unknown");
    run["nativeStartedAt"] = json!("2026-11-12T00:00:00Z");
    run["contextReads"] = if read {
        json!([{"number":1,"tool":"review_changes"},{"number":2,"tool":"source_read"}])
    } else {
        json!([{"number":1,"tool":"review_changes"}])
    };
    s.save_pr_review(&run, None).unwrap();
}

/// The current attempt's setup tries, each ending before any review exists.
fn fail_setup(s: &Store, t: &str, times: usize) {
    let task = internal(s, t);
    for _ in 0..times {
        let plan = s.delivery_claim(&task, "review").unwrap().unwrap();
        s.delivery_finish(&task, &plan, Err("Reviewer admission unavailable".into())).unwrap();
        s.db.write()
            .unwrap()
            .execute("UPDATE delivery_flows SET data=json_set(data,'$.rounds[#-1].review.nextTry',0) WHERE task_id=?1", [&task])
            .unwrap();
    }
}

fn raw(s: &Store, t: &str) -> Value {
    let task = internal(s, t);
    let raw: String = s.db.read().unwrap().query_row("SELECT data FROM delivery_flows WHERE task_id=?1", [&task], |r| r.get(0)).unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn count(s: &Store, sql: &str) -> i64 {
    s.db.read().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}

/// Review records and review_start receipts: what a paid start writes.
fn written(s: &Store) -> (i64, i64) {
    (
        count(s, "SELECT COUNT(*) FROM pr_reviews"),
        count(s, "SELECT COUNT(*) FROM collaboration_requests WHERE operation='review_start'"),
    )
}

fn delivery_mail(s: &Store, agent: &str) -> Vec<Value> {
    s.collaboration_call(None, "peer_read", json!({"agentId":agent,"limit":200})).unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["metadata"]["kind"] == "delivery")
        .cloned()
        .collect()
}

fn review_start(t: &str, key: &str, base: &str, head: &str) -> crate::pr_review::Start {
    serde_json::from_value(json!({"requestId":key,"taskId":t,"linkId":"7:pull:1","baseSha":sha(base),"headSha":sha(head)})).unwrap()
}

fn green(s: &Store, watch: &str, base: &str, head: &str) {
    s.ci_observe(
        watch,
        Ok(crate::ci_monitor::Observed {
            runs: vec![json!({"id":"github:7:123:1","workflowId":8,"event":"pull_request","repositoryId":7,"runId":"123","attempt":"1","headSha":sha(head),"name":"Checks","rawStatus":"completed","status":"success","conclusion":"success","url":"https://github.com/o/r/actions/runs/123"})],
            head: Some(sha(head)),
            pr: Some(json!({"baseSha":sha(base),"state":"open","merged":false})),
            truncated: false,
            checked: chrono::Utc::now().timestamp(),
            wait: 0,
            excluded: 0,
        }),
    )
    .unwrap();
}

fn interest(s: &Store, t: &str, owner: &str) -> Option<bool> {
    let subs = s.ci_list(None, Some(t), None).unwrap()["subscriptions"].clone();
    subs.as_array().unwrap().iter().flat_map(|sub| sub["interests"].as_array().unwrap().clone()).find(|i| i["owner"] == owner).map(|i| i["active"] == true)
}

/// #3: an attempt that failed without counting is retried in its round, as
/// attempt 2 with its own request and result; the round keeps its CI.
#[test]
fn an_uncounted_failure_is_retried_as_attempt_two_of_the_same_round_with_the_same_ci() {
    let (_d, s, t) = setup();
    let flow = enable(&s, &t)["id"].as_str().unwrap().to_owned();
    let first = submit(&s, &t, "r1")["task"]["result"]["id"].clone();
    let run = start(&s, &t, "one");
    let key = internal(&s, &t);
    let (plan, sub) = subscribe_plan(&s, &t);
    s.delivery_finish(&key, &plan, Ok(sub.clone())).unwrap();
    not_started(&s, run);
    assert_eq!(get(&s, &t)["state"], "infrastructure_error");
    let f = cont(&s, &t, "a", "b", "retry").unwrap();
    assert_eq!((f["rounds"].as_array().unwrap().len(), f["attempt"].clone(), f["state"].clone()), (1, json!(2), json!("awaiting_result")), "{f}");
    let r = &f["rounds"][0];
    assert_eq!(r["review"]["requestId"], format!("delivery:{flow}:1:review:2"));
    assert_eq!((r["review"]["finished"].clone(), r["resultId"].clone()), (json!(0), Value::Null));
    let earlier = r["earlier"].as_array().unwrap();
    assert_eq!(earlier.len(), 1, "{r}");
    assert_eq!(
        (&earlier[0]["number"], &earlier[0]["replaced"], &earlier[0]["review"]["id"], &earlier[0]["resultId"], &earlier[0]["baseSha"]),
        (&json!(1), &json!("uncounted_failure"), &json!("one"), &first, &json!(sha("a")))
    );
    assert_eq!(earlier[0]["review"]["requestId"], format!("delivery:{flow}:1:review"));
    // The round's CI: the same subscription and request, still its interest.
    assert_eq!((&r["ci"]["id"], &r["ci"]["requestId"]), (&sub["id"], &plan.input["requestId"]));
    assert_eq!(interest(&s, &t, &format!("delivery:{flow}:1")), Some(true));
    // S2: a replaced attempt's review is still one the flow registered.
    assert!(crate::delivery::store::registers_review(&s.db.read().unwrap(), &key, "one").unwrap());
    assert_eq!(
        count(&s, "SELECT COUNT(*) FROM collaboration_task_activity WHERE data LIKE '%authorized attempt 2 of round 1/2 at aaaa%: attempt 1 (one) reached no verdict and doesn''t count%'"),
        1
    );
    // Only a matching result starts it, under the attempt's own request.
    assert!(s.delivery_claim(&key, "review").unwrap().is_none());
    submit(&s, &t, "r2");
    let run = start(&s, &t, "two");
    assert_eq!(run["requestId"], format!("delivery:{flow}:1:review:2"));
    let r = get(&s, &t)["rounds"][0].clone();
    assert_eq!((&r["review"]["id"], &r["review"]["finished"]), (&json!("two"), &json!(1)));
    finish(&s, run, "no_findings");
    green(&s, sub["watchId"].as_str().unwrap(), "a", "b");
    assert_eq!(get(&s, &t)["state"], "ready_to_merge");
}

/// #3: a round's CI subscribed after a retry is still the round's, under
/// its owner check: the last round, a result, this head.
#[test]
fn a_retried_rounds_ci_subscribes_under_the_rounds_own_identity() {
    let (_d, s, t) = setup();
    let f = enable(&s, &t);
    submit(&s, &t, "r1");
    not_started(&s, start(&s, &t, "one"));
    cont(&s, &t, "a", "b", "retry").unwrap();
    let url = f["url"].as_str().unwrap();
    let ci = json!({"requestId":f["rounds"][0]["ci"]["requestId"],"taskId":t,"url":url,"expectedSha":sha("b")});
    let early = s.ci_subscribe(Some("owner"), serde_json::from_value(ci.clone()).unwrap(), Repository { id: 7, full_name: "o/r".into() }, "pull", 1);
    assert!(early.unwrap_err().to_string().contains("Delivery authorization changed"), "the new attempt has no result yet");
    submit(&s, &t, "r2");
    let (plan, sub) = subscribe_plan(&s, &t);
    assert_eq!(plan.input["requestId"], ci["requestId"]);
    s.delivery_finish(&internal(&s, &t), &plan, Ok(sub.clone())).unwrap();
    assert_eq!(interest(&s, &t, &format!("delivery:{}:1", f["id"].as_str().unwrap())), Some(true));
    assert_eq!(get(&s, &t)["rounds"][0]["ci"]["id"], sub["id"]);
}

/// #4 and Lead 8082: a retry at a new base of the same head keeps the old
/// base in `earlier`; the replaced attempt's request, naming that base,
/// returns its original review with its receipt and starts nothing without.
#[test]
fn a_base_only_retry_fixes_the_new_base_and_a_replaced_request_never_starts_a_review() {
    let (_d, s, t) = setup();
    let flow = enable(&s, &t)["id"].as_str().unwrap().to_owned();
    submit(&s, &t, "r1");
    let run = start(&s, &t, "one");
    let (plan, sub) = subscribe_plan(&s, &t);
    let key = internal(&s, &t);
    s.delivery_finish(&key, &plan, Ok(sub.clone())).unwrap();
    not_started(&s, run);
    refresh(&s, "e", "b");
    let f = cont(&s, &t, "e", "b", "rebased").unwrap();
    let r = &f["rounds"][0];
    assert_eq!((&r["baseSha"], &r["earlier"][0]["baseSha"], &f["candidate"]["baseSha"]), (&json!(sha("e")), &json!(sha("a")), &json!(sha("e"))));
    assert_eq!((&r["ci"]["id"], &r["ci"]["requestId"]), (&sub["id"], &plan.input["requestId"]), "CI is the round's");
    let old = review_start(&t, &format!("delivery:{flow}:1:review"), "a", "b");
    let before = written(&s);
    let (again, created) = s.create_pr_review(Some("owner"), &old, "must-not-exist").unwrap();
    assert!(!created && again["id"] == "one", "its receipt returns the original review");
    assert_eq!(written(&s), before);
    let error = s.create_pr_review(None, &old, "must-not-exist").unwrap_err().to_string();
    assert!(error.contains("was replaced by attempt 2 of round 1"), "{error}");
    assert!(error.ends_with("No review was started."), "{error}");
    assert!(s.previous_pr_review(None, &old).is_err(), "the lookup refuses it too");
    assert_eq!(written(&s), before, "no record and no receipt");
    // attach_review refuses it before matching: its old base matches no
    // candidate, and an unmatched request registers nothing.
    let config = r["settings"].clone();
    let db = s.db.write().unwrap();
    let attach = |request: &str| {
        crate::delivery::store::attach_review(&db, &key, "7:pull:1", Some(&sha("a")), Some(&sha("b")), &config, request, "x")
    };
    assert!(attach(&format!("delivery:{flow}:1:review")).unwrap_err().to_string().contains("was replaced"));
    attach("manual-old-base").unwrap();
    drop(db);
    assert!(get(&s, &t)["rounds"][0]["review"]["id"].is_null());
}

/// #5: a counted review of the head refuses the same base and a new one.
#[test]
fn a_counted_review_of_the_head_refuses_another_attempt_whatever_the_base() {
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    finish(&s, start(&s, &t, "one"), "changes_requested");
    let error = refused(&s, &t, "a", "b", "same");
    assert!(error.contains(&format!("Head {} already has a counted review of this PR (one, completed)", sha("b"))), "{error}");
    assert!(error.ends_with("No attempt was authorized."), "{error}");
    refresh(&s, "e", "b");
    let error = refused(&s, &t, "e", "b", "rebased");
    assert!(error.contains("a base-only change doesn't add one"), "{error}");
}

/// #2: a new head another task already reviewed is refused.
#[test]
fn a_new_head_another_task_reviewed_is_refused() {
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    finish(&s, start(&s, &t, "one"), "changes_requested");
    let other = s
        .collaboration_call(None, "task_create", json!({"requestId":"other","title":"Same PR"}))
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    link(&s, &other, "b");
    completed_review(&s, &other, "elsewhere", Some(&sha("a")), Some(&sha("c")));
    refresh(&s, "a", "c");
    let error = refused(&s, &t, "a", "c", "next");
    assert!(error.contains("already has a counted review of this PR (elsewhere, completed)"), "{error}");
}

/// #11: back at an earlier round's head, a new round when that head has no
/// counted review (here past the cap), R-COUNTED when it has one.
#[test]
fn back_at_an_earlier_head_is_a_new_round_unless_it_has_a_counted_review() {
    for counted in [true, false] {
        let (_d, s, t) = setup();
        enable(&s, &t);
        submit(&s, &t, "r1");
        let run = start(&s, &t, "one");
        if counted {
            finish(&s, run, "changes_requested");
        } else {
            not_started(&s, run);
        }
        refresh(&s, "a", "c");
        cont(&s, &t, "a", "c", "to-c").unwrap();
        submit(&s, &t, "r2");
        not_started(&s, start(&s, &t, "two"));
        refresh(&s, "a", "b");
        let error = refused(&s, &t, "a", "b", "back");
        if counted {
            assert!(error.contains("already has a counted review of this PR (one, completed)"), "{error}");
        } else {
            assert!(error.contains("Authorized review limit reached"), "a new round, so the cap: {error}");
        }
    }
}

/// The flow fixture a Core at c6e51671 wrote (the fields every Core before
/// S4 writes), for this task.
fn legacy(s: &Store, t: &str, flow: &str) -> Value {
    let task = internal(s, t);
    let db = s.db.read().unwrap();
    let reference = crate::collaboration_store::task_number(&db, &task).unwrap();
    let url = crate::github::store::task_links(&db, &task).unwrap()[0]["url"].as_str().unwrap().to_owned();
    let text = include_str!("../fixtures/flow-c6e51671.json")
        .replace("{FLOW}", flow)
        .replace("{TASK}", &task)
        .replace("{REF}", &reference)
        .replace("{URL}", &url);
    serde_json::from_str(&text).unwrap()
}

fn insert(s: &Store, t: &str, flow: &Value) {
    let task = internal(s, t);
    s.db.write()
        .unwrap()
        .execute("INSERT INTO delivery_flows(task_id,data) VALUES(?1,?2)", rusqlite::params![task, flow.to_string()])
        .unwrap();
}

/// A legacy flow of two rounds at one head: round 1's review counted, round
/// 2's (older Cores continued the same SHA as a new round) didn't.
fn legacy_same_head(s: &Store, t: &str, first: &str, first_by: Option<&str>) -> Value {
    let (run, _) = s.create_pr_review(first_by, &review_start(t, first, "a", "b"), first).unwrap();
    finish(s, run, "changes_requested");
    let (run, _) = s.create_pr_review(Some("owner"), &review_start(t, "delivery:F:2:review", "a", "b"), "two").unwrap();
    not_started(s, run);
    let mut f = legacy(s, t, "F");
    let mut second = f["rounds"][0].clone();
    f["rounds"][0]["review"] = json!({"requestId":"delivery:F:1:review","id":first,"attempts":1,"nextTry":1761955290,"error":null});
    second["number"] = json!(2);
    second["review"] = json!({"requestId":"delivery:F:2:review","id":"two","attempts":1,"nextTry":1761955320,"error":null});
    second["ci"]["requestId"] = json!("delivery:F:2:ci");
    f["rounds"].as_array_mut().unwrap().push(second);
    f["notified"] = json!(["1:waiting_fix", "2:infrastructure_error"]);
    insert(s, t, &f);
    f
}

/// #12 and #13: a legacy flow is judged by the head's whole history, not
/// only its last attempt, which failed without counting here.
#[test]
fn a_legacy_flow_with_a_counted_review_of_the_head_is_refused() {
    // #12: the flow's own round 1 counted.
    let (_d, s, t) = setup();
    legacy_same_head(&s, &t, "delivery:F:1:review", Some("owner"));
    let error = refused(&s, &t, "a", "b", "again");
    assert!(error.contains("already has a counted review of this PR (delivery:F:1:review, completed)"), "{error}");
    // #13: enabling adopted an earlier manual review that counted.
    let (_d, s, t) = setup();
    legacy_same_head(&s, &t, "manual", None);
    let error = refused(&s, &t, "a", "b", "again");
    assert!(error.contains("already has a counted review of this PR (manual, completed)"), "{error}");
    assert!(get(&s, &t).get("attempt").is_none());
}

/// #6: a preparing, running or unknown attempt is never replaced, the
/// Codex unknown that doesn't count included.
#[test]
fn an_unfinished_or_unknown_attempt_is_never_replaced() {
    for ending in ["preparing", "running", "codex_unknown"] {
        let (_d, s, t) = setup();
        enable(&s, &t);
        submit(&s, &t, "r1");
        let mut run = start(&s, &t, "one");
        match ending {
            "running" => {
                run["status"] = json!("running");
                s.save_pr_review(&run, None).unwrap();
            }
            "codex_unknown" => {
                no_report(&s, run, "unknown", false);
                assert!(!crate::pr_review::store::counts_toward_limit(&s.db.read().unwrap(), "one").unwrap(), "it doesn't count");
            }
            _ => {}
        }
        let error = refused(&s, &t, "a", "b", "retry");
        assert!(error.contains("Reconcile the existing review first"), "{ending}: {error}");
    }
}

/// #6 (Lead 11659): a review that completed without an explicit conclusion
/// (`unknown`, or none recorded) is an unknown outcome a person judges first:
/// no new round for a new head nobody reviewed, within the cap, and no other
/// attempt at its own head. Nothing is written, not even the continue's
/// receipt. A failure that doesn't count is still retried.
#[test]
fn a_completed_review_without_an_explicit_conclusion_is_never_replaced() {
    let continues = |s: &Store| count(s, "SELECT COUNT(*) FROM collaboration_requests WHERE operation='delivery_continue'");
    for conclusion in [Some("unknown"), None] {
        let (_d, s, t) = setup();
        enable(&s, &t);
        submit(&s, &t, "r1");
        let mut run = start(&s, &t, "one");
        // As a real round records it: its fixed revision and actual reviewer.
        run["status"] = json!("completed");
        run["baseSha"] = run["requestedBaseSha"].clone();
        run["headSha"] = run["requestedHeadSha"].clone();
        run["actualHarness"] = run["requestedHarness"].clone();
        run["actualModel"] = run["requestedModel"].clone();
        match conclusion {
            Some(c) => run["conclusion"] = json!(c),
            None => {
                run.as_object_mut().unwrap().remove("conclusion");
            }
        }
        s.save_pr_review(&run, None).unwrap();
        let f = get(&s, &t);
        assert_eq!(f["state"], "needs_judgment");
        assert!(f["reason"].as_str().unwrap().contains("did not produce an explicit passing conclusion"), "{f}");
        let before = (written(&s), continues(&s));
        // A new head nobody reviewed, with one of the two rounds left.
        refresh(&s, "a", "c");
        let error = refused(&s, &t, "a", "c", "new-head");
        assert!(error.contains("completed without an explicit conclusion"), "{conclusion:?}: {error}");
        assert!(error.ends_with("No attempt was authorized."), "{error}");
        // The same head again, at its own base.
        refresh(&s, "a", "b");
        let error = refused(&s, &t, "a", "b", "same-head");
        assert!(error.contains("completed without an explicit conclusion"), "{conclusion:?}: {error}");
        assert_eq!((written(&s), continues(&s)), before, "no round, attempt, review or receipt");
        assert_eq!(get(&s, &t)["rounds"].as_array().unwrap().len(), 1);
    }
    // A failure that doesn't count is still another attempt.
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    let mut run = start(&s, &t, "one");
    run["conclusion"] = json!("unknown");
    not_started(&s, run);
    assert_eq!(cont(&s, &t, "a", "b", "retry").unwrap()["attempt"], 2);
}

/// #9: a start the PR's started round limit refused is never retried here.
#[test]
fn a_start_the_limit_refused_is_not_continued() {
    let (_d, s, t) = setup();
    completed_review(&s, &t, "before", None, None);
    enable(&s, &t);
    submit(&s, &t, "r1");
    completed_review(&s, &t, "late", Some(&sha("c")), Some(&sha("d")));
    let key = internal(&s, &t);
    let plan = s.delivery_claim(&key, "review").unwrap().unwrap();
    let input: crate::pr_review::Start = serde_json::from_value(plan.input.clone()).unwrap();
    let error = s.create_pr_review(Some("owner"), &input, "refused").unwrap_err().to_string();
    s.delivery_finish(&key, &plan, Err(error)).unwrap();
    for (base, head, key) in [("a", "b", "same"), ("a", "e", "new-head")] {
        refresh(&s, base, head);
        let error = refused(&s, &t, base, head, key);
        assert!(error.contains("Round 1 attempt 1 was refused by this PR's two started review rounds"), "{error}");
    }
}

/// #10: a round gets at most three attempts.
#[test]
fn a_fourth_attempt_is_refused() {
    let (_d, s, t) = setup();
    enable(&s, &t);
    for n in 1..=3 {
        submit(&s, &t, &format!("r{n}"));
        not_started(&s, start(&s, &t, &format!("review-{n}")));
        if n < 3 {
            cont(&s, &t, "a", "b", &format!("retry-{n}")).unwrap();
        }
    }
    let f = get(&s, &t);
    assert_eq!((f["attempt"].clone(), f["rounds"][0]["earlier"].as_array().unwrap().len()), (json!(3), 2));
    let error = refused(&s, &t, "a", "b", "retry-3");
    assert!(error.contains("Round 1 already had 3 attempts; human judgment is required. No attempt was authorized."), "{error}");
}

/// The manifest-only harness failure never counts; one after reading
/// source doesn't for the PR's first, and counts from its second.
#[test]
fn a_no_report_failure_is_retried_until_it_counts() {
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    no_report(&s, start(&s, &t, "manifest"), "failed", false);
    cont(&s, &t, "a", "b", "retry-1").unwrap();
    submit(&s, &t, "r2");
    no_report(&s, start(&s, &t, "read-1"), "failed", true);
    cont(&s, &t, "a", "b", "retry-2").unwrap();
    submit(&s, &t, "r3");
    no_report(&s, start(&s, &t, "read-2"), "failed", true);
    let f = get(&s, &t);
    let replaced: Vec<_> = f["rounds"][0]["earlier"].as_array().unwrap().iter().map(|a| a["review"]["id"].clone()).collect();
    assert_eq!(replaced, vec![json!("manifest"), json!("read-1")]);
    let error = refused(&s, &t, "a", "b", "retry-3");
    assert!(error.contains("already has a counted review of this PR (read-2, failed)"), "{error}");
}

/// #7: three setup tries that all ended, with no review_start receipt,
/// prove the setup failed: the round retries, and the replaced request,
/// which never had a receipt, can't start anything later.
#[test]
fn an_exhausted_setup_is_retried_and_its_request_never_starts_a_review() {
    let (_d, s, t) = setup();
    let flow = enable(&s, &t)["id"].as_str().unwrap().to_owned();
    submit(&s, &t, "r1");
    fail_setup(&s, &t, 3);
    let f = get(&s, &t);
    assert_eq!(f["state"], "infrastructure_error");
    assert_eq!((&f["rounds"][0]["review"]["attempts"], &f["rounds"][0]["review"]["finished"]), (&json!(3), &json!(3)));
    let f = cont(&s, &t, "a", "b", "retry").unwrap();
    let earlier = &f["rounds"][0]["earlier"][0];
    assert_eq!((&earlier["replaced"], &earlier["review"]["id"]), (&json!("setup_exhausted"), &Value::Null));
    assert_eq!(
        count(&s, "SELECT COUNT(*) FROM collaboration_task_activity WHERE data LIKE '%authorized attempt 2 of round 1/2%attempt 1 (setup) reached no verdict%'"),
        1
    );
    let before = written(&s);
    for actor in [Some("owner"), None] {
        let error = s.create_pr_review(actor, &review_start(&t, &format!("delivery:{flow}:1:review"), "a", "b"), "x").unwrap_err().to_string();
        assert!(error.contains("was replaced by attempt 2 of round 1"), "{error}");
    }
    assert_eq!(written(&s), before, "no record and no receipt");
    // A receipt of the attempt's request means a start may have committed:
    // its setup isn't proven to have failed.
    let (_d, s, t) = setup();
    let flow = enable(&s, &t)["id"].as_str().unwrap().to_owned();
    submit(&s, &t, "r1");
    fail_setup(&s, &t, 3);
    s.db.write()
        .unwrap()
        .execute(
            "INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES('agent:owner','review_start',?1,'{}','{}')",
            [format!("delivery:{flow}:1:review")],
        )
        .unwrap();
    let error = refused(&s, &t, "a", "b", "retry");
    assert!(error.contains("hasn't been confirmed to have ended"), "{error}");
}

/// #8: a setup try whose end isn't recorded (still in flight, or lost to a
/// restart) doesn't prove its setup failed. Its three tries are reported
/// used, and mailed once, as before S4 (PR #901 R1 P2), but the attempt isn't
/// replaced; a step an older Core wrote has no count of ended tries either.
#[test]
fn a_setup_in_flight_or_unrecorded_is_not_replaced() {
    let (dir, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    fail_setup(&s, &t, 2);
    assert!(s.delivery_claim(&internal(&s, &t), "review").unwrap().is_some(), "the third try is in flight");
    // Core restarts before that try's answer is recorded.
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let task = internal(&s, &t);
    let f = get(&s, &t);
    assert_eq!((&f["rounds"][0]["review"]["attempts"], &f["rounds"][0]["review"]["finished"]), (&json!(3), &json!(2)));
    assert_eq!(f["state"], "infrastructure_error", "{f}");
    assert!(f["reason"].as_str().unwrap().contains("the completion of one or more of them isn't recorded"), "{f}");
    assert!(s.delivery_claim(&task, "review").unwrap().is_none(), "never tried again");
    assert!(s.delivery_reconcile(&task).unwrap());
    assert!(!s.delivery_reconcile(&task).unwrap());
    let mail: Vec<_> = delivery_mail(&s, "owner").into_iter().filter(|m| m["metadata"]["status"] == "infrastructure_error").collect();
    assert_eq!(mail.len(), 1, "whoever decides is told once: {mail:?}");
    let before = written(&s);
    let error = refused(&s, &t, "a", "b", "retry");
    assert_eq!(error, "Round 1 attempt 1 hasn't been confirmed to have ended: its setup is in flight or wasn't recorded as finished. Reconcile it first. No attempt was authorized.");
    assert_eq!(written(&s), before, "no review and no receipt");
    // An older step has no count of ended tries: exhausted as before, unproven.
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    fail_setup(&s, &t, 3);
    let task = internal(&s, &t);
    s.db.write()
        .unwrap()
        .execute("UPDATE delivery_flows SET data=json_remove(data,'$.rounds[0].review.finished','$.rounds[0].ci.finished') WHERE task_id=?1", [&task])
        .unwrap();
    let f = get(&s, &t);
    assert_eq!(f["state"], "infrastructure_error");
    assert!(f["reason"].as_str().unwrap().starts_with("Review setup failed after three attempts"), "{f}");
    let error = refused(&s, &t, "a", "b", "retry");
    assert!(error.contains("hasn't been confirmed to have ended"), "{error}");
}

/// A try whose end was missing is judged by its real record once there is
/// one: a late failing answer proves the setup failed, so the head may be
/// authorized again; a review the lost answer had started is the round's, and
/// nothing starts a replacement for it.
#[test]
fn an_unrecorded_try_recovers_from_its_real_record() {
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    fail_setup(&s, &t, 2);
    let task = internal(&s, &t);
    let late = s.delivery_claim(&task, "review").unwrap().unwrap();
    assert!(get(&s, &t)["reason"].as_str().unwrap().contains("Until that is confirmed, no replacement attempt can be authorized"));
    assert!(refused(&s, &t, "a", "b", "early").contains("hasn't been confirmed to have ended"));
    s.delivery_finish(&task, &late, Err("Reviewer admission unavailable".into())).unwrap();
    let f = get(&s, &t);
    assert_eq!(f["rounds"][0]["review"]["finished"], 3);
    assert!(f["reason"].as_str().unwrap().starts_with("Review setup failed after three attempts"), "{f}");
    let f = cont(&s, &t, "a", "b", "retry").unwrap();
    assert_eq!(f["rounds"][0]["earlier"][0]["replaced"], "setup_exhausted");
    // The third try did start its review before its answer was lost.
    let (dir, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    fail_setup(&s, &t, 2);
    let task = internal(&s, &t);
    let plan = s.delivery_claim(&task, "review").unwrap().unwrap();
    let input: crate::pr_review::Start = serde_json::from_value(plan.input.clone()).unwrap();
    let (_, created) = s.create_pr_review(Some("owner"), &input, "started").unwrap();
    assert!(created);
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.recover_pr_reviews().unwrap();
    let f = get(&s, &t);
    assert_eq!(f["rounds"][0]["review"]["id"], "started", "the review is the round's: {f}");
    assert!(f["reason"].as_str().unwrap().starts_with("Review unknown"), "judged by its review: {f}");
    assert!(s.delivery_claim(&task, "review").unwrap().is_none());
    let (again, created) = s.create_pr_review(Some("owner"), &input, "ignored").unwrap();
    assert!(!created && again["id"] == "started", "its request returns it");
    assert_eq!(written(&s), (1, 1), "one review, one receipt");
    assert!(refused(&s, &t, "a", "b", "retry").contains("Reconcile the existing review first"));
}

/// A manual review of the candidate takes the current attempt, within the
/// PR's two started rounds like any other.
#[test]
fn a_manual_review_takes_the_current_attempt_within_the_started_round_limit() {
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    not_started(&s, start(&s, &t, "one"));
    cont(&s, &t, "a", "b", "retry").unwrap();
    completed_review(&s, &t, "x1", Some(&sha("c")), Some(&sha("d")));
    completed_review(&s, &t, "x2", Some(&sha("c")), Some(&sha("e")));
    let manual = review_start(&t, "manual", "a", "b");
    let error = s.create_pr_review(Some("owner"), &manual, "m").unwrap_err().to_string();
    assert!(error.starts_with("round_limit:"), "{error}");
    assert!(get(&s, &t)["rounds"][0]["review"]["id"].is_null());
    let (_, created) = s.create_pr_review(None, &manual, "m").unwrap();
    assert!(created, "the user may start one beyond it");
    let r = get(&s, &t)["rounds"][0].clone();
    assert_eq!((&r["review"]["id"], &r["earlier"][0]["review"]["id"]), (&json!("m"), &json!("one")));
}

/// A setup answer that arrives after its attempt was replaced is written to
/// that attempt in `earlier`, never to the new one.
#[test]
fn a_late_setup_answer_writes_only_the_attempt_it_was_claimed_for() {
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    let task = internal(&s, &t);
    let late = s.delivery_claim(&task, "review").unwrap().unwrap();
    // Its attempt reads as exhausted, as a person reconciling it may leave it.
    s.db.write()
        .unwrap()
        .execute("UPDATE delivery_flows SET data=json_set(data,'$.rounds[0].review.attempts',3,'$.rounds[0].review.finished',3) WHERE task_id=?1", [&task])
        .unwrap();
    cont(&s, &t, "a", "b", "retry").unwrap();
    let current = get(&s, &t)["rounds"][0]["review"].clone();
    s.delivery_finish(&task, &late, Err("Reviewer admission unavailable (late)".into())).unwrap();
    let r = get(&s, &t)["rounds"][0].clone();
    assert_eq!(r["review"], current, "the new attempt is untouched");
    assert_eq!(r["earlier"][0]["review"]["error"], "Reviewer admission unavailable (late)");
}

/// Each attempt's states are notified on their own, also when the state is
/// the same and nothing was reconciled between the continue and it.
#[test]
fn each_attempt_mails_its_own_states() {
    let (_d, s, t) = setup();
    enable(&s, &t);
    submit(&s, &t, "r1");
    fail_setup(&s, &t, 3);
    let task = internal(&s, &t);
    assert!(s.delivery_reconcile(&task).unwrap());
    let f = raw(&s, &t);
    assert_eq!((&f["notified"], &f["lastKey"]), (&json!(["1:infrastructure_error"]), &json!("1:infrastructure_error")));
    cont(&s, &t, "a", "b", "retry").unwrap();
    submit(&s, &t, "r2");
    fail_setup(&s, &t, 3);
    assert!(s.delivery_reconcile(&task).unwrap());
    assert!(!s.delivery_reconcile(&task).unwrap());
    let f = raw(&s, &t);
    assert_eq!(f["notified"], json!(["1:infrastructure_error", "1.2:infrastructure_error"]));
    assert_eq!((&f["lastState"], &f["lastKey"]), (&json!("infrastructure_error"), &json!("1.2:infrastructure_error")));
    let mail: Vec<_> = delivery_mail(&s, "owner").into_iter().filter(|m| m["metadata"]["status"] == "infrastructure_error").collect();
    assert_eq!(mail.len(), 2, "{mail:?}");
    for (m, n) in mail.iter().zip([1, 2]) {
        assert_eq!(m["metadata"]["attempt"], n);
        assert!(m["body"].as_str().unwrap().contains(&format!("delivery round 1/2, attempt {n}/3: infrastructure_error")), "{m}");
    }
}

/// D7: a flow an older Core wrote reads, saves and mails as it did, keeps
/// its request and CI identities, and only a round this Core writes names
/// attempts. Compared with the fixture value, not only through serde.
#[test]
fn a_flow_an_older_core_wrote_reads_saves_and_mails_as_before() {
    let (_d, s, t) = setup();
    let fixture = legacy(&s, &t, "F");
    insert(&s, &t, &fixture);
    let task = internal(&s, &t);
    let v = get(&s, &t);
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    let mut old = vec!["candidate", "ciEvidence", "dispatchId", "enabled", "id", "lastState", "linkId", "maxRounds", "notified", "owner", "reason", "recipient", "reviewEvidence", "rounds", "state", "taskId", "taskRef", "terminal", "url"];
    old.sort();
    assert_eq!(keys, old, "{v}");
    assert_eq!(v["rounds"], fixture["rounds"]);
    assert_eq!(v["state"], "infrastructure_error");
    assert!(v["reason"].as_str().unwrap().starts_with("Review setup failed after three attempts"), "{v}");
    s.delivery_claim(&task, "review").unwrap();
    crate::delivery::store::resave(&s.db.write().unwrap(), &task).unwrap();
    assert_eq!(raw(&s, &t), fixture, "read and saved unchanged, value for value");
    assert!(!s.delivery_reconcile(&task).unwrap(), "already notified");
    assert_eq!(raw(&s, &t), fixture);
    assert!(delivery_mail(&s, "owner").is_empty());
    // Its CI request and owner check work as before; an old step stays old.
    let (plan, sub) = subscribe_plan(&s, &t);
    assert_eq!(plan.input["requestId"], "delivery:F:1:ci");
    s.delivery_finish(&task, &plan, Ok(sub.clone())).unwrap();
    assert_eq!(interest(&s, &t, "delivery:F:1"), Some(true));
    let f = raw(&s, &t);
    assert_eq!(f["rounds"][0]["ci"], json!({"requestId":"delivery:F:1:ci","id":sub["id"],"attempts":1,"nextTry":f["rounds"][0]["ci"]["nextTry"],"error":null}));
    // So does its review request: the current attempt's, never replaced.
    let (run, created) = s.create_pr_review(Some("owner"), &review_start(&t, "delivery:F:1:review", "a", "b"), "old-id").unwrap();
    assert!(created);
    assert_eq!(get(&s, &t)["rounds"][0]["review"]["id"], "old-id");
    finish(&s, run, "changes_requested");
    assert!(s.delivery_reconcile(&task).unwrap());
    let mail = delivery_mail(&s, "owner");
    assert_eq!(mail.len(), 1);
    assert!(mail[0]["body"].as_str().unwrap().contains("delivery round 1/2: waiting_fix."), "{}", mail[0]);
    assert!(mail[0]["metadata"].get("attempt").is_none());
    let f = raw(&s, &t);
    assert!(f.get("lastKey").is_none() && f["rounds"][0].get("earlier").is_none(), "{f}");
    // Its next round is this Core's: it names its attempt; round 1 stays as it was.
    refresh(&s, "a", "c");
    let v = cont(&s, &t, "a", "c", "next").unwrap();
    assert_eq!((&v["attempt"], &v["rounds"][1]["review"]["finished"]), (&json!(1), &json!(0)));
    assert!(v["rounds"][0]["review"].get("finished").is_none());
    submit(&s, &t, "r2");
    let (plan, sub) = subscribe_plan(&s, &t);
    s.delivery_finish(&task, &plan, Ok(sub)).unwrap();
    assert_eq!(interest(&s, &t, "delivery:F:2"), Some(true));
    // Stopping closes every round's CI interest.
    stopped(&s, &t, &v, "stop");
    assert_eq!((interest(&s, &t, "delivery:F:1"), interest(&s, &t, "delivery:F:2")), (Some(false), Some(false)));
}

/// D7: a terminal flow an older Core wrote still can't be continued.
#[test]
fn a_terminal_flow_an_older_core_wrote_stays_terminal() {
    let (_d, s, t) = setup();
    let mut f = legacy(&s, &t, "F");
    f["enabled"] = json!(false);
    f["terminal"] = json!({"state":"stopped","reason":"Automatic delivery was explicitly stopped.","at":"2026-11-01T00:00:00+00:00"});
    insert(&s, &t, &f);
    let error = refused(&s, &t, "a", "b", "again");
    assert!(error.contains("This delivery is terminal"), "{error}");
    assert_eq!(get(&s, &t)["state"], "stopped");
}
