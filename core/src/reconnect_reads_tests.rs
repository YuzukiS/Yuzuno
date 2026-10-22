//! T-140: a Codex reconnect, its failures and what connecting writes read and
//! write the Agent's fields without reading the record whole, and record what
//! they recorded before. A child of `workspace`, so it can set the reconnect
//! timeout.
use super::*;
use std::os::unix::fs::PermissionsExt;

/// A Codex app-server that resumes and reads each thread as named, refuses
/// the thread `refused` and never answers for the thread `silent`.
const NATIVE: &str = r#"#!/usr/bin/python3
import json, sys
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request: continue
    method, params = request.get('method'), request.get('params') or {}
    result = {}
    if method in ('thread/resume', 'thread/read'):
        if params.get('threadId') == 'silent': continue
        if params.get('threadId') == 'refused':
            emit({'id':request['id'],'error':{'code':-32600,'message':'thread refused by fixture'}})
            continue
        result = {'thread':{'id':params['threadId'],'status':{'type':'idle'},'turns':[]},'model':'test-model'}
    elif method == 'config/read': result = {'config':{'model_context_window':None,'model_auto_compact_token_limit':None}}
    emit({'id':request['id'],'result':result})
"#;

fn record(id: &str, thread: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":id,"goal":"test","cwd":"/tmp","model":"test-model",
        "color":"sage","threadId":thread,"status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
        "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

fn kinds(ws: &Workspace, id: &str) -> Vec<String> {
    let db = rusqlite::Connection::open(ws.data_dir.join("workspace.sqlite")).unwrap();
    let mut query = db.prepare("SELECT kind FROM journal WHERE agent_id=?1 ORDER BY seq").unwrap();
    query.query_map([id], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
}

#[tokio::test]
async fn a_codex_reconnect_and_its_failures_read_no_whole_record() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("native.py");
    std::fs::write(&script, NATIVE).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(root.path().join("data"), "/tmp".into(), script.to_string_lossy().into()).unwrap();
    ws.reconnect_timeout_ms.store(300, Ordering::Relaxed);
    for (id, thread) in [("reads-ok", "thread"), ("reads-refused", "refused"), ("reads-silent", "silent"), ("reads-closed", "thread")] {
        ws.store.insert(&record(id, thread)).unwrap();
    }
    ws.close_agent("reads-closed").await.unwrap();
    let closed_reads = crate::store::detail_reads_of("reads-closed");

    // A new app-server: connecting, attaching and reconciling.
    let connected = ws.reconnect_summary("reads-ok").await.unwrap();
    assert_eq!(connected.connection_state, "connected");
    let written = kinds(&ws, "reads-ok");
    assert_eq!(written.first().map(String::as_str), Some("runtime/connecting"), "{written:?}");
    assert!(written.iter().any(|k| k == "thread/reconciled"), "{written:?}");

    // Refused: the error is recorded once, as before, and the transport dropped.
    let refused = ws.reconnect_summary("reads-refused").await.unwrap_err();
    let agent = ws.store.agent("reads-refused").unwrap();
    assert_eq!((agent.status.as_str(), agent.error.as_deref(), agent.connection_state.as_str()),
        ("error", Some(refused.to_string().as_str()), "disconnected"));
    let errors = |id: &str| kinds(&ws, id).iter().filter(|k| *k == "runtime/error").count();
    assert_eq!(errors("reads-refused"), 1);
    ws.reconnect_summary("reads-refused").await.unwrap_err();
    assert_eq!(errors("reads-refused"), 1, "the same error again is not recorded again");

    // Unanswered: the outcome is unknown, and the Agent says so.
    let unknown = ws.reconnect_summary("reads-silent").await.unwrap_err();
    assert!(unknown.is::<OutcomeUnknown>(), "{unknown:#}");
    let agent = ws.store.agent("reads-silent").unwrap();
    assert_eq!((agent.status.as_str(), agent.error.as_deref()), ("uncertain", Some(unknown.to_string().as_str())));

    // Closed: refused, and nothing is recorded as its failure.
    let before = ws.store.agent("reads-closed").unwrap();
    let refused = ws.reconnect_summary("reads-closed").await.unwrap_err();
    assert!(refused.to_string().contains("已关闭"), "{refused}");
    let after = ws.store.agent("reads-closed").unwrap();
    assert_eq!((after.status, after.error, after.last_seq), (before.status, before.error, before.last_seq));
    assert_eq!(errors("reads-closed"), 0);

    let reads = ["reads-ok", "reads-refused", "reads-silent"].map(|id| (id, crate::store::detail_reads_of(id)));
    assert_eq!(reads, [("reads-ok", 0), ("reads-refused", 0), ("reads-silent", 0)], "whole records read");
    assert_eq!(crate::store::detail_reads_of("reads-closed") - closed_reads, 0, "reads-closed: a whole record was read");
}

/// Where a remote Agent's runtime is (`runtime/located`, written as `connect`
/// writes it) is an Agent field: the metadata write keeps it, on a record held
/// and on one that is not, and a Store opened again reads it.
#[test]
fn a_located_runtime_is_kept_by_the_metadata_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let mut detail = record("located", "thread");
    detail.agent.remote = Some(serde_json::from_value(json!({"machine":{"id":"fixture","name":"fixture",
        "target":"unused.invalid","codex":"codex","defaultCwd":"/tmp"},"runtime":null})).unwrap());
    let instance = |agent: Agent| agent.remote.unwrap().runtime.unwrap().instance_id;
    {
        let store = Store::open(&path).unwrap();
        store.insert(&detail).unwrap();
        for (n, held) in [(1, false), (2, true)] {
            if held {
                store.update("located", "test/held", &json!({}), |_| {}).unwrap();
            } else {
                store.release_for_test("located");
            }
            let located: crate::remote::RuntimeRef = serde_json::from_value(json!({"root":"/srv/runtime","socket":"/srv/runtime/s",
                "pid":n,"codex":"codex","instanceId":format!("instance-{n}")})).unwrap();
            store.update_meta("located", "runtime/located", &json!({"instanceId":located.instance_id}), move |m| {
                if let Some(r) = &mut m.agent.remote { r.runtime = Some(located); }
            }).unwrap();
            assert_eq!(instance(store.agent("located").unwrap()), format!("instance-{n}"));
        }
    }
    let reopened = Store::open(&path).unwrap();
    assert_eq!(instance(reopened.agent("located").unwrap()), "instance-2");
    assert_eq!(instance(reopened.detail("located").unwrap().agent), "instance-2");
}
