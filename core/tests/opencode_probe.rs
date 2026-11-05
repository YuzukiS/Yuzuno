//! A lab probe of a real OpenCode 2.x (T-32 slice 2, Lead 4669), ignored
//! unless asked for: `YUZUNO_OPENCODE_PROBE` names the executable, and whoever
//! runs it gives OpenCode private XDG folders (data, state, config, cache) in
//! the environment, with HOME as it is. It starts, checks and stops OpenCode
//! through Core's own path, on loopback, with no session, no prompt and no
//! provider.
#![cfg(target_os = "linux")]

use std::{path::PathBuf, time::{Duration, Instant}};
use yuzuno_workspace::opencode::{supported, Launch, Server, TEARDOWN};

fn ended(pid: u64) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
    }
}

#[tokio::test]
#[ignore = "needs a real OpenCode 2.x, named by YUZUNO_OPENCODE_PROBE"]
async fn a_real_opencode_2x_starts_answers_only_its_password_and_ends_within_its_teardown() {
    let program = PathBuf::from(std::env::var_os("YUZUNO_OPENCODE_PROBE").expect("YUZUNO_OPENCODE_PROBE names the executable"));
    let dir = tempfile::tempdir().unwrap();
    let (directory, root) = (dir.path().join("work"), dir.path().join("db"));
    std::fs::create_dir(&directory).unwrap();
    std::fs::create_dir(&root).unwrap();
    let launch = Launch::new(program, directory, &root, dir.path().join("cache"));
    let started = Instant::now();
    let server = Server::start(&launch).await.unwrap();
    println!("probe: listening and ready after {:?}; /api/info says version {}", started.elapsed(), server.version());
    assert!(supported(server.version()), "{}", server.version());

    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let info = format!("{}/api/info", server.base());
    assert_eq!(http.get(&info).send().await.unwrap().status(), 401, "no password: refused");
    assert_eq!(http.get(&info).basic_auth("opencode", Some("guess")).send().await.unwrap().status(), 401, "another password: refused");
    println!("probe: /api/info without the password, and with another one: 401");

    let pid = u64::from(server.pid().unwrap());
    let stopping = Instant::now();
    server.shutdown().await.unwrap();
    let took = stopping.elapsed();
    println!("probe: shutdown took {took:?}");
    assert!(took < TEARDOWN + Duration::from_secs(1), "shutdown took {took:?}");
    assert!(ended(pid), "OpenCode ended and was reaped");
    let made: Vec<String> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    println!("probe: its database folder holds {made:?}");
    assert!(launch.database.exists(), "its database is where Core put it (OPENCODE_DB)");
}
