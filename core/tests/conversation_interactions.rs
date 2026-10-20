//! Deterministic native-protocol boundary tests. Every runtime and DB is temporary.
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, sync::Arc};
use yuzuno_workspace::{model::{AgentDetail, AgentSettings, MessageInput}, store::Store, workspace::Workspace};

fn detail() -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"test-model","color":"sage","threadId":"thread","status":"idle","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

fn input(id: &str, text: &str, turn: Option<&str>) -> MessageInput {
    serde_json::from_value(json!({"clientMessageId":id,"text":text,"expectedTurnId":turn})).unwrap()
}

fn form_spec() -> Value {
    json!({"root":"result","elements":{
        "result":{"type":"Result","props":{"title":"Setup","summary":"Confirm the directory"},"children":["form"]},
        "form":{"type":"Clarification","props":{"id":"setup","title":"Setup","fields":[
            {"id":"directory","type":"text","label":"Directory","required":true}
        ]}}
    }})
}

fn form_input(client: &str, result: &str, directory: &str) -> MessageInput {
    let answer = serde_json::to_string(directory).unwrap();
    let text = format!("Answers to “Setup”:\n{{\n  \"resultId\": \"{result}\",\n  \"formId\": \"setup\",\n  \"answers\": {{\n    \"directory\": {answer}\n  }}\n}}");
    serde_json::from_value(json!({"clientMessageId":client,"text":text,"expectedTurnId":null,
        "clarification":{"resultId":result,"formId":"setup","answers":{"directory":directory}}})).unwrap()
}

#[tokio::test]
async fn published_form_answers_bind_the_original_result_and_send_once_with_durable_receipts() {
    let (dir, ws) = fixture().await;
    ws.send_message("a", input("start", "Please clarify", None)).await.unwrap();
    let published = ws.result_publish("a", json!({"requestId":"form","expectedTurnId":"turn-1","spec":form_spec()})).await.unwrap().unwrap();
    let result = published["resultId"].as_str().unwrap();
    let answer = form_input("answer", result, "中文目录 /workspace");
    let (first, duplicate) = tokio::join!(ws.send_message("a", answer.clone()), ws.send_message("a", answer.clone()));
    assert_eq!(first.unwrap().status, "accepted");
    assert_eq!(duplicate.unwrap().status, "accepted");
    assert_eq!(calls(&dir, "turn/steer").len(), 1);
    assert!(calls(&dir, "turn/steer")[0]["params"]["input"][0]["text"].as_str().unwrap().contains(result));
    let other_window = form_input("other-window", result, "another answer");
    assert!(ws.send_message("a", other_window).await.unwrap_err().to_string().contains("already submitted"));
    ws.reconnect("a").await.unwrap();
    assert_eq!(ws.send_message("a", answer).await.unwrap().status, "accepted");
    assert_eq!(calls(&dir, "turn/steer").len(), 1);
    assert_eq!(ws.store.detail("a").unwrap().agent.reviewed_seq, 0);
}

#[tokio::test]
async fn forms_reject_invalid_stale_foreign_session_and_closed_sources_without_native_sends() {
    let (dir, ws) = fixture().await;
    ws.send_message("a", input("start", "Please clarify", None)).await.unwrap();
    let first = ws.result_publish("a", json!({"requestId":"form1","expectedTurnId":"turn-1","spec":form_spec()})).await.unwrap().unwrap();
    let result = first["resultId"].as_str().unwrap();
    assert!(ws.send_message("a", form_input("blank", result, " ")).await.is_err());
    let mut forged = form_input("forged", result, "valid"); forged.text = "A different instruction".into();
    assert!(ws.send_message("a", forged).await.is_err());
    let mut wrong_field = form_input("field", result, "valid"); wrong_field.clarification.as_mut().unwrap().answers = json!({"another":"value"});
    assert!(ws.send_message("a", wrong_field).await.is_err());
    assert!(ws.send_message("a", form_input("missing", "not-a-result", "valid")).await.is_err());
    let mut foreign = detail(); foreign.agent.id = "b".into(); ws.store.insert(&foreign).unwrap();
    assert!(ws.send_message("b", form_input("foreign", result, "valid")).await.unwrap_err().to_string().contains("unavailable"));
    let latest = ws.result_publish("a", json!({"requestId":"form2","expectedTurnId":"turn-1","spec":form_spec(),"revisesResultId":result})).await.unwrap().unwrap();
    assert!(ws.send_message("a", form_input("stale", result, "valid")).await.unwrap_err().to_string().contains("replaced"));
    let result = latest["resultId"].as_str().unwrap();
    ws.store.update("a", "test/session", &json!({}), |d| d.agent.thread_id = Some("different-session".into())).unwrap();
    assert!(ws.send_message("a", form_input("session", result, "valid")).await.unwrap_err().to_string().contains("conversation has changed"));
    ws.store.update("a", "test/close", &json!({}), |d| { d.agent.thread_id = Some("thread".into()); d.agent.closed_at = Some("closed".into()); }).unwrap();
    assert!(ws.send_message("a", form_input("closed", result, "valid")).await.is_err());
    assert!(calls(&dir, "turn/steer").is_empty());
}

#[tokio::test]
async fn rejected_form_can_be_explicitly_retried_but_lost_delivery_is_never_replayed() {
    let (dir, ws) = fixture().await;
    ws.send_message("a", input("start", "Please clarify", None)).await.unwrap();
    let publish = |request| json!({"requestId":request,"expectedTurnId":"turn-1","spec":form_spec()});
    let first = ws.result_publish("a", publish("form1")).await.unwrap().unwrap();
    let result = first["resultId"].as_str().unwrap();
    std::fs::write(dir.path().join("form-outcome"), "reject").unwrap();
    assert_eq!(ws.send_message("a", form_input("rejected", result, "kept")).await.unwrap().status, "rejected");
    std::fs::remove_file(dir.path().join("form-outcome")).unwrap();
    assert_eq!(ws.send_message("a", form_input("retry", result, "kept")).await.unwrap().status, "accepted");
    let second = ws.result_publish("a", publish("form2")).await.unwrap().unwrap();
    std::fs::write(dir.path().join("form-outcome"), "lost").unwrap();
    let lost = form_input("lost", second["resultId"].as_str().unwrap(), "kept after transport loss");
    assert_eq!(ws.send_message("a", lost.clone()).await.unwrap().status, "uncertain");
    assert_eq!(ws.send_message("a", lost).await.unwrap().status, "uncertain");
    assert_eq!(calls(&dir, "turn/steer").len(), 3);
    let receipts = ws.store.detail("a").unwrap().message_receipts;
    assert_eq!(receipts.last().unwrap().input.clarification.as_ref().unwrap().answers["directory"], "kept after transport loss");
}

async fn fixture() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("native.py");
    std::fs::write(&script, r#"#!/usr/bin/python3
import json, sys, pathlib
root = pathlib.Path(__file__).parent
state = root / 'thread.json'
loaded = False
def emit(value): print(json.dumps(value), flush=True)
def thread():
    return json.loads(state.read_text()) if state.exists() else {'id':'thread','status':{'type':'idle'},'turns':[]}
for line in sys.stdin:
    request = json.loads(line)
    with (root / 'calls.jsonl').open('a') as log: log.write(json.dumps(request)+'\n')
    method, params = request.get('method'), request.get('params', {})
    if 'id' not in request: continue
    result = {}
    if method in ['thread/start','thread/resume','thread/read']:
        if method == 'thread/resume' and (root/'missing-rollout').exists():
            emit({'id':request['id'],'error':{'code':-32600,'message':'no rollout found for thread id thread'}})
            continue
        if method != 'thread/read': loaded = True
        result = {'thread':thread(), 'model':params.get('model','test-model')}
        if method == 'thread/resume' and (root/'replay-usage').exists(): emit({'method':'thread/tokenUsage/updated','params':{'threadId':'thread','turnId':'old','tokenUsage':{'last':{'totalTokens':20000},'modelContextWindow':258400}}})
    elif method == 'thread/unsubscribe':
        loaded = (root/'other-subscriber').exists()
        result = {'status':'unsubscribed'}
        if not loaded: emit({'method':'thread/closed','params':{'threadId':'thread'}})
    elif method == 'thread/loaded/list':
        result = {'data':['thread'] if loaded else [],'nextCursor':None}
    elif method == 'model/list':
        result = {'data':[{'id':'test-model','model':'test-model','defaultReasoningEffort':'low','supportedReasoningEfforts':[{'reasoningEffort':'low'},{'reasoningEffort':'high'}]}], 'nextCursor':None}
    elif method == 'config/read':
        if (root/'config-error').exists():
            emit({'id':request['id'],'error':{'code':-32600,'message':'config unavailable'}})
            continue
        cfg = root / 'config.json'
        result = {'config':json.loads(cfg.read_text()) if cfg.exists() else {'approvals_reviewer':'auto_review','sandbox_mode':'workspace-write','model_context_window':None,'model_auto_compact_token_limit':None}}
    elif method == 'configRequirements/read':
        cfg = root / 'requirements.json'
        result = {'requirements':json.loads(cfg.read_text()) if cfg.exists() else None}
    elif method in ['turn/start','turn/steer']:
        if not loaded:
            emit({'id':request['id'],'error':{'code':-32600,'message':'thread is not loaded'}})
            continue
        text = next((i['text'] for i in params['input'] if i['type'] == 'text'), '')
        if text.startswith('Answers to') and (root/'form-outcome').exists():
            if (root/'form-outcome').read_text() == 'lost': sys.exit(0)
            emit({'id':request['id'],'error':{'code':-32600,'message':'form reply rejected by fixture'}})
            continue
        if text == 'reject':
            emit({'id':request['id'],'error':{'code':-32600,'message':'turn has finished'}})
            continue
        t = thread()
        if method == 'turn/steer' and text in ['answer-race', 'answer-timeout']:
            if text == 'answer-timeout': sys.exit(0)
            t['turns'][-1]['status'] = 'completed'
            t['status']['type'] = 'idle'
            state.write_text(json.dumps(t))
            emit({'id':request['id'],'error':{'code':-32600,'message':'no active turn to steer'}})
            continue
        if method == 'turn/start':
            turn = {'id':'turn-'+str(len(t['turns'])+1), 'status':'inProgress','items':[]}
            t['turns'].append(turn)
        else: turn = t['turns'][-1]
        item = {'id':'native-'+str(len(turn['items'])), 'clientId':params.get('clientUserMessageId'), 'type':'userMessage','content':params['input']}
        if text != 'lost-unconfirmed': turn['items'].append(item)
        t['status'] = {'type':'active'}
        state.write_text(json.dumps(t))
        if text.startswith('lost'): sys.exit(0)
        if method == 'turn/start': emit({'method':'turn/started','params':{'threadId':'thread','turn':turn}})
        emit({'method':'item/completed','params':{'threadId':'thread','turnId':turn['id'],'item':item}})
        result = {'turn':turn} if method == 'turn/start' else {'turnId':turn['id']}
    emit({'id':request['id'],'result':result})
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.to_string_lossy().into()).unwrap();
    ws.store.insert(&detail()).unwrap();
    ws.reconnect("a").await.unwrap();
    (dir, ws)
}

fn calls(dir: &tempfile::TempDir, method: &str) -> Vec<Value> {
    std::fs::read_to_string(dir.path().join("calls.jsonl")).unwrap().lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()).filter(|r| r["method"] == method).collect()
}

#[tokio::test]
async fn concurrent_retry_sends_once_and_steer_never_falls_back_to_start() {
    let (dir, ws) = fixture().await;
    let a = input("initial", "hello", None);
    let (first, retry) = tokio::join!(ws.send_message("a", a.clone()), ws.send_message("a", a.clone()));
    assert_eq!(first.unwrap().status, "accepted");
    assert_eq!(retry.unwrap().status, "accepted");
    assert_eq!(calls(&dir, "turn/start").len(), 1);
    assert!(ws.send_message("a", input("initial", "different", None)).await.is_err());
    let steered = ws.send_message("a", input("extra", "more", Some("turn-1"))).await.unwrap();
    assert_eq!(steered.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(ws.send_message("a", input("stale", "more", Some("old-turn"))).await.unwrap().status, "rejected");
    assert_eq!(ws.send_message("a", input("race", "reject", Some("turn-1"))).await.unwrap().status, "rejected");
    assert_eq!(calls(&dir, "turn/steer").len(), 2);
    assert_eq!(calls(&dir, "turn/start").len(), 1);
    ws.reconnect("a").await.unwrap();
    let d = ws.store.detail("a").unwrap();
    assert_eq!(d.turns.len(), 1);
    assert_eq!(d.turns[0]["items"].as_array().unwrap().len(), 2);
    assert_eq!(d.agent.reviewed_seq, 0);
}

#[tokio::test]
async fn lost_reply_is_not_replayed_and_native_id_can_confirm_delivery() {
    let (dir, ws) = fixture().await;
    ws.send_message("a", input("start", "hello", None)).await.unwrap();
    let lost = input("lost-id", "lost-confirmed", Some("turn-1"));
    assert_eq!(ws.send_message("a", lost.clone()).await.unwrap().status, "uncertain");
    assert_eq!(ws.send_message("a", lost.clone()).await.unwrap().status, "uncertain");
    assert!(ws.send_message("a", input("different", "new", None)).await.is_err());
    assert!(ws.send("a", "legacy new".into()).await.is_err());
    ws.reconnect("a").await.unwrap();
    assert_eq!(ws.send_message("a", lost).await.unwrap().status, "accepted");
    assert_eq!(calls(&dir, "turn/steer").len(), 1);
    assert_eq!(calls(&dir, "turn/start").len(), 1);
}

#[tokio::test]
async fn reconciliation_without_native_evidence_keeps_unknown_receipt() {
    let (dir, ws) = fixture().await;
    ws.send_message("a", input("start", "hello", None)).await.unwrap();
    let lost = input("lost-id", "lost-unconfirmed", Some("turn-1"));
    assert_eq!(ws.send_message("a", lost.clone()).await.unwrap().status, "uncertain");
    ws.reconnect("a").await.unwrap();
    assert_eq!(ws.send_message("a", lost).await.unwrap().status, "uncertain");
    assert!(ws.send_message("a", input("new-id", "new", None)).await.is_err());
    assert_eq!(calls(&dir, "turn/steer").len(), 1);
}

#[tokio::test]
async fn direct_answer_is_deduplicated_without_resolving_pending_or_read_state() {
    let (dir, ws) = fixture().await;
    ws.send_message("a", input("start", "hello", None)).await.unwrap();
    ws.store.update("a", "fixture", &json!({}), |d| {
        d.turns[0]["items"].as_array_mut().unwrap().push(json!({"id":"question","type":"agentMessage","delivery":"async","questions":[{"title":"Which?"}]}));
        d.pending.push(serde_json::from_value(json!({"id":"pending","agentId":"a","method":"item/tool/requestUserInput","params":{"isBlocking":false},"createdAt":"","stale":false})).unwrap());
    }).unwrap();
    let mut answer = input("answer", "Regarding your question…", Some("turn-1"));
    answer.question = Some(serde_json::from_value(json!({"turnId":"turn-1","itemId":"question"})).unwrap());
    assert_eq!(ws.send_message("a", answer.clone()).await.unwrap().status, "accepted");
    answer.client_message_id = "double-click".into();
    assert!(ws.send_message("a", answer).await.is_err());
    let d = ws.store.detail("a").unwrap();
    assert_eq!(d.pending.len(), 1);
    assert_eq!(d.agent.reviewed_seq, 0);
    assert_eq!(calls(&dir, "turn/steer").len(), 1);
}

fn add_question(ws: &Workspace) {
    ws.store.update("a", "fixture", &json!({}), |d| {
        d.turns[0]["items"].as_array_mut().unwrap().push(json!({"id":"question","type":"agentMessage","delivery":"async","questions":[{"title":"Which?"}]}));
        d.pending.push(serde_json::from_value(json!({"id":"pending","agentId":"a","method":"item/tool/requestUserInput","params":{"isBlocking":false},"createdAt":"","stale":false})).unwrap());
    }).unwrap();
}

fn finish_native(dir: &tempfile::TempDir) {
    let state = dir.path().join("thread.json");
    let mut thread: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
    thread["turns"].as_array_mut().unwrap().last_mut().unwrap()["status"] = "completed".into();
    thread["status"]["type"] = "idle".into();
    std::fs::write(state, serde_json::to_vec(&thread).unwrap()).unwrap();
}

#[tokio::test]
async fn async_answer_uses_a_new_turn_when_browser_and_core_still_show_finished_work_as_active() {
    let (dir, ws) = fixture().await;
    ws.send_message("a", input("start", "hello", None)).await.unwrap();
    add_question(&ws);
    finish_native(&dir); // Completion notification has not reached Core or UI.
    let mut answer = input("answer", "Yes", Some("turn-1"));
    answer.question = Some(serde_json::from_value(json!({"turnId":"turn-1","itemId":"question"})).unwrap());
    assert_eq!(ws.send_message("a", answer.clone()).await.unwrap().turn_id.as_deref(), Some("turn-2"));
    assert_eq!(ws.send_message("a", answer).await.unwrap().status, "accepted");
    assert_eq!(calls(&dir, "turn/start").len(), 2);
    assert!(calls(&dir, "turn/steer").is_empty());
    let d = ws.store.detail("a").unwrap();
    assert_eq!(d.pending.len(), 1);
    assert_eq!(d.agent.reviewed_seq, 0);
}

#[tokio::test]
async fn an_explicit_no_active_turn_rejection_can_recover_an_answer_but_a_lost_reply_never_replays() {
    for (text, expected_status, starts) in [("answer-race", "accepted", 2), ("answer-timeout", "uncertain", 1)] {
        let (dir, ws) = fixture().await;
        ws.send_message("a", input("start", "hello", None)).await.unwrap();
        add_question(&ws);
        let mut answer = input("answer", text, Some("turn-1"));
        answer.question = Some(serde_json::from_value(json!({"turnId":"turn-1","itemId":"question"})).unwrap());
        assert_eq!(ws.send_message("a", answer.clone()).await.unwrap().status, expected_status);
        assert_eq!(ws.send_message("a", answer).await.unwrap().status, expected_status);
        assert_eq!(calls(&dir, "turn/steer").len(), 1);
        assert_eq!(calls(&dir, "turn/start").len(), starts);
    }
}

#[tokio::test]
async fn permission_presets_persist_and_follow_config_is_reread_for_each_new_turn() {
    let (dir, ws) = fixture().await;
    let settings = AgentSettings { permission_preset:Some("auto".into()), ..Default::default() };
    ws.update_settings("a", "test-model".into(), settings).await.unwrap();
    ws.send_message("a", input("start", "hello", None)).await.unwrap();
    let first = &calls(&dir, "turn/start")[0]["params"];
    assert_eq!(first["approvalsReviewer"], "auto_review");
    assert_eq!(first["sandboxPolicy"]["type"], "workspaceWrite");
    assert_eq!(first["sandboxPolicy"]["networkAccess"], false);
    ws.update_settings("a", "test-model".into(), AgentSettings { permission_preset:Some("config".into()), ..Default::default() }).await.unwrap();
    assert!(calls(&dir, "turn/interrupt").is_empty());
    assert!(calls(&dir, "config/batchWrite").is_empty());
    finish_native(&dir); ws.reconnect("a").await.unwrap();
    std::fs::write(dir.path().join("config.json"), json!({"approvals_reviewer":"user","approval_policy":"never","sandbox_mode":"read-only"}).to_string()).unwrap();
    ws.send_message("a", input("next", "hello again", None)).await.unwrap();
    let next = &calls(&dir, "turn/start")[1]["params"];
    assert_eq!(next["approvalsReviewer"], "user");
    assert_eq!(next["approvalPolicy"], "never");
    assert_eq!(next["sandboxPolicy"]["type"], "readOnly");
    assert_eq!(ws.store.detail("a").unwrap().agent.settings.permission_preset.as_deref(), Some("config"));
    assert!(calls(&dir, "config/value/write").is_empty());
}

#[tokio::test]
async fn managed_permissions_disable_and_reject_modes_without_changing_saved_settings() {
    let (dir, ws) = fixture().await;
    std::fs::write(dir.path().join("requirements.json"), json!({"allowedApprovalPolicies":["on-request"],"allowedSandboxModes":["workspace-write"]}).to_string()).unwrap();
    let catalog = ws.agent_catalog("a").await.unwrap();
    let full = catalog["permissions"]["presets"].as_array().unwrap().iter().find(|p| p["id"] == "full").unwrap();
    assert_eq!(full["available"], false);
    let settings = AgentSettings { permission_preset:Some("full".into()), ..Default::default() };
    assert!(ws.update_settings("a", "test-model".into(), settings).await.is_err());
    assert!(ws.store.detail("a").unwrap().agent.settings.permission_preset.is_none());
    assert!(calls(&dir, "turn/start").is_empty());
}

#[tokio::test]
async fn settings_are_validated_persisted_and_only_used_on_next_start_or_resume() {
    let (dir, ws) = fixture().await;
    ws.send_message("a", input("start", "hello", None)).await.unwrap();
    let settings = AgentSettings { context_window: None, auto_compact_token_limit: None, reasoning_effort:Some("high".into()), approval_policy:"never".into(), sandbox:"read-only".into(), permission_preset:None, permission_mode:None };
    assert!(ws.update_settings("a", "not-on-this-machine".into(), settings.clone()).await.is_err());
    let mut invalid = settings.clone(); invalid.reasoning_effort = Some("ultra".into());
    assert!(ws.update_settings("a", "test-model".into(), invalid).await.is_err());
    let saved = ws.update_settings("a", "test-model".into(), settings).await.unwrap();
    assert_eq!(saved.settings.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(saved.status, "working");
    assert_eq!(saved.reviewed_seq, 0);
    assert_eq!(calls(&dir, "turn/start")[0]["params"]["approvalPolicy"], "on-request");
    assert_eq!(calls(&dir, "turn/interrupt").len(), 0);
    let state = dir.path().join("thread.json");
    let mut thread: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
    thread["turns"][0]["status"] = "completed".into(); thread["status"]["type"] = "idle".into();
    std::fs::write(&state, serde_json::to_vec(&thread).unwrap()).unwrap();
    ws.reconnect("a").await.unwrap();
    assert_eq!(ws.send_message("a", input("next", "hello again", None)).await.unwrap().status, "accepted");
    let next = &calls(&dir, "turn/start")[1]["params"];
    assert_eq!(next["model"], "test-model");
    assert_eq!(next["effort"], "high");
    assert_eq!(next["sandboxPolicy"]["type"], "readOnly");
    assert_eq!(next["approvalPolicy"], "never");
}

#[test]
fn context_uses_latest_request_and_survives_restart_as_stale() {
    let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("workspace.sqlite");
    {
        let store = Store::open(&path).unwrap(); store.insert(&detail()).unwrap();
        store.update("a", "thread/tokenUsage/updated", &json!({}), |d| {
            d.apply("thread/tokenUsage/updated", &json!({"turnId":"t","tokenUsage":{"last":{"totalTokens":25000},"total":{"totalTokens":999999},"modelContextWindow":100000}}));
            assert_eq!(d.context_usage.as_ref().unwrap().used_percent, 25.0);
            d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"pending","text":"hello"},"status":"sending"})).unwrap());
        }).unwrap();
    }
    let store = Store::open(&path).unwrap(); let mut d = store.detail("a").unwrap();
    assert!(d.context_usage.as_ref().unwrap().stale);
    assert_eq!(d.message_receipts[0].status, "uncertain");
    d.apply("thread/tokenUsage/updated", &json!({"tokenUsage":{"last":{"totalTokens":100},"modelContextWindow":0}}));
    assert!(d.context_usage.is_none());
    assert_eq!(d.agent.reviewed_seq, 0);
}

#[tokio::test]
async fn codex_interaction_endpoints_cannot_rebind_a_claude_agent_or_create_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "must-not-spawn-codex".into()).unwrap();
    let mut d = detail();
    d.agent.harness = "claude".into();
    d.agent.claude_session_id = Some("preserve-native-claude-session".into());
    d.agent.thread_id = None;
    d.agent.model = "haiku".into();
    ws.store.insert(&d).unwrap();
    // Ordinary idle Claude sends now share receipts (T-48); Codex-native
    // async-question answers remain unsupported and cannot start a runtime.
    let mut question = input("client-message", "hello", None);
    question.question = Some(yuzuno_workspace::model::QuestionSource { turn_id: "t".into(), item_id: "q".into() });
    let error = ws.send_message("a", question).await.unwrap_err();
    assert!(error.to_string().contains("Claude answers in the conversation"), "{error}");
    let error = ws.agent_catalog("a").await.unwrap_err();
    assert!(error.to_string().contains("仅适用于 Codex"));
    let error = ws.update_settings("a", "codex-model".into(), AgentSettings::default()).await.unwrap_err();
    assert!(error.to_string().contains("Claude 当前不支持"));
    let after = ws.store.detail("a").unwrap();
    assert_eq!(after.agent.claude_session_id, d.agent.claude_session_id);
    assert!(after.agent.thread_id.is_none());
    assert_eq!(after.agent.model,"haiku");
    assert_eq!(after.agent.last_seq,0,"unsupported operations must not journal a send or connection attempt");
    assert!(after.message_receipts.is_empty());
    assert!(after.context_usage.is_none());
    // A follow-up to a turn that is not running is refused before anything
    // is sent (T-65): no receipt, the draft is kept, and no runtime starts.
    let refused = ws.send_message("a", input("client-message", "hello", Some("active-claude-turn"))).await.unwrap_err();
    assert!(refused.to_string().contains("原 Turn 已结束"), "{refused}");
    let after = ws.store.detail("a").unwrap();
    assert!(after.message_receipts.is_empty());
    assert_eq!(after.agent.claude_session_id, d.agent.claude_session_id);
    assert!(after.agent.thread_id.is_none());
}

#[test]
fn compaction_and_rail_projection_preserve_each_others_native_evidence() {
    let mut d=detail();
    d.apply("thread/tokenUsage/updated", &json!({"turnId":"t","tokenUsage":{"last":{"totalTokens":25000},"modelContextWindow":100000}}));
    d.apply("turn/started", &json!({"turn":{"id":"t","status":"inProgress","items":[]}}));
    d.apply("item/completed", &json!({"turnId":"t","item":{"id":"commentary","type":"agentMessage","phase":"commentary","text":"验证会话恢复"}}));
    d.apply("item/completed", &json!({"turnId":"t","item":{"id":"compact","type":"contextCompaction"}}));
    assert!(d.context_usage.as_ref().unwrap().stale);
    assert_eq!(d.context_usage.as_ref().unwrap().used_percent,25.0);
    let summary=yuzuno_workspace::rail::project(&d).unwrap();
    assert_eq!(summary.text,"验证会话恢复");
    assert_eq!(summary.item_id.as_deref(),Some("commentary"));
    assert_eq!(summary.source,"agent");
    assert_eq!(d.agent.reviewed_seq,0);
}

#[tokio::test]
async fn images_are_sent_natively_scoped_and_included_in_durable_deduplication() {
    use axum::{body::{Body, to_bytes}, http::Request};
    use tower::ServiceExt;
    let (dir, ws) = fixture().await;
    let router = yuzuno_workspace::server::router(ws.clone(), dir.path().join("web"));
    ws.reconnect("a").await.unwrap();
    let mut ids = Vec::new();
    for color in [40, 180] {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(16, 16, image::Rgb([color, 30, 10])).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let make = || Request::builder().method("POST").uri("/api/agents/a/images").header("host", "127.0.0.1:4317");
        let denied = router.clone().oneshot(make().body(Body::from(png.get_ref().clone())).unwrap()).await.unwrap();
        assert_eq!(denied.status(), 403);
        let response = router.clone().oneshot(make().header("x-yuzuno-client", "desktop").body(Body::from(png.into_inner())).unwrap()).await.unwrap();
        assert_eq!(response.status(), 200);
        let value: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        ids.push(value["id"].as_str().unwrap().to_string());
    }
    let mut first = input("with-images", "Inspect both", None);
    first.images = ids.clone();
    assert_eq!(ws.send_message("a", first.clone()).await.unwrap().status, "accepted");
    assert_eq!(ws.send_message("a", first.clone()).await.unwrap().status, "accepted");
    let mut changed = first.clone(); changed.images.reverse();
    assert!(ws.send_message("a", changed).await.is_err());
    let mut only_image = input("image-only", "", Some("turn-1"));
    only_image.images.push(ids[1].clone());
    assert_eq!(ws.send_message("a", only_image).await.unwrap().status, "accepted");
    let starts = calls(&dir, "turn/start");
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0]["params"]["input"].as_array().unwrap().len(), 3);
    let path = starts[0]["params"]["input"][1]["path"].as_str().unwrap();
    assert!(std::path::Path::new(path).is_file());
    assert_eq!(calls(&dir, "turn/steer")[0]["params"]["input"][0]["type"], "localImage");
    ws.reconnect("a").await.unwrap();
    let saved = ws.store.detail("a").unwrap();
    assert_eq!(saved.message_receipts[0].input.images, ids);
    assert_eq!(saved.turns[0]["items"][0]["content"][1]["type"], "localImage");
    assert_eq!(saved.agent.reviewed_seq, 0);
    let response = router.oneshot(Request::builder().uri(format!("/api/agents/a/images/{}?thumb=true", ids[0])).header("host", "127.0.0.1:4317").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 16);
}


async fn context_fixture() -> (tempfile::TempDir, Arc<Workspace>) {
    let (dir, ws) = fixture().await;
    std::fs::write(dir.path().join("thread.json"), json!({"id":"thread","status":{"type":"idle"},
        "turns":[{"id":"prior","status":"completed","items":[]}]}).to_string()).unwrap();
    ws.reconnect("a").await.unwrap();
    (dir, ws)
}

#[tokio::test]
async fn context_settings_persist_per_agent_and_apply_only_by_explicit_idle_reload() {
    let (dir, ws) = context_fixture().await;
    let mut other = detail(); other.agent.id = "b".into(); ws.store.insert(&other).unwrap();
    let settings = AgentSettings { context_window:Some(872000), auto_compact_token_limit:None,
        reasoning_effort:Some("high".into()), ..Default::default() };
    ws.update_settings("a", "test-model".into(), settings).await.unwrap();
    assert_eq!(ws.store.detail("a").unwrap().agent.settings.context_window, Some(872000));
    assert_eq!(ws.store.detail("b").unwrap().agent.settings.context_window, None);
    assert!(calls(&dir, "thread/unsubscribe").is_empty());
    assert_eq!(ws.agent_catalog("a").await.unwrap()["context"]["settingsSubmitted"], false);
    std::fs::write(dir.path().join("replay-usage"), "yes").unwrap();
    let applied = ws.apply_codex_context("a").await.unwrap();
    assert_eq!(applied["settingsSubmitted"], true);
    assert!(applied["observedWindowTokens"].is_null());
    let resume = calls(&dir, "thread/resume").pop().unwrap();
    assert_eq!(resume["params"]["threadId"], "thread");
    assert_eq!(resume["params"]["config"]["model_context_window"], 872000);
    assert_eq!(resume["params"]["config"]["model_auto_compact_token_limit"], 784800);
    assert_eq!(resume["params"]["config"]["model_reasoning_effort"], "high");
    ws.update_settings("a", "test-model".into(), AgentSettings::default()).await.unwrap();
    ws.apply_codex_context("a").await.unwrap();
    let resume = calls(&dir, "thread/resume").pop().unwrap();
    assert!(resume["params"]["config"].get("model_context_window").is_none());
    assert!(resume["params"]["config"].get("model_auto_compact_token_limit").is_none());
    for method in ["thread/start", "thread/fork", "turn/start", "turn/interrupt", "config/value/write", "config/batchWrite"] {
        assert!(calls(&dir, method).is_empty(), "{method}");
    }
}

#[tokio::test]
async fn context_reload_refuses_active_turn_pending_approval_and_uncertain_receipts() {
    for state in ["working", "approval", "uncertain"] {
        let (dir, ws) = fixture().await;
        ws.store.update("a", "fixture", &json!({}), |d| {
            if state == "working" { d.agent.status = "working".into(); }
            if state == "approval" { d.pending.push(serde_json::from_value(json!({"id":"approval","agentId":"a","method":"item/commandExecution/requestApproval","params":{},"createdAt":""})).unwrap()); }
            if state == "uncertain" { d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"x","text":"x"},"status":"uncertain","turnId":null,"error":null})).unwrap()); }
        }).unwrap();
        assert!(ws.apply_codex_context("a").await.is_err(), "{state}");
        assert!(calls(&dir, "thread/unsubscribe").is_empty());
        assert!(calls(&dir, "turn/interrupt").is_empty());
    }
}

#[tokio::test]
async fn context_reload_requires_native_idle_and_never_invents_effective_usage() {
    let (dir, ws) = context_fixture().await;
    std::fs::write(dir.path().join("thread.json"), json!({"id":"thread","status":{"type":"active"},"turns":[]}).to_string()).unwrap();
    assert!(ws.apply_codex_context("a").await.is_err());
    assert!(calls(&dir, "thread/unsubscribe").is_empty());
    std::fs::write(dir.path().join("thread.json"), json!({"id":"thread","status":{"type":"idle"},"turns":[]}).to_string()).unwrap();
    std::fs::write(dir.path().join("other-subscriber"), "yes").unwrap();
    let resumes = calls(&dir, "thread/resume").len();
    let response = ws.apply_codex_context("a").await.unwrap();
    assert_eq!(response["settingsSubmitted"], true);
    assert!(response["observedWindowTokens"].is_null());
    assert_eq!(calls(&dir, "thread/resume").len(), resumes + 1);
    assert!(calls(&dir, "thread/start").is_empty());
}

#[tokio::test]
async fn context_capability_failure_does_not_save_and_reload_never_replaces_missing_thread() {
    let (dir, ws) = context_fixture().await;
    std::fs::write(dir.path().join("config.json"), "{}").unwrap();
    assert!(ws.update_settings("a", "test-model".into(), AgentSettings { context_window:Some(872000), ..Default::default() }).await.is_err());
    assert!(ws.store.detail("a").unwrap().agent.settings.context_window.is_none());
    std::fs::write(dir.path().join("missing-rollout"), "yes").unwrap();
    assert!(ws.apply_codex_context("a").await.is_err());
    assert!(calls(&dir, "thread/start").is_empty());
    assert_eq!(ws.store.detail("a").unwrap().agent.thread_id.as_deref(), Some("thread"));
}

#[tokio::test]
async fn saved_context_overrides_can_be_cleared_offline_after_capability_loss() {
    for failure in ["missing", "error"] {
        let (dir, ws) = context_fixture().await;
        let custom = AgentSettings { context_window:Some(872000), auto_compact_token_limit:Some(600000),
            reasoning_effort:Some("high".into()), ..Default::default() };
        ws.update_settings("a", "test-model".into(), custom.clone()).await.unwrap();
        // A healthy local reconnect reuses its transport. Close this idle
        // fixture first so capability loss is exercised on a fresh attach.
        ws.close_agent("a").await.unwrap();
        if failure == "missing" { std::fs::write(dir.path().join("config.json"), "{}").unwrap(); }
        else { std::fs::write(dir.path().join("config-error"), "yes").unwrap(); }
        assert!(ws.reopen_agent("a").await.is_err());
        assert!(ws.agent_catalog("a").await.is_err());
        let automatic = AgentSettings { context_window:None, auto_compact_token_limit:None, ..custom };
        let changed_permissions = AgentSettings { sandbox:"danger-full-access".into(), ..automatic.clone() };
        assert!(ws.update_settings("a", "test-model".into(), changed_permissions).await.is_err(),
            "offline recovery must not bypass validation of permission changes");
        assert!(ws.update_settings("a", "other-model".into(), automatic.clone()).await.is_err());
        let before = std::fs::read(dir.path().join("calls.jsonl")).unwrap();
        let saved = ws.update_settings("a", "test-model".into(), automatic.clone()).await.unwrap();
        assert_eq!(saved.settings, automatic);
        assert_eq!(saved.thread_id.as_deref(), Some("thread"));
        assert_eq!(std::fs::read(dir.path().join("calls.jsonl")).unwrap(), before, "clearing must send no native RPC");
        if failure == "error" { std::fs::remove_file(dir.path().join("config-error")).unwrap(); }
        let restored = ws.reconnect("a").await.unwrap();
        assert_eq!(restored.agent.thread_id.as_deref(), Some("thread"));
        let resume = calls(&dir, "thread/resume").pop().unwrap();
        assert!(resume["params"]["config"].get("model_context_window").is_none());
        assert!(resume["params"]["config"].get("model_auto_compact_token_limit").is_none());
        assert_eq!(resume["params"]["config"]["model_reasoning_effort"], "high");
        assert!(calls(&dir, "thread/start").is_empty());
    }
}

#[tokio::test]
async fn rejected_context_reload_can_edit_settings_and_reconnect_without_replacing_app_server() {
    let (dir, ws) = context_fixture().await;
    let resumes = calls(&dir, "thread/resume").len();
    std::fs::write(dir.path().join("missing-rollout"), "yes").unwrap();
    assert!(ws.apply_codex_context("a").await.is_err());
    assert_eq!(ws.store.detail("a").unwrap().agent.connection_state, "unconfirmed");
    let catalog = ws.agent_catalog("a").await.unwrap();
    assert_eq!(catalog["context"]["settingsSubmitted"], false);
    assert_eq!(catalog["context"]["needsReconnect"], true);
    assert_eq!(catalog["context"]["canApply"], false);
    let settings = AgentSettings { context_window:Some(600000), auto_compact_token_limit:Some(400000),
        reasoning_effort:Some("high".into()), ..Default::default() };
    ws.update_settings("a", "test-model".into(), settings).await.unwrap();
    assert_eq!(calls(&dir, "thread/resume").len(), resumes + 1, "settings edits must not retry rejected config");
    assert!(ws.reconnect("a").await.is_err());
    assert_eq!(calls(&dir, "thread/resume").len(), resumes + 2, "a definite rejection must allow a new attempt");
    std::fs::remove_file(dir.path().join("missing-rollout")).unwrap();
    let restored = ws.reconnect("a").await.unwrap();
    assert_eq!(restored.agent.thread_id.as_deref(), Some("thread"));
    assert_eq!(restored.agent.connection_state, "connected");
    let resume = calls(&dir, "thread/resume").pop().unwrap();
    assert_eq!(resume["params"]["threadId"], "thread");
    assert_eq!(resume["params"]["config"]["model_context_window"], 600000);
    assert_eq!(resume["params"]["config"]["model_auto_compact_token_limit"], 400000);
    assert_eq!(resume["params"]["config"]["model_reasoning_effort"], "high");
    let catalog = ws.agent_catalog("a").await.unwrap();
    assert_eq!(catalog["context"]["needsReconnect"], false);
    assert_eq!(catalog["context"]["settingsSubmitted"], true);
    assert!(catalog["context"]["observedWindowTokens"].is_null());
    assert_eq!(calls(&dir, "initialize").len(), 1, "recovery must keep the app-server alive");
    assert_eq!(calls(&dir, "thread/unsubscribe").len(), 1);
    for method in ["thread/start", "thread/fork", "turn/start", "turn/interrupt"] {
        assert!(calls(&dir, method).is_empty(), "{method}");
    }
    assert_eq!(ws.send_message("a", input("after-recovery", "continue", None)).await.unwrap().status, "accepted");
    assert_eq!(calls(&dir, "turn/start").len(), 1, "recovered thread must actually accept sends");
}

#[tokio::test]
async fn context_reload_keeps_empty_thread_attached_and_cached_usage_unknown_after_restart() {
    let (dir, ws) = fixture().await;
    let catalog = ws.agent_catalog("a").await.unwrap();
    assert_eq!(catalog["context"]["canApply"], false);
    assert_eq!(catalog["context"]["needsFirstTurn"], true);
    assert!(ws.apply_codex_context("a").await.unwrap_err().to_string().contains("首轮"));
    assert!(calls(&dir, "thread/unsubscribe").is_empty());

    let (dir, ws) = context_fixture().await;
    let saved = AgentSettings { context_window:Some(600000), ..Default::default() };
    ws.update_settings("a", "test-model".into(), saved).await.unwrap();
    ws.apply_codex_context("a").await.unwrap();
    ws.close_agent("a").await.unwrap();
    let previous = Arc::downgrade(&ws);
    drop(ws);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while previous.strong_count() != 0 { tokio::task::yield_now().await; }
    }).await.unwrap();
    std::fs::write(dir.path().join("replay-usage"), "yes").unwrap();
    let restarted = Workspace::new(dir.path().join("data"), "/tmp".into(), dir.path().join("native.py").to_string_lossy().into()).unwrap();
    restarted.reopen_agent("a").await.unwrap();
    let catalog = restarted.agent_catalog("a").await.unwrap();
    assert!(catalog["context"]["observedWindowTokens"].is_null());
    assert_eq!(restarted.store.detail("a").unwrap().agent.settings.context_window, Some(600000));
}
