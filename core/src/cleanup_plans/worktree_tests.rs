//! YN-74 ② (design 7, ②): a reclaimed worktree is pinned and kept, and
//! comes back as it was; what Core never removes; snapshots expire, refs not.
use super::*;

fn commit(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-q", "-m", name]);
}

/// Ignored without being a cleanup rule's: the repository's own exclude file.
fn ignore(lab: &Lab, pattern: &str) {
    let common = git(&lab.project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    let exclude = Path::new(&common).join("info/exclude");
    std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    let mut text = std::fs::read_to_string(&exclude).unwrap_or_default();
    text.push_str(&format!("{pattern}\n"));
    std::fs::write(exclude, text).unwrap();
}

/// Registers, approves and applies a one-group delete plan of `items`.
async fn reclaim(lab: &Lab, request: &str, items: Vec<Value>) -> Value {
    let plan = submit(lab, request, vec![group("d", "delete")], items).await;
    let key = format!("gate-{request}");
    ask(lab, &key, "ex", 4, &naming(&plan), &["d"]);
    reply(lab, &key, &["d"], None);
    apply_as(lab, "ex", &format!("go-{request}"), &plan, &key, &[]).await.unwrap();
    applied(lab, &plan).await;
    plan
}

async fn restore(lab: &Lab, actor: Option<&str>, request: &str, plan: &Value, item: &str) -> Result<Value> {
    lab.ws.collaboration_call(actor, "cleanup_restore", json!({"requestId": request, "planId": plan["planId"], "itemId": item})).await
}

fn tar_names(path: &str) -> Vec<String> {
    let bytes = std::fs::read(path).unwrap();
    let mut names: Vec<String> = tar::Archive::new(flate2::read::GzDecoder::new(&bytes[..])).entries().unwrap()
        .map(|e| e.unwrap().path().unwrap().display().to_string()).collect();
    names.sort();
    names
}

#[tokio::test]
async fn a_worktree_with_its_own_commit_is_pinned_kept_removed_and_comes_back_as_it_was() {
    let lab = lab();
    gated(&lab);
    ignore(&lab, "scratch-notes/");
    let tree = worktree(&lab, &lab.home.join("work/wt/ahead"), "feat/ahead");
    commit(&tree, "mine.txt", "only here\n");
    std::fs::write(tree.join("draft.md"), "untracked draft\n").unwrap();
    std::fs::create_dir_all(tree.join("scratch-notes")).unwrap();
    std::fs::write(tree.join("scratch-notes/n.txt"), "ignored, no rule\n").unwrap();
    cargo_target(&tree.join("target"), &["debug"]);
    let head = git(&tree, &["rev-parse", "HEAD"]);
    let plan = reclaim(&lab, "ahead", vec![item("w", "d", "worktree", &tree)]).await;
    assert!(!tree.exists(), "removed");
    let items = items_of(&lab, &plan).await;
    let w = items.iter().find(|i| i["item"] == "w").unwrap();
    assert_eq!(w["state"], "removed", "{w:#}");
    let pinned = w["result"]["ref"].as_str().unwrap().to_owned();
    // Named by the task's key now (DEM-1 in Project Demo), the plan and the item.
    assert_eq!(pinned, format!("refs/yuzuno/reclaimed/DEM-1/{}/w", plan["planId"].as_str().unwrap()));
    assert_eq!(git(&lab.project, &["rev-parse", &pinned]), head, "its commit is pinned");
    assert_eq!(git(&lab.project, &["rev-parse", "refs/heads/feat/ahead"]), head, "its branch stays");
    assert!(!git(&lab.project, &["worktree", "list", "--porcelain"]).contains("wt/ahead"), "pruned from Git's list");
    // What Git would not bring back is in its snapshot; what a rule rebuilds is not.
    assert_eq!(tar_names(w["snapshotKept"]["path"].as_str().unwrap()), ["draft.md", "scratch-notes/n.txt"]);
    // Only a lead or the user puts it back.
    let error = restore(&lab, Some("ex"), "r0", &plan, "w").await.unwrap_err().to_string();
    assert!(error.starts_with("not_allowed:"), "{error}");
    let back = restore(&lab, Some("lead"), "r1", &plan, "w").await.unwrap();
    assert_eq!(back["state"], "restored");
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&tree, &["symbolic-ref", "HEAD"]), "refs/heads/feat/ahead", "on its branch again");
    assert_eq!(std::fs::read_to_string(tree.join("mine.txt")).unwrap(), "only here\n");
    assert_eq!(std::fs::read_to_string(tree.join("draft.md")).unwrap(), "untracked draft\n");
    assert_eq!(std::fs::read_to_string(tree.join("scratch-notes/n.txt")).unwrap(), "ignored, no rule\n");
    assert_eq!(git(&tree, &["status", "--porcelain"]), "?? draft.md", "as it was");
    assert_eq!(restore(&lab, Some("lead"), "r1", &plan, "w").await.unwrap()["state"], "restored", "a retry is the same");
    let error = restore(&lab, Some("lead"), "r2", &plan, "w").await.unwrap_err().to_string();
    assert!(error.starts_with("item_restored:"), "{error}");
}

#[tokio::test]
async fn changes_git_tracks_need_save_diff_and_come_back_with_it() {
    let lab = lab();
    gated(&lab);
    let tree = worktree(&lab, &lab.project.join(".worktrees/edit"), "feat/edit");
    std::fs::write(tree.join("README.md"), "demo, edited\n").unwrap();
    let plain = submit(&lab, "no-diff", vec![group("d", "delete")], vec![item("w", "d", "worktree", &tree)]).await;
    assert_eq!(refused(&item_states(&lab, &plain).await, "w"), "trackedChanges");
    let mut with = item("w", "d", "worktree", &tree);
    with["saveDiff"] = json!(true);
    let plan = reclaim(&lab, "diff", vec![with]).await;
    assert!(!tree.exists());
    let items = items_of(&lab, &plan).await;
    let kept = &items.iter().find(|i| i["item"] == "w").unwrap()["snapshotKept"];
    assert!(kept["diff"]["path"].as_str().unwrap().ends_with("/w.diff"), "{kept:#}");
    restore(&lab, None, "r1", &plan, "w").await.unwrap();
    assert_eq!(std::fs::read_to_string(tree.join("README.md")).unwrap(), "demo, edited\n", "its change is applied again");
}

#[tokio::test]
async fn a_snapshot_over_the_limit_keeps_the_worktree_and_an_expired_snapshot_keeps_its_ref() {
    let lab = lab();
    gated(&lab);
    let tree = worktree(&lab, &lab.project.join(".worktrees/big"), "feat/big");
    std::fs::write(tree.join("draft.md"), "untracked\n").unwrap();
    settings_change(&lab, |c| c.snapshot_max_mib = 0);
    let plan = submit(&lab, "big", vec![group("d", "delete")], vec![item("w", "d", "worktree", &tree)]).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "w"), "snapshotTooLarge");
    settings_change(&lab, |c| c.snapshot_max_mib = 256);
    let head = git(&tree, &["rev-parse", "HEAD"]);
    let plan = reclaim(&lab, "small", vec![item("w", "d", "worktree", &tree)]).await;
    let items = items_of(&lab, &plan).await;
    let w = items.iter().find(|i| i["item"] == "w").unwrap().clone();
    let file = PathBuf::from(w["snapshotKept"]["path"].as_str().unwrap());
    assert!(file.exists());
    // Past snapshotDays: the snapshot goes, the ref stays.
    lab.ws.store.db.write().unwrap().execute(
        "UPDATE cleanup_items SET snapshot=json_set(snapshot,'$.at','2000-01-01T00:00:00+00:00') WHERE plan_id=?1 AND item_id='w'",
        [plan["planId"].as_str()]).unwrap();
    let data = lab.ws.data_dir.clone();
    assert_eq!(lab.ws.stored(move |s| worktrees::expire_snapshots(s, &data)).await.unwrap(), 1);
    assert!(!file.exists());
    let pinned = w["result"]["ref"].as_str().unwrap();
    assert_eq!(git(&lab.project, &["rev-parse", pinned]), head, "refs never expire");
    let back = restore(&lab, None, "r1", &plan, "w").await.unwrap();
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), head, "what Git keeps comes back");
    assert!(!tree.join("draft.md").exists());
    assert!(back["restored"]["how"].to_string().contains("expired"), "{back:#}");
}

#[tokio::test]
async fn a_scratch_entry_gets_back_its_evidence_and_nothing_comes_back_over_something_new() {
    let lab = lab();
    gated(&lab);
    let entry = old_entry(&lab, "job-e");
    let plan = reclaim(&lab, "entry", vec![item("e", "d", "entry", &entry)]).await;
    assert!(!entry.exists());
    std::fs::create_dir_all(&entry).unwrap();
    let error = restore(&lab, None, "r0", &plan, "e").await.unwrap_err().to_string();
    assert!(error.starts_with("path_taken:"), "{error}");
    std::fs::remove_dir(&entry).unwrap();
    restore(&lab, None, "r1", &plan, "e").await.unwrap();
    assert_eq!(std::fs::read(entry.join("out/shot.png")).unwrap(), vec![3u8; 1000]);
    assert!(entry.join("out/report.json").exists() && !entry.join("main.rs").exists(), "only its evidence");
}
