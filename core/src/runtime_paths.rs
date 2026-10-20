use std::{ffi::OsString, path::PathBuf};

/// Installed bundles explicitly select their assets. Only developer builds
/// may fall back to this checkout; packaged binaries must not embed its path.
pub(crate) fn resolve(configured: Option<OsString>, relative: &str) -> Option<PathBuf> {
    match configured {
        Some(path) if path.is_empty() => None,
        Some(path) => Some(path.into()),
        None => source_asset(relative),
    }
}

#[cfg(not(feature = "bundled-release"))]
fn source_asset(relative: &str) -> Option<PathBuf> {
    Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtimes").join(relative))
}

#[cfg(feature = "bundled-release")]
fn source_asset(_relative: &str) -> Option<PathBuf> {
    None
}
