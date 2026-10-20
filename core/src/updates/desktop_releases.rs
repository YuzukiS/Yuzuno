//! Desktop app releases, relayed to a desktop on this computer (T-13).
//!
//! The desktop's own updater verifies every installer against the public key
//! built into it, and that the signed version is the announced one, so Core
//! only carries bytes here and decides nothing about trust. It reads the
//! project's fixed `desktop-<version>` Releases with this host's
//! GitHub login and serves exactly two things for a known target: a Tauri
//! updater manifest whose installer URL points back at this Core, and that
//! release's installer. No caller chooses a repository, URL or file.
use super::controller::Controller;
use crate::github::client::Client;
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    sync::{atomic::AtomicU64, OnceLock},
    time::Duration,
};
use tokio::sync::Semaphore;

/// Targets with a published desktop installer.
const REPOSITORY: &str = "YuzukiS/Yuzuno";
const TARGETS: [&str; 1] = ["windows-x86_64"];
const MAX_INSTALLER: u64 = 512 * 1024 * 1024;
const MAX_SIGNATURE: u64 = 4096;
const MAX_NOTES: usize = 16 * 1024;
const SIGNATURE_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct DesktopReleases {
    pub(crate) client: Client,
    /// One installer transfer at a time.
    transfers: Semaphore,
}

impl Default for DesktopReleases {
    fn default() -> Self {
        Self {
            client: Client::default(),
            transfers: Semaphore::new(1),
        }
    }
}

pub fn shared() -> &'static DesktopReleases {
    static SHARED: OnceLock<DesktopReleases> = OnceLock::new();
    SHARED.get_or_init(DesktopReleases::default)
}

fn installer_name(target: &str) -> String {
    format!("yuzuno-desktop-{target}-setup.exe")
}

pub fn known_target(target: &str) -> Result<&'static str> {
    TARGETS
        .into_iter()
        .find(|known| *known == target)
        .context("No desktop app is published for this platform")
}

/// The version a `desktop-<version>` tag names: plain semver, nothing else.
fn tag_version(tag: &str) -> Option<&str> {
    let version = tag.strip_prefix("desktop-")?;
    let core = version.split(['-', '+']).next()?;
    let parts: Vec<_> = core.split('.').collect();
    let valid = parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
        && version.len() <= 64
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'));
    valid.then_some(version)
}

/// This Core's own loopback address as the request named it; the server
/// already accepts no other Host.
fn loopback_origin(host: &str) -> Result<String> {
    let (name, port) = host.rsplit_once(':').context("Unrecognized Core host")?;
    ensure!(
        matches!(name, "127.0.0.1" | "localhost") && port.parse::<u16>().is_ok_and(|p| p > 0),
        "Desktop updates are relayed only to this computer"
    );
    Ok(format!("http://{name}:{port}"))
}

struct Release {
    tag: String,
    version: String,
    notes: String,
    published_at: String,
    installer: (u64, u64),
    signature: (u64, u64),
}

/// One release's asset by its fixed name: (id, size), uploaded and bounded.
fn asset(release: &Value, name: &str, max: u64) -> Result<(u64, u64)> {
    let asset = release["assets"]
        .as_array()
        .context("Release assets are missing")?
        .iter()
        .find(|a| a["name"] == name)
        .with_context(|| format!("The desktop release has no {name}"))?;
    ensure!(
        asset["state"] == "uploaded",
        "The desktop release's {name} is not uploaded"
    );
    let id = asset["id"]
        .as_u64()
        .context("Release asset id is missing")?;
    let size = asset["size"]
        .as_u64()
        .context("Release asset size is missing")?;
    ensure!(
        size > 0 && size <= max,
        "The desktop release's {name} has an unexpected size"
    );
    Ok((id, size))
}

/// The newest stable desktop release (or the one tagged `tag`), with an
/// installer for `target`. Core releases and drafts are never considered.
fn select(releases: &Value, target: &str, tag: Option<&str>) -> Result<Release> {
    let release = releases
        .as_array()
        .context("Invalid GitHub release list")?
        .iter()
        .filter(|r| r["draft"] == false && r["prerelease"] == false)
        .filter(|r| r["tag_name"].as_str().and_then(tag_version).is_some())
        .filter(|r| tag.is_none_or(|tag| r["tag_name"] == tag))
        .max_by_key(|r| r["published_at"].as_str().unwrap_or(""))
        .context("No desktop release has been published in this repository")?;
    let name = installer_name(target);
    let tag = release["tag_name"].as_str().unwrap_or_default().to_owned();
    let mut notes = release["body"].as_str().unwrap_or_default().to_owned();
    if notes.len() > MAX_NOTES {
        let end = (0..=MAX_NOTES)
            .rev()
            .find(|i| notes.is_char_boundary(*i))
            .unwrap_or(0);
        notes.truncate(end);
    }
    Ok(Release {
        version: tag_version(&tag).unwrap_or_default().to_owned(),
        tag,
        notes,
        published_at: release["published_at"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        installer: asset(release, &name, MAX_INSTALLER)?,
        signature: asset(release, &format!("{name}.sig"), MAX_SIGNATURE)?,
    })
}

/// Disposable desktop downloads live with this workspace's data, independently
/// of Core's managed installation and its separate release trust configuration.
fn scratch_root(controller: &Controller) -> Result<std::path::PathBuf> {
    let root = controller.launch.data_dir.join("desktop-updates");
    std::fs::create_dir_all(&root).context("Could not create desktop download storage")?;
    Ok(root)
}

impl DesktopReleases {
    async fn releases(&self) -> Result<Value> {
        // Boxed: the client's futures are large, and callers may run on a small stack.
        Box::pin(
            self.client
                .get(&format!("repos/{REPOSITORY}/releases?per_page=100")),
        )
        .await
    }

    /// The updater manifest for `target`, pointing at this Core for the
    /// installer. The signature is carried as published; the desktop checks it.
    pub async fn manifest(
        &self,
        controller: &Controller,
        target: &str,
        host: &str,
    ) -> Result<Value> {
        let target = known_target(target)?;
        let origin = loopback_origin(host)?;
        let release = select(&self.releases().await?, target, None)?;
        let scratch = tempfile::Builder::new()
            .prefix("desktop-signature-")
            .tempdir_in(scratch_root(controller)?)?;
        let path = scratch.path().join("installer.sig");
        Box::pin(self.client.download(
            &format!("repos/{REPOSITORY}/releases/assets/{}", release.signature.0),
            &path,
            release.signature.1,
            SIGNATURE_TIMEOUT,
            &AtomicU64::new(0),
        ))
        .await?;
        let signature = tokio::fs::read_to_string(&path).await?;
        ensure!(
            !signature.trim().is_empty() && signature.trim().bytes().all(|b| b.is_ascii_graphic()),
            "The desktop release's signature is not a Tauri signature"
        );
        let url = format!(
            "{origin}/api/updates/desktop/{target}/installer?tag={}",
            release.tag
        );
        Ok(json!({
            "version": release.version,
            "notes": release.notes,
            "pub_date": release.published_at,
            "platforms": {target: {"signature": signature.trim(), "url": url}},
        }))
    }

    /// That release's installer for `target`, in a file deleted when dropped.
    pub async fn installer(
        &self,
        controller: &Controller,
        target: &str,
        tag: &str,
    ) -> Result<(tempfile::NamedTempFile, u64)> {
        let target = known_target(target)?;
        if tag_version(tag).is_none() {
            bail!("Not a desktop release tag");
        }
        let _transfer = self.transfers.try_acquire().map_err(|_| {
            anyhow::anyhow!("Another desktop installer is being transferred; try again shortly")
        })?;
        let release = select(&self.releases().await?, target, Some(tag))?;
        let file = tempfile::Builder::new()
            .prefix("desktop-installer-")
            .tempfile_in(scratch_root(controller)?)?;
        // The GitHub client creates the file itself.
        let path = file.path().to_owned();
        std::fs::remove_file(&path)?;
        Box::pin(self.client.download(
            &format!("repos/{REPOSITORY}/releases/assets/{}", release.installer.0),
            &path,
            release.installer.1,
            INSTALLER_TIMEOUT,
            &AtomicU64::new(0),
        ))
        .await?;
        let size = std::fs::metadata(&path)?.len();
        ensure!(
            size == release.installer.1,
            "The installer differs from its release record"
        );
        Ok((file, size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        updates::{
            catalog,
            lifecycle::WorkspaceRuntime,
            package,
            state::{Launch, Layout, ReleaseRef},
        },
        workspace::Workspace,
    };
    use std::{os::unix::fs::PermissionsExt, sync::Arc};
    use tower::ServiceExt;

    const INSTALLER: &[u8] = b"MZ fixture installer bytes";
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK";

    /// Managed or checkout Core with no Core release key; its GitHub fixture has one Core release, a
    /// draft and two desktop releases.
    fn fixture(managed: bool) -> (tempfile::TempDir, Arc<Controller>, DesktopReleases) {
        let dir = tempfile::tempdir().unwrap();
        let initial = package::fixture(&dir.path().join("initial"), "initial");
        let root = dir.path().join("managed");
        catalog::register(
            &root,
            &initial.path,
            &initial.manifest_sha256,
            "Local test",
            true,
        )
        .unwrap();
        let layout = Layout::open(&root).unwrap();
        let running = layout.release(&ReleaseRef::from(&initial)).unwrap();
        let ws =
            Workspace::new(dir.path().join("data"), "/fixture".into(), "unused".into()).unwrap();
        let controller = Controller::new(
            managed.then_some(layout),
            managed.then_some(running),
            Launch {
                port: 4495,
                data_dir: dir.path().join("data"),
                cwd: dir.path().into(),
                codex: "unused".into(),
            },
            Arc::new(WorkspaceRuntime(ws.clone())),
            ws.admission.clone(),
        )
        .unwrap();
        std::fs::write(dir.path().join("asset-21"), INSTALLER).unwrap();
        std::fs::write(dir.path().join("asset-22"), SIGNATURE).unwrap();
        let script = dir.path().join("gh-fixture.py");
        std::fs::write(&script, format!(r#"#!/usr/bin/python3
import json,sys
from pathlib import Path
root=Path(__file__).parent
assert sys.argv[1:6] == ['api','--hostname','github.com','--method','GET']
endpoint=sys.argv[-1]
desktop=[{{'id':21,'name':'yuzuno-desktop-windows-x86_64-setup.exe','state':'uploaded','size':{installer}}},
 {{'id':22,'name':'yuzuno-desktop-windows-x86_64-setup.exe.sig','state':'uploaded','size':{signature}}}]
if endpoint == 'repos/YuzukiS/Yuzuno/releases?per_page=100':
 print(json.dumps([
  {{'tag_name':'core-test','draft':False,'prerelease':False,'published_at':'2026-10-16T00:00:00Z','assets':[]}},
  {{'tag_name':'desktop-9.0.0','draft':True,'prerelease':False,'published_at':'2026-10-17T00:00:00Z','assets':desktop}},
  {{'tag_name':'desktop-0.2.0','draft':False,'prerelease':False,'published_at':'2026-10-15T00:00:00Z','body':'Faster start','assets':desktop}},
  {{'tag_name':'desktop-0.1.0','draft':False,'prerelease':False,'published_at':'2026-10-14T00:00:00Z','body':'First','assets':desktop}}]))
elif endpoint.startswith('repos/YuzukiS/Yuzuno/releases/assets/'):
 sys.stdout.buffer.write((root/('asset-'+endpoint.rsplit('/',1)[1])).read_bytes())
else: raise AssertionError(endpoint)
"#, installer = INSTALLER.len(), signature = SIGNATURE.len())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let releases = DesktopReleases {
            client: Client {
                program: script.to_string_lossy().into(),
                deadline: Duration::from_secs(10),
            },
            transfers: Semaphore::new(1),
        };
        (dir, controller, releases)
    }

    #[tokio::test]
    async fn the_manifest_points_the_desktop_back_at_this_core_for_the_newest_installer() {
        for managed in [false, true] {
            let (_dir, controller, releases) = fixture(managed);
            assert_eq!(controller.releases.status()["configured"], false);
            let manifest = releases
                .manifest(&controller, "windows-x86_64", "127.0.0.1:4495")
                .await
                .unwrap();
            assert_eq!(manifest["version"], "0.2.0");
            assert_eq!(manifest["notes"], "Faster start");
            assert_eq!(manifest["pub_date"], "2026-10-15T00:00:00Z");
            let platform = &manifest["platforms"]["windows-x86_64"];
            assert_eq!(
                platform["signature"], SIGNATURE,
                "carried as published; the desktop verifies it"
            );
            assert_eq!(
            platform["url"],
            "http://127.0.0.1:4495/api/updates/desktop/windows-x86_64/installer?tag=desktop-0.2.0"
        );
            let (file, size) = releases
                .installer(&controller, "windows-x86_64", "desktop-0.1.0")
                .await
                .unwrap();
            assert_eq!(
                (std::fs::read(file.path()).unwrap(), size),
                (INSTALLER.to_vec(), INSTALLER.len() as u64)
            );
            for tag in [
                "desktop-9.0.0",
                "core-test",
                "desktop-0.3.0",
                "../../etc/passwd",
            ] {
                assert!(
                    releases
                        .installer(&controller, "windows-x86_64", tag)
                        .await
                        .is_err(),
                    "{tag}"
                );
            }
            assert!(releases
                .manifest(&controller, "windows-x86_64", "evil.example:4495")
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn the_routes_refuse_unknown_targets_before_asking_github() {
        let (_dir, controller, _) = fixture(false);
        let response = crate::updates::api::router::<()>(controller)
            .oneshot(
                axum::http::Request::get("/api/updates/desktop/linux-x86_64/manifest")
                    .header("host", "127.0.0.1:4495")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }

    fn release(tag: &str, published: &str, assets: Value) -> Value {
        json!({"tag_name":tag,"draft":false,"prerelease":false,"published_at":published,"body":"Notes","assets":assets})
    }
    fn assets() -> Value {
        json!([
            {"id":11,"name":"yuzuno-desktop-windows-x86_64-setup.exe","state":"uploaded","size":4096},
            {"id":12,"name":"yuzuno-desktop-windows-x86_64-setup.exe.sig","state":"uploaded","size":300},
        ])
    }

    #[test]
    fn only_stable_desktop_releases_with_this_targets_installer_are_offered() {
        let list = json!([
            release("core-2026", "2026-10-15T00:00:00Z", assets()),
            release("desktop-0.3.0", "2026-10-14T00:00:00Z", assets()),
            release("desktop-0.2.0", "2026-10-13T00:00:00Z", assets()),
            {"tag_name":"desktop-9.9.9","draft":true,"prerelease":false,"published_at":"2026-10-16T00:00:00Z","assets":assets()},
            {"tag_name":"desktop-8.0.0","draft":false,"prerelease":true,"published_at":"2026-10-16T00:00:00Z","assets":assets()},
            release("desktop-latest", "2026-10-17T00:00:00Z", assets()),
        ]);
        let newest = select(&list, "windows-x86_64", None).unwrap();
        assert_eq!(
            (newest.tag.as_str(), newest.version.as_str()),
            ("desktop-0.3.0", "0.3.0")
        );
        assert_eq!(
            (newest.installer, newest.signature),
            ((11, 4096), (12, 300))
        );
        assert_eq!(
            select(&list, "windows-x86_64", Some("desktop-0.2.0"))
                .unwrap()
                .version,
            "0.2.0"
        );
        for tag in [
            "desktop-9.9.9",
            "desktop-8.0.0",
            "core-2026",
            "desktop-latest",
        ] {
            assert!(select(&list, "windows-x86_64", Some(tag)).is_err(), "{tag}");
        }
        let missing = json!([release(
            "desktop-1.0.0",
            "2026-10-14T00:00:00Z",
            json!([assets()[0].clone()])
        )]);
        assert!(select(&missing, "windows-x86_64", None)
            .err()
            .unwrap()
            .to_string()
            .contains(".sig"));
        let huge = json!([release(
            "desktop-1.0.0",
            "2026-10-14T00:00:00Z",
            json!([
            {"id":1,"name":"yuzuno-desktop-windows-x86_64-setup.exe","state":"uploaded","size":MAX_INSTALLER + 1},
            assets()[1].clone()])
        )]);
        assert!(select(&huge, "windows-x86_64", None).is_err());
        let pending = json!([release(
            "desktop-1.0.0",
            "2026-10-14T00:00:00Z",
            json!([
            {"id":1,"name":"yuzuno-desktop-windows-x86_64-setup.exe","state":"starter","size":10},
            assets()[1].clone()])
        )]);
        assert!(select(&pending, "windows-x86_64", None).is_err());
    }

    #[test]
    fn tags_targets_and_hosts_are_fixed_shapes() {
        for (tag, version) in [
            ("desktop-0.2.0", Some("0.2.0")),
            ("desktop-1.2.3-beta.1", Some("1.2.3-beta.1")),
            ("desktop-1.2", None),
            ("desktop-a.b.c", None),
            ("core-1.2.3", None),
            ("desktop-1.2.3/../x", None),
            ("desktop-1.2.3?x=1", None),
        ] {
            assert_eq!(tag_version(tag), version, "{tag}");
        }
        assert!(known_target("windows-x86_64").is_ok());
        assert!(known_target("linux-x86_64").is_err());
        assert!(known_target("../../etc").is_err());
        assert_eq!(
            loopback_origin("127.0.0.1:4317").unwrap(),
            "http://127.0.0.1:4317"
        );
        assert_eq!(
            loopback_origin("localhost:4494").unwrap(),
            "http://localhost:4494"
        );
        for host in [
            "example.com:4317",
            "127.0.0.1",
            "127.0.0.1:0",
            "192.168.1.2:4317",
            "127.0.0.1:4317@evil",
        ] {
            assert!(loopback_origin(host).is_err(), "{host}");
        }
    }
}
