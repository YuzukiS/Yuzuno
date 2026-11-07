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
/// A task's internal ID; tools take its "T-n" reference, tables the ID.
fn internal(s: &Store, task: &str) -> String {
    crate::collaboration_store::task_key(&s.db.read().unwrap(), task).unwrap().0
}
fn review(s: &Store, task: &str, head: &str, conclusion: &str) -> String {
    let task = internal(s, task);
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
/// Core's batch commit (main + head), the batch PR's merge ref, and the
/// merge commit GitHub makes on main.
fn batch_commit() -> String {
    sha('e')
}
fn batch_merge_ref() -> String {
    sha('0')
}
fn merge_commit() -> String {
    sha('f')
}
/// GitHub with everything green: main at main_sha(), the merge ref is
/// main + head, and both CI jobs checked out exactly that merge. A merge
/// lands merge_commit() with the tested tree.
fn green() -> Value {
    let mut commits = serde_json::Map::new();
    let commit = |sha: String, tree: String, parents: Vec<String>| json!({"sha":sha,"tree":tree,"parents":parents});
    commits.insert(main_sha(), commit(main_sha(), sha('6'), vec![old_main()]));
    commits.insert(merge_sha(), commit(merge_sha(), tree(), vec![main_sha(), head()]));
    commits.insert(sha('7'), commit(sha('7'), sha('8'), vec![old_main(), head()]));
    commits.insert(sha('9'), commit(sha('9'), sha('8'), vec![main_sha(), head()]));
    commits.insert(batch_merge_ref(), commit(batch_merge_ref(), tree(), vec![main_sha(), batch_commit()]));
    json!({"pull":{"number":11,"state":"open","draft":false,"merged":false,"merged_at":null,"mergeable":true,"mergeable_state":"clean",
            "head":{"sha":head(),"ref":"feature"},"base":{"ref":"main","sha":main_sha(),"repo":{"default_branch":"main"}}},
        "main":main_sha(),"merge":merge_sha(),"commits":commits,
        "mainRuns":[{"id":90,"name":"CI","head_sha":main_sha(),"status":"completed","conclusion":"success","created_at":"2026-11-05T05:00:00Z"}],
        "runs":[{"id":41,"name":"CI","run_attempt":1,"status":"completed","conclusion":"failure","head_sha":head()},
                {"id":42,"name":"CI","run_attempt":1,"status":"completed","conclusion":"success","head_sha":head()}],
        "batchRuns":[],
        "jobs":{"42":[{"id":501,"name":"Core (build and test)","conclusion":"success"},{"id":502,"name":"Web UI","conclusion":"success"},
                      {"id":503,"name":"Docs","conclusion":"skipped"}],
                "60":[{"id":601,"name":"Core (build and test)","conclusion":"success"},{"id":602,"name":"Web UI","conclusion":"success"}]},
        "logs":{"501":log(&merge_sha()),"502":log(&merge_sha()),"601":log(&batch_merge_ref()),"602":log(&batch_merge_ref())},
        "refs":{},"pulls":{},"batchCommit":batch_commit(),"batchTree":tree(),"mergeSha":merge_commit(),"mergeTree":tree(),
        "mergeAnswers":[],"calls":[]})
}
/// The batch's CI finished green on its own merge ref.
fn batch_green(s: &mut Value) {
    s["batchRuns"] = json!([{"id":60,"name":"CI","run_attempt":1,"status":"completed","conclusion":"success","head_sha":batch_commit()}]);
}
/// Main's push CI on the merge commit finished with `conclusion`.
fn main_ci(s: &mut Value, conclusion: &str) {
    let run = json!({"id":95,"name":"CI","run_attempt":1,"head_sha":merge_commit(),"status":"completed","conclusion":conclusion,
        "created_at":chrono::Utc::now().to_rfc3339(),"html_url":"https://github.com/owner/repo/actions/runs/95"});
    s["mainRuns"].as_array_mut().unwrap().insert(0, run);
}
/// Main moves on to `to`: GitHub's merge ref is now `merge` = `to` + head,
/// and both CI jobs checked it out.
fn move_main(s: &mut Value, to: String, merge: String) {
    s["commits"][&to] = json!({"sha":to,"tree":sha('6'),"parents":[main_sha()]});
    s["commits"][&merge] = json!({"sha":merge,"tree":tree(),"parents":[to, head()]});
    s["logs"]["501"] = json!(log(&merge));
    s["logs"]["502"] = json!(log(&merge));
    s["pull"]["base"]["sha"] = json!(to);
    s["main"] = json!(to);
    s["merge"] = json!(merge);
}

#[cfg(unix)]
fn fake_gh(root: &std::path::Path, state: Value) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(root.join("gh.json"), state.to_string()).unwrap();
    let script = root.join("gh.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib,time
p=pathlib.Path(__file__).with_name('gh.json')
s=json.loads(p.read_text()); a=sys.argv[1:]
method=a[a.index('--method')+1]
ep=next(v for v in a if v.startswith('repos/'))
body=json.loads(sys.stdin.read() or 'null') if '--input' in a else None
s['calls'].append({'method':method,'endpoint':ep,'body':body}); p.write_text(json.dumps(s))
include='--include' in a
def save(): p.write_text(json.dumps(s))
def out(code,data,link=None):
    if include:
        status={200:'200 OK',201:'201 Created',204:'204 No Content',404:'404 Not Found',405:'405 Method Not Allowed',409:'409 Conflict',422:'422 Unprocessable Entity',429:'429 Too Many Requests',502:'502 Bad Gateway'}[code]
        sys.stdout.write('HTTP/2.0 '+status+'\r\nEtag: "'+str(len(s['calls']))+'"\r\n'+('Link: '+link+'\r\n' if link else '')+'\r\n'+('' if data is None else json.dumps(data)))
    else:
        sys.stdout.write(data if isinstance(data,str) else json.dumps(data))
    if code>=300:
        print('HTTP '+str(code),file=sys.stderr); sys.exit(1)
    sys.exit(0)
path=ep[len('repos/owner/repo/'):]
query=dict(x.split('=',1) for x in path.split('?',1)[1].split('&')) if '?' in path else {}
c=s['commits']
if method=='POST' and path=='git/refs':
    name=body['ref'][len('refs/heads/'):]
    if name in s['refs']: out(422,{'message':'Reference already exists'})
    q=s.get('refAnswers') or []
    answer=q.pop(0) if q else None
    s['refs'][name]=body['sha']; save()
    if answer=='lost': out(502,{'message':'Bad gateway'})
    out(201,{'ref':body['ref'],'object':{'sha':body['sha']}})
if method=='POST' and path=='merges':
    if s.get('batchConflict'): out(409,{'message':'Merge conflict'})
    k={'sha':s['batchCommit'],'tree':s['batchTree'],'parents':[s['refs'][body['base']],body['head']]}
    c[k['sha']]=k; s['refs'][body['base']]=k['sha']; save()
    out(201,{'sha':k['sha'],'commit':{'tree':{'sha':k['tree']}},'parents':[{'sha':x} for x in k['parents']]})
if method=='POST' and path=='pulls':
    n='900'; s['pulls'][n]={'number':900,'state':'open','head':{'ref':body['head'],'sha':s['refs'][body['head']]},'base':{'ref':body['base']},'draft':body['draft']}
    save(); out(201,s['pulls'][n])
if method=='PATCH' and path.startswith('pulls/') and path.split('/')[1] in s['pulls']:
    s['pulls'][path.split('/')[1]]['state']=body['state']; save(); out(200,s['pulls'][path.split('/')[1]])
if method=='DELETE' and path.startswith('git/refs/heads/'):
    q=s.get('deleteAnswers') or []
    answer=q.pop(0) if q else None
    if answer=='502':
        save(); out(502,{'message':'Bad gateway'})
    if answer=='429':
        save(); out(429,{'message':'API rate limit exceeded'})
    s['refs'].pop(path[len('git/refs/heads/'):],None); save(); out(204,None)
if method=='PUT' and path=='pulls/11/merge':
    answer=s['mergeAnswers'].pop(0) if s['mergeAnswers'] else 'ok'; save()
    if answer in ('405','409'): out(int(answer),{'message':'Pull Request is not mergeable'})
    if answer=='429': out(429,{'message':'API rate limit exceeded'})
    if answer=='noauth':
        print('To get started with GitHub CLI, please run:  gh auth login',file=sys.stderr); sys.exit(4)
    if answer=='slowok': time.sleep(2)
    if answer=='hang':
        time.sleep(5); out(502,{'message':'Bad gateway'})
    if answer=='502': out(502,{'message':'Bad gateway'})
    if answer=='502down':
        s['pullDown']=True; save(); out(502,{'message':'Bad gateway'})
    if answer=='502move':
        s['main']=s['movedMain']; save(); out(502,{'message':'Bad gateway'})
    m={'sha':s['mergeSha'],'tree':s['mergeTree'],'parents':[s['main'],body['sha']]}
    c[m['sha']]=m; s['main']=m['sha']
    s['pull'].update({'merged':True,'state':'closed','merged_at':'now','merge_commit_sha':m['sha']}); save()
    if answer=='lost': out(502,{'message':'Bad gateway'})
    out(200,{'sha':m['sha'],'merged':True,'message':'Pull Request successfully merged'})
if method!='GET': out(404,{})
if path=='pulls/11' and s.get('pullDown'): out(502,{'message':'Bad gateway'})
if path=='pulls/11':
    q=s.get('pullQueue') or []
    d=q.pop(0) if q else s['pull']
    slow=s.pop('slowPull',None)
    save()
    if slow:
        p.with_name('pull-started').write_text('1'); time.sleep(2)
    out(200,d)
if path=='pulls/12' and s.get('pull12'): out(200,s['pull12'])
if path.startswith('pulls/') and path.split('/')[1] in s['pulls']: out(200,s['pulls'][path.split('/')[1]])
if path.startswith('git/ref/heads/queue/'):
    name=path[len('git/ref/heads/'):]
    out(200,{'object':{'sha':s['refs'][name]}}) if name in s['refs'] else out(404,{})
if path=='git/ref/heads/main': out(200,{'object':{'sha':s['main']}})
if path.startswith('git/ref/heads/') and path[len('git/ref/heads/'):] in s.get('branches',{}): out(200,{'object':{'sha':s['branches'][path[len('git/ref/heads/'):]]}})
if path=='branches/main': out(200,{'commit':{'sha':s.get('branchMain',s['main'])}})
if path=='git/ref/pull/11/merge':
    out(200,{'object':{'sha':s['merge']}}) if s['merge'] else out(404,{})
if path.startswith('compare/'):
    key=path[len('compare/'):].split('?')[0]
    out(200,s['compare'][key]) if key in s.get('compare',{}) else out(404,{'message':'Not Found'})
down=s.get('commitDown')
if path.startswith('git/commits/') and (down is True or down==path.split('/')[-1]): out(502,{'message':'Bad gateway'})
if path.startswith('git/commits/'):
    k=c[path.split('/')[-1]]; out(200,{'sha':k['sha'],'tree':{'sha':k['tree']},'parents':[{'sha':x} for x in k['parents']]})
if path.startswith('commits/') and '/check-runs' in path: out(200,{'total_count':len(s.get('checkRuns',[])),'check_runs':s.get('checkRuns',[])})
if path.startswith('commits/') and path.endswith('/status'): out(200,{'state':'pending','statuses':s.get('statuses',[])})
if path.startswith('commits/'):
    k=next(v for n,v in c.items() if n.startswith(path.split('/')[-1]))
    out(200,{'sha':k['sha'],'parents':[{'sha':x} for x in k['parents']],'commit':{'tree':{'sha':k['tree']}}})
if path.startswith('actions/runs?branch='): out(200,{'total_count':len(s['mainRuns']),'workflow_runs':s['mainRuns']})
if path.startswith('actions/runs?head_sha='):
    runs=s['batchRuns'] if query['head_sha']==s['batchCommit'] else s['runs']
    out(200,{'total_count':len(runs),'workflow_runs':runs})
if path.startswith('actions/runs/') and '/jobs' in path:
    jobs=s['jobs'][path.split('/')[2]]; per=int(query.get('per_page',100)); page=int(query.get('page',1))
    more=page*per<len(jobs)
    link='<https://api.github.com/'+ep.replace('&page='+str(page),'&page='+str(page+1))+'>; rel="next"' if more else None
    out(200,{'total_count':s.get('jobsTotal',len(jobs)),'jobs':jobs[(page-1)*per:page*per]},link)
if path.startswith('actions/jobs/') and path.endswith('/logs'):
    if '--allow-escape-sequences' in a and s.get('oldGh'):
        print('unknown flag: --allow-escape-sequences\n\nUsage:  gh api <endpoint> [flags]',file=sys.stderr); sys.exit(1)
    if '--allow-escape-sequences' not in a:
        print('fake gh: a job log read without --allow-escape-sequences would rewrite its escape sequences',file=sys.stderr); sys.exit(1)
    if s.get('slowLog'):
        p.with_name('log-started').write_text('1'); time.sleep(2)
    if s.get('mainOnLog'):
        s['main']=s.pop('mainOnLog'); s['pull']['base']['sha']=s['main']; save()
    out(200,s['logs'][path.split('/')[2]])
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
/// The writes the fake GitHub received, as "METHOD endpoint".
fn writes(root: &std::path::Path) -> Vec<String> {
    calls(root)
        .iter()
        .filter(|c| c["method"] != "GET")
        .map(|c| format!("{} {}", c["method"].as_str().unwrap(), c["endpoint"].as_str().unwrap()))
        .collect()
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
    /// The next step is due now, whatever wait the last one set.
    fn due(&self) {
        self.ws.store.db.write().unwrap().execute("UPDATE merge_entries SET next_check=0", []).unwrap();
    }
    async fn step(&self) -> Value {
        self.due();
        tick(&self.ws).await.unwrap();
        self.entry().await
    }
    fn comments(&self) -> Vec<String> {
        let db = self.ws.store.db.read().unwrap();
        let mut q = db.prepare("SELECT json_extract(data,'$.body') FROM collaboration_task_activity WHERE task_id=?1 AND json_extract(data,'$.kind')='comment' ORDER BY seq").unwrap();
        let task = crate::collaboration_store::task_key(&db, &self.task).unwrap().0;
        q.query_map([&task], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
    }
    fn mail(&self, agent: &str) -> Vec<Value> {
        let read = self.ws.store.collaboration_call(None, "peer_read", json!({"agentId":agent})).unwrap();
        read["messages"].as_array().unwrap().iter().filter(|m| m["metadata"]["kind"] == "merge").cloned().collect()
    }
    fn paused(&self) -> Value {
        self.ws.store.merge_repository(7).unwrap()
    }
}

#[cfg(unix)]
fn lab_with(f: impl FnOnce(&mut Value)) -> Lab {
    let mut state = green();
    f(&mut state);
    lab(state)
}

#[cfg(unix)]
#[tokio::test]
async fn a_released_head_with_green_ci_on_the_current_main_merges_and_is_followed_to_done() {
    let lab = lab(green());
    let released = lab.release(Some("lead"), "r1").await.unwrap();
    assert_eq!(released["state"], "queued");
    assert_eq!(released["mainAtRelease"], main_sha(), "the release keeps the main of its moment");
    assert!(writes(lab.dir.path()).is_empty(), "a release writes nothing to GitHub");
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "merged", "every gate held and the merge went: {e}");
    assert_eq!(
        writes(lab.dir.path()),
        ["PUT repos/owner/repo/pulls/11/merge"],
        "the only write is one merge request"
    );
    let put = calls(lab.dir.path()).into_iter().find(|c| c["method"] == "PUT").unwrap();
    assert_eq!(put["body"], json!({"merge_method":"merge","sha":head()}), "a merge commit pinned to the released head");
    let m = &e["merge"];
    assert_eq!((m["sha"].clone(), m["attempts"].clone(), m["expectedMain"].clone()), (json!(merge_commit()), json!(1), json!(main_sha())));
    assert_eq!(m["post"]["ok"], true, "the post-check held: {m}");
    assert_eq!(m["post"]["commit"]["parents"], json!([main_sha(), head()]));
    let ev = &e["lastEvidence"];
    assert_eq!(ev["gate"]["kind"], "slot");
    assert_eq!(ev["gate"]["tree"], tree());
    let jobs = ev["gate"]["runs"][0]["jobs"].as_array().unwrap();
    assert_eq!(ev["gate"]["runs"][0]["run"], 42, "the newest CI run decides, not the older red one");
    assert_eq!(jobs.len(), 2, "the skipped job proves nothing and is not listed: {jobs:?}");
    assert!(jobs.iter().all(|j| j["checkout"] == merge_sha() && j["logSha256"].as_str().is_some_and(|h| h.len() == 64)));
    assert!(lab.comments().iter().any(|c| c.contains(&format!("merged #11 at {}", &head()[..12]))));
    assert_eq!(lab.mail("lead").len(), 1, "the releasing lead is told of the merge");
    assert_eq!(lab.mail("dev").len(), 1, "and so is the task's executor");

    let e = lab.step().await;
    assert_eq!(e["state"], "merged", "main CI has not run yet: {e}");
    change(lab.dir.path(), |s| main_ci(s, "success"));
    let e = lab.step().await;
    assert_eq!(e["state"], "done", "main CI on the merge commit is green: {e}");
    assert_eq!(e["merge"]["mainCi"]["conclusion"], "success");
    assert_eq!(lab.mail("lead").len(), 2, "and the lead is told main CI passed");
    assert!(lab.paused()["paused"].is_null());
    lab.step().await;
    assert_eq!(writes(lab.dir.path()).len(), 1, "a done entry writes nothing more");
    assert_eq!(lab.mail("lead").len(), 2, "a done entry is not announced again");
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
        assert!(!lab.mail("lead").is_empty(), "{reason}: the lead is told");
        assert!(writes(lab.dir.path()).is_empty(), "{reason}: a stop writes nothing to GitHub");
        assert_eq!(lab.paused()["paused"]["reason"] == "main_red", reason == "main_red", "{reason}: only red main CI pauses the queue");
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
async fn an_unfinished_run_waits_and_the_entry_merges_once_it_is_green() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["runs"][1]["status"] = json!("in_progress");
        s["runs"][1]["conclusion"] = Value::Null;
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("waiting"), json!("waiting")), "an unfinished run must wait: {e}");
    assert!(e["detail"].as_str().unwrap().contains("CI run 42 on the head is in_progress"), "{}", e["detail"]);
    assert!(e["nextCheck"].as_i64().unwrap() > chrono::Utc::now().timestamp(), "a wait sets a later check");
    assert!(lab.mail("lead").is_empty(), "waiting is not announced");
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["checks"], 1, "a waiting entry is not checked before its time");
    change(lab.dir.path(), |s| {
        s["runs"][1]["status"] = json!("completed");
        s["runs"][1]["conclusion"] = json!("success");
    });
    assert_eq!(lab.step().await["state"], "merged");
}

#[cfg(unix)]
#[tokio::test]
async fn only_the_dispatching_lead_or_the_user_may_release_a_reviewed_head() {
    let lab = lab(green());
    let refused = |r: Result<Value>, what: &str| match r {
        Err(e) => e.to_string(),
        Ok(v) => panic!("{what} was accepted: {v}"),
    };
    let m = refused(lab.release(Some("dev"), "x").await, "the executor's release");
    assert!(m.contains("the task's executor cannot release its own PR"), "the executor was refused for another reason: {m}");
    let m = refused(lab.release(Some("lead2"), "x").await, "a lead's release of a task it did not dispatch");
    assert!(m.contains("only the task's dispatcher"), "the other lead was refused for another reason: {m}");
    lab.ws.store.merge_set_enabled(7, false).unwrap();
    let m = refused(lab.release(Some("lead"), "x").await, "a release while the queue is off");
    assert!(m.starts_with("merge_queue_disabled"), "{m}");
    lab.ws.store.merge_set_enabled(7, true).unwrap();
    review(&lab.ws.store, &lab.task, &head(), "changes_requested");
    let m = refused(lab.release(Some("lead"), "x").await, "a release over a changes_requested round");
    assert!(m.contains("concluded changes_requested, which does not pass"), "{m}");
    review(&lab.ws.store, &lab.task, &sha('a'), "no_findings");
    let m = refused(lab.release(Some("lead"), "x").await, "a release over a round of another head");
    assert!(m.contains("not the released head"), "{m}");
    review(&lab.ws.store, &lab.task, &head(), "no_findings");
    let other = lab.ws.collaboration_call(Some("lead"), "merge_enqueue", json!({"requestId":"x","taskId":lab.task,
        "pullUrl":"https://github.com/owner/repo/pull/12","headSha":head()})).await;
    let m = refused(other, "an unlinked PR's release");
    assert!(m.contains("not linked to the task"), "the unlinked PR was refused for another reason: {m}");
    assert!(calls(lab.dir.path()).is_empty(), "a refused release reads nothing from GitHub");

    let first = lab.release(Some("lead"), "r1").await.unwrap();
    assert_eq!(lab.release(Some("lead"), "r1").await.unwrap()["id"], first["id"], "a retry of the same request is the same entry");
    let conflict = lab.ws.collaboration_call(Some("lead"), "merge_enqueue", json!({"requestId":"r1","taskId":lab.task,
        "pullUrl":"https://github.com/owner/repo/pull/11","headSha":head(),"note":"different"})).await;
    let m = refused(conflict, "a replay with another payload");
    assert!(m.starts_with("idempotency_conflict"), "{m}");
    let m = refused(lab.release(Some("lead"), "r2").await, "a second release of a queued PR");
    assert!(m.starts_with("merge_already_queued"), "the second release was refused for another reason: {m}");
    lab.ws.collaboration_call(None, "merge_cancel", json!({"requestId":"c","entryId":first["id"]})).await.unwrap();
    let by_user = lab.release(None, "u1").await.unwrap();
    assert_eq!(by_user["release"]["by"]["kind"], "user", "the user may release without a dispatch");
}

#[cfg(unix)]
#[tokio::test]
async fn a_dispatcher_that_is_not_a_lead_may_not_release() {
    let lab = lab(green());
    let project: String = {
        let db = lab.ws.store.db.read().unwrap();
        db.query_row("SELECT project_id FROM project_tasks", [], |r| r.get(0)).unwrap()
    };
    crate::agent_roles::save(&lab.ws.store, &project, 1, vec!["lead2".into()]).unwrap();
    match lab.release(Some("lead"), "x").await {
        Err(e) => assert!(e.to_string().contains("the dispatcher is not a lead"), "{e}"),
        Ok(v) => panic!("a release by a dispatcher that is no longer a lead was accepted: {v}"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn retry_belongs_to_the_releaser_and_a_late_check_is_dropped() {
    let lab = lab(green());
    change(lab.dir.path(), |s| s["runs"][1]["conclusion"] = json!("failure"));
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let id = e["id"].as_str().unwrap().to_owned();
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["reason"], "ci_red");
    let before = calls(lab.dir.path()).len();
    match lab.ws.collaboration_call(Some("lead2"), "merge_retry", json!({"requestId":"x","entryId":id})).await {
        Err(e) => assert!(e.to_string().contains("only the Agent that released this merge"), "{e}"),
        Ok(v) => panic!("a retry by an Agent that did not release the merge was accepted: {v}"),
    }
    assert_eq!(calls(lab.dir.path()).len(), before, "a refused retry reads nothing from GitHub");
    change(lab.dir.path(), |s| s["runs"][1]["conclusion"] = json!("success"));
    let retried = lab.ws.collaboration_call(Some("lead"), "merge_retry", json!({"requestId":"t1","entryId":id})).await.unwrap();
    assert_eq!(retried["state"], "queued");
    let late = lab.ws.store.merge_record(&id, retried["attempt"].as_i64().unwrap() - 1, &store::anchor(&retried), Ok((json!({}), Ok(()))), 0).unwrap();
    assert!(late.merge.is_none() && !late.announced, "a check that began before the retry changes nothing");
    assert_eq!(lab.entry().await["state"], "queued", "a check that began before the retry changes nothing");
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["state"], "merged", "the retry checked everything again");
}

#[cfg(unix)]
#[tokio::test]
async fn cancel_belongs_to_the_releaser_and_a_late_check_is_dropped() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["runs"][1]["status"] = json!("in_progress");
        s["runs"][1]["conclusion"] = Value::Null;
    });
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let id = e["id"].as_str().unwrap().to_owned();
    tick(&lab.ws).await.unwrap();
    let cancelled = lab.ws.collaboration_call(Some("lead"), "merge_cancel", json!({"requestId":"c1","entryId":id})).await.unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    let late = lab.ws.store.merge_record(&id, cancelled["attempt"].as_i64().unwrap() - 1, &store::anchor(&cancelled), Ok((json!({}), Ok(()))), 0).unwrap();
    assert!(late.merge.is_none(), "a check that began before the cancel changes nothing");
    assert_eq!(lab.entry().await["state"], "cancelled");
    lab.step().await;
    assert!(writes(lab.dir.path()).is_empty(), "a cancelled entry without a batch writes nothing");
}

#[cfg(unix)]
#[tokio::test]
async fn a_retry_counts_main_ci_only_from_the_main_it_reads() {
    let lab = lab(green());
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let id = e["id"].as_str().unwrap().to_owned();
    let after = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        let red = json!({"id":91,"name":"CI","head_sha":sha('b'),"status":"completed","conclusion":"failure","created_at":after});
        s["mainRuns"].as_array_mut().unwrap().insert(0, red);
    });
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["reason"], "main_red", "a red run on main after the release stops the entry");
    assert_eq!(lab.paused()["paused"]["main"], sha('b'), "and pauses the queue at the red commit");
    let green_again = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        move_main(s, sha('c'), sha('d'));
        let green = json!({"id":92,"name":"CI","head_sha":sha('c'),"status":"completed","conclusion":"success","created_at":green_again});
        s["mainRuns"].as_array_mut().unwrap().insert(0, green);
    });
    let retried = lab.ws.collaboration_call(Some("lead"), "merge_retry", json!({"requestId":"t1","entryId":id})).await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "merged", "after main is green again, a retry passes: {e}");
    assert_eq!(retried["mainAtRelease"], sha('c'), "the retry anchors the entry at the main it read");
    assert_eq!(e["lastEvidence"]["main"]["atRelease"], sha('c'));
    let r = lab.paused();
    assert!(r["paused"].is_null(), "CI on a newer main is green, so the pause ended: {r}");
    assert_eq!(r["pauses"][0]["clearedBy"]["by"], "a newer green main", "and what ended it is journaled: {r}");
}

#[cfg(unix)]
#[tokio::test]
async fn an_entry_waiting_through_a_red_main_pause_proceeds_once_a_newer_main_is_green() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    // After the release main moved to sha('b'), its CI went red, and another
    // entry paused the queue there.
    let after = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        s["commits"][sha('b')] = json!({"sha":sha('b'),"tree":sha('6'),"parents":[main_sha()]});
        s["main"] = json!(sha('b'));
        let red = json!({"id":91,"name":"CI","head_sha":sha('b'),"status":"completed","conclusion":"failure","created_at":after});
        s["mainRuns"].as_array_mut().unwrap().insert(0, red);
    });
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE merge_repositories SET data=json_set(data,'$.paused',json(?1)) WHERE repository_id=7",
        [json!({"reason":"main_red","at":after,"detail":"Main CI run 91 concluded failure","main":sha('b'),"base":"main"}).to_string()],
    ).unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "the entry waits at the pause: {e}");
    // Main moves past the red commit and CI on the new main is green.
    let green_again = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        move_main(s, sha('c'), sha('d'));
        let green = json!({"id":92,"name":"CI","head_sha":sha('c'),"status":"completed","conclusion":"success","created_at":green_again});
        s["mainRuns"].as_array_mut().unwrap().insert(0, green);
    });
    let e = lab.step().await;
    assert_eq!(e["state"], "merged", "an entry waiting through a red-main pause proceeds once a newer main is green: {e}");
    let r = lab.paused();
    assert!(r["paused"].is_null(), "nothing pauses the queue again: {r}");
    assert_eq!(r["pauses"].as_array().map(Vec::len), Some(1), "one journal line for the pause and what ended it: {r}");
    assert_eq!(r["pauses"][0]["clearedBy"]["by"], "a newer green main");
    assert_eq!(e["mainAtRelease"], sha('c'), "the entry counts main CI from the main that ended the pause");
}

/// Main went red at b after the release and the queue paused there; then
/// main moved on to c, whose CI is green. Runs come newest first.
fn red_then_green(s: &mut Value, at: &str) {
    s["commits"][sha('b')] = json!({"sha":sha('b'),"tree":sha('6'),"parents":[main_sha()]});
    let red = json!({"id":91,"name":"CI","head_sha":sha('b'),"status":"completed","conclusion":"failure","created_at":at});
    s["mainRuns"].as_array_mut().unwrap().insert(0, red);
    move_main(s, sha('c'), sha('d'));
    let green = json!({"id":92,"name":"CI","head_sha":sha('c'),"status":"completed","conclusion":"success","created_at":at});
    s["mainRuns"].as_array_mut().unwrap().insert(0, green);
}
#[cfg(unix)]
fn pause_at_b(lab: &Lab, at: &str) {
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE merge_repositories SET data=json_set(data,'$.paused',json(?1)) WHERE repository_id=7",
        [json!({"reason":"main_red","at":at,"detail":"Main CI run 91 concluded failure","main":sha('b'),"base":"main"}).to_string()],
    ).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_pause_one_entry_ends_reanchors_the_next_entry_before_its_check_in_the_same_pass() {
    let lab = lab(green());
    let first = lab.release(Some("lead"), "r1").await.unwrap()["id"].as_str().unwrap().to_owned();
    // A second entry of the repository, #12, released at the same main.
    let second = {
        let db = lab.ws.store.db.read().unwrap();
        let mut w: Value = serde_json::from_str(&db.query_row("SELECT data FROM merge_entries", [], |r| r.get::<_, String>(0)).unwrap()).unwrap();
        w["id"] = json!(uuid::Uuid::new_v4().to_string());
        w["entryId"] = w["id"].clone();
        w["number"] = json!(12);
        w["url"] = json!("https://github.com/owner/repo/pull/12");
        w
    };
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,7,12,'queued',0,?3)",
        rusqlite::params![second["id"].as_str(), second["taskId"].as_str(), second.to_string()],
    ).unwrap();
    let second = second["id"].as_str().unwrap().to_owned();
    let after = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        let mut pull12 = s["pull"].clone();
        pull12["number"] = json!(12);
        s["pull12"] = pull12;
        s["commits"][sha('b')] = json!({"sha":sha('b'),"tree":sha('6'),"parents":[main_sha()]});
        s["main"] = json!(sha('b'));
        let red = json!({"id":91,"name":"CI","head_sha":sha('b'),"status":"completed","conclusion":"failure","created_at":after});
        s["mainRuns"].as_array_mut().unwrap().insert(0, red);
    });
    pause_at_b(&lab, &after);
    tick(&lab.ws).await.unwrap();
    let get = |id: &str| lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":id}));
    assert_eq!(get(&second).await.unwrap()["state"], "waiting", "both entries wait at the pause");
    // Main moves on to c with green CI: the first entry's check ends the pause.
    change(lab.dir.path(), |s| {
        move_main(s, sha('c'), sha('d'));
        let green = json!({"id":92,"name":"CI","head_sha":sha('c'),"status":"completed","conclusion":"success","created_at":after});
        s["mainRuns"].as_array_mut().unwrap().insert(0, green);
    });
    lab.step().await;
    assert_eq!(get(&first).await.unwrap()["state"], "merged", "the first entry ended the pause and merged");
    let e = get(&second).await.unwrap();
    assert_ne!(e["reason"], "main_red", "the second entry is not stopped by the red run from before the pause ended: {e}");
    assert_eq!(e["lastEvidence"]["main"]["atRelease"], sha('c'), "the second entry is checked from the new anchor in the same pass: {e}");
    let r = lab.paused();
    assert!(r["paused"].is_null(), "nothing pauses the queue again: {r}");
}

#[cfg(unix)]
#[tokio::test]
async fn an_unpause_during_a_check_drops_that_check_instead_of_stopping_on_the_old_red_run() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    let after = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        red_then_green(s, &after);
        s["slowPull"] = json!(true);
    });
    pause_at_b(&lab, &after);
    // The check reads its entry, then the PR (slowly); the unpause lands then.
    let ws = lab.ws.clone();
    let pass = tokio::spawn(async move { tick(&ws).await });
    let started = lab.dir.path().join("pull-started");
    for _ in 0..200 {
        if started.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(started.exists(), "the check reached the PR read");
    lab.ws.collaboration_call(Some("lead2"), "merge_unpause", json!({"requestId":"u","repositoryId":7,"reason":"fixed"})).await.unwrap();
    pass.await.unwrap().unwrap();
    let e = lab.entry().await;
    assert_ne!(e["reason"], "main_red", "a check from the anchor before the unpause is dropped, not recorded as main_red: {e}");
    assert!(lab.paused()["paused"].is_null(), "nothing pauses the queue again");
    assert_eq!(e["mainAtRelease"], sha('c'), "the entry keeps the unpause's anchor");
    assert_eq!(lab.step().await["state"], "merged", "checked again from the new anchor, it merges");
}

#[cfg(unix)]
#[tokio::test]
async fn an_unpause_retried_with_its_request_id_gets_the_first_answer_back() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    pause_at_b(&lab, &chrono::Utc::now().to_rfc3339());
    let input = json!({"requestId":"u1","repositoryId":7,"reason":"fixed"});
    let first = lab.ws.collaboration_call(Some("lead2"), "merge_unpause", input.clone()).await.unwrap();
    let before = calls(lab.dir.path()).len();
    let again = lab.ws.collaboration_call(Some("lead2"), "merge_unpause", input).await.expect("an identical retry gets the first answer back");
    assert_eq!(again, first);
    assert_eq!(calls(lab.dir.path()).len(), before, "the retry reads nothing from GitHub");
    assert_eq!(lab.paused()["pauses"].as_array().map(Vec::len), Some(1), "nothing is cleared twice");
    let other = lab.ws.collaboration_call(Some("lead2"), "merge_unpause", json!({"requestId":"u1","repositoryId":7,"reason":"other"})).await;
    assert!(other.unwrap_err().to_string().starts_with("idempotency_conflict"), "the same requestId with another payload is refused");
}

#[cfg(unix)]
#[tokio::test]
async fn a_branch_whose_creation_answer_was_lost_is_still_removed() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
        s["refAnswers"] = json!(["lost"]);
    });
    let id = lab.release(Some("lead"), "r1").await.unwrap()["id"].as_str().unwrap().to_owned();
    // GitHub creates the batch branch, but its answer is lost.
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["batch"]["ref"], "pending", "the branch was recorded before it was asked for: {e}");
    lab.ws.collaboration_call(Some("lead"), "merge_cancel", json!({"requestId":"c1","entryId":id})).await.unwrap();
    let e = lab.step().await;
    let w = writes(lab.dir.path());
    assert!(w.contains(&format!("DELETE repos/owner/repo/git/refs/heads/queue/merge-{id}")), "Core deletes a branch it may have made: {w:?}");
    assert_eq!(e["batch"]["cleanup"], "done", "{e}");
}

#[cfg(unix)]
#[tokio::test]
async fn read_failures_before_the_post_check_stop_and_pause_instead_of_ending_done() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    // Merged, but the merge commit was never read: no post-check yet.
    let mut m = lab.entry().await;
    m["state"] = json!("merged");
    m["merge"] = json!({"expectedMain":main_sha(),"tree":tree(),"gate":"slot","head":head(),"attempts":1,"puts":[{"n":1}],"sha":merge_commit(),"post":null,"mainCi":null});
    lab.ws.store.db.write().unwrap().execute("UPDATE merge_entries SET state='merged',next_check=0,data=?1", [m.to_string()]).unwrap();
    change(lab.dir.path(), |s| s["commitDown"] = json!(true));
    for _ in 0..8 {
        lab.step().await;
    }
    let e = lab.entry().await;
    assert_eq!(
        (e["state"].clone(), e["reason"].clone()),
        (json!("stopped"), json!("post_check_unverified")),
        "read failures before the post-check stop the entry, never done: {e}"
    );
    assert_eq!(lab.paused()["paused"]["reason"], "post_check_unverified", "nothing merges on top of an unchecked merge commit");
}

#[cfg(unix)]
#[tokio::test]
async fn a_pause_longer_than_the_wait_limit_keeps_its_entries_waiting_for_the_unpause() {
    let lab = lab(green());
    let id = lab.release(Some("lead"), "r1").await.unwrap()["id"].as_str().unwrap().to_owned();
    let after = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        s["commits"][sha('b')] = json!({"sha":sha('b'),"tree":sha('6'),"parents":[main_sha()]});
        s["main"] = json!(sha('b'));
        let red = json!({"id":91,"name":"CI","head_sha":sha('b'),"status":"completed","conclusion":"failure","created_at":after});
        s["mainRuns"].as_array_mut().unwrap().insert(0, red);
    });
    pause_at_b(&lab, &after);
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["state"], "waiting");
    // Seven hours on, the queue is still paused.
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE merge_entries SET data=json_set(data,'$.waitingSince',?1)",
        [chrono::Utc::now().timestamp() - 7 * 3600],
    ).unwrap();
    let e = lab.step().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("waiting"), json!("waiting")), "a pause longer than six hours does not time the entry out: {e}");
    let answer = lab.ws.collaboration_call(Some("lead2"), "merge_unpause", json!({"requestId":"u","repositoryId":7})).await.unwrap();
    assert_eq!(answer["reanchored"], json!([id]), "the unpause re-anchors the waiting entry");
    assert_eq!(lab.entry().await["mainAtRelease"], sha('b'));
}

#[cfg(unix)]
#[tokio::test]
async fn a_merge_whose_post_check_has_not_run_holds_the_next_one() {
    let lab = lab(green());
    let next = lab.release(Some("lead"), "r1").await.unwrap()["id"].as_str().unwrap().to_owned();
    // #12 merged as e, but its merge commit cannot be read yet.
    let earlier = {
        let db = lab.ws.store.db.read().unwrap();
        let mut w: Value = serde_json::from_str(&db.query_row("SELECT data FROM merge_entries", [], |r| r.get::<_, String>(0)).unwrap()).unwrap();
        w["id"] = json!(uuid::Uuid::new_v4().to_string());
        w["entryId"] = w["id"].clone();
        w["number"] = json!(12);
        w["state"] = json!("merged");
        w["merge"] = json!({"expectedMain":main_sha(),"tree":tree(),"gate":"slot","head":head(),"attempts":1,"puts":[{"n":1}],"sha":sha('e'),"post":null,"mainCi":null});
        w
    };
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,7,12,'merged',0,?3)",
        rusqlite::params![earlier["id"].as_str(), earlier["taskId"].as_str(), earlier.to_string()],
    ).unwrap();
    change(lab.dir.path(), |s| {
        s["commits"][sha('e')] = json!({"sha":sha('e'),"tree":tree(),"parents":[main_sha(),head()]});
        s["commitDown"] = json!(sha('e'));
    });
    tick(&lab.ws).await.unwrap();
    let get = |id: String| lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":id}));
    let e = get(next.clone()).await.unwrap();
    assert_eq!(e["state"], "ready", "a merge whose post-check has not run holds the next one: {e}");
    assert!(e["detail"].as_str().unwrap().contains("whose post-check has not run yet"), "{}", e["detail"]);
    assert!(!writes(lab.dir.path()).iter().any(|w| w.starts_with("PUT")), "nothing merges on top of an unchecked merge commit");
    // The merge commit can be read again: #12's post-check runs, then the next entry merges.
    change(lab.dir.path(), |s| s["commitDown"] = Value::Null);
    lab.step().await;
    lab.step().await;
    assert_eq!(get(earlier["id"].as_str().unwrap().to_owned()).await.unwrap()["merge"]["post"]["ok"], true);
    assert_eq!(get(next).await.unwrap()["state"], "merged", "once the post-check has run, the next entry merges");
}

/// Main moves on to b, whose CI goes red: the first release stops as
/// main_red and pauses the queue there, recording run 91. Answers its id.
#[cfg(unix)]
async fn stopped_at_a_red_main(lab: &Lab) -> String {
    let first = lab.release(Some("lead"), "r1").await.unwrap()["id"].as_str().unwrap().to_owned();
    let after = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        move_main(s, sha('b'), sha('d'));
        let red = json!({"id":91,"name":"CI","head_sha":sha('b'),"status":"completed","conclusion":"failure","created_at":after});
        s["mainRuns"].as_array_mut().unwrap().insert(0, red);
    });
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.paused()["paused"]["run"], 91, "the pause records the red run");
    first
}
/// As `stopped_at_a_red_main`, then a second release of the PR waits at the pause.
#[cfg(unix)]
async fn waiting_at_a_red_main(lab: &Lab) -> String {
    stopped_at_a_red_main(lab).await;
    let second = lab.release(Some("lead"), "r2").await.unwrap()["id"].as_str().unwrap().to_owned();
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":second})).await.unwrap()["state"], "waiting");
    second
}

#[cfg(unix)]
#[tokio::test]
async fn an_unpause_at_a_main_still_red_accepts_that_run_and_no_other() {
    let lab = lab(green());
    let second = waiting_at_a_red_main(&lab).await;
    // A lead unpauses while main is still b and run 91 is still red.
    let answer = lab.ws.collaboration_call(Some("lead2"), "merge_unpause", json!({"requestId":"u","repositoryId":7})).await.unwrap();
    assert_eq!(answer["acceptedRun"]["id"], 91, "the unpause accepts the red run at the unchanged main: {answer}");
    lab.step().await;
    let e = lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":second})).await.unwrap();
    assert_eq!(e["state"], "merged", "the accepted run no longer stops the entry: {e}");
    assert!(lab.paused()["paused"].is_null(), "nothing pauses the queue again");

    // A later red run on a newer main still stops the entry.
    let lab = lab_with(|_| {});
    let second = waiting_at_a_red_main(&lab).await;
    lab.ws.collaboration_call(Some("lead2"), "merge_unpause", json!({"requestId":"u","repositoryId":7})).await.unwrap();
    let later = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        move_main(s, sha('c'), sha('f'));
        let red = json!({"id":93,"name":"CI","head_sha":sha('c'),"status":"completed","conclusion":"failure","created_at":later});
        s["mainRuns"].as_array_mut().unwrap().insert(0, red);
    });
    lab.step().await;
    let e = lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":second})).await.unwrap();
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("main_red")), "only the accepted run is accepted: {e}");
}

#[cfg(unix)]
async fn unpause_by_lead2(lab: &Lab) -> Value {
    lab.ws.collaboration_call(Some("lead2"), "merge_unpause", json!({"requestId":"u","repositoryId":7})).await.unwrap()
}
#[cfg(unix)]
async fn entry_by_id(lab: &Lab, id: &str) -> Value {
    lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":id})).await.unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn an_accepted_run_belongs_to_its_main_for_every_entry_anchored_there() {
    // The entry that found the red run, retried after the unpause accepted it.
    let lab = lab(green());
    let finder = stopped_at_a_red_main(&lab).await;
    unpause_by_lead2(&lab).await;
    lab.ws.collaboration_call(Some("lead"), "merge_retry", json!({"requestId":"t1","entryId":finder})).await.unwrap();
    lab.step().await;
    let e = entry_by_id(&lab, &finder).await;
    assert_eq!(e["state"], "merged", "a retry at the main whose red run was accepted merges: {e}");
    assert!(lab.paused()["paused"].is_null(), "no second pause");

    // A release made at that main after the unpause.
    let lab = lab_with(|_| {});
    stopped_at_a_red_main(&lab).await;
    unpause_by_lead2(&lab).await;
    let fresh = lab.release(Some("lead"), "r2").await.unwrap()["id"].as_str().unwrap().to_owned();
    lab.step().await;
    assert_eq!(entry_by_id(&lab, &fresh).await["state"], "merged", "a new release at that main merges too");

    // A retry once main has moved on carries nothing: a red run there stops it.
    let lab = lab_with(|_| {});
    let finder = stopped_at_a_red_main(&lab).await;
    unpause_by_lead2(&lab).await;
    let later = chrono::Utc::now().to_rfc3339();
    change(lab.dir.path(), |s| {
        move_main(s, sha('c'), sha('f'));
        let red = json!({"id":93,"name":"CI","head_sha":sha('c'),"status":"completed","conclusion":"failure","created_at":later});
        s["mainRuns"].as_array_mut().unwrap().insert(0, red);
    });
    lab.ws.collaboration_call(Some("lead"), "merge_retry", json!({"requestId":"t1","entryId":finder})).await.unwrap();
    lab.step().await;
    let e = entry_by_id(&lab, &finder).await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("main_red")), "a retry at a newer main carries no acceptance: {e}");
}

/// Core sends one merge request. An uncertain answer, whether or not GitHub
/// merged, whether or not main moved and whether or not GitHub can be read
/// after it, is never sent again or reconciled: the entry stops with
/// merge_unknown and the repository's queue pauses, urgent.
#[cfg(unix)]
#[tokio::test]
async fn an_uncertain_merge_answer_stops_unknown_and_pauses_and_nothing_is_sent_again() {
    for answer in ["502", "lost", "502move", "502down"] {
        let lab = lab_with(|s| {
            s["mergeAnswers"] = json!([answer, "ok"]);
            s["movedMain"] = json!(sha('c'));
        });
        lab.release(Some("lead"), "r1").await.unwrap();
        tick(&lab.ws).await.unwrap();
        let e = lab.entry().await;
        assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("merge_unknown")), "{answer}: one uncertain answer stops the entry: {e}");
        assert_eq!(lab.paused()["paused"]["reason"], "merge_unknown", "{answer}: a merge that may have landed unchecked pauses the queue");
        assert!(lab.mail("lead").iter().any(|m| m["priority"] == "urgent"), "{answer}: merge_unknown is urgent");
        lab.step().await;
        assert_eq!(writes(lab.dir.path()), ["PUT repos/owner/repo/pulls/11/merge"], "{answer}: never a second merge request");
    }
    // The next release of the PR waits at the pause instead of merging on top.
    let lab = lab_with(|s| s["mergeAnswers"] = json!(["502"]));
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let next = lab.release(Some("lead"), "r2").await.unwrap()["id"].as_str().unwrap().to_owned();
    lab.step().await;
    let e = lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":next})).await.unwrap();
    assert_eq!(e["state"], "waiting", "nothing merges until a person has looked: {e}");
    assert_eq!(writes(lab.dir.path()).iter().filter(|w| w.starts_with("PUT")).count(), 1);
}
#[cfg(unix)]
#[tokio::test]
async fn reads_failing_before_any_merge_request_stop_unreachable_without_a_pause() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    resumed_before_its_first_request(&lab).await;
    change(lab.dir.path(), |s| s["pullDown"] = json!(true));
    for _ in 0..8 {
        lab.step().await;
    }
    let e = lab.entry().await;
    assert_eq!(
        (e["state"].clone(), e["reason"].clone()),
        (json!("stopped"), json!("github_unreachable")),
        "no request was sent, so nothing merged: {e}"
    );
    assert!(lab.paused()["paused"].is_null(), "a stop after which nothing merged does not pause");
    assert!(writes(lab.dir.path()).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_merge_request_that_never_left_core_is_not_an_uncertain_one() {
    // gh refuses before sending anything (no login): five times in a row.
    let lab = lab_with(|s| s["mergeAnswers"] = json!(vec!["noauth"; 5]));
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "merging", "a request that never left Core is not an uncertain one: {e}");
    assert_eq!(e["merge"]["attempts"], 0, "the request that was not sent does not count: {e}");
    assert!(e["merge"]["puts"][0]["notSent"].as_str().unwrap().starts_with("not_sent"), "{e}");
    assert!(lab.paused()["paused"].is_null(), "nothing was sent, so nothing pauses");
    for _ in 0..4 {
        lab.step().await;
    }
    let e = lab.entry().await;
    assert_eq!(
        (e["state"].clone(), e["reason"].clone()),
        (json!("stopped"), json!("github_unreachable")),
        "after five requests that could not be sent the entry stops, and nothing merged: {e}"
    );
    assert!(lab.paused()["paused"].is_null(), "no pause: nothing merged");
}

#[cfg(unix)]
#[tokio::test]
async fn a_timed_out_merge_request_stays_uncertain() {
    // A request that times out may have merged: the entry stops and pauses at once.
    let dir = tempfile::tempdir().unwrap();
    let program = fake_gh(dir.path(), {
        let mut s = green();
        s["mergeAnswers"] = json!(["hang", "ok"]);
        s
    });
    let mut ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let client = &mut Arc::get_mut(&mut ws).unwrap().github.client;
    client.program = program;
    client.deadline = std::time::Duration::from_secs(1);
    client.merge_deadline = std::time::Duration::from_secs(1);
    let task = setup(&ws.store);
    let lab = Lab { dir, ws, task };
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("merge_unknown")), "a timeout stays uncertain: {e}");
    assert_eq!(lab.paused()["paused"]["reason"], "merge_unknown");
    assert_eq!(writes(lab.dir.path()).len(), 1, "it is not sent again");
}

#[cfg(unix)]
#[tokio::test]
async fn a_rate_limited_merge_request_waits_and_is_sent_again() {
    // The rate limit refused the request: it merged nothing.
    let lab = lab_with(|s| s["mergeAnswers"] = json!(["429"]));
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "merging", "a rate-limited merge request waits, it is not refused: {e}");
    assert!(e["detail"].as_str().unwrap().contains("rate_limited"), "{}", e["detail"]);
    assert_eq!(e["merge"]["attempts"], 0, "the rate-limited request certainly merged nothing: {e}");
    assert!(lab.paused()["paused"].is_null(), "so nothing pauses");
    let e = lab.step().await;
    assert_eq!(e["state"], "merged", "after the cooldown the merge is sent again and merges: {e}");
    assert_eq!(writes(lab.dir.path()).iter().filter(|w| w.starts_with("PUT")).count(), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn a_release_main_without_a_run_does_not_count_older_red_runs() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["mainRuns"] = json!([{"id":89,"name":"CI","head_sha":old_main(),"status":"completed","conclusion":"failure","created_at":"2026-11-01T00:00:00Z"}]);
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "merged", "a red run from before the release does not count: {e}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_run_that_finished_between_the_reads_is_judged_on_a_fresh_read_of_the_pr() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    change(lab.dir.path(), |s| {
        let mut stale = s["pull"].clone();
        stale["mergeable_state"] = json!("unstable");
        s["pullQueue"] = json!([stale]);
    });
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "merged", "a run that finished between the reads is judged on the fresh read of the PR: {e}");
    let reads = calls(lab.dir.path()).iter().filter(|c| c["method"] == "GET" && c["endpoint"] == "repos/owner/repo/pulls/11").count();
    assert_eq!(reads, 4, "the PR is read at release, before and after the head's runs, and right before the merge request");
}

#[cfg(unix)]
#[tokio::test]
async fn unstable_or_blocked_waits_while_a_check_is_pending_and_stops_once_none_is() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    change(lab.dir.path(), |s| {
        s["pull"]["mergeable_state"] = json!("unstable");
        s["statuses"] = json!([{"context":"external/lint","state":"pending"}]);
    });
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "a pending external status must wait: {e}");
    assert!(e["detail"].as_str().unwrap().contains("unstable while status external/lint"), "{}", e["detail"]);
    change(lab.dir.path(), |s| {
        s["pull"]["mergeable_state"] = json!("blocked");
        s["statuses"] = json!([{"context":"external/lint","state":"success"}]);
        s["checkRuns"] = json!([{"name":"Deploy preview","status":"in_progress"}]);
    });
    lab.due();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "a pending check run must wait: {e}");
    assert!(e["detail"].as_str().unwrap().contains("blocked while check run Deploy preview"), "{}", e["detail"]);
    change(lab.dir.path(), |s| {
        s["pull"]["mergeable_state"] = json!("unstable");
        s["checkRuns"] = json!([{"name":"Deploy preview","status":"completed","conclusion":"failure"}]);
    });
    lab.due();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("ci_red")), "unstable with nothing pending is ci_red: {e}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_gh_without_the_raw_log_flag_stops_with_the_version_it_needs() {
    let lab = lab(green());
    change(lab.dir.path(), |s| s["oldGh"] = json!(true));
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("gh_too_old")), "an old gh stops with gh_too_old: {e}");
    let detail = e["detail"].as_str().unwrap();
    assert!(detail.contains("--allow-escape-sequences") && detail.contains("gh 2.97.0"), "the stop names the flag and the version: {detail}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_head_tested_on_an_older_main_merges_through_a_batch_on_the_current_main() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
    });
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let branch = format!("queue/merge-{}", e["id"].as_str().unwrap());
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "CI tested an older main, so Core builds a batch and waits for its CI: {e}");
    assert!(e["detail"].as_str().unwrap().contains("Core opened batch #900"), "{}", e["detail"]);
    assert_eq!(
        writes(lab.dir.path()),
        ["POST repos/owner/repo/git/refs", "POST repos/owner/repo/merges", "POST repos/owner/repo/pulls"],
        "the batch: its branch at main, the head merged into it, and a draft PR to run CI"
    );
    let bodies: Vec<Value> = calls(lab.dir.path()).into_iter().filter(|c| c["method"] == "POST").map(|c| c["body"].clone()).collect();
    assert_eq!(bodies[0], json!({"ref":format!("refs/heads/{branch}"),"sha":main_sha()}));
    assert_eq!((bodies[1]["base"].clone(), bodies[1]["head"].clone()), (json!(branch), json!(head())));
    assert_eq!((bodies[2]["head"].clone(), bodies[2]["base"].clone(), bodies[2]["draft"].clone()), (json!(branch), json!("main"), json!(true)));
    assert_eq!(e["batch"]["commit"], batch_commit());
    assert_eq!(lab.step().await["state"], "waiting", "no CI on the batch yet");
    assert_eq!(writes(lab.dir.path()).len(), 3, "a waiting batch is not built again");
    change(lab.dir.path(), batch_green);
    let e = lab.step().await;
    assert_eq!(e["state"], "merged", "CI on the batch proved the merge: {e}");
    assert_eq!(e["lastEvidence"]["gate"]["kind"], "batch");
    assert_eq!(e["lastEvidence"]["gate"]["batch"]["pr"], 900);
    assert_eq!(e["merge"]["post"]["ok"], true);
    assert_eq!(
        writes(lab.dir.path())[3..],
        [
            "PUT repos/owner/repo/pulls/11/merge".to_owned(),
            "PATCH repos/owner/repo/pulls/900".to_owned(),
            format!("DELETE repos/owner/repo/git/refs/heads/{branch}")
        ],
        "the merge, then Core closes its batch PR and deletes its branch"
    );
    assert_eq!(e["batch"]["cleanup"], "done");
}

/// Main moved on to sha('c') after the PR's CI ran, and GitHub never moved the
/// PR's merge ref: it stays main_sha() + head, as in the T-37 lab (finding F1,
/// over 19 minutes). The compare of the two mains names main_sha() as their
/// merge base, so the ref's main is an older main. The batch's own CI ran on
/// the current main.
fn main_moved_ref_stale(s: &mut Value) {
    let to = sha('c');
    s["commits"][&to] = json!({"sha":to,"tree":sha('6'),"parents":[main_sha()]});
    s["commits"][&batch_merge_ref()]["parents"] = json!([to, batch_commit()]);
    s["main"] = json!(to);
    s["compare"] = json!({format!("{}...{}", main_sha(), to): {"base":main_sha(),"mergeBase":main_sha(),"commits":1}});
}
/// Backdate when the entry's last check first saw its merge ref as it is.
fn age_merge_ref(lab: &Lab, seconds: i64) {
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE merge_entries SET data=json_set(data,'$.lastEvidence.mergeRef.since',json_extract(data,'$.lastEvidence.mergeRef.since')-?1)", [seconds])
        .unwrap();
}

/// T-37 lab finding F1: a merge ref GitHub never moves to the current main kept
/// the entry waiting until wait_timeout. CI on the PR checked out that ref, so
/// it cannot have tested the current main: the entry goes to the batch at once.
#[cfg(unix)]
#[tokio::test]
async fn a_merge_ref_github_never_moves_to_the_current_main_batches_in_one_tick() {
    let lab = lab_with(main_moved_ref_stale);
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let branch = format!("queue/merge-{}", e["id"].as_str().unwrap());
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "{e}");
    assert!(
        e["detail"].as_str().unwrap().contains("Core opened batch #900"),
        "a merge ref on an older main goes to the batch in the first check: {}",
        e["detail"]
    );
    assert_eq!(
        writes(lab.dir.path()),
        ["POST repos/owner/repo/git/refs", "POST repos/owner/repo/merges", "POST repos/owner/repo/pulls"],
        "the batch: its branch, the head merged into it, and its draft PR"
    );
    let create = calls(lab.dir.path()).into_iter().find(|c| c["method"] == "POST").unwrap();
    assert_eq!(create["body"], json!({"ref":format!("refs/heads/{branch}"),"sha":sha('c')}), "the batch is built on the current main");
    assert!(
        !calls(lab.dir.path()).iter().any(|c| c["endpoint"].as_str().unwrap().ends_with("/logs")),
        "no job log is read: CI behind a stale merge ref cannot have tested the current main"
    );
    change(lab.dir.path(), batch_green);
    let e = lab.step().await;
    assert_eq!(e["state"], "merged", "CI on the batch proved the merge: {e}");
    assert_eq!(e["lastEvidence"]["gate"]["kind"], "batch");
    assert_eq!(e["merge"]["post"]["ok"], true, "{e}");
}

/// A merge ref GitHub has not computed is waited for, but only two minutes:
/// then Core builds the batch with its own merge.
#[cfg(unix)]
#[tokio::test]
async fn a_merge_ref_github_has_not_computed_is_waited_for_two_minutes_then_batched() {
    let lab = lab_with(|s| {
        main_moved_ref_stale(s);
        s["merge"] = Value::Null;
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    assert_eq!(lab.entry().await["state"], "waiting");
    assert!(writes(lab.dir.path()).is_empty(), "within the two minutes Core writes nothing");
    age_merge_ref(&lab, 100);
    lab.step().await;
    assert!(writes(lab.dir.path()).is_empty(), "nor before they end");
    age_merge_ref(&lab, 21);
    let e = lab.step().await;
    assert!(
        e["detail"].as_str().unwrap().contains("Core opened batch #900"),
        "after two minutes without a merge ref Core builds the batch itself: {}",
        e["detail"]
    );
    assert_eq!(writes(lab.dir.path()).len(), 3, "its branch, its merge and its draft PR");
}

/// T-37 lab finding F2: GitHub runs no CI for a PR with merge conflicts, so
/// the entry waited for runs until wait_timeout. GitHub's own verdict stops it
/// at once, and the task and the mail say what to do next.
#[cfg(unix)]
#[tokio::test]
async fn a_conflicting_pr_without_ci_stops_with_conflict_in_one_tick() {
    let lab = lab_with(|s| {
        s["pull"]["mergeable"] = json!(false);
        s["pull"]["mergeable_state"] = json!("dirty");
        s["runs"] = json!([]);
        s["merge"] = Value::Null;
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("conflict")), "{e}");
    assert!(e["detail"].as_str().unwrap().contains("cannot merge into its base"), "{}", e["detail"]);
    assert!(writes(lab.dir.path()).is_empty(), "a conflict writes nothing to GitHub");
    assert!(
        !calls(lab.dir.path()).iter().any(|c| c["endpoint"].as_str().unwrap().contains("head_sha=")),
        "it stops before waiting for runs GitHub will never start"
    );
    let next = "merges the current main into the PR branch";
    assert!(
        lab.comments().iter().any(|c| c.contains("stopped (conflict)") && c.contains(next)),
        "the task says what to do next: {:?}",
        lab.comments()
    );
    for agent in ["lead", "dev"] {
        assert!(
            lab.mail(agent).iter().any(|m| m["body"].as_str().unwrap().contains(next)),
            "{agent} is told what to do next: {:?}",
            lab.mail(agent)
        );
    }
}

/// While GitHub is still computing whether the PR can merge, nothing is
/// decided: the entry waits for its runs as before.
#[cfg(unix)]
#[tokio::test]
async fn a_pr_whose_mergeability_github_is_computing_waits_for_its_runs() {
    let lab = lab_with(|s| {
        s["pull"]["mergeable"] = Value::Null;
        s["pull"]["mergeable_state"] = json!("unknown");
        s["runs"] = json!([]);
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "{e}");
    assert_eq!(e["detail"], "No run of workflow CI on the head yet");
}

#[cfg(unix)]
#[tokio::test]
async fn a_batch_that_cannot_merge_stops_and_core_deletes_its_branch() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
        s["batchConflict"] = json!(true);
    });
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let branch = format!("queue/merge-{}", e["id"].as_str().unwrap());
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("conflict")), "a batch that cannot merge stops: {e}");
    lab.step().await;
    assert_eq!(
        writes(lab.dir.path()),
        ["POST repos/owner/repo/git/refs".to_owned(), "POST repos/owner/repo/merges".to_owned(), format!("DELETE repos/owner/repo/git/refs/heads/{branch}")],
        "Core deletes the branch it made; it opened no PR"
    );
    assert_eq!(lab.entry().await["batch"]["cleanup"], "done");
}

#[cfg(unix)]
#[tokio::test]
async fn red_ci_on_a_batch_stops_and_core_removes_the_batch() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    change(lab.dir.path(), |s| {
        batch_green(s);
        s["batchRuns"][0]["conclusion"] = json!("failure");
    });
    let e = lab.step().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("ci_red")), "red CI on the batch stops the entry: {e}");
    lab.step().await;
    let w = writes(lab.dir.path());
    assert_eq!(
        w.get(3..),
        Some(&["PATCH repos/owner/repo/pulls/900".to_owned(), format!("DELETE repos/owner/repo/git/refs/heads/queue/merge-{}", e["id"].as_str().unwrap())][..]),
        "Core closes its batch PR and deletes its branch: {w:?}"
    );
    assert!(!w.iter().any(|w| w.starts_with("PUT")), "nothing merged");
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_cleanup_never_skips_the_post_check_or_main_ci() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
        s["deleteAnswers"] = json!(["502"]);
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    change(lab.dir.path(), batch_green);
    let deletes = || writes(lab.dir.path()).iter().filter(|w| w.starts_with("DELETE")).count();
    // The merge goes; deleting the batch branch then gets a 502.
    let e = lab.step().await;
    assert_eq!(e["merge"]["post"]["ok"], true, "a failed cleanup does not skip the post-check: {e}");
    assert_eq!(e["state"], "merged");
    assert_eq!(e["batch"]["cleanup"], "pending", "the failed removal is kept for a retry: {e}");
    assert!(e["batch"]["cleanupError"].as_str().unwrap().contains("502"), "{}", e["batch"]["cleanupError"]);
    // The switch goes off after the merge; main CI still finishes and is read.
    lab.ws.store.merge_set_enabled(7, false).unwrap();
    change(lab.dir.path(), |s| main_ci(s, "success"));
    let e = lab.step().await;
    assert_eq!(e["state"], "done", "main CI is followed though the cleanup failed: {e}");
    assert_eq!(e["merge"]["mainCi"]["conclusion"], "success");
    assert_eq!(e["batch"]["cleanup"], "pending");
    lab.step().await;
    assert_eq!(deletes(), 1, "with the switch off Core sends no DELETE");
    // Back on: the cleanup pass removes the branch.
    lab.ws.store.merge_set_enabled(7, true).unwrap();
    let e = lab.step().await;
    assert_eq!(e["batch"]["cleanup"], "done", "the cleanup is retried later and ends done: {e}");
    assert_eq!(deletes(), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_cleanup_still_pauses_on_a_failed_post_check_or_red_main_ci() {
    let needs_batch = |s: &mut Value| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
        s["deleteAnswers"] = json!(["502", "502", "502"]);
    };
    let lab = lab_with(|s| {
        needs_batch(s);
        s["mergeTree"] = json!(sha('8'));
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    change(lab.dir.path(), batch_green);
    let e = lab.step().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("post_check_failed")), "a failed cleanup does not hide a failed post-check: {e}");
    assert_eq!(lab.paused()["paused"]["reason"], "post_check_failed");

    let lab = lab_with(needs_batch);
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    change(lab.dir.path(), batch_green);
    assert_eq!(lab.step().await["state"], "merged");
    change(lab.dir.path(), |s| main_ci(s, "failure"));
    let e = lab.step().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("done"), json!("main_red")), "a failed cleanup does not hide red main CI: {e}");
    assert_eq!(lab.paused()["paused"]["reason"], "main_red");
}

#[cfg(unix)]
#[tokio::test]
async fn an_upgrade_from_the_dry_run_build_turns_its_switch_off_and_stops_its_entries() {
    // A Workspace the dry-run build wrote: its switch on, which there only let
    // Core check, and its entry at ready, which there was final.
    let dir = tempfile::tempdir().unwrap();
    let program = fake_gh(dir.path(), green());
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let (task, old) = {
        let s = Store::open(&data.join("workspace.sqlite")).unwrap();
        let task = setup(&s);
        let (id, internal, at) = (uuid::Uuid::new_v4().to_string(), internal(&s, &task), crate::model::now());
        let e = json!({"id":id,"entryId":id,"taskId":internal,"taskReference":task,"repositoryId":7,"repository":"owner/repo","number":11,
            "url":"https://github.com/owner/repo/pull/11","linkId":"7:pull:11","headSha":head(),"baseBranch":"main",
            "mainAtRelease":main_sha(),"mainAnchoredAt":at,"requireWorkflows":[],"note":null,
            "release":{"by":{"kind":"agent","id":"lead","name":"Lead"},"requestId":"r0","at":at,"source":null,"reviewId":null},
            "state":"ready","reason":null,"detail":"Every check held. This slice is a dry run.","attempt":1,"checks":1,"waits":0,
            "readFailures":0,"waitingSince":null,"nextCheck":0,"evidence":null,"lastEvidence":null,
            "history":[{"at":at,"state":"queued","reason":null,"detail":"released"}],"dryRun":true,"createdAt":at,"updatedAt":at});
        let db = s.db.write().unwrap();
        db.execute("UPDATE merge_repositories SET data=?1 WHERE repository_id=7", [json!({"repositoryId":7,"enabled":true,"updatedAt":at}).to_string()])
            .unwrap();
        db.execute(
            "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,7,11,'ready',0,?3)",
            rusqlite::params![id, internal, e.to_string()],
        )
        .unwrap();
        (task, id)
    };
    // This build opens it.
    let mut ws = Workspace::new(data, dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program;
    let lab = Lab { dir, ws, task };
    let r = lab.paused();
    assert_eq!(r["enabled"], false, "the upgrade turned the dry-run switch off: {r}");
    assert_eq!(r["switches"][0]["by"], "Yuzuno Core");
    assert!(r["switches"][0]["detail"].as_str().unwrap().contains("Turn it on again for real merges"), "{r}");
    let get = |id: String| lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":id}));
    let e = get(old.clone()).await.unwrap();
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("dry_run_ended")), "the dry-run release stops: {e}");
    lab.step().await;
    let err = lab
        .ws
        .collaboration_call(Some("lead"), "merge_retry", json!({"requestId":"again","entryId":old}))
        .await
        .expect_err("a dry-run entry cannot be retried into a merge");
    assert!(format!("{err:#}").starts_with("merge_dry_run_ended"), "{err:#}");
    assert!(calls(lab.dir.path()).is_empty(), "a tick and the refused retry read and write nothing");
    // The user turns the switch on again, and a fresh release merges.
    lab.ws.store.merge_set_enabled(7, true).unwrap();
    let fresh = lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = get(fresh["id"].as_str().unwrap().to_owned()).await.unwrap();
    assert_eq!(e["state"], "merged", "a release made to this build merges: {e}");
    assert_eq!(writes(lab.dir.path()), ["PUT repos/owner/repo/pulls/11/merge"]);
}

#[cfg(unix)]
#[tokio::test]
async fn a_batch_removal_waits_while_the_switch_is_off_and_goes_once_it_is_on() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
    });
    let id = lab.release(Some("lead"), "r1").await.unwrap()["id"].as_str().unwrap().to_owned();
    tick(&lab.ws).await.unwrap();
    assert_eq!(writes(lab.dir.path()).len(), 3, "Core built a batch");
    lab.ws.store.merge_set_enabled(7, false).unwrap();
    lab.ws.collaboration_call(Some("lead"), "merge_cancel", json!({"requestId":"c1","entryId":id})).await.unwrap();
    // More retry windows than the failure limit, all with the switch off.
    for _ in 0..12 {
        lab.step().await;
    }
    let e = lab.entry().await;
    assert_eq!(e["batch"]["cleanup"], "pending", "with the switch off the removal waits and is not given up: {e}");
    assert!(e["batch"]["cleanupFailures"].is_null(), "waiting for the switch is no failure: {e}");
    assert!(e["batch"]["cleanupError"].as_str().unwrap().starts_with("merge_queue_disabled"), "{}", e["batch"]["cleanupError"]);
    assert_eq!(writes(lab.dir.path()).len(), 3, "with the switch off Core sends nothing");
    // On again, the removal is due at once. GitHub's rate limit refuses the
    // first nine deletes, which is a wait too.
    change(lab.dir.path(), |s| s["deleteAnswers"] = json!(vec!["429"; 9]));
    lab.ws.store.merge_set_enabled(7, true).unwrap();
    tick(&lab.ws).await.unwrap();
    let w = writes(lab.dir.path());
    assert_eq!(
        w.get(3..),
        Some(&["PATCH repos/owner/repo/pulls/900".to_owned(), format!("DELETE repos/owner/repo/git/refs/heads/queue/merge-{id}")][..]),
        "turning the switch on makes the removal due now: {w:?}"
    );
    for _ in 0..8 {
        lab.step().await;
    }
    let e = lab.entry().await;
    assert_eq!(e["batch"]["cleanup"], "pending", "a removal the rate limit refused waits too: {e}");
    assert!(e["batch"]["cleanupFailures"].is_null(), "{e}");
    let e = lab.step().await;
    assert_eq!(e["batch"]["cleanup"], "done", "then Core removes its batch: {e}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_batch_removal_that_keeps_failing_stops_and_says_so() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
        s["deleteAnswers"] = json!(vec!["502"; 8]);
    });
    let id = lab.release(Some("lead"), "r1").await.unwrap()["id"].as_str().unwrap().to_owned();
    tick(&lab.ws).await.unwrap();
    lab.ws.collaboration_call(Some("lead"), "merge_cancel", json!({"requestId":"c1","entryId":id})).await.unwrap();
    for _ in 0..8 {
        lab.step().await;
    }
    let e = lab.entry().await;
    assert_eq!(e["batch"]["cleanup"], "failed", "eight failures in a row end the removal: {e}");
    let last = e["history"].as_array().unwrap().last().unwrap()["detail"].as_str().unwrap().to_owned();
    assert!(last.contains(&format!("Remove the branch queue/merge-{id} and PR #900 by hand")), "the entry says Core stopped trying: {last}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_refused_merge_stops_with_githubs_answer() {
    let lab = lab_with(|s| s["mergeAnswers"] = json!(["405"]));
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("merge_refused")), "a refused merge stops: {e}");
    assert!(e["detail"].as_str().unwrap().contains("GitHub answered 405"), "{}", e["detail"]);
    assert_eq!(writes(lab.dir.path()).len(), 1, "a refusal is not retried");
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_post_check_pauses_the_queue_and_tells_the_leads() {
    let lab = lab_with(|s| s["mergeTree"] = json!(sha('8')));
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("post_check_failed")), "a tree CI did not test stops: {e}");
    assert_eq!(lab.paused()["paused"]["reason"], "post_check_failed", "and pauses the queue");
    let told = lab.mail("lead2");
    assert!(told.iter().any(|m| m["priority"] == "urgent" && m["metadata"]["status"] == "paused"), "the other lead is told, urgently: {told:?}");
}

#[cfg(unix)]
#[tokio::test]
async fn red_main_ci_after_a_merge_pauses_and_only_a_lead_or_the_user_unpauses() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    change(lab.dir.path(), |s| main_ci(s, "failure"));
    let e = lab.step().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("done"), json!("main_red")), "red main CI ends the entry: {e}");
    assert_eq!(lab.paused()["paused"]["reason"], "main_red", "and pauses the queue");
    // Another entry of the repository waits while the queue is paused.
    let waiting = {
        let db = lab.ws.store.db.read().unwrap();
        let mut w: Value = serde_json::from_str(&db.query_row("SELECT data FROM merge_entries", [], |r| r.get::<_, String>(0)).unwrap()).unwrap();
        w["id"] = json!(uuid::Uuid::new_v4().to_string());
        w["number"] = json!(12);
        w["state"] = json!("waiting");
        w["mainAtRelease"] = json!(old_main());
        w
    };
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,7,12,'waiting',99999999999,?3)",
        rusqlite::params![waiting["id"].as_str(), waiting["taskId"].as_str(), waiting.to_string()],
    ).unwrap();
    let before = calls(lab.dir.path()).len();
    match lab.ws.collaboration_call(Some("dev"), "merge_unpause", json!({"requestId":"u","repositoryId":7})).await {
        Err(e) => assert!(e.to_string().starts_with("merge_unpause_not_allowed"), "{e}"),
        Ok(v) => panic!("the executor unpaused the queue: {v}"),
    }
    assert_eq!(calls(lab.dir.path()).len(), before, "a refused unpause reads nothing from GitHub");
    let answer = lab.ws.collaboration_call(Some("lead2"), "merge_unpause", json!({"requestId":"u","repositoryId":7,"reason":"fixed"})).await.unwrap();
    assert_eq!(answer["reanchored"], json!([waiting["id"]]), "every waiting entry is re-anchored: {answer}");
    let r = lab.paused();
    assert!(r["paused"].is_null());
    assert_eq!(r["pauses"][0]["clearedBy"]["by"], "Lead 2", "the unpause is journaled: {r}");
    let w: Value = {
        let db = lab.ws.store.db.read().unwrap();
        serde_json::from_str(&db.query_row("SELECT data FROM merge_entries WHERE number=12", [], |r| r.get::<_, String>(0)).unwrap()).unwrap()
    };
    assert_eq!(w["mainAtRelease"], merge_commit(), "re-anchored at the main read at the unpause");
    assert!(lab.mail("lead").iter().any(|m| m["priority"] == "urgent" && m["metadata"]["status"] == "unpaused"), "the leads are told");
}

#[cfg(unix)]
#[tokio::test]
async fn with_the_switch_off_core_writes_nothing() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    lab.ws.store.merge_set_enabled(7, false).unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "ready", "every check held: {e}");
    assert!(e["detail"].as_str().unwrap().contains("the merge queue is off"), "{}", e["detail"]);
    assert!(writes(lab.dir.path()).is_empty(), "with the switch off Core writes nothing");
    lab.ws.store.merge_set_enabled(7, true).unwrap();
    assert_eq!(lab.step().await["state"], "merged", "once it is on again, the entry merges after a fresh check");
}

#[cfg(unix)]
#[tokio::test]
async fn every_page_of_jobs_is_checked() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        let jobs = s["jobs"]["42"].as_array_mut().unwrap();
        for n in 0..98 {
            jobs.push(json!({"id":1000 + n,"name":format!("skip {n}"),"conclusion":"skipped"}));
        }
        jobs.push(json!({"id":700,"name":"Late","conclusion":"success"}));
        s["logs"]["700"] = json!(log(&sha('9')));
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["reason"], "checkout_mismatch", "a job on page 2 is checked too: {e}");
    assert!(e["detail"].as_str().unwrap().contains("Job 700"), "{}", e["detail"]);
}

#[cfg(unix)]
#[tokio::test]
async fn jobs_github_counts_but_core_did_not_read_prove_nothing() {
    let lab = lab_with(|s| s["jobsTotal"] = json!(4));
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["reason"], "checkout_unproven", "GitHub counts more jobs than Core read: {e}");
    assert!(e["detail"].as_str().unwrap().contains("Core read 3 of 4 jobs"), "{}", e["detail"]);
}

#[cfg(unix)]
#[tokio::test]
async fn a_log_download_holds_no_github_slot() {
    let lab = lab_with(|s| s["slowLog"] = json!(true));
    lab.release(Some("lead"), "r1").await.unwrap();
    let ws = lab.ws.clone();
    let check = tokio::spawn(async move { tick(&ws).await });
    let started = lab.dir.path().join("log-started");
    for _ in 0..200 {
        if started.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(started.exists(), "the check reached a job log");
    let both = tokio::time::timeout(std::time::Duration::from_millis(800), lab.ws.github.slots.acquire_many(2)).await;
    assert!(both.is_ok(), "while a job log downloads, the check holds no GitHub slot");
    drop(both);
    check.await.unwrap().unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_merge_journaled_before_core_stopped_stops_unknown_and_is_never_sent_again() {
    let lab = lab(green());
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    // The process stopped after journaling a merge request it may have sent;
    // GitHub did merge it.
    let mut m = e.clone();
    m["state"] = json!("merging");
    m["merge"] = json!({"expectedMain":main_sha(),"tree":tree(),"gate":"slot","head":head(),"attempts":1,"puts":[{"n":1}],"sha":null,"post":null,"mainCi":null});
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE merge_entries SET state='merging',next_check=0,data=?1", [m.to_string()]).unwrap();
    change(lab.dir.path(), |s| {
        s["pull"].as_object_mut().unwrap().extend([("merged".into(), json!(true)), ("state".into(), json!("closed")), ("merge_commit_sha".into(), json!(merge_commit()))]);
        s["main"] = json!(merge_commit());
        s["commits"][merge_commit()] = json!({"sha":merge_commit(),"tree":tree(),"parents":[main_sha(),head()]});
    });
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("merge_unknown")), "a journaled request with no recorded answer is unknown: {e}");
    assert!(e["detail"].as_str().unwrap().contains("may have been sent"), "{}", e["detail"]);
    assert_eq!(lab.paused()["paused"]["reason"], "merge_unknown", "and the queue pauses until a person has looked");
    assert!(writes(lab.dir.path()).is_empty(), "nothing was sent again");
}
/// Whatever fails once a request is journaled (it may have been sent) stops
/// the entry with merge_unknown at once: never github_unreachable, never a
/// wait for another request.
#[cfg(unix)]
#[tokio::test]
async fn a_failure_after_a_journaled_request_stops_unknown_at_once() {
    let lab = lab(green());
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let mut m = e.clone();
    m["state"] = json!("merging");
    m["merge"] = json!({"expectedMain":main_sha(),"tree":tree(),"gate":"slot","head":head(),"attempts":1,"puts":[{"n":1}],"sha":null,"post":null,"mainCi":null});
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE merge_entries SET state='merging',next_check=0,data=?1", [m.to_string()]).unwrap();
    let (id, attempt) = (e["id"].as_str().unwrap().to_owned(), e["attempt"].as_i64().unwrap_or(0));
    lab.ws.store.merge_answered(&id, attempt, Err("unavailable: the connection dropped".into()), 0).unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("merge_unknown")), "a failure after a journaled request stops merge_unknown at once: {e}");
    assert_eq!(lab.paused()["paused"]["reason"], "merge_unknown", "the queue pauses");
}

#[cfg(unix)]
#[tokio::test]
async fn with_the_switch_off_core_builds_no_batch() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    lab.ws.store.merge_set_enabled(7, false).unwrap();
    tick(&lab.ws).await.unwrap();
    assert!(writes(lab.dir.path()).is_empty(), "with the switch off Core builds no batch");
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "{e}");
    assert!(e["detail"].as_str().unwrap().contains("the merge queue is off"), "{}", e["detail"]);
    lab.ws.store.merge_set_enabled(7, true).unwrap();
    lab.step().await;
    assert_eq!(writes(lab.dir.path()).len(), 3, "once it is on, the batch is built");
}

#[cfg(unix)]
#[tokio::test]
async fn a_write_to_a_branch_core_did_not_make_is_refused() {
    let lab = lab(green());
    for branch in ["main", "queue/merge-not-an-entry", "feature"] {
        match super::writes::write(&lab.ws, 7, "owner/repo", super::writes::Write::DeleteBranch { branch }).await {
            Err(e) => assert!(e.to_string().starts_with("merge_write_refused"), "{branch}: {e}"),
            Ok(answer) => panic!("Core deleted {branch}, a branch it did not make: {answer:?}"),
        }
    }
    assert!(writes(lab.dir.path()).is_empty(), "nothing reached GitHub");
}

#[cfg(unix)]
#[tokio::test]
async fn main_moving_after_the_check_gets_no_merge_and_every_check_runs_again() {
    let moved = sha('c');
    let lab = lab_with(|s| {
        s["commits"][&moved] = json!({"sha":moved,"tree":sha('6'),"parents":[main_sha()]});
        // Main moves while the check downloads job logs, after it read main.
        s["mainOnLog"] = json!(moved);
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let w = writes(lab.dir.path());
    assert!(!w.iter().any(|w| w.starts_with("PUT")), "no merge request onto a main CI did not test: {w:?}");
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "{e}");
    assert!(e["detail"].as_str().unwrap().contains("since the check, so no merge was sent"), "{}", e["detail"]);
    let e = lab.step().await;
    assert_eq!(e["lastEvidence"]["main"]["before"], json!(moved), "every check runs again, from the new main: {e}");
    assert!(!writes(lab.dir.path()).iter().any(|w| w.starts_with("PUT")));
}

/// A `merging` entry the process stopped on before it journaled a request.
#[cfg(unix)]
async fn resumed_before_its_first_request(lab: &Lab) {
    let mut m = lab.entry().await;
    m["state"] = json!("merging");
    m["merge"] = json!({"expectedMain":main_sha(),"tree":tree(),"gate":"slot","head":head(),"attempts":0,"puts":[],"sha":null,"post":null,"mainCi":null});
    lab.ws.store.db.write().unwrap().execute("UPDATE merge_entries SET state='merging',next_check=0,data=?1", [m.to_string()]).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_merge_resumed_before_its_first_request_reads_main_first() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    resumed_before_its_first_request(&lab).await;
    change(lab.dir.path(), |s| s["main"] = json!(sha('c')));
    tick(&lab.ws).await.unwrap();
    assert!(writes(lab.dir.path()).is_empty(), "a resumed merge reads main before its first request and sends nothing onto a moved main");
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "{e}");
    assert!(e["detail"].as_str().unwrap().contains("Main moved"), "{}", e["detail"]);

    // On the main it expects, the resumed merge reads main, then sends.
    let lab = lab_with(|_| {});
    lab.release(Some("lead"), "r1").await.unwrap();
    resumed_before_its_first_request(&lab).await;
    let before = calls(lab.dir.path()).len();
    tick(&lab.ws).await.unwrap();
    let c = calls(lab.dir.path());
    let first = c[before..].iter().find(|c| c["method"] == "PUT" || c["endpoint"] == "repos/owner/repo/git/ref/heads/main").unwrap();
    assert_eq!(first["method"], "GET", "main is read right before the first request: {c:?}");
    assert_eq!(lab.entry().await["state"], "merged");
}

#[cfg(unix)]
#[tokio::test]
async fn a_pr_that_changed_before_the_first_request_is_refused_without_one() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    resumed_before_its_first_request(&lab).await;
    change(lab.dir.path(), |s| s["pull"]["head"]["sha"] = json!(sha('d')));
    tick(&lab.ws).await.unwrap();
    assert!(writes(lab.dir.path()).is_empty(), "no request for a head that moved");
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("merge_refused")), "{e}");
    assert!(e["detail"].as_str().unwrap().contains("The PR head moved"), "{}", e["detail"]);

    // Merged by someone else before Core sent anything: not Core's merge.
    let lab = lab_with(|_| {});
    lab.release(Some("lead"), "r1").await.unwrap();
    resumed_before_its_first_request(&lab).await;
    change(lab.dir.path(), |s| {
        s["pull"].as_object_mut().unwrap().extend([("merged".into(), json!(true)), ("state".into(), json!("closed")), ("merge_commit_sha".into(), json!(merge_commit()))]);
    });
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["reason"].clone()), (json!("stopped"), json!("merge_refused")), "a merge made outside the queue is not Core's: {e}");
    // Refused either way; only the detail tells it from a PR closed without a merge.
    assert!(e["detail"].as_str().unwrap().contains("merged outside the queue"), "a merge made outside the queue is named as one: {}", e["detail"]);
    assert!(writes(lab.dir.path()).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_paused_queue_merges_nothing() {
    let lab = lab(green());
    lab.ws.store.merge_set_enabled(7, true).unwrap();
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE merge_repositories SET data=json_set(data,'$.paused',json(?1)) WHERE repository_id=7",
        [json!({"reason":"post_check_failed","at":"2026-11-06T00:00:00Z","detail":"a test pause","main":sha('b'),"base":"main"}).to_string()],
    ).unwrap();
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "{e}");
    assert!(e["detail"].as_str().unwrap().contains("It waits until a lead or the user unpauses it"), "a paused queue holds the entry at its gate: {}", e["detail"]);
    assert!(writes(lab.dir.path()).is_empty(), "a paused queue merges nothing");
}

#[cfg(unix)]
#[tokio::test]
async fn a_batch_whose_ci_tested_another_merge_stops() {
    let lab = lab(green());
    change(lab.dir.path(), |s| {
        s["logs"]["501"] = json!(log(&sha('7')));
        s["logs"]["502"] = json!(log(&sha('7')));
    });
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    change(lab.dir.path(), |s| {
        batch_green(s);
        s["logs"]["602"] = json!(log(&sha('9')));
    });
    let e = lab.step().await;
    assert_eq!(e["reason"], "checkout_mismatch", "a batch whose CI tested another merge stops: {e}");
    assert!(!writes(lab.dir.path()).iter().any(|w| w.starts_with("PUT")), "nothing merged");
}

#[cfg(unix)]
#[tokio::test]
async fn one_merge_at_a_time_per_repository() {
    let lab = lab(green());
    let e = lab.release(Some("lead"), "r1").await.unwrap();
    let mut other = e.clone();
    other["id"] = json!(uuid::Uuid::new_v4().to_string());
    other["number"] = json!(12);
    other["state"] = json!("merging");
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,7,12,'merging',99999999999,?3)",
        rusqlite::params![other["id"].as_str(), other["taskId"].as_str(), other.to_string()],
    ).unwrap();
    tick(&lab.ws).await.unwrap();
    // The task's newest entry is #12's now: read #11's by its id.
    let e = lab.ws.collaboration_call(Some("lead"), "merge_get", json!({"entryId":e["id"]})).await.unwrap();
    assert_eq!(e["state"], "ready", "another merge of the repository is in flight: {e}");
    assert!(e["detail"].as_str().unwrap().contains("it merges after #12"), "{}", e["detail"]);
    assert!(writes(lab.dir.path()).is_empty(), "one merge at a time per repository");
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
        json!({"id":9,"name":"CI","head_sha":"new","conclusion":null,"status":"in_progress","created_at":"2026-11-06T02:00:00Z"}),
        json!({"id":8,"name":"CI","head_sha":"since","conclusion":"cancelled","status":"completed","created_at":"2026-11-06T01:00:00Z"}),
        json!({"id":7,"name":"CI","head_sha":"older","conclusion":"failure","status":"completed","created_at":"2026-11-06T00:30:00Z"}),
    ];
    assert!(checks::main_health(&main, "since", "2026-11-06T01:30:00Z", &[]).is_ok(), "runs before the release main do not count");
    assert!(
        checks::main_health(&main, "elsewhere", "2026-11-06T01:30:00Z", &[]).is_ok(),
        "a release main without a run of its own does not count the red runs from before the release"
    );
    assert!(
        matches!(checks::main_health(&main, "elsewhere", "2026-11-06T00:15:00Z", &[]), Err(Hold::Stop("main_red", _))),
        "a red run newer than the anchor stops the entry"
    );
    let red_anchor = vec![json!({"id":6,"name":"CI","head_sha":"since","conclusion":"failure","status":"completed","created_at":"2026-11-06T00:10:00Z"})];
    assert!(
        matches!(checks::main_health(&red_anchor, "since", "2026-11-06T01:00:00Z", &[]), Err(Hold::Stop("main_red", _))),
        "the anchor main's own red run counts, though it began before the release"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_job_log_read_stops_at_its_limit() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("gh.py");
    std::fs::write(&script, "#!/usr/bin/python3\nimport sys\nsys.stdout.write('x'*(5000 if 'jobs/1/logs' in ' '.join(sys.argv) else 10))\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let client = crate::github::client::Client { program: script.to_string_lossy().into(), deadline: std::time::Duration::from_secs(5), ..Default::default() };
    let (bytes, truncated) = client.log_prefix("repos/o/r/actions/jobs/1/logs", 1000).await.unwrap();
    assert_eq!((bytes.len(), truncated), (1000, true), "the read stops at the limit and says so");
    let (bytes, truncated) = client.log_prefix("repos/o/r/actions/jobs/2/logs", 1000).await.unwrap();
    assert_eq!((bytes.len(), truncated), (10, false));
}

#[test]
fn the_routes_and_tools_are_well_formed() {
    let _ = router();
    let tools = tool_definitions();
    assert_eq!(
        tools.iter().map(|t| t["name"].as_str().unwrap()).collect::<Vec<_>>(),
        ["merge_enqueue", "merge_get", "merge_list", "merge_cancel", "merge_retry", "merge_unpause"]
    );
    for tool in tools {
        let _: rmcp::model::Tool = serde_json::from_value(tool).unwrap();
    }
    assert!(
        crate::collaboration_store::tool_definitions().iter().any(|t| t["name"] == "merge_enqueue"),
        "the queue's tools are offered to Agents"
    );
}


/// The queue merges only into the repository's default branch: a PR into any
/// other base is refused at release, naming both, and nothing is queued.
#[cfg(unix)]
#[tokio::test]
async fn a_pr_into_another_branch_than_the_default_is_refused_at_release() {
    let lab = lab_with(|s| {
        s["pull"]["base"]["ref"] = json!("release-1.x");
        s["branches"] = json!({"release-1.x": sha('e')});
    });
    let released = lab.release(Some("lead"), "r1").await;
    assert!(released.is_err(), "a PR into another base is refused at release: {released:?}");
    let refused = released.unwrap_err().to_string();
    assert!(refused.starts_with("merge_not_default_branch"), "it says why: {refused}");
    assert!(refused.contains("(main)") && refused.contains("release-1.x"), "the refusal names both branches: {refused}");
    let queued: i64 = lab.ws.store.db.read().unwrap().query_row("SELECT COUNT(*) FROM merge_entries", [], |r| r.get(0)).unwrap();
    assert_eq!(queued, 0, "nothing is queued");
}

/// A pause belongs to the base it was recorded on: only that branch's newer
/// green head ends it.
#[test]
fn a_pause_is_ended_only_by_a_newer_green_head_of_its_own_base() {
    let paused = json!({"reason":"main_red","at":"2026-11-06T00:00:00Z","detail":"Main CI run 91 concluded failure","main":sha('b'),"run":91,"base":"main"});
    let green = vec![json!({"id":92,"name":"CI","head_sha":main_sha(),"status":"completed","conclusion":"success"})];
    assert!(checks::pause(&paused, "release-1.x", &main_sha(), &green).is_err(), "another base's green head does not end main's pause");
    assert!(matches!(checks::pause(&paused, "main", &main_sha(), &green), Ok(Some(_))), "main's own newer green head does");
}

/// An entry on another base (one released before the default branch changed)
/// is not re-anchored at main's head when main's pause ends.
#[cfg(unix)]
#[tokio::test]
async fn an_entry_on_another_base_is_not_reanchored_when_main_s_pause_ends() {
    let paused = json!({"reason":"main_red","at":"2026-11-06T00:00:00Z","detail":"Main CI run 91 concluded failure","main":sha('b'),"run":91,"base":"main"});
    let lab = lab(green());
    let id = lab.release(Some("lead"), "r1").await.unwrap()["id"].as_str().unwrap().to_owned();
    {
        let db = lab.ws.store.db.write().unwrap();
        db.execute("UPDATE merge_entries SET data=json_set(data,'$.baseBranch','release-1.x','$.mainAtRelease',?1) WHERE id=?2", rusqlite::params![sha('e'), id]).unwrap();
        db.execute("UPDATE merge_repositories SET data=json_set(data,'$.paused',json(?1)) WHERE repository_id=7", [paused.to_string()]).unwrap();
    }
    unpause_by_lead2(&lab).await;
    assert!(lab.paused()["paused"].is_null(), "the unpause ends the pause");
    let e = entry_by_id(&lab, &id).await;
    assert_eq!(e["mainAtRelease"], json!(sha('e')), "an entry on another base is not re-anchored at main's head: {e}");
}

/// A merge GitHub answers after the read deadline is still a certain answer:
/// the merge request has its own, longer deadline.
#[cfg(unix)]
#[tokio::test]
async fn a_merge_answered_after_the_read_deadline_is_merged_not_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let program = fake_gh(dir.path(), {
        let mut s = green();
        s["mergeAnswers"] = json!(["slowok"]);
        s
    });
    let mut ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let client = &mut Arc::get_mut(&mut ws).unwrap().github.client;
    client.program = program;
    // Reads time out after 1 s; the merge answers after 2 s.
    client.deadline = std::time::Duration::from_secs(1);
    let task = setup(&ws.store);
    let lab = Lab { dir, ws, task };
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "merged", "a merge answered after the read deadline is merged: {e}");
    assert_eq!(writes(lab.dir.path()).len(), 1, "with one request");
}

/// A merge that waits to be sent again (a rate limit, a request that never
/// left Core) is not sent onto a queue another entry paused meanwhile: the
/// entry goes back to waiting with nothing sent, and once the queue is
/// unpaused it is checked and merges.
#[cfg(unix)]
#[tokio::test]
async fn a_merge_waiting_to_be_resent_is_not_sent_onto_a_paused_queue() {
    for (answer, why) in [("429", "rate_limited"), ("noauth", "could not be sent")] {
        let lab = lab_with(|s| s["mergeAnswers"] = json!([answer]));
        lab.release(Some("lead"), "r1").await.unwrap();
        tick(&lab.ws).await.unwrap();
        let e = lab.entry().await;
        assert_eq!((e["state"].clone(), e["merge"]["attempts"].clone()), (json!("merging"), json!(0)), "{answer}: the merge waits to be sent again: {e}");
        assert!(e["detail"].as_str().unwrap().contains(why), "{answer}: {}", e["detail"]);
        let puts = || writes(lab.dir.path()).iter().filter(|w| w.starts_with("PUT")).count();
        let sent = puts();
        // Another entry's merge turned main red meanwhile, and the queue paused.
        lab.ws.store.db.write().unwrap().execute(
            "UPDATE merge_repositories SET data=json_set(data,'$.paused',json(?1)) WHERE repository_id=7",
            [json!({"reason":"main_red","at":"2026-11-06T00:00:00Z","detail":"Main CI run 91 concluded failure","main":main_sha(),"run":91,"base":"main"}).to_string()],
        ).unwrap();
        let e = lab.step().await;
        assert_eq!(puts(), sent, "{answer}: no merge request is sent onto a paused queue");
        assert_eq!(e["state"], "waiting", "{answer}: the entry waits for the unpause: {e}");
        assert!(e["detail"].as_str().unwrap().contains("paused"), "{answer}: it says why: {}", e["detail"]);
        lab.step().await;
        assert_eq!(puts(), sent, "{answer}: nor on the next pass while the queue is paused");
        unpause_by_lead2(&lab).await;
        let e = lab.step().await;
        assert_eq!(e["state"], "merged", "{answer}: once unpaused, the entry is checked and merges: {e}");
        assert_eq!(puts(), sent + 1, "{answer}: with one more request");
    }
}

/// Each repository names how its entries land. `core-merge`, the only landing
/// this Core has, is the default and is what a merge records; a landing this
/// Core does not have keeps a checked entry ready and sends nothing.
#[cfg(unix)]
#[tokio::test]
async fn an_entry_lands_with_core_merge_and_a_landing_this_core_lacks_sends_nothing() {
    let lab = lab(green());
    assert_eq!(lab.paused()["landing"], "core-merge", "a repository lands with core-merge unless set otherwise");
    let set = |landing: &str| {
        lab.ws.store.db.write().unwrap()
            .execute("UPDATE merge_repositories SET data=json_set(data,'$.landing',?1) WHERE repository_id=7", [landing])
            .unwrap();
    };
    set("github-auto-merge");
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "ready", "every check held, but this Core cannot land that way: {e}");
    assert!(e["detail"].as_str().unwrap().contains("cannot land with 'github-auto-merge'"), "the entry says why: {e}");
    assert!(writes(lab.dir.path()).is_empty(), "nothing was sent to GitHub");
    set("core-merge");
    let e = lab.step().await;
    assert_eq!(e["state"], "merged", "with core-merge the entry merges: {e}");
    assert_eq!(e["merge"]["landing"], "core-merge", "the merge records how it lands: {e}");
    assert_eq!(writes(lab.dir.path()), ["PUT repos/owner/repo/pulls/11/merge"]);
}

/// A merge that started with a landing this Core lacks (a later Core began
/// it) is never sent from here: the entry goes back to waiting and says why.
#[cfg(unix)]
#[tokio::test]
async fn a_merge_begun_with_a_landing_this_core_lacks_is_not_sent() {
    let lab = lab(green());
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE merge_repositories SET data=json_set(data,'$.landing','github-auto-merge') WHERE repository_id=7", [])
        .unwrap();
    lab.release(Some("lead"), "r1").await.unwrap();
    tick(&lab.ws).await.unwrap();
    let merge = json!({"expectedMain":main_sha(),"tree":tree(),"gate":"slot","landing":"github-auto-merge","head":head(),
        "attempts":0,"puts":[],"startedAt":"2026-11-06T00:00:00Z","sha":null,"post":null,"mainCi":null});
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE merge_entries SET state='merging',next_check=0,data=json_set(data,'$.state','merging','$.merge',json(?1))", [merge.to_string()])
        .unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "waiting", "the merge is not sent and the entry is checked again: {e}");
    assert!(e["detail"].as_str().unwrap().contains("cannot land with 'github-auto-merge'; nothing was sent"), "it says why: {e}");
    assert_eq!(e["retiredMerges"][0]["landing"], "github-auto-merge", "the unsent merge is kept: {e}");
    assert!(writes(lab.dir.path()).is_empty(), "nothing was sent to GitHub");
}

/// The user sets a repository's landing on its route: `core-merge`, the only
/// one this Core has. The two planned for core.25 are refused by name, and a
/// refused request saves nothing, its switch change included.
#[cfg(unix)]
#[tokio::test]
async fn the_landing_is_core_merge_and_the_planned_ones_are_refused_by_name() {
    use tower::ServiceExt;
    let lab = lab(green());
    let put = |body: Value| {
        axum::http::Request::builder()
            .method("PUT")
            .uri("/api/merge-queue/repositories/7")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap()
    };
    let answer = |response: axum::response::Response| async move {
        let status = response.status();
        (status, serde_json::from_slice::<Value>(&axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap())
    };
    for name in ["github-auto-merge", "github-merge-queue"] {
        let (status, body) = answer(router().with_state(lab.ws.clone()).oneshot(put(json!({"landing":name,"enabled":false}))).await.unwrap()).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "a planned landing is refused: {body}");
        assert!(body["error"].as_str().unwrap().contains(&format!("the {name} landing comes in core.25")), "{name} is refused by name: {body}");
    }
    let (status, body) = answer(router().with_state(lab.ws.clone()).oneshot(put(json!({"landing":"bors"}))).await.unwrap()).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"].as_str().unwrap().contains("unknown landing"), "{body}");
    let r = lab.paused();
    assert_eq!((r["landing"].clone(), r["enabled"].clone()), (json!("core-merge"), json!(true)), "a refused landing saves nothing, the switch included: {r}");
    // A later Core's landing, set back to core-merge: the switch journal says so.
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE merge_repositories SET data=json_set(data,'$.landing','github-auto-merge') WHERE repository_id=7", [])
        .unwrap();
    let (status, body) = answer(router().with_state(lab.ws.clone()).oneshot(put(json!({"landing":"core-merge"}))).await.unwrap()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    assert_eq!((body["landing"].clone(), body["enabled"].clone()), (json!("core-merge"), json!(true)), "setting the landing leaves the switch as it was: {body}");
    let last = body["switches"].as_array().and_then(|j| j.last()).cloned().unwrap_or_default();
    assert_eq!((last["detail"].clone(), last["by"].clone()), (json!("Landing set to core-merge"), json!("user")), "the switch journal records the landing: {body}");
}

/// Turning the switch on, through the user's route, makes an entry that was
/// ready and waiting for it due at once: the next pass merges it, with no
/// wait for its next check.
#[cfg(unix)]
#[tokio::test]
async fn turning_the_switch_on_makes_a_ready_entry_due_at_once() {
    use tower::ServiceExt;
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    lab.ws.store.merge_set_enabled(7, false).unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "ready", "every check held, with the switch off: {e}");
    let on = axum::http::Request::builder()
        .method("PUT")
        .uri("/api/merge-queue/repositories/7")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(json!({"enabled":true}).to_string()))
        .unwrap();
    assert_eq!(router().with_state(lab.ws.clone()).oneshot(on).await.unwrap().status(), axum::http::StatusCode::OK);
    // A plain pass, not one that makes every entry due.
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!(e["state"], "merged", "turning the switch on makes a ready entry due at once: {e}");
}

/// An entry that passed every check while the switch is off waits for the
/// switch: however long the switch stays off, it is not checked again, and
/// Core reads nothing from GitHub for it (no job pages or logs every five
/// minutes).
#[cfg(unix)]
#[tokio::test]
async fn a_ready_entry_is_not_checked_again_while_the_switch_stays_off() {
    let lab = lab(green());
    lab.release(Some("lead"), "r1").await.unwrap();
    lab.ws.store.merge_set_enabled(7, false).unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["checks"].clone()), (json!("ready"), json!(1)), "every check held, with the switch off: {e}");
    let reads = calls(lab.dir.path()).len();
    // A day goes by with the switch off.
    lab.ws.store.db.write().unwrap().execute("UPDATE merge_entries SET next_check=next_check-86400", []).unwrap();
    tick(&lab.ws).await.unwrap();
    let e = lab.entry().await;
    assert_eq!((e["state"].clone(), e["checks"].clone()), (json!("ready"), json!(1)), "while the switch stays off, a ready entry is not checked again: {e}");
    assert_eq!(calls(lab.dir.path()).len(), reads, "nor read from GitHub");
}
