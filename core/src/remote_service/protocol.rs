//! What Core accepts from one remote session, and what an ended session's
//! exit means (design v4 A2 and A3; YN-83 S1 PR4a).
//!
//! Pure functions only: a line, or the facts of an exit, in; a checked value
//! or a typed code out. Values from the remote end are for display: nothing
//! here puts them into a command, a path or an admission decision, and no
//! remote text or stderr leaves this module, only codes and bounded values.
//! Unknown fields are ignored; a known field of the wrong type, or a value
//! outside what it may be, is `protocol`. Numbers are clipped to their
//! range, and a value the remote left out or sent as null stays unknown,
//! never 0.
#![cfg_attr(not(test), allow(dead_code))]

use crate::jobs::{unusable_python, UnusablePython};
use serde_json::{Map, Value};
use std::time::Duration;

/// A marked boot line starts with this, the session's nonce and a space.
pub(crate) const MARK: &str = "YUZUNO-REMOTE ";
pub(crate) const PROTOCOL: u64 = 1;
/// Ages and windows beyond an hour are an hour: far past every staleness
/// limit (6 s for CPU and memory, 15 s for disks), so nothing is lost.
const MAX_MS: f64 = 3_600_000.0;
/// 2^40 MiB is an exbibyte: far above any machine, still exact in an f64.
const MAX_MIB: f64 = 1_099_511_627_776.0;
const MAX_CORES: f64 = 65_536.0;
/// The program samples one root in S1 and at most four paths at once
/// (program.py DISK_READS).
const MAX_DISKS: usize = 4;
const MAX_TOKENS: usize = 32;
const MAX_TOKEN: usize = 64;
const MAX_BOOT_ID: usize = 64;

/// Why a session cannot go on, as a stable code. Only `ssh_unreachable`
/// lets a caller back off and start again by itself (see `After`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Code {
    SshAuth,
    SshHostKey,
    SshUnreachable,
    SshFailed,
    NoPython,
    PythonTooOld,
    PythonStandIn,
    BadRequest,
    UnsupportedPlatform,
    RootUnsafe,
    UploadShort,
    UploadMismatch,
    BootTimeout,
    BootInternal,
    /// A refusal from the boot step with a code this Core does not know.
    BootError,
    Version,
    Protocol,
    UncleanExit,
}

impl Code {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Code::SshAuth => "ssh_auth",
            Code::SshHostKey => "ssh_host_key",
            Code::SshUnreachable => "ssh_unreachable",
            Code::SshFailed => "ssh_failed",
            Code::NoPython => "no_python",
            Code::PythonTooOld => "python_too_old",
            Code::PythonStandIn => "python_stand_in",
            Code::BadRequest => "bad_request",
            Code::UnsupportedPlatform => "unsupported_platform",
            Code::RootUnsafe => "root_unsafe",
            Code::UploadShort => "upload_short",
            Code::UploadMismatch => "upload_mismatch",
            Code::BootTimeout => "boot_timeout",
            Code::BootInternal => "boot_internal",
            Code::BootError => "boot_error",
            Code::Version => "version",
            Code::Protocol => "protocol",
            Code::UncleanExit => "unclean_exit",
        }
    }

    fn after(self) -> After {
        if self == Code::SshUnreachable {
            After::Backoff
        } else {
            After::Stop
        }
    }
}

/// What a caller may do once a session has ended. The transport only says
/// so; it never starts another session itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum After {
    /// The exit was proven clean: a later interest may start a new session.
    Clean,
    /// OpenSSH said only that it could not connect or resolve the host, and
    /// nothing ran there: a caller may try again after a backoff.
    Backoff,
    /// No new session without someone's action (a check, a changed record).
    Stop,
}

fn boot_code(given: &str) -> Code {
    match given {
        "bad_request" => Code::BadRequest,
        "python_too_old" => Code::PythonTooOld,
        "unsupported_platform" => Code::UnsupportedPlatform,
        "root_unsafe" => Code::RootUnsafe,
        "upload_short" => Code::UploadShort,
        "upload_mismatch" => Code::UploadMismatch,
        "timeout" => Code::BootTimeout,
        "internal" => Code::BootInternal,
        _ => Code::BootError,
    }
}

/// One stdout line before the hello.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BootLine {
    Need,
    Ready,
    Refused(Code),
    /// Not marked with this session's nonce: login noise, or a forged line.
    Noise,
    /// Marked with this nonce, but not a line the boot step writes.
    Invalid,
}

pub(crate) fn boot_line(line: &[u8], nonce: &str) -> BootLine {
    let Some(rest) = line
        .strip_prefix(MARK.as_bytes())
        .and_then(|rest| rest.strip_prefix(nonce.as_bytes()))
        .and_then(|rest| rest.strip_prefix(b" "))
    else {
        return BootLine::Noise;
    };
    let Ok(Value::Object(line)) = serde_json::from_slice::<Value>(rest) else {
        return BootLine::Invalid;
    };
    if line.get("need") == Some(&Value::Bool(true)) {
        BootLine::Need
    } else if line.get("ready") == Some(&Value::Bool(true)) {
        BootLine::Ready
    } else if let Some(Value::Object(error)) = line.get("error") {
        BootLine::Refused(boot_code(error.get("code").and_then(Value::as_str).unwrap_or_default()))
    } else {
        BootLine::Invalid
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    Linux,
    Darwin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CpuSource {
    ProcStat,
    Mach,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemorySource {
    Meminfo,
    /// free + speculative + inactive pages: an estimate.
    DarwinFreeInactive,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Hello {
    pub session_id: String,
    pub host_id: Option<String>,
    pub boot_id: Option<String>,
    pub account_key: Option<String>,
    pub platform: Platform,
    pub python: String,
    pub cpu: Option<CpuSource>,
    pub memory: Option<MemorySource>,
    pub why: Vec<String>,
}

/// The first frame after `ready`. `version` when it is not this Core's
/// protocol and program digest.
pub(crate) fn hello(line: &[u8], digest: &str) -> Result<Hello, Code> {
    let frame = object(line)?;
    if frame.get("ev").and_then(Value::as_str) != Some("hello") {
        return Err(Code::Protocol);
    }
    let data = map(frame.get("data"))?;
    if data.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL)
        || data.get("version").and_then(Value::as_str) != Some(digest)
    {
        return Err(Code::Version);
    }
    let platform = match data.get("platform").and_then(Value::as_str) {
        Some("Linux") => Platform::Linux,
        Some("Darwin") => Platform::Darwin,
        _ => return Err(Code::Protocol),
    };
    let load = map(data.get("load"))?;
    let cpu = match load.get("cpu") {
        None | Some(Value::Null) => None,
        Some(value) => Some(match value.as_str() {
            Some("proc-stat") => CpuSource::ProcStat,
            Some("mach") => CpuSource::Mach,
            _ => return Err(Code::Protocol),
        }),
    };
    let memory = match load.get("memory") {
        None | Some(Value::Null) => None,
        Some(value) => Some(memory_source(value)?),
    };
    if load.get("disk").and_then(Value::as_str) != Some("statvfs") {
        return Err(Code::Protocol);
    }
    Ok(Hello {
        session_id: hex(data.get("sessionId"), 32)?,
        host_id: nullable(data.get("hostId"), |value| hex(Some(value), 32))?,
        boot_id: nullable(data.get("bootId"), printable)?,
        account_key: nullable(data.get("accountKey"), |value| hex(Some(value), 32))?,
        platform,
        python: python(data.get("python"))?,
        cpu,
        memory,
        why: tokens(load.get("why"))?,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Cpu {
    /// Busy share of all CPUs, 0–100.
    pub pct: f64,
    pub cores: Option<u32>,
    pub window_ms: u64,
    /// How old the sample was when the frame was written.
    pub age: Duration,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Memory {
    pub total_mib: f64,
    pub used_mib: f64,
    pub available_mib: f64,
    pub measure: MemorySource,
    pub age: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    Root,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Space {
    Known { total_mib: f64, available_mib: f64, age: Duration },
    /// The read failed with this code; `permanent` when it will not pass by
    /// itself (no such folder, no permission).
    Error { code: String, permanent: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Disk {
    pub roles: Vec<Role>,
    pub space: Space,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Load {
    pub cpu: Option<Cpu>,
    pub memory: Option<Memory>,
    pub disks: Vec<Disk>,
    pub why: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Bye {
    pub code: u8,
    pub clean: bool,
    pub why: Vec<String>,
}

/// A frame after the hello.
#[derive(Debug, PartialEq)]
pub(crate) enum Frame {
    Load(Load),
    Bye(Bye),
    /// An answer to one of Core's requests: it only shows the session lives.
    Reply,
    /// An event this Core does not know.
    Other,
}

pub(crate) fn frame(line: &[u8]) -> Result<Frame, Code> {
    let frame = object(line)?;
    if let Some(event) = frame.get("ev") {
        return match event.as_str() {
            Some("load") => Ok(Frame::Load(load(map(frame.get("data"))?)?)),
            Some("bye") => Ok(Frame::Bye(bye(map(frame.get("data"))?)?)),
            Some("hello") | None => Err(Code::Protocol),
            Some(_) => Ok(Frame::Other),
        };
    }
    if frame.get("re").is_some_and(Value::is_u64) {
        return match (frame.get("ok"), frame.get("err")) {
            (Some(Value::Object(_)), None) | (None, Some(Value::Object(_))) => Ok(Frame::Reply),
            _ => Err(Code::Protocol),
        };
    }
    Err(Code::Protocol)
}

fn load(data: &Map<String, Value>) -> Result<Load, Code> {
    let cpu = match data.get("cpu") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let cpu = map(Some(value))?;
            Some(Cpu {
                pct: number(cpu, "pct", 100.0)?,
                cores: match cpu.get("cores") {
                    None | Some(Value::Null) => None,
                    Some(_) => Some(number(cpu, "cores", MAX_CORES)?.max(1.0) as u32),
                },
                window_ms: number(cpu, "windowMs", MAX_MS)? as u64,
                age: age(cpu)?,
            })
        }
    };
    let memory = match data.get("memory") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let memory = map(Some(value))?;
            let total = number(memory, "totalMiB", MAX_MIB)?;
            Some(Memory {
                total_mib: total,
                used_mib: number(memory, "usedMiB", MAX_MIB)?.min(total),
                available_mib: number(memory, "availableMiB", MAX_MIB)?.min(total),
                measure: memory_source(memory.get("measure").unwrap_or(&Value::Null))?,
                age: age(memory)?,
            })
        }
    };
    let Some(Value::Array(rows)) = data.get("disks") else {
        return Err(Code::Protocol);
    };
    if rows.is_empty() || rows.len() > MAX_DISKS {
        return Err(Code::Protocol);
    }
    let disks = rows.iter().map(disk).collect::<Result<_, _>>()?;
    Ok(Load { cpu, memory, disks, why: tokens(data.get("why"))? })
}

fn disk(row: &Value) -> Result<Disk, Code> {
    let row = map(Some(row))?;
    let Some(Value::Array(given)) = row.get("roles") else {
        return Err(Code::Protocol);
    };
    if given.is_empty() || given.len() > MAX_DISKS {
        return Err(Code::Protocol);
    }
    let roles = given
        .iter()
        .map(|role| match role.as_str() {
            Some("root") => Ok(Role::Root),
            _ => Err(Code::Protocol),
        })
        .collect::<Result<_, _>>()?;
    let space = match row.get("error") {
        Some(code) => Space::Error {
            code: token(code)?,
            permanent: row.get("permanent").and_then(Value::as_bool).ok_or(Code::Protocol)?,
        },
        None => {
            let total = number(row, "totalMiB", MAX_MIB)?;
            Space::Known { total_mib: total, available_mib: number(row, "availableMiB", MAX_MIB)?.min(total), age: age(row)? }
        }
    };
    Ok(Disk { roles, space })
}

fn bye(data: &Map<String, Value>) -> Result<Bye, Code> {
    let code = data.get("code").and_then(Value::as_u64).filter(|code| *code <= 255).ok_or(Code::Protocol)?;
    let clean = data.get("clean").and_then(Value::as_bool).ok_or(Code::Protocol)?;
    Ok(Bye { code: code as u8, clean, why: tokens(data.get("why"))? })
}

fn object(line: &[u8]) -> Result<Map<String, Value>, Code> {
    match serde_json::from_slice::<Value>(line) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(Code::Protocol),
    }
}

fn map(value: Option<&Value>) -> Result<&Map<String, Value>, Code> {
    value.and_then(Value::as_object).ok_or(Code::Protocol)
}

/// A number in [0, max]: present and numeric, or `protocol`.
fn number(map: &Map<String, Value>, key: &str, max: f64) -> Result<f64, Code> {
    let value = map.get(key).and_then(Value::as_f64).ok_or(Code::Protocol)?;
    Ok(value.clamp(0.0, max))
}

fn age(map: &Map<String, Value>) -> Result<Duration, Code> {
    Ok(Duration::from_millis(number(map, "ageMs", MAX_MS)? as u64))
}

fn memory_source(value: &Value) -> Result<MemorySource, Code> {
    match value.as_str() {
        Some("meminfo") => Ok(MemorySource::Meminfo),
        Some("darwin-free+inactive") => Ok(MemorySource::DarwinFreeInactive),
        _ => Err(Code::Protocol),
    }
}

fn nullable(value: Option<&Value>, check: impl Fn(&Value) -> Result<String, Code>) -> Result<Option<String>, Code> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => check(value).map(Some),
    }
}

/// Exactly `length` lowercase hexadecimal digits.
fn hex(value: Option<&Value>, length: usize) -> Result<String, Code> {
    match value.and_then(Value::as_str) {
        Some(text) if text.len() == length && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) => Ok(text.to_owned()),
        _ => Err(Code::Protocol),
    }
}

/// 1–64 printable ASCII characters.
fn printable(value: &Value) -> Result<String, Code> {
    match value.as_str() {
        Some(text) if !text.is_empty() && text.len() <= MAX_BOOT_ID && text.bytes().all(|b| (0x20..0x7f).contains(&b)) => {
            Ok(text.to_owned())
        }
        _ => Err(Code::Protocol),
    }
}

/// `3.x.y`, each part of up to three digits.
fn python(value: Option<&Value>) -> Result<String, Code> {
    let text = value.and_then(Value::as_str).ok_or(Code::Protocol)?;
    let parts: Vec<&str> = text.split('.').collect();
    let digits = |part: &str| (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    if parts.len() == 3 && parts[0] == "3" && digits(parts[1]) && digits(parts[2]) {
        Ok(text.to_owned())
    } else {
        Err(Code::Protocol)
    }
}

/// A short code such as `gpu:not_enabled` or `read_pending`.
fn token(value: &Value) -> Result<String, Code> {
    match value.as_str() {
        Some(text)
            if !text.is_empty()
                && text.len() <= MAX_TOKEN
                && text.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b':' | b'+' | b'.' | b'-')) =>
        {
            Ok(text.to_owned())
        }
        _ => Err(Code::Protocol),
    }
}

fn tokens(value: Option<&Value>) -> Result<Vec<String>, Code> {
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= MAX_TOKENS => items.iter().map(token).collect(),
        Some(_) => Err(Code::Protocol),
    }
}

/// The start of stderr: its first bytes, whether more came, and whether it
/// was read to its end.
#[derive(Clone, Debug, Default)]
pub(crate) struct Stderr {
    pub head: Vec<u8>,
    pub truncated: bool,
    pub complete: bool,
}

/// How the OpenSSH child ended, as far as Core saw it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exit {
    Code(i32),
    Signal,
    /// Not reaped yet: the reaper still holds it (see link::ReapGate).
    Unknown,
    /// OpenSSH could not be started at all.
    NoChild,
}

/// Everything the classification looks at.
pub(crate) struct Facts<'a> {
    /// `protocol` or `version`, when Core found the session's output wrong.
    pub detected: Option<Code>,
    pub exit: Exit,
    /// Any stdout byte at all: the remote shell may have run something.
    pub stdout_seen: bool,
    /// The boot step's marked refusal.
    pub refused: Option<Code>,
    /// A bye with `clean: true` arrived.
    pub bye_clean: bool,
    /// stdout was read to its end.
    pub eof: bool,
    pub stderr: &'a Stderr,
}

/// Design v4 A2's table, in its order. Clean only when all three hold: a
/// clean bye, stdout read to its end, and OpenSSH's exit 0. Only a 255 with
/// nothing on stdout and a complete stderr whose every line is a connect or
/// DNS failure may back off; everything else stops.
pub(crate) fn classify(facts: &Facts<'_>) -> (After, Option<Code>) {
    if let Some(code) = facts.detected {
        return (After::Stop, Some(code));
    }
    if facts.bye_clean && facts.eof && facts.exit == Exit::Code(0) {
        return (After::Clean, None);
    }
    let text = String::from_utf8_lossy(&facts.stderr.head);
    let code = match facts.exit {
        Exit::Code(255) => {
            if text.contains("Permission denied") || text.contains("Too many authentication failures") {
                Code::SshAuth
            } else if text.contains("Host key verification failed") || text.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
                Code::SshHostKey
            } else if !facts.stdout_seen && connect_failure_only(facts.stderr) {
                Code::SshUnreachable
            } else {
                Code::SshFailed
            }
        }
        // A marked refusal counts only with the boot step's own exit 3.
        Exit::Code(3) => facts.refused.unwrap_or(Code::UncleanExit),
        // 0 is the program's own exit; as Jobs reads them, only other exits
        // can be the shell's or Python's (jobs::remote::parse_reply).
        Exit::Code(code) if code != 0 => match unusable_python(code, &text) {
            Some(UnusablePython::Missing) => Code::NoPython,
            Some(UnusablePython::TooOld) => Code::PythonTooOld,
            Some(UnusablePython::StandIn) => Code::PythonStandIn,
            None => Code::UncleanExit,
        },
        _ => Code::UncleanExit,
    };
    (code.after(), Some(code))
}

/// OpenSSH's own line when connect(2) or getaddrinfo failed, before any SSH
/// connection: `ssh: connect to host <host> port <port>: <reason>` or
/// `ssh: Could not resolve hostname <host>: <reason>`, the reason being
/// glibc's or macOS's text. Nothing ran there and no login was tried.
/// `kex_exchange_identification`, `Connection closed by` and `Connection
/// reset by peer` come after a TCP connection and are not on it.
const CONNECT: [&str; 6] = [
    "Connection refused",
    "Connection timed out",
    "Operation timed out",
    "No route to host",
    "Network is unreachable",
    "Host is down",
];
const RESOLVE: [&str; 4] = [
    "Name or service not known",
    "Temporary failure in name resolution",
    "No address associated with hostname",
    "nodename nor servname provided, or not known",
];

/// True when stderr was read whole, was not cut, has at least one line, and
/// every line that is not empty is one of those two, exactly.
pub(crate) fn connect_failure_only(stderr: &Stderr) -> bool {
    if stderr.truncated || !stderr.complete {
        return false;
    }
    let Ok(text) = std::str::from_utf8(&stderr.head) else {
        return false;
    };
    let mut lines = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).filter(|line| !line.is_empty()).peekable();
    lines.peek().is_some() && lines.all(connect_failure)
}

fn connect_failure(line: &str) -> bool {
    let host = |host: &str| !host.is_empty() && host.len() <= 255 && host.bytes().all(|b| b.is_ascii_graphic());
    if let Some(rest) = line.strip_prefix("ssh: connect to host ") {
        let Some((name, rest)) = rest.split_once(" port ") else {
            return false;
        };
        let Some((port, reason)) = rest.split_once(": ") else {
            return false;
        };
        return host(name) && (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit()) && CONNECT.contains(&reason);
    }
    if let Some(rest) = line.strip_prefix("ssh: Could not resolve hostname ") {
        let Some((name, reason)) = rest.split_once(": ") else {
            return false;
        };
        return host(name) && RESOLVE.contains(&reason);
    }
    false
}
