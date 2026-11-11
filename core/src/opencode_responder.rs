//! Answering an OpenCode permission request for real (YN-78 S4b; design v4
//! 2.4, with the Dev Lead's activities 8489 and 8632): a bounded queue, a
//! bounded preparation, a bounded wait to send, the delivery and check
//! rounds, and the interrupt/teardown after an answer whose fate is unknown.
//!
//! **Who feeds it.** One `Engine` per connection generation of a local
//! OpenCode executor at Auto-approve whose rules, instructions and this
//! responder started together (opencode_agent.rs, `opencode_start`). Its
//! live `permission.asked` events and its snapshot's pending requests come
//! here instead of the user's queue; nothing else does.
//!
//! **One request, one answer.** A request is named by its connection
//! generation, session and request ID. The first submission takes the queue
//! slot and fixes its preparation deadline; a duplicate (another event, a
//! snapshot read, a repeated call) joins the same work and never moves a
//! deadline or sends a second first answer. A request already finished is
//! reported with the same decision and outcome. The API returns structured
//! reports; it never logs a message, a tool input or a request's content.
//!
//! **Preparation (20 s).** From the first submission, the one message read
//! of binding (`min(15 s, what is left)`, body included) and the blocking
//! file-system decision share one absolute deadline. The file system runs
//! in a bounded blocking worker: one per connection, four for Core, and a
//! worker whose result is abandoned after the deadline keeps its permit
//! until it really ends. A preparation that runs out becomes a stable Reject
//! (`Reason::PreparationTimeout`). The moment the decision is formed is the
//! request's `ready_at`, set once.
//!
//! **Sending (30 s to the first POST).** Each session sends one permission
//! answer at a time, its POST and response body; nothing else holds that
//! turn: not the file system, a check GET, a backoff or an interrupt. First
//! answers go in the order they were ready; a retry goes to the end. Each
//! request waits in at most one place. From `ready_at`, its first POST must
//! start within FIRST_POST_LIMIT, the wait for its turn and a reject's
//! preflight included; one that can't closes the connection on its fault
//! path (`Fault::SendExpired`): no user prompt and no answer made up.
//!
//! **Reject first, ask once.** Before a reject's first POST its session's
//! pending list is read once. Of what it lists, the requests this
//! controller already holds as Once and that wait for their turn now are let
//! go first, for at most PRIORITY_WINDOW from the list and never past the
//! reject's own first-POST deadline. A promoted request still sends with its
//! own deadlines, attempts and checks; the reject keeps its place in the
//! queue and only waits; the session is never locked for it, and a Once
//! request that arrives later is not waited for. A `permission.replied`
//! reject Core did not start is recorded as collateral, separately from
//! Core's own reject.
//!
//! **Delivery (30 s, then 15 + 10 + 12).** The first POST starts `t0`; every
//! later wait, check GET, backoff and POST spends `t0 + 30 s`. Each POST and
//! each check GET uses `min(15 s, what is left)`, body included. At most
//! three POSTs: 204 is delivered, 404 is gone, 400 is checked and retried,
//! and a timeout or a lost connection is unknown and checked. A 200 still
//! waiting is retried after 0.1, 0.5 or 2 s. If it is still unknown at the
//! deadline, the request's own session is interrupted (15 s), then its
//! disappearance is awaited (10 s), then the captured runtime is ended:
//! SIGTERM, TEARDOWN, and an explicit SIGKILL if it is still there.
//!
//! **One teardown.** Every fault and every unknown tail of a connection ends
//! the same captured runtime once. A later one joins the earliest SIGTERM
//! and SIGKILL already planned, and may only move them sooner, never later.
//! From acceptance to sending SIGKILL is therefore at most BOUND =
//! 20 + 30 + 30 + 15 + 10 + 12 = 117 s, plus the kernel's own exit time.
//! Sending SIGKILL is not the kernel having ended it. Nothing is recorded as
//! rejected or exited because an HTTP answer was unknown or a close was
//! only requested.
//!
//! **Queue bounds.** At most 64 active requests and EVENT_BUFFER_LIMIT bytes
//! of recorded request data, retained reports included and evicted oldest
//! first. A submission that cannot be admitted closes this one connection
//! on its fault path (`Fault::Overload`), once; every request it held gets a
//! structured `Faulted` report with the POSTs that really started.
//!
//! **Generations.** Every answer and every result checks that the captured
//! generation is still current first. A result from an older generation is
//! discarded, never sent, and the captured runtime is never re-looked-up: a
//! new runtime is not this one, and is not ended by this code.

use crate::opencode::{PermissionDelivery, Reply, REQUEST_LIMIT, TEARDOWN};
use crate::opencode_permissions::{bind_within, Answer, Asked, Call, Calls, Connection, Decision, MessageReader, Reason, Unbound};
use anyhow::Result;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{watch, Notify, Semaphore};
use tokio::time::{sleep_until, timeout_at, Instant};

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
/// Dev Lead 8489): the one message read and the file-system decision
/// together, never reset by a duplicate.
pub(crate) const PREPARE_LIMIT: Duration = Duration::from_secs(20);
/// From a prepared decision (`ready_at`) to its first POST: the wait for the
/// session's turn and a reject's preflight together (Dev Lead 8632).
pub(crate) const FIRST_POST_LIMIT: Duration = Duration::from_secs(30);
/// The first POST's `t0` to the end of delivery and checking.
pub(crate) const DELIVERY_LIMIT: Duration = Duration::from_secs(30);
/// A reject's preflight: its one list and the Once requests it lets go first.
pub(crate) const PRIORITY_WINDOW: Duration = Duration::from_secs(15);
/// The interrupt stage after an unknown delivery.
pub(crate) const INTERRUPT_LIMIT: Duration = Duration::from_secs(15);
/// Waiting for the request to disappear, or its turn to end, after the
/// interrupt.
pub(crate) const SETTLE_LIMIT: Duration = Duration::from_secs(10);
/// From acceptance to sending SIGKILL, at most (Dev Lead 8632): the stages
/// above and TEARDOWN, one after the other.
pub(crate) const BOUND: Duration = Duration::from_secs(117);
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

const _: () = assert!(PREPARE_LIMIT.as_secs() + FIRST_POST_LIMIT.as_secs() + DELIVERY_LIMIT.as_secs() + INTERRUPT_LIMIT.as_secs()
    + SETTLE_LIMIT.as_secs() + TEARDOWN.as_secs() == BOUND.as_secs());

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

/// Why a connection closed on its fault path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fault {
    /// A submission over REQUESTS or BYTES.
    Overload,
    /// A prepared answer whose first POST could not start within
    /// FIRST_POST_LIMIT of its `ready_at`.
    SendExpired,
}

impl Fault {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Overload => "overload",
            Self::SendExpired => "send_expired",
        }
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
    /// The connection closed on its fault path; `rounds` is how many POSTs
    /// actually started. `rounds == 0` is the only "nothing was sent" case; a
    /// positive count leaves delivery unknown and is never a rejection.
    Faulted(Fault),
}

impl Outcome {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Delivered => "delivered",
            Self::Gone => "gone",
            Self::Collateral => "collateral",
            Self::Interrupted => "interrupted",
            Self::Closed => "closed",
            Self::Killed => "killed",
            Self::Discarded => "discarded",
            Self::Faulted(fault) => fault.code(),
        }
    }
}

/// One structured answer, for the record and its checks. `notice` is the
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
/// closing on its fault path and nothing was queued.
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
    /// When its decision was first formed; never moved.
    ready_at: Mutex<Option<Instant>>,
    /// A reject of this request was started by Core.
    reject_started: AtomicBool,
    /// A reject event Core did not start was seen.
    collateral: AtomicBool,
    /// The absolute first-POST t0 of this request's delivery.
    delivery_start: Mutex<Option<Instant>>,
    /// The one terminal gate shared with `finish`: a POST cannot start after
    /// the report is published.
    terminal: Mutex<bool>,
    /// POSTs that have actually started.
    rounds: AtomicU8,
    finished: AtomicBool,
    report: watch::Sender<Option<Report>>,
}

impl Entry {
    fn finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    /// Its decision, and the moment it was first formed.
    fn ready(&self, answer: Answer) -> Instant {
        *self.decision.lock().unwrap() = Some(answer);
        *self.ready_at.lock().unwrap().get_or_insert_with(Instant::now)
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
    /// Set once, by the first fault: the connection is closing.
    fault: Option<Fault>,
}

impl State {
    /// Drops the oldest retained reports until the bound holds.
    fn evict(&mut self, limit: usize) {
        while self.bytes > limit {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(gone) = self.done.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(gone.size());
            }
        }
    }
}

/// One session's sending order: one POST at a time, first answers in the
/// order they were ready, retries at the end.
#[derive(Default)]
struct Lane {
    state: Mutex<LaneState>,
    changed: Notify,
}

#[derive(Default)]
struct LaneState {
    /// A POST of this session is in flight.
    busy: bool,
    next: u64,
    /// Each request waiting, by its place.
    waiting: BTreeMap<u64, Waiting>,
}

struct Waiting {
    request: String,
    /// False while its reject's preflight lists.
    eligible: bool,
    /// Let go before the others until then.
    promoted_until: Option<Instant>,
    /// A reject's: it lets these go first while they wait, until then.
    behind: Option<(Vec<String>, Instant)>,
}

impl LaneState {
    /// Whose turn it is now: a promoted request first, else the first ready.
    fn chosen(&self, now: Instant) -> Option<u64> {
        if self.busy {
            return None;
        }
        let queued = |id: &str| self.waiting.values().any(|waiting| waiting.request == id);
        let ready = |waiting: &Waiting| waiting.eligible
            && waiting.behind.as_ref().is_none_or(|(ids, until)| now >= *until || !ids.iter().any(|id| queued(id)));
        self.waiting.iter().find(|(_, waiting)| waiting.promoted_until.is_some_and(|until| now < until) && ready(waiting))
            .or_else(|| self.waiting.iter().find(|(_, waiting)| ready(waiting)))
            .map(|(place, _)| *place)
    }

    /// The next moment the choice may change by time alone.
    fn next_window(&self, now: Instant) -> Option<Instant> {
        self.waiting.values()
            .flat_map(|waiting| waiting.promoted_until.into_iter().chain(waiting.behind.as_ref().map(|(_, until)| *until)))
            .filter(|until| *until > now).min()
    }
}

/// A session's one send in flight; dropping it lets the next go.
struct Turn<'a>(&'a Lane);

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().busy = false;
        self.0.changed.notify_waiters();
    }
}

impl Lane {
    /// A place at the end, for `request`.
    fn enqueue(&self, request: &str, eligible: bool) -> u64 {
        let place = {
            let mut state = self.state.lock().unwrap();
            let place = state.next;
            state.next += 1;
            state.waiting.insert(place, Waiting { request: request.to_owned(), eligible, promoted_until: None, behind: None });
            place
        };
        self.changed.notify_waiters();
        place
    }

    /// Of `ids`, those waiting for their turn now are let go first until
    /// `until`; they are returned.
    fn promote(&self, ids: &HashSet<String>, until: Instant) -> Vec<String> {
        let promoted = {
            let mut state = self.state.lock().unwrap();
            let mut promoted = Vec::new();
            for waiting in state.waiting.values_mut().filter(|waiting| waiting.eligible && ids.contains(&waiting.request)) {
                waiting.promoted_until = Some(waiting.promoted_until.map_or(until, |was| was.max(until)));
                promoted.push(waiting.request.clone());
            }
            promoted
        };
        self.changed.notify_waiters();
        promoted
    }

    /// A reject at `place` waits no more for its preflight: it keeps its
    /// place, behind what it promoted until their window ends.
    fn preflighted(&self, place: u64, behind: Option<(Vec<String>, Instant)>) {
        if let Some(waiting) = self.state.lock().unwrap().waiting.get_mut(&place) {
            waiting.eligible = true;
            waiting.behind = behind;
        }
        self.changed.notify_waiters();
    }

    fn leave(&self, place: u64) {
        self.state.lock().unwrap().waiting.remove(&place);
        self.changed.notify_waiters();
    }

    /// Waits for `place`'s turn until `deadline`. None when the deadline came
    /// first; its place is given up then.
    async fn turn(&self, place: u64, deadline: Instant) -> Option<Turn<'_>> {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let wake = {
                let mut state = self.state.lock().unwrap();
                let now = Instant::now();
                // At its deadline nothing more is sent, even if its turn
                // came at that same instant.
                if now >= deadline {
                    state.waiting.remove(&place);
                    drop(state);
                    self.changed.notify_waiters();
                    return None;
                }
                if state.chosen(now) == Some(place) {
                    state.busy = true;
                    state.waiting.remove(&place);
                    return Some(Turn(self));
                }
                state.next_window(now).map_or(deadline, |until| until.min(deadline))
            };
            tokio::select! {
                _ = &mut notified => {}
                _ = sleep_until(wake) => {}
            }
        }
    }
}

/// How the connection's one teardown ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ended {
    Closed,
    Killed,
    Discarded,
}

/// The connection's one teardown: when SIGTERM and SIGKILL are due, moved
/// only sooner, and how it ended.
struct Closing {
    plan: watch::Sender<(Instant, Instant)>,
    ended: watch::Receiver<Option<Ended>>,
}

/// One connection's answer engine. Generic only so tests can drive the wire,
/// the message reader, the decision and the runtime with fakes; production
/// uses `Server` for `Native` and `MessageReader`.
pub(crate) struct Engine<R: MessageReader + 'static, J: Judge + 'static, N: Native + 'static> {
    pub(crate) generation: u64,
    /// The Agent's own session; a child session may be the request's.
    pub(crate) session: String,
    /// The sub-agent sessions the connection knows now.
    children: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
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
    /// be prepared and queued on the same session first.
    #[cfg(test)]
    preflight_gate: Mutex<Option<(String, Arc<Notify>)>>,
    state: Mutex<State>,
    lanes: Mutex<HashMap<String, Arc<Lane>>>,
    closing: Mutex<Option<Closing>>,
}

impl<R: MessageReader + 'static, J: Judge + 'static, N: Native + 'static> Engine<R, J, N> {
    /// A controller for one captured connection. `current` answers whether
    /// its generation is still the live one; it is asked before every answer
    /// and before every write of a result that could otherwise cross one.
    /// `children` lists the sub-agent sessions the connection knows when a
    /// request is bound, not when the engine was made.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(generation: u64, session: String, children: Arc<dyn Fn() -> Vec<String> + Send + Sync>, calls: Arc<Calls>,
        reader: Arc<R>, judge: Arc<J>, native: Arc<N>, current: Arc<dyn Fn() -> bool + Send + Sync>, runtime: Arc<dyn Runtime>) -> Self {
        Self {
            generation, session, children, calls, reader, judge, native, current, runtime,
            fs_connection: Arc::new(Semaphore::new(FS_CONNECTION)),
            fs_global: global_fs(),
            bytes_limit: BYTES,
            #[cfg(test)]
            preflight_gate: Mutex::new(None),
            state: Mutex::default(),
            lanes: Mutex::default(),
            closing: Mutex::default(),
        }
    }

    /// The tool calls this connection's OpenCode reported, which binding reads.
    pub(crate) fn calls(&self) -> &Calls {
        &self.calls
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
    fn with_preflight_gate(self, request: &str, gate: Arc<Notify>) -> Self {
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
    /// and the caller never waits for the preparation, a file system or HTTP.
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
        if state.fault.is_some() {
            return Submission::Full;
        }
        // Retained reports share the bound with active work, so old history
        // is dropped to make room before a submission is called overload.
        let limit = self.bytes_limit.saturating_sub(size);
        state.evict(limit);
        if size > self.bytes_limit || state.active.len() >= REQUESTS || state.bytes.saturating_add(size) > self.bytes_limit {
            drop(state);
            self.fault(Fault::Overload);
            return Submission::Full;
        }
        let (report, receiver) = watch::channel(None);
        let entry = Arc::new(Entry {
            key: key.clone(),
            prepare_deadline: Instant::now() + PREPARE_LIMIT,
            size,
            decision: Mutex::new(None),
            ready_at: Mutex::new(None),
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
            // Before Core's own answer, or another request's reject took it.
            if !entry.reject_started.load(Ordering::SeqCst) {
                entry.collateral.store(true, Ordering::SeqCst);
            }
            return;
        }
        let marked = state.done.get_mut(&key).filter(|report| !report.collateral && !report.own_reject).map(|report| {
            report.collateral = true;
        });
        if marked.is_some() {
            // The flag is retained history too: the bound holds at once.
            state.bytes = state.bytes.saturating_add(4);
            state.evict(self.bytes_limit);
        }
    }

    fn lane(&self, session: &str) -> Arc<Lane> {
        self.lanes.lock().unwrap().entry(session.to_owned()).or_default().clone()
    }

    /// The connection's one fault: the first cause closes it, a later one
    /// changes nothing.
    fn fault(self: &Arc<Self>, cause: Fault) {
        let start = {
            let mut state = self.state.lock().unwrap();
            if state.fault.is_some() {
                false
            } else {
                state.fault = Some(cause);
                true
            }
        };
        if start {
            let engine = self.clone();
            tokio::spawn(async move { engine.close_connection(cause).await; });
        }
    }

    /// One close for the whole connection: every request it held gets a
    /// `Faulted` report and no answer; then the main session is interrupted,
    /// and the connection's one teardown is joined.
    async fn close_connection(self: Arc<Self>, cause: Fault) {
        let held: Vec<Arc<Entry>> = {
            let state = self.state.lock().unwrap();
            state.active.values().cloned().collect()
        };
        for entry in held {
            let answer = entry.decision.lock().unwrap().clone();
            self.finish(&entry, answer, Outcome::Faulted(cause)).await;
        }
        let abort_until = Instant::now() + INTERRUPT_LIMIT;
        if (self.current)() {
            if let Some(limit) = remaining(abort_until) {
                let _ = self.native.abort(&self.session, REQUEST_LIMIT.min(limit)).await;
            }
        }
        let term_at = Instant::now().min(abort_until) + SETTLE_LIMIT;
        let _ = self.teardown(term_at, term_at + TEARDOWN).await;
    }

    async fn work(self: Arc<Self>, entry: Arc<Entry>, asked: Asked) {
        if !(self.current)() {
            self.finish(&entry, None, Outcome::Discarded).await;
            return;
        }
        let answer = match self.prepare(&entry, &asked).await {
            _ if entry.finished() => return,
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
        let ready_at = entry.ready(answer.clone());
        let first_post_until = ready_at + FIRST_POST_LIMIT;
        let lane = self.lane(&asked.session);
        let reject = matches!(answer, Answer::Reject(_));
        // Its place in the session's order is taken now; a reject's waits
        // until its preflight has listed the session.
        let place = lane.enqueue(&asked.id, !reject);
        if reject {
            #[cfg(test)]
            self.await_preflight_gate(&asked.id).await;
            self.preflight(&asked, &lane, place, first_post_until).await;
        }
        if let Some(outcome) = self.deliver(&entry, &asked, &answer, &lane, place, first_post_until).await {
            self.finish(&entry, Some(answer), outcome).await;
        }
    }

    async fn prepare(&self, entry: &Entry, asked: &Asked) -> Prepared {
        let deadline = entry.prepare_deadline;
        let Some(limit) = remaining(deadline) else { return Prepared::Answer(Answer::Reject(Reason::PreparationTimeout)) };
        let children = (self.children)();
        let on = Connection { generation: self.generation, session: &self.session, children: &children };
        let bound = bind_within(asked, &on, &self.calls, &*self.reader, &*self.current, REQUEST_LIMIT.min(limit)).await;
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
            _ => return Prepared::Answer(Answer::Reject(Reason::PreparationTimeout)),
        };
        let (asked, call, judge) = (asked.clone(), call.clone(), self.judge.clone());
        let handle = tokio::task::spawn_blocking(move || {
            let _held = (connection, global);
            judge.decide(&asked, &call)
        });
        match timeout_at(deadline, handle).await {
            Ok(Ok(decision)) => Prepared::Answer(decision.answer),
            Ok(Err(_)) => Prepared::Answer(Answer::Reject(Reason::RulesInvalid)),
            Err(_) => Prepared::Answer(Answer::Reject(Reason::PreparationTimeout)),
        }
    }

    /// Before a reject's first POST: one list of its session's pending
    /// requests. Those this controller already holds as Once, and that wait
    /// for their turn now, go first for at most PRIORITY_WINDOW, never past
    /// the reject's own first-POST deadline. The list creates nothing and
    /// moves no deadline; the reject keeps its place.
    async fn preflight(&self, asked: &Asked, lane: &Lane, place: u64, first_post_until: Instant) {
        let window = (Instant::now() + PRIORITY_WINDOW).min(first_post_until);
        let mut behind = None;
        if let (true, Some(limit)) = ((self.current)(), remaining(window)) {
            if let Ok(listed) = self.native.pending_all(&asked.session, REQUEST_LIMIT.min(limit)).await {
                if (self.current)() {
                    let held: HashSet<String> = {
                        let state = self.state.lock().unwrap();
                        listed.iter().filter_map(|item| item["id"].as_str()).filter(|id| *id != asked.id).filter(|id| {
                            let key = Key { generation: self.generation, session: asked.session.clone(), request: (*id).to_owned() };
                            state.active.get(&key).is_some_and(|target| !target.finished()
                                && matches!(*target.decision.lock().unwrap(), Some(Answer::Once)))
                        }).map(str::to_owned).collect()
                    };
                    let promoted = lane.promote(&held, window);
                    if !promoted.is_empty() {
                        behind = Some((promoted, window));
                    }
                }
            }
        }
        lane.preflighted(place, behind);
    }

    /// The answer's POSTs, each in its session's turn, with the checks and
    /// backoff between them outside it. None when the connection is closing
    /// on its fault path, which publishes this request's report itself.
    async fn deliver(self: &Arc<Self>, entry: &Entry, asked: &Asked, answer: &Answer, lane: &Lane, first: u64,
        first_post_until: Instant) -> Option<Outcome> {
        let mut queued = Some(first);
        loop {
            if entry.finished() || !(self.current)() {
                if let Some(place) = queued.take() {
                    lane.leave(place);
                }
                return (!entry.finished()).then_some(Outcome::Discarded);
            }
            let t0 = *entry.delivery_start.lock().unwrap();
            if entry.rounds.load(Ordering::SeqCst) >= ROUNDS {
                break;
            }
            // Before its first POST: FIRST_POST_LIMIT from ready; after it,
            // everything spends t0 + DELIVERY_LIMIT.
            let until = t0.map_or(first_post_until, |t0| t0 + DELIVERY_LIMIT);
            let place = queued.take().unwrap_or_else(|| lane.enqueue(&asked.id, true));
            let Some(turn) = lane.turn(place, until).await else {
                if t0.is_none() {
                    // Its first answer could not even be sent in time: the
                    // connection closes on its fault path, never the user's prompt.
                    self.fault(Fault::SendExpired);
                    return None;
                }
                break;
            };
            if entry.finished() {
                return None;
            }
            if !(self.current)() {
                return Some(Outcome::Discarded);
            }
            // Reserve the attempt and its t0 before the HTTP starts: a close
            // that publishes while this response is in flight must see it.
            let Some(t0) = entry.start_post() else {
                if entry.finished() {
                    return None;
                }
                break;
            };
            if matches!(answer, Answer::Reject(_)) {
                entry.reject_started.store(true, Ordering::SeqCst);
            }
            let until = t0 + DELIVERY_LIMIT;
            let Some(limit) = remaining(until) else { break };
            let result = self.native.deliver(&asked.session, &asked.id, answer, REQUEST_LIMIT.min(limit)).await;
            drop(turn);
            if entry.finished() {
                return None;
            }
            if !(self.current)() {
                return Some(Outcome::Discarded);
            }
            match result {
                Delivery::Delivered => return Some(Outcome::Delivered),
                Delivery::Gone => return Some(Outcome::Gone),
                Delivery::Invalid | Delivery::Unknown => {}
            }
            let attempts = entry.rounds.load(Ordering::SeqCst);
            if attempts >= ROUNDS {
                break;
            }
            let Some(limit) = remaining(until) else { break };
            if let Ok(None) = self.native.pending(&asked.session, &asked.id, REQUEST_LIMIT.min(limit)).await {
                return Some(Outcome::Gone);
            }
            let wait = BACKOFF[usize::from(attempts.saturating_sub(1)).min(BACKOFF.len() - 1)];
            let Some(left) = remaining(until) else { break };
            if left <= wait {
                break;
            }
            sleep_until(Instant::now() + wait).await;
        }
        let t0 = (*entry.delivery_start.lock().unwrap()).unwrap_or_else(Instant::now);
        Some(self.unknown_tail(asked, t0).await)
    }

    async fn unknown_tail(&self, asked: &Asked, t0: Instant) -> Outcome {
        let abort_until = t0 + DELIVERY_LIMIT + INTERRUPT_LIMIT;
        if !(self.current)() {
            return Outcome::Discarded;
        }
        if let Some(limit) = remaining(abort_until) {
            let _ = self.native.abort(&asked.session, REQUEST_LIMIT.min(limit)).await;
        }
        let term_at = abort_until + SETTLE_LIMIT;
        loop {
            if !(self.current)() {
                return Outcome::Discarded;
            }
            let Some(limit) = remaining(term_at) else { break };
            match self.native.pending(&asked.session, &asked.id, REQUEST_LIMIT.min(limit)).await {
                Ok(None) => return Outcome::Interrupted,
                Ok(Some(_)) | Err(_) => {}
            }
            let Some(left) = remaining(term_at) else { break };
            sleep_until(Instant::now() + SETTLE_POLL.min(left)).await;
        }
        self.teardown(term_at, term_at + TEARDOWN).await
    }

    /// Joins the connection's one teardown of its captured runtime: SIGTERM
    /// by `term_at`, SIGKILL by `kill_at`, or sooner when another fault
    /// already planned them sooner. The answer is how that one teardown ended.
    async fn teardown(&self, term_at: Instant, kill_at: Instant) -> Outcome {
        let mut ended = {
            let mut closing = self.closing.lock().unwrap();
            match &*closing {
                Some(planned) => {
                    planned.plan.send_modify(|(term, kill)| {
                        *term = (*term).min(term_at);
                        *kill = (*kill).min(kill_at);
                    });
                    planned.ended.clone()
                }
                None => {
                    let (plan, planned) = watch::channel((term_at, kill_at));
                    let (done, ended) = watch::channel(None);
                    tokio::spawn(run_teardown(self.runtime.clone(), planned, done));
                    *closing = Some(Closing { plan, ended: ended.clone() });
                    ended
                }
            }
        };
        let end = loop {
            if let Some(end) = *ended.borrow_and_update() {
                break end;
            }
            if ended.changed().await.is_err() {
                break Ended::Discarded;
            }
        };
        match end {
            Ended::Closed => Outcome::Closed,
            Ended::Killed => Outcome::Killed,
            Ended::Discarded => Outcome::Discarded,
        }
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
        let (answer, outcome) = if !(self.current)() && !matches!(outcome, Outcome::Faulted(_)) {
            (None, Outcome::Discarded)
        } else {
            (answer, outcome)
        };
        let collateral = entry.collateral.load(Ordering::SeqCst);
        let own_reject = entry.reject_started.load(Ordering::SeqCst);
        // A request another reject took before Core had sent its own answer
        // is recorded as collateral, not as Core's delivery or a plain 404.
        let outcome = if collateral && !own_reject && outcome == Outcome::Gone { Outcome::Collateral } else { outcome };
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
            state.bytes = state.bytes.saturating_sub(entry.size).saturating_add(report.size());
            state.order.push_back(entry.key.clone());
            state.done.insert(entry.key.clone(), report.clone());
            state.evict(self.bytes_limit);
        }
        let _ = entry.report.send(Some(report));
    }
}

/// The connection's one teardown: SIGTERM at the planned moment, SIGKILL at
/// the planned one if it has not ended; each only ever moved sooner. Signals
/// go only to the captured runtime, and only while it is still current.
async fn run_teardown(runtime: Arc<dyn Runtime>, mut plan: watch::Receiver<(Instant, Instant)>, done: watch::Sender<Option<Ended>>) {
    let mut following = true;
    loop {
        let (term_at, _) = *plan.borrow_and_update();
        if !following {
            sleep_until(term_at).await;
            break;
        }
        tokio::select! {
            _ = sleep_until(term_at) => break,
            changed = plan.changed() => following = changed.is_ok(),
        }
    }
    if !runtime.current() {
        done.send_replace(Some(Ended::Discarded));
        return;
    }
    runtime.terminate();
    let ended = loop {
        let (_, kill_at) = *plan.borrow_and_update();
        let limit = remaining(kill_at).unwrap_or_default();
        if !following {
            break runtime.ended_within(limit).await;
        }
        tokio::select! {
            ended = runtime.ended_within(limit) => break ended,
            changed = plan.changed() => following = changed.is_ok(),
        }
    };
    let end = if ended {
        if runtime.current() { Ended::Closed } else { Ended::Discarded }
    } else if runtime.current() {
        runtime.kill();
        Ended::Killed
    } else {
        Ended::Discarded
    };
    done.send_replace(Some(end));
}

enum Prepared {
    Answer(Answer),
    Discarded,
}

fn remaining(until: Instant) -> Option<Duration> {
    let now = Instant::now();
    (until > now).then(|| until - now)
}

/// Core's one bound on blocking file-system decisions, shared by every
/// connection of every Agent.
fn global_fs() -> Arc<Semaphore> {
    use std::sync::OnceLock;
    static GLOBAL: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GLOBAL.get_or_init(|| Arc::new(Semaphore::new(FS_GLOBAL))).clone()
}

/// Runs blocking file-system `work` under one of Core's global permits, as a
/// decision does, within `deadline`. None when the deadline came first; the
/// work keeps its permit until it really ends, and no other is started for it.
pub(crate) async fn bounded_fs<T: Send + 'static>(deadline: Instant, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let permit = timeout_at(deadline, global_fs().acquire_owned()).await.ok()?.ok()?;
    let handle = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    });
    timeout_at(deadline, handle).await.ok()?.ok()
}

#[cfg(test)]
mod tests;
