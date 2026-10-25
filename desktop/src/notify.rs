//! System notifications from the selected workspace (T-188). On Windows the
//! workspace page hands a notification to the system through this app's own
//! two commands, granted to the selected Core's origin only, beside the
//! desktop update commands. Whether Windows then shows it (its notification
//! settings, Focus) is the system's, and this app cannot read it.
//!
//! The notification plugin is used for its Rust API alone. Its page script,
//! which would replace every page's `window.Notification` with calls to the
//! plugin's own commands, is left out, and so are those commands: no page is
//! granted them, and with them left out no capability could reach them.

use crate::{connection, notification_text, ConnectionState};
use serde::Serialize;
use tauri::{
    ipc::Invoke,
    plugin::Plugin,
    webview::PageLoadPayload,
    AppHandle, RunEvent, Runtime, Webview, WebviewWindow, Window,
};
use tauri_plugin_notification::NotificationExt;
use url::Url;

/// The systems this app has been checked to notify on. Elsewhere it says it
/// cannot, until it is checked there.
const CHECKED: bool = cfg!(windows);

/// The notification plugin without its page script or page commands.
pub fn plugin<R: Runtime>() -> impl Plugin<R> + 'static {
    RustOnly(tauri_plugin_notification::init())
}

struct RustOnly<P>(P);

impl<R: Runtime, P: Plugin<R>> Plugin<R> for RustOnly<P> {
    fn name(&self) -> &'static str {
        self.0.name()
    }
    fn initialize(&mut self, app: &AppHandle<R>, config: serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }
    fn initialization_script(&self) -> Option<String> {
        None
    }
    fn window_created(&mut self, window: Window<R>) {
        self.0.window_created(window)
    }
    fn webview_created(&mut self, webview: Webview<R>) {
        self.0.webview_created(webview)
    }
    fn on_navigation(&mut self, webview: &Webview<R>, url: &Url) -> bool {
        self.0.on_navigation(webview, url)
    }
    fn on_page_load(&mut self, webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
        self.0.on_page_load(webview, payload)
    }
    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        self.0.on_event(app, event)
    }
    fn extend_api(&mut self, _invoke: Invoke<R>) -> bool {
        false
    }
}

/// Whether this app can hand notifications to this system.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notifications {
    supported: bool,
    /// The system it hands them to, when it can.
    system: Option<&'static str>,
}

fn here() -> Notifications {
    Notifications { supported: CHECKED, system: CHECKED.then_some("windows") }
}

/// The selected Core, when this call comes from that Core's workspace page.
fn workspace(window: &WebviewWindow, state: &ConnectionState) -> Result<(), String> {
    let selected = state.selected.lock().map_err(|_| "Connection state unavailable.")?.clone();
    let url = window.url().map_err(|e| e.to_string())?;
    if !connection::permits_workspace(window.label(), &url, selected.as_ref()) {
        return Err("System notifications are only available in the selected workspace.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_notifications(window: WebviewWindow, connection: tauri::State<'_, ConnectionState>) -> Result<Notifications, String> {
    workspace(&window, &connection)?;
    Ok(here())
}

/// What became of a notification handed to this app.
#[derive(Serialize)]
pub struct Handed {
    /// Given to the system. False: held back, the window being in front.
    handed: bool,
}

/// Hands one notification to the system. `handed` means only that: whether
/// the system shows it is not reported back. With `when_away`, one meant for
/// while the user looks elsewhere, it is held back while this window is in
/// front (`notification_text::shown_now`); a page that sends none (an older
/// one) is handed on as before.
#[tauri::command]
pub fn desktop_notify(
    app: AppHandle,
    window: WebviewWindow,
    connection: tauri::State<'_, ConnectionState>,
    title: String,
    body: String,
    when_away: Option<bool>,
) -> Result<Handed, String> {
    workspace(&window, &connection)?;
    if !CHECKED {
        return Err("This app can't show system notifications on this system yet.".into());
    }
    let (title, body) = notification_text::checked(&title, &body)?;
    let focused = window.is_focused().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    if !notification_text::shown_now(when_away.unwrap_or(false), focused, minimized) {
        return Ok(Handed { handed: false });
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("The system didn't take the notification: {error}"))?;
    Ok(Handed { handed: true })
}

#[cfg(test)]
mod tests {
    use tauri::plugin::Plugin;

    #[test]
    fn the_notification_plugin_gives_no_page_its_script() {
        // As published, it replaces every page's window.Notification.
        assert!(tauri_plugin_notification::init::<tauri::Wry>().initialization_script_2().is_some());
        let plugin = super::plugin::<tauri::Wry>();
        assert_eq!(plugin.initialization_script(), None);
        assert!(plugin.initialization_script_2().is_none());
        assert_eq!(plugin.name(), "notification");
    }

    #[test]
    fn only_a_checked_system_says_it_can_notify() {
        let here = super::here();
        assert_eq!(here.supported, cfg!(windows));
        assert_eq!(here.system, cfg!(windows).then_some("windows"));
    }
}
