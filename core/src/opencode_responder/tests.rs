//! The bounded responder, on fakes: no OpenCode, no network, no real
//! process. The clocks are tokio's paused clock; the blocking file-system
//! worker is a closure the test can latch; every call is recorded.
use super::*;
use crate::opencode_permissions::{Answer, Asked, Call, Calls, Decision, Reason};
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use tokio::sync::{Notify, Semaphore};

#[derive(Clone, Debug)]
struct Sent {
    session: String,
    request: String,
    answer: Answer,
    limit: Duration,
    /// When the POST entered the native call, before its delay.
    at: Instant,
}

struct FakeNative {
    sent: StdMutex<Vec<Sent>>,
    results: StdMutex<VecDeque<Delivery>>,
    /// One request's own results, before the shared ones.
    results_for: StdMutex<HashMap<String, VecDeque<Delivery>>>,
    /// Each delivery's own delay before its result.
    delays: StdMutex<VecDeque<Duration>>,
    delays_for: StdMutex<HashMap<String, VecDeque<Duration>>>,
    /// `Some` makes every check GET return a waiting request; `None` pops
    /// `pending`.
    pending_always: StdMutex<Option<bool>>,
    pending: StdMutex<VecDeque<bool>>,
    /// How long each check GET takes.
    pending_delay: StdMutex<Duration>,
    /// When each check GET started, by request.
    checked: StdMutex<Vec<(String, Instant)>>,
    list: StdMutex<Vec<Value>>,
    /// When set, each delivery takes one permit. Closing it lets every
    /// waiter go, the current and any later one, so no wake-up is lost.
    gate: StdMutex<Option<Arc<Semaphore>>>,
    /// When set with a gate, only this session's deliveries wait.
    gate_for: StdMutex<Option<String>>,
    /// Runs after a delivery is recorded, before its result is returned.
    after_deliver: StdMutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// Signalled when a POST has entered the native call, before any response.
    entered: StdMutex<Option<Arc<Notify>>>,
    entered_count: AtomicUsize,
    aborts: AtomicUsize,
}

impl FakeNative {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            sent: StdMutex::default(),
            results: StdMutex::default(),
            results_for: StdMutex::default(),
            delays: StdMutex::default(),
            delays_for: StdMutex::default(),
            pending_always: StdMutex::default(),
            pending: StdMutex::default(),
            pending_delay: StdMutex::default(),
            checked: StdMutex::default(),
            list: StdMutex::default(),
            gate: StdMutex::default(),
            gate_for: StdMutex::default(),
            after_deliver: StdMutex::default(),
            entered: StdMutex::default(),
            entered_count: AtomicUsize::default(),
            aborts: AtomicUsize::default(),
        })
    }

    fn results(self: &Arc<Self>, results: impl IntoIterator<Item = Delivery>) -> Arc<Self> {
        self.results.lock().unwrap().extend(results);
        self.clone()
    }

    fn results_for(self: &Arc<Self>, request: &str, results: impl IntoIterator<Item = Delivery>) -> Arc<Self> {
        self.results_for.lock().unwrap().entry(request.to_owned()).or_default().extend(results);
        self.clone()
    }

    fn delays(self: &Arc<Self>, delays: impl IntoIterator<Item = Duration>) -> Arc<Self> {
        self.delays.lock().unwrap().extend(delays);
        self.clone()
    }

    fn delays_for(self: &Arc<Self>, request: &str, delays: impl IntoIterator<Item = Duration>) -> Arc<Self> {
        self.delays_for.lock().unwrap().entry(request.to_owned()).or_default().extend(delays);
        self.clone()
    }

    fn pending(self: &Arc<Self>, pending: impl IntoIterator<Item = bool>) -> Arc<Self> {
        self.pending.lock().unwrap().extend(pending);
        self.clone()
    }

    fn always_pending(self: &Arc<Self>, waiting: bool) -> Arc<Self> {
        *self.pending_always.lock().unwrap() = Some(waiting);
        self.clone()
    }

    fn pending_delay(self: &Arc<Self>, delay: Duration) -> Arc<Self> {
        *self.pending_delay.lock().unwrap() = delay;
        self.clone()
    }

    fn list(self: &Arc<Self>, list: Vec<Value>) -> Arc<Self> {
        *self.list.lock().unwrap() = list;
        self.clone()
    }

    /// Holds each delivery until the returned gate gives it a permit.
    fn hold(&self) -> Arc<Semaphore> {
        let gate = Arc::new(Semaphore::new(0));
        *self.gate.lock().unwrap() = Some(gate.clone());
        gate
    }

    fn gate_session(self: &Arc<Self>, session: &str) -> Arc<Self> {
        *self.gate_for.lock().unwrap() = Some(session.to_owned());
        self.clone()
    }

    fn after_deliver(self: &Arc<Self>, hook: Arc<dyn Fn() + Send + Sync>) -> Arc<Self> {
        *self.after_deliver.lock().unwrap() = Some(hook);
        self.clone()
    }

    fn on_entered(self: &Arc<Self>, gate: Arc<Notify>) -> Arc<Self> {
        *self.entered.lock().unwrap() = Some(gate);
        self.clone()
    }

    fn entered_count(&self) -> usize {
        self.entered_count.load(Ordering::SeqCst)
    }

    fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }

    /// The POSTs of `request`, in order.
    fn sent_for(&self, request: &str) -> Vec<Sent> {
        self.sent().into_iter().filter(|sent| sent.request == request).collect()
    }
}

impl Native for FakeNative {
    fn deliver<'a>(&'a self, session: &'a str, request: &'a str, answer: &'a Answer, limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Delivery> + Send + 'a>> {
        Box::pin(async move {
            let at = Instant::now();
            self.entered_count.fetch_add(1, Ordering::SeqCst);
            // Recorded as it enters, so a test sees the POST in flight.
            self.sent.lock().unwrap().push(Sent { session: session.to_owned(), request: request.to_owned(), answer: answer.clone(), limit, at });
            let entered = { self.entered.lock().unwrap().clone() };
            if let Some(entered) = entered {
                entered.notify_one();
            }
            // The gate first, then the POST's own delay: a held POST's delay
            // starts when the test lets it go.
            let gate = { self.gate.lock().unwrap().clone() };
            let matches_session = self.gate_for.lock().unwrap().as_deref().is_none_or(|only| only == session);
            if let Some(gate) = gate.filter(|_| matches_session) {
                if let Ok(permit) = gate.acquire().await {
                    permit.forget();
                }
            }
            let delay = {
                let own = self.delays_for.lock().unwrap().get_mut(request).and_then(VecDeque::pop_front);
                own.or_else(|| self.delays.lock().unwrap().pop_front())
            };
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let hook = { self.after_deliver.lock().unwrap().clone() };
            if let Some(hook) = hook {
                hook();
            }
            let own = self.results_for.lock().unwrap().get_mut(request).and_then(VecDeque::pop_front);
            own.or_else(|| self.results.lock().unwrap().pop_front()).unwrap_or(Delivery::Delivered)
        })
    }

    fn pending<'a>(&'a self, _session: &'a str, request: &'a str, _limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async move {
            self.checked.lock().unwrap().push((request.to_owned(), Instant::now()));
            let delay = *self.pending_delay.lock().unwrap();
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let waiting = match *self.pending_always.lock().unwrap() {
                Some(waiting) => waiting,
                None => self.pending.lock().unwrap().pop_front().unwrap_or(false),
            };
            Ok(waiting.then(|| json!({"id": "per"})))
        })
    }

    fn pending_all<'a>(&'a self, _session: &'a str, _limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>>> + Send + 'a>> {
        let list = self.list.lock().unwrap().clone();
        Box::pin(async move { Ok(list) })
    }

    fn abort<'a>(&'a self, _session: &'a str, _limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        self.aborts.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

#[derive(Default)]
struct FakeRuntime {
    current: AtomicBool,
    terminated: AtomicUsize,
    killed: AtomicUsize,
    ends: AtomicBool,
    /// When `terminate` and `kill` were called.
    terminated_at: StdMutex<Option<Instant>>,
    killed_at: StdMutex<Option<Instant>>,
    /// Set current=false while `ended_within` waits, as a generation change
    /// during the TERM window.
    flip_on_wait: AtomicBool,
}

impl FakeRuntime {
    fn live() -> Arc<Self> {
        let runtime = Arc::new(Self::default());
        runtime.current.store(true, Ordering::SeqCst);
        runtime
    }
}

impl Runtime for FakeRuntime {
    fn current(&self) -> bool {
        self.current.load(Ordering::SeqCst)
    }

    fn terminate(&self) {
        self.terminated_at.lock().unwrap().get_or_insert_with(Instant::now);
        self.terminated.fetch_add(1, Ordering::SeqCst);
    }

    fn ended_within<'a>(&'a self, limit: Duration) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            tokio::time::sleep(limit).await;
            if self.flip_on_wait.load(Ordering::SeqCst) {
                self.current.store(false, Ordering::SeqCst);
            }
            self.ends.load(Ordering::SeqCst)
        })
    }

    fn kill(&self) {
        *self.killed_at.lock().unwrap() = Some(Instant::now());
        self.killed.fetch_add(1, Ordering::SeqCst);
    }
}

struct NoReader;

impl MessageReader for NoReader {
    fn message<'a>(&'a self, _session: &'a str, _message: &'a str)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async { Ok(None) })
    }
}

struct TestJudge(Arc<dyn Fn(&Asked, &Call) -> Decision + Send + Sync>);

impl Judge for TestJudge {
    fn decide(&self, asked: &Asked, call: &Call) -> Decision {
        (self.0)(asked, call)
    }
}

/// Releases a blocking fixture however the test leaves it: a panic or an
/// assertion cannot leave a `spawn_blocking` worker holding Tokio's exit.
struct Unblock(Arc<(StdMutex<bool>, Condvar)>);

impl Drop for Unblock {
    fn drop(&mut self) {
        let (lock, cond) = &*self.0;
        *lock.lock().unwrap() = true;
        cond.notify_all();
    }
}

/// Lets a held gate open however the test ends, for a POST that reaches it
/// even after the test's own checks.
struct OpenGate(Arc<Semaphore>);

impl Drop for OpenGate {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// Waits in real time for what OS threads and this runtime's tasks do, at
/// most 10 s, then freezes Tokio's time again. A paused test only: its clock
/// may otherwise advance to a deadline while a blocking worker has not even
/// started (paused time does not wait for one), so nothing is proven by
/// yielding. What the test then checks of deadlines runs on paused time.
async fn real<T>(what: &str, work: impl std::future::Future<Output = T>) -> T {
    tokio::time::resume();
    let done = tokio::time::timeout(Duration::from_secs(10), work).await;
    tokio::time::pause();
    done.unwrap_or_else(|_| panic!("{what} within 10 s of real time"))
}

/// `real` until `holds`.
async fn eventually(what: &str, holds: impl Fn() -> bool) {
    real(what, async {
        while !holds() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }).await
}

/// How many blocking decisions have started: a receipt each worker sends
/// from its own thread.
#[derive(Default)]
struct Started {
    count: AtomicUsize,
}

impl Started {
    fn arrive(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }

    fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }

    /// Until `n` workers have started, in real time (`real`).
    async fn reach(&self, n: usize) {
        eventually(&format!("{n} blocking decisions start"), || self.count() >= n).await
    }
}

/// Tokio's timer resolution: a sleep of `d` from an instant that is not on a
/// millisecond fires at the first tick at or after it, so up to this late.
const TICK: Duration = Duration::from_millis(1);

/// `at` is `d` after `from`, as Tokio's timers can make it.
fn right_after(at: Instant, from: Instant, d: Duration) -> bool {
    at >= from + d && at <= from + d + TICK
}

const GENERATION: u64 = 7;

fn calls() -> Arc<Calls> {
    let calls = Calls::default();
    calls.ingest_event(GENERATION, &json!({"type": "session.tool.input.started",
        "data": {"sessionID": "ses_main", "assistantMessageID": "msg_1", "id": "call_1", "name": "read"}}));
    calls.ingest_event(GENERATION, &json!({"type": "session.tool.called",
        "data": {"sessionID": "ses_main", "assistantMessageID": "msg_1", "id": "call_1", "input": {"path": "a.txt"}}}));
    Arc::new(calls)
}

fn asked(id: &str, session: &str) -> Asked {
    Asked::read(&json!({"id": id, "sessionID": session, "action": "read", "resources": ["a.txt"],
        "source": {"type": "tool", "messageID": "msg_1", "id": "call_1"}})).unwrap()
}

fn once() -> Decision {
    Decision { answer: Answer::Once, call: None, targets: vec![] }
}

fn reject() -> Decision {
    Decision { answer: Answer::Reject(Reason::WriteOutside), call: None, targets: vec![] }
}

fn no_children() -> Arc<dyn Fn() -> Vec<String> + Send + Sync> {
    Arc::new(Vec::new)
}

type TestEngine = Engine<NoReader, TestJudge, FakeNative>;

fn make(native: Arc<FakeNative>, runtime: Arc<FakeRuntime>, judge: TestJudge) -> TestEngine {
    let live = runtime.clone();
    Engine::new(GENERATION, "ses_main".into(), no_children(), calls(), Arc::new(NoReader),
        Arc::new(judge), native, Arc::new(move || live.current()), runtime)
}

fn engine(native: Arc<FakeNative>, runtime: Arc<FakeRuntime>, judge: TestJudge) -> Arc<TestEngine> {
    Arc::new(make(native, runtime, judge))
}

fn accepted(submission: Submission) -> watch::Receiver<Option<Report>> {
    match submission {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    }
}

async fn report(mut receiver: watch::Receiver<Option<Report>>) -> Report {
    tokio::time::timeout(Duration::from_secs(200), async move {
        loop {
            if let Some(report) = receiver.borrow().clone() {
                return report;
            }
            if receiver.changed().await.is_err() {
                panic!("the report's sender ended");
            }
        }
    }).await.expect("the report within 200 s")
}

/// Whether `request` has its decision (it is ready, or finished).
fn decided(engine: &TestEngine, request: &str) -> bool {
    let key = Key { generation: GENERATION, session: "ses_main".into(), request: request.into() };
    let state = engine.state.lock().unwrap();
    state.done.contains_key(&key) || state.active.get(&key).is_some_and(|entry| entry.decision.lock().unwrap().is_some())
}

/// Submits each request of the main session once the one before it is
/// decided: their preparations run on blocking workers, so requests
/// submitted together may be ready, and take their places, in any order.
async fn in_order(engine: &Arc<TestEngine>, ids: &[&str]) -> Vec<watch::Receiver<Option<Report>>> {
    let mut receivers = Vec::new();
    for id in ids {
        receivers.push(accepted(engine.submit(&asked(id, "ses_main"))));
        eventually("each is decided in turn", || decided(engine, id)).await;
    }
    receivers
}

/// How many requests wait for the main session's turn.
fn waiting(engine: &TestEngine) -> usize {
    engine.lane("ses_main").state.lock().unwrap().waiting.len()
}

/// A duplicate submission joins the one work: one first POST, the same
/// report, and no moved deadline.
#[tokio::test(start_paused = true)]
async fn a_duplicate_request_joins_one_answer() {
    let native = FakeNative::new();
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let asked = asked("per_1", "ses_main");
    let first = engine.submit(&asked);
    let second = engine.submit(&asked);
    let report = report(accepted(first)).await;
    assert!(matches!(second, Submission::Joined(_)));
    assert_eq!(report.outcome, Outcome::Delivered);
    assert_eq!(native.sent().len(), 1);
    assert!(matches!(engine.submit(&asked), Submission::Known(known) if known == report));
}

/// Different sessions answer independently; one session's requests do not
/// run at once.
#[tokio::test]
async fn sessions_are_serial_and_independent() {
    let entered = Arc::new(Notify::new());
    let native = FakeNative::new().gate_session("ses_main").on_entered(entered.clone());
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let main = accepted(engine.submit(&asked("per_1", "ses_main")));
    // Main's POST is in flight, held at its gate, before the other session's request exists.
    tokio::time::timeout(Duration::from_secs(30), entered.notified()).await.expect("main's POST entered its gate");
    let other = accepted(engine.submit(&asked("per_1", "ses_child")));
    // ses_child is not one of this connection's children in this fake, so
    // its request is refused as unbound, and is answered while main's POST
    // is still held: the two sessions' sends are independent.
    let other = tokio::time::timeout(Duration::from_secs(30), report(other)).await.expect("the other session completes");
    assert_eq!(other.outcome, Outcome::Delivered);
    assert_eq!(other.answer, Some(Answer::Reject(Reason::Unbound(Unbound::NotThisConnection))));
    assert!(main.borrow().is_none(), "main's answer is still in flight");
    assert_eq!(native.sent().iter().map(|sent| (sent.session.as_str(), sent.request.as_str())).collect::<Vec<_>>(),
        [("ses_main", "per_1"), ("ses_child", "per_1")], "both POSTs entered, main's first");
    gate.add_permits(1);
    let main = tokio::time::timeout(Duration::from_secs(30), report(main)).await.expect("the main session after the gate");
    assert_eq!(main.outcome, Outcome::Delivered);
    assert_eq!(native.sent().len(), 2, "both sessions answered once");
}

/// Two requests of one session answer one after the other, not at once.
#[tokio::test]
async fn one_session_answers_one_after_the_other() {
    let entered = Arc::new(Notify::new());
    let native = FakeNative::new().gate_session("ses_main").on_entered(entered.clone());
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let first = accepted(engine.submit(&asked("per_1", "ses_main")));
    tokio::time::timeout(Duration::from_secs(30), entered.notified()).await.expect("the first POST entered its gate");
    let second = accepted(engine.submit(&asked("per_2", "ses_main")));
    // Real time here: the second is ready and waits for its turn, never entering.
    tokio::time::timeout(Duration::from_secs(30), async {
        while !(decided(&engine, "per_2") && waiting(&engine) == 1) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }).await.expect("the second is ready and waits");
    assert_eq!(native.entered_count(), 1, "the second cannot enter while the first's POST is in flight");
    gate.add_permits(1);
    let first = tokio::time::timeout(Duration::from_secs(30), report(first)).await.expect("the first answer");
    assert_eq!(first.outcome, Outcome::Delivered);
    tokio::time::timeout(Duration::from_secs(30), entered.notified()).await.expect("the second POST entered its gate");
    gate.add_permits(1);
    let second = tokio::time::timeout(Duration::from_secs(30), report(second)).await.expect("the second answer");
    assert_eq!(second.outcome, Outcome::Delivered);
    let sent = native.sent();
    assert_eq!(sent.iter().map(|sent| sent.request.as_str()).collect::<Vec<_>>(), ["per_1", "per_2"]);
}

/// A 400 is checked and the same decision sent again; a 404 ends as gone.
#[tokio::test(start_paused = true)]
async fn a_refused_payload_is_checked_and_resent_with_the_same_decision() {
    let native = FakeNative::new().pending([true]).results([Delivery::Invalid, Delivery::Gone]);
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let report = report(accepted(engine.submit(&asked("per_1", "ses_main")))).await;
    assert_eq!(report.outcome, Outcome::Gone);
    assert_eq!(report.rounds, 2);
    let sent = native.sent();
    assert_eq!(sent.len(), 2);
    assert!(sent.iter().all(|sent| sent.answer == Answer::Once), "the same decision is sent again");
}

/// Retained history is evicted to make room for a new request; only active
/// work can call the connection overloaded.
#[tokio::test(start_paused = true)]
async fn finished_history_is_evicted_before_a_new_request_is_overload() {
    let native = FakeNative::new();
    let engine = Arc::new(make(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once()))).with_bytes(64));
    for index in 0..8 {
        let report = report(accepted(engine.submit(&asked(&format!("per_{index}"), "ses_main")))).await;
        assert_eq!(report.outcome, Outcome::Delivered);
    }
    assert_eq!(native.sent().len(), 8, "each new request was answered");
}

/// The collateral flag is part of a report's recorded size, so eviction
/// subtracts what the flag added.
#[test]
fn a_report_counts_its_collateral_flag() {
    let report = Report {
        generation: 7, session: "ses_main".into(), request: "per_1".into(), answer: Some(Answer::Once),
        outcome: Outcome::Delivered, rounds: 1, collateral: false, own_reject: false, notice: None,
    };
    let plain = report.size();
    let mut marked = report.clone();
    marked.collateral = true;
    assert_eq!(marked.size(), plain + 4);
}

/// A late collateral reject that grows retained history past the bound
/// evicts the oldest report at once, not at the next submission.
#[tokio::test(start_paused = true)]
async fn late_collateral_on_retained_history_is_evicted_at_once() {
    let native = FakeNative::new();
    let one = Report { generation: GENERATION, session: "ses_main".into(), request: "per_0".into(), answer: Some(Answer::Once),
        outcome: Outcome::Delivered, rounds: 1, collateral: false, own_reject: false, notice: None }.size();
    let held = asked("per_2", "ses_main").size();
    // Two retained Once reports and one active request fill the bound exactly.
    let limit = 2 * one + held;
    let engine = Arc::new(make(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once()))).with_bytes(limit));
    for index in 0..2 {
        assert_eq!(report(accepted(engine.submit(&asked(&format!("per_{index}"), "ses_main")))).await.outcome, Outcome::Delivered);
    }
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let active = accepted(engine.submit(&asked("per_2", "ses_main")));
    eventually("per_2's POST is in flight", || native.sent_for("per_2").len() == 1).await;
    assert_eq!(engine.state.lock().unwrap().bytes, limit);
    engine.replied("ses_main", "per_1", "reject");
    {
        let state = engine.state.lock().unwrap();
        assert!(state.bytes <= limit, "the bound holds right after the flag: {} > {limit}", state.bytes);
        let oldest = Key { generation: GENERATION, session: "ses_main".into(), request: "per_0".into() };
        let marked = Key { generation: GENERATION, session: "ses_main".into(), request: "per_1".into() };
        assert!(!state.done.contains_key(&oldest), "the oldest report was evicted");
        assert!(state.done[&marked].collateral, "the marked one is kept");
    }
    gate.add_permits(1);
    assert_eq!(report(active).await.outcome, Outcome::Delivered);
}

/// Three rounds at most, each POST within 15 s, with a check and a backoff
/// between them, then the unknown tail.
#[tokio::test(start_paused = true)]
async fn delivery_rounds_are_bounded_and_shared() {
    let native = FakeNative::new().always_pending(true).results([Delivery::Unknown, Delivery::Unknown, Delivery::Unknown]);
    let runtime = FakeRuntime::live();
    runtime.ends.store(true, Ordering::SeqCst);
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let report = report(accepted(engine.submit(&asked("per_1", "ses_main")))).await;
    let sent = native.sent();
    assert_eq!(sent.len(), 3);
    assert!(sent.iter().all(|sent| sent.limit <= REQUEST_LIMIT), "each POST is within 15 s");
    assert_eq!(report.rounds, 3);
    assert_eq!(report.outcome, Outcome::Closed);
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1, "one interrupt, not one per round");
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.killed.load(Ordering::SeqCst), 0, "the fake ended within TEARDOWN");
}

/// Duplicates while an answer is checked and resent join it: they neither
/// refresh a deadline nor add a fourth POST.
#[tokio::test(start_paused = true)]
async fn duplicates_add_no_fourth_post_and_refresh_no_deadline() {
    let native = FakeNative::new().always_pending(true).delays([Duration::from_secs(5); 3])
        .results([Delivery::Invalid, Delivery::Invalid, Delivery::Invalid]);
    let runtime = FakeRuntime::live();
    runtime.ends.store(true, Ordering::SeqCst);
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let asked = asked("per_1", "ses_main");
    let receiver = accepted(engine.submit(&asked));
    let key = Key { generation: GENERATION, session: "ses_main".into(), request: "per_1".into() };
    eventually("the first POST", || !native.sent().is_empty()).await;
    let (ready, prepare) = {
        let state = engine.state.lock().unwrap();
        let entry = &state.active[&key];
        let ready = entry.ready_at.lock().unwrap().unwrap();
        (ready, entry.prepare_deadline)
    };
    for _ in 0..4 {
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(matches!(engine.submit(&asked), Submission::Joined(_)));
    }
    {
        let state = engine.state.lock().unwrap();
        let entry = &state.active[&key];
        assert_eq!((entry.ready_at.lock().unwrap().unwrap(), entry.prepare_deadline), (ready, prepare), "nothing moved");
    }
    let report = report(receiver).await;
    assert_eq!(native.sent().len(), 3, "three POSTs, never a fourth");
    assert_eq!(report.rounds, 3);
    assert_eq!(report.outcome, Outcome::Closed);
}

/// The first POST may use all of its 15 s; the check still has the other 15.
#[tokio::test(start_paused = true)]
async fn a_first_post_using_its_limit_leaves_the_check_its_own() {
    let native = FakeNative::new().delays([Duration::from_secs(15)]).pending([true]).results([Delivery::Unknown, Delivery::Delivered]);
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let report = report(accepted(engine.submit(&asked("per_1", "ses_main")))).await;
    assert_eq!(report.outcome, Outcome::Delivered);
    let sent = native.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].limit, Duration::from_secs(15));
    assert!(sent[1].limit <= Duration::from_secs(15) && sent[1].limit > Duration::ZERO);
}

/// A preparation that runs out yields a stable reject through the normal
/// delivery; it never waits for the user.
#[tokio::test(start_paused = true)]
async fn a_preparation_timeout_is_a_delivered_reject() {
    let native = FakeNative::new();
    let started = Arc::new(Started::default());
    let release = Arc::new((StdMutex::new(false), Condvar::new()));
    let _unblock = Unblock(release.clone());
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel();
    let (arrived, held, finished_tx) = (started.clone(), release.clone(), done_tx);
    let judge = TestJudge(Arc::new(move |_, _| {
        arrived.arrive();
        let (lock, cond) = &*held;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = cond.wait(released).unwrap();
        }
        let _ = finished_tx.send(());
        once()
    }));
    let engine = engine(native.clone(), FakeRuntime::live(), judge);
    let submitted = Instant::now();
    let receiver = accepted(engine.submit(&asked("per_1", "ses_main")));
    started.reach(1).await;
    assert!(receiver.borrow().is_none(), "the preparation still waits for the blocked judge");
    tokio::time::advance(PREPARE_LIMIT + Duration::from_secs(1)).await;
    let report = report(receiver).await;
    let (lock, cond) = &*release;
    *lock.lock().unwrap() = true;
    cond.notify_all();
    done_rx.recv().await.expect("the blocking judge finished");
    assert_eq!(report.outcome, Outcome::Delivered);
    assert_eq!(report.answer, Some(Answer::Reject(Reason::PreparationTimeout)));
    assert!(report.notice.as_deref().unwrap_or_default().contains("preparing"));
    let sent = native.sent();
    assert_eq!(sent.len(), 1);
    assert!(matches!(sent[0].answer, Answer::Reject(Reason::PreparationTimeout)));
    assert!(sent[0].at >= submitted + PREPARE_LIMIT, "the delivery starts after the preparation bound");
}

/// An engine whose one connection file-system permit the test holds, so a
/// request's preparation can be made to last a chosen time without a
/// blocking thread.
fn held_fs(native: Arc<FakeNative>, runtime: Arc<FakeRuntime>, judge: TestJudge) -> (Arc<TestEngine>, Arc<Semaphore>) {
    let connection = Arc::new(Semaphore::new(FS_CONNECTION));
    let engine = Arc::new(make(native, runtime, judge).with_fs(connection.clone(), Arc::new(Semaphore::new(FS_GLOBAL))));
    (engine, connection)
}

/// Lets go of the file-system permit `held` takes at `after` from now.
fn release_after(connection: &Arc<Semaphore>, after: Duration) {
    let held = connection.clone().try_acquire_owned().expect("the permit is free");
    tokio::spawn(async move {
        tokio::time::sleep(after).await;
        drop(held);
    });
}

/// A 19 s preparation, then a normal slow POST, while the session's turn is
/// taken by another request's two slow POSTs past the 20 s preparation
/// bound: it waits for its turn on its own first-POST deadline, and nothing
/// faults (S4b-1's P3: its session lock wait used to be the 20 s bound).
#[tokio::test(start_paused = true)]
async fn a_19s_preparation_then_a_slow_post_is_delivered() {
    let native = FakeNative::new()
        .delays_for("per_x", [Duration::from_secs(15), Duration::from_secs(15)]).results_for("per_x", [Delivery::Unknown, Delivery::Delivered])
        .delays_for("per_a", [Duration::from_secs(10)]).pending([true]);
    let runtime = FakeRuntime::live();
    let (engine, connection) = held_fs(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let start = Instant::now();
    let x = accepted(engine.submit(&asked("per_x", "ses_main")));
    eventually("x is decided", || decided(&engine, "per_x")).await;
    release_after(&connection, Duration::from_secs(19));
    let a = accepted(engine.submit(&asked("per_a", "ses_main")));
    let (x, a) = (report(x).await, report(a).await);
    assert_eq!((x.outcome, x.rounds), (Outcome::Delivered, 2));
    assert_eq!((a.outcome, a.rounds), (Outcome::Delivered, 1));
    // Anchored on the POSTs themselves: a's turn is the instant x's second
    // POST (15 s) ends, past a's own 20 s preparation bound, within its
    // first-POST bound.
    let (x_sent, a_sent) = (native.sent_for("per_x"), native.sent_for("per_a"));
    assert!(right_after(a_sent[0].at, x_sent[1].at, Duration::from_secs(15)), "a waited for x's second POST");
    assert!(a_sent[0].at - start >= PREPARE_LIMIT && a_sent[0].at - start < Duration::from_secs(19) + FIRST_POST_LIMIT);
    assert_eq!(native.aborts.load(Ordering::SeqCst), 0, "no fault");
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 0);
}

/// One request's check and backoff hold nothing: another of its session
/// sends meanwhile.
#[tokio::test(start_paused = true)]
async fn b_sends_while_a_checks_and_backs_off() {
    let native = FakeNative::new().results_for("per_a", [Delivery::Unknown, Delivery::Delivered]).pending([true])
        .pending_delay(Duration::from_secs(5)).delays_for("per_b", [Duration::from_secs(1)]);
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let mut receivers = in_order(&engine, &["per_a", "per_b"]).await.into_iter();
    let (a, b) = (report(receivers.next().unwrap()).await, report(receivers.next().unwrap()).await);
    assert_eq!((a.outcome, a.rounds, b.outcome, b.rounds), (Outcome::Delivered, 2, Outcome::Delivered, 1));
    let checked = native.checked.lock().unwrap().iter().find(|(request, _)| request == "per_a").map(|(_, at)| *at).unwrap();
    let (a_sent, b_sent) = (native.sent_for("per_a"), native.sent_for("per_b"));
    assert!(b_sent[0].at >= checked && b_sent[0].at < checked + Duration::from_secs(5), "b sent while a's check ran");
    assert!(b_sent[0].at < a_sent[1].at, "before a's retry");
}

/// A first answer that can't start within 30 s of being ready closes the
/// connection on its fault path: no user prompt, no answer made up, and the
/// POSTs that started are counted.
#[tokio::test(start_paused = true)]
async fn a_first_post_that_cannot_start_in_30s_faults_the_connection() {
    // x1's POST holds the session's turn until all four are ready, so every
    // deadline below is reached from that one release, whatever the setup's
    // real-time waits took: x3's first POST at +15 s is well within its 30 s,
    // b's turn would come at +45 s, past its own.
    let native = FakeNative::new().delays_for("per_x1", [Duration::from_secs(14)]).delays_for("per_x2", [Duration::from_secs(1)])
        .delays_for("per_x3", [Duration::from_secs(30)]);
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let runtime = FakeRuntime::live();
    runtime.ends.store(true, Ordering::SeqCst);
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let reports = in_order(&engine, &["per_x1", "per_x2", "per_x3", "per_b"]).await;
    eventually("x1's POST holds the turn and the rest wait", || native.entered_count() == 1 && waiting(&engine) == 3).await;
    let released = Instant::now();
    gate.add_permits(3);
    let mut done = Vec::new();
    for receiver in reports {
        done.push(report(receiver).await);
    }
    assert_eq!((done[0].outcome, done[1].outcome), (Outcome::Delivered, Outcome::Delivered));
    assert_eq!((done[2].outcome, done[2].rounds), (Outcome::Faulted(Fault::SendExpired), 1), "x3's POST was in flight");
    assert_eq!((done[3].outcome, done[3].rounds, done[3].notice.clone()), (Outcome::Faulted(Fault::SendExpired), 0, None));
    assert!(native.sent_for("per_b").is_empty(), "nothing sent for what never had its turn");
    assert!(matches!(engine.submit(&asked("per_c", "ses_main")), Submission::Full), "closing");
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 1);
    // b was ready before the release, so its expiry, and the TERM after the
    // interrupt and settle, come within these of it.
    let term = runtime.terminated_at.lock().unwrap().unwrap();
    assert!(term <= released + FIRST_POST_LIMIT + INTERRUPT_LIMIT + SETTLE_LIMIT, "{:?}", term - released);
}

/// Before a reject, a Once request already waiting for the session's turn
/// is let go first, though it was ready after the reject.
#[tokio::test(start_paused = true)]
async fn a_reject_lets_a_waiting_once_request_go_first() {
    let gate = Arc::new(Notify::new());
    let native = FakeNative::new().delays_for("per_x", [Duration::from_secs(5)]).list(vec![json!({"id": "per_once"}), json!({"id": "per_reject"})]);
    let judge = TestJudge(Arc::new(|asked, _| if asked.id == "per_reject" { reject() } else { once() }));
    let engine = Arc::new(make(native.clone(), FakeRuntime::live(), judge).with_preflight_gate("per_reject", gate.clone()));
    let x = accepted(engine.submit(&asked("per_x", "ses_main")));
    eventually("x's POST", || native.entered_count() == 1).await;
    let reject = accepted(engine.submit(&asked("per_reject", "ses_main")));
    let once = accepted(engine.submit(&asked("per_once", "ses_main")));
    eventually("both wait", || waiting(&engine) == 2 && decided(&engine, "per_once")).await;
    gate.notify_one();
    let (x, reject, once) = (report(x).await, report(reject).await, report(once).await);
    assert_eq!((x.outcome, once.outcome, once.rounds), (Outcome::Delivered, Outcome::Delivered, 1));
    assert_eq!((reject.outcome, reject.own_reject), (Outcome::Delivered, true));
    assert_eq!(native.sent().iter().map(|sent| sent.request.as_str()).collect::<Vec<_>>(), ["per_x", "per_once", "per_reject"],
        "the Once request goes before the reject");
}

/// The priority window is bounded: after it, the reject goes in its own
/// place, before promoted requests still waiting. x's POST holds the turn
/// until r has promoted the three, so the window is measured from r's
/// preflight and every turn below from the one release.
#[tokio::test(start_paused = true)]
async fn promotion_waits_only_within_its_window() {
    let preflight = Arc::new(Notify::new());
    let native = FakeNative::new().delays_for("per_x", [Duration::from_secs(1)])
        .delays_for("per_o1", [Duration::from_secs(15)]).delays_for("per_o2", [Duration::from_secs(4)])
        .delays_for("per_o3", [Duration::from_secs(2)])
        .list(vec![json!({"id": "per_o1"}), json!({"id": "per_o2"}), json!({"id": "per_o3"})]);
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let runtime = FakeRuntime::live();
    let judge = TestJudge(Arc::new(|asked, _| if asked.id == "per_r" { reject() } else { once() }));
    let engine = Arc::new(make(native.clone(), runtime.clone(), judge).with_preflight_gate("per_r", preflight.clone()));
    let x = accepted(engine.submit(&asked("per_x", "ses_main")));
    eventually("x's POST holds the turn", || native.entered_count() == 1).await;
    let r = accepted(engine.submit(&asked("per_r", "ses_main")));
    eventually("r waits for its preflight", || waiting(&engine) == 1).await;
    // Ready one after the other, so their places are in this order.
    let mut os = Vec::new();
    for (n, id) in ["per_o1", "per_o2", "per_o3"].iter().enumerate() {
        os.push(accepted(engine.submit(&asked(id, "ses_main"))));
        eventually("each is ready in turn", || decided(&engine, id) && waiting(&engine) == n + 2).await;
    }
    preflight.notify_one();
    let promoted = || engine.lane("ses_main").state.lock().unwrap().waiting.values()
        .any(|waiting| waiting.request == "per_r" && waiting.eligible && waiting.behind.is_some());
    eventually("r has promoted the three", promoted).await;
    let released = Instant::now();
    gate.add_permits(5);
    let r = report(r).await;
    assert_eq!(r.outcome, Outcome::Delivered);
    for receiver in os {
        assert_eq!(report(receiver).await.outcome, Outcome::Delivered);
    }
    assert_eq!(report(x).await.outcome, Outcome::Delivered);
    let order: Vec<String> = native.sent().iter().map(|sent| sent.request.clone()).collect();
    assert_eq!(order, ["per_x", "per_o1", "per_r", "per_o2", "per_o3"]);
    // Anchored on the release and the POSTs: o1 took the turn when x's 1 s
    // POST ended, inside the window; r took it the instant o1's 15 s POST
    // ended, the window (at most 15 s from r's preflight) over, though o2 and
    // o3 had been promoted too.
    let (o1_at, r_at) = (native.sent_for("per_o1")[0].at, native.sent_for("per_r")[0].at);
    assert!(right_after(o1_at, released, Duration::from_secs(1)), "o1 first, promoted, when x's POST ended");
    assert!(right_after(r_at, o1_at, Duration::from_secs(15)), "r right after o1, before the still-promoted o2 and o3");
    assert_eq!(native.aborts.load(Ordering::SeqCst), 0, "no fault");
}

/// Promotion takes only requests waiting for their turn now: one between
/// its check and its retry is not waited for, and keeps its own backoff.
#[tokio::test(start_paused = true)]
async fn promotion_does_not_skip_a_targets_backoff() {
    let gate = Arc::new(Notify::new());
    let native = FakeNative::new().results_for("per_once", [Delivery::Unknown, Delivery::Delivered]).pending([true])
        .pending_delay(Duration::from_secs(3)).list(vec![json!({"id": "per_once"})]);
    let judge = TestJudge(Arc::new(|asked, _| if asked.id == "per_reject" { reject() } else { once() }));
    let engine = Arc::new(make(native.clone(), FakeRuntime::live(), judge).with_preflight_gate("per_reject", gate.clone()));
    let once = accepted(engine.submit(&asked("per_once", "ses_main")));
    eventually("its first POST", || native.sent_for("per_once").len() == 1).await;
    let reject = accepted(engine.submit(&asked("per_reject", "ses_main")));
    eventually("the reject waits for its preflight", || waiting(&engine) == 1).await;
    gate.notify_one();
    let (once, reject) = (report(once).await, report(reject).await);
    assert_eq!((once.outcome, once.rounds, reject.outcome), (Outcome::Delivered, 2, Outcome::Delivered));
    let (once_sent, reject_sent) = (native.sent_for("per_once"), native.sent_for("per_reject"));
    assert!(reject_sent[0].at < once_sent[1].at, "the reject did not wait for a request in its check");
    assert!(once_sent[1].at - once_sent[0].at >= Duration::from_secs(3) + BACKOFF[0], "its own check and backoff");
}

/// A request that disappears after the interrupt is `Interrupted`, and the
/// captured runtime is not touched.
#[tokio::test(start_paused = true)]
async fn an_interrupt_that_settles_is_not_a_teardown() {
    let native = FakeNative::new().pending([true, true, false]).results([Delivery::Unknown, Delivery::Unknown, Delivery::Unknown]);
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let report = report(accepted(engine.submit(&asked("per_1", "ses_main")))).await;
    assert_eq!(report.outcome, Outcome::Interrupted);
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.killed.load(Ordering::SeqCst), 0);
}

/// A runtime that ended after SIGTERM is `Closed`; a KILL only sent is
/// `Killed`, not a confirmed exit.
#[tokio::test(start_paused = true)]
async fn an_unknown_delivery_ends_the_captured_runtime() {
    let native = FakeNative::new().always_pending(true).results([Delivery::Unknown, Delivery::Unknown, Delivery::Unknown]);
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let report = report(accepted(engine.submit(&asked("per_1", "ses_main")))).await;
    assert_eq!(report.outcome, Outcome::Killed);
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.killed.load(Ordering::SeqCst), 1);
    let t0 = native.sent()[0].at;
    let killed = runtime.killed_at.lock().unwrap().expect("KILL was sent");
    assert!(killed - t0 >= Duration::from_secs(66) && killed - t0 <= Duration::from_secs(67) + Duration::from_millis(10),
        "KILL is sent within t0 + 67 s");
}

/// Two unknown tails of one connection share its one teardown: one SIGTERM
/// and one SIGKILL, at the earliest planned; the later never restarts them.
#[tokio::test(start_paused = true)]
async fn competing_tails_keep_the_earliest_kill() {
    let native = FakeNative::new().always_pending(true);
    for request in ["per_a", "per_b"] {
        native.results_for(request, [Delivery::Unknown; 3]);
    }
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let a = accepted(engine.submit(&asked("per_a", "ses_main")));
    tokio::time::sleep(Duration::from_secs(5)).await;
    let b = accepted(engine.submit(&asked("per_b", "ses_child")));
    let (a, b) = (report(a).await, report(b).await);
    let t0 = native.sent_for("per_a")[0].at;
    assert_eq!((a.outcome, b.outcome), (Outcome::Killed, Outcome::Killed));
    assert_eq!((runtime.terminated.load(Ordering::SeqCst), runtime.killed.load(Ordering::SeqCst)), (1, 1));
    let killed = runtime.killed_at.lock().unwrap().unwrap() - t0;
    assert!(killed <= DELIVERY_LIMIT + INTERRUPT_LIMIT + SETTLE_LIMIT + TEARDOWN + Duration::from_millis(10), "a's KILL, not b's later one: {killed:?}");
}

/// A fault while a request waits in its unknown tail ends the runtime on the
/// fault's own sooner schedule; the tail's later teardown joins it and never
/// moves it later.
#[tokio::test(start_paused = true)]
async fn an_overload_fault_ends_the_runtime_before_a_tails_later_teardown() {
    let native = FakeNative::new().always_pending(true).results_for("per_a", [Delivery::Unknown; 3]);
    let runtime = FakeRuntime::live();
    let size = asked("per_a", "ses_main").size();
    let engine = Arc::new(make(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once()))).with_bytes(size + size / 2));
    let a = accepted(engine.submit(&asked("per_a", "ses_main")));
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(native.sent_for("per_a").len(), 3, "its three POSTs are done; it waits in its tail");
    let t0 = native.sent_for("per_a")[0].at;
    let fault_at = Instant::now();
    assert!(matches!(engine.submit(&asked("per_b", "ses_main")), Submission::Full), "over the byte bound");
    let a = report(a).await;
    assert_eq!(a.outcome, Outcome::Faulted(Fault::Overload));
    tokio::time::sleep(Duration::from_secs(90)).await;
    assert_eq!((runtime.terminated.load(Ordering::SeqCst), runtime.killed.load(Ordering::SeqCst)), (1, 1));
    let killed = runtime.killed_at.lock().unwrap().unwrap();
    assert!(killed - fault_at <= INTERRUPT_LIMIT + SETTLE_LIMIT + TEARDOWN, "the fault's own teardown: {:?}", killed - fault_at);
    assert!(killed < t0 + DELIVERY_LIMIT + INTERRUPT_LIMIT + SETTLE_LIMIT + TEARDOWN, "sooner than a's planned one");
}

/// The whole bound from acceptance to SIGKILL: a preparation that runs out
/// at 20 s, a first POST that waits its turn behind three 14 s POSTs, and a
/// delivery whose fate stays unknown, end within 117 s.
#[tokio::test(start_paused = true)]
async fn acceptance_to_kill_is_within_117s() {
    let native = FakeNative::new().always_pending(true).results_for("per_a", [Delivery::Unknown; 3]);
    for request in ["per_x1", "per_x2", "per_x3"] {
        native.delays_for(request, [Duration::from_secs(14)]);
        native.results_for(request, [Delivery::Delivered]);
    }
    let runtime = FakeRuntime::live();
    let (engine, connection) = held_fs(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let xs: Vec<_> = ["per_x1", "per_x2", "per_x3"].iter().map(|id| accepted(engine.submit(&asked(id, "ses_main")))).collect();
    eventually("the three are decided", || ["per_x1", "per_x2", "per_x3"].iter().all(|id| decided(&engine, id))).await;
    release_after(&connection, PREPARE_LIMIT + Duration::from_secs(5));
    let accepted_at = Instant::now();
    let a = report(accepted(engine.submit(&asked("per_a", "ses_main")))).await;
    for receiver in xs {
        assert_eq!(report(receiver).await.outcome, Outcome::Delivered);
    }
    assert_eq!(a.answer, Some(Answer::Reject(Reason::PreparationTimeout)));
    assert_eq!(a.outcome, Outcome::Killed);
    let first = native.sent_for("per_a")[0].at - accepted_at;
    // accepted_at can be read a timer tick after the three POSTs began.
    assert!(first >= Duration::from_secs(42) - TICK && first < PREPARE_LIMIT + FIRST_POST_LIMIT, "its first POST waited its turn: {first:?}");
    let killed = runtime.killed_at.lock().unwrap().unwrap() - accepted_at;
    assert!(killed <= BOUND, "{killed:?} > {BOUND:?}");
    assert!(killed >= first + Duration::from_secs(67), "{killed:?}");
}

/// An older generation is not answered, and a new runtime is not ended.
#[tokio::test(start_paused = true)]
async fn an_old_generation_is_discarded_without_ending_a_new_runtime() {
    let native = FakeNative::new();
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    runtime.current.store(false, Ordering::SeqCst);
    let report = report(accepted(engine.submit(&asked("per_1", "ses_main")))).await;
    assert_eq!(report.outcome, Outcome::Discarded);
    assert_eq!(native.sent().len(), 0);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.killed.load(Ordering::SeqCst), 0);
}

/// A generation change while a request waits for its session's turn
/// discards it: it never sends.
#[tokio::test(start_paused = true)]
async fn a_generation_change_while_waiting_to_send_is_discarded() {
    let runtime = FakeRuntime::live();
    let native = FakeNative::new().delays_for("per_x", [Duration::from_secs(10)]);
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let mut receivers = in_order(&engine, &["per_x", "per_b"]).await.into_iter();
    let (x, b) = (receivers.next().unwrap(), receivers.next().unwrap());
    eventually("b waits", || waiting(&engine) == 1).await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    runtime.current.store(false, Ordering::SeqCst);
    let (x, b) = (report(x).await, report(b).await);
    assert_eq!((x.outcome, b.outcome), (Outcome::Discarded, Outcome::Discarded));
    assert!(native.sent_for("per_b").is_empty());
    assert_eq!(waiting(&engine), 0, "it gave up its place");
}

/// A reject event Core did not start is collateral; its own reject is not.
#[tokio::test(start_paused = true)]
async fn collateral_rejects_are_recorded_separately() {
    let native = FakeNative::new();
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let receiver = accepted(engine.submit(&asked("per_1", "ses_main")));
    engine.replied("ses_main", "per_1", "reject");
    let report = report(receiver).await;
    assert_eq!(report.outcome, Outcome::Delivered);
    assert!(report.collateral);
}

/// Core's own reject delivered with 204 keeps its ownership when its SSE
/// reject arrives late: it is not collateral and the known report is stable.
#[tokio::test(start_paused = true)]
async fn our_own_late_reject_event_is_not_collateral() {
    let native = FakeNative::new();
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| reject())));
    let asked = asked("per_1", "ses_main");
    let report = report(accepted(engine.submit(&asked))).await;
    assert_eq!(report.outcome, Outcome::Delivered);
    assert!(report.own_reject);
    assert!(!report.collateral);
    engine.replied("ses_main", "per_1", "reject");
    let known = match engine.submit(&asked) {
        Submission::Known(known) => known,
        other => panic!("not known after completion: {other:?}"),
    };
    assert_eq!(known, report, "our own late SSE reject changed the report");
    assert!(!known.collateral);
}

/// An external reject after a Once request finished is recorded as
/// collateral, and its size follows Report::size.
#[tokio::test(start_paused = true)]
async fn an_external_late_reject_marks_a_done_once_request() {
    let native = FakeNative::new();
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let asked = asked("per_1", "ses_main");
    let report = report(accepted(engine.submit(&asked))).await;
    assert_eq!(report.outcome, Outcome::Delivered);
    assert!(!report.own_reject);
    engine.replied("ses_main", "per_1", "reject");
    let known = match engine.submit(&asked) {
        Submission::Known(known) => known,
        other => panic!("not known after completion: {other:?}"),
    };
    assert!(known.collateral);
}

/// A successful HTTP answer that arrives after its generation changed is
/// discarded at publication, with no notice.
#[tokio::test(start_paused = true)]
async fn a_late_success_from_an_old_generation_is_discarded() {
    let runtime = FakeRuntime::live();
    let changed = runtime.clone();
    let native = FakeNative::new().after_deliver(Arc::new(move || changed.current.store(false, Ordering::SeqCst)));
    let engine = engine(native, runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let report = report(accepted(engine.submit(&asked("per_1", "ses_main")))).await;
    assert_eq!(report.outcome, Outcome::Discarded);
    assert_eq!(report.answer, None);
    assert_eq!(report.notice, None);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 0);
}

/// A generation change while SIGTERM is awaited is discarded: no KILL is
/// sent and the result is not `Killed`.
#[tokio::test(start_paused = true)]
async fn a_generation_change_during_teardown_sends_no_kill() {
    let native = FakeNative::new().always_pending(true).results([Delivery::Unknown, Delivery::Unknown, Delivery::Unknown]);
    let runtime = FakeRuntime::live();
    runtime.flip_on_wait.store(true, Ordering::SeqCst);
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let report = report(accepted(engine.submit(&asked("per_1", "ses_main")))).await;
    assert_eq!(report.outcome, Outcome::Discarded);
    assert_eq!(report.notice, None);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.killed.load(Ordering::SeqCst), 0);
}

/// A queue-bound fault on an already changed generation sends no abort or
/// signal to the new runtime.
#[tokio::test(start_paused = true)]
async fn a_fault_after_a_generation_change_sends_nothing() {
    let runtime = FakeRuntime::live();
    let native = FakeNative::new();
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    for index in 0..REQUESTS {
        let _ = engine.submit(&asked(&format!("per_{index}"), &format!("ses_{index}")));
    }
    assert!(matches!(engine.submit(&asked("per_more", "ses_more")), Submission::Full));
    runtime.current.store(false, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(native.aborts.load(Ordering::SeqCst), 0, "no abort on a stale generation");
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 0);
}

/// A POST whose response is still in flight when the connection is closed is
/// counted as started: its fault report is unknown, not "nothing sent",
/// and one fault closes the connection once.
#[tokio::test(start_paused = true)]
async fn an_in_flight_post_is_counted_when_overload_closes() {
    let native = FakeNative::new();
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let entered = Arc::new(Notify::new());
    native.on_entered(entered.clone());
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let mut target = None;
    for index in 0..REQUESTS {
        let receiver = accepted(engine.submit(&asked(&format!("per_{index}"), &format!("ses_{index}"))));
        if index == REQUESTS - 1 {
            target = Some(receiver);
        }
    }
    while native.entered_count() < REQUESTS {
        entered.notified().await;
    }
    let target = target.unwrap();
    assert!(matches!(engine.submit(&asked("per_extra", "ses_extra")), Submission::Full));
    let report = report(target).await;
    assert_eq!(report.outcome, Outcome::Faulted(Fault::Overload));
    assert!(report.rounds >= 1, "the POST had started before the close");
    assert_eq!(report.notice, None);
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1);
    // The close continues after publishing the reports: abort, settle, TERM.
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 1);
    // A repeated submission does not run a second fault/close.
    assert!(matches!(engine.submit(&asked("per_more", "ses_more")), Submission::Full));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1);
    gate.close();
}

/// The queue bound closes the connection once, with structured reports and
/// no answers for what it held.
#[tokio::test(start_paused = true)]
async fn the_queue_bound_closes_the_connection_once() {
    let native = FakeNative::new();
    let runtime = FakeRuntime::live();
    // Each request's preparation waits on the test's own file-system permit,
    // so nothing is answered before the bound is reached.
    let (engine, connection) = held_fs(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let _held = connection.clone().try_acquire_owned().unwrap();
    // Each binds to the connection's own call, so each waits for that permit.
    let mut receivers = Vec::new();
    for index in 0..REQUESTS {
        receivers.push(accepted(engine.submit(&asked(&format!("per_{index}"), "ses_main"))));
    }
    assert!(matches!(engine.submit(&asked("per_more", "ses_main")), Submission::Full));
    // The one close reports every held request as faulted.
    for receiver in receivers {
        let report = report(receiver).await;
        assert_eq!((report.outcome, report.rounds), (Outcome::Faulted(Fault::Overload), 0));
    }
    // The one close carries on after the reports: abort, settle, then TERM.
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(native.sent().len(), 0, "nothing is answered for an overloaded connection");
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 1);
}

/// The blocking file-system worker: at most one per connection and four
/// across Core; a timeout abandons the result but not the worker's permit.
#[tokio::test(start_paused = true)]
async fn fs_workers_are_bounded_and_timeouts_hold_their_permits() {
    let started = Arc::new(Started::default());
    let arrived = started.clone();
    let released = Arc::new((StdMutex::new(false), Condvar::new()));
    let _unblock = Unblock(released.clone());
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel();
    let release = released.clone();
    let judge: Arc<dyn Fn(&Asked, &Call) -> Decision + Send + Sync> = Arc::new(move |_, _| {
        arrived.arrive();
        let (lock, cond) = &*release;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = cond.wait(released).unwrap();
        }
        let _ = done_tx.send(());
        once()
    });
    let global = Arc::new(Semaphore::new(FS_GLOBAL));
    let mut engines = Vec::new();
    for index in 0..=FS_GLOBAL {
        let engine = Arc::new(make(FakeNative::new(), FakeRuntime::live(), TestJudge(judge.clone()))
            .with_fs(Arc::new(Semaphore::new(FS_CONNECTION)), global.clone()));
        engines.push((engine, index));
    }
    let mut receivers = Vec::new();
    for (engine, index) in &engines {
        receivers.push(accepted(engine.submit(&asked(&format!("per_{index}"), "ses_main"))));
    }
    // Four blocking decisions have started (an explicit barrier); the fifth
    // has no global permit.
    started.reach(FS_GLOBAL).await;
    assert_eq!(global.available_permits(), 0);
    assert!(receivers.iter().all(|receiver| receiver.borrow().is_none()), "every preparation still waits");
    // Move past the preparation deadline: every one times out, and no
    // further worker is started for any of them.
    tokio::time::advance(PREPARE_LIMIT + Duration::from_secs(1)).await;
    let mut outcomes = Vec::new();
    for receiver in receivers {
        outcomes.push(report(receiver).await);
    }
    assert_eq!(started.count(), FS_GLOBAL, "no worker is spawned on a timeout");
    assert_eq!(global.available_permits(), 0, "a hung worker keeps its permit after its timeout");
    let (lock, cond) = &*released;
    *lock.lock().unwrap() = true;
    cond.notify_all();
    for _ in 0..FS_GLOBAL {
        done_rx.recv().await.expect("every blocking decision finished");
    }
    assert!(outcomes.iter().all(|report| report.outcome == Outcome::Delivered
        && report.answer == Some(Answer::Reject(Reason::PreparationTimeout))));
    eventually("the permits come back once the workers end", || global.available_permits() == FS_GLOBAL).await;
    assert_eq!(started.count(), FS_GLOBAL);
}

/// A duplicate joins the same work and does not move the preparation bound.
#[tokio::test(start_paused = true)]
async fn a_duplicate_event_does_not_refresh_the_deadline() {
    let native = FakeNative::new();
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let engine = engine(native.clone(), FakeRuntime::live(), TestJudge(Arc::new(|_, _| once())));
    let asked = asked("per_1", "ses_main");
    let receiver = accepted(engine.submit(&asked));
    let key = Key { generation: GENERATION, session: "ses_main".into(), request: "per_1".into() };
    let first = {
        let state = engine.state.lock().unwrap();
        state.active.get(&key).expect("the request is active").prepare_deadline
    };
    tokio::time::advance(Duration::from_secs(10)).await;
    let _ = engine.submit(&asked);
    let second = {
        let state = engine.state.lock().unwrap();
        state.active.get(&key).expect("the request is still active").prepare_deadline
    };
    assert_eq!(first, second, "the duplicate did not move the preparation deadline");
    gate.add_permits(1);
    let report = report(receiver).await;
    assert_eq!(report.outcome, Outcome::Delivered);
}

/// The sub-agent sessions are read when a request is bound, not when the
/// engine was made: a child the connection learns later is the Agent's.
#[tokio::test(start_paused = true)]
async fn a_child_learned_after_the_engine_was_made_is_bound() {
    let native = FakeNative::new();
    let runtime = FakeRuntime::live();
    let known = Arc::new(StdMutex::new(Vec::<String>::new()));
    let listed = known.clone();
    let calls = calls();
    calls.ingest_event(GENERATION, &json!({"type": "session.tool.input.started",
        "data": {"sessionID": "ses_child", "assistantMessageID": "msg_1", "id": "call_1", "name": "read"}}));
    calls.ingest_event(GENERATION, &json!({"type": "session.tool.called",
        "data": {"sessionID": "ses_child", "assistantMessageID": "msg_1", "id": "call_1", "input": {"path": "a.txt"}}}));
    let live = runtime.clone();
    let engine = Arc::new(Engine::new(GENERATION, "ses_main".into(), Arc::new(move || listed.lock().unwrap().clone()), calls,
        Arc::new(NoReader), Arc::new(TestJudge(Arc::new(|_, _| once()))), native.clone(), Arc::new(move || live.current()), runtime));
    let before = report(accepted(engine.submit(&asked("per_1", "ses_child")))).await;
    assert_eq!(before.answer, Some(Answer::Reject(Reason::Unbound(Unbound::NotThisConnection))));
    known.lock().unwrap().push("ses_child".into());
    let after = report(accepted(engine.submit(&asked("per_2", "ses_child")))).await;
    assert_eq!((after.answer, after.outcome), (Some(Answer::Once), Outcome::Delivered));
}

/// The stages add up to the bound the Dev Lead fixed (8632).
#[test]
fn the_stages_add_up_to_117s() {
    assert_eq!(PREPARE_LIMIT + FIRST_POST_LIMIT + DELIVERY_LIMIT + INTERRUPT_LIMIT + SETTLE_LIMIT + TEARDOWN, BOUND);
    assert_eq!(BOUND, Duration::from_secs(117));
}
