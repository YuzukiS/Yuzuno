use super::*;
use crate::{model::AgentDetail, store::Store};
#[cfg(unix)]
#[path = "stopped_refresh_tests.rs"]
mod stopped_refresh;
#[cfg(unix)]
#[path = "commit_watch_tests.rs"]
mod commit_watch;
fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    for id in ["a", "b"] {
        s.insert(&serde_json::from_value::<AgentDetail>(json!({"agent":{"id":id,"name":id,"cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    }
    for title in ["One outcome", "Second outcome"] {
        s.collaboration_call(
            None,
            "task_create",
            json!({"requestId":title,"title":title,"status":"doing"}),
        )
        .unwrap();
    }
    (dir, s)
}
fn input(id: &str) -> Subscribe {
    Subscribe {
        request_id: id.into(),
        task_id: "T-1".into(),
        agent_id: None,
        url: "https://github.com/o/r/pull/7".into(),
        expected_sha: "a".repeat(40),
        branch: None,
        event: None,
    }
}
fn subscribe(s: &Store, agent: &str, id: &str) -> Value {
    s.ci_subscribe(
        Some(agent),
        input(id),
        crate::github::client::Repository {
            id: 123,
            full_name: "o/r".into(),
        },
        "pull",
        7,
    )
    .unwrap()
}
fn raw(attempt: u64, status: &str, conclusion: Value) -> Value {
    json!({"id":42,"run_attempt":attempt,"head_sha":"a".repeat(40),"name":"CI","status":status,"conclusion":conclusion,"repository":{"id":123},"created_at":"2026-10-15T00:00:00Z"})
}
fn run(attempt: u64, status: &str, conclusion: Value) -> Value {
    client::run(&raw(attempt, status, conclusion), 123, "o/r").unwrap()
}
fn seen(runs: Vec<Value>, head: Option<String>) -> Observed {
    Observed {
        pr: None,
        runs,
        head,
        truncated: false,
        checked: chrono::Utc::now().timestamp(),
        wait: 0,
        excluded: 0,
    }
}
fn observe(s: &Store, w: &str, runs: Vec<Value>) {
    s.ci_observe(w, Ok(seen(runs, Some("a".repeat(40)))))
        .unwrap();
}
fn mail(s: &Store, agent: &str) -> Vec<Value> {
    s.collaboration_call(
        Some(agent),
        "peer_read",
        json!({"priority":"normal","afterSeq":0,"limit":50}),
    )
    .unwrap()["messages"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn subscription_retry_shared_facts_and_per_subscriber_restart_notifications() {
    let (dir, s) = setup();
    let a = subscribe(&s, "a", "watch");
    let b = subscribe(&s, "b", "watch");
    let w = a["watchId"].as_str().unwrap().to_owned();
    assert_eq!(a["watchId"], b["watchId"]);
    assert_eq!(subscribe(&s, "a", "watch")["id"], a["id"]);
    let mut other = input("watch");
    other.expected_sha = "b".repeat(40);
    assert!(
        s.ci_previous(Some("a"), &other)
            .unwrap_err()
            .to_string()
            .contains("idempotency_conflict")
    );
    observe(&s, &w, vec![run(1, "in_progress", Value::Null)]);
    assert!(mail(&s, "a").is_empty());
    observe(&s, &w, vec![run(1, "completed", json!("success"))]);
    assert_eq!(mail(&s, "a").len(), 1);
    assert_eq!(mail(&s, "b").len(), 1);
    let m = mail(&s, "a").remove(0);
    assert_eq!(m["sender"]["kind"], "system");
    assert_eq!(m["metadata"]["kind"], "ci");
    assert_eq!(m["notice"]["status"], "passed");
    assert_eq!(m["priority"], "normal");
    assert_eq!(
        s.ci_list(None, None, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        s.db.read()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM local_jobs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    observe(&s, &w, vec![run(1, "completed", json!("success"))]);
    assert_eq!(mail(&s, "a").len(), 1);
    observe(&s, &w, vec![run(2, "completed", json!("failure"))]);
    assert_eq!(mail(&s, "a").len(), 2);
    assert_eq!(
        s.ci_list(None, None, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s.collaboration_call(None, "task_get", json!({"taskId":"T-1"}))
            .unwrap()["task"]["status"],
        "doing"
    );
}
#[test]
fn pinned_sha_failure_retains_fact_and_stop_respects_owner() {
    let (_dir, s) = setup();
    let sub = subscribe(&s, "a", "first");
    let w = sub["watchId"].as_str().unwrap();
    observe(&s, w, vec![run(1, "in_progress", Value::Null)]);
    let before = s.ci_run("github:123:42:1").unwrap();
    for _ in 0..8 {
        s.ci_observe(w, Err("unavailable: API offline".into()))
            .unwrap();
    }
    let page = s.ci_list(None, None, None).unwrap();
    assert_eq!(page["runs"][0]["observedAt"], before["observedAt"]);
    // Counted in scope whether or not it is on the listed page.
    assert_eq!(page["activeSubscriptionCount"], 1);
    assert_eq!(
        s.ci_list(Some("b"), None, None).unwrap()["activeSubscriptionCount"],
        0
    );
    // The internal task id a subscription carries scopes the list too.
    let scoped = s.ci_list(Some("a"), sub["taskId"].as_str(), None).unwrap();
    assert_eq!(scoped["runs"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["activeSubscriptionCount"], 1);
    assert_eq!(
        page["subscriptions"][0]["watch"]["state"],
        "needs_attention"
    );
    assert!(s.ci_due().unwrap().is_none());
    assert!(mail(&s, "a").is_empty());
    let mut wrong = run(1, "completed", json!("success"));
    wrong["headSha"] = json!("b".repeat(40));
    assert!(s.ci_observe(w, Ok(seen(vec![wrong], None))).is_err());
    s.ci_observe(
        w,
        Ok(seen(
            vec![run(1, "completed", json!("success"))],
            Some("b".repeat(40)),
        )),
    )
    .unwrap();
    let p = s.ci_list(None, None, None).unwrap();
    assert_eq!(p["subscriptions"][0]["watch"]["state"], "older_commit");
    assert_eq!(p["runs"][0]["headSha"], "a".repeat(40));
    assert!(
        s.ci_unsubscribe(Some("b"), sub["id"].as_str().unwrap())
            .is_err()
    );
    assert_eq!(
        s.ci_unsubscribe(Some("a"), sub["id"].as_str().unwrap())
            .unwrap()["active"],
        false
    );
    assert_eq!(
        s.ci_list(None, None, None).unwrap()["activeSubscriptionCount"],
        0
    );
    observe(&s, w, vec![run(2, "completed", json!("failure"))]);
    assert_eq!(mail(&s, "a").len(), 1);
    assert!(
        s.ci_list(Some("b"), None, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        s.ci_list(None, Some("T-2"), None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn typed_run_outcomes_pagination_and_mixed_jobs() {
    for (conclusion, expected) in [
        ("success", "passed"),
        ("failure", "failed"),
        ("timed_out", "failed"),
        ("cancelled", "cancelled"),
        ("neutral", "skipped"),
        ("skipped", "skipped"),
        ("mystery", "unknown"),
    ] {
        assert_eq!(run(1, "completed", json!(conclusion))["status"], expected);
    }
    assert_eq!(run(1, "waiting", Value::Null)["status"], "pending");
    assert!(client::run(&raw(1, "completed", json!("success")), 999, "o/r").is_err());
    assert!(client::target("https://evil.test/o/r/actions/runs/42").is_err());
    assert!(client::target("https://github.com/o/r/actions/runs/42?token=bad").is_err());
    let endpoint = "repos/o/r/actions/runs/42/attempts/1/jobs?per_page=100&page=1";
    assert_eq!(client::next_page("<https://api.github.com/repos/o/r/actions/runs/42/attempts/1/jobs?per_page=100&page=2>; rel=\"next\"",endpoint,1).unwrap().unwrap(),"repos/o/r/actions/runs/42/attempts/1/jobs?per_page=100&page=2");
    assert!(client::next_page("<https://evil.test/repos/o/r/actions/runs/42/attempts/1/jobs?per_page=100&page=2>; rel=\"next\"",endpoint,1).is_err());
    let jobs = json!({"total_count":103,"jobs":[{"id":1,"run_id":42,"head_sha":"a".repeat(40),"name":"pass","status":"completed","conclusion":"success","steps":[{"name":"one","number":1,"status":"completed","conclusion":"success"}]},{"id":2,"run_id":42,"head_sha":"a".repeat(40),"name":"pending","status":"queued"},{"id":3,"run_id":42,"head_sha":"a".repeat(40),"name":"skip","status":"completed","conclusion":"skipped"}]});
    let detail = client::jobs(&jobs, &run(1, "in_progress", Value::Null), 1, true).unwrap();
    assert_eq!(detail["nextPage"], 2);
    assert_eq!(detail["jobs"][0]["status"], "passed");
    assert_eq!(detail["jobs"][1]["status"], "pending");
    assert_eq!(detail["jobs"][2]["status"], "skipped");
    assert_eq!(detail["jobs"][0]["steps"].as_array().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn conditional_client_bounds_and_304_cache_preservation() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gh-fixture");
    std::fs::write(&path,"#!/bin/sh\nprintf 'HTTP/2.0 304 Not Modified\\r\\nEtag: \"one\"\\r\\nX-Poll-Interval: 90\\r\\n\\r\\n'\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let c = crate::github::client::Client {
        program: path.to_string_lossy().into(),
        deadline: Duration::from_secs(1),
    };
    let v = c
        .conditional("repos/o/r/actions/runs", Some("\"one\""))
        .await
        .unwrap();
    assert_eq!(v["code"], 304);
    assert_eq!(v["headers"]["x-poll-interval"], "90");
    assert!(v["error"].is_null());
    let (_dir, s) = setup();
    s.ci_save_cache(
        "endpoint",
        json!({"etag":"one","value":{"fact":true},"fetchedAt":1}),
    )
    .unwrap();
    s.ci_cooldown(9999999999).unwrap();
    let (cache, until) = s.ci_cache("endpoint").unwrap();
    assert_eq!(cache.unwrap()["value"]["fact"], true);
    assert_eq!(until, 9999999999);
}

#[cfg(unix)]
#[tokio::test]
async fn scheduler_pages_conditionals_rate_limit_and_incomplete_attempt_restart_recovery() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, s) = setup();
    let a = subscribe(&s, "a", "one");
    subscribe(&s, "b", "two");
    let id = a["watchId"].as_str().unwrap().to_owned();
    drop(s);
    let phase = dir.path().join("phase");
    std::fs::write(&phase, "pending").unwrap();
    let program = dir.path().join("gh-fixture");
    let fixture = r##"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
phase=(root/'phase').read_text()
ep=next(v for v in sys.argv if v.startswith(('repos/','repositories/')))
with (root/'requests').open('a') as f:f.write(ep+'\n')
if phase=='rate':
 print('HTTP/2.0 429 Too Many Requests\r\nRetry-After: 600\r\n\r\n')
 print('HTTP 429 rate limit',file=sys.stderr)
 sys.exit(1)
etag='"'+phase+'-'+ep+'"'
if 'If-None-Match: '+etag in sys.argv:
 print('HTTP/2.0 304 Not Modified\r\nEtag: '+etag+'\r\n\r\n')
 sys.exit(0)
def run(n=42,attempt=1):
 return {'id':n,'run_attempt':attempt,'head_sha':'a'*40,'name':'CI','repository':{'id':123},'status':'in_progress' if phase=='pending' else 'completed','conclusion':None if phase in ('pending','incomplete') else ('failure' if attempt==1 else 'success')}
link=''
if ep=='repositories/123':data={'id':123,'full_name':'o/r'}
elif '/pulls/7' in ep:data={'number':7,'base':{'repo':{'id':123}},'head':{'sha':('b' if phase=='done' else 'a')*40}}
elif '/attempts/1' in ep:data=run()
elif 'page=2' in ep:data={'total_count':2,'workflow_runs':[run(43)]}
else:
 data={'total_count':2,'workflow_runs':[run(42,2 if phase=='done' else 1)]}
 link='Link: <https://api.github.com/'+ep.replace('&page=1','&page=2')+'>; rel="next"\r\n'
print('HTTP/2.0 200 OK\r\nEtag: '+etag+'\r\n'+link+'\r\n'+json.dumps(data))
"##;
    std::fs::write(&program, fixture).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut ws = Workspace::new(dir.path().into(), "/workspace".into(), "unused".into()).unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program.to_string_lossy().into();
    tick(&ws).await.unwrap();
    assert_eq!(
        ws.store.ci_list(None, None, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(mail(&ws.store, "a").is_empty());
    fn force(ws: &Workspace) {
        let db = ws.store.db.write().unwrap();
        db.execute("UPDATE ci_watches SET next_poll=0", []).unwrap();
        db.execute(
            "UPDATE ci_cache SET data=json_set(data,'$.fetchedAt',0)",
            [],
        )
        .unwrap();
    }
    force(&ws);
    tick(&ws).await.unwrap(); // same etags: 304 bodies from durable cache
    assert_eq!(
        ws.store.ci_list(None, None, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    std::fs::write(&phase, "rate").unwrap();
    force(&ws);
    tick(&ws).await.unwrap();
    let failed = ws.store.ci_list(None, None, None).unwrap();
    assert!(
        failed["subscriptions"][0]["watch"]["error"]
            .as_str()
            .unwrap()
            .contains("rate_limited")
    );
    assert_eq!(failed["runs"][0]["rawStatus"], "in_progress");
    assert!(mail(&ws.store, "a").is_empty());
    let calls = std::fs::read_to_string(dir.path().join("requests")).unwrap();
    force(&ws);
    tick(&ws).await.unwrap();
    assert_eq!(
        calls,
        std::fs::read_to_string(dir.path().join("requests")).unwrap()
    ); // global cooldown: no API call
    ws.store
        .db
        .write()
        .unwrap()
        .execute("UPDATE ci_control SET cooldown=0", [])
        .unwrap();
    std::fs::write(&phase, "incomplete").unwrap();
    force(&ws);
    tick(&ws).await.unwrap();
    let incomplete = ws.store.ci_unfinished(&id).unwrap();
    assert_eq!(incomplete.len(), 2);
    assert!(
        incomplete
            .iter()
            .all(|r| r["rawStatus"] == "completed" && r["conclusion"].is_null())
    );
    assert!(mail(&ws.store, "a").is_empty());
    // The new attempt becomes current while Core is down. Its predecessor
    // still needs an attempt-specific read despite already being completed.
    drop(ws);
    ws = Workspace::new(dir.path().into(), "/workspace".into(), "unused".into()).unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program.to_string_lossy().into();
    std::fs::write(&phase, "done").unwrap();
    force(&ws);
    tick(&ws).await.unwrap();
    let done = ws.store.ci_list(None, None, None).unwrap();
    assert_eq!(done["runs"].as_array().unwrap().len(), 3);
    assert_eq!(done["subscriptions"][0]["watch"]["state"], "older_commit");
    assert_eq!(mail(&ws.store, "a").len(), 3);
    assert_eq!(mail(&ws.store, "b").len(), 3);
    assert!(ws.store.ci_unfinished(&id).unwrap().is_empty());
    assert!(
        std::fs::read_to_string(dir.path().join("requests"))
            .unwrap()
            .lines()
            .any(|ep| ep == "repos/o/r/actions/runs/42/attempts/1")
    );
    let old = mail(&ws.store, "a")
        .into_iter()
        .filter(|m| m["metadata"]["runId"] == "42" && m["metadata"]["attempt"] == "1")
        .collect::<Vec<_>>();
    assert_eq!(old.len(), 1);
    assert_eq!(old[0]["metadata"]["conclusion"], "failure");
    force(&ws);
    tick(&ws).await.unwrap();
    assert_eq!(mail(&ws.store, "a").len(), 3);
    ws.store
        .db
        .write()
        .unwrap()
        .execute("UPDATE ci_subscriptions SET expires=0", [])
        .unwrap();
    force(&ws);
    assert!(ws.store.ci_due().unwrap().is_none());
}

#[test]
fn incomplete_conclusion_waits_and_large_terminal_mail_batches_drain_boundedly() {
    let (_dir, s) = setup();
    let sub = subscribe(&s, "a", "batch");
    let id = sub["watchId"].as_str().unwrap();
    observe(&s, id, vec![run(1, "completed", Value::Null)]);
    assert!(mail(&s, "a").is_empty());
    let mut runs = Vec::new();
    for n in 1..=105 {
        let mut r = run(n, "completed", json!("success"));
        r["id"] = json!(format!("github:123:42:{n}"));
        runs.push(r);
    }
    observe(&s, id, runs);
    let count = || {
        s.db.read()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ci_notifications", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
    };
    assert_eq!(count(), 100);
    assert!(s.ci_flush_notifications().unwrap());
    assert_eq!(count(), 105);
    assert!(!s.ci_flush_notifications().unwrap());
}

#[test]
fn run_state_change_revalidates_only_its_jobs_cache_and_keeps_conditional_evidence() {
    let (_dir, s) = setup();
    let sub = subscribe(&s, "a", "jobs-cache");
    let id = sub["watchId"].as_str().unwrap();
    observe(&s, id, vec![run(1, "in_progress", Value::Null)]);
    let endpoint = "repos/o/r/actions/runs/42/attempts/1/jobs?per_page=100&page=1";
    let other = "repos/o/r/actions/runs/42/attempts/2/jobs?per_page=100&page=1";
    let cache = json!({"fetchedAt":1234,"etag":"jobs-running","value":{"jobs":[]}});
    s.ci_save_cache(endpoint, cache.clone()).unwrap();
    s.ci_save_cache(other, cache.clone()).unwrap();
    observe(&s, id, vec![run(1, "in_progress", Value::Null)]);
    assert_eq!(s.ci_cache(endpoint).unwrap().0.unwrap(), cache);
    observe(&s, id, vec![run(1, "completed", json!("success"))]);
    let revalidate = s.ci_cache(endpoint).unwrap().0.unwrap();
    assert_eq!(revalidate["fetchedAt"], 0);
    assert_eq!(revalidate["etag"], cache["etag"]);
    assert_eq!(revalidate["value"], cache["value"]);
    assert_eq!(s.ci_cache(other).unwrap().0.unwrap(), cache);
}

/// A controlled `gh`: `phase` picks GitHub's answer, every call is logged.
#[cfg(unix)]
fn lab(dir: &std::path::Path) -> Arc<Workspace> {
    use std::os::unix::fs::PermissionsExt;
    let fixture = r##"#!/usr/bin/python3
import json,sys,pathlib,re
root=pathlib.Path(__file__).parent
phase=(root/'phase').read_text()
ep=next(v for v in sys.argv if v.startswith(('repos/','repositories/')))
with (root/'requests').open('a') as f:f.write(ep+'\n')
if phase=='rate':
 print('HTTP/2.0 429 Too Many Requests\r\nRetry-After: 600\r\n\r\n')
 print('HTTP 429 rate limit',file=sys.stderr)
 sys.exit(1)
etag='"'+phase+'-'+ep+'"'
if 'If-None-Match: '+etag in sys.argv:
 print('HTTP/2.0 304 Not Modified\r\nEtag: '+etag+'\r\n\r\n')
 sys.exit(0)
sha=(re.search('head_sha=([0-9a-f]{40})',ep) or [None,'a'*40])[1]
done=phase in ('done','interval')
run={'id':42 if sha[0]=='a' else 43,'run_attempt':1,'head_sha':sha,'name':'CI','repository':{'id':123},'status':'completed' if done else 'in_progress','conclusion':'success' if done else None}
step='in_progress' if phase=='running' else 'completed'
if ep=='repositories/123':data={'id':123,'full_name':'o/r'}
elif '/pulls/7' in ep:data={'number':7,'base':{'repo':{'id':123}},'head':{'sha':'a'*40}}
elif re.search(r'/actions/runs/42/attempts/1$',ep):data=run
elif '/jobs' in ep:data={'total_count':1,'jobs':[{'id':1,'run_id':42,'run_attempt':1,'head_sha':'a'*40,'name':'Build','status':run['status'],'conclusion':run['conclusion'],'steps':[{'number':1,'name':'Compile','status':step,'conclusion':'success' if step=='completed' else None}]}]}
else:data={'total_count':1,'workflow_runs':[run]}
extra='X-Poll-Interval: 120\r\n' if phase=='interval' else ''
print('HTTP/2.0 200 OK\r\nEtag: '+etag+'\r\n'+extra+'\r\n'+json.dumps(data))
"##;
    let program = dir.join("gh-fixture");
    std::fs::write(&program, fixture).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(dir.join("phase"), "running").unwrap();
    let mut ws = Workspace::new(dir.into(), "/workspace".into(), "unused".into()).unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program.to_string_lossy().into();
    // No background monitor: each check below is the test's own.
    ws.ci.started.set(()).unwrap();
    ws
}
#[cfg(unix)]
fn requests(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("requests"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}
/// Makes every cached GitHub answer `seconds` old.
fn age(ws: &Workspace, seconds: i64) {
    ws.store
        .db
        .write()
        .unwrap()
        .execute(
            "UPDATE ci_cache SET data=json_set(data,'$.fetchedAt',?1)",
            [chrono::Utc::now().timestamp() - seconds],
        )
        .unwrap();
}
fn next_poll(ws: &Workspace, watch: &str) -> i64 {
    ws.store
        .db
        .read()
        .unwrap()
        .query_row(
            "SELECT next_poll FROM ci_watches WHERE id=?1",
            [watch],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
        - chrono::Utc::now().timestamp()
}
fn failures(ws: &Workspace) -> i64 {
    ws.store
        .db
        .read()
        .unwrap()
        .query_row("SELECT failures FROM ci_watches", [], |r| r.get(0))
        .unwrap()
}
async fn ask(ws: &Arc<Workspace>, operation: &str, input: Value) -> Result<Value> {
    call(ws.clone(), None, operation.into(), input).await
}
fn until(answer: &Value) -> i64 {
    chrono::DateTime::parse_from_rfc3339(answer["retryAt"].as_str().unwrap())
        .unwrap()
        .timestamp()
        - chrono::Utc::now().timestamp()
}

#[cfg(unix)]
#[tokio::test]
async fn manual_refresh_asks_github_now_shares_answers_and_respects_github_limits() {
    let (dir, s) = setup();
    let sub = subscribe(&s, "a", "watch");
    let watch = sub["watchId"].as_str().unwrap().to_owned();
    drop(s);
    let ws = lab(dir.path());
    let phase = |p: &str| std::fs::write(dir.path().join("phase"), p).unwrap();
    let key = "github:123:42:1";
    let input = json!({"agentId":"a","runKey":key,"pages":1});
    assert!(tick(&ws).await.unwrap());
    assert!(
        (29..=31).contains(&next_poll(&ws, &watch)),
        "running runs are checked every 30 s"
    );
    let shown = ask(&ws, "ci_get", json!({"runKey":key})).await.unwrap();
    assert_eq!(
        shown["details"]["jobs"][0]["steps"][0]["status"],
        "in_progress"
    );

    // GitHub moves on within Yuzuno's cache period: a step finishes while
    // the run still runs. Listing and reading stay local; a refresh asks.
    phase("step");
    age(&ws, 20);
    let before = requests(dir.path()).len();
    let listed = ask(&ws, "ci_list", json!({})).await.unwrap();
    assert_eq!(listed["runs"][0]["rawStatus"], "in_progress");
    let cached = ask(&ws, "ci_get", json!({"runKey":key})).await.unwrap();
    assert_eq!(
        cached["details"]["jobs"][0]["steps"][0]["status"],
        "in_progress"
    );
    assert_eq!(
        requests(dir.path()).len(),
        before,
        "list and get never ask GitHub on their own here"
    );
    let fresh = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(fresh["status"], "checked", "{fresh}");
    assert_eq!(fresh["run"]["rawStatus"], "in_progress");
    assert_eq!(
        fresh["details"][0]["jobs"][0]["steps"][0]["status"],
        "completed"
    );
    assert!(fresh["error"].is_null() && fresh["retryAt"].is_null());
    let asked = requests(dir.path())[before..].to_vec();
    assert_eq!(
        asked.len(),
        3,
        "pull, runs and jobs; the repository identity stays cached: {asked:?}"
    );
    assert!(asked.iter().any(|e| e.contains("/jobs?")));

    // Asked again within ten seconds: that answer, no new request.
    age(&ws, 3);
    let before = requests(dir.path()).len();
    let again = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(again["status"], "recent", "{again}");
    assert_eq!(requests(dir.path()).len(), before);

    // Two windows at once: one set of reads answers both.
    age(&ws, 20);
    let before = requests(dir.path()).len();
    let (one, two) = tokio::join!(
        ask(&ws, "ci_refresh", input.clone()),
        ask(&ws, "ci_refresh", input.clone())
    );
    for answer in [one.unwrap(), two.unwrap()] {
        assert!(
            matches!(answer["status"].as_str(), Some("checked" | "recent")),
            "{answer}"
        );
        assert_eq!(
            answer["details"][0]["jobs"][0]["steps"][0]["status"],
            "completed"
        );
    }
    assert_eq!(
        requests(dir.path()).len() - before,
        3,
        "concurrent refreshes share one check"
    );

    // The run finishes: one mail however often it is refreshed.
    phase("done");
    age(&ws, 20);
    let done = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(
        (done["status"].as_str(), done["run"]["status"].as_str()),
        (Some("checked"), Some("passed"))
    );
    assert!(
        (299..=301).contains(&next_poll(&ws, &watch)),
        "finished runs every five minutes"
    );
    age(&ws, 20);
    ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(mail(&ws.store, "a").len(), 1);

    // GitHub's poll interval wins over a manual refresh.
    phase("interval");
    age(&ws, 20);
    ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    age(&ws, 30);
    let before = requests(dir.path()).len();
    let interval = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(interval["status"], "github_interval", "{interval}");
    assert!((88..=91).contains(&until(&interval)), "{interval}");
    assert_eq!(requests(dir.path()).len(), before);
    // The run is checked anew, but its steps are still within GitHub's poll
    // interval: the answer says so rather than "checked" (R1).
    let now = chrono::Utc::now().timestamp();
    {
        let db = ws.store.db.write().unwrap();
        db.execute("UPDATE ci_cache SET data=json_set(data,'$.fetchedAt',?1,'$.pollSeconds',0) WHERE endpoint NOT LIKE '%/jobs?%'", [now - 60]).unwrap();
        db.execute("UPDATE ci_cache SET data=json_set(data,'$.fetchedAt',?1) WHERE endpoint LIKE '%/jobs?%'", [now - 30]).unwrap();
    }
    let before = requests(dir.path()).len();
    let steps = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(steps["watches"][0]["status"], "checked", "{steps}");
    assert_eq!(steps["status"], "github_interval", "{steps}");
    assert!((88..=91).contains(&until(&steps)), "{steps}");
    let asked = requests(dir.path())[before..].to_vec();
    assert!(
        !asked.is_empty() && asked.iter().all(|e| !e.contains("/jobs?")),
        "{asked:?}"
    );

    // Rate limited: the shared cooldown holds, the last observation stays,
    // and the watch's own schedule and failure count are untouched.
    phase("rate");
    ws.store
        .db
        .write()
        .unwrap()
        .execute(
            "UPDATE ci_cache SET data=json_set(data,'$.fetchedAt',?1,'$.pollSeconds',0)",
            [chrono::Utc::now().timestamp() - 60],
        )
        .unwrap();
    let scheduled = next_poll(&ws, &watch);
    let before = requests(dir.path()).len();
    let limited = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(limited["status"], "cooldown", "{limited}");
    assert!(
        limited["error"].as_str().unwrap().contains("rate_limited"),
        "{limited}"
    );
    assert!(until(&limited) >= 590, "Retry-After: 600");
    assert_eq!(requests(dir.path()).len() - before, 1);
    let listed = ask(&ws, "ci_list", json!({})).await.unwrap();
    assert_eq!(listed["runs"][0]["status"], "passed");
    assert!(listed["cooldownUntil"].is_string());
    assert!((scheduled - 1..=scheduled).contains(&next_poll(&ws, &watch)));
    assert_eq!(failures(&ws), 0);
    let still = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(still["status"], "cooldown");
    assert_eq!(
        requests(dir.path()).len() - before,
        1,
        "no call while cooling down"
    );
    ws.store
        .db
        .write()
        .unwrap()
        .execute("UPDATE ci_control SET cooldown=0", [])
        .unwrap();
    phase("done");

    // A paused watch is not resumed, a stopped one not renewed, and an
    // unknown run is refused. A known historical run still gets one exact read.
    let before = requests(dir.path()).len();
    let set_failures = |n: i64| {
        ws.store
            .db
            .write()
            .unwrap()
            .execute("UPDATE ci_watches SET failures=?1", [n])
            .unwrap()
    };
    set_failures(8);
    let paused = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert_eq!(
        (
            paused["status"].as_str(),
            paused["paused"].as_u64(),
            paused["runWatched"].as_bool()
        ),
        (Some("checked"), Some(1), Some(false))
    );
    assert_eq!(failures(&ws), 8);
    set_failures(0);
    let subscription = |ws: &Workspace| {
        ws.store
            .db
            .read()
            .unwrap()
            .query_row("SELECT active,expires FROM ci_subscriptions", [], |r| {
                Ok((r.get::<_, bool>(0)?, r.get::<_, i64>(1)?))
            })
            .unwrap()
    };
    ws.store
        .ci_unsubscribe(Some("a"), sub["id"].as_str().unwrap())
        .unwrap();
    let stopped = subscription(&ws);
    let gone = ask(&ws, "ci_refresh", input.clone()).await.unwrap();
    assert!(
        matches!(gone["status"].as_str(), Some("checked" | "recent")),
        "{gone}"
    );
    assert_eq!(gone["runWatched"], false);
    assert_eq!(subscription(&ws), stopped);
    assert!(!stopped.0);
    let unknown = ask(&ws, "ci_refresh", json!({"runKey":"github:123:999:1"}))
        .await
        .unwrap_err();
    assert!(unknown.to_string().contains("not found"), "{unknown}");
    assert_eq!(
        requests(dir.path()).len(),
        before + 2,
        "one exact attempt and its jobs, shared after stopping"
    );
    assert_eq!(mail(&ws.store, "a").len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn scheduler_takes_due_watches_in_turn_at_the_running_cadence() {
    let (dir, s) = setup();
    let first = subscribe(&s, "a", "first");
    let mut other = input("second");
    other.expected_sha = "b".repeat(40);
    let repository = crate::github::client::Repository {
        id: 123,
        full_name: "o/r".into(),
    };
    let second = s
        .ci_subscribe(Some("a"), other, repository, "pull", 7)
        .unwrap();
    drop(s);
    let ws = lab(dir.path());
    // Both are due: one per tick, in order, with no idle beat between them.
    assert!(tick(&ws).await.unwrap());
    assert!(tick(&ws).await.unwrap());
    assert!(!tick(&ws).await.unwrap());
    for w in [&first, &second] {
        assert!((29..=31).contains(&next_poll(&ws, w["watchId"].as_str().unwrap())));
    }
    let asked = requests(dir.path());
    assert_eq!(
        asked.iter().filter(|e| e.contains("/pulls/7")).count(),
        1,
        "the PR read is shared: {asked:?}"
    );
    assert_eq!(asked.iter().filter(|e| e.contains("head_sha=")).count(), 2);
    let now = chrono::Utc::now().timestamp();
    let due = ws.store.ci_next_due().unwrap().unwrap();
    assert!((29..=31).contains(&(due - now)));
    assert_eq!(idle(Some(due), now), Duration::from_secs(10));
    assert_eq!(idle(Some(now + 3), now), Duration::from_secs(3));
    assert_eq!(idle(Some(now - 5), now), Duration::from_secs(1));
    assert_eq!(idle(None, now), Duration::from_secs(10));
    // A run's refresh checks only that run's watches, with or without a
    // view; without a run, the view's (R1).
    age(&ws, 20);
    let before = requests(dir.path()).len();
    for input in [
        json!({"runKey":"github:123:42:1"}),
        json!({"agentId":"a","runKey":"github:123:42:1"}),
    ] {
        let answer = ask(&ws, "ci_refresh", input).await.unwrap();
        let checked: Vec<_> = answer["watches"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|o| o["watchId"].as_str())
            .collect();
        assert_eq!(checked, [first["watchId"].as_str().unwrap()], "{answer}");
    }
    let asked = requests(dir.path())[before..].to_vec();
    assert!(
        !asked.is_empty() && asked.iter().all(|e| !e.contains(&"b".repeat(40))),
        "{asked:?}"
    );
    let view = ask(&ws, "ci_refresh", json!({"agentId":"a"}))
        .await
        .unwrap();
    assert_eq!(view["watches"].as_array().unwrap().len(), 2, "{view}");
    // A cooldown holds the next check back.
    ws.store.ci_cooldown(now + 120).unwrap();
    assert_eq!(ws.store.ci_next_due().unwrap(), Some(now + 120));
}

fn task_patch(s: &Store, task: &str, patch: Value, request: &str) {
    let current = s
        .collaboration_call(None, "task_get", json!({"taskId":task}))
        .unwrap();
    s.collaboration_call(None, "task_update", json!({"taskId":task,"expectedVersion":current["task"]["version"],"requestId":request,"patch":patch})).unwrap();
}
#[test]
fn terminal_task_reclaims_watch_slots_without_stopping_other_tasks_or_agents() {
    let (_d, s) = setup();
    for number in 1..=50 {
        let mut q = input(&format!("target-{number}"));
        q.url = format!("https://github.com/o/r/pull/{number}");
        s.ci_subscribe(
            Some("a"),
            q,
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "pull",
            number,
        )
        .unwrap();
    }
    let mut shared = input("shared");
    shared.task_id = "T-2".into();
    let other = s
        .ci_subscribe(
            Some("b"),
            shared.clone(),
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "pull",
            7,
        )
        .unwrap();
    let mut extra = input("extra");
    extra.task_id = "T-2".into();
    assert!(
        s.ci_subscribe(
            Some("b"),
            extra.clone(),
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into()
            },
            "pull",
            51
        )
        .unwrap_err()
        .to_string()
        .contains("50 distinct")
    );
    task_patch(&s, "T-1", json!({"status":"done"}), "close");
    let mine = s.ci_list(Some("a"), None, None).unwrap();
    assert_eq!(mine["subscriptions"].as_array().unwrap().len(), 50);
    assert!(
        mine["subscriptions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|sub| sub["active"] == false && sub["closure"]["reason"] == "task_completed")
    );
    assert_eq!(
        s.ci_previous(Some("b"), &shared).unwrap().unwrap()["active"],
        true
    );
    s.ci_subscribe(
        Some("b"),
        extra,
        crate::github::client::Repository {
            id: 123,
            full_name: "o/r".into(),
        },
        "pull",
        51,
    )
    .unwrap();
    observe(
        &s,
        other["watchId"].as_str().unwrap(),
        vec![run(1, "completed", json!("success"))],
    );
    assert!(mail(&s, "a").is_empty());
    assert_eq!(mail(&s, "b").len(), 1);
}
#[test]
fn post_merge_run_survives_task_close_and_resubscribe_needs_fresh_evidence() {
    let (dir, s) = setup();
    let mut q = input("main-run");
    q.url = "https://github.com/o/r/actions/runs/42".into();
    let sub = s
        .ci_subscribe(
            Some("a"),
            q.clone(),
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "run",
            42,
        )
        .unwrap();
    let wid = sub["watchId"].as_str().unwrap();
    observe(&s, wid, vec![run(1, "in_progress", Value::Null)]);
    task_patch(&s, "T-1", json!({"status":"done"}), "close");
    assert_eq!(
        s.ci_previous(Some("a"), &q).unwrap().unwrap()["active"],
        true
    );
    observe_after_request(&s, wid, vec![run(1, "completed", json!("success"))]);
    assert_eq!(mail(&s, "a").len(), 1);
    let closed = s.ci_previous(Some("a"), &q).unwrap().unwrap();
    assert_eq!(closed["active"], false);
    assert_eq!(closed["closure"]["reason"], "verification_completed");
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.ci_flush_notifications().unwrap();
    assert_eq!(
        s.ci_previous(Some("a"), &q).unwrap().unwrap()["closure"],
        closed["closure"]
    );
    // Replaying the old request has no renewal side effect, even on a done task.
    let replay = s
        .ci_subscribe(
            Some("a"),
            q.clone(),
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "run",
            42,
        )
        .unwrap();
    assert_eq!(replay["active"], false);
    assert_eq!(replay["expiresAt"], closed["expiresAt"]);
    // A fresh request keeps the same subscription and notification receipts.
    // Make the cached observation unambiguously older than this new request.
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE ci_watches SET data=json_set(data,'$.observedAt','2000-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    q.request_id = "rerun".into();
    let renewed = s
        .ci_subscribe(
            Some("a"),
            q.clone(),
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "run",
            42,
        )
        .unwrap();
    assert_eq!(renewed["id"], closed["id"]);
    s.ci_flush_notifications().unwrap();
    assert_eq!(
        s.ci_previous(Some("a"), &q).unwrap().unwrap()["active"],
        true
    );
    observe(&s, wid, vec![run(2, "in_progress", Value::Null)]);
    observe_after_request(&s, wid, vec![run(2, "completed", json!("failure"))]);
    observe_after_request(&s, wid, vec![run(2, "completed", json!("failure"))]);
    assert_eq!(mail(&s, "a").len(), 2);
    assert_eq!(
        s.ci_previous(Some("a"), &q).unwrap().unwrap()["active"],
        false
    );
    assert_eq!(
        s.ci_list(None, None, None).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn legacy_cleanup_preserves_closed_reasons_and_explicit_request_replay() {
    for patch in [json!({"status":"cancelled"}), json!({"archived":true})] {
        let (dir, s) = setup();
        let sub = subscribe(&s, "a", "legacy");
        // Simulate old-version rows and task closure without a lifecycle hook.
        s.db.write()
            .unwrap()
            .execute("DELETE FROM ci_interests", [])
            .unwrap();
        let (path, value) = if patch["archived"] == true {
            ("$.archivedAt", crate::model::now())
        } else {
            ("$.status", "cancelled".into())
        };
        s.db.write()
            .unwrap()
            .execute(
                "UPDATE collaboration_tasks SET data=json_set(data,?1,?2) WHERE seq=1",
                rusqlite::params![path, value],
            )
            .unwrap();
        drop(s);
        let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        s.ci_flush_notifications().unwrap();
        let closed = s.ci_previous(Some("a"), &input("legacy")).unwrap().unwrap();
        assert_eq!(closed["active"], false);
        assert_eq!(closed["id"], sub["id"]);
        assert_eq!(
            closed["closure"]["reason"],
            if patch["archived"] == true {
                "task_archived"
            } else {
                "task_cancelled"
            }
        );
        s.ci_unsubscribe(Some("a"), closed["id"].as_str().unwrap())
            .unwrap();
        s.ci_flush_notifications().unwrap();
        assert_eq!(
            s.ci_previous(Some("a"), &input("legacy")).unwrap().unwrap()["closure"],
            closed["closure"]
        );
    }
}

// Model a later remote answer without sleeping or relying on wall-clock races.
fn observe_after_request(s: &Store, watch: &str, runs: Vec<Value>) {
    let mut observation = seen(runs, Some("a".repeat(40)));
    observation.checked = chrono::Utc::now().timestamp() + 1;
    s.ci_observe(watch, Ok(observation)).unwrap();
}
#[test]
fn renewal_in_same_second_cannot_close_on_cached_terminal_evidence() {
    let (_dir, s) = setup();
    let mut q = input("specific-run");
    q.url = "https://github.com/o/r/actions/runs/42".into();
    let sub = s
        .ci_subscribe(
            Some("a"),
            q.clone(),
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "run",
            42,
        )
        .unwrap();
    let wid = sub["watchId"].as_str().unwrap();
    task_patch(&s, "T-1", json!({"status":"done"}), "done");
    observe_after_request(&s, wid, vec![run(1, "completed", json!("success"))]);
    assert_eq!(
        s.ci_previous(Some("a"), &q).unwrap().unwrap()["active"],
        false
    );
    q.request_id = "renew-in-same-second".into();
    let renewed = s
        .ci_subscribe(
            Some("a"),
            q.clone(),
            crate::github::client::Repository {
                id: 123,
                full_name: "o/r".into(),
            },
            "run",
            42,
        )
        .unwrap();
    let epoch = chrono::Utc::now().timestamp();
    let opened = chrono::DateTime::from_timestamp(epoch, 900_000_000)
        .unwrap()
        .to_rfc3339();
    s.db.write().unwrap().execute("UPDATE ci_interests SET data=json_set(data,'$.openedAt',?1) WHERE active=1 AND subscription_id=?2",rusqlite::params![opened,renewed["id"].as_str()]).unwrap();
    s.db.write()
        .unwrap()
        .execute(
            "UPDATE ci_watches SET data=json_set(data,'$.observedAt',?1) WHERE id=?2",
            rusqlite::params![super::stamp(epoch), wid],
        )
        .unwrap();
    s.ci_flush_notifications().unwrap();
    assert_eq!(
        s.ci_previous(Some("a"), &q).unwrap().unwrap()["active"],
        true
    );
    assert_eq!(mail(&s, "a").len(), 1);
    let mut newer = seen(
        vec![run(2, "completed", json!("success"))],
        Some("a".repeat(40)),
    );
    newer.checked = epoch + 1;
    s.ci_observe(wid, Ok(newer)).unwrap();
    assert_eq!(
        s.ci_previous(Some("a"), &q).unwrap().unwrap()["active"],
        false
    );
    assert_eq!(mail(&s, "a").len(), 2);
}

/// T-131: the watched commit is the full 40-character SHA; a shorter one is
/// refused with how to get it, before anything is watched.
#[tokio::test]
async fn an_abbreviated_expected_sha_is_refused_with_how_to_get_the_full_one() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().into(), "/workspace".into(), "unused".into()).unwrap();
    let error = ask(&ws, "ci_subscribe", json!({"requestId":"watch","taskId":"T-1",
        "url":"https://github.com/o/r/pull/1","expectedSha":"e635e5e"})).await.unwrap_err().to_string();
    assert!(error.starts_with("expectedSha must be a full commit SHA, 40 hexadecimal characters, as GitHub shows it; got 7 characters."), "{error}");
    assert!(error.contains("git rev-parse"), "{error}");
    let tool = tool_definitions().into_iter().find(|tool| tool["name"] == "ci_subscribe").unwrap();
    assert_eq!(tool["inputSchema"]["properties"]["expectedSha"]["pattern"], "^[0-9a-fA-F]{40}$");
}
