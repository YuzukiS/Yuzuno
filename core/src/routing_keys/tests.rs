//! The routing key file (YN-34 S1a): made 0600 in a 0700 folder whatever the
//! umask, refused when wider or not Core's, never read back. Synthetic values
//! only.
use super::*;
use std::os::unix::fs::symlink;

const KEY: &str = "sk-test-yn34-local-0123456789";
const TOKEN: &str = "ops_test-yn34-token-0123456789";

fn store() -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::of(tmp.path());
    (tmp, store)
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().mode() & 0o777
}

/// The umask is the process's: set it for one closure, then restore it.
fn with_umask<T>(mask: libc::mode_t, run: impl FnOnce() -> T) -> T {
    let before = unsafe { libc::umask(mask) };
    let out = run();
    unsafe { libc::umask(before) };
    out
}

#[test]
fn the_file_is_0600_in_a_0700_folder_whatever_the_umask() {
    for mask in [0o000, 0o022, 0o077] {
        let (tmp, store) = store();
        with_umask(mask, || store.put_local("anthropic", Provider::Anthropic, Secret::new(KEY.into())).unwrap());
        assert_eq!(mode(&tmp.path().join(DIR)), 0o700, "umask {mask:o}: the folder");
        assert_eq!(mode(&tmp.path().join(DIR).join(FILE)), 0o600, "umask {mask:o}: the file");
        // A replacement is a new file, made the same way.
        with_umask(mask, || store.put_token(Secret::new(TOKEN.into())).unwrap());
        assert_eq!(mode(&tmp.path().join(DIR).join(FILE)), 0o600, "umask {mask:o}: the replaced file");
        let left: Vec<_> = fs::read_dir(tmp.path().join(DIR)).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from(FILE)], "no temporary file is left");
    }
}

#[test]
fn a_file_others_may_access_is_refused_not_read() {
    let (tmp, store) = store();
    store.put_local("deepseek", Provider::Deepseek, Secret::new(KEY.into())).unwrap();
    let file = tmp.path().join(DIR).join(FILE);
    for wider in [0o644, 0o640, 0o604, 0o660] {
        fs::set_permissions(&file, fs::Permissions::from_mode(wider)).unwrap();
        let error = format!("{:#}", store.keys().unwrap_err());
        assert!(error.contains(&format!("(mode {wider:o})")) && error.contains("will not use it"), "{wider:o}: {error}");
        assert!(store.source("deepseek").is_err(), "{wider:o}: no value either");
        assert!(store.put_token(Secret::new(TOKEN.into())).is_err(), "{wider:o}: and no write over it");
    }
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(store.keys().unwrap().len(), 1, "0600 again: used again");
}

#[test]
fn a_link_in_the_files_place_is_refused() {
    let (tmp, store) = store();
    let elsewhere = tmp.path().join("elsewhere.json");
    fs::write(&elsewhere, "{}").unwrap();
    fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o600)).unwrap();
    fs::DirBuilder::new().mode(0o700).create(tmp.path().join(DIR)).unwrap();
    symlink(&elsewhere, tmp.path().join(DIR).join(FILE)).unwrap();
    let error = format!("{:#}", store.keys().unwrap_err());
    assert!(error.contains("is a link"), "{error}");
}

#[test]
fn a_folder_others_may_write_into_is_refused() {
    let (tmp, store) = store();
    fs::DirBuilder::new().mode(0o777).create(tmp.path().join(DIR)).unwrap();
    fs::set_permissions(tmp.path().join(DIR), fs::Permissions::from_mode(0o777)).unwrap();
    let error = format!("{:#}", store.put_local("a", Provider::Openai, Secret::new(KEY.into())).unwrap_err());
    assert!(error.contains("can be written by other users"), "{error}");
    assert!(!tmp.path().join(DIR).join(FILE).exists(), "nothing written");
}

#[test]
fn another_users_file_is_refused() {
    // A test cannot chown as an ordinary user: the rule is checked on its own.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("f");
    fs::write(&path, "{}").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let meta = fs::metadata(&path).unwrap();
    assert!(trusted(&path, &meta).is_ok(), "Core's own 0600 file");
    let me = rustix::process::geteuid().as_raw();
    assert_ne!(me, 0, "run as an ordinary user");
    let root = Path::new("/etc/passwd");
    let error = format!("{:#}", trusted(root, &fs::metadata(root).unwrap()).unwrap_err());
    assert!(error.contains("belongs to user 0") && error.contains(&format!("not to Core's user {me}")), "{error}");
}

#[test]
fn a_read_says_whether_a_key_is_set_never_its_value() {
    let (_tmp, store) = store();
    let local = store.put_local("anthropic", Provider::Anthropic, Secret::new(format!("  {KEY}\n"))).unwrap();
    let reference = store.put_reference("openai", Provider::Openai, "op://Vault/OpenAI API/credential").unwrap();
    let token = store.put_token(Secret::new(TOKEN.into())).unwrap();
    let shown = serde_json::to_string(&(store.keys().unwrap(), store.token().unwrap(), &local, &reference, &token)).unwrap();
    assert!(!shown.contains(KEY) && !shown.contains(TOKEN), "{shown}");
    assert_eq!((local.source, local.set, local.reference.as_deref()), ("local", true, None));
    assert_eq!((reference.source, reference.reference.as_deref()), ("1password", Some("op://Vault/OpenAI API/credential")));
    assert!(token.set && token.set_at.is_some());
    // The value is kept trimmed, and only `source` gives it, for injection.
    match store.source("anthropic").unwrap() {
        Some((Provider::Anthropic, Source::Local(secret))) => assert_eq!(secret.expose(), KEY),
        _ => panic!("the local key"),
    }
    assert_eq!(store.token_value().unwrap().unwrap().expose(), TOKEN);
    assert!(store.remove_token().unwrap() && !store.token().unwrap().set);
    assert!(store.remove("anthropic").unwrap() && !store.remove("anthropic").unwrap());
}

#[test]
fn a_value_never_reaches_text() {
    let secret = Secret::new(KEY.into());
    assert_eq!((format!("{secret}"), format!("{secret:?}")), ("[redacted]".to_string(), "[redacted]".to_string()));
    // A damaged file's error says where it broke, not what it holds.
    let (tmp, store) = store();
    fs::DirBuilder::new().mode(0o700).create(tmp.path().join(DIR)).unwrap();
    let file = tmp.path().join(DIR).join(FILE);
    fs::write(&file, format!("{{\"keys\":{{\"a\":{{\"source\":\"local\",\"provider\":\"anthropic\",\"value\":\"{KEY}\" BROKEN")).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let error = format!("{:#}", store.keys().unwrap_err());
    assert!(error.contains("not readable (line 1") && !error.contains(KEY), "{error}");
    // Nor does a refused value.
    let refused = format!("{:#}", Store::of(tmp.path()).put_local("b", Provider::Openai, Secret::new(format!("{KEY}\u{7}"))).unwrap_err());
    assert!(!refused.contains(KEY), "{refused}");
}

#[test]
fn ids_values_and_later_files_are_checked() {
    let (tmp, store) = store();
    for bad in ["", "Anthropic", "a/b", "-a", "a_b", &"x".repeat(49)] {
        assert!(store.put_local(bad, Provider::Anthropic, Secret::new(KEY.into())).is_err(), "id {bad:?}");
    }
    for bad in ["", "   ", "a\nb", &"x".repeat(MAX_VALUE + 1)] {
        assert!(store.put_local("a", Provider::Anthropic, Secret::new(bad.into())).is_err(), "value of {} bytes", bad.len());
    }
    assert!(!tmp.path().join(DIR).join(FILE).exists(), "nothing refused was written");
    store.put_local("a", Provider::Anthropic, Secret::new(KEY.into())).unwrap();
    let file = tmp.path().join(DIR).join(FILE);
    fs::write(&file, r#"{"version":2,"keys":{}}"#).unwrap();
    let error = format!("{:#}", store.put_token(Secret::new(TOKEN.into())).unwrap_err());
    assert!(error.contains("from a later Core (version 2)"), "{error}");
}

#[test]
fn backups_leave_the_folder_out_with_a_reason() {
    let reason = crate::workspace_backup::EXCLUDED.iter().find(|(name, _)| *name == DIR).map(|(_, why)| *why);
    assert!(reason.is_some_and(|why| why.contains("never copied")), "{reason:?}");
}
