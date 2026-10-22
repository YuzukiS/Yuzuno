//! A Codex Agent's working-folder diff (T-29 `/diff`): what Codex 0.162.1's
//! CLI `/diff` shows — the working tree against the index, then each
//! untracked file — plus the names of staged changes, which that view leaves
//! out. Read on the machine where the Agent's Codex runs, through the
//! app-server's own `command/exec` on the Agent's current connection, as the
//! CLI itself reads it; nothing is connected or resumed for it, and nothing
//! is sent to the model.
//!
//! Only a fixed sequence of Git commands runs, in the Agent's folder, under a
//! read-only sandbox, with what the CLI disables (hooks, a configured
//! fsmonitor helper, external diff, textconv, filter drivers) and more:
//! variables that would point Git elsewhere or add configuration are unset,
//! and optional locks are off.
//!
//! Bounded: every command's output is streamed with a cap one byte above its
//! limit, so reaching the cap is known exactly (Codex does not stop a capped
//! process, so Yuzuno terminates it); the whole read has one time budget.
//! Measured on 0.162.1 (T-29 probe 109dae93): a buffered capped result is
//! re-decoded as a legacy encoding when the cap splits a character, and
//! carries no truncation flag, so it is not used.
use crate::{
    rpc::{Rpc, RpcError},
    server::ApiError,
    updates::events::EventBarrier,
    workspace::{Connection, Workspace},
};
use anyhow::Result;
use axum::{
    extract::{Path, Query, State as ApiState},
    routing::get,
    Json, Router,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

/// Limits of one read, adjustable by tests.
#[derive(Clone, Debug)]
pub(crate) struct Limits {
    /// Tracked changes (`git diff`).
    pub tracked: usize,
    /// Each untracked file's diff.
    pub untracked_each: usize,
    /// Untracked files whose content is read.
    pub untracked_files: usize,
    /// Untracked and staged names kept.
    pub names: usize,
    /// The lists' own output (`ls-files`, `diff --cached --name-status`).
    pub list: usize,
    /// Everything kept, diagnostics and lists included.
    pub total: usize,
    /// The whole read, every command included.
    pub budget: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            tracked: 2 * 1024 * 1024,
            untracked_each: 256 * 1024,
            untracked_files: 100,
            names: 1000,
            list: 256 * 1024,
            total: 4 * 1024 * 1024,
            budget: Duration::from_secs(30),
        }
    }
}

/// Small outputs: `rev-parse`, the filter configuration.
pub(crate) const SMALL: usize = 64 * 1024;
/// Of a command's stderr, what is kept to say why it failed.
const STDERR_KEPT: usize = 4 * 1024;
/// A command is not started with less time than this left.
const MIN_COMMAND: Duration = Duration::from_millis(300);
/// After Codex's own timeout, how long its answer may take to arrive.
const ANSWER_GRACE: Duration = Duration::from_secs(3);
const MAX_TOKEN: usize = 64;

/// Git configuration given on every command line.
const HARDENING: [&str; 6] = [
    "-c", "safe.bareRepository=explicit",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
];
/// Diff options that keep Git from running configured helpers, and keep its
/// output in one form whatever the user's diff settings (a/ and b/ names,
/// paths from the repository's top).
const DIFF_FLAGS: [&str; 8] = ["--no-textconv", "--no-ext-diff", "--submodule=short", "--ignore-submodules=dirty", "--no-color",
    "--src-prefix=a/", "--dst-prefix=b/", "--no-relative"];
/// Variables that would point Git at another repository or index, add
/// configuration, run a diff helper or write traces: unset for every command.
const UNSET: [&str; 14] = [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG", "GIT_EXTERNAL_DIFF",
    "GIT_ATTR_SOURCE", "GIT_TRACE", "GIT_TRACE2", "GIT_TRACE2_EVENT",
];

/// One streamed command's output as it arrives (`command/exec/outputDelta`).
#[derive(Default)]
struct Stream {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_cap: usize,
    /// More than `stdout_cap` bytes came, or Codex reported its cap
    /// (`stdout_cap` + 1) reached: there was more.
    stdout_full: bool,
    notify: Arc<Notify>,
}

/// The running read of one Agent: its request token and connection.
pub(crate) struct Running {
    token: String,
    /// The connection the read runs on: cancelling it acts there only.
    rpc: Arc<Rpc>,
    cancelled: AtomicBool,
    /// The command now running, to terminate on cancel.
    current: Mutex<Option<String>>,
    wake: Notify,
}

impl Running {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(process) = self.current.lock().unwrap().clone() {
            terminate(&self.rpc, process);
        }
        self.wake.notify_waiters();
    }
}

#[derive(Default)]
pub(crate) struct State {
    /// Keyed by Agent, connection generation and processId: a late delta of
    /// another connection or read finds nothing.
    streams: Mutex<HashMap<(String, u64, String), Stream>>,
    reads: Mutex<HashMap<String, Arc<Running>>>,
    pub(crate) limits: Mutex<Limits>,
}

impl State {
    /// One `command/exec/outputDelta` of connection `generation`.
    pub(crate) fn deliver(&self, id: &str, generation: u64, p: &Value) {
        let Some(process) = p["processId"].as_str() else { return };
        let mut streams = self.streams.lock().unwrap();
        let Some(stream) = streams.get_mut(&(id.to_owned(), generation, process.to_owned())) else { return };
        let bytes = base64::engine::general_purpose::STANDARD.decode(p["deltaBase64"].as_str().unwrap_or_default()).unwrap_or_default();
        let full = p["capReached"] == true;
        match p["stream"].as_str() {
            Some("stdout") => {
                let room = stream.stdout_cap.saturating_sub(stream.stdout.len());
                // Counted here too: whether Codex flags an output of exactly its cap is not relied on.
                let over = bytes.len() > room;
                stream.stdout.extend_from_slice(&bytes[..bytes.len().min(room)]);
                if (full || over) && !stream.stdout_full {
                    stream.stdout_full = true;
                    stream.notify.notify_one();
                }
            }
            Some("stderr") => {
                let room = STDERR_KEPT.saturating_sub(stream.stderr.len());
                stream.stderr.extend_from_slice(&bytes[..bytes.len().min(room)]);
            }
            _ => {}
        }
    }

    /// Cancels the Agent's running read if `token` is its own.
    pub(crate) fn cancel(&self, id: &str, token: &str) -> bool {
        let running = self.reads.lock().unwrap().get(id).filter(|r| r.token == token).cloned();
        running.map(|r| r.cancel()).is_some()
    }
}

fn terminate(rpc: &Arc<Rpc>, process: String) {
    let rpc = rpc.clone();
    tokio::spawn(async move {
        let _ = rpc.request_within("command/exec/terminate", json!({"processId":process}), Duration::from_secs(5)).await;
    });
}

/// Text as Git wrote it: a cut multi-byte character at the end of a capped
/// output is left out; bytes that are not UTF-8 show as U+FFFD, and say so.
fn text(mut bytes: Vec<u8>, capped: bool) -> (String, bool) {
    if capped {
        if let Err(error) = std::str::from_utf8(&bytes) {
            if error.error_len().is_none() {
                bytes.truncate(error.valid_up_to());
            }
        }
    }
    match String::from_utf8(bytes) {
        Ok(text) => (text, false),
        Err(error) => (String::from_utf8_lossy(error.as_bytes()).into_owned(), true),
    }
}

/// One part of the diff as read: the text kept, whether it is all of it.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    text: String,
    complete: bool,
    /// Bytes that are not UTF-8 are shown as U+FFFD.
    not_utf8: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedEntry {
    /// Git's status letter, with a rename's or copy's score (R100).
    status: String,
    path: String,
    /// A rename's or copy's source.
    from: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    entries: Vec<StagedEntry>,
    complete: bool,
    /// Git could not list them: its words, or timeout. Not an empty list.
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UntrackedFile {
    path: String,
    /// The file as an addition; None when not read.
    diff: Option<Part>,
    /// Why it was not read: nested_repository, limit, total, stopped; or
    /// the error Git gave for it.
    not_read: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Untracked {
    files: Vec<UntrackedFile>,
    /// Every untracked name was listed (none left out by the list's limits).
    listed_all: bool,
    /// Git could not list them: its words, or timeout. Not an empty list.
    error: Option<String>,
}

/// The `/diff` read: what Git said in the Agent's folder, within the limits.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// read, not_repository, unavailable, failed, cancelled or busy.
    state: &'static str,
    reason: String,
    /// Git's or Codex's own words, shortened.
    detail: Option<String>,
    generation: Option<u64>,
    cwd: Option<String>,
    tracked: Option<Part>,
    staged: Option<Staged>,
    untracked: Option<Untracked>,
    /// Every part read whole, nothing left out or stopped.
    complete: bool,
    /// Why the read ended early: budget, total, cancelled or connection.
    stopped: Option<String>,
    bytes: usize,
    commands: usize,
    elapsed_ms: u64,
}

impl Report {
    fn not(state: &'static str, reason: &str) -> Self {
        Self { state, reason: reason.into(), ..Default::default() }
    }
}

/// Why a command did not give its output.
#[derive(Debug)]
enum Stop {
    Cancelled,
    Budget,
    /// This Codex has no `command/exec` (JSON-RPC -32601).
    Unsupported,
    /// This platform's Codex refuses the streamed, capped form (its Windows sandbox).
    Platform(String),
    /// Codex refused the request.
    Refused(String),
    /// No answer: the connection ended or the answer did not arrive.
    Connection(String),
    /// Too much was kept already.
    Total,
}

struct Out {
    exit: i64,
    stdout: Vec<u8>,
    stdout_full: bool,
    stderr: String,
}

impl Out {
    fn says(&self, words: &str) -> bool {
        self.stderr.contains(words)
    }
    /// Git is not on the machine: the sandbox could not start it (0.162.1's
    /// Linux sandbox exits 101 saying so), or a shell's 127.
    fn git_missing(&self) -> bool {
        (self.exit == 101 && self.says("Failed to execvp")) || self.exit == 127
    }
}

struct Reader<'a> {
    ws: &'a Workspace,
    id: String,
    generation: u64,
    rpc: Arc<Rpc>,
    events: Option<Arc<EventBarrier>>,
    cwd: String,
    running: Arc<Running>,
    limits: Limits,
    deadline: Instant,
    commands: usize,
    kept: usize,
    overrides: Vec<(String, String)>,
}

impl Reader<'_> {
    fn env(&self) -> Value {
        let mut env = Map::new();
        for name in UNSET {
            env.insert(name.into(), Value::Null);
        }
        env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
        env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
        env.insert("GIT_PAGER".into(), "cat".into());
        env.insert("PAGER".into(), "cat".into());
        // Always set: an inherited count would add its own configuration.
        env.insert("GIT_CONFIG_COUNT".into(), self.overrides.len().to_string().into());
        for (index, (key, value)) in self.overrides.iter().enumerate() {
            env.insert(format!("GIT_CONFIG_KEY_{index}"), key.clone().into());
            env.insert(format!("GIT_CONFIG_VALUE_{index}"), value.clone().into());
        }
        Value::Object(env)
    }

    /// One Git command, its stdout kept up to `cap` bytes.
    async fn git(&mut self, args: &[&str], cap: usize) -> std::result::Result<Out, Stop> {
        if self.running.cancelled.load(Ordering::SeqCst) {
            return Err(Stop::Cancelled);
        }
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left < MIN_COMMAND {
            return Err(Stop::Budget);
        }
        if self.kept >= self.limits.total {
            return Err(Stop::Total);
        }
        self.commands += 1;
        let process = format!("yuzuno-diff-{}-{}", self.running.token, self.commands);
        let notify = Arc::new(Notify::new());
        let key = (self.id.clone(), self.generation, process.clone());
        self.ws.codex_diff.streams.lock().unwrap().insert(key.clone(),
            Stream { stdout_cap: cap, notify: notify.clone(), ..Default::default() });
        *self.running.current.lock().unwrap() = Some(process.clone());
        let argv: Vec<&str> = std::iter::once("git").chain(HARDENING).chain(args.iter().copied()).collect();
        let params = json!({"command":argv,"processId":process,"streamStdoutStderr":true,"cwd":self.cwd,
            "timeoutMs":left.as_millis() as u64,"outputBytesCap":cap + 1,"env":self.env(),
            "sandboxPolicy":{"type":"readOnly","networkAccess":false}});
        let rpc = self.rpc.clone();
        let mut answer = tokio::spawn(async move { rpc.request_within("command/exec", params, left + ANSWER_GRACE).await });
        let mut terminated = false;
        let result = loop {
            tokio::select! {
                result = &mut answer => break result.unwrap_or_else(|e| Err(anyhow::anyhow!(e))),
                // Codex keeps a capped process running: stop it, once.
                _ = notify.notified(), if !terminated => {
                    terminated = true;
                    terminate(&self.rpc, process.clone());
                }
                _ = self.running.wake.notified() => {}
            }
        };
        *self.running.current.lock().unwrap() = None;
        let answer = match result {
            Ok(answer) => answer,
            Err(error) => {
                self.ws.codex_diff.streams.lock().unwrap().remove(&key);
                return Err(match error.downcast_ref::<RpcError>() {
                    Some(refused) if refused.code == -32601 => Stop::Unsupported,
                    Some(refused) if refused.message.contains("not supported with windows sandbox") => Stop::Platform(refused.message.clone()),
                    Some(refused) => Stop::Refused(refused.message.clone()),
                    None => {
                        // No answer: the command may still run; stop it.
                        terminate(&self.rpc, process);
                        Stop::Connection(error.to_string())
                    }
                });
            }
        };
        // Every delta Codex sent before its answer is handled before the output is taken.
        let drained = match &self.events {
            Some(events) => tokio::time::timeout(ANSWER_GRACE, events.drain()).await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("its output did not arrive"))),
            None => Ok(()),
        };
        let stream = self.ws.codex_diff.streams.lock().unwrap().remove(&key).unwrap_or_default();
        if let Err(error) = drained {
            return Err(Stop::Connection(error.to_string()));
        }
        // Terminated because the read was cancelled: not Git's answer.
        if self.running.cancelled.load(Ordering::SeqCst) {
            return Err(Stop::Cancelled);
        }
        let stderr = String::from_utf8_lossy(&stream.stderr).into_owned();
        self.kept += stream.stdout.len().min(cap) + stderr.len();
        Ok(Out { exit: answer["exitCode"].as_i64().unwrap_or(-1), stdout_full: stream.stdout_full,
            stdout: stream.stdout, stderr })
    }
}

/// Exit 0; a capped process that Yuzuno terminated counts as read (its
/// output is marked incomplete).
fn read_ok(out: &Out) -> bool {
    out.exit == 0 || (out.stdout_full && out.exit == 137)
}

/// `diff --no-index` against /dev/null: the file as an addition, exit 1,
/// nothing on stderr. Exit 1 is also its error exit (Git 2.56 says "Could not
/// access 'link/null'" for a link to a folder, which it follows as a folder),
/// so exit 1 alone is not a read; nor is any other command's exit 1.
fn diff_ok(out: &Out) -> bool {
    let added = out.exit == 1 && out.stderr.is_empty() && out.stdout.starts_with(b"diff --git ");
    added || (out.stdout_full && matches!(out.exit, 1 | 137))
}

/// Why a list could not be read: Git's words, or Codex's timeout.
fn failure(out: &Out) -> String {
    match (out.exit, short(&out.stderr)) {
        (124, _) => "timeout".into(),
        (exit, words) if words.is_empty() => format!("exit {exit}"),
        (exit, words) => format!("exit {exit}: {words}"),
    }
}

fn short(text: &str) -> String {
    text.chars().take(1000).collect::<String>().trim().to_owned()
}

/// `name\0` records. What follows the last NUL is empty, or a record a cap
/// cut, and is left out.
fn names(bytes: &[u8]) -> Vec<String> {
    let mut parts: Vec<&[u8]> = bytes.split(|b| *b == 0).collect();
    parts.pop();
    parts.into_iter().map(|p| String::from_utf8_lossy(p).into_owned()).collect()
}

/// `--name-status -z`: a status, then one path, or two for a rename or copy.
fn staged_entries(records: &[String], limit: usize) -> (Vec<StagedEntry>, bool) {
    let mut entries = vec![];
    let mut at = 0;
    while at < records.len() {
        let status = records[at].clone();
        let two = status.starts_with('R') || status.starts_with('C');
        let needed = if two { 3 } else { 2 };
        if at + needed > records.len() {
            return (entries, false);
        }
        if entries.len() >= limit {
            return (entries, false);
        }
        let (from, path) = if two { (Some(records[at + 1].clone()), records[at + 2].clone()) } else { (None, records[at + 1].clone()) };
        entries.push(StagedEntry { status, path, from });
        at += needed;
    }
    (entries, true)
}

fn stop_name(stop: &Stop) -> &'static str {
    match stop {
        Stop::Cancelled => "cancelled",
        Stop::Budget => "budget",
        Stop::Total => "total",
        Stop::Connection(_) => "connection",
        Stop::Unsupported => "old_protocol",
        Stop::Platform(_) => "platform",
        Stop::Refused(_) => "refused",
    }
}

/// A stop before anything was read: the read could not happen.
fn not_read(stop: Stop) -> Report {
    match stop {
        Stop::Unsupported => Report::not("unavailable", "old_protocol"),
        Stop::Platform(detail) => Report { detail: Some(short(&detail)), ..Report::not("unavailable", "platform") },
        Stop::Refused(detail) => Report { detail: Some(short(&detail)), ..Report::not("failed", "refused") },
        Stop::Connection(detail) => Report { detail: Some(short(&detail)), ..Report::not("failed", "connection") },
        Stop::Cancelled => Report::not("cancelled", "cancelled"),
        Stop::Budget => Report::not("failed", "budget"),
        Stop::Total => Report::not("failed", "total"),
    }
}

impl Reader<'_> {
    async fn read(&mut self) -> Report {
        // In a work tree at all.
        let out = match self.git(&["rev-parse", "--is-inside-work-tree"], SMALL).await {
            Ok(out) => out,
            Err(stop) => return not_read(stop),
        };
        if out.git_missing() {
            return Report { detail: Some(short(&out.stderr)), ..Report::not("unavailable", "git_missing") };
        }
        if out.exit == 124 {
            return Report::not("failed", "timeout");
        }
        if out.says("dubious ownership") {
            return Report { detail: Some(short(&out.stderr)), ..Report::not("failed", "dubious_ownership") };
        }
        if out.exit != 0 || String::from_utf8_lossy(&out.stdout).trim() != "true" {
            if out.says("not a git repository") || (out.exit == 0) {
                return Report { detail: Some(short(&out.stderr)), ..Report::not("not_repository", "not_work_tree") };
            }
            return Report { detail: Some(short(&out.stderr)), ..Report::not("failed", "git") };
        }
        // Filter drivers, so none of them runs, as the CLI does.
        let out = match self.git(&["config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|process)$"], SMALL).await {
            Ok(out) => out,
            Err(stop) => return not_read(stop),
        };
        // `--get-regexp` exits 1 when no key matches: no driver is configured.
        if !matches!(out.exit, 0 | 1) || out.stdout_full {
            // Every driver must be disabled before any diff runs.
            return Report { detail: Some(short(&out.stderr)), ..Report::not("failed", "filter_config") };
        }
        let mut drivers: Vec<String> = names(&out.stdout).into_iter()
            .filter_map(|key| key.strip_suffix(".clean").or_else(|| key.strip_suffix(".process")).map(str::to_owned)).collect();
        drivers.sort();
        drivers.dedup();
        self.overrides = drivers.into_iter().flat_map(|d| [(format!("{d}.clean"), String::new()),
            (format!("{d}.process"), String::new()), (format!("{d}.required"), "false".into())]).collect();

        let mut report = Report { state: "read", reason: "read".into(), complete: true, ..Default::default() };
        // Tracked: the working tree against the index.
        let tracked_args: Vec<&str> = std::iter::once("diff").chain(DIFF_FLAGS).collect();
        match self.git(&tracked_args, self.limits.tracked).await {
            Ok(out) if read_ok(&out) => {
                let (text, not_utf8) = text(out.stdout, out.stdout_full);
                report.complete &= !out.stdout_full;
                report.tracked = Some(Part { text, complete: !out.stdout_full, not_utf8 });
            }
            Ok(out) if out.exit == 124 => return Report { stopped: Some("budget".into()), ..Report::not("failed", "timeout") },
            Ok(out) => return Report { detail: Some(short(&out.stderr)), ..Report::not("failed", "git") },
            Err(stop) => return not_read(stop),
        }
        // Staged: names and status only.
        let staged_args: Vec<&str> = ["diff", "--cached", "--name-status", "-z"].into_iter().chain(DIFF_FLAGS).collect();
        match self.git(&staged_args, self.limits.list).await {
            Ok(out) if read_ok(&out) => {
                let (entries, all) = staged_entries(&names(&out.stdout), self.limits.names);
                let complete = all && !out.stdout_full;
                report.complete &= complete;
                report.staged = Some(Staged { entries, complete, error: None });
            }
            Ok(out) => {
                report.complete = false;
                report.staged = Some(Staged { error: Some(failure(&out)), ..Default::default() });
            }
            Err(stop) => return self.ended(report, stop),
        }
        // Untracked: the names, then each file's content, within the limits.
        let out = match self.git(&["ls-files", "--others", "--exclude-standard", "-z"], self.limits.list).await {
            Ok(out) if read_ok(&out) => out,
            Ok(out) => {
                report.complete = false;
                report.untracked = Some(Untracked { error: Some(failure(&out)), ..Default::default() });
                return report;
            }
            Err(stop) => return self.ended(report, stop),
        };
        let mut listed = names(&out.stdout);
        let mut listed_all = !out.stdout_full;
        if listed.len() > self.limits.names {
            listed.truncate(self.limits.names);
            listed_all = false;
        }
        report.complete &= listed_all;
        let mut untracked = Untracked { files: vec![], listed_all, error: None };
        let mut read = 0;
        let mut stopped: Option<Stop> = None;
        for path in listed {
            let not = if stopped.is_some() {
                Some("stopped")
            } else if path.ends_with('/') {
                Some("nested_repository")
            } else if read >= self.limits.untracked_files {
                Some("limit")
            } else if self.kept + self.limits.untracked_each >= self.limits.total {
                Some("total")
            } else {
                None
            };
            if let Some(why) = not {
                report.complete = false;
                untracked.files.push(UntrackedFile { path, diff: None, not_read: Some(why.into()) });
                continue;
            }
            let args: Vec<&str> = ["diff", "--no-index"].into_iter().chain(DIFF_FLAGS).chain(["--", "/dev/null", path.as_str()]).collect();
            match self.git(&args, self.limits.untracked_each).await {
                Ok(out) if diff_ok(&out) => {
                    read += 1;
                    let (text, not_utf8) = text(out.stdout, out.stdout_full);
                    report.complete &= !out.stdout_full;
                    untracked.files.push(UntrackedFile { path, diff: Some(Part { text, complete: !out.stdout_full, not_utf8 }), not_read: None });
                }
                Ok(out) => {
                    read += 1;
                    report.complete = false;
                    untracked.files.push(UntrackedFile { path, diff: None, not_read: Some(failure(&out)) });
                }
                Err(stop) => {
                    report.complete = false;
                    report.stopped = Some(stop_name(&stop).into());
                    untracked.files.push(UntrackedFile { path, diff: None, not_read: Some("stopped".into()) });
                    stopped = Some(stop);
                }
            }
        }
        report.untracked = Some(untracked);
        if let Some(Stop::Cancelled) = stopped {
            report.state = "cancelled";
        }
        report
    }

    /// A stop after something was read: what was read stays, marked incomplete.
    fn ended(&self, mut report: Report, stop: Stop) -> Report {
        report.complete = false;
        report.stopped = Some(stop_name(&stop).into());
        if let Stop::Cancelled = stop {
            report.state = "cancelled";
        }
        report
    }
}

/// Removes the Agent's running read when it ends, however it ends; a read
/// whose request went away is cancelled, so its command does not run on.
struct Registered<'a> {
    ws: &'a Workspace,
    id: String,
    running: Arc<Running>,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.running.cancel();
        let mut reads = self.ws.codex_diff.reads.lock().unwrap();
        if reads.get(&self.id).is_some_and(|r| Arc::ptr_eq(r, &self.running)) {
            reads.remove(&self.id);
        }
    }
}

/// A read of the target the dialog showed: the Agent's folder on connection
/// `generation`. A newer connection or another folder is not read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub(crate) token: String,
    pub(crate) generation: u64,
    pub(crate) cwd: String,
}

/// What a read would read now: the Agent's folder on its current connection.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// ready or unavailable.
    state: &'static str,
    reason: &'static str,
    generation: Option<u64>,
    cwd: String,
}

impl Workspace {
    /// The Agent (as listed, never its history: T-140) and its current
    /// connection, or why there is none to read on. Nothing is connected.
    async fn codex_diff_on(&self, id: &str) -> Result<std::result::Result<(crate::model::Agent, Connection), &'static str>> {
        let agent = self.listed(id).await?;
        if agent.harness != "codex" {
            return Ok(Err("harness"));
        }
        if agent.closed_at.is_some() {
            return Ok(Err("closed"));
        }
        let connection = self.rpcs.lock().unwrap().get(id).cloned()
            .filter(|c| !c.closing && agent.connection_state == "connected");
        Ok(connection.map(|c| (agent, c)).ok_or("not_connected"))
    }

    /// What `/diff` would read now, for the dialog to show before it reads.
    pub async fn codex_diff_target(&self, id: &str) -> Result<Target> {
        Ok(match self.codex_diff_on(id).await? {
            Ok((agent, connection)) => Target { state: "ready", reason: "ready", generation: Some(connection.generation), cwd: agent.cwd },
            Err(reason) => Target { state: "unavailable", reason, generation: None, cwd: self.listed(id).await?.cwd },
        })
    }

    /// This Codex Agent's working-folder diff, read on the connection and in
    /// the folder the dialog showed. Nothing is connected or resumed for it;
    /// one read at a time per Agent.
    pub async fn codex_diff(self: &Arc<Self>, id: &str, request: Request) -> Result<Report> {
        let Request { token, generation, cwd } = request;
        anyhow::ensure!(!token.is_empty() && token.len() <= MAX_TOKEN
            && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "无效的读取标识");
        let started = Instant::now();
        let (agent, connection) = match self.codex_diff_on(id).await? {
            Ok(on) => on,
            Err(reason) => return Ok(Report::not("unavailable", reason)),
        };
        if connection.generation != generation || agent.cwd != cwd {
            return Ok(Report { generation: Some(connection.generation), cwd: Some(agent.cwd), ..Report::not("unavailable", "target_changed") });
        }
        let running = Arc::new(Running { token, rpc: connection.rpc.clone(),
            cancelled: AtomicBool::new(false), current: Mutex::new(None), wake: Notify::new() });
        {
            let mut reads = self.codex_diff.reads.lock().unwrap();
            if reads.contains_key(id) {
                return Ok(Report::not("busy", "busy"));
            }
            reads.insert(id.to_owned(), running.clone());
        }
        let _registered = Registered { ws: self.as_ref(), id: id.to_owned(), running: running.clone() };
        let limits = self.codex_diff.limits.lock().unwrap().clone();
        let mut reader = Reader {
            ws: self.as_ref(), id: id.to_owned(), generation: connection.generation, rpc: connection.rpc.clone(),
            events: connection.events.clone(), cwd: agent.cwd.clone(), running, deadline: started + limits.budget,
            limits, commands: 0, kept: 0, overrides: vec![],
        };
        let mut report = reader.read().await;
        // A read that outlived its connection is not that connection's whole answer.
        let current = self.rpcs.lock().unwrap().get(id).map(|c| c.generation);
        if report.state == "read" && current != Some(connection.generation) {
            report.complete = false;
            report.stopped.get_or_insert_with(|| "connection".into());
        }
        report.generation = Some(connection.generation);
        report.cwd = Some(agent.cwd);
        report.commands = reader.commands;
        report.bytes = reader.kept;
        report.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(report)
    }
}

async fn target_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Target>, ApiError> {
    Ok(Json(ws.codex_diff_target(&id).await?))
}

async fn read_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(request): Json<Request>) -> Result<Json<Report>, ApiError> {
    Ok(Json(ws.codex_diff(&id, request).await?))
}

#[derive(Deserialize)]
struct CancelQuery {
    token: String,
}

async fn cancel_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Query(query): Query<CancelQuery>) -> Json<Value> {
    Json(json!({"cancelled": ws.codex_diff.cancel(&id, &query.token)}))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/codex/diff", get(target_route).post(read_route).delete(cancel_route))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_keeps_whole_characters_and_says_when_bytes_are_not_utf8() {
        // A cap that splits あ (e3 81 82): the cut character is left out.
        assert_eq!(text(vec![b'a', 0xe3, 0x81], true), ("a".into(), false));
        assert_eq!(text("aあ".as_bytes().to_vec(), true), ("aあ".into(), false));
        // Not capped, or invalid inside: shown with U+FFFD, and said.
        assert_eq!(text(vec![b'a', 0xe3, 0x81], false), ("a\u{fffd}".into(), true));
        assert_eq!(text(vec![b'a', 0xff, b'b'], true), ("a\u{fffd}b".into(), true));
    }

    #[test]
    fn nul_separated_lists_leave_out_a_cut_last_record() {
        assert_eq!(names(b"a\0-b\0new\nline\0"), ["a", "-b", "new\nline"]);
        assert_eq!(names(b"a\0b\0cu"), ["a", "b"]);
        let records: Vec<String> = ["M", "a.rs", "R100", "old.rs", "new.rs", "A", "x"].map(String::from).to_vec();
        let (entries, all) = staged_entries(&records, 10);
        assert!(all);
        assert_eq!(entries.iter().map(|e| (e.status.as_str(), e.path.as_str(), e.from.as_deref())).collect::<Vec<_>>(),
            [("M", "a.rs", None), ("R100", "new.rs", Some("old.rs")), ("A", "x", None)]);
        let (entries, all) = staged_entries(&records[..4], 10);
        assert_eq!((entries.len(), all), (1, false), "a rename cut by the cap is not shown half");
        let (entries, all) = staged_entries(&records, 2);
        assert_eq!((entries.len(), all), (2, false));
    }

    #[test]
    fn deltas_belong_to_their_own_connection_and_process_and_stop_at_the_cap() {
        let state = State::default();
        let notify = Arc::new(Notify::new());
        state.streams.lock().unwrap().insert(("a".into(), 3, "p".into()), Stream { stdout_cap: 4, notify, ..Default::default() });
        let delta = |stream: &str, text: &str, full: bool| json!({"processId":"p","stream":stream,
            "deltaBase64":base64::engine::general_purpose::STANDARD.encode(text),"capReached":full});
        state.deliver("a", 3, &delta("stdout", "ab", false));
        state.deliver("a", 2, &delta("stdout", "zz", false));
        state.deliver("b", 3, &delta("stdout", "zz", false));
        state.deliver("a", 3, &delta("stdout", "cde", true));
        state.deliver("a", 3, &delta("stderr", "warning", false));
        let mut streams = state.streams.lock().unwrap();
        let stream = &streams[&("a".to_owned(), 3, "p".to_owned())];
        assert_eq!((stream.stdout.as_slice(), stream.stdout_full, stream.stderr.as_slice()), (&b"abcd"[..], true, &b"warning"[..]));
        // One byte over the limit is more, flagged or not; exactly the limit is whole.
        for (text, full) in [("abcd", false), ("abcde", true)] {
            streams.insert(("a".into(), 3, "q".into()), Stream { stdout_cap: 4, ..Default::default() });
            drop(streams);
            state.deliver("a", 3, &json!({"processId":"q","stream":"stdout","deltaBase64":base64::engine::general_purpose::STANDARD.encode(text),"capReached":false}));
            streams = state.streams.lock().unwrap();
            assert_eq!(streams[&("a".to_owned(), 3, "q".to_owned())].stdout_full, full, "{text}");
        }
    }
}
