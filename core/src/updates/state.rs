//! Durable operation journal shared by Core and its narrowly scoped helper.
use super::package::{atomic_json, valid_id, Bundle};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub const KEEP_RELEASES: usize = 3;
pub const WAIT_SECONDS: i64 = 30 * 60;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Preparing,
    Prepared,
    Waiting,
    Flushing,
    Stopping,
    Starting,
    Restoring,
    Complete,
    RolledBack,
    Failed,
    Cancelled,
}
impl Phase {
    pub fn active(self) -> bool {
        matches!(
            self,
            Self::Preparing
                | Self::Waiting
                | Self::Flushing
                | Self::Stopping
                | Self::Starting
                | Self::Restoring
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseRef {
    pub release_id: String,
    pub manifest_sha256: String,
}
impl From<&Bundle> for ReleaseRef {
    fn from(bundle: &Bundle) -> Self {
        Self {
            release_id: bundle.manifest.release_id.clone(),
            manifest_sha256: bundle.manifest_sha256.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub port: u16,
    pub data_dir: PathBuf,
    pub cwd: PathBuf,
    pub codex: String,
}

impl Launch {
    /// Whether a Core can start in `cwd`, its `--cwd` and working directory,
    /// the candidate's and, after a failed update, the previous release's
    /// alike: it exists, is a directory and can be entered (T-11). This is
    /// checked at that moment; the directory can still go away afterwards.
    pub fn check_cwd(&self) -> Result<()> {
        let cwd = &self.cwd;
        let metadata = fs::metadata(cwd)
            .with_context(|| format!("Core's launch directory {} is missing or unreadable", cwd.display()))?;
        ensure!(metadata.is_dir(), "Core's launch directory {} is not a directory", cwd.display());
        rustix::fs::access(cwd, rustix::fs::Access::EXEC_OK)
            .with_context(|| format!("Core's launch directory {} cannot be entered", cwd.display()))?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_ticks: u64,
    pub executable: PathBuf,
}
impl ProcessIdentity {
    #[cfg(target_os = "linux")]
    pub fn read(pid: u32) -> Result<Self> {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
        // comm can contain spaces and ')'; fields after the final ')' begin at state (3).
        let fields = stat
            .rsplit_once(')')
            .context("Malformed process identity")?
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        ensure!(fields.first() != Some(&"Z"), "Process has exited");
        let start_ticks = fields
            .get(19)
            .context("Missing process start time")?
            .parse()?;
        let executable = fs::read_link(format!("/proc/{pid}/exe"))?;
        Ok(Self {
            pid,
            start_ticks,
            executable,
        })
    }
    /// macOS has no /proc: the same three facts come from libproc, as the
    /// remote Jobs helper reads them there (jobs/remote_job.py, darwin_proc).
    ///
    /// `start_ticks` here is not clock ticks since boot, as on Linux, but
    /// the process's start time in microseconds since the Unix epoch
    /// (`pbi_start_tvsec * 1e6 + pbi_start_tvusec`), which the kernel sets
    /// once and never changes for the process's lifetime. Like Linux's, it
    /// is compared only with a value read on the same machine in the same
    /// boot: equal means the same process, and a PID used again by another
    /// process has another start time.
    #[cfg(target_os = "macos")]
    pub fn read(pid: u32) -> Result<Self> {
        use std::os::unix::ffi::OsStrExt;
        // PID 0 is the kernel, not a process to act on; one past c_int is
        // none (proc_pidinfo takes c_int).
        let raw = libc::c_int::try_from(pid)
            .ok()
            .filter(|&raw| raw > 0)
            .with_context(|| format!("No process {pid}"))?;
        let started = darwin::start_time(raw)?;
        let mut path = [0u8; darwin::PATH_MAX];
        // SAFETY: `path` is a live, writable buffer of PATH_MAX (4096) bytes
        // and that length is what proc_pidpath is told it may write.
        let written = unsafe {
            libc::proc_pidpath(raw, path.as_mut_ptr().cast(), darwin::PATH_MAX as u32)
        };
        // It answers the path's length without its NUL, or 0 or less on
        // failure (the process has gone, or has no executable any more).
        let length = usize::try_from(written)
            .ok()
            .filter(|&length| length > 0 && length < darwin::PATH_MAX)
            .ok_or_else(std::io::Error::last_os_error)
            .with_context(|| format!("Cannot read the executable of process {pid}"))?;
        let executable = PathBuf::from(std::ffi::OsStr::from_bytes(&path[..length]));
        // The start time and the path are of one process only if the PID
        // still names it after the path was read: had it exited in between
        // and its PID been given to another, that one has another start time.
        ensure!(
            darwin::start_time(raw)? == started,
            "Process {pid} changed while it was read"
        );
        Ok(Self {
            pid,
            start_ticks: started,
            executable,
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub fn read(_pid: u32) -> Result<Self> {
        anyhow::bail!("Managed Core updates require Linux/WSL or macOS")
    }
    pub fn alive(&self) -> bool {
        Self::read(self.pid).is_ok_and(|live| live == *self)
    }
}

#[cfg(target_os = "macos")]
mod darwin {
    use anyhow::{ensure, Context, Result};

    /// PROC_PIDPATHINFO_MAXSIZE, sys/proc_info.h: 4 × MAXPATHLEN.
    pub(super) const PATH_MAX: usize = libc::PROC_PIDPATHINFO_MAXSIZE as usize;

    /// A live process's start time in microseconds since the Unix epoch,
    /// from proc_pidinfo(PROC_PIDTBSDINFO). A process that has gone and one
    /// that has exited but is not yet reaped (a zombie) both have none, as
    /// reading /proc/<pid>/stat says for Z on Linux.
    pub(super) fn start_time(pid: libc::c_int) -> Result<u64> {
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: `info` is a writable proc_bsdinfo of `size` bytes, and
        // `size` is the length proc_pidinfo is told it may write. arg 0 asks
        // for live processes only.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size as libc::c_int,
            )
        };
        // It answers the bytes it wrote: the whole structure, or 0 or less
        // with errno set (ESRCH: no such live process). A shorter answer is
        // not read as a process.
        match usize::try_from(written) {
            Ok(written) if written == size => {}
            Ok(written) if written > 0 => anyhow::bail!("Process {pid} answered {written} of {size} bytes"),
            _ => {
                return Err(std::io::Error::last_os_error())
                    .with_context(|| format!("Cannot read process {pid}"))
            }
        }
        // SAFETY: proc_pidinfo wrote all `size` bytes, and every field of
        // proc_bsdinfo is a plain integer or byte array, valid for any bits.
        let info = unsafe { info.assume_init() };
        ensure!(info.pbi_pid == pid as u32, "Process {pid} answered as another");
        ensure!(info.pbi_status != libc::SZOMB, "Process has exited");
        info.pbi_start_tvsec
            .checked_mul(1_000_000)
            .and_then(|micros| micros.checked_add(info.pbi_start_tvusec))
            .context("Malformed process start time")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRef {
    pub agent_id: String,
    pub harness: String,
    pub native_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub id: String,
    pub request_id: String,
    pub release_id: String,
    pub phase: Phase,
    pub started_at: String,
    pub updated_at: String,
    pub deadline: String,
    pub error: Option<String>,
    pub recovered_sessions: usize,
    pub total_sessions: usize,
    // These private fields never leave the Core-host journal.
    pub previous: ReleaseRef,
    pub candidate: ReleaseRef,
    pub old_process: ProcessIdentity,
    pub helper_process: Option<ProcessIdentity>,
    pub new_process: Option<ProcessIdentity>,
    #[serde(default)]
    pub stopping_process: Option<ProcessIdentity>,
    #[serde(default)]
    pub records_proof: Option<serde_json::Value>,
    pub workspace_id: String,
    pub token: String,
    pub launch: Launch,
    pub sessions: Vec<SessionRef>,
}
impl Operation {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"releaseId":self.release_id,"phase":self.phase,
            "startedAt":self.started_at,"updatedAt":self.updated_at,"deadline":self.deadline,
            "error":self.error,"recoveredSessions":self.recovered_sessions,"totalSessions":self.total_sessions,
            "recordsProof":self.records_proof})
    }
    pub fn set_phase(&mut self, phase: Phase, error: Option<String>) {
        self.phase = phase;
        self.error = error;
        self.updated_at = now();
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub prepared: Option<ReleaseRef>,
    pub operation: Option<Operation>,
    /// Keep request identities across later operations, so a delayed retry never reapplies.
    #[serde(default)]
    pub requests: Vec<(String, String)>,
}

#[derive(Clone)]
pub struct Layout {
    pub root: PathBuf,
}
impl Layout {
    pub fn open(root: &Path) -> Result<Self> {
        ensure!(root.is_absolute(), "Managed release root must be absolute");
        ensure!(
            !fs::symlink_metadata(root)?.file_type().is_symlink(),
            "Managed root cannot be a symlink"
        );
        let root = fs::canonicalize(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let meta = fs::metadata(&root)?;
            ensure!(
                meta.uid() == rustix::process::geteuid().as_raw()
                    && meta.permissions().mode() & 0o022 == 0,
                "Managed root must be owned by this user and not writable by other users"
            );
        }
        for name in ["updates", "releases", "incoming", "backups"] {
            let path = root.join(name);
            if !path.exists() {
                fs::create_dir(&path)?;
            }
            ensure!(
                fs::symlink_metadata(&path)?.file_type().is_dir(),
                "Managed directory cannot be a symlink: {name}"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(Self { root })
    }
    pub fn updates(&self) -> PathBuf {
        self.root.join("updates")
    }
    pub fn socket(&self) -> PathBuf {
        self.updates().join("control.sock")
    }
    pub fn release(&self, release: &ReleaseRef) -> Result<Bundle> {
        valid_id(&release.release_id)?;
        let bundle = Bundle::verify(
            &self.root.join("releases").join(&release.release_id),
            &release.manifest_sha256,
        )?;
        ensure!(
            bundle.manifest.release_id == release.release_id,
            "Release directory and manifest disagree"
        );
        Ok(bundle)
    }
    pub fn journal(&self) -> Result<Journal> {
        let path = self.updates().join("state.json");
        if !path.exists() {
            return Ok(Journal::default());
        }
        ensure!(
            fs::symlink_metadata(&path)?.file_type().is_file()
                && fs::metadata(&path)?.len() < 4 * 1024 * 1024,
            "Invalid update state file"
        );
        Ok(serde_json::from_reader(File::open(path)?)?)
    }
    /// Every writer reloads under an OS lock. HTTP cancel and helper transitions
    /// cannot overwrite each other's decisions or lose an idempotency receipt.
    pub fn edit<T>(&self, action: impl FnOnce(&mut Journal) -> Result<T>) -> Result<T> {
        let lock = private_file(&self.updates().join("state.lock"))?;
        lock.lock()?;
        let mut state = self.journal()?;
        let result = action(&mut state)?;
        atomic_json(&self.updates().join("state.json"), &state)?;
        Ok(result)
    }
    pub fn edit_operation<T>(
        &self,
        id: &str,
        action: impl FnOnce(&mut Operation) -> Result<T>,
    ) -> Result<T> {
        self.edit(|state| {
            let op = state.operation.as_mut().context("No update operation")?;
            ensure!(op.id == id, "Update operation changed");
            action(op)
        })
    }
}

pub fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    }
    Ok(options.open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_changes_are_durable_and_serialized() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::open(dir.path()).unwrap();
        let mut workers = vec![];
        for n in 0..8 {
            let layout = layout.clone();
            workers.push(std::thread::spawn(move || {
                layout
                    .edit(|s| {
                        s.requests.push((n.to_string(), "candidate".into()));
                        Ok(())
                    })
                    .unwrap()
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(layout.journal().unwrap().requests.len(), 8);
    }
    #[test]
    fn process_identity_includes_start_time_and_executable() {
        let live = ProcessIdentity::read(std::process::id()).unwrap();
        assert!(live.alive());
        // The file that runs, resolved: on macOS current_exe() need not be.
        assert_eq!(live.executable, fs::canonicalize(std::env::current_exe().unwrap()).unwrap());
        let mut stale = live.clone();
        stale.start_ticks += 1;
        assert!(!stale.alive());
        // No process has PID 0 or one past what the system's PIDs hold.
        assert!(ProcessIdentity::read(0).is_err());
        assert!(ProcessIdentity::read(u32::MAX).is_err());
    }

    /// Whether `ps` lists `pid` as exited but not yet reaped (Z).
    fn zombie(pid: u32) -> bool {
        let state = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&state.stdout).trim().starts_with('Z')
    }

    /// A child reads as itself while it runs, the same each time. Once it
    /// has exited it has no identity: not while its parent has yet to reap
    /// it (a zombie, which still holds its PID), nor once it has.
    #[test]
    fn an_exited_child_has_no_process_identity() {
        let mut child = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let running = ProcessIdentity::read(child.id()).unwrap();
        assert_eq!(running.pid, child.id());
        assert_eq!(running.executable, fs::canonicalize("/bin/sleep").unwrap());
        assert_eq!(ProcessIdentity::read(child.id()).unwrap(), running);
        assert!(running.alive());
        child.kill().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !zombie(child.id()) {
            assert!(std::time::Instant::now() < deadline, "the child did not exit");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let error = ProcessIdentity::read(child.id()).unwrap_err();
        assert!(!running.alive(), "a zombie: {error:#}");
        child.wait().unwrap();
        // Its PID may be another process's by now; it is not this one.
        assert!(!running.alive());
    }

    /// On macOS the start time is microseconds since the Unix epoch, so two
    /// processes started within the same second still differ.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_macos_start_time_is_microseconds_since_the_epoch() {
        let now = || {
            let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
            u64::try_from(since.as_micros()).unwrap()
        };
        let before = now();
        let mut first = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut second = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let after = now();
        let one = ProcessIdentity::read(first.id()).unwrap();
        let two = ProcessIdentity::read(second.id()).unwrap();
        for child in [&mut first, &mut second] {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        // A second's leeway for the clocks' own steps.
        let window = before - 1_000_000..=after + 1_000_000;
        assert!(window.contains(&one.start_ticks) && window.contains(&two.start_ticks), "{window:?}: {} {}", one.start_ticks, two.start_ticks);
        assert!(one.start_ticks < two.start_ticks, "{} {}", one.start_ticks, two.start_ticks);
    }
}
