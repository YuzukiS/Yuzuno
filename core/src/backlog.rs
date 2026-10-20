//! What Core has received from an Agent's native runtime but not yet applied.
//!
//! For each connection, Core keeps the arrival time of every native event in
//! flight, from the moment its transport read it until the consumer finished
//! applying it. "Applying" includes waiting for the Agent's ownership lock or
//! the database. This lives in memory only and uses the receiving side's
//! monotonic clock. Nothing about the queue changes: its bound, its order, the
//! EventBarrier, storage and retries all behave as before. Only arrival times
//! are kept, never event content.
//!
//! This is Core's own backlog. It says nothing about the native runtime's
//! output buffers, the network or how fast a client renders.
use crate::workspace::Workspace;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

/// One connection's events in flight, oldest first. The consumer applies them
/// in arrival order, so the oldest one is the next to finish.
#[derive(Default)]
pub(crate) struct Backlog {
    arrivals: Mutex<VecDeque<Instant>>,
}

impl Backlog {
    fn received(&self) {
        self.arrivals.lock().unwrap().push_back(Instant::now());
    }

    /// The newest event never entered the queue.
    fn withdrawn(&self) {
        self.arrivals.lock().unwrap().pop_back();
    }

    /// The consumer finished applying the oldest event.
    pub(crate) fn applied(&self) {
        self.arrivals.lock().unwrap().pop_front();
    }

    /// Events in flight, and how long the oldest has waited.
    fn snapshot(&self, now: Instant) -> (usize, Duration) {
        let arrivals = self.arrivals.lock().unwrap();
        let oldest = arrivals
            .front()
            .map_or(Duration::ZERO, |at| now.saturating_duration_since(*at));
        (arrivals.len(), oldest)
    }
}

/// A transport's way into its consumer's queue. A plain sender (model
/// catalogs, reviews, tests) is not observed.
#[derive(Clone)]
pub struct EventSender {
    tx: mpsc::Sender<Value>,
    backlog: Option<Arc<Backlog>>,
}

impl EventSender {
    pub(crate) fn observed(tx: mpsc::Sender<Value>, backlog: Arc<Backlog>) -> Self {
        Self {
            tx,
            backlog: Some(backlog),
        }
    }

    /// Counts the event as received, then waits for room in the queue as before.
    pub async fn send(&self, message: Value) -> Result<(), mpsc::error::SendError<Value>> {
        let Some(backlog) = &self.backlog else {
            return self.tx.send(message).await;
        };
        backlog.received();
        // Taken back unless it enters the queue: a closed queue, or this
        // send dropped while it waited for room.
        let mut unsent = Unsent(Some(backlog));
        let sent = self.tx.send(message).await;
        if sent.is_ok() {
            unsent.0 = None;
        }
        sent
    }
}

struct Unsent<'a>(Option<&'a Backlog>);

impl Drop for Unsent<'_> {
    fn drop(&mut self) {
        if let Some(backlog) = self.0 {
            backlog.withdrawn();
        }
    }
}

impl From<mpsc::Sender<Value>> for EventSender {
    fn from(tx: mpsc::Sender<Value>) -> Self {
        Self { tx, backlog: None }
    }
}

/// Barrier markers share the queue but are not native events.
pub(crate) fn is_native(message: &Value) -> bool {
    message.get("_yuzunoUpdateBarrier").is_none()
}

/// Each Agent's latest connection and its backlog.
#[derive(Default)]
pub(crate) struct Backlogs(Mutex<HashMap<String, (u64, Arc<Backlog>)>>);

impl Backlogs {
    pub(crate) fn track(&self, agent: &str, generation: u64, backlog: Arc<Backlog>) {
        self.0
            .lock()
            .unwrap()
            .insert(agent.into(), (generation, backlog));
    }
}

impl Workspace {
    /// The Agent's current connection: its generation, and whether it is
    /// closing (a shutdown that fails leaves the same connection open again).
    fn connection(&self, agent: &str) -> Option<(u64, bool)> {
        let codex = self
            .rpcs
            .lock()
            .unwrap()
            .get(agent)
            .map(|c| (c.generation, c.closing));
        codex.or_else(|| {
            self.claudes
                .lock()
                .unwrap()
                .get(agent)
                .map(|c| (c.generation, false))
        })
    }

    /// Core's backlog for every Agent with a live connection. An Agent that
    /// is missing has no backlog Core can see (not connected, or its
    /// connection is closing); that is unknown, not zero.
    pub fn backlog(&self) -> Value {
        let now = Instant::now();
        let tracked: Vec<_> = self
            .backlogs
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(agent, (generation, backlog))| (agent.clone(), *generation, backlog.clone()))
            .collect();
        let mut agents = Map::new();
        let mut ended = Vec::new();
        for (agent, generation, backlog) in tracked {
            match self.connection(&agent) {
                Some((current, closing)) if current == generation => {
                    // Closing: not reported, but kept in case the shutdown fails.
                    if closing {
                        continue;
                    }
                }
                // Ended, or replaced by a newer generation.
                _ => {
                    ended.push((agent, generation));
                    continue;
                }
            }
            let (pending, oldest) = backlog.snapshot(now);
            agents.insert(
                agent,
                json!({
                    "generation": generation,
                    "pending": pending,
                    "oldestMs": oldest.as_millis() as u64,
                }),
            );
        }
        if !ended.is_empty() {
            let mut map = self.backlogs.0.lock().unwrap();
            for (agent, generation) in ended {
                if map
                    .get(&agent)
                    .is_some_and(|(current, _)| *current == generation)
                {
                    map.remove(&agent);
                }
            }
        }
        json!({"observedAt": chrono::Utc::now().to_rfc3339(), "agents": agents})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_event_counts_from_its_arrival_until_it_is_applied() {
        let (tx, mut rx) = mpsc::channel(1);
        let backlog = Arc::new(Backlog::default());
        let sender = EventSender::observed(tx, backlog.clone());
        sender.send(json!({"method":"a"})).await.unwrap();
        // The queue is full: the next event is received but waits to enter it.
        let waiting = tokio::spawn({
            let sender = sender.clone();
            async move { sender.send(json!({"method":"b"})).await }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            backlog.snapshot(Instant::now()).0,
            2,
            "a queued and b waiting for room"
        );
        let first = rx.recv().await.unwrap();
        assert_eq!(first["method"], "a");
        assert_eq!(
            backlog.snapshot(Instant::now()).0,
            2,
            "a is out of the queue but not yet applied"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            backlog.snapshot(Instant::now()).1 >= Duration::from_millis(40),
            "the oldest age is a's"
        );
        backlog.applied();
        waiting.await.unwrap().unwrap();
        rx.recv().await.unwrap();
        assert_eq!(backlog.snapshot(Instant::now()).0, 1);
        backlog.applied();
        assert_eq!(backlog.snapshot(Instant::now()), (0, Duration::ZERO));
    }

    #[tokio::test]
    async fn an_event_for_a_closed_queue_is_not_left_behind() {
        let (tx, rx) = mpsc::channel(4);
        drop(rx);
        let backlog = Arc::new(Backlog::default());
        assert!(EventSender::observed(tx, backlog.clone())
            .send(json!({}))
            .await
            .is_err());
        assert_eq!(backlog.snapshot(Instant::now()).0, 0);
    }

    #[tokio::test]
    async fn an_event_whose_send_is_dropped_is_not_left_behind() {
        let (tx, _rx) = mpsc::channel(1);
        let backlog = Arc::new(Backlog::default());
        let sender = EventSender::observed(tx, backlog.clone());
        sender.send(json!({"method":"a"})).await.unwrap();
        let waited = tokio::time::timeout(
            Duration::from_millis(30),
            sender.send(json!({"method":"b"})),
        )
        .await;
        assert!(waited.is_err(), "the queue stayed full");
        assert_eq!(
            backlog.snapshot(Instant::now()).0,
            1,
            "only the event that entered the queue counts"
        );
    }

    #[test]
    fn barrier_markers_are_not_native_events() {
        assert!(is_native(&json!({"method":"turn/started"})));
        assert!(!is_native(&json!({"_yuzunoUpdateBarrier":"x"})));
    }
}

#[cfg(all(test, unix))]
mod workspace_tests {
    use super::*;
    use crate::model::AgentDetail;
    use std::{os::unix::fs::PermissionsExt, path::Path};

    /// A Codex runtime that answers every request. When `burst-<thread>`
    /// appears it sends that many events for its Thread; `exit-<thread>`
    /// ends it.
    const CODEX: &str = r#"#!/usr/bin/python3
import json, os, sys, threading, time
root = os.path.dirname(os.path.abspath(__file__))
lock = threading.Lock()
thread = []
def emit(v):
    with lock: print(json.dumps(v), flush=True)
def watch():
    while not thread: time.sleep(0.01)
    t = thread[0]
    while True:
        if os.path.exists(os.path.join(root, 'exit-' + t)): os._exit(0)
        path = os.path.join(root, 'burst-' + t)
        if os.path.exists(path):
            n = int(open(path).read()); os.remove(path)
            for _ in range(n):
                emit({'method':'item/agentMessage/delta','params':{'threadId':t,'turnId':'t','itemId':'m','delta':'x'}})
        path = os.path.join(root, 'turns-' + t)
        if os.path.exists(path):
            n = int(open(path).read()); os.remove(path)
            for i in range(n):
                turn = {'id':'turn-%d' % i,'status':'inProgress','items':[]}
                emit({'method':'turn/started','params':{'threadId':t,'turn':turn}})
                for _ in range(20):
                    emit({'method':'item/agentMessage/delta','params':{'threadId':t,'turnId':turn['id'],'itemId':'m','delta':'word '}})
                emit({'method':'turn/completed','params':{'threadId':t,'turn':dict(turn, status='completed')}})
        time.sleep(0.01)
threading.Thread(target=watch, daemon=True).start()
for line in sys.stdin:
    r = json.loads(line)
    if 'id' not in r: continue
    m, p = r.get('method'), r.get('params') or {}
    result = {}
    if m in ['thread/start', 'thread/resume', 'thread/read']:
        if not thread: thread.append(p.get('threadId', 'thread'))
        result = {'thread':{'id':thread[0],'status':{'type':'idle'},'turns':[]},'model':'m'}
    emit({'id':r['id'],'result':result})
"#;

    /// A Claude bridge that starts a session. When `burst` appears it sends
    /// that many events; `exit` ends it.
    const BRIDGE: &str = r#"import json, os, sys, threading, time
root = os.path.dirname(os.path.abspath(__file__))
lock = threading.Lock()
def emit(v):
    with lock: print(json.dumps(v), flush=True)
def watch():
    while True:
        if os.path.exists(os.path.join(root, 'exit')): os._exit(0)
        path = os.path.join(root, 'burst')
        if os.path.exists(path):
            n = int(open(path).read()); os.remove(path)
            for _ in range(n):
                emit({'type':'event','turnId':None,'event':{'type':'system','subtype':'status','status':None,'session_id':'s'}})
        time.sleep(0.01)
threading.Thread(target=watch, daemon=True).start()
for line in sys.stdin:
    c = json.loads(line)
    result = {'started':True,'sessionId':'s'} if c.get('op') == 'start' else {}
    emit({'type':'response','id':c.get('id'),'result':result})
"#;

    fn write_script(path: &Path, text: &str) {
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    /// Written whole, then renamed into place, so the runtime never reads half.
    fn trigger(dir: &Path, name: &str, contents: &str) {
        let partial = dir.join(format!("{name}.partial"));
        std::fs::write(&partial, contents).unwrap();
        std::fs::rename(partial, dir.join(name)).unwrap();
    }

    fn codex_agent(id: &str) -> AgentDetail {
        serde_json::from_value(
            json!({"agent":{"id":id,"name":id,"cwd":"/","model":"m","color":"sage",
            "threadId":format!("thread-{id}"),"status":"idle","createdAt":"","updatedAt":"",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]}),
        )
        .unwrap()
    }

    fn agent(ws: &Workspace, id: &str) -> Value {
        ws.backlog()["agents"][id].clone()
    }

    async fn until(what: &str, mut check: impl FnMut() -> bool) {
        for _ in 0..500 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for {what}");
    }

    #[tokio::test]
    async fn codex_events_count_from_arrival_until_applied_per_agent_and_connection() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("codex.py");
        write_script(&script, CODEX);
        let ws = Workspace::new(
            dir.path().join("data"),
            "/".into(),
            script.to_string_lossy().into(),
        )
        .unwrap();
        for id in ["a", "b"] {
            ws.store.insert(&codex_agent(id)).unwrap();
            ws.reconnect(id).await.unwrap();
        }
        assert_eq!(
            agent(&ws, "a")["pending"],
            0,
            "connected and idle: known, nothing pending"
        );
        let first = agent(&ws, "a")["generation"].as_u64().unwrap();

        // While a's events cannot be applied, one that has left the queue
        // and waits for the Agent's lock still counts, with its age.
        let held_a = ws.owner("a").await;
        trigger(dir.path(), "burst-thread-a", "1");
        until("a's event to arrive", || agent(&ws, "a")["pending"] == 1).await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(agent(&ws, "a")["oldestMs"].as_u64().unwrap() >= 250);
        trigger(dir.path(), "burst-thread-a", "40");
        until("a's burst", || agent(&ws, "a")["pending"] == 41).await;

        // Another Agent is counted, and drained, on its own.
        let held_b = ws.owner("b").await;
        trigger(dir.path(), "burst-thread-b", "30");
        until("b's burst", || agent(&ws, "b")["pending"] == 30).await;
        drop(held_b);
        until("b to catch up", || agent(&ws, "b")["pending"] == 0).await;
        assert_eq!(agent(&ws, "a")["pending"], 41, "a is still held");

        // While a close is under way the backlog is not reported; a shutdown
        // that fails keeps the same connection, and its count is still there.
        let set_closing =
            |closing: bool| ws.rpcs.lock().unwrap().get_mut("a").unwrap().closing = closing;
        set_closing(true);
        assert!(agent(&ws, "a").is_null(), "closing: unknown");
        set_closing(false);
        assert_eq!(
            agent(&ws, "a")["generation"].as_u64(),
            Some(first),
            "the same connection, still tracked"
        );
        assert_eq!(agent(&ws, "a")["pending"], 41);

        // Clients read it over HTTP while consumption lags.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = crate::server::router_on_port(ws.clone(), dir.path().join("assets"), port);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let read: Value = reqwest::get(format!("http://127.0.0.1:{port}/api/backlog"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(read["agents"]["a"]["pending"], 41);
        assert!(read["observedAt"].is_string());

        // An update barrier still waits for the earlier events and is not
        // counted itself.
        let barrier = ws
            .rpcs
            .lock()
            .unwrap()
            .get("a")
            .unwrap()
            .events
            .clone()
            .unwrap();
        let drained = tokio::spawn(async move { barrier.drain().await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !drained.is_finished(),
            "the barrier waits behind a's events"
        );
        assert_eq!(agent(&ws, "a")["pending"], 41);
        drop(held_a);
        drained.await.unwrap().unwrap();
        until("a to catch up", || agent(&ws, "a")["pending"] == 0).await;
        assert_eq!(agent(&ws, "a")["oldestMs"], 0);

        // Without a connection the backlog is unknown, not zero; a new
        // connection starts its own count.
        trigger(dir.path(), "exit-thread-a", "");
        until("a's runtime to end", || agent(&ws, "a").is_null()).await;
        assert_eq!(agent(&ws, "b")["pending"], 0, "b is unaffected");
        std::fs::remove_file(dir.path().join("exit-thread-a")).unwrap();
        ws.reconnect("a").await.unwrap();
        let second = agent(&ws, "a");
        assert!(second["generation"].as_u64().unwrap() > first);
        assert_eq!(second["pending"], 0);
    }

    /// One connection's own count, read directly (the report drops ended
    /// connections).
    fn tracked(ws: &Workspace, id: &str) -> Arc<Backlog> {
        ws.backlogs.0.lock().unwrap()[id].1.clone()
    }

    fn pending(backlog: &Backlog) -> usize {
        backlog.snapshot(Instant::now()).0
    }

    /// A barrier whose drain was cancelled leaves its marker in the queue,
    /// where it is dispatched like an event. It must not take a real event's
    /// place. The Agent's lock is fair, so taking it again at once stops the
    /// consumer at each next item.
    #[tokio::test]
    async fn an_orphaned_barrier_marker_never_takes_an_events_place() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("codex.py");
        write_script(&script, CODEX);
        let ws = Workspace::new(
            dir.path().join("data"),
            "/".into(),
            script.to_string_lossy().into(),
        )
        .unwrap();
        ws.store.insert(&codex_agent("a")).unwrap();
        ws.reconnect("a").await.unwrap();
        let backlog = tracked(&ws, "a");

        let held = ws.owner("a").await;
        trigger(dir.path(), "burst-thread-a", "1");
        until("e0 to wait for the lock", || pending(&backlog) == 1).await;
        let barrier = ws
            .rpcs
            .lock()
            .unwrap()
            .get("a")
            .unwrap()
            .events
            .clone()
            .unwrap();
        let drain = tokio::spawn(async move { barrier.drain().await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        drain.abort();
        assert!(drain.await.unwrap_err().is_cancelled());
        trigger(dir.path(), "burst-thread-a", "1");
        until("e1 behind the orphaned marker", || pending(&backlog) == 2).await;

        // e0 is applied; the consumer then waits with the marker.
        drop(held);
        let held = ws.owner("a").await;
        until("e0 to be applied", || pending(&backlog) == 1).await;
        // The marker is dispatched; the consumer then waits with e1.
        drop(held);
        let held = ws.owner("a").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(pending(&backlog), 1, "the marker did not take e1's place");
        drop(held);
        until("e1 to be applied", || pending(&backlog) == 0).await;
    }

    /// The sample behind the UI's 5 s threshold: how far behind Core gets
    /// with nothing blocked, on bursts of deltas and of whole Turns (each
    /// Turn boundary is a synchronous write). Run on demand:
    /// `cargo test --lib backlog_sample -- --ignored --nocapture --test-threads=1`.
    #[tokio::test]
    #[ignore]
    async fn backlog_sample() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("codex.py");
        write_script(&script, CODEX);
        let ws = Workspace::new(
            dir.path().join("data"),
            "/".into(),
            script.to_string_lossy().into(),
        )
        .unwrap();
        ws.store.insert(&codex_agent("a")).unwrap();
        ws.reconnect("a").await.unwrap();
        for (kind, size, events) in [
            ("burst", 500, 500),
            ("burst", 5000, 5000),
            ("turns", 50, 50 * 22),
            ("turns", 200, 200 * 22),
        ] {
            trigger(dir.path(), &format!("{kind}-thread-a"), &size.to_string());
            let started = Instant::now();
            let (mut seen, mut most, mut oldest) = (false, 0u64, 0u64);
            loop {
                let a = agent(&ws, "a");
                let pending = a["pending"].as_u64().unwrap();
                most = most.max(pending);
                oldest = oldest.max(a["oldestMs"].as_u64().unwrap());
                seen |= pending > 0;
                if (seen && pending == 0) || started.elapsed() > Duration::from_secs(60) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            println!("{kind} {size} ({events} events): most pending {most}, oldest {oldest} ms, caught up in {} ms",
                started.elapsed().as_millis());
        }
    }

    #[tokio::test]
    async fn claude_events_count_until_applied_and_are_unknown_once_the_bridge_ends() {
        // Other library tests start bridges too; none runs while this one
        // points them at python.
        let _env = crate::claude::BRIDGE_ENV.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let bridge = dir.path().join("bridge.py");
        write_script(&bridge, BRIDGE);
        std::env::set_var("YUZUNO_NODE", "python3");
        std::env::set_var("YUZUNO_CLAUDE_BRIDGE", &bridge);
        let ws = Workspace::new(dir.path().join("data"), "/".into(), "unused".into()).unwrap();
        let created = ws
            .claude_create("C".into(), String::new(), "/".into(), "m".into(), None)
            .await
            .unwrap();
        let id = created.id.clone();
        until("the bridge to connect", || {
            ws.store.detail(&id).unwrap().agent.connection_state == "connected"
        })
        .await;
        assert_eq!(agent(&ws, &id)["pending"], 0);

        let held = ws.owner(&id).await;
        trigger(dir.path(), "burst", "25");
        until("the burst to arrive", || agent(&ws, &id)["pending"] == 25).await;
        drop(held);
        until("Claude events to be applied", || {
            agent(&ws, &id)["pending"] == 0
        })
        .await;

        trigger(dir.path(), "exit", "");
        until("the bridge to end", || agent(&ws, &id).is_null()).await;

        // While an update closes the connection, its end goes another way
        // through the consumer; it is still counted until applied.
        std::fs::remove_file(dir.path().join("exit")).unwrap();
        ws.reconnect(&id).await.unwrap();
        until("the bridge to reconnect", || {
            ws.store.detail(&id).unwrap().agent.connection_state == "connected"
        })
        .await;
        let backlog = tracked(&ws, &id);
        ws.claudes.lock().unwrap()[&id]
            .events
            .clone()
            .unwrap()
            .mark_closing();
        let held = ws.owner(&id).await;
        trigger(dir.path(), "exit", "");
        until("the bridge's end to arrive", || pending(&backlog) == 1).await;
        drop(held);
        until("the end to be applied", || pending(&backlog) == 0).await;
        std::env::remove_var("YUZUNO_NODE");
        std::env::remove_var("YUZUNO_CLAUDE_BRIDGE");
    }
}
