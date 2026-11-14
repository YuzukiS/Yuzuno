//! OpenCode (T-110) through its own server, `opencode serve`: one process per
//! Agent on this host's loopback, behind a password only Core holds. This is
//! the transport; `opencode_agent` connects it to an Agent's record. It adds
//! no permission rule of its own.
//!
//! OpenCode 2.x (T-32): it is started, checked and stopped as 2.x is, and
//! any 2.x from `MIN` its `/api/info` reports is spoken to (`MAJOR`; Yuzuno's
//! support stops at `VERIFIED`, YN-119); an older 2.x or another major is
//! stopped. The calls
//! past start and stop are still those of 1.19.3 until their slices of T-32
//! move them to 2.x. Native requests, events and
//! results come back as OpenCode sent them. What OpenCode did not say is not
//! decided here: an accepted prompt (204) is not yet a stored message, a
//! message not found is not proof it was not delivered, and no message is
//! ever sent twice.
//!
//! The event stream has no replay (its events carry no SSE `id`). After a
//! break, subscribe again and then read a `snapshot`: OpenCode registers a
//! subscriber before it sends `server.connected`, so what happened after that
//! is either in the snapshot or still to come as an event, possibly both.
//!
//! OpenCode runs in a process group of its own, so the children that stay in
//! it (language servers, local MCP servers) end with it: on `shutdown`, when
//! the `Server` is dropped, or (on Unix) when Core ends without either. What
//! its tools run (a shell command, the bash tool) is in a session of its own
//! (`cross-spawn-spawner.ts`, detached), out of the group's reach: OpenCode
//! ends it as it tears down after SIGTERM, so `shutdown` signals and then
//! gives it TEARDOWN before SIGKILL. Dropping a `Server`, a Core or an
//! OpenCode that is killed, or one that does not end in time skips that, and
//! such a process runs on until it ends by itself.
use anyhow::{anyhow, bail, ensure, Context, Result};
use reqwest::{Method, Response, Url};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fmt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
    time::{timeout, Instant},
};

/// The OpenCode major this module speaks (T-32: the latest 2.x, not one
/// release): any version `/api/info` reports in it from `MIN` is taken.
pub const MAJOR: &str = "2";
/// The release Yuzuno's OpenCode support stops at (YN-119): the last one the
/// stand-in and tests are checked against, and the last whose problems are
/// fixed here. No newer release is probed or followed. A later 2.x still
/// starts, said to be unverified (`newer_note`), and is not refused.
pub const VERIFIED: &str = "2.2.5";
/// The npm package OpenCode 2.x is published as (T-32: 1.x was `opencode-ai`),
/// which `newer_note` names to install VERIFIED from.
const PACKAGE: &str = "@opencode/cli";
/// The oldest 2.x Core reads (T-32, R2 59b5e3c6): its `/api/info` (2.0.6),
/// the `idle` message among a session's messages (2.0.4) and a step's own
/// start (`started`, 2.0.7) are there, as are every other route and event
/// Core reads (2.0.0). An older one, a pre-release of it included, and a 2.x
/// whose version cannot be read, are refused, never read in part (`release`).
pub const MIN: &str = "2.0.7";

/// The oldest 2.x an Agent can be logged in through (T-32 slice 4b, D4): its
/// integration and credential routes are all there from 2.0.20.
pub const LOGIN_MIN: &str = "2.0.20";
/// 2.x's Basic user, which it does not let be changed (server/src/process.ts).
const USERNAME: &str = "opencode";
const START_LIMIT: Duration = Duration::from_secs(30);
pub(crate) const REQUEST_LIMIT: Duration = Duration::from_secs(15);
/// How long OpenCode may take to connect an MCP server Core adds and to list
/// its tools, each (`timeout.startup`, `timeout.catalog`; 2.x's own are 30 s).
pub const MCP_STARTUP: Duration = Duration::from_secs(10);
/// An MCP add answers once OpenCode has tried to connect the server.
const MCP_LIMIT: Duration = Duration::from_secs(25);
/// The query that names the folder a 2.x request is for (protocol/src/groups/location.ts).
const LOCATION: &str = "location[directory]";
/// How long `shutdown` waits after SIGTERM before SIGKILL: longer than the
/// 10 s 2.x gives its own teardown, which ends what its tools run, before it
/// exits (cli/src/shutdown-deadline.ts). The watcher (`WATCHED`) waits as long.
pub const TEARDOWN: Duration = Duration::from_secs(12);
/// How often a start asks again while 2.x says it is still starting (503).
const READY_POLL: Duration = Duration::from_millis(100);
/// 2.x writes an SSE comment (`: heartbeat`) every 15 s on an open stream
/// (server/src/handlers/event.ts), so a silence this long is a broken one.
pub const EVENT_IDLE_LIMIT: Duration = Duration::from_secs(30);
/// Items asked for per page of a 2.x list read: its most (`limit` 1..=200,
/// protocol/src/groups/message.ts).
const PAGE: usize = 200;
const BODY_LIMIT: usize = 2048;
/// The most of a permission answer Core reads (YN-78 S1): one request or a
/// session's pending list, each small, read whole or refused, never a dump.
const PERMISSION_BODY_LIMIT: usize = 256 << 10;
const LINE_LIMIT: u64 = 64 << 10;
/// The most of one event Core reads, and (YN-78 S4a) of one stored message
/// it reads to bind a permission request to its tool call.
pub(crate) const EVENT_BUFFER_LIMIT: usize = 16 << 20;
/// What a start that failed tells of why (T-32): the first STDERR_KEPT bytes
/// OpenCode wrote on stderr (the rest is drained), waited for at most
/// STDERR_WAIT once it has gone; of them, at most STDERR_LINES lines and
/// REASON_CHARS characters. And `--version`, given at most VERSION_LIMIT.
const STDERR_KEPT: usize = 4 << 10;
const STDERR_WAIT: Duration = Duration::from_secs(1);
const STDERR_LINES: usize = 3;
const REASON_CHARS: usize = 300;
const VERSION_LIMIT: Duration = Duration::from_secs(5);
/// `sh -c WATCHED opencode PROGRAM ARGS…`: the watcher reads the pipe on fd 3
/// until it closes, then ends its own process group, OpenCode's, as
/// `shutdown` does: SIGTERM, TEARDOWN (12 s: 2.x gives its own teardown 10 s
/// after SIGTERM, cli/src/shutdown-deadline.ts DEADLINE), then SIGKILL. Unix
/// only; elsewhere `shutdown` ends OpenCode at once. It ignores SIGTERM itself,
/// so it is still in the group (whose ID then cannot be anyone else's) when
/// its SIGKILL ends what ignored SIGTERM, and itself with it.
#[cfg(unix)]
const WATCHED: &str = r#"exec 3<&0; (trap '' TERM; read _ <&3; kill -TERM 0; sleep 12; kill -KILL 0) >/dev/null 2>&1 </dev/null & exec "$@" 3<&- </dev/null"#;

/// What one Agent's server is started with.
pub struct Launch {
    /// The `opencode` executable.
    pub program: PathBuf,
    /// The Agent's folder: the server's working directory, and the instance
    /// every request names.
    pub directory: PathBuf,
    /// This Agent's own session database (`OPENCODE_DB`), an absolute path.
    pub database: PathBuf,
    /// OpenCode's data and state folders, this Agent's own
    /// (`XDG_DATA_HOME`, `XDG_STATE_HOME`), and its cache, the one Core's
    /// Agents share (`XDG_CACHE_HOME`), never the user's (T-32, Lead 4870).
    /// Its config stays the user's.
    pub data: PathBuf,
    pub state: PathBuf,
    pub cache: PathBuf,
    /// A routing key for this server alone (routing_launch.rs, YN-34 S1c):
    /// set on its process only, never in `environment`, which other processes
    /// started for the Agent read.
    pub extra: Vec<(String, crate::routing_keys::Secret)>,
    /// OPENCODE_CONFIG_CONTENT for this server alone: an executor's permission
    /// level as OpenCode's rules (permission_levels.rs, YN-56 S3). None leaves
    /// Core's own environment as it is.
    pub config: Option<String>,
    /// The executor's own temporary directory (YN-78 S2a), given to this
    /// server as TMPDIR, TMP and TEMP. None leaves Core's own as they are.
    pub temp_dir: Option<PathBuf>,
}

impl Launch {
    /// An Agent's: its database and its own folders in `folder`, and
    /// `cache`, the cache Core's Agents share.
    pub fn new(program: PathBuf, directory: PathBuf, folder: &Path, cache: PathBuf) -> Self {
        let own = folder.join("xdg");
        Self { program, directory, database: folder.join("opencode.db"), data: own.join("data"), state: own.join("state"), cache, extra: Vec::new(),
            config: None, temp_dir: None }
    }

    /// What OpenCode gets besides Core's own environment: the database and
    /// folders above, no update check or models.dev fetch of its own, and an
    /// executor's temporary directory as TMPDIR, TMP and TEMP (YN-78 S2a).
    /// 2.2.5's `serve` never updates itself anyway (only its TUI does,
    /// cli/src/commands/handlers/default.ts); without the fetch, its models
    /// are its release's own catalog and the user's config
    /// (cli/src/server-process.ts, core/src/models-dev.ts).
    pub fn environment(&self) -> Vec<(&'static str, &OsStr)> {
        let mut environment: Vec<(&'static str, &OsStr)> = vec![("OPENCODE_DB", self.database.as_os_str()),
            ("XDG_DATA_HOME", self.data.as_os_str()), ("XDG_STATE_HOME", self.state.as_os_str()),
            ("XDG_CACHE_HOME", self.cache.as_os_str()), ("OPENCODE_DISABLE_AUTOUPDATE", OsStr::new("1")),
            ("OPENCODE_DISABLE_MODELS_FETCH", OsStr::new("1"))];
        if let Some(temp) = &self.temp_dir {
            environment.extend([("TMPDIR", temp.as_os_str()), ("TMP", temp.as_os_str()), ("TEMP", temp.as_os_str())]);
        }
        environment
    }
}

/// A non-2xx answer, as OpenCode gave it (its body shortened).
#[derive(Debug, Clone, PartialEq)]
pub struct HttpStatus {
    pub code: u16,
    pub body: String,
}

impl fmt::Display for HttpStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OpenCode answered HTTP {}: {}", self.code, self.body)
    }
}

impl std::error::Error for HttpStatus {}

/// A login request OpenCode refused (T-32 slice 4b): its status and kind,
/// never its answer.
#[derive(Debug, PartialEq)]
pub struct LoginRefused {
    pub code: u16,
    pub kind: Option<String>,
}

impl std::fmt::Display for LoginRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            Some(kind) => write!(f, "OpenCode refused the login (HTTP {}, {kind})", self.code),
            None => write!(f, "OpenCode refused the login (HTTP {})", self.code),
        }
    }
}

impl std::error::Error for LoginRefused {}

/// An MCP request OpenCode refused (T-61 slice 1): its status and kind,
/// never its answer, which may quote the request and so its bearer.
#[derive(Debug, PartialEq)]
pub struct McpRefused {
    pub code: u16,
    pub kind: Option<String>,
}

impl std::fmt::Display for McpRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            Some(kind) => write!(f, "OpenCode refused the MCP server (HTTP {}, {kind})", self.code),
            None => write!(f, "OpenCode refused the MCP server (HTTP {})", self.code),
        }
    }
}

impl std::error::Error for McpRefused {}

/// One of 2.x's requests (a permission or a form) whose answer OpenCode
/// refused (T-61 slice 2).
#[derive(Debug, PartialEq)]
pub enum RequestRefused {
    /// 400: it can't take this answer (a form's, checked as 2.x checks it);
    /// the request is still pending. 2.x's own message, which names fields.
    Invalid { message: String },
    /// 404 or 409: it no longer holds the request pending for this session
    /// (answered, ended, or another session's); nothing was answered.
    Gone { code: u16, kind: Option<String> },
    Other { code: u16, kind: Option<String> },
}

impl std::fmt::Display for RequestRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { message } => write!(f, "OpenCode can't take this answer: {message}"),
            Self::Gone { code, kind } => write!(f, "OpenCode no longer holds this request (HTTP {code}{})", kind.as_ref().map(|k| format!(", {k}")).unwrap_or_default()),
            Self::Other { code, kind } => write!(f, "OpenCode refused the answer (HTTP {code}{})", kind.as_ref().map(|k| format!(", {k}")).unwrap_or_default()),
        }
    }
}

impl std::error::Error for RequestRefused {}

/// What a prompt submission is known to have done.
#[derive(Debug, PartialEq)]
pub enum Submission {
    /// OpenCode took it: 2.x's prompt answers with the message as it
    /// durably admitted it, under the ID it was sent with, or says the ID is
    /// one it holds already (T-32 slice 4a).
    Accepted,
    /// A 4xx: OpenCode refused the request before taking it (an unknown
    /// session, an invalid body, wrong credentials).
    Refused(HttpStatus),
    /// No answer, a lost connection, a 5xx or an unexpected status: it may
    /// or may not have been taken. Look for its ID; never send it again.
    Unknown(String),
}

/// What 2.x answered a compaction with (`POST /api/session/:id/compact`,
/// T-61 slice 4). 2.x admits a compaction and answers at once, before it
/// runs: what became of it is its message's, under the ID Core asked for.
#[derive(Debug, PartialEq)]
pub enum CompactAdmission {
    /// 200 with the compaction 2.x admitted under the ID asked for.
    Admitted,
    /// 200 with another compaction already pending in the session (2.2.5
    /// core/src/session/inbox.ts): the one asked for was not admitted.
    OtherPending(String),
    /// Refused before it was admitted: 404 for a session or folder 2.x does
    /// not hold, 400 for a request it can't read. 2.x's words of why.
    Refused { code: u16, message: String },
    /// Anything else (409 for an ID already a message, a 5xx, no answer, a
    /// lost connection, another body): it may or may not have been admitted.
    /// Look for its ID; never send it again.
    Unknown(String),
}

/// What a revert request is known to have done (T-10 Revert, Lead 3990).
#[derive(Debug, PartialEq)]
pub enum RevertAnswer {
    /// 200 with the revert 2.x staged, read as the session holding it
    /// (`{id, revert}`, `Server::stage`).
    Answered(Value),
    /// Refused before OpenCode changed any file, as only its own refusals
    /// before the stage begins answer (see `refused_before`).
    Refused(HttpStatus),
    /// Anything else: no answer, a lost connection, a 5xx, any other 4xx or
    /// body. Its files may have been sent back in part or whole.
    Unknown(String),
}

/// An answer to a permission request. OpenCode's third answer, `always`,
/// is not offered (T-61 D-12): 2.x would keep it as a saved rule of the
/// Agent's database, allowing later requests of the project by patterns the
/// tool chooses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reply {
    Once,
    Reject,
}

/// What became of an answer to a permission request (YN-78 S1, design 2.4 of
/// the OpenCode auto-approval design). OpenCode's 204 says it took the
/// answer, 404 that it no longer holds the request pending, and 400 that it
/// refused the payload with the request still pending. Anything else, no
/// answer or a lost connection included, leaves whether it was taken unknown:
/// never read as delivered, and never as a refusal.
#[derive(Debug, PartialEq)]
pub enum PermissionDelivery {
    /// 204: OpenCode took the answer.
    Delivered,
    /// 404: the request is no longer pending (answered, ended, or another
    /// session's); nothing was answered.
    Gone { code: u16, kind: Option<String> },
    /// 400: OpenCode refused the payload; the request is still pending.
    Invalid { message: String },
    /// It may or may not have been taken: no answer, a timeout, a lost
    /// connection, or a status other than 204, 404 or 400.
    Unknown(String),
}

/// Whether OpenCode reached an MCP server, as it lists it for the Agent's
/// folder (`GET /api/mcp`, T-61 slice 1).
#[derive(Debug, PartialEq)]
pub enum Mcp {
    Connected,
    /// Still connecting (`pending`): 2.x may answer the add of a folder's
    /// first server before it has connected it.
    Pending,
    /// Not listed: never added to the folder, or gone with it.
    Absent,
    /// Any other status (`failed`, `needs_auth`, `disabled`), as OpenCode
    /// reported it (`{status, error?}`).
    NotConnected(Value),
}

/// What OpenCode holds for one session now.
#[derive(Debug, Default)]
pub struct Snapshot {
    /// When the read began, on this process's own clock (`Server::tick`,
    /// #699 R2 and P3-a): what it found missing was missing from then on,
    /// never before.
    pub began: u64,
    /// The Server whose clock `began` is (`Server::id`).
    pub by: String,
    /// The inbox as read first, before the messages (#699 R2): an item 2.x
    /// delivers and stores while the read goes on is in this list or in
    /// `messages`, never in neither.
    pub inbox_first: Value,
    /// The session's messages, oldest first, as `GET /api/session/:id/message`
    /// pages them (`messages`).
    pub messages: Value,
    /// `{type: busy | idle}` (`session_status`).
    pub status: Value,
    /// What 2.x admitted into the session and has not delivered into its
    /// turn yet, oldest first, as `GET /api/session/:id/inbox` lists it.
    pub inbox: Value,
    /// Requests pending in this session and in the sub-agent sessions
    /// given (`snapshot`), each with its `sessionID`; others' are left out.
    pub permissions: Vec<Value>,
    pub questions: Vec<Value>,
}

/// A model one of OpenCode's configured providers offers, as 2.x's
/// `GET /api/model` lists it (T-32 slice 4a), and only what names it: a
/// provider's or a model's `settings`, `headers` and `body` can hold
/// credentials and are never read (T-10).
#[derive(Clone, Debug, PartialEq)]
pub struct ModelChoice {
    pub provider: String,
    pub provider_name: String,
    pub model: String,
    pub name: String,
    /// `alpha`, `beta`, `deprecated` or `active` (schema/src/model.ts).
    pub status: String,
    /// The IDs of its variants (`variants[].id`, such as `low` or `max`),
    /// mildest first; never what each one sets.
    pub variants: Vec<String>,
    /// Whether it reads images (`capabilities.input` holds `image`).
    pub image: bool,
    /// Its context window in tokens (`limit.context`); 0 when OpenCode lists
    /// none, or none that is a whole number.
    pub context: u64,
}

impl ModelChoice {
    /// How Yuzuno names it: `<providerID>/<modelID>`, as OpenCode's own
    /// configuration does (`cfg.model`).
    pub fn id(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

/// An image for a prompt (T-10), inline: a `data:` URI, which 2.x decodes
/// and may scale (T-32 slice 4a, core/src/session/prompt.ts).
pub struct FilePart {
    /// `image/png`, `image/jpeg` or `image/webp`.
    pub mime: &'static str,
    /// Yuzuno's ID for the image, the name OpenCode's record gives it.
    pub filename: String,
    pub data: Vec<u8>,
}

impl FilePart {
    /// As 2.x's prompt takes a file (schema/src/prompt-input.ts): a `data:`
    /// URI, which it decodes in place (core/src/session/prompt.ts), named.
    fn input(&self) -> Value {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.encode(&self.data);
        json!({"uri": format!("data:{};base64,{data}", self.mime), "name": self.filename})
    }
}

/// A command OpenCode offers (`GET /api/command`, T-10, T-61 slice 3): its
/// name and description, all 2.x lists of one. Its template, which may
/// hold shell lines (`!`) or paths, its agent and its model stay
/// OpenCode's: 2.x says nothing of them.
#[derive(Clone, Debug, PartialEq)]
pub struct CommandChoice {
    pub name: String,
    pub description: String,
}

/// What 2.x answered a command with (`POST /api/session/:id/command`, T-61
/// slice 3). It answers once it has admitted what the command makes of its
/// text, or done what the command does, not at the end of any run.
#[derive(Debug, PartialEq)]
pub enum CommandAnswer {
    /// 204: done. What it admitted, if anything, is under an ID of 2.x's
    /// own, as its events and record show: the request carries no ID.
    Done,
    /// A 4xx, with which 2.x ran nothing (404 `CommandNotFoundError` for a
    /// name it does not define, or the session's), or a 500
    /// (`CommandExecutionError`): what the command does failed, possibly
    /// after it admitted a message, which only the session's record tells.
    /// 2.x's words of why, as `command_words` keeps them.
    Refused { code: u16, message: String },
    /// No answer, a lost connection or an unexpected status: it may or may
    /// not have run. It is never sent again.
    Unknown(String),
}

/// 2.x's own words of why it refused or failed a command (`message`), at
/// most `COMMAND_WORDS` characters; else its status.
async fn command_words(response: Response) -> String {
    let code = response.status().as_u16();
    let answered: Value = response.json().await.unwrap_or_default();
    let message = answered["message"].as_str().or(answered["data"]["message"].as_str()).unwrap_or_default();
    if message.trim().is_empty() {
        return format!("HTTP {code}");
    }
    message.chars().take(COMMAND_WORDS).collect()
}

const COMMAND_WORDS: usize = 500;

/// Variant names mildest first, as OpenCode derives them (`none`, `low`, …,
/// `max`, `provider/transform.ts`); other names after them, by name.
fn variant_order(name: &str) -> (usize, &str) {
    const KNOWN: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    (KNOWN.iter().position(|known| *known == name).unwrap_or(KNOWN.len()), name)
}

/// A message ID in OpenCode's own form: `msg_`, 12 hex digits of
/// `ms × 4096 + n`, 14 base62 characters (`schema/src/identifier.ts`).
/// OpenCode orders messages by the time it stores them, so the ID only has to
/// be new. A message keeps its ID: the same ID sent again would replace the
/// stored message and run the session again.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MessageId(String);

impl MessageId {
    pub fn new() -> Self {
        static LAST: Mutex<(u64, u64)> = Mutex::new((0, 0));
        const CHARS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let n = {
            let mut last = LAST.lock().unwrap();
            if last.0 != now {
                *last = (now, 0);
            }
            last.1 += 1;
            last.1
        };
        let value = now.wrapping_mul(0x1000).wrapping_add(n) & 0xffff_ffff_ffff;
        // The bytes of a v4 UUID that hold no version or variant bits.
        let random = uuid::Uuid::new_v4().into_bytes();
        let tail: String = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15]
            .iter()
            .map(|&i| CHARS[random[i] as usize % 62] as char)
            .collect();
        Self(format!("msg_{value:012x}{tail}"))
    }

    /// An ID made by `new` and kept, read back.
    pub fn parse(id: &str) -> Result<Self> {
        let b = id.as_bytes();
        let valid = b.len() == 30
            && b.starts_with(b"msg_")
            && b[4..16].iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && b[16..].iter().all(u8::is_ascii_alphanumeric);
        ensure!(valid, "Not an OpenCode message ID made by Yuzuno: {id}");
        Ok(Self(id.into()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for MessageId {
    fn default() -> Self {
        Self::new()
    }
}

/// OpenCode's process group, whose ID is OpenCode's PID. It is signalled only
/// while that process is not yet reaped, so the ID cannot be anyone else's.
struct Group(Option<u32>);

impl Group {
    fn signal(&self, kill: bool) {
        #[cfg(unix)]
        if let Some(pid) = self.0.and_then(|pid| rustix::process::Pid::from_raw(pid as i32)) {
            let signal = if kill { rustix::process::Signal::KILL } else { rustix::process::Signal::TERM };
            let _ = rustix::process::kill_process_group(pid, signal);
        }
        #[cfg(not(unix))]
        let _ = kill;
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.signal(true);
    }
}

/// One Agent's running `opencode serve`.
pub struct Server {
    // Before `child`: dropped first, while OpenCode is not yet reaped.
    group: Group,
    child: Child,
    base: String,
    password: String,
    directory: String,
    /// The version its `/api/info` reported.
    version: String,
    http: reqwest::Client,
    submitted: Mutex<HashSet<MessageId>>,
    /// This process's own clock of reads and answers (`tick`): the order in
    /// which they happened, whatever the wall clock does (#699 P3-a).
    ticks: std::sync::atomic::AtomicU64,
    /// This Server's own name, new each time one starts (`id`): a tick means
    /// something only beside the name of the Server that counted it (#707
    /// R1 44d3157b; a connection's generation restarts with Core).
    id: String,
}

impl Server {
    /// Starts OpenCode on 127.0.0.1 with a new password and waits until it
    /// listens, is ready and reports a version of `MAJOR`. On any failure,
    /// what it started is ended.
    pub async fn start(launch: &Launch) -> Result<Self> {
        ensure!([&launch.database, &launch.data, &launch.state, &launch.cache].iter().all(|path| path.is_absolute()),
            "The OpenCode database and folders must be absolute paths");
        ensure!(launch.directory.is_absolute() && launch.directory.is_dir(),
            "The Agent's folder must be an existing absolute path");
        let directory = launch.directory.to_str().context("The Agent's folder is not valid UTF-8")?.to_owned();
        let password = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        // OpenCode never reads its stdin, so a Core that ends without
        // dropping `Server` (killed, or exiting) would leave it running on the
        // Agent's database. A watcher in its group holds Core's end of a pipe
        // instead and ends the group when that closes, however Core ends;
        // OpenCode itself replaces the shell (same PID) with stdin closed.
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", WATCHED, "opencode"]).arg(&launch.program);
            command
        };
        #[cfg(not(unix))]
        let mut command = Command::new(&launch.program);
        // Both network options are explicit; 2.x has no mDNS option, and a
        // flag it does not know ends it. The address is taken from what it
        // prints. The password is in the environment only: 2.x reads
        // OPENCODE_PASSWORD before the 1.x name and keeps neither for what it
        // runs (cli/src/env.ts, server-process.ts).
        command
            .args(["serve", "--hostname", "127.0.0.1", "--port", "0"])
            .current_dir(&launch.directory)
            .env("OPENCODE_PASSWORD", &password)
            .envs(launch.environment())
            .envs(launch.extra.iter().map(|(name, value)| (name.as_str(), value.expose())))
            .envs(launch.config.iter().map(|config| ("OPENCODE_CONFIG_CONTENT", config.as_str())))
            .stdin(if cfg!(unix) { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .context("Could not start OpenCode: install the official OpenCode CLI on the Core host")?;
        let stdout = child.stdout.take().context("OpenCode's output is unavailable")?;
        let stderr = child.stderr.take().context("OpenCode's error output is unavailable")?;
        // Its first STDERR_KEPT bytes are kept, to tell why a start failed;
        // all of it is drained, so that writing it never blocks or fails.
        let said = Arc::new(Mutex::new(Vec::new()));
        let (closed, ended) = tokio::sync::oneshot::channel::<()>();
        {
            let said = said.clone();
            tokio::spawn(async move {
                let (mut stderr, mut chunk) = (stderr, [0u8; 4096]);
                while let Ok(read) = stderr.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    let mut kept = said.lock().unwrap();
                    let room = STDERR_KEPT.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
                let _ = closed.send(());
            });
        }
        let mut server = Self {
            group: Group(child.id()),
            child,
            base: String::new(),
            password,
            directory,
            version: String::new(),
            // Never through a proxy: the password goes to loopback only.
            http: reqwest::Client::builder().no_proxy().build()?,
            submitted: Mutex::default(),
            ticks: std::sync::atomic::AtomicU64::new(0),
            id: uuid::Uuid::new_v4().simple().to_string(),
        };
        // From here on, an error drops `server`, which ends its group.
        // OpenCode's output is bytes, not necessarily UTF-8; a line is read
        // at most LINE_LIMIT at a time.
        let mut output = BufReader::new(stdout);
        let listened = timeout(START_LIMIT, async {
            let mut line = Vec::new();
            loop {
                line.clear();
                if (&mut output).take(LINE_LIMIT).read_until(b'\n', &mut line).await? == 0 {
                    return Ok::<_, anyhow::Error>(None);
                }
                if let Some(base) = listening(&String::from_utf8_lossy(&line))? {
                    return Ok(Some(base));
                }
            }
        })
        .await;
        server.base = match listened {
            Ok(Ok(Some(base))) => base,
            Ok(Ok(None)) => {
                let _ = timeout(STDERR_WAIT, ended).await;
                let said = said.lock().unwrap().clone();
                bail!("OpenCode exited before it was listening{}", diagnosis(launch, &said).await);
            }
            Ok(Err(error)) => {
                let said = said.lock().unwrap().clone();
                bail!("{error:#}{}", diagnosis(launch, &said).await);
            }
            Err(_) => {
                let said = said.lock().unwrap().clone();
                bail!("OpenCode was not listening after {}s{}", START_LIMIT.as_secs(), diagnosis(launch, &said).await);
            }
        };
        // Its later output is not read, only drained so that writing it
        // never blocks or fails.
        tokio::spawn(async move { tokio::io::copy(&mut output, &mut tokio::io::sink()).await });
        let info = server.ready().await?;
        let version = info["version"].as_str().unwrap_or_default();
        ensure!(supported(version),
            "OpenCode {version} is not supported: Yuzuno speaks the server protocol of OpenCode {MAJOR}.x (checked against {VERIFIED})");
        ensure!(release(version).is_some(), "OpenCode {version}: {}", unreadable_note());
        ensure!(!older_than_min(version), "OpenCode {version} is {}", older_note());
        server.version = version.to_owned();
        Ok(server)
    }

    /// `/api/info` once 2.x is ready: it answers 503 while it is still
    /// starting (server/src/process.ts), and is asked again until it is, within
    /// START_LIMIT. Asked without `?directory=`: it is the server's, not an
    /// instance's.
    async fn ready(&self) -> Result<Value> {
        let url = format!("{}/api/info", self.base);
        let asked = timeout(START_LIMIT, async {
            loop {
                let answer = self.http.get(&url).basic_auth(USERNAME, Some(&self.password)).timeout(REQUEST_LIMIT).send().await
                    .context("OpenCode did not answer /api/info")?;
                if answer.status() != reqwest::StatusCode::SERVICE_UNAVAILABLE {
                    return success(answer).await?.json::<Value>().await.context("OpenCode's answer to /api/info is not JSON");
                }
                tokio::time::sleep(READY_POLL).await;
            }
        })
        .await;
        asked.map_err(|_| anyhow!("OpenCode was not ready after {}s", START_LIMIT.as_secs()))?
    }

    /// The version this server's `/api/info` reported.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// The loopback address it listens on (`http://127.0.0.1:PORT`).
    pub fn base(&self) -> &str {
        &self.base
    }

    /// Asks OpenCode to end (SIGTERM to its group) without waiting: 2.x then
    /// tears down as for `shutdown`, ending what its tools run. For a server
    /// that others still hold; the last of them reaps it.
    pub fn terminate(&self) {
        #[cfg(unix)]
        self.group.signal(false);
    }

    /// Sends SIGKILL to this process's group, without waiting or reaping
    /// (YN-78 S4b's last stage, after SIGTERM and TEARDOWN did not end it).
    /// The group is signalled only while its process is not yet reaped, as
    /// `Group` says; sending it is not the kernel having ended it.
    pub(crate) fn kill(&self) {
        #[cfg(unix)]
        self.group.signal(true);
    }

    /// Waits at most `limit` for OpenCode to exit, without reaping it, and
    /// says whether it did. Unix only; elsewhere it does not wait.
    pub async fn ended_within(&self, limit: Duration) -> bool {
        #[cfg(unix)]
        {
            let deadline = Instant::now() + limit;
            while !self.exited() && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            self.exited()
        }
        #[cfg(not(unix))]
        {
            let _ = limit;
            false
        }
    }

    /// OpenCode's process ID, while it is not yet reaped.
    pub fn pid(&self) -> Option<u32> {
        self.group.0
    }

    /// Ends OpenCode and its own children: SIGTERM to the group, up to
    /// TEARDOWN for OpenCode to tear down (ending what its tools run) and
    /// exit, then SIGKILL to whatever of it is left.
    pub async fn shutdown(mut self) -> Result<()> {
        #[cfg(unix)]
        {
            self.group.signal(false);
            let deadline = Instant::now() + TEARDOWN;
            while !self.exited() && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            self.group.signal(true);
        }
        #[cfg(not(unix))]
        let _ = self.child.start_kill();
        let waited = self.child.wait().await;
        // Reaped: the group's ID may now be reused, so it is not signalled again.
        self.group.0 = None;
        waited.context("OpenCode did not end")?;
        Ok(())
    }

    /// Whether OpenCode has exited, without reaping it.
    #[cfg(unix)]
    fn exited(&self) -> bool {
        use rustix::process::{waitid, Pid, WaitId, WaitIdOptions};
        let Some(pid) = self.group.0.and_then(|pid| Pid::from_raw(pid as i32)) else { return true };
        let options = WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG;
        !matches!(waitid(WaitId::Pid(pid), options), Ok(None))
    }

    /// A Server over an arbitrary test process, with the same process-group
    /// ownership a real one has, for the S4b teardown tests. Test-only.
    #[cfg(all(test, unix))]
    pub(crate) fn synthetic(command: &mut Command) -> Self {
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .kill_on_drop(true).process_group(0);
        let child = command.spawn().expect("a synthetic runtime");
        Self {
            group: Group(child.id()),
            child,
            base: String::new(),
            password: String::new(),
            directory: String::new(),
            version: String::new(),
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
            submitted: Mutex::default(),
            ticks: std::sync::atomic::AtomicU64::new(0),
            id: "synthetic-runtime".into(),
        }
    }

    /// A new session; OpenCode's record of it (its `id` names it).
    pub async fn create_session(&self, title: &str) -> Result<Value> {
        // 2.x takes the session's folder from its body, not from the request (server/src/handlers/session.ts).
        let body = json!({"title": title, "location": {"directory": self.directory}});
        let session = self.data(Method::POST, "/api/session", &[], Some(&body)).await?;
        segment(session["id"].as_str().unwrap_or_default()).context("OpenCode created a session without a usable ID")?;
        Ok(session)
    }

    /// Sends one text prompt under `id`, once: an ID this server was given
    /// before is refused here, whatever became of it.
    pub async fn submit(&self, session: &str, id: &MessageId, text: &str) -> Result<Submission> {
        self.submit_with(session, id, text, &[]).await
    }

    /// As `submit`, with its images after the text, through 2.x's prompt
    /// (`POST /api/session/:id/prompt`, T-32 slice 4a). It carries no model:
    /// the session's is set apart (`switch_model`). Its answer is the message
    /// as 2.x admitted it under `id`, which a Conflict says it holds already.
    pub async fn submit_with(&self, session: &str, id: &MessageId, text: &str, files: &[FilePart]) -> Result<Submission> {
        let path = format!("/api/session/{}/prompt", segment(session)?);
        ensure!(self.submitted.lock().unwrap().insert(id.clone()),
            "Message {} was submitted already; it is never sent again", id.as_str());
        let mut body = json!({"id": id.as_str(), "text": text});
        if !files.is_empty() {
            body["files"] = files.iter().map(FilePart::input).collect();
        }
        let sent = self.request(Method::POST, &path).timeout(REQUEST_LIMIT).json(&body).send().await;
        Ok(match sent {
            Err(error) => Submission::Unknown(format!("OpenCode did not answer: {error}")),
            Ok(response) if response.status().is_success() => match response.json::<Value>().await {
                Ok(answer) if answer["data"]["id"] == id.as_str() => Submission::Accepted,
                Ok(answer) => Submission::Unknown(format!("OpenCode admitted {} instead", answer["data"]["id"].as_str().unwrap_or("no message it named"))),
                Err(error) => Submission::Unknown(format!("OpenCode's answer was not read: {error}")),
            },
            // 2.x's ConflictError: a message under this ID is one it holds already.
            Ok(response) if response.status().as_u16() == 409 => Submission::Accepted,
            Ok(response) if response.status().is_client_error() => Submission::Refused(status(response).await),
            Ok(response) => Submission::Unknown(status(response).await.to_string()),
        })
    }

    /// Makes `model`, with `variant`, the session's for its next steps
    /// (`POST /api/session/:id/model`, T-32 slice 4a): 2.x's prompt carries
    /// none. 2.x keeps a `model-switched` message of it.
    pub async fn switch_model(&self, session: &str, model: &ModelChoice, variant: Option<&str>) -> Result<()> {
        let mut body = json!({"model": {"id": model.model, "providerID": model.provider}});
        if let Some(variant) = variant {
            body["model"]["variant"] = variant.into();
        }
        let path = format!("/api/session/{}/model", segment(session)?);
        let response = self.request(Method::POST, &path).timeout(REQUEST_LIMIT).json(&body).send().await
            .with_context(|| format!("OpenCode did not answer {path}"))?;
        success(response).await?;
        Ok(())
    }

    /// Where 2.x holds the message sent under `id`, or `None` while it holds
    /// none (T-32 slice 4a): admitted and waiting in its inbox, else among the
    /// session's messages once delivered (`GET
    /// /api/session/:id/message/:messageID`). The inbox is read first:
    /// delivery only moves a message from it to the messages, so one
    /// delivered between the two reads is found by the second (R5 728f7e52).
    /// A session OpenCode does not know is an error, not a `None`.
    pub async fn message(&self, session: &str, id: &MessageId) -> Result<Option<Value>> {
        let inbox = self.data(Method::GET, &format!("/api/session/{}/inbox", segment(session)?), &[], None).await?;
        if let Some(waiting) = inbox.as_array().into_iter().flatten().find(|item| item["id"] == id.as_str()) {
            return Ok(Some(waiting.clone()));
        }
        let path = format!("/api/session/{}/message/{}", segment(session)?, segment(id.as_str())?);
        match self.data(Method::GET, &path, &[], None).await {
            Ok(message) => Ok(Some(message)),
            Err(error) if error.downcast_ref::<HttpStatus>().is_some_and(|s| s.code == 404) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Opens the event stream and reads up to its `server.connected`.
    /// `idle_limit` bounds a silence (normally `EVENT_IDLE_LIMIT`).
    pub async fn subscribe(&self, idle_limit: Duration) -> Result<Events> {
        // Not the request's own timeout: that would also end the stream.
        let sent = self.request(Method::GET, "/api/event").header("accept", "text/event-stream").send();
        let response = timeout(REQUEST_LIMIT, sent).await
            .map_err(|_| anyhow!("OpenCode did not answer /api/event"))?
            .context("OpenCode did not answer /api/event")?;
        let response = success(response).await?;
        let kind = content_type(&response);
        ensure!(kind.eq_ignore_ascii_case("text/event-stream"),
            "OpenCode answered /api/event with {}, not an event stream: not the OpenCode {MAJOR}.x API", shown(kind));
        let mut events = Events { response, buffer: Vec::new(), scanned: 0, idle_limit };
        let first = events.next().await?.context("OpenCode closed its event stream at once")?;
        ensure!(first["type"] == "server.connected", "OpenCode's event stream did not begin with server.connected");
        Ok(events)
    }

    /// `session`'s status now, in the shape Core's record takes:
    /// `{type: busy}` while 2.x lists it among the sessions this process is
    /// running (`GET /api/session/active`), else `{type: idle}`. 2.x lists no
    /// retry there; it is on the answer that retries.
    pub async fn session_status(&self, session: &str) -> Result<Value> {
        status_of(&self.data(Method::GET, "/api/session/active", &[], None).await?, session)
    }

    /// The next tick of this process's own clock (`ticks`), from 1: a later
    /// call answers more. A tick of another Server means nothing here.
    pub fn tick(&self) -> u64 {
        self.ticks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    /// This Server's own name (`id`), whose `tick`s these are.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The session's messages, status and inbox, read now, with the requests
    /// pending in it and in the sub-agent sessions `children`.
    pub async fn snapshot(&self, session: &str, children: &[String]) -> Result<Snapshot> {
        let began = self.tick();
        let path = format!("/api/session/{}/inbox", segment(session)?);
        let inbox_first = self.data(Method::GET, &path, &[], None).await?;
        ensure!(inbox_first.is_array(), "OpenCode's {path} is not a list");
        let messages = self.messages(session).await?;
        let status = self.session_status(session).await?;
        let inbox = self.data(Method::GET, &path, &[], None).await?;
        ensure!(inbox.is_array(), "OpenCode's {path} is not a list");
        let sessions: Vec<&str> = std::iter::once(session).chain(children.iter().map(String::as_str)).collect();
        Ok(Snapshot {
            began,
            by: self.id.clone(),
            inbox_first,
            messages,
            status,
            inbox,
            permissions: self.pending_of("permission", &sessions).await?,
            questions: self.pending_of("form", &sessions).await?,
        })
    }

    /// The chat models 2.x offers now (`GET /api/model`), named with their
    /// providers' names (`GET /api/provider`), by provider and then model
    /// name (T-32 slice 4a). Only what names and describes one is read: a
    /// provider's or a model's `settings`, `headers` and `body` can hold
    /// credentials and are never kept.
    pub async fn models(&self) -> Result<Vec<ModelChoice>> {
        let providers = self.data(Method::GET, "/api/provider", &[], None).await?;
        let names: HashMap<&str, &str> = providers.as_array().context("OpenCode's providers is not a list")?.iter()
            .filter_map(|provider| Some((provider["id"].as_str()?, provider["name"].as_str()?))).collect();
        let listed = self.data(Method::GET, "/api/model", &[], None).await?;
        let mut models = Vec::new();
        for model in listed.as_array().context("OpenCode's models is not a list")? {
            let (Some(id), Some(provider)) = (model["id"].as_str(), model["providerID"].as_str()) else { continue };
            // One a provider's settings turned off is not offered (schema/src/model.ts `enabled`).
            if model["enabled"] == false {
                continue;
            }
            let mut variants: Vec<String> = model["variants"].as_array().into_iter().flatten()
                .filter_map(|variant| variant["id"].as_str().map(str::to_owned)).collect();
            variants.sort_by(|a, b| variant_order(a).cmp(&variant_order(b)));
            models.push(ModelChoice {
                provider: provider.into(),
                provider_name: names.get(provider).copied().unwrap_or(provider).into(),
                model: id.into(),
                name: model["name"].as_str().unwrap_or(id).into(),
                status: model["status"].as_str().unwrap_or("active").into(),
                variants,
                image: model["capabilities"]["input"].as_array().is_some_and(|input| input.iter().any(|kind| kind == "image")),
                context: model["limit"]["context"].as_u64().unwrap_or(0),
            });
        }
        models.sort_by(|a, b| (&a.provider_name, &a.name, &a.model).cmp(&(&b.provider_name, &b.name, &b.model)));
        Ok(models)
    }

    /// The model 2.x runs a session on when none was made the session's: its
    /// configuration's `model`, else its newest enabled chat model (`GET
    /// /api/model/default`; 2.2.5 core/src/model.ts `default`), as
    /// `<provider>/<model>` and as shown, its provider's name (`GET
    /// /api/provider`) and its own; None when it has none (YN-48). Only its
    /// IDs and names are read.
    pub async fn default_model(&self) -> Result<Option<(String, String)>> {
        let model = self.data(Method::GET, "/api/model/default", &[], None).await?;
        let (Some(provider), Some(id)) = (model["providerID"].as_str(), model["id"].as_str()) else { return Ok(None) };
        let providers = self.data(Method::GET, "/api/provider", &[], None).await?;
        let provider_name = providers.as_array().into_iter().flatten().find(|p| p["id"] == provider)
            .and_then(|p| p["name"].as_str()).unwrap_or(provider);
        Ok(Some((format!("{provider}/{id}"), format!("{provider_name} · {}", model["name"].as_str().unwrap_or(id)))))
    }

    /// The commands OpenCode offers now, by name (`GET /api/command`, T-32
    /// slice 4a): its configuration's, its own (`init`, `review`, `goal`, …)
    /// and its MCP servers' prompts. Each is named and described only.
    pub async fn commands(&self) -> Result<Vec<CommandChoice>> {
        let listed = self.data(Method::GET, "/api/command", &[], None).await?;
        let mut commands: Vec<CommandChoice> = listed.as_array().context("OpenCode's commands is not a list")?.iter()
            .filter_map(|command| Some(CommandChoice {
                name: command["name"].as_str()?.to_owned(),
                description: command["description"].as_str().unwrap_or_default().into(),
            })).collect();
        commands.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(commands)
    }

    /// The request that runs the command `name` with `text` in the session
    /// (`POST /api/session/:id/command {name, text}`, T-61 slice 3), once
    /// for `id`, Core's ID of its Turn: an ID this server was given before
    /// is refused here, whatever became of it. 2.x's request carries no ID
    /// and no model: what it admits gets an ID of 2.x's own, with the
    /// session's model unless the command names one. 2.x answers once the
    /// command has admitted its message, which can wait on the template's
    /// shell lines or an MCP server, so the request has no time limit of
    /// its own, and holds nothing of this server: it does not keep OpenCode
    /// from being stopped.
    pub fn command(&self, session: &str, id: &MessageId, name: &str, text: &str)
        -> Result<impl std::future::Future<Output = CommandAnswer> + Send + 'static> {
        let path = format!("/api/session/{}/command", segment(session)?);
        ensure!(self.submitted.lock().unwrap().insert(id.clone()),
            "Message {} was submitted already; it is never sent again", id.as_str());
        let request = self.request(Method::POST, &path).json(&json!({"name": name, "text": text}));
        Ok(async move {
            match request.send().await {
                Err(error) => CommandAnswer::Unknown(format!("OpenCode did not answer: {error}")),
                Ok(response) if response.status().is_success() => CommandAnswer::Done,
                Ok(response) if response.status().is_client_error() || response.status().as_u16() == 500 => {
                    let code = response.status().as_u16();
                    CommandAnswer::Refused { code, message: command_words(response).await }
                }
                Ok(response) => CommandAnswer::Unknown(status(response).await.to_string()),
            }
        })
    }

    /// The session as OpenCode holds it now (`GET /api/session/:id`): its
    /// `revert`, among the rest, set while a revert waits to be applied.
    pub async fn session(&self, session: &str) -> Result<Value> {
        self.data(Method::GET, &format!("/api/session/{}", segment(session)?), &[], None).await
    }

    /// Where 2.x holds `directory` (T-61 slice 5: `GET /api/location`, its
    /// `location[directory]` as a deepObject query, protocol/src/groups/
    /// location.ts): `{directory, project: {id, directory, canonical}}`, the
    /// folder as 2.x resolved it and the project it holds it for, whose
    /// `directory` is the Git top level its snapshots are taken from.
    pub async fn location(&self, directory: &str) -> Result<Value> {
        self.json_with(Method::GET, "/api/location", &[(LOCATION, directory)], None).await
    }

    /// The agents 2.x has for `directory` (T-61 slice 8: `GET /api/agent`,
    /// protocol/src/groups/agent.ts), each as `(id, mode, hidden)`: only
    /// those fields are read, since an agent's `request` may hold its
    /// provider's headers.
    pub async fn agents(&self, directory: &str) -> Result<Vec<(String, String, bool)>> {
        let listed = self.data(Method::GET, "/api/agent", &[(LOCATION, directory)], None).await?;
        let listed = listed.as_array().context("OpenCode's /api/agent is not a list")?;
        Ok(listed.iter().filter_map(|agent| Some((agent["id"].as_str()?.to_owned(), agent["mode"].as_str()?.to_owned(),
            agent["hidden"].as_bool().unwrap_or(false)))).collect())
    }

    /// The agents 2.x has for `directory`, each as `{id, permissions}`: the
    /// permission rules it decides by (YN-56 S3). Only those fields are kept,
    /// since an agent's `request` may hold its provider's headers.
    pub async fn agent_rules(&self, directory: &str) -> Result<Value> {
        let listed = self.data(Method::GET, "/api/agent", &[(LOCATION, directory)], None).await?;
        let listed = listed.as_array().context("OpenCode's /api/agent is not a list")?;
        Ok(listed.iter().map(|agent| serde_json::json!({"id": agent["id"], "permissions": agent["permissions"]})).collect())
    }

    /// The session's messages now, `[{info, parts}]`, as a snapshot reads them.
    /// Every page of them, oldest first: 2.x gives 50 at most, newest first,
    /// unless asked (server/src/handlers/message.ts).
    pub async fn messages(&self, session: &str) -> Result<Value> {
        Ok(Value::Array(self.all(&format!("/api/session/{}/message", segment(session)?), &[("order", "asc")]).await?))
    }

    /// Compacts the session under `id` (T-61 slice 4: `POST
    /// /api/session/:id/compact {id}`), once: an ID this server was given
    /// before is refused here, whatever became of it. The request carries no
    /// model: 2.x compacts with the session's, as a prompt runs. 2.x commits a
    /// revert the session holds first, then admits the compaction and answers
    /// at once; it has no busy guard (a compaction admitted while a run goes
    /// on is taken up at its next step), so callers ask only while idle.
    pub async fn compact(&self, session: &str, id: &MessageId) -> Result<CompactAdmission> {
        let path = format!("/api/session/{}/compact", segment(session)?);
        ensure!(self.submitted.lock().unwrap().insert(id.clone()),
            "Message {} was submitted already; it is never sent again", id.as_str());
        let sent = self.request(Method::POST, &path).timeout(REQUEST_LIMIT).json(&json!({"id": id.as_str()})).send().await;
        Ok(match sent {
            Err(error) => CompactAdmission::Unknown(format!("OpenCode did not answer: {error}")),
            Ok(response) if response.status().as_u16() == 200 => match response.json::<Value>().await {
                Ok(answer) if answer["data"]["type"] == "compaction" && answer["data"]["id"] == id.as_str() => CompactAdmission::Admitted,
                Ok(answer) if answer["data"]["type"] == "compaction" && answer["data"]["id"].is_string() =>
                    CompactAdmission::OtherPending(answer["data"]["id"].as_str().unwrap_or_default().to_owned()),
                Ok(_) => CompactAdmission::Unknown("OpenCode answered 200 with no compaction".into()),
                Err(error) => CompactAdmission::Unknown(format!("OpenCode's answer was not read: {error}")),
            },
            Ok(response) => {
                let code = response.status().as_u16();
                let answered: Value = response.json().await.unwrap_or_default();
                let kind = answered["_tag"].as_str().unwrap_or_default();
                let words = || answered["message"].as_str().unwrap_or("").chars().take(500).collect::<String>();
                // Only what 2.x refuses before it admits anything: an unknown session or folder, a request it can't read.
                let refused = matches!((code, kind), (404, "SessionNotFoundError" | "LocationNotFoundError"))
                    || (code == 400 && kind == "InvalidRequestError"
                        && matches!(answered["kind"].as_str(), Some("Params" | "Headers" | "Query" | "Payload")));
                if refused {
                    CompactAdmission::Refused { code, message: if words().is_empty() { format!("HTTP {code}") } else { words() } }
                } else {
                    CompactAdmission::Unknown(format!("OpenCode answered HTTP {code} {kind}"))
                }
            }
        })
    }

    /// The request that stages a revert of `session` to before `message`
    /// (T-61 slice 6: `POST /api/session/:id/revert/stage {messageID,
    /// files: true}`, 2.2.5 core/src/session/revert.ts). 2.x captures the
    /// folder, sends back each file of every later step to that step's first
    /// snapshot, keeps the revert in the session and answers with it once
    /// that is done; `commit` then deletes the messages. So it has no time
    /// limit of its own and holds nothing of this server; sent once. Its 200
    /// is read as the session holding that revert (`{id, revert}`), as
    /// 1.19.3's whole session answer was.
    pub fn stage(&self, session: &str, message: &str) -> Result<impl std::future::Future<Output = RevertAnswer> + Send + 'static> {
        let path = format!("/api/session/{}/revert/stage", segment(session)?);
        let request = self.request(Method::POST, &path).json(&json!({"messageID": message, "files": true}));
        let (session, asked) = (session.to_owned(), message.to_owned());
        Ok(async move {
            match request.send().await {
                Err(error) => RevertAnswer::Unknown(format!("OpenCode did not answer: {error}")),
                Ok(response) if response.status().as_u16() == 200 => match response.text().await {
                    Ok(body) => match serde_json::from_str::<Value>(&body) {
                        Ok(answer) if answer["data"].is_object() => RevertAnswer::Answered(json!({"id": session, "revert": answer["data"]})),
                        _ => RevertAnswer::Unknown(format!("OpenCode answered 200 with {}", body.chars().take(200).collect::<String>())),
                    },
                    Err(error) => RevertAnswer::Unknown(format!("OpenCode's answer broke off: {error}")),
                },
                Ok(response) => {
                    let status = status(response).await;
                    if refused_before(&status, &session, &asked) { RevertAnswer::Refused(status) } else { RevertAnswer::Unknown(status.to_string()) }
                }
            }
        })
    }

    /// Commits the revert `session` holds (T-61 slice 6: `POST
    /// /api/session/:id/revert/commit`, D-26 (a)): 2.x deletes the messages
    /// from its boundary on, the boundary included, and touches no file.
    /// 204, also when nothing is held. A lost answer is harmless: 2.x commits
    /// a held revert itself before its next prompt or compaction.
    pub async fn commit(&self, session: &str) -> Result<()> {
        let path = format!("/api/session/{}/revert/commit", segment(session)?);
        let response = self.request(Method::POST, &path).timeout(REQUEST_LIMIT).send().await
            .map_err(|error| anyhow!("OpenCode did not answer {path} ({})", error.without_url()))?;
        ensure!(response.status().as_u16() == 204, "OpenCode answered {path} with {}", status(response).await);
        Ok(())
    }

    /// Writes `payload` as a new session through 2.x's import (T-61 slice 7,
    /// `POST /api/experimental/session/import {info, messages, location}`,
    /// 2.2.5 core/src/session/transfer.ts), once, waiting at most `limit`.
    /// 2.x writes it in one transaction, so whatever the answer, only a read
    /// says what it holds.
    pub async fn import(&self, payload: &crate::opencode_transfer::Payload, limit: Duration) -> crate::opencode_transfer::ImportAnswer {
        use crate::opencode_transfer::{import_answer, ImportAnswer};
        let request = self.request(Method::POST, "/api/experimental/session/import").timeout(limit).json(&payload.body());
        match request.send().await {
            Err(error) => ImportAnswer::Unknown(format!("OpenCode did not answer: {}", error.without_url())),
            Ok(response) if response.status().as_u16() == 200 => match response.text().await {
                Ok(body) => match serde_json::from_str::<Value>(&body) {
                    Ok(answer) if answer["data"].is_object() => ImportAnswer::Imported(answer["data"].clone()),
                    _ => ImportAnswer::Unknown(format!("OpenCode answered 200 with {}", body.chars().take(200).collect::<String>())),
                },
                Err(error) => ImportAnswer::Unknown(format!("OpenCode's answer broke off: {}", error.without_url())),
            },
            Ok(response) => {
                let status = status(response).await;
                import_answer(&status, payload.id()).unwrap_or(ImportAnswer::Failed(status))
            }
        }
    }

    /// Every session this OpenCode lists (`GET /api/session`), every page,
    /// oldest first.
    pub async fn sessions(&self) -> Result<Vec<Value>> {
        self.all("/api/session", &[("order", "asc")]).await
    }

    /// The sessions OpenCode started under `session` (its sub-agents,
    /// `parentID` = `session`), as `GET /api/session?parentID=` lists them,
    /// every page.
    pub async fn children(&self, session: &str) -> Result<Vec<Value>> {
        self.all("/api/session", &[("parentID", segment(session)?), ("order", "asc")]).await
    }

    /// Answers a permission request pending in `session` (T-61 slice 2:
    /// `POST /api/session/:id/permission/:request/reply`, 204). 2.x refuses
    /// one no longer pending, or of another session, with 404, having
    /// answered nothing (`RequestRefused::Gone`). Its rule: rejecting one
    /// rejects every other request then pending in the same session
    /// (2.2.5 core/src/permission.ts).
    pub async fn reply_permission(&self, session: &str, request: &str, reply: Reply) -> Result<()> {
        let decision = match reply { Reply::Once => "once", Reply::Reject => "reject" };
        let path = format!("/api/session/{}/permission/{}/reply", segment(session)?, segment(request)?);
        self.request_call(Method::POST, &path, Some(&json!({"decision": decision}))).await
    }

    /// The permission request `request` if it still waits in `session`
    /// (`GET /api/session/:sessionID/permission/:requestID`, YN-78 S1):
    /// `None` when OpenCode answers 404, which says it no longer holds it
    /// pending. This is the read design 2.4 uses to check an answer whose
    /// delivery is unknown.
    pub async fn pending_permission(&self, session: &str, request: &str) -> Result<Option<Value>> {
        self.wire().pending_permission(session, request, REQUEST_LIMIT).await
    }

    /// Every permission request waiting in `session` (`GET
    /// /api/session/:sessionID/permission`, YN-78 S1), in OpenCode's order.
    /// The read design 2.4 uses to answer some before a reject.
    pub async fn pending_permissions(&self, session: &str) -> Result<Vec<Value>> {
        self.wire().pending_permissions(session, REQUEST_LIMIT).await
    }

    /// As `pending_permission`, with an explicit bound for the whole read,
    /// body included (YN-78 S4b: what is left of an absolute deadline).
    pub(crate) async fn pending_permission_within(&self, session: &str, request: &str, limit: Duration) -> Result<Option<Value>> {
        self.wire().pending_permission(session, request, limit).await
    }

    /// As `pending_permissions`, with an explicit bound for the whole read,
    /// body included (YN-78 S4b).
    pub(crate) async fn pending_permissions_within(&self, session: &str, limit: Duration) -> Result<Vec<Value>> {
        self.wire().pending_permissions(session, limit).await
    }

    /// Answers a permission request and reports what became of it (YN-78
    /// S1, design 2.4): 204 delivered, 404 gone, 400 refused, and unknown
    /// for no answer, a timeout, a lost connection or another status.
    /// `message`, when given, is OpenCode's feedback to the model: with a
    /// reject the tool fails as corrected and the turn continues (2.2.5
    /// core/src/permission.ts). None sends the same payload as
    /// `reply_permission`, which stays the manual path, unchanged: its
    /// reject carries no reason and ends the step.
    pub async fn answer_permission(&self, session: &str, request: &str, reply: Reply, message: Option<&str>) -> Result<PermissionDelivery> {
        self.wire().answer_permission(session, request, reply, message, REQUEST_LIMIT).await
    }

    /// As `answer_permission`, with an explicit bound for the whole request,
    /// body included (YN-78 S4b: min(REQUEST_LIMIT, what a deadline leaves)).
    pub(crate) async fn answer_permission_within(&self, session: &str, request: &str, reply: Reply, message: Option<&str>,
        limit: Duration) -> Result<PermissionDelivery> {
        self.wire().answer_permission(session, request, reply, message, limit).await
    }

    /// This server's HTTP side, for the calls of YN-78 S1.
    fn wire(&self) -> Wire<'_> {
        Wire { base: &self.base, password: &self.password, http: &self.http }
    }

    /// Answers a form pending in `session` (T-61 slice 2: `POST
    /// /api/session/:id/form/:form/reply`, 204): each field's value by its
    /// key. 2.x checks the answer first and refuses one it can't take with
    /// 400, leaving the form pending (`RequestRefused::Invalid`).
    pub async fn reply_form(&self, session: &str, form: &str, answer: &Value) -> Result<()> {
        let path = format!("/api/session/{}/form/{}/reply", segment(session)?, segment(form)?);
        self.request_call(Method::POST, &path, Some(&json!({"answer": answer}))).await
    }

    /// Declines a form pending in `session` (`DELETE
    /// /api/session/:id/form/:form`, 204), with no message: the tool that
    /// asked fails as a declined one does.
    pub async fn cancel_form(&self, session: &str, form: &str) -> Result<()> {
        let path = format!("/api/session/{}/form/{}", segment(session)?, segment(form)?);
        self.request_call(Method::DELETE, &path, None).await
    }

    /// An answer to one of 2.x's requests: 204, or what it refused it as.
    async fn request_call(&self, method: Method, path: &str, body: Option<&Value>) -> Result<()> {
        let mut request = self.request(method, path).timeout(REQUEST_LIMIT);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.with_context(|| format!("OpenCode did not answer {path}"))?;
        let code = response.status().as_u16();
        if response.status().is_success() {
            return Ok(());
        }
        let answered: Value = response.json().await.unwrap_or_default();
        let kind = answered["_tag"].as_str().or(answered["name"].as_str()).map(str::to_owned);
        bail!(match code {
            400 => RequestRefused::Invalid { message: answered["message"].as_str().unwrap_or_default().chars().take(300).collect() },
            404 | 409 => RequestRefused::Gone { code, kind },
            _ => RequestRefused::Other { code, kind },
        })
    }

    /// Asks OpenCode to interrupt the session's run (`POST
    /// /api/session/:id/interrupt`, T-32 slice 4a). Its answer is not the
    /// end of the run: that is its `execution.interrupted`, by event or
    /// snapshot.
    pub async fn abort(&self, session: &str) -> Result<()> {
        self.json(Method::POST, &format!("/api/session/{}/interrupt", segment(session)?), None).await?;
        Ok(())
    }

    /// As `abort`, with an explicit bound (YN-78 S4b's interrupt stage).
    pub(crate) async fn abort_within(&self, session: &str, limit: Duration) -> Result<()> {
        let path = format!("/api/session/{}/interrupt", segment(session)?);
        timeout(limit, self.json(Method::POST, &path, None)).await
            .map_err(|_| anyhow!("OpenCode did not answer {path} within {limit:?}"))??;
        Ok(())
    }

    /// The integrations this OpenCode can log in to, with their methods and
    /// connections (`GET /api/integration`, T-32 slice 4b). Its answer
    /// carries no secret (core/src/integration.ts); Core never reads
    /// `/api/credential`, which answers them.
    pub async fn integrations(&self) -> Result<Vec<Value>> {
        let listed = self.data(Method::GET, "/api/integration", &[], None).await?;
        listed.as_array().cloned().context("OpenCode's integrations is not a list")
    }

    /// Where each provider OpenCode offers now gets its access (YN-47), by
    /// provider ID, as `sources` tells it from `GET /api/provider` and
    /// `GET /api/integration`. Neither answer's settings or metadata are read.
    pub async fn provider_sources(&self) -> Result<HashMap<String, &'static str>> {
        let providers = self.data(Method::GET, "/api/provider", &[], None).await?;
        Ok(sources(&providers, &self.integrations().await?))
    }

    /// Logs `integration` in with `key` (`POST
    /// /api/integration/:id/connect/key`, 204), which 2.x keeps in its own
    /// database as the active credential. The key goes in this request's
    /// body only, and a refusal says its status and kind, never what
    /// OpenCode answered (`login`).
    pub async fn connect_key(&self, integration: &str, key: &str, label: Option<&str>, answer: Option<&Value>) -> Result<()> {
        let mut body = json!({"key": key});
        if let Some(label) = label {
            body["label"] = label.into();
        }
        if let Some(answer) = answer {
            body["answer"] = answer.clone();
        }
        self.login(Method::POST, &format!("/api/integration/{}/connect/key", segment(integration)?), Some(&body)).await?;
        Ok(())
    }

    /// Starts an OAuth sign-in by `method` (`POST …/connect/oauth`): the
    /// attempt, its link and instructions, mode and expiry.
    pub async fn oauth_start(&self, integration: &str, method: &str, answer: Option<&Value>) -> Result<Value> {
        let mut body = json!({"methodID": method});
        if let Some(answer) = answer {
            body["answer"] = answer.clone();
        }
        let path = format!("/api/integration/{}/connect/oauth", segment(integration)?);
        let answered = self.login(Method::POST, &path, Some(&body)).await?.context("OpenCode started no sign-in")?;
        Ok(answered.get("data").cloned().unwrap_or(answered))
    }

    /// Where an OAuth attempt is: pending, complete, failed or expired.
    pub async fn oauth_status(&self, integration: &str, attempt: &str) -> Result<Value> {
        let path = format!("/api/integration/{}/connect/oauth/{}", segment(integration)?, segment(attempt)?);
        let answered = self.login(Method::GET, &path, None).await?.context("OpenCode said nothing of the sign-in")?;
        Ok(answered.get("data").cloned().unwrap_or(answered))
    }

    /// Completes a code-mode attempt with the code the user was given
    /// (`POST …/:attemptID/complete`). Never sent for an auto one: 2.x
    /// completes those itself.
    pub async fn oauth_complete(&self, integration: &str, attempt: &str, code: &str) -> Result<()> {
        let path = format!("/api/integration/{}/connect/oauth/{}/complete", segment(integration)?, segment(attempt)?);
        self.login(Method::POST, &path, Some(&json!({"code": code}))).await?;
        Ok(())
    }

    /// Cancels an attempt (`DELETE …/:attemptID`, 204 whatever became of it).
    pub async fn oauth_cancel(&self, integration: &str, attempt: &str) -> Result<()> {
        let path = format!("/api/integration/{}/connect/oauth/{}", segment(integration)?, segment(attempt)?);
        self.login(Method::DELETE, &path, None).await?;
        Ok(())
    }

    /// Logs a connection out (`DELETE /api/credential/:id`, 204): 2.x
    /// removes the credential from its database and makes its newest other
    /// one, if any, active.
    pub async fn delete_credential(&self, credential: &str) -> Result<()> {
        self.login(Method::DELETE, &format!("/api/credential/{}", segment(credential)?), None).await?;
        Ok(())
    }

    /// A login request: its JSON answer, or None for 204. A refusal says its
    /// status and 2.x's `kind` (or `_tag`) only: OpenCode's answer to a
    /// request that carried a key is never repeated, so nothing it echoed
    /// can reach Core's answer, record or error.
    async fn login(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Option<Value>> {
        let mut request = self.request(method, path).timeout(REQUEST_LIMIT);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| anyhow!("OpenCode did not answer the login request ({})", error.without_url()))?;
        let code = response.status();
        if code.is_success() {
            if code.as_u16() == 204 {
                return Ok(None);
            }
            return Ok(Some(response.json().await.context("OpenCode's answer to the login request is not JSON")?));
        }
        bail!(LoginRefused { code: code.as_u16(), kind: refusal_kind(response).await })
    }

    /// Adds a remote MCP server to the Agent's folder (T-61 slice 1:
    /// `PUT /api/experimental/mcp/:server`, 204), held in OpenCode's memory
    /// only (no config file), with OAuth off and its tools offered to the
    /// model as tools of their own (`codemode: false`; 2.x's default puts
    /// them behind its single `execute` tool). The same configuration again
    /// changes nothing while the server is there, a failed one included; a
    /// server OpenCode dropped with the folder is added again. 2.x answers
    /// once it has tried to connect it, except a folder's first, which may
    /// still be `pending` (2.2.5 core/src/mcp/index.ts).
    pub async fn add_mcp(&self, name: &str, url: &str, bearer: &str) -> Result<()> {
        let config = json!({"type": "remote", "url": url, "oauth": false, "codemode": false,
            "headers": {"Authorization": format!("Bearer {bearer}")},
            "timeout": {"startup": MCP_STARTUP.as_millis() as u64, "catalog": MCP_STARTUP.as_millis() as u64}});
        self.mcp_call(Method::PUT, &format!("/api/experimental/mcp/{}", segment(name)?), Some(&json!({"config": config}))).await
    }

    /// Has OpenCode connect a server it holds again (`…/connect`, 204): a
    /// failed one is not tried again by adding it unchanged.
    pub async fn connect_mcp(&self, name: &str) -> Result<()> {
        self.mcp_call(Method::POST, &format!("/api/experimental/mcp/{}/connect", segment(name)?), None).await
    }

    /// The server `name` as OpenCode lists it for the Agent's folder
    /// (`GET /api/mcp`): its status only, as 2.x lists no configuration.
    pub async fn mcp(&self, name: &str) -> Result<Mcp> {
        let listed = self.data(Method::GET, "/api/mcp", &[(LOCATION, &self.directory)], None).await?;
        let listed = listed.as_array().context("OpenCode's /api/mcp is not a list")?;
        Ok(match listed.iter().find(|server| server["name"] == name) {
            None => Mcp::Absent,
            Some(server) => match server["status"]["status"].as_str() {
                Some("connected") => Mcp::Connected,
                Some("pending") => Mcp::Pending,
                _ => Mcp::NotConnected(server["status"].clone()),
            },
        })
    }

    /// An MCP request that answers 204, naming the Agent's folder as its
    /// sessions do (`location[directory]`): 2.x keeps a server added at
    /// runtime per folder, and takes its own working directory, resolved,
    /// for a request that names none. A refusal says its status and kind
    /// only (`McpRefused`).
    async fn mcp_call(&self, method: Method, path: &str, body: Option<&Value>) -> Result<()> {
        let mut request = self.request_with(method, path, &[(LOCATION, &self.directory)]).timeout(MCP_LIMIT);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| anyhow!("OpenCode did not answer {path} ({})", error.without_url()))?;
        let code = response.status();
        if code.is_success() {
            return Ok(());
        }
        bail!(McpRefused { code: code.as_u16(), kind: refusal_kind(response).await })
    }

    /// What waits in each of `sessions`: its permission requests
    /// (`permission`) or forms (`form`), from 2.x's own list of each session
    /// (`GET /api/session/:id/<kind>`).
    async fn pending_of(&self, kind: &str, sessions: &[&str]) -> Result<Vec<Value>> {
        let mut all = Vec::new();
        for session in sessions {
            let path = format!("/api/session/{}/{kind}", segment(session)?);
            let listed = self.data(Method::GET, &path, &[], None).await?;
            all.extend(listed.as_array().with_context(|| format!("OpenCode's {path} is not a list"))?.iter().cloned());
        }
        Ok(all)
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.request_with(method, path, &[])
    }

    /// A request of `path` with `query`. 1.19.3's routes, used until their
    /// slices move them (T-32), also name the instance by the query (a
    /// folder need not be a valid header value); 2.x's under `/api` name
    /// none here: a session's folder is its own, given when it is made. The
    /// MCP ones name it in their `query` (`LOCATION`).
    fn request_with(&self, method: Method, path: &str, query: &[(&str, &str)]) -> reqwest::RequestBuilder {
        let mut url = Url::parse(&format!("{}{path}", self.base)).expect("an OpenCode path");
        url.query_pairs_mut().extend_pairs(query);
        if !path.starts_with("/api/") {
            url.query_pairs_mut().append_pair("directory", &self.directory);
        }
        self.http.request(method, url).basic_auth(USERNAME, Some(&self.password))
    }

    async fn json(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        self.json_with(method, path, &[], body).await
    }

    /// The JSON OpenCode answers. 2.x answers a GET outside `/api` with its
    /// web UI's page, 200 and HTML, whatever the path
    /// (cli/src/services/web-ui.ts): any other answer is refused as not one
    /// of its API's.
    async fn json_with(&self, method: Method, path: &str, query: &[(&str, &str)], body: Option<&Value>) -> Result<Value> {
        let mut request = self.request_with(method, path, query).timeout(REQUEST_LIMIT);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.with_context(|| format!("OpenCode did not answer {path}"))?;
        let response = success(response).await?;
        let kind = content_type(&response);
        ensure!(kind.eq_ignore_ascii_case("application/json"),
            "OpenCode answered {path} with {}, not JSON: not an answer of the OpenCode {MAJOR}.x API", shown(kind));
        response.json().await.with_context(|| format!("OpenCode's answer to {path} is not JSON"))
    }

    /// What a 2.x API answer holds (`{data, …}`).
    async fn data(&self, method: Method, path: &str, query: &[(&str, &str)], body: Option<&Value>) -> Result<Value> {
        let mut answer = self.json_with(method, path, query, body).await?;
        let data = answer.get_mut("data").with_context(|| format!("OpenCode's answer to {path} has no data"))?;
        Ok(data.take())
    }

    /// Every item of a 2.x list (`{data: […], cursor: {next}}`): the first
    /// page with `first`, each next by its cursor alone, which carries the
    /// rest (server/src/handlers/message.ts; the session list's cursor holds
    /// its filters, schema/src/session.ts), until a page shorter than PAGE.
    async fn all(&self, path: &str, first: &[(&str, &str)]) -> Result<Vec<Value>> {
        let limit = PAGE.to_string();
        let mut query: Vec<(&str, String)> = first.iter().map(|(name, value)| (*name, (*value).to_owned())).collect();
        let (mut items, mut seen) = (Vec::new(), HashSet::new());
        loop {
            query.push(("limit", limit.clone()));
            let asked: Vec<(&str, &str)> = query.iter().map(|(name, value)| (*name, value.as_str())).collect();
            let page = self.json_with(Method::GET, path, &asked, None).await?;
            let listed = page["data"].as_array().with_context(|| format!("OpenCode's {path} is not a list"))?;
            items.extend(listed.iter().cloned());
            let Some(next) = page["cursor"]["next"].as_str().filter(|_| listed.len() >= PAGE) else { return Ok(items) };
            ensure!(seen.insert(next.to_owned()), "OpenCode gave {path} the same next page twice");
            query = vec![("cursor", next.to_owned())];
        }
    }
}

/// One `Server`'s HTTP side apart from a running OpenCode (YN-78 S1): its
/// base address, password and client, so a test can put a protocol stand-in
/// where OpenCode would be. These paths are OpenCode's own and name no
/// folder query.
struct Wire<'a> {
    base: &'a str,
    password: &'a str,
    http: &'a reqwest::Client,
}

impl Wire<'_> {
    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let url = Url::parse(&format!("{}{path}", self.base)).expect("an OpenCode path");
        self.http.request(method, url).basic_auth(USERNAME, Some(self.password))
    }

    /// `GET /api/session/:sessionID/permission/:requestID`: the request while
    /// it waits, `None` for 404. A 200 is read as `{data: request}` within
    /// PERMISSION_BODY_LIMIT; any other status is an error. The whole read,
    /// body included, is within `limit` (S4b: both the delivery check and the
    /// preparation read share one absolute deadline).
    async fn pending_permission(&self, session: &str, request: &str, limit: Duration) -> Result<Option<Value>> {
        let path = format!("/api/session/{}/permission/{}", segment(session)?, segment(request)?);
        timeout(limit, async {
            let response = self.request(Method::GET, &path).send().await
                .with_context(|| format!("OpenCode did not answer {path}"))?;
            match response.status().as_u16() {
                200 => Ok(Some(data_of(response, &path).await?)),
                404 => Ok(None),
                code => Err(refusal(&path, code, response).await),
            }
        }).await.map_err(|_| anyhow!("OpenCode did not answer {path} within {limit:?}"))?
    }

    /// `GET /api/session/:sessionID/permission`: every pending request, read
    /// as `{data: [request, …]}` within PERMISSION_BODY_LIMIT, body included
    /// within `limit`.
    async fn pending_permissions(&self, session: &str, limit: Duration) -> Result<Vec<Value>> {
        let path = format!("/api/session/{}/permission", segment(session)?);
        timeout(limit, async {
            let response = self.request(Method::GET, &path).send().await
                .with_context(|| format!("OpenCode did not answer {path}"))?;
            let code = response.status().as_u16();
            if code != 200 {
                return Err(refusal(&path, code, response).await);
            }
            let data = data_of(response, &path).await?;
            Ok(data.as_array().with_context(|| format!("OpenCode's answer to {path} is not a list"))?.clone())
        }).await.map_err(|_| anyhow!("OpenCode did not answer {path} within {limit:?}"))?
    }

    /// `GET /api/session/:sessionID/message/:messageID` (YN-78 S4a, design
    /// v4 2.3.1): the one stored message a permission request's tool call is
    /// in, read as `{data: message}` within EVENT_BUFFER_LIMIT, `None` for
    /// 404; anything else is an error. The whole read, body included, is
    /// within `limit` (S4b's preparation deadline). Unlike `Server::message`
    /// it reads no inbox: only a stored answer holds a tool call. Nothing
    /// calls it but the tests yet.
    async fn session_message(&self, session: &str, message: &str, limit: Duration) -> Result<Option<Value>> {
        let path = format!("/api/session/{}/message/{}", segment(session)?, segment(message)?);
        timeout(limit, async {
            let response = self.request(Method::GET, &path).send().await
                .with_context(|| format!("OpenCode did not answer {path}"))?;
            match response.status().as_u16() {
                200 => Ok(Some(data_within(response, &path, EVENT_BUFFER_LIMIT).await?)),
                404 => Ok(None),
                code => Err(refusal(&path, code, response).await),
            }
        }).await.map_err(|_| anyhow!("OpenCode did not answer {path} within {limit:?}"))?
    }

    /// `POST …/permission/:requestID/reply`: the answer, classified as
    /// `PermissionDelivery` says. Only 204 is delivered: any other success,
    /// an unexpected status, a timeout or a lost connection is unknown. The
    /// whole request, body included, is within `limit`.
    async fn answer_permission(&self, session: &str, request: &str, reply: Reply, message: Option<&str>, limit: Duration) -> Result<PermissionDelivery> {
        let path = format!("/api/session/{}/permission/{}/reply", segment(session)?, segment(request)?);
        let mut body = json!({"decision": match reply { Reply::Once => "once", Reply::Reject => "reject" }});
        if let Some(message) = message {
            body["message"] = message.into();
        }
        let answered = timeout(limit, async {
            let response = self.request(Method::POST, &path).json(&body).send().await?;
            let code = response.status().as_u16();
            Ok::<_, reqwest::Error>(match code {
                204 => PermissionDelivery::Delivered,
                404 => PermissionDelivery::Gone { code, kind: bounded_kind(response).await },
                400 => PermissionDelivery::Invalid { message: bounded_message(response).await },
                _ => PermissionDelivery::Unknown(format!("OpenCode answered {path} with HTTP {code}")),
            })
        }).await;
        Ok(match answered {
            Ok(Ok(delivery)) => delivery,
            Ok(Err(error)) => PermissionDelivery::Unknown(format!("OpenCode did not answer {path} ({})", error.without_url())),
            Err(_) => PermissionDelivery::Unknown(format!("OpenCode did not answer {path} within {limit:?}")),
        })
    }
}

/// The read a permission request's binding makes (YN-78 S4a): one GET on
/// this server, at most REQUEST_LIMIT.
impl crate::opencode_permissions::MessageReader for Wire<'_> {
    fn message<'a>(&'a self, session: &'a str, message: &'a str)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async move { self.session_message(session, message, REQUEST_LIMIT).await })
    }

    fn message_within<'a>(&'a self, session: &'a str, message: &'a str, limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async move { self.session_message(session, message, limit).await })
    }
}

/// The same one read on the server itself (S4b's responder binds through a
/// `Server`, never through a connection it looks up again).
impl crate::opencode_permissions::MessageReader for Server {
    fn message<'a>(&'a self, session: &'a str, message: &'a str)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async move { self.wire().session_message(session, message, REQUEST_LIMIT).await })
    }

    fn message_within<'a>(&'a self, session: &'a str, message: &'a str, limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async move { self.wire().session_message(session, message, limit).await })
    }
}

/// A 200 answer's `data` (`{data, …}`), read as JSON within
/// PERMISSION_BODY_LIMIT.
async fn data_of(response: Response, path: &str) -> Result<Value> {
    data_within(response, path, PERMISSION_BODY_LIMIT).await
}

/// A 200 answer's `data`, read as JSON within `limit` bytes.
async fn data_within(response: Response, path: &str, limit: usize) -> Result<Value> {
    let kind = content_type(&response);
    ensure!(kind.eq_ignore_ascii_case("application/json"),
        "OpenCode answered {path} with {}, not JSON: not an answer of the OpenCode {MAJOR}.x API", shown(kind));
    let (body, cut) = bounded_body(response, limit).await;
    ensure!(!cut, "OpenCode's answer to {path} is longer than {limit} bytes");
    let mut answered: Value = serde_json::from_slice(&body).with_context(|| format!("OpenCode's answer to {path} is not JSON"))?;
    let data = answered.get_mut("data").with_context(|| format!("OpenCode's answer to {path} has no data"))?;
    Ok(data.take())
}

/// At most `limit` bytes of a body, and whether it was read up to that limit
/// (YN-78 S1: what Core reads to check its own answer, never a whole dump).
async fn bounded_body(mut response: Response, limit: usize) -> (Vec<u8>, bool) {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let room = limit.saturating_sub(body.len());
                body.extend_from_slice(&chunk[..room.min(chunk.len())]);
                if body.len() >= limit {
                    return (body, true);
                }
            }
            Ok(None) => return (body, false),
            Err(_) => return (body, true),
        }
    }
}

/// A refusal of a permission read: its status and name only, the body read
/// within BODY_LIMIT.
async fn refusal(path: &str, code: u16, response: Response) -> anyhow::Error {
    let (body, _) = bounded_body(response, BODY_LIMIT).await;
    let answered: Value = serde_json::from_slice(&body).unwrap_or_default();
    let kind = answered_kind(&answered).map(|kind| format!(", {kind}")).unwrap_or_default();
    anyhow!("OpenCode refused {path} (HTTP {code}{kind})")
}

/// The name of a 404's or 400's answer, within BODY_LIMIT.
async fn answered(response: Response) -> Value {
    let (body, _) = bounded_body(response, BODY_LIMIT).await;
    serde_json::from_slice(&body).unwrap_or_default()
}

async fn bounded_kind(response: Response) -> Option<String> {
    answered_kind(&answered(response).await)
}

async fn bounded_message(response: Response) -> String {
    answered(response).await["message"].as_str().unwrap_or_default().chars().take(300).collect()
}

/// 2.x's name of a refusal (`_tag`, else `name`), when it is a plain name.
fn answered_kind(answered: &Value) -> Option<String> {
    answered["_tag"].as_str().or(answered["name"].as_str()).filter(|kind| kind.len() <= 64
        && kind.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')).map(str::to_owned)
}

/// OpenCode's event stream.
pub struct Events {
    response: Response,
    buffer: Vec<u8>,
    /// Where in `buffer` the end of the next event is still to be looked for.
    scanned: usize,
    idle_limit: Duration,
}

impl Events {
    /// The next event as 2.x sends it (`{id, type, data, …}`); its heartbeat
    /// is a comment, never an event. `Ok(None)`: OpenCode ended the stream. An error: it broke,
    /// sent something that is not an event, or was silent past the idle
    /// limit. Either way events may have been missed; subscribe again, then
    /// read a snapshot.
    pub async fn next(&mut self) -> Result<Option<Value>> {
        loop {
            while let Some(data) = frame(&mut self.buffer, &mut self.scanned)? {
                let Some(data) = data else { continue };
                let event: Value = serde_json::from_str(&data).context("OpenCode sent an event that is not JSON")?;
                return Ok(Some(event));
            }
            let chunk = timeout(self.idle_limit, self.response.chunk()).await
                .map_err(|_| anyhow!("OpenCode's event stream was silent for {:?}", self.idle_limit))?
                .context("OpenCode's event stream broke")?;
            let Some(chunk) = chunk else { return Ok(None) };
            self.buffer.extend_from_slice(&chunk);
            ensure!(self.buffer.len() <= EVENT_BUFFER_LIMIT, "OpenCode sent an event larger than 16 MiB");
        }
    }
}

/// The session an event belongs to: 2.x names it as `data.sessionID`, and a
/// form's as `data.form.sessionID` (schema/src/session-event.ts, form.ts).
pub fn session_of(event: &Value) -> Option<&str> {
    event["data"]["sessionID"].as_str().or_else(|| event["data"]["form"]["sessionID"].as_str())
}

/// Where each provider in `providers` (2.x's `GET /api/provider`) gets its
/// access, by its integration's connections in `integrations` (`GET
/// /api/integration`; a provider's integration is its `integrationID`, else
/// its own ID, as 2.2.5's core/src/provider.ts finds it): `credential` for a
/// login, `env` for an environment variable OpenCode reads, else `ready`. A
/// ready one needs neither: OpenCode's config sets it up, it found a local
/// server, or its own free models (2.x makes all of them `activation:
/// enabled`, so Yuzuno does not tell them apart).
fn sources(providers: &Value, integrations: &[Value]) -> HashMap<String, &'static str> {
    providers.as_array().into_iter().flatten().filter_map(|provider| {
        let id = provider["id"].as_str()?;
        let integration = provider["integrationID"].as_str().unwrap_or(id);
        let held: Vec<&str> = integrations.iter().filter(|i| i["id"] == integration)
            .flat_map(|i| i["connections"].as_array().into_iter().flatten())
            .filter_map(|c| c["type"].as_str()).collect();
        let source = if held.contains(&"credential") { "credential" } else if held.contains(&"env") { "env" } else { "ready" };
        Some((id.to_owned(), source))
    }).collect()
}

/// `{type: busy}` for a session 2.x's `/api/session/active` lists, else
/// `{type: idle}`. Its `data` is an object keyed by session ID, each
/// `{type: "running"}` (protocol/src/groups/session.ts: `Schema.Record(Session.ID,
/// SessionActive)`; server/src/handlers/session.ts). Any other shape is
/// refused, never read as idle (R1 00fe8a2b of #590).
fn status_of(active: &Value, session: &str) -> Result<Value> {
    let listed = active.as_object().with_context(|| format!(
        "OpenCode's /api/session/active is {}, not an object keyed by session: not an answer of the OpenCode {MAJOR}.x API", kind_of(active)))?;
    match listed.get(session) {
        None => Ok(json!({"type": "idle"})),
        Some(entry) if *entry == json!({"type": "running"}) => Ok(json!({"type": "busy"})),
        Some(entry) => bail!("OpenCode's /api/session/active lists {session} as {entry}, not running: not an answer of the OpenCode {MAJOR}.x API"),
    }
}

/// What kind of JSON value this is, for a message.
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// An answer's media type, without its parameters ("" for none).
fn content_type(response: &Response) -> &str {
    let kind = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("");
    kind.split(';').next().unwrap_or("").trim()
}

fn shown(kind: &str) -> String {
    if kind.is_empty() { "no content type".into() } else { kind.into() }
}

/// Why a start failed, as far as OpenCode says (T-32): which OpenCode it is,
/// when `--version` names one not of MAJOR (or, as a note, one newer than
/// VERIFIED), and its first lines on stderr. Empty when it says neither.
async fn diagnosis(launch: &Launch, said: &[u8]) -> String {
    let mut out = String::new();
    match installed(launch).await {
        Some(version) if !supported(&version) => out.push_str(&format!(
            " (the installed OpenCode says \u{201c}{version}\u{201d}; Yuzuno speaks the server protocol of OpenCode {MAJOR}.x)")),
        Some(version) if release(&version).is_none() => out.push_str(&format!(
            " (the installed OpenCode says \u{201c}{version}\u{201d}: {})", unreadable_note())),
        Some(version) if older_than_min(&version) => out.push_str(&format!(
            " (the installed OpenCode says \u{201c}{version}\u{201d}, {})", older_note())),
        Some(version) if newer_than_verified(&version) => out.push_str(&format!(
            " (the installed OpenCode says \u{201c}{version}\u{201d}; {})", newer_note())),
        _ => {}
    }
    let lines = reason(said);
    if !lines.is_empty() {
        out.push_str(": ");
        out.push_str(&lines);
    }
    out
}

/// Whether `version` (`2.2.5`, or as `--version` prints it, `opencode
/// v2.0.16`) is one of MAJOR.
pub fn supported(version: &str) -> bool {
    let version = version.trim();
    let version = version.strip_prefix("opencode ").unwrap_or(version);
    let version = version.strip_prefix('v').unwrap_or(version);
    let mut parts = version.split('.');
    parts.next() == Some(MAJOR) && parts.next().is_some_and(|minor| !minor.is_empty() && minor.bytes().all(|b| b.is_ascii_digit()))
}

/// The major Core keeps for an Agent made by a server reporting `version`
/// (T-32): MAJOR for one it speaks, none otherwise. Core's gate and the web
/// read only this, never the version string.
pub fn major(version: &str) -> Option<String> {
    supported(version).then(|| MAJOR.to_owned())
}

/// A release as it ranks (T-32, R4 eef2b7e2): its MAJOR.MINOR.PATCH
/// (`2.2.5`, or `opencode v2.0.16` as `--version` prints it), cut at the
/// first `-` or `+`, then whether it is the release itself, as semver ranks
/// them: a pre-release (`2.0.7-rc1`) below its release, a build
/// (`2.0.7+build`) as the release. None when those three numbers cannot be
/// read.
fn release(version: &str) -> Option<(u64, u64, u64, bool)> {
    let v = version.trim();
    let v = v.strip_prefix("opencode ").unwrap_or(v);
    let v = v.strip_prefix('v').unwrap_or(v);
    let v = v.split_once('+').map_or(v, |(v, _)| v);
    let (numbers, released) = v.split_once('-').map_or((v, true), |(numbers, _)| (numbers, false));
    let mut parts = numbers.split('.').map(|part| part.parse::<u64>().ok());
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(Some(major)), Some(Some(minor)), Some(Some(patch)), None) => Some((major, minor, patch, released)),
        _ => None,
    }
}

/// Whether `version` is a release after VERIFIED (T-32): taken, and said to
/// be unverified (YN-119).
pub fn newer_than_verified(version: &str) -> bool {
    matches!((release(version), release(VERIFIED)), (Some(v), Some(w)) if v > w)
}

/// Whether an Agent can be logged in through an OpenCode of `version`
/// (T-32 slice 4b, D4): one of LOGIN_MIN or newer, ranked as `release` ranks
/// them.
pub fn login_supported(version: &str) -> bool {
    matches!((release(version), release(LOGIN_MIN)), (Some(v), Some(m)) if v >= m)
}

/// What the login says of an OpenCode older than LOGIN_MIN, naming both.
pub fn login_update_note(version: &str) -> String {
    format!("update OpenCode to log in here: this Agent runs {version}; logging in needs {LOGIN_MIN} or newer")
}

/// Whether `version` is a release before MIN (T-32): refused.
pub fn older_than_min(version: &str) -> bool {
    matches!((release(version), release(MIN)), (Some(v), Some(m)) if v < m)
}

/// What a start says of a 2.x older than MIN.
fn older_note() -> String {
    format!("older than {MIN}, the oldest Core reads; update it")
}

/// What a start says of a 2.x whose version cannot be read (`release`).
fn unreadable_note() -> String {
    format!("cannot read its version; {MIN} is the oldest Core reads")
}

/// What a start or the Agent says of a version newer than VERIFIED (YN-119):
/// it runs, but support stops at VERIFIED, and how to install that one.
pub fn newer_note() -> String {
    format!("OpenCode support stops at {VERIFIED}: this release is unverified, and problems with it are not fixed; \
        to be safe, install {VERIFIED} with npm i -g {PACKAGE}@{VERIFIED}")
}

/// The first line `<program> --version` prints, within VERSION_LIMIT: 1.x
/// prints `1.19.3`, 2.x `opencode v2.0.16`. It inherits Core's
/// environment, as the server does, with the Agent's own added
/// (`Launch::environment`); the server's username and password are not
/// given to it.
async fn installed(launch: &Launch) -> Option<String> {
    let mut command = Command::new(&launch.program);
    command.arg("--version").current_dir(&launch.directory).envs(launch.environment())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let out = timeout(VERSION_LIMIT, command.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().map(plain).find(|line| !line.is_empty()).map(|line| clipped(&line, 80))
}

/// What stderr said, for a message: its first STDERR_LINES non-empty lines,
/// plain, joined, at most REASON_CHARS characters.
fn reason(said: &[u8]) -> String {
    let text = String::from_utf8_lossy(said);
    let lines: Vec<String> = text.lines().map(plain).filter(|line| !line.is_empty()).take(STDERR_LINES).collect();
    clipped(&lines.join(" / "), REASON_CHARS)
}

/// A line without its terminal escape sequences (`ESC [ … final`) or other
/// control characters, trimmed.
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

/// `text` cut to at most `chars` characters, marked when it was cut.
fn clipped(text: &str, chars: usize) -> String {
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

/// The base URL from `server listening on http://HOST:PORT` (2.x,
/// cli/src/server-process.ts). Only 127.0.0.1, the address Core asked for,
/// is used.
fn listening(line: &str) -> Result<Option<String>> {
    ensure!(!line.trim().starts_with("opencode server listening on "),
        "OpenCode started as 1.x does, not as {MAJOR}.x");
    let Some(address) = line.trim().strip_prefix("server listening on ") else { return Ok(None) };
    let (host, port) = address.strip_prefix("http://").and_then(|a| a.rsplit_once(':'))
        .with_context(|| format!("OpenCode reported an address Yuzuno does not read: {address}"))?;
    ensure!(host == "127.0.0.1", "OpenCode listened on {host}, not on this host's loopback; it was stopped");
    let port = port.parse::<u16>().ok().filter(|p| *p > 0)
        .with_context(|| format!("OpenCode reported an invalid port: {port}"))?;
    Ok(Some(format!("http://127.0.0.1:{port}")))
}

/// Takes one complete event off the front of `buffer`: `Some(data)` (`None`
/// for an event without data, such as a comment), or nothing yet. The lines
/// before `scanned` are known not to end the event, so a large event arriving
/// in many chunks is read through once.
fn frame(buffer: &mut Vec<u8>, scanned: &mut usize) -> Result<Option<Option<String>>> {
    while let Some(end) = buffer[*scanned..].iter().position(|b| *b == b'\n').map(|i| *scanned + i) {
        let line = &buffer[*scanned..end];
        if !line.is_empty() && line != b"\r" {
            *scanned = end + 1;
            continue;
        }
        let data = data(&buffer[..*scanned])?;
        buffer.drain(..=end);
        *scanned = 0;
        return Ok(Some(data));
    }
    Ok(None)
}

/// The `data` of one event's lines. `id`, `event` and `retry` carry nothing
/// OpenCode uses; a line with an empty field is a comment.
fn data(lines: &[u8]) -> Result<Option<String>> {
    let mut data: Option<String> = None;
    for line in lines.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let line = std::str::from_utf8(line).context("OpenCode sent an event that is not UTF-8")?;
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        if field == "data" {
            let value = value.strip_prefix(' ').unwrap_or(value);
            match &mut data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => data = Some(value.into()),
            }
        }
    }
    Ok(data)
}

/// An ID OpenCode made, checked before it becomes a path segment.
fn segment(id: &str) -> Result<&str> {
    ensure!(!id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Not an OpenCode ID: {id:?}");
    Ok(id)
}

/// The kind (`kind`, else `_tag`) of a refusal, when it is a plain name: the
/// rest of OpenCode's answer is never kept.
async fn refusal_kind(response: Response) -> Option<String> {
    let answered: Value = response.json().await.unwrap_or_default();
    answered["kind"].as_str().or(answered["_tag"].as_str()).filter(|kind| kind.len() <= 64
        && kind.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')).map(str::to_owned)
}

async fn success(response: Response) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    Err(status(response).await.into())
}

/// Whether a stage's answer is one 2.x gives only before it changes any
/// file of the Agent's (T-61 slice 6), its status and whole body together,
/// as its own API declares them (protocol/src/errors.ts): 409
/// `SessionBusyError` of `session` itself (core/src/session/session.ts, the
/// stage's busy guard); 404 `SessionNotFoundError`, `LocationNotFoundError`,
/// or `MessageNotFoundError` of the message `asked` (that one comes after a
/// capture, which writes into the snapshot store only); 400
/// `InvalidRequestError` of a parameter, header, query or payload that could
/// not be decoded, before the handler runs. Not one of kind `Body`: before
/// 2.2.0 2.x answered so when it could not encode its own response, after
/// the handler ran. Nor any other answer: a 401, a 500, any other body for
/// those statuses, or one cut short.
fn refused_before(status: &HttpStatus, session: &str, asked: &str) -> bool {
    let Ok(body) = serde_json::from_str::<Value>(&status.body) else { return false };
    let text = |value: &Value| value.is_string();
    match status.code {
        409 => body["_tag"] == "SessionBusyError" && body["sessionID"] == session && text(&body["message"]),
        404 => text(&body["message"]) && match body["_tag"].as_str() {
            Some("SessionNotFoundError") => body["sessionID"] == session,
            Some("MessageNotFoundError") => body["sessionID"] == session && body["messageID"] == asked,
            Some("LocationNotFoundError") => true,
            _ => false,
        },
        400 => body["_tag"] == "InvalidRequestError" && text(&body["message"])
            && matches!(body["kind"].as_str(), Some("Params" | "Headers" | "Query" | "Payload")),
        _ => false,
    }
}

async fn status(response: Response) -> HttpStatus {
    let code = response.status().as_u16();
    let mut body = response.text().await.unwrap_or_default();
    if body.len() > BODY_LIMIT {
        let mut end = BODY_LIMIT;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
        body.push('…');
    }
    HttpStatus { code, body }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A provider's access comes from its integration's connections, found
    /// by its `integrationID` or else its own ID (YN-47): a login before an
    /// environment variable, and neither is `ready`. Nothing else of either
    /// answer is read.
    #[test]
    fn a_providers_source_is_its_integrations_connection() {
        let providers = json!([
            {"id": "deepseek", "name": "DeepSeek", "activation": "auto", "settings": {"apiKey": "fixture-secret"}},
            {"id": "openrouter", "name": "OpenRouter", "activation": "auto"},
            {"id": "copilot-chat", "integrationID": "github-copilot", "name": "Copilot", "activation": "auto"},
            {"id": "lmstudio", "name": "LMStudio", "activation": "enabled"},
            {"id": "opencode", "name": "OpenCode", "activation": "enabled"},
            {"name": "no id"},
        ]);
        let integrations = [
            json!({"id": "deepseek", "connections": [{"type": "env", "name": "DEEPSEEK_API_KEY"}, {"type": "credential", "id": "crd_1"}]}),
            json!({"id": "openrouter", "connections": [{"type": "env", "name": "OPENROUTER_API_KEY"}], "metadata": {"token": "fixture-secret"}}),
            json!({"id": "github-copilot", "connections": [{"type": "credential", "id": "crd_2"}]}),
            json!({"id": "copilot-chat", "connections": []}),
            json!({"id": "lmstudio"}),
        ];
        let found = sources(&providers, &integrations);
        assert_eq!(found, HashMap::from([
            ("deepseek".to_owned(), "credential"), ("openrouter".to_owned(), "env"), ("copilot-chat".to_owned(), "credential"),
            ("lmstudio".to_owned(), "ready"), ("opencode".to_owned(), "ready"),
        ]));
        assert!(sources(&json!({"not": "a list"}), &integrations).is_empty());
    }

    /// Only 2.x's own refusals before a stage changes any file count as
    /// refused (T-61 slice 6, R2-2): busy for this session, a session,
    /// location or asked message 2.x does not hold, a request it could not
    /// read. 1.19.3's bodies, another session's or message's, a `Body` 400,
    /// any other status, or a body cut short say nothing of what it did.
    #[test]
    fn only_opencodes_own_refusals_before_a_revert_count_as_refused() {
        let refused = |code: u16, body: Value| refused_before(&HttpStatus { code, body: body.to_string() }, "ses_1", "msg_1");
        for (code, body) in [
            (409, json!({"_tag": "SessionBusyError", "sessionID": "ses_1", "message": "Session is busy: ses_1"})),
            (404, json!({"_tag": "SessionNotFoundError", "sessionID": "ses_1", "message": "Session not found: ses_1"})),
            (404, json!({"_tag": "MessageNotFoundError", "sessionID": "ses_1", "messageID": "msg_1", "message": "Message not found: msg_1"})),
            (404, json!({"_tag": "LocationNotFoundError", "message": "Location not found"})),
            (400, json!({"_tag": "InvalidRequestError", "kind": "Payload", "message": "Expected string"})),
            (400, json!({"_tag": "InvalidRequestError", "kind": "Headers", "message": "no"})),
        ] {
            assert!(refused(code, body.clone()), "refused before anything: {code} {body}");
        }
        for (code, body) in [
            (409, json!({"_tag": "SessionBusyError", "sessionID": "ses_2", "message": "Session is busy: ses_2"})),
            (409, json!({"_tag": "ConflictError", "message": "conflict"})),
            (404, json!({"_tag": "MessageNotFoundError", "sessionID": "ses_1", "messageID": "msg_2", "message": "Message not found: msg_2"})),
            (404, json!({"_tag": "SessionNotFoundError", "sessionID": "ses_2", "message": "gone"})),
            (404, json!({"name": "NotFoundError", "data": {"message": "Session not found: ses_1"}})),
            (400, json!({"_tag": "InvalidRequestError", "kind": "Body", "message": "the response could not be encoded"})),
            (400, json!({"name": "BadRequest", "data": {"message": "Expected string", "kind": "Payload"}})),
            (401, json!({"_tag": "UnauthorizedError", "message": "no"})),
            (500, json!({"_tag": "UnknownError", "message": "no", "ref": "err_1"})),
        ] {
            assert!(!refused(code, body.clone()), "says nothing of what it did: {code} {body}");
        }
        assert!(!refused_before(&HttpStatus { code: 409, body: "{\"_tag\":\"SessionBusyError\",\"sessionID\":\"ses_1\",…".into() }, "ses_1", "msg_1"), "cut short");
    }

    #[test]
    fn only_a_loopback_listening_line_gives_an_address() {
        assert_eq!(listening("server listening on http://127.0.0.1:4096").unwrap().as_deref(), Some("http://127.0.0.1:4096"));
        assert!(listening("opencode server listening on http://127.0.0.1:4096").unwrap_err().to_string().contains("as 1.x does"),
            "1.x's line is refused, not waited past");
        assert_eq!(listening("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.").unwrap(), None);
        for line in ["server listening on http://0.0.0.0:4096", "server listening on http://[::1]:4096",
            "server listening on http://127.0.0.1:0", "server listening on https://127.0.0.1:4096",
            "server listening on http://127.0.0.1.example:4096"] {
            assert!(listening(line).is_err(), "{line}");
        }
    }

    #[test]
    fn only_a_release_after_the_verified_one_is_newer() {
        for version in ["2.2.6", "2.3.0", "2.10.0", "3.0.0", "opencode v2.2.6", "v2.3.0"] {
            assert!(newer_than_verified(version), "{version}");
        }
        for version in ["2.2.5", "2.2.4", "2.0.16", "1.19.3", "opencode v2.2.5", "2.x", ""] {
            assert!(!newer_than_verified(version), "{version}");
        }
    }

    /// 2.x's active list is read only in its own shape: an object keyed by
    /// session ID, each `{type: "running"}` (R1 00fe8a2b of #590).
    #[test]
    fn the_active_list_is_read_only_in_its_own_shape() {
        assert_eq!(status_of(&json!({"ses_a": {"type": "running"}}), "ses_a").unwrap(), json!({"type": "busy"}));
        assert_eq!(status_of(&json!({"ses_b": {"type": "running"}}), "ses_a").unwrap(), json!({"type": "idle"}));
        assert_eq!(status_of(&json!({}), "ses_a").unwrap(), json!({"type": "idle"}));
        for other in [json!([{"id": "ses_a", "type": "running"}]), json!([]), json!(null), json!("ses_a"), json!({"ses_a": {"type": "starting"}})] {
            assert!(status_of(&other, "ses_a").is_err(), "{other} is refused, never read as idle");
        }
    }

    #[test]
    fn any_release_of_the_major_is_supported_and_no_other() {
        for version in ["2.2.5", "2.0.16", "2.10.0", "v2.3.1", "opencode v2.0.16", " 2.2.5 "] {
            assert!(supported(version), "{version}");
        }
        for version in ["1.19.3", "opencode v1.19.3", "3.0.0", "2", "2.", "2.x", "20.1.0", "", "opencode"] {
            assert!(!supported(version), "{version}");
        }
    }

    #[test]
    fn events_are_framed_across_chunks_lines_and_comments() {
        let mut scanned = 0;
        let mut buffer = b": hello\r\n\r\ndata: {\"type\":\"a\"}\n\nda".to_vec();
        assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), Some(None));
        assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), Some(Some("{\"type\":\"a\"}".into())));
        assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), None, "an unfinished event waits");
        for chunk in [&b"ta: one\nda"[..], b"ta:two\r", b"\nid: 7\nevent: message\n", b"\n"] {
            assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), None);
            buffer.extend_from_slice(chunk);
        }
        assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), Some(Some("one\ntwo".into())));
        assert!(buffer.is_empty() && scanned == 0);
        let mut broken = b"data: \xff\n\n".to_vec();
        assert!(frame(&mut broken, &mut 0).is_err());
    }

    #[test]
    fn message_ids_have_opencodes_form_and_do_not_repeat() {
        let ids: Vec<MessageId> = (0..5000).map(|_| MessageId::new()).collect();
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len());
        for id in &ids[..50] {
            assert_eq!(MessageId::parse(id.as_str()).unwrap(), *id);
        }
        for bad in ["msg_", "ses_0123456789abABCDEFGHIJKLMN", "msg_0123456789aBABCDEFGHIJKLMN", "msg_0123456789abABCDEFGHIJKL-N",
            "msg_0123456789abABCDEFGHIJ\u{e9}N"] {
            assert!(MessageId::parse(bad).is_err(), "{bad}");
        }
    }

    /// The stand-in OpenCode in `dir`, started with these switches (see the
    /// fixture). Its PIDs: itself and the children in its group.
    #[cfg(target_os = "linux")]
    async fn stand_in(dir: &std::path::Path, switches: &[&str]) -> (Server, Vec<u64>) {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("opencode");
        let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");
        std::fs::write(&program, format!("#!/bin/sh\nexec /usr/bin/python3 {fixture} \"$@\"\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (directory, root) = (dir.join("work"), dir.join("db"));
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(&root).unwrap();
        for switch in switches {
            let (name, value) = switch.split_once('=').unwrap_or((switch, "1"));
            std::fs::write(root.join(name), value).unwrap();
        }
        let server = Server::start(&Launch::new(program, directory, &root, dir.join("cache"))).await.unwrap();
        let seen: Value = serde_json::from_str(&std::fs::read_to_string(root.join("start.json")).unwrap()).unwrap();
        let pids = ["pid", "child", "stubborn"].iter().filter_map(|key| seen[key].as_u64()).collect();
        (server, pids)
    }

    /// Whether every one of `pids` ends (or is a zombie) within `limit`.
    #[cfg(target_os = "linux")]
    async fn all_end(pids: &[u64], limit: Duration) -> bool {
        let ended = |pid: &u64| std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map_or(true, |stat| stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')));
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if pids.iter().all(ended) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        pids.iter().all(ended)
    }

    /// As if Core ended without dropping `Server`: only its end of the pipe
    /// closes, and OpenCode's whole group ends anyway, even what ignores
    /// SIGTERM (after TEARDOWN, by SIGKILL).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn closing_cores_end_of_the_pipe_ends_opencodes_group() {
        for stubborn in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (mut server, pids) = stand_in(dir.path(), if stubborn { &["stubborn"] } else { &[] }).await;
            assert_eq!(pids.len(), if stubborn { 3 } else { 2 });
            drop(server.child.stdin.take());
            assert!(all_end(&pids, TEARDOWN + Duration::from_secs(5)).await, "stubborn {stubborn}: OpenCode outlived the pipe: {pids:?}");
        }
    }

    /// `shutdown` and dropping end a group that ignores SIGTERM too.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn shutdown_and_drop_end_a_group_that_ignores_term() {
        let dir = tempfile::tempdir().unwrap();
        let (server, pids) = stand_in(dir.path(), &["stubborn"]).await;
        server.shutdown().await.unwrap();
        assert!(all_end(&pids, Duration::from_secs(5)).await, "after shutdown: {pids:?}");
        let dir = tempfile::tempdir().unwrap();
        let (server, pids) = stand_in(dir.path(), &["stubborn"]).await;
        drop(server);
        assert!(all_end(&pids, Duration::from_secs(5)).await, "after drop: {pids:?}");
    }

    /// The process a tool of the stand-in runs, in a session of its own.
    #[cfg(target_os = "linux")]
    fn tool_pid(dir: &std::path::Path) -> u64 {
        let seen: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("db/start.json")).unwrap()).unwrap();
        seen["tool"].as_u64().unwrap()
    }

    #[cfg(target_os = "linux")]
    fn calls(dir: &std::path::Path, path: &str) -> Vec<Value> {
        std::fs::read_to_string(dir.join("db/calls.jsonl")).unwrap_or_default().lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()).filter(|c| c["path"] == path).collect()
    }

    /// What OpenCode's tools run is out of its group: `shutdown` lets 2.x
    /// tear down after SIGTERM, which ends it, while dropping the `Server`
    /// (as a killed Core would) ends only the group. Nothing is asked over
    /// HTTP to stop: 2.x has no `/global/dispose`.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn only_shutdown_ends_what_opencodes_tools_run() {
        let dir = tempfile::tempdir().unwrap();
        let (server, pids) = stand_in(dir.path(), &["tool"]).await;
        let tool = tool_pid(dir.path());
        server.shutdown().await.unwrap();
        assert!(all_end(&[tool], Duration::from_secs(1)).await, "the tool's process outlived shutdown");
        assert!(all_end(&pids, Duration::from_secs(5)).await, "after shutdown: {pids:?}");
        assert!(calls(dir.path(), "/global/dispose").is_empty(), "no dispose");

        let dir = tempfile::tempdir().unwrap();
        let (server, pids) = stand_in(dir.path(), &["tool"]).await;
        let tool = tool_pid(dir.path());
        drop(server);
        assert!(all_end(&pids, Duration::from_secs(5)).await, "after drop: {pids:?}");
        let ran_on = !all_end(&[tool], Duration::from_millis(500)).await;
        let _ = rustix::process::kill_process_group(rustix::process::Pid::from_raw(tool as i32).unwrap(), rustix::process::Signal::KILL);
        assert!(ran_on, "dropping skips the teardown; if this changed, so did what the module says");
    }

    /// A teardown that takes a while is waited for, and what its tools run
    /// ends with it; one that does not end is cut short at TEARDOWN.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn shutdown_waits_for_a_slow_teardown_and_cuts_a_stuck_one_short() {
        for (teardown, ends_itself) in [(5, true), (60, false)] {
            let dir = tempfile::tempdir().unwrap();
            let (server, pids) = stand_in(dir.path(), &["tool", &format!("teardown={teardown}")]).await;
            let tool = tool_pid(dir.path());
            let started = Instant::now();
            server.shutdown().await.unwrap();
            let took = started.elapsed();
            assert!(all_end(&pids, Duration::from_secs(1)).await, "teardown {teardown}: {pids:?}");
            if ends_itself {
                assert!(took >= Duration::from_secs(teardown) && took < TEARDOWN, "teardown {teardown}: waited {took:?}");
                assert!(all_end(&[tool], Duration::from_secs(1)).await, "teardown {teardown}: the tool's process ran on");
            } else {
                assert!(took >= TEARDOWN && took < TEARDOWN + Duration::from_secs(2), "teardown {teardown}: waited {took:?}");
                let _ = rustix::process::kill_process_group(rustix::process::Pid::from_raw(tool as i32).unwrap(), rustix::process::Signal::KILL);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_watcher_waits_what_shutdown_waits() {
        assert!(WATCHED.contains(&format!("sleep {}; kill -KILL 0", TEARDOWN.as_secs())));
    }

    #[test]
    fn only_plain_ids_become_path_segments() {
        assert!(segment("ses_01J9ZABC-x").is_ok());
        for bad in ["", "../config", "a/b", "per_1?x=1", "ses 1"] {
            assert!(segment(bad).is_err(), "{bad:?}");
        }
    }

    /// One request as a protocol stand-in saw it (YN-78 S1).
    #[derive(Clone, Debug)]
    struct Asked {
        method: String,
        path: String,
        authorization: Option<String>,
        body: Value,
    }

    /// What the stand-in answers one request with.
    struct Answered {
        status: u16,
        content_type: &'static str,
        body: String,
        delay: Duration,
    }

    /// A protocol stand-in at a loopback address: one HTTP/1.1 request per
    /// connection, recorded, answered by `answer`. It is not OpenCode; it is
    /// the wire S1's calls are checked against.
    struct Protocol {
        base: String,
        seen: Arc<Mutex<Vec<Asked>>>,
    }

    impl Protocol {
        async fn start(answer: impl Fn(&Asked) -> Answered + Send + Sync + 'static) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let seen = Arc::new(Mutex::new(Vec::new()));
            let answer: Arc<dyn Fn(&Asked) -> Answered + Send + Sync> = Arc::new(answer);
            let recorded = seen.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else { return };
                    let (recorded, answer) = (recorded.clone(), answer.clone());
                    tokio::spawn(async move { serve(socket, recorded, answer).await });
                }
            });
            Self { base, seen }
        }

        fn asked(&self) -> Vec<Asked> {
            self.seen.lock().unwrap().clone()
        }

        fn wire<'a>(&'a self, http: &'a reqwest::Client) -> Wire<'a> {
            Wire { base: &self.base, password: "fixture-password", http }
        }
    }

    async fn serve(mut socket: tokio::net::TcpStream, seen: Arc<Mutex<Vec<Asked>>>, answer: Arc<dyn Fn(&Asked) -> Answered + Send + Sync>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let head_end = loop {
            if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break end + 4;
            }
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            }
        };
        let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
        let mut lines = head.split("\r\n");
        let mut request = lines.next().unwrap_or_default().split(' ');
        let method = request.next().unwrap_or_default().to_owned();
        let path = request.next().unwrap_or_default().split('?').next().unwrap_or_default().to_owned();
        let (mut authorization, mut length) = (None, 0usize);
        for line in lines {
            let Some((name, value)) = line.split_once(':') else { continue };
            if name.eq_ignore_ascii_case("authorization") {
                authorization = Some(value.trim().to_owned());
            }
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
        let mut body = buffer[head_end..].to_vec();
        while body.len() < length {
            match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => body.extend_from_slice(&chunk[..read]),
            }
        }
        let asked = Asked { method, path, authorization, body: serde_json::from_slice(&body).unwrap_or(Value::Null) };
        let answered = answer(&asked);
        seen.lock().unwrap().push(asked);
        if !answered.delay.is_zero() {
            tokio::time::sleep(answered.delay).await;
        }
        let mut response = format!("HTTP/1.1 {} Status\r\ncontent-type: {}\r\nconnection: close\r\n",
            answered.status, answered.content_type);
        if answered.status != 204 {
            response.push_str(&format!("content-length: {}\r\n", answered.body.len()));
        }
        response.push_str("\r\n");
        response.push_str(&answered.body);
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
    }

    fn json_answer(status: u16, body: Value) -> Answered {
        Answered { status, content_type: "application/json", body: body.to_string(), delay: Duration::ZERO }
    }

    fn empty_answer(status: u16) -> Answered {
        Answered { status, content_type: "text/plain", body: String::new(), delay: Duration::ZERO }
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    /// The answer keeps 2.x's payload: `{decision}` alone for the manual
    /// answers, with `message` only when one is given (YN-78 S1). The path,
    /// method and Basic authentication are as 2.x's permission route takes
    /// them, and an ID that is not a path segment is refused before any
    /// request.
    #[tokio::test]
    async fn permission_answers_carry_a_message_only_when_given() {
        use base64::Engine as _;
        let protocol = Protocol::start(|_| empty_answer(204)).await;
        let client = client();
        let wire = protocol.wire(&client);

        assert_eq!(wire.answer_permission("ses_a", "per_1", Reply::Once, None, REQUEST_LIMIT).await.unwrap(),
            PermissionDelivery::Delivered);
        assert_eq!(wire.answer_permission("ses_a", "per_1", Reply::Reject, None, REQUEST_LIMIT).await.unwrap(),
            PermissionDelivery::Delivered);
        assert_eq!(wire.answer_permission("ses_a", "per_1", Reply::Reject, Some("use $TMPDIR"), REQUEST_LIMIT).await.unwrap(),
            PermissionDelivery::Delivered);

        let asked = protocol.asked();
        assert_eq!(asked.len(), 3);
        assert!(asked.iter().all(|asked| asked.method == "POST" && asked.path == "/api/session/ses_a/permission/per_1/reply"));
        assert_eq!(asked[0].body, json!({"decision": "once"}), "no message key when none is given");
        assert_eq!(asked[1].body, json!({"decision": "reject"}), "the manual reject is unchanged: no reason");
        assert_eq!(asked[2].body, json!({"decision": "reject", "message": "use $TMPDIR"}));
        let basic = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("opencode:fixture-password"));
        assert!(asked.iter().all(|asked| asked.authorization.as_deref() == Some(basic.as_str())), "Basic authentication");

        assert!(wire.answer_permission("ses_a", "../config", Reply::Once, None, REQUEST_LIMIT).await.is_err());
        assert!(wire.answer_permission("ses/a", "per_1", Reply::Once, None, REQUEST_LIMIT).await.is_err());
        assert!(wire.pending_permission("ses_a", "per_1?x=1", REQUEST_LIMIT).await.is_err());
        assert_eq!(protocol.asked().len(), 3, "nothing is sent for an ID that is not a path segment");
    }

    /// S4b's explicit deadlines: a POST whose answer is late is unknown, and
    /// a check read that is late is an error, both within the given bound.
    #[tokio::test(start_paused = true)]
    async fn permission_calls_use_the_explicit_deadline() {
        let protocol = Protocol::start(|_| Answered { status: 204, content_type: "text/plain", body: String::new(),
            delay: Duration::from_secs(20) }).await;
        let client = client();
        let wire = protocol.wire(&client);
        let delivery = wire.answer_permission("ses_a", "per_1", Reply::Once, None, Duration::from_secs(1)).await.unwrap();
        assert!(matches!(delivery, PermissionDelivery::Unknown(reason) if reason.contains("within")), "the POST is bounded");
        let read = wire.pending_permission("ses_a", "per_1", Duration::from_secs(1)).await;
        assert!(read.unwrap_err().to_string().contains("within"), "the check read is bounded too");
        let message = wire.session_message("ses_a", "msg_1", Duration::from_secs(1)).await;
        assert!(message.unwrap_err().to_string().contains("within"), "the message read is bounded too");
    }

    /// The reads name the session and return 2.x's `data`, the single one
    /// `None` for 404; a 200 is read only as bounded JSON of its own shape
    /// (YN-78 S1).
    #[tokio::test]
    async fn permission_reads_return_their_data_within_their_shape() {
        let protocol = Protocol::start(|asked: &Asked| {
            let path = asked.path.as_str();
            if path.ends_with("/permission/per_1") {
                json_answer(200, json!({"data": {"id": "per_1", "sessionID": "ses_a", "action": "read"}}))
            } else if path.ends_with("/permission/per_2") {
                empty_answer(404)
            } else if path.ends_with("/permission/html") {
                Answered { status: 200, content_type: "text/html", body: "not json".into(), delay: Duration::ZERO }
            } else if path.ends_with("/permission/shape") {
                json_answer(200, json!({"rows": []}))
            } else if path.ends_with("/permission/huge") {
                json_answer(200, json!({"data": {"id": "x".repeat(PERMISSION_BODY_LIMIT)}}))
            } else if path == "/api/session/ses_a/permission" {
                json_answer(200, json!({"data": [{"id": "per_1"}, {"id": "per_2"}]}))
            } else if path == "/api/session/ses_b/permission" {
                json_answer(200, json!({"data": {"id": "per_1"}}))
            } else if path == "/api/session/ses_c/permission" {
                json_answer(500, json!({"message": "no"}))
            } else {
                empty_answer(404)
            }
        }).await;
        let client = client();
        let wire = protocol.wire(&client);

        assert_eq!(wire.pending_permission("ses_a", "per_1", REQUEST_LIMIT).await.unwrap(),
            Some(json!({"id": "per_1", "sessionID": "ses_a", "action": "read"})));
        assert_eq!(wire.pending_permission("ses_a", "per_2", REQUEST_LIMIT).await.unwrap(), None, "404 is gone");
        assert_eq!(wire.pending_permissions("ses_a", REQUEST_LIMIT).await.unwrap(),
            vec![json!({"id": "per_1"}), json!({"id": "per_2"})]);
        assert!(wire.pending_permission("ses_a", "html", REQUEST_LIMIT).await.unwrap_err().to_string().contains("not JSON"));
        assert!(wire.pending_permission("ses_a", "shape", REQUEST_LIMIT).await.unwrap_err().to_string().contains("has no data"));
        assert!(wire.pending_permissions("ses_b", REQUEST_LIMIT).await.unwrap_err().to_string().contains("not a list"));
        assert!(wire.pending_permissions("ses_c", REQUEST_LIMIT).await.unwrap_err().to_string().contains("HTTP 500"));
        assert!(wire.pending_permission("ses_a", "huge", REQUEST_LIMIT).await.unwrap_err().to_string().contains("longer than"));

        let asked = protocol.asked();
        assert!(asked.iter().all(|asked| asked.method == "GET"));
        assert_eq!(asked[0].path, "/api/session/ses_a/permission/per_1");
        assert_eq!(asked[1].path, "/api/session/ses_a/permission/per_2");
        assert_eq!(asked[2].path, "/api/session/ses_a/permission");
        assert_eq!(asked[5].path, "/api/session/ses_b/permission");
        assert_eq!(asked[6].path, "/api/session/ses_c/permission");
    }

    /// Only 204 is delivered: 404 is gone, 400 is refused, and every other
    /// status, a timeout and a lost connection are unknown, never success
    /// (YN-78 S1).
    #[tokio::test]
    async fn permission_delivery_separates_gone_refused_and_unknown() {
        let answers: Arc<Mutex<Vec<Answered>>> = Arc::new(Mutex::new(vec![
            json_answer(404, json!({"_tag": "PermissionNotFoundError", "requestID": "per_1"})),
            json_answer(400, json!({"_tag": "InvalidRequestError", "message": "Invalid decision: always"})),
            json_answer(200, json!({"ok": true})),
            json_answer(201, json!({"ok": true})),
            json_answer(401, json!({"_tag": "UnauthorizedError"})),
            json_answer(500, json!({"_tag": "UnknownError"})),
        ]));
        let protocol = Protocol::start(move |_| answers.lock().unwrap().remove(0)).await;
        let client = client();
        let wire = protocol.wire(&client);

        assert_eq!(wire.answer_permission("ses_a", "per_1", Reply::Once, None, REQUEST_LIMIT).await.unwrap(),
            PermissionDelivery::Gone { code: 404, kind: Some("PermissionNotFoundError".into()) });
        assert_eq!(wire.answer_permission("ses_a", "per_1", Reply::Once, None, REQUEST_LIMIT).await.unwrap(),
            PermissionDelivery::Invalid { message: "Invalid decision: always".into() });
        for _ in 0..4 {
            let delivery = wire.answer_permission("ses_a", "per_1", Reply::Once, None, REQUEST_LIMIT).await.unwrap();
            assert!(matches!(delivery, PermissionDelivery::Unknown(_)), "another status is never success: {delivery:?}");
        }

        // A timeout at the answer, and a connection that is not there.
        let slow = Protocol::start(|_| Answered { status: 204, content_type: "text/plain", body: String::new(), delay: Duration::from_secs(5) }).await;
        let unknown = slow.wire(&client).answer_permission("ses_a", "per_1", Reply::Once, None, Duration::from_millis(100)).await.unwrap();
        assert!(matches!(unknown, PermissionDelivery::Unknown(ref why) if why.contains("did not answer")), "{unknown:?}");
        let port = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let lost = Wire { base: &format!("http://127.0.0.1:{port}"), password: "fixture-password", http: &client };
        let unknown = lost.answer_permission("ses_a", "per_1", Reply::Once, None, Duration::from_millis(500)).await.unwrap();
        assert!(matches!(unknown, PermissionDelivery::Unknown(_)), "a lost connection is unknown: {unknown:?}");
    }

    /// The read a binding makes (YN-78 S4a): one GET of the stored message,
    /// by its session and ID as path segments, with Basic authentication; a
    /// 200 is read only as bounded JSON with `data`, 404 is none, and any
    /// other answer is an error.
    #[tokio::test]
    async fn a_stored_message_is_read_once_within_its_bound() {
        let protocol = Protocol::start(|asked: &Asked| match asked.path.as_str() {
            "/api/session/ses_a/message/msg_1" => json_answer(200, json!({"data": {"id": "msg_1", "type": "assistant", "content": []}})),
            "/api/session/ses_a/message/msg_html" => Answered { status: 200, content_type: "text/html", body: "<p>".into(), delay: Duration::ZERO },
            "/api/session/ses_a/message/msg_shape" => json_answer(200, json!({"rows": []})),
            "/api/session/ses_a/message/msg_huge" => json_answer(200, json!({"data": {"id": "x".repeat(EVENT_BUFFER_LIMIT)}})),
            "/api/session/ses_a/message/msg_500" => json_answer(500, json!({"_tag": "UnknownError"})),
            _ => empty_answer(404),
        }).await;
        let client = client();
        let wire = protocol.wire(&client);

        assert_eq!(wire.session_message("ses_a", "msg_1", REQUEST_LIMIT).await.unwrap(),
            Some(json!({"id": "msg_1", "type": "assistant", "content": []})));
        assert_eq!(wire.session_message("ses_a", "msg_gone", REQUEST_LIMIT).await.unwrap(), None, "404 is no message");
        assert!(wire.session_message("ses_a", "msg_html", REQUEST_LIMIT).await.unwrap_err().to_string().contains("not JSON"));
        assert!(wire.session_message("ses_a", "msg_shape", REQUEST_LIMIT).await.unwrap_err().to_string().contains("has no data"));
        assert!(wire.session_message("ses_a", "msg_huge", REQUEST_LIMIT).await.unwrap_err().to_string().contains("longer than"));
        assert!(wire.session_message("ses_a", "msg_500", REQUEST_LIMIT).await.unwrap_err().to_string().contains("HTTP 500"));
        assert!(wire.session_message("ses_a", "../msg_1", REQUEST_LIMIT).await.is_err());
        assert!(wire.session_message("ses/a", "msg_1", REQUEST_LIMIT).await.is_err());

        use base64::Engine as _;
        let basic = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode("opencode:fixture-password"));
        let asked = protocol.asked();
        assert_eq!(asked.len(), 6, "nothing is sent for an ID that is not a path segment");
        assert!(asked.iter().all(|asked| asked.method == "GET" && asked.authorization.as_deref() == Some(basic.as_str())));
        assert_eq!(asked[0].path, "/api/session/ses_a/message/msg_1");
    }

    /// A request binds to a call OpenCode reported on the connection with no
    /// read; one of a sub-agent's session, or of a call not seen, with one
    /// read of its message, after which the call is known (YN-78 S4a,
    /// design v4 2.3.1). Nothing is answered.
    #[tokio::test]
    async fn a_request_binds_with_at_most_one_read_of_its_message() {
        use crate::opencode_permissions as permissions;
        let tool = |id: &str, input: Value| json!({"type": "tool", "id": id, "name": "read", "state": {"status": "running", "input": input, "metadata": {}}});
        let protocol = Protocol::start(move |asked: &Asked| match asked.path.as_str() {
            "/api/session/ses_child/message/msg_c" =>
                json_answer(200, json!({"data": {"id": "msg_c", "type": "assistant", "content": [tool("call_c", json!({"path": "/x"}))]}})),
            "/api/session/ses_main/message/msg_m" =>
                json_answer(200, json!({"data": {"id": "msg_m", "type": "assistant", "content": [tool("call_2", json!({"path": "/y"}))]}})),
            _ => empty_answer(404),
        }).await;
        let client = client();
        let wire = protocol.wire(&client);
        let calls = permissions::Calls::default();
        let children = vec!["ses_child".to_owned()];
        let on = permissions::Connection { generation: 7, session: "ses_main", children: &children };
        let current = || true;
        let asked = |session: &str, message: &str, call: &str| permissions::Asked::read(&json!({"id": "per_1", "sessionID": session,
            "action": "external_directory", "resources": ["/*"], "source": {"type": "tool", "messageID": message, "id": call}})).unwrap();
        let event = |kind: &str, data: Value| {
            let mut data = data;
            data.as_object_mut().unwrap().extend([("sessionID".to_owned(), json!("ses_main")),
                ("assistantMessageID".to_owned(), json!("msg_m")), ("id".to_owned(), json!("call_1"))]);
            json!({"type": kind, "data": data})
        };
        calls.ingest_event(7, &event("session.tool.input.started", json!({"name": "read"})));
        calls.ingest_event(7, &event("session.tool.called", json!({"input": {"path": "/z"}})));

        let main = permissions::bind(&asked("ses_main", "msg_m", "call_1"), &on, &calls, &wire, &current).await.unwrap();
        assert_eq!((main.tool, &main.input, main.read), (permissions::Tool::Read, &json!({"path": "/z"}), false));
        assert!(protocol.asked().is_empty(), "a call seen on the connection takes no read");

        let child = permissions::bind(&asked("ses_child", "msg_c", "call_c"), &on, &calls, &wire, &current).await.unwrap();
        assert_eq!((&child.session, &child.input, child.read), (&"ses_child".to_owned(), &json!({"path": "/x"}), true));
        assert_eq!(protocol.asked().len(), 1, "a sub-agent's call takes one read");
        let again = permissions::bind(&asked("ses_child", "msg_c", "call_c"), &on, &calls, &wire, &current).await.unwrap();
        assert!(!again.read, "the read is kept as that generation's evidence");

        let unseen = permissions::bind(&asked("ses_main", "msg_m", "call_2"), &on, &calls, &wire, &current).await.unwrap();
        assert_eq!((&unseen.input, unseen.read), (&json!({"path": "/y"}), true));
        let gone = permissions::bind(&asked("ses_main", "msg_other", "call_3"), &on, &calls, &wire, &current).await;
        assert_eq!(gone, Err(permissions::Unbound::Gone));
        let asked = protocol.asked();
        assert_eq!(asked.iter().map(|asked| asked.path.as_str()).collect::<Vec<_>>(),
            ["/api/session/ses_child/message/msg_c", "/api/session/ses_main/message/msg_m", "/api/session/ses_main/message/msg_other"],
            "one read for each call not seen, and no other request: nothing is answered");
        assert!(asked.iter().all(|asked| asked.method == "GET"));
    }

    /// S4b's teardown of a captured runtime: with another Arc still held, a
    /// process that ignores SIGTERM is KILLed by its own process group, and
    /// no last-drop is needed. Run by a managed Job (`--ignored`), never in
    /// CI: it starts a synthetic process of its own and signals only it.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "a real process test, run by a managed Job"]
    async fn a_shared_synthetic_runtime_is_killed_without_being_dropped() {
        let mut command = Command::new("/usr/bin/python3");
        command.args(["-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"]);
        let server = Arc::new(Server::synthetic(&mut command));
        let held = server.clone();
        // Let the synthetic process install its SIGTERM handler.
        tokio::time::sleep(Duration::from_millis(500)).await;
        server.terminate();
        assert!(!server.ended_within(Duration::from_millis(250)).await, "it ignores SIGTERM");
        server.kill();
        assert!(server.ended_within(Duration::from_secs(2)).await, "SIGKILL ends its own group");
        assert_eq!(Arc::strong_count(&server), 2, "still shared; no drop did this");
        drop(held);
        drop(server);
    }
}
