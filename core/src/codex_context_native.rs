//! Context reload recovery and opt-in real-runtime acceptance.
//! Uses only owned processes and temporary workspace data; reports no messages.
use super::*;
use std::time::Duration;

#[tokio::test]
async fn context_remote_reattach_accepts_running_turn_usage_without_new_turn_started() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir()?;
    let script = root.path().join("native.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, sys
thread = {'id':'thread','status':{'type':'active'},'turns':[{'id':'active','status':'inProgress','items':[]}]}
def emit(value): print(json.dumps(value), flush=True)
def usage(turn, tokens): emit({'method':'thread/tokenUsage/updated','params':{'threadId':'thread','turnId':turn,'tokenUsage':{'last':{'totalTokens':tokens},'modelContextWindow':258400}}})
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request: continue
    method, result = request.get('method'), {}
    if method == 'thread/resume':
        usage('old', 1000)
        result = {'thread':thread,'model':'test-model'}
    elif method == 'test/usage': usage(request['params']['turn'], request['params']['tokens'])
    elif method == 'thread/read': result = {'thread':thread}
    emit({'id':request['id'],'result':result})
"#)?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    let ws = Workspace::new(root.path().join("data"), "/tmp".into(), script.to_string_lossy().into())?;
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","goal":"test",
        "cwd":"/tmp","model":"test-model","color":"sage","threadId":"thread","status":"idle",
        "createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]}))?;
    ws.store.insert(&detail)?;
    // Exercise the real attachment/event path over a local fixture transport;
    // the attachment represents a surviving remote runtime, with no SSH I/O.
    let connection = ws.connect("a").await?;
    let before = ws.detail("a").await?;
    let mut remote_agent = before.agent.clone();
    remote_agent.remote = Some(serde_json::from_value(json!({"machine":{"id":"fixture","name":"fixture",
        "target":"unused.invalid","codex":"codex","defaultCwd":"/tmp"},"runtime":null}))?);
    ws.codex_context.awaiting_fresh_usage("a", connection.generation);
    let params = resume_params("thread", &remote_agent);
    let reply = connection.rpc.begin_request("thread/resume", params.clone()).await?;
    *connection.attachment.lock().await = Some(Attachment {
        request_seq:before.agent.last_seq, request_rev:before.agent.rev, new_empty_thread:false,
        replacing_empty_thread:false, same_thread_only:false, agent:remote_agent, before,
        imported:false, initial_params:params, reply,
    });
    ws.finish_attach("a", connection.clone()).await?;
    connection.events.as_ref().unwrap().drain().await?;
    assert!(ws.detail("a").await?.context_usage.is_none());
    connection.rpc.request("test/usage", json!({"turn":"active","tokens":25000})).await?;
    connection.events.as_ref().unwrap().drain().await?;
    let live = ws.detail("a").await?;
    assert_eq!(live.context_usage.as_ref().unwrap().used_tokens, 25000);
    assert!(!live.context_usage.as_ref().unwrap().stale);
    assert!(!ws.codex_context.submitted("a", connection.generation, &live.agent.settings));
    connection.rpc.request("test/usage", json!({"turn":"old","tokens":1000})).await?;
    connection.events.as_ref().unwrap().drain().await?;
    assert_eq!(ws.detail("a").await?.context_usage.unwrap().used_tokens, 25000);
    ws.remove_connection("a", connection.generation).await;
    Ok(())
}

#[tokio::test]
async fn context_reload_late_rejection_releases_attempt_but_timeout_never_replays_it() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir()?;
    let script = root.path().join("native.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, sys
resumes, pending = 0, None
thread = {'id':'thread','status':{'type':'idle'},'turns':[{'id':'prior','status':'completed','items':[]}]}
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request: continue
    method, result = request.get('method'), {}
    if method == 'thread/resume':
        resumes += 1
        if resumes == 2:
            pending = request['id']
            continue
        result = {'thread':thread,'model':'test-model'}
    elif method == 'thread/read': result = {'thread':thread}
    elif method == 'thread/unsubscribe': result = {'status':'unsubscribed'}
    elif method == 'config/read': result = {'config':{'model_context_window':None,'model_auto_compact_token_limit':None}}
    elif method == 'test/resumes': result = {'count':resumes}
    elif method == 'test/reject':
        emit({'id':pending,'error':{'code':-32600,'message':'context rejected by fixture'}})
    emit({'id':request['id'],'result':result})
"#)?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    let ws = Workspace::new(root.path().join("data"), "/tmp".into(), script.to_string_lossy().into())?;
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","goal":"test",
        "cwd":"/tmp","model":"test-model","color":"sage","threadId":"thread","status":"idle",
        "createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]}))?;
    ws.store.insert(&detail)?;
    ws.reconnect("a").await?;
    let connection = ws.rpcs.lock().unwrap().get("a").cloned().unwrap();
    ws.reconnect_timeout_ms.store(5, Ordering::Relaxed);
    let error = ws.apply_codex_context("a").await.unwrap_err();
    assert!(error.is::<OutcomeUnknown>(), "{error:#}");
    assert!(ws.reconnect("a").await.unwrap_err().is::<OutcomeUnknown>());
    assert_eq!(connection.rpc.request("test/resumes", json!({})).await?["count"], 2);
    assert!(connection.attachment.lock().await.is_some());
    connection.rpc.request("test/reject", json!({})).await?;
    assert!(ws.reconnect("a").await.unwrap_err().is::<RpcError>());
    assert!(connection.attachment.lock().await.is_none());
    assert!(ws.codex_context.needs_resume("a", connection.generation));
    ws.reconnect_timeout_ms.store(1000, Ordering::Relaxed);
    let restored = ws.reconnect("a").await?;
    assert_eq!(restored.agent.thread_id.as_deref(), Some("thread"));
    assert_eq!(restored.agent.connection_state, "connected");
    assert_eq!(connection.rpc.request("test/resumes", json!({})).await?["count"], 3);
    assert_eq!(ws.rpcs.lock().unwrap().get("a").unwrap().rpc.pid(), connection.rpc.pid());
    assert!(!ws.codex_context.needs_resume("a", connection.generation));
    assert!(ws.codex_context.submitted("a", connection.generation, &restored.agent.settings));
    ws.close_agent("a").await?;
    Ok(())
}

/// T-140: the Codex model catalog checks the Agent on its listed view, reads
/// it again once connected for the settings the connection may change, and
/// takes the context settings from the send view, held or not. It answers as
/// the app-server does and as the whole record would, and reads no whole
/// record.
#[tokio::test]
async fn the_codex_model_catalog_reads_the_agent_and_its_send_view_not_its_history() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir()?;
    let script = root.path().join("native.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, sys
thread = {'id':'thread','status':{'type':'idle'},'turns':[{'id':'prior','status':'completed','items':[]}]}
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request: continue
    method, result = request.get('method'), {}
    if method == 'thread/resume': result = {'thread':thread,'model':'test-model'}
    elif method == 'thread/read': result = {'thread':thread}
    elif method == 'model/list': result = {'data':[{'id':'test-model','model':'test-model'}],'nextCursor':None}
    elif method == 'config/read': result = {'config':{'model_context_window':None,'model_auto_compact_token_limit':None}}
    elif method == 'configRequirements/read': result = {'requirements':None}
    emit({'id':request['id'],'result':result})
"#)?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    let ws = Workspace::new(root.path().join("data"), "/tmp".into(), script.to_string_lossy().into())?;
    let agent = "codex-catalog-reads";
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":agent,"name":"A","goal":"test",
        "cwd":"/tmp","model":"test-model","color":"sage","threadId":"thread","status":"idle",
        "createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"prior","status":"completed","items":[{"id":"m","type":"agentMessage","text":"done"}]}],
        "pending":[],"artifacts":[]}))?;
    ws.store.insert(&detail)?;
    ws.reconnect(agent).await?;
    let mut catalogs = Vec::new();
    for _ in [true, false] {
        let before = crate::store::detail_reads_of(agent);
        catalogs.push(ws.agent_catalog(agent).await?);
        assert_eq!(crate::store::detail_reads_of(agent) - before, 0, "a whole record was read");
        ws.store.release_for_test(agent);
    }
    assert_eq!(catalogs[0], catalogs[1], "held or not, the same catalog");
    let catalog = &catalogs[0];
    assert_eq!(catalog["models"], json!([{"id":"test-model","model":"test-model"}]));
    assert!(!catalog["permissions"].is_null());
    let whole = ws.detail(agent).await?;
    assert_eq!(catalog["context"]["needsFirstTurn"], json!(whole.turns.is_empty()));
    assert_eq!(catalog["context"]["canApply"], json!(ws.ensure_rewind_settled(agent).await.is_ok()
        && crate::codex_context::idle(&whole) && !whole.turns.is_empty()));
    assert_eq!(catalog["context"]["requestedWindowTokens"], json!(whole.agent.settings.context_window));
    ws.close_agent(agent).await?;
    Ok(())
}

/// T-140: a Codex Stop finds the harness on the listed Agent and the
/// running Turn on the send view, held or not, and reads no whole record. It
/// asks Codex once per Stop, with the Agent's own thread and that Turn, and
/// the Turn keeps running: the acknowledgement is not its end.
#[tokio::test]
async fn a_codex_stop_reads_the_agent_and_its_send_view_not_its_history() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir()?;
    let script = root.path().join("native.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, sys
thread = {'id':'thread','status':{'type':'active'},'turns':[{'id':'active','status':'inProgress','items':[]}]}
interrupts = []
def emit(value): print(json.dumps(value), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request: continue
    method, result = request.get('method'), {}
    if method == 'thread/resume': result = {'thread':thread,'model':'test-model'}
    elif method == 'thread/read': result = {'thread':thread}
    elif method == 'turn/interrupt': interrupts.append(request['params'])
    elif method == 'test/interrupts': result = {'asked':interrupts}
    emit({'id':request['id'],'result':result})
"#)?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
    let ws = Workspace::new(root.path().join("data"), "/tmp".into(), script.to_string_lossy().into())?;
    let agent = "codex-stop-reads";
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":agent,"name":"A","goal":"test",
        "cwd":"/tmp","model":"test-model","color":"sage","threadId":"thread","status":"working",
        "createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"active","status":"inProgress","items":[{"id":"m","type":"agentMessage","text":"working"}]}],
        "pending":[],"artifacts":[]}))?;
    ws.store.insert(&detail)?;
    ws.reconnect(agent).await?;
    let before = crate::store::detail_reads_of(agent);
    // The first Stop reads the record as the reconnect left it, the second once released.
    ws.interrupt(agent).await?;
    ws.store.release_for_test(agent);
    ws.interrupt(agent).await?;
    assert_eq!(crate::store::detail_reads_of(agent) - before, 0, "a whole record was read");
    let connection = ws.rpcs.lock().unwrap().get(agent).cloned().context("connected")?;
    let asked = connection.rpc.request("test/interrupts", json!({})).await?;
    assert_eq!(asked["asked"], json!([{"threadId":"thread","turnId":"active"}, {"threadId":"thread","turnId":"active"}]));
    let after = ws.detail(agent).await?;
    assert_eq!(after.turns.last().unwrap()["status"], "inProgress", "the acknowledgement is not the Turn's end");
    ws.remove_connection(agent, connection.generation).await;
    Ok(())
}

async fn small_turn(ws: &Arc<Workspace>, label: &str, checks: &mut Vec<Value>) -> Result<u64> {
    let response = ws
        .send(
            "probe",
            "Reply with exactly OK. Do not use tools, read files, browse, or send messages.".into(),
        )
        .await?;
    let turn = response["turnId"].as_str().context("missing turn")?;
    let detail = tokio::time::timeout(Duration::from_secs(150), async {
        loop {
            let detail = ws.detail("probe").await?;
            if let Some(done) = detail
                .turns
                .iter()
                .find(|t| t["id"] == turn && t["status"] != "inProgress")
            {
                anyhow::ensure!(done["status"] == "completed", "probe turn did not complete");
                return Ok::<_, anyhow::Error>(detail);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await??;
    let usage = detail.context_usage.context("native usage missing")?;
    anyhow::ensure!(
        usage.turn_id == turn && !usage.stale,
        "usage is not from the fresh turn"
    );
    checks.push(
        json!({"label":label,"windowTokens":usage.window_tokens,"usedTokens":usage.used_tokens,
        "turnCount":detail.turns.len(),"requestedWindow":detail.agent.settings.context_window}),
    );
    Ok(usage.window_tokens)
}

#[tokio::test]
#[ignore = "uses installed authenticated Codex and four tiny model turns; run as an authorized Job"]
async fn real_context_settings_through_workspace() -> Result<()> {
    let output = PathBuf::from(
        std::env::var_os("YUZUNO_CONTEXT_CORE_REPORT").context("report path required")?,
    );
    let program = std::env::var("YUZUNO_CONTEXT_PROBE_CODEX").unwrap_or_else(|_| "codex".into());
    let root = tempfile::Builder::new()
        .prefix("yuzuno-context-core-")
        .tempdir()?;
    let cwd = root.path().join("work");
    std::fs::create_dir(&cwd)?;
    let data = root.path().join("workspace");
    let mut workspaces = vec![];
    let mut checks = vec![];
    let result: Result<()> = async {
        let ws = Workspace::new(data.clone(), cwd.to_string_lossy().into(), program.clone())?;
        workspaces.push(ws.clone());
        let settings = AgentSettings { context_window:Some(872000), auto_compact_token_limit:Some(700000),
            reasoning_effort:Some("low".into()), ..Default::default() };
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"probe","name":"Context probe",
            "goal":"","cwd":cwd,"model":"gpt-6-astra","settings":settings,"color":"sage","status":"offline",
            "createdAt":now(),"updatedAt":now(),"unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]}))?;
        ws.store.insert(&detail)?;
        let original = ws.ensure("probe").await?;
        let thread = ws.detail("probe").await?.agent.thread_id.context("missing thread")?;
        anyhow::ensure!(ws.apply_codex_context("probe").await.is_err(), "empty thread must not unsubscribe");
        anyhow::ensure!(small_turn(&ws, "native-start-872000", &mut checks).await? == 828400, "unexpected native start window");
        ws.update_settings("probe", "gpt-6-astra".into(), AgentSettings {
            context_window:Some(600000), reasoning_effort:Some("low".into()), ..Default::default()
        }).await?;
        let applied = ws.apply_codex_context("probe").await?;
        anyhow::ensure!(applied["settingsSubmitted"] == true && applied["observedWindowTokens"].is_null(), "resume replay must remain unknown");
        let after = ws.ensure("probe").await?;
        anyhow::ensure!(original.rpc.pid() == after.rpc.pid() && original.generation == after.generation, "apply replaced the app-server");
        anyhow::ensure!(small_turn(&ws, "same-process-apply-600000", &mut checks).await? == 570000, "apply window mismatch");
        anyhow::ensure!(ws.detail("probe").await?.agent.thread_id.as_deref() == Some(thread.as_str()), "apply changed thread identity");
        // Save another override and explicitly apply, then recreate only the
        // probe Workspace before a model turn. Cached resume usage is old.
        ws.update_settings("probe", "gpt-6-astra".into(), AgentSettings {
            context_window:Some(700000), reasoning_effort:Some("low".into()), ..Default::default()
        }).await?;
        ws.apply_codex_context("probe").await?;
        ws.close_agent("probe").await?;
        // These test snapshots also own EventBarrier senders. Release them
        // so the native event reader can exit and drop its Workspace owner.
        drop(original);
        drop(after);
        let previous = Arc::downgrade(&ws);
        workspaces.clear();
        drop(ws);
        tokio::time::timeout(Duration::from_secs(2), async {
            while previous.strong_count() != 0 { tokio::task::yield_now().await; }
        }).await.context("old probe Workspace did not release its data lock")?;
        let reopened = Workspace::new(data, cwd.to_string_lossy().into(), program)?;
        workspaces.push(reopened.clone());
        reopened.reopen_agent("probe").await?;
        let catalog = reopened.agent_catalog("probe").await?;
        anyhow::ensure!(catalog["context"]["observedWindowTokens"].is_null(), "restart accepted cached usage");
        anyhow::ensure!(small_turn(&reopened, "restart-before-fresh-turn-700000", &mut checks).await? == 665000, "restart lost saved window");
        reopened.update_settings("probe", "gpt-6-astra".into(), AgentSettings {
            reasoning_effort:Some("low".into()), ..Default::default()
        }).await?;
        reopened.apply_codex_context("probe").await?;
        anyhow::ensure!(small_turn(&reopened, "reset-by-omission", &mut checks).await? == 258400, "native default was not restored");
        anyhow::ensure!(reopened.detail("probe").await?.agent.thread_id.as_deref() == Some(thread.as_str()), "restart or reset changed thread identity");
        checks.push(json!({"sameThread":true,"applyKeptAppServer":true,"emptyThreadProtected":true,"restartSuppressedCachedUsage":true}));
        Ok(())
    }.await;
    // Always stop only the processes owned by this probe, including failures.
    for ws in workspaces {
        let connections: Vec<_> = ws.rpcs.lock().unwrap().values().cloned().collect();
        for connection in connections {
            let _ = connection.rpc.close_and_wait().await;
        }
    }
    let report = json!({"kind":"candidate-workspace-context-native","passed":result.is_ok(),"checks":checks});
    std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
    println!("{report}");
    result
}
