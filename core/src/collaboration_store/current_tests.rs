use crate::{github::client::Repository, model::AgentDetail, store::Store};
use serde_json::{json, Value};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.insert(&serde_json::from_value::<AgentDetail>(json!({"agent":{"id":"a","name":"Dev","cwd":"/workspace","model":"test",
        "color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,
        "reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    s.collaboration_call(None, "task_create", json!({"requestId":"c","title":"Ship it","status":"doing"})).unwrap();
    (dir, s)
}

fn get(s: &Store, input: Value) -> anyhow::Result<Value> {
    s.collaboration_call(None, "task_get", input)
}

fn comment(s: &Store, n: usize) {
    s.collaboration_call(Some("a"), "task_comment", json!({"requestId":format!("n{n}"),"taskId":"T-1","body":format!("note {n} {}", "x".repeat(200))})).unwrap();
}

#[test]
fn the_current_view_is_short_cuts_long_text_and_reads_no_history() {
    let (_dir, s) = store();
    for n in 0..300 {
        comment(&s, n);
    }
    let version = get(&s, json!({"taskId":"T-1","view":"current"})).unwrap()["current"]["version"].as_i64().unwrap();
    s.collaboration_call(None, "task_update", json!({"requestId":"u","taskId":"T-1","expectedVersion":version,
        "patch":{"progress":"p".repeat(4000)}})).unwrap();
    let version = version + 1;
    s.collaboration_call(Some("a"), "task_submit_result", json!({"requestId":"r","taskId":"T-1","expectedVersion":version,
        "summary":"s".repeat(3000)})).unwrap();
    let current = get(&s, json!({"taskId":"T-1","view":"current"})).unwrap();
    let full = get(&s, json!({"taskId":"T-1"})).unwrap();
    let c = &current["current"];
    assert_eq!((c["taskId"].clone(), c["status"].clone(), c["version"].clone()), (json!("T-1"), json!("review"), json!(version + 1)));
    assert!(c["progress"].as_str().unwrap().ends_with("[2500 more characters: view \"full\"]"), "{}", c["progress"]);
    assert!(c["result"]["summary"].as_str().unwrap().contains("[1500 more characters"));
    assert_eq!(c["latestActivity"]["kind"], "result");
    for gone in ["activities", "executions", "materialsSource"] {
        assert!(current.get(gone).is_none() && c.get(gone).is_none(), "{gone}");
    }
    assert!(current.to_string().len() * 5 < full.to_string().len(), "{} vs {}", current.to_string().len(), full.to_string().len());

    // History the current view never reads: an old row Core cannot parse (JSON5,
    // which SQLite's JSON indexes accept and serde does not) breaks the full
    // view and a page that includes it, nothing else.
    s.db.write().unwrap().execute(
        "UPDATE collaboration_task_activity SET data='{kind:\"comment\",}' WHERE seq=(SELECT MIN(seq) FROM collaboration_task_activity)",
        []).unwrap();
    assert!(get(&s, json!({"taskId":"T-1"})).is_err());
    assert!(get(&s, json!({"taskId":"T-1","view":"activity"})).is_err());
    assert_eq!(get(&s, json!({"taskId":"T-1","view":"current"})).unwrap()["current"]["version"], json!(version + 1));
    assert_eq!(get(&s, json!({"taskId":"T-1","view":"activity","afterSeq":5,"limit":2})).unwrap()["activities"].as_array().unwrap().len(), 2);
}

#[test]
fn history_pages_keep_a_stable_cursor_while_it_grows() {
    let (_dir, s) = store();
    for n in 0..120 {
        comment(&s, n);
    }
    let mut seen = Vec::new();
    let mut after = 0;
    loop {
        let page = get(&s, json!({"taskId":"T-1","view":"activity","afterSeq":after,"limit":50})).unwrap();
        assert_eq!(page["taskId"], "T-1");
        assert!(page.get("executions").is_none() && page.get("task").is_none());
        let activities = page["activities"].as_array().unwrap().clone();
        seen.extend(activities.iter().map(|a| a["seq"].as_i64().unwrap()));
        if seen.len() == 50 {
            comment(&s, 999); // written between pages: on a later page, once
        }
        after = page["nextAfterSeq"].as_i64().unwrap();
        if page["hasMore"] == false {
            break;
        }
    }
    let total: i64 = s.db.read().unwrap().query_row("SELECT COUNT(*) FROM collaboration_task_activity", [], |r| r.get(0)).unwrap();
    assert_eq!(seen.len() as i64, total, "every activity once");
    assert!(seen.windows(2).all(|w| w[0] < w[1]), "in order, no repeats");
}

#[test]
fn views_say_what_they_need() {
    let (_dir, s) = store();
    let wrong = |input: Value| get(&s, input).unwrap_err().to_string();
    assert!(wrong(json!({"taskId":"T-1","view":"everything"})).contains("view is current, activity or full"));
    assert!(wrong(json!({"taskId":"T-1","view":"current","limit":5})).contains("use view \"activity\""));
    assert!(wrong(json!({"taskId":"T-1","view":"current","dispatchId":"d"})).contains("omit view"));
    assert!(wrong(json!({"taskId":"T-1","view":"activity","limit":500})).contains("limit 1..200"));
    // Without a view the store answers as before: the whole record.
    let full = get(&s, json!({"taskId":"T-1"})).unwrap();
    assert!(full["task"].is_object() && full["activities"].is_array() && full["executions"].is_array());
}

#[test]
fn the_delivery_is_read_from_records_and_unknown_is_never_green() {
    let (_dir, s) = store();
    let repo = Repository { id: 7, full_name: "owner/repo".into() };
    let (base, head) = ("a".repeat(40), "b".repeat(40));
    s.github_link_object("T-1", &repo, "pull", 1, json!({"title":"Ship","state":"open","baseSha":base,"headSha":head,
        "baseBranch":"main","ci":{"state":"success","headSha":"c".repeat(40),"complete":true,"observedAt":"then"}})).unwrap();
    let delivery = |s: &Store| get(s, json!({"taskId":"T-1","view":"current"})).unwrap()["current"]["delivery"].clone();
    let pr = delivery(&s)["pullRequests"][0].clone();
    assert_eq!((pr["number"].clone(), pr["headSha"].clone()), (json!(1), json!(head)));
    assert_eq!(pr["ci"]["state"], "unknown", "another commit's success says nothing of this head: {pr}");
    assert!(pr["latestReview"].is_null());

    let start = serde_json::from_value(json!({"requestId":"r1","notifyAgentId":null,"taskId":"T-1","linkId":pr["linkId"],
        "baseSha":null,"headSha":null})).unwrap();
    let (mut run, _) = s.create_pr_review(None, &start, "r1").unwrap();
    run["status"] = json!("completed");
    run["conclusion"] = json!("approved_with_notes");
    run["headSha"] = json!(head);
    run["baseSha"] = json!(base);
    run["actualHarness"] = json!("codex");
    run["actualModel"] = json!("model");
    run["findings"] = json!([{"priority":3},{"priority":3},{"priority":2}]);
    run["scope"] = json!({"counts":{"covered":4}});
    s.save_pr_review(&run, Some("report")).unwrap();
    let pr = delivery(&s)["pullRequests"][0].clone();
    let review = &pr["latestReview"];
    assert_eq!((review["conclusion"].clone(), review["forCurrentHead"].clone()), (json!("approved_with_notes"), json!(true)));
    assert_eq!((review["reviewerStarted"].clone(), pr["reviews"].clone()), (json!(true), json!({"attempts":1,"reviewerRuns":1})));
    assert!(pr.get("latestReviewerRun").is_none(), "the newest attempt ran a reviewer: {pr}");
    assert_eq!(review["findings"], json!({"P3":2,"P2":1}));
    assert_eq!(review["scopeCounts"], json!({"covered":4}));

    // A later attempt that failed while preparing (a wrong fixed base) started
    // no reviewer: it is shown as such, and the round before it still is.
    let again = serde_json::from_value(json!({"requestId":"r2","notifyAgentId":null,"taskId":"T-1","linkId":pr["linkId"],
        "baseSha":"c".repeat(40),"headSha":head})).unwrap();
    let (mut failed, _) = s.create_pr_review(None, &again, "r2").unwrap();
    failed["status"] = json!("failed");
    failed["error"] = json!("The requested base is not the PR's base; no reviewer was started");
    s.save_pr_review(&failed, None).unwrap();
    let pr = delivery(&s)["pullRequests"][0].clone();
    assert_eq!((pr["latestReview"]["reviewId"].clone(), pr["latestReview"]["reviewerStarted"].clone()), (json!("r2"), json!(false)));
    assert_eq!((pr["latestReviewerRun"]["reviewId"].clone(), pr["latestReviewerRun"]["conclusion"].clone()),
        (json!("r1"), json!("approved_with_notes")));
    assert_eq!(pr["reviews"], json!({"attempts":2,"reviewerRuns":1}));

    let subscribe = serde_json::from_value(json!({"requestId":"ci","taskId":"T-1","agentId":null,
        "url":"https://github.com/owner/repo/pull/1","expectedSha":head})).unwrap();
    let sub = s.ci_subscribe(Some("a"), subscribe, repo, "pull", 1).unwrap();
    let ci = delivery(&s)["ciSubscriptions"][0].clone();
    assert_eq!((ci["active"].clone(), ci["latestRun"].clone()), (json!(true), Value::Null), "nothing observed yet: {ci}");
    let observed = json!({"id":"github:7:42:1","source":"github_actions","repositoryId":7,"repository":"owner/repo","runId":"42",
        "attempt":"1","headSha":head,"name":"CI","status":"passed","rawStatus":"completed","conclusion":"success",
        "event":"pull_request","branch":"feature","observedAt":"now","url":"https://github.com/owner/repo/actions/runs/42/attempts/1"});
    s.ci_observe(sub["watchId"].as_str().unwrap(), Ok(crate::ci_monitor::Observed { runs: vec![observed], head: Some(head.clone()),
        pr: None, truncated: false, checked: chrono::Utc::now().timestamp(), wait: 0, excluded: 0 })).unwrap();
    let ci = delivery(&s)["ciSubscriptions"][0].clone();
    assert_eq!((ci["latestRun"]["conclusion"].clone(), ci["latestRun"]["headSha"].clone()), (json!("success"), json!(head)));
    assert_eq!(ci["agent"], "Dev");
}

/// T-203: each observation says where it came from and when Core made it, a
/// failed refresh keeps the last good one, a watched workflow run sits beside
/// the head's checks without standing for them, and the latest result stays
/// the report it was while the task moves on.
#[test]
fn observations_carry_their_source_and_time_and_a_result_stays_as_reported() {
    let (_dir, s) = store();
    s.insert(&serde_json::from_value::<AgentDetail>(json!({"agent":{"id":"lead","name":"Lead","cwd":"/workspace","model":"test",
        "color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,
        "reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    let repo = Repository { id: 7, full_name: "owner/repo".into() };
    let (base, head) = ("a".repeat(40), "b".repeat(40));
    s.github_link_object("T-1", &repo, "pull", 1, json!({"title":"Ship","state":"open","baseSha":base,"headSha":head,
        "baseBranch":"main","observedAt":"t0","ci":{"state":"pending","headSha":head,"complete":false,"observedAt":"t0"}})).unwrap();
    let current = |s: &Store| get(s, json!({"taskId":"T-1","view":"current"})).unwrap()["current"].clone();
    let pr = current(&s)["delivery"]["pullRequests"][0].clone();
    assert_eq!((pr["state"].clone(), pr["observedAt"].clone(), pr["error"].clone()), (json!("open"), json!("t0"), Value::Null));
    assert!(pr["ci"]["source"].as_str().unwrap().contains("all of this head's checks"), "{pr}");
    assert_eq!(pr["watchedRuns"], json!([]));

    // A failed refresh is kept as it happened: the last good read stays, with
    // its time, and the attempt and its error are shown beside it.
    s.github_refresh_object(pr["linkId"].as_str().unwrap(), Err("rate_limited: try later".into())).unwrap();
    let failed = current(&s)["delivery"]["pullRequests"][0].clone();
    assert_eq!((failed["state"].clone(), failed["observedAt"].clone(), failed["ci"]["state"].clone()), (json!("open"), json!("t0"), json!("pending")));
    assert_eq!((failed["error"].clone(), failed["stale"].clone()), (json!("rate_limited: try later"), json!(true)));
    assert!(failed["lastAttemptAt"].as_str().unwrap() >= failed["syncedAt"].as_str().unwrap(), "{failed}");

    // One workflow passing on the head is shown as that run, and the head's
    // checks stay as GitHub last reported them.
    let subscribe = serde_json::from_value(json!({"requestId":"ci","taskId":"T-1","agentId":null,
        "url":"https://github.com/owner/repo/pull/1","expectedSha":head})).unwrap();
    let sub = s.ci_subscribe(Some("a"), subscribe, repo, "pull", 1).unwrap();
    let observed = json!({"id":"github:7:42:2","source":"github_actions","repositoryId":7,"repository":"owner/repo","runId":"42",
        "attempt":"2","headSha":head,"name":"CI","status":"passed","rawStatus":"completed","conclusion":"success",
        "event":"pull_request","branch":"feature","observedAt":"t1","url":"https://github.com/owner/repo/actions/runs/42/attempts/2"});
    s.ci_observe(sub["watchId"].as_str().unwrap(), Ok(crate::ci_monitor::Observed { runs: vec![observed], head: Some(head.clone()),
        pr: None, truncated: false, checked: chrono::Utc::now().timestamp(), wait: 0, excluded: 0 })).unwrap();
    let pr = current(&s)["delivery"]["pullRequests"][0].clone();
    assert_eq!(pr["watchedRuns"], json!([{"runKey":"github:7:42:2","name":"CI","status":"passed","conclusion":"success",
        "attempt":"2","observedAt":"t1"}]));
    assert_eq!((pr["ci"]["state"].clone(), pr["ci"]["observedAt"].clone()), (json!("pending"), json!("t0")), "{pr}");
    assert!(current(&s)["delivery"]["note"].as_str().unwrap().contains("not all of its checks"));

    // The same commit heads a fork's PR too. Each PR lists only the runs of
    // its own repository: the fork's passing run is not the upstream PR's.
    let fork = Repository { id: 8, full_name: "fork/repo".into() };
    s.github_link_object("T-1", &fork, "pull", 2, json!({"title":"Ship (fork)","state":"open","baseSha":base,"headSha":head,
        "baseBranch":"main","observedAt":"t0","ci":{"state":"pending","headSha":head,"complete":false,"observedAt":"t0"}})).unwrap();
    let subscribe = serde_json::from_value(json!({"requestId":"ci-fork","taskId":"T-1","agentId":null,
        "url":"https://github.com/fork/repo/pull/2","expectedSha":head})).unwrap();
    let sub = s.ci_subscribe(Some("a"), subscribe, fork, "pull", 2).unwrap();
    let forked = json!({"id":"github:8:77:1","source":"github_actions","repositoryId":8,"repository":"fork/repo","runId":"77",
        "attempt":"1","headSha":head,"name":"Fork CI","status":"passed","rawStatus":"completed","conclusion":"success",
        "event":"pull_request","branch":"feature","observedAt":"t2","url":"https://github.com/fork/repo/actions/runs/77/attempts/1"});
    s.ci_observe(sub["watchId"].as_str().unwrap(), Ok(crate::ci_monitor::Observed { runs: vec![forked], head: Some(head.clone()),
        pr: None, truncated: false, checked: chrono::Utc::now().timestamp(), wait: 0, excluded: 0 })).unwrap();
    let pulls = current(&s)["delivery"]["pullRequests"].clone();
    let runs = |pr: &Value| pr["watchedRuns"].as_array().unwrap().iter().map(|r| r["runKey"].clone()).collect::<Vec<_>>();
    assert_eq!(runs(&pulls[0]), vec![json!("github:7:42:2")], "the fork's run is not the upstream PR's: {pulls}");
    assert_eq!(runs(&pulls[1]), vec![json!("github:8:77:1")], "the upstream run is not the fork PR's: {pulls}");
    assert_eq!((pulls[0]["repositoryId"].clone(), pulls[1]["repositoryId"].clone()), (json!(7), json!(8)));

    // The result is the report it was. Status, version and the mail's delivery
    // move on in their own fields; the report and its state then do not.
    let version = current(&s)["version"].clone();
    let dispatched = s.collaboration_call(Some("lead"), "task_dispatch", json!({"requestId":"d","taskId":"T-1",
        "expectedVersion":version,"toAgentId":"a"})).unwrap();
    let submitted = s.collaboration_call(Some("a"), "task_submit_result", json!({"requestId":"r","taskId":"T-1",
        "expectedVersion":current(&s)["version"],"dispatchId":dispatched["message"]["dispatchId"],"summary":"Ready"})).unwrap();
    let reported = current(&s)["version"].as_i64().unwrap();
    let result = current(&s)["result"].clone();
    assert_eq!((result["taskVersionAtReport"].clone(), result["statusAtReport"].clone(), result["editsSinceReport"].clone()),
        (json!(reported), json!("review"), json!(0)));
    assert_eq!((result["notification"].clone(), result["notificationNow"].clone()), (json!("pending"), json!("pending")));
    assert!(result["note"].as_str().unwrap().contains("never rewritten"));
    let seq = submitted["message"]["seq"].as_i64().unwrap();
    s.set_peer_delivery("lead", seq, "sending", json!({})).unwrap();
    s.set_peer_delivery("lead", seq, "delivered", json!({})).unwrap();
    s.collaboration_call(Some("lead"), "task_update", json!({"requestId":"done","taskId":"T-1","expectedVersion":reported,
        "patch":{"status":"done","progress":"Accepted after review"}})).unwrap();
    let now = current(&s);
    assert_eq!((now["status"].clone(), now["progress"].clone()), (json!("done"), json!("Accepted after review")));
    let result = &now["result"];
    assert_eq!((result["statusAtReport"].clone(), result["editsSinceReport"].clone(), result["summary"].clone()),
        (json!("review"), json!(1), json!("Ready")));
    assert_eq!((result["notification"].clone(), result["notificationNow"].clone()), (json!("pending"), json!("delivered")));

    // A result reported before Core recorded its version says it does not know.
    s.db.write().unwrap().execute("UPDATE collaboration_tasks SET data=json_remove(data,'$.result.taskVersion','$.result.status')", []).unwrap();
    let result = current(&s)["result"].clone();
    assert_eq!((result["taskVersionAtReport"].clone(), result["statusAtReport"].clone(), result["editsSinceReport"].clone()),
        (Value::Null, Value::Null, Value::Null));
}

/// Each query of the current view, and of loading a dispatched task (every
/// task read and write does), reads through the index named for it: the plan
/// never walks the task's history or the Workspace's reviews, subscriptions
/// or runs.
#[test]
fn the_current_path_reads_through_its_indexes() {
    use super::super::result_dispatch::{DISPATCH_ENDS, LATEST_DISPATCH};
    let (_dir, s) = store();
    let db = s.db.read().unwrap();
    for (sql, index) in [(super::LATEST_ACTIVITY, "collaboration_activity_task"), (LATEST_DISPATCH, "collaboration_activity_dispatched"),
        (DISPATCH_ENDS, "collaboration_activity_dispatch_end"), (super::LATEST_REVIEW, "pr_reviews_task"),
        (super::NEWEST_SUBSCRIPTIONS, "ci_subscriptions_task"), (super::SUBSCRIPTION_COUNT, "ci_subscriptions_task"),
        (super::LATEST_REVIEWER_RUN, "pr_reviews_task"), (super::REVIEW_COUNTS, "pr_reviews_task"),
        (super::LATEST_RUN, "(watch_id=?)"), (super::MESSAGE_STATE, "(id=?)")] {
        let mut plan = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let unbound = vec![rusqlite::types::Null; plan.parameter_count()];
        let steps: Vec<String> = plan.query_map(rusqlite::params_from_iter(unbound), |r| r.get(3)).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert!(steps.iter().all(|step| !step.starts_with("SCAN")), "{sql}: {steps:?}");
        assert!(steps[0].contains(index), "{sql} reads through {index}: {steps:?}");
    }
}
