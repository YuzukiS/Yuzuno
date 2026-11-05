//! T-34: a dispatch from an executor template, end to end. Core creates one
//! executor, dispatches the task to it, starts it, and its mail reaches it
//! once it is connected. Only the Claude SDK stream is scripted
//! (fixtures/executor_dispatch_bridge.mjs); no model, account or daily Core.
#![cfg(unix)]
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};
use yuzuno_workspace::{model::AgentDetail, server, workspace::Workspace};

async fn until(what: &str, mut check: impl FnMut() -> bool) {
    let waited = tokio::time::timeout(Duration::from_secs(20), async {
        while !check() { tokio::time::sleep(Duration::from_millis(20)).await; }
    }).await;
    assert!(waited.is_ok(), "timed out waiting: {what}");
}

/// What the scripted SDK was given in `folder`, one prompt a line.
fn prompts(folder: &Path) -> Vec<Value> {
    std::fs::read_to_string(folder.join("prompts.jsonl")).unwrap_or_default()
        .lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn folder(lab: &Path, name: &str) -> String {
    let path = lab.join(name);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::canonicalize(path).unwrap().to_string_lossy().into_owned()
}

async fn task(ws: &Arc<Workspace>, title: &str, project: &str, worktree: Option<&str>) -> String {
    let mut input = json!({"requestId":format!("create {title}"),"title":title,"projectId":project});
    if let Some(worktree) = worktree {
        input["materials"] = json!({"worktree":worktree});
    }
    ws.collaboration_call(None, "task_create", input).await.unwrap()["task"]["id"].as_str().unwrap().to_owned()
}

fn dispatch(request: &str, task: &str) -> Value {
    json!({"requestId":request,"taskId":task,"expectedVersion":1,"executor":{"templateId":"reviewer"}})
}

#[tokio::test]
async fn a_template_dispatch_creates_one_executor_that_gets_its_mail_once_connected() {
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/executor_dispatch_bridge.mjs"));
    let lab = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let work = folder(lab.path(), "project");
    let ws = Workspace::new(lab.path().join("data"), lab.path().to_string_lossy().into(), "unused".into()).unwrap();
    let project = ws.store.create_project("Executor fixture", BTreeMap::from([("local".into(), work.clone())])).unwrap().id;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert_ne!(port, 4317);
    ws.start_collaboration(port);
    let app = server::router_on_port(ws.clone(), lab.path().join("no-ui"), port);
    let serving = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let saved = client.put(format!("http://127.0.0.1:{port}/api/executor-templates")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"templates":[{"id":"reviewer","label":"Reviewer","harness":"claude","instructions":"Review the change."}]}))
        .send().await.unwrap();
    assert_eq!(saved.status(), reqwest::StatusCode::OK);

    // One dispatch creates one Agent: an executor of the task's Project, in
    // its folder, named by the template, the task's assignee.
    let first = task(&ws, "Review the change", &project, None).await;
    let answer = ws.collaboration_call(None, "task_dispatch", dispatch("first", &first)).await.unwrap();
    let executor = answer["agentId"].as_str().unwrap().to_owned();
    let agents = ws.store.agents().unwrap();
    assert_eq!(agents.len(), 1, "one dispatch creates one Agent");
    let agent = &agents[0];
    assert_eq!(
        (agent.id.as_str(), agent.kind.as_deref(), agent.project_id.as_deref(), agent.cwd.as_str(), agent.name.as_str(), agent.harness.as_str()),
        (executor.as_str(), Some("executor"), Some(project.as_str()), work.as_str(), "T-1 · Reviewer", "claude"),
    );
    assert_eq!(answer["task"]["assigneeAgentId"], json!(executor));

    // Its runtime starts, and the dispatch's mail, with its materials, is
    // delivered once it is connected.
    until("the mail reaches the executor", || !prompts(Path::new(&work)).is_empty()).await;
    let prompt = prompts(Path::new(&work))[0].to_string();
    assert!(prompt.contains("mailbox delivery from Yuzuno Core"), "the mail reaches the executor: {prompt}");
    assert_eq!(ws.store.agent(&executor).unwrap().connection_state, "connected");
    let mail = ws.store.collaboration_call(Some(&executor), "peer_read", json!({})).unwrap();
    let dispatched = mail["messages"].as_array().unwrap().iter().find(|m| m["taskId"] == json!(first)).expect("the dispatch's mail");
    assert_eq!(dispatched["materialsRef"]["dispatchId"], answer["task"]["dispatch"]["id"]);
    assert!(dispatched["body"].as_str().unwrap().contains("Its instructions: Review the change."),
        "the template's instructions reach the executor in its mail: {}", dispatched["body"]);

    // A retry with the same requestId returns the same Agent; another
    // payload under it, or both an Agent and a template, is refused.
    let again = ws.collaboration_call(None, "task_dispatch", dispatch("first", &first)).await.unwrap();
    assert_eq!(again["agentId"], json!(executor), "a retry with the same requestId returns the same agentId");
    assert_eq!(ws.store.agents().unwrap().len(), 1, "a retry makes only one Agent");
    let mut other = dispatch("first", &first);
    other["body"] = json!("Another payload");
    let refused = ws.collaboration_call(None, "task_dispatch", other).await.unwrap_err().to_string();
    assert!(refused.starts_with("idempotency_conflict:"), "{refused}");
    let mut both = dispatch("both", &first);
    both["toAgentId"] = json!(executor);
    let refused = ws.collaboration_call(None, "task_dispatch", both).await.unwrap_err().to_string();
    assert!(refused.contains("not both"), "{refused}");

    // The store refuses a dispatch after its executor exists: the executor
    // is closed (kept, not deleted) and the dispatch failed, also on retry.
    let second = task(&ws, "Refused by the store", &project, None).await;
    let mut induced = dispatch("induced", &second);
    induced["materials"] = json!({"repositoryId":4242});
    let refused = ws.collaboration_call(None, "task_dispatch", induced.clone()).await.unwrap_err().to_string();
    assert!(refused.contains("repository"), "{refused}");
    let made: Vec<_> = ws.store.agents().unwrap().into_iter().filter(|a| a.id != executor).collect();
    assert_eq!(made.len(), 1);
    assert!(made[0].closed_at.is_some(), "the Agent is closed when the store refuses its dispatch");
    let again = ws.collaboration_call(None, "task_dispatch", induced).await.unwrap_err().to_string();
    assert_eq!(again, refused, "a retry gets the same failure");
    assert_eq!(ws.store.agents().unwrap().len(), 2);
    let second_task = ws.collaboration_call(None, "task_get", json!({"taskId":second})).await.unwrap();
    assert_eq!(second_task["task"]["status"], "todo", "nothing was dispatched");

    // While an update drains, a template dispatch is refused before anything
    // is written; an ordinary dispatch is not.
    ws.admission.begin_drain("t34-lab-update").unwrap();
    let third = task(&ws, "Dispatched after the update", &project, None).await;
    // An accepted dispatch is said so, not a panic: the assertion below names it.
    let paused = ws.collaboration_call(None, "task_dispatch", dispatch("paused", &third)).await
        .err().map_or_else(|| "accepted".to_owned(), |e| e.to_string());
    assert!(paused.starts_with("workspace_updating:") && paused.contains("from an executor template waits for it"),
        "a template dispatch is refused while an update drains: {paused}");
    assert!(paused.contains("Retry the same request once the update is done"), "the refusal says to retry it: {paused}");
    assert_eq!(ws.store.agents().unwrap().len(), 2, "nothing was created during the update");
    // A retry of one already made is refused too, then gets its recorded answer.
    let replayed = ws.collaboration_call(None, "task_dispatch", dispatch("first", &first)).await.unwrap_err().to_string();
    assert!(replayed.starts_with("workspace_updating:"), "{replayed}");
    let fourth = task(&ws, "Dispatched during the update", &project, None).await;
    ws.collaboration_call(None, "task_dispatch", json!({"requestId":"ordinary","taskId":fourth,"expectedVersion":1,"toAgentId":executor}))
        .await.expect("an ordinary dispatch is not refused while an update drains");
    ws.admission.reopen("t34-lab-update").unwrap();
    let replayed = ws.collaboration_call(None, "task_dispatch", dispatch("first", &first)).await.unwrap();
    assert_eq!(replayed["agentId"], json!(executor), "after the update, a retry of one already made gets its recorded answer");
    let after = ws.collaboration_call(None, "task_dispatch", dispatch("paused", &third)).await.unwrap();
    assert_eq!(ws.store.agents().unwrap().len(), 3, "the same requestId dispatches once the update is done");

    // A lead's dispatch: the executor works in the task's worktree, and its
    // result reaches the lead.
    let lead: AgentDetail = serde_json::from_value(json!({"agent":{"id":"lead","name":"Lead fixture","cwd":work,"model":"","harness":"claude",
        "color":"sage","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&lead).unwrap();
    ws.store.set_agent_project("lead", Some(&project)).unwrap();
    let leads = client.put(format!("http://127.0.0.1:{port}/api/projects/{project}/leads")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"leadAgentIds":["lead"]})).send().await.unwrap();
    assert_eq!(leads.status(), reqwest::StatusCode::OK);
    let worktree = folder(lab.path(), "lead-work");
    let fifth = task(&ws, "Led", &project, Some(&worktree)).await;
    let led = ws.collaboration_call(Some("lead"), "task_dispatch", dispatch("led", &fifth)).await.unwrap();
    let led_executor = led["agentId"].as_str().unwrap().to_owned();
    assert_eq!(ws.store.agent(&led_executor).unwrap().cwd, worktree, "the dispatch's worktree comes first");
    ws.collaboration_call(Some(&led_executor), "task_submit_result", json!({"requestId":"result","taskId":fifth,"expectedVersion":2,
        "summary":"Reviewed the fixture.","dispatchId":led["task"]["dispatch"]["id"]})).await.unwrap();
    let mail = ws.store.collaboration_call(Some("lead"), "peer_read", json!({})).unwrap();
    assert!(mail["messages"].as_array().unwrap().iter().any(|m| m["taskId"] == json!(fifth)), "the result reaches the dispatcher: {mail}");

    for id in [executor, after["agentId"].as_str().unwrap().to_owned(), led_executor] {
        ws.close_agent(&id).await.unwrap();
    }
    serving.abort();
}
