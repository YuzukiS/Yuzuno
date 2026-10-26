//! Stopping a running Core with a signal (T-88): SIGINT, as Ctrl+C sends, and
//! SIGTERM, as `kill` and service managers send, both take Core's own
//! shutdown. The built `yuzuno-workspace` runs as a process of its own, with a
//! new Workspace folder, a free loopback port, an environment of its own and
//! the stand-in `opencode serve` (tests/fixtures/opencode_server.py, run by
//! /usr/bin/python3) as its one Agent's OpenCode. The signal goes only to that
//! process. No OpenCode, Codex, account, model or network service is used.
#![cfg(target_os = "linux")]

#[allow(unused_imports)]
use yuzuno_workspace::store::whole::WholeRecord;
use rustix::process::{kill_process, Pid, Signal};
use serde_json::{json, Value};
use std::{
    os::unix::{fs::PermissionsExt, process::{CommandExt, ExitStatusExt}},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use yuzuno_workspace::{model::AgentDetail, store::Store};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/opencode_server.py");
const ID: &str = "oc";

fn agent(cwd: &Path) -> AgentDetail {
    serde_json::from_value(json!({"agent": {
        "id":ID, "name":"OpenCode", "cwd":cwd, "model":"", "color":"sage", "harness":"opencode",
        "threadId":null, "status":"offline", "createdAt":"", "updatedAt":"",
        "unreadCount":0, "pendingCount":0, "lastSeq":0, "reviewedSeq":0
    },"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

/// No such process, or a zombie its parent has yet to reap.
fn ended(pid: u64) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
    }
}

async fn ends(pid: u64, within: Duration) -> bool {
    let until = Instant::now() + within;
    while Instant::now() < until {
        if ended(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    ended(pid)
}

/// What a test started and must not leave running, whatever it found: Core
/// if it is still running, the stand-in's processes if Core left them, and
/// the unrelated process. Each is signalled only while its command line is
/// still the one this test started there.
struct Leftovers {
    core: Option<Child>,
    unrelated: Option<Child>,
    fixture: Vec<u64>,
}

impl Drop for Leftovers {
    fn drop(&mut self) {
        for child in [self.core.as_mut(), self.unrelated.as_mut()].into_iter().flatten() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        for &pid in &self.fixture {
            let ours = std::fs::read(format!("/proc/{pid}/cmdline"))
                .is_ok_and(|line| line.windows(5).any(|w| w == b"sleep") || line.windows(FIXTURE.len()).any(|w| w == FIXTURE.as_bytes()));
            if ours && !ended(pid) {
                let _ = kill_process(Pid::from_raw(pid as i32).unwrap(), Signal::KILL);
            }
        }
    }
}

/// What a stop looked like, compared whole so that a failure shows all of it.
#[derive(Debug, PartialEq)]
struct Stop {
    /// How the process ended: `exit 0`, another code, or the signal that ended it.
    ended: String,
    /// How the open event stream ended: `ended` when Core closed it.
    events: String,
    /// `POST /global/dispose` the stand-in OpenCode received.
    disposed: usize,
    /// The process the stand-in's tool ran, in a session of its own, which
    /// only `/global/dispose` ends.
    tool_ended: bool,
    /// A process this test started that has nothing to do with Core.
    unrelated_running: bool,
    /// The Workspace opens again with the Agent and the project made while
    /// Core ran.
    reopened: Result<(), String>,
}

async fn stop_with(signal: Signal) -> Stop {
    let dir = tempfile::tempdir().unwrap();
    let (data, work, home, web) = (dir.path().join("data"), dir.path().join("work"), dir.path().join("home"), dir.path().join("web"));
    for folder in [&data, &work, &home, &web] {
        std::fs::create_dir_all(folder).unwrap();
    }
    let program = dir.path().join("opencode");
    std::fs::write(&program, format!("#!/bin/sh\nexec /usr/bin/python3 {FIXTURE} \"$@\"\n")).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    // The stand-in starts a tool process that only /global/dispose ends.
    let root = data.join("opencode").join(ID);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("tool"), "1").unwrap();
    Store::open(&data.join("workspace.sqlite")).unwrap().insert(&agent(&work)).unwrap();

    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let log = dir.path().join("core.log");
    let core = Command::new(env!("CARGO_BIN_EXE_yuzuno-workspace"))
        .args(["--port", &port.to_string(), "--codex"])
        .arg(dir.path().join("no-codex"))
        .arg("--data-dir").arg(&data)
        .arg("--cwd").arg(&work)
        .arg("--web-dir").arg(&web)
        .current_dir(&work)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home)
        .env("LANG", "C.UTF-8")
        .env("YUZUNO_OPENCODE_BIN", &program)
        .stdin(Stdio::null())
        .stdout(std::fs::File::create(&log).unwrap())
        .stderr(std::fs::File::create(dir.path().join("core.err")).unwrap())
        .spawn()
        .unwrap();
    let unrelated = Command::new("sleep").arg("600").process_group(0).stdin(Stdio::null()).spawn().unwrap();
    let mut left = Leftovers { core: Some(core), unrelated: Some(unrelated), fixture: vec![] };
    let core_log = |dir: &Path| format!("{}{}",
        std::fs::read_to_string(dir.join("core.log")).unwrap_or_default(),
        std::fs::read_to_string(dir.join("core.err")).unwrap_or_default());

    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let ready = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(response) = client.get(format!("{base}/api/health")).send().await {
            if response.status().is_success() {
                break;
            }
        }
        assert!(left.core.as_mut().unwrap().try_wait().unwrap().is_none(), "Core exited before it answered:\n{}", core_log(dir.path()));
        assert!(Instant::now() < ready, "Core did not answer:\n{}", core_log(dir.path()));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let post = |path: &str, body: Value| client.post(format!("{base}{path}"))
        .header("x-yuzuno-client", "desktop").json(&body).send();
    let reconnected: Value = post(&format!("/api/agents/{ID}/reconnect"), json!({})).await.unwrap().json().await.unwrap();
    assert_eq!(reconnected["agent"]["connectionState"], "connected", "{reconnected}\n{}", core_log(dir.path()));
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(root.join("start.json")).unwrap()).unwrap();
    let pid = |key: &str| seen[key].as_u64().unwrap();
    left.fixture = vec![pid("pid"), pid("child"), pid("tool")];
    let created = post("/api/projects", json!({"name":"Made while Core ran"})).await.unwrap();
    let made = created.status();
    let text = created.text().await.unwrap();
    assert!(made.is_success(), "{text}");
    let mut stream = client.get(format!("{base}/api/events")).send().await.unwrap();
    assert!(stream.status().is_success());
    let events = tokio::spawn(async move {
        loop {
            match stream.chunk().await {
                Ok(Some(_)) => continue,
                Ok(None) => return "ended".to_owned(),
                Err(error) => return format!("broke: {error}"),
            }
        }
    });

    let core_pid = Pid::from_raw(left.core.as_ref().unwrap().id() as i32).unwrap();
    kill_process(core_pid, signal).unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(status) = left.core.as_mut().unwrap().try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "Core did not stop:\n{}", core_log(dir.path()));
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let ended_as = match (status.code(), status.signal()) {
        (Some(code), _) => format!("exit {code}"),
        (None, Some(number)) => format!("signal {number}"),
        _ => format!("{status:?}"),
    };
    let events = tokio::time::timeout(Duration::from_secs(10), events).await
        .map_or_else(|_| "still open".to_owned(), Result::unwrap);
    let disposed = std::fs::read_to_string(root.join("calls.jsonl")).unwrap_or_default().lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|call| call["method"] == "POST" && call["path"] == "/global/dispose").count();
    let tool_ended = ends(pid("tool"), Duration::from_secs(5)).await;
    let unrelated_running = left.unrelated.as_mut().unwrap().try_wait().unwrap().is_none();
    let reopened = (|| -> anyhow::Result<()> {
        let store = Store::open(&data.join("workspace.sqlite"))?;
        anyhow::ensure!(store.detail(ID)?.agent.harness == "opencode", "the Agent changed");
        anyhow::ensure!(store.projects()?.iter().any(|p| p.name == "Made while Core ran"), "the project is gone");
        Ok(())
    })().map_err(|error| format!("{error:#}"));
    let stop = Stop { ended: ended_as, events, disposed, tool_ended, unrelated_running, reopened };
    if stop != expected() {
        eprintln!("Core's output:\n{}", core_log(dir.path()));
    }
    stop
}

fn expected() -> Stop {
    Stop {
        ended: "exit 0".into(),
        events: "ended".into(),
        disposed: 1,
        tool_ended: true,
        unrelated_running: true,
        reopened: Ok(()),
    }
}

/// SIGTERM: Core shuts down as it does on Ctrl+C. It closes the event stream,
/// asks its OpenCode to end what its tools run, and exits normally, with its
/// records kept; a process that is not its own runs on.
#[tokio::test]
async fn sigterm_stops_core_through_its_own_shutdown() {
    assert_eq!(stop_with(Signal::TERM).await, expected());
}

/// SIGINT (Ctrl+C) keeps doing the same.
#[tokio::test]
async fn sigint_stops_core_through_its_own_shutdown() {
    assert_eq!(stop_with(Signal::INT).await, expected());
}
