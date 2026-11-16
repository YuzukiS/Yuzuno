//! Dragging a kept file out of the desktop window as a real file (YN-170).
//!
//! A page can only drag out what a browser can: an address, text, or on
//! Chromium a `DownloadURL`, which Windows hands on as a file to be
//! downloaded at the drop. A folder takes that; an app that takes only real
//! paths (the ChatGPT app's input box, among others) does not, and the Mac
//! app's WebKit has no such drag at all. So the page asks this command
//! instead, once the pointer has moved with its button held: the app fetches
//! the file from the selected Core into a folder of its own, then starts
//! the system's drag with that path, as Explorer or Finder drags a file.
//!
//! - **Who may ask.** Only the selected Core's workspace page in the main
//!   window (`connection::permits_workspace`, the badge's rule), through a
//!   permission granted to that origin only.
//! - **What it fetches.** The page names a file (its kind, ids and name),
//!   never an address or a path. `file_drag_rules` checks each part by
//!   Core's own rule and builds the path, one of Core's three download
//!   routes on the selected Core. The app's Core client follows no
//!   redirect; only a 200 is taken, and no more than Core keeps (25 MiB for
//!   a Brief snapshot, 40 MiB for a sent file). Core asks nothing more of
//!   the app than of the page: its downloads need no credential.
//! - **Where the copy goes.** `<app cache>/drag/<16 hex digits>/<Core's
//!   name>`: a new folder for every drag, never one reused, and a new file.
//!   It is marked as a download (`Zone.Identifier` on Windows, quarantine on
//!   macOS).
//! - **When it goes.** At once when no drag happened (the button was let go,
//!   or something failed). A dropped copy stays, since the app it went to
//!   may read it later, and goes once it is older than an hour: when the app
//!   starts and before each drag. Only folders named as copies are removed.
//! - **The drag.** Copy only, one at a time, and only while the primary
//!   button is still held: `file_drag/win.rs` on Windows, `file_drag/mac.rs`
//!   on macOS. Elsewhere the page is told there is none, and drags as before.

use crate::{connection, file_drag_rules as rules, ConnectionState};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

#[cfg(target_os = "macos")]
#[path = "file_drag/mac.rs"]
mod native;
#[cfg(windows)]
#[path = "file_drag/win.rs"]
mod native;
#[cfg(not(any(windows, target_os = "macos")))]
mod native {
    use super::Outcome;
    use std::path::Path;
    use tauri::WebviewWindow;

    /// No system drag here: the page drags as a browser does.
    pub const READY: bool = false;

    pub async fn start(_window: &WebviewWindow, _path: &Path, _source: &str) -> Result<Outcome, String> {
        Err("Dragging a file out is not available on this system.".into())
    }
}

/// How long the file may take to arrive while the button is held: 40 MiB
/// in it is about 1.4 MB/s, slower than the links this app reaches a Core
/// over (this computer, an SSH tunnel, a tailnet). The app's Core client
/// otherwise gives up after 4 seconds, for a health check.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// A file the page asks to drag out, as Core names it.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DragFile {
    BriefAttachment { project_id: String, section: String, name: String, version: u64 },
    AgentFile { agent_id: String, file_id: String, name: String },
    ProjectFile { project_id: String, file_id: String, name: String },
}

impl DragFile {
    fn rules(&self) -> rules::File<'_> {
        match self {
            DragFile::BriefAttachment { project_id, section, name, version } => rules::File::BriefAttachment {
                project: project_id,
                section,
                name,
                version: *version,
            },
            DragFile::AgentFile { agent_id, file_id, name } => rules::File::AgentFile { agent: agent_id, id: file_id, name },
            DragFile::ProjectFile { project_id, file_id, name } => {
                rules::File::ProjectFile { project: project_id, id: file_id, name }
            }
        }
    }
}

/// How a drag ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// Dropped where something took it.
    Dropped,
    /// Let go where nothing took it, or Escape was pressed.
    Cancelled,
    /// The button was let go before the file had arrived: no drag began.
    Released,
}

/// The command's answer: whether this app drags files out here, when the
/// page asks without a file; else how the drag ended.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Answer {
    Probe { ready: bool },
    Drag { outcome: Outcome },
}

/// One drag at a time: a second one, while the first is fetched or under
/// way, is refused.
#[derive(Default)]
pub struct FileDrags {
    busy: AtomicBool,
}

struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl FileDrags {
    fn begin(&self) -> Result<Busy<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| Busy(&self.busy))
            .map_err(|_| "Another file is being dragged out.".to_owned())
    }
}

/// Drags `file` out of the window as a real file; without one, says whether
/// this app can here.
#[tauri::command]
pub async fn desktop_file_drag(
    window: WebviewWindow,
    connection: tauri::State<'_, ConnectionState>,
    drags: tauri::State<'_, FileDrags>,
    file: Option<DragFile>,
) -> Result<Answer, String> {
    let selected = connection
        .selected
        .lock()
        .map_err(|_| "Connection state unavailable.")?
        .clone();
    let page = window.url().map_err(|e| e.to_string())?;
    if !connection::permits_workspace(window.label(), &page, selected.as_ref()) {
        return Err("Dragging files out is only available in the selected workspace.".into());
    }
    let Some(file) = file else {
        return Ok(Answer::Probe { ready: native::READY });
    };
    if !native::READY {
        return Err("Dragging a file out is not available on this system.".into());
    }
    let core = selected.ok_or("No workspace is selected.")?;
    let fetch = rules::fetch(&file.rules())?;
    let url = address(&core, &fetch.path)?;
    let _busy = drags.begin()?;
    let root = copies(window.app_handle())?;
    remove_stale(&root);
    let folder = new_folder(&root)?;
    let outcome = deliver(&window, &connection.client, &url, &fetch, &folder).await;
    if outcome != Ok(Outcome::Dropped) {
        remove(&folder);
    }
    outcome.map(|outcome| Answer::Drag { outcome })
}

/// `path` on the selected Core, and nowhere else.
fn address(core: &Url, path: &str) -> Result<Url, String> {
    let url = core.join(path).map_err(|_| "That file has no address on this Core.")?;
    if url.origin() != core.origin() {
        return Err("That file has no address on this Core.".into());
    }
    Ok(url)
}

async fn deliver(
    window: &WebviewWindow,
    client: &reqwest::Client,
    url: &Url,
    fetch: &rules::Fetch,
    folder: &Path,
) -> Result<Outcome, String> {
    let bytes = download(client, url, fetch.limit).await?;
    let units = folder.to_string_lossy().encode_utf16().count();
    let path = folder.join(rules::disk_name(&fetch.name, cfg!(windows), units));
    let written = path.clone();
    tauri::async_runtime::spawn_blocking(move || write_new(&written, &bytes))
        .await
        .map_err(|_| "The file could not be kept for the drag.".to_owned())??;
    native::start(window, &path, url.as_str()).await
}

/// The file, whole and within `limit`, from a 200 answer only.
async fn download(client: &reqwest::Client, url: &Url, limit: u64) -> Result<Vec<u8>, String> {
    let too_large = || "This file is larger than Core keeps.".to_owned();
    let mut response = client
        .get(url.clone())
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|_| "Core did not answer.".to_owned())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("Core answered HTTP {}.", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|length| length > limit) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The file did not arrive whole.".to_owned())?
    {
        if body.len() as u64 + chunk.len() as u64 > limit {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("The file could not be kept for the drag ({e})."))?;
    file.write_all(bytes)
        .map_err(|e| format!("The file could not be kept for the drag ({e})."))
}

/// This app's folder of copies, made if it is not there.
fn copies(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "This app has no folder to keep the file in.")?
        .join("drag");
    std::fs::create_dir_all(&root).map_err(|e| format!("This app could not make a folder for the file ({e})."))?;
    Ok(root)
}

/// A new folder for one drag's copy; an existing one is never reused.
fn new_folder(root: &Path) -> Result<PathBuf, String> {
    let state = RandomState::new();
    for attempt in 0u64..8 {
        let mut hasher = state.build_hasher();
        hasher.write_u64(attempt);
        hasher.write_u128(SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos());
        let folder = root.join(rules::copy_folder_name(hasher.finish()));
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("This app could not make a folder for the file ({error}).")),
        }
    }
    Err("This app could not make a folder for the file.".into())
}

/// One drag's folder, once it is no longer needed. A copy the app it went
/// to still holds open stays, and goes with the stale ones later.
fn remove(folder: &Path) {
    if let Err(error) = std::fs::remove_dir_all(folder) {
        eprintln!("Unable to remove a dragged file's copy yet: {error}");
    }
}

/// Removes the copies older than an hour: only real folders (never a link)
/// named as copies, in this app's folder of copies.
fn remove_stale(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let named = entry.file_name().to_str().is_some_and(rules::copy_folder);
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        let stale = meta
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= Duration::from_secs(rules::STALE_SECS));
        if named && meta.is_dir() && !meta.file_type().is_symlink() && stale {
            remove(&entry.path());
        }
    }
}

/// When the app starts: the copies of earlier runs that are old enough.
pub fn remove_stale_at_start(app: &AppHandle) {
    let Ok(cache) = app.path().app_cache_dir() else { return };
    tauri::async_runtime::spawn_blocking(move || remove_stale(&cache.join("drag")));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_names_a_file_in_its_own_words() {
        let file: DragFile = serde_json::from_value(serde_json::json!({
            "kind": "briefAttachment", "projectId": "p1", "section": "design/yn170", "name": "notes.md", "version": 3
        }))
        .unwrap();
        assert_eq!(
            file.rules(),
            rules::File::BriefAttachment { project: "p1", section: "design/yn170", name: "notes.md", version: 3 }
        );
        let file: DragFile = serde_json::from_value(serde_json::json!({
            "kind": "agentFile", "agentId": "a", "fileId": "f", "name": "a.txt"
        }))
        .unwrap();
        assert_eq!(file.rules(), rules::File::AgentFile { agent: "a", id: "f", name: "a.txt" });
        let file: DragFile = serde_json::from_value(serde_json::json!({
            "kind": "projectFile", "projectId": "p", "fileId": "f", "name": "a.txt"
        }))
        .unwrap();
        assert_eq!(file.rules(), rules::File::ProjectFile { project: "p", id: "f", name: "a.txt" });
        // An address or a path is not a file this takes.
        for other in [
            serde_json::json!({ "kind": "url", "url": "https://example.com/a.txt" }),
            serde_json::json!({ "kind": "path", "path": "C:\\Windows\\win.ini" }),
            serde_json::json!({ "kind": "agentFile", "agentId": "a", "name": "a.txt" }),
            serde_json::json!({ "kind": "briefAttachment", "projectId": "p", "section": "s", "name": "a", "version": -1 }),
        ] {
            assert!(serde_json::from_value::<DragFile>(other.clone()).is_err(), "{other}");
        }
    }

    #[test]
    fn the_page_reads_the_answer_in_its_own_words() {
        assert_eq!(serde_json::to_value(Answer::Probe { ready: true }).unwrap(), serde_json::json!({ "ready": true }));
        assert_eq!(
            serde_json::to_value(Answer::Drag { outcome: Outcome::Released }).unwrap(),
            serde_json::json!({ "outcome": "released" })
        );
        assert_eq!(serde_json::to_value(Outcome::Dropped).unwrap(), "dropped");
        assert_eq!(serde_json::to_value(Outcome::Cancelled).unwrap(), "cancelled");
    }

    #[test]
    fn a_file_is_fetched_only_from_the_selected_core() {
        let core = Url::parse("http://127.0.0.1:4317").unwrap();
        let fetch = rules::fetch(&rules::File::BriefAttachment { project: "p", section: "a/b", name: "x.csv", version: 2 }).unwrap();
        assert_eq!(
            address(&core, &fetch.path).unwrap().as_str(),
            "http://127.0.0.1:4317/api/projects/p/brief/attachments/a%2Fb/x.csv?version=2"
        );
        let tunnel = Url::parse("https://core.example.ts.net").unwrap();
        assert_eq!(
            address(&tunnel, "api/agents/a/files/f/n").unwrap().as_str(),
            "https://core.example.ts.net/api/agents/a/files/f/n"
        );
        for elsewhere in ["//example.com/a", "https://example.com/a", "http://127.0.0.1:4318/a"] {
            assert!(address(&core, elsewhere).is_err(), "{elsewhere}");
        }
    }

    #[test]
    fn one_drag_at_a_time() {
        let drags = FileDrags::default();
        let first = drags.begin().unwrap();
        assert!(drags.begin().is_err());
        drop(first);
        assert!(drags.begin().is_ok());
    }

    #[test]
    fn only_stale_copy_folders_are_removed() {
        let root = std::env::temp_dir().join(format!("yuzuno-file-drag-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let fresh = new_folder(&root).unwrap();
        std::fs::write(fresh.join("a.txt"), b"kept").unwrap();
        let other = root.join("not-a-copy");
        std::fs::create_dir(&other).unwrap();
        let named_file = root.join(rules::copy_folder_name(7));
        std::fs::write(&named_file, b"a file, not a folder").unwrap();
        remove_stale(&root);
        // Nothing here is an hour old.
        assert!(fresh.join("a.txt").exists());
        assert!(other.exists());
        assert!(named_file.exists());
        // A second folder is never the first.
        let second = new_folder(&root).unwrap();
        assert_ne!(second, fresh);
        assert!(rules::copy_folder(second.file_name().unwrap().to_str().unwrap()));
        remove(&fresh);
        assert!(!fresh.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
