use super::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<std::ffi::OsString> {
    let pairs: Vec<(String, String)> = pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    move |name: &str| pairs.iter().find(|(n, _)| n == name).map(|(_, v)| v.into())
}

/// Git on `store` with `work` as its work tree, as OpenCode runs it on its
/// own snapshot store.
fn run(store: &Path, work: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .current_dir(work)
        .arg("--git-dir")
        .arg(store)
        .arg("--work-tree")
        .arg(work)
        .args(["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "core.symlinks=true"])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

/// A snapshot of `work` as OpenCode takes one (`Snapshot.track`: everything
/// added to its own store's index, then the tree written): the tree's ID.
fn track(store: &Path, work: &Path) -> String {
    if !store.exists() {
        run(store, work, &["init", "-q"]);
        // As OpenCode sets up its store (`snapshot/index.ts`).
        run(store, work, &["config", "core.autocrlf", "false"]);
    }
    run(store, work, &["add", "-A", "."]);
    run(store, work, &["write-tree"]).trim().to_owned()
}

/// Every file in `dir`: its path, size and modification time.
fn listing(dir: &Path) -> Vec<(PathBuf, u64, Option<u128>)> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(at) = stack.pop() {
        for entry in fs::read_dir(&at).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.is_dir() {
                stack.push(path);
            } else {
                found.push((path, metadata.len(), super::modified(&metadata)));
            }
        }
    }
    found.sort();
    found
}

/// What these tests give OpenCode's own Git beyond their environment: no global or system configuration of
/// whoever runs them.
static HERMETIC: std::sync::LazyLock<Vec<(String, String)>> =
    std::sync::LazyLock::new(|| vec![("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()), ("GIT_CONFIG_NOSYSTEM".into(), "1".into())]);

fn file(bytes: &[u8], executable: bool) -> State {
    State::File { size: bytes.len() as u64, sha256: sha256(bytes), executable }
}

#[test]
fn roots_are_worked_out_from_the_environment_as_opencode_works_them_out() {
    let roots = Roots::of(env(&[("HOME", "/home/u/")]), || None).unwrap();
    assert_eq!(roots, Roots {
        home: "/home/u/".into(),
        data: "/home/u/.local/share/opencode".into(),
        state: "/home/u/.local/state/opencode".into(),
        config: "/home/u/.config/opencode".into(),
    }, "os.homedir() as it is; xdg-basedir's folders joined as path.join does");
    let roots = Roots::of(env(&[("HOME", "/h"), ("XDG_DATA_HOME", "/x/data/"), ("XDG_STATE_HOME", ""), ("XDG_CONFIG_HOME", "/c/./d/../e")]), || None).unwrap();
    assert_eq!((roots.data.as_str(), roots.state.as_str(), roots.config.as_str()),
        ("/x/data/opencode", "/h/.local/state/opencode", "/c/e/opencode"), "an empty XDG folder is none");
    let roots = Roots::of(env(&[]), || Some("/account".into())).unwrap();
    assert_eq!((roots.home.as_str(), roots.data.as_str()), ("/account", "/account/.local/share/opencode"), "no HOME: the account's own");
    for (pairs, said) in [
        (&[("HOME", "home")][..], "HOME is not an absolute path"),
        (&[("HOME", "/h"), ("XDG_DATA_HOME", "data")][..], "XDG_DATA_HOME is not an absolute path"),
        (&[("HOME", "")][..], "HOME is empty"),
    ] {
        let error = Roots::of(env(pairs), || Some("/account".into())).unwrap_err().to_string();
        assert!(error.contains(said), "{pairs:?}: {error}");
    }
    assert!(Roots::of(env(&[]), || None).is_err(), "no home folder at all");
}

#[test]
fn the_store_is_data_snapshot_project_and_the_worktrees_sha1() {
    assert_eq!(store("/d/opencode", "abc123", "/w/repo").unwrap(),
        PathBuf::from("/d/opencode/snapshot/abc123/2d98e56dc36b7431b8f668bf4d7715c564698d73"));
    for project in ["", "a/b", "..", "a b"] {
        assert!(store("/d/opencode", project, "/w/repo").is_err(), "project {project:?}");
    }
    assert!(store("/d/opencode", "abc123", "repo").is_err(), "a relative worktree");
}

/// On 2.x the store is OpenCode's data folder, as Core starts it for each
/// Agent (`XDG_DATA_HOME` in Core's own folder for it), then the project and
/// the SHA-1 of its Git top level, resolved (T-61 slice 5; 2.2.5
/// core/src/snapshot.ts): the resolving is the caller's, and a relative top
/// level is refused.
#[test]
fn the_store_is_in_cores_own_agent_folder_by_opencodes_project_and_toplevel() {
    let roots = Roots::of(env(&[("HOME", "/home/someone"), ("XDG_DATA_HOME", "/core/data/opencode/oc/xdg/data")]), || None).unwrap();
    assert_eq!(roots.data, "/core/data/opencode/oc/xdg/data/opencode");
    assert_eq!(store(&roots.data, "prj1", "/w/repo").unwrap(),
        PathBuf::from("/core/data/opencode/oc/xdg/data/opencode/snapshot/prj1/2d98e56dc36b7431b8f668bf4d7715c564698d73"),
        "in Core's own folder for the Agent, by the project and the SHA-1 of the top level");
    assert!(store(&roots.data, "prj1", "w/repo").is_err(), "a relative top level");
}

/// The files a 2.x revert sends back (T-61 slice 5): each step after the
/// Turn with a snapshot, in the session's order, each file once with the
/// first such step's `start`; files relative to the Git top level, inside
/// the Agent's folder.
#[test]
fn the_files_a_2x_revert_sends_back_are_each_steps_first_start_after_the_turn() {
    let user = |id: &str| json!({"id": id, "type": "user", "text": "x"});
    let step = |id: &str, start: &str, files: &[&str]| json!({"id": id, "type": "assistant", "snapshot": {"start": start, "end": start, "files": files}});
    let (one, two) = ("a".repeat(40), "b".repeat(40));
    let messages = vec![
        user("u1"),
        step("a1", &one, &["f/a", "f/b"]),
        json!({"id": "i1", "type": "idle", "outcome": "succeeded"}),
        user("u2"),
        step("a2", &two, &["f/a", "f/c"]),
    ];
    let target = |rel: &str, hash: &str| Target { file: format!("/w/{rel}"), rel: rel.into(), hash: hash.into() };
    assert_eq!(targets_v2(&messages, "u1", "/w", "/w/f").unwrap(),
        vec![target("f/a", &one), target("f/b", &one), target("f/c", &two)], "each file once, its first step's start");
    assert_eq!(targets_v2(&messages, "u2", "/w", "/w/f").unwrap(), vec![target("f/a", &two), target("f/c", &two)],
        "nothing before the boundary");
    assert_eq!(targets_v2(&messages[..4], "u2", "/w", "/w/f").unwrap(), vec![], "no step after it: no file");
    let off = vec![user("u1"), json!({"id": "a1", "type": "assistant"}), json!({"id": "a2", "type": "assistant"})];
    assert_eq!(targets_v2(&off, "u1", "/w", "/w/f").unwrap(), vec![], "snapshots off: 2.x sends no file back");

    let one_step = |files: &[&str]| vec![user("u1"), step("a1", &"a".repeat(40), files)];
    for (messages, boundary, said) in [
        (messages.clone(), "a1", "goes back to a user message"),
        (messages.clone(), "u9", "would revert nothing"),
        (one_step(&["other/x"]), "u1", "outside the Agent's folder"),
        (one_step(&["f/../other"]), "u1", "not a plain path inside"),
        (one_step(&["/w/f/a"]), "u1", "not a plain path inside"),
        (one_step(&["f/x*"]), "u1", "a character Git reads as a pattern"),
        (one_step(&["f/[ab]"]), "u1", "a character Git reads as a pattern"),
        (one_step(&["f/sub/.gitattributes"]), "u1", "is a .gitattributes file"),
        (vec![user("u1"), step("a1", "HEAD", &["f/a"])], "u1", "not an object ID"),
    ] {
        let error = targets_v2(&messages, boundary, "/w", "/w/f").unwrap_err().to_string();
        assert!(error.contains(said), "{boundary}: {error}");
    }
    assert!(targets_v2(&messages, "u1", "/w", "/elsewhere").is_err(), "an Agent folder outside the top level");
    assert!(targets_v2(&messages, "u1", "/", "/w").is_err(), "the root as top level");
}

/// A step after the Turn that 2.x would pass over in silence refuses the
/// files (D-24 (a): every file known, or nothing asked): one with a `start`
/// and no list of its files (2.x skips its files), or one with no snapshot
/// beside steps that have one (2.x skips the step).
#[test]
fn a_step_with_a_start_and_no_file_list_refuses_files() {
    let one = "a".repeat(40);
    let user = json!({"id": "u1", "type": "user", "text": "x"});
    let listed = json!({"id": "a1", "type": "assistant", "snapshot": {"start": one, "files": ["f/a"]}});
    for (step, said) in [
        (json!({"id": "a2", "type": "assistant", "snapshot": {"start": one}}), "a snapshot but no list of its files"),
        (json!({"id": "a2", "type": "assistant"}), "no snapshot though others have"),
        (json!({"id": "a2", "type": "assistant", "snapshot": {"end": one, "files": ["f/b"]}}), "no snapshot though others have"),
    ] {
        let error = targets_v2(&[user.clone(), listed.clone(), step.clone()], "u1", "/w", "/w/f").unwrap_err().to_string();
        assert!(error.contains(said), "{step}: {error}");
        let error = targets_v2(&[user.clone(), step.clone(), listed.clone()], "u1", "/w", "/w/f").unwrap_err().to_string();
        assert!(error.contains(said), "{step}, first: {error}");
    }
}

#[tokio::test]
async fn what_each_file_should_become_is_read_from_the_snapshot_store_which_is_left_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let (work, store) = (dir.path().join("work"), dir.path().join("store"));
    fs::create_dir_all(work.join("sub")).unwrap();
    fs::write(work.join("a.txt"), "a0\n").unwrap();
    fs::write(work.join("run.sh"), "#!/bin/sh\n").unwrap();
    fs::set_permissions(work.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(work.join("sub/b.txt"), "b0").unwrap();
    fs::write(work.join("x*"), "star").unwrap();
    std::os::unix::fs::symlink("a.txt", work.join("link")).unwrap();
    let hash = track(&store, &work);
    fs::write(work.join("new.txt"), "n1").unwrap();
    let before = listing(&store);
    let missing = "0".repeat(40);

    check_store(&store).unwrap();
    assert_eq!(expected(&store, &hash, "a.txt", BOUNDS).await.unwrap(), file(b"a0\n", false));
    assert_eq!(expected(&store, &hash, "run.sh", BOUNDS).await.unwrap(), file(b"#!/bin/sh\n", true));
    assert_eq!(expected(&store, &hash, "sub/b.txt", BOUNDS).await.unwrap(), file(b"b0", false));
    assert_eq!(expected(&store, &hash, "new.txt", BOUNDS).await.unwrap(), State::Absent, "not in the snapshot: OpenCode deletes it");
    assert_eq!(expected(&store, &hash, "x*", BOUNDS).await.unwrap(), file(b"star", false), "a name is read as it is");
    assert_eq!(expected(&store, &hash, "*", BOUNDS).await.unwrap(), State::Absent, "never as a pattern");
    for (hash, rel, bounds, said) in [
        (hash.as_str(), "link", BOUNDS, "mode 120000"),
        (hash.as_str(), "sub", BOUNDS, "a tree of mode 040000"),
        (missing.as_str(), "a.txt", BOUNDS, "reverting would delete a.txt"),
        (hash.as_str(), "a.txt", Bounds { file: 2, ..BOUNDS }, "more than 2 for Core to check"),
    ] {
        let error = format!("{:#}", expected(&store, hash, rel, bounds).await.unwrap_err());
        assert!(error.contains(said), "{rel}: {error}");
    }
    assert_eq!(listing(&store), before, "reading wrote nothing in the store");

    assert!(check_store(&work).is_err(), "a folder that is not a Git store");
    std::os::unix::fs::symlink(&store, dir.path().join("linked")).unwrap();
    assert!(check_store(&dir.path().join("linked")).is_err(), "a store that is a symlink");
}

#[test]
fn what_is_there_now_follows_no_symlink_and_is_a_regular_file_or_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().canonicalize().unwrap();
    fs::create_dir_all(work.join("dir")).unwrap();
    fs::write(work.join("a.txt"), "a1").unwrap();
    fs::write(work.join("exe"), "x").unwrap();
    fs::set_permissions(work.join("exe"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(work.join("dir/inner.txt"), "i").unwrap();
    std::os::unix::fs::symlink("a.txt", work.join("ln")).unwrap();
    std::os::unix::fs::symlink("dir", work.join("sd")).unwrap();
    let made = std::process::Command::new("mkfifo").arg(work.join("fifo")).status().unwrap();
    assert!(made.success());
    let root = Root::of(&work).unwrap();

    let state = |rel: &str| current(&work.join(rel), &work, root, BOUNDS).map(|(state, _)| state);
    assert_eq!(current(&work.join("a.txt"), &work, root, BOUNDS).unwrap(), (file(b"a1", false), Some(b"a1".to_vec())));
    assert_eq!(state("exe").unwrap(), file(b"x", true));
    assert_eq!(state("missing").unwrap(), State::Absent);
    assert_eq!(state("missing/x").unwrap(), State::Absent);
    for (rel, said) in [
        ("ln", "is a symlink"),
        ("sd/inner.txt", "is a symlink"),
        ("dir", "is not a regular file"),
        ("a.txt/x", "is not a folder"),
        ("fifo", "is not a regular file"),
    ] {
        let error = state(rel).unwrap_err().to_string();
        assert!(error.contains(said), "{rel}: {error}");
    }
    assert!(current(Path::new("/elsewhere/a"), &work, root, BOUNDS).is_err(), "outside the Agent's folder");
    let error = current(&work.join("a.txt"), &work, root, Bounds { file: 1, ..BOUNDS }).unwrap_err().to_string();
    assert!(error.contains("more than 1 for Core to keep"), "past the bound: {error}");

    // The folder itself: another one in its place, a symlink to it, or none at all never reads as nothing there.
    let other = tempfile::tempdir().unwrap();
    let elsewhere = Root::of(other.path()).unwrap();
    let error = format!("{:#}", current(&work.join("missing"), &work, elsewhere, BOUNDS).unwrap_err());
    assert!(error.contains("no longer the folder it was"), "{error}");
    let linked = other.path().join("linked");
    std::os::unix::fs::symlink(&work, &linked).unwrap();
    let error = format!("{:#}", current(&linked.join("missing"), &linked, root, BOUNDS).unwrap_err());
    assert!(error.contains("cannot be opened as a folder"), "{error}");
    let gone = other.path().join("gone");
    let error = format!("{:#}", current(&gone.join("missing"), &gone, root, BOUNDS).unwrap_err());
    assert!(error.contains("cannot be opened as a folder"), "{error}");
}

#[tokio::test]
async fn a_plan_is_bounded_its_backup_is_what_was_checked_and_each_file_is_judged_after() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (work, store) = (root.join("work"), root.join("store"));
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join("a.txt"), "a0").unwrap();
    fs::write(work.join("b.txt"), "b0").unwrap();
    let hash = track(&store, &work);
    // As OpenCode's run after that snapshot changed them.
    fs::write(work.join("a.txt"), "a1").unwrap();
    fs::write(work.join("b.txt"), "b1").unwrap();
    fs::write(work.join("new.txt"), "n1").unwrap();
    let targets: Vec<Target> = ["a.txt", "b.txt", "new.txt"]
        .iter()
        .map(|rel| Target { file: work.join(rel).to_string_lossy().into_owned(), rel: (*rel).into(), hash: hash.clone() })
        .collect();

    let root_id = Root::of(&work).unwrap();
    let (entries, kept) = plan(&store, &work, &HERMETIC, &targets, &work, root_id, BOUNDS).await.unwrap();
    assert_eq!(entries.iter().map(|e| (&e.expected, &e.current)).collect::<Vec<_>>(), vec![
        (&file(b"a0", false), &file(b"a1", false)),
        (&file(b"b0", false), &file(b"b1", false)),
        (&State::Absent, &file(b"n1", false)),
    ]);
    assert_eq!(kept, vec![Some(b"a1".to_vec()), Some(b"b1".to_vec()), Some(b"n1".to_vec())]);
    for (bounds, said) in [(Bounds { paths: 2, ..BOUNDS }, "more than 2 for Core to check"), (Bounds { total: 5, ..BOUNDS }, "more than 5 bytes")] {
        let error = plan(&store, &work, &HERMETIC, &targets, &work, root_id, bounds).await.unwrap_err().to_string();
        assert!(error.contains(said), "{error}");
    }

    let error = backup(&root.join("attempt/files"), &entries, &work, root_id, BOUNDS).unwrap_err().to_string();
    assert!(error.contains("is not a folder to keep a backup in"), "its parent is the caller's: {error}");
    fs::create_dir(root.join("attempt")).unwrap();
    let kept = backup(&root.join("attempt/files"), &entries, &work, root_id, BOUNDS).unwrap();
    assert_eq!(fs::read(root.join("attempt/files").join(kept.files[0].as_ref().unwrap())).unwrap(), b"a1");
    let listed: Backup = serde_json::from_slice(&fs::read(root.join("attempt/files/backup.json")).unwrap()).unwrap();
    assert_eq!(listed, kept, "its list, written last");
    assert!(backup(&root.join("attempt/files"), &entries, &work, root_id, BOUNDS).is_err(), "never into a backup already there");
    fs::write(work.join("b.txt"), "changed").unwrap();
    let error = backup(&root.join("again"), &entries, &work, root_id, BOUNDS).unwrap_err().to_string();
    assert!(error.contains("has changed since it was checked"), "{error}");
    fs::write(work.join("b.txt"), "b1").unwrap();

    // After the revert: a.txt back as the snapshot holds it, b.txt left as a failed checkout leaves it, new.txt neither.
    fs::write(work.join("a.txt"), "a0").unwrap();
    fs::write(work.join("new.txt"), "other").unwrap();
    assert_eq!(outcomes(&entries, &work, root_id, BOUNDS), vec![
        Outcome::Verified,
        Outcome::NotRestored,
        Outcome::Drifted { now: Some(file(b"other", false)), why: None },
    ]);
    fs::remove_file(work.join("new.txt")).unwrap();
    fs::set_permissions(work.join("a.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    let after = outcomes(&entries, &work, root_id, BOUNDS);
    assert_eq!(after[2], Outcome::Verified, "deleted, as the snapshot did not hold it");
    assert!(matches!(after[0], Outcome::Drifted { .. }), "the same bytes, but executable: not what the snapshot holds");
}

#[test]
fn only_a_native_executable_is_a_launcher_whose_environment_is_known() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().canonicalize().unwrap().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let make = |name: &str, bytes: &[u8]| {
        fs::write(bin.join(name), bytes).unwrap();
        fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        bin.join(name)
    };
    let elf = make("opencode-real", b"\x7fELF\x02\x01\x01\0rest");
    std::os::unix::fs::symlink(&elf, bin.join("opencode")).unwrap();
    let launcher = Launcher::resolve(Path::new("opencode"), Some(bin.as_os_str())).unwrap();
    assert!(matches!(&launcher, Launcher::Native { path, size: 12, .. } if path == &elf), "{launcher:?}");
    launcher.check().unwrap();
    assert_eq!(Launcher::resolve(&elf, None).unwrap(), launcher, "an absolute path, as it is");

    let script = make("wrapper", b"#!/bin/sh\nexec opencode-real \"$@\"\n");
    let other = Launcher::resolve(&script, None).unwrap();
    assert!(matches!(&other, Launcher::Other { why, .. } if why.contains("not a native executable")), "{other:?}");
    assert!(other.check().unwrap_err().to_string().contains("not known"));
    for program in [Path::new("./opencode"), Path::new("bin/opencode")] {
        assert!(matches!(Launcher::resolve(program, Some(bin.as_os_str())).unwrap(), Launcher::Other { .. }), "{program:?}");
    }
    let path = std::ffi::OsString::from(format!("relative:{}", bin.display()));
    assert!(matches!(Launcher::resolve(Path::new("opencode"), Some(path.as_os_str())).unwrap(), Launcher::Other { why, .. } if why.contains("relative entry")));
    assert!(Launcher::resolve(Path::new("missing"), Some(bin.as_os_str())).is_err());

    fs::write(&elf, b"\x7fELF\x02\x01\x01\0rest and more").unwrap();
    assert!(launcher.check().unwrap_err().to_string().contains("has changed since"));
}

#[test]
fn opencodes_checkout_reads_a_path_as_a_pattern_so_such_a_path_is_refused() {
    // As `Snapshot.revert` checks a file out (`git checkout <hash> -- <absolute file>`): "x*" brings "xa" back too,
    // a file no patch named, which Core would neither list nor back up.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (work, store) = (root.join("work"), root.join("store"));
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join("x*"), "s0").unwrap();
    fs::write(work.join("xa"), "a0").unwrap();
    let hash = track(&store, &work);
    fs::write(work.join("x*"), "s1").unwrap();
    fs::write(work.join("xa"), "a1").unwrap();
    let pattern = work.join("x*");
    run(&store, &work, &["checkout", hash.as_str(), "--", pattern.to_str().unwrap()]);
    assert_eq!(fs::read_to_string(work.join("xa")).unwrap(), "a0", "Git matched xa by the pattern x*");
    let rel = work.join("x*").strip_prefix(&root).unwrap().to_string_lossy().into_owned();
    let messages = vec![
        json!({"id": "u1", "type": "user", "text": "x"}),
        json!({"id": "a1", "type": "assistant", "snapshot": {"start": hash, "files": [rel]}}),
    ];
    let error = targets_v2(&messages, "u1", root.to_str().unwrap(), work.to_str().unwrap()).unwrap_err().to_string();
    assert!(error.contains("a character Git reads as a pattern"), "{error}");
}

#[tokio::test]
async fn a_file_git_would_convert_on_opencodes_checkout_is_refused_before_anything_is_asked() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (work, store) = (root.join("work"), root.join("store"));
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join(".gitattributes"), "*.crlf text eol=crlf\n*.id ident\n*.raw -text\n").unwrap();
    fs::write(work.join("a.crlf"), "a\n").unwrap();
    fs::write(work.join("b.id"), "$Id$\n").unwrap();
    fs::write(work.join("c.raw"), "c\n").unwrap();
    fs::write(work.join("plain.txt"), "p\n").unwrap();
    let hash = track(&store, &work);
    // As OpenCode checks it out: the snapshot holds "a\n", the file becomes "a\r\n".
    let crlf = work.join("a.crlf");
    fs::write(&crlf, "changed").unwrap();
    run(&store, &work, &["checkout", hash.as_str(), "--", crlf.to_str().unwrap()]);
    assert_eq!(fs::read(&crlf).unwrap(), b"a\r\n", "Git converted it on checkout");
    assert_eq!(expected(&store, &hash, "a.crlf", BOUNDS).await.unwrap(), file(b"a\n", false), "the snapshot's own bytes differ");
    for (rel, said) in [("a.crlf", "text: set"), ("b.id", "ident: set")] {
        let error = format!("{:#}", unconverted(&store, &work, &HERMETIC, rel).await.unwrap_err());
        assert!(error.contains(said), "{rel}: {error}");
    }
    unconverted(&store, &work, &HERMETIC, "c.raw").await.unwrap();
    unconverted(&store, &work, &HERMETIC, "plain.txt").await.unwrap();
    let targets = vec![Target { file: crlf.to_string_lossy().into_owned(), rel: "a.crlf".into(), hash: hash.clone() }];
    let root_id = Root::of(&work).unwrap();
    let error = format!("{:#}", plan(&store, &work, &HERMETIC, &targets, &work, root_id, BOUNDS).await.unwrap_err());
    assert!(error.contains("Git would convert a.crlf"), "{error}");
    // A configuration that converts every file, as someone's own may.
    run(&store, &work, &["config", "core.autocrlf", "true"]);
    let error = format!("{:#}", unconverted(&store, &work, &HERMETIC, "plain.txt").await.unwrap_err());
    assert!(error.contains("core.autocrlf \"true\""), "{error}");
}

#[cfg(target_os = "linux")]
#[test]
fn a_launcher_is_bound_to_the_process_that_runs_it_and_its_folders_come_with_it() {
    let sleep = Launcher::resolve(Path::new("sleep"), std::env::var_os("PATH").as_deref()).unwrap();
    let Launcher::Native { path, .. } = &sleep else { panic!("{sleep:?}") };
    let mut child = std::process::Command::new(path).arg("30").spawn().unwrap();
    sleep.bound(child.id()).unwrap();
    let ours = Launcher::resolve(&std::env::current_exe().unwrap(), None).unwrap();
    let error = ours.bound(child.id()).unwrap_err().to_string();
    assert!(error.contains("does not run"), "another file than the one started: {error}");

    let none = || Vec::<std::ffi::OsString>::new();
    let started = Started::of(Ok(sleep.clone()), Some(child.id()), env(&[("HOME", "/h")]), vec!["GIT_EDITOR".into(), "PATH".into()], || None).unwrap();
    assert_eq!((&started.launcher, started.roots.data.as_str()), (&sleep, "/h/.local/share/opencode"));
    for (launcher, pid, pairs, names, said) in [
        (Ok(ours), Some(child.id()), &[("HOME", "/h")][..], none(), "does not run"),
        (Ok(sleep.clone()), None, &[("HOME", "/h")][..], none(), "no ID"),
        (Ok(sleep.clone()), Some(child.id()), &[("HOME", "")][..], none(), "HOME is empty"),
        (Err(anyhow::anyhow!("opencode is not on the PATH")), Some(child.id()), &[("HOME", "/h")][..], none(), "not on the PATH"),
        (Ok(sleep.clone()), Some(child.id()), &[("HOME", "/h")][..], vec!["GIT_CONFIG_GLOBAL".into()], "sets GIT_CONFIG_GLOBAL"),
        (Ok(sleep.clone()), Some(child.id()), &[("HOME", "/h")][..], vec!["GIT_INDEX_FILE".into(), "GIT_ATTR_SOURCE".into()], "sets GIT_INDEX_FILE, GIT_ATTR_SOURCE"),
    ] {
        let why = Started::of(launcher, pid, env(pairs), names, || None).unwrap_err();
        assert!(why.contains(said), "{why}");
    }
    child.kill().unwrap();
    child.wait().unwrap();
}

#[tokio::test]
async fn either_view_of_the_attributes_that_converts_refuses_and_core_autocrlf_counts_only_as_git_reads_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (work, store) = (root.join("work"), root.join("store"));
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join(".gitattributes"), "*.txt text eol=crlf\n").unwrap();
    fs::write(work.join("a.txt"), "a\n").unwrap();
    track(&store, &work);
    // The work tree's own says nothing converts now; the index still holds the one that does.
    fs::write(work.join(".gitattributes"), "*.txt -text\n").unwrap();
    let error = format!("{:#}", unconverted(&store, &work, &HERMETIC, "a.txt").await.unwrap_err());
    assert!(error.contains("by the index's attributes"), "{error}");
    fs::write(work.join(".gitattributes"), "").unwrap();
    track(&store, &work);
    unconverted(&store, &work, &HERMETIC, "a.txt").await.unwrap();
    for (value, converts) in [("yes", true), ("on", true), ("1", true), ("TRUE", true), ("input", false), ("off", false), ("no", false), ("0", false)] {
        run(&store, &work, &["config", "core.autocrlf", value]);
        let answer = unconverted(&store, &work, &HERMETIC, "a.txt").await;
        assert_eq!(answer.is_err(), converts, "core.autocrlf {value}: {answer:?}");
    }
    // A key with no value is true to Git.
    run(&store, &work, &["config", "--unset", "core.autocrlf"]);
    let mut config = fs::read_to_string(store.join("config")).unwrap();
    config.push_str("[core]\n\tautocrlf\n");
    fs::write(store.join("config"), config).unwrap();
    let error = format!("{:#}", unconverted(&store, &work, &HERMETIC, "a.txt").await.unwrap_err());
    assert!(error.contains("core.autocrlf \"\""), "{error}");
}

#[tokio::test]
async fn a_git_answer_past_its_bound_ends_git_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let (work, store) = (root.join("work"), root.join("store"));
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join("big"), vec![b'x'; 4 << 20]).unwrap();
    track(&store, &work);
    let object = run(&store, &work, &["hash-object", "big"]).trim().to_owned();
    let started = std::time::Instant::now();
    let error = git_ok(&store, &["cat-file", "blob", object.as_str()], 10).await.unwrap_err().to_string();
    assert!(error.contains("exceeded 10 bytes"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(10), "ended at once, not at the time limit: {:?}", started.elapsed());
}

/// Whether the process `pid` is gone, reaped: no such process, not even one that ended unreaped.
#[cfg(target_os = "linux")]
fn reaped(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit(')').next().and_then(|rest| rest.split_whitespace().next()) == Some("X"),
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_capture_ends_within_its_deadline_and_reaps_what_it_started_however_it_ends() {
    let dir = tempfile::tempdir().unwrap();
    let pid = |name: &str| -> i32 { std::fs::read_to_string(dir.path().join(name)).unwrap().trim().parse().unwrap() };
    let within = Duration::from_secs(2);

    // What it says held open by a process it started in turn: its answer and its own end came, what it says
    // never ends; the deadline ends that wait, and what it started itself is reaped. Its deadline is wider: under
    // load the shell may not have started what it starts in 2 s (T-61 slice 5; still bounded below at 10 s).
    let held = dir.path().join("held");
    let started = std::time::Instant::now();
    let error = capture(sh(format!("echo $$ > {0}/self; sh -c 'echo $$ > {1}; exec sleep 30 >/dev/null' & echo answer", dir.path().display(), held.display())), 100, Duration::from_secs(5))
        .await.unwrap_err().to_string();
    assert!(error.contains("What Git said did not end within"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    assert!(reaped(pid("self")), "what it started itself is reaped");
    let descendant = pid("held");
    assert!(!reaped(descendant), "a process it did not start is not its to end");
    unsafe { libc::kill(descendant, libc::SIGKILL) };

    // No answer by the deadline: killed and reaped.
    let started = std::time::Instant::now();
    let error = capture(sh(format!("echo $$ > {}/slow; exec sleep 30", dir.path().display())), 100, within).await.unwrap_err().to_string();
    assert!(error.contains("Git did not answer within"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    assert!(reaped(pid("slow")), "killed and reaped at the deadline");

    // More than it may answer: killed and reaped at once.
    let started = std::time::Instant::now();
    let error = capture(sh(format!("echo $$ > {}/loud; exec yes", dir.path().display())), 10, within).await.unwrap_err().to_string();
    assert!(error.contains("exceeded 10 bytes"), "{error}");
    assert!(started.elapsed() < within, "ended at once: {:?}", started.elapsed());
    assert!(reaped(pid("loud")), "killed and reaped when it said too much");

    // And an ordinary end: its answer, what it said, how it ended.
    let (status, answer, said) = capture(sh("echo answer; echo trouble >&2; exit 3".into()), 100, within).await.unwrap();
    assert_eq!((status.code(), answer, said.as_str()), (Some(3), b"answer\n".to_vec(), "trouble"));
}

/// A pipe that fails once it has given its first bytes, as a read can.
#[cfg(target_os = "linux")]
struct FailsAfterFirst<R>(R, bool);

#[cfg(target_os = "linux")]
impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for FailsAfterFirst<R> {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        if self.1 {
            return std::task::Poll::Ready(Err(std::io::Error::other("a read that fails")));
        }
        let before = buf.filled().len();
        let polled = std::pin::Pin::new(&mut self.0).poll_read(cx, buf);
        self.1 = matches!(polled, std::task::Poll::Ready(Ok(()))) && buf.filled().len() > before;
        polled
    }
}

/// A pipe that says when it is dropped.
#[cfg(target_os = "linux")]
struct Dropped<R>(R, std::sync::Arc<std::sync::atomic::AtomicBool>);

#[cfg(target_os = "linux")]
impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for Dropped<R> {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

#[cfg(target_os = "linux")]
impl<R> Drop for Dropped<R> {
    fn drop(&mut self) {
        self.1.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(target_os = "linux")]
fn sh(script: String) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/bin/sh");
    command.arg("-c").arg(script);
    command
}

/// The process ID a script wrote to `file`, once it has.
#[cfg(target_os = "linux")]
async fn written(file: &Path) -> i32 {
    for _ in 0..400 {
        if let Some(pid) = fs::read_to_string(file).ok().and_then(|pid| pid.trim().parse().ok()) {
            return pid;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("no process ID in {}", file.display());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_read_that_fails_is_the_captures_error_with_its_cause_and_what_it_started_is_reaped() {
    let dir = tempfile::tempdir().unwrap();
    let within = Duration::from_secs(10);

    // What it says fails to be read after its answer and its own end came: that failure, not a panic.
    let quick = dir.path().join("quick");
    let error = capture_through(sh(format!("echo $$ > {}; echo trouble >&2; echo answer", quick.display())), 100, within,
        |out, err| (out, FailsAfterFirst(err, false))).await.unwrap_err();
    let error = format!("{error:#}");
    assert!(error.contains("What Git said could not be read"), "{error}");
    assert!(error.contains("a read that fails"), "the cause is kept: {error}");
    assert!(reaped(written(&quick).await), "what it started is reaped");

    // Its answer fails to be read while it runs on: that failure at once, and what it started killed and reaped.
    let stuck = dir.path().join("stuck");
    let started = std::time::Instant::now();
    let error = capture_through(sh(format!("echo $$ > {}; echo answer; exec sleep 30", stuck.display())), 100, within,
        |out, err| (FailsAfterFirst(out, false), err)).await.unwrap_err();
    let error = format!("{error:#}");
    assert!(error.contains("Git's answer could not be read"), "{error}");
    assert!(error.contains("a read that fails"), "the cause is kept: {error}");
    assert!(started.elapsed() < within / 2, "ended at once: {:?}", started.elapsed());
    assert!(reaped(written(&stuck).await), "killed and reaped when its answer could not be read");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_capture_dropped_before_it_ends_ends_its_reads_with_it_and_kills_what_it_started() {
    use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
    let dir = tempfile::tempdir().unwrap();
    let (me, held) = (dir.path().join("self"), dir.path().join("held"));
    let (answer, saying) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    let (a, s) = (answer.clone(), saying.clone());
    // It runs on, and so does a process it started in turn, holding what it says open.
    let mut capture = Box::pin(capture_through(
        sh(format!("echo $$ > {}; sh -c 'echo $$ > {}; exec sleep 30 >/dev/null' & exec sleep 30", me.display(), held.display())),
        100, Duration::from_secs(30), move |out, err| (Dropped(out, a), Dropped(err, s))));
    let started = tokio::time::timeout(Duration::from_secs(10), async { tokio::join!(written(&me), written(&held)) });
    let (me, descendant) = tokio::select! {
        ended = &mut capture => panic!("it ended before it was dropped: {ended:?}"),
        pids = started => pids.expect("it started"),
    };
    drop(capture);
    assert!(answer.load(Ordering::SeqCst), "its answer is read no longer once it is dropped");
    assert!(saying.load(Ordering::SeqCst), "what it says is read no longer once it is dropped");
    // Killed: nothing here waits for it, so it may stay unreaped until Tokio reaps it.
    let state = |pid: i32| fs::read_to_string(format!("/proc/{pid}/stat")).ok()
        .and_then(|stat| stat.rsplit(')').next().and_then(|rest| rest.split_whitespace().next()).map(str::to_owned));
    let mut ended = false;
    for _ in 0..200 {
        ended = matches!(state(me).as_deref(), None | Some("Z" | "X"));
        if ended {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(ended, "what it started is killed: {:?}", state(me));
    assert!(!reaped(descendant), "a process it did not start is not its to end");
    unsafe { libc::kill(descendant, libc::SIGKILL) };
}
