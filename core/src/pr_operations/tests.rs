use super::*;
use crate::{github::client::Repository, store::Store};

fn setup(s: &Store) -> (String, String) {
    let project = s.create_project("Delivery", Default::default()).unwrap();
    s.github_link_repo(
        &project.id,
        &Repository {
            id: 7,
            full_name: "owner/repo".into(),
        },
    )
    .unwrap();
    let task = s
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"task","title":"Deliver PR","projectId":project.id}),
        )
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let agent: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"dev","name":"Dev","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    s.insert(&agent).unwrap();
    (task, project.id)
}
fn input(task: &str, key: &str) -> Submit {
    Submit {
        request_id: key.into(),
        task_id: task.into(),
        repository_id: 7,
        action: "create".into(),
        base: "main".into(),
        head: "feature/safe".into(),
        title: "Ship feature".into(),
        body: "Literal `code` and $(not-a-command)\nSecond line".into(),
        draft: Some(true),
        number: None,
        notify_agent_id: Some("dev".into()),
    }
}
fn remote() -> Value {
    json!({"id":70,"number":11,"url":"https://github.com/owner/repo/pull/11","repositoryId":7,"repository":"owner/repo","title":"Ship feature","body":"body","draft":true,"state":"open","base":"main","head":"feature/safe","baseSha":"a".repeat(40),"headSha":"b".repeat(40),"observedAt":crate::model::now()})
}
fn mail(s: &Store) -> Value {
    s.collaboration_call(None, "peer_read", json!({"agentId":"dev"}))
        .unwrap()
}

#[test]
fn request_identity_recovery_and_notifications_survive_restart_without_task_completion() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    let s = Store::open(&path).unwrap();
    let (task, _) = setup(&s);
    let original = s
        .collaboration_call(None, "task_get", json!({"taskId":task}))
        .unwrap()["task"]
        .clone();
    let request = input(&task, "one");
    let (record, created) = s.create_pr_operation(Some("dev"), request.clone()).unwrap();
    assert!(created);
    assert_eq!(
        s.create_pr_operation(Some("dev"), request.clone())
            .unwrap()
            .0["id"],
        record["id"]
    );
    let mut conflict = request.clone();
    conflict.body.push('!');
    assert!(s.create_pr_operation(Some("dev"), conflict).is_err());
    assert!(
        s.create_pr_operation(None, input(&task, "concurrent"))
            .is_err()
    );
    s.update("dev", "closed", &json!({}), |d| {
        d.agent.closed_at = Some("later".into())
    })
    .unwrap();
    drop(s);
    let s = Store::open(&path).unwrap();
    s.recover_pr_operations().unwrap();
    s.recover_pr_operations().unwrap();
    let id = record["id"].as_str().unwrap();
    assert_eq!(s.pr_operation(&task, id).unwrap()["status"], "unknown");
    let messages = mail(&s);
    assert_eq!(messages["messages"].as_array().unwrap().len(), 1);
    let message = &messages["messages"][0];
    assert_eq!(message["sender"]["kind"], "system");
    assert_eq!(message["sender"]["id"], "core");
    assert_eq!(message["priority"], "normal");
    // The mailbox notice names it as a PR operation, not a bare System notice.
    assert_eq!(message["notice"]["kind"], "pr");
    assert_eq!(message["notice"]["status"], "unknown");
    assert!(
        message["body"]
            .as_str()
            .unwrap()
            .contains("github_pr_get(taskId=T-1")
    );
    assert!(s.agent("dev").unwrap().closed_at.is_some());
    let check = Check {
        request_id: "check".into(),
        task_id: task.clone(),
        operation_id: id.into(),
        number: None,
    };
    let (mut checked, created) = s.check_pr_operation(None, check.clone()).unwrap();
    assert!(created);
    assert!(!s.check_pr_operation(None, check).unwrap().1);
    checked["status"] = json!("completed");
    checked["remote"] = remote();
    checked["finishedAt"] = json!(crate::model::now());
    let done = s.finish_pr_operation(checked.clone()).unwrap();
    assert_eq!(done["linked"], true);
    s.finish_pr_operation(checked).unwrap();
    assert_eq!(mail(&s)["messages"].as_array().unwrap().len(), 2);
    let after = s
        .collaboration_call(None, "task_get", json!({"taskId":task}))
        .unwrap()["task"]
        .clone();
    assert_eq!(after["status"], original["status"]);
    assert_eq!(after["version"], original["version"]);
    assert_eq!(
        s.github_list(None, Some(&task)).unwrap()["links"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn a_remote_pr_survives_link_failure_and_repair_reuses_its_identity() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("data.sqlite")).unwrap();
    let (task, project) = setup(&s);
    let (mut record, _) = s.create_pr_operation(None, input(&task, "create")).unwrap();
    record["status"] = json!("completed");
    record["remote"] = remote();
    record["finishedAt"] = json!(crate::model::now());
    s.github_unlink_repo(&project, 7).unwrap();
    let pending = s.finish_pr_operation(record).unwrap();
    assert_eq!(pending["status"], "link_pending");
    assert_eq!(pending["remote"]["number"], 11);
    assert_eq!(pending["linked"], false);
    assert_eq!(mail(&s)["messages"].as_array().unwrap().len(), 1);
    s.github_link_repo(
        &project,
        &Repository {
            id: 7,
            full_name: "owner/repo".into(),
        },
    )
    .unwrap();
    let (mut checked, _) = s
        .check_pr_operation(
            None,
            Check {
                request_id: "repair".into(),
                task_id: task.clone(),
                operation_id: pending["id"].as_str().unwrap().into(),
                number: None,
            },
        )
        .unwrap();
    checked["status"] = json!("completed");
    checked["finishedAt"] = json!(crate::model::now());
    let done = s.finish_pr_operation(checked).unwrap();
    assert_eq!(done["id"], pending["id"]);
    assert_eq!(done["remote"]["number"], 11);
    assert_eq!(done["linked"], true);
    assert_eq!(done["history"].as_array().unwrap().len(), 2);
    assert_eq!(mail(&s)["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn a_notification_failure_rolls_back_the_result_and_link_together() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("data.sqlite")).unwrap();
    let (task, _) = setup(&s);
    let (mut record, _) = s.create_pr_operation(None, input(&task, "atomic")).unwrap();
    record["status"] = json!("completed");
    record["remote"] = remote();
    record["finishedAt"] = json!(crate::model::now());
    s.db.write().unwrap().execute_batch("CREATE TRIGGER reject_notification BEFORE INSERT ON collaboration_messages BEGIN SELECT RAISE(ABORT,'injected notification failure'); END;").unwrap();
    assert!(s.finish_pr_operation(record.clone()).is_err());
    assert_eq!(
        s.pr_operation(&task, record["id"].as_str().unwrap())
            .unwrap()["status"],
        "accepted"
    );
    assert_eq!(
        s.github_list(None, Some(&task)).unwrap()["links"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(mail(&s)["messages"].as_array().unwrap().len(), 0);
    s.db.write()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_notification")
        .unwrap();
    assert_eq!(s.finish_pr_operation(record).unwrap()["linked"], true);
    assert_eq!(mail(&s)["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn loaded_range_refresh_includes_old_operation_changes_without_returning_bodies() {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("data.sqlite")).unwrap();
    let (task, _) = setup(&s);
    let mut ids = Vec::new();
    for n in 0..45 {
        let mut request = input(&task, &format!("op-{n}"));
        request.notify_agent_id = None;
        let (mut record, _) = s.create_pr_operation(None, request).unwrap();
        ids.push(record["id"].as_str().unwrap().to_owned());
        record["status"] = json!("failed");
        s.finish_pr_operation(record).unwrap();
    }
    let first = s.list_pr_operations(&task, None, None).unwrap();
    assert_eq!(first["operations"].as_array().unwrap().len(), 20);
    let second = s
        .list_pr_operations(&task, first["nextBefore"].as_i64(), None)
        .unwrap();
    let (mut checked, _) = s
        .check_pr_operation(
            None,
            Check {
                request_id: "old".into(),
                task_id: task.clone(),
                operation_id: ids[10].clone(),
                number: None,
            },
        )
        .unwrap();
    checked["status"] = json!("unknown");
    s.finish_pr_operation(checked).unwrap();
    let refresh = s
        .list_pr_operations(&task, None, second["nextBefore"].as_i64())
        .unwrap();
    assert_eq!(refresh["operations"].as_array().unwrap().len(), 40);
    assert_eq!(refresh["hasMore"], true);
    assert_eq!(refresh["nextBefore"], second["nextBefore"]);
    let old = refresh["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == ids[10])
        .unwrap();
    assert_eq!(old["status"], "unknown");
    assert!(old["input"].get("body").is_none());
    assert!(s.pr_operation(&task, &ids[10]).unwrap()["input"]["body"].is_string());
}

#[test]
fn only_explicit_branch_and_update_inputs_are_accepted() {
    let mut i = input("T-1", "key");
    assert!(i.validate().is_ok());
    for bad in [
        "-flag", "../main", "a..b", "a?b", "a b", "a\\b", "a@{b", "a.lock", "a//b",
    ] {
        i.head = bad.into();
        assert!(i.validate().is_err(), "{bad}");
    }
    i = input("T-1", "key");
    i.action = "update".into();
    assert!(i.validate().is_err());
    i.number = Some(11);
    assert!(i.validate().is_err());
    i.draft = None;
    assert!(i.validate().is_ok());
}

#[cfg(unix)]
fn fake_gh(root: &std::path::Path, lost: bool) -> String {
    use std::os::unix::fs::PermissionsExt;
    let script = root.join("gh.py");
    std::fs::write(
        root.join("remote.json"),
        json!({"pulls":[],"calls":[],"writes":0,"lost":lost}).to_string(),
    )
    .unwrap();
    std::fs::write(&script,r#"#!/usr/bin/python3
import json,sys,pathlib,urllib.parse,time
p=pathlib.Path(__file__).with_name('remote.json')
s=json.loads(p.read_text()); a=sys.argv[1:]; method=a[a.index('--method')+1]
endpoint=next(v for v in a if v.startswith(('repos/','repositories/')))
if s.get('delay') and endpoint=='repositories/7': time.sleep(s['delay'])
body=json.load(sys.stdin) if '--input' in a else None
s['calls'].append({'method':method,'endpoint':endpoint,'body':body})
if method=='POST':
 n=11+len(s['pulls']); v={'id':n+100,'number':n,'title':body['title'],'body':body['body'],'draft':body['draft'],'state':'open','merged_at':None,'user':{'login':'owner'},'base':{'ref':body['base'],'sha':'a'*40,'repo':{'id':7}},'head':{'ref':body['head'],'sha':'b'*40,'repo':{'id':7}}}
 s['pulls'].append(v); s['writes']+=1
elif method=='PATCH':
 n=int(endpoint.rsplit('/',1)[1]); v=next(v for v in s['pulls'] if v['number']==n); v.update(body); s['writes']+=1
elif endpoint=='repositories/7': v={'id':7,'full_name':'owner/repo'}
elif '/branches/' in endpoint: v={'commit':{'sha':('a' if endpoint.endswith('/main') else 'b')*40}}
elif '/pulls?' in endpoint: v=s['pulls']
else: v=next(v for v in s['pulls'] if v['number']==int(endpoint.rsplit('/',1)[1]))
p.write_text(json.dumps(s))
if method=='POST' and s['lost']:
 print('HTTP 503 response lost',file=sys.stderr); sys.exit(1)
print(json.dumps(v))
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_string_lossy().into_owned()
}

#[cfg(unix)]
#[tokio::test]
async fn missing_write_reply_is_checked_without_reposting_and_existing_pr_is_not_edited() {
    let dir = tempfile::tempdir().unwrap();
    let program = fake_gh(dir.path(), true);
    let mut ws = Workspace::new(
        dir.path().join("data"),
        dir.path().to_string_lossy().into(),
        "unused".into(),
    )
    .unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program;
    let (task, _) = setup(&ws.store);
    let request = input(&task, "create");
    let literal = request.body.clone();
    let (mut record, _) = ws.store.create_pr_operation(None, request).unwrap();
    remote::execute(&ws, &mut record, false, None)
        .await
        .unwrap();
    assert_eq!(record["status"], "completed");
    assert_eq!(record["outcome"], "checked");
    assert!(record["writeError"].is_string());
    ws.store.finish_pr_operation(record).unwrap();
    let mut request = input(&task, "reuse");
    request.title = "Must not replace somebody's title".into();
    let (mut reused, _) = ws.store.create_pr_operation(None, request).unwrap();
    remote::execute(&ws, &mut reused, false, None)
        .await
        .unwrap();
    assert_eq!(reused["outcome"], "reused");
    assert_eq!(reused["remote"]["title"], "Ship feature");
    ws.store.finish_pr_operation(reused).unwrap();
    let mut request = input(&task, "update");
    request.action = "update".into();
    request.number = Some(11);
    request.draft = None;
    request.title = "Explicit new title".into();
    let (mut updated, _) = ws.store.create_pr_operation(None, request).unwrap();
    remote::execute(&ws, &mut updated, false, None)
        .await
        .unwrap();
    assert_eq!(updated["outcome"], "updated");
    let state: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("remote.json")).unwrap()).unwrap();
    assert_eq!(state["writes"], 2);
    let calls = state["calls"].as_array().unwrap();
    assert_eq!(calls.iter().filter(|c| c["method"] == "POST").count(), 1);
    assert_eq!(
        calls.iter().find(|c| c["method"] == "POST").unwrap()["body"]["body"],
        literal
    );
    assert!(
        calls
            .iter()
            .any(|c| c["endpoint"].as_str().unwrap().ends_with("/feature%2Fsafe"))
    );
    assert_eq!(state["pulls"][0]["title"], "Explicit new title");
    assert_eq!(state["pulls"][0]["draft"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn ambiguous_candidates_require_selection_and_checks_never_replay_updates() {
    let dir = tempfile::tempdir().unwrap();
    let program = fake_gh(dir.path(), false);
    let mut ws = Workspace::new(
        dir.path().join("data"),
        dir.path().to_string_lossy().into(),
        "unused".into(),
    )
    .unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program;
    let (task, _) = setup(&ws.store);
    let raw = |n| json!({"id":n+100,"number":n,"title":"Existing title","body":"Someone else's body","draft":false,"state":"open","base":{"ref":"main","sha":"a".repeat(40),"repo":{"id":7}},"head":{"ref":"feature/safe","sha":"b".repeat(40),"repo":{"id":7}}});
    let path = dir.path().join("remote.json");
    std::fs::write(
        &path,
        json!({"pulls":[raw(11),raw(12)],"calls":[],"writes":0,"lost":false}).to_string(),
    )
    .unwrap();
    let (mut record, _) = ws
        .store
        .create_pr_operation(None, input(&task, "ambiguous"))
        .unwrap();
    remote::execute(&ws, &mut record, false, None)
        .await
        .unwrap();
    assert_eq!(record["status"], "needs_selection");
    assert_eq!(record["candidates"].as_array().unwrap().len(), 2);
    let id = record["id"].as_str().unwrap().to_owned();
    ws.store.finish_pr_operation(record).unwrap();
    let (mut selected, _) = ws
        .store
        .check_pr_operation(
            None,
            Check {
                request_id: "select".into(),
                task_id: task.clone(),
                operation_id: id,
                number: Some(12),
            },
        )
        .unwrap();
    remote::execute(&ws, &mut selected, true, Some(12))
        .await
        .unwrap();
    assert_eq!(selected["remote"]["number"], 12);
    assert_eq!(selected["remote"]["title"], "Existing title");
    assert_eq!(selected["status"], "completed");
    ws.store.finish_pr_operation(selected).unwrap();
    let mut update = input(&task, "unconfirmed-update");
    update.action = "update".into();
    update.number = Some(11);
    update.draft = None;
    let (mut uncertain, _) = ws.store.create_pr_operation(None, update).unwrap();
    uncertain["status"] = json!("unknown");
    let id = uncertain["id"].as_str().unwrap().to_owned();
    ws.store.finish_pr_operation(uncertain).unwrap();
    let (mut checked, _) = ws
        .store
        .check_pr_operation(
            None,
            Check {
                request_id: "check-update".into(),
                task_id: task.clone(),
                operation_id: id,
                number: None,
            },
        )
        .unwrap();
    remote::execute(&ws, &mut checked, true, None)
        .await
        .unwrap();
    assert_eq!(checked["status"], "unknown");
    ws.store.finish_pr_operation(checked).unwrap();
    let mut wrong = input(&task, "wrong-target");
    wrong.number = Some(11);
    wrong.base = "another-base".into();
    let (mut record, _) = ws.store.create_pr_operation(None, wrong).unwrap();
    assert!(
        remote::execute(&ws, &mut record, false, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("does not match")
    );
    let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(state["writes"], 0);
}

#[cfg(unix)]
#[tokio::test]
async fn interrupted_numbered_update_cannot_recover_using_another_matching_pr() {
    let dir = tempfile::tempdir().unwrap();
    let program = fake_gh(dir.path(), false);
    let data = dir.path().join("data");
    let ws = Workspace::new(
        data.clone(),
        dir.path().to_string_lossy().into(),
        "unused".into(),
    )
    .unwrap();
    let (task, _) = setup(&ws.store);
    let mut update = input(&task, "numbered-update");
    update.action = "update".into();
    update.number = Some(11);
    update.draft = None;
    let raw = |number, title: &str, body: &str, state: &str| json!({"id":number+100,"number":number,"title":title,"body":body,"draft":false,"state":state,"base":{"ref":"main","sha":"a".repeat(40),"repo":{"id":7}},"head":{"ref":"feature/safe","sha":"b".repeat(40),"repo":{"id":7}}});
    let path = dir.path().join("remote.json");
    std::fs::write(&path, json!({"pulls":[raw(11,"Original title","Original body","open"),raw(12,&update.title,&update.body,"closed")],"calls":[],"writes":0,"lost":false}).to_string()).unwrap();
    let (record, _) = ws
        .store
        .create_pr_operation(Some("dev"), update.clone())
        .unwrap();
    let id = record["id"].as_str().unwrap().to_owned();
    // Restart after acceptance, before any remote identity or write was saved.
    drop(ws);
    let mut ws =
        Workspace::new(data, dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program;
    let interrupted = ws.store.pr_operation(&task, &id).unwrap();
    assert_eq!(interrupted["status"], "unknown");
    assert!(interrupted["remote"].is_null());
    assert_eq!(mail(&ws.store)["messages"].as_array().unwrap().len(), 1);

    let check = |key: &str, number| Check {
        request_id: key.into(),
        task_id: task.clone(),
        operation_id: id.clone(),
        number,
    };
    let rejected = call(
        ws.clone(),
        Some("dev".into()),
        "github_pr_check".into(),
        serde_json::to_value(check("alternate", Some(12))).unwrap(),
    )
    .await;
    assert!(
        rejected.is_err(),
        "An explicit target must survive restart even with remote=null"
    );
    assert_eq!(ws.store.pr_operation(&task, &id).unwrap(), interrupted);
    assert!(
        ws.store.github_list(None, Some(&task)).unwrap()["links"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(mail(&ws.store)["messages"].as_array().unwrap().len(), 1);
    let state: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(state["calls"].as_array().unwrap().is_empty());

    // The worker enforces the same invariant independently of Store admission.
    let (mut checked, _) = ws
        .store
        .check_pr_operation(None, check("worker-guard", None))
        .unwrap();
    let error = remote::execute(&ws, &mut checked, true, Some(12))
        .await
        .unwrap_err();
    checked["status"] = json!("unknown");
    checked["error"] = json!(error.to_string());
    checked["finishedAt"] = json!(crate::model::now());
    ws.store.finish_pr_operation(checked).unwrap();
    assert!(
        ws.store.github_list(None, Some(&task)).unwrap()["links"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        mail(&ws.store)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["body"].as_str().unwrap().contains("has ended: unknown"))
    );

    // Checking the original target remains possible, but its old content
    // cannot be mistaken for the historical PR's matching requested content.
    let (mut checked, _) = ws
        .store
        .check_pr_operation(None, check("original", Some(11)))
        .unwrap();
    remote::execute(&ws, &mut checked, true, Some(11))
        .await
        .unwrap();
    assert_eq!(checked["status"], "unknown");
    assert_eq!(checked["remote"]["number"], 11);
    ws.store.finish_pr_operation(checked).unwrap();
    assert!(
        mail(&ws.store)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["body"].as_str().unwrap().contains("has ended: unknown"))
    );

    // Once the original remote target actually has the desired content,
    // read-only recovery confirms that same PR without replaying the update.
    let mut state: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    state["pulls"][0]["title"] = json!(update.title);
    state["pulls"][0]["body"] = json!(update.body);
    std::fs::write(&path, state.to_string()).unwrap();
    let (mut checked, _) = ws
        .store
        .check_pr_operation(None, check("confirmed-original", None))
        .unwrap();
    remote::execute(&ws, &mut checked, true, None)
        .await
        .unwrap();
    assert_eq!(checked["status"], "completed");
    assert_eq!(checked["remote"]["number"], 11);
    ws.store.finish_pr_operation(checked).unwrap();
    let links = ws.store.github_list(None, Some(&task)).unwrap();
    assert_eq!(links["links"].as_array().unwrap().len(), 1);
    assert_eq!(links["links"][0]["number"], 11);
    let messages = mail(&ws.store);
    let completed: Vec<_> = messages["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["body"].as_str().unwrap().contains("has ended: completed"))
        .collect();
    assert_eq!(completed.len(), 1);
    assert!(completed[0]["body"].as_str().unwrap().contains("/pull/11"));
    let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(state["writes"], 0);
    assert!(
        state["calls"].as_array().unwrap().iter().all(
            |c| c["method"] == "GET" && !c["endpoint"].as_str().unwrap().ends_with("/pulls/12")
        )
    );
}

#[cfg(unix)]
#[tokio::test]
async fn accepted_operation_outlives_the_call_and_notifies_once() {
    let dir = tempfile::tempdir().unwrap();
    let program = fake_gh(dir.path(), false);
    let path = dir.path().join("remote.json");
    std::fs::write(
        &path,
        json!({"pulls":[],"calls":[],"writes":0,"lost":false,"delay":1}).to_string(),
    )
    .unwrap();
    let mut ws = Workspace::new(
        dir.path().join("data"),
        dir.path().to_string_lossy().into(),
        "unused".into(),
    )
    .unwrap();
    Arc::get_mut(&mut ws).unwrap().github.client.program = program;
    let (task, _) = setup(&ws.store);
    let payload = serde_json::to_value(input(&task, "background")).unwrap();
    let start = std::time::Instant::now();
    let record = call(
        ws.clone(),
        Some("dev".into()),
        "github_pr_submit".into(),
        payload.clone(),
    )
    .await
    .unwrap();
    assert!(start.elapsed() < std::time::Duration::from_millis(750));
    assert_eq!(record["status"], "accepted");
    let duplicate = call(
        ws.clone(),
        Some("dev".into()),
        "github_pr_submit".into(),
        payload,
    )
    .await
    .unwrap();
    assert_eq!(duplicate["id"], record["id"]);
    ws.store
        .update("dev", "closed", &json!({}), |d| {
            d.agent.closed_at = Some("later".into())
        })
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(8),
        ws.collaboration_wakeup.notified(),
    )
    .await
    .unwrap();
    let result = ws
        .store
        .pr_operation(&task, record["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(result["status"], "completed");
    assert_eq!(result["linked"], true);
    assert_eq!(mail(&ws.store)["messages"].as_array().unwrap().len(), 1);
    assert!(ws.store.agent("dev").unwrap().closed_at.is_some());
}
