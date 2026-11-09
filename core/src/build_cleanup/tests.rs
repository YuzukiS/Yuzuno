//! YN-65 on throwaway Git repositories with synthetic records: which folders
//! count as a released executor's, that only their Cargo debug output goes,
//! when, and what keeps it.
use super::*;
use crate::model::AgentDetail;

const TAG: &str = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n";

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-C"])
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A Git repository at dir whose target/ and .worktrees/ are ignored.
fn repository(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q"]);
    std::fs::write(dir.join(".gitignore"), "target/\n.worktrees/\n").unwrap();
    std::fs::write(dir.join("README.md"), "demo\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "first"]);
    std::fs::canonicalize(dir).unwrap()
}

/// A Cargo target directory in dir, made by Cargo (tagged), with profiles.
fn target(dir: &Path, profiles: &[&str]) -> PathBuf {
    let target = dir.to_path_buf();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("CACHEDIR.TAG"), TAG).unwrap();
    for name in profiles {
        let profile = target.join(name);
        std::fs::create_dir_all(profile.join(".fingerprint")).unwrap();
        std::fs::create_dir_all(profile.join("deps")).unwrap();
        std::fs::write(profile.join(".cargo-lock"), "").unwrap();
        std::fs::write(profile.join("deps/blob"), vec![7u8; 20_000]).unwrap();
    }
    target
}

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    /// The Project's folder, a checkout of its repository.
    project: PathBuf,
    task: String,
}

/// Task T-1 in Project Demo, whose folder on this host is a Git checkout.
fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let project = repository(&dir.path().join("demo"));
    let created = ws.store.create_project("Demo", BTreeMap::from([("local".to_owned(), project.display().to_string())])).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Demo","status":"doing"})).unwrap();
    let task = {
        let db = ws.store.db.write().unwrap();
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        crate::projects::set_task_project(&db, &task, Some(&created.id)).unwrap();
        db.execute("INSERT INTO github_repositories(id,data) VALUES(42,'{\"id\":42,\"fullName\":\"example/demo\"}')", []).unwrap();
        task
    };
    Lab { dir, ws, project, task }
}

/// A worktree of the Project's checkout, with a core/ folder Jobs run in.
fn worktree(lab: &Lab, name: &str, branch: &str) -> PathBuf {
    let path = lab.project.join(".worktrees").join(name);
    git(&lab.project, &["worktree", "add", "-q", "-b", branch, &path.display().to_string()]);
    std::fs::create_dir_all(path.join("core")).unwrap();
    std::fs::canonicalize(path).unwrap()
}

fn ago(days: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339()
}

/// Executor `id` of T-1, working in `cwd`, released `days` ago (None: open).
fn executor(lab: &Lab, id: &str, cwd: &Path, released: Option<i64>) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Executor {id}"),"cwd":cwd,
        "model":"","harness":"codex","color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    lab.ws.store.insert(&detail).unwrap();
    if let Some(days) = released {
        // A released executor is closed (not by a release here: its role row says so below).
        lab.ws.store.update(id, "agent/closed", &json!({"reason": "test"}), |d| d.agent.closed_at = Some(ago(days))).unwrap();
    }
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at,archived_at)
         VALUES(?1,'executor','design-first',?2,'lead','released','now','now',?3)",
        params![id, lab.task, released.map(ago)],
    ).unwrap();
}

fn job(lab: &Lab, agent: &str, id: &str, data: Value) {
    let mut data = data;
    data["id"] = json!(id);
    data["name"] = json!(format!("job {id}"));
    data["target"] = json!({"kind": "local"});
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES(?1,?2,?3,'succeeded',0,?4)",
        params![id, lab.task, agent, data.to_string()],
    ).unwrap();
}

fn pull_request(lab: &Lab, number: i64, branch: &str) {
    let db = lab.ws.store.db.write().unwrap();
    let id = format!("42:pull:{number}");
    db.execute("INSERT INTO github_objects(id,repo_id,kind,number,data) VALUES(?1,42,'pull',?2,?3)",
        params![id, number, json!({"snapshot": {"headBranch": branch}}).to_string()]).unwrap();
    db.execute("INSERT INTO github_task_links(task_id,object_id) VALUES(?1,?2)", params![lab.task, id]).unwrap();
}

fn turn(lab: &Lab, enabled: bool, keep_days: u32, earlier: bool) -> Policy {
    let db = lab.ws.store.db.write().unwrap();
    let version = policy(&db).unwrap().version;
    change_policy(&db, Change { enabled, keep_days, earlier, expected_version: version }).unwrap()
}

async fn pass(lab: &Lab) -> usize {
    lab.ws.build_cleanup_pass().await.unwrap()
}

/// Its saved state and outcome.
fn record(lab: &Lab, agent: &str) -> Option<(String, Value)> {
    lab.ws.store.db.read().unwrap()
        .query_row("SELECT state, data FROM build_cleanups WHERE agent_id=?1", [agent], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .optional().unwrap()
        .map(|(state, data)| (state, serde_json::from_str(&data).unwrap()))
}

fn comments(lab: &Lab) -> Vec<String> {
    let db = lab.ws.store.db.read().unwrap();
    let mut q = db.prepare("SELECT json_extract(data,'$.body') FROM collaboration_task_activity WHERE task_id=?1 AND json_extract(data,'$.source.buildCleanup') IS NOT NULL").unwrap();
    q.query_map([&lab.task], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
}

#[tokio::test]
async fn nothing_goes_while_it_is_off_or_within_the_days_kept() {
    let lab = lab();
    let a = worktree(&lab, "a", "feat/a");
    let debug = target(&a.join("target"), &["debug"]).join("debug");
    executor(&lab, "e1", &lab.project, Some(2));
    job(&lab, "e1", "j1", json!({"cwd": a.join("core")}));
    assert_eq!(pass(&lab).await, 0, "off: no pass");
    assert!(debug.exists());

    turn(&lab, true, 3, true);
    assert_eq!(pass(&lab).await, 0, "released two days ago, three are kept");
    assert!(debug.exists());

    turn(&lab, true, 1, false);
    assert_eq!(pass(&lab).await, 1);
    assert!(!debug.exists());
    assert_eq!(record(&lab, "e1").unwrap().0, "done");
    assert_eq!(pass(&lab).await, 0, "done once");
}

#[tokio::test]
async fn only_executors_released_after_it_was_turned_on_unless_earlier_ones_too() {
    let lab = lab();
    let a = worktree(&lab, "a", "feat/a");
    let debug = target(&a.join("target"), &["debug"]).join("debug");
    executor(&lab, "e1", &a, Some(2));
    let on = turn(&lab, true, 0, false);
    assert!(on.since.is_some());
    assert_eq!(pass(&lab).await, 0);
    assert!(debug.exists(), "released before it was turned on");
    let earlier = turn(&lab, true, 0, true);
    assert_eq!(earlier.since, None);
    assert_eq!(pass(&lab).await, 1);
    assert!(!debug.exists());
}

#[tokio::test]
async fn its_records_name_its_folders_and_only_their_debug_output_goes() {
    let lab = lab();
    // Its own folder, a Job's folder, its pull request's branch, a Job's target.
    let own = worktree(&lab, "own", "feat/own");
    let ran = worktree(&lab, "ran", "feat/ran");
    let branch = worktree(&lab, "branch", "feat/pr");
    let unrelated = worktree(&lab, "unrelated", "feat/other");
    for tree in [&own, &ran, &branch, &unrelated] {
        target(&tree.join("target"), &["debug", "release"]);
    }
    let named = target(&lab.project.join("target/yn-x"), &["debug"]);
    let main = target(&lab.project.join("target"), &["debug"]);
    // Evidence beside the output, and work in progress in a worktree.
    std::fs::write(ran.join("target/shots.png"), "evidence").unwrap();
    std::fs::create_dir_all(ran.join("target/yn-jobs")).unwrap();
    std::fs::write(ran.join("target/yn-jobs/check.sh"), "echo ok").unwrap();
    std::fs::write(ran.join("README.md"), "work in progress\n").unwrap();
    std::fs::write(ran.join("notes.txt"), "mine\n").unwrap();
    let status = git(&ran, &["status", "--porcelain"]);
    // Elsewhere: another repository inside the Project's folder, one outside it.
    let nested = repository(&lab.project.join("vendor/other"));
    target(&nested.join("target"), &["debug"]);
    let outside = repository(&lab.dir.path().join("outside"));
    target(&outside.join("target"), &["debug"]);

    executor(&lab, "e1", &own, Some(2));
    job(&lab, "e1", "j1", json!({"cwd": ran.join("core"), "env": {"CARGO_TARGET_DIR": named}}));
    job(&lab, "e1", "j2", json!({"cwd": lab.project, "env": {"CARGO_TARGET_DIR": "target"}}));
    job(&lab, "e1", "j3", json!({"cwd": nested}));
    job(&lab, "e1", "j4", json!({"cwd": outside}));
    pull_request(&lab, 7, "feat/pr");
    turn(&lab, true, 1, true);
    assert_eq!(pass(&lab).await, 1);

    for gone in [own.join("target/debug"), ran.join("target/debug"), branch.join("target/debug"), named.join("debug")] {
        assert!(!gone.exists(), "{} should be removed", gone.display());
    }
    for kept in [own.join("target/release"), ran.join("target/release"), unrelated.join("target/debug"), main.join("debug"),
        nested.join("target/debug"), outside.join("target/debug"), ran.join("target/shots.png"), ran.join("target/yn-jobs/check.sh")] {
        assert!(kept.exists(), "{} should stay", kept.display());
    }
    assert_eq!(git(&ran, &["status", "--porcelain"]), status, "the worktree's own changes stay");
    assert_eq!(std::fs::read_to_string(ran.join("README.md")).unwrap(), "work in progress\n");

    let (state, data) = record(&lab, "e1").unwrap();
    assert_eq!(state, "done");
    let removed: Vec<&str> = data["results"].as_array().unwrap().iter().filter(|r| r["state"] == "removed")
        .map(|r| r["path"].as_str().unwrap()).collect();
    assert_eq!(removed.len(), 4, "{data}");
    assert!(removed.contains(&"target/yn-x/debug") && removed.contains(&".worktrees/branch/target/debug"), "{removed:?}");
    let notes = comments(&lab);
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].contains("Core removed 4 Cargo debug folder(s)"), "{}", notes[0]);
}

#[tokio::test]
async fn a_process_waits_for_another_try_and_what_cargo_did_not_make_is_kept_once() {
    let lab = lab();
    let busy = worktree(&lab, "busy", "feat/busy");
    let shots = worktree(&lab, "shots", "feat/shots");
    let busy_debug = target(&busy.join("target"), &["debug"]).join("debug");
    let shots_debug = target(&shots.join("target"), &["debug"]).join("debug");
    std::fs::create_dir(shots_debug.join("shots")).unwrap();
    std::fs::write(shots_debug.join("shots/home.png"), "evidence").unwrap();
    executor(&lab, "e1", &lab.project, Some(2));
    job(&lab, "e1", "j1", json!({"cwd": busy}));
    job(&lab, "e1", "j2", json!({"cwd": shots}));
    turn(&lab, true, 1, true);

    // A test binary running from it holds no Cargo lock: the process keeps it.
    let mut child = std::process::Command::new("sleep").arg("30").current_dir(busy_debug.join("deps")).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(pass(&lab).await, 1);
    let (state, data) = record(&lab, "e1").unwrap();
    assert_eq!(state, "waiting", "{data}");
    let result = |path: &str| data["results"].as_array().unwrap().iter().find(|r| r["path"] == path).unwrap().clone();
    let busy_result = result(".worktrees/busy/target/debug");
    assert_eq!(busy_result["state"], "waiting");
    assert!(busy_result["reasons"].to_string().contains(&format!("Process {}", child.id())), "{busy_result}");
    let shots_result = result(".worktrees/shots/target/debug");
    assert_eq!(shots_result["state"], "kept");
    assert!(shots_result["reasons"][0].as_str().unwrap().contains("It holds what Cargo does not make: shots"), "{shots_result}");
    assert!(busy_debug.exists() && shots_debug.join("shots/home.png").exists());
    assert_eq!(pass(&lab).await, 0, "not before its next try");
    assert!(comments(&lab).is_empty(), "nothing on the task while it waits");

    child.kill().unwrap();
    child.wait().unwrap();
    lab.ws.store.db.write().unwrap().execute("UPDATE build_cleanups SET next_try_at=?1", [ago(1)]).unwrap();
    assert_eq!(pass(&lab).await, 1);
    assert!(!busy_debug.exists());
    assert!(shots_debug.join("shots/home.png").exists());
    assert_eq!(record(&lab, "e1").unwrap().0, "done");
    let notes = comments(&lab);
    assert_eq!(notes.len(), 1);
    assert!(notes[0].contains("Kept .worktrees/shots/target/debug: It holds what Cargo does not make: shots"), "{}", notes[0]);

    // A week of waiting gives up.
    let lab = lab_with_waiting().await;
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE build_cleanups SET next_try_at=?1, data=json_set(data,'$.firstTriedAt',?2)", params![ago(1), ago(8)]).unwrap();
    assert_eq!(pass(&lab).await, 1);
    assert_eq!(record(&lab, "e1").unwrap().0, "gaveUp");
}

/// One released executor whose only profile another open executor of its
/// task may still use: it waits.
async fn lab_with_waiting() -> Lab {
    let lab = lab();
    let branch = worktree(&lab, "pr", "feat/pr");
    target(&branch.join("target"), &["debug"]);
    executor(&lab, "e1", &lab.project, Some(2));
    executor(&lab, "e2", &lab.project, None);
    pull_request(&lab, 9, "feat/pr");
    turn(&lab, true, 1, true);
    assert_eq!(pass(&lab).await, 1);
    let (state, data) = record(&lab, "e1").unwrap();
    assert_eq!(state, "waiting");
    assert!(data["results"][0]["reasons"].to_string().contains(SHARED), "{data}");
    assert!(branch.join("target/debug").exists());
    lab
}

/// An executor whose task names no Project folder here is done at once, with
/// nothing to do, and holds up no executor released after it.
#[tokio::test]
async fn one_without_a_project_folder_is_done_and_the_others_go_on() {
    let lab = lab();
    let a = worktree(&lab, "a", "feat/a");
    let debug = target(&a.join("target"), &["debug"]).join("debug");
    executor(&lab, "e1", &a, Some(3));
    executor(&lab, "e2", &a, Some(2));
    // e1's task is none Core knows: it has no Project, so no folder.
    lab.ws.store.db.write().unwrap().execute("UPDATE agent_roles SET task_id='no-such-task' WHERE agent_id='e1'", []).unwrap();
    turn(&lab, true, 1, true);
    assert_eq!(pass(&lab).await, 2);
    assert_eq!(record(&lab, "e1").unwrap().0, "done", "no folder of its can be named: nothing to do");
    assert!(!debug.exists(), "e2's went");
}

#[test]
fn the_policy_changes_only_against_the_version_read_and_within_its_bounds() {
    let lab = lab();
    let db = lab.ws.store.db.write().unwrap();
    assert_eq!(policy(&db).unwrap(), Policy::default());
    let stale = change_policy(&db, Change { enabled: true, keep_days: 1, earlier: false, expected_version: 3 }).unwrap_err();
    assert!(stale.to_string().starts_with("version_conflict"), "{stale}");
    let over = change_policy(&db, Change { enabled: true, keep_days: MAX_KEEP_DAYS + 1, earlier: false, expected_version: 0 }).unwrap_err();
    assert!(over.to_string().contains("keepDays is 0 to 30"), "{over}");
    let on = change_policy(&db, Change { enabled: true, keep_days: 2, earlier: false, expected_version: 0 }).unwrap();
    assert!(on.enabled && on.since.is_some() && on.version == 1);
    let longer = change_policy(&db, Change { enabled: true, keep_days: 5, earlier: false, expected_version: 1 }).unwrap();
    assert_eq!(longer.since, on.since, "changing the days keeps from when it applies");
    let off = change_policy(&db, Change { enabled: false, keep_days: 5, earlier: true, expected_version: 2 }).unwrap();
    assert!(!off.enabled);
}

#[test]
fn a_release_says_what_happens_to_its_build_output() {
    let mut policy = Policy::default();
    assert_eq!(release_note(&policy, Some("2026-11-09T00:00:00+00:00"), false), json!({"enabled": false}));
    policy.enabled = true;
    policy.keep_days = 2;
    let note = release_note(&policy, Some("2026-11-09T00:00:00+00:00"), false);
    assert_eq!(note["dueAt"], "2026-11-11T00:00:00+00:00");
    assert!(release_note(&policy, None, false)["dueAt"].is_null(), "still archiving: from its close");
    assert!(release_note(&policy, Some("2026-11-09T00:00:00+00:00"), true)["note"].as_str().unwrap().contains("another machine"));
    policy.since = Some("2026-11-10T00:00:00+00:00".into());
    assert!(release_note(&policy, Some("2026-11-09T00:00:00+00:00"), false)["note"].as_str().unwrap().contains("before the cleanup was turned on"));
}

#[tokio::test]
async fn the_backlog_preview_counts_and_removes_nothing() {
    let lab = lab();
    let a = worktree(&lab, "a", "feat/a");
    let b = worktree(&lab, "b", "feat/b");
    let debug = target(&a.join("target"), &["debug"]).join("debug");
    let marked = target(&b.join("target"), &["debug"]).join("debug");
    std::fs::write(marked.join("report.html"), "evidence").unwrap();
    executor(&lab, "e1", &a, Some(2));
    executor(&lab, "e2", &b, Some(3));
    let preview = preview_backlog(&lab.ws).await.unwrap();
    assert_eq!(preview["folders"], 1, "{preview}");
    assert_eq!(preview["kept"], 1, "{preview}");
    assert!(preview["bytes"].as_u64().unwrap() >= 20_000);
    assert_eq!(preview["items"][0]["path"], ".worktrees/a/target/debug");
    assert_eq!(preview["complete"], true);
    assert!(debug.exists() && marked.exists());
}

/// The user's routes: read it, change it against the version read, preview
/// the backlog. A stale version or an unknown field changes nothing.
#[tokio::test]
async fn the_users_routes_read_and_change_it_against_the_version_read() {
    use tower::ServiceExt;
    let lab = lab();
    let call = |method: &str, path: &str, body: Option<Value>| {
        let request = axum::http::Request::builder().method(method).uri(path).header("content-type", "application/json");
        let body = body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string()));
        router().with_state(lab.ws.clone()).oneshot(request.body(body).unwrap())
    };
    let read = |response: axum::response::Response| async move {
        let status = response.status();
        (status, serde_json::from_slice::<Value>(&axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap_or(Value::Null))
    };
    let (status, body) = read(call("GET", "/api/build-cleanup", None).await.unwrap()).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!((body["policy"]["enabled"].clone(), body["policy"]["keepDays"].clone(), body["policy"]["version"].clone()), (json!(false), json!(1), json!(0)));
    assert_eq!(body["recent"], json!([]));
    let (status, body) = read(call("PUT", "/api/build-cleanup", Some(json!({"enabled": true, "keepDays": 2, "expectedVersion": 0}))).await.unwrap()).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    assert_eq!((body["policy"]["enabled"].clone(), body["policy"]["version"].clone()), (json!(true), json!(1)));
    let (status, body) = read(call("PUT", "/api/build-cleanup", Some(json!({"enabled": false, "keepDays": 2, "expectedVersion": 0}))).await.unwrap()).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().starts_with("version_conflict"), "{body}");
    let (status, _) = read(call("PUT", "/api/build-cleanup", Some(json!({"enabled": false, "keepDays": 2, "expectedVersion": 1, "since": null}))).await.unwrap()).await;
    assert!(status.is_client_error(), "an unknown field is refused");
    assert!(policy(&lab.ws.store.db.read().unwrap()).unwrap().enabled, "and nothing changed");
    let (status, body) = read(call("POST", "/api/build-cleanup/backlog", None).await.unwrap()).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!((body["folders"].clone(), body["complete"].clone()), (json!(0), json!(true)));
}
