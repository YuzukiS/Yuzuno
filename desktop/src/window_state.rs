//! The window's state since the app opened (YN-221 S8), for Copy
//! diagnostics: visible, minimized or hidden, whether it has focus, its last
//! changes and how long it was in each (`window_state_rules`). It answers
//! `desktop_window_state` to the selected Core's workspace page only (the
//! T-188 rule, as `desktop_badge`), and records nothing anywhere else.
//!
//! The system reports focus, and minimizing and restoring as a resize; it
//! does not report being covered by another window, nor every show and hide,
//! so the state is also read again from the window each time an event comes
//! and each time the page asks. A window another covers counts as visible. A
//! read that fails makes the state unknown, never a guess: what was seen
//! before stays in the log, and the time until a read works again counts
//! toward no state.

use crate::{connection, window_state_rules as rules, ConnectionState};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{WebviewWindow, WindowEvent};

static START: OnceLock<Instant> = OnceLock::new();
static LOG: Mutex<Option<rules::Log>> = Mutex::new(None);

fn now_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The state the window is in now, as the system says; None when it can't say.
fn read(window: &WebviewWindow) -> Option<rules::State> {
    rules::observed(window.is_visible().ok(), window.is_minimized().ok())
}

/// Reads the window again; a read that fails is noted as unknown.
fn refresh(window: &WebviewWindow) {
    let state = read(window);
    if let Ok(mut log) = LOG.lock() {
        if let Some(log) = log.as_mut() {
            log.note(now_ms(), state);
        }
    }
}

/// Starts the log for the main window and follows its events.
pub fn watch(window: &WebviewWindow) {
    let at = now_ms();
    let state = read(window);
    let focused = window.is_focused().ok();
    if let Ok(mut log) = LOG.lock() {
        *log = Some(rules::Log::new(at, state, focused));
    }
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(focused) => {
            if let Ok(mut log) = LOG.lock() {
                if let Some(log) = log.as_mut() {
                    log.focus(Some(*focused));
                }
            }
            refresh(&handle);
        }
        WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => refresh(&handle),
        _ => {}
    });
}

/// The window's state for Copy diagnostics, to the selected workspace's page.
#[tauri::command]
pub fn desktop_window_state(
    window: WebviewWindow,
    connection: tauri::State<'_, ConnectionState>,
) -> Result<Value, String> {
    let selected = connection
        .selected
        .lock()
        .map_err(|_| "Connection state unavailable.")?
        .clone();
    let url = window.url().map_err(|e| e.to_string())?;
    if !connection::permits_workspace(window.label(), &url, selected.as_ref()) {
        return Err("The window's state is only available in the selected workspace.".into());
    }
    refresh(&window);
    let log = LOG.lock().map_err(|_| "Window state unavailable.")?;
    let Some(log) = log.as_ref() else {
        return Err("The window's state is not recorded.".into());
    };
    let report = log.report(now_ms());
    // "unknown" where the system could not say; focus null until it said.
    Ok(json!({
        "state": rules::name_of(report.state),
        "focused": report.focused,
        "totals": {"visibleMs": report.visible_ms, "minimizedMs": report.minimized_ms, "hiddenMs": report.hidden_ms},
        "changes": report.changes.iter().map(|c| json!({"sinceStartMs": c.since_start_ms, "state": rules::name_of(c.state)})).collect::<Vec<_>>(),
        "dropped": report.dropped,
    }))
}
