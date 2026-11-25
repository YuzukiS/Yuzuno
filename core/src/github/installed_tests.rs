//! R-38 S2b: what Core keeps of whether a merged PR is in the release it
//! runs, and when it asks GitHub (the lead's bounds on YN-227, comment 12384):
//! a PR's read records its merge commit; batches ask GitHub's compare, in the
//! stated direction, only for merged PRs whose answer against this release is
//! not kept, read the merge commit of one merged before Core kept them in one
//! read of the PR, keep "not in this repository" only when GitHub shows the
//! repository and says it has no such commit, back off a PR it could not
//! tell, share answers, questions under way and the rate limit across every
//! path, and drop answers against other releases. GitHub is a fixture; every
//! repository, commit and release is synthetic.
use super::{installed::*, *};
use rusqlite::params;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, sync::atomic::{AtomicU8, Ordering}};

const RELEASE: &str = "1111111111111111111111111111111111111111";
const M1: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const M2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const M3: &str = "cccccccccccccccccccccccccccccccccccccccc";
const M5: &str = "5555555555555555555555555555555555555555";
const M6: &str = "6666666666666666666666666666666666666666";

/// The release a test's Core runs, by its `AtomicU8`: 0 none (a source build), 1 RELEASE, 2 the next one. Each test
/// has its own, set once when its Workspace is made.
fn running(which: &AtomicU8) -> Option<Installed> {
    match which.load(Ordering::SeqCst) {
        1 => Some(Installed { release_id: "core-20261125-1111111".into(), version: "0.1.0".into(), git_sha: RELEASE.into() }),
        2 => Some(Installed { release_id: "core-20261126-2222222".into(), version: "0.1.1".into(), git_sha: "2".repeat(40) }),
        _ => None,
    }
}
static BATCHES: AtomicU8 = AtomicU8::new(1);
static LIMIT: AtomicU8 = AtomicU8::new(1);
static SHARED: AtomicU8 = AtomicU8::new(1);
static REFRESH: AtomicU8 = AtomicU8::new(0);

/// GitHub as a fixture. owner/repo (7) has the release's commit; its PRs #1-#3 merged as M1-M3: compared with the
/// release, M1 is in it ("behind": the head is an ancestor of the base), M2 merged after it ("ahead"), M3 is not
/// found. other/unrelated (8) is shown but has no such commit (422); secret/repo (9) is not shown (404). A PR read
/// with --jq gives its merge commit alone. With `.limit` next to it every compare is rate limited; with `.slow`
/// each compare takes 0.3 s. Each endpoint asked goes to `.calls`.
fn fixture(dir: &std::path::Path) -> std::path::PathBuf {
    let script = dir.join("gh-fixture.py");
    let next = "2".repeat(40);
    std::fs::write(&script, format!(r#"#!/usr/bin/python3
import sys,json,time
from pathlib import Path
endpoint=next(a for a in sys.argv if a.startswith('repos/') or a.startswith('repositories/'))
jq=sys.argv[sys.argv.index('--jq')+1] if '--jq' in sys.argv else None
with open(Path(__file__).with_suffix(".calls"), "a") as calls: print(endpoint, file=calls)
merges={{1:'{M1}',2:'{M2}',3:'{M3}',5:'{M5}',6:'{M6}'}}
if endpoint.startswith('repositories/') or endpoint.count('/')==2:
 print(json.dumps({{'id':7,'full_name':'owner/repo'}}))
elif '/compare/' in endpoint:
 assert jq == '.status', sys.argv
 if Path(__file__).with_suffix(".limit").exists(): print("HTTP 403: API rate limit exceeded",file=sys.stderr); sys.exit(1)
 if Path(__file__).with_suffix(".slow").exists(): time.sleep(.3)
 base,head=endpoint.split('/compare/')[1].split('?')[0].split('...')
 assert base in ('{RELEASE}','{next}'), endpoint
 if head=='{M3}': print("HTTP 404: Not Found",file=sys.stderr); sys.exit(1)
 print('behind' if head=='{M1}' else 'ahead')
elif '/check-runs?' in endpoint: print(json.dumps({{'total_count':0,'check_runs':[]}}))
elif '/status?' in endpoint: print(json.dumps({{'sha':'d'*40,'total_count':0,'statuses':[]}}))
elif '/commits/' in endpoint:
 repo=endpoint.split('/commits/')[0]
 if repo=='repos/owner/repo': print('HTTP/2.0 200 OK\r\n\r\n'+endpoint.split('/commits/')[1])
 elif repo=='repos/other/unrelated': print('HTTP/2.0 422 Unprocessable Entity\r\n\r\n'); print('HTTP 422',file=sys.stderr); sys.exit(1)
 else: print('HTTP/2.0 404 Not Found\r\n\r\n'); print('HTTP 404',file=sys.stderr); sys.exit(1)
elif '/pulls/' in endpoint:
 n=int(endpoint.split('/pulls/')[1])
 if jq: print(json.dumps({{'sha':merges[n].upper(),'at':'2026-11-24T10:00:00Z'}})); sys.exit(0)
 print(json.dumps({{'number':n,'title':f'Fixture {{n}}','state':'closed','merged_at':'2026-11-24T10:00:00Z','merge_commit_sha':merges[n].upper(),
  'head':{{'sha':'d'*40,'ref':'branch'}},'base':{{'sha':'e'*40,'ref':'main'}},'draft':False}}))
else: raise Exception(endpoint)
"#)).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    script
}

/// A Workspace on GitHub's fixture running `release`, with one Project and one task of it: the task's key, its
/// internal id and the Project.
fn lab(dir: &std::path::Path, release: fn() -> Option<Installed>) -> (Arc<Workspace>, String, String, String) {
    let mut ws = Workspace::new(dir.join("data"), "/fixture".into(), "unused".into()).unwrap();
    {
        let state = &mut Arc::get_mut(&mut ws).unwrap().github;
        state.client.program = fixture(dir).to_str().unwrap().into();
        state.release = release;
    }
    let project = ws.store.create_project("Code", BTreeMap::new()).unwrap().id;
    let task = ws.store.collaboration_call(None, "task_create",
        json!({"requestId":"t","title":"Deliver feature","projectId":project})).unwrap()["task"]["id"].as_str().unwrap().to_owned();
    let internal = crate::collaboration_store::task_key(&ws.store.db.read().unwrap(), &task).unwrap().0;
    ws.store.github_link_repo(&project, &client::Repository { id: 7, full_name: "owner/repo".into() }).unwrap();
    {
        let db = ws.store.db.write().unwrap();
        for (id, name) in [(8, "other/unrelated"), (9, "secret/repo")] {
            db.execute("INSERT INTO github_repositories(id,data) VALUES(?1,?2)", params![id, json!({"id":id,"fullName":name}).to_string()]).unwrap();
        }
    }
    (ws, task, internal, project)
}

/// PR #`number` of repository `repo`, merged, linked to the task with internal id `internal`; with its merge commit
/// when Core read it.
fn merged(ws: &Workspace, internal: &str, repo: i64, number: i64, merge: Option<&str>) {
    let db = ws.store.db.write().unwrap();
    let mut snapshot = json!({"title":format!("Fixture {number}"),"state":"merged","observedAt":"2026-11-24T10:00:00Z"});
    if let Some(merge) = merge {
        snapshot["mergeCommitSha"] = json!(merge);
    }
    let object = format!("{repo}:pull:{number}");
    db.execute("INSERT INTO github_objects(id,repo_id,kind,number,data) VALUES(?1,?2,'pull',?3,?4)",
        params![object, repo, number, json!({"snapshot":snapshot,"syncedAt":"2026-11-24T10:00:00Z","error":null}).to_string()]).unwrap();
    db.execute("INSERT INTO github_task_links(task_id,object_id) VALUES(?1,?2)", params![internal, object]).unwrap();
}

fn rows(ws: &Workspace, sql: &str) -> Vec<(String, Option<i64>)> {
    ws.store.db.read().unwrap().prepare(sql).unwrap()
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?))).unwrap()
        .collect::<rusqlite::Result<Vec<_>>>().unwrap()
}

/// What is kept against `installed`, by merge commit.
fn kept_rows(ws: &Workspace, installed: &str) -> Vec<(String, Option<i64>)> {
    rows(ws, &format!("SELECT merge_sha,contained FROM github_installed_commits WHERE installed_sha='{installed}' ORDER BY merge_sha"))
}

/// How many of the endpoints GitHub was asked contain `part`.
fn calls(dir: &std::path::Path, part: &str) -> usize {
    std::fs::read_to_string(dir.join("gh-fixture.calls")).unwrap_or_default().lines().filter(|l| l.contains(part)).count()
}

#[tokio::test]
async fn batches_ask_only_what_is_not_known_keep_unrelated_apart_from_unknown_and_back_off() {
    let dir = tempfile::tempdir().unwrap();
    let (ws, _task, internal, project) = lab(dir.path(), || running(&BATCHES));
    merged(&ws, &internal, 7, 1, Some(M1));
    merged(&ws, &internal, 7, 2, None);
    merged(&ws, &internal, 7, 3, Some(M3));
    merged(&ws, &internal, 8, 5, Some(M5));
    merged(&ws, &internal, 9, 6, Some(M6));
    let two = |more| Some(Batch { asked: 2, more, limited: false });

    // Two at a time, the newest first: #6's repository is not shown (unknown, backed off); #5's is shown without the
    // release's commit (kept as not applying, no compare).
    assert_eq!(pass(&ws, None, 2).await.unwrap(), two(true));
    ws.github.jobs.lock().unwrap().clear();
    // #3's compare is not found (unknown, backed off); #2's merge commit is read in one read of the PR, then compared.
    assert_eq!(pass(&ws, None, 2).await.unwrap(), two(true));
    ws.github.jobs.lock().unwrap().clear();
    assert_eq!(pass(&ws, None, 2).await.unwrap(), Some(Batch { asked: 1, more: false, limited: false }));
    assert_eq!(kept_rows(&ws, RELEASE), vec![(M5.into(), None), (M1.into(), Some(1)), (M2.into(), Some(0))]);
    assert_eq!(rows(&ws, "SELECT CAST(repo_id AS TEXT),has_commit FROM github_installed_repos ORDER BY repo_id"),
        vec![("7".into(), Some(1)), ("8".into(), Some(0))], "secret/repo is not known: GitHub did not show it");
    assert_eq!(rows(&ws, "SELECT object_id,tries FROM github_installed_tries ORDER BY object_id"),
        vec![("7:pull:3".into(), Some(1)), ("9:pull:6".into(), Some(1))]);
    assert_eq!((calls(dir.path(), "/compare/"), calls(dir.path(), "/commits/"), calls(dir.path(), "/pulls/")), (3, 3, 1),
        "one compare for each of #1-#3, the release's commit read once per repository, #2 read once");
    let snapshot: String = ws.store.db.read().unwrap()
        .query_row("SELECT json_extract(data,'$.snapshot.mergeCommitSha') FROM github_objects WHERE id='7:pull:2'", [], |r| r.get(0)).unwrap();
    assert_eq!(snapshot, M2, "kept in lower case, the rest of its snapshot as it was");
    // While #3 and #6 are not known, the Project's count is not given: never a 0 for lack of information.
    assert_eq!(merged_after(&ws.store.db.read().unwrap(), &project, &running(&BATCHES).unwrap()).unwrap(), None);

    // Within their backoff nothing is asked; once it has passed, each is asked again and waits longer.
    ws.github.jobs.lock().unwrap().clear();
    assert_eq!(pass(&ws, None, 2).await.unwrap(), Some(Batch { asked: 0, more: false, limited: false }));
    ws.store.db.write().unwrap().execute("UPDATE github_installed_tries SET next_at='2000-01-01T00:00:00Z'", []).unwrap();
    ws.github.jobs.lock().unwrap().clear();
    assert_eq!(pass(&ws, None, 2).await.unwrap(), two(false));
    assert_eq!(rows(&ws, "SELECT object_id,tries FROM github_installed_tries ORDER BY object_id"),
        vec![("7:pull:3".into(), Some(2)), ("9:pull:6".into(), Some(2))]);

    // A new release: what was kept against the old one is dropped, and each is asked again.
    BATCHES.store(2, Ordering::SeqCst);
    ws.github.jobs.lock().unwrap().clear();
    pass(&ws, None, 10).await.unwrap();
    assert!(kept_rows(&ws, RELEASE).is_empty(), "the old release's answers are dropped");
    assert_eq!(kept_rows(&ws, &"2".repeat(40)), vec![(M5.into(), None), (M1.into(), Some(1)), (M2.into(), Some(0))]);
}

#[tokio::test]
async fn the_rate_limit_stops_every_path_and_keeps_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (ws, _task, internal, _project) = lab(dir.path(), || running(&LIMIT));
    merged(&ws, &internal, 7, 1, Some(M1));
    merged(&ws, &internal, 7, 2, Some(M2));
    std::fs::write(dir.path().join("gh-fixture.limit"), "").unwrap();
    assert_eq!(pass(&ws, None, 10).await.unwrap(), Some(Batch { asked: 1, more: true, limited: true }), "it stops at its first compare");
    let cooling = ws.github.jobs.lock().unwrap()["installed:limited"];
    assert!(!cooling.0 && cooling.1 > Instant::now() + Duration::from_secs(200), "five minutes, for every path");
    let before = calls(dir.path(), "repos/");
    // The path a refresh takes asks nothing while it cools down.
    assert_eq!(check(&ws, 7, "owner/repo", M2, &running(&LIMIT).unwrap()).await.unwrap(), Asked::Limited);
    assert_eq!(calls(dir.path(), "repos/"), before);
    assert!(kept_rows(&ws, RELEASE).is_empty(), "a rate-limited compare keeps nothing");
}

#[tokio::test]
async fn a_kept_answer_is_not_asked_again_and_the_same_question_is_asked_once() {
    let dir = tempfile::tempdir().unwrap();
    let (ws, _task, _internal, _project) = lab(dir.path(), || running(&SHARED));
    let release = running(&SHARED).unwrap();
    std::fs::write(dir.path().join("gh-fixture.slow"), "").unwrap();
    let (a, b) = tokio::join!(check(&ws, 7, "owner/repo", M1, &release), check(&ws, 7, "owner/repo", M1, &release));
    let mut both = [format!("{:?}", a.unwrap()), format!("{:?}", b.unwrap())];
    both.sort();
    assert_eq!(both, ["Elsewhere", "Kept"], "two paths at once: one asks, the other takes its answer");
    assert_eq!(calls(dir.path(), "/compare/"), 1);
    assert_eq!(check(&ws, 7, "owner/repo", M1, &release).await.unwrap(), Asked::Kept);
    assert_eq!(calls(dir.path(), "/compare/"), 1, "kept: not asked again");
    assert_eq!(kept_rows(&ws, RELEASE), vec![(M1.into(), Some(1))]);
}

#[tokio::test]
async fn github_refresh_of_a_task_asks_about_its_merged_prs_and_a_source_build_asks_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (ws, task, _internal, _project) = lab(dir.path(), || running(&REFRESH));
    ws.collaboration_call(None, "github_links", json!({"taskId":task,"action":"link","input":"https://github.com/owner/repo/pull/1"}))
        .await.unwrap();
    let links = ws.collaboration_call(None, "github_links", json!({"taskId":task})).await.unwrap();
    assert_eq!((links["links"][0]["snapshot"]["mergeCommitSha"].clone(), links["links"][0]["snapshot"]["mergedAt"].clone()),
        (json!(M1), json!("2026-11-24T10:00:00Z")), "a PR read merged records when and as what");
    // A source build runs no release: nothing is asked.
    assert_eq!(pass(&ws, None, BATCH).await.unwrap(), None);
    ws.collaboration_call(None, "github_refresh", json!({"taskId":task})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(calls(dir.path(), "/compare/"), 0);

    // With a release, a refresh of the task asks about its merged PR, which it no longer reads.
    REFRESH.store(1, Ordering::SeqCst);
    let reads = calls(dir.path(), "/pulls/");
    ws.collaboration_call(None, "github_refresh", json!({"taskId":task})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while kept_rows(&ws, RELEASE).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(kept_rows(&ws, RELEASE), vec![(M1.into(), Some(1))]);
    assert_eq!(calls(dir.path(), "/pulls/"), reads, "a merged PR is not read again (YN-193)");
}
