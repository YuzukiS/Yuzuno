//! The Workspace's remote sessions (YN-83 S1 PR4b; design v4 PR4 items 3,
//! 5, 6, 7, 11 and 12, and the Lead's 8447): who may start one, when each
//! closes, what a stop and a backoff hold, and what an edit, a removal, a
//! drain or a shutdown does. Sessions are fake Links this test drives, the
//! records a list it holds, and time a clock it moves: no process starts.

use super::link::{Ended, FakeLink, Link, Phase, Stamped, Terminal};
use super::protocol::{After, Code, CpuSource, Exit, Hello, MemorySource, Platform};
use super::registry::{answer, CheckTicket, Clock, Closed, Closing, Host, Registry, Timing};
use crate::remote::RemoteMachine;
use crate::updates::admission::Admission;
use anyhow::Result;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Notify, Semaphore};

const SECOND: Duration = Duration::from_secs(1);

/// Time that moves only when the test says so.
#[derive(Clone)]
struct TestClock(Arc<ClockState>);

struct ClockState {
    base: Instant,
    offset: Mutex<Duration>,
    moved: Notify,
}

impl TestClock {
    fn new() -> TestClock {
        TestClock(Arc::new(ClockState { base: Instant::now(), offset: Mutex::new(Duration::ZERO), moved: Notify::new() }))
    }

    fn advance(&self, by: Duration) {
        *self.0.offset.lock().unwrap() += by;
        self.0.moved.notify_waiters();
    }
}

impl Clock for TestClock {
    fn now(&self) -> Instant {
        self.0.base + *self.0.offset.lock().unwrap()
    }

    fn sleep_until(&self, at: Instant) -> BoxFuture<'static, ()> {
        let clock = self.clone();
        Box::pin(async move {
            loop {
                let moved = clock.0.moved.notified();
                tokio::pin!(moved);
                moved.as_mut().enable();
                if clock.now() >= at {
                    return;
                }
                moved.await;
            }
        })
    }
}

/// A session this test started, by machine and generation.
struct Started {
    id: String,
    fake: FakeLink,
}

type Sessions = Arc<Mutex<Vec<Started>>>;

struct TestHost {
    registry: Registry,
    admission: Arc<Admission>,
    /// None: the store cannot be read.
    machines: Mutex<Option<Vec<RemoteMachine>>>,
    /// While set, a read of the records waits for a permit.
    hold_reads: Mutex<Option<Arc<Semaphore>>>,
    sessions: Sessions,
    /// Runs as each session starts.
    on_start: Mutex<Option<Box<dyn Fn() + Send>>>,
    local: Option<String>,
}

impl Host for TestHost {
    fn registry(&self) -> &Registry {
        &self.registry
    }

    fn admission(&self) -> &Arc<Admission> {
        &self.admission
    }

    fn registered(&self) -> BoxFuture<'_, Result<Vec<RemoteMachine>>> {
        Box::pin(async move {
            let hold = self.hold_reads.lock().unwrap().clone();
            if let Some(hold) = hold {
                let _permit = hold.acquire().await.unwrap();
            }
            self.machines.lock().unwrap().clone().ok_or_else(|| anyhow::anyhow!("the store could not be read"))
        })
    }

    fn start(&self, machine: &RemoteMachine, generation: u64) -> Result<Link> {
        let (link, fake) = Link::fake(generation);
        self.sessions.lock().unwrap().push(Started { id: machine.id.clone(), fake });
        if let Some(hook) = &*self.on_start.lock().unwrap() {
            hook();
        }
        Ok(link)
    }

    fn local_host(&self) -> Option<String> {
        self.local.clone()
    }
}

fn machine(id: &str, target: &str, root: &str) -> RemoteMachine {
    RemoteMachine {
        id: id.into(),
        name: format!("{id} box"),
        target: target.into(),
        codex: "codex".into(),
        default_cwd: "/srv/synthetic/work".into(),
        data_root: Some(root.into()),
        ..Default::default()
    }
}

fn lab(machines: Vec<RemoteMachine>) -> (Arc<TestHost>, TestClock, Sessions) {
    let clock = TestClock::new();
    let sessions: Sessions = Arc::default();
    let host = Arc::new(TestHost {
        registry: Registry::new(Timing::PRODUCTION, Arc::new(clock.clone())),
        admission: Arc::new(Admission::default()),
        machines: Mutex::new(Some(machines)),
        hold_reads: Mutex::new(None),
        sessions: sessions.clone(),
        on_start: Mutex::new(None),
        local: None,
    });
    (host, clock, sessions)
}

async fn get(host: &Arc<TestHost>) -> Vec<Value> {
    answer(host).await.unwrap()["machines"].as_array().unwrap().clone()
}

fn state(rows: &[Value], id: &str) -> (String, Value) {
    let row = rows.iter().find(|row| row["id"] == id).unwrap_or_else(|| panic!("{id} in {rows:?}"));
    (row["state"].as_str().unwrap().to_owned(), row["code"].clone())
}

fn starts(sessions: &Sessions, id: &str) -> usize {
    sessions.lock().unwrap().iter().filter(|started| started.id == id).count()
}

/// The `n`th session started on `id`.
fn with<T>(sessions: &Sessions, id: &str, n: usize, f: impl FnOnce(&mut FakeLink) -> T) -> T {
    let mut sessions = sessions.lock().unwrap();
    let started = sessions.iter_mut().filter(|started| started.id == id).nth(n).unwrap_or_else(|| panic!("session {n} of {id}"));
    f(&mut started.fake)
}

/// Core asked it to close, or dropped its Link.
fn closed(sessions: &Sessions, id: &str, n: usize) -> bool {
    with(sessions, id, n, |fake| !matches!(fake.closing.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)))
}

fn hello(sessions: &Sessions, clock: &TestClock, id: &str, n: usize) {
    let now = clock.now();
    with(sessions, id, n, |fake| {
        let value = Hello {
            session_id: "ab".repeat(16),
            host_id: None,
            boot_id: None,
            account_key: None,
            platform: Platform::Linux,
            python: "3.12.4".into(),
            cpu: Some(CpuSource::ProcStat),
            memory: Some(MemorySource::Meminfo),
            why: vec![],
        };
        fake.state.send_modify(|state| {
            state.phase = Phase::Online;
            state.hello = Some(Arc::new(Stamped { value, received: now }));
            state.last_frame = Some(now);
        });
    });
}

/// The session ends: `after`, with `code`, its child reaped or not.
fn end(sessions: &Sessions, id: &str, n: usize, after: After, code: Option<Code>, reaped: bool) {
    with(sessions, id, n, |fake| {
        if reaped {
            fake.reaped.send_replace(true);
        }
        let generation = fake.state.borrow().generation;
        let terminal = Terminal {
            generation,
            after,
            code,
            ended: Ended::RemoteEnded,
            exit: if reaped { Exit::Code(0) } else { Exit::Unknown },
            bye: None,
            uploaded: false,
            reap: fake.reap.clone(),
        };
        fake.state.send_modify(|state| {
            state.phase = Phase::Ended;
            state.terminal = Some(Arc::new(terminal));
        });
    });
}

/// Waits (real time, bounded) for the registry's own tasks to get there.
async fn eventually(what: &str, done: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < until, "never: {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Lets the registry's tasks run after the clock moved or a session spoke.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gets_at_once_start_each_machine_once_and_answer_without_waiting() {
    let (host, _clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a"), machine("m2", "box-b", "/srv/b")]);
    let calls: Vec<_> = (0..8).map(|_| tokio::spawn({ let host = host.clone(); async move { get(&host).await } })).collect();
    for call in calls {
        let rows = call.await.unwrap();
        // No handshake is waited for: the answer says it is connecting.
        assert!(rows.iter().all(|row| row["state"] == "connecting"), "{rows:?}");
    }
    assert_eq!((starts(&sessions, "m1"), starts(&sessions, "m2")), (1, 1));
    get(&host).await;
    assert_eq!((starts(&sessions, "m1"), starts(&sessions, "m2")), (1, 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sixty_seconds_after_the_last_interest_every_session_closes_by_itself() {
    let (host, clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a"), machine("m2", "box-b", "/srv/b")]);
    get(&host).await;
    hello(&sessions, &clock, "m1", 0);
    settle().await;
    clock.advance(59 * SECOND);
    settle().await;
    // A GET just before the end keeps it.
    get(&host).await;
    clock.advance(59 * SECOND);
    settle().await;
    assert!(!closed(&sessions, "m1", 0) && !closed(&sessions, "m2", 0));
    // Exactly 60 s after that GET: online and still connecting alike, with
    // no GET to see it (and no spinning at that instant).
    clock.advance(SECOND);
    eventually("both closed", || closed(&sessions, "m1", 0) && closed(&sessions, "m2", 0)).await;
    // A proven clean end is idle, and the next interest starts it again.
    end(&sessions, "m1", 0, After::Clean, None, true);
    settle().await;
    assert_eq!(state(&host.registry.peek()["machines"].as_array().unwrap().clone(), "m1").0, "idle");
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m1").0, "connecting");
    assert_eq!(starts(&sessions, "m1"), 2);
    // m2 closed before its hello: its end was not proven clean, so it stops.
    end(&sessions, "m2", 0, After::Stop, Some(Code::UncleanExit), true);
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m2"), ("unavailable".into(), "unclean_exit".into()));
    assert_eq!(starts(&sessions, "m2"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_backoff_doubles_ends_idle_without_the_interest_and_resets_only_on_a_hello() {
    let (host, clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a")]);
    let retry = |rows: &[Value]| rows[0]["retryAt"].as_str().map(str::to_owned);
    get(&host).await;
    end(&sessions, "m1", 0, After::Backoff, Some(Code::SshUnreachable), true);
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m1"), ("offline".into(), "ssh_unreachable".into()));
    let first = chrono::DateTime::parse_from_rfc3339(&retry(&rows).unwrap()).unwrap();
    let seen = chrono::DateTime::parse_from_rfc3339(rows[0]["observedAt"].as_str().unwrap()).unwrap();
    assert_eq!((first - seen).num_milliseconds(), 1000, "{rows:?}");
    // A GET during the backoff starts nothing.
    get(&host).await;
    assert_eq!(starts(&sessions, "m1"), 1);
    // It ends while the interest lasts: started again, with no GET.
    clock.advance(SECOND);
    eventually("the retry", || starts(&sessions, "m1") == 2).await;
    end(&sessions, "m1", 1, After::Backoff, Some(Code::SshUnreachable), true);
    settle().await;
    let rows = host.registry.peek()["machines"].as_array().unwrap().clone();
    let (at, seen) = (retry(&rows).unwrap(), rows[0]["observedAt"].as_str().unwrap().to_owned());
    let wait = chrono::DateTime::parse_from_rfc3339(&at).unwrap() - chrono::DateTime::parse_from_rfc3339(&seen).unwrap();
    assert_eq!(wait.num_milliseconds(), 2000, "doubled: {rows:?}");
    // Past the interest by then: idle, nothing started.
    clock.advance(61 * SECOND);
    settle().await;
    eventually("idle", || state(&host.registry.peek()["machines"].as_array().unwrap().clone(), "m1").0 == "idle").await;
    assert_eq!(starts(&sessions, "m1"), 2);
    // A new interest starts it, and does not reset the count: 4 s next.
    get(&host).await;
    assert_eq!(starts(&sessions, "m1"), 3);
    end(&sessions, "m1", 2, After::Backoff, Some(Code::SshUnreachable), true);
    let rows = get(&host).await;
    let wait = chrono::DateTime::parse_from_rfc3339(&retry(&rows).unwrap()).unwrap()
        - chrono::DateTime::parse_from_rfc3339(rows[0]["observedAt"].as_str().unwrap()).unwrap();
    assert_eq!(wait.num_milliseconds(), 4000, "{rows:?}");
    // A session that says hello does: the next failure waits 1 s again.
    clock.advance(4 * SECOND);
    eventually("the retry", || starts(&sessions, "m1") == 4).await;
    hello(&sessions, &clock, "m1", 3);
    settle().await;
    end(&sessions, "m1", 3, After::Clean, None, true);
    get(&host).await;
    end(&sessions, "m1", 4, After::Backoff, Some(Code::SshUnreachable), true);
    let rows = get(&host).await;
    let wait = chrono::DateTime::parse_from_rfc3339(&retry(&rows).unwrap()).unwrap()
        - chrono::DateTime::parse_from_rfc3339(rows[0]["observedAt"].as_str().unwrap()).unwrap();
    assert_eq!(wait.num_milliseconds(), 1000, "{rows:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stop_holds_until_a_later_check_reaches_the_machine_as_it_is() {
    let m1 = machine("m1", "box-a", "/srv/a");
    let (host, clock, sessions) = lab(vec![m1.clone()]);
    get(&host).await;
    // Checks started before the stop, of another root, or after it but failing.
    let before = host.registry.check_started(&m1);
    end(&sessions, "m1", 0, After::Stop, Some(Code::UncleanExit), true);
    let other_root = host.registry.check_started(&machine("m1", "box-a", "/srv/old"));
    let other_target = host.registry.check_started(&machine("m1", "box-old", "/srv/a"));
    let _failed = host.registry.check_started(&m1);
    // Three interests, the interest's end and a backoff's time: nothing starts.
    for _ in 0..3 {
        let rows = get(&host).await;
        assert_eq!(state(&rows, "m1"), ("unavailable".into(), "unclean_exit".into()));
    }
    clock.advance(120 * SECOND);
    settle().await;
    get(&host).await;
    for ticket in [&before, &other_root, &other_target] {
        host.registry.check_reached(ticket);
        assert_eq!(state(&get(&host).await, "m1").0, "unavailable", "{ticket:?}");
    }
    assert_eq!(starts(&sessions, "m1"), 1);
    // One started after the stop, of the machine as it is, that reached it.
    let after: CheckTicket = host.registry.check_started(&m1);
    host.registry.check_reached(&after);
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m1").0, "connecting");
    assert_eq!(starts(&sessions, "m1"), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_target_or_root_is_another_session_and_the_old_ones_news_changes_nothing() {
    let (host, clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a")]);
    get(&host).await;
    hello(&sessions, &clock, "m1", 0);
    end(&sessions, "m1", 0, After::Stop, Some(Code::Protocol), true);
    assert_eq!(state(&get(&host).await, "m1").0, "unavailable");
    // A new name or budget changes nothing: still stopped, nothing closed.
    let mut renamed = machine("m1", "box-a", "/srv/a");
    renamed.name = "renamed".into();
    renamed.max_jobs = Some(3);
    *host.machines.lock().unwrap() = Some(vec![renamed.clone()]);
    let rows = get(&host).await;
    assert_eq!((state(&rows, "m1").0.as_str(), rows[0]["name"].as_str()), ("unavailable", Some("renamed")));
    // A new data root: the stop goes, and a new session starts.
    let moved = machine("m1", "box-a", "/srv/b");
    {
        let held = host.registry.hold().await;
        *host.machines.lock().unwrap() = Some(vec![moved.clone()]);
        host.registry.saved(&held, &moved);
    }
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m1").0, "connecting");
    assert_eq!(starts(&sessions, "m1"), 2);
    hello(&sessions, &clock, "m1", 1);
    get(&host).await;
    // A new target while it is online: closed, and nothing of it is shown.
    let pointed = machine("m1", "box-c", "/srv/b");
    {
        let held = host.registry.hold().await;
        *host.machines.lock().unwrap() = Some(vec![pointed.clone()]);
        host.registry.saved(&held, &pointed);
    }
    assert!(closed(&sessions, "m1", 1));
    let rows = host.registry.peek()["machines"].as_array().unwrap().clone();
    assert_eq!((rows[0]["state"].clone(), rows[0]["platform"].clone(), rows[0]["load"].clone()), ("idle".into(), Value::Null, Value::Null));
    // Until its child is reaped, nothing starts for the new target.
    assert_eq!(state(&get(&host).await, "m1").0, "idle");
    assert_eq!(starts(&sessions, "m1"), 2);
    // It ends unclean, reaped: that stop was the old session's, not the new record's.
    end(&sessions, "m1", 1, After::Stop, Some(Code::UncleanExit), true);
    settle().await;
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m1").0, "connecting", "{rows:?}");
    assert_eq!(starts(&sessions, "m1"), 3);
    // Nor does its news after that change the new session.
    hello(&sessions, &clock, "m1", 1);
    settle().await;
    let rows = get(&host).await;
    assert_eq!((state(&rows, "m1").0.as_str(), rows[0]["platform"].clone()), ("connecting", Value::Null), "{rows:?}");
    assert_eq!(starts(&sessions, "m1"), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unreaped_child_holds_its_machine_through_edits_removal_and_the_same_id_again() {
    let m1 = machine("m1", "box-a", "/srv/a");
    let (host, _clock, sessions) = lab(vec![m1.clone()]);
    get(&host).await;
    // Ended unclean, the child not reaped yet.
    end(&sessions, "m1", 0, After::Stop, Some(Code::UncleanExit), false);
    get(&host).await;
    // A new target clears the stop, but the old child still holds it.
    let pointed = machine("m1", "box-b", "/srv/a");
    *host.machines.lock().unwrap() = Some(vec![pointed.clone()]);
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m1").0, "idle");
    assert_eq!(starts(&sessions, "m1"), 1);
    // Removed: no longer listed, still held.
    {
        let held = host.registry.hold().await;
        *host.machines.lock().unwrap() = Some(vec![]);
        host.registry.removed(&held, "m1");
    }
    assert!(get(&host).await.is_empty());
    // Back under the same id, as it was: still held.
    *host.machines.lock().unwrap() = Some(vec![m1.clone()]);
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m1").0, "idle");
    assert_eq!(starts(&sessions, "m1"), 1);
    // Only a real wait that returned opens it.
    with(&sessions, "m1", 0, |fake| fake.reaped.send_replace(true));
    let rows = get(&host).await;
    assert_eq!(state(&rows, "m1").0, "connecting");
    assert_eq!(starts(&sessions, "m1"), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_removal_waits_for_a_get_that_read_the_records_and_one_after_it_starts_nothing() {
    let (host, _clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a")]);
    let reads = Arc::new(Semaphore::new(0));
    *host.hold_reads.lock().unwrap() = Some(reads.clone());
    // A GET reads the records and waits there, holding the gate.
    let reading = tokio::spawn({ let host = host.clone(); async move { get(&host).await } });
    settle().await;
    // A removal meanwhile waits for it; it commits only after.
    let removal = tokio::spawn({
        let host = host.clone();
        async move {
            let held = host.registry.hold().await;
            *host.machines.lock().unwrap() = Some(vec![]);
            host.registry.removed(&held, "m1");
        }
    });
    settle().await;
    assert!(!removal.is_finished());
    assert_eq!(host.machines.lock().unwrap().as_ref().map(Vec::len), Some(1));
    reads.add_permits(1);
    let rows = reading.await.unwrap();
    removal.await.unwrap();
    // The GET saw it registered and started it; the removal then closed it.
    assert_eq!((state(&rows, "m1").0.as_str(), starts(&sessions, "m1")), ("connecting", 1));
    assert!(closed(&sessions, "m1", 0));
    // A GET after the removal reads the records without it: nothing starts.
    reads.add_permits(100);
    assert!(get(&host).await.is_empty());
    assert_eq!(starts(&sessions, "m1"), 1);
    // A record the store cannot read now starts nothing and records nothing.
    let (host, clock, sessions) = lab(vec![machine("m2", "box-b", "/srv/b")]);
    *host.machines.lock().unwrap() = None;
    assert!(answer(&host).await.is_err());
    assert_eq!((starts(&sessions, "m2"), host.registry.interest()), (0, None));
    // Nor does a backoff that ends then.
    *host.machines.lock().unwrap() = Some(vec![machine("m2", "box-b", "/srv/b")]);
    get(&host).await;
    end(&sessions, "m2", 0, After::Backoff, Some(Code::SshUnreachable), true);
    settle().await;
    *host.machines.lock().unwrap() = None;
    clock.advance(SECOND);
    eventually("idle", || state(&host.registry.peek()["machines"].as_array().unwrap().clone(), "m2").0 == "idle").await;
    assert_eq!(starts(&sessions, "m2"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_drain_starts_nothing_closes_every_session_and_reopening_keeps_stops_and_interest() {
    let (host, clock, sessions) =
        lab(vec![machine("m1", "box-a", "/srv/a"), machine("m2", "box-b", "/srv/b"), machine("m3", "box-c", "/srv/c")]);
    get(&host).await;
    let interest = host.registry.interest();
    hello(&sessions, &clock, "m1", 0);
    end(&sessions, "m2", 0, After::Stop, Some(Code::SshAuth), true);
    end(&sessions, "m3", 0, After::Backoff, Some(Code::SshUnreachable), true);
    settle().await;
    host.admission.begin_drain("update").unwrap();
    // The session is asked to close, with no GET.
    eventually("m1 closed", || closed(&sessions, "m1", 0)).await;
    end(&sessions, "m1", 0, After::Clean, None, true);
    // Neither the backoff's end nor a GET starts anything, and no interest is recorded.
    clock.advance(2 * SECOND);
    eventually("m3 idle", || state(&host.registry.peek()["machines"].as_array().unwrap().clone(), "m3").0 == "idle").await;
    let rows = get(&host).await;
    assert_eq!((state(&rows, "m1").0.as_str(), state(&rows, "m3").0.as_str()), ("idle", "idle"), "{rows:?}");
    assert_eq!(host.registry.interest(), interest);
    assert_eq!((starts(&sessions, "m1"), starts(&sessions, "m3")), (1, 1));
    // Reopened: the stop stays, and the interest is what it was.
    host.admission.reopen("update").unwrap();
    assert_eq!(state(&host.registry.peek()["machines"].as_array().unwrap().clone(), "m2"), ("unavailable".into(), "ssh_auth".into()));
    assert_eq!(host.registry.interest(), interest);
    // The next GET starts what may start, by the usual rules.
    let rows = get(&host).await;
    assert_eq!((state(&rows, "m1").0.as_str(), state(&rows, "m2").0.as_str(), state(&rows, "m3").0.as_str()), ("connecting", "unavailable", "connecting"));
    // A drain that begins while a GET starts sessions: the one starting is
    // closed at once, and none after it starts.
    let (host, _clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a"), machine("m2", "box-b", "/srv/b")]);
    let admission = host.admission.clone();
    *host.on_start.lock().unwrap() = Some(Box::new(move || {
        let _ = admission.begin_drain("update");
    }));
    get(&host).await;
    assert_eq!((starts(&sessions, "m1"), starts(&sessions, "m2")), (1, 0));
    assert!(closed(&sessions, "m1", 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_admissions_other_changes_never_wake_the_registry_and_a_drain_does() {
    let (host, _clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a")]);
    get(&host).await;
    settle().await;
    let before = host.registry.steps();
    // Every permit's end notifies the admission's waiters.
    for _ in 0..1000 {
        drop(host.admission.enter_completion().unwrap());
    }
    settle().await;
    assert!(host.registry.steps() - before <= 1, "{} steps for 1000 permits", host.registry.steps() - before);
    assert!(!closed(&sessions, "m1", 0));
    host.admission.begin_drain("update").unwrap();
    eventually("closed by the drain", || closed(&sessions, "m1", 0)).await;
}

/// Core's shutdown (Ctrl+C, SIGTERM or an update's Stop) sends true on its
/// watch, then runs its other steps first: the HTTP server's graceful end,
/// OpenCode's stop. None of them is run here, as if they hung. From the
/// moment the watch says so, nothing starts here again and every session is
/// asked to close; `close_all` only waits for them later.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn once_core_shuts_down_nothing_starts_here_and_every_session_is_asked_to_close() {
    let (host, clock, sessions) =
        lab(vec![machine("m1", "box-a", "/srv/a"), machine("m2", "box-b", "/srv/b"), machine("m3", "box-c", "/srv/c")]);
    let (shutdown, watched) = watch::channel(false);
    host.registry.follow_shutdown(watched);
    get(&host).await;
    hello(&sessions, &clock, "m1", 0);
    end(&sessions, "m2", 0, After::Backoff, Some(Code::SshUnreachable), true);
    end(&sessions, "m3", 0, After::Clean, None, true);
    settle().await;
    let interest = host.registry.interest();
    shutdown.send_replace(true);
    // At once: a GET starts nothing (m3 is idle) and records nothing.
    let rows = get(&host).await;
    assert_eq!(starts(&sessions, "m3"), 1, "{rows:?}");
    assert_eq!(host.registry.interest(), interest);
    // The online session is asked to close, with no close_all.
    eventually("m1 asked to close", || closed(&sessions, "m1", 0)).await;
    // m2's backoff ends within the interest: still nothing starts.
    clock.advance(2 * SECOND);
    eventually("m2 idle", || state(&host.registry.peek()["machines"].as_array().unwrap().clone(), "m2").0 == "idle").await;
    get(&host).await;
    assert_eq!((starts(&sessions, "m1"), starts(&sessions, "m2"), starts(&sessions, "m3")), (1, 1, 1));
}

/// A start already under way when Core's shutdown is sent: its session is
/// closed as soon as it is registered, its gate stays closed until a real
/// wait, and no start after it is tried.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_start_under_way_as_core_shuts_down_is_closed_at_once_and_its_gate_stays_closed() {
    let (host, _clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a"), machine("m2", "box-b", "/srv/b")]);
    let (shutdown, watched) = watch::channel(false);
    host.registry.follow_shutdown(watched);
    *host.on_start.lock().unwrap() = Some(Box::new(move || {
        shutdown.send_replace(true);
    }));
    get(&host).await;
    assert_eq!((starts(&sessions, "m1"), starts(&sessions, "m2")), (1, 0));
    assert!(closed(&sessions, "m1", 0));
    assert!(!with(&sessions, "m1", 0, |fake| fake.reap.is_reaped()));
    // Its end is still waited for, and nothing is taken for reaped.
    let closing = tokio::spawn({ let host = host.clone(); async move { host.registry.close_all(Closing::Shutdown, Duration::MAX).await } });
    settle().await;
    end(&sessions, "m1", 0, After::Stop, Some(Code::UncleanExit), false);
    settle().await;
    assert!(!closing.is_finished());
    with(&sessions, "m1", 0, |fake| fake.reaped.send_replace(true));
    let done = tokio::time::timeout(Duration::from_secs(5), closing).await.expect("ended once reaped").unwrap();
    assert_eq!(done, Closed { waited: 1, unreaped: 0 });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_registry_lets_its_workspace_go_and_its_sessions_close_with_it() {
    let (host, _clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a")]);
    get(&host).await;
    assert!(host.registry.managing());
    let admission = host.admission.clone();
    let weak = Arc::downgrade(&host);
    drop(host);
    // Nothing kept it (the managing task upgrades its Weak only for a step):
    // the sessions were dropped with it, which closes them, and the managing
    // task ended (it held the admission).
    eventually("the host dropped", || weak.upgrade().is_none()).await;
    assert!(closed(&sessions, "m1", 0));
    eventually("the managing task ended", || Arc::strong_count(&admission) == 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_waits_14_s_in_all_however_many_machines_and_takes_nothing_for_ended() {
    let machines: Vec<RemoteMachine> = (0..6).map(|n| machine(&format!("m{n}"), &format!("box-{n}"), &format!("/srv/{n}"))).collect();
    let (host, clock, sessions) = lab(machines);
    get(&host).await;
    let closing = tokio::spawn({ let host = host.clone(); async move { host.registry.close_all(Closing::Shutdown, Duration::MAX).await } });
    settle().await;
    for n in 0..6 {
        assert!(closed(&sessions, &format!("m{n}"), 0), "m{n}");
    }
    clock.advance(Timing::PRODUCTION.closing() - Duration::from_millis(1));
    settle().await;
    assert!(!closing.is_finished());
    clock.advance(Duration::from_millis(1));
    let done = tokio::time::timeout(Duration::from_secs(5), closing).await.expect("ended at 14 s").unwrap();
    assert_eq!(done, Closed { waited: 6, unreaped: 6 });
    // Shut down: nothing starts again, and nothing was taken for reaped.
    let rows = get(&host).await;
    assert_eq!(rows.len(), 6);
    assert!(sessions.lock().unwrap().iter().all(|started| !started.fake.reap.is_reaped()));
    assert_eq!(starts(&sessions, "m0"), 1);
    // Sessions that end at once: no waiting. A detach leaves the usual rules.
    let (host, _clock, sessions) = lab(vec![machine("m1", "box-a", "/srv/a")]);
    get(&host).await;
    let closing = tokio::spawn({ let host = host.clone(); async move { host.registry.close_all(Closing::Detach, Duration::MAX).await } });
    eventually("asked to close", || closed(&sessions, "m1", 0)).await;
    end(&sessions, "m1", 0, After::Clean, None, true);
    let done = tokio::time::timeout(Duration::from_secs(5), closing).await.expect("no wait").unwrap();
    assert_eq!(done, Closed { waited: 1, unreaped: 0 });
    get(&host).await;
    assert_eq!(starts(&sessions, "m1"), 2);
}
