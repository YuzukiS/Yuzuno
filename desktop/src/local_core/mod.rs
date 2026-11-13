//! The connection page's local Core commands (YN-107 and YN-108 share their
//! interface: YN-107 design section 6). Only the embedded connection page
//! may call them: each is in `build.rs` and the `connection` capability and
//! first checks `require_connection_page`; a Workspace page has none.
//!
//! So far (YN-109): `local_core_targets` lists where this computer could
//! install or start Core, and `local_core_check` checks one of them
//! read-only, with any installation already there. On Windows that is a
//! WSL 2 distribution (`wsl.rs`); the Mac app answers `comingSoon` until
//! YN-108 connects its own; elsewhere `unsupported`.

pub mod auto_start;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod check_rules;
#[cfg(windows)]
pub mod wsl;
#[cfg_attr(not(windows), allow(dead_code))]
mod wsl_list;

use check_rules::{Found, Level, Port, Report, State};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::WebviewWindow;

/// The read-only check, sent to WSL on stdin (design 4.3).
#[cfg_attr(not(windows), allow(dead_code))]
const CHECK_SCRIPT: &str = include_str!("check.sh");

/// Where this computer can install or start a local Core.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Targets {
    platform: Option<&'static str>,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    targets: Vec<Target>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    id: String,
    label: String,
    kind: &'static str,
    selectable: bool,
    is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// What the read-only check of one target found.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    target: String,
    platform: &'static str,
    user: String,
    home: String,
    checks: Vec<CheckItem>,
    installation: Option<Installation>,
    defaults: Defaults,
    installable: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CheckItem {
    id: &'static str,
    level: &'static str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl From<check_rules::Item> for CheckItem {
    fn from(item: check_rules::Item) -> Self {
        Self {
            id: item.id,
            level: match item.level {
                Level::Required => "required",
                Level::Recommended => "recommended",
            },
            state: match item.state {
                State::Ok => "ok",
                State::Missing => "missing",
                State::Unknown => "unknown",
            },
            detail: item.detail,
        }
    }
}

/// An installation already in the install folder. Without a start record
/// (`recorded: false`) its port and Workspace are not known.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    install_dir: String,
    release_id: String,
    port: Option<u16>,
    workspace_id: Option<String>,
    recorded: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    install_dir: String,
    data_dir: String,
    port: u16,
}

/// What every command answers with when it does not do what was asked.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Error {
    code: &'static str,
    message: String,
}

impl Error {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

fn require_connection_page(window: &WebviewWindow) -> Result<(), Error> {
    crate::require_connection_page(window).map_err(|message| Error::new("notConnectionPage", message))
}

/// The targets the page was last shown, which are the only ones it may
/// check; and whether a check is running.
#[derive(Default)]
pub struct LocalCore {
    listed: Mutex<Vec<Target>>,
    checking: AtomicBool,
}

#[tauri::command]
pub async fn local_core_targets(window: WebviewWindow, local: tauri::State<'_, LocalCore>) -> Result<Targets, Error> {
    require_connection_page(&window)?;
    let targets = platform_targets().await;
    *local.listed.lock().map_err(|_| Error::new("unavailable", "Local Core state unavailable."))? = targets.targets.clone();
    Ok(targets)
}

#[tauri::command]
pub async fn local_core_check(
    window: WebviewWindow,
    local: tauri::State<'_, LocalCore>,
    target: String,
) -> Result<Check, Error> {
    require_connection_page(&window)?;
    if !cfg!(windows) {
        return Err(Error::new("unsupported", "This app cannot install Core on this computer yet."));
    }
    let target = local
        .listed
        .lock()
        .map_err(|_| Error::new("unavailable", "Local Core state unavailable."))?
        .iter()
        .find(|listed| listed.id == target && listed.selectable)
        .cloned()
        .ok_or_else(|| Error::new("unknownTarget", "Choose a distribution from the latest list."))?;
    if local.checking.swap(true, Ordering::SeqCst) {
        return Err(Error::new("busy", "A check is already running."));
    }
    struct Done<'a>(&'a AtomicBool);
    impl Drop for Done<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _done = Done(&local.checking);
    check_target(&window, &target).await
}

#[cfg(windows)]
async fn platform_targets() -> Targets {
    match tauri::async_runtime::spawn_blocking(wsl::list).await {
        Ok(Ok(output)) => wsl_targets(output.success, &output.stdout, &output.stderr),
        Ok(Err(wsl::Failure::NoWsl)) => Targets {
            platform: Some("wsl"),
            available: false,
            reason: Some("noWsl"),
            message: Some("WSL is not installed on this computer.".into()),
            targets: Vec::new(),
        },
        Ok(Err(wsl::Failure::Run(message))) => wsl_error(message),
        Err(error) => wsl_error(error.to_string()),
    }
}

#[cfg(target_os = "macos")]
async fn platform_targets() -> Targets {
    Targets { platform: Some("macos"), available: false, reason: Some("comingSoon"), message: None, targets: Vec::new() }
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn platform_targets() -> Targets {
    Targets { platform: None, available: false, reason: Some("unsupported"), message: None, targets: Vec::new() }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn wsl_error(message: String) -> Targets {
    Targets { platform: Some("wsl"), available: false, reason: Some("wslError"), message: Some(message), targets: Vec::new() }
}

/// What the page is shown from `wsl.exe --list --verbose` (design 4.2): a
/// distribution can be chosen if it is WSL 2 and its name is one this app
/// passes to WSL. A failure shows WSL's own first line.
#[cfg_attr(not(windows), allow(dead_code))]
fn wsl_targets(success: bool, stdout: &[u8], stderr: &[u8]) -> Targets {
    let text = wsl_list::decode(stdout);
    if !success {
        let message = wsl_list::first_line(&wsl_list::decode(stderr))
            .or_else(|| wsl_list::first_line(&text))
            .unwrap_or_else(|| "WSL could not list its distributions.".into());
        return wsl_error(message);
    }
    let distros = wsl_list::parse(&text);
    if distros.is_empty() {
        return wsl_error("WSL listed no distributions.".into());
    }
    let targets = distros
        .into_iter()
        .map(|distro| {
            let named = check_rules::distro_name_ok(&distro.name);
            let note = if distro.version != 2 {
                Some(format!("WSL {}: run `wsl --set-version {} 2` in Windows first.", distro.version, distro.name))
            } else if !named {
                Some("Its name has characters this app does not pass to WSL.".into())
            } else {
                None
            };
            Target {
                label: distro.name.clone(),
                id: distro.name,
                kind: "wsl",
                selectable: distro.version == 2 && named,
                is_default: distro.is_default,
                note,
            }
        })
        .collect();
    Targets { platform: Some("wsl"), available: true, reason: None, message: None, targets }
}

#[cfg(windows)]
async fn check_target(window: &WebviewWindow, target: &Target) -> Result<Check, Error> {
    let distro = target.id.clone();
    let output = tauri::async_runtime::spawn_blocking(move || wsl::check(&distro, CHECK_SCRIPT))
        .await
        .map_err(|error| Error::new("checkFailed", error.to_string()))?
        .map_err(|failure| match failure {
            wsl::Failure::NoWsl => Error::new("noWsl", "WSL is not installed on this computer."),
            wsl::Failure::Run(message) => Error::new("checkFailed", message),
        })?;
    let text = String::from_utf8_lossy(&output.stdout);
    let report = check_rules::parse(&text).ok().filter(|_| output.success).ok_or_else(|| {
        let said = wsl_list::first_line(&wsl_list::decode(&output.stderr))
            .or_else(|| wsl_list::first_line(&text))
            .unwrap_or_else(|| "no output".into());
        Error::new("checkFailed", format!("The check could not run in {}: {said}.", target.id))
    })?;
    let port = free_port(window).await;
    Ok(build_check(&target.id, &report, port))
}

#[cfg(not(windows))]
async fn check_target(_: &WebviewWindow, _: &Target) -> Result<Check, Error> {
    Err(Error::new("unsupported", "This app cannot install Core on this computer yet."))
}

/// The first port of [`check_rules::PORTS`] that no saved workspace or
/// remembered address is on and nothing on Windows' loopback answers at
/// (design 4.7). Windows also reaches a Core in WSL there, and a program
/// that holds the port on Windows would keep WSL's forwarding from it.
#[cfg(windows)]
async fn free_port(window: &WebviewWindow) -> Port {
    use std::{
        net::{Ipv4Addr, SocketAddr, TcpStream},
        time::Duration,
    };
    use tauri::Manager;
    let saved = crate::read_entries(window.app_handle());
    if let Some(reason) = crate::entries::unusable(&saved) {
        return Port::Unknown(format!("The workspaces saved on this computer could not be read ({reason})."));
    }
    let bound: Vec<u16> = saved
        .entries()
        .iter()
        .map(|entry| &entry.url)
        .chain(saved.remembered().iter().map(|known| &known.url))
        .filter(|url| crate::connection::is_loopback(url))
        .filter_map(|url| url.port_or_known_default())
        .collect();
    let candidates: Vec<u16> = check_rules::PORTS.filter(|port| !bound.contains(port)).collect();
    // A connection is accepted at once when something listens; Windows
    // takes about 2 s to refuse one, so a short wait is enough.
    let answering = |port: u16| {
        TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(500)).is_ok()
    };
    match tauri::async_runtime::spawn_blocking(move || candidates.into_iter().find(|&port| !answering(port))).await {
        Ok(Some(port)) => Port::Free(port),
        Ok(None) => Port::NoneFree,
        Err(error) => Port::Unknown(error.to_string()),
    }
}

/// `current.json`: only the release is read.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Current {
    release_id: String,
}

/// `updates/launch.json`: only where it ran and with which Workspace is
/// read; the environment it recorded and the rest are dropped unread.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Launch {
    port: u16,
    workspace_id: String,
}

/// The installation the check found, as far as this app can read it.
#[cfg_attr(not(windows), allow(dead_code))]
fn installation(report: &Report) -> (Option<Installation>, Found) {
    if report.get("root.state") != Some("installed") {
        return (None, Found::Nothing);
    }
    let read = |key: &str| report.get(key).filter(|text| !text.is_empty()).and_then(check_rules::base64);
    let root = report.get("root").filter(|root| check_rules::linux_path_ok(root));
    let current = read("root.current").and_then(|bytes| serde_json::from_slice::<Current>(&bytes).ok());
    let (Some(root), Some(current)) = (root, current.filter(|current| check_rules::release_id_ok(&current.release_id)))
    else {
        return (None, Found::Unreadable);
    };
    let recorded = read("root.launch")
        .and_then(|bytes| serde_json::from_slice::<Launch>(&bytes).ok())
        .filter(|launch| launch.port >= 1024 && check_rules::workspace_id_ok(&launch.workspace_id))
        // Its start entry is what starts a recorded installation.
        .filter(|_| report.get("root.entry") == Some("yes"));
    let installation = Installation {
        install_dir: root.to_owned(),
        release_id: current.release_id,
        port: recorded.as_ref().map(|launch| launch.port),
        recorded: recorded.is_some(),
        workspace_id: recorded.map(|launch| launch.workspace_id),
    };
    (Some(installation), Found::Installation)
}

/// The check's answer to the page. Only WSL 2 targets are checked.
#[cfg_attr(not(windows), allow(dead_code))]
fn build_check(target: &str, report: &Report, port: Port) -> Check {
    let (installation, found) = installation(report);
    let items = check_rules::judge(report, true, &port, found);
    let installable = check_rules::installable(&items, found);
    let text = |key: &str| report.get(key).unwrap_or_default().to_owned();
    Check {
        target: target.to_owned(),
        platform: "wsl",
        user: text("user"),
        home: text("home"),
        checks: items.into_iter().map(CheckItem::from).collect(),
        installation,
        defaults: Defaults {
            install_dir: text("root"),
            data_dir: text("data"),
            port: match port {
                Port::Free(port) => port,
                _ => *check_rules::PORTS.start(),
            },
        },
        installable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn targets_have_the_shared_shape() {
        let list = "  NAME            STATE           VERSION\r\n* main-distro     Running         2\r\n  old-distro      Stopped         1\r\n  odd,name        Stopped         2\r\n";
        let targets = wsl_targets(true, list.as_bytes(), b"");
        assert_eq!(
            serde_json::to_value(&targets).unwrap(),
            json!({
                "platform": "wsl",
                "available": true,
                "targets": [
                    {"id": "main-distro", "label": "main-distro", "kind": "wsl", "selectable": true, "isDefault": true},
                    {"id": "old-distro", "label": "old-distro", "kind": "wsl", "selectable": false, "isDefault": false,
                     "note": "WSL 1: run `wsl --set-version old-distro 2` in Windows first."},
                    {"id": "odd,name", "label": "odd,name", "kind": "wsl", "selectable": false, "isDefault": false,
                     "note": "Its name has characters this app does not pass to WSL."}
                ]
            })
        );
    }

    #[test]
    fn a_failed_or_empty_list_shows_what_wsl_said() {
        let error = |targets: Targets| serde_json::to_value(&targets).unwrap();
        assert_eq!(
            error(wsl_targets(false, b"", b"<3>WSL (8) ERROR: something.\r\n")),
            json!({"platform": "wsl", "available": false, "reason": "wslError", "message": "WSL (8) ERROR: something", "targets": []})
        );
        // UTF-16LE, as an older WSL prints it.
        let said: Vec<u8> = "Windows Subsystem for Linux has no installed distributions.\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(
            error(wsl_targets(false, &said, b""))["message"],
            "Windows Subsystem for Linux has no installed distributions"
        );
        assert_eq!(error(wsl_targets(true, b"  NAME STATE VERSION\r\n", b""))["message"], "WSL listed no distributions.");
    }

    #[test]
    fn errors_are_a_code_and_a_message() {
        assert_eq!(
            serde_json::to_value(Error::new("unknownTarget", "Choose.")).unwrap(),
            json!({"code": "unknownTarget", "message": "Choose."})
        );
    }

    fn base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let word = chunk.iter().enumerate().fold(0u32, |word, (index, &byte)| word | (byte as u32) << (16 - 8 * index));
            for index in 0..4 {
                out.push(if index <= chunk.len() { ALPHABET[(word >> (18 - 6 * index) & 63) as usize] as char } else { '=' });
            }
        }
        out
    }

    fn report(extra: &str) -> Report {
        check_rules::parse(&format!(
            "format=1\nuser=someone\nuid=1000\nhome=/home/someone\nshell=/bin/bash\narch=x86_64\nglibc=2.39\ntools.missing=\nenv.source=login\n\
             root=/home/someone/.local/share/yuzuno-core\ndata=/home/someone/.local/share/yuzuno-core-data\ndata.state=absent\n\
             tool.node=v22.11.0\ntool.git=git version 2.43.0\ntool.gh=gh version 2.45.0\ntool.claude=2.1.3\ntool.codex=codex-cli 0.80.0\n\
             tool.python3=Python 3.12.3\ngh.auth=ok\nsystemd=running\ncgroup=cpu memory pids\n{extra}"
        ))
        .unwrap()
    }

    #[test]
    fn a_check_has_the_shared_shape() {
        let check = serde_json::to_value(build_check("main-distro", &report("root.state=absent\n"), Port::Free(4318))).unwrap();
        let keys: Vec<_> = check.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 8);
        for key in ["target", "platform", "user", "home", "checks", "installation", "defaults", "installable"] {
            assert!(keys.contains(&key.to_owned()), "{key}");
        }
        assert_eq!(check["target"], "main-distro");
        assert_eq!(check["platform"], "wsl");
        assert_eq!(check["user"], "someone");
        assert_eq!(check["home"], "/home/someone");
        assert_eq!(check["installation"], Value::Null);
        assert_eq!(
            check["defaults"],
            json!({"installDir": "/home/someone/.local/share/yuzuno-core", "dataDir": "/home/someone/.local/share/yuzuno-core-data", "port": 4318})
        );
        assert_eq!(check["installable"], true);
        assert_eq!(check["checks"][0], json!({"id": "wsl2", "level": "required", "state": "ok"}));
        assert_eq!(check["checks"][6], json!({"id": "port", "level": "required", "state": "ok", "detail": "4318"}));
        assert_eq!(check["checks"].as_array().unwrap().len(), 14);
    }

    #[test]
    fn an_installation_with_a_start_record() {
        let current = base64(br#"{"releaseId":"20261113-b870c92","manifestSha256":"00"}"#);
        let launch = base64(
            br#"{"port":4317,"dataDir":"/home/someone/.local/share/yuzuno-core-data","cwd":"/home/someone","codex":"","workspaceId":"ws-1","environment":{"PATH":"/usr/bin"},"recordedAt":"2026-11-13T00:00:00Z"}"#,
        );
        let check = serde_json::to_value(build_check(
            "main-distro",
            &report(&format!("root.state=installed\nroot.current={current}\nroot.launch={launch}\nroot.entry=yes\n")),
            Port::Free(4318),
        ))
        .unwrap();
        assert_eq!(
            check["installation"],
            json!({"installDir": "/home/someone/.local/share/yuzuno-core", "releaseId": "20261113-b870c92", "port": 4317, "workspaceId": "ws-1", "recorded": true})
        );
        assert_eq!(check["installable"], false);
        // Nothing of the recorded environment reaches the page.
        assert!(!check.to_string().contains("/usr/bin"));
    }

    #[test]
    fn an_installation_without_a_start_record() {
        let current = base64(br#"{"releaseId":"20261113-b870c92","manifestSha256":"00"}"#);
        let launch = base64(br#"{"port":4317,"workspaceId":"ws-1"}"#);
        for extra in [
            format!("root.state=installed\nroot.current={current}\nroot.launch=\nroot.entry=no\n"),
            // A record whose start entry is gone does not count.
            format!("root.state=installed\nroot.current={current}\nroot.launch={launch}\nroot.entry=no\n"),
        ] {
            let check = serde_json::to_value(build_check("main-distro", &report(&extra), Port::Free(4317))).unwrap();
            assert_eq!(
                check["installation"],
                json!({"installDir": "/home/someone/.local/share/yuzuno-core", "releaseId": "20261113-b870c92", "port": null, "workspaceId": null, "recorded": false})
            );
            assert_eq!(check["installable"], false);
        }
    }

    #[test]
    fn an_installation_this_app_cannot_read() {
        for current in [base64(b"{not json"), base64(br#"{"releaseId":"../x"}"#), String::new()] {
            let check = serde_json::to_value(build_check(
                "main-distro",
                &report(&format!("root.state=installed\nroot.current={current}\nroot.entry=no\n")),
                Port::Free(4317),
            ))
            .unwrap();
            assert_eq!(check["installation"], Value::Null);
            assert_eq!(check["installable"], false);
            assert_eq!(check["checks"][4]["id"], "paths");
            assert_eq!(check["checks"][4]["state"], "missing");
        }
    }

    /// This computer's own `wsl.exe --list --verbose`, read once (it starts
    /// and changes no distribution), when YUZUNO_DESKTOP_REAL_WSL is set: a
    /// Windows Job on a computer with WSL. Prints what the page would get.
    #[cfg(windows)]
    #[test]
    fn this_computers_wsl_list() {
        if std::env::var_os("YUZUNO_DESKTOP_REAL_WSL").is_none() {
            return;
        }
        let output = match wsl::list() {
            Ok(output) => output,
            Err(wsl::Failure::NoWsl) => panic!("no System32\\wsl.exe"),
            Err(wsl::Failure::Run(message)) => panic!("{message}"),
        };
        let targets = wsl_targets(output.success, &output.stdout, &output.stderr);
        println!("real wsl list: {}", serde_json::to_string(&targets).unwrap());
        assert!(targets.available, "{targets:?}");
        assert!(!targets.targets.is_empty());
        assert_eq!(targets.targets.iter().filter(|target| target.is_default).count(), 1);
    }

    #[test]
    fn no_free_port_is_shown_as_the_default_and_refused() {
        let check = serde_json::to_value(build_check("main-distro", &report("root.state=absent\n"), Port::NoneFree)).unwrap();
        assert_eq!(check["defaults"]["port"], 4317);
        assert_eq!(check["checks"][6]["state"], "missing");
        assert_eq!(check["installable"], false);
    }
}
