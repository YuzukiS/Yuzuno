//! Real HTTP admission with deterministic native protocol peers. No account or
//! external runtime is used; logs contain method names, never MCP parameters.
use super::*;
use std::{os::unix::fs::PermissionsExt, time::Duration};

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    base: String,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Lab {
    fn drop(&mut self) {
        self.server.abort();
        for c in self.ws.rpcs.lock().unwrap().values() { c.rpc.close(); }
    }
}

impl Lab {
    async fn new(active: bool, question: bool, delayed: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json,sys,pathlib,time
root=pathlib.Path(__file__).parent
state=root/'thread.json'
for line in sys.stdin:
 r=json.loads(line); m=r.get('method','response'); p=r.get('params',{})
 with (root/'methods').open('a') as f:f.write(m+'\n')
 if 'method' not in r or 'id' not in r:continue
 result={}
 if m in ['thread/start','thread/resume','thread/read']:
  if m!='thread/read' and (root/'delay').exists():
   (root/'waiting').touch()
   while (root/'delay').exists():time.sleep(.01)
  mode=(root/(m.split('/')[1]+'-mode'))
  mode=mode.read_text() if mode.exists() else ''
  if mode=='drop':continue
  if mode=='reject':
   print(json.dumps({'id':r['id'],'error':{'code':-32603,'message':'native store unavailable'}}),flush=True)
   continue
  result={'thread':json.loads(state.read_text()),'model':'m'}
  if mode=='wrong':result['thread']['id']='different-thread'
 elif m=='mcpServer/tool/call':result={'isError':True,'content':[{'text':'HTTP 401'}]}
 elif m=='thread/backgroundTerminals/list':result={'data':[{'id':'shell'}],'nextCursor':None}
 elif m in ['turn/start','turn/steer']:
  t=json.loads(state.read_text())
  if m=='turn/start':t['turns'].append({'id':'new-turn','status':'inProgress','items':[]})
  turn=t['turns'][-1]
  turn['items'].append({'id':'user','type':'userMessage','clientId':p.get('clientUserMessageId'),'content':p['input']})
  t['status']={'type':'active'}
  state.write_text(json.dumps(t))
  result={'turn':turn} if m=='turn/start' else {'turnId':turn['id']}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let items = if question { json!([{"id":"q","type":"agentMessage","delivery":"async","questions":[{"title":"Which?"}]}]) } else { json!([]) };
        let turns = json!([{"id":"old-turn","status":if active {"inProgress"} else {"completed"},"items":items}]);
        std::fs::write(dir.path().join("thread.json"), json!({"id":"thread-a","status":{"type":if active {"active"} else {"idle"}},"turns":turns}).to_string()).unwrap();
        if delayed { std::fs::write(dir.path().join("delay"), "").unwrap(); }
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.display().to_string()).unwrap();
        let d: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m","color":"sage",
            "threadId":"thread-a","status":if active {"working"} else {"offline"},"createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":turns,"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&d).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::server::router_on_port(ws.clone(), dir.path().join("web"), addr.port());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        Self { dir, ws, base:format!("http://{addr}/api"), server }
    }

    async fn post(&self, path: &str, body: &Value) -> (u16, Value) {
        let response = reqwest::Client::new().post(format!("{}{path}", self.base))
            .header("X-Yuzuno-Client", "desktop").json(body).send().await.unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }

    async fn unready(&self) {
        let c = self.ws.rpcs.lock().unwrap().get("a").unwrap().clone();
        self.ws.verify_remote_collaboration("a", "thread-a", c.generation, &c.rpc).await;
    }

    fn submissions(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("methods")).unwrap_or_default().lines()
            .filter(|m| matches!(*m, "turn/start" | "turn/steer")).count()
    }

    fn message_journal(&self) -> i64 {
        rusqlite::Connection::open(self.ws.data_dir.join("workspace.sqlite")).unwrap()
            .query_row("SELECT count(*) FROM journal WHERE kind IN ('message/requested','message/receipt','turn/requested')", [], |r| r.get(0)).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_timeout_keeps_one_attach_and_late_reply_recovers_same_process() {
    for active in [false, true] {
        let lab = Lab::new(active, false, true).await;
        lab.ws.reconnect_timeout_ms.store(100, Ordering::Relaxed);
        let before = lab.ws.detail("a").await.unwrap();
        let (status, error) = lab.post("/agents/a/reconnect", &json!({})).await;
        assert_eq!(status, 400);
        assert!(error["error"].as_str().unwrap().contains("超时"));
        let connection = lab.ws.rpcs.lock().unwrap()["a"].clone();
        let after = lab.ws.detail("a").await.unwrap();
        assert_eq!(after.agent.connection_state, "unconfirmed");
        assert_eq!(after.agent.status, "uncertain");
        assert_eq!(after.agent.thread_id, before.agent.thread_id);
        assert_eq!(after.turns, before.turns);
        assert_eq!(lab.message_journal(), 0);
        assert!(lab.ws.collaboration_status("a").await.is_none());

        // Repeated checks while no native reply exists remain unknown; none
        // resubmits thread/resume or replaces/kills the original transport.
        assert_eq!(lab.post("/agents/a/reconnect", &json!({})).await.0, 400);
        assert_eq!(lab.ws.rpcs.lock().unwrap()["a"].generation, connection.generation);
        assert!(Arc::ptr_eq(&lab.ws.rpcs.lock().unwrap()["a"].rpc, &connection.rpc));
        std::fs::remove_file(lab.dir.path().join("delay")).unwrap();
        lab.ws.reconnect_timeout_ms.store(2000, Ordering::Relaxed);
        assert_eq!(lab.post("/agents/a/reconnect", &json!({})).await.0, 200);
        let recovered = lab.ws.detail("a").await.unwrap();
        assert_eq!(recovered.agent.connection_state, "connected");
        assert_eq!(recovered.agent.status, if active { "working" } else { "idle" });
        assert!(recovered.agent.error.is_none());
        assert_eq!(recovered.agent.thread_id, before.agent.thread_id);
        assert_eq!(lab.ws.rpcs.lock().unwrap()["a"].generation, connection.generation);
        assert!(lab.ws.collaboration_status("a").await.unwrap().ready);
        let methods = std::fs::read_to_string(lab.dir.path().join("methods")).unwrap();
        assert_eq!(methods.lines().filter(|m| *m == "thread/resume").count(), 1);
        assert_eq!(methods.lines().filter(|m| *m == "initialize").count(), 1);
        assert_eq!(lab.submissions(), 0);
        assert_eq!(lab.message_journal(), 0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_retry_does_not_lose_live_approval_or_release_inflight_admission() {
    let lab = Lab::new(true, false, true).await;
    lab.ws.reconnect_timeout_ms.store(100, Ordering::Relaxed);
    assert_eq!(lab.post("/agents/a/reconnect", &json!({})).await.0, 400);
    let generation = lab.ws.rpcs.lock().unwrap()["a"].generation;
    lab.ws.store.update("a", "test/pending", &json!({}), |d| {
        d.pending.push(PendingRequest { id:"approval".into(), agent_id:"a".into(),
            method:"item/commandExecution/requestApproval".into(),
            params:json!({"_runtimeGeneration":generation,"_rpcId":100,"turnId":"old-turn"}),
            created_at:now(), stale:false });
    }).unwrap();
    lab.ws.reconnect_timeout_ms.store(2000, Ordering::Relaxed);
    let ws = lab.ws.clone();
    let retry = tokio::spawn(async move { ws.reconnect("a").await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while lab.ws.detail("a").await.unwrap().agent.connection_state != "connecting" {
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    let gate = lab.ws.gate("a").await;
    assert!(gate.try_lock().is_err(), "An actual recovery check still owns its lifecycle gate");
    assert!(!retry.is_finished());
    std::fs::remove_file(lab.dir.path().join("delay")).unwrap();
    retry.await.unwrap().unwrap();
    let after = lab.ws.detail("a").await.unwrap();
    assert_eq!(after.agent.status, "waiting");
    assert_eq!(after.pending.len(), 1);
    assert!(!after.pending[0].stale);
    assert_eq!(lab.ws.rpcs.lock().unwrap()["a"].generation, generation);
    assert_eq!(lab.post("/requests/approval/respond", &json!({"response":{"decision":"decline"}})).await.0, 200);
    assert_eq!(lab.submissions(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_read_timeout_error_and_wrong_identity_keep_a_retryable_same_session() {
    for mode in ["drop", "reject", "wrong"] {
        let lab = Lab::new(false, false, false).await;
        lab.ws.reconnect("a").await.unwrap();
        let generation = lab.ws.rpcs.lock().unwrap()["a"].generation;
        lab.ws.reconnect_timeout_ms.store(100, Ordering::Relaxed);
        std::fs::write(lab.dir.path().join("read-mode"), mode).unwrap();
        let (status, error) = lab.post("/agents/a/reconnect", &json!({})).await;
        assert_eq!(status, 400);
        let after = lab.ws.detail("a").await.unwrap();
        assert_eq!(after.agent.connection_state, "unconfirmed");
        assert_eq!(after.agent.thread_id.as_deref(), Some("thread-a"));
        assert!(error["error"].is_string());
        assert_eq!(after.agent.status, if mode == "drop" { "uncertain" } else { "error" });
        assert_eq!(lab.ws.rpcs.lock().unwrap()["a"].generation, generation);
        std::fs::remove_file(lab.dir.path().join("read-mode")).unwrap();
        lab.ws.reconnect_timeout_ms.store(2000, Ordering::Relaxed);
        assert_eq!(lab.post("/agents/a/reconnect", &json!({})).await.0, 200);
        let after = lab.ws.detail("a").await.unwrap();
        assert_eq!(after.agent.connection_state, "connected");
        assert_eq!(after.agent.status, "idle");
        assert!(after.agent.error.is_none());
        assert_eq!(lab.ws.rpcs.lock().unwrap()["a"].generation, generation);
        assert_eq!(lab.submissions(), 0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reconnect_late_native_rejection_and_wrong_session_never_become_success() {
    for mode in ["reject", "wrong"] {
        let lab = Lab::new(true, false, true).await;
        lab.ws.reconnect_timeout_ms.store(100, Ordering::Relaxed);
        assert_eq!(lab.post("/agents/a/reconnect", &json!({})).await.0, 400);
        std::fs::write(lab.dir.path().join("resume-mode"), mode).unwrap();
        std::fs::remove_file(lab.dir.path().join("delay")).unwrap();
        lab.ws.reconnect_timeout_ms.store(2000, Ordering::Relaxed);
        let (status, error) = lab.post("/agents/a/reconnect", &json!({})).await;
        assert_eq!(status, 400);
        assert!(error["error"].as_str().unwrap().contains(if mode == "reject" { "native store unavailable" } else { "不同会话" }));
        let after = lab.ws.detail("a").await.unwrap();
        assert_ne!(after.agent.connection_state, "connecting");
        assert_ne!(after.agent.connection_state, "connected");
        assert_eq!(after.agent.thread_id.as_deref(), Some("thread-a"));
        assert_eq!(after.turns[0]["status"], "inProgress");
        assert!(lab.ws.collaboration_status("a").await.is_none());
        assert_eq!(lab.submissions(), 0);
    }
}

fn input(kind: &str) -> Value {
    json!({"clientMessageId":kind,"text":"Keep my draft","expectedTurnId":if kind == "ordinary" {Value::Null} else {json!("old-turn")},
        "question":if kind == "answer" {json!({"turnId":"old-turn","itemId":"q"})} else {Value::Null}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pasted_boundaries_survive_codex_start_steer_and_reconcile_without_entering_native_input() {
    for active in [false, true] {
        let lab = Lab::new(active, false, false).await;
        lab.ws.reconnect("a").await.unwrap();
        let body = "👨‍👩‍👧‍👦e\u{301}中文\r\n".repeat(12);
        let text = format!("before {body} between {body} after\r\n");
        let len = body.encode_utf16().count();
        let blocks = json!([{"id":"one","start":7,"end":7+len}, {"id":"two","start":16+len,"end":16+len*2}]);
        let input = json!({"clientMessageId":"paste","text":text,"textBlocks":blocks,
            "expectedTurnId":if active {json!("old-turn")} else {Value::Null}});
        let (status, first) = lab.post("/agents/a/messages", &input).await;
        assert_eq!(status, 200); assert_eq!(first["status"], "accepted");
        lab.ws.reconcile("a").await.unwrap();
        let d = lab.ws.detail("a").await.unwrap();
        let user = d.turns.last().unwrap()["items"].as_array().unwrap().iter().find(|i| i["clientId"] == "paste").unwrap();
        assert_eq!(user[crate::message_content::BLOCKS], blocks);
        assert_eq!(crate::message_content::text(user), text);
        let native: Value = serde_json::from_slice(&std::fs::read(lab.dir.path().join("thread.json")).unwrap()).unwrap();
        let sent = &native["turns"].as_array().unwrap().last().unwrap()["items"][0];
        assert_eq!(sent["content"][0]["text"], text);
        assert!(sent.get(crate::message_content::BLOCKS).is_none());
        assert_eq!(lab.post("/agents/a/messages", &input).await.1["status"],"accepted");
        assert_eq!(lab.submissions(),1);
        let receipt = &d.message_receipts[0];
        assert!(receipt.binding.is_some());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_collaboration_admission_precedes_receipts_for_start_steer_and_answer() {
    for kind in ["ordinary", "steer", "answer"] {
        let lab = Lab::new(kind == "steer", kind == "answer", false).await;
        lab.ws.reconnect("a").await.unwrap();
        lab.unready().await;
        let before = lab.ws.detail("a").await.unwrap();
        let (status, error) = lab.post("/agents/a/messages", &input(kind)).await;
        assert_eq!(status, 400);
        assert_eq!(error["code"], "message_not_submitted");
        let after = lab.ws.detail("a").await.unwrap();
        assert!(after.message_receipts.is_empty());
        assert_eq!(after.turns, before.turns);
        assert_eq!(after.agent.last_seq, before.agent.last_seq);
        assert_eq!(lab.message_journal(), 0);
        assert_eq!(lab.submissions(), 0);
        let generation = lab.ws.rpcs.lock().unwrap()["a"].generation;
        lab.ws.collaboration_started("a", generation).await;
        let (status, receipt) = lab.post("/agents/a/messages", &input(kind)).await;
        assert_eq!(status, 200);
        assert_eq!(receipt["status"], "accepted");
        assert_eq!(lab.submissions(), 1);
        lab.unready().await;
        let (status, retry) = lab.post("/agents/a/messages", &input(kind)).await;
        assert_eq!(status, 200);
        assert_eq!(retry, receipt, "Existing client ID precedes readiness admission");
        assert_eq!(lab.submissions(), 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_offline_admission_waits_for_attach_without_reserving_an_unsent_message() {
    for fail in [false, true] {
        let lab = Lab::new(false, fail, true).await;
        let kind = if fail { "answer" } else { "ordinary" };
        let base = lab.base.clone();
        let sending = tokio::spawn(async move {
            reqwest::Client::new().post(format!("{base}/agents/a/messages"))
                .header("X-Yuzuno-Client", "desktop").json(&input(kind)).send().await.unwrap()
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !lab.dir.path().join("waiting").exists() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.unwrap();
        assert!(!sending.is_finished());
        assert!(lab.ws.collaboration_status("a").await.is_none());
        assert!(lab.ws.detail("a").await.unwrap().message_receipts.is_empty());
        assert_eq!(lab.message_journal(), 0, "A crash here cannot leave an uncertain input receipt");
        assert_eq!(lab.submissions(), 0);
        if fail {
            lab.ws.rpcs.lock().unwrap()["a"].rpc.close();
        } else {
            std::fs::remove_file(lab.dir.path().join("delay")).unwrap();
        }
        let response = tokio::time::timeout(Duration::from_secs(5), sending).await.unwrap().unwrap();
        if fail {
            assert_eq!(response.status(), 400);
            assert_eq!(response.json::<Value>().await.unwrap()["code"], "message_not_submitted");
            assert!(lab.ws.detail("a").await.unwrap().message_receipts.is_empty());
            assert_eq!(lab.message_journal(), 0);
            assert_eq!(lab.submissions(), 0);
        } else {
            assert_eq!(response.status(), 200);
            assert_eq!(response.json::<Value>().await.unwrap()["status"], "accepted");
            assert_eq!(lab.submissions(), 1, "Offline idle sessions still recover automatically");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_reconnect_preserves_current_pending_approval_transport() {
    for absent_readiness in [false, true] {
        let lab = Lab::new(true, false, false).await;
        lab.ws.reconnect("a").await.unwrap();
        lab.unready().await;
        if absent_readiness { lab.ws.collaboration_attached.lock().await.clear(); }
        let generation = lab.ws.rpcs.lock().unwrap()["a"].generation;
        lab.ws.store.update("a", "test/pending", &json!({}), |d| {
            d.agent.remote = Some(serde_json::from_value(json!({"machine":{"id":"test","name":"Test","target":"unused",
                "codex":"unused","defaultCwd":"/tmp"},"runtime":null})).unwrap());
            d.pending.push(PendingRequest { id:"approval".into(), agent_id:"a".into(),
                method:"item/commandExecution/requestApproval".into(), params:json!({"_runtimeGeneration":generation,"_rpcId":100}),
                created_at:now(), stale:false });
        }).unwrap();
        assert_eq!(lab.post("/agents/a/reconnect", &json!({})).await.0, 200);
        assert_eq!(lab.ws.rpcs.lock().unwrap()["a"].generation, generation);
        assert_eq!(lab.post("/requests/approval/respond", &json!({"response":{"decision":"decline"}})).await.0, 200);
        assert_eq!(lab.post("/agents/a/reconnect", &json!({})).await.0, 200);
        assert_eq!(lab.ws.rpcs.lock().unwrap()["a"].generation, generation, "Response sent but unresolved still owns its transport");
        let d = lab.ws.detail("a").await.unwrap();
        assert!(!d.pending[0].stale);
        assert_eq!(d.pending[0].params["_responseSent"], true);
        assert_eq!(lab.submissions(), 0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_missing_readiness_can_reconnect_and_offline_active_work_stays_check_only() {
    let lab = Lab::new(false, false, false).await;
    lab.ws.reconnect("a").await.unwrap();
    let generation = lab.ws.rpcs.lock().unwrap()["a"].generation;
    lab.ws.collaboration_attached.lock().await.clear();
    assert_eq!(lab.post("/agents/a/messages", &input("ordinary")).await.1["code"], "message_not_submitted");
    assert_eq!(lab.message_journal(), 0);
    assert_eq!(lab.post("/agents/a/reconnect", &json!({})).await.0, 200);
    assert_ne!(lab.ws.rpcs.lock().unwrap()["a"].generation, generation);
    assert!(lab.ws.collaboration_status("a").await.unwrap().ready);
    assert_eq!(lab.submissions(), 0);

    let lab = Lab::new(true, false, false).await;
    lab.ws.store.update("a", "test/offline", &json!({}), |d| d.agent.status = "offline".into()).unwrap();
    assert_eq!(lab.post("/agents/a/messages", &input("ordinary")).await.1["code"], "message_not_submitted");
    assert_eq!(lab.ws.detail("a").await.unwrap().agent.status, "working");
    assert_eq!(lab.message_journal(), 0);
    assert_eq!(lab.submissions(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_detail_combines_live_fields_without_holding_native_owner_or_advancing_history() {
    let lab = Lab::new(false, false, false).await;
    lab.ws.reconnect("a").await.unwrap();
    let before = lab.ws.detail("a").await.unwrap();
    let mut changes = lab.ws.changes.subscribe(None);
    crate::background_shells::codex_event(&lab.ws, "a", "turn/completed", &json!({}), Some("thread-a"));
    tokio::time::timeout(Duration::from_secs(5), async {
        while crate::background_shells::shells(&lab.ws, "a").is_none() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.unwrap();
    lab.unready().await;
    assert!(std::iter::from_fn(|| changes.try_next()).any(|event| event.data.contains("agent.changed")));
    let owned = lab.ws.owner("a").await;
    let response = tokio::time::timeout(Duration::from_secs(2), reqwest::get(format!("{}/agents/a", lab.base))).await.unwrap().unwrap();
    let detail: Value = response.json().await.unwrap();
    assert_eq!(detail["backgroundShells"]["count"], 1);
    assert_eq!(detail["collaboration"]["ready"], false);
    assert_eq!(detail["agent"]["lastSeq"], before.agent.last_seq);
    assert_eq!(detail["agent"]["unreadCount"], before.agent.unread_count);
    assert_eq!(detail["agent"]["rev"], before.agent.rev);
    drop(owned);
}
