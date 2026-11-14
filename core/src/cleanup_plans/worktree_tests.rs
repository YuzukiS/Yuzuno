//! YN-74 ② (design 7, ②): a reclaimed worktree is pinned and kept, and
//! comes back as it was; what Core never removes; snapshots expire, refs not.
use super::*;

#[cfg(target_os = "linux")]
fn commit(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-q", "-m", name]);
}

/// Ignored without being a cleanup rule's: the repository's own exclude file.
#[cfg(target_os = "linux")]
fn ignore(lab: &Lab, pattern: &str) {
    let common = git(&lab.project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    let exclude = Path::new(&common).join("info/exclude");
    std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    let mut text = std::fs::read_to_string(&exclude).unwrap_or_default();
    text.push_str(&format!("{pattern}\n"));
    std::fs::write(exclude, text).unwrap();
}

/// Registers, approves and applies a one-group delete plan of `items`.
#[cfg(target_os = "linux")]
async fn reclaim(lab: &Lab, request: &str, items: Vec<Value>) -> Value {
    let plan = submit(lab, request, vec![group("d", "delete")], items).await;
    let key = format!("gate-{request}");
    ask(lab, &key, "ex", 4, &naming(&plan), &["d"]);
    reply(lab, &key, &["d"], None);
    apply_as(lab, "ex", &format!("go-{request}"), &plan, &key, &[]).await.unwrap();
    applied(lab, &plan).await;
    plan
}

#[cfg(target_os = "linux")]
async fn restore(lab: &Lab, actor: Option<&str>, request: &str, plan: &Value, item: &str) -> Result<Value> {
    lab.ws.collaboration_call(actor, "cleanup_restore", json!({"requestId": request, "planId": plan["planId"], "itemId": item})).await
}

#[cfg(target_os = "linux")]
fn tar_names(path: &str) -> Vec<String> {
    let bytes = std::fs::read(path).unwrap();
    let mut names: Vec<String> = tar::Archive::new(flate2::read::GzDecoder::new(&bytes[..])).entries().unwrap()
        .map(|e| e.unwrap().path().unwrap().display().to_string()).collect();
    names.sort();
    names
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

/// Review daaf3749: an untracked folder Git does not enter (a nested
/// repository) is kept whole, and comes back.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_nested_repository_git_does_not_enter_is_kept_whole_and_comes_back() {
    let lab = lab();
    gated(&lab);
    let tree = worktree(&lab, &lab.project.join(".worktrees/nest"), "feat/nest");
    let inner = tree.join("vendor/lib");
    std::fs::create_dir_all(&inner).unwrap();
    git(&inner, &["init", "-q"]);
    commit(&inner, "inner.txt", "inside a nested repository\n");
    let listed = git(&tree, &["ls-files", "--others", "--exclude-standard"]);
    assert_eq!(listed, "vendor/lib/", "Git names it as one folder");
    let plan = reclaim(&lab, "nest", vec![item("w", "d", "worktree", &tree)]).await;
    let items = items_of(&lab, &plan).await;
    let names = tar_names(items[0]["snapshotKept"]["path"].as_str().unwrap());
    assert!(names.contains(&"vendor/lib/inner.txt".to_owned()) && names.iter().any(|n| n.starts_with("vendor/lib/.git/")), "{names:?}");
    restore(&lab, None, "r1", &plan, "w").await.unwrap();
    assert_eq!(std::fs::read_to_string(inner.join("inner.txt")).unwrap(), "inside a nested repository\n");
    assert_eq!(git(&inner, &["log", "--format=%s"]), "inner.txt", "its history came back too");
}

/// Review daaf3749: a worktree removed only in part keeps its snapshot and
/// ref on record, and can be restored.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_worktree_removed_only_in_part_keeps_its_snapshot_on_record_and_comes_back() {
    use std::os::unix::fs::PermissionsExt as _;
    if rustix::process::geteuid().as_raw() == 0 {
        return; // root removes a read-only folder's files: nothing to stop it here
    }
    let lab = lab();
    gated(&lab);
    let tree = worktree(&lab, &lab.project.join(".worktrees/stuck"), "feat/stuck");
    let locked = tree.join("locked-notes");
    std::fs::create_dir_all(&locked).unwrap();
    std::fs::write(locked.join("x.txt"), "kept\n").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    let plan = reclaim(&lab, "stuck", vec![item("w", "d", "worktree", &tree)]).await;
    let items = items_of(&lab, &plan).await;
    let w = &items[0];
    let left: Vec<PathBuf> = std::fs::read_dir(tree.parent().unwrap()).unwrap().flatten().map(|e| e.path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(".yuzuno-removing-")).collect();
    for dir in &left {
        let _ = std::fs::set_permissions(dir.join("locked-notes"), std::fs::Permissions::from_mode(0o755));
    }
    assert_eq!(w["state"], "partial", "{w:#}");
    assert!(w["snapshotKept"]["path"].is_string() && w["result"]["ref"].is_string(), "its snapshot and ref stay on record: {w:#}");
    restore(&lab, None, "r1", &plan, "w").await.unwrap();
    assert_eq!(std::fs::read_to_string(tree.join("locked-notes/x.txt")).unwrap(), "kept\n");
    assert_eq!(item_states(&lab, &plan).await["w"].0, "restored");
}

/// Review daaf3749: nothing is made before the snapshot is checked, and a
/// branch checked out elsewhere comes back detached.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_changed_snapshot_makes_nothing_and_a_branch_checked_out_elsewhere_comes_back_detached() {
    let lab = lab();
    gated(&lab);
    let tree = worktree(&lab, &lab.project.join(".worktrees/twice"), "feat/twice");
    std::fs::write(tree.join("draft.md"), "untracked\n").unwrap();
    let head = git(&tree, &["rev-parse", "HEAD"]);
    let plan = reclaim(&lab, "twice", vec![item("w", "d", "worktree", &tree)]).await;
    let items = items_of(&lab, &plan).await;
    let file = PathBuf::from(items[0]["snapshotKept"]["path"].as_str().unwrap());
    let kept = std::fs::read(&file).unwrap();
    let mut changed = kept.clone();
    changed.push(0);
    std::fs::write(&file, changed).unwrap();
    let error = restore(&lab, None, "r1", &plan, "w").await.unwrap_err().to_string();
    assert!(error.starts_with("snapshot_changed:"), "{error}");
    assert!(!tree.exists(), "nothing was made");
    std::fs::write(&file, kept).unwrap();
    // Its branch is checked out in another worktree meanwhile.
    let other = worktree_on(&lab, &lab.project.join(".worktrees/other"), "feat/twice");
    let back = restore(&lab, None, "r2", &plan, "w").await.unwrap();
    assert!(back["restored"]["how"].to_string().contains("detached"), "{back:#}");
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), head);
    assert!(other.exists());
}

/// A worktree of an existing branch.
#[cfg(target_os = "linux")]
fn worktree_on(lab: &Lab, path: &Path, branch: &str) -> PathBuf {
    git(&lab.project, &["worktree", "add", "-q", &path.display().to_string(), branch]);
    std::fs::canonicalize(path).unwrap()
}

/// Lead, mail 10748: only the reclaimed worktree's own record goes. Another
/// worktree whose folder is away for now (a drive not mounted) keeps its
/// record, and comes back to it.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn only_the_reclaimed_worktree_s_record_goes_not_one_whose_folder_is_away_for_now() {
    let lab = lab();
    gated(&lab);
    let away = worktree(&lab, &lab.project.join(".worktrees/away"), "feat/away");
    let tree = worktree(&lab, &lab.project.join(".worktrees/done"), "feat/done");
    let stored = lab.root().join("unmounted-drive");
    std::fs::rename(&away, &stored).unwrap();
    let listed = |lab: &Lab| git(&lab.project, &["worktree", "list", "--porcelain"]);
    assert!(listed(&lab).contains(&format!("worktree {}", away.display())), "Git still has its record");
    let plan = reclaim(&lab, "own-record", vec![item("w", "d", "worktree", &tree)]).await;
    let items = items_of(&lab, &plan).await;
    assert_eq!(items[0]["result"]["record"]["dropped"], true, "{:#}", items[0]);
    let after = listed(&lab);
    assert!(!after.contains(&format!("worktree {}", tree.display())), "its own record went: {after}");
    assert!(after.contains(&format!("worktree {}", away.display())), "the other one's stays: {after}");
    // Its drive comes back: it is a worktree as before.
    std::fs::rename(&stored, &away).unwrap();
    assert_eq!(git(&away, &["rev-parse", "--abbrev-ref", "HEAD"]), "feat/away");
    // Restoring drops nothing but the restored worktree's own record either.
    std::fs::rename(&away, &stored).unwrap();
    restore(&lab, None, "r1", &plan, "w").await.unwrap();
    assert!(listed(&lab).contains(&format!("worktree {}", away.display())), "still there after a restore");
    std::fs::rename(&stored, &away).unwrap();
}

#[test]
fn a_record_is_dropped_only_when_it_alone_names_a_path_that_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let common = root.join("repo/.git");
    let record = |id: &str, gitdir: &str| {
        let at = common.join("worktrees").join(id);
        std::fs::create_dir_all(&at).unwrap();
        std::fs::write(at.join("gitdir"), format!("{gitdir}\n")).unwrap();
        at
    };
    let gone = root.join("wt/gone");
    let rel = record("rel", "../../../../wt/gone/.git");
    assert_eq!(worktrees::drop_record(&common, &gone), Ok(Some("rel".to_owned())), "a relative gitdir names it too");
    assert!(!rel.exists());
    let here = root.join("wt/here");
    std::fs::create_dir_all(&here).unwrap();
    record("here", &format!("{}/.git", here.display()));
    assert!(worktrees::drop_record(&common, &here).unwrap_err().contains("still there"));
    let locked = record("locked", &format!("{}/.git", gone.display()));
    std::fs::write(locked.join("locked"), "on a drive\n").unwrap();
    assert!(worktrees::drop_record(&common, &gone).unwrap_err().contains("locked"));
    std::fs::remove_file(locked.join("locked")).unwrap();
    record("twin", &format!("{}/.git", gone.display()));
    assert!(worktrees::drop_record(&common, &gone).unwrap_err().contains("2 of Git's"), "two records: neither goes");
    assert_eq!(worktrees::drop_record(&common, &root.join("wt/none")), Ok(None));
}
