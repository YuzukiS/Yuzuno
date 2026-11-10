//! Paths as OpenCode 2.2.5 makes them from a tool call's input, and where
//! they really are (YN-78 S4a; design v4 2.3.3).
//!
//! OpenCode's side is lexical: `resolvePath` (core/src/file-access.ts)
//! expands `~` and resolves against the Agent's folder as Node's
//! `path.resolve` does, and `resolve` calls a path inside when it is under
//! the folder or its Git worktree (when that isn't `/`). Core's side is the
//! real path: `canonicalize`, which follows every link. A path that can't
//! be made real can't be checked, and is refused by the caller.
use super::Reason;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::time::{Duration, Instant};

/// How much a check may read of the file system (design v4 2.3.3): 20,000
/// entries or 2 seconds, whichever comes first. Its basis: one working copy
/// of this repository without `.git` and `target` has 2,433 entries, and the
/// design host's /usr/include 11,242. The kernel's own calls can't be
/// interrupted, so the time is checked between them: a bound on Core's
/// work, not a hard deadline.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Budget {
    pub entries: usize,
    pub time: Duration,
}

pub(crate) const BUDGET: Budget = Budget { entries: 20_000, time: Duration::from_secs(2) };

/// Where a check reads the time, so a test can move it.
pub(crate) trait Clock: Sync {
    fn now(&self) -> Instant;
}

/// The time as it is.
pub(crate) struct Wall;

impl Clock for Wall {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// What is left of a Budget: each read of the file system takes one.
pub(super) struct Spend<'c> {
    left: usize,
    until: Instant,
    clock: &'c dyn Clock,
}

impl<'c> Spend<'c> {
    pub(super) fn new(budget: &Budget, clock: &'c dyn Clock) -> Self {
        Self { left: budget.entries, until: clock.now() + budget.time, clock }
    }

    /// One more read, unless the budget is spent.
    pub(super) fn take(&mut self) -> bool {
        if self.left == 0 || self.clock.now() >= self.until {
            return false;
        }
        self.left -= 1;
        true
    }
}

/// `path` with its empty, `.` and `..` parts taken out, as Node's POSIX
/// `path.resolve` normalizes: an absolute path in, an absolute path out.
pub(super) fn normal(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Whether `path` is absolute and already normal: what Core takes as a
/// trusted path.
pub(super) fn is_normal(path: &str) -> bool {
    path.starts_with('/') && normal(path) == path
}

/// OpenCode's `resolvePath(directory, input)` (file-access.ts): `~` and
/// `~/…` from `home`, an absolute path as it is, anything else against
/// `directory`; then normalized. None for an input `FSUtil.windowsPath`
/// (not among the fixed sources) might read otherwise: one with a `\` or a
/// drive letter, and one with a NUL, which no path has.
pub(super) fn resolve(directory: &str, input: &str, home: &str) -> Option<String> {
    let bytes = input.as_bytes();
    if input.contains(['\\', '\0']) || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':') {
        return None;
    }
    let joined = if input == "~" {
        home.to_owned()
    } else if let Some(rest) = input.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else if input.starts_with('/') {
        input.to_owned()
    } else {
        format!("{directory}/{input}")
    };
    Some(normal(&joined))
}

/// Whether normal `path` is `dir` or under it.
pub(super) fn within(path: &str, dir: &str) -> bool {
    dir == "/" || path == dir || path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// The folder normal `path` is in (`/` for `/`).
pub(super) fn parent(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some(("", _)) | None => "/",
        Some((parent, _)) => parent,
    }
}

/// The last part of normal `path`.
pub(super) fn name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

/// OpenCode's `external_directory` resource for folder `dir`:
/// `path.join(dir, "*")`.
pub(super) fn star(dir: &str) -> String {
    if dir == "/" { "/*".to_owned() } else { format!("{dir}/*") }
}

/// `path.relative(from, to)` for normal absolute paths, `.` for the same:
/// the resource OpenCode names a path inside the folder by.
pub(super) fn relative(from: &str, to: &str) -> String {
    let from: Vec<&str> = from.split('/').filter(|p| !p.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|p| !p.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    if parts.is_empty() { ".".to_owned() } else { parts.join("/") }
}

/// The real path of `path`, every link followed; None when it can't be
/// made (it doesn't exist, can't be read, or isn't UTF-8).
pub(super) fn real(path: &str) -> Option<String> {
    fs::canonicalize(path).ok()?.into_os_string().into_string().ok()
}

/// Where a write to normal `path` lands (design v4 2.3.2 rule 3): an existing
/// path's real path, a link followed to what it names; a new file's nearest
/// existing folder's real path with the rest. None when that can't be told:
/// a link to nothing, a parent that isn't a folder, an error.
pub(super) fn real_for_write(path: &str) -> Option<String> {
    let mut rest: Vec<&str> = Vec::new();
    let mut at = path;
    loop {
        match fs::symlink_metadata(at) {
            Ok(_) => {
                let found = real(at)?;
                if rest.is_empty() {
                    return Some(found);
                }
                if !fs::metadata(&found).ok()?.is_dir() {
                    return None;
                }
                rest.reverse();
                return Some(normal(&format!("{found}/{}", rest.join("/"))));
            }
            Err(error) if error.kind() == ErrorKind::NotFound && at != "/" => {
                rest.push(name(at));
                at = parent(at);
            }
            Err(_) => return None,
        }
    }
}

/// Whether a file name is a `.env` file's (`*.env`, `*.env.*`, but not
/// `*.env.example`), in any case.
pub(super) fn is_env(name: &str) -> bool {
    let name = name.to_lowercase();
    (name.ends_with(".env") || name.contains(".env.")) && !name.ends_with(".env.example")
}

/// The locations an executor's rules protect, each as given and as its real
/// path, and what may be read of Core's data directory: O and T, real.
pub(super) struct Places {
    pub dirs: Vec<String>,
    pub files: Vec<String>,
    pub data: Vec<String>,
    pub kept: Vec<String>,
    /// The device and inode of each protected location and D that exists.
    pub ids: Vec<(u64, u64)>,
}

impl Places {
    /// Why reading real path `c` is refused for where it is, if it is
    /// (design v4 2.3.3): in a protected folder, a protected file, or in D
    /// but not in O or T. A protected location is checked first, so it
    /// holds inside O and T too.
    pub(super) fn located(&self, c: &str) -> Option<Reason> {
        if self.dirs.iter().any(|dir| within(c, dir)) || self.files.iter().any(|file| file == c) {
            return Some(Reason::Protected);
        }
        if self.data.iter().any(|dir| within(c, dir)) && !self.kept.iter().any(|dir| within(c, dir)) {
            return Some(Reason::CoreData);
        }
        None
    }

    /// Whether a search of real folder `c` reaches a protected location or D
    /// at any depth, or is of `/`.
    pub(super) fn holds(&self, c: &str) -> bool {
        c == "/" || self.dirs.iter().chain(&self.files).chain(&self.data).any(|place| within(place, c))
    }
}

/// What a bounded walk of a folder found (design v4 2.3.3, grep).
#[derive(Debug, PartialEq)]
pub(super) enum Scanned {
    /// No `.env` file and nothing protected.
    Clear,
    /// A `.env` file, a protected location by device and inode, or a link
    /// to either.
    Found,
    /// The budget ran out, or a read failed: nothing was proven.
    Unproven,
}

/// Walks real folder `root` as ripgrep would reach it, without following
/// links or reading `.gitignore` (so it refuses more, never less), to prove
/// no `.env` file is under it. A link isn't walked into, but what it names
/// is checked as a read would be: a link in T to a protected file is found.
/// One that names nothing can't be read and is passed over. Each folder,
/// entry and link takes one of `spend`.
pub(super) fn scan(root: &str, places: &Places, spend: &mut Spend<'_>) -> Scanned {
    let mut folders = vec![std::path::PathBuf::from(root)];
    while let Some(folder) = folders.pop() {
        if !spend.take() {
            return Scanned::Unproven;
        }
        let Ok(entries) = fs::read_dir(&folder) else { return Scanned::Unproven };
        for entry in entries {
            if !spend.take() {
                return Scanned::Unproven;
            }
            let Ok(entry) = entry else { return Scanned::Unproven };
            if is_env(&entry.file_name().to_string_lossy()) {
                return Scanned::Found;
            }
            // DirEntry's type and metadata are the entry's own, not a link's target's.
            let (Ok(kind), Ok(own)) = (entry.file_type(), entry.metadata()) else { return Scanned::Unproven };
            if places.ids.contains(&(own.dev(), own.ino())) {
                return Scanned::Found;
            }
            if kind.is_dir() {
                folders.push(entry.path());
            } else if kind.is_symlink() {
                if !spend.take() {
                    return Scanned::Unproven;
                }
                match fs::canonicalize(entry.path()) {
                    Ok(target) => {
                        let Some(target) = target.to_str() else { return Scanned::Unproven };
                        if places.located(target).is_some() || is_env(name(target)) {
                            return Scanned::Found;
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(_) => return Scanned::Unproven,
                }
            }
        }
    }
    Scanned::Clear
}
