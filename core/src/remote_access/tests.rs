//! Phone access from Settings (T-185) against stand-ins for Windows'
//! tailscale.exe and curl.exe, which keep the Serve configuration in a JSON
//! file and play Serve's part for a request through it (the Host header and
//! `Tailscale-User-Login` of this PC's owner). Core's own listeners are real.
//! No real Tailscale, Serve, Windows or daily Core is reached.
use super::*;
use std::os::unix::fs::PermissionsExt;

const DNS: &str = "pc.tail0.ts.net";
const OWNER: &str = "owner@github";

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    state: PathBuf,
    log: PathBuf,
}

/// The fake tailscale.exe: status from the state file, `serve status`,
/// `serve --bg --https=P target` and `serve --https=P off`, with faults the
/// state names: `failAdd` and `failOff` (refused), `lostAdd` (added, then no
/// answer) and `slow` (seconds before any answer).
const TAILSCALE: &str = include_str!("../../../acceptance/t185-remote-access/fake_tailscale.py");

/// The fake curl.exe: `-sS -m S -o - -w "\n%{http_code}" URL`. Loopback URLs
/// are fetched as they are; an https URL goes through the Serve entry for its
/// host and port, as this PC's owner.
const CURL: &str = include_str!("../../../acceptance/t185-remote-access/fake_curl.py");

fn lab(kind: &str) -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let write = |name: &str, body: &str| {
        let path = bin.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    let tailscale = write("tailscale.exe", TAILSCALE);
    let curl = write("curl.exe", CURL);
    let state = bin.join("tailscale.exe.json");
    std::fs::write(&state, json!({
        "owner": OWNER,
        "status": {"BackendState": "Running", "Self": {"DNSName": format!("{DNS}."), "UserID": 7},
            "User": {"7": {"LoginName": OWNER}}, "CertDomains": [DNS]},
        // Someone else's service: never touched.
        "serve": {"TCP": {"443": {"HTTPS": true}}, "Web": {format!("{DNS}:443"): {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8790"}}}}},
    }).to_string()).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let mut host = Host::new(kind, "Ubuntu", Some("mirrored".into()), tailscale, curl);
    host.limit = Some(3);
    ws.remote_access.test_host.set(host).unwrap();
    let log = bin.join("tailscale.exe.log");
    Lab { dir, ws, state, log }
}

impl Lab {
    fn start(&self, bound: Bound) {
        run(&self.ws, bound, self.dir.path().join("web"), None, 4317);
    }
    fn fake(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.state).unwrap()).unwrap()
    }
    fn set_fake(&self, change: impl FnOnce(&mut Value)) {
        let mut value = self.fake();
        change(&mut value);
        std::fs::write(&self.state, value.to_string()).unwrap();
    }
    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log).unwrap_or_default().lines().map(str::to_owned).collect()
    }
    fn saved(&self) -> Saved {
        read(&path(&self.ws)).unwrap()
    }
    async fn apply(&self, request: Value) -> Result<Value> {
        let op = start(&self.ws, serde_json::from_value(request)?).await?;
        let id = op["id"].as_str().unwrap().to_owned();
        for _ in 0..400 {
            let op = self.saved().operations.into_iter().find(|o| o.id == id).unwrap();
            if op.state != "running" {
                return Ok(serde_json::to_value(op)?);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("operation {id} did not finish");
    }
    async fn view(&self) -> Value {
        view(&self.ws, true).await.unwrap()
    }
    /// POST /api/remote-access/check, as the page on Core's port makes it.
    async fn check(&self) -> Value {
        match post_check(AppState(self.ws.clone()), Request::new(axum::body::Body::empty())).await {
            Ok(Json(value)) => value,
            Err(_) => panic!("check failed"),
        }
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn get(port: u16, path: &str, login: Option<&str>, host: &str) -> (u16, String) {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut request = client.get(format!("http://127.0.0.1:{port}{path}")).header("host", host);
    if let Some(login) = login {
        request = request.header("tailscale-user-login", login);
    }
    let response = request.send().await.unwrap();
    let code = response.status().as_u16();
    (code, response.text().await.unwrap_or_default())
}

#[tokio::test]
async fn apply_serves_the_phone_entry_without_a_restart_and_a_new_core_serves_it_too() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    let op = lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    assert_eq!((op["state"].as_str(), op["step"].as_str()), (Some("succeeded"), Some("done")), "{op}");
    let origin = format!("https://{DNS}:8444");
    assert_eq!(op["url"], origin.as_str());
    // Serve: Core's entry added, the other service kept, nothing reset.
    let serve = &lab.fake()["serve"];
    assert_eq!(serve["Web"][format!("{DNS}:8444")], json!({"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{port}")}}}));
    assert_eq!(serve["Web"][format!("{DNS}:443")], json!({"Handlers": {"/": {"Proxy": "http://127.0.0.1:8790"}}}));
    assert!(lab.calls().iter().all(|c| !c.contains("reset")), "{:?}", lab.calls());
    // The listener: the allowed login through this host gets in, anything else does not.
    let host = format!("{DNS}:8444");
    assert_eq!(get(port, "/api/health", Some(OWNER), &host).await.0, 200);
    assert_eq!(get(port, "/api/health", None, &host).await.0, 403);
    assert_eq!(get(port, "/api/health", Some("someone@else"), &host).await.0, 403);
    // The page: applied, listening from Settings, verified, the address to open.
    let view = lab.view().await;
    assert_eq!(view["saved"]["applied"], true, "{view}");
    assert_eq!((view["listening"]["source"].as_str(), view["listening"]["port"].as_u64()), (Some("settings"), Some(port as u64)));
    assert_eq!(view["url"], origin.as_str());
    assert_eq!(view["verification"]["ok"], true, "{}", view["verification"]);
    assert_eq!(view["serve"]["state"], "ours");
    assert_eq!(view["serve"]["otherEntries"], 1);
    let size = view["qr"]["size"].as_u64().unwrap() as usize;
    assert!(size >= 21 && view["qr"]["rows"].as_array().unwrap().iter().all(|r| r.as_str().unwrap().len() == size), "{}", view["qr"]);
    // Through the phone entry the page is read-only, and apply is not served there.
    let (code, body) = get(port, "/api/remote-access", Some(OWNER), &host).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["canChange"], false);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let refused = client.post(format!("http://127.0.0.1:{port}/api/remote-access/apply")).header("host", &host)
        .header("tailscale-user-login", OWNER).header("origin", &origin).header("x-yuzuno-client", "desktop")
        .json(&json!({"requestId": "from-phone", "enabled": false})).send().await.unwrap();
    assert!(matches!(refused.status().as_u16(), 404 | 405), "{}", refused.status());
    // A new Core on the same data serves the applied entry, and an environment entry does not override it.
    let env = RemoteEntry::new("https://elsewhere.ts.net:9000", "env@github").unwrap();
    let next = startup(&lab.ws.data_dir, Some((free_port(), env)));
    assert_eq!(next.listen, Some((Entry { port, origin: origin.clone(), login: OWNER.into() }, "settings")));
}

#[tokio::test]
async fn a_taken_serve_port_rolls_back_to_the_previous_entry_and_saves_the_request_unapplied() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    lab.set_fake(|s| {
        s["serve"]["TCP"]["8445"] = json!({"HTTPS": true});
        s["serve"]["Web"][format!("{DNS}:8445")] = json!({"Handlers": {"/": {"Proxy": "http://127.0.0.1:9999"}}});
    });
    // The same local port, another Serve port: the old listener closes first, so the rollback binds it again.
    let op = lab.apply(json!({"requestId": "move", "enabled": true, "localPort": port, "servePort": 8445})).await.unwrap();
    assert_eq!((op["state"].as_str(), op["step"].as_str()), (Some("rolledBack"), Some("serve")), "{op}");
    assert!(op["error"].as_str().unwrap().contains(&format!("already used by another Serve configuration (https://{DNS}:8445/ → http://127.0.0.1:9999)")), "{op}");
    assert!(op["error"].as_str().unwrap().ends_with("the previous phone access is unchanged"), "{op}");
    let host = format!("{DNS}:8444");
    assert_eq!(get(port, "/api/health", Some(OWNER), &host).await.0, 200, "the previous entry serves again");
    let serve = &lab.fake()["serve"];
    assert_eq!(serve["Web"][format!("{DNS}:8445")]["Handlers"]["/"]["Proxy"], "http://127.0.0.1:9999", "someone else's port is untouched");
    assert!(serve["Web"][format!("{DNS}:8444")].is_object());
    let view = lab.view().await;
    assert_eq!((view["saved"]["servePort"].as_u64(), view["saved"]["applied"].as_bool()), (Some(8445), Some(false)), "{view}");
    assert_eq!(view["url"], format!("https://{DNS}:8444").as_str(), "what applies is still the previous entry");
    assert_eq!(view["serve"]["state"], "ours", "read again after the rollback: the entry that applies");
}

#[tokio::test]
async fn disable_removes_only_its_own_entry_and_ends_streams_that_began_under_it() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    let host = format!("{DNS}:8444");
    // An event stream opened through the phone entry.
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut stream = client.get(format!("http://127.0.0.1:{port}/api/events")).header("host", &host)
        .header("tailscale-user-login", OWNER).send().await.unwrap();
    assert_eq!(stream.status().as_u16(), 200);
    let op = lab.apply(json!({"requestId": "off", "enabled": false})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match stream.chunk().await {
                Ok(Some(_)) => continue,
                _ => break,
            }
        }
    }).await;
    assert!(ended.is_ok(), "the stream outlived the entry it began under");
    assert!(client.get(format!("http://127.0.0.1:{port}/api/health")).send().await.is_err(), "nothing listens any more");
    let serve = &lab.fake()["serve"];
    assert!(serve["Web"].get(format!("{DNS}:8444")).is_none() && serve["TCP"].get("8444").is_none(), "{serve}");
    assert!(serve["Web"][format!("{DNS}:443")].is_object(), "the other service is kept");
    assert!(lab.calls().contains(&"serve --https=8444 off".to_owned()), "{:?}", lab.calls());
    let saved = lab.saved();
    assert_eq!((saved.effective.as_ref().map(|e| e.listen.is_none()), saved.owned.is_none()), (Some(true), true));
    assert_eq!(lab.view().await["serve"]["state"], "absent", "read again after the disable");
    // Off from Settings stays off for a new Core, whatever the environment says.
    let env = RemoteEntry::new(&format!("https://{DNS}:8444"), OWNER).unwrap();
    assert_eq!(startup(&lab.ws.data_dir, Some((free_port(), env))).listen, None);
}

#[tokio::test]
async fn an_entry_changed_outside_yuzuno_is_left_as_it_is() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    lab.set_fake(|s| s["serve"]["Web"][format!("{DNS}:8444")]["Handlers"]["/"]["Proxy"] = json!("http://127.0.0.1:9999"));
    let op = lab.apply(json!({"requestId": "off", "enabled": false})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    assert!(op["notes"][0].as_str().unwrap().contains("changed outside Yuzuno"), "{op}");
    assert!(!lab.calls().iter().any(|c| c.ends_with("off")), "{:?}", lab.calls());
    assert_eq!(lab.fake()["serve"]["Web"][format!("{DNS}:8444")]["Handlers"]["/"]["Proxy"], "http://127.0.0.1:9999");
}

#[tokio::test]
async fn a_serve_change_without_an_answer_is_uncertain_and_the_retry_finishes_without_a_second_entry() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.set_fake(|s| s["lostAdd"] = json!(true));
    let first = lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    // The entry was added before the answer was lost: one more look found it.
    // A lost answer whose entry is not there stays uncertain.
    assert!(matches!(first["state"].as_str(), Some("succeeded") | Some("uncertain")), "{first}");
    let again = lab.apply(json!({"requestId": "again", "enabled": true, "localPort": port})).await.unwrap();
    assert_eq!(again["state"], "succeeded", "{again}");
    let adds = lab.calls().iter().filter(|c| c.starts_with("serve --bg")).count();
    assert_eq!(adds, 1, "{:?}", lab.calls());
    assert_eq!(lab.fake()["serve"]["TCP"].as_object().unwrap().len(), 2, "Core's entry and the other one");
}

#[tokio::test]
async fn a_request_id_repeats_its_operation_and_another_change_waits_for_none() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.set_fake(|s| s["slow"] = json!(1));
    let request = json!({"requestId": "on", "enabled": true, "localPort": port});
    let first = start(&lab.ws, serde_json::from_value(request.clone()).unwrap()).await.unwrap();
    let repeated = start(&lab.ws, serde_json::from_value(request.clone()).unwrap()).await.unwrap();
    assert_eq!(first["id"], repeated["id"]);
    let other = start(&lab.ws, serde_json::from_value(json!({"requestId": "other", "enabled": false})).unwrap()).await.unwrap_err();
    assert!(other.to_string().contains("remote_access_busy"), "{other}");
    let changed = start(&lab.ws, serde_json::from_value(json!({"requestId": "on", "enabled": false})).unwrap()).await.unwrap_err();
    assert!(changed.to_string().contains("idempotency_conflict"), "{changed}");
    lab.set_fake(|s| s["slow"] = json!(0));
    let done = lab.apply(request).await.unwrap();
    assert_eq!(done["id"], first["id"]);
    assert_eq!(done["state"], "succeeded", "{done}");
}

#[tokio::test]
async fn a_port_in_use_keeps_the_previous_entry_and_nothing_else_changes() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let taken = held.local_addr().unwrap().port();
    let calls = lab.calls().len();
    let op = lab.apply(json!({"requestId": "move", "enabled": true, "localPort": taken})).await.unwrap();
    assert_eq!((op["state"].as_str(), op["step"].as_str()), (Some("failed"), Some("listen")), "{op}");
    assert!(op["error"].as_str().unwrap().contains(&format!("127.0.0.1:{taken} is in use")), "{op}");
    assert_eq!(get(port, "/api/health", Some(OWNER), &format!("{DNS}:8444")).await.0, 200);
    assert!(lab.calls()[calls..].iter().all(|c| !c.starts_with("serve --")), "Serve was not changed: {:?}", &lab.calls()[calls..]);
    assert_eq!(lab.view().await["saved"]["applied"], false);
}

#[tokio::test]
async fn the_environment_entry_serves_until_settings_apply_and_is_then_adopted_unchanged() {
    let lab = lab("wsl");
    let port = free_port();
    lab.set_fake(|s| {
        s["serve"]["TCP"]["8444"] = json!({"HTTPS": true});
        s["serve"]["Web"][format!("{DNS}:8444")] = json!({"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{port}")}}});
    });
    let env = RemoteEntry::new(&format!("https://{DNS}:8444"), OWNER).unwrap();
    lab.start(startup(&lab.ws.data_dir, Some((port, env))).bind().await.unwrap());
    let view = lab.view().await;
    assert_eq!(view["listening"]["source"], "environment", "{view}");
    assert_eq!((view["environment"]["ignored"].as_bool(), view["saved"].is_null()), (Some(false), true));
    // Check sees the entry it would set, not yet recorded as Core's.
    let checked = lab.check().await;
    assert_eq!(checked["serve"]["state"], "sameTargetNotRecorded", "{checked}");
    assert_eq!(checked["url"], format!("https://{DNS}:8444").as_str());
    let before = lab.calls().len();
    let op = lab.apply(json!({"requestId": "adopt", "enabled": true, "localPort": port})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    assert!(lab.calls()[before..].iter().all(|c| !c.starts_with("serve --")), "adopted without a Serve change: {:?}", &lab.calls()[before..]);
    let view = lab.view().await;
    assert_eq!((view["listening"]["source"].as_str(), view["environment"]["ignored"].as_bool(), view["serve"]["state"].as_str()),
        (Some("settings"), Some(true), Some("ours")), "{view}");
}

#[tokio::test]
async fn an_unsupported_host_changes_nothing_and_says_why() {
    let lab = lab("linux");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let op = lab.apply(json!({"requestId": "on", "enabled": true})).await.unwrap();
    assert_eq!((op["state"].as_str(), op["step"].as_str()), (Some("failed"), Some("validate")), "{op}");
    assert!(op["error"].as_str().unwrap().contains("Core in WSL with Tailscale for Windows"), "{op}");
    let checked = lab.check().await;
    let steps = checked["verification"]["steps"].as_array().unwrap();
    assert_eq!(steps[0]["state"], "failed");
    assert!(steps[1..].iter().all(|s| s["state"] == "skipped"), "{steps:?}");
    assert_eq!(checked["support"]["state"], "unsupported");
    assert!(lab.calls().is_empty(), "no Tailscale command ran: {:?}", lab.calls());
    assert!(lab.saved().effective.is_none());
}

#[tokio::test]
async fn reading_the_page_or_checking_writes_nothing() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    lab.view().await;
    lab.check().await;
    assert!(!path(&lab.ws).exists(), "no record without a change");
    assert!(lab.calls().iter().all(|c| c.ends_with("--json")), "{:?}", lab.calls());
}

#[tokio::test]
async fn an_unreadable_record_leaves_phone_access_off_with_its_reason() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(FILE), "{not json").unwrap();
    let env = RemoteEntry::new(&format!("https://{DNS}:8444"), OWNER).unwrap();
    let started = startup(dir.path(), Some((free_port(), env)));
    assert_eq!(started.listen, None);
    assert!(started.error.unwrap().contains("Phone access was not started"));
}

#[test]
fn serve_entries_are_matched_exactly() {
    let config = json!({"TCP": {"8444": {"HTTPS": true}, "443": {"HTTPS": true}},
        "Web": {format!("{DNS}:8444"): {"Handlers": {"/": {"Proxy": "http://127.0.0.1:4318"}}}, format!("{DNS}:443"): {"Handlers": {"/": {"Proxy": "x"}}}}});
    assert_eq!(host::serve_entry(&config, DNS, 8444, "http://127.0.0.1:4318").0, "match");
    assert_eq!(host::serve_entry(&config, DNS, 8444, "http://127.0.0.1:4319").0, "conflict");
    assert_eq!(host::serve_entry(&config, DNS, 8445, "http://127.0.0.1:4318").0, "absent");
    assert_eq!(host::other_entries(&config, 8444), 1);
    let mut funnel = config.clone();
    funnel["AllowFunnel"] = json!({format!("{DNS}:8444"): true});
    assert_eq!(host::serve_entry(&funnel, DNS, 8444, "http://127.0.0.1:4318").0, "conflict");
    let mut extra = config;
    extra["Web"][format!("{DNS}:8444")]["Handlers"]["/admin"] = json!({"Proxy": "y"});
    assert_eq!(host::serve_entry(&extra, DNS, 8444, "http://127.0.0.1:4318").0, "conflict");
}

#[tokio::test]
async fn a_new_login_on_the_same_port_ends_what_the_old_login_opened() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    let host = format!("{DNS}:8444");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut stream = client.get(format!("http://127.0.0.1:{port}/api/events")).header("host", &host)
        .header("tailscale-user-login", OWNER).send().await.unwrap();
    assert_eq!(stream.status().as_u16(), 200);
    let op = lab.apply(json!({"requestId": "other-login", "enabled": true, "localPort": port, "login": "partner@github"})).await.unwrap();
    assert_eq!(op["state"].as_str(), Some("succeeded"), "{op}");
    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(Some(_)) = stream.chunk().await {}
    }).await;
    assert!(ended.is_ok(), "the old login's stream outlived the change");
    assert_eq!(get(port, "/api/health", Some(OWNER), &host).await.0, 403, "the old login is refused now");
    assert_eq!(get(port, "/api/health", Some("partner@github"), &host).await.0, 200);
}

#[tokio::test]
async fn an_operation_a_stopped_core_left_running_is_marked_interrupted() {
    let lab = lab("wsl");
    let left = Operation {
        id: "op-1".into(), request_id: "r-1".into(), kind: "apply".into(), state: "running".into(), step: "serve".into(),
        error: None, notes: Vec::new(), started_at: "2026-10-24T00:00:00Z".into(), finished_at: None, url: None,
        request: serde_json::from_value(json!({"requestId": "r-1", "enabled": true})).unwrap(),
    };
    update(&lab.ws, |saved| { saved.operations.push(left); Ok(()) }).unwrap();
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let op = lab.view().await["operation"].clone();
    assert_eq!((op["state"].as_str(), op["step"].as_str()), (Some("interrupted"), Some("serve")), "{op}");
    assert!(op["error"].as_str().unwrap().contains("Core stopped during the serve step"), "{op}");
    // Its request id answers with that record; a new request may run.
    assert_eq!(start(&lab.ws, serde_json::from_value(json!({"requestId": "r-1", "enabled": true})).unwrap()).await.unwrap()["state"], "interrupted");
}

#[tokio::test]
async fn a_taken_port_at_startup_stops_core_only_for_the_environment_entry() {
    let dir = tempfile::tempdir().unwrap();
    let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let taken = held.local_addr().unwrap().port();
    let env = RemoteEntry::new(&format!("https://{DNS}:8444"), OWNER).unwrap();
    let error = startup(dir.path(), Some((taken, env))).bind().await.err().expect("YUZUNO_REMOTE_PORT taken stops Core");
    assert!(format!("{error:#}").contains("YUZUNO_REMOTE_PORT"), "{error:#}");
    let saved = Saved { format: 1, effective: Some(Applied { listen: Some(Entry { port: taken, origin: format!("https://{DNS}:8444"), login: OWNER.into() }),
        serve_port: Some(8444), applied_at: "2026-10-24T00:00:00Z".into() }), ..Default::default() };
    crate::updates::package::atomic_json(&dir.path().join(FILE), &saved).unwrap();
    let bound = startup(dir.path(), None).bind().await.expect("a Settings port taken leaves Core running");
    assert!(bound.listener.is_none());
    assert!(bound.error.unwrap().contains(&format!("could not listen on 127.0.0.1:{taken}")));
}

#[tokio::test]
async fn a_refused_removal_turns_core_off_and_keeps_the_entry_recorded_as_its_own() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    lab.set_fake(|s| s["failOff"] = json!("serve config locked"));
    let op = lab.apply(json!({"requestId": "off", "enabled": false})).await.unwrap();
    assert_eq!(op["state"], "failed", "{op}");
    assert!(op["error"].as_str().unwrap().contains("serve config locked"), "{op}");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert!(client.get(format!("http://127.0.0.1:{port}/api/health")).send().await.is_err(), "Core stopped listening anyway");
    assert_eq!(lab.saved().owned.map(|o| o.serve_port), Some(8444), "still recorded, so a later disable can remove it");
    lab.set_fake(|s| s["failOff"] = Value::Null);
    let again = lab.apply(json!({"requestId": "off-again", "enabled": false})).await.unwrap();
    assert_eq!(again["state"], "succeeded", "{again}");
    assert!(lab.fake()["serve"]["TCP"].get("8444").is_none());
}

/// The page is built on the example views in this file (T-185, Dev 3); a
/// real view must keep their fields, and the states they list.
const VIEWS: &str = include_str!("../../../web/tools/fixtures/remote-access-views.json");

fn keys(value: &Value) -> std::collections::BTreeSet<String> {
    value.as_object().map(|o| o.keys().filter(|k| !k.starts_with('_')).cloned().collect()).unwrap_or_default()
}

#[tokio::test]
async fn real_views_keep_the_shape_the_page_is_built_on() {
    let fixtures: Value = serde_json::from_str(VIEWS).unwrap();
    let example = &fixtures["appliedVerified"];
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let port = free_port();
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": port})).await.unwrap();
    let real = lab.view().await;
    let mut known = keys(example);
    known.extend(keys(&fixtures["remoteEntryReadOnly"]));
    assert!(keys(&real).is_subset(&known), "fields the page does not know: {:?}", keys(&real).difference(&known).collect::<Vec<_>>());
    assert!(keys(example).is_subset(&keys(&real)), "fields the page reads but Core does not send: {:?}", keys(example).difference(&keys(&real)).collect::<Vec<_>>());
    for field in ["support", "saved", "listening", "serve", "tailscale", "verification", "qr", "defaults"] {
        assert_eq!(keys(&real[field]), keys(&example[field]), "{field}");
    }
    for field in ["coreHost", "tailscaleHost"] {
        assert_eq!(keys(&real["support"][field]), keys(&example["support"][field]), "support.{field}");
    }
    let optional: std::collections::BTreeSet<String> = ["error", "notes"].map(String::from).into();
    let mut op_known = keys(&example["operation"]);
    op_known.extend(optional);
    assert!(keys(&real["operation"]).is_subset(&op_known), "{}", real["operation"]);
    assert_eq!(keys(&real["operation"]["request"]), keys(&example["operation"]["request"]));
    let ids = |view: &Value| view["verification"]["steps"].as_array().unwrap().iter().map(|s| s["id"].clone()).collect::<Vec<_>>();
    assert_eq!(ids(&real), ids(example));
    for step in real["verification"]["steps"].as_array().unwrap() {
        assert_eq!(keys(step), ["detail", "id", "state"].map(String::from).into());
    }
    // The states and steps Core can report, as the page lists them.
    let list = |name: &str| fixtures[name].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(list("operationStates"), ["running", "succeeded", "failed", "rolledBack", "uncertain", "interrupted"]);
    assert_eq!(list("operationSteps"), ["validate", "save", "listen", "serve", "verify", "done"]);
    assert_eq!(list("serveStates"), ["unchecked", "absent", "ours", "sameTargetNotRecorded", "conflict", "error"]);
    // Through the phone entry: read-only, with its reason.
    let remote = view(&lab.ws, false).await.unwrap();
    assert_eq!(remote["canChange"], false);
    assert!(remote["readOnlyReason"].is_string());
}

#[tokio::test]
async fn a_check_before_setup_reads_serve_for_the_planned_port() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let serve_step = |view: &Value, id: &str| view["verification"]["steps"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap().clone();
    let free = lab.check().await;
    assert_eq!(free["serve"]["state"], "absent", "{}", free["serve"]);
    assert_eq!(serve_step(&free, "serve")["state"], "skipped");
    assert!(serve_step(&free, "serve")["detail"].as_str().unwrap().contains("Port 8444 is free"), "{free}");
    lab.set_fake(|s| {
        s["serve"]["TCP"]["8444"] = json!({"HTTPS": true});
        s["serve"]["Web"][format!("{DNS}:8444")] = json!({"Handlers": {"/": {"Proxy": "http://127.0.0.1:9999"}}});
    });
    let taken = lab.check().await;
    assert_eq!(taken["serve"]["state"], "conflict", "{}", taken["serve"]);
    assert_eq!(serve_step(&taken, "serve")["state"], "failed");
    assert!(lab.calls().iter().all(|c| c.ends_with("--json")), "read only: {:?}", lab.calls());
}

#[tokio::test]
async fn a_first_apply_rolled_back_says_phone_access_stays_off() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    lab.set_fake(|s| {
        s["serve"]["TCP"]["8444"] = json!({"HTTPS": true, "TCPForward": "127.0.0.1:22"});
    });
    let op = lab.apply(json!({"requestId": "on", "enabled": true, "localPort": free_port()})).await.unwrap();
    assert_eq!(op["state"], "rolledBack", "{op}");
    let error = op["error"].as_str().unwrap();
    assert!(error.contains("(TCP 8444 → 127.0.0.1:22)") && error.ends_with("phone access stays off"), "{error}");
    assert!(lab.view().await["listening"].is_null());
}

#[tokio::test]
async fn a_new_local_port_on_the_same_serve_port_replaces_cores_own_entry() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let (first, second) = (free_port(), free_port());
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": first})).await.unwrap();
    let before = lab.calls().len();
    let op = lab.apply(json!({"requestId": "move", "enabled": true, "localPort": second})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    let changes: Vec<String> = lab.calls()[before..].iter().filter(|c| c.starts_with("serve --")).cloned().collect();
    assert_eq!(changes, [format!("serve --https=8444 off"), format!("serve --bg --https=8444 http://127.0.0.1:{second}")]);
    let serve = &lab.fake()["serve"];
    assert_eq!(serve["Web"][format!("{DNS}:8444")]["Handlers"]["/"]["Proxy"], format!("http://127.0.0.1:{second}").as_str());
    assert!(serve["Web"][format!("{DNS}:443")].is_object(), "the other service is kept");
    let host = format!("{DNS}:8444");
    assert_eq!(get(second, "/api/health", Some(OWNER), &host).await.0, 200);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert!(client.get(format!("http://127.0.0.1:{first}/api/health")).send().await.is_err(), "the old port is closed");
    assert_eq!(lab.saved().owned.map(|o| o.target), Some(format!("http://127.0.0.1:{second}")));
}

#[tokio::test]
async fn a_refused_replacement_points_serve_back_at_the_previous_entry() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let (first, second) = (free_port(), free_port());
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": first})).await.unwrap();
    lab.set_fake(|s| s["failAddTarget"] = json!(format!("http://127.0.0.1:{second}")));
    let op = lab.apply(json!({"requestId": "move", "enabled": true, "localPort": second})).await.unwrap();
    assert_eq!(op["state"], "rolledBack", "{op}");
    assert!(op["error"].as_str().unwrap().ends_with("The previous phone access is unchanged"), "{op}");
    assert!(op.get("notes").is_none(), "pointed back: {op}");
    assert_eq!(lab.fake()["serve"]["Web"][format!("{DNS}:8444")]["Handlers"]["/"]["Proxy"], format!("http://127.0.0.1:{first}").as_str());
    assert_eq!(get(first, "/api/health", Some(OWNER), &format!("{DNS}:8444")).await.0, 200);
    let saved = lab.saved();
    assert_eq!(saved.effective.and_then(|e| e.listen).map(|e| e.port), Some(first));
}

#[tokio::test]
async fn an_unanswered_serve_add_puts_the_previous_listener_back_and_keeps_the_record() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let (first, second) = (free_port(), free_port());
    lab.apply(json!({"requestId": "on", "enabled": true, "localPort": first})).await.unwrap();
    lab.set_fake(|s| s["hangAdd"] = json!(true));
    let op = lab.apply(json!({"requestId": "move", "enabled": true, "localPort": second, "servePort": 8445})).await.unwrap();
    assert_eq!(op["state"], "uncertain", "{op}");
    // What applies is unchanged in Core and in its record: a restart now serves the same entry.
    assert_eq!(get(first, "/api/health", Some(OWNER), &format!("{DNS}:8444")).await.0, 200);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert!(client.get(format!("http://127.0.0.1:{second}/api/health")).send().await.is_err());
    assert_eq!(startup(&lab.ws.data_dir, None).listen.map(|(e, _)| e.port), Some(first));
    lab.set_fake(|s| s["hangAdd"] = Value::Null);
    let again = lab.apply(json!({"requestId": "move-again", "enabled": true, "localPort": second, "servePort": 8445})).await.unwrap();
    assert_eq!(again["state"], "succeeded", "{again}");
    assert!(lab.fake()["serve"]["TCP"].get("8444").is_none(), "the previous entry, on another port, removed");
}

#[tokio::test]
async fn an_unreadable_record_is_kept_aside_by_the_next_apply() {
    let lab = lab("wsl");
    std::fs::write(path(&lab.ws), "{not json").unwrap();
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let view = lab.view().await;
    assert!(view["startupError"].as_str().unwrap().contains("Phone access was not started"), "{view}");
    let op = lab.apply(json!({"requestId": "on", "enabled": true, "localPort": free_port()})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    assert!(op["notes"][0].as_str().unwrap().contains("could not be read"), "{op}");
    let kept: Vec<_> = std::fs::read_dir(&lab.ws.data_dir).unwrap().flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("remote-access.json.unreadable-")).collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(std::fs::read_to_string(kept[0].path()).unwrap(), "{not json");
}
