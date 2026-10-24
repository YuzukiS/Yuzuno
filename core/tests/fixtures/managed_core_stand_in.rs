//! A stand-in for an installed Core, for `updates::start`'s tests (T-170).
//! The tests compile it with `rustc` and copy it to a release's
//! `bin/yuzuno-workspace`, so that, as for Core, that path is the process's
//! own executable. Like Core it listens on `--port` (and on
//! `YUZUNO_REMOTE_PORT` when set), records how it started in
//! `<install-dir>/updates/launch.json` before it answers, and answers
//! `/api/health`. A copy at another name (standing in for the release's
//! helper) records nothing. It notes each start in `<data-dir>/started`. Files in
//! `--data-dir` change it: `exit-early` (it exits before listening),
//! `ignore-interrupt` (it ignores SIGINT), `release-id` (the release its
//! health names, instead of its own).
use std::{
    env, fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
};

extern "C" {
    fn signal(signum: i32, handler: usize) -> usize;
}

const ENVIRONMENT: [&str; 16] = [
    "PATH", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
    "YUZUNO_NODE", "YUZUNO_OPENCODE_BIN", "YUZUNO_EXPERIMENTAL_OPENCODE", "YUZUNO_CLAUDE_RUNTIME_CACHE",
    "YUZUNO_SERVICE_PORTS", "YUZUNO_WINDOWS_JOBS_ROOT", "YUZUNO_REMOTE_PORT", "YUZUNO_REMOTE_ORIGIN", "YUZUNO_REMOTE_LOGIN",
];

fn text(value: &str) -> String {
    let mut quoted = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            c if (c as u32) < 0x20 => quoted.push_str(&format!("\\u{:04x}", c as u32)),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

fn option(arguments: &[String], name: &str) -> String {
    arguments[arguments.iter().position(|argument| argument == name).unwrap() + 1].clone()
}

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let data = PathBuf::from(option(&arguments, "--data-dir"));
    let install = PathBuf::from(option(&arguments, "--install-dir"));
    let port: u16 = option(&arguments, "--port").parse().unwrap();
    let environment: Vec<String> = ENVIRONMENT
        .iter()
        .filter_map(|name| Some(format!("{}:{}", text(name), text(&env::var(name).ok()?))))
        .collect();
    let listed: Vec<String> = arguments.iter().map(|argument| text(argument)).collect();
    let mut notes = fs::OpenOptions::new().create(true).append(true).open(data.join("started")).unwrap();
    writeln!(
        notes,
        "{{\"pid\":{},\"argv\":[{}],\"env\":{{{}}}}}",
        std::process::id(),
        listed.join(","),
        environment.join(",")
    )
    .unwrap();
    if data.join("exit-early").exists() {
        eprintln!("the stand-in exits early");
        std::process::exit(3);
    }
    if data.join("ignore-interrupt").exists() {
        // SIGINT is 2, SIG_IGN is 1.
        unsafe { signal(2, 1) };
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let _remote = env::var("YUZUNO_REMOTE_PORT")
        .ok()
        .map(|remote| TcpListener::bind(("127.0.0.1", remote.parse::<u16>().unwrap())).unwrap());
    let workspace = fs::read_to_string(data.join("workspace-id")).unwrap_or_else(|_| "workspace-1".into());
    let record = format!(
        "{{\"port\":{port},\"dataDir\":{},\"cwd\":{},\"codex\":{},\"workspaceId\":{},\"environment\":{{{}}},\"recordedAt\":\"stand-in\"}}",
        text(&option(&arguments, "--data-dir")),
        text(&option(&arguments, "--cwd")),
        text(&option(&arguments, "--codex")),
        text(workspace.trim()),
        environment.join(",")
    );
    let executable = env::current_exe().unwrap();
    // Only a release's Core records; a copy standing in for its helper does not.
    if executable.file_name().is_some_and(|name| name == "yuzuno-workspace") {
        fs::write(install.join("updates/launch.json"), record).unwrap();
    }
    let own = executable.parent().unwrap().parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        // Read at each request, so a test can change it while this runs.
        let release = fs::read_to_string(data.join("release-id")).unwrap_or_else(|_| own.clone());
        let health = format!(
            "{{\"product\":\"yuzuno\",\"workspaceId\":{},\"apiReady\":true,\"storageReady\":true,\"releaseId\":{}}}",
            text(workspace.trim()),
            text(release.trim())
        );
        let mut request = [0u8; 2048];
        let _ = stream.read(&mut request);
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{health}",
            health.len()
        );
    }
}
