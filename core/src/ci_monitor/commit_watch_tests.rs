//! A commit watch: an exact commit, branch and event, subscribed before any
//! of its runs exists (for example a merge commit on main, for push).
use super::*;

const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_URL: &str = "https://github.com/o/r/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WATCH: &str = "123:commit:push:main:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// GitHub as a phase: the runs listed for the commit, plus runs GitHub's
/// filters should have left out (as if they were ignored), which the watch
/// must exclude itself.
fn commit_lab(dir: &std::path::Path) -> Arc<Workspace> {
    let ws = lab(dir);
    std::fs::write(dir.join("gh-fixture"), r##"#!/usr/bin/python3
import json,sys,pathlib,time
root=pathlib.Path(__file__).parent
phase=(root/'phase').read_text()
ep=next(v for v in sys.argv if v.startswith(('repos/','repositories/')))
with (root/'requests').open('a') as f:f.write(ep+'\n')
if phase=='rate':
 print('HTTP/2.0 429 Too Many Requests\r\nRetry-After: 600\r\n\r\n');print('HTTP 429 rate limit',file=sys.stderr);sys.exit(1)
if phase=='offline':
 print('HTTP/2.0 503 Service Unavailable\r\n\r\n');print('HTTP 503',file=sys.stderr);sys.exit(1)
A='a'*40
if phase=='nocommit' and '/git/commits/' in ep:
 print('HTTP/2.0 404 Not Found\r\n\r\n');print('HTTP 404 Not Found',file=sys.stderr);sys.exit(1)
etag='"'+phase+'-'+ep+'"'
if 'If-None-Match: '+etag in sys.argv:
 print('HTTP/2.0 304 Not Modified\r\nEtag: '+etag+'\r\n\r\n');sys.exit(0)
old='2026-10-15T00:00:00Z'
recent=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
def run(i,attempt,status,conclusion,name='CI',event='push',branch='main',sha=A,head=123,updated=old):
 return {'id':i,'run_attempt':attempt,'head_sha':sha,'name':name,'event':event,'head_branch':branch,'repository':{'id':123},'head_repository':{'id':head},'status':status,'conclusion':conclusion,'created_at':old,'updated_at':updated}
decoys=[run(50,1,'completed','success',event='pull_request'),run(51,1,'completed','success',branch='feature'),run(52,1,'completed','success',head=999),run(53,1,'completed','success',sha='b'*40)]
lists={
 'none':[],
 'appear':[run(42,1,'in_progress',None)]+decoys,
 'done1':[run(42,1,'completed','success'),run(44,1,'in_progress',None,name='Docs')]+decoys,
 'rerun':[run(42,2,'in_progress',None),run(44,1,'completed','success',name='Docs')],
 'alldone':[run(42,2,'completed','failure'),run(44,1,'completed','success',name='Docs')],
 'alldone-recent':[run(42,2,'completed','failure',updated=recent),run(44,1,'completed','success',name='Docs',updated=recent)],
}
if ep in ('repositories/123','repos/o/r'):data={'id':123,'full_name':'o/r'}
elif ep=='repos/o/r/git/commits/'+A:data={'sha':A,'tree':{'sha':'c'*40},'parents':[]}
elif ep=='repos/o/r/actions/runs/42/attempts/1':data=run(42,1,'completed','success')
elif ep=='repos/o/r/actions/runs?head_sha='+A+'&branch=main&event=push&per_page=100&page=1':
 data={'total_count':len(lists[phase]),'workflow_runs':lists[phase]}
else:raise Exception('Unexpected endpoint: '+ep)
print('HTTP/2.0 200 OK\r\nEtag: '+etag+'\r\n\r\n'+json.dumps(data))
"##).unwrap();
    std::fs::write(dir.join("phase"), "none").unwrap();
    ws
}
/// Makes the watch due now, as the monitor's own schedule would later.
fn due_now(ws: &Workspace) {
    ws.store
        .db
        .write()
        .unwrap()
        .execute("UPDATE ci_watches SET next_poll=0", [])
        .unwrap();
}
fn phase(dir: &std::path::Path, p: &str) {
    std::fs::write(dir.join("phase"), p).unwrap();
}
fn commit_input(request: &str) -> Value {
    json!({"requestId":request,"taskId":"T-1","agentId":"a","url":COMMIT_URL,"expectedSha":A,"branch":"main","event":"push"})
}
fn store_input(request: &str) -> Subscribe {
    let mut q = input(request);
    q.url = COMMIT_URL.into();
    q.expected_sha = A.into();
    q.branch = Some("main".into());
    q.event = Some("push".into());
    q
}
fn subscribe_commit(s: &Store, request: &str) -> Value {
    s.ci_subscribe(
        Some("a"),
        store_input(request),
        crate::github::client::Repository {
            id: 123,
            full_name: "o/r".into(),
        },
        "commit",
        0,
    )
    .unwrap()
}
fn commit_run(id: u64, attempt: u64, status: &str, conclusion: Value) -> Value {
    client::run(
        &json!({"id":id,"run_attempt":attempt,"head_sha":A,"name":"CI","event":"push","head_branch":"main","repository":{"id":123},"head_repository":{"id":123},"status":status,"conclusion":conclusion,"created_at":"2026-10-15T00:00:00Z","updated_at":"2026-10-15T00:00:00Z"}),
        123,
        "o/r",
    )
    .unwrap()
}
fn watch_row(ws: &Workspace) -> Value {
    let raw: String = ws
        .store
        .db
        .read()
        .unwrap()
        .query_row("SELECT data FROM ci_watches WHERE id=?1", [WATCH], |r| {
            r.get(0)
        })
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}
fn runs_stored(s: &Store) -> Vec<String> {
    let db = s.db.read().unwrap();
    let mut q = db.prepare("SELECT id FROM ci_runs ORDER BY id").unwrap();
    q.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap()
}
fn interest_closures(s: &Store) -> Vec<(String, bool, Value)> {
    let db = s.db.read().unwrap();
    let mut q = db
        .prepare("SELECT s.watch_id,i.active,i.data FROM ci_interests i JOIN ci_subscriptions s ON s.id=i.subscription_id ORDER BY i.rowid")
        .unwrap();
    q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, bool>(1)?,
            r.get::<_, String>(2)?,
        ))
    })
    .unwrap()
    .map(|r| {
        let (w, a, d) = r.unwrap();
        (
            w,
            a,
            serde_json::from_str::<Value>(&d).unwrap()["closure"].clone(),
        )
    })
    .collect()
}
fn ci_mail(s: &Store) -> Vec<Value> {
    mail(s, "a")
        .into_iter()
        .filter(|m| m["metadata"]["kind"] == "ci")
        .collect()
}

#[tokio::test]
async fn commit_watch_subscribes_with_no_run_and_refuses_unclear_targets() {
    let (dir, s) = setup();
    drop(s);
    let ws = commit_lab(dir.path());
    // The target is explicit: branch and event are required for a commit URL,
    // must be exact names, and never apply to a PR or run URL.
    for (change, problem) in [
        (json!({"branch":null}), "needs branch"),
        (json!({"event":null}), "needs event"),
        (json!({"branch":"main branch"}), "exact branch name"),
        (json!({"event":"Push"}), "exact GitHub event"),
        (
            json!({"expectedSha":"b".repeat(40)}),
            "the commit the URL names",
        ),
        (
            json!({"url":"https://github.com/o/r/commit/abc"}),
            "full 40-character",
        ),
        (
            json!({"url":"https://github.com/o/r/pull/7","expectedSha":A}),
            "only to a commit URL",
        ),
        // A commit URL in exactly one form: no path or spelling ambiguity.
        (
            json!({"url":format!("https://github.com/o/r.git/commit/{A}")}),
            "exactly the form",
        ),
        (
            json!({"url":format!("https://github.com/o/r//commit/{A}")}),
            "exactly the form",
        ),
        (
            json!({"url":format!("https://github.com/o/r/commit/{A}/")}),
            "exactly the form",
        ),
        (
            json!({"url":format!("https://github.com/o/r/tree/x/commit/{A}")}),
            "exactly the form",
        ),
        (
            json!({"url":format!("https://github.com/o/r/commit/{A}?diff=split")}),
            "full 40-character",
        ),
        (
            json!({"url":format!("https://github.com/o/r/commit/{A}#top")}),
            "full 40-character",
        ),
        (
            json!({"url":format!("https://github.com/o r/r/commit/{A}")}),
            "Invalid GitHub owner/repository",
        ),
        (
            json!({"url":format!("http://github.com/o/r/commit/{A}")}),
            "exactly the form",
        ),
        (
            json!({"url":format!("https://github.com/{}/r/commit/{A}", "o".repeat(240))}),
            "exactly the form",
        ),
        (json!({"branch":"main/"}), "exact branch name"),
        (json!({"branch":"../main"}), "exact branch name"),
        (json!({"branch":"a".repeat(201)}), "exact branch name"),
        (json!({"event":"push\n"}), "exact GitHub event"),
    ] {
        let mut q = commit_input("bad");
        for (k, v) in change.as_object().unwrap() {
            if v.is_null() {
                q.as_object_mut().unwrap().remove(k);
            } else {
                q[k] = v.clone();
            }
        }
        let e = ask(&ws, "ci_subscribe", q).await.unwrap_err().to_string();
        assert!(e.contains(problem), "{change}: {e}");
    }
    assert!(
        requests(dir.path()).is_empty(),
        "refused before any GitHub read"
    );
    // A commit that is not in the repository is refused.
    phase(dir.path(), "nocommit");
    assert!(
        ask(&ws, "ci_subscribe", commit_input("missing"))
            .await
            .is_err()
    );
    // With no run yet, the watch is persisted and waits for runs to appear.
    phase(dir.path(), "none");
    let sub = ask(&ws, "ci_subscribe", commit_input("main-push"))
        .await
        .unwrap();
    assert_eq!(sub["active"], true, "{sub}");
    assert_eq!(sub["watchId"], WATCH);
    assert_eq!(sub["watch"]["kind"], "commit");
    assert_eq!(sub["watch"]["state"], "waiting_for_run");
    assert_eq!(sub["watch"]["branch"], "main");
    assert_eq!(sub["watch"]["event"], "push");
    assert_eq!(sub["watch"]["expectedSha"], A);
    assert_eq!(
        requests(dir.path()).last().unwrap(),
        &format!("repos/o/r/git/commits/{A}"),
        "only the commit object is read to subscribe, not its runs"
    );
    // A lost reply's retry returns the same subscription, with no GitHub
    // read, mail or second interest; the same requestId for another target
    // is a conflict.
    let asked = requests(dir.path()).len();
    let again = ask(&ws, "ci_subscribe", commit_input("main-push"))
        .await
        .unwrap();
    assert_eq!(again["id"], sub["id"]);
    assert_eq!(requests(dir.path()).len(), asked);
    assert_eq!(again["interests"].as_array().unwrap().len(), 1);
    let mut other = commit_input("main-push");
    other["branch"] = json!("release/1.0");
    let e = ask(&ws, "ci_subscribe", other)
        .await
        .unwrap_err()
        .to_string();
    assert!(e.contains("idempotency_conflict"), "{e}");
    // A PR or run receipt from before this change still replays: absent
    // branch/event fields keep its stored input identical.
    assert_eq!(
        serde_json::to_value(input("old")).unwrap(),
        json!({"requestId":"old","taskId":"T-1","agentId":null,"url":"https://github.com/o/r/pull/7","expectedSha":"a".repeat(40)})
    );
}

#[test]
fn a_receipt_written_before_commit_watches_replays_without_a_conflict() {
    let (_dir, s) = setup();
    let old = subscribe(&s, "a", "before-t144");
    // The receipt exactly as the previous release stored it: no branch or
    // event key at all.
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE collaboration_requests SET input_json=?1 WHERE request_id='before-t144'",
            [format!(
                r#"{{"requestId":"before-t144","taskId":"T-1","agentId":null,"url":"https://github.com/o/r/pull/7","expectedSha":"{}"}}"#,
                "a".repeat(40)
            )],
        )
        .unwrap();
    let again = subscribe(&s, "a", "before-t144");
    assert_eq!(again["id"], old["id"]);
    assert_eq!(
        again["interests"].as_array().unwrap().len(),
        1,
        "a replay, not a renewal"
    );
    // The old watch's data, without the new fields, still reads and lists.
    assert!(again["watch"]["branch"].is_null());
    assert_eq!(
        s.ci_list(Some("a"), None, None).unwrap()["subscriptions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn commit_watch_finds_late_runs_of_its_target_only_and_mails_each_attempt_once() {
    let (dir, s) = setup();
    drop(s);
    let ws = commit_lab(dir.path());
    ask(&ws, "ci_subscribe", commit_input("main-push"))
        .await
        .unwrap();
    // No run yet: waiting, read again in 30 s, no mail.
    assert!(tick(&ws).await.unwrap());
    let w = watch_row(&ws);
    assert_eq!(w["state"], "waiting_for_run", "{w}");
    assert!(w["error"].is_null());
    assert!((29..=31).contains(&next_poll(&ws, WATCH)));
    assert!(ci_mail(&ws.store).is_empty());
    assert_eq!(
        requests(dir.path()).last().unwrap(),
        &format!("repos/o/r/actions/runs?head_sha={A}&branch=main&event=push&per_page=100&page=1")
    );
    // The run appears later. A same-commit PR run, another branch's run, a
    // fork's run and another commit's run are listed too, and left out.
    phase(dir.path(), "appear");
    age(&ws, 60);
    due_now(&ws);
    assert!(tick(&ws).await.unwrap());
    let w = watch_row(&ws);
    assert_eq!(w["state"], "watching", "{w}");
    assert_eq!(w["excludedRuns"], 4);
    assert_eq!(runs_stored(&ws.store), vec!["github:123:42:1"]);
    assert!(ci_mail(&ws.store).is_empty(), "still running");
    // Two workflows and a rerun: each finished attempt mails once.
    for (p, mails) in [("done1", 1), ("rerun", 2), ("alldone", 3), ("alldone", 3)] {
        phase(dir.path(), p);
        age(&ws, 60);
        due_now(&ws);
        assert!(tick(&ws).await.unwrap());
        assert_eq!(ci_mail(&ws.store).len(), mails, "after {p}");
    }
    assert_eq!(
        runs_stored(&ws.store),
        vec!["github:123:42:1", "github:123:42:2", "github:123:44:1"]
    );
    let mails = ci_mail(&ws.store);
    let names: Vec<_> = mails
        .iter()
        .map(|m| m["metadata"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["main push · CI", "main push · Docs", "main push · CI"]
    );
    assert_eq!(mails[2]["metadata"]["attempt"], "2");
    assert_eq!(mails[2]["metadata"]["conclusion"], "failure");
    assert_eq!(mails[0]["metadata"]["branch"], "main");
    assert_eq!(mails[0]["metadata"]["event"], "push");
    assert!(mails.iter().all(|m| m["metadata"]["expectedSha"] == A));
    // A restart keeps the watch and its mail receipts: nothing is sent again.
    drop(ws);
    let ws = commit_lab(dir.path());
    phase(dir.path(), "alldone");
    age(&ws, 600);
    due_now(&ws);
    assert!(tick(&ws).await.unwrap());
    assert_eq!(ci_mail(&ws.store).len(), 3);
    assert_eq!(watch_row(&ws)["state"], "watching");
}

#[tokio::test]
async fn commit_watch_failures_and_rate_limits_are_not_waiting_or_success() {
    let (dir, s) = setup();
    drop(s);
    let ws = commit_lab(dir.path());
    ask(&ws, "ci_subscribe", commit_input("main-push"))
        .await
        .unwrap();
    phase(dir.path(), "offline");
    assert!(tick(&ws).await.unwrap());
    let w = watch_row(&ws);
    assert_eq!(w["state"], "retrying", "{w}");
    assert!(
        w["error"].as_str().unwrap().starts_with("unavailable:"),
        "{w}"
    );
    // Rate limited: the shared cooldown holds every read, the error stays.
    phase(dir.path(), "rate");
    due_now(&ws);
    assert!(tick(&ws).await.unwrap());
    let w = watch_row(&ws);
    assert_eq!(w["state"], "retrying");
    assert!(ws.store.ci_cooldown_until().unwrap() > chrono::Utc::now().timestamp());
    assert!(
        ws.store.ci_due().unwrap().is_none(),
        "nothing is read during the cooldown"
    );
    assert!(ci_mail(&ws.store).is_empty());
    // After the cooldown, a good read clears the error and waits again.
    phase(dir.path(), "none");
    {
        let db = ws.store.db.write().unwrap();
        db.execute("UPDATE ci_control SET cooldown=0", []).unwrap();
        db.execute("UPDATE ci_watches SET next_poll=0", []).unwrap();
    }
    assert!(tick(&ws).await.unwrap());
    let w = watch_row(&ws);
    assert_eq!(w["state"], "waiting_for_run", "{w}");
    assert!(w["error"].is_null());
    assert_eq!(failures(&ws), 0);
}

#[test]
fn commit_watch_reads_less_often_while_no_run_appears() {
    let (_dir, s) = setup();
    subscribe_commit(&s, "main-push");
    let since = |s: &Store, age: i64| {
        let at = (chrono::Utc::now() - chrono::Duration::seconds(age)).to_rfc3339();
        let db = s.db.write().unwrap();
        db.execute(
            "UPDATE ci_watches SET data=json_set(data,'$.createdAt',?1)",
            [&at],
        )
        .unwrap();
        db.execute(
            "UPDATE ci_interests SET data=json_set(data,'$.openedAt',?1)",
            [&at],
        )
        .unwrap();
    };
    let wait = |s: &Store| {
        let due: i64 =
            s.db.read()
                .unwrap()
                .query_row("SELECT next_poll FROM ci_watches", [], |r| r.get(0))
                .unwrap();
        due - chrono::Utc::now().timestamp()
    };
    // A new request renews the fast pace of a watch that waited long.
    since(&s, 2 * 3600);
    subscribe_commit(&s, "renewed");
    s.ci_observe(WATCH, Ok(seen(vec![], None))).unwrap();
    assert!((29..=31).contains(&wait(&s)), "renewed: {}", wait(&s));
    for (age, pace) in [(0, 30), (20 * 60, 120), (2 * 3600, 600)] {
        since(&s, age);
        s.ci_observe(WATCH, Ok(seen(vec![], None))).unwrap();
        let due: i64 =
            s.db.read()
                .unwrap()
                .query_row("SELECT next_poll FROM ci_watches", [], |r| r.get(0))
                .unwrap();
        let wait = due - chrono::Utc::now().timestamp();
        assert!((pace - 1..=pace + 1).contains(&wait), "{age} s old: {wait}");
    }
    // Once a run exists, the usual pace applies.
    s.ci_observe(
        WATCH,
        Ok(seen(
            vec![commit_run(42, 1, "in_progress", Value::Null)],
            None,
        )),
    )
    .unwrap();
    let due: i64 =
        s.db.read()
            .unwrap()
            .query_row("SELECT next_poll FROM ci_watches", [], |r| r.get(0))
            .unwrap();
    assert!((29..=31).contains(&(due - chrono::Utc::now().timestamp())));
}

#[test]
fn commit_watch_outlives_task_closure_and_pr_merge_until_verified_and_settled() {
    let (_dir, s) = setup();
    // A PR candidate of the same task, and the merge commit's watch.
    let pr = subscribe(&s, "a", "candidate");
    let commit = subscribe_commit(&s, "main-push");
    // The PR merges: its candidate interest closes, the commit watch's not.
    let mut merged = seen(vec![], Some("a".repeat(40)));
    merged.pr = Some(json!({"state":"closed","merged":true,"baseSha":"c".repeat(40)}));
    s.ci_observe(pr["watchId"].as_str().unwrap(), Ok(merged))
        .unwrap();
    let closures = interest_closures(&s);
    assert_eq!(closures[0].2["reason"], "pr_merged");
    assert!(closures[1].1, "the commit watch stays: {closures:?}");
    // The task is done while the commit's run still runs: kept.
    s.collaboration_call(
        Some("a"),
        "task_update",
        json!({"requestId":"done","taskId":"T-1","expectedVersion":1,"patch":{"status":"done"}}),
    )
    .unwrap();
    s.ci_observe(
        WATCH,
        Ok(seen(
            vec![commit_run(42, 1, "in_progress", Value::Null)],
            None,
        )),
    )
    .unwrap();
    assert!(interest_closures(&s)[1].1, "a running run keeps it");
    // Finished and mailed. GitHub says it finished days ago, but Yuzuno has
    // only now observed it: kept, and the quiet window starts here.
    let done = |attempt, conclusion: &str| commit_run(42, attempt, "completed", json!(conclusion));
    let kept = |s: &Store, why: &str| assert!(interest_closures(s)[1].1, "{why}");
    // As if the window and the request were 11 minutes old.
    let quiet = |s: &Store, minutes: i64| {
        let at = (chrono::Utc::now() - chrono::Duration::minutes(minutes)).to_rfc3339();
        let db = s.db.write().unwrap();
        db.execute(
            "UPDATE ci_watches SET data=json_set(data,'$.quietSince',?1) WHERE id=?2",
            [&at, WATCH],
        )
        .unwrap();
        db.execute(
            "UPDATE ci_interests SET data=json_set(data,'$.openedAt',?1) WHERE active=1",
            [&at],
        )
        .unwrap();
    };
    let quiet_since = |s: &Store| {
        let raw: String =
            s.db.read()
                .unwrap()
                .query_row("SELECT data FROM ci_watches WHERE id=?1", [WATCH], |r| {
                    r.get(0)
                })
                .unwrap();
        serde_json::from_str::<Value>(&raw).unwrap()["quietSince"].clone()
    };
    // The request was 11 minutes ago; GitHub says the run finished days ago.
    // Yuzuno only now sees it finished: kept, the quiet window starts here.
    quiet(&s, 11);
    s.ci_observe(WATCH, Ok(seen(vec![done(1, "success")], None)))
        .unwrap();
    assert_eq!(ci_mail(&s).len(), 1);
    kept(&s, "GitHub's old finish time does not settle it");
    // A failed read breaks the window; the recovery starts it again.
    quiet(&s, 11);
    s.ci_observe(WATCH, Err("HTTP 503".into())).unwrap();
    assert!(quiet_since(&s).is_null());
    s.ci_observe(WATCH, Ok(seen(vec![done(1, "success")], None)))
        .unwrap();
    kept(&s, "recovered just now");
    // A rerun's new attempt starts it again, and must itself finish and mail.
    quiet(&s, 11);
    s.ci_observe(
        WATCH,
        Ok(seen(
            vec![commit_run(42, 2, "in_progress", Value::Null)],
            None,
        )),
    )
    .unwrap();
    kept(&s, "a new attempt runs");
    s.ci_observe(WATCH, Ok(seen(vec![done(2, "failure")], None)))
        .unwrap();
    assert_eq!(ci_mail(&s).len(), 2);
    kept(&s, "it just finished");
    // A cut run list is never a verification.
    quiet(&s, 11);
    let mut cut = seen(vec![done(2, "failure")], None);
    cut.truncated = true;
    s.ci_observe(WATCH, Ok(cut)).unwrap();
    kept(&s, "the list was cut");
    assert!(quiet_since(&s).is_null());
    s.ci_observe(WATCH, Ok(seen(vec![done(2, "failure")], None)))
        .unwrap();
    kept(&s, "the window starts again after a complete read");
    // The window counts from the request at the earliest: quiet for eleven
    // minutes, but asked for only a minute ago, is not settled yet.
    quiet(&s, 11);
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE ci_interests SET data=json_set(data,'$.openedAt',?1) WHERE active=1",
            [(chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339()],
        )
        .unwrap();
    s.ci_observe(WATCH, Ok(seen(vec![done(2, "failure")], None)))
        .unwrap();
    kept(&s, "asked for only a minute ago");
    // Ten minutes of complete observations that saw nothing new, after the
    // request: verified, closed, with no extra mail.
    quiet(&s, 11);
    s.ci_observe(WATCH, Ok(seen(vec![done(2, "failure")], None)))
        .unwrap();
    let closures = interest_closures(&s);
    assert!(!closures[1].1, "{closures:?}");
    assert_eq!(closures[1].2["reason"], "verification_completed");
    assert_eq!(ci_mail(&s).len(), 2, "no extra mail");
    // A commit can still be subscribed on the done task; a PR candidate not.
    subscribe_commit(&s, "after-merge");
    assert!(commit["id"].is_string());
    let e = s
        .ci_subscribe(
            Some("a"),
            input("late-pr"),
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "pull",
            7,
        )
        .unwrap_err()
        .to_string();
    assert!(e.contains("Reopen the task"), "{e}");
}

#[test]
fn commit_watch_with_no_run_mails_once_at_expiry_and_not_after_a_stop() {
    let (_dir, s) = setup();
    let sub = subscribe_commit(&s, "main-push");
    s.ci_observe(WATCH, Ok(seen(vec![], None))).unwrap();
    let expire = |s: &Store| {
        let db = s.db.write().unwrap();
        db.execute("UPDATE ci_interests SET expires=1", []).unwrap();
        db.execute("UPDATE ci_subscriptions SET expires=1", [])
            .unwrap();
    };
    expire(&s);
    s.ci_flush_notifications().unwrap();
    s.ci_flush_notifications().unwrap();
    let mails = ci_mail(&s);
    assert_eq!(mails.len(), 1, "{mails:?}");
    assert_eq!(mails[0]["metadata"]["status"], "no_run_observed");
    assert_eq!(mails[0]["metadata"]["name"], "main push · no run observed");
    let body = mails[0]["body"].as_str().unwrap();
    assert!(
        body.contains("Yuzuno observed no matching run of commit")
            && body.contains("Its last successful read was at")
            && body.contains("This is not proof that GitHub never had such a run")
            && body.contains("nothing is known to have run or passed")
            && !body.contains("failed"),
        "{body}"
    );
    assert_eq!(interest_closures(&s)[0].2["reason"], "expired");
    // A renewal whose last read failed: a run may exist that it did not see.
    subscribe_commit(&s, "renewed");
    s.ci_observe(WATCH, Err("HTTP 503".into())).unwrap();
    expire(&s);
    s.ci_flush_notifications().unwrap();
    let mails = ci_mail(&s);
    assert_eq!(mails.len(), 2);
    assert_eq!(mails[1]["metadata"]["status"], "unknown");
    let body = mails[1]["body"].as_str().unwrap();
    assert!(
        body.contains("Its last read failed (HTTP 503")
            && body.contains("a run may exist that it did not see"),
        "{body}"
    );
    // Failed reads before a later success are said too.
    subscribe_commit(&s, "renewed-again");
    s.ci_observe(WATCH, Err("rate_limited: cooling down".into()))
        .unwrap();
    s.ci_observe(WATCH, Ok(seen(vec![], None))).unwrap();
    expire(&s);
    s.ci_flush_notifications().unwrap();
    let mails = ci_mail(&s);
    assert_eq!(mails.len(), 3);
    assert_eq!(mails[2]["metadata"]["status"], "no_run_observed");
    let body = mails[2]["body"].as_str().unwrap();
    assert!(
        body.contains("2 reads of this watch failed")
            && body.contains("rate_limited: cooling down")
            && body.contains("later reads succeeded"),
        "{body}"
    );
    // An old requestId's replay neither renews nor mails again.
    subscribe_commit(&s, "renewed-again");
    s.ci_flush_notifications().unwrap();
    assert_eq!(ci_mail(&s).len(), 3);
    // An explicit stop is the Agent's own choice: no mail.
    let stopped = subscribe_commit(&s, "stopped");
    s.ci_unsubscribe(Some("a"), stopped["id"].as_str().unwrap())
        .unwrap();
    s.ci_flush_notifications().unwrap();
    assert_eq!(ci_mail(&s).len(), 3);
    assert_eq!(
        sub["id"], stopped["id"],
        "one subscription per watch, Agent and task"
    );
    let last = interest_closures(&s);
    assert_eq!(last.last().unwrap().2["reason"], "explicit_stop");
}

#[test]
fn commit_watch_waits_for_its_run_in_the_agent_rail_while_monitored_on_schedule() {
    let (_dir, s) = setup();
    subscribe_commit(&s, "main-push");
    s.ci_observe(WATCH, Ok(seen(vec![], None))).unwrap();
    let rail = |s: &Store| s.live_ci_counts().unwrap()["agents"]["a"].clone();
    // Waiting for its first run is no failure and has no deadline: still
    // monitored, with its last successful read.
    let r = rail(&s);
    assert_eq!(
        (
            r["waitingForRun"].clone(),
            r["discovering"].clone(),
            r["check"].clone()
        ),
        (json!(1), json!(0), json!(0)),
        "{r}"
    );
    assert!(r["waitingCheckedAt"].is_string(), "{r}");
    // An hour later, read every ten minutes and still on schedule: waiting.
    let age = |s: &Store, observed: i64, due: i64| {
        let at = |secs: i64| (chrono::Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339();
        s.db.write()
            .unwrap()
            .execute(
                "UPDATE ci_watches SET data=json_set(data,'$.observedAt',?1,'$.nextPollAt',?2)",
                [at(observed), at(due)],
            )
            .unwrap();
        s.db.write()
            .unwrap()
            .execute(
                "UPDATE ci_interests SET data=json_set(data,'$.openedAt',?1)",
                [at(-3600)],
            )
            .unwrap();
    };
    age(&s, -500, 100);
    assert_eq!(rail(&s)["waitingForRun"], 1);
    // Overdue (the monitor has not read when it should have): Check CI.
    age(&s, -1500, -900);
    let r = rail(&s);
    assert_eq!(
        (r["check"].clone(), r.get("waitingForRun").cloned()),
        (json!(1), None),
        "{r}"
    );
    // A failed read: Check CI, not waiting.
    s.ci_observe(WATCH, Err("HTTP 503".into())).unwrap();
    assert_eq!(rail(&s), json!({"running":0,"discovering":0,"check":1}));
    // Recovered: waiting again.
    s.ci_observe(WATCH, Ok(seen(vec![], None))).unwrap();
    assert_eq!(rail(&s)["waitingForRun"], 1);
    // Its run appears: running, and nothing waits for a run any more.
    s.ci_observe(
        WATCH,
        Ok(seen(
            vec![commit_run(42, 1, "in_progress", Value::Null)],
            None,
        )),
    )
    .unwrap();
    assert_eq!(rail(&s), json!({"running":1,"discovering":0,"check":0}));
}

/// Read-only check against real GitHub with the host's `gh` login, run by
/// hand: T144_REAL_COMMIT_URL (a merged commit with finished runs) and
/// T144_REAL_BRANCH / T144_REAL_EVENT name the target; T144_REAL_OUT gets the
/// observation. It subscribes in a scratch workspace, observes once and
/// reads mail there; it never triggers, reruns or cancels anything.
#[tokio::test]
#[ignore]
async fn real_github_commit_watch_read_only() {
    let (Ok(url), Ok(branch), Ok(event)) = (
        std::env::var("T144_REAL_COMMIT_URL"),
        std::env::var("T144_REAL_BRANCH"),
        std::env::var("T144_REAL_EVENT"),
    ) else {
        panic!("set T144_REAL_COMMIT_URL, T144_REAL_BRANCH and T144_REAL_EVENT");
    };
    let sha = url.rsplit('/').next().unwrap().to_ascii_lowercase();
    let (dir, s) = setup();
    drop(s);
    let ws = Workspace::new(dir.path().into(), "/workspace".into(), "unused".into()).unwrap();
    ws.ci.started.set(()).unwrap();
    let sub = ask(
        &ws,
        "ci_subscribe",
        json!({"requestId":"real","taskId":"T-1","agentId":"a","url":url,"expectedSha":sha,"branch":branch,"event":event}),
    )
    .await
    .unwrap();
    let watch = sub["watchId"].as_str().unwrap().to_owned();
    assert_eq!(sub["watch"]["state"], "waiting_for_run");
    assert!(tick(&ws).await.unwrap());
    let w: Value = serde_json::from_str(
        &ws.store
            .db
            .read()
            .unwrap()
            .query_row("SELECT data FROM ci_watches WHERE id=?1", [&watch], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
    )
    .unwrap();
    let runs = ws.store.ci_list(Some("a"), None, None).unwrap()["runs"].clone();
    let mails = ci_mail(&ws.store);
    let out = json!({"subscription":sub,"watch":w,"runs":runs,"mails":mails.iter().map(|m| json!({"body":m["body"],"metadata":m["metadata"]})).collect::<Vec<_>>()});
    if let Ok(path) = std::env::var("T144_REAL_OUT") {
        std::fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    }
    assert!(w["error"].is_null(), "{w}");
    assert_eq!(w["state"], "watching", "{w}");
    let runs = runs.as_array().unwrap();
    assert!(!runs.is_empty());
    for r in runs {
        assert_eq!(r["headSha"], sha.as_str());
        assert_eq!(r["branch"], branch.as_str());
        assert_eq!(r["event"], event.as_str());
    }
    let finished = runs
        .iter()
        .filter(|r| r["rawStatus"] == "completed" && r["conclusion"].is_string())
        .count();
    assert_eq!(mails.len(), finished, "one mail per finished attempt");
}
