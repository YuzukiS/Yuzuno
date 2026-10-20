use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use yuzuno_workspace::{model::AgentDetail, store::Store};

fn agent(id: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":id, "name":format!("Agent {id}"), "cwd":"/workspace", "model":"", "color":"sage",
        "harness":"codex", "threadId":format!("session-{id}"), "status":"idle",
        "createdAt":"", "updatedAt":"", "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

fn call(store: &Store, operation: &str, input: Value) -> Value {
    store.collaboration_call(None, operation, input).unwrap()
}

fn create(store: &Store, n: usize, status: &str, assignee: Option<&str>, project: Option<&str>) -> String {
    let mut input = json!({"requestId":format!("c{n}"),"title":format!("Task {n}"),"status":status,"projectId":project});
    if let Some(a) = assignee {
        input["assigneeAgentId"] = json!(a);
    }
    call(store, "task_create", input)["task"]["id"].as_str().unwrap().to_owned()
}

fn ids(page: &Value) -> Vec<String> {
    page["tasks"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect()
}

fn total(page: &Value) -> i64 {
    page["counts"].as_object().unwrap().values().map(|v| v.as_i64().unwrap()).sum()
}

/// Every page until hasMore is false, with the same conditions.
fn all_pages(store: &Store, filter: Value) -> (Vec<String>, Vec<i64>) {
    let mut seen = Vec::new();
    let mut totals = Vec::new();
    let mut after = 0;
    loop {
        let mut input = filter.clone();
        input["afterSeq"] = json!(after);
        input["limit"] = json!(100);
        let page = call(store, "task_list", input);
        seen.extend(ids(&page));
        totals.push(total(&page));
        if page["hasMore"] != true {
            return (seen, totals);
        }
        after = page["nextAfterSeq"].as_i64().unwrap();
    }
}

#[test]
fn a_match_beyond_the_first_hundred_is_found_on_the_first_page() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    store.insert(&agent("mori")).unwrap();
    for n in 1..=150 {
        if n == 140 {
            create(&store, n, "doing", Some("mori"), None);
        } else {
            create(&store, n, "todo", None, None);
        }
    }
    let page = call(&store, "task_list", json!({"limit":100,"status":"doing","assigneeAgentId":"mori"}));
    assert_eq!(ids(&page), vec!["T-140"], "filtered before paging, not within the first 100");
    assert_eq!(page["hasMore"], false);
    assert_eq!(total(&page), 1);
    let open = call(&store, "task_list", json!({"limit":100,"statuses":["doing","blocked"]}));
    assert_eq!(ids(&open), vec!["T-140"]);
}

#[test]
fn matches_spanning_pages_arrive_once_each_with_the_same_total() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    store.insert(&agent("hana")).unwrap();
    let mut expected = BTreeSet::new();
    // 210 tasks, 137 of them owned by Hana and open, interleaved with others.
    let mut owned = 0;
    for n in 1..=210 {
        let mine = owned < 137 && n % 3 != 0;
        let status = ["todo", "doing", "blocked", "review"][n % 4];
        let id = if mine {
            owned += 1;
            create(&store, n, status, Some("hana"), None)
        } else {
            create(&store, n, if n % 2 == 0 { "done" } else { status }, None, None)
        };
        if mine {
            expected.insert(id);
        }
    }
    assert_eq!(expected.len(), 137);
    let (seen, totals) = all_pages(&store, json!({"assigneeAgentId":"hana","statuses":["todo","doing","blocked","review"]}));
    assert_eq!(seen.len(), 137, "no duplicates and nothing missing");
    assert_eq!(seen.iter().cloned().collect::<BTreeSet<_>>(), expected);
    assert_eq!(totals, vec![137, 137], "two pages, each reporting the full matching total");
}

#[test]
fn open_statuses_respect_archive_and_combine_with_project_and_owner() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    store.insert(&agent("mori")).unwrap();
    let app = store.create_project("App", BTreeMap::new()).unwrap().id;
    let mut by_status = BTreeMap::new();
    for (n, status) in ["todo", "doing", "blocked", "review", "done", "cancelled"].iter().enumerate() {
        by_status.insert(*status, create(&store, n + 1, status, Some("mori"), Some(&app)));
        create(&store, n + 11, status, None, None);
    }
    // An archived open task is excluded unless archived tasks are asked for.
    let archived = create(&store, 30, "doing", Some("mori"), Some(&app));
    call(&store, "task_update", json!({"requestId":"arch","taskId":archived,"expectedVersion":1,"patch":{"archived":true}}));
    let open = json!(["todo", "doing", "blocked", "review"]);

    let mine = call(&store, "task_list", json!({"statuses":open,"assigneeAgentId":"mori","projectId":app}));
    let expect: Vec<String> = ["todo", "doing", "blocked", "review"].iter().map(|s| by_status[s].clone()).collect();
    assert_eq!(ids(&mine), expect);
    assert_eq!(mine["counts"], json!({"todo":1,"doing":1,"blocked":1,"review":1,"done":0,"cancelled":0}));
    let everyone = call(&store, "task_list", json!({"statuses":open}));
    assert_eq!(ids(&everyone).len(), 8, "both owners, both projects");
    let loose = call(&store, "task_list", json!({"statuses":open,"projectId":null}));
    assert_eq!(ids(&loose).len(), 4);
    let loose_mine = call(&store, "task_list", json!({"statuses":open,"projectId":null,"assigneeAgentId":"mori"}));
    assert!(ids(&loose_mine).is_empty(), "a real empty result");
    assert_eq!(total(&loose_mine), 0);
    let shelf = call(&store, "task_list", json!({"statuses":open,"archived":true}));
    assert_eq!(ids(&shelf), vec![archived]);
    // The single-status form is unchanged for existing clients.
    let done = call(&store, "task_list", json!({"status":"done","assigneeAgentId":"mori"}));
    assert_eq!(ids(&done), vec![by_status["done"].clone()]);
    let all = call(&store, "task_list", json!({}));
    assert_eq!(total(&all), 12);
}

#[test]
fn malformed_status_filters_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    for (input, message) in [
        (json!({"status":"todo","statuses":["doing"]}), "status or statuses"),
        (json!({"statuses":[]}), "must not be empty"),
        (json!({"statuses":["todo","todo"]}), "duplicate"),
        (json!({"statuses":["open"]}), "invalid task status"),
        (json!({"statuses":[1]}), "must be strings"),
        (json!({"statuses":"todo"}), "must be an array"),
        (json!({"statuses":null}), "must be an array"),
    ] {
        let error = store.collaboration_call(None, "task_list", input.clone()).unwrap_err().to_string();
        assert!(error.contains(message), "{input} → {error}");
    }
    let schema = yuzuno_workspace::collaboration_store::tool_definitions()
        .into_iter().find(|t| t["name"] == "task_list").unwrap();
    assert_eq!(schema["inputSchema"]["properties"]["statuses"]["type"], "array");
}
