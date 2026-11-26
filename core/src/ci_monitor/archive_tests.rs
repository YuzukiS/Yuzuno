//! R-39: the rolling CI history archive, on an old Workspace's history at
//! both former limits (2000 subscriptions, 10000 attempts).
use super::limits::{finish, mails_of, old_history, old_request, old_run, old_sub, target, task_id};
use super::*;
use rusqlite::params;

const DAY: i64 = 86400;

fn count(s: &Store, sql: &str) -> i64 {
    s.db.read().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}
/// One sweep of every watch at `now`, pass by pass.
fn sweep(s: &Store, now: i64) -> Vec<archive::Pass> {
    let mut passes = Vec::new();
    let mut after = 0;
    loop {
        let pass = s.ci_archive_pass(after, now).unwrap();
        let next = pass.next;
        passes.push(pass);
        match next {
            Some(next) => after = next,
            None => return passes,
        }
    }
}
fn moved(passes: &[archive::Pass]) -> usize {
    passes.iter().map(|p| p.watches).sum()
}
fn repo() -> crate::github::client::Repository {
    crate::github::client::Repository { id: 123, full_name: "o/r".into() }
}
/// Every run of task T-1, paged as ci_list pages them.
fn all_runs(s: &Store) -> Vec<Value> {
    let (mut runs, mut before) = (Vec::new(), None);
    loop {
        let page = s.ci_list(None, Some("T-1"), before).unwrap();
        runs.extend(page["runs"].as_array().unwrap().iter().cloned());
        if page["hasMore"] != true {
            return runs;
        }
        before = page["nextBefore"].as_i64();
    }
}

#[test]
fn an_old_full_history_rolls_into_the_archive_and_every_record_reads_back() {
    let (dir, s) = setup();
    let task = task_id(&s, "T-1");
    let now = chrono::Utc::now().timestamp();
    old_history(&s, &task, 2000, 10000, now - 30 * DAY);
    {
        let db = s.db.write().unwrap();
        // The last ten ended yesterday, and entry 5 has a mail still to deliver.
        for i in 1990..2000 {
            db.execute("UPDATE ci_subscriptions SET data=json_set(data,'$.closure.at',?2) WHERE id=?1",
                params![old_sub(i), super::stamp(now - DAY)]).unwrap();
        }
        db.execute("UPDATE collaboration_messages SET delivery_state='pending' WHERE id='old-mail-5'", []).unwrap();
    }
    let passes = sweep(&s, now);
    // A pass looks at 100 watches and moves whole ones (five runs each).
    assert_eq!(passes.len(), 21, "{passes:?}");
    assert!(passes.iter().all(|p| p.watches <= 100 && p.runs == 5 * p.watches), "{passes:?}");
    assert_eq!(moved(&passes), 1989);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_subscriptions"), 11);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_subscriptions_archive"), 1989);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_interests_archive"), 1989);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_notifications_archive"), 9945);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_runs"), 55);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_runs_archive"), 9945);
    assert_eq!(moved(&sweep(&s, now)), 0, "nothing moves twice");

    // Every subscription and run still reads, newest first.
    let list = s.ci_list(None, Some("T-1"), None).unwrap();
    let subs = list["subscriptions"].as_array().unwrap();
    assert_eq!((subs.len(), &list["subscriptionsTruncated"]), (200, &json!(true)));
    assert_eq!(subs[0]["id"], old_sub(1999));
    assert_eq!(subs[10]["id"], old_sub(1989));
    assert_eq!((&subs[10]["archived"], &subs[10]["active"]), (&json!(true), &json!(false)));
    assert_eq!(subs[10]["interests"][0]["closure"]["reason"], "expired");
    let runs = all_runs(&s);
    assert_eq!(runs.len(), 10000);
    assert!(runs.windows(2).all(|w| w[0]["cursor"].as_i64() > w[1]["cursor"].as_i64()));
    let key = old_run(0, 0)["id"].as_str().unwrap().to_owned();
    assert_eq!(s.ci_run(&key).unwrap()["runWatched"], false);
    assert_eq!(s.ci_refresh_targets(None, None, Some(&key), 5).unwrap()["watches"], json!([]));
    // An old requestId still answers with its subscription as it was.
    let replay = s.ci_previous(Some("a"), &old_request(0)).unwrap().unwrap();
    assert_eq!((&replay["id"], &replay["active"]), (&json!(old_sub(0)), &json!(false)));
    assert_eq!(replay["watch"]["number"], 1000);
    assert_eq!(s.ci_unsubscribe(Some("a"), &old_sub(0)).unwrap()["active"], false);
    let current = s.collaboration_call(None, "task_get", json!({"taskId":"T-1","view":"current"})).unwrap();
    let delivery = &current["current"]["delivery"];
    assert_eq!(delivery["ciSubscriptionsShown"], "6 newest of 2000");
    assert_eq!(delivery["ciSubscriptions"][0]["subscriptionId"], old_sub(1999));
    assert_eq!(delivery["ciSubscriptions"][0]["latestRun"]["runKey"], old_run(1999, 9999)["id"]);

    // After a restart nothing moves again and nothing is mailed again.
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(moved(&sweep(&s, now)), 0);
    assert_eq!(s.ci_run(&key).unwrap()["id"], key);
    // A new subscription comes after every one made before, archived ones too.
    let new = target(&s, 1).unwrap();
    assert_eq!(s.ci_list(None, Some("T-1"), None).unwrap()["subscriptions"][0]["id"], new["id"]);

    // Subscribing again to an archived watch brings it back whole, in its
    // place: its receipts keep each completion to the one mail it had.
    let mut again = old_request(7);
    again.request_id = "again-7".into();
    let back = s.ci_subscribe(Some("a"), again, repo(), "pull", 1007).unwrap();
    assert_eq!((&back["id"], &back["active"], &back["archived"]), (&json!(old_sub(7)), &json!(true), &Value::Null));
    for j in (7..10000).step_by(2000) {
        assert_eq!(mails_of(&s, old_run(7, j)["id"].as_str().unwrap()), 1, "run {j}");
    }
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_subscriptions_archive"), 1988);
    let order: i64 = count(&s, &format!("SELECT rowid FROM ci_subscriptions WHERE id='{}'", old_sub(7)));
    assert_eq!(order, 8, "it keeps its place among all subscriptions");
    // Another Agent on another archived watch is mailed each finished run
    // once, as a new subscriber always was.
    let mut other = old_request(8);
    other.request_id = "b-8".into();
    s.ci_subscribe(Some("b"), other, repo(), "pull", 1008).unwrap();
    for j in (8..10000).step_by(2000) {
        assert_eq!(mails_of(&s, old_run(8, j)["id"].as_str().unwrap()), 2, "run {j}");
    }
    // A live watch that sees an archived run takes it back: never in both.
    let run = old_run(9, 9);
    let rid = run["id"].as_str().unwrap().to_owned();
    let mut watch_run = input("run-9");
    watch_run.url = "https://github.com/o/r/actions/runs/5000009".into();
    watch_run.expected_sha = run["headSha"].as_str().unwrap().into();
    let sub = s.ci_subscribe(Some("a"), watch_run, repo(), "run", 5_000_009).unwrap();
    s.ci_observe(sub["watchId"].as_str().unwrap(), Ok(seen(vec![run.clone()], None))).unwrap();
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM ci_runs WHERE id='{rid}'")), 1);
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM ci_runs_archive WHERE id='{rid}'")), 0);
    assert_eq!(mails_of(&s, &rid), 2, "its old mail and the new subscription's");
    assert_eq!(s.ci_run(&rid).unwrap()["runWatched"], true);
    // A new attempt is its own mail, and the same completion again is none.
    finish(&s, 1);
    finish(&s, 1);
    assert_eq!(mails_of(&s, "github:123:1:1"), 1);
    assert_eq!(all_runs(&s).len(), 10001);
}

/// A run another, live watch links stays in the main table when its archived
/// watch moves; the archived watch still lists it.
#[test]
fn a_shared_run_stays_while_a_live_watch_links_it() {
    let (_dir, s) = setup();
    let task = task_id(&s, "T-1");
    let now = chrono::Utc::now().timestamp();
    old_history(&s, &task, 2, 2, now - 30 * DAY);
    let run = old_run(0, 0);
    let mut watch_run = input("run-0");
    watch_run.url = "https://github.com/o/r/actions/runs/5000000".into();
    watch_run.expected_sha = run["headSha"].as_str().unwrap().into();
    let sub = s.ci_subscribe(Some("b"), watch_run, repo(), "run", 5_000_000).unwrap();
    s.ci_observe(sub["watchId"].as_str().unwrap(), Ok(seen(vec![run.clone()], None))).unwrap();
    assert_eq!(moved(&sweep(&s, now)), 2);
    let rid = run["id"].as_str().unwrap();
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM ci_runs WHERE id='{rid}'")), 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_runs_archive"), 1);
    let old = s.ci_previous(Some("a"), &old_request(0)).unwrap().unwrap();
    assert_eq!(old["archived"], true);
    let runs = all_runs(&s);
    assert_eq!(runs.len(), 2);
    assert_eq!(runs.iter().find(|r| r["id"] == rid).unwrap()["runWatched"], true);
    // The live watch ends and its mail was delivered; a week on, the run
    // follows its watches.
    s.db.write().unwrap().execute("UPDATE collaboration_messages SET delivery_state='delivered'", []).unwrap();
    s.ci_unsubscribe(Some("b"), sub["id"].as_str().unwrap()).unwrap();
    assert_eq!(moved(&sweep(&s, now + archive::KEEP_SECONDS)), 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_runs"), 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_runs_archive"), 2);
    assert_eq!(all_runs(&s).len(), 2);
}

/// A pass moves whole watches until it moved 1010 runs, the most one
/// observation writes; the rest of its page waits for the next pass.
#[test]
fn a_pass_stops_once_it_moved_1010_runs() {
    let (_dir, s) = setup();
    let task = task_id(&s, "T-1");
    let now = chrono::Utc::now().timestamp();
    old_history(&s, &task, 20, 2500, now - 30 * DAY);
    let passes = sweep(&s, now);
    let shape: Vec<(usize, usize)> = passes.iter().map(|p| (p.watches, p.runs)).collect();
    assert_eq!(shape, vec![(9, 1125), (9, 1125), (2, 250)]);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM ci_runs_archive"), 2500);
    assert_eq!(all_runs(&s).len(), 2500);
}
