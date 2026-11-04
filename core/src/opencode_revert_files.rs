//! What an OpenCode Agent's revert would do to its files, read before it is
//! asked, and what it did, checked after (T-10 Revert; Lead 3990, 4002, 4016,
//! 4019).
//!
//! OpenCode 1.19.3's v1 revert (`session/revert.ts`, `snapshot/index.ts`)
//! sends every file a `patch` part after the boundary names back to that
//! file's first such part's snapshot: a tree in OpenCode's own snapshot store
//! (`<data>/snapshot/<project>/<sha1 of the worktree>`). A path that tree does
//! not hold is deleted, and so is one whose tree or object cannot be read; a
//! checkout that fails is only logged. It answers success either way. So
//! what each file should become is read here from that store, read only
//! (never a checkout, an index, a ref or any write), before anything is
//! asked: every path must come out known, or nothing is asked. After the
//! revert, each path is compared with what it should be and with what it was.
//!
//! The store is found only for an OpenCode this Core started as a native
//! executable (`Launcher`), from the environment it gave it (`Roots`): a script
//! or another launcher may change that environment, and then where the store
//! is cannot be known.
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// How much a revert's files may hold for Core to read, keep and check them.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub paths: usize,
    /// Bytes of one file, now or in the snapshot.
    pub file: u64,
    /// Bytes of every file, now and in the snapshot, together.
    pub total: u64,
}

pub const BOUNDS: Bounds = Bounds { paths: 200, file: 8 << 20, total: 32 << 20 };

const GIT_SECONDS: u64 = 30;

/// What the `opencode` a Core starts resolves to: a native executable, kept
/// by its identity on disk, or something else, which may change the
/// environment it is given before OpenCode runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Launcher {
    Native { path: PathBuf, size: u64, modified: Option<u128>, inode: u64 },
    Other { path: PathBuf, why: String },
}

impl Launcher {
    /// `program` as `/bin/sh` finds it to run it: an absolute path as it is,
    /// else the first executable file of that name in `path` (the PATH of
    /// the environment it is given), followed to the file itself. A PATH
    /// entry that is empty or relative names a folder relative to where it
    /// runs, so it is not looked through: one before the match makes it
    /// unknown.
    pub fn resolve(program: &Path, path: Option<&OsStr>) -> Result<Self> {
        let found = if program.is_absolute() {
            program.to_path_buf()
        } else if program.as_os_str().as_encoded_bytes().contains(&b'/') {
            // Relative to the folder OpenCode is started in, the Agent's.
            return Ok(Self::Other { path: program.to_path_buf(), why: "it is a relative path".into() });
        } else {
            let mut found = None;
            for dir in std::env::split_paths(path.unwrap_or_default()) {
                if !dir.is_absolute() {
                    return Ok(Self::Other { path: program.to_path_buf(), why: format!("PATH has a relative entry ({}) before it", dir.display()) });
                }
                let candidate = dir.join(program);
                if executable(&candidate) {
                    found = Some(candidate);
                    break;
                }
            }
            found.with_context(|| format!("{} is not on the PATH OpenCode is started with", program.display()))?
        };
        let real = std::fs::canonicalize(&found).with_context(|| format!("{} cannot be followed to a file", found.display()))?;
        let metadata = std::fs::metadata(&real).with_context(|| format!("{} cannot be read", real.display()))?;
        let mut head = [0u8; 4];
        let read = std::io::Read::read(&mut std::fs::File::open(&real)?, &mut head)?;
        if read < 4 || !native(&head) {
            return Ok(Self::Other { path: real, why: "it is not a native executable (a script or another launcher)".into() });
        }
        Ok(Self::Native { path: real, size: metadata.len(), modified: modified(&metadata), inode: inode(&metadata) })
    }

    /// The native executable it still is, the very file it was; why not otherwise.
    pub fn check(&self) -> Result<()> {
        match self {
            Self::Other { path, why } => {
                bail!("OpenCode was started through {}, and {why}: where it keeps its snapshots is not known", path.display())
            }
            Self::Native { path, size, modified: was, inode: number } => {
                let now = std::fs::metadata(path).with_context(|| format!("{} cannot be read now", path.display()))?;
                ensure!(now.len() == *size && modified(&now) == *was && inode(&now) == *number,
                    "{} has changed since OpenCode was started from it", path.display());
                Ok(())
            }
        }
    }
}

fn native(head: &[u8; 4]) -> bool {
    // ELF, or Mach-O (32 and 64 bit, either order, and universal).
    head == b"\x7fELF" || matches!(u32::from_be_bytes(*head), 0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe | 0xcafebabe)
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn modified(metadata: &std::fs::Metadata) -> Option<u128> {
    metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_nanos())
}

fn inode(metadata: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(metadata)
}

/// Where OpenCode 1.19.3 keeps what it keeps, as it works them out from the
/// environment it runs with (`core/src/global.ts`, xdg-basedir 5.1.0,
/// Node's `os.homedir()`): `data` holds the snapshot stores; `home`, `state`
/// and `config` are what its `GET /path` answers, to check against.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roots {
    pub home: String,
    pub data: String,
    pub state: String,
    pub config: String,
}

impl Roots {
    /// From the environment OpenCode is started with (`var`), and the
    /// account's own home folder (`passwd`) for when it has no HOME. A
    /// relative or non-UTF-8 folder in it is refused: OpenCode would take it
    /// relative to where it runs. So is an empty HOME: `os.homedir()` answers
    /// it as it is, and xdg-basedir then has no folder at all.
    pub fn of(var: impl Fn(&str) -> Option<std::ffi::OsString>, passwd: impl FnOnce() -> Option<PathBuf>) -> Result<Self> {
        let text = |name: &str| -> Result<Option<String>> {
            match var(name) {
                None => Ok(None),
                Some(value) if value.is_empty() => Ok(None),
                Some(value) => {
                    let value = value.into_string().map_err(|_| anyhow::anyhow!("{name} is not UTF-8"))?;
                    ensure!(value.starts_with('/'), "{name} is not an absolute path ({value})");
                    Ok(Some(value))
                }
            }
        };
        ensure!(var("HOME").is_none_or(|home| !home.is_empty()), "HOME is empty");
        let home = match text("HOME")? {
            Some(home) => home,
            None => {
                let home = passwd().context("there is no HOME and no home folder for this account")?;
                let home = home.into_os_string().into_string().map_err(|_| anyhow::anyhow!("the account's home folder is not UTF-8"))?;
                ensure!(home.starts_with('/'), "the account's home folder is not an absolute path");
                home
            }
        };
        let base = |name: &str, default: &[&str]| -> Result<String> {
            Ok(match text(name)? {
                Some(value) => value,
                None => join(&home, default),
            })
        };
        Ok(Self {
            data: join(&base("XDG_DATA_HOME", &[".local", "share"])?, &["opencode"]),
            state: join(&base("XDG_STATE_HOME", &[".local", "state"])?, &["opencode"]),
            config: join(&base("XDG_CONFIG_HOME", &[".config"])?, &["opencode"]),
            home,
        })
    }

    /// Whether OpenCode's own `GET /path` answer agrees: the same home, state
    /// and config. It names no data folder, so this checks the environment
    /// it works from, not the data folder itself.
    pub fn agrees(&self, path: &Value) -> Result<()> {
        for (name, ours) in [("home", &self.home), ("state", &self.state), ("config", &self.config)] {
            let theirs = path[name].as_str().with_context(|| format!("OpenCode's /path has no {name}"))?;
            ensure!(theirs == ours, "OpenCode's {name} folder is {theirs}, not {ours} as Core started it");
        }
        Ok(())
    }
}

/// `base` and `parts` joined and normalized as Node's `path.join` does, for
/// an absolute `base`.
fn join(base: &str, parts: &[&str]) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for segment in std::iter::once(base).chain(parts.iter().copied()).flat_map(|p| p.split('/')) {
        match segment {
            "" | "." => {}
            ".." => {
                kept.pop();
            }
            segment => kept.push(segment),
        }
    }
    format!("/{}", kept.join("/"))
}

/// OpenCode's snapshot store for `project` and `worktree`
/// (`snapshot/index.ts:71`: `Hash.fast` is SHA-1 in hex), as its `GET /path`
/// and the session name them, in `data`.
pub fn store(data: &str, project: &str, worktree: &str) -> Result<PathBuf> {
    ensure!(!project.is_empty() && project.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "OpenCode's project ID is not one folder name ({project})");
    ensure!(worktree.starts_with('/'), "OpenCode's worktree is not an absolute path ({worktree})");
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, worktree.as_bytes());
    let hex: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    Ok(PathBuf::from(join(data, &["snapshot", project, &hex])))
}

/// One file a revert sends back: as OpenCode names it, relative to the
/// worktree, and the snapshot it goes back to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub file: String,
    pub rel: String,
    pub hash: String,
}

/// The files a revert to the user message `boundary` sends back, in
/// OpenCode's order (`session/revert.ts:46-60`): every `patch` part after the
/// boundary's first part, each file once, with the first such part's
/// snapshot. `messages` are the session's, as OpenCode lists them. Each file
/// must be a plain path inside `folder`, the Agent's own, itself inside
/// `worktree`.
pub fn targets(messages: &[Value], boundary: &str, worktree: &str, folder: &str) -> Result<Vec<Target>> {
    ensure!(worktree != "/" && join(worktree, &[]) == worktree, "OpenCode's worktree is not a plain absolute path ({worktree})");
    ensure!(folder == worktree || folder.starts_with(&format!("{worktree}/")), "The Agent's folder is not inside OpenCode's worktree");
    let mut matched = false;
    let mut found: Vec<Target> = Vec::new();
    for message in messages {
        let info = &message["info"];
        for part in message["parts"].as_array().into_iter().flatten() {
            if matched {
                if part["type"] == "patch" {
                    let hash = part["hash"].as_str().context("A patch part names no snapshot")?;
                    ensure!(matches!(hash.len(), 40 | 64) && hash.bytes().all(|b| b.is_ascii_hexdigit()),
                        "A patch part's snapshot is not an object ID ({hash})");
                    for file in part["files"].as_array().context("A patch part names no files")? {
                        let file = file.as_str().context("A patch part's file is not a path")?;
                        if found.iter().any(|t| t.file == file) {
                            continue;
                        }
                        found.push(Target { file: file.into(), rel: inside(file, worktree, folder)?, hash: hash.into() });
                    }
                }
            } else if info["id"] == boundary {
                ensure!(info["role"] == "user", "A revert goes back to a user message, not to {boundary}");
                matched = true;
            }
        }
    }
    ensure!(matched, "OpenCode would revert nothing: {boundary} is not a message of this session with any part");
    Ok(found)
}

/// `file` relative to `worktree`, as OpenCode works it out (`path.relative`),
/// when it is a plain path inside `folder`.
fn inside(file: &str, worktree: &str, folder: &str) -> Result<String> {
    ensure!(file.starts_with('/') && join(file, &[]) == file.trim_end_matches('/') && !file.ends_with('/'),
        "{file} is not a plain absolute path");
    ensure!(file.starts_with(&format!("{folder}/")), "{file} is outside the Agent's folder");
    Ok(file[worktree.len() + 1..].to_owned())
}

/// What is at a path: nothing, or a file of these bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum State {
    Absent,
    File { size: u64, sha256: String, executable: bool },
}

impl State {
    fn bytes(&self) -> u64 {
        match self {
            Self::Absent => 0,
            Self::File { size, .. } => *size,
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// One read-only Git command on the store: no hooks, fsmonitor, optional
/// locks, prompts, replacements or system and global configuration. Its
/// output, at most `limit` bytes, or why it failed: a failure is never read
/// as absence.
async fn git(store: &Path, args: &[&str], limit: u64) -> Result<std::result::Result<Vec<u8>, String>> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("--git-dir")
        .arg(store)
        .args(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_LITERAL_PATHSPECS", "1");
    for name in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_PARAMETERS"] {
        command.env_remove(name);
    }
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Git could not be started on this Core's host")?;
    let mut out = child.stdout.take().context("Missing Git output")?.take(limit + 1);
    let mut err = child.stderr.take().context("Missing Git errors")?.take(4096);
    let run = async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let (a, b, status) = tokio::join!(out.read_to_end(&mut stdout), err.read_to_end(&mut stderr), child.wait());
        a?;
        b?;
        Ok::<_, anyhow::Error>((status?, stdout, stderr))
    };
    let (status, stdout, stderr) = tokio::time::timeout(Duration::from_secs(GIT_SECONDS), run)
        .await
        .map_err(|_| anyhow::anyhow!("Git did not answer within {GIT_SECONDS} s"))??;
    ensure!(stdout.len() as u64 <= limit, "Git's answer exceeded {limit} bytes");
    Ok(if status.success() { Ok(stdout) } else { Err(String::from_utf8_lossy(&stderr).trim().chars().take(600).collect()) })
}

async fn git_ok(store: &Path, args: &[&str], limit: u64) -> Result<Vec<u8>> {
    git(store, args, limit).await?.map_err(|why| anyhow::anyhow!("git {} failed: {why}", args.join(" ")))
}

/// Whether `store` is a Git store of its own: a folder, no symlink, with its
/// HEAD and objects.
pub fn check_store(store: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(store).with_context(|| format!("OpenCode's snapshot store {} cannot be read", store.display()))?;
    ensure!(metadata.is_dir(), "OpenCode's snapshot store {} is not a folder", store.display());
    ensure!(std::fs::symlink_metadata(store.join("HEAD")).is_ok_and(|m| m.is_file())
        && std::fs::symlink_metadata(store.join("objects")).is_ok_and(|m| m.is_dir()),
        "{} is not a Git store", store.display());
    Ok(())
}

/// What the snapshot `hash` in `store` holds at `rel`, read only: nothing,
/// or a regular file of these bytes. A snapshot or object that cannot be
/// read, or anything but a regular file there, is refused: OpenCode would
/// delete the file, or write what Core cannot check.
pub async fn expected(store: &Path, hash: &str, rel: &str, bounds: Bounds) -> Result<State> {
    let kind = git_ok(store, &["cat-file", "-t", hash], 64).await
        .with_context(|| format!("OpenCode's snapshot {hash} cannot be read; reverting would delete {rel}"))?;
    ensure!(kind == b"tree\n", "OpenCode's snapshot {hash} is not a tree");
    let listed = git_ok(store, &["ls-tree", "-z", hash, "--", rel], 64 * 1024).await
        .with_context(|| format!("{rel} cannot be read in OpenCode's snapshot {hash}"))?;
    let entries: Vec<&[u8]> = listed.split(|b| *b == 0).filter(|e| !e.is_empty()).collect();
    let Some(entry) = (match entries.len() {
        0 => None,
        1 => Some(entries[0]),
        _ => bail!("OpenCode's snapshot {hash} lists more than one entry for {rel}"),
    }) else {
        return Ok(State::Absent);
    };
    let entry = std::str::from_utf8(entry).context("OpenCode's snapshot lists a path that is not UTF-8")?;
    let (head, path) = entry.split_once('\t').context("OpenCode's snapshot listing is not as Git writes it")?;
    let fields: Vec<&str> = head.split(' ').collect();
    ensure!(fields.len() == 3 && path == rel, "OpenCode's snapshot listing is not for {rel}");
    let executable = match (fields[0], fields[1]) {
        ("100644", "blob") => false,
        ("100755", "blob") => true,
        (mode, kind) => bail!("{rel} is a {kind} of mode {mode} in OpenCode's snapshot, not a regular file"),
    };
    let object = fields[2];
    let size: u64 = String::from_utf8(git_ok(store, &["cat-file", "-s", object], 64).await?)?.trim().parse()
        .context("Git did not say the object's size")?;
    ensure!(size <= bounds.file, "{rel} is {size} bytes in OpenCode's snapshot, more than {} for Core to check", bounds.file);
    let bytes = git_ok(store, &["cat-file", "blob", object], size).await?;
    ensure!(bytes.len() as u64 == size, "Git gave {} bytes of {rel}, not {size}", bytes.len());
    Ok(State::File { size, sha256: sha256(&bytes), executable })
}

/// What is at `file` now, no symlink followed (the file itself, and every
/// folder from `folder` down to it): nothing, a regular file and its bytes,
/// or a refusal.
pub fn current(file: &Path, folder: &Path, bounds: Bounds) -> Result<(State, Option<Vec<u8>>)> {
    use std::os::unix::fs::PermissionsExt;
    let below = file.strip_prefix(folder).with_context(|| format!("{} is outside the Agent's folder", file.display()))?;
    let mut at = folder.to_path_buf();
    let mut parts = below.components().peekable();
    while let Some(part) = parts.next() {
        at.push(part);
        let metadata = match std::fs::symlink_metadata(&at) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((State::Absent, None)),
            Err(error) => return Err(error).with_context(|| format!("{} cannot be read", at.display())),
        };
        ensure!(!metadata.file_type().is_symlink(), "{} is a symlink", at.display());
        if parts.peek().is_some() {
            ensure!(metadata.is_dir(), "{} is not a folder", at.display());
            continue;
        }
        ensure!(metadata.is_file(), "{} is not a regular file", at.display());
        ensure!(metadata.len() <= bounds.file, "{} is {} bytes, more than {} for Core to keep", at.display(), metadata.len(), bounds.file);
        let bytes = std::fs::read(&at).with_context(|| format!("{} cannot be read", at.display()))?;
        ensure!(bytes.len() as u64 == metadata.len(), "{} changed while it was read", at.display());
        let executable = metadata.permissions().mode() & 0o100 != 0;
        return Ok((State::File { size: bytes.len() as u64, sha256: sha256(&bytes), executable }, Some(bytes)));
    }
    bail!("{} is the Agent's folder itself", file.display())
}

/// One file a revert sends back: what it should become, and what it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub target: Target,
    pub expected: State,
    pub current: State,
}

/// Every file a revert sends back, each known, within `bounds`; with the
/// bytes of each file there now, for the backup.
pub async fn plan(store: &Path, targets: &[Target], folder: &Path, bounds: Bounds) -> Result<(Vec<Entry>, Vec<Option<Vec<u8>>>)> {
    ensure!(targets.len() <= bounds.paths, "The revert sends back {} files, more than {} for Core to check", targets.len(), bounds.paths);
    check_store(store)?;
    let (mut entries, mut kept, mut total) = (Vec::new(), Vec::new(), 0u64);
    for target in targets {
        let expected = expected(store, &target.hash, &target.rel, bounds).await?;
        let (current, bytes) = current(Path::new(&target.file), folder, bounds)?;
        total += expected.bytes() + current.bytes();
        ensure!(total <= bounds.total, "The revert's files hold more than {} bytes for Core to check", bounds.total);
        entries.push(Entry { target: target.clone(), expected, current });
        kept.push(bytes);
    }
    Ok((entries, kept))
}

/// What Core keeps of each file before the revert is asked, with the attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub entries: Vec<Entry>,
    /// Each entry's kept bytes in `dir`, by entry: none for a file absent then.
    pub files: Vec<Option<String>>,
}

/// The bytes of each file before the revert, in `dir` (new): each is read
/// again and must still be what `entries` say, else nothing is kept and the
/// revert must not be asked. The list is written last.
pub fn backup(dir: &Path, entries: &[Entry], folder: &Path, bounds: Bounds) -> Result<Backup> {
    std::fs::create_dir_all(dir.parent().context("The backup has no parent folder")?)?;
    std::fs::create_dir(dir).with_context(|| format!("{} cannot be made for the backup", dir.display()))?;
    let mut files = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let (now, bytes) = current(Path::new(&entry.target.file), folder, bounds)?;
        ensure!(now == entry.current, "{} has changed since it was checked", entry.target.file);
        files.push(match bytes {
            Some(bytes) => {
                let name = format!("{index}.bin");
                std::fs::write(dir.join(&name), &bytes)?;
                Some(name)
            }
            None => None,
        });
    }
    let kept = Backup { entries: entries.to_vec(), files };
    crate::updates::package::atomic_json(&dir.join("backup.json"), &kept)?;
    Ok(kept)
}

/// What became of one file after the revert.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum Outcome {
    /// It is what the snapshot holds.
    Verified,
    /// It is still what it was before: OpenCode logs a checkout that fails.
    NotRestored,
    /// Neither, or it cannot be read.
    Drifted { now: Option<State>, why: Option<String> },
}

/// Each file as it is now, against what it should be and what it was.
pub fn outcomes(entries: &[Entry], folder: &Path, bounds: Bounds) -> Vec<Outcome> {
    entries
        .iter()
        .map(|entry| match current(Path::new(&entry.target.file), folder, bounds) {
            Ok((now, _)) if now == entry.expected => Outcome::Verified,
            Ok((now, _)) if now == entry.current => Outcome::NotRestored,
            Ok((now, _)) => Outcome::Drifted { now: Some(now), why: None },
            Err(error) => Outcome::Drifted { now: None, why: Some(format!("{error:#}")) },
        })
        .collect()
}

#[cfg(test)]
#[path = "opencode_revert_files_tests.rs"]
mod tests;
