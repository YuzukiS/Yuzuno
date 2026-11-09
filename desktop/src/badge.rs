//! Home's "needs you" count on the Windows taskbar button (YN-43): the
//! approved bubble (`badge_rules`) as the button's overlay icon, with words
//! for screen readers. Only the selected Core's workspace page may set it
//! (the T-188 rule), and it sends the count only when it changes.
//!
//! Windows draws an overlay at the lower-right of the button. Tauri's own
//! `set_overlay_icon` takes no words for screen readers, so this calls
//! ITaskbarList3::SetOverlayIcon itself. Windows forgets overlays when
//! Explorer restarts and then sends TaskbarButtonCreated; the last badge is
//! set again then, and when the window moves to a display with another
//! scale. The badge goes when the window leaves the selected workspace.
//! Nothing flashes or asks for attention. Other systems accept the count and
//! show nothing; a macOS dock badge is later work.

use crate::{badge_rules, connection, ConnectionState};
use std::sync::Mutex;
use tauri::WebviewWindow;
use url::Url;

/// A badge the page asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shown {
    pub count: u32,
    pub lang: badge_rules::Lang,
}

/// The badge shown now, kept to set it again after TaskbarButtonCreated or
/// a scale change. None: no badge.
static SHOWN: Mutex<Option<Shown>> = Mutex::new(None);

/// What a call may set: only from the selected Core's workspace page in the
/// main window, with a count and language `badge_rules` accepts.
pub fn accepted(
    window_label: &str,
    url: &Url,
    selected: Option<&Url>,
    count: i64,
    lang: &str,
) -> Result<Shown, String> {
    if !connection::permits_workspace(window_label, url, selected) {
        return Err("The taskbar badge is only available in the selected workspace.".into());
    }
    Ok(Shown {
        count: badge_rules::checked(count)?,
        lang: badge_rules::lang(lang)?,
    })
}

/// Sets the badge to Home's count; 0 takes it off.
#[tauri::command]
pub fn desktop_badge(
    window: WebviewWindow,
    connection: tauri::State<'_, ConnectionState>,
    count: i64,
    lang: String,
) -> Result<(), String> {
    let selected = connection
        .selected
        .lock()
        .map_err(|_| "Connection state unavailable.")?
        .clone();
    let url = window.url().map_err(|e| e.to_string())?;
    let shown = accepted(window.label(), &url, selected.as_ref(), count, &lang)?;
    show(&window, Some(shown));
    Ok(())
}

/// Takes the badge off: the window no longer shows the selected workspace.
pub fn clear(window: &WebviewWindow) {
    show(window, None);
}

fn show(window: &WebviewWindow, shown: Option<Shown>) {
    let shown = shown.filter(|s| s.count > 0);
    {
        let Ok(mut current) = SHOWN.lock() else { return };
        if *current == shown {
            return;
        }
        *current = shown;
    }
    #[cfg(windows)]
    win::apply_later(window);
    #[cfg(not(windows))]
    let _ = window;
}

/// Watches the window for a new taskbar button or display scale (Windows).
pub fn watch(window: &WebviewWindow) {
    #[cfg(windows)]
    win::watch(window);
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod win {
    use super::SHOWN;
    use crate::badge_rules;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::OnceLock;
    use tauri::WebviewWindow;
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPV5HEADER, BI_BITFIELDS,
        DIB_RGB_COLORS,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, DestroyIcon, RegisterWindowMessageW, HICON, ICONINFO, WM_DPICHANGED,
    };

    /// This module's window subclass.
    const SUBCLASS_ID: usize = 0x5945_4e34; // "YN4"
    /// The window's DPI; 96 is 100%.
    static DPI: AtomicU32 = AtomicU32::new(96);

    fn taskbar_button_created() -> u32 {
        static MESSAGE: OnceLock<u32> = OnceLock::new();
        // SAFETY: a constant, NUL-terminated name.
        *MESSAGE.get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) })
    }

    fn note_scale(window: &WebviewWindow) {
        if let Ok(scale) = window.scale_factor() {
            if scale.is_finite() && scale > 0.0 {
                DPI.store((scale * 96.0).round() as u32, Ordering::Relaxed);
            }
        }
    }

    pub fn watch(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        note_scale(window);
        let _ = taskbar_button_created();
        // SAFETY: called on the thread that created this live window, with
        // a subclass procedure that lives as long as the program.
        unsafe {
            let _ = SetWindowSubclass(HWND(hwnd.0), Some(subclass), SUBCLASS_ID, 0);
        }
    }

    pub fn apply_later(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        note_scale(window);
        // A window handle is not Send; its value is.
        let raw = hwnd.0 as isize;
        let _ = window.run_on_main_thread(move || apply(HWND(raw as *mut _)));
    }

    unsafe extern "system" fn subclass(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        // SAFETY: Windows calls this with the window's own message.
        let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
        if message == WM_DPICHANGED {
            // The new DPI is in the low word (both words are the same).
            DPI.store((wparam.0 & 0xffff) as u32, Ordering::Relaxed);
            apply(hwnd);
        } else if message == taskbar_button_created() {
            apply(hwnd);
        }
        result
    }

    /// Puts the badge shown now on the window's taskbar button, or takes it
    /// off. Runs on the window's thread.
    fn apply(hwnd: HWND) {
        let shown = SHOWN.lock().ok().and_then(|s| *s);
        let scale = DPI.load(Ordering::Relaxed) as f64 / 96.0;
        if let Err(error) = set_overlay(hwnd, shown, scale) {
            eprintln!("Unable to set the taskbar badge: {error}");
        }
    }

    fn set_overlay(hwnd: HWND, shown: Option<super::Shown>, scale: f64) -> Result<(), String> {
        // SAFETY: COM on the window's own thread, balanced below when this
        // call initialized it (S_OK or S_FALSE).
        let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let result = (|| {
            // SAFETY: the system's own taskbar object, used on this thread.
            let taskbar: ITaskbarList3 = unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) }
                .map_err(|e| e.to_string())?;
            unsafe { taskbar.HrInit() }.map_err(|e| e.to_string())?;
            let Some((shown, label)) = shown.and_then(|s| badge_rules::label(s.count).map(|l| (s, l))) else {
                // SAFETY: a null icon removes this window's overlay.
                return unsafe { taskbar.SetOverlayIcon(hwnd, HICON::default(), PCWSTR::null()) }
                    .map_err(|e| e.to_string());
            };
            let size = badge_rules::size_for_scale(scale);
            let png = badge_rules::asset(label, size).ok_or("No badge picture at this size.")?;
            let icon = icon(png)?;
            let text = HSTRING::from(badge_rules::alt_text(shown.count, shown.lang));
            // SAFETY: a live icon; the taskbar keeps its own copy, so it is
            // destroyed right after.
            let set = unsafe { taskbar.SetOverlayIcon(hwnd, icon, &text) }.map_err(|e| e.to_string());
            unsafe {
                let _ = DestroyIcon(icon);
            }
            set
        })();
        if init.is_ok() {
            // SAFETY: balances the CoInitializeEx above.
            unsafe { CoUninitialize() };
        }
        result
    }

    /// An icon with per-pixel alpha from one of the approved PNGs.
    fn icon(png: &[u8]) -> Result<HICON, String> {
        let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
        decoder.set_transformations(png::Transformations::EXPAND);
        let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
        let mut rgba = vec![0; reader.output_buffer_size().ok_or("The badge picture is too large.")?];
        let frame = reader.next_frame(&mut rgba).map_err(|e| e.to_string())?;
        if frame.color_type != png::ColorType::Rgba || frame.bit_depth != png::BitDepth::Eight {
            return Err("The badge picture is not 8-bit RGBA.".into());
        }
        let (width, height) = (frame.width as i32, frame.height as i32);
        let header = BITMAPV5HEADER {
            bV5Size: std::mem::size_of::<BITMAPV5HEADER>() as u32,
            bV5Width: width,
            // Negative: rows from the top, as the PNG has them.
            bV5Height: -height,
            bV5Planes: 1,
            bV5BitCount: 32,
            bV5Compression: BI_BITFIELDS,
            bV5RedMask: 0x00ff_0000,
            bV5GreenMask: 0x0000_ff00,
            bV5BlueMask: 0x0000_00ff,
            bV5AlphaMask: 0xff00_0000,
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        // SAFETY: a 32-bit top-down section of width × height pixels; Windows
        // allocates it and gives back its pixels.
        let color = unsafe {
            CreateDIBSection(None, (&header as *const BITMAPV5HEADER).cast::<BITMAPINFO>(), DIB_RGB_COLORS, &mut bits, None, 0)
        }
        .map_err(|e| e.to_string())?;
        // SAFETY: the section holds exactly width × height BGRA pixels.
        let pixels = unsafe { std::slice::from_raw_parts_mut(bits.cast::<u8>(), (width * height * 4) as usize) };
        for (to, from) in pixels.chunks_exact_mut(4).zip(rgba[..frame.buffer_size()].chunks_exact(4)) {
            to.copy_from_slice(&[from[2], from[1], from[0], from[3]]);
        }
        // An empty mask: the colour bitmap's alpha decides what shows.
        let mask_bits = vec![0u8; ((width as usize + 15) / 16 * 2) * height as usize];
        // SAFETY: a 1-bit bitmap of the same size from a buffer that fits it.
        let mask = unsafe { CreateBitmap(width, height, 1, 1, Some(mask_bits.as_ptr().cast())) };
        let info = ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        };
        // SAFETY: both bitmaps are live; the icon copies them, so they are
        // deleted right after.
        let icon = unsafe { CreateIconIndirect(&info) }.map_err(|e| e.to_string());
        unsafe {
            let _ = DeleteObject(color.into());
            let _ = DeleteObject(mask.into());
        }
        icon
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use badge_rules::Lang;

    #[test]
    fn only_the_selected_workspace_sets_the_badge() {
        let core = Url::parse("http://127.0.0.1:4317").unwrap();
        let workspace = Url::parse("http://127.0.0.1:4317/?shell=desktop").unwrap();
        assert_eq!(
            accepted("main", &workspace, Some(&core), 3, "zh"),
            Ok(Shown { count: 3, lang: Lang::Zh })
        );
        // Another window, no selected Core, the connection page or another
        // origin (port included) is refused, whatever the count.
        assert!(accepted("other", &workspace, Some(&core), 3, "en").is_err());
        assert!(accepted("main", &workspace, None, 3, "en").is_err());
        for url in [
            "http://tauri.localhost/index.html",
            "tauri://localhost/index.html",
            "http://127.0.0.1:4318/",
            "https://example.com/",
        ] {
            let url = Url::parse(url).unwrap();
            assert!(accepted("main", &url, Some(&core), 3, "en").is_err(), "{url}");
        }
    }

    #[test]
    fn counts_and_languages_out_of_range_are_refused() {
        let core = Url::parse("http://127.0.0.1:4317").unwrap();
        for count in [-1, badge_rules::MAX_COUNT + 1] {
            assert!(accepted("main", &core, Some(&core), count, "en").is_err(), "{count}");
        }
        assert!(accepted("main", &core, Some(&core), 3, "fr").is_err());
        assert_eq!(
            accepted("main", &core, Some(&core), 0, "en"),
            Ok(Shown { count: 0, lang: Lang::En })
        );
    }
}
