//! Desktop app releases, relayed to a desktop on this computer (T-13).
//!
//! The desktop's own updater verifies every installer against the public key
//! built into it, and that the signed version is the announced one, so Core
//! only carries bytes here and decides nothing about trust. It reads the
//! project's fixed `desktop-<version>` Releases with this host's
//! GitHub login, or without one when gh is missing or not signed in
//! (public_github), and serves exactly two things for a known target: a Tauri
//! updater manifest whose installer URL points back at this Core, and that
//! release's update file for the target (the Windows installer, the Mac app
//! archive). No caller chooses a repository, URL or file.
use super::{
    controller::Controller,
    public_github::{PublicGithub, Route},
};
use crate::github::client::Client;
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    sync::{atomic::AtomicU64, OnceLock},
    time::Duration,
};
use tokio::sync::Semaphore;

const REPOSITORY: &str = "YuzukiS/Yuzuno";
/// Each target's update file, as its Tauri updater installs it. The file's
/// signature is always `<file>.sig`.
const TARGETS: [(&str, &str); 2] = [
    ("windows-x86_64", "yuzuno-desktop-windows-x86_64-setup.exe"),
    ("darwin-aarch64", "yuzuno-desktop-darwin-aarch64.app.tar.gz"),
];
const MAX_INSTALLER: u64 = 512 * 1024 * 1024;
const MAX_SIGNATURE: u64 = 4096;
const MAX_NOTES: usize = 16 * 1024;
const SIGNATURE_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct DesktopReleases {
    pub(crate) client: Client,
    /// Used only when gh is missing or not signed in (YN-110).
    pub(crate) public: PublicGithub,
    /// One installer transfer at a time.
    transfers: Semaphore,
}

impl Default for DesktopReleases {
    fn default() -> Self {
        Self {
            client: Client::default(),
            public: PublicGithub::default(),
            transfers: Semaphore::new(1),
        }
    }
}

pub fn shared() -> &'static DesktopReleases {
    static SHARED: OnceLock<DesktopReleases> = OnceLock::new();
    SHARED.get_or_init(DesktopReleases::default)
}

/// The known target and its update file.
pub fn known_target(target: &str) -> Result<(&'static str, &'static str)> {
    TARGETS
        .into_iter()
        .find(|(known, _)| *known == target)
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

/// The newest stable desktop release that has both of `target`'s files, or
/// the one tagged `tag`, which must have them. A release may carry only some
/// targets, so a target whose file the newest release lacks gets an older one.
/// Core releases and drafts are never considered.
fn select(
    releases: &Value,
    (target, file): (&str, &str),
    tag: Option<&str>,
) -> Result<Release> {
    let files = |release: &Value| -> Result<_> {
        Ok((
            asset(release, file, MAX_INSTALLER)?,
            asset(release, &format!("{file}.sig"), MAX_SIGNATURE)?,
        ))
    };
    let stable = releases
        .as_array()
        .context("Invalid GitHub release list")?
        .iter()
        .filter(|r| r["draft"] == false && r["prerelease"] == false)
        .filter(|r| r["tag_name"].as_str().and_then(tag_version).is_some());
    let (release, (installer, signature)) = match tag {
        // Only that release: without its files it is refused, never replaced.
        Some(tag) => {
            let release = stable
                .filter(|r| r["tag_name"] == tag)
                .max_by_key(|r| r["published_at"].as_str().unwrap_or(""))
                .context("No desktop release has been published in this repository")?;
            (release, files(release)?)
        }
        None => stable
            .filter_map(|r| files(r).ok().map(|found| (r, found)))
            .max_by_key(|(r, _)| r["published_at"].as_str().unwrap_or(""))
            .with_context(|| format!("No published desktop release has a {target} update"))?,
    };
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
        installer,
        signature,
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
    /// Each manifest or installer is one operation with its own route.
    fn route(&self) -> Route<'_> {
        Route::new(&self.client, &self.public)
    }

    async fn releases(route: &mut Route<'_>) -> Result<Value> {
        // Boxed: the client's futures are large, and callers may run on a small stack.
        Box::pin(route.get(&format!("repos/{REPOSITORY}/releases?per_page=100"))).await
    }

    /// The updater manifest for `target`, pointing at this Core for the
    /// installer. The signature is carried as published; the desktop checks it.
    pub async fn manifest(
        &self,
        controller: &Controller,
        target: &str,
        host: &str,
    ) -> Result<Value> {
        let (target, file) = known_target(target)?;
        let origin = loopback_origin(host)?;
        let mut route = self.route();
        let releases = Self::releases(&mut route).await?;
        let release = select(&releases, (target, file), None)?;
        let scratch = tempfile::Builder::new()
            .prefix("desktop-signature-")
            .tempdir_in(scratch_root(controller)?)?;
        let path = scratch.path().join("installer.sig");
        Box::pin(route.download(
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

    /// That release's update file for `target`, in a file deleted when dropped.
    pub async fn installer(
        &self,
        controller: &Controller,
        target: &str,
        tag: &str,
    ) -> Result<(tempfile::NamedTempFile, u64)> {
        let (target, file) = known_target(target)?;
        if tag_version(tag).is_none() {
            bail!("Not a desktop release tag");
        }
        let _transfer = self.transfers.try_acquire().map_err(|_| {
            anyhow::anyhow!("Another desktop installer is being transferred; try again shortly")
        })?;
        let mut route = self.route();
        let releases = Self::releases(&mut route).await?;
        let release = select(&releases, (target, file), Some(tag))?;
        let download = tempfile::Builder::new()
            .prefix("desktop-installer-")
            .tempfile_in(scratch_root(controller)?)?;
        // The GitHub client creates the file itself.
        let path = download.path().to_owned();
        std::fs::remove_file(&path)?;
        Box::pin(route.download(
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
        Ok((download, size))
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
    const MAC_UPDATE: &[u8] = b"\x1f\x8b fixture Mac app archive bytes";
    const MAC_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IE1hYyBzaWduYXR1cmUgZnJvbSB0YXVyaQo=";

    /// Managed or checkout Core with no Core release key; its GitHub fixture has one Core release, a
    /// draft and three desktop releases: 0.3.0 for Windows only, 0.2.0 for Windows and the Mac,
    /// 0.1.0 for Windows only.
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
        std::fs::write(dir.path().join("asset-31"), MAC_UPDATE).unwrap();
        std::fs::write(dir.path().join("asset-32"), MAC_SIGNATURE).unwrap();
        let script = dir.path().join("gh-fixture.py");
        std::fs::write(&script, format!(r#"#!/usr/bin/python3
import json,sys
from pathlib import Path
root=Path(__file__).parent
assert sys.argv[1:6] == ['api','--hostname','github.com','--method','GET']
endpoint=sys.argv[-1]
windows=[{{'id':21,'name':'yuzuno-desktop-windows-x86_64-setup.exe','state':'uploaded','size':{installer}}},
 {{'id':22,'name':'yuzuno-desktop-windows-x86_64-setup.exe.sig','state':'uploaded','size':{signature}}}]
mac=[{{'id':31,'name':'yuzuno-desktop-darwin-aarch64.app.tar.gz','state':'uploaded','size':{mac_update}}},
 {{'id':32,'name':'yuzuno-desktop-darwin-aarch64.app.tar.gz.sig','state':'uploaded','size':{mac_signature}}}]
if endpoint == 'repos/YuzukiS/Yuzuno/releases?per_page=100':
 print(json.dumps([
  {{'tag_name':'core-test','draft':False,'prerelease':False,'published_at':'2026-10-18T00:00:00Z','assets':[]}},
  {{'tag_name':'desktop-9.0.0','draft':True,'prerelease':False,'published_at':'2026-10-17T00:00:00Z','assets':windows+mac}},
  {{'tag_name':'desktop-0.3.0','draft':False,'prerelease':False,'published_at':'2026-10-16T00:00:00Z','body':'Windows fix','assets':windows}},
  {{'tag_name':'desktop-0.2.0','draft':False,'prerelease':False,'published_at':'2026-10-15T00:00:00Z','body':'Faster start','assets':windows+mac}},
  {{'tag_name':'desktop-0.1.0','draft':False,'prerelease':False,'published_at':'2026-10-14T00:00:00Z','body':'First','assets':windows}}]))
elif endpoint.startswith('repos/YuzukiS/Yuzuno/releases/assets/'):
 sys.stdout.buffer.write((root/('asset-'+endpoint.rsplit('/',1)[1])).read_bytes())
else: raise AssertionError(endpoint)
"#, installer = INSTALLER.len(), signature = SIGNATURE.len(),
            mac_update = MAC_UPDATE.len(), mac_signature = MAC_SIGNATURE.len())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let releases = DesktopReleases {
            client: Client {
                program: script.to_string_lossy().into(),
                deadline: Duration::from_secs(10),
                ..Default::default()
            },
            public: PublicGithub::default(),
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
            assert_eq!(
                manifest["version"], "0.3.0",
                "the newest release, though it has no Mac update"
            );
            assert_eq!(manifest["notes"], "Windows fix");
            assert_eq!(manifest["pub_date"], "2026-10-16T00:00:00Z");
            let platform = &manifest["platforms"]["windows-x86_64"];
            assert_eq!(
                platform["signature"], SIGNATURE,
                "carried as published; the desktop verifies it"
            );
            assert_eq!(
            platform["url"],
            "http://127.0.0.1:4495/api/updates/desktop/windows-x86_64/installer?tag=desktop-0.3.0"
        );
            assert_eq!(manifest["platforms"].as_object().unwrap().len(), 1);
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
                "desktop-0.4.0",
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
    async fn the_mac_gets_the_newest_release_with_its_update_from_this_core() {
        for managed in [false, true] {
            let (_dir, controller, releases) = fixture(managed);
            let manifest = releases
                .manifest(&controller, "darwin-aarch64", "127.0.0.1:4495")
                .await
                .unwrap();
            assert_eq!(
                manifest["version"], "0.2.0",
                "the newest release that has a Mac update; 0.3.0 has none"
            );
            assert_eq!(manifest["notes"], "Faster start");
            assert_eq!(manifest["pub_date"], "2026-10-15T00:00:00Z");
            let platform = &manifest["platforms"]["darwin-aarch64"];
            assert_eq!(
                platform["signature"], MAC_SIGNATURE,
                "the Mac update's own signature, carried as published"
            );
            assert_eq!(
                platform["url"],
                "http://127.0.0.1:4495/api/updates/desktop/darwin-aarch64/installer?tag=desktop-0.2.0"
            );
            assert_eq!(manifest["platforms"].as_object().unwrap().len(), 1);
            let (file, size) = releases
                .installer(&controller, "darwin-aarch64", "desktop-0.2.0")
                .await
                .unwrap();
            assert_eq!(
                (std::fs::read(file.path()).unwrap(), size),
                (MAC_UPDATE.to_vec(), MAC_UPDATE.len() as u64)
            );
            // A named release without the Mac's files is refused, never replaced by another.
            for tag in ["desktop-0.3.0", "desktop-0.1.0"] {
                let refused = releases
                    .installer(&controller, "darwin-aarch64", tag)
                    .await
                    .err()
                    .unwrap_or_else(|| panic!("{tag}"));
                assert_eq!(
                    format!("{refused:#}"),
                    "The desktop release has no yuzuno-desktop-darwin-aarch64.app.tar.gz",
                    "{tag}"
                );
            }
            assert!(releases
                .installer(&controller, "darwin-aarch64", "desktop-9.0.0")
                .await
                .is_err());
            assert!(releases
                .manifest(&controller, "darwin-aarch64", "evil.example:4495")
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn without_gh_the_relay_reads_the_public_releases() {
        use crate::updates::public_github::stand_in::{self, Answer};
        let (dir, controller, mut releases) = fixture(false);
        releases.client.program = dir.path().join("no-gh").to_string_lossy().into();
        let github = stand_in::serve(|path, _| match path {
            "/repos/YuzukiS/Yuzuno/releases?per_page=100" => Answer::ok(json!([
                release("desktop-0.2.0", "2026-10-15T00:00:00Z", json!([
                    {"id":21,"name":"yuzuno-desktop-windows-x86_64-setup.exe","state":"uploaded","size":INSTALLER.len()},
                    {"id":22,"name":"yuzuno-desktop-windows-x86_64-setup.exe.sig","state":"uploaded","size":SIGNATURE.len()}])),
            ]).to_string()),
            "/repos/YuzukiS/Yuzuno/releases/assets/21" => Answer::ok(INSTALLER),
            "/repos/YuzukiS/Yuzuno/releases/assets/22" => Answer::ok(SIGNATURE),
            _ => Answer::status(404),
        });
        releases.public = github.reader(&[]);
        let manifest = releases
            .manifest(&controller, "windows-x86_64", "127.0.0.1:4495")
            .await
            .unwrap();
        assert_eq!(manifest["version"], "0.2.0");
        assert_eq!(manifest["platforms"]["windows-x86_64"]["signature"], SIGNATURE);
        let (file, size) = releases
            .installer(&controller, "windows-x86_64", "desktop-0.2.0")
            .await
            .unwrap();
        assert_eq!((std::fs::read(file.path()).unwrap(), size), (INSTALLER.to_vec(), INSTALLER.len() as u64));
        let requests = github.requests();
        assert_eq!(requests.len(), 4, "{requests:?}");
        assert!(requests.iter().all(|head| head.starts_with("GET /repos/YuzukiS/Yuzuno/releases")), "{requests:?}");
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
    fn mac_assets() -> Value {
        json!([
            {"id":13,"name":"yuzuno-desktop-darwin-aarch64.app.tar.gz","state":"uploaded","size":8192},
            {"id":14,"name":"yuzuno-desktop-darwin-aarch64.app.tar.gz.sig","state":"uploaded","size":310},
        ])
    }
    fn both() -> Value {
        let mut both = assets();
        both.as_array_mut()
            .unwrap()
            .extend(mac_assets().as_array().unwrap().iter().cloned());
        both
    }
    fn windows() -> (&'static str, &'static str) {
        known_target("windows-x86_64").unwrap()
    }
    fn mac() -> (&'static str, &'static str) {
        known_target("darwin-aarch64").unwrap()
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
        let newest = select(&list, windows(), None).unwrap();
        assert_eq!(
            (newest.tag.as_str(), newest.version.as_str()),
            ("desktop-0.3.0", "0.3.0")
        );
        assert_eq!(
            (newest.installer, newest.signature),
            ((11, 4096), (12, 300))
        );
        assert_eq!(
            select(&list, windows(), Some("desktop-0.2.0"))
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
            assert!(select(&list, windows(), Some(tag)).is_err(), "{tag}");
        }
        let missing = json!([release(
            "desktop-1.0.0",
            "2026-10-14T00:00:00Z",
            json!([assets()[0].clone()])
        )]);
        assert_eq!(
            select(&missing, windows(), None)
                .err()
                .unwrap()
                .to_string(),
            "No published desktop release has a windows-x86_64 update"
        );
        assert!(select(&missing, windows(), Some("desktop-1.0.0"))
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
        assert!(select(&huge, windows(), None).is_err());
        let pending = json!([release(
            "desktop-1.0.0",
            "2026-10-14T00:00:00Z",
            json!([
            {"id":1,"name":"yuzuno-desktop-windows-x86_64-setup.exe","state":"starter","size":10},
            assets()[1].clone()])
        )]);
        assert!(select(&pending, windows(), None).is_err());
    }

    #[test]
    fn each_target_gets_the_newest_release_that_has_both_of_its_files() {
        let list = json!([
            release("desktop-0.4.0", "2026-10-15T00:00:00Z", mac_assets()),
            release("desktop-0.3.0", "2026-10-14T00:00:00Z", assets()),
            release("desktop-0.2.0", "2026-10-13T00:00:00Z", both()),
            release("desktop-0.1.0", "2026-10-12T00:00:00Z", both()),
        ]);
        // 0.4.0 has only the Mac's files, 0.3.0 only Windows': each target
        // passes over the newer release that lacks its own.
        let win = select(&list, windows(), None).unwrap();
        assert_eq!(
            (win.tag.as_str(), win.installer, win.signature),
            ("desktop-0.3.0", (11, 4096), (12, 300))
        );
        let newest_mac = select(&list, mac(), None).unwrap();
        assert_eq!(
            (newest_mac.tag.as_str(), newest_mac.installer, newest_mac.signature),
            ("desktop-0.4.0", (13, 8192), (14, 310))
        );
        let without_mac_fix = json!([list[1].clone(), list[2].clone(), list[3].clone()]);
        assert_eq!(
            select(&without_mac_fix, windows(), None).unwrap().tag,
            "desktop-0.3.0",
            "Windows still gets the newest release when it has no Mac files"
        );
        let mac_update = select(&without_mac_fix, mac(), None).unwrap();
        assert_eq!(
            (mac_update.tag.as_str(), mac_update.version.as_str(), mac_update.installer),
            ("desktop-0.2.0", "0.2.0", (13, 8192))
        );
        // A named release is that one: refused without this target's files,
        // never replaced by an older one.
        assert_eq!(
            select(&list, mac(), Some("desktop-0.1.0")).unwrap().version,
            "0.1.0"
        );
        let refused = select(&list, mac(), Some("desktop-0.3.0"))
            .err()
            .unwrap()
            .to_string();
        assert_eq!(
            refused,
            "The desktop release has no yuzuno-desktop-darwin-aarch64.app.tar.gz"
        );
        assert!(select(&list, windows(), Some("desktop-0.4.0")).is_err());
        // No release for the Mac at all: the error names it (a 404 to the app).
        let windows_only = json!([list[1].clone()]);
        assert_eq!(
            select(&windows_only, mac(), None)
                .err()
                .unwrap()
                .to_string(),
            "No published desktop release has a darwin-aarch64 update"
        );
        assert!(select(&json!([]), mac(), None).is_err());
    }

    #[test]
    fn the_size_and_upload_rules_hold_for_the_mac_update_too() {
        let (archive, signature) = (mac_assets()[0].clone(), mac_assets()[1].clone());
        let with = |field: &str, value: Value, of: &Value| {
            let mut asset = of.clone();
            asset[field] = value;
            asset
        };
        for broken in [
            json!([with("size", json!(MAX_INSTALLER + 1), &archive), signature.clone()]),
            json!([with("size", json!(0), &archive), signature.clone()]),
            json!([with("state", json!("starter"), &archive), signature.clone()]),
            json!([archive.clone(), with("size", json!(MAX_SIGNATURE + 1), &signature)]),
            json!([archive.clone(), with("state", json!("starter"), &signature)]),
            json!([archive.clone()]),
            json!([signature.clone()]),
        ] {
            let list = json!([
                release("desktop-0.5.0", "2026-10-15T00:00:00Z", broken.clone()),
                release("desktop-0.2.0", "2026-10-13T00:00:00Z", both()),
            ]);
            assert_eq!(
                select(&list, mac(), None).unwrap().tag,
                "desktop-0.2.0",
                "a newer release with a broken Mac update is passed over: {broken}"
            );
            assert!(
                select(&list, mac(), Some("desktop-0.5.0")).is_err(),
                "{broken}"
            );
            assert!(
                select(&json!([list[0].clone()]), mac(), None).is_err(),
                "{broken}"
            );
        }
        // At the limits it is offered.
        let at_limits = json!([release(
            "desktop-0.5.0",
            "2026-10-15T00:00:00Z",
            json!([
                with("size", json!(MAX_INSTALLER), &archive),
                with("size", json!(MAX_SIGNATURE), &signature)
            ])
        )]);
        let offered = select(&at_limits, mac(), None).unwrap();
        assert_eq!(
            (offered.installer, offered.signature),
            ((13, MAX_INSTALLER), (14, MAX_SIGNATURE))
        );
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
        assert_eq!(
            known_target("windows-x86_64").unwrap(),
            ("windows-x86_64", "yuzuno-desktop-windows-x86_64-setup.exe")
        );
        assert_eq!(
            known_target("darwin-aarch64").unwrap(),
            ("darwin-aarch64", "yuzuno-desktop-darwin-aarch64.app.tar.gz")
        );
        for unknown in [
            "linux-x86_64",
            "darwin-x86_64",
            "darwin-universal",
            "windows-aarch64",
            "../../etc",
            "",
        ] {
            assert!(known_target(unknown).is_err(), "{unknown}");
        }
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
