use super::*;
use crate::test_ports::free_port;
use crate::updates::{
    start::tests::{answer, compiled, held, install as installed, starts_seen},
    state::ReleaseRef,
};
#[cfg(target_os = "linux")]
use crate::updates::start::tests::alive;
use std::{os::unix::fs::PermissionsExt, sync::atomic::Ordering};

const REPOSITORY: &str = "YuzukiS/Yuzuno";
/// The releases tests' publisher key: a test key, not the real one.
fn key() -> &'static str {
    include_str!("../releases/fixtures/publisher.pub").lines().nth(1).unwrap()
}

/// Every path under `root` with its mode and, for a file, its contents.
fn snapshot(root: &Path) -> Vec<(PathBuf, u32, Option<Vec<u8>>)> {
    let mut seen = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                folders.push(path.clone());
            }
            seen.push((path.clone(), meta.permissions().mode(), meta.is_file().then(|| fs::read(&path).unwrap())));
        }
    }
    seen.sort();
    seen
}

fn state_and_code(outcome: &Value) -> (Option<&str>, Option<&str>) {
    (outcome["state"].as_str(), outcome["code"].as_str())
}

#[test]
fn a_signed_bundle_installs_as_a_new_installation_that_core_can_update() {
    let temp = tempfile::tempdir().unwrap();
    let bundle = package::fixture(&temp.path().join("stage/bundle"), "a");
    // Its parent is missing too, as ~/.local/share can be.
    let root = temp.path().join("share/yuzuno-core");
    let outcome = install(&root, &bundle.path, &bundle.manifest_sha256, "core-test", REPOSITORY, key());
    assert_eq!(
        outcome,
        json!({"state":"installed","releaseId":"a","installDir":fs::canonicalize(&root).unwrap(),"releaseSource":true})
    );
    assert_eq!(fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
    let layout = Layout::open(&root).unwrap();
    let current: ReleaseRef = serde_json::from_slice(&fs::read(root.join("current.json")).unwrap()).unwrap();
    assert_eq!(current.release_id, "a");
    layout.release(&current).unwrap();
    // Core reads the release source as it would have written it.
    releases::read_source(&layout).unwrap();
    assert_eq!(fs::metadata(root.join("release-source.json")).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(root.join("release-source.json")).unwrap()).unwrap(),
        json!({"repository":REPOSITORY,"publicKey":key()})
    );
    // Installing there again changes nothing.
    let before = snapshot(&root);
    let other = package::fixture(&temp.path().join("stage-b/bundle"), "b");
    let again = install(&root, &other.path, &other.manifest_sha256, "core-test", REPOSITORY, key());
    assert_eq!(state_and_code(&again), (Some("refused"), Some("installed")), "{again}");
    assert_eq!(snapshot(&root), before);
}

#[test]
fn an_invalid_source_or_folder_writes_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let bundle = package::fixture(&temp.path().join("stage/bundle"), "a");
    let root = temp.path().join("share/yuzuno-core");
    for (repository, public_key) in [
        ("https://github.com/YuzukiS/Yuzuno", key()),
        ("YuzukiS", key()),
        ("YuzukiS/Yuzuno/releases", key()),
        (REPOSITORY, "not a key"),
        (REPOSITORY, ""),
    ] {
        let outcome = install(&root, &bundle.path, &bundle.manifest_sha256, "core-test", repository, public_key);
        assert_eq!(state_and_code(&outcome), (Some("refused"), Some("invalidSource")), "{repository} {public_key}: {outcome}");
    }
    let outcome = install(Path::new("share/yuzuno-core"), &bundle.path, &bundle.manifest_sha256, "core-test", REPOSITORY, key());
    assert_eq!(state_and_code(&outcome), (Some("refused"), Some("invalidInstallDir")), "{outcome}");
    assert!(!temp.path().join("share").exists());
}

#[test]
fn a_failed_registration_removes_only_a_folder_it_made() {
    let temp = tempfile::tempdir().unwrap();
    let bundle = package::fixture(&temp.path().join("stage/bundle"), "a");
    let wrong = "0".repeat(64);
    // Made by this install: removed, and only it.
    let root = temp.path().join("share/yuzuno-core");
    let outcome = install(&root, &bundle.path, &wrong, "core-test", REPOSITORY, key());
    assert_eq!(state_and_code(&outcome), (Some("failed"), Some("register")), "{outcome}");
    assert_eq!(outcome["cleaned"], true);
    assert!(!root.exists() && temp.path().join("share").is_dir());
    // A file the signed manifest does not list: refused the same way.
    fs::write(bundle.path.join("web/extra.js"), "unlisted").unwrap();
    let outcome = install(&root, &bundle.path, &bundle.manifest_sha256, "core-test", REPOSITORY, key());
    assert_eq!((state_and_code(&outcome), &outcome["cleaned"]), ((Some("failed"), Some("register")), &json!(true)), "{outcome}");
    assert!(!root.exists());
    fs::remove_file(bundle.path.join("web/extra.js")).unwrap();
    // There before, with the user's own file: kept as it was.
    let own = temp.path().join("own");
    fs::create_dir(&own).unwrap();
    fs::set_permissions(&own, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(own.join("notes.txt"), "mine").unwrap();
    let before = snapshot(&own);
    let outcome = install(&own, &bundle.path, &wrong, "core-test", REPOSITORY, key());
    assert_eq!((state_and_code(&outcome), &outcome["cleaned"]), ((Some("failed"), Some("register")), &json!(false)), "{outcome}");
    assert_eq!(snapshot(&own), before);
    // A link where the folder would be: registering fails after the bundle
    // checked out, and the link stays.
    let link = temp.path().join("link");
    std::os::unix::fs::symlink(temp.path().join("nowhere"), &link).unwrap();
    let outcome = install(&link, &bundle.path, &bundle.manifest_sha256, "core-test", REPOSITORY, key());
    assert_eq!((state_and_code(&outcome), &outcome["cleaned"]), ((Some("failed"), Some("register")), &json!(false)), "{outcome}");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert!(!temp.path().join("nowhere").exists());
}

#[test]
fn only_a_folder_this_install_made_without_a_release_is_removed() {
    let temp = tempfile::tempdir().unwrap();
    let folder = |name: &str| {
        let path = temp.path().join(name);
        fs::create_dir(&path).unwrap();
        fs::write(path.join("file"), "kept").unwrap();
        path
    };
    let not_made = folder("not-made");
    assert_eq!(remove_if_made(&not_made, false), (false, None));
    let installed = folder("installed");
    fs::write(installed.join("current.json"), "{}").unwrap();
    assert_eq!(remove_if_made(&installed, true), (false, None));
    let link = temp.path().join("link");
    std::os::unix::fs::symlink(folder("target"), &link).unwrap();
    assert_eq!(remove_if_made(&link, true), (false, None));
    assert!(not_made.join("file").exists() && installed.join("file").exists() && temp.path().join("target/file").exists());
    let made = folder("made");
    assert_eq!(remove_if_made(&made, true), (true, None));
    assert!(!made.exists());
}

#[test]
fn a_release_source_that_cannot_be_written_leaves_the_installation() {
    let temp = tempfile::tempdir().unwrap();
    let bundle = package::fixture(&temp.path().join("stage/bundle"), "a");
    let root = temp.path().join("yuzuno-core");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    // A folder in the way of the file.
    fs::create_dir_all(root.join("release-source.json/inside")).unwrap();
    let outcome = install(&root, &bundle.path, &bundle.manifest_sha256, "core-test", REPOSITORY, key());
    assert_eq!((outcome["state"].as_str(), &outcome["releaseSource"]), (Some("installed"), &json!(false)), "{outcome}");
    assert!(outcome["releaseSourceError"].as_str().is_some_and(|error| !error.is_empty()), "{outcome}");
    assert!(root.join("current.json").is_file());
}

/// A stand-in login shell named `name` in `dir`: it notes its arguments in
/// `<dir>/args`, sets `last` to the command it was given, then runs `body`.
fn fake_shell(dir: &Path, name: &str, body: &str) -> PathBuf {
    let shells = dir.join("shells");
    fs::create_dir_all(&shells).unwrap();
    let path = shells.join(name);
    let args = dir.join("args");
    fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > {args:?}\nfor last; do :; done\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}
fn arguments_seen(dir: &Path) -> Option<Vec<String>> {
    Some(fs::read_to_string(dir.join("args")).ok()?.lines().map(str::to_owned).collect())
}
/// A profile that prints around the command, sets a value too long to keep
/// and a secret that is not one of the names kept, and adds to PATH.
const PROFILE: &str = r#"printf 'Welcome\n\0PATH=/before-the-mark\0'
CODEX_HOME=/home/u/.codex GH_TOKEN=secret-token CLAUDE_CONFIG_DIR="$(printf '%09000d' 0)" PATH="/home/u/.local/bin:$PATH" /bin/sh -c "$last"
printf '\0PATH=/after-the-mark\0bye'"#;

#[test]
fn the_login_shells_environment_is_read_between_its_marks_and_only_the_kept_names() {
    let temp = tempfile::tempdir().unwrap();
    let shell = fake_shell(temp.path(), "bash", PROFILE);
    let environment = login_environment(&shell, temp.path(), Duration::from_secs(10));
    assert_eq!((environment.source, environment.note), ("loginShell", None));
    let seen = arguments_seen(temp.path()).unwrap();
    assert_eq!(seen[..3], ["-i", "-l", "-c"]);
    assert_eq!(environment.values["CODEX_HOME"], "/home/u/.codex");
    assert!(environment.values["PATH"].starts_with("/home/u/.local/bin:"), "{:?}", environment.values);
    assert!(!environment.values.contains_key("GH_TOKEN"));
    assert!(!environment.values.contains_key("CLAUDE_CONFIG_DIR"), "longer than MAX_VALUE");
    assert!(environment.values.keys().all(|name| start::ENVIRONMENT.contains(&name.as_str())));
    // csh and tcsh take their options together.
    let shell = fake_shell(temp.path(), "tcsh", PROFILE);
    let environment = login_environment(&shell, temp.path(), Duration::from_secs(10));
    assert_eq!(environment.source, "loginShell");
    assert_eq!(arguments_seen(temp.path()).unwrap()[..1], ["-ic"]);
}

#[test]
fn a_shell_that_cannot_be_read_falls_back_to_this_processs_environment() {
    let temp = tempfile::tempdir().unwrap();
    let inherited: BTreeMap<String, String> = start::ENVIRONMENT
        .iter()
        .filter_map(|name| Some((name.to_string(), std::env::var(name).ok().filter(|value| value.len() <= start::MAX_VALUE)?)))
        .collect();
    // Not one of the shells it knows the options of: never run.
    let shell = fake_shell(temp.path(), "nu", PROFILE);
    let environment = login_environment(&shell, temp.path(), Duration::from_secs(10));
    assert_eq!((environment.source, environment.note), ("inherited", Some("unsupportedShell")));
    assert_eq!(environment.values, inherited);
    assert_eq!(arguments_seen(temp.path()), None);
    // It prints no marks.
    let shell = fake_shell(temp.path(), "zsh", "printf 'PATH=/x\\0'; exit 1");
    let environment = login_environment(&shell, temp.path(), Duration::from_secs(10));
    assert_eq!((environment.source, environment.note), ("inherited", Some("noMarkers")));
    // It is not there.
    let environment = login_environment(&temp.path().join("missing/bash"), temp.path(), Duration::from_secs(10));
    assert_eq!((environment.source, environment.note), ("inherited", Some("spawnFailed")));
    assert_eq!(environment.values, inherited);
}

fn pid_in(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(pid) = fs::read_to_string(path).ok().and_then(|text| text.trim().parse().ok()) {
            return pid;
        }
        assert!(Instant::now() < deadline, "{} was not written", path.display());
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn gone(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while crate::updates::state::ProcessIdentity::read(pid).is_ok() {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
}

#[test]
fn a_shell_that_does_not_finish_is_ended_with_everything_in_its_group() {
    let temp = tempfile::tempdir().unwrap();
    let (shell_pid, child_pid) = (temp.path().join("shell-pid"), temp.path().join("child-pid"));
    let body = format!("echo $$ > {shell_pid:?}\nsleep 60 &\necho $! > {child_pid:?}\nsleep 60");
    let shell = fake_shell(temp.path(), "bash", &body);
    let asked = Instant::now();
    let environment = login_environment(&shell, temp.path(), Duration::from_secs(1));
    assert!(asked.elapsed() < Duration::from_secs(5), "{:?}", asked.elapsed());
    assert_eq!((environment.source, environment.note), ("inherited", Some("timeout")));
    assert!(gone(pid_in(&shell_pid)), "the shell is still running");
    assert!(gone(pid_in(&child_pid)), "what the shell started is still running");
}

#[test]
fn a_program_the_profile_leaves_running_does_not_hold_up_the_environment() {
    let temp = tempfile::tempdir().unwrap();
    let child_pid = temp.path().join("child-pid");
    // It keeps the shell's output open after the shell has exited.
    let shell = fake_shell(temp.path(), "bash", &format!("sleep 30 &\necho $! > {child_pid:?}\n/bin/sh -c \"$last\""));
    let asked = Instant::now();
    let environment = login_environment(&shell, temp.path(), Duration::from_secs(10));
    let child = crate::updates::state::ProcessIdentity::read(pid_in(&child_pid));
    if let Ok(child) = &child {
        // Left running, as a terminal would leave it; ended here.
        if child.executable.file_name().is_some_and(|name| name == "sleep") {
            let _ = rustix::process::kill_process(rustix::process::Pid::from_raw(child.pid as i32).unwrap(), rustix::process::Signal::KILL);
        }
    }
    assert_eq!((environment.source, environment.note), ("loginShell", None));
    assert!(asked.elapsed() < Duration::from_secs(5), "{:?}", asked.elapsed());
    assert!(environment.values.contains_key("PATH"));
}

#[test]
fn marks_end_only_after_envs_last_entry() {
    let mark = b"0123456789abcdef";
    let output = |parts: &[&[u8]]| parts.concat();
    assert_eq!(between_marks(&output(&[b"noise", mark, mark, b"tail"]), mark), Some((21, 21)));
    let text = output(&[b"noise", mark, b"A=1\0B=x", mark, b"y\0", mark, b"tail", mark]);
    let (from, to) = between_marks(&text, mark).unwrap();
    assert_eq!(&text[from..to], b"A=1\0B=x0123456789abcdefy\0");
    assert_eq!(between_marks(&output(&[b"noise", mark, b"A=1\0"]), mark), None);
    assert_eq!(between_marks(b"no marks", mark), None);
}

const QUICK: FirstBudget = FirstBudget {
    lock: Duration::from_secs(5),
    port: Duration::from_secs(2),
    shell: Duration::from_secs(10),
    ready: Duration::from_secs(20),
};

/// A first start of `install`'s Core on `port`, with its data and working
/// folders made.
fn request(install: &crate::updates::start::tests::Install, port: u16) -> FirstStart {
    let data_dir = install.temp.path().join("data");
    let cwd = install.temp.path().join("home");
    fs::create_dir_all(&data_dir).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    FirstStart { root: install.layout.root.clone(), port, data_dir, cwd, codex: None }
}

#[cfg(target_os = "linux")]
#[test]
fn a_new_installation_starts_with_the_login_shells_environment_and_records_it() {
    let install = installed();
    compiled(&install, "yuzuno-workspace");
    let port = free_port();
    let request = request(&install, port);
    let shell = fake_shell(install.temp.path(), "bash", PROFILE);
    let outcome = first_start_with(&request, &shell, QUICK);
    let core = held(&outcome);
    assert_eq!(
        outcome,
        json!({"state":"started","pid":outcome["pid"],"releaseId":"a","workspaceId":"workspace-1","port":port,
            "installDir":install.layout.root,"recorded":true,"environment":"loginShell","shell":shell}),
    );
    let seen = starts_seen(&request.data_dir.join("started"));
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["pid"], outcome["pid"]);
    assert_eq!(
        seen[0]["argv"],
        json!(["--install-dir", install.layout.root, "--port", port.to_string(), "--data-dir", request.data_dir, "--cwd", request.cwd, "--codex", "codex"])
    );
    assert_eq!(seen[0]["env"]["CODEX_HOME"], "/home/u/.codex");
    assert!(seen[0]["env"]["PATH"].as_str().unwrap().starts_with("/home/u/.local/bin:"), "{}", seen[0]);
    // It recorded how it started, so `start` takes over from here.
    let record = start::read_record(&install.layout).unwrap();
    assert_eq!((record.port, record.workspace_id.as_str()), (port, "workspace-1"));
    let budget = start::Budget { lock: QUICK.lock, ready: QUICK.ready };
    assert_eq!(start::start(&install.layout.root, port, "workspace-1", budget)["state"], "running");
    let again = first_start_with(&request, &shell, QUICK);
    assert_eq!(
        again,
        json!({"state":"refused","code":"recorded","message":again["message"],"port":port,"workspaceId":"workspace-1"})
    );
    assert!(alive(&core));
    assert_eq!(starts_seen(&request.data_dir.join("started")).len(), 1);
}

#[test]
fn a_first_start_without_the_login_shells_environment_says_so() {
    let install = installed();
    compiled(&install, "yuzuno-workspace");
    let request = request(&install, free_port());
    let shell = fake_shell(install.temp.path(), "nu", PROFILE);
    let outcome = first_start_with(&request, &shell, QUICK);
    let _core = held(&outcome);
    assert_eq!(outcome["state"], "started", "{outcome}");
    assert_eq!((&outcome["environment"], &outcome["environmentNote"]), (&json!("inherited"), &json!("unsupportedShell")));
    assert_eq!(starts_seen(&request.data_dir.join("started"))[0]["env"]["CODEX_HOME"], json!(std::env::var("CODEX_HOME").ok()));
}

#[test]
fn a_first_start_refuses_what_it_cannot_start_and_starts_nothing() {
    let install = installed();
    compiled(&install, "yuzuno-workspace");
    let shell = fake_shell(install.temp.path(), "bash", PROFILE);
    let port = free_port();
    let base = request(&install, port);
    let releases = install.layout.root.join("releases");
    let into_releases = install.temp.path().join("into-releases");
    std::os::unix::fs::symlink(&releases, &into_releases).unwrap();
    let elsewhere = install.temp.path().join("not-an-install");
    fs::create_dir(&elsewhere).unwrap();
    let cases: Vec<(FirstStart, &str)> = vec![
        (FirstStart { root: elsewhere.clone(), ..request(&install, port) }, "notInstalled"),
        (FirstStart { root: PathBuf::from("relative/core"), ..request(&install, port) }, "notInstalled"),
        (FirstStart { port: 0, ..request(&install, port) }, "invalidPort"),
        (FirstStart { data_dir: PathBuf::from("data"), ..request(&install, port) }, "invalidDataDir"),
        (FirstStart { data_dir: base.data_dir.join("../data"), ..request(&install, port) }, "invalidDataDir"),
        (FirstStart { data_dir: releases.join("a/data"), ..request(&install, port) }, "invalidDataDir"),
        (FirstStart { data_dir: install.layout.root.join("incoming/data"), ..request(&install, port) }, "invalidDataDir"),
        (FirstStart { data_dir: into_releases.join("new/data"), ..request(&install, port) }, "invalidDataDir"),
        (FirstStart { cwd: PathBuf::from("home"), ..request(&install, port) }, "invalidCwd"),
        (FirstStart { cwd: install.temp.path().join("missing"), ..request(&install, port) }, "invalidCwd"),
    ];
    for (request, code) in cases {
        let outcome = first_start_with(&request, &shell, QUICK);
        assert_eq!(state_and_code(&outcome), (Some("refused"), Some(code)), "{}: {outcome}", request.data_dir.display());
    }
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0, "nothing was made where no installation is");
    // Something on the port: another Workspace's Core, or another program.
    let (taken, stop) = answer(r#"{"product":"yuzuno","workspaceId":"workspace-2","apiReady":true}"#);
    let outcome = first_start_with(&FirstStart { port: taken, ..request(&install, port) }, &shell, QUICK);
    stop.store(true, Ordering::SeqCst);
    assert_eq!(
        (state_and_code(&outcome), &outcome["workspaceId"]),
        ((Some("refused"), Some("coreOnPort")), &json!("workspace-2")),
        "{outcome}"
    );
    let (taken, stop) = answer(r#"{"status":"ok"}"#);
    let outcome = first_start_with(&FirstStart { port: taken, ..request(&install, port) }, &shell, QUICK);
    stop.store(true, Ordering::SeqCst);
    assert_eq!(state_and_code(&outcome), (Some("refused"), Some("portInUse")), "{outcome}");
    // Refused before the login shell ran or Core started, and nothing recorded.
    assert_eq!(arguments_seen(install.temp.path()), None);
    assert!(starts_seen(&base.data_dir.join("started")).is_empty());
    assert!(start::read_record(&install.layout).is_none());
}

#[cfg(target_os = "linux")]
#[test]
fn a_first_start_whose_core_exits_or_is_slow_says_so() {
    let install = installed();
    compiled(&install, "yuzuno-workspace");
    let shell = fake_shell(install.temp.path(), "bash", PROFILE);
    let request = request(&install, free_port());
    fs::write(request.data_dir.join("exit-early"), "").unwrap();
    let outcome = first_start_with(&request, &shell, QUICK);
    assert_eq!(state_and_code(&outcome), (Some("failed"), Some("exited")), "{outcome}");
    assert!(outcome["log"].as_str().is_some_and(|log| log.contains("exits early")), "{outcome}");
    // Nothing recorded: the next first start is not refused.
    assert!(start::read_record(&install.layout).is_none());
    fs::remove_file(request.data_dir.join("exit-early")).unwrap();
    // Running but not answering within the wait: said, and left running.
    fs::write(request.data_dir.join("no-listen"), "").unwrap();
    let outcome = first_start_with(&request, &shell, FirstBudget { ready: Duration::from_secs(1), ..QUICK });
    let core = held(&outcome);
    assert_eq!(outcome, json!({"state":"starting","pid":outcome["pid"],"releaseId":"a","port":request.port}));
    assert!(alive(&core), "the slow Core was stopped");
    assert_eq!(starts_seen(&request.data_dir.join("started")).len(), 2);
}
