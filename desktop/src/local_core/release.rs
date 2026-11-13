//! Finds, downloads and verifies a signed Core release for the connection
//! page's local install (YN-107 design 4.4). Shared with the Mac app
//! (YN-108): the platform is a parameter (`linux-x86_64`, `macos-aarch64`).
//!
//! What is trusted, and nothing else:
//! - **The repository**, fixed: [`REPOSITORY`]. Nothing from the page or a
//!   saved file chooses it.
//! - **The publisher key**, built in: [`public_key`] is `desktop/core-release.pub`,
//!   the key docs/independent-core.md publishes. A new key needs a new
//!   desktop release.
//! - **The signed descriptor** (`yuzuno-core-<platform>.json`), checked with
//!   minisign and then by Core's own rules for it
//!   (core/src/updates/releases.rs, `verify_descriptor`), less "compatible
//!   with the release running", since nothing runs yet.
//! - **The archive**, by its size and SHA-256 named in that descriptor.
//!
//! Everything is kept in memory; nothing is written on this computer. GitHub
//! is asked without any token, over HTTPS only, through Windows' own proxy
//! settings and certificates (the updater's HTTP client).

use super::Error;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};
use tokio::sync::watch;

/// The only repository Core releases come from.
pub const REPOSITORY: &str = "YuzukiS/Yuzuno";

/// The Core release publisher's minisign public key, as
/// docs/independent-core.md publishes it.
const PUBLIC_KEY_FILE: &str = include_str!("../../core-release.pub");

/// The built-in publisher key: the one base64 line of `core-release.pub`.
pub fn public_key() -> &'static str {
    PUBLIC_KEY_FILE.trim_end_matches(['\n', '\r'])
}

/// Size limits: the release list as Core's GitHub client reads one, the
/// descriptor and signature as Core does (releases.rs), and the archive as
/// the desktop relay downloads one (desktop/README.md, desktop updates).
pub const MAX_LIST: u64 = 8 * 1024 * 1024;
pub const MAX_DESCRIPTOR: u64 = 8 * 1024 * 1024;
pub const MAX_SIGNATURE: u64 = 4096;
pub const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
/// Core's own bounds on what a release unpacks to (releases.rs).
const MAX_FILES: usize = 30_000;
const MAX_EXPANDED: u64 = 4 * 1024 * 1024 * 1024;
const MAX_NOTES: usize = 32_768;
/// Core's release protocol (core/src/updates/package.rs, `PROTOCOL`).
const PROTOCOL: u32 = 1;

/// How long each request may take: the list and the small files as Core
/// allows its own (releases.rs), the archive as the desktop relay does.
pub const LIST_WAIT: Duration = Duration::from_secs(30);
pub const SMALL_WAIT: Duration = Duration::from_secs(30);
pub const ARCHIVE_WAIT: Duration = Duration::from_secs(15 * 60);

/// One release asset: its name, where GitHub serves it, and its size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

/// The newest stable Core release with this platform's three assets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub tag: String,
    pub descriptor: Asset,
    pub signature: Asset,
    pub archive: Asset,
}

/// What a verified descriptor says, as far as installing needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub tag: String,
    pub release_id: String,
    pub manifest_sha256: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
}

/// A release tag this app passes on: `core-` and plain characters.
pub fn tag_ok(tag: &str) -> bool {
    tag.len() <= 100
        && tag.strip_prefix("core-").is_some_and(|rest| {
            !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new("releaseInvalid", message)
}

/// The asset called `name` in `assets`: exactly one, uploaded, of a size
/// from 1 byte to `max`, served at the fixed release download address.
fn asset(assets: &[Value], tag: &str, name: &str, max: u64) -> Result<Asset, Error> {
    let found: Vec<_> = assets.iter().filter(|asset| asset["name"] == name).collect();
    let [asset] = found.as_slice() else {
        return Err(Error::new("releaseNotFound", format!("Release {tag} has no single {name}.")));
    };
    if asset["state"] != "uploaded" {
        return Err(Error::new("releaseNotFound", format!("Release {tag}'s {name} is not ready yet.")));
    }
    let size = asset["size"].as_u64().filter(|size| *size > 0 && *size <= max).ok_or_else(|| {
        invalid(format!("Release {tag}'s {name} is empty or larger than this app downloads."))
    })?;
    let url = format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{name}");
    if asset["browser_download_url"] != url.as_str() {
        return Err(invalid(format!("Release {tag}'s {name} is not served from {REPOSITORY}'s releases.")));
    }
    Ok(Asset { name: name.to_owned(), url, size })
}

/// The three assets of `release` for `platform`.
pub fn assets(release: &Value, platform: &str) -> Result<Found, Error> {
    let tag = release["tag_name"].as_str().filter(|tag| tag_ok(tag)).ok_or_else(|| invalid("A release has a tag this app does not use."))?;
    let assets = release["assets"].as_array().ok_or_else(|| invalid(format!("Release {tag} lists no assets.")))?;
    let prefix = format!("yuzuno-core-{platform}");
    Ok(Found {
        tag: tag.to_owned(),
        descriptor: asset(assets, tag, &format!("{prefix}.json"), MAX_DESCRIPTOR)?,
        signature: asset(assets, tag, &format!("{prefix}.json.minisig"), MAX_SIGNATURE)?,
        archive: asset(assets, tag, &format!("{prefix}.tar.gz"), MAX_ARCHIVE)?,
    })
}

/// The release to install from GitHub's release list, chosen as Core
/// chooses an update (releases.rs): not a draft, not a prerelease, tagged
/// `core-` (desktop releases have tags of their own), the latest published.
pub fn choose(releases: &Value, platform: &str) -> Result<Found, Error> {
    let release = releases
        .as_array()
        .ok_or_else(|| invalid("GitHub's answer is not a list of releases."))?
        .iter()
        .filter(|release| {
            release["draft"] == false
                && release["prerelease"] == false
                && release["tag_name"].as_str().is_some_and(|tag| tag.starts_with("core-"))
        })
        .max_by_key(|release| release["published_at"].as_str().unwrap_or(""))
        .ok_or_else(|| Error::new("releaseNotFound", format!("No stable Core release is published in {REPOSITORY}.")))?;
    assets(release, platform)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    format: u32,
    repository: String,
    tag: String,
    manifest: Manifest,
    manifest_sha256: String,
    archive_sha256: String,
    archive_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: u32,
    release_id: String,
    platform: String,
    protocol: u32,
    notes: String,
    files: BTreeMap<String, File>,
}

#[derive(Deserialize)]
struct File {
    bytes: u64,
}

fn sha256_ok(hex: &str) -> bool {
    hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Checks the descriptor's signature with `key`, then what it says against
/// Core's rules and the release it came with: `platform`, the release's
/// `tag` and its archive's `archive_size`. Fields Core's rules do not read
/// are left to the installed release's own helper, which checks the whole
/// manifest again before anything is installed.
pub fn verify_descriptor(
    key: &str,
    bytes: &[u8],
    signature: &str,
    platform: &str,
    tag: &str,
    archive_size: u64,
) -> Result<Verified, Error> {
    let key = PublicKey::from_base64(key).map_err(|error| invalid(format!("The publisher key is not a minisign key ({error}).")))?;
    let signature = Signature::decode(signature).map_err(|error| Error::new("signature", format!("The release signature cannot be read ({error}).")))?;
    key.verify(bytes, &signature, false).map_err(|error| {
        Error::new("signature", format!("The release is not signed by Yuzuno's Core publisher key ({error}). Nothing was installed."))
    })?;
    let descriptor: Descriptor = serde_json::from_slice(bytes).map_err(|error| invalid(format!("The signed release descriptor cannot be read ({error}).")))?;
    check(&descriptor, platform, tag, archive_size)
}

fn check(d: &Descriptor, platform: &str, tag: &str, archive_size: u64) -> Result<Verified, Error> {
    let m = &d.manifest;
    if d.format != 1 || d.repository != REPOSITORY {
        return Err(invalid(format!("The signed release is from {}, not {REPOSITORY}.", d.repository)));
    }
    if d.tag != tag || !tag_ok(&d.tag) {
        return Err(invalid(format!("The signed release is {}, but GitHub lists it as {tag}.", d.tag)));
    }
    if m.platform != platform || m.protocol != PROTOCOL {
        return Err(invalid(format!("The signed release is for {} (protocol {}), not {platform}.", m.platform, m.protocol)));
    }
    if m.format != 1 || m.notes.len() > MAX_NOTES || !super::check_rules::release_id_ok(&m.release_id) {
        return Err(invalid("The signed release manifest is not one this app reads."));
    }
    if !sha256_ok(&d.manifest_sha256) || !sha256_ok(&d.archive_sha256) {
        return Err(invalid("The signed release has an invalid checksum."));
    }
    if d.archive_bytes != archive_size || d.archive_bytes == 0 || d.archive_bytes > MAX_ARCHIVE {
        return Err(invalid(format!(
            "The signed release says its archive has {} bytes; GitHub lists {archive_size}.",
            d.archive_bytes
        )));
    }
    let expanded = m.files.values().try_fold(0u64, |sum, file| sum.checked_add(file.bytes));
    if m.files.len() > MAX_FILES || !expanded.is_some_and(|expanded| expanded <= MAX_EXPANDED) {
        return Err(invalid("The signed release unpacks to more than Core accepts."));
    }
    Ok(Verified {
        tag: d.tag.clone(),
        release_id: m.release_id.clone(),
        manifest_sha256: d.manifest_sha256.clone(),
        archive_sha256: d.archive_sha256.clone(),
        archive_bytes: d.archive_bytes,
    })
}

/// The archive is the one the verified descriptor names: its size and
/// SHA-256.
pub fn verify_archive(verified: &Verified, archive: &[u8]) -> Result<(), Error> {
    let digest: String = Sha256::digest(archive).iter().map(|byte| format!("{byte:02x}")).collect();
    if archive.len() as u64 != verified.archive_bytes || !digest.eq_ignore_ascii_case(&verified.archive_sha256) {
        return Err(Error::new(
            "releaseInvalid",
            "The downloaded archive does not match its signed checksum. Nothing was installed.",
        ));
    }
    Ok(())
}

/// Asks GitHub for releases and their files, without any token.
pub struct Client {
    http: updater_http::Client,
}

impl Client {
    pub fn new() -> Result<Self, Error> {
        // The updater's HTTP client brings no TLS crypto of its own; the
        // updater plugin installs the same provider before it builds one.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let redirect = updater_http::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("more than 5 redirects")
            } else if attempt.url().scheme() != "https" {
                attempt.error("a redirect away from HTTPS")
            } else {
                attempt.follow()
            }
        });
        let http = updater_http::Client::builder()
            .user_agent(format!("Yuzuno-Desktop/{}", env!("CARGO_PKG_VERSION")))
            .https_only(true)
            .redirect(redirect)
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| Error::new("network", format!("Could not prepare a connection to GitHub: {error}")))?;
        Ok(Self { http })
    }

    async fn get(&self, url: &str, accept: &str, wait: Duration) -> Result<updater_http::Response, Error> {
        let response = self
            .http
            .get(url)
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
            .timeout(wait)
            .send()
            .await
            .map_err(|error| Error::new("network", format!("Could not reach GitHub: {}", chain(&error))))?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(response);
        }
        let exhausted = response.headers().get("x-ratelimit-remaining").is_some_and(|left| left == "0");
        Err(match status {
            429 => rate_limited(),
            403 if exhausted => rate_limited(),
            404 => Error::new("releaseNotFound", format!("GitHub has no such release or file in {REPOSITORY} (HTTP 404).")),
            _ => Error::new("network", format!("GitHub answered HTTP {status}.")),
        })
    }

    /// Reads a body of at most `limit` bytes, reporting progress and
    /// stopping when `cancel` turns true.
    async fn body(
        mut response: updater_http::Response,
        limit: u64,
        cancel: &mut watch::Receiver<bool>,
        progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<Vec<u8>, Error> {
        let too_large = || Error::new("releaseInvalid", "GitHub sent more than this app downloads.");
        if response.content_length().is_some_and(|length| length > limit) {
            return Err(too_large());
        }
        let mut body = Vec::new();
        loop {
            if *cancel.borrow() {
                return Err(cancelled());
            }
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk,
                () = asked_to_stop(cancel) => return Err(cancelled()),
            };
            match chunk.map_err(|error| Error::new("network", format!("The download from GitHub broke off: {}", chain(&error))))? {
                Some(chunk) if body.len() as u64 + chunk.len() as u64 <= limit => {
                    body.extend_from_slice(&chunk);
                    progress(body.len() as u64);
                }
                Some(_) => return Err(too_large()),
                None => return Ok(body),
            }
        }
    }

    /// GitHub's list of the repository's releases (the first 100).
    pub async fn releases(&self, cancel: &mut watch::Receiver<bool>) -> Result<Value, Error> {
        let url = format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=100");
        let response = self.get(&url, "application/vnd.github+json", LIST_WAIT).await?;
        let body = Self::body(response, MAX_LIST, cancel, &mut |_| {}).await?;
        serde_json::from_slice(&body).map_err(|_| invalid("GitHub's release list cannot be read."))
    }

    /// One release, by its tag (the check of a real release).
    #[cfg(test)]
    pub async fn release(&self, tag: &str) -> Result<Value, Error> {
        let url = format!("https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}");
        let response = self.get(&url, "application/vnd.github+json", LIST_WAIT).await?;
        let body = Self::body(response, MAX_LIST, &mut watch::channel(false).1, &mut |_| {}).await?;
        serde_json::from_slice(&body).map_err(|_| invalid("GitHub's release cannot be read."))
    }

    /// An asset's bytes, which must be exactly its listed size.
    pub async fn download(
        &self,
        asset: &Asset,
        wait: Duration,
        cancel: &mut watch::Receiver<bool>,
        progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<Vec<u8>, Error> {
        let response = self.get(&asset.url, "application/octet-stream", wait).await?;
        let body = Self::body(response, asset.size, cancel, progress).await?;
        if body.len() as u64 != asset.size {
            return Err(Error::new("network", format!("{} arrived incomplete ({} of {} bytes).", asset.name, body.len(), asset.size)));
        }
        Ok(body)
    }
}

/// Ends when `cancel` turns true; never, once nothing can turn it so.
async fn asked_to_stop(cancel: &mut watch::Receiver<bool>) {
    if cancel.wait_for(|cancelled| *cancelled).await.is_err() {
        std::future::pending::<()>().await;
    }
}

fn rate_limited() -> Error {
    Error::new(
        "rateLimited",
        "GitHub's limit for downloads without signing in (60 an hour from one address) is used up. Try again later.",
    )
}

pub fn cancelled() -> Error {
    Error::new("cancelled", "The installation was cancelled. Nothing was installed.")
}

/// An error with its causes, as a person can read it.
fn chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Signed with a throwaway key made only for these tests (its secret was
    // discarded); not the publisher's. The verifier checks an archive only
    // by its size and SHA-256, so the archive they sign is a text stand-in.
    const TEST_KEY: &str = include_str!("../../tests/fixtures/release/test-key.pub");
    const DESCRIPTOR: &[u8] = include_bytes!("../../tests/fixtures/release/yuzuno-core-linux-x86_64.json");
    const SIGNATURE: &str = include_str!("../../tests/fixtures/release/yuzuno-core-linux-x86_64.json.minisig");
    const LEGACY: &str = include_str!("../../tests/fixtures/release/yuzuno-core-linux-x86_64.json.legacy.minisig");
    const MAC_DESCRIPTOR: &[u8] = include_bytes!("../../tests/fixtures/release/yuzuno-core-macos-aarch64.json");
    const MAC_SIGNATURE: &str = include_str!("../../tests/fixtures/release/yuzuno-core-macos-aarch64.json.minisig");
    const ARCHIVE: &[u8] = include_bytes!("../../tests/fixtures/release/archive-stand-in.txt");
    const TAG: &str = "core-20991231-0a1b2c3";

    fn test_key() -> &'static str {
        TEST_KEY.trim_end()
    }

    #[test]
    fn the_built_in_key_is_one_minisign_key_and_not_the_test_key() {
        assert_eq!(PUBLIC_KEY_FILE.lines().count(), 1);
        assert!(PublicKey::from_base64(public_key()).is_ok());
        assert_ne!(public_key(), test_key());
    }

    #[test]
    fn a_signed_descriptor_is_verified_and_read() {
        let verified = verify_descriptor(test_key(), DESCRIPTOR, SIGNATURE, "linux-x86_64", TAG, ARCHIVE.len() as u64).unwrap();
        assert_eq!(verified.tag, TAG);
        assert_eq!(verified.release_id, "20991231-0a1b2c3");
        assert_eq!(verified.archive_bytes, ARCHIVE.len() as u64);
        verify_archive(&verified, ARCHIVE).unwrap();
        // The same check for the Mac's platform, with its own descriptor.
        let mac = verify_descriptor(test_key(), MAC_DESCRIPTOR, MAC_SIGNATURE, "macos-aarch64", TAG, ARCHIVE.len() as u64).unwrap();
        assert_eq!(mac.release_id, verified.release_id);
    }

    #[test]
    fn a_wrong_key_or_changed_bytes_or_a_legacy_signature_is_refused() {
        let code = |result: Result<Verified, Error>| result.unwrap_err().code;
        // The publisher's real key did not sign the test file.
        assert_eq!(code(verify_descriptor(public_key(), DESCRIPTOR, SIGNATURE, "linux-x86_64", TAG, ARCHIVE.len() as u64)), "signature");
        let mut changed = DESCRIPTOR.to_vec();
        let at = changed.iter().position(|&byte| byte == b'0').unwrap();
        changed[at] = b'1';
        assert_eq!(code(verify_descriptor(test_key(), &changed, SIGNATURE, "linux-x86_64", TAG, ARCHIVE.len() as u64)), "signature");
        assert_eq!(code(verify_descriptor(test_key(), DESCRIPTOR, LEGACY, "linux-x86_64", TAG, ARCHIVE.len() as u64)), "signature");
        // Another file's signature.
        assert_eq!(code(verify_descriptor(test_key(), MAC_DESCRIPTOR, SIGNATURE, "macos-aarch64", TAG, ARCHIVE.len() as u64)), "signature");
        assert_eq!(code(verify_descriptor(test_key(), DESCRIPTOR, "not a signature", "linux-x86_64", TAG, 1)), "signature");
        assert_eq!(code(verify_descriptor("not a key", DESCRIPTOR, SIGNATURE, "linux-x86_64", TAG, 1)), "releaseInvalid");
    }

    #[test]
    fn a_signed_descriptor_for_another_platform_tag_or_size_is_refused() {
        let size = ARCHIVE.len() as u64;
        for (platform, tag, size) in [
            ("macos-aarch64", TAG, size),
            ("linux-aarch64", TAG, size),
            ("linux-x86_64", "core-20991231-other", size),
            ("linux-x86_64", TAG, size + 1),
        ] {
            let error = verify_descriptor(test_key(), DESCRIPTOR, SIGNATURE, platform, tag, size).unwrap_err();
            assert_eq!(error.code, "releaseInvalid", "{platform} {tag} {size}: {}", error.message);
        }
    }

    fn descriptor() -> Value {
        serde_json::from_slice(DESCRIPTOR).unwrap()
    }

    fn checked(value: Value) -> Result<Verified, Error> {
        let descriptor: Descriptor = serde_json::from_value(value).map_err(|error| invalid(error.to_string()))?;
        check(&descriptor, "linux-x86_64", TAG, ARCHIVE.len() as u64)
    }

    #[test]
    fn each_of_cores_rules_for_a_descriptor_is_kept() {
        assert!(checked(descriptor()).is_ok());
        let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
            ("format", Box::new(|d: &mut Value| d["format"] = json!(2))),
            ("repository", Box::new(|d: &mut Value| d["repository"] = json!("someone/Yuzuno"))),
            ("tag", Box::new(|d: &mut Value| d["tag"] = json!("core-20991231-other"))),
            ("platform", Box::new(|d: &mut Value| d["manifest"]["platform"] = json!("linux-aarch64"))),
            ("protocol", Box::new(|d: &mut Value| d["manifest"]["protocol"] = json!(2))),
            ("manifest format", Box::new(|d: &mut Value| d["manifest"]["format"] = json!(2))),
            ("release id", Box::new(|d: &mut Value| d["manifest"]["releaseId"] = json!("../20991231"))),
            ("notes", Box::new(|d: &mut Value| d["manifest"]["notes"] = json!("x".repeat(MAX_NOTES + 1)))),
            ("manifest checksum", Box::new(|d: &mut Value| d["manifestSha256"] = json!("00"))),
            ("archive checksum", Box::new(|d: &mut Value| d["archiveSha256"] = json!("z".repeat(64)))),
            ("archive size", Box::new(|d: &mut Value| d["archiveBytes"] = json!(1))),
            ("expanded size", Box::new(|d: &mut Value| {
                d["manifest"]["files"]["bin/big"] = json!({"bytes": MAX_EXPANDED, "sha256": "0".repeat(64), "executable": false})
            })),
            ("missing field", Box::new(|d: &mut Value| {
                d.as_object_mut().unwrap().remove("archiveSha256");
            })),
        ];
        for (rule, change) in cases {
            let mut value = descriptor();
            change(&mut value);
            assert_eq!(checked(value).map(|_| ()).unwrap_err().code, "releaseInvalid", "{rule}");
        }
    }

    #[test]
    fn an_archive_that_differs_from_its_checksum_is_refused() {
        let verified = verify_descriptor(test_key(), DESCRIPTOR, SIGNATURE, "linux-x86_64", TAG, ARCHIVE.len() as u64).unwrap();
        let mut changed = ARCHIVE.to_vec();
        changed[20] ^= 1;
        assert_eq!(verify_archive(&verified, &changed).unwrap_err().code, "releaseInvalid");
        assert_eq!(verify_archive(&verified, &ARCHIVE[1..]).unwrap_err().code, "releaseInvalid");
    }

    fn uploaded(tag: &str, name: &str, size: u64) -> Value {
        json!({
            "name": name,
            "state": "uploaded",
            "size": size,
            "browser_download_url": format!("https://github.com/YuzukiS/Yuzuno/releases/download/{tag}/{name}"),
        })
    }

    fn release(tag: &str, published: &str, draft: bool, prerelease: bool) -> Value {
        json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "published_at": published,
            "assets": [
                uploaded(tag, "yuzuno-core-linux-x86_64.json", 1200),
                uploaded(tag, "yuzuno-core-linux-x86_64.json.minisig", 300),
                uploaded(tag, "yuzuno-core-linux-x86_64.tar.gz", 50_000_000),
                uploaded(tag, "yuzuno-core-macos-aarch64.json", 1200),
                uploaded(tag, "yuzuno-core-macos-aarch64.json.minisig", 300),
                uploaded(tag, "yuzuno-core-macos-aarch64.tar.gz", 40_000_000),
            ],
        })
    }

    #[test]
    fn the_latest_stable_core_release_is_chosen() {
        let list = json!([
            release("core-20261101-aaaaaaa", "2026-11-01T00:00:00Z", false, false),
            release("core-20261113-bbbbbbb", "2026-11-13T00:00:00Z", false, false),
            // Newer, but not a stable Core release.
            release("desktop-0.5.0", "2026-11-14T00:00:00Z", false, false),
            release("core-20261115-ccccccc", "2026-11-15T00:00:00Z", true, false),
            release("core-20261116-ddddddd", "2026-11-16T00:00:00Z", false, true),
        ]);
        let found = choose(&list, "linux-x86_64").unwrap();
        assert_eq!(found.tag, "core-20261113-bbbbbbb");
        assert_eq!(
            found.archive,
            Asset {
                name: "yuzuno-core-linux-x86_64.tar.gz".into(),
                url: "https://github.com/YuzukiS/Yuzuno/releases/download/core-20261113-bbbbbbb/yuzuno-core-linux-x86_64.tar.gz".into(),
                size: 50_000_000,
            }
        );
        assert_eq!(found.signature.size, 300);
        assert_eq!(choose(&list, "macos-aarch64").unwrap().archive.size, 40_000_000);
        assert_eq!(choose(&json!([release("desktop-0.5.0", "2026-11-14T00:00:00Z", false, false)]), "linux-x86_64").unwrap_err().code, "releaseNotFound");
        assert_eq!(choose(&json!({"message": "Not Found"}), "linux-x86_64").unwrap_err().code, "releaseInvalid");
    }

    #[test]
    fn a_missing_duplicate_unready_large_or_elsewhere_asset_is_refused() {
        let tag = "core-20261113-bbbbbbb";
        let with = |change: &dyn Fn(&mut Vec<Value>)| {
            let mut release = release(tag, "2026-11-13T00:00:00Z", false, false);
            change(release["assets"].as_array_mut().unwrap());
            assets(&release, "linux-x86_64").map(|_| ()).unwrap_err().code
        };
        assert_eq!(with(&|assets| { assets.remove(1); }), "releaseNotFound");
        assert_eq!(with(&|assets| assets.push(uploaded(tag, "yuzuno-core-linux-x86_64.tar.gz", 10))), "releaseNotFound");
        assert_eq!(with(&|assets| assets[0]["state"] = json!("new")), "releaseNotFound");
        assert_eq!(with(&|assets| assets[2]["size"] = json!(MAX_ARCHIVE + 1)), "releaseInvalid");
        assert_eq!(with(&|assets| assets[1]["size"] = json!(MAX_SIGNATURE + 1)), "releaseInvalid");
        assert_eq!(with(&|assets| assets[0]["size"] = json!(0)), "releaseInvalid");
        for url in [
            "https://github.com/someone/Yuzuno/releases/download/core-20261113-bbbbbbb/yuzuno-core-linux-x86_64.tar.gz",
            "http://github.com/YuzukiS/Yuzuno/releases/download/core-20261113-bbbbbbb/yuzuno-core-linux-x86_64.tar.gz",
            "https://example.com/yuzuno-core-linux-x86_64.tar.gz",
        ] {
            assert_eq!(with(&|assets| assets[2]["browser_download_url"] = json!(url)), "releaseInvalid", "{url}");
        }
        // A tag this app would not pass on.
        let mut odd = release("core-x y", "2026-11-13T00:00:00Z", false, false);
        odd["tag_name"] = json!("core-x y");
        assert_eq!(assets(&odd, "linux-x86_64").unwrap_err().code, "releaseInvalid");
    }

    #[test]
    fn tags_this_app_passes_on() {
        for tag in ["core-20261113-b870c92", "core-1.2_3"] {
            assert!(tag_ok(tag), "{tag}");
        }
        let long = format!("core-{}", "1".repeat(100));
        for tag in ["core-", "desktop-0.4.0", "core-x y", "core-a/b", "core-$(x)", long.as_str()] {
            assert!(!tag_ok(tag), "{tag}");
        }
    }

    /// The real release core-20261113-b870c92 from GitHub, checked with the
    /// built-in key, when YUZUNO_DESKTOP_REAL_RELEASE is set: shows that key
    /// is the one Core releases are signed with. Downloads the descriptor,
    /// its signature and the archive (into memory only).
    #[test]
    fn a_real_release_verifies_with_the_built_in_key() {
        if std::env::var_os("YUZUNO_DESKTOP_REAL_RELEASE").is_none() {
            return;
        }
        tauri::async_runtime::block_on(async {
            let client = Client::new().unwrap();
            let tag = "core-20261113-b870c92";
            let release = client.release(tag).await.unwrap();
            let found = assets(&release, "linux-x86_64").unwrap();
            let mut cancel = watch::channel(false).1;
            let descriptor = client.download(&found.descriptor, SMALL_WAIT, &mut cancel, &mut |_| {}).await.unwrap();
            let signature = client.download(&found.signature, SMALL_WAIT, &mut cancel, &mut |_| {}).await.unwrap();
            let signature = String::from_utf8(signature).unwrap();
            let verified = verify_descriptor(public_key(), &descriptor, &signature, "linux-x86_64", tag, found.archive.size).unwrap();
            let digest = |bytes: &[u8]| Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            println!(
                "real release {tag}: descriptor {} bytes sha256 {}, signature sha256 {}, releaseId {}, archive {} bytes",
                descriptor.len(),
                digest(&descriptor),
                digest(signature.as_bytes()),
                verified.release_id,
                verified.archive_bytes
            );
            let archive = client.download(&found.archive, ARCHIVE_WAIT, &mut cancel, &mut |_| {}).await.unwrap();
            verify_archive(&verified, &archive).unwrap();
            println!("real release {tag}: archive sha256 {} matches the signed descriptor", digest(&archive));
            // The list's choice is a stable Core release with the same checks.
            let latest = choose(&client.releases(&mut cancel).await.unwrap(), "linux-x86_64").unwrap();
            println!("latest stable Core release: {}", latest.tag);
        });
    }
}
