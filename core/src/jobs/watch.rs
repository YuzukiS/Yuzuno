//! What Core reads of its local Jobs on each tick (T-59). A local attempt is
//! two transient units of the user's systemd: its worker, whose cgroup holds
//! the command, and its collector (host.py `supervise`), which records how it
//! ended. Each tick Core reads their own files: the attempt's records in its
//! folder (`dispatched.json`, `launch.json`, `started.json`, `command.json`,
//! `result.json`) and each unit's `cgroup.events`. A Job that runs steadily
//! starts no process.
//!
//! The host helper (python3, and the systemctl calls it makes) is started only
//! when those files say something happened: the worker started, its command
//! started, an outcome was recorded, a unit's processes are gone with no
//! outcome, the boot changed, a cancel was asked, or a file can't be read. A
//! state that is the same as when the helper was last asked about it is asked
//! about again after 2 s, then 4 s, and so on up to once a minute, never on
//! every tick. Nothing here is kept across a restart: a Core that starts reads
//! the same files and asks what they call for.
use super::host;
use anyhow::Result;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

/// A state asked about and unchanged since is asked about again after this,
/// doubling up to `RETRY_MAX`.
const RETRY: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// How long a dispatched attempt may go without its collector's launch
/// record before Core asks systemd itself.
pub(super) const LAUNCH_WAIT: Duration = Duration::from_secs(30);

/// One unit's cgroup, as its `cgroup.events` says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Group {
    /// Something runs in it.
    Live { frozen: bool },
    /// It exists with nothing in it.
    Empty,
    /// No such cgroup (systemd removed it), or no record names it yet.
    Gone,
    /// Its file could not be read: only the helper can tell.
    Unreadable,
}

/// What a question to the helper is about: the worker's group and the
/// collector's, whether a cancel is asked and whether the command's own
/// record is there. The same state is asked about again only after a wait;
/// any change, at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct State {
    worker: Group,
    collector: Group,
    cancel: bool,
    command: bool,
}

/// What the files say about one active attempt.
enum Reading {
    /// Ask the helper.
    Ask,
    /// Ask it only if the state lasts: one the collector itself normally ends
    /// within a poll or two, by recording the outcome.
    Defer,
    /// Nothing to do yet.
    Wait,
    /// It runs as before: this reading, with its freezer from the files.
    Running(Value),
}

/// Per attempt: when Core first saw it, and when it last asked the helper
/// about it, its state then and how long to wait before asking again about
/// the same state.
struct Seen {
    first: Instant,
    asked: Option<(Instant, Duration, State)>,
}

#[derive(Default)]
pub(super) struct Watch {
    seen: Mutex<HashMap<String, Seen>>,
}

impl Watch {
    /// This tick's evidence for one active attempt, as `host::observe` gives
    /// it, asking the helper only when the files call for it.
    pub(super) async fn observe(&self, data: &Path, job: &Value) -> Result<Option<Value>> {
        let attempt = job["attempt"].as_str().unwrap_or_default().to_owned();
        let first = self.seen.lock().unwrap().entry(attempt.clone()).or_insert_with(|| Seen { first: Instant::now(), asked: None }).first;
        let (reading, state) = read(data, job, first.elapsed());
        match reading {
            Reading::Running(value) => Ok(Some(value)),
            Reading::Wait => Ok(None),
            Reading::Defer if self.defer(&attempt, state) => Ok(None),
            Reading::Ask | Reading::Defer if !self.due(&attempt, state) => Ok(None),
            Reading::Ask | Reading::Defer => {
                let answer = host::observe(data, job).await;
                self.asked(&attempt, state);
                answer
            }
        }
    }

    /// Whether the helper may be asked about this attempt now: never asked,
    /// its state changed since, or the wait for the same state is over.
    fn due(&self, attempt: &str, state: State) -> bool {
        let seen = self.seen.lock().unwrap();
        match seen.get(attempt).and_then(|seen| seen.asked) {
            None => true,
            Some((at, wait, before)) => before != state || at.elapsed() >= wait,
        }
    }

    /// For a state first seen now: noted as if asked about, so the helper is
    /// asked only if it is still so after `RETRY`. Whether it was new.
    fn defer(&self, attempt: &str, state: State) -> bool {
        let mut seen = self.seen.lock().unwrap();
        let Some(seen) = seen.get_mut(attempt) else { return false };
        if seen.asked.is_some_and(|(_, _, before)| before == state) {
            return false;
        }
        seen.asked = Some((Instant::now(), RETRY, state));
        true
    }

    fn asked(&self, attempt: &str, state: State) {
        let mut seen = self.seen.lock().unwrap();
        let Some(seen) = seen.get_mut(attempt) else { return };
        let wait = match seen.asked {
            Some((_, wait, before)) if before == state => (wait * 2).min(RETRY_MAX),
            _ => RETRY,
        };
        seen.asked = Some((Instant::now(), wait, state));
    }

    /// Forgets attempts no longer active.
    pub(super) fn retain(&self, active: &HashSet<String>) {
        self.seen.lock().unwrap().retain(|attempt, _| active.contains(attempt));
    }

    /// Tests: as a Core that just started, which has seen nothing.
    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn reset(&self) {
        self.seen.lock().unwrap().clear();
    }

    /// Tests: as if `by` had passed since every first sight and question.
    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn rewind(&self, by: Duration) {
        for seen in self.seen.lock().unwrap().values_mut() {
            seen.first -= by;
            if let Some((at, _, _)) = seen.asked.as_mut() {
                *at -= by;
            }
        }
    }
}

/// A unit's cgroup, from its own `cgroup.events`.
pub(super) fn group(data: &Path, path: Option<&str>) -> Group {
    let Some(path) = path.filter(|path| !path.is_empty()) else { return Group::Gone };
    let file = host::cgroup_root(data).join(path.trim_start_matches('/')).join("cgroup.events");
    match std::fs::read_to_string(file) {
        Ok(text) => {
            let value = |key: &str| text.lines().find_map(|line| line.strip_prefix(key)?.strip_prefix(' ')).map(str::trim);
            match value("populated") {
                Some("1") => Group::Live { frozen: value("frozen") == Some("1") },
                Some("0") => Group::Empty,
                _ => Group::Unreadable,
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Group::Gone,
        Err(_) => Group::Unreadable,
    }
}

/// One of the attempt's records: None when missing, an error when it can't
/// be read as JSON.
fn record(dir: &Path, name: &str) -> Result<Option<Value>, ()> {
    match std::fs::read(dir.join(name)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| ()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

fn boot_id() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok().map(|id| id.trim().to_owned())
}

/// What the files say about one active attempt, `waited` after Core first saw
/// it, and its state as they give it.
fn read(data: &Path, job: &Value, waited: Duration) -> (Reading, State) {
    let cancel = job["cancelRequestedAt"].is_string();
    let none = State { worker: Group::Gone, collector: Group::Gone, cancel, command: false };
    let Ok(dir) = host::folder(data, job) else { return (Reading::Ask, none) };
    // Never handed to systemd-run: the helper is not started for it (host::observe).
    if !dir.join("dispatched.json").exists() {
        return (Reading::Ask, none);
    }
    // Another boot: the helper records the attempt interrupted.
    if boot_id().is_none_or(|boot| job["bootId"] != boot.as_str()) {
        return (Reading::Ask, none);
    }
    // A record that can't be read: only the helper can tell.
    let (Ok(result), Ok(launch), Ok(started), Ok(command)) =
        (record(&dir, "result.json"), record(&dir, "launch.json"), record(&dir, "started.json"), record(&dir, "command.json"))
    else {
        return (Reading::Ask, none);
    };
    let attempt = &job["attempt"];
    let started = started.filter(|proof| proof["attempt"] == *attempt && proof["bootId"] == job["bootId"]);
    let collector = launch.as_ref().map_or(Group::Gone, |launch| group(data, launch["controlGroup"].as_str()));
    let worker = started.as_ref().map_or(Group::Gone, |proof| group(data, proof["controlGroup"].as_str()));
    let created = |command: &Value| command["attempt"] == *attempt && command["pid"].is_i64();
    let state = State { worker, collector, cancel, command: command.as_ref().is_some_and(created) };
    let live = |group: Group| matches!(group, Group::Live { .. });
    // A cancel: the helper stops both units, and is asked again when their groups change.
    if cancel {
        return (Reading::Ask, state);
    }
    // A group that can't be read is never taken as running.
    if matches!(worker, Group::Unreadable) || matches!(collector, Group::Unreadable) {
        return (Reading::Ask, state);
    }
    // An outcome recorded: settled once nothing of either unit runs.
    if result.as_ref().is_some_and(|result| result["status"] != "unknown") {
        return (if live(worker) || live(collector) { Reading::Wait } else { Reading::Ask }, state);
    }
    if launch.is_none() {
        return (if waited < LAUNCH_WAIT { Reading::Wait } else { Reading::Ask }, state);
    }
    let Some(proof) = started else {
        // The collector starts the worker and records what became of it.
        return (if live(collector) { Reading::Wait } else { Reading::Ask }, state);
    };
    // The first running reading carries systemd's own evidence of the start.
    if job["status"] != "running" {
        return (Reading::Ask, state);
    }
    // The command's own start (T-14), taken once.
    if state.command && !created(&job["result"]["command"]) {
        return (Reading::Ask, state);
    }
    match (worker, collector) {
        (Group::Live { frozen }, Group::Live { .. }) => {
            let mut value = job["result"].clone();
            value["started"] = proof;
            value["freezer"] = json!({"populated": true, "frozen": frozen});
            (Reading::Running(value), state)
        }
        // The worker ended and its collector runs: it records the outcome.
        (_, Group::Live { .. }) => (Reading::Defer, state),
        _ => (Reading::Ask, state),
    }
}
