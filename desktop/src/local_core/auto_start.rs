//! The switch for starting this computer's confirmed Core by itself when the
//! app opens (YN-107 design section 6, parts 1 and 4; the user chose "start
//! it when the app opens" in design/yn108-mac-core). Windows and the Mac
//! share it. It is the top-level `autoStartLocalCore` of `core.json`, beside
//! the saved Workspaces, and a record without it means on.
//!
//! Setting it starts nothing. The connection page reads it from
//! `connection_info` when the app opens and, if the last Workspace is this
//! computer's confirmed Core and does not answer, calls `start_core` itself:
//! once, never for an unconfirmed entry, and not again after a failure.

use super::{require_connection_page, Error};
use serde::Serialize;
use tauri::{Manager, WebviewWindow};

/// The switch as it is saved now.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AutoStart {
    enabled: bool,
}

#[tauri::command]
pub fn local_core_auto_start(window: WebviewWindow, enabled: bool) -> Result<AutoStart, Error> {
    require_connection_page(&window)?;
    let app = window.app_handle();
    let saved = crate::read_entries(app);
    // A record that cannot be read is written over by nothing: a list built
    // from it would replace every Workspace it still holds.
    if let Some(reason) = crate::entries::unusable(&saved) {
        return Err(Error::new(
            "savedUnusable",
            format!("The workspaces saved on this computer could not be read ({reason}). Nothing was changed."),
        ));
    }
    let crate::entries::Saved::Entries { entries, selected, remembered, .. } = &saved else {
        return Err(Error::new(
            "nothingSaved",
            "No workspace is saved on this computer yet, so there is nothing to start by itself.",
        ));
    };
    crate::write_entries(app, entries, selected.as_deref(), remembered, enabled).map_err(|error| {
        Error::new("notSaved", format!("This computer could not save the change ({error}). The setting is as it was."))
    })?;
    // What was written, as the next launch will read it.
    Ok(AutoStart { enabled: crate::read_entries(app).auto_start() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_has_the_shared_shape() {
        assert_eq!(serde_json::to_value(AutoStart { enabled: false }).unwrap(), serde_json::json!({"enabled": false}));
    }
}
