//! T-29: `/review` for a Codex Agent with a fake app-server that records
//! every request: Codex's own review is asked for only between turns, on the
//! connection already serving the thread, inline as a Turn of that thread,
//! and is never sent as a prompt. No account, model or real review is used.
use super::*;
use crate::model::ReviewTarget;

fn agent(id: &str, harness: &str, status: &str, turn: &str) -> AgentDetail {
    let mut d: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"m","color":"sage","harness":harness,
        "threadId":format!("thread-{id}"),"status":status,"createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[{"id":format!("turn-{id}"),"status":turn,"items":[]}],
        "pending":[],"artifacts":[]})).unwrap();
    d.agent.connection_state = "connected".into();
    d
}

/// A fake app-server writing each request's method and params to `log`. To
/// `review/start` it answers as Codex 0.162.1 does, the review's Turn with
/// the review's own user message, except when `mode` says: `missing`
/// (method not found), `busy` (another error), `noturn` (an answer without
/// the Turn), either after a pause when prefixed `slow-`, or `drop` (it exits
/// without answering, so the outcome is unknown).
async fn fake(log: &std::path::Path, mode: &str) -> Arc<Rpc> {
    let code = r#"import json,sys,time
for line in sys.stdin:
 r=json.loads(line)
 if 'method' not in r: continue
 with open(sys.argv[1],'a') as f:f.write(json.dumps({'method':r['method'],'params':r.get('params')})+'\n')
 mode=sys.argv[2]; review=r['method']=='review/start'
 if review and mode=='drop': sys.exit(0)
 if review and mode.startswith('slow-'):
  time.sleep(0.4); mode=mode[5:]
 if review and mode=='missing':
  print(json.dumps({'id':r['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True)
 elif review and mode=='busy':
  print(json.dumps({'id':r['id'],'error':{'code':-32603,'message':'failed to start review'}}),flush=True)
 elif review and mode=='accept':
  turn={'id':'review','status':'inProgress','items':[{'type':'userMessage','id':'review','content':[{'type':'text','text':'Review the current code changes'}]}],'error':None}
  print(json.dumps({'id':r['id'],'result':{'turn':turn,'reviewThreadId':r['params']['threadId']}}),flush=True)
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

fn lab() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    (dir, ws)
}

fn changes() -> ReviewTarget { ReviewTarget::UncommittedChanges {} }

#[tokio::test]
async fn an_idle_connected_codex_agent_asks_codex_for_its_own_review_as_a_turn_of_this_thread() {
    let (dir, ws) = lab();
    let log = dir.path().join("requests");
    connected(&ws, agent("a", "codex", "idle", "completed"), &log, "accept").await;
    assert_eq!(ws.codex_review("a", changes()).await.unwrap(), json!({"accepted":true,"threadId":"thread-a","turnId":"review"}));
    assert_eq!(requests(&log), [json!({"method":"review/start","params":{"threadId":"thread-a","target":{"type":"uncommittedChanges"},"delivery":"inline"}})],
        "one native request, inline on this thread; nothing sent as a prompt");
    // Codex's answer is the review's Turn: recorded as started, with what Codex shows for it.
    let d = ws.detail("a").await.unwrap();
    let turn = d.turns.iter().find(|t| t["id"] == "review").expect("the review's Turn");
    assert_eq!((turn["status"].as_str(), turn["items"][0]["content"][0]["text"].as_str()), (Some("inProgress"), Some("Review the current code changes")));
    assert_eq!(status(&ws, "a"), "working");
    assert!(ws.codex_review("a", changes()).await.unwrap_err().to_string().contains("当前 Turn 尚未结束"));
    assert!(ws.codex_compact("a").await.unwrap_err().to_string().contains("当前 Turn 尚未结束"));
    assert_eq!(requests(&log).len(), 1, "nothing else while it runs");
    // Its own events carry it on: the result is Codex's exitedReviewMode item.
    let exited = json!({"type":"exitedReviewMode","id":"exit","review":"Looks fine.\n\n- Name the error — a.rs:1"});
    ws.store.record_applied("a", "item/completed", "item/completed", &json!({"threadId":"thread-a","turnId":"review","item":exited})).unwrap();
    ws.store.record_applied("a", "turn/completed", "turn/completed", &json!({"threadId":"thread-a","turn":{"id":"review","status":"completed","items":[]}})).unwrap();
    assert_eq!(status(&ws, "a"), "idle");
    let d = ws.detail("a").await.unwrap();
    let items = &d.turns.iter().find(|t| t["id"] == "review").unwrap()["items"];
    assert_eq!(items.as_array().unwrap().iter().map(|i| i["type"].as_str().unwrap()).collect::<Vec<_>>(), ["userMessage", "exitedReviewMode"]);
    ws.codex_review("a", changes()).await.unwrap();
    assert_eq!(requests(&log).len(), 2, "after it ended, a new /review may run");
}

#[tokio::test]
async fn each_target_goes_to_codex_in_its_own_shape_and_a_malformed_one_asks_nothing() {
    let (dir, ws) = lab();
    let sent = [
        (ReviewTarget::BaseBranch { branch: " main ".into() }, json!({"type":"baseBranch","branch":"main"})),
        (ReviewTarget::Commit { sha: "abc1234".into(), title: None }, json!({"type":"commit","sha":"abc1234","title":null})),
        (ReviewTarget::Commit { sha: "abc1234".into(), title: Some(" Fix it ".into()) }, json!({"type":"commit","sha":"abc1234","title":"Fix it"})),
        (ReviewTarget::Custom { instructions: "  Check the error paths\n".into() }, json!({"type":"custom","instructions":"Check the error paths"})),
    ];
    for (index, (target, expected)) in sent.into_iter().enumerate() {
        let (id, log) = (format!("t{index}"), dir.path().join(format!("t{index}")));
        connected(&ws, agent(&id, "codex", "idle", "completed"), &log, "accept").await;
        ws.codex_review(&id, target).await.unwrap();
        assert_eq!(requests(&log)[0]["params"]["target"], expected);
    }
    let log = dir.path().join("bad");
    connected(&ws, agent("bad", "codex", "idle", "completed"), &log, "accept").await;
    for target in [ReviewTarget::BaseBranch { branch: " ".into() }, ReviewTarget::BaseBranch { branch: "main; rm".into() },
                   ReviewTarget::Commit { sha: "".into(), title: Some("t".into()) }, ReviewTarget::Custom { instructions: "\n ".into() },
                   ReviewTarget::Custom { instructions: "x".repeat(100_001) }] {
        assert!(ws.codex_review("bad", target.clone()).await.unwrap_err().to_string().contains("没有执行 /review"), "{target:?}");
    }
    assert!(requests(&log).is_empty(), "no request reached Codex");
    assert_eq!(status(&ws, "bad"), "idle", "and nothing was recorded as asked");
    // Only Codex's own target shapes are read; nothing else rides along.
    for wrong in [json!({"type":"commit","sha":"a","title":null,"extra":1}), json!({"type":"detached"}), json!({"type":"baseBranch"}),
                  json!({"type":"uncommittedChanges","delivery":"detached"})] {
        assert!(serde_json::from_value::<ReviewTarget>(wrong.clone()).is_err(), "{wrong}");
    }
    assert_eq!(serde_json::from_value::<ReviewTarget>(json!({"type":"commit","sha":"a"})).unwrap(), ReviewTarget::Commit { sha: "a".into(), title: None });
}

async fn refused(ws: &Arc<Workspace>, id: &str, log: &std::path::Path, says: &str) {
    let error = ws.codex_review(id, changes()).await.unwrap_err().to_string();
    assert!(error.contains(says) && error.contains("/review"), "{id}: {error}");
    assert!(requests(log).is_empty(), "{id}: no request reached Codex");
}

#[tokio::test]
async fn review_is_refused_without_any_request_when_the_agent_is_not_between_turns_or_not_connected() {
    let (dir, ws) = lab();
    let log = dir.path().join("busy");
    connected(&ws, agent("busy", "codex", "working", "inProgress"), &log, "accept").await;
    refused(&ws, "busy", &log, "当前 Turn 尚未结束").await;
    let log = dir.path().join("uncertain");
    connected(&ws, agent("uncertain", "codex", "uncertain", "completed"), &log, "accept").await;
    refused(&ws, "uncertain", &log, "结果尚未确认").await;
    let log = dir.path().join("closing");
    connected(&ws, agent("closing", "codex", "idle", "completed"), &log, "accept").await;
    ws.rpcs.lock().unwrap().get_mut("closing").unwrap().closing = true;
    refused(&ws, "closing", &log, "没有连接到这个原生会话").await;
    ws.store.insert(&agent("offline", "codex", "offline", "completed")).unwrap();
    assert!(ws.codex_review("offline", changes()).await.unwrap_err().to_string().contains("没有连接到这个原生会话"));
    assert!(ws.rpcs.lock().unwrap().get("offline").is_none(), "no connection was opened for it");
    // Claude runs its own /review as a native command sent as a message.
    ws.store.insert(&agent("claude", "claude", "idle", "completed")).unwrap();
    assert!(ws.codex_review("claude", changes()).await.unwrap_err().to_string().contains("Claude 的 /review 是原生命令"));
}

#[tokio::test]
async fn only_a_codex_without_the_method_provably_ran_nothing() {
    let (dir, ws) = lab();
    let log = dir.path().join("missing");
    connected(&ws, agent("old", "codex", "idle", "completed"), &log, "missing").await;
    let error = ws.codex_review("old", changes()).await.unwrap_err().to_string();
    assert!(error.contains("不提供原生审查（review/start）"), "{error}");
    assert_eq!(status(&ws, "old"), "idle", "nothing ran, so the Agent is as it was");
    let sent: Vec<_> = requests(&log).into_iter().map(|r| r["method"].clone()).collect();
    assert_eq!(sent, [json!("review/start")], "no fallback to a prompt or another request");
    // Any other error, or an answer without the review's Turn, says nothing
    // about whether it began: uncertain, and nothing slips in after it.
    for mode in ["busy", "noturn"] {
        let log = dir.path().join(mode);
        connected(&ws, agent(mode, "codex", "idle", "completed"), &log, mode).await;
        let error = ws.codex_review(mode, changes()).await.unwrap_err().to_string();
        assert!(error.contains("不要重复执行") && !error.contains("不提供"), "{mode}: {error}");
        assert_eq!(status(&ws, mode), "uncertain", "{mode}");
        assert!(ws.codex_review(mode, changes()).await.unwrap_err().to_string().contains("尚未确认"));
        assert!(ws.send(mode, "hello".into()).await.is_err(), "{mode}: no message either");
        let sent: Vec<_> = requests(&log).into_iter().map(|r| r["method"].clone()).collect();
        assert_eq!(sent.iter().filter(|m| *m == "review/start").count(), 1, "{mode}: no second review");
        assert!(!sent.contains(&json!("turn/start")), "{mode}: no prompt: {sent:?}");
    }
}

#[tokio::test]
async fn a_lost_answer_leaves_review_unknown_and_nothing_is_sent_again() {
    let (dir, ws) = lab();
    let log = dir.path().join("requests");
    connected(&ws, agent("lost", "codex", "idle", "completed"), &log, "drop").await;
    let error = ws.codex_review("lost", changes()).await.unwrap_err().to_string();
    assert!(error.contains("结果无法确认") && error.contains("不要重复执行"), "{error}");
    assert_eq!(status(&ws, "lost"), "uncertain", "it may have run: check, never resend");
    assert!(ws.codex_review("lost", changes()).await.unwrap_err().to_string().contains("尚未确认"));
    assert_eq!(requests(&log).len(), 1);
}

#[tokio::test]
async fn an_answer_after_codex_has_already_ended_the_review_never_starts_it_again() {
    let (dir, ws) = lab();
    let log = dir.path().join("late");
    connected(&ws, agent("late", "codex", "idle", "completed"), &log, "slow-accept").await;
    let pending = {
        let ws = ws.clone();
        tokio::spawn(async move { ws.codex_review("late", ReviewTarget::UncommittedChanges {}).await })
    };
    for _ in 0..200 {
        if status(&ws, "late") == "uncertain" { break; }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(status(&ws, "late"), "uncertain", "requested");
    // Codex's own events for the review's Turn arrive before its answer.
    ws.store.record_applied("late", "turn/started", "turn/started", &json!({"threadId":"thread-late","turn":{"id":"review","status":"inProgress","items":[]}})).unwrap();
    ws.store.record_applied("late", "turn/completed", "turn/completed", &json!({"threadId":"thread-late","turn":{"id":"review","status":"completed","items":[]}})).unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["turnId"], "review");
    let d = ws.detail("late").await.unwrap();
    assert_eq!(d.turns.iter().filter(|t| t["id"] == "review").map(|t| t["status"].as_str().unwrap()).collect::<Vec<_>>(), ["completed"]);
    assert_eq!(status(&ws, "late"), "idle", "the ended Turn is not started again");
}

#[test]
fn a_long_review_result_is_sent_whole_as_conversation_text_is() {
    let review = format!("Overall fine.\n\n{}", "- A finding — a.rs:1\n".repeat(2_000));
    let exited = json!({"type":"exitedReviewMode","id":"exit","review":review});
    let shown = crate::client_view::item(&exited, &[]);
    assert_eq!(shown["review"].as_str(), Some(review.as_str()), "not trimmed to a preview");
    assert!(shown.get(crate::client_view::TRUNCATED).is_none());
    // Past the window's own bound, its preview reads the review's start.
    let huge = json!({"type":"exitedReviewMode","id":"exit","review":"Overall fine.\n".repeat(4_000)});
    let preview = crate::conversation_window::bounded_item(&huge);
    assert_eq!(preview["type"], "historyPreview");
    assert!(preview["text"].as_str().unwrap().starts_with("Overall fine.\nOverall fine."));
}
