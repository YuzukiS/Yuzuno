//! YN-74 ①a1 on throwaway Git repositories, a fake HOME and synthetic
//! folders (design 7, ①a): what registration refuses, what it recognizes,
//! and that Core's summary is Core's own.
use super::*;
use crate::model::AgentDetail;

const TAG_CARGO: &str = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n";
const TAG_PYTEST: &str = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by pytest.\n";
const ATTEMPT: &str = "00000000-0000-4000-8000-000000000001";

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

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    home: PathBuf,
    project: PathBuf,
    scratch: PathBuf,
}

impl Lab {
    fn root(&self) -> PathBuf {
        std::fs::canonicalize(self.dir.path()).unwrap()
    }
}

fn agent(ws: &Workspace, id: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
        "model":"","harness":"claude","color":"sage","status":"idle","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
}

/// Task T-1 in Project Demo, at <home>/work/demo, a Git checkout pushed to a
/// bare remote whose default branch is main. Its executor `ex`, a lead
/// `lead`, an inventory Job `inv`. Another Project's folder at <root>/other.
/// HOME is <root>/home; the scratch root <root>/scratch; nothing has to be
/// a day old.
fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let home = root.join("home");
    let project = home.join("work/demo");
    std::fs::create_dir_all(&project).unwrap();
    git(&project, &["init", "-q"]);
    std::fs::write(project.join(".gitignore"), "target/\n.worktrees/\n").unwrap();
    std::fs::write(project.join("README.md"), "demo\n").unwrap();
    git(&project, &["add", "."]);
    git(&project, &["commit", "-q", "-m", "first"]);
    git(&root, &["init", "-q", "--bare", "remote.git"]);
    git(&project, &["remote", "add", "origin", &root.join("remote.git").display().to_string()]);
    git(&project, &["push", "-q", "origin", "main"]);
    git(&project, &["remote", "set-head", "origin", "main"]);
    let other = root.join("other");
    std::fs::create_dir_all(&other).unwrap();
    let scratch = root.join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    let ws = Workspace::new(root.join("data"), "/tmp".into(), "unused".into()).unwrap();
    *ws.cleanup.env.lock().unwrap() =
        Some(HostEnv { home: Some(home.clone()), cache: Some(home.join(".cache")), library: None, uid: rustix::process::getuid().as_raw() });
    let demo = ws.store.create_project("Demo", BTreeMap::from([("local".to_owned(), project.display().to_string())])).unwrap();
    ws.store.create_project("Other", BTreeMap::from([("local".to_owned(), other.display().to_string())])).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Clean","status":"doing"})).unwrap();
    for id in ["ex", "lead", "stranger"] {
        agent(&ws, id);
    }
    ws.store.set_agent_project("lead", Some(&demo.id)).unwrap();
    {
        let db = ws.store.db.write().unwrap();
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        crate::projects::set_task_project(&db, &task, Some(&demo.id)).unwrap();
        db.execute("INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at)
            VALUES('ex','executor','workspace-cleanup',?1,'agent:lead','running','now','now')", [&task]).unwrap();
        db.execute("INSERT INTO agent_roles(agent_id,kind,project_id,created_by,created_at,updated_at) VALUES('lead','lead',?1,'user','now','now')",
            [&demo.id]).unwrap();
        inventory_job(&db, &task, "inv", json!({"kind": "local"}), &project);
    }
    let lab = Lab { dir, ws, home, project, scratch };
    settings_change(&lab, |c| {
        c.scratch_roots = vec![lab.scratch.display().to_string()];
        c.fresh_days = 0;
        c.evidence_days = 0;
    });
    lab
}

/// A finished inventory Job of the task, its command Core's own on `folder` (inventory.rs `core_inventory`).
fn inventory_job(db: &Connection, task: &str, id: &str, target: Value, folder: &Path) {
    let argv = inventory::command("/usr/bin/python3", &folder.display().to_string(), &[], &[], &json!({}), "out/inventory.json");
    let data = json!({"id":id,"taskId":task,"agentId":"ex","attempt":ATTEMPT,"status":"succeeded","target":target,
        "name": inventory::JOB_NAME, "argv": argv,
        "machine":{"name":"Synthetic host"},
        "result":{"attempt":ATTEMPT,"artifacts":[{"path":"out/inventory.json","sha256":"b".repeat(64),"ok":true,"bytes":12}]}});
    db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'ex','succeeded',?3)", params![id, task, data.to_string()])
        .unwrap();
    // As cleanup_inventory records the inventory it starts (inventory.rs `ours`).
    let machine = data["target"]["machineId"].as_str().unwrap_or("local").to_owned();
    db.execute("INSERT OR REPLACE INTO cleanup_inventories(actor,request_id,task_id,machine,folder,identity,job_id,created_at) VALUES('ex',?1,?2,?3,?4,?5,?6,'now')",
        params![format!("cleanup-inventory/{id}"), task, machine, folder.display().to_string(), inventory::identity(&data), id]).unwrap();
}

fn settings_change(lab: &Lab, edit: impl FnOnce(&mut Settings)) {
    let db = lab.ws.store.db.write().unwrap();
    let mut s = settings::read(&db).unwrap();
    edit(&mut s);
    settings::change(&db, settings::Change {
        protected_paths: s.protected_paths, scratch_roots: s.scratch_roots, max_items: s.max_items, plan_hours: s.plan_hours,
        summary_paths: s.summary_paths, fresh_days: s.fresh_days, evidence_days: s.evidence_days, snapshot_max_mib: s.snapshot_max_mib,
        evidence_file_mib: s.evidence_file_mib, evidence_suffixes: s.evidence_suffixes, snapshot_days: s.snapshot_days,
        rules: Some(s.rules), project_rules: Some(s.project_rules), rule_layer: Some(s.rule_layer),
        worktree_reclaim: Some(s.worktree_reclaim), worktree_keep_days: Some(s.worktree_keep_days), expected_version: s.version,
    })
    .unwrap();
}

fn item(id: &str, group: &str, kind: &str, path: &Path) -> Value {
    json!({"id": id, "group": group, "kind": kind, "path": path, "reason": "test"})
}

fn group(id: &str, decision: &str) -> Value {
    json!({"id": id, "label": format!("Group {id}"), "decision": decision, "reason": "test"})
}

fn plan_input(request: &str, groups: Vec<Value>, items: Vec<Value>) -> Value {
    json!({"requestId": request, "taskId": "T-1", "title": "Tidy", "groups": groups, "items": items,
        "inventory": {"jobId": "inv", "attempt": ATTEMPT, "path": "out/inventory.json", "sha256": "b".repeat(64)}})
}

async fn submit_as(lab: &Lab, actor: Option<&str>, input: Value) -> Result<Value> {
    lab.ws.collaboration_call(actor, "cleanup_plan_submit", input).await
}

async fn submit(lab: &Lab, request: &str, groups: Vec<Value>, items: Vec<Value>) -> Value {
    submit_as(lab, Some("ex"), plan_input(request, groups, items)).await.unwrap()
}

/// Each item's state and refusal code, by item id.
async fn item_states(lab: &Lab, plan: &Value) -> BTreeMap<String, (String, Option<String>)> {
    let read = lab.ws.collaboration_call(Some("ex"), "cleanup_plan_get",
        json!({"planId": plan["planId"], "view": "items", "limit": 100})).await.unwrap();
    read["itemsPage"].as_array().unwrap().iter()
        .map(|i| (i["item"].as_str().unwrap().to_owned(), (i["state"].as_str().unwrap().to_owned(), i["refusal"]["code"].as_str().map(str::to_owned))))
        .collect()
}

async fn items_of(lab: &Lab, plan: &Value) -> Vec<Value> {
    let read = lab.ws.collaboration_call(Some("ex"), "cleanup_plan_get",
        json!({"planId": plan["planId"], "view": "items", "limit": 100})).await.unwrap();
    read["itemsPage"].as_array().unwrap().clone()
}

fn refused(states: &BTreeMap<String, (String, Option<String>)>, id: &str) -> String {
    let (state, code) = &states[id];
    assert_eq!(state, "refused", "{id}: {states:?}");
    code.clone().unwrap()
}

fn pending(states: &BTreeMap<String, (String, Option<String>)>, id: &str) {
    assert_eq!(states[id].0, "pending", "{id}: {states:?}");
}

fn worktree(lab: &Lab, path: &Path, branch: &str) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    git(&lab.project, &["worktree", "add", "-q", "-b", branch, &path.display().to_string()]);
    std::fs::canonicalize(path).unwrap()
}

fn cargo_target(dir: &Path, profiles: &[&str]) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("CACHEDIR.TAG"), TAG_CARGO).unwrap();
    for name in profiles {
        let profile = dir.join(name);
        std::fs::create_dir_all(profile.join(".fingerprint")).unwrap();
        std::fs::create_dir_all(profile.join("deps")).unwrap();
        std::fs::write(profile.join(".cargo-lock"), "").unwrap();
        std::fs::write(profile.join("deps/blob"), vec![7u8; 20_000]).unwrap();
    }
}

#[tokio::test]
async fn what_is_fixed_in_core_is_refused_whatever_the_settings_say() {
    let lab = lab();
    let root = lab.root();
    // Every folder of the lab is in a scratch root: only what is fixed refuses them.
    settings_change(&lab, |c| c.scratch_roots = vec![root.display().to_string(), lab.home.display().to_string(),
        lab.home.join(".cache").display().to_string(), lab.home.join("work").display().to_string()]);
    std::fs::create_dir_all(lab.home.join(".cache/tool")).unwrap();
    std::fs::create_dir_all(lab.home.join("notes")).unwrap();
    std::fs::create_dir_all(root.join("junk")).unwrap();
    let main = lab.project.clone();
    let plan = submit(&lab, "fixed", vec![group("g", "delete")], vec![
        item("data", "g", "entry", &root.join("data")),
        item("holdsHome", "g", "entry", &root.join("home")),
        item("firstLevel", "g", "entry", &lab.home.join("notes")),
        item("xdg", "g", "entry", &lab.home.join(".cache/tool")),
        item("other", "g", "entry", &root.join("other")),
        item("work", "g", "entry", &lab.home.join("work")),
        item("project", "g", "worktree", &main),
        item("junk", "g", "entry", &root.join("junk")),
    ]).await;
    let states = item_states(&lab, &plan).await;
    for id in ["data", "holdsHome", "firstLevel", "xdg", "other", "work", "project"] {
        assert_eq!(refused(&states, id), "forbidden", "{id}");
    }
    pending(&states, "junk");
    let items = items_of(&lab, &plan).await;
    let why = |id: &str| items.iter().find(|i| i["item"] == id).unwrap()["refusal"]["why"].as_str().unwrap().to_owned();
    assert!(why("data").contains("Core's data folder"), "{}", why("data"));
    assert!(why("xdg").contains("$XDG_CACHE_HOME"), "{}", why("xdg"));
    assert!(why("other").contains("Another Project"), "{}", why("other"));
    assert!(why("project").contains("This Project's folder"), "{}", why("project"));
}

#[tokio::test]
async fn xdg_cache_home_counts_where_it_is_set_and_home_unset_refuses_everything() {
    let lab = lab();
    let elsewhere = lab.scratch.join("cache-elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::create_dir_all(lab.scratch.join("plain")).unwrap();
    let uid = rustix::process::getuid().as_raw();
    *lab.ws.cleanup.env.lock().unwrap() = Some(HostEnv { home: Some(lab.home.clone()), cache: Some(elsewhere.clone()), library: None, uid });
    let plan = submit(&lab, "xdg", vec![group("g", "delete")],
        vec![item("xdg", "g", "entry", &elsewhere), item("plain", "g", "entry", &lab.scratch.join("plain"))]).await;
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "xdg"), "forbidden");
    pending(&states, "plain");
    // Without HOME, Core cannot tell the home folder: it refuses everything.
    *lab.ws.cleanup.env.lock().unwrap() = Some(HostEnv { home: None, cache: None, library: None, uid });
    let plan = submit(&lab, "nohome", vec![group("g", "delete")], vec![item("plain", "g", "entry", &lab.scratch.join("plain"))]).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "plain"), "forbidden");
}

#[tokio::test]
async fn links_mounts_other_owners_and_unreadable_mounts_are_refused() {
    let lab = lab();
    let real = lab.scratch.join("real");
    std::fs::create_dir_all(real.join("inner")).unwrap();
    std::os::unix::fs::symlink(&real, lab.scratch.join("link")).unwrap();
    std::fs::create_dir_all(lab.scratch.join("mounted/inner")).unwrap();
    *lab.ws.cleanup.mounts.lock().unwrap() = Some(Some(vec![lab.scratch.join("mounted/inner")]));
    let plan = submit(&lab, "links", vec![group("g", "delete")], vec![
        item("link", "g", "entry", &lab.scratch.join("link")),
        item("through", "g", "entry", &lab.scratch.join("link/inner")),
        item("mounted", "g", "entry", &lab.scratch.join("mounted")),
        item("real", "g", "entry", &real),
        item("dots", "g", "entry", &lab.scratch.join("real/../real")),
    ]).await;
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "link"), "link");
    assert_eq!(refused(&states, "through"), "link");
    assert_eq!(refused(&states, "mounted"), "mount");
    assert_eq!(refused(&states, "dots"), "path");
    pending(&states, "real");
    // Mounts that cannot be read refuse everything; so does another owner.
    *lab.ws.cleanup.mounts.lock().unwrap() = Some(None);
    let plan = submit(&lab, "nomounts", vec![group("g", "delete")], vec![item("real", "g", "entry", &real)]).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "real"), "unchecked");
    *lab.ws.cleanup.mounts.lock().unwrap() = Some(Some(Vec::new()));
    let uid = rustix::process::getuid().as_raw();
    *lab.ws.cleanup.env.lock().unwrap() =
        Some(HostEnv { home: Some(lab.home.clone()), cache: Some(lab.home.join(".cache")), library: None, uid: uid.wrapping_add(1) });
    let plan = submit(&lab, "owner", vec![group("g", "delete")], vec![item("real", "g", "entry", &real)]).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "real"), "owner");
}

#[tokio::test]
async fn a_protected_path_is_refused_until_it_is_taken_out_of_settings_and_entries_need_a_scratch_root() {
    let lab = lab();
    let keep = lab.scratch.join("keep");
    let holder = lab.scratch.join("holder");
    std::fs::create_dir_all(&keep).unwrap();
    std::fs::create_dir_all(holder.join("evidence")).unwrap();
    let outside = lab.home.join("work/loose");
    std::fs::create_dir_all(outside.join("deeper")).unwrap();
    settings_change(&lab, |c| c.protected_paths = vec![keep.display().to_string(), holder.join("evidence").display().to_string()]);
    let items = || vec![item("keep", "g", "entry", &keep), item("holder", "g", "entry", &holder),
        item("outside", "g", "entry", &outside.join("deeper"))];
    let plan = submit(&lab, "protected", vec![group("g", "delete")], items()).await;
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "keep"), "protected");
    assert_eq!(refused(&states, "holder"), "protected", "it holds a protected path");
    assert_eq!(refused(&states, "outside"), "notScratch");
    settings_change(&lab, |c| c.protected_paths.clear());
    let plan = submit(&lab, "unprotected", vec![group("g", "delete")], items()).await;
    let states = item_states(&lab, &plan).await;
    pending(&states, "keep");
    pending(&states, "holder");
}

#[tokio::test]
async fn worktrees_are_the_ones_git_lists_wherever_they_are_and_never_main_or_locked() {
    let lab = lab();
    let outside = worktree(&lab, &lab.home.join("work/wt/x"), "feat/x");
    let locked = worktree(&lab, &lab.project.join(".worktrees/locked"), "feat/locked");
    git(&lab.project, &["worktree", "lock", &locked.display().to_string()]);
    let ahead = worktree(&lab, &lab.project.join(".worktrees/ahead"), "feat/ahead");
    std::fs::write(ahead.join("new.txt"), "mine\n").unwrap();
    git(&ahead, &["add", "new.txt"]);
    git(&ahead, &["commit", "-q", "-m", "mine"]);
    // A folder that looks like a worktree but the repository does not list.
    let fake = lab.home.join("work/fake");
    std::fs::create_dir_all(&fake).unwrap();
    std::fs::write(fake.join(".git"), format!("gitdir: {}/.git/worktrees/fake\n", lab.project.display())).unwrap();
    let plan = submit(&lab, "worktrees", vec![group("g", "delete")], vec![
        item("outside", "g", "worktree", &outside), item("locked", "g", "worktree", &locked),
        item("ahead", "g", "worktree", &ahead), item("fake", "g", "worktree", &fake),
    ]).await;
    let states = item_states(&lab, &plan).await;
    pending(&states, "outside");
    pending(&states, "ahead");
    assert_eq!(refused(&states, "locked"), "locked");
    assert_eq!(refused(&states, "fake"), "notWorktree");
    let items = items_of(&lab, &plan).await;
    let of = |id: &str| items.iter().find(|i| i["item"] == id).unwrap().clone();
    assert_eq!(of("outside")["category"], "clean-merged-worktree");
    assert_eq!(of("outside")["worktree"]["branch"], "feat/x");
    assert_eq!(of("ahead")["category"], "worktree-unique-commits");
    assert_eq!(of("ahead")["worktree"]["uniqueCommits"], 1);
    // An entry holding a registered worktree is refused as an entry.
    let wt_in_scratch = worktree(&lab, &lab.scratch.join("box/wt"), "feat/box");
    let plan = submit(&lab, "box", vec![group("g", "delete")], vec![item("box", "g", "entry", wt_in_scratch.parent().unwrap())]).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "box"), "holdsWorktree");
}

#[tokio::test]
async fn cache_folders_go_by_rule_and_git_must_ignore_them_inside_the_project() {
    let lab = lab();
    let tree = worktree(&lab, &lab.project.join(".worktrees/a"), "feat/a");
    cargo_target(&tree.join("target"), &["debug", "release"]);
    std::fs::write(tree.join("target/release/shot.png"), "evidence").unwrap();
    std::fs::write(tree.join("target/notes.md"), "mine").unwrap();
    cargo_target(&lab.project.join("target"), &["debug"]);
    let loose = lab.project.join("cachey");
    std::fs::create_dir_all(&loose).unwrap();
    std::fs::write(loose.join("CACHEDIR.TAG"), TAG_PYTEST).unwrap();
    let pytest = lab.scratch.join("job-1/.pytest_cache");
    let ruff = lab.scratch.join("job-1/.ruff_cache");
    for dir in [&pytest, &ruff] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("CACHEDIR.TAG"), TAG_PYTEST).unwrap();
    }
    let forged = lab.scratch.join("forged");
    std::fs::create_dir_all(&forged).unwrap();
    std::fs::write(forged.join("CACHEDIR.TAG"), "Signature: 0000\n# created by nobody\n").unwrap();
    let plan = submit(&lab, "caches", vec![group("r", "rebuildable")], vec![
        item("wt", "r", "cache-dir", &tree.join("target")),
        item("main", "r", "cache-dir", &lab.project.join("target")),
        item("loose", "r", "cache-dir", &loose),
        item("pytest", "r", "cache-dir", &pytest),
        item("forged", "r", "cache-dir", &forged),
        json!({"id": "named", "group": "r", "kind": "cache-dir", "rule": "cargo", "path": ruff}),
    ]).await;
    let states = item_states(&lab, &plan).await;
    pending(&states, "wt");
    pending(&states, "main");
    pending(&states, "pytest");
    assert_eq!(refused(&states, "loose"), "notIgnored");
    assert_eq!(refused(&states, "forged"), "noRule");
    assert_eq!(refused(&states, "named"), "ruleMismatch");
    let items = items_of(&lab, &plan).await;
    let of = |id: &str| items.iter().find(|i| i["item"] == id).unwrap().clone();
    assert_eq!(of("wt")["rule"], "cargo");
    assert_eq!(of("pytest")["rule"], "cachedir-tag");
    assert!(of("pytest")["basis"].as_str().unwrap().contains("pytest"));
    let pre: Value = {
        let db = lab.ws.store.db.read().unwrap();
        let raw: String = db.query_row("SELECT pre FROM cleanup_items WHERE plan_id=?1 AND item_id='wt'", [plan["planId"].as_str()], |r| r.get(0)).unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    let names: Vec<&str> = pre["profiles"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["debug"], "a profile holding what Cargo does not make stays");
    assert_eq!(pre["kept"], json!(["notes.md", "release"]));
    // A rule in the repository adds nothing: only Core's rules count.
    std::fs::write(lab.project.join(".yuzuno-cleanup.json"), r#"{"rules":[{"name":"cachey"}]}"#).unwrap();
    let plan = submit(&lab, "repo-rule", vec![group("r", "rebuildable")], vec![item("plain", "r", "cache-dir", &lab.project.join("cachey"))]).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "plain"), "notIgnored");
}

#[tokio::test]
async fn a_project_that_is_a_folder_of_a_larger_repository_has_its_cache_folders_checked_from_the_repository_s_top() {
    let lab = lab();
    let app = lab.project.join("app");
    std::fs::create_dir_all(&app).unwrap();
    std::fs::write(app.join("Cargo.toml"), "[package]\n").unwrap();
    git(&lab.project, &["add", "app/Cargo.toml"]);
    git(&lab.project, &["commit", "-q", "-m", "app"]);
    cargo_target(&app.join("target"), &["debug"]);
    let loose = app.join("cachey");
    std::fs::create_dir_all(&loose).unwrap();
    std::fs::write(loose.join("CACHEDIR.TAG"), TAG_PYTEST).unwrap();
    {
        let db = lab.ws.store.db.write().unwrap();
        db.execute("UPDATE projects SET data=json_set(data,'$.defaultDirs.local',?1) WHERE json_extract(data,'$.name')='Demo'",
            [app.display().to_string()]).unwrap();
        // Its inventory is of the Project's folder as it is now.
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        db.execute("DELETE FROM local_jobs WHERE id='inv'", []).unwrap();
        inventory_job(&db, &task, "inv", json!({"kind": "local"}), &app);
    }
    let plan = submit(&lab, "mono", vec![group("r", "rebuildable")],
        vec![item("target", "r", "cache-dir", &app.join("target")), item("loose", "r", "cache-dir", &loose)]).await;
    let states = item_states(&lab, &plan).await;
    pending(&states, "target");
    assert_eq!(refused(&states, "loose"), "notIgnored");
    // The Project's folder itself stays fixed.
    let plan = submit(&lab, "mono-self", vec![group("d", "delete")], vec![item("app", "d", "worktree", &app)]).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "app"), "forbidden");
}

#[tokio::test]
async fn fresh_writes_and_the_evidence_window_keep_items_and_snapshots_have_a_limit() {
    let lab = lab();
    let job = lab.scratch.join("job-2");
    std::fs::create_dir_all(job.join("out")).unwrap();
    std::fs::write(job.join("out/shot.png"), vec![1u8; 2048]).unwrap();
    std::fs::write(job.join("out/report.json"), "{}").unwrap();
    std::fs::write(job.join("out/blob.bin"), vec![0u8; 4096]).unwrap();
    std::fs::write(job.join("main.rs"), "fn main() {}").unwrap();
    cargo_target(&lab.project.join("target"), &["debug"]);
    let plan = submit(&lab, "snap", vec![group("d", "delete"), group("r", "rebuildable")],
        vec![item("job", "d", "entry", &job), item("target", "r", "cache-dir", &lab.project.join("target"))]).await;
    let items = items_of(&lab, &plan).await;
    let job_item = items.iter().find(|i| i["item"] == "job").unwrap();
    assert_eq!(job_item["state"], "pending");
    assert_eq!(job_item["snapshot"], json!({"files": 2, "bytes": 2050}), "only evidence suffixes, not sources or binaries");
    let d = &plan["groups"][0]["summary"];
    assert_eq!(d["snapshots"], json!({"items": 1, "bytes": 2050}));
    settings_change(&lab, |c| {
        c.snapshot_max_mib = 0;
        c.fresh_days = 1;
        c.evidence_days = 7;
    });
    let plan = submit(&lab, "fresh", vec![group("d", "delete"), group("r", "rebuildable")],
        vec![item("job", "d", "entry", &job), item("target", "r", "cache-dir", &lab.project.join("target"))]).await;
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "job"), "evidenceWindow");
    assert_eq!(refused(&states, "target"), "fresh");
    settings_change(&lab, |c| c.evidence_days = 0);
    let plan = submit(&lab, "toolarge", vec![group("d", "delete")], vec![item("job", "d", "entry", &job)]).await;
    assert_eq!(refused(&item_states(&lab, &plan).await, "job"), "snapshotTooLarge");
    assert_eq!(plan["groups"][0]["summary"]["snapshotTooLarge"], 1);
}

#[tokio::test]
async fn a_decision_that_does_not_fit_its_kinds_refuses_the_whole_plan() {
    let lab = lab();
    let ahead = worktree(&lab, &lab.project.join(".worktrees/ahead"), "feat/ahead");
    std::fs::write(ahead.join("new.txt"), "mine\n").unwrap();
    git(&ahead, &["add", "new.txt"]);
    git(&ahead, &["commit", "-q", "-m", "mine"]);
    std::fs::create_dir_all(lab.scratch.join("e")).unwrap();
    for (decision, kind, path) in [("rebuildable", "worktree", ahead.clone()), ("rebuildable", "entry", lab.scratch.join("e")),
        ("delete", "cache-dir", lab.scratch.join("e"))] {
        let error = submit_as(&lab, Some("ex"), plan_input(&format!("mismatch-{decision}-{kind}"),
            vec![json!({"id": "g", "label": "Rebuildable build output", "decision": decision})], vec![item("x", "g", kind, &path)]))
            .await.unwrap_err().to_string();
        assert!(error.starts_with("kind_mismatch:"), "{error}");
    }
    let count: i64 = lab.ws.store.db.read().unwrap().query_row("SELECT COUNT(*) FROM cleanup_plans", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0, "nothing was registered");
    // Keep and ask groups take any kind.
    submit(&lab, "keep", vec![group("k", "keep"), group("a", "ask")],
        vec![item("w", "k", "worktree", &ahead), item("e", "a", "entry", &lab.scratch.join("e"))]).await;
}

#[tokio::test]
async fn core_s_summary_shows_a_worktree_with_its_own_commits_whatever_the_author_calls_its_group() {
    let lab = lab();
    let ahead = worktree(&lab, &lab.project.join(".worktrees/ahead"), "feat/ahead");
    std::fs::write(ahead.join("new.txt"), "mine\n").unwrap();
    git(&ahead, &["add", "new.txt"]);
    git(&ahead, &["commit", "-q", "-m", "mine"]);
    std::fs::write(ahead.join("draft.txt"), "untracked\n").unwrap();
    lab.ws.cleanup.skip_kind_check.store(true, std::sync::atomic::Ordering::SeqCst);
    let misleading = json!({"id": "g", "label": "Rebuildable build output (safe)", "decision": "rebuildable", "reason": "only caches"});
    let plan = submit(&lab, "lie", vec![misleading], vec![item("w", "g", "worktree", &ahead)]).await;
    let summary = &plan["groups"][0]["summary"];
    assert_eq!(summary["worktrees"], 1);
    assert_eq!(summary["kinds"]["worktree"], 1);
    assert_eq!(summary["uniqueCommits"], json!({"worktrees": 1, "commits": 1}));
    assert_eq!(summary["untrackedFiles"], 1);
    assert_eq!(summary["categories"]["worktree-unique-commits"], 1);
    let codes: Vec<&str> = summary["warnings"].as_array().unwrap().iter().map(|w| w["code"].as_str().unwrap()).collect();
    assert!(codes.contains(&"notRebuildable") && codes.contains(&"uniqueCommits") && codes.contains(&"uncommitted"), "{codes:?}");
    assert_eq!(plan["groups"][0]["authorLabel"], "Rebuildable build output (safe)", "the author's words stay beside, apart");
    // The summary is the items' alone: other labels and reasons, the same summary.
    let honest = json!({"id": "g", "label": "Anything at all", "decision": "rebuildable", "reason": "something else"});
    let again = submit(&lab, "honest", vec![honest], vec![json!({"id": "w", "group": "g", "kind": "worktree", "path": ahead, "reason": "other words"})]).await;
    let full = |plan: &Value| -> Value {
        let db = lab.ws.store.db.read().unwrap();
        let raw: String = db.query_row("SELECT data FROM cleanup_plans WHERE id=?1", [plan["planId"].as_str()], |r| r.get(0)).unwrap();
        serde_json::from_str::<Value>(&raw).unwrap()["summary"].clone()
    };
    assert_eq!(full(&plan), full(&again));
    assert_ne!(plan["sha256"], again["sha256"], "the sha256 also covers the author's words");
    // Computed twice from the same items: the same.
    let stored = vec![summary::Stored { id: "w".into(), group: "g".into(), kind: "worktree".into(), path: "/x".into(), refusal: None,
        pre: json!({"category": "worktree-unique-commits", "bytes": 5, "worktree": {"uniqueCommits": 2}})}];
    let groups = vec![("g".to_owned(), "delete".to_owned())];
    assert_eq!(summary::all(&groups, &stored, 10), summary::all(&groups, &stored, 10));
}

#[tokio::test]
async fn only_the_task_s_executor_registers_a_retry_is_the_same_plan_and_a_newer_one_cancels_it() {
    let lab = lab();
    std::fs::create_dir_all(lab.scratch.join("e")).unwrap();
    let input = || plan_input("once", vec![group("g", "delete")], vec![item("e", "g", "entry", &lab.scratch.join("e"))]);
    for actor in [Some("lead"), Some("stranger"), None] {
        let error = submit_as(&lab, actor, input()).await.unwrap_err().to_string();
        assert!(error.starts_with("not_executor:"), "{actor:?}: {error}");
    }
    let first = submit_as(&lab, Some("ex"), input()).await.unwrap();
    let retry = submit_as(&lab, Some("ex"), input()).await.unwrap();
    assert_eq!(first["planId"], retry["planId"]);
    assert_eq!(first["sha256"], retry["sha256"]);
    let mut changed = input();
    changed["title"] = json!("Another");
    let error = submit_as(&lab, Some("ex"), changed).await.unwrap_err().to_string();
    assert!(error.starts_with("idempotency_conflict:"), "{error}");
    // Inventory must be this task's checked Job artifact.
    let mut wrong = plan_input("wrong-inventory", vec![group("g", "delete")], vec![item("e", "g", "entry", &lab.scratch.join("e"))]);
    wrong["inventory"]["sha256"] = json!("c".repeat(64));
    let error = submit_as(&lab, Some("ex"), wrong).await.unwrap_err().to_string();
    assert!(error.starts_with("invalid_input:") && error.contains("inventory"), "{error}");
    let current = lab.ws.stored(|s| current_plan(s, "T-1")).await.unwrap();
    assert_eq!(current["plan"]["planId"], first["planId"]);
    let newer = submit(&lab, "newer", vec![group("g", "delete")], vec![item("e", "g", "entry", &lab.scratch.join("e"))]).await;
    let current = lab.ws.stored(|s| current_plan(s, "T-1")).await.unwrap();
    assert_eq!(current["plan"]["planId"], newer["planId"]);
    let old = lab.ws.collaboration_call(Some("ex"), "cleanup_plan_get", json!({"planId": first["planId"]})).await.unwrap();
    assert_eq!(old["state"], "cancelled");
    assert_eq!(old["cancelled"]["planId"], newer["planId"]);
    // Past its expiry it is expired, and Home has nothing to approve.
    lab.ws.store.db.write().unwrap().execute("UPDATE cleanup_plans SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?1",
        [newer["planId"].as_str()]).unwrap();
    let current = lab.ws.stored(|s| current_plan(s, "T-1")).await.unwrap();
    assert!(current["plan"].is_null());
    assert_eq!(current["planned"], true, "it had plans: a gate ask of it is still a cleanup approval");
    let read = lab.ws.collaboration_call(None, "cleanup_plan_get", json!({"planId": newer["planId"]})).await.unwrap();
    assert_eq!(read["state"], "expired");
}

#[tokio::test]
async fn its_executor_a_lead_and_the_user_read_it_and_items_come_in_pages() {
    let lab = lab();
    assert_eq!(lab.ws.stored(|s| current_plan(s, "T-1")).await.unwrap()["planned"], false, "no plan yet");
    for name in ["a", "b", "c"] {
        std::fs::create_dir_all(lab.scratch.join(name)).unwrap();
    }
    let plan = submit(&lab, "read", vec![group("g", "delete")],
        ["a", "b", "c"].iter().map(|n| item(n, "g", "entry", &lab.scratch.join(n))).collect()).await;
    for actor in [Some("ex"), Some("lead"), None] {
        let read = lab.ws.collaboration_call(actor, "cleanup_plan_get", json!({"planId": plan["planId"]})).await.unwrap();
        assert_eq!(read["sha256"], plan["sha256"]);
        assert!(read["groups"][0]["summary"]["largest"].is_array());
    }
    let error = lab.ws.collaboration_call(Some("stranger"), "cleanup_plan_get", json!({"planId": plan["planId"]})).await.unwrap_err();
    assert!(error.to_string().starts_with("not_allowed:"), "{error}");
    let page = lab.ws.collaboration_call(Some("ex"), "cleanup_plan_get", json!({"planId": plan["planId"], "view": "items", "limit": 2})).await.unwrap();
    assert_eq!(page["itemsPage"].as_array().unwrap().len(), 2);
    assert_eq!(page["hasMore"], true);
    let rest = lab.ws.collaboration_call(Some("ex"), "cleanup_plan_get",
        json!({"planId": plan["planId"], "view": "items", "afterItem": page["nextAfterItem"]})).await.unwrap();
    assert_eq!(rest["itemsPage"][0]["item"], "c");
    assert_eq!(rest["hasMore"], false);
    // The registration was noted on its task.
    let db = lab.ws.store.db.read().unwrap();
    let body: String = db.query_row("SELECT json_extract(data,'$.body') FROM collaboration_task_activity WHERE json_extract(data,'$.source.cleanupPlan.planId')=?1",
        [plan["planId"].as_str()], |r| r.get(0)).unwrap();
    assert!(body.contains("Nothing is removed by registering it"), "{body}");
}

#[tokio::test]
async fn a_plan_from_another_machine_s_inventory_is_registered_with_every_item_refused() {
    let lab = lab();
    {
        let db = lab.ws.store.db.write().unwrap();
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        db.execute("DELETE FROM local_jobs WHERE id='inv'", []).unwrap();
        inventory_job(&db, &task, "inv", json!({"kind": "ssh", "machineId": "m1"}), Path::new("/synthetic/m1/demo"));
    }
    // The inventory is of the Project's folder on that machine.
    let demo = lab.ws.store.projects().unwrap().into_iter().find(|p| p.name == "Demo").unwrap();
    lab.ws.store.update_project(&demo.id, crate::projects::ProjectChange { name: None, key: None, archived: None,
        default_dirs: BTreeMap::from([("m1".to_owned(), Some("/synthetic/m1/demo".to_owned()))]) }).unwrap();
    let plan = submit(&lab, "remote", vec![group("g", "delete")], vec![item("x", "g", "entry", Path::new("/synthetic/remote/x"))]).await;
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "x"), "remote");
    assert_eq!(plan["machine"], "Synthetic host");
}

#[test]
fn settings_are_checked_and_saved_against_the_version_read() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let db = ws.store.db.write().unwrap();
    let fresh = settings::read(&db).unwrap();
    assert!(fresh.protected_paths.is_empty() && fresh.scratch_roots.is_empty(), "nothing assumed on a new install");
    assert_eq!((fresh.max_items, fresh.plan_hours, fresh.fresh_days, fresh.evidence_days, fresh.snapshot_max_mib), (2000, 24, 1, 7, 256));
    let change = |protected: Vec<&str>, version: i64, max_items: u32| settings::Change {
        protected_paths: protected.into_iter().map(str::to_owned).collect(), scratch_roots: vec![], max_items, plan_hours: 24,
        summary_paths: 10, fresh_days: 1, evidence_days: 7, snapshot_max_mib: 256, evidence_file_mib: 4,
        evidence_suffixes: vec![".PNG".into(), "png".into()], snapshot_days: 30, rules: None, project_rules: None,
        rule_layer: None, worktree_reclaim: None, worktree_keep_days: None, expected_version: version,
    };
    assert!(settings::change(&db, change(vec!["relative/path"], 0, 10)).unwrap_err().to_string().starts_with("invalid_input:"));
    assert!(settings::change(&db, change(vec!["/"], 0, 10)).unwrap_err().to_string().starts_with("invalid_input:"));
    assert!(settings::change(&db, change(vec![], 0, 2001)).unwrap_err().to_string().starts_with("invalid_input:"));
    let saved = settings::change(&db, change(vec!["/synthetic/evidence", "/synthetic/evidence"], 0, 10)).unwrap();
    assert_eq!(saved.protected_paths, ["/synthetic/evidence"]);
    assert_eq!(saved.evidence_suffixes, ["png"]);
    assert_eq!(saved.version, 1);
    assert!(settings::change(&db, change(vec![], 0, 10)).unwrap_err().to_string().starts_with("version_conflict:"));
    assert_eq!(settings::read(&db).unwrap(), saved);
}

#[test]
fn git_worktree_list_is_read_with_its_main_worktree_first() {
    let listed = check::parse_worktrees(
        "worktree /synthetic/demo\nHEAD 1111\nbranch refs/heads/main\n\nworktree /synthetic/wt/x\nHEAD 2222\nbranch refs/heads/feat/x\nlocked reason\n\nworktree /synthetic/gone\nHEAD 3333\ndetached\nprunable gitdir file points to non-existent location\n",
    );
    assert_eq!(listed.len(), 3);
    assert!(listed[0].main && !listed[1].main);
    assert_eq!(listed[1].branch.as_deref(), Some("feat/x"));
    assert!(listed[1].locked && !listed[0].locked);
    assert!(listed[2].prunable && listed[2].branch.is_none());
}

#[path = "apply_tests.rs"]
mod apply_tests;

#[path = "inventory_tests.rs"]
mod inventory_tests;

// ---------------------------------------------------------------------------
// ③b: the rule layer, its automatic records, the to-tidy list and migration.

fn commit_in(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-q", "-m", name]);
}

fn exclude(lab: &Lab, pattern: &str) {
    let common = git(&lab.project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    let file = Path::new(&common).join("info/exclude");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let mut text = std::fs::read_to_string(&file).unwrap_or_default();
    text.push_str(&format!("{pattern}\n"));
    std::fs::write(file, text).unwrap();
}

fn auto_settings(lab: &Lab, worktrees: bool, caches: bool, keep_days: u32) {
    settings_change(lab, |c| {
        c.worktree_reclaim = worktrees;
        c.rule_layer = caches;
        c.worktree_keep_days = keep_days;
        c.fresh_days = 0;
    });
}

fn yn65_keep_days(lab: &Lab, days: u32) {
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO build_cleanup_policy(id,data) VALUES(1,?1)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        [json!({"enabled":false,"keepDays":days,"since":null,"version":0,"changedAt":null}).to_string()],
    ).unwrap();
}

async fn automatic(lab: &Lab) -> usize {
    super::automatic::pass(&lab.ws).await.unwrap()
}

fn auto_states(lab: &Lab) -> Vec<(String, String, String)> {
    let db = lab.ws.store.db.read().unwrap();
    let mut q = db.prepare("SELECT r.state,i.path,i.state FROM cleanup_automatic_runs r
        LEFT JOIN cleanup_automatic_items i ON i.run_id=r.id ORDER BY r.started_at,i.seq").unwrap();
    q.query_map([], |r| Ok((r.get(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default(), r.get::<_, Option<String>>(2)?.unwrap_or_default())))
        .unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

fn auto_item(lab: &Lab, path: &Path) -> Option<Value> {
    let db = lab.ws.store.db.read().unwrap();
    let text = path.to_string_lossy().into_owned();
    db.query_row("SELECT result,snapshot,ref,task_id FROM cleanup_automatic_items WHERE path=?1 ORDER BY rowid DESC LIMIT 1", [text],
        |r| Ok(json!({"result": r.get::<_, Option<String>>(0)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null),
            "snapshot": r.get::<_, Option<String>>(1)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null),
            "ref": r.get::<_, Option<String>>(2)?, "task": r.get::<_, Option<String>>(3)?}))).optional().unwrap()
}

#[tokio::test]
async fn the_rule_layer_reclaims_an_ancestor_worktree_and_keeps_its_automatic_record() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/anc"), "feat/anc");
    let head = git(&tree, &["rev-parse", "HEAD"]);
    assert!(automatic(&lab).await >= 1);
    assert!(!tree.exists(), "an ancestor with nothing else is reclaimed");
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["result"]["code"], "removed", "{item:#}");
    assert_eq!(item["task"], Value::Null, "no task is invented");
    let pinned = item["ref"].as_str().unwrap();
    assert_eq!(git(&lab.project, &["rev-parse", pinned]), head);
    let runs = auto_states(&lab);
    assert!(runs.iter().any(|(state, _, _)| state == "done" || state == "incomplete"), "{runs:?}");
}

#[tokio::test]
async fn a_worktree_at_origin_s_same_named_tip_is_reclaimed_and_one_with_its_own_commits_is_not() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let pushed = worktree(&lab, &lab.home.join("work/wt/tip"), "feat/tip");
    commit_in(&pushed, "tip.txt", "on origin\n");
    git(&lab.project, &["push", "-q", "origin", "feat/tip"]);
    let own = worktree(&lab, &lab.home.join("work/wt/own"), "feat/own");
    commit_in(&own, "mine.txt", "only here\n");
    assert!(automatic(&lab).await >= 1);
    assert!(!pushed.exists(), "its HEAD is the same-named branch on origin");
    assert!(own.exists(), "its own commit keeps it");
    let item = auto_item(&lab, &own).unwrap();
    assert_eq!(item["result"]["code"], "uniqueCommits", "{item:#}");
    let db = lab.ws.store.db.read().unwrap();
    let reason: String = db.query_row("SELECT reason FROM cleanup_to_tidy WHERE path=?1", [own.to_string_lossy().as_ref()], |r| r.get(0)).unwrap();
    assert_eq!(reason, "uniqueCommits");
}

#[tokio::test]
async fn a_merged_pull_request_s_head_is_reclaimed_even_with_a_commit_no_branch_has() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/pr"), "feat/pr");
    commit_in(&tree, "pr.txt", "merged\n");
    let head = git(&tree, &["rev-parse", "HEAD"]);
    git(&lab.project, &["remote", "set-url", "origin", "/synthetic/demo.git"]);
    let db = lab.ws.store.db.write().unwrap();
    let project: String = db.query_row("SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'", [], |r| r.get(0)).unwrap();
    db.execute("INSERT OR IGNORE INTO github_repositories(id,data) VALUES(7,'{\"fullName\":\"synthetic/demo\"}')", []).unwrap();
    db.execute("INSERT OR IGNORE INTO github_project_repos(project_id,repo_id) VALUES(?1,7)", [&project]).unwrap();
    db.execute("INSERT INTO github_objects(id,repo_id,kind,number,data) VALUES('7:pull:1',7,'pull',1,?1)", [json!({
        "snapshot": {"state": "merged", "headSha": head, "observedAt": "2026-11-09T00:00:00+00:00"}}).to_string()]).unwrap();
    drop(db);
    assert!(automatic(&lab).await >= 1);
    assert!(!tree.exists(), "a merged PR's head is proof enough");
}

#[tokio::test]
async fn untracked_files_a_lock_and_an_unknown_git_answer_keep_a_worktree() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let dirty = worktree(&lab, &lab.home.join("work/wt/dirty"), "feat/dirty");
    std::fs::write(dirty.join("draft.md"), "draft\n").unwrap();
    let locked = worktree(&lab, &lab.home.join("work/wt/locked"), "feat/locked");
    git(&lab.project, &["worktree", "lock", locked.to_str().unwrap()]);
    let unknown = worktree(&lab, &lab.home.join("work/wt/unknown"), "feat/unknown");
    // origin/main gone: the ancestor proof cannot answer, and the branch is on no origin.
    // Another remote ref keeps its commit from counting as one of its own.
    git(&lab.project, &["update-ref", "refs/remotes/origin/keep", "HEAD"]);
    git(&lab.project, &["update-ref", "-d", "refs/remotes/origin/main"]);
    assert!(automatic(&lab).await >= 1);
    assert!(dirty.exists() && locked.exists() && unknown.exists(), "nothing uncertain is removed");
    let locked_item = auto_item(&lab, &locked).unwrap();
    assert_eq!(locked_item["result"]["code"], "locked", "{locked_item:#}");
    let unknown_item = auto_item(&lab, &unknown).unwrap();
    assert!(matches!(unknown_item["result"]["code"].as_str(), Some("unknownGit") | Some("needsCherry")), "{unknown_item:#}");
}

#[tokio::test]
async fn a_recent_job_in_a_worktree_keeps_it_after_an_old_release() {
    let lab = lab();
    auto_settings(&lab, true, false, 7);
    let tree = worktree(&lab, &lab.home.join("work/wt/used"), "feat/used");
    let days = |n: i64| (chrono::Utc::now() - chrono::Duration::days(n)).to_rfc3339();
    agent(&lab.ws, "old");
    let db = lab.ws.store.db.write().unwrap();
    let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
    db.execute("UPDATE agents SET data=json_set(data,'$.cwd',?1) WHERE id='old'", [tree.to_string_lossy().as_ref()]).unwrap();
    db.execute("INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at,archived_at)
        VALUES('old','executor','workspace-cleanup',?1,'agent:lead','released','now','now',?2)",
        params![task, days(10)]).unwrap();
    db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('reuse',?1,'old','succeeded',?2)",
        params![task, json!({"cwd": tree, "status": "succeeded", "finishedAt": days(1), "target": {"kind": "local"}}).to_string()]).unwrap();
    drop(db);
    assert!(automatic(&lab).await >= 1);
    assert!(tree.exists(), "a job there yesterday is newer than the old release");
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["result"]["code"], "recent", "{item:#}");
}

#[tokio::test]
async fn an_automatic_run_restores_a_taskless_worktree_and_a_restart_never_retries_it() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    exclude(&lab, "notes/");
    let tree = worktree(&lab, &lab.home.join("work/wt/auto"), "feat/auto");
    std::fs::create_dir_all(tree.join("notes")).unwrap();
    std::fs::write(tree.join("notes/n.txt"), "kept in the snapshot\n").unwrap();
    let head = git(&tree, &["rev-parse", "HEAD"]);
    assert!(automatic(&lab).await >= 1);
    assert!(!tree.exists());
    let run: String = lab.ws.store.db.read().unwrap()
        .query_row("SELECT run_id FROM cleanup_automatic_items WHERE path=?1", [tree.to_string_lossy().as_ref()], |r| r.get(0)).unwrap();
    // Only the lead of the Project (or the user) restores it, by runId.
    let denied = lab.ws.collaboration_call(Some("ex"), "cleanup_restore", json!({"requestId":"r0","runId":run,"itemId":"1"})).await.unwrap_err().to_string();
    assert!(denied.starts_with("not_allowed:"), "{denied}");
    let back = lab.ws.collaboration_call(Some("lead"), "cleanup_restore", json!({"requestId":"r1","runId":run,"itemId":"1"})).await.unwrap();
    assert_eq!(back["state"], "restored");
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), head);
    assert_eq!(std::fs::read_to_string(tree.join("notes/n.txt")).unwrap(), "kept in the snapshot\n");
    // A run and an item a stopped Core left mid-removal are interrupted, never retried.
    let db = lab.ws.store.db.write().unwrap();
    db.execute("INSERT INTO cleanup_automatic_runs(id,project_id,machine,task_id,policy_version,params,state,started_at,data)
        VALUES('stale',(SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'),'local',NULL,0,'{}','running','now','{}')", []).unwrap();
    db.execute("INSERT INTO cleanup_automatic_items(run_id,item_id,seq,kind,path,state,evidence,pre,updated_at)
        VALUES('stale','1',1,'cache-dir','/synthetic/left','removing','{}','{}','now')", []).unwrap();
    drop(db);
    assert_eq!(lab.ws.stored(super::automatic::recover).await.unwrap(), 1);
    let (state, item_state): (String, String) = lab.ws.store.db.read().unwrap().query_row(
        "SELECT r.state,i.state FROM cleanup_automatic_runs r JOIN cleanup_automatic_items i ON i.run_id=r.id WHERE r.id='stale'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((state.as_str(), item_state.as_str()), ("interrupted", "interrupted"));
}

#[tokio::test]
async fn a_new_install_opens_the_rule_layer_and_an_upgrade_keeps_every_new_switch_off() {
    let dir = tempfile::tempdir().unwrap();
    // A Workspace opened by an earlier Core: a user table exists already, and
    // YN-65's own policy row says it was on.
    let old = dir.path().join("old.db");
    {
        let db = rusqlite::Connection::open(&old).unwrap();
        db.execute_batch("CREATE TABLE build_cleanup_policy(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);").unwrap();
        db.execute("INSERT INTO build_cleanup_policy(id,data) VALUES(1,?1)", [json!({"enabled":true,"keepDays":3,
            "since":"2026-01-01T00:00:00+00:00","version":4,"changedAt":null}).to_string()]).unwrap();
    }
    let store = crate::store::Store::open(&old).unwrap();
    {
        let db = store.db.read().unwrap();
        let settings = settings::read(&db).unwrap();
        assert!(!settings.rule_layer && !settings.worktree_reclaim, "an upgrade keeps the new switches off");
        assert_eq!(settings.worktree_keep_days, 7);
        let init = settings::initialization(&db).unwrap();
        assert_eq!(init["fresh"], false);
        assert!(init["notice"].as_str().is_some(), "one notice is left for Settings");
        let policy = crate::build_cleanup::policy(&db).unwrap();
        assert!(policy.enabled && policy.keep_days == 3 && policy.version == 4, "YN-65 is untouched");
        assert_eq!(policy.since.as_deref(), Some("2026-01-01T00:00:00+00:00"));
    }
    let fresh = crate::store::Store::open(&dir.path().join("new.db")).unwrap();
    let db = fresh.db.read().unwrap();
    let settings = settings::read(&db).unwrap();
    assert!(settings.rule_layer && settings.worktree_reclaim, "a new install has both on");
    assert_eq!(settings::initialization(&db).unwrap()["fresh"], true);
}

#[tokio::test]
async fn a_walk_over_its_bound_is_incomplete_and_skips_protected_paths() {
    let lab = lab();
    // Three rule folders, one under a protected path: a bound of two sees two.
    for name in ["a", "b", "c", "protected/d"] {
        let dir = lab.project.join(name).join("node_modules");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(lab.project.join(name).join("package.json"), "{\"name\":\"x\"}").unwrap();
        std::fs::write(lab.project.join(name).join("package-lock.json"), "{}").unwrap();
        std::fs::write(dir.join("x.js"), "x\n").unwrap();
    }
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.max_items = 2;
        c.protected_paths = vec![lab.project.join("protected").display().to_string()];
        c.fresh_days = 0;
    });
    assert!(automatic(&lab).await >= 1);
    let db = lab.ws.store.db.read().unwrap();
    let states: Vec<(String, String)> = db.prepare("SELECT r.state,i.path FROM cleanup_automatic_runs r
        JOIN cleanup_automatic_items i ON i.run_id=r.id").unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert!(states.iter().any(|(state, _)| state == "incomplete"), "{states:?}");
    assert!(!states.iter().any(|(_, path)| path.contains("/protected/")), "a protected path is not walked: {states:?}");
}

#[tokio::test]
async fn a_closed_task_leaves_its_recorded_folders_for_the_next_cleanup() {
    let lab = lab();
    let folder = lab.home.join("work/wt/recorded");
    let db = lab.ws.store.db.write().unwrap();
    let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
    db.execute("INSERT INTO task_workspaces(id,task_id,data) VALUES('w1',?1,?2)",
        params![task, json!({"id":"w1","path":folder}).to_string()]).unwrap();
    drop(db);
    lab.ws.store.collaboration_call(None, "task_update", json!({"requestId":"close","taskId":"T-1","expectedVersion":1,
        "patch":{"status":"done"}})).unwrap();
    let db = lab.ws.store.db.read().unwrap();
    let (reason, state): (String, String) = db.query_row("SELECT reason,state FROM cleanup_to_tidy WHERE path=?1",
        [folder.to_string_lossy().as_ref()], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((reason.as_str(), state.as_str()), ("taskClosed", "open"));
}

#[tokio::test]
async fn the_rule_layer_removes_only_cargo_s_own_subtrees_and_leaves_the_rest() {
    let lab = lab();
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.fresh_days = 0;
        c.worktree_keep_days = 0;
    });
    yn65_keep_days(&lab, 0);
    let target = lab.project.join("target");
    cargo_target(&target, &["debug", "release"]);
    std::fs::write(target.join("mine.txt"), "not Cargo's\n").unwrap();
    assert!(automatic(&lab).await >= 1);
    assert!(!target.join("debug").exists() && !target.join("release").exists(), "Cargo's profiles go");
    assert_eq!(std::fs::read_to_string(target.join("mine.txt")).unwrap(), "not Cargo's\n", "everything else stays");
}

#[tokio::test]
async fn the_to_tidy_list_is_the_same_for_a_dispatch_and_paged_for_the_executor() {
    let lab = lab();
    let db = lab.ws.store.db.write().unwrap();
    let project: String = db.query_row("SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'", [], |r| r.get(0)).unwrap();
    for (i, reason) in ["uniqueCommits", "needsCherry", "snapshotTooLarge"].iter().enumerate() {
        db.execute("INSERT INTO cleanup_to_tidy(project_id,machine,path,reason,first_seen,last_seen,state)
            VALUES(?1,'local',?2,?3,'now','now','open')", params![project, format!("/synthetic/tidy/{i}"), reason]).unwrap();
    }
    let materials = super::automatic::tidy_snapshot(&db, &project, "local", 20).unwrap();
    assert_eq!(materials["total"], 3);
    assert_eq!(materials["returned"], 3);
    assert!(materials["readWith"].as_str().unwrap().contains("cleanup_tidy_get"));
    drop(db);
    let page = lab.ws.collaboration_call(Some("ex"), "cleanup_tidy_get", json!({"taskId":"T-1","limit":2})).await.unwrap();
    assert_eq!(page["total"], 3);
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert_eq!(page["hasMore"], true);
    let next = page["nextAfter"].as_str().unwrap().to_owned();
    let rest = lab.ws.collaboration_call(Some("ex"), "cleanup_tidy_get", json!({"taskId":"T-1","after":next,"limit":2})).await.unwrap();
    assert_eq!(rest["items"].as_array().unwrap().len(), 1);
    assert_eq!(rest["hasMore"], false);
    let denied = lab.ws.collaboration_call(Some("stranger"), "cleanup_tidy_get", json!({"taskId":"T-1"})).await.unwrap_err().to_string();
    assert!(denied.starts_with("not_allowed:"), "{denied}");
}

#[tokio::test]
async fn the_rule_layer_walks_a_registered_worktree_outside_the_project_folder() {
    let lab = lab();
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.fresh_days = 0;
    });
    yn65_keep_days(&lab, 0);
    exclude(&lab, "node_modules/");
    let tree = worktree(&lab, &lab.home.join("work/wt/outside"), "feat/outside");
    let modules = tree.join("node_modules");
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::write(tree.join("package.json"), "{\"name\":\"x\"}").unwrap();
    std::fs::write(tree.join("package-lock.json"), "{}").unwrap();
    std::fs::write(modules.join("x.js"), "x\n").unwrap();
    assert!(automatic(&lab).await >= 1);
    assert!(!modules.exists(), "a rule folder in a registered worktree outside the Project goes");
}

#[tokio::test]
async fn an_open_executor_or_a_live_job_in_a_worktree_keeps_it() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let busy = worktree(&lab, &lab.home.join("work/wt/busy"), "feat/busy");
    let running = worktree(&lab, &lab.home.join("work/wt/running"), "feat/running");
    agent(&lab.ws, "busy");
    let db = lab.ws.store.db.write().unwrap();
    let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
    db.execute("UPDATE agents SET data=json_set(data,'$.cwd',?1) WHERE id='busy'", [busy.to_string_lossy().as_ref()]).unwrap();
    db.execute("INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at)
        VALUES('busy','executor','workspace-cleanup',?1,'agent:lead','running','now','now')", [&task]).unwrap();
    db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('live',?1,'ex','running',?2)",
        params![task, json!({"cwd": running, "status": "running", "target": {"kind": "local"}}).to_string()]).unwrap();
    drop(db);
    assert!(automatic(&lab).await >= 1);
    assert!(busy.exists(), "an open executor's worktree stays");
    assert!(running.exists(), "a live Job's worktree stays");
    let busy_item = auto_item(&lab, &busy).unwrap();
    assert_eq!(busy_item["result"]["code"], "inUse", "{busy_item:#}");
    let running_item = auto_item(&lab, &running).unwrap();
    assert_eq!(running_item["result"]["code"], "inUse", "{running_item:#}");
}

#[tokio::test]
async fn cache_folders_wait_for_yn65_s_keep_days() {
    let lab = lab();
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.fresh_days = 0;
    });
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO build_cleanup_policy(id,data) VALUES(1,?1)",
        [json!({"enabled":false,"keepDays":3,"since":null,"version":0,"changedAt":null}).to_string()],
    ).unwrap();
    cargo_target(&lab.project.join("target"), &["debug"]);
    assert!(automatic(&lab).await >= 1);
    assert!(lab.project.join("target/debug").exists(), "YN-65 keepDays still protects a fresh profile");
    let item = auto_item(&lab, &lab.project.join("target")).unwrap();
    assert_eq!(item["result"]["code"], "keepDays", "{item:#}");
}

#[tokio::test]
async fn an_interrupted_path_is_never_tried_automatically_again() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/stopped"), "feat/stopped");
    let db = lab.ws.store.db.write().unwrap();
    let project: String = db.query_row("SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'", [], |r| r.get(0)).unwrap();
    db.execute("INSERT INTO cleanup_automatic_runs(id,project_id,machine,task_id,policy_version,params,state,started_at,finished_at,data)
        VALUES('earlier',?1,'local',NULL,0,'{}','interrupted','now','now','{}')", [&project]).unwrap();
    db.execute("INSERT INTO cleanup_automatic_items(run_id,item_id,seq,kind,path,state,evidence,pre,updated_at)
        VALUES('earlier','1',1,'worktree',?1,'interrupted','{}','{}','now')", [tree.to_string_lossy().as_ref()]).unwrap();
    drop(db);
    assert!(automatic(&lab).await >= 1);
    assert!(tree.exists(), "a path an earlier pass interrupted is left alone");
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["result"]["code"], "interrupted", "{item:#}");
}

#[tokio::test]
async fn an_interrupted_automatic_removal_with_its_snapshot_and_ref_can_be_restored() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    exclude(&lab, "notes/");
    let tree = worktree(&lab, &lab.home.join("work/wt/interrupted"), "feat/interrupted");
    std::fs::create_dir_all(tree.join("notes")).unwrap();
    std::fs::write(tree.join("notes/n.txt"), "in the snapshot\n").unwrap();
    let head = git(&tree, &["rev-parse", "HEAD"]);
    assert!(automatic(&lab).await >= 1);
    let db = lab.ws.store.db.write().unwrap();
    let (run, item): (String, String) = db.query_row("SELECT run_id,item_id FROM cleanup_automatic_items WHERE path=?1",
        [tree.to_string_lossy().as_ref()], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    // A Core that stopped after the removal: its item is interrupted, but the
    // snapshot and pinned ref were already on record.
    db.execute("UPDATE cleanup_automatic_items SET state='interrupted' WHERE run_id=?1 AND item_id=?2", params![run, item]).unwrap();
    drop(db);
    let back = lab.ws.collaboration_call(Some("lead"), "cleanup_restore", json!({"requestId":"r1","runId":run,"itemId":item})).await.unwrap();
    assert_eq!(back["state"], "restored");
    assert_eq!(back["runId"], run.as_str(), "an automatic answer names its run");
    assert!(back.get("planId").is_none(), "and no manual plan id");
    let retry = lab.ws.collaboration_call(Some("lead"), "cleanup_restore", json!({"requestId":"r1","runId":run,"itemId":item})).await.unwrap();
    assert_eq!((retry["state"].as_str(), retry["runId"].as_str()), (Some("restored"), Some(run.as_str())));
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), head);
    assert_eq!(std::fs::read_to_string(tree.join("notes/n.txt")).unwrap(), "in the snapshot\n");
}

#[tokio::test]
async fn a_folder_replaced_by_another_repository_is_not_this_project_s_cache() {
    let lab = lab();
    let tree = worktree(&lab, &lab.home.join("work/wt/identity"), "feat/identity");
    let project: String = lab.ws.store.db.read().unwrap()
        .query_row("SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'", [], |r| r.get(0)).unwrap();
    let settings = settings::read(&lab.ws.store.db.read().unwrap()).unwrap();
    let ctx = check::context(lab.ws.cleanup.env(), lab.ws.cleanup.mounts(), &lab.ws.data_dir, &lab.project.display().to_string(),
        Some(&project), &[], settings).await.unwrap();
    // The same path now holds a different repository's checkout.
    std::fs::rename(&tree, lab.home.join("work/wt/identity-away")).unwrap();
    std::fs::create_dir_all(&tree).unwrap();
    git(&tree, &["init", "-q"]);
    std::fs::write(tree.join(".gitignore"), "node_modules/\n").unwrap();
    git(&tree, &["add", ".gitignore"]);
    git(&tree, &["commit", "-q", "-m", "other"]);
    let modules = tree.join("node_modules");
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::write(tree.join("package.json"), "{\"name\":\"other\"}").unwrap();
    std::fs::write(tree.join("package-lock.json"), "{}").unwrap();
    std::fs::write(modules.join("x.js"), "other\n").unwrap();
    let item = check::Item { id: "c".into(), group: "g".into(), kind: "cache-dir".into(), rule: None,
        path: modules.display().to_string(), save_diff: false };
    let checked = check::preflight(&ctx, &item).await;
    assert_eq!(checked.refusal.map(|(code, _)| code), Some("otherTree"), "{:#}", checked.pre);
    assert!(modules.exists(), "nothing in another repository is a candidate");
}

#[tokio::test]
async fn a_stop_after_the_snapshot_and_ref_leaves_a_restorable_prepared_item() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    exclude(&lab, "notes/");
    let tree = worktree(&lab, &lab.home.join("work/wt/prepared"), "feat/prepared");
    std::fs::create_dir_all(tree.join("notes")).unwrap();
    std::fs::write(tree.join("notes/n.txt"), "snapshot before removal\n").unwrap();
    let head = git(&tree, &["rev-parse", "HEAD"]);
    lab.ws.cleanup.stop_after_prepare.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = automatic(&lab).await;
    // Nothing destructive has happened, and both the snapshot and the pinned
    // ref are already on record.
    assert!(tree.exists());
    let (run, item, state, snapshot, reference): (String, String, String, Option<String>, Option<String>) =
        lab.ws.store.db.read().unwrap().query_row(
            "SELECT run_id,item_id,state,snapshot,ref FROM cleanup_automatic_items WHERE path=?1 ORDER BY rowid DESC LIMIT 1",
            [tree.to_string_lossy().as_ref()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap();
    assert_eq!(state, "interrupted", "the injected stop is closed as an uncertain removal");
    assert!(snapshot.is_some() && reference.is_some(), "snapshot {snapshot:?} ref {reference:?}");
    // A Core that stopped is recovered as interrupted, never retried.
    lab.ws.stored(super::automatic::recover).await.unwrap();
    // The destructive step is simulated in the fixture; the snapshot and ref
    // alone bring it back.
    std::fs::remove_dir_all(&tree).unwrap();
    let back = lab.ws.collaboration_call(Some("lead"), "cleanup_restore", json!({"requestId":"r1","runId":run,"itemId":item})).await.unwrap();
    assert_eq!(back["state"], "restored");
    assert_eq!(back["runId"], run.as_str(), "an automatic answer names its run");
    assert!(back.get("planId").is_none(), "and no manual plan id");
    let retry = lab.ws.collaboration_call(Some("lead"), "cleanup_restore", json!({"requestId":"r1","runId":run,"itemId":item})).await.unwrap();
    assert_eq!((retry["state"].as_str(), retry["runId"].as_str()), (Some("restored"), Some(run.as_str())));
    assert_eq!(git(&tree, &["rev-parse", "HEAD"]), head);
    assert_eq!(std::fs::read_to_string(tree.join("notes/n.txt")).unwrap(), "snapshot before removal\n");
}

#[tokio::test]
async fn a_registered_worktree_inside_the_project_is_walked_for_rule_folders() {
    let lab = lab();
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.fresh_days = 0;
    });
    yn65_keep_days(&lab, 0);
    exclude(&lab, "node_modules/");
    let tree = worktree(&lab, &lab.project.join(".worktrees/inner"), "feat/inner");
    let modules = tree.join("node_modules");
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::write(tree.join("package.json"), "{\"name\":\"inner\"}").unwrap();
    std::fs::write(tree.join("package-lock.json"), "{}").unwrap();
    std::fs::write(modules.join("x.js"), "inner\n").unwrap();
    assert!(automatic(&lab).await >= 1);
    assert!(!modules.exists(), "a rule folder inside an in-Project worktree goes too");
}

#[tokio::test]
async fn an_automatic_restore_writes_the_item_s_task_activity() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/tasked"), "feat/tasked");
    let db = lab.ws.store.db.write().unwrap();
    let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
    db.execute("INSERT INTO task_workspaces(id,task_id,data) VALUES('w1',?1,?2)",
        params![task, json!({"id":"w1","path":tree}).to_string()]).unwrap();
    drop(db);
    assert!(automatic(&lab).await >= 1);
    assert!(!tree.exists());
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["task"], task, "the item carries the task");
    let (run, item_id): (String, String) = lab.ws.store.db.read().unwrap().query_row(
        "SELECT run_id,item_id FROM cleanup_automatic_items WHERE path=?1", [tree.to_string_lossy().as_ref()], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    lab.ws.collaboration_call(Some("lead"), "cleanup_restore", json!({"requestId":"r1","runId":run,"itemId":item_id})).await.unwrap();
    let comments: i64 = lab.ws.store.db.read().unwrap().query_row(
        "SELECT COUNT(*) FROM collaboration_task_activity WHERE task_id=?1 AND json_extract(data,'$.kind')='comment'
           AND json_extract(data,'$.body') LIKE 'Restored %'", [&task], |r| r.get(0)).unwrap();
    assert_eq!(comments, 1, "the task gets the restore line");
}

#[tokio::test]
async fn a_worktree_gitdir_directory_s_time_counts_as_activity() {
    let lab = lab();
    auto_settings(&lab, true, false, 7);
    let tree = worktree(&lab, &lab.home.join("work/wt/gitdir-time"), "feat/gitdir-time");
    let text = std::fs::read_to_string(tree.join(".git")).unwrap();
    let gitdir = std::fs::canonicalize(text.trim().strip_prefix("gitdir: ").unwrap()).unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 24 * 3600);
    // The worktree's own metadata files are ten days old; the gitdir itself
    // (its directory entry) was touched now.
    for relative in ["HEAD", "index", "commondir", "gitdir", "logs/HEAD", "ORIG_HEAD", "FETCH_HEAD"] {
        if let Ok(file) = std::fs::File::open(gitdir.join(relative)) {
            file.set_modified(old).unwrap();
        }
    }
    std::fs::File::open(tree.join(".git")).unwrap().set_modified(old).unwrap();
    assert!(automatic(&lab).await >= 1);
    assert!(tree.exists(), "the gitdir directory's own time is recent");
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["result"]["code"], "recent", "{item:#}");
}

#[test]
fn a_workspace_with_a_view_or_a_sqlite_prefixed_name_is_not_a_new_install() {
    let dir = tempfile::tempdir().unwrap();
    let view = dir.path().join("view.db");
    {
        let db = rusqlite::Connection::open(&view).unwrap();
        db.execute_batch("CREATE VIEW user_data AS SELECT 1 AS n;").unwrap();
    }
    let store = crate::store::Store::open(&view).unwrap();
    {
        let db = store.db.read().unwrap();
        assert!(!settings::read(&db).unwrap().rule_layer, "a view is a user schema: upgrade, off");
        assert_eq!(settings::initialization(&db).unwrap()["fresh"], false);
    }
    // "sqlite_" is escaped: a table named sqliteXuser is a user table, not an
    // internal sqlite_ one.
    let named = dir.path().join("named.db");
    {
        let db = rusqlite::Connection::open(&named).unwrap();
        db.execute_batch("CREATE TABLE sqliteXuser(id INTEGER);").unwrap();
    }
    let store = crate::store::Store::open(&named).unwrap();
    let db = store.db.read().unwrap();
    assert!(!settings::read(&db).unwrap().rule_layer, "sqliteXuser is a user table: upgrade, off");
    assert_eq!(settings::initialization(&db).unwrap()["fresh"], false);
}

#[tokio::test]
async fn a_renamed_removal_residue_is_never_a_new_item_after_recovery() {
    let lab = lab();
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.fresh_days = 0;
        c.worktree_keep_days = 0;
    });
    yn65_keep_days(&lab, 0);
    exclude(&lab, "ignored/");
    let parent = lab.project.join("ignored");
    std::fs::create_dir_all(&parent).unwrap();
    let original = parent.join(".pytest_cache");
    std::fs::create_dir_all(&original).unwrap();
    std::fs::write(original.join("CACHEDIR.TAG"), TAG_PYTEST).unwrap();
    std::fs::write(original.join("state"), "cache\n").unwrap();
    // The registry still names the path Core planned; remove_aside has already
    // renamed the object to the removal namespace.
    let residue = parent.join(".yuzuno-removing-test");
    std::fs::rename(&original, &residue).unwrap();
    let db = lab.ws.store.db.write().unwrap();
    let project: String = db.query_row("SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'", [], |r| r.get(0)).unwrap();
    db.execute("INSERT INTO cleanup_automatic_runs(id,project_id,machine,task_id,policy_version,params,state,started_at,data)
        VALUES('renamed',?1,'local',NULL,0,'{}','running','now','{}')", [&project]).unwrap();
    db.execute("INSERT INTO cleanup_automatic_items(run_id,item_id,seq,kind,path,state,evidence,pre,updated_at)
        VALUES('renamed','1',1,'cache-dir',?1,'removing','{}','{}','now')", [original.to_string_lossy().as_ref()]).unwrap();
    drop(db);
    lab.ws.stored(super::automatic::recover).await.unwrap();
    // Nothing at the residue's path is a new item, and the residue stays.
    let _ = automatic(&lab).await;
    assert!(residue.join("state").exists(), "the renamed object is left as it is");
    let at_residue: i64 = lab.ws.store.db.read().unwrap().query_row(
        "SELECT COUNT(*) FROM cleanup_automatic_items WHERE path=?1", [residue.to_string_lossy().as_ref()], |r| r.get(0)).unwrap();
    assert_eq!(at_residue, 0, "the removal namespace is never discovered as a candidate");
    // Execution refuses it too, even if a plan or a race names it directly.
    let settings = settings::read(&lab.ws.store.db.read().unwrap()).unwrap();
    let ctx = check::context(lab.ws.cleanup.env(), lab.ws.cleanup.mounts(), &lab.ws.data_dir, &lab.project.display().to_string(),
        Some(&project), &[], settings).await.unwrap();
    let item = check::Item { id: "r".into(), group: "g".into(), kind: "cache-dir".into(), rule: None,
        path: residue.display().to_string(), save_diff: false };
    let checked = check::preflight(&ctx, &item).await;
    assert_eq!(checked.refusal.map(|(code, _)| code), Some("removing"), "{:#}", checked.pre);
}

#[tokio::test]
async fn a_timed_out_worktree_is_deferred_and_does_not_starve_the_cache_stage() {
    let lab = lab();
    auto_settings(&lab, true, true, 0);
    yn65_keep_days(&lab, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/slow"), "feat/slow");
    let target = lab.project.join("target");
    cargo_target(&target, &["debug"]);
    // Deterministic injection: the first worktree candidate's Context is
    // already expired, and each stage admits one candidate.
    lab.ws.cleanup.stage_limit.store(1, std::sync::atomic::Ordering::SeqCst);
    lab.ws.cleanup.timeout_first_candidate.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = automatic(&lab).await;
    assert!(tree.exists(), "a timed-out worktree is not removed");
    assert!(!target.join("debug").exists(), "the cache stage still gets its own admission and runs");
    let worktree_item = auto_item(&lab, &tree).unwrap();
    assert_eq!(worktree_item["result"]["code"], "timeout", "{worktree_item:#}");
    let state: String = lab.ws.store.db.read().unwrap().query_row(
        "SELECT i.state FROM cleanup_automatic_items i WHERE i.path=?1 ORDER BY i.rowid DESC LIMIT 1",
        [tree.to_string_lossy().as_ref()], |r| r.get(0)).unwrap();
    assert_eq!(state, "deferred");
    let run: String = lab.ws.store.db.read().unwrap().query_row(
        "SELECT state FROM cleanup_automatic_runs WHERE id=(SELECT run_id FROM cleanup_automatic_items WHERE path=?1 ORDER BY rowid DESC LIMIT 1)",
        [tree.to_string_lossy().as_ref()], |r| r.get(0)).unwrap();
    assert_eq!(run, "incomplete");
}

#[tokio::test]
async fn the_cursor_stops_at_the_last_attempted_item_and_later_items_are_reached() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let first = worktree(&lab, &lab.home.join("work/wt/a-first"), "feat/first");
    let second = worktree(&lab, &lab.home.join("work/wt/b-second"), "feat/second");
    lab.ws.cleanup.stage_limit.store(1, std::sync::atomic::Ordering::SeqCst);
    lab.ws.cleanup.timeout_first_candidate.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = automatic(&lab).await;
    let db = lab.ws.store.db.read().unwrap();
    let project: String = db.query_row("SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'", [], |r| r.get(0)).unwrap();
    let cursor: String = db.query_row("SELECT last_key FROM cleanup_automatic_cursors WHERE project_id=?1 AND kind='worktree'", [&project], |r| r.get(0)).unwrap();
    assert_eq!(cursor, first.to_string_lossy(), "the cursor names the timed-out first candidate, not the array's last");
    drop(db);
    assert!(second.exists(), "the second candidate was never started");
    lab.ws.cleanup.stage_limit.store(0, std::sync::atomic::Ordering::SeqCst);
    lab.ws.cleanup.timeout_first_candidate.store(false, std::sync::atomic::Ordering::SeqCst);
    let _ = automatic(&lab).await;
    assert!(!second.exists(), "the next pass resumes at the unprocessed second candidate");
}

#[tokio::test]
async fn a_used_up_stage_budget_is_incomplete_without_starting_a_candidate() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/no-time"), "feat/no-time");
    *lab.ws.cleanup.stage_budget.lock().unwrap() = Some(std::time::Duration::ZERO);
    let _ = automatic(&lab).await;
    assert!(tree.exists(), "nothing starts when the stage has no admission time");
    let run: String = lab.ws.store.db.read().unwrap().query_row(
        "SELECT state FROM cleanup_automatic_runs WHERE project_id=(SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo')
           ORDER BY started_at DESC LIMIT 1", [], |r| r.get(0)).unwrap();
    assert_eq!(run, "incomplete");
}

#[tokio::test]
async fn each_candidate_gets_a_fresh_context_deadline() {
    let lab = lab();
    let project: String = lab.ws.store.db.read().unwrap()
        .query_row("SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo'", [], |r| r.get(0)).unwrap();
    let settings = settings::read(&lab.ws.store.db.read().unwrap()).unwrap();
    let ctx = check::context(lab.ws.cleanup.env(), lab.ws.cleanup.mounts(), &lab.ws.data_dir, &lab.project.display().to_string(),
        Some(&project), &[], settings).await.unwrap();
    let budget = std::time::Duration::from_secs(2);
    // An expired Context is reset: the deadline lies in [before + budget,
    // after + budget], whatever the scheduler does between the two reads.
    let mut expired = ctx.clone();
    expired.deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let before = std::time::Instant::now();
    let renewed = expired.renewed_with(budget);
    let after = std::time::Instant::now();
    assert!(before + budget <= renewed.deadline, "the deadline is at least before + budget");
    assert!(renewed.deadline <= after + budget, "and at most after + budget");
    assert!(renewed.deadline > expired.deadline, "the expired deadline was really reset");
}

#[tokio::test]
async fn recent_git_activity_keeps_a_worktree_after_an_old_release_and_the_check_does_not_touch_the_index_clock() {
    let lab = lab();
    auto_settings(&lab, true, false, 7);
    let tree = worktree(&lab, &lab.home.join("work/wt/manual-edit"), "feat/manual-edit");
    agent(&lab.ws, "old");
    let days = |n: i64| (chrono::Utc::now() - chrono::Duration::days(n)).to_rfc3339();
    let db = lab.ws.store.db.write().unwrap();
    let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
    db.execute("UPDATE agents SET data=json_set(data,'$.cwd',?1) WHERE id='old'", [tree.to_string_lossy().as_ref()]).unwrap();
    db.execute("INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at,archived_at)
        VALUES('old','executor','workspace-cleanup',?1,'agent:lead','released','now','now',?2)",
        params![task, days(10)]).unwrap();
    drop(db);
    let index = PathBuf::from(git(&tree, &["rev-parse", "--path-format=absolute", "--git-path", "index"]));
    let before = std::fs::metadata(&index).unwrap().modified().unwrap();
    assert!(automatic(&lab).await >= 1);
    assert!(tree.exists(), "recent Git activity is newer than the old release");
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["result"]["code"], "recent", "{item:#}");
    let after = std::fs::metadata(&index).unwrap().modified().unwrap();
    assert_eq!(before, after, "checking the age does not refresh the index clock");
}

#[tokio::test]
async fn cache_cursor_covers_multiple_roots_and_punctuation_over_repeated_rounds() {
    let lab = lab();
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.max_items = 1;
        c.fresh_days = 30; // every candidate is kept, so it comes back each round
    });
    exclude(&lab, "node_modules/");
    let mut expected: Vec<PathBuf> = Vec::new();
    for parent in ["a", "a-b", "b"] {
        let dir = lab.project.join(parent);
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("package.json"), "{\"name\":\"x\"}").unwrap();
        std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
        std::fs::write(dir.join("node_modules/x.js"), "x\n").unwrap();
        expected.push(std::fs::canonicalize(dir.join("node_modules")).unwrap());
    }
    // A second root: a registered worktree outside the Project folder.
    let tree = worktree(&lab, &lab.home.join("work/wt/root"), "feat/root");
    std::fs::create_dir_all(tree.join("node_modules")).unwrap();
    std::fs::write(tree.join("package.json"), "{\"name\":\"root\"}").unwrap();
    std::fs::write(tree.join("package-lock.json"), "{}").unwrap();
    std::fs::write(tree.join("node_modules/x.js"), "x\n").unwrap();
    expected.push(std::fs::canonicalize(tree.join("node_modules")).unwrap());
    for _ in 0..expected.len() {
        let _ = automatic(&lab).await;
    }
    let seen: Vec<PathBuf> = {
        let db = lab.ws.store.db.read().unwrap();
        let mut q = db.prepare("SELECT DISTINCT path FROM cleanup_automatic_items WHERE kind='cache-dir'").unwrap();
        q.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|p| PathBuf::from(p.unwrap())).collect()
    };
    let mut expected_sorted = expected.clone();
    expected_sorted.sort();
    let mut seen_sorted = seen.clone();
    seen_sorted.sort();
    assert_eq!(seen_sorted, expected_sorted, "every root and punctuation case is reached over rounds");
}

#[tokio::test]
async fn a_minimal_two_root_tag_cache_case_is_covered_by_the_sorted_cursor() {
    let lab = lab();
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.max_items = 1;
        c.fresh_days = 30; // kept every round, so the cursor has to advance past it
    });
    exclude(&lab, "cache/");
    let tagged = |dir: &Path| {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("CACHEDIR.TAG"), TAG_PYTEST).unwrap();
        std::fs::write(dir.join("state"), "cache\n").unwrap();
        std::fs::canonicalize(dir).unwrap()
    };
    let mut expected = vec![
        tagged(&lab.project.join("a/cache")),
        tagged(&lab.project.join("a-/cache")),
    ];
    for name in ["a-root", "z-root"] {
        let tree = worktree(&lab, &lab.home.join("work/wt").join(name), &format!("feat/{name}"));
        expected.push(tagged(&tree.join("cache")));
    }
    for _ in 0..expected.len() {
        let _ = automatic(&lab).await;
    }
    let mut seen: Vec<PathBuf> = {
        let db = lab.ws.store.db.read().unwrap();
        let mut q = db.prepare("SELECT DISTINCT path FROM cleanup_automatic_items WHERE kind='cache-dir'").unwrap();
        q.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|p| PathBuf::from(p.unwrap())).collect()
    };
    expected.sort();
    seen.sort();
    assert_eq!(seen, expected, "a-root/z-root and a/ vs a-/ are both reached over rounds");
}

fn inject_fault(lab: &Lab, point: &str, times: usize) {
    lab.ws.cleanup.faults.lock().unwrap().insert(point.to_owned(), times);
}

fn demo_run(lab: &Lab) -> (String, String) {
    let id = demo_run_id(lab);
    lab.ws.store.db.read().unwrap().query_row(
        "SELECT state,COALESCE(data,'{}') FROM cleanup_automatic_runs WHERE id=?1", [&id],
        |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
}

fn demo_run_id(lab: &Lab) -> String {
    lab.ws.store.db.read().unwrap().query_row(
        "SELECT id FROM cleanup_automatic_runs
          WHERE project_id=(SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo')
          ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0)).unwrap()
}

fn run_state(lab: &Lab, id: &str) -> String {
    lab.ws.store.db.read().unwrap().query_row("SELECT state FROM cleanup_automatic_runs WHERE id=?1", [id], |r| r.get(0)).unwrap()
}

#[tokio::test]
async fn a_read_error_after_begin_run_closes_the_ledger_as_failed() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    inject_fault(&lab, "read", 1);
    let _ = automatic(&lab).await;
    let (state, data) = demo_run(&lab);
    assert_eq!(state, "failed", "{data}");
    assert!(data.contains("injected fault: read") && data.contains("setup"), "{data}");
}

#[tokio::test]
async fn a_plan_write_error_interrupts_the_item_and_never_retries_it() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/plan-error"), "feat/plan-error");
    inject_fault(&lab, "plan", 1);
    let _ = automatic(&lab).await;
    assert!(tree.exists(), "nothing was removed");
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["result"]["code"], "interrupted", "{item:#}");
    assert_eq!(demo_run(&lab).0, "failed");
    // The next pass keeps the interrupted path and never deletes it again.
    let _ = automatic(&lab).await;
    assert!(tree.exists());
    let again = auto_item(&lab, &tree).unwrap();
    assert_eq!(again["result"]["code"], "interrupted", "{again:#}");
}

#[tokio::test]
async fn a_prepared_write_error_keeps_the_snapshot_and_ref_and_blocks_retry() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    exclude(&lab, "notes/");
    let tree = worktree(&lab, &lab.home.join("work/wt/prepared-error"), "feat/prepared-error");
    std::fs::create_dir_all(tree.join("notes")).unwrap();
    std::fs::write(tree.join("notes/n.txt"), "kept\n").unwrap();
    inject_fault(&lab, "prepared", 1);
    let _ = automatic(&lab).await;
    assert!(tree.exists(), "a failed prepared write never removes");
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["result"]["code"], "interrupted", "{item:#}");
    assert!(item["snapshot"].is_object() && item["ref"].is_string(), "{item:#}");
    let _ = automatic(&lab).await;
    assert!(tree.exists());
}

#[tokio::test]
async fn a_finish_record_error_after_removal_keeps_the_interrupted_evidence() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    exclude(&lab, "notes/");
    let tree = worktree(&lab, &lab.home.join("work/wt/finish-error"), "feat/finish-error");
    std::fs::create_dir_all(tree.join("notes")).unwrap();
    std::fs::write(tree.join("notes/n.txt"), "kept\n").unwrap();
    inject_fault(&lab, "finish_item", 1);
    let _ = automatic(&lab).await;
    assert!(!tree.exists(), "the removal had already happened");
    let item = auto_item(&lab, &tree).unwrap();
    assert_eq!(item["result"]["code"], "interrupted", "{item:#}");
    assert!(item["snapshot"].is_object() && item["ref"].is_string(), "{item:#}");
    let failed_run = demo_run_id(&lab);
    // A later pass must not redo an uncertain removal.
    let _ = automatic(&lab).await;
    assert!(!tree.exists());
    assert_eq!(run_state(&lab, &failed_run), "failed");
}

#[tokio::test]
async fn a_failed_finish_write_is_repaired_from_the_ledger_next_entry() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/finish-ledger"), "feat/finish-ledger");
    inject_fault(&lab, "finish_run", 1);
    let _ = automatic(&lab).await;
    assert!(!tree.exists());
    let finished_run = demo_run_id(&lab);
    assert_eq!(run_state(&lab, &finished_run), "running", "the body finished but its ledger did not");
    let _ = automatic(&lab).await;
    assert_eq!(run_state(&lab, &finished_run), "done", "the next entry repairs the old run's ledger");
}

#[tokio::test]
async fn a_failed_failure_write_is_repaired_next_entry_without_running_forever() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    inject_fault(&lab, "read", 1);
    inject_fault(&lab, "fail_run", 1);
    let _ = automatic(&lab).await;
    let failed_run = demo_run_id(&lab);
    assert_eq!(run_state(&lab, &failed_run), "running", "the failure could not be recorded yet");
    let _ = automatic(&lab).await;
    assert_eq!(run_state(&lab, &failed_run), "failed", "the next entry repairs the ledger only");
}

#[tokio::test]
async fn a_full_repair_queue_stops_new_runs_until_the_ledger_recovers() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    let tree = worktree(&lab, &lab.home.join("work/wt/backpressure"), "feat/backpressure");
    {
        let mut repairs = lab.ws.cleanup.repairs.lock().unwrap();
        for i in 0..100 {
            repairs.push(super::automatic::AutomaticRepair::Finished {
                run: format!("missing-{i}"), state: "done".into(), data: json!({}) });
        }
    }
    inject_fault(&lab, "repair", 20);
    let _ = automatic(&lab).await;
    assert!(tree.exists(), "no new run starts while the repair queue is full");
    let runs: i64 = lab.ws.store.db.read().unwrap().query_row(
        "SELECT COUNT(*) FROM cleanup_automatic_runs WHERE project_id=(SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo')",
        [], |r| r.get(0)).unwrap();
    assert_eq!(runs, 0, "the queue is not dropped and no run is admitted over it");
    assert_eq!(lab.ws.cleanup.repairs.lock().unwrap().len(), 100);
    // Storage recovers: the next entry repairs 20 and admits the run again.
    let _ = automatic(&lab).await;
    assert!(!tree.exists());
}

#[tokio::test]
async fn a_registered_worktree_under_the_removal_namespace_is_never_discovered() {
    let lab = lab();
    settings_change(&lab, |c| {
        c.worktree_reclaim = false;
        c.rule_layer = true;
        c.fresh_days = 0;
        c.max_items = 50;
    });
    yn65_keep_days(&lab, 0);
    exclude(&lab, "node_modules/");
    let tree = worktree(&lab, &lab.home.join("work/.yuzuno-removing-root/wt"), "feat/removing-root");
    let modules = tree.join("node_modules");
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::write(tree.join("package.json"), "{\"name\":\"x\"}").unwrap();
    std::fs::write(tree.join("package-lock.json"), "{}").unwrap();
    std::fs::write(modules.join("x.js"), "x\n").unwrap();
    let _ = automatic(&lab).await;
    assert!(modules.exists(), "no discovery inside the removal namespace");
    let items: i64 = lab.ws.store.db.read().unwrap().query_row(
        "SELECT COUNT(*) FROM cleanup_automatic_items WHERE path LIKE '%/.yuzuno-removing-%'", [], |r| r.get(0)).unwrap();
    assert_eq!(items, 0, "not even a refused automatic item is created there");
}

#[tokio::test]
async fn a_99_backlog_stops_after_one_project_and_never_passes_the_cap() {
    let lab = lab();
    auto_settings(&lab, true, false, 0);
    {
        let mut repairs = lab.ws.cleanup.repairs.lock().unwrap();
        for i in 0..99 {
            repairs.push(super::automatic::AutomaticRepair::Finished {
                run: format!("missing-{i}"), state: "done".into(), data: json!({}) });
        }
    }
    // Demo's body fails and its failure write fails: one repair (99 -> 100).
    // The old one-check-per-pass would then let Other add a second (101).
    inject_fault(&lab, "repair", 20); // keep the 99-repair backlog intact at this entry
    inject_fault(&lab, "read", 1);
    inject_fault(&lab, "fail_run", 2);
    let _ = automatic(&lab).await;
    assert_eq!(lab.ws.cleanup.repairs.lock().unwrap().len(), 100);
    let db = lab.ws.store.db.read().unwrap();
    let demo: i64 = db.query_row("SELECT COUNT(*) FROM cleanup_automatic_runs WHERE project_id=(SELECT id FROM projects WHERE json_extract(data,'$.name')='Demo')", [], |r| r.get(0)).unwrap();
    let other: i64 = db.query_row("SELECT COUNT(*) FROM cleanup_automatic_runs WHERE project_id=(SELECT id FROM projects WHERE json_extract(data,'$.name')='Other')", [], |r| r.get(0)).unwrap();
    assert_eq!((demo, other), (1, 0), "the remaining Project does not start once the cap is reached");
}
