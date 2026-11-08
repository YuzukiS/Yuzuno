//! Routing accounts (YN-34 S1b) against stand-ins: a stub `cswap` that prints
//! a `list --json` answer, and a stub claude_swap package and claude for the
//! launcher. Synthetic accounts only; no claude-swap is installed or run.
use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

const LIST: &str = r#"{"schemaVersion":1,"activeAccountNumber":1,"accounts":[
 {"number":1,"email":"Person@Example.com","organizationName":null,"organizationUuid":null,"isOrganization":false,"active":true,"usageStatus":"ok","usage":{}},
 {"number":2,"email":"person@example.com","organizationName":"Team","organizationUuid":"org-1","isOrganization":true,"active":false,"usageStatus":"ok","usage":{},"alias":"team"},
 {"number":3,"email":"other@example.com","organizationUuid":null,"active":false,"usageStatus":"http-429","usage":null}
]}"#;

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, body).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

/// A stub cswap that answers `list --json` with `answer` and exits `code`.
fn cswap(dir: &Path, answer: &str, code: i32) -> String {
    fs::write(dir.join("answer.json"), answer).unwrap();
    let d = dir.display();
    script(dir, "cswap", &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{d}/args'\ncat '{d}/answer.json'\nexit {code}\n")).display().to_string()
}

#[test]
fn a_fingerprint_names_an_account_without_its_email() {
    let a = fingerprint("Person@Example.com ", None);
    assert_eq!(a, fingerprint("person@example.com", None), "case and spaces do not matter");
    assert_ne!(a, fingerprint("person@example.com", Some("org-1")), "another organization is another account");
    assert_eq!(a.len(), 16);
    assert!(!a.contains("person") && !a.contains('@'));
}

#[tokio::test]
async fn the_list_is_read_and_a_binding_resolves_at_each_launch() {
    let tmp = tempfile::tempdir().unwrap();
    let accounts = cswap_accounts(&cswap(tmp.path(), LIST, 0)).await.unwrap();
    assert_eq!(fs::read_to_string(tmp.path().join("args")).unwrap(), "list\n--json\n");
    assert_eq!(accounts.iter().map(|a| (a.number, a.active, a.label.as_str())).collect::<Vec<_>>(),
        [(1, true, "Person@Example.com"), (2, false, "team"), (3, false, "other@example.com")]);
    let personal = fingerprint("person@example.com", None);
    let team = fingerprint("person@example.com", Some("org-1"));
    // The host's current default login starts on the plain host login, not
    // through `cswap run --require-session`, which would refuse it.
    assert_eq!(resolve(&accounts, &personal), Launch::HostLogin);
    assert_eq!(resolve(&accounts, &team), Launch::Session { number: 2 });
    // Slots move: the same account under another number resolves to it.
    let moved = cswap_accounts(&cswap(tmp.path(), &LIST.replace(r#""number":2"#, r#""number":7"#), 0)).await.unwrap();
    assert_eq!(resolve(&moved, &team), Launch::Session { number: 7 });
    // An account no longer listed is gone: never another account instead.
    let without = cswap_accounts(&cswap(tmp.path(), &LIST.replace("org-1", "org-2"), 0)).await.unwrap();
    assert_eq!(resolve(&without, &team), Launch::Gone);
    assert_eq!(resolve(&[], &personal), Launch::Gone);
}

#[tokio::test]
async fn each_way_the_list_cannot_be_read_says_why_without_cswaps_words() {
    let tmp = tempfile::tempdir().unwrap();
    let error = r#"{"schemaVersion":1,"error":{"type":"AccountNotFound","message":"No account person@example.com"}}"#;
    let why = cswap_accounts(&cswap(tmp.path(), error, 1)).await.unwrap_err();
    assert_eq!((why.code, why.message.as_str()), ("cswapError", "cswap list refused: AccountNotFound"));
    assert!(!serde_json::to_string(&why).unwrap().contains("example.com"), "its message, which names the account, is not passed on");
    let why = cswap_accounts(&cswap(tmp.path(), r#"{"schemaVersion":2,"accounts":[]}"#, 0)).await.unwrap_err();
    assert_eq!(why.code, "cswapSchema");
    assert!(why.message.contains("schema 2") && why.message.contains("1.0.0"), "{}", why.message);
    let why = cswap_accounts(&cswap(tmp.path(), "Launching... not JSON", 0)).await.unwrap_err();
    assert_eq!((why.code, why.message_zh.as_str()), ("cswapFailed", "cswap list 没有给出账号列表（exit 0）"));
    let why = cswap_accounts(&tmp.path().join("no-such-cswap").display().to_string()).await.unwrap_err();
    assert_eq!(why.code, "cswapMissing");
    let slow = script(tmp.path(), "slow", "#!/bin/sh\nexec sleep 30\n");
    assert_eq!(cswap_accounts(&slow.display().to_string()).await.unwrap_err().code, "cswapTimeout");
}

#[test]
fn the_command_and_its_python_are_checked() {
    assert_eq!(check_command(" cswap ").unwrap(), "cswap");
    assert_eq!(check_command("/opt/tools/bin/cswap").unwrap(), "/opt/tools/bin/cswap");
    for bad in ["", "cswap list", "bin/cswap", "cs\nwap", "cswap\tx"] {
        assert!(check_command(bad).is_err(), "{bad:?}");
    }
    let tmp = tempfile::tempdir().unwrap();
    let console = script(tmp.path(), "cswap", "#!/opt/claude-swap/venv/bin/python3\nimport sys\n");
    assert_eq!(cswap_python(&console.display().to_string()).unwrap(), PathBuf::from("/opt/claude-swap/venv/bin/python3"));
    let shim = script(tmp.path(), "shim", "#!/bin/sh\nexec python3 -m claude_swap \"$@\"\n");
    let error = format!("{:#}", cswap_python(&shim.display().to_string()).unwrap_err());
    assert!(error.contains("not claude-swap's Python console script"), "{error}");
}

#[test]
fn codex_homes_are_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let ok = tmp.path().join("work");
    fs::create_dir(&ok).unwrap();
    fs::set_permissions(&ok, fs::Permissions::from_mode(0o700)).unwrap();
    let home = |id: &str, path: &Path| CodexHome { id: id.into(), label: "Work".into(), home: path.display().to_string() };
    check_homes(&[home("work", &ok)]).unwrap();
    let open = tmp.path().join("open");
    fs::create_dir(&open).unwrap();
    fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).unwrap();
    for (bad, why) in [
        (vec![home("work", &open)], "Other users can write"),
        (vec![home("work", &tmp.path().join("missing"))], "is not there"),
        (vec![home("Work", &ok)], "1 to 48"),
        (vec![home("work", &ok), home("work2", &ok)], "listed twice"),
        (vec![CodexHome { id: "rel".into(), label: "x".into(), home: "relative".into() }], "absolute"),
    ] {
        let error = format!("{:#}", check_homes(&bad).unwrap_err());
        assert!(error.contains(why), "{why}: {error}");
    }
}

/// The launcher, against a stub claude_swap package (whose `run` prints its
/// notice on stdout, as 1.0.0 does, then execs claude) and a stub claude.
#[test]
fn the_launcher_keeps_cswaps_notices_off_claudes_stdout() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    fs::create_dir_all(d.join("pkg/claude_swap")).unwrap();
    fs::write(d.join("pkg/claude_swap/__init__.py"), "").unwrap();
    fs::write(d.join("pkg/claude_swap/cli.py"), r#"import json, os, sys
def main():
    print("Launching Account-%s (person@example.com) [session mode]" % sys.argv[2])
    with open(os.environ["STUB_DIR"] + "/argv.json", "w") as f:
        json.dump(sys.argv, f)
    if sys.argv[2] == "9":
        print("Error: Account-9 is the active default login", file=sys.stderr)
        return 1
    claude = os.environ["STUB_CLAUDE"]
    os.execvpe(claude, [claude, *sys.argv[5:]], dict(os.environ, CLAUDE_CONFIG_DIR="/profiles/2"))
"#).unwrap();
    let claude = script(d, "claude", "#!/bin/sh\nprintf '{\"type\":\"system\",\"args\":\"%s\",\"config\":\"%s\"}\\n' \"$*\" \"$CLAUDE_CONFIG_DIR\"\n");
    let launcher = Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtimes/claude/cswap-claude");
    let run = |account: Option<&str>| {
        let mut command = std::process::Command::new(&launcher);
        command.args(["--print", "hi"]).env("YUZUNO_CSWAP_PYTHON", "/usr/bin/python3").env("PYTHONPATH", d.join("pkg"))
            .env("STUB_DIR", d).env("STUB_CLAUDE", &claude).env_remove("YUZUNO_CSWAP_ACCOUNT");
        if let Some(account) = account {
            command.env("YUZUNO_CSWAP_ACCOUNT", account);
        }
        command.output().unwrap()
    };
    let out = run(Some("2"));
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "{\"type\":\"system\",\"args\":\"--print hi\",\"config\":\"/profiles/2\"}\n",
        "stdout is Claude's alone");
    assert!(String::from_utf8_lossy(&out.stderr).contains("Launching Account-2"), "the notice went to stderr");
    let argv: Vec<String> = serde_json::from_str(&fs::read_to_string(d.join("argv.json")).unwrap()).unwrap();
    assert_eq!(argv, ["cswap", "run", "2", "--require-session", "--", "--print", "hi"]);
    // A refusal (the account is the default login) starts nothing and prints nothing on stdout.
    let refused = run(Some("9"));
    assert_eq!((refused.status.code(), refused.stdout.is_empty()), (Some(1), true));
    // Without an account the wrapper refuses before running anything.
    let none = run(None);
    assert!(!none.status.success() && none.stdout.is_empty());
}
