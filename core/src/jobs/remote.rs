//! Jobs on a registered remote Linux machine, over that machine's SSH
//! identity (crate::remote). The machine runs each attempt under its own
//! supervisor (remote_job.py) in a private folder named by job and attempt:
//! its own process group, output ring and outcome.
//!
//! Before anything is started, Core pins the machine that answers (`hello`:
//! an app-specific hash of its machine-id) and records it with the attempt's
//! request digest. It records that the start is being sent before it sends
//! it, and never sends it twice. Every later request names the Workspace,
//! the machine entry, the digest and the pinned machine, so a re-pointed
//! name, another Workspace's record or another command is never taken for
//! this attempt. A start that went unanswered is checked with a fence: if it
//! never arrived, it is refused from then on and the job was not started; if
//! it did, it is that same attempt. Whatever cannot be settled for certain
//! is unknown and keeps its slot.
//!
//! Each SSH machine has its own admission (maxJobs, and its budget when one
//! is set). Declared CPU, RAM and swap go with each attempt, with the
//! machine's mode: the helper holds what the account's systemd user manager
//! can in the attempt's own scope, only where the account lingers, and reads
//! it back; strict starts nothing it cannot hold, limited runs and records
//! what is only declared, and a machine registered before limits (no mode)
//! only records them, as before. GPU admission, pause and artifacts are not
//! available on this executor.
//!
//! Windows on the PC this Core's WSL runs on is the built-in machine
//! `windows`, reached through WSL interop instead of SSH. Its helper speaks
//! the same requests and replies, so everything above holds there too; only
//! how a call reaches the machine differs (see `Machine`).
//!
//! Each attempt lives under a data root on its machine: the absolute folder
//! the helper reports when Core pins the machine (or, pinned by an older
//! Core, the machine's root as configured), recorded before the start is
//! sent and named in every later request. Changing a machine's root, or the
//! default, never loses an attempt or starts it again. An attempt sent
//! before roots were recorded is in the legacy root its Core used.
use super::store::{budget, get, reserved, save};
use super::{changed, Workspace};
use crate::{model::now, remote::RemoteMachine, store::Store};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HELPER: &str = include_str!("remote_job.py");
/// Attempts running at once on one remote machine.
pub(super) const SLOTS: i64 = 2;
/// The ceiling a user may set for a machine's attempts at once: an SSH
/// machine's maxJobs (validated in remote::validate_machine) and Windows'.
pub(super) const MAX_JOBS_RANGE: std::ops::RangeInclusive<u32> = 1..=64;
/// Windows' mode: its Job Object holds every declared limit.
const STRICT: &str = "strict";
/// An SSH attempt's mode when its machine has none (registered before limits,
/// or set back to it), or when an older Core reserved it: resources are
/// recorded, nothing is held, and its request carries no limits (digest v1),
/// as before T-108.
const LEGACY: &str = "legacy";
/// How often a remote attempt is checked; a cancellation is acted on at once.
const OBSERVE_EVERY: Duration = Duration::from_secs(10);
const REPLY_LIMIT: u64 = 256 * 1024;
/// The OpenSSH program; tests substitute a stand-in with its conventions.
pub(super) const SSH: &str = "ssh";
/// The built-in machine: Windows on this PC, through WSL interop.
pub(super) const WINDOWS: &str = "windows";
const WINDOWS_NAME: &str = "Windows on this PC";
/// The request/reply protocol the Windows helper must speak (windows_job.cs Protocol).
pub(super) const WINDOWS_PROTOCOL: i64 = 1;
/// Where a release keeps the native Windows Jobs helper, which WSL interop
/// runs as a Windows program: windows_job.cs built with Windows' own .NET
/// Framework compiler (tools/build-windows-helper.py).
const WINDOWS_HELPER: &str = "runtimes/windows-jobs/yuzuno-jobs-helper.exe";
/// The Windows helper's data root for new attempts, unless
/// YUZUNO_WINDOWS_JOBS_ROOT names one (an acceptance run's own folder).
/// Outside %LOCALAPPDATA%\Yuzuno, the desktop app's install folder, so its
/// installer and uninstaller never touch Jobs' records.
const WINDOWS_ROOT: &str = r"%LOCALAPPDATA%\YuzunoData\windows-jobs";
/// The helper's root before roots were recorded, when no
/// YUZUNO_WINDOWS_JOBS_ROOT named one.
pub(crate) const WINDOWS_LEGACY_ROOT: &str = r"%LOCALAPPDATA%\yuzuno-next";
const NO_WINDOWS_HELPER: &str = "this Core has no Windows Jobs helper (its release ships none, or a development Core was not given YUZUNO_WINDOWS_JOBS_HELPER with YUZUNO_WINDOWS_JOBS_HELPER_SHA256)";

/// A machine a remote Job runs on, and how a call reaches it.
#[derive(Clone, Debug)]
pub(super) enum Machine {
    /// A registered machine, over its own SSH identity.
    Ssh(RemoteMachine),
    /// Windows on this PC: the native helper through WSL interop, no SSH.
    Windows,
}

impl Machine {
    pub(super) fn name(&self) -> &str {
        match self {
            Machine::Ssh(machine) => &machine.name,
            Machine::Windows => WINDOWS_NAME,
        }
    }
}

/// The programs calls go through; tests substitute stand-ins.
pub(super) struct Programs<'a> {
    pub ssh: &'a str,
    /// None when this Core has no Windows helper.
    pub windows: Option<&'a WindowsHelper>,
}

/// The native Windows helper, and the SHA-256 its bytes must have each time
/// it is run.
#[derive(Clone, Debug)]
pub(super) struct WindowsHelper {
    pub path: String,
    pub sha256: String,
    /// Whether WSL interop was on when this was read; off, nothing is run.
    pub interop: bool,
}

/// This Core's Windows helper. A managed release names its own copy and the
/// digest from its signed manifest, or none (both empty); a development Core
/// uses only one given explicitly with its digest. Nothing falls back to a
/// data folder, and nothing is compiled on the spot.
pub(super) fn windows_helper() -> Option<WindowsHelper> {
    configured_helper(std::env::var("YUZUNO_WINDOWS_JOBS_HELPER").ok(), std::env::var("YUZUNO_WINDOWS_JOBS_HELPER_SHA256").ok())
}

/// A path is used only with a well-formed digest to check it against.
pub(super) fn configured_helper(path: Option<String>, sha256: Option<String>) -> Option<WindowsHelper> {
    let path = path.filter(|path| !path.is_empty())?;
    let sha256 = sha256?.to_ascii_lowercase();
    (sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| WindowsHelper { path, sha256, interop: windows_available() })
}

/// `YUZUNO_WINDOWS_JOBS_HELPER` and its SHA-256 for a managed release: its
/// own verified copy, or empty when it has none (an older release), which
/// only leaves Windows jobs not started.
pub(super) fn release_windows_helper(release: &crate::updates::package::Bundle) -> (std::path::PathBuf, String) {
    match release.manifest.files.get(WINDOWS_HELPER) {
        Some(asset) => (release.path.join(WINDOWS_HELPER), asset.sha256.clone()),
        None => (std::path::PathBuf::new(), String::new()),
    }
}

impl WindowsHelper {
    /// The helper's bytes as they are now, read before each run: anything
    /// but exactly the trusted file is never run.
    async fn check(&self) -> std::result::Result<(), String> {
        let bytes = tokio::fs::read(&self.path).await.map_err(|error| {
            format!("the Windows Jobs helper cannot be run from this Core's WSL ({}: {error})", self.path)
        })?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != self.sha256 {
            return Err(format!(
                "the Windows Jobs helper at {} is not the one this Core trusts (SHA-256 {actual}, expected {}); it was not run",
                self.path, self.sha256));
        }
        Ok(())
    }

    /// A test's stand-in, trusted as it is now.
    #[cfg(test)]
    pub(super) fn trusting(path: &str) -> Self {
        let sha256 = std::fs::read(path).map(|bytes| format!("{:x}", Sha256::digest(&bytes))).unwrap_or_default();
        WindowsHelper { path: path.to_owned(), sha256, interop: true }
    }
}

/// Whether this Core runs in WSL with Windows interop on, so that the
/// built-in Windows machine can be offered at all.
pub(super) fn windows_available() -> bool {
    std::fs::read_to_string("/proc/sys/fs/binfmt_misc/WSLInterop").is_ok_and(|state| state.starts_with("enabled"))
}
/// Replies that show the attempt's record exists on the pinned machine.
const ACKNOWLEDGING: [&str; 7] = ["starting", "running", "stopping", "settling", "lost", "terminal", "unclear"];

/// What one helper call came back with.
#[derive(Debug)]
pub(super) enum Reply {
    Answer(Value),
    /// The helper refused before doing anything (no process was started).
    Refused(String),
    /// No answer: the machine was not reached. Whatever it was asked to do
    /// may or may not have happened.
    NoAnswer(String),
    /// The machine was reached but the helper did not run to an answer
    /// there (a crash, a kill, no reply line): as uncertain as no answer.
    Broken(String),
    /// The machine cannot run the helper at all: no python3 (the shell's 127
    /// or 126), or one too old for it (a SyntaxError). Before anything was
    /// sent this is final; afterwards it is as uncertain as no answer.
    Unusable(String),
}

/// The helper marks its reply line with this and the call's nonce (sent on
/// stdin), so that nothing the account's login scripts print, a forged
/// reply line included, ever passes for a reply.
const REPLY_MARK: &str = "YUZUNO-JOBS-REPLY ";

/// One helper call's outcome from its exit status and output. A reply is
/// exactly one complete line with this call's nonce, and counts only with
/// exit 0 (an answer) or 3 (a refusal); anything else is no answer, or a
/// helper that did not run to an answer there.
pub(super) fn parse_reply(code: Option<i32>, out: &[u8], stderr: &str, nonce: &str) -> Reply {
    let code = match code {
        // OpenSSH exits 255 when it cannot connect or authenticate.
        Some(255) => return Reply::NoAnswer(format!("SSH: {stderr}")),
        None => return Reply::NoAnswer("SSH ended by a signal".into()),
        Some(code) => code,
    };
    framed(code, out, stderr, nonce).unwrap_or_else(|code| match code {
        // The shell's own: python3 not found, or not executable.
        126 | 127 => Reply::Unusable(format!("it has no usable python3 ({stderr})")),
        // The helper's source does not parse: a python3 older than 3.6.
        1 if stderr.contains("SyntaxError") => {
            Reply::Unusable(format!("its python3 is too old for the Jobs helper, which needs 3.6 or newer ({stderr})"))
        }
        _ => Reply::Broken(format!("the helper there exited {code}: {stderr}")),
    })
}

/// The same for a call to Windows through WSL interop. There is no SSH:
/// whatever exit comes without a reply is a helper that did not run to an
/// answer, as uncertain as no answer. A helper that cannot be started at
/// all is told apart before (see `call`).
pub(super) fn parse_windows_reply(code: Option<i32>, out: &[u8], stderr: &str, nonce: &str) -> Reply {
    let Some(code) = code else {
        return Reply::NoAnswer("the Windows helper ended by a signal".into());
    };
    framed(code, out, stderr, nonce).unwrap_or_else(|code| Reply::Broken(format!("the helper on Windows exited {code}: {stderr}")))
}

/// The reply in this call's output, or the exit status when there is none
/// to read and the transport decides what that exit means.
fn framed(code: i32, out: &[u8], stderr: &str, nonce: &str) -> std::result::Result<Reply, i32> {
    if out.len() as u64 > REPLY_LIMIT {
        return Ok(Reply::Broken(format!("more than {} KiB of output", REPLY_LIMIT / 1024)));
    }
    let text = String::from_utf8_lossy(out);
    let prefix = format!("{REPLY_MARK}{nonce} ");
    // Only lines that end with a newline: a cut-off last line is no reply.
    let complete = text.rsplit_once('\n').map_or("", |(lines, _)| lines);
    let frames: Vec<&str> = complete.split('\n').filter_map(|line| line.strip_prefix(prefix.as_str())).collect();
    let reply = match frames.as_slice() {
        [one] => serde_json::from_str::<Value>(one).ok().filter(Value::is_object),
        [] => None,
        _ => return Ok(Reply::Broken("more than one reply line".into())),
    };
    match (code, reply) {
        (0, Some(reply)) if reply.get("error").is_none() => Ok(Reply::Answer(reply)),
        (3, Some(reply)) if reply["error"].is_string() => {
            Ok(Reply::Refused(reply["error"].as_str().unwrap_or_default().to_owned()))
        }
        (0 | 3, _) => Ok(Reply::Broken(format!("no reply from the helper there (exit {code}: {stderr})"))),
        _ => Err(code),
    }
}

#[cfg(test)]
pub(super) async fn invoke(program: &str, machine: &RemoteMachine, request: Value) -> Reply {
    call(&Programs { ssh: program, windows: None }, &Machine::Ssh(machine.clone()), request).await
}

/// One helper call on the machine, through its own transport.
pub(super) async fn call(programs: &Programs<'_>, machine: &Machine, mut request: Value) -> Reply {
    if let Machine::Ssh(machine) = machine {
        if let Err(error) = crate::remote::validate_machine(machine) {
            return Reply::Refused(format!("{error:#}"));
        }
    }
    // New for each call; only the helper, which reads it from stdin, can echo it.
    request["replyNonce"] = json!(uuid::Uuid::new_v4().simple().to_string());
    let nonce = request["replyNonce"].as_str().unwrap_or_default().to_owned();
    let Ok(payload) = serde_json::to_vec(&request) else {
        return Reply::Refused("the request could not be encoded".into());
    };
    // Only fixed helper code enters the command; everything variable
    // travels as JSON on stdin.
    let mut command = match machine {
        Machine::Ssh(machine) => {
            let mut command = crate::remote::ssh_with(programs.ssh);
            command
                .args(["-o", "ClearAllForwardings=yes"])
                .arg(&machine.target)
                .arg(format!("python3 -c {}", crate::remote::shell_quote(HELPER)));
            command
        }
        // The native helper itself, run by WSL interop as a Windows program
        // once its bytes are the trusted ones, with the data root an
        // isolated Core (an acceptance run) names.
        Machine::Windows => {
            let Some(helper) = programs.windows else {
                return Reply::Unusable(NO_WINDOWS_HELPER.into());
            };
            if !helper.interop {
                return Reply::Unusable("WSL interop is off, so this Core cannot run Windows programs".into());
            }
            if let Err(why) = helper.check().await {
                return Reply::Unusable(why);
            }
            let mut command = tokio::process::Command::new(&helper.path);
            // An attempt's own root; hello, which writes nothing, reports
            // the root an acceptance run names.
            if let Some(root) = request["root"].as_str() {
                command.arg("--root").arg(root);
            } else if let Some(root) = std::env::var_os("YUZUNO_WINDOWS_JOBS_ROOT") {
                command.arg("--root").arg(root);
            }
            command
        }
    };
    let spawned = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match (spawned, machine) {
        (Ok(child), _) => child,
        // Nothing reached Windows: interop is off, or the file is not executable.
        (Err(error), Machine::Windows) => {
            let path = programs.windows.map_or("", |helper| helper.path.as_str());
            return Reply::Unusable(format!("the Windows Jobs helper cannot be run from this Core's WSL ({path}: {error})"))
        }
        (Err(error), Machine::Ssh(_)) => return Reply::NoAnswer(format!("could not start OpenSSH: {error}")),
    };
    let run = async move {
        let mut stdin = child.stdin.take().context("no stdin")?;
        let mut stdout = child.stdout.take().context("no stdout")?.take(REPLY_LIMIT + 1);
        let mut stderr = child.stderr.take().context("no stderr")?.take(8192);
        let (_, out, err) = tokio::try_join!(
            // Moved in, so stdin closes once written: the helper reads to EOF.
            // An SSH that cannot connect exits without reading it; what it
            // printed and its exit status say why, not the pipe it closed.
            async move {
                match stdin.write_all(&payload).await {
                    Ok(()) => stdin.shutdown().await,
                    Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
                    Err(error) => Err(error),
                }
            },
            async {
                let mut bytes = Vec::new();
                stdout.read_to_end(&mut bytes).await.map(|_| bytes)
            },
            async {
                let mut bytes = Vec::new();
                stderr.read_to_end(&mut bytes).await.map(|_| bytes)
            },
        )?;
        let status = child.wait().await?;
        Ok::<_, anyhow::Error>((status.code(), out, err))
    };
    match tokio::time::timeout(Duration::from_secs(30), run).await {
        Err(_) => Reply::NoAnswer("no answer within 30 seconds".into()),
        Ok(Err(error)) => Reply::NoAnswer(format!("{error:#}")),
        Ok(Ok((code, out, err))) => {
            let stderr = String::from_utf8_lossy(&err).trim().chars().take(500).collect::<String>();
            match machine {
                Machine::Ssh(_) => parse_reply(code, &out, &stderr, &nonce),
                Machine::Windows => parse_windows_reply(code, &out, &stderr, &nonce),
            }
        }
    }
}

/// What the attempt runs, as sent to the machine. It also carries the
/// declared resources and the mode: an SSH machine's, taken when its slot was
/// (see reserve_remote), strict on Windows, whose Job Object holds both. The
/// helper holds them or refuses.
pub(super) fn spec(job: &Value) -> Value {
    let mut spec = json!({"argv": job["argv"], "cwd": job["cwd"],
        "env": if job["env"].is_object() { job["env"].clone() } else { json!({}) },
        "timeoutSeconds": job["timeoutSeconds"]});
    let kind = job["executor"]["kind"].as_str();
    let mode = job["executor"]["limitMode"].as_str();
    // An SSH attempt in the legacy mode, or reserved by an older Core (no
    // mode at all), carries no limits. Windows does, unless an older Core
    // already pinned this attempt with the digest of its request without
    // them (v1): the start must match what was pinned.
    let pinned_v1 = kind == Some(WINDOWS) && job["remote"]["digest"].as_str() == Some(digest(&spec).as_str());
    let legacy = kind == Some(SSH) && matches!(mode, None | Some(LEGACY)) || pinned_v1;
    if matches!(kind, Some(SSH | WINDOWS)) && !legacy {
        let declared = &job["resources"];
        spec["limits"] = json!({"mode": mode.unwrap_or(STRICT),
            "cpuMillis": declared["cpuMillis"], "memoryMiB": declared["memoryMiB"], "swapMiB": declared["swapMiB"]});
    }
    // On an SSH machine or Windows, the inputs frozen at submit and the
    // declared artifacts go with the start (v3): the supervisor checks the
    // inputs again before the command runs and the artifacts after it exits.
    if matches!(kind, Some(SSH | WINDOWS)) {
        if let Some(files) = job["snapshot"]["files"].as_array().filter(|files| !files.is_empty()) {
            spec["inputs"] = files
                .iter()
                .map(|f| json!({"path": f["path"], "absolutePath": f["absolutePath"], "sha256": f["sha256"]}))
                .collect();
        }
        if let Some(artifacts) = job["artifacts"].as_array().filter(|artifacts| !artifacts.is_empty()) {
            spec["artifacts"] = artifacts
                .iter()
                .map(|a| json!({"path": a["path"], "format": a["format"].as_str().unwrap_or("bytes"),
                    "minBytes": a["minBytes"].as_u64().unwrap_or(1)}))
                .collect();
        }
    }
    spec
}

/// A job with inputs or artifacts (a v3 request) is bound when it is
/// submitted: its digest, with the mode its limits take, is recorded then and
/// marked `prebound` (store.rs new_job). A Core from before inputs and
/// artifacts never starts it with its own, shorter request, even after a
/// rollback while it is queued: it records a digest only where none is
/// (remote_note never replaces one), and the machine refuses a start whose
/// request does not match the digest it carries, before writing anything.
/// Jobs without inputs or artifacts are pinned at their start as before.
pub(super) fn prebind(job: &mut Value, mode: Option<String>) {
    let nonempty = |value: &Value| value.as_array().is_some_and(|items| !items.is_empty());
    let kind = job["executor"]["kind"].as_str();
    if !matches!(kind, Some(SSH | WINDOWS)) || !(nonempty(&job["snapshot"]["files"]) || nonempty(&job["artifacts"])) {
        return;
    }
    if kind == Some(SSH) {
        job["executor"]["limitMode"] = json!(mode.unwrap_or_else(|| LEGACY.to_owned()));
    }
    job["remote"] = json!({"digest": digest(&spec(job)), "prebound": {"at": now(), "request": "v3"}});
}

/// The request digest, encoded without ambiguity exactly as the helper
/// does; the helper refuses a start whose command does not match it. A spec
/// with limits is v2 and binds them too; one with frozen inputs or declared
/// artifacts is v3 and binds those as well. An attempt recorded with an
/// earlier version keeps the digest it was recorded with.
pub(super) fn digest(spec: &Value) -> String {
    fn put(hash: &mut Sha256, text: &str) {
        hash.update(format!("{}:", text.len()).as_bytes());
        hash.update(text.as_bytes());
        hash.update(b",");
    }
    let limits = spec.get("limits").filter(|limits| !limits.is_null());
    // None or empty: no inputs or artifacts, so v1 or v2 exactly as before.
    let nonempty = |key: &str| spec[key].as_array().is_some_and(|items| !items.is_empty());
    let v3 = nonempty("inputs") || nonempty("artifacts");
    let mut hash = Sha256::new();
    put(&mut hash, match (v3, limits.is_some()) {
        (true, _) => "yuzuno-remote-job-v3",
        (false, true) => "yuzuno-remote-job-v2",
        (false, false) => "yuzuno-remote-job-v1",
    });
    let argv = spec["argv"].as_array().map(Vec::as_slice).unwrap_or_default();
    put(&mut hash, &argv.len().to_string());
    for item in argv {
        put(&mut hash, item.as_str().unwrap_or_default());
    }
    put(&mut hash, spec["cwd"].as_str().unwrap_or_default());
    let env: BTreeMap<&str, &str> = spec["env"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| (key.as_str(), value.as_str().unwrap_or_default()))
        .collect();
    put(&mut hash, &env.len().to_string());
    for (key, value) in env {
        put(&mut hash, key);
        put(&mut hash, value);
    }
    put(&mut hash, &spec["timeoutSeconds"].as_i64().unwrap_or_default().to_string());
    if v3 {
        put(&mut hash, if limits.is_some() { "limits" } else { "no limits" });
    }
    if let Some(limits) = limits {
        put(&mut hash, limits["mode"].as_str().unwrap_or_default());
        for key in ["cpuMillis", "memoryMiB", "swapMiB"] {
            put(&mut hash, &limits[key].as_i64().unwrap_or_default().to_string());
        }
    }
    if v3 {
        let empty = Vec::new();
        let inputs = spec["inputs"].as_array().unwrap_or(&empty);
        put(&mut hash, &inputs.len().to_string());
        for item in inputs {
            for key in ["path", "absolutePath", "sha256"] {
                put(&mut hash, item[key].as_str().unwrap_or_default());
            }
        }
        let artifacts = spec["artifacts"].as_array().unwrap_or(&empty);
        put(&mut hash, &artifacts.len().to_string());
        for item in artifacts {
            put(&mut hash, item["path"].as_str().unwrap_or_default());
            put(&mut hash, item["format"].as_str().unwrap_or_default());
            put(&mut hash, &item["minBytes"].as_u64().unwrap_or_default().to_string());
        }
    }
    format!("{:x}", hash.finalize())
}

/// A request about this attempt, bound to everything that names it.
fn bound(job: &Value, workspace: &str, action: &str) -> Value {
    json!({"action": action, "jobId": job["id"], "attempt": job["attempt"], "workspaceKey": workspace,
        "machineId": job["executor"]["machineId"], "digest": job["remote"]["digest"],
        "expectHost": job["remote"]["hostId"], "root": attempt_root(job)})
}

#[cfg(test)]
pub(super) fn bound_for_tests(job: &Value, workspace: &str, action: &str) -> Value {
    bound(job, workspace, action)
}

/// The data root this attempt was sent to: recorded with its start, or, for
/// one sent before roots were recorded, the root its Core used then.
pub(super) fn attempt_root(job: &Value) -> Value {
    match job["remote"]["root"].as_str() {
        Some(root) => json!(root),
        None if job["executor"]["kind"] == "windows" => json!(windows_named_root().unwrap_or_else(|| WINDOWS_LEGACY_ROOT.into())),
        None => json!(crate::remote::LEGACY_ROOT),
    }
}

/// The data root a start on this machine goes to now.
fn new_root(machine: &Machine) -> String {
    match machine {
        Machine::Ssh(machine) => machine.root().to_owned(),
        Machine::Windows => windows_named_root().unwrap_or_else(|| WINDOWS_ROOT.to_owned()),
    }
}

/// The absolute root a hello reported, if it is one Core can name again:
/// plain names (remote::validate_root) or a local Windows drive folder.
fn pinned_root(machine: &Machine, reply: &Value) -> Option<String> {
    match machine {
        Machine::Ssh(_) => reply["root"].as_str()
            .filter(|root| root.starts_with('/') && crate::remote::validate_root(root).is_ok())
            .map(str::to_owned),
        Machine::Windows => reply["dataRoot"].as_str()
            .filter(|root| {
                let bytes = root.as_bytes();
                root.len() <= 240 && bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\"
                    && !root.chars().any(|c| c.is_control() || "\"<>|?*".contains(c))
            })
            .map(str::to_owned),
    }
}

fn windows_named_root() -> Option<String> {
    std::env::var("YUZUNO_WINDOWS_JOBS_ROOT").ok().filter(|root| !root.is_empty())
}

fn machine_name(job: &Value) -> String {
    job["executor"]["machineName"].as_str().unwrap_or("the remote machine").to_owned()
}

/// A reply from any machine but the pinned one is that machine's answer,
/// never this attempt's.
fn from_pinned(job: &Value, mut reply: Value) -> Value {
    if reply["hostId"] != job["remote"]["hostId"] {
        reply["status"] = json!("other_host");
    }
    reply
}

/// What holds the attempt's declared resources there, in a few words, from
/// the limits its helper froze when it started it. An attempt started
/// without them (by an older Core) has its CPU and RAM only declared.
fn limits_said(job: &Value, started: &Value) -> String {
    let limits = &started["limits"];
    let windows = job["executor"]["kind"] == WINDOWS;
    if !limits.is_object() {
        return if !windows && matches!(job["executor"]["limitMode"].as_str(), None | Some(LEGACY)) {
            "declared CPU and RAM are recorded, not enforced there: this machine keeps the record-only mode it had \
             before limits (choose strict or limited for it on the Machines page)".into()
        } else {
            "declared CPU and RAM are not enforced there".into()
        };
    }
    let memory = match (limits["memory"] == "limited", windows) {
        (true, true) => format!("committed memory held at {} MiB by its Job Object", limits["memoryMiB"]),
        // Swap is held with memory unless the kernel there does not account it.
        (true, false) if limits["swap"] == "declared" => format!(
            "memory held at {} MiB in its own systemd scope, swap declared only (that kernel does not account it)",
            limits["memoryMiB"]),
        (true, false) => format!("memory held at {} MiB in its own systemd scope", limits["memoryMiB"]),
        (false, _) => "memory declared only, not limited".to_owned(),
    };
    let cpu = if limits["cpu"] == "limited" {
        format!("CPU held at {} mCPU", limits["cpuMillis"])
    } else {
        "CPU declared only, not limited".to_owned()
    };
    let mut said = format!("{memory}; {cpu}");
    let scoped = limits["memory"] == "limited" || limits["cpu"] == "limited";
    // limited holds nothing in a scope of a user manager that may stop; the
    // helper's own caveat says when that, not a missing controller, is why.
    let unlingering = limits["caveats"].as_array().is_some_and(|caveats| {
        caveats.iter().any(|caveat| caveat.as_str().is_some_and(|text| text.contains("this account does not linger")))
    });
    if !windows && !scoped && unlingering {
        said.push_str("; nothing is held in a scope because this account does not linger");
    }
    said
}

/// Evidence for a reply about this attempt, or None while it is settling.
pub(super) fn evidence(job: &Value, reply: &Value) -> Option<Value> {
    let name = machine_name(job);
    let base = |status: &str, reason: String| {
        json!({"jobId": job["id"], "attempt": job["attempt"], "status": status, "reason": reason, "evidence": reply})
    };
    let detail = reply["reason"].as_str().unwrap_or_default();
    // What holds the attempt's processes there, as a whole and in short.
    let (group, short) = if job["executor"]["kind"] == "windows" { ("Job Object", "Job Object") } else { ("process group", "group") };
    match reply["status"].as_str().unwrap_or_default() {
        "running" | "stopping" if job["executor"]["kind"] == "windows" => {
            let started = &reply["started"];
            let mut value = base("running", format!(
                "Running on {name} in its own Job Object (process {}); {}", started["pid"], limits_said(job, started)));
            value["started"] = json!({"at": started["startedAtUnix"], "pid": started["pid"], "jobObject": started["jobObject"],
                "bootId": started["bootId"], "limits": started["limits"]});
            Some(value)
        }
        "running" | "stopping" => {
            let started = &reply["started"];
            let mut value = base("running", format!(
                "Running on {name} in its own process group ({}); {}", started["pgid"], limits_said(job, started)));
            value["started"] = json!({"at": started["startedAtUnix"], "pgid": started["pgid"], "bootId": started["bootId"],
                "limits": started["limits"]});
            Some(value)
        }
        "terminal" => {
            let result = &reply["result"];
            let mut value = base(result["status"].as_str().unwrap_or("unknown"),
                result["reason"].as_str().unwrap_or_default().to_owned());
            value["finishedAtUnix"] = result["finishedAtUnix"].clone();
            // Checked on that machine after a clean exit, as for local jobs;
            // absent when they were not checked (a failure, a cancel).
            if let Some(artifacts) = result.get("artifacts") {
                value["artifacts"] = artifacts.clone();
                value["artifactsOn"] = json!({"machineId": job["executor"]["machineId"], "name": name,
                    "hostId": job["remote"]["hostId"]});
            }
            if let Some(started) = reply["started"].as_object() {
                value["started"] = if job["executor"]["kind"] == "windows" {
                    json!({"at": started.get("startedAtUnix"), "pid": started.get("pid"), "jobObject": started.get("jobObject"),
                        "limits": started.get("limits")})
                } else {
                    json!({"at": started.get("startedAtUnix"), "pgid": started.get("pgid"), "limits": started.get("limits")})
                };
            }
            Some(value)
        }
        "lost" => Some(base("unknown", format!(
            "The supervisor of this attempt on {name} is gone without an outcome; {}. Its slot stays held: cancel to stop what is left and release it.",
            match (reply["leaderAlive"] == true, reply["processes"].as_i64().unwrap_or_default()) {
                (true, _) => "its command is still running".to_owned(),
                (false, 0) => format!("nothing of its {group} is left, but its exit status was not recorded"),
                (false, n) => format!("its command has exited but {n} process(es) of its {short} are still running"),
            }))),
        "other_host" => Some(base("unknown", format!(
            "{name} now reaches a different machine than the one this attempt was started on, so it cannot be checked or stopped from here. Its state is unknown and its slot stays held until {name} reaches that machine again."))),
        "conflict" => Some(base("unknown", format!(
            "The attempt with this ID on {name} belongs to another request ({detail}); this job's state is unknown and its slot stays held."))),
        "unclear" => Some(base("unknown", format!(
            "This attempt's record on {name} is unclear ({detail}); its state is unknown and its slot stays held."))),
        // A fence never settles an attempt the machine had acknowledged.
        "absent" | "fenced" if job["remote"]["acknowledged"] == true => Some(base("unknown", format!(
            "This attempt's folder on {name} is gone although the machine had acknowledged it; its outcome is unknown and its slot stays held."))),
        "absent" => Some(base("unknown", format!(
            "This attempt's record on {name} is missing; its outcome is unknown and its slot stays held."))),
        "fenced" if job["cancelRequestedAt"].is_string() => {
            Some(base("cancelled", format!("Cancelled before it started on {name}; nothing was started there")))
        }
        "fenced" => Some(base("rejected", format!(
            "Not started on {name}: the start never reached it, and a late arrival is now refused. No process was created; submit again with a new requestId to retry."))),
        // starting, settling, busy: the next check settles it.
        _ => None,
    }
}

fn unanswered(job: &Value, error: &str) -> Value {
    // A stable reason: an unreachable machine is told once, not every check.
    json!({"jobId": job["id"], "attempt": job["attempt"], "status": "unknown",
        "reason": format!("{} did not answer; this attempt's state there is unknown and its slot stays held. Core checks the same attempt again when the machine answers and never starts it twice.", machine_name(job)),
        "evidence": {"coreObservation": true, "error": error}})
}

impl Store {
    /// Remote jobs that hold a slot or wait for one, oldest first.
    pub(super) fn remote_jobs(&self) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT id FROM local_jobs WHERE (reserved=1 OR status='queued')
             AND json_extract(data,'$.executor.kind') IN ('ssh','windows') ORDER BY seq",
        )?;
        let ids = q.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter().map(|id| get(&db, id)).collect()
    }
    /// Take a slot on the job's machine for this queued remote job, or say
    /// why it waits. The attempt is bound to its slot before it is started.
    pub(super) fn reserve_remote(&self, id: &str) -> Result<Option<Value>> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        if job["status"] != "queued" || !matches!(job["executor"]["kind"].as_str(), Some("ssh" | "windows")) {
            return Ok(None);
        }
        let machine = job["executor"]["machineId"].as_str().context("Missing machine")?.to_owned();
        let used: i64 = tx.query_row(
            "SELECT COUNT(*) FROM local_jobs WHERE reserved=1 AND json_extract(data,'$.executor.machineId')=?1",
            [&machine],
            |r| r.get(0),
        )?;
        // An SSH machine as registered now: its ceiling, budget and mode apply
        // to each attempt that takes a slot from here on. Windows has its own
        // ceiling, set in this host's Jobs settings, beside the shared budget.
        let settings = if job["executor"]["kind"] == SSH { machine_settings(&tx, &machine)? } else { None };
        let ceiling = if job["executor"]["kind"] == WINDOWS {
            super::store::windows_max_jobs(&tx)?
        } else {
            settings.as_ref().and_then(|m| m.max_jobs)
        }
        .map_or(SLOTS, i64::from);
        let need: super::Resources = serde_json::from_value(job["reservation"].clone())?;
        let mut wait = None;
        if used >= ceiling {
            wait = Some(format!("Waiting for a slot on {}: {used} of {ceiling} in use", machine_name(&job)));
        } else if job["executor"]["kind"] == WINDOWS {
            // Windows on this PC is the same physical machine as this host:
            // its jobs hold this host's budget beside the Linux jobs.
            let limit = budget(&tx, None)?;
            let (taken, _) = reserved(&tx)?;
            let free = limit.available(&taken);
            if !need.fits(&limit) {
                // Queued before submissions were checked against this budget
                // (an older Core), or the budget was lowered since: it waits
                // with the reason, not silently.
                wait = Some(format!(
                    "Cannot start under this PC's Jobs budget, which its Linux and Windows jobs share: needs {} mCPU / {} MiB RAM / {} MiB swap including collector, more than the whole budget of {} mCPU / {} MiB RAM / {} MiB swap. Raise the budget or cancel this job",
                    need.cpu_millis, need.memory_mi_b, need.swap_mi_b, limit.cpu_millis, limit.memory_mi_b, limit.swap_mi_b));
            } else if !need.fits(&free) {
                wait = Some(format!(
                    "Waiting for this PC's Jobs budget, which its Linux and Windows jobs share: needs {} mCPU / {} MiB RAM / {} MiB swap including collector; {} mCPU / {} MiB RAM / {} MiB swap free",
                    need.cpu_millis, need.memory_mi_b, need.swap_mi_b, free.cpu_millis, free.memory_mi_b, free.swap_mi_b));
            }
        } else if let Some(limit) = settings.as_ref().and_then(|m| m.budget.as_ref()) {
            // That host's own budget, held by the attempts reserved there.
            let taken = machine_reserved(&tx, &machine)?;
            let (cpu, memory) = (u64::from(limit.cpu_millis), u64::from(limit.memory_mib));
            let (free_cpu, free_memory) = (cpu.saturating_sub(taken.cpu_millis), memory.saturating_sub(taken.memory_mi_b));
            if need.cpu_millis > free_cpu || need.memory_mi_b > free_memory {
                wait = Some(format!(
                    "Waiting for {}'s Jobs budget: needs {} mCPU / {} MiB RAM including its supervisor; {free_cpu} mCPU / {free_memory} MiB RAM free of {cpu} mCPU / {memory} MiB RAM",
                    machine_name(&job), need.cpu_millis, need.memory_mi_b));
            }
        }
        if let Some(reason) = wait {
            if job["reason"] != reason.as_str() {
                job["reason"] = json!(reason);
                save(&tx, &job)?;
                tx.commit()?;
            }
            return Ok(None);
        }
        // A job bound at submit (prebind) keeps the mode it was bound with.
        if job["executor"]["kind"] == SSH && !job["remote"]["prebound"].is_object() {
            // Bound into this attempt's request (spec, digest): a later change
            // of the machine's mode is for later attempts. A machine without a
            // mode keeps the behaviour it had before limits (LEGACY).
            job["executor"]["limitMode"] =
                json!(settings.and_then(|m| m.limit_mode).unwrap_or_else(|| LEGACY.to_owned()));
        }
        job["reserved"] = json!(true);
        job["status"] = json!("starting");
        job["startedAt"] = json!(now());
        job["reason"] = json!(format!("Slot taken on {}; starting this attempt there", machine_name(&job)));
        save(&tx, &job)?;
        tx.commit()?;
        Ok(Some(job))
    }
    /// Record facts about this unfinished attempt on its machine, each once:
    /// a recorded fact is never replaced. `reason` replaces the reason of a
    /// job that is still starting.
    pub(super) fn remote_note(&self, id: &str, attempt: &Value, facts: Value, reason: Option<&str>) -> Result<Option<Value>> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut job = get(&tx, id)?;
        if job["reserved"] != true || &job["attempt"] != attempt {
            return Ok(None);
        }
        if !job["remote"].is_object() {
            job["remote"] = json!({});
        }
        for (key, value) in facts.as_object().into_iter().flatten() {
            if job["remote"][key].is_null() {
                job["remote"][key] = value.clone();
            }
        }
        if let Some(reason) = reason.filter(|_| job["status"] == "starting") {
            job["reason"] = json!(reason);
        }
        save(&tx, &job)?;
        tx.commit()?;
        Ok(Some(job))
    }
}

/// The remote executor's own loop: remote checks never hold up local
/// admission, and a slow machine never holds up the others. With no remote
/// job it reads nothing until a submission or cancellation wakes it, so an
/// idle executor adds no work in flight, also while Core drains for an update.
pub(super) fn start(ws: &Arc<Workspace>) {
    let weak: Weak<Workspace> = Arc::downgrade(ws);
    let wake = ws.jobs.remote_wake.clone();
    // Read once as Core starts, before it serves anything: a Core without
    // remote jobs to resume starts idle and reads nothing.
    let busy = ws.store.remote_jobs().map_or(true, |jobs| !jobs.is_empty());
    tokio::spawn(run(weak, wake, busy, |ws| async move {
        let helper = windows_helper();
        let programs = Programs { ssh: SSH, windows: helper.as_ref() };
        tick_with(&ws, &programs).await
    }));
}

/// The loop itself, over one pass (tick_with). A wake that arrives while a
/// pass runs (a submission, a cancel, a changed Windows setting) always gets
/// a pass of its own after it, even when that pass found nothing to do: the
/// pass may have read the jobs before the one that woke it was stored.
pub(super) async fn run<F, Fut>(weak: Weak<Workspace>, wake: Arc<tokio::sync::Notify>, mut busy: bool, mut pass: F)
where
    F: FnMut(Arc<Workspace>) -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    loop {
        if busy {
            let Some(ws) = weak.upgrade() else {
                break;
            };
            busy = pass(ws).await.unwrap_or_else(|error| {
                eprintln!("Remote jobs reconciliation: {error:#}");
                true
            });
            tokio::select! { _ = tokio::time::sleep(Duration::from_secs(3)) => {}, _ = wake.notified() => busy = true }
            continue;
        }
        tokio::select! {
            _ = wake.notified() => busy = true,
            // Only to end with its Workspace; nothing is read.
            _ = tokio::time::sleep(Duration::from_secs(60)) => if weak.strong_count() == 0 { break },
        }
    }
}

fn due(ws: &Workspace, job: &Value) -> bool {
    let id = job["id"].as_str().unwrap_or_default().to_owned();
    let mut seen = ws.jobs.remote_seen.lock().unwrap();
    if !job["cancelRequestedAt"].is_string() && seen.get(&id).is_some_and(|at| at.elapsed() < OBSERVE_EVERY) {
        return false;
    }
    seen.insert(id, Instant::now());
    true
}

/// One pass with one stand-in program for every transport (tests).
#[cfg(test)]
pub(super) async fn tick(ws: &Arc<Workspace>, program: &str) -> Result<bool> {
    let helper = WindowsHelper::trusting(program);
    tick_with(ws, &Programs { ssh: program, windows: Some(&helper) }).await
}

/// One pass over the remote jobs; false when there is none, so the loop
/// can wait to be woken instead.
pub(super) async fn tick_with(ws: &Arc<Workspace>, programs: &Programs<'_>) -> Result<bool> {
    let _gate = ws.jobs.remote_gate.lock().await;
    let jobs = ws.stored(|s| s.remote_jobs()).await?;
    if jobs.is_empty() {
        ws.jobs.remote_seen.lock().unwrap().clear();
        return Ok(false);
    }
    let Ok(_completion) = ws.admission.enter_completion() else {
        return Ok(true);
    };
    let checks = jobs
        .iter()
        .filter(|job| job["reserved"] == true && due(ws, job))
        .map(|job| observe(ws, job.clone(), programs));
    for result in futures_util::future::join_all(checks).await {
        if let Err(error) = result {
            eprintln!("Remote job check: {error:#}");
        }
    }
    // Starting new work stops while Core drains for an update.
    let Ok(_work) = ws.admission.enter_work() else {
        return Ok(true);
    };
    // Windows jobs hold this host's budget. One queued before any job here
    // stored it (a Workspace that never ran a local job, an older Core)
    // gets this host's suggested budget first, as a submission would.
    if jobs.iter().any(|job| job["status"] == "queued" && job["executor"]["kind"] == WINDOWS) {
        match super::host::machine_info().await {
            Ok(host) => {
                if let Err(error) = ws.stored(move |s| s.init_job_budget(&host["suggestedBudget"])).await {
                    eprintln!("Remote jobs: this host's Jobs budget could not be stored: {error:#}");
                }
            }
            Err(error) => eprintln!("Remote jobs: this host could not be read for its Jobs budget: {error:#}"),
        }
    }
    for job in jobs.iter().filter(|job| job["status"] == "queued") {
        let id = job["id"].as_str().unwrap_or_default().to_owned();
        // One job that cannot be reserved stays queued with its error logged;
        // the jobs after it are still reserved.
        let reserved = match ws.stored(move |s| s.reserve_remote(&id)).await {
            Ok(reserved) => reserved,
            Err(error) => {
                eprintln!("Remote job {}: {error:#}", job["id"].as_str().unwrap_or_default());
                continue;
            }
        };
        if let Some(job) = reserved {
            changed(ws);
            launch(ws, job, programs).await?;
        }
    }
    ws.jobs.remote_seen.lock().unwrap().retain(|id, _| jobs.iter().any(|j| j["id"] == id.as_str()));
    Ok(true)
}

async fn machine_of(ws: &Arc<Workspace>, job: &Value) -> Result<Machine> {
    if job["executor"]["kind"] == "windows" {
        return Ok(Machine::Windows);
    }
    let id = job["executor"]["machineId"].as_str().context("Missing machine")?.to_owned();
    ws.stored(move |s| s.machine(&id)).await.map(Machine::Ssh)
}

async fn record(ws: &Arc<Workspace>, job: &Value, evidence: Value) -> Result<()> {
    let id = job["id"].as_str().context("Missing job")?.to_owned();
    if ws.stored(move |s| s.update_job_evidence(&id, evidence)).await? {
        changed(ws);
    }
    Ok(())
}

async fn not_started(ws: &Arc<Workspace>, job: &Value, reason: String) -> Result<()> {
    let id = job["id"].as_str().context("Missing job")?.to_owned();
    if ws.stored(move |s| s.job_not_started(&id, &reason)).await? {
        changed(ws);
    }
    Ok(())
}

async fn note(ws: &Arc<Workspace>, job: &Value, facts: Value, reason: Option<String>) -> Result<Option<Value>> {
    let (id, attempt) = (job["id"].as_str().context("Missing job")?.to_owned(), job["attempt"].clone());
    let noted = ws.stored(move |s| s.remote_note(&id, &attempt, facts, reason.as_deref())).await?;
    changed(ws);
    Ok(noted)
}

async fn workspace_key(ws: &Arc<Workspace>) -> Result<String> {
    ws.stored(|s| s.workspace_id()).await
}

async fn observe(ws: &Arc<Workspace>, job: Value, programs: &Programs<'_>) -> Result<()> {
    if job["remote"]["startSentAt"].is_null() {
        // Nothing was sent to the machine yet: Core stopped before, or the
        // machine did not answer hello. Settling a cancellation needs no
        // machine; starting it is new work, which stops while Core drains
        // for an update.
        if job["cancelRequestedAt"].is_string() {
            return launch(ws, job, programs).await;
        }
        let Ok(_work) = ws.admission.enter_work() else {
            return Ok(());
        };
        return launch(ws, job, programs).await;
    }
    let Ok(machine) = machine_of(ws, &job).await else {
        let mut value = unanswered(&job, "machine not registered");
        value["reason"] = json!(format!(
            "{} is no longer registered; this attempt's state there is unknown and its slot stays held.",
            machine_name(&job)));
        return record(ws, &job, value).await;
    };
    let action = if job["cancelRequestedAt"].is_string() { "cancel" } else { "status" };
    let mut request = bound(&job, &workspace_key(ws).await?, action);
    // Until the machine has acknowledged the attempt, a check also makes a
    // start that never arrived final, so "not started" is certain.
    request["fence"] = json!(job["remote"]["acknowledged"] != true);
    match call(programs, &machine, request).await {
        Reply::Answer(reply) => answered(ws, &job, reply).await,
        Reply::Refused(message) => {
            let mut value = unanswered(&job, &message);
            value["reason"] = json!(format!(
                "{} refused to report this attempt: {message}. Its state is unknown and its slot stays held.",
                machine.name()));
            record(ws, &job, value).await
        }
        Reply::NoAnswer(error) | Reply::Broken(error) | Reply::Unusable(error) => record(ws, &job, unanswered(&job, &error)).await,
    }
}

async fn answered(ws: &Arc<Workspace>, job: &Value, reply: Value) -> Result<()> {
    let reply = from_pinned(job, reply);
    let status = reply["status"].as_str().unwrap_or_default();
    if ACKNOWLEDGING.contains(&status) && job["remote"]["acknowledged"] != true {
        note(ws, job, json!({"acknowledged": true, "acknowledgedAt": now()}), None).await?;
    }
    if let Some(value) = evidence(job, &reply) {
        record(ws, job, value).await?;
    }
    // Whether the attempt's own scope there is frozen, as the machine read it
    // from its cgroup: settles a pause or resume whose reply was lost, and
    // shows one made outside Yuzuno (pause.rs reconcile_remote_pause). The
    // user's pause or resume holds the jobs gate from its intent to its
    // answer, so this waits for one in progress, and a reading taken before
    // one changed the job is not applied (review R1).
    if matches!(status, "running" | "stopping") {
        if let Some(freezer) = reply.get("freezer").filter(|freezer| freezer.is_object()).cloned() {
            let _gate = ws.jobs.gate.lock().await;
            let seen = job.clone();
            if ws.stored(move |s| s.reconcile_remote_pause(&seen, &freezer)).await? {
                changed(ws);
            }
        }
    }
    Ok(())
}

/// Why this job cannot be paused, or None. A remote attempt can be paused
/// only when it runs in a scope of its own on its machine (its start's
/// evidence names the scope that holds its limits), which the helper freezes
/// after proving it is this attempt's; one without (a record-only machine, or
/// an account that does not linger) is never paused by other means.
pub(super) fn pause_refusal(job: &Value) -> Option<String> {
    let name = machine_name(job);
    match job["executor"]["kind"].as_str() {
        None => None,
        Some(SSH) if job["result"]["started"]["limits"]["held"]["unit"].is_string() => None,
        Some(SSH) => Some(format!(
            "Pause is not available for this job on {name}: it runs without a scope of its own there (no limits are held for it: a record-only machine, or an account that does not linger), and pause freezes only an attempt's own scope; nothing was changed")),
        Some(_) => Some(format!("Pause is not available for jobs on {name}: this executor has no pause, so nothing was changed")),
    }
}

/// The user's pause or resume of a remote attempt, as its machine answered:
/// {state, reason, evidence}, as host::control answers for local jobs. A lost
/// reply is unknown, settled later by what the machine reports (answered).
pub(super) async fn control(ws: &Arc<Workspace>, job: &Value, mode: &str) -> Value {
    control_with(ws, job, mode, &Programs { ssh: SSH, windows: None }).await
}

pub(super) async fn control_with(ws: &Arc<Workspace>, job: &Value, mode: &str, programs: &Programs<'_>) -> Value {
    let name = machine_name(job);
    let (done, not_done) = if mode == "pause" { ("paused", "notPaused") } else { ("resumed", "notResumed") };
    let unknown = |why: String| json!({"state": "unknown",
        "reason": format!("{name} did not confirm the {mode}: {why}. Whether it took hold is known when the machine answers again")});
    let machine = match machine_of(ws, job).await {
        Ok(machine) => machine,
        Err(error) => return json!({"state": not_done, "reason": format!("{name} is not registered now ({error:#}); nothing was {done}")}),
    };
    let workspace = match workspace_key(ws).await {
        Ok(key) => key,
        Err(error) => return json!({"state": not_done, "reason": format!("{error:#}; nothing was {done}")}),
    };
    match call(programs, &machine, bound(job, &workspace, mode)).await {
        Reply::Answer(reply) => {
            let reply = from_pinned(job, reply);
            match reply["status"].as_str().unwrap_or_default() {
                "control" if reply["state"].is_string() => json!({"state": reply["state"], "reason": reply["reason"],
                    "evidence": reply["evidence"]}),
                "other_host" => json!({"state": not_done,
                    "reason": format!("{name} now reaches a different machine; nothing was {done} there")}),
                "absent" | "conflict" => json!({"state": not_done,
                    "reason": format!("{name} has no record of this attempt ({}); nothing was {done}",
                        reply["reason"].as_str().unwrap_or("absent"))}),
                status => unknown(format!("it answered {status}")),
            }
        }
        // Refused before anything was done.
        Reply::Refused(message) => json!({"state": not_done, "reason": format!("{name} refused the {mode}: {message}")}),
        Reply::NoAnswer(error) | Reply::Broken(error) | Reply::Unusable(error) => unknown(error),
    }
}

async fn launch(ws: &Arc<Workspace>, job: Value, programs: &Programs<'_>) -> Result<()> {
    let id = job["id"].as_str().context("Missing job")?.to_owned();
    ws.jobs.remote_seen.lock().unwrap().insert(id, Instant::now());
    let name = machine_name(&job);
    if job["cancelRequestedAt"].is_string() {
        let reason = format!("Cancelled before it was started on {name}; nothing was sent there");
        return record(ws, &job, json!({"jobId": job["id"], "attempt": job["attempt"], "status": "cancelled",
            "reason": reason, "evidence": {"coreObservation": true}})).await;
    }
    let Ok(machine) = machine_of(ws, &job).await else {
        return not_started(ws, &job, format!("Not started: {name} is no longer registered")).await;
    };
    // Nothing has been sent yet: a job accepted for one SSH destination never
    // starts at another.
    if let Machine::Ssh(registered) = &machine {
        if job["machine"]["target"].as_str().is_some_and(|target| target != registered.target) {
            return not_started(ws, &job, format!(
                "Not started: {name}'s SSH destination changed after this job was submitted; nothing was sent there")).await;
        }
        // Bound at submit with the machine's mode then (prebind): a mode
        // changed since is neither applied by recomputing what was bound nor
        // ignored by running as bound.
        let mode = registered.limit_mode.as_deref().unwrap_or(LEGACY);
        if job["remote"]["prebound"].is_object() && job["executor"]["limitMode"].as_str() != Some(mode) {
            return not_started(ws, &job, format!(
                "Not started: {name}'s limits mode changed from {} to {mode} after this job was submitted, and its request was bound with the mode it had then; nothing was sent there. Submit it again to run it in the {mode} mode",
                job["executor"]["limitMode"].as_str().unwrap_or(LEGACY))).await;
        }
    }
    let mut job = job;
    if job["remote"]["hostId"].is_null() {
        // Pin the machine behind the name before anything can start there,
        // with the absolute root a start goes to.
        match call(programs, &machine, json!({"action": "hello", "root": new_root(&machine)})).await {
            // A Windows helper that speaks another protocol never gets a start.
            Reply::Answer(reply) if matches!(machine, Machine::Windows) && reply["status"] == "hello"
                && reply["protocol"] != WINDOWS_PROTOCOL =>
            {
                return not_started(ws, &job, format!(
                    "Not started on {}: its helper speaks protocol {}, and this Core needs {WINDOWS_PROTOCOL}; nothing was sent there",
                    machine.name(), reply["protocol"])).await;
            }
            // Inputs were frozen on the machine that answered at submit: the
            // name now reaching another never gets the start.
            Reply::Answer(reply) if reply["status"] == "hello" && job["snapshot"]["hostId"].is_string()
                && reply["hostId"] != job["snapshot"]["hostId"] =>
            {
                return not_started(ws, &job, format!(
                    "Not started on {}: it now reaches a different machine than the one its inputs were frozen on at submit; nothing was sent there",
                    machine.name())).await;
            }
            Reply::Answer(reply) if reply["status"] == "hello" && reply["hostId"].is_string() => {
                let mut facts = json!({"hostId": reply["hostId"], "helloBootId": reply["bootId"], "digest": digest(&spec(&job))});
                if let Some(root) = pinned_root(&machine, &reply) {
                    facts["root"] = json!(root);
                }
                // The helper Core checked and ran; what it says of itself is only reported.
                if let (Machine::Windows, Some(helper)) = (&machine, programs.windows) {
                    facts["helper"] = json!({"sha256": helper.sha256, "protocol": reply["protocol"],
                        "reportedSha256": reply["helperSha256"], "os": reply["os"]});
                }
                let Some(pinned) = note(ws, &job, facts, None).await? else {
                    return Ok(());
                };
                job = pinned;
            }
            Reply::Answer(_) => {
                return not_started(ws, &job, format!("Not started on {}: it did not identify itself", machine.name())).await;
            }
            Reply::Refused(message) => {
                return not_started(ws, &job, format!("Not started on {}: {message}", machine.name())).await;
            }
            // The machine cannot run the helper at all; hello starts nothing,
            // so this is final.
            Reply::Unusable(why) => {
                return not_started(ws, &job, format!("Not started on {}: {why}", machine.name())).await;
            }
            // Anything else may pass (a crash, a kill): ask again later.
            Reply::NoAnswer(error) | Reply::Broken(error) => {
                let reason = format!("Waiting for {} to answer before starting; nothing has been sent there yet ({error})", machine.name());
                note(ws, &job, json!({}), Some(reason)).await?;
                return Ok(());
            }
        }
    }
    // Bound at submit (prebind): what is sent must be what was bound then.
    if job["remote"]["prebound"].is_object() && job["remote"]["digest"].as_str() != Some(digest(&spec(&job)).as_str()) {
        return not_started(ws, &job, format!(
            "Not started on {}: its request no longer matches the one bound when it was submitted; nothing was sent there",
            machine.name())).await;
    }
    let workspace = workspace_key(ws).await?;
    // Recorded before the start leaves: from here on a missing answer is
    // unknown, never "not started", and the start is never sent again. The
    // root goes with it: every later request finds the attempt there.
    // A root older Cores do not know keeps them out of this Workspace until
    // the attempt ends (older_cores.rs), before the record that names it.
    let sent = now();
    let root = new_root(&machine);
    let why = (!crate::older_cores::legacy_root(matches!(machine, Machine::Windows), &root))
        .then(|| format!("a Job is started in {root} on {}", machine.name()));
    let (id, attempt) = (job["id"].as_str().context("Missing job")?.to_owned(), job["attempt"].clone());
    let facts = json!({"startSentAt": sent, "root": root});
    let noted = ws.stored(move |s| {
        let _kept_out = s.keep_older_cores_out_for(why)?;
        s.remote_note(&id, &attempt, facts, None)
    }).await?;
    changed(ws);
    let Some(job) = noted else {
        return Ok(());
    };
    if job["remote"]["startSentAt"] != sent.as_str() {
        // An earlier check already sent it.
        return Ok(());
    }
    let mut request = bound(&job, &workspace, "start");
    for (key, value) in spec(&job).as_object().into_iter().flatten() {
        request[key] = value.clone();
    }
    match call(programs, &machine, request).await {
        // Refused there before anything was written; the pinned machine never got it.
        Reply::Answer(reply) if reply["status"] == "other_host" => {
            not_started(ws, &job, format!(
                "Not started: {} reached a different machine than the one that answered a moment before; nothing was started",
                machine.name())).await
        }
        Reply::Answer(reply) => answered(ws, &job, reply).await,
        Reply::Refused(message) => not_started(ws, &job, format!("Not started on {}: {message}", machine.name())).await,
        // The helper may have failed after this attempt became real there.
        Reply::NoAnswer(error) | Reply::Broken(error) | Reply::Unusable(error) => {
            let mut value = unanswered(&job, &error);
            value["reason"] = json!(format!(
                "No acknowledgement from {} for this start: {error}. Core checks the same attempt there when the machine answers and never starts it twice; its slot stays held.",
                machine.name()));
            record(ws, &job, value).await
        }
    }
}

pub(super) async fn logs(ws: &Arc<Workspace>, job: &Value, offset: Option<u64>) -> Result<Value> {
    let helper = windows_helper();
    logs_with(ws, job, offset, &Programs { ssh: SSH, windows: helper.as_ref() }).await
}

pub(super) async fn logs_with(ws: &Arc<Workspace>, job: &Value, offset: Option<u64>, programs: &Programs<'_>) -> Result<Value> {
    if job["remote"]["startSentAt"].is_null() {
        return Ok(json!({"jobId": job["id"], "offset": 0, "nextOffset": 0, "oldestOffset": 0, "totalBytes": 0,
            "truncated": false, "text": "", "retainedBytesLimit": 2 * 1024 * 1024}));
    }
    let machine = machine_of(ws, job).await?;
    let mut request = bound(job, &workspace_key(ws).await?, "logs");
    request["offset"] = json!(offset);
    match call(programs, &machine, request).await {
        Reply::Answer(mut reply) if reply["status"] == "logs" && reply["hostId"] == job["remote"]["hostId"] => {
            if let Some(map) = reply.as_object_mut() {
                for key in ["status", "hostId", "bootId"] {
                    map.remove(key);
                }
            }
            Ok(reply)
        }
        Reply::Answer(reply) if reply["status"] == "conflict" => {
            anyhow::bail!("The output on {} belongs to another request with this attempt's ID", machine.name())
        }
        Reply::Answer(reply) if reply["status"] == "other_host" || reply["hostId"] != job["remote"]["hostId"] => anyhow::bail!(
            "The output could not be read: {} now reaches a different machine than the one this attempt was started on",
            machine.name()),
        Reply::Answer(reply) => anyhow::bail!(
            "The output on {} could not be read: {} {}",
            machine.name(),
            reply["status"].as_str().unwrap_or("no status"),
            reply["reason"].as_str().unwrap_or_default()),
        Reply::Refused(message) | Reply::NoAnswer(message) | Reply::Broken(message) | Reply::Unusable(message) => {
            anyhow::bail!("The output on {} could not be read: {message}", machine.name())
        }
    }
}

/// What a remote Job freezes at submit. Its inputs are files on its machine:
/// that machine's helper reads them there now (inspect, which writes
/// nothing) and they are frozen by SHA-256 with the machine that answered.
/// No path is ever resolved on this host (for Windows on this PC, nothing is
/// read through /mnt either: its native helper reads them). Any input that is
/// missing, not a regular file, unreadable or too large refuses the submit, as
/// does a machine that does not answer.
pub(super) async fn remote_snapshot(ws: &Arc<Workspace>, programs: &Programs<'_>, machine_id: &str, cwd: &str,
    inputs: &[String]) -> Result<Value> {
    if inputs.is_empty() {
        return Ok(json!({"cwd": cwd, "remote": true,
            "scope": "Nothing is frozen on the remote machine: Core does not see its files"}));
    }
    let (machine, frozen_on) = if machine_id == WINDOWS {
        (Machine::Windows, windows_snapshot())
    } else {
        let id = machine_id.to_owned();
        let machine = ws.stored(move |s| s.machine(&id)).await?;
        let frozen_on = machine_snapshot(&machine);
        (Machine::Ssh(machine), frozen_on)
    };
    let name = machine.name().to_owned();
    let windows = matches!(machine, Machine::Windows);
    // Nothing of the Store is held while the machine answers (at most 30
    // seconds, and the SSH process is ended with the call); the Job is
    // inserted after, only with the machine still registered as it was here
    // (store.rs create_job).
    let reply = match call(programs, &machine, json!({"action": "inspect", "cwd": cwd, "inputs": inputs})).await {
        Reply::Answer(reply) if reply["status"] == "inspected" && reply["hostId"].is_string() => reply,
        Reply::Answer(reply) => anyhow::bail!("The inputs could not be read on {name}, so nothing was submitted: {}",
            reply["status"].as_str().unwrap_or("no status")),
        Reply::Refused(message) | Reply::NoAnswer(message) | Reply::Broken(message) | Reply::Unusable(message) => {
            anyhow::bail!("The inputs could not be read on {name}, so nothing was submitted: {message}")
        }
    };
    let files = reply["files"].as_array().cloned().unwrap_or_default();
    let mut problems: Vec<String> = files
        .iter()
        .filter_map(|f| f["problem"].as_str().map(|why| format!("{}: {why}", f["path"].as_str().unwrap_or_default())))
        .collect();
    problems.extend(reply["problem"].as_str().map(str::to_owned));
    anyhow::ensure!(problems.is_empty(), "Inputs on {name} cannot be frozen, so nothing was submitted: {}", problems.join("; "));
    // One entry per input, in order, each a file there with its digest, at
    // that machine's own kind of absolute path (on Windows, the final path
    // Windows gave: a drive path, or a network one a mapped drive leads to).
    let absolute = |path: &str| if windows { windows_final_path(path) } else { path.starts_with('/') };
    let frozen = files.len() == inputs.len() && files.iter().zip(inputs).all(|(file, given)| {
        file["path"] == given.as_str() && file["absolutePath"].as_str().is_some_and(absolute)
            && file["sha256"].as_str().is_some_and(|sha| sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
    });
    anyhow::ensure!(frozen, "The inputs could not be read on {name}, so nothing was submitted: its reply does not name each input with its digest");
    Ok(json!({"cwd": cwd, "remote": true, "hostId": reply["hostId"], "frozenOn": frozen_on, "files": files, "totalBytes": reply["totalBytes"],
        "scope": format!("Inputs are files on {name}, frozen there by SHA-256 at submit with the machine that answered, and checked again there before the command runs. Nothing on this host is read for them")}))
}

/// A final path as Windows names a file: C:\... or \\server\share\...
fn windows_final_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    (drive || path.starts_with(r"\\") && !path.starts_with(r"\\?\") && !path.starts_with(r"\\.\"))
        && !path.chars().any(char::is_control)
}

/// What this executor can and cannot do, recorded with each remote job.
pub(super) fn capabilities() -> Value {
    json!({
        "executor": "ssh",
        "platform": "Linux",
        "limits": "Declared CPU, RAM and swap go with each attempt. Where the account's systemd user manager has the controllers, the helper holds memory (and CPU, where the cpu controller is delegated) in the attempt's own transient scope and reads them back before the command runs; swap only where the kernel accounts it, and nothing unless the account lingers (a scope of a user manager that may stop with the last session is not made). The machine's mode decides the rest: strict (a machine added now) starts nothing it cannot hold, limited runs and records what is only declared, and a machine registered before limits only records them, as before. Each attempt records what was held, and nothing limits the machine's own load",
        "slots": SLOTS,
        "admission": "Per machine: at most maxJobs attempts (2 unless set), within the machine's own budget when one is set; this host's budget is not used",
        "gpu": "unavailable",
        "pause": "Only for an attempt that runs in a scope of its own on that machine (its limits are held there: strict, or limited on an account that lingers): its scope is frozen through the account's systemd and read back from its cgroup, as for local jobs; its memory and the machine's reservation stay, and its timeout keeps counting. Otherwise unavailable, with the reason: nothing is stopped with signals instead",
        "inputs": "Files on that machine, frozen there by SHA-256 at submit and checked again there before the command runs; one that changed stops the start",
        "artifacts": "Checked on that machine after a clean exit, as for local jobs; recorded with path, size and SHA-256, and whether a file was already at the path before the command ran (noted, not judged: a file left there earlier passes if it meets the rules); never copied here",
        "outputs": "unavailable",
        "processes": "Cancel and timeouts stop the attempt's own process group, checking each process (boot, PID, start time) before signalling it. A process group is not a cgroup: a process that starts its own session or group leaves it and is not stopped",
        "bootId": null,
    })
}

/// The same for Windows on this PC.
pub(super) fn windows_capabilities() -> Value {
    json!({
        "executor": "windows",
        "platform": "Windows",
        "limits": "Declared CPU and RAM are held by the attempt's Job Object, read back before the command runs: a hard cap on its share of all this PC's processors, and a job-wide limit on committed memory (paging file included, not resident memory as a Linux cgroup counts: an allocation beyond it fails, nothing is killed)",
        "admission": "Windows and this WSL are one PC: a Windows attempt reserves from this host's Jobs budget beside its Linux jobs, and at most Windows' maxJobs attempts run at once (2 unless the user set 1–64 in this host's Jobs settings; only a ceiling, never extra budget)",
        "slots": SLOTS,
        "gpu": "unavailable",
        "pause": "unavailable",
        "inputs": "Files on this PC's Windows, read by the native helper there (never through /mnt): frozen by SHA-256 and their final path at submit, and checked again while the command is still suspended, before it runs; one that changed stops the start. A check before the start, not a read-only snapshot while it runs",
        "artifacts": "Checked by the native helper on Windows after a clean exit, by the same rules as local jobs (json and jsonl by a syntax check of its own that follows Python's json reading, with stated bounds: nesting deeper than 1000 levels or an integer of more than 4300 digits leaves the check not completed); recorded with the final path, size and SHA-256, and whether a file was already at the path; never copied here",
        "outputs": "unavailable",
        "processes": "Each attempt's command runs in its own Windows Job Object, which its child processes join; cancel and timeouts terminate that Job Object, and the outcome is written only once it holds no process. What is still in it 5 s after the command exits (Windows' console host closes by then) is stopped and reported",
        "bootId": null,
    })
}

/// What the built-in Windows machine is recorded as on a Job.
pub(super) fn windows_snapshot() -> Value {
    json!({"id": WINDOWS, "name": WINDOWS_NAME, "kind": "windows"})
}

/// The machine a remote Job is accepted for, with the SSH destination it was
/// registered with then.
pub(super) fn machine_snapshot(machine: &RemoteMachine) -> Value {
    json!({"id": machine.id, "name": machine.name, "kind": "ssh", "target": machine.target})
}

/// The SSH machine as registered now, read inside the caller's transaction.
pub(super) fn machine_settings(tx: &rusqlite::Connection, id: &str) -> Result<Option<RemoteMachine>> {
    use rusqlite::OptionalExtension;
    let raw: Option<String> = tx.query_row("SELECT data FROM machines WHERE id=?1", [id], |r| r.get(0)).optional()?;
    Ok(raw.map(|raw| serde_json::from_str(&raw)).transpose()?)
}

/// What the attempts holding a slot on this machine reserve of its budget.
fn machine_reserved(tx: &rusqlite::Connection, id: &str) -> Result<super::Resources> {
    let mut q = tx.prepare("SELECT data FROM local_jobs WHERE reserved=1 AND json_extract(data,'$.executor.machineId')=?1")?;
    let mut total = super::Resources::default();
    for row in q.query_map([id], |r| r.get::<_, String>(0))? {
        let value: Value = serde_json::from_str(&row?)?;
        total.add(&serde_json::from_value::<super::Resources>(value["reservation"].clone())?);
    }
    Ok(total)
}

/// The registered machine read inside the caller's transaction (see
/// Store::create_job), or the refusal when it is not registered.
pub(super) fn registered_machine(tx: &rusqlite::Connection, id: &str) -> Result<Value> {
    use rusqlite::OptionalExtension;
    if id == WINDOWS {
        // Tests drive it with a stand-in for the Windows helper on any host.
        anyhow::ensure!(cfg!(test) || windows_available(),
            "machineId windows is Windows on the PC this Core's WSL runs on; this Core does not run in WSL with Windows interop on");
        return Ok(windows_snapshot());
    }
    let raw: Option<String> = tx
        .query_row("SELECT data FROM machines WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    let machine: RemoteMachine =
        serde_json::from_str(&raw.context("machineId is not a registered SSH machine of this Workspace")?)?;
    Ok(machine_snapshot(&machine))
}
