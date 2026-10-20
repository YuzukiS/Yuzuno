//! `/compact` for a Codex Agent with a fake app-server that records every
//! request: Codex's own compaction is asked for only between turns, on the
//! connection already serving the thread, and is never sent as a prompt.
use super::*;

fn agent(id: &str, harness: &str, status: &str, turn: &str) -> AgentDetail {
    let mut d: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"m","color":"sage","harness":harness,
        "threadId":format!("thread-{id}"),"status":status,"createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[{"id":format!("turn-{id}"),"status":turn,"items":[]}],
        "pending":[],"artifacts":[]})).unwrap();
    d.agent.connection_state = "connected".into();
    d
}

/// A fake app-server writing each request's method and params to `log`. It
/// answers `{}`, except to `thread/compact/start` when `mode` says: `missing`
/// (method not found), `busy` (another refusal) or `drop` (it exits without
/// answering, so the outcome is unknown).
async fn fake(log: &std::path::Path, mode: &str) -> Arc<Rpc> {
    let code = r#"import json,sys
for line in sys.stdin:
 r=json.loads(line)
 if 'method' not in r: continue
 with open(sys.argv[1],'a') as f:f.write(json.dumps({'method':r['method'],'params':r.get('params')})+'\n')
 if r['method']=='thread/compact/start' and sys.argv[2]=='drop': sys.exit(0)
 if r['method']=='thread/compact/start' and sys.argv[2]=='missing':
  print(json.dumps({'id':r['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True)
 elif r['method']=='thread/compact/start' and sys.argv[2]=='busy':
  print(json.dumps({'id':r['id'],'error':{'code':-32000,'message':'thread is busy'}}),flush=True)
 else:
  print(json.dumps({'id':r['id'],'result':{}}),flush=True)
"#;
    let (tx, _rx) = mpsc::channel(8);
    Rpc::spawn("python3", &["-c".into(), code.into(), log.display().to_string(), mode.into()], tx).await.unwrap()
}

fn requests(log: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(log).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

async fn connected(ws: &Arc<Workspace>, d: AgentDetail, log: &std::path::Path, mode: &str) {
    let id = d.agent.id.clone();
    ws.store.insert(&d).unwrap();
    let rpc = fake(log, mode).await;
    ws.rpcs.lock().unwrap().insert(id, Connection { generation: 7, rpc, closing: false, events: None, attachment: Default::default() });
}

fn status(ws: &Arc<Workspace>, id: &str) -> String {
    ws.store.agents().unwrap().into_iter().find(|a| a.id == id).unwrap().status
}

#[tokio::test]
async fn an_idle_connected_codex_agent_asks_codex_itself_and_only_its_own_turn_settles_it() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let log = dir.path().join("requests");
    connected(&ws, agent("a", "codex", "idle", "completed"), &log, "accept").await;
    assert_eq!(ws.codex_compact("a").await.unwrap(), json!({"accepted":true,"threadId":"thread-a"}));
    assert_eq!(requests(&log), [json!({"method":"thread/compact/start","params":{"threadId":"thread-a"}})], "one native request; nothing sent as a prompt");
    // Accepted is not done: until Codex's own events say so, nothing else goes in.
    assert_eq!(status(&ws, "a"), "uncertain");
    assert!(ws.codex_compact("a").await.unwrap_err().to_string().contains("尚未确认"));
    assert_eq!(requests(&log).len(), 1, "no second compaction");
    // Codex runs its compaction as a turn of this thread.
    ws.store.record_applied("a", "turn/started", "turn/started", &json!({"threadId":"thread-a","turn":{"id":"compaction","status":"inProgress","items":[]}})).unwrap();
    assert_eq!(status(&ws, "a"), "working");
    assert!(ws.codex_compact("a").await.unwrap_err().to_string().contains("当前 Turn 尚未结束"));
    ws.store.record_applied("a", "turn/completed", "turn/completed", &json!({"threadId":"thread-a","turn":{"id":"compaction","status":"completed","items":[]}})).unwrap();
    assert_eq!(status(&ws, "a"), "idle");
    ws.codex_compact("a").await.unwrap();
    assert_eq!(requests(&log).len(), 2, "after it ended, a new /compact may run");
}

async fn refused(ws: &Arc<Workspace>, id: &str, log: &std::path::Path, says: &str) {
    let error = ws.codex_compact(id).await.unwrap_err().to_string();
    assert!(error.contains(says), "{id}: {error}");
    assert!(requests(log).is_empty(), "{id}: no request reached Codex");
}

#[tokio::test]
async fn compact_is_refused_without_any_request_when_the_agent_is_not_between_turns_or_not_connected() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    // A running turn.
    let log = dir.path().join("busy");
    connected(&ws, agent("busy", "codex", "working", "inProgress"), &log, "accept").await;
    refused(&ws, "busy", &log, "当前 Turn 尚未结束").await;
    // A pending approval.
    let log = dir.path().join("approval");
    let mut d = agent("approval", "codex", "idle", "completed");
    d.pending.push(PendingRequest { id: "p".into(), agent_id: "approval".into(), method: "item/commandExecution/requestApproval".into(),
        params: json!({"_runtimeGeneration":7}), created_at: now(), stale: false });
    connected(&ws, d, &log, "accept").await;
    refused(&ws, "approval", &log, "当前 Turn 尚未结束或正在等待回应").await;
    // An earlier send or execution whose result is unknown.
    let log = dir.path().join("uncertain");
    connected(&ws, agent("uncertain", "codex", "uncertain", "completed"), &log, "accept").await;
    refused(&ws, "uncertain", &log, "结果尚未确认").await;
    // No live connection: nothing is connected or resumed for it.
    ws.store.insert(&agent("offline", "codex", "offline", "completed")).unwrap();
    let error = ws.codex_compact("offline").await.unwrap_err().to_string();
    assert!(error.contains("没有连接到这个原生会话"), "{error}");
    assert!(ws.rpcs.lock().unwrap().get("offline").is_none(), "no connection was opened");
    // A connection that is closing.
    let log = dir.path().join("closing");
    connected(&ws, agent("closing", "codex", "idle", "completed"), &log, "accept").await;
    ws.rpcs.lock().unwrap().get_mut("closing").unwrap().closing = true;
    refused(&ws, "closing", &log, "没有连接到这个原生会话").await;
    // Claude runs its own /compact as a native command sent as a message.
    ws.store.insert(&agent("claude", "claude", "idle", "completed")).unwrap();
    assert!(ws.codex_compact("claude").await.unwrap_err().to_string().contains("Claude 的 /compact 是原生命令"));
}

#[tokio::test]
async fn a_refusal_ran_nothing_and_says_which_refusal_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    // A Codex without the method: not supported here.
    let log = dir.path().join("missing");
    connected(&ws, agent("old", "codex", "idle", "completed"), &log, "missing").await;
    let error = ws.codex_compact("old").await.unwrap_err().to_string();
    assert!(error.contains("不提供原生压缩（thread/compact/start）"), "{error}");
    assert_eq!(status(&ws, "old"), "idle", "nothing ran, so the Agent is as it was");
    let sent: Vec<_> = requests(&log).into_iter().map(|r| r["method"].clone()).collect();
    assert_eq!(sent, [json!("thread/compact/start")], "no fallback to a prompt or another request");
    // Any other refusal is reported as itself, not as unsupported.
    let log = dir.path().join("busy");
    connected(&ws, agent("refused", "codex", "idle", "completed"), &log, "busy").await;
    let error = ws.codex_compact("refused").await.unwrap_err().to_string();
    assert!(error.contains("Codex 拒绝了原生压缩：thread is busy") && !error.contains("不提供"), "{error}");
    assert_eq!(status(&ws, "refused"), "idle");
}

#[tokio::test]
async fn a_lost_answer_leaves_compact_unknown_and_nothing_is_sent_again() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let log = dir.path().join("requests");
    connected(&ws, agent("lost", "codex", "idle", "completed"), &log, "drop").await;
    let error = ws.codex_compact("lost").await.unwrap_err().to_string();
    assert!(error.contains("结果无法确认") && error.contains("不要重复执行"), "{error}");
    assert_eq!(status(&ws, "lost"), "uncertain", "it may have run: check, never resend");
    assert!(ws.codex_compact("lost").await.unwrap_err().to_string().contains("尚未确认"));
    assert_eq!(requests(&log).len(), 1);
}
