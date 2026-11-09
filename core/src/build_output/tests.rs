//! Which folders are Cargo's (YN-65). The preview, protections and removal
//! are exercised end to end in task_workspaces/tests.rs.
use super::*;

const TAG: &str = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n";

/// A Cargo profile directory with one small file.
fn profile(target: &Path, name: &str) -> PathBuf {
    let dir = target.join(name);
    std::fs::create_dir_all(dir.join(".fingerprint")).unwrap();
    std::fs::create_dir_all(dir.join("deps")).unwrap();
    std::fs::write(dir.join(".cargo-lock"), "").unwrap();
    std::fs::write(dir.join("deps/blob"), [7u8; 10]).unwrap();
    dir
}

/// A target directory made before Cargo ran (scripts/source_build.py and Job
/// scripts make it) has no CACHEDIR.TAG, only the rustc information Cargo
/// keeps there: its profiles are Cargo output all the same (YN-65: 24 of 81
/// on one host). A .rustc_info.json that is not Cargo's names nothing.
#[test]
fn a_target_cargo_did_not_create_is_known_by_its_rustc_information() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let made = root.join("target/t61s5");
    std::fs::create_dir_all(&made).unwrap();
    std::fs::write(made.join(".rustc_info.json"), r#"{"rustc_fingerprint":1689302309,"outputs":{"797":{"success":true}}}"#).unwrap();
    profile(&made, "debug");
    for (name, text) in [("no-fingerprint", r#"{"outputs":{}}"#), ("not-json", "rustc_fingerprint outputs"), ("outputs-list", r#"{"rustc_fingerprint":1,"outputs":[]}"#)] {
        let forged = root.join("target").join(name);
        std::fs::create_dir_all(&forged).unwrap();
        std::fs::write(forged.join(".rustc_info.json"), text).unwrap();
        profile(&forged, "debug");
    }
    let (candidates, _, _) = discover(root);
    assert_eq!(candidates, [made.join("debug")]);
}

/// Cargo's rustc information is a small regular file: a large one, or a link
/// to a real one, is not taken as Cargo's. The tag alone still suffices.
#[test]
fn only_a_small_regular_rustc_information_file_or_the_tag_counts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let real = root.join("elsewhere");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("info.json"), r#"{"rustc_fingerprint":1,"outputs":{}}"#).unwrap();
    let linked = root.join("target/linked");
    std::fs::create_dir_all(&linked).unwrap();
    std::os::unix::fs::symlink(real.join("info.json"), linked.join(".rustc_info.json")).unwrap();
    profile(&linked, "debug");
    let large = root.join("target/large");
    std::fs::create_dir_all(&large).unwrap();
    let padding = " ".repeat(RUSTC_INFO_BYTES as usize);
    std::fs::write(large.join(".rustc_info.json"), format!(r#"{{"rustc_fingerprint":1,"outputs":{{}}}}{padding}"#)).unwrap();
    profile(&large, "debug");
    let tagged = root.join("target/tagged");
    std::fs::create_dir_all(&tagged).unwrap();
    std::fs::write(tagged.join("CACHEDIR.TAG"), TAG).unwrap();
    profile(&tagged, "debug");
    let (candidates, _, _) = discover(root);
    assert_eq!(candidates, [tagged.join("debug")]);
}

/// A Git checkout whose target/ is ignored, with one Cargo profile in it.
fn checkout() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-C"])
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "first"]);
    std::fs::create_dir(root.join("target")).unwrap();
    std::fs::write(root.join("target/CACHEDIR.TAG"), TAG).unwrap();
    let debug = profile(&root.join("target"), "debug");
    (dir, root, debug)
}

/// Cargo 1.97 holds .cargo-lock shared while it compiles, and its newer
/// .cargo-build-lock and .cargo-artifact-lock exclusively (YN-65 Job
/// 3d9447d1): a build holding only one of the newer locks is a build too.
#[tokio::test]
async fn a_build_holding_only_one_of_cargos_newer_locks_is_still_a_build() {
    let (_dir, root, debug) = checkout();
    assert_eq!(local_protections(&root, &debug).await, Vec::<String>::new());
    for name in [".cargo-build-lock", ".cargo-artifact-lock"] {
        std::fs::write(debug.join(name), "").unwrap();
        let lock = std::fs::File::open(debug.join(name)).unwrap();
        lock.lock().unwrap();
        let reasons = local_protections(&root, &debug).await;
        assert_eq!(reasons, ["Cargo is building here now"], "{name}");
        drop(lock);
    }
    assert_eq!(local_protections(&root, &debug).await, Vec::<String>::new());
}

/// A program that runs from it, works in it or has a file open there keeps
/// it: `cargo test` and `cargo run` hold no lock while the program runs.
#[tokio::test]
async fn a_process_working_in_running_from_or_reading_it_keeps_it() {
    let (dir, root, debug) = checkout();
    let elsewhere = dir.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    let sleep = ["/usr/bin/sleep", "/bin/sleep"].into_iter().map(PathBuf::from).find(|p| p.exists()).expect("sleep");
    std::fs::copy(&sleep, debug.join("deps/sleepy")).unwrap();
    std::fs::write(debug.join("deps/input"), "x").unwrap();
    let start = |program: &Path, cwd: &Path, stdin: std::process::Stdio| {
        std::process::Command::new(program).arg("30").current_dir(cwd).stdin(stdin).spawn().unwrap()
    };
    let cases = [
        ("its working folder is there", start(&sleep, &debug.join("deps"), std::process::Stdio::null())),
        ("it runs a program from there", start(&debug.join("deps/sleepy"), &elsewhere, std::process::Stdio::null())),
        ("it has a file open there", start(&sleep, &elsewhere, std::fs::File::open(debug.join("deps/input")).unwrap().into())),
    ];
    for (how, mut child) in cases {
        // Wait until the child runs its program, not this test's copy.
        let (exe, me) = (format!("/proc/{}/exe", child.id()), std::env::current_exe().unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::fs::read_link(&exe).map_or(true, |p| p == me) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let reasons = local_protections(&root, &debug).await;
        let expected = format!("Process {} ", child.id());
        assert!(reasons.iter().any(|r| r.starts_with(&expected) && r.ends_with(how)), "{how}: {reasons:?}");
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert_eq!(local_protections(&root, &debug).await, Vec::<String>::new());
}
