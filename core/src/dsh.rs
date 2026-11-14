//! dsh, the DeepSeek Harness (YN-119, design v1 §3.1–§3.3 and §5.1), through
//! the interface it gives automated clients: `dsh --profile acp`, ACP v1,
//! JSON-RPC 2.0 as one JSON object per line on stdin and stdout. One process
//! per Agent, with a `DSH_HOME` of the Agent's own. This is the process layer
//! (slice S1): the program, its version, Core's overlay and its read-back,
//! the transport, and the end. Turns, events and the Agent's record are
//! `dsh_agent`'s (S2a); this module decides nothing about them.
//!
//! dsh takes a key it does not know, a row that is not there and a value it
//! cannot use, and starts all the same (probe ea68fd90). So a start that
//! succeeds says nothing by itself, and `Dsh::start` refuses, naming the
//! step, unless each check passes (§3.3):
//! 1. the version `dsh --version` prints (`standing`);
//! 2. the composed configuration, read back with `--dump-config`
//!    (`check_dump`);
//! 3. the keys and values Core writes, against dsh's own schema
//!    (`check_schema`);
//! 4. the answer to `initialize` (`check_initialize`).
//!
//! The fifth, the answer to `session/new` or `session/resume`, is the
//! caller's (`check_session`).
//!
//! dsh runs in a process group of its own, so what stays in it ends with it
//! (`shutdown`, or a `Dsh` dropped), also once dsh has exited by itself: the
//! group is sent SIGKILL after dsh exits and before it is reaped. dsh also
//! ends when its stdin closes (in about 0.1 s, probe cf6d119a), so a Core
//! that ends without either leaves no dsh reading behind.
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fmt,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering as Atomic},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, watch},
    time::timeout,
};

use crate::backlog::EventSender;
use crate::routing_keys::Secret;
use crate::rpc::{OutcomeUnknown, RpcError};

/// The line of dsh this module speaks (§5.1). dsh is still 0.y, where each
/// minor may break (semver 2.0.0 §4; its upgrade guide is per version), so
/// `0.2` counts as a major. The line of probe cf6d119a.
pub const LINE: &str = "0.2";
/// The newest release checked (probe cf6d119a: npm `next` at the design).
pub const VERIFIED: &str = "0.2.2-rc.3";
/// The oldest release checked (probe cf6d119a: npm `latest` at the design).
/// An older one, or one whose version cannot be read, is refused.
pub const MIN: &str = "0.2.2-rc.1";

/// The rows of dsh's configuration Core's overlay replaces (§3.2), in the
/// order it writes them (`Launch::rows`): each start reads every one back
/// (`check_dump`) and checks its keys against dsh's schema (`check_schema`).
/// A row a later dsh renames or drops refuses the start, naming it.
pub const OVERLAY_ROWS: [&str; 6] = [
    "session-log-deepseek",
    "plugin-package-inventory-deepseek",
    "session-telemetry-otel",
    "acp",
    "sandbox-policy",
    "approval",
];

/// What a refusal of the version tells the user to do (§5.1).
const UPDATE: &str = "install or update dsh: npm i -g @deepseek-ai/dsh@latest";
/// How long `--version` may take (§5.1).
const VERSION_LIMIT: Duration = Duration::from_secs(10);
/// How long `--dump-config` and `--dump-config-schema` may each take (§3.3;
/// measured 0.1 s and 1.4–1.9 s, YN-124 capture).
const DUMP_LIMIT: Duration = Duration::from_secs(15);
/// How long `initialize` may take: a first start writes its profile first
/// (1.4 s measured, probe cf6d119a). OpenCode is given as long (opencode.rs).
const START_LIMIT: Duration = Duration::from_secs(30);
/// How long `shutdown` waits after closing stdin, and again after SIGTERM,
/// before the next step (§3.1): dsh gives its own teardown 5 s after a signal
/// (apps/cli/src/process-shutdown.ts); measured 0.1 s.
pub const CLOSE_GRACE: Duration = Duration::from_secs(5);
/// The most of dsh's stderr kept to say why it failed: its last 16 KiB (§3.1).
const STDERR_KEPT: usize = 16 << 10;
/// The most Core reads of `--version` (one line), `--dump-config` (13 KiB
/// measured) and `--dump-config-schema` (630 KiB measured); more is refused.
const VERSION_MOST: usize = 4 << 10;
const DUMP_MOST: usize = 4 << 20;
const SCHEMA_MOST: usize = 32 << 20;
/// What a refusal quotes of what dsh said.
const REASON_CHARS: usize = 600;

/// The `dsh` this Core starts: `YUZUNO_DSH_BIN`, else `dsh` from PATH. The
/// user installs it; Core neither bundles nor updates it (§3.1), as with
/// Codex and OpenCode.
pub fn program() -> PathBuf {
    std::env::var_os("YUZUNO_DSH_BIN").map(PathBuf::from).unwrap_or_else(|| "dsh".into())
}

/// An Agent's own folder for dsh, `<data>/dsh/<agent>` (§3.1), which Core
/// creates and owns: `home/` is its DSH_HOME and `overlay.yml` is beside it.
pub fn folder(data: &Path, agent: &str) -> Result<PathBuf> {
    ensure!(!agent.is_empty() && agent != "." && agent != ".." && !agent.contains(['/', '\\', '\0']),
        "An Agent ID is not a folder name");
    Ok(data.join("dsh").join(agent))
}

/// Folders outside the Agent's folder its sandbox may also write (§3.2,
/// `additionalWritableRoots`): the Git common directory of a linked worktree
/// there, so that `git commit` can write it, as dsh's own documentation says
/// (sandbox-policy README:51, risk included: hooks and config are in it).
/// None when the folder is not in Git, or the directory is inside it; a Git
/// that cannot say leaves none, so the sandbox only ever gets narrower.
pub async fn writable_roots(directory: &Path) -> Vec<PathBuf> {
    let mut command = Command::new("git");
    command.args(["rev-parse", "--path-format=absolute", "--git-common-dir"]).current_dir(directory)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let Ok(Ok(out)) = timeout(VERSION_LIMIT, command.output()).await else { return Vec::new() };
    let Ok(text) = String::from_utf8(out.stdout) else { return Vec::new() };
    let common = text.trim_end_matches(['\n', '\r']);
    if !out.status.success() || common.is_empty() {
        return Vec::new();
    }
    match (std::fs::canonicalize(common), std::fs::canonicalize(directory)) {
        (Ok(common), Ok(root)) if !common.starts_with(&root) => vec![common],
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------- versions

/// A version as semver 2.0.0 ranks it (§11): MAJOR.MINOR.PATCH, then a
/// pre-release below its release, its identifiers compared one by one
/// (numbers as numbers, below text); build metadata does not count.
#[derive(Clone, Debug)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<Ident>,
    text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Ident {
    // Declared first: a numeric identifier ranks below an alphanumeric one.
    Number(u64),
    Text(String),
}

impl Version {
    /// `0.2.2-rc.3`, as `dsh --version` prints it (an optional leading `v`
    /// is taken too). None for anything that is not semver 2.0.0.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let core = text.strip_prefix('v').unwrap_or(text);
        let (core, build) = core.split_once('+').map_or((core, None), |(c, b)| (c, Some(b)));
        let (numbers, pre) = core.split_once('-').map_or((core, None), |(n, p)| (n, Some(p)));
        let number = |part: &str| -> Option<u64> {
            (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) && (part == "0" || !part.starts_with('0')))
                .then(|| part.parse().ok()).flatten()
        };
        let mut parts = numbers.split('.');
        let (major, minor, patch) = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);
        if parts.next().is_some() {
            return None;
        }
        let word = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if let Some(build) = build {
            if !build.split('.').all(word) {
                return None;
            }
        }
        let pre = match pre {
            None => Vec::new(),
            Some(pre) => pre.split('.').map(|part| {
                if !word(part) {
                    None
                } else if part.bytes().all(|b| b.is_ascii_digit()) {
                    number(part).map(Ident::Number)
                } else {
                    Some(Ident::Text(part.to_owned()))
                }
            }).collect::<Option<Vec<_>>>()?,
        };
        Some(Self { major, minor, patch, pre, text: text.to_owned() })
    }

    /// Its line (§5.1): `0.y` while the major is 0, else the major.
    fn line(&self) -> (u64, Option<u64>) {
        if self.major == 0 { (0, Some(self.minor)) } else { (self.major, None) }
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)).then_with(|| {
            match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                // A shorter list whose identifiers all equal the longer one's ranks lower (§11.4.4).
                (false, false) => self.pre.cmp(&other.pre),
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Version {}

/// Where an installed dsh stands against what Core was checked with (§5.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// In LINE and not newer than VERIFIED.
    Verified,
    /// In LINE, newer than VERIFIED: started, and said to be newer.
    Newer,
    /// A later line (0.3, 1.x): started, as every start is, only once each
    /// check of the start passes, and said to be unverified.
    NewLine,
}

impl Standing {
    /// Its name as Core keeps it beside the version (S2a, `dsh_version`).
    pub fn label(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Newer => "newer",
            Self::NewLine => "newLine",
        }
    }

    /// What the Agent says of it, if anything.
    pub fn note(self) -> Option<String> {
        match self {
            Self::Verified => None,
            Self::Newer => Some(format!("newer than the verified {VERIFIED}")),
            Self::NewLine => Some(format!("a new dsh line, not verified (Yuzuno was checked with {LINE}, up to {VERIFIED})")),
        }
    }
}

/// Where the version `dsh --version` printed stands (§5.1): refused when it
/// cannot be read as one or is older than MIN.
pub fn standing(printed: &str) -> Result<(Version, Standing)> {
    let version = Version::parse(printed)
        .with_context(|| format!("dsh says \u{201c}{}\u{201d}, which is not a version Core can read; {UPDATE}", clipped(printed, 80)))?;
    let (min, verified, line) = (Version::parse(MIN).unwrap(), Version::parse(VERIFIED).unwrap(), line_of(LINE));
    ensure!(version >= min, "dsh {version} is older than {MIN}, the oldest Yuzuno speaks; {UPDATE}");
    let standing = match version.line().cmp(&line) {
        Ordering::Greater => Standing::NewLine,
        _ if version > verified => Standing::Newer,
        _ => Standing::Verified,
    };
    Ok((version, standing))
}

/// The line `LINE` names: `0.2` or `1`.
fn line_of(text: &str) -> (u64, Option<u64>) {
    let mut parts = text.split('.').map(|p| p.parse::<u64>().expect("LINE is numbers"));
    match (parts.next(), parts.next()) {
        (Some(0), Some(minor)) => (0, Some(minor)),
        (Some(major), None) if major > 0 => (major, None),
        _ => panic!("LINE is 0.y or a major"),
    }
}

// ---------------------------------------------------------------- the overlay

/// How far an Agent's dsh may go (§3.6): the sandbox preset its overlay
/// names, and whether dsh asks before a command goes past it. dsh's sandbox
/// limits file writes only: network and reads are open at every level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// `workspace-write` + `ask`: the Agent's folder and `Launch::writable`;
    /// dsh asks (`session/request_permission`) before going past them.
    Workspace,
    /// `danger-full-access` + `never`.
    Full,
}

impl Access {
    /// The sandbox preset (`sandbox-policy` `mode`, and DSH_PERMISSION_MODE).
    pub fn mode(self) -> &'static str {
        match self {
            Self::Workspace => "workspace-write",
            Self::Full => "danger-full-access",
        }
    }

    /// The approval policy (`approval` `policy`).
    pub fn policy(self) -> &'static str {
        match self {
            Self::Workspace => "ask",
            Self::Full => "never",
        }
    }
}

/// One row of Core's overlay: what it sets, all literal (§3.2), so that it
/// can be read back as written.
pub(crate) struct Row {
    pub(crate) id: &'static str,
    /// `disabled: true` on the row itself.
    pub(crate) disabled: bool,
    /// Its `config`, which replaces dsh's whole config of the row.
    pub(crate) config: Vec<(&'static str, Scalar)>,
}

pub(crate) enum Scalar {
    /// A boolean or a name: read back as written.
    Word(&'static str),
    /// Paths: YAML may fold them, so only their key is read back.
    Path(String),
    Paths(Vec<String>),
}

/// What one Agent's dsh is started with.
pub struct Launch {
    /// The `dsh` executable (`program`).
    pub program: PathBuf,
    /// This Agent's own folder for dsh (`folder`).
    pub folder: PathBuf,
    /// The Agent's folder: dsh's working directory and its sandbox's
    /// `workspaceRoot`. An existing absolute path.
    pub directory: PathBuf,
    pub access: Access,
    /// More folders the sandbox may write (`writable_roots`).
    pub writable: Vec<PathBuf>,
    /// `$DSH_HOME/AGENTS.md`, rewritten at every start: the session notice and
    /// the Brief's rules, as Codex gets them in developerInstructions (§3.1).
    pub instructions: String,
    /// The DeepSeek key, given to dsh as DEEPSEEK_API_KEY and nowhere else.
    pub key: Option<Secret>,
    /// DEEPSEEK_BASE_URL: a stand-in model for tests and lab probes. None uses
    /// dsh's own address for DeepSeek.
    pub endpoint: Option<String>,
}

impl Launch {
    /// The rows of Core's overlay (§3.2), `root` being the Agent's folder
    /// as dsh resolves it.
    pub(crate) fn rows(&self, root: &str) -> Result<Vec<Row>> {
        let writable = self.writable.iter()
            .map(|path| path.to_str().map(str::to_owned).context("A folder dsh may write is not valid UTF-8"))
            .collect::<Result<Vec<_>>>()?;
        use Scalar::*;
        Ok(vec![
            // No session log or plugin list sent along with each request to DeepSeek (§3.2, Q3).
            Row { id: OVERLAY_ROWS[0], disabled: false, config: vec![("enabled", Word("false"))] },
            Row { id: OVERLAY_ROWS[1], disabled: false, config: vec![("enabled", Word("false"))] },
            // No telemetry.
            Row { id: OVERLAY_ROWS[2], disabled: true, config: vec![] },
            Row { id: OVERLAY_ROWS[3], disabled: false, config: vec![("provider", Word("deepseek-official")), ("model", Word("deepseek-flash"))] },
            Row { id: OVERLAY_ROWS[4], disabled: false, config: vec![
                ("mode", Word(self.access.mode())),
                ("workspaceRoot", Path(root.to_owned())),
                ("additionalWritableRoots", Paths(writable)),
            ] },
            Row { id: OVERLAY_ROWS[5], disabled: false, config: vec![("policy", Word(self.access.policy()))] },
        ])
    }
}

/// The overlay's text: block YAML, paths as JSON strings (a YAML
/// double-quoted scalar), everything else a plain word.
pub(crate) fn overlay_text(rows: &[Row]) -> String {
    let quoted = |path: &str| serde_json::to_string(path).expect("a string serializes");
    let mut out = String::from("# Yuzuno Core's overlay for this Agent (YN-119 \u{a7}3.2): rewritten at each start, then read back.\n");
    for row in rows {
        out.push_str(&format!("- id: {}\n", row.id));
        if !row.config.is_empty() {
            out.push_str("  config:\n");
        }
        for (key, value) in &row.config {
            match value {
                Scalar::Word(word) => out.push_str(&format!("    {key}: {word}\n")),
                Scalar::Path(path) => out.push_str(&format!("    {key}: {}\n", quoted(path))),
                Scalar::Paths(paths) if paths.is_empty() => out.push_str(&format!("    {key}: []\n")),
                Scalar::Paths(paths) => {
                    out.push_str(&format!("    {key}:\n"));
                    for path in paths {
                        out.push_str(&format!("      - {}\n", quoted(path)));
                    }
                }
            }
        }
        if row.disabled {
            out.push_str("  disabled: true\n");
        }
    }
    out
}

/// The files of a start, in the Agent's folder as resolved (a Workspace
/// reached through a link included), so that the overlay's path dsh prints
/// is the one it was given.
pub(crate) struct Prepared {
    pub(crate) home: PathBuf,
    pub(crate) overlay: PathBuf,
    pub(crate) rows: Vec<Row>,
}

/// Writes the Agent's dsh folder for a start (§3.1): the folder and its
/// `home/` (0700), the overlay and `home/AGENTS.md` (0600), each replaced
/// whole.
pub(crate) fn prepare(launch: &Launch) -> Result<Prepared> {
    ensure!(launch.directory.is_absolute() && launch.directory.is_dir(), "The Agent's folder must be an existing absolute path");
    let root = std::fs::canonicalize(&launch.directory).context("The Agent's folder cannot be resolved")?;
    let root = root.to_str().context("The Agent's folder is not valid UTF-8")?.to_owned();
    std::fs::create_dir_all(launch.folder.join("home"))
        .with_context(|| format!("{} cannot be created; dsh was not started", launch.folder.display()))?;
    let folder = std::fs::canonicalize(&launch.folder).context("The Agent's dsh folder cannot be resolved")?;
    ensure!(folder.to_str().is_some(), "The Agent's dsh folder is not valid UTF-8");
    let home = folder.join("home");
    private(&folder, 0o700)?;
    private(&home, 0o700)?;
    let rows = launch.rows(&root)?;
    let overlay = folder.join("overlay.yml");
    replace(&overlay, overlay_text(&rows).as_bytes())?;
    replace(&home.join("AGENTS.md"), launch.instructions.as_bytes())?;
    Ok(Prepared { home, overlay, rows })
}

fn private(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .with_context(|| format!("{} cannot be made private", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

/// `path` replaced by `bytes` at once (a new file renamed over it), 0600.
fn replace(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let dir = path.parent().context("A file of the dsh folder has no folder")?;
    let mut file = tempfile::NamedTempFile::new_in(dir).with_context(|| format!("{} cannot be written", path.display()))?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    private(file.path(), 0o600)?;
    file.persist(path).with_context(|| format!("{} cannot be written", path.display()))?;
    Ok(())
}

// ---------------------------------------------------------------- processes

/// A dsh's process group, whose ID is its PID. It is signalled only while
/// that process is not yet reaped, so the ID cannot be anyone else's: an
/// exited process keeps its ID until it is reaped. It is sent SIGKILL when
/// dropped, and by `end` once its process has exited.
struct Group(Mutex<Option<u32>>);

impl Group {
    fn new(pid: Option<u32>) -> Self {
        Self(Mutex::new(pid))
    }

    #[cfg(unix)]
    fn signal(&self, signal: rustix::process::Signal) {
        let pid = self.0.lock().unwrap();
        if let Some(pid) = pid.and_then(|pid| rustix::process::Pid::from_raw(pid as i32)) {
            let _ = rustix::process::kill_process_group(pid, signal);
        }
    }

    /// Whether its process has exited, without reaping it.
    #[cfg(unix)]
    fn exited(&self) -> bool {
        use rustix::process::{waitid, Pid, WaitId, WaitIdOptions};
        let Some(pid) = self.0.lock().unwrap().and_then(|pid| Pid::from_raw(pid as i32)) else { return true };
        let options = WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG;
        !matches!(waitid(WaitId::Pid(pid), options), Ok(None))
    }

    /// Once its process has exited, still unreaped.
    #[cfg(unix)]
    async fn exit(&self) {
        while !self.exited() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// Ends what its process left in the group, once that process has
    /// exited and before it is reaped: SIGKILL, as dsh has had its own
    /// teardown by then (§3.1). Called with the process exited, or about to
    /// be after SIGKILL.
    fn end(&self) {
        #[cfg(unix)]
        self.signal(rustix::process::Signal::KILL);
    }

    /// Reaped: its ID may be reused from now on.
    fn reaped(&self) {
        *self.0.lock().unwrap() = None;
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        #[cfg(unix)]
        self.signal(rustix::process::Signal::KILL);
    }
}

/// dsh started for one start's step: the program in the Agent's folder, in a
/// group of its own, with its environment (§3.1). Core's own environment is
/// passed on without any DSH_* or DEEPSEEK_* of its own (its proxies stay:
/// dsh reaches DeepSeek through them), then DSH_HOME, DSH_PERMISSION_MODE as
/// the overlay's, DSH_TELEMETRY_DISABLED=1, and with `key` the Agent's key.
/// No key or token is ever in its arguments.
fn command(launch: &Launch, prepared: &Prepared, args: &[&OsStr], key: bool) -> Command {
    let mut command = Command::new(&launch.program);
    command.args(args).current_dir(&launch.directory);
    for (name, _) in std::env::vars_os() {
        let bytes = name.as_encoded_bytes();
        if bytes.starts_with(b"DSH_") || bytes.starts_with(b"DEEPSEEK_") {
            command.env_remove(&name);
        }
    }
    command
        .env("DSH_HOME", &prepared.home)
        .env("DSH_PERMISSION_MODE", launch.access.mode())
        .env("DSH_TELEMETRY_DISABLED", "1");
    if let (true, Some(secret)) = (key, &launch.key) {
        command.env("DEEPSEEK_API_KEY", secret.expose());
    }
    if let Some(endpoint) = &launch.endpoint {
        command.env("DEEPSEEK_BASE_URL", endpoint);
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command
}

pub(crate) struct Output {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

/// Runs a step's `command` within `limit`, reading at most `most` bytes of
/// its stdout (more is refused) and STDERR_KEPT of its stderr (the rest is
/// drained). Its group is ended once it exits, and past `limit` or on an
/// error.
pub(crate) async fn run(mut command: Command, limit: Duration, most: usize, what: &str) -> Result<Output> {
    let mut child = command.spawn().with_context(|| format!("dsh could not be started for {what}; {UPDATE}"))?;
    let group = Group::new(child.id());
    let (stdout, stderr) = (child.stdout.take().context("dsh's output is unavailable")?, child.stderr.take().context("dsh's error output is unavailable")?);
    let ran = timeout(limit, async {
        let ((stdout, cut), (stderr, _)) = tokio::try_join!(bounded(stdout, most), bounded(stderr, STDERR_KEPT))?;
        ensure!(!cut, "dsh printed more than {most} bytes for {what}");
        #[cfg(unix)]
        group.exit().await;
        group.end();
        let status = child.wait().await?;
        group.reaped();
        Ok(Output { status, stdout, stderr })
    })
    .await;
    ran.unwrap_or_else(|_| Err(anyhow!("dsh did not finish {what} within {limit:?}")))
}

/// All of `reader`, keeping at most `most` bytes, and whether it had more.
async fn bounded(mut reader: impl AsyncRead + Unpin, most: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let (mut kept, mut cut, mut chunk) = (Vec::new(), false, vec![0u8; 16 << 10]);
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok((kept, cut));
        }
        let room = most.saturating_sub(kept.len());
        cut |= read > room;
        kept.extend_from_slice(&chunk[..read.min(room)]);
    }
}

/// What dsh said, for a refusal: plain, on one line, at most REASON_CHARS.
fn said(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<String> = text.lines().map(plain).filter(|line| !line.is_empty()).collect();
    clipped(&lines.join(" / "), REASON_CHARS)
}

/// A line without terminal escape sequences or other control characters.
fn plain(line: &str) -> String {
    let (mut out, mut chars) = (String::new(), line.chars().peekable());
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
        } else if c == '\t' {
            out.push(' ');
        } else if !c.is_control() {
            out.push(c);
        }
    }
    out.trim().to_owned()
}

fn clipped(text: &str, chars: usize) -> String {
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

fn status_said(output: &Output) -> String {
    let said = said(&output.stderr);
    if said.is_empty() { format!("{}", output.status) } else { format!("{}: {said}", output.status) }
}

// ---------------------------------------------------------------- the check

/// What a start's checks found (§3.3 steps 1–3).
pub struct Checked {
    pub version: Version,
    pub standing: Standing,
    pub(crate) prepared: Prepared,
}

/// Steps 1–3 of a start (§3.3), after writing the Agent's dsh folder: the
/// version, the configuration read back, and its keys against dsh's schema.
/// A failure names its step.
pub async fn check(launch: &Launch) -> Result<Checked> {
    let prepared = prepare(launch)?;
    let (version, standing) = read_version(launch, &prepared).await.context("dsh start check 1 of 5 (its version)")?;
    let dump = read_dump(launch, &prepared).await.context("dsh start check 2 of 5 (its configuration, read back)")?;
    let overlay = prepared.overlay.to_str().expect("checked UTF-8 in prepare");
    let names = check_dump(&dump, overlay, &prepared.rows).context("dsh start check 2 of 5 (its configuration, read back)")?;
    let schema = schema(launch, &prepared, &version).await.context("dsh start check 3 of 5 (its configuration schema)")?;
    check_schema(&schema, &prepared.rows, &names).context("dsh start check 3 of 5 (its configuration schema)")?;
    Ok(Checked { version, standing, prepared })
}

async fn read_version(launch: &Launch, prepared: &Prepared) -> Result<(Version, Standing)> {
    let output = run(command(launch, prepared, &["--version".as_ref()], false), VERSION_LIMIT, VERSION_MOST, "--version").await?;
    ensure!(output.status.success(), "`dsh --version` failed ({}); {UPDATE}", status_said(&output));
    let text = String::from_utf8_lossy(&output.stdout);
    standing(text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default())
}

async fn read_dump(launch: &Launch, prepared: &Prepared) -> Result<String> {
    let args: [&OsStr; 5] = ["--profile".as_ref(), "acp".as_ref(), "--patch".as_ref(), prepared.overlay.as_os_str(), "--dump-config".as_ref()];
    let output = run(command(launch, prepared, &args, true), DUMP_LIMIT, DUMP_MOST, "--dump-config").await?;
    ensure!(output.status.success(), "`dsh --dump-config` failed ({})", status_said(&output));
    // dsh warns of a patch it could not apply on stderr only, and exits 0.
    ensure!(output.stderr.is_empty(), "`dsh --dump-config` wrote on stderr: {}", said(&output.stderr));
    String::from_utf8(output.stdout).context("`dsh --dump-config` printed text that is not UTF-8")
}

/// One entry of `--dump-config`: the heading of its group (`# == <layer>,
/// patched by <patch>, …`) and its lines after `- id:`.
struct Entry<'a> {
    id: String,
    heading: &'a str,
    lines: Vec<&'a str>,
}

fn entries(dump: &str) -> Vec<Entry<'_>> {
    let (mut found, mut heading) = (Vec::<Entry>::new(), "");
    let mut open = false;
    for line in dump.lines() {
        if line.starts_with("# ==") {
            heading = line;
            open = false;
        } else if let Some(id) = line.strip_prefix("- id: ") {
            found.push(Entry { id: unquoted(id), heading, lines: Vec::new() });
            open = true;
        } else if open && line.starts_with("  ") {
            found.last_mut().unwrap().lines.push(line);
        } else if !line.trim().is_empty() {
            open = false;
        }
    }
    found
}

/// A YAML scalar as js-yaml prints a plain, single- or double-quoted one.
fn unquoted(text: &str) -> String {
    let text = text.trim();
    if let Some(inner) = text.strip_prefix('\'').and_then(|t| t.strip_suffix('\'')) {
        inner.replace("''", "'")
    } else if text.starts_with('"') {
        serde_json::from_str(text).unwrap_or_else(|_| text.to_owned())
    } else {
        text.to_owned()
    }
}

/// Whether a group heading names `overlay` as its last patch, as dsh prints
/// it: `# == <layer>, patched by <first>, …, <last>`.
fn patched_last_by(heading: &str, overlay: &str) -> bool {
    match heading.split_once(", patched by ") {
        Some((_, patches)) => patches == overlay || patches.ends_with(&format!(", {overlay}")),
        None => false,
    }
}

/// Step 2 (§3.3) over `dump`, what `--dump-config` printed with `overlay`:
/// every row of `rows` is there once, its group last patched by `overlay`,
/// and each word Core wrote reads back as written (each path, its key). The
/// package of each row, as dsh names it, for step 3.
pub(crate) fn check_dump(dump: &str, overlay: &str, rows: &[Row]) -> Result<HashMap<&'static str, String>> {
    let entries = entries(dump);
    let mut names = HashMap::new();
    for row in rows {
        let id = row.id;
        let found: Vec<&Entry> = entries.iter().filter(|entry| entry.id == id).collect();
        let entry = match found[..] {
            [entry] => entry,
            [] => bail!("dsh has no row \u{201c}{id}\u{201d}: this dsh no longer has a setting Yuzuno relies on"),
            _ => bail!("dsh lists the row \u{201c}{id}\u{201d} {} times", found.len()),
        };
        ensure!(patched_last_by(entry.heading, overlay),
            "the row \u{201c}{id}\u{201d} is not set last by Yuzuno's overlay ({overlay}): dsh says \u{201c}{}\u{201d}", clipped(entry.heading, 300));
        let name = entry.lines.iter().find_map(|line| line.strip_prefix("  name: ")).map(unquoted)
            .with_context(|| format!("dsh names no package for the row \u{201c}{id}\u{201d}"))?;
        if row.disabled {
            ensure!(entry.lines.contains(&"  disabled: true"), "the row \u{201c}{id}\u{201d} does not read back as disabled: true");
        }
        // The keys of its config: the lines four spaces in, below `  config:`.
        let config: Vec<&str> = entry.lines.iter().skip_while(|line| **line != "  config:").skip(1)
            .take_while(|line| line.starts_with("   ")).filter_map(|line| line.strip_prefix("    "))
            .filter(|line| !line.starts_with(' ')).collect();
        for (key, value) in &row.config {
            match value {
                Scalar::Word(word) => ensure!(config.contains(&format!("{key}: {word}").as_str()),
                    "the row \u{201c}{id}\u{201d} does not read back {key}: {word}"),
                Scalar::Path(_) | Scalar::Paths(_) => ensure!(config.iter().any(|line| line.strip_prefix(key).is_some_and(|rest| rest.starts_with(':'))),
                    "the row \u{201c}{id}\u{201d} does not read back its {key}"),
            }
        }
        names.insert(id, name);
    }
    Ok(names)
}

/// What dsh's `--dump-config-schema` says of the rows Core writes.
pub(crate) struct Schema {
    /// The keys an entry takes on its own level (`$defs.entryMetadata`).
    entry: HashSet<String>,
    /// Each package's config, as a branch of `$defs.entry.allOf` gives it:
    /// its keys, each with the constants it lists (none: any value of its
    /// type), or None for a package dsh has no schema for (`unknownConfig`).
    packages: HashMap<String, Option<HashMap<String, Vec<String>>>>,
}

/// The schemas read, by program and version (§3.3): about 630 KiB each.
static SCHEMAS: Mutex<Option<HashMap<(PathBuf, String), Arc<Schema>>>> = Mutex::new(None);

async fn schema(launch: &Launch, prepared: &Prepared, version: &Version) -> Result<Arc<Schema>> {
    let key = (launch.program.clone(), version.to_string());
    if let Some(schema) = SCHEMAS.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        return Ok(schema.clone());
    }
    let args: [&OsStr; 3] = ["--profile".as_ref(), "acp".as_ref(), "--dump-config-schema".as_ref()];
    let output = run(command(launch, prepared, &args, false), DUMP_LIMIT, SCHEMA_MOST, "--dump-config-schema").await?;
    ensure!(output.status.success(), "`dsh --dump-config-schema` failed ({})", status_said(&output));
    let schema = Arc::new(tokio::task::spawn_blocking(move || read_schema(&output.stdout)).await??);
    SCHEMAS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, schema.clone());
    Ok(schema)
}

/// `--dump-config-schema` read (§3.3 step 3): for each package, the branch
/// of `$defs.entry.allOf` whose `if.properties.name.const` names it, and
/// through its `then.properties.config.anyOf[].$ref` the config it takes.
pub(crate) fn read_schema(bytes: &[u8]) -> Result<Schema> {
    let value: Value = serde_json::from_slice(bytes).context("dsh's schema is not JSON")?;
    let defs = value.get("$defs").and_then(Value::as_object).context("dsh's schema has no $defs")?;
    let entry = defs.get("entryMetadata").and_then(|m| m.get("properties")).and_then(Value::as_object)
        .context("dsh's schema has no $defs.entryMetadata.properties")?.keys().cloned().collect();
    let branches = defs.get("entry").and_then(|e| e.get("allOf")).and_then(Value::as_array)
        .context("dsh's schema has no $defs.entry.allOf")?;
    let mut packages: HashMap<String, Option<HashMap<String, Vec<String>>>> = HashMap::new();
    for branch in branches {
        let Some(name) = branch.pointer("/if/properties/name/const").and_then(Value::as_str) else { continue };
        let mut keys: Option<HashMap<String, Vec<String>>> = Some(HashMap::new());
        for choice in branch.pointer("/then/properties/config/anyOf").and_then(Value::as_array).into_iter().flatten() {
            let def = match choice.get("$ref").and_then(Value::as_str) {
                Some("#/$defs/unknownConfig") => {
                    keys = None;
                    break;
                }
                Some(reference) => reference.strip_prefix("#/$defs/").and_then(|name| defs.get(name))
                    .with_context(|| format!("dsh's schema refers to {reference}, which it does not define"))?,
                None => choice,
            };
            let found = keys.as_mut().unwrap();
            for shape in def.get("anyOf").and_then(Value::as_array).into_iter().flatten().chain([def]) {
                for (key, property) in shape.get("properties").and_then(Value::as_object).into_iter().flatten() {
                    constants(property, found.entry(key.clone()).or_default());
                }
            }
        }
        // A package without a config schema is one dsh cannot check either.
        let keys = keys.filter(|keys| !keys.is_empty());
        match (packages.get_mut(name), keys) {
            (Some(Some(known)), Some(more)) => {
                for (key, values) in more {
                    known.entry(key).or_default().extend(values);
                }
            }
            (Some(known), None) => *known = None,
            (Some(None), Some(_)) => {}
            (None, keys) => {
                packages.insert(name.to_owned(), keys);
            }
        }
    }
    Ok(Schema { entry, packages })
}

/// Every string `const` and `enum` value in a property's schema.
fn constants(schema: &Value, out: &mut Vec<String>) {
    match schema {
        Value::Object(fields) => {
            for (key, value) in fields {
                match (key.as_str(), value) {
                    ("const", Value::String(text)) => out.push(text.clone()),
                    ("enum", Value::Array(values)) => out.extend(values.iter().filter_map(Value::as_str).map(str::to_owned)),
                    _ => constants(value, out),
                }
            }
        }
        Value::Array(values) => values.iter().for_each(|value| constants(value, out)),
        _ => {}
    }
}

/// Step 3 (§3.3): each key Core writes is one dsh's schema lists for the
/// row's package, and each word is one of the constants it lists, if it
/// lists any. A package without a config schema (`unknownConfig`) is left to
/// step 2.
pub(crate) fn check_schema(schema: &Schema, rows: &[Row], names: &HashMap<&'static str, String>) -> Result<()> {
    for row in rows {
        let id = row.id;
        if row.disabled {
            ensure!(schema.entry.contains("disabled"), "dsh's schema no longer takes disabled on a row (row \u{201c}{id}\u{201d})");
        }
        if row.config.is_empty() {
            continue;
        }
        let name = names.get(id).with_context(|| format!("no package was read back for the row \u{201c}{id}\u{201d}"))?;
        let Some(package) = schema.packages.get(name) else {
            bail!("dsh's schema has no entry for {name} (row \u{201c}{id}\u{201d})");
        };
        let Some(keys) = package else { continue };
        for (key, value) in &row.config {
            let values = keys.get(*key)
                .with_context(|| format!("dsh's schema for {name} (row \u{201c}{id}\u{201d}) has no key {key}"))?;
            if let Scalar::Word(word) = value {
                ensure!(values.is_empty() || values.iter().any(|value| value == word),
                    "dsh's schema for {name} (row \u{201c}{id}\u{201d}) does not take {key}: {word} (it takes {})", values.join(", "));
            }
        }
    }
    Ok(())
}

/// Step 4 (§3.3): ACP v1, with HTTP MCP servers and sessions that can be
/// resumed and closed.
pub fn check_initialize(answer: &Value) -> Result<()> {
    ensure!(answer["protocolVersion"].as_u64() == Some(1), "dsh speaks ACP {}, not 1", answer["protocolVersion"]);
    let capabilities = &answer["agentCapabilities"];
    ensure!(capabilities["mcpCapabilities"]["http"] == true, "dsh does not take HTTP MCP servers (mcpCapabilities.http)");
    for needed in ["resume", "close"] {
        ensure!(capabilities["sessionCapabilities"].get(needed).is_some_and(|v| !v.is_null()),
            "dsh cannot {needed} a session (sessionCapabilities.{needed})");
    }
    Ok(())
}

/// Step 5 (§3.3), the caller's: `session/new` or `session/resume` answered
/// with a model and a reasoning effort among its options.
pub fn check_session(answer: &Value) -> Result<()> {
    let options = answer["configOptions"].as_array().context("dsh's session has no configOptions")?;
    for needed in ["model", "reasoning_effort"] {
        ensure!(options.iter().any(|option| option["id"] == needed), "dsh's session has no {needed} option");
    }
    Ok(())
}

// ---------------------------------------------------------------- the transport

type Reply = oneshot::Sender<Result<Value>>;
type Waiting = Arc<Mutex<Pending>>;

/// The requests still waiting for dsh's answer, and once its output has
/// ended, why: from then on no request is sent, so none can wait forever.
#[derive(Default)]
struct Pending {
    replies: HashMap<u64, Reply>,
    ended: Option<String>,
}

/// How `shutdown` ended dsh.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    /// It exited after its stdin closed.
    Input,
    /// After SIGTERM to its group.
    Term,
    /// After SIGKILL to its group.
    Kill,
}

/// One Agent's running `dsh --profile acp`. Its requests to Core
/// (`session/request_permission`) and its notifications (`session/update`)
/// go to its events as dsh sent them; Core answers a request with `respond`
/// or `respond_error`. When it ends, every request still waiting fails as
/// OutcomeUnknown and the events get `yuzuno/disconnected` with why.
pub struct Dsh {
    // Before `child`: dropped first, while dsh is not yet reaped.
    group: Group,
    child: tokio::sync::Mutex<Child>,
    tx: mpsc::Sender<Value>,
    waiting: Waiting,
    next: AtomicU64,
    close_input: watch::Sender<bool>,
    stopped: watch::Receiver<bool>,
    stderr: Arc<Mutex<Vec<u8>>>,
    version: Version,
    standing: Standing,
    initialized: Value,
}

/// A request sent, its answer still to come (`session/prompt`, which ends
/// with its Turn).
pub struct Call {
    id: u64,
    rx: oneshot::Receiver<Result<Value>>,
}

impl Call {
    /// The request's ID.
    pub fn id(&self) -> u64 {
        self.id
    }

    /// Its answer, however long it takes; OutcomeUnknown when dsh ends first.
    pub async fn answer(self) -> Result<Value> {
        self.rx.await.unwrap_or_else(|_| Err(OutcomeUnknown("dsh's connection ended before it answered; the outcome is not known".into()).into()))
    }
}

impl Dsh {
    /// Checks dsh (`check`, steps 1–3), starts `dsh --profile acp --patch
    /// <overlay>` and asks `initialize` (step 4). On any failure what it
    /// started is ended and the step is named.
    pub async fn start(launch: &Launch, events: impl Into<EventSender>) -> Result<Self> {
        let checked = check(launch).await?;
        let args: [&OsStr; 4] = ["--profile".as_ref(), "acp".as_ref(), "--patch".as_ref(), checked.prepared.overlay.as_os_str()];
        let mut command = command(launch, &checked.prepared, &args, true);
        command.stdin(Stdio::piped());
        let mut child = command.spawn().with_context(|| format!("dsh could not be started; {UPDATE}"))?;
        let group = Group::new(child.id());
        let stdin = child.stdin.take().context("dsh's input is unavailable")?;
        let stdout = child.stdout.take().context("dsh's output is unavailable")?;
        let stderr = child.stderr.take().context("dsh's error output is unavailable")?;
        let (tx, rx) = mpsc::channel::<Value>(256);
        let (close_input, closing) = watch::channel(false);
        let (stopped_tx, stopped) = watch::channel(false);
        let waiting: Waiting = Arc::default();
        let kept = Arc::new(Mutex::new(Vec::new()));
        tokio::spawn(write(stdin, rx, closing));
        tokio::spawn(read(stdout, waiting.clone(), events.into(), stopped_tx));
        tokio::spawn(keep_tail(stderr, kept.clone()));
        let mut dsh = Self {
            group,
            child: tokio::sync::Mutex::new(child),
            tx,
            waiting,
            next: AtomicU64::new(1),
            close_input,
            stopped,
            stderr: kept,
            version: checked.version,
            standing: checked.standing,
            initialized: Value::Null,
        };
        // From here on, an error drops `dsh`, which ends its group.
        let params = json!({
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
            "clientInfo": {"name": "yuzuno", "title": "Yuzuno", "version": env!("CARGO_PKG_VERSION")},
        });
        let answer = dsh.request("initialize", params, START_LIMIT).await;
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) => {
                let said = dsh.said().await;
                bail!("dsh start check 4 of 5 (initialize): {error:#}{said}");
            }
        };
        check_initialize(&answer).context("dsh start check 4 of 5 (initialize)")?;
        dsh.initialized = answer;
        Ok(dsh)
    }

    /// The version `dsh --version` printed at this start.
    pub fn version(&self) -> &Version {
        &self.version
    }

    pub fn standing(&self) -> Standing {
        self.standing
    }

    /// dsh's answer to `initialize`.
    pub fn initialized(&self) -> &Value {
        &self.initialized
    }

    /// dsh's process ID while it is not yet reaped.
    pub fn pid(&self) -> Option<u32> {
        *self.group.0.lock().unwrap()
    }

    /// Whether its output is still open.
    pub fn is_running(&self) -> bool {
        !*self.stopped.borrow()
    }

    /// The last STDERR_KEPT bytes dsh wrote on stderr.
    pub fn stderr_tail(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap()).into_owned()
    }

    /// The tail of stderr, after a moment for its last lines, as a refusal
    /// quotes it.
    async fn said(&self) -> String {
        let _ = timeout(Duration::from_secs(1), self.stopped.clone().wait_for(|stopped| *stopped)).await;
        let said = said(&self.stderr.lock().unwrap());
        if said.is_empty() { String::new() } else { format!(": dsh said: {said}") }
    }

    async fn send(&self, message: Value) -> Result<()> {
        if let Some(reason) = &self.waiting.lock().unwrap().ended {
            bail!("{reason}; nothing more is sent to it");
        }
        self.tx.send(message).await.map_err(|_| anyhow!("dsh's input is closed"))
    }

    /// Sends a request; its answer is the `Call`'s. Refused, unsent, once
    /// dsh's output has ended.
    pub async fn call(&self, method: &str, params: Value) -> Result<Call> {
        let id = self.next.fetch_add(1, Atomic::Relaxed);
        let (reply, rx) = oneshot::channel();
        {
            let mut waiting = self.waiting.lock().unwrap();
            if let Some(reason) = &waiting.ended {
                bail!("{reason}; nothing more is sent to it");
            }
            waiting.replies.insert(id, reply);
        }
        if let Err(error) = self.tx.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await {
            self.waiting.lock().unwrap().replies.remove(&id);
            return Err(anyhow!("dsh's input is closed ({error})"));
        }
        Ok(Call { id, rx })
    }

    /// A request and its answer within `limit`: dsh's error as RpcError, and
    /// OutcomeUnknown when it does not answer in time or ends first (it may
    /// have done what was asked).
    pub async fn request(&self, method: &str, params: Value, limit: Duration) -> Result<Value> {
        let call = self.call(method, params).await?;
        let id = call.id;
        match timeout(limit, call.answer()).await {
            Ok(answer) => answer,
            Err(_) => {
                self.waiting.lock().unwrap().replies.remove(&id);
                Err(OutcomeUnknown(format!("dsh did not answer {method} within {limit:?}; the outcome is not known")).into())
            }
        }
    }

    /// A notification (`session/cancel`).
    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params})).await
    }

    /// The answer to one of dsh's requests, under the ID it gave.
    pub async fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result})).await
    }

    pub async fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<()> {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})).await
    }

    /// Ends dsh (§3.1): closes its stdin and waits CLOSE_GRACE, then SIGTERM
    /// to its group and CLOSE_GRACE again, then SIGKILL. However it exited,
    /// what it left in its group is then sent SIGKILL, before dsh is reaped.
    pub async fn shutdown(&self) -> Result<(Ending, ExitStatus)> {
        self.shutdown_within(CLOSE_GRACE).await
    }

    pub(crate) async fn shutdown_within(&self, grace: Duration) -> Result<(Ending, ExitStatus)> {
        let _ = self.close_input.send(true);
        let mut ending = Ending::Input;
        #[cfg(unix)]
        if !self.exits_within(grace).await {
            ending = Ending::Term;
            self.group.signal(rustix::process::Signal::TERM);
            if !self.exits_within(grace).await {
                ending = Ending::Kill;
                self.group.signal(rustix::process::Signal::KILL);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = grace;
            ending = Ending::Kill;
            let _ = self.child.lock().await.start_kill();
        }
        // dsh has exited (or is sent SIGKILL) and is not yet reaped, so the
        // group is still its own: what it left there, a tool's command or an
        // MCP server, ends now (review 4f8d976e).
        self.group.end();
        let status = self.child.lock().await.wait().await.context("dsh did not end")?;
        // Reaped: the group's ID may now be reused, so it is not signalled again.
        self.group.reaped();
        Ok((ending, status))
    }

    #[cfg(unix)]
    async fn exits_within(&self, limit: Duration) -> bool {
        timeout(limit, self.group.exit()).await.is_ok()
    }
}

/// Writes each message as one line until the input is closed (`shutdown`),
/// the `Dsh` is dropped, or dsh stops reading; then closes dsh's stdin.
async fn write(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::Receiver<Value>, mut closing: watch::Receiver<bool>) {
    loop {
        let message = tokio::select! {
            biased;
            _ = closing.wait_for(|close| *close) => break,
            message = rx.recv() => match message {
                Some(message) => message,
                None => break,
            },
        };
        let mut line = serde_json::to_vec(&message).expect("a Value serializes");
        line.push(b'\n');
        if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

/// Reads dsh's messages until its output ends or is not ACP: answers go to
/// the requests waiting for them, everything else to `events`.
async fn read(stdout: tokio::process::ChildStdout, waiting: Waiting, events: EventSender, stopped: watch::Sender<bool>) {
    let mut reader = BufReader::new(stdout);
    let reason = loop {
        match crate::rpc::read_message(&mut reader).await {
            Ok(Some((message, bytes))) => {
                if let Err(error) = route(message, bytes, &waiting, &events).await {
                    break format!("{error:#}");
                }
            }
            Ok(None) => break "dsh has ended".to_owned(),
            Err(error) => break format!("dsh wrote something that is not an ACP message ({error:#})"),
        }
    };
    // Marked ended under the same lock `call` takes, so that no request is
    // added after these are failed.
    let drained: Vec<Reply> = {
        let mut waiting = waiting.lock().unwrap();
        waiting.ended = Some(reason.clone());
        waiting.replies.drain().map(|(_, reply)| reply).collect()
    };
    for reply in drained {
        let _ = reply.send(Err(OutcomeUnknown(format!("{reason}; the outcome is not known")).into()));
    }
    let _ = events.send(json!({"method": "yuzuno/disconnected", "params": {"message": reason}})).await;
    let _ = stopped.send(true);
}

async fn route(mut message: Value, bytes: usize, waiting: &Waiting, events: &EventSender) -> Result<()> {
    if message.get("method").is_some_and(Value::is_string) {
        return events.send_sized(message, bytes).await.map_err(|_| anyhow!("nothing reads dsh's messages any more"));
    }
    let Some(id) = message.get("id").and_then(Value::as_u64) else { return Ok(()) };
    let Some(reply) = waiting.lock().unwrap().replies.remove(&id) else { return Ok(()) };
    let answer = match message.get_mut("error").map(Value::take) {
        Some(error) => match (error["code"].as_i64(), error["message"].as_str()) {
            (Some(code), Some(text)) => Err(RpcError { code, message: text.to_owned(), data: error.get("data").filter(|d| !d.is_null()).cloned() }.into()),
            _ => Err(anyhow!("dsh answered with an error Core cannot read: {}", clipped(&error.to_string(), 300))),
        },
        None => Ok(message.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
    };
    let _ = reply.send(answer);
    Ok(())
}

/// Keeps the last STDERR_KEPT bytes of dsh's stderr, draining all of it.
async fn keep_tail(mut stderr: tokio::process::ChildStderr, kept: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 4096];
    while let Ok(read) = stderr.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        let mut kept = kept.lock().unwrap();
        kept.extend_from_slice(&chunk[..read]);
        let over = kept.len().saturating_sub(STDERR_KEPT);
        kept.drain(..over);
    }
}

#[cfg(test)]
#[path = "dsh_tests.rs"]
mod tests;
