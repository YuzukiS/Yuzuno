//! Windows: the copy is dragged as the Shell's own data object for that file,
//! the one Explorer drags (its formats include CF_HDROP, the list of real
//! paths apps take a dropped file by), through the system's drag loop with
//! its default drop source and drag image (`SHDoDragDrop`). Copy only, so
//! nothing that takes it can move or delete the copy.

use super::Outcome;
use crate::file_drag_rules as rules;
use std::{path::Path, sync::OnceLock};
use tauri::WebviewWindow;
use windows::{
    core::HSTRING,
    Win32::{
        Foundation::HWND,
        System::{
            Com::{IBindCtx, IDataObject},
            Ole::{IDropSource, OleInitialize, DROPEFFECT_COPY, DROPEFFECT_NONE},
        },
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON},
            Shell::{BHID_DataObject, IShellItem, SHCreateItemFromParsingName, SHDoDragDrop},
            WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON},
        },
    },
};

/// Windows drags files out.
pub const READY: bool = true;

/// Marks the copy as downloaded from `source`, then drags it from the main
/// window, on its thread, until it is dropped or let go.
pub async fn start(window: &WebviewWindow, path: &Path, source: &str) -> Result<Outcome, String> {
    mark(path, source);
    // A window handle is not Send; its value is.
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let path = path.to_owned();
    let (done, outcome) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = done.send(drag(HWND(hwnd as *mut _), &path));
        })
        .map_err(|e| e.to_string())?;
    outcome.await.map_err(|_| "The drag did not start.".to_owned())?
}

/// The `Zone.Identifier` stream a browser gives a download. A volume
/// without streams (FAT) keeps the file unmarked, as a browser's would be.
fn mark(path: &Path, source: &str) {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    if let Err(error) = std::fs::write(&stream, rules::zone_identifier(source)) {
        eprintln!("Unable to mark a dragged file as downloaded: {error}");
    }
}

/// Whether the primary mouse button is held now. `GetAsyncKeyState` reads
/// the physical buttons, so with the buttons swapped in Settings the
/// primary one is the right one (Microsoft's documentation of it).
fn primary_held() -> bool {
    // SAFETY: plain reads of the system's state, with valid arguments.
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    let button = if swapped { VK_RBUTTON } else { VK_LBUTTON };
    let state = unsafe { GetAsyncKeyState(i32::from(button.0)) };
    (state as u16 & 0x8000) != 0
}

/// Runs on the main window's thread, which the drag loop runs on.
fn drag(hwnd: HWND, path: &Path) -> Result<Outcome, String> {
    // The drag needs OLE on this thread. The window's own setup starts it
    // only with Tauri's drop handler, which this window turns off; started
    // once here, it stays for the app's life.
    static OLE: OnceLock<Result<(), String>> = OnceLock::new();
    OLE.get_or_init(|| {
        // SAFETY: on the window's own thread, which is already a
        // single-threaded apartment; a second start is S_FALSE, not an error.
        unsafe { OleInitialize(None) }.map_err(|error| format!("Windows could not start a drag here ({error})."))
    })
    .clone()?;
    if !primary_held() {
        return Ok(Outcome::Released);
    }
    // SAFETY: a path of a file this app just wrote, and interfaces Windows
    // returns, used only during this call on this thread.
    let data: IDataObject = unsafe {
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None::<&IBindCtx>)
            .map_err(|error| format!("Windows could not find the file to drag ({error})."))?;
        item.BindToHandler(None::<&IBindCtx>, &BHID_DataObject)
            .map_err(|error| format!("Windows could not drag this file ({error})."))?
    };
    // SAFETY: the main window's live handle and the data object above; the
    // call returns once the drag has ended.
    let effect = unsafe { SHDoDragDrop(Some(hwnd), &data, None::<&IDropSource>, DROPEFFECT_COPY) }
        .map_err(|error| format!("Windows could not drag this file ({error})."))?;
    Ok(if effect == DROPEFFECT_NONE { Outcome::Cancelled } else { Outcome::Dropped })
}
