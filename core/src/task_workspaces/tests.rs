//! T-169 on a throwaway Git repository with synthetic records: what a
//! workspace shows, what creating one registers, and that cleanup removes
//! only selected, unprotected Cargo profile output, once, as previewed.
use super::*;
use crate::model::AgentDetail;
use std::collections::BTreeMap;

const TAG: &str = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n# For information about cache directory tags see https://bford.info/cachedir/\n";

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    repo: PathBuf,
    task: String,
}

/// A Workspace with task T-1 in a Project linked to example/demo, Agent "a",
/// and a checkout of example/demo whose target/ is ignored.
fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let repo = dir.path().join("demo");
    std::fs::create_dir(&repo).unwrap();
    sh(&repo, &["init", "-q"]);
    std::fs::write(repo.join(".gitignore"), "target/\nnode_modules/\n").unwrap();
    std::fs::write(repo.join("README.md"), "demo\n").unwrap();
    sh(&repo, &["add", "."]);
    sh(&repo, &["commit", "-q", "-m", "first"]);
    sh(&repo, &["remote", "add", "origin", "https://github.com/example/demo.git"]);
    sh(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    let repo = std::fs::canonicalize(repo).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":repo,"model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Demo","status":"doing"})).unwrap();
    let project = ws.store.create_project("Demo", BTreeMap::new()).unwrap();
    {
        let db = ws.store.db.write().unwrap();
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        crate::projects::set_task_project(&db, &task, Some(&project.id)).unwrap();
        db.execute("INSERT INTO github_repositories(id,data) VALUES(42,'{\"id\":42,\"fullName\":\"example/demo\"}')", []).unwrap();
        db.execute("INSERT INTO github_project_repos(project_id,repo_id) VALUES(?1,42)", [&project.id]).unwrap();
    }
    Lab { _dir: dir, ws, repo, task: "T-1".into() }
}

fn job(lab: &Lab, id: &str, status: &str, data: Value) {
    let db = lab.ws.store.db.write().unwrap();
    let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
    let mut data = data;
    data["id"] = json!(id);
    data["name"] = json!(format!("job {id}"));
    db.execute(
        "INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES(?1,?2,'a',?3,?4,?5)",
        params![id, task, status, (status == "running") as i64, data.to_string()],
    )
    .unwrap();
}

/// A Cargo profile directory with one file of `bytes`.
fn profile(target: &Path, name: &str, bytes: usize) -> PathBuf {
    let dir = target.join(name);
    std::fs::create_dir_all(dir.join(".fingerprint")).unwrap();
    std::fs::create_dir_all(dir.join("deps")).unwrap();
    std::fs::write(dir.join(".cargo-lock"), "").unwrap();
    std::fs::write(dir.join("deps/blob"), vec![7u8; bytes]).unwrap();
    dir
}

fn error(result: Result<Value>) -> String {
    result.unwrap_err().to_string()
}

#[test]
fn github_remote_urls_name_their_repository() {
    for url in ["https://github.com/example/demo.git", "https://github.com/example/demo", "git@github.com:example/demo.git",
        "ssh://git@github.com/example/demo.git", "https://token@github.com/example/demo/"] {
        assert_eq!(github_name(url).as_deref(), Some("example/demo"), "{url}");
    }
    for url in ["https://gitlab.com/example/demo.git", "https://github.com/example", "/srv/git/demo.git"] {
        assert_eq!(github_name(url), None, "{url}");
    }
}

#[tokio::test]
async fn a_registered_worktree_shows_its_git_state_and_who_uses_it() {
    let lab = lab();
    let sub = lab.repo.join("docs");
    std::fs::create_dir(&sub).unwrap();
    let refused = error(register_workspace(lab.ws.clone(), lab.task.clone(), Register { path: sub.display().to_string() }).await);
    assert!(refused.contains("not the top folder"), "{refused}");
    assert!(error(register_workspace(lab.ws.clone(), lab.task.clone(), Register { path: "relative/path".into() }).await).contains("absolute"));

    std::fs::write(lab.repo.join("README.md"), "changed\n").unwrap();
    std::fs::write(lab.repo.join("notes.txt"), "mine\n").unwrap();
    job(&lab, "live", "running", json!({"cwd": lab.repo, "taskRef": "T-1"}));
    job(&lab, "elsewhere", "running", json!({"cwd": "/srv/other", "taskRef": "T-1"}));
    let view = register_workspace(lab.ws.clone(), lab.task.clone(), Register { path: lab.repo.display().to_string() }).await.unwrap();
    assert_eq!(view["state"], "present");
    assert_eq!(view["git"]["branch"], "main");
    assert_eq!(view["git"]["origin"], "example/demo");
    assert_eq!(view["git"]["repositoryId"], 42);
    assert_eq!(view["git"]["changes"], json!({"modified": 1, "untracked": 1, "complete": true}));
    assert_eq!(view["users"]["agents"][0]["name"], "Mori");
    assert_eq!(view["users"]["agents"][0]["relation"], "inside");
    let live: Vec<&str> = view["users"]["liveJobs"].as_array().unwrap().iter().map(|j| j["id"].as_str().unwrap()).collect();
    assert_eq!(live, ["live"]);
    let again = error(register_workspace(lab.ws.clone(), lab.task.clone(), Register { path: lab.repo.display().to_string() }).await);
    assert!(again.contains("already registered"), "{again}");

    // Replaced at the same path: no longer the registered folder.
    let listed = list_workspaces(lab.ws.clone(), lab.task.clone()).await.unwrap();
    assert_eq!(listed["workspaces"].as_array().unwrap().len(), 1);
    let moved = lab.repo.with_extension("moved");
    std::fs::rename(&lab.repo, &moved).unwrap();
    std::fs::create_dir(&lab.repo).unwrap();
    let listed = list_workspaces(lab.ws.clone(), lab.task.clone()).await.unwrap();
    assert_eq!(listed["workspaces"][0]["state"], "changed");
    let id = listed["workspaces"][0]["id"].as_str().unwrap().to_owned();
    assert!(error(preview_cleanup(lab.ws.clone(), lab.task.clone(), id.clone()).await).contains("no longer the folder"));
    let forgotten = forget_workspace(lab.ws.clone(), lab.task.clone(), id).await.unwrap();
    assert_eq!(forgotten["forgotten"], true);
    assert!(moved.join("notes.txt").exists() && lab.repo.exists(), "forgetting touches no file");
}

fn creation(lab: &Lab, branch: &str, path: &Path) -> Create {
    Create { repository: lab.repo.display().to_string(), branch: branch.into(), base: None, path: path.display().to_string() }
}

#[tokio::test]
async fn creating_a_worktree_registers_it_only_once_git_made_it_as_asked() {
    let lab = lab();
    let parent = lab.repo.parent().unwrap().to_path_buf();
    let target = parent.join("demo-t1");
    let bad = error(create_worktree(lab.ws.clone(), lab.task.clone(), creation(&lab, "bad..name", &target)).await);
    assert!(bad.contains("not a valid branch name"), "{bad}");
    let taken = error(create_worktree(lab.ws.clone(), lab.task.clone(), creation(&lab, "main", &target)).await);
    assert!(taken.contains("already exists"), "{taken}");
    let occupied = parent.join("occupied");
    std::fs::create_dir(&occupied).unwrap();
    let busy = error(create_worktree(lab.ws.clone(), lab.task.clone(), creation(&lab, "t1/work", &occupied)).await);
    assert!(busy.contains("already exists"), "{busy}");

    let view = create_worktree(lab.ws.clone(), lab.task.clone(), creation(&lab, "t1/work", &target)).await.unwrap();
    assert_eq!(view["origin"], "created");
    assert_eq!(view["branch"], "t1/work");
    assert_eq!(view["git"]["branch"], "t1/work");
    assert_eq!(view["git"]["sameRepository"], true);
    assert_eq!(view["baseSha"].as_str(), Some(sh(&lab.repo, &["rev-parse", "HEAD"]).as_str()));
    assert_eq!(sh(&target, &["rev-parse", "--abbrev-ref", "HEAD"]), "t1/work");

    // A checkout of a repository the task is not linked to: nothing happens.
    sh(&lab.repo, &["remote", "set-url", "origin", "https://github.com/someone/else.git"]);
    let other = parent.join("demo-other");
    let unlinked = error(create_worktree(lab.ws.clone(), lab.task.clone(), creation(&lab, "t1/other", &other)).await);
    assert!(unlinked.contains("not a repository linked"), "{unlinked}");
    assert!(!other.exists());
    sh(&lab.repo, &["remote", "set-url", "origin", "https://github.com/example/demo.git"]);
    // Git refuses (the base does not exist): no record, no folder.
    let mut input = creation(&lab, "t1/none", &parent.join("demo-none"));
    input.base = Some("no-such-ref".into());
    assert!(error(create_worktree(lab.ws.clone(), lab.task.clone(), input).await).contains("not a commit"));
    let listed = list_workspaces(lab.ws.clone(), lab.task.clone()).await.unwrap();
    assert_eq!(listed["workspaces"].as_array().unwrap().len(), 1);
}

/// The registered checkout with Cargo output, someone's evidence beside it,
/// another worktree inside, and a link out.
async fn cargo_lab() -> (Lab, String, PathBuf) {
    let lab = lab();
    let target = lab.repo.join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("CACHEDIR.TAG"), TAG).unwrap();
    profile(&target, "debug", 40_000);
    profile(&target, "release", 20_000);
    std::fs::create_dir_all(target.join("t110")).unwrap();
    std::fs::write(target.join("t110/report.json"), "{}").unwrap();
    // Another worktree inside, with its own Cargo output: not this workspace's.
    let nested = lab.repo.join("wt/other");
    std::fs::create_dir_all(nested.join("target")).unwrap();
    std::fs::write(nested.join(".git"), "gitdir: /elsewhere\n").unwrap();
    std::fs::write(nested.join("target/CACHEDIR.TAG"), TAG).unwrap();
    profile(&nested.join("target"), "debug", 1000);
    // A link to Cargo output outside: never followed.
    let outside = lab._dir.path().join("outside-target");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("CACHEDIR.TAG"), TAG).unwrap();
    profile(&outside, "debug", 1000);
    std::os::unix::fs::symlink(&outside, lab.repo.join("linked")).unwrap();
    std::fs::write(lab.repo.join(".gitignore"), "target/\nnode_modules/\nwt/\nlinked\n").unwrap();
    sh(&lab.repo, &["commit", "-q", "-am", "ignore"]);
    let view = register_workspace(lab.ws.clone(), lab.task.clone(), Register { path: lab.repo.display().to_string() }).await.unwrap();
    let id = view["id"].as_str().unwrap().to_owned();
    (lab, id, outside)
}

fn candidate<'a>(preview: &'a Value, relative: &str) -> &'a Value {
    preview["candidates"].as_array().unwrap().iter().find(|c| c["relative"] == relative).unwrap()
}

#[tokio::test]
async fn cleanup_offers_only_cargo_profiles_of_this_worktree_and_keeps_the_rest() {
    let (lab, id, outside) = cargo_lab().await;
    let preview = preview_cleanup(lab.ws.clone(), lab.task.clone(), id).await.unwrap();
    let offered: Vec<&str> = preview["candidates"].as_array().unwrap().iter().map(|c| c["relative"].as_str().unwrap()).collect();
    assert_eq!(offered, ["target/debug", "target/release"]);
    let kept: Vec<(&str, &str)> = preview["kept"].as_array().unwrap().iter()
        .map(|k| (k["path"].as_str().unwrap(), k["reason"].as_str().unwrap())).collect();
    assert!(kept.contains(&("target/t110", "Not recognized as Cargo build output: it may be yours")), "{kept:?}");
    assert!(kept.iter().any(|(p, r)| *p == "wt/other" && r.contains("Another Git working tree")), "{kept:?}");
    assert!(!preview.to_string().contains(&*outside.to_string_lossy()), "a link is not followed");
    assert_eq!(preview["bounds"]["complete"], true);
    let debug = candidate(&preview, "target/debug");
    assert!(debug["estimate"]["bytes"].as_u64().unwrap() >= 40_000);
    assert_eq!(debug["protected"], json!([]));
}

#[tokio::test]
async fn protections_come_from_git_builds_jobs_agents_and_evidence() {
    let (lab, id, _) = cargo_lab().await;
    let debug = lab.repo.join("target/debug");
    let release = lab.repo.join("target/release");
    // A build holding the lock, a tracked file, evidence a finished Job recorded.
    let lock = std::fs::File::open(debug.join(".cargo-lock")).unwrap();
    lock.lock().unwrap();
    std::fs::write(release.join("keep.txt"), "tracked").unwrap();
    sh(&lab.repo, &["add", "-f", "target/release/keep.txt"]);
    sh(&lab.repo, &["commit", "-q", "-m", "track"]);
    job(&lab, "done", "succeeded", json!({"cwd": "/srv/x", "result": {"artifacts": [{"absolutePath": release.join("app")}]}}));
    let preview = preview_cleanup(lab.ws.clone(), lab.task.clone(), id.clone()).await.unwrap();
    let reasons = |rel: &str| candidate(&preview, rel)["protected"].as_array().unwrap().iter()
        .map(|r| r.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert!(reasons("target/debug").contains(&"Cargo is building here now".to_owned()), "{:?}", reasons("target/debug"));
    let release_reasons = reasons("target/release");
    assert!(release_reasons.contains(&"Git tracks files here".to_owned()), "{release_reasons:?}");
    assert!(release_reasons.iter().any(|r| r.contains("kept as evidence: done")), "{release_reasons:?}");
    // Selecting a protected candidate removes nothing.
    let refused = remove_selected(lab.ws.clone(), lab.task.clone(), id.clone(),
        Execute { preview_id: preview["id"].as_str().unwrap().into(), candidates: vec![candidate(&preview, "target/debug")["id"].as_str().unwrap().into()] })
        .await
        .unwrap();
    assert_eq!(refused["results"][0]["state"], "refused");
    assert!(debug.exists());
    drop(lock);

    // A running Job in the worktree, and an Agent working there, protect it all.
    job(&lab, "build", "running", json!({"cwd": lab.repo.join("core")}));
    lab.ws.store.update("a", "turn/started", &json!({}), |d| d.agent.status = "working".into()).unwrap();
    let preview = preview_cleanup(lab.ws.clone(), lab.task.clone(), id).await.unwrap();
    for c in preview["candidates"].as_array().unwrap() {
        let reasons = c["protected"].to_string();
        assert!(reasons.contains("Job job build (build) is running in this worktree"), "{reasons}");
        assert!(reasons.contains("Agent Mori is working in this worktree"), "{reasons}");
    }
}

#[tokio::test]
async fn removal_is_once_per_preview_and_refuses_what_changed_since() {
    let (lab, id, _) = cargo_lab().await;
    let debug = lab.repo.join("target/debug");
    let release = lab.repo.join("target/release");
    let preview = preview_cleanup(lab.ws.clone(), lab.task.clone(), id.clone()).await.unwrap();
    let pid = preview["id"].as_str().unwrap().to_owned();
    let ids = |p: &Value| p["candidates"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    // release changes after the preview: it is refused, debug goes.
    std::fs::create_dir(release.join("new")).unwrap();
    let done = remove_selected(lab.ws.clone(), lab.task.clone(), id.clone(), Execute { preview_id: pid.clone(), candidates: ids(&preview) }).await.unwrap();
    let states: Vec<(&str, &str)> = done["results"].as_array().unwrap().iter()
        .map(|r| (r["relative"].as_str().unwrap(), r["state"].as_str().unwrap())).collect();
    assert_eq!(states, [("target/debug", "removed"), ("target/release", "refused")]);
    assert!(done["results"][1]["reason"].as_str().unwrap().contains("changed since the preview"));
    assert!(!debug.exists() && release.exists());
    assert!(lab.repo.join("target/t110/report.json").exists(), "what was kept stays");
    assert!(lab.repo.join("wt/other/target/debug").exists(), "another worktree's output stays");
    let leftovers = std::fs::read_dir(lab.repo.join("target")).unwrap().flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(REMOVING)).count();
    assert_eq!(leftovers, 0);
    assert!(done["freedBytes"].is_string() && done["note"].as_str().unwrap().contains("other programs"));

    // The same preview again: refused, it was used.
    let reused = error(remove_selected(lab.ws.clone(), lab.task.clone(), id.clone(), Execute { preview_id: pid, candidates: ids(&preview) }).await);
    assert!(reused.contains("already used"), "{reused}");

    // Replaced by another folder of the same name since the preview: refused.
    let preview = preview_cleanup(lab.ws.clone(), lab.task.clone(), id.clone()).await.unwrap();
    std::fs::rename(&release, lab.repo.join("target/moved")).unwrap();
    profile(&lab.repo.join("target"), "release", 10);
    let replaced = remove_selected(lab.ws.clone(), lab.task.clone(), id.clone(),
        Execute { preview_id: preview["id"].as_str().unwrap().into(), candidates: ids(&preview) }).await.unwrap();
    assert_eq!(replaced["results"][0]["state"], "refused");
    assert!(release.join("deps/blob").exists());

    // HEAD moved since the preview: nothing is removed.
    let preview = preview_cleanup(lab.ws.clone(), lab.task.clone(), id.clone()).await.unwrap();
    sh(&lab.repo, &["commit", "-q", "--allow-empty", "-m", "moved"]);
    let moved = error(remove_selected(lab.ws.clone(), lab.task.clone(), id.clone(),
        Execute { preview_id: preview["id"].as_str().unwrap().into(), candidates: ids(&preview) }).await);
    assert!(moved.contains("HEAD moved"), "{moved}");
    assert!(release.exists());

    // An expired preview: refused.
    let preview = preview_cleanup(lab.ws.clone(), lab.task.clone(), id.clone()).await.unwrap();
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE task_workspaces SET data=json_set(data,'$.preview.expiresAt','2000-01-01T00:00:00Z') WHERE id=?1", [&id])
        .unwrap();
    let expired = error(remove_selected(lab.ws.clone(), lab.task.clone(), id,
        Execute { preview_id: preview["id"].as_str().unwrap().into(), candidates: ids(&preview) }).await);
    assert!(expired.contains("expired"), "{expired}");
    assert!(release.exists());
}

#[test]
fn hard_linked_files_are_counted_once_and_apart() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("a"), dir.path().join("b"));
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    std::fs::write(a.join("one"), vec![1u8; 64 * 1024]).unwrap();
    std::fs::hard_link(a.join("one"), b.join("one")).unwrap();
    std::fs::write(b.join("own"), vec![2u8; 8 * 1024]).unwrap();
    let (mut seen, mut budget) = (HashSet::new(), 1000);
    let deadline = Instant::now() + Duration::from_secs(10);
    let first = measure(&a, &mut seen, &mut budget, deadline);
    let second = measure(&b, &mut seen, &mut budget, deadline);
    assert!(first["sharedBytes"].as_u64().unwrap() >= 64 * 1024 && first["bytes"] == 0, "{first}");
    assert_eq!(second["sharedBytes"], 0, "the same file is not counted twice: {second}");
    assert!(second["bytes"].as_u64().unwrap() >= 8 * 1024);
}

#[test]
fn the_routes_register_without_conflict_and_mounts_are_read() {
    // axum panics at registration on conflicting routes.
    let _ = router();
    let mounts = mounts().expect("Linux exposes /proc/self/mountinfo");
    assert!(mounts.contains(&PathBuf::from("/")), "{mounts:?}");
}

#[tokio::test]
async fn a_large_git_answer_fails_fast_and_a_linked_folder_still_counts_as_inside() {
    let lab = lab();
    // More than 64 KiB of untracked names (at the top: an untracked folder
    // is listed once): refused at once, not after 8 s.
    std::fs::create_dir(lab.repo.join("many")).unwrap();
    for n in 0..2500 {
        std::fs::write(lab.repo.join(format!("untracked-file-with-a-long-name-{n:05}.txt")), "").unwrap();
    }
    let started = Instant::now();
    let facts = git_facts(&lab.repo).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(GIT_SECONDS / 2), "{:?}", started.elapsed());
    assert_eq!(facts["changes"]["complete"], false);
    assert!(facts["changes"]["reason"].as_str().unwrap().contains("exceeded"), "{facts}");

    // An Agent and a Job reaching the worktree through a link are its users.
    let link = lab._dir.path().join("via-link");
    std::os::unix::fs::symlink(&lab.repo, &link).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"b","name":"Kai","cwd":link.join("many"),"model":"test","color":"sage","status":"working","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    lab.ws.store.insert(&agent).unwrap();
    job(&lab, "linked", "running", json!({"cwd": "/srv/elsewhere", "env": {"CARGO_TARGET_DIR": link.join("target")}}));
    std::fs::create_dir(lab.repo.join("target")).unwrap();
    let agents = lab.ws.store.workspace_agents(&lab.repo).unwrap();
    assert!(agents.iter().any(|a| a["name"] == "Kai" && a["relation"] == "inside"), "{agents:?}");
    let jobs = lab.ws.store.workspace_live_jobs(&lab.repo).unwrap();
    assert!(jobs.iter().any(|j| j["id"] == "linked"), "{jobs:?}");
}
