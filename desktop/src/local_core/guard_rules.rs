//! What the read-only guard saw of the state WSL 2's distributions share
//! (`guard.sh`, YN-156 design 2.5), and what changed between two looks, with
//! no dependencies, so CI checks it without building the desktop app (as
//! `check_rules.rs`). `wsl.rs` runs the script in a distribution that is
//! already running; this only reads its bytes.
//!
//! WSL 2's distributions share one binfmt_misc table, which is how Windows
//! programs start, and one cgroup v2 tree. A second distribution with systemd
//! may clear that table when it starts or stops and write the same tree. The
//! guard runs before and after each command into a distribution while another
//! one runs, and [`changes`] says whether the witness saw anything go away or
//! change. It writes nothing itself.

use std::collections::BTreeMap;

/// The guard script's output format this app reads.
pub const FORMAT: &str = "1";

/// One binfmt_misc entry that carries Windows interop: magic `MZ` (`4d5a`),
/// interpreter `/init`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Interop {
    pub name: String,
    pub enabled: bool,
    /// The kernel's flags field (`P`, `OC`, ...), or `-` when it printed none.
    pub flags: String,
}

/// One look at the shared state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// `enabled`, `disabled` or `absent`; None when the script did not say.
    pub binfmt: Option<String>,
    pub interop: Vec<Interop>,
    /// How many other binfmt_misc entries were registered.
    pub others: Option<u32>,
    /// Each cgroup's `subtree_control` value by path; None where the file is
    /// absent. Values are kept as printed (for example `+cpu +memory +pids`).
    pub cgroups: BTreeMap<String, Option<String>>,
}

fn named(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn flags_ok(flags: &str) -> bool {
    flags == "-" || (!flags.is_empty() && flags.len() <= 4 && flags.bytes().all(|byte| b"POCF".contains(&byte)))
}

/// Whether `key` is one of the `key=value` lines this app reads.
fn key_ok(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-')
}

fn user_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("user.") else { return false };
    let Some((uid, which)) = rest.split_once('.') else { return false };
    !uid.is_empty() && uid.bytes().all(|byte| byte.is_ascii_digit()) && matches!(which, "control" | "app")
}

/// The guard's output, if it is the format this app reads. Lines that are not
/// `key=value`, or whose value this app does not understand, are ignored
/// except where the value is the one thing being compared: then a malformed
/// line is an error, so a garbled look is never read as "nothing changed".
pub fn parse(text: &str) -> Result<Snapshot, String> {
    let mut snapshot = Snapshot::default();
    let mut format = None;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let Some((key, value)) = line.split_once('=') else { continue };
        if !key_ok(key) {
            continue;
        }
        match key {
            "format" => format = Some(value.to_owned()),
            "binfmt.status" => {
                if !matches!(value, "enabled" | "disabled" | "absent") {
                    return Err(format!("The guard printed a status this app does not read: {value:?}."));
                }
                snapshot.binfmt = Some(value.to_owned());
            }
            "binfmt.other" => {
                snapshot.others = Some(value.parse().map_err(|_| format!("The guard printed a count this app does not read: {value:?}."))?);
            }
            "interop" => {
                let mut parts = value.split_whitespace();
                let (Some(name), Some(state)) = (parts.next(), parts.next()) else {
                    return Err(format!("The guard printed an interop entry this app does not read: {value:?}."));
                };
                let flags = parts.next().unwrap_or("-");
                if !named(name) || !matches!(state, "enabled" | "disabled") || !flags_ok(flags) || parts.next().is_some() {
                    return Err(format!("The guard printed an interop entry this app does not read: {value:?}."));
                }
                snapshot.interop.push(Interop { name: name.to_owned(), enabled: state == "enabled", flags: flags.to_owned() });
            }
            _ if key.starts_with("cgroup.") || user_key(key) => {
                snapshot.cgroups.insert(key.to_owned(), (value != "(absent)").then(|| value.to_owned()));
            }
            _ => {}
        }
    }
    match format.as_deref() {
        Some(FORMAT) => Ok(snapshot),
        Some(other) => Err(format!("The guard printed format {other}, which this app does not read.")),
        None => Err("The guard printed nothing this app can read.".into()),
    }
}

/// Something the witness saw differently after a command ran in the target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    BinfmtStatus { before: String, after: String },
    InteropGone { name: String, flags: String },
    InteropDisabled { name: String, flags: String },
    InteropFlags { name: String, before: String, after: String },
    OtherEntries { before: u32, after: u32 },
    Cgroup { path: String, before: String, after: String },
}

impl Change {
    /// One English sentence: `detail` is in English, as WSL's and Core's own
    /// words are.
    pub fn describe(&self) -> String {
        match self {
            Change::BinfmtStatus { before, after } => format!("binfmt_misc went from {before} to {after}"),
            Change::InteropGone { name, .. } => {
                format!("the Windows interop entry {name} is gone, so Windows programs cannot start in any distribution")
            }
            Change::InteropDisabled { name, .. } => format!("the Windows interop entry {name} is disabled"),
            Change::InteropFlags { name, before, after } => format!("the interop entry {name} changed its flags from {before} to {after}"),
            Change::OtherEntries { before, after } => format!("other binfmt_misc entries went from {before} to {after}"),
            Change::Cgroup { path, before, after } => {
                format!("{path}/cgroup.subtree_control changed from {before:?} to {after:?}")
            }
        }
    }

    /// How to put one thing back, for the page to show as text. Nothing here
    /// runs it. An entry that still exists is enabled or replaced in place:
    /// registering the same name again would be refused.
    pub fn restore(&self) -> Option<String> {
        match self {
            Change::InteropGone { name, flags } => {
                if !named(name) || !flags_ok(flags) || flags == "-" {
                    return None;
                }
                Some(format!("printf '%s' ':{name}:M::MZ::/init:{flags}' > /proc/sys/fs/binfmt_misc/register"))
            }
            Change::InteropDisabled { name, .. } => {
                if !named(name) {
                    return None;
                }
                Some(format!("printf '%s' 1 > /proc/sys/fs/binfmt_misc/{name}"))
            }
            Change::InteropFlags { name, before: flags, .. } => {
                if !named(name) || !flags_ok(flags) || flags == "-" {
                    return None;
                }
                Some(format!(
                    "printf '%s' -1 > /proc/sys/fs/binfmt_misc/{name} && printf '%s' ':{name}:M::MZ::/init:{flags}' > /proc/sys/fs/binfmt_misc/register"
                ))
            }
            Change::Cgroup { path, before, after } => {
                // A user manager that is gone has no file to write: starting
                // a session as that user makes a new one.
                if !path.starts_with("/sys/fs/cgroup/") || !path.contains("/user@") || after == "(absent)" {
                    return None;
                }
                if !before.chars().all(|c| c == '+' || c == ' ' || c.is_ascii_lowercase()) || before.trim().is_empty() {
                    return None;
                }
                let value = before.trim();
                Some(format!("printf '%s' '{value}' > {path}/cgroup.subtree_control"))
            }
            Change::BinfmtStatus { .. } | Change::OtherEntries { .. } => None,
        }
    }

    /// Advice that has no one command: the root and system slices belong to
    /// the distribution's own systemd, and a user manager that stopped starts
    /// again with its next session.
    pub fn advice(&self) -> Option<String> {
        match self {
            Change::Cgroup { path, after, .. } if path.starts_with("/sys/fs/cgroup/user.slice/") && after == "(absent)" => {
                Some("That user manager stopped; running a command as that user in the distribution starts it again.".into())
            }
            Change::Cgroup { path, .. } if path.starts_with("/sys/fs/cgroup/user.slice/") => {
                Some("Running Jobs in that distribution have lost those limits; they keep running.".into())
            }
            Change::Cgroup { .. } => Some("That belongs to the distribution's own systemd: restart it when convenient, which stops what runs in it.".into()),
            _ => None,
        }
    }
}

fn cgroup_path(key: &str) -> String {
    match key {
        "cgroup.root" => "/sys/fs/cgroup".into(),
        "cgroup.user-slice" => "/sys/fs/cgroup/user.slice".into(),
        "cgroup.system-slice" => "/sys/fs/cgroup/system.slice".into(),
        _ => match key.strip_prefix("user.").and_then(|rest| rest.split_once('.')) {
            Some((uid, "control")) => format!("/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service"),
            Some((uid, "app")) => format!("/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/app.slice"),
            _ => key.to_owned(),
        },
    }
}

/// What changed from `before` to `after`. Things that appeared are not a
/// change: only what a baseline had may go away or change. A baseline value
/// that is now unreadable counts as changed.
pub fn changes(before: &Snapshot, after: &Snapshot) -> Vec<Change> {
    let mut changes = Vec::new();
    if let (Some(before), Some(after)) = (&before.binfmt, &after.binfmt) {
        if before != after {
            changes.push(Change::BinfmtStatus { before: before.clone(), after: after.clone() });
        }
    }
    for entry in &before.interop {
        match after.interop.iter().find(|each| each.name == entry.name) {
            None => changes.push(Change::InteropGone { name: entry.name.clone(), flags: entry.flags.clone() }),
            Some(after) if entry.enabled && !after.enabled => {
                changes.push(Change::InteropDisabled { name: entry.name.clone(), flags: entry.flags.clone() })
            }
            Some(after) if after.flags != entry.flags => changes.push(Change::InteropFlags {
                name: entry.name.clone(),
                before: entry.flags.clone(),
                after: after.flags.clone(),
            }),
            Some(_) => {}
        }
    }
    if let (Some(before), Some(after)) = (before.others, after.others) {
        if after < before {
            changes.push(Change::OtherEntries { before, after });
        }
    }
    for (key, before) in &before.cgroups {
        let Some(before) = before else { continue };
        let after = after.cgroups.get(key).cloned().flatten();
        if after.as_ref() != Some(before) {
            changes.push(Change::Cgroup {
                path: cgroup_path(key),
                before: before.clone(),
                after: after.unwrap_or_else(|| "(absent)".into()),
            });
        }
    }
    changes
}

/// What the page shows when a command ran and the witness saw a change: what
/// changed, what it means, and how to put it back, as text. Nothing in it is
/// run by this app.
pub fn message(witness: &str, target: &str, changes: &[Change]) -> String {
    let described = changes.iter().map(Change::describe).collect::<Vec<_>>().join("; ");
    let mut text = format!(
        "The WSL distributions share Windows interop and one cgroup tree, and what {witness} can see changed while this app was working on {target}: {described}. Nothing further was run in {target}."
    );
    let mut commands = Vec::new();
    let mut advice = Vec::new();
    for change in changes {
        if let Some(command) = change.restore() {
            commands.push(command);
        }
        if let Some(advice_text) = change.advice() {
            if !advice.contains(&advice_text) {
                advice.push(advice_text);
            }
        }
    }
    if !commands.is_empty() {
        text.push_str(&format!(
            " Restore commands, run by you as root in {witness}: {}",
            commands.join(" ; ")
        ));
    }
    if !advice.is_empty() {
        text.push(' ');
        text.push_str(&advice.join(" "));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUARD: &str = "\
format=1
binfmt.status=enabled
interop=WSLInterop enabled P
interop=OtherInterop enabled -
binfmt.other=3
cgroup.root=+cpu +memory +pids
cgroup.user-slice=+cpu +memory +pids
cgroup.system-slice=+cpu +memory +pids
user.1000.control=+cpu +memory +pids
user.1000.app=+cpu +memory +pids
";

    fn snapshot() -> Snapshot {
        parse(GUARD).unwrap()
    }

    fn changed(from: &str, to: &str) -> Vec<Change> {
        changes(&parse(from).unwrap(), &parse(to).unwrap())
    }

    #[test]
    fn reads_a_guard_look() {
        let snapshot = snapshot();
        assert_eq!(snapshot.binfmt.as_deref(), Some("enabled"));
        assert_eq!(snapshot.others, Some(3));
        assert_eq!(
            snapshot.interop,
            [
                Interop { name: "WSLInterop".into(), enabled: true, flags: "P".into() },
                Interop { name: "OtherInterop".into(), enabled: true, flags: "-".into() },
            ]
        );
        assert_eq!(snapshot.cgroups["cgroup.root"].as_deref(), Some("+cpu +memory +pids"));
        assert_eq!(snapshot.cgroups["user.1000.app"].as_deref(), Some("+cpu +memory +pids"));
        assert_eq!(changes(&snapshot, &snapshot), []);
    }

    #[test]
    fn an_absent_file_is_not_an_empty_one() {
        let absent = parse("format=1\ncgroup.root=(absent)\ncgroup.user-slice=\n").unwrap();
        assert_eq!(absent.cgroups["cgroup.root"], None);
        assert_eq!(absent.cgroups["cgroup.user-slice"], Some(String::new()));
        // A key the baseline did not have is not a change when it appears,
        // even as an empty file.
        assert_eq!(changed("format=1\ncgroup.root=(absent)\n", "format=1\ncgroup.root=\n").len(), 0);
        assert_eq!(changed("format=1\n", "format=1\ncgroup.root=+cpu\n").len(), 0);
        // A baseline value that is gone is.
        assert_eq!(changed("format=1\ncgroup.root=+cpu\n", "format=1\n").len(), 1);
    }

    #[test]
    fn interop_that_went_away_or_changed_is_reported() {
        let gone = changed(GUARD, &GUARD.replace("interop=WSLInterop enabled P\n", ""));
        assert_eq!(gone, [Change::InteropGone { name: "WSLInterop".into(), flags: "P".into() }]);
        let disabled = changed(GUARD, &GUARD.replace("interop=WSLInterop enabled P", "interop=WSLInterop disabled P"));
        assert_eq!(disabled, [Change::InteropDisabled { name: "WSLInterop".into(), flags: "P".into() }]);
        let flags = changed(GUARD, &GUARD.replace("interop=WSLInterop enabled P", "interop=WSLInterop enabled PO"));
        assert_eq!(flags, [Change::InteropFlags { name: "WSLInterop".into(), before: "P".into(), after: "PO".into() }]);
        // A new entry, a newly enabled one and a higher count are not changes.
        let more = format!("{GUARD}interop=NewOne enabled -\n");
        assert_eq!(changes(&snapshot(), &parse(&more).unwrap()), []);
        let enabled = GUARD.replace("interop=OtherInterop enabled -", "interop=OtherInterop disabled -");
        assert_eq!(changes(&parse(&enabled).unwrap(), &snapshot()), []);
        assert_eq!(changed(GUARD, &GUARD.replace("binfmt.other=3", "binfmt.other=4")), []);
    }

    #[test]
    fn a_baseline_entry_that_was_already_disabled_is_not_a_change() {
        let disabled = parse("format=1\ninterop=WSLInterop disabled P\n").unwrap();
        assert_eq!(changes(&disabled, &disabled.clone()), []);
        let enabled = parse("format=1\ninterop=WSLInterop enabled P\n").unwrap();
        // Becoming enabled is an improvement, not a change to stop on.
        assert_eq!(changes(&disabled, &enabled), []);
        assert_eq!(changes(&enabled, &disabled).len(), 1);
    }

    #[test]
    fn other_entries_that_went_away_are_reported() {
        let fewer = changed(GUARD, &GUARD.replace("binfmt.other=3", "binfmt.other=1"));
        assert_eq!(fewer, [Change::OtherEntries { before: 3, after: 1 }]);
        let disabled = changed(GUARD, &GUARD.replace("binfmt.status=enabled", "binfmt.status=disabled"));
        assert_eq!(disabled, [Change::BinfmtStatus { before: "enabled".into(), after: "disabled".into() }]);
    }

    #[test]
    fn cgroup_values_changes_and_a_user_manager_that_went_away_are_reported() {
        let changed_root = changed(GUARD, &GUARD.replace("cgroup.root=+cpu +memory +pids", "cgroup.root=+cpu +pids"));
        assert_eq!(
            changed_root,
            [Change::Cgroup {
                path: "/sys/fs/cgroup".into(),
                before: "+cpu +memory +pids".into(),
                after: "+cpu +pids".into(),
            }]
        );
        let gone = changed(GUARD, &GUARD.replace("user.1000.control=+cpu +memory +pids\n", ""));
        assert_eq!(gone.len(), 1);
        assert!(gone[0].describe().contains("user@1000.service"));
        // A new user manager is not a change.
        let new = format!("{GUARD}user.1001.control=+cpu +memory +pids\n");
        assert_eq!(changes(&snapshot(), &parse(&new).unwrap()), []);
    }

    #[test]
    fn the_restore_text_is_a_command_or_advice_and_nothing_is_run() {
        let gone = Change::InteropGone { name: "WSLInterop".into(), flags: "P".into() };
        assert_eq!(
            gone.restore(),
            Some("printf '%s' ':WSLInterop:M::MZ::/init:P' > /proc/sys/fs/binfmt_misc/register".into())
        );
        assert_eq!(
            Change::InteropDisabled { name: "WSLInterop".into(), flags: "P".into() }.restore(),
            Some("printf '%s' 1 > /proc/sys/fs/binfmt_misc/WSLInterop".into())
        );
        let reflagged = Change::InteropFlags { name: "WSLInterop".into(), before: "P".into(), after: "PO".into() };
        assert_eq!(
            reflagged.restore(),
            Some(
                "printf '%s' -1 > /proc/sys/fs/binfmt_misc/WSLInterop && printf '%s' ':WSLInterop:M::MZ::/init:P' > /proc/sys/fs/binfmt_misc/register".into()
            )
        );
        assert_eq!(Change::InteropGone { name: "bad name".into(), flags: "P".into() }.restore(), None);
        assert_eq!(Change::InteropGone { name: "WSLInterop".into(), flags: "P; rm".into() }.restore(), None);
        assert_eq!(Change::InteropGone { name: "WSLInterop".into(), flags: "-".into() }.restore(), None);
        assert_eq!(Change::InteropDisabled { name: "bad name".into(), flags: "P".into() }.restore(), None);
        let user = Change::Cgroup {
            path: "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service".into(),
            before: "+cpu +memory +pids".into(),
            after: "+cpu".into(),
        };
        assert_eq!(
            user.restore(),
            Some(
                "printf '%s' '+cpu +memory +pids' > /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.subtree_control".into()
            )
        );
        assert!(user.advice().unwrap().contains("lost those limits"));
        let stopped = Change::Cgroup {
            path: "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service".into(),
            before: "+cpu +memory +pids".into(),
            after: "(absent)".into(),
        };
        assert_eq!(stopped.restore(), None);
        assert!(stopped.advice().unwrap().contains("user manager stopped"));
        let stopped_text = message("archlinux", "Ubuntu-24.04", &[stopped]);
        assert!(stopped_text.contains("user manager stopped"));
        assert!(!stopped_text.contains("Restore commands"));
        let root = Change::Cgroup { path: "/sys/fs/cgroup".into(), before: "+cpu".into(), after: "+memory".into() };
        assert_eq!(root.restore(), None);
        assert!(root.advice().unwrap().contains("restart it"));
        let text = message("archlinux", "Ubuntu-24.04", &[gone, root]);
        assert!(text.contains("WSLInterop is gone"));
        assert!(text.contains("Nothing further was run in Ubuntu-24.04"));
        assert!(text.contains("Restore commands"));
        assert!(text.contains("printf"));
        assert!(text.contains("archlinux"));
    }

    #[test]
    fn reads_only_its_own_format_and_refuses_a_garbled_look() {
        assert!(parse("binfmt.status=enabled\n").is_err());
        assert!(parse("format=2\n").is_err());
        assert!(parse("format=1\nbinfmt.status=nonsense\n").is_err());
        assert!(parse("format=1\nbinfmt.other=many\n").is_err());
        assert!(parse("format=1\ninterop=WSLInterop enabled\n").is_ok());
        assert!(parse("format=1\ninterop=WSLInterop maybe P\n").is_err());
        assert!(parse("format=1\ninterop=WSLInterop enabled P extra\n").is_err());
        // A line this app does not read is skipped, as WSL may print anything.
        assert!(parse("noise\nformat=1\nnot a key=1\ncgroup.other=+cpu\n").is_ok());
        assert_eq!(parse("format=1\ninterop=WSLInterop enabled\n").unwrap().interop[0].flags, "-");
    }
}
