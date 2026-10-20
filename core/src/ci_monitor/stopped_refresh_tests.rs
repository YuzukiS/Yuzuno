//! Historical observations can be checked without reviving their monitors.
use super::*;

fn exact_lab(dir: &std::path::Path) -> Arc<Workspace> {
    let ws = lab(dir);
    std::fs::write(dir.join("gh-fixture"), r##"#!/usr/bin/python3
import json,sys,pathlib,re
root=pathlib.Path(__file__).parent
phase=(root/'phase').read_text()
ep=next(v for v in sys.argv if v.startswith(('repos/','repositories/')))
with (root/'requests').open('a') as f:f.write(ep+'\n')
if phase in ('denied','rate','auth','missing','offline') and ep!='repositories/123':
 code={'denied':403,'rate':429,'auth':401,'missing':404,'offline':503}[phase]
 extra='Retry-After: 600\r\n' if phase in ('denied','rate') else ''
 print('HTTP/2.0 '+str(code)+' Error\r\n'+extra+'\r\n');print('HTTP '+str(code),file=sys.stderr);sys.exit(1)
etag='"'+phase+'-'+ep+'"'
if 'If-None-Match: '+etag in sys.argv:
 print('HTTP/2.0 304 Not Modified\r\nEtag: '+etag+'\r\n\r\n');sys.exit(0)
run={'id':42,'run_attempt':1,'head_sha':'a'*40,'name':'CI','repository':{'id':123},'status':'completed','conclusion':'cancelled'}
if ep=='repositories/123':data={'id':123,'full_name':'o/r'}
elif ep=='repos/o/r/actions/runs/42/attempts/1':
 data=run
 if phase=='wrong-repository':data['repository']['id']=456
 if phase=='wrong-run':data['id']=43
 if phase=='wrong-attempt':data['run_attempt']=2
 if phase=='wrong-sha':data['head_sha']='b'*40
 if phase=='running':data.update(status='in_progress',conclusion=None)
elif ep=='repos/o/r/actions/runs/42/attempts/1/jobs?per_page=100&page=1':data={'total_count':1,'jobs':[{'id':1,'run_id':42,'run_attempt':1,'head_sha':'a'*40,'name':'Build','status':'completed','conclusion':'cancelled','steps':[]}]}
else:raise Exception('Unexpected endpoint: '+ep)
if phase=='wrong-owner' and ep=='repositories/123':data['id']=456
extra='X-Poll-Interval: 120\r\n' if phase=='interval' or (phase=='steps-interval' and '/jobs?' in ep) else ''
print('HTTP/2.0 200 OK\r\nEtag: '+etag+'\r\n'+extra+'\r\n'+json.dumps(data))
"##).unwrap();
    std::fs::write(dir.join("phase"), "cancelled").unwrap();
    ws
}

// Watch, subscription, link and notification rows must be byte-for-byte
// unchanged by checking an unmonitored run, including a paused schedule.
fn monitor_state(ws: &Workspace) -> Vec<Vec<String>> {
    let db = ws.store.db.read().unwrap();
    [
        "ci_watches",
        "ci_subscriptions",
        "ci_watch_runs",
        "ci_notifications",
    ]
    .into_iter()
    .map(|table| {
        let mut q = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = q.column_count();
        q.query_map([], |row| {
            Ok((0..columns)
                .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                .collect::<Vec<_>>()
                .join("|"))
        })
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap()
    })
    .collect()
}

#[tokio::test]
async fn stopped_old_head_refreshes_exact_attempt_without_touching_new_watch() {
    let (dir, s) = setup();
    let old = subscribe(&s, "a", "old-head");
    observe(
        &s,
        old["watchId"].as_str().unwrap(),
        vec![
            run(1, "in_progress", Value::Null),
            run(2, "in_progress", Value::Null),
        ],
    );
    s.ci_unsubscribe(Some("a"), old["id"].as_str().unwrap())
        .unwrap();
    let mut q = input("new-head");
    q.expected_sha = "b".repeat(40);
    let new = s
        .ci_subscribe(
            Some("a"),
            q,
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "pull",
            7,
        )
        .unwrap();
    let mut b = run(1, "in_progress", Value::Null);
    b["id"] = json!("github:123:43:1");
    b["runId"] = json!("43");
    b["headSha"] = json!("b".repeat(40));
    s.ci_observe(
        new["watchId"].as_str().unwrap(),
        Ok(seen(vec![b.clone()], Some("b".repeat(40)))),
    )
    .unwrap();
    drop(s);
    let ws = exact_lab(dir.path());
    let before = monitor_state(&ws);
    let rerun = ws.store.ci_run("github:123:42:2").unwrap();
    let result = ask(&ws, "ci_refresh", json!({"runKey":"github:123:42:1"}))
        .await
        .unwrap();
    assert_eq!(result["status"], "checked", "{result}");
    assert_eq!(result["runWatched"], false);
    assert_eq!(result["run"]["status"], "cancelled");
    assert_eq!(result["details"][0]["jobs"][0]["status"], "cancelled");
    assert_eq!(
        ws.store.ci_run("github:123:42:1").unwrap()["status"],
        "cancelled"
    );
    assert_eq!(ws.store.ci_run("github:123:42:2").unwrap(), rerun);
    b["runWatched"] = json!(true);
    assert_eq!(ws.store.ci_run("github:123:43:1").unwrap(), b);
    assert_eq!(monitor_state(&ws), before);
    assert!(mail(&ws.store, "a").is_empty());
    assert_eq!(
        requests(dir.path()),
        [
            "repositories/123",
            "repos/o/r/actions/runs/42/attempts/1",
            "repos/o/r/actions/runs/42/attempts/1/jobs?per_page=100&page=1"
        ]
    );
    drop(ws);
    let reopened = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    assert_eq!(
        reopened.ci_run("github:123:42:1").unwrap()["status"],
        "cancelled"
    );
}

fn unwatched(mode: &str) -> (tempfile::TempDir, Arc<Workspace>) {
    let (dir, s) = setup();
    let sub = subscribe(&s, "a", "historical");
    observe(
        &s,
        sub["watchId"].as_str().unwrap(),
        vec![run(1, "in_progress", Value::Null)],
    );
    match mode {
        "paused" => {
            s.db.write()
                .unwrap()
                .execute("UPDATE ci_watches SET failures=8", [])
                .unwrap();
        }
        "expired" => {
            s.db.write()
                .unwrap()
                .execute("UPDATE ci_subscriptions SET expires=0", [])
                .unwrap();
        }
        _ => {
            s.ci_unsubscribe(Some("a"), sub["id"].as_str().unwrap())
                .unwrap();
        }
    }
    drop(s);
    let ws = exact_lab(dir.path());
    (dir, ws)
}

#[tokio::test]
async fn paused_and_expired_exact_reads_preserve_monitoring_and_notification_state() {
    for mode in ["paused", "expired"] {
        let (dir, ws) = unwatched(mode);
        let before = monitor_state(&ws);
        let view = ask(&ws, "ci_refresh", json!({"agentId":"a"}))
            .await
            .unwrap();
        assert_eq!(view["status"], "nothing");
        assert!(requests(dir.path()).is_empty());
        let result = ask(&ws, "ci_refresh", json!({"runKey":"github:123:42:1"}))
            .await
            .unwrap();
        assert_eq!(result["status"], "checked", "{mode}: {result}");
        assert_eq!(result["run"]["runWatched"], false);
        assert_eq!(result["run"]["status"], "cancelled");
        assert_eq!(monitor_state(&ws), before, "{mode}");
        if mode == "paused" {
            assert!(!ws.store.ci_flush_notifications().unwrap());
            assert_eq!(monitor_state(&ws), before);
        }
        assert!(mail(&ws.store, "a").is_empty());
        assert!(ws.store.ci_due().unwrap().is_none());
    }
}

#[tokio::test]
async fn exact_read_checks_repo_run_attempt_and_sha_and_preserves_old_facts_on_failure() {
    for phase in [
        "wrong-owner",
        "wrong-repository",
        "wrong-run",
        "wrong-attempt",
        "wrong-sha",
        "auth",
        "missing",
        "offline",
    ] {
        let (dir, ws) = unwatched("stopped");
        let before = monitor_state(&ws);
        let old = ws.store.ci_run("github:123:42:1").unwrap();
        std::fs::write(dir.path().join("phase"), phase).unwrap();
        let q = json!({"runKey":"github:123:42:1"});
        let (a, b) = tokio::join!(
            ask(&ws, "ci_refresh", q.clone()),
            ask(&ws, "ci_refresh", q.clone())
        );
        for result in [a.unwrap(), b.unwrap()] {
            assert_eq!(result["status"], "error", "{phase}: {result}");
            assert!(result["error"].is_string());
            assert!(result["run"].is_null() && result["details"].is_null());
        }
        assert_eq!(ws.store.ci_run("github:123:42:1").unwrap(), old);
        assert_eq!(monitor_state(&ws), before);
        let calls = requests(dir.path());
        assert_eq!(
            calls.len(),
            if phase == "wrong-owner" { 1 } else { 2 },
            "concurrent failures coalesce: {phase}: {calls:?}"
        );
        ask(&ws, "ci_refresh", q).await.unwrap();
        assert_eq!(
            requests(dir.path()),
            calls,
            "failure retry shares short cooldown"
        );
        let unknown = ask(&ws, "ci_refresh", json!({"runKey":"github:123:42:99"}))
            .await
            .unwrap_err();
        assert!(unknown.to_string().contains("not found"));
        assert_eq!(requests(dir.path()), calls);
    }
}

#[tokio::test]
async fn one_off_reads_share_success_304_poll_interval_and_github_cooldown() {
    let (dir, ws) = unwatched("stopped");
    let q = json!({"runKey":"github:123:42:1"});
    let before = monitor_state(&ws);
    let (a, b) = tokio::join!(
        ask(&ws, "ci_refresh", q.clone()),
        ask(&ws, "ci_refresh", q.clone())
    );
    for result in [a.unwrap(), b.unwrap()] {
        assert_eq!(result["run"]["status"], "cancelled");
        assert!(matches!(
            result["status"].as_str(),
            Some("checked" | "recent")
        ));
    }
    assert_eq!(requests(dir.path()).len(), 3);
    age(&ws, 3);
    assert_eq!(
        ask(&ws, "ci_refresh", q.clone()).await.unwrap()["status"],
        "recent"
    );
    assert_eq!(requests(dir.path()).len(), 3);
    age(&ws, 20);
    let not_modified = ask(&ws, "ci_refresh", q.clone()).await.unwrap();
    assert_eq!(not_modified["run"]["status"], "cancelled");
    assert_eq!(not_modified["status"], "checked");
    assert_eq!(
        requests(dir.path()).len(),
        5,
        "two conditional 304s, repository shared"
    );
    std::fs::write(dir.path().join("phase"), "interval").unwrap();
    age(&ws, 20);
    ask(&ws, "ci_refresh", q.clone()).await.unwrap();
    age(&ws, 30);
    let count = requests(dir.path()).len();
    let interval = ask(&ws, "ci_refresh", q.clone()).await.unwrap();
    assert_eq!(interval["status"], "github_interval", "{interval}");
    assert!((88..=91).contains(&until(&interval)));
    assert_eq!(requests(dir.path()).len(), count);
    assert_eq!(monitor_state(&ws), before);
    for phase in ["denied", "rate"] {
        let (dir, ws) = unwatched("stopped");
        std::fs::write(dir.path().join("phase"), phase).unwrap();
        let old = ws.store.ci_run("github:123:42:1").unwrap();
        let first = ask(&ws, "ci_refresh", q.clone()).await.unwrap();
        assert_eq!(first["status"], "cooldown", "{phase}: {first}");
        assert!(until(&first) >= 590);
        let count = requests(dir.path()).len();
        assert_eq!(
            ask(&ws, "ci_refresh", q.clone()).await.unwrap()["status"],
            "cooldown"
        );
        assert_eq!(requests(dir.path()).len(), count);
        assert_eq!(ws.store.ci_run("github:123:42:1").unwrap(), old);
    }
}

#[tokio::test]
async fn finished_jobs_do_not_decide_run_status_and_their_poll_interval_survives_changes() {
    let (dir, ws) = unwatched("stopped");
    let q = json!({"runKey":"github:123:42:1"});
    std::fs::write(dir.path().join("phase"), "running").unwrap();
    let result = ask(&ws, "ci_refresh", q.clone()).await.unwrap();
    assert_eq!(result["run"]["status"], "running");
    assert_eq!(result["details"][0]["jobs"][0]["status"], "cancelled");
    std::fs::write(dir.path().join("phase"), "steps-interval").unwrap();
    // ci_get can have more recent jobs than the run; changing run status must
    // not erase the server's 120-second minimum for those jobs.
    age(&ws, 30);
    ask(&ws, "ci_get", q.clone()).await.unwrap();
    let count = requests(dir.path()).len();
    let result = ask(&ws, "ci_refresh", q).await.unwrap();
    assert_eq!(result["run"]["status"], "cancelled");
    assert_eq!(
        requests(dir.path()).len(),
        count + 1,
        "only the exact run, not its interval-limited jobs"
    );
}

#[test]
fn monitoring_metadata_is_current_and_a_stale_exact_cache_cannot_regress_run_facts() {
    let (_dir, s) = setup();
    let a = subscribe(&s, "a", "first");
    let b = subscribe(&s, "b", "shared");
    observe(
        &s,
        a["watchId"].as_str().unwrap(),
        vec![run(1, "in_progress", Value::Null)],
    );
    let key = "github:123:42:1";
    assert_eq!(s.ci_run(key).unwrap()["runWatched"], true);
    s.ci_unsubscribe(Some("a"), a["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        s.ci_list(Some("a"), None, None).unwrap()["runs"][0]["runWatched"],
        true,
        "other subscriber still watches"
    );
    s.ci_unsubscribe(Some("b"), b["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        s.ci_list(None, None, None).unwrap()["runs"][0]["runWatched"],
        false
    );
    let mut current = run(1, "completed", json!("cancelled"));
    current["observedAt"] = json!(stamp(chrono::Utc::now().timestamp()));
    s.ci_refresh_run(current.clone()).unwrap();
    let mut stale = run(1, "in_progress", Value::Null);
    stale["observedAt"] = json!(stamp(chrono::Utc::now().timestamp() - 3));
    assert!(!s.ci_refresh_run(stale.clone()).unwrap());
    stale["observedAt"] = current["observedAt"].clone();
    assert!(!s.ci_refresh_run(stale).unwrap());
    assert_eq!(s.ci_run(key).unwrap()["status"], "cancelled");
}
