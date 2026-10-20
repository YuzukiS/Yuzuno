use axum::{body::{to_bytes, Body}, http::{Request, StatusCode}};
use serde_json::{json, Value};
use std::{io::Write, process::{Command, Stdio}};
use tower::ServiceExt;
use yuzuno_workspace::{machines::MachineCheck, server, workspace::Workspace};

const HELPER: &str = include_str!("../src/remote_helper.py");

async fn request(router: &axum::Router, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
    let response = router.clone().oneshot(Request::builder().method(method).uri(uri)
        .header("host", "localhost:4317").header("x-yuzuno-client", "desktop")
        .header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// A stand-in Codex that answers `--version`, like the official CLI.
fn fake_codex(dir: &std::path::Path) -> String {
    let path = dir.join("codex");
    std::fs::write(&path, "#!/bin/sh\necho 'codex-cli 9.9.9'\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path.to_string_lossy().into_owned()
}

fn harness<'a>(check: &'a Value, name: &str) -> &'a Value {
    check["harnesses"].as_array().unwrap().iter().find(|h| h["harness"] == name).unwrap()
}

#[tokio::test]
async fn core_host_checks_are_recorded_and_listed() {
    let tmp = tempfile::tempdir().unwrap();
    let codex = fake_codex(tmp.path());
    let data = tmp.path().join("data");
    let ws = Workspace::new(data.clone(), tmp.path().to_string_lossy().into_owned(), codex).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let (_, before) = request(&router, "GET", "/api/machines", Value::Null).await;
    assert_eq!(before["machines"][0]["lastCheck"], Value::Null, "never checked is unknown, not online");
    let (status, check) = request(&router, "POST", "/api/machines/local/check", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{check}");
    assert_eq!(check["machineId"], "local");
    assert_eq!(check["reachable"], true);
    assert!(check["host"]["hostname"].as_str().is_some_and(|h| !h.is_empty()));
    let codex_check = harness(&check, "codex");
    assert_eq!(codex_check["found"], true);
    assert_eq!(codex_check["version"], "codex-cli 9.9.9");
    // Claude's result depends on this host; it is always reported separately.
    assert_eq!(harness(&check, "claude")["supported"], true);
    assert_eq!(check["defaultFolder"]["resolved"], json!(tmp.path().canonicalize().unwrap()));
    assert!(check["checkedAt"].as_str().unwrap() >= check["startedAt"].as_str().unwrap());
    let (_, after) = request(&router, "GET", "/api/machines", Value::Null).await;
    assert_eq!(after["machines"][0]["lastCheck"], check, "the list and the check share one record");
    // Written to the Workspace database, not held in memory.
    let db = rusqlite::Connection::open(data.join("workspace.sqlite")).unwrap();
    let stored: String = db.query_row("SELECT data FROM machine_checks WHERE machine_id='local'", [], |r| r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), check);
}

#[tokio::test]
async fn a_missing_harness_is_reported_beside_a_reachable_host() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), "/definitely/missing/folder".into(),
        tmp.path().join("no-codex-here").to_string_lossy().into_owned()).unwrap();
    let router = server::router_on_port(ws, tmp.path().join("assets"), 4317);
    let (status, check) = request(&router, "POST", "/api/machines/local/check", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(check["reachable"], true);
    let codex = harness(&check, "codex");
    assert_eq!(codex["found"], false);
    assert!(codex["error"].as_str().unwrap().contains("not found"));
    assert!(check["defaultFolder"]["error"].is_string());
    assert!(check["defaultFolder"].get("resolved").is_none());
}

#[tokio::test]
async fn an_unreachable_ssh_machine_is_a_recorded_failure_and_unknown_machines_are_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "codex".into()).unwrap();
    let router = server::router_on_port(ws, tmp.path().join("assets"), 4317);
    // `.invalid` never resolves (RFC 2606), so this fails before any network use.
    let (status, machine) = request(&router, "POST", "/api/machines", json!({"name":"Gone","target":"nobody@host.invalid",
        "codex":"codex","defaultCwd":"/srv"})).await;
    assert_eq!(status, StatusCode::OK, "{machine}");
    let id = machine["id"].as_str().unwrap();
    let (status, check) = request(&router, "POST", &format!("/api/machines/{id}/check"), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{check}");
    assert_eq!(check["reachable"], false);
    assert!(check["error"].as_str().is_some_and(|e| !e.is_empty()));
    assert!(check.get("host").is_none());
    // Claude can run there (T-28); unreachable, it is simply not found.
    assert_eq!(harness(&check, "claude")["supported"], true);
    assert_eq!(harness(&check, "claude")["found"], false, "an unreachable machine has no Claude Code we know of");
    let (_, list) = request(&router, "GET", "/api/machines", Value::Null).await;
    let listed = list["machines"].as_array().unwrap().iter().find(|m| m["id"] == id).unwrap();
    assert_eq!(listed["lastCheck"]["reachable"], false);
    assert_eq!(list["machines"][0]["lastCheck"], Value::Null, "checking one machine leaves the others unknown");
    let (status, _) = request(&router, "POST", "/api/machines/not-registered/check", Value::Null).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn ssh_machines_are_edited_and_removed_but_not_the_core_host_or_one_an_open_agent_uses() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "codex".into()).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let machine = |name: &str, target: &str, cwd: &str| json!({"name":name,"target":target,"codex":"codex","defaultCwd":cwd});
    let (_, added) = request(&router, "POST", "/api/machines", machine("Mini", "nobody@host.invalid", "/srv")).await;
    let id = added["id"].as_str().unwrap().to_owned();
    let uri = format!("/api/machines/{id}");
    let listed = |list: &Value| list["machines"].as_array().unwrap().iter().find(|m| m["id"] == id.as_str()).cloned();
    let (_, check) = request(&router, "POST", &format!("{uri}/check"), Value::Null).await;
    assert_eq!(check["reachable"], false);

    // A new name keeps the last check; a new destination or folder drops it,
    // since it described the old one.
    let (status, renamed) = request(&router, "PUT", &uri, machine("Mac mini", "nobody@host.invalid", "/srv")).await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!((renamed["id"].as_str(), renamed["name"].as_str(), renamed["kind"].as_str()), (Some(id.as_str()), Some("Mac mini"), Some("ssh")));
    let (_, list) = request(&router, "GET", "/api/machines", Value::Null).await;
    assert_eq!(listed(&list).unwrap()["lastCheck"], check);
    let (status, _) = request(&router, "PUT", &uri, machine("Mac mini", "me@other.invalid", "/Users/me")).await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = request(&router, "GET", "/api/machines", Value::Null).await;
    let saved = listed(&list).unwrap();
    assert_eq!((saved["target"].as_str(), saved["defaultCwd"].as_str()), (Some("me@other.invalid"), Some("/Users/me")));
    assert_eq!(saved["lastCheck"], Value::Null);

    // Edits are checked as additions are, and leave the machine as it was.
    let (status, refused) = request(&router, "PUT", &uri, machine("Mac mini", "-oProxyCommand=sh", "/Users/me")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let (_, list) = request(&router, "GET", "/api/machines", Value::Null).await;
    assert_eq!(listed(&list).unwrap()["target"], "me@other.invalid");
    let (status, _) = request(&router, "PUT", "/api/machines/not-registered", machine("X", "x", "/x")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // The Core host is listed and checked, never edited or removed.
    for method in ["PUT", "DELETE"] {
        let (status, body) = request(&router, method, "/api/machines/local", machine("Host", "host", "/")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method}");
        assert!(body["error"].as_str().unwrap().contains("Core host"), "{body}");
    }

    // An unfinished Job there (a remote Job records its machine, T-108) keeps
    // the machine and its destination; a new name is still fine.
    let db = rusqlite::Connection::open(tmp.path().join("data/workspace.sqlite")).unwrap();
    // A stand-in Job row: what matters here is its machine, not its task.
    db.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES('job-r','T-1','agent-a','running',1,?1)",
        [json!({"executor":{"machineId":id}}).to_string()]).unwrap();
    let (status, refused) = request(&router, "PUT", &uri, machine("Mac mini", "me@third.invalid", "/Users/me")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["error"], "Jobs still run on this machine; change its SSH destination once they finish");
    let (status, _) = request(&router, "PUT", &uri, machine("Office mini", "me@other.invalid", "/Users/me")).await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = request(&router, "DELETE", &uri, Value::Null).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["error"], "Jobs still run on this machine; remove it once they finish");
    db.execute("UPDATE local_jobs SET status='succeeded', reserved=0 WHERE id='job-r'", []).unwrap();
    // A pipeline stage waiting for its upstream is unfinished too.
    db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES('job-w','T-1','agent-a','waiting',0,?1)",
        [json!({"executor":{"machineId":id}}).to_string()]).unwrap();
    let (status, refused) = request(&router, "DELETE", &uri, Value::Null).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["error"], "Jobs still run on this machine; remove it once they finish");
    db.execute("UPDATE local_jobs SET status='cancelled' WHERE id='job-w'", []).unwrap();

    // An open Agent there keeps the machine; once closed, it can go.
    let agent: yuzuno_workspace::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"agent-a","name":"Mikan",
        "goal":"","cwd":"/Users/me","model":"","color":"sage","status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
        "pendingCount":0,"lastSeq":0,"reviewedSeq":0,"remote":{"machine":{"id":id,"name":"Mac mini",
        "target":"me@other.invalid","codex":"codex","defaultCwd":"/Users/me"},"runtime":null}},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    let (status, refused) = request(&router, "DELETE", &uri, Value::Null).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["error"], "Mikan still works on this machine. Close that agent first, then remove it.");
    ws.store.update("agent-a", "agent/closed", &json!({}), |d| d.agent.closed_at = Some("2026-10-18T00:00:00Z".into())).unwrap();
    let (status, removed) = request(&router, "DELETE", &uri, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    let (_, list) = request(&router, "GET", "/api/machines", Value::Null).await;
    assert!(listed(&list).is_none());
    assert_eq!(list["machines"].as_array().unwrap().len(), 1, "the Core host stays");
    // The closed Agent keeps the copy it was created with.
    assert_eq!(ws.store.detail("agent-a").unwrap().agent.remote.unwrap().machine.target, "me@other.invalid");
    let (status, _) = request(&router, "DELETE", &uri, Value::Null).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "already removed");
}

#[test]
fn a_check_that_ends_after_its_machine_changed_or_went_is_not_kept() {
    use yuzuno_workspace::remote::RemoteMachine;
    let tmp = tempfile::tempdir().unwrap();
    let store = yuzuno_workspace::store::Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    let before = RemoteMachine { id: "mini".into(), name: "Mini".into(), target: "old@host".into(), codex: "codex".into(), default_cwd: "/srv".into(), ..Default::default() };
    store.add_machine(&before).unwrap();
    let check = MachineCheck { machine_id: "mini".into(), started_at: "2026-10-18T00:00:00.000Z".into(),
        checked_at: "2026-10-18T00:00:09.000Z".into(), duration_ms: 9000, reachable: true, error: None, host: None,
        harnesses: vec![], default_folder: None };
    // The destination changed while the check of the old one ran.
    let after = RemoteMachine { target: "new@host".into(), ..before.clone() };
    store.update_machine(&after).unwrap();
    let error = store.record_ssh_machine_check(&check, 1, &before).unwrap_err();
    assert_eq!(error.to_string(), "This machine was changed while it was being tested; test it again");
    assert!(store.machine_checks().unwrap().get("mini").is_none(), "nothing kept for the new destination");
    // A rename alone leaves the check describing the same machine.
    let renamed = RemoteMachine { name: "Office mini".into(), ..after.clone() };
    store.update_machine(&renamed).unwrap();
    assert!(store.record_ssh_machine_check(&check, 2, &after).unwrap().reachable);
    store.remove_machine("mini").unwrap();
    let error = store.record_ssh_machine_check(&check, 3, &renamed).unwrap_err();
    assert_eq!(error.to_string(), "This machine was removed while it was being tested");
    assert!(store.machine_checks().unwrap().get("mini").is_none(), "no orphan check");
}

#[test]
fn an_agent_created_on_a_machine_removed_meanwhile_is_refused() {
    use yuzuno_workspace::{model::AgentDetail, remote::RemoteMachine};
    let tmp = tempfile::tempdir().unwrap();
    let store = yuzuno_workspace::store::Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    let mini = RemoteMachine { id: "mini".into(), name: "Mac mini".into(), target: "me@mini".into(), codex: "codex".into(), default_cwd: "/srv".into(), ..Default::default() };
    store.add_machine(&mini).unwrap();
    let agent = |id: &str| -> AgentDetail { serde_json::from_value(json!({"agent":{"id":id,"name":id,"goal":"","cwd":"/srv","model":"",
        "color":"sage","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0,
        "remote":{"machine":mini,"runtime":null}},"turns":[],"pending":[],"artifacts":[]})).unwrap() };
    // Read while the machine was there, inserted after it went (creation
    // waits on SSH in between).
    store.insert_created(&agent("kept")).unwrap();
    assert!(store.remove_machine("mini").is_err(), "an open Agent keeps its machine");
    store.update("kept", "agent/closed", &json!({}), |d| d.agent.closed_at = Some("2026-10-18T00:00:00Z".into())).unwrap();
    store.remove_machine("mini").unwrap();
    let error = store.insert_created(&agent("late")).unwrap_err();
    assert_eq!(error.to_string(), "Mac mini was removed while this agent was being created");
    assert_eq!(store.agents().unwrap().iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["kept"]);
}

#[test]
fn a_slow_earlier_check_cannot_replace_a_newer_result() {
    let tmp = tempfile::tempdir().unwrap();
    let store = yuzuno_workspace::store::Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    let check = |at: &str, reachable: bool| MachineCheck {
        machine_id: "local".into(), started_at: at.into(), checked_at: at.into(), duration_ms: 1,
        reachable, error: None, host: None, harnesses: vec![], default_folder: None,
    };
    store.record_machine_check(&check("2026-10-13T00:00:02.000Z", true), 2_000).unwrap();
    let kept = store.record_machine_check(&check("2026-10-13T00:00:01.000Z", false), 1_000).unwrap();
    assert!(kept.reachable, "the newer start wins");
    let replaced = store.record_machine_check(&check("2026-10-13T00:00:03.000Z", false), 3_000).unwrap();
    assert!(!replaced.reachable);
    assert_eq!(store.machine_checks().unwrap()["local"], replaced);
    // Reopening the Workspace (a Core restart) keeps the latest result.
    drop(store);
    let reopened = yuzuno_workspace::store::Store::open(&tmp.path().join("workspace.sqlite")).unwrap();
    assert_eq!(reopened.machine_checks().unwrap()["local"], replaced);
}

#[test]
fn the_ssh_probe_reports_reachability_apart_from_codex_and_folder() {
    // Run the exact helper that SSH executes, locally and without SSH.
    let run = |request: Value| -> Value {
        let mut child = Command::new("python3").arg("-c").arg(HELPER)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    };
    let missing = run(json!({"action":"probe","codex":"/no/such/codex","defaultCwd":"/no/such/folder"}));
    assert!(missing["hostname"].as_str().is_some_and(|h| !h.is_empty()));
    assert!(missing["codexError"].is_string());
    assert!(missing.get("codex").is_none());
    assert!(missing["defaultCwdError"].is_string());
    let tmp = tempfile::tempdir().unwrap();
    let found = run(json!({"action":"probe","codex":fake_codex(tmp.path()),"defaultCwd":tmp.path()}));
    assert_eq!(found["codexVersion"], "codex-cli 9.9.9");
    assert_eq!(found["defaultCwd"], json!(tmp.path().canonicalize().unwrap()));
    // The Rust side reads both shapes.
    let info: yuzuno_workspace::remote::RemoteInfo = serde_json::from_value(missing).unwrap();
    assert!(info.codex.is_none() && info.codex_error.is_some());
}

#[tokio::test]
async fn a_machines_jobs_settings_are_saved_kept_through_an_edit_that_leaves_them_out_and_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "codex".into()).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let base = json!({"name":"lab_host","target":"lab_host","codex":"codex","defaultCwd":"/srv"});
    let with = |extra: Value| {
        let mut body = base.clone();
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        body
    };
    // Out-of-range or unknown settings are refused; nothing is added.
    for wrong in [json!({"maxJobs":0}), json!({"maxJobs":65}), json!({"limitMode":"loose"}), json!({"budget":{"cpuMillis":8000}})] {
        let (status, body) = request(&router, "POST", "/api/machines", with(wrong.clone())).await;
        assert!(status.is_client_error(), "{wrong}: {status} {body}");
    }
    assert!(ws.store.machines().unwrap().is_empty(), "no machine was added");
    // Jobs admission applies them (jobs::remote): they are saved as given.
    let (status, added) = request(&router, "POST", "/api/machines", with(json!({"dataRoot":"~/jobs-lab/.yuzuno","contained":true,
        "maxJobs":4,"budget":{"cpuMillis":8000,"memoryMiB":16384},"limitMode":"limited"}))).await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let id = added["id"].as_str().unwrap().to_owned();
    let uri = format!("/api/machines/{id}");
    let saved = || async { ws.store.machines().unwrap().pop().unwrap() };
    // They stay through an edit from a client that knows none of these settings.
    let (status, _) = request(&router, "PUT", &uri, with(json!({"name":"lab_host box"}))).await;
    assert_eq!(status, StatusCode::OK);
    let kept = saved().await;
    assert_eq!((kept.name.as_str(), kept.root(), kept.contained, kept.max_jobs, kept.limit_mode.as_deref()),
        ("lab_host box", "~/jobs-lab/.yuzuno", true, Some(4), Some("limited")));
    assert_eq!(kept.budget.as_ref().map(|b| (b.cpu_millis, b.memory_mib)), Some((8000, 16384)));
    let (_, list) = request(&router, "GET", "/api/machines", Value::Null).await;
    let listed = list["machines"].as_array().unwrap().iter().find(|m| m["id"] == id.as_str()).unwrap().clone();
    assert_eq!((listed["maxJobs"].as_u64(), listed["limitMode"].as_str()), (Some(4), Some("limited")));
    // A wrong value is refused and changes nothing; null clears one; "" puts
    // the data root back to the default.
    let before = serde_json::to_value(saved().await).unwrap();
    for refused in [json!({"name":"lab_host box","maxJobs":0}), json!({"name":"lab_host box","limitMode":"loose"}),
                    json!({"name":"lab_host box","dataRoot":"~/a b"}), json!({"name":"lab_host box","dataRoot":"~"}),
                    json!({"name":"lab_host box","budget":{"cpuMillis":100}})] {
        let (status, body) = request(&router, "PUT", &uri, with(refused.clone())).await;
        assert!(status.is_client_error(), "{refused}: {status} {body}");
    }
    assert_eq!(serde_json::to_value(saved().await).unwrap(), before);
    let (status, body) = request(&router, "PUT", &uri, with(json!({"name":"lab_host box","dataRoot":"","maxJobs":null,"contained":null}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let cleared = saved().await;
    assert_eq!((cleared.root(), cleared.contained, cleared.max_jobs, cleared.limit_mode.as_deref()),
        (yuzuno_workspace::remote::DEFAULT_ROOT, false, None, Some("limited")));
}

/// A machine added now is strict unless the request chooses; null chooses
/// the record-only mode that machines registered before limits keep, and an
/// edit that leaves the mode out never turns such a machine strict (T-108,
/// Lead seq 4179).
#[tokio::test]
async fn a_new_machine_is_strict_unless_it_chooses_and_one_without_a_mode_keeps_it() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "codex".into()).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let body = |name: &str, extra: Value| {
        let mut body = json!({"name":name,"target":"lab_host","codex":"codex","defaultCwd":"/srv"});
        body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        body
    };
    let mode = |id: &str| ws.store.machine(id).unwrap().limit_mode;
    let (status, strict) = request(&router, "POST", "/api/machines", body("new", json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{strict}");
    assert_eq!((strict["limitMode"].as_str(), mode(strict["id"].as_str().unwrap())), (Some("strict"), Some("strict".into())));
    let (_, legacy) = request(&router, "POST", "/api/machines", body("legacy", json!({"limitMode":null}))).await;
    let id = legacy["id"].as_str().unwrap().to_owned();
    assert_eq!((legacy.get("limitMode"), mode(&id)), (None, None));
    // An edit that leaves the mode out keeps it record-only; choosing and
    // clearing are explicit.
    let uri = format!("/api/machines/{id}");
    request(&router, "PUT", &uri, body("legacy box", json!({}))).await;
    assert_eq!(mode(&id), None);
    request(&router, "PUT", &uri, body("legacy box", json!({"limitMode":"limited"}))).await;
    assert_eq!(mode(&id), Some("limited".into()));
    request(&router, "PUT", &uri, body("legacy box", json!({"limitMode":null}))).await;
    assert_eq!(mode(&id), None);
    // A record stored before limits had no mode at all, and keeps none.
    let before = yuzuno_workspace::remote::RemoteMachine { id: "old".into(), name: "old".into(), target: "old".into(), codex: "codex".into(),
        default_cwd: "/srv".into(), ..Default::default() };
    ws.store.add_machine(&before).unwrap();
    request(&router, "PUT", "/api/machines/old", body("old box", json!({}))).await;
    assert_eq!((ws.store.machine("old").unwrap().name.as_str(), mode("old")), ("old box", None));
}

#[tokio::test]
async fn health_names_the_product_and_keeps_the_identifier_released_desktops_require() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "codex".into()).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    let (status, health) = request(&router, "GET", "/api/health", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["product"], "yuzuno");
    // Desktop 0.2.0 and earlier connect only when this is exactly "yuzuno-next".
    assert_eq!(health["application"], "yuzuno-next");
    assert_eq!(health["workspaceId"], ws.store.workspace_id().unwrap());
}

#[tokio::test]
async fn while_an_update_drains_a_machine_cannot_get_a_setting_that_keeps_older_cores_out() {
    // The release being replaced may still have to take the Workspace back
    // (an automatic rollback): nothing may close it to that release meanwhile.
    let tmp = tempfile::tempdir().unwrap();
    let ws = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into_owned(), "codex".into()).unwrap();
    let router = server::router_on_port(ws.clone(), tmp.path().join("assets"), 4317);
    // Plain: the record-only mode, which older Cores keep too. A machine that
    // leaves the mode out is strict (T-108), a setting older Cores ignore.
    let plain = json!({"name":"lab","target":"lab","codex":"codex","defaultCwd":"/srv","limitMode":null});
    let mut rooted = plain.clone();
    rooted["name"] = json!("lab_host");
    rooted["dataRoot"] = json!("~/jobs-lab/.yuzuno");
    let mut strict = plain.clone();
    strict["name"] = json!("new");
    strict.as_object_mut().unwrap().remove("limitMode");
    ws.admission.begin_drain("test-update").unwrap();
    // Refused as the drain refuses new work, and nothing is stored.
    let draining = |status: StatusCode, body: &Value| {
        status.is_client_error() && body["error"].as_str().is_some_and(|e| e.starts_with("workspace_updating:"))
    };
    let (status, body) = request(&router, "POST", "/api/machines", rooted.clone()).await;
    assert!(draining(status, &body), "a data root: {status} {body}");
    let (status, body) = request(&router, "POST", "/api/machines", strict).await;
    assert!(draining(status, &body), "a new machine is strict: {status} {body}");
    assert!(ws.store.machines().unwrap().is_empty(), "nothing stored while draining");
    let (status, added) = request(&router, "POST", "/api/machines", plain).await;
    assert_eq!(status, StatusCode::OK, "a plain machine is not new work: {added}");
    assert_eq!(ws.store.machines().unwrap().len(), 1);
    ws.admission.reopen("test-update").unwrap();
    let (status, body) = request(&router, "POST", "/api/machines", rooted).await;
    if unsafe { libc::geteuid() } == 0 {
        // Root ignores permissions, so older Cores could not be kept out: refused.
        assert!(!status.is_success(), "{body}");
    } else {
        assert_eq!(status, StatusCode::OK, "{body}");
    }
}
