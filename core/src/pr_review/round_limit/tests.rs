//! The rule from stored records alone; the Store's use of it is tested
//! with the started-rounds limit in continuation/tests.rs.
use super::*;

/// A round whose native harness reported a failure before any report,
/// after these reads (beyond the change manifest).
fn no_report(id: &str, tools: &[&str]) -> Value {
    let mut reads = vec![json!({"number":1,"tool":"review_changes"})];
    reads.extend(tools.iter().map(|tool| json!({"tool":tool})));
    json!({"id":id,"round":1,"status":"failed","ledger":{"version":LEDGER_VERSION},"nativeStartedAt":"2026-11-09T00:25:15Z",
        "reasonCodes":["execution_failed"],"conclusion":"unknown","findings":[],"contextReads":reads})
}

#[test]
fn only_a_harness_failure_before_any_report_shows_no_verdict() {
    assert_eq!(ending(&no_report("a", &[])), Ending::NoReport { read: false });
    assert_eq!(ending(&no_report("a", &["source_search"])), Ending::NoReport { read: true });
    // Codex ends such a round unknown, with the same single reason.
    let mut codex = no_report("a", &["source_diff"]);
    codex["status"] = json!("unknown");
    assert_eq!(ending(&codex), Ending::NoReport { read: true });
    let mut early = no_report("a", &[]);
    early.as_object_mut().unwrap().remove("nativeStartedAt");
    assert_eq!(ending(&early), Ending::NotStarted);
    let other = |edit: fn(&mut Value)| {
        let mut run = no_report("a", &[]);
        edit(&mut run);
        assert_eq!(ending(&run), Ending::Other, "{run}");
    };
    other(|r| r["status"] = json!("completed"));
    other(|r| r["status"] = json!("cancelled"));
    other(|r| r["status"] = json!("running"));
    other(|r| r["reasonCodes"] = json!(["execution_failed", "execution_unconfirmed"]));
    other(|r| r["reasonCodes"] = json!(["execution_unconfirmed"]));
    other(|r| r["reasonCodes"] = json!(["invalid_report"]));
    other(|r| r["conclusion"] = json!("changes_requested"));
    other(|r| r["nativeCorrectness"] = json!("unknown"));
    other(|r| r["findings"] = json!([{"priority":3}]));
    other(|r| { r.as_object_mut().unwrap().remove("findings"); });
    // Without a ledger nothing it did can be proved, started or not.
    other(|r| { r.as_object_mut().unwrap().remove("ledger"); });
    other(|r| {
        r.as_object_mut().unwrap().remove("ledger");
        r.as_object_mut().unwrap().remove("nativeStartedAt");
    });
    other(|r| { r.as_object_mut().unwrap().remove("nativeStartedAt"); r["status"] = json!("unknown"); });
}

#[test]
fn a_pr_leaves_one_failure_after_reads_uncounted_whether_stamped_or_older() {
    let completed = json!({"id":"c","status":"completed"});
    // Older rounds without a stamp, in the order they were created.
    let rounds = [no_report("n", &[]), no_report("r1", &["source_read"]), completed.clone(), no_report("r2", &["source_diff"])];
    assert_eq!(counts(&rounds), [false, false, true, true]);
    // A stamp decides, wherever it is: the stamped one took the free round.
    let mut stamped = no_report("r2", &["source_diff"]);
    stamped["roundLimit"] = stamp(&stamped, &[]).unwrap();
    assert_eq!(stamped["roundLimit"]["counts"], false);
    let mut later = no_report("r3", &["source_diff"]);
    later["roundLimit"] = stamp(&later, std::slice::from_ref(&stamped)).unwrap();
    assert_eq!(later["roundLimit"]["counts"], true);
    assert_eq!(later["roundLimit"]["uncountedRound"]["reviewId"], "r2");
    assert!(later["roundLimit"]["why"].as_str().unwrap().contains("round 1 (r2)"));
    assert_eq!(counts(&[completed.clone(), stamped.clone(), later.clone()]), [true, false, true]);
    // A round stamped when an older unstamped one had taken it counts, and
    // counting agrees with both.
    let older = no_report("old", &["source_read"]);
    let mut after = no_report("new", &["source_read"]);
    after["roundLimit"] = stamp(&after, std::slice::from_ref(&older)).unwrap();
    assert_eq!(after["roundLimit"]["counts"], true);
    assert_eq!(counts(&[older, after]), [false, true]);
    // One that read nothing never counts, and takes nothing.
    let nothing = no_report("n", &[]);
    let stamped = stamp(&nothing, &[]).unwrap();
    assert_eq!((stamped["counts"].as_bool(), stamped["read"].as_str()), (Some(false), Some("nothing")));
    assert!(stamp(&no_report("r", &["source_read"]), std::slice::from_ref(&nothing)).unwrap()["counts"] == false);
    // Any other round gets no stamp.
    assert!(stamp(&completed, &[]).is_none());
}
