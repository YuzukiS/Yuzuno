//! Backups and restores from Settings (T-192, slice 2), through Core's HTTP
//! routes: they start only on Core's own port, the phone entry may read, and
//! each runs as an idempotent operation. Temporary folders only.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use yuzuno_workspace::{
    server::{self, RemoteEntry},
    workspace::Workspace,
};

const ORIGIN: &str = "https://core.example-tailnet.ts.net:8444";
const HOST: &str = "core.example-tailnet.ts.net:8444";
const LOGIN: &str = "person@example.com";

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>, remote: bool) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    builder = if remote {
        builder.header("host", HOST).header("tailscale-user-login", LOGIN).header("origin", ORIGIN)
    } else {
        builder.header("host", "127.0.0.1:4317")
    };
    builder = builder.header("x-yuzuno-client", "desktop").header("content-type", "application/json");
    let request = builder.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// No route takes the request: 404, or 405 where the page's own GET
/// fallback answers the path.
fn unrouted(status: StatusCode) -> bool {
    matches!(status, StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED)
}

async fn finished(app: &Router, id: &str) -> Value {
    for _ in 0..600 {
        let (status, op) = call(app, "GET", &format!("/api/workspace/backup/operations/{id}"), None, false).await;
        assert_eq!(status, StatusCode::OK, "{op}");
        if op["state"] != "running" {
            return op;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("operation {id} did not finish");
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_back_up_check_and_restore_only_from_cores_own_port() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused-codex".into()).unwrap();
    let remote = server::remote_router(ws.clone(), tmp.path().join("assets"), None, RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    let local = server::router(ws, tmp.path().join("assets"));

    let (status, view) = call(&local, "GET", "/api/workspace/backup", None, false).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!((view["canChange"].clone(), view["canBackUp"].clone()), (json!(true), json!(true)), "{view}");
    let (status, phone) = call(&remote, "GET", "/api/workspace/backup", None, true).await;
    assert_eq!((status, phone["canChange"].clone()), (StatusCode::OK, json!(false)), "the phone entry may read");

    let backup = tmp.path().join("backup");
    let request = json!({"requestId":"b1","to":backup});
    let (status, _) = call(&remote, "POST", "/api/workspace/backups", Some(request.clone()), true).await;
    assert!(unrouted(status), "a phone cannot start a backup: {status}");
    assert!(!backup.exists());
    let (status, started) = call(&local, "POST", "/api/workspace/backups", Some(request.clone()), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let id = started["operation"]["id"].as_str().unwrap().to_owned();
    let (_, again) = call(&local, "POST", "/api/workspace/backups", Some(request), false).await;
    assert_eq!(again["operation"]["id"], id.as_str(), "the same request is the same operation");
    let (status, conflict) = call(&local, "POST", "/api/workspace/backups",
        Some(json!({"requestId":"b1","to":tmp.path().join("elsewhere")})), false).await;
    assert_eq!((status, conflict["code"].clone()), (StatusCode::CONFLICT, json!("idempotency_conflict")));
    let done = finished(&local, &id).await;
    assert_eq!(done["state"], "succeeded", "{done}");
    assert_eq!(done["result"]["path"], json!(backup));
    yuzuno_workspace::workspace_backup::verify(&backup).unwrap();
    let (status, _) = call(&local, "POST", &format!("/api/workspace/backup/operations/{id}/stop"), None, false).await;
    assert_eq!(status, StatusCode::CONFLICT, "only a running operation stops");

    let (status, checked) = call(&local, "POST", "/api/workspace/backups/check", Some(json!({"requestId":"c1","path":backup})), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{checked}");
    assert_eq!(finished(&local, checked["operation"]["id"].as_str().unwrap()).await["state"], "succeeded");

    let restored = tmp.path().join("restored");
    let (status, pre) = call(&local, "POST", "/api/workspace/restore/precheck", Some(json!({"from":backup,"to":restored})), false).await;
    assert_eq!(status, StatusCode::OK, "{pre}");
    assert_eq!((pre["target"].clone(), pre["sameIdentity"].clone()), (json!("new"), json!(true)), "{pre}");
    let (status, refused) = call(&local, "POST", "/api/workspace/restore/precheck", Some(json!({"from":backup,"to":data})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(refused["error"].as_str().unwrap().contains("holds a Workspace"), "the reason is given: {refused}");
    assert!(!restored.exists(), "a precheck writes nothing");
    let (status, _) = call(&remote, "POST", "/api/workspace/restores", Some(json!({"requestId":"r1","from":backup,"to":restored})), true).await;
    assert!(unrouted(status), "a phone cannot restore: {status}");
    let (status, started) = call(&local, "POST", "/api/workspace/restores", Some(json!({"requestId":"r1","from":backup,"to":restored})), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let done = finished(&local, started["operation"]["id"].as_str().unwrap()).await;
    assert_eq!(done["state"], "succeeded", "{done}");
    assert!(done["result"]["nextSteps"][0].as_str().unwrap().contains("--data-dir"));
    assert!(restored.join("workspace.sqlite").is_file());
    let (status, relative) = call(&local, "POST", "/api/workspace/backups", Some(json!({"requestId":"b2","to":"relative/path"})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{relative}");
}

/// The daily backup (T-196): off until turned on, only from Core's own port,
/// at a time of day in UTC into a folder that exists. Turning it on backs up
/// nothing now, and its schedule file is never in a backup.
#[tokio::test(flavor = "multi_thread")]
async fn the_daily_backup_is_off_until_turned_on_from_cores_own_port_and_its_time_is_utc() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused-codex".into()).unwrap();
    let remote = server::remote_router(ws.clone(), tmp.path().join("assets"), None, RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    let local = server::router(ws, tmp.path().join("assets"));
    let (status, view) = call(&local, "GET", "/api/workspace/backup", None, false).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["schedule"]["enabled"], json!(false), "off by default: {view}");
    assert_eq!((view["schedule"]["nextRunAt"].clone(), view["schedule"]["lastRun"].clone()), (Value::Null, Value::Null));
    // The last run alone, what a page reads to notify of a failure (T-196): the phone entry may read it too.
    for (app, remote_entry) in [(&local, false), (&remote, true)] {
        let (status, last) = call(app, "GET", "/api/workspace/backup/last-run", None, remote_entry).await;
        assert_eq!((status, last), (StatusCode::OK, json!({"lastRun": null})));
    }

    let daily = tmp.path().join("daily");
    std::fs::create_dir(&daily).unwrap();
    let on = json!({"enabled":true,"timeUtc":"03:00","folder":daily});
    let (status, _) = call(&remote, "POST", "/api/workspace/backup/schedule", Some(on.clone()), true).await;
    assert!(unrouted(status), "a phone cannot turn it on: {status}");
    let (status, bad) = call(&local, "POST", "/api/workspace/backup/schedule", Some(json!({"enabled":true,"timeUtc":"25:00","folder":daily})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(bad["error"].as_str().unwrap().contains("HH:MM, in UTC"), "{bad}");
    let (status, missing) = call(&local, "POST", "/api/workspace/backup/schedule",
        Some(json!({"enabled":true,"timeUtc":"03:00","folder":tmp.path().join("missing")})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(missing["error"].as_str().unwrap().contains("is not a folder"), "{missing}");
    let (status, view) = call(&local, "GET", "/api/workspace/backup", None, false).await;
    assert_eq!((status, view["schedule"]["enabled"].clone()), (StatusCode::OK, json!(false)), "refusals change nothing");

    let (status, set) = call(&local, "POST", "/api/workspace/backup/schedule", Some(on), false).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let schedule = &set["schedule"];
    assert_eq!((schedule["enabled"].clone(), schedule["timeUtc"].clone()), (json!(true), json!("03:00")));
    let next = chrono::DateTime::parse_from_rfc3339(schedule["nextRunAt"].as_str().unwrap()).unwrap();
    assert!(next > chrono::Utc::now() && next.format("%H:%M:%S").to_string() == "03:00:00" && next.offset().local_minus_utc() == 0, "{schedule}");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(std::fs::read_dir(&daily).unwrap().count(), 0, "turning it on backs up nothing now");
    assert!(data.join("backup-schedule.json").is_file());

    // A backup made now leaves the schedule out: a restored copy starts with none.
    let backup = tmp.path().join("backup");
    let (status, started) = call(&local, "POST", "/api/workspace/backups", Some(json!({"requestId":"b1","to":backup})), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    assert_eq!(finished(&local, started["operation"]["id"].as_str().unwrap()).await["state"], "succeeded");
    let manifest: Value = serde_json::from_slice(&std::fs::read(backup.join("manifest.json")).unwrap()).unwrap();
    assert!(manifest["excluded"].as_array().unwrap().iter().any(|e| e["path"] == "backup-schedule.json"), "{manifest}");

    let (status, off) = call(&local, "POST", "/api/workspace/backup/schedule", Some(json!({"enabled":false,"timeUtc":"03:00"})), false).await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!((off["schedule"]["enabled"].clone(), off["schedule"]["nextRunAt"].clone()), (json!(false), Value::Null));
}

/// The retention preview (T-196, slice 2): only from Core's own port, read
/// only, and refusing a relative folder or a count out of range.
#[tokio::test(flavor = "multi_thread")]
async fn a_retention_preview_lists_a_folder_only_from_cores_own_port_and_changes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused-codex".into()).unwrap();
    let remote = server::remote_router(ws.clone(), tmp.path().join("assets"), None, RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    let local = server::router(ws, tmp.path().join("assets"));
    let folder = tmp.path().join("backups");
    std::fs::create_dir(&folder).unwrap();
    let (status, started) = call(&local, "POST", "/api/workspace/backups", Some(json!({"requestId":"b1","to":folder.join("first")})), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    assert_eq!(finished(&local, started["operation"]["id"].as_str().unwrap()).await["state"], "succeeded");
    std::fs::create_dir(folder.join("photos")).unwrap();

    let request = json!({"folder": folder, "keep": 1});
    let (status, _) = call(&remote, "POST", "/api/workspace/backup/retention/preview", Some(request.clone()), true).await;
    assert!(unrouted(status), "a phone cannot list host folders: {status}");
    let (status, preview) = call(&local, "POST", "/api/workspace/backup/retention/preview", Some(request), false).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let verdicts: Vec<(String, String)> = preview["entries"].as_array().unwrap().iter()
        .map(|e| (e["name"].as_str().unwrap().to_owned(), e["verdict"].as_str().unwrap().to_owned())).collect();
    assert!(verdicts.contains(&("first".into(), "keep".into())) && verdicts.contains(&("photos".into(), "ignored".into())), "{preview}");
    assert_eq!(preview["removableEstimateBytes"], json!(0));
    let (status, relative) = call(&local, "POST", "/api/workspace/backup/retention/preview", Some(json!({"folder":"backups","keep":1})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(relative["error"].as_str().unwrap().contains("absolute"), "{relative}");
    let (status, zero) = call(&local, "POST", "/api/workspace/backup/retention/preview", Some(json!({"folder":folder,"keep":0})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(zero["error"].as_str().unwrap().contains("Keep at least 1"), "{zero}");
    // Removing one (T-196, slice 3): not from a phone, and refused at once when the folder no longer allows it.
    let remove = json!({"requestId":"rm1","folder":folder,"keep":1,"name":"first","manifestSha256":"stale"});
    let (status, _) = call(&remote, "POST", "/api/workspace/backup/retention/remove", Some(remove.clone()), true).await;
    assert!(unrouted(status), "a phone cannot remove a backup: {status}");
    let (status, refused) = call(&local, "POST", "/api/workspace/backup/retention/remove", Some(remove), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    let reason = refused["error"].as_str().unwrap();
    assert!(reason.contains("not one that could be removed now: One of the latest 1") && reason.ends_with("nothing was removed"), "{refused}");
    assert!(folder.join("first/manifest.json").is_file() && folder.join("photos").is_dir(), "nothing was removed");
    // With a newer backup, the older one is removed once; the same request again gets that operation back.
    let (status, started) = call(&local, "POST", "/api/workspace/backups", Some(json!({"requestId":"b2","to":folder.join("second")})), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    assert_eq!(finished(&local, started["operation"]["id"].as_str().unwrap()).await["state"], "succeeded");
    let (_, preview) = call(&local, "POST", "/api/workspace/backup/retention/preview", Some(json!({"folder": folder, "keep": 1})), false).await;
    let first = preview["entries"].as_array().unwrap().iter().find(|e| e["name"] == "first").unwrap().clone();
    assert_eq!(first["verdict"], "remove", "{preview}");
    let remove = json!({"requestId":"rm2","folder":folder,"keep":1,"name":"first","manifestSha256":first["manifestSha256"]});
    let (status, started) = call(&local, "POST", "/api/workspace/backup/retention/remove", Some(remove.clone()), false).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let id = started["operation"]["id"].as_str().unwrap().to_owned();
    let done = finished(&local, &id).await;
    assert_eq!((done["state"].clone(), done["result"]["keptCheckedName"].clone()), (json!("succeeded"), json!("second")), "{done}");
    assert!(!folder.join("first").exists() && folder.join("second/manifest.json").is_file());
    let (status, again) = call(&local, "POST", "/api/workspace/backup/retention/remove", Some(remove), false).await;
    assert_eq!((status, again["operation"]["id"].as_str(), again["operation"]["state"].as_str()), (StatusCode::ACCEPTED, Some(id.as_str()), Some("succeeded")), "{again}");
    let other = json!({"requestId":"rm2","folder":folder,"keep":1,"name":"second","manifestSha256":"other"});
    let (status, conflict) = call(&local, "POST", "/api/workspace/backup/retention/remove", Some(other), false).await;
    assert_eq!((status, conflict["code"].as_str()), (StatusCode::CONFLICT, Some("idempotency_conflict")), "{conflict}");
    assert!(folder.join("second/manifest.json").is_file(), "the newest is never removed");
    // A space budget (T-196, slice 5): optional; the count alone is unchanged, a budget the newest
    // doesn't fit in keeps it and says so, and a budget of nothing is refused.
    let (status, count) = call(&local, "POST", "/api/workspace/backup/retention/preview", Some(json!({"folder": folder, "keep": 1})), false).await;
    assert_eq!(status, StatusCode::OK, "{count}");
    assert!(count.get("budget").is_none() && count["sizeBasis"].as_str().unwrap().contains("nothing is measured on disk"), "{count}");
    let (status, tiny) = call(&local, "POST", "/api/workspace/backup/retention/preview", Some(json!({"folder": folder, "keep": 1, "budgetBytes": 1})), false).await;
    assert_eq!(status, StatusCode::OK, "{tiny}");
    assert_eq!(tiny["budget"]["state"], "over", "{tiny}");
    let second = tiny["entries"].as_array().unwrap().iter().find(|e| e["name"] == "second").unwrap();
    assert_eq!(second["verdict"], "keep", "{tiny}");
    let (status, zero) = call(&local, "POST", "/api/workspace/backup/retention/preview", Some(json!({"folder": folder, "keep": 1, "budgetBytes": 0})), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(zero["error"].as_str().unwrap().contains("space budget"), "{zero}");
}

/// Automatic removal of old daily backups (T-196, slice 6): off by default,
/// turned on only from Core's own port for the folder the page previewed,
/// removing nothing when turned on; a folder change turns it off.
#[tokio::test(flavor = "multi_thread")]
async fn automatic_removal_is_off_until_turned_on_for_the_previewed_folder_from_cores_own_port() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let ws = Workspace::new(data.clone(), "/tmp".into(), "unused-codex".into()).unwrap();
    let remote = server::remote_router(ws.clone(), tmp.path().join("assets"), None, RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    let local = server::router(ws, tmp.path().join("assets"));
    let (daily, other) = (tmp.path().join("daily"), tmp.path().join("other"));
    std::fs::create_dir(&daily).unwrap();
    std::fs::create_dir(&other).unwrap();
    std::fs::create_dir(daily.join("an-old-folder")).unwrap();
    let (_, view) = call(&local, "GET", "/api/workspace/backup", None, false).await;
    assert_eq!((view["schedule"]["retention"].clone(), view["schedule"]["retentionNote"].clone()), (Value::Null, Value::Null), "off by default: {view}");
    let on = json!({"enabled":true,"keep":2,"budgetBytes":1073741824u64,"folder":daily});
    let (status, refused) = call(&local, "POST", "/api/workspace/backup/schedule/retention", Some(on.clone()), false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(refused["error"].as_str().unwrap().contains("save the daily backup's folder first"), "{refused}");
    let (status, _) = call(&local, "POST", "/api/workspace/backup/schedule", Some(json!({"enabled":true,"timeUtc":"03:00","folder":daily})), false).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&remote, "POST", "/api/workspace/backup/schedule/retention", Some(on.clone()), true).await;
    assert!(unrouted(status), "a phone cannot turn it on: {status}");
    for wrong in [json!({"enabled":true,"keep":2,"folder":other}), json!({"enabled":true,"folder":daily}), json!({"enabled":true,"keep":0,"folder":daily})] {
        let (status, refused) = call(&local, "POST", "/api/workspace/backup/schedule/retention", Some(wrong.clone()), false).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{wrong}: {refused}");
    }
    let (status, set) = call(&local, "POST", "/api/workspace/backup/schedule/retention", Some(on), false).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!((set["schedule"]["retention"]["keep"].clone(), set["schedule"]["retention"]["budgetBytes"].clone()), (json!(2), json!(1073741824u64)));
    assert!(daily.join("an-old-folder").is_dir(), "turning it on removes nothing");
    let (status, moved) = call(&local, "POST", "/api/workspace/backup/schedule", Some(json!({"enabled":true,"timeUtc":"03:00","folder":other})), false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(moved["schedule"]["retention"], Value::Null);
    assert!(moved["schedule"]["retentionNote"].as_str().unwrap().contains("folder changed"), "{moved}");
    let (status, off) = call(&local, "POST", "/api/workspace/backup/schedule/retention", Some(json!({"enabled":false})), false).await;
    assert_eq!((status, off["schedule"]["retentionNote"].clone()), (StatusCode::OK, Value::Null));
}
