//! Manual machine checks. A check records what Core could reach and run at
//! that moment; it is never a live status, and nothing re-runs it in the
//! background. Results live apart from machine configuration.
use crate::{remote::{self, RemoteMachine}, store::Store, workspace::Workspace};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, process::Stdio, time::Instant};
use tokio::{process::Command, time::{timeout, Duration}};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostFacts {
    pub hostname: String,
    pub platform: String,
    pub home: String,
}

/// Whether a Harness CLI was found and answered `--version`. Finding it does
/// not prove that it is signed in or that a model request would succeed.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCheck {
    pub harness: String,
    pub supported: bool,
    pub found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Claude Code on the Core host only: what its own `claude auth status`
    /// said, run as Core runs it. None where it was not asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<SignIn>,
}

/// One answer of `claude auth status --json`, and nothing of the account:
/// only whether it is signed in, the method's short name and the folder it
/// uses. A failed,
/// timed-out or unreadable answer is `unknown` with the reason, never taken
/// for signed out.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    /// `signedIn`, `signedOut` or `unknown`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// The configuration folder it reported using (`configDirectory`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderCheck {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineCheck {
    pub machine_id: String,
    pub started_at: String,
    pub checked_at: String,
    pub duration_ms: u64,
    /// Core reached the machine: itself, or SSH plus the helper for SSH machines.
    pub reachable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<HostFacts>,
    #[serde(default)]
    pub harnesses: Vec<HarnessCheck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_folder: Option<FolderCheck>,
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS machine_checks(
            machine_id TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, data TEXT NOT NULL);",
    )?;
    Ok(())
}

impl Store {
    /// Keeps the most recently *started* check, so a slow earlier check that
    /// finishes late cannot replace a newer result.
    pub fn record_machine_check(&self, check: &MachineCheck, started_ms: i64) -> Result<MachineCheck> {
        let db = self.db.write()?;
        upsert_check(&db, check, started_ms)
    }

    /// An SSH machine's check, kept only while the machine is still the one
    /// it reached: an edit or removal during a check (which can take many
    /// seconds) leaves it describing nothing stored, so it is refused.
    pub fn record_ssh_machine_check(&self, check: &MachineCheck, started_ms: i64, probed: &RemoteMachine) -> Result<MachineCheck> {
        let db = self.db.write()?;
        let raw: Option<String> = db.query_row(
            "SELECT data FROM machines WHERE id=?1", [&probed.id], |r| r.get(0)).optional()?;
        let Some(raw) = raw else { bail!("This machine was removed while it was being tested") };
        let stored: RemoteMachine = serde_json::from_str(&raw)?;
        if (&stored.target, &stored.codex, &stored.default_cwd) != (&probed.target, &probed.codex, &probed.default_cwd) {
            bail!("This machine was changed while it was being tested; test it again");
        }
        upsert_check(&db, check, started_ms)
    }

    pub fn machine_checks(&self) -> Result<HashMap<String, MachineCheck>> {
        let db = self.db.read()?;
        let mut query = db.prepare("SELECT machine_id,data FROM machine_checks")?;
        let rows = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut checks = HashMap::new();
        for row in rows {
            let (id, data) = row?;
            // A record this build cannot read is reported as never checked.
            if let Ok(check) = serde_json::from_str(&data) {
                checks.insert(id, check);
            }
        }
        Ok(checks)
    }
}

fn find_executable(program: &str) -> Option<String> {
    let candidate = Path::new(program);
    let candidates: Vec<std::path::PathBuf> = if candidate.components().count() > 1 {
        vec![candidate.to_path_buf()]
    } else {
        std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).map(|dir| dir.join(program)).collect())
            .unwrap_or_default()
    };
    candidates.into_iter().find_map(|path| {
        let metadata = std::fs::metadata(&path).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        metadata.is_file().then(|| std::fs::canonicalize(&path).unwrap_or(path).to_string_lossy().into_owned())
    })
}

/// Runs `program --version` without a shell, with a bounded wait.
async fn version_of(harness: &str, program: &str, missing: &str) -> HarnessCheck {
    let mut check = HarnessCheck { harness: harness.into(), supported: true, ..Default::default() };
    let Some(executable) = find_executable(program) else {
        check.error = Some(missing.into());
        return check;
    };
    check.executable = Some(executable.clone());
    let run = Command::new(&executable).arg("--version")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).output();
    match timeout(Duration::from_secs(10), run).await {
        Err(_) => check.error = Some(format!("{program} --version did not answer within 10 seconds")),
        Ok(Err(error)) => check.error = Some(format!("Could not run {program}: {error}")),
        Ok(Ok(output)) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            check.error = Some(format!("{program} --version failed: {}", stderr.trim().chars().take(300).collect::<String>()));
        }
        Ok(Ok(output)) => {
            check.found = true;
            check.version = Some(String::from_utf8_lossy(&output.stdout).trim().chars().take(200).collect());
        }
    }
    check
}

fn local_hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .or_else(|| std::process::Command::new("hostname").output().ok()
            .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()))
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

fn platform_name() -> String {
    // Same wording as Python's platform.system() on SSH machines.
    match std::env::consts::OS {
        "linux" => "Linux".into(),
        "macos" => "Darwin".into(),
        "windows" => "Windows".into(),
        other => other.into(),
    }
}

fn millis(at: chrono::DateTime<chrono::Utc>) -> i64 {
    at.timestamp_millis()
}

fn stamp(at: chrono::DateTime<chrono::Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

async fn check_local(ws: &Workspace) -> (HostFacts, Vec<HarnessCheck>, FolderCheck) {
    let host = HostFacts {
        hostname: local_hostname(),
        platform: platform_name(),
        home: dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    let codex = version_of("codex", ws.codex_program(), "Codex was not found on Core's PATH").await;
    let mut claude = version_of("claude", "claude", "Claude Code was not found on Core's PATH").await;
    // The Claude harness also runs Yuzuno's Node bridge on this host.
    let node = std::env::var("YUZUNO_NODE").unwrap_or_else(|_| "node".into());
    if claude.found && find_executable(&node).is_none() {
        claude.found = false;
        claude.error = Some(format!("Claude Code was found, but {node} (needed by Yuzuno's Claude bridge) was not"));
    }
    if claude.found {
        let executable = claude.executable.clone().unwrap_or_else(|| "claude".into());
        let sign_in = claude_sign_in(&executable, Duration::from_secs(15)).await;
        // Only a clear "not logged in" makes it unusable; an unknown answer
        // leaves it found, with the reason kept in sign_in.
        if sign_in.state == "signedOut" {
            claude.found = false;
            let config = std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|dir| !dir.is_empty());
            claude.error = Some(local_claude_login_hint(&host.hostname, &executable, config.as_deref(),
                sign_in.folder.as_deref(), sign_in.method.as_deref()));
        }
        claude.sign_in = Some(sign_in);
    }
    let folder = match std::fs::canonicalize(&ws.default_cwd) {
        Ok(path) if path.is_dir() => FolderCheck {
            path: ws.default_cwd.clone(), resolved: Some(path.to_string_lossy().into_owned()), error: None },
        Ok(_) => FolderCheck { path: ws.default_cwd.clone(), resolved: None, error: Some("Not a folder".into()) },
        Err(error) => FolderCheck { path: ws.default_cwd.clone(), resolved: None, error: Some(error.to_string()) },
    };
    (host, vec![codex, claude], folder)
}

/// `claude auth status --json` run as Core runs Claude: the executable the
/// check found on Core's PATH, with Core's own environment (its
/// CLAUDE_CONFIG_DIR, if any), which the Claude bridge inherits too. No model
/// call. Only `loggedIn`, a short `authMethod` and the `configDirectory` it
/// uses are kept; anything it prints about the account is not.
async fn claude_sign_in(executable: &str, wait: Duration) -> SignIn {
    let unknown = |detail: String| SignIn {
        state: "unknown".into(), method: None, folder: None, detail: Some(detail.chars().take(300).collect()) };
    let run = Command::new(executable).args(["auth", "status", "--json"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).output();
    let output = match timeout(wait, run).await {
        Err(_) => return unknown(format!("`claude auth status` did not answer within {wait:?}")),
        Ok(Err(error)) => return unknown(format!("Could not run `claude auth status`: {error}")),
        Ok(Ok(output)) => output,
    };
    // It may exit non-zero when signed out; what it printed decides.
    let status: Option<serde_json::Value> = serde_json::from_slice(&output.stdout).ok();
    match status.as_ref().and_then(|s| s.get("loggedIn")).and_then(serde_json::Value::as_bool) {
        Some(signed_in) => SignIn {
            state: if signed_in { "signedIn" } else { "signedOut" }.into(),
            method: status.as_ref().and_then(|s| s.get("authMethod")).and_then(serde_json::Value::as_str)
                .filter(|method| method.len() <= 40).map(Into::into),
            folder: status.as_ref().and_then(|s| s.get("configDirectory")).and_then(serde_json::Value::as_str)
                .filter(|folder| folder.len() <= 4096).map(Into::into),
            detail: None,
        },
        None => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            unknown(format!("`claude auth status --json` ({}) did not say whether it is signed in{}",
                output.status, if stderr.is_empty() { String::new() } else { format!(": {stderr}") }))
        }
    }
}

/// Where and how to sign Claude Code in for Core on the Core host: that host,
/// as the user Core runs as, in the configuration folder Core's Claude uses.
/// Yuzuno never signs in or copies a login itself.
fn local_claude_login_hint(host: &str, executable: &str, config_dir: Option<&str>, reported: Option<&str>, method: Option<&str>) -> String {
    let command = match config_dir {
        Some(dir) => format!("CLAUDE_CONFIG_DIR={} {} auth login", remote::shell_quote(dir), remote::shell_quote(executable)),
        None => format!("{} auth login", remote::shell_quote(executable)),
    };
    // The folder Claude Code itself reported using, else what Core's environment implies.
    let folder = match (reported, config_dir) {
        (Some(folder), Some(_)) => format!("its configuration folder {folder} (Core's CLAUDE_CONFIG_DIR)"),
        (Some(folder), None) => format!("its configuration folder {folder}"),
        (None, Some(dir)) => format!("the folder Core's CLAUDE_CONFIG_DIR names, {dir}"),
        (None, None) => "Claude Code's default folder for that user (~/.claude)".to_owned(),
    };
    format!(
        "Claude Code on the Core host ({host}) is not signed in for Core: `claude auth status`, run as Core runs it, reports \
         not logged in (auth method: {}). Sign in on {host} as the user Core runs as, in {folder}: for example `{command}`, \
         or another method from Claude Code's authentication guide. Then check the machine again.",
        method.unwrap_or("unknown")
    )
}

/// Why Claude Code there cannot run a turn for Yuzuno, and where to sign in.
/// What it reports is a fact; why is only a likely reason. Its login stays
/// there: Yuzuno never copies one over or chooses a method for the user.
fn claude_login_hint(method: Option<&str>) -> String {
    format!(
        "Claude Code is installed there but not logged in for SSH sessions: run over SSH, `claude auth status` reports not logged in (auth method: {}). \
         One possible reason is a login kept in the macOS Keychain, which an SSH session may not be able to read. \
         Sign in on that machine in a way its SSH sessions can use (for example `claude auth login` in an SSH session there; \
         Claude Code then keeps the login in ~/.claude/.credentials.json when the Keychain is locked), or choose another method from \
         Claude Code's authentication guide. Then check the machine again.",
        method.unwrap_or("unknown")
    )
}

/// Runs one check and stores it, whether it succeeds or fails. Unknown
/// machines are an error; an unreachable machine is a recorded result.
pub async fn check(ws: &Workspace, machine_id: &str) -> Result<MachineCheck> {
    let started = chrono::Utc::now();
    let clock = Instant::now();
    let mut result = MachineCheck {
        machine_id: machine_id.into(), started_at: stamp(started), checked_at: String::new(), duration_ms: 0,
        reachable: false, error: None, host: None, harnesses: vec![], default_folder: None,
    };
    // The SSH machine as this check found it stored; see record_ssh_machine_check.
    let mut probed = None;
    if machine_id == "local" {
        let (host, harnesses, folder) = check_local(ws).await;
        result.reachable = true;
        result.host = Some(host);
        result.harnesses = harnesses;
        result.default_folder = Some(folder);
    } else {
        let id = machine_id.to_owned();
        let machine = ws.stored(move |store| store.machine(&id)).await.context("Machine is not registered in this Workspace")?;
        probed = Some(machine.clone());
        // Unknown until the machine answers.
        let unsupported = HarnessCheck { harness: "claude".into(), supported: true, ..Default::default() };
        match remote::probe(&machine).await {
            Ok(info) => {
                result.reachable = true;
                result.host = Some(HostFacts { hostname: info.hostname, platform: info.platform, home: info.home });
                // Claude there runs Yuzuno's bridge on that machine's Node,
                // with that machine's own installed and logged-in CLI.
                let claude_error = info.claude_error.clone().or_else(|| {
                    info.node_error.as_ref().map(|_| "Claude Code was found, but node (needed by Yuzuno's Claude bridge) was not".to_owned())
                }).or_else(|| (info.claude_logged_in == Some(false)).then(|| claude_login_hint(info.claude_auth_method.as_deref())));
                result.harnesses = vec![HarnessCheck {
                    harness: "codex".into(), supported: true, found: info.codex_error.is_none() && info.codex.is_some(),
                    executable: info.codex, version: info.codex_version, error: info.codex_error, sign_in: None,
                }, HarnessCheck {
                    harness: "claude".into(), supported: true, found: claude_error.is_none() && info.claude.is_some(),
                    executable: info.claude, version: info.claude_version, error: claude_error, sign_in: None,
                }];
                result.default_folder = Some(FolderCheck {
                    path: machine.default_cwd.clone(), resolved: info.default_cwd, error: info.default_cwd_error });
            }
            Err(error) => {
                result.error = Some(error.to_string().chars().take(2000).collect());
                result.harnesses = vec![unsupported];
            }
        }
    }
    result.checked_at = stamp(chrono::Utc::now());
    result.duration_ms = clock.elapsed().as_millis() as u64;
    match probed {
        Some(machine) => ws.stored(move |store| store.record_ssh_machine_check(&result, millis(started), &machine)).await,
        None => ws.stored(move |store| store.record_machine_check(&result, millis(started))).await,
    }
}

/// Keeps the most recently *started* check of a machine (see
/// `Store::record_machine_check`).
fn upsert_check(db: &Connection, check: &MachineCheck, started_ms: i64) -> Result<MachineCheck> {
    db.execute(
        "INSERT INTO machine_checks(machine_id,started_ms,data) VALUES(?1,?2,?3)
         ON CONFLICT(machine_id) DO UPDATE SET started_ms=excluded.started_ms, data=excluded.data
         WHERE excluded.started_ms >= machine_checks.started_ms",
        params![check.machine_id, started_ms, serde_json::to_string(check)?],
    )?;
    let stored: String = db.query_row(
        "SELECT data FROM machine_checks WHERE machine_id=?1", [&check.machine_id], |r| r.get(0))?;
    Ok(serde_json::from_str(&stored)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in `claude` that answers `auth status --json` with this script.
    fn fake_claude(dir: &Path, name: &str, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn only_a_clear_answer_counts_as_signed_in_or_out() {
        let tmp = tempfile::tempdir().unwrap();
        let wait = Duration::from_secs(5);
        // Signed out, as Claude Code 2.1.295 answers with an empty profile
        // (seen on a fresh host): JSON, then exit 1. What it printed decides.
        let out = fake_claude(tmp.path(), "out", r#"echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty",
  "analyticsDisabled": false, "projectsDirectory": "/p/claude-config/projects", "configDirectory": "/p/claude-config"}'; exit 1"#);
        assert_eq!(claude_sign_in(&out, wait).await, SignIn { state: "signedOut".into(), method: Some("none".into()),
            folder: Some("/p/claude-config".into()), detail: None });
        // Signed in: nothing of the account is kept, only the method's short name.
        let signed = fake_claude(tmp.path(), "in",
            r#"echo '{"loggedIn":true,"authMethod":"claude.ai","email":"someone@example.com","orgName":"Org"}'"#);
        let answer = claude_sign_in(&signed, wait).await;
        assert_eq!(answer, SignIn { state: "signedIn".into(), method: Some("claude.ai".into()), folder: None, detail: None });
        assert!(!serde_json::to_string(&answer).unwrap().contains("example.com"));
        // A failure, an answer without loggedIn, a hang: unknown with the reason, never signed out.
        let failed = fake_claude(tmp.path(), "failed", "echo 'config folder unreadable' >&2; exit 2");
        let unknown = claude_sign_in(&failed, wait).await;
        assert_eq!(unknown.state, "unknown");
        assert!(unknown.detail.as_deref().unwrap().ends_with("did not say whether it is signed in: config folder unreadable"), "{unknown:?}");
        let other = fake_claude(tmp.path(), "other", "echo 'Logged in as someone'");
        assert_eq!(claude_sign_in(&other, wait).await.state, "unknown");
        let slow = fake_claude(tmp.path(), "slow", "exec sleep 30");
        let late = claude_sign_in(&slow, Duration::from_millis(300)).await;
        assert_eq!((late.state.as_str(), late.detail.as_deref()),
            ("unknown", Some("`claude auth status` did not answer within 300ms")));
        let missing = claude_sign_in(&tmp.path().join("gone").to_string_lossy(), wait).await;
        assert!(missing.detail.unwrap().starts_with("Could not run `claude auth status`"));
    }

    #[test]
    fn the_sign_in_hint_names_the_host_the_folder_and_the_command() {
        let dir = "/home/u/jobs-lab/run/claude config";
        let hint = local_claude_login_hint("lab_host-Server", "/home/u/.local/bin/claude", Some(dir), Some(dir), Some("none"));
        assert!(hint.starts_with("Claude Code on the Core host (lab_host-Server) is not signed in for Core"), "{hint}");
        assert!(hint.contains("(auth method: none)"));
        assert!(hint.contains("in its configuration folder /home/u/jobs-lab/run/claude config (Core's CLAUDE_CONFIG_DIR)"), "{hint}");
        assert!(hint.contains("`CLAUDE_CONFIG_DIR='/home/u/jobs-lab/run/claude config' '/home/u/.local/bin/claude' auth login`"), "{hint}");
        // Without a reported folder, what Core's environment implies.
        let unreported = local_claude_login_hint("lab_host-Server", "/usr/bin/claude", Some(dir), None, None);
        assert!(unreported.contains("in the folder Core's CLAUDE_CONFIG_DIR names, /home/u/jobs-lab/run/claude config"), "{unreported}");
        let reported = local_claude_login_hint("host", "/usr/bin/claude", None, Some("/home/u/.claude"), None);
        assert!(reported.contains("in its configuration folder /home/u/.claude: for example `'/usr/bin/claude' auth login`"), "{reported}");
        let default = local_claude_login_hint("host", "/usr/bin/claude", None, None, None);
        assert!(default.contains("in Claude Code's default folder for that user (~/.claude): for example `'/usr/bin/claude' auth login`"), "{default}");
        assert!(default.contains("(auth method: unknown)"));
    }
}
