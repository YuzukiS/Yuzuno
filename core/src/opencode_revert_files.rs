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
    Native { path: PathBuf, size: u64, modified: Option<u128>, dev: u64, inode: u64 },
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
        Ok(Self::Native { path: real, size: metadata.len(), modified: modified(&metadata), dev: std::os::unix::fs::MetadataExt::dev(&metadata), inode: inode(&metadata) })
    }

    /// The native executable it still is, the very file it was; why not otherwise.
    pub fn check(&self) -> Result<()> {
        match self {
            Self::Other { path, why } => {
                bail!("OpenCode was started through {}, and {why}: where it keeps its snapshots is not known", path.display())
            }
            Self::Native { path, size, modified: was, dev, inode: number } => {
                let now = std::fs::metadata(path).with_context(|| format!("{} cannot be read now", path.display()))?;
                ensure!(now.len() == *size && modified(&now) == *was && std::os::unix::fs::MetadataExt::dev(&now) == *dev && inode(&now) == *number,
                    "{} has changed since OpenCode was started from it", path.display());
                Ok(())
            }
        }
    }

    /// That the process `pid` runs this very file (`/proc/<pid>/exe`: the
    /// file it executes, however it was named), as a check of what was
    /// started, not only of what was resolved (Lead 4037). Linux only.
    pub fn bound(&self, pid: u32) -> Result<()> {
        let Self::Native { path, size, dev, inode: number, .. } = self else {
            return self.check();
        };
        ensure!(cfg!(target_os = "linux"), "What OpenCode's process runs can be checked only on Linux");
        let running = std::fs::metadata(format!("/proc/{pid}/exe")).context("What OpenCode's process runs cannot be read")?;
        ensure!(std::os::unix::fs::MetadataExt::dev(&running) == *dev && inode(&running) == *number && running.len() == *size,
            "OpenCode's process does not run {}", path.display());
        Ok(())
    }
}

/// Where a connection's OpenCode keeps its snapshots can be known from how
/// Core started it: the launcher it resolved, ran and bound to the process,
/// and OpenCode's folders from the environment it gave it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Started {
    pub launcher: Launcher,
    pub roots: Roots,
}

impl Started {
    /// For the process `pid` started from `launcher`, with the environment
    /// `var` gives and whose variables are `names` (and `passwd` for an
    /// account's home when it has no HOME): what is known, or why it is not.
    pub fn of(launcher: Result<Launcher>, pid: Option<u32>, var: impl Fn(&str) -> Option<std::ffi::OsString>,
        names: impl IntoIterator<Item = std::ffi::OsString>, passwd: impl FnOnce() -> Option<PathBuf>) -> std::result::Result<Self, String> {
        let known = || -> Result<Self> {
            let launcher = launcher?;
            launcher.check()?;
            launcher.bound(pid.context("OpenCode's process has no ID")?)?;
            let set: Vec<String> = names.into_iter().filter_map(|name| name.into_string().ok()).filter(|name| git_scope(name)).collect();
            ensure!(set.is_empty(), "Core's environment sets {}, which OpenCode's own Git takes up: what its checkout reads cannot be read the same way",
                set.join(", "));
            Ok(Self { launcher, roots: Roots::of(var, passwd)? })
        };
        known().map_err(|error| format!("{error:#}"))
    }
}

/// A variable that changes what Git reads for OpenCode's own checkout (its
/// store, index, objects, configuration, attributes, or how it reads a path).
/// OpenCode passes its environment on to Git, so one set means Core cannot
/// read what that checkout reads the same way (Lead 4051).
fn git_scope(name: &str) -> bool {
    name.starts_with("GIT_CONFIG")
        || matches!(name, "GIT_DIR" | "GIT_WORK_TREE" | "GIT_INDEX_FILE" | "GIT_OBJECT_DIRECTORY" | "GIT_ALTERNATE_OBJECT_DIRECTORIES"
            | "GIT_COMMON_DIR" | "GIT_NAMESPACE" | "GIT_ATTR_NOSYSTEM" | "GIT_ATTR_SOURCE" | "GIT_NO_REPLACE_OBJECTS" | "GIT_REPLACE_REF_BASE"
            | "GIT_LITERAL_PATHSPECS" | "GIT_GLOB_PATHSPECS" | "GIT_NOGLOB_PATHSPECS" | "GIT_ICASE_PATHSPECS")
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
    // OpenCode checks the file out by its path as a Git pathspec (`snapshot/index.ts:427,496`), where these are
    // patterns: it could restore files of other names too, which Core neither lists nor backs up (Lead 4036).
    ensure!(!file.contains(['*', '?', '[', '\\']), "{file} has a character Git reads as a pattern (* ? [ \\): OpenCode could restore more than this file");
    // Put back, it could change how Git writes every other file (Lead 4051).
    ensure!(Path::new(file).file_name() != Some(OsStr::new(".gitattributes")),
        "{file} is a .gitattributes file: putting it back could change how Git writes the others");
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
    let (status, stdout, said) = capture(command, limit).await?;
    Ok(if status.success() { Ok(stdout) } else { Err(said) })
}

/// `command` run with its answer kept, at most `limit` bytes of it: more ends
/// it at once (killed and reaped), as does GIT_SECONDS without an end. What
/// it says on error is kept from its start and the rest read away, so it
/// never waits on a full pipe.
async fn capture(mut command: tokio::process::Command, limit: u64) -> Result<(std::process::ExitStatus, Vec<u8>, String)> {
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Git could not be started on this Core's host")?;
    let mut out = child.stdout.take().context("Missing Git output")?;
    let mut err = child.stderr.take().context("Missing Git errors")?;
    let said = tokio::spawn(async move {
        let mut kept = Vec::new();
        (&mut err).take(4096).read_to_end(&mut kept).await?;
        tokio::io::copy(&mut err, &mut tokio::io::sink()).await?;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&kept).trim().chars().take(600).collect::<String>())
    });
    let run = async {
        let mut stdout = Vec::new();
        (&mut out).take(limit + 1).read_to_end(&mut stdout).await?;
        if stdout.len() as u64 > limit {
            let _ = child.start_kill();
            let _ = child.wait().await;
            bail!("Git's answer exceeded {limit} bytes");
        }
        Ok::<_, anyhow::Error>((child.wait().await?, stdout))
    };
    let (status, stdout) = tokio::time::timeout(Duration::from_secs(GIT_SECONDS), run)
        .await
        .map_err(|_| anyhow::anyhow!("Git did not answer within {GIT_SECONDS} s"))??;
    let said = said.await.context("What Git said was not read")??;
    Ok((status, stdout, said))
}

/// Git as OpenCode itself runs it on its store for a checkout (`snapshot/index.ts`: its work tree, its own
/// `core.longpaths` and `core.symlinks`, and the configuration and attributes the environment it was given names,
/// global and system ones included; `env` is what Core sets for that process beyond its own environment), for
/// questions whose answer depends on that scope: what such a checkout would do to a file's bytes. The environment
/// is passed on as it is: one that changes Git's scope refuses where OpenCode was started (`Started`). Nothing it
/// runs writes or runs a filter.
async fn native_git(store: &Path, worktree: &Path, env: &[(String, String)], args: &[&str], limit: u64) -> Result<(std::process::ExitStatus, Vec<u8>, String)> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("--git-dir")
        .arg(store)
        .arg("--work-tree")
        .arg(worktree)
        .args(["-c", "core.longpaths=true", "-c", "core.symlinks=true", "-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(worktree)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(env.iter().map(|(k, v)| (k, v)));
    capture(command, limit).await
}

/// That OpenCode's checkout of `rel` would write the snapshot's bytes as they are (Lead 4037): no attribute that
/// converts them (`text`, `eol`, `crlf`, `ident`, `filter`, `working-tree-encoding`) and no `core.autocrlf` that
/// would, as Git reads them for that checkout (`native_git`). Only none of them, or `-text`, lets the snapshot's
/// bytes be what the file becomes; anything else refuses, and no filter is ever run to find out what it would do.
pub async fn unconverted(store: &Path, worktree: &Path, env: &[(String, String)], rel: &str) -> Result<()> {
    // Both views of the attributes: the work tree's `.gitattributes` first, and the index's alone. Which one a
    // checkout reads first depends on how Git does it (Git 2.56's `checkout <tree> -- <path>` took the work tree's,
    // checked by hand), so either one that converts refuses (Lead 4051).
    for cached in [false, true] {
        let mut ask = vec!["check-attr", "-z"];
        if cached {
            ask.push("--cached");
        }
        ask.extend(["text", "eol", "crlf", "ident", "filter", "working-tree-encoding", "--", rel]);
        let (status, listed, said) = native_git(store, worktree, env, &ask, 64 * 1024).await
            .with_context(|| format!("What Git would do to {rel} on OpenCode's checkout cannot be read"))?;
        ensure!(status.success(), "git {} failed: {said}", ask.join(" "));
        let fields: Vec<&[u8]> = listed.split(|b| *b == 0).collect();
        for answer in fields.chunks(3).filter(|answer| answer.len() == 3) {
            let (attribute, value) = (String::from_utf8_lossy(answer[1]), String::from_utf8_lossy(answer[2]));
            let plain = value == "unspecified" || (attribute == "text" && value == "unset");
            ensure!(plain, "Git would convert {rel} as OpenCode checks it out ({attribute}: {value}{}), so it would not become the snapshot's bytes",
                if cached { ", by the index's attributes" } else { "" });
        }
    }
    // Unset is exit 1 with nothing said; any other failure is not an answer. Only what Git reads as false, or
    // `input` (which converts on commit alone), leaves a checkout's bytes as they are: anything else, a key with no
    // value (true) included, refuses.
    let ask = ["config", "--get", "core.autocrlf"];
    let (status, value, said) = native_git(store, worktree, env, &ask, 64).await?;
    let autocrlf = match status.code() {
        Some(0) => String::from_utf8_lossy(&value).trim().to_ascii_lowercase(),
        Some(1) if value.is_empty() && said.is_empty() => "false".into(),
        _ => bail!("git {} failed: {said}", ask.join(" ")),
    };
    ensure!(matches!(autocrlf.as_str(), "false" | "no" | "off" | "0" | "input"),
        "Git would convert line endings as OpenCode checks files out (core.autocrlf {autocrlf:?})");
    Ok(())
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

/// The Agent's folder, held by what it is (device and inode), not by its
/// path: every read of a file below it starts from it, and stops if it is
/// no longer that folder (Lead 4036).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Root {
    pub dev: u64,
    pub ino: u64,
}

impl Root {
    /// `folder` as it is now: a folder, itself no symlink.
    pub fn of(folder: &Path) -> Result<Self> {
        let fd = open_root(folder)?;
        let stat = rustix::fs::fstat(&fd)?;
        Ok(Self::of_stat(&stat))
    }
}

fn open_root(folder: &Path) -> Result<rustix::fd::OwnedFd> {
    use rustix::fs::{Mode, OFlags};
    rustix::fs::open(folder, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())
        .with_context(|| format!("The Agent's folder {} cannot be opened as a folder", folder.display()))
}

/// What is at `file` now: nothing, or a regular file and its bytes; anything
/// else refuses. It is reached from `folder`, which must still be `root`, one
/// name at a time, each opened from the folder before it and never through a
/// symlink. Its kind is read before it is opened, so a FIFO or a device found
/// there is not opened; one put there between that read and the open is
/// opened without waiting (non-blocking) and refused by the check of the open
/// file made before any byte is read: the same file (device and inode),
/// regular, within `bounds.file`. At most that many bytes are read, and the
/// file must not change meanwhile. Before it answers, the path is walked
/// again from `folder`: every name must still be what was opened (and a
/// missing one still missing), so a file renamed away meanwhile is never
/// taken for what is at the path. A folder that is gone, or no longer `root`,
/// refuses: it never reads as nothing there. What is written there after it
/// answers, before OpenCode's revert, cannot be excluded.
pub fn current(file: &Path, folder: &Path, root: Root, bounds: Bounds) -> Result<(State, Option<Vec<u8>>)> {
    use rustix::fs::{AtFlags, FileType, Mode, OFlags};
    use rustix::io::Errno;
    let below = file.strip_prefix(folder).with_context(|| format!("{} is outside the Agent's folder", file.display()))?;
    let names: Vec<&OsStr> = below
        .components()
        .map(|part| match part {
            std::path::Component::Normal(name) => Ok(name),
            _ => bail!("{} is not a plain path", file.display()),
        })
        .collect::<Result<_>>()?;
    ensure!(!names.is_empty(), "{} is the Agent's folder itself", file.display());
    let mut dir = open_root(folder)?;
    ensure!(Root::of_fd(&dir)? == root, "The Agent's folder {} is no longer the folder it was", folder.display());
    let mut at = folder.to_path_buf();
    // What each name was as it was opened, to walk the path again with.
    let mut seen: Vec<Root> = Vec::new();
    let mut found = (State::Absent, None);
    for (index, name) in names.iter().enumerate() {
        at.push(name);
        let stat = match rustix::fs::statat(&dir, *name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => stat,
            Err(Errno::NOENT) => break,
            Err(error) => return Err(error).with_context(|| format!("{} cannot be read", at.display())),
        };
        let id = Root::of_stat(&stat);
        let kind = FileType::from_raw_mode(stat.st_mode);
        ensure!(kind != FileType::Symlink, "{} is a symlink", at.display());
        if index + 1 < names.len() {
            ensure!(kind == FileType::Directory, "{} is not a folder", at.display());
            let next = rustix::fs::openat(&dir, *name, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())
                .with_context(|| format!("{} cannot be opened as a folder", at.display()))?;
            ensure!(Root::of_fd(&next)? == id, "{} changed while it was read", at.display());
            seen.push(id);
            dir = next;
            continue;
        }
        ensure!(kind == FileType::RegularFile, "{} is not a regular file", at.display());
        ensure!(stat.st_size as u64 <= bounds.file, "{} is {} bytes, more than {} for Core to keep", at.display(), stat.st_size, bounds.file);
        let opened = rustix::fs::openat(&dir, *name, OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC, Mode::empty())
            .with_context(|| format!("{} cannot be opened", at.display()))?;
        let before = rustix::fs::fstat(&opened)?;
        ensure!(Root::of_fd(&opened)? == id && FileType::from_raw_mode(before.st_mode) == FileType::RegularFile && before.st_size as u64 <= bounds.file,
            "{} changed before it was read", at.display());
        let mut handle = std::fs::File::from(opened);
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(&mut handle, bounds.file + 1), &mut bytes)
            .with_context(|| format!("{} cannot be read", at.display()))?;
        let after = rustix::fs::fstat(&handle)?;
        ensure!(bytes.len() as u64 <= bounds.file, "{} grew past {} bytes while it was read", at.display(), bounds.file);
        // The widths of these fields differ between Linux and macOS.
        #[allow(clippy::unnecessary_cast)]
        let same = |a: &rustix::fs::Stat| (a.st_dev as u64, a.st_ino as u64, a.st_size as u64, a.st_mtime as i64, a.st_mtime_nsec as i64, a.st_mode);
        ensure!(same(&before) == same(&stat) && same(&after) == same(&stat) && bytes.len() as u64 == stat.st_size as u64,
            "{} changed while it was read", at.display());
        seen.push(id);
        let executable = stat.st_mode & 0o100 != 0;
        found = (State::File { size: bytes.len() as u64, sha256: sha256(&bytes), executable }, Some(bytes));
    }
    // The path walked again: the folder, every name as it was opened, and the one missing still missing.
    let mut dir = open_root(folder)?;
    ensure!(Root::of_fd(&dir)? == root, "The Agent's folder {} changed while {} was read", folder.display(), file.display());
    for (index, name) in names.iter().enumerate() {
        let now = match rustix::fs::statat(&dir, *name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => Some(Root::of_stat(&stat)),
            Err(Errno::NOENT) => None,
            Err(error) => return Err(error).with_context(|| format!("{} cannot be read again", file.display())),
        };
        ensure!(now == seen.get(index).copied(), "{} changed while it was read", file.display());
        if now.is_none() || index + 1 == names.len() {
            break;
        }
        dir = rustix::fs::openat(&dir, *name, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty())
            .with_context(|| format!("{} cannot be read again", file.display()))?;
        ensure!(Some(Root::of_fd(&dir)?) == now, "{} changed while it was read", file.display());
    }
    Ok(found)
}

impl Root {
    // The widths of these fields differ between Linux and macOS.
    #[allow(clippy::unnecessary_cast)]
    fn of_stat(stat: &rustix::fs::Stat) -> Self {
        Self { dev: stat.st_dev as u64, ino: stat.st_ino as u64 }
    }

    fn of_fd(fd: &rustix::fd::OwnedFd) -> Result<Self> {
        let stat = rustix::fs::fstat(fd)?;
        Ok(Self::of_stat(&stat))
    }
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
pub async fn plan(store: &Path, worktree: &Path, env: &[(String, String)], targets: &[Target], folder: &Path, root: Root, bounds: Bounds) -> Result<(Vec<Entry>, Vec<Option<Vec<u8>>>)> {
    ensure!(targets.len() <= bounds.paths, "The revert sends back {} files, more than {} for Core to check", targets.len(), bounds.paths);
    check_store(store)?;
    let (mut entries, mut kept, mut total) = (Vec::new(), Vec::new(), 0u64);
    for target in targets {
        let expected = expected(store, &target.hash, &target.rel, bounds).await?;
        if matches!(expected, State::File { .. }) {
            unconverted(store, worktree, env, &target.rel).await?;
        }
        let (current, bytes) = current(Path::new(&target.file), folder, root, bounds)?;
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

/// The bytes of each file before the revert, in `dir`, made here in a parent
/// folder that is already there and on disk (the caller's to ensure): each is
/// read again and must still be what `entries` say, else nothing is kept and
/// the revert must not be asked. Each copy is on disk (synced) before the
/// list, which is written last and synced with its folder; the parent's entry
/// for `dir` is synced too. Any failure means no backup, so no revert.
pub fn backup(dir: &Path, entries: &[Entry], folder: &Path, root: Root, bounds: Bounds) -> Result<Backup> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let parent = dir.parent().context("The backup has no parent folder")?;
    ensure!(std::fs::symlink_metadata(parent).is_ok_and(|m| m.is_dir()), "{} is not a folder to keep a backup in", parent.display());
    std::fs::create_dir(dir).with_context(|| format!("{} cannot be made for the backup", dir.display()))?;
    let mut files = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let (now, bytes) = current(Path::new(&entry.target.file), folder, root, bounds)?;
        ensure!(now == entry.current, "{} has changed since it was checked", entry.target.file);
        files.push(match bytes {
            Some(bytes) => {
                let name = format!("{index}.bin");
                let mut copy = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(dir.join(&name))?;
                copy.write_all(&bytes)?;
                copy.sync_all()?;
                Some(name)
            }
            None => None,
        });
    }
    let kept = Backup { entries: entries.to_vec(), files };
    crate::updates::package::atomic_json(&dir.join("backup.json"), &kept)?;
    std::fs::File::open(parent)?.sync_all()?;
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
pub fn outcomes(entries: &[Entry], folder: &Path, root: Root, bounds: Bounds) -> Vec<Outcome> {
    entries
        .iter()
        .map(|entry| match current(Path::new(&entry.target.file), folder, root, bounds) {
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
