//! macOS: the system's own window buttons stand over the workspace toolbar,
//! as on Windows the toolbar is the title bar (YN-90). The window has no
//! title bar row of its own: its title bar is transparent over the page
//! (`TitleBarStyle::Overlay`), and the buttons are moved down to the
//! toolbar's middle. The system draws them, in its own size, order and
//! spacing; only where the row of buttons starts is set here.
//!
//! The page asks `desktop_title_bar` how much room the buttons take and what
//! a double click on the bar does, both as the system reports them at the
//! time. A shell without the command (or another system) leaves the page's
//! toolbar as it is.

use crate::{connection, ConnectionState};
use serde::Serialize;
use tauri::WebviewWindow;

/// Where the close button starts, from the window's left edge, in points:
/// the toolbar's own leading padding (17px, `.toolbar` in web/src/styles.css),
/// where its logo started before the buttons took its place. Tauri's
/// documentation and Apple's guidelines give no value.
pub const LIGHTS_X: f64 = 17.0;
/// How far down the buttons are moved, in points. wry makes the title bar
/// `button height + LIGHTS_Y` tall (`inset_traffic_lights`) and AppKit
/// places the buttons in it, so no document gives the result; the Desktop
/// macOS workflow measures it with the Accessibility API on every run and
/// fails unless the close button's centre is 24±1px from the window's top:
/// the middle of the toolbar's 48px above its 1px bottom border.
pub const LIGHTS_Y: f64 = 22.0;

/// What a double click on the title bar does, as the user chose in System
/// Settings ("Double-click a window's title bar to").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DoubleClick {
    Zoom,
    Minimize,
    None,
}

/// The global `AppleActionOnDoubleClick` default: "Maximize" (Zoom),
/// "Minimize" or "None" (Do Nothing), and since macOS 15 "Fill", which has no
/// public API and zooms instead, as in Zed (zed#30468, zed#39311). Unset is
/// the system's default, Zoom.
pub fn double_click(setting: Option<&str>) -> DoubleClick {
    match setting {
        Some("Minimize") => DoubleClick::Minimize,
        Some("None") => DoubleClick::None,
        _ => DoubleClick::Zoom,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleBar {
    /// Where the zoom button ends, from the window's left edge, in points
    /// (the page's CSS pixels: the window has no page zoom). 0 while the
    /// buttons are hidden, as in full screen.
    pub inset: f64,
    pub double_click: DoubleClick,
}

/// The window buttons over the toolbar: macOS only; elsewhere `None`, and
/// the page keeps its toolbar as it is. Only for the selected workspace or
/// the connection page, as `set_appearance`. Not async: Tauri runs it on the
/// main thread, where AppKit must be called.
#[tauri::command]
pub fn desktop_title_bar(
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
) -> Result<Option<TitleBar>, String> {
    let selected = state
        .selected
        .lock()
        .map_err(|_| "Connection state unavailable.")?
        .clone();
    let url = window.url().map_err(|e| e.to_string())?;
    if !connection::permits_appearance(window.label(), &url, selected.as_ref()) {
        return Err(
            "The title bar is only available in the selected workspace or connection page.".into(),
        );
    }
    read(&window)
}

#[cfg(not(target_os = "macos"))]
fn read(_window: &WebviewWindow) -> Result<Option<TitleBar>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn read(window: &WebviewWindow) -> Result<Option<TitleBar>, String> {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
    use objc2_foundation::{ns_string, MainThreadMarker, NSUserDefaults};

    MainThreadMarker::new().ok_or("The title bar can only be read on the main thread.")?;
    let ns_window = window.ns_window().map_err(|e| e.to_string())?;
    // SAFETY: Tauri's live NSWindow of this window, used only on the main
    // thread (checked above) and only during this call.
    let ns_window: &NSWindow = unsafe { &*ns_window.cast::<NSWindow>() };
    let full_screen = ns_window
        .styleMask()
        .contains(NSWindowStyleMask::FullScreen);
    let inset = match ns_window.standardWindowButton(NSWindowButton::ZoomButton) {
        Some(zoom) if !full_screen && !zoom.isHidden() => {
            let frame = zoom.convertRect_toView(zoom.bounds(), None);
            (frame.origin.x + frame.size.width).max(0.0)
        }
        _ => 0.0,
    };
    let setting = NSUserDefaults::standardUserDefaults()
        .stringForKey(ns_string!("AppleActionOnDoubleClick"))
        .map(|setting| setting.to_string());
    Ok(Some(TitleBar {
        inset,
        double_click: double_click(setting.as_deref()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_double_click_does_what_the_system_setting_says() {
        assert_eq!(double_click(Some("Minimize")), DoubleClick::Minimize);
        assert_eq!(double_click(Some("None")), DoubleClick::None);
        assert_eq!(double_click(Some("Maximize")), DoubleClick::Zoom);
        // Fill has no public API: it zooms.
        assert_eq!(double_click(Some("Fill")), DoubleClick::Zoom);
        // Unset, or a value this app does not know: the system default.
        assert_eq!(double_click(None), DoubleClick::Zoom);
        assert_eq!(double_click(Some("minimize")), DoubleClick::Zoom);
    }

    #[test]
    fn the_page_reads_the_answer_in_its_own_words() {
        let answer = serde_json::to_value(TitleBar {
            inset: 71.5,
            double_click: DoubleClick::None,
        })
        .unwrap();
        assert_eq!(answer, serde_json::json!({ "inset": 71.5, "doubleClick": "none" }));
    }
}
