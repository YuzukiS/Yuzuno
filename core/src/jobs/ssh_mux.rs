//! One Core-private OpenSSH connection per machine for remote-Job helper
//! calls (T-163). Each call used to make its own connection: a full SSH
//! handshake for every status check, log page and control. Calls now open
//! a session on a master connection this Core starts and owns:
//! - a call never waits for a master, nor fails because of one: a master is
//!   started apart from the call that first needs it, and every call that
//!   finds none ready connects itself, exactly as before. A machine that
//!   refuses or cannot be reached answers each call as it always did;
//! - its socket is in a directory of this Core process alone: private
//!   (0700, this user's, not a link), under `$XDG_RUNTIME_DIR` or `/tmp`.
//!   A path too long for a Unix socket or that OpenSSH would read otherwise
//!   (`%`, whitespace, quotes), or a directory that cannot be made private,
//!   means no master;
//! - it is never the user's ControlMaster or ControlPersist, nor a socket an
//!   earlier Core left: each process names its own directory, and removes
//!   those of Cores that have ended;
//! - it is this Core's child. Dropped, it is killed. On Linux it is also sent
//!   SIGTERM when the runtime thread that started it ends, which a killed
//!   Core's threads do (PR_SET_PDEATHSIG; tested with SIGKILL). Where libc
//!   is not available to Core (other than Linux with glibc), no directory
//!   is made, and every call connects itself;
//! - after `idle` without a call or after `age`, it ends once no call is
//!   using it: a call in progress is never cut off;
//! - a call uses a master only for where OpenSSH would connect now: the
//!   key names the machine, its target and that target's resolved
//!   configuration (`ssh -G`, which connects to nothing), so a target or an
//!   SSH configuration pointed elsewhere is another connection. A name whose
//!   address changes in DNS is followed once its master retires (`age`);
//! - one that cannot be made is not tried again for `retry`;
//! - a master carries one call at a time. sshd allows `MaxSessions`
//!   sessions per connection (10 by default, as few as 1 where hardened)
//!   and refuses the rest, and OpenSSH does not then connect directly: a
//!   call that finds its master busy connects itself, as before.
//!
//! The master authenticates and checks the host key as any call did (the
//! same options); calls through it reuse that authenticated connection. A
//! call sends and reads exactly what it did before, once: where the socket
//! does not answer, OpenSSH connects directly before sending anything
//! (ControlMaster=no). A call whose master ends during it has no answer, as
//! when a connection drops: unknown stays unknown, and nothing is sent again.
use crate::remote::{ssh_with_control, Control, RemoteMachine};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A Unix socket path's limit (`sun_path`, with its NUL) less the 17 bytes
/// OpenSSH appends to the path while it makes the socket.
const SOCKET_PATH_LIMIT: usize = 108 - 1 - 17;
/// How long a master may take to connect: `ConnectTimeout` and a margin.
const CONNECT_WAIT: Duration = Duration::from_secs(12);
/// Calls a master carries at once; within any sshd's `MaxSessions`.
const SESSIONS: usize = 1;

pub(crate) struct Mux {
    /// Where this process's sockets are made, chosen on first use; None when
    /// no private directory with short enough paths could be made.
    dir: OnceLock<Option<PathBuf>>,
    base: Option<PathBuf>,
    idle: Duration,
    age: Duration,
    retry: Duration,
    sessions: usize,
    slots: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
}

#[derive(Default)]
struct Slot {
    master: Option<Master>,
    /// A master is being started for this key.
    starting: bool,
    failed: Option<Instant>,
    #[cfg(test)]
    starts: usize,
}

struct Master {
    child: tokio::process::Child,
    path: PathBuf,
    started: Instant,
    used: Instant,
    /// One more holder for each call using it (`Lease`).
    calls: Arc<()>,
}

/// A master's socket, held for as long as a call uses it.
pub(crate) struct Lease {
    pub(crate) path: PathBuf,
    _call: Arc<()>,
}

impl Default for Mux {
    fn default() -> Self {
        Self::new(None, Duration::from_secs(60), Duration::from_secs(300), Duration::from_secs(60))
    }
}

fn key(machine: &RemoteMachine, destination: &str) -> String {
    format!("{}\n{}\n{destination}", machine.id, machine.target)
}

/// Where OpenSSH would connect for `target` now, as a digest of its
/// resolved configuration (`ssh -G`: it reads the configuration and connects
/// to nothing); None when that cannot be read, and the call connects itself.
pub(crate) async fn destination(program: &str, target: &str) -> Option<String> {
    let mut command = ssh_with_control(program, Control::Off);
    command.arg("-G").arg(target).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await.ok()?.ok()?;
    output.status.success().then(|| format!("{:x}", Sha256::digest(&output.stdout)))
}

impl Mux {
    /// `base` is where the process directory is made (None: the default),
    /// and the durations as in the module's description.
    pub(crate) fn new(base: Option<PathBuf>, idle: Duration, age: Duration, retry: Duration) -> Self {
        Self { dir: OnceLock::new(), base, idle, age, retry, sessions: SESSIONS, slots: Default::default() }
    }

    /// The same, with masters that carry `sessions` calls at once, for tests.
    #[cfg(test)]
    pub(crate) fn with_sessions(self, sessions: usize) -> Self {
        Self { sessions, ..self }
    }

    /// The socket of a live master for `machine`, for one call; None when
    /// none is ready or it is carrying all the calls it may, and the call
    /// connects itself. Where none is ready, a master is then started for
    /// the calls after it, unless one is being started or the last one could
    /// not be made within `retry`.
    pub(crate) fn client(&self, program: &str, machine: &RemoteMachine, destination: &str) -> Option<Lease> {
        let dir = self.dir()?;
        let key = key(machine, destination);
        let slot = self.slots.lock().unwrap().entry(key.clone()).or_default().clone();
        {
            let mut held = slot.lock().unwrap();
            if let Some(master) = &mut held.master {
                if self.spent(master) {
                    held.master = None;
                } else if Arc::strong_count(&master.calls) > self.sessions {
                    return None;
                } else {
                    master.used = Instant::now();
                    return Some(Lease { path: master.path.clone(), _call: master.calls.clone() });
                }
            }
            if held.starting || held.failed.is_some_and(|at| at.elapsed() < self.retry) {
                return None;
            }
            held.starting = true;
            #[cfg(test)]
            {
                held.starts += 1;
            }
        }
        let name = format!("{:x}", Sha256::digest(key.as_bytes()));
        let (program, target, path) = (program.to_owned(), machine.target.clone(), dir.join(&name[..16]));
        tokio::spawn(async move {
            let master = start(&program, &target, &path).await;
            let mut held = slot.lock().unwrap();
            held.starting = false;
            match master {
                Some(master) => {
                    held.master = Some(master);
                    held.failed = None;
                }
                None => held.failed = Some(Instant::now()),
            }
        });
        None
    }

    /// Ends the masters that have stopped, or that no call uses and have
    /// been idle or alive too long.
    pub(crate) fn sweep(&self) {
        let slots: Vec<_> = self.slots.lock().unwrap().values().cloned().collect();
        for slot in slots {
            let mut held = slot.lock().unwrap();
            if held.master.as_mut().is_some_and(|master| self.spent(master)) {
                held.master = None;
            }
        }
    }

    /// It has stopped, or no call uses it and it has been idle or alive too long.
    fn spent(&self, master: &mut Master) -> bool {
        !matches!(master.child.try_wait(), Ok(None))
            || (Arc::strong_count(&master.calls) == 1
                && (master.used.elapsed() >= self.idle || master.started.elapsed() >= self.age))
    }

    fn dir(&self) -> Option<PathBuf> {
        self.dir.get_or_init(|| private_dir(self.base.clone())).clone()
    }

    /// `machine`'s slot for where its target leads now, for tests.
    #[cfg(test)]
    fn slot(&self, machine: &RemoteMachine) -> Option<Arc<Mutex<Slot>>> {
        let slots = self.slots.lock().unwrap();
        let prefix = format!("{}\n{}\n", machine.id, machine.target);
        let mut matching = slots.iter().filter(|(key, _)| key.starts_with(&prefix));
        let found = matching.next().map(|(_, slot)| slot.clone());
        assert!(matching.next().is_none(), "tests ask by machine only while it has one destination");
        found
    }

    /// The masters' sockets, for tests.
    #[cfg(test)]
    pub(crate) fn socket_dir(&self) -> Option<PathBuf> {
        self.dir()
    }

    /// How many masters were started for `machine`, for tests.
    #[cfg(test)]
    pub(crate) fn starts(&self, machine: &RemoteMachine) -> usize {
        self.slot(machine).map_or(0, |slot| slot.lock().unwrap().starts)
    }

    /// Whether a master for `machine` is ready, and whether one is being
    /// started, for tests.
    #[cfg(test)]
    pub(crate) fn state(&self, machine: &RemoteMachine) -> (bool, bool) {
        self.slot(machine).map_or((false, false), |slot| {
            let held = slot.lock().unwrap();
            (held.master.is_some(), held.starting)
        })
    }

    /// The process ID of `machine`'s master, for tests.
    #[cfg(test)]
    pub(crate) fn master_pid(&self, machine: &RemoteMachine) -> Option<u32> {
        self.slot(machine)?.lock().unwrap().master.as_ref()?.child.id()
    }

    /// Ends `machine`'s master as if it had stopped by itself, for tests.
    #[cfg(test)]
    pub(crate) fn kill_master_for_test(&self, machine: &RemoteMachine) {
        if let Some(slot) = self.slot(machine) {
            if let Some(master) = &mut slot.lock().unwrap().master {
                let _ = master.child.start_kill();
            }
        }
    }
}

/// A master for `target` at `path`, once its socket is there; None when it
/// gave up or did not connect in time (it is then killed).
async fn start(program: &str, target: &str, path: &Path) -> Option<Master> {
    // A socket of an earlier master of this process, which has ended:
    // OpenSSH makes no master where a file is already.
    let _ = std::fs::remove_file(path);
    let mut command = ssh_with_control(program, Control::Master(path));
    command
        .args(["-N", "-o", "ClearAllForwardings=yes"])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: prctl is async-signal-safe and touches only the child.
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_socket()) {
            return Some(Master { child, path: path.to_owned(), started, used: started, calls: Arc::new(()) });
        }
        if !matches!(child.try_wait(), Ok(None)) || started.elapsed() >= CONNECT_WAIT {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

impl Drop for Mux {
    fn drop(&mut self) {
        // The children end with their Child (kill_on_drop); their sockets go
        // with the directory.
        self.slots.lock().unwrap().clear();
        if let Some(Some(dir)) = self.dir.get() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// This process's own socket directory, under a private base, with room for
/// a socket name; directories left by Cores that have ended are removed.
fn private_dir(base: Option<PathBuf>) -> Option<PathBuf> {
    let base = base.or_else(default_base)?;
    let uid = euid()?;
    let private = |path: &Path| std::fs::symlink_metadata(path)
        .is_ok_and(|meta| meta.is_dir() && meta.uid() == uid && meta.mode() & 0o077 == 0);
    if !private(&base) {
        std::fs::DirBuilder::new().mode(0o700).create(&base).ok()?;
        if !private(&base) {
            return None;
        }
    }
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let ended = entry.file_name().to_str().and_then(|name| name.split('-').next()?.parse::<u32>().ok())
                .is_some_and(|pid| !Path::new(&format!("/proc/{pid}")).exists());
            if ended {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    let nonce = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let dir = base.join(format!("{}-{nonce}", std::process::id()));
    // OpenSSH expands %-tokens and a leading ~ in ControlPath, and splits an
    // option's value at whitespace and quotes.
    let text = dir.to_str()?;
    if text.contains(|c: char| c == '%' || c == '"' || c == '\'' || c.is_whitespace())
        || !dir.is_absolute()
        || text.len() + 1 + 16 > SOCKET_PATH_LIMIT
    {
        return None;
    }
    std::fs::DirBuilder::new().mode(0o700).create(&dir).ok()?;
    private(&dir).then_some(dir)
}

fn default_base() -> Option<PathBuf> {
    let uid = euid()?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from)
        .filter(|dir| dir.is_absolute() && std::fs::symlink_metadata(dir)
            .is_ok_and(|meta| meta.is_dir() && meta.uid() == uid && meta.mode() & 0o077 == 0));
    Some(match runtime {
        Some(dir) => dir.join("yuzuno-ssh"),
        None => PathBuf::from(format!("/tmp/yuzuno-ssh-{uid}")),
    })
}

/// This process's effective user, where Core has libc.
fn euid() -> Option<u32> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: geteuid only reads this process's credentials.
        Some(unsafe { libc::geteuid() })
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    {
        None
    }
}
