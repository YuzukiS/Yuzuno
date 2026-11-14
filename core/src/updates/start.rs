//! Starting an installed Core again as it last started (T-171). The Windows
//! desktop's connection page asks for this when its Core does not answer: it
//! runs `updates/start start …` in the Core's WSL distribution. That starts
//! the installed release (`current.json`) with the port, Workspace folder,
//! working folder and Codex the Core last ran with, and the few environment
//! values in [`ENVIRONMENT`]. It starts only that Core, only when nothing
//! answers on its port. Then it only stays while that Core runs
//! ([`keep_running`]), so WSL keeps the distribution, and Core, running.
//! A start can also give Core the phone's remote entry, or none ([`Remote`],
//! T-170), and `updates/start stop …` stops this installation's Core and
//! nothing else ([`stop`]). On macOS (YN-108) both run as they do on Linux,
//! from a terminal; there a start returns once it has printed, since
//! nothing ends a detached Core when the command that started it exits.
use super::{
    package::{self, Bundle},
    state::{self, Launch, Layout, ReleaseRef},
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// How this installation's Core last started, in `updates/`.
pub const RECORD: &str = "launch.json";
/// `updates/start`: the running release's helper, at a path that stays the
/// same across updates. The desktop runs it; nothing else is executed.
pub const ENTRY: &str = "start";
const LOCK: &str = "start.lock";
/// Held by the one start that keeps the distribution running ([`keep_running`]).
const KEEP_LOCK: &str = "keep.lock";
/// Where the documented start command writes Core's output too.
const LOG: &str = "core.log";

/// The environment kept with the record: what Core and the tools it starts
/// read from it, so a start from the desktop matches one from the user's
/// shell. Nothing else is recorded; the rest comes from `wsl.exe`.
pub const ENVIRONMENT: [&str; 16] = [
    "PATH",
    "LANG",
    "LC_ALL",
    // systemd's user manager, for Jobs.
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    // The native CLIs' own folders.
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    // Core's settings that are not options.
    "YUZUNO_NODE",
    "YUZUNO_OPENCODE_BIN",
    "YUZUNO_EXPERIMENTAL_OPENCODE",
    "YUZUNO_CLAUDE_RUNTIME_CACHE",
    "YUZUNO_SERVICE_PORTS",
    "YUZUNO_WINDOWS_JOBS_ROOT",
    "YUZUNO_REMOTE_PORT",
    "YUZUNO_REMOTE_ORIGIN",
    "YUZUNO_REMOTE_LOGIN",
];
pub(super) const MAX_VALUE: usize = 8192;

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub port: u16,
    pub data_dir: PathBuf,
    pub cwd: PathBuf,
    pub codex: String,
    pub workspace_id: String,
    /// The names in [`ENVIRONMENT`] that were set, with their values.
    pub environment: BTreeMap<String, String>,
    pub recorded_at: String,
}

/// Recorded by a managed Core once it holds its port and has opened its
/// Workspace; `var` reads its environment.
pub fn record(
    layout: &Layout,
    running: &Bundle,
    launch: &Launch,
    workspace_id: &str,
    var: impl Fn(&str) -> Option<String>,
) -> Result<()> {
    let environment = ENVIRONMENT
        .iter()
        .filter_map(|name| Some((name.to_string(), var(name).filter(|value| value.len() <= MAX_VALUE)?)))
        .collect();
    package::atomic_json(
        &layout.updates().join(RECORD),
        &Record {
            port: launch.port,
            data_dir: launch.data_dir.clone(),
            cwd: launch.cwd.clone(),
            codex: launch.codex.clone(),
            workspace_id: workspace_id.into(),
            environment,
            recorded_at: state::now(),
        },
    )?;
    let staged = layout.updates().join(format!(".start-{}", uuid::Uuid::new_v4()));
    std::os::unix::fs::symlink(running.path.join("bin/yuzuno-update-helper"), &staged)?;
    if let Err(error) = fs::rename(&staged, layout.updates().join(ENTRY)) {
        let _ = fs::remove_file(&staged);
        return Err(error.into());
    }
    Ok(())
}

pub(super) fn read_record(layout: &Layout) -> Option<Record> {
    let mut bytes = Vec::new();
    File::open(layout.updates().join(RECORD))
        .ok()?
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Where a desktop starts this Core: in a WSL distribution, by its name, or
/// on the Mac it runs on.
#[derive(Debug, PartialEq, Eq)]
enum Platform {
    Wsl(String),
    Macos,
}

impl Platform {
    /// This process's: WSL, which sets `WSL_DISTRO_NAME` in every process it
    /// starts, or macOS. None elsewhere (Linux outside WSL).
    fn here() -> Option<Self> {
        match std::env::var("WSL_DISTRO_NAME") {
            Ok(distro) if !distro.is_empty() => Some(Self::Wsl(distro)),
            _ if cfg!(target_os = "macos") => Some(Self::Macos),
            _ => None,
        }
    }
}

/// What the desktop keeps to start this Core again: where it is, and on
/// which `platform` (`wsl` or `macos`; a desktop reads an answer without
/// one as WSL's, as Cores before it answered). Says why not when this Core
/// cannot be started that way.
pub fn profile(layout: Option<&Layout>, port: u16, workspace_id: &str) -> Value {
    profile_on(Platform::here(), layout, port, workspace_id, || user_info().map(|user| user.name))
}

fn profile_on(
    platform: Option<Platform>,
    layout: Option<&Layout>,
    port: u16,
    workspace_id: &str,
    user: impl FnOnce() -> Option<String>,
) -> Value {
    let Some(layout) = layout else {
        return json!({"available":false,"reason":"notManaged"});
    };
    let Some(platform) = platform else {
        return json!({"available":false,"reason":"notWsl"});
    };
    if !read_record(layout).is_some_and(|record| record.port == port && record.workspace_id == workspace_id)
        || !layout.updates().join(ENTRY).exists()
    {
        return json!({"available":false,"reason":"notRecorded"});
    }
    let Some(user) = user() else {
        return json!({"available":false,"reason":"noUser"});
    };
    let mut answer = json!({"available":true,"user":user,"installDir":layout.root,"port":port,"workspaceId":workspace_id});
    match platform {
        Platform::Wsl(distro) => {
            answer["platform"] = json!("wsl");
            answer["wslDistro"] = json!(distro);
        }
        Platform::Macos => answer["platform"] = json!("macos"),
    }
    answer
}

/// This process's user, from the user database.
pub(super) struct User {
    pub name: String,
    /// The login shell, when the user database names one.
    pub shell: Option<PathBuf>,
}

/// This process's user name and login shell, from the user database
/// (`getpwuid_r`: on Linux with glibc, and on macOS). Elsewhere only the
/// name, from `USER`.
pub(super) fn user_info() -> Option<User> {
    #[cfg(any(all(target_os = "linux", target_env = "gnu"), target_os = "macos"))]
    {
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut found = std::ptr::null_mut();
        let mut buffer = vec![0 as libc::c_char; 16 * 1024];
        // SAFETY: every pointer refers to storage that outlives the call.
        let status = unsafe {
            libc::getpwuid_r(libc::geteuid(), &mut entry, buffer.as_mut_ptr(), buffer.len(), &mut found)
        };
        if status != 0 || found.is_null() {
            return None;
        }
        // SAFETY: on success pw_name and pw_shell point into `buffer`,
        // NUL-terminated (pw_shell may be null).
        let name = unsafe { std::ffi::CStr::from_ptr(entry.pw_name) };
        let shell = (!entry.pw_shell.is_null())
            .then(|| unsafe { std::ffi::CStr::from_ptr(entry.pw_shell) })
            .and_then(|shell| shell.to_str().ok())
            .filter(|shell| !shell.is_empty())
            .map(PathBuf::from);
        name.to_str().ok().map(|name| User { name: name.to_owned(), shell })
    }
    #[cfg(not(any(all(target_os = "linux", target_env = "gnu"), target_os = "macos")))]
    std::env::var("USER").ok().map(|name| User { name, shell: None })
}

/// How long a start may wait: for another start of this Core to finish, and
/// for the started Core to answer.
#[derive(Clone, Copy)]
pub struct Budget {
    pub lock: Duration,
    pub ready: Duration,
}
impl Default for Budget {
    fn default() -> Self {
        Self { lock: Duration::from_secs(120), ready: Duration::from_secs(120) }
    }
}

/// Why nothing was started or stopped, or how a start or stop failed.
pub(super) struct Stop {
    pub state: &'static str,
    pub code: &'static str,
    pub message: String,
    pub log: Option<String>,
}
pub(super) fn refused(code: &'static str, message: impl Into<String>) -> Stop {
    Stop { state: "refused", code, message: message.into(), log: None }
}
pub(super) fn failed(code: &'static str, message: impl Into<String>) -> Stop {
    Stop { state: "failed", code, message: message.into(), log: None }
}

/// The remote entry a start gives Core (T-170): as it last started, the
/// settings given here, or none. They are Core's `YUZUNO_REMOTE_*`
/// environment, which Core records once it has opened its Workspace, so a
/// start that fails leaves the record as it was.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Remote {
    Recorded,
    Set { port: u16, origin: String, login: String },
    Off,
}
const REMOTE: [&str; 3] = ["YUZUNO_REMOTE_PORT", "YUZUNO_REMOTE_ORIGIN", "YUZUNO_REMOTE_LOGIN"];

impl Remote {
    /// The values of [`REMOTE`] this start gives, or None to keep the
    /// record's.
    fn environment(&self) -> Option<[Option<String>; 3]> {
        match self {
            Remote::Recorded => None,
            Remote::Set { port, origin, login } => Some([Some(port.to_string()), Some(origin.clone()), Some(login.clone())]),
            Remote::Off => Some([None, None, None]),
        }
    }
}

pub(super) fn result_of(result: Result<Value, Stop>) -> Value {
    match result {
        Ok(outcome) => outcome,
        Err(stop) => {
            let mut outcome = json!({"state":stop.state,"code":stop.code,"message":stop.message});
            if let Some(log) = stop.log {
                outcome["log"] = json!(log);
            }
            outcome
        }
    }
}

/// Starts the Core installed at `root` that last ran on `port` with the
/// Workspace `workspace_id`, unless it already answers there. The result's
/// `state`: `started`, `running` (it already answered; nothing started),
/// `starting` (started, not answering yet; nothing is stopped), `refused` or
/// `failed`, with a `code` and `message`.
pub fn start(root: &Path, port: u16, workspace_id: &str, budget: Budget) -> Value {
    start_with(root, port, workspace_id, &Remote::Recorded, budget)
}

/// [`start`] with the remote entry `remote`. Settings Core would refuse are
/// refused before anything else; a Core that already answers is not
/// changed (`refused`, code `running`): it is stopped first ([`stop`]).
/// A started Core's result says what it recorded.
pub fn start_with(root: &Path, port: u16, workspace_id: &str, remote: &Remote, budget: Budget) -> Value {
    result_of(try_start(root, port, workspace_id, remote, budget))
}

/// What a start and a stop check first: the installation at `root`, held by
/// its start lock while the returned file lives, that last ran on `port` with
/// `workspace_id`, and no update switching its release.
fn prepare(root: &Path, port: u16, workspace_id: &str, wait: Duration) -> Result<(Layout, File, Record), Stop> {
    let (layout, lock) = open_locked(root, wait)?;
    let Some(record) = read_record(&layout) else {
        return Err(refused("noRecord", "This installation has not recorded how its Core starts. Start Core in WSL once with this version."));
    };
    if record.port != port {
        return Err(refused("otherPort", format!("This installation's Core last ran on port {}, not {port}.", record.port)));
    }
    if record.workspace_id != workspace_id {
        return Err(refused("otherWorkspace", "This installation's Core last opened another Workspace."));
    }
    refuse_while_switching(&layout)?;
    Ok((layout, lock, record))
}

/// The installation at `root`, held by its start lock while the returned
/// file lives: what every start and stop opens first.
pub(super) fn open_locked(root: &Path, wait: Duration) -> Result<(Layout, File), Stop> {
    let installed = |path: &Path| path.is_absolute() && path.join("current.json").is_file();
    if !installed(root) {
        return Err(refused("notInstalled", format!("No Yuzuno installation is at {}.", root.display())));
    }
    let layout = Layout::open(root).map_err(|error| refused("unsafeInstall", format!("{error:#}")))?;
    let lock = state::private_file(&layout.updates().join(LOCK)).map_err(|error| failed("error", format!("{error:#}")))?;
    let until = Instant::now() + wait;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if Instant::now() < until => std::thread::sleep(Duration::from_millis(100)),
            Err(fs::TryLockError::WouldBlock) => return Err(refused("busy", "Another start or stop of this Core has not finished.")),
            Err(fs::TryLockError::Error(error)) => return Err(failed("error", error.to_string())),
        }
    }
    Ok((layout, lock))
}

/// Refused while an update switches this installation's release.
pub(super) fn refuse_while_switching(layout: &Layout) -> Result<(), Stop> {
    if let Ok(journal) = layout.journal() {
        if journal.operation.is_some_and(|op| {
            op.phase.active() && op.helper_process.as_ref().is_some_and(|helper| helper.alive())
        }) {
            return Err(refused("updating", "A Core update is switching releases right now. Wait for it to finish."));
        }
    }
    Ok(())
}

fn try_start(root: &Path, port: u16, workspace_id: &str, remote: &Remote, budget: Budget) -> Result<Value, Stop> {
    if let Remote::Set { port: remote_port, origin, login } = remote {
        crate::server::RemoteEntry::from_settings(Some(remote_port.to_string()), Some(origin.clone()), Some(login.clone()), port)
            .map_err(|error| refused("invalidRemote", format!("{error:#}. Nothing was started or changed.")))?;
    }
    let (layout, _lock, record) = prepare(root, port, workspace_id, budget.lock)?;
    let client = client().map_err(|error| failed("error", error.to_string()))?;
    // Whatever holds the port: this Core (running or still starting),
    // another one, or something else.
    let until = Instant::now() + budget.ready;
    loop {
        match probe(&client, port, Some(workspace_id)) {
            Answer::Free => break,
            Answer::Ours { .. } if *remote == Remote::Recorded => return Ok(json!({"state":"running","workspaceId":workspace_id})),
            Answer::Ours { .. } => {
                return Err(refused("running", "This installation's Core is running, and its remote entry was not changed. Stop it first, then start it with these settings."))
            }
            Answer::Workspace => return Err(refused("otherWorkspaceOnPort", format!("Another Workspace's Core answers on port {port}."))),
            Answer::Other => return Err(refused("portInUse", format!("Port {port} is used by something other than Yuzuno Core."))),
            Answer::Silent if Instant::now() < until => std::thread::sleep(Duration::from_millis(250)),
            Answer::Silent => return Err(refused("portInUse", format!("Something holds port {port} but does not answer as Yuzuno Core."))),
        }
    }
    let (release, core) = installed_core(&layout)?;
    let (log, log_path, offset) = open_log(&layout)?;
    let mut child = spawn(&core, &layout, &record, log, remote).map_err(|error| failed("spawn", format!("Cannot start Core: {error}")))?;
    let pid = child.id();
    let until = Instant::now() + budget.ready;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(Stop { log: tail(&log_path, offset), ..failed("exited", format!("Core exited before it answered ({status}).")) });
        }
        match probe(&client, port, Some(workspace_id)) {
            Answer::Ours { ready: true, .. } => {
                let mut outcome = json!({"state":"started","pid":pid,"releaseId":release,"workspaceId":workspace_id});
                if *remote != Remote::Recorded {
                    outcome["remote"] = remote_outcome(&layout, remote);
                }
                return Ok(outcome);
            }
            Answer::Workspace | Answer::Other => {
                return Err(failed("portInUse", format!("Something else took port {port} while Core started; Core (process {pid}) was left as it is.")))
            }
            _ if Instant::now() < until => std::thread::sleep(Duration::from_millis(250)),
            _ => {
                let mut outcome = json!({"state":"starting","pid":pid,"releaseId":release,"workspaceId":workspace_id});
                if *remote != Remote::Recorded {
                    outcome["remote"] = json!({"recorded":false,"message":"Core has not answered yet, so whether it took this remote entry is not known."});
                }
                return Ok(outcome);
            }
        }
    }
}

/// The release `current.json` names, and its Core.
pub(super) fn installed_core(layout: &Layout) -> Result<(String, PathBuf), Stop> {
    let release: ReleaseRef = File::open(layout.root.join("current.json"))
        .ok()
        .and_then(|file| serde_json::from_reader(file).ok())
        .ok_or_else(|| failed("missingRelease", "current.json does not name a release."))?;
    package::valid_id(&release.release_id).map_err(|error| failed("missingRelease", format!("{error:#}")))?;
    let core = layout.root.join("releases").join(&release.release_id).join("bin/yuzuno-workspace");
    if !core.is_file() {
        return Err(failed("missingRelease", format!("The installed release {} is missing its Core.", release.release_id)));
    }
    Ok((release.release_id, core))
}

/// `core.log`, where a start writes Core's output, with its path and how
/// long it was before this start.
pub(super) fn open_log(layout: &Layout) -> Result<(File, PathBuf, u64), Stop> {
    let path = layout.root.join(LOG);
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(&path)
        .map_err(|error| failed("error", format!("Cannot open {}: {error}", path.display())))?;
    let offset = log.metadata().map(|meta| meta.len()).unwrap_or(0);
    Ok((log, path, offset))
}

/// What a started Core took of the remote entry this start gave it. Core
/// records how it started before it answers, so a record without these
/// settings means Core could not record them: a later start as recorded (the
/// desktop's) would start it without them.
fn remote_outcome(layout: &Layout, remote: &Remote) -> Value {
    let given = remote.environment().unwrap_or_default();
    let recorded = read_record(layout).is_some_and(|record| {
        REMOTE.iter().zip(&given).all(|(name, value)| record.environment.get(*name) == value.as_ref())
    });
    match remote {
        Remote::Set { port, origin, .. } => {
            let listening = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, *port)), Duration::from_secs(1)).is_ok();
            json!({"entry":"on","port":port,"origin":origin,"listening":listening,"recorded":recorded})
        }
        Remote::Off | Remote::Recorded => json!({"entry":"off","recorded":recorded}),
    }
}

/// How long [`keep_running`] stays once Core is gone, and how often it looks.
#[derive(Clone, Copy)]
pub struct Keep {
    pub grace: Duration,
    pub poll: Duration,
}
impl Default for Keep {
    fn default() -> Self {
        Self { grace: Duration::from_secs(120), poll: Duration::from_secs(5) }
    }
}

/// After a start that launched Core, the start stays (and with it the
/// `wsl.exe` that ran it from Windows) while this installation's Core holds
/// `port`. WSL may end a distribution that no `wsl.exe` is attached to,
/// background processes and all: the first start after Windows restarts
/// has nothing else attached. It returns once the port has been free, or
/// held by something else, for `grace`, which an update's restart stays
/// within. It starts, stops and restarts nothing. One per installation: if
/// another start already keeps the distribution, it returns at once.
/// `workspace_id` is the Workspace that Core opened, or None when that is not
/// known yet (a first start whose Core has not answered): then any Yuzuno
/// Core on `port` counts.
pub fn keep_running(root: &Path, port: u16, workspace_id: Option<&str>, keep: Keep) -> Result<()> {
    let lock = state::private_file(&root.join("updates").join(KEEP_LOCK))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => return Ok(()),
        Err(fs::TryLockError::Error(error)) => return Err(error.into()),
    }
    let client = client()?;
    let mut gone = None::<Instant>;
    loop {
        // Silent: a Core that has its port but does not answer yet.
        if matches!(probe(&client, port, workspace_id), Answer::Ours { .. } | Answer::Silent) {
            gone = None;
        } else if gone.get_or_insert_with(Instant::now).elapsed() >= keep.grace {
            return Ok(());
        }
        std::thread::sleep(keep.poll);
    }
}

/// After `start` or `first-start` printed a result that launched Core: in
/// WSL, which `distro` (`WSL_DISTRO_NAME`, which WSL sets in every process
/// it starts) says, it stays while that Core runs ([`keep_running`]);
/// elsewhere it returns at once, since nothing ends a detached Core there
/// when the command that started it exits.
pub fn stay(root: &Path, port: u16, workspace_id: Option<&str>, distro: Option<&std::ffi::OsStr>, keep: Keep) -> Result<()> {
    if distro.is_some_and(|name| !name.is_empty()) {
        keep_running(root, port, workspace_id, keep)
    } else {
        Ok(())
    }
}

/// How long a stop may wait: for another start or stop of this Core to
/// finish, and for Core to exit once interrupted.
#[derive(Clone, Copy)]
pub struct StopBudget {
    pub lock: Duration,
    pub exit: Duration,
}
impl Default for StopBudget {
    fn default() -> Self {
        Self { lock: Duration::from_secs(120), exit: Duration::from_secs(60) }
    }
}

/// Stops the Core installed at `root` that last ran on `port` with the
/// Workspace `workspace_id` (T-170): it asks Core to shut down, and Core
/// shuts down cleanly. On Linux it interrupts Core (SIGINT); on macOS it
/// sends SIGTERM (YN-108), which Core takes the same way. Only when that
/// Core answers there and is the one process of this installation, running
/// the release it says it runs, started with that port and, where the
/// system can tell (Linux), holding it; otherwise nothing is signalled.
/// Nothing is ever killed: a Core that has not exited within the wait is
/// said to be `stopping` (code `timeout`) and left as it is. The result's
/// `state`: `stopped` (with `portHeldBy` when something holds the port
/// again by the time Core has gone), `notRunning`, `stopping`, `refused` or
/// `failed`, with a `code` and `message`.
pub fn stop(root: &Path, port: u16, workspace_id: &str, budget: StopBudget) -> Value {
    result_of(try_stop(root, port, workspace_id, budget))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn try_stop(root: &Path, port: u16, workspace_id: &str, budget: StopBudget) -> Result<Value, Stop> {
    let (layout, _lock, _record) = prepare(root, port, workspace_id, budget.lock)?;
    let client = client().map_err(|error| failed("error", error.to_string()))?;
    let release = match probe(&client, port, Some(workspace_id)) {
        Answer::Free => return Ok(json!({"state":"notRunning","workspaceId":workspace_id})),
        Answer::Ours { release: Some(release), .. } => release,
        Answer::Ours { release: None, .. } => {
            return Err(refused("unidentified", format!("The Core on port {port} does not say which release it runs; nothing was stopped.")))
        }
        Answer::Workspace => return Err(refused("otherWorkspaceOnPort", format!("Another Workspace's Core answers on port {port}; nothing was stopped."))),
        Answer::Other => return Err(refused("portInUse", format!("Port {port} is used by something other than Yuzuno Core; nothing was stopped."))),
        Answer::Silent => {
            return Err(refused("notAnswering", format!("Something holds port {port} but does not answer as Yuzuno Core; nothing was stopped.")))
        }
    };
    package::valid_id(&release).map_err(|error| refused("unidentified", format!("{error:#}; nothing was stopped.")))?;
    let core = instance(&layout, port, &release)?;
    interrupt(&core, port)?;
    let until = Instant::now() + budget.exit;
    loop {
        if !core.alive() {
            let mut outcome = json!({"state":"stopped","pid":core.pid,"releaseId":release,"workspaceId":workspace_id});
            // Core has gone; something may hold its port again already (a
            // start that started Core again, or another program).
            let holder = match probe(&client, port, Some(workspace_id)) {
                Answer::Free => None,
                Answer::Ours { .. } => Some("thisWorkspace"),
                Answer::Workspace => Some("otherWorkspace"),
                Answer::Other => Some("otherProgram"),
                Answer::Silent => Some("notAnswering"),
            };
            if let Some(holder) = holder {
                outcome["portHeldBy"] = json!(holder);
                outcome["message"] = json!(format!("Core (process {}) has exited; port {port} is held again ({holder}).", core.pid));
            }
            return Ok(outcome);
        }
        if Instant::now() >= until {
            return Err(Stop {
                state: "stopping",
                code: "timeout",
                message: format!(
                    "Core (process {}) was asked to stop but has not exited within {} s. Nothing more was done: it may still be finishing. Check again before stopping it any other way.",
                    core.pid,
                    budget.exit.as_secs()
                ),
                log: None,
            });
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn try_stop(_root: &Path, _port: u16, _workspace_id: &str, _budget: StopBudget) -> Result<Value, Stop> {
    Err(refused("unsupported", "Stopping a managed Core needs Linux, WSL or macOS."))
}

/// Interrupts Core, `core`, through a pidfd held before its last check: a
/// process ID used again after it is not the one interrupted.
#[cfg(target_os = "linux")]
fn interrupt(core: &state::ProcessIdentity, port: u16) -> Result<(), Stop> {
    use rustix::process::{pidfd_open, pidfd_send_signal, Pid, PidfdFlags, Signal};
    let pid = Pid::from_raw(core.pid as i32).ok_or_else(|| failed("error", format!("Invalid process ID {}", core.pid)))?;
    let held = pidfd_open(pid, PidfdFlags::empty())
        .map_err(|error| refused("changed", format!("Core (process {}) could not be held ({error}); nothing was stopped.", core.pid)))?;
    if !core.alive() || holds(core.pid, port) != Some(true) {
        return Err(refused("changed", format!("Core (process {}) changed while it was checked; nothing was stopped.", core.pid)));
    }
    pidfd_send_signal(&held, Signal::INT).map_err(|error| failed("signal", format!("Cannot interrupt Core (process {}): {error}", core.pid)))
}

/// Sends Core, `core`, SIGTERM. macOS has no handle to signal a process
/// through, as Linux's pidfd is, so its identity, start time included, is
/// read again just before the signal: had it exited and its process ID been
/// given to another process since it was found, that one has another start
/// time and is not signalled. What is left is the moment between that read
/// and the signal.
#[cfg(target_os = "macos")]
fn interrupt(core: &state::ProcessIdentity, _port: u16) -> Result<(), Stop> {
    use rustix::process::{kill_process, Pid, Signal};
    let pid = Pid::from_raw(core.pid as i32).ok_or_else(|| failed("error", format!("Invalid process ID {}", core.pid)))?;
    if !core.alive() {
        return Err(refused("changed", format!("Core (process {}) changed while it was checked; nothing was stopped.", core.pid)));
    }
    kill_process(pid, Signal::TERM).map_err(|error| failed("signal", format!("Cannot stop Core (process {}): {error}", core.pid)))
}

/// The one process of the installation at `layout` (`--install-dir` names
/// it, and it runs a release of it): it must run `release` with `--port
/// port` and, where the system can tell (Linux), hold that port. Refused
/// when another process of the installation runs too, or when none is that
/// one.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn instance(layout: &Layout, port: u16, release: &str) -> Result<state::ProcessIdentity, Stop> {
    let root = fs::canonicalize(&layout.root).map_err(|error| failed("error", format!("{}: {error}", layout.root.display())))?;
    let releases = root.join("releases");
    let mut found = Vec::new();
    for pid in process_ids()? {
        // A process that has gone, or on Linux another user's, has no
        // identity here.
        let Ok(identity) = state::ProcessIdentity::read(pid) else { continue };
        // A release's Core: not its helper, which a start that stays runs
        // with the same --install-dir.
        let core = identity.executable.file_name().is_some_and(|name| name == "yuzuno-workspace")
            && identity.executable.parent().is_some_and(|bin| bin.file_name().is_some_and(|name| name == "bin"))
            && identity.executable.parent().and_then(Path::parent).and_then(Path::parent) == Some(releases.as_path());
        if !core {
            continue;
        }
        // Not shown for another user's process (macOS).
        let Some(arguments) = arguments(pid) else { continue };
        let installed = option(&arguments, "--install-dir").and_then(|dir| fs::canonicalize(dir).ok());
        if installed.as_deref() == Some(root.as_path()) {
            found.push((identity, arguments));
        }
    }
    let (identity, arguments) = match found.as_slice() {
        [one] => one,
        [] => {
            return Err(refused("unidentified", format!("A Core answers on port {port}, but no process of this installation runs; nothing was stopped.")))
        }
        many => {
            let pids: Vec<String> = many.iter().map(|(identity, _)| identity.pid.to_string()).collect();
            return Err(refused(
                "multipleInstances",
                format!("More than one process of this installation runs (processes {}); nothing was stopped.", pids.join(", ")),
            ));
        }
    };
    let expected = releases.join(release).join("bin/yuzuno-workspace");
    if identity.executable != expected {
        return Err(refused(
            "unidentified",
            format!("Process {} runs {}, not the release its Core says it runs ({release}); nothing was stopped.", identity.pid, identity.executable.display()),
        ));
    }
    // Where which process holds the port cannot be told (macOS: None), the
    // one process of this installation started with it, running the release
    // the Core on it names, is taken to be that Core.
    if option(arguments, "--port") != Some(port.to_string().as_str()) || holds(identity.pid, port) == Some(false) {
        return Err(refused("unidentified", format!("Process {} of this installation does not hold port {port}; nothing was stopped.", identity.pid)));
    }
    Ok(identity.clone())
}

/// Every process ID on this machine, from /proc.
#[cfg(target_os = "linux")]
fn process_ids() -> Result<Vec<u32>, Stop> {
    let entries = fs::read_dir("/proc").map_err(|error| failed("error", format!("Cannot list processes: {error}")))?;
    Ok(entries.flatten().filter_map(|entry| entry.file_name().to_str()?.parse().ok()).collect())
}

/// Every process ID on this machine, from libproc (`proc_listallpids`).
#[cfg(target_os = "macos")]
fn process_ids() -> Result<Vec<u32>, Stop> {
    let unlisted = |error: std::io::Error| failed("error", format!("Cannot list processes: {error}"));
    // SAFETY: a null buffer of no bytes only asks how many there are.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    // A machine always runs some process: none means the question failed.
    let mut room = usize::try_from(count).ok().filter(|&count| count > 0).ok_or_else(|| unlisted(std::io::Error::last_os_error()))?;
    for _ in 0..4 {
        // Room for processes that start between the two calls.
        room += 64;
        let mut pids: Vec<libc::pid_t> = vec![0; room];
        let bytes = libc::c_int::try_from(room * std::mem::size_of::<libc::pid_t>())
            .map_err(|_| unlisted(std::io::Error::other("too many processes")))?;
        // SAFETY: `pids` is a live, writable buffer of `bytes` bytes, which
        // is what proc_listallpids is told it may write.
        let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        // It answers how many IDs it wrote, at most `room`.
        let listed = usize::try_from(listed)
            .ok()
            .filter(|&listed| listed > 0 && listed <= room)
            .ok_or_else(|| unlisted(std::io::Error::last_os_error()))?;
        // A full buffer may not have had room for them all: ask again.
        if listed < room {
            pids.truncate(listed);
            return Ok(pids.into_iter().filter_map(|pid| u32::try_from(pid).ok().filter(|&pid| pid > 0)).collect());
        }
        room = listed * 2;
    }
    Err(unlisted(std::io::Error::other("their number kept growing")))
}

/// Process `pid`'s arguments, without the program.
#[cfg(target_os = "linux")]
fn arguments(pid: u32) -> Option<Vec<String>> {
    let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let mut arguments: Vec<String> = bytes.split(|byte| *byte == 0).map(|part| String::from_utf8_lossy(part).into_owned()).collect();
    if arguments.last().is_some_and(String::is_empty) {
        arguments.pop();
    }
    (!arguments.is_empty()).then(|| arguments.split_off(1))
}

/// Process `pid`'s arguments, without the program, from sysctl
/// `KERN_PROCARGS2` ([`procargs`]). None for a process that has gone, and
/// for another user's, which the kernel does not show.
#[cfg(target_os = "macos")]
fn arguments(pid: u32) -> Option<Vec<String>> {
    let pid = libc::c_int::try_from(pid).ok().filter(|&pid| pid > 0)?;
    // The most a process's arguments and environment take together.
    let mut most: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: `name` holds the 2 names given; `most` is a writable c_int
    // and `size` its size, which sysctl may write; nothing is set (null, 0).
    let status = unsafe {
        libc::sysctl(name.as_mut_ptr(), 2, (&mut most as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0)
    };
    if status != 0 || size != std::mem::size_of::<libc::c_int>() {
        return None;
    }
    let mut buffer = vec![0u8; usize::try_from(most).ok().filter(|&most| most > 0)?];
    let mut size = buffer.len();
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    // SAFETY: `name` holds the 3 names given; `buffer` is writable for
    // `size` bytes, which sysctl is told and sets to the bytes it wrote;
    // nothing is set (null, 0).
    let status = unsafe {
        libc::sysctl(name.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0)
    };
    if status != 0 {
        return None;
    }
    procargs(buffer.get(..size)?)
}

/// The arguments, without the program, in an answer to `KERN_PROCARGS2`:
/// the argument count (a native-endian int), the executable's path and the
/// NULs that pad it, then that many NUL-terminated arguments, the program
/// first, then the environment, which is not read. None when the answer
/// ends before all of them: nothing is read past `bytes`.
#[cfg(any(target_os = "macos", test))]
fn procargs(bytes: &[u8]) -> Option<Vec<String>> {
    let (count, rest) = bytes.split_first_chunk::<4>()?;
    let count = usize::try_from(i32::from_ne_bytes(*count)).ok().filter(|&count| count > 0)?;
    // Past the executable's path, then past its padding.
    let rest = &rest[rest.iter().position(|&byte| byte == 0)?..];
    let mut rest = &rest[rest.iter().position(|&byte| byte != 0)?..];
    let mut arguments = Vec::new();
    for _ in 0..count {
        let end = rest.iter().position(|&byte| byte == 0)?;
        arguments.push(String::from_utf8_lossy(&rest[..end]).into_owned());
        rest = &rest[end + 1..];
    }
    arguments.remove(0);
    Some(arguments)
}

/// The value of option `name`, given as `name value` or `name=value`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn option<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    arguments.iter().enumerate().find_map(|(index, argument)| {
        if argument == name {
            arguments.get(index + 1).map(String::as_str)
        } else {
            argument.strip_prefix(name)?.strip_prefix('=')
        }
    })
}

/// Whether process `pid` holds the socket listening on 127.0.0.1:`port`,
/// from /proc. None where that cannot be told: not on Linux (on macOS a
/// stop and a first start then skip this check).
#[cfg(target_os = "linux")]
pub(super) fn holds(pid: u32, port: u16) -> Option<bool> {
    let Some(inode) = listening(port) else { return Some(false) };
    let socket = format!("socket:[{inode}]");
    let Ok(descriptors) = fs::read_dir(format!("/proc/{pid}/fd")) else { return Some(false) };
    Some(descriptors.flatten().any(|descriptor| fs::read_link(descriptor.path()).is_ok_and(|link| link.as_os_str() == socket.as_str())))
}
#[cfg(not(target_os = "linux"))]
pub(super) fn holds(_pid: u32, _port: u16) -> Option<bool> {
    None
}

/// The inode of the socket listening on 127.0.0.1:`port` (`/proc/net/tcp`).
#[cfg(target_os = "linux")]
fn listening(port: u16) -> Option<u64> {
    let table = fs::read_to_string("/proc/net/tcp").ok()?;
    let local = format!("{:08X}:{port:04X}", u32::from_ne_bytes([127, 0, 0, 1]));
    table.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // State 0A is LISTEN.
        (fields.get(1) == Some(&local.as_str()) && fields.get(3) == Some(&"0A")).then(|| fields.get(9)?.parse().ok())?
    })
}

pub(super) fn client() -> reqwest::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
}

/// The installed Core, detached from this helper and from `wsl.exe`, with
/// the recorded options and environment, and the remote entry `remote`.
pub(super) fn spawn(core: &Path, layout: &Layout, record: &Record, log: File, remote: &Remote) -> std::io::Result<Child> {
    let mut command = Command::new(core);
    command
        .arg("--install-dir")
        .arg(&layout.root)
        .arg("--port")
        .arg(record.port.to_string())
        .arg("--data-dir")
        .arg(&record.data_dir)
        .arg("--cwd")
        .arg(&record.cwd)
        .arg("--codex")
        .arg(&record.codex)
        .current_dir(&record.cwd)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    for name in ENVIRONMENT {
        match record.environment.get(name) {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    if let Some(values) = remote.environment() {
        for (name, value) in REMOTE.iter().zip(values) {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
    }
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        command.pre_exec(|| rustix::process::setsid().map(|_| ()).map_err(std::io::Error::from));
    }
    command.spawn()
}

/// The last few kilobytes this start wrote to the log.
pub(super) fn tail(path: &Path, from: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let end = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(end.saturating_sub(4096).max(from))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub(super) enum Answer {
    /// Nothing listens.
    Free,
    /// This Workspace's Core (any Core, when no Workspace was given), the
    /// Workspace it says it has open, and the release it says it runs.
    Ours {
        ready: bool,
        #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), expect(dead_code, reason = "read only by a stop, which needs Linux or macOS"))]
        release: Option<String>,
        workspace: String,
    },
    /// Another Workspace's Core.
    Workspace,
    /// Not a Yuzuno Core.
    Other,
    /// Something listens but has not answered (yet).
    Silent,
}

/// What answers on `port`, as the Core of `workspace_id` or, given None, of
/// any Workspace.
pub(super) fn probe(client: &reqwest::blocking::Client, port: u16, workspace_id: Option<&str>) -> Answer {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    match TcpStream::connect_timeout(&address, Duration::from_secs(1)) {
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => return Answer::Free,
        Err(_) => return Answer::Silent,
        Ok(_) => {}
    }
    let Ok(response) = client.get(format!("http://127.0.0.1:{port}/api/health")).send() else {
        return Answer::Silent;
    };
    if !response.status().is_success() {
        // A definite answer, and not a Core's health.
        return Answer::Other;
    }
    let mut body = Vec::new();
    if response.take(64 * 1024).read_to_end(&mut body).is_err() {
        return Answer::Silent;
    }
    let Ok(health) = serde_json::from_slice::<Value>(&body) else {
        return Answer::Other;
    };
    // As the desktop recognizes a Core (desktop/src/health.rs).
    let core = match health["product"].as_str() {
        Some(product) => product == crate::server::PRODUCT,
        None => health["application"] == crate::server::LEGACY_APPLICATION,
    };
    if !core {
        Answer::Other
    } else if workspace_id.is_some_and(|workspace_id| health["workspaceId"] != workspace_id) {
        Answer::Workspace
    } else {
        Answer::Ours {
            ready: health["apiReady"] != false && health["storageReady"] != false,
            release: health["releaseId"].as_str().map(str::to_owned),
            workspace: health["workspaceId"].as_str().unwrap_or_default().to_owned(),
        }
    }
}

#[cfg(test)]
pub(in crate::updates) mod tests {
    use super::*;
    use crate::test_ports::free_port;
    use crate::updates::catalog;
    use std::{io::Write, net::TcpListener, os::unix::fs::PermissionsExt, sync::Arc};

    pub(in crate::updates) struct Install {
        pub temp: tempfile::TempDir,
        pub layout: Layout,
        pub running: Bundle,
    }
    /// A managed installation of release a that has not started yet.
    pub(in crate::updates) fn install() -> Install {
        let temp = tempfile::tempdir().unwrap();
        let a = package::fixture(&temp.path().join("source-a"), "a");
        let root = temp.path().join("managed");
        catalog::register(&root, &a.path, &a.manifest_sha256, "review a", true).unwrap();
        let layout = Layout::open(&root).unwrap();
        let running = layout.release(&ReleaseRef::from(&a)).unwrap();
        Install { temp, layout, running }
    }
    fn launch(install: &Install, port: u16) -> Launch {
        let data = install.temp.path().join("data");
        let cwd = install.temp.path().join("work");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        Launch { port, data_dir: data, cwd, codex: "/opt/codex/bin/codex".into() }
    }
    const WORKSPACE: &str = "workspace-1";
    const QUICK: Budget = Budget { lock: Duration::from_secs(5), ready: Duration::from_secs(20) };

    /// A stand-in for the installed Core: a Python script at the release's
    /// Core path. It notes how it was started in `started`, then serves
    /// `/api/health` on its `--port` as `workspace`.
    fn stand_in(install: &Install, body: &str) -> PathBuf {
        let notes = install.temp.path().join("started");
        let core = install.layout.root.join("releases/a/bin/yuzuno-workspace");
        let dir = core.parent().unwrap();
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
        let _ = fs::remove_file(&core);
        let script = format!(
            r#"#!/usr/bin/env python3
import http.server, json, os, sys, time
args = sys.argv[1:]
port = int(args[args.index("--port") + 1])
with open({notes:?}, "a") as notes:
    notes.write(json.dumps({{"argv": args, "cwd": os.getcwd(), "sid": os.getsid(0), "pid": os.getpid(),
        "env": {{name: os.environ.get(name) for name in ("PATH", "CODEX_HOME", "YUZUNO_REMOTE_PORT", "KEEP_ME")}}}}) + "\n")
{body}
class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        payload = json.dumps({{"product": "yuzuno", "workspaceId": {WORKSPACE:?}, "apiReady": True, "storageReady": True}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(payload)
    def log_message(self, *args): pass
http.server.HTTPServer(("127.0.0.1", port), Health).serve_forever()
"#
        );
        fs::write(&core, script).unwrap();
        fs::set_permissions(&core, fs::Permissions::from_mode(0o700)).unwrap();
        notes
    }
    pub(in crate::updates) fn starts_seen(path: &Path) -> Vec<Value> {
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    /// Stops a stand-in this test started, by the pid its start reported.
    struct Started(Option<i32>);
    impl Drop for Started {
        fn drop(&mut self) {
            if let Some(pid) = self.0.and_then(rustix::process::Pid::from_raw) {
                let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
            }
        }
    }
    fn started(outcome: &Value) -> Started {
        Started(outcome["pid"].as_i64().map(|pid| pid as i32))
    }

    /// Answers every connection with `body` as an HTTP 200, until stopped.
    pub(in crate::updates) fn answer(body: &'static str) -> (u16, Arc<std::sync::atomic::AtomicBool>) {
        answer_with("200 OK", body)
    }
    fn answer_with(status: &'static str, body: &'static str) -> (u16, Arc<std::sync::atomic::AtomicBool>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = stop.clone();
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            while !done.load(std::sync::atomic::Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let mut request = [0u8; 2048];
                        let _ = stream.read(&mut request);
                        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        (port, stop)
    }

    #[test]
    fn a_core_records_how_it_started_and_where_its_helper_is() {
        let install = install();
        let launch = launch(&install, 4321);
        let environment = |name: &str| match name {
            "PATH" => Some("/home/u/.local/bin:/usr/bin".into()),
            "YUZUNO_REMOTE_PORT" => Some("4318".into()),
            "CODEX_HOME" => Some("x".repeat(MAX_VALUE + 1)),
            // Not in the list: never recorded.
            "GH_TOKEN" | "ANTHROPIC_API_KEY" => Some("secret".into()),
            _ => None,
        };
        record(&install.layout, &install.running, &launch, WORKSPACE, environment).unwrap();
        let path = install.layout.updates().join(RECORD);
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let saved = read_record(&install.layout).unwrap();
        assert_eq!(
            (saved.port, saved.data_dir, saved.cwd, saved.codex.as_str(), saved.workspace_id.as_str()),
            (4321, launch.data_dir.clone(), launch.cwd.clone(), "/opt/codex/bin/codex", WORKSPACE)
        );
        assert_eq!(
            saved.environment,
            BTreeMap::from([
                ("PATH".to_string(), "/home/u/.local/bin:/usr/bin".to_string()),
                ("YUZUNO_REMOTE_PORT".to_string(), "4318".to_string()),
            ])
        );
        assert!(!fs::read_to_string(&path).unwrap().contains("secret"));
        let entry = install.layout.updates().join(ENTRY);
        assert_eq!(fs::read_link(&entry).unwrap(), install.running.path.join("bin/yuzuno-update-helper"));
        // A later start replaces both.
        record(&install.layout, &install.running, &Launch { port: 4400, ..launch }, WORKSPACE, |_| None).unwrap();
        assert_eq!(read_record(&install.layout).unwrap().port, 4400);
        assert!(read_record(&install.layout).unwrap().environment.is_empty());
        assert!(fs::read_link(&entry).is_ok());
        assert!(!fs::read_dir(install.layout.updates())
            .unwrap()
            .any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".start-")));
    }

    #[test]
    fn nothing_starts_without_a_matching_record() {
        let install = install();
        let elsewhere = install.temp.path().join("not-an-install");
        fs::create_dir(&elsewhere).unwrap();
        let outcome = start(&elsewhere, 4321, WORKSPACE, QUICK);
        assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("refused"), Some("notInstalled")));
        // Nothing was made there.
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
        let outcome = start(&install.layout.root, 4321, WORKSPACE, QUICK);
        assert_eq!(outcome["code"], "noRecord");
        let notes = stand_in(&install, "");
        record(&install.layout, &install.running, &launch(&install, 4321), WORKSPACE, |_| None).unwrap();
        assert_eq!(start(&install.layout.root, 4322, WORKSPACE, QUICK)["code"], "otherPort");
        assert_eq!(start(&install.layout.root, 4321, "workspace-2", QUICK)["code"], "otherWorkspace");
        assert!(starts_seen(&notes).is_empty());
    }

    #[test]
    fn a_core_that_answers_is_never_started_again() {
        let install = install();
        let notes = stand_in(&install, "");
        for (body, state, code) in [
            (r#"{"product":"yuzuno","workspaceId":"workspace-1","apiReady":true}"#, "running", None),
            (r#"{"application":"yuzuno-next","workspaceId":"workspace-1"}"#, "running", None),
            (r#"{"product":"yuzuno","workspaceId":"workspace-2"}"#, "refused", Some("otherWorkspaceOnPort")),
            (r#"{"status":"ok"}"#, "refused", Some("portInUse")),
            ("<html>not json</html>", "refused", Some("portInUse")),
        ] {
            let (port, stop) = answer(body);
            record(&install.layout, &install.running, &launch(&install, port), WORKSPACE, |_| None).unwrap();
            let outcome = start(&install.layout.root, port, WORKSPACE, QUICK);
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
            assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some(state), code), "{body}: {outcome}");
        }
        // A definite answer that is not a Core's health is refused at once,
        // not after the whole wait.
        let (port, stop) = answer_with("404 Not Found", "nothing here");
        record(&install.layout, &install.running, &launch(&install, port), WORKSPACE, |_| None).unwrap();
        let asked = Instant::now();
        let outcome = start(&install.layout.root, port, WORKSPACE, QUICK);
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(outcome["code"], "portInUse", "{outcome}");
        assert!(asked.elapsed() < Duration::from_secs(5), "{:?}", asked.elapsed());
        assert!(starts_seen(&notes).is_empty(), "nothing was started");
    }

    #[test]
    fn a_start_stays_while_its_core_runs_then_goes() {
        let install = install();
        let root = install.layout.root.clone();
        let (port, stop) = answer(r#"{"product":"yuzuno","workspaceId":"workspace-1","apiReady":true}"#);
        let keep = Keep { grace: Duration::from_millis(800), poll: Duration::from_millis(100) };
        let staying = {
            let root = root.clone();
            std::thread::spawn(move || keep_running(&root, port, Some(WORKSPACE), keep))
        };
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!staying.is_finished(), "it stays while Core answers");
        // Another start that launched a Core finds this one keeping and returns.
        let other = Instant::now();
        keep_running(&root, port, Some(WORKSPACE), keep).unwrap();
        assert!(other.elapsed() < Duration::from_millis(500));
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let gone = Instant::now();
        while !staying.is_finished() {
            assert!(gone.elapsed() < Duration::from_secs(10), "it stayed after Core had gone");
            std::thread::sleep(Duration::from_millis(50));
        }
        staying.join().unwrap().unwrap();
        assert!(gone.elapsed() >= keep.grace, "it waited out the grace: {:?}", gone.elapsed());
    }

    /// Only in WSL does a start stay after it printed; there, before Core
    /// has said which Workspace it opened, any Core on the port counts.
    #[test]
    fn a_start_stays_only_in_wsl() {
        let install = install();
        let root = install.layout.root.clone();
        let (port, stop) = answer(r#"{"product":"yuzuno","workspaceId":"workspace-2","apiReady":true}"#);
        let keep = Keep { grace: Duration::from_millis(800), poll: Duration::from_millis(100) };
        for distro in [None, Some(std::ffi::OsStr::new(""))] {
            let asked = Instant::now();
            stay(&root, port, None, distro, keep).unwrap();
            assert!(asked.elapsed() < Duration::from_millis(500), "{distro:?}: {:?}", asked.elapsed());
        }
        let staying = std::thread::spawn(move || stay(&root, port, None, Some(std::ffi::OsStr::new("Ubuntu-24.04")), keep));
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!staying.is_finished(), "it stays while a Core answers");
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let gone = Instant::now();
        while !staying.is_finished() {
            assert!(gone.elapsed() < Duration::from_secs(10), "it stayed after Core had gone");
            std::thread::sleep(Duration::from_millis(50));
        }
        staying.join().unwrap().unwrap();
        // Given a Workspace, another one's Core does not count.
        let (port, stop) = answer(r#"{"product":"yuzuno","workspaceId":"workspace-2","apiReady":true}"#);
        let asked = Instant::now();
        keep_running(&install.layout.root, port, Some(WORKSPACE), keep).unwrap();
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(asked.elapsed() < Duration::from_secs(5), "{:?}", asked.elapsed());
    }

    #[test]
    fn the_installed_release_starts_detached_with_the_recorded_launch() {
        // A bound for a run that hangs, not a time the stand-in must keep:
        // the values of Budget::default(), the wait a real start has. A cold
        // Python on a loaded macOS runner took more than QUICK's 20 s to
        // answer /api/health and the start came back `starting` (core-macos
        // 43562579022, YN-147). `a_core_that_exits_or_is_slow_is_said_as_such`
        // covers that result with its own 1 s wait.
        const READY: Budget = Budget { lock: Duration::from_secs(120), ready: Duration::from_secs(120) };
        let install = install();
        let notes = stand_in(&install, "");
        let port = free_port();
        let launch = launch(&install, port);
        let environment = |name: &str| match name {
            "PATH" => Some(std::env::var("PATH").unwrap()),
            "CODEX_HOME" => Some("/home/u/.codex".into()),
            _ => None,
        };
        record(&install.layout, &install.running, &launch, WORKSPACE, environment).unwrap();
        let outcome = start(&install.layout.root, port, WORKSPACE, READY);
        let _stop = started(&outcome);
        assert_eq!(outcome["state"], "started", "{outcome}");
        assert_eq!(outcome["releaseId"], "a");
        let seen = starts_seen(&notes);
        assert_eq!(seen.len(), 1);
        let root = install.layout.root.to_string_lossy();
        let (data, cwd) = (launch.data_dir.to_string_lossy(), launch.cwd.to_string_lossy());
        assert_eq!(
            seen[0]["argv"],
            json!(["--install-dir", root, "--port", port.to_string(), "--data-dir", data, "--cwd", cwd, "--codex", "/opt/codex/bin/codex"])
        );
        // Its working folder as the system resolves it (macOS: /tmp is /private/tmp).
        assert_eq!(seen[0]["cwd"], json!(launch.cwd.canonicalize().unwrap().to_string_lossy()));
        // Its own session, so it outlives the helper and wsl.exe.
        assert_eq!(seen[0]["sid"], seen[0]["pid"]);
        assert_eq!(seen[0]["pid"], outcome["pid"]);
        assert_eq!(seen[0]["env"]["CODEX_HOME"], "/home/u/.codex");
        // A listed variable the Core did not have is not passed on.
        assert_eq!(seen[0]["env"]["YUZUNO_REMOTE_PORT"], Value::Null);
        // A second start finds it running and starts nothing.
        assert_eq!(start(&install.layout.root, port, WORKSPACE, READY)["state"], "running");
        assert_eq!(starts_seen(&notes).len(), 1);
    }

    #[test]
    fn two_starts_at_once_start_one_core() {
        let install = install();
        // Slow to answer, so the second start waits on the first.
        let notes = stand_in(&install, "time.sleep(1)");
        let port = free_port();
        record(&install.layout, &install.running, &launch(&install, port), WORKSPACE, |_| None).unwrap();
        let root = install.layout.root.clone();
        let starts: Vec<_> = (0..2)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || start(&root, port, WORKSPACE, QUICK))
            })
            .collect();
        let outcomes: Vec<Value> = starts.into_iter().map(|start| start.join().unwrap()).collect();
        let _stops: Vec<_> = outcomes.iter().map(started).collect();
        let mut states: Vec<_> = outcomes.iter().map(|outcome| outcome["state"].as_str().unwrap().to_owned()).collect();
        states.sort();
        assert_eq!(states, ["running", "started"], "{outcomes:?}");
        assert_eq!(starts_seen(&notes).len(), 1);
    }

    #[test]
    fn a_core_that_exits_or_is_slow_is_said_as_such() {
        let install = install();
        let port = free_port();
        let notes = stand_in(&install, "print('cannot open the Workspace', file=sys.stderr); sys.exit(3)");
        record(&install.layout, &install.running, &launch(&install, port), WORKSPACE, |_| None).unwrap();
        fs::write(install.layout.root.join(LOG), "an older start's output\n").unwrap();
        let outcome = start(&install.layout.root, port, WORKSPACE, QUICK);
        assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("failed"), Some("exited")), "{outcome}");
        let log = outcome["log"].as_str().unwrap();
        assert!(log.contains("cannot open the Workspace") && !log.contains("older start"), "{log}");
        assert_eq!(starts_seen(&notes).len(), 1);

        // Not answering within the wait: said, and left running.
        stand_in(&install, "time.sleep(60)");
        let outcome = start(&install.layout.root, port, WORKSPACE, Budget { lock: QUICK.lock, ready: Duration::from_secs(1) });
        let stop = started(&outcome);
        assert_eq!(outcome["state"], "starting", "{outcome}");
        let pid = rustix::process::Pid::from_raw(stop.0.unwrap()).unwrap();
        assert!(rustix::process::test_kill_process(pid).is_ok(), "the slow Core was not stopped");
    }

    const ORIGIN: &str = "https://core.example-tailnet.ts.net:8444";
    const LOGIN: &str = "person@example.com";
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    const QUICK_STOP: StopBudget = StopBudget { lock: Duration::from_secs(5), exit: Duration::from_secs(20) };

    /// tests/fixtures/managed_core_stand_in.rs, compiled once per test
    /// process with the rustc beside the cargo that built these tests: a
    /// program, so that a release's `bin/yuzuno-workspace` is its process's
    /// own executable, as Core's is.
    fn compiled_stand_in() -> &'static Path {
        static BUILT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        BUILT.get_or_init(|| {
            let dir = tempfile::tempdir().unwrap().keep();
            let program = dir.join("stand-in");
            let beside = Path::new(env!("CARGO")).with_file_name("rustc");
            let rustc = if beside.is_file() { beside } else { PathBuf::from("rustc") };
            let built = Command::new(&rustc)
                .args(["--edition", "2021", "-o"])
                .arg(&program)
                .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/managed_core_stand_in.rs"))
                .output()
                .unwrap();
            assert!(built.status.success(), "{}: {}", rustc.display(), String::from_utf8_lossy(&built.stderr));
            program
        })
    }
    /// The compiled stand-in as `name` in release a's `bin/`.
    pub(in crate::updates) fn compiled(install: &Install, name: &str) -> PathBuf {
        let path = install.layout.root.join("releases/a/bin").join(name);
        fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
        let _ = fs::remove_file(&path);
        fs::copy(compiled_stand_in(), &path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    /// A Core this test started, ended at the end of the test only while it
    /// is still that process.
    pub(in crate::updates) struct Held(pub Option<state::ProcessIdentity>);
    impl Drop for Held {
        fn drop(&mut self) {
            if let Some(core) = self.0.take().filter(state::ProcessIdentity::alive) {
                if let Some(pid) = rustix::process::Pid::from_raw(core.pid as i32) {
                    let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
                }
            }
        }
    }
    pub(in crate::updates) fn held(outcome: &Value) -> Held {
        Held(outcome["pid"].as_u64().and_then(|pid| state::ProcessIdentity::read(pid as u32).ok()))
    }
    pub(in crate::updates) fn alive(core: &Held) -> bool {
        core.0.as_ref().is_some_and(state::ProcessIdentity::alive)
    }
    fn on(port: u16) -> Remote {
        Remote::Set { port, origin: ORIGIN.into(), login: LOGIN.into() }
    }

    /// A start gives Core the remote entry it is told to (T-170), or none, and
    /// says what Core recorded; a later start as recorded keeps it. While
    /// Core runs, a start with settings changes nothing.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_start_gives_core_the_remote_entry_it_is_told_to_and_says_what_core_recorded() {
        let install = install();
        compiled(&install, "yuzuno-workspace");
        let port = free_port();
        let launch = launch(&install, port);
        let notes = launch.data_dir.join("started");
        record(&install.layout, &install.running, &launch, WORKSPACE, |_| None).unwrap();
        let remote = free_port();
        let outcome = start_with(&install.layout.root, port, WORKSPACE, &on(remote), QUICK);
        let core = held(&outcome);
        assert_eq!(outcome["state"], "started", "{outcome}");
        assert_eq!(outcome["remote"], json!({"entry":"on","port":remote,"origin":ORIGIN,"listening":true,"recorded":true}));
        let seen = starts_seen(&notes);
        assert_eq!(seen.len(), 1);
        assert_eq!(
            (&seen[0]["env"]["YUZUNO_REMOTE_PORT"], &seen[0]["env"]["YUZUNO_REMOTE_ORIGIN"], &seen[0]["env"]["YUZUNO_REMOTE_LOGIN"]),
            (&json!(remote.to_string()), &json!(ORIGIN), &json!(LOGIN))
        );
        // Running, it is not changed: neither its record nor its process.
        let before = fs::read(install.layout.updates().join(RECORD)).unwrap();
        for remote in [on(free_port()), Remote::Off] {
            let again = start_with(&install.layout.root, port, WORKSPACE, &remote, QUICK);
            assert_eq!((again["state"].as_str(), again["code"].as_str()), (Some("refused"), Some("running")), "{again}");
        }
        assert_eq!(fs::read(install.layout.updates().join(RECORD)).unwrap(), before);
        assert!(alive(&core));
        assert_eq!(starts_seen(&notes).len(), 1);
        // Stopped, it starts as it recorded: with the entry.
        assert_eq!(stop(&install.layout.root, port, WORKSPACE, QUICK_STOP)["state"], "stopped");
        let outcome = start(&install.layout.root, port, WORKSPACE, QUICK);
        let _core = held(&outcome);
        assert_eq!(outcome["state"], "started", "{outcome}");
        assert_eq!(outcome.get("remote"), None);
        assert_eq!(starts_seen(&notes)[1]["env"]["YUZUNO_REMOTE_PORT"], remote.to_string());
        // Then without it, which Core records too.
        assert_eq!(stop(&install.layout.root, port, WORKSPACE, QUICK_STOP)["state"], "stopped");
        let outcome = start_with(&install.layout.root, port, WORKSPACE, &Remote::Off, QUICK);
        let _core = held(&outcome);
        assert_eq!(outcome["remote"], json!({"entry":"off","recorded":true}), "{outcome}");
        assert_eq!(starts_seen(&notes)[2]["env"], json!({}));
        assert!(REMOTE.iter().all(|name| !read_record(&install.layout).unwrap().environment.contains_key(*name)));
        assert_eq!(stop(&install.layout.root, port, WORKSPACE, QUICK_STOP)["state"], "stopped");
    }

    /// Settings Core would refuse are refused before anything else: nothing
    /// starts and the record stays. A Core that cannot take them (it exits
    /// before answering) leaves the record as it was too.
    #[test]
    fn remote_settings_that_cannot_be_taken_start_nothing_and_change_no_record() {
        let install = install();
        compiled(&install, "yuzuno-workspace");
        let port = free_port();
        let launch = launch(&install, port);
        let notes = launch.data_dir.join("started");
        record(&install.layout, &install.running, &launch, WORKSPACE, |_| None).unwrap();
        let before = fs::read(install.layout.updates().join(RECORD)).unwrap();
        for remote in [
            on(port),
            on(0),
            Remote::Set { port: free_port(), origin: "http://core.example-tailnet.ts.net:8444".into(), login: LOGIN.into() },
            Remote::Set { port: free_port(), origin: format!("{ORIGIN}/somewhere"), login: LOGIN.into() },
            Remote::Set { port: free_port(), origin: ORIGIN.into(), login: format!(" {LOGIN}") },
            Remote::Set { port: free_port(), origin: ORIGIN.into(), login: String::new() },
        ] {
            let outcome = start_with(&install.layout.root, port, WORKSPACE, &remote, QUICK);
            assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("refused"), Some("invalidRemote")), "{remote:?}: {outcome}");
        }
        assert!(starts_seen(&notes).is_empty());
        // Its remote port is another program's: it exits before it records.
        // Taken from free_port too: a bind of port 0 could be given Core's.
        let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, free_port())).unwrap();
        let outcome = start_with(&install.layout.root, port, WORKSPACE, &on(taken.local_addr().unwrap().port()), QUICK);
        assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("failed"), Some("exited")), "{outcome}");
        // So with a Core that fails before it listens.
        fs::write(launch.data_dir.join("exit-early"), "").unwrap();
        let outcome = start_with(&install.layout.root, port, WORKSPACE, &on(free_port()), QUICK);
        assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("failed"), Some("exited")), "{outcome}");
        assert!(outcome["log"].as_str().unwrap().contains("exits early"), "{outcome}");
        assert_eq!(starts_seen(&notes).len(), 2);
        assert_eq!(fs::read(install.layout.updates().join(RECORD)).unwrap(), before);
    }

    /// A stop interrupts this installation's Core, once it is sure which
    /// process that is, and waits for it to go; a start that stays (the
    /// release's helper, with the same --install-dir) is not that process.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_stop_interrupts_this_installations_core_and_waits_for_it_to_go() {
        let install = install();
        compiled(&install, "yuzuno-workspace");
        let port = free_port();
        let launch = launch(&install, port);
        record(&install.layout, &install.running, &launch, WORKSPACE, |_| None).unwrap();
        assert_eq!(stop(&install.layout.root, port, WORKSPACE, QUICK_STOP)["state"], "notRunning");
        let outcome = start(&install.layout.root, port, WORKSPACE, QUICK);
        let core = held(&outcome);
        assert_eq!(outcome["state"], "started", "{outcome}");
        // Standing in for the release's helper: another executable of the
        // release, with the same --install-dir.
        let helper_data = install.temp.path().join("helper");
        fs::create_dir_all(&helper_data).unwrap();
        let mut helper = Command::new(compiled(&install, "yuzuno-update-helper"))
            .arg("--install-dir")
            .arg(&install.layout.root)
            .args(["--port", &free_port().to_string(), "--cwd", "/", "--codex", "codex", "--data-dir"])
            .arg(&helper_data)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !helper_data.join("started").exists() {
            assert!(Instant::now() < deadline, "the helper's stand-in did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
        let stopped = stop(&install.layout.root, port, WORKSPACE, QUICK_STOP);
        let still = helper.try_wait().unwrap().is_none();
        let _ = helper.kill();
        let _ = helper.wait();
        assert_eq!(stopped["state"], "stopped", "{stopped}");
        assert_eq!((&stopped["pid"], &stopped["releaseId"]), (&outcome["pid"], &json!("a")));
        assert!(!alive(&core));
        assert!(still, "the helper was signalled");
        assert!(matches!(probe(&client().unwrap(), port, Some(WORKSPACE)), Answer::Free));
        assert_eq!(stop(&install.layout.root, port, WORKSPACE, QUICK_STOP)["state"], "notRunning");
    }

    /// Nothing that cannot be tied to this installation's one Core is
    /// signalled: an answer from a process outside the installation, another
    /// Workspace or program, a Core of the installation started with another
    /// port or (Linux) not holding it, two Cores of the installation, or a
    /// Core whose executable is not the release it says it runs.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_stop_signals_nothing_it_cannot_tie_to_this_installations_one_core() {
        let install = install();
        compiled(&install, "yuzuno-workspace");
        for (body, code) in [
            // This test process answering as the Core.
            (r#"{"product":"yuzuno","workspaceId":"workspace-1","apiReady":true,"releaseId":"a"}"#, "unidentified"),
            (r#"{"product":"yuzuno","workspaceId":"workspace-1","apiReady":true}"#, "unidentified"),
            (r#"{"product":"yuzuno","workspaceId":"workspace-2"}"#, "otherWorkspaceOnPort"),
            (r#"{"status":"ok"}"#, "portInUse"),
        ] {
            let (port, done) = answer(body);
            record(&install.layout, &install.running, &launch(&install, port), WORKSPACE, |_| None).unwrap();
            let outcome = stop(&install.layout.root, port, WORKSPACE, QUICK_STOP);
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("refused"), Some(code)), "{body}: {outcome}");
        }
        let core_path = install.layout.root.join("releases/a/bin/yuzuno-workspace");
        // A Core of this installation given the port, which does not hold
        // it: this test process answers there. Only Linux can tell who
        // holds a port (holds); macOS takes the one Core of the
        // installation started with it to be the Core that answers.
        #[cfg(target_os = "linux")]
        {
            let (port, done) = answer(r#"{"product":"yuzuno","workspaceId":"workspace-1","apiReady":true,"releaseId":"a"}"#);
            let quiet_data = install.temp.path().join("quiet");
            fs::create_dir_all(&quiet_data).unwrap();
            fs::write(quiet_data.join("no-listen"), "").unwrap();
            let mut quiet = Command::new(&core_path)
                .arg("--install-dir")
                .arg(&install.layout.root)
                .args(["--port", &port.to_string(), "--cwd", "/", "--codex", "codex", "--data-dir"])
                .arg(&quiet_data)
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !quiet_data.join("started").exists() {
                assert!(Instant::now() < deadline, "the quiet Core did not start");
                std::thread::sleep(Duration::from_millis(50));
            }
            record(&install.layout, &install.running, &launch(&install, port), WORKSPACE, |_| None).unwrap();
            let outcome = stop(&install.layout.root, port, WORKSPACE, QUICK_STOP);
            let quiet_alive = quiet.try_wait().unwrap().is_none();
            let _ = quiet.kill();
            let _ = quiet.wait();
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("refused"), Some("unidentified")), "{outcome}");
            assert!(quiet_alive, "a Core not holding the port was signalled");
        }
        // A Core of this installation started with another port is not the
        // one on this port: this test process answers there.
        let (port, done) = answer(r#"{"product":"yuzuno","workspaceId":"workspace-1","apiReady":true,"releaseId":"a"}"#);
        let elsewhere_data = install.temp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere_data).unwrap();
        fs::write(elsewhere_data.join("no-listen"), "").unwrap();
        let mut elsewhere = Command::new(&core_path)
            .arg("--install-dir")
            .arg(&install.layout.root)
            .args(["--port", &free_port().to_string(), "--cwd", "/", "--codex", "codex", "--data-dir"])
            .arg(&elsewhere_data)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !elsewhere_data.join("started").exists() {
            assert!(Instant::now() < deadline, "the other port's Core did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
        record(&install.layout, &install.running, &launch(&install, port), WORKSPACE, |_| None).unwrap();
        let outcome = stop(&install.layout.root, port, WORKSPACE, QUICK_STOP);
        let elsewhere_alive = elsewhere.try_wait().unwrap().is_none();
        let _ = elsewhere.kill();
        let _ = elsewhere.wait();
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("refused"), Some("unidentified")), "{outcome}");
        assert!(elsewhere_alive, "a Core started with another port was signalled");
        let port = free_port();
        let launch = launch(&install, port);
        record(&install.layout, &install.running, &launch, WORKSPACE, |_| None).unwrap();
        let outcome = start(&install.layout.root, port, WORKSPACE, QUICK);
        let core = held(&outcome);
        assert_eq!(outcome["state"], "started", "{outcome}");
        // A second Core of this installation, on another port.
        let second_data = install.temp.path().join("second");
        fs::create_dir_all(&second_data).unwrap();
        let mut second = Command::new(&core_path)
            .arg("--install-dir")
            .arg(&install.layout.root)
            .args(["--port", &free_port().to_string(), "--cwd", "/", "--codex", "codex", "--data-dir"])
            .arg(&second_data)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !second_data.join("started").exists() {
            assert!(Instant::now() < deadline, "the second Core did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(300));
        // It recorded itself; the first one's record back.
        record(&install.layout, &install.running, &launch, WORKSPACE, |_| None).unwrap();
        let outcome = stop(&install.layout.root, port, WORKSPACE, QUICK_STOP);
        let second_alive = second.try_wait().unwrap().is_none();
        let _ = second.kill();
        let _ = second.wait();
        assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("refused"), Some("multipleInstances")), "{outcome}");
        assert!(alive(&core) && second_alive);
        // One Core, saying it runs release b from release a's executable.
        fs::write(launch.data_dir.join("release-id"), "b").unwrap();
        let outcome = stop(&install.layout.root, port, WORKSPACE, QUICK_STOP);
        assert_eq!((outcome["state"].as_str(), outcome["code"].as_str()), (Some("refused"), Some("unidentified")), "{outcome}");
        assert!(alive(&core));
    }

    /// A Core that does not exit when interrupted is said to be stopping and
    /// left as it is: nothing kills it.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_core_that_does_not_exit_is_said_to_be_stopping_and_left_running() {
        let install = install();
        compiled(&install, "yuzuno-workspace");
        let port = free_port();
        let launch = launch(&install, port);
        record(&install.layout, &install.running, &launch, WORKSPACE, |_| None).unwrap();
        fs::write(launch.data_dir.join("ignore-interrupt"), "").unwrap();
        let outcome = start(&install.layout.root, port, WORKSPACE, QUICK);
        let core = held(&outcome);
        assert_eq!(outcome["state"], "started", "{outcome}");
        let stopped = stop(&install.layout.root, port, WORKSPACE, StopBudget { lock: QUICK_STOP.lock, exit: Duration::from_secs(1) });
        assert_eq!((stopped["state"].as_str(), stopped["code"].as_str()), (Some("stopping"), Some("timeout")), "{stopped}");
        assert!(alive(&core), "it was killed");
        assert!(matches!(probe(&client().unwrap(), port, Some(WORKSPACE)), Answer::Ours { .. }));
    }

    /// A Core that has exited while its port is held again (here by a process
    /// it shared its socket with) is said to have stopped, with what holds the
    /// port: not that it may still be finishing.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_core_gone_while_its_port_is_held_again_is_said_to_have_stopped() {
        let install = install();
        compiled(&install, "yuzuno-workspace");
        compiled(&install, "port-keeper");
        let port = free_port();
        let launch = launch(&install, port);
        record(&install.layout, &install.running, &launch, WORKSPACE, |_| None).unwrap();
        fs::write(launch.data_dir.join("hand-over"), "").unwrap();
        let outcome = start(&install.layout.root, port, WORKSPACE, QUICK);
        let core = held(&outcome);
        assert_eq!(outcome["state"], "started", "{outcome}");
        let keeper_pid = launch.data_dir.join("keeper-pid");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !keeper_pid.exists() {
            assert!(Instant::now() < deadline, "the port keeper did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
        let keeper = Held(fs::read_to_string(&keeper_pid).unwrap().parse().ok().and_then(|pid| state::ProcessIdentity::read(pid).ok()));
        let stopped = stop(&install.layout.root, port, WORKSPACE, StopBudget { lock: QUICK_STOP.lock, exit: Duration::from_secs(5) });
        assert_eq!((stopped["state"].as_str(), stopped["portHeldBy"].as_str()), (Some("stopped"), Some("thisWorkspace")), "{stopped}");
        assert!(!alive(&core));
        assert!(alive(&keeper), "the port keeper was signalled");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn options_are_read_as_core_is_given_them() {
        let arguments: Vec<String> = ["--install-dir", "/i", "--port=4317", "--data-dir", "/d"].map(String::from).to_vec();
        assert_eq!(option(&arguments, "--install-dir"), Some("/i"));
        assert_eq!(option(&arguments, "--port"), Some("4317"));
        assert_eq!(option(&arguments, "--data-dir"), Some("/d"));
        assert_eq!(option(&arguments, "--cwd"), None);
        assert_eq!(option(&["--port".to_string()], "--port"), None);
    }

    /// The start profile says where this Core starts again, and on which
    /// platform: in a WSL distribution, or on the Mac it runs on.
    #[test]
    fn the_start_profile_names_its_platform() {
        let install = install();
        let port = 4321;
        let user = || Some("someone".to_string());
        let mac = || Some(Platform::Macos);
        let root = install.layout.root.to_string_lossy().into_owned();
        let not_recorded = json!({"available":false,"reason":"notRecorded"});
        assert_eq!(profile_on(mac(), None, port, WORKSPACE, user), json!({"available":false,"reason":"notManaged"}));
        assert_eq!(profile_on(mac(), Some(&install.layout), port, WORKSPACE, user), not_recorded);
        record(&install.layout, &install.running, &launch(&install, port), WORKSPACE, |_| None).unwrap();
        assert_eq!(
            profile_on(Some(Platform::Wsl("Ubuntu-24.04".into())), Some(&install.layout), port, WORKSPACE, user),
            json!({"available":true,"platform":"wsl","wslDistro":"Ubuntu-24.04","user":"someone","installDir":root,"port":port,"workspaceId":WORKSPACE})
        );
        assert_eq!(
            profile_on(mac(), Some(&install.layout), port, WORKSPACE, user),
            json!({"available":true,"platform":"macos","user":"someone","installDir":root,"port":port,"workspaceId":WORKSPACE})
        );
        // Linux outside WSL, another port or Workspace, no user.
        assert_eq!(profile_on(None, Some(&install.layout), port, WORKSPACE, user), json!({"available":false,"reason":"notWsl"}));
        assert_eq!(profile_on(mac(), Some(&install.layout), port + 1, WORKSPACE, user), not_recorded);
        assert_eq!(profile_on(mac(), Some(&install.layout), port, "workspace-2", user), not_recorded);
        assert_eq!(profile_on(mac(), Some(&install.layout), port, WORKSPACE, || None), json!({"available":false,"reason":"noUser"}));
        #[cfg(target_os = "macos")]
        if std::env::var_os("WSL_DISTRO_NAME").is_none() {
            assert_eq!(Platform::here(), Some(Platform::Macos));
        }
    }

    /// The user database names this process's user, as `id -un` does, and
    /// on macOS always a login shell.
    #[cfg(any(all(target_os = "linux", target_env = "gnu"), target_os = "macos"))]
    #[test]
    fn this_processs_user_and_shell_come_from_the_user_database() {
        let id = Command::new("id").arg("-un").output().unwrap();
        assert!(id.status.success(), "{id:?}");
        let user = user_info().expect("this process's user is in the user database");
        assert_eq!(user.name, String::from_utf8(id.stdout).unwrap().trim());
        if let Some(shell) = &user.shell {
            assert!(shell.is_absolute(), "{}", shell.display());
        }
        #[cfg(target_os = "macos")]
        assert!(user.shell.is_some(), "no login shell for {}", user.name);
    }

    /// An answer to KERN_PROCARGS2 (macOS), laid out as macOS lays it: the
    /// count, the executable's path and its padding, the arguments, then
    /// the environment. Read on every system from these bytes.
    #[test]
    fn macos_process_arguments_are_read_within_their_bytes() {
        fn answer(count: i32, rest: &[u8]) -> Vec<u8> {
            [&count.to_ne_bytes()[..], rest].concat()
        }
        let path: &[u8] = b"/Users/someone/managed/releases/a/bin/yuzuno-workspace\0\0\0\0";
        let full = [
            path,
            b"/Users/someone/managed/releases/a/bin/yuzuno-workspace\0",
            b"--install-dir\0/Users/someone/my managed\0--port\0",
            b"4317\0",
            b"PATH=/usr/bin\0HOME=/Users/someone\0",
        ]
        .concat();
        assert_eq!(procargs(&answer(5, &full)), Some(["--install-dir", "/Users/someone/my managed", "--port", "4317"].map(String::from).to_vec()));
        // As many as the count says, and no more: the environment is not read.
        assert_eq!(procargs(&answer(2, &full)), Some(vec!["--install-dir".to_string()]));
        assert_eq!(procargs(&answer(1, &full)), Some(vec![]));
        // An empty argument is one; the path may have no padding.
        assert_eq!(procargs(&answer(3, &[path, b"program\0\0--x\0"].concat())), Some(vec![String::new(), "--x".into()]));
        assert_eq!(procargs(&answer(2, b"/bin/p\0p\0--y\0")), Some(vec!["--y".to_string()]));
        // More than there are, a count of none or less, and answers that
        // end early: none.
        for bytes in [
            answer(8, &full),
            answer(0, &full),
            answer(-1, &full),
            answer(2, b"/bin/p"),
            answer(2, b"/bin/p\0\0\0"),
            answer(2, b"/bin/p\0p\0--y"),
            vec![1, 0],
            vec![],
        ] {
            assert_eq!(procargs(&bytes), None, "{bytes:?}");
        }
    }

    /// The system lists this process, and a Core's arguments are read as it
    /// was given them, spaces and empty ones included.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn processes_are_listed_and_their_arguments_read() {
        assert!(process_ids().map_err(|stop| stop.message).unwrap().contains(&std::process::id()));
        assert_eq!(arguments(std::process::id()), Some(std::env::args().skip(1).collect::<Vec<_>>()));
        let install = install();
        let data = install.temp.path().join("data with space");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("no-listen"), "").unwrap();
        let (root, data_dir) = (install.layout.root.to_string_lossy().into_owned(), data.to_string_lossy().into_owned());
        let given: Vec<String> = [
            "--install-dir", root.as_str(), "--port", "4317", "--cwd", "/", "--codex", "codex", "--data-dir", data_dir.as_str(), "a b", "",
        ]
        .map(String::from)
        .to_vec();
        let mut core = Command::new(compiled(&install, "yuzuno-workspace")).args(&given).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !data.join("started").exists() {
            assert!(Instant::now() < deadline, "the stand-in did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
        let read = arguments(core.id());
        let listed = process_ids().map_err(|stop| stop.message).unwrap().contains(&core.id());
        let _ = core.kill();
        let _ = core.wait();
        assert_eq!(read, Some(given));
        assert!(listed);
        // A process that has gone has none.
        assert_eq!(arguments(core.id()), None);
    }
}
