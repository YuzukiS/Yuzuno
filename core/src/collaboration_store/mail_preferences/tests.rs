use super::*;
use crate::{model::AgentDetail, store::Store};

fn agent(store: &Store, id: &str) {
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
        "cwd":"/synthetic/work","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
}

/// A task `exec` works on: its public and its internal ID.
fn task(store: &Store, title: &str) -> (String, String) {
    let created = store.collaboration_call(None, "task_create", json!({"requestId":format!("create {title}"),"title":title,"assigneeAgentId":"exec"})).unwrap();
    let public = created["task"]["id"].as_str().unwrap().to_owned();
    let internal = task_key(&store.db.read().unwrap(), &public).unwrap().0;
    (public, internal)
}

/// A merge of `task`'s PR while its executor works, to `to`: quiet by default.
fn merged(store: &Store, to: &str, task: &str, n: u32) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    insert_message(&store.db.write().unwrap(), json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
        "recipient":{"kind":"agent","id":to,"name":format!("Agent {to}")},"body":format!("Merge queue: merged #{n}."),
        "taskId":task,"replyTo":null,"threadId":id,"createdAt":now(),"source":{},"priority":"normal",
        "metadata":{"kind":"merge","entryId":format!("entry-{n}"),"status":"merged","reason":null,"mainCi":null,"entryKind":null,"name":format!("PR #{n}")}}))
        .unwrap()
}

fn set(store: &Store, agent: &str, input: Value) -> Result<Value> {
    store.collaboration_call(Some(agent), "mail_preferences", input)
}

/// YN-68 S2: an Agent reads its own preferences (the default, never set),
/// sets them by requestId, idempotently, field by field, and its quiet
/// notices ring as they say from then on; another Agent's are its own. A
/// task done, cancelled or archived no longer counts.
#[test]
fn an_agent_reads_and_sets_its_own_mail_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["lead", "exec"] {
        agent(&store, id);
    }
    let (waited, waited_id) = task(&store, "Waited for");
    let (other, other_id) = task(&store, "Other");
    let read = set(&store, "lead", json!({})).unwrap();
    assert_eq!(read["preferences"], json!({"mode":"actions","wakeForTasks":[],"updatedAt":null}), "the default: {read}");

    let refused = |actor: Option<&str>, input: Value| store.collaboration_call(actor, "mail_preferences", input).unwrap_err().to_string();
    assert!(refused(None, json!({})).starts_with("invalid_input: mail_preferences is an Agent's own"));
    assert!(refused(Some("lead"), json!({"mode":"all"})).contains("requestId"), "a change needs a requestId");
    assert!(refused(Some("lead"), json!({"requestId":"empty"})).starts_with("invalid_input: give mode or wakeForTasks"));
    assert!(refused(Some("lead"), json!({"requestId":"loud","mode":"loud"})).starts_with("invalid_input: mode must be actions or all"));
    let eleven: Vec<_> = (0..11).map(|_| json!(waited)).collect();
    assert!(refused(Some("lead"), json!({"requestId":"many","wakeForTasks":eleven})).starts_with("invalid_input: wakeForTasks names at most 10"));
    assert!(refused(Some("lead"), json!({"requestId":"none","wakeForTasks":["T-999"]})).starts_with("task_not_found"));

    let first = set(&store, "lead", json!({"requestId":"p1","wakeForTasks":[waited, waited]})).unwrap();
    assert_eq!((first["preferences"]["mode"].clone(), first["preferences"]["wakeForTasks"].clone()), (json!("actions"), json!([waited])));
    assert_eq!(set(&store, "lead", json!({"requestId":"p1","wakeForTasks":[waited, waited]})).unwrap(), first, "a retry answers the same");
    assert!(refused(Some("lead"), json!({"requestId":"p1","mode":"all"})).starts_with("idempotency_conflict"));

    // The task it named rings; another stays quiet; so does the same task for another Agent.
    let rang = merged(&store, "lead", &waited_id, 1);
    assert_eq!((rang["wake"].clone(), rang["wakeReason"].clone()), (json!("ring"), json!(crate::mail_wake::WANTED)));
    assert_eq!(merged(&store, "lead", &other_id, 2)["wake"], "quiet");
    assert_eq!(merged(&store, "exec", &waited_id, 3)["wake"], "quiet", "only the lead's own preferences changed");

    // mode all: every one rings; the tasks it named stay named.
    let all = set(&store, "lead", json!({"requestId":"p2","mode":"all"})).unwrap();
    assert_eq!((all["preferences"]["mode"].clone(), all["preferences"]["wakeForTasks"].clone()), (json!("all"), json!([waited])));
    assert_eq!(merged(&store, "lead", &other_id, 4)["wake"], "ring");
    set(&store, "lead", json!({"requestId":"p3","mode":"actions"})).unwrap();
    assert_eq!(merged(&store, "lead", &other_id, 5)["wake"], "quiet", "back to the default");

    // A task closed no longer counts.
    let version = store.collaboration_call(None, "task_get", json!({"taskId":waited})).unwrap()["task"]["version"].clone();
    store.collaboration_call(None, "task_update", json!({"requestId":"close","taskId":waited,"expectedVersion":version,"patch":{"status":"done"}})).unwrap();
    let db = store.db.read().unwrap();
    assert!(!rings(&db, "lead", Some(&load_task(&db, &waited_id).unwrap())).unwrap());
    assert!(!rings(&db, "lead", Some(&load_task(&db, &other_id).unwrap())).unwrap());
    assert!(!rings(&db, "lead", None).unwrap());
}

/// The tool's description fits the harnesses' cut, and its parameters are the three it reads.
#[test]
fn the_tool_fits_and_says_what_it_takes() {
    let tool = crate::collaboration_store::tool_definitions().into_iter().find(|t| t["name"] == "mail_preferences").unwrap();
    let description = tool["description"].as_str().unwrap();
    assert!(description.encode_utf16().count() <= crate::results::max_description_length(), "{}", description.encode_utf16().count());
    let mut properties: Vec<_> = tool["inputSchema"]["properties"].as_object().unwrap().keys().cloned().collect();
    properties.sort();
    assert_eq!(properties, ["mode", "requestId", "wakeForTasks"]);
}
