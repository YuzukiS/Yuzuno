//! Where Core keeps its Workspace when it is not told (`--data-dir`,
//! `YUZUNO_DATA_DIR`): `<platform data>/yuzuno/workspace`, for example
//! `~/.local/share/yuzuno/workspace` on Linux. The product folder above it
//! may already hold other things (an older Yuzuno product's files, a managed
//! Core install), so Core uses only its own `workspace` folder in it and
//! never changes the product folder or anything else there.
//!
//! A Workspace in the folder builds before T-137 used,
//! `<platform data>/yuzuno-next`, is used where it is. Its records, local
//! Jobs, image copies and lock name absolute paths in it, so Core never moves
//! or copies it on its own; `move_legacy` (`--move-workspace`) moves it, with
//! Core stopped, and leaves a link at the old path.
//!
//! Everything is classified by reading before anything is created. Two
//! different Workspaces, or a `workspace` folder holding something Core did
//! not make, stop Core with both paths named; nothing is written.
use anyhow::{bail, ensure, Context, Result};
use std::path::{Path, PathBuf};

/// The product's folder in the platform's data folder.
pub const PRODUCT: &str = "yuzuno";
/// Core's own folder in it.
pub const WORKSPACE: &str = "workspace";
/// The default of builds before T-137: recognized, never created.
pub const LEGACY: &str = "yuzuno-next";
/// What makes a folder a Workspace: its database.
const DATABASE: &str = "workspace.sqlite";

/// The Workspace folder to use, and whether it is the legacy one.
#[derive(Debug, PartialEq)]
pub struct Chosen {
    pub path: PathBuf,
    pub legacy: bool,
}

#[derive(Debug, PartialEq)]
enum Found {
    Missing,
    /// It has a Workspace database.
    Workspace,
    /// Empty, or only the lock a first start that stopped early leaves.
    Unstarted,
    /// It holds this name, which Core did not put there.
    Other(String),
    /// A file or something else that is not a folder.
    NotFolder,
}

/// Reads `dir` (following a link, as Core's own use of it does).
fn classify(dir: &Path) -> Result<Found> {
    let meta = match std::fs::metadata(dir) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A dangling link is not a missing folder Core may create.
            return Ok(if std::fs::symlink_metadata(dir).is_ok() { Found::NotFolder } else { Found::Missing });
        }
        Err(error) => return Err(error).with_context(|| format!("Cannot read {}", dir.display())),
    };
    if !meta.is_dir() {
        return Ok(Found::NotFolder);
    }
    if std::fs::symlink_metadata(dir.join(DATABASE)).is_ok() {
        return Ok(Found::Workspace);
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir).with_context(|| format!("Cannot read {}", dir.display()))? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name != "workspace.lock" {
            names.push(name);
        }
    }
    names.sort();
    Ok(match names.into_iter().next() {
        None => Found::Unstarted,
        Some(name) => Found::Other(name),
    })
}

/// The default Workspace folder under `base`, the platform's data folder.
/// Reads only; Workspace::new creates the folder it returns, if needed.
pub fn resolve(base: &Path) -> Result<Chosen> {
    let product = base.join(PRODUCT);
    let new = product.join(WORKSPACE);
    let legacy = base.join(LEGACY);
    let chosen = |path: &Path, legacy| Ok(Chosen { path: path.to_owned(), legacy });
    // A product folder that is not a folder is named itself.
    let (blocked, found) = match classify(&product)? {
        Found::NotFolder => (&product, Found::NotFolder),
        _ => (&new, classify(&new)?),
    };
    match (found, classify(&legacy)?) {
        (Found::Workspace, Found::Workspace) => {
            if std::fs::canonicalize(&new)? == std::fs::canonicalize(&legacy)? {
                return chosen(&new, false);
            }
            bail!(
                "There are two Workspaces, {} and {} (where builds before this one kept it). \
                 Core does not choose between them or change either: start it with \
                 --data-dir naming the one to use.",
                new.display(),
                legacy.display()
            )
        }
        (Found::Workspace, _) => chosen(&new, false),
        // Used where it is, even beside an empty new folder.
        (_, Found::Workspace) => chosen(&legacy, true),
        (Found::Missing | Found::Unstarted, _) => chosen(&new, false),
        (Found::Other(name), _) => bail!(
            "{} holds {name:?}, which this Core did not put there, and no Workspace; \
             Core does not start a new Workspace in it. Start Core with --data-dir naming another folder.",
            new.display()
        ),
        (Found::NotFolder, _) => bail!(
            "{} is not a folder, so Core cannot keep its Workspace there; start Core with --data-dir",
            blocked.display()
        ),
    }
}

/// What `move_legacy` did.
#[derive(Debug, PartialEq)]
pub enum Moved {
    /// The Workspace is now in `<base>/yuzuno/workspace`; the old path links to it.
    Moved(PathBuf),
    /// It already was.
    AlreadyMoved(PathBuf),
}

/// `--move-workspace`: moves a Workspace that builds before T-137 kept in
/// `<base>/yuzuno-next` to `<base>/yuzuno/workspace`, leaving a link at the
/// old path for the absolute paths its records and native histories hold.
/// Run with Core stopped; it is refused while a Core holds the Workspace.
///
/// Neither path is ever missing or another folder: under the Workspace's own
/// lock, a link that resolves to nothing is put at the new path (no Core can
/// use it as a folder: create_dir_all fails on it, and `resolve` takes the
/// Workspace where it is), then the two paths are exchanged in one atomic
/// step (renameat2 RENAME_EXCHANGE). The old path is the folder until then
/// and the link to it after; any Core reaches the folder's own lock through
/// either. Each state an interruption can leave is one every Core opens as
/// the same Workspace, and running this again finishes the move. A file
/// system that cannot exchange leaves everything as it was.
///
/// Refused, with nothing changed, unless: the default location is the legacy
/// one, a real folder with a Workspace, on the same file system as `<base>`
/// and `<base>/yuzuno`; nothing is at the new path (but the link of an
/// interrupted run); its database passes a quick check; no Job is unfinished
/// (queued, waiting or holding its slot); and no managed update is under way:
/// no update helper runs, and the update journal of `install` (the managed
/// install, `--install-dir`) and of `<base>/yuzuno/managed-core` shows none.
/// Linux only, where it was tested: elsewhere it is refused. `step` is called
/// at each step (tests interrupt there).
pub fn move_legacy(base: &Path, install: Option<&Path>, step: &mut dyn FnMut(&str) -> Result<()>) -> Result<Moved> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (base, install, step);
        bail!("Moving the Workspace is available on Linux only so far; it stays where it is");
    }
    #[cfg(target_os = "linux")]
    move_on_linux(base, install, step)
}

/// The link left at the old path, relative to `<base>`. At the new path,
/// before the exchange, it resolves to `<base>/yuzuno/yuzuno/workspace`: nothing.
#[cfg(target_os = "linux")]
const LINK: &str = "yuzuno/workspace";

#[cfg(target_os = "linux")]
fn move_on_linux(base: &Path, install: Option<&Path>, step: &mut dyn FnMut(&str) -> Result<()>) -> Result<Moved> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    let product = base.join(PRODUCT);
    let new = product.join(WORKSPACE);
    let legacy = base.join(LEGACY);
    let id = |meta: &std::fs::Metadata| (meta.dev(), meta.ino());
    let sync = |dir: &Path| -> Result<()> {
        std::fs::File::open(dir).and_then(|d| d.sync_all()).with_context(|| format!("Cannot sync {}", dir.display()))
    };
    let prepared = || {
        std::fs::symlink_metadata(&new).is_ok_and(|m| m.file_type().is_symlink())
            && std::fs::read_link(&new).is_ok_and(|text| text == Path::new(LINK))
            && std::fs::metadata(&new).is_err()
    };
    // Done before: the folder at the new path, the old path a link to it.
    if let (Ok(moved), Ok(link), Ok(through)) =
        (std::fs::symlink_metadata(&new), std::fs::symlink_metadata(&legacy), std::fs::metadata(&legacy))
    {
        if moved.is_dir() && !moved.file_type().is_symlink() && link.file_type().is_symlink() && id(&moved) == id(&through) {
            // Decided under the lock too: a move still finishing holds it.
            let _lock = crate::store::lock_workspace(&new.join(DATABASE))?;
            return Ok(Moved::AlreadyMoved(new));
        }
    }
    let folder = match std::fs::symlink_metadata(&legacy) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => meta,
        Ok(_) => bail!("{} is not a folder of its own; nothing was moved", legacy.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            bail!("There is no Workspace in {} to move; nothing was changed", legacy.display())
        }
        Err(error) => return Err(error).with_context(|| format!("Cannot read {}", legacy.display())),
    };
    ensure!(legacy.join(DATABASE).is_file(), "{} holds no Workspace; nothing was moved", legacy.display());
    // The lock every Core takes: the same file whichever path reaches it.
    let lock = crate::store::lock_workspace(&legacy.join(DATABASE))?;
    step("locked")?;
    // Classified again under the lock: the lock must be this folder's.
    let now = std::fs::symlink_metadata(&legacy)?;
    let named = std::fs::symlink_metadata(legacy.join("workspace.lock"))?;
    ensure!(!now.file_type().is_symlink() && id(&now) == id(&folder) && id(&lock.metadata()?) == id(&named),
        "{} changed while it was being locked; nothing was moved", legacy.display());
    let base_dev = std::fs::metadata(base)?.dev();
    ensure!(folder.dev() == base_dev, "{} is another file system than {}; nothing was moved", legacy.display(), base.display());
    let made_product = match std::fs::symlink_metadata(&product) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() && meta.dev() == base_dev => false,
        Ok(_) => bail!("{} is not a folder on the same file system; nothing was moved", product.display()),
        Err(error) => return Err(error).with_context(|| format!("Cannot read {}", product.display())),
    };
    let was_prepared = prepared();
    if !was_prepared {
        match std::fs::symlink_metadata(&new) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => bail!("{} exists; it is not replaced, and nothing was moved", new.display()),
            Err(error) => return Err(error).with_context(|| format!("Cannot read {}", new.display())),
        }
    }
    preconditions(&legacy, base, install)?;
    if made_product {
        std::fs::create_dir(&product).with_context(|| format!("Cannot create {}", product.display()))?;
        sync(base)?;
    }
    step("product")?;
    if !was_prepared {
        std::os::unix::fs::symlink(LINK, &new).with_context(|| format!("Cannot link {}", new.display()))?;
        sync(&product)?;
    }
    step("linked")?;
    let failed = if cfg!(debug_assertions) && std::env::var_os("YUZUNO_MOVE_EXCHANGE_FAILS").is_some() {
        Some(std::io::Error::from_raw_os_error(libc::EINVAL))
    } else {
        let (old, to) = (std::ffi::CString::new(legacy.as_os_str().as_bytes())?, std::ffi::CString::new(new.as_os_str().as_bytes())?);
        // SAFETY: two NUL-terminated paths that renameat2 only reads.
        let rc = unsafe { libc::renameat2(libc::AT_FDCWD, old.as_ptr(), libc::AT_FDCWD, to.as_ptr(), libc::RENAME_EXCHANGE) };
        (rc != 0).then(std::io::Error::last_os_error)
    };
    if let Some(error) = failed {
        // Back to exactly what was there: no link, and no product folder this run made.
        std::fs::remove_file(&new).with_context(|| format!("The exchange failed ({error}); cannot remove the link {}", new.display()))?;
        if made_product {
            let _ = std::fs::remove_dir(&product);
        }
        sync(base)?;
        bail!("This file system cannot exchange two paths atomically ({error}); the Workspace stays in {}, and nothing was moved",
            legacy.display());
    }
    step("exchanged")?;
    sync(base)?;
    sync(&product)?;
    let moved = std::fs::symlink_metadata(&new)?;
    let link = std::fs::symlink_metadata(&legacy)?;
    let through = std::fs::metadata(&legacy)?;
    ensure!(moved.is_dir() && id(&moved) == id(&folder) && link.file_type().is_symlink() && id(&through) == id(&folder),
        "After the exchange, {} and {} do not name the Workspace as expected", new.display(), legacy.display());
    step("verified")?;
    drop(lock);
    Ok(Moved::Moved(new))
}

/// What must hold before the folder moves, read under its lock.
#[cfg(target_os = "linux")]
fn preconditions(legacy: &Path, base: &Path, install: Option<&Path>) -> Result<()> {
    let db = read_only(&legacy.join(DATABASE))?;
    let check: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    ensure!(check == "ok", "The Workspace database fails its quick check ({check}); nothing was moved");
    // A Job's folder, logs and supervisor name paths in the Workspace.
    let unfinished = unfinished_jobs(&db)?;
    ensure!(unfinished == 0, "{unfinished} Job(s) have not ended; move the Workspace once they have. Nothing was moved");
    // A managed update records the Workspace path for its whole operation. Its
    // helper runs for all of it, wherever the install is; the journal also
    // covers a helper that stopped half-way.
    if let Some(pid) = running_update_helper()? {
        bail!("An update helper is running (process {pid}); move the Workspace once the update has ended. Nothing was moved");
    }
    for root in install.into_iter().map(Path::to_path_buf).chain([base.join(PRODUCT).join("managed-core")]) {
        let journal = root.join("updates/state.json");
        let Ok(text) = std::fs::read_to_string(&journal) else { continue };
        let state: serde_json::Value = serde_json::from_str(&text).with_context(|| format!("Cannot read {}", journal.display()))?;
        let phase = state["operation"]["phase"].as_str().unwrap_or("");
        ensure!(!matches!(phase, "preparing" | "waiting" | "flushing" | "stopping" | "starting" | "restoring"),
            "A managed update is under way ({phase}, {}); move the Workspace once it has ended. Nothing was moved", root.display());
    }
    Ok(())
}

/// Opens a Workspace database no Core is writing, reading without writing
/// anything there. With no write-ahead log content (none is being written),
/// the database file is all there is and is opened immutable: SQLite then
/// makes no -wal or -shm file. With content, a read-only connection still
/// rebuilds SQLite's own shared-memory index (-shm) and changes nothing else.
pub(crate) fn read_only(database: &Path) -> Result<rusqlite::Connection> {
    use rusqlite::{Connection, OpenFlags};
    let mut wal = database.as_os_str().to_owned();
    wal.push("-wal");
    let wal = std::fs::metadata(wal).map_or(0, |meta| meta.len());
    let mut uri = String::from("file:");
    for c in database.to_string_lossy().chars() {
        match c {
            '%' => uri.push_str("%25"),
            '?' => uri.push_str("%3f"),
            '#' => uri.push_str("%23"),
            ' ' => uri.push_str("%20"),
            c => uri.push(c),
        }
    }
    uri.push_str(if wal == 0 { "?mode=ro&immutable=1" } else { "?mode=ro" });
    Ok(Connection::open_with_flags(&uri, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)?)
}

/// Jobs that have not ended, as store.rs machine_jobs counts them: a run's
/// stage that waits for its upstream stages has its folder and inputs named
/// in the Workspace too. A Workspace without the Jobs table has none.
pub(crate) fn unfinished_jobs(db: &rusqlite::Connection) -> Result<i64> {
    let has_jobs: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_jobs')", [], |r| r.get(0))?;
    if !has_jobs {
        return Ok(0);
    }
    Ok(db.query_row("SELECT COUNT(*) FROM local_jobs WHERE reserved=1 OR status IN ('queued','waiting')", [], |r| r.get(0))?)
}

/// A `yuzuno-update-helper` process of this account, if one runs.
#[cfg(target_os = "linux")]
fn running_update_helper() -> Result<Option<u32>> {
    update_helper_in(Path::new("/proc"))
}

/// The update helper among the processes `proc` lists. A list that cannot be
/// read whole is an error, never "none runs": a helper may be in what was not
/// read. A process skipped is one gone since it was listed or one without an
/// executable (a kernel thread or a zombie), and one whose executable this
/// account may not read: another account's, or one that made itself
/// non-dumpable, as agents for keys do (the update helper does not).
#[cfg(target_os = "linux")]
fn update_helper_in(proc: &Path) -> Result<Option<u32>> {
    let unknown = |error: std::io::Error| {
        anyhow::anyhow!("Cannot tell whether an update helper is running: {} cannot be read ({error}). Nothing was moved",
            proc.display())
    };
    for entry in std::fs::read_dir(proc).map_err(unknown)? {
        let name = entry.map_err(unknown)?.file_name();
        let Some(pid) = name.to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
        match std::fs::read_link(proc.join(name).join("exe")) {
            Ok(exe) if exe.file_name().is_some_and(|file| file.to_string_lossy().starts_with("yuzuno-update-helper")) => {
                return Ok(Some(pid));
            }
            Ok(_) => {}
            Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied) => {}
            Err(error) => return Err(unknown(error)),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn workspace(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(DATABASE), "").unwrap();
    }

    /// Every path under `root` with its kind and permissions.
    fn tree(root: &Path) -> Vec<(String, u32)> {
        let mut found = Vec::new();
        let mut stack = vec![root.to_owned()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                let meta = std::fs::symlink_metadata(&path).unwrap();
                found.push((path.strip_prefix(root).unwrap().display().to_string(), meta.permissions().mode()));
                if meta.is_dir() {
                    stack.push(path);
                }
            }
        }
        found.sort();
        found
    }

    #[test]
    fn a_new_install_gets_the_workspace_folder_and_nothing_is_made_by_looking() {
        let base = tempfile::tempdir().unwrap();
        let chosen = resolve(base.path()).unwrap();
        assert_eq!(chosen, Chosen { path: base.path().join("yuzuno/workspace"), legacy: false });
        assert!(tree(base.path()).is_empty());
        // An empty legacy folder is not a Workspace.
        std::fs::create_dir(base.path().join(LEGACY)).unwrap();
        assert_eq!(resolve(base.path()).unwrap().path, base.path().join("yuzuno/workspace"));
    }

    #[test]
    fn a_legacy_workspace_is_used_where_it_is_and_a_new_one_wins_once_it_exists() {
        let base = tempfile::tempdir().unwrap();
        let legacy = base.path().join(LEGACY);
        workspace(&legacy);
        let before = tree(base.path());
        assert_eq!(resolve(base.path()).unwrap(), Chosen { path: legacy.clone(), legacy: true });
        assert_eq!(tree(base.path()), before, "classified by reading only");
        // An unstarted new folder does not hide it.
        std::fs::create_dir_all(base.path().join("yuzuno/workspace")).unwrap();
        assert_eq!(resolve(base.path()).unwrap().path, legacy);
        // The same Workspace under both names is one Workspace.
        std::fs::remove_dir(base.path().join("yuzuno/workspace")).unwrap();
        std::os::unix::fs::symlink(&legacy, base.path().join("yuzuno/workspace")).unwrap();
        assert_eq!(resolve(base.path()).unwrap(), Chosen { path: base.path().join("yuzuno/workspace"), legacy: false });
    }

    #[test]
    fn two_different_workspaces_stop_core_and_neither_is_touched() {
        let base = tempfile::tempdir().unwrap();
        workspace(&base.path().join(LEGACY));
        workspace(&base.path().join("yuzuno/workspace"));
        let before = tree(base.path());
        let error = resolve(base.path()).unwrap_err().to_string();
        assert!(error.contains("two Workspaces") && error.contains("--data-dir"), "{error}");
        assert!(error.contains(&base.path().join(LEGACY).display().to_string()), "{error}");
        assert_eq!(tree(base.path()), before);
    }

    #[test]
    fn another_products_files_beside_it_are_left_as_they_are() {
        let base = tempfile::tempdir().unwrap();
        // An older Yuzuno product and a managed Core install in the product folder.
        let product = base.path().join(PRODUCT);
        for dir in ["node", "nodes", "plugins", "managed-core/releases"] {
            std::fs::create_dir_all(product.join(dir)).unwrap();
        }
        std::fs::write(product.join("yuzuno.db"), "old product").unwrap();
        std::fs::write(product.join("supervisor.lock"), "").unwrap();
        std::fs::set_permissions(&product, std::fs::Permissions::from_mode(0o755)).unwrap();
        let before = tree(&product);
        let chosen = resolve(base.path()).unwrap();
        assert_eq!(chosen.path, product.join(WORKSPACE));
        // Core's own folder is made private; the product folder is not changed.
        let ws = crate::workspace::Workspace::new(chosen.path.clone(), "/".into(), "codex".into()).unwrap();
        drop(ws);
        assert_eq!(mode(&product), 0o755);
        assert_eq!(mode(&product.join(WORKSPACE)), 0o700);
        let after: Vec<_> = tree(&product).into_iter().filter(|(path, _)| !path.starts_with(WORKSPACE)).collect();
        assert_eq!(after, before);
        assert_eq!(std::fs::read_to_string(product.join("yuzuno.db")).unwrap(), "old product");
        // And the next start finds that Workspace.
        assert_eq!(resolve(base.path()).unwrap().path, product.join(WORKSPACE));
    }

    #[test]
    fn a_workspace_folder_that_core_did_not_make_is_never_used() {
        let base = tempfile::tempdir().unwrap();
        let new = base.path().join("yuzuno/workspace");
        std::fs::create_dir_all(&new).unwrap();
        // Only the lock a first start leaves: that start stopped early.
        std::fs::write(new.join("workspace.lock"), "").unwrap();
        assert_eq!(resolve(base.path()).unwrap().path, new);
        std::fs::write(new.join("notes.txt"), "someone's").unwrap();
        let before = tree(base.path());
        let error = resolve(base.path()).unwrap_err().to_string();
        assert!(error.contains("\"notes.txt\"") && error.contains("did not put there"), "{error}");
        assert_eq!(tree(base.path()), before);
        // Not a folder at all.
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join(PRODUCT), "a file").unwrap();
        let error = resolve(other.path()).unwrap_err().to_string();
        assert!(error.contains(&format!("{} is not a folder", other.path().join(PRODUCT).display())), "{error}");
        // A legacy Workspace beside it is still used where it is.
        workspace(&other.path().join(LEGACY));
        assert_eq!(resolve(other.path()).unwrap().path, other.path().join(LEGACY));
        let dangling = tempfile::tempdir().unwrap();
        std::fs::create_dir(dangling.path().join(PRODUCT)).unwrap();
        std::os::unix::fs::symlink(dangling.path().join("gone"), dangling.path().join("yuzuno/workspace")).unwrap();
        assert!(resolve(dangling.path()).unwrap_err().to_string().contains("is not a folder"));
    }

    #[test]
    fn a_legacy_workspace_another_core_holds_is_refused_and_no_empty_one_is_made() {
        let base = tempfile::tempdir().unwrap();
        let legacy = base.path().join(LEGACY);
        std::fs::create_dir(&legacy).unwrap();
        let running = crate::store::Store::open(&legacy.join(DATABASE)).unwrap();
        let chosen = resolve(base.path()).unwrap();
        assert_eq!(chosen.path, legacy);
        let error = crate::workspace::Workspace::new(chosen.path, "/".into(), "codex".into()).err().unwrap().to_string();
        assert!(error.contains("另一个 Core"), "{error}");
        assert!(!base.path().join(PRODUCT).exists(), "no new Workspace beside the one in use");
        drop(running);
    }

    /// A legacy Workspace with a real database, an image copy and a Job log,
    /// as records and native histories name them by absolute path.
    #[cfg(target_os = "linux")]
    fn legacy(base: &Path) -> std::path::PathBuf {
        let dir = base.join(LEGACY);
        std::fs::create_dir_all(dir.join("input-images/a")).unwrap();
        std::fs::create_dir_all(dir.join("jobs/j")).unwrap();
        let db = rusqlite::Connection::open(dir.join(DATABASE)).unwrap();
        db.execute_batch("CREATE TABLE workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO workspace_meta VALUES('workspaceId','w-1');
            CREATE TABLE local_jobs(id TEXT, status TEXT, reserved INTEGER, data TEXT);").unwrap();
        std::fs::write(dir.join("input-images/a/i.png"), "image").unwrap();
        std::fs::write(dir.join("jobs/j/log-0.bin"), "log").unwrap();
        std::fs::write(dir.join("workspace.lock"), "").unwrap();
        dir
    }

    #[cfg(target_os = "linux")]
    fn ino(path: &Path) -> u64 {
        std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(path).unwrap())
    }

    #[cfg(target_os = "linux")]
    fn never(_: &str) -> Result<()> {
        Ok(())
    }

    /// The moves look at every process (an update helper refuses them), and
    /// one test runs a stand-in helper: they take turns.
    #[cfg(target_os = "linux")]
    static MOVES: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(target_os = "linux")]
    fn one_move_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        MOVES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_legacy_workspace_moves_and_its_old_paths_still_lead_to_it() {
        let _turn = one_move_at_a_time();
        let tmp = tempfile::tempdir().unwrap();
        let old = legacy(tmp.path());
        let database = ino(&old.join(DATABASE));
        let new = tmp.path().join(PRODUCT).join(WORKSPACE);
        assert_eq!(move_legacy(tmp.path(), None, &mut never).unwrap(), Moved::Moved(new.clone()));
        assert!(!std::fs::symlink_metadata(&new).unwrap().file_type().is_symlink());
        assert!(std::fs::symlink_metadata(&old).unwrap().file_type().is_symlink());
        assert_eq!(ino(&new.join(DATABASE)), database, "the same database, not a copy");
        assert_eq!(std::fs::read_to_string(old.join("input-images/a/i.png")).unwrap(), "image");
        assert_eq!(std::fs::read_to_string(old.join("jobs/j/log-0.bin")).unwrap(), "log");
        assert_eq!(resolve(tmp.path()).unwrap(), Chosen { path: new.clone(), legacy: false });
        assert_eq!(move_legacy(tmp.path(), None, &mut never).unwrap(), Moved::AlreadyMoved(new));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_interrupted_move_leaves_the_same_workspace_found_and_a_rerun_finishes_it() {
        let _turn = one_move_at_a_time();
        for at in ["locked", "product", "linked", "exchanged", "verified"] {
            let tmp = tempfile::tempdir().unwrap();
            let old = legacy(tmp.path());
            let database = ino(&old.join(DATABASE));
            let mut stop = |name: &str| -> Result<()> { if name == at { bail!("stopped at {name}") } Ok(()) };
            assert!(move_legacy(tmp.path(), None, &mut stop).is_err(), "{at}");
            // Whatever it left, Core finds the one Workspace there is.
            let chosen = resolve(tmp.path()).unwrap();
            assert_eq!(ino(&chosen.path.join(DATABASE)), database, "{at}: {chosen:?}");
            let done = move_legacy(tmp.path(), None, &mut never).unwrap();
            let new = tmp.path().join(PRODUCT).join(WORKSPACE);
            assert!(matches!(&done, Moved::Moved(path) | Moved::AlreadyMoved(path) if *path == new), "{at}: {done:?}");
            assert_eq!(ino(&new.join(DATABASE)), database, "{at}");
            assert!(std::fs::symlink_metadata(&old).unwrap().file_type().is_symlink(), "{at}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_move_that_could_lose_or_split_something_is_refused_and_nothing_changes() {
        let _turn = one_move_at_a_time();
        let unchanged = |why: &str, setup: &dyn Fn(&Path)| {
            let tmp = tempfile::tempdir().unwrap();
            legacy(tmp.path());
            setup(tmp.path());
            let before = tree(tmp.path());
            let refused = move_legacy(tmp.path(), None, &mut never).unwrap_err().to_string();
            assert!(refused.contains(why), "{refused}");
            assert_eq!(tree(tmp.path()), before, "{why}");
        };
        unchanged("Job(s) have not ended", &|base| {
            rusqlite::Connection::open(base.join(LEGACY).join(DATABASE)).unwrap()
                .execute("INSERT INTO local_jobs VALUES('j','running',1,'{}')", []).unwrap();
        });
        // A run's stage that waits for its upstream stages holds no slot yet.
        unchanged("Job(s) have not ended", &|base| {
            rusqlite::Connection::open(base.join(LEGACY).join(DATABASE)).unwrap()
                .execute("INSERT INTO local_jobs VALUES('s','waiting',0,'{}')", []).unwrap();
        });
        unchanged("A managed update is under way", &|base| {
            let updates = base.join(PRODUCT).join("managed-core/updates");
            std::fs::create_dir_all(&updates).unwrap();
            std::fs::write(updates.join("state.json"), r#"{"operation":{"phase":"waiting"}}"#).unwrap();
        });
        unchanged("exists; it is not replaced", &|base| {
            std::fs::create_dir_all(base.join(PRODUCT).join(WORKSPACE)).unwrap();
        });
        unchanged("is not a folder on the same file system", &|base| {
            std::fs::write(base.join(PRODUCT), "a file").unwrap();
        });
        // A managed install named by --install-dir, wherever it is.
        let tmp = tempfile::tempdir().unwrap();
        legacy(tmp.path());
        let install = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(install.path().join("updates")).unwrap();
        std::fs::write(install.path().join("updates/state.json"), r#"{"operation":{"phase":"stopping"}}"#).unwrap();
        let before = tree(tmp.path());
        let refused = move_legacy(tmp.path(), Some(install.path()), &mut never).unwrap_err().to_string();
        assert!(refused.contains("A managed update is under way (stopping"), "{refused}");
        assert_eq!(tree(tmp.path()), before);
        // An update helper that runs, for an install anywhere; ended however
        // the test ends.
        struct Helper(std::process::Child);
        impl Drop for Helper {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        // CI runs 39492395660, 39513045319, 39534080239 and 39534937391 moved
        // a few milliseconds after spawn() returned, and a scan a moment later
        // found the helper. spawn() may return before the child's exec has
        // finished, while it does not yet read as the helper. So the helper is
        // a copy of sh that says when it runs its own code; from then on it
        // is the helper the guard must see. (A real helper starts after its
        // operation is in the journal, which the guard also reads.)
        let path = install.path().join("yuzuno-update-helper");
        std::fs::copy("/bin/sh", &path).unwrap();
        let mut helper = Helper(std::process::Command::new(&path).args(["-c", "echo ready; read line"])
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap());
        let pid = helper.0.id();
        let exe_at_spawn = std::fs::read_link(format!("/proc/{pid}/exe"));
        let stdout = helper.0.stdout.take().unwrap();
        let (said, heard) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = std::io::BufRead::read_line(&mut std::io::BufReader::new(stdout), &mut line);
            let _ = said.send(line);
        });
        let line = heard.recv_timeout(std::time::Duration::from_secs(30))
            .unwrap_or_else(|_| panic!("update helper {pid} did not say within 30 s that it runs (exe at spawn {exe_at_spawn:?})"));
        assert_eq!(line, "ready\n", "update helper {pid}");
        let started = std::time::Instant::now();
        // If it moves anyway, say what /proc showed of the helper when spawn
        // returned and shows now (read before it is reaped), whether it still
        // runs and what the scan sees now.
        let refused = match move_legacy(tmp.path(), None, &mut never) {
            Err(error) => error.to_string(),
            Ok(moved) => panic!("moved ({moved:?}) {:?} after update helper {pid} said it runs: exe at spawn {exe_at_spawn:?}, \
                exe {:?}, stat {:?}, then it {:?}, scan now {:?}",
                started.elapsed(), std::fs::read_link(format!("/proc/{pid}/exe")),
                std::fs::read_to_string(format!("/proc/{pid}/stat")), helper.0.try_wait(), running_update_helper()),
        };
        assert!(refused.contains(&format!("An update helper is running (process {pid})")), "{refused}");
        assert_eq!(tree(tmp.path()), before);
        drop(helper);
        // A Core that holds the Workspace: refused by its lock.
        let tmp = tempfile::tempdir().unwrap();
        legacy(tmp.path());
        let _held = crate::store::lock_workspace(&tmp.path().join(LEGACY).join(DATABASE)).unwrap();
        assert!(move_legacy(tmp.path(), None, &mut never).unwrap_err().to_string().contains("另一个 Core"));
        assert!(!tmp.path().join(PRODUCT).exists());
    }

    /// Whether an update helper runs is known only from a whole list of
    /// processes: one that cannot be read refuses the move, as a helper would.
    #[cfg(target_os = "linux")]
    #[test]
    fn processes_that_cannot_be_listed_are_not_taken_for_no_update_helper() {
        let fake = tempfile::tempdir().unwrap();
        let unreadable = fake.path().join("not-mounted");
        let error = update_helper_in(&unreadable).unwrap_err().to_string();
        assert!(error.contains("Cannot tell whether an update helper is running") && error.contains("Nothing was moved"), "{error}");
        // Read whole: what is not a process, a process gone since it was
        // listed, and others' programs are not it; a helper still is, its
        // file deleted or not.
        let proc = fake.path().join("proc");
        for (name, exe) in [("self", Some("/usr/bin/bash")), ("1", Some("/usr/lib/systemd/systemd")), ("2", None),
            ("40", Some("/usr/bin/sleep"))] {
            std::fs::create_dir_all(proc.join(name)).unwrap();
            if let Some(exe) = exe {
                std::os::unix::fs::symlink(exe, proc.join(name).join("exe")).unwrap();
            }
        }
        assert_eq!(update_helper_in(&proc).unwrap(), None);
        std::fs::create_dir(proc.join("41")).unwrap();
        std::os::unix::fs::symlink("/opt/yuzuno/yuzuno-update-helper (deleted)", proc.join("41/exe")).unwrap();
        assert_eq!(update_helper_in(&proc).unwrap(), Some(41));
    }
}
