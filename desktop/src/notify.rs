//! System notifications from the selected workspace (T-188). On Windows the
//! workspace page hands a notification to the system through this app's own
//! two commands, granted to the selected Core's origin only, beside the
//! desktop update commands. Whether Windows then shows it (its notification
//! settings, Focus) is the system's, and this app cannot read it.
//!
//! On macOS the same commands go through UNUserNotificationCenter, which
//! keeps the user's answer for this app: the page reads it, a click there may
//! ask for it once (a third command), and each notification is sent only
//! after reading it again, as the user can change it in System Settings at
//! any time. Every wait there is macOS's own; after one, the selected
//! workspace is checked again before macOS is asked or given anything.
//!
//! The ask covers the dock badge too (YN-94): macOS shows the dock icon's
//! number of an app that asked for notifications only while its "Badge
//! application icon" is on, a switch System Settings offers only to an app
//! that asked for badges. An app allowed before without badges asks once
//! more, which shows no prompt (`ask_for_badge_once`); the page says where
//! the switch is (`badge` in its answer).
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
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;
use url::Url;

/// The systems this app has been checked to notify on through the plugin.
/// Elsewhere it says it cannot, until it is checked there. macOS has its own
/// way (`mac`).
#[cfg(not(target_os = "macos"))]
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
    /// Whether one would be handed on now. On macOS: whether macOS allows them.
    supported: bool,
    /// The system it hands them to, when it can.
    system: Option<&'static str>,
    /// macOS: what it allows this app now (`notification_text::Allowed`).
    #[serde(skip_serializing_if = "Option::is_none")]
    authorization: Option<&'static str>,
    /// macOS: the dock badge, "on", "off" or "not-requested" (no "Badge
    /// application icon" switch for this app yet), when macOS says (YN-94).
    #[serde(skip_serializing_if = "Option::is_none")]
    badge: Option<&'static str>,
    /// macOS: why it couldn't be read, when it couldn't.
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[cfg(not(target_os = "macos"))]
fn here() -> Notifications {
    Notifications { supported: CHECKED, system: CHECKED.then_some("windows"), authorization: None, badge: None, reason: None }
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

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn desktop_notifications(window: WebviewWindow, connection: tauri::State<'_, ConnectionState>) -> Result<Notifications, String> {
    workspace(&window, &connection)?;
    Ok(here())
}

/// Asks the system to allow this app's notifications. Only macOS has
/// anything to ask; here it answers as `desktop_notifications`.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn desktop_notifications_request(window: WebviewWindow, connection: tauri::State<'_, ConnectionState>) -> Result<Notifications, String> {
    desktop_notifications(window, connection)
}

/// What became of a notification handed to this app.
#[derive(Serialize)]
pub struct Handed {
    /// Given to the system (on macOS: accepted by it). False: not given,
    /// `held` says why.
    handed: bool,
    /// "looking": one meant for while the user looks elsewhere, held back
    /// because this window is in front. Nothing was shown; nothing failed.
    held: Option<&'static str>,
}

/// Hands one notification to the system. `handed` means only that: whether
/// the system shows it is not reported back. With `when_away`, one meant for
/// while the user looks elsewhere, it is held back while this window is in
/// front (`notification_text::shown_now`), as the window reports it; a state
/// that can't be read is an error, never taken for away. A page that sends
/// no `when_away` (an older one) is handed on as before. Whether to hand it
/// on is decided first; then what it says is checked.
#[cfg(not(target_os = "macos"))]
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
    if when_away.unwrap_or(false) {
        let unread = |error: tauri::Error| format!("This app couldn't read whether its window is in front: {error}");
        let focused = window.is_focused().map_err(unread)?;
        let minimized = window.is_minimized().map_err(unread)?;
        if !notification_text::shown_now(true, focused, minimized) {
            return Ok(Handed { handed: false, held: Some("looking") });
        }
    }
    let (title, body) = notification_text::checked(&title, &body)?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("The system didn't take the notification: {error}"))?;
    Ok(Handed { handed: true, held: None })
}

/// Whether the window is in front, for one meant for while the user looks
/// elsewhere: a state that can't be read is an error, never taken for away.
#[cfg(target_os = "macos")]
fn in_front(window: &WebviewWindow) -> Result<bool, String> {
    let unread = |error: tauri::Error| format!("This app couldn't read whether its window is in front: {error}");
    let focused = window.is_focused().map_err(unread)?;
    let minimized = window.is_minimized().map_err(unread)?;
    Ok(!notification_text::shown_now(true, focused, minimized))
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn desktop_notifications(window: WebviewWindow, connection: tauri::State<'_, ConnectionState>) -> Result<Notifications, String> {
    workspace(&window, &connection)?;
    Ok(mac::answer(mac::read().await))
}

/// Asks macOS to allow this app's notifications, the dock badge included,
/// from the page's click, only when the user has not been asked: macOS
/// shows its prompt once, and a denial is changed in System Settings, not
/// asked again. What macOS says it granted is not taken as the answer: what
/// it says afterwards is. An error is why macOS wasn't asked.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn desktop_notifications_request(window: WebviewWindow, connection: tauri::State<'_, ConnectionState>) -> Result<Notifications, String> {
    workspace(&window, &connection)?;
    let before = mac::read().await;
    if !matches!(before, Ok((allowed, _)) if allowed.asks()) {
        return Ok(mac::answer(before));
    }
    // Meanwhile another Core may have been selected.
    workspace(&window, &connection)?;
    mac::request().await?;
    Ok(mac::answer(mac::read().await))
}

/// Asks macOS once more, now with the dock badge, when the user has
/// allowed this app's notifications and its badge isn't on (YN-94): an app
/// allowed before asked for alerts and sounds only, so System Settings has
/// no "Badge application icon" switch for it, and macOS drops the dock
/// icon's number. Asked again, macOS shows no prompt (Apple: "Subsequent
/// calls to this method don't prompt the person again"); the switch then
/// appears for the user to turn on. Called with each badge the selected
/// workspace sets; at most one ask per run. Not asked yet, turned off,
/// quiet or unread: never asked from here.
#[cfg(target_os = "macos")]
pub fn ask_for_badge_once(window: WebviewWindow) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::Manager;
    static ASKED: AtomicBool = AtomicBool::new(false);
    if ASKED.load(Ordering::Relaxed) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(settings) = mac_usernotifications::get_notification_settings().await else { return };
        if !mac::asks_for_badge(settings.authorization_status, settings.badge_enabled) {
            return;
        }
        // Meanwhile another Core may have been selected.
        if workspace(&window, &window.state::<ConnectionState>()).is_err() {
            return;
        }
        if ASKED.swap(true, Ordering::Relaxed) {
            return;
        }
        if let Err(error) = mac::request().await {
            eprintln!("Unable to ask macOS for the dock badge: {error}");
        }
    });
}

/// As on Windows, and only while macOS allows this app's notifications, as
/// it says now. `handed` means macOS accepted it.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn desktop_notify(
    window: WebviewWindow,
    connection: tauri::State<'_, ConnectionState>,
    title: String,
    body: String,
    when_away: Option<bool>,
) -> Result<Handed, String> {
    workspace(&window, &connection)?;
    let allowed = mac::allowed().await.map_err(|reason| format!("macOS's permission couldn't be read: {reason}"))?;
    if !allowed.sends() {
        return Err("macOS doesn't allow this app's notifications now.".into());
    }
    if when_away.unwrap_or(false) && in_front(&window)? {
        return Ok(Handed { handed: false, held: Some("looking") });
    }
    let (title, body) = notification_text::checked(&title, &body)?;
    // Meanwhile another Core may have been selected.
    workspace(&window, &connection)?;
    mac_usernotifications::send(mac_usernotifications::Notification::new().title(title).message(body))
        .await
        .map_err(|error| format!("macOS didn't take the notification: {}", mac::said(error)))?;
    Ok(Handed { handed: true, held: None })
}

/// macOS's notification center, through mac-usernotifications, and asked
/// directly for what that crate doesn't ask for (the badge).
#[cfg(target_os = "macos")]
mod mac {
    use super::Notifications;
    use crate::notification_text::Allowed;
    use block2::RcBlock;
    use mac_usernotifications::{AuthorizationStatus, Error, NotificationSettingStatus};
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
    use std::cell::Cell;

    pub fn from_status(status: AuthorizationStatus) -> Allowed {
        match status {
            AuthorizationStatus::NotDetermined => Allowed::NotRequested,
            AuthorizationStatus::Authorized => Allowed::Yes,
            AuthorizationStatus::Provisional => Allowed::Quiet,
            AuthorizationStatus::Denied => Allowed::Denied,
            // Ephemeral is App Clips' (iOS); Unknown, a state macOS added.
            AuthorizationStatus::Ephemeral | AuthorizationStatus::Unknown => Allowed::Unknown,
        }
    }

    /// The crate's error, in this app's words where it has them.
    pub fn said(error: Error) -> String {
        match error {
            // macOS's notification center needs one (a cargo run has none).
            Error::NoBundleIdentifier => "this app isn't running from its app bundle".into(),
            error => error.to_string(),
        }
    }

    /// The page's word for the dock badge (YN-94): "not-requested" is an app
    /// that never asked for badges, with no "Badge application icon" switch.
    pub fn badge_word(setting: NotificationSettingStatus) -> Option<&'static str> {
        match setting {
            NotificationSettingStatus::Enabled => Some("on"),
            NotificationSettingStatus::Disabled => Some("off"),
            NotificationSettingStatus::NotSupported => Some("not-requested"),
            NotificationSettingStatus::Unknown => None,
        }
    }

    /// Whether to ask again for the badge (`super::ask_for_badge_once`):
    /// only once the user has allowed this app's notifications, which macOS
    /// does not ask about again, and while its badge isn't on. Quiet
    /// (provisional) is left alone: Apple doesn't say a request then shows
    /// no prompt, and this app never asks for it.
    pub fn asks_for_badge(status: AuthorizationStatus, badge: NotificationSettingStatus) -> bool {
        status == AuthorizationStatus::Authorized && badge != NotificationSettingStatus::Enabled
    }

    /// What macOS allows this app now, and its dock badge, read each time,
    /// or why it couldn't be.
    pub async fn read() -> Result<(Allowed, Option<&'static str>), String> {
        let settings = mac_usernotifications::get_notification_settings().await.map_err(said)?;
        Ok((from_status(settings.authorization_status), badge_word(settings.badge_enabled)))
    }

    /// What macOS allows this app now, or why it couldn't be read.
    pub async fn allowed() -> Result<Allowed, String> {
        read().await.map(|(allowed, _)| allowed)
    }

    /// Asks macOS for alerts, sounds and the dock badge (YN-94):
    /// mac-usernotifications asks for the first two only. Like that crate,
    /// it first checks this app runs from its bundle, without which the
    /// notification center can't be used at all. Any thread may use the
    /// center, and its answer may come on another (Apple). What it says it
    /// granted is not used: what macOS says afterwards is (`read`).
    pub async fn request() -> Result<(), String> {
        mac_usernotifications::check_bundle().map_err(said)?;
        // The block and the center are not Send: they are gone before the wait.
        let answered = {
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let tx = Cell::new(Some(tx));
            UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
                &RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(());
                    }
                }),
            );
            rx
        };
        answered.await.map_err(|_| "macOS didn't answer".to_string())
    }

    pub fn answer(read: Result<(Allowed, Option<&'static str>), String>) -> Notifications {
        let (allowed, badge, reason) = match read {
            Ok((allowed, badge)) => (allowed, badge, None),
            Err(reason) => (Allowed::Unknown, None, Some(reason)),
        };
        Notifications { supported: allowed.sends(), system: Some("macos"), authorization: Some(allowed.word()), badge, reason }
    }
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

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn only_a_checked_system_says_it_can_notify() {
        let here = super::here();
        assert_eq!(here.supported, cfg!(windows));
        assert_eq!(here.system, cfg!(windows).then_some("windows"));
        assert_eq!(serde_json::to_value(&here).unwrap().as_object().map(|o| o.len()), Some(2), "no macOS fields");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_says_what_it_allows_and_an_unread_state_is_not_a_denial() {
        use super::mac::{answer, from_status};
        use crate::notification_text::Allowed;
        use mac_usernotifications::AuthorizationStatus as S;
        let read = [S::NotDetermined, S::Authorized, S::Provisional, S::Denied, S::Ephemeral, S::Unknown].map(from_status);
        assert_eq!(read, [Allowed::NotRequested, Allowed::Yes, Allowed::Quiet, Allowed::Denied, Allowed::Unknown, Allowed::Unknown]);
        let json = |read| serde_json::to_value(answer(read)).unwrap();
        assert_eq!(
            json(Ok((Allowed::Quiet, Some("on")))),
            serde_json::json!({ "supported": true, "system": "macos", "authorization": "quiet", "badge": "on" })
        );
        assert_eq!(
            json(Ok((Allowed::NotRequested, None))),
            serde_json::json!({ "supported": false, "system": "macos", "authorization": "not-requested" })
        );
        assert_eq!(
            json(Err("unreadable".into())),
            serde_json::json!({ "supported": false, "system": "macos", "authorization": "unknown", "reason": "unreadable" })
        );
    }

    // YN-94: the dock badge as the page names it, and when it is asked for
    // again: only once allowed (no prompt then) and while it isn't on.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_badge_is_named_and_asked_for_again_only_once_allowed_and_not_on() {
        use super::mac::{asks_for_badge, badge_word};
        use mac_usernotifications::{AuthorizationStatus as S, NotificationSettingStatus as B};
        let badges = [B::Enabled, B::Disabled, B::NotSupported, B::Unknown];
        assert_eq!(badges.map(badge_word), [Some("on"), Some("off"), Some("not-requested"), None]);
        let statuses = [S::NotDetermined, S::Authorized, S::Provisional, S::Denied, S::Ephemeral, S::Unknown];
        let asked: Vec<_> = statuses
            .iter()
            .flat_map(|&status| badges.iter().map(move |&badge| (status, badge)))
            .filter(|&(status, badge)| asks_for_badge(status, badge))
            .collect();
        // Never before the user's own answer (not asked yet), after a no,
        // while quiet, or for a state this app doesn't know.
        assert_eq!(asked, [(S::Authorized, B::Disabled), (S::Authorized, B::NotSupported), (S::Authorized, B::Unknown)]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn without_its_app_bundle_macos_is_not_asked() {
        // A test binary has no bundle identifier: both refuse before
        // touching the notification center (which would crash without one).
        let read = tauri::async_runtime::block_on(super::mac::allowed());
        assert_eq!(read, Err("this app isn't running from its app bundle".into()));
        let asked = tauri::async_runtime::block_on(super::mac::request());
        assert_eq!(asked, Err("this app isn't running from its app bundle".into()));
    }
}
