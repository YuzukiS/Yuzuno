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
        (executor.as_str(), Some("executor"), Some(project.as_str()), work.as_str(), "EF-1 · Reviewer", "claude"),
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

/// T-35: no more executors run at once than the Workspace's slots. The next
/// waits: its task says where in the queue, and Connect is refused without
/// marking it failed. It starts once one is closed, or the limit is raised.
#[tokio::test]
async fn executors_past_the_slots_wait_their_turn_and_start_when_a_slot_is_free() {
    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/executor_dispatch_bridge.mjs"));
    let lab = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let work = folder(lab.path(), "project");
    let ws = Workspace::new(lab.path().join("data"), lab.path().to_string_lossy().into(), "unused".into()).unwrap();
    let project = ws.store.create_project("Executor fixture", BTreeMap::from([("local".into(), work)])).unwrap().id;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert_ne!(port, 4317);
    ws.start_collaboration(port);
    let app = server::router_on_port(ws.clone(), lab.path().join("no-ui"), port);
    let serving = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{port}/api");
    let saved = client.put(format!("{base}/executor-templates")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"templates":[{"id":"reviewer","label":"Reviewer","harness":"claude","instructions":"Review the change."}]}))
        .send().await.unwrap();
    assert_eq!(saved.status(), reqwest::StatusCode::OK);
    let slots = client.put(format!("{base}/executor-slots")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"slots":2})).send().await.unwrap();
    assert_eq!(slots.status(), reqwest::StatusCode::OK);
    assert_eq!(slots.json::<Value>().await.unwrap()["workspace"]["slots"], 2);

    // Three dispatches, each executor in a worktree of its own.
    let (mut tasks, mut executors, mut folders) = (Vec::new(), Vec::new(), Vec::new());
    for name in ["one", "two", "three"] {
        let worktree = folder(lab.path(), name);
        let id = task(&ws, &format!("Review {name}"), &project, Some(&worktree)).await;
        let answer = ws.collaboration_call(None, "task_dispatch", dispatch(name, &id)).await.unwrap();
        executors.push(answer["agentId"].as_str().unwrap().to_owned());
        tasks.push(id);
        folders.push(worktree);
    }
    until("the first two get their mail", || folders[..2].iter().all(|f| !prompts(Path::new(f)).is_empty())).await;
    // As an Agent reads it: task_get's current view.
    let slot = |task: &str| ws.store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"current"})).unwrap()["current"]["executorSlot"].clone();
    assert_eq!(slot(&tasks[2]), json!({"agentId":executors[2],"state":"waiting","machine":"local","position":1}));
    let third = ws.store.agent(&executors[2]).unwrap();
    assert_eq!((third.connection_state.as_str(), third.status.as_str()), ("disconnected", "offline"), "the third waits, unstarted");

    // Connect on it is refused, with its place; it is not marked failed.
    let refused = client.post(format!("{base}/agents/{}/reconnect", executors[2])).header("X-Yuzuno-Client", "desktop")
        .json(&json!({})).send().await.unwrap();
    assert_eq!(refused.status(), reqwest::StatusCode::BAD_REQUEST);
    let refused = refused.json::<Value>().await.unwrap()["error"].as_str().unwrap_or_default().to_owned();
    assert!(refused.starts_with("executor_queued: this executor waits for an executor slot (number 1 in the queue)"), "{refused}");
    let third = ws.store.agent(&executors[2]).unwrap();
    assert_eq!((third.connection_state.as_str(), third.status.as_str(), third.error.as_deref()), ("disconnected", "offline", None),
        "a refused Connect changes nothing");
    assert!(prompts(Path::new(&folders[2])).is_empty(), "nothing started it");

    // Mail for a waiting executor, its dispatch's and a peer's, waits as
    // pending: delivery neither starts it nor counts a problem (Lead 2, 5325).
    // The barrier: urgent mail sent to the second right after reaches it (no
    // wake-up interval for urgent), so a delivery pass, which takes every
    // pending batch, ran with the third's mail pending.
    let second_before = prompts(Path::new(&folders[1])).len();
    ws.collaboration_call(Some(&executors[0]), "peer_send",
        json!({"requestId":"to-third","toAgentId":executors[2],"body":"Also read the linked notes.","taskId":tasks[2]})).await.unwrap();
    ws.collaboration_call(Some(&executors[0]), "peer_send",
        json!({"requestId":"to-second","toAgentId":executors[1],"body":"A barrier for the third's mail.","taskId":tasks[1],"priority":"urgent"})).await.unwrap();
    until("the second gets the mail sent with the third's", || prompts(Path::new(&folders[1])).len() > second_before).await;
    let third = ws.store.agent(&executors[2]).unwrap();
    assert_eq!((third.connection_state.as_str(), third.status.as_str(), third.error.as_deref()), ("disconnected", "offline", None),
        "mail for a waiting executor does not start it");
    assert!(prompts(Path::new(&folders[2])).is_empty(), "nor wakes it");
    let problems = |task: &str| ws.store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"current"})).unwrap()["current"]["mailProblems"].clone();
    assert_eq!(problems(&tasks[2]), json!([]), "a waiting executor's mail is no delivery problem: not failed, not retried");
    // Once started, the first two are running (recorded as their start returns).
    for (task, executor) in tasks[..2].iter().zip(&executors) {
        let running = json!({"agentId":executor,"state":"running","machine":"local"});
        until("the first two run", || slot(task) == running).await;
    }
    let in_use = |client: reqwest::Client, base: String| async move {
        client.get(format!("{base}/executor-slots")).header("X-Yuzuno-Client", "desktop").send().await.unwrap()
            .json::<Value>().await.unwrap()["inUse"].clone()
    };
    assert_eq!(in_use(client.clone(), base.clone()).await, json!({"waiting":1,"starting":0,"running":2}));

    // A close frees a slot: the third starts and gets its mail.
    ws.close_agent(&executors[0]).await.unwrap();
    until("the third gets its mail", || !prompts(Path::new(&folders[2])).is_empty()).await;
    assert_eq!(ws.store.agent(&executors[2]).unwrap().connection_state, "connected");
    let first = prompts(Path::new(&folders[2]))[0].to_string();
    assert!(first.contains("mailbox delivery from Yuzuno Core"), "its first turn is its mail: {first}");
    let read = ws.store.collaboration_call(Some(&executors[2]), "peer_read", json!({})).unwrap();
    let read = read["messages"].as_array().unwrap();
    assert!(read.iter().any(|m| m["taskId"] == json!(tasks[2]) && m["materialsRef"]["dispatchId"].is_string()),
        "the dispatch's mail reached it: {read:?}");
    assert!(read.iter().any(|m| m["body"] == json!("Also read the linked notes.")), "and the peer's: {read:?}");
    assert_eq!(problems(&tasks[2]), json!([]), "delivered once started, with no problem recorded");
    assert_eq!(slot(&tasks[0]), Value::Null, "a closed executor holds no slot");

    // A fourth waits until the limit is raised.
    let fourth_folder = folder(lab.path(), "four");
    let fourth = task(&ws, "Review four", &project, Some(&fourth_folder)).await;
    let answer = ws.collaboration_call(None, "task_dispatch", dispatch("four", &fourth)).await.unwrap();
    let fourth_executor = answer["agentId"].as_str().unwrap().to_owned();
    assert_eq!(slot(&fourth)["state"], "waiting");
    let raised = client.put(format!("{base}/executor-slots")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":1,"slots":3})).send().await.unwrap();
    assert_eq!(raised.status(), reqwest::StatusCode::OK);
    until("the fourth gets its mail", || !prompts(Path::new(&fourth_folder)).is_empty()).await;
    until("the fourth runs", || slot(&fourth)["state"] == "running").await;
    assert_eq!(in_use(client.clone(), base.clone()).await, json!({"waiting":0,"starting":0,"running":3}));

    // The first, reopened, waits for a slot again instead of starting; it
    // starts when one is free.
    let reopened = client.post(format!("{base}/agents/{}/reopen", executors[0])).header("X-Yuzuno-Client", "desktop")
        .json(&json!({})).send().await.unwrap();
    assert_eq!(reopened.status(), reqwest::StatusCode::OK, "a reopen is not refused");
    let first = ws.store.agent(&executors[0]).unwrap();
    assert!(first.closed_at.is_none());
    assert_eq!((first.connection_state.as_str(), first.status.as_str()), ("disconnected", "offline"), "reopened, not started");
    assert_eq!(slot(&tasks[0]), json!({"agentId":executors[0],"state":"waiting","machine":"local","position":1}));
    ws.close_agent(&fourth_executor).await.unwrap();
    until("the reopened one runs", || slot(&tasks[0])["state"] == "running").await;
    assert_eq!(ws.store.agent(&executors[0]).unwrap().connection_state, "connected");

    for id in &executors {
        ws.close_agent(id).await.unwrap();
    }
    serving.abort();
}

/// T-35 S2: an executor whose start fails is closed, kept and rebuilt once,
/// as a new dispatch by the same lead; the rebuilt one starts in the same
/// folder and gets the dispatch's mail. When the rebuilt one fails too, Core
/// blocks the task with both reasons and mails the lead once. Only the
/// Claude SDK stream is scripted: its `fail-starts` file fails starts.
#[tokio::test]
async fn a_failed_start_is_rebuilt_once_and_a_second_failure_blocks_the_task() {
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
    let base = format!("http://127.0.0.1:{port}/api");
    let saved = client.put(format!("{base}/executor-templates")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"templates":[{"id":"reviewer","label":"Reviewer","harness":"claude","instructions":"Review the change."}]}))
        .send().await.unwrap();
    assert_eq!(saved.status(), reqwest::StatusCode::OK);
    let lead: AgentDetail = serde_json::from_value(json!({"agent":{"id":"lead","name":"Lead fixture","cwd":work,"model":"","harness":"claude",
        "color":"sage","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&lead).unwrap();
    ws.store.set_agent_project("lead", Some(&project)).unwrap();
    let leads = client.put(format!("{base}/projects/{project}/leads")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"leadAgentIds":["lead"]})).send().await.unwrap();
    assert_eq!(leads.status(), reqwest::StatusCode::OK);
    let starts = |folder: &str| std::fs::read_to_string(Path::new(folder).join("starts")).unwrap_or_default().lines().count();
    let current = |task: &str| ws.store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"current"})).unwrap()["current"].clone();

    // Its first start fails once: the rebuilt executor starts in the same
    // folder and gets the dispatch's mail.
    let once = folder(lab.path(), "once");
    std::fs::write(Path::new(&once).join("fail-starts"), "1").unwrap();
    let task_once = task(&ws, "Review once", &project, Some(&once)).await;
    let first = ws.collaboration_call(Some("lead"), "task_dispatch", dispatch("once", &task_once)).await.unwrap()["agentId"]
        .as_str().unwrap().to_owned();
    until("the rebuilt executor gets its mail", || !prompts(Path::new(&once)).is_empty()).await;
    assert_eq!(starts(&once), 2, "one failed start, one rebuild that started");
    assert!(ws.store.agent(&first).unwrap().closed_at.is_some(), "the first is closed, and kept");
    let now = current(&task_once);
    let second = now["assignee"]["id"].as_str().or(now["dispatch"]["executor"]["id"].as_str()).unwrap_or_default().to_owned();
    assert!(!second.is_empty() && second != first, "the task is the rebuilt executor's: {now}");
    assert_eq!(ws.store.agent(&second).unwrap().cwd, once, "in the same folder");
    assert_eq!(now["status"], "doing");
    until("the rebuilt one runs", || current(&task_once)["executorSlot"]["state"] == "running").await;

    // It fails every time: after the one rebuild, Core blocks the task and
    // tells the lead.
    let always = folder(lab.path(), "always");
    std::fs::write(Path::new(&always).join("fail-starts"), "9").unwrap();
    let task_always = task(&ws, "Review never", &project, Some(&always)).await;
    ws.collaboration_call(Some("lead"), "task_dispatch", dispatch("always", &task_always)).await.unwrap();
    until("the task is blocked", || current(&task_always)["status"] == "blocked").await;
    assert_eq!(starts(&always), 2, "the first start and the one rebuild's");
    let full = ws.store.collaboration_call(None, "task_get", json!({"taskId":task_always,"view":"full"})).unwrap();
    let blocker = full["task"]["blocker"].as_str().unwrap();
    assert_eq!(blocker.matches("scripted start failure").count(), 2, "both reasons: {blocker}");
    assert!(prompts(Path::new(&always)).is_empty(), "nothing started, so no mail reached an executor");
    let mail = ws.store.collaboration_call(Some("lead"), "peer_read", json!({})).unwrap();
    let told: Vec<&Value> = mail["messages"].as_array().unwrap().iter()
        .filter(|m| m["taskId"] == json!(task_always) && m["metadata"]["kind"] == "executor").collect();
    assert_eq!(told.len(), 1, "one mail to the lead: {told:?}");
    assert!(told[0]["body"].as_str().unwrap().contains("is blocked"), "{}", told[0]["body"]);

    ws.close_agent(&second).await.unwrap();
    serving.abort();
}

/// T-34 S4: a lead releases the executor it dispatched, over MCP; another
/// Agent can't. The released executor's slot goes to the next one waiting,
/// which starts and gets its mail. The released one stays closed: a reopen is
/// refused, over HTTP too. Its task, its dispatch and its result stay as they
/// were, and the Agent list names the release.
#[tokio::test]
async fn a_lead_releases_its_executor_over_mcp_and_the_freed_slot_starts_the_next() {
    use rmcp::{model::CallToolRequestParams, transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport}, ServiceExt as _};
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
    let base = format!("http://127.0.0.1:{port}/api");
    let saved = client.put(format!("{base}/executor-templates")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"templates":[{"id":"reviewer","label":"Reviewer","harness":"claude","instructions":"Review the change."}]}))
        .send().await.unwrap();
    assert_eq!(saved.status(), reqwest::StatusCode::OK);
    let slots = client.put(format!("{base}/executor-slots")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"slots":1})).send().await.unwrap();
    assert_eq!(slots.status(), reqwest::StatusCode::OK);
    for id in ["lead", "member"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("{id} fixture"),"cwd":work,"model":"","harness":"claude",
            "color":"sage","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&agent).unwrap();
        ws.store.set_agent_project(id, Some(&project)).unwrap();
    }
    let leads = client.put(format!("{base}/projects/{project}/leads")).header("X-Yuzuno-Client", "desktop")
        .json(&json!({"expectedVersion":0,"leadAgentIds":["lead"]})).send().await.unwrap();
    assert_eq!(leads.status(), reqwest::StatusCode::OK);

    // The lead dispatches two; one slot, so the second waits.
    let (mut tasks, mut executors, mut folders) = (Vec::new(), Vec::new(), Vec::new());
    for name in ["first", "second"] {
        let worktree = folder(lab.path(), name);
        let id = task(&ws, &format!("Review {name}"), &project, Some(&worktree)).await;
        let answer = ws.collaboration_call(Some("lead"), "task_dispatch", dispatch(name, &id)).await.unwrap();
        executors.push(answer["agentId"].as_str().unwrap().to_owned());
        tasks.push((id, answer["task"]["dispatch"]["id"].clone()));
        folders.push(worktree);
    }
    until("the first gets its mail", || !prompts(Path::new(&folders[0])).is_empty()).await;
    let slot = |task: &str| ws.store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"current"})).unwrap()["current"]["executorSlot"].clone();
    assert_eq!(slot(&tasks[1].0)["state"], "waiting");
    ws.collaboration_call(Some(&executors[0]), "task_submit_result", json!({"requestId":"result","taskId":tasks[0].0,"expectedVersion":2,
        "summary":"Reviewed the fixture.","dispatchId":tasks[0].1})).await.unwrap();
    // What a release must leave as it is.
    let kept = |task: &str| {
        let current = ws.store.collaboration_call(None, "task_get", json!({"taskId":task,"view":"current"})).unwrap()["current"].clone();
        json!([current["status"], current["version"], current["assignee"], current["dispatch"], current["updatedAt"],
            current["result"]["id"], current["result"]["summary"]])
    };
    let before = kept(&tasks[0].0);
    assert_eq!(before[0], "review");
    assert!(before[3]["id"].is_string() && before[5].is_string(), "{before}");

    let connect = |agent: &str| {
        let config = yuzuno_workspace::collaboration_mcp::agent_http_config(&ws, agent, &format!("http://127.0.0.1:{port}")).unwrap();
        let token = config["headers"]["Authorization"].as_str().unwrap().trim_start_matches("Bearer ").to_owned();
        StreamableHttpClientTransport::with_client(
            reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap(),
            StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp/{agent}")).auth_header(token))
    };
    let release = |request: &str| CallToolRequestParams::new("executor_release")
        .with_arguments(json!({"requestId":request,"agentId":executors[0]}).as_object().unwrap().clone());
    let lead = tokio::time::timeout(Duration::from_secs(10), ().serve(connect("lead"))).await.unwrap().unwrap();
    let member = tokio::time::timeout(Duration::from_secs(10), ().serve(connect("member"))).await.unwrap().unwrap();
    assert!(lead.list_all_tools().await.unwrap().iter().any(|t| t.name == "executor_release"), "executor_release is offered to Agents");
    let refused = member.call_tool(release("m")).await.unwrap();
    assert_eq!(refused.is_error, Some(true));
    assert!(refused.structured_content.unwrap()["error"].as_str().unwrap().starts_with("not_dispatcher:"), "another Agent is refused over MCP");
    assert!(ws.store.agent(&executors[0]).unwrap().closed_at.is_none(), "and nothing changed");

    let released = lead.call_tool(release("l")).await.unwrap().structured_content.unwrap();
    assert!(released["releasedAt"].is_string(), "{released}");
    assert_eq!(released["releasedBy"], "agent:lead", "the release names the lead that made it");
    until("the second gets its mail", || !prompts(Path::new(&folders[1])).is_empty()).await;
    assert_eq!(slot(&tasks[1].0)["state"], "running", "the freed slot starts the next one waiting");
    assert_eq!(slot(&tasks[0].0), Value::Null, "the released executor holds no slot");
    assert_eq!(ws.store.agent(&executors[0]).unwrap().closed_at.as_deref(), released["releasedAt"].as_str());
    let again = lead.call_tool(release("l")).await.unwrap().structured_content.unwrap();
    assert_eq!(again, released, "a repeat answers with the same releasedAt");

    let reopened = client.post(format!("{base}/agents/{}/reopen", executors[0])).header("X-Yuzuno-Client", "desktop")
        .json(&json!({})).send().await.unwrap();
    assert_eq!(reopened.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(reopened.json::<Value>().await.unwrap()["error"],
        "executor_released: a released executor stays closed; dispatch the task again for new work", "a released executor is not reopened");
    assert!(ws.store.agent(&executors[0]).unwrap().closed_at.is_some());
    assert_eq!(kept(&tasks[0].0), before, "its task, dispatch and result are as they were");
    let listed = client.get(format!("{base}/workspace")).header("X-Yuzuno-Client", "desktop").send().await.unwrap()
        .json::<Value>().await.unwrap();
    let listed = listed["agents"].as_array().unwrap().iter().find(|a| a["id"] == json!(executors[0])).unwrap().clone();
    assert_eq!((listed["releasedAt"].clone(), listed["releasedBy"].clone()), (released["releasedAt"].clone(), json!("agent:lead")),
        "the Agent list names the release, and who made it");

    let _ = lead.cancel().await;
    let _ = member.cancel().await;
    ws.close_agent(&executors[1]).await.unwrap();
    serving.abort();
}
