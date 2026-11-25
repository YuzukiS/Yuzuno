//! R-38 S2: what a request's card says of its task's own progress and
//! blocker, and of the pull requests the task links: whether each merged one
//! is in the release this Core runs, by the commit ancestry Core kept
//! (github/installed.rs), never asked of GitHub on the way. Every
//! repository, commit and release here is synthetic.
use super::*;
use crate::{github::installed::Installed, project_requests::page_for};

const INSTALLED: &str = "1111111111111111111111111111111111111111";
const M7: &str = "7777777777777777777777777777777777777777";
const M8: &str = "8888888888888888888888888888888888888888";
const M9: &str = "9999999999999999999999999999999999999999";
const M11: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn release() -> Installed {
    Installed { release_id: "core-20261125-1111111".into(), version: "0.1.0".into(), git_sha: INSTALLED.into() }
}

impl Lab {
    /// Pull request #`number` of repository `repo`, as Core last read it, linked to the task `key`; merged ones with
    /// their merge commit when Core read it.
    fn linked_pull(&self, key: &str, repo: i64, number: i64, state: &str, merge: Option<&str>) {
        let db = self.ws.store.db.write().unwrap();
        let object = format!("{repo}:pull:{number}");
        let mut snapshot = json!({"title":format!("[YN-1] 第 {number} 号"),"state":state,"observedAt":"2026-11-25T05:00:00Z"});
        if let Some(merge) = merge {
            snapshot["mergeCommitSha"] = json!(merge);
            snapshot["mergedAt"] = json!("2026-11-24T10:00:00Z");
        }
        db.execute("INSERT INTO github_objects(id,repo_id,kind,number,data) VALUES(?1,?2,'pull',?3,?4)",
            params![object, repo, number, json!({"snapshot":snapshot,"syncedAt":"2026-11-25T05:00:00Z","error":null}).to_string()]).unwrap();
        let (task, _) = crate::collaboration_store::task_key(&db, key).unwrap();
        db.execute("INSERT INTO github_task_links(task_id,object_id) VALUES(?1,?2)", params![task, object]).unwrap();
    }

    /// What Core keeps of GitHub's compare of `merge` with the installed commit: whether it is an ancestor, or
    /// None when the repository has no such commit.
    fn kept(&self, repo: i64, merge: &str, contained: Option<bool>) {
        self.ws.store.db.write().unwrap().execute(
            "INSERT INTO github_installed_commits(repo_id,merge_sha,installed_sha,contained,checked_at) VALUES(?1,?2,?3,?4,'2026-11-25T05:01:00Z')",
            params![repo, merge, INSTALLED, contained]).unwrap();
    }

    /// The Project's requests as its page reads them against `installed`.
    fn listed(&self, installed: Option<&Installed>) -> Value {
        page_for(&self.ws.store.db.read().unwrap(), &self.project, None, Some(50), installed).unwrap()
    }

    /// What GitHub (`gh_fixture`) was asked, every endpoint.
    fn asked_all(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("requests")).unwrap_or_default()
    }
}

/// Each merged PR's (number, state, installed) on R-n's only card.
fn installed_of(listed: &Value, n: i64) -> Vec<Value> {
    let request = listed["requests"].as_array().unwrap().iter().find(|r| r["n"] == n).unwrap();
    request["cards"][0]["prs"]["items"].as_array().unwrap().iter()
        .map(|pr| json!([pr["number"], pr["state"], pr["installed"]])).collect()
}

#[tokio::test]
async fn a_requests_card_says_its_tasks_progress_and_whether_each_merged_pr_is_in_the_release() {
    let lab = lab();
    let n = lab.say("把请求卡的进度做成分段条", "m1").await;
    let made = lab.route("desk", n, "请求进度条", "好。", vec![to_agent("进度条", "lead", "实施")]).await.unwrap();
    let key = made["routes"][0]["task"].as_str().unwrap().to_owned();
    // Before anyone writes it, a task has no progress or blocker, and no PRs.
    let fresh = lab.listed(Some(&release()));
    let card = &fresh["requests"][0]["cards"][0];
    assert_eq!((card["task"]["progress"].clone(), card["task"]["blocker"].clone(), card["prs"].clone()),
        (Value::Null, Value::Null, json!({"items":[]})));
    assert_eq!(fresh["mergedAfterInstalled"], 0, "no merged PR: none after the release");

    let long = "契约已合入，".to_owned() + &"进".repeat(300);
    let version = lab.task(&key)["version"].clone();
    lab.ws.store.collaboration_call(None, "task_update", json!({"requestId":"progress","taskId":key,"expectedVersion":version,
        "patch":{"progress":long,"blocker":"  等 core.40 发布  "}})).unwrap();
    // #7 is in the release, #8 merged after it, #9 merged before Core kept merge commits, #10 is open,
    // and #11 is of a repository the installed commit is not one of.
    lab.linked_pull(&key, 123, 7, "merged", Some(M7));
    lab.linked_pull(&key, 123, 8, "merged", Some(M8));
    lab.linked_pull(&key, 123, 9, "merged", None);
    lab.linked_pull(&key, 123, 10, "open", None);
    lab.linked_pull(&key, 124, 11, "merged", Some(M11));
    lab.kept(123, M7, Some(true));
    lab.kept(123, M8, Some(false));
    lab.kept(124, M11, None);

    let before = lab.asked_all();
    let listed = lab.listed(Some(&release()));
    assert_eq!(lab.asked_all(), before, "reading the page never asks GitHub");
    let task = &listed["requests"][0]["cards"][0]["task"];
    let progress = task["progress"].as_str().unwrap();
    assert_eq!(progress.chars().count(), 280);
    assert!(progress.starts_with("契约已合入，") && progress.ends_with("进…"), "{progress}");
    assert_eq!(task["blocker"], "等 core.40 发布");
    assert_eq!(lab.task(&key)["progress"].as_str().unwrap().chars().count(), 306, "the task keeps it whole");
    assert_eq!(installed_of(&listed, n), vec![json!([7, "merged", true]), json!([8, "merged", false]), json!([9, "merged", null]),
        json!([10, "open", null]), json!([11, "merged", null])]);
    assert_eq!(listed["requests"][0]["cards"][0]["prs"]["items"][0], json!({"number":7,"title":"[YN-1] 第 7 号",
        "url":"https://github.com/o/r/pull/7","repository":"o/r","state":"merged","mergedAt":"2026-11-24T10:00:00Z","installed":true}));
    assert_eq!(listed["requests"][0]["cards"][0]["prs"]["items"][3]["mergedAt"], Value::Null, "an open PR has not merged");
    assert_eq!(listed["installedRelease"], json!({"releaseId":"core-20261125-1111111","version":"0.1.0","gitSha":INSTALLED}));
    assert_eq!(listed["mergedAfterInstalled"], Value::Null, "#9's merge commit is not known, so no count is given");

    // Once #9's merge commit is read and kept as in the release, the count is known: #8 alone; #11 counts for neither.
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE github_objects SET data=json_set(data,'$.snapshot.mergeCommitSha',?1) WHERE id='123:pull:9'", [M9]).unwrap();
    lab.kept(123, M9, Some(true));
    let listed = lab.listed(Some(&release()));
    assert_eq!(listed["mergedAfterInstalled"], 1);
    assert_eq!(installed_of(&listed, n)[2], json!([9, "merged", true]));

    // Another release: what was kept against this one says nothing of it.
    let next = Installed { git_sha: "2222222222222222222222222222222222222222".into(), ..release() };
    let other = lab.listed(Some(&next));
    assert!(installed_of(&other, n).iter().all(|pr| pr[2].is_null()), "{other}");
    assert_eq!(other["mergedAfterInstalled"], Value::Null);
    // A source build runs no release: nothing is said installed, and there is no count.
    let source = lab.listed(None);
    assert_eq!((source["installedRelease"].clone(), source["mergedAfterInstalled"].clone()), (Value::Null, Value::Null));
    assert!(installed_of(&source, n).iter().all(|pr| pr[2].is_null()), "{source}");
    assert_eq!(lab.asked_all(), before, "still nothing asked of GitHub");
}

#[test]
fn only_a_managed_release_with_a_full_commit_is_a_release() {
    use crate::github::installed::of;
    let managed = json!({"releaseId":"core-20261125-abcdef0","version":"0.1.0","gitSha":"ABCDEF0123456789ABCDEF0123456789ABCDEF01","managed":true});
    assert_eq!(of(&managed), Some(Installed { release_id: "core-20261125-abcdef0".into(), version: "0.1.0".into(),
        git_sha: "abcdef0123456789abcdef0123456789abcdef01".into() }));
    assert_eq!(of(&json!({"releaseId":"development","version":"0.1.0","gitSha":null,"managed":false})), None, "a source build");
    for sha in ["abcdef0", "", "abcdef0123456789abcdef0123456789abcdef0g"] {
        let mut release = managed.clone();
        release["gitSha"] = json!(sha);
        assert_eq!(of(&release), None, "{sha}: no full commit, no release");
    }
    let mut unmanaged = managed;
    unmanaged["managed"] = json!(false);
    assert_eq!(of(&unmanaged), None);
}
