//! Desktop app updates through the selected Core (T-13).
//!
//! The release source is the Core this window is connected to, on this
//! computer: it reads the project's private `desktop-*` Releases with its own
//! GitHub login, so the desktop never holds a token. Trust does not come from
//! Core. Every update is signed, the official updater verifies the download
//! against the public key built into this app (and that the signed version is
//! the one announced), and exactly those verified bytes are installed.
//!
//! Windows runs the signed installer, which closes this app and opens the
//! new version. macOS replaces this app's bundle in place with the signed
//! `.app` archive (the updater's own swap, which puts the old app back if it
//! fails), then this app reopens itself as the new version (YN-181).
use crate::{connection, ConnectionState};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

/// This platform, as Core names its update routes and the updater looks it
/// up in Core's manifest: the updater's own `{os}-{arch}` name.
#[cfg(target_os = "macos")]
const TARGET: &str = "darwin-aarch64";
#[cfg(not(target_os = "macos"))]
const TARGET: &str = "windows-x86_64";
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_INSTALLER: u64 = 512 * 1024 * 1024;
/// A restart after an update reopens the Core that was selected, if it
/// happens this soon after the install began.
const RESUME_WINDOW: Duration = Duration::from_secs(30 * 60);
const RESUME_FILE: &str = "resume-after-update.json";

fn manifest_url(core: &Url) -> Result<Url, String> {
    core.join(&format!("api/updates/desktop/{TARGET}/manifest"))
        .map_err(|e| e.to_string())
}

/// Where Core serves installers: the update must come from there.
fn installer_path() -> String {
    format!("/api/updates/desktop/{TARGET}/installer")
}

#[derive(Default)]
pub struct DesktopUpdates {
    /// The last check, for the Core it was read from.
    pending: Mutex<Option<Pending>>,
    progress: Mutex<Progress>,
    received: AtomicU64,
}

struct Pending {
    core: Url,
    update: Update,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    error: Option<String>,
    total_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    version: String,
    /// "installer": this copy can replace itself in place with an update (on
    /// Windows, installed by this app's own installer; on macOS, an app
    /// bundle). "unknown": anything else (a portable copy, a build, another
    /// installer); it is updated by hand. The name is kept: pages from
    /// core.36 and older offer the install only for "installer".
    channel: &'static str,
    /// Why this copy cannot update itself here, if it cannot.
    unavailable: Option<String>,
    phase: &'static str,
    error: Option<String>,
    received_bytes: u64,
    total_bytes: Option<u64>,
    available: Option<Available>,
}

/// The selected Core, when this call comes from that Core's workspace page.
fn workspace_core(window: &WebviewWindow, state: &ConnectionState) -> Result<Url, String> {
    let selected = state
        .selected
        .lock()
        .map_err(|_| "Connection state unavailable.")?
        .clone();
    let url = window.url().map_err(|e| e.to_string())?;
    if !connection::permits_workspace(window.label(), &url, selected.as_ref()) {
        return Err("Desktop updates are only available in the selected workspace.".into());
    }
    selected.ok_or_else(|| "No workspace is selected.".into())
}

fn public_key(app: &AppHandle) -> Option<String> {
    config_public_key(app.config())
}

/// The key updates are verified with (plugins > updater > pubkey), if this
/// build has one. Without it the updater plugin cannot start, so the app runs
/// without it and says why where updates are offered.
pub fn config_public_key(config: &tauri::Config) -> Option<String> {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

/// Why updates cannot run here at all (as opposed to a failed attempt).
fn unavailable(app: &AppHandle, core: &Url) -> Option<String> {
    if !cfg!(any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )) {
        return Some(
            "Desktop updates are published for Windows x64 and Apple silicon Macs.".into(),
        );
    }
    if public_key(app).is_none() {
        return Some(
            "This build has no update signing key. Install a newer release by hand.".into(),
        );
    }
    if !connection::is_loopback(core) {
        return Some(
            "Desktop updates come through a Core on this computer. Connect to it, or update by hand."
                .into(),
        );
    }
    #[cfg(target_os = "macos")]
    if mac::runs_read_only() {
        return Some(
            "Yuzuno is running from its disk image or from a place macOS keeps read-only. \
            Drag it to Applications, open it from there, then update."
                .into(),
        );
    }
    None
}

impl DesktopUpdates {
    fn status(&self, app: &AppHandle, core: &Url) -> Status {
        let progress = self.progress.lock().unwrap().clone();
        let pending = self.pending.lock().unwrap();
        let available = pending
            .as_ref()
            .filter(|pending| pending.core == *core)
            .map(|pending| Available {
                version: pending.update.version.clone(),
                notes: pending.update.body.clone(),
                date: pending.update.date.map(|date| date.to_string()),
            });
        Status {
            version: app.package_info().version.to_string(),
            channel: if self_updating_copy(&app.package_info().name) {
                "installer"
            } else {
                "unknown"
            },
            unavailable: unavailable(app, core),
            phase: if progress.phase.is_empty() {
                "idle"
            } else {
                progress.phase
            },
            error: progress.error,
            received_bytes: self.received.load(Ordering::Relaxed),
            total_bytes: progress.total_bytes,
            available,
        }
    }

    fn set(&self, phase: &'static str, error: Option<String>) {
        let mut progress = self.progress.lock().unwrap();
        progress.phase = phase;
        progress.error = error;
    }

    fn busy(&self) -> bool {
        matches!(
            self.progress.lock().unwrap().phase,
            "checking" | "downloading" | "installing"
        )
    }

    /// A Core switch makes an earlier check meaningless.
    pub fn forget(&self) {
        *self.pending.lock().unwrap() = None;
        if !self.busy() {
            self.set("idle", None);
        }
    }
}

/// Only an installer for this exact target, from the selected Core.
fn validate_download(core: &Url, url: &Url) -> Result<(), String> {
    let same_origin = url.origin() == core.origin()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none();
    if !same_origin || url.path() != installer_path() {
        return Err("The update did not come from the selected Core; it was not used.".into());
    }
    Ok(())
}

fn readable(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        // An older Core answers this platform's manifest route with 404,
        // which the updater reads as no release.
        Error::ReleaseNotFound => {
            "This Core offered no desktop release for this computer. It may have no release \
            source or no published release for it yet, or be older than desktop updates for \
            this computer."
                .into()
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "The desktop release has no update for this computer.".into()
        }
        Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => {
            "The update's signature does not match the version it claims; it was not installed."
                .into()
        }
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            "The update's signature is not valid for this app; it was not installed.".into()
        }
        Error::Reqwest(_) | Error::Network(_) => {
            "Could not reach the Core for the update. Check that it is running and try again."
                .into()
        }
        other => format!("The update failed: {other}"),
    }
}

/// Why installing the verified update did not happen.
fn install_failure(error: tauri_plugin_updater::Error) -> String {
    if cfg!(target_os = "macos") {
        mac_install_failure(error)
    } else {
        format!("The installer could not start: {error}")
    }
}

/// The macOS updater's failures, said so that the user can act on them. It
/// moves the new app into place with renames on the app's own disk; a
/// permission error is the administrator prompt cancelled, or macOS (App
/// Management) refusing the change.
fn mac_install_failure(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::PreviousAppNotRestored(kept) => format!(
            "The update failed and the previous app could not be put back; it was kept at {}. \
            Move it back to Applications.",
            kept.display()
        ),
        Error::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            "macOS did not let Yuzuno replace itself. Install the new version by hand, or allow \
            Yuzuno under System Settings → Privacy & Security → App Management and \
            try again."
                .into()
        }
        Error::TempDirNotOnSameMountPoint => {
            "Yuzuno can update itself only on the disk that holds the system's temporary \
            folder. Move it to Applications."
                .into()
        }
        other => format!("The update could not be installed: {other}"),
    }
}

#[tauri::command]
pub fn desktop_update_status(
    app: AppHandle,
    window: WebviewWindow,
    connection: tauri::State<'_, ConnectionState>,
    updates: tauri::State<'_, DesktopUpdates>,
) -> Result<Status, String> {
    let core = workspace_core(&window, &connection)?;
    Ok(updates.status(&app, &core))
}

#[tauri::command]
pub async fn desktop_update_check(
    app: AppHandle,
    window: WebviewWindow,
    connection: tauri::State<'_, ConnectionState>,
    updates: tauri::State<'_, DesktopUpdates>,
) -> Result<Status, String> {
    let core = workspace_core(&window, &connection)?;
    if let Some(reason) = unavailable(&app, &core) {
        return Err(reason);
    }
    if updates.busy() {
        return Ok(updates.status(&app, &core));
    }
    updates.set("checking", None);
    *updates.pending.lock().unwrap() = None;
    let checked = async {
        // Only the selected Core, no proxy and no redirects: the manifest and
        // the installer both come from it or from nowhere.
        let updater = app
            .updater_builder()
            .target(TARGET)
            .endpoints(vec![manifest_url(&core)?])
            .map_err(readable)?
            .timeout(CHECK_TIMEOUT)
            .no_proxy()
            .configure_client(|client| client.redirect(updater_http::redirect::Policy::none()))
            .build()
            .map_err(readable)?;
        let update = updater.check().await.map_err(readable)?;
        if let Some(update) = &update {
            validate_download(&core, &update.download_url)?;
        }
        Ok::<_, String>(update)
    }
    .await;
    // The selection may have changed while this ran; its result belongs to
    // the Core it asked.
    let still_selected = connection
        .selected
        .lock()
        .map(|s| s.as_ref() == Some(&core))
        .unwrap_or(false);
    match checked {
        Ok(_) if !still_selected => updates.set("idle", None),
        Ok(Some(update)) => {
            *updates.pending.lock().unwrap() = Some(Pending {
                core: core.clone(),
                update,
            });
            updates.set("available", None);
        }
        Ok(None) => updates.set("current", None),
        Err(error) => updates.set("failed", Some(error)),
    }
    Ok(updates.status(&app, &core))
}

/// Downloads the update checked from the selected Core, verifies it and
/// installs it: on Windows its installer closes this app and opens the new
/// version; on macOS the new bundle replaces this one and the app reopens.
/// Returns only if that failed.
#[tauri::command]
pub async fn desktop_update_install(
    app: AppHandle,
    window: WebviewWindow,
    connection: tauri::State<'_, ConnectionState>,
    updates: tauri::State<'_, DesktopUpdates>,
    version: String,
) -> Result<Status, String> {
    let core = workspace_core(&window, &connection)?;
    if let Some(reason) = unavailable(&app, &core) {
        return Err(reason);
    }
    if !self_updating_copy(&app.package_info().name) {
        return Err(
            "This copy was not installed from a Yuzuno release, so it cannot update itself. \
            Install the new release by hand."
                .into(),
        );
    }
    if updates.busy() {
        return Err("An update is already in progress.".into());
    }
    let mut update = {
        let mut pending = updates.pending.lock().unwrap();
        match pending.take() {
            Some(p) if p.core == core && p.update.version == version => p.update,
            other => {
                *pending = other;
                return Err(
                    "Check for updates again; the update shown is no longer the one available."
                        .into(),
                );
            }
        }
    };
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    updates.received.store(0, Ordering::Relaxed);
    updates.progress.lock().unwrap().total_bytes = None;
    updates.set("downloading", None);
    let too_large = Arc::new(tokio::sync::Notify::new());
    let signal = too_large.clone();
    let received = &updates.received;
    let progress = &updates.progress;
    // The official download verifies the signature. Past the size limit it is
    // dropped, which cancels the transfer.
    let downloaded = tokio::select! {
        result = update.download(
            |chunk, total| {
                if let Some(total) = total {
                    progress.lock().unwrap().total_bytes = Some(total);
                }
                let so_far = received.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                if so_far > MAX_INSTALLER || total.is_some_and(|t| t > MAX_INSTALLER) {
                    signal.notify_one();
                }
            },
            || {},
        ) => result.map_err(readable),
        _ = too_large.notified() => Err("The update is larger than a desktop installer can be; it was not used.".into()),
    };
    let bytes = match downloaded {
        Ok(bytes) => bytes,
        Err(error) => {
            updates.set("failed", Some(error.clone()));
            return Err(error);
        }
    };
    updates.set("installing", None);
    remember_core(&app, &core);
    // On Windows this starts the installer and exits; it returns only on
    // error. On macOS it returns once the new bundle is in place.
    if let Err(error) = update.install(bytes) {
        forget_core(&app);
        let error = install_failure(error);
        updates.set("failed", Some(error.clone()));
        return Err(error);
    }
    // macOS: reopen as the new version. Tauri ends this process and opens
    // the bundle again through Launch Services, with the original arguments;
    // the marker above reopens the Core selected now. It does not return.
    if cfg!(target_os = "macos") {
        app.restart();
    }
    Ok(updates.status(&app, &core))
}

fn resume_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(RESUME_FILE))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The installer (Windows) or the restart (macOS) reopens this app with its
/// original arguments; a Core chosen in the window is not among them, so it
/// is kept here for that restart.
fn remember_core(app: &AppHandle, core: &Url) {
    if let Some(path) = resume_file(app) {
        let record = serde_json::json!({"coreUrl": core.as_str(), "at": now_secs()});
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        if let Err(error) = std::fs::write(&path, record.to_string()) {
            eprintln!("Unable to remember the workspace across the update: {error}");
        }
    }
}

fn forget_core(app: &AppHandle) {
    if let Some(path) = resume_file(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// The installer replays the original arguments and environment (macOS's
/// restart replays the arguments only). A valid, one-time update marker
/// takes priority because the user may have selected another Core since
/// launch. Without one, normal startup selection is kept.
pub fn restore_startup_core(app: &AppHandle, startup: Result<Url, String>) -> Result<Url, String> {
    match resume_file(app) {
        Some(path) => restore_startup_from_file(&path, startup, now_secs()),
        None => startup,
    }
}

fn restore_startup_from_file(
    path: &Path,
    startup: Result<Url, String>,
    now: u64,
) -> Result<Url, String> {
    let record = std::fs::read(path).ok().filter(|bytes| bytes.len() <= 4096);
    // Consume before using it; if removal fails, do not repeatedly override
    // a later deliberate launch with the same marker.
    if std::fs::remove_file(path).is_err() {
        return startup;
    }
    record
        .as_deref()
        .and_then(|bytes| resume_record(bytes, now))
        .map(Ok)
        .unwrap_or(startup)
}

fn resume_record(bytes: &[u8], now: u64) -> Option<Url> {
    let record: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let at = record["at"].as_u64()?;
    if at > now || now - at > RESUME_WINDOW.as_secs() {
        return None;
    }
    connection::parse_core_url(record["coreUrl"].as_str()?).ok()
}

/// Whether this copy can replace itself in place with an update. On Windows:
/// installed by this app's own NSIS installer, whose uninstall record names
/// this executable. Anything else cannot be updated in place by this updater.
#[cfg(windows)]
fn self_updating_copy(product: &str) -> bool {
    let key = format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{product}");
    let (Some(location), Some(binary)) = (
        registry::current_user_string(&key, "InstallLocation"),
        registry::current_user_string(&key, "MainBinaryName"),
    ) else {
        return false;
    };
    let installed = PathBuf::from(location.trim().trim_matches('"')).join(binary.trim());
    let (Ok(installed), Ok(current)) = (
        std::fs::canonicalize(installed),
        std::env::current_exe().and_then(std::fs::canonicalize),
    ) else {
        return false;
    };
    installed
        .as_os_str()
        .eq_ignore_ascii_case(current.as_os_str())
}

/// On macOS: an app bundle, the folder the updater replaces (`update_rules`).
/// A `cargo run` build in `target/` is not one. Whether its volume can be
/// written is `unavailable`'s check.
#[cfg(target_os = "macos")]
fn self_updating_copy(_product: &str) -> bool {
    mac::current_bundle().is_some()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn self_updating_copy(_product: &str) -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac {
    use crate::update_rules;
    use objc2::rc::autoreleasepool;
    use objc2_foundation::{NSNumber, NSString, NSURLVolumeIsReadOnlyKey, NSURL};
    use std::path::{Path, PathBuf};

    /// The bundle this executable runs from, as the updater finds it (the
    /// same starting executable).
    pub fn current_bundle() -> Option<PathBuf> {
        let exe = tauri::utils::platform::current_exe().ok()?;
        update_rules::app_bundle(&exe)
    }

    /// The app runs from a volume that cannot be written: its disk image,
    /// or the random read-only place macOS runs a quarantined app from when
    /// it was opened where it was downloaded (App Translocation). One
    /// Foundation property covers both, whatever the path. An answer macOS
    /// cannot give counts as writable: the updater then refuses before it
    /// moves anything.
    pub fn runs_read_only() -> bool {
        let Ok(exe) = tauri::utils::platform::current_exe() else {
            return false;
        };
        let place = update_rules::app_bundle(&exe).unwrap_or(exe);
        on_read_only_volume(&place)
    }

    fn on_read_only_volume(path: &Path) -> bool {
        let Some(text) = path.to_str() else {
            return false;
        };
        autoreleasepool(|_| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(text));
            let mut value = None;
            // SAFETY: the key is Foundation's own constant, and an NSNumber
            // (a boolean) is the value it gives; it is checked before use.
            let read =
                unsafe { url.getResourceValue_forKey_error(&mut value, NSURLVolumeIsReadOnlyKey) };
            match read {
                Ok(()) => value
                    .as_deref()
                    .and_then(|value| value.downcast_ref::<NSNumber>())
                    .is_some_and(|number| number.boolValue()),
                Err(error) => {
                    eprintln!("Unable to read whether the app's volume is read-only: {error:?}");
                    false
                }
            }
        })
    }
}

#[cfg(windows)]
mod registry {
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ},
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// One REG_SZ value under HKEY_CURRENT_USER, if present.
    pub fn current_user_string(key: &str, value: &str) -> Option<String> {
        let (key, value) = (wide(key), wide(value));
        let mut buffer = vec![0u16; 1024];
        let mut bytes = (buffer.len() * 2) as u32;
        // SAFETY: the buffer and its byte length describe the same allocation.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let length = (bytes as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(
            &buffer[..length.min(buffer.len())],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> Url {
        Url::parse("http://127.0.0.1:4317/").unwrap()
    }

    #[test]
    fn each_platform_asks_core_for_its_own_update() {
        let expected = if cfg!(target_os = "macos") {
            "darwin-aarch64"
        } else {
            "windows-x86_64"
        };
        assert_eq!(TARGET, expected);
        assert_eq!(
            manifest_url(&core()).unwrap().as_str(),
            format!("http://127.0.0.1:4317/api/updates/desktop/{expected}/manifest")
        );
        assert_eq!(
            installer_path(),
            format!("/api/updates/desktop/{expected}/installer")
        );
    }

    #[test]
    fn an_update_is_used_only_from_the_selected_cores_installer_route() {
        let path = installer_path();
        let ok = Url::parse(&format!("http://127.0.0.1:4317{path}?tag=desktop-0.2.0")).unwrap();
        assert!(validate_download(&core(), &ok).is_ok());
        let other = if TARGET == "windows-x86_64" {
            "darwin-aarch64"
        } else {
            "windows-x86_64"
        };
        for bad in [
            format!("http://127.0.0.1:4318{path}"),
            format!("http://localhost:4317{path}"),
            "https://github.com/YuzukiS/Yuzuno/releases/download/x/setup.exe".into(),
            format!("http://127.0.0.1:4317{path}/../../agents"),
            "http://127.0.0.1:4317/api/artifact?path=/etc/passwd".into(),
            format!("http://user:pass@127.0.0.1:4317{path}"),
            format!("http://127.0.0.1:4317{path}#x"),
            // Another platform's update is not this one's.
            format!(
                "http://127.0.0.1:4317/api/updates/desktop/{other}/installer?tag=desktop-0.2.0"
            ),
        ] {
            assert!(
                validate_download(&core(), &Url::parse(&bad).unwrap()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_failed_mac_install_says_what_to_do() {
        use tauri_plugin_updater::Error;
        let kept = mac_install_failure(Error::PreviousAppNotRestored(PathBuf::from(
            "/Users/example/Yuzuno.app",
        )));
        assert!(
            kept.contains("kept at /Users/example/Yuzuno.app.")
                && kept.ends_with("Move it back to Applications."),
            "{kept}"
        );
        // The administrator prompt cancelled, or App Management refusing.
        let denied = mac_install_failure(Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Failed to move the new app into place",
        )));
        assert!(
            denied.starts_with("macOS did not let Yuzuno replace itself.")
                && denied.contains("Privacy & Security → App Management"),
            "{denied}"
        );
        assert!(mac_install_failure(Error::TempDirNotOnSameMountPoint)
            .ends_with("Move it to Applications."));
        let other = mac_install_failure(Error::Io(std::io::Error::other("disk full")));
        assert_eq!(other, "The update could not be installed: disk full");
    }

    #[test]
    fn only_a_build_with_an_update_key_has_one() {
        let config = |plugins: serde_json::Value| -> tauri::Config {
            serde_json::from_value(serde_json::json!({"identifier": "dev.yuzuno.test", "plugins": plugins})).unwrap()
        };
        assert_eq!(config_public_key(&config(serde_json::json!({}))), None);
        assert_eq!(config_public_key(&config(serde_json::json!({"updater": {"windows": {}}}))), None);
        assert_eq!(config_public_key(&config(serde_json::json!({"updater": {"pubkey": "  "}}))), None);
        assert_eq!(
            config_public_key(&config(serde_json::json!({"updater": {"pubkey": " key "}}))).as_deref(),
            Some("key")
        );
    }

    #[test]
    fn update_restart_prefers_the_selected_core_over_replayed_cli_and_environment_once() {
        let path = std::env::temp_dir().join(format!(
            "yuzuno-resume-test-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let selected = Url::parse("http://127.0.0.1:4473").unwrap();
        let now = 10_000;
        for startup in [
            connection::configured_url(["--core-url".into(), "http://127.0.0.1:4998".into()], None),
            connection::configured_url([], Some("http://localhost:4999".into())),
            connection::configured_url(["--core-url".into(), "invalid".into()], None),
        ] {
            let write = |at| {
                std::fs::write(
                    &path,
                    serde_json::json!({"coreUrl":selected,"at":at}).to_string(),
                )
                .unwrap()
            };
            write(now - 60);
            assert_eq!(
                restore_startup_from_file(&path, startup.clone(), now),
                Ok(selected.clone())
            );
            assert!(!path.exists(), "consumed on the update restart");
            assert_eq!(
                restore_startup_from_file(&path, startup.clone(), now),
                startup,
                "next launch honors its own selection"
            );
            write(now - 3_600);
            assert_eq!(
                restore_startup_from_file(&path, startup.clone(), now),
                startup,
                "stale marker does not override startup"
            );
            assert!(!path.exists());
        }
    }

    #[test]
    fn the_resume_record_reopens_only_a_recent_valid_core() {
        let record = |url: &str, at: u64| {
            serde_json::json!({"coreUrl": url, "at": at})
                .to_string()
                .into_bytes()
        };
        let now = 10_000;
        assert_eq!(
            resume_record(&record("http://127.0.0.1:4321", now - 60), now),
            Some(Url::parse("http://127.0.0.1:4321").unwrap())
        );
        assert_eq!(
            resume_record(&record("http://127.0.0.1:4321", now - 3_600), now),
            None,
            "stale"
        );
        assert_eq!(
            resume_record(&record("http://127.0.0.1:4321", now + 60), now),
            None,
            "from the future"
        );
        assert_eq!(
            resume_record(&record("http://192.168.1.2:4317", now), now),
            None,
            "not a valid Core address"
        );
        assert_eq!(resume_record(b"not json", now), None);
    }
}
