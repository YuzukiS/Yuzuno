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
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-codex".into()).unwrap();
        ws.store
            .add_machine(&RemoteMachine {
                id: "m1".into(),
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
