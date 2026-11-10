//! Answering an OpenCode permission request for real (YN-78 S4b-1; design v4
//! 2.4, with the Dev Lead's activity 8489): a bounded queue, a bounded
//! preparation, the delivery and check rounds, and the interrupt/teardown
//! after an answer whose fate is unknown.
//!
//! **Private and unwired.** Nothing here is called by an event, a snapshot,
//! `ask()`, Core's user queue or the start-up rules yet. Only tests call it.
//! S4b-2 will feed it; until then every permission level asks the user
//! exactly as before, and no answer is sent by Core for a real request.
//!
//! **One request, one answer.** A request is named by its connection
//! generation, session and request ID. The first submission takes the queue
//! slot and fixes its preparation deadline; a duplicate (another event, a
//! snapshot read, a repeated call) joins the same work and never moves that
//! deadline or sends a second first answer. A request already finished is
//! reported with the same decision and outcome. The API returns structured
//! reports; it never logs a message, a tool input or a request's content.
//!
//! **Preparation (20 s).** From the first submission, queueing, the one
//! message read of binding (`min(15 s, what is left)`, body included), and
//! the blocking file-system decision all share one absolute deadline. The
//! filesystem runs in a bounded blocking worker: one per connection, four
//! for Core, and a worker whose result is abandoned after the deadline keeps
//! its permit until it really ends. A preparation that runs out becomes a
//! stable Reject (`Reason::PreparationTimeout`) and goes through the same
//! bounded delivery; one that cannot even be serialized with its session
//! closes the connection instead, never the user's prompt.
//!
//! **Queue bounds.** At most 64 active requests and EVENT_BUFFER_LIMIT bytes
//! of recorded request data. A submission that cannot be admitted closes
//! this one connection on its fault path, once (SIGTERM, TEARDOWN, KILL),
//! and every request it held gets a structured `Overloaded` report; no
//! request becomes a user prompt and no fake rejection is sent.
//!
//! **Delivery (30 s, then 15 + 10 + 12).** The first POST starts `t0`; the
//! absolute delivery deadline is `t0 + 30 s`. Each POST and each check GET
//! uses `min(15 s, what is left)`, body included. At most three rounds: 204
//! is delivered, 404 is gone, 400 is checked and retried, and a timeout or a
//! lost connection is unknown and checked. A 200 still waiting is retried
//! after 0.1, 0.5 or 2 s. If it is still unknown at the deadline, the
//! request's own session is interrupted (15 s), then its disappearance is
//! awaited (10 s), then the captured runtime is ended: SIGTERM, TEARDOWN,
//! and an explicit SIGKILL if it is still there. Sending SIGKILL is not the
//! kernel having ended it. The whole bound from acceptance is therefore at
//! most 20 + 67 = 87 s, plus the kernel's own exit time. Nothing is recorded
//! as rejected or exited because an HTTP answer was unknown or a close was
//! only requested.
//!
//! **Reject first, ask once.** Before a reject, the session's pending list
//! is read once; requests this controller already holds with a `Once`
//! decision are answered first, through the same ledger. The list never
//! creates a new task and never resets a deadline. A `permission.replied`
//! reject Core did not start is recorded as collateral, separately from
//! Core's own reject; concurrent new requests may still be rejected with it,
//! which is recorded, not denied.
//!
//! **Generations.** Every answer and every result checks that the captured
//! generation is still current first. A result from an older generation is
//! discarded, never sent, and the captured runtime is never re-looked-up: a
//! new runtime is not this one, and is not ended by this code.
#![cfg_attr(not(test), allow(dead_code, unused_imports))]

use crate::opencode::{PermissionDelivery, Reply};
use crate::opencode_permissions::{bind_within, Answer, Asked, Call, Calls, Connection, Decision, MessageReader, Reason, Unbound};
use anyhow::Result;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{watch, Semaphore};
use tokio::time::{sleep_until, timeout_at, Instant};
use crate::opencode::REQUEST_LIMIT;

/// What Core makes of one bound call (S4a's `decide`, run on the bounded
/// blocking worker). Tests may count, latch or block here.
pub(crate) trait Judge: Send + Sync {
    fn decide(&self, asked: &Asked, call: &Call) -> Decision;
}

impl<F> Judge for F where F: Fn(&Asked, &Call) -> Decision + Send + Sync {
    fn decide(&self, asked: &Asked, call: &Call) -> Decision {
        self(asked, call)
    }
}

/// From the first accepted request to its prepared decision (design v4 S4b,
/// Dev Lead 8489): queueing, the one message read and the file-system
/// decision together, never reset by a duplicate.
pub(crate) const PREPARE_LIMIT: Duration = Duration::from_secs(20);
/// The first POST's `t0` to the end of delivery and checking.
pub(crate) const DELIVERY_LIMIT: Duration = Duration::from_secs(30);
/// The interrupt stage after an unknown delivery.
pub(crate) const INTERRUPT_LIMIT: Duration = Duration::from_secs(15);
/// Waiting for the request to disappear, or its turn to end, after the
/// interrupt.
pub(crate) const SETTLE_LIMIT: Duration = Duration::from_secs(10);
/// Between the delivery rounds, as opencode_agent's RESUBSCRIBE.
pub(crate) const BACKOFF: [Duration; 3] = [Duration::from_millis(100), Duration::from_millis(500), Duration::from_secs(2)];
/// Even a 400 or an unanswered POST gives up after this many POSTs.
pub(crate) const ROUNDS: u8 = 3;
/// At most this many requests wait on one connection.
pub(crate) const REQUESTS: usize = 64;
/// At most this much request data is recorded on one connection.
pub(crate) const BYTES: usize = crate::opencode::EVENT_BUFFER_LIMIT;
/// Blocking file-system decisions: one per connection ...
pub(crate) const FS_CONNECTION: usize = 1;
/// ... and this many across Core.
pub(crate) const FS_GLOBAL: usize = 4;
/// How often the settle stage asks whether the request still waits.
const SETTLE_POLL: Duration = Duration::from_millis(100);

/// What became of one answer's delivery (2.4's four classes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Delivery {
    Delivered,
    Gone,
    /// 400: the payload was not taken; the request is still pending.
    Invalid,
    /// No answer, a timeout, a lost connection or another status.
    Unknown,
}

/// The connection's captured runtime, ended only through this same value.
pub(crate) trait Runtime: Send + Sync {
    /// The captured Agent, generation and Server are still the live one.
    fn current(&self) -> bool;
    /// SIGTERM to the captured process group.
    fn terminate(&self);
    /// Whether it ended within `limit`, without reaping it.
    fn ended_within<'a>(&'a self, limit: Duration) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
    /// SIGKILL to the captured process group.
    fn kill(&self);
}

/// The native calls the engine makes, on the captured Server. The wire is
/// not looked up again; a fake implements this in tests.
pub(crate) trait Native: Send + Sync {
    fn deliver<'a>(&'a self, session: &'a str, request: &'a str, answer: &'a Answer, limit: Duration)
        -> Pin<Box<dyn Future<Output = Delivery> + Send + 'a>>;
    fn pending<'a>(&'a self, session: &'a str, request: &'a str, limit: Duration)
        -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + Send + 'a>>;
    fn pending_all<'a>(&'a self, session: &'a str, limit: Duration)
        -> Pin<Box<dyn Future<Output = Result<Vec<Value>>> + Send + 'a>>;
    fn abort<'a>(&'a self, session: &'a str, limit: Duration)
        -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
}

impl Native for crate::opencode::Server {
    fn deliver<'a>(&'a self, session: &'a str, request: &'a str, answer: &'a Answer, limit: Duration)
        -> Pin<Box<dyn Future<Output = Delivery> + Send + 'a>> {
        Box::pin(async move {
            let (reply, message) = match answer {
                Answer::Once => (Reply::Once, None),
                Answer::Reject(reason) => (Reply::Reject, Some(reason.message())),
            };
            match self.answer_permission_within(session, request, reply, message.as_deref(), limit).await {
                Ok(PermissionDelivery::Delivered) => Delivery::Delivered,
                Ok(PermissionDelivery::Gone { .. }) => Delivery::Gone,
                Ok(PermissionDelivery::Invalid { .. }) => Delivery::Invalid,
                Ok(PermissionDelivery::Unknown(_)) | Err(_) => Delivery::Unknown,
            }
        })
    }

    fn pending<'a>(&'a self, session: &'a str, request: &'a str, limit: Duration)
        -> Pin<Box<dyn Future<Output = Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async move { self.pending_permission_within(session, request, limit).await })
    }

    fn pending_all<'a>(&'a self, session: &'a str, limit: Duration)
        -> Pin<Box<dyn Future<Output = Result<Vec<Value>>> + Send + 'a>> {
        Box::pin(async move { self.pending_permissions_within(session, limit).await })
    }

    fn abort<'a>(&'a self, session: &'a str, limit: Duration)
        -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move { self.abort_within(session, limit).await })
    }
}

/// What a request ended as. A name is a fact; none is a log line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// 204.
    Delivered,
    /// 404, before anything was sent, or the request no longer waited while
    /// it could still have been this answer.
    Gone,
    /// A `permission.replied` reject Core did not start (or did not deliver
    /// itself).
    Collateral,
    /// The request was gone after the interrupt, but what took the answer is
    /// unknown.
    Interrupted,
    /// The runtime ended after an unknown delivery, as `ended_within` saw it.
    Closed,
    /// SIGKILL was sent to the captured runtime after an unknown delivery;
    /// the kernel's exit was not confirmed.
    Killed,
    /// The generation changed before an answer was sent.
    Discarded,
    /// The connection closed on its queue's bound; `rounds` is how many POSTs
    /// actually started. `rounds == 0` is the only "nothing was sent" case; a
    /// positive count leaves delivery unknown and is never a rejection.
    Overloaded,
}

/// One structured answer, for a future UI and its checks. `notice` is the
/// reason sentence only when delivery or disappearance is a fact; never
/// before.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Report {
    pub generation: u64,
    pub session: String,
    pub request: String,
    pub answer: Option<Answer>,
    pub outcome: Outcome,
    /// How many POSTs actually started (0 only when none did).
    pub rounds: u8,
    pub collateral: bool,
    /// Core itself started the reject for this request.
    pub own_reject: bool,
    pub notice: Option<String>,
}

impl Report {
    fn size(&self) -> usize {
        self.session.len() + self.request.len() + self.notice.as_ref().map_or(0, String::len)
            + if self.collateral { 4 } else { 0 }
            + self.answer.as_ref().map_or(0, |answer| match answer {
                Answer::Once => 0,
                Answer::Reject(reason) => reason.code().len() + reason.message().len(),
            })
    }
}

/// A queued request, by generation, session and request ID.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Key {
    generation: u64,
    session: String,
    request: String,
}

/// What `submit` did. A duplicate joins the first work's report; a finished
/// request answers with its one report; `Full` means this connection is
/// closing on its bound and nothing was queued.
#[derive(Debug)]
pub(crate) enum Submission {
    Accepted(watch::Receiver<Option<Report>>),
    Joined(watch::Receiver<Option<Report>>),
    Known(Report),
    Full,
}

/// A queued request's shared state. Only this controller writes it; the
/// report is sent once, and every duplicate reads that one.
struct Entry {
    key: Key,
    prepare_deadline: Instant,
    size: usize,
    decision: Mutex<Option<Answer>>,
    preflight: AtomicBool,
    /// A reject of this request was started by Core.
    reject_started: AtomicBool,
    /// A reject event Core did not start was seen.
    collateral: AtomicBool,
    /// The absolute first-POST t0 of this request's delivery, shared by its
    /// worker and any preflight that answers it first.
    delivery_start: Mutex<Option<Instant>>,
    /// Attempts that have actually started, and the one terminal gate shared
    /// with `finish`: a POST cannot start after the report is published.
    terminal: Mutex<bool>,
    rounds: AtomicU8,
    finished: AtomicBool,
    report: watch::Sender<Option<Report>>,
}

impl Entry {
    fn finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    /// Reserves one POST before its HTTP starts: its first t0, one more
    /// attempt, and its absolute deadline. None when the report is already
    /// terminal or the three attempts are used.
    fn start_post(&self) -> Option<Instant> {
        let terminal = self.terminal.lock().unwrap();
        if *terminal {
            return None;
        }
        let attempts = self.rounds.load(Ordering::SeqCst);
        if attempts >= ROUNDS {
            return None;
        }
        let t0 = *self.delivery_start.lock().unwrap().get_or_insert_with(Instant::now);
        self.rounds.store(attempts + 1, Ordering::SeqCst);
        Some(t0)
    }
}

#[derive(Default)]
struct State {
    active: HashMap<Key, Arc<Entry>>,
    done: HashMap<Key, Report>,
    order: VecDeque<Key>,
    bytes: usize,
    closing: bool,
}

/// One connection's answer engine. Generic only so tests can drive the wire,
/// the message reader, the decision and the runtime with fakes; production
/// uses `Server` for `Native` and `MessageReader`.
pub(crate) struct Engine<R: MessageReader + 'static, J: Judge + 'static, N: Native + 'static> {
    pub(crate) generation: u64,
    /// The Agent's own session; a child session may be the request's.
    pub(crate) session: String,
    pub(crate) children: Vec<String>,
    calls: Arc<Calls>,
    reader: Arc<R>,
    judge: Arc<J>,
    native: Arc<N>,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
    runtime: Arc<dyn Runtime>,
    fs_connection: Arc<Semaphore>,
    fs_global: Arc<Semaphore>,
    /// The bound on recorded request data: active work plus retained reports.
    bytes_limit: usize,
    /// A test-only pause before a reject's preflight, so a Once request can
    /// be prepared and its worker queued on the same session first.
    #[cfg(test)]
    preflight_gate: Mutex<Option<(String, Arc<tokio::sync::Notify>)>>,
    state: Mutex<State>,
    sessions: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl<R: MessageReader + 'static, J: Judge + 'static, N: Native + 'static> Engine<R, J, N> {
    /// A controller for one captured connection. `current` answers whether
    /// its generation is still the live one; it is asked before every answer
    /// and before every write of a result that could otherwise cross one.
    pub(crate) fn new(generation: u64, session: String, children: Vec<String>, calls: Arc<Calls>, reader: Arc<R>,
        judge: Arc<J>, native: Arc<N>, current: Arc<dyn Fn() -> bool + Send + Sync>, runtime: Arc<dyn Runtime>) -> Self {
        Self {
            generation, session, children, calls, reader, judge, native, current, runtime,
            fs_connection: Arc::new(Semaphore::new(FS_CONNECTION)),
            fs_global: global_fs(),
            bytes_limit: BYTES,
            #[cfg(test)]
            preflight_gate: Mutex::new(None),
            state: Mutex::default(),
            sessions: Mutex::default(),
        }
    }

    /// Wires this controller's file-system permits to another set, so a test
    /// can prove the global bound without other tests' workers. Production
    /// always takes `FS_GLOBAL` from this module's one global set.
    #[cfg(test)]
    fn with_fs(mut self, connection: Arc<Semaphore>, global: Arc<Semaphore>) -> Self {
        self.fs_connection = connection;
        self.fs_global = global;
        self
    }

    /// A smaller byte budget, so a test can prove retained history is evicted
    /// before a submission is called overload.
    #[cfg(test)]
    fn with_bytes(mut self, limit: usize) -> Self {
        self.bytes_limit = limit;
        self
    }

    /// Pause this request's reject just before its preflight list.
    #[cfg(test)]
    fn with_preflight_gate(self, request: &str, gate: Arc<tokio::sync::Notify>) -> Self {
        *self.preflight_gate.lock().unwrap() = Some((request.to_owned(), gate));
        self
    }

    #[cfg(test)]
    async fn await_preflight_gate(&self, request: &str) {
        let gate = {
            let held = self.preflight_gate.lock().unwrap();
            held.as_ref().filter(|(only, _)| only == request).map(|(_, gate)| gate.clone())
        };
        if let Some(gate) = gate {
            gate.notified().await;
        }
    }

    /// Takes in a request. It returns at once: the work runs on its own task,
    /// and the caller never waits for the whole preparation or delivery.
    pub(crate) fn submit(self: &Arc<Self>, asked: &Asked) -> Submission {
        let key = Key { generation: self.generation, session: asked.session.clone(), request: asked.id.clone() };
        let size = asked.size();
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.active.get(&key) {
            return Submission::Joined(entry.report.subscribe());
        }
        if let Some(report) = state.done.get(&key) {
            return Submission::Known(report.clone());
        }
        if state.closing {
            return Submission::Full;
        }
        // Retained reports share the bound with active work, so old history
        // is dropped to make room before a submission is called overload.
        while state.bytes.saturating_add(size) > self.bytes_limit {
            let Some(oldest) = state.order.pop_front() else { break };
            if let Some(gone) = state.done.remove(&oldest) {
                state.bytes = state.bytes.saturating_sub(gone.size());
            }
        }
        if size > self.bytes_limit || state.active.len() >= REQUESTS || state.bytes.saturating_add(size) > self.bytes_limit {
            drop(state);
            self.fault();
            return Submission::Full;
        }
        let admitted = Instant::now();
        let (report, receiver) = watch::channel(None);
        let entry = Arc::new(Entry {
            key: key.clone(),
            prepare_deadline: admitted + PREPARE_LIMIT,
            size,
            decision: Mutex::new(None),
            preflight: AtomicBool::new(false),
            reject_started: AtomicBool::new(false),
            collateral: AtomicBool::new(false),
            delivery_start: Mutex::new(None),
            terminal: Mutex::new(false),
            rounds: AtomicU8::new(0),
            finished: AtomicBool::new(false),
            report,
        });
        state.bytes = state.bytes.saturating_add(size);
        state.active.insert(key, entry.clone());
        drop(state);
        let engine = self.clone();
        let asked = asked.clone();
        tokio::spawn(async move { engine.work(entry, asked).await; });
        Submission::Accepted(receiver)
    }

    /// One `permission.replied` event, for the collateral ledger only. It
    /// creates no work, and a late or duplicate event changes no terminal
    /// answer. A reject Core itself started is not collateral.
    pub(crate) fn replied(&self, session: &str, request: &str, decision: &str) {
        if decision != "reject" {
            return;
        }
        let key = Key { generation: self.generation, session: session.to_owned(), request: request.to_owned() };
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.active.get(&key) {
            if !entry.reject_started.load(Ordering::SeqCst) {
                entry.collateral.store(true, Ordering::SeqCst);
                if entry.decision.lock().unwrap().is_none() {
                    // It was answered by another request's reject before Core
                    // got to it; the work will see 404 and finish.
                    entry.collateral.store(true, Ordering::SeqCst);
                }
            }
        } else if let Some(report) = state.done.get_mut(&key) {
            if !report.collateral && !report.own_reject {
                report.collateral = true;
                state.bytes = state.bytes.saturating_add(4);
            }
        }
    }

    fn session_lock(&self, session: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.entry(session.to_owned()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }

    fn fault(self: &Arc<Self>) {
        let start = {
            let mut state = self.state.lock().unwrap();
            if state.closing {
                false
            } else {
                state.closing = true;
                true
            }
        };
        if start {
            let engine = self.clone();
            tokio::spawn(async move { engine.close_connection().await; });
        }
    }

    /// One close for the whole connection: every request it held gets an
    /// `Overloaded` report and no answer; then the same bounded abort, wait
    /// and teardown once.
    async fn close_connection(self: Arc<Self>) {
        let held: Vec<Arc<Entry>> = {
            let state = self.state.lock().unwrap();
            state.active.values().cloned().collect()
        };
        for entry in held {
            let answer = entry.decision.lock().unwrap().clone();
            self.finish(&entry, answer, Outcome::Overloaded).await;
        }
        let abort_until = Instant::now() + INTERRUPT_LIMIT;
        if (self.current)() {
            if let Some(limit) = remaining(abort_until) {
                let _ = self.native.abort(&self.session, limit).await;
            }
        }
        let wait_until = Instant::now() + SETTLE_LIMIT;
        sleep_until(wait_until).await;
        if self.runtime.current() {
            self.runtime.terminate();
            let until = wait_until + crate::opencode::TEARDOWN;
            let limit = remaining(until).unwrap_or_default();
            if !self.runtime.ended_within(limit).await && self.runtime.current() {
                self.runtime.kill();
            }
        }
    }

    async fn work(self: Arc<Self>, entry: Arc<Entry>, asked: Asked) {
        if !(self.current)() {
            self.finish(&entry, None, Outcome::Discarded).await;
            return;
        }
        // Binding and the blocking decision need no session order; answers
        // are serialized below, which lets a reject answer a prepared Once
        // request of the same session first.
        let answer = self.prepare(&entry, &asked).await;
        if entry.finished() {
            return;
        }
        let answer = match answer {
            Prepared::Answer(answer) => answer,
            Prepared::Discarded => {
                self.finish(&entry, None, Outcome::Discarded).await;
                return;
            }
        };
        if !(self.current)() {
            self.finish(&entry, None, Outcome::Discarded).await;
            return;
        }
        *entry.decision.lock().unwrap() = Some(answer.clone());
        let lock = self.session_lock(&asked.session);
        let held = match remaining(entry.prepare_deadline) {
            Some(_) => match timeout_at(entry.prepare_deadline, lock.lock()).await {
                Ok(held) => held,
                Err(_) => {
                    // Waiting to answer used the whole preparation: there is
                    // no safe point to send an answer through.
                    self.fault();
                    return;
                }
            },
            // The preparation bound is spent; the session's turn is free at
            // this instant or this answer cannot be serialized at all.
            None => match lock.try_lock() {
                Ok(held) => held,
                Err(_) => {
                    self.fault();
                    return;
                }
            },
        };
        if entry.finished() {
            return;
        }
        #[cfg(test)]
        self.await_preflight_gate(&asked.id).await;
        if matches!(answer, Answer::Reject(_)) {
            self.preflight(&entry, &asked).await;
        }
        if entry.finished() {
            return;
        }
        let outcome = self.deliver(&entry, &asked, answer.clone()).await;
        self.finish(&entry, Some(answer), outcome).await;
        drop(held);
    }

    async fn prepare(&self, entry: &Entry, asked: &Asked) -> Prepared {
        let deadline = entry.prepare_deadline;
        let Some(limit) = remaining(deadline) else { return Prepared::Answer(Answer::Reject(Reason::PreparationTimeout)) };
        let on = Connection { generation: self.generation, session: &self.session, children: &self.children };
        let bound = bind_within(asked, &on, &self.calls, &*self.reader, &*self.current, min(REQUEST_LIMIT, limit)).await;
        let call = match bound {
            Ok(call) => call,
            Err(Unbound::Stale) => return Prepared::Discarded,
            Err(_) if remaining(deadline).is_none() => return Prepared::Answer(Answer::Reject(Reason::PreparationTimeout)),
            Err(unbound) => return Prepared::Answer(Answer::Reject(Reason::Unbound(unbound))),
        };
        // The blocking decision: its worker holds both permits until the
        // closure really ends, even when this deadline abandons its result.
        let connection = match timeout_at(deadline, self.fs_connection.clone().acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            _ => return Prepared::Answer(Answer::Reject(Reason::PreparationTimeout)),
        };
        let global = match timeout_at(deadline, self.fs_global.clone().acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            _ => {
                drop(connection);
                return Prepared::Answer(Answer::Reject(Reason::PreparationTimeout));
            }
        };
        let (asked, call, judge) = (asked.clone(), call.clone(), self.judge.clone());
        let handle = tokio::task::spawn_blocking(move || {
            let _connection = connection;
            let _global = global;
            judge.decide(&asked, &call)
        });
        match timeout_at(deadline, handle).await {
            Ok(Ok(decision)) => Prepared::Answer(decision.answer),
            Ok(Err(_)) => Prepared::Answer(Answer::Reject(Reason::RulesInvalid)),
            Err(_) => Prepared::Answer(Answer::Reject(Reason::PreparationTimeout)),
        }
    }

    /// Before a reject: one list of this session's pending requests, and the
    /// requests this controller already holds with a Once decision are
    /// answered first. The list creates nothing and resets no deadline.
    async fn preflight(&self, entry: &Entry, asked: &Asked) {
        if entry.preflight.swap(true, Ordering::SeqCst) {
            return;
        }
        if !(self.current)() {
            return;
        }
        let Some(limit) = remaining(entry.prepare_deadline) else { return };
        let pending = match self.native.pending_all(&asked.session, min(REQUEST_LIMIT, limit)).await {
            Ok(items) => items,
            Err(_) => return,
        };
        if !(self.current)() {
            return;
        }
        for item in pending {
            let Some(id) = item["id"].as_str() else { continue };
            if id == asked.id {
                continue;
            }
            let key = Key { generation: self.generation, session: asked.session.clone(), request: id.to_owned() };
            let target = { self.state.lock().unwrap().active.get(&key).cloned() };
            let Some(target) = target else { continue };
            if target.finished() || !matches!(*target.decision.lock().unwrap(), Some(Answer::Once)) {
                continue;
            }
            // One real POST, sharing the target's one first-POST t0, absolute
            // deadline and attempt count with its own worker. A failure here
            // is handed to that worker without resetting any of them.
            let Some(caller_left) = remaining(entry.prepare_deadline) else { return };
            let _ = self.post_once(&target, &asked.session, id, Answer::Once, caller_left).await;
        }
    }

    /// One bounded POST for a request another reject is answering first. It
    /// reserves the target's attempt and first-POST t0 before the HTTP starts,
    /// so an overload close sees what really started; a failure leaves the
    /// target active for its own worker to continue.
    async fn post_once(&self, target: &Entry, session: &str, request: &str, answer: Answer, caller_left: Duration) -> Option<Delivery> {
        if target.finished() || caller_left.is_zero() {
            return None;
        }
        let t0 = *target.delivery_start.lock().unwrap();
        let until = t0.map(|t0| t0 + DELIVERY_LIMIT).unwrap_or_else(|| Instant::now() + DELIVERY_LIMIT);
        let Some(target_left) = remaining(until) else { return None };
        let limit = min(REQUEST_LIMIT, min(caller_left, target_left));
        if limit.is_zero() || !(self.current)() {
            return None;
        }
        let Some(t0) = target.start_post() else { return None };
        let Some(target_left) = remaining(t0 + DELIVERY_LIMIT) else { return None };
        let limit = min(limit, target_left);
        let result = self.native.deliver(session, request, &answer, limit).await;
        match result {
            Delivery::Delivered => self.finish(target, Some(answer), Outcome::Delivered).await,
            Delivery::Gone => self.finish(target, Some(answer), Outcome::Gone).await,
            Delivery::Invalid | Delivery::Unknown => {}
        }
        Some(result)
    }

    async fn deliver(&self, entry: &Entry, asked: &Asked, answer: Answer) -> Outcome {
        if entry.finished() {
            return Outcome::Overloaded;
        }
        // Its first POST, wherever it was sent (this worker or a preflight),
        // fixes one t0; every later POST shares its absolute deadline.
        let mut t0 = *entry.delivery_start.lock().unwrap();
        loop {
            if entry.finished() {
                return Outcome::Overloaded;
            }
            if !(self.current)() {
                return Outcome::Discarded;
            }
            let until = t0.map(|t0| t0 + DELIVERY_LIMIT).unwrap_or_else(|| Instant::now() + DELIVERY_LIMIT);
            if remaining(until).is_none() {
                break;
            }
            if entry.rounds.load(Ordering::SeqCst) >= ROUNDS {
                break;
            }
            // Reserve the attempt and its t0 before the HTTP starts: a close
            // that publishes while this response is in flight must see it.
            let start = match entry.start_post() {
                Some(start) => start,
                None => {
                    if entry.finished() {
                        return Outcome::Overloaded;
                    }
                    break;
                }
            };
            t0 = Some(start);
            if matches!(answer, Answer::Reject(_)) {
                entry.reject_started.store(true, Ordering::SeqCst);
            }
            let until = start + DELIVERY_LIMIT;
            let Some(limit) = remaining(until) else { break };
            let result = self.native.deliver(&asked.session, &asked.id, &answer, min(REQUEST_LIMIT, limit)).await;
            if entry.finished() {
                return Outcome::Overloaded;
            }
            if !(self.current)() {
                return Outcome::Discarded;
            }
            match result {
                Delivery::Delivered => return Outcome::Delivered,
                Delivery::Gone => return Outcome::Gone,
                Delivery::Invalid | Delivery::Unknown => {}
            }
            let attempts = entry.rounds.load(Ordering::SeqCst);
            if attempts >= ROUNDS {
                break;
            }
            let Some(limit) = remaining(until) else { break };
            match self.native.pending(&asked.session, &asked.id, min(REQUEST_LIMIT, limit)).await {
                Ok(None) => return Outcome::Gone,
                Ok(Some(_)) | Err(_) => {}
            }
            let wait = BACKOFF[usize::from(attempts.saturating_sub(1)).min(BACKOFF.len() - 1)];
            let Some(left) = remaining(until) else { break };
            if left <= wait {
                break;
            }
            sleep_until(Instant::now() + wait).await;
        }
        let _ = entry;
        self.unknown_tail(asked, t0.unwrap_or_else(Instant::now)).await
    }

    async fn unknown_tail(&self, asked: &Asked, t0: Instant) -> Outcome {
        let abort_until = t0 + DELIVERY_LIMIT + INTERRUPT_LIMIT;
        if !(self.current)() {
            return Outcome::Discarded;
        }
        if let Some(limit) = remaining(abort_until) {
            let _ = self.native.abort(&asked.session, min(REQUEST_LIMIT, limit)).await;
        }
        let wait_until = abort_until + SETTLE_LIMIT;
        loop {
            if !(self.current)() {
                return Outcome::Discarded;
            }
            let Some(limit) = remaining(wait_until) else { break };
            match self.native.pending(&asked.session, &asked.id, min(REQUEST_LIMIT, limit)).await {
                Ok(None) => return Outcome::Interrupted,
                Ok(Some(_)) | Err(_) => {}
            }
            let Some(left) = remaining(wait_until) else { break };
            sleep_until(Instant::now() + SETTLE_POLL.min(left)).await;
        }
        if !self.runtime.current() {
            return Outcome::Discarded;
        }
        self.runtime.terminate();
        let until = wait_until + crate::opencode::TEARDOWN;
        let limit = remaining(until).unwrap_or_default();
        if self.runtime.ended_within(limit).await {
            return if self.runtime.current() { Outcome::Closed } else { Outcome::Discarded };
        }
        if !self.runtime.current() {
            return Outcome::Discarded;
        }
        self.runtime.kill();
        Outcome::Killed
    }

    async fn finish(&self, entry: &Entry, answer: Option<Answer>, outcome: Outcome) {
        let mut terminal = entry.terminal.lock().unwrap();
        if *terminal {
            return;
        }
        *terminal = true;
        entry.finished.store(true, Ordering::SeqCst);
        drop(terminal);
        // The result is published only for the generation that is still the
        // live one; an older generation's delivery is discarded without a
        // notice, even if its last HTTP answer arrived.
        let (answer, outcome) = if !(self.current)() && !matches!(outcome, Outcome::Overloaded) {
            (None, Outcome::Discarded)
        } else {
            (answer, outcome)
        };
        let collateral = entry.collateral.load(Ordering::SeqCst);
        let own_reject = entry.reject_started.load(Ordering::SeqCst);
        // A request another reject took before Core had sent its own answer
        // is recorded as collateral, not as Core's delivery or a plain 404.
        let outcome = if collateral && !own_reject && outcome == Outcome::Gone {
            Outcome::Collateral
        } else {
            outcome
        };
        let notice = match (&answer, outcome) {
            (Some(Answer::Reject(reason)), Outcome::Delivered | Outcome::Gone) => Some(reason.message()),
            _ => None,
        };
        let report = Report {
            generation: entry.key.generation,
            session: entry.key.session.clone(),
            request: entry.key.request.clone(),
            answer,
            outcome,
            rounds: entry.rounds.load(Ordering::SeqCst),
            collateral,
            own_reject,
            notice,
        };
        {
            let mut state = self.state.lock().unwrap();
            state.active.remove(&entry.key);
            state.bytes = state.bytes.saturating_sub(entry.size);
            let size = report.size();
            state.bytes = state.bytes.saturating_add(size);
            state.order.push_back(entry.key.clone());
            state.done.insert(entry.key.clone(), report.clone());
            while state.bytes > self.bytes_limit {
                let Some(oldest) = state.order.pop_front() else { break };
                if let Some(gone) = state.done.remove(&oldest) {
                    state.bytes = state.bytes.saturating_sub(gone.size());
                }
            }
        }
        let _ = entry.report.send(Some(report));
    }
}

enum Prepared {
    Answer(Answer),
    Discarded,
}

fn remaining(until: Instant) -> Option<Duration> {
    let now = Instant::now();
    (until > now).then(|| until - now)
}

fn min(a: Duration, b: Duration) -> Duration {
    a.min(b)
}

/// Core's one bound on blocking file-system decisions, shared by every
/// connection of every Agent.
fn global_fs() -> Arc<Semaphore> {
    use std::sync::OnceLock;
    static GLOBAL: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GLOBAL.get_or_init(|| Arc::new(Semaphore::new(FS_GLOBAL))).clone()
}

#[cfg(test)]
mod tests;
