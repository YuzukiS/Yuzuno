//! What the read-only check of a WSL distribution found (`check.sh`, YN-107
//! design 4.3) and what it means for installing Core there, with no
//! dependencies, so CI checks it without building the desktop app (as
//! `health.rs`). Also the rules for the names and paths that become part of
//! a `wsl.exe` command, which a saved start (`connection.rs`) uses too.
//!
//! The check items and their levels are the shared table of the connection
//! page's local Core commands (design section 6, part 3); `detail` is in
//! English, as WSL's and Core's own words are.

/// The check script's output format this app reads.
pub const FORMAT: &str = "1";

/// Where the desktop looks for a free port for a new Core: Core's default,
/// 4317 (core/src/main.rs), and the nine after it (design 4.7).
pub const PORTS: std::ops::RangeInclusive<u16> = 4317..=4326;

fn named(text: &str, max: usize, more: &[char]) -> bool {
    !text.is_empty() && text.len() <= max && text.chars().all(|c| c.is_ascii_alphanumeric() || more.contains(&c))
}

/// A WSL distribution's name this app passes to `wsl.exe --distribution`.
pub fn distro_name_ok(name: &str) -> bool {
    named(name, 64, &['.', '_', '-']) && !name.starts_with(['-', '.'])
}

/// A Linux account name this app passes to `wsl.exe --user`.
pub fn user_name_ok(name: &str) -> bool {
    named(name, 32, &['_', '-']) && !name.starts_with('-')
}

/// A Workspace's identifier, as a saved start keeps it.
pub fn workspace_id_ok(id: &str) -> bool {
    named(id, 64, &['-', '_'])
}

/// A release's identifier, as Core checks one (core/src/updates/package.rs,
/// `valid_id`).
pub fn release_id_ok(id: &str) -> bool {
    named(id, 100, &['-', '_'])
}

/// An absolute Linux path in a WSL distribution that this app passes to
/// `wsl.exe` as an argument: plain characters only (no spaces), no empty,
/// `.` or `..` parts, and not a Windows folder seen from WSL.
pub fn linux_path_ok(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 512
        && path.chars().all(|c| c.is_ascii_alphanumeric() || "._-+@/".contains(c))
        && path[1..].split('/').all(|part| !matches!(part, "" | "." | ".."))
        // Windows folders seen from WSL: not a Linux installation.
        && !path.starts_with("/mnt/")
}

/// `a` and `b` are the same folder or one holds the other (both already
/// passed [`linux_path_ok`]).
pub fn same_or_nested(a: &str, b: &str) -> bool {
    let within = |inner: &str, outer: &str| inner == outer || inner.strip_prefix(outer).is_some_and(|rest| rest.starts_with('/'));
    within(a, b) || within(b, a)
}

/// The `key=value` lines the check printed.
#[derive(Debug, Default)]
pub struct Report {
    fields: Vec<(String, String)>,
}

impl Report {
    /// The value printed for `key` (the first, if printed twice).
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str())
    }
}

/// The check's output, if it is the format this app reads: `format=1`
/// first, then `key=value` lines. Lines that are not `key=value` are
/// ignored, since a login shell may print anything before the script runs
/// its own commands.
pub fn parse(text: &str) -> Result<Report, String> {
    let mut fields = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some((key, value)) = line.split_once('=') {
            if !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.') {
                fields.push((key.to_owned(), value.to_owned()));
            }
        }
    }
    let report = Report { fields };
    match report.get("format") {
        Some(FORMAT) => Ok(report),
        Some(other) => Err(format!("The check printed format {other}, which this app does not read.")),
        None => Err("The check printed nothing this app can read.".into()),
    }
}

/// Standard base64 (RFC 4648, with padding), as `base64` prints it once its
/// line breaks are removed.
pub fn base64(text: &str) -> Option<Vec<u8>> {
    let value = |byte: u8| -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index == bytes.len() / 4 - 1;
        let padding = chunk.iter().rev().take_while(|&&byte| byte == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return None;
        }
        let mut word = 0;
        for &byte in &chunk[..4 - padding] {
            word = word << 6 | value(byte)?;
        }
        word <<= 6 * padding as u32;
        out.extend_from_slice(&word.to_be_bytes()[1..4 - padding]);
    }
    Some(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Required,
    Recommended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Ok,
    Missing,
    Unknown,
}

/// One line of the check list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: &'static str,
    pub level: Level,
    pub state: State,
    pub detail: Option<String>,
}

/// The port for a new Core, as the desktop found it from Windows (design
/// 4.7); the check script does not look at ports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Port {
    /// The first of [`PORTS`] that nothing answers on and no saved
    /// workspace or remembered address is bound to.
    Free(u16),
    /// Every one of [`PORTS`] is in use or bound.
    NoneFree,
    /// The desktop could not tell, and why.
    Unknown(String),
}

/// What is at the installation folder, as the desktop read it from
/// `current.json` (it reads JSON; this file has no JSON reader).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    /// No Yuzuno installation there.
    Nothing,
    /// An installation whose release this app read.
    Installation,
    /// A `current.json` this app could not read.
    Unreadable,
}

/// A program the check asked for its version: its first line, `-` when the
/// login PATH (or the fixed path) has no such program, `?` when it was not
/// run or said nothing.
fn tool<'a>(report: &'a Report, key: &str) -> Option<&'a str> {
    report.get(key).map(str::trim)
}

/// The leading `major.minor` of a version such as `v22.11.0` or `2.39`.
fn major_minor(version: &str) -> Option<(u32, u32)> {
    let version = version.trim().trim_start_matches('v');
    let mut parts = version.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// Why a program may be missing although it is installed: the check could
/// not read the login shell's PATH.
fn path_note(report: &Report) -> String {
    match report.get("env.source") {
        Some("login") => String::new(),
        _ => format!(
            " (the login shell's PATH could not be read: {}; a tool set up there, such as nvm, is not seen)",
            report.get("env.note").filter(|note| !note.is_empty()).unwrap_or("unknown")
        ),
    }
}

/// Every check item, in the shared table's order, for a WSL distribution
/// whose list entry says `wsl2`.
pub fn judge(report: &Report, wsl2: bool, port: &Port, found: Found) -> Vec<Item> {
    use Level::{Recommended, Required};
    let item = |id, level, state, detail: Option<String>| Item { id, level, state, detail };
    let mut items = Vec::new();

    items.push(item("wsl2", Required, if wsl2 { State::Ok } else { State::Missing }, None));

    items.push(match (report.get("user"), report.get("uid")) {
        (Some(user), Some(uid)) if !user.is_empty() && !uid.is_empty() => {
            if uid == "0" || user == "root" {
                item("user", Required, State::Missing, Some("The default account is root; set a regular default user for this distribution.".into()))
            } else if !user_name_ok(user) {
                item("user", Required, State::Missing, Some(format!("The account name {user:?} has characters this app does not pass to WSL.")))
            } else {
                item("user", Required, State::Ok, Some(user.to_owned()))
            }
        }
        _ => item("user", Required, State::Unknown, None),
    });

    items.push(match report.get("arch") {
        Some("x86_64") => item("arch", Required, State::Ok, Some("x86_64".into())),
        Some(arch) if !arch.is_empty() => item("arch", Required, State::Missing, Some(format!("{arch}: Core is released for x86_64 only."))),
        _ => item("arch", Required, State::Unknown, None),
    });

    items.push(match report.get("glibc") {
        None => item("glibc", Required, State::Unknown, None),
        Some("") => item("glibc", Required, State::Missing, Some("This distribution's C library is not glibc.".into())),
        Some(version) => match major_minor(version) {
            Some(found) if found >= (2, 35) => item("glibc", Required, State::Ok, Some(version.to_owned())),
            Some(_) => item("glibc", Required, State::Missing, Some(format!("glibc {version}; Core needs 2.35 or newer."))),
            None => item("glibc", Required, State::Unknown, Some(version.to_owned())),
        },
    });

    items.push(paths(report, found));

    items.push(match report.get("tools.missing") {
        None => item("tools", Required, State::Unknown, None),
        Some(missing) if missing.trim().is_empty() => item("tools", Required, State::Ok, None),
        Some(missing) => item("tools", Required, State::Missing, Some(format!("Missing: {}", missing.trim()))),
    });

    items.push(match port {
        Port::Free(port) => item("port", Required, State::Ok, Some(port.to_string())),
        Port::NoneFree => item(
            "port",
            Required,
            State::Missing,
            Some(format!(
                "Ports {}–{} are all in use or saved for other workspaces.",
                PORTS.start(),
                PORTS.end()
            )),
        ),
        Port::Unknown(why) => item("port", Required, State::Unknown, Some(why.clone())),
    });

    items.push(match tool(report, "tool.node") {
        None => item("node", Recommended, State::Unknown, None),
        Some("-") => item("node", Recommended, State::Missing, Some(format!("Not found on PATH{}.", path_note(report)))),
        Some(version) => match major_minor(version) {
            Some((major, _)) if major >= 20 => item("node", Recommended, State::Ok, Some(version.to_owned())),
            Some(_) => item("node", Recommended, State::Missing, Some(format!("{version}; Claude Agents need Node.js 20 or newer."))),
            None => item("node", Recommended, State::Unknown, Some(version.to_owned())),
        },
    });

    for (id, key, missing) in [
        ("git", "tool.git", "Not found on PATH"),
        ("python3", "tool.python3", "There is no /usr/bin/python3"),
    ] {
        items.push(present(report, id, key, missing));
    }

    items.push(systemd(report));

    for (id, key) in [("claude", "tool.claude"), ("codex", "tool.codex")] {
        items.push(present(report, id, key, "Not found on PATH"));
    }

    items.push(match (tool(report, "tool.gh"), report.get("gh.auth")) {
        (None, _) => item("gh", Recommended, State::Unknown, None),
        (Some("-"), _) => item("gh", Recommended, State::Missing, Some(format!("gh is not found on PATH{}.", path_note(report)))),
        (Some(_), Some("ok")) => item("gh", Recommended, State::Ok, None),
        (Some(_), Some("no")) => item("gh", Recommended, State::Missing, Some("gh is not signed in to github.com (gh auth login).".into())),
        (Some(_), Some("timeout")) => item("gh", Recommended, State::Unknown, Some("gh did not answer within 10 seconds.".into())),
        (Some(_), _) => item("gh", Recommended, State::Unknown, None),
    });

    items
}

fn present(report: &Report, id: &'static str, key: &str, missing: &str) -> Item {
    let (state, detail) = match tool(report, key) {
        None | Some("?") => (State::Unknown, None),
        Some("-") if key == "tool.python3" => (State::Missing, Some(format!("{missing}."))),
        Some("-") => (State::Missing, Some(format!("{missing}{}.", path_note(report)))),
        Some(version) => (State::Ok, Some(version.to_owned())),
    };
    Item { id, level: Level::Recommended, state, detail }
}

fn systemd(report: &Report) -> Item {
    let item = |state, detail: Option<String>| Item { id: "systemd", level: Level::Recommended, state, detail };
    let manager = match report.get("systemd").map(str::trim) {
        None | Some("?") => return item(State::Unknown, None),
        Some("-") => return item(State::Missing, Some("systemctl is not found.".into())),
        Some("") => return item(State::Missing, Some("The systemd user manager did not answer.".into())),
        Some(manager) => manager,
    };
    if !matches!(manager, "running" | "degraded") {
        return item(State::Missing, Some(format!("The systemd user manager is {manager}.")));
    }
    let controllers = report.get("cgroup").unwrap_or("").split_whitespace().collect::<Vec<_>>();
    let lacking = ["cpu", "memory", "pids"].into_iter().filter(|name| !controllers.contains(name)).collect::<Vec<_>>();
    if lacking.is_empty() {
        item(State::Ok, Some(manager.to_owned()))
    } else {
        item(
            State::Missing,
            Some(format!("The user manager's cgroup lacks {}; Jobs need cpu, memory and pids.", lacking.join(", "))),
        )
    }
}

fn paths(report: &Report, found: Found) -> Item {
    let item = |state, detail: Option<String>| Item { id: "paths", level: Level::Required, state, detail };
    let (Some(home), Some(root), Some(data)) = (report.get("home"), report.get("root"), report.get("data")) else {
        return item(State::Unknown, None);
    };
    for (what, path) in [("home folder", home), ("install folder", root), ("data folder", data)] {
        if !linux_path_ok(path) {
            return item(
                State::Missing,
                Some(format!(
                    "The {what} {path:?} is not a path this app passes to WSL: an absolute Linux path outside /mnt, with letters, digits and ._-+@ only."
                )),
            );
        }
    }
    if same_or_nested(root, data) {
        return item(State::Missing, Some("The install and data folders must be apart, neither inside the other.".into()));
    }
    match (report.get("root.state"), found) {
        (Some("absent"), _) | (Some("installed"), Found::Installation) => {}
        (Some("installed"), _) => {
            return item(State::Missing, Some(format!("{root} has an installation whose current.json this app cannot read.")))
        }
        (Some("other"), _) => return item(State::Missing, Some(format!("{root} exists but is not a Yuzuno installation."))),
        _ => return item(State::Unknown, None),
    }
    match report.get("data.state") {
        Some("absent" | "empty") => item(State::Ok, None),
        // Opened as it is; the page says so.
        Some("workspace") => item(State::Ok, Some(format!("{data} holds a workspace, which Core will open."))),
        Some("other") => item(State::Missing, Some(format!("{data} exists and holds something other than a Yuzuno workspace."))),
        _ => item(State::Unknown, None),
    }
}

/// Whether Core can be installed here: every required item is ok and there
/// is no installation yet (shared table, part 2).
pub fn installable(items: &[Item], found: Found) -> bool {
    found == Found::Nothing && items.iter().all(|item| item.level == Level::Recommended || item.state == State::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "\
noise a login shell printed
format=1
user=someone
uid=1000
home=/home/someone
shell=/bin/bash
arch=x86_64
glibc=2.39
tools.missing=
env.source=login
root=/home/someone/.local/share/yuzuno-core
root.state=absent
data=/home/someone/.local/share/yuzuno-core-data
data.state=absent
tool.node=v22.11.0
tool.git=git version 2.43.0
tool.gh=gh version 2.45.0 (2024-03-04)
tool.claude=2.1.3 (Claude Code)
tool.codex=codex-cli 0.80.0
tool.python3=Python 3.12.3
gh.auth=ok
systemd=running
cgroup=cpu memory pids
";

    fn with(changes: &[(&str, &str)]) -> Report {
        let mut text = String::new();
        for line in GOOD.lines() {
            let key = line.split_once('=').map(|(key, _)| key);
            match changes.iter().find(|(name, _)| Some(*name) == key) {
                Some((_, "<none>")) => {}
                Some((name, value)) => text.push_str(&format!("{name}={value}\n")),
                None => text.push_str(&format!("{line}\n")),
            }
        }
        for (name, value) in changes {
            if !GOOD.contains(&format!("\n{name}=")) {
                text.push_str(&format!("{name}={value}\n"));
            }
        }
        parse(&text).unwrap()
    }

    fn state(items: &[Item], id: &str) -> (State, Option<String>) {
        let item = items.iter().find(|item| item.id == id).unwrap_or_else(|| panic!("no {id}"));
        (item.state, item.detail.clone())
    }

    fn judged(changes: &[(&str, &str)]) -> Vec<Item> {
        judge(&with(changes), true, &Port::Free(4317), Found::Nothing)
    }

    #[test]
    fn lists_every_item_of_the_shared_table_in_order() {
        let items = judged(&[]);
        let ids: Vec<_> = items.iter().map(|item| item.id).collect();
        assert_eq!(
            ids,
            ["wsl2", "user", "arch", "glibc", "paths", "tools", "port", "node", "git", "python3", "systemd", "claude", "codex", "gh"]
        );
        let required: Vec<_> = items.iter().filter(|item| item.level == Level::Required).map(|item| item.id).collect();
        assert_eq!(required, ["wsl2", "user", "arch", "glibc", "paths", "tools", "port"]);
        assert!(items.iter().all(|item| item.state == State::Ok), "{items:?}");
        assert!(installable(&items, Found::Nothing));
        assert!(!installable(&items, Found::Installation));
    }

    #[test]
    fn reads_only_its_own_format() {
        assert!(parse("user=x\n").is_err());
        assert!(parse("format=2\n").is_err());
        let report = parse("Welcome!\r\nformat=1\r\nuser=a=b\r\nWeird Key=1\r\nuser=again\r\n").unwrap();
        assert_eq!(report.get("user"), Some("a=b"));
        assert_eq!(report.get("Weird Key"), None);
    }

    #[test]
    fn a_root_or_unusual_account_cannot_install() {
        for changes in [[("uid", "0"), ("user", "root")], [("uid", "0"), ("user", "admin")], [("uid", "1000"), ("user", "root")]] {
            let items = judged(&changes);
            assert_eq!(state(&items, "user").0, State::Missing);
            assert!(!installable(&items, Found::Nothing));
        }
        assert_eq!(state(&judged(&[("user", "-x")]), "user").0, State::Missing);
        assert_eq!(state(&judged(&[("user", "some one")]), "user").0, State::Missing);
        assert_eq!(state(&judged(&[("user", "<none>")]), "user").0, State::Unknown);
    }

    #[test]
    fn needs_x86_64_and_glibc_2_35() {
        assert_eq!(state(&judged(&[("arch", "aarch64")]), "arch").0, State::Missing);
        assert_eq!(state(&judged(&[("glibc", "2.35")]), "glibc").0, State::Ok);
        assert_eq!(state(&judged(&[("glibc", "2.4")]), "glibc").0, State::Missing);
        assert_eq!(state(&judged(&[("glibc", "2.31")]), "glibc").0, State::Missing);
        assert_eq!(state(&judged(&[("glibc", "3.0")]), "glibc").0, State::Ok);
        assert_eq!(state(&judged(&[("glibc", "")]), "glibc").0, State::Missing);
        assert_eq!(state(&judged(&[("glibc", "<none>")]), "glibc").0, State::Unknown);
    }

    #[test]
    fn needs_every_tool_the_install_uses() {
        let items = judged(&[("tools.missing", "gzip timeout")]);
        assert_eq!(state(&items, "tools"), (State::Missing, Some("Missing: gzip timeout".into())));
        assert!(!installable(&items, Found::Nothing));
    }

    #[test]
    fn paths_follow_the_rules_for_wsl_arguments() {
        assert_eq!(state(&judged(&[("home", "/home/some one")]), "paths").0, State::Missing);
        assert_eq!(state(&judged(&[("root", "/mnt/c/yuzuno")]), "paths").0, State::Missing);
        assert_eq!(state(&judged(&[("data", "relative/data")]), "paths").0, State::Missing);
        assert_eq!(state(&judged(&[("data", "/home/someone/.local/share/yuzuno-core")]), "paths").0, State::Missing);
        assert_eq!(state(&judged(&[("data", "/home/someone/.local/share/yuzuno-core/data")]), "paths").0, State::Missing);
        assert_eq!(state(&judged(&[("root", "/home/someone/.local")]), "paths").0, State::Missing);
        // A shared prefix is not nesting.
        assert_eq!(state(&judged(&[("data", "/home/someone/.local/share/yuzuno-core2")]), "paths").0, State::Ok);
    }

    #[test]
    fn what_is_already_in_the_folders() {
        assert_eq!(state(&judged(&[("root.state", "other")]), "paths").0, State::Missing);
        assert_eq!(state(&judged(&[("data.state", "other")]), "paths").0, State::Missing);
        assert_eq!(state(&judged(&[("data.state", "empty")]), "paths").0, State::Ok);
        let (found, detail) = state(&judged(&[("data.state", "workspace")]), "paths");
        assert_eq!(found, State::Ok);
        assert!(detail.unwrap().contains("holds a workspace"));
        // An installation is started, not installed again.
        let report = with(&[("root.state", "installed")]);
        let items = judge(&report, true, &Port::Free(4317), Found::Installation);
        assert_eq!(state(&items, "paths").0, State::Ok);
        assert!(!installable(&items, Found::Installation));
        let items = judge(&report, true, &Port::Free(4317), Found::Unreadable);
        assert_eq!(state(&items, "paths").0, State::Missing);
        assert!(!installable(&items, Found::Unreadable));
        assert_eq!(state(&judged(&[("root.state", "<none>")]), "paths").0, State::Unknown);
    }

    #[test]
    fn the_port_comes_from_the_desktop() {
        let report = with(&[]);
        for (port, expected) in [
            (Port::Free(4320), State::Ok),
            (Port::NoneFree, State::Missing),
            (Port::Unknown("no saved list".into()), State::Unknown),
        ] {
            let items = judge(&report, true, &port, Found::Nothing);
            assert_eq!(state(&items, "port").0, expected);
            assert_eq!(installable(&items, Found::Nothing), expected == State::Ok);
        }
        assert!(!installable(&judge(&report, false, &Port::Free(4317), Found::Nothing), Found::Nothing));
    }

    #[test]
    fn recommended_items_never_stop_an_install() {
        let items = judged(&[
            ("tool.node", "v18.19.0"),
            ("tool.git", "-"),
            ("tool.python3", "-"),
            ("systemd", "offline"),
            ("tool.claude", "-"),
            ("tool.codex", "?"),
            ("gh.auth", "no"),
        ]);
        for id in ["node", "git", "python3", "systemd", "claude", "gh"] {
            assert_eq!(state(&items, id).0, State::Missing, "{id}");
        }
        assert_eq!(state(&items, "codex").0, State::Unknown);
        assert!(installable(&items, Found::Nothing));
    }

    #[test]
    fn node_needs_version_20() {
        assert_eq!(state(&judged(&[("tool.node", "v20.0.0")]), "node").0, State::Ok);
        assert_eq!(state(&judged(&[("tool.node", "v19.9.9")]), "node").0, State::Missing);
        assert_eq!(state(&judged(&[("tool.node", "?")]), "node").0, State::Unknown);
    }

    #[test]
    fn says_when_the_login_path_was_not_read() {
        let (_, detail) = state(&judged(&[("tool.node", "-"), ("env.source", "inherited"), ("env.note", "timeout")]), "node");
        assert!(detail.unwrap().contains("could not be read: timeout"));
        let (_, detail) = state(&judged(&[("tool.node", "-")]), "node");
        assert_eq!(detail.as_deref(), Some("Not found on PATH."));
    }

    #[test]
    fn systemd_needs_the_three_controllers() {
        assert_eq!(state(&judged(&[("systemd", "degraded")]), "systemd").0, State::Ok);
        let (found, detail) = state(&judged(&[("cgroup", "memory pids")]), "systemd");
        assert_eq!(found, State::Missing);
        assert!(detail.unwrap().contains("lacks cpu"));
        assert_eq!(state(&judged(&[("systemd", "-")]), "systemd").0, State::Missing);
        assert_eq!(state(&judged(&[("systemd", "")]), "systemd").0, State::Missing);
    }

    #[test]
    fn gh_signed_in() {
        assert_eq!(state(&judged(&[("tool.gh", "-")]), "gh").0, State::Missing);
        assert_eq!(state(&judged(&[("gh.auth", "timeout")]), "gh").0, State::Unknown);
    }

    #[test]
    fn names_and_paths() {
        assert!(distro_name_ok("Ubuntu-24.04"));
        assert!(!distro_name_ok("-x") && !distro_name_ok(".x") && !distro_name_ok("a b") && !distro_name_ok(""));
        assert!(!distro_name_ok(&"a".repeat(65)));
        assert!(user_name_ok("some_one-2") && !user_name_ok("-x") && !user_name_ok(&"a".repeat(33)));
        assert!(release_id_ok("20261113-b870c92") && !release_id_ok("../x"));
        assert!(workspace_id_ok("ws_1-a") && !workspace_id_ok("ws 1"));
        assert!(linux_path_ok("/home/a/.local/share/yuzuno-core"));
        for bad in ["", "/", "relative", "/a//b", "/a/./b", "/a/../b", "/a/", "/mnt/c/x", "/a b", "/a\nb", "/ä"] {
            assert!(!linux_path_ok(bad), "{bad:?}");
        }
        assert!(same_or_nested("/a/b", "/a/b") && same_or_nested("/a/b/c", "/a/b") && same_or_nested("/a", "/a/b"));
        assert!(!same_or_nested("/a/b", "/a/bc"));
    }

    #[test]
    fn base64_as_the_tool_prints_it() {
        assert_eq!(base64("").unwrap(), b"");
        assert_eq!(base64("eyJyZWxlYXNlSWQiOiJ4In0=").unwrap(), br#"{"releaseId":"x"}"#);
        assert_eq!(base64("YQ==").unwrap(), b"a");
        assert_eq!(base64("YWI=").unwrap(), b"ab");
        assert_eq!(base64("YWJj").unwrap(), b"abc");
        for bad in ["YQ=", "Y===", "YQ==YWJj", "YW J", "YWJ!"] {
            assert_eq!(base64(bad), None, "{bad}");
        }
    }
}
