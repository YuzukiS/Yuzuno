//! S4b-1's bounded responder, on fakes: no OpenCode, no network, no real
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
    at: Instant,
}

struct FakeNative {
    sent: StdMutex<Vec<Sent>>,
    results: StdMutex<VecDeque<Delivery>>,
    /// Each delivery's own delay before its result.
    delays: StdMutex<VecDeque<Duration>>,
    /// `Some` makes every check GET return a waiting request; `None` pops
    /// `pending`.
    pending_always: StdMutex<Option<bool>>,
    pending: StdMutex<VecDeque<bool>>,
    list: StdMutex<Vec<Value>>,
    /// Each delivery consumes one permit. Closing the gate releases current
    /// and future waiters, so cleanup cannot lose a wake-up.
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
            delays: StdMutex::default(),
            pending_always: StdMutex::default(),
            pending: StdMutex::default(),
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

    fn delays(self: &Arc<Self>, delays: impl IntoIterator<Item = Duration>) -> Arc<Self> {
        self.delays.lock().unwrap().extend(delays);
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

    fn list(self: &Arc<Self>, list: Vec<Value>) -> Arc<Self> {
        *self.list.lock().unwrap() = list;
        self.clone()
    }

    fn gate_session(self: &Arc<Self>, session: &str) -> Arc<Self> {
        *self.gate_for.lock().unwrap() = Some(session.to_owned());
        self.clone()
    }

    fn hold(&self) -> Arc<Semaphore> {
        let gate = Arc::new(Semaphore::new(0));
        *self.gate.lock().unwrap() = Some(gate.clone());
        gate
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
}

impl Native for FakeNative {
    fn deliver<'a>(&'a self, session: &'a str, request: &'a str, answer: &'a Answer, limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Delivery> + Send + 'a>> {
        Box::pin(async move {
            let at = Instant::now();
            self.entered_count.fetch_add(1, Ordering::SeqCst);
            let entered = { self.entered.lock().unwrap().clone() };
            if let Some(entered) = entered {
                entered.notify_one();
            }
            let delay = { self.delays.lock().unwrap().pop_front() };
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let gate = { self.gate.lock().unwrap().clone() };
            let matches_session = self.gate_for.lock().unwrap().as_deref().is_none_or(|only| only == session);
            if let Some(gate) = gate.filter(|_| matches_session) {
                if let Ok(permit) = gate.acquire().await {
                    permit.forget();
                }
            }
            self.sent.lock().unwrap().push(Sent {
                session: session.to_owned(), request: request.to_owned(), answer: answer.clone(), limit, at,
            });
            let hook = { self.after_deliver.lock().unwrap().clone() };
            if let Some(hook) = hook {
                hook();
            }
            self.results.lock().unwrap().pop_front().unwrap_or(Delivery::Delivered)
        })
    }

    fn pending<'a>(&'a self, _session: &'a str, _request: &'a str, _limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Value>>> + Send + 'a>> {
        Box::pin(async move {
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
    /// When `kill` was called, for the t0 + 67 s bound.
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

/// Also opens for a POST that reaches the gate after cleanup began.
struct OpenGate(Arc<Semaphore>);

impl Drop for OpenGate {
    fn drop(&mut self) {
        self.0.close();
    }
}

impl Drop for Unblock {
    fn drop(&mut self) {
        let (lock, cond) = &*self.0;
        *lock.lock().unwrap() = true;
        cond.notify_all();
    }
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

fn engine(native: Arc<FakeNative>, runtime: Arc<FakeRuntime>, judge: TestJudge) -> Arc<Engine<NoReader, TestJudge, FakeNative>> {
    let live = runtime.clone();
    Arc::new(Engine::new(GENERATION, "ses_main".into(), Vec::new(), calls(), Arc::new(NoReader),
        Arc::new(judge), native, Arc::new(move || live.current()), runtime))
}

async fn report(mut receiver: watch::Receiver<Option<Report>>) -> Report {
    tokio::time::timeout(Duration::from_secs(120), async move {
        loop {
            if let Some(report) = receiver.borrow().clone() {
                return report;
            }
            if receiver.changed().await.is_err() {
                panic!("the report's sender ended");
            }
        }
    }).await.expect("the report within 120 s")
}

/// A duplicate submission joins the one work: one first POST, the same
/// report, and no moved deadline.
#[tokio::test(start_paused = true)]
async fn a_duplicate_request_joins_one_answer() {
    let native = FakeNative::new();
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let asked = asked("per_1", "ses_main");
    let first = engine.submit(&asked);
    let second = engine.submit(&asked);
    let report = match first {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
    assert!(matches!(second, Submission::Joined(_)));
    assert_eq!(report.outcome, Outcome::Delivered);
    assert_eq!(native.sent().len(), 1);
    assert!(matches!(engine.submit(&asked), Submission::Known(known) if known == report));
}

/// Different sessions answer independently; one session's requests do not
/// run at once.
#[tokio::test]
async fn sessions_are_serial_and_independent() {
    let native = FakeNative::new();
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    native.gate_session("ses_main");
    let entered = Arc::new(Notify::new());
    native.on_entered(entered.clone());
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let main = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    tokio::time::timeout(Duration::from_secs(30), entered.notified()).await.expect("the main POST entered its gate");
    let other = match engine.submit(&asked("per_1", "ses_child")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    // ses_child is not one of this connection's children in this fake, so
    // its request is refused as unbound, and still completes while main waits.
    let other = tokio::time::timeout(Duration::from_secs(30), report(other)).await.expect("the other session completes");
    assert_eq!(other.outcome, Outcome::Delivered);
    assert!(native.sent().iter().all(|sent| sent.session == "ses_child"), "the gated main-session answer has not gone");
    gate.close();
    let main = tokio::time::timeout(Duration::from_secs(30), report(main)).await.expect("the main session after the gate");
    assert_eq!(main.outcome, Outcome::Delivered);
    assert_eq!(native.sent().len(), 2, "both sessions answered");
}

/// Two requests of one session answer one after the other, not at once.
#[tokio::test]
async fn one_session_answers_one_after_the_other() {
    let native = FakeNative::new();
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    *native.gate_for.lock().unwrap() = Some("ses_main".to_owned());
    let entered = Arc::new(Notify::new());
    native.on_entered(entered.clone());
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let first = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    tokio::time::timeout(Duration::from_secs(30), entered.notified()).await.expect("the first POST entered its gate");
    let second = match engine.submit(&asked("per_2", "ses_main")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    let key = Key { generation: GENERATION, session: "ses_main".into(), request: "per_2".into() };
    let waiting = engine.state.lock().unwrap().active[&key].clone();
    tokio::time::timeout(Duration::from_secs(30), waiting.prepared.notified()).await.expect("the second request prepared");
    assert_eq!(native.entered_count(), 1, "the prepared second request cannot enter while the first holds the session");
    gate.add_permits(1);
    let first = tokio::time::timeout(Duration::from_secs(30), report(first)).await.expect("the first answer");
    assert_eq!(first.outcome, Outcome::Delivered);
    assert_eq!(native.sent().len(), 1, "the second waits for the first answer");
    gate.add_permits(1);
    let second = tokio::time::timeout(Duration::from_secs(30), report(second)).await.expect("the second answer");
    assert_eq!(second.outcome, Outcome::Delivered);
    let sent = native.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].request, "per_1");
    assert_eq!(sent[1].request, "per_2");
}

/// A 400 is checked and the same decision sent again; a 404 ends as gone.
#[tokio::test(start_paused = true)]
async fn a_refused_payload_is_checked_and_resent_with_the_same_decision() {
    let native = FakeNative::new().pending([true]).results([Delivery::Invalid, Delivery::Gone]);
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let report = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
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
    let runtime = FakeRuntime::live();
    let engine = Arc::new(Engine::new(GENERATION, "ses_main".into(), Vec::new(), calls(), Arc::new(NoReader),
        Arc::new(TestJudge(Arc::new(|_, _| once()))), native.clone(), {
            let live = runtime.clone();
            Arc::new(move || live.current())
        }, runtime).with_bytes(64));
    for index in 0..8 {
        let report = match engine.submit(&asked(&format!("per_{index}"), "ses_main")) {
            Submission::Accepted(receiver) => report(receiver).await,
            other => panic!("history evicted but not accepted: {other:?}"),
        };
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

/// A preflight POST that fails hands the target's one t0, cumulative
/// attempts and absolute deadline to its own real worker; the worker does not
/// restart the delivery.
#[tokio::test(start_paused = true)]
async fn a_preflight_failure_hands_off_the_same_delivery_ledger() {
    let gate = Arc::new(Notify::new());
    let entered = Arc::new(Notify::new());
    let native = FakeNative::new().delays([Duration::from_secs(15)]).pending([true])
        .results([Delivery::Unknown, Delivery::Delivered, Delivery::Unknown, Delivery::Delivered])
        .list(vec![json!({"id": "per_once"})]);
    let runtime = FakeRuntime::live();
    let judge = TestJudge(Arc::new(|asked, _| if asked.id == "per_reject" { reject() } else { once() }));
    let live = runtime.clone();
    let engine = Arc::new(Engine::new(GENERATION, "ses_main".into(), Vec::new(), calls(), Arc::new(NoReader),
        Arc::new(judge), native.clone(), Arc::new(move || live.current()), runtime)
        .with_preflight_gate("per_reject", entered.clone(), gate.clone()));
    // OS blocking workers must really start before paused Tokio time may
    // advance. Pin the intended interleaving, not which submit wins the CPU.
    tokio::time::resume();
    let (reject, once) = tokio::time::timeout(Duration::from_secs(5), async {
        let reject = match engine.submit(&asked("per_reject", "ses_main")) {
            Submission::Accepted(receiver) => receiver,
            other => panic!("reject not accepted: {other:?}"),
        };
        entered.notified().await; // reject owns the session and is at preflight
        let once = match engine.submit(&asked("per_once", "ses_main")) {
            Submission::Accepted(receiver) => receiver,
            other => panic!("once not accepted: {other:?}"),
        };
        let key = Key { generation: GENERATION, session: "ses_main".into(), request: "per_once".into() };
        let waiting = engine.state.lock().unwrap().active[&key].clone();
        waiting.prepared.notified().await;
        assert_eq!(*waiting.decision.lock().unwrap(), Some(Answer::Once));
        assert!(native.sent().is_empty(), "the Once worker waits behind the reject's preflight");
        (reject, once)
    }).await.expect("both workers reached the handoff barriers before the preparation deadline");
    tokio::time::pause();
    gate.notify_one();
    let reject = report(reject).await;
    let target = report(once).await;
    assert_eq!(reject.outcome, Outcome::Delivered);
    assert!(reject.own_reject);
    assert_eq!(target.outcome, Outcome::Delivered);
    assert_eq!(target.answer, Some(Answer::Once));
    assert_eq!(target.rounds, 3, "the preflight POST counts toward the target's three");
    let sent = native.sent();
    let target_sent: Vec<&Sent> = sent.iter().filter(|sent| sent.request == "per_once").collect();
    assert_eq!(target_sent.len(), 3, "one preflight POST and two more from its worker");
    assert!(target_sent[2].at - target_sent[0].at < DELIVERY_LIMIT, "all three share t0 + 30 s");
    assert!(target_sent[0].limit <= REQUEST_LIMIT);
}

/// Three rounds at most, each POST within 15 s, with a check and a backoff
/// between them, then the unknown tail.
#[tokio::test(start_paused = true)]
async fn delivery_rounds_are_bounded_and_shared() {
    let native = FakeNative::new().always_pending(true).results([Delivery::Unknown, Delivery::Unknown, Delivery::Unknown]);
    let runtime = FakeRuntime::live();
    runtime.ends.store(true, Ordering::SeqCst);
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let report = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
    let sent = native.sent();
    assert_eq!(sent.len(), 3);
    assert!(sent.iter().all(|sent| sent.limit <= REQUEST_LIMIT), "each POST is within 15 s");
    assert_eq!(report.rounds, 3);
    assert_eq!(report.outcome, Outcome::Closed);
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1, "one interrupt, not one per round");
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.killed.load(Ordering::SeqCst), 0, "the fake ended within TEARDOWN");
}

/// The first POST may use all of its 15 s; the check still has the other 15.
#[tokio::test(start_paused = true)]
async fn a_first_post_using_its_limit_leaves_the_check_its_own() {
    let native = FakeNative::new().delays([Duration::from_secs(15)]).pending([true]).results([Delivery::Unknown, Delivery::Delivered]);
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let report = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
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
    let runtime = FakeRuntime::live();
    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new((StdMutex::new(false), Condvar::new()));
    let _unblock = Unblock(release.clone());
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel();
    let (held, finished_tx) = (release.clone(), done_tx);
    let judge = TestJudge(Arc::new(move |_, _| {
        started_tx.send(()).expect("the test waits for the worker to start");
        let (lock, cond) = &*held;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = cond.wait(released).unwrap();
        }
        let _ = finished_tx.send(());
        once()
    }));
    let engine = engine(native.clone(), runtime, judge);
    let asked = asked("per_1", "ses_main");
    tokio::time::resume();
    let submitted = Instant::now();
    let receiver = match engine.submit(&asked) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    tokio::time::timeout(PREPARE_LIMIT / 2, started_rx.recv()).await
        .expect("the blocking judge started before the preparation deadline").expect("the start sender");
    assert!(receiver.borrow().is_none(), "preparation is still waiting for the blocked judge");
    tokio::time::pause();
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

/// A request that disappears after the interrupt is `Interrupted`, and the
/// captured runtime is not touched.
#[tokio::test(start_paused = true)]
async fn an_interrupt_that_settles_is_not_a_teardown() {
    let native = FakeNative::new().pending([true, true, false]).results([Delivery::Unknown, Delivery::Unknown, Delivery::Unknown]);
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let report = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
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
    let report = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
    assert_eq!(report.outcome, Outcome::Killed);
    assert_eq!(native.aborts.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.killed.load(Ordering::SeqCst), 1);
    let t0 = native.sent()[0].at;
    let killed = runtime.killed_at.lock().unwrap().expect("KILL was sent");
    assert!(killed - t0 >= Duration::from_secs(66) && killed - t0 <= Duration::from_secs(67) + Duration::from_millis(10),
        "KILL is sent within t0 + 67 s");
}

/// An older generation is not answered, and a new runtime is not ended.
#[tokio::test(start_paused = true)]
async fn an_old_generation_is_discarded_without_ending_a_new_runtime() {
    let native = FakeNative::new();
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    runtime.current.store(false, Ordering::SeqCst);
    let report = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
    assert_eq!(report.outcome, Outcome::Discarded);
    assert_eq!(native.sent().len(), 0);
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.killed.load(Ordering::SeqCst), 0);
}

/// A reject event Core did not start is collateral; its own reject is not.
#[tokio::test(start_paused = true)]
async fn collateral_rejects_are_recorded_separately() {
    let native = FakeNative::new();
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let receiver = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    engine.replied("ses_main", "per_1", "reject");
    let report = report(receiver).await;
    assert_eq!(report.outcome, Outcome::Delivered);
    assert!(report.collateral);
}

/// Before a reject, the controller answers the request it already holds as
/// Once first, through the same ledger; the list creates no second task.
#[tokio::test(start_paused = true)]
async fn a_reject_answers_a_held_once_request_first() {
    let native = FakeNative::new();
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| reject())));
    // A request already prepared as Once and waiting for the session's turn,
    // as a concurrent event would leave it (its own worker is not needed for
    // this ordering check).
    let key = Key { generation: GENERATION, session: "ses_main".into(), request: "per_once".into() };
    let (send, receiver) = watch::channel(None);
    let entry = Arc::new(Entry {
        key: key.clone(),
        prepare_deadline: Instant::now() + PREPARE_LIMIT,
        size: 8,
        decision: StdMutex::new(Some(Answer::Once)),
        prepared: Notify::new(),
        preflight: AtomicBool::new(false),
        reject_started: AtomicBool::new(false),
        collateral: AtomicBool::new(false),
        delivery_start: StdMutex::new(None),
        terminal: StdMutex::new(false),
        rounds: std::sync::atomic::AtomicU8::new(0),
        finished: AtomicBool::new(false),
        report: send,
    });
    {
        let mut state = engine.state.lock().unwrap();
        state.bytes += 8;
        state.active.insert(key, entry);
    }
    native.list(vec![json!({"id": "per_once"})]);
    let reject = match engine.submit(&asked("per_reject", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
    assert_eq!(reject.answer, Some(Answer::Reject(Reason::WriteOutside)));
    let sent = native.sent();
    assert_eq!(sent.iter().map(|sent| sent.request.as_str()).collect::<Vec<_>>(), ["per_once", "per_reject"],
        "the Once request is answered before the reject");
    assert_eq!(sent[0].answer, Answer::Once);
    assert_eq!(report(receiver).await.outcome, Outcome::Delivered);
}

/// Core's own reject delivered with 204 keeps its ownership when its SSE
/// reject arrives late: it is not collateral and the known report is stable.
#[tokio::test(start_paused = true)]
async fn our_own_late_reject_event_is_not_collateral() {
    let native = FakeNative::new();
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| reject())));
    let asked = asked("per_1", "ses_main");
    let report = match engine.submit(&asked) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
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
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let asked = asked("per_1", "ses_main");
    let report = match engine.submit(&asked) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
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
    let report = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
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
    let report = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => report(receiver).await,
        other => panic!("not accepted: {other:?}"),
    };
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
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(native.aborts.load(Ordering::SeqCst), 0, "no abort on a stale generation");
    assert_eq!(runtime.terminated.load(Ordering::SeqCst), 0);
}

/// A POST whose response is still in flight when the connection is closed is
/// counted as started: its overload report is unknown, not "nothing sent",
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
        let receiver = match engine.submit(&asked(&format!("per_{index}"), &format!("ses_{index}"))) {
            Submission::Accepted(receiver) => receiver,
            other => panic!("request {index} not accepted: {other:?}"),
        };
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
    assert_eq!(report.outcome, Outcome::Overloaded);
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
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime.clone(), TestJudge(Arc::new(|_, _| once())));
    let mut receivers = Vec::new();
    for index in 0..REQUESTS {
        let session = format!("ses_{index}");
        if let Submission::Accepted(receiver) = engine.submit(&asked(&format!("per_{index}"), &session)) {
            receivers.push(receiver);
        } else {
            panic!("request {index} was not accepted");
        }
    }
    assert!(matches!(engine.submit(&asked("per_more", "ses_more")), Submission::Full));
    // The one close reports every held request as overloaded.
    let first = report(receivers.remove(0)).await;
    assert_eq!(first.outcome, Outcome::Overloaded);
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
    let started = Arc::new(AtomicUsize::new(0));
    let counted = started.clone();
    let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
    let released = Arc::new((StdMutex::new(false), Condvar::new()));
    let _unblock = Unblock(released.clone());
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel();
    let release = released.clone();
    let judge = TestJudge(Arc::new(move |_, _| {
        counted.fetch_add(1, Ordering::SeqCst);
        started_tx.send(()).expect("the test waits for every worker to start");
        let (lock, cond) = &*release;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = cond.wait(released).unwrap();
        }
        let _ = done_tx.send(());
        once()
    }));
    let global = Arc::new(Semaphore::new(FS_GLOBAL));
    let mut engines = Vec::new();
    for index in 0..=FS_GLOBAL {
        let native = FakeNative::new();
        let runtime = FakeRuntime::live();
        let live = runtime.clone();
        let engine = Arc::new(Engine::new(GENERATION, "ses_main".into(), Vec::new(), calls(), Arc::new(NoReader),
            Arc::new(TestJudge(judge.0.clone())), native, Arc::new(move || live.current()), runtime)
            .with_fs(Arc::new(Semaphore::new(FS_CONNECTION)), global.clone()));
        engines.push((engine, index));
    }
    // Keep real time while waiting on OS threads; paused Tokio time must
    // not exhaust their preparation deadlines before they have started.
    tokio::time::resume();
    let mut receivers = Vec::new();
    for (engine, index) in &engines {
        if let Submission::Accepted(receiver) = engine.submit(&asked(&format!("per_{index}"), "ses_main")) {
            receivers.push(receiver);
        }
    }
    tokio::time::timeout(PREPARE_LIMIT / 2, async {
        for _ in 0..FS_GLOBAL {
            started_rx.recv().await.expect("each blocking judge's start sender");
        }
    }).await.expect("all four workers started before the preparation deadline");
    assert_eq!(started.load(Ordering::SeqCst), FS_GLOBAL);
    assert!(receivers.iter().all(|receiver| receiver.borrow().is_none()), "preparation is still pending");
    tokio::time::pause();
    // Every request times out while the four OS workers remain blocked.
    // Await those reports, not a fixed number of scheduler yields.
    tokio::time::advance(PREPARE_LIMIT + Duration::from_secs(1)).await;
    let mut outcomes = Vec::new();
    for receiver in receivers {
        let report = report(receiver).await;
        assert_eq!(report.answer, Some(Answer::Reject(Reason::PreparationTimeout)));
        outcomes.push(report.outcome);
    }
    assert_eq!(started.load(Ordering::SeqCst), FS_GLOBAL, "no worker is spawned on a timeout");
    assert_eq!(global.available_permits(), 0, "timed-out workers still own all four permits");
    let (lock, cond) = &*released;
    *lock.lock().unwrap() = true;
    cond.notify_all();
    for _ in 0..FS_GLOBAL {
        done_rx.recv().await.expect("every blocking decision finished");
    }
    assert!(outcomes.iter().any(|outcome| *outcome == Outcome::Delivered));
}

/// A duplicate joins the same work and does not move the preparation bound.
#[tokio::test(start_paused = true)]
async fn a_duplicate_event_does_not_refresh_the_deadline() {
    let native = FakeNative::new();
    let gate = native.hold();
    let _open = OpenGate(gate.clone());
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let asked = asked("per_1", "ses_main");
    let receiver = match engine.submit(&asked) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
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
