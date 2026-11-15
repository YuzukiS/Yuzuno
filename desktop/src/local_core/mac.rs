//! The Mac app's local Core back end (YN-108 design 4.2 and 4.3): the
//! connection page's macOS target, its read-only check, and installing,
//! starting and stopping Core on this Mac.
//!
//! What it trusts, and nothing else: the signed release `release.rs` verifies
//! (platform `macos-aarch64`), the installed release's own `yuzuno-update-
//! helper` (which checks every file against the signed manifest again), and
//! the paths this file's rules pass. Every program runs as one fixed
//! executable with each value as an argument of its own; no shell is
//! involved anywhere, so a path may hold spaces and non-ASCII characters.
//!
//! The quarantine attribute is checked and never removed: a release unpacked
//! with it stops the install with `quarantined`. Unpacking with `/usr/bin/tar`
//! does not pass it on, so this should never happen for the app's own
//! download; if it does, macOS may refuse to run the program and this app
//! does not turn Gatekeeper off for it.
//!
//! `local_core_targets` answers one target, `this-mac`; on an Intel Mac it is
//! not selectable (Apple silicon is all Core releases have). `check` gathers
//! the facts with Foundation and one fixed script on the login shell's PATH;
//! install downloads into a temporary file beside the install folder, unpacks
//! it there, registers it, starts it the first time, saves it confirmed and
//! opens it.

use super::{
    check_rules::{self, Found, Item, Level, Port, State},
    Cancellable, Check, CheckItem, Defaults, Error, Installation, LocalCore, Place, Progress, Target, Targets,
};
use crate::connection::{self, StartOutcome, StartPlatform, StartProfile};
use serde::Deserialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, Manager, WebviewWindow};

/// The one target the page shows on this Mac.
pub const TARGET_ID: &str = "this-mac";
/// The release platform the Mac app installs.
pub const PLATFORM: &str = "macos-aarch64";
const LABEL: &str = "这台 Mac / This Mac";
const NOTE_INTEL: &str = "暂不支持 Intel Mac / Intel Macs aren't supported yet";
/// The install and data folders the user chose (YN-108 design 5, item 4):
/// `~/Library/Application Support/yuzuno/managed-core` and `.../workspace`,
/// the managed install location Core itself recognizes.
const INSTALL_SUFFIX: &str = "Library/Application Support/yuzuno/managed-core";
const DATA_SUFFIX: &str = "Library/Application Support/yuzuno/workspace";
const XCODE_SELECT: &str = "/usr/bin/xcode-select";
const DSCL: &str = "/usr/bin/dscl";
const TAR: &str = "/usr/bin/tar";
const XATTR: &str = "/usr/bin/xattr";
/// The fixed script the tools check runs (design 4.2).
const TOOLS: &str = include_str!("mac_check.sh");

mod waits {
    use super::Duration;
    /// Reading the login shell's PATH, as `first-start` reads its environment.
    pub const LOGIN: Duration = Duration::from_secs(10);
    /// The tools script, including `gh auth status`; only what it printed
    /// before the wait is read.
    pub const TOOLS: Duration = Duration::from_secs(10);
    pub const COPY: Duration = Duration::from_secs(10 * 60);
    pub const INSTALL: Duration = Duration::from_secs(5 * 60);
    /// A first start answers once Core is up: the helper waits up to two
    /// minutes, and Core usually answers in one or two seconds.
    pub const FIRST_START: Duration = Duration::from_secs(60);
    /// A start of a recorded installation; the helper's own wait is two
    /// minutes, as in WSL.
    pub const START: Duration = Duration::from_secs(180);
    pub const STOP: Duration = Duration::from_secs(180);
}

/// The Mac's one target. `selectable` is false on an Intel Mac: Core is
/// released for Apple silicon only (YN-161).
pub fn targets() -> Targets {
    let selectable = cfg!(target_arch = "aarch64");
    Targets {
        platform: Some("macos"),
        available: true,
        reason: None,
        message: None,
        targets: vec![Target {
            id: TARGET_ID.into(),
            label: LABEL.into(),
            kind: "macos",
            selectable,
            is_default: true,
            running: true,
            boot: "running",
            boot_detail: None,
            note: (!selectable).then(|| NOTE_INTEL.to_owned()),
        }],
    }
}

/// The read-only check with the default folders.
pub fn check(port: Port) -> Check {
    check_at(None, None, port)
}

/// The read-only check for `install` and `data` (the defaults when absent)
/// and a port the app looked for. It reads, changes and creates nothing.
pub fn check_at(install: Option<&str>, data: Option<&str>, port: Port) -> Check {
    let (user, home) = account();
    let install = install.map(str::to_owned).unwrap_or_else(|| format!("{home}/{INSTALL_SUFFIX}"));
    let data = data.map(str::to_owned).unwrap_or_else(|| format!("{home}/{DATA_SUFFIX}"));
    let clt = clt_present();
    let facts = Facts {
        user,
        home,
        arm64: cfg!(target_arch = "aarch64"),
        macos: macos_version(),
        clt,
        tools: tools(clt),
        port,
        install,
        data,
    };
    judge(&facts)
}

/// The account's name and home folder, from Foundation (design 4.2).
fn account() -> (String, String) {
    use objc2_foundation::{NSHomeDirectory, NSUserName};
    let user = NSUserName().to_string();
    let mut home = NSHomeDirectory().to_string();
    while home.len() > 1 && home.ends_with('/') {
        home.pop();
    }
    (user, home)
}

/// The macOS version the app runs on, as (major, minor).
fn macos_version() -> Option<(u32, u32)> {
    use objc2_foundation::NSProcessInfo;
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    Some((u32::try_from(version.majorVersion).ok()?, u32::try_from(version.minorVersion).ok()?))
}

/// Whether Xcode's command line tools are installed. `/usr/bin/xcode-select
/// -p` fails when they are not.
fn clt_present() -> bool {
    Command::new(XCODE_SELECT)
        .arg("-p")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// A program's version line, or whether it was found at all: `None` when the
/// check did not report it, `Some("-")` when the PATH has no such program,
/// `Some("?")` when it was not run.
type Tool = Option<String>;

/// What the tools script printed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tools {
    node: Tool,
    git: Tool,
    gh: Tool,
    gh_auth: Tool,
    claude: Tool,
    codex: Tool,
    /// Why the login shell's PATH could not be read, when it could not.
    path_note: Option<String>,
}

/// Reads the login shell's PATH and runs the fixed tools script with it, as
/// the login shell would find the tools. A login shell that does not answer
/// within its wait (a profile that hangs) leaves the tools unknown, not the
/// check failed: they are recommended items.
fn tools(clt: bool) -> Tools {
    let (user, _) = account();
    let shell = login_shell(&user);
    let path = login_path(&shell);
    let mut note = None;
    if path.is_none() {
        note = Some(format!("the login shell ({shell}) did not give its PATH within {} seconds", waits::LOGIN.as_secs()));
    }
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(TOOLS).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(path) = &path {
        command.env("PATH", path);
    }
    if !clt {
        // `/usr/bin/git` is Xcode's stand-in and would open Apple's installer.
        command.env("YUZUNO_CHECK_GIT", "0");
    }
    let Some(mut child) = command.spawn().ok() else {
        return Tools { path_note: Some("the tools check could not run".into()), ..Tools::default() };
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Tools { path_note: Some("the tools check could not run".into()), ..Tools::default() };
    };
    let (sender, chunks) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 16 * 1024];
        let mut stdout = stdout;
        while let Ok(read @ 1..) = stdout.read(&mut buffer) {
            if sender.send(buffer[..read].to_vec()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + waits::TOOLS;
    let mut output = Vec::new();
    let mut done = false;
    while !done && output.len() <= 64 * 1024 {
        match chunks.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(chunk) => {
                output.extend_from_slice(&chunk);
                done = String::from_utf8_lossy(&output).lines().any(|line| line.trim_end_matches('\r') == "done=1");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let mut tools = parse_tools(&String::from_utf8_lossy(&output));
    tools.path_note = note;
    tools
}

/// The `key=value` lines the tools script printed.
pub fn parse_tools(text: &str) -> Tools {
    let mut tools = Tools::default();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let Some((key, value)) = line.split_once('=') else { continue };
        let slot = match key {
            "tool.node" => &mut tools.node,
            "tool.git" => &mut tools.git,
            "tool.gh" => &mut tools.gh,
            "gh.auth" => &mut tools.gh_auth,
            "tool.claude" => &mut tools.claude,
            "tool.codex" => &mut tools.codex,
            _ => continue,
        };
        *slot = Some(value.chars().take(200).collect());
    }
    tools
}

/// The account's login shell, from `dscl` (design 4.2); `/bin/zsh` when it
/// cannot be read or is not a program on this Mac.
fn login_shell(user: &str) -> String {
    let path = format!("/Users/{user}");
    let read = Command::new(DSCL).args([".", "-read", &path, "UserShell"]).output();
    if let Ok(output) = read {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let Some((key, value)) = line.split_once(':') else { continue };
                if key.trim() != "UserShell" {
                    continue;
                }
                let shell = value.trim();
                if shell.starts_with('/') && !shell.chars().any(char::is_control) && Path::new(shell).is_file() {
                    return shell.to_owned();
                }
            }
        }
    }
    "/bin/zsh".into()
}

/// The PATH the login shell has, read once as `first-start` reads its whole
/// environment: a random marker around `env -0`, a 10-second wait, and the
/// shell's process group ended then (it leads its group; killing it is the
/// most this app can do without a Rust process-group API on the Mac).
fn login_path(shell: &str) -> Option<String> {
    let options: &[&str] = match Path::new(shell).file_name().and_then(|name| name.to_str()) {
        Some("bash" | "zsh" | "sh" | "dash" | "ksh" | "mksh" | "fish") => &["-i", "-l", "-c"],
        Some("csh" | "tcsh") => &["-ic"],
        _ => return None,
    };
    let mark = marker();
    let script = format!("printf '%s' {mark}; /usr/bin/env -0; printf '%s' {mark}");
    let mut child = Command::new(shell)
        .args(options)
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (sender, chunks) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        let mut stdout = stdout;
        while let Ok(read @ 1..) = stdout.read(&mut buffer) {
            if sender.send(buffer[..read].to_vec()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + waits::LOGIN;
    let mut output = Vec::new();
    let mut found = None;
    while found.is_none() && output.len() <= 256 * 1024 {
        match chunks.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(chunk) => {
                output.extend_from_slice(&chunk);
                found = between_marks(&output, mark.as_bytes());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let (from, to) = found?;
    output[from..to]
        .split(|byte| *byte == 0)
        .filter_map(|entry| std::str::from_utf8(entry).ok()?.split_once('='))
        .find(|(name, _)| *name == "PATH")
        .map(|(_, value)| value.to_owned())
}

/// Where env's output is in `output`: after the first `mark`, up to the mark
/// that follows the NUL ending its last entry (or comes at once when there
/// are none). A mark inside a value does not end it early.
fn between_marks(output: &[u8], mark: &[u8]) -> Option<(usize, usize)> {
    let find = |from: usize| output.get(from..)?.windows(mark.len()).position(|window| window == mark).map(|at| at + from);
    let start = find(0)? + mark.len();
    let mut from = start;
    while let Some(at) = find(from) {
        if at == start || output[at - 1] == 0 {
            return Some((start, at));
        }
        from = at + 1;
    }
    None
}

/// A marker the shell's own startup output cannot already contain.
fn marker() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_nanos()).unwrap_or(0);
    let pid = u128::from(std::process::id());
    format!("y{:016x}{:04x}z", nanos, pid & 0xffff)
}

/// The check's facts, gathered once.
struct Facts {
    user: String,
    home: String,
    arm64: bool,
    macos: Option<(u32, u32)>,
    clt: bool,
    tools: Tools,
    port: Port,
    install: String,
    data: String,
}

/// What is at the installation folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Root {
    Absent,
    Installed,
    /// An installation whose `current.json` this app cannot read.
    Unreadable,
    /// Something that is not a Yuzuno installation.
    Other,
}

/// The check, from the facts it gathered: every item of the shared table
/// this platform has, in its order (design 4.1, part 3).
fn judge(facts: &Facts) -> Check {
    use {Level::Recommended, Level::Required, State::*};
    let item = |id, level, state, detail: Option<String>| Item { id, level, state, detail };
    let note = facts.tools.path_note.as_deref().map(|why| format!(" ({why})")).unwrap_or_default();
    let mut items = Vec::new();

    items.push(if facts.arm64 {
        item("arch", Required, Ok, Some("Apple silicon".into()))
    } else {
        item(
            "arch",
            Required,
            Missing,
            Some("This Mac is Intel (x86_64); Core is released for Apple silicon Macs only.".into()),
        )
    });

    items.push(match facts.macos {
        Some((major, minor)) if major >= 11 => item("macos", Required, Ok, Some(format!("{major}.{minor}"))),
        Some((major, minor)) => item("macos", Required, Missing, Some(format!("macOS {major}.{minor}; Core needs macOS 11 or newer."))),
        None => item("macos", Required, Unknown, None),
    });

    let (installation, found) = installation(facts);
    items.push(paths(facts, found));

    items.push(match facts.port {
        Port::Free(port) => item("port", Required, Ok, Some(port.to_string())),
        Port::NoneFree => item(
            "port",
            Required,
            Missing,
            Some(format!(
                "Ports {}–{} are all in use or saved for other workspaces.",
                check_rules::MAC_PORTS.start(),
                check_rules::MAC_PORTS.end()
            )),
        ),
        Port::Unknown(ref why) => item("port", Required, Unknown, Some(why.clone())),
    });

    items.push(if facts.clt {
        item("clt", Recommended, Ok, None)
    } else {
        item(
            "clt",
            Recommended,
            Missing,
            Some("Xcode's command line tools are not installed (/usr/bin/xcode-select -p fails).".into()),
        )
    });

    items.push(match tool(&facts.tools.node) {
        None | Some("?") => item("node", Recommended, Unknown, None),
        Some("-") => item("node", Recommended, Missing, Some(format!("Not found on the login shell's PATH{note}."))),
        Some(version) => match check_rules::major_minor(version) {
            Some((major, _)) if major >= 20 => item("node", Recommended, Ok, Some(version.to_owned())),
            Some(_) => item("node", Recommended, Missing, Some(format!("{version}; Claude Agents need Node.js 20 or newer."))),
            None => item("node", Recommended, Unknown, Some(version.to_owned())),
        },
    });

    for (id, value, missing) in [
        ("git", &facts.tools.git, "Not found on the login shell's PATH"),
        ("claude", &facts.tools.claude, "Not found on the login shell's PATH"),
        ("codex", &facts.tools.codex, "Not found on the login shell's PATH"),
    ] {
        items.push(match tool(value) {
            None | Some("?") => item(id, Recommended, Unknown, None),
            Some("-") => item(id, Recommended, Missing, Some(format!("{missing}{note}."))),
            Some(version) => item(id, Recommended, Ok, Some(version.to_owned())),
        });
    }

    items.push(match (tool(&facts.tools.gh), tool(&facts.tools.gh_auth)) {
        (None, _) | (Some("?"), _) => item("gh", Recommended, Unknown, None),
        (Some("-"), _) => item("gh", Recommended, Missing, Some(format!("gh is not found on the login shell's PATH{note}."))),
        (Some(_), Some("0")) => item("gh", Recommended, Ok, None),
        (Some(_), Some("-")) => item("gh", Recommended, Missing, Some("gh is not signed in to github.com (gh auth login).".into())),
        (Some(_), Some(other)) if other != "?" => {
            item("gh", Recommended, Missing, Some(format!("gh auth status failed (exit code {other}).")))
        }
        (Some(_), _) => item("gh", Recommended, Unknown, None),
    });

    let defaults = Defaults {
        install_dir: facts.install.clone(),
        data_dir: facts.data.clone(),
        port: match facts.port {
            Port::Free(port) => port,
            _ => *check_rules::MAC_PORTS.start(),
        },
    };
    let installable = check_rules::installable(&items, found);
    Check {
        target: TARGET_ID.into(),
        platform: "macos",
        user: facts.user.clone(),
        home: facts.home.clone(),
        checks: items.into_iter().map(CheckItem::from).collect(),
        installation,
        defaults,
        installable,
    }
}

fn tool(value: &Tool) -> Option<&str> {
    value.as_deref()
}

/// The installation in the install folder, and what the check made of it.
fn installation(facts: &Facts) -> (Option<Installation>, Found) {
    match root_state(&facts.install) {
        (Root::Absent, _) => (None, Found::Nothing),
        (Root::Installed, installation) => (installation, Found::Installation),
        (Root::Unreadable, _) | (Root::Other, _) => (None, Found::Unreadable),
    }
}

/// What is at `root`: a Yuzuno installation (its `current.json` read), a
/// folder that is something else, or one whose record cannot be read.
fn root_state(root: &str) -> (Root, Option<Installation>) {
    let path = Path::new(root);
    let Ok(meta) = fs::symlink_metadata(path) else { return (Root::Absent, None) };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return (Root::Other, None);
    }
    let current_path = path.join("current.json");
    if fs::symlink_metadata(&current_path).is_err() {
        return (Root::Other, None);
    }
    let Some(current) = read_json::<Current>(&current_path, 4096) else { return (Root::Unreadable, None) };
    if !check_rules::release_id_ok(&current.release_id) {
        return (Root::Unreadable, None);
    }
    let recorded = read_json::<Launch>(&path.join("updates/launch.json"), 65536)
        .filter(|launch| launch.port >= 1024 && check_rules::workspace_id_ok(&launch.workspace_id))
        // Its start entry is what starts a recorded installation.
        .filter(|_| executable(&path.join("updates/start")));
    let installation = Installation {
        install_dir: root.to_owned(),
        release_id: current.release_id,
        port: recorded.as_ref().map(|launch| launch.port),
        workspace_id: recorded.map(|launch| launch.workspace_id),
        recorded: false,
    };
    let installation = Installation { recorded: installation.port.is_some(), ..installation };
    (Root::Installed, Some(installation))
}

fn executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// `current.json`: only the release is read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Current {
    release_id: String,
}

/// `updates/launch.json`: only where it ran and with which Workspace is read;
/// the environment it recorded and the rest are dropped unread.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Launch {
    port: u16,
    workspace_id: String,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, limit: u64) -> Option<T> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// The `paths` item: the folders follow the Mac's rules, and what is in them
/// can take an installation (design 4.2).
fn paths(facts: &Facts, found: Found) -> Item {
    let item = |state, detail: Option<String>| Item { id: "paths", level: Level::Required, state, detail };
    let (home, install, data) = (facts.home.as_str(), facts.install.as_str(), facts.data.as_str());
    if !check_rules::mac_path_shape_ok(home) {
        return item(State::Missing, Some(format!("The home folder {home:?} is not a path this app uses.")));
    }
    for (what, path) in [("install", install), ("data", data)] {
        if !check_rules::mac_path_ok(path, home) {
            return item(
                State::Missing,
                Some(format!(
                    "The {what} folder {path:?} is not a path this app uses on this Mac: an absolute path inside your home folder, not under Desktop, Documents, Downloads, iCloud or /Volumes."
                )),
            );
        }
    }
    if check_rules::same_or_nested(install, data) {
        return item(State::Missing, Some("The install and data folders must be apart, neither inside the other.".into()));
    }
    match found {
        Found::Nothing | Found::Installation => {}
        Found::Unreadable => {
            let detail = if Path::new(install).join("current.json").exists() {
                format!("{install} has an installation whose current.json this app cannot read.")
            } else {
                format!("{install} exists but is not a Yuzuno installation.")
            };
            return item(State::Missing, Some(detail));
        }
    }
    // Core's own check of a managed root: this user's, and not writable by
    // anyone else (core/src/updates/state.rs, `Layout::open`).
    if let (Ok(meta), Ok(home_meta)) = (fs::metadata(install), fs::metadata(home)) {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != home_meta.uid() || meta.mode() & 0o022 != 0 {
            return item(
                State::Missing,
                Some(format!("{install} must be owned by you and not writable by other users.")),
            );
        }
    }
    match data_state(data) {
        (State::Ok, None) => item(State::Ok, None),
        (state, detail) => item(state, detail),
    }
}

/// Whether the data folder can hold a Workspace: absent or empty is fine,
/// one holding a Workspace is opened as it is, anything else is not.
fn data_state(data: &str) -> (State, Option<String>) {
    let path = Path::new(data);
    let Ok(meta) = fs::symlink_metadata(path) else { return (State::Ok, None) };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return (State::Missing, Some(format!("{data} exists and is not a folder.")));
    }
    if path.join("workspace.lock").exists() || path.join("workspace.sqlite").exists() {
        return (State::Ok, Some(format!("{data} holds a workspace, which Core will open.")));
    }
    match fs::read_dir(path).ok().and_then(|mut entries| entries.next()) {
        None => (State::Ok, None),
        Some(_) => (
            State::Missing,
            Some(format!("{data} exists and holds something other than a Yuzuno workspace.")),
        ),
    }
}

/// One run program's output, kept to a limit.
struct Output {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Reads a pipe to its end, keeping the first `limit` bytes; the rest is read
/// and dropped, so the program never waits on a full pipe.
fn drain(pipe: Option<impl Read + Send + 'static>, limit: u64) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.by_ref().take(limit).read_to_end(&mut kept);
            let _ = std::io::copy(&mut pipe, &mut std::io::sink());
        }
        kept
    })
}

/// Runs `program` with `arguments`, each one argument, and no shell. After
/// `wait` it is stopped and that is an error.
fn run(program: &Path, arguments: &[&str], wait: Duration, limit: u64) -> Result<Output, String> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot run {}: {error}", program.display()))?;
    let stdout = drain(child.stdout.take(), limit);
    let stderr = drain(child.stderr.take(), 64 * 1024);
    let deadline = Instant::now() + wait;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if stdout.is_finished() && stderr.is_finished() => {
                return Ok(Output {
                    success: status.success(),
                    code: status.code(),
                    stdout: stdout.join().unwrap_or_default(),
                    stderr: stderr.join().unwrap_or_default(),
                })
            }
            Ok(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} gave no answer within {} seconds.", program.display(), wait.as_secs()));
            }
            Err(error) => return Err(format!("Cannot wait for {}: {error}", program.display())),
        }
    }
}

/// What a command that prints a one-line JSON result came to.
enum Said {
    Result(String),
    Ended(String, Option<i32>),
    Unanswered,
}

/// Runs `program` and reads its output until `is_result` accepts a line, it
/// ends, or `wait` is over. The Mac's helper returns once it has printed;
/// nothing needs to stay, unlike `wsl.exe` keeping a distribution running.
fn until_result(program: &Path, arguments: &[&str], wait: Duration, is_result: impl Fn(&str) -> bool) -> Result<Said, Error> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Error::new("startFailed", format!("Cannot run {}: {error}", program.display())))?;
    fn read_all(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(64 * 1024).read_to_end(&mut bytes);
            }
            bytes
        })
    }
    let stderr = read_all(child.stderr.take());
    let (lines, arriving) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut stdout = BufReader::new(stdout.take(64 * 1024));
            let mut line = Vec::new();
            while matches!(stdout.read_until(b'\n', &mut line), Ok(read) if read > 0) {
                if lines.send(String::from_utf8_lossy(&line).into_owned()).is_err() {
                    break;
                }
                line.clear();
            }
        });
    }
    let deadline = Instant::now() + wait;
    let mut output = String::new();
    loop {
        match arriving.recv_timeout(Duration::from_millis(200)) {
            Ok(line) if is_result(&line) => return Ok(Said::Result(line)),
            Ok(line) => output.push_str(&line),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= deadline {
            return Ok(Said::Unanswered);
        }
    }
    let ending = Instant::now() + Duration::from_secs(5);
    while (matches!(child.try_wait(), Ok(None)) || !stderr.is_finished()) && Instant::now() < ending {
        std::thread::sleep(Duration::from_millis(100));
    }
    if stderr.is_finished() {
        output.push('\n');
        output.push_str(&String::from_utf8_lossy(&stderr.join().unwrap_or_default()));
    }
    let code = child.try_wait().ok().flatten().and_then(|status| status.code());
    Ok(Said::Ended(output, code))
}

/// A temporary file or folder of this install, removed on every way out.
struct TempPath {
    path: PathBuf,
    dir: bool,
}

impl TempPath {
    fn file(path: PathBuf) -> Self {
        Self { path, dir: false }
    }

    fn dir(path: PathBuf) -> Self {
        Self { path, dir: true }
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        if self.dir {
            let _ = fs::remove_dir_all(&self.path);
        } else {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Eight letters or digits, for one install's temporary names.
fn suffix() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_nanos()).unwrap_or(0);
    let pid = u128::from(std::process::id());
    format!("{:016x}", nanos ^ (pid << 64)).chars().take(8).collect()
}

fn refs(arguments: &[String]) -> Vec<&str> {
    arguments.iter().map(String::as_str).collect()
}

async fn blocking<T: Send + 'static>(code: &'static str, work: impl FnOnce() -> Result<T, Error> + Send + 'static) -> Result<T, Error> {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(Error::new(code, error.to_string())),
    }
}

/// Downloads, verifies, unpacks, registers and starts the latest release on
/// this Mac (design 4.2, parts 1 to 5). Progress goes to `on_progress`;
/// `local_core_cancel` stops it until the release is unpacked.
pub async fn install(
    window: &WebviewWindow,
    local: &LocalCore,
    target: &Target,
    checked: &Check,
    place: Place,
    progress: &Channel<Progress>,
) -> Result<String, Error> {
    if target.id != TARGET_ID {
        return Err(Error::new("unknownTarget", "The Mac app installs Core on this Mac only."));
    }
    let send = |update: Progress| {
        let _ = progress.send(update);
    };
    let cancel = Cancellable::open(local)?;
    let mut receiver = cancel.receiver.clone();

    // The folders and port as they are now: the same check, for these.
    super::port_free(window, place.port).await?;
    let now = {
        let (install_dir, data_dir, port) = (place.install_dir.clone(), place.data_dir.clone(), place.port);
        blocking("checkFailed", move || Ok(check_at(Some(&install_dir), Some(&data_dir), Port::Free(port)))).await?
    };
    if now.user != checked.user || now.home != checked.home {
        return Err(Error::new("checkChanged", "The account changed since it was checked. Check it again."));
    }
    if !now.installable {
        return Err(super::not_installable(&now));
    }

    // The release: found, its descriptor verified, its archive downloaded
    // into a file beside the install folder (the same volume).
    send(Progress::phase("release"));
    let client = super::release::Client::new()?;
    let found = super::release::choose(&client.releases(&mut receiver).await?, PLATFORM)?;
    send(Progress { detail: Some(found.tag.clone()), ..Progress::phase("release") });
    let descriptor = client.download(&found.descriptor, super::release::SMALL_WAIT, &mut receiver, &mut |_| {}).await?;
    let signature = client.download(&found.signature, super::release::SMALL_WAIT, &mut receiver, &mut |_| {}).await?;
    let signature = String::from_utf8(signature).map_err(|_| Error::new("signature", "The release signature cannot be read."))?;
    let verified = super::release::verify_descriptor(
        super::release::public_key(),
        &descriptor,
        &signature,
        PLATFORM,
        &found.tag,
        found.archive.size,
    )?;
    cancel.check()?;

    let parent = Path::new(&place.install_dir)
        .parent()
        .ok_or_else(|| Error::new("invalidPath", "The install folder has no parent folder."))?
        .to_path_buf();
    let download = parent.join(format!(".yuzuno-download-{}", suffix()));
    let staging = parent.join(format!(".yuzuno-core-install.{}", suffix()));
    // Both go on every way out, the successful one included.
    let _download_guard = TempPath::file(download.clone());
    let _staging_guard = TempPath::dir(staging.clone());
    if !parent.exists() {
        let folder = parent.clone();
        blocking("copyFailed", move || {
            fs::create_dir_all(&folder)
                .and_then(|()| fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)))
                .map_err(|error| Error::new("copyFailed", format!("Cannot make {}: {error}", folder.display())))
        })
        .await?;
    }

    send(Progress::bytes("download", 0, found.archive.size));
    let total = found.archive.size;
    let mut told = 0;
    client
        .download_archive(&found.archive, &verified, &download, super::release::ARCHIVE_WAIT, &mut receiver, &mut |done| {
            if done - told >= 1 << 20 || done == total {
                told = done;
                send(Progress::bytes("download", done, total));
            }
        })
        .await?;
    send(Progress::phase("verify"));
    cancel.check()?;

    send(Progress::phase("copy"));
    let (archive, stage) = (download.clone(), staging.clone());
    blocking("copyFailed", move || unpack(&archive, &stage)).await?;
    cancel.end();

    let stage_for_check = staging.clone();
    let quarantined = blocking("copyFailed", move || quarantined(&stage_for_check)).await?;
    if let Some(file) = quarantined {
        return Err(Error::new(
            "quarantined",
            format!(
                "{file} unpacked with the quarantine attribute, which macOS uses to block programs; nothing was installed. This app does not remove it, and does not turn Gatekeeper off."
            ),
        ));
    }

    send(Progress::phase("register"));
    let (stage, root, expected) = (staging.clone(), place.install_dir.clone(), verified.clone());
    let installed = blocking("installFailed", move || register(&stage, &root, &expected)).await?;
    let place = Place { install_dir: installed.install_dir.clone(), ..place };
    if let Ok(mut placed) = local.placed.lock() {
        *placed = Some((target.id.clone(), place.clone()));
    }

    send(Progress::phase("start"));
    let started = {
        let (installed, place, home) = (installed, place.clone(), now.home.clone());
        blocking("startFailed", move || first_start(&installed, &place, &home)).await?
    };
    send(Progress { detail: started.note.clone(), ..Progress::phase("open") });
    open(window, &started, place.port).await
}

/// Unpacks the verified archive with `/usr/bin/tar`, an absolute program
/// with each path one argument (design 4.2, part 2). It does not pass the
/// quarantine attribute on.
fn unpack(archive: &Path, staging: &Path) -> Result<(), Error> {
    fs::DirBuilder::new()
        .recursive(false)
        .mode(0o700)
        .create(staging)
        .map_err(|error| Error::new("copyFailed", format!("Cannot make {}: {error}", staging.display())))?;
    let (archive, staging) = (archive.to_string_lossy(), staging.to_string_lossy());
    let output = run(
        Path::new(TAR),
        &["-xzf", archive.as_ref(), "-C", staging.as_ref()],
        waits::COPY,
        256 * 1024,
    )
    .map_err(|why| Error::new("copyFailed", why))?;
    if !output.success {
        return Err(Error::new(
            "copyFailed",
            format!(
                "Unpacking the release failed: {}.",
                super::said(&String::from_utf8_lossy(&output.stdout), &String::from_utf8_lossy(&output.stderr))
            ),
        ));
    }
    Ok(())
}

/// The first file under `unpacked/bin` with the quarantine attribute, if
/// any. `/usr/bin/xattr -p` prints the value and succeeds only when it is
/// there; the attribute is reported and never removed.
fn quarantined(unpacked: &Path) -> Result<Option<String>, Error> {
    let bin = unpacked.join("bin");
    let entries = fs::read_dir(&bin)
        .map_err(|error| Error::new("copyFailed", format!("The release has no bin folder ({}): {error}", bin.display())))?;
    let mut files = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|error| Error::new("copyFailed", format!("Cannot read {}: {error}", bin.display())))?
            .path();
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
            files.push(path);
        }
    }
    if files.is_empty() {
        return Err(Error::new("copyFailed", format!("The release has no programs in {}.", bin.display())));
    }
    for file in files {
        let file = file.to_string_lossy();
        let output = run(Path::new(XATTR), &["-p", "com.apple.quarantine", file.as_ref()], Duration::from_secs(10), 4096)
            .map_err(|why| Error::new("copyFailed", format!("Cannot check the quarantine attribute: {why}")))?;
        if output.success && !output.stdout.is_empty() {
            return Ok(Some(file.into_owned()));
        }
    }
    Ok(None)
}

/// The unpacked release's own helper installs it (core/src/updates/setup.rs).
fn register(staging: &Path, root: &str, verified: &super::release::Verified) -> Result<super::Installed, Error> {
    let bundle = staging.to_string_lossy().into_owned();
    let sha = &verified.manifest_sha256;
    let sha_ok = sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit());
    let key = super::release::public_key();
    if !sha_ok
        || !super::release::tag_ok(&verified.tag)
        || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
    {
        return Err(Error::new("releaseInvalid", "The release's checksum, tag or key is not one this app passes on."));
    }
    let helper = staging.join("bin/yuzuno-update-helper");
    let output = run(
        &helper,
        &[
            "install",
            "--install-dir",
            root,
            "--bundle",
            bundle.as_str(),
            "--manifest-sha256",
            sha.as_str(),
            "--reviewed-source",
            verified.tag.as_str(),
            "--repository",
            super::release::REPOSITORY,
            "--public-key",
            key,
        ],
        waits::INSTALL,
        64 * 1024,
    )
    .map_err(|why| Error::new("installFailed", why))?;
    super::installed(
        output.code,
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
        check_rules::mac_path_shape_ok,
    )
}

/// The installed release's helper starts its Core the first time, with the
/// login shell's environment and Core's own working folder.
fn first_start(installed: &super::Installed, place: &Place, home: &str) -> Result<super::Started, Error> {
    let helper = Path::new(&installed.install_dir)
        .join("releases")
        .join(&installed.release_id)
        .join("bin/yuzuno-update-helper");
    let port = place.port.to_string();
    let arguments = [
        "first-start",
        "--install-dir",
        installed.install_dir.as_str(),
        "--port",
        port.as_str(),
        "--data-dir",
        place.data_dir.as_str(),
        "--cwd",
        home,
    ];
    match until_result(&helper, &arguments, waits::FIRST_START, |line| crate::connection::start_result_line(line).is_some())? {
        Said::Result(line) => super::first_started(
            &crate::connection::start_result_line(&line).unwrap_or_default(),
            place.port,
            check_rules::mac_path_shape_ok,
        ),
        Said::Ended(output, code) => Err(super::first_start_ended(
            &output,
            code,
            "Start Core from the connection page once a newer release is installed, or update it.",
        )),
        Said::Unanswered => Err(Error::new(
            "starting",
            "Yuzuno's start gave no answer within a minute. Core may still be starting: use Start in a moment. Nothing was stopped.",
        )),
    }
}

/// Opens what a first start started, saved as a confirmed entry named for
/// this Mac.
async fn open(window: &WebviewWindow, started: &super::Started, port: u16) -> Result<String, Error> {
    let core = super::loopback(port)?;
    let profile = StartProfile::macos(&core, &started.install_dir, &started.workspace_id)
        .ok_or_else(|| Error::new("openFailed", "Core started, but what it said about itself is not something this app saves."))?;
    crate::open_first_started(window, &profile, &crate::entries::name_for_mac())
        .await
        .map_err(|message| Error::new("openFailed", message))
}

/// Starts the installation the latest check found: as its start record
/// says, or, when it never started, its first start.
pub async fn start_found(
    window: &WebviewWindow,
    local: &LocalCore,
    checked: &Check,
    installation: &Installation,
) -> Result<String, Error> {
    let name = crate::entries::name_for_mac();
    if let (true, Some(port), Some(workspace)) = (installation.recorded, installation.port, installation.workspace_id.as_deref()) {
        // Started before: as its record says, like a saved start.
        let profile = StartProfile::macos(&super::loopback(port)?, &installation.install_dir, workspace)
            .ok_or_else(|| Error::new("startFailed", "The installation's start record is not one this app uses."))?;
        return crate::start_found(window, &profile, &name).await.map_err(|message| Error::new("startFailed", message));
    }
    // Installed, never started: its first start, with the folder and port
    // the latest installation from this window gave it, else the check's.
    let placed = local.placed.lock().map_err(|_| super::unavailable())?.clone();
    let place = match placed {
        Some((id, place)) if id == TARGET_ID && place.install_dir == installation.install_dir => place,
        _ => super::choose_place(checked, &installation.install_dir, &checked.defaults.data_dir, checked.defaults.port)?,
    };
    super::port_free(window, place.port).await?;
    let installed = super::Installed { release_id: installation.release_id.clone(), install_dir: installation.install_dir.clone() };
    let port = place.port;
    let started = {
        let (installed, place, home) = (installed, place.clone(), checked.home.clone());
        blocking("startFailed", move || first_start(&installed, &place, &home)).await?
    };
    open(window, &started, port).await
}

/// Starts `profile`'s Core on this Mac and reads its entry's answer.
pub async fn start(profile: &StartProfile) -> StartOutcome {
    let Some(arguments) = profile.mac_arguments("start") else {
        return StartOutcome::Failed("This app can start only a Core on this Mac that it installed or read here.".into());
    };
    let Some((program, rest)) = arguments.split_first() else {
        return StartOutcome::Failed("This app has no start entry for that Core.".into());
    };
    let (program, rest) = (PathBuf::from(program.as_str()), rest.to_vec());
    let outcome = blocking("startFailed", move || {
        until_result(&program, &refs(&rest), waits::START, |line| connection::start_result_line(line).is_some())
    })
    .await;
    match outcome {
        Ok(Said::Result(line)) => connection::start_result(profile, &line),
        Ok(Said::Ended(output, _)) => connection::start_result(profile, &output),
        Ok(Said::Unanswered) => StartOutcome::Unanswered,
        Err(error) => StartOutcome::Failed(error.message),
    }
}

/// Stops `profile`'s Core through its installation's own `stop`: it asks
/// Core to shut down and never kills it. `Ok` only when Core stopped or was
/// not running; otherwise the entry's own words.
pub fn stop(profile: &StartProfile) -> Result<(), String> {
    let Some(arguments) = profile.mac_arguments("stop") else {
        return Err("This app can stop only a Core on this Mac that it installed.".into());
    };
    let Some((program, rest)) = arguments.split_first() else {
        return Err("This app has no stop entry for that Core.".into());
    };
    let output = run(Path::new(program), &refs(rest), waits::STOP, 64 * 1024)?;
    let text = String::from_utf8_lossy(&output.stdout);
    let result = text.lines().rev().find_map(connection::start_result_line).ok_or_else(|| {
        let said = String::from_utf8_lossy(&output.stderr);
        let said = said.lines().chain(text.lines()).map(str::trim).find(|line| !line.is_empty()).unwrap_or("no result");
        format!("The stop entry gave no result ({said}).")
    })?;
    match result["state"].as_str() {
        Some("stopped" | "notRunning") => Ok(()),
        _ => {
            let message = result["message"].as_str().unwrap_or("").trim();
            Err(if message.is_empty() { "Core was not stopped.".into() } else { message.to_owned() })
        }
    }
}

/// The start the Workspace menu's stop item may stop: this Mac's, confirmed,
/// and the one the selected Workspace is at.
fn confirmed_mac_start(app: &tauri::AppHandle) -> Option<StartProfile> {
    let state = app.state::<crate::ConnectionState>();
    let start = state.start.lock().ok()?.clone()?;
    let selected = state.selected.lock().ok()?.clone();
    (start.platform == StartPlatform::Macos && start.confirmed && selected.as_ref() == Some(&start.core)).then_some(start)
}

/// Offers the stop item only where it can act: a confirmed Core on this Mac
/// for the selected Workspace (design 4.3).
pub fn update_stop_item(app: &tauri::AppHandle) {
    let Some(menu) = app.menu() else { return };
    let Some(tauri::menu::MenuItemKind::MenuItem(item)) = menu.get("stop-local-core") else { return };
    let _ = item.set_enabled(confirmed_mac_start(app).is_some());
}

/// Runs the menu item's stop after the click, off the event loop. Nothing
/// asks first (the user's choice); a failure says so in the window.
pub fn stop_now(app: &tauri::AppHandle) {
    let Some(profile) = confirmed_mac_start(app) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(message) = stop(&profile) {
            crate::show_notice(&app, &format!("Yuzuno Core was not stopped. {message}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            user: "someone".into(),
            home: "/Users/someone".into(),
            arm64: true,
            macos: Some((27, 0)),
            clt: true,
            tools: parse_tools(
                "format=1\ntool.node=v22.11.0\ntool.git=git version 2.43.0\ntool.gh=gh version 2.45.0\ngh.auth=0\n\
                 tool.claude=2.1.3 (Claude Code)\ntool.codex=codex-cli 0.80.0\ndone=1\n",
            ),
            port: Port::Free(4317),
            install: "/Users/someone/Library/Application Support/yuzuno/managed-core".into(),
            data: "/Users/someone/Library/Application Support/yuzuno/workspace".into(),
        }
    }

    fn state<'a>(check: &'a Check, id: &str) -> (&'static str, Option<&'a str>) {
        let item = check.checks.iter().find(|item| item.id == id).unwrap_or_else(|| panic!("no {id}"));
        (item.state, item.detail.as_deref())
    }

    #[test]
    fn one_target_this_mac_and_an_intel_one_is_not_selectable() {
        let value = serde_json::to_value(targets()).unwrap();
        assert_eq!(value["platform"], "macos");
        assert_eq!(value["available"], true);
        let listed = &value["targets"][0];
        assert_eq!(listed["id"], "this-mac");
        assert_eq!(listed["kind"], "macos");
        assert_eq!(listed["isDefault"], true);
        assert_eq!(listed["running"], true);
        assert_eq!(listed["selectable"], cfg!(target_arch = "aarch64"));
        if cfg!(not(target_arch = "aarch64")) {
            assert!(listed["note"].as_str().unwrap().contains("Intel Mac"));
        }
    }

    #[test]
    fn the_check_has_the_shared_shape_and_this_platforms_items() {
        let check = judge(&facts());
        let value = serde_json::to_value(&check).unwrap();
        let ids: Vec<_> = check.checks.iter().map(|item| item.id).collect();
        assert_eq!(ids, ["arch", "macos", "paths", "port", "clt", "node", "git", "claude", "codex", "gh"]);
        let required: Vec<_> = check.checks.iter().filter(|item| item.level == "required").map(|item| item.id).collect();
        assert_eq!(required, ["arch", "macos", "paths", "port"]);
        assert_eq!(value["platform"], "macos");
        assert_eq!(value["target"], "this-mac");
        assert_eq!(value["user"], "someone");
        assert_eq!(value["home"], "/Users/someone");
        assert_eq!(value["installation"], serde_json::Value::Null);
        assert_eq!(value["installable"], true);
        assert_eq!(
            value["defaults"],
            serde_json::json!({
                "installDir": "/Users/someone/Library/Application Support/yuzuno/managed-core",
                "dataDir": "/Users/someone/Library/Application Support/yuzuno/workspace",
                "port": 4317,
            })
        );
        assert_eq!(state(&check, "arch"), ("ok", Some("Apple silicon")));
        assert_eq!(state(&check, "macos"), ("ok", Some("27.0")));
        assert_eq!(state(&check, "node").0, "ok");
        assert_eq!(state(&check, "gh").0, "ok");
    }

    #[test]
    fn the_required_items_stop_an_install_and_the_recommended_ones_do_not() {
        let mut old = facts();
        old.arm64 = false;
        old.macos = Some((10, 15));
        let check = judge(&old);
        assert_eq!(state(&check, "arch").0, "missing");
        assert_eq!(state(&check, "macos").0, "missing");
        assert!(!check.installable);

        let mut recommended = facts();
        recommended.clt = false;
        recommended.tools = parse_tools("format=1\ntool.node=v18.19.0\ntool.git=-\ntool.gh=-\ngh.auth=-\ntool.claude=-\ntool.codex=?\ndone=1\n");
        let check = judge(&recommended);
        for id in ["clt", "node", "git", "gh", "claude"] {
            assert_eq!(state(&check, id).0, "missing", "{id}");
        }
        assert_eq!(state(&check, "codex").0, "unknown");
        assert!(check.installable, "recommended items never stop an install");
    }

    #[test]
    fn folders_outside_the_home_or_in_a_guarded_one_are_refused() {
        for (install, data) in [
            ("/Users/someone/Desktop/core", "/Users/someone/Library/Application Support/yuzuno/workspace"),
            ("/Users/someone/Library/Mobile Documents/core", "/Users/someone/data"),
            ("/Volumes/External/core", "/Volumes/External/data"),
            ("/Users/someone/core", "/Users/someone/core/data"),
            ("/Users/someone", "/Users/someone/data"),
            ("relative/core", "/Users/someone/data"),
        ] {
            let mut f = facts();
            f.install = install.into();
            f.data = data.into();
            let check = judge(&f);
            assert_eq!(state(&check, "paths").0, "missing", "{install} {data}");
            assert!(!check.installable, "{install} {data}");
        }
        // Spaces and non-ASCII are allowed: paths are one argument each.
        let mut f = facts();
        f.install = "/Users/someone/我的 Core/managed core".into();
        f.data = "/Users/someone/我的 Core/工作区".into();
        assert_eq!(state(&judge(&f), "paths").0, "ok");
    }

    #[test]
    fn the_port_comes_from_the_app() {
        for (port, expected) in [
            (Port::Free(4320), "ok"),
            (Port::NoneFree, "missing"),
            (Port::Unknown("cannot tell".into()), "unknown"),
        ] {
            let mut f = facts();
            f.port = port;
            assert_eq!(state(&judge(&f), "port").0, expected);
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yuzuno-mac-check-{name}-{}", suffix()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    #[test]
    fn an_installation_is_read_with_and_without_a_start_record() {
        let root = temp("installed");
        let home = root.to_str().unwrap().to_owned();
        let install = format!("{home}/managed-core");
        let data = format!("{home}/workspace");
        write(Path::new(&format!("{install}/current.json")), r#"{"releaseId":"20261113-b870c92","manifestSha256":"00"}"#);
        let mut f = facts();
        f.home = home.clone();
        f.install = install.clone();
        f.data = data.clone();
        let check = judge(&f);
        let installation = check.installation.as_ref().expect("an installation");
        assert_eq!((installation.release_id.as_str(), installation.recorded), ("20261113-b870c92", false));
        assert!(!check.installable, "an installation is started, not installed again");

        // A start record and its executable entry make it recorded.
        write(Path::new(&format!("{install}/updates/launch.json")), r#"{"port":4317,"workspaceId":"ws-1","environment":{"PATH":"/usr/bin"}}"#);
        let entry = format!("{install}/updates/start");
        write(Path::new(&entry), "#!/bin/sh\n");
        fs::set_permissions(Path::new(&entry), fs::Permissions::from_mode(0o700)).unwrap();
        let check = judge(&f);
        let installation = check.installation.as_ref().expect("an installation");
        assert_eq!((installation.port, installation.workspace_id.as_deref(), installation.recorded), (Some(4317), Some("ws-1"), true));
        let text = serde_json::to_string(&check).unwrap();
        assert!(!text.contains("/usr/bin"), "nothing of the recorded environment reaches the page");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_that_is_not_an_installation_or_cannot_be_read_is_not_installable() {
        let root = temp("other");
        let home = root.to_str().unwrap().to_owned();
        let mut f = facts();
        f.home = home.clone();
        f.install = format!("{home}/managed-core");
        f.data = format!("{home}/workspace");
        write(Path::new(&format!("{}/managed-core/readme.txt", home)), "not ours");
        let check = judge(&f);
        assert_eq!(state(&check, "paths").0, "missing");
        assert!(!check.installable);
        write(Path::new(&format!("{}/managed-core/current.json", home)), r#"{"releaseId":"../x"}"#);
        let check = judge(&f);
        assert_eq!(state(&check, "paths").0, "missing");
        assert!(state(&check, "paths").1.unwrap().contains("cannot read"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_data_folder_holding_something_else_is_refused() {
        let root = temp("data");
        let home = root.to_str().unwrap().to_owned();
        let mut f = facts();
        f.home = home.clone();
        f.install = format!("{home}/managed-core");
        f.data = format!("{home}/workspace");
        write(Path::new(&format!("{}/workspace/notes.txt", home)), "x");
        let check = judge(&f);
        assert_eq!(state(&check, "paths").0, "missing");
        write(Path::new(&format!("{}/workspace/workspace.lock", home)), "");
        let check = judge(&f);
        assert_eq!(state(&check, "paths").0, "ok");
        assert!(state(&check, "paths").1.unwrap().contains("holds a workspace"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_tools_script_is_read_as_key_value_lines() {
        let tools = parse_tools("noise\r\nformat=1\r\ntool.node=v22.11.0\r\ntool.git=-\r\ngh.auth=1\r\ndone=1\r\n");
        assert_eq!(tools.node.as_deref(), Some("v22.11.0"));
        assert_eq!(tools.git.as_deref(), Some("-"));
        assert_eq!(tools.gh_auth.as_deref(), Some("1"));
        assert_eq!(tools.claude, None);
        // A version is cut, so one odd line cannot make the check large.
        let long = parse_tools(&format!("tool.claude={}\n", "v".repeat(500)));
        assert_eq!(long.claude.unwrap().chars().count(), 200);
    }

    #[test]
    fn node_needs_version_20_and_gh_its_sign_in() {
        let check = judge(&facts());
        assert_eq!(state(&check, "node").0, "ok");
        for (value, expected) in [("v19.9.9", "missing"), ("?", "unknown"), ("-", "missing")] {
            let mut f = facts();
            f.tools = parse_tools(&format!("tool.node={value}\n"));
            assert_eq!(state(&judge(&f), "node").0, expected, "{value}");
        }
        for (auth, expected) in [("0", "ok"), ("-", "missing"), ("1", "missing"), ("?", "unknown")] {
            let mut f = facts();
            f.tools = parse_tools(&format!("tool.gh=gh version 2.45.0\ngh.auth={auth}\n"));
            assert_eq!(state(&judge(&f), "gh").0, expected, "{auth}");
        }
    }

    #[test]
    fn a_login_shell_that_did_not_answer_leaves_the_tools_unknown_not_the_check_failed() {
        let mut f = facts();
        f.tools.path_note = Some("the login shell (/bin/zsh) did not give its PATH within 10 seconds".into());
        f.tools = Tools { path_note: f.tools.path_note.clone(), ..parse_tools("") };
        let check = judge(&f);
        assert_eq!(state(&check, "node").0, "unknown");
        assert!(check.installable, "the tools are recommended");
    }

    #[test]
    fn the_quarantine_attribute_is_found_and_never_removed() {
        let root = temp("quarantine");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let program = bin.join("yuzuno-workspace");
        write(&program, "not a program");
        assert_eq!(quarantined(&root).unwrap(), None);
        let set = Command::new(XATTR)
            .args(["-w", "com.apple.quarantine", "0081;00000000;Safari;", &program.to_string_lossy()])
            .status()
            .expect("xattr runs");
        assert!(set.success());
        assert_eq!(quarantined(&root).unwrap(), Some(program.display().to_string()));
        // Reported, and still there: this app does not remove it.
        let read = Command::new(XATTR).args(["-p", "com.apple.quarantine", &program.to_string_lossy()]).output().unwrap();
        assert!(read.status.success() && !read.stdout.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_stop_result_is_read_from_the_entrys_json() {
        let profile = StartProfile::macos(
            &crate::connection::parse_core_url("http://127.0.0.1:4317").unwrap(),
            "/Users/someone/Library/Application Support/yuzuno/managed-core",
            "ws-1",
        )
        .unwrap();
        assert_eq!(profile.platform, StartPlatform::Macos);
        assert_eq!(
            profile.mac_arguments("stop").unwrap()[0],
            "/Users/someone/Library/Application Support/yuzuno/managed-core/updates/start"
        );
    }
}
