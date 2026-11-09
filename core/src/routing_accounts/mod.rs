//! Routing accounts (YN-34 S1b; docs/executor-routing.md): the subscription
//! accounts executor routing may start an executor with. Nothing here starts
//! one yet (S1c does); this is the inventory and how a binding resolves.
//!
//! - **Claude**: claude-swap's accounts (`cswap`, docs/claude-swap.md). Core
//!   reads `cswap list --json` (the command is a setting) and binds to an
//!   account by a fingerprint of its email and organizationUuid, never the
//!   email itself, because slot numbers move. At each launch the binding is
//!   resolved again (`resolve`): the account that is the host's current
//!   default login launches on the plain host login (`--require-session`
//!   refuses it, and it is the same account), any other through
//!   `cswap run <slot> --require-session` (runtimes/claude/cswap-claude), and
//!   one no longer listed is gone: never another account in its place.
//! - **Codex**: CODEX_HOME folders the user names, one per account.
//!
//! claude-swap's JSON and `run` were read at release 1.0.0 (`CSWAP_PINNED`).
use crate::{store::Store, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{os::unix::fs::MetadataExt, path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

pub mod routes;

/// The claude-swap release whose `list --json` and `run` this was written against.
pub const CSWAP_PINNED: &str = "1.0.0";
const CSWAP_KEY: &str = "routing.cswap";
const CODEX_KEY: &str = "routing.codexHomes";
const MAX_HOMES: usize = 16;
/// `cswap list` may read each account's usage over the network.
const LIST_TIMEOUT: Duration = if cfg!(test) { Duration::from_secs(5) } else { Duration::from_secs(60) };

/// One claude-swap account as Core shows it: by its number, alias and
/// fingerprint. Its email is neither shown nor kept (YN-34 S2b).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub number: u32,
    pub fingerprint: String,
    pub active: bool,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_status: Option<String>,
    /// What is left of its weekly window, as claude-swap read it (YN-34 S2b):
    /// `pct` there is the share used. Its 5-hour window is not read (YN-60).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week: Option<Window>,
}

/// One usage window: the share left (0–100), when known, and when it resets.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub left_pct: Option<f64>,
    pub resets_at: Option<String>,
}

fn window(value: &Value) -> Option<Window> {
    if !value.is_object() {
        return None;
    }
    let left_pct = value["pct"].as_f64().filter(|n| n.is_finite()).map(|used| (100.0 - used).clamp(0.0, 100.0));
    let resets_at = value["resetsAt"].as_str().filter(|t| chrono::DateTime::parse_from_rfc3339(t).is_ok()).map(str::to_owned);
    Some(Window { left_pct, resets_at })
}

/// Why claude-swap's accounts cannot be read now.
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

/// How an executor bound to a claude-swap account starts now.
#[derive(Clone, Debug, PartialEq)]
pub enum Launch {
    /// The account is the host's current default login: plain `claude`.
    HostLogin,
    /// Through `cswap run <number> --require-session`.
    Session { number: u32 },
    /// No listed account has this fingerprint: the executor does not start.
    Gone,
}

/// A stable name for an account: its email (case folded) and organization,
/// hashed, so no email is kept.
pub fn fingerprint(email: &str, organization_uuid: Option<&str>) -> String {
    let mut hash = Sha256::new();
    hash.update(b"yuzuno-cswap-account\0");
    hash.update(email.trim().to_lowercase().as_bytes());
    hash.update(b"\0");
    hash.update(organization_uuid.unwrap_or("").trim().as_bytes());
    hash.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// How the executor bound to `fingerprint` starts, from `accounts`.
pub fn resolve(accounts: &[Account], fingerprint: &str) -> Launch {
    match accounts.iter().find(|a| a.fingerprint == fingerprint) {
        Some(account) if account.active => Launch::HostLogin,
        Some(account) => Launch::Session { number: account.number },
        None => Launch::Gone,
    }
}

/// Reads `cswap list --json` (schema 1). What cswap printed on stderr, and
/// its error message, are not passed on: only its error's type.
pub async fn cswap_accounts(command: &str) -> Result<Vec<Account>, Unavailable> {
    let mut child = Command::new(command);
    child.args(["list", "--json"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let output = match child.spawn() {
        Ok(child) => match tokio::time::timeout(LIST_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(_)) => return Err(failed("no exit code".into())),
            Err(_) => return Err(unavailable("cswapTimeout", format!("cswap list did not answer within {} s", LIST_TIMEOUT.as_secs()),
                format!("cswap list 在 {} 秒内没有回答", LIST_TIMEOUT.as_secs()))),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(unavailable("cswapMissing", format!("claude-swap ({command}) is not installed on this host"),
                format!("这台主机没装 claude-swap（{command}）")));
        }
        Err(error) => return Err(failed(format!("{}", error.kind()))),
    };
    let json: Value = serde_json::from_slice(&output.stdout).map_err(|_| failed(exit_of(&output.status)))?;
    if let Some(kind) = json["error"]["type"].as_str() {
        let kind: String = kind.chars().filter(|c| c.is_ascii_alphanumeric()).take(64).collect();
        return Err(unavailable("cswapError", format!("cswap list refused: {kind}"), format!("cswap list 报错：{kind}")));
    }
    ensure_schema(&json)?;
    let rows = json["accounts"].as_array().ok_or_else(|| failed(exit_of(&output.status)))?;
    Ok(rows.iter().filter_map(account).collect())
}

fn ensure_schema(json: &Value) -> Result<(), Unavailable> {
    match json["schemaVersion"].as_u64() {
        Some(1) => Ok(()),
        other => Err(unavailable("cswapSchema",
            format!("cswap list answered schema {} (Core reads schema 1, as claude-swap {CSWAP_PINNED} writes)", other.map_or("none".into(), |v| v.to_string())),
            format!("cswap list 的格式版本是 {}（Core 读的是 claude-swap {CSWAP_PINNED} 的版本 1）", other.map_or("无".into(), |v| v.to_string())))),
    }
}

/// A row; one without a number or email is left out.
fn account(row: &Value) -> Option<Account> {
    let number = u32::try_from(row["number"].as_u64()?).ok()?;
    let email = row["email"].as_str().filter(|e| !e.trim().is_empty())?;
    let organization = row["organizationUuid"].as_str().filter(|o| !o.is_empty());
    // Its alias, else its number: never its email, which pages and records don't show (YN-34 S2b).
    let label = row["alias"].as_str().filter(|a| !a.trim().is_empty() && !a.contains('@')).map(str::to_owned)
        .unwrap_or_else(|| format!("Account-{number}"));
    Some(Account {
        number,
        fingerprint: fingerprint(email, organization),
        active: row["active"].as_bool() == Some(true),
        label: label.chars().take(120).collect(),
        usage_status: row["usageStatus"].as_str().map(|s| s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect()),
        week: window(&row["usage"]["sevenDay"]),
    })
}

fn exit_of(status: &std::process::ExitStatus) -> String {
    status.code().map_or_else(|| "no exit code".to_string(), |c| format!("exit {c}"))
}

fn failed(exit: String) -> Unavailable {
    unavailable("cswapFailed", format!("cswap list gave no account list ({exit})"), format!("cswap list 没有给出账号列表（{exit}）"))
}

/// The cswap command: a bare name looked up on PATH, or an absolute path.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CswapSettings {
    pub command: String,
}

impl Default for CswapSettings {
    fn default() -> Self {
        Self { command: "cswap".into() }
    }
}

pub fn check_command(command: &str) -> Result<String> {
    let command = command.trim();
    ensure!(!command.is_empty() && command.len() <= 4096 && !command.chars().any(|c| c.is_control() || c.is_whitespace() && c != ' '),
        "The cswap command is one program: a name on PATH or an absolute path, without arguments");
    ensure!(!command.contains(' ') || command.starts_with('/'), "The cswap command takes no arguments");
    ensure!(command.starts_with('/') || !command.contains('/'), "The cswap command is a name on PATH or an absolute path");
    Ok(command.to_string())
}

/// The Python claude-swap runs with: the interpreter its command's first
/// line names (`#!/…/python`). The launcher runs claude-swap's own code
/// with it (runtimes/claude/cswap-run.py).
pub fn cswap_python(command: &str) -> Result<std::path::PathBuf> {
    let path = if command.starts_with('/') {
        std::path::PathBuf::from(command)
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|dir| dir.join(command)).find(|p| p.is_file())
            .with_context(|| format!("{command} is not on PATH"))?
    };
    let first = std::fs::read(&path).with_context(|| format!("Cannot read {}", path.display()))?;
    let line = String::from_utf8_lossy(&first[..first.len().min(512)]).lines().next().unwrap_or("").to_string();
    let interpreter = line.strip_prefix("#!").map(str::trim).unwrap_or("");
    ensure!(interpreter.starts_with('/') && !interpreter.contains(' ') && interpreter.rsplit('/').next().is_some_and(|n| n.starts_with("python")),
        "{} is not claude-swap's Python console script (its first line does not name a python): set the cswap command to the installed script", path.display());
    Ok(interpreter.into())
}

/// A CODEX_HOME folder for one Codex account.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexHome {
    pub id: String,
    pub label: String,
    pub home: String,
}

/// Checks a list as a save takes it: ids as routing keys' ids, labels of 1
/// to 60 characters, homes absolute folders that exist, belong to Core's
/// user and no other user may write into, each once.
pub fn check_homes(homes: &[CodexHome]) -> Result<()> {
    ensure!(homes.len() <= MAX_HOMES, "At most {MAX_HOMES} Codex homes");
    let uid = rustix::process::geteuid().as_raw();
    for (i, home) in homes.iter().enumerate() {
        crate::routing_keys::check_id(&home.id)?;
        // Routing's readings and policy name the host's own login `login` (#800 R1 P2).
        ensure!(home.id != "login", "login names the host's own Codex login, which needs no entry; give this Codex home another id");
        let label = home.label.trim();
        ensure!(!label.is_empty() && label.chars().count() <= 60, "A Codex home's label is 1 to 60 characters");
        let path = Path::new(&home.home);
        ensure!(path.is_absolute(), "A Codex home is an absolute folder: {}", home.home);
        let meta = std::fs::metadata(path).with_context(|| format!("The Codex home {} is not there", home.home))?;
        ensure!(meta.is_dir(), "The Codex home {} is not a folder", home.home);
        ensure!(meta.uid() == uid, "The Codex home {} belongs to another user", home.home);
        ensure!(meta.mode() & 0o022 == 0, "Other users can write into the Codex home {} (mode {:o})", home.home, meta.mode() & 0o777);
        ensure!(!homes[..i].iter().any(|h| h.id == home.id), "Two Codex homes are named {}", home.id);
        ensure!(!homes[..i].iter().any(|h| Path::new(&h.home) == path), "{} is listed twice", home.home);
    }
    Ok(())
}

impl Store {
    pub(crate) fn cswap_settings(&self) -> Result<CswapSettings> {
        let raw: Option<String> = self.db.read()?.query_row("SELECT value FROM workspace_meta WHERE key=?1", [CSWAP_KEY], |r| r.get(0)).optional()?;
        Ok(raw.map(|raw| serde_json::from_str(&raw)).transpose()?.unwrap_or_default())
    }

    pub(crate) fn save_cswap_settings(&self, settings: &CswapSettings) -> Result<()> {
        self.put_meta(CSWAP_KEY, &serde_json::to_string(settings)?)
    }

    pub(crate) fn codex_homes(&self) -> Result<Vec<CodexHome>> {
        let raw: Option<String> = self.db.read()?.query_row("SELECT value FROM workspace_meta WHERE key=?1", [CODEX_KEY], |r| r.get(0)).optional()?;
        Ok(raw.map(|raw| serde_json::from_str(&raw)).transpose()?.unwrap_or_default())
    }

    pub(crate) fn save_codex_homes(&self, homes: &[CodexHome]) -> Result<()> {
        check_homes(homes)?;
        self.put_meta(CODEX_KEY, &serde_json::to_string(homes)?)
    }

    fn put_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db.write()?.execute(
            "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }
}

impl Workspace {
    /// claude-swap's accounts as its command lists them now.
    pub async fn routing_cswap_accounts(&self) -> Result<(CswapSettings, Result<Vec<Account>, Unavailable>)> {
        let settings = self.stored(|store| store.cswap_settings()).await?;
        let accounts = cswap_accounts(&settings.command).await;
        Ok((settings, accounts))
    }
}

#[cfg(test)]
mod tests;
