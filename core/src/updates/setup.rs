//! Installing a signed release as a new managed installation and starting
//! its Core for the first time (YN-107): what the desktop app runs in the
//! user's own WSL distribution, as the user, to set up a Core without a
//! terminal. `install` is run by the helper of the unpacked release itself;
//! `first-start` by the installed release's helper, since `updates/start`
//! exists only once a Core has recorded how it started. Each prints one JSON
//! line with a `state`, as `updates/start` does. Neither depends on WSL.
use super::{
    catalog, package, releases,
    start::{self, failed, refused, Answer, Record, Remote, Stop},
    state::{Launch, Layout},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{ErrorKind, Read},
    os::unix::{
        fs::{DirBuilderExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

impl From<Stop> for Value {
    fn from(stop: Stop) -> Value {
        start::result_of(Err(stop))
    }
}

/// `stop`'s result with `fields` added.
fn with(stop: Stop, fields: Value) -> Value {
    let mut outcome = Value::from(stop);
    if let (Some(outcome), Value::Object(fields)) = (outcome.as_object_mut(), fields) {
        outcome.extend(fields);
    }
    outcome
}

/// Installs the release unpacked at `bundle`, whose signed manifest hashes to
/// `manifest_sha256`, as a new managed installation at `root`, as
/// `register --initialize` does (every file checked again), then lets Core
/// update it from `repository`, signed with `public_key`
/// (`release-source.json`). Starts nothing. The result's `state`:
/// `installed`, or `refused` (nothing written) or `failed`, with a `code` and
/// `message`. When registering fails, `root` is removed only if this install
/// made it and no release was installed there (`"cleaned":true`).
pub fn install(
    root: &Path,
    bundle: &Path,
    manifest_sha256: &str,
    reviewed_source: &str,
    repository: &str,
    public_key: &str,
) -> Value {
    if let Err(error) = releases::validate_source(repository, public_key) {
        return refused("invalidSource", format!("{error:#}. Nothing was written.")).into();
    }
    if !root.is_absolute() {
        return refused("invalidInstallDir", format!("The installation folder must be an absolute path, not {}.", root.display())).into();
    }
    if fs::symlink_metadata(root.join("current.json")).is_ok() {
        return refused("installed", format!("A Yuzuno installation is already at {}; nothing was written.", root.display())).into();
    }
    let created = match make_root(root) {
        Ok(created) => created,
        Err(stop) => return stop.into(),
    };
    if let Err(error) = catalog::register(root, bundle, manifest_sha256, reviewed_source, true) {
        let (cleaned, problem) = remove_if_made(root, created);
        let mut outcome = with(failed("register", format!("{error:#}")), json!({"cleaned":cleaned}));
        if let Some(problem) = problem {
            outcome["cleanError"] = json!(problem);
        }
        return outcome;
    }
    let installed = Layout::open(root)
        .map_err(|error| failed("error", format!("{error:#}")))
        .and_then(|layout| Ok((start::installed_core(&layout)?.0, layout)));
    let (release, layout) = match installed {
        Ok(installed) => installed,
        Err(stop) => return stop.into(),
    };
    let source = package::atomic_json(
        &layout.root.join("release-source.json"),
        &json!({"repository":repository,"publicKey":public_key}),
    )
    .and_then(|()| releases::read_source(&layout));
    let mut outcome = json!({"state":"installed","releaseId":release,"installDir":layout.root,"releaseSource":source.is_ok()});
    if let Err(error) = source {
        outcome["releaseSourceError"] = json!(format!("{error:#}"));
    }
    outcome
}

/// Makes `root`, private to this user, with any missing parents, unless
/// something is there already. True only when this call made `root` itself:
/// a single `mkdir` that fails if anything is there, so another install of
/// the same folder at the same time never counts it as its own.
fn make_root(root: &Path) -> Result<bool, Stop> {
    match fs::symlink_metadata(root) {
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(failed("error", format!("{}: {error}", root.display()))),
    }
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent).map_err(|error| failed("error", format!("Cannot make {}: {error}", parent.display())))?;
    }
    match fs::DirBuilder::new().mode(0o700).create(root) {
        Ok(()) => {
            // As register makes it, whatever the umask.
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))
                .map_err(|error| failed("error", format!("{}: {error}", root.display())))?;
            Ok(true)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(failed("error", format!("Cannot make {}: {error}", root.display()))),
    }
}

/// After registering failed: removes `root` only when this install made it
/// (`created`), no release was installed there (no `current.json`) and it is
/// still a folder, not a link. Never its parents or anything else. Whether
/// it was removed, and why not when that failed.
fn remove_if_made(root: &Path, created: bool) -> (bool, Option<String>) {
    let folder = fs::symlink_metadata(root).is_ok_and(|meta| meta.file_type().is_dir());
    if !created || !folder || fs::symlink_metadata(root.join("current.json")).is_ok() {
        return (false, None);
    }
    match fs::remove_dir_all(root) {
        Ok(()) => (true, None),
        Err(error) => (false, Some(format!("Cannot remove {}: {error}", root.display()))),
    }
}

/// What `first-start` starts: the Core installed at `root`, on `port`, with
/// its Workspace in `data_dir` and Agents starting in `cwd`.
pub struct FirstStart {
    pub root: PathBuf,
    pub port: u16,
    pub data_dir: PathBuf,
    pub cwd: PathBuf,
    /// Core's `--codex`; Core's own default when None.
    pub codex: Option<String>,
}

/// How long a first start may wait: for another start of this installation,
/// for something on the port to answer, for the login shell, and for the
/// started Core to answer. The defaults add up to less than the desktop's
/// 180 s wait for the result (desktop/src/main.rs `START_WAIT`).
#[derive(Clone, Copy)]
pub struct FirstBudget {
    pub lock: Duration,
    pub port: Duration,
    pub shell: Duration,
    pub ready: Duration,
}
impl Default for FirstBudget {
    fn default() -> Self {
        Self {
            lock: Duration::from_secs(30),
            port: Duration::from_secs(10),
            shell: Duration::from_secs(10),
            ready: Duration::from_secs(120),
        }
    }
}

/// Starts the Core of a new installation, which has not recorded how it
/// starts yet, with the environment of the user's login shell
/// ([`login_environment`]). The result's `state`: `started` (with the
/// Workspace it opened and whether it `recorded` how it started, which later
/// starts use), `starting` (started, not answering yet; nothing is stopped),
/// `refused` (nothing started; `recorded` when a Core of it recorded already:
/// use `start`) or `failed`, with a `code` and `message`.
pub fn first_start(request: &FirstStart, budget: FirstBudget) -> Value {
    let shell = start::user_info()
        .and_then(|user| user.shell)
        .unwrap_or_else(|| PathBuf::from(if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }));
    first_start_with(request, &shell, budget)
}

fn first_start_with(request: &FirstStart, shell: &Path, budget: FirstBudget) -> Value {
    try_first_start(request, shell, budget).unwrap_or_else(|outcome| outcome)
}

fn try_first_start(request: &FirstStart, shell: &Path, budget: FirstBudget) -> Result<Value, Value> {
    let FirstStart { root, port, data_dir, cwd, codex } = request;
    let port = *port;
    if port == 0 {
        return Err(refused("invalidPort", "Give Core a port from 1 to 65535.").into());
    }
    if !data_dir.is_absolute() || data_dir.components().any(|part| part == Component::ParentDir) {
        return Err(refused("invalidDataDir", format!("The Workspace folder must be an absolute path without '..', not {}.", data_dir.display())).into());
    }
    if !cwd.is_absolute() {
        return Err(refused("invalidCwd", format!("The working folder must be an absolute path, not {}.", cwd.display())).into());
    }
    let launch = Launch { port, data_dir: data_dir.clone(), cwd: cwd.clone(), codex: codex.clone().unwrap_or_else(|| "codex".into()) };
    launch.check_cwd().map_err(|error| refused("invalidCwd", format!("{error:#}")))?;
    let (layout, _lock) = start::open_locked(root, budget.lock)?;
    // As Core refuses it (core/src/main.rs), before anything starts.
    let packages = [layout.root.join("releases"), layout.root.join("incoming")];
    if packages.iter().any(|dir| resolved(data_dir).starts_with(dir) || data_dir.starts_with(dir)) {
        return Err(refused("invalidDataDir", "The Workspace folder must be outside the installation's release packages.").into());
    }
    if let Some(record) = start::read_record(&layout) {
        return Err(with(
            refused("recorded", "This installation's Core has started before; start it as it recorded."),
            json!({"port":record.port,"workspaceId":record.workspace_id}),
        ));
    }
    start::refuse_while_switching(&layout)?;
    let client = start::client().map_err(|error| failed("error", error.to_string()))?;
    let until = Instant::now() + budget.port;
    loop {
        match start::probe(&client, port, None) {
            Answer::Free => break,
            Answer::Ours { workspace, .. } => {
                return Err(with(refused("coreOnPort", format!("A Yuzuno Core already answers on port {port}.")), json!({"workspaceId":workspace})))
            }
            Answer::Workspace => return Err(refused("coreOnPort", format!("A Yuzuno Core already answers on port {port}.")).into()),
            Answer::Other => return Err(refused("portInUse", format!("Port {port} is used by something other than Yuzuno Core.")).into()),
            Answer::Silent if Instant::now() < until => std::thread::sleep(Duration::from_millis(250)),
            Answer::Silent => return Err(refused("portInUse", format!("Something holds port {port} but does not answer as Yuzuno Core.")).into()),
        }
    }
    let environment = login_environment(shell, cwd, budget.shell);
    let (release, core) = start::installed_core(&layout)?;
    let (log, log_path, offset) = start::open_log(&layout)?;
    let record = Record {
        port,
        data_dir: launch.data_dir,
        cwd: launch.cwd,
        codex: launch.codex,
        workspace_id: String::new(),
        environment: environment.values,
        recorded_at: String::new(),
    };
    let mut child = start::spawn(&core, &layout, &record, log, &Remote::Recorded)
        .map_err(|error| failed("spawn", format!("Cannot start Core: {error}")))?;
    let pid = child.id();
    let until = Instant::now() + budget.ready;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(Stop { log: start::tail(&log_path, offset), ..failed("exited", format!("Core exited before it answered ({status}).")) }.into());
        }
        match start::probe(&client, port, None) {
            Answer::Ours { ready: true, workspace, .. } if !workspace.is_empty() => {
                // The Core that answers is the one started here, when the
                // system can tell (Linux: it holds the port's socket).
                if start::holds(pid, port) == Some(false) {
                    return Err(failed("portInUse", format!("Another Yuzuno Core answers on port {port}; Core (process {pid}) was left as it is.")).into());
                }
                let recorded = start::read_record(&layout).is_some_and(|record| record.port == port && record.workspace_id == workspace);
                let mut outcome = json!({"state":"started","pid":pid,"releaseId":release,"workspaceId":workspace,"port":port,
                    "installDir":layout.root,"recorded":recorded,"environment":environment.source,"shell":shell});
                if let Some(note) = environment.note {
                    outcome["environmentNote"] = json!(note);
                }
                return Ok(outcome);
            }
            Answer::Workspace | Answer::Other => {
                return Err(failed("portInUse", format!("Something else took port {port} while Core started; Core (process {pid}) was left as it is.")).into())
            }
            _ if Instant::now() < until => std::thread::sleep(Duration::from_millis(250)),
            _ => return Ok(json!({"state":"starting","pid":pid,"releaseId":release,"port":port})),
        }
    }
}

/// `path` with its nearest existing ancestor's links resolved.
fn resolved(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut base = path;
    loop {
        if let Ok(real) = fs::canonicalize(base) {
            return rest.iter().rev().fold(real, |path, part| path.join(part));
        }
        match (base.parent(), base.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                base = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// The environment a first start gives Core: [`start::ENVIRONMENT`]'s
/// values, from the user's login shell or else this process's.
pub(super) struct Environment {
    pub values: BTreeMap<String, String>,
    /// `loginShell` or `inherited`.
    pub source: &'static str,
    /// Why the login shell's was not used: `unsupportedShell`, `timeout`,
    /// `noMarkers` or `spawnFailed`.
    pub note: Option<&'static str>,
}

/// The most of a login shell's output that is read.
const MAX_OUTPUT: usize = 1024 * 1024;

/// [`start::ENVIRONMENT`] as the user's login shell `shell`, started in
/// `cwd`, sets it, as a terminal would have it: `wsl.exe --exec` runs no
/// shell, so its PATH lacks what the user's profile adds (`~/.local/bin`,
/// nvm). As VS Code reads it (src/vs/platform/shell/node/shellEnv.ts): the
/// shell runs interactive and login (`-i -l -c`; csh and tcsh `-ic`) with
/// stdin from /dev/null, prints `env -0` between two random marks, and only
/// that is read; in its own session, so it takes no terminal, and its whole
/// process group is killed if it has not finished within `wait`. Shells
/// that take other options are not run. Without it, this process's own
/// values (`inherited`), with why.
pub(super) fn login_environment(shell: &Path, cwd: &Path, wait: Duration) -> Environment {
    match read_login_shell(shell, cwd, wait) {
        Ok(values) => Environment { values, source: "loginShell", note: None },
        Err(note) => Environment {
            values: start::ENVIRONMENT
                .iter()
                .filter_map(|name| Some((name.to_string(), std::env::var(name).ok().filter(|value| value.len() <= start::MAX_VALUE)?)))
                .collect(),
            source: "inherited",
            note: Some(note),
        },
    }
}

fn read_login_shell(shell: &Path, cwd: &Path, wait: Duration) -> Result<BTreeMap<String, String>, &'static str> {
    let options: &[&str] = match shell.file_name().and_then(|name| name.to_str()) {
        Some("bash" | "zsh" | "sh" | "dash" | "ksh" | "mksh" | "fish") => &["-i", "-l", "-c"],
        Some("csh" | "tcsh") => &["-ic"],
        _ => return Err("unsupportedShell"),
    };
    let mark = uuid::Uuid::new_v4().simple().to_string()[..16].to_owned();
    let mut command = Command::new(shell);
    command
        .args(options)
        .arg(format!("printf '%s' {mark}; /usr/bin/env -0; printf '%s' {mark}"))
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        command.pre_exec(|| rustix::process::setsid().map(|_| ()).map_err(std::io::Error::from));
    }
    let mut child = command.spawn().map_err(|_| "spawnFailed")?;
    let mut stdout = child.stdout.take().ok_or("spawnFailed")?;
    let (sender, chunks) = mpsc::channel::<Vec<u8>>();
    // Reads until the shell's output ends, or until no one listens: a
    // program the shell's profile left running may keep the output open.
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        while let Ok(read @ 1..) = stdout.read(&mut buffer) {
            if sender.send(buffer[..read].to_vec()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + wait;
    let mut output = Vec::new();
    let mut found = None;
    while found.is_none() && output.len() <= MAX_OUTPUT {
        match chunks.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(chunk) => {
                output.extend_from_slice(&chunk);
                found = between_marks(&output, mark.as_bytes());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                end_group(&mut child);
                return Err("timeout");
            }
        }
    }
    drop(chunks);
    // The shell ends once it has printed; past the wait, it and what it
    // started in its group are ended.
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                end_group(&mut child);
                if found.is_none() {
                    return Err("timeout");
                }
                break;
            }
        }
    }
    let (from, to) = found.ok_or("noMarkers")?;
    Ok(output[from..to]
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            let (name, value) = std::str::from_utf8(entry).ok()?.split_once('=')?;
            (start::ENVIRONMENT.contains(&name) && value.len() <= start::MAX_VALUE).then(|| (name.to_owned(), value.to_owned()))
        })
        .collect())
}

/// Where `env -0`'s output is in `output`: after the first `mark`, up to the
/// `mark` that ends it. That one follows the NUL ending env's last entry, or
/// the first mark at once when there are none, so a mark inside a value
/// does not end it early.
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

/// Kills the shell's process group (the shell leads it) and reaps the shell.
/// The shell is not reaped before this, so its process ID still names it.
fn end_group(child: &mut Child) {
    if let Some(group) = rustix::process::Pid::from_raw(child.id() as i32) {
        let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests;
