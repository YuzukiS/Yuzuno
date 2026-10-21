//! The Claude Agent SDK on the user's machine (T-159).
//!
//! A public release leaves the SDK out (docs/public-readiness.md). Its Claude
//! runtime carries `claude-agent-sdk.json` instead: the locked version, source
//! and sha512 integrity, and every file of the package with its size and
//! SHA-256. Where installed Cores require the package's package.json it has a
//! placeholder (tools/claude_sdk_release.py). Before Core runs that runtime,
//! or uploads it to an SSH machine, it prepares a copy of it with the SDK in
//! place, in `<data folder>/claude-runtime/<content key>`:
//! - the SDK's files from another installed release or another prepared copy,
//!   when every file matches the manifest;
//! - else the package from its locked source, downloaded by the runtime's
//!   fetch-claude-sdk.mjs with Node (which Claude needs anyway), checked here
//!   against the locked integrity, unpacked and checked file by file.
//!
//! A copy is assembled in a temporary folder and renamed into place only when
//! it is complete and checked, so nothing half-made is ever run. The key is
//! the runtime's content: releases with the same runtime share one copy. A
//! runtime that has the SDK itself (a source checkout, an older release, a
//! test fixture) is run as it is.
use anyhow::{bail, ensure, Context, Result};
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256, Sha512};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const MANIFEST: &str = "claude-agent-sdk.json";
const PACKAGE: &str = "node_modules/@anthropic-ai/claude-agent-sdk";
const NAME: &str = "@anthropic-ai/claude-agent-sdk";
const FETCH: &str = "fetch-claude-sdk.mjs";
const RECEIPT: &str = ".yuzuno-prepared.json";
const TEMPORARY: &str = ".tmp-";
/// The script gives up after 120 seconds; this only ends a Node that hangs.
const DOWNLOAD_LIMIT: Duration = Duration::from_secs(150);

#[derive(Deserialize)]
struct Manifest {
    format: u32,
    name: String,
    version: String,
    resolved: String,
    integrity: String,
    files: BTreeMap<String, File>,
}

#[derive(Deserialize)]
struct File {
    sha256: String,
    bytes: u64,
}

static CACHE: OnceLock<PathBuf> = OnceLock::new();
/// One preparation at a time. Core is alone on its data folder (the
/// Workspace lock), so this process is the only one that writes there.
static PREPARING: LazyLock<Arc<tokio::sync::Mutex<()>>> = LazyLock::new(Default::default);
/// Runtime directory → its prepared copy, once made or found in this process.
static PREPARED: LazyLock<Mutex<HashMap<PathBuf, PathBuf>>> = LazyLock::new(Default::default);

/// Keeps prepared runtimes in `<data_dir>/claude-runtime`. The first
/// Workspace of the process sets it; YUZUNO_CLAUDE_RUNTIME_CACHE overrides it.
pub(crate) fn set_cache(data_dir: &Path) {
    let _ = CACHE.set(data_dir.join("claude-runtime"));
}

fn cache() -> Option<PathBuf> {
    std::env::var_os("YUZUNO_CLAUDE_RUNTIME_CACHE").filter(|dir| !dir.is_empty()).map(PathBuf::from)
        .or_else(|| CACHE.get().cloned())
}

fn node() -> String {
    std::env::var("YUZUNO_NODE").unwrap_or_else(|_| "node".into())
}

fn configured_bridge(configured: Option<OsString>) -> Result<PathBuf> {
    crate::runtime_paths::resolve(configured, "claude/bridge.mjs")
        .context("请设置 YUZUNO_CLAUDE_BRIDGE 或通过已安装的发布包启动 Core")
}

/// The bridge script Core starts: the configured one (YUZUNO_CLAUDE_BRIDGE,
/// else the checkout's), in its prepared runtime when its release leaves the
/// SDK out. Waits for the preparation and returns its error.
pub(crate) async fn bridge_script(configured: Option<OsString>) -> Result<PathBuf> {
    let script = configured_bridge(configured)?;
    let (Some(root), Some(name)) = (script.parent(), script.file_name()) else { bail!("找不到 Claude SDK bridge") };
    Ok(runtime(root, cache(), node()).await?.join(name))
}

/// The runtime directory Core uploads to an SSH machine: the configured
/// bridge's, or its prepared copy (see `bridge_script`).
pub(crate) async fn runtime_root(configured: Option<OsString>) -> Result<PathBuf> {
    let script = configured_bridge(configured)?;
    let root = script.parent().context("找不到本机 Claude Runtime 目录")?;
    runtime(root, cache(), node()).await
}

/// `root` itself, or its prepared copy when it carries the SDK's manifest.
async fn runtime(root: &Path, cache: Option<PathBuf>, node: String) -> Result<PathBuf> {
    if !root.join(MANIFEST).is_file() {
        return Ok(root.to_path_buf());
    }
    if let Some(done) = PREPARED.lock().unwrap().get(root).filter(|done| done.join(RECEIPT).is_file()).cloned() {
        return Ok(done);
    }
    let cache = cache.context("Claude Runtime 的准备目录尚未设置")?;
    // The task keeps the lock until it has finished, even if its caller
    // stopped waiting: no other preparation starts while it still writes.
    let held = PREPARING.clone().lock_owned().await;
    let source = root.to_path_buf();
    let prepared = tokio::task::spawn_blocking(move || {
        let _held = held;
        prepare(&source, &cache, &node)
    })
    .await
    .context("准备 Claude Runtime 的任务中断")??;
    PREPARED.lock().unwrap().insert(root.to_path_buf(), prepared.clone());
    Ok(prepared)
}

/// The prepared copy of the runtime at `root` under `cache`, made if there is
/// none. Blocking; one at a time (see `PREPARING`).
fn prepare(root: &Path, cache: &Path, node: &str) -> Result<PathBuf> {
    let manifest = manifest(root)?;
    let key = content_key(root)?;
    let target = cache.join(&key);
    if ready(&target, &key, &manifest) {
        return Ok(target);
    }
    std::fs::create_dir_all(cache)?;
    clear_temporaries(cache);
    let temporary = cache.join(format!("{TEMPORARY}{key}"));
    let made = assemble(root, cache, &temporary, &key, &manifest, node);
    if let Err(error) = made {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }
    if target.exists() {
        // Not ready (checked above): a copy whose receipt is gone.
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(&temporary, &target)?;
    sync_dir(cache);
    Ok(target)
}

fn assemble(root: &Path, cache: &Path, temporary: &Path, key: &str, manifest: &Manifest, node: &str) -> Result<()> {
    copy_tree(root, temporary)?;
    let package = temporary.join(PACKAGE);
    // The placeholder (or nothing) goes; only the SDK's own files come in.
    let _ = std::fs::remove_dir_all(&package);
    std::fs::create_dir_all(&package)?;
    let source = match installed_copy(root, cache, manifest) {
        Some((dir, label)) => {
            for path in manifest.files.keys() {
                let out = package.join(path);
                std::fs::create_dir_all(out.parent().context("SDK 文件没有上级目录")?)?;
                std::fs::copy(dir.join(path), &out)?;
            }
            label
        }
        None => {
            download(temporary, node, manifest, &package)?;
            format!("registry {}", manifest.resolved)
        }
    };
    check(&package, manifest)?;
    let receipt = serde_json::json!({"format": 1, "key": key, "name": manifest.name, "version": manifest.version,
        "integrity": manifest.integrity, "source": source, "at": crate::model::now()});
    write_synced(&temporary.join(RECEIPT), &serde_json::to_vec_pretty(&receipt)?)
}

fn manifest(root: &Path) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(root.join(MANIFEST))?)
        .context("claude-agent-sdk.json 无法读取")?;
    ensure!(manifest.format == 1 && manifest.name == NAME, "claude-agent-sdk.json 不是 Claude Agent SDK 的清单");
    ensure!(manifest.resolved.starts_with("https://") && manifest.integrity.starts_with("sha512-"),
        "claude-agent-sdk.json 没有 HTTPS 来源和 sha512 integrity");
    ensure!(!manifest.files.is_empty(), "claude-agent-sdk.json 没有列出文件");
    for path in manifest.files.keys() {
        ensure!(Path::new(path).components().all(|c| matches!(c, Component::Normal(_))),
            "claude-agent-sdk.json 列出了越界路径：{path}");
    }
    Ok(manifest)
}

/// What the runtime is: every file under `root`, by path and SHA-256.
fn content_key(root: &Path) -> Result<String> {
    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for relative in files {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(sha256(&root.join(&relative))?.as_bytes());
        hasher.update([b'\n']);
    }
    Ok(format!("{:x}", hasher.finalize())[..32].to_owned())
}

/// Regular files under `dir`, relative to `root`; anything else is refused.
fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            walk(root, &path, out)?;
        } else if kind.is_file() {
            out.push(path.strip_prefix(root)?.to_string_lossy().into_owned());
        } else {
            bail!("Claude Runtime 中有非普通文件：{}", path.display());
        }
    }
    Ok(())
}

fn sha256(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// A copy made earlier, with its receipt and every SDK file at its size.
fn ready(target: &Path, key: &str, manifest: &Manifest) -> bool {
    let Ok(receipt) = std::fs::read(target.join(RECEIPT)) else { return false };
    let Ok(receipt) = serde_json::from_slice::<serde_json::Value>(&receipt) else { return false };
    receipt["key"] == key && receipt["integrity"] == manifest.integrity.as_str()
        && manifest.files.iter().all(|(path, file)| {
            std::fs::symlink_metadata(target.join(PACKAGE).join(path)).is_ok_and(|m| m.is_file() && m.len() == file.bytes)
        })
}

/// Another copy of exactly these files: another prepared runtime, or another
/// installed release (`…/releases/<release>/runtimes/claude`).
fn installed_copy(root: &Path, cache: &Path, manifest: &Manifest) -> Option<(PathBuf, String)> {
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(cache).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(TEMPORARY) {
            candidates.push((entry.path().join(PACKAGE), format!("prepared copy {name}")));
        }
    }
    if root.ends_with("runtimes/claude") {
        if let Some(releases) = root.parent().and_then(Path::parent).and_then(Path::parent) {
            for entry in std::fs::read_dir(releases).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                candidates.push((entry.path().join("runtimes/claude").join(PACKAGE), format!("release {name}")));
            }
        }
    }
    candidates.sort();
    candidates.into_iter().find(|(dir, _)| {
        manifest.files.iter().all(|(path, file)| {
            let path = dir.join(path);
            std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && m.len() == file.bytes)
                && sha256(&path).is_ok_and(|actual| actual == file.sha256)
        })
    })
}

fn proxied() -> bool {
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

/// The package from its locked source, through the runtime's own script, then
/// checked against the locked integrity and unpacked into `package`.
fn download(temporary: &Path, node: &str, manifest: &Manifest, package: &Path) -> Result<()> {
    let archive = temporary.join(".claude-agent-sdk.tgz");
    let log = temporary.join(".fetch.log");
    let mut command = std::process::Command::new(node);
    command
        .arg(temporary.join(FETCH))
        .arg(&manifest.resolved)
        .arg(&manifest.integrity)
        .arg(&archive)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&log)?);
    if proxied() {
        // Only for this download; fetch-claude-sdk.mjs refuses a Node too
        // old to honour it rather than connecting around the proxy.
        command.env("NODE_USE_ENV_PROXY", "1");
    }
    let mut child = command.spawn().with_context(|| format!("无法启动 Node（{node}）取得 Claude Agent SDK"))?;
    let deadline = Instant::now() + DOWNLOAD_LIMIT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("取得 Claude Agent SDK {} 超时；可以稍后重试", manifest.version);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if !status.success() {
        let said = std::fs::read_to_string(&log).unwrap_or_default();
        let said: String = said.trim().chars().take(600).collect();
        bail!("未能取得 Claude Agent SDK {}（{}）：{}；可以稍后重试", manifest.version, status,
            if said.is_empty() { "Node 没有说明原因" } else { &said });
    }
    let bytes = std::fs::read(&archive)?;
    let expected = manifest.integrity.strip_prefix("sha512-")
        .and_then(|value| base64::engine::general_purpose::STANDARD.decode(value).ok())
        .context("claude-agent-sdk.json 的 integrity 无法解析")?;
    ensure!(Sha512::digest(&bytes).as_slice() == expected.as_slice(), "取得的 Claude Agent SDK 与锁定的 integrity 不符");
    unpack(&bytes, package)?;
    std::fs::remove_file(&archive)?;
    std::fs::remove_file(&log)?;
    Ok(())
}

/// An npm package (`package/…`): regular files and folders only, inside it.
fn unpack(bytes: &[u8], package: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() || kind.is_pax_local_extensions() {
            continue;
        }
        let path = entry.path()?.into_owned();
        let relative = path.strip_prefix("package").ok()
            .filter(|relative| relative.components().all(|c| matches!(c, Component::Normal(_))))
            .with_context(|| format!("Claude Agent SDK 包中有越界路径：{}", path.display()))?
            .to_path_buf();
        let out = package.join(&relative);
        if kind.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        ensure!(kind.is_file() && !relative.as_os_str().is_empty(),
            "Claude Agent SDK 包中有非普通文件：{}", path.display());
        ensure!(!out.exists(), "Claude Agent SDK 包中有重复文件：{}", path.display());
        std::fs::create_dir_all(out.parent().context("SDK 文件没有上级目录")?)?;
        std::io::copy(&mut entry, &mut std::fs::File::create(&out)?)?;
    }
    Ok(())
}

/// The SDK folder holds exactly the manifest's files, each as listed.
fn check(package: &Path, manifest: &Manifest) -> Result<()> {
    let mut found = Vec::new();
    walk(package, package, &mut found)?;
    found.sort();
    let listed: Vec<&String> = manifest.files.keys().collect();
    ensure!(found.iter().collect::<Vec<_>>() == listed, "取得的 Claude Agent SDK 文件与清单不一致");
    for (path, file) in &manifest.files {
        let path = package.join(path);
        ensure!(std::fs::metadata(&path)?.len() == file.bytes && sha256(&path)? == file.sha256,
            "取得的 Claude Agent SDK 文件与清单不一致：{}", path.display());
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &target)?;
        } else {
            bail!("Claude Runtime 中有非普通文件：{}", entry.path().display());
        }
    }
    Ok(())
}

/// Folders that a preparation interrupted before its rename left behind.
fn clear_temporaries(cache: &Path) {
    for entry in std::fs::read_dir(cache).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with(TEMPORARY) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn sync_dir(dir: &Path) {
    if let Ok(dir) = std::fs::File::open(dir) {
        let _ = dir.sync_all();
    }
}

#[cfg(test)]
#[path = "claude_sdk_tests.rs"]
mod tests;
