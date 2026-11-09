//! YN-74 ③a (design 7, ③ items 1-4, and Lead mail 10772): each rule
//! recognizes its fixture and not one without its manifest; CACHEDIR.TAG
//! first, a forged one is none; `.venv` and Terraform only once a Project
//! turns them on; no file in a repository adds a rule; Cargo's target keeps
//! what Cargo didn't make; Core and the inventory script recognize the same
//! folders; a merge Git can't tell is never merged; only Core's own
//! inventory is an inventory.
use super::rules::{self, RULES};
use super::*;

/// Every rule on.
fn all() -> BTreeSet<&'static str> {
    rules::ids().into_iter().map(|(id, _)| id).collect()
}

fn touch(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// One fixture per rule: (rule, folder, what goes beside it, what goes in
/// it), and the same folder without what makes it the rule's.
fn fixtures() -> Vec<(&'static str, &'static str, Vec<(&'static str, &'static str)>, Vec<(&'static str, &'static str)>, Vec<(&'static str, &'static str)>)> {
    vec![
        ("node-modules", "node_modules", vec![("package.json", "{}"), ("package-lock.json", "{}")], vec![], vec![("package.json", "{}")]),
        ("node-framework", ".next", vec![("package.json", "{}")], vec![], vec![]),
        ("frontend-build", "dist", vec![("package.json", r#"{"scripts":{"build":"vite build"}}"#)], vec![], vec![("package.json", r#"{"scripts":{"test":"x"}}"#)]),
        ("python-cache", ".mypy_cache", vec![], vec![], vec![]),
        ("python-pycache", "__pycache__", vec![], vec![("a.cpython-312.pyc", "")], vec![]),
        ("python-tox", ".tox", vec![("tox.ini", "")], vec![], vec![]),
        ("python-venv", ".venv", vec![("uv.lock", "")], vec![("pyvenv.cfg", "home = /usr/bin")], vec![("uv.lock", "")]),
        ("maven", "target", vec![("pom.xml", "<project/>")], vec![], vec![]),
        ("gradle", "build", vec![("build.gradle.kts", "")], vec![], vec![]),
        ("dotnet", "obj", vec![("App.csproj", "<Project/>")], vec![], vec![]),
        ("swiftpm", ".build", vec![("Package.swift", "")], vec![], vec![]),
        ("dart", ".dart_tool", vec![("pubspec.yaml", "")], vec![], vec![]),
        ("elixir", "_build", vec![("mix.exs", "")], vec![], vec![]),
        ("haskell", "dist-newstyle", vec![("app.cabal", "")], vec![], vec![]),
        ("zig", "zig-out", vec![("build.zig", "")], vec![], vec![]),
        ("cmake", "out", vec![], vec![("CMakeCache.txt", ""), ("CMakeFiles/cmake.check_cache", "")], vec![]),
        ("unity", "Library", vec![("ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.0")], vec![], vec![]),
        ("unreal", "Intermediate", vec![("Game.uproject", "{}")], vec![], vec![]),
        ("godot", ".godot", vec![("project.godot", "")], vec![], vec![]),
        ("terraform", ".terraform", vec![("main.tf", "")], vec![], vec![]),
        ("node-compile-cache", "node-compile-cache", vec![], vec![], vec![]),
    ]
}

/// Builds every fixture below `root`: `<rule>/yes/<folder>` with what makes
/// it the rule's, `<rule>/no/<folder>` without it (or, for a rule by name
/// alone, by a name near it). Returns (rule, yes, no).
fn build(root: &Path) -> Vec<(&'static str, PathBuf, PathBuf)> {
    fixtures().into_iter().map(|(rule, name, beside, within, beside_without)| {
        let yes = root.join(rule).join("yes").join(name);
        // A rule by name alone has no folder without its manifest: a name near it is none.
        let no_name = if beside.is_empty() && within.is_empty() { format!("{name}-copy") } else { name.to_owned() };
        let no = root.join(rule).join("no").join(no_name);
        std::fs::create_dir_all(&yes).unwrap();
        std::fs::create_dir_all(&no).unwrap();
        for (file, text) in &beside {
            touch(&yes.parent().unwrap().join(file), text);
        }
        for (file, text) in &within {
            touch(&yes.join(file), text);
        }
        for (file, text) in &beside_without {
            touch(&no.parent().unwrap().join(file), text);
        }
        if rule == "python-pycache" {
            touch(&no.join("a.py"), "");
        }
        (rule, yes, no)
    }).collect()
}

#[test]
fn every_rule_recognizes_its_fixture_and_not_one_without_what_makes_it_the_rules() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let built = build(&root);
    assert_eq!(built.len(), RULES.len(), "a fixture for every ecosystem rule");
    let on = all();
    for (rule, yes, no) in &built {
        let scratch = *rule == "node-compile-cache";
        let found = check::recognize(yes, &on, !scratch, scratch).unwrap();
        assert_eq!(found.as_ref().map(|f| f.0), Some(*rule), "{rule}: {yes:?}");
        assert!(!found.unwrap().1.is_empty());
        let without = check::recognize(no, &on, !scratch, scratch).unwrap();
        assert_ne!(without.map(|f| f.0), Some(*rule), "{rule} without its manifest: {no:?}");
    }
    let (_, dist, _) = built.iter().find(|(r, _, _)| *r == "frontend-build").unwrap();
    assert_eq!(check::recognize(dist, &on, false, true).unwrap(), None, "dist outside Git: maybe a release");
    let (_, compile, _) = built.iter().find(|(r, _, _)| *r == "node-compile-cache").unwrap();
    assert_eq!(check::recognize(compile, &on, true, false).unwrap(), None, "node-compile-cache only in a scratch root");
    // Only the outermost node_modules.
    let (_, modules, _) = built.iter().find(|(r, _, _)| *r == "node-modules").unwrap();
    let inner = modules.join("left-pad/node_modules");
    std::fs::create_dir_all(&inner).unwrap();
    touch(&modules.join("left-pad/package.json"), "{}");
    touch(&modules.join("left-pad/package-lock.json"), "{}");
    assert_eq!(check::recognize(&inner, &on, true, false).unwrap(), None);
    assert!(rules::matches("*.egg-info", "demo.egg-info") && rules::matches("requirements*.txt", "requirements-dev.txt")
        && !rules::matches("*.csproj", "App.csproj.bak") && rules::matches("*", ""));
}

/// Review 939ed865 (P2): a scratch root's clone built in source holds
/// CMakeCache.txt beside its sources; there no Git check applies. A folder
/// holding .git is no rule's, and CMake's rule takes a build folder only.
#[test]
fn a_checkout_is_never_a_cache_and_an_in_source_cmake_build_is_none() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let on = all();
    let clone = root.join("scratch/clone");
    for file in ["CMakeLists.txt", "CMakeCache.txt", "CMakeFiles/cmake.check_cache", "src/main.c"] {
        touch(&clone.join(file), "");
    }
    assert_eq!(check::recognize(&clone, &on, false, true).unwrap(), None, "an in-source build is the sources");
    let build = clone.join("build");
    touch(&build.join("CMakeCache.txt"), "");
    touch(&build.join("CMakeFiles/cmake.check_cache"), "");
    assert_eq!(check::recognize(&build, &on, false, true).unwrap().map(|f| f.0), Some("cmake"), "its own build folder is one");
    // Whatever else is in it, a folder holding .git is no rule's.
    let tagged = root.join("t/cache");
    touch(&tagged.join("CACHEDIR.TAG"), TAG_PYTEST);
    let target = root.join("c/target");
    touch(&target.join("CACHEDIR.TAG"), TAG_CARGO);
    let next = root.join("n/.next");
    touch(&root.join("n/package.json"), "{}");
    let cmake = root.join("m/out");
    touch(&cmake.join("CMakeCache.txt"), "");
    touch(&cmake.join("CMakeFiles/x"), "");
    for folder in [&tagged, &target, &next, &cmake] {
        std::fs::create_dir_all(folder).unwrap();
        assert!(check::recognize(folder, &on, true, true).unwrap().is_some(), "{folder:?} is one before");
        std::fs::create_dir_all(folder.join(".git")).unwrap();
        assert_eq!(check::recognize(folder, &on, true, true).unwrap(), None, "{folder:?} holding .git");
    }
    touch(&build.join(".git"), "gitdir: /synthetic/elsewhere");
    assert_eq!(check::recognize(&build, &on, false, true).unwrap(), None, "a .git file, as a worktree has, too");
}

#[tokio::test]
async fn a_scratch_root_s_clone_is_never_rebuildable_in_a_plan() {
    let lab = lab();
    let built = lab.scratch.join("job-7/clone");
    for file in ["CMakeLists.txt", "CMakeCache.txt", "CMakeFiles/cmake.check_cache", "src/main.c"] {
        touch(&built.join(file), "");
    }
    let repo = lab.scratch.join("job-8/web");
    touch(&repo.join("CACHEDIR.TAG"), TAG_PYTEST);
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    let plan = submit(&lab, "clones", vec![group("r", "rebuildable")], vec![
        item("built", "r", "cache-dir", &built), item("repo", "r", "cache-dir", &repo)]).await;
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "built"), "noRule");
    assert_eq!(refused(&states, "repo"), "noRule");
    assert!(built.join("src/main.c").exists() && repo.join(".git").exists());
}

#[test]
fn a_cachedir_tag_comes_first_and_a_forged_one_is_none() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let on = all();
    // Cargo's tag beside a pom.xml: the cargo rule, not Maven's.
    let target = root.join("both/target");
    touch(&target.join("CACHEDIR.TAG"), TAG_CARGO);
    touch(&root.join("both/pom.xml"), "<project/>");
    assert_eq!(check::recognize(&target, &on, true, false).unwrap().map(|f| f.0), Some("cargo"));
    // pytest's tag: the whole folder, by cachedir-tag.
    let pytest = root.join("p/.pytest_cache");
    touch(&pytest.join("CACHEDIR.TAG"), TAG_PYTEST);
    assert_eq!(check::recognize(&pytest, &on, true, false).unwrap().map(|f| f.0), Some("cachedir-tag"));
    // A tag without the signature is none; the folder goes by its own rule or by none.
    let forged = root.join("f/cache");
    touch(&forged.join("CACHEDIR.TAG"), "Signature: 0000\n");
    assert_eq!(check::recognize(&forged, &on, true, false).unwrap(), None);
    let next = root.join("n/.next");
    touch(&next.join("CACHEDIR.TAG"), "Signature: 0000\n");
    touch(&root.join("n/package.json"), "{}");
    assert_eq!(check::recognize(&next, &on, true, false).unwrap().map(|f| f.0), Some("node-framework"));
    // Off, a tag's rule says so.
    let mut off = on.clone();
    off.remove(rules::CACHEDIR_TAG);
    assert_eq!(check::recognize(&pytest, &off, true, false), Err(rules::CACHEDIR_TAG));
}

#[test]
fn venv_and_terraform_are_off_until_a_project_turns_them_on_and_each_rule_can_be_turned_off() {
    let mut settings = Settings::default();
    let defaults = rules::enabled(&settings, Some("p1"));
    assert!(!defaults.contains("python-venv") && !defaults.contains("terraform"));
    assert!(defaults.contains("cargo") && defaults.contains("node-modules") && defaults.contains(rules::CACHEDIR_TAG));
    assert_eq!(defaults.len(), rules::ids().len() - 2, "every other rule is on by default");
    settings.rules.insert("node-modules".into(), false);
    settings.project_rules.insert("p1".into(), BTreeMap::from([("python-venv".to_owned(), true), ("node-modules".to_owned(), true)]));
    let p1 = rules::enabled(&settings, Some("p1"));
    assert!(p1.contains("python-venv") && p1.contains("node-modules"), "a Project's own switch over this host's");
    let p2 = rules::enabled(&settings, Some("p2"));
    assert!(!p2.contains("python-venv") && !p2.contains("node-modules"), "another Project: this host's switch");
    let dir = tempfile::tempdir().unwrap();
    let venv = std::fs::canonicalize(dir.path()).unwrap().join(".venv");
    touch(&venv.join("pyvenv.cfg"), "home = /usr/bin");
    touch(&dir.path().join("requirements.txt"), "");
    assert_eq!(check::recognize(&venv, &p2, true, false), Err("python-venv"), "off: the rule is named");
    assert_eq!(check::recognize(&venv, &p1, true, false).unwrap().map(|f| f.0), Some("python-venv"));
    let table = rules::table(&p1);
    let ids: Vec<&str> = table["rules"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"python-venv") && !ids.contains(&"terraform"), "the script gets the rules on: {ids:?}");
    assert_eq!((table["cargo"].as_bool(), table["cachedirTag"].as_bool()), (Some(true), Some(true)));
}

#[test]
fn settings_switch_known_rules_only() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let db = ws.store.db.write().unwrap();
    let change = |rules: BTreeMap<String, bool>, projects: BTreeMap<String, BTreeMap<String, bool>>, version: i64| settings::Change {
        protected_paths: vec![], scratch_roots: vec![], max_items: 10, plan_hours: 24, summary_paths: 10, fresh_days: 1, evidence_days: 7,
        snapshot_max_mib: 256, evidence_file_mib: 4, evidence_suffixes: vec![], snapshot_days: 30, rules: Some(rules),
        project_rules: Some(projects), expected_version: version,
    };
    let bogus = settings::change(&db, change(BTreeMap::from([("bogus".into(), true)]), BTreeMap::new(), 0)).unwrap_err().to_string();
    assert!(bogus.starts_with("invalid_input: rules names no rule \"bogus\""), "{bogus}");
    let per = BTreeMap::from([("p1".to_owned(), BTreeMap::from([("terraform".to_owned(), true), ("nope".to_owned(), false)]))]);
    assert!(settings::change(&db, change(BTreeMap::new(), per, 0)).unwrap_err().to_string().contains("projectRules.p1 names no rule \"nope\""));
    let saved = settings::change(&db, change(BTreeMap::from([("cargo".into(), false)]), BTreeMap::from([("p1".to_owned(),
        BTreeMap::from([("terraform".to_owned(), true)]))]), 0)).unwrap();
    assert_eq!((saved.rules.get("cargo"), saved.project_rules["p1"].get("terraform")), (Some(&false), Some(&true)));
    // A change that names neither keeps both.
    let mut kept = change(BTreeMap::new(), BTreeMap::new(), saved.version);
    (kept.rules, kept.project_rules) = (None, None);
    let again = settings::change(&db, kept).unwrap();
    assert_eq!((again.rules, again.project_rules), (saved.rules, saved.project_rules));
    assert_eq!(settings::overview(&db).unwrap()["rules"].as_array().unwrap().len(), rules::ids().len());
}

#[tokio::test]
async fn in_a_plan_a_rule_file_in_the_repository_adds_nothing_and_a_rule_off_says_so() {
    let lab = lab();
    std::fs::write(lab.project.join(".gitignore"), "target/\n.worktrees/\nnode_modules/\nassets/\n.venv/\n").unwrap();
    // A repository's own "rule" naming its assets folder: no rule reads it.
    touch(&lab.project.join(".yuzuno-cleanup.json"), r#"{"rules":[{"name":"assets","default":true}]}"#);
    touch(&lab.project.join("assets/logo.png"), "png");
    let app = lab.project.join("app");
    touch(&app.join("package.json"), "{}");
    touch(&app.join("node_modules/left-pad/index.js"), "");
    let locked = lab.project.join("web");
    touch(&locked.join("package.json"), "{}");
    touch(&locked.join("package-lock.json"), "{}");
    touch(&locked.join("node_modules/left-pad/index.js"), "");
    touch(&lab.project.join(".venv/pyvenv.cfg"), "home = /usr/bin");
    touch(&lab.project.join("requirements.txt"), "");
    let plan = submit(&lab, "rules", vec![group("r", "rebuildable")], vec![
        item("assets", "r", "cache-dir", &lab.project.join("assets")),
        item("bare", "r", "cache-dir", &app.join("node_modules")),
        item("locked", "r", "cache-dir", &locked.join("node_modules")),
        item("venv", "r", "cache-dir", &lab.project.join(".venv")),
    ]).await;
    let states = item_states(&lab, &plan).await;
    assert_eq!(refused(&states, "assets"), "noRule");
    assert_eq!(refused(&states, "bare"), "noRule", "node_modules without a lockfile");
    pending(&states, "locked");
    assert_eq!(refused(&states, "venv"), "ruleOff", "off by default");
    let items = items_of(&lab, &plan).await;
    let locked = items.iter().find(|i| i["item"] == "locked").unwrap();
    assert_eq!(locked["rule"], "node-modules", "{locked}");
}

/// Cargo's target (design 7 ③ item 2): a whole profile, one left half
/// removed, a target triple's, doc, package and tmp go; what Cargo didn't
/// make, and a profile holding something of someone's, stay; and Cargo's own
/// top-level files with the folder itself.
#[tokio::test]
async fn cargo_s_target_keeps_what_cargo_did_not_make_and_takes_a_half_profile() {
    let lab = lab();
    gated(&lab);
    let target = lab.project.join("target");
    cargo_target(&target, &["debug", "x86_64-unknown-linux-gnu/release"]);
    // A profile left half removed: its lock gone, its fingerprints there.
    touch(&target.join("release/.fingerprint/a/dep-lib"), "");
    touch(&target.join("release/deps/libx.rlib"), "rlib");
    for named in ["doc/demo/index.html", "package/demo-0.1.0.crate", "tmp/x"] {
        touch(&target.join(named), "made by cargo");
    }
    touch(&target.join("notes/benchmarks.md"), "someone's");
    cargo_target(&target, &["bench"]);
    touch(&target.join("bench/report.html"), "someone's");
    let (subtrees, kept) = check::cargo_profiles(&target);
    let names: Vec<(&str, &str)> = subtrees.iter().map(|s| (s["name"].as_str().unwrap(), s["kind"].as_str().unwrap())).collect();
    assert_eq!(names, [("debug", "profile"), ("doc", "named"), ("package", "named"), ("release", "profile"), ("tmp", "named"),
        ("x86_64-unknown-linux-gnu", "triple")]);
    assert_eq!(kept, ["bench", "notes"]);
    let plan = submit(&lab, "cargo", vec![group("r", "rebuildable")], vec![item("target", "r", "cache-dir", &target)]).await;
    assert_eq!(plan["refused"], 0, "{plan:#}");
    ask(&lab, "gates/cleanup", "ex", 4, &naming(&plan), &["r"]);
    reply(&lab, "gates/cleanup", &["r"], None);
    apply_as(&lab, "ex", "go", &plan, "gates/cleanup", &[]).await.unwrap();
    let done = applied(&lab, &plan).await;
    assert_eq!(done["applied"]["removed"], 1, "{done:#}");
    for gone in ["debug", "release", "x86_64-unknown-linux-gnu", "doc", "package", "tmp"] {
        assert!(!target.join(gone).exists(), "{gone} went");
    }
    for stays in ["notes/benchmarks.md", "bench/report.html", "CACHEDIR.TAG"] {
        assert!(target.join(stays).exists(), "{stays} stays");
    }
}

/// Lead mail 10772: a merge Git can't tell is not known, never merged, and
/// the user is told.
#[tokio::test]
async fn a_merge_git_cannot_tell_is_never_clean_and_merged() {
    let lab = lab();
    let tree = worktree(&lab, &lab.home.join("wt/unknown"), "feat/unknown");
    git(&lab.project, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone"]);
    let plan = submit(&lab, "unknown", vec![group("d", "delete")], vec![item("wt", "d", "worktree", &tree)]).await;
    let items = items_of(&lab, &plan).await;
    let wt = items.iter().find(|i| i["item"] == "wt").unwrap();
    assert!(wt["worktree"]["merged"].is_null(), "{wt}");
    assert_eq!(wt["category"], "other");
    let warnings = plan["groups"][0]["summary"]["warnings"].as_array().cloned().unwrap_or_default();
    assert!(warnings.iter().any(|w| w["code"] == "mergeUnknown"), "{}", plan["groups"][0]["summary"]);
}

/// Lead mail 10772: a plan's inventory, and a retry of cleanup_inventory,
/// is only a Job Core took with its own command of this Project's folder.
#[tokio::test]
async fn only_core_s_own_inventory_is_an_inventory() {
    let lab = lab();
    {
        let db = lab.ws.store.db.write().unwrap();
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        // The executor's own Job, named and placed as an inventory would be, but its command is its own.
        let forged = json!({"id": "forged", "taskId": task, "agentId": "ex", "attempt": ATTEMPT, "status": "succeeded", "target": {"kind": "local"},
            "name": inventory::JOB_NAME, "argv": ["/usr/bin/python3", "-c", "print(1)", "--project", lab.project, "--out", "out/inventory.json"],
            "result": {"attempt": ATTEMPT, "artifacts": [{"path": "out/inventory.json", "sha256": "c".repeat(64), "ok": true, "bytes": 2}]}});
        db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('forged',?1,'ex','succeeded',?2)", params![task, forged.to_string()]).unwrap();
        // Core's own command, but of another folder.
        let elsewhere = inventory::command("/usr/bin/python3", "/synthetic/elsewhere", &[], &[], &json!({}), "out/inventory.json");
        let other = json!({"id": "other-folder", "taskId": task, "agentId": "ex", "attempt": ATTEMPT, "status": "succeeded", "target": {"kind": "local"},
            "name": inventory::JOB_NAME, "argv": elsewhere,
            "result": {"attempt": ATTEMPT, "artifacts": [{"path": "out/inventory.json", "sha256": "d".repeat(64), "ok": true, "bytes": 2}]}});
        db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('other-folder',?1,'ex','succeeded',?2)", params![task, other.to_string()]).unwrap();
        // The executor submitted it itself, under the requestId cleanup_inventory would use.
        db.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES('agent:ex','job_submit','cleanup-inventory/x',?1,?2)",
            params![json!({"name": inventory::JOB_NAME, "taskId": task}).to_string(), json!({"jobId": "forged"}).to_string()]).unwrap();
    }
    for (job, sha) in [("forged", "c"), ("other-folder", "d")] {
        let mut input = plan_input(&format!("from-{job}"), vec![group("g", "delete")], vec![item("e", "g", "entry", &lab.scratch.join("e"))]);
        input["inventory"] = json!({"jobId": job, "attempt": ATTEMPT, "path": "out/inventory.json", "sha256": sha.repeat(64)});
        let error = submit_as(&lab, Some("ex"), input).await.unwrap_err().to_string();
        assert!(error.starts_with("invalid_input: inventory: Job") && error.contains("cleanup_inventory"), "{job}: {error}");
    }
    let retry = lab.ws.collaboration_call(Some("ex"), "cleanup_inventory", json!({"requestId": "x", "taskId": "T-1"})).await.unwrap_err().to_string();
    assert!(retry.starts_with("idempotency_conflict:"), "{retry}");
    // Python before 3.4 refuses -I before it runs anything: too old, said so.
    let old = inventory::read_probe(Some(2), b"", "Unknown option: -I\nusage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...").unwrap_err();
    assert!(old.starts_with("python3 on this Core's host is older than 3.4: it doesn't know -I"), "{old}");
}

/// YN-74 ③a (design 3.1): Core and the inventory script recognize the same
/// folders, by the same table: each rule's fixture and its fixture without
/// what makes it the rule's, in a Git checkout and in a scratch root.
#[test]
fn core_and_the_script_recognize_the_same_folders() {
    let lab = lab();
    let tree = lab.project.join("eco");
    let built = build(&tree);
    let compile = lab.scratch.join("job-9/node-compile-cache");
    std::fs::create_dir_all(&compile).unwrap();
    // Near misses in a scratch root, where no Git check applies: an in-source CMake build and a clone.
    for file in ["CMakeLists.txt", "CMakeCache.txt", "CMakeFiles/x", "src/main.c"] {
        touch(&lab.scratch.join("job-9/clone").join(file), "");
    }
    touch(&lab.scratch.join("job-9/repo/CACHEDIR.TAG"), TAG_PYTEST);
    std::fs::create_dir_all(lab.scratch.join("job-9/repo/.git")).unwrap();
    let on: BTreeSet<&'static str> = rules::ids().into_iter().map(|(id, _)| id).collect();
    let argv = inventory::command("python3", &lab.project.display().to_string(), &[lab.scratch.display().to_string()], &[],
        &rules::table(&on), "out.json");
    let out = lab.root().join("out.json");
    let done = std::process::Command::new("python3").args(&argv[1..]).current_dir(lab.root()).output().unwrap();
    assert!(done.status.success(), "{}", String::from_utf8_lossy(&done.stderr));
    let file: Value = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    let script: BTreeMap<String, String> = file["cacheDirs"].as_array().unwrap().iter()
        .map(|c| (c["path"].as_str().unwrap().to_owned(), c["rule"].as_str().unwrap().to_owned())).collect();
    let mut core = BTreeMap::new();
    for (_, yes, no) in &built {
        for dir in [yes, no] {
            if let Ok(Some((rule, _))) = check::recognize(dir, &on, true, false) {
                core.insert(dir.display().to_string(), rule.to_owned());
            }
        }
    }
    if let Ok(Some((rule, _))) = check::recognize(&compile, &on, false, true) {
        core.insert(compile.display().to_string(), rule.to_owned());
    }
    let script: BTreeMap<String, String> = script.into_iter().filter(|(p, _)| p.starts_with(&tree.display().to_string()) || p.contains("job-9")).collect();
    assert_eq!(script, core, "the script and Core recognize the same folders, by the same rules");
    assert_eq!(core.len(), built.len(), "each rule's fixture, and only it: {core:#?}");
}

/// Lead activity 8080 P2-1: "only .pyc" is never proven by a prefix. Over
/// its cap, or with an entry it can't read, a folder is not one.
#[test]
fn a_pycache_over_its_cap_is_never_only_pyc_files() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("__pycache__");
    for name in ["a.pyc", "b.pyc", "c.pyc", "d.pyc"] {
        touch(&cache.join(name), "");
    }
    assert!(rules::only_files_ending(&cache, ".pyc", 10), "four .pyc files under a cap of ten");
    assert!(!rules::only_files_ending(&cache, ".pyc", 3), "four entries over a cap of three: not proven, so not one");
    touch(&cache.join("notes.txt"), "mine");
    assert!(!rules::only_files_ending(&cache, ".pyc", 10));
    std::fs::remove_file(cache.join("notes.txt")).unwrap();
    std::os::unix::fs::symlink("/synthetic/elsewhere.pyc", cache.join("e.pyc")).unwrap();
    assert!(!rules::only_files_ending(&cache, ".pyc", 10), "a link is no compiled file");
}

/// Lead activity 8080 P2-2: of Cargo's target, a subtree that holds a Git
/// working tree or repository (doc, package, tmp or build by name) stays.
#[tokio::test]
async fn cargo_s_named_subtrees_holding_git_stay() {
    let lab = lab();
    gated(&lab);
    let target = lab.project.join("target");
    cargo_target(&target, &["debug"]);
    // tmp is a clone of its own, with work not pushed anywhere.
    touch(&target.join("tmp/.git/HEAD"), "ref: refs/heads/main\n");
    touch(&target.join("tmp/unpushed.rs"), "fn mine() {}");
    // doc holds a worktree's .git file.
    touch(&target.join("doc/.git"), "gitdir: /synthetic/elsewhere/.git/worktrees/doc");
    touch(&target.join("doc/notes.md"), "mine");
    touch(&target.join("package/demo-0.1.0.crate"), "made by cargo");
    let (subtrees, kept) = check::cargo_profiles(&target);
    let names: Vec<&str> = subtrees.iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["debug", "package"], "{subtrees:?}");
    assert_eq!(kept, ["doc", "tmp"]);
    let plan = submit(&lab, "git-in-target", vec![group("r", "rebuildable")], vec![item("target", "r", "cache-dir", &target)]).await;
    assert_eq!(plan["refused"], 0, "{plan:#}");
    ask(&lab, "gates/cleanup", "ex", 4, &naming(&plan), &["r"]);
    reply(&lab, "gates/cleanup", &["r"], None);
    apply_as(&lab, "ex", "go", &plan, "gates/cleanup", &[]).await.unwrap();
    applied(&lab, &plan).await;
    assert!(!target.join("debug").exists() && !target.join("package").exists());
    for stays in ["tmp/.git/HEAD", "tmp/unpushed.rs", "doc/.git", "doc/notes.md"] {
        assert!(target.join(stays).exists(), "{stays} stays");
    }
}

/// Lead activity 8080 P2-2, the snapshot: a worktree's snapshot keeps what
/// Cargo didn't make in its target (and a clone there), skipping only
/// Cargo's own subtrees, since a reclaimed worktree goes whole.
#[tokio::test]
async fn a_worktree_snapshot_keeps_what_cargo_did_not_make_in_its_target() {
    let lab = lab();
    let tree = worktree(&lab, &lab.home.join("wt/cargo"), "feat/cargo");
    let target = tree.join("target");
    cargo_target(&target, &["debug"]);
    touch(&target.join("notes/report.md"), "someone's");
    touch(&target.join("tmp/.git/HEAD"), "ref: refs/heads/main\n");
    touch(&target.join("tmp/work.txt"), "unpushed");
    let keep = worktrees::keep_list(&tree, &all()).await.unwrap();
    for kept in ["target/notes/report.md", "target/tmp/work.txt", "target/tmp/.git/HEAD"] {
        assert!(keep.files.iter().any(|f| f == kept), "{kept} is kept: {:?}", keep.files);
    }
    assert!(!keep.files.iter().any(|f| f.starts_with("target/debug/")), "Cargo's profile is rebuildable: {:?}", keep.files);
}

/// Lead activity 8080 P2-3: an inventory is one only when Core's own
/// cleanup_inventory started it. A Job of the task with Core's very command,
/// or with a second --project after it, is none.
#[tokio::test]
async fn a_job_with_core_s_command_that_core_did_not_start_is_no_inventory() {
    let lab = lab();
    {
        let db = lab.ws.store.db.write().unwrap();
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        let exact = inventory::command("/usr/bin/python3", &lab.project.display().to_string(), &[], &[], &json!({}), "out/inventory.json");
        let mut twice = exact.clone();
        let at = twice.len() - 2;
        twice.splice(at..at, ["--project".to_owned(), "/synthetic/other".to_owned()]);
        for (id, argv, sha) in [("copied", exact, "e"), ("twice", twice, "f")] {
            let data = json!({"id": id, "taskId": task, "agentId": "ex", "attempt": ATTEMPT, "status": "succeeded", "target": {"kind": "local"},
                "name": inventory::JOB_NAME, "argv": argv,
                "result": {"attempt": ATTEMPT, "artifacts": [{"path": "out/inventory.json", "sha256": sha.repeat(64), "ok": true, "bytes": 2}]}});
            db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'ex','succeeded',?3)", params![id, task, data.to_string()]).unwrap();
        }
    }
    for (job, sha) in [("copied", "e"), ("twice", "f")] {
        let mut input = plan_input(&format!("from-{job}"), vec![group("g", "delete")], vec![item("e", "g", "entry", &lab.scratch.join("e"))]);
        input["inventory"] = json!({"jobId": job, "attempt": ATTEMPT, "path": "out/inventory.json", "sha256": sha.repeat(64)});
        let error = submit_as(&lab, Some("ex"), input).await.expect_err(&format!("a plan from {job} is refused")).to_string();
        assert!(error.starts_with("invalid_input: inventory:"), "{job}: {error}");
    }
}

/// Lead activity 8080 P2-3: even with a record, a Job whose command names a
/// second --project is no inventory; and a retry after a job_submit whose
/// answer was lost before its record named the Job names it then.
#[tokio::test]
async fn core_s_record_binds_one_folder_and_a_lost_answer_is_named_on_retry() {
    let lab = lab();
    {
        let db = lab.ws.store.db.write().unwrap();
        let (task, _) = collaboration::task_key(&db, "T-1").unwrap();
        let mut twice = inventory::command("/usr/bin/python3", &lab.project.display().to_string(), &[], &[], &json!({}), "out/inventory.json");
        let at = twice.len() - 2;
        twice.splice(at..at, ["--project".to_owned(), "/synthetic/other".to_owned()]);
        let data = json!({"id": "twice", "taskId": task, "agentId": "ex", "attempt": ATTEMPT, "status": "succeeded", "target": {"kind": "local"},
            "name": inventory::JOB_NAME, "argv": twice,
            "result": {"attempt": ATTEMPT, "artifacts": [{"path": "out/inventory.json", "sha256": "f".repeat(64), "ok": true, "bytes": 2}]}});
        db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('twice',?1,'ex','succeeded',?2)", params![task, data.to_string()]).unwrap();
        db.execute("INSERT INTO cleanup_inventories(actor,request_id,task_id,machine,folder,identity,job_id,created_at) VALUES('ex','cleanup-inventory/twice',?1,'local',?2,?3,'twice','now')",
            params![task, lab.project.display().to_string(), inventory::identity(&data)]).unwrap();
        // The lab's own inventory `inv`, as if its job_submit answered but the record never learned its Job.
        db.execute("UPDATE cleanup_inventories SET job_id=NULL WHERE job_id='inv'", []).unwrap();
        db.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES('agent:ex','job_submit','cleanup-inventory/inv',?1,?2)",
            params![json!({"name": inventory::JOB_NAME, "taskId": task}).to_string(), json!({"jobId": "inv"}).to_string()]).unwrap();
    }
    let mut input = plan_input("from-twice", vec![group("g", "delete")], vec![item("e", "g", "entry", &lab.scratch.join("e"))]);
    input["inventory"] = json!({"jobId": "twice", "attempt": ATTEMPT, "path": "out/inventory.json", "sha256": "f".repeat(64)});
    let error = submit_as(&lab, Some("ex"), input).await.unwrap_err().to_string();
    assert!(error.starts_with("invalid_input: inventory: Job twice is not the inventory"), "{error}");
    // Not named yet: no plan takes it.
    let unnamed = submit_as(&lab, Some("ex"), plan_input("before", vec![group("g", "delete")], vec![item("e", "g", "entry", &lab.scratch.join("e"))]))
        .await.unwrap_err().to_string();
    assert!(unnamed.starts_with("invalid_input: inventory: Job inv is no inventory"), "{unnamed}");
    // Its retry finds the Job and names it; then a plan takes it.
    let again = lab.ws.collaboration_call(Some("ex"), "cleanup_inventory", json!({"requestId": "inv", "taskId": "T-1"})).await.unwrap();
    assert_eq!(again["jobId"], "inv", "{again}");
    submit(&lab, "after", vec![group("g", "delete")], vec![item("e", "g", "entry", &lab.scratch.join("e"))]).await;
}
