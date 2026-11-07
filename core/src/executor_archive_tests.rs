use super::*;
use crate::{collaboration_store::insert_message, model::AgentDetail, store::Store};

fn agent(store: &Store, id: &str) {
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
        "cwd":"/synthetic/work","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
}

fn close(store: &Store, id: &str) {
    store.update(id, "agent/closed", &json!({}), |d| d.agent.closed_at = Some("then".into())).unwrap();
}

/// A task (its public ID) and its internal ID.
fn task(store: &Store, title: &str) -> (String, String) {
    let created = store.collaboration_call(None, "task_create", json!({"requestId":format!("create {title}"),"title":title})).unwrap();
    let public = created["task"]["id"].as_str().unwrap().to_owned();
    let internal = task_key(&store.db.read().unwrap(), &public).unwrap().0;
    (public, internal)
}

/// `id`, the executor of `task` that `by` dispatched (an actor key, as
/// executor_dispatches writes it); archived and closed, as a release leaves
/// it, when `archived`.
fn executor(store: &Store, id: &str, task: &str, by: &str, archived: bool) {
    agent(store, id);
    store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,archived_at,created_at,updated_at)
         VALUES(?1,'executor','reviewer',?2,?3,?4,'now','now')",
        params![id, task, by, archived.then_some("then")],
    ).unwrap();
    if archived {
        close(store, id);
    }
}

/// A Job's result mail, as jobs/store.rs writes it.
fn job_result(to: &str, job: &str) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
        "recipient":{"kind":"agent","id":to,"name":format!("Agent {to}")},"body":format!("Job {job} succeeded."),
        "taskId":null,"replyTo":null,"threadId":id,"createdAt":"now","source":{"jobId":job,"attempt":"attempt-1"},
        "priority":"normal","jobId":job,"metadata":{"kind":"job","status":"succeeded","jobId":job,"attempt":"attempt-1","name":job}})
}

fn inbox(store: &Store, agent: &str) -> Vec<Value> {
    let read = store.collaboration_call(None, "peer_read", json!({"agentId":agent})).unwrap();
    read["messages"].as_array().unwrap().clone()
}

/// T-36: Core's own mail to an archived executor (here a Job's result) goes
/// to the Agent that dispatched it, which it names as its original
/// recipient; its doorbell is still a Job's. An executor not archived gets
/// its own mail, and so does one the user dispatched: there is no Agent to
/// send that to.
#[test]
fn core_mail_to_an_archived_executor_goes_to_its_dispatcher_naming_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    agent(&store, "lead");
    let (_, t) = task(&store, "Review");
    executor(&store, "exec", &t, "agent:lead", true);
    executor(&store, "open", &t, "agent:lead", false);
    executor(&store, "mine", &t, "user", true);
    for (to, job) in [("exec", "job-a"), ("open", "job-b"), ("mine", "job-c")] {
        insert_message(&store.db.write().unwrap(), job_result(to, job)).unwrap();
    }
    let lead = inbox(&store, "lead");
    assert_eq!(lead.len(), 1, "only the archived executor's mail comes to its dispatcher: {lead:?}");
    assert_eq!(lead[0]["jobId"], "job-a");
    assert_eq!(lead[0]["recipient"], json!({"kind":"agent","id":"lead","name":"Agent lead"}));
    assert_eq!(lead[0]["originalRecipient"], json!({"kind":"agent","id":"exec","name":"Agent exec"}), "the mail names its original recipient");
    assert!(lead[0]["body"].as_str().unwrap().starts_with("Sent to Agent exec, the archived executor of T-1 you dispatched"),
        "{}", lead[0]["body"]);
    assert!(lead[0]["body"].as_str().unwrap().ends_with("Job job-a succeeded."), "the mail itself follows");
    assert_eq!((lead[0]["notice"]["kind"].as_str(), lead[0]["notice"]["status"].as_str()), (Some("job"), Some("succeeded")));
    assert!(inbox(&store, "exec").is_empty(), "nothing waits on the archived executor");
    assert_eq!(inbox(&store, "open")[0]["jobId"], "job-b", "an executor not archived gets its own mail");
    assert_eq!(inbox(&store, "mine")[0]["jobId"], "job-c", "one the user dispatched keeps its mail");
    let mut wait = job_result("exec", "update");
    wait["metadata"] = json!({"kind":"update_wait","operationId":"op"});
    insert_message(&store.db.write().unwrap(), wait).unwrap();
    assert_eq!(inbox(&store, "lead").len(), 1, "an update's request to end a Turn is not passed on");
}

/// T-36: an Agent's or the user's mail to an archived executor, and a
/// dispatch naming it, is refused with `executor_archived`, its task and who
/// to write to instead, and nothing is written. Mail to an executor not
/// archived goes as before.
#[test]
fn mail_and_a_dispatch_to_an_archived_executor_are_refused_with_its_task() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    agent(&store, "lead");
    agent(&store, "peer");
    let (_, t) = task(&store, "Review");
    let (other, _) = task(&store, "Another");
    executor(&store, "exec", &t, "agent:lead", true);
    executor(&store, "open", &t, "agent:lead", false);
    executor(&store, "mine", &t, "user", true);
    let refused = |actor: Option<&str>, operation: &str, input: Value| match store.collaboration_call(actor, operation, input) {
        Ok(answer) => panic!("{operation} to an archived executor is refused, not answered: {answer}"),
        Err(error) => error.to_string(),
    };
    for actor in [Some("peer"), None] {
        let error = refused(actor, "peer_send", json!({"requestId":"to exec","toAgentId":"exec","body":"One more thing"}));
        assert_eq!(error, "executor_archived: Agent exec is archived since T-1's work was released, and takes no more mail or work \
            (taskId T-1); write to Agent lead, who dispatched it, or dispatch the task again", "{actor:?}");
    }
    let error = refused(None, "task_dispatch", json!({"requestId":"again","taskId":other,"expectedVersion":1,"toAgentId":"exec"}));
    assert!(error.starts_with("executor_archived: Agent exec is archived since T-1's work"), "a dispatch names it archived, not closed: {error}");
    let error = refused(Some("peer"), "peer_send", json!({"requestId":"to mine","toAgentId":"mine","body":"Hello"}));
    assert!(error.ends_with("(taskId T-1); dispatch the task again for new work"), "{error}");
    assert!(inbox(&store, "exec").is_empty() && inbox(&store, "mine").is_empty(), "nothing was written");
    let task = store.collaboration_call(None, "task_get", json!({"taskId":other})).unwrap();
    assert_eq!((task["task"]["version"].as_i64(), task["task"]["dispatch"].is_null()), (Some(1), true), "the dispatch changed nothing");
    store.collaboration_call(Some("peer"), "peer_send", json!({"requestId":"to open","toAgentId":"open","body":"Hello"})).unwrap();
    assert_eq!(inbox(&store, "open").len(), 1);
}

/// T-36: an executor does not set its own task done, archived or not: it
/// submits its result, and the Agent that dispatched it, or the user,
/// decides. It may set any other status, and another task's done is as
/// before.
#[test]
fn an_executor_cannot_set_its_own_task_done_but_its_dispatcher_and_the_user_can() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    agent(&store, "lead");
    let (public, t) = task(&store, "Review");
    let (other, _) = task(&store, "Another");
    executor(&store, "exec", &t, "agent:lead", false);
    let update = |actor: Option<&str>, request: &str, task: &str, version: i64, status: &str| {
        store.collaboration_call(actor, "task_update",
            json!({"requestId":request,"taskId":task,"expectedVersion":version,"patch":{"status":status}}))
    };
    let error = match update(Some("exec"), "done", &public, 1, "done") {
        Ok(answer) => panic!("the executor's own done is refused, not saved: {answer}"),
        Err(error) => error.to_string(),
    };
    assert!(error.starts_with("executor_done_refused: an executor does not set its own task done"), "{error}");
    let task = store.collaboration_call(None, "task_get", json!({"taskId":public})).unwrap();
    assert_eq!((task["task"]["status"].as_str(), task["task"]["version"].as_i64()), (Some("todo"), Some(1)), "nothing changed");
    update(Some("exec"), "review", &public, 1, "review").unwrap();
    update(Some("exec"), "other done", &other, 1, "done").unwrap();
    update(Some("lead"), "accepted", &public, 2, "done").unwrap();
    update(None, "reopened", &public, 3, "doing").unwrap();
    update(None, "done by the user", &public, 4, "done").unwrap();
}

/// T-36 (#622 R2 5d030b12): nor through its result. An executor's
/// task_submit_result with status done is refused and writes nothing; with
/// review it goes through, and its dispatcher then sets the task done.
#[test]
fn an_executor_cannot_submit_its_own_task_as_done_only_as_review() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    agent(&store, "lead");
    let (public, t) = task(&store, "Review");
    executor(&store, "exec", &t, "agent:lead", false);
    let submit = |request: &str, version: i64, status: &str| store.collaboration_call(Some("exec"), "task_submit_result",
        json!({"requestId":request,"taskId":public,"expectedVersion":version,"summary":"Merged; checks passed.","status":status}));
    let error = match submit("done", 1, "done") {
        Ok(answer) => panic!("the executor's done result is refused, not saved: {answer}"),
        Err(error) => error.to_string(),
    };
    assert!(error.starts_with("executor_done_refused: an executor does not set its own task done") && error.contains("status review"), "{error}");
    let task = store.collaboration_call(None, "task_get", json!({"taskId":public})).unwrap();
    assert_eq!((task["task"]["status"].as_str(), task["task"]["version"].as_i64(), task["task"]["result"].is_null()),
        (Some("todo"), Some(1), true), "nothing was written: {}", task["task"]);
    let reviewed = submit("review", 1, "review").unwrap();
    assert_eq!(reviewed["task"]["status"], "review", "a review result goes through");
    let version = reviewed["task"]["version"].as_i64().unwrap();
    store.collaboration_call(Some("lead"), "task_update",
        json!({"requestId":"accepted","taskId":public,"expectedVersion":version,"patch":{"status":"done"}})).unwrap();
}
