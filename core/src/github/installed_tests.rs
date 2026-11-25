//! R-38 S2b: what Core keeps of whether a merged PR is in the release it
//! runs, and when it asks GitHub: a PR's read records its merge commit; a
//! pass asks GitHub's compare, in the stated direction, only for merged PRs
//! whose answer against this release is not kept, reads first the merge
//! commit of one merged before Core kept them, keeps "this repository has no
//! such commit" apart from "not in it", stops at the rate limit, and drops
//! answers against other releases. GitHub is a fixture; every repository,
//! commit and release is synthetic.
use super::{installed::*, *};
use crate::store::Store;
use std::{os::unix::fs::PermissionsExt, sync::atomic::{AtomicU8, Ordering}};

const RELEASE: &str = "1111111111111111111111111111111111111111";
const M1: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const M2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const M3: &str = "cccccccccccccccccccccccccccccccccccccccc";

/// The release a test's Core runs, by its `AtomicU8`: 0 none (a source build), 1 RELEASE, 2 the next one. Each test
/// has its own, set once when its Workspace is made.
fn running(which: &AtomicU8) -> Option<Installed> {
    match which.load(Ordering::SeqCst) {
        1 => Some(Installed { release_id: "core-20261125-1111111".into(), version: "0.1.0".into(), git_sha: RELEASE.into() }),
        2 => Some(Installed { release_id: "core-20261126-2222222".into(), version: "0.1.1".into(), git_sha: "2".repeat(40) }),
        _ => None,
    }
}
static FIRST: AtomicU8 = AtomicU8::new(1);
static SECOND: AtomicU8 = AtomicU8::new(0);

/// GitHub as a fixture: owner/repo (7), whose PRs #1-#3 merged as M1-M3. Compared with the release, M1 is in it
/// ("behind": the head is an ancestor of the base), M2 merged after it ("ahead"), and M3 is a commit the
/// repository's compare does not know (HTTP 404). With a `.limit` file next to it, every compare is rate limited.
/// Each endpoint asked goes to the `.calls` file.
fn fixture(dir: &std::path::Path) -> std::path::PathBuf {
    let script = dir.join("gh-fixture.py");
    let next = "2".repeat(40);
    std::fs::write(&script, format!(r#"#!/usr/bin/python3
import sys,json
from pathlib import Path
endpoint=next(a for a in sys.argv if a.startswith('repos/') or a.startswith('repositories/'))
with open(Path(__file__).with_suffix(".calls"), "a") as calls: print(endpoint, file=calls)
merges={{1:'{M1}',2:'{M2}',3:'{M3}'}}
if endpoint.startswith('repositories/') or endpoint.count('/')==2:
 print(json.dumps({{'id':7,'full_name':'owner/repo'}}))
elif '/compare/' in endpoint:
 assert sys.argv[sys.argv.index('--jq')+1] == '.status', sys.argv
 if Path(__file__).with_suffix(".limit").exists(): print("HTTP 403: API rate limit exceeded",file=sys.stderr); sys.exit(1)
 base,head=endpoint.split('/compare/')[1].split('?')[0].split('...')
 assert base=='{RELEASE}' or base=='{next}', endpoint
 if head=='{M3}': print("HTTP 404: Not Found",file=sys.stderr); sys.exit(1)
 print('behind' if head=='{M1}' else 'ahead')
elif '/pulls/' in endpoint:
 n=int(endpoint.split('/pulls/')[1])
 print(json.dumps({{'number':n,'title':f'Fixture {{n}}','state':'closed','merged_at':'2026-11-24T10:00:00Z','merge_commit_sha':merges[n].upper(),
  'head':{{'sha':'d'*40,'ref':'branch'}},'base':{{'sha':'e'*40,'ref':'main'}},'draft':False}}))
elif '/check-runs?' in endpoint: print(json.dumps({{'total_count':0,'check_runs':[]}}))
elif '/status?' in endpoint: print(json.dumps({{'sha':'d'*40,'total_count':0,'statuses':[]}}))
else: raise Exception(endpoint)
"#)).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    script
}

fn create(s: &Store) -> String {
    s.collaboration_call(None, "task_create", json!({"requestId":uuid::Uuid::new_v4().to_string(),"title":"Deliver feature"}))
        .unwrap()["task"]["id"].as_str().unwrap().to_owned()
}

/// What is kept of each merge commit against `installed`, by merge commit.
fn kept_rows(s: &Store, installed: &str) -> Vec<(String, Option<i64>)> {
    s.db.read().unwrap()
        .prepare("SELECT merge_sha,contained FROM github_installed_commits WHERE installed_sha=?1 ORDER BY merge_sha").unwrap()
        .query_map([installed], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        .collect::<rusqlite::Result<Vec<_>>>().unwrap()
}

fn compares(script: &std::path::Path) -> usize {
    std::fs::read_to_string(script.with_extension("calls")).unwrap_or_default().lines().filter(|l| l.contains("/compare/")).count()
}

#[tokio::test]
async fn a_pass_asks_only_about_merged_prs_whose_answer_against_this_release_is_not_kept() {
    let dir = tempfile::tempdir().unwrap();
    let script = fixture(dir.path());
    let mut ws = Workspace::new(dir.path().join("data"), "/fixture".into(), "unused".into()).unwrap();
    {
        let state = &mut Arc::get_mut(&mut ws).unwrap().github;
        state.client.program = script.to_str().unwrap().into();
        state.release = || running(&FIRST);
    }
    let task = ws.stored(|s| Ok(create(s))).await.unwrap();
    // #1 and #3 are linked now: the read records when and as what each merged.
    for n in [1, 3] {
        ws.collaboration_call(None, "github_links", json!({"taskId":task,"action":"link","input":format!("https://github.com/owner/repo/pull/{n}")}))
            .await.unwrap();
    }
    let links = ws.collaboration_call(None, "github_links", json!({"taskId":task})).await.unwrap();
    assert_eq!((links["links"][0]["snapshot"]["state"].clone(), links["links"][0]["snapshot"]["mergeCommitSha"].clone(),
        links["links"][0]["snapshot"]["mergedAt"].clone()), (json!("merged"), json!(M1), json!("2026-11-24T10:00:00Z")));
    // #2 was linked before Core kept merge commits: merged, with none.
    {
        let db = ws.store.db.write().unwrap();
        db.execute("INSERT INTO github_objects(id,repo_id,kind,number,data) VALUES('7:pull:2',7,'pull',2,?1)",
            [json!({"snapshot":{"title":"Fixture 2","state":"merged","observedAt":"2026-11-20T00:00:00Z"},"syncedAt":"2026-11-20T00:00:00Z","error":null}).to_string()]).unwrap();
        let (internal, _) = crate::collaboration_store::task_key(&db, &task).unwrap();
        db.execute("INSERT INTO github_task_links(task_id,object_id) VALUES(?1,'7:pull:2')", [internal]).unwrap();
    }

    assert_eq!(pass(&ws, None).await.unwrap(), Some(3));
    assert_eq!(kept_rows(&ws.store, RELEASE), vec![(M1.into(), Some(1)), (M2.into(), Some(0)), (M3.into(), None)],
        "in it, merged after it, and a commit the repository's compare does not know");
    let links = ws.collaboration_call(None, "github_links", json!({"taskId":task})).await.unwrap();
    assert_eq!(links["links"][1]["snapshot"]["mergeCommitSha"], M2, "#2 was read for its merge commit");
    assert_eq!(compares(&script), 3);

    // A second pass at once is the same one, coalesced; once it may run, nothing is unknown and nothing is asked.
    assert_eq!(pass(&ws, None).await.unwrap(), Some(0));
    ws.github.jobs.lock().unwrap().clear();
    assert_eq!(pass(&ws, None).await.unwrap(), Some(0));
    assert_eq!(compares(&script), 3, "what is kept is not asked again");

    // A new release: what was kept against the old one is dropped, and each is asked again.
    ws.github.jobs.lock().unwrap().clear();
    FIRST.store(2, Ordering::SeqCst);
    std::fs::write(script.with_extension("limit"), "").unwrap();
    assert_eq!(pass(&ws, None).await.unwrap(), Some(1), "the rate limit stops the pass at its first compare");
    assert!(kept_rows(&ws.store, RELEASE).is_empty(), "the old release's answers are dropped");
    assert!(kept_rows(&ws.store, &"2".repeat(40)).is_empty(), "a rate-limited compare keeps nothing");
    let cooling = ws.github.jobs.lock().unwrap()["installed:*"];
    assert!(!cooling.0 && cooling.1 > Instant::now() + Duration::from_secs(200), "five minutes before the next pass");
    std::fs::remove_file(script.with_extension("limit")).unwrap();
    ws.github.jobs.lock().unwrap().clear();
    assert_eq!(pass(&ws, None).await.unwrap(), Some(3));
    assert_eq!(kept_rows(&ws.store, &"2".repeat(40)).len(), 3);
}

#[tokio::test]
async fn github_refresh_of_a_task_asks_about_its_merged_prs_and_a_source_build_asks_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let script = fixture(dir.path());
    let mut ws = Workspace::new(dir.path().join("data"), "/fixture".into(), "unused".into()).unwrap();
    {
        let state = &mut Arc::get_mut(&mut ws).unwrap().github;
        state.client.program = script.to_str().unwrap().into();
        state.release = || running(&SECOND);
    }
    let task = ws.stored(|s| Ok(create(s))).await.unwrap();
    ws.collaboration_call(None, "github_links", json!({"taskId":task,"action":"link","input":"https://github.com/owner/repo/pull/1"}))
        .await.unwrap();
    // A source build runs no release: nothing is asked, and its start-up check does nothing.
    assert_eq!(pass(&ws, None).await.unwrap(), None);
    ws.collaboration_call(None, "github_refresh", json!({"taskId":task})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(compares(&script), 0);
    assert!(kept_rows(&ws.store, RELEASE).is_empty());

    // With a release, a refresh of the task asks about its merged PR, which it no longer reads.
    SECOND.store(1, Ordering::SeqCst);
    let reads = || std::fs::read_to_string(script.with_extension("calls")).unwrap_or_default().lines().filter(|l| l.contains("/pulls/")).count();
    let before = reads();
    ws.collaboration_call(None, "github_refresh", json!({"taskId":task})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while kept_rows(&ws.store, RELEASE).is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(kept_rows(&ws.store, RELEASE), vec![(M1.into(), Some(1))]);
    assert_eq!(reads(), before, "a merged PR is not read again (YN-193)");
}
