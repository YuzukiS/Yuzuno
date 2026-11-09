//! Phone access from Settings (T-185) against stand-ins for Windows'
//! tailscale.exe and curl.exe, which keep the Serve configuration in a JSON
//! file and play Serve's part for a request through it (the Host header and
//! `Tailscale-User-Login` of this PC's owner). Core's own listeners are real.
//! No real Tailscale, Serve, Windows or daily Core is reached.
use super::*;
use crate::test_ports::free_port;
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
        view(&self.ws, false).await.unwrap()
    }
    /// POST /api/remote-access/check, as the page on Core's port makes it.
    async fn check(&self) -> Value {
        match post_check(AppState(self.ws.clone()), Request::new(axum::body::Body::empty())).await {
            Ok(Json(value)) => value,
            Err(_) => panic!("check failed"),
        }
    }
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
    // Through the phone entry the page says so, and a change is served there too (YN-79).
    let (code, body) = get(port, "/api/remote-access", Some(OWNER), &host).await;
    assert_eq!(code, 200, "{body}");
    let remote: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(remote["phoneEntry"], true, "{remote}");
    assert!(remote.get("canChange").is_none() && remote.get("readOnlyReason").is_none(), "{remote}");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let refused = client.post(format!("http://127.0.0.1:{port}/api/remote-access/apply")).header("host", &host)
        .header("tailscale-user-login", OWNER).header("origin", &origin).header("x-yuzuno-client", "desktop")
        .json(&json!({"requestId": "", "enabled": false})).send().await.unwrap();
    // Reaching the route, and refused by its own check: not a missing route.
    assert_eq!(refused.status().as_u16(), 400, "{}", refused.text().await.unwrap_or_default());
    // A new Core on the same data serves the applied entry, and an environment entry does not override it.
    let env = RemoteEntry::new("https://elsewhere.ts.net:9000", "env@github").unwrap();
    let next = startup(&lab.ws.data_dir, Some((free_port(), env)));
    assert_eq!(next.listen, Some((Entry { port, origin: origin.clone(), login: OWNER.into() }, "settings")));
}

#[tokio::test]
async fn a_phone_changes_its_own_access_and_the_entry_ends_with_it() {
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let phone = free_port();
    let op = lab.apply(json!({"requestId": "on", "enabled": true, "localPort": phone})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    let host = format!("{DNS}:8444");
    let origin = format!("https://{DNS}:8444");
    // The page through the phone entry reads it, then turns phone access off itself (YN-79).
    let (code, view) = get(phone, "/api/remote-access", Some(OWNER), &host).await;
    assert_eq!(code, 200, "{view}");
    assert_eq!(serde_json::from_str::<Value>(&view).unwrap()["phoneEntry"], true, "{view}");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let answer = client.post(format!("http://127.0.0.1:{phone}/api/remote-access/apply")).header("host", &host)
        .header("tailscale-user-login", OWNER).header("origin", &origin).header("x-yuzuno-client", "desktop")
        .json(&json!({"requestId": "off-from-phone", "enabled": false})).send().await.unwrap();
    assert_eq!(answer.status().as_u16(), 200, "{}", answer.text().await.unwrap_or_default());
    for _ in 0..400 {
        if lab.saved().operations.iter().any(|o| o.request_id == "off-from-phone" && o.state != "running") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(lab.view().await["listening"].is_null(), "phone access is off, as the phone asked");
    assert!(client.get(format!("http://127.0.0.1:{phone}/api/health")).send().await.is_err(), "the entry that answered no longer listens");
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
        error: None, notes: Vec::new(), started_at: "2026-10-24T00:00:00Z".into(), finished_at: None, url: None, legacy: None,
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
    known.extend(keys(&fixtures["throughPhone"]));
    assert!(keys(&real).is_subset(&known), "fields the page does not know: {:?}", keys(&real).difference(&known).collect::<Vec<_>>());
    assert!(keys(example).is_subset(&keys(&real)), "fields the page reads but Core does not send: {:?}", keys(example).difference(&keys(&real)).collect::<Vec<_>>());
    for field in ["support", "saved", "listening", "serve", "tailscale", "verification", "qr", "defaults", "previews"] {
        assert_eq!(keys(&real[field]), keys(&example[field]), "{field}");
    }
    for field in ["coreHost", "tailscaleHost"] {
        assert_eq!(keys(&real["support"][field]), keys(&example["support"][field]), "support.{field}");
    }
    let optional: std::collections::BTreeSet<String> = ["error", "notes", "legacy"].map(String::from).into();
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
    assert_eq!(list("operationStates"), ["running", "succeeded", "failed", "rolledBack", "uncertain", "interrupted", "partial"]);
    assert_eq!(list("operationSteps"), ["validate", "save", "listen", "serve", "verify", "cleanup", "done"]);
    assert_eq!(list("serveStates"), ["unchecked", "absent", "ours", "sameTargetNotRecorded", "conflict", "error"]);
    // Through the phone entry: the same shape, saying the page is there (YN-79).
    let remote = view(&lab.ws, true).await.unwrap();
    assert_eq!(remote["phoneEntry"], true);
    assert!(remote.get("canChange").is_none() && remote.get("readOnlyReason").is_none());
    assert!(keys(&remote).is_subset(&known), "fields the page does not know: {:?}", keys(&remote).difference(&known).collect::<Vec<_>>());
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
    // The context comes first: "The previous phone access is unchanged: Tailscale Serve refused …".
    assert!(op["error"].as_str().unwrap().starts_with("The previous phone access is unchanged: Tailscale Serve refused"), "{op}");
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

// ---- phone previews (T-5) ----------------------------------------------

const PAGE: &str = "<!doctype html><title>Proto</title><button onclick=\"this.textContent='clicked'\">Try</button>";
/// Yuzuno's own page, as the lab's web folder has it: what a path that fell
/// through to the page would get.
const SHELL: &str = "<!doctype html><title>Yuzuno</title><p>the app shell</p>";

impl Lab {
    /// An Agent "a" whose working directory holds `proto.html`, for
    /// previews; and Yuzuno's page in the web folder.
    fn with_page(&self) {
        let work = self.dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("proto.html"), PAGE).unwrap();
        std::fs::create_dir_all(self.dir.path().join("web")).unwrap();
        std::fs::write(self.dir.path().join("web/index.html"), SHELL).unwrap();
        let agent: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":work,"model":"test","color":"sage",
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).unwrap();
        self.ws.store.insert(&agent).unwrap();
    }
    /// Phone access on `phone`, including previews.
    async fn on_with_previews(&self, phone: u16) {
        self.start(startup(&self.ws.data_dir, None).bind().await.unwrap());
        let op = self.apply(json!({"requestId": "on", "enabled": true, "localPort": phone, "previews": true})).await.unwrap();
        assert_eq!((op["state"].as_str(), op["step"].as_str()), (Some("succeeded"), Some("done")), "{op}");
    }
    /// An older Core's phone previews record, as it is on disk.
    fn legacy_record(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.ws.data_dir.join("remote-preview.json")).unwrap()).unwrap()
    }
}

/// A preview asked for through the phone entry on `port`, as Serve passes a
/// phone's request: its Host, the login, the page's origin and client header.
async fn mint(port: u16, login: &str) -> (u16, Value) {
    mint_source(port, login, json!({"kind": "artifact", "agentId": "a", "path": "proto.html"})).await
}

/// The same for the preview of `source`.
async fn mint_source(port: u16, login: &str, source: Value) -> (u16, Value) {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client.post(format!("http://127.0.0.1:{port}/api/previews")).header("host", format!("{DNS}:8444"))
        .header("tailscale-user-login", login).header("origin", format!("https://{DNS}:8444")).header("x-yuzuno-client", "desktop")
        .json(&source).send().await.unwrap();
    let code = response.status().as_u16();
    (code, response.json().await.unwrap_or(Value::Null))
}

/// One request on the phone entry as Serve passes it: the path and header
/// lines as given. Its answer's status, head and body, a chunked one put
/// together (every answer there is a stream, `end_on_revoke`).
async fn raw(port: u16, method: &str, path: &str, headers: &str) -> (u16, String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(format!("{method} {path} HTTP/1.1\r\n{headers}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut text = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), stream.read_to_string(&mut text)).await;
    let status = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let body = if has(head, "Transfer-Encoding", "chunked") { unchunked(body) } else { body.to_owned() };
    (status, head.to_owned(), body)
}

/// A chunked body's bytes, as text.
fn unchunked(mut rest: &str) -> String {
    let mut body = String::new();
    while let Some((size, after)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        if size == 0 || after.len() < size {
            break;
        }
        body.push_str(&after[..size]);
        rest = after[size..].strip_prefix("\r\n").unwrap_or(&after[size..]);
    }
    body
}

/// What follows the phone entry's origin in `url`.
fn after_origin(url: &Value) -> String {
    url.as_str().unwrap().strip_prefix(&format!("https://{DNS}:8444")).unwrap().to_owned()
}

fn has(head: &str, name: &str, value: &str) -> bool {
    head.split("\r\n").any(|line| line.split_once(':').is_some_and(|(n, v)| n.eq_ignore_ascii_case(name) && v.trim() == value))
}

fn named(head: &str, name: &str) -> bool {
    head.split("\r\n").any(|line| line.split_once(':').is_some_and(|(n, _)| n.eq_ignore_ascii_case(name)))
}

/// The head lines Serve adds for this PC's owner on the phone entry.
fn as_serve() -> String {
    format!("Host: {DNS}:8444\r\nTailscale-User-Login: {OWNER}\r\nX-Forwarded-For: 100.64.0.2\r\n")
}

/// As `as_serve`, for a change from the phone page itself.
fn from_page() -> String {
    format!("{}Origin: https://{DNS}:8444\r\nX-Yuzuno-Client: desktop\r\n", as_serve())
}

#[tokio::test]
async fn a_6_6_mb_home_attachment_opens_whole_through_the_phone_entry() {
    use sha2::Digest;
    let lab = lab("wsl");
    lab.with_page();
    let file = lab.dir.path().join("work/large.html");
    let page = crate::previews::synthetic_page(6_606_144);
    std::fs::write(&file, &page).unwrap();
    let kept = crate::project_brief::attach_for_test(&lab.ws, "a", "designs", &file).await;
    let phone = free_port();
    lab.on_with_previews(phone).await;
    let source = json!({"kind": "briefAttachment", "projectId": kept["projectId"], "section": "designs", "name": "large.html"});
    let (code, minted) = mint_source(phone, OWNER, source).await;
    assert_eq!(code, 200, "a 6.6 MB Home attachment opens through the phone entry: {minted}");
    // The page as Serve passes a phone's request for it (`as_serve`).
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client.get(format!("http://127.0.0.1:{phone}{}", after_origin(&minted["url"])))
        .header("host", format!("{DNS}:8444")).header("tailscale-user-login", OWNER).header("x-forwarded-for", "100.64.0.2")
        .send().await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let policy = crate::previews::page_policy(Some(&format!("https://{DNS}:8444")));
    assert_eq!(response.headers().get("content-security-policy").and_then(|v| v.to_str().ok()), Some(policy.as_str()));
    assert!(response.headers().get("x-frame-options").is_none(), "{:?}", response.headers());
    let body = response.bytes().await.unwrap();
    let sha = format!("{:x}", sha2::Sha256::digest(&page));
    assert_eq!(minted["sha256"].as_str(), Some(sha.as_str()), "{minted}");
    assert_eq!(format!("{:x}", sha2::Sha256::digest(&body)), sha, "the page as it was kept, whole ({} bytes came)", body.len());
}

const APART: &str = "YUZUNO_TEST_PREVIEW_APART";

/// What serving a 20 MiB Home attachment's preview costs (YN-10): opened on
/// the previews' port and through the phone entry, each page read whole by a
/// client that keeps none of it, while the allocator counts how far the
/// heap grew (`test_alloc`). In a test process of its own, so no other
/// test's allocations count; the client's own do, so it is a bound. VmRSS
/// and VmHWM before and after are reported only.
#[test]
fn a_20_mib_preview_is_served_without_the_page_in_memory() {
    let name = format!("{}::a_20_mib_preview_is_served_without_the_page_in_memory", module_path!().split_once("::").unwrap().1);
    if std::env::var(APART).as_deref() == Ok(name.as_str()) {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        println!("{APART}={}", runtime.block_on(served_apart()));
        return;
    }
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args([name.as_str(), "--exact", "--nocapture", "--test-threads=1"])
        .env(APART, &name)
        .output()
        .unwrap();
    let (said, err) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success(), "{}\n{said}\n{err}", out.status);
    let marker = format!("{APART}=");
    let line = said.lines().find_map(|line| line.split_once(marker.as_str()).map(|(_, said)| said))
        .unwrap_or_else(|| panic!("what the process measured, in what it said:\n{said}"));
    let report: Value = serde_json::from_str(line).unwrap();
    println!("a 20 MiB preview served on both routes: {report}");
    let size = report["size"].as_u64().unwrap();
    assert!(report["localBytes"].as_u64().unwrap() >= size && report["phoneBytes"].as_u64().unwrap() >= size, "{report}");
    assert!(report["heapGrowthPeakBytes"].as_i64().unwrap() < 2 << 20, "the page is never held whole: {report}");
}

/// The measurement itself (`a_20_mib_preview_is_served_without_the_page_in_memory`).
async fn served_apart() -> Value {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const SIZE: usize = 20 << 20;
    /// Every byte of the answer to `request`, keeping none: how many came.
    async fn drained(port: u16, request: String) -> u64 {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let (mut chunk, mut total) = (vec![0u8; 16 << 10], 0u64);
        loop {
            match stream.read(&mut chunk).await.unwrap() {
                0 => return total,
                n => total += n as u64,
            }
        }
    }
    let lab = lab("wsl");
    lab.with_page();
    let file = lab.dir.path().join("work/large.html");
    std::fs::write(&file, crate::previews::synthetic_page(SIZE)).unwrap();
    let kept = crate::project_brief::attach_for_test(&lab.ws, "a", "designs", &file).await;
    let phone = free_port();
    lab.on_with_previews(phone).await;
    let local = free_port();
    lab.ws.services.use_ports(local..=local);
    let source = json!({"kind": "briefAttachment", "projectId": kept["projectId"], "section": "designs", "name": "large.html"});
    let before = memory_status();
    crate::test_alloc::count();
    let asker = crate::previews::Asker::Local(Some("http://localhost:4317"));
    let view = lab.ws.open_preview(serde_json::from_value(source.clone()).unwrap(), asker).await.unwrap();
    let port = view["port"].as_u64().unwrap() as u16;
    let page = view["url"].as_str().unwrap().split_once(&format!(":{port}")).unwrap().1.to_owned();
    let local_bytes = drained(port, format!("GET {page} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")).await;
    let (code, minted) = mint_source(phone, OWNER, source).await;
    assert_eq!(code, 200, "{minted}");
    let phone_bytes = drained(phone, format!("GET {} HTTP/1.1\r\n{}Connection: close\r\n\r\n", after_origin(&minted["url"]), as_serve())).await;
    let (peak, largest) = crate::test_alloc::counted_so_far();
    json!({"size": SIZE, "localBytes": local_bytes, "phoneBytes": phone_bytes, "heapGrowthPeakBytes": peak,
        "largestAllocationBytes": largest, "before": before, "after": memory_status()})
}

/// This process's VmRSS and VmHWM in KiB, as /proc says them now.
fn memory_status() -> Value {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| {
        status.lines().find_map(|line| line.strip_prefix(name)).and_then(|value| value.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
    };
    json!({"vmRssKiB": field("VmRSS:"), "vmHwmKiB": field("VmHWM:")})
}

#[tokio::test]
async fn a_card_preview_through_the_phone_entry_is_given_again_on_that_run_only() {
    let lab = lab("wsl");
    lab.with_page();
    let file = lab.dir.path().join("work/card.html");
    std::fs::write(&file, PAGE).unwrap();
    let kept = crate::project_brief::attach_for_test(&lab.ws, "a", "designs", &file).await;
    let phone = free_port();
    lab.on_with_previews(phone).await;
    let card = json!({"kind": "briefAttachment", "projectId": kept["projectId"], "section": "designs", "name": "card.html",
        "version": kept["version"], "place": "card"});
    let (_, first) = mint_source(phone, OWNER, card.clone()).await;
    let (_, again) = mint_source(phone, OWNER, card.clone()).await;
    assert_eq!((&first["reused"], &again["reused"], &again["url"]), (&json!(false), &json!(true), &first["url"]), "{first} {again}");
    assert_eq!((again["proof"]["method"].as_str(), again["version"].clone()), (Some("POST"), kept["version"].clone()));
    // A Range request gets the whole page, with the same headers.
    let page = after_origin(&first["url"]);
    let (status, head, body) = raw(phone, "GET", &page, &format!("{}Range: bytes=0-9\r\n", as_serve())).await;
    assert_eq!((status, body.as_str()), (200, PAGE), "{head}");
    let policy = crate::previews::page_policy(Some(&format!("https://{DNS}:8444")));
    assert!(has(&head, "Content-Security-Policy", &policy) && !named(&head, "Content-Range") && !named(&head, "X-Frame-Options"), "{head}");
    // What the phone was given ends with its run, a card's as well.
    lab.ws.previews.revoke_phone(None);
    assert_eq!(raw(phone, "GET", &page, &as_serve()).await.0, 404);
    let (_, later) = mint_source(phone, OWNER, card).await;
    assert!(later["reused"] == json!(false) && later["url"] != first["url"], "{later}");
}

#[tokio::test]
async fn previews_open_on_the_phone_entrys_own_origin_through_its_one_serve_entry() {
    let lab = lab("wsl");
    lab.with_page();
    let phone = free_port();
    lab.on_with_previews(phone).await;
    // Serve: the phone entry beside the other service, and nothing else; nothing reset.
    let serve = &lab.fake()["serve"];
    assert_eq!(serve["TCP"].as_object().unwrap().keys().collect::<Vec<_>>(), ["443", "8444"], "{serve}");
    assert_eq!(serve["Web"].as_object().unwrap().len(), 2, "{serve}");
    let changes: Vec<String> = lab.calls().into_iter().filter(|c| c.starts_with("serve --")).collect();
    assert_eq!(changes, [format!("serve --bg --https=8444 http://127.0.0.1:{phone}")]);
    let view = lab.view().await;
    assert_eq!(view["previews"], json!({"included": true, "available": true, "legacy": null}), "{view}");
    assert_eq!(view["saved"]["previews"], true);

    // Asked for through the phone entry: its own origin, a proof by POST.
    let origin = format!("https://{DNS}:8444");
    let (code, minted) = mint(phone, OWNER).await;
    assert_eq!(code, 200, "{minted}");
    let page = after_origin(&minted["url"]);
    let token = page.strip_prefix("/__yuzuno/preview/v/").unwrap_or_else(|| panic!("{minted}")).to_owned();
    assert!(token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{minted}");
    assert!(after_origin(&minted["proof"]["url"]).starts_with("/__yuzuno/preview/proof/"), "{minted}");
    assert_eq!((minted["proof"]["method"].as_str(), minted["port"].as_u64()), (Some("POST"), Some(8444)), "{minted}");

    // The page: every header of its own, framed only by the phone page, never refused by X-Frame-Options.
    let (status, head, body) = raw(phone, "GET", &page, &as_serve()).await;
    assert_eq!((status, body.as_str()), (200, PAGE), "{head}");
    for (name, value) in [
        ("Content-Type", "text/html; charset=utf-8".to_owned()),
        ("Content-Security-Policy", crate::previews::page_policy(Some(&origin))),
        ("Cross-Origin-Opener-Policy", "same-origin".into()),
        ("Cross-Origin-Resource-Policy", "same-origin".into()),
        ("Referrer-Policy", "no-referrer".into()),
        ("X-Content-Type-Options", "nosniff".into()),
        ("Cache-Control", "no-store".into()),
    ] {
        assert!(has(&head, name, &value), "{name}: {head}");
    }
    assert!(head.to_ascii_lowercase().contains("permissions-policy: accelerometer=(), camera=()"), "{head}");
    assert!(!named(&head, "X-Frame-Options") && !named(&head, "Access-Control-Allow-Origin"), "{head}");
    let (status, head_only, body) = raw(phone, "HEAD", &page, &as_serve()).await;
    assert_eq!((status, body.as_str()), (200, ""), "{head_only}");
    assert!(has(&head_only, "Content-Security-Policy", &crate::previews::page_policy(Some(&origin))) && !named(&head_only, "X-Frame-Options"), "{head_only}");
    // Yuzuno's own page and API are never framed.
    for path in ["/api/health", "/", "/api/remote-access", "/some/page"] {
        let (_, head, _) = raw(phone, "GET", path, &as_serve()).await;
        assert!(has(&head, "X-Frame-Options", "DENY"), "{path}: {head}");
    }

    // Anyone or anything else gets no page.
    let refused = [
        (format!("Host: {DNS}:8444\r\n"), 403, "no login"),
        (format!("Host: {DNS}:8444\r\nTailscale-User-Login: someone@else\r\n"), 403, "another login"),
        (format!("Host: {DNS}:8444\r\nTailscale-User-Login: {OWNER}\r\nTailscale-User-Login: {OWNER}\r\n"), 403, "the login twice"),
        (format!("{}Tailscale-Funnel-Request: ?1\r\n", as_serve()), 403, "Funnel"),
        (format!("Host: 127.0.0.1:{phone}\r\nTailscale-User-Login: {OWNER}\r\n"), 403, "a loopback name"),
        (format!("{}Upgrade: websocket\r\n", as_serve()), 400, "a change of protocol"),
    ];
    for (headers, want, what) in refused {
        let (status, _, body) = raw(phone, "GET", &page, &headers).await;
        assert_eq!(status, want, "{what}: {body}");
        assert!(!body.contains("button") && !body.contains(SHELL), "{what}: {body}");
    }
    assert_eq!(raw(phone, "POST", &page, &from_page()).await.0, 405, "a page only by GET or HEAD");
    // Nothing under the reserved path is Yuzuno's page, however its path is written.
    let first = token.as_bytes()[0];
    for path in [
        format!("/__yuzuno/preview/v/{}", "0".repeat(64)),
        format!("{page}/more"),
        format!("{page}x"),
        format!("/__yuzuno/preview/v/{}", token.to_uppercase()),
        format!("/__yuzuno/preview/v/%{first:02X}{}", &token[1..]),
        format!("/%5F%5Fyuzuno/preview/v/{token}"),
        format!("/%255F%255Fyuzuno/preview/v/{token}"),
        format!("/__yuzuno%2Fpreview%2Fv%2F{token}"),
        format!("/x/../__yuzuno/preview/v/{token}"),
        format!("/./__yuzuno/preview/v/{token}"),
        format!("/__yuzuno/./preview/v/{token}"),
        format!("/__YUZUNO/preview/v/{token}"),
        "/__yuzuno/preview/v/..%2F..%2Fapi%2Fhealth".into(),
        "/__yuzuno".into(),
        "/__yuzuno/".into(),
        "/__yuzuno/preview".into(),
        "/__yuzuno/preview/v/".into(),
        "/__yuzuno/api/health".into(),
    ] {
        for method in ["GET", "HEAD"] {
            let (status, head, body) = raw(phone, method, &path, &as_serve()).await;
            assert_eq!(status, 404, "{method} {path}: {head}{body}");
            assert!(method == "HEAD" || body.contains("(Yuzuno preview)"), "{path}: {body}");
            assert!(!body.contains("button") && !body.contains(SHELL) && has(&head, "X-Frame-Options", "DENY"), "{method} {path}: {head}{body}");
        }
    }
    // A path the reserved one is not part of is Yuzuno's page, as always.
    assert!(raw(phone, "GET", "/__yuzunox/page", &as_serve()).await.2.contains(SHELL));

    // The proof: once, by POST from the phone page itself (its exact Origin and client header); never by GET.
    let proof = after_origin(&minted["proof"]["url"]);
    let answer = minted["proof"]["answer"].as_str().unwrap();
    assert_eq!(raw(phone, "GET", &proof, &format!("{}Origin: {origin}\r\n", as_serve())).await.0, 405, "never by GET");
    for (headers, what) in [
        (format!("{}Origin: null\r\nX-Yuzuno-Client: desktop\r\n", as_serve()), "Origin null"),
        (format!("{}Origin: https://{DNS}:8445\r\nX-Yuzuno-Client: desktop\r\n", as_serve()), "another origin"),
        (format!("{}Origin: http://localhost:4317\r\nX-Yuzuno-Client: desktop\r\n", as_serve()), "Core's own port"),
        (format!("{}X-Yuzuno-Client: desktop\r\n", as_serve()), "no Origin"),
        (format!("{}Origin: {origin}\r\n", as_serve()), "no client header"),
        (format!("{}Origin: {origin}\r\nOrigin: {origin}\r\nX-Yuzuno-Client: desktop\r\n", as_serve()), "the Origin twice"),
    ] {
        assert_eq!(raw(phone, "POST", &proof, &headers).await.0, 403, "{what}");
    }
    // Asking to change protocol is refused before the proof is looked at: it stays unused.
    let (status, _, body) = raw(phone, "POST", &proof, &format!("{}Upgrade: websocket\r\n", from_page())).await;
    assert_eq!(status, 400, "{body}");
    assert!(body.contains("never another protocol"), "{body}");
    let (status, head, body) = raw(phone, "POST", &proof, &from_page()).await;
    assert_eq!((status, body.as_str()), (200, answer), "{head}");
    assert!(!named(&head, "Access-Control-Allow-Origin") && has(&head, "X-Frame-Options", "DENY"), "{head}");
    assert_eq!(raw(phone, "POST", &proof, &from_page()).await.0, 404, "answered once");

    // The page asks through the phone entry as what it is: another origin cannot choose for it.
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let chosen = client.post(format!("http://127.0.0.1:{phone}/api/previews")).header("host", format!("{DNS}:8444"))
        .header("tailscale-user-login", OWNER).header("origin", "http://localhost:4317").header("x-yuzuno-client", "desktop")
        .json(&json!({"kind": "artifact", "agentId": "a", "path": "proto.html"})).send().await.unwrap();
    assert_eq!(chosen.status().as_u16(), 403);
    // Phone access itself is changed here too (YN-79), while the older way of turning previews on is refused.
    let apply = client.post(format!("http://127.0.0.1:{phone}/api/remote-access/apply")).header("host", format!("{DNS}:8444"))
        .header("tailscale-user-login", OWNER).header("origin", &origin).header("x-yuzuno-client", "desktop")
        .json(&json!({"requestId": "", "enabled": true, "previews": false})).send().await.unwrap();
    assert_eq!(apply.status().as_u16(), 400, "the route's own check, not a missing route: {}", apply.status());
    let preview = client.post(format!("http://127.0.0.1:{phone}/api/remote-access/preview")).header("host", format!("{DNS}:8444"))
        .header("tailscale-user-login", OWNER).header("origin", &origin).header("x-yuzuno-client", "desktop")
        .json(&json!({"requestId": "from-phone", "enabled": true, "previews": false})).send().await.unwrap();
    assert_eq!(preview.status().as_u16(), 400);
    assert!(preview.text().await.unwrap_or_default().contains("phone_previews_moved"));
    assert_eq!(lab.view().await["previews"]["included"], true);
}

#[tokio::test]
async fn previews_go_with_the_choice_and_leaving_them_out_ends_what_a_phone_was_given() {
    let lab = lab("wsl");
    lab.with_page();
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let phone = free_port();
    // Phone access as it was before the choice: no previews.
    let op = lab.apply(json!({"requestId": "on", "enabled": true, "localPort": phone})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    assert_eq!(lab.view().await["previews"], json!({"included": false, "available": false, "legacy": null}));
    let (code, refused) = mint(phone, OWNER).await;
    assert_eq!(code, 400, "{refused}");
    assert!(refused["error"].as_str().unwrap().starts_with("preview_unavailable_remote:"), "{refused}");
    // Included, on the same entry: nothing is asked of Serve.
    let before = lab.calls().len();
    let op = lab.apply(json!({"requestId": "include", "enabled": true, "localPort": phone, "previews": true})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    assert!(lab.calls()[before..].iter().all(|c| !c.starts_with("serve --")), "{:?}", &lab.calls()[before..]);
    let (code, minted) = mint(phone, OWNER).await;
    assert_eq!(code, 200, "{minted}");
    let page = after_origin(&minted["url"]);
    assert_eq!(raw(phone, "GET", &page, &as_serve()).await.0, 200);
    // Left out by an older page: the choice holds, and so does what the same entry gave.
    let op = lab.apply(json!({"requestId": "older-page", "enabled": true, "localPort": phone})).await.unwrap();
    assert_eq!((op["state"].as_str(), lab.view().await["previews"]["included"].as_bool()), (Some("succeeded"), Some(true)), "{op}");
    assert_eq!(raw(phone, "GET", &page, &as_serve()).await.0, 200);
    // Left out: refused at once, and what a phone was given is gone.
    let op = lab.apply(json!({"requestId": "exclude", "enabled": true, "localPort": phone, "previews": false})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    let (status, _, body) = raw(phone, "GET", &page, &as_serve()).await;
    assert_eq!(status, 403, "{body}");
    assert!(body.contains("does not include previews"), "{body}");
    assert_eq!(mint(phone, OWNER).await.0, 400);
    assert_eq!(lab.view().await["previews"], json!({"included": false, "available": false, "legacy": null}));
    // Included again: what was given before stays gone.
    lab.apply(json!({"requestId": "include-again", "enabled": true, "localPort": phone, "previews": true})).await.unwrap();
    assert_eq!(raw(phone, "GET", &page, &as_serve()).await.0, 404, "revoked");
    let (_, again) = mint(phone, OWNER).await;
    let again = after_origin(&again["url"]);
    assert_eq!(raw(phone, "GET", &again, &as_serve()).await.0, 200);
    // Phone access off keeps the choice, and ends what was given; on again, the choice applies.
    let off = lab.apply(json!({"requestId": "off", "enabled": false})).await.unwrap();
    assert_eq!(off["state"], "succeeded", "{off}");
    let view = lab.view().await;
    assert_eq!((view["saved"]["previews"].clone(), view["previews"].clone()), (json!(true), json!({"included": true, "available": false, "legacy": null})), "{view}");
    let on = lab.apply(json!({"requestId": "on-again", "enabled": true, "localPort": phone})).await.unwrap();
    assert_eq!(on["state"], "succeeded", "{on}");
    assert_eq!(raw(phone, "GET", &again, &as_serve()).await.0, 404, "phone access off ended it");
    assert_eq!(mint(phone, OWNER).await.0, 200);
    // A new Core on the same data reads the choice as it applies.
    assert_eq!(lab.saved().previews, Some(true));
}

#[tokio::test]
async fn a_phone_entry_served_anew_opens_none_of_what_an_earlier_one_was_given() {
    let lab = lab("wsl");
    lab.with_page();
    let phone = free_port();
    lab.on_with_previews(phone).await;
    let (_, minted) = mint(phone, OWNER).await;
    let page = after_origin(&minted["url"]);
    assert_eq!(raw(phone, "GET", &page, &as_serve()).await.0, 200);
    // Another login, on the same port.
    let op = lab.apply(json!({"requestId": "partner", "enabled": true, "localPort": phone, "login": "partner@github"})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    let partner = format!("Host: {DNS}:8444\r\nTailscale-User-Login: partner@github\r\n");
    assert_eq!(raw(phone, "GET", &page, &as_serve()).await.0, 403, "the old login is refused");
    assert_eq!(raw(phone, "GET", &page, &partner).await.0, 404, "the new login never opens what the old one was given");
    let (code, minted) = mint(phone, "partner@github").await;
    assert_eq!(code, 200, "{minted}");
    let page = after_origin(&minted["url"]);
    // Another local port.
    let other = free_port();
    let op = lab.apply(json!({"requestId": "move", "enabled": true, "localPort": other, "login": "partner@github"})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    assert_eq!(raw(other, "GET", &page, &partner).await.0, 404, "a new port opens nothing from the old one");
    let (_, minted) = mint(other, "partner@github").await;
    let page = after_origin(&minted["url"]);
    assert_eq!(raw(other, "GET", &page, &partner).await.0, 200);
    // Off, then on again just as it was.
    lab.apply(json!({"requestId": "off", "enabled": false})).await.unwrap();
    let op = lab.apply(json!({"requestId": "same-again", "enabled": true, "localPort": other, "login": "partner@github"})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    assert_eq!(raw(other, "GET", &page, &partner).await.0, 404, "off and on again opens nothing from before");
    assert_eq!(mint(other, "partner@github").await.0, 200);
}

#[test]
fn the_choice_is_what_a_change_asks_else_what_was_saved_else_what_applies() {
    let saved = |previews: Option<bool>| Saved { previews, ..Default::default() };
    // No choice of its own yet: an older Core's previews decide; with none, off.
    assert!(!included(&saved(None), false));
    assert!(included(&saved(None), true));
    // A choice of its own always holds.
    assert!(!included(&saved(Some(false)), true));
    assert!(included(&saved(Some(true)), false));
    let request = |previews: Option<bool>| -> ApplyRequest {
        serde_json::from_value(json!({"requestId": "r", "enabled": true, "previews": previews})).unwrap()
    };
    let desired = |previews: Option<bool>| Desired {
        enabled: true, login: OWNER.into(), serve_port: 8444, local_port: 4318, origin: None, previews, saved_at: "now".into(),
    };
    assert!(chosen(&request(Some(true)), Some(&desired(Some(false))), false));
    assert!(!chosen(&request(Some(false)), Some(&desired(Some(true))), true));
    assert!(chosen(&request(None), Some(&desired(Some(true))), false));
    assert!(!chosen(&request(None), Some(&desired(None)), false));
    assert!(chosen(&request(None), None, true));
    // Sent by an older page, a request has none, and is kept as it was sent.
    let older: ApplyRequest = serde_json::from_value(json!({"requestId": "r", "enabled": true})).unwrap();
    assert_eq!(serde_json::to_value(&older).unwrap().get("previews"), None);
}

/// Phone access and an older Core's phone previews as that Core left them:
/// the phone entry on `phone`; previews turned on (`on`), with their own
/// Serve entry on 8445 to `local`, which `serve_8445` says Serve has.
fn older(lab: &Lab, phone: u16, local: u16, on: bool, serve_8445: Option<Value>) {
    let origin = format!("https://{DNS}:8444");
    let dir = &lab.ws.data_dir;
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(FILE), json!({"format": 1,
        "desired": {"enabled": true, "login": OWNER, "servePort": 8444, "localPort": phone, "origin": origin, "savedAt": "2026-10-31T00:00:00Z"},
        "effective": {"listen": {"port": phone, "origin": origin, "login": OWNER}, "servePort": 8444, "appliedAt": "2026-10-31T00:00:00Z"},
        "owned": {"servePort": 8444, "host": DNS, "target": format!("http://127.0.0.1:{phone}")}, "operations": []}).to_string()).unwrap();
    std::fs::write(dir.join("remote-preview.json"), json!({"format": 1,
        "desired": {"enabled": on, "servePort": 8445, "localPort": local, "savedAt": "2026-10-31T00:00:00Z"},
        "effective": {"listen": {"servePort": 8445, "localPort": local}, "appliedAt": "2026-10-31T00:00:00Z"},
        "owned": {"servePort": 8445, "host": DNS, "target": format!("http://127.0.0.1:{local}")},
        "operations": [{"id": "p-1", "requestId": "page-p1", "kind": "apply", "state": "succeeded", "step": "done",
            "startedAt": "2026-10-31T00:00:00Z", "request": {"requestId": "page-p1", "enabled": true, "servePort": null, "localPort": null}}]}).to_string()).unwrap();
    lab.set_fake(|s| {
        s["serve"]["TCP"]["8444"] = json!({"HTTPS": true});
        s["serve"]["Web"][format!("{DNS}:8444")] = json!({"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{phone}")}}});
        if let Some(entry) = serve_8445 {
            s["serve"]["TCP"]["8445"] = json!({"HTTPS": true});
            s["serve"]["Web"][format!("{DNS}:8445")] = entry;
        }
    });
}

/// The Serve entry an older Core set for its phone previews on `local`.
fn theirs(local: u16) -> Option<Value> {
    Some(json!({"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{local}")}}}))
}

#[tokio::test]
async fn an_older_cores_previews_keep_their_choice_never_listen_again_and_their_entry_goes_with_the_next_change() {
    let lab = lab("wsl");
    lab.with_page();
    let (phone, local) = (free_port(), free_port());
    older(&lab, phone, local, true, theirs(local));
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    // Starting changes nothing in Serve, and nothing of theirs listens.
    assert!(lab.calls().is_empty(), "{:?}", lab.calls());
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", local)).await.is_err(), "their listener never starts");
    let legacy = json!({"servePort": 8445, "host": DNS, "target": format!("http://127.0.0.1:{local}")});
    let mut held = legacy.clone();
    held["lastAttempt"] = Value::Null;
    assert_eq!(lab.view().await["previews"], json!({"included": true, "available": true, "legacy": held}));
    // Their choice holds: previews open through the phone entry itself.
    let (code, minted) = mint(phone, OWNER).await;
    assert_eq!(code, 200, "{minted}");
    assert_eq!(raw(phone, "GET", &after_origin(&minted["url"]), &as_serve()).await.0, 200);
    // The next change, once its own entry is verified, removes theirs alone, and keeps their record.
    let op = lab.apply(json!({"requestId": "next", "enabled": true, "localPort": phone})).await.unwrap();
    assert_eq!((op["state"].as_str(), op["legacy"]["state"].as_str()), (Some("succeeded"), Some("removed")), "{op}");
    assert!(op["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().contains("Serve port 8445 was removed")), "{op}");
    let serve = &lab.fake()["serve"];
    assert_eq!(serve["TCP"].as_object().unwrap().keys().collect::<Vec<_>>(), ["443", "8444"], "{serve}");
    assert_eq!(serve["Web"][format!("{DNS}:443")]["Handlers"]["/"]["Proxy"], "http://127.0.0.1:8790", "someone else's entry is untouched");
    assert!(lab.calls().iter().all(|c| !c.contains("reset")), "{:?}", lab.calls());
    let record = lab.legacy_record();
    assert!(record["owned"].is_null(), "{record}");
    assert_eq!((record["desired"]["enabled"].clone(), record["operations"][0]["id"].clone()), (json!(true), json!("p-1")), "the rest is kept: {record}");
    // What their entry was and what became of it stay: never Core's again, never forgotten.
    assert_eq!((record["formerOwned"].clone(), record["disposition"]["state"].clone()), (legacy.clone(), json!("removed")), "{record}");
    let view = lab.view().await["previews"].clone();
    assert_eq!((view["included"].clone(), view["available"].clone(), view["legacy"]["state"].clone(), view["legacy"]["formerOwned"].clone()),
        (json!(true), json!(true), json!("removed"), legacy), "{view}");
    assert_eq!(lab.saved().previews, Some(true), "the choice is phone access's own now");
    // Nothing is left of theirs: the next change asks nothing for it.
    let before = lab.calls().len();
    let op = lab.apply(json!({"requestId": "after", "enabled": true, "localPort": phone})).await.unwrap();
    assert_eq!(op["state"], "succeeded", "{op}");
    assert!(op.get("legacy").is_none(), "{op}");
    assert!(lab.calls()[before..].iter().all(|c| !c.contains("8445")), "{:?}", &lab.calls()[before..]);
}

#[tokio::test]
async fn an_older_cores_previews_turned_off_or_left_out_by_a_choice_stay_off() {
    // Theirs off: previews stay off.
    let lab = lab("wsl");
    lab.with_page();
    let (phone, local) = (free_port(), free_port());
    older(&lab, phone, local, false, theirs(local));
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    assert_eq!(lab.view().await["previews"]["included"], false);
    assert_eq!(mint(phone, OWNER).await.0, 400);
    // A choice of phone access's own holds over theirs.
    let lab = lab_with(|lab| older(lab, free_port(), free_port(), true, None));
    let mut saved = lab.saved();
    saved.previews = Some(false);
    crate::updates::package::atomic_json(&path(&lab.ws), &saved).unwrap();
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    assert_eq!(lab.view().await["previews"]["included"], false);
}

/// A lab `prepare` writes records into before its Core starts.
fn lab_with(prepare: impl FnOnce(&Lab)) -> Lab {
    let lab = lab("wsl");
    lab.with_page();
    prepare(&lab);
    lab
}

#[tokio::test]
async fn an_older_cores_entry_is_removed_only_while_it_is_still_exactly_its_own() {
    // (case, Serve's entry on 8445, a fault, how it ends, whether Serve keeps 8445, whether the record keeps it)
    type Case = (&'static str, fn(u16) -> Option<Value>, Value, &'static str, bool, bool);
    let cases: [Case; 5] = [
        ("absent", |_| None, Value::Null, "absent", false, false),
        ("foreign", |_| Some(json!({"Handlers": {"/": {"Proxy": "http://127.0.0.1:9999"}}})), Value::Null, "foreign", true, false),
        ("another handler", |local| Some(json!({"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{local}")}, "/x": {"Path": "/srv"}}})), Value::Null, "foreign", true, false),
        ("refused", theirs, json!({"failOff": "serve config locked"}), "partial", true, true),
        ("no answer", theirs, json!({"lostOff": true}), "uncertain", false, true),
    ];
    for (case, entry, fault, ends, served, recorded) in cases {
        let (phone, local) = (free_port(), free_port());
        let lab = lab_with(|lab| older(lab, phone, local, true, entry(local)));
        lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
        lab.set_fake(|s| if let Value::Object(fault) = &fault { s.as_object_mut().unwrap().extend(fault.clone()) });
        let before = lab.fake()["serve"]["Web"][format!("{DNS}:8445")].clone();
        let op = lab.apply(json!({"requestId": "next", "enabled": true, "localPort": phone})).await.unwrap();
        // Phone access works however theirs ended, and says so apart; theirs
        // not removed is this change's own end, at its own step.
        let (state, step) = match ends {
            "partial" | "uncertain" => (ends, "cleanup"),
            _ => ("succeeded", "done"),
        };
        assert_eq!((op["state"].as_str(), op["step"].as_str(), op["legacy"]["state"].as_str()), (Some(state), Some(step), Some(ends)), "{case}: {op}");
        if state != "succeeded" {
            assert!(op["error"].as_str().unwrap().starts_with("Phone access is on; "), "{case}: {op}");
        }
        assert_eq!(get(phone, "/api/health", Some(OWNER), &format!("{DNS}:8444")).await.0, 200, "{case}");
        let now = lab.fake()["serve"]["Web"][format!("{DNS}:8445")].clone();
        assert_eq!(!now.is_null(), served, "{case}: {now}");
        if served {
            assert_eq!(now, before, "{case}: left as it is");
        }
        let record = lab.legacy_record();
        let view = lab.view().await["previews"]["legacy"].clone();
        let theirs = json!({"servePort": 8445, "host": DNS, "target": format!("http://127.0.0.1:{local}")});
        if recorded {
            // Still held for them, with why this change could not remove it.
            assert_eq!((record["owned"].clone(), record["lastAttempt"]["state"].clone()), (theirs.clone(), json!(ends)), "{case}: {record}");
            assert_eq!((view["servePort"].as_u64(), view["lastAttempt"]["state"].as_str()), (Some(8445), Some(ends)), "{case}: {view}");
        } else {
            // No longer held, never forgotten: what it was, and what became of it.
            assert!(record["owned"].is_null(), "{case}: {record}");
            assert_eq!((record["formerOwned"].clone(), record["disposition"]["state"].clone()), (theirs.clone(), json!(ends)), "{case}: {record}");
            assert_eq!((view["state"].as_str(), view["formerOwned"].clone()), (Some(ends), theirs.clone()), "{case}: {view}");
        }
        if recorded {
            // The next change looks again, with nothing in the way: then it is gone.
            lab.set_fake(|s| {
                s["failOff"] = Value::Null;
                s["lostOff"] = Value::Null;
            });
            let op = lab.apply(json!({"requestId": "again", "enabled": true, "localPort": phone})).await.unwrap();
            let want = if case == "no answer" { "absent" } else { "removed" };
            assert_eq!((op["state"].as_str(), op["legacy"]["state"].as_str()), (Some("succeeded"), Some(want)), "{case}: {op}");
            let record = lab.legacy_record();
            assert!(record["owned"].is_null(), "{case}");
            assert_eq!((record["formerOwned"].clone(), record["disposition"]["state"].clone()), (theirs, json!(want)), "{case}: {record}");
            assert!(lab.fake()["serve"]["Web"][format!("{DNS}:8445")].is_null(), "{case}");
        }
        assert!(lab.calls().iter().all(|c| !c.contains("reset")), "{case}: {:?}", lab.calls());
    }
}

#[tokio::test]
async fn an_older_cores_entry_goes_with_phone_access_turned_off_and_an_unreadable_record_is_kept() {
    let (phone, local) = (free_port(), free_port());
    let lab = lab_with(|lab| older(lab, phone, local, true, theirs(local)));
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let off = lab.apply(json!({"requestId": "off", "enabled": false})).await.unwrap();
    assert_eq!((off["state"].as_str(), off["legacy"]["state"].as_str()), (Some("succeeded"), Some("removed")), "{off}");
    let serve = &lab.fake()["serve"];
    assert!(serve["TCP"].get("8444").is_none() && serve["TCP"].get("8445").is_none(), "{serve}");
    assert!(serve["Web"][format!("{DNS}:443")].is_object());
    // Unreadable: phone access goes on, and the record is kept as it is.
    let (phone, local) = (free_port(), free_port());
    let lab = lab_with(|lab| {
        older(lab, phone, local, true, theirs(local));
        std::fs::write(lab.ws.data_dir.join("remote-preview.json"), "{not json").unwrap();
    });
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    assert!(lab.view().await["previews"]["legacy"]["error"].as_str().unwrap().contains("not a readable phone previews record"));
    let op = lab.apply(json!({"requestId": "next", "enabled": true, "localPort": phone})).await.unwrap();
    assert_eq!((op["state"].as_str(), op["step"].as_str(), op["legacy"]["state"].as_str()), (Some("partial"), Some("cleanup"), Some("partial")), "{op}");
    assert_eq!(std::fs::read_to_string(lab.ws.data_dir.join("remote-preview.json")).unwrap(), "{not json");
    assert!(lab.fake()["serve"]["Web"][format!("{DNS}:8445")].is_object(), "nothing removed it cannot read as its own");
    assert_eq!(get(phone, "/api/health", Some(OWNER), &format!("{DNS}:8444")).await.0, 200);
}

#[tokio::test]
async fn phone_access_takes_neither_port_of_an_older_cores_previews_entry_until_it_is_gone() {
    let (phone, local) = (free_port(), free_port());
    let lab = lab_with(|lab| older(lab, phone, local, true, theirs(local)));
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let serve = lab.fake()["serve"].clone();
    let before = lab.calls().len();
    // Their very mapping, their Serve port, their local port: each refused before anything changes.
    for (id, request, said) in [
        ("theirs", json!({"servePort": 8445, "localPort": local}), "Serve port 8445 is still the older phone previews' own entry".to_owned()),
        ("serve", json!({"servePort": 8445, "localPort": phone}), "Serve port 8445 is still the older phone previews' own entry".to_owned()),
        ("local", json!({"localPort": local}), format!("Port {local} is still where the older phone previews' own Serve entry points")),
    ] {
        let mut request = request;
        request["requestId"] = json!(id);
        request["enabled"] = json!(true);
        let op = lab.apply(request).await.unwrap();
        assert_eq!((op["state"].as_str(), op["step"].as_str()), (Some("failed"), Some("validate")), "{id}: {op}");
        assert!(op["error"].as_str().unwrap().contains(&said) && op["error"].as_str().unwrap().ends_with("nothing was changed"), "{id}: {op}");
    }
    assert!(lab.calls()[before..].iter().all(|c| !c.starts_with("serve --")), "{:?}", &lab.calls()[before..]);
    assert_eq!(lab.fake()["serve"], serve, "Serve unchanged: the phone entry and theirs");
    assert_eq!(get(phone, "/api/health", Some(OWNER), &format!("{DNS}:8444")).await.0, 200, "the phone entry works on");
    assert!(!lab.legacy_record()["owned"].is_null(), "theirs is still theirs to remove");
    // Once a change has removed theirs, both ports are phone access's.
    let off = lab.apply(json!({"requestId": "off", "enabled": false})).await.unwrap();
    assert_eq!((off["state"].as_str(), off["legacy"]["state"].as_str()), (Some("succeeded"), Some("removed")), "{off}");
    let on = lab.apply(json!({"requestId": "now", "enabled": true, "servePort": 8445, "localPort": local})).await.unwrap();
    assert_eq!((on["state"].as_str(), on.get("legacy")), (Some("succeeded"), None), "{on}");
    assert_eq!(lab.fake()["serve"]["Web"][format!("{DNS}:8445")], json!({"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{local}")}}}));
    assert_eq!(get(local, "/api/health", Some(OWNER), &format!("{DNS}:8445")).await.0, 200, "phone access on what were their ports");
}

#[tokio::test]
async fn an_older_cores_entry_on_phone_access_s_own_serve_port_is_never_removed_for_them() {
    // Records that already meet there (from before phone access was kept off their ports): phone access holds 8445.
    let (local, theirs_local) = (free_port(), free_port());
    let lab = lab_with(|lab| {
        older(lab, free_port(), theirs_local, true, None);
        let mut saved = lab.saved();
        saved.owned = Some(Owned { serve_port: 8445, host: DNS.into(), target: format!("http://127.0.0.1:{local}") });
        crate::updates::package::atomic_json(&path(&lab.ws), &saved).unwrap();
    });
    lab.set_fake(|s| {
        s["serve"]["TCP"]["8445"] = json!({"HTTPS": true});
        s["serve"]["Web"][format!("{DNS}:8445")] = json!({"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{theirs_local}")}}});
    });
    let mut record = lab.legacy_record();
    record["owned"]["target"] = json!(format!("http://127.0.0.1:{theirs_local}"));
    std::fs::write(lab.ws.data_dir.join("remote-preview.json"), record.to_string()).unwrap();
    let before = lab.fake()["serve"].clone();
    let said = preview::clear(&lab.ws, &lab.ws.remote_access.host(false), Some(8445)).await.unwrap();
    assert_eq!(said["state"], "foreign", "{said}");
    assert!(said["detail"].as_str().unwrap().contains("Phone access serves on Serve port 8445 now; nothing of the older phone previews there was removed"), "{said}");
    assert_eq!(lab.fake()["serve"], before, "nothing removed");
    assert!(lab.calls().iter().all(|c| !c.starts_with("serve --")), "{:?}", lab.calls());
    let record = lab.legacy_record();
    assert!(record["owned"].is_null(), "theirs no more: {record}");
    assert_eq!((record["formerOwned"]["servePort"].as_u64(), record["disposition"]["state"].as_str()), (Some(8445), Some("foreign")), "never Core's, never forgotten: {record}");
}

#[tokio::test]
async fn an_older_cores_record_it_cannot_read_keeps_phone_access_on_its_own_ports_until_it_can() {
    use std::os::unix::fs::PermissionsExt;
    // Not JSON; JSON not as Core writes it (not an object, no format or another, no `owned`, an entry not
    // as Core writes it); no access to it at all. None reads as no record.
    for case in ["not JSON", "null", "a list", "a string", "an empty object", "another format", "no owned", "an entry not as Core writes it", "no access"] {
        let (phone, local) = (free_port(), free_port());
        let file = |lab: &Lab| lab.ws.data_dir.join("remote-preview.json");
        let lab = lab_with(|lab| {
            older(lab, phone, local, true, theirs(local));
            let mut record = lab.legacy_record();
            let write = |text: String| std::fs::write(file(lab), text).unwrap();
            match case {
                "not JSON" => write("{not json".into()),
                "null" => write("null".into()),
                "a list" => write("[]".into()),
                "a string" => write("\"remote-preview\"".into()),
                "an empty object" => write("{}".into()),
                "another format" => {
                    record["format"] = json!(2);
                    write(record.to_string());
                }
                "no owned" => {
                    record.as_object_mut().unwrap().remove("owned");
                    write(record.to_string());
                }
                "an entry not as Core writes it" => {
                    record["owned"] = json!({"servePort": "8445", "target": 4319});
                    write(record.to_string());
                }
                _ => std::fs::set_permissions(file(lab), std::fs::Permissions::from_mode(0o000)).unwrap(),
            }
        });
        lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
        assert!(lab.view().await["previews"]["legacy"]["error"].is_string(), "{case}: shown as unknown, never as none");
        let serve = lab.fake()["serve"].clone();
        // Another local port, or another Serve port (theirs among them): refused, nothing changed.
        for (id, request) in [("local", json!({"localPort": free_port()})), ("serve", json!({"servePort": 8445, "localPort": phone}))] {
            let mut request = request;
            request["requestId"] = json!(format!("{id}-{case}"));
            request["enabled"] = json!(true);
            let op = lab.apply(request).await.unwrap();
            assert_eq!((op["state"].as_str(), op["step"].as_str()), (Some("failed"), Some("validate")), "{case} {id}: {op}");
            let error = op["error"].as_str().unwrap();
            assert!(error.contains("cannot be read") && error.contains("remote-preview.json") && error.ends_with("nothing was changed"), "{case} {id}: {op}");
        }
        assert_eq!(lab.fake()["serve"], serve, "{case}: Serve unchanged");
        assert_eq!(get(phone, "/api/health", Some(OWNER), &format!("{DNS}:8444")).await.0, 200, "{case}: the phone entry works on");
        // Its own ports, as it serves now: applied, and the change says theirs is not done.
        let op = lab.apply(json!({"requestId": format!("same-{case}"), "enabled": true, "localPort": phone})).await.unwrap();
        assert_eq!((op["state"].as_str(), op["step"].as_str(), op["legacy"]["state"].as_str()), (Some("partial"), Some("cleanup"), Some("partial")), "{case}: {op}");
        assert_eq!(lab.fake()["serve"]["Web"][format!("{DNS}:8445")], serve["Web"][format!("{DNS}:8445")], "{case}: nothing of theirs removed");
        if case == "no access" {
            std::fs::set_permissions(file(&lab), std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}

#[tokio::test]
async fn an_older_page_turning_previews_on_by_themselves_is_refused_and_changes_nothing() {
    use axum::response::IntoResponse;
    let lab = lab("wsl");
    lab.start(startup(&lab.ws.data_dir, None).bind().await.unwrap());
    let error = previews_moved().await.unwrap_err().into_response();
    assert_eq!(error.status().as_u16(), 400);
    let body = axum::body::to_bytes(error.into_body(), 4096).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("phone_previews_moved"), "{body:?}");
    assert!(!path(&lab.ws).exists() && lab.calls().is_empty());
}
