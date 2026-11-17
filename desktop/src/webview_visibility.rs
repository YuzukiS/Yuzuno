//! The page is hidden while the window is minimized (YN-199).
//!
//! WebView2 runs in a child window that gets no message when the app's
//! window is minimized or restored, and wry 0.57 (under Tauri) skips
//! `WM_SIZE` with `SIZE_MINIMIZED` without changing the WebView's
//! `IsVisible`. So a minimized window's page went on drawing frames and
//! running its animations, and read itself as visible.
//!
//! WebView2's guidance, `ICoreWebView2Controller::put_IsVisible`: "For
//! performance reasons, developers should set the IsVisible property of the
//! WebView to FALSE when the app window is minimized and back to TRUE when
//! the app window is restored", by handling `SIZE_MINIMIZED` and
//! `SIZE_RESTORED`. A hidden page's animations stop and some of its tasks
//! run less often; its scripts still run, so the live stream and the notices
//! meant for while the user is away go on. Nothing here suspends the page.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{WebviewWindow, WindowEvent};

/// The WebView's visibility once the window is or is not minimized, when it
/// changes; `None` when it stays as it is.
fn change(shown: bool, minimized: bool) -> Option<bool> {
    (shown == minimized).then_some(!minimized)
}

/// Keep the page hidden while the window is minimized, shown otherwise.
/// Tao reports minimizing and restoring as `Resized` (`WM_SIZE`).
pub fn follow(window: &WebviewWindow) {
    let shown = Arc::new(AtomicBool::new(true));
    let handle = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }
        let Ok(minimized) = handle.is_minimized() else {
            return;
        };
        let Some(visible) = change(shown.load(Ordering::Relaxed), minimized) else {
            return;
        };
        shown.store(visible, Ordering::Relaxed);
        let set = handle.with_webview(move |webview| {
            // SAFETY: Tauri hands out the window's live controller on the
            // main thread for this call; IsVisible only takes a BOOL.
            if let Err(error) = unsafe { webview.controller().SetIsVisible(visible) } {
                eprintln!("Unable to set the page's visibility: {error}");
            }
        });
        if let Err(error) = set {
            eprintln!("Unable to reach the page to set its visibility: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::change;

    #[test]
    fn hidden_while_minimized_and_shown_again_once_restored() {
        assert_eq!(change(true, true), Some(false));
        assert_eq!(change(false, false), Some(true));
    }

    #[test]
    fn a_resize_that_changes_nothing_sets_nothing() {
        assert_eq!(change(true, false), None);
        assert_eq!(change(false, true), None);
    }
}
