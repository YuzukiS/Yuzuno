//! Files the user attaches to a message (YN-145): any type, kept by Core for
//! the Agent they go to and given to it by path. Each Agent has a folder of
//! its own, `input-files/<agent>/<id>/<name>`: the ID is the content's
//! SHA-256, the name the one `safe_name` makes of the user's, so the Agent's
//! tools still see its extension. Files are written once and made read-only
//! (0400) in private folders (0700); Core never opens, unpacks or runs one,
//! and checks each again before it is sent (`check`). Only the user's page
//! uploads and downloads them: an Agent's credential is refused (`router`).
//! The limits are the image channel's (`input_images`): 8 files and 40 MiB a
//! message, 256 MiB and 4096 files an Agent, and at least 1 byte a file.
use crate::{server::ApiError, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, Request, State},
    http::{header, HeaderValue},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{ErrorKind, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, OnceLock},
};
use tokio::sync::{mpsc, Semaphore};
use tower::ServiceExt;

pub const MAX_FILES: usize = 8;
pub const MAX_TOTAL: u64 = 40 * 1024 * 1024;
pub const MAX_FOLDER: u64 = 256 * 1024 * 1024;
pub const MAX_FOLDER_FILES: usize = 4096;
/// A name's most: 200 UTF-16 units, as the web counts an image's name
/// (`validDraftImages`), and 240 bytes, inside the 255 of NAME_MAX on Linux
/// and macOS.
const MAX_NAME_UNITS: usize = 200;
const MAX_NAME_BYTES: usize = 240;
/// The longest ending after a name's last dot that a shortened name keeps.
const MAX_EXTENSION: usize = 16;
const TOO_LARGE: &str = "Files in one message must total at most 40 MiB";
// One upload at a time: the folder's room is counted before it is written.
static SAVING: OnceLock<Arc<Semaphore>> = OnceLock::new();
// One copy to an Agent at a time: bounds the recipient's quota check.
static ADOPTING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A saved file as a message names it: its content's SHA-256, its safe name
/// and its size. On disk it is `<folder>/<id>/<name>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FileRef {
    pub id: String,
    pub name: String,
    pub bytes: u64,
}

/// The harnesses an attached file is given to, by path.
pub fn takes_files(harness: &str) -> bool {
    matches!(harness, "codex" | "claude" | "opencode")
}

/// The name a file is saved under: the user's last path segment, with
/// control characters, `\ / : * ? " < > |` and backticks made `_`, no
/// trailing spaces or dots, `_` before a leading `.` or `-` (no hidden
/// files, no shell options), `file` for an empty one, and shortened to 200
/// UTF-16 units and 240 bytes, keeping its extension. Unicode is kept as
/// given, without normalization. A safe name is its own safe name.
pub fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let replaced: String = last.chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|`".contains(c) { '_' } else { c })
        .collect();
    let mut name = replaced.trim_end_matches([' ', '.']).to_owned();
    if name.is_empty() {
        return "file".into();
    }
    if name.starts_with(['.', '-']) {
        name.insert(0, '_');
    }
    let fitted = fit(&name);
    match fitted.trim_end_matches([' ', '.']) {
        "" => "file".into(),
        kept => kept.into(),
    }
}

/// `name` within the name limits: the part before its extension is cut.
fn fit(name: &str) -> String {
    let units = |s: &str| s.encode_utf16().count();
    if units(name) <= MAX_NAME_UNITS && name.len() <= MAX_NAME_BYTES {
        return name.into();
    }
    let extension = name.rfind('.')
        .filter(|&at| at > 0 && name[at + 1..].chars().count() <= MAX_EXTENSION)
        .map_or("", |at| &name[at..]);
    let (mut units_left, mut bytes_left) = (MAX_NAME_UNITS - units(extension), MAX_NAME_BYTES - extension.len());
    let mut kept = String::new();
    for c in name[..name.len() - extension.len()].chars() {
        if c.len_utf16() > units_left || c.len_utf8() > bytes_left {
            break;
        }
        units_left -= c.len_utf16();
        bytes_left -= c.len_utf8();
        kept.push(c);
    }
    kept + extension
}

fn safe_owner(owner: &str) -> Result<()> {
    ensure!(
        !owner.is_empty() && owner.len() <= 100 && owner.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
        "Invalid file owner"
    );
    Ok(())
}

/// An Agent's own folder of attached files: the one its harness may read.
pub fn agent_dir(root: &FsPath, agent: &str) -> Result<PathBuf> {
    safe_owner(agent)?;
    Ok(root.join("input-files").join(agent))
}

/// A Project's files written on Home, before any is sent:
/// `home-files/<projectId>` (YN-145 F6).
pub fn home_dir(root: &FsPath, project: &str) -> Result<PathBuf> {
    safe_owner(project)?;
    Ok(root.join("home-files").join(project))
}

/// `dir/<id>/<name>`, for an ID that is a SHA-256 and a name that is safe.
fn file_path(dir: &FsPath, id: &str, name: &str) -> Result<PathBuf> {
    ensure!(
        id.len() == 64 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "Invalid file reference"
    );
    ensure!(safe_name(name) == name, "Invalid file name");
    Ok(dir.join(id).join(name))
}

/// `dir`, made private (0700) if it is not there yet; a link is refused.
pub(crate) fn make_private(dir: &FsPath) -> Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
        .with_context(|| format!("Cannot create {}", dir.display()))?;
    ensure!(std::fs::symlink_metadata(dir)?.is_dir(), "{} is not a folder", dir.display());
    Ok(())
}

/// The saved file at `path`, opened without following a link and without
/// waiting on a pipe, in a folder that is not a link: a regular file, and
/// its size.
fn open_plain(path: &FsPath) -> Result<(std::fs::File, u64)> {
    const MISSING: &str = "Saved file is missing; attach it again";
    let folder = std::fs::symlink_metadata(path.parent().context("Invalid file reference")?).context(MISSING)?;
    ensure!(folder.is_dir(), "Invalid saved file");
    let flags = rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK;
    let file = std::fs::OpenOptions::new().read(true).custom_flags(flags.bits() as i32).open(path).context(MISSING)?;
    let meta = file.metadata()?;
    ensure!(meta.is_file(), "Invalid saved file");
    Ok((file, meta.len()))
}

/// The SHA-256 of what `file` holds, read up to one byte past `most`, and
/// the number of bytes read.
fn sha256(file: &mut std::fs::File, most: u64) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let read = std::io::copy(&mut file.take(most + 1), &mut hasher)?;
    Ok((format!("{:x}", hasher.finalize()), read))
}

/// The bytes and number of the files saved in `dir` as `<id>/<name>`; links
/// are counted, not followed, and temporary files are not counted.
fn usage(dir: &FsPath) -> Result<(u64, usize)> {
    let (mut bytes, mut files) = (0, 0);
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        for inner in std::fs::read_dir(entry.path())? {
            bytes += inner?.metadata()?.len();
            files += 1;
        }
    }
    Ok((bytes, files))
}

/// One upload being written: a private temporary file in the folder, hashed
/// as it is written, refused once it passes the message's 40 MiB or the
/// folder's room. Dropped unfinished, its temporary file is removed.
struct Saving {
    dir: PathBuf,
    name: String,
    file: tempfile::NamedTempFile,
    hasher: Sha256,
    written: u64,
    room: u64,
}

impl Saving {
    /// `declared` is the request's Content-Length, refused before any byte.
    fn begin(dir: &FsPath, name: String, declared: Option<u64>) -> Result<Self> {
        ensure!(declared.is_none_or(|bytes| bytes <= MAX_TOTAL), TOO_LARGE);
        make_private(dir)?;
        let (used, files) = usage(dir)?;
        ensure!(files < MAX_FOLDER_FILES, "This Agent's saved files reached the 4096-file limit");
        let room = MAX_FOLDER.saturating_sub(used);
        const FULL: &str = "This Agent's saved files reached the 256 MiB limit";
        ensure!(room > 0 && declared.is_none_or(|bytes| bytes <= room), FULL);
        // Created new (O_EXCL), readable and writable by its owner only (0600).
        let file = tempfile::Builder::new().prefix(".tmp-").tempfile_in(dir)?;
        Ok(Self { dir: dir.to_owned(), name, file, hasher: Sha256::new(), written: 0, room })
    }

    fn write(&mut self, chunk: &[u8]) -> Result<()> {
        self.written += chunk.len() as u64;
        ensure!(self.written <= MAX_TOTAL, TOO_LARGE);
        ensure!(self.written <= self.room, "This Agent's saved files reached the 256 MiB limit");
        self.hasher.update(chunk);
        self.file.write_all(chunk)?;
        Ok(())
    }

    /// Kept as `<id>/<name>`, never over another file: the same name with
    /// the same content is kept once; one changed since is replaced.
    fn finish(self) -> Result<FileRef> {
        ensure!(self.written > 0, "A file must hold at least 1 byte");
        self.file.as_file().sync_all()?;
        let id = format!("{:x}", self.hasher.finalize());
        let folder = self.dir.join(&id);
        make_private(&folder)?;
        let path = file_path(&self.dir, &id, &self.name)?;
        let kept = match self.file.persist_noclobber(&path) {
            Ok(file) => file,
            Err(taken) if taken.error.kind() == ErrorKind::AlreadyExists => {
                let same = open_plain(&path).and_then(|(mut file, len)| {
                    Ok(len == self.written && sha256(&mut file, len)? == (id.clone(), len))
                });
                if same.unwrap_or(false) {
                    return Ok(FileRef { id, name: self.name, bytes: self.written });
                }
                taken.file.persist(&path).map_err(|failed| failed.error)?
            }
            Err(taken) => return Err(taken.error.into()),
        };
        kept.set_permissions(std::fs::Permissions::from_mode(0o400))?;
        Ok(FileRef { id, name: self.name, bytes: self.written })
    }
}

/// Saves `body` in `dir` as `safe_name(name)`, written to disk as it
/// arrives, one upload at a time. A body that stops early keeps nothing.
pub(crate) async fn save_stream(dir: PathBuf, name: &str, declared: Option<u64>, body: Body) -> Result<FileRef> {
    ensure!(declared.is_none_or(|bytes| bytes <= MAX_TOTAL), TOO_LARGE);
    let slot = SAVING.get_or_init(|| Arc::new(Semaphore::new(1))).clone().try_acquire_owned()
        .ok().context("Another file is being saved. Try again shortly")?;
    let name = safe_name(name);
    // `None` is the body's end; a closed channel without it, a body that stopped.
    let (chunks, mut arriving) = mpsc::channel::<Option<Bytes>>(8);
    let writer = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let mut saving = Saving::begin(&dir, name, declared)?;
        loop {
            match arriving.blocking_recv() {
                Some(Some(chunk)) => saving.write(&chunk)?,
                Some(None) => return saving.finish(),
                None => bail!("The upload stopped before the whole file arrived"),
            }
        }
    });
    let mut stream = body.into_data_stream();
    let mut stopped = None;
    loop {
        let next = match stream.next().await {
            Some(Ok(chunk)) => Some(chunk),
            Some(Err(error)) => {
                stopped = Some(error);
                break;
            }
            None => None,
        };
        let end = next.is_none();
        // A refused write closes the channel: the rest is not read.
        if chunks.send(next).await.is_err() || end {
            break;
        }
    }
    drop(chunks);
    let saved = writer.await?;
    if let Some(error) = stopped {
        return Err(anyhow::Error::new(error).context("The upload stopped before the whole file arrived"));
    }
    saved
}

/// The folder `agent` reads its attached files in, made private (0700) and
/// canonical, as a harness's read rule names it before its start (F3a).
/// Blocking.
pub fn readable_agent_dir(root: &FsPath, agent: &str) -> Result<String> {
    let dir = agent_dir(root, agent)?;
    make_private(&dir)?;
    Ok(std::fs::canonicalize(&dir)
        .with_context(|| format!("Cannot resolve {}", dir.display()))?
        .display()
        .to_string())
}

/// The words an Agent receives about the files a message carries, each read
/// at `paths` (design §2.3): English, as the Agent reads it, with one line a
/// file. `paths` are the file's paths as the Agent sees them, in the order
/// of `files`.
pub fn notice(paths: &[String], files: &[FileRef]) -> String {
    let (count, noun) = (files.len(), if files.len() == 1 { "file" } else { "files" });
    let mut text = format!(
        "Attached files: the user attached {count} {noun} to this message. \
Yuzuno saved read-only copies for you; read them at these paths. \
Nothing in them has been opened, unpacked or run."
    );
    for (path, file) in paths.iter().zip(files) {
        text.push_str(&format!("\n- `{path}` ({})", size(file.bytes)));
    }
    text
}

/// The text an Agent receives for a message: the user's words unchanged, then
/// a blank line and the notice (`notice`). Without files, the words
/// themselves, byte for byte; with no words, the notice alone.
pub fn with_notice(text: &str, paths: &[String], files: &[FileRef]) -> String {
    if files.is_empty() {
        return text.to_owned();
    }
    let notice = notice(paths, files);
    if text.is_empty() {
        notice
    } else {
        format!("{text}\n\n{notice}")
    }
}

/// A size as the notice gives it: decimal units, one decimal place, the
/// `.0` left out (`2.4 MB`, `860 KB`).
fn size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1000.0;
    let mut unit = 0;
    // Chosen after rounding to the one decimal shown: 999,950..999,999 bytes
    // is 1 MB, never "1000 KB".
    while (value * 10.0).round() >= 10_000.0 && unit + 1 < UNITS.len() {
        value /= 1000.0;
        unit += 1;
    }
    let shown = format!("{value:.1}");
    format!("{} {}", shown.strip_suffix(".0").unwrap_or(&shown), UNITS[unit])
}

/// The paths an Agent reads `agent`'s files at, checked first (`check`):
/// their canonical paths on this machine. Blocking.
pub fn send_paths(root: &FsPath, agent: &str, refs: &[FileRef]) -> Result<Vec<String>> {
    let dir = agent_dir(root, agent)?;
    check(&dir, refs)?
        .iter()
        .map(|path| {
            std::fs::canonicalize(path)
                .map(|real| real.display().to_string())
                .with_context(|| format!("Saved file {} is missing; attach it again", path.display()))
        })
        .collect()
}

/// A message's files, checked before it is sent: in this folder, still as
/// they were saved (size and SHA-256), and within the count and the total.
/// Their paths, in order. Blocking.
pub fn check(dir: &FsPath, refs: &[FileRef]) -> Result<Vec<PathBuf>> {
    if refs.is_empty() {
        return Ok(vec![]);
    }
    ensure!(refs.len() <= MAX_FILES, "Attach at most 8 files per message");
    let total = refs.iter().try_fold(0u64, |total, file| total.checked_add(file.bytes));
    ensure!(total.is_some_and(|total| total <= MAX_TOTAL), TOO_LARGE);
    ensure!(std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir()), "Saved files are missing; attach them again");
    let mut unique = HashSet::new();
    refs.iter().map(|file| -> Result<PathBuf> {
        ensure!(unique.insert((&file.id, &file.name)), "Duplicate file reference");
        let path = file_path(dir, &file.id, &file.name)?;
        let (mut opened, len) = open_plain(&path)?;
        let changed = || format!("Saved file {} changed; attach it again", file.name);
        ensure!(len == file.bytes, changed());
        ensure!(sha256(&mut opened, len)? == (file.id.clone(), len), changed());
        Ok(path)
    }).collect()
}

/// The bytes of a message's files, in order: each checked as `check` does and
/// hashed again as it is read, for a copy to a remote Agent (remote_files).
/// Blocking.
pub(crate) fn message_bytes(dir: &FsPath, refs: &[FileRef]) -> Result<Vec<Vec<u8>>> {
    check(dir, refs)?.into_iter().zip(refs).map(|(path, file)| {
        let changed = || format!("Saved file {} changed; attach it again", file.name);
        let (opened, len) = open_plain(&path)?;
        ensure!(len == file.bytes && len <= MAX_TOTAL, changed());
        let mut bytes = Vec::with_capacity(len as usize);
        opened.take(len + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() as u64 == len, changed());
        ensure!(format!("{:x}", Sha256::digest(&bytes)) == file.id, changed());
        Ok(bytes)
    }).collect()
}

/// Checks the files a message from Home names (YN-145 F6), before anything is
/// kept or sent: each in the Project's folder, unchanged since upload, within
/// the count and the total. Blocking.
pub fn check_home(root: &FsPath, project: &str, refs: &[FileRef]) -> Result<()> {
    check(&home_dir(root, project)?, refs).map(drop)
}

/// Copies the files a message from Home names (YN-145 F6) from the Project's
/// folder to `agent`'s own, once its recipient is known: a copy, never a hard
/// link, so an Agent that changes its own cannot change the staging copy or
/// another recipient's. One the Agent already has is left as it is; the
/// Agent's own room must fit the rest. Called again, it copies nothing twice,
/// so a retry is the same. Blocking.
pub fn adopt(root: &FsPath, project: &str, agent: &str, refs: &[FileRef]) -> Result<()> {
    if refs.is_empty() {
        return Ok(());
    }
    let from = home_dir(root, project)?;
    let to = agent_dir(root, agent)?;
    check(&from, refs)?;
    let _one = ADOPTING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for file in refs {
        let source = file_path(&from, &file.id, &file.name)?;
        let target = file_path(&to, &file.id, &file.name)?;
        if target.exists() {
            continue;
        }
        let (mut reader, len) = open_plain(&source)?;
        ensure!(len == file.bytes, "Saved file {} changed; attach it again", file.name);
        make_private(&to)?;
        let (used, files) = usage(&to)?;
        ensure!(files < MAX_FOLDER_FILES, "The receiving Agent's saved files reached the 4096-file limit");
        ensure!(used.saturating_add(file.bytes) <= MAX_FOLDER, "The receiving Agent's saved files reached the 256 MiB limit");
        make_private(target.parent().context("Invalid file reference")?)?;
        // Created new (O_EXCL), readable and writable by its owner only, and
        // made read-only once it is the file that was checked.
        let mut writer = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&target)?;
        let copied = std::io::copy(&mut reader, &mut writer)?;
        writer.sync_all()?;
        drop(writer);
        let (mut checkable, size) = open_plain(&target)?;
        if copied != file.bytes || sha256(&mut checkable, size)? != (file.id.clone(), size) {
            let _ = std::fs::remove_file(&target);
            bail!("Saved file {} changed; attach it again", file.name);
        }
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o400))?;
    }
    Ok(())
}

/// Removes a deleted Agent's attached files: its own folder only, and not a
/// link put in its place. Blocking.
pub(crate) fn remove_agent_dir(root: &FsPath, agent: &str) -> Result<()> {
    let dir = agent_dir(root, agent)?;
    match std::fs::symlink_metadata(&dir) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(meta) if meta.is_dir() => Ok(std::fs::remove_dir_all(&dir)?),
        Ok(_) => bail!("{} is not a folder; it is left as it is", dir.display()),
    }
}

/// The user's routes, on Core's own port and on the phone entry: upload an
/// Agent's file and download one. An Agent's credential (any Authorization
/// header) is refused: no Agent attaches a file for the user.
///
/// A Project's routes are registered with the user's Home routes
/// (`project_requests::router`), under the same refusal.
pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/agents/{id}/files", post(upload_route))
        .route("/api/agents/{id}/files/{file_id}/{name}", get(read_route))
        .layer(middleware::from_fn(crate::routing_keys::routes::no_agent_credential))
}

#[derive(Deserialize)]
pub struct Upload {
    pub name: String,
}

/// `POST /api/agents/{id}/files?name=`: the body is the file's bytes. The
/// Agent is open and its harness takes files.
async fn upload_route(
    State(ws): State<Arc<Workspace>>,
    Path(agent): Path<String>,
    Query(upload): Query<Upload>,
    request: Request,
) -> Result<Json<FileRef>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let dir = agent_dir(&ws.data_dir, &agent)?;
    let info = ws.stored(move |store| store.agent(&agent)).await?;
    crate::model::ensure_agent_open(&info)?;
    if !takes_files(&info.harness) {
        return Err(anyhow::anyhow!("{} can't receive files; Codex, Claude and OpenCode Agents can", info.name).into());
    }
    let declared = request.headers().get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()?.parse().ok());
    Ok(Json(save_stream(dir, &upload.name, declared, request.into_body()).await?))
}

/// `POST /api/projects/{id}/files?name=`, for the files written on Home
/// (YN-145 F6): the body is the file's bytes, kept in the Project's staging
/// folder. Only for a Project that is not archived, as its images.
pub async fn home_upload_route(
    State(ws): State<Arc<Workspace>>,
    Path(project): Path<String>,
    Query(upload): Query<Upload>,
    request: Request,
) -> Result<Json<FileRef>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let dir = home_dir(&ws.data_dir, &project)?;
    let id = project.clone();
    ws.stored(move |store| {
        let (name, archived) = crate::projects::project_labels(&*store.db.read()?)?
            .remove(&id)
            .context("project_not_found: Project does not exist")?;
        ensure!(!archived, "project_archived: {name} is archived; unarchive it to attach files");
        Ok(())
    })
    .await?;
    let declared = request.headers().get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()?.parse().ok());
    Ok(Json(save_stream(dir, &upload.name, declared, request.into_body()).await?))
}

/// `GET /api/projects/{id}/files/{file_id}/{name}` (YN-145 F6): a file in
/// the Project's staging folder, served as an Agent's. An archived Project's
/// are still read, as its requests are.
pub async fn home_read_route(
    State(ws): State<Arc<Workspace>>,
    Path((project, id, name)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, ApiError> {
    let path = file_path(&home_dir(&ws.data_dir, &project)?, &id, &name)?;
    ws.stored(move |store| crate::projects::ensure_exists(&*store.db.read()?, &project)).await?;
    let checked = path.clone();
    tokio::task::spawn_blocking(move || open_plain(&checked).map(drop)).await??;
    let mut response = tower_http::services::ServeFile::new(path).oneshot(request).await?.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    headers.insert(header::CONTENT_DISPOSITION, attachment(&name));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

/// `GET /api/agents/{id}/files/{file_id}/{name}`, for a live or closed
/// Agent: always a download, never shown under Core's origin.
async fn read_route(
    State(ws): State<Arc<Workspace>>,
    Path((agent, id, name)): Path<(String, String, String)>,
    request: Request,
) -> Result<Response, ApiError> {
    let path = file_path(&agent_dir(&ws.data_dir, &agent)?, &id, &name)?;
    ws.stored(move |store| store.agent(&agent)).await?;
    let checked = path.clone();
    tokio::task::spawn_blocking(move || open_plain(&checked).map(drop)).await??;
    let mut response = tower_http::services::ServeFile::new(path).oneshot(request).await?.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    headers.insert(header::CONTENT_DISPOSITION, attachment(&name));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

/// `attachment; filename*=UTF-8''<name>`, the name percent-encoded as
/// RFC 8187 asks: every byte that is not an attr-char.
fn attachment(name: &str) -> HeaderValue {
    let mut value = String::from("attachment; filename*=UTF-8''");
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            value.push(char::from(byte));
        } else {
            value.push_str(&format!("%{byte:02X}"));
        }
    }
    HeaderValue::from_str(&value).expect("an ASCII header value")
}

#[cfg(test)]
mod tests;
