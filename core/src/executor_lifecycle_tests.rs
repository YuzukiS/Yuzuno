use super::*;
use crate::model::AgentDetail;
use crate::store::Store;
use rusqlite::params;
use std::sync::Arc;

fn workspace() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    // No runtime runs: these Agents are Codex Agents that never started.
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(),
        dir.path().join("no-codex").to_string_lossy().into()).unwrap();
    (dir, ws)
}

fn agent(store: &Store, id: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
        "model":"","harness":"codex","color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
}

/// A task (its public ID) and its internal ID.
pub(crate) fn task(store: &Store, title: &str) -> (String, String) {
    let created = store.collaboration_call(None, "task_create", json!({"requestId":format!("create {title}"),"title":title})).unwrap();
    let public = created["task"]["id"].as_str().unwrap().to_owned();
    let internal = crate::collaboration_store::task_key(&store.db.read().unwrap(), &public).unwrap().0;
    (public, internal)
}

/// Executor `id` of `task`, dispatched by `by` on dispatch `dispatch`, which
/// is its task's newest; its slot in `slot` state, with `reason`.
fn executor(store: &Store, id: &str, task: &str, by: &str, dispatch: &str, slot: &str, reason: Option<&str>) {
    agent(store, id);
    role(store, id, task, by, dispatch, slot, reason);
}

/// `executor`'s rows for an Agent that exists: its role, its task's newest
/// dispatch, its slot.
pub(crate) fn role(store: &Store, id: &str, task: &str, by: &str, dispatch: &str, slot: &str, reason: Option<&str>) {
    let db = store.db.write().unwrap();
    db.execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,task_id,dispatch_id,created_by,state,created_at,updated_at)
         VALUES(?1,'executor','reviewer',?2,?3,?4,'dispatched','2026-11-06T01:00:00Z','2026-11-06T01:00:00Z')",
        params![id, task, dispatch, by],
    ).unwrap();
    db.execute(
        "INSERT INTO collaboration_task_activity(task_id,data) VALUES(?1,?2)",
        params![task, json!({"kind":"dispatched","dispatch":{"id":dispatch,"requestedBy":{"kind":"user","id":"user","name":"You"},
            "notificationRecipient":null,"executor":{"kind":"agent","id":id,"name":format!("Agent {id}")},"source":{},
            "dispatchedAt":"2026-11-06T01:00:00Z","active":true,"invalidatedAt":null,"invalidatedReason":null}}).to_string()],
    ).unwrap();
    let seq: i64 = db.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM executor_slots", [], |r| r.get(0)).unwrap();
    db.execute(
        "INSERT INTO executor_slots(agent_id,seq,task_id,machine_id,template_id,state,since,queued_at,reason)
         VALUES(?1,?2,?3,'local','reviewer',?4,'2026-11-06T01:00:00Z','2026-11-06T01:00:00Z',?5)",
        params![id, seq, task, slot, reason],
    ).unwrap();
}

/// Its task's status set to `status`, with a result on `dispatch` when given.
pub(crate) fn task_is(store: &Store, task: &str, status: &str, blocker: &str, result_on: Option<&str>) {
    let result = result_on.map(|dispatch| json!({"dispatchId":dispatch,"reportedAt":"2026-11-06T02:00:00Z"}));
    store.db.write().unwrap().execute(
        "UPDATE collaboration_tasks SET data=json_set(data,'$.status',?2,'$.blocker',?3,'$.result',json(?4)) WHERE id=?1",
        params![task, status, blocker, result.map_or("null".to_owned(), |r| r.to_string())],
    ).unwrap();
}

fn close(store: &Store, id: &str) {
    store.update(id, "test/closed", &json!({}), |d| d.agent.closed_at = Some(crate::model::now())).unwrap();
}

fn listed(store: &Store, id: &str) -> Value {
    store.agents().unwrap().into_iter().find(|a| a.id == id).and_then(|a| a.executor).unwrap_or(Value::Null)
}

/// Facts for an open executor at work in its slot, on a task being done.
fn at_work() -> Facts {
    Facts {
        archived_at: None,
        archiving: None,
        closed: false,
        slot: Some(("running".into(), None, "s".into())),
        task_status: "doing".into(),
        task_blocker: String::new(),
        task_updated_at: "u".into(),
        holds_newest_dispatch: true,
        result_at: None,
    }
}

/// T-36 S3: each state is the first rule of docs/executor-model.md's
/// lifecycle table that holds, in its order.
#[test]
fn each_state_is_the_first_rule_that_holds_in_the_tables_order() {
    let named = |change: &dyn Fn(&mut Facts)| {
        let mut facts = at_work();
        change(&mut facts);
        state(&facts)
    };
    let state_of = |change: &dyn Fn(&mut Facts)| named(change).0;
    assert_eq!(state_of(&|_| {}), "running");
    assert_eq!(state_of(&|f| f.slot = Some(("waiting".into(), None, "s".into()))), "queued");
    assert_eq!(state_of(&|f| f.slot = Some(("starting".into(), None, "s".into()))), "starting", "a start in flight is not failed");
    assert_eq!(named(&|f| f.slot = Some(("starting".into(), Some("uncertain".into()), "s".into()))),
        ("failed", Some("s".into()), Some("uncertain".into())), "held open with its reason: failed");
    assert_eq!(named(&|f| { f.task_status = "review".into(); f.result_at = Some("r".into()) }), ("delivering", Some("r".into()), None));
    assert_eq!(state_of(&|f| f.result_at = Some("r".into())), "running", "its result in, but its task sent back: at work again");
    assert_eq!(state_of(&|f| f.task_status = "review".into()), "running", "in review on another's result");
    let blocked = |f: &mut Facts| { f.closed = true; f.task_status = "blocked".into(); f.task_blocker = "Both starts failed".into() };
    assert_eq!(named(&blocked), ("failed", Some("u".into()), Some("Both starts failed".into())), "closed while its task is blocked on it");
    assert_eq!(state_of(&|f| { blocked(f); f.holds_newest_dispatch = false }), "closed", "blocked on another executor: only closed");
    assert_eq!(state_of(&|f| f.closed = true), "closed");
    assert_eq!(state_of(&|f| { f.closed = true; f.slot = Some(("starting".into(), Some("x".into()), "s".into())) }), "closed",
        "a closed start's reason is not a held one");
    let archiving = |f: &mut Facts| f.archiving = Some(("a".into(), "Waiting to close: a Job is still running.".into()));
    assert_eq!(named(&|f| { archiving(f); blocked(f) }), ("archiving", Some("a".into()), Some("Waiting to close: a Job is still running.".into())),
        "being released comes before failed and closed");
    assert_eq!(named(&|f| { archiving(f); f.closed = true; f.archived_at = Some("z".into()) }), ("archived", Some("z".into()), None),
        "archived comes first");
}

/// T-36 S3: the Agent listing and the task's views carry each executor's
/// lifecycle: its state, task, dispatcher and, while queued, its place.
#[tokio::test]
async fn the_listing_and_its_task_show_each_executors_lifecycle() {
    let (_dir, ws) = workspace();
    let s = &ws.store;
    agent(s, "lead");
    let (queued_public, queued) = task(s, "Queued work");
    let (review_public, review) = task(s, "Reviewed work");
    executor(s, "e1", &queued, "user", "d1", "waiting", None);
    executor(s, "e2", &review, "agent:lead", "d2", "running", None);
    task_is(s, &review, "review", "", Some("d2"));
    let e1 = listed(s, "e1");
    assert_eq!((e1["state"].as_str(), e1["position"].as_i64()), (Some("queued"), Some(1)), "{e1}");
    assert_eq!(e1["dispatcher"], json!({"kind":"user"}));
    assert_eq!(e1["task"], json!({"id":queued_public,"title":"Queued work"}));
    let e2 = listed(s, "e2");
    assert_eq!((e2["state"].as_str(), e2["since"].as_str()), (Some("delivering"), Some("2026-11-06T02:00:00Z")), "{e2}");
    assert_eq!(e2["dispatcher"], json!({"kind":"agent","id":"lead","name":"Agent lead"}));
    assert!(listed(s, "lead").is_null(), "a standing Agent has none");
    let read = s.collaboration_call(None, "task_get", json!({"taskId":review_public})).unwrap();
    assert_eq!(read["task"]["executor"]["state"], "delivering", "task_get has it: {}", read["task"]);
    let list = s.collaboration_call(None, "task_list", json!({})).unwrap();
    let shown: Vec<_> = list["tasks"].as_array().unwrap().iter().map(|t| (t["title"].clone(), t["executor"]["state"].clone())).collect();
    assert!(shown.contains(&(json!("Queued work"), json!("queued"))) && shown.contains(&(json!("Reviewed work"), json!("delivering"))),
        "task_list has it: {shown:?}");
    // Its task blocked while it runs: the blocker, its state as it was.
    task_is(s, &queued, "blocked", "Waiting for a licence", None);
    assert_eq!(listed(s, "e1")["blocked"], "Waiting for a licence");
    assert_eq!(listed(s, "e1")["state"], "queued");
    close(s, "e1");
    assert_eq!(listed(s, "e1")["state"], "failed", "closed while its task is blocked on it");
}

/// T-43 S2 (g8): the sidebar names an executor's task by the key it has now,
/// as the executor's own name, Home's live references and task_get do, not
/// `T-<n>`; and it says which template the executor was made from (its
/// dispatch's materials' label) and when it was dispatched.
#[tokio::test]
async fn the_listing_names_its_task_by_its_key_and_its_template_by_its_label() {
    let (_dir, ws) = workspace();
    let s = &ws.store;
    let project = s.create_project("yuzuno-next", Default::default()).unwrap();
    assert_eq!(project.key.as_deref(), Some("YN"));
    let created = s.collaboration_call(None, "task_create", json!({"requestId":"keyed","title":"Keyed work","projectId":project.id})).unwrap();
    let public = created["task"]["id"].as_str().unwrap().to_owned();
    assert_eq!(public, "YN-1");
    let internal = crate::collaboration_store::task_key(&s.db.read().unwrap(), &public).unwrap().0;
    executor(s, "e1", &internal, "user", "d1", "running", None);
    s.db.write().unwrap().execute(
        "INSERT INTO executor_dispatches(actor,request_id,input_json,task_id,template_id,project_id,machine_id,template_json,agent_id,state,created_at,updated_at)
         VALUES('user','r1','{}',?1,'reviewer',?2,'local',?3,'e1','dispatched','now','now')",
        params![internal, project.id, json!({"id":"reviewer","label":"Reviewer","source":"workspace"}).to_string()],
    ).unwrap();
    let e1 = listed(s, "e1");
    assert_eq!(e1["task"], json!({"id":"YN-1","title":"Keyed work"}), "its key, not T-<n>, and no short name until given: {e1}");
    // A short name given (T-43): the row says what it is doing by it.
    let version = s.collaboration_call(None, "task_get", json!({"taskId":"YN-1","view":"current"})).unwrap()["current"]["version"].clone();
    s.collaboration_call(None, "task_update", json!({"requestId":"named","taskId":"YN-1","expectedVersion":version,
        "patch":{"shortName":"Keyed export"}})).unwrap();
    assert_eq!(listed(s, "e1")["task"]["shortName"], "Keyed export");
    assert_eq!(e1["template"], json!({"id":"reviewer","label":"Reviewer"}), "{e1}");
    assert_eq!(e1["dispatchedAt"], "2026-11-06T01:00:00Z", "{e1}");
    // One made before its dispatch row was kept still names its template.
    executor(s, "e2", &internal, "user", "d2", "running", None);
    assert_eq!(listed(s, "e2")["template"], json!({"id":"reviewer","label":null}));
}

/// T-36 S3: a task write naming an executor as its assignee announces it:
/// its Agent, so the sidebar and Home read it again, and the task board.
/// Only a write that can move its lifecycle does (#647 R1 333f9680): a
/// progress-only update announces nothing.
#[tokio::test]
async fn a_task_write_for_an_executor_announces_its_lifecycle() {
    let (_dir, ws) = workspace();
    let (public, internal) = task(&ws.store, "Work");
    executor(&ws.store, "e1", &internal, "user", "d1", "running", None);
    agent(&ws.store, "plain");
    let (other, _) = task(&ws.store, "Other work");
    let claim = |task: &str| json!({"requestId":format!("claim {task}"),"taskId":task,"expectedVersion":1});
    ws.collaboration_call(Some("e1"), "task_claim", claim(&public)).await.unwrap();
    ws.collaboration_call(Some("plain"), "task_claim", claim(&other)).await.unwrap();
    let mut events = ws.changes.subscribe(None);
    let mut announced = || {
        let mut seen = vec![];
        while let Some(entry) = events.try_next() {
            let event: Value = serde_json::from_str(&entry.data).unwrap();
            if event["type"] == "agent.changed" || event["scope"] == "executors" {
                seen.push(event["agentId"].as_str().map_or_else(|| event["scope"].as_str().unwrap().to_owned(), str::to_owned));
            }
        }
        seen
    };
    let progress = json!({"requestId":"progress","taskId":public,"expectedVersion":2,"patch":{"progress":"Halfway through"}});
    ws.collaboration_call(Some("e1"), "task_update", progress).await.unwrap();
    assert!(announced().is_empty(), "a progress-only update announces nothing");
    let blocked = |task: &str, version: i64| json!({"requestId":format!("block {task}"),"taskId":task,"expectedVersion":version,
        "patch":{"status":"blocked","blocker":"Waiting for a licence"}});
    ws.collaboration_call(Some("e1"), "task_update", blocked(&public, 3)).await.unwrap();
    ws.collaboration_call(Some("plain"), "task_update", blocked(&other, 2)).await.unwrap();
    assert_eq!(announced(), vec!["e1".to_owned(), "executors".to_owned()], "the executor's, once; the plain Agent's task write, none");
    assert_eq!(listed(&ws.store, "e1")["blocked"], "Waiting for a licence");
}

/// T-36 S3 (#647 R1 333f9680): which task writes can move an executor's
/// lifecycle: a result, a dispatch, a claim, and an update of the status or
/// the blocker; not a progress-only update, nor a new task.
#[test]
fn only_a_write_that_can_move_a_lifecycle_announces_it() {
    let update = |changes: Value| json!({"activity":{"changes":changes}});
    assert!(!moves("task_update", &update(json!({"progress":"Halfway"}))), "a progress-only update");
    assert!(!moves("task_update", &update(json!({"title":"Renamed","description":"More"}))), "a title or description");
    assert!(moves("task_update", &update(json!({"status":"review"}))), "a status");
    assert!(moves("task_update", &update(json!({"blocker":"Waiting for the keys"}))), "a blocker");
    for call in ["task_submit_result", "task_dispatch", "task_claim"] {
        assert!(moves(call, &json!({})), "{call}");
    }
    assert!(!moves("task_create", &json!({})), "a new task has no executor yet");
    assert!(!moves("task_comment", &json!({})), "a comment");
}

/// YN-57 S4a: what routing gave each executor, for its row's card, from its
/// dispatch's record (`route_json`), its template and what it starts with.
/// Synthetic ids only; a key by its id and an account by number and fingerprint.
#[tokio::test]
async fn the_listing_says_what_routing_gave_each_executor() {
    use crate::routing_launch::RuntimeProfile;
    let (_dir, ws) = workspace();
    let s = &ws.store;
    let (_, task) = task(s, "Routed work");
    /// Executor `id` running `harness` · `model` (and `effort`), with its dispatch row: `template` its materials'
    /// template, `route` routing's record of it (None: not routed).
    let routed = |id: &str, harness: &str, model: &str, effort: Option<&str>, template: Value, route: Option<Value>| {
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
            "model":model,"harness":harness,"color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0,
            "settings":{"reasoningEffort":effort,"approvalPolicy":"on-request","sandbox":"workspace-write"}},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        s.insert(&detail).unwrap();
        role(s, id, &task, "user", &format!("d-{id}"), "running", None);
        s.db.write().unwrap().execute(
            "INSERT INTO executor_dispatches(actor,request_id,input_json,task_id,template_id,project_id,machine_id,template_json,agent_id,state,created_at,updated_at,route_json)
             VALUES('user',?1,'{}',?2,'reviewer',NULL,'local',?3,?4,'dispatched','now','now',?5)",
            params![format!("r-{id}"), task, template.to_string(), id, route.map(|r| r.to_string())],
        ).unwrap();
    };
    let reviewer = json!({"id":"reviewer","label":"Reviewer","source":"workspace"});
    let candidate = |id: &str, label: Option<&str>| json!({"id":id,"label":label,"harness":"x","model":"y","state":"chosen","reasons":[],"readings":[]});
    routed("e-key", "opencode", "deepseek/deepseek-flash", None, reviewer.clone(),
        Some(json!({"at":"dispatch","chosen":"c-ds","candidates":[candidate("c-ds", Some("DeepSeek off-peak"))]})));
    s.set_runtime_profile("e-key", Some(&RuntimeProfile::ApiKey { key_id: "deepseek-main".into() })).unwrap();
    routed("e-pool", "claude", "opus", None, reviewer.clone(),
        Some(json!({"at":"dispatch","chosen":"c-cl","account":{"number":2,"fingerprint":"0f1e2d3c4b5a6978"},"candidates":[candidate("c-cl", None)]})));
    s.set_runtime_profile("e-pool", Some(&RuntimeProfile::ClaudeAccount { fingerprint: "0f1e2d3c4b5a6978".into() })).unwrap();
    routed("e-home", "codex", "gpt-6.1-sol", Some("high"), reviewer.clone(),
        Some(json!({"at":"start","chosen":"c-cx","candidates":[candidate("c-cx", Some("  "))]})));
    s.set_runtime_profile("e-home", Some(&RuntimeProfile::CodexHome { id: "work".into() })).unwrap();
    routed("e-login", "codex", "gpt-6.1-sol", None, reviewer.clone(), Some(json!({"at":"dispatch","chosen":"c-sub","candidates":[]})));
    routed("e-wait", "opencode", "", None, reviewer.clone(),
        Some(json!({"at":"dispatch","chosen":null,"waiting":true,"earliest":{"at":"2026-11-09T04:00:00Z","candidate":"c-ds"},"candidates":[]})));
    routed("e-wait-open", "opencode", "", None, reviewer.clone(), Some(json!({"at":"dispatch","chosen":null,"waiting":true,"candidates":[]})));
    // YN-70: a tier and whose it is go with the summary, whatever its kind.
    routed("e-fast", "opencode", "deepseek/deepseek-flash", None, reviewer.clone(),
        Some(json!({"at":"dispatch","chosen":"c-ds","tier":"fast","tierSource":"template","candidates":[]})));
    routed("e-fast-wait", "opencode", "", None, reviewer.clone(),
        Some(json!({"at":"dispatch","chosen":null,"waiting":true,"tier":"strong","tierSource":"lead","candidates":[]})));
    // Released as release_waiting writes it: its reason an object (R1 e7dfa1a9).
    let waits = crate::routing_policy::dispatch::WaitingExecutor { agent: "e-released".into(), harness: "claude".into(),
        machine: "local".into(), project: None, route: json!({"waiting":true}), unstarted: true, unavailable: vec![] };
    let mut released = crate::routing_policy::dispatch::release_reason(&json!({"enabled":true,"candidates":[]}), &waits).unwrap();
    released["at"] = json!("2026-11-09T01:00:00Z");
    routed("e-released", "claude", "", None, reviewer.clone(),
        Some(json!({"at":"dispatch","chosen":null,"waiting":false,"released":released,"candidates":[]})));
    let mut off = crate::routing_policy::dispatch::release_reason(&json!({"enabled":false}), &waits).unwrap();
    off["at"] = json!("2026-11-09T01:00:00Z");
    routed("e-released-off", "claude", "", None, reviewer.clone(),
        Some(json!({"at":"dispatch","chosen":null,"waiting":false,"released":off,"candidates":[]})));
    routed("e-fixed", "claude", "opus", None, json!({"id":"reviewer","label":"Reviewer","routing":"fixed"}), None);
    routed("e-off", "codex", "", None, reviewer.clone(), None);
    // On a task of its own: a task's view shows its newest dispatch's executor.
    let (_, older) = super::tests::task(s, "Older work");
    executor(s, "e-old", &older, "user", "d-old", "running", None);

    assert_eq!(listed(s, "e-key")["route"], json!({"kind":"chosen","candidate":"c-ds","label":"DeepSeek off-peak","harness":"opencode",
        "model":"deepseek/deepseek-flash","credential":{"kind":"apiKey","keyId":"deepseek-main"}}));
    assert_eq!(listed(s, "e-pool")["route"], json!({"kind":"chosen","candidate":"c-cl","harness":"claude","model":"opus",
        "credential":{"kind":"pool","account":{"fingerprint":"0f1e2d3c4b5a6978","number":2}}}), "an account by number and fingerprint");
    assert_eq!(listed(s, "e-home")["route"], json!({"kind":"chosen","candidate":"c-cx","harness":"codex","model":"gpt-6.1-sol","effort":"high",
        "credential":{"kind":"codexHome","id":"work"}}), "a blank label is none");
    assert_eq!(listed(s, "e-login")["route"]["credential"], json!({"kind":"login"}), "no profile: the host's login");
    assert_eq!(listed(s, "e-wait")["route"], json!({"kind":"waiting","earliest":"2026-11-09T04:00:00Z"}));
    assert_eq!(listed(s, "e-wait-open")["route"], json!({"kind":"waiting"}));
    assert_eq!(listed(s, "e-fast")["route"], json!({"kind":"chosen","candidate":"c-ds","harness":"opencode","model":"deepseek/deepseek-flash",
        "credential":{"kind":"login"},"tier":"fast","tierSource":"template"}), "its tier and whose (YN-70)");
    assert_eq!(listed(s, "e-fast-wait")["route"], json!({"kind":"waiting","tier":"strong","tierSource":"lead"}));
    assert_eq!(listed(s, "e-released")["route"], json!({"kind":"unrouted","why":"noCandidate"}));
    assert_eq!(listed(s, "e-released-off")["route"], json!({"kind":"unrouted","why":"routingOff"}));
    assert_eq!(listed(s, "e-fixed")["route"], json!({"kind":"unrouted","why":"fixed"}));
    assert_eq!(listed(s, "e-off")["route"], json!({"kind":"unrouted","why":"none"}), "no record says it wasn't routed, not that routing was off");
    assert!(listed(s, "e-old").get("route").is_none(), "one made before its dispatch row was kept says nothing of routing");
    assert_eq!(listed(s, "e-key")["template"], json!({"id":"reviewer","label":"Reviewer"}), "its template, from the same row");
    // A task's view of its executor (its newest dispatch's, e-off here) says it too.
    let views = for_tasks(&s.db.read().unwrap(), &[task.as_str()]).unwrap();
    assert_eq!(views[&task]["route"], json!({"kind":"unrouted","why":"none"}), "{}", views[&task]);
}
