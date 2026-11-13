//! Runs Windows' own `wsl.exe` for the connection page (YN-107 design 4.1),
//! Windows only: `%SystemRoot%\System32\wsl.exe`, never one found on PATH,
//! without a window, with WSL's own messages in UTF-8. Everything that
//! comes from the user, a list or a check is one argument of its own; no
//! Windows shell is involved, and scripts go to WSL on stdin, never in an
//! argument.
//!
//! What runs in WSL through it (design section 7, item 5): the list of
//! distributions, the read-only check, and a saved installation's start
//! entry (`start`, moved here from main.rs).

use crate::connection::{self, StartOutcome, StartProfile};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc::{self, RecvTimeoutError},
    time::{Duration, Instant},
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How long listing may take (design 4.2).
pub const LIST_WAIT: Duration = Duration::from_secs(10);

/// How long the check may take: the first `wsl.exe` call may boot the
/// distribution (design 4.3).
pub const CHECK_WAIT: Duration = Duration::from_secs(90);

/// How long the connection page waits for a start in WSL. The start itself
/// waits up to two minutes for Core to answer; booting WSL comes first.
const START_WAIT: Duration = Duration::from_secs(180);

/// Windows' own wsl.exe, if WSL is installed.
pub fn exe() -> Option<PathBuf> {
    let wsl = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join(r"System32\wsl.exe");
    wsl.is_file().then_some(wsl)
}

fn command(wsl: &PathBuf, arguments: &[&str]) -> Command {
    let mut command = Command::new(wsl);
    command
        .args(arguments)
        // wsl.exe's own messages in UTF-8 rather than UTF-16.
        .env("WSL_UTF8", "1")
        .creation_flags(CREATE_NO_WINDOW);
    command
}

/// What `wsl.exe` printed and how it ended.
pub struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub enum Failure {
    /// There is no `System32\wsl.exe`.
    NoWsl,
    /// It could not be run, or did not end within its time.
    Run(String),
}

/// Reads a pipe to its end, keeping the first `limit` bytes; the rest is
/// read and dropped, so the program never waits on a full pipe.
fn drain(pipe: Option<impl Read + Send + 'static>, limit: u64) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.by_ref().take(limit).read_to_end(&mut kept);
            let _ = std::io::copy(&mut pipe, &mut std::io::sink());
        }
        kept
    })
}

/// Runs `wsl.exe` with `arguments`, writes `input` to it and closes its
/// input, and keeps at most `limit` bytes of each output. After `wait` it
/// is stopped (only `wsl.exe` itself: what it started in WSL is bounded by
/// its own time limits) and that is a failure.
pub fn run(arguments: &[&str], input: &'static [u8], wait: Duration, limit: u64) -> Result<Output, Failure> {
    let wsl = exe().ok_or(Failure::NoWsl)?;
    let mut child = command(&wsl, arguments)
        .stdin(if input.is_empty() { Stdio::null() } else { Stdio::piped() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Failure::Run(format!("Could not run WSL: {error}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        // Its own thread: WSL may read the input only as the script goes on.
        std::thread::spawn(move || {
            let _ = stdin.write_all(input);
        });
    }
    let stdout = drain(child.stdout.take(), limit);
    let stderr = drain(child.stderr.take(), 64 * 1024);
    let deadline = Instant::now() + wait;
    // Ended, and its output read to the end; both within the time.
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) if stdout.is_finished() && stderr.is_finished() => break status,
            Ok(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::Run(format!(
                    "WSL gave no answer within {} seconds.",
                    wait.as_secs()
                )));
            }
            Err(error) => return Err(Failure::Run(format!("Could not wait for WSL: {error}"))),
        }
    };
    Ok(Output {
        success: status.success(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// `wsl.exe --list --verbose`.
pub fn list() -> Result<Output, Failure> {
    run(&["--list", "--verbose"], b"", LIST_WAIT, 64 * 1024)
}

/// The read-only check in `distro` (a name from the list that passed
/// `check_rules::distro_name_ok`), as its default account (no `--user`):
/// `check.sh` on stdin, its default install and data folders.
pub fn check(distro: &str, script: &'static str) -> Result<Output, Failure> {
    run(
        &["--distribution", distro, "--exec", "/bin/sh", "-s", "--", "default", "default"],
        script.as_bytes(),
        CHECK_WAIT,
        256 * 1024,
    )
}

/// Runs the installation's start entry in its WSL distribution and reads
/// its result as soon as it is printed. After starting Core the entry stays
/// while Core runs, so WSL keeps the distribution running: that `wsl.exe`
/// is left running, hidden, and outlives this window. Waiting ends after
/// [`START_WAIT`]; nothing is stopped then.
pub fn start(profile: &StartProfile) -> StartOutcome {
    let Some(wsl) = exe() else {
        return StartOutcome::Failed("WSL is not installed on this computer, so Core cannot be started from here.".into());
    };
    let arguments = profile.wsl_arguments();
    let child = command(&wsl, &arguments.iter().map(String::as_str).collect::<Vec<_>>())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => return StartOutcome::Failed(format!("Could not run WSL: {error}")),
    };
    fn read_all(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(64 * 1024).read_to_end(&mut bytes);
            }
            bytes
        })
    }
    let stderr = read_all(child.stderr.take());
    let (lines, arriving) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut stdout = BufReader::new(stdout.take(64 * 1024));
            let mut line = Vec::new();
            while matches!(stdout.read_until(b'\n', &mut line), Ok(read) if read > 0) {
                if lines.send(String::from_utf8_lossy(&line).into_owned()).is_err() {
                    break;
                }
                line.clear();
            }
        });
    }
    let deadline = Instant::now() + START_WAIT;
    let mut output = String::new();
    loop {
        match arriving.recv_timeout(Duration::from_millis(200)) {
            Ok(line) if connection::start_result_line(&line).is_some() => {
                return connection::start_result(profile, &line);
            }
            Ok(line) => output.push_str(&line),
            // wsl.exe ended without a result: what it said is why.
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= deadline {
            return StartOutcome::Unanswered;
        }
    }
    // Its output has closed; give it and its error stream a moment to end,
    // never more.
    let ending = Instant::now() + Duration::from_secs(5);
    while (matches!(child.try_wait(), Ok(None)) || !stderr.is_finished()) && Instant::now() < ending {
        std::thread::sleep(Duration::from_millis(100));
    }
    if stderr.is_finished() {
        output.push('\n');
        output.push_str(&String::from_utf8_lossy(&stderr.join().unwrap_or_default()));
    }
    connection::start_result(profile, &output)
}
