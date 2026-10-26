#![cfg(unix)]
#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::Path, sync::Arc};
use yuzuno_workspace::{codex_sessions::ImportSession, workspace::Workspace};

const THREAD: &str = "01912345-6789-7890-abcd-0123456789ab";
struct Lab { root: tempfile::TempDir, ws: Arc<Workspace> }
impl Lab {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json, os, pathlib, sys, time
root = pathlib.Path(__file__).parent
thread_id = '01912345-6789-7890-abcd-0123456789ab'
def emit(v): print(json.dumps(v), flush=True)
def turns():
    if (root/'history.json').exists(): return json.loads((root/'history.json').read_text())
    count = 0 if (root/'empty').exists() else 12 + (int((root/'extra').read_text() or '1') if (root/'extra').exists() else 0)
    return [{'id':f't-{i}','status':'completed','items':[{'id':f'item-{i}','type':'agentMessage','phase':'final_answer','text':f'Native result {i}'}]} for i in range(count)]
def thread():
    status = {'type':'active','activeFlags':[]} if (root/'active').exists() else {'type':'idle'}
    return {'id':thread_id,'cwd':str(root),'name':'Original native session','preview':'Original task','model':'native-model','reasoningEffort':'ultra','updatedAt':1700000000,'status':status,'historyMode':'paginated'}
for line in sys.stdin:
    req = json.loads(line)
    with (root/'calls.jsonl').open('a') as log: log.write(json.dumps(dict(req,pid=os.getpid()))+'\n')
    if 'id' not in req: continue
    method,p = req['method'],req.get('params',{})
    result = {}
    if method == 'thread/read':
        if (root/'slow').exists(): time.sleep(30)
        if (root/'missing').exists():
            emit({'id':req['id'],'error':{'code':-32600,'message':f'no rollout found for thread id {thread_id}'}}); continue
        result = {'thread':thread()}
        if p.get('includeTurns'): result['thread']['turns'] = turns()
    elif method == 'thread/turns/list':
        if p.get('itemsView') not in ['notLoaded', 'summary', 'full']:
            emit({'id':req['id'],'error':{'code':-32600,'message':'Invalid itemsView enum'}}); continue
        # As Codex 0.162 pages: a cursor names the Turn it continues from.
        rows = turns()[::-1]
        ids = [t['id'] for t in rows]
        start = 0
        if p.get('cursor'):
            anchor = json.loads(p['cursor'])
            if anchor['turn_id'] not in ids:
                emit({'id':req['id'],'error':{'code':-32600,'message':'invalid cursor: anchor turn is no longer present'}}); continue
            start = ids.index(anchor['turn_id']) + (0 if anchor['include_anchor'] else 1)
        rows = rows[start:start+p.get('limit',3)]
        if p.get('itemsView') == 'notLoaded': rows = [dict(t,items=[]) for t in rows]
        end = start+len(rows)
        result = {'data':rows,'nextCursor':json.dumps({'turn_id':rows[-1]['id'],'include_anchor':False}) if rows and end<len(ids) else None,'backwardsCursor':None}
    elif method == 'config/read': result = {'config':{'approval_policy':'never','sandbox_mode':'danger-full-access'}}
    elif method == 'configRequirements/read':
        result = {'requirements':{'allowedSandboxModes':['read-only']} if (root/'restricted').exists() else None}
    elif method == 'thread/resume':
        if (root/'missing').exists():
            emit({'id':req['id'],'error':{'code':-32600,'message':f'no rollout found for thread id {thread_id}'}}); continue
        result = {'thread':thread(),'model':'native-model','reasoningEffort':p.get('config',{}).get('model_reasoning_effort','low')}
        result['thread']['turns'] = [] if p.get('excludeTurns') else turns()
    elif method == 'turn/start':
        result={'turn':{'id':'new-turn','status':'inProgress','items':[]}}
    emit({'id':req['id'],'result':result})
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ws = Workspace::new(root.path().join("data"), root.path().to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
        Self { root, ws }
    }
    fn input(&self) -> ImportSession { ImportSession { thread_id: THREAD.into(), name: "Adopted".into(), permission_preset: "ask".into() } }
    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("calls.jsonl")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
    fn mark(&self, name: &str) { std::fs::write(self.root.path().join(name), "").unwrap(); }
}

#[tokio::test]
async fn preview_import_and_pages_are_read_only_preserve_settings_and_bound_cached_history() {
    let lab = Lab::new();
    let preview = lab.ws.preview_codex_session(THREAD).await.unwrap();
    assert_eq!(preview.turn_count, 12);
    assert_eq!(preview.model.as_deref(), Some("native-model"));
    assert_eq!(preview.reasoning_effort.as_deref(), Some("ultra"));
    assert!(preview.existing_agent_id.is_none());
    assert!(preview.warnings.is_empty());
    assert_eq!(preview.permissions["presets"][1]["id"], "ask");
    assert_eq!(preview.permissions["presets"][1]["available"], true);
    assert!(lab.ws.store.agents().unwrap().is_empty());
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    assert_eq!(agent.status, "offline");
    assert_eq!(agent.connection_state, "disconnected");
    assert_eq!(agent.thread_id.as_deref(), Some(THREAD));
    assert_eq!(agent.cwd, lab.root.path().to_string_lossy());
    assert_eq!(agent.model, "native-model");
    assert_eq!(agent.settings.reasoning_effort.as_deref(), Some("ultra"));
    assert_eq!(agent.settings.permission_preset.as_deref(), Some("ask"));
    assert_eq!(agent.unread_count, 0);
    assert_eq!(agent.pending_count, 0);
    let detail = lab.ws.store.detail(&agent.id).unwrap();
    assert_eq!(detail.turns.len(), 3);
    assert_eq!(detail.turns[0]["id"], "t-9");
    assert_eq!(detail.turns[2]["items"][0]["text"], "Native result 11");
    let history = detail.history.unwrap();
    assert!(history.has_more);
    let page = lab.ws.codex_session_history(&agent.id, history.next_cursor.as_deref()).await.unwrap();
    assert_eq!(page.turns[0]["id"], "t-6");
    assert_eq!(page.turns[2]["id"], "t-8");
    assert_eq!(lab.ws.store.detail(&agent.id).unwrap().turns.len(), 3, "older pages are not persisted into the mutable cache");
    assert!(lab.ws.store.codex_handoff_pending(&agent.id).unwrap());
    assert!(lab.ws.agent_catalog(&agent.id).await.unwrap_err().to_string().contains("尚未接续"));
    assert!(lab.calls().iter().all(|r| !["thread/resume", "thread/start", "turn/start", "turn/steer"].contains(&r["method"].as_str().unwrap_or(""))));
    assert!(lab.calls().iter().filter(|r| r["method"] == "thread/read").all(|r| r["params"]["includeTurns"] == false));
    for pid in lab.calls().iter().filter_map(|r| r["pid"].as_u64()) {
        assert!(!Path::new(&format!("/proc/{pid}")).exists(), "read subprocess must be reaped");
    }
    let db = rusqlite::Connection::open(lab.root.path().join("data/workspace.sqlite")).unwrap();
    let (count, size): (i64,i64) = db.query_row("SELECT count(*),sum(length(data)) FROM journal", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(count,1);
    assert!(size<300,"journal stores provenance, not historical item bodies");
}

#[tokio::test]
async fn explicit_resume_keeps_model_effort_mcp_and_permissions_and_only_new_completions_are_unread() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    lab.ws.start_collaboration(4399);
    lab.ws.reconnect(&agent.id).await.unwrap();
    assert!(!lab.ws.store.codex_handoff_pending(&agent.id).unwrap());
    let detail = lab.ws.store.detail(&agent.id).unwrap();
    assert_eq!(detail.agent.unread_count,0);
    assert_eq!(detail.agent.model,"native-model");
    assert_eq!(detail.agent.settings.reasoning_effort.as_deref(),Some("ultra"));
    let calls=lab.calls();
    let resumed=&calls.iter().find(|r|r["method"]=="thread/resume").unwrap()["params"];
    assert_eq!(resumed["threadId"],THREAD);
    assert_eq!(resumed["excludeTurns"],true);
    assert_eq!(resumed["model"],"native-model");
    assert_eq!(resumed["config"]["model_reasoning_effort"],"ultra");
    assert_eq!(resumed["approvalsReviewer"],"user");
    assert_eq!(resumed["sandbox"],"workspace-write");
    assert!(resumed["config"]["mcp_servers.yuzuno"]["url"].as_str().unwrap().ends_with(&agent.id));
    assert!(!calls.iter().any(|r|r["method"]=="turn/start"||r["method"]=="thread/start"));
    lab.mark("extra");
    lab.ws.reconnect(&agent.id).await.unwrap();
    assert_eq!(lab.ws.store.detail(&agent.id).unwrap().agent.unread_count,1);
    lab.ws.reconnect(&agent.id).await.unwrap();
    assert_eq!(lab.ws.store.detail(&agent.id).unwrap().agent.unread_count,1);
    assert!(lab.calls().iter().filter(|r| r["method"]=="thread/read").all(|r|r["params"]["includeTurns"]==false));
    lab.ws.close_agent(&agent.id).await.unwrap();
}

#[tokio::test]
async fn imported_membership_survives_duplicate_import_resume_and_updates() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    assert!(agent.project_id.is_none());
    let project = lab.ws.store.create_project("Development", Default::default()).unwrap();
    lab.ws.store.set_agent_project(&agent.id, Some(&project.id)).unwrap();
    let duplicate = lab.ws.import_codex_session(lab.input()).await.unwrap();
    assert_eq!(duplicate.id, agent.id);
    assert_eq!(duplicate.project_id.as_deref(), Some(project.id.as_str()));
    lab.ws.reconnect(&agent.id).await.unwrap();
    assert_eq!(lab.ws.store.detail(&agent.id).unwrap().agent.project_id.as_deref(), Some(project.id.as_str()));
    let closed = lab.ws.close_agent(&agent.id).await.unwrap();
    assert_eq!(closed.agent.project_id.as_deref(), Some(project.id.as_str()));
    let db = rusqlite::Connection::open(lab.root.path().join("data/workspace.sqlite")).unwrap();
    let raw: String = db.query_row("SELECT data FROM agents WHERE id=?1", [&agent.id], |r| r.get(0)).unwrap();
    let raw: Value = serde_json::from_str(&raw).unwrap();
    assert!(raw["agent"].get("projectId").is_none(), "membership remains outside native session records");
    assert_eq!(lab.ws.store.agents().unwrap().len(), 1);
}

#[tokio::test]
async fn invalid_failed_repeated_closed_and_parallel_imports_never_leave_duplicate_agents() {
    let lab=Lab::new();
    assert!(lab.ws.preview_codex_session("/tmp/a; touch bad").await.is_err());
    assert!(lab.calls().is_empty());
    lab.mark("restricted");
    let preview=lab.ws.preview_codex_session(THREAD).await.unwrap();
    assert_eq!(preview.permissions["presets"][1]["available"],false);
    assert!(lab.ws.import_codex_session(lab.input()).await.is_err());
    assert!(lab.ws.store.agents().unwrap().is_empty());
    std::fs::remove_file(lab.root.path().join("restricted")).unwrap();
    let (a,b)=tokio::join!(lab.ws.import_codex_session(lab.input()),lab.ws.import_codex_session(lab.input()));
    assert!(a.is_ok()||b.is_ok());
    let agent=a.or(b).unwrap();
    assert_eq!(lab.ws.store.agents().unwrap().len(),1);
    assert_eq!(lab.ws.import_codex_session(lab.input()).await.unwrap().id,agent.id);
    lab.ws.close_agent(&agent.id).await.unwrap();
    assert!(lab.ws.import_codex_session(lab.input()).await.unwrap().closed_at.is_some());
    assert_eq!(lab.ws.preview_codex_session(THREAD).await.unwrap().existing_agent_id.as_deref(),Some(agent.id.as_str()));
    assert_eq!(lab.ws.store.agents().unwrap().len(),1);
}

#[tokio::test]
async fn missing_original_rollout_never_creates_a_replacement_and_cancelled_reads_reap_the_child() {
    let lab=Lab::new();
    let agent=lab.ws.import_codex_session(lab.input()).await.unwrap();
    lab.mark("missing");
    assert!(lab.ws.reconnect(&agent.id).await.is_err());
    assert_eq!(lab.ws.store.detail(&agent.id).unwrap().agent.thread_id.as_deref(),Some(THREAD));
    assert!(!lab.calls().iter().any(|r|r["method"]=="thread/start"));
    assert!(!lab.ws.store.begin_empty_thread_replacement(&agent.id,THREAD).unwrap());
    lab.mark("slow");
    let before = lab.calls().len();
    let ws=lab.ws.clone();
    let task=tokio::spawn(async move{ws.preview_codex_session(THREAD).await});
    let pid=tokio::time::timeout(std::time::Duration::from_secs(3),async{
        loop{
            let calls=lab.calls();
            if let Some(r)=calls.last().filter(|r|calls.len()>before && r["method"]=="thread/read") { break r["pid"].as_u64().unwrap(); }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    task.abort();let _=task.await;
    tokio::time::timeout(std::time::Duration::from_secs(3),async{
        while Path::new(&format!("/proc/{pid}")).exists(){tokio::time::sleep(std::time::Duration::from_millis(10)).await;}
    }).await.unwrap();
}

#[tokio::test]
async fn history_cursor_tracks_new_tail_and_queued_messages_cannot_claim_handoff() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    lab.ws.start_collaboration(4399);
    // Even urgent peer delivery may not activate a newly adopted session.
    lab.ws.collaboration_call(None, "peer_send", json!({
        "requestId":"mail", "toAgentId":agent.id, "body":"urgent task", "priority":"urgent"
    })).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(lab.ws.store.codex_handoff_pending(&agent.id).unwrap());
    assert!(!lab.calls().iter().any(|r| r["method"]=="thread/resume"||r["method"]=="turn/start"));
    let db=rusqlite::Connection::open(lab.root.path().join("data/workspace.sqlite")).unwrap();
    db.execute("DELETE FROM collaboration_messages",[]).unwrap();
    // Another source client added more than one full page before handoff.
    std::fs::write(lab.root.path().join("extra"), "5").unwrap();
    lab.ws.reconnect(&agent.id).await.unwrap();
    let detail=lab.ws.store.detail(&agent.id).unwrap();
    let page=lab.ws.codex_session_history(&agent.id,detail.history.as_ref().unwrap().next_cursor.as_deref()).await.unwrap();
    assert!(page.turns.iter().any(|t|t["id"]=="t-13"), "Turn between the old and new cache remains reachable");
    lab.ws.close_agent(&agent.id).await.unwrap();
}

#[tokio::test]
async fn earlier_native_pages_skip_the_turns_saved_while_the_session_ran() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    let turn = |i: usize| json!({"id":format!("t-{i}"),"status":"completed","items":[
        {"id":format!("item-{i}"),"type":"agentMessage","phase":"final_answer","text":format!("Native result {i}")}]});
    // Yuzuno saved six live Turns as they ran; the reconnect after them points
    // the cursor behind the recent page, t-15..t-17.
    std::fs::write(lab.root.path().join("extra"), "6").unwrap();
    lab.ws.store.update(&agent.id, "test/live", &json!({}), |d| d.turns.extend((12..18).map(turn))).unwrap();
    lab.ws.reconnect(&agent.id).await.unwrap();
    let cursor = lab.ws.store.detail(&agent.id).unwrap().history.unwrap().next_cursor;
    let before = lab.calls().len();
    let page = lab.ws.codex_session_history(&agent.id, cursor.as_deref()).await.unwrap();
    // Not t-12..t-14 or t-9..t-11, which the conversation already shows.
    assert_eq!(page.turns.iter().map(|t| t["id"].as_str().unwrap()).collect::<Vec<_>>(), ["t-6", "t-7", "t-8"]);
    assert!(page.has_more);
    let reads: Vec<Value> = lab.calls()[before..].iter().filter(|r| r["method"] == "thread/turns/list")
        .map(|r| r["params"]["itemsView"].clone()).collect();
    assert_eq!(reads, ["full", "notLoaded", "full"], "saved Turns are skipped by ID, without their Items");
    // With every earlier Turn saved, the page says so instead of repeating them.
    lab.ws.store.update(&agent.id, "test/all", &json!({}), |d| { d.turns.splice(0..0, (0..9).map(turn)); }).unwrap();
    let page = lab.ws.codex_session_history(&agent.id, cursor.as_deref()).await.unwrap();
    assert!(page.turns.is_empty() && !page.has_more && page.next_cursor.is_none());
    lab.ws.close_agent(&agent.id).await.unwrap();
}

#[tokio::test]
async fn cached_unfinished_turn_outside_recent_page_gets_its_native_result() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    lab.ws.store.update(&agent.id,"test/offline",&json!({}),|d| {
        d.turns[2]["status"]="inProgress".into();
        d.turns[2]["items"][0]["text"]="partial answer".into();
    }).unwrap();
    std::fs::write(lab.root.path().join("extra"),"7").unwrap();
    let resumed=lab.ws.reconnect(&agent.id).await.unwrap();
    assert_eq!(resumed.agent.status,"idle");
    let recovered=resumed.turns.iter().find(|t|t["id"]=="t-11").unwrap();
    assert_eq!(recovered["status"],"completed");
    assert_eq!(recovered["items"][0]["text"],"Native result 11");
    let latest=resumed.turns.last().unwrap();
    assert_eq!(latest["id"],"t-18");
    lab.ws.close_agent(&agent.id).await.unwrap();
}

#[tokio::test]
async fn imported_empty_session_is_never_replaced_when_its_rollout_disappears() {
    let lab=Lab::new();
    lab.mark("empty");
    let agent=lab.ws.import_codex_session(lab.input()).await.unwrap();
    assert!(lab.ws.store.detail(&agent.id).unwrap().turns.is_empty());
    lab.mark("missing");
    assert!(lab.ws.reconnect(&agent.id).await.is_err());
    assert!(!lab.ws.store.begin_empty_thread_replacement(&agent.id,THREAD).unwrap());
    assert!(!lab.calls().iter().any(|r|r["method"]=="thread/start"));
}


#[tokio::test]
async fn imported_question_provenance_is_read_only_and_excludes_new_turns() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    let question = json!({"id":"q","type":"agentMessage","delivery":"async","questions":[{"title":"Old question"}]});
    lab.ws.store.update(&agent.id, "test/questions", &json!({}), |detail| {
        detail.turns[0]["items"] = json!([question]);
        detail.turns.push(json!({"id":"new-after-import","status":"completed","items":[question],"_yuzunoImportedQuestions":true}));
    }).unwrap();
    let before = lab.ws.store.detail(&agent.id).unwrap();
    let shown = lab.ws.store.client_detail(&agent.id).unwrap();
    assert_eq!(shown.turns[0]["_yuzunoImportedQuestions"], true);
    assert!(shown.turns.last().unwrap().get("_yuzunoImportedQuestions").is_none());
    assert!(shown.turns[1].get("_yuzunoImportedQuestions").is_none());
    assert!(before.turns[0].get("_yuzunoImportedQuestions").is_none());
    let after = lab.ws.store.detail(&agent.id).unwrap();
    assert_eq!(serde_json::to_value(before).unwrap(), serde_json::to_value(after).unwrap());
    assert!(shown.pending.is_empty());
    assert_eq!(shown.agent.reviewed_seq, 0);
    assert_eq!(lab.calls().iter().filter(|call| call["method"] == "thread/turns/list").count(), 2);
}

#[tokio::test]
async fn pasted_receipt_identity_survives_core_restart_reconnect_and_full_native_pages() {
    let Lab { root, ws } = Lab::new();
    let agent = ws.import_codex_session(ImportSession { thread_id:THREAD.into(),name:"Paste history".into(),permission_preset:"ask".into() }).await.unwrap();
    let body = "👨‍👩‍👧‍👦e\u{301}中文\r\n".repeat(12);
    let text = format!("before {body} between {body} after\r\n");
    let len = body.encode_utf16().count();
    let blocks = json!([{"id":"one","start":7,"end":7+len},{"id":"two","start":16+len,"end":16+len*2}]);
    let mut history: Vec<Value> = (0..12).map(|i| json!({"id":format!("t-{i}"),"status":"completed","items":[
        {"id":format!("item-{i}"),"type":"agentMessage","text":format!("Native result {i}")}
    ]})).collect();
    for index in [8,11] {
        let tid = format!("t-{index}");
        let items: Vec<Value> = (0..2).map(|n|json!({"id":format!("live-{tid}-{n}"),"clientId":format!("client-{tid}-{n}"),
            "type":"userMessage","content":[{"type":"text","text":text}]})).collect();
        ws.store.update(&agent.id,"test/liveReceipt",&json!({}),|d|{
            d.turns.retain(|t| t["id"] != tid);
            d.turns.push(json!({"id":tid,"status":"completed","items":items}));
            for n in 0..2 {
                d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":format!("client-{tid}-{n}"),"text":text,
                    "textBlocks":if n==0 {blocks.clone()} else {json!([])}},"status":"sending"})).unwrap());
            }
            d.confirm_message_receipts();
        }).unwrap();
        history[index]["items"] = items.into_iter().enumerate().map(|(n,mut item)|{
            item.as_object_mut().unwrap().remove("clientId"); item["id"]=format!("item-{}",n+1).into(); item
        }).collect::<Vec<_>>().into();
    }
    ws.store.update(&agent.id,"test/window",&json!({}),|d|d.turns.retain(|t|t["id"] != "t-8")).unwrap();
    std::fs::write(root.path().join("history.json"),serde_json::to_vec(&history).unwrap()).unwrap();
    drop(ws);
    let ws = Workspace::new(root.path().join("data"),root.path().to_string_lossy().into(),root.path().join("native.py").to_string_lossy().into()).unwrap();
    ws.start_collaboration(4399);
    ws.reconnect(&agent.id).await.unwrap();
    let current = ws.store.detail(&agent.id).unwrap();
    let recent = current.turns.iter().find(|t|t["id"]=="t-11").unwrap();
    assert_eq!(recent["items"][0]["id"],"live-t-11-0");
    assert_eq!(recent["items"][0]["_yuzunoTextBlocks"],blocks);
    let seq=current.agent.last_seq;
    let page = ws.codex_session_history(&agent.id,Some(&json!({"turn_id":"t-9","include_anchor":false}).to_string())).await.unwrap();
    let older = page.turns.iter().find(|t|t["id"]=="t-8").unwrap();
    assert_eq!(older["items"][0]["id"],"live-t-8-0");
    assert_eq!(older["items"][0]["_yuzunoTextBlocks"],blocks);
    assert_eq!(older["items"][1]["_yuzunoTextBlocks"],json!([]));
    assert_eq!(older["items"][0]["content"][0]["text"],text);
    let after=ws.store.detail(&agent.id).unwrap();
    assert_eq!(after.agent.last_seq,seq,"history projection stays read-only");
    assert!(after.turns.iter().all(|t|t["id"]!="t-8"));
    ws.close_agent(&agent.id).await.unwrap();
}

/// T-198: a power cut left Core holding an unfinished Turn the native
/// history never got. Reconnecting can't confirm it and says so; only the
/// user's explicit end makes that Turn interrupted with its result unknown,
/// after which the same Agent and session go on, nothing sent again.
#[tokio::test]
async fn a_turn_missing_from_native_history_is_ended_only_by_the_user_and_the_session_goes_on() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    lab.ws.start_collaboration(4399);
    let lost = json!({"id":"lost-turn","status":"inProgress","items":[
        {"id":"lost-user","type":"userMessage","content":[{"type":"text","text":"the input before the power cut"}]},
        {"id":"lost-tool","type":"commandExecution","command":"make","status":"inProgress"}]});
    lab.ws.store.update(&agent.id, "test/powerCut", &json!({}), move |d| d.turns.push(lost)).unwrap();

    // Reconnecting can't confirm it, says so, and keeps what it found.
    let error = lab.ws.reconnect(&agent.id).await.unwrap_err().to_string();
    assert!(error.contains("原生历史未包含"), "{error}");
    let d = lab.ws.store.detail(&agent.id).unwrap();
    let found = d.codex_handoff.as_ref().and_then(|h| h.missing_turns.clone()).expect("the finding is kept");
    assert_eq!((found.turn_ids.clone(), found.native_status.as_str(), found.thread_id.as_str()),
        (vec!["lost-turn".to_owned()], "idle", THREAD));
    assert_eq!(d.turns.iter().find(|t| t["id"] == "lost-turn").unwrap()["status"], "inProgress", "nothing ends it by itself");
    assert_ne!(d.agent.connection_state, "connected");
    // Checking again finds the same, on its own connection.
    let _ = lab.ws.reconnect(&agent.id).await.unwrap_err();
    let found = lab.ws.store.detail(&agent.id).unwrap().codex_handoff.unwrap().missing_turns.unwrap();

    // Misuse is refused and changes nothing: other Turns, an earlier connection.
    assert!(lab.ws.end_missing_native_turns(&agent.id, &["t-3".into()], found.generation).await.is_err());
    assert!(lab.ws.end_missing_native_turns(&agent.id, &["lost-turn".into()], found.generation - 1).await.is_err());
    let before = lab.ws.store.detail(&agent.id).unwrap();
    assert_eq!(before.turns.iter().find(|t| t["id"] == "lost-turn").unwrap()["status"], "inProgress");

    // The user's end: only that Turn, interrupted with its result unknown.
    let ended = lab.ws.end_missing_native_turns(&agent.id, &["lost-turn".into()], found.generation).await.unwrap();
    assert_eq!((ended.connection_state.as_str(), ended.status.as_str()), ("disconnected", "offline"));
    assert_eq!(ended.thread_id.as_deref(), Some(THREAD), "the same session");
    let seq = lab.ws.store.detail(&agent.id).unwrap().agent.last_seq;
    lab.ws.end_missing_native_turns(&agent.id, &["lost-turn".into()], found.generation).await.unwrap();
    let after = lab.ws.store.detail(&agent.id).unwrap();
    assert_eq!(after.agent.last_seq, seq, "ending it again writes nothing");
    let turn = after.turns.iter().find(|t| t["id"] == "lost-turn").unwrap();
    assert_eq!(turn["status"], "interrupted");
    assert!(turn["missingNative"]["endedAt"].is_string() && turn["missingNative"]["checkedAt"].is_string(), "{turn}");
    let was = before.turns.iter().find(|t| t["id"] == "lost-turn").unwrap();
    assert_eq!(turn["items"], was["items"], "what it recorded stays: a tool it ran is not called not run");
    for other in before.turns.iter().filter(|t| t["id"] != "lost-turn") {
        assert!(after.turns.iter().any(|t| t == other), "every other Turn stays as it was");
    }
    assert!(after.codex_handoff.as_ref().unwrap().missing_turns.is_none());
    assert_eq!(serde_json::to_value(&after.agent.settings).unwrap(), serde_json::to_value(&before.agent.settings).unwrap(), "permissions and settings stay");

    // The same Agent and session go on; only the new message is sent.
    lab.ws.reconnect(&agent.id).await.unwrap();
    assert_eq!(lab.ws.store.agent(&agent.id).unwrap().connection_state, "connected");
    lab.ws.send(&agent.id, "the next message".into()).await.unwrap();
    let starts: Vec<Value> = lab.calls().into_iter().filter(|r| r["method"] == "turn/start").collect();
    assert_eq!(starts.len(), 1, "one new Turn, nothing replayed");
    assert_eq!(starts[0]["params"]["threadId"], THREAD);
    let sent = serde_json::to_string(&starts[0]["params"]).unwrap();
    assert!(sent.contains("the next message") && !sent.contains("the input before the power cut"));
    assert!(!lab.calls().iter().any(|r| matches!(r["method"].as_str(), Some("thread/fork" | "thread/start" | "turn/steer"))));
    let kept = lab.ws.store.detail(&agent.id).unwrap();
    assert_eq!(kept.turns.iter().find(|t| t["id"] == "lost-turn").unwrap()["status"], "interrupted", "the ended Turn is kept");
    // The fixture's new Turn never finishes, so the Agent is left open: closing
    // it would wait for an interrupt Codex never confirms.
}

/// T-198: while Codex says the session is running a Turn, or when a check
/// failed for another reason, the local record is not ended.
#[tokio::test]
async fn a_missing_turn_is_not_ended_while_codex_runs_one_or_when_the_check_failed_otherwise() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    lab.ws.store.update(&agent.id, "test/powerCut", &json!({}), |d|
        d.turns.push(json!({"id":"lost-turn","status":"inProgress","items":[]}))).unwrap();
    lab.mark("active");
    assert!(lab.ws.reconnect(&agent.id).await.is_err());
    let found = lab.ws.store.detail(&agent.id).unwrap().codex_handoff.unwrap().missing_turns.unwrap();
    assert_eq!(found.native_status, "active");
    let refused = lab.ws.end_missing_native_turns(&agent.id, &["lost-turn".into()], found.generation).await.unwrap_err();
    assert!(refused.to_string().contains("正在运行"), "{refused}");
    assert_eq!(lab.ws.store.detail(&agent.id).unwrap().turns.iter().find(|t| t["id"] == "lost-turn").unwrap()["status"], "inProgress");

    // Another Agent whose check failed for another reason (its rollout is gone): no finding, no end.
    let other = Lab::new();
    let agent = other.ws.import_codex_session(other.input()).await.unwrap();
    other.ws.store.update(&agent.id, "test/powerCut", &json!({}), |d|
        d.turns.push(json!({"id":"lost-turn","status":"inProgress","items":[]}))).unwrap();
    other.mark("missing");
    assert!(other.ws.reconnect(&agent.id).await.is_err());
    assert!(other.ws.store.detail(&agent.id).unwrap().codex_handoff.and_then(|h| h.missing_turns).is_none());
    assert!(other.ws.end_missing_native_turns(&agent.id, &["lost-turn".into()], 1).await.is_err());
    assert_eq!(other.ws.store.detail(&agent.id).unwrap().turns.iter().find(|t| t["id"] == "lost-turn").unwrap()["status"], "inProgress");
}

/// A reconnect whose newest native Turns the record holds, each ended as it
/// ended natively, reads that page without Items and changes nothing; one
/// with a Turn the record lacks reads the page whole and adds it (T-140).
#[tokio::test]
async fn a_reconnect_reads_the_newest_page_whole_only_when_the_record_lacks_it() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(lab.input()).await.unwrap();
    let reads = |from: usize| -> Vec<Value> { lab.calls()[from..].iter().filter(|r| r["method"] == "thread/turns/list")
        .map(|r| r["params"]["itemsView"].clone()).collect() };
    let ids = |detail: &yuzuno_workspace::model::AgentDetail| -> Vec<String> {
        detail.turns.iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect() };
    let held = lab.ws.store.detail(&agent.id).unwrap();
    let before = lab.calls().len();
    lab.ws.reconnect(&agent.id).await.unwrap();
    let light = reads(before);
    assert!(!light.is_empty() && light.iter().all(|view| view == "notLoaded"), "{light:?}");
    let detail = lab.ws.store.detail(&agent.id).unwrap();
    assert_eq!(ids(&detail), ["t-9", "t-10", "t-11"]);
    assert_eq!(detail.turns, held.turns);
    // Another client ran a Turn meanwhile.
    std::fs::write(lab.root.path().join("extra"), "1").unwrap();
    let before = lab.calls().len();
    lab.ws.reconnect(&agent.id).await.unwrap();
    assert!(reads(before).iter().any(|view| view == "full"));
    let detail = lab.ws.store.detail(&agent.id).unwrap();
    assert_eq!(ids(&detail), ["t-9", "t-10", "t-11", "t-12"]);
    assert_eq!(detail.turns[3]["items"][0]["text"], "Native result 12");
    lab.ws.close_agent(&agent.id).await.unwrap();
}
