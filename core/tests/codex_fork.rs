#![cfg(unix)]
//! Explicit native fork after another client's writer refuses a resume.
use serde_json::Value;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, sync::Arc};
use yuzuno_workspace::{
    codex_sessions::{ForkSession, ImportSession},
    workspace::Workspace,
};

const SOURCE: &str = "01912345-6789-7890-abcd-0123456789ab";

struct Lab { root: tempfile::TempDir, ws: Arc<Workspace> }

impl Lab {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("native.py");
        std::fs::write(&script, r#"#!/usr/bin/python3
import json, os, pathlib, sys, time, uuid
root = pathlib.Path(__file__).parent
source = '01912345-6789-7890-abcd-0123456789ab'
forks_file = root/'forks.json'
def emit(v): print(json.dumps(v), flush=True)
def forks(): return json.loads(forks_file.read_text()) if forks_file.exists() else {}
def source_turns():
    statuses = json.loads((root/'statuses.json').read_text()) if (root/'statuses.json').exists() else {}
    rows = [{'id':f't-{i}','status':statuses.get(f't-{i}','completed'),'completedAt':1700000000+i,'items':[{'id':f'item-{i}','type':'agentMessage','phase':'final_answer','text':f'Native result {i}'}]} for i in range(12)]
    if (root/'image-message.json').exists(): rows[-1]['items'].insert(0, json.loads((root/'image-message.json').read_text()))
    if (root/'running').exists(): rows.append({'id':'t-12','status':'inProgress','items':[]})
    return rows
def turns(thread_id):
    if thread_id == source: return source_turns()
    fork = forks()[thread_id]
    rows = source_turns()
    rows = rows[:[t['id'] for t in rows].index(fork['last'])+1]
    if fork.get('mismatch'): rows = rows[1:]
    return rows
def thread(thread_id):
    meta = {'id':thread_id,'cwd':str(root),'name':'Original native session','preview':'Original task','model':'native-model',
            'reasoningEffort':'ultra','updatedAt':1700000000,'createdAt':1700000000,'status':{'type':'idle'},'forkedFromId':None}
    if thread_id != source: meta.update(forkedFromId=source, createdAt=forks()[thread_id]['created'])
    return meta
for line in sys.stdin:
    req = json.loads(line)
    with (root/'calls.jsonl').open('a') as log: log.write(json.dumps(dict(req,pid=os.getpid()))+'\n')
    if 'id' not in req: continue
    method,p = req['method'],req.get('params',{})
    result = {}
    tid = p.get('threadId')
    if method == 'thread/read':
        if tid != source and (root/'fork_unreadable').exists():
            emit({'id':req['id'],'error':{'code':-32603,'message':'native read failed'}}); continue
        if tid != source and tid not in forks():
            emit({'id':req['id'],'error':{'code':-32600,'message':f'no rollout found for thread id {tid}'}}); continue
        result = {'thread':thread(tid)}
    elif method == 'thread/turns/list':
        rows = turns(tid)[::-1]
        cursor = int(p.get('cursor') or 0)
        rows = rows[cursor:cursor+p.get('limit',3)]
        if p.get('itemsView') == 'notLoaded': rows = [dict(t,items=[]) for t in rows]
        end = cursor+len(rows)
        result = {'data':rows,'nextCursor':str(end) if end<len(turns(tid)) else None,'backwardsCursor':None}
    elif method == 'thread/list':
        rows = [thread(t) for t in forks()] + [thread(source)]
        rows.sort(key=lambda t: t['createdAt'], reverse=True)
        result = {'data':[r for r in rows if r['cwd'] == p.get('cwd')],'nextCursor':None}
    elif method == 'thread/fork':
        if (root/'fork_reject').exists():
            emit({'id':req['id'],'error':{'code':-32600,'message':'fork refused by native test'}}); continue
        if p.get('lastTurnId') not in [t['id'] for t in source_turns() if t['status'] == 'completed']:
            emit({'id':req['id'],'error':{'code':-32600,'message':'last turn must be a completed turn'}}); continue
        fork_id = str(uuid.uuid4())
        all_forks = forks()
        all_forks[fork_id] = {'last':p['lastTurnId'],'created':int(time.time()),'mismatch':(root/'fork_mismatch').exists()}
        forks_file.write_text(json.dumps(all_forks))
        if (root/'fork_crash').exists(): sys.exit(1)
        result = {'thread':dict(thread(fork_id),turns=[]),'model':p.get('model'),
                  'reasoningEffort':(p.get('config') or {}).get('model_reasoning_effort')}
    elif method == 'config/read': result = {'config':{'approval_policy':'never','sandbox_mode':'danger-full-access'}}
    elif method == 'configRequirements/read': result = {'requirements':None}
    elif method == 'thread/resume':
        if tid == source and (root/'writer').exists():
            emit({'id':req['id'],'error':{'code':-32600,'message':f'thread {source} already has an active writer'}}); continue
        result = {'thread':dict(thread(tid),turns=[]),'model':p.get('model'),
                  'reasoningEffort':(p.get('config') or {}).get('model_reasoning_effort')}
    elif method == 'turn/start':
        result = {'turn':{'id':'new-turn','status':'inProgress','items':[]}}
    emit({'id':req['id'],'result':result})
"#).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ws = Workspace::new(root.path().join("data"), root.path().to_string_lossy().into(), script.to_string_lossy().into()).unwrap();
        Self { root, ws }
    }
    fn mark(&self, name: &str) { std::fs::write(self.root.path().join(name), "").unwrap(); }
    /// Native statuses other than completed, by Turn ID.
    fn statuses(&self, statuses: Value) { std::fs::write(self.root.path().join("statuses.json"), statuses.to_string()).unwrap(); }
    fn clear(&self, name: &str) { let _ = std::fs::remove_file(self.root.path().join(name)); }
    fn calls(&self, method: &str) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("calls.jsonl")).unwrap_or_default().lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap()).filter(|c| c["method"] == method).collect()
    }
    /// An imported source whose resume was refused by another client's writer.
    async fn conflicted_source(&self) -> String {
        let agent = self.ws.import_codex_session(ImportSession {
            thread_id: SOURCE.into(), name: "Adopted".into(), permission_preset: "auto".into(),
        }).await.unwrap();
        let project = self.ws.store.create_project("Night work", BTreeMap::new()).unwrap();
        self.ws.store.set_agent_project(&agent.id, Some(&project.id)).unwrap();
        self.mark("writer");
        let error = self.ws.reconnect(&agent.id).await.unwrap_err();
        assert!(error.to_string().contains("already has an active writer"));
        agent.id
    }
    fn fork(&self, request: &str) -> ForkSession {
        ForkSession { request_id: request.into(), through_turn_id: "t-11".into(), name: "Adopted".into(), abandon_unconfirmed: false }
    }
}

const REQUEST: &str = "5f0e2c1a-0000-4000-8000-000000000001";
const OTHER_REQUEST: &str = "5f0e2c1a-0000-4000-8000-000000000002";
const THIRD_REQUEST: &str = "5f0e2c1a-0000-4000-8000-000000000003";

#[tokio::test]
async fn fork_inherits_original_image_ownership_and_both_preview_routes_remain_readable() {
    use axum::{body::{Body, to_bytes}, http::Request};
    use tower::ServiceExt;
    let lab = Lab::new();
    let source = lab.conflicted_source().await;
    let router = yuzuno_workspace::server::router(lab.ws.clone(), lab.root.path().join("web"));
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(640, 360, image::Rgb([200, 30, 10]))
        .write_to(&mut png, image::ImageFormat::Png).unwrap();
    let response = router.clone().oneshot(Request::builder().method("POST")
        .uri(format!("/api/agents/{source}/images"))
        .header("host", "127.0.0.1:4317").header("x-yuzuno-client", "desktop")
        .body(Body::from(png.get_ref().clone())).unwrap()).await.unwrap();
    assert_eq!(response.status(), 200);
    let uploaded: Value = serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let image_id = uploaded["id"].as_str().unwrap();
    // The fixture stores exactly the localImage input used by real sends in a
    // completed native user message. Fork history verification must preserve it.
    let content = yuzuno_workspace::input_images::native_input(
        &lab.ws.data_dir, &source, "", &[image_id.into()]).unwrap();
    let message = serde_json::json!({"id":"image-user","type":"userMessage","content":content});
    std::fs::write(lab.root.path().join("image-message.json"), message.to_string()).unwrap();
    let outcome = lab.ws.fork_codex_session(&source, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(outcome.state, "completed", "{:?}", outcome.message);
    let fork = outcome.agent.unwrap();
    let detail = lab.ws.store.detail(&fork.id).unwrap();
    let inherited = detail.turns.iter().flat_map(|t| t["items"].as_array().unwrap())
        .find(|i| i["id"] == "image-user").unwrap();
    assert_eq!(inherited, &message);
    assert!(!lab.ws.data_dir.join("input-images").join(&fork.id).exists());
    let native_path = std::path::Path::new(inherited["content"][0]["path"].as_str().unwrap());
    let owner = native_path.parent().unwrap().file_name().unwrap().to_str().unwrap();
    assert_eq!(owner, source);
    for thumb in [false, true] {
        let uri = format!("/api/agents/{owner}/images/{image_id}?thumb={thumb}");
        let response = router.clone().oneshot(Request::builder().uri(uri)
            .header("host", "127.0.0.1:4317").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "image/png");
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), if thumb { 320 } else { 640 });
        if !thumb { assert_eq!(bytes.as_ref(), png.get_ref()); }
    }
    // Ownership is not an arbitrary filesystem path or an unregistered owner.
    let response = router.oneshot(Request::builder()
        .uri(format!("/api/agents/missing-owner/images/{image_id}"))
        .header("host", "127.0.0.1:4317").body(Body::empty()).unwrap()).await.unwrap();
    assert!(!response.status().is_success());
}

#[tokio::test]
async fn writer_conflict_is_recorded_and_cleared_by_a_successful_attach() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    let detail = lab.ws.store.detail(&id).unwrap();
    assert!(detail.codex_handoff.as_ref().unwrap().writer_conflict_at.is_some());
    assert_eq!(detail.agent.connection_state, "disconnected");
    lab.clear("writer");
    lab.ws.reconnect(&id).await.unwrap();
    let detail = lab.ws.store.detail(&id).unwrap();
    assert!(detail.codex_handoff.unwrap().writer_conflict_at.is_none());
    // Without a recorded conflict there is nothing to offer.
    assert!(lab.ws.preview_codex_fork(&id).await.is_err());
}

#[tokio::test]
async fn preview_reads_only_and_stops_at_the_latest_completed_turn() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    lab.mark("running");
    let preview = lab.ws.preview_codex_fork(&id).await.unwrap();
    assert_eq!(preview.through_turn_id.as_deref(), Some("t-11"));
    assert_eq!(preview.through_completed_at, Some(1700000011));
    assert_eq!((preview.included_turns, preview.excluded_turns), (12, 1));
    assert_eq!(preview.model, "native-model");
    assert_eq!(preview.reasoning_effort.as_deref(), Some("ultra"));
    assert_eq!(preview.permission_preset.as_deref(), Some("auto"));
    assert!(preview.project_id.is_some());
    assert!(lab.calls("thread/fork").is_empty());
}

#[tokio::test]
async fn the_boundary_is_the_latest_completed_turn_and_keeps_the_earlier_history() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    // An older interrupted Turn, then a completed one, then an interrupted and a running one.
    lab.statuses(serde_json::json!({"t-5":"interrupted","t-11":"interrupted"}));
    lab.mark("running");
    let preview = lab.ws.preview_codex_fork(&id).await.unwrap();
    assert_eq!(preview.through_turn_id.as_deref(), Some("t-10"));
    assert_eq!(preview.through_completed_at, Some(1700000010));
    assert_eq!((preview.included_turns, preview.excluded_turns), (11, 2));

    // An interrupted Turn is never a boundary, even when asked for directly.
    let refused = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(refused.state, "failed");
    assert!(refused.message.unwrap().contains("不是原会话中已完成的 Turn"));
    assert!(lab.calls("thread/fork").is_empty());

    let at_boundary = ForkSession { through_turn_id: "t-10".into(), ..lab.fork(OTHER_REQUEST) };
    let outcome = lab.ws.fork_codex_session(&id, at_boundary).await.unwrap();
    assert_eq!(outcome.state, "completed", "{:?}", outcome.message);
    assert_eq!(lab.calls("thread/fork")[0]["params"]["lastTurnId"], "t-10");
    // The copy is the whole prefix, the older interrupted Turn included.
    let fork = lab.ws.store.detail(&outcome.agent.unwrap().id).unwrap();
    let from = fork.codex_handoff.unwrap().forked_from.unwrap();
    assert_eq!((from.through_turn_id.as_str(), from.turn_count), ("t-10", 11));
    assert_eq!(lab.ws.store.detail(&id).unwrap().codex_handoff.unwrap().forked_to.unwrap().turn_count, 11);
}

#[tokio::test]
async fn explicit_fork_keeps_history_and_settings_and_continues_without_a_prompt() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    lab.mark("running");
    let outcome = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(outcome.state, "completed", "{:?}", outcome.message);
    assert!(outcome.connected);
    let fork = outcome.agent.unwrap();
    assert_ne!(fork.id, id);
    assert_ne!(fork.thread_id.as_deref(), Some(SOURCE));
    assert_eq!((fork.name.as_str(), fork.model.as_str()), ("Adopted", "native-model"));
    assert_eq!(fork.settings.reasoning_effort.as_deref(), Some("ultra"));
    assert_eq!(fork.settings.permission_preset.as_deref(), Some("auto"));
    assert_eq!(lab.ws.store.agent_project(&fork.id).unwrap(), lab.ws.store.agent_project(&id).unwrap());

    let call = &lab.calls("thread/fork")[0]["params"];
    assert_eq!((call["threadId"].as_str(), call["lastTurnId"].as_str()), (Some(SOURCE), Some("t-11")));
    assert_eq!(call["model"], "native-model");
    assert_eq!(call["config"]["model_reasoning_effort"], "ultra");
    assert!(call["approvalPolicy"].is_string() && call["sandbox"].is_string());
    // Continuing never replays text or starts a Turn by itself.
    assert!(lab.calls("turn/start").is_empty());

    let detail = lab.ws.store.detail(&fork.id).unwrap();
    assert_eq!(detail.agent.connection_state, "connected");
    assert_eq!(detail.agent.unread_count, 0);
    let from = detail.codex_handoff.unwrap().forked_from.unwrap();
    assert_eq!((from.agent_id.as_str(), from.through_turn_id.as_str(), from.turn_count), (id.as_str(), "t-11", 12));
    // The source keeps its session and identity, and links to the fork.
    let source = lab.ws.store.detail(&id).unwrap();
    assert_eq!(source.agent.thread_id.as_deref(), Some(SOURCE));
    assert!(source.agent.closed_at.is_none());
    assert_eq!(source.codex_handoff.unwrap().forked_to.unwrap().agent_id, fork.id);
}

#[tokio::test]
async fn repeated_clicks_and_retries_return_the_same_fork() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    let first = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap().agent.unwrap();
    let again = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap().agent.unwrap();
    let other_click = lab.ws.fork_codex_session(&id, lab.fork(OTHER_REQUEST)).await.unwrap().agent.unwrap();
    assert_eq!((again.id.as_str(), other_click.id.as_str()), (first.id.as_str(), first.id.as_str()));
    assert_eq!(lab.calls("thread/fork").len(), 1);
    assert_eq!(lab.ws.store.agents().unwrap().len(), 2);
    // A request ID cannot be reused for another boundary.
    let mut changed = lab.fork(REQUEST);
    changed.through_turn_id = "t-10".into();
    assert!(lab.ws.fork_codex_session(&id, changed).await.is_err());
}

#[tokio::test]
async fn a_refused_fork_changes_nothing_and_can_be_tried_again() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    lab.mark("fork_reject");
    let outcome = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(outcome.state, "failed");
    assert!(outcome.message.unwrap().contains("原会话未改变"));
    assert_eq!(lab.ws.store.agents().unwrap().len(), 1);
    // The same request reports the same failure without forking again.
    assert_eq!(lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap().state, "failed");
    assert_eq!(lab.calls("thread/fork").len(), 1);
    lab.clear("fork_reject");
    let retried = lab.ws.fork_codex_session(&id, lab.fork(OTHER_REQUEST)).await.unwrap();
    assert_eq!(retried.state, "completed");
    assert_eq!(lab.calls("thread/fork").len(), 2);
}

#[tokio::test]
async fn a_lost_fork_response_stays_unconfirmed_until_the_user_explicitly_forks_again() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    lab.mark("fork_crash");
    let outcome = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(outcome.state, "uncertain");
    assert!(outcome.message.unwrap().contains("不会自动重试"));
    // Neither a retry nor another click forks again, or assumes failure.
    assert_eq!(lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap().state, "uncertain");
    let other_click = lab.ws.fork_codex_session(&id, lab.fork(OTHER_REQUEST)).await.unwrap();
    assert_eq!((other_click.state.as_str(), other_click.request_id.as_str()), ("uncertain", REQUEST));
    assert_eq!(lab.calls("thread/fork").len(), 1);
    assert_eq!(lab.ws.store.agents().unwrap().len(), 1);
    // Only the explicit choice gives that attempt up and forks again.
    lab.clear("fork_crash");
    let explicit = ForkSession { abandon_unconfirmed: true, ..lab.fork("5f0e2c1a-0000-4000-8000-000000000003") };
    let again = lab.ws.fork_codex_session(&id, explicit).await.unwrap();
    assert_eq!(again.state, "completed", "{:?}", again.message);
    assert_eq!(lab.calls("thread/fork").len(), 2);
    assert_eq!(lab.ws.store.agents().unwrap().len(), 2);
    // A completed fork can never be abandoned by that flag.
    let after = ForkSession { abandon_unconfirmed: true, ..lab.fork("5f0e2c1a-0000-4000-8000-000000000004") };
    assert_eq!(lab.ws.fork_codex_session(&id, after).await.unwrap().agent.unwrap().id, again.agent.unwrap().id);
    assert_eq!(lab.calls("thread/fork").len(), 2);
}

#[tokio::test]
async fn a_fork_whose_history_differs_is_not_registered() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    lab.mark("fork_mismatch");
    let outcome = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(outcome.state, "failed");
    let message = outcome.message.unwrap();
    assert!(message.contains("不一致") && message.contains("未加入 Workspace"), "{message}");
    assert_eq!(lab.ws.store.agents().unwrap().len(), 1);
    assert!(lab.ws.store.detail(&id).unwrap().codex_handoff.unwrap().forked_to.is_none());
}

#[tokio::test]
async fn a_fork_that_cannot_be_read_back_is_checked_again_never_forked_again() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    lab.mark("fork_unreadable");
    let error = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap_err();
    assert!(error.to_string().contains("不会重新 fork"), "{error}");
    // Another click meets the same unchecked fork instead of forking again.
    assert!(lab.ws.fork_codex_session(&id, lab.fork(OTHER_REQUEST)).await.is_err());
    assert_eq!(lab.ws.store.agents().unwrap().len(), 1);
    lab.clear("fork_unreadable");
    let outcome = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(outcome.state, "completed", "{:?}", outcome.message);
    assert_eq!(lab.calls("thread/fork").len(), 1);
    assert_eq!(lab.ws.store.agents().unwrap().len(), 2);
}

#[tokio::test]
async fn a_closed_fork_stays_the_continuation_and_a_deleted_one_frees_the_source() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    let first = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap().agent.unwrap();

    // Closed still exists: the link stays and the same boundary returns it.
    lab.ws.close_agent(&first.id).await.unwrap();
    assert_eq!(lab.ws.preview_codex_fork(&id).await.unwrap().forked_to.unwrap().agent_id, first.id);
    let again = lab.ws.fork_codex_session(&id, lab.fork(OTHER_REQUEST)).await.unwrap();
    assert_eq!((again.state.as_str(), again.connected), ("completed", false));
    assert!(again.agent.unwrap().closed_at.is_some());
    assert_eq!(lab.calls("thread/fork").len(), 1);

    // Deleted: the source no longer claims a continuation and is still in conflict.
    lab.ws.delete_agent(&first.id).await.unwrap();
    let source = lab.ws.store.detail(&id).unwrap();
    let handoff = source.codex_handoff.unwrap();
    assert!(handoff.forked_to.is_none() && handoff.writer_conflict_at.is_some());
    assert!(lab.ws.preview_codex_fork(&id).await.unwrap().forked_to.is_none());
    // The old request does not fork again by itself.
    let old = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(old.state, "failed");
    assert!(old.message.unwrap().contains("已从 Workspace 删除"));
    assert_eq!((lab.calls("thread/fork").len(), lab.ws.store.agents().unwrap().len()), (1, 1));

    // Only a new explicit request forks again, once.
    let second = lab.ws.fork_codex_session(&id, lab.fork(THIRD_REQUEST)).await.unwrap().agent.unwrap();
    assert_ne!(second.id, first.id);
    assert_eq!((lab.calls("thread/fork").len(), lab.ws.store.agents().unwrap().len()), (2, 2));
    assert_eq!(lab.ws.store.detail(&id).unwrap().codex_handoff.unwrap().forked_to.unwrap().agent_id, second.id);
}

#[tokio::test]
async fn a_record_left_by_an_earlier_delete_does_not_block_a_new_fork() {
    let lab = Lab::new();
    let id = lab.conflicted_source().await;
    let first = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap().agent.unwrap();
    lab.ws.close_agent(&first.id).await.unwrap();
    // As a Core without the release step deleted it: the record and link remain.
    let db = rusqlite::Connection::open(lab.root.path().join("data/workspace.sqlite")).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    db.execute("DELETE FROM journal WHERE agent_id=?1", [&first.id]).unwrap();
    db.execute("DELETE FROM agents WHERE id=?1", [&first.id]).unwrap();
    drop(db);

    assert!(lab.ws.preview_codex_fork(&id).await.unwrap().forked_to.is_none());
    let second = lab.ws.fork_codex_session(&id, lab.fork(OTHER_REQUEST)).await.unwrap().agent.unwrap();
    assert_ne!(second.id, first.id);
    let old = lab.ws.fork_codex_session(&id, lab.fork(REQUEST)).await.unwrap();
    assert_eq!(old.state, "failed");
    assert_eq!((lab.calls("thread/fork").len(), lab.ws.store.agents().unwrap().len()), (2, 2));
}

#[tokio::test]
async fn only_a_conflicted_local_codex_session_can_fork() {
    let lab = Lab::new();
    let agent = lab.ws.import_codex_session(ImportSession {
        thread_id: SOURCE.into(), name: "Adopted".into(), permission_preset: "ask".into(),
    }).await.unwrap();
    let error = lab.ws.fork_codex_session(&agent.id, lab.fork(REQUEST)).await.unwrap_err();
    assert!(error.to_string().contains("被其他客户端占用"));
    assert!(lab.calls("thread/fork").is_empty());
    // Refused for its request ID, not for the conflict this session lacks.
    let invalid = ForkSession { request_id: "not-a-uuid".into(), ..lab.fork(REQUEST) };
    let error = lab.ws.fork_codex_session(&agent.id, invalid).await.unwrap_err();
    assert!(error.to_string().contains("fork 请求编号无效"), "{error:#}");
    assert!(lab.calls("thread/fork").is_empty());
}
