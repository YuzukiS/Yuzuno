//! The protection resolver on synthetic environments: no real home is read.
use super::*;

fn env(os: Os, vars: &[(&'static str, &str)]) -> PathEnv {
    PathEnv { os: Some(os), vars: vars.iter().map(|(name, value)| (*name, OsString::from(value))).collect(), account_home: None, extra: Vec::new() }
}

fn normals(locations: &[Location]) -> Vec<&str> {
    locations.iter().map(|location| location.normal.as_str()).collect()
}

#[test]
fn the_defaults_are_under_the_credential_home_by_platform() {
    let linux = plan(&env(Os::Linux, &[("HOME", "/home/synthetic")])).unwrap();
    assert_eq!(normals(&linux.dirs), ["/home/synthetic/.ssh", "/home/synthetic/.gnupg", "/home/synthetic/.aws", "/home/synthetic/.config/gcloud",
        "/home/synthetic/.azure", "/home/synthetic/.kube", "/home/synthetic/.docker", "/home/synthetic/.config/gh",
        "/home/synthetic/.password-store", "/home/synthetic/.local/share/opencode", "/home/synthetic/.local/share/keyrings"]);
    assert_eq!(normals(&linux.files), ["/home/synthetic/.netrc", "/home/synthetic/.git-credentials", "/home/synthetic/.config/git/credentials",
        "/home/synthetic/.npmrc", "/home/synthetic/.pypirc", "/home/synthetic/.cargo/credentials", "/home/synthetic/.cargo/credentials.toml",
        "/home/synthetic/.codex/auth.json", "/home/synthetic/.claude/.credentials.json"]);
    let mac = plan(&env(Os::Mac, &[("HOME", "/Users/synthetic")])).unwrap();
    assert!(normals(&mac.dirs).contains(&"/Users/synthetic/Library/Keychains"));
    assert!(!normals(&mac.dirs).iter().any(|dir| dir.ends_with("keyrings")));
    assert!(!normals(&mac.files).iter().any(|file| file.ends_with(".credentials.json")), "Claude Code keeps it in the Keychain there");
    let unix = plan(&env(Os::Unix, &[("HOME", "/home/synthetic")])).unwrap();
    assert_eq!((unix.dirs.len(), unix.files.len()), (HOME_DIRS.len(), HOME_FILES.len()));
    assert_eq!((linux.credential_home.as_str(), linux.native_home.as_str(), linux.native_config.as_str()),
        ("/home/synthetic", "/home/synthetic", "/home/synthetic/.config/opencode"));
}

#[test]
fn an_override_adds_to_the_defaults_and_never_replaces_one() {
    let planned = plan(&env(Os::Linux, &[("HOME", "/home/synthetic"), ("GNUPGHOME", "/srv/gpg"), ("AZURE_CONFIG_DIR", "/srv/az"),
        ("GH_CONFIG_DIR", "/srv/gh"), ("CLOUDSDK_CONFIG", "/srv/gcloud"), ("DOCKER_CONFIG", "/srv/docker"), ("PASSWORD_STORE_DIR", "/srv/pass"),
        ("CODEX_HOME", "/srv/codex"), ("CARGO_HOME", "/srv/cargo"), ("XDG_CONFIG_HOME", "/srv/config"), ("XDG_DATA_HOME", "/srv/data"),
        ("AWS_CONFIG_FILE", "/srv/aws/config"), ("AWS_SHARED_CREDENTIALS_FILE", "/srv/aws/credentials"),
        ("NPM_CONFIG_USERCONFIG", "/srv/npm/user"), ("NPM_CONFIG_GLOBALCONFIG", "/srv/npm/global"),
        ("npm_config_userconfig", "/srv/npm/lower-user"), ("npm_config_globalconfig", "/srv/npm/lower-global"),
        ("KUBECONFIG", "/srv/kube/a::/srv/kube/b:")])).unwrap();
    let dirs = normals(&planned.dirs);
    let files = normals(&planned.files);
    for dir in ["/home/synthetic/.gnupg", "/srv/gpg", "/srv/az", "/srv/gh", "/srv/gcloud", "/srv/docker", "/srv/pass", "/home/synthetic/.config/gcloud",
        "/srv/config/gcloud", "/srv/config/gh", "/home/synthetic/.local/share/opencode", "/srv/data/opencode", "/srv/data/keyrings"] {
        assert!(dirs.contains(&dir), "{dir}");
    }
    for file in ["/home/synthetic/.codex/auth.json", "/srv/codex/auth.json", "/srv/cargo/credentials", "/srv/cargo/credentials.toml",
        "/home/synthetic/.cargo/credentials", "/srv/config/git/credentials", "/home/synthetic/.config/git/credentials", "/srv/aws/config",
        "/srv/aws/credentials", "/srv/npm/user", "/srv/npm/global", "/srv/npm/lower-user", "/srv/npm/lower-global", "/srv/kube/a", "/srv/kube/b"] {
        assert!(files.contains(&file), "{file}");
    }
    assert!(!dirs.contains(&"/srv/kube"), "KUBECONFIG's files, not their folders");
    assert_eq!(planned.native_config, "/srv/config/opencode");
}

#[test]
fn the_three_homes_are_kept_apart() {
    let planned = plan(&env(Os::Linux, &[("HOME", "/home/synthetic"), ("OPENCODE_TEST_HOME", "/srv/test-home"),
        ("OPENCODE_CONFIG_DIR", "/srv/opencode-config")])).unwrap();
    assert_eq!(planned.credential_home, "/home/synthetic");
    assert_eq!(planned.native_home, "/srv/test-home", "`~` in a tool's path");
    assert_eq!(planned.native_config, "/srv/opencode-config");
    assert!(normals(&planned.dirs).contains(&"/home/synthetic/.ssh"), "TEST_HOME moves no default protection");
    assert!(!normals(&planned.dirs).iter().any(|dir| dir.starts_with("/srv/test-home")));
    // An unset HOME is the account database's.
    let mut unset = env(Os::Linux, &[]);
    unset.account_home = Some(PathBuf::from("/home/account"));
    assert_eq!(plan(&unset).unwrap().credential_home, "/home/account");
    assert!(plan(&env(Os::Linux, &[])).unwrap_err().to_string().contains("HOME is unset"));
}

#[test]
fn empty_xdg_is_its_default_and_empty_kubeconfig_lists_nothing() {
    let planned = plan(&env(Os::Linux, &[("HOME", "/home/synthetic"), ("XDG_CONFIG_HOME", ""), ("XDG_DATA_HOME", ""), ("KUBECONFIG", "")])).unwrap();
    let defaults = plan(&env(Os::Linux, &[("HOME", "/home/synthetic")])).unwrap();
    assert_eq!(planned, defaults);
}

#[test]
fn an_empty_relative_or_unrepresentable_value_fails_the_whole_resolution() {
    let failing = [("HOME", ""), ("HOME", "home/synthetic"), ("OPENCODE_TEST_HOME", ""), ("OPENCODE_CONFIG_DIR", ""), ("GNUPGHOME", ""),
        ("GNUPGHOME", "relative/gpg"), ("GNUPGHOME", " /srv/gpg"), ("XDG_CONFIG_HOME", "relative"), ("CARGO_HOME", ""),
        ("AWS_CONFIG_FILE", "./config"), ("npm_config_userconfig", ""), ("KUBECONFIG", "/srv/a:relative"), ("DOCKER_CONFIG", "/srv/doc*er"),
        ("CODEX_HOME", "/srv/co?ex"), ("GH_CONFIG_DIR", "/srv/g\\h"), ("PASSWORD_STORE_DIR", "/srv/pa\nss"), ("GNUPGHOME", "/")];
    for (name, value) in failing {
        let mut vars = vec![("HOME", "/home/synthetic")];
        vars.retain(|(set, _)| *set != name);
        vars.push((name, value));
        assert!(plan(&env(Os::Linux, &vars)).is_err(), "{name}={value:?} must fail, not weaken");
    }
    // Not UTF-8.
    let mut odd = env(Os::Linux, &[("HOME", "/home/synthetic")]);
    {
        use std::os::unix::ffi::OsStringExt;
        odd.vars.insert("GNUPGHOME", OsString::from_vec(vec![b'/', 0xff]));
    }
    assert!(plan(&odd).unwrap_err().to_string().contains("not UTF-8"));
    // A routing key that would set one of them, by name only.
    let mut extra = env(Os::Linux, &[("HOME", "/home/synthetic")]);
    extra.extra = vec!["DEEPSEEK_API_KEY".into()];
    plan(&extra).unwrap();
    extra.extra.push("CODEX_HOME".into());
    assert!(plan(&extra).unwrap_err().to_string().contains("CODEX_HOME is set for this executor alone"));
}

#[test]
fn values_are_never_trimmed_and_are_made_normal() {
    let planned = plan(&env(Os::Linux, &[("HOME", "/home/synthetic/"), ("GNUPGHOME", "/srv/./x/../gpg/")])).unwrap();
    assert_eq!(planned.credential_home, "/home/synthetic");
    let gpg = planned.dirs.iter().find(|location| location.normal == "/srv/gpg").unwrap();
    assert_eq!(gpg.given, "/srv/./x/../gpg/", "the identity is read from the path as given");
    assert!(plan(&env(Os::Linux, &[("HOME", "/home/synthetic"), ("GNUPGHOME", "/srv/gpg ")])).unwrap().dirs.iter().any(|l| l.normal == "/srv/gpg "),
        "a trailing space is part of the path");
}

#[test]
fn the_parser_bounds_fail_the_whole_policy_never_truncate_it() {
    let long = format!("/{}", "a".repeat(VARIABLE_BYTES));
    assert!(plan(&env(Os::Linux, &[("HOME", "/home/synthetic"), ("GNUPGHOME", &long)])).unwrap_err().to_string().contains("bytes"));
    let near = format!("/{}", "b".repeat(VARIABLE_BYTES - 2));
    let many: Vec<(&'static str, &str)> = [("HOME", "/home/synthetic")].into_iter()
        .chain(["GNUPGHOME", "AZURE_CONFIG_DIR", "GH_CONFIG_DIR", "CLOUDSDK_CONFIG", "DOCKER_CONFIG"].map(|name| (name, near.as_str()))).collect();
    assert!(plan(&env(Os::Linux, &many)).unwrap_err().to_string().contains("in all"));
    let kube: Vec<String> = (0..=KUBECONFIG_ENTRIES).map(|n| format!("/k/{n}")).collect();
    let kube = kube.join(":");
    assert!(plan(&env(Os::Linux, &[("HOME", "/home/synthetic"), ("KUBECONFIG", &kube)])).unwrap_err().to_string().contains("KUBECONFIG lists"));
    let at_bound: Vec<String> = (0..KUBECONFIG_ENTRIES).map(|n| format!("/k/{n}")).collect();
    assert_eq!(plan(&env(Os::Linux, &[("HOME", "/home/synthetic"), ("KUBECONFIG", &at_bound.join(":"))])).unwrap().files.len(),
        HOME_FILES.len() + 1 + KUBECONFIG_ENTRIES);
    let path = format!("/{}", "c".repeat(PATH_BYTES));
    assert!(plan(&env(Os::Linux, &[("HOME", "/home/synthetic"), ("GNUPGHOME", &path)])).unwrap_err().to_string().contains("more than 4096"));
}

#[test]
fn identities_add_canonical_paths_and_keep_missing_ones_lexical() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(dir.path()).unwrap().join("home");
    let elsewhere = home.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(home.join(".config")).unwrap();
    std::fs::create_dir_all(elsewhere.join("ssh")).unwrap();
    // ~/.ssh is a link to a folder elsewhere; ~/.aws does not exist; ~/.netrc is a dangling link.
    symlink(elsewhere.join("ssh"), home.join(".ssh")).unwrap();
    symlink(elsewhere.join("gone"), home.join(".netrc")).unwrap();
    let home_text = home.to_str().unwrap();
    let planned = plan(&env(Os::Linux, &[("HOME", home_text)])).unwrap();
    let protection = identify(&planned).unwrap();
    let ssh = format!("{home_text}/.ssh");
    let real_ssh = elsewhere.join("ssh").to_str().unwrap().to_owned();
    assert!(protection.dirs.contains(&ssh) && protection.dirs.contains(&real_ssh), "both the normal and the canonical path");
    assert!(protection.dirs.contains(&format!("{home_text}/.aws")), "a missing default is still protected");
    assert!(protection.files.contains(&format!("{home_text}/.netrc")), "a link to nothing keeps its normal path");
    assert!(protection.len() <= ITEMS);
    // A link loop is not missing: the whole resolution fails.
    symlink(home.join(".kube"), home.join(".kube-loop")).unwrap();
    symlink(home.join(".kube-loop"), home.join(".kube")).unwrap();
    let looping = identify(&plan(&env(Os::Linux, &[("HOME", home_text)])).unwrap()).unwrap_err().to_string();
    assert!(looping.contains(".kube"), "{looping}");
}
