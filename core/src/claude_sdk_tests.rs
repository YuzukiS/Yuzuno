//! The Claude runtime of a release that leaves the SDK out (T-159), prepared
//! from synthetic packages: no network, no real SDK, no Claude.
use super::*;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

const SDK: &[(&str, &str)] = &[
    ("package.json", r#"{"name":"@anthropic-ai/claude-agent-sdk","version":"0.3.296"}"#),
    ("sdk.mjs", "export const query = () => {};\n"),
    ("vendor/x.js", "vendored\n"),
];
const PLACEHOLDER: &str = r#"{"private":true,"yuzunoPlaceholder":true}"#;
/// Records each start: the script and whether it was asked to review.
const BRIDGE: &str = "import { writeFileSync } from 'node:fs';\n\
    writeFileSync(new URL('./started', import.meta.url), JSON.stringify({ script: process.argv[1], review: process.argv.includes('--review') }) + '\\n', { flag: 'a' });\n";

fn tgz(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
    for (path, body) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Regular);
        builder.append_data(&mut header, path, body.as_bytes()).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn package() -> Vec<u8> {
    tgz(&SDK.iter().map(|(path, body)| (format!("package/{path}"), *body)).collect::<Vec<_>>()
        .iter().map(|(path, body)| (path.as_str(), *body)).collect::<Vec<_>>())
}

fn integrity(bytes: &[u8]) -> String {
    format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes)))
}

fn hex(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

fn write(path: &Path, body: impl AsRef<[u8]>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

/// `<base>/releases/<id>/runtimes/claude`, leaving out the SDK `integrity` names.
fn release(base: &Path, id: &str, integrity: &str) -> PathBuf {
    let root = base.join("releases").join(id).join("runtimes/claude");
    write(&root.join("bridge.mjs"), BRIDGE);
    write(&root.join("remote-host.mjs"), "// the SSH machine's host; not started here\n");
    write(&root.join(FETCH), "// not run: the tests' node is a script\n");
    write(&root.join("node_modules/zod/package.json"), r#"{"name":"zod","version":"4.6.7"}"#);
    write(&root.join(PACKAGE).join("package.json"), PLACEHOLDER);
    let files: serde_json::Map<String, Value> = SDK.iter()
        .map(|(path, body)| (path.to_string(), json!({"sha256": hex(body), "bytes": body.len()}))).collect();
    write(&root.join(MANIFEST), serde_json::to_vec(&json!({"format": 1, "name": NAME, "version": "0.3.296",
        "resolved": "https://registry.example/claude-agent-sdk-0.3.296.tgz", "integrity": integrity, "files": files})).unwrap());
    root
}

/// An older release that still has the SDK in it.
fn older_release(base: &Path, id: &str) -> PathBuf {
    let root = base.join("releases").join(id).join("runtimes/claude");
    write(&root.join("bridge.mjs"), BRIDGE);
    for (path, body) in SDK {
        write(&root.join(PACKAGE).join(path), body);
    }
    root
}

/// A `node` that copies `archive` where the script would write and counts its runs.
fn node(base: &Path, archive: &Path, delay: &str) -> (String, PathBuf) {
    let count = base.join("node-runs");
    let script = base.join("node.sh");
    write(&script, format!("#!/bin/sh\nsleep {delay}\necho run >> '{}'\ncp '{}' \"$4\"\n", count.display(), archive.display()));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script.to_string_lossy().into_owned(), count)
}

fn runs(count: &Path) -> usize {
    std::fs::read_to_string(count).map(|text| text.lines().count()).unwrap_or(0)
}

fn receipt(target: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(target.join(RECEIPT)).unwrap()).unwrap()
}

fn has_the_sdk(target: &Path) {
    for (path, body) in SDK {
        assert_eq!(std::fs::read_to_string(target.join(PACKAGE).join(path)).unwrap(), *body, "{path}");
    }
    assert!(target.join("bridge.mjs").is_file());
    assert!(target.join("node_modules/zod/package.json").is_file());
}

fn left_in(cache: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(cache).unwrap().flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[tokio::test]
async fn a_runtime_with_the_sdk_itself_is_run_as_it_is() {
    let base = tempfile::tempdir().unwrap();
    let root = older_release(base.path(), "core-old");
    assert_eq!(runtime(&root, None, "node".into()).await.unwrap(), root);
}

#[test]
fn the_sdk_of_another_installed_release_is_used_without_downloading() {
    let base = tempfile::tempdir().unwrap();
    older_release(base.path(), "core-old");
    let root = release(base.path(), "core-new", &integrity(&package()));
    let (node, count) = node(base.path(), &base.path().join("no-archive"), "0");
    let cache = base.path().join("cache");
    let target = prepare(&root, &cache, &node).unwrap();
    assert_eq!(runs(&count), 0, "the installed copy was not used");
    has_the_sdk(&target);
    assert_eq!(receipt(&target)["source"], "release core-old");
    // The release itself is left as it was: placeholder and manifest.
    assert_eq!(std::fs::read_to_string(root.join(PACKAGE).join("package.json")).unwrap(), PLACEHOLDER);
}

#[test]
fn a_changed_installed_copy_is_not_used_and_the_locked_package_is_downloaded() {
    let base = tempfile::tempdir().unwrap();
    let old = older_release(base.path(), "core-old");
    write(&old.join(PACKAGE).join("vendor/x.js"), "changed\n");
    let archive = base.path().join("package.tgz");
    write(&archive, package());
    let root = release(base.path(), "core-new", &integrity(&package()));
    let (node, count) = node(base.path(), &archive, "0");
    let target = prepare(&root, &base.path().join("cache"), &node).unwrap();
    assert_eq!(runs(&count), 1);
    has_the_sdk(&target);
    assert_eq!(receipt(&target)["source"], "registry https://registry.example/claude-agent-sdk-0.3.296.tgz");
    assert!(!target.join(".claude-agent-sdk.tgz").exists() && !target.join(".fetch.log").exists());
}

#[test]
fn a_download_that_differs_from_the_lock_is_refused_and_nothing_is_kept() {
    let base = tempfile::tempdir().unwrap();
    let archive = base.path().join("package.tgz");
    write(&archive, tgz(&[("package/sdk.mjs", "other\n")]));
    let root = release(base.path(), "core-new", &integrity(&package()));
    let (node, count) = node(base.path(), &archive, "0");
    let cache = base.path().join("cache");
    let error = prepare(&root, &cache, &node).unwrap_err().to_string();
    assert!(error.contains("integrity"), "{error}");
    assert_eq!(left_in(&cache), Vec::<String>::new(), "nothing half-made is kept");
    // Once the source has the locked package, the next attempt succeeds.
    write(&archive, package());
    has_the_sdk(&prepare(&root, &cache, &node).unwrap());
    assert_eq!(runs(&count), 2);
}

#[test]
fn a_package_with_anything_but_its_own_files_is_refused() {
    let outside = tgz(&[("package/sdk.mjs", SDK[1].1), ("other/x.js", "x\n")]);
    let linked = {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        builder.append_link(&mut header, "package/sdk.mjs", "/etc/passwd").unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    };
    for (label, bytes) in [("a path outside the package", outside), ("a link", linked)] {
        let base = tempfile::tempdir().unwrap();
        let archive = base.path().join("package.tgz");
        write(&archive, &bytes);
        // The lock names these very bytes: only unpacking can refuse them.
        let root = release(base.path(), "core-new", &integrity(&bytes));
        let (node, _) = node(base.path(), &archive, "0");
        let cache = base.path().join("cache");
        let error = prepare(&root, &cache, &node).unwrap_err().to_string();
        assert!(error.contains("越界路径") || error.contains("非普通文件"), "{label}: {error}");
        assert_eq!(left_in(&cache), Vec::<String>::new(), "{label}");
    }
}

#[test]
fn releases_with_the_same_runtime_share_one_copy() {
    let base = tempfile::tempdir().unwrap();
    let archive = base.path().join("package.tgz");
    write(&archive, package());
    let a = release(base.path(), "core-a", &integrity(&package()));
    let b = release(base.path(), "core-b", &integrity(&package()));
    let (node, count) = node(base.path(), &archive, "0");
    let cache = base.path().join("cache");
    let first = prepare(&a, &cache, &node).unwrap();
    assert_eq!(prepare(&b, &cache, &node).unwrap(), first);
    assert_eq!(runs(&count), 1);
    assert_eq!(left_in(&cache).len(), 1);
    // Another runtime gets its own copy, its SDK from the copy already made.
    write(&b.join("bridge.mjs"), "// changed\n");
    let second = prepare(&b, &cache, &node).unwrap();
    assert_ne!(second, first);
    assert_eq!(runs(&count), 1);
    assert!(receipt(&second)["source"].as_str().unwrap().starts_with("prepared copy "));
}

#[test]
fn leftovers_of_an_interrupted_preparation_are_never_used() {
    let base = tempfile::tempdir().unwrap();
    let archive = base.path().join("package.tgz");
    write(&archive, package());
    let root = release(base.path(), "core-new", &integrity(&package()));
    let (node, _) = node(base.path(), &archive, "0");
    let cache = base.path().join("cache");
    let key = content_key(&root).unwrap();
    // A temporary folder a stopped preparation left, and a copy without its receipt.
    write(&cache.join(format!("{TEMPORARY}{key}")).join("half"), "x");
    write(&cache.join(&key).join(PACKAGE).join("sdk.mjs"), "half\n");
    let target = prepare(&root, &cache, &node).unwrap();
    assert_eq!(target, cache.join(&key));
    has_the_sdk(&target);
    assert_eq!(left_in(&cache), vec![key]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn waits_share_one_preparation_and_a_wait_given_up_leaves_a_whole_copy() {
    let base = tempfile::tempdir().unwrap();
    let archive = base.path().join("package.tgz");
    write(&archive, package());
    let root = release(base.path(), "core-new", &integrity(&package()));
    let cache = base.path().join("cache");
    let (node, count) = node(base.path(), &archive, "0.5");
    // A caller that stops waiting while the download runs.
    let gave_up = tokio::time::timeout(Duration::from_millis(100), runtime(&root, Some(cache.clone()), node.clone())).await;
    assert!(gave_up.is_err());
    // Two more wait together: the first preparation finishes, nobody starts another.
    let (one, two) = tokio::join!(runtime(&root, Some(cache.clone()), node.clone()), runtime(&root, Some(cache.clone()), node.clone()));
    let (one, two) = (one.unwrap(), two.unwrap());
    assert_eq!(one, two);
    assert_eq!(runs(&count), 1);
    has_the_sdk(&one);
    assert_eq!(left_in(&cache).len(), 1);
}

/// Every Claude start goes through Bridge::spawn_mode (Agents, review,
/// session reading, commands) and every SSH upload through runtime_root: for
/// a release without the SDK both use the prepared copy, never the release.
#[tokio::test]
async fn bridges_start_and_ssh_uploads_come_from_the_prepared_runtime() {
    struct Restore(Vec<(&'static str, Option<OsString>)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
    let _env = crate::claude::BRIDGE_ENV.lock().await;
    let _restore = Restore(["YUZUNO_CLAUDE_BRIDGE", "YUZUNO_CLAUDE_RUNTIME_CACHE"].into_iter()
        .map(|name| (name, std::env::var_os(name))).collect());
    let base = tempfile::tempdir().unwrap();
    older_release(base.path(), "core-old");
    let root = release(base.path(), "core-new", &integrity(&package()));
    let cache = base.path().join("cache");
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", root.join("bridge.mjs"));
    std::env::set_var("YUZUNO_CLAUDE_RUNTIME_CACHE", &cache);

    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let work = base.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    let _agent = crate::claude::Bridge::spawn(tx.clone()).await.unwrap();
    let _review = crate::claude::Bridge::spawn_review(tx, &work).await.unwrap();
    let prepared = runtime_root(std::env::var_os("YUZUNO_CLAUDE_BRIDGE")).await.unwrap();
    assert!(prepared.starts_with(&cache));
    let started = prepared.join("started");
    let deadline = Instant::now() + Duration::from_secs(20);
    while std::fs::read_to_string(&started).map_or(0, |text| text.lines().count()) < 2 {
        assert!(Instant::now() < deadline, "the bridges did not start");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut starts: Vec<Value> = std::fs::read_to_string(&started).unwrap().lines()
        .map(|line| serde_json::from_str(line).unwrap()).collect();
    starts.sort_by_key(|start| start["review"].as_bool());
    assert_eq!(starts, [json!({"script": prepared.join("bridge.mjs"), "review": false}),
                        json!({"script": prepared.join("bridge.mjs"), "review": true})]);
    assert!(!root.join("started").exists(), "the release's own bridge never started");

    let (_, archive) = crate::remote::claude_runtime_cached(&prepared).unwrap();
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(archive.as_slice()));
    let mut uploaded = BTreeMap::new();
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        let mut body = String::new();
        std::io::Read::read_to_string(&mut entry, &mut body).unwrap();
        uploaded.insert(entry.path().unwrap().to_string_lossy().into_owned(), body);
    }
    assert_eq!(uploaded[&format!("{PACKAGE}/package.json")], SDK[0].1, "the SDK goes to SSH machines, not the placeholder");
    assert_eq!(uploaded[&format!("{PACKAGE}/sdk.mjs")], SDK[1].1);
}

// Runtime & versions (T-191): what the status says, and that reading it
// prepares, copies and downloads nothing.

#[tokio::test]
async fn the_status_names_the_locked_sdk_and_its_copy_without_preparing_anything() {
    let base = tempfile::tempdir().unwrap();
    let archive = base.path().join("package.tgz");
    write(&archive, package());
    let root = release(base.path(), "core-new", &integrity(&package()));
    let (node, count) = node(base.path(), &archive, "0");
    let cache = base.path().join("cache");
    let script = || -> Result<PathBuf> { Ok(root.join("bridge.mjs")) };
    let status = status_of(script(), Some(&cache));
    assert_eq!(status["format"], 1);
    assert!(status["readAt"].is_string());
    assert_eq!(status["runtime"], json!({"kind": "release", "release": "core-new"}));
    assert_eq!(status["sdk"], json!({"state": "locked", "version": "0.3.296", "registry": "registry.example"}));
    assert_eq!(status["copy"], json!({"state": "none", "limited": false}));
    assert!(!cache.exists(), "reading prepares nothing");
    assert_eq!(runs(&count), 0, "and downloads nothing");
    // A copy an earlier run left is found by its receipt; another SDK's, a
    // damaged receipt and one deeper down are not counted.
    let copy = prepare(&root, &cache, &node).unwrap();
    write(&cache.join("other").join(RECEIPT), json!({"name": NAME, "integrity": "sha512-other", "version": "0.1.0",
        "source": "release core-x", "at": "2026-01-01T00:00:00Z"}).to_string());
    write(&cache.join("damaged").join(RECEIPT), "{");
    write(&cache.join("deeper/inside").join(RECEIPT), std::fs::read(copy.join(RECEIPT)).unwrap());
    let status = status_of(script(), Some(&cache));
    assert_eq!(status["copy"]["state"], "found", "{status}");
    assert_eq!(status["copy"]["copies"], 1);
    assert_eq!(status["copy"]["newest"]["version"], "0.3.296");
    assert_eq!(status["copy"]["newest"]["source"], json!({"from": "registry", "host": "registry.example"}));
    assert_eq!(status["copy"]["newest"]["at"], receipt(&copy)["at"]);
    // Once this run of Core uses a copy, that copy is the one said.
    assert_eq!(runtime(&root, Some(cache.clone()), node.clone()).await.unwrap(), copy);
    let status = status_of(script(), Some(&cache));
    assert_eq!(status["copy"]["state"], "inUse", "{status}");
    assert_eq!(status["copy"]["copy"]["version"], "0.3.296");
    assert_eq!(status["copy"]["copy"]["source"], json!({"from": "registry", "host": "registry.example"}));
    assert_eq!(runs(&count), 1, "the one download was the preparation's");
    assert!(!status.to_string().contains(&*base.path().to_string_lossy()), "no path is said: {status}");
}

#[test]
fn a_runtime_with_the_sdk_itself_says_its_version_and_needs_no_copy() {
    let base = tempfile::tempdir().unwrap();
    let older = older_release(base.path(), "core-old");
    let status = status_of(Ok(older.join("bridge.mjs")), Some(&base.path().join("cache")));
    assert_eq!(status["runtime"], json!({"kind": "release", "release": "core-old"}));
    assert_eq!(status["sdk"], json!({"state": "inRuntime", "version": "0.3.296"}));
    assert_eq!(status["copy"], json!({"state": "notNeeded"}));
    // A source checkout's runtime is no release's; one with neither the SDK
    // nor its manifest says so.
    let checkout = base.path().join("src/runtimes/claude");
    write(&checkout.join("bridge.mjs"), BRIDGE);
    let status = status_of(Ok(checkout.join("bridge.mjs")), None);
    assert_eq!(status["runtime"], json!({"kind": "other"}));
    assert_eq!(status["sdk"], json!({"state": "none"}));
    assert_eq!(status["copy"], json!({"state": "notNeeded"}));
}

#[test]
fn a_damaged_manifest_or_no_runtime_is_said_and_a_registry_is_named_by_its_host_only() {
    let base = tempfile::tempdir().unwrap();
    let cache = base.path().join("cache");
    let root = release(base.path(), "core-new", &integrity(&package()));
    write(&root.join(MANIFEST), "{damaged");
    let status = status_of(Ok(root.join("bridge.mjs")), Some(&cache));
    assert_eq!(status["sdk"], json!({"state": "unreadable", "reason": "claude-agent-sdk.json 无法读取"}));
    assert_eq!(status["copy"], json!({"state": "unknown"}));
    write(&root.join(MANIFEST), vec![b' '; STATUS_MANIFEST_BYTES as usize + 1]);
    let status = status_of(Ok(root.join("bridge.mjs")), Some(&cache));
    assert_eq!(status["sdk"]["state"], "unreadable", "a manifest past the bound is not read: {status}");
    // A registry URL that signs in is named by its host alone.
    let signed = release(base.path(), "core-signed", &integrity(&package()));
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(signed.join(MANIFEST)).unwrap()).unwrap();
    manifest["resolved"] = json!("https://person:SecretToken@registry.example:8443/claude-agent-sdk.tgz");
    write(&signed.join(MANIFEST), manifest.to_string());
    let status = status_of(Ok(signed.join("bridge.mjs")), Some(&cache));
    assert_eq!(status["sdk"]["registry"], "registry.example:8443");
    assert!(!status.to_string().contains("SecretToken"), "{status}");
    // No runtime: nothing known, nothing guessed.
    let none = status_of(Err(anyhow::anyhow!("no bridge configured")), Some(&cache));
    assert_eq!((&none["runtime"], &none["sdk"], &none["copy"]),
        (&json!({"kind": "missing"}), &json!({"state": "unknown"}), &json!({"state": "unknown"})));
    assert!(!cache.exists(), "reading prepares nothing");
}
