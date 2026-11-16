//! Which macOS app bundle a running executable belongs to (YN-181), with no
//! dependencies, so CI checks it without building a desktop app (as
//! `badge_rules.rs`). `update.rs` uses it to decide whether this copy can
//! replace itself with an update.

use std::path::{Path, PathBuf};

/// The `.app` bundle the executable at `exe` runs from: its folder is
/// `MacOS`, inside `Contents`, inside a folder named `<name>.app`. None for
/// anything else, such as a `cargo run` build in `target/`.
///
/// The official updater (tauri-plugin-updater 2.13.3,
/// `extract_path_from_executable`) replaces the folder two levels above an
/// executable whose folder path contains `Contents/MacOS`. Wherever this
/// returns a bundle, that folder is this bundle; this rule is stricter, so
/// the updater never replaces a folder that is not an app. Whether the
/// bundle's volume can be written is checked separately.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    // `Path::extension` is None for a bare ".app": a bundle needs a name.
    if bundle.extension()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(exe: &str) -> Option<PathBuf> {
        app_bundle(Path::new(exe))
    }

    #[test]
    fn an_executable_in_an_app_bundle_belongs_to_that_bundle() {
        for (exe, app) in [
            (
                "/Applications/Yuzuno.app/Contents/MacOS/yuzuno-desktop",
                "/Applications/Yuzuno.app",
            ),
            (
                "/Users/example/Applications/Yuzuno.app/Contents/MacOS/yuzuno-desktop",
                "/Users/example/Applications/Yuzuno.app",
            ),
            (
                "/Applications/Yuzuno Lab.app/Contents/MacOS/yuzuno-lab",
                "/Applications/Yuzuno Lab.app",
            ),
            // A disk image or a translocated copy is still a bundle; that it
            // cannot be written is checked on its volume.
            (
                "/Volumes/Yuzuno/Yuzuno.app/Contents/MacOS/yuzuno-desktop",
                "/Volumes/Yuzuno/Yuzuno.app",
            ),
        ] {
            assert_eq!(bundle(exe), Some(PathBuf::from(app)), "{exe}");
        }
    }

    #[test]
    fn anything_else_is_not_a_bundle() {
        for exe in [
            "target/release/yuzuno-desktop",
            "/Users/example/src/yuzuno/desktop/target/debug/yuzuno-desktop",
            "yuzuno-desktop",
            "/yuzuno-desktop",
            // The updater's own rule would replace `/x` here.
            "/x/Contents/MacOS/y",
            "/Contents/MacOS/y",
            "Contents/MacOS/y",
            "/Applications/.app/Contents/MacOS/y",
            "/Applications/Yuzuno.app/Contents/Resources/x",
            "/Applications/Yuzuno.app/Contents/MacOS/helpers/x",
            "/Applications/Yuzuno.app/Contents/MacOSX/x",
            "/Applications/Yuzuno.app/MacOS/x",
            "/Applications/Yuzuno.apps/Contents/MacOS/x",
        ] {
            assert_eq!(bundle(exe), None, "{exe}");
        }
    }
}
