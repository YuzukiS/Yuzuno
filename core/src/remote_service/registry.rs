//! The Workspace's remote sessions: one Link at most per registered SSH
//! machine (YN-83 S1 PR4b; design v4 PR4).
//!
//! What may start one: `GET /api/machine-live` (live.rs); the remote Jobs
//! held on a machine (`hold_jobs`, from each pass of the Jobs loop, YN-83 S2
//! PR4); and, while either wants a session there, the end of a backoff. The
//! interest a GET recorded lasts 60 s, for every machine; Jobs want one on
//! their own machine while they are held there and for 60 s after the last
//! went. Nothing else starts one: no other page, no Core start, no record
//! change. Each start
//! takes a short `Admission::enter_work` permit, so none starts once an
//! update drains, and none once Core's shutdown watch says true
//! (`follow_shutdown`): every start reads that watch itself. A session Core
//! started is asked to close when nothing wants it any more, when an update drains,
//! when its machine's target or data root changes or the machine is
//! removed, and as soon as Core's shutdown is sent.
//!
//! Per machine, by its id: the record as stored, the current Link, since
//! when its state holds, a stop, a backoff, and every child of an earlier
//! session not yet reaped (`ReapGate`), whatever its generation or the
//! record it ran for. While one of those gates is closed nothing starts
//! there; a removed machine stays, unlisted, until they open.
//!
//! After a session ends (the transport's `After`):
//! - `Clean`: the next interest may start one.
//! - `Backoff`: only OpenSSH's own connect or DNS failure. Retried after
//!   1 s, doubling to 60 s, while something wants a session there; once
//!   nothing does, the machine is idle and nothing starts until the next
//!   interest or Jobs held there. The count
//!   goes back to zero only on a session that said hello, a changed target or
//!   root, or a qualifying manual check; a new interest keeps it.
//! - `Stop`: nothing starts there until its target or data root changes, a
//!   manual check that started after the stop reaches the machine as it is
//!   now, or Core restarts. A GET, an interest, Jobs held there, a backoff
//!   ending or an older session's late news never clears it.
//!
//! A session asked to scan Jobs' records says only which attempts changed
//! (`jobs_views`): the Jobs side then asks the attempt's helper sooner, and
//! its answer alone is the attempt's state.
//!
//! One gate (`hold`) orders every final check of the records with each
//! start, and the add, edit and removal of a machine with what they change
//! here (server.rs takes it around the store write). So a removal committed
//! after a GET read the records can never be followed by a start from what
//! it read. The gate is held across store reads through the Workspace's
//! async store boundary and across starting OpenSSH, never across a
//! handshake, a session's end or a wait for a child.
//!
//! The registry keeps no strong reference to its Workspace: the one task
//! that manages it at a time (`ensure_manager`) holds a Weak one, upgraded
//! only for each short step and never while it sleeps or waits, and ends
//! when there is nothing left to manage or the Workspace is gone.
//! Dropping the Workspace drops each Link, which closes its session.

use super::link::{age_at, JobsScan, Limits, Link, Options, Snapshot, Stamped};
use super::live::{self, Live, Row};
use super::protocol::{After, Attempt};
use crate::remote::RemoteMachine;
use crate::updates::admission::Admission;
use anyhow::Result;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Notify};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Timing {
    /// How long one GET's interest lasts (design v4 A8: ssh_mux's idle 60 s).
    pub interest: Duration,
    /// The first backoff, doubled after each failure up to `backoff_max`
    /// (v4 A8: gpu_sampler's backoff, ssh_mux's retry after 60 s).
    pub backoff_first: Duration,
    pub backoff_max: Duration,
    /// The transport's: its silence also decides when an answer stops
    /// showing a session online.
    pub limits: Limits,
}

impl Timing {
    pub(crate) const PRODUCTION: Timing = Timing {
        interest: Duration::from_secs(60),
        backoff_first: Duration::from_secs(1),
        backoff_max: Duration::from_secs(60),
        limits: Limits::PRODUCTION,
    };

    /// How long closing every session may take, all at once: one close, the
    /// wait for the exit once stdout ends and the wait after SIGKILL
    /// (10 + 2 + 2 = 14 s, the Lead's fixed budget for PR4b).
    pub(crate) fn closing(&self) -> Duration {
        self.limits.close + self.limits.exit_wait + self.limits.kill_wait
    }

    /// The wait after the `failures`th failure in a row (1 s, 2 s, 4 s … 60 s).
    pub(crate) fn backoff(&self, failures: u32) -> Duration {
        let mut delay = self.backoff_first;
        for _ in 1..failures {
            if delay >= self.backoff_max {
                break;
            }
            delay = delay.saturating_mul(2);
        }
        delay.min(self.backoff_max)
    }
}

/// Core's monotonic clock, and its wall clock for display only.
pub(crate) trait Clock: Send + Sync + 'static {
    fn now(&self) -> Instant;
    fn wall(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }
    fn sleep_until(&self, at: Instant) -> BoxFuture<'static, ()>;
}

struct System;

impl Clock for System {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn sleep_until(&self, at: Instant) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep_until(at.into()))
    }
}

/// What the registry needs of its Workspace (tests give their own).
pub(crate) trait Host: Send + Sync + 'static {
    fn registry(&self) -> &Registry;
    fn admission(&self) -> &Arc<Admission>;
    /// The registered SSH machines in their order, through the store's async
    /// boundary.
    fn registered(&self) -> BoxFuture<'_, Result<Vec<RemoteMachine>>>;
    /// Starts one session: `Link::start` with `Registry::options`.
    fn start(&self, machine: &RemoteMachine, generation: u64) -> Result<Link>;
    /// This host's id by the remote program's algorithm, if it has one.
    fn local_host(&self) -> Option<String>;
}

pub(crate) struct Registry {
    inner: Arc<Inner>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry::new(Timing::PRODUCTION, Arc::new(System))
    }
}

struct Inner {
    clock: Arc<dyn Clock>,
    gate: tokio::sync::Mutex<()>,
    state: Mutex<State>,
    /// Wakes the managing task: a session's news, or the registry gone.
    wake: Arc<Notify>,
    /// Steps the managing task took (tests).
    #[cfg(test)]
    steps: std::sync::atomic::AtomicU64,
    /// Core's shutdown watch, once `follow_shutdown` was given it.
    shutdown: std::sync::OnceLock<watch::Receiver<bool>>,
    /// The Jobs loop's wake-up, once `wake_jobs_with` was given it.
    jobs_wake: std::sync::OnceLock<Arc<Notify>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // The managing task sees the Workspace gone and ends.
        self.wake.notify_one();
    }
}

/// The gate held: a final check of the records, a start, or a machine's add,
/// edit or removal with what it changes here.
pub(crate) struct Held<'a>(#[allow(dead_code)] tokio::sync::MutexGuard<'a, ()>);

/// A manual check, numbered when it started (see `Registry::check_started`).
#[derive(Clone, Debug)]
pub(crate) struct CheckTicket {
    id: String,
    target: String,
    root: String,
    seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Closing {
    /// An update detaches: closed now, and the usual rules once it reopens.
    Detach,
    /// Core ends: nothing starts again.
    Shutdown,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Closed {
    /// Sessions asked to close, and earlier children still unreaped.
    pub waited: usize,
    /// Of those, children not reaped by the end of the budget: their reaper
    /// still holds them, and their machines start nothing until it is done.
    pub unreaped: usize,
}

struct State {
    timing: Timing,
    ssh: String,
    /// In the stored order; removed machines whose children are not all
    /// reaped come after them, unlisted.
    entries: Vec<Entry>,
    /// When a GET last recorded the user's interest.
    interest: Option<Instant>,
    generations: u64,
    /// Manual checks started so far (see `CheckTicket`).
    checks: u64,
    /// A managing task runs.
    manager: bool,
    /// Core is ending: nothing starts again (see also `Inner::ending`).
    closed: bool,
    /// The Jobs side's attempts, by machine id (`hold_jobs`).
    jobs: HashMap<String, JobsHold>,
    /// Jobs sets numbered so far.
    job_sets: u64,
}

/// The remote Jobs held on one machine: their attempts, as one numbered set.
struct JobsHold {
    set: u64,
    attempts: Arc<Vec<Attempt>>,
    /// When the last attempt went: the session it kept closes 60 s later.
    emptied: Option<Instant>,
}

impl JobsHold {
    fn wants(&self, now: Instant, interest: Duration) -> bool {
        !self.attempts.is_empty() || self.emptied.is_some_and(|at| now.saturating_duration_since(at) < interest)
    }
}

/// A held set's scan stands for its attempts this long: three of the
/// session's 2 s scan periods (program.py LOAD_PERIOD), as live::CPU_STALE
/// (S2 design v3 §3.7).
pub(crate) const JOBS_FRESH: Duration = Duration::from_secs(6);

/// What one machine's current session says of the Jobs held there.
#[derive(Clone, Debug)]
pub(crate) struct JobsView {
    /// The set asked for, and its attempts.
    pub set: u64,
    pub attempts: Arc<Vec<Attempt>>,
    /// The data root the session watches (the record's, as stored), and the
    /// host its hello named.
    pub root: String,
    pub host_id: Option<String>,
    pub scan: Option<Arc<Stamped<JobsScan>>>,
    /// The session has ended (its end not yet settled here).
    pub ended: bool,
}

/// What a session says of one attempt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Notice {
    /// Its newest scan is of the set asked for, answered, holds this
    /// attempt and is at most JOBS_FRESH old.
    pub covered: bool,
    /// When an event of this session last said it changed.
    pub changed: Option<Instant>,
}

impl JobsView {
    pub(crate) fn notice(&self, attempt: &Attempt, now: Instant) -> Notice {
        let Some(scan) = &self.scan else { return Notice::default() };
        let covered = !self.ended
            && scan.value.why.is_none()
            && scan.value.set == self.set
            && self.attempts.contains(attempt)
            && age_at(scan.received, scan.value.age, now) <= JOBS_FRESH;
        Notice { covered, changed: scan.value.changed.get(attempt).copied() }
    }
}

struct Entry {
    machine: RemoteMachine,
    deleted: bool,
    run: Option<Run>,
    since: Instant,
    stop: Option<&'static str>,
    retry_at: Option<Instant>,
    failures: u32,
    /// The checks started when this machine last stopped or backed off: only
    /// a later one may clear that.
    blocked: u64,
    /// Children of earlier sessions here, until their gates open.
    gates: Vec<super::link::ReapGate>,
}

struct Run {
    link: Link,
    /// It said hello.
    hello: bool,
}

fn fingerprint(machine: &RemoteMachine) -> (&str, &str) {
    (&machine.target, machine.root())
}

impl Entry {
    fn new(machine: RemoteMachine, now: Instant) -> Entry {
        Entry { machine, deleted: false, run: None, since: now, stop: None, retry_at: None, failures: 0, blocked: 0, gates: vec![] }
    }

    /// Closes the current session, if any, keeping its gate.
    fn retire(&mut self) {
        if let Some(run) = self.run.take() {
            self.gates.push(run.link.reap_gate());
            // Dropping a Link closes its session.
        }
    }

    /// The record as stored now. A new target or data root (or a machine
    /// back under a removed one's id) is another machine: its session ends,
    /// and its stop and backoff go with it. Its unreaped children stay.
    fn saved(&mut self, machine: RemoteMachine, now: Instant) {
        let changed = self.deleted || fingerprint(&self.machine) != fingerprint(&machine);
        self.machine = machine;
        if changed {
            self.retire();
            self.deleted = false;
            self.stop = None;
            self.retry_at = None;
            self.failures = 0;
            self.since = now;
        }
    }

    fn removed(&mut self, now: Instant) {
        if !self.deleted {
            self.retire();
            self.deleted = true;
            self.stop = None;
            self.retry_at = None;
            self.since = now;
        }
    }

    /// What the current session said: its hello, or its end. Returns the
    /// state read, while the session goes on.
    fn settle(&mut self, now: Instant, timing: &Timing, checks: u64) -> Option<Snapshot> {
        let run = self.run.as_mut()?;
        let snapshot = run.link.snapshot();
        if let Some(hello) = &snapshot.hello {
            if !run.hello {
                run.hello = true;
                self.failures = 0;
                self.since = hello.received;
            }
        }
        let Some(terminal) = snapshot.terminal.clone() else { return Some(snapshot) };
        self.retire();
        self.since = now;
        self.retry_at = None;
        match terminal.after {
            After::Clean => {}
            After::Backoff => {
                self.failures = self.failures.saturating_add(1);
                self.retry_at = Some(now + timing.backoff(self.failures));
                self.blocked = checks;
            }
            After::Stop => {
                self.stop = Some(terminal.code.map_or("unclean_exit", |code| code.as_str()));
                self.blocked = checks;
            }
        }
        None
    }

    fn reaped(&self) -> bool {
        self.gates.iter().all(|gate| gate.is_reaped())
    }

    /// Nothing stands in the way of a session here now.
    fn can_start(&self, now: Instant) -> bool {
        !self.deleted && self.run.is_none() && self.stop.is_none() && self.retry_at.is_none_or(|at| at <= now) && self.reaped()
    }

    /// As an answer shows it, with the state `settle` read of a session
    /// that goes on.
    fn row(&self, session: Option<&Snapshot>) -> Row {
        let live = match session {
            Some(snapshot) => match (&snapshot.hello, snapshot.last_frame) {
                (Some(hello), Some(last_frame)) => Live::Online { hello: hello.clone(), load: snapshot.load.clone(), last_frame },
                _ => Live::Connecting,
            },
            None => match (self.stop, self.retry_at) {
                (Some(code), _) => Live::Unavailable { code },
                (None, Some(retry_at)) => Live::Offline { retry_at },
                (None, None) => Live::Idle,
            },
        };
        Row { id: self.machine.id.clone(), name: self.machine.name.clone(), live, since: self.since }
    }
}

impl State {
    fn new() -> State {
        State {
            timing: Timing::PRODUCTION,
            ssh: "ssh".into(),
            entries: vec![],
            interest: None,
            generations: 0,
            checks: 0,
            manager: false,
            closed: false,
            jobs: HashMap::new(),
            job_sets: 0,
        }
    }

    fn entry(&mut self, id: &str) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|entry| entry.machine.id == id)
    }

    /// The records as the store has them now, in its order.
    fn reconcile(&mut self, stored: Vec<RemoteMachine>, now: Instant) {
        let mut before = std::mem::take(&mut self.entries);
        for machine in stored {
            let entry = match before.iter().position(|entry| entry.machine.id == machine.id) {
                Some(at) => {
                    let mut entry = before.remove(at);
                    entry.saved(machine, now);
                    entry
                }
                None => Entry::new(machine, now),
            };
            self.entries.push(entry);
        }
        for mut gone in before {
            gone.removed(now);
            self.entries.push(gone);
        }
    }

    /// Settles every session's news; returns the rows an answer lists.
    fn settle(&mut self, now: Instant) -> Vec<Row> {
        let (timing, checks) = (self.timing, self.checks);
        let mut rows = vec![];
        for entry in &mut self.entries {
            let session = entry.settle(now, &timing, checks);
            entry.gates.retain(|gate| !gate.is_reaped());
            if !entry.deleted {
                rows.push(entry.row(session.as_ref()));
            }
        }
        // A removed machine goes once every child it had is reaped.
        self.entries.retain(|entry| !(entry.deleted && entry.run.is_none() && entry.gates.is_empty()));
        rows
    }

    /// The interest lasts until 60 s after the GET, that instant excluded:
    /// the managing task wakes then and closes.
    fn interested(&self, now: Instant) -> bool {
        self.interest.is_some_and(|at| now.saturating_duration_since(at) < self.timing.interest)
    }

    /// Something wants a session on `id` now: the user's interest, or Jobs
    /// held there (until 60 s after the last went).
    fn wanted(&self, id: &str, now: Instant) -> bool {
        self.interested(now) || self.jobs.get(id).is_some_and(|hold| hold.wants(now, self.timing.interest))
    }

    /// When that want ends by itself, if it does: the later of the
    /// interest's end and 60 s after the last Job there went; never while
    /// Jobs are held there.
    fn wanted_until(&self, id: &str, now: Instant) -> Option<Instant> {
        let interest = self.timing.interest;
        let home = self.interest.filter(|_| self.interested(now)).map(|at| at + interest);
        match self.jobs.get(id) {
            Some(hold) if !hold.attempts.is_empty() => None,
            Some(hold) => home.max(hold.emptied.filter(|_| hold.wants(now, interest)).map(|at| at + interest)),
            None => home,
        }
    }

    /// The Jobs side's attempts as one pass found them; a machine left out
    /// holds none. A changed list is a new set. True when one changed.
    fn hold_jobs(&mut self, mut given: BTreeMap<String, Vec<Attempt>>, now: Instant) -> bool {
        let interest = self.timing.interest;
        let mut sets = self.job_sets;
        let mut changed = false;
        for (id, hold) in &mut self.jobs {
            let attempts = given.remove(id).unwrap_or_default();
            if *hold.attempts != attempts {
                sets += 1;
                changed = true;
                hold.set = sets;
                hold.emptied = attempts.is_empty().then_some(now);
                hold.attempts = Arc::new(attempts);
            }
        }
        for (id, attempts) in given.into_iter().filter(|(_, attempts)| !attempts.is_empty()) {
            sets += 1;
            changed = true;
            self.jobs.insert(id, JobsHold { set: sets, attempts: Arc::new(attempts), emptied: None });
        }
        self.job_sets = sets;
        self.jobs.retain(|_, hold| hold.wants(now, interest));
        changed
    }

    /// Asks each session for the set held on its machine (sent only when new,
    /// or again when its ask looks lost; link.rs `watch_jobs`).
    fn ask_jobs(&mut self) {
        let State { entries, jobs, .. } = self;
        for entry in entries.iter_mut() {
            if let (Some(run), Some(hold)) = (&mut entry.run, jobs.get(&entry.machine.id)) {
                run.link.watch_jobs(hold.set, &hold.attempts);
            }
        }
    }
}

impl Registry {
    pub(crate) fn new(timing: Timing, clock: Arc<dyn Clock>) -> Registry {
        let mut state = State::new();
        state.timing = timing;
        Registry {
            inner: Arc::new(Inner {
                clock,
                gate: tokio::sync::Mutex::new(()),
                state: Mutex::new(state),
                wake: Arc::new(Notify::new()),
                #[cfg(test)]
                steps: Default::default(),
                shutdown: std::sync::OnceLock::new(),
                jobs_wake: std::sync::OnceLock::new(),
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Tests: the program used as OpenSSH, and the timing.
    #[cfg(all(test, target_os = "linux", target_env = "gnu"))]
    pub(crate) fn configure(&self, ssh: &str, timing: Timing) {
        let mut state = self.state();
        state.ssh = ssh.into();
        state.timing = timing;
    }

    /// How a session here is started.
    pub(crate) fn options(&self) -> Options {
        let state = self.state();
        Options {
            ssh: state.ssh.clone(),
            limits: state.timing.limits,
            jobs_wake: self.inner.jobs_wake.get().cloned(),
            ..Default::default()
        }
    }

    /// The Jobs loop's wake-up (jobs::remote), notified when a session says
    /// an attempt held there changed. Once; later calls change nothing.
    pub(crate) fn wake_jobs_with(&self, wake: Arc<Notify>) {
        let _ = self.inner.jobs_wake.set(wake);
    }

    /// What each machine's current session says of the Jobs held there, by
    /// machine id: only machines with Jobs held and a session of this
    /// generation, never one that went before.
    pub(crate) fn jobs_views(&self) -> HashMap<String, JobsView> {
        let state = self.state();
        let mut views = HashMap::new();
        for entry in state.entries.iter().filter(|entry| !entry.deleted) {
            let (Some(run), Some(hold)) = (&entry.run, state.jobs.get(&entry.machine.id)) else { continue };
            let snapshot = run.link.snapshot();
            views.insert(entry.machine.id.clone(), JobsView {
                set: hold.set,
                attempts: hold.attempts.clone(),
                root: entry.machine.root().to_owned(),
                host_id: snapshot.hello.as_ref().and_then(|hello| hello.value.host_id.clone()),
                scan: snapshot.jobs.clone(),
                ended: snapshot.terminal.is_some(),
            });
        }
        views
    }

    pub(crate) fn closing(&self) -> Duration {
        self.state().timing.closing()
    }

    /// Core's shutdown watch (main.rs). From the moment it says true no
    /// start passes, since each one reads it under the state lock; and every
    /// session is asked to close then, before Core's other shutdown steps
    /// (the HTTP server's graceful end, OpenCode's stop) have run.
    /// `close_all` later only waits. Inside a Tokio runtime only.
    pub(crate) fn follow_shutdown(&self, shutdown: watch::Receiver<bool>) {
        if self.inner.shutdown.set(shutdown.clone()).is_err() {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        let mut shutdown = shutdown;
        tokio::spawn(async move {
            if shutdown.wait_for(|ending| *ending).await.is_err() {
                return;
            }
            if let Some(inner) = weak.upgrade() {
                inner.begin_shutdown();
            }
        });
    }

    pub(crate) async fn hold(&self) -> Held<'_> {
        Held(self.inner.gate.lock().await)
    }

    /// A machine added or edited, as just committed under `held`.
    pub(crate) fn saved(&self, _held: &Held<'_>, machine: &RemoteMachine) {
        let now = self.inner.clock.now();
        let mut state = self.state();
        match state.entry(&machine.id) {
            Some(entry) => entry.saved(machine.clone(), now),
            None => state.entries.push(Entry::new(machine.clone(), now)),
        }
    }

    /// A machine removed, as just committed under `held`.
    pub(crate) fn removed(&self, _held: &Held<'_>, id: &str) {
        let now = self.inner.clock.now();
        if let Some(entry) = self.state().entry(id) {
            entry.removed(now);
        }
    }

    /// A manual check of `machine` starts. Numbered in this Core only, so no
    /// clock and no check from before a restart can count as later.
    pub(crate) fn check_started(&self, machine: &RemoteMachine) -> CheckTicket {
        let mut state = self.state();
        state.checks += 1;
        CheckTicket { id: machine.id.clone(), target: machine.target.clone(), root: machine.root().to_owned(), seq: state.checks }
    }

    /// The check reached the machine and is the one now stored for it, as
    /// written under `held` (machines.rs). It ends a stop or a backoff there
    /// only if it started after that began and was of the machine's target
    /// and data root as they are now.
    pub(crate) fn check_reached(&self, _held: &Held<'_>, ticket: &CheckTicket) {
        let now = self.inner.clock.now();
        let mut state = self.state();
        let Some(entry) = state.entry(&ticket.id) else { return };
        if entry.deleted || fingerprint(&entry.machine) != (ticket.target.as_str(), ticket.root.as_str()) || ticket.seq <= entry.blocked {
            return;
        }
        if entry.stop.is_some() || entry.retry_at.is_some() {
            entry.since = now;
        }
        entry.stop = None;
        entry.retry_at = None;
        entry.failures = 0;
    }

    /// Asks every session to close and waits, all together, for their ends
    /// and for every child here to be reaped: at most `budget`, and never
    /// more than `Timing::closing`. What is still unreaped then stays so,
    /// with its reaper; nothing is taken for ended.
    pub(crate) async fn close_all(&self, how: Closing, budget: Duration) -> Closed {
        let clock = self.inner.clock.clone();
        let deadline = clock.now() + budget.min(self.closing());
        // After a GET or retry that is starting a session, never past the deadline.
        let held = tokio::select! {
            held = self.hold() => Some(held),
            _ = clock.sleep_until(deadline) => None,
        };
        let waits: Vec<(Option<watch::Receiver<Snapshot>>, super::link::ReapGate)> = {
            let mut state = self.state();
            if how == Closing::Shutdown {
                state.closed = true;
            }
            let mut waits = vec![];
            for entry in &mut state.entries {
                if let Some(run) = &mut entry.run {
                    run.link.close();
                    waits.push((Some(run.link.subscribe()), run.link.reap_gate()));
                }
                for gate in entry.gates.iter().filter(|gate| !gate.is_reaped()) {
                    waits.push((None, gate.clone()));
                }
            }
            waits
        };
        drop(held);
        let all = futures_util::future::join_all(waits.iter().map(|(state, gate)| async move {
            if let Some(state) = state {
                let _ = state.clone().wait_for(|now| now.terminal.is_some()).await;
            }
            gate.reaped().await;
        }));
        tokio::select! {
            _ = all => {}
            _ = clock.sleep_until(deadline) => {}
        }
        Closed { waited: waits.len(), unreaped: waits.iter().filter(|(_, gate)| !gate.is_reaped()).count() }
    }

    /// A session this test drives as `machine`'s current one, online with
    /// `host_id` as its hello's (jobs::remote_tests).
    #[cfg(test)]
    pub(crate) fn fake_session(&self, machine: &RemoteMachine, host_id: Option<&str>) -> FakeSession {
        let now = self.inner.clock.now();
        let mut state = self.state();
        state.generations += 1;
        let (link, fake) = Link::fake(state.generations);
        let hello = super::protocol::Hello {
            session_id: "ab".repeat(16),
            host_id: host_id.map(str::to_owned),
            boot_id: None,
            account_key: None,
            platform: super::protocol::Platform::Linux,
            python: "3.12.4".into(),
            cpu: None,
            memory: None,
            why: vec![],
        };
        fake.state.send_modify(|snapshot| {
            snapshot.phase = super::link::Phase::Online;
            snapshot.hello = Some(Arc::new(Stamped { value: hello, received: now }));
            snapshot.last_frame = Some(now);
        });
        let run = Run { link, hello: true };
        match state.entry(&machine.id) {
            Some(entry) => entry.run = Some(run),
            None => {
                let mut entry = Entry::new(machine.clone(), now);
                entry.run = Some(run);
                state.entries.push(entry);
            }
        }
        FakeSession(fake)
    }

    #[cfg(test)]
    pub(crate) fn managing(&self) -> bool {
        self.state().manager
    }

    #[cfg(test)]
    pub(crate) fn steps(&self) -> u64 {
        self.inner.steps.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn interest(&self) -> Option<Instant> {
        self.state().interest
    }

    /// The answer as a GET would give it now, without recording an interest
    /// or starting anything.
    #[cfg(test)]
    pub(crate) fn peek(&self) -> Value {
        let now = self.inner.clock.now();
        let (rows, silence) = {
            let mut state = self.state();
            (state.settle(now), state.timing.limits.silence)
        };
        live::answer(&rows, None, now, self.inner.clock.wall(), silence)
    }
}

impl Inner {
    /// Core is ending: shut down here, or its shutdown watch says so.
    fn ending(&self, state: &State) -> bool {
        state.closed || self.shutdown.get().is_some_and(|shutdown| *shutdown.borrow())
    }

    /// Nothing starts again; every session is asked to close now.
    fn begin_shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.closed = true;
        for entry in &mut state.entries {
            if let Some(run) = &mut entry.run {
                run.link.close();
            }
        }
        drop(state);
        self.wake.notify_one();
    }

    /// One session's news, if it is still this machine's current one.
    fn settle(&self, generation: u64) {
        let now = self.clock.now();
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (timing, checks) = (state.timing, state.checks);
        if let Some(entry) =
            state.entries.iter_mut().find(|entry| entry.run.as_ref().is_some_and(|run| run.link.generation() == generation))
        {
            entry.settle(now, &timing, checks);
        }
    }
}

/// `GET /api/machine-live`: records the interest, starts what may start,
/// and answers at once with each registered machine as it is now. A failed
/// read of the records starts nothing and records nothing.
pub(crate) async fn answer<H: Host>(host: &Arc<H>) -> Result<Value> {
    let registry = host.registry();
    let inner = &registry.inner;
    let held = registry.hold().await;
    let stored = host.registered().await?;
    let now = inner.clock.now();
    let starts: Vec<String> = {
        let mut state = registry.state();
        state.reconcile(stored, now);
        state.settle(now);
        // No interest is recorded, and nothing started, while an update drains.
        match (inner.ending(&state), host.admission().enter_work()) {
            (false, Ok(_permit)) => {
                state.interest = Some(now);
                state.entries.iter().filter(|entry| entry.can_start(now)).map(|entry| entry.machine.id.clone()).collect()
            }
            _ => vec![],
        }
    };
    for id in starts {
        if !start(host, &held, &id, |entry, _, now| entry.can_start(now)) {
            break;
        }
    }
    drop(held);
    let (rows, silence) = {
        let now = inner.clock.now();
        let mut state = registry.state();
        (state.settle(now), state.timing.limits.silence)
    };
    let local = host.local_host();
    Ok(live::answer(&rows, local.as_deref(), inner.clock.now(), inner.clock.wall(), silence))
}

/// Starts a session on `id` if `may` still holds, under `held` and a short
/// work permit. False once no permit is given (an update drains) or Core
/// is ending: no other start should be tried then.
fn start<H: Host>(host: &Arc<H>, _held: &Held<'_>, id: &str, may: impl Fn(&Entry, &State, Instant) -> bool) -> bool {
    let registry = host.registry();
    let inner = &registry.inner;
    let Ok(permit) = host.admission().enter_work() else { return false };
    let (machine, generation) = {
        let now = inner.clock.now();
        let mut state = registry.state();
        if inner.ending(&state) {
            return false;
        }
        let Some(at) = state.entries.iter().position(|entry| entry.machine.id == id) else { return true };
        if !may(&state.entries[at], &state, now) {
            return true;
        }
        state.generations += 1;
        (state.entries[at].machine.clone(), state.generations)
    };
    let started = host.start(&machine, generation);
    let now = inner.clock.now();
    let draining = host.admission().snapshot().operation_id.is_some();
    {
        let mut state = registry.state();
        let checks = state.checks;
        // Core's shutdown, sent while it started, reads here too.
        let closed = inner.ending(&state);
        let asked = state.jobs.get(id).map(|hold| (hold.set, hold.attempts.clone()));
        // Under the gate nothing else changes which machine this is.
        let Some(entry) = state.entry(id) else { return true };
        entry.retry_at = None;
        entry.since = now;
        match started {
            Ok(mut link) => {
                if let Some((set, attempts)) = &asked {
                    link.watch_jobs(*set, attempts);
                }
                let changes = link.subscribe();
                if draining || closed {
                    // An update began draining, or Core's shutdown was
                    // sent, while it started.
                    link.close();
                }
                entry.run = Some(Run { link, hello: false });
                watch_session(inner, changes, generation);
            }
            Err(_) => {
                // A record that does not validate: nothing can start there
                // until it changes.
                entry.stop = Some("machine_invalid");
                entry.blocked = checks;
            }
        }
    }
    drop(permit);
    ensure_manager(host);
    true
}

/// Settles a session's hello and its end as they come.
fn watch_session(inner: &Arc<Inner>, mut changes: watch::Receiver<Snapshot>, generation: u64) {
    let weak = Arc::downgrade(inner);
    let wake = inner.wake.clone();
    tokio::spawn(async move {
        let mut hello = false;
        loop {
            let (said_hello, ended) = {
                let now = changes.borrow_and_update();
                (now.hello.is_some(), now.terminal.is_some())
            };
            if ended || (said_hello && !hello) {
                hello = said_hello;
                let Some(inner) = weak.upgrade() else { return };
                inner.settle(generation);
                drop(inner);
                wake.notify_one();
                if ended {
                    return;
                }
            }
            if changes.changed().await.is_err() {
                if let Some(inner) = weak.upgrade() {
                    inner.settle(generation);
                }
                wake.notify_one();
                return;
            }
        }
    });
}

/// A session a test drives (`Registry::fake_session`).
#[cfg(test)]
pub(crate) struct FakeSession(super::link::FakeLink);

#[cfg(test)]
impl FakeSession {
    /// The set it was last asked to scan.
    pub(crate) fn asked(&self) -> Option<(u64, Vec<Attempt>)> {
        self.0.wanted.borrow().as_ref().map(|want| (want.set, want.attempts.to_vec()))
    }

    /// Its newest jobs event: of `set`, received at `received` with no age,
    /// answered or not, these changes said so far.
    pub(crate) fn scan(&self, set: u64, answered: bool, changed: BTreeMap<Attempt, Instant>, received: Instant) {
        let why = (!answered).then_some(super::protocol::JobsWhy::Unanswered);
        let scan = Arc::new(Stamped { value: JobsScan { set, age: Duration::ZERO, why, changed }, received });
        self.0.state.send_modify(|snapshot| snapshot.jobs = Some(scan));
    }
}

/// When to look again, and whether a session runs (an update's drain then
/// closes it).
struct Next {
    at: Option<Instant>,
    runs: bool,
}

/// Starts the one task that manages the registry, unless it runs.
fn ensure_manager<H: Host>(host: &Arc<H>) {
    let inner = &host.registry().inner;
    {
        let mut state = host.registry().state();
        if state.manager {
            return;
        }
        state.manager = true;
    }
    let weak = Arc::downgrade(host);
    let wake = inner.wake.clone();
    let admission = host.admission().clone();
    let clock = inner.clock.clone();
    tokio::spawn(async move {
        loop {
            let changed = admission.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let woken = wake.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            // Of the admission's changes only a drain's start or end is news
            // here; every permit's end notifies too, and is let pass.
            let draining = admission.snapshot().operation_id.is_some();
            let Some(host) = weak.upgrade() else { return };
            let Some(next) = manage(&host).await else { return };
            drop(host);
            let sleep = next.at.map(|at| clock.sleep_until(at));
            let sleep = async move {
                match sleep {
                    Some(sleep) => sleep.await,
                    None => std::future::pending().await,
                }
            };
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut woken => break,
                    _ = &mut sleep => break,
                    _ = &mut changed, if next.runs => {
                        if admission.snapshot().operation_id.is_some() != draining {
                            break;
                        }
                        changed.set(admission.changed.notified());
                        changed.as_mut().enable();
                        if admission.snapshot().operation_id.is_some() != draining {
                            break;
                        }
                    }
                }
            }
        }
    });
}

/// One step: settle what sessions said; close each once nothing wants it
/// (no interest, no Jobs held there), an update drains or Core ends; start
/// again where a backoff ended while something wants it, and make the rest
/// idle. None when there is nothing left to manage (the task then ends).
async fn manage<H: Host>(host: &Arc<H>) -> Option<Next> {
    let registry = host.registry();
    let inner = &registry.inner;
    #[cfg(test)]
    inner.steps.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let now = inner.clock.now();
    let draining = host.admission().snapshot().operation_id.is_some();
    let due: Vec<String> = {
        let mut state = registry.state();
        state.settle(now);
        let interest = state.timing.interest;
        state.jobs.retain(|_, hold| hold.wants(now, interest));
        let wanted: HashSet<String> = if draining || inner.ending(&state) {
            HashSet::new()
        } else {
            state.entries.iter().filter(|entry| state.wanted(&entry.machine.id, now)).map(|entry| entry.machine.id.clone()).collect()
        };
        let mut due = vec![];
        for entry in &mut state.entries {
            let interested = wanted.contains(&entry.machine.id);
            if let Some(run) = &mut entry.run {
                if !interested {
                    run.link.close();
                }
            } else if entry.retry_at.is_some_and(|at| at <= now) {
                if interested && entry.can_start(now) {
                    due.push(entry.machine.id.clone());
                } else {
                    // Its backoff ended without the interest: idle until the next.
                    entry.retry_at = None;
                    entry.since = now;
                }
            }
        }
        if due.is_empty() {
            let runs = state.entries.iter().any(|entry| entry.run.is_some());
            let retry = state.entries.iter().filter_map(|entry| entry.retry_at).min();
            if !runs && retry.is_none() {
                state.manager = false;
                return None;
            }
            let close_at = state
                .entries
                .iter()
                .filter(|entry| entry.run.is_some() && wanted.contains(&entry.machine.id))
                .filter_map(|entry| state.wanted_until(&entry.machine.id, now))
                .min();
            return Some(Next { at: close_at.into_iter().chain(retry).min(), runs });
        }
        due
    };
    let held = registry.hold().await;
    match host.registered().await {
        Ok(stored) => {
            let now = inner.clock.now();
            registry.state().reconcile(stored, now);
            for id in &due {
                let may = |entry: &Entry, state: &State, now: Instant| {
                    entry.retry_at.is_some() && entry.can_start(now) && state.wanted(&entry.machine.id, now)
                };
                if !start(host, &held, id, may) {
                    break;
                }
            }
        }
        Err(_) => {
            // Without the records as they are now, nothing starts: idle
            // until the next interest reads them again.
            let now = inner.clock.now();
            let mut state = registry.state();
            for id in &due {
                if let Some(entry) = state.entry(id) {
                    entry.retry_at = None;
                    entry.since = now;
                }
            }
        }
    }
    drop(held);
    Some(Next { at: Some(inner.clock.now()), runs: true })
}

/// The remote Jobs held on each SSH machine, as one pass of the Jobs loop
/// found them (jobs::remote; YN-83 S2 PR4): by machine id, the attempts whose
/// start was sent and that hold their slot; a machine left out holds none.
/// Jobs held on a machine want a session there, as the user's interest
/// does, until 60 s after the last went. A session that may start there by
/// the usual rules (no stop, backoff or unreaped child, no drain, Core not
/// ending) is started under the gate from the records read again, and each
/// session is asked to scan its machine's set. Nothing here changes a Job.
pub(crate) async fn hold_jobs<H: Host>(host: &Arc<H>, attempts: BTreeMap<String, Vec<Attempt>>) {
    let registry = host.registry();
    let inner = &registry.inner;
    let now = inner.clock.now();
    let (changed, starts) = {
        let mut state = registry.state();
        let changed = state.hold_jobs(attempts, now);
        state.settle(now);
        state.ask_jobs();
        let starts: Vec<String> = if inner.ending(&state) {
            vec![]
        } else {
            let state = &*state;
            state
                .jobs
                .iter()
                .filter(|(id, hold)| {
                    !hold.attempts.is_empty()
                        && state.entries.iter().find(|entry| &entry.machine.id == *id).is_none_or(|entry| entry.can_start(now))
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        (changed, starts)
    };
    if changed {
        // When a session closes may have changed.
        inner.wake.notify_one();
    }
    if starts.is_empty() || host.admission().snapshot().operation_id.is_some() {
        return;
    }
    let held = registry.hold().await;
    let Ok(stored) = host.registered().await else { return };
    {
        let now = inner.clock.now();
        let mut state = registry.state();
        state.reconcile(stored, now);
        state.settle(now);
    }
    for id in starts {
        let may = |entry: &Entry, state: &State, now: Instant| {
            entry.can_start(now) && state.jobs.get(&entry.machine.id).is_some_and(|hold| !hold.attempts.is_empty())
        };
        if !start(host, &held, &id, may) {
            break;
        }
    }
}
