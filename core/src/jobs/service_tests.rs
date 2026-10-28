//! T-5: a Job that serves a Project service, at submit, in the Store and as
//! the services list shows it (service_jobs.rs).
use super::*;
use crate::remote::RemoteMachine;
use crate::service_jobs::Link;
use crate::services::NewService;

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    project: String,
}

/// A Project with a task in it (T-1), and a task in none (T-2).
fn lab() -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let agent: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace",
        "model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
        "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
    .unwrap();
    ws.store.insert(&agent).unwrap();
    let project = ws.store.create_project("Portal", Default::default()).unwrap().id;
    ws.store
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Portal","status":"doing","projectId":project}))
        .unwrap();
    ws.store
        .collaboration_call(None, "task_create", json!({"requestId":"loose","title":"Loose","status":"doing"}))
        .unwrap();
    Lab { _dir: dir, ws, project }
}

/// A port nothing listens on now.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn service(lab: &Lab, name: &str, machine: &str, port: u16) -> String {
    let new = NewService { name: name.into(), machine_id: machine.into(), port, path: format!("/{}", name.to_lowercase()) };
    lab.ws.register_service(&lab.project, new, json!({"kind":"user"}), None).await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn served(id: &str, task: &str, service: &str, health_path: Option<&str>) -> Submit {
    let mut submit: Submit = serde_json::from_value(json!({"requestId":id,"taskId":task,"agentId":"a","name":"Dev server","cwd":"/workspace",
        "argv":["/usr/bin/python3","-m","http.server"],"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},
        "timeoutSeconds":3600,"guardGit":false,"service":{"serviceId":service}}))
    .unwrap();
    submit.service_link = Some(Link { service_id: service.into(), health_path: health_path.map(str::to_owned) });
    submit
}

fn create(s: &Store, input: Submit) -> Result<Value> {
    s.create_job(None, input, json!({"cwd":"/workspace"}), json!({"id":"local-test","name":"test",
        "suggestedBudget":{"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}}), json!({"bootId":"boot"}))
}

/// The host reports the next queued Job running, then (optionally) ended.
fn run(s: &Store, job: &Value) {
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":job["attempt"],"status":"running",
        "reason":"Running with verified cgroup limits","started":{"at":1792000000.0}}))
        .unwrap();
}
fn end(s: &Store, job: &Value, status: &str) {
    s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":job["attempt"],"status":status,
        "reason":"ended","exitCode":0}))
        .unwrap();
}

async fn listed(lab: &Lab, id: &str) -> Value {
    lab.ws.project_services(&lab.project).await.unwrap()["services"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap()
        .clone()
}

#[tokio::test]
async fn the_services_list_says_which_job_serves_a_service_and_an_external_one_has_none() {
    let lab = lab();
    let port = free_port();
    let served_id = service(&lab, "Vite", "local", port).await;
    let external = service(&lab, "Jupyter", "local", free_port()).await;
    let job = create(&lab.ws.store, served("a", "T-1", &served_id, Some("/health"))).unwrap();

    let view = listed(&lab, &served_id).await;
    assert_eq!(view["job"]["jobId"], job["id"]);
    assert_eq!(view["job"]["status"], "queued");
    // Nothing listens on the port, whoever was meant to.
    assert_eq!(view["job"]["owner"], "notListening");
    assert_eq!(view["job"]["earlierJobIds"], json!([]));
    assert_eq!(view["job"]["canStop"], true);
    // Declared, but not checked while the Job does not run: never guessed.
    assert_eq!(view["health"]["declared"], true);
    assert_eq!(view["health"]["state"], "unknown");
    assert!(view["health"]["reason"].as_str().unwrap().contains("not running"), "{view}");

    // A registered service no Job serves: nothing to stop from Yuzuno.
    let view = listed(&lab, &external).await;
    assert_eq!(view["job"], Value::Null);
    assert_eq!(view["health"], json!({"declared": false}));

    // The Job records what it declared; the link itself is not part of the request.
    assert_eq!(job["service"], json!({"serviceId": served_id}));
}

#[tokio::test]
async fn a_restart_is_a_new_job_only_once_the_earlier_one_has_ended() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite", "local", free_port()).await;
    let first = create(s, served("a", "T-1", &id, None)).unwrap();

    // Queued, running, cancelling: it may still serve, so no second Job.
    let refused = |s: &Store, request: &str| create(s, served(request, "T-1", &id, None)).unwrap_err().to_string();
    let queued = refused(s, "b1");
    assert!(queued.contains("still served by Job") && queued.contains(first["id"].as_str().unwrap()), "{queued}");
    run(s, &first);
    assert!(refused(s, "b2").contains("(running)"));
    assert_eq!(listed(&lab, &id).await["job"]["canStop"], true);
    s.request_job_cancel(None, first["id"].as_str().unwrap()).unwrap();
    assert!(refused(s, "b3").contains("(cancelling)"));
    assert_eq!(listed(&lab, &id).await["job"]["canStop"], false, "a stop already asked for is not offered again");

    end(s, &first, "cancelled");
    let second = create(s, served("b4", "T-1", &id, None)).unwrap();
    let view = listed(&lab, &id).await;
    assert_eq!(view["job"]["jobId"], second["id"]);
    assert_eq!(view["job"]["earlierJobIds"], json!([first["id"]]));
    // Nothing was linked by the refused attempts.
    let links: i64 = s.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM project_service_jobs WHERE service_id=?1", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(links, 2);
}

#[tokio::test]
async fn a_job_serves_only_a_service_of_its_tasks_project_on_this_host() {
    let lab = lab();
    let s = &lab.ws.store;
    let id = service(&lab, "Vite", "local", free_port()).await;
    let loose = create(s, served("loose", "T-2", &id, None)).unwrap_err().to_string();
    assert!(loose.contains("the task is in no Project"), "{loose}");

    s.add_machine(&RemoteMachine { id: "m1".into(), name: "m1".into(), target: "m1".into(), codex: "codex".into(),
        default_cwd: "/tmp".into(), ..Default::default() })
        .unwrap();
    let remote = service(&lab, "Remote", "m1", free_port()).await;
    let elsewhere = create(s, served("remote", "T-1", &remote, None)).unwrap_err().to_string();
    assert!(elsewhere.contains("on this host only"), "{elsewhere}");

    let missing = create(s, served("missing", "T-1", "no-such-service", None)).unwrap_err().to_string();
    assert!(missing.contains("service_not_found"), "{missing}");
    // None of them is a Job.
    assert!(s.list_jobs(None, None, None).unwrap()["jobs"].as_array().unwrap().is_empty());
}

#[test]
fn a_service_is_declared_for_a_job_on_this_host_that_is_not_exclusive() {
    let base = json!({"requestId":"x","taskId":"T-1","name":"Dev","cwd":"/workspace","argv":["/bin/true"],
        "resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},"guardGit":false});
    let check = |extra: Value| {
        let mut request = base.clone();
        for (key, value) in extra.as_object().unwrap() {
            request[key] = value.clone();
        }
        serde_json::from_value::<Submit>(request).unwrap().validate().map_err(|e| e.to_string())
    };
    let new = json!({"name":"Vite","port":5173});
    assert!(check(json!({"service": new})).is_ok());
    // An alias is checked again once it resolves; local is this host.
    assert!(check(json!({"service": new, "machineId": "local"})).is_ok());
    assert!(check(json!({"service": new, "machineId": "m1"})).unwrap_err().contains("this Core's host only"));
    assert!(check(json!({"service": new, "exclusive": true})).unwrap_err().contains("cannot be exclusive"));
    assert!(check(json!({"service": {"serviceId":"s","port":5173}})).unwrap_err().contains("not both"));
    assert!(check(json!({"service": {"name":"Vite"}})).unwrap_err().contains("name and port"));
    assert!(check(json!({"service": {"name":"Vite","port":5173,"healthPath":"health"}})).unwrap_err().contains("healthPath"));
    assert!(serde_json::from_value::<Submit>({
        let mut r = base.clone();
        r["service"] = json!({"name":"Vite","port":5173,"command":"x"});
        r
    })
    .is_err(), "unknown service fields are refused");
}
