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
// This app's version, for the pages its window opens (T-191).
mod app_version;

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
    // A record that could not be read answers no profiles, and nothing may
    // be decided from it: not whether this address is one of the saved
    // Workspaces, not which Workspace answered there before, and not what a
    // list built from it would replace. So the connection is refused here --
    // before the window is pointed anywhere and before anything is written --
    // and the record is left exactly as it is. Opening anyway would be the
    // draft-sharing case this slice refuses, with the check that prevents it
    // switched off; writing anyway would put this one Workspace over a record
    // that may still hold sixteen. The comment in `core_profiles::save_with`
    // named this failure while guarding only its own oversize write, which
    // was never enough: by the time that write runs the list it was handed is
    // already empty. (`rename_core` and `remove_core` reach no write from
    // such a record either: the Workspace they were asked about is not in an
    // empty list, and they answer that.)
    if let Some(reason) = core_profiles::unusable(&saved) {
        return Err(format!(
            "The Workspaces saved on this iPhone could not be read ({reason}). This app will not open a workspace it cannot check against them, and has changed nothing of what is saved."
        ));
    }
    let mut profiles = saved.profiles().to_vec();
    // The saved Workspace this is: the one the page named, or, when it named
    // none, whichever is saved at this same address. Looking the address up
    // is what makes the check below hold: the page drops the profile it was
    // about as soon as the field differs from the saved address by so much as
    // a trailing slash, and typing a saved address by hand never named one at
    // all. Keyed on the id alone, the refusal was skipped in exactly those
    // cases -- the other Workspace opened in the very origin it guards -- and
    // each connect wrote another profile for an address already saved.
    let known = match profile.as_deref() {
        Some(id) => profiles.iter().find(|kept| kept.id == id).cloned(),
        None => profiles.iter().find(|kept| kept.url == core).cloned(),
    };
    // What the Workspace that just answered lets this do with the address.
    // Decided here, before the window is pointed anywhere and before a byte
    // is written, so every refusal leaves the record exactly as it is.
    //
    // Only `Open` goes on. The three refusals are told apart because they
    // are different situations and a person can act on each: another
    // Workspace is at this address; this one cannot be checked against what
    // is saved; the answer is too long for this app to keep.
    let before = known.as_ref().and_then(|known| known.workspace_id.as_deref());
    let named = known
        .as_ref()
        .map(|known| known.name.clone())
        .unwrap_or_else(|| core_profiles::name_for(&core));
    let answered_json = (!workspace.is_empty()).then(|| workspace.clone());
    let refusal = |identity: &str| {
        Ok(serde_json::json!({
            "url": core.as_str(),
            "opened": false,
            "identity": identity,
            "profileName": named,
            "savedWorkspaceId": before,
            "workspaceId": answered_json,
        }))
    };
    let answered = match core_profiles::opening(before, &workspace) {
        core_profiles::Opening::Open(answered) => answered,
        core_profiles::Opening::Changed => return refusal("changed"),
        core_profiles::Opening::Unverified => return refusal("unverified"),
        core_profiles::Opening::Unkeepable => return refusal("unkeepable"),
    };
    *state.selected.lock().map_err(|_| "Connection state unavailable.".to_owned())? = Some(core.clone());
    // What is written down after opening it: the profile asked for, updated,
    // or a new one. A Workspace is never written twice under one profile.
    let selected_id = match known {
        Some(known) => {
            if let Some(kept) = profiles.iter_mut().find(|kept| kept.id == known.id) {
                kept.url = core.clone();
                if let Some(answered) = answered.clone() {
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
            profiles.push(core_profiles::Profile { id: id.clone(), name, url: core.clone(), workspace_id: answered.clone() });
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
        "workspaceId": answered,
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
async fn check_health(client: &reqwest::Client, core: &Url) -> Result<String, String> {
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
    // The answer is handed on as it came, and classified by
    // `core_profiles::opening`. It used to be filtered here: an identifier
    // longer than the record keeps was dropped, which made it
    // indistinguishable from a Core that named no Workspace at all -- and a
    // Core that names none was then treated as "nothing to compare", so an
    // address already bound to a Workspace opened on it. Whether an answer
    // can be kept is a different question from whether it can be checked,
    // and only the second one decides whether to open.
    Ok(health
        .get("workspaceId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned())
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
                // Each page may read the version this app was built as: a
                // value, not a command (app_version.js).
                .initialization_script(app_version::script(&app.package_info().version.to_string()))
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
