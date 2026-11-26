//! YN-221: the reconciliation loop's pass (advance_runs) advances each run in
//! flight, and every run waiting for one, once, oldest first (runs.rs
//! advance_each_once). Before, it advanced each run in flight, newest first,
//! and again every run waiting for it (`baseline` here). Each case puts runs
//! in a state only that pass carries on: an event whose own propagation is
//! undone, the upstream runs' rows kept as the event left them. It then
//! compares every run after each of three passes, and the mail each pass
//! sent, with the baseline's from the same state. Synthetic records only.
use super::*;

fn after(s: &Store, request: &str, stages: Value, after: Value) -> Value {
    let input: RunSubmit = serde_json::from_value(json!({"requestId":request,"taskId":"T-1","name":request,
        "stages":stages,"afterRuns":after})).unwrap();
    input.validate().unwrap();
    let prepared = prepare(&input);
    s.create_run(Some("a"), input, prepared, machine(), json!({"bootId":"boot"})).unwrap()
}
/// A run named `name` with no run to wait for.
fn first(s: &Store, name: &str, stages: Value) -> Value {
    after(s, name, stages, json!([]))
}
fn id(run: &Value) -> &str {
    run["id"].as_str().unwrap()
}

const OPEN: &str = "SELECT id FROM local_job_runs WHERE json_extract(data,'$.settledAt') IS NULL
                 AND json_extract(data,'$.idleAt') IS NULL ORDER BY seq DESC LIMIT 64";

/// The pass as it was before YN-221: each run in flight, newest first, and
/// again, for each, every run waiting for it.
fn baseline(s: &Store) {
    let ids: Vec<String> = s.db.read().unwrap().prepare(OPEN).unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    let mut db = s.db.write().unwrap();
    let tx = db.transaction().unwrap();
    for id in ids {
        runs::advance(s, &tx, &id).unwrap();
    }
    tx.commit().unwrap();
}

/// Every run, oldest first: its status, whether it is idle or settled, and
/// each stage's latest attempt's status and reason.
fn states(s: &Store) -> Vec<Value> {
    let ids: Vec<String> = s.db.read().unwrap().prepare("SELECT id FROM local_job_runs ORDER BY seq").unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    ids.iter()
        .map(|id| {
            let run = s.run(id).unwrap();
            let stages: Vec<Value> = run["stages"].as_array().unwrap().iter()
                .map(|st| {
                    let job = latest(s, &run, st["key"].as_str().unwrap());
                    json!({"key": st["key"], "status": job["status"], "reason": job["reason"]})
                })
                .collect();
            json!({"name": run["name"], "status": run["status"], "idle": run["idleAt"].is_string(),
                "settled": run["settledAt"].is_string(), "stages": stages})
        })
        .collect()
}
fn named<'a>(states: &'a [Value], name: &str) -> &'a Value {
    states.iter().find(|r| r["name"] == name).unwrap()
}

/// Agent a's mail, every page.
fn mails(s: &Store) -> Vec<Value> {
    let (mut all, mut after) = (Vec::new(), 0);
    loop {
        let page = s.collaboration_call(Some("a"), "peer_read", json!({"afterSeq": after, "limit": 200})).unwrap();
        all.extend(page["messages"].as_array().unwrap().iter().cloned());
        if page["hasMore"] != true {
            return all;
        }
        after = page["nextAfterSeq"].as_i64().unwrap();
    }
}
/// The mail since `from`: what each told, of which run, in no order (the
/// baseline told the runs it read newest first; the pass tells them oldest
/// first).
fn sent(s: &Store, from: usize) -> Vec<Value> {
    let mut mail: Vec<Value> = mails(s)[from..].iter().map(|m| json!([m["metadata"]["status"], m["metadata"]["runId"]])).collect();
    mail.sort_by_key(|m| m.to_string());
    mail
}

const TABLES: [(&str, &str); 3] = [
    ("local_job_runs", "id"),
    ("local_job_run_attempts", "run_id"),
    ("local_jobs", "json_extract(data,'$.run.id')"),
];
fn snapshot(s: &Store) {
    let db = s.db.write().unwrap();
    for (t, _) in TABLES {
        db.execute_batch(&format!("DROP TABLE IF EXISTS snap_{t}; CREATE TABLE snap_{t} AS SELECT * FROM {t};")).unwrap();
    }
}
/// The runs' tables as snapshotted, but the rows of the runs `keep` as they
/// are now, and of the runs `jobs_of` their Jobs only.
fn restore(s: &Store, keep: &[&str], jobs_of: &[&str]) {
    let db = s.db.write().unwrap();
    for (t, by) in TABLES {
        let kept: Vec<String> = keep.iter().chain(if t == "local_jobs" { jobs_of } else { &[] })
            .map(|k| format!("'{k}'")).collect();
        let other = if kept.is_empty() { "1".to_owned() } else { format!("{by} IS NULL OR {by} NOT IN ({})", kept.join(",")) };
        db.execute_batch(&format!("DELETE FROM {t} WHERE {other}; INSERT INTO {t} SELECT * FROM snap_{t} WHERE {other};")).unwrap();
    }
}

/// Three passes from the state now: the baseline's, then, from the same
/// state, this pass's. The runs after each pass and the mail it sent are the
/// same. Returns the runs after each of this pass's, and the mail it sent.
fn same_passes(s: &Store, case: &str) -> Vec<(Vec<Value>, Vec<Value>)> {
    snapshot(s);
    let pass = |s: &Store, f: &dyn Fn(&Store)| {
        let from = mails(s).len();
        f(s);
        (states(s), sent(s, from))
    };
    let before: Vec<_> = (0..3).map(|_| pass(s, &baseline)).collect();
    restore(s, &[], &[]);
    let now: Vec<_> = (0..3).map(|_| pass(s, &|s: &Store| { s.advance_runs().unwrap(); })).collect();
    for (n, (was, is)) in before.iter().zip(&now).enumerate() {
        assert_eq!(is.0, was.0, "{case}: the runs after pass {}", n + 1);
        assert_eq!(is.1, was.1, "{case}: the mail of pass {}", n + 1);
    }
    now
}

/// The lead's case for this change: D waits for U1 and U2, which both end in
/// the same pass (their stages succeeded; the runs not advanced yet). The
/// baseline reads D first (the newest) and again after each of them; read
/// once, D must still be read after both, and released in that pass.
#[test]
fn two_runs_that_end_in_the_same_pass_release_the_run_waiting_for_both_in_that_pass() {
    let (_dir, s) = setup();
    let u1 = first(&s, "u1", json!([stage("prep", &[])]));
    let u2 = first(&s, "u2", json!([stage("prep", &[])]));
    let d = after(&s, "d", json!([stage("train", &[]), stage("eval", &["train"])]), json!([{"runId":u1["id"]},{"runId":u2["id"]}]));
    after(&s, "d2", json!([stage("report", &[])]), json!([{"runId":d["id"]}]));
    snapshot(&s);
    for _ in 0..2 {
        let job = start(&s);
        assert!(success(&s, &job, "aaa"));
    }
    assert_eq!(latest(&s, &d, "train")["status"], "queued", "their own events release D");
    restore(&s, &[], &[id(&u1), id(&u2)]);
    let undone = states(&s);
    assert!(!named(&undone, "u1")["settled"].as_bool().unwrap() && !named(&undone, "u2")["settled"].as_bool().unwrap());
    assert_eq!(named(&undone, "d")["stages"][0]["status"], "waiting");
    let passes = same_passes(&s, "two upstream runs");
    let first = &passes[0].0;
    assert!(named(first, "u1")["settled"].as_bool().unwrap() && named(first, "u2")["settled"].as_bool().unwrap());
    assert_eq!(named(first, "d")["stages"][0]["status"], "queued", "D released in the pass both ended");
    assert_eq!(named(first, "d2")["stages"][0]["status"], "waiting", "D2 waits for D to succeed");
}

/// U, then D1 (two stages) after U, D2 after D1, F after U and D1 (a
/// diamond), E after U's end (when settled).
fn graph(s: &Store) -> Value {
    let up = first(s, "u", json!([stage("prep", &[])]));
    let d1 = after(s, "d1", json!([stage("train", &[]), stage("eval", &["train"])]), json!([{"runId":up["id"]}]));
    after(s, "d2", json!([stage("report", &[])]), json!([{"runId":d1["id"]}]));
    after(s, "f", json!([stage("merge", &[])]), json!([{"runId":up["id"]},{"runId":d1["id"]}]));
    after(s, "e", json!([stage("gpu", &[])]), json!([{"runId":up["id"],"when":"settled"}]));
    up
}

/// `event` on U through the real code, then undone but for U's own rows:
/// the passes carry it on to the runs waiting for U as the event did, and as
/// the baseline's passes do.
fn carried(case: &str, prepare: impl Fn(&Store), event: impl Fn(&Store, &Value)) {
    let (_dir, s) = setup();
    let up = graph(&s);
    prepare(&s);
    snapshot(&s);
    let from = mails(&s).len();
    event(&s, &up);
    let by_event = states(&s);
    // Of the runs waiting for U: U's own mail went with its rows, kept.
    let waiting = |mail: Vec<Value>| {
        let mut mail: Vec<String> = mail.into_iter().filter(|m| m[1] != up["id"]).map(|m| m.to_string()).collect();
        mail.sort();
        mail
    };
    let told = waiting(sent(&s, from));
    restore(&s, &[id(&up)], &[]);
    let passes = same_passes(&s, case);
    assert_eq!(passes[0].0, by_event, "{case}: the first pass leaves every run as the event did");
    assert_eq!(waiting(passes[0].1.clone()), told, "{case}: the first pass tells the runs waiting for U as the event did");
}

#[test]
fn a_success_is_carried_on_by_the_pass() {
    carried("success", |_| {}, |s, _| {
        let job = start(s);
        assert!(success(s, &job, "aaa"));
    });
}

#[test]
fn a_failure_is_carried_on_by_the_pass() {
    carried("failure", |_| {}, |s, _| {
        let job = start(s);
        assert!(finish(s, &job, "failed", exit("1"), json!({})));
    });
}

#[test]
fn a_cancellation_is_carried_on_by_the_pass() {
    carried("cancellation", |_| {}, |s, up| {
        s.request_run_cancel(Some("a"), id(up)).unwrap();
    });
}

#[test]
fn a_retry_is_carried_on_by_the_pass() {
    carried("retry", |s| {
        let job = start(s);
        assert!(finish(s, &job, "failed", exit("1"), json!({})));
    }, |s, up| {
        s.retry_stage(Some("a"), "again", id(up), "prep").unwrap();
    });
}

/// The pass covers the 64 newest runs in flight and the runs waiting for
/// them, as before: U0, the oldest, has its stage succeeded but is not
/// advanced yet; D0 waits for it; DI waits for U3 and is held (U3 failed,
/// so DI is idle and not in flight), and U3 was retried. With 62 more runs
/// in flight U0 is the 65th and left to its own events; with 61 it is the
/// 64th and ends in the first pass. DI, reached only through U3, is freed.
#[test]
fn the_pass_covers_the_64_newest_runs_in_flight_and_the_runs_waiting_for_them_as_before() {
    for others in [62, 61] {
        let (_dir, s) = setup();
        let u0 = first(&s, "u0", json!([stage("prep", &[])]));
        let d0 = after(&s, "d0", json!([stage("train", &[])]), json!([{"runId":u0["id"]}]));
        let u3 = first(&s, "u3", json!([stage("prep", &[])]));
        let di = after(&s, "di", json!([stage("train", &[])]), json!([{"runId":u3["id"]}]));
        for i in 0..others {
            first(&s, &format!("other-{i}"), json!([stage("x", &[])]));
        }
        // U0's stage succeeds, its propagation undone.
        snapshot(&s);
        let job = start(&s);
        assert_eq!(job["run"]["id"], u0["id"]);
        assert!(success(&s, &job, "aaa"));
        restore(&s, &[], &[id(&u0)]);
        assert_eq!(latest(&s, &d0, "train")["status"], "waiting");
        // U3 fails (DI held), then is retried, that propagation undone.
        let job = start(&s);
        assert_eq!(job["run"]["id"], u3["id"]);
        assert!(finish(&s, &job, "failed", exit("1"), json!({})));
        assert!(s.run(id(&di)).unwrap()["idleAt"].is_string());
        snapshot(&s);
        s.retry_stage(Some("a"), "again", id(&u3), "prep").unwrap();
        restore(&s, &[id(&u3), id(&u0)], &[]);
        assert!(s.run(id(&di)).unwrap()["idleAt"].is_string(), "DI held again");
        let passes = same_passes(&s, &format!("{others} more runs in flight"));
        let first = &passes[0].0;
        let inside = others == 61;
        assert_eq!(named(first, "u0")["settled"].as_bool().unwrap(), inside, "U0 ends in the pass only within the 64");
        assert_eq!(named(first, "d0")["stages"][0]["status"], if inside { "queued" } else { "waiting" });
        assert!(!named(first, "di")["idle"].as_bool().unwrap(), "DI freed through U3");
        assert_eq!(named(first, "di")["status"], "waiting");
    }
}

/// The field's shape on 2026-11-26 (YN-221 w2): 320 runs, 267 settled, 35
/// failed and idle, and 18 in flight linked as there. What one pass costs,
/// the baseline's and this one's, on this thread. A measurement:
/// cargo test --release advance_runs_cost -- --ignored --nocapture
#[test]
#[ignore = "a measurement"]
fn advance_runs_cost() {
    let (_dir, s) = setup();
    let make = |name: &str, stages: usize, after_runs: Vec<Value>| -> String {
        let stages: Vec<Value> = (0..stages)
            .map(|i| { let needs: Vec<String> = if i == 0 { vec![] } else { vec![format!("s{}", i - 1)] }; stage(&format!("s{i}"), &needs.iter().map(String::as_str).collect::<Vec<_>>()) })
            .collect();
        id(&after(&s, name, json!(stages), json!(after_runs))).to_owned()
    };
    for i in 0..302 {
        let run = make(&format!("hist-{i}"), [1, 3, 5, 7, 9][i % 5], vec![]);
        let (field, ended) = if i < 267 { ("$.settledAt", "succeeded") } else { ("$.idleAt", "failed") };
        let db = s.db.write().unwrap();
        db.execute(&format!("UPDATE local_job_runs SET data=json_set(data,'{field}','2026-11-20T00:00:00Z') WHERE id=?1"), [&run]).unwrap();
        db.execute("UPDATE local_jobs SET status=?2, data=json_set(data,'$.status',?2) WHERE json_extract(data,'$.run.id')=?1",
            rusqlite::params![run, ended]).unwrap();
    }
    let shape: [(&str, usize, &[&str]); 18] = [
        ("fcca", 5, &[]), ("b319", 7, &[]), ("4fc6", 9, &[]), ("8541", 4, &[]), ("7ce7", 12, &[]), ("4fd6", 16, &[]), ("b1c1", 8, &[]),
        ("10bc", 1, &["b319", "fcca"]), ("7560", 4, &["4fc6"]), ("2089", 12, &["7560"]), ("52f0", 7, &["2089", "b319", "fcca"]),
        ("80b3", 4, &["8541"]), ("8fa6", 8, &["80b3"]), ("11c9", 16, &["4fd6"]), ("804a", 4, &["7ce7", "11c9"]), ("fd74", 1, &["804a"]),
        ("3ac8", 4, &["7ce7", "4fd6"]), ("9b43", 1, &["3ac8"]),
    ];
    let mut ids: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    for (name, stages, waits) in shape {
        let run = make(name, stages, waits.iter().map(|w| json!({"runId": ids[w]})).collect());
        ids.insert(name, run);
    }
    let cpu = |f: &dyn Fn()| {
        f();
        let n = 10;
        let start = crate::runtime_diag::thread_cpu_ns().unwrap();
        for _ in 0..n {
            f();
        }
        (crate::runtime_diag::thread_cpu_ns().unwrap() - start) as f64 / 1e6 / n as f64
    };
    let before = cpu(&|| baseline(&s));
    let now = cpu(&|| { s.advance_runs().unwrap(); });
    println!("{}", json!({"runs": 320, "inFlight": 18, "baselineMs": (before * 100.0).round() / 100.0, "onceMs": (now * 100.0).round() / 100.0}));
}
