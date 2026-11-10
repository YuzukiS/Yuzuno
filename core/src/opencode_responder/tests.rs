//! S4b-1's bounded responder, on fakes: no OpenCode, no network, no real
//! process. The clocks are tokio's paused clock; the blocking file-system
//! worker is a closure the test can latch; every call is recorded.
use super::*;
use crate::opencode_permissions::{Answer, Asked, Call, Calls, Decision, Reason};
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use tokio::sync::Notify;

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
    /// When set, each delivery waits for one notification.
    gate: StdMutex<Option<Arc<Notify>>>,
    /// When set with a gate, only this session's deliveries wait.
    gate_for: StdMutex<Option<String>>,
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

    fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }
}

impl Native for FakeNative {
    fn deliver<'a>(&'a self, session: &'a str, request: &'a str, answer: &'a Answer, limit: Duration)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Delivery> + Send + 'a>> {
        Box::pin(async move {
            let delay = { self.delays.lock().unwrap().pop_front() };
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let gate = { self.gate.lock().unwrap().clone() };
            let matches_session = self.gate_for.lock().unwrap().as_deref().is_none_or(|only| only == session);
            if let Some(gate) = gate.filter(|_| matches_session) {
                gate.notified().await;
            }
            self.sent.lock().unwrap().push(Sent {
                session: session.to_owned(), request: request.to_owned(), answer: answer.clone(), limit, at: Instant::now(),
            });
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
            self.ends.load(Ordering::SeqCst)
        })
    }

    fn kill(&self) {
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
    *native.gate.lock().unwrap() = Some(Arc::new(Notify::new()));
    native.gate_session("ses_main");
    let gate = native.gate.lock().unwrap().clone().unwrap();
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let main = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    let other = match engine.submit(&asked("per_1", "ses_child")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    // ses_child is not one of this connection's children in this fake, so
    // its request is refused as unbound, and still completes while main waits.
    let other = tokio::time::timeout(Duration::from_secs(2), report(other)).await.expect("the other session completes");
    assert_eq!(other.outcome, Outcome::Delivered);
    assert!(native.sent().iter().all(|sent| sent.session == "ses_child"), "the gated main-session answer has not gone");
    gate.notify_waiters();
    let main = tokio::time::timeout(Duration::from_secs(2), report(main)).await.expect("the main session after the gate");
    assert_eq!(main.outcome, Outcome::Delivered);
    assert_eq!(native.sent().len(), 2, "both sessions answered");
}

/// Two requests of one session answer one after the other, not at once.
#[tokio::test]
async fn one_session_answers_one_after_the_other() {
    let native = FakeNative::new();
    let gate = Arc::new(Notify::new());
    *native.gate.lock().unwrap() = Some(gate.clone());
    *native.gate_for.lock().unwrap() = Some("ses_main".to_owned());
    let runtime = FakeRuntime::live();
    let engine = engine(native.clone(), runtime, TestJudge(Arc::new(|_, _| once())));
    let first = match engine.submit(&asked("per_1", "ses_main")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    let second = match engine.submit(&asked("per_2", "ses_main")) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    for _ in 0..100 {
        if !native.sent().is_empty() {
            break;
        }
        // The delivery is recorded after the gate, so wait for the worker to
        // be at the gate by letting the tasks run.
        tokio::task::yield_now().await;
    }
    gate.notify_one();
    let first = tokio::time::timeout(Duration::from_secs(2), report(first)).await.expect("the first answer");
    assert_eq!(first.outcome, Outcome::Delivered);
    assert_eq!(native.sent().len(), 1, "the second waits for the first answer");
    gate.notify_one();
    let second = tokio::time::timeout(Duration::from_secs(2), report(second)).await.expect("the second answer");
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
        outcome: Outcome::Delivered, rounds: 1, collateral: false, notice: None,
    };
    let plain = report.size();
    let mut marked = report.clone();
    marked.collateral = true;
    assert_eq!(marked.size(), plain + 4);
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
    let started = Arc::new(AtomicBool::new(false));
    let release = Arc::new((StdMutex::new(false), Condvar::new()));
    let (running, held) = (started.clone(), release.clone());
    let judge = TestJudge(Arc::new(move |_, _| {
        running.store(true, Ordering::SeqCst);
        let (lock, cond) = &*held;
        let mut done = lock.lock().unwrap();
        while !*done {
            done = cond.wait(done).unwrap();
        }
        once()
    }));
    let engine = engine(native.clone(), runtime, judge);
    let asked = asked("per_1", "ses_main");
    let submitted = Instant::now();
    let receiver = match engine.submit(&asked) {
        Submission::Accepted(receiver) => receiver,
        other => panic!("not accepted: {other:?}"),
    };
    for _ in 0..100 {
        if started.load(Ordering::SeqCst) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(started.load(Ordering::SeqCst));
    tokio::time::advance(PREPARE_LIMIT + Duration::from_secs(1)).await;
    let report = report(receiver).await;
    let (lock, cond) = &*release;
    *lock.lock().unwrap() = true;
    cond.notify_all();
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
        preflight: AtomicBool::new(false),
        reject_started: AtomicBool::new(false),
        collateral: AtomicBool::new(false),
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

/// The queue bound closes the connection once, with structured reports and
/// no answers for what it held.
#[tokio::test(start_paused = true)]
async fn the_queue_bound_closes_the_connection_once() {
    let native = FakeNative::new();
    *native.gate.lock().unwrap() = Some(Arc::new(Notify::new()));
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
    let released = Arc::new((StdMutex::new(false), Condvar::new()));
    let release = released.clone();
    let judge = TestJudge(Arc::new(move |_, _| {
        counted.fetch_add(1, Ordering::SeqCst);
        let (lock, cond) = &*release;
        let mut done = lock.lock().unwrap();
        while !*done {
            done = cond.wait(done).unwrap();
        }
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
    let mut receivers = Vec::new();
    for (engine, index) in &engines {
        if let Submission::Accepted(receiver) = engine.submit(&asked(&format!("per_{index}"), "ses_main")) {
            receivers.push(receiver);
        }
    }
    // Four blocking decisions are running; the fifth has no global permit.
    for _ in 0..100 {
        if started.load(Ordering::SeqCst) >= FS_GLOBAL {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(started.load(Ordering::SeqCst), FS_GLOBAL);
    // Move past the preparation deadline: the fifth becomes a timeout, and
    // no further worker is started for it.
    tokio::time::advance(PREPARE_LIMIT + Duration::from_secs(1)).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert_eq!(started.load(Ordering::SeqCst), FS_GLOBAL, "no worker is spawned on a timeout");
    let (lock, cond) = &*released;
    *lock.lock().unwrap() = true;
    cond.notify_all();
    // Every engine finishes; the timed-out one delivered a preparation reject.
    let mut outcomes = Vec::new();
    for receiver in receivers {
        outcomes.push(report(receiver).await.outcome);
    }
    assert!(outcomes.iter().any(|outcome| *outcome == Outcome::Delivered));
}

/// A duplicate joins the same work and does not move the preparation bound.
#[tokio::test(start_paused = true)]
async fn a_duplicate_event_does_not_refresh_the_deadline() {
    let native = FakeNative::new();
    let gate = Arc::new(Notify::new());
    *native.gate.lock().unwrap() = Some(gate.clone());
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
    gate.notify_one();
    let report = report(receiver).await;
    assert_eq!(report.outcome, Outcome::Delivered);
}
