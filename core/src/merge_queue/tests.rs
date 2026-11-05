use super::checks::{self, Hold};
use super::*;
use crate::{github::client::Repository, model::AgentDetail, store::Store};

fn sha(c: char) -> String {
    std::iter::repeat_n(c, 40).collect()
}
/// The released head, main, an older main, the PR's merge ref and its tree.
fn head() -> String {
    sha('1')
}
fn main_sha() -> String {
    sha('2')
}
fn old_main() -> String {
    sha('3')
}
fn merge_sha() -> String {
    sha('4')
}
fn tree() -> String {
    sha('5')
}

fn agent(s: &Store, id: &str, name: &str) {
    s.insert(&serde_json::from_value::<AgentDetail>(json!({"agent":{"id":id,"name":name,"cwd":"/workspace","model":"test",
        "color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap())
    .unwrap();
}
fn review(s: &Store, task: &str, head: &str, conclusion: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let data = json!({"id":id,"status":"completed","conclusion":conclusion,"headSha":head,"round":1,
        "findings":[],"coverage":{"coveredFileCount":3,"fileCount":3}});
    s.db.write()
        .unwrap()
        .execute(
            "INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES(?1,?2,'7:pull:11','completed',?3)",
            rusqlite::params![id, task, data.to_string()],
        )
        .unwrap();
    id
}
/// A Project with two leads; the task is dispatched by "lead" to "dev", its PR
/// #11 is linked and reviewed at the head, and the queue is on for the repo.
fn setup(s: &Store) -> String {
    let project = s.create_project("Merge", Default::default()).unwrap();
    let repo = Repository { id: 7, full_name: "owner/repo".into() };
    s.github_link_repo(&project.id, &repo).unwrap();
    for (id, name) in [("lead", "Lead"), ("lead2", "Lead 2"), ("dev", "Dev")] {
        agent(s, id, name);
    }
    s.set_agent_project("lead", Some(&project.id)).unwrap();
    s.set_agent_project("lead2", Some(&project.id)).unwrap();
    crate::agent_roles::save(s, &project.id, 0, vec!["lead".into(), "lead2".into()]).unwrap();
    let task = s
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Merge PR","projectId":project.id}))
        .unwrap()["task"]
        .clone();
    let id = task["id"].as_str().unwrap().to_owned();
    s.collaboration_call(Some("lead"), "task_dispatch", json!({"requestId":"d","taskId":id,"expectedVersion":task["version"],"toAgentId":"dev"}))
        .unwrap();
    s.github_link_object(&id, &repo, "pull", 11, json!({"headSha":head(),"state":"open"})).unwrap();
    review(s, &id, &head(), "no_findings");
    s.merge_set_enabled(7, true).unwrap();
    id
}

fn log(merge: &str) -> String {
    format!(
        "\u{feff}2026-11-05T05:01:53.1Z ##[group]Run actions/checkout\n2026-11-05T05:01:54.2Z HEAD is now at {} Merge {} into {}\n2026-11-05T05:02:00.0Z ok\n",
        &merge[..7],
        head(),
        main_sha()
    )
}
/// GitHub with everything green: main at main_sha(), the merge ref is
/// main + head, and both CI jobs checked out exactly that merge.
fn green() -> Value {
    let mut commits = serde_json::Map::new();
    let commit = |sha: String, tree: String, parents: Vec<String>| json!({"sha":sha,"tree":tree,"parents":parents});
    commits.insert(main_sha(), commit(main_sha(), sha('6'), vec![old_main()]));
    commits.insert(merge_sha(), commit(merge_sha(), tree(), vec![main_sha(), head()]));
    commits.insert(sha('7'), commit(sha('7'), sha('8'), vec![old_main(), head()]));
    commits.insert(sha('9'), commit(sha('9'), sha('8'), vec![main_sha(), head()]));
    json!({"pull":{"number":11,"state":"open","draft":false,"merged":false,"merged_at":null,"mergeable":true,"mergeable_state":"clean",
            "head":{"sha":head()},"base":{"ref":"main","sha":main_sha()}},
        "main":main_sha(),"merge":merge_sha(),"commits":commits,
        "mainRuns":[{"id":90,"name":"CI","head_sha":main_sha(),"status":"completed","conclusion":"success"}],
        "runs":[{"id":41,"name":"CI","run_attempt":1,"status":"completed","conclusion":"failure","head_sha":head()},
                {"id":42,"name":"CI","run_attempt":1,"status":"completed","conclusion":"success","head_sha":head()}],
        "jobs":{"42":[{"id":501,"name":"Core (build and test)","conclusion":"success"},{"id":502,"name":"Web UI","conclusion":"success"},
                      {"id":503,"name":"Docs","conclusion":"skipped"}]},
        "logs":{"501":log(&merge_sha()),"502":log(&merge_sha())},"calls":[]})
}

#[cfg(unix)]
fn fake_gh(root: &std::path::Path, state: Value) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(root.join("gh.json"), state.to_string()).unwrap();
    let script = root.join("gh.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib
p=pathlib.Path(__file__).with_name('gh.json')
s=json.loads(p.read_text()); a=sys.argv[1:]
method=a[a.index('--method')+1]
ep=next(v for v in a if v.startswith('repos/'))
s['calls'].append({'method':method,'endpoint':ep}); p.write_text(json.dumps(s))
include='--include' in a
def out(code,data):
    if include:
        sys.stdout.write('HTTP/2.0 '+{200:'200 OK',404:'404 Not Found'}[code]+'\r\nEtag: "'+str(len(s['calls']))+'"\r\n\r\n'+json.dumps(data))
    else:
        sys.stdout.write(data if isinstance(data,str) else json.dumps(data))
    if code!=200:
        print('HTTP '+str(code),file=sys.stderr); sys.exit(1)
    sys.exit(0)
path=ep[len('repos/owner/repo/'):]
c=s['commits']
if method!='GET': out(404,{})
if path=='pulls/11': out(200,s['pull'])
if path=='git/ref/heads/main': out(200,{'object':{'sha':s['main']}})
if path=='branches/main': out(200,{'commit':{'sha':s.get('branchMain',s['main'])}})
if path=='git/ref/pull/11/merge':
    out(200,{'object':{'sha':s['merge']}}) if s['merge'] else out(404,{})
if path.startswith('git/commits/'):
    k=c[path.split('/')[-1]]; out(200,{'sha':k['sha'],'tree':{'sha':k['tree']},'parents':[{'sha':x} for x in k['parents']]})
if path.startswith('commits/'):
    k=next(v for n,v in c.items() if n.startswith(path.split('/')[-1]))
    out(200,{'sha':k['sha'],'parents':[{'sha':x} for x in k['parents']],'commit':{'tree':{'sha':k['tree']}}})
if path.startswith('actions/runs?branch='): out(200,{'workflow_runs':s['mainRuns']})
if path.startswith('actions/runs?head_sha='): out(200,{'workflow_runs':s['runs']})
if path.startswith('actions/runs/') and '/jobs' in path: out(200,{'jobs':s['jobs'][path.split('/')[2]]})
if path.startswith('actions/jobs/') and path.endswith('/logs'): out(200,s['logs'][path.split('/')[2]])
out(404,{})
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_string_lossy().into_owned()
}
fn change(root: &std::path::Path, f: impl FnOnce(&mut Value)) {
    let path = root.join("gh.json");
    let mut state: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    f(&mut state);
    std::fs::write(path, state.to_string()).unwrap();
}
fn calls(root: &std::path::Path) -> Vec<Value> {
    let state: Value = serde_json::from_slice(&std::fs::read(root.join("gh.json")).unwrap()).unwrap();
    state["calls"].as_array().unwrap().clone()
}

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    task: String,
}
#[cfg(unix)]
fn lab(state: Value) -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let program = fake_gh(dir.path(), state);
    let mut ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program;
    let task = setup(&ws.store);
    Lab { dir, ws, task }
}
impl Lab {
    async fn release(&self, actor: Option<&str>, key: &str) -> Result<Value> {
        self.ws
            .collaboration_call(actor, "merge_enqueue", json!({"requestId":key,"taskId":self.task,
                "pullUrl":"https://github.com/owner/repo/pull/11","headSha":head()}))
            .await
    }
    async fn entry(&self) -> Value {
        self.ws.collaboration_call(Some("lead"), "merge_get", json!({"taskId":self.task})).await.unwrap()
    }
    /// The next check is due now, whatever wait the last one set.
    fn due(&self) {
        self.ws.store.db.write().unwrap().execute("UPDATE merge_entries SET next_check=0", []).unwrap();
    }
    fn comments(&self) -> Vec<String> {
        let db = self.ws.store.db.read().unwrap();
        let mut q = db.prepare("SELECT json_extract(data,'$.body') FROM collaboration_task_activity WHERE task_id=?1 AND json_extract(data,'$.kind')='comment' ORDER BY seq").unwrap();
        q.query_map([&self.task], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
    }
    fn mail(&self, agent: &str) -> Vec<Value> {
        let read = self.ws.store.collaboration_call(None, "peer_read", json!({"agentId":agent})).unwrap();
        read["messages"].as_array().unwrap().iter().filter(|m| m["metadata"]["kind"] == "merge").cloned().collect()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_released_head_with_green_ci_on_the_current_main_is_ready_and_nothing_is_written() {
    let lab = lab(green());
    let released = lab.release(Some("lead"), "r1").await.unwrap();
    assert_eq!(released["state"], "queued");
    assert_eq!(released["mainAtRelease"], main_sha(), "the release keeps the main of its moment");
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "ready", "every gate held: {e}");
    let ev = &e["evidence"];
    assert_eq!(ev["gate"]["kind"], "slot");
    assert_eq!(ev["gate"]["tree"], tree());
    assert_eq!(ev["gate"]["mergeRef"]["parents"], json!([main_sha(), head()]));
    let jobs = ev["gate"]["runs"][0]["jobs"].as_array().unwrap();
    assert_eq!(ev["gate"]["runs"][0]["run"], 42, "the newest CI run decides, not the older red one");
    assert_eq!(jobs.len(), 2, "the skipped job proves nothing and is not listed: {jobs:?}");
    assert!(jobs.iter().all(|j| j["checkout"] == merge_sha() && j["logSha256"].as_str().is_some_and(|h| h.len() == 64)));
    assert_eq!(ev["review"]["conclusion"], "no_findings");
    assert_eq!(ev["main"]["before"], main_sha());
    assert_eq!(ev["main"]["atRelease"], main_sha());
    assert_eq!(ev["wouldMerge"], json!({"method":"merge","sha":head(),"endpoint":"repos/owner/repo/pulls/11/merge"}));
    assert_eq!(ev["dryRun"], true);
    assert!(calls(lab.dir.path()).iter().all(|c| c["method"] == "GET"), "a dry run writes nothing to GitHub");
    assert!(lab.comments().iter().any(|c| c.contains("is ready to merge") && c.contains("Nothing was written to GitHub")));
    assert_eq!(lab.mail("lead").len(), 1, "the releasing lead is told once");
    assert_eq!(lab.mail("dev").len(), 1, "and so is the task's executor");
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.mail("lead").len(), 1, "a ready entry is not checked or announced again");
}

#[cfg(unix)]
#[tokio::test]
async fn each_gate_stops_with_its_reason_and_says_what_it_saw() {
    type Mutation = fn(&mut Value);
    let cases: Vec<(&str, Mutation, &str)> = vec![
        ("head_moved", (|s: &mut Value| s["pull"]["head"]["sha"] = json!(sha('a'))) as Mutation, "not the released head"),
        ("pr_not_open", (|s: &mut Value| s["pull"]["draft"] = json!(true)) as Mutation, "The PR is a draft"),
        ("main_red", (|s: &mut Value| {
            s["mainRuns"].as_array_mut().unwrap().insert(0, json!({"id":91,"name":"CI","head_sha":sha('b'),"status":"completed","conclusion":"failure"}))
        }) as Mutation, "Main CI run 91"),
        ("ci_red", (|s: &mut Value| s["runs"][1]["conclusion"] = json!("failure")) as Mutation, "CI run 42 attempt 1 on the head concluded failure"),
        ("conflict", (|s: &mut Value| s["pull"]["mergeable"] = json!(false)) as Mutation, "cannot merge into its base"),
        ("merge_blocked", (|s: &mut Value| s["pull"]["mergeable_state"] = json!("blocked")) as Mutation, "merge state as blocked"),
        ("needs_batch", (|s: &mut Value| {
            s["logs"]["501"] = json!(log(&sha('7')));
            s["logs"]["502"] = json!(log(&sha('7')));
        }) as Mutation, "not the current main"),
        ("checkout_mismatch", (|s: &mut Value| s["logs"]["502"] = json!(log(&sha('9')))) as Mutation, "which is not the merge of the current main and the head"),
        ("checkout_unproven", (|s: &mut Value| s["logs"]["501"] = json!("no checkout in this log\n")) as Mutation, "shows no checkout of a merge commit"),
    ];
    for (reason, mutate, detail) in cases {
        let lab = lab(green());
        lab.release(Some("lead"), "r1").await.unwrap();
        change(lab.dir.path(), mutate);
        tick(&lab.ws).await.unwrap();
        let e = lab.entry().await;
        assert_eq!(e["state"], "stopped", "{reason}: {e}");
        assert_eq!(e["reason"], reason, "{reason}: {}", e["detail"]);
        assert!(e["detail"].as_str().unwrap().contains(detail), "{reason}: {}", e["detail"]);
        assert_eq!(e["evidence"]["stop"]["reason"], reason);
        assert!(lab.comments().iter().any(|c| c.contains(&format!("stopped ({reason})"))), "{reason}: the stop is on the task");
        assert_eq!(lab.mail("lead").len(), 1, "{reason}: the lead is told");
        assert!(calls(lab.dir.path()).iter().all(|c| c["method"] == "GET"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_newer_review_round_at_another_head_stops_the_released_one() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    review(&lab.ws.store, &lab.task, &sha('a'), "no_findings");
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["reason"], "review_not_passing", "{e}");
    assert!(e["detail"].as_str().unwrap().contains("not the released head"), "{}", e["detail"]);
}

#[cfg(unix)]
#[tokio::test]
async fn an_unfinished_run_waits_and_the_entry_becomes_ready_once_it_is_green() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["runs"][1]["status"] = json!("in_progress");
        s["runs"][1]["conclusion"] = Value::Null;
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("waiting"), json!("waiting")), "{e}");
    assert!(e["detail"].as_str().unwrap().contains("CI run 42 on the head is in_progress"), "{}", e["detail"]);
    assert!(e["nextCheck"].as_i64().unwrap() > chrono::Utc::now().timestamp(), "a wait sets a later check");
    assert!(lab.mail("lead").is_empty(), "waiting is not announced");
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["checks"], 1, "a waiting entry is not checked before its time");
    change(lab.dir.path(), |s| {
        s["runs"][1]["status"] = json!("completed");
        s["runs"][1]["conclusion"] = json!("success");
    });
    lab.due();
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["state"], "ready");
}

#[cfg(unix)]
#[tokio::test]
async fn only_the_dispatching_lead_or_the_user_may_release_a_reviewed_head() {
    let lab = lab(green());
    let refused = |r: Result<Value>| r.unwrap_err().to_string();
    assert!(refused(lab.release(Some("dev"), "x").await).contains("the task's executor cannot release its own PR"));
    assert!(refused(lab.release(Some("lead2"), "x").await).contains("only the task's dispatcher"));
    lab.ws.store.merge_set_enabled(7, false).unwrap();
    assert!(refused(lab.release(Some("lead"), "x").await).starts_with("merge_queue_disabled"));
    lab.ws.store.merge_set_enabled(7, true).unwrap();
    review(&lab.ws.store, &lab.task, &head(), "changes_requested");
    assert!(refused(lab.release(Some("lead"), "x").await).contains("concluded changes_requested, which does not pass"));
    review(&lab.ws.store, &lab.task, &sha('a'), "no_findings");
    assert!(refused(lab.release(Some("lead"), "x").await).contains("not the released head"));
    review(&lab.ws.store, &lab.task, &head(), "no_findings");
    let other = lab.ws.collaboration_call(Some("lead"), "merge_enqueue", json!({"requestId":"x","taskId":lab.task,
        "pullUrl":"https://github.com/owner/repo/pull/12","headSha":head()})).await;
    assert!(refused(other).contains("not linked to the task"));
    assert!(calls(lab.dir.path()).is_empty(), "a refused release reads nothing from GitHub");

    let first = lab.release(Some("lead"), "r1").await.unwrap();
    assert_eq!(lab.release(Some("lead"), "r1").await.unwrap()["id"], first["id"], "a retry of the same request is the same entry");
    let conflict = lab.ws.collaboration_call(Some("lead"), "merge_enqueue", json!({"requestId":"r1","taskId":lab.task,
        "pullUrl":"https://github.com/owner/repo/pull/11","headSha":head(),"note":"different"})).await;
    assert!(refused(conflict).starts_with("idempotency_conflict"));
    assert!(refused(lab.release(Some("lead"), "r2").await).starts_with("merge_already_queued"));
    lab.ws.collaboration_call(None, "merge_cancel", json!({"requestId":"c","entryId":first["id"]})).await.unwrap();
    let by_user = lab.release(None, "u1").await.unwrap();
    assert_eq!(by_user["release"]["by"]["kind"], "user", "the user may release without a dispatch");
}

#[cfg(unix)]
#[tokio::test]
async fn cancel_and_retry_belong_to_the_releaser_and_a_late_check_is_dropped() {
    let lab = lab(green());
    change(lab.dir.path(), |s| s["runs"][1]["conclusion"] = json!("failure"));
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let id = e["id"].as_str().unwrap().to_owned();
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["reason"], "ci_red");
    let retry = |actor: Option<&'static str>, key: &'static str| {
        let ws = lab.ws.clone();
        let id = id.clone();
        async move { ws.collaboration_call(actor, "merge_retry", json!({"requestId":key,"entryId":id})).await }
    };
    assert!(retry(Some("lead2"), "x").await.unwrap_err().to_string().contains("only the Agent that released this merge"));
    change(lab.dir.path(), |s| s["runs"][1]["conclusion"] = json!("success"));
    assert_eq!(retry(Some("lead"), "t1").await.unwrap()["state"], "queued");
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["state"], "ready", "the retry checked everything again");

    let cancelled = lab.ws.collaboration_call(Some("lead"), "merge_cancel", json!({"requestId":"c1","entryId":id})).await.unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    let attempt = cancelled["attempt"].as_i64().unwrap() - 1;
    let late = lab.ws.store.merge_record(&id, attempt, Ok((json!({}), Ok(()))), 0).unwrap();
    assert!(!late, "a check that began before the cancel changes nothing");
    assert_eq!(lab.entry().await["state"], "cancelled");
}

#[test]
fn the_checkout_line_and_the_newest_run_of_each_workflow_are_read_exactly() {
    let line = checks::checkout_line(log(&merge_sha()).as_bytes()).unwrap();
    assert_eq!(line, (merge_sha()[..7].to_owned(), head(), main_sha()));
    assert_eq!(checks::checkout_line(b"HEAD is now at abc Merge x into y\n"), None, "short or malformed SHAs are no proof");
    let runs = vec![
        json!({"id":1,"name":"CI","status":"completed","conclusion":"failure","run_attempt":1}),
        json!({"id":2,"name":"CI","status":"completed","conclusion":"success","run_attempt":1}),
        json!({"id":3,"name":"Desktop macOS","status":"completed","conclusion":"success","run_attempt":2}),
    ];
    let newest = checks::head_runs(&runs, &["Desktop macOS".into()]).unwrap();
    assert_eq!(newest.iter().map(|r| r["id"].as_u64().unwrap()).collect::<Vec<_>>(), [2, 3]);
    assert_eq!(
        checks::head_runs(&runs[..2], &["Desktop macOS".into()]),
        Err(Hold::Wait("No run of workflow Desktop macOS on the head yet".into()))
    );
    let main = vec![
        json!({"id":9,"name":"CI","head_sha":"new","conclusion":null,"status":"in_progress"}),
        json!({"id":8,"name":"CI","head_sha":"since","conclusion":"cancelled","status":"completed"}),
        json!({"id":7,"name":"CI","head_sha":"older","conclusion":"failure","status":"completed"}),
    ];
    assert!(checks::main_health(&main, "since").is_ok(), "runs before the release main do not count");
    assert!(matches!(checks::main_health(&main, "elsewhere"), Err(Hold::Stop("main_red", _))));
}

#[cfg(unix)]
#[tokio::test]
async fn a_job_log_read_stops_at_its_limit() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("gh.py");
    std::fs::write(&script, "#!/usr/bin/python3\nimport sys\nsys.stdout.write('x'*(5000 if 'jobs/1/logs' in ' '.join(sys.argv) else 10))\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let client = crate::github::client::Client { program: script.to_string_lossy().into(), deadline: std::time::Duration::from_secs(5) };
    let (bytes, truncated) = client.log_prefix("repos/o/r/actions/jobs/1/logs", 1000).await.unwrap();
    assert_eq!((bytes.len(), truncated), (1000, true));
    let (bytes, truncated) = client.log_prefix("repos/o/r/actions/jobs/2/logs", 1000).await.unwrap();
    assert_eq!((bytes.len(), truncated), (10, false));
}

#[test]
fn the_routes_and_tools_are_well_formed() {
    let _ = router();
    let tools = tool_definitions();
    assert_eq!(
        tools.iter().map(|t| t["name"].as_str().unwrap()).collect::<Vec<_>>(),
        ["merge_enqueue", "merge_get", "merge_list", "merge_cancel", "merge_retry"]
    );
    for tool in tools {
        let _: rmcp::model::Tool = serde_json::from_value(tool).unwrap();
    }
    assert!(
        crate::collaboration_store::tool_definitions().iter().any(|t| t["name"] == "merge_enqueue"),
        "the queue's tools are offered to Agents"
    );
}
