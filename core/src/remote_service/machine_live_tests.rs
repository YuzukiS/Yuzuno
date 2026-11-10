//! `GET /api/machine-live` through Core's routers (YN-83 S1 PR4b): only a
//! GET from Yuzuno's page records an interest or starts a session, on the
//! local and the phone entry alike; nothing else does, `/api/machine-load`
//! included. OpenSSH is a stand-in that records each call. One test goes
//! through a real sshd on 127.0.0.1 with its own keys and configuration
//! (jobs::ssh_mux_tests): the API brings the machine online, the session
//! closes clean once the interest ends, and the next interest runs the
//! installed program again without uploading it. No registered machine,
//! none of the user's SSH files, and no daily Core are used.

use super::package;
use super::registry::Timing;
use crate::jobs::ssh_mux_tests::Sshd;
use crate::remote::RemoteMachine;
use crate::{server, workspace::Workspace};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::Value;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

const ORIGIN: &str = "https://core.example-tailnet.ts.net:8444";
const HOST: &str = "core.example-tailnet.ts.net:8444";
const LOGIN: &str = "person@example.com";

struct Lab {
    dir: tempfile::TempDir,
    ws: Arc<Workspace>,
}

impl Lab {
    /// A Workspace with one machine, `target`, its data root a private
    /// folder of this test's own.
    fn new(target: &str) -> Lab {
        Lab::with_id("m1", target)
    }

    fn with_id(id: &str, target: &str) -> Lab {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-codex".into()).unwrap();
        ws.store
            .add_machine(&RemoteMachine {
                id: id.into(),
                name: "Lab box".into(),
                target: target.into(),
                codex: "codex".into(),
                default_cwd: "/srv/synthetic/work".into(),
                data_root: Some(root.to_string_lossy().into_owned()),
                ..Default::default()
            })
            .unwrap();
        Lab { dir, ws }
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.dir.path().join(name)
    }

    /// An OpenSSH that records the call and cannot connect (a backoff).
    fn unreachable_ssh(&self) -> String {
        let path = self.path("ssh-down");
        let calls = self.path("calls");
        std::fs::write(&path, format!("#!/bin/sh\necho call >> '{}'\necho 'ssh: connect to host box-a port 22: Connection refused' >&2\nexit 255\n", calls.display())).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// An OpenSSH that records the call and refuses the login.
    fn refusing_ssh(&self) -> String {
        let path = self.path("ssh");
        let calls = self.path("calls");
        std::fs::write(&path, format!("#!/bin/sh\necho call >> '{}'\necho 'tester@box-a: Permission denied (publickey).' >&2\nexit 255\n", calls.display())).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn calls(&self) -> usize {
        std::fs::read_to_string(self.path("calls")).unwrap_or_default().lines().count()
    }

    fn program(&self) -> std::path::PathBuf {
        self.path("root").join("remote").join("bin").join(format!("{}.py", package::digest()))
    }
}

/// A request as the page sends it on Core's port (`phone`: through the
/// phone entry's proxy), with `client` as its X-Yuzuno-Client headers.
async fn call(app: &Router, method: &str, uri: &str, phone: bool, client: &[&str]) -> (StatusCode, String) {
    let mut builder = Request::builder().method(method).uri(uri);
    builder = if phone {
        builder.header("host", HOST).header("tailscale-user-login", LOGIN).header("origin", ORIGIN)
    } else {
        builder.header("host", "127.0.0.1:4317")
    };
    for value in client {
        builder = builder.header("x-yuzuno-client", *value);
    }
    let response = app.clone().oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// A change from the page: `body` as JSON.
async fn send(app: &Router, method: &str, uri: &str, body: Value) -> (StatusCode, String) {
    let request = Request::builder().method(method).uri(uri).header("host", "127.0.0.1:4317")
        .header("x-yuzuno-client", "desktop").header("content-type", "application/json")
        .body(Body::from(body.to_string())).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn first(answer: &str) -> Value {
    let answer: Value = serde_json::from_str(answer).unwrap();
    answer["machines"][0].clone()
}

async fn eventually(what: &str, within: Duration, done: impl Fn() -> bool) {
    let until = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < until, "never: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_a_get_from_the_page_records_an_interest_or_starts_a_session() {
    let lab = Lab::new("box-a");
    lab.ws.machine_live.configure(&lab.refusing_ssh(), Timing::PRODUCTION);
    let local = server::router(lab.ws.clone(), lab.ws.data_dir.join("assets"));
    let phone = server::remote_router(lab.ws.clone(), lab.ws.data_dir.join("assets"), None, server::RemoteEntry::new(ORIGIN, LOGIN).unwrap());
    // No client header, another one, or two: refused, on either entry.
    let refused: [&[&str]; 3] = [&[], &["web"], &["desktop", "desktop"]];
    for client in refused {
        for app in [&local, &phone] {
            let (status, _) = call(app, "GET", "/api/machine-live", std::ptr::eq(app, &phone), client).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{client:?}");
        }
    }
    // HEAD, which axum would answer with the GET, and every other method.
    for method in ["HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"] {
        let (status, body) = call(&local, method, "/api/machine-live", false, &["desktop"]).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{method}: {body}");
    }
    // The Core host's own load is read as before, and starts nothing.
    let (status, _) = call(&local, "GET", "/api/machine-load", false, &["desktop"]).await;
    assert_eq!(status, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!((lab.calls(), lab.ws.machine_live.interest()), (0, None));
    assert_eq!(lab.ws.machine_live.peek()["machines"], serde_json::json!([]));
    // From the page, on the phone entry: the interest, and one start.
    let (status, answer) = call(&phone, "GET", "/api/machine-live", true, &["desktop"]).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert!(lab.ws.machine_live.interest().is_some());
    eventually("one call", Duration::from_secs(10), || lab.calls() == 1).await;
    // Refused there, it stops: further GETs start nothing.
    let folder = lab.dir.path().to_string_lossy().into_owned();
    let mut row = Value::Null;
    for _ in 0..50 {
        let (status, answer) = call(&local, "GET", "/api/machine-live", false, &["desktop"]).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        // Nothing of how Core reaches it, nor what OpenSSH said.
        for hidden in ["box-a", "tester", "Permission denied", folder.as_str(), "/srv/synthetic"] {
            assert!(!answer.contains(hidden), "{hidden} in {answer}");
        }
        row = first(&answer);
        if row["state"] == "unavailable" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!((row["id"].as_str(), row["state"].as_str(), row["code"].as_str()), (Some("m1"), Some("unavailable"), Some("ssh_auth")), "{row}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(lab.calls(), 1);
}

/// The manual check as the Machines page runs it (machines::check), its
/// probe answered by a stand-in for this test's own machine id
/// (remote::STAND_INS): a failed one leaves the stop, one that reaches the
/// machine as it is ends it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_check_that_reaches_the_machine_ends_its_stop_and_a_failed_one_does_not() {
    const ID: &str = "yn83-pr4b-check-box";
    let lab = Lab::with_id(ID, "box-a");
    lab.ws.machine_live.configure(&lab.refusing_ssh(), Timing::PRODUCTION);
    let app = server::router(lab.ws.clone(), lab.ws.data_dir.join("assets"));
    let reaches = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let answers = reaches.clone();
    crate::remote::STAND_INS.lock().unwrap().push((ID.into(), crate::remote::StandIn {
        answer: Arc::new(move |request: &Value| {
            anyhow::ensure!(request["action"] == "probe", "only a probe is expected: {request}");
            anyhow::ensure!(answers.load(std::sync::atomic::Ordering::SeqCst), "ssh: connect to host box-a port 22: Connection refused");
            Ok(serde_json::json!({"hostname": "box-a", "platform": "Linux", "home": "/home/tester"}))
        }),
        program: String::new(),
    }));
    let state = || async {
        let (status, answer) = call(&app, "GET", "/api/machine-live", false, &["desktop"]).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        let row = first(&answer);
        (row["state"].as_str().unwrap_or_default().to_owned(), row["code"].as_str().unwrap_or_default().to_owned())
    };
    let mut seen = state().await;
    let until = Instant::now() + Duration::from_secs(10);
    while seen.0 != "unavailable" && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(50)).await;
        seen = state().await;
    }
    assert_eq!(seen, ("unavailable".into(), "ssh_auth".into()));
    // A check that does not reach it: still stopped, nothing started.
    let failed = crate::machines::check(&lab.ws, ID).await.unwrap();
    assert!(!failed.reachable, "{failed:?}");
    assert_eq!(state().await, ("unavailable".into(), "ssh_auth".into()));
    assert_eq!(lab.calls(), 1);
    // One that does, of the machine as it is: the next GET starts it again.
    reaches.store(true, std::sync::atomic::Ordering::SeqCst);
    let reached = crate::machines::check(&lab.ws, ID).await.unwrap();
    assert!(reached.reachable, "{reached:?}");
    // Started again (it may already have been refused again by the time the
    // answer is made): OpenSSH is called a second time.
    let again = state().await.0;
    assert!(matches!(again.as_str(), "connecting" | "unavailable"), "{again}");
    eventually("a second call", Duration::from_secs(10), || lab.calls() == 2).await;
    crate::remote::STAND_INS.lock().unwrap().retain(|(id, _)| id != ID);
}

/// Core's shutdown watch says true (as Ctrl+C, SIGTERM or an update's Stop
/// sends it) while its other steps have not run: neither a GET nor the end
/// of a backoff starts OpenSSH again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn once_core_shuts_down_neither_a_get_nor_a_backoff_starts_ssh() {
    let lab = Lab::new("box-a");
    lab.ws.machine_live.configure(&lab.unreachable_ssh(), Timing::PRODUCTION);
    let (shutdown, watched) = tokio::sync::watch::channel(false);
    lab.ws.follow_core_shutdown(watched);
    let app = server::router(lab.ws.clone(), lab.ws.data_dir.join("assets"));
    let (status, answer) = call(&app, "GET", "/api/machine-live", false, &["desktop"]).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    eventually("one call", Duration::from_secs(10), || lab.calls() == 1).await;
    let peek = || lab.ws.machine_live.peek()["machines"][0].clone();
    eventually("a backoff", Duration::from_secs(10), || peek()["code"] == "ssh_unreachable").await;
    shutdown.send_replace(true);
    let (status, answer) = call(&app, "GET", "/api/machine-live", false, &["desktop"]).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    // The backoff (1 s) ends well within the interest: nothing starts.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(lab.calls(), 1);
}

/// The probe answers for this test's own machine id: true or false, in
/// turn, from `reaches` (remote::STAND_INS).
fn probe_answers(id: &str, reaches: Vec<bool>) {
    let answers = std::sync::Mutex::new(reaches.into_iter());
    crate::remote::STAND_INS.lock().unwrap().push((id.into(), crate::remote::StandIn {
        answer: Arc::new(move |request: &Value| {
            anyhow::ensure!(request["action"] == "probe", "only a probe is expected: {request}");
            let reaches = answers.lock().unwrap().next().unwrap_or(false);
            anyhow::ensure!(reaches, "ssh: connect to host box-a port 22: Connection refused");
            Ok(serde_json::json!({"hostname": "box-a", "platform": "Linux", "home": "/home/tester"}))
        }),
        program: String::new(),
    }));
}

/// A machine `id` whose session stopped (the stand-in refuses the login),
/// through the page's router.
async fn stopped(id: &str) -> (Lab, Router) {
    let lab = Lab::with_id(id, "box-a");
    lab.ws.machine_live.configure(&lab.refusing_ssh(), Timing::PRODUCTION);
    let app = server::router(lab.ws.clone(), lab.ws.data_dir.join("assets"));
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let (_, answer) = call(&app, "GET", "/api/machine-live", false, &["desktop"]).await;
        if first(&answer)["state"] == "unavailable" {
            return (lab, app);
        }
        assert!(Instant::now() < until, "{answer}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The next check of `id` stops right after its result is stored.
fn pause_after_record(id: &str) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Semaphore>) {
    let (stopped, go) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Semaphore::new(0)));
    crate::machines::AFTER_RECORD.lock().unwrap().push((id.into(), stopped.clone(), go.clone()));
    (stopped, go)
}

/// From a check's stored result to what it does here (ending a stop), no
/// edit of the machine comes between: an edit of `contained` sent then
/// commits only after.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_never_commits_between_a_checks_stored_result_and_its_effect() {
    const ID: &str = "yn83-pr4b-edit-box";
    let (lab, app) = stopped(ID).await;
    probe_answers(ID, vec![true]);
    let (paused, go) = pause_after_record(ID);
    let check = tokio::spawn({ let ws = lab.ws.clone(); async move { crate::machines::check(&ws, ID).await } });
    tokio::time::timeout(Duration::from_secs(10), paused.notified()).await.expect("the check stored its result");
    let edit = tokio::spawn({
        let app = app.clone();
        async move {
            send(&app, "PUT", &format!("/api/machines/{ID}"), serde_json::json!({
                "name": "Lab box", "target": "box-a", "codex": "codex", "defaultCwd": "/srv/synthetic/work", "contained": true,
            })).await
        }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let early = edit.is_finished();
    go.add_permits(1);
    let checked = check.await.unwrap().unwrap();
    let (status, answer) = edit.await.unwrap();
    assert!(!early, "the edit committed between the check's stored result and its effect");
    assert!(checked.reachable && status == StatusCode::OK, "{checked:?} {answer}");
    // The check ended the stop while it described the machine; the edit
    // then dropped it as the record changed.
    let checks = lab.ws.store.machine_checks().unwrap();
    assert!(!checks.contains_key(ID), "{checks:?}");
    let (_, answer) = call(&app, "GET", "/api/machine-live", false, &["desktop"]).await;
    eventually("started again", Duration::from_secs(10), || lab.calls() == 2).await;
    assert!(matches!(first(&answer)["state"].as_str(), Some("connecting" | "unavailable")), "{answer}");
    crate::remote::STAND_INS.lock().unwrap().retain(|(id, _)| id != ID);
}

/// Nor does a check that started later: it is stored only after the first
/// check's effect, so what the first one acts on is what is stored then.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_later_check_is_never_stored_between_a_checks_stored_result_and_its_effect() {
    const ID: &str = "yn83-pr4b-newer-box";
    let (lab, _app) = stopped(ID).await;
    probe_answers(ID, vec![true, false]);
    let (paused, go) = pause_after_record(ID);
    let first_check = tokio::spawn({ let ws = lab.ws.clone(); async move { crate::machines::check(&ws, ID).await } });
    tokio::time::timeout(Duration::from_secs(10), paused.notified()).await.expect("the check stored its result");
    let later = tokio::spawn({ let ws = lab.ws.clone(); async move { crate::machines::check(&ws, ID).await } });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let early = later.is_finished();
    go.add_permits(1);
    let reached = first_check.await.unwrap().unwrap();
    let failed = later.await.unwrap().unwrap();
    assert!(!early, "a later check was stored between a check's stored result and its effect");
    assert!(reached.reachable && !failed.reachable, "{reached:?} {failed:?}");
    // The later one is what is stored now, as the latest started.
    assert_eq!(lab.ws.store.machine_checks().unwrap()[ID], failed);
    crate::remote::STAND_INS.lock().unwrap().retain(|(id, _)| id != ID);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_a_real_sshd_the_api_brings_a_machine_online_closes_it_without_interest_and_reuses_the_program() {
    let sshd = Sshd::start();
    let lab = Lab::new("box-b");
    // The interest held 3 s instead of 60 s; everything else as in production.
    let interest = Duration::from_secs(3);
    lab.ws.machine_live.configure(&sshd.wrapper, Timing { interest, ..Timing::PRODUCTION });
    let app = server::router(lab.ws.clone(), lab.ws.data_dir.join("assets"));
    let online = || async {
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            let (status, answer) = call(&app, "GET", "/api/machine-live", false, &["desktop"]).await;
            assert_eq!(status, StatusCode::OK, "{answer}");
            let row = first(&answer);
            if row["state"] == "online" {
                return row;
            }
            assert!(row["state"] == "connecting" && Instant::now() < until, "{row}");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    let row = online().await;
    assert_eq!((row["platform"].as_str(), row["code"].clone()), (Some("Linux"), Value::Null), "{row}");
    let installed = std::fs::metadata(lab.program()).unwrap();
    assert_eq!(installed.permissions().mode() & 0o777, 0o600);
    // No more GETs: the interest ends, and the session closes, proven clean.
    let peek = || lab.ws.machine_live.peek()["machines"][0].clone();
    eventually("idle", interest + Duration::from_secs(20), || peek()["state"] == "idle").await;
    assert_eq!(sshd.connections(), 1);
    // The next interest runs the installed program again: not uploaded anew.
    online().await;
    assert_eq!(sshd.connections(), 2);
    let again = std::fs::metadata(lab.program()).unwrap();
    assert_eq!((again.ino(), again.mtime(), again.mtime_nsec()), (installed.ino(), installed.mtime(), installed.mtime_nsec()));
    // Core's shutdown closes it, within its budget, its child reaped.
    let started = Instant::now();
    assert_eq!(lab.ws.close_remote_sessions().await, 0);
    assert!(started.elapsed() < Timing::PRODUCTION.closing(), "{:?}", started.elapsed());
    assert_eq!(peek()["state"], "idle");
}
