//! Signed GitHub Release discovery/download. Installation remains entirely T-12's
//! catalog -> prepare -> explicit apply path. No HTTP caller chooses a source/key.
use super::{
    catalog,
    controller::Controller,
    package::{self, Bundle, Manifest},
    state::{self, Layout},
};
use crate::github::client::Client;
use anyhow::{ensure, Context, Result};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Component, Path},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::Notify;

const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;
const MAX_EXPANDED: u64 = 4 * 1024 * 1024 * 1024;
const MAX_DESCRIPTOR: u64 = 8 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    repository: String,
    public_key: String,
}
impl Config {
    fn read(layout: &Layout) -> Result<Self> {
        let path = layout.root.join("release-source.json");
        let meta = fs::symlink_metadata(&path)
            .context("No release source configured on this Core host")?;
        ensure!(
            meta.file_type().is_file() && meta.len() <= 16 * 1024,
            "Invalid release source configuration"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            ensure!(
                meta.uid() == rustix::process::getuid().as_raw() && meta.mode() & 0o022 == 0,
                "Release source must be owner-controlled"
            );
        }
        let config: Self = serde_json::from_reader(File::open(path)?)?;
        ensure!(
            crate::github::client::parse(&config.repository, false)?.repo == config.repository,
            "Configure a GitHub owner/repo, not a URL"
        );
        PublicKey::from_base64(&config.public_key).context("Invalid release signing public key")?;
        Ok(config)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    format: u32,
    repository: String,
    tag: String,
    manifest: Manifest,
    manifest_sha256: String,
    archive_sha256: String,
    archive_bytes: u64,
}
#[derive(Clone)]
struct Candidate {
    descriptor: Descriptor,
    asset_id: u64,
}
impl Candidate {
    fn public(&self) -> Value {
        let mut summary = serde_json::to_value(&self.descriptor.manifest).unwrap();
        summary.as_object_mut().unwrap().remove("files");
        summary["bytes"] = json!(self.descriptor.archive_bytes);
        summary["source"] = json!(format!(
            "{} · {} · Signature verified",
            self.descriptor.repository, self.descriptor.tag
        ));
        summary
    }
}
struct Job {
    cancelled: AtomicBool,
    wake: Notify,
}
impl Job {
    fn check(&self) -> Result<()> {
        ensure!(!self.cancelled.load(Ordering::SeqCst), "Download cancelled");
        Ok(())
    }
}
struct Status {
    phase: &'static str,
    candidate: Option<Candidate>,
    error: Option<String>,
    checked_at: Option<String>,
    job: Option<Arc<Job>>,
}
pub struct Releases {
    config: Option<Config>,
    reason: Option<String>,
    state: Mutex<Status>,
    received: AtomicU64,
    client: Client,
}
impl Releases {
    pub fn new(layout: Option<&Layout>) -> Self {
        let config = layout
            .context("Install a managed release to enable release downloads")
            .and_then(Config::read);
        let interrupted =
            layout.is_some_and(|l| l.updates().join("release-download.json").exists());
        let (config, reason) = match config {
            Ok(c) => (Some(c), None),
            Err(e) => (None, Some(e.to_string())),
        };
        Self { config, reason, state: Mutex::new(Status {
            phase: if interrupted { "failed" } else { "idle" }, candidate: None, checked_at: None, job: None,
            error: interrupted.then(|| "Download was interrupted by a Core restart. Check for updates and download again.".into()),
        }), received: AtomicU64::new(0), client: Client::default() }
    }
    pub fn status(&self) -> Value {
        let s = self.state.lock().unwrap();
        json!({"configured":self.config.is_some(),"repository":self.config.as_ref().map(|c| &c.repository),"reason":self.reason,
            "phase":s.phase,"candidate":s.candidate.as_ref().map(Candidate::public),"error":s.error,"checkedAt":s.checked_at,
            "receivedBytes":self.received.load(Ordering::Relaxed),"totalBytes":s.candidate.as_ref().map(|c| c.descriptor.archive_bytes)})
    }
    fn begin(&self, phase: &'static str) -> Option<Arc<Job>> {
        let mut s = self.state.lock().unwrap();
        if s.job.is_some() {
            return None;
        }
        let job = Arc::new(Job {
            cancelled: AtomicBool::new(false),
            wake: Notify::new(),
        });
        s.phase = phase;
        s.error = None;
        s.job = Some(job.clone());
        self.received.store(0, Ordering::Relaxed);
        Some(job)
    }
    fn finish(&self, result: Result<()>, phase: &'static str) {
        let mut s = self.state.lock().unwrap();
        let cancelled = s
            .job
            .take()
            .is_some_and(|j| j.cancelled.load(Ordering::SeqCst));
        match result {
            Ok(()) => {
                s.phase = phase;
                s.error = None;
            }
            Err(e) => {
                s.phase = if cancelled { "cancelled" } else { "failed" };
                s.error = Some(e.to_string());
            }
        }
    }
    pub fn cancel(&self) -> Result<()> {
        let s = self.state.lock().unwrap();
        ensure!(
            matches!(s.phase, "downloading" | "verifying"),
            "There is no cancellable download"
        );
        let job = s.job.as_ref().context("No download in progress")?;
        job.cancelled.store(true, Ordering::SeqCst);
        job.wake.notify_one();
        Ok(())
    }
    /// Manual only. Ordinary status polling and Core startup never contact GitHub.
    pub fn check(controller: &Arc<Controller>) -> Result<()> {
        let this = &controller.releases;
        if this.config.is_none() {
            return Ok(());
        }
        controller.managed()?;
        let permit = controller.admission.enter_work()?;
        let Some(_) = this.begin("checking") else {
            return Ok(());
        };
        let controller = controller.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let source = &controller.releases;
            let outcome = source.discover(&controller).await;
            let phase = match outcome {
                Ok(candidate) => {
                    let mut s = source.state.lock().unwrap();
                    s.candidate = candidate;
                    s.checked_at = Some(state::now());
                    if s.candidate.is_some() {
                        "available"
                    } else {
                        "current"
                    }
                }
                Err(error) => {
                    source.finish(Err(error), "failed");
                    return;
                }
            };
            source.finish(Ok(()), phase);
        });
        Ok(())
    }
    async fn discover(&self, controller: &Controller) -> Result<Option<Candidate>> {
        let config = self.config.as_ref().context("No release source")?;
        let (layout, running) = controller.managed()?;
        let releases = self
            .client
            .get(&format!(
                "repos/{}/releases?per_page=100",
                config.repository
            ))
            .await?;
        // Desktop releases have their own lifecycle and must not hide a Core
        // release just because they became GitHub's global 'latest'.
        let release = releases
            .as_array()
            .context("Invalid GitHub release list")?
            .iter()
            .filter(|r| {
                r["draft"] == false
                    && r["prerelease"] == false
                    && r["tag_name"]
                        .as_str()
                        .is_some_and(|t| t.starts_with("core-"))
            })
            .max_by_key(|r| r["published_at"].as_str().unwrap_or(""))
            .context("No stable Core release has been published in this repository")?;
        let tag = release["tag_name"]
            .as_str()
            .context("Release tag is missing")?;
        let assets = release["assets"]
            .as_array()
            .context("Release assets are missing")?;
        let prefix = format!("yuzuno-core-{}", package::platform());
        let (index_id, index_bytes) = asset(assets, &format!("{prefix}.json"), MAX_DESCRIPTOR)?;
        let (signature_id, signature_bytes) =
            asset(assets, &format!("{prefix}.json.minisig"), 4096)?;
        let (archive_id, archive_bytes) = asset(assets, &format!("{prefix}.tar.gz"), MAX_ARCHIVE)?;
        let temporary = tempfile::Builder::new()
            .prefix("release-check-")
            .tempdir_in(layout.updates())?;
        let index = temporary.path().join("index.json");
        let signature = temporary.path().join("index.minisig");
        let progress = AtomicU64::new(0);
        for (id, path, bytes) in [
            (index_id, &index, index_bytes),
            (signature_id, &signature, signature_bytes),
        ] {
            self.client
                .download(
                    &format!("repos/{}/releases/assets/{id}", config.repository),
                    path,
                    bytes,
                    Duration::from_secs(30),
                    &progress,
                )
                .await?;
        }
        let bytes = tokio::fs::read(index).await?;
        let signature = tokio::fs::read_to_string(signature).await?;
        let descriptor = verify_descriptor(config, &bytes, &signature, &running.manifest)?;
        ensure!(
            descriptor.tag == tag && descriptor.archive_bytes == archive_bytes,
            "Signed release differs from GitHub asset metadata"
        );
        if descriptor.manifest.release_id == running.manifest.release_id
            || chrono::DateTime::parse_from_rfc3339(&descriptor.manifest.built_at)?
                <= chrono::DateTime::parse_from_rfc3339(&running.manifest.built_at)?
        {
            return Ok(None);
        }
        Ok(Some(Candidate {
            descriptor,
            asset_id: archive_id,
        }))
    }
    pub fn download(controller: &Arc<Controller>, release_id: &str) -> Result<()> {
        let this = &controller.releases;
        let (layout, _) = controller.managed()?;
        let candidate = {
            let s = this.state.lock().unwrap();
            let c = s
                .candidate
                .as_ref()
                .context("Check for a signed release first")?;
            ensure!(
                c.descriptor.manifest.release_id == release_id,
                "Available release changed; check again"
            );
            if s.phase == "downloaded" || s.job.is_some() {
                return Ok(());
            }
            c.clone()
        };
        let permit = controller.admission.enter_work()?;
        let Some(job) = this.begin("downloading") else {
            return Ok(());
        };
        if let Err(e) = package::atomic_json(
            &layout.updates().join("release-download.json"),
            &json!({"releaseId":release_id,"startedAt":state::now()}),
        ) {
            this.finish(Err(e), "failed");
            return Err(anyhow::anyhow!("Could not save download state"));
        }
        let controller = controller.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let source = &controller.releases;
            let mut result = source.fetch_and_register(&controller, candidate, job).await;
            if let Some(layout) = &controller.layout {
                let _ = fs::remove_file(layout.updates().join("release-download.json"));
            }
            // The downloaded bundle enters the same candidate shelf as a local
            // reviewed release. Preparation/application still require user clicks.
            if result.is_ok() {
                result = controller.check().await;
            }
            drop(_permit);
            source.finish(result, "downloaded");
        });
        Ok(())
    }
    async fn fetch_and_register(
        &self,
        controller: &Controller,
        candidate: Candidate,
        job: Arc<Job>,
    ) -> Result<()> {
        let (layout, running) = controller.managed()?;
        let layout = layout.clone();
        let running = running.manifest.clone();
        let config = self.config.clone().context("No release source")?;
        let expanded = candidate
            .descriptor
            .manifest
            .files
            .values()
            .try_fold(0u64, |sum, f| {
                sum.checked_add(f.bytes).context("Release size overflow")
            })?;
        let work = layout.updates();
        let reserve = candidate.descriptor.archive_bytes + 2 * expanded + 64 * 1024 * 1024;
        let temporary = tokio::task::spawn_blocking(move || -> Result<_> {
            // Only this source's abandoned private scratch directories are ours.
            for entry in fs::read_dir(&work)? {
                let entry = entry?;
                if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("release-download-")
                    && entry.file_type()?.is_dir()
                {
                    fs::remove_dir_all(entry.path())?;
                }
            }
            package::ensure_space(&work, reserve)?;
            Ok(tempfile::Builder::new()
                .prefix("release-download-")
                .tempdir_in(work)?)
        })
        .await??;
        let archive = temporary.path().join("bundle.tar.gz");
        let endpoint = format!(
            "repos/{}/releases/assets/{}",
            config.repository, candidate.asset_id
        );
        let transfer = self.client.download(
            &endpoint,
            &archive,
            candidate.descriptor.archive_bytes,
            Duration::from_secs(300),
            &self.received,
        );
        let result = tokio::select! {
            result = transfer => result,
            _ = job.wake.notified() => Err(anyhow::anyhow!("Download cancelled")),
        };
        if let Err(error) = result {
            let _ = tokio::task::spawn_blocking(move || temporary.close()).await;
            return Err(error);
        }
        self.state.lock().unwrap().phase = "verifying";
        let source = &controller.releases;
        let source = source.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let bundle = unpack(&archive, temporary.path(), &candidate.descriptor, &job)?;
            bundle.compatible_with(&running, package::STORAGE)?;
            {
                let mut s = source.state.lock().unwrap();
                job.check()?;
                s.phase = "registering"; // cancellation can no longer report success
            }
            catalog::register(
                &layout.root,
                &bundle.path,
                &candidate.descriptor.manifest_sha256,
                &format!(
                    "Signed GitHub release {}/{}",
                    config.repository, candidate.descriptor.tag
                ),
                false,
            )?;
            temporary.close()?;
            Ok(())
        })
        .await?
    }
}

fn asset(assets: &[Value], name: &str, max: u64) -> Result<(u64, u64)> {
    let found: Vec<_> = assets.iter().filter(|a| a["name"] == name).collect();
    ensure!(
        found.len() == 1,
        "Release has no unique {name} asset for this platform"
    );
    let a = found[0];
    ensure!(a["state"] == "uploaded", "Release asset is not ready");
    let id = a["id"]
        .as_u64()
        .filter(|id| *id > 0)
        .context("Invalid release asset ID")?;
    let size = a["size"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= max)
        .context("Release asset exceeds the size limit")?;
    Ok((id, size))
}
fn verify_descriptor(
    config: &Config,
    bytes: &[u8],
    signature: &str,
    running: &Manifest,
) -> Result<Descriptor> {
    PublicKey::from_base64(&config.public_key)?
        .verify(bytes, &Signature::decode(signature)?, false)
        .context("Release signature did not match the trusted publisher")?;
    let d: Descriptor =
        serde_json::from_slice(bytes).context("Invalid signed release descriptor")?;
    ensure!(
        d.format == 1 && d.repository == config.repository,
        "Signed release source does not match this installation"
    );
    package::valid_id(&d.manifest.release_id)?;
    ensure!(
        d.manifest.platform == package::platform() && d.manifest.protocol == package::PROTOCOL,
        "Release platform or protocol is incompatible"
    );
    ensure!(
        d.manifest.format == 1 && d.manifest.notes.len() <= 32768,
        "Invalid release manifest"
    );
    ensure!(
        d.manifest_sha256.len() == 64
            && d.archive_sha256.len() == 64
            && d.manifest_sha256
                .bytes()
                .chain(d.archive_sha256.bytes())
                .all(|b| b.is_ascii_hexdigit()),
        "Invalid signed checksum"
    );
    ensure!(
        d.archive_bytes > 0 && d.archive_bytes <= MAX_ARCHIVE && d.manifest.files.len() <= 30000,
        "Release exceeds size limits"
    );
    let expanded = d.manifest.files.values().try_fold(0u64, |sum, f| {
        sum.checked_add(f.bytes).context("Release size overflow")
    })?;
    ensure!(
        expanded <= MAX_EXPANDED,
        "Expanded release exceeds size limit"
    );
    let bundle = Bundle {
        path: Default::default(),
        manifest: d.manifest.clone(),
        manifest_sha256: d.manifest_sha256.clone(),
    };
    bundle.compatible_with(running, package::STORAGE)?;
    Ok(d)
}
fn unpack(archive: &Path, parent: &Path, descriptor: &Descriptor, job: &Job) -> Result<Bundle> {
    job.check()?;
    ensure!(
        fs::metadata(archive)?.len() == descriptor.archive_bytes
            && package::sha256(archive)? == descriptor.archive_sha256,
        "Downloaded archive does not match its signed checksum"
    );
    let destination = parent.join("bundle");
    fs::create_dir(&destination)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(archive)?));
    for entry in archive.entries()? {
        job.check()?;
        let mut entry = entry?;
        ensure!(
            entry.header().entry_type().is_file(),
            "Release archives may contain only regular files"
        );
        let name = entry.path()?.into_owned();
        let name = name.to_str().context("Invalid archive path encoding")?;
        ensure!(
            !name.is_empty()
                && !name.contains('\\')
                && Path::new(name)
                    .components()
                    .all(|c| matches!(c, Component::Normal(_))),
            "Unsafe archive path"
        );
        let (limit, executable) = if name == "manifest.json" {
            (MAX_DESCRIPTOR, false)
        } else {
            let file = descriptor
                .manifest
                .files
                .get(name)
                .context("Archive contains an unlisted file")?;
            ensure!(
                entry.size() == file.bytes,
                "Archive file size differs from signed manifest"
            );
            (file.bytes, file.executable)
        };
        ensure!(entry.size() <= limit, "Archive file exceeds signed size");
        let path = destination.join(name);
        fs::create_dir_all(path.parent().unwrap())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        io::copy(&mut entry, &mut file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                path,
                fs::Permissions::from_mode(if executable { 0o555 } else { 0o444 }),
            )?;
        }
    }
    let bundle = Bundle::verify(&destination, &descriptor.manifest_sha256)?;
    ensure!(
        serde_json::to_value(&bundle.manifest)? == serde_json::to_value(&descriptor.manifest)?,
        "Archive manifest differs from signed release metadata"
    );
    Ok(bundle)
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod tests;
