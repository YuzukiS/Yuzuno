//! Keeping Cores from before data roots out of a Workspace they would
//! mishandle.
//!
//! Such a Core knows one remote folder, `~/.yuzuno-next`, and one Windows
//! folder, `%LOCALAPPDATA%\yuzuno-next`. Given a Workspace that has a remote
//! or Windows attempt started in another root, it looks only in its own: a
//! start whose reply was lost is fenced there and reported not started while
//! it may be running, and one that was acknowledged turns unknown with no way
//! to cancel it. It also ignores a machine's own root, its containment and
//! its Jobs limits, so it would write outside the root a machine allows and
//! admit more than the machine is set to run. A remote or Windows Job not yet
//! started it would start in its own folder without this Core's limits, and a
//! Windows Job it would not count in this PC's Jobs budget.
//!
//! Every such Core opens the Workspace lock (`workspace.lock`) for writing
//! before it reads anything else (store.rs `lock_workspace`, in every build
//! since the first). While this Workspace holds something it would mishandle,
//! the lock file is read-only: an older Core fails to open it (EACCES) and
//! stops before it reads a record. This Core needs only the lock itself
//! (flock), which a read-only descriptor takes, so two of its builds still
//! exclude each other through the same file.
//!
//! - Closed before the write that needs it, in the same Store call, and on
//!   disk (the lock file is synced) before that write commits. Closing is
//!   proven, not assumed: opening the file for writing must now fail, and the
//!   kernel must confirm that no other process holds it open (a write lease;
//!   an older Core that opened it just before it closed would take the lock
//!   once this Core left). Unproven, the write is refused: running as root, a
//!   file system without permissions or leases, a platform other than Linux,
//!   another open of the file, or a lease the kernel does not confirm was let
//!   go.
//! - Opened again only when Core opens or leaves the Workspace and finds
//!   nothing such left, while no write that needs it is under way. Nothing is
//!   changed to get there: an attempt keeps its root, its state and its slot
//!   until it ends, and an Agent until it is closed.
//!
//! Not covered: an older Core run as root (it ignores permissions), a lock
//! file someone deleted or made writable by hand, and a copy of the Workspace
//! database opened without its lock file.
use crate::remote::{RemoteMachine, LEGACY_ROOT};
use crate::store::Store;
use anyhow::{bail, Context, Result};
use parking_lot::{RwLock, RwLockReadGuard};
use rusqlite::OptionalExtension;
use std::fs::{File, OpenOptions, Permissions};
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

/// The lock file's mode while older Cores are kept out.
const CLOSED: u32 = 0o400;
const OPEN: u32 = 0o600;

/// The Workspace lock this Core holds, and whether older Cores may open it.
pub struct Guard {
    file: File,
    path: PathBuf,
    /// Writes that need older Cores kept out hold it shared from before they
    /// close it until they commit; reopening holds it exclusively.
    writes: RwLock<()>,
    /// Closed and proven by this process, and not opened since.
    proven: AtomicBool,
}

/// Held by a write that needs older Cores kept out until it has committed.
pub struct KeptOut<'a>(#[allow(dead_code)] RwLockReadGuard<'a, ()>);

impl Guard {
    pub fn new(file: File, path: PathBuf) -> Self {
        Self { file, path, writes: RwLock::new(()), proven: AtomicBool::new(false) }
    }

    fn closed(&self) -> Result<bool> {
        Ok(self.file.metadata()?.permissions().mode() & 0o777 == CLOSED)
    }

    /// Closes the lock file to older Cores; Err(why) if that is not proven.
    fn close(&self) -> Result<std::result::Result<(), String>> {
        if self.closed()? && self.proven.load(Ordering::SeqCst) {
            return Ok(Ok(()));
        }
        if !self.closed()? {
            self.file.set_permissions(Permissions::from_mode(CLOSED)).context("Cannot make the Workspace lock read-only")?;
        }
        // The mode is on disk before the record that needs it.
        self.file.sync_all().context("Cannot sync the Workspace lock")?;
        match OpenOptions::new().write(true).open(&self.path) {
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {}
            Ok(_) => return Ok(Err("its lock file can still be opened for writing by this account (Core runs as root, \
                or the file system does not keep permissions)".into())),
            Err(error) => return Err(error).context("Cannot check the Workspace lock"),
        }
        if let Err(why) = only_open(&self.file)? {
            return Ok(Err(why));
        }
        self.proven.store(true, Ordering::SeqCst);
        Ok(Ok(()))
    }
}

/// F_SETSIG, which the libc crate does not name: <fcntl.h> __F_SETSIG on
/// Linux (the same on x86-64 and AArch64).
#[cfg(target_os = "linux")]
const F_SETSIG: libc::c_int = 10;

/// That no other process holds the lock file open, asked of the kernel: a
/// write lease (F_SETLEASE F_WRLCK) is granted only while this process's open
/// of the file is its only one (a child shares that open; it is not another).
/// This needs no access to other processes, so one that cannot be inspected
/// (another account's, or one of this account's that made itself
/// non-dumpable) is counted all the same. An older Core that opened the file
/// before it was closed, and would take the lock once this Core left, is one
/// such open; so is one that is only failing to take it now, or a reader,
/// which are gone a moment later and are waited for briefly. The lease is
/// let go at once; should something open the file meanwhile, the kernel
/// tells this process with SIGURG, which is ignored, instead of SIGIO, which
/// would end it.
#[cfg(target_os = "linux")]
fn only_open(file: &File) -> Result<std::result::Result<(), String>> {
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    // SAFETY: fcntl on a descriptor this File owns; no memory is passed.
    if unsafe { libc::fcntl(fd, F_SETSIG, libc::SIGURG) } != 0 {
        return Err(std::io::Error::last_os_error()).context("Cannot prepare the Workspace lock's check");
    }
    for _ in 0..20 {
        // SAFETY: as above.
        if unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_WRLCK as libc::c_int) } == 0 {
            release_lease(fd)?;
            return Ok(Ok(()));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EAGAIN) {
            return Ok(Err(format!("the kernel cannot tell whether another process holds its lock file open ({error})")));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Ok(Err("another process holds its lock file open (for example a Core that opened it before it was made read-only)".into()))
}

/// Lets go of the check's lease, and fails unless the kernel confirms that no
/// lease is left. One left in place would hold up every other open of the
/// file until the kernel breaks it (`/proc/sys/fs/lease-break-time`), so the
/// write that asked for the check is refused instead.
#[cfg(target_os = "linux")]
fn release_lease(fd: std::os::fd::RawFd) -> Result<()> {
    // SAFETY: fcntl on a descriptor the caller's File owns; no memory is passed.
    if unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_UNLCK as libc::c_int) } != 0 {
        return Err(std::io::Error::last_os_error()).context("Cannot let go of the lease the Workspace lock's check took");
    }
    // SAFETY: as above.
    match unsafe { libc::fcntl(fd, libc::F_GETLEASE) } {
        lease if lease == libc::F_UNLCK as libc::c_int => Ok(()),
        -1 => Err(std::io::Error::last_os_error()).context("Cannot confirm the Workspace lock's check let go of its lease"),
        lease => bail!("The Workspace lock's check still holds a lease ({lease}) after letting it go"),
    }
}

#[cfg(not(target_os = "linux"))]
fn only_open(_file: &File) -> Result<std::result::Result<(), String>> {
    Ok(Err("this platform cannot tell whether another process holds its lock file open".into()))
}

/// Whether `root` is the one Cores before data roots used for this executor.
pub fn legacy_root(windows: bool, root: &str) -> bool {
    root == if windows { crate::jobs::WINDOWS_LEGACY_ROOT } else { LEGACY_ROOT }
}

/// What about this machine an older Core would ignore.
pub fn machine_hazard(machine: &RemoteMachine) -> Option<String> {
    let name = &machine.name;
    if let Some(root) = machine.data_root.as_deref().filter(|root| *root != LEGACY_ROOT) {
        Some(format!("the machine {name} keeps its files in {root}"))
    } else if machine.contained {
        Some(format!("the machine {name} keeps its sessions contained"))
    } else if machine.max_jobs.is_some() || machine.budget.is_some() || machine.limit_mode.is_some() {
        Some(format!("the machine {name} has Jobs limits"))
    } else {
        None
    }
}

/// What about an open Agent on this machine copy an older Core would mishandle.
pub fn agent_hazard(name: &str, machine: &RemoteMachine) -> Option<String> {
    if machine.root() != LEGACY_ROOT {
        Some(format!("the Agent {name} runs in {} on {}", machine.root(), machine.name))
    } else if machine.contained {
        Some(format!("the Agent {name} runs contained on {}", machine.name))
    } else {
        None
    }
}

impl Store {
    /// Keeps older Cores out of this Workspace for a write that needs it;
    /// hold the result until that write has committed. Refused, with `why`,
    /// if keeping them out cannot be proven.
    pub fn keep_older_cores_out(&self, why: &str) -> Result<KeptOut<'_>> {
        let held = self.workspace_lock.writes.read();
        let newly = !self.workspace_lock.closed()?;
        if let Err(reason) = self.workspace_lock.close()? {
            bail!("Not done: {why}, which Yuzuno Core builds before data roots would mishandle, and they cannot \
                be kept out of this Workspace: {reason}");
        }
        if newly {
            eprintln!("Workspace: Core builds before data roots cannot open it now ({why}); its lock file is read-only");
        }
        Ok(KeptOut(held))
    }

    /// `keep_older_cores_out` if `why` is Some.
    pub fn keep_older_cores_out_for(&self, why: Option<String>) -> Result<Option<KeptOut<'_>>> {
        why.map(|why| self.keep_older_cores_out(&why)).transpose()
    }

    /// When Core opens and leaves the Workspace: older Cores stay out while
    /// something here is what they would mishandle, and may open it again
    /// once nothing is. Never fails the caller; it says what it did.
    pub fn settle_older_cores(&self) {
        let _settling = self.workspace_lock.writes.write();
        let result = (|| -> Result<()> {
            match self.older_core_hazard()? {
                Some(why) => match self.workspace_lock.close()? {
                    Ok(()) => {}
                    Err(reason) => eprintln!("Workspace: {why}, which Core builds before data roots would mishandle, \
                        and they cannot be kept out: {reason}"),
                },
                None if self.workspace_lock.closed()? => {
                    self.workspace_lock.file.set_permissions(Permissions::from_mode(OPEN))?;
                    self.workspace_lock.file.sync_all()?;
                    self.workspace_lock.proven.store(false, Ordering::SeqCst);
                    eprintln!("Workspace: nothing in it is what Core builds before data roots would mishandle; they may open it again");
                }
                None => {}
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Workspace: could not settle whether older Cores may open it: {error:#}");
        }
    }

    /// The first thing in this Workspace an older Core would mishandle.
    pub fn older_core_hazard(&self) -> Result<Option<String>> {
        if let Some(why) = self.machines()?.iter().find_map(machine_hazard) {
            return Ok(Some(why));
        }
        for agent in self.agents()? {
            if agent.closed_at.is_some() {
                continue;
            }
            if let Some(why) = agent.remote.as_ref().and_then(|remote| agent_hazard(&agent.name, &remote.machine)) {
                return Ok(Some(why));
            }
        }
        let db = self.db.read()?;
        // A cap on how many Windows Jobs run at once (T-108), which an older
        // Core does not read. A Workspace from before it has no such table.
        let capped: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_job_windows')", [], |r| r.get(0))?;
        if capped && db.query_row("SELECT max_jobs FROM local_job_windows WHERE id=1", [], |r| r.get::<_, Option<i64>>(0))
            .optional()?.flatten().is_some()
        {
            return Ok(Some("Windows Jobs have a concurrency cap set".into()));
        }
        // Unfinished (queued, or holding its slot) remote and Windows Jobs. Only
        // one started by an older Core, which recorded no root, or in the legacy
        // root (as the machine names it: an absolute root a hello reported is
        // never taken for it) is one an older Core handles as this one does.
        let mut query = db.prepare(
            "SELECT id, json_extract(data,'$.executor.kind'), COALESCE(json_extract(data,'$.executor.machineName'), ''),
                    json_extract(data,'$.remote.startSentAt') IS NOT NULL, json_extract(data,'$.remote.root')
             FROM local_jobs WHERE (reserved=1 OR status='queued') AND json_extract(data,'$.executor.kind') IN ('ssh','windows')",
        )?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let (id, kind, machine, sent, root): (String, String, String, bool, Option<String>) =
                (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?);
            if kind == "windows" {
                return Ok(Some(format!("the Job {id} on Windows has not ended")));
            }
            if !sent {
                return Ok(Some(format!("the Job {id} on {machine} has not been started yet")));
            }
            if let Some(root) = root.filter(|root| !legacy_root(false, root)) {
                return Ok(Some(format!("the Job {id} was started in {root} on {machine}")));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_an_older_core_would_ignore_is_a_hazard() {
        let plain = RemoteMachine { name: "lab".into(), ..Default::default() };
        assert_eq!(machine_hazard(&plain), None);
        assert_eq!(machine_hazard(&RemoteMachine { data_root: Some(LEGACY_ROOT.into()), ..plain.clone() }), None);
        for hazard in [
            RemoteMachine { data_root: Some("~/jobs-lab/.yuzuno".into()), ..plain.clone() },
            RemoteMachine { contained: true, ..plain.clone() },
            RemoteMachine { max_jobs: Some(1), ..plain.clone() },
            RemoteMachine { limit_mode: Some("strict".into()), ..plain.clone() },
        ] {
            assert!(machine_hazard(&hazard).is_some(), "{hazard:?}");
        }
        // An Agent's copy: its runtime is in its root, legacy or not.
        assert_eq!(agent_hazard("a", &RemoteMachine { data_root: Some(LEGACY_ROOT.into()), ..plain.clone() }), None);
        assert!(agent_hazard("a", &RemoteMachine { data_root: Some("~/.yuzuno".into()), ..plain.clone() }).is_some());
        assert!(agent_hazard("a", &plain).is_some(), "a copy without a root is the default root's");
        assert!(legacy_root(false, "~/.yuzuno-next") && !legacy_root(false, "~/.yuzuno"));
        assert!(legacy_root(true, crate::jobs::WINDOWS_LEGACY_ROOT) && !legacy_root(true, LEGACY_ROOT));
    }

    fn lock(dir: &std::path::Path) -> PathBuf {
        dir.join("workspace.lock")
    }

    fn open(dir: &std::path::Path) -> Result<Store> {
        Store::open(&dir.join("workspace.sqlite"))
    }

    /// How every Core before data roots opens it (store.rs lock_workspace).
    fn older_core_opens(dir: &std::path::Path) -> bool {
        OpenOptions::new().read(true).write(true).create(true).truncate(false).open(lock(dir)).is_ok()
    }

    fn as_root() -> bool {
        // SAFETY: geteuid has no preconditions.
        unsafe { libc::geteuid() == 0 }
    }

    fn lab_host() -> RemoteMachine {
        RemoteMachine { id: "lab_host".into(), name: "lab_host".into(), target: "lab_host".into(), codex: "codex".into(),
            default_cwd: "/srv".into(), data_root: Some("~/jobs-lab/.yuzuno".into()), ..Default::default() }
    }

    #[test]
    fn a_machine_with_its_own_root_keeps_older_cores_out_until_none_has_one() {
        let tmp = tempfile::tempdir().unwrap();
        let store = open(tmp.path()).unwrap();
        assert!(older_core_opens(tmp.path()));
        let added = store.add_machine(&lab_host());
        if as_root() {
            // Root ignores permissions: keeping older Cores out cannot be proven, so nothing is saved.
            assert!(added.unwrap_err().to_string().contains("cannot be kept out"));
            assert!(store.machines().unwrap().is_empty());
            return;
        }
        added.unwrap();
        assert!(!older_core_opens(tmp.path()), "an older Core cannot open the Workspace lock");
        assert_eq!(std::fs::metadata(lock(tmp.path())).unwrap().permissions().mode() & 0o777, CLOSED);
        // This Core's own builds still exclude each other through the same file.
        assert!(open(tmp.path()).is_err(), "a second Core is refused while the first holds the lock");
        drop(store);
        let store = open(tmp.path()).unwrap();
        assert!(!older_core_opens(tmp.path()), "still kept out: the machine still has its own root");
        // Without one, older Cores may open it again once Core leaves or opens it.
        store.update_machine(&RemoteMachine { data_root: None, ..lab_host() }).unwrap();
        assert!(!older_core_opens(tmp.path()));
        drop(store);
        let _store = open(tmp.path()).unwrap();
        assert!(older_core_opens(tmp.path()), "nothing an older Core would mishandle is left");
    }

    #[test]
    fn saving_jobs_limits_keeps_older_cores_out_and_clearing_them_lets_them_in_only_if_nothing_else_remains() {
        if as_root() {
            return;
        }
        // The Store save T-108's settings go through (server.rs add/update_machine).
        let limits = [
            RemoteMachine { max_jobs: Some(3), ..RemoteMachine::default() },
            RemoteMachine { budget: Some(crate::remote::MachineBudget { cpu_millis: 4000, memory_mib: 8192 }), ..RemoteMachine::default() },
            RemoteMachine { limit_mode: Some("strict".into()), ..RemoteMachine::default() },
        ];
        for setting in limits {
            let machine = RemoteMachine { id: "lab".into(), name: "lab".into(), target: "lab".into(),
                codex: "codex".into(), default_cwd: "/srv".into(), ..setting };
            let plain = RemoteMachine { max_jobs: None, budget: None, limit_mode: None, ..machine.clone() };
            // Added with it, and set on a machine that had none.
            for added_with_it in [true, false] {
                let tmp = tempfile::tempdir().unwrap();
                let store = open(tmp.path()).unwrap();
                if added_with_it {
                    store.add_machine(&machine).unwrap();
                } else {
                    store.add_machine(&plain).unwrap();
                    assert!(older_core_opens(tmp.path()), "a plain machine keeps nothing out");
                    store.update_machine(&machine).unwrap();
                }
                assert!(!older_core_opens(tmp.path()), "{machine:?}");
                // Cleared, with another machine that still has its own root: still out.
                store.add_machine(&lab_host()).unwrap();
                store.update_machine(&plain).unwrap();
                drop(store);
                let store = open(tmp.path()).unwrap();
                assert!(!older_core_opens(tmp.path()), "lab_host still has its own root");
                // Cleared everywhere: older Cores may open it again.
                store.update_machine(&RemoteMachine { data_root: None, ..lab_host() }).unwrap();
                drop(store);
                let _store = open(tmp.path()).unwrap();
                assert!(older_core_opens(tmp.path()), "{machine:?}: nothing is left");
            }
        }
    }

    #[test]
    fn an_older_core_that_opened_the_lock_before_it_closed_keeps_the_write_from_happening() {
        if as_root() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let store = open(tmp.path()).unwrap();
        // An older Core that opened the lock for writing just before it closed:
        // it would take the lock once this Core left. A real process, not a
        // child of this one, holds it (the inner shell).
        let mut older = std::process::Command::new("/bin/sh")
            .args(["-c", "sh -c 'exec 3<>\"$1\"; echo \"ready $$\"; read stop' sh \"$1\"; :", "sh"])
            .arg(lock(tmp.path()))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(older.stdout.take().unwrap()), &mut ready).unwrap();
        assert!(ready.starts_with("ready "), "{ready}");
        let refused = store.add_machine(&lab_host()).unwrap_err().to_string();
        assert!(refused.contains("another process holds its lock file open"), "{refused}");
        assert!(store.machines().unwrap().is_empty(), "nothing was saved");
        drop(older.stdin.take());
        older.wait().unwrap();
        store.add_machine(&lab_host()).unwrap();
        assert!(!older_core_opens(tmp.path()));
    }

    /// A process of this account that holds the lock open and makes itself
    /// non-dumpable: its descriptors cannot be listed (/proc/PID/fd refuses),
    /// so nothing short of the kernel's own count can see it.
    fn hidden_holder(lock: Option<&std::path::Path>) -> std::process::Child {
        let mut child = std::process::Command::new("python3")
            .args(["-c", "import ctypes, os, sys\n\
                if len(sys.argv) > 1: held = os.open(sys.argv[1], os.O_RDWR)\n\
                ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)\n\
                print('ready', flush=True)\n\
                sys.stdin.read()"])
            .args(lock)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(child.stdout.take().unwrap()), &mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        child
    }

    #[test]
    fn a_holder_that_cannot_be_inspected_still_keeps_the_write_from_happening() {
        if as_root() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let store = open(tmp.path()).unwrap();
        let mut hidden = hidden_holder(Some(&lock(tmp.path())));
        assert!(std::fs::read_dir(format!("/proc/{}/fd", hidden.id())).is_err(), "its descriptors cannot be listed");
        let refused = store.add_machine(&lab_host()).unwrap_err().to_string();
        assert!(refused.contains("another process holds its lock file open"), "{refused}");
        assert!(store.machines().unwrap().is_empty(), "nothing was saved");
        drop(hidden.stdin.take());
        hidden.wait().unwrap();
        store.add_machine(&lab_host()).unwrap();
        // One that cannot be inspected but does not hold the file (such as an
        // agent for keys) keeps nothing from happening.
        let mut other = hidden_holder(None);
        store.update_machine(&RemoteMachine { contained: true, ..lab_host() }).unwrap();
        drop(other.stdin.take());
        other.wait().unwrap();
    }

    #[test]
    fn the_checks_lease_is_let_go_and_a_release_the_kernel_refuses_is_an_error() {
        if as_root() {
            return;
        }
        use std::os::fd::AsRawFd;
        let tmp = tempfile::tempdir().unwrap();
        let path = lock(tmp.path());
        let file = OpenOptions::new().read(true).write(true).create(true).open(&path).unwrap();
        only_open(&file).unwrap().unwrap();
        // SAFETY: fcntl on a descriptor this test owns; no memory is passed.
        assert_eq!(unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLEASE) }, libc::F_UNLCK as libc::c_int,
            "no lease is left");
        // So another open does not wait for the kernel to break one.
        let started = std::time::Instant::now();
        drop(File::open(&path).unwrap());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        // The kernel refuses to let go of a lease that is not held: that is an
        // error, never taken for a release.
        let error = release_lease(file.as_raw_fd()).unwrap_err();
        assert!(format!("{error:#}").contains("Cannot let go of the lease"), "{error:#}");
    }

    #[test]
    fn an_open_agent_or_an_unfinished_job_in_a_new_root_keeps_older_cores_out() {
        if as_root() {
            return;
        }
        let agent = |id: &str, root: &str| -> crate::model::AgentDetail {
            serde_json::from_value(serde_json::json!({"agent":{"id":id,"name":id,"cwd":"/srv","model":"m","color":"sage",
                "status":"offline","createdAt":"2026-10-19","updatedAt":"2026-10-19","unreadCount":0,"pendingCount":0,
                "lastSeq":0,"reviewedSeq":0,"remote":{"machine":{"id":"lab","name":"lab","target":"lab","codex":"codex",
                "defaultCwd":"/srv","dataRoot":root}}},"turns":[],"pending":[],"artifacts":[]})).unwrap()
        };
        let agents = tempfile::tempdir().unwrap();
        let store = open(agents.path()).unwrap();
        // An Agent whose runtime stays in the legacy root: nothing to keep out.
        store.insert(&agent("old", LEGACY_ROOT)).unwrap();
        assert!(older_core_opens(agents.path()));
        assert_eq!(store.older_core_hazard().unwrap(), None);
        store.insert(&agent("new", "~/.yuzuno")).unwrap();
        assert!(!older_core_opens(agents.path()));
        assert!(store.older_core_hazard().unwrap().unwrap().contains("the Agent new runs in ~/.yuzuno on lab"));
        // Unfinished attempts: only one sent to a root older Cores do not know counts.
        let tmp = tempfile::tempdir().unwrap();
        let store = open(tmp.path()).unwrap();
        store.insert(&agent("old", LEGACY_ROOT)).unwrap();
        store.collaboration_call(None, "task_create", serde_json::json!({"requestId":"t","title":"t"})).unwrap();
        let task: String = store.db.read().unwrap().query_row("SELECT id FROM collaboration_tasks", [], |r| r.get(0)).unwrap();
        let job = |id: &str, kind: &str, status: &str, reserved: bool, remote: serde_json::Value| {
            let data = serde_json::json!({"id":id,"executor":{"kind":kind,"machineName":"lab"},"remote":remote});
            store.db.write().unwrap().execute(
                "INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES(?1,?2,'old',?3,?4,?5)",
                rusqlite::params![id, task, status, reserved, data.to_string()]).unwrap();
        };
        let sent = |root: &str| serde_json::json!({"startSentAt":"2026-10-19T00:00:00Z","root":root});
        // Handled by an older Core as by this one: started by one (no root
        // recorded), in the legacy root, or ended; and a local Job.
        job("by-older", "ssh", "running", true, serde_json::json!({"startSentAt":"2026-10-19T00:00:00Z"}));
        job("legacy", "ssh", "unknown", true, sent(LEGACY_ROOT));
        job("ended", "ssh", "succeeded", false, sent("~/.yuzuno"));
        job("ended-windows", "windows", "failed", false, sent(r"%LOCALAPPDATA%\YuzunoData\windows-jobs"));
        store.db.write().unwrap().execute(
            "INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES('local',?1,'old','queued',0,'{\"id\":\"local\"}')",
            [&task]).unwrap();
        assert_eq!(store.older_core_hazard().unwrap(), None);
        for (id, kind, status, reserved, remote, hazard) in [
            ("queued", "ssh", "queued", false, serde_json::json!({}), "has not been started yet"),
            ("unsent", "ssh", "starting", true, serde_json::json!({"hostId":"h"}), "has not been started yet"),
            ("new-root", "ssh", "unknown", true, sent("/home/u/.yuzuno"), "was started in /home/u/.yuzuno"),
            ("windows", "windows", "queued", false, serde_json::json!({}), "on Windows has not ended"),
            ("windows-legacy", "windows", "running", true, sent(crate::jobs::WINDOWS_LEGACY_ROOT), "on Windows has not ended"),
        ] {
            job(id, kind, status, reserved, remote);
            let found = store.older_core_hazard().unwrap().unwrap();
            assert!(found.contains(&format!("the Job {id}")) && found.contains(hazard), "{id}: {found}");
            store.db.write().unwrap().execute("DELETE FROM local_jobs WHERE id=?1", [id]).unwrap();
        }
        job("running", "windows", "running", true, sent(r"%LOCALAPPDATA%\YuzunoData\windows-jobs"));
        drop(store);
        let _store = open(tmp.path()).unwrap();
        assert!(!older_core_opens(tmp.path()), "opening the Workspace keeps them out while it is unfinished");
    }

    #[test]
    fn a_cap_on_windows_jobs_keeps_older_cores_out_while_it_is_set() {
        if as_root() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let store = open(tmp.path()).unwrap();
        // Without T-108 there is no table for it; with it, the jobs store makes
        // the table empty when it opens.
        assert_eq!(store.older_core_hazard().unwrap(), None);
        store.db.write().unwrap().execute_batch(
            "CREATE TABLE IF NOT EXISTS local_job_windows (id INTEGER PRIMARY KEY CHECK(id=1), max_jobs INTEGER);").unwrap();
        assert_eq!(store.older_core_hazard().unwrap(), None, "an empty table is no cap");
        // One row, max_jobs NULL for the default.
        store.db.write().unwrap().execute("INSERT INTO local_job_windows VALUES(1, NULL)", []).unwrap();
        assert_eq!(store.older_core_hazard().unwrap(), None, "the default is no cap");
        store.db.write().unwrap().execute("UPDATE local_job_windows SET max_jobs=1 WHERE id=1", []).unwrap();
        assert_eq!(store.older_core_hazard().unwrap().as_deref(), Some("Windows Jobs have a concurrency cap set"));
        drop(store);
        let store = open(tmp.path()).unwrap();
        assert!(!older_core_opens(tmp.path()), "kept out while the cap is set");
        store.db.write().unwrap().execute("UPDATE local_job_windows SET max_jobs=NULL WHERE id=1", []).unwrap();
        drop(store);
        let _store = open(tmp.path()).unwrap();
        assert!(older_core_opens(tmp.path()), "nothing is left once the cap is cleared");
    }
}
