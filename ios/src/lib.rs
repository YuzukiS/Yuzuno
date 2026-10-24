//! Yuzuno on iOS (T-170): an app that shows a Workspace Core's own web UI.
//! Its local connection page takes the Core's HTTPS address and checks that
//! a Yuzuno Core answers there; the window then opens that Core, as the
//! desktop app does (desktop/README.md). Nothing but the window runs on the
//! phone: Codex, the Workspace and its agents stay on the Core host.

mod core_url;
mod saved_core;
// The desktop app's rule for recognizing a Core, shared as is.
#[path = "../../desktop/src/health.rs"]
mod health;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// The Core the window may show: the one last connected from the page.
struct Connection {
    client: reqwest::Client,
    selected: Arc<Mutex<Option<Url>>>,
}

fn saved_core_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("core.json"))
}

/// The Core last connected from the page (`saved_core::Saved`, as the page
/// reads it): none yet, one this app would accept now, or a record that
/// cannot be used, which is not taken for a first launch.
#[tauri::command]
fn saved_core(app: AppHandle) -> serde_json::Value {
    match saved_core_file(&app) {
        Some(file) => saved_core::read(&file).to_json(),
        None => saved_core::Saved::Unreadable("this app has no data folder to keep it in".into()).to_json(),
    }
}

/// Opens the Core at `url` once it answers as a Yuzuno Core: the window may
/// then show that origin. The answer says whether it was also saved for the
/// next launch (`saved`, else `saveError`): a Core that answered but could
/// not be saved is not reported as unreachable, nor as saved.
#[tauri::command]
async fn connect_core(app: AppHandle, state: State<'_, Connection>, url: String) -> Result<serde_json::Value, String> {
    let core = core_url::parse(&url)?;
    check_health(&state.client, &core).await?;
    *state.selected.lock().map_err(|_| "Connection state unavailable.".to_owned())? = Some(core.clone());
    let saved = saved_core_file(&app)
        .ok_or_else(|| std::io::Error::other("this app has no data folder to keep it in"))
        .and_then(|file| saved_core::save(&file, &core));
    Ok(match saved {
        Ok(()) => serde_json::json!({ "url": core.as_str(), "saved": true }),
        Err(error) => serde_json::json!({ "url": core.as_str(), "saved": false, "saveError": error.to_string() }),
    })
}

/// Whether `core` answers `/api/health` as a Yuzuno Core: no redirect, at
/// most 64 KiB, as the desktop app reads it.
async fn check_health(client: &reqwest::Client, core: &Url) -> Result<(), String> {
    let url = core.join("api/health").map_err(|_| "This address is not valid.".to_owned())?;
    let mut response = client.get(url).send().await.map_err(|_| {
        "Your Workspace is not reachable. Check its address, and that this iPhone is connected to your private network.".to_owned()
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "The Workspace returned HTTP {}. Check its address and try again.",
            response.status().as_u16()
        ));
    }
    let not_core = || "This address did not answer as a Yuzuno Workspace.".to_owned();
    if response.content_length().is_some_and(|length| length > 65_536) {
        return Err(not_core());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the Workspace's answer.".to_owned())?
    {
        if body.len() + chunk.len() > 65_536 {
            return Err(not_core());
        }
        body.extend_from_slice(&chunk);
    }
    let health: serde_json::Value = serde_json::from_slice(&body).map_err(|_| not_core())?;
    let product = health.get("product").and_then(serde_json::Value::as_str);
    let application = health.get("application").and_then(serde_json::Value::as_str);
    if !health::is_core(product, application) {
        return Err("This address is reachable, but it is not a Yuzuno Workspace.".into());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let selected = Arc::new(Mutex::new(None::<Url>));
    let navigation = selected.clone();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .expect("Unable to create the Workspace connection client");
    tauri::Builder::default()
        // Used from here only: no page is granted the opener's commands, and
        // its page script does not take over link clicks (as in the desktop
        // app, T-104).
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(Connection { client, selected })
        .invoke_handler(tauri::generate_handler![saved_core, connect_core])
        .setup(move |app| {
            let outside = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                // Tauri opens no new window on iOS: a tap on a link that asks
                // for one comes back as a `yuzuno-open:` navigation instead.
                .initialization_script(include_str!("new_window_links.js"))
                .on_navigation(move |url| {
                    let selected = navigation.lock().ok().and_then(|selected| selected.clone());
                    match core_url::destination(url, selected.as_ref()) {
                        core_url::Destination::Window => true,
                        core_url::Destination::Outside(link) => {
                            if let Err(error) = outside.opener().open_url(link.as_str(), None::<&str>) {
                                eprintln!("Unable to open {} outside Yuzuno: {error}", link.scheme());
                            }
                            false
                        }
                        core_url::Destination::Nowhere => false,
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Unable to run Yuzuno");
}
