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
        inventory_job(&db, &task, "inv", json!({"kind": "local"}));
    }
    let lab = Lab { dir, ws, home, project, scratch };
    settings_change(&lab, |c| {
        c.scratch_roots = vec![lab.scratch.display().to_string()];
        c.fresh_days = 0;
        c.evidence_days = 0;
    });
    lab
}

fn inventory_job(db: &Connection, task: &str, id: &str, target: Value) {
    let data = json!({"id":id,"taskId":task,"agentId":"ex","attempt":ATTEMPT,"status":"succeeded","target":target,
        "machine":{"name":"Synthetic host"},
        "result":{"attempt":ATTEMPT,"artifacts":[{"path":"out/inventory.json","sha256":"b".repeat(64),"ok":true,"bytes":12}]}});
    db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'ex','succeeded',?3)", params![id, task, data.to_string()])
        .unwrap();
}

fn settings_change(lab: &Lab, edit: impl FnOnce(&mut Settings)) {
    let db = lab.ws.store.db.write().unwrap();
    let mut s = settings::read(&db).unwrap();
    edit(&mut s);
    settings::change(&db, settings::Change {
        protected_paths: s.protected_paths, scratch_roots: s.scratch_roots, max_items: s.max_items, plan_hours: s.plan_hours,
        summary_paths: s.summary_paths, fresh_days: s.fresh_days, evidence_days: s.evidence_days, snapshot_max_mib: s.snapshot_max_mib,
        evidence_file_mib: s.evidence_file_mib, evidence_suffixes: s.evidence_suffixes, expected_version: s.version,
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
    let read = lab.ws.collaboration_call(None, "cleanup_plan_get", json!({"planId": newer["planId"]})).await.unwrap();
    assert_eq!(read["state"], "expired");
}

#[tokio::test]
async fn its_executor_a_lead_and_the_user_read_it_and_items_come_in_pages() {
    let lab = lab();
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
        inventory_job(&db, &task, "inv", json!({"kind": "ssh", "machineId": "m1"}));
    }
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
        evidence_suffixes: vec![".PNG".into(), "png".into()], expected_version: version,
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
