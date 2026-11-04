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

    let path = json!({"home": "/account", "state": "/account/.local/state/opencode", "config": "/account/.config/opencode", "worktree": "/w", "directory": "/w"});
    roots.agrees(&path).unwrap();
    for (name, other) in [("home", "/elsewhere"), ("state", "/s/opencode"), ("config", "/c/opencode")] {
        let mut changed = path.clone();
        changed[name] = other.into();
        let error = roots.agrees(&changed).unwrap_err().to_string();
        assert!(error.contains(&format!("OpenCode's {name} folder is {other}")), "{error}");
    }
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

#[test]
fn a_revert_sends_back_each_file_of_a_later_patch_to_its_first_patchs_snapshot() {
    let message = |id: &str, role: &str, parts: Value| json!({"info": {"id": id, "role": role}, "parts": parts});
    let text = |id: &str| json!({"id": id, "type": "text", "text": "x"});
    let patch = |hash: &str, files: &[&str]| json!({"id": "p", "type": "patch", "hash": hash, "files": files});
    let (one, two) = ("a".repeat(40), "b".repeat(40));
    let messages = vec![
        message("u1", "user", json!([text("t1")])),
        message("a1", "assistant", json!([text("t2"), patch(&one, &["/w/f/a", "/w/f/b"])])),
        message("u2", "user", json!([text("t3")])),
        message("a2", "assistant", json!([patch(&two, &["/w/f/a", "/w/f/c"])])),
    ];
    let target = |file: &str, hash: &str| Target { file: file.into(), rel: file.trim_start_matches("/w/").into(), hash: hash.into() };
    assert_eq!(targets(&messages, "u1", "/w", "/w/f").unwrap(),
        vec![target("/w/f/a", &one), target("/w/f/b", &one), target("/w/f/c", &two)], "each file once, its first patch's snapshot");
    assert_eq!(targets(&messages, "u2", "/w", "/w/f").unwrap(), vec![target("/w/f/a", &two), target("/w/f/c", &two)],
        "nothing before the boundary");
    assert_eq!(targets(&messages[..3], "u2", "/w", "/w/f").unwrap(), vec![], "no patch after it: no file");

    for (messages, boundary, said) in [
        (messages.clone(), "a1", "goes back to a user message"),
        (messages.clone(), "u9", "would revert nothing"),
        (vec![message("u1", "user", json!([]))], "u1", "would revert nothing"),
        (vec![message("u1", "user", json!([text("t")])), message("a1", "assistant", json!([patch(&one, &["/w/other/x"])]))], "u1", "outside the Agent's folder"),
        (vec![message("u1", "user", json!([text("t")])), message("a1", "assistant", json!([patch(&one, &["/w/f/../other"])]))], "u1", "not a plain absolute path"),
        (vec![message("u1", "user", json!([text("t")])), message("a1", "assistant", json!([patch("HEAD", &["/w/f/a"])]))], "u1", "not an object ID"),
        (vec![message("u1", "user", json!([text("t")])), message("a1", "assistant", json!([patch(&one, &["/w/f/x*"])]))], "u1", "a character Git reads as a pattern"),
        (vec![message("u1", "user", json!([text("t")])), message("a1", "assistant", json!([patch(&one, &["/w/f/x?"])]))], "u1", "a character Git reads as a pattern"),
        (vec![message("u1", "user", json!([text("t")])), message("a1", "assistant", json!([patch(&one, &["/w/f/[ab]"])]))], "u1", "a character Git reads as a pattern"),
        (vec![message("u1", "user", json!([text("t")])), message("a1", "assistant", json!([patch(&one, &["/w/f/x\\y"])]))], "u1", "a character Git reads as a pattern"),
        (vec![message("u1", "user", json!([text("t")])), message("a1", "assistant", json!([patch(&one, &["/w/f/sub/.gitattributes"])]))], "u1", "is a .gitattributes file"),
    ] {
        let error = targets(&messages, boundary, "/w", "/w/f").unwrap_err().to_string();
        assert!(error.contains(said), "{boundary}: {error}");
    }
    assert!(targets(&messages, "u1", "/w", "/elsewhere").is_err(), "an Agent folder outside the worktree");
    assert!(targets(&messages, "u1", "/", "/w").is_err(), "the root as worktree");
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
    let messages = vec![
        json!({"info": {"id": "u1", "role": "user"}, "parts": [{"id": "t", "type": "text", "text": "x"}]}),
        json!({"info": {"id": "a1", "role": "assistant"}, "parts": [{"id": "p", "type": "patch", "hash": hash, "files": [work.join("x*")]}]}),
    ];
    let error = targets(&messages, "u1", root.to_str().unwrap(), work.to_str().unwrap()).unwrap_err().to_string();
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
    assert!(error.contains("core.autocrlf true"), "{error}");
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
