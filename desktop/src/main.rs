#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod chrome;
mod connection;
mod health;
mod notification_text;
mod notify;
mod update;

use connection::{
    desktop_url, hand_outside, is_connection_page, is_loopback, launch_url, open_failure_notice,
    parse_core_url, permits_appearance, permits_navigation, startup_url, Attempt, Outside, Settle,
    StartOutcome, StartProfile,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
#[cfg(target_os = "macos")]
use tauri::menu::PredefinedMenuItem;
use tauri::{
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem, Submenu},
    AppHandle, Manager, WebviewUrl, WebviewWindow,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// What the toolbar needs to act as a title bar without a system frame:
/// move, minimize, maximize/restore, close, and read the frame state.
/// Granted to the embedded connection page and the selected Core only.
const WINDOW_FRAME: [&str; 6] = [
    "core:window:allow-is-decorated",
    "core:window:allow-is-maximized",
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
];

/// A link the workspace window does not open itself (a new window, or a page
/// outside the selected Core) goes to the system browser or mail app. The
/// window keeps no extra IPC for this; it happens on the native side. If the
/// system cannot open it, the page says so.
fn open_outside(app: &AppHandle, url: &Url) {
    if let Outside::Failed(error) = hand_outside(url, |link| system_open(app, link)) {
        eprintln!("Unable to open {} outside Yuzuno: {error}", url.scheme());
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.eval(open_failure_notice(url, &error)) {
                eprintln!("Unable to show that a link was not opened: {error}");
            }
        }
    }
}

fn system_open(app: &AppHandle, url: &str) -> Result<(), String> {
    // Lab builds only (`--features lab-open-failure`): a reserved `.invalid`
    // host fails, so the failure notice can be seen in a real window.
    if cfg!(feature = "lab-open-failure")
        && Url::parse(url)
            .ok()
            .and_then(|url| url.host_str().map(|host| host.ends_with(".invalid")))
            == Some(true)
    {
        return Err("this lab build never opens .invalid hosts".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

/// Link clicks are left to this window's own handlers (`on_new_window`,
/// `on_navigation`, then `open_outside`). The plugin's default page script
/// cancels a `target=_blank` click and asks for opener IPC instead, which no
/// workspace page is granted, so such a link did nothing (T-104).
fn opener_plugin<R: tauri::Runtime>() -> impl tauri::plugin::Plugin<R> + 'static {
    tauri_plugin_opener::Builder::new()
        .open_js_links_on_click(false)
        .build()
}

/// The Core last connected from the connection page, in the app's data
/// folder. A launch that names no Core opens it again.
const SAVED_CORE_FILE: &str = "core.json";

fn saved_core_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(SAVED_CORE_FILE))
}

/// The saved Core, and where it is installed in WSL if it said so.
fn read_saved_core(app: &AppHandle) -> (Option<Url>, Option<StartProfile>) {
    let Some(bytes) = saved_core_file(app).and_then(|path| std::fs::read(path).ok()) else {
        return (None, None);
    };
    (connection::saved_core(&bytes), connection::saved_start(&bytes))
}

/// Written whole, then renamed over the old record, so a crash leaves one
/// or the other. Failing to save only means the next launch asks again.
fn save_core(app: &AppHandle, core: &Url, start: Option<&StartProfile>) {
    let Some(path) = saved_core_file(app) else {
        return;
    };
    let staged = path.with_extension("json.new");
    let saved = std::fs::create_dir_all(path.parent().unwrap_or(&path))
        .and_then(|()| std::fs::write(&staged, connection::saved_record(core, start)))
        .and_then(|()| std::fs::rename(&staged, &path));
    if let Err(error) = saved {
        eprintln!("Unable to remember the workspace for the next launch: {error}");
    }
}

struct ConnectionState {
    /// What startup opens: the Core the launch names, else the one last
    /// connected here, else the default; after an update restart, the Core
    /// that was selected before it.
    startup: Mutex<Result<Url, String>>,
    selected: Arc<Mutex<Option<Url>>>,
    client: reqwest::Client,
    first_open: AtomicBool,
    /// Where the saved Core is installed in WSL, so the connection page can
    /// start it (T-171); only ever from that Core's own answer.
    start: Mutex<Option<StartProfile>>,
    /// A start from this window is under way.
    starting: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    core_url: String,
    error: Option<String>,
    auto_connect: bool,
    /// The WSL distribution the shown Core can be started in, if any.
    start_distro: Option<String>,
    /// This computer's start entry has accepted that installation before.
    start_confirmed: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AppearanceTheme {
    Light,
    Dark,
}

#[tauri::command]
fn set_appearance(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    theme: AppearanceTheme,
) -> Result<(), String> {
    let selected = state
        .selected
        .lock()
        .map_err(|_| "Connection state unavailable.")?;
    let current_url = window.url().map_err(|e| e.to_string())?;
    if !permits_appearance(window.label(), &current_url, selected.as_ref()) {
        return Err(
            "Appearance is only available in the selected workspace or connection page.".into(),
        );
    }
    // Only this fixed light/dark palette is exposed. No arbitrary window,
    // filesystem, process, navigation, or connection operation is granted.
    // Keep Tauri's window theme preference at None. Its ThemeChanged handler
    // also sets WebView2's preferred color scheme; forcing a window theme here
    // would feed our explicit choice back into prefers-color-scheme and prevent
    // a later System preference from following actual OS changes.
    #[cfg(windows)]
    chrome::apply(&window, theme);
    // Other platforms retain their normal native frame; CSS still applies the
    // selected workspace palette without forcing an app-wide OS appearance.
    #[cfg(not(windows))]
    let _ = theme;
    Ok(())
}

fn require_connection_page(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" || !is_connection_page(&window.url().map_err(|e| e.to_string())?) {
        return Err("This operation is only available on the local connection page.".into());
    }
    Ok(())
}

#[tauri::command]
fn connection_info(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
) -> Result<ConnectionInfo, String> {
    require_connection_page(&window)?;
    let selected = state
        .selected
        .lock()
        .map_err(|_| "Connection state unavailable.")?;
    let startup = state
        .startup
        .lock()
        .map_err(|_| "Connection state unavailable.")?;
    let core_url = selected
        .as_ref()
        .or(startup.as_ref().ok())
        .map(Url::as_str)
        .unwrap_or(connection::DEFAULT_CORE_URL)
        .to_owned();
    let shown = state
        .start
        .lock()
        .map_err(|_| "Connection state unavailable.")?
        .clone()
        .filter(|start| start.core.as_str() == core_url);
    Ok(ConnectionInfo {
        core_url,
        start_distro: shown.as_ref().map(|start| start.wsl_distro.clone()),
        start_confirmed: shown.is_some_and(|start| start.confirmed),
        error: startup
            .as_ref()
            .err()
            .cloned()
            .filter(|_| selected.is_none()),
        auto_connect: state.first_open.swap(false, Ordering::Relaxed),
    })
}

/// A small JSON answer from the selected Core, read with a size limit.
/// None: nothing answered at all.
async fn read_json(client: &reqwest::Client, url: Url) -> Option<Result<serde_json::Value, String>> {
    let mut response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return Some(Err(format!(
            "Core returned HTTP {}. Check its address and try again.",
            response.status().as_u16()
        )));
    }
    let not_core = || "This address did not return a Yuzuno Core health response.".to_owned();
    if response.content_length().is_some_and(|length| length > 65_536) {
        return Some(Err(not_core()));
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 65_536 => body.extend_from_slice(&chunk),
            Ok(Some(_)) => return Some(Err(not_core())),
            Ok(None) => break,
            Err(_) => return Some(Err("Could not read the Core health response.".into())),
        }
    }
    Some(serde_json::from_slice(&body).map_err(|_| not_core()))
}

/// The Core's health: its Workspace if it is a Yuzuno Core.
async fn core_health(client: &reqwest::Client, core: &Url) -> Option<Result<String, String>> {
    let health = match read_json(client, core.join("api/health").ok()?).await? {
        Ok(health) => health,
        Err(error) => return Some(Err(error)),
    };
    let product = health.get("product").and_then(serde_json::Value::as_str);
    let application = health.get("application").and_then(serde_json::Value::as_str);
    if !health::is_core(product, application) {
        return Some(Err("This address is reachable, but it is not a Yuzuno Core.".into()));
    }
    Some(Ok(health["workspaceId"].as_str().unwrap_or_default().to_owned()))
}

#[tauri::command]
async fn connect_core(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    updates: tauri::State<'_, update::DesktopUpdates>,
    url: String,
) -> Result<String, String> {
    require_connection_page(&window)?;
    let core = parse_core_url(&url)?;
    open_core(&window, &state, &updates, core, None).await
}

/// Opens `core` once its health says it is a Yuzuno Core (and, after a
/// start, the expected Workspace); remembers it, and on Windows where it is
/// installed in WSL if it says so.
async fn open_core(
    window: &WebviewWindow,
    state: &ConnectionState,
    updates: &update::DesktopUpdates,
    core: Url,
    expected: Option<&str>,
) -> Result<String, String> {
    let workspace = core_health(&state.client, &core).await.unwrap_or_else(|| {
        Err("Core is not reachable yet. Start it in WSL or on your chosen host, then try again.".into())
    })?;
    if expected.is_some_and(|expected| expected != workspace) {
        return Err("Core answered, but with another Workspace. Check its address.".into());
    }
    // Only a Core on this computer can say where it is installed; the Mac
    // app and other platforms never start one.
    let offered = if cfg!(windows) && is_loopback(&core) {
        match core.join("api/desktop/start-profile") {
            Ok(url) => read_json(&state.client, url).await.and_then(Result::ok),
            Err(_) => None,
        }
    } else {
        None
    };
    require_connection_page(window)?;
    let mut selected = state
        .selected
        .lock()
        .map_err(|_| "Connection state unavailable.")?;
    if selected.as_ref() != Some(&core) {
        // The user-selected origin, including its port, is the only remote
        // origin granted set_appearance and the window-frame calls. Previous
        // grants cannot control a newly selected workspace: set_appearance
        // checks the current URL, and navigation no longer admits an earlier
        // origin, so its page cannot load here to use the window calls.
        let capability = CapabilityBuilder::new(format!(
            "appearance-{}",
            core.origin().ascii_serialization()
        ))
        .local(false)
        .webview("main")
        .remote(format!("{}/*", core.origin().ascii_serialization()))
        .permission("allow-set-appearance");
        window
            .add_capability(
                WINDOW_FRAME
                    .iter()
                    .fold(capability, |capability, permission| {
                        capability.permission(*permission)
                    }),
            )
            .map_err(|e| format!("Could not enable workspace appearance: {e}"))?;
        // Desktop updates are asked for from the selected workspace only
        // (each command checks the window's current origin again).
        window
            .add_capability(
                CapabilityBuilder::new(format!(
                    "desktop-updates-{}",
                    core.origin().ascii_serialization()
                ))
                .local(false)
                .webview("main")
                .remote(format!("{}/*", core.origin().ascii_serialization()))
                .permission("allow-desktop-update-status")
                .permission("allow-desktop-update-check")
                .permission("allow-desktop-update-install"),
            )
            .map_err(|e| format!("Could not enable desktop updates: {e}"))?;
        // System notifications, likewise from the selected workspace only
        // (T-188): this app's two commands, never the plugin's own.
        window
            .add_capability(
                CapabilityBuilder::new(format!(
                    "desktop-notifications-{}",
                    core.origin().ascii_serialization()
                ))
                .local(false)
                .webview("main")
                .remote(format!("{}/*", core.origin().ascii_serialization()))
                .permission("allow-desktop-notifications")
                .permission("allow-desktop-notify"),
            )
            .map_err(|e| format!("Could not enable system notifications: {e}"))?;
        updates.forget();
    }
    *selected = Some(core.clone());
    let mut start = state
        .start
        .lock()
        .map_err(|_| "Connection state unavailable.")?;
    // What this Core offers now, still confirmed only if it is the very
    // same target; an older Core that cannot say keeps what was saved for
    // the same Core and Workspace. Opening a Core never confirms anything.
    let previous = start.take();
    let kept = match offered {
        Some(offered) => StartProfile::offered(&core, &workspace, &offered)
            .map(|offered| connection::merge_offered(previous.as_ref(), offered)),
        None => previous.filter(|saved| saved.core == core && saved.workspace_id == workspace),
    };
    *start = kept;
    save_core(window.app_handle(), &core, start.as_ref());
    Ok(desktop_url(&core).into())
}

/// How long the connection page waits for a start in WSL. The start itself
/// waits up to two minutes for Core to answer; booting WSL comes first.
#[cfg(windows)]
const START_WAIT: Duration = Duration::from_secs(180);

/// Runs the installation's start entry in its WSL distribution and reads
/// its result as soon as it is printed. After starting Core the entry stays
/// while Core runs, so WSL keeps the distribution running: that `wsl.exe`
/// is left running, hidden, and outlives this window. Waiting ends after
/// [`START_WAIT`]; nothing is stopped then.
#[cfg(windows)]
fn wsl_start(profile: &StartProfile) -> StartOutcome {
    use std::{
        io::{BufRead, BufReader, Read},
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        sync::mpsc::{self, RecvTimeoutError},
        time::Instant,
    };
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Windows' own wsl.exe, never one found on PATH.
    let wsl = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join(r"System32\wsl.exe");
    if !wsl.is_file() {
        return StartOutcome::Failed("WSL is not installed on this computer, so Core cannot be started from here.".into());
    }
    let child = Command::new(&wsl)
        .args(profile.wsl_arguments())
        // wsl.exe's own messages in UTF-8 rather than UTF-16.
        .env("WSL_UTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => return StartOutcome::Failed(format!("Could not run WSL: {error}")),
    };
    fn read_all(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(64 * 1024).read_to_end(&mut bytes);
            }
            bytes
        })
    }
    let stderr = read_all(child.stderr.take());
    let (lines, arriving) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut stdout = BufReader::new(stdout.take(64 * 1024));
            let mut line = Vec::new();
            while matches!(stdout.read_until(b'\n', &mut line), Ok(read) if read > 0) {
                if lines.send(String::from_utf8_lossy(&line).into_owned()).is_err() {
                    break;
                }
                line.clear();
            }
        });
    }
    let deadline = Instant::now() + START_WAIT;
    let mut output = String::new();
    loop {
        match arriving.recv_timeout(Duration::from_millis(200)) {
            Ok(line) if connection::start_result_line(&line).is_some() => {
                return connection::start_result(profile, &line);
            }
            Ok(line) => output.push_str(&line),
            // wsl.exe ended without a result: what it said is why.
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= deadline {
            return StartOutcome::Unanswered;
        }
    }
    // Its output has closed; give it and its error stream a moment to end,
    // never more.
    let ending = Instant::now() + Duration::from_secs(5);
    while (matches!(child.try_wait(), Ok(None)) || !stderr.is_finished()) && Instant::now() < ending {
        std::thread::sleep(Duration::from_millis(100));
    }
    if stderr.is_finished() {
        output.push('\n');
        output.push_str(&String::from_utf8_lossy(&stderr.join().unwrap_or_default()));
    }
    connection::start_result(profile, &output)
}

#[cfg(windows)]
async fn run_start(profile: &StartProfile) -> StartOutcome {
    let profile = profile.clone();
    tauri::async_runtime::spawn_blocking(move || wsl_start(&profile))
        .await
        .unwrap_or_else(|error| StartOutcome::Failed(error.to_string()))
}

#[cfg(not(windows))]
async fn run_start(_: &StartProfile) -> StartOutcome {
    StartOutcome::Failed("Starting Core is available in the Windows app with WSL only.".into())
}

/// Keeps what a start attempt showed about the saved profile
/// ([`connection::settle`]): confirmed once this computer's start entry has
/// accepted the installation; an unconfirmed one forgotten once the entry
/// says it is not installed here.
fn settle_start(window: &WebviewWindow, state: &ConnectionState, profile: &StartProfile, attempt: &Attempt) -> Result<(), String> {
    let settled = connection::settle(profile, attempt);
    if settled == Settle::Keep {
        return Ok(());
    }
    let mut start = state.start.lock().map_err(|_| "Connection state unavailable.")?;
    // Only the profile this attempt was for; another may have been saved since.
    if start.as_ref().is_some_and(|saved| saved.same_target(profile)) {
        *start = match settled {
            Settle::Confirm => Some(StartProfile { confirmed: true, ..profile.clone() }),
            _ => None,
        };
        save_core(window.app_handle(), &profile.core, start.as_ref());
    }
    Ok(())
}

/// Starts the saved Core in its WSL distribution when it does not answer,
/// then opens it once it answers with its own Workspace. A Core that already
/// answers is opened, never started again. Only the embedded connection page
/// may ask, only for the address it was saved with; what runs is fixed by
/// that Core's own earlier answer, not by the page.
#[tauri::command]
async fn start_core(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    updates: tauri::State<'_, update::DesktopUpdates>,
    url: String,
) -> Result<String, String> {
    require_connection_page(&window)?;
    let core = parse_core_url(&url)?;
    let profile = state
        .start
        .lock()
        .map_err(|_| "Connection state unavailable.")?
        .clone()
        .filter(|start| start.core == core)
        .ok_or("This app can start only a Core it has connected to on this computer, at the same address.")?;
    if state.starting.swap(true, Ordering::SeqCst) {
        return Err("Core is already being started.".into());
    }
    struct Done<'a>(&'a AtomicBool);
    impl Drop for Done<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _done = Done(&state.starting);
    match core_health(&state.client, &core).await {
        // Answering over HTTP says nothing about where it runs: opened,
        // never counted as this computer's (settle keeps the profile).
        Some(Ok(workspace)) if workspace == profile.workspace_id => {
            settle_start(&window, &state, &profile, &Attempt::Answering)?;
            return open_core(&window, &state, &updates, core, Some(&profile.workspace_id)).await;
        }
        Some(Ok(_)) => return Err("Another Workspace's Core answers at this address. Nothing was started.".into()),
        Some(Err(error)) => return Err(format!("{error} Nothing was started.")),
        None => {}
    }
    let outcome = run_start(&profile).await;
    let attempt = Attempt::Ran(outcome);
    settle_start(&window, &state, &profile, &attempt)?;
    let Attempt::Ran(outcome) = attempt else { unreachable!() };
    match outcome {
        StartOutcome::Started | StartOutcome::Running => {}
        StartOutcome::Starting => {
            return Err("Core was started but has not answered yet. Try Connect in a moment; nothing was stopped.".into())
        }
        StartOutcome::Unanswered => {
            return Err("WSL gave no answer within 3 minutes. Core may still be starting: try Connect in a moment. Nothing was stopped, and nothing is tried again by itself.".into())
        }
        StartOutcome::NotHere(_) if !profile.confirmed => {
            return Err("Not started: this computer's WSL has no matching installation for this Workspace. If this address leads to another computer, such as an SSH tunnel, start Core there.".into())
        }
        StartOutcome::NotHere(message) | StartOutcome::Failed(message) => return Err(message),
    }
    // WSL's forwarding to Windows can lag the Core's own answer slightly.
    let mut tries = 0;
    loop {
        match open_core(&window, &state, &updates, core.clone(), Some(&profile.workspace_id)).await {
            Err(error) if tries < 10 && error.starts_with("Core is not reachable") => {
                tries += 1;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            result => return result,
        }
    }
}

fn main() {
    let launch = launch_url(
        std::env::args().skip(1),
        std::env::var("YUZUNO_CORE_URL").ok(),
    );
    let selected = Arc::new(Mutex::new(None::<Url>));
    let navigation_target = selected.clone();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("Unable to create the Core connection client");

    let context = tauri::generate_context!();
    let builder = tauri::Builder::default()
        .plugin(opener_plugin())
        // System notifications through the app's own commands only (T-188).
        .plugin(notify::plugin());
    // Updates are verified against plugins > updater > pubkey. No updater
    // command is granted to any page; the app's own commands use it. A build
    // without that key (such as the Mac app's) cannot start the updater, so it
    // runs without it; the update commands then say why and never reach it.
    let builder = if update::config_public_key(context.config()).is_some() {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    builder
        .manage(ConnectionState {
            startup: Mutex::new(startup_url(launch.clone(), None)),
            selected,
            client,
            first_open: AtomicBool::new(true),
            start: Mutex::new(None),
            starting: AtomicBool::new(false),
        })
        .manage(update::DesktopUpdates::default())
        .invoke_handler(tauri::generate_handler![
            connection_info,
            connect_core,
            start_core,
            set_appearance,
            update::desktop_update_status,
            update::desktop_update_check,
            update::desktop_update_install,
            notify::desktop_notifications,
            notify::desktop_notify
        ])
        .setup(move |app| {
            // An update's installer restarts this app with its launch
            // arguments; reopen the Core chosen in the window before it.
            {
                let state = app.state::<ConnectionState>();
                let mut startup = state.startup.lock().unwrap();
                let (saved, start) = read_saved_core(app.handle());
                let opened = startup_url(launch, saved);
                *startup = update::restore_startup_core(app.handle(), opened);
                *state.start.lock().unwrap() = start;
            }
            let connect =
                MenuItem::with_id(app, "connection", "Connection…", true, Some("CmdOrCtrl+,"))?;
            let quit = MenuItem::with_id(app, "quit", "Close Yuzuno", true, Some("CmdOrCtrl+Q"))?;
            // macOS menus belong to the app, not a window. Its own app menu
            // carries Quit, and Edit gives the workspace's text fields the
            // usual copy and paste shortcuts.
            #[cfg(target_os = "macos")]
            {
                let _ = &quit;
                let separator = || PredefinedMenuItem::separator(app);
                app.set_menu(Menu::with_items(
                    app,
                    &[
                        &Submenu::with_items(
                            app,
                            "Yuzuno",
                            true,
                            &[
                                &PredefinedMenuItem::about(app, None, None)?,
                                &separator()?,
                                &PredefinedMenuItem::hide(app, None)?,
                                &PredefinedMenuItem::hide_others(app, None)?,
                                &PredefinedMenuItem::show_all(app, None)?,
                                &separator()?,
                                &PredefinedMenuItem::quit(app, None)?,
                            ],
                        )?,
                        &Submenu::with_items(
                            app,
                            "Edit",
                            true,
                            &[
                                &PredefinedMenuItem::undo(app, None)?,
                                &PredefinedMenuItem::redo(app, None)?,
                                &separator()?,
                                &PredefinedMenuItem::cut(app, None)?,
                                &PredefinedMenuItem::copy(app, None)?,
                                &PredefinedMenuItem::paste(app, None)?,
                                &PredefinedMenuItem::select_all(app, None)?,
                            ],
                        )?,
                        &Submenu::with_items(app, "Workspace", true, &[&connect])?,
                        &Submenu::with_items(
                            app,
                            "Window",
                            true,
                            &[
                                &PredefinedMenuItem::minimize(app, None)?,
                                &PredefinedMenuItem::maximize(app, None)?,
                                &separator()?,
                                &PredefinedMenuItem::close_window(app, None)?,
                            ],
                        )?,
                    ],
                )?)?;
            }
            #[cfg(not(target_os = "macos"))]
            let menu = Menu::with_items(
                app,
                &[&Submenu::with_items(
                    app,
                    "Workspace",
                    true,
                    &[&connect, &quit],
                )?],
            )?;
            let navigation_app = app.handle().clone();
            let new_window_app = app.handle().clone();
            let builder =
                tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Yuzuno")
                    .inner_size(1320.0, 900.0)
                    .min_inner_size(940.0, 650.0)
                    .center()
                    .visible(false)
                    // On Windows the workspace toolbar is the title bar: no
                    // system frame, but the shadow and resize edges remain.
                    // Elsewhere the system frame stays.
                    .decorations(!cfg!(windows))
                    .shadow(true)
                    .background_color(tauri::window::Color(250, 248, 244, 255));
            #[cfg(not(target_os = "macos"))]
            let builder = builder.menu(menu);
            let builder = builder
                .on_navigation(move |url| {
                    let permitted = navigation_target
                        .lock()
                        .map(|core| permits_navigation(url, core.as_ref()))
                        .unwrap_or(false);
                    if !permitted {
                        open_outside(&navigation_app, url);
                    }
                    permitted
                })
                .on_new_window(move |url, _| {
                    open_outside(&new_window_app, &url);
                    tauri::webview::NewWindowResponse::Deny
                });
            let window = builder.build()?;
            #[cfg(windows)]
            {
                // Keep menu accelerators, but remove the extra Windows menu row.
                // The embedded/workspace Connection button provides a visible entry.
                window.hide_menu()?;
                chrome::apply(&window, AppearanceTheme::Light);
            }
            window.show()?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "connection" => {
                if let Some(window) = app.get_webview_window("main") {
                    let local_url = if cfg!(target_os = "windows") {
                        "http://tauri.localhost/index.html"
                    } else {
                        "tauri://localhost/index.html"
                    };
                    if let Err(error) =
                        window.navigate(local_url.parse().expect("valid embedded URL"))
                    {
                        eprintln!("Unable to open connection page: {error}");
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .run(context)
        .expect("Unable to open the Yuzuno desktop window");
}

#[cfg(test)]
mod tests {
    use tauri::plugin::Plugin;

    #[test]
    fn the_opener_plugin_leaves_link_clicks_to_the_window() {
        // With its default page script, a target=_blank click is cancelled in
        // the page and never reaches on_new_window (T-104).
        assert!(tauri_plugin_opener::init::<tauri::Wry>().initialization_script().is_some());
        assert_eq!(super::opener_plugin::<tauri::Wry>().initialization_script(), None);
    }
}
