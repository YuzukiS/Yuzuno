#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod chrome;
mod connection;
mod health;
mod update;

use connection::{
    desktop_url, hand_outside, is_connection_page, launch_url, open_failure_notice, parse_core_url,
    permits_appearance, permits_navigation, startup_url, Outside,
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

fn read_saved_core(app: &AppHandle) -> Option<Url> {
    connection::saved_core(&std::fs::read(saved_core_file(app)?).ok()?)
}

/// Written whole, then renamed over the old record, so a crash leaves one
/// or the other. Failing to save only means the next launch asks again.
fn save_core(app: &AppHandle, core: &Url) {
    let Some(path) = saved_core_file(app) else {
        return;
    };
    let staged = path.with_extension("json.new");
    let saved = std::fs::create_dir_all(path.parent().unwrap_or(&path))
        .and_then(|()| std::fs::write(&staged, connection::saved_record(core)))
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    core_url: String,
    error: Option<String>,
    auto_connect: bool,
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
    Ok(ConnectionInfo {
        core_url,
        error: startup
            .as_ref()
            .err()
            .cloned()
            .filter(|_| selected.is_none()),
        auto_connect: state.first_open.swap(false, Ordering::Relaxed),
    })
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
    let mut response = state
        .client
        .get(core.join("api/health").map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|_| {
            "Core is not reachable yet. Start it in WSL or on your chosen host, then try again."
                .to_owned()
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "Core returned HTTP {}. Check its address and try again.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > 65_536)
    {
        return Err("This address did not return a Yuzuno Core health response.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the Core health response.".to_owned())?
    {
        if body.len() + chunk.len() > 65_536 {
            return Err("This address did not return a Yuzuno Core health response.".into());
        }
        body.extend_from_slice(&chunk);
    }
    let health: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| "This address did not return a Yuzuno Core health response.".to_owned())?;
    let product = health.get("product").and_then(serde_json::Value::as_str);
    let application = health.get("application").and_then(serde_json::Value::as_str);
    if !health::is_core(product, application) {
        return Err("This address is reachable, but it is not a Yuzuno Core.".into());
    }
    require_connection_page(&window)?;
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
        updates.forget();
    }
    *selected = Some(core.clone());
    save_core(window.app_handle(), &core);
    Ok(desktop_url(&core).into())
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
    let builder = tauri::Builder::default().plugin(opener_plugin());
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
        })
        .manage(update::DesktopUpdates::default())
        .invoke_handler(tauri::generate_handler![
            connection_info,
            connect_core,
            set_appearance,
            update::desktop_update_status,
            update::desktop_update_check,
            update::desktop_update_install
        ])
        .setup(move |app| {
            // An update's installer restarts this app with its launch
            // arguments; reopen the Core chosen in the window before it.
            {
                let state = app.state::<ConnectionState>();
                let mut startup = state.startup.lock().unwrap();
                let opened = startup_url(launch, read_saved_core(app.handle()));
                *startup = update::restore_startup_core(app.handle(), opened);
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
