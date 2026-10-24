//! Workspace backup and restore (T-192), first slice.
//!
//! A backup is a folder a person can read. `manifest.json` says what is in it
//! (each file with its size and SHA-256), what was left out and why, and what
//! a Workspace backup never covers. `workspace.sqlite` is a consistent copy
//! of the database with the Workspace's own credentials removed, and `files/`
//! holds the folders Core keeps beside the database. The database copy an
//! update makes (updates/helper.rs) is one file for recovering from that
//! update, not this.
//!
//! This slice backs up a Workspace no Core is using: it takes the Workspace's
//! own lock, and no Job may be unfinished, since Jobs outlive Core and write
//! in jobs/. It restores into a new or empty folder only, never over a
//! Workspace. Nothing is reported as done before every byte was read back and
//! checked: a backup is written beside its destination and renamed into place
//! once verified, a restore likewise beside its target, and on any error that
//! folder is removed and nothing else has changed.
use crate::updates::{
    package::STORAGE,
    storage::{verify_records, Storage, RECORD_LAYOUT},
};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

#[cfg(test)]
mod tests;

pub const FORMAT: &str = "yuzuno-workspace-backup";
pub const VERSION: u32 = 1;
const DATABASE: &str = "workspace.sqlite";
const MANIFEST: &str = "manifest.json";
const FILES: &str = "files";
/// Room kept free beyond what is written, as the update backup keeps.
const MARGIN: u64 = 64 * 1024 * 1024;
/// The Workspace's own credentials: a bearer token per Agent for its Yuzuno
/// MCP connection (collaboration_mcp.rs), which Core makes again on demand.
const CREDENTIALS: &str = "collaboration.mcp.agent.*";

/// Folders Core keeps its own files in, copied whole.
const INCLUDED: &[&str] = &["input-images", "brief-attachments", "pr-reviews", "jobs"];
/// Names in the Workspace folder left out, with the reason the manifest gives.
const EXCLUDED: &[(&str, &str)] = &[
    ("workspace.lock", "The lock of the Core using the Workspace"),
    ("workspace.sqlite-wal", "Folded into the database copy"),
    ("workspace.sqlite-shm", "SQLite's index of the write-ahead log, which it rebuilds"),
    ("workspace.sqlite-journal", "SQLite's rollback journal"),
    ("claude-runtime", "A cache of the Claude runtime, which Core rebuilds"),
    ("desktop-updates", "Downloaded desktop release packages"),
    ("opencode", "OpenCode's own session databases: native session data, like Codex and Claude histories"),
];
const OTHER: &str = "Not made by this Core version; not copied";
const SPECIAL: &str = "A link or special file; a backup holds regular files only";
const NOT_FOLDER: &str = "Not a folder, as this Core keeps it; not copied";
const NOT_UTF8: &str = "Its name is not UTF-8; not copied";
/// What a Workspace backup never holds: it is kept outside the Workspace.
const NOT_COVERED: &[&str] = &[
    "Native CLI accounts, keys and configuration (Codex, Claude Code, OpenCode)",
    "Native session histories kept by Codex, Claude Code and OpenCode outside the Workspace",
    "Agents' working directories and repositories",
    "SSH keys and configuration",
    "The managed Core install: its releases and the database copies updates make",
    "Each device's browser preferences and drafts",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    /// The Core release that wrote it (guide::release).
    pub created_by: Value,
    pub workspace_id: String,
    pub database: Database,
    pub files: Vec<FileEntry>,
    pub excluded: Vec<Excluded>,
    pub not_covered: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Database {
    pub bytes: u64,
    pub sha256: String,
    pub schema: u32,
    pub record_layouts: Vec<u32>,
    /// Agents whose whole history, Items and payloads were read back.
    pub agents: usize,
    /// Rows in each table.
    pub tables: BTreeMap<String, i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEntry {
    /// Relative to the Workspace folder, `/`-separated.
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Excluded {
    pub path: String,
    pub reason: String,
}

/// What a restore did, and what the restored Workspace does not have.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub restored_to: PathBuf,
    pub workspace_id: String,
    pub agents: usize,
    pub files: usize,
    pub bytes: u64,
    pub excluded: Vec<Excluded>,
    pub not_covered: Vec<String>,
    pub notes: Vec<String>,
}

/// Whose database is read: the Workspace being backed up, or a backup.
/// They differ only in what a user can do about a schema this Core does not
/// read.
#[derive(Clone, Copy)]
enum Role {
    Workspace,
    Backup,
}

/// What a database copy holds, read from the copy itself.
#[derive(Debug, PartialEq)]
struct Facts {
    schema: u32,
    record_layouts: Vec<u32>,
    agents: usize,
    tables: BTreeMap<String, i64>,
    workspace_id: String,
    credentials: i64,
}

/// Backs up the Workspace in `data`, which no Core may be using, into the
/// new folder `out`.
pub fn backup(data: &Path, out: &Path) -> Result<Manifest> {
    ensure!(fs::symlink_metadata(data.join(DATABASE)).is_ok_and(|meta| meta.is_file()),
        "{} holds no Workspace database; nothing was written", data.display());
    let data = fs::canonicalize(data).with_context(|| format!("Cannot read {}", data.display()))?;
    let (parent, out) = new_folder(out)?;
    ensure!(!out.starts_with(&data), "A backup cannot be put inside the Workspace it backs up ({}); nothing was written",
        data.display());
    let _lock = crate::store::lock_workspace(&data.join(DATABASE))
        .context("Stop the Core using this Workspace before backing it up; nothing was written")?;
    let source = crate::data_dir::read_only(&data.join(DATABASE))?;
    let unfinished = crate::data_dir::unfinished_jobs(&source)?;
    ensure!(unfinished == 0, "{unfinished} Job(s) have not ended; back up the Workspace once they have. Nothing was written");
    let (planned, mut excluded) = plan(&data)?;
    let mut wal = data.join(DATABASE).into_os_string();
    wal.push("-wal");
    // The copy, and VACUUM's temporary copy of it.
    let database = fs::metadata(data.join(DATABASE))?.len().saturating_add(fs::metadata(wal).map_or(0, |meta| meta.len()));
    let required = planned.iter().map(|(_, bytes)| *bytes).sum::<u64>()
        .saturating_add(database.saturating_mul(2)).saturating_add(MARGIN);
    room(&parent, required).context("Nothing was written")?;
    let partial = parent.join(format!(".{}.partial-{}", name(&out)?, uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<Manifest> {
        private_dirs(&partial)?;
        let (database, removed, workspace_id) = copy_database(&source, &partial.join(DATABASE))?;
        excluded.insert(0, Excluded {
            path: format!("{DATABASE}: workspace_meta {CREDENTIALS}"),
            reason: format!("The Workspace's own MCP credentials ({removed} removed from the copy); Core makes new ones when an Agent connects"),
        });
        let mut files = Vec::new();
        for (path, bytes) in &planned {
            let (copied, sha256) = copy_file(&data.join(path), &partial.join(FILES).join(path))?;
            ensure!(copied == *bytes, "{path} changed while it was being copied");
            files.push(FileEntry { path: path.clone(), bytes: copied, sha256 });
        }
        let manifest = Manifest {
            format: FORMAT.into(),
            version: VERSION,
            created_at: chrono::Utc::now().to_rfc3339(),
            created_by: crate::guide::release(),
            workspace_id,
            database,
            files,
            excluded,
            not_covered: NOT_COVERED.iter().map(|s| s.to_string()).collect(),
        };
        let mut file = new_file(&partial.join(MANIFEST))?;
        file.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        file.sync_all()?;
        // Read back whole, as anyone checking it later would.
        let checked = verify(&partial)?;
        sync_dir(&partial)?;
        fs::rename(&partial, &out).with_context(|| format!("Cannot put the backup at {}", out.display()))?;
        sync_dir(&parent)?;
        Ok(checked)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    result.context("The backup was not made; nothing was left behind")
}

/// Checks a backup folder: exactly the files its manifest lists, each with
/// its size and SHA-256, and a database this Core can read whole.
pub fn verify(dir: &Path) -> Result<Manifest> {
    let meta = fs::symlink_metadata(dir).with_context(|| format!("Cannot read the backup {}", dir.display()))?;
    ensure!(meta.is_dir(), "{} is not a backup folder", dir.display());
    let manifest = read_manifest(dir)?;
    let mut expected: BTreeMap<String, (u64, &str)> = BTreeMap::new();
    expected.insert(DATABASE.into(), (manifest.database.bytes, manifest.database.sha256.as_str()));
    let mut seen = BTreeSet::new();
    for file in &manifest.files {
        check_path(&file.path)?;
        ensure!(seen.insert(file.path.as_str()), "The manifest lists {} twice", file.path);
        expected.insert(format!("{FILES}/{}", file.path), (file.bytes, file.sha256.as_str()));
    }
    for (_, sha256) in expected.values() {
        ensure!(sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "The manifest has an invalid SHA-256: {sha256}");
    }
    let mut found = BTreeSet::new();
    every_file(dir, "", &mut found)?;
    for path in &found {
        ensure!(path == MANIFEST || expected.contains_key(path), "The backup holds {path}, which its manifest does not list");
    }
    for (path, (bytes, sha256)) in &expected {
        ensure!(found.contains(path), "{path} is missing from the backup");
        let (actual, digest) = hash_file(&dir.join(path))?;
        ensure!(actual == *bytes && digest == *sha256, "{path} differs from its manifest entry: {actual} bytes, SHA-256 {digest}");
    }
    let facts = read_only_facts(&dir.join(DATABASE), Role::Backup)?;
    agrees(&facts, &manifest)?;
    Ok(manifest)
}

/// Restores a backup into `target`, a new or empty folder, and checks the
/// Workspace there before it is put in place.
pub fn restore(backup: &Path, target: &Path) -> Result<Restored> {
    let manifest = verify(backup)?;
    let backup = fs::canonicalize(backup)?;
    let (parent, target, existing) = restore_target(target)?;
    ensure!(!target.starts_with(&backup) && !backup.starts_with(&target),
        "The backup and the restored Workspace cannot be inside each other; nothing was changed");
    let bytes = manifest.files.iter().map(|file| file.bytes).sum::<u64>().saturating_add(manifest.database.bytes);
    room(&parent, bytes.saturating_add(MARGIN)).context("Nothing was changed")?;
    let staging = parent.join(format!(".{}.restoring-{}", name(&target)?, uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<Restored> {
        private_dirs(&staging)?;
        let mut copies = vec![(PathBuf::from(DATABASE), manifest.database.bytes, manifest.database.sha256.clone())];
        copies.extend(manifest.files.iter().map(|file| (PathBuf::from(FILES).join(&file.path), file.bytes, file.sha256.clone())));
        for (path, bytes, sha256) in &copies {
            let to = staging.join(path.strip_prefix(FILES).unwrap_or(path.as_path()));
            let (copied, digest) = copy_file(&backup.join(path), &to)?;
            ensure!(copied == *bytes && digest == *sha256, "{} changed while it was being restored", path.display());
            // What was written, read back.
            let (written, digest) = hash_file(&to)?;
            ensure!(written == *bytes && digest == *sha256, "{} was not written intact", path.display());
        }
        let facts = read_only_facts(&staging.join(DATABASE), Role::Backup)?;
        agrees(&facts, &manifest)?;
        sync_dir(&staging)?;
        if existing {
            fs::remove_dir(&target).with_context(|| format!("{} is no longer empty", target.display()))?;
        }
        if let Err(error) = fs::rename(&staging, &target) {
            if existing {
                let _ = fs::create_dir(&target);
            }
            return Err(error).with_context(|| format!("Cannot put the Workspace at {}", target.display()));
        }
        sync_dir(&parent)?;
        Ok(Restored {
            restored_to: target.clone(),
            workspace_id: manifest.workspace_id.clone(),
            agents: facts.agents,
            files: manifest.files.len(),
            bytes,
            excluded: manifest.excluded.clone(),
            not_covered: manifest.not_covered.clone(),
            notes: vec![
                format!("The restored Workspace keeps the identity {} of the one backed up; do not run a Core on both at once.",
                    manifest.workspace_id),
                "The Workspace's own MCP credentials were not in the backup; Core makes new ones when an Agent connects.".into(),
                "Paths inside records and native histories still name the folder that was backed up; they are not rewritten.".into(),
                "Native sessions, CLI accounts and working directories were not in the backup (notCovered).".into(),
            ],
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.context("Nothing was restored; nothing else was changed")
}

/// The files to copy (path, bytes), and the names left out.
fn plan(data: &Path) -> Result<(Vec<(String, u64)>, Vec<Excluded>)> {
    let (mut files, mut excluded) = (Vec::new(), Vec::new());
    for name in names(data, "", &mut excluded)? {
        if name == DATABASE {
            continue;
        }
        if INCLUDED.contains(&name.as_str()) {
            if fs::symlink_metadata(data.join(&name))?.is_dir() {
                walk(data, &name, &mut files, &mut excluded)?;
            } else {
                excluded.push(Excluded { path: name, reason: NOT_FOLDER.into() });
            }
        } else if let Some((_, reason)) = EXCLUDED.iter().find(|(known, _)| *known == name) {
            excluded.push(Excluded { path: name, reason: (*reason).into() });
        } else {
            excluded.push(Excluded { path: name, reason: OTHER.into() });
        }
    }
    Ok((files, excluded))
}

/// The UTF-8 names in `root/rel`, sorted; others are recorded as left out.
fn names(root: &Path, rel: &str, excluded: &mut Vec<Excluded>) -> Result<Vec<String>> {
    let dir = root.join(rel);
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).with_context(|| format!("Cannot read {}", dir.display()))? {
        let name = entry.with_context(|| format!("Cannot read {}", dir.display()))?.file_name();
        match name.to_str() {
            Some(name) => names.push(name.to_owned()),
            None => excluded.push(Excluded { path: joined(rel, &name.to_string_lossy()), reason: NOT_UTF8.into() }),
        }
    }
    names.sort();
    Ok(names)
}

fn joined(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.into() } else { format!("{rel}/{name}") }
}

fn walk(root: &Path, rel: &str, files: &mut Vec<(String, u64)>, excluded: &mut Vec<Excluded>) -> Result<()> {
    for name in names(root, rel, excluded)? {
        let path = joined(rel, &name);
        let meta = fs::symlink_metadata(root.join(&path)).with_context(|| format!("Cannot read {path}"))?;
        if meta.is_file() {
            files.push((path, meta.len()));
        } else if meta.is_dir() {
            walk(root, &path, files, excluded)?;
        } else {
            excluded.push(Excluded { path, reason: SPECIAL.into() });
        }
    }
    Ok(())
}

/// Every regular file in a backup folder; anything else is refused.
fn every_file(root: &Path, rel: &str, found: &mut BTreeSet<String>) -> Result<()> {
    let mut odd = Vec::new();
    for name in names(root, rel, &mut odd)? {
        let path = joined(rel, &name);
        let meta = fs::symlink_metadata(root.join(&path)).with_context(|| format!("Cannot read {path}"))?;
        if meta.is_file() {
            found.insert(path);
        } else if meta.is_dir() {
            every_file(root, &path, found)?;
        } else {
            bail!("The backup holds {path}, which is not a regular file");
        }
    }
    if let Some(entry) = odd.first() {
        bail!("The backup holds {}, whose name is not UTF-8", entry.path);
    }
    Ok(())
}

/// A manifest path: relative, plain components, in one of the copied folders.
fn check_path(path: &str) -> Result<()> {
    let plain = !path.is_empty()
        && !path.contains(['\\', '\0'])
        && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)))
        && path.split('/').all(|part| !part.is_empty());
    let first = path.split('/').next().unwrap_or("");
    ensure!(plain && path.contains('/') && INCLUDED.contains(&first), "The manifest names a path a backup cannot hold: {path:?}");
    Ok(())
}

fn read_manifest(dir: &Path) -> Result<Manifest> {
    let path = dir.join(MANIFEST);
    let meta = fs::symlink_metadata(&path).with_context(|| format!("{} has no {MANIFEST}; it is not a Workspace backup", dir.display()))?;
    ensure!(meta.is_file() && meta.len() <= 64 * 1024 * 1024, "{MANIFEST} is not a regular file of at most 64 MiB");
    let value: Value = serde_json::from_slice(&fs::read(&path)?).context("The backup manifest is not JSON")?;
    ensure!(value["format"] == FORMAT, "{} is not a Workspace backup (format {})", dir.display(), value["format"]);
    ensure!(value["version"] == VERSION,
        "This backup has format version {}; this Core reads version {VERSION}. Use the Core that made it", value["version"]);
    serde_json::from_value(value).context("The backup manifest is not one this Core can read")
}

/// The facts of a database copy no Core is using, read without writing.
fn read_only_facts(database: &Path, role: Role) -> Result<Facts> {
    let db = crate::data_dir::read_only(database)?;
    facts(&db, role)
}

fn facts(db: &Connection, role: Role) -> Result<Facts> {
    let checks = db.prepare("PRAGMA integrity_check")?.query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ensure!(checks == ["ok"], "The database fails its integrity check: {}", checks.join("; "));
    let storage = Storage::read(db)?;
    match (storage.schema.cmp(&STORAGE), role) {
        (std::cmp::Ordering::Equal, _) => {}
        (std::cmp::Ordering::Greater, _) => bail!(
            "The database has schema {}, newer than this Core reads ({STORAGE}); use a Core release that reads it", storage.schema),
        // Opening it upgrades the database (Store::open).
        (std::cmp::Ordering::Less, Role::Workspace) => bail!(
            "The Workspace has schema {}, older than this Core reads ({STORAGE}). Start this Core on it once, which upgrades it, then back it up",
            storage.schema),
        (std::cmp::Ordering::Less, Role::Backup) => bail!(
            "The backup has schema {}, older than this Core reads ({STORAGE}); restore it with the Core release that made it (createdBy in its manifest)",
            storage.schema),
    }
    ensure!(storage.record_layouts.iter().all(|layout| *layout <= RECORD_LAYOUT),
        "The database has record layouts {:?}; this Core reads up to {RECORD_LAYOUT}. Use the Core that wrote it",
        storage.record_layouts);
    let agents = verify_records(db)?;
    let names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tables = BTreeMap::new();
    for name in names {
        let rows = db.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "\"\"")), [], |row| row.get(0))?;
        tables.insert(name, rows);
    }
    let workspace_id = db.query_row("SELECT value FROM workspace_meta WHERE key='workspaceId'", [], |row| row.get(0))
        .context("The database has no Workspace identity")?;
    let credentials = db.query_row("SELECT COUNT(*) FROM workspace_meta WHERE key GLOB ?1", [CREDENTIALS], |row| row.get(0))?;
    Ok(Facts { schema: storage.schema, record_layouts: storage.record_layouts, agents, tables, workspace_id, credentials })
}

/// A database copy is the one the manifest describes.
fn agrees(facts: &Facts, manifest: &Manifest) -> Result<()> {
    let database = &manifest.database;
    ensure!(facts.workspace_id == manifest.workspace_id, "The database belongs to Workspace {}, not {}",
        facts.workspace_id, manifest.workspace_id);
    ensure!(facts.schema == database.schema && facts.record_layouts == database.record_layouts,
        "The database's schema or record layouts differ from its manifest");
    ensure!(facts.agents == database.agents, "The database holds {} Agents; its manifest says {}", facts.agents, database.agents);
    ensure!(facts.tables == database.tables, "The database's tables or row counts differ from its manifest");
    ensure!(facts.credentials == 0, "The database still holds Workspace MCP credentials");
    Ok(())
}

/// Copies the Workspace database whole, in one pass under one read
/// transaction, then removes the credentials from the copy and leaves no
/// trace of them in its free pages.
fn copy_database(source: &Connection, path: &Path) -> Result<(Database, usize, String)> {
    drop(new_file(path)?);
    let mut target = Connection::open(path)?;
    {
        let backup = rusqlite::backup::Backup::new(source, &mut target)?;
        let step = backup.step(-1)?;
        ensure!(matches!(step, rusqlite::backup::StepResult::Done), "The database could not be copied in one pass");
    }
    // One file, no write-ahead log beside it; Core turns WAL on when it opens it.
    target.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;")?;
    let removed = target.execute("DELETE FROM workspace_meta WHERE key GLOB ?1", [CREDENTIALS])?;
    target.execute_batch("VACUUM")?;
    let facts = facts(&target, Role::Workspace)?;
    target.close().map_err(|(_, error)| error)?;
    File::open(path)?.sync_all()?;
    let (bytes, sha256) = hash_file(path)?;
    Ok((Database { bytes, sha256, schema: facts.schema, record_layouts: facts.record_layouts, agents: facts.agents,
        tables: facts.tables }, removed, facts.workspace_id))
}

/// Copies one regular file, never through a link, into a new file.
fn copy_file(from: &Path, to: &Path) -> Result<(u64, String)> {
    let mut input = open_regular(from)?;
    if let Some(parent) = to.parent() {
        private_dirs(parent)?;
    }
    let mut output = new_file(to)?;
    let (mut hasher, mut buffer, mut total) = (Sha256::new(), vec![0; 1 << 16], 0u64);
    loop {
        let read = input.read(&mut buffer).with_context(|| format!("Cannot read {}", from.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read]).with_context(|| format!("Cannot write {}", to.display()))?;
        total += read as u64;
    }
    output.sync_all().with_context(|| format!("Cannot write {}", to.display()))?;
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn hash_file(path: &Path) -> Result<(u64, String)> {
    let mut input = open_regular(path)?;
    let (mut hasher, mut buffer, mut total) = (Sha256::new(), vec![0; 1 << 16], 0u64);
    loop {
        let read = input.read(&mut buffer).with_context(|| format!("Cannot read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn open_regular(path: &Path) -> Result<File> {
    let meta = fs::symlink_metadata(path).with_context(|| format!("Cannot read {}", path.display()))?;
    ensure!(meta.is_file(), "{} is not a regular file", path.display());
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    }
    options.open(path).with_context(|| format!("Cannot read {}", path.display()))
}

/// A new file only its owner can read.
fn new_file(path: &Path) -> Result<File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).with_context(|| format!("Cannot create {}", path.display()))
}

fn private_dirs(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).with_context(|| format!("Cannot create {}", path.display()))
}

fn sync_dir(path: &Path) -> Result<()> {
    File::open(path).and_then(|dir| dir.sync_all()).with_context(|| format!("Cannot sync {}", path.display()))
}

fn name(path: &Path) -> Result<String> {
    Ok(path.file_name().and_then(|name| name.to_str()).context("The folder needs a UTF-8 name")?.to_owned())
}

/// A folder that does not exist yet, under a parent that does: the canonical
/// parent and the full path.
fn new_folder(path: &Path) -> Result<(PathBuf, PathBuf)> {
    let (parent, full) = beside(path)?;
    match fs::symlink_metadata(&full) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((parent, full)),
        Ok(_) => bail!("{} exists; a backup is written to a new folder only. Nothing was written", full.display()),
        Err(error) => Err(error).with_context(|| format!("Cannot read {}", full.display())),
    }
}

/// Where a restore may go: a new folder, or an empty one (the flag).
fn restore_target(path: &Path) -> Result<(PathBuf, PathBuf, bool)> {
    let (parent, full) = beside(path)?;
    match fs::symlink_metadata(&full) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((parent, full, false)),
        Ok(meta) if meta.is_dir() => {
            ensure!(!full.join(DATABASE).exists(),
                "{} holds a Workspace; a backup is restored only into a new or empty folder, never over a Workspace. Nothing was changed",
                full.display());
            ensure!(fs::read_dir(&full)?.next().is_none(),
                "{} is not empty; a backup is restored only into a new or empty folder. Nothing was changed", full.display());
            Ok((parent, full, true))
        }
        Ok(_) => bail!("{} exists and is not a folder; nothing was changed", full.display()),
        Err(error) => Err(error).with_context(|| format!("Cannot read {}", full.display())),
    }
}

fn beside(path: &Path) -> Result<(PathBuf, PathBuf)> {
    let name = match path.components().next_back() {
        Some(Component::Normal(name)) => name.to_owned(),
        _ => bail!("{} does not name a folder", path.display()),
    };
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let parent = fs::canonicalize(parent).with_context(|| format!("{} does not exist", parent.display()))?;
    let full = parent.join(name);
    Ok((parent, full))
}

#[cfg(test)]
thread_local! {
    /// Free space a test reports instead of the file system's.
    static AVAILABLE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

fn room(path: &Path, required: u64) -> Result<()> {
    #[cfg(test)]
    if let Some(available) = AVAILABLE.with(|cell| cell.get()) {
        ensure!(available >= required, "Not enough space: need {required} bytes, available {available} bytes");
        return Ok(());
    }
    crate::updates::package::ensure_space(path, required)
}
