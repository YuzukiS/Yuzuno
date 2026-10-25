//! Yuzuno on iOS (T-170): an app that shows a Workspace Core's own web UI.
//! Its local connection page takes the Core's HTTPS address and checks that
//! a Yuzuno Core answers there; the window then opens that Core, as the
//! desktop app does (desktop/README.md). Nothing but the window runs on the
//! phone: Codex, the Workspace and its agents stay on the Core host.

mod core_profiles;
mod core_url;
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

/// The named Workspaces this iPhone keeps (`core_profiles::Saved`, as the
/// page reads it): none yet, those this app would accept now, or a record
/// that cannot be used, which is not taken for a first launch. None of them
/// is said to be reachable: that is only known once one is connected to.
#[tauri::command]
fn saved_cores(app: AppHandle) -> serde_json::Value {
    read_profiles(&app).to_json()
}

fn read_profiles(app: &AppHandle) -> core_profiles::Saved {
    match saved_core_file(app) {
        Some(file) => core_profiles::read(&file),
        None => core_profiles::Saved::Unreadable("this app has no data folder to keep it in".into()),
    }
}

/// Opens the Core at `url` once it answers as a Yuzuno Core: the window may
/// then show that origin. The answer says whether it was also saved
/// (`saved`, else `saveError`): a Core that answered but could not be saved
/// is not reported as unreachable, nor as saved.
///
/// `profile` names a saved Workspace this is meant to be. When that profile
/// already knows a `workspaceId` and the Core answers with another one, this
/// opens nothing and keeps opening nothing: a Workspace that shares a name or
/// an address with the saved one is still a different Workspace.
///
/// It is refused rather than offered, because this app cannot yet keep the
/// two apart. The window has one WebView and the page it opens is the Core's
/// own origin, so both Workspaces at one address share that origin's storage,
/// and `web/src/composer-draft.ts` keys a composer draft and its pasted
/// bodies by Agent alone (`yuzuno.composer.v1:<agent>`,
/// `yuzuno.paste.v1:<agent>:<body>`), with no Workspace in the key. Two
/// Workspaces whose Agents share an identifier would therefore hand each
/// other their unsent drafts. Opening it anyway is not offered until a draft
/// is kept per Workspace, or this app keeps a store per profile.
#[tauri::command]
async fn connect_core(
    app: AppHandle,
    state: State<'_, Connection>,
    url: String,
    profile: Option<String>,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let core = core_url::parse(&url)?;
    let workspace = check_health(&state.client, &core).await?;
    let saved = read_profiles(&app);
    let mut profiles = saved.profiles().to_vec();
    let known = profile
        .as_deref()
        .and_then(|id| profiles.iter().find(|kept| kept.id == id))
        .cloned();
    // The Workspace this profile was last opened at, against the one that
    // just answered. Only a profile that already knows one can disagree.
    if let Some(known) = known.as_ref() {
        let before = known.workspace_id.as_deref();
        if core_profiles::identity(before, workspace.as_deref()) == core_profiles::Identity::Changed {
            return Ok(serde_json::json!({
                "url": core.as_str(),
                "opened": false,
                "identity": "changed",
                "profileName": known.name,
                "savedWorkspaceId": before,
                "workspaceId": workspace,
            }));
        }
    }
    *state.selected.lock().map_err(|_| "Connection state unavailable.".to_owned())? = Some(core.clone());
    // What is written down after opening it: the profile asked for, updated,
    // or a new one. A Workspace is never written twice under one profile.
    let selected_id = match known {
        Some(known) => {
            if let Some(kept) = profiles.iter_mut().find(|kept| kept.id == known.id) {
                kept.url = core.clone();
                if let Some(answered) = workspace.clone() {
                    kept.workspace_id = Some(answered);
                }
                if let Some(name) = name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
                    kept.name = name.chars().take(core_profiles::NAME_LIMIT).collect();
                }
            }
            known.id
        }
        None => {
            let id = core_profiles::next_id(&profiles);
            let name = name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(|name| name.chars().take(core_profiles::NAME_LIMIT).collect())
                .unwrap_or_else(|| core_profiles::name_for(&core));
            profiles.push(core_profiles::Profile { id: id.clone(), name, url: core.clone(), workspace_id: workspace.clone() });
            id
        }
    };
    let written = saved_core_file(&app)
        .ok_or_else(|| std::io::Error::other("this app has no data folder to keep it in"))
        .and_then(|file| core_profiles::save(&file, &profiles, Some(&selected_id)));
    let mut answer = serde_json::json!({
        "url": core.as_str(),
        "opened": true,
        "identity": "known",
        "profile": selected_id,
        "workspaceId": workspace,
        "saved": written.is_ok(),
    });
    if let Err(error) = written {
        answer["saveError"] = serde_json::json!(error.to_string());
    }
    Ok(answer)
}

/// Renames a saved Workspace. Its address and the Workspace it points at are
/// untouched: a name is this person's label, not an identity.
#[tauri::command]
fn rename_core(app: AppHandle, profile: String, name: String) -> Result<serde_json::Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give this Workspace a name.".into());
    }
    if name.chars().count() > core_profiles::NAME_LIMIT {
        return Err(format!("A name can be up to {} characters.", core_profiles::NAME_LIMIT));
    }
    let saved = read_profiles(&app);
    let mut profiles = saved.profiles().to_vec();
    let selected = match &saved {
        core_profiles::Saved::Profiles { selected, .. } => selected.clone(),
        _ => None,
    };
    let Some(kept) = profiles.iter_mut().find(|kept| kept.id == profile) else {
        return Err("That Workspace is not saved on this iPhone.".into());
    };
    kept.name = name.to_owned();
    write_profiles(&app, &profiles, selected.as_deref())
}

/// Forgets a saved Workspace on this iPhone. It removes nothing on the Core
/// and signs nothing out: it is this iPhone's own list.
#[tauri::command]
fn remove_core(app: AppHandle, profile: String) -> Result<serde_json::Value, String> {
    let saved = read_profiles(&app);
    let mut profiles = saved.profiles().to_vec();
    let selected = match &saved {
        core_profiles::Saved::Profiles { selected, .. } => selected.clone(),
        _ => None,
    };
    if !profiles.iter().any(|kept| kept.id == profile) {
        return Err("That Workspace is not saved on this iPhone.".into());
    }
    profiles.retain(|kept| kept.id != profile);
    let selected = selected.filter(|id| *id != profile);
    write_profiles(&app, &profiles, selected.as_deref())
}

/// Writes the list and says what the page should show now. A refused write
/// changes nothing, and is reported rather than taken as done.
fn write_profiles(app: &AppHandle, profiles: &[core_profiles::Profile], selected: Option<&str>) -> Result<serde_json::Value, String> {
    saved_core_file(app)
        .ok_or_else(|| std::io::Error::other("this app has no data folder to keep it in"))
        .and_then(|file| core_profiles::save(&file, profiles, selected))
        .map_err(|error| format!("This iPhone could not save the change ({error}). The list is as it was."))?;
    Ok(read_profiles(app).to_json())
}

/// Whether `core` answers `/api/health` as a Yuzuno Core: no redirect, at
/// most 64 KiB, as the desktop app reads it. On success it answers with the
/// `workspaceId` that Core named, which tells one Workspace from another at
/// the same address or under the same name. A Core old enough not to send
/// one answers `None`: it is still a Core, and this app then has no identity
/// to compare, which it says rather than assuming they match.
async fn check_health(client: &reqwest::Client, core: &Url) -> Result<Option<String>, String> {
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
    Ok(health
        .get("workspaceId")
        .and_then(serde_json::Value::as_str)
        .filter(|workspace| !workspace.is_empty())
        .map(str::to_owned))
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
        .invoke_handler(tauri::generate_handler![saved_cores, connect_core, rename_core, remove_core])
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
