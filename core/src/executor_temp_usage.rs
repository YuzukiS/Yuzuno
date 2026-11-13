//! How much an OpenCode executor's own temporary directory holds (YN-78 S2c;
//! design v4 3.4, the S2c contract Dev Lead 2 fixed on 2026-11-13).
//!
//! After a live Turn of its main session ends and that end is committed, Core
//! tries at most once to measure the directory its process was given at
//! start, and keeps one latest result for its Overview. A soft line of 2 GiB
//! is only shown: nothing is evicted, paused, deleted or refused here.
//!
//! - Only the directory this start actually passed as TMPDIR (its verified
//!   path, device and inode, carried from the start to its connection), never
//!   what a record says later. Before anything below it is read, it must
//!   still be S2a's directory: under this Core's current default root, this
//!   Agent's name, the owner's, 0700, the same device and inode.
//! - Each Turn gets a ticket: Workspace, Agent, native main session, Turn,
//!   connection generation, the directory's identity and a revision that only
//!   grows. A result is written only while its ticket is still the latest,
//!   its connection is still the Agent's current one, and (for a byte count)
//!   the record is still that directory, unreleased. An older result is
//!   dropped, never measured again, and wakes no model.
//! - The same Turn (Agent, main session, Turn ID) has one ticket: a repeated
//!   idle, a whole read, a reconnect, an import or a start never makes one.
//!   Nothing is queued across a restart: a Core that stops between the
//!   commit and the measurement misses that sample. At most once, not
//!   exactly once.
//! - The walk reads metadata only, from directory descriptors opened without
//!   following links, and never opens a file. It counts what `measure` in
//!   build_output counts (allocated blocks), but stops at the first doubt
//!   instead of skipping it: anything it can't prove makes the result unknown,
//!   never a smaller number and never 0.
//! - Its work is bounded: one background measurement in all of Core at a
//!   time, tried and never waited for; one of the file-system permits Core's
//!   answers share (opencode_responder's FS_GLOBAL); 20,000 entries and 2
//!   seconds; paths, depth and open folders capped. Both permits stay with
//!   the worker until it really ends.
//!
//! Stored: counts, states, times and tickets. Never a file's name or content.
use crate::{
    executor_temp::Given,
    opencode_permissions::{Clock, Wall, BUDGET},
    store::Store,
    workspace::Workspace,
};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio::time::Instant;

/// The soft line: reaching it is shown, nothing more. Its basis is design v4
/// 3.4 (one working copy measured 40 MB; builds and tests run in managed
/// Jobs). Not a setting.
pub(crate) const SOFT_LIMIT_BYTES: i64 = 2_147_483_648;
/// `st_blocks` counts 512-byte units (POSIX <sys/stat.h>; Linux stat(2);
/// macOS stat(2)), whatever the file system's own block size.
const BLOCK: u64 = 512;
/// Background measurements running at once in all of Core: one. A file
/// system call that never returns then holds one worker and one of the
/// FS_GLOBAL permits for good, never one more per Turn, and never all of the
/// permits Core's own answers need. One Workspace runs in a Core process, so
/// the Workspace's slot is Core's.
const BACKGROUND: usize = 1;

/// How far a walk may go. Reaching any of them makes the result unknown.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// Entries read, and inodes remembered, as `BUDGET` (20,000).
    pub entries: usize,
    /// A relative path's bytes: PATH_MAX, 4096 on Linux (<linux/limits.h>).
    pub path_bytes: usize,
    /// Folders below the root.
    pub depth: usize,
    /// Folders open at once, the root's included. macOS's default soft
    /// RLIMIT_NOFILE is 256 and Linux's 1024; 64 leaves the rest of Core room.
    pub open_dirs: usize,
}

pub(crate) const LIMITS: Limits = Limits { entries: BUDGET.entries, path_bytes: 4096, depth: 32, open_dirs: 64 };
// A walk relative to directory descriptors holds one per level, the root's
// included: there must be one for every level it may reach.
const _: () = assert!(LIMITS.open_dirs > LIMITS.depth);

/// Why a measurement has no byte count. Each is a short code the Overview
/// words; none is ever shown as 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unknown {
    /// Another measurement still runs.
    Busy,
    /// The 2 seconds ran out: waiting for a permit, opening or walking.
    Timeout,
    /// More than 20,000 entries.
    Entries,
    /// A path longer than 4096 bytes.
    Path,
    /// Folders deeper than 32.
    Depth,
    /// More than 64 folders open at once, or none could be opened.
    Handles,
    /// Something changed while it was read: the root, a folder or an entry.
    Changed,
    /// A mount below it, or a mount table that can't be read.
    Mount,
    /// Another file system below it.
    Device,
    /// A read failed.
    Error,
    /// The count doesn't fit.
    Overflow,
    /// No longer the directory its start was given: released, replaced, or
    /// not under this Core's current root.
    Unavailable,
}

impl Unknown {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Unknown::Busy => "busy",
            Unknown::Timeout => "timeout",
            Unknown::Entries => "entries",
            Unknown::Path => "path",
            Unknown::Depth => "depth",
            Unknown::Handles => "handles",
            Unknown::Changed => "changed",
            Unknown::Mount => "mount",
            Unknown::Device => "device",
            Unknown::Error => "error",
            Unknown::Overflow => "overflow",
            Unknown::Unavailable => "unavailable",
        }
    }
}

/// One measurement: the allocated bytes of a complete walk, or why there is
/// none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sample {
    Measured(i64),
    Unknown(Unknown),
}

/// What a walk has counted: each non-directory entry's own allocated blocks,
/// an inode with other links once.
#[derive(Default)]
pub(crate) struct Tally {
    bytes: u64,
    seen: HashSet<(u64, u64)>,
}

impl Tally {
    pub(crate) fn add(&mut self, dev: u64, ino: u64, links: u64, blocks: i64, limits: &Limits) -> Result<(), Unknown> {
        let blocks = u64::try_from(blocks).map_err(|_| Unknown::Error)?;
        if links > 1 {
            if self.seen.contains(&(dev, ino)) {
                return Ok(());
            }
            if self.seen.len() >= limits.entries {
                return Err(Unknown::Entries);
            }
            self.seen.insert((dev, ino));
        }
        let bytes = blocks.checked_mul(BLOCK).ok_or(Unknown::Overflow)?;
        self.bytes = self.bytes.checked_add(bytes).ok_or(Unknown::Overflow)?;
        Ok(())
    }

    /// The count as Core keeps it (SQLite's signed 64 bits).
    pub(crate) fn total(&self) -> Result<i64, Unknown> {
        i64::try_from(self.bytes).map_err(|_| Unknown::Overflow)
    }
}

/// Whether a count has reached the soft line.
pub(crate) fn over(bytes: i64) -> bool {
    bytes >= SOFT_LIMIT_BYTES
}

/// The mount table proves nothing is mounted at `root` or below it. Without
/// one (a platform with no /proc/self/mountinfo, or a read error), nothing is
/// proved.
fn no_mount_within(root: &Path, mounts: &dyn Fn() -> Option<Vec<PathBuf>>) -> Result<(), Unknown> {
    let mounts = mounts().ok_or(Unknown::Mount)?;
    if mounts.iter().any(|mount| mount.starts_with(root)) {
        return Err(Unknown::Mount);
    }
    Ok(())
}

/// The allocated bytes below `root`, which must be `given`'s directory (by
/// device and inode, the owner's, 0700) when it is opened, by a walk that
/// stops at the first doubt. `until` is the measurement's one deadline; the
/// kernel's own calls can't be interrupted, so it is checked between them.
#[cfg(unix)]
pub(crate) fn walk(given: &Given, limits: &Limits, until: std::time::Instant, clock: &dyn Clock,
    mounts: &dyn Fn() -> Option<Vec<PathBuf>>) -> Sample {
    match walked(given, limits, until, clock, mounts) {
        Ok(bytes) => Sample::Measured(bytes),
        Err(why) => Sample::Unknown(why),
    }
}

#[cfg(unix)]
// The widths of these fields differ between Linux and macOS.
#[allow(clippy::unnecessary_cast)]
fn walked(given: &Given, limits: &Limits, until: std::time::Instant, clock: &dyn Clock,
    mounts: &dyn Fn() -> Option<Vec<PathBuf>>) -> Result<i64, Unknown> {
    use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags};
    use rustix::io::Errno;
    let folder = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let opened = |error: Errno| match error {
        Errno::NOENT | Errno::LOOP | Errno::NOTDIR => Unknown::Changed,
        Errno::MFILE | Errno::NFILE => Unknown::Handles,
        _ => Unknown::Error,
    };
    let (dev, ino) = (given.dev as u64, given.ino as u64);
    let root = &given.path;
    no_mount_within(root, mounts)?;
    if clock.now() >= until {
        return Err(Unknown::Timeout);
    }
    let fd = rustix::fs::open(root, folder, Mode::empty()).map_err(opened)?;
    let stat = rustix::fs::fstat(&fd).map_err(|_| Unknown::Error)?;
    if (stat.st_dev as u64, stat.st_ino as u64) != (dev, ino)
        || FileType::from_raw_mode(stat.st_mode) != FileType::Directory
        || stat.st_uid != rustix::process::getuid().as_raw()
        || stat.st_mode & 0o777 != 0o700
    {
        return Err(Unknown::Changed);
    }
    struct Frame {
        dir: Dir,
        /// Its path's bytes below the root.
        len: usize,
    }
    let mut stack = vec![Frame { dir: Dir::new(fd).map_err(|_| Unknown::Error)?, len: 0 }];
    let (mut tally, mut entries) = (Tally::default(), 0usize);
    loop {
        // A folder found here is `level` below the root; opening it makes
        // `level + 1` open, the root's included.
        let level = stack.len();
        let Some(frame) = stack.last_mut() else { break };
        if clock.now() >= until {
            return Err(Unknown::Timeout);
        }
        let entry = match frame.dir.read() {
            None => {
                stack.pop();
                continue;
            }
            Some(Err(_)) => return Err(Unknown::Error),
            Some(Ok(entry)) => entry,
        };
        let name = entry.file_name();
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        entries += 1;
        if entries > limits.entries {
            return Err(Unknown::Entries);
        }
        let len = frame.len + usize::from(frame.len > 0) + name.to_bytes().len();
        if len > limits.path_bytes {
            return Err(Unknown::Path);
        }
        let parent = frame.dir.fd().map_err(|_| Unknown::Error)?;
        let stat = rustix::fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|error| if error == Errno::NOENT { Unknown::Changed } else { Unknown::Error })?;
        if stat.st_dev as u64 != dev {
            return Err(Unknown::Device);
        }
        if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
            // A file, a link (itself, never what it names) or anything else.
            tally.add(stat.st_dev as u64, stat.st_ino as u64, stat.st_nlink as u64, stat.st_blocks as i64, limits)?;
            continue;
        }
        if level > limits.depth {
            return Err(Unknown::Depth);
        }
        if level + 1 > limits.open_dirs {
            return Err(Unknown::Handles);
        }
        let fd = rustix::fs::openat(parent, name, folder, Mode::empty()).map_err(opened)?;
        let now = rustix::fs::fstat(&fd).map_err(|_| Unknown::Error)?;
        if (now.st_dev, now.st_ino) != (stat.st_dev, stat.st_ino) {
            return Err(Unknown::Changed);
        }
        let dir = Dir::new(fd).map_err(|_| Unknown::Error)?;
        stack.push(Frame { dir, len });
    }
    // Still that directory at its path, with nothing mounted below it since.
    let again = rustix::fs::statat(rustix::fs::CWD, root, AtFlags::SYMLINK_NOFOLLOW).map_err(opened)?;
    if (again.st_dev as u64, again.st_ino as u64) != (dev, ino) {
        return Err(Unknown::Changed);
    }
    no_mount_within(root, mounts)?;
    tally.total()
}

/// Runs on every open, from `executor_temp::migrate`: the latest ticket and
/// result of each executor. No queue: nothing here is measured again after a
/// restart.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS executor_temp_usage(
            workspace_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            session TEXT NOT NULL,
            turn TEXT NOT NULL,
            generation INTEGER NOT NULL,
            path TEXT NOT NULL,
            dev INTEGER NOT NULL,
            ino INTEGER NOT NULL,
            ticketed_at TEXT NOT NULL,
            result_revision INTEGER,
            state TEXT,
            bytes INTEGER,
            reason TEXT,
            measured_at TEXT,
            last_bytes INTEGER,
            last_at TEXT,
            PRIMARY KEY(workspace_id, agent_id));",
    )?;
    Ok(())
}

/// One Turn's right to write a result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Ticket {
    pub workspace: String,
    pub agent: String,
    pub session: String,
    pub turn: String,
    pub generation: u64,
    pub given: Given,
    pub revision: i64,
    /// The record was this directory, unreleased, when the ticket was made;
    /// otherwise nothing is read and the result is unknown.
    pub usable: bool,
}

/// The ticket for this ended Turn, if it is an executor's at ask, auto or
/// full and has had none: one transaction, from an async caller's `stored`.
pub(crate) fn issue(store: &Store, agent: &str, session: &str, turn: &str, generation: u64, given: &Given) -> Result<Option<Ticket>> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    let level: Option<String> =
        tx.query_row("SELECT level FROM agent_permission_levels WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?;
    if !matches!(level.as_deref(), Some("ask" | "auto" | "full")) || crate::agent_roles::kind(&tx, agent)? != crate::agent_roles::EXECUTOR {
        return Ok(None);
    }
    let workspace = crate::executor_temp::workspace_of(&tx)?;
    let last: Option<(i64, String, String)> = tx
        .query_row(
            "SELECT revision,session,turn FROM executor_temp_usage WHERE workspace_id=?1 AND agent_id=?2",
            params![workspace, agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if last.as_ref().is_some_and(|(_, s, t)| s == session && t == turn) {
        return Ok(None);
    }
    let revision = last.map_or(0, |(revision, ..)| revision) + 1;
    let usable = allocated(&tx, &workspace, agent, given)?;
    let path = given.path.to_string_lossy();
    tx.execute(
        "INSERT INTO executor_temp_usage(workspace_id,agent_id,revision,session,turn,generation,path,dev,ino,ticketed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(workspace_id,agent_id) DO UPDATE SET revision=excluded.revision, session=excluded.session,
           turn=excluded.turn, generation=excluded.generation, path=excluded.path, dev=excluded.dev, ino=excluded.ino,
           ticketed_at=excluded.ticketed_at",
        params![workspace, agent, revision, session, turn, generation as i64, path, given.dev, given.ino, crate::model::now()],
    )?;
    tx.commit()?;
    Ok(Some(Ticket {
        workspace,
        agent: agent.to_owned(),
        session: session.to_owned(),
        turn: turn.to_owned(),
        generation,
        given: given.clone(),
        revision,
        usable,
    }))
}

/// The Agent's record is still `given`'s directory, unreleased.
fn allocated(db: &Connection, workspace: &str, agent: &str, given: &Given) -> Result<bool> {
    let record: Option<(String, i64, i64, Option<String>)> = db
        .query_row(
            "SELECT path,dev,ino,released_at FROM executor_temp_dirs WHERE workspace_id=?1 AND agent_id=?2",
            params![workspace, agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    Ok(record.is_some_and(|(path, dev, ino, released)| {
        released.is_none() && Path::new(&path) == given.path && (dev, ino) == (given.dev, given.ino)
    }))
}

/// Writes `sample` only while `ticket` is still the latest, and a byte count
/// only while the record is still its directory, unreleased: one transaction.
/// Its revision when written; None when it was dropped.
pub(crate) fn write_back(store: &Store, ticket: &Ticket, sample: Sample) -> Result<Option<i64>> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    let latest: Option<(i64, String, String, i64, String, i64, i64)> = tx
        .query_row(
            "SELECT revision,session,turn,generation,path,dev,ino FROM executor_temp_usage WHERE workspace_id=?1 AND agent_id=?2",
            params![ticket.workspace, ticket.agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    let expected = (
        ticket.revision,
        ticket.session.clone(),
        ticket.turn.clone(),
        ticket.generation as i64,
        ticket.given.path.to_string_lossy().into_owned(),
        ticket.given.dev,
        ticket.given.ino,
    );
    if latest.as_ref() != Some(&expected) {
        return Ok(None);
    }
    let at = crate::model::now();
    match sample {
        Sample::Measured(bytes) => {
            if !allocated(&tx, &ticket.workspace, &ticket.agent, &ticket.given)? {
                return Ok(None);
            }
            tx.execute(
                "UPDATE executor_temp_usage SET result_revision=?3, state='measured', bytes=?4, reason=NULL, measured_at=?5,
                   last_bytes=?4, last_at=?5 WHERE workspace_id=?1 AND agent_id=?2",
                params![ticket.workspace, ticket.agent, ticket.revision, bytes, at],
            )?;
        }
        Sample::Unknown(why) => {
            tx.execute(
                "UPDATE executor_temp_usage SET result_revision=?3, state='unknown', bytes=NULL, reason=?4, measured_at=?5
                 WHERE workspace_id=?1 AND agent_id=?2",
                params![ticket.workspace, ticket.agent, ticket.revision, why.code(), at],
            )?;
        }
    }
    tx.commit()?;
    Ok(Some(ticket.revision))
}

/// The Agent's latest result as its Overview reads it, if it has one: a
/// byte count only from a complete walk, the soft line, and the last byte
/// count apart, with its own time.
pub(crate) fn view(db: &Connection, agent: &str) -> Result<Option<Value>> {
    type Row = (i64, String, Option<i64>, Option<String>, String, Option<i64>, Option<String>);
    let row: Option<Row> = db
        .query_row(
            "SELECT result_revision,state,bytes,reason,measured_at,last_bytes,last_at FROM executor_temp_usage
             WHERE agent_id=?1 AND result_revision IS NOT NULL
               AND workspace_id=(SELECT value FROM workspace_meta WHERE key='workspaceId')",
            [agent],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;
    let Some((revision, state, bytes, reason, at, last_bytes, last_at)) = row else { return Ok(None) };
    let mut usage = json!({"revision": revision, "state": state, "at": at, "limitBytes": SOFT_LIMIT_BYTES, "bytes": null});
    match (state.as_str(), bytes) {
        ("measured", Some(bytes)) => {
            usage["bytes"] = json!(bytes);
            usage["over"] = json!(over(bytes));
        }
        _ => {
            usage["state"] = json!("unknown");
            usage["reason"] = json!(reason);
        }
    }
    if let (Some(bytes), Some(at)) = (last_bytes, last_at) {
        usage["lastMeasured"] = json!({"bytes": bytes, "at": at});
    }
    Ok(Some(usage))
}

/// Core's one background measurement slot, and what tests hold it with.
pub(crate) struct State {
    slot: Arc<Semaphore>,
    #[cfg(test)]
    pub(crate) hooks: std::sync::Mutex<Hooks>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            slot: Arc::new(Semaphore::new(BACKGROUND)),
            #[cfg(test)]
            hooks: Default::default(),
        }
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct Hooks {
    /// Called on the worker, holding both permits, before it reads anything.
    pub before_walk: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// How a measurement's start went.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Attempt<T> {
    /// The slot was taken: nothing started.
    Busy,
    /// `until` came first; the work, if it started, keeps both permits until
    /// it really ends, and nothing else starts for it.
    Late,
    Done(T),
}

/// Tries `slot` (never waits for it), then waits until `until` for one of
/// `global`, and runs `work` holding both on the blocking pool
/// (`opencode_responder::bounded_fs_on`).
pub(crate) async fn attempt<T: Send + 'static>(slot: &Arc<Semaphore>, global: Arc<Semaphore>, until: Instant,
    work: impl FnOnce() -> T + Send + 'static) -> Attempt<T> {
    let Ok(held) = slot.clone().try_acquire_owned() else { return Attempt::Busy };
    match crate::opencode_responder::bounded_fs_on(global, until, move || {
        let _held = held;
        work()
    })
    .await
    {
        Some(done) => Attempt::Done(done),
        None => Attempt::Late,
    }
}

/// The measurement the worker makes: S2a's checks of the directory, then the
/// walk, within `until`.
#[cfg(unix)]
fn measure_now(data: &Path, agent: &str, given: &Given, until: std::time::Instant) -> Sample {
    if crate::executor_temp::still_current(data, agent, &given.path, given.dev, given.ino).is_err() {
        return Sample::Unknown(Unknown::Unavailable);
    }
    walk(given, &LIMITS, until, &Wall, &crate::build_output::mounts)
}

impl Workspace {
    /// After a live Turn of Agent `id`'s main session on connection
    /// `generation` ended and that end was committed: its one ticket, then
    /// one measurement in the background. Nothing for a connection that is
    /// no longer current or whose start passed no temporary directory.
    pub(crate) async fn temp_usage_after_turn(self: &Arc<Self>, id: &str, generation: u64, turn: String) {
        if self.opencode_current(id, generation).and_then(|c| c.temp.clone()).is_none() {
            return;
        }
        let owned = self.owner(id).await;
        let Some(c) = self.opencode_current(id, generation) else { return };
        let Some(given) = c.temp.clone() else { return };
        let (agent, session) = (id.to_owned(), c.session.clone());
        let issued = self.stored_owned(owned, move |store| issue(store, &agent, &session, &turn, generation, &given)).await;
        let ticket = match issued {
            Ok(Some(ticket)) => ticket,
            Ok(None) => return,
            Err(error) => {
                eprintln!("[executor-temp] Agent {id}'s measurement could not be started: {error:#}");
                return;
            }
        };
        let ws = self.clone();
        tokio::spawn(async move {
            let sample = ws.temp_usage_measure(&ticket).await;
            ws.temp_usage_record(ticket, sample).await;
        });
    }

    /// One measurement for `ticket`, holding no lock, ownership or gate.
    async fn temp_usage_measure(&self, ticket: &Ticket) -> Sample {
        if !ticket.usable {
            return Sample::Unknown(Unknown::Unavailable);
        }
        // Waiting for a permit, opening the root and the walk share this one deadline.
        let until = Instant::now() + BUDGET.time;
        #[cfg(unix)]
        let work = {
            let (data, agent, given) = (self.data_dir.clone(), ticket.agent.clone(), ticket.given.clone());
            #[cfg(test)]
            let hook = self.temp_usage.hooks.lock().unwrap().before_walk.clone();
            move || {
                #[cfg(test)]
                if let Some(hook) = hook {
                    hook();
                }
                measure_now(&data, &agent, &given, until.into_std())
            }
        };
        #[cfg(not(unix))]
        let work = || Sample::Unknown(Unknown::Unavailable);
        match attempt(&self.temp_usage.slot, crate::opencode_responder::global_fs(), until, work).await {
            Attempt::Busy => Sample::Unknown(Unknown::Busy),
            Attempt::Late => Sample::Unknown(Unknown::Timeout),
            Attempt::Done(sample) => sample,
        }
    }

    /// Writes `sample` while its ticket is the latest and its connection
    /// still the Agent's current one, under the Agent's ownership; then
    /// tells clients its revision only (`agent.tempUsage`).
    async fn temp_usage_record(&self, ticket: Ticket, sample: Sample) {
        let owned = self.owner(&ticket.agent).await;
        let current = self
            .opencode_current(&ticket.agent, ticket.generation)
            .is_some_and(|c| c.session == ticket.session && c.temp.as_ref() == Some(&ticket.given));
        if !current {
            return;
        }
        let agent = ticket.agent.clone();
        match self.stored_owned(owned, move |store| write_back(store, &ticket, sample)).await {
            Ok(Some(revision)) => {
                self.changes.publish(&json!({"type": "agent.tempUsage", "agentId": agent, "revision": revision}));
            }
            Ok(None) => {}
            Err(error) => eprintln!("[executor-temp] Agent {agent}'s measurement could not be recorded: {error:#}"),
        }
    }
}

#[cfg(all(test, unix))]
#[path = "executor_temp_usage_tests.rs"]
mod tests;
