//! Each OpenCode executor's own temporary directory (YN-78 S2a, design 3.1
//! and 3.2): the one its `opencode serve` gets as TMPDIR, TMP and TEMP.
//!
//! Only a local OpenCode executor whose level is ask, auto or full gets one.
//! read-only, an Agent with no level and a standing Agent get none, and keep
//! today's behaviour (no TMPDIR from Core). The default root is
//! `<Core's data directory>/t`, which the cleanup checks already refuse to
//! remove; this slice starts nothing else and never deletes a directory.
//!
//! An executor's directory is recorded with its full ID, its canonical path
//! and its device and inode, so a restart reuses it only while it is still
//! that same directory and still directly under this Core's current default
//! root. A record from another data directory (a restored backup keeps the
//! Workspace ID) is kept for history but never reused, rebound or deleted,
//! and no environment is passed from it. A directory already there without
//! this Agent's record is never taken over: the next longer prefix is tried,
//! and when none is free the executor starts as before without a temporary
//! directory, with the reason kept for its detail.
use crate::{agent_roles, store::Store};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

/// The default root under Core's data directory: `<D>/t`.
const ROOT_NAME: &str = "t";
/// The prefixes of an executor's ID a directory name may use, in order; the
/// full ID is tried last.
const PREFIXES: [usize; 2] = [8, 12];
/// A final path's most bytes: `sun_path` (108 on Linux, 104 on macOS) less
/// the terminating NUL and 40 bytes for what a tool makes under TMPDIR.
pub(crate) const LINUX_LIMIT: usize = 108 - 1 - 40;
pub(crate) const MAC_LIMIT: usize = 104 - 1 - 40;

#[cfg(unix)]
fn limit() -> usize {
    if cfg!(target_os = "macos") {
        MAC_LIMIT
    } else {
        LINUX_LIMIT
    }
}

/// The record of an executor's temporary directory.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TempDir {
    pub path: String,
    pub dev: i64,
    pub ino: i64,
    pub created_at: String,
    pub released_at: Option<String>,
}

/// Runs on every open, idempotent. No foreign key: deleting an Agent leaves
/// the record (design 3.2), so a later Core can still find the directory.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS executor_temp_dirs(
            workspace_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            path TEXT NOT NULL,
            dev INTEGER NOT NULL,
            ino INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            released_at TEXT,
            PRIMARY KEY(workspace_id, agent_id));
        CREATE TABLE IF NOT EXISTS executor_temp_notes(
            workspace_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            note TEXT NOT NULL,
            at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, agent_id));",
    )?;
    Ok(())
}

impl Store {
    /// The Agent's recorded temporary directory, if it has one.
    pub(crate) fn executor_temp_dir(&self, workspace: &str, agent: &str) -> Result<Option<TempDir>> {
        Ok(self
            .db
            .read()?
            .query_row(
                "SELECT path,dev,ino,created_at,released_at FROM executor_temp_dirs WHERE workspace_id=?1 AND agent_id=?2",
                params![workspace, agent],
                |r| {
                    Ok(TempDir { path: r.get(0)?, dev: r.get(1)?, ino: r.get(2)?, created_at: r.get(3)?, released_at: r.get(4)? })
                },
            )
            .optional()?)
    }

    fn save_executor_temp_dir(&self, workspace: &str, agent: &str, path: &str, dev: i64, ino: i64) -> Result<()> {
        self.db.write()?.execute(
            "INSERT INTO executor_temp_dirs(workspace_id,agent_id,path,dev,ino,created_at,released_at)
             VALUES(?1,?2,?3,?4,?5,?6,NULL)
             ON CONFLICT(workspace_id,agent_id) DO NOTHING",
            params![workspace, agent, path, dev, ino, crate::model::now()],
        )?;
        Ok(())
    }

    /// Why this Agent has no temporary directory now, kept for its detail.
    fn note_executor_temp(&self, workspace: &str, agent: &str, note: &str) -> Result<()> {
        self.db.write()?.execute(
            "INSERT INTO executor_temp_notes(workspace_id,agent_id,note,at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(workspace_id,agent_id) DO UPDATE SET note=excluded.note, at=excluded.at",
            params![workspace, agent, note, crate::model::now()],
        )?;
        Ok(())
    }

    fn clear_executor_temp_note(&self, workspace: &str, agent: &str) -> Result<()> {
        self.db.write()?.execute(
            "DELETE FROM executor_temp_notes WHERE workspace_id=?1 AND agent_id=?2",
            params![workspace, agent],
        )?;
        Ok(())
    }

    /// The Agent's temporary directory as its detail shows it, if it has one
    /// or a reason it has none.
    #[cfg(test)]
    pub(crate) fn executor_temp_view(&self, agent: &str) -> Result<Option<Value>> {
        view(&*self.db.read()?, agent)
    }
}

/// `executor_temp_view`, for callers holding a connection (the lifecycle's
/// `tempDir`).
pub(crate) fn view(db: &Connection, agent: &str) -> Result<Option<Value>> {
    let dir: Option<(String, Option<String>)> = db
        .query_row("SELECT path,released_at FROM executor_temp_dirs WHERE agent_id=?1", [agent], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let note: Option<String> = db
        .query_row("SELECT note FROM executor_temp_notes WHERE agent_id=?1", [agent], |r| r.get(0))
        .optional()?;
    if dir.is_none() && note.is_none() {
        return Ok(None);
    }
    let mut view = json!({});
    if let Some((path, released_at)) = dir {
        view["path"] = json!(path);
        if let Some(released_at) = released_at {
            view["releasedAt"] = json!(released_at);
        }
    }
    if let Some(note) = note {
        view["note"] = json!(note);
    }
    Ok(Some(view))
}

/// This Agent's temporary directory for the start now under way, if it may
/// have one: created or reused, and recorded. None leaves today's behaviour
/// (no TMPDIR from Core), with the reason kept for its detail when it is
/// eligible and none could be used.
pub(crate) fn ensure_at_start(store: &Store, data: &Path, agent: &str) -> Result<Option<PathBuf>> {
    #[cfg(not(unix))]
    {
        let _ = (store, data, agent);
        return Ok(None);
    }
    #[cfg(unix)]
    {
        let Some(level) = store.permission_level(agent)? else { return Ok(None) };
        if !matches!(level.as_str(), "ask" | "auto" | "full") {
            return Ok(None);
        }
        {
            let db = store.db.read()?;
            if agent_roles::kind(&db, agent)? != agent_roles::EXECUTOR {
                return Ok(None);
            }
        }
        let workspace = store.workspace_id()?;
        let outcome = allocate(store, data, &workspace, agent)
            .unwrap_or_else(|error| Outcome::Unavailable(format!("Core could not prepare a temporary directory: {error:#}")));
        match outcome {
            Outcome::Ready(path) => {
                store.clear_executor_temp_note(&workspace, agent)?;
                Ok(Some(path))
            }
            Outcome::Unavailable(reason) => {
                store.note_executor_temp(&workspace, agent, &reason)?;
                Ok(None)
            }
        }
    }
}

/// Records the first release of this Agent's temporary directory; a later
/// call keeps the time it already has. Nothing is deleted.
pub(crate) fn release_for_close(db: &Connection, agent: &str, at: &str) -> Result<()> {
    db.execute(
        "UPDATE executor_temp_dirs SET released_at=?2 WHERE agent_id=?1 AND released_at IS NULL",
        params![agent, at],
    )?;
    Ok(())
}

/// What an Agent about to start may get.
#[cfg(unix)]
enum Outcome {
    Ready(PathBuf),
    Unavailable(String),
}

#[cfg(unix)]
fn allocate(store: &Store, data: &Path, workspace: &str, agent: &str) -> Result<Outcome> {
    let root = default_root(data)?;
    let prefixes = prefixes(agent)?;
    if let Some(record) = store.executor_temp_dir(workspace, agent)? {
        if record.released_at.is_some() {
            return Ok(Outcome::Unavailable("its temporary directory was released with its executor".into()));
        }
        // The record must belong to *this* Core's current default root, not
        // only still be the same directory: a restored backup keeps the
        // Workspace and this record, but the cleanup protection covers the new
        // data directory only. A record outside it is kept for history, never
        // reused, deleted or rebound, and no environment is passed.
        let path = Path::new(&record.path);
        return Ok(match verify(path, record.dev, record.ino).and_then(|()| within_root(path, &root, &prefixes)) {
            Ok(()) => Outcome::Ready(path.to_path_buf()),
            Err(why) => Outcome::Unavailable(format!("its recorded temporary directory can't be used: {why}")),
        });
    }
    let mut tried = Vec::new();
    for prefix in &prefixes {
        let candidate = root.join(prefix);
        if fits(&candidate).is_none() {
            return Ok(Outcome::Unavailable(format!(
                "the default temporary directory would be {} bytes, more than the {} this platform allows",
                candidate.to_str().map_or(0, str::len),
                limit()
            )));
        }
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => {
                tried.push(format!("{prefix} is already there"));
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Ok(Outcome::Unavailable(format!("Core could not look at {}: {error}", candidate.display()))),
        }
        if let Err(error) = std::fs::create_dir(&candidate) {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                tried.push(format!("{prefix} is already there"));
                continue;
            }
            return Ok(Outcome::Unavailable(format!("Core could not make {}: {error}", candidate.display())));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o700))?;
        }
        let Ok(canonical) = std::fs::canonicalize(&candidate) else {
            return Ok(Outcome::Unavailable(format!("Core could not read back {}. It was left in place.", candidate.display())));
        };
        let meta = std::fs::symlink_metadata(&canonical)?;
        let (dev, ino) = (meta.dev() as i64, meta.ino() as i64);
        // Before it is recorded or handed to a server, the final canonical
        // path must be the directory just made: inside this Core's current
        // root, named for this Agent, 0700, the owner's, on the root's file
        // system, and within the platform's limit.
        if let Err(why) = verify(&canonical, dev, ino).and_then(|()| within_root(&canonical, &root, &prefixes)) {
            return Ok(Outcome::Unavailable(format!("{} can't be used: {why}. It was left in place.", canonical.display())));
        }
        store.save_executor_temp_dir(workspace, agent, &canonical.to_string_lossy(), dev, ino)?;
        return Ok(match store.executor_temp_dir(workspace, agent)? {
            Some(record) if record.path == canonical.to_string_lossy() => Outcome::Ready(canonical),
            _ => Outcome::Unavailable(format!("{} could not be recorded for this Agent. It was left in place.", canonical.display())),
        });
    }
    Ok(Outcome::Unavailable(format!(
        "no free name under {}: {}",
        root.display(),
        if tried.is_empty() { "none was tried".into() } else { tried.join("; ") }
    )))
}

/// Core's default temporary root, made 0700 under its data directory, after
/// checking it is Core's own directory and on the same file system.
#[cfg(unix)]
fn default_root(data: &Path) -> Result<PathBuf> {
    let data = std::fs::canonicalize(data)?;
    let data_meta = std::fs::symlink_metadata(&data)?;
    ensure!(data_meta.is_dir() && !data_meta.file_type().is_symlink(), "{} is not Core's data directory", data.display());
    let root = data.join(ROOT_NAME);
    match std::fs::symlink_metadata(&root) {
        Ok(meta) => {
            ensure!(meta.is_dir() && !meta.file_type().is_symlink(), "{} is not a directory", root.display());
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                ensure!(meta.uid() == rustix::process::getuid().as_raw(), "{} belongs to another user", root.display());
            }
            ensure!(meta.dev() == data_meta.dev(), "{} is on another file system", root.display());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(&root)?,
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(root)
}

/// The names to try for `agent`, shortest first; its full ID when the short
/// ones are the whole ID or are not enough.
#[cfg(unix)]
fn prefixes(agent: &str) -> Result<Vec<String>> {
    ensure!(!agent.is_empty() && agent.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Not an Agent ID a directory may be named for: {agent:?}");
    let mut prefixes = Vec::with_capacity(PREFIXES.len() + 1);
    for length in PREFIXES {
        if agent.len() > length {
            prefixes.push(agent[..length].to_owned());
        }
    }
    if prefixes.last().is_none_or(|prefix| prefix != agent) {
        prefixes.push(agent.to_owned());
    }
    Ok(prefixes)
}

/// The path's UTF-8 length when it is within this platform's limit.
#[cfg(unix)]
fn fits(path: &Path) -> Option<usize> {
    path.to_str().map(str::len).filter(|bytes| *bytes <= limit())
}

/// Whether the recorded directory is still the same one, and still safe to
/// hand to a server. Any doubt is a refusal, never a new record.
#[cfg(unix)]
fn verify(path: &Path, dev: i64, ino: i64) -> std::result::Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|error| format!("Core can't read {}: {error}", path.display()))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.uid() != rustix::process::getuid().as_raw() {
            return Err(format!("{} belongs to another user", path.display()));
        }
        if meta.permissions().mode() & 0o777 != 0o700 {
            return Err(format!("{} is not 0700", path.display()));
        }
        if meta.dev() != dev as u64 || meta.ino() != ino as u64 {
            return Err(format!("{} is not the directory Core recorded", path.display()));
        }
        let parent = path.parent().ok_or_else(|| format!("{} has no parent", path.display()))?;
        let parent = std::fs::symlink_metadata(parent).map_err(|error| format!("Core can't read {}: {error}", parent.display()))?;
        if parent.dev() != meta.dev() {
            return Err(format!("{} is on another file system", path.display()));
        }
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| format!("Core can't read {}: {error}", path.display()))?;
    if canonical != path.to_path_buf() {
        return Err(format!("{} is not its canonical path", path.display()));
    }
    if fits(path).is_none() {
        return Err(format!("{} is longer than this platform allows", path.display()));
    }
    Ok(())
}

/// Whether `path` is a direct child of this Core's current temporary root and
/// named with one of this Agent's prefixes. A restored backup's record can
/// still verify by identity while pointing into another data directory; that
/// path is outside the cleanup protection this Core fixed over its own root,
/// so it is refused rather than used.
#[cfg(unix)]
fn within_root(path: &Path, root: &Path, prefixes: &[String]) -> std::result::Result<(), String> {
    if path.parent() != Some(root) {
        return Err(format!("{} is not directly under this Core's temporary root {}", path.display(), root.display()));
    }
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    if !prefixes.iter().any(|prefix| prefix == name) {
        return Err(format!("{} is not a name for this Agent's temporary directory", path.display()));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::model::AgentDetail;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    fn lab() -> (tempfile::TempDir, Store) {
        // A short root that canonicalizes to itself on this file system: the
        // default temporary path must fit MAC_LIMIT (63 bytes), and macOS's
        // /var is a symlink to /private/var. /tmp is short on both platforms
        // (/private/tmp on macOS) and the fixture is removed with the lab.
        let dir = tempfile::Builder::new().prefix("yn78-").tempdir_in("/tmp").unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        (dir, store)
    }

    fn agent(store: &Store, id: &str) {
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
            "cwd":"/synthetic/work","model":"","harness":"opencode","color":"sage","status":"idle",
            "createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        store.insert(&detail).unwrap();
    }

    fn executor(store: &Store, id: &str) {
        store.db.write().unwrap().execute(
            "INSERT INTO agent_roles(agent_id,kind,template_id,created_by,state,created_at,updated_at)
             VALUES(?1,'executor','template','lead','created','now','now')", [id]).unwrap();
    }

    fn workspace(store: &Store) -> String {
        store.workspace_id().unwrap()
    }

    fn data(dir: &tempfile::TempDir) -> PathBuf {
        // The canonical data directory, as Core sees it: on macOS /tmp is a
        // symlink to /private/tmp, so expected paths must use the same form.
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::canonicalize(data).unwrap()
    }

    #[test]
    fn a_paths_limit_is_utf8_bytes_and_the_platforms() {
        assert_eq!((LINUX_LIMIT, MAC_LIMIT), (67, 63));
        let limit = limit();
        assert!(fits(Path::new(&"x".repeat(limit))).is_some());
        assert!(fits(Path::new(&"x".repeat(limit + 1))).is_none());
        // Bytes, not characters: 22 × 3 = 66 and 23 × 3 = 69. Whether each
        // fits is this platform's limit (67 on Linux, 63 on macOS).
        assert_eq!(fits(Path::new(&"数".repeat(22))).is_some(), 66 <= limit);
        assert_eq!(fits(Path::new(&"数".repeat(23))).is_none(), 69 > limit);
    }

    #[test]
    fn only_an_opencode_executor_with_a_level_that_waits_for_nobody_gets_a_directory() {
        let (dir, store) = lab();
        std::fs::create_dir_all(data(&dir)).unwrap();
        for (id, level, role) in [
            ("ask", Some("ask"), true), ("auto", Some("auto"), true), ("full", Some("full"), true),
            ("read-only", Some("read-only"), true), ("no-level", None, true), ("standing", Some("auto"), false),
        ] {
            agent(&store, id);
            if role {
                executor(&store, id);
            }
            store.set_permission_level(id, level).unwrap();
            let found = ensure_at_start(&store, &data(&dir), id).unwrap();
            assert_eq!(found.is_some(), matches!(level, Some("ask" | "auto" | "full")) && role, "{id}");
        }
        // The ineligible ones never wrote a directory or a note.
        let db = store.db.read().unwrap();
        let dirs: i64 = db.query_row("SELECT COUNT(*) FROM executor_temp_dirs", [], |r| r.get(0)).unwrap();
        let notes: i64 = db.query_row("SELECT COUNT(*) FROM executor_temp_notes", [], |r| r.get(0)).unwrap();
        assert_eq!((dirs, notes), (3, 0));
        drop(db);
        for id in ["ask", "auto", "full"] {
            let path = ensure_at_start(&store, &data(&dir), id).unwrap().unwrap();
            assert_eq!(path, data(&dir).join("t").join(id));
            assert_eq!(std::fs::symlink_metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn a_restart_reuses_the_recorded_directory_and_its_identity() {
        let (dir, store) = lab();
        std::fs::create_dir_all(data(&dir)).unwrap();
        agent(&store, "auto");
        executor(&store, "auto");
        store.set_permission_level("auto", Some("auto")).unwrap();
        let first = ensure_at_start(&store, &data(&dir), "auto").unwrap().unwrap();
        let record = store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap();
        assert_eq!(record.path, first.to_string_lossy());
        assert_eq!(record.released_at, None);
        // A restart in the same Core, and a Core opened again: the same path,
        // still no second record.
        assert_eq!(ensure_at_start(&store, &data(&dir), "auto").unwrap().unwrap(), first);
        drop(store);
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        assert_eq!(ensure_at_start(&store, &data(&dir), "auto").unwrap().unwrap(), first);
        assert_eq!(store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap().path, first.to_string_lossy());
    }

    #[test]
    fn a_prefix_grows_from_eight_to_twelve_to_the_full_id_on_a_collision() {
        let (dir, store) = lab();
        std::fs::create_dir_all(data(&dir)).unwrap();
        let ids = ["abcdefgh-1111-2222", "abcdefgh-3333-4444", "abcdefgh-3333-5555"];
        for id in ids {
            agent(&store, id);
            executor(&store, id);
            store.set_permission_level(id, Some("auto")).unwrap();
        }
        let first = ensure_at_start(&store, &data(&dir), ids[0]).unwrap().unwrap();
        let second = ensure_at_start(&store, &data(&dir), ids[1]).unwrap().unwrap();
        let third = ensure_at_start(&store, &data(&dir), ids[2]).unwrap().unwrap();
        assert_eq!(first, data(&dir).join("t").join("abcdefgh"));
        assert_eq!(second, data(&dir).join("t").join("abcdefgh-333"));
        assert_eq!(third, data(&dir).join("t").join(ids[2]));
    }

    #[test]
    fn a_directory_without_this_agents_record_is_never_taken_over() {
        let (dir, store) = lab();
        std::fs::create_dir_all(data(&dir).join("t").join("abcdefgh")).unwrap();
        agent(&store, "abcdefgh-1111");
        executor(&store, "abcdefgh-1111");
        store.set_permission_level("abcdefgh-1111", Some("auto")).unwrap();
        let found = ensure_at_start(&store, &data(&dir), "abcdefgh-1111").unwrap().unwrap();
        assert_eq!(found, data(&dir).join("t").join("abcdefgh-111"));
        let occupied = data(&dir).join("t").join("abcdefgh");
        assert!(std::fs::symlink_metadata(&occupied).unwrap().is_dir(), "the directory already there is untouched");
        assert_eq!(store.executor_temp_dir(&workspace(&store), "abcdefgh-1111").unwrap().unwrap().path, found.to_string_lossy());

        // Every name already there: no directory, a reason, and no record.
        let (other_dir, other) = lab();
        std::fs::create_dir_all(data(&other_dir).join("t")).unwrap();
        for name in ["abcdefgh", "abcdefgh-333", "abcdefgh-3333-full"] {
            std::fs::create_dir_all(data(&other_dir).join("t").join(name)).unwrap();
        }
        agent(&other, "abcdefgh-3333-full");
        executor(&other, "abcdefgh-3333-full");
        other.set_permission_level("abcdefgh-3333-full", Some("auto")).unwrap();
        assert_eq!(ensure_at_start(&other, &data(&other_dir), "abcdefgh-3333-full").unwrap(), None);
        assert_eq!(other.executor_temp_dir(&workspace(&other), "abcdefgh-3333-full").unwrap(), None);
        assert!(other.executor_temp_view("abcdefgh-3333-full").unwrap().unwrap()["note"].as_str().unwrap().contains("no free name"));
    }

    #[test]
    fn a_replaced_directory_is_refused_and_never_rebound() {
        let (dir, store) = lab();
        std::fs::create_dir_all(data(&dir)).unwrap();
        agent(&store, "auto");
        executor(&store, "auto");
        store.set_permission_level("auto", Some("auto")).unwrap();
        let path = ensure_at_start(&store, &data(&dir), "auto").unwrap().unwrap();
        let record = store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap();
        // The same name, a different directory: the record does not follow it.
        // The old directory is renamed aside first, so its inode cannot be
        // handed to the new one (a file system may reuse a freed inode).
        let aside = path.with_file_name("auto-old");
        std::fs::rename(&path, &aside).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(ensure_at_start(&store, &data(&dir), "auto").unwrap(), None);
        assert_eq!(store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap(), record, "the record is unchanged");
        assert!(store.executor_temp_view("auto").unwrap().unwrap()["note"].as_str().unwrap().contains("can't be used"));
        // A symlink there is refused too.
        std::fs::remove_dir(&path).unwrap();
        std::os::unix::fs::symlink(data(&dir).join("elsewhere"), &path).unwrap();
        assert_eq!(ensure_at_start(&store, &data(&dir), "auto").unwrap(), None);
        assert_eq!(store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap(), record);
        std::fs::remove_dir(&aside).unwrap();
    }

    #[test]
    fn a_record_from_another_data_directory_is_refused_and_kept() {
        let (dir, store) = lab();
        agent(&store, "auto");
        executor(&store, "auto");
        store.set_permission_level("auto", Some("auto")).unwrap();
        let old = ensure_at_start(&store, &data(&dir), "auto").unwrap().unwrap();
        let record = store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap();

        // A restored backup keeps the Workspace and this record but starts
        // under a new data directory. The old directory is still the same
        // directory by identity, yet it is outside the root this Core protects
        // and is never reused, rebound or deleted; no environment is passed.
        let new_data = dir.path().join("restored");
        std::fs::create_dir_all(&new_data).unwrap();
        let new_data = std::fs::canonicalize(&new_data).unwrap();
        assert_eq!(ensure_at_start(&store, &new_data, "auto").unwrap(), None);
        assert!(old.is_dir(), "the old directory is never deleted");
        assert_eq!(store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap(), record, "the record is unchanged");
        let note = store.executor_temp_view("auto").unwrap().unwrap();
        assert!(note["note"].as_str().unwrap().contains("temporary root"), "{note}");
        assert!(!new_data.join("t").join("auto").exists(), "nothing is made in the new root for it");
    }

    #[test]
    fn a_data_directory_alias_that_canonicalizes_to_the_same_root_reuses_the_record() {
        let (dir, store) = lab();
        let data = data(&dir);
        agent(&store, "auto");
        executor(&store, "auto");
        store.set_permission_level("auto", Some("auto")).unwrap();
        let first = ensure_at_start(&store, &data, "auto").unwrap().unwrap();
        let alias = dir.path().join("data-alias");
        std::os::unix::fs::symlink(&data, &alias).unwrap();
        assert_eq!(ensure_at_start(&store, &alias, "auto").unwrap().unwrap(), first);
    }

    #[test]
    fn a_record_under_the_root_with_another_agents_name_is_refused() {
        let (dir, store) = lab();
        agent(&store, "auto");
        executor(&store, "auto");
        store.set_permission_level("auto", Some("auto")).unwrap();
        let root = data(&dir).join("t");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let other = root.join("someone-else");
        std::fs::create_dir(&other).unwrap();
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o700)).unwrap();
        let meta = std::fs::symlink_metadata(&other).unwrap();
        store.save_executor_temp_dir(&workspace(&store), "auto", &other.to_string_lossy(), meta.dev() as i64, meta.ino() as i64).unwrap();
        let record = store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap();
        assert_eq!(ensure_at_start(&store, &data(&dir), "auto").unwrap(), None);
        assert!(other.is_dir(), "the directory is never taken over or deleted");
        assert_eq!(store.executor_temp_dir(&workspace(&store), "auto").unwrap().unwrap(), record);
        let note = store.executor_temp_view("auto").unwrap().unwrap();
        assert!(note["note"].as_str().unwrap().contains("not a name"), "{note}");
    }

    #[test]
    fn a_path_too_long_or_without_free_names_keeps_todays_behaviour() {
        let (dir, store) = lab();
        // A data path already long enough that <D>/t/<id> is over the limit:
        // the default root is made, no Agent directory is, and no env is passed.
        let deep = dir.path().join("x".repeat(40)).join("y".repeat(40));
        std::fs::create_dir_all(&deep).unwrap();
        agent(&store, "auto");
        executor(&store, "auto");
        store.set_permission_level("auto", Some("auto")).unwrap();
        assert_eq!(ensure_at_start(&store, &deep, "auto").unwrap(), None);
        assert!(!deep.join("t").join("auto").exists(), "no over-long directory is made");
        let note = store.executor_temp_view("auto").unwrap().unwrap();
        assert!(note["note"].as_str().unwrap().contains("more than"), "{note}");

        // Non-ASCII in the data path counts in bytes, not characters.
        let (unicode_dir, unicode) = lab();
        let unicode_deep = unicode_dir.path().join("数据".repeat(8));
        std::fs::create_dir_all(&unicode_deep).unwrap();
        agent(&unicode, "auto");
        executor(&unicode, "auto");
        unicode.set_permission_level("auto", Some("auto")).unwrap();
        assert!(unicode_deep.join("t").join("auto").to_str().unwrap().len() > limit(), "the case must be over the limit");
        assert_eq!(ensure_at_start(&unicode, &unicode_deep, "auto").unwrap(), None);
        assert!(!unicode_deep.join("t").join("auto").exists());
    }

    #[test]
    fn release_and_delete_keep_the_record_and_the_directory_and_keep_the_first_time() {
        let (dir, store) = lab();
        std::fs::create_dir_all(data(&dir)).unwrap();
        agent(&store, "auto");
        executor(&store, "auto");
        store.set_permission_level("auto", Some("auto")).unwrap();
        let path = ensure_at_start(&store, &data(&dir), "auto").unwrap().unwrap();
        let workspace = workspace(&store);
        // An ordinary close is not a release.
        store.update("auto", "agent/closed", &json!({"reason": "closed"}), |d| d.agent.closed_at = Some("closed-at".into())).unwrap();
        assert_eq!(store.executor_temp_dir(&workspace, "auto").unwrap().unwrap().released_at, None);
        // A release records the close's time once; a later release keeps it.
        store.update("auto", "agent/closed", &json!({"reason": "released", "by": "user"}), |_| {}).unwrap();
        assert_eq!(store.executor_temp_dir(&workspace, "auto").unwrap().unwrap().released_at.as_deref(), Some("closed-at"));
        release_for_close(&store.db.write().unwrap(), "auto", "later").unwrap();
        assert_eq!(store.executor_temp_dir(&workspace, "auto").unwrap().unwrap().released_at.as_deref(), Some("closed-at"));
        // Deleting the Agent records the first release and leaves the record
        // and the directory.
        store.delete_closed_agent("auto").unwrap();
        assert!(path.is_dir(), "the directory is never deleted");
        assert_eq!(store.executor_temp_dir(&workspace, "auto").unwrap().unwrap().released_at.as_deref(), Some("closed-at"));

        // A delete without a release records the delete's time, and keeps
        // the directory too.
        agent(&store, "deleted");
        executor(&store, "deleted");
        store.set_permission_level("deleted", Some("auto")).unwrap();
        let deleted = ensure_at_start(&store, &data(&dir), "deleted").unwrap().unwrap();
        store.update("deleted", "agent/closed", &json!({"reason": "closed"}), |d| d.agent.closed_at = Some("closed-at".into())).unwrap();
        store.delete_closed_agent("deleted").unwrap();
        assert!(deleted.is_dir(), "the directory is never deleted");
        assert!(store.executor_temp_dir(&workspace, "deleted").unwrap().unwrap().released_at.is_some());
    }
}
