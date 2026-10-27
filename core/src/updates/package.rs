//! Local, reviewed release bundles. Remote URLs and installer commands are not inputs.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub const PROTOCOL: u32 = 1;
pub const STORAGE: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub sha256: String,
    pub bytes: u64,
    pub executable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schema {
    pub writes: u32,
    pub reads_min: u32,
    pub reads_max: u32,
}

impl Schema {
    pub fn reads(&self, version: u32) -> bool {
        self.reads_min <= version && version <= self.reads_max
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub release_id: String,
    pub version: String,
    pub git_sha: String,
    pub built_at: String,
    pub notes: String,
    pub platform: String,
    pub protocol: u32,
    pub schema: Schema,
    pub records: Schema,
    pub files: BTreeMap<String, Asset>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry {
    pub release_id: String,
    pub manifest_sha256: String,
    pub reviewed_at: String,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub format: u32,
    pub releases: Vec<CatalogEntry>,
}

#[derive(Clone)]
pub struct Bundle {
    pub path: PathBuf,
    pub manifest: Manifest,
    pub manifest_sha256: String,
}

pub fn valid_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid release ID"
    );
    Ok(())
}

fn relative(path: &str) -> Result<&Path> {
    let p = Path::new(path);
    ensure!(
        !path.is_empty()
            && !path.contains('\\')
            && p.components().all(|c| matches!(c, Component::Normal(_))),
        "Invalid release asset path"
    );
    ensure!(p.to_str() == Some(path), "Invalid asset encoding");
    Ok(p)
}

pub fn sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn files(root: &Path, directory: &Path, found: &mut BTreeSet<String>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        ensure!(!kind.is_symlink(), "Release symlinks are not allowed");
        if kind.is_dir() {
            files(root, &entry.path(), found)?;
        } else {
            ensure!(kind.is_file(), "Release contains a special file");
            found.insert(
                entry
                    .path()
                    .strip_prefix(root)?
                    .to_str()
                    .context("Non-UTF8 release path")?
                    .into(),
            );
        }
    }
    Ok(())
}

pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

impl Bundle {
    pub fn verify(path: &Path, trusted_hash: &str) -> Result<Self> {
        ensure!(
            !fs::symlink_metadata(path)?.file_type().is_symlink(),
            "Release directory cannot be a symlink"
        );
        let root = fs::canonicalize(path)?;
        let manifest_path = root.join("manifest.json");
        ensure!(
            fs::symlink_metadata(&manifest_path)?.file_type().is_file(),
            "Manifest must be a regular file"
        );
        ensure!(
            fs::metadata(&manifest_path)?.len() <= 8 * 1024 * 1024,
            "Release manifest is too large"
        );
        let actual_hash = sha256(&manifest_path)?;
        ensure!(
            actual_hash == trusted_hash,
            "Candidate manifest does not match the reviewed catalog"
        );
        let manifest: Manifest = serde_json::from_reader(File::open(&manifest_path)?)?;
        valid_id(&manifest.release_id)?;
        ensure!(
            manifest.format == 1 && manifest.protocol == PROTOCOL,
            "Unsupported release protocol"
        );
        ensure!(
            manifest.platform == platform(),
            "Candidate is for a different Core platform"
        );
        ensure!(
            manifest.schema.reads_min <= manifest.schema.reads_max
                && manifest.schema.reads(manifest.schema.writes),
            "Invalid schema compatibility range"
        );
        ensure!(
            manifest.records.reads_min <= manifest.records.reads_max
                && manifest.records.reads(manifest.records.writes),
            "Invalid record format compatibility range"
        );
        ensure!(
            manifest.git_sha.len() == 40 && manifest.git_sha.bytes().all(|b| b.is_ascii_hexdigit()),
            "Release build identity is missing"
        );
        ensure!(
            !manifest.version.is_empty() && manifest.notes.len() <= 32_768,
            "Invalid release description"
        );
        for required in [
            "bin/yuzuno-workspace",
            "bin/yuzuno-update-helper",
            "web/index.html",
            "runtimes/claude/bridge.mjs",
            "runtimes/claude/package.json",
            "runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
        ] {
            ensure!(
                manifest.files.contains_key(required),
                "Release is incomplete: {required}"
            );
        }
        let mut found = BTreeSet::new();
        files(&root, &root, &mut found)?;
        found.remove("manifest.json");
        ensure!(
            found == manifest.files.keys().cloned().collect(),
            "Release has missing or unlisted files"
        );
        for (name, asset) in &manifest.files {
            let path = root.join(relative(name)?);
            ensure!(
                asset.sha256.len() == 64 && asset.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
                "Invalid asset checksum"
            );
            ensure!(
                fs::metadata(&path)?.len() == asset.bytes && sha256(&path)? == asset.sha256,
                "Release asset differs: {name}"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                ensure!(
                    (fs::metadata(&path)?.permissions().mode() & 0o111 != 0) == asset.executable,
                    "Release executable mode differs: {name}"
                );
            }
        }
        for binary in ["bin/yuzuno-workspace", "bin/yuzuno-update-helper"] {
            ensure!(
                manifest.files[binary].executable,
                "Release binary is not executable"
            );
        }
        let index = fs::read_to_string(root.join("web/index.html"))?;
        ensure!(
            index.contains(&format!(
                "<meta name=\"yuzuno-release\" content=\"{}\">",
                manifest.release_id
            )),
            "UI release identity does not match Core bundle"
        );
        Ok(Self {
            path: root,
            manifest,
            manifest_sha256: actual_hash,
        })
    }

    pub fn total_bytes(&self) -> Result<u64> {
        self.manifest.files.values().try_fold(0u64, |sum, a| {
            sum.checked_add(a.bytes).context("Release size overflow")
        })
    }

    pub fn compatible_with(&self, running: &Manifest, database_schema: u32) -> Result<()> {
        ensure!(
            self.manifest.schema.reads(database_schema),
            "Candidate cannot read the current Workspace schema"
        );
        // First slice promises automatic recovery, so reject a candidate whose
        // writes would make the retained old executable unable to read the DB.
        ensure!(
            running.schema.reads(self.manifest.schema.writes),
            "Candidate requires a schema migration that prevents safe automatic rollback"
        );
        ensure!(
            self.manifest.records.reads(running.records.writes),
            "Candidate cannot read the current record format"
        );
        ensure!(
            running.records.reads(self.manifest.records.writes),
            "Candidate record format prevents safe automatic rollback"
        );
        Ok(())
    }

    pub fn stage(&self, releases: &Path, required_free: u64) -> Result<Self> {
        fs::create_dir_all(releases)?;
        ensure_space(
            releases,
            self.total_bytes()?
                .checked_add(required_free)
                .context("Required space overflow")?,
        )?;
        let destination = releases.join(&self.manifest.release_id);
        if destination.exists() {
            return Self::verify(&destination, &self.manifest_sha256);
        }
        let staging = releases.join(format!(".stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging)?;
        let result = (|| -> Result<()> {
            for name in self
                .manifest
                .files
                .keys()
                .map(String::as_str)
                .chain(std::iter::once("manifest.json"))
            {
                let to = staging.join(relative(name)?);
                fs::create_dir_all(to.parent().unwrap())?;
                fs::copy(self.path.join(name), &to)?;
                File::open(&to)?.sync_all()?;
            }
            Self::verify(&staging, &self.manifest_sha256)?;
            fs::rename(&staging, &destination)?;
            File::open(releases)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result?;
        Self::verify(&destination, &self.manifest_sha256)
    }
}

pub fn ensure_space(path: &Path, required: u64) -> Result<()> {
    #[cfg(unix)]
    {
        let fs = rustix::fs::statvfs(path)?;
        let available = fs.f_bavail.saturating_mul(fs.f_frsize);
        ensure!(
            available >= required,
            "Not enough space: need {required} bytes, available {available} bytes"
        );
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, required);
        anyhow::bail!("Managed Core updates currently require Linux/WSL")
    }
}

pub fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().context("Missing state directory")?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".update-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
pub(crate) fn fixture(root: &Path, id: &str) -> Bundle {
    let layout = super::storage::RECORD_LAYOUT;
    fixture_records(root, id, Schema { writes: layout, reads_min: layout, reads_max: layout })
}

/// `fixture` of a release with this record format.
#[cfg(test)]
pub(crate) fn fixture_records(root: &Path, id: &str, records: Schema) -> Bundle {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(root).unwrap();
    let mut assets = BTreeMap::new();
    for name in [
        "bin/yuzuno-workspace",
        "bin/yuzuno-update-helper",
        "web/index.html",
        "runtimes/claude/bridge.mjs",
        "runtimes/claude/package.json",
        "runtimes/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    ] {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let contents = if name == "web/index.html" {
            format!("<html><head><meta name=\"yuzuno-release\" content=\"{id}\"></head></html>")
        } else {
            "fixture".into()
        };
        fs::write(&path, contents).unwrap();
        let executable = name.starts_with("bin/");
        fs::set_permissions(
            &path,
            fs::Permissions::from_mode(if executable { 0o700 } else { 0o600 }),
        )
        .unwrap();
        assets.insert(
            name.into(),
            Asset {
                sha256: sha256(&path).unwrap(),
                bytes: fs::metadata(&path).unwrap().len(),
                executable,
            },
        );
    }
    let manifest = Manifest {
        format: 1,
        release_id: id.into(),
        version: format!("2026.10.{id}"),
        git_sha: "a".repeat(40),
        built_at: "2026-10-13T00:00:00Z".into(),
        notes: "Reviewed fixture".into(),
        platform: platform(),
        protocol: PROTOCOL,
        records,
        schema: Schema {
            writes: STORAGE,
            reads_min: STORAGE,
            reads_max: STORAGE,
        },
        files: assets,
    };
    atomic_json(&root.join("manifest.json"), &manifest).unwrap();
    Bundle::verify(root, &sha256(&root.join("manifest.json")).unwrap()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn altered_assets_and_unlisted_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let original = fixture(&dir.path().join("a"), "a");
        fs::write(original.path.join("web/index.html"), "tampered").unwrap();
        assert!(Bundle::verify(&original.path, &original.manifest_sha256).is_err());
        let other = fixture(&dir.path().join("b"), "b");
        fs::write(other.path.join("unexpected.sh"), "unlisted").unwrap();
        assert!(Bundle::verify(&other.path, &other.manifest_sha256).is_err());
    }
    #[test]
    fn stage_checks_trust_space_and_schema_before_installing() {
        let dir = tempfile::tempdir().unwrap();
        let a = fixture(&dir.path().join("a"), "a");
        let mut b = fixture(&dir.path().join("b"), "b");
        assert!(b.compatible_with(&a.manifest, STORAGE).is_ok());
        b.manifest.schema.writes = STORAGE + 1;
        assert!(b.compatible_with(&a.manifest, STORAGE).is_err());
        assert!(a.stage(&dir.path().join("releases"), u64::MAX).is_err());
        assert!(!dir.path().join("releases/a").exists());
        let staged = a.stage(&dir.path().join("releases"), 0).unwrap();
        assert_eq!(staged.manifest_sha256, a.manifest_sha256);
        assert!(a.stage(&dir.path().join("releases"), 0).is_ok());
    }
    #[test]
    fn symlinks_and_parent_paths_cannot_escape_the_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let a = fixture(&dir.path().join("a"), "a");
        std::os::unix::fs::symlink(dir.path(), a.path.join("outside")).unwrap();
        assert!(Bundle::verify(&a.path, &a.manifest_sha256).is_err());
        for path in ["../file", "/file", "a/../../file", "a\\file", ""] {
            assert!(relative(path).is_err(), "{path}");
        }
    }
}
