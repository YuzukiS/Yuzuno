//! Where the phone entry's pieces run (T-185): Core in WSL, Tailscale on the
//! Windows it runs on. Only that pair is supported; every command is a fixed
//! Windows program with fixed arguments, reached through WSL interop
//! (https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop).
//! Nothing here takes a command from a request.
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

/// Tailscale for Windows where its installer puts it, as WSL mounts drive C.
pub(super) const WINDOWS_TAILSCALE: &str = "/mnt/c/Program Files/Tailscale/tailscale.exe";
/// Windows' own curl, for requests made from the Windows side.
pub(super) const WINDOWS_CURL: &str = "/mnt/c/Windows/System32/curl.exe";

#[derive(Clone, Debug)]
pub(crate) struct Host {
    /// What runs Core, and whether it is the supported pair.
    pub(super) support: Value,
    pub(super) supported: bool,
    pub(super) tailscale: PathBuf,
    pub(super) curl: PathBuf,
    /// Seconds each command may take, when a test shortens them.
    pub(super) limit: Option<u64>,
}

impl Host {
    /// This computer as it is now. `YUZUNO_TAILSCALE_CLI` and
    /// `YUZUNO_REMOTE_ACCESS_CURL` point tests and labs at stand-ins; with
    /// them set the pair still has to look like WSL with interop.
    pub(crate) fn detect() -> Self {
        let tailscale = std::env::var_os("YUZUNO_TAILSCALE_CLI").map(PathBuf::from).unwrap_or_else(|| WINDOWS_TAILSCALE.into());
        let curl = std::env::var_os("YUZUNO_REMOTE_ACCESS_CURL").map(PathBuf::from).unwrap_or_else(|| WINDOWS_CURL.into());
        let version = std::fs::read_to_string("/proc/version").unwrap_or_default();
        let wsl = version.to_ascii_lowercase().contains("microsoft")
            && std::path::Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists();
        let os = std::env::consts::OS;
        let kind = if wsl { "wsl" } else if os == "linux" { "linux" } else if os == "macos" { "macos" } else { "other" };
        let name = std::env::var("WSL_DISTRO_NAME").ok().filter(|n| !n.is_empty())
            .or_else(|| std::fs::read_to_string("/proc/sys/kernel/hostname").ok().map(|h| h.trim().to_owned()))
            .unwrap_or_else(|| os.to_owned());
        Self::new(kind, &name, wsl.then(networking).flatten(), tailscale, curl)
    }

    pub(super) fn new(kind: &str, name: &str, networking: Option<String>, tailscale: PathBuf, curl: PathBuf) -> Self {
        let found = tailscale.is_file();
        let reason = if kind != "wsl" {
            Some(format!(
                "This Core runs on {}. Phone access from Settings supports one setup for now: Core in WSL with Tailscale for Windows on the same PC. Any other host, a Tailscale inside WSL included, is not configured from here.",
                match kind { "linux" => "Linux, not WSL", "macos" => "macOS", _ => "an unrecognized system" }
            ))
        } else if !found {
            Some(format!("Tailscale for Windows was not found at {}. Install it on Windows, or this Core cannot configure phone access.", tailscale.display()))
        } else {
            None
        };
        let support = json!({
            "state": if reason.is_none() { "supported" } else { "unsupported" },
            "reason": reason,
            "coreHost": {"kind": kind, "name": name, "networking": networking.as_deref().unwrap_or("unknown")},
            "tailscaleHost": if found && kind == "wsl" {
                json!({"kind": "windows", "cli": tailscale.display().to_string()})
            } else {
                json!({"kind": "none"})
            },
        });
        Self { supported: reason.is_none(), support, tailscale, curl, limit: None }
    }
}

/// `wslinfo --networking-mode`: mirrored, nat, or unknown when WSL is too old.
fn networking() -> Option<String> {
    let out = std::process::Command::new("wslinfo").arg("--networking-mode").stderr(Stdio::null()).output().ok()?;
    let mode = String::from_utf8_lossy(&out.stdout).trim().to_ascii_lowercase();
    (out.status.success() && matches!(mode.as_str(), "mirrored" | "nat")).then_some(mode)
}

/// What a program printed, bounded, within `seconds`. A timeout is its own
/// error: whether a change it was making took effect is then unknown.
pub(super) struct Output {
    pub(super) code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

#[derive(Debug)]
pub(super) struct TimedOut(pub(super) String);
impl std::fmt::Display for TimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} did not answer within its time limit; whether it took effect is unknown", self.0)
    }
}
impl std::error::Error for TimedOut {}

async fn on(host: &Host, program: &PathBuf, args: &[&str], seconds: u64) -> Result<Output> {
    run(program, args, host.limit.unwrap_or(seconds)).await
}

pub(super) async fn run(program: &PathBuf, args: &[&str], seconds: u64) -> Result<Output> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("Could not start {}", program.display()))?;
    let mut out = child.stdout.take().context("no stdout")?.take(1024 * 1024);
    let mut err = child.stderr.take().context("no stderr")?.take(64 * 1024);
    let name = format!("{} {}", program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), args.join(" "));
    let finished = async {
        let (mut o, mut e) = (Vec::new(), Vec::new());
        let (a, b, status) = tokio::join!(
            out.read_to_end(&mut o),
            err.read_to_end(&mut e),
            child.wait()
        );
        a?;
        b?;
        Ok::<_, anyhow::Error>(Output { code: status?.code(), stdout: decode(&o), stderr: decode(&e) })
    };
    match tokio::time::timeout(Duration::from_secs(seconds), finished).await {
        Ok(result) => result,
        Err(_) => Err(TimedOut(name).into()),
    }
}

/// Windows programs may print UTF-8 with a byte order mark.
fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
}

/// `tailscale status --json`, reduced to what the page shows.
pub(super) async fn status(host: &Host) -> Result<Value> {
    let out = on(host, &host.tailscale, &["status", "--json"], 20).await?;
    let status: Value = serde_json::from_str(out.stdout.trim()).with_context(|| {
        format!("Tailscale status was not JSON (exit {:?}): {}", out.code, out.stderr.trim())
    })?;
    let backend = status["BackendState"].as_str().unwrap_or("");
    let dns = status["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.').to_owned();
    let owner = status["Self"]["UserID"].as_u64()
        .and_then(|id| status["User"][id.to_string()]["LoginName"].as_str())
        .map(str::to_owned);
    let https = !dns.is_empty() && status["CertDomains"].as_array().is_some_and(|d| d.iter().any(|d| d == dns.as_str()));
    Ok(json!({
        "state": match backend { "Running" => "running", "NeedsLogin" | "NeedsMachineAuth" => "needsLogin", "Stopped" => "stopped", _ => "error" },
        "backend": backend,
        "dnsName": (!dns.is_empty()).then_some(dns),
        "ownerLogin": owner,
        "https": https,
        "observedAt": crate::model::now(),
    }))
}

/// `tailscale serve status --json` (an empty answer is no configuration).
pub(super) async fn serve_status(host: &Host) -> Result<Value> {
    let out = on(host, &host.tailscale, &["serve", "status", "--json"], 20).await?;
    ensure!(out.code == Some(0), "Tailscale serve status failed (exit {:?}): {}", out.code, out.stderr.trim());
    let text = out.stdout.trim();
    if text.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(text).context("Tailscale serve status was not JSON")
}

/// How one Serve port stands in a `serve status`: absent, exactly the entry
/// wanted (HTTPS, one handler "/" proxying to `target`, no Funnel), or used
/// for something else.
pub(super) fn serve_entry(config: &Value, dns: &str, port: u16, target: &str) -> (&'static str, String) {
    let name = format!("{dns}:{port}");
    let tcp = &config["TCP"][port.to_string()];
    let web = config["Web"].as_object().and_then(|web| {
        web.iter().find(|(key, _)| key.rsplit_once(':').is_some_and(|(_, p)| p == port.to_string())).map(|(k, v)| (k.clone(), v.clone()))
    });
    let funnel = config["AllowFunnel"].as_object().is_some_and(|f| f.keys().any(|k| k.ends_with(&format!(":{port}"))));
    if tcp.is_null() && web.is_none() {
        return ("absent", format!("Nothing is served on port {port}"));
    }
    let exact = tcp == &json!({"HTTPS": true})
        && web.as_ref().is_some_and(|(key, value)| key == &name && value == &json!({"Handlers": {"/": {"Proxy": target}}}))
        && !funnel;
    if exact {
        return ("match", format!("https://{name} serves {target}"));
    }
    let what = match &web {
        Some((key, value)) => format!("{key} is {value}"),
        None => format!("TCP {port} is {tcp}"),
    };
    ("conflict", format!("Port {port} is already used by another Serve configuration ({what}{}); it is left as it is", if funnel { ", with Funnel" } else { "" }))
}

/// Every Serve port other than `port`, for the page's "other services kept".
pub(super) fn other_entries(config: &Value, port: u16) -> usize {
    config["TCP"].as_object().map_or(0, |tcp| tcp.keys().filter(|p| **p != port.to_string()).count())
}

/// `tailscale serve --bg --https=<port> <target>`: runs in the background
/// and persists in tailscaled (https://tailscale.com/docs/reference/tailscale-cli/serve).
pub(super) async fn serve_add(host: &Host, port: u16, target: &str) -> Result<()> {
    let flag = format!("--https={port}");
    let out = on(host, &host.tailscale, &["serve", "--bg", &flag, target], 30).await?;
    if out.code != Some(0) {
        bail!("Tailscale Serve refused the entry (exit {:?}): {}", out.code, out.stderr.trim());
    }
    Ok(())
}

/// `tailscale serve --https=<port> off`: that port only, never a reset.
pub(super) async fn serve_off(host: &Host, port: u16) -> Result<()> {
    let flag = format!("--https={port}");
    let out = on(host, &host.tailscale, &["serve", &flag, "off"], 30).await?;
    if out.code != Some(0) {
        bail!("Tailscale Serve did not remove port {port} (exit {:?}): {}", out.code, out.stderr.trim());
    }
    Ok(())
}

/// A GET from the Windows side: its status and the start of its body.
pub(super) async fn windows_get(host: &Host, url: &str) -> Result<(u16, String)> {
    let out = on(host, &host.curl, &["-sS", "-m", "15", "-o", "-", "-w", "\n%{http_code}", url], 25).await?;
    let (body, code) = out.stdout.rsplit_once('\n').unwrap_or(("", out.stdout.as_str()));
    let code: u16 = code.trim().parse().unwrap_or(0);
    ensure!(code != 0, "No answer from {url}: {}", out.stderr.trim());
    Ok((code, body.chars().take(300).collect()))
}
