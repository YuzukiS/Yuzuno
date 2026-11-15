//! The connection page's local Core commands (YN-107 and YN-108 share their
//! interface: YN-107 design section 6). Only the embedded connection page
//! may call them: each is in `build.rs` and the `connection` capability and
//! first checks `require_connection_page`; a Workspace page has none.
//!
//! `local_core_targets` lists where this computer could install or start
//! Core, and `local_core_check` checks one of them read-only, with any
//! installation already there (YN-109). `local_core_install` downloads and
//! verifies the latest Core release (`release.rs`), installs it there and
//! starts it the first time; `local_core_start` starts the installation the
//! check found; both save it as a confirmed entry and open it.
//! `local_core_cancel` stops an installation until its release is unpacked.
//!
//! On Windows the target is a WSL 2 distribution (`wsl.rs`); the Mac app
//! answers `comingSoon` until YN-108 connects its own; elsewhere
//! `unsupported`.
//!
//! Errors are `{code, message}`; the codes: `notConnectionPage`,
//! `unsupported`, `unavailable`, `unknownTarget`, `busy`, `noWsl`,
//! `checkFailed`, `notChecked`, `checkChanged`, `notStarted`,
//! `peerChanged`, `noInstallation`, `invalidPath`, `invalidPort`,
//! `portInUse`, `notInstallable`, `network`, `rateLimited`,
//! `releaseNotFound`, `releaseInvalid`, `signature`, `cancelled`,
//! `copyFailed`, `tooOld`, `installFailed`, `recorded`, `startFailed`,
//! `starting`, `openFailed`.

pub mod auto_start;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod check_rules;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod guard_rules;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod release;
#[cfg(windows)]
pub mod wsl;
#[cfg_attr(not(windows), allow(dead_code))]
mod wsl_list;

use check_rules::{Found, Level, Port, Report, State};
#[cfg(windows)]
use crate::connection::{StartOutcome, StartProfile};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{ipc::Channel, WebviewWindow};
use tokio::sync::watch;

/// The read-only check, sent to WSL on stdin (design 4.3).
#[cfg_attr(not(windows), allow(dead_code))]
const CHECK_SCRIPT: &str = include_str!("check.sh");

/// Makes and removes an installation's temporary folder, sent to WSL on
/// stdin (design 4.5).
#[cfg_attr(not(windows), allow(dead_code))]
const STAGE_SCRIPT: &str = include_str!("stage.sh");

/// Looks read-only at the state WSL 2's distributions share, sent to WSL on
/// stdin (YN-156, guard.sh).
#[cfg_attr(not(windows), allow(dead_code))]
const GUARD_SCRIPT: &str = include_str!("guard.sh");

/// The Core release a WSL distribution runs.
#[cfg_attr(not(windows), allow(dead_code))]
const WSL_PLATFORM: &str = "linux-x86_64";

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
    /// Whether it runs now (`wsl --list --running --quiet`).
    running: bool,
    /// Rule R1 (check_rules::Boot): `own`, `running`, `alone` or `risky`.
    boot: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    boot_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// What the read-only check of one target found.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
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
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    install_dir: String,
    release_id: String,
    port: Option<u16>,
    workspace_id: Option<String>,
    recorded: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
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
/// check; whether a check is running; the latest check, which is what an
/// installation or a start goes by; and how to cancel the installation
/// under way while it still can be.
#[derive(Default)]
pub struct LocalCore {
    listed: Mutex<Vec<Target>>,
    checking: AtomicBool,
    checked: Mutex<Option<Check>>,
    cancel: Mutex<Option<watch::Sender<bool>>>,
    /// Where the latest installation from this window went, so a start of
    /// it before its first start uses the same folder and port.
    placed: Mutex<Option<(String, Place)>>,
}

fn unavailable() -> Error {
    Error::new("unavailable", "Local Core state unavailable.")
}

fn unsupported() -> Error {
    Error::new("unsupported", "This app cannot install Core on this computer yet.")
}

/// `target`, if the latest list showed it and it can be chosen.
fn listed_target(local: &LocalCore, target: &str) -> Result<Target, Error> {
    local
        .listed
        .lock()
        .map_err(|_| unavailable())?
        .iter()
        .find(|listed| listed.id == target && listed.selectable)
        .cloned()
        .ok_or_else(|| Error::new("unknownTarget", "Choose a distribution from the latest list."))
}

/// The latest check, if it was of `target`.
#[cfg_attr(not(windows), allow(dead_code))]
fn latest_check(local: &LocalCore, target: &str) -> Result<Check, Error> {
    local
        .checked
        .lock()
        .map_err(|_| unavailable())?
        .clone()
        .filter(|check| check.target == target)
        .ok_or_else(|| Error::new("notChecked", "Check this distribution first."))
}

#[tauri::command]
pub async fn local_core_targets(window: WebviewWindow, local: tauri::State<'_, LocalCore>) -> Result<Targets, Error> {
    require_connection_page(&window)?;
    let targets = platform_targets().await;
    *local.listed.lock().map_err(|_| unavailable())? = targets.targets.clone();
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
        return Err(unsupported());
    }
    let target = listed_target(&local, &target)?;
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
    let check = check_target(&window, &target).await?;
    *local.checked.lock().map_err(|_| unavailable())? = Some(check.clone());
    Ok(check)
}

#[cfg(windows)]
async fn platform_targets() -> Targets {
    match tauri::async_runtime::spawn_blocking(wsl::list).await {
        Ok(Ok(output)) => {
            // Reading the running names starts nothing (rule R1). If they
            // cannot be read, every stopped non-default distribution is
            // treated as risky.
            let running = running_names().await;
            wsl_targets(output.success, &output.stdout, &output.stderr, running.as_deref())
        }
        Ok(Err(wsl::Failure::NoWsl)) => Targets {
            platform: Some("wsl"),
            available: false,
            reason: Some("noWsl"),
            message: Some("WSL is not installed on this computer.".into()),
            targets: Vec::new(),
        },
        Ok(Err(wsl::Failure::Run(message))) => wsl_error(message),
        Ok(Err(wsl::Failure::Cancelled)) => wsl_error("Listing was stopped.".into()),
        Err(error) => wsl_error(error.to_string()),
    }
}

/// The distributions running now, or None when that could not be read.
#[cfg(windows)]
async fn running_names() -> Option<Vec<String>> {
    match tauri::async_runtime::spawn_blocking(wsl::running).await {
        Ok(Ok(output)) => Some(running_result(
            output.success,
            output.code,
            &wsl_list::decode(&output.stdout),
            &wsl_list::decode(&output.stderr),
        )?),
        _ => None,
    }
}

/// What `wsl --list --running --quiet` came to. WSL's own "no running
/// distributions" path prints the message and returns -1 when not quiet
/// (`WslClient.cpp`: `if ((!options.quiet) && distros.empty()) ... return -1;`);
/// with `--quiet` it prints nothing and returns 0. Either way, a "-1" or that
/// message is no running distribution, not a failure.
fn running_result(success: bool, code: Option<i32>, stdout: &str, stderr: &str) -> Option<Vec<String>> {
    if success {
        return Some(wsl_list::parse_running(stdout));
    }
    let said = format!("{stdout}\n{stderr}");
    let none = code == Some(-1)
        || said.lines().any(|line| line.trim().eq_ignore_ascii_case("There are no running distributions."));
    none.then(Vec::new)
}

/// `names` limited to the distributions `--list --verbose` knows. WSL may
/// print a "no running distributions" line instead of nothing; that is not a
/// distribution name, and treating it as one would invent a witness.
#[cfg_attr(not(windows), allow(dead_code))]
fn running_among(names: Vec<String>, known: &[String]) -> Vec<String> {
    names.into_iter().filter(|name| known.iter().any(|known| known == name)).collect()
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
/// passes to WSL. A failure shows WSL's own first line. `running` is the
/// names from `--list --running --quiet`, or None when they could not be
/// read (then a stopped distribution that is not the default is risky).
#[cfg_attr(not(windows), allow(dead_code))]
fn wsl_targets(success: bool, stdout: &[u8], stderr: &[u8], running: Option<&[String]>) -> Targets {
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
    // WSL may print a "no running distributions" message instead of nothing;
    // only names the verbose list knows are distributions.
    let known: Vec<String> = distros.iter().map(|distro| distro.name.clone()).collect();
    let running: Option<Vec<String>> = running.map(|names| running_among(names.to_vec(), &known));
    let running = running.as_deref();
    let default = distros.iter().find(|distro| distro.is_default).map(|distro| distro.name.clone());
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
            let is_running = running.is_some_and(|names| names.iter().any(|name| name == &distro.name));
            let peers_running = match running {
                Some(names) => names.iter().any(|name| name != &distro.name),
                // Unknown: treat it as another distribution running.
                None => true,
            };
            let boot = check_rules::boot(distro.is_default, is_running, peers_running);
            let boot_detail = (boot == check_rules::Boot::Risky).then(|| {
                let default = default.as_deref().map(|name| format!(" ({name})")).unwrap_or_default();
                if running.is_some() {
                    format!(
                        "It is stopped and another WSL distribution is running. Starting it could remove Windows interop from the running one and share its cgroups. Stop the other distributions, or install into the default distribution{default}."
                    )
                } else {
                    format!(
                        "WSL's running distributions could not be read, so this app does not start this stopped distribution. Stop the other distributions, or install into the default distribution{default}."
                    )
                }
            });
            Target {
                label: distro.name.clone(),
                id: distro.name,
                kind: "wsl",
                selectable: distro.version == 2 && named,
                is_default: distro.is_default,
                running: is_running,
                boot: boot.as_str(),
                boot_detail,
                note,
            }
        })
        .collect();
    Targets { platform: Some("wsl"), available: true, reason: None, message: None, targets }
}

#[cfg(windows)]
fn failure_text(failure: wsl::Failure) -> String {
    match failure {
        wsl::Failure::NoWsl => "WSL is not installed on this computer".into(),
        wsl::Failure::Run(message) => message,
        wsl::Failure::Cancelled => "reading it was stopped".into(),
    }
}

/// What rule R1 reads once: the default distribution and the ones running
/// now (YN-156). Reading the running names starts nothing.
#[cfg(windows)]
struct Situation {
    default: Option<String>,
    /// Every distribution `--list --verbose` listed.
    known: Vec<String>,
    /// None when `--list --running --quiet` could not be read; then a
    /// stopped distribution that is not the default is treated as risky.
    running: Option<Vec<String>>,
}

#[cfg(windows)]
impl Situation {
    async fn read() -> Result<Self, Error> {
        let output = tauri::async_runtime::spawn_blocking(wsl::list)
            .await
            .map_err(|error| Error::new("checkFailed", error.to_string()))?
            .map_err(|failure| Error::new("checkFailed", failure_text(failure)))?;
        if !output.success {
            let said = wsl_list::first_line(&wsl_list::decode(&output.stderr))
                .or_else(|| wsl_list::first_line(&wsl_list::decode(&output.stdout)))
                .unwrap_or_else(|| "WSL could not list its distributions.".into());
            return Err(Error::new("checkFailed", said));
        }
        let distros = wsl_list::parse(&wsl_list::decode(&output.stdout));
        let known: Vec<String> = distros.iter().map(|distro| distro.name.clone()).collect();
        let default = distros.iter().find(|distro| distro.is_default).map(|distro| distro.name.clone());
        let running = running_names().await.map(|names| running_among(names, &known));
        Ok(Self { default, known, running })
    }

    fn is_running(&self, distro: &str) -> bool {
        self.running.as_ref().is_some_and(|names| names.iter().any(|name| name == distro))
    }

    fn is_default(&self, distro: &str) -> bool {
        self.default.as_deref() == Some(distro)
    }

    /// Rule R1: a stopped distribution may not be started when it is not the
    /// default one and another distribution runs (or that cannot be read).
    /// A distribution that already runs is not started again by this.
    fn may_start(&self, distro: &str) -> Result<(), Error> {
        let peers: Option<Vec<String>> = self.running.as_ref().map(|running| {
            running.iter().filter(|name| name.as_str() != distro).cloned().collect()
        });
        let peers_running = peers.as_ref().map_or(true, |peers| !peers.is_empty());
        if check_rules::boot(self.is_default(distro), self.is_running(distro), peers_running).can_start() {
            Ok(())
        } else {
            Err(not_started(distro, peers.as_deref(), self.default.as_deref()))
        }
    }

    /// A running distribution other than the target to look from, preferring
    /// the default one.
    fn witness(&self, target: &str) -> Option<String> {
        let running = self.running.as_ref()?;
        running
            .iter()
            .find(|name| name.as_str() != target && self.default.as_deref() == Some(name.as_str()))
            .or_else(|| running.iter().find(|name| name.as_str() != target))
            .cloned()
    }
}

#[cfg(windows)]
fn not_started(distro: &str, peers: Option<&[String]>, default: Option<&str>) -> Error {
    let who = match peers {
        Some(peers) if !peers.is_empty() => format!("and {} is running", peers.join(", ")),
        _ => "and other WSL distributions may be running".into(),
    };
    let default = default.map(|name| format!(" ({name})")).unwrap_or_default();
    Error::new(
        "notStarted",
        format!(
            "WSL did not start {distro}: it is stopped, it is not the default distribution, {who}. Starting it could remove Windows interop from the running distribution and share its cgroups. Stop the other distributions, or install into the default distribution{default}."
        ),
    )
}

/// The read-only witness for the distributions' shared state (YN-156 rule
/// G): one look before the first command into the target and one after each
/// command, in a distribution that is already running. A change stops the
/// work; nothing is put back by this app.
#[cfg(windows)]
struct Guard {
    target: String,
    known: Vec<String>,
    witness: Option<String>,
    baseline: Option<guard_rules::Snapshot>,
}

#[cfg(windows)]
impl Guard {
    async fn open(situation: &Situation, target: &str) -> Result<Self, Error> {
        let witness = situation.witness(target);
        let baseline = match &witness {
            Some(witness) => Some(snapshot(witness).await?),
            None => None,
        };
        Ok(Self { target: target.to_owned(), known: situation.known.clone(), witness, baseline })
    }

    async fn after(&mut self) -> Result<(), Error> {
        let running = running_names().await.map(|names| running_among(names, &self.known));
        let Some(running) = running else {
            return Err(Error::new(
                "peerChanged",
                format!(
                    "The shared state could not be checked: WSL's running distributions could not be read. Nothing further was run in {}.",
                    self.target
                ),
            ));
        };
        let still_running = self.witness.as_ref().is_some_and(|witness| running.iter().any(|name| name == witness));
        if self.witness.is_none() {
            // A distribution started to run meanwhile: look from it from the
            // next command on. Nothing was compared with it before.
            let Some(witness) = running.into_iter().find(|name| name.as_str() != self.target.as_str()) else { return Ok(()) };
            self.baseline = Some(snapshot(&witness).await?);
            self.witness = Some(witness);
            return Ok(());
        }
        if !still_running {
            let witness = self.witness.as_deref().unwrap_or_default();
            return Err(Error::new(
                "peerChanged",
                format!(
                    "The shared state could not be checked: {witness} stopped while this app was working on {target}. Nothing further was run in {target}. Check Windows interop and the cgroups yourself; this app changes neither.",
                    target = self.target
                ),
            ));
        }
        let witness = self.witness.clone().unwrap_or_default();
        let after = snapshot(&witness).await?;
        if let Some(before) = &self.baseline {
            let changes = guard_rules::changes(before, &after);
            if !changes.is_empty() {
                return Err(Error::new("peerChanged", guard_rules::message(&witness, &self.target, &changes)));
            }
        }
        self.baseline = Some(after);
        Ok(())
    }
}

/// One look at what `witness` can see of the shared state.
#[cfg(windows)]
async fn snapshot(witness: &str) -> Result<guard_rules::Snapshot, Error> {
    let name = witness.to_owned();
    let output = tauri::async_runtime::spawn_blocking(move || wsl::guard(&name, GUARD_SCRIPT))
        .await
        .map_err(|error| Error::new("peerChanged", format!("The shared state could not be checked: {error}.")))?
        .map_err(|failure| Error::new("peerChanged", format!("The shared state could not be checked in {witness}: {}.", failure_text(failure))))?;
    if !output.success {
        let said = wsl_list::first_line(&wsl_list::decode(&output.stderr))
            .or_else(|| wsl_list::first_line(&String::from_utf8_lossy(&output.stdout)))
            .unwrap_or_else(|| "the guard printed nothing".into());
        return Err(Error::new(
            "peerChanged",
            format!("The shared state could not be checked in {witness}: {said}. Nothing further was run in the target distribution."),
        ));
    }
    guard_rules::parse(&String::from_utf8_lossy(&output.stdout)).map_err(|said| {
        Error::new(
            "peerChanged",
            format!("The shared state could not be checked in {witness}: {said} Nothing further was run in the target distribution."),
        )
    })
}

/// Runs `work` (one command into the target) between two looks; a change the
/// witness saw is the error, whether it is seen before the command or after
/// it, whatever `work` came to.
#[cfg(windows)]
async fn guarded<T, F>(guard: &mut Guard, work: F) -> Result<T, Error>
where
    F: std::future::Future<Output = Result<T, Error>>,
{
    guard.after().await?;
    let result = work.await;
    guard.after().await?;
    result
}

#[cfg(windows)]
async fn check_target(window: &WebviewWindow, target: &Target) -> Result<Check, Error> {
    let situation = Situation::read().await?;
    situation.may_start(&target.id)?;
    let mut guard = Guard::open(&situation, &target.id).await?;
    let report = guarded(&mut guard, run_check(target, "default", "default")).await?;
    let port = free_port(window).await;
    Ok(build_check(&target.id, &report, port, situation.is_default(&target.id)))
}

/// Runs the read-only check in `target` for these folders (`default`, or
/// paths that passed `check_rules::linux_path_ok`).
#[cfg(windows)]
async fn run_check(target: &Target, install: &str, data: &str) -> Result<Report, Error> {
    let (distro, install_arg, data_arg) = (target.id.clone(), install.to_owned(), data.to_owned());
    let output = tauri::async_runtime::spawn_blocking(move || wsl::check(&distro, CHECK_SCRIPT, &install_arg, &data_arg))
        .await
        .map_err(|error| Error::new("checkFailed", error.to_string()))?
        .map_err(|failure| match failure {
            wsl::Failure::NoWsl => Error::new("noWsl", "WSL is not installed on this computer."),
            wsl::Failure::Run(message) => Error::new("checkFailed", message),
            wsl::Failure::Cancelled => Error::new("checkFailed", "The check was stopped."),
        })?;
    let text = String::from_utf8_lossy(&output.stdout);
    check_rules::parse(&text).ok().filter(|_| output.success).ok_or_else(|| {
        let said = wsl_list::first_line(&wsl_list::decode(&output.stderr))
            .or_else(|| wsl_list::first_line(&text))
            .unwrap_or_else(|| "no output".into());
        Error::new("checkFailed", format!("The check could not run in {}: {said}.", target.id))
    })
}

#[cfg(not(windows))]
async fn check_target(_: &WebviewWindow, _: &Target) -> Result<Check, Error> {
    Err(Error::new("unsupported", "This app cannot install Core on this computer yet."))
}

/// The loopback ports a saved workspace or remembered address is on.
#[cfg(windows)]
fn bound_ports(window: &WebviewWindow) -> Result<Vec<u16>, String> {
    use tauri::Manager;
    let saved = crate::read_entries(window.app_handle());
    if let Some(reason) = crate::entries::unusable(&saved) {
        return Err(format!("The workspaces saved on this computer could not be read ({reason})."));
    }
    Ok(saved
        .entries()
        .iter()
        .map(|entry| &entry.url)
        .chain(saved.remembered().iter().map(|known| &known.url))
        .filter(|url| crate::connection::is_loopback(url))
        .filter_map(|url| url.port_or_known_default())
        .collect())
}

/// Something on Windows' loopback answers at `port`. A connection is
/// accepted at once when something listens; Windows takes about 2 s to
/// refuse one, so a short wait is enough.
#[cfg(windows)]
fn answering(port: u16) -> bool {
    use std::{
        net::{Ipv4Addr, SocketAddr, TcpStream},
        time::Duration,
    };
    TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(500)).is_ok()
}

/// The first port of [`check_rules::PORTS`] that no saved workspace or
/// remembered address is on and nothing on Windows' loopback answers at
/// (design 4.7). Windows also reaches a Core in WSL there, and a program
/// that holds the port on Windows would keep WSL's forwarding from it.
#[cfg(windows)]
async fn free_port(window: &WebviewWindow) -> Port {
    let bound = match bound_ports(window) {
        Ok(bound) => bound,
        Err(why) => return Port::Unknown(why),
    };
    let candidates: Vec<u16> = check_rules::PORTS.filter(|port| !bound.contains(port)).collect();
    match tauri::async_runtime::spawn_blocking(move || candidates.into_iter().find(|&port| !answering(port))).await {
        Ok(Some(port)) => Port::Free(port),
        Ok(None) => Port::NoneFree,
        Err(error) => Port::Unknown(error.to_string()),
    }
}

/// `port` is one a new Core can take: no saved workspace or remembered
/// address is on it and nothing answers there (design 4.7).
#[cfg(windows)]
async fn port_free(window: &WebviewWindow, port: u16) -> Result<(), Error> {
    if bound_ports(window).map_err(|why| Error::new("portInUse", why))?.contains(&port) {
        return Err(Error::new("portInUse", format!("Port {port} is saved here for another workspace. Choose another port.")));
    }
    if tauri::async_runtime::spawn_blocking(move || answering(port)).await.unwrap_or(true) {
        return Err(Error::new("portInUse", format!("Something on this computer already answers on port {port}. Choose another port.")));
    }
    Ok(())
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
fn build_check(target: &str, report: &Report, port: Port, is_default: bool) -> Check {
    let (installation, found) = installation(report);
    let items = check_rules::judge(report, true, &port, found, is_default);
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

/// One step of an installation, as the connection page shows it (design
/// section 6, part 2). Sent through a Tauri channel: the page needs no
/// event permission for it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Progress {
    fn phase(phase: &'static str) -> Self {
        Self { phase, done: None, total: None, detail: None }
    }

    fn bytes(phase: &'static str, done: u64, total: u64) -> Self {
        Self { done: Some(done), total: Some(total), ..Self::phase(phase) }
    }
}

/// How long each step in WSL may take (design 4.5); a first start's wait is
/// `wsl::START_WAIT`.
#[cfg_attr(not(windows), allow(dead_code))]
mod waits {
    use std::time::Duration;
    pub const STAGE: Duration = Duration::from_secs(30);
    pub const UNPACK: Duration = Duration::from_secs(10 * 60);
    pub const INSTALL: Duration = Duration::from_secs(5 * 60);
}

/// Where an installation goes: an install folder and a Workspace folder
/// that passed this platform's path rules, apart from each other, and a
/// port for its Core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    install_dir: String,
    data_dir: String,
    port: u16,
}

/// The folders and port the page asked for (design section 6, part 2): the
/// check's defaults, or folders that pass the WSL path rules, `~/` read as
/// the checked account's home; apart from each other; a port from 1024.
#[cfg_attr(not(windows), allow(dead_code))]
fn choose_place(check: &Check, install_dir: &str, data_dir: &str, port: u16) -> Result<Place, Error> {
    let expand = |path: &str| match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{rest}", check.home),
        None => path.to_owned(),
    };
    let (install_dir, data_dir) = (expand(install_dir), expand(data_dir));
    for (what, path) in [("install", &install_dir), ("data", &data_dir)] {
        if !check_rules::linux_path_ok(path) {
            return Err(Error::new(
                "invalidPath",
                format!("The {what} folder {path:?} is not one this app passes to WSL: an absolute Linux path outside /mnt, with letters, digits and ._-+@ only."),
            ));
        }
    }
    if check_rules::same_or_nested(&install_dir, &data_dir) {
        return Err(Error::new("invalidPath", "The install and data folders must be apart, neither inside the other."));
    }
    if port < 1024 {
        return Err(Error::new("invalidPort", "Choose a port from 1024 to 65535."));
    }
    Ok(Place { install_dir, data_dir, port })
}

/// The arguments to `wsl.exe` for each step of an installation (design
/// 4.5): `--distribution <D> --user <U> --exec` and a fixed program. Each
/// value from the user, the check or the release is checked here once more
/// and is one argument of its own: none is ever written into a script or a
/// command line that WSL would read.
#[cfg_attr(not(windows), allow(dead_code))]
struct Steps {
    distro: String,
    user: String,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Steps {
    fn new(distro: &str, user: &str) -> Result<Self, Error> {
        if !check_rules::distro_name_ok(distro) || !check_rules::user_name_ok(user) || user == "root" {
            return Err(Error::new("checkChanged", "The distribution or its account is not one this app installs for. Check it again."));
        }
        Ok(Self { distro: distro.into(), user: user.into() })
    }

    fn command(&self, program: String, arguments: &[&str]) -> Vec<String> {
        let mut command: Vec<String> = ["--distribution", &self.distro, "--user", &self.user, "--exec"].map(str::to_owned).to_vec();
        command.push(program);
        command.extend(arguments.iter().map(|argument| (*argument).to_owned()));
        command
    }

    fn path(path: &str) -> Result<&str, Error> {
        if check_rules::linux_path_ok(path) {
            Ok(path)
        } else {
            Err(Error::new("invalidPath", format!("{path:?} is not a path this app passes to WSL.")))
        }
    }

    /// `stage.sh`, on stdin: `prepare <install folder>` or `clean <stage>`.
    fn stage(&self, step: &'static str, folder: &str) -> Result<Vec<String>, Error> {
        Ok(self.command("/bin/sh".into(), &["-s", "--", step, Self::path(folder)?]))
    }

    /// Unpacks the release from stdin into `<stage>/bundle`. `env` finds
    /// `tar` on the same PATH the check found it on.
    fn unpack(&self, stage: &str) -> Result<Vec<String>, Error> {
        let bundle = format!("{}/bundle", Self::path(stage)?);
        Ok(self.command("/usr/bin/env".into(), &["tar", "-xzf", "-", "-C", &bundle]))
    }

    /// The unpacked release's own helper installs it (core/src/updates/setup.rs).
    fn install(&self, stage: &str, root: &str, verified: &release::Verified, key: &str) -> Result<Vec<String>, Error> {
        let bundle = format!("{}/bundle", Self::path(stage)?);
        let sha = &verified.manifest_sha256;
        let sha_ok = sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit());
        if !sha_ok || !release::tag_ok(&verified.tag) || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte)) {
            return Err(Error::new("releaseInvalid", "The release's checksum, tag or key is not one this app passes on."));
        }
        let helper = format!("{bundle}/bin/yuzuno-update-helper");
        Ok(self.command(
            helper,
            &[
                "install",
                "--install-dir",
                Self::path(root)?,
                "--bundle",
                &bundle,
                "--manifest-sha256",
                sha,
                "--reviewed-source",
                &verified.tag,
                "--repository",
                release::REPOSITORY,
                "--public-key",
                key,
            ],
        ))
    }

    /// The installed release's helper starts its Core the first time, in
    /// the account's home folder.
    fn first_start(&self, root: &str, release_id: &str, place: &Place, home: &str) -> Result<Vec<String>, Error> {
        if !check_rules::release_id_ok(release_id) {
            return Err(Error::new("installFailed", "The installed release has an identifier this app does not pass on."));
        }
        let helper = format!("{}/releases/{release_id}/bin/yuzuno-update-helper", Self::path(root)?);
        let port = place.port.to_string();
        Ok(self.command(
            helper,
            &["first-start", "--install-dir", root, "--port", &port, "--data-dir", Self::path(&place.data_dir)?, "--cwd", Self::path(home)?],
        ))
    }
}

/// The temporary folder `stage.sh prepare` made for `root`: in its parent,
/// named as the script names one.
#[cfg_attr(not(windows), allow(dead_code))]
fn stage_from(stdout: &str, root: &str) -> Option<String> {
    let stage = stdout.lines().find_map(|line| line.trim_end_matches('\r').strip_prefix("stage="))?;
    let (parent, name) = stage.rsplit_once('/')?;
    let suffix = name.strip_prefix(".yuzuno-core-install.")?;
    let ok = root.rsplit_once('/').is_some_and(|(root_parent, _)| root_parent == parent)
        && suffix.len() == 8
        && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && check_rules::linux_path_ok(stage);
    ok.then(|| stage.to_owned())
}

/// What a step said went wrong: `stage.sh`'s `error=`, else the first line
/// of its error output or output, without WSL's log level.
#[cfg_attr(not(windows), allow(dead_code))]
fn said(stdout: &str, stderr: &str) -> String {
    if let Some(error) = stdout.lines().find_map(|line| line.strip_prefix("error=")) {
        return error.trim_end_matches('\r').to_owned();
    }
    let line = stderr.lines().chain(stdout.lines()).map(str::trim).find(|line| !line.is_empty()).unwrap_or("no output");
    let line = line
        .strip_prefix('<')
        .and_then(|rest| rest.split_once('>'))
        .filter(|(level, _)| !level.is_empty() && level.bytes().all(|byte| byte.is_ascii_digit()))
        .map_or(line, |(_, rest)| rest.trim());
    line.chars().take(300).collect()
}

/// The last line of `stdout` that is a helper's one-line JSON result.
#[cfg_attr(not(windows), allow(dead_code))]
fn result_line(stdout: &str) -> Option<serde_json::Value> {
    stdout.lines().rev().find_map(crate::connection::start_result_line)
}

/// What `install` installed: the release and its installation folder as
/// Core resolved it.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Installed {
    release_id: String,
    install_dir: String,
}

/// Reads `yuzuno-update-helper install`'s result (core/src/updates/setup.rs).
#[cfg_attr(not(windows), allow(dead_code))]
fn installed(code: Option<i32>, stdout: &str, stderr: &str) -> Result<Installed, Error> {
    let Some(result) = result_line(stdout) else {
        if code == Some(2) {
            return Err(Error::new(
                "tooOld",
                "The latest Core release cannot be installed from the app yet: its update helper has no install command. Nothing was installed.",
            ));
        }
        return Err(Error::new("installFailed", format!("Installing failed: {}.", said(stdout, stderr))));
    };
    let message = result["message"].as_str().unwrap_or("").trim();
    match result["state"].as_str() {
        Some("installed") => {
            let release_id = result["releaseId"].as_str().filter(|id| check_rules::release_id_ok(id));
            let install_dir = result["installDir"].as_str().filter(|dir| check_rules::linux_path_ok(dir));
            match (release_id, install_dir) {
                (Some(release_id), Some(install_dir)) => Ok(Installed { release_id: release_id.into(), install_dir: install_dir.into() }),
                _ => Err(Error::new("installFailed", "Core was installed, but its result is not one this app reads.")),
            }
        }
        _ => {
            let mut text = if message.is_empty() { "Installing failed.".to_owned() } else { message.to_owned() };
            if result["cleaned"] == true {
                text.push_str(" The installation folder it had made was removed.");
            }
            Err(Error::new("installFailed", text))
        }
    }
}

/// A first start that answered: the Workspace its Core opened and the
/// installation folder as Core resolved it.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Started {
    workspace_id: String,
    install_dir: String,
    /// When Core could not get the login shell's environment.
    note: Option<String>,
}

/// Reads `yuzuno-update-helper first-start`'s result line for `port`.
#[cfg_attr(not(windows), allow(dead_code))]
fn first_started(result: &serde_json::Value, port: u16) -> Result<Started, Error> {
    let message = result["message"].as_str().unwrap_or("").trim();
    match (result["state"].as_str(), result["code"].as_str()) {
        (Some("started"), _) => {
            let workspace = result["workspaceId"].as_str().filter(|id| check_rules::workspace_id_ok(id));
            let install_dir = result["installDir"].as_str().filter(|dir| check_rules::linux_path_ok(dir));
            let (Some(workspace), Some(install_dir), true) = (workspace, install_dir, result["port"] == port) else {
                return Err(Error::new("startFailed", "Core started, but what it said about itself is not something this app saves."));
            };
            let note = (result["environment"] != "loginShell").then(|| {
                format!(
                    "Core could not read your login shell's environment ({}), so Agents may not find tools your shell profile sets up, such as nvm's node.",
                    result["environmentNote"].as_str().unwrap_or("unknown")
                )
            });
            Ok(Started { workspace_id: workspace.into(), install_dir: install_dir.into(), note })
        }
        (Some("starting"), _) => Err(Error::new(
            "starting",
            "Core started but has not answered within two minutes. Use Start in a moment; nothing was stopped.",
        )),
        (Some("refused"), Some("recorded")) => Err(Error::new("recorded", "This installation has started before. Check the distribution again and use Start.")),
        (Some("failed"), Some("exited")) => {
            let log = result["log"].as_str().unwrap_or("");
            let last = log.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
            Err(Error::new("startFailed", format!("Core stopped while starting. {}", last.chars().take(300).collect::<String>()).trim_end().to_owned()))
        }
        _ => Err(Error::new("startFailed", if message.is_empty() { "Core could not be started.".to_owned() } else { message.to_owned() })),
    }
}

/// A first start that printed no result: an update helper too old to have
/// `first-start` exits with 2 (an unknown command).
#[cfg_attr(not(windows), allow(dead_code))]
fn first_start_ended(output: &str, code: Option<i32>) -> Error {
    if code == Some(2) {
        return Error::new(
            "tooOld",
            "This installation's release cannot be started from the app before its first start. Start it once in WSL (docs/independent-core.md), or update it.",
        );
    }
    Error::new("startFailed", format!("Core could not be started: {}.", said(output, "")))
}

/// Core cannot be installed there, and why: each required item not ok.
#[cfg_attr(not(windows), allow(dead_code))]
fn not_installable(check: &Check) -> Error {
    let reasons: Vec<String> = check
        .checks
        .iter()
        .filter(|item| item.level == "required" && item.state != "ok")
        .map(|item| match &item.detail {
            Some(detail) => format!("{}: {detail}", item.id),
            None => format!("{}: {}", item.id, item.state),
        })
        .collect();
    let mut message = String::from("Core cannot be installed there");
    if check.installation.is_some() {
        message.push_str(": an installation is there already");
    }
    if !reasons.is_empty() {
        message.push_str(&format!(" ({})", reasons.join("; ")));
    }
    message.push('.');
    Error::new("notInstallable", message)
}

/// Says what became of the temporary folder after `error`.
#[cfg_attr(not(windows), allow(dead_code))]
fn cleaned_up(mut error: Error, left: Option<String>) -> Error {
    match left {
        None => error.message.push_str(" The temporary folder was removed."),
        Some(left) => {
            error.message.push(' ');
            error.message.push_str(&left);
        }
    }
    error
}

fn busy() -> Error {
    Error::new("busy", "Core is already being installed or started.")
}

/// Lets `local_core_cancel` stop the installation under way until it is
/// dropped or [`Cancellable::end`]s.
#[cfg_attr(not(windows), allow(dead_code))]
struct Cancellable<'a> {
    local: &'a LocalCore,
    receiver: watch::Receiver<bool>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl<'a> Cancellable<'a> {
    fn open(local: &'a LocalCore) -> Result<Self, Error> {
        let (sender, receiver) = watch::channel(false);
        *local.cancel.lock().map_err(|_| unavailable())? = Some(sender);
        Ok(Self { local, receiver })
    }

    fn check(&self) -> Result<(), Error> {
        if *self.receiver.borrow() {
            return Err(release::cancelled());
        }
        Ok(())
    }

    fn end(&self) {
        if let Ok(mut cancel) = self.local.cancel.lock() {
            *cancel = None;
        }
    }
}

impl Drop for Cancellable<'_> {
    fn drop(&mut self) {
        self.end();
    }
}

/// Downloads and verifies the latest Core release, installs it in the
/// target at the folders and port given, starts it the first time, saves it
/// as a confirmed entry and opens it (design 4.4–4.6). Progress goes to
/// `on_progress`; `local_core_cancel` stops it until the release is
/// unpacked.
#[tauri::command]
pub async fn local_core_install(
    window: WebviewWindow,
    local: tauri::State<'_, LocalCore>,
    target: String,
    install_dir: String,
    data_dir: String,
    port: u16,
    on_progress: Channel<Progress>,
) -> Result<String, Error> {
    require_connection_page(&window)?;
    if !cfg!(windows) {
        return Err(unsupported());
    }
    let target = listed_target(&local, &target)?;
    let checked = latest_check(&local, &target.id)?;
    let place = choose_place(&checked, &install_dir, &data_dir, port)?;
    let _starting = crate::Starting::take(&window).ok_or_else(busy)?;
    install(&window, &local, &target, &checked, place, &on_progress).await
}

/// Starts the installation the latest check of the target found: as its
/// start record says, or, when it never started, its first start. Saves it
/// as a confirmed entry and opens it (design 4.6).
#[tauri::command]
pub async fn local_core_start(window: WebviewWindow, local: tauri::State<'_, LocalCore>, target: String) -> Result<String, Error> {
    require_connection_page(&window)?;
    if !cfg!(windows) {
        return Err(unsupported());
    }
    let target = listed_target(&local, &target)?;
    let checked = latest_check(&local, &target.id)?;
    let installation = checked
        .installation
        .clone()
        .ok_or_else(|| Error::new("noInstallation", "The latest check found no installation in this distribution to start."))?;
    let _starting = crate::Starting::take(&window).ok_or_else(busy)?;
    start_found(&window, &local, &target, &checked, &installation).await
}

/// Stops the installation under way, until its release is unpacked;
/// otherwise nothing.
#[tauri::command]
pub fn local_core_cancel(window: WebviewWindow, local: tauri::State<'_, LocalCore>) -> Result<(), Error> {
    require_connection_page(&window)?;
    if let Some(cancel) = local.cancel.lock().map_err(|_| unavailable())?.as_ref() {
        cancel.send_replace(true);
    }
    Ok(())
}

#[cfg(not(windows))]
async fn install(_: &WebviewWindow, _: &LocalCore, _: &Target, _: &Check, _: Place, _: &Channel<Progress>) -> Result<String, Error> {
    Err(unsupported())
}

#[cfg(not(windows))]
async fn start_found(_: &WebviewWindow, _: &LocalCore, _: &Target, _: &Check, _: &Installation) -> Result<String, Error> {
    Err(unsupported())
}

/// Runs `work` (a `wsl.exe` call) off the async runtime; its failure to run
/// becomes `code`.
#[cfg(windows)]
async fn blocking<T: Send + 'static>(
    code: &'static str,
    work: impl FnOnce() -> Result<T, wsl::Failure> + Send + 'static,
) -> Result<T, Error> {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(wsl::Failure::NoWsl)) => Err(Error::new("noWsl", "WSL is not installed on this computer.")),
        Ok(Err(wsl::Failure::Run(message))) => Err(Error::new(code, message)),
        Ok(Err(wsl::Failure::Cancelled)) => Err(release::cancelled()),
        Err(error) => Err(Error::new(code, error.to_string())),
    }
}

#[cfg(windows)]
fn refs(arguments: &[String]) -> Vec<&str> {
    arguments.iter().map(String::as_str).collect()
}

#[cfg(windows)]
async fn install(
    window: &WebviewWindow,
    local: &LocalCore,
    target: &Target,
    checked: &Check,
    place: Place,
    progress: &Channel<Progress>,
) -> Result<String, Error> {
    let send = |update: Progress| {
        let _ = progress.send(update);
    };
    let cancel = Cancellable::open(local)?;
    let mut receiver = cancel.receiver.clone();

    // Rule R1, then the witness for the shared state (rule G): every command
    // into the target is compared with one look before it.
    let situation = Situation::read().await?;
    situation.may_start(&target.id)?;
    let mut guard = Guard::open(&situation, &target.id).await?;

    // The folders and port as they are now: the same check, for these.
    port_free(window, place.port).await?;
    let report = guarded(&mut guard, run_check(target, &place.install_dir, &place.data_dir)).await?;
    let now = build_check(&target.id, &report, Port::Free(place.port), situation.is_default(&target.id));
    if now.user != checked.user || now.home != checked.home {
        return Err(Error::new("checkChanged", "The distribution's account changed since it was checked. Check it again."));
    }
    if !now.installable {
        return Err(not_installable(&now));
    }
    let steps = Steps::new(&target.id, &now.user)?;
    cancel.check()?;

    // The release: found, its descriptor verified, its archive downloaded
    // into memory and checked against it. Nothing is written yet.
    send(Progress::phase("release"));
    let client = release::Client::new()?;
    let found = release::choose(&client.releases(&mut receiver).await?, WSL_PLATFORM)?;
    send(Progress { detail: Some(found.tag.clone()), ..Progress::phase("release") });
    let descriptor = client.download(&found.descriptor, release::SMALL_WAIT, &mut receiver, &mut |_| {}).await?;
    let signature = client.download(&found.signature, release::SMALL_WAIT, &mut receiver, &mut |_| {}).await?;
    let signature = String::from_utf8(signature).map_err(|_| Error::new("signature", "The release signature cannot be read."))?;
    let verified = release::verify_descriptor(release::public_key(), &descriptor, &signature, WSL_PLATFORM, &found.tag, found.archive.size)?;
    let total = found.archive.size;
    send(Progress::bytes("download", 0, total));
    let mut told = 0;
    let archive = client
        .download(&found.archive, release::ARCHIVE_WAIT, &mut receiver, &mut |done| {
            if done - told >= 1 << 20 || done == total {
                told = done;
                send(Progress::bytes("download", done, total));
            }
        })
        .await?;
    send(Progress::phase("verify"));
    release::verify_archive(&verified, &archive)?;
    cancel.check()?;

    // Into the distribution: only these verified bytes, on tar's stdin.
    send(Progress::bytes("copy", 0, total));
    // Looking before `prepare` creates nothing yet; if the look after it
    // fails, the folder it made is removed like any other failed step.
    guard.after().await?;
    let prepared = prepare(&steps, &place.install_dir).await;
    if let Err(error) = guard.after().await {
        return match prepared {
            Ok(stage) => Err(cleaned_up(error, clean(&steps, &stage).await)),
            Err(_) => Err(error),
        };
    }
    let stage = prepared?;
    let unpacked = guarded(&mut guard, unpack(&steps, &stage, archive, &cancel, progress.clone(), total)).await;
    cancel.end();
    if let Err(error) = unpacked {
        return Err(cleaned_up(error, clean(&steps, &stage).await));
    }
    send(Progress::phase("register"));
    let installed = guarded(&mut guard, register(&steps, &stage, &place.install_dir, &verified)).await;
    let left = clean(&steps, &stage).await;
    // The temporary folder is removed by the same step; look once more after.
    guard.after().await?;
    let installed = installed.map_err(|error| cleaned_up(error, left))?;
    let place = Place { install_dir: installed.install_dir.clone(), ..place };
    if let Ok(mut placed) = local.placed.lock() {
        *placed = Some((target.id.clone(), place.clone()));
    }

    send(Progress::phase("start"));
    let started = guarded(&mut guard, first_start(&steps, &installed.install_dir, &installed.release_id, &place, &now.home)).await?;
    send(Progress { detail: started.note.clone(), ..Progress::phase("open") });
    open(window, target, &now.user, place.port, &started).await
}

/// Makes the temporary folder next to the install folder.
#[cfg(windows)]
async fn prepare(steps: &Steps, root: &str) -> Result<String, Error> {
    let arguments = steps.stage("prepare", root)?;
    let output = blocking("copyFailed", move || wsl::run(&refs(&arguments), STAGE_SCRIPT.as_bytes(), waits::STAGE, 64 * 1024)).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    match stage_from(&stdout, root) {
        Some(stage) if output.success => Ok(stage),
        _ => Err(Error::new(
            "copyFailed",
            format!("Could not make a temporary folder for the release: {}.", said(&stdout, &String::from_utf8_lossy(&output.stderr))),
        )),
    }
}

/// Unpacks the verified archive into the temporary folder from tar's stdin.
#[cfg(windows)]
async fn unpack(steps: &Steps, stage: &str, archive: Vec<u8>, cancel: &Cancellable<'_>, progress: Channel<Progress>, total: u64) -> Result<(), Error> {
    use std::sync::Arc;
    let arguments = steps.unpack(stage)?;
    let receiver = cancel.receiver.clone();
    let output = blocking("copyFailed", move || {
        let mut told = 0;
        wsl::run_with(&refs(&arguments), Some(Arc::new(archive)), waits::UNPACK, 64 * 1024, &|| *receiver.borrow(), &mut |done| {
            if done - told >= 1 << 20 || done == total {
                told = done;
                let _ = progress.send(Progress::bytes("copy", done, total));
            }
        })
    })
    .await?;
    if !output.success {
        return Err(Error::new(
            "copyFailed",
            format!("Unpacking the release failed: {}.", said(&String::from_utf8_lossy(&output.stdout), &String::from_utf8_lossy(&output.stderr))),
        ));
    }
    Ok(())
}

/// Removes the temporary folder. `None` once it is gone; else where it is
/// and why it stayed.
#[cfg(windows)]
async fn clean(steps: &Steps, stage: &str) -> Option<String> {
    let left = |why: String| Some(format!("The temporary folder {stage} could not be removed ({why}); you can delete it."));
    let arguments = match steps.stage("clean", stage) {
        Ok(arguments) => arguments,
        Err(error) => return left(error.message),
    };
    match blocking("copyFailed", move || wsl::run(&refs(&arguments), STAGE_SCRIPT.as_bytes(), waits::STAGE, 64 * 1024)).await {
        Ok(output) if output.success && String::from_utf8_lossy(&output.stdout).lines().any(|line| line.starts_with("removed=")) => None,
        Ok(output) => left(said(&String::from_utf8_lossy(&output.stdout), &String::from_utf8_lossy(&output.stderr))),
        Err(error) => left(error.message),
    }
}

/// The unpacked release's helper installs it.
#[cfg(windows)]
async fn register(steps: &Steps, stage: &str, root: &str, verified: &release::Verified) -> Result<Installed, Error> {
    let arguments = steps.install(stage, root, verified, release::public_key())?;
    let output = blocking("installFailed", move || wsl::run(&refs(&arguments), b"", waits::INSTALL, 64 * 1024)).await?;
    installed(output.code, &String::from_utf8_lossy(&output.stdout), &String::from_utf8_lossy(&output.stderr))
}

/// The installed release's helper starts its Core the first time. Its
/// `wsl.exe` stays while Core runs, as a start's does (`wsl::start`).
#[cfg(windows)]
async fn first_start(steps: &Steps, root: &str, release_id: &str, place: &Place, home: &str) -> Result<Started, Error> {
    let arguments = steps.first_start(root, release_id, place, home)?;
    let is_result = |line: &str| crate::connection::start_result_line(line).is_some();
    match blocking("startFailed", move || wsl::until_result(&arguments, wsl::START_WAIT, is_result)).await? {
        wsl::Said::Result(line) => first_started(&crate::connection::start_result_line(&line).unwrap_or_default(), place.port),
        wsl::Said::Ended(output, code) => Err(first_start_ended(&output, code)),
        wsl::Said::Unanswered => Err(Error::new(
            "starting",
            "WSL gave no answer within 3 minutes. Core may still be starting: use Start in a moment. Nothing was stopped.",
        )),
    }
}

/// Opens what a first start started, saved as a confirmed entry named for
/// its distribution.
#[cfg(windows)]
async fn open(window: &WebviewWindow, target: &Target, user: &str, port: u16, started: &Started) -> Result<String, Error> {
    let core = loopback(port)?;
    let profile = crate::connection::StartProfile::new(&core, &target.id, user, &started.install_dir, &started.workspace_id)
        .ok_or_else(|| Error::new("openFailed", "Core started, but what it said about itself is not something this app saves."))?;
    crate::open_first_started(window, &profile, &crate::entries::name_for_wsl(&target.id))
        .await
        .map_err(|message| Error::new("openFailed", message))
}

#[cfg(windows)]
fn loopback(port: u16) -> Result<url::Url, Error> {
    url::Url::parse(&format!("http://127.0.0.1:{port}")).map_err(|error| Error::new("openFailed", error.to_string()))
}

#[cfg(windows)]
async fn start_found(
    window: &WebviewWindow,
    local: &LocalCore,
    target: &Target,
    checked: &Check,
    installation: &Installation,
) -> Result<String, Error> {
    let name = crate::entries::name_for_wsl(&target.id);
    let situation = Situation::read().await?;
    situation.may_start(&target.id)?;
    if let (true, Some(port), Some(workspace)) = (installation.recorded, installation.port, installation.workspace_id.as_deref()) {
        // Started before: as its record says, like a saved start.
        let profile = crate::connection::StartProfile::new(&loopback(port)?, &target.id, &checked.user, &installation.install_dir, workspace)
            .ok_or_else(|| Error::new("startFailed", "The installation's start record is not one this app uses."))?;
        return crate::start_found(window, &profile, &name).await.map_err(|message| Error::new("startFailed", message));
    }
    // Installed, never started: its first start, with the folder and port
    // the latest installation from this window gave it, else the check's.
    let placed = local.placed.lock().map_err(|_| unavailable())?.clone();
    let place = match placed {
        Some((id, place)) if id == target.id && place.install_dir == installation.install_dir => place,
        _ => choose_place(checked, &installation.install_dir, &checked.defaults.data_dir, checked.defaults.port)?,
    };
    port_free(window, place.port).await?;
    let steps = Steps::new(&target.id, &checked.user)?;
    let mut guard = Guard::open(&situation, &target.id).await?;
    let started = guarded(&mut guard, first_start(&steps, &installation.install_dir, &installation.release_id, &place, &checked.home)).await?;
    open(window, target, &checked.user, place.port, &started).await
}

/// Starts `profile`'s Core with rule G around it: the shared state is looked
/// at before the start and after it, from other running distributions, and a
/// change stops the work (the Core itself may already be running). Rule R1
/// is checked first: a stopped distribution is started only as the default
/// one or while no other one runs.
#[cfg(windows)]
pub async fn start_guarded(profile: &StartProfile) -> StartOutcome {
    let situation = match Situation::read().await {
        Ok(situation) => situation,
        Err(error) => return StartOutcome::Failed(error.message),
    };
    if let Err(error) = situation.may_start(&profile.wsl_distro) {
        return StartOutcome::Failed(error.message);
    }
    let mut guard = match Guard::open(&situation, &profile.wsl_distro).await {
        Ok(guard) => guard,
        Err(error) => return StartOutcome::Failed(error.message),
    };
    // The look before the start. It may also be read when WSL's running
    // names cannot be read, and then nothing is started.
    if let Err(error) = guard.after().await {
        return StartOutcome::Failed(error.message);
    }
    let profile = profile.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || wsl::start(&profile))
        .await
        .unwrap_or_else(|error| StartOutcome::Failed(error.to_string()));
    match guard.after().await {
        Ok(()) => outcome,
        Err(error) => StartOutcome::Failed(error.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn targets_have_the_shared_shape() {
        let list = "  NAME            STATE           VERSION\r\n* main-distro     Running         2\r\n  old-distro      Stopped         1\r\n  odd,name        Stopped         2\r\n";
        let running = vec!["main-distro".to_string()];
        let targets = wsl_targets(true, list.as_bytes(), b"", Some(&running));
        let value = serde_json::to_value(&targets).unwrap();
        assert_eq!(value["platform"], "wsl");
        assert_eq!(value["available"], true);
        let listed = value["targets"].as_array().unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(
            listed[0],
            json!({"id": "main-distro", "label": "main-distro", "kind": "wsl", "selectable": true,
                   "isDefault": true, "running": true, "boot": "running"})
        );
        assert_eq!(listed[1]["id"], "old-distro");
        assert_eq!(listed[1]["selectable"], false);
        assert_eq!(listed[1]["running"], false);
        assert_eq!(listed[1]["boot"], "risky");
        assert!(listed[1]["bootDetail"].as_str().unwrap().contains("stopped and another WSL distribution is running"));
        assert!(listed[1]["note"].as_str().unwrap().contains("wsl --set-version"));
        assert_eq!(listed[2]["id"], "odd,name");
        assert_eq!(listed[2]["boot"], "risky");
        assert!(listed[2]["note"].as_str().unwrap().contains("characters this app does not pass"));
    }

    #[test]
    fn a_stopped_distribution_is_alone_or_risky_by_what_runs_now() {
        let list = "  NAME       STATE     VERSION\r\n* main     Running   2\r\n  other    Stopped   2\r\n";
        let boot = |running: Option<&[String]>| {
            let targets = wsl_targets(true, list.as_bytes(), b"", running);
            let value = serde_json::to_value(&targets).unwrap();
            let targets = value["targets"].as_array().unwrap().clone();
            (targets[0]["boot"].as_str().unwrap().to_owned(), targets[1]["boot"].as_str().unwrap().to_owned())
        };
        let none: Vec<String> = Vec::new();
        let other = vec!["other".to_string()];
        let main = vec!["main".to_string()];
        assert_eq!(boot(Some(&none)), ("own".into(), "alone".into()));
        assert_eq!(boot(Some(&other)), ("own".into(), "running".into()));
        assert_eq!(boot(Some(&main)), ("running".into(), "risky".into()));
        // Unreadable running names: only the default may start.
        assert_eq!(boot(None), ("own".into(), "risky".into()));
    }

    #[test]
    fn a_no_running_message_is_not_a_distribution_or_a_peer() {
        let known = vec!["main".to_string(), "other".to_string()];
        assert_eq!(
            running_among(vec!["There are no running distributions.".into()], &known),
            Vec::<String>::new()
        );
        assert_eq!(
            running_among(vec!["main".into(), "noise line".into()], &known),
            ["main".to_string()]
        );
        let list = "  NAME       STATE     VERSION\r\n* main     Stopped   2\r\n  other    Stopped   2\r\n";
        let message = vec!["There are no running distributions.".to_string()];
        let targets = wsl_targets(true, list.as_bytes(), b"", Some(&message));
        let value = serde_json::to_value(&targets).unwrap();
        let targets = value["targets"].as_array().unwrap();
        assert_eq!(targets[0]["boot"], "own");
        assert_eq!(targets[1]["boot"], "alone");
        assert_eq!(targets[1]["bootDetail"], Value::Null);
    }

    #[test]
    fn a_no_running_result_is_an_empty_list_only_when_wsl_says_so() {
        assert_eq!(running_result(true, Some(0), "", ""), Some(Vec::new()));
        assert_eq!(running_result(true, Some(0), "main\n", ""), Some(vec!["main".to_string()]));
        assert_eq!(
            running_result(false, Some(-1), "There are no running distributions.\n", ""),
            Some(Vec::new())
        );
        assert_eq!(
            running_result(false, Some(0), "There are no running distributions.\n", ""),
            Some(Vec::new())
        );
        assert_eq!(running_result(false, Some(1), "WSL (1) ERROR: gone\n", ""), None);
    }

    #[test]
    fn a_failed_or_empty_list_shows_what_wsl_said() {
        let error = |targets: Targets| serde_json::to_value(&targets).unwrap();
        assert_eq!(
            error(wsl_targets(false, b"", b"<3>WSL (8) ERROR: something.\r\n", None)),
            json!({"platform": "wsl", "available": false, "reason": "wslError", "message": "WSL (8) ERROR: something", "targets": []})
        );
        // UTF-16LE, as an older WSL prints it.
        let said: Vec<u8> = "Windows Subsystem for Linux has no installed distributions.\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(
            error(wsl_targets(false, &said, b"", None))["message"],
            "Windows Subsystem for Linux has no installed distributions"
        );
        assert_eq!(error(wsl_targets(true, b"  NAME STATE VERSION\r\n", b"", None))["message"], "WSL listed no distributions.");
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
             tool.python3=Python 3.12.3\ngh.auth=ok\ninit=init\nsystemd=running\ncgroup=cpu memory pids\n{extra}"
        ))
        .unwrap()
    }

    #[test]
    fn a_check_has_the_shared_shape() {
        let check = serde_json::to_value(build_check("main-distro", &report("root.state=absent\n"), Port::Free(4318), true)).unwrap();
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
        assert_eq!(check["checks"][7], json!({"id": "port", "level": "required", "state": "ok", "detail": "4318"}));
        assert_eq!(check["checks"].as_array().unwrap().len(), 15);
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
            true,
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
            let check = serde_json::to_value(build_check("main-distro", &report(&extra), Port::Free(4317), true)).unwrap();
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
                true,
            ))
            .unwrap();
            assert_eq!(check["installation"], Value::Null);
            assert_eq!(check["installable"], false);
            assert_eq!(check["checks"][5]["id"], "paths");
            assert_eq!(check["checks"][5]["state"], "missing");
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
            Err(wsl::Failure::Cancelled) => panic!("listing was stopped"),
        };
        let targets = wsl_targets(output.success, &output.stdout, &output.stderr, None);
        println!("real wsl list: {}", serde_json::to_string(&targets).unwrap());
        assert!(targets.available, "{targets:?}");
        assert!(!targets.targets.is_empty());
        assert_eq!(targets.targets.iter().filter(|target| target.is_default).count(), 1);
    }

    #[test]
    fn no_free_port_is_shown_as_the_default_and_refused() {
        let check = serde_json::to_value(build_check("main-distro", &report("root.state=absent\n"), Port::NoneFree, true)).unwrap();
        assert_eq!(check["defaults"]["port"], 4317);
        assert_eq!(check["checks"][7]["state"], "missing");
        assert_eq!(check["installable"], false);
    }

    fn checked() -> Check {
        build_check("main-distro", &report("root.state=absent\n"), Port::Free(4318), true)
    }

    #[test]
    fn progress_has_the_shared_shape() {
        assert_eq!(serde_json::to_value(Progress::phase("release")).unwrap(), json!({"phase": "release"}));
        assert_eq!(
            serde_json::to_value(Progress::bytes("download", 1, 2)).unwrap(),
            json!({"phase": "download", "done": 1, "total": 2})
        );
        let open = Progress { detail: Some("why".into()), ..Progress::phase("open") };
        assert_eq!(serde_json::to_value(open).unwrap(), json!({"phase": "open", "detail": "why"}));
    }

    #[test]
    fn the_folders_are_the_defaults_or_plain_paths_apart_with_a_port_from_1024() {
        let check = checked();
        let place = choose_place(&check, &check.defaults.install_dir, &check.defaults.data_dir, 4318).unwrap();
        assert_eq!(
            place,
            Place {
                install_dir: "/home/someone/.local/share/yuzuno-core".into(),
                data_dir: "/home/someone/.local/share/yuzuno-core-data".into(),
                port: 4318
            }
        );
        // `~/` is the checked account's home.
        let chosen = choose_place(&check, "~/core", "~/core-data", 1024).unwrap();
        assert_eq!((chosen.install_dir.as_str(), chosen.data_dir.as_str()), ("/home/someone/core", "/home/someone/core-data"));
        for (install, data, code) in [
            ("core", "/home/someone/data", "invalidPath"),
            ("~", "/home/someone/data", "invalidPath"),
            ("/home/someone/my core", "/home/someone/data", "invalidPath"),
            ("/home/someone/../root/core", "/home/someone/data", "invalidPath"),
            ("/mnt/c/core", "/home/someone/data", "invalidPath"),
            ("/home/someone/core;x", "/home/someone/data", "invalidPath"),
            ("/home/someone/core", "/home/someone/core", "invalidPath"),
            ("/home/someone/core", "/home/someone/core/data", "invalidPath"),
            ("/home/someone/core/inner", "/home/someone/core", "invalidPath"),
        ] {
            assert_eq!(choose_place(&check, install, data, 4318).unwrap_err().code, code, "{install} {data}");
        }
        assert_eq!(choose_place(&check, "~/core", "~/data", 1023).unwrap_err().code, "invalidPort");
        assert_eq!(choose_place(&check, "~/core", "~/data", 0).unwrap_err().code, "invalidPort");
    }

    fn verified() -> release::Verified {
        release::Verified {
            tag: "core-20991231-0a1b2c3".into(),
            release_id: "20991231-0a1b2c3".into(),
            manifest_sha256: "ab".repeat(32),
            archive_sha256: "cd".repeat(32),
            archive_bytes: 598,
        }
    }

    #[test]
    fn each_step_is_one_fixed_program_with_every_value_an_argument_of_its_own() {
        let steps = Steps::new("main-distro", "someone").unwrap();
        let head = ["--distribution", "main-distro", "--user", "someone", "--exec"];
        let with = |rest: &[&str]| head.iter().chain(rest).map(|part| part.to_string()).collect::<Vec<_>>();
        let root = "/home/someone/.local/share/yuzuno-core";
        let stage = "/home/someone/.local/share/.yuzuno-core-install.Ab3dEf9h";
        assert_eq!(steps.stage("prepare", root).unwrap(), with(&["/bin/sh", "-s", "--", "prepare", root]));
        assert_eq!(steps.stage("clean", stage).unwrap(), with(&["/bin/sh", "-s", "--", "clean", stage]));
        assert_eq!(
            steps.unpack(stage).unwrap(),
            with(&["/usr/bin/env", "tar", "-xzf", "-", "-C", &format!("{stage}/bundle")])
        );
        let sha = "ab".repeat(32);
        assert_eq!(
            steps.install(stage, root, &verified(), release::public_key()).unwrap(),
            with(&[
                &format!("{stage}/bundle/bin/yuzuno-update-helper"),
                "install",
                "--install-dir",
                root,
                "--bundle",
                &format!("{stage}/bundle"),
                "--manifest-sha256",
                &sha,
                "--reviewed-source",
                "core-20991231-0a1b2c3",
                "--repository",
                "YuzukiS/Yuzuno",
                "--public-key",
                release::public_key(),
            ])
        );
        let place = Place { install_dir: root.into(), data_dir: "/home/someone/.local/share/yuzuno-core-data".into(), port: 4318 };
        assert_eq!(
            steps.first_start(root, "20991231-0a1b2c3", &place, "/home/someone").unwrap(),
            with(&[
                &format!("{root}/releases/20991231-0a1b2c3/bin/yuzuno-update-helper"),
                "first-start",
                "--install-dir",
                root,
                "--port",
                "4318",
                "--data-dir",
                "/home/someone/.local/share/yuzuno-core-data",
                "--cwd",
                "/home/someone",
            ])
        );
    }

    #[test]
    fn a_step_refuses_a_value_this_app_does_not_pass_to_wsl() {
        for (distro, user) in [("main distro", "someone"), ("-x", "someone"), ("main-distro", "root"), ("main-distro", "some one"), ("main-distro", "")] {
            assert_eq!(Steps::new(distro, user).err().map(|error| error.code), Some("checkChanged"), "{distro} {user}");
        }
        let steps = Steps::new("main-distro", "someone").unwrap();
        for folder in ["relative", "/home/someone/a b", "/home/someone/$(x)", "/home/someone/../x", "/mnt/c/x"] {
            assert_eq!(steps.stage("prepare", folder).unwrap_err().code, "invalidPath", "{folder}");
            assert_eq!(steps.unpack(folder).unwrap_err().code, "invalidPath", "{folder}");
        }
        let stage = "/home/someone/.local/share/.yuzuno-core-install.Ab3dEf9h";
        let root = "/home/someone/.local/share/yuzuno-core";
        for change in [
            (|v: &mut release::Verified| v.manifest_sha256 = "x; rm".into()) as fn(&mut release::Verified),
            |v: &mut release::Verified| v.tag = "core-a b".into(),
        ] {
            let mut odd = verified();
            change(&mut odd);
            assert_eq!(steps.install(stage, root, &odd, release::public_key()).unwrap_err().code, "releaseInvalid");
        }
        assert_eq!(steps.install(stage, root, &verified(), "RW key").unwrap_err().code, "releaseInvalid");
        let place = Place { install_dir: root.into(), data_dir: "/home/someone/data".into(), port: 4318 };
        assert_eq!(steps.first_start(root, "../x", &place, "/home/someone").unwrap_err().code, "installFailed");
        assert_eq!(steps.first_start(root, "1", &place, "/home/some one").unwrap_err().code, "invalidPath");
    }

    #[test]
    fn the_temporary_folder_is_read_only_as_stage_sh_names_it_beside_the_install_folder() {
        let root = "/home/someone/.local/share/yuzuno-core";
        assert_eq!(
            stage_from("noise\nstage=/home/someone/.local/share/.yuzuno-core-install.Ab3dEf9h\r\nswept=0\n", root).as_deref(),
            Some("/home/someone/.local/share/.yuzuno-core-install.Ab3dEf9h")
        );
        for printed in [
            "",
            "stage=/home/someone/.yuzuno-core-install.Ab3dEf9h",
            "stage=/home/someone/.local/share/.yuzuno-core-install.Ab3dEf9",
            "stage=/home/someone/.local/share/.yuzuno-core-install.Ab3d-f9h",
            "stage=/home/someone/.local/share/other.Ab3dEf9h",
            "stage=/home/someone/.local/share/x/../.yuzuno-core-install.Ab3dEf9h",
        ] {
            assert_eq!(stage_from(printed, root), None, "{printed}");
        }
    }

    #[test]
    fn install_results_are_read() {
        let ok = r#"{"state":"installed","releaseId":"20991231-0a1b2c3","installDir":"/home/someone/.local/share/yuzuno-core","releaseSource":true}"#;
        assert_eq!(
            installed(Some(0), &format!("a banner\n{ok}\n"), "").unwrap(),
            Installed { release_id: "20991231-0a1b2c3".into(), install_dir: "/home/someone/.local/share/yuzuno-core".into() }
        );
        // A release whose helper has no `install`: clap's exit code 2.
        let old = installed(Some(2), "", "error: unrecognized subcommand 'install'\n").unwrap_err();
        assert_eq!(old.code, "tooOld");
        let refused = installed(Some(3), r#"{"state":"refused","code":"installed","message":"A Yuzuno installation is already at /x; nothing was written."}"#, "").unwrap_err();
        assert_eq!((refused.code, refused.message.as_str()), ("installFailed", "A Yuzuno installation is already at /x; nothing was written."));
        let failed = installed(Some(3), r#"{"state":"failed","code":"register","message":"Bad file.","cleaned":true}"#, "").unwrap_err();
        assert_eq!(failed.message, "Bad file. The installation folder it had made was removed.");
        let odd = installed(Some(0), r#"{"state":"installed","releaseId":"../x","installDir":"/home/someone/core"}"#, "").unwrap_err();
        assert_eq!(odd.code, "installFailed");
        let silent = installed(Some(1), "", "<3>WSL (12) ERROR: no such file\n").unwrap_err();
        assert_eq!(silent.message, "Installing failed: WSL (12) ERROR: no such file.");
    }

    #[test]
    fn first_start_results_are_read() {
        let started = json!({"state":"started","pid":7,"releaseId":"20991231-0a1b2c3","workspaceId":"ws-1","port":4318,
            "installDir":"/home/someone/.local/share/yuzuno-core","recorded":true,"environment":"loginShell","shell":"/bin/bash"});
        assert_eq!(
            first_started(&started, 4318).unwrap(),
            Started { workspace_id: "ws-1".into(), install_dir: "/home/someone/.local/share/yuzuno-core".into(), note: None }
        );
        assert_eq!(first_started(&started, 4317).unwrap_err().code, "startFailed");
        let mut inherited = started.clone();
        inherited["environment"] = json!("inherited");
        inherited["environmentNote"] = json!("timeout");
        assert!(first_started(&inherited, 4318).unwrap().note.unwrap().contains("(timeout)"));
        let code = |value: serde_json::Value| first_started(&value, 4318).unwrap_err();
        assert_eq!(code(json!({"state":"starting","pid":7,"port":4318})).code, "starting");
        assert_eq!(code(json!({"state":"refused","code":"recorded","port":4317,"workspaceId":"ws-0"})).code, "recorded");
        let exited = code(json!({"state":"failed","code":"exited","message":"Core exited.","log":"one\nthe last line\n\n"}));
        assert_eq!((exited.code, exited.message.as_str()), ("startFailed", "Core stopped while starting. the last line"));
        assert_eq!(code(json!({"state":"refused","code":"portInUse","message":"Port 4318 is used."})).message, "Port 4318 is used.");
        assert_eq!(first_start_ended("error: unrecognized subcommand 'first-start'\n", Some(2)).code, "tooOld");
        assert_eq!(first_start_ended("<3>WSL (9) ERROR: gone\n", Some(1)).message, "Core could not be started: WSL (9) ERROR: gone.");
    }

    #[test]
    fn a_place_that_cannot_take_core_says_each_required_item() {
        let check = build_check("main-distro", &report("root.state=other\n"), Port::NoneFree, true);
        let error = not_installable(&check);
        assert_eq!(error.code, "notInstallable");
        assert!(error.message.contains("paths: /home/someone/.local/share/yuzuno-core exists but is not a Yuzuno installation."), "{}", error.message);
        assert!(error.message.contains("port: Ports 4317–4326"), "{}", error.message);
        assert!(!error.message.contains("node"), "recommended items are not reasons");
        assert_eq!(
            cleaned_up(Error::new("copyFailed", "Unpacking failed."), None).message,
            "Unpacking failed. The temporary folder was removed."
        );
        assert_eq!(cleaned_up(Error::new("copyFailed", "Unpacking failed."), Some("Left /x.".into())).message, "Unpacking failed. Left /x.");
    }
}
