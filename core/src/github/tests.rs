use super::*;
use crate::store::Store;
use client::{checks_summary, parse, Repository};

#[test]
fn strict_references_never_become_shell_or_endpoint_input() {
    assert_eq!(
        parse(" https://github.com/Owner/repo.git/ ", false)
            .unwrap()
            .repo,
        "Owner/repo"
    );
    assert_eq!(
        parse("https://github.com/Owner/repo/pull/42", true)
            .unwrap()
            .number,
        Some(42)
    );
    for url in [
        "https://evil.test/a/b/pull/1",
        "https://github.com@evil.test/a/b/pull/1",
        "https://github.com/a/b/pull/01",
        "https://github.com/a/b/pull/1?token=x",
        "https://github.com/a/b/pull/1#comment",
        "https://github.com/a/../pull/1",
        "https://github.com/a/b/pull/1;touch",
        "a/b/pull/1",
        "https://github.com/a/b/commit/abc",
        "https://github.com/a/b/issues/0",
    ] {
        assert!(parse(url, true).is_err(), "{url}");
    }
    for repo in [
        "--hostname=evil/x",
        "a/b/c",
        "a/$(touch)",
        "ssh://github.com/a/b",
        "a/b\nother",
    ] {
        assert!(parse(repo, false).is_err(), "{repo}");
    }
}
#[test]
fn ci_is_for_the_observed_commit_and_never_guesses_success() {
    let sha = "a".repeat(40);
    let statuses = json!({"sha":sha,"total_count":0,"statuses":[]});
    let runs = |status: &str, conclusion: &str| json!({"total_count":1,"check_runs":[{"name":"test","head_sha":sha,"status":status,"conclusion":conclusion}]});
    for (status, conclusion, wanted) in [
        ("queued", "", "pending"),
        ("in_progress", "", "pending"),
        ("completed", "success", "success"),
        ("completed", "failure", "failure"),
        ("completed", "cancelled", "cancelled"),
        ("completed", "skipped", "neutral"),
        ("completed", "future_value", "unknown"),
    ] {
        assert_eq!(
            checks_summary(&sha, &runs(status, conclusion), &statuses).unwrap()["state"],
            wanted
        );
    }
    assert_eq!(
        checks_summary(&sha, &json!({"total_count":0,"check_runs":[]}), &statuses).unwrap()
            ["state"],
        "none"
    );
    let mut old = runs("completed", "success");
    old["check_runs"][0]["head_sha"] = json!("b".repeat(40));
    assert_eq!(
        checks_summary(&sha, &old, &statuses).unwrap()["state"],
        "unknown"
    );
    let mut partial = runs("completed", "success");
    partial["total_count"] = json!(101);
    assert_eq!(
        checks_summary(&sha, &partial, &statuses).unwrap()["state"],
        "unknown"
    );
    let failed =
        json!({"sha":sha,"total_count":1,"statuses":[{"context":"legacy","state":"failure"}]});
    assert_eq!(
        checks_summary(&sha, &runs("completed", "success"), &failed).unwrap()["state"],
        "failure"
    );
}
fn create(s: &Store, project: Option<&str>) -> Value {
    s.collaboration_call(None,"task_create",json!({"requestId":uuid::Uuid::new_v4().to_string(),"title":"Deliver feature","projectId":project})).unwrap()["task"].clone()
}
#[test]
fn associations_survive_restart_rename_and_failure_without_completing_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("test.sqlite");
    let s = Store::open(&db).unwrap();
    let p = s.create_project("One", Default::default()).unwrap();
    let p2 = s.create_project("Two", Default::default()).unwrap();
    let task = create(&s, Some(&p.id));
    let id = task["id"].as_str().unwrap();
    let r = Repository {
        id: 7,
        full_name: "owner/repo".into(),
    };
    let r2 = Repository {
        id: 8,
        full_name: "owner/second".into(),
    };
    let snapshot = json!({"title":"Fix 中文","state":"open","headSha":"a".repeat(40)});
    assert!(s
        .github_link_object(id, &r, "pull", 1, snapshot.clone())
        .is_err());
    for project in [&p.id, &p2.id] {
        s.github_link_repo(project, &r).unwrap();
        s.github_link_repo(project, &r).unwrap();
    }
    s.github_link_repo(&p.id, &r2).unwrap();
    for (repo, kind, n) in [(&r, "pull", 1), (&r, "pull", 2), (&r2, "issue", 3)] {
        s.github_link_object(id, repo, kind, n, snapshot.clone())
            .unwrap();
        s.github_link_object(id, repo, kind, n, snapshot.clone())
            .unwrap();
    }
    assert_eq!(
        s.github_list(Some(&p.id), None).unwrap()["repositories"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s.github_list(None, Some(id)).unwrap()["links"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    s.github_refresh_object(
        "7:pull:1",
        Ok((
            Repository {
                id: 7,
                full_name: "new/renamed".into(),
            },
            json!({"title":"Fix 中文","state":"merged"}),
        )),
    )
    .unwrap();
    s.github_refresh_object("7:pull:1", Err("unavailable: offline".into()))
        .unwrap();
    let page = s.github_list(None, Some(id)).unwrap();
    let link = page["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "7:pull:1")
        .unwrap();
    assert_eq!(link["snapshot"]["state"], "merged");
    assert_eq!(link["stale"], true);
    assert_eq!(link["repository"], "new/renamed");
    let updated = s
        .collaboration_call(None, "task_get", json!({"taskId":id}))
        .unwrap();
    assert_eq!(updated["task"]["status"], task["status"]);
    assert_eq!(updated["task"]["version"], task["version"]);
    assert_eq!(updated["task"]["github"].as_array().unwrap().len(), 3);
    s.github_unlink_repo(&p.id, 7).unwrap();
    assert_eq!(
        s.github_list(None, Some(id)).unwrap()["links"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    drop(s);
    let s = Store::open(&db).unwrap();
    assert_eq!(
        s.github_list(None, Some(id)).unwrap()["links"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    s.github_unlink_object(id, "7:pull:1").unwrap();
    s.github_unlink_object(id, "7:pull:1").unwrap();
    assert_eq!(
        s.github_list(None, Some(id)).unwrap()["links"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
/// T-204: how many of a task's 30 places are used, what the 31st gets, and
/// that nothing is unlinked for the user.
#[test]
fn a_task_says_how_many_of_its_30_links_are_used_and_refuses_the_31st_with_what_to_do() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("test.sqlite")).unwrap();
    let p = s.create_project("One", Default::default()).unwrap();
    let id = create(&s, Some(&p.id))["id"].as_str().unwrap().to_owned();
    let r = Repository { id: 7, full_name: "owner/repo".into() };
    s.github_link_repo(&p.id, &r).unwrap();
    let capacity = |s: &Store| {
        let page = s.github_list(None, Some(&id)).unwrap();
        let c = &page["capacity"];
        (c["linkedCount"].as_i64().unwrap(), c["limit"].as_i64().unwrap(), c["remaining"].as_i64().unwrap(), page["links"].as_array().unwrap().len())
    };
    assert_eq!(capacity(&s), (0, 30, 30, 0));
    // A project's answer has no task capacity.
    assert!(s.github_list(Some(&p.id), None).unwrap().get("capacity").is_none());
    // Closed and merged ones count like open ones.
    for n in 1..=30u64 {
        let state = ["open", "closed", "merged"][(n % 3) as usize];
        s.github_link_object(&id, &r, if n % 2 == 0 { "pull" } else { "issue" }, n, json!({"title":format!("Synthetic {n}"),"state":state}))
            .unwrap();
    }
    assert_eq!(capacity(&s), (30, 30, 0, 30));
    // Linking one already linked takes no second place, also when full.
    s.github_link_object(&id, &r, "pull", 2, json!({"title":"Synthetic 2","state":"merged"})).unwrap();
    assert_eq!(capacity(&s), (30, 30, 0, 30));
    // The 31st is refused with the numbers and what to do; nothing changes.
    let refused = s
        .github_link_object(&id, &r, "pull", 31, json!({"title":"Synthetic 31","state":"open"}))
        .unwrap_err()
        .to_string();
    for part in ["link_limit_reached:", "linkedCount 30", "limit 30", "remaining 0", "closed and merged", "Nothing was linked", "action unlink", "linkId", "another task"] {
        assert!(refused.contains(part), "{part}: {refused}");
    }
    assert_eq!(capacity(&s), (30, 30, 0, 30));
    // The user unlinks one: one place is free, and the 31st fits.
    s.github_unlink_object(&id, "7:issue:1").unwrap();
    assert_eq!(capacity(&s), (29, 30, 1, 29));
    s.github_link_object(&id, &r, "pull", 31, json!({"title":"Synthetic 31","state":"open"})).unwrap();
    assert_eq!(capacity(&s), (30, 30, 0, 30));
}
#[tokio::test]
async fn missing_gh_is_actionable() {
    let c = client::Client {
        program: "/nonexistent/yuzuno-gh-fixture".into(),
        ..Default::default()
    };
    assert!(c
        .repository("owner/repo")
        .await
        .unwrap_err()
        .to_string()
        .starts_with("gh_missing:"));
}
#[cfg(unix)]
#[tokio::test]
async fn service_coalesces_refresh_and_does_not_resurrect_unlinked_objects() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("gh-fixture.py");
    std::fs::write(&script,r#"#!/usr/bin/python3
import sys,json,time
from pathlib import Path
with open(Path(__file__).with_suffix(".calls"), "a") as calls: print(sys.argv[-1], file=calls)
if Path(__file__).with_suffix(".fail").exists():
 print("HTTP 404 fake-private-diagnostic",file=sys.stderr);sys.exit(1)
assert sys.argv[1:6] == ['api','--hostname','github.com','--method','GET'], sys.argv
endpoint=sys.argv[-1]
if endpoint.startswith('repositories/') or endpoint.count('/')==2:
 print(json.dumps({'id':7,'full_name':'owner/repo'}))
elif '/pulls/' in endpoint:
 time.sleep(.15)
 print(json.dumps({'number':1,'title':'Fixture','state':'open','head':{'sha':'a'*40,'ref':'branch'},'base':{'ref':'main'},'draft':False}))
elif '/check-runs?' in endpoint: print(json.dumps({'total_count':0,'check_runs':[]}))
elif '/status?' in endpoint: print(json.dumps({'sha':'a'*40,'total_count':0,'statuses':[]}))
else: raise Exception(endpoint)
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut ws =
        Workspace::new(dir.path().join("data"), "/fixture".into(), "unused".into()).unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = script.to_str().unwrap().into();
    let task = ws.stored(|s| Ok(create(s, None))).await.unwrap();
    let id = task["id"].as_str().unwrap();
    let linked = ws
        .collaboration_call(
            None,
            "github_links",
            json!({"taskId":id,"action":"link","input":"https://github.com/owner/repo/pull/1"}),
        )
        .await
        .unwrap();
    assert_eq!(linked["links"][0]["snapshot"]["ci"]["state"], "none");
    assert_eq!(
        [&linked["capacity"]["linkedCount"], &linked["capacity"]["limit"], &linked["capacity"]["remaining"]],
        [&json!(1), &json!(30), &json!(29)]
    );
    std::fs::write(script.with_extension("fail"), "404").unwrap();
    let calls = || {
        std::fs::read_to_string(script.with_extension("calls"))
            .unwrap_or_default()
            .lines()
            .count()
    };
    let before = calls();
    for _ in 0..5 {
        ws.collaboration_call(None, "github_refresh", json!({"taskId":id}))
            .await
            .unwrap();
    }
    assert_eq!(ws.github.jobs.lock().unwrap().len(), 1);
    tokio::time::timeout(Duration::from_secs(5), async {
        while ws.github.jobs.lock().unwrap().values().any(|v| v.0) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // Five refreshes of one link start one read: its first call fails, and
    // the other refreshes find that read running or just ended.
    assert_eq!(calls() - before, 1, "GitHub calls after five refreshes of one link");
    let failed = ws
        .collaboration_call(None, "github_links", json!({"taskId":id}))
        .await
        .unwrap();
    assert_eq!(failed["links"][0]["stale"], true);
    assert_eq!(failed["links"][0]["snapshot"]["state"], "open");
    assert!(failed["links"][0]["error"]
        .as_str()
        .unwrap()
        .starts_with("not_found:"));
    assert!(!failed.to_string().contains("fake-private-diagnostic"));
    std::fs::remove_file(script.with_extension("fail")).unwrap();
    ws.github.jobs.lock().unwrap().clear();
    ws.collaboration_call(None, "github_refresh", json!({"taskId":id}))
        .await
        .unwrap();
    ws.collaboration_call(
        None,
        "github_links",
        json!({"taskId":id,"action":"unlink","linkId":"7:pull:1"}),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while ws.github.jobs.lock().unwrap().values().any(|v| v.0) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let unlinked = ws
        .collaboration_call(None, "github_links", json!({"taskId":id}))
        .await
        .unwrap();
    assert!(unlinked["links"].as_array().unwrap().is_empty());
    assert_eq!(unlinked["capacity"]["linkedCount"], 0);
    assert_eq!(unlinked["capacity"]["remaining"], 30);
    assert!(ws
        .collaboration_call(None, "github_refresh", json!({"taskId":id,"projectId":"p"}))
        .await
        .is_err());
}

#[test]
fn remote_errors_are_actionable_without_echoing_sensitive_diagnostics() {
    for (diagnostic, wanted) in [
        ("HTTP 401 secret", "not_authenticated"),
        ("gh auth login secret", "not_authenticated"),
        ("HTTP 403 secret", "forbidden"),
        ("HTTP 404 secret", "not_found"),
        ("API rate limit exceeded secret", "rate_limited"),
        (
            "gh: Could not resolve to a Repository with the name 'o/secret'.",
            "not_found",
        ),
        ("dial tcp secret", "unavailable"),
    ] {
        let error = client::failure(diagnostic.as_bytes(), Some(1)).to_string();
        assert!(error.starts_with(wanted));
        assert!(!error.contains("secret"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn gh_deadline_ends_only_the_owned_reader() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("slow-gh.py");
    std::fs::write(&path, "#!/usr/bin/python3\nimport time\ntime.sleep(60)\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let client = client::Client {
        program: path.to_str().unwrap().into(),
        deadline: Duration::from_millis(100),
    };
    let started = Instant::now();
    assert!(client
        .repository("owner/repo")
        .await
        .unwrap_err()
        .to_string()
        .starts_with("timeout:"));
    assert!(started.elapsed() < Duration::from_secs(2));
}

fn activity_fixture(id: i64) -> Value {
    let sha = |c: char| c.to_string().repeat(40);
    let commit = |c: char, title: &str, author: Value| json!({"oid":sha(c),"messageHeadline":title,"committedDate":"2026-10-17T01:02:03Z","author":author});
    let pull = |n: u64, head: char, rollup: char, state: Value, draft: bool, author: Value| json!({"number":n,"title":format!("PR {n}"),"isDraft":draft,"headRefOid":sha(head),"author":author,"commits":{"nodes":[{"commit":{"oid":sha(rollup),"statusCheckRollup":state}}]}});
    json!({"repository":{"databaseId":id,"nameWithOwner":"owner/repo","defaultBranchRef":{"name":"main","target":{"history":{"nodes":[
        commit('a', "Fix 中文 parsing", json!({"name":"Mori Git","user":{"login":"mori"}})),
        commit('b', "No account", json!({"name":"Plain Name","user":null})),
        {"oid":"not-a-sha","messageHeadline":"skipped","committedDate":"x","author":null},
        commit('c', "Three", json!(null)),
        commit('d', "Four", json!(null)),
        commit('e', "Five", json!(null)),
        commit('f', "Six is beyond the limit", json!(null)),
    ]}}},"pullRequests":{"totalCount":9,"nodes":[
        pull(12, 'c', 'c', json!({"state":"SUCCESS"}), false, json!({"login":"hana"})),
        pull(13, 'd', 'e', json!({"state":"FAILURE"}), true, json!(null)),
        pull(14, 'f', 'f', json!(null), false, json!({"login":"sora"})),
        pull(15, 'a', 'a', json!({"state":"ERROR"}), false, json!({"login":"sora"})),
        pull(16, 'b', 'b', json!({"state":"EXPECTED"}), false, json!({"login":"sora"})),
        pull(17, 'b', 'b', json!({"state":"SUCCESS"}), false, json!({"login":"sora"})),
    ]}}})
}
fn runs_fixture(id: i64) -> Value {
    json!({"total_count":2,"workflow_runs":[
        {"id":901,"name":"CI","head_branch":"main","status":"completed","conclusion":"failure","run_started_at":"2026-10-17T01:05:00Z","created_at":"2026-10-17T01:04:00Z","repository":{"id":id},"html_url":"https://evil.test/x"},
        {"id":902,"name":null,"head_branch":"feat/x","status":"in_progress","conclusion":null,"run_started_at":null,"created_at":"2026-10-17T01:06:00Z","repository":{"id":id}},
    ]})
}

#[test]
fn activity_parses_github_fixtures_into_home_shape() {
    let v = activity::parse_repository(7, &activity_fixture(7)).unwrap();
    assert_eq!(v["fullName"], "owner/repo");
    assert_eq!(v["defaultBranch"], "main");
    assert_eq!(v["pullsTotal"], 9);
    let commits = v["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 5, "at most five, invalid ones skipped");
    assert_eq!(commits[0]["sha"], "a".repeat(40));
    assert_eq!(commits[0]["title"], "Fix 中文 parsing");
    assert_eq!(
        commits[0]["author"], "mori",
        "the GitHub login when there is one"
    );
    assert_eq!(commits[1]["author"], "Plain Name");
    assert!(commits[2]["author"].is_null());
    assert_eq!(commits[0]["at"], "2026-10-17T01:02:03Z");
    assert_eq!(
        commits[0]["url"],
        format!("https://github.com/owner/repo/commit/{}", "a".repeat(40))
    );
    assert_eq!(commits[4]["title"], "Five");
    let pulls = v["pulls"].as_array().unwrap();
    assert_eq!(pulls.len(), 5);
    assert_eq!(
        pulls[0],
        json!({"number":12,"title":"PR 12","author":"hana","url":"https://github.com/owner/repo/pull/12","draft":false,"ci":{"state":"success"}})
    );
    // A rollup for an older head says nothing about the current one.
    assert!(pulls[1].get("ci").is_none());
    assert_eq!(pulls[1]["draft"], true);
    assert!(pulls[1]["author"].is_null());
    assert!(
        pulls[2].get("ci").is_none(),
        "no checks: unknown, not success"
    );
    assert_eq!(pulls[3]["ci"]["state"], "failure");
    assert_eq!(pulls[4]["ci"]["state"], "pending");

    let runs = activity::parse_runs(7, "owner/repo", &runs_fixture(7)).unwrap();
    assert_eq!(
        runs[0],
        json!({"id":901,"name":"CI","branch":"main","status":"completed","conclusion":"failure","at":"2026-10-17T01:05:00Z","url":"https://github.com/owner/repo/actions/runs/901"})
    );
    assert_eq!(runs[1]["name"], "Workflow");
    assert_eq!(runs[1]["at"], "2026-10-17T01:06:00Z");
    assert!(runs[1]["conclusion"].is_null());

    // Identity is checked; nothing is guessed.
    assert!(activity::parse_repository(8, &activity_fixture(7)).is_err());
    assert!(activity::parse_repository(7, &json!({"repository":null}))
        .unwrap_err()
        .to_string()
        .starts_with("not_found:"));
    assert!(activity::parse_runs(8, "owner/repo", &runs_fixture(7)).is_err());
    let empty = activity::parse_repository(
        7,
        &json!({"repository":{"databaseId":7,"nameWithOwner":"owner/repo","defaultBranchRef":null,"pullRequests":{"totalCount":0,"nodes":[]}}}),
    )
    .unwrap();
    assert!(empty.get("defaultBranch").is_none());
    assert_eq!(empty["commits"], json!([]));
}

#[test]
fn activity_errors_are_classified_without_diagnostics() {
    let f = activity::Failure::from_error(&anyhow::anyhow!("token=secret strange output"));
    assert_eq!(f.message, "unavailable: GitHub could not complete the read");
    assert!(f.until.is_none());
    let f = activity::Failure::from_error(&anyhow::anyhow!(
        "timeout: GitHub POST timed out; a write result must be checked before retrying"
    ));
    assert_eq!(f.message, "timeout: GitHub did not answer in time");
    let f = activity::Failure::from_error(&anyhow::anyhow!(
        "rate_limited: GitHub rate limit reached; retry later"
    ));
    assert!(f.until.unwrap() >= Instant::now() + activity::RATE_COOLDOWN - Duration::from_secs(5));
}

#[tokio::test]
async fn activity_cache_keeps_ttl_interval_cooldown_and_coalesces() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let cache = activity::Cache::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let good = |n: usize| json!({"observedAt":format!("n{n}"),"commits":[{"sha":n}],"pulls":[],"runs":[],"runsEtag":"\"e\""});
    let ok = |calls: Arc<AtomicUsize>| {
        move |_previous: Option<Value>| async move {
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            (Some(good(n)), None)
        }
    };
    let fail = |calls: Arc<AtomicUsize>, rate: Option<Instant>| {
        move |previous: Option<Value>| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            assert!(previous.is_some(), "the fetcher sees the last good answer");
            (
                None,
                Some(activity::Failure {
                    message: if rate.is_some() {
                        "rate_limited: GitHub rate limit reached; retry later".into()
                    } else {
                        "unavailable: GitHub could not complete the read".into()
                    },
                    until: rate,
                }),
            )
        }
    };
    let count = || calls.load(Ordering::SeqCst);

    let v = cache.read(1, at(0), ok(calls.clone())).await;
    assert_eq!(
        (count(), v["stale"].clone(), v["observedAt"].clone()),
        (1, json!(false), json!("n1"))
    );
    assert!(v.get("runsEtag").is_none() && v.get("error").is_none());
    // Fresh for the TTL.
    let v = cache.read(1, at(119), ok(calls.clone())).await;
    assert_eq!((count(), v["observedAt"].clone()), (1, json!("n1")));
    // Past the TTL a failure keeps the last good answer, stale with its error.
    let v = cache.read(1, at(121), fail(calls.clone(), None)).await;
    assert_eq!(count(), 2);
    assert_eq!(v["observedAt"], "n1");
    assert_eq!(v["commits"][0]["sha"], 1);
    assert_eq!(v["stale"], true);
    assert!(v["error"].as_str().unwrap().starts_with("unavailable:"));
    // At least 30 s between attempts, failed ones included.
    let v = cache.read(1, at(150), ok(calls.clone())).await;
    assert_eq!((count(), v["stale"].clone()), (2, json!(true)));
    let v = cache.read(1, at(151), ok(calls.clone())).await;
    assert_eq!(
        (count(), v["stale"].clone(), v["observedAt"].clone()),
        (3, json!(false), json!("n3"))
    );
    assert!(v.get("error").is_none());
    // A partial answer is new data that is still stale and retried after 30 s.
    let partial = |calls: Arc<AtomicUsize>| {
        move |_p: Option<Value>| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            (
                Some(good(99)),
                Some(activity::Failure {
                    message: "Actions runs: forbidden: no".into(),
                    until: None,
                }),
            )
        }
    };
    let v = cache.read(1, at(300), partial(calls.clone())).await;
    assert_eq!(
        (count(), v["observedAt"].clone(), v["stale"].clone()),
        (4, json!("n99"), json!(true))
    );
    let v = cache.read(1, at(320), ok(calls.clone())).await;
    assert_eq!(count(), 4);
    assert_eq!(v["error"], "Actions runs: forbidden: no");
    // A rate limit pauses every repository until its cooldown ends.
    cache.read(2, at(300), ok(calls.clone())).await;
    assert_eq!(count(), 5);
    let v = cache
        .read(1, at(331), fail(calls.clone(), Some(at(331 + 300))))
        .await;
    assert_eq!(count(), 6);
    assert!(v["error"].as_str().unwrap().starts_with("rate_limited:"));
    let v = cache.read(2, at(500), ok(calls.clone())).await;
    assert_eq!(count(), 6, "the cooldown is shared");
    assert_eq!(
        (v["observedAt"].clone(), v["stale"].clone()),
        (json!("n5"), json!(true))
    );
    assert!(v["error"].as_str().unwrap().starts_with("rate_limited:"));
    let v = cache.read(1, at(600), ok(calls.clone())).await;
    assert_eq!(count(), 6);
    assert_eq!(v["observedAt"], "n99");
    let v = cache.read(2, at(632), ok(calls.clone())).await;
    assert_eq!(count(), 7);
    assert_eq!(v["stale"], false);
    assert!(v.get("error").is_none());
    // A first read that fails has nothing to keep and says so.
    let v = cache
        .read(5, at(700), |_p: Option<Value>| async {
            (
                None,
                Some(activity::Failure {
                    message: "not_found: gone".into(),
                    until: None,
                }),
            )
        })
        .await;
    assert_eq!(
        v,
        json!({"observedAt":null,"commits":[],"pulls":[],"runs":[],"error":"not_found: gone","stale":true})
    );
    // Concurrent readers of one repository share one read.
    let slow = |calls: Arc<AtomicUsize>| {
        move |_p: Option<Value>| async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            (Some(good(n)), None)
        }
    };
    let (a, b) = tokio::join!(
        cache.read(3, at(700), slow(calls.clone())),
        cache.read(3, at(700), slow(calls.clone()))
    );
    assert_eq!(count(), 8);
    assert_eq!(a, b);
}

#[cfg(unix)]
#[tokio::test]
async fn activity_endpoint_reads_linked_repositories_through_gh() {
    use axum::body::Body;
    use std::os::unix::fs::PermissionsExt;
    use tower::ServiceExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("gh-fixture.py");
    std::fs::write(
        dir.path().join("graphql.json"),
        json!({"data":activity_fixture(7)}).to_string(),
    )
    .unwrap();
    std::fs::write(dir.path().join("runs.json"), runs_fixture(7).to_string()).unwrap();
    std::fs::write(&script, r#"#!/usr/bin/python3
import sys,json
from pathlib import Path
root=Path(__file__).parent
args=sys.argv[1:]
assert args[:3]==['api','--hostname','github.com'], args
endpoint=next(a for a in args if a=='graphql' or a.startswith('repos/'))
with (root/'requests').open('a') as f: f.write(endpoint+(' etag' if 'If-None-Match: "runs-1"' in args else '')+'\n')
if (root/'fail').exists():
 print("gh: Could not resolve to a Repository with the name 'owner/repo'. fake-private-diagnostic",file=sys.stderr);sys.exit(1)
if endpoint=='graphql':
 assert args[3:5]==['--method','POST'] and args[-2:]==['--input','-'], args
 body=json.load(sys.stdin)
 assert body['variables']=={'owner':'owner','name':'repo'}, body
 assert body['query'].startswith('query('), body
 print((root/'graphql.json').read_text(encoding='utf-8'))
else:
 assert endpoint=='repos/owner/repo/actions/runs?per_page=5&exclude_pull_requests=true', endpoint
 assert args[3:5]==['--method','GET'] and '--include' in args, args
 if 'If-None-Match: "runs-1"' in args:
  print('HTTP/2.0 304 Not Modified\r\nEtag: "runs-1"\r\n\r\n');sys.exit(0)
 print('HTTP/2.0 200 OK\r\nEtag: "runs-1"\r\n\r\n'+(root/'runs.json').read_text(encoding='utf-8'))
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut ws =
        Workspace::new(dir.path().join("data"), "/fixture".into(), "unused".into()).unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = script.to_str().unwrap().into();
    let (p, empty) = ws
        .stored(|s| {
            let p = s.create_project("App", Default::default())?;
            let empty = s.create_project("Empty", Default::default())?;
            s.github_link_repo(
                &p.id,
                &Repository {
                    id: 7,
                    full_name: "owner/repo".into(),
                },
            )?;
            Ok((p.id, empty.id))
        })
        .await
        .unwrap();
    let requests = || {
        std::fs::read_to_string(dir.path().join("requests"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let get = |project: String| {
        let ws = ws.clone();
        async move {
            let response = router()
                .with_state(ws)
                .oneshot(
                    axum::http::Request::get(format!("/api/projects/{project}/repo-activity"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(response.status().is_success());
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            serde_json::from_slice::<Value>(&bytes).unwrap()
        }
    };

    let page = get(p.clone()).await;
    assert!(page["observedAt"].is_string());
    let repo = &page["repositories"][0];
    assert_eq!(page["repositories"].as_array().unwrap().len(), 1);
    assert_eq!(repo["id"], 7);
    assert_eq!(repo["fullName"], "owner/repo");
    assert_eq!(repo["url"], "https://github.com/owner/repo");
    assert_eq!(repo["defaultBranch"], "main");
    assert_eq!(repo["commits"].as_array().unwrap().len(), 5);
    assert_eq!(repo["pulls"][0]["ci"]["state"], "success");
    assert_eq!(
        repo["runs"][0]["url"],
        "https://github.com/owner/repo/actions/runs/901"
    );
    assert_eq!(repo["stale"], false);
    assert!(repo["observedAt"].is_string());
    assert!(repo.get("error").is_none() && repo.get("runsEtag").is_none());
    assert_eq!(requests().len(), 2);
    // Fresh answers do not ask GitHub again; no repositories, no block.
    get(p.clone()).await;
    assert_eq!(requests().len(), 2);
    assert_eq!(get(empty).await["repositories"], json!([]));
    // An unchanged runs page is a conditional 304 and keeps the runs.
    ws.github
        .activity
        .age(activity::TTL + Duration::from_secs(1));
    let page = get(p.clone()).await;
    assert_eq!(
        requests()[3],
        "repos/owner/repo/actions/runs?per_page=5&exclude_pull_requests=true etag"
    );
    assert_eq!(page["repositories"][0]["runs"][1]["status"], "in_progress");
    assert_eq!(page["repositories"][0]["stale"], false);
    // A failure keeps the last good data, marked stale, without diagnostics.
    std::fs::write(dir.path().join("fail"), "").unwrap();
    ws.github
        .activity
        .age(activity::TTL + Duration::from_secs(1));
    let page = get(p.clone()).await;
    let repo = &page["repositories"][0];
    assert_eq!(repo["stale"], true);
    assert!(repo["error"].as_str().unwrap().starts_with("not_found:"));
    assert_eq!(repo["commits"][0]["title"], "Fix 中文 parsing");
    assert!(!page.to_string().contains("fake-private-diagnostic"));
    assert_eq!(requests().len(), 5);
    // Within 30 s of that attempt nothing is read again.
    get(p).await;
    assert_eq!(requests().len(), 5);
}
