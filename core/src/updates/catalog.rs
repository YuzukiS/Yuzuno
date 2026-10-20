//! Explicit host-side registration of a reviewed local build. UI cannot supply
//! these paths or hashes; it only chooses IDs from this owner's catalog.
use super::{
    package::{self, Bundle, Catalog, CatalogEntry},
    state::{self, Layout, ReleaseRef},
};
use anyhow::{ensure, Result};
use std::{
    fs::{self, File},
    path::Path,
};

pub fn register(
    root: &Path,
    source: &Path,
    expected_hash: &str,
    reviewed_source: &str,
    initialize: bool,
) -> Result<()> {
    ensure!(
        !reviewed_source.trim().is_empty() && reviewed_source.len() <= 512,
        "Provide the reviewed source/review receipt"
    );
    let bundle = Bundle::verify(source, expected_hash)?;
    if !root.exists() {
        fs::create_dir_all(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        }
    }
    let layout = Layout::open(root)?;
    let helper = state::private_file(&layout.updates().join("helper.lock"))?;
    helper.try_lock()?;
    let registration = state::private_file(&layout.updates().join("catalog.lock"))?;
    registration.lock()?;
    ensure!(
        !layout
            .journal()?
            .operation
            .is_some_and(|op| op.phase.active()),
        "An update is in progress"
    );
    let current_path = root.join("current.json");
    ensure!(
        !initialize || !current_path.exists(),
        "Managed installation already exists; initialize never replaces it"
    );
    if current_path.exists() {
        let current: ReleaseRef = serde_json::from_reader(File::open(&current_path)?)?;
        let running = layout.release(&current)?;
        bundle.compatible_with(&running.manifest, package::STORAGE)?;
    }
    let catalog_path = root.join("catalog.json");
    let mut catalog: Catalog = if catalog_path.exists() {
        serde_json::from_reader(File::open(&catalog_path)?)?
    } else {
        Catalog {
            format: 1,
            releases: vec![],
        }
    };
    ensure!(catalog.format == 1, "Unsupported catalog format");
    if let Some(existing) = catalog
        .releases
        .iter()
        .find(|r| r.release_id == bundle.manifest.release_id)
    {
        ensure!(
            existing.manifest_sha256 == expected_hash,
            "Release IDs are immutable; choose a new release ID for changed content"
        );
    }
    let staged = bundle.stage(
        &root.join(if initialize { "releases" } else { "incoming" }),
        64 * 1024 * 1024,
    )?;
    catalog
        .releases
        .retain(|r| r.release_id != bundle.manifest.release_id);
    catalog.releases.insert(
        0,
        CatalogEntry {
            release_id: bundle.manifest.release_id,
            manifest_sha256: expected_hash.into(),
            reviewed_at: state::now(),
            source: reviewed_source.into(),
        },
    );
    // Only a small candidate shelf is kept. Existing installed bundles remain
    // available for rollback and old tab chunks; unused incoming copies do not
    // accumulate indefinitely as more reviewed builds are registered.
    let mut incoming_kept = 0;
    catalog.releases.retain(|entry| {
        if root.join("releases").join(&entry.release_id).is_dir() {
            return true;
        }
        incoming_kept += 1;
        incoming_kept <= 3
    });
    package::atomic_json(&catalog_path, &catalog)?;
    for entry in fs::read_dir(root.join("incoming"))? {
        let entry = entry?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if id
            .strip_prefix(".stage-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            ensure!(entry.file_type()?.is_dir(), "Unexpected staging entry");
            fs::remove_dir_all(entry.path())?;
            continue;
        }
        package::valid_id(&id)?;
        ensure!(entry.file_type()?.is_dir(), "Unexpected candidate entry");
        if !catalog.releases.iter().any(|r| r.release_id == id) {
            fs::remove_dir_all(entry.path())?;
        }
    }
    if initialize {
        package::atomic_json(&current_path, &ReleaseRef::from(&staged))?;
    }
    Ok(())
}
