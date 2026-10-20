use crate::AppearanceTheme;
use tauri::WebviewWindow;
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    DWMWA_USE_IMMERSIVE_DARK_MODE,
};

/// Match the cream/leaf or dark workspace palette while Windows retains the caption,
/// hit testing, resizing, accessibility, and Snap layout controls.
pub fn apply(window: &WebviewWindow, theme: AppearanceTheme) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // COLORREF uses 0x00BBGGRR. DWM supports these attributes on Windows 11;
    // older systems keep their native colors if an attribute is unsupported.
    let (dark, caption, text, border) = match theme {
        AppearanceTheme::Light => (0, 0x00ed_f4f5_u32, 0x003c_4b36_u32, 0x00dd_e7e4_u32),
        AppearanceTheme::Dark => (1, 0x0026_2c25_u32, 0x00ce_e2d9_u32, 0x003b_463a_u32),
    };
    for (attribute, color) in [
        (DWMWA_USE_IMMERSIVE_DARK_MODE, dark),
        (DWMWA_CAPTION_COLOR, caption),
        (DWMWA_TEXT_COLOR, text),
        (DWMWA_BORDER_COLOR, border),
    ] {
        // SAFETY: hwnd is this live Tauri window; DWM reads a COLORREF-sized
        // value synchronously and does not retain the borrowed pointer.
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd.0,
                attribute as u32,
                (&color as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        };
        if result < 0 {
            eprintln!("Native caption color unavailable ({result:#x}); retaining system colors.");
        }
    }
}
