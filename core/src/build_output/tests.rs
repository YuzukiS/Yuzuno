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
