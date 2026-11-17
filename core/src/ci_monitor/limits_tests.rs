//! YN-193: the CI monitor's limit of 50 counts only the targets still waiting
//! for something; all live targets are at most 100; an older PR head with
//! nothing of it still running is read every five minutes.
use super::*;

fn sha(n: u64) -> String {
    format!("{n:040x}")
}
fn target(s: &Store, n: u64) -> anyhow::Result<Value> {
    let mut request = input(&format!("w{n}"));
    request.expected_sha = sha(n);
    s.ci_subscribe(Some("a"), request, crate::github::client::Repository { id: 123, full_name: "o/r".into() }, "pull", 7)
}
fn watch_of(n: u64) -> String {
    format!("123:pull:7:{}", sha(n))
}
/// The watch of target `n` saw one finished run of its head.
fn finish(s: &Store, n: u64) {
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
