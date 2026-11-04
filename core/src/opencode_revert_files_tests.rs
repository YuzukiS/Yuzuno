use super::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<std::ffi::OsString> {
    let pairs: Vec<(String, String)> = pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    move |name| pairs.iter().find(|(n, _)| n == name).map(|(_, v)| v.into())
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
        (&"0".repeat(40)[..], "a.txt", BOUNDS, "reverting would delete a.txt"),
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

    let state = |rel: &str| current(&work.join(rel), &work, BOUNDS).map(|(state, _)| state);
    assert_eq!(current(&work.join("a.txt"), &work, BOUNDS).unwrap(), (file(b"a1", false), Some(b"a1".to_vec())));
    assert_eq!(state("exe").unwrap(), file(b"x", true));
    assert_eq!(state("missing").unwrap(), State::Absent);
    assert_eq!(state("missing/x").unwrap(), State::Absent);
    for (rel, said) in [("ln", "is a symlink"), ("sd/inner.txt", "is a symlink"), ("dir", "is not a regular file"), ("a.txt/x", "is not a folder")] {
        let error = state(rel).unwrap_err().to_string();
        assert!(error.contains(said), "{rel}: {error}");
    }
    assert!(current(Path::new("/elsewhere/a"), &work, BOUNDS).is_err(), "outside the Agent's folder");
    assert!(current(&work.join("a.txt"), &work, Bounds { file: 1, ..BOUNDS }).is_err(), "past the bound");
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

    let (entries, kept) = plan(&store, &targets, &work, BOUNDS).await.unwrap();
    assert_eq!(entries.iter().map(|e| (&e.expected, &e.current)).collect::<Vec<_>>(), vec![
        (&file(b"a0", false), &file(b"a1", false)),
        (&file(b"b0", false), &file(b"b1", false)),
        (&State::Absent, &file(b"n1", false)),
    ]);
    assert_eq!(kept, vec![Some(b"a1".to_vec()), Some(b"b1".to_vec()), Some(b"n1".to_vec())]);
    for (bounds, said) in [(Bounds { paths: 2, ..BOUNDS }, "more than 2 for Core to check"), (Bounds { total: 5, ..BOUNDS }, "more than 5 bytes")] {
        let error = plan(&store, &targets, &work, bounds).await.unwrap_err().to_string();
        assert!(error.contains(said), "{error}");
    }

    let kept = backup(&root.join("attempt/files"), &entries, &work, BOUNDS).unwrap();
    assert_eq!(fs::read(root.join("attempt/files").join(kept.files[0].as_ref().unwrap())).unwrap(), b"a1");
    let listed: Backup = serde_json::from_slice(&fs::read(root.join("attempt/files/backup.json")).unwrap()).unwrap();
    assert_eq!(listed, kept, "its list, written last");
    assert!(backup(&root.join("attempt/files"), &entries, &work, BOUNDS).is_err(), "never into a backup already there");
    fs::write(work.join("b.txt"), "changed").unwrap();
    let error = backup(&root.join("again"), &entries, &work, BOUNDS).unwrap_err().to_string();
    assert!(error.contains("has changed since it was checked"), "{error}");
    fs::write(work.join("b.txt"), "b1").unwrap();

    // After the revert: a.txt back as the snapshot holds it, b.txt left as a failed checkout leaves it, new.txt neither.
    fs::write(work.join("a.txt"), "a0").unwrap();
    fs::write(work.join("new.txt"), "other").unwrap();
    assert_eq!(outcomes(&entries, &work, BOUNDS), vec![
        Outcome::Verified,
        Outcome::NotRestored,
        Outcome::Drifted { now: Some(file(b"other", false)), why: None },
    ]);
    fs::remove_file(work.join("new.txt")).unwrap();
    fs::set_permissions(work.join("a.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    let after = outcomes(&entries, &work, BOUNDS);
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
    assert!(matches!(Launcher::resolve(Path::new("opencode"), Some(&path)).unwrap(), Launcher::Other { why, .. } if why.contains("relative entry")));
    assert!(Launcher::resolve(Path::new("missing"), Some(bin.as_os_str())).is_err());

    fs::write(&elf, b"\x7fELF\x02\x01\x01\0rest and more").unwrap();
    assert!(launcher.check().unwrap_err().to_string().contains("has changed since"));
}
