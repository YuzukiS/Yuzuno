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
    #[cfg(not(target_os = "linux"))]
    pub fn read(_pid: u32) -> Result<Self> {
        anyhow::bail!("Managed Core updates require Linux/WSL")
    }
    pub fn alive(&self) -> bool {
        Self::read(self.pid).is_ok_and(|live| live == *self)
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
        let mut stale = live.clone();
        stale.start_ticks += 1;
        assert!(!stale.alive());
    }
}
