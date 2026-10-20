use super::*;
use crate::{model::AgentDetail, store::Store};
use std::collections::HashSet;

struct Fixture {
    _dir: tempfile::TempDir,
    store: Store,
    projects: [String; 2],
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        for id in ["a", "b"] {
            let detail: AgentDetail = serde_json::from_value(json!({"agent":{
                "id":id,"name":id,"cwd":"/fixture","model":"test","color":"sage","status":"idle",
                "createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0
            },"turns":[],"pending":[],"artifacts":[]})).unwrap();
            store.insert(&detail).unwrap();
        }
        let projects =
            ["One", "Two"].map(|name| store.create_project(name, BTreeMap::new()).unwrap().id);
        for (n, project) in [Some(&projects[0]), Some(&projects[1]), None]
            .into_iter()
            .enumerate()
        {
            store.collaboration_call(None, "task_create", json!({
                "requestId":format!("task-{n}"),"title":format!("Fixture task {n}"),"projectId":project
            })).unwrap();
        }
        store.set_agent_project("a", Some(&projects[0])).unwrap();
        Self {
            _dir: dir,
            store,
            projects,
        }
    }
    fn job(&self, agent: &str, task: &str, status: &str, reserved: bool) -> Value {
        let input: Submit = serde_json::from_value(json!({
            "requestId":uuid::Uuid::new_v4().to_string(),"taskId":task,"name":"Synthetic fixture job",
            "cwd":"/fixture","argv":["/usr/bin/true"],"env":{"TOKEN":"fixture-secret-never-in-list"},
            "resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0}
        })).unwrap();
        let mut job = self.store.create_job(Some(agent), input, json!({"cwd":"/fixture"}),
            json!({"id":"local-fixture","name":"Fixture host","suggestedBudget":{"cpuMillis":4000,"memoryMiB":8192,"swapMiB":0}}),
            json!({"bootId":"fixture"})).unwrap();
        job["status"] = json!(status);
        job["reserved"] = json!(reserved);
        job["reason"] = json!("Synthetic fixture outcome");
        job["source"] =
            json!({"agentId":agent,"sessionId":"fixture-session","turnId":"fixture-turn"});
        store::save(&self.store.db.write().unwrap(), &job).unwrap();
        job
    }
    fn list(&self, args: Value) -> Value {
        self.store.list_jobs_for(Some("a"), args).unwrap()
    }
}
fn ids(list: &Value, key: &str) -> HashSet<String> {
    list[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn default_self_and_explicit_agent_task_workspace_filters() {
    let f = Fixture::new();
    let a = f.job("a", "T-1", "succeeded", false);
    let b = f.job("b", "T-1", "queued", false);
    f.job("b", "T-2", "succeeded", false);
    assert_eq!(
        ids(&f.list(json!({})), "jobs"),
        HashSet::from([a["id"].as_str().unwrap().into()])
    );
    assert_eq!(
        f.list(json!({"agentId":"b"}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        f.list(json!({"taskId":"T-1"}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        f.list(json!({"taskId":a["taskId"]}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        f.list(json!({"agentId":"b","taskId":"T-1"}))["jobs"][0]["id"],
        b["id"]
    );
    assert_eq!(
        f.list(json!({"scope":"workspace"}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        f.list(json!({"scope":"self","taskId":"T-1"}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.list(json!({"agentId":"missing"}))["jobs"], json!([]));
    assert_eq!(f.list(json!({}))["liveJobs"], json!([])); // Other Agent's live job stays out.
    assert_eq!(
        f.list(json!({"taskId":"T-1"}))["liveJobIds"],
        json!([b["id"]])
    );
}

#[test]
fn project_membership_follows_task_and_null_never_falls_back_to_agent() {
    let f = Fixture::new();
    f.job("a", "T-1", "succeeded", false);
    let other = f.job("b", "T-1", "running", true);
    f.job("a", "T-2", "queued", false);
    let none = f.job("a", "T-3", "waiting", false);
    f.store
        .set_agent_project("a", Some(&f.projects[1]))
        .unwrap();
    for args in [
        json!({"projectId":f.projects[0]}),
        json!({"scope":"project","projectId":f.projects[0]}),
    ] {
        let list = f.list(args);
        assert_eq!(list["jobs"].as_array().unwrap().len(), 2);
        assert_eq!(list["liveJobIds"], json!([other["id"]]));
    }
    assert_eq!(
        f.list(json!({"projectId":f.projects[0],"agentId":"b"}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.list(json!({"projectId":f.projects[0],"taskId":"T-2"}))["jobs"],
        json!([])
    );
    assert_eq!(
        f.list(json!({"projectId":null}))["jobs"][0]["id"],
        none["id"]
    );
    assert_eq!(
        f.list(json!({"scope":"project","projectId":null}))["liveJobIds"],
        json!([none["id"]])
    );
    f.store
        .collaboration_call(
            None,
            "task_update",
            json!({"taskId":"T-1","expectedVersion":1,
        "requestId":"move-task","patch":{"projectId":f.projects[1]}}),
        )
        .unwrap();
    assert_eq!(
        f.list(json!({"projectId":f.projects[0]}))["jobs"],
        json!([])
    );
    assert_eq!(
        f.list(json!({"projectId":f.projects[1]}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        f.list(json!({"projectId":null}))["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn independent_live_cursor_preserves_old_active_jobs_and_deduplicates_each_response() {
    let f = Fixture::new();
    let old = f.job("a", "T-1", "unknown", true);
    let mut expected_live = HashSet::from([old["id"].as_str().unwrap().to_owned()]);
    for n in 0..7 {
        let j = f.job(
            "a",
            "T-1",
            if n % 2 == 0 { "queued" } else { "succeeded" },
            false,
        );
        if n % 2 == 0 {
            expected_live.insert(j["id"].as_str().unwrap().into());
        }
    }
    let mut history = HashSet::new();
    let mut before = Value::Null;
    loop {
        let list = f.list(json!({"limit":2,"before":before}));
        let page = ids(&list, "jobs");
        assert!(page.is_disjoint(&ids(&list, "liveJobs")));
        assert!(page.is_disjoint(&history));
        assert!(list["liveJobIds"].as_array().unwrap().len() <= 2);
        history.extend(page);
        before = list["nextBefore"].clone();
        if list["hasMore"] == false {
            break;
        }
    }
    assert_eq!(history.len(), 8);
    let mut live = HashSet::new();
    let mut cursor = Value::Null;
    loop {
        // before=0 makes history empty; live paging must remain independent.
        let list = f.list(json!({"limit":2,"before":0,"liveBefore":cursor}));
        let page = ids(&list, "liveJobs");
        assert!(page.is_disjoint(&live));
        assert_eq!(page.len(), list["liveJobIds"].as_array().unwrap().len());
        live.extend(page);
        cursor = list["nextLiveBefore"].clone();
        if list["liveHasMore"] == false {
            break;
        }
    }
    assert_eq!(live, expected_live);
    let last = f.list(json!({"before":0,"liveBefore":0}));
    assert_eq!(last["jobs"], json!([]));
    assert_eq!(last["liveJobs"], json!([]));
    assert_eq!(last["nextBefore"], Value::Null);
    assert_eq!(last["nextLiveBefore"], Value::Null);
}

#[test]
fn limits_scope_errors_and_gui_contract() {
    let f = Fixture::new();
    for n in 0..56 {
        f.job(if n % 2 == 0 { "a" } else { "b" }, "T-1", "queued", false);
    }
    let gui = f.store.list_jobs_for(None, json!({})).unwrap();
    assert_eq!(gui["jobs"].as_array().unwrap().len(), 50);
    assert_eq!(gui["liveJobs"].as_array().unwrap().len(), 56);
    assert_eq!(gui["hasMore"], true);
    assert!(gui.get("scope").is_none());
    assert!(gui["jobs"][0].get("source").is_some());
    assert_eq!(f.list(json!({}))["jobs"].as_array().unwrap().len(), 10);
    for limit in [1, 50] {
        let page = f.list(json!({"scope":"workspace","limit":limit}));
        assert_eq!(page["jobs"].as_array().unwrap().len(), limit);
        assert!(page["liveJobs"].as_array().unwrap().is_empty());
        assert_eq!(page["liveJobIds"].as_array().unwrap().len(), limit);
        assert_eq!(page["liveHasMore"], true);
    }
    for args in [
        json!({"limit":0}),
        json!({"limit":51}),
        json!({"limit":-1}),
        json!({"limit":1.5}),
        json!({"limit":u64::MAX}),
        json!({"scope":"wrong"}),
        json!({"scope":"project"}),
        json!({"scope":"self","agentId":"b"}),
        json!({"projectId":"missing"}),
        json!({"projectId":42}),
        json!({"scope":"workspace","projectId":null}),
        json!({"scope":"self","projectId":f.projects[0]}),
        json!({"taskId":"T-999"}),
        json!({"agentId":""}),
        json!({"compact":"yes"}),
    ] {
        assert!(
            f.store.list_jobs_for(Some("a"), args.clone()).is_err(),
            "{args}"
        );
    }
    let defs = tool_definitions();
    let schema =
        &defs.iter().find(|d| d["name"] == "job_list").unwrap()["inputSchema"]["properties"];
    assert_eq!(schema["limit"]["default"], 10);
    assert_eq!(schema["limit"]["maximum"], 50);
    assert_eq!(schema["compact"]["default"], true);
    assert_eq!(schema["projectId"]["type"], json!(["string", "null"]));
}

#[test]
fn compact_projection_bounds_text_and_both_modes_omit_environment() {
    let f = Fixture::new();
    let mut job = f.job("b", "T-1", "succeeded", false);
    job["reason"] = json!("界".repeat(2000));
    job["pause"] = json!({"state":"paused","details":"large private-looking evidence"});
    job["executor"] = json!({"kind":"ssh","machineId":"remote","machineName":"Host"});
    job["run"] = json!({"id":"run-1","stage":"train","attempt":2,"needs":["prepare"]});
    store::save(&f.store.db.write().unwrap(), &job).unwrap();
    for compact in [false, true] {
        let list = f.list(json!({"agentId":"b","compact":compact}));
        assert!(!list.to_string().contains("fixture-secret-never-in-list"));
        for row in list["jobs"].as_array().unwrap() {
            assert!(row.get("env").is_none());
            assert!(row.get("argv").is_none());
        }
    }
    let small = f.list(json!({"agentId":"b"}));
    let row = &small["jobs"][0];
    assert_eq!(row["reason"].as_str().unwrap().chars().count(), 512);
    assert_eq!(row["reasonTruncated"], true);
    assert_eq!(row["pauseState"], "paused");
    assert_eq!(row["machineId"], "remote");
    assert_eq!(
        row["run"],
        json!({"id":"run-1","stage":"train","attempt":2})
    );
    assert!(row.get("source").is_none());
    // Complete retained detail is unchanged; job_get applies its actor redaction.
    assert_eq!(
        f.store.job(job["id"].as_str().unwrap()).unwrap()["reason"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        2000
    );
}

#[test]
fn synthetic_response_size_receipt() {
    let f = Fixture::new();
    for n in 0..120 {
        f.job(
            if n % 10 == 0 { "a" } else { "b" },
            if n % 2 == 0 { "T-1" } else { "T-2" },
            if n < 70 { "succeeded" } else { "queued" },
            false,
        );
    }
    let cases = [
        (
            "prior-workspace",
            f.store.list_jobs(None, None, None).unwrap(),
        ),
        ("new-default-self", f.list(json!({}))),
        ("new-workspace", f.list(json!({"scope":"workspace"}))),
        ("new-project", f.list(json!({"projectId":f.projects[0]}))),
        (
            "new-expanded-workspace",
            f.list(json!({"scope":"workspace","compact":false})),
        ),
    ];
    let rows: Vec<_> = cases.iter().map(|(name, list)| json!({"case":name,
        "jobs":list["jobs"].as_array().unwrap().len(),"liveJobs":list["liveJobs"].as_array().unwrap().len(),
        "serializedBytes":serde_json::to_vec(list).unwrap().len()})).collect();
    println!(
        "T130_RESPONSE_SIZE {}",
        json!({"fixtureJobs":120,"agents":2,"projects":2,"rows":rows})
    );
    let old = serde_json::to_vec(&cases[0].1).unwrap().len();
    for (_, list) in &cases[1..4] {
        assert!(serde_json::to_vec(list).unwrap().len() < old / 4);
    }
}
