//! A routing key kept in 1Password (YN-34 S1a): read through the 1Password
//! CLI, `op`, with a service account's token.
//!
//! - `op` gets an environment of its own: PATH and HOME from Core's, and the
//!   token as OP_SERVICE_ACCOUNT_TOKEN. Nothing else of Core's reaches it, so
//!   no OP_CONNECT_* (which would take precedence over the token) and no other
//!   secret; and the token reaches nothing but `op`.
//! - `read` runs `op read --no-newline <reference>` once and keeps the value
//!   in memory for the one process it is handed to.
//! - `check` runs `op read "<reference>?attribute=type"`: it answers the
//!   field's type, never its value, so it confirms the reference without
//!   revealing the key.
//! - Service accounts need op 2.18.0 or later; `op --version` is checked
//!   before each use.
//!
//! Sources (www.1password.dev, read 2026-11-08):
//! - service accounts and the version: /service-accounts/use-with-1password-cli
//! - `op read` and `--no-newline`: /cli/reference/commands/read
//! - references and `?attribute=`: /cli/secret-reference-syntax
//! - request limits (an `op read` costs 3 reads): /service-accounts/rate-limits
//!
//! When a key cannot be had, `Unavailable` says why, in English and Chinese,
//! without anything `op` printed: its output could name what it read.
use super::{Secret, Store};
use anyhow::{ensure, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::{ffi::OsString, process::Stdio, time::Duration};
use tokio::process::Command;

/// The oldest op that has service accounts.
pub const MIN_VERSION: (u32, u32, u32) = (2, 18, 0);
/// How long one op run may take; a run past it counts as 1Password unreachable.
const TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(2) } else { Duration::from_secs(30) };
const MAX_REFERENCE: usize = 1024;

/// Why a 1Password key cannot be had now. A routing candidate that uses it
/// counts as unavailable, and the next one is tried.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unavailable {
    pub code: &'static str,
    pub message: String,
    pub message_zh: String,
}

fn unavailable(code: &'static str, message: String, message_zh: String) -> Unavailable {
    Unavailable { code, message, message_zh }
}

fn token_missing() -> Unavailable {
    unavailable("tokenMissing", "The 1Password service account's token is not set".into(), "1Password 服务账号的令牌没设置".into())
}

fn not_found(reference: &str) -> Unavailable {
    unavailable("referenceNotFound", format!("1Password has no {reference}"), format!("1Password 里找不到 {reference}"))
}

fn unreachable_now() -> Unavailable {
    unavailable("unreachable", "1Password is unreachable; the key cannot be fetched".into(), "1Password 连不上，取不到 key".into())
}

/// A reference as kept: `op://vault/item/[section/]field`, without a query
/// (Core adds its own). Its parts may hold spaces, as 1Password's do.
pub fn check_reference(reference: &str) -> Result<String> {
    let reference = reference.trim();
    ensure!(reference.len() <= MAX_REFERENCE, "A 1Password reference is at most {MAX_REFERENCE} bytes");
    ensure!(!reference.chars().any(char::is_control), "A 1Password reference has no line breaks or control characters");
    let path = reference.strip_prefix("op://").ok_or_else(|| anyhow::anyhow!("A 1Password reference starts with op://"))?;
    ensure!(!path.contains('?'), "A 1Password reference names a field, without ?query");
    let parts: Vec<&str> = path.split('/').collect();
    ensure!((3..=4).contains(&parts.len()) && parts.iter().all(|part| !part.trim().is_empty()),
        "A 1Password reference is op://vault/item/field or op://vault/item/section/field");
    Ok(reference.to_string())
}

/// The op this Core runs: YUZUNO_OP_BIN, else `op` on PATH.
fn program() -> OsString {
    std::env::var_os("YUZUNO_OP_BIN").filter(|p| !p.is_empty()).unwrap_or_else(|| "op".into())
}

/// One op run: its environment is only PATH, HOME and, when given, the
/// token. Output is kept in memory; stderr only to tell failures apart.
async fn run(args: &[&str], token: Option<&Secret>) -> std::io::Result<Option<std::process::Output>> {
    let mut command = Command::new(program());
    command.args(args).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for name in ["PATH", "HOME"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if let Some(token) = token {
        command.env("OP_SERVICE_ACCOUNT_TOKEN", token.expose());
    }
    let child = command.spawn()?;
    match tokio::time::timeout(TIMEOUT, child.wait_with_output()).await {
        Ok(output) => output.map(Some),
        Err(_) => Ok(None),
    }
}

/// `op --version`, read as its first x.y.z.
fn version_in(text: &str) -> Option<(u32, u32, u32)> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.')).find_map(|word| {
        let mut parts = word.split('.').map(|p| p.parse::<u32>().ok());
        match (parts.next().flatten(), parts.next().flatten(), parts.next().flatten()) {
            (Some(a), Some(b), Some(c)) => Some((a, b, c)),
            _ => None,
        }
    })
}

/// Whether op is installed here, which version, and whether it has service
/// accounts.
pub async fn installed() -> Value {
    match version().await {
        Ok(v) => json!({"found": true, "version": format!("{}.{}.{}", v.0, v.1, v.2), "supported": v >= MIN_VERSION}),
        Err(why) => json!({"found": why.code != "opMissing", "supported": false, "reason": why}),
    }
}

async fn version() -> Result<(u32, u32, u32), Unavailable> {
    let missing = || unavailable("opMissing", "The 1Password CLI (op) is not installed on this host".into(), "这台主机没装 1Password CLI（op）".into());
    match run(&["--version"], None).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(missing()),
        // A run past the time limit counts as unreachable, as for read and check.
        Ok(None) => Err(unreachable_now()),
        Err(_) => Err(failed(None)),
        Ok(Some(output)) => version_in(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| failed(output.status.code())),
    }
}

/// op of a version with service accounts, and the token; else why not.
async fn ready(store: &Store) -> Result<Secret, Unavailable> {
    let token = match store.token_value() {
        Ok(Some(token)) => token,
        Ok(None) => return Err(token_missing()),
        Err(error) => return Err(unavailable("keyFile", format!("{error:#}"), format!("执行者路由的 key 文件不能用：{error:#}"))),
    };
    let found = version().await?;
    if found < MIN_VERSION {
        let v = format!("{}.{}.{}", found.0, found.1, found.2);
        return Err(unavailable("opTooOld", format!("op {v} is too old: service accounts need 2.18.0 or later"),
            format!("op {v} 太旧：服务账号需要 2.18.0 或更新")));
    }
    Ok(token)
}

/// Reads the key `reference` names, once, into memory.
pub async fn read(store: &Store, reference: &str) -> Result<Secret, Unavailable> {
    let token = ready(store).await?;
    match run(&["read", "--no-newline", reference], Some(&token)).await {
        Ok(Some(output)) if output.status.success() => {
            let value = String::from_utf8(output.stdout).map_err(|_| failed(Some(0)))?;
            let value = value.trim_end_matches(['\r', '\n']).to_string();
            if value.is_empty() { Err(failed(Some(0))) } else { Ok(Secret::new(value)) }
        }
        Ok(Some(output)) => Err(classify(&output.stderr, output.status.code(), reference)),
        Ok(None) => Err(unreachable_now()),
        Err(_) => Err(failed(None)),
    }
}

/// Confirms `reference` names a field the token can read, without reading
/// its value: `?attribute=type` answers the field's type.
pub async fn check(store: &Store, reference: &str) -> Result<(), Unavailable> {
    let token = ready(store).await?;
    let query = format!("{reference}?attribute=type");
    match run(&["read", "--no-newline", &query], Some(&token)).await {
        Ok(Some(output)) if output.status.success() => Ok(()),
        Ok(Some(output)) => Err(classify(&output.stderr, output.status.code(), reference)),
        Ok(None) => Err(unreachable_now()),
        Err(_) => Err(failed(None)),
    }
}

fn failed(code: Option<i32>) -> Unavailable {
    let exit = code.map_or_else(|| "no exit code".to_string(), |c| format!("exit {c}"));
    unavailable("failed", format!("op could not read the key ({exit})"), format!("op 取不到 key（{exit}）"))
}

/// Tells op's failures apart by its own words; what it printed is never
/// passed on. op documents no exit codes for these, only messages.
fn classify(stderr: &[u8], code: Option<i32>, reference: &str) -> Unavailable {
    let text = String::from_utf8_lossy(stderr).to_lowercase();
    let has = |words: &[&str]| words.iter().any(|word| text.contains(word));
    if has(&["(429)", "too many requests"]) {
        unavailable("rateLimited", "1Password's request limit for the service account is reached; try again later".into(),
            "服务账号的 1Password 请求次数到上限了，稍后再试".into())
    } else if has(&["isn't an item", "isn't a vault", "isn't a field", "isn't a section", "could not find", "no item", "not found", "no such field"]) {
        not_found(reference)
    } else if has(&["(401)", "unauthorized", "invalid token", "token is invalid", "authentication", "signed out", "expired"]) {
        unavailable("tokenRejected", "1Password refused the service account's token".into(), "1Password 不接受服务账号的令牌".into())
    } else if has(&["dial tcp", "connection refused", "no such host", "timeout", "timed out", "network", "connection reset", "tls", "eof"]) {
        unreachable_now()
    } else {
        failed(code)
    }
}

#[cfg(test)]
#[path = "op_tests.rs"]
mod tests;
