//! YN-211: what every runtime's reconnect keeps, whichever way it answers
//! (the whole record as the client window shows it, or the Agent as listed).
//! `check` runs on one runtime's stand-in. Each runtime's own tests call it:
//! Codex below, Claude in claude_mcp.rs, OpenCode in opencode_agent_tests.rs
//! and dsh in dsh_agent_tests.rs. All four are held to this one contract,
//! with what differs between them named in `Runtime`. A child of `workspace`,
//! so it can read the runtime a reconnect left live.
//!
//! The SSH cases stay where they are tested with their helper stand-ins
//! (disconnect.rs: Claude and Codex), and so does a Codex app-server that
//! exits while its disconnect is still queued (reconnect_exit_tests.rs).
//! OpenCode and dsh run on Core's own host only.
use super::*;
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::pin::Pin;

/// One step a runtime's test supplies.
pub(crate) type Step<'a, T> = Box<dyn Fn(T) -> Pin<Box<dyn Future<Output = ()> + 'a>> + 'a>;

/// What `check` needs to know of one runtime.
pub(crate) struct Runtime<'a> {
    /// Whether the user's Disconnect stops it (OpenCode's is refused, as
    /// `disconnect_agent` has it).
    pub(crate) disconnects: bool,
    /// Ends its live runtime the way it ends by itself (its stand-in exits),
    /// returning once the Agent reads disconnected.
    pub(crate) end: Step<'a, ()>,
    /// Hands Core, through that runtime's own event entry, an event as the
    /// runtime of this generation sent it: one that changes the record when
    /// that runtime is the live one.
    pub(crate) event: Step<'a, u64>,
    /// Whether that event's change is on the record.
    pub(crate) applied: Box<dyn Fn() -> bool + 'a>,
}

/// The Agent fields both answers must agree on with the Agent as listed.
const SAME: [&str; 9] = ["id", "harness", "closedAt", "disconnectedAt", "connectionState",
    "threadId", "claudeSessionId", "opencodeSessionId", "projectId"];

fn same(answered: &crate::model::Agent, listed: &crate::model::Agent, what: &str) {
    let (answered, listed) = (serde_json::to_value(answered).unwrap(), serde_json::to_value(listed).unwrap());
    for key in SAME {
        assert_eq!(answered[key], listed[key], "{what}: {key}");
    }
}

/// The journal kinds of `id`, oldest first.
pub(crate) fn kinds(ws: &Workspace, id: &str) -> Vec<String> {
    let db = rusqlite::Connection::open(ws.data_dir.join("workspace.sqlite")).unwrap();
    let mut query = db.prepare("SELECT kind FROM journal WHERE agent_id=?1 ORDER BY seq").unwrap();
    query.query_map([id], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

/// The Agent as listed once `done` holds of it, within 20 s.
pub(crate) async fn until(ws: &Arc<Workspace>, id: &str, what: &str, done: impl Fn(&crate::model::Agent) -> bool) -> crate::model::Agent {
    for _ in 0..1000 {
        let agent = ws.listed(id).await.unwrap();
        if done(&agent) {
            return agent;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("{what} within 20 s: {:?}", serde_json::to_value(ws.listed(id).await.unwrap()).unwrap());
}

/// The contract, on Agent `id` of `ws`, open and not yet connected or
/// connected and idle. It ends with the Agent closed.
pub(crate) async fn check(ws: &Arc<Workspace>, id: &str, runtime: Runtime<'_>) {
    let generation = || ws.collaboration_generation(id);
    let starts = || kinds(ws, id).iter().filter(|k| k.ends_with("/connecting")).count();
    let connected = |what: &'static str| until(ws, id, what, |a| a.connection_state == "connected");

    // Both answers, on a healthy connection: the same Agent, the record
    // bounded to the client window, and no whole history read for either.
    ws.reconnect_summary(id).await.unwrap();
    connected("the first reconnect").await;
    let live = generation().expect("a live runtime");
    let (started, reads) = (starts(), crate::store::detail_reads_of(id));
    let listed = ws.reconnect_summary(id).await.unwrap();
    same(&listed, &ws.listed(id).await.unwrap(), "the summary");
    let record = ws.reconnect(id).await.unwrap();
    same(&record.agent, &ws.listed(id).await.unwrap(), "the record");
    // Again, and two at once: they wait for each other on the gate.
    let (summary, record) = tokio::join!(ws.reconnect_summary(id), ws.reconnect(id));
    summary.unwrap();
    record.unwrap();
    assert_eq!(generation(), Some(live), "reconnecting a ready connection keeps its runtime");
    assert_eq!(starts(), started, "and starts none");
    assert_eq!(crate::store::detail_reads_of(id), reads, "no answer read a whole record");

    // The user's Disconnect: the automatic path is refused either way and
    // starts nothing; their Reconnect starts it again.
    let mut previous = live;
    if runtime.disconnects {
        ws.disconnect_agent(id).await.unwrap();
        assert_eq!(generation(), None);
        let permit = ws.admission.enter_work().unwrap();
        let refused = ws.reconnect_settled(id, &permit).await.unwrap_err();
        assert!(refused.to_string().contains("Reconnect"), "{refused}");
        let refused = ws.reconnect_accepted(id, &permit).await.unwrap_err();
        assert!(refused.to_string().contains("Reconnect"), "{refused}");
        drop(permit);
        assert_eq!(generation(), None, "nothing started it");
        assert!(ws.listed(id).await.unwrap().disconnected_at.is_some(), "still disconnected");
        let back = ws.reconnect_summary(id).await.unwrap();
        assert!(back.disconnected_at.is_none());
        connected("the user's reconnect").await;
        previous = generation().expect("started again");
        assert_ne!(previous, live);
    } else {
        let refused = ws.disconnect_agent(id).await.unwrap_err();
        assert!(refused.to_string().contains("Nothing changed"), "{refused}");
        assert_eq!(generation(), Some(live));
    }

    // Its runtime ends by itself: one reconnect attaches a new one, and the
    // next keeps it.
    (runtime.end)(()).await;
    assert_eq!(ws.listed(id).await.unwrap().connection_state, "disconnected");
    let record = ws.reconnect(id).await.unwrap();
    assert_ne!(record.agent.connection_state, "disconnected");
    connected("the reconnect after its end").await;
    let current = generation().expect("a new runtime");
    assert!(current != previous && current != live, "{current} after {previous}");
    ws.reconnect_summary(id).await.unwrap();
    assert_eq!(generation(), Some(current));

    // An event of an earlier runtime arriving late changes nothing; the
    // same event from the live one is applied, so the check is not vacuous.
    for old in [live, previous] {
        (runtime.event)(old).await;
        assert!(!(runtime.applied)(), "an event of runtime {old} after {current} took over");
    }
    (runtime.event)(current).await;
    assert!((runtime.applied)(), "the live runtime's event is applied");

    // Closed: refused by each, nothing started and nothing recorded.
    ws.close_agent(id).await.unwrap();
    assert_eq!(generation(), None);
    let before = ws.listed(id).await.unwrap();
    let permit = ws.admission.enter_work().unwrap();
    let refusals = [
        ws.reconnect(id).await.map(drop),
        ws.reconnect_summary(id).await.map(drop),
        ws.reconnect_settled(id, &permit).await,
    ];
    drop(permit);
    for refused in refusals {
        let refused = refused.unwrap_err();
        assert!(refused.to_string().contains("已关闭"), "{refused}");
    }
    assert_eq!(generation(), None, "a closed Agent starts no runtime");
    let after = ws.listed(id).await.unwrap();
    assert_eq!((&after.status, &after.error, after.last_seq, &after.connection_state),
        (&before.status, &before.error, before.last_seq, &before.connection_state), "nothing recorded");

    // Reopened: a new runtime, under the same contract.
    let reopened = ws.reopen_agent_summary(id).await.unwrap();
    assert!(reopened.closed_at.is_none());
    connected("the reopen").await;
    assert!(generation().is_some_and(|g| g != current), "a new runtime");
    ws.close_agent(id).await.unwrap();
}

/// A Codex app-server that resumes and reads its one thread as idle, has no
/// background terminals, and exits when told `test/exit`.
const NATIVE: &str = r#"#!/usr/bin/python3
import json, sys
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method, params = request.get('method'), request.get('params') or {}
    if method == 'test/exit': sys.exit(0)
    if 'id' not in request or 'method' not in request: continue
    result = {}
    if method in ('thread/resume', 'thread/read'):
        result = {'thread':{'id':params['threadId'],'status':{'type':'idle'},'turns':[]},'model':'test-model'}
    elif method in ('thread/turns/list', 'thread/backgroundTerminals/list'): result = {'data':[],'nextCursor':None}
    elif method == 'config/read': result = {'config':{'model_context_window':None,'model_auto_compact_token_limit':None}}
    emit({'id':request['id'],'result':result})
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_codex_reconnect_keeps_the_contract() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("native.py");
    std::fs::write(&script, NATIVE).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let cwd = root.path().to_string_lossy().into_owned();
    let ws = Workspace::new(root.path().join("data"), cwd.clone(), script.to_string_lossy().into()).unwrap();
    ws.store.insert(&serde_json::from_value(json!({"agent":{"id":"a","name":"A","goal":"test","cwd":cwd,
        "model":"test-model","color":"sage","threadId":"thread","status":"idle","createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    let approval = |generation: u64| json!({"id": 900 + generation, "method": "item/commandExecution/requestApproval",
        "params": {"threadId": "thread", "turnId": "turn-late", "itemId": "command-late", "command": "true"}});
    let w = &ws;
    let runtime = Runtime {
        disconnects: true,
        end: Box::new(move |()| Box::pin(async move {
            let live = w.rpcs.lock().unwrap().get("a").cloned().unwrap();
            live.rpc.send(json!({"method": "test/exit"})).await.unwrap();
            until(w, "a", "the app-server's end", |a| a.connection_state == "disconnected").await;
        })),
        event: Box::new(move |generation| Box::pin(w.dispatch_event("a", generation, approval(generation)))),
        applied: Box::new(move || w.store.detail("a").unwrap().pending.iter().any(|p| !p.stale)),
    };
    check(&ws, "a", runtime).await;
}
