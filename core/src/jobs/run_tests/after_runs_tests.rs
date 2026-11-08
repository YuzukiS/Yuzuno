//! YN-30: a run that starts after other runs of the same Agent. With when
//! succeeded it starts once each has settled succeeded, their artifacts its
//! upstream; with when settled once each has ended. A named run that failed
//! holds it with one mail until that run is retried; a cancelled one holds a
//! run that waits for it to succeed. Store-level, synthetic records only.
use super::*;

/// A run of `stages` that starts after `after` ([{runId, when?}]).
fn create_after(s: &Store, request: &str, stages: Value, after: Value) -> Value {
    let input: RunSubmit = serde_json::from_value(json!({"requestId":request,"taskId":"T-1","name":request,
        "stages":stages,"afterRuns":after})).unwrap();
    input.validate().unwrap();
    let prepared = prepare(&input);
    s.create_run(Some("a"), input, prepared, machine(), json!({"bootId":"boot"})).unwrap()
}
fn try_after(s: &Store, actor: &str, request: &str, after: Value) -> Result<Value, String> {
    let input: RunSubmit = serde_json::from_value(json!({"requestId":request,"taskId":"T-1","name":request,
        "stages":[stage("later", &[])],"afterRuns":after})).map_err(|e| e.to_string())?;
    input.validate().map_err(|e| e.to_string())?;
    let prepared = prepare(&input);
    s.create_run(Some(actor), input, prepared, machine(), json!({"bootId":"boot"})).map_err(|e| e.to_string())
}
fn view(s: &Store, run: &Value) -> Value {
    s.run(run["id"].as_str().unwrap()).unwrap()
}
fn held_mail(s: &Store) -> Vec<Value> {
    mail(s).into_iter().filter(|m| m["metadata"]["status"] == "blocked_by_run").collect()
}
fn runs(s: &Store) -> i64 {
    s.db.read().unwrap().query_row("SELECT COUNT(*) FROM local_job_runs", [], |r| r.get(0)).unwrap()
}

#[test]
fn a_run_starts_after_another_succeeded_with_its_artifacts_as_upstream_and_a_chain_in_order() {
    let (_dir, s) = setup();
    let a = create(&s, "a", json!([stage("prep", &[])]));
    let a_id = a["id"].as_str().unwrap().to_owned();
    // Named by a prefix; kept whole.
    let b = create_after(&s, "b", json!([stage("train", &[]), stage("eval", &["train"])]), json!([{"runId":&a_id[..8]}]));
    let c = create_after(&s, "c", json!([stage("report", &[])]), json!([{"runId":b["id"]}]));
    assert_eq!(b["afterRuns"], json!([{"runId":a_id,"name":"Fixture run","when":"succeeded","status":"queued"}]));
    // Its stages show their own needs only.
    let shown = view(&s, &b);
    assert_eq!(shown["stages"][0]["needs"], json!([]));
    assert_eq!(shown["stages"][1]["needs"], json!(["train"]));
    assert_eq!(shown["status"], "waiting");
    let train = latest(&s, &b, "train");
    assert_eq!(train["status"], "waiting");
    assert_eq!(train["reason"], format!("Waiting for run Fixture run ({}) to succeed (queued)", &a_id[..8]));
    // Only A's stage is in the queue.
    let prep = start(&s);
    assert_eq!(prep["run"]["id"], a["id"]);
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    assert!(success(&s, &prep, "aaa"));
    // A succeeded: B's root stage is released, A's artifact its upstream and checked.
    let train = latest(&s, &b, "train");
    assert_eq!(train["status"], "queued");
    assert_eq!(train["upstream"][0]["jobId"], prep["id"]);
    assert_eq!(train["upstream"][0]["artifacts"][0]["sha256"], "aaa");
    assert_eq!(train["guardChecks"], json!([{"stage":format!("prep of run {}", &a_id[..8]),"jobId":prep["id"],"attempt":prep["attempt"],
        "cwd":"/workspace","artifacts":[artifact("prep.json", "aaa")]}]));
    assert!(train["identity"]["sha256"].is_string());
    assert_eq!(view(&s, &b)["afterRuns"][0]["status"], "succeeded");
    // C waits for B, which has not succeeded yet.
    assert_eq!(latest(&s, &c, "report")["status"], "waiting");
    for key in ["train", "eval"] {
        let job = start(&s);
        assert_eq!(job["run"]["stage"], key);
        assert!(success(&s, &job, "bbb"));
    }
    assert_eq!(latest(&s, &c, "report")["status"], "queued", "B succeeded, so C starts");
    assert!(held_mail(&s).is_empty());
}

#[test]
fn a_failed_run_holds_its_dependant_with_one_mail_until_it_is_retried_and_succeeds() {
    let (_dir, s) = setup();
    let a = create(&s, "a", json!([stage("prep", &[])]));
    let a_id = a["id"].as_str().unwrap().to_owned();
    let b = create_after(&s, "b", json!([stage("train", &[])]), json!([{"runId":a_id}]));
    let prep = start(&s);
    assert!(finish(&s, &prep, "failed", exit("1"), json!({})));
    let held = view(&s, &b);
    assert_eq!(held["status"], "blocked_by_run");
    assert!(held["idleAt"].is_string());
    let reason = latest(&s, &b, "train")["reason"].as_str().unwrap().to_owned();
    assert!(reason.contains("and it is failed") && reason.contains("starts by itself once that run is retried"), "{reason}");
    let told = held_mail(&s);
    assert_eq!(told.len(), 1);
    let body = told[0]["body"].as_str().unwrap();
    assert!(body.contains(b["id"].as_str().unwrap()) && body.contains(&a_id) && body.contains("job_run_cancel"), "{body}");
    assert_eq!(told[0]["metadata"]["runId"], b["id"]);
    // Read again: not told again. Its live reference needs attention.
    s.advance_runs().unwrap();
    assert_eq!(held_mail(&s).len(), 1);
    {
        let db = s.db.read().unwrap();
        assert_eq!(crate::jobs::run_live_ref(&db, b["id"].as_str().unwrap()).unwrap().unwrap()["status"], "blocked_by_run");
    }
    // Retried: B waits again, and the notice is forgotten.
    s.retry_stage(Some("a"), "again", &a_id, "prep").unwrap();
    let waiting = view(&s, &b);
    assert_eq!(waiting["status"], "waiting");
    assert!(waiting["afterRunsNoticed"].as_object().is_none_or(|told| told.is_empty()), "{waiting}");
    // It fails again: told once more; then retried and succeeded, B starts.
    let second = start(&s);
    assert!(finish(&s, &second, "failed", exit("1"), json!({})));
    assert_eq!(held_mail(&s).len(), 2);
    s.retry_stage(Some("a"), "third", &a_id, "prep").unwrap();
    let third = start(&s);
    assert!(success(&s, &third, "ccc"));
    assert_eq!(latest(&s, &b, "train")["status"], "queued");
    assert_eq!(held_mail(&s).len(), 2);
}

#[test]
fn a_cancelled_run_holds_one_waiting_for_its_success_and_releases_one_waiting_for_its_end() {
    let (_dir, s) = setup();
    let a = create(&s, "a", json!([stage("prep", &[])]));
    let a_id = a["id"].as_str().unwrap().to_owned();
    let data = create_after(&s, "data", json!([stage("train", &[])]), json!([{"runId":a_id}]));
    let order = create_after(&s, "order", json!([stage("gpu", &[])]), json!([{"runId":a_id,"when":"settled"}]));
    s.request_run_cancel(Some("a"), &a_id).unwrap();
    assert_eq!(view(&s, &a)["status"], "cancelled");
    // Waiting for its success: held, told once, never started, not cancelled for its owner.
    let held = view(&s, &data);
    assert_eq!(held["status"], "blocked_by_run");
    let reason = latest(&s, &data, "train")["reason"].as_str().unwrap().to_owned();
    assert!(reason.contains("but it was cancelled: it never will"), "{reason}");
    assert_eq!(held_mail(&s).len(), 1);
    assert!(held["cancelRequestedAt"].is_null());
    // Waiting for its end: released, with nothing handed on.
    let gpu = latest(&s, &order, "gpu");
    assert_eq!(gpu["status"], "queued");
    assert_eq!(gpu["upstream"], json!([]));
    assert_eq!(view(&s, &order)["afterRuns"][0]["when"], "settled");
    // Its owner cancels the held one.
    assert_eq!(s.request_run_cancel(Some("a"), data["id"].as_str().unwrap()).unwrap()["status"], "cancelled");
}

#[test]
fn named_runs_are_the_agents_own_existing_ones_each_once_and_cannot_form_a_cycle() {
    let (_dir, s) = setup();
    let a = create(&s, "a", json!([stage("prep", &[])]));
    let a_id = a["id"].as_str().unwrap().to_owned();
    let theirs = {
        let input = input("theirs", json!([stage("x", &[])]));
        let prepared = prepare(&input);
        s.create_run(Some("b"), input, prepared, machine(), json!({"bootId":"boot"})).unwrap()
    };
    let before = runs(&s);
    let error = try_after(&s, "a", "unknown", json!([{"runId":"deadbeef"}])).unwrap_err();
    assert_eq!(error, r#"Run not found: no Run ID starts with "deadbeef""#);
    let error = try_after(&s, "a", "foreign", json!([{"runId":theirs["id"]}])).unwrap_err();
    assert!(error.contains("is another Agent's: a run waits only for its own Agent's runs"), "{error}");
    let error = try_after(&s, "a", "twice", json!([{"runId":a_id},{"runId":&a_id[..8]}])).unwrap_err();
    assert_eq!(error, format!("afterRuns names run {} twice", &a_id[..8]));
    let many: Vec<Value> = (0..9).map(|_| json!({"runId":a_id})).collect();
    assert_eq!(try_after(&s, "a", "many", json!(many)).unwrap_err(), "afterRuns names at most 8 runs");
    let error = try_after(&s, "a", "mode", json!([{"runId":a_id,"when":"later"}])).unwrap_err();
    assert!(error.contains("unknown variant `later`"), "{error}");
    assert_eq!(runs(&s), before, "nothing was made for a refused submission");
    // A cycle would need an earlier run to name a later one: resubmitting A's
    // request with B named is a different submission, refused.
    let b = create_after(&s, "b", json!([stage("train", &[])]), json!([{"runId":a_id}]));
    let error = try_after(&s, "a", "a", json!([{"runId":b["id"]}])).unwrap_err();
    assert!(error.starts_with("idempotency_conflict"), "{error}");
    // A run that was cancelled never succeeds: refused unless only its end is waited for.
    s.request_run_cancel(Some("a"), &a_id).unwrap();
    let error = try_after(&s, "a", "late", json!([{"runId":a_id}])).unwrap_err();
    assert!(error.contains("was cancelled: it will never succeed"), "{error}");
    let ordered = try_after(&s, "a", "late-order", json!([{"runId":a_id,"when":"settled"}])).unwrap();
    assert_eq!(latest(&s, &ordered, "later")["status"], "queued", "it already ended");
}

#[test]
fn the_tool_names_both_modes_within_its_description_limit() {
    let tools = tool_definitions();
    let submit = tools.iter().find(|t| t["name"] == "job_run_submit").unwrap();
    let text = submit["description"].as_str().unwrap();
    assert!(text.contains("when succeeded (default") && text.contains("or settled (ordering only"), "{text}");
    assert!(text.encode_utf16().count() <= 2048, "{}", text.encode_utf16().count());
    let after = &submit["inputSchema"]["properties"]["afterRuns"];
    assert_eq!(after["maxItems"], 8);
    assert_eq!(after["items"]["properties"]["when"]["enum"], json!(["succeeded", "settled"]));
    assert_eq!(after["items"]["required"], json!(["runId"]));
    assert!(after["items"]["properties"]["runId"]["description"].as_str().unwrap().contains("unique prefix"));
}

/// #768 R1 P2: a reused stage runs nothing, so a stage behind it still waits
/// for the named runs, in both modes; with when succeeded it also gets their
/// artifacts as its upstream.
#[test]
fn a_stage_behind_a_reused_one_still_waits_for_the_named_runs() {
    let (_dir, s) = setup();
    // An earlier run whose prep succeeded, to reuse.
    create(&s, "earlier", json!([stage("prep", &[])]));
    let done = start(&s);
    assert!(success(&s, &done, "ppp"));
    let done = s.job(done["id"].as_str().unwrap()).unwrap();
    // The run they wait for, still queued.
    let a = create(&s, "a", json!([stage("other", &[])]));
    let a_id = a["id"].as_str().unwrap().to_owned();
    let mut waiting = Vec::new();
    for when in ["settled", "succeeded"] {
        let mut prep = stage("prep", &[]);
        prep["reuse"] = done["id"].clone();
        let input: RunSubmit = serde_json::from_value(json!({"requestId":format!("b-{when}"),"taskId":"T-1","name":format!("b-{when}"),
            "stages":[prep, stage("gpu", &["prep"])],"afterRuns":[{"runId":a_id,"when":when}]})).unwrap();
        input.validate().unwrap();
        let mut prepared = prepare(&input);
        // The HTTP submission path verifies the reuse before create_run.
        prepared[0].reuse = Some(json!({"jobId":done["id"],"attempt":done["attempt"],"cwd":done["cwd"],
            "artifacts":done["result"]["artifacts"],"identity":done["identity"]["sha256"]}));
        let b = s.create_run(Some("a"), input, prepared, machine(), json!({})).unwrap();
        let gpu = latest(&s, &b, "gpu");
        assert_eq!(gpu["status"], "waiting", "{when}: {gpu}");
        let verb = if when == "settled" { "finish" } else { "succeed" };
        assert_eq!(gpu["reason"], format!("Waiting for run Fixture run ({}) to {verb} (queued)", &a_id[..8]), "{when}");
        waiting.push((when, b));
    }
    let other = start(&s);
    assert_eq!(other["run"]["id"], a["id"], "only the named run's stage was queued");
    assert!(success(&s, &other, "ooo"));
    for (when, b) in waiting {
        let gpu = latest(&s, &b, "gpu");
        assert_eq!(gpu["status"], "queued", "{when}");
        let from: Vec<&Value> = gpu["upstream"].as_array().unwrap().iter().map(|u| &u["jobId"]).collect();
        let expected = if when == "succeeded" { vec![&done["id"], &other["id"]] } else { vec![&done["id"]] };
        assert_eq!(from.len(), expected.len(), "{when}: {}", gpu["upstream"]);
        for id in expected {
            assert!(from.contains(&id), "{when}: {id} in {}", gpu["upstream"]);
        }
    }
}
