//! How Store and Workspace share SQLite and per-Agent state under load: reads
//! beside a long write, Agents that never wait for each other, reconnect that
//! stays exclusive with one Agent's events, atomic multi-statement writes and
//! the synced default, and operations that finish although their request was
//! dropped. A child of `workspace`, so it can reach its locks.
use super::*;
use std::{
    sync::{mpsc as std_mpsc, Barrier},
    thread,
    time::Duration,
};

const PATIENCE: Duration = Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn collaboration_failure_gates_input_and_mail_without_blocking_native_control() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    ws.collaboration_url.set("http://127.0.0.1:4999".into()).unwrap();
    let mut d = agent("a", "thread-a");
    d.agent.connection_state = "connected".into();
    ws.store.insert(&d).unwrap();
    let methods = dir.path().join("methods");
    let code = r#"import json,sys
for line in sys.stdin:
 r=json.loads(line)
 m=r.get('method','response')
 with open(sys.argv[1],'a') as f:f.write(m+'\n')
 if m=='response': continue
 result={}
 if m=='mcpServer/tool/call':result={'isError':True,'content':[{'text':'HTTP 401'}]}
 if m=='thread/read':result={'thread':{'id':'thread-a','status':{'type':'active','activeFlags':[]},'turns':[{'id':'turn-a','status':'inProgress','items':[]}]}}
 if m=='thread/turns/list':result={'data':[{'id':'turn-a','status':'inProgress','items':[]}],'nextCursor':None}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#;
    let (tx, _rx) = mpsc::channel(8);
    let rpc = Rpc::spawn("python3", &["-c".into(), code.into(), methods.display().to_string()], tx).await.unwrap();
    ws.rpcs.lock().unwrap().insert("a".into(), Connection { generation: 42, rpc: rpc.clone(), closing: false, events: None, attachment: Default::default() });
    ws.collaboration_started("a", 42).await;
    let before = ws.detail("a").await.unwrap();
    ws.verify_remote_collaboration("a", "thread-a", 42, &rpc).await;
    let after = ws.detail("a").await.unwrap();
    assert_eq!(after.agent.status, "working");
    assert_eq!(after.agent.last_seq, before.agent.last_seq);
    assert_eq!(after.agent.unread_count, before.agent.unread_count);
    assert_eq!(ws.collaboration_status("a").await.unwrap().reason, Some("unauthorized"));
    assert!(ws.steer_locked("a", "do not send", "turn-a", "m").await.unwrap_err().to_string().contains("协作连接"));
    for priority in ["normal", "urgent"] {
        ws.collaboration_call(None, "peer_send", json!({"requestId":priority,"toAgentId":"a","priority":priority,"body":"Keep pending"})).await.unwrap();
    }
    for batch in ws.store.pending_peer_deliveries().unwrap() { ws.deliver_peer_batch(&batch).await.unwrap(); }
    assert_eq!(ws.store.pending_peer_deliveries().unwrap().len(), 2);
    // Native control is still available, and an ACK never marks completion.
    ws.interrupt("a").await.unwrap();
    ws.reconcile("a").await.unwrap();
    assert_eq!(ws.detail("a").await.unwrap().agent.status, "working");
    ws.store.update("a", "test/pending", &json!({}), |d| {
        d.pending.push(PendingRequest { id: "approval".into(), agent_id: "a".into(),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"_runtimeGeneration":42,"_rpcId":100}), created_at: now(), stale: false });
    }).unwrap();
    ws.respond("approval", json!({"decision":"decline"})).await.unwrap();
    ws.store.update("a", "test/idle", &json!({}), |d| {
        d.agent.status = "idle".into(); d.turns.clear(); d.pending.clear();
    }).unwrap();
    assert!(ws.send("a", "do not start".into()).await.unwrap_err().to_string().contains("协作连接"));
    for batch in ws.store.pending_peer_deliveries().unwrap() { ws.deliver_peer_batch(&batch).await.unwrap(); }
    assert_eq!(ws.store.pending_peer_deliveries().unwrap().len(), 2);
    // A replacement owns readiness; late old-generation success/failure cannot overwrite it.
    ws.rpcs.lock().unwrap().get_mut("a").unwrap().generation = 43;
    ws.collaboration_started("a", 43).await;
    ws.verify_remote_collaboration("a", "thread-a", 42, &rpc).await;
    assert!(ws.collaboration_status("a").await.unwrap().ready);
    let seen = std::fs::read_to_string(methods).unwrap();
    assert!(seen.contains("turn/interrupt") && seen.contains("thread/read") && seen.contains("response"));
    assert!(!seen.contains("turn/start") && !seen.contains("turn/steer"));
    ws.close_agent("a").await.unwrap();
    assert!(ws.detail("a").await.unwrap().agent.closed_at.is_some());
}

fn agent(id: &str, thread_id: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"m","color":"sage",
        "threadId":thread_id,"status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[{"id":format!("turn-{id}"),"status":"inProgress","items":[]}],
        "pending":[],"artifacts":[]})).unwrap()
}

fn workspace(dir: &tempfile::TempDir) -> Arc<Workspace> {
    Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap()
}

/// A second connection to the same file, as another process would see it.
fn sql(ws: &Workspace) -> rusqlite::Connection {
    rusqlite::Connection::open(ws.data_dir.join("workspace.sqlite")).unwrap()
}

fn kinds(ws: &Workspace, id: &str) -> Vec<String> {
    let db = sql(ws);
    let mut query = db.prepare("SELECT kind FROM journal WHERE agent_id=?1 ORDER BY seq").unwrap();
    query.query_map([id], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

/// A harmless stdin sink standing in for a native runtime connection.
async fn connect(ws: &Workspace, id: &str, generation: u64) -> Arc<Rpc> {
    let (tx, _rx) = mpsc::channel(8);
    let rpc = Rpc::spawn("python3", &["-c".into(), "import sys; sys.stdin.read()".into()], tx).await.unwrap();
    ws.rpcs.lock().unwrap().insert(id.into(), Connection { generation, rpc: rpc.clone(), closing: false, events: None, attachment: Default::default() });
    rpc
}

fn delta(thread_id: &str, turn: &str, text: &str) -> Value {
    json!({"method":"item/agentMessage/delta","params":{"threadId":thread_id,"turnId":turn,"itemId":"reply","delta":text}})
}

/// A completed reply Item: journaled (streamed deltas are not).
fn completed(thread_id: &str, turn: &str, text: &str) -> Value {
    json!({"method":"item/completed","params":{"threadId":thread_id,"turnId":turn,
        "item":{"id":"reply","type":"agentMessage","text":text}}})
}

/// Holds the single writer inside an IMMEDIATE transaction that has already
/// written (uncommitted) a whole Agent, until `release` is sent.
fn hold_writer(store: Arc<Store>) -> (std_mpsc::Sender<()>, thread::JoinHandle<()>) {
    let (held_tx, held_rx) = std_mpsc::channel();
    let (release_tx, release_rx) = std_mpsc::channel::<()>();
    let writer = thread::spawn(move || {
        let mut db = store.db.write().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO agents(id,data) VALUES('uncommitted',?1)",
            [serde_json::to_string(&agent("uncommitted", "t")).unwrap()]).unwrap();
        held_tx.send(()).unwrap();
        let _ = release_rx.recv();
        drop(tx);
    });
    held_rx.recv_timeout(PATIENCE).unwrap();
    (release_tx, writer)
}

#[test]
fn reads_proceed_while_a_long_write_is_in_progress() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    store.insert(&agent("a", "thread-a")).unwrap();
    store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Visible task"})).unwrap();
    let (release, writer) = hold_writer(store.clone());
    // Every kind of read the GUI and MCP make, while the writer is busy.
    let (done_tx, done_rx) = std_mpsc::channel();
    let reader = store.clone();
    thread::spawn(move || {
        let read = || -> Result<()> {
            assert_eq!(reader.detail("a")?.agent.id, "a");
            let listed = reader.agents()?;
            assert_eq!(listed.len(), 1, "the uncommitted Agent is invisible");
            reader.workspace_id()?;
            reader.projects()?;
            reader.project_usage()?;
            reader.catchup()?;
            reader.pending_peer_deliveries()?;
            assert_eq!(reader.collaboration_call(None, "task_list", json!({}))?["tasks"].as_array().unwrap().len(), 1);
            reader.collaboration_call(None, "peers_list", json!({}))?;
            reader.collaboration_call(None, "peer_read", json!({}))?;
            Ok(())
        };
        done_tx.send(read().map_err(|e| e.to_string())).unwrap();
    });
    let outcome = done_rx.recv_timeout(PATIENCE);
    release.send(()).unwrap();
    writer.join().unwrap();
    outcome.expect("reads waited for the writer").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gui_requests_are_answered_while_a_long_write_is_in_progress() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    ws.store.insert(&agent("a", "thread-a")).unwrap();
    let app = crate::server::router_on_port(ws.clone(), dir.path().to_owned(), 4440);
    let (release, writer) = hold_writer(ws.store.clone());
    let get = |path: &str| {
        let request = axum::http::Request::get(path).header("host", "127.0.0.1:4440")
            .body(axum::body::Body::empty()).unwrap();
        tower::ServiceExt::oneshot(app.clone(), request)
    };
    let answered = tokio::time::timeout(PATIENCE, async {
        for path in ["/api/workspace", "/api/agents/a", "/api/catchup", "/api/projects", "/api/machines"] {
            assert_eq!(get(path).await.unwrap().status(), axum::http::StatusCode::OK, "{path}");
        }
    }).await;
    release.send(()).unwrap();
    writer.join().unwrap();
    answered.expect("GUI reads waited for the writer");
}

/// Agent A's event is slow: A's large record is not held, so its first native
/// event loads it whole. B's events are recorded meanwhile.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_agents_slow_event_does_not_delay_another_agents_events() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    let method = "item/unknown/requestSomething";
    let mut big = agent("a", "thread-a");
    big.agent.status = "error".into();
    big.agent.error = Some(format!("当前客户端尚未支持请求：{method}。未授权任何操作。"));
    big.turns[0]["items"] = (0..150_000).map(|n| json!({"id":format!("old-{n}"),"type":"agentMessage",
        "text":"An earlier line of output that makes this record large"})).collect();
    ws.store.insert(&big).unwrap();
    ws.store.insert(&agent("b", "thread-b")).unwrap();
    ws.store.agents().unwrap();
    let (rpc_a, rpc_b) = (connect(&ws, "a", 1).await, connect(&ws, "b", 2).await);
    // An unsupported request is refused; the same refusal was already shown,
    // so nothing new is recorded for A. That check reads the Agent only.
    let request = json!({"id":7,"method":method,"params":{"threadId":"thread-a","turnId":"turn-a"}});
    ws.dispatch_event("a", 1, request).await;
    assert!(kinds(&ws, "a").is_empty());
    let slow = tokio::spawn({
        let ws = ws.clone();
        async move { ws.dispatch_event("a", 1, completed("thread-a", "turn-a", "Earlier")).await }
    });
    // Let A's handler start reading its record.
    tokio::time::sleep(Duration::from_millis(30)).await;
    tokio::time::timeout(PATIENCE, async {
        ws.dispatch_event("b", 2, completed("thread-b", "turn-b", "Hello")).await;
        ws.dispatch_event("b", 2, json!({"method":"turn/completed","params":{"threadId":"thread-b",
            "turn":{"id":"turn-b","status":"completed","items":[]}}})).await;
    }).await.unwrap();
    assert!(!slow.is_finished(), "B finished while A's slow event was still being handled");
    assert_eq!(kinds(&ws, "b"), ["item/completed", "turn/completed"]);
    assert_eq!(ws.store.detail("b").unwrap().turns[0]["status"], "completed");
    tokio::time::timeout(PATIENCE, slow).await.unwrap().unwrap();
    assert_eq!(kinds(&ws, "a"), ["item/completed"]);
    rpc_a.close();
    rpc_b.close();
}

/// While one of A's events (or its reconnect) holds A's ownership lock, A's
/// next event waits, and B is not affected at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agents_events_wait_only_for_that_agent() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    ws.store.insert(&agent("a", "thread-a")).unwrap();
    ws.store.insert(&agent("b", "thread-b")).unwrap();
    let (rpc_a, rpc_b) = (connect(&ws, "a", 1).await, connect(&ws, "b", 2).await);
    let held = ws.owner("a").await;
    let waiting = tokio::spawn({
        let ws = ws.clone();
        async move { ws.dispatch_event("a", 1, completed("thread-a", "turn-a", "after")).await }
    });
    // B streams, in order, while A is busy.
    tokio::time::timeout(PATIENCE, async {
        for n in 0..20 {
            ws.dispatch_event("b", 2, delta("thread-b", "turn-b", &format!("{n} "))).await;
        }
    }).await.unwrap();
    let streamed = ws.store.detail("b").unwrap().turns[0]["items"][0]["text"].clone();
    assert_eq!(streamed, (0..20).map(|n| format!("{n} ")).collect::<String>());
    assert!(!waiting.is_finished());
    assert!(kinds(&ws, "a").is_empty());
    drop(held);
    tokio::time::timeout(PATIENCE, waiting).await.unwrap().unwrap();
    assert_eq!(kinds(&ws, "a"), ["item/completed"]);
    rpc_a.close();
    rpc_b.close();
}

/// Retiring a connection (part of every reconnect) and handling that
/// connection's events exclude each other: whichever is first finishes before
/// the other starts, so an event of a retired connection is never recorded
/// after it was retired.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_is_mutually_exclusive_with_the_same_agents_events() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    ws.store.insert(&agent("a", "thread-a")).unwrap();
    let approval = |id: u64| json!({"id":id,"method":"item/commandExecution/requestApproval",
        "params":{"threadId":"thread-a","turnId":"turn-a","itemId":format!("command-{id}"),"command":"true"}});
    let pause = || tokio::time::sleep(Duration::from_millis(50));

    // The connection is retired first: the event that queued behind it finds
    // no connection of its generation and records nothing.
    let rpc = connect(&ws, "a", 1).await;
    let held = ws.owner("a").await;
    let retire = tokio::spawn({ let ws = ws.clone(); async move { ws.remove_connection("a", 1).await } });
    pause().await;
    let late = tokio::spawn({ let ws = ws.clone(); async move { ws.dispatch_event("a", 1, approval(1)).await } });
    pause().await;
    assert!(ws.rpcs.lock().unwrap().contains_key("a"), "retiring waits for the event in progress");
    assert!(!retire.is_finished() && !late.is_finished());
    drop(held);
    tokio::time::timeout(PATIENCE, retire).await.unwrap().unwrap();
    tokio::time::timeout(PATIENCE, late).await.unwrap().unwrap();
    assert_eq!(kinds(&ws, "a"), ["runtime/detached"]);
    assert!(ws.store.detail("a").unwrap().pending.is_empty());
    rpc.close();

    // The event is first: it is recorded completely before the retirement.
    let rpc = connect(&ws, "a", 2).await;
    let held = ws.owner("a").await;
    let event = tokio::spawn({ let ws = ws.clone(); async move { ws.dispatch_event("a", 2, approval(2)).await } });
    pause().await;
    let retire = tokio::spawn({ let ws = ws.clone(); async move { ws.remove_connection("a", 2).await } });
    pause().await;
    drop(held);
    tokio::time::timeout(PATIENCE, event).await.unwrap().unwrap();
    tokio::time::timeout(PATIENCE, retire).await.unwrap().unwrap();
    assert_eq!(kinds(&ws, "a"), ["runtime/detached", "request", "runtime/detached"]);
    let pending = ws.store.detail("a").unwrap().pending;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].params["_runtimeGeneration"], 2);
    rpc.close();
}

#[test]
fn multi_statement_writes_stay_atomic_for_concurrent_readers() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    let project = store.create_project("Linked", Default::default()).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let writer = thread::spawn({
        let (store, barrier, project) = (store.clone(), barrier.clone(), project.id.clone());
        move || {
            barrier.wait();
            for n in 0..40 {
                let mut detail = agent(&format!("agent-{n}"), "t");
                detail.agent.project_id = Some(project.clone());
                store.insert(&detail).unwrap();
            }
        }
    });
    barrier.wait();
    // An Agent is never seen outside the project it was created in.
    let mut seen = 0;
    while seen < 40 {
        let agents = store.agents().unwrap();
        assert!(agents.iter().all(|a| a.project_id.as_deref() == Some(project.id.as_str())));
        seen = agents.len();
    }
    writer.join().unwrap();

    // A failure in a later statement rolls back the earlier ones.
    let db = rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER refuse_link BEFORE INSERT ON project_agents BEGIN SELECT RAISE(ABORT,'link refused'); END;
        CREATE TRIGGER refuse_mail BEFORE INSERT ON collaboration_messages BEGIN SELECT RAISE(ABORT,'mail refused'); END;").unwrap();
    let mut detail = agent("unlinked", "t");
    detail.agent.project_id = Some(project.id.clone());
    assert!(store.insert(&detail).is_err());
    assert!(store.detail("unlinked").is_err());
    assert_eq!(store.agents().unwrap().len(), 40);
    let task = store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Dispatch me"})).unwrap();
    let dispatched = store.collaboration_call(None, "task_dispatch", json!({"requestId":"d","taskId":task["task"]["id"],
        "expectedVersion":1,"toAgentId":"agent-0"}));
    assert!(dispatched.unwrap_err().to_string().contains("mail refused"));
    let unchanged = store.collaboration_call(None, "task_get", json!({"taskId":task["task"]["id"]})).unwrap();
    assert_eq!(unchanged["task"]["version"], 1);
    assert_eq!(unchanged["task"]["status"], task["task"]["status"]);
    assert!(unchanged["task"]["assigneeAgentId"].is_null());
    // Nothing of the failed call, receipt included, was kept.
    db.execute_batch("DROP TRIGGER refuse_mail;").unwrap();
    store.collaboration_call(None, "task_dispatch", json!({"requestId":"d","taskId":task["task"]["id"],
        "expectedVersion":1,"toAgentId":"agent-0"})).unwrap();
}

#[test]
fn a_failed_write_leaves_the_writer_synced() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    store.insert(&agent("a", "thread-a")).unwrap();
    let db = rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER refuse BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    // A completed Item (journaled unsynced) and an ordinary event, both failing.
    let p = json!({"turnId":"turn-a","item":{"id":"reply","type":"agentMessage","text":"kept"}});
    let completed = || store.record_stream("a", crate::store::route("item/completed", &p), "item/completed", &p);
    assert!(completed().is_err());
    assert!(store.update("a", "turn/completed", &json!({}), |_| {}).is_err());
    // Neither connection ever changes mode.
    assert_eq!((store.db.writer_synchronous(), store.db.unsynced_synchronous()), (2, 1));
    db.execute_batch("DROP TRIGGER refuse;").unwrap();
    completed().unwrap();
    assert_eq!((store.db.writer_synchronous(), store.db.unsynced_synchronous()), (2, 1));
    assert_eq!(store.detail("a").unwrap().turns[0]["items"][0]["text"], "kept");
}

/// The client of an API request goes away while the operation's store work
/// waits for the (held) writer: hyper drops the request, but the operation
/// still runs to its end.
async fn dropped_request(ws: &Arc<Workspace>, dir: &tempfile::TempDir, method: &str, path: &str, body: &str) {
    let app = crate::server::router_on_port(ws.clone(), dir.path().to_owned(), 4440);
    let (release, writer) = hold_writer(ws.store.clone());
    let request = axum::http::Request::builder().method(method).uri(path)
        .header("host", "127.0.0.1:4440").header("x-yuzuno-client", "desktop")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_owned())).unwrap();
    let answered = tokio::time::timeout(Duration::from_millis(300), tower::ServiceExt::oneshot(app, request)).await;
    assert!(answered.is_err(), "the request was meant to be waiting for the writer");
    release.send(()).unwrap();
    writer.join().unwrap();
}

async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(PATIENCE, async {
        while !done() { tokio::time::sleep(Duration::from_millis(20)).await; }
    }).await.unwrap_or_else(|_| panic!("{what} never happened"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_agents_fork_sources_are_released_even_if_the_request_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let ws = workspace(&dir);
    let mut source = agent("s", "source-thread");
    source.codex_handoff = Some(serde_json::from_value(json!({"forkedTo":{"agentId":"a","threadId":"thread-a",
        "throughTurnId":"turn-s","turnCount":1,"at":""}})).unwrap());
    ws.store.insert(&source).unwrap();
    let mut fork = agent("a", "thread-a");
    fork.agent.status = "offline".into();
    fork.agent.closed_at = Some(now());
    ws.store.insert(&fork).unwrap();
    dropped_request(&ws, &dir, "DELETE", "/api/agents/a", "").await;
    eventually("releasing the fork source", || ws.store.detail("s").unwrap()
        .codex_handoff.is_some_and(|h| h.forked_to.is_none())).await;
    assert!(ws.store.detail("a").is_err());
    assert_eq!(kinds(&ws, "s"), ["codex/forkReleased"]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sent_message_reaches_the_runtime_even_if_the_request_is_dropped() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("native.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
class _TurnsList:
    """thread/turns/list answered as this fake's thread/read (T-140)."""
    def __init__(self, raw): self.raw, self.ids, self.buf = raw, set(), ''
    def write(self, text):
        self.buf += text
        while '\n' in self.buf:
            line, self.buf = self.buf.split('\n', 1)
            try:
                v = json.loads(line)
                if isinstance(v, dict) and v.get('id') in self.ids and 'result' in v:
                    self.ids.discard(v['id'])
                    turns = ((v['result'] or {}).get('thread') or {}).get('turns') or []
                    v['result'] = {'data': list(reversed(turns)), 'nextCursor': None}
                    line = json.dumps(v)
            except ValueError: pass
            self.raw.write(line + '\n')
        return len(text)
    def flush(self): self.raw.flush()
sys.stdout = _TurnsList(sys.stdout)
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 m=r['method']; result={}
 if m=='thread/turns/list': sys.stdout.ids.add(r['id']); m='thread/read'
 if m in ['thread/start','thread/resume','thread/read']:
  result={'thread':{'id':'native-thread','status':{'type':'idle'},'turns':[]}}
 if m=='turn/start':
  with (root/'starts.jsonl').open('a') as f:f.write(json.dumps(r['params'])+'\n')
  result={'turn':{'id':'native-turn','status':'inProgress','items':[]}}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.to_string_lossy().into()).unwrap();
    // Production configures collaboration before attaching any native session.
    ws.collaboration_url.set("http://127.0.0.1:4440".into()).unwrap();
    let mut idle = agent("a", "unused");
    idle.agent.thread_id = None;
    idle.agent.status = "offline".into();
    idle.turns.clear();
    ws.store.insert(&idle).unwrap();
    ws.reconnect("a").await.unwrap();
    dropped_request(&ws, &dir, "POST", "/api/agents/a/turns", r#"{"text":"Keep going"}"#).await;
    let starts = dir.path().join("starts.jsonl");
    eventually("accepting the turn", || kinds(&ws, "a").iter().any(|k| k == "turn/accepted")).await;
    let sent = std::fs::read_to_string(starts).unwrap();
    assert_eq!(sent.lines().count(), 1);
    assert!(sent.contains("Keep going"));
    assert_eq!(ws.store.detail("a").unwrap().agent.status, "working");
}

/// No store job ever waits for another job to finish (the writer, Store's
/// maps and moved ownership guards are only held by running jobs), so even a
/// blocking pool of one thread serves two streaming Agents, the GUI and a
/// collaboration call at once without deadlocking.
#[test]
fn one_blocking_thread_is_enough_for_everything_at_once() {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(1)
        .enable_all().build().unwrap();
    runtime.block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(&dir);
        ws.store.insert(&agent("a", "thread-a")).unwrap();
        ws.store.insert(&agent("b", "thread-b")).unwrap();
        let (rpc_a, rpc_b) = (connect(&ws, "a", 1).await, connect(&ws, "b", 2).await);
        let app = crate::server::router_on_port(ws.clone(), dir.path().to_owned(), 4440);
        let mut tasks = Vec::new();
        for (id, generation) in [("a", 1), ("b", 2)] {
            let ws = ws.clone();
            tasks.push(tokio::spawn(async move {
                let thread = format!("thread-{id}");
                for n in 0..30 {
                    ws.dispatch_event(id, generation, delta(&thread, &format!("turn-{id}"), &format!("{n} "))).await;
                }
                ws.dispatch_event(id, generation, json!({"method":"turn/completed","params":{"threadId":thread,
                    "turn":{"id":format!("turn-{id}"),"status":"completed","items":[]}}})).await;
            }));
        }
        for path in ["/api/workspace", "/api/agents/a", "/api/catchup"] {
            let app = app.clone();
            tasks.push(tokio::spawn(async move {
                for _ in 0..10 {
                    let request = axum::http::Request::get(path).header("host", "127.0.0.1:4440")
                        .body(axum::body::Body::empty()).unwrap();
                    assert!(tower::ServiceExt::oneshot(app.clone(), request).await.unwrap().status().is_success());
                }
            }));
        }
        let mail = ws.clone();
        tasks.push(tokio::spawn(async move {
            mail.collaboration_call(None, "peer_send", json!({"requestId":"m","toAgentId":"b","body":"hello"})).await.unwrap();
            mail.collaboration_call(Some("a"), "task_list", json!({})).await.unwrap();
        }));
        tokio::time::timeout(PATIENCE, async {
            for task in tasks { task.await.unwrap(); }
        }).await.expect("a store job waited for another one");
        for id in ["a", "b"] {
            assert_eq!(ws.store.detail(id).unwrap().turns[0]["status"], "completed");
        }
        rpc_a.close();
        rpc_b.close();
    });
}
