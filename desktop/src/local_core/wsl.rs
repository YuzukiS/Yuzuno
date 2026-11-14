//! Runs Windows' own `wsl.exe` for the connection page (YN-107 design 4.1),
//! Windows only: `%SystemRoot%\System32\wsl.exe`, never one found on PATH,
//! without a window, with WSL's own messages in UTF-8. Everything that
//! comes from the user, a list or a check is one argument of its own; no
//! Windows shell is involved, and scripts go to WSL on stdin, never in an
//! argument.
//!
//! What runs in WSL through it (design section 7, item 5): the list of
//! distributions, the read-only check, a saved installation's start entry
//! (`start`, moved here from main.rs), and the steps of an installation
//! (`super::Step`): making and removing its temporary folder, unpacking the
//! verified release into it from stdin, installing and the first start.

use crate::connection::{self, StartOutcome, StartProfile};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc,
    },
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
/// A first start waits as long (core/src/updates/setup.rs, `FirstBudget`).
pub const START_WAIT: Duration = Duration::from_secs(180);

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
    /// Its exit code: the command's in WSL, when WSL ran it.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub enum Failure {
    /// There is no `System32\wsl.exe`.
    NoWsl,
    /// It could not be run, or did not end within its time.
    Run(String),
    /// It was stopped because the installation was cancelled.
    Cancelled,
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
    let input = (!input.is_empty()).then(|| Arc::new(input.to_vec()));
    run_with(arguments, input, wait, limit, &|| false, &mut |_| {})
}

/// [`run`], with `input` held in memory and written in pieces, `written`
/// told how much has gone in, and `wsl.exe` stopped as soon as `cancelled`
/// says so (only `wsl.exe`: a program in WSL reading from it then finds its
/// input cut short).
pub fn run_with(
    arguments: &[&str],
    input: Option<Arc<Vec<u8>>>,
    wait: Duration,
    limit: u64,
    cancelled: &dyn Fn() -> bool,
    written: &mut dyn FnMut(u64),
) -> Result<Output, Failure> {
    let wsl = exe().ok_or(Failure::NoWsl)?;
    let mut child = command(&wsl, arguments)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Failure::Run(format!("Could not run WSL: {error}")))?;
    let sent = Arc::new(AtomicU64::new(0));
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        let sent = sent.clone();
        // Its own thread: WSL may read the input only as the script goes on.
        // It ends when everything is written (closing the input) or when WSL
        // stops reading.
        std::thread::spawn(move || {
            for piece in input.chunks(64 * 1024) {
                if stdin.write_all(piece).is_err() {
                    return;
                }
                sent.fetch_add(piece.len() as u64, Ordering::Relaxed);
            }
        });
    }
    let stdout = drain(child.stdout.take(), limit);
    let stderr = drain(child.stderr.take(), 64 * 1024);
    let deadline = Instant::now() + wait;
    let mut told = 0;
    // Ended, and its output read to the end; both within the time.
    let status = loop {
        let now = sent.load(Ordering::Relaxed);
        if now != told {
            told = now;
            written(now);
        }
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::Cancelled);
        }
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
        code: status.code(),
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
/// `check.sh` on stdin, for the install and data folders given (`default`,
/// or paths that passed `check_rules::linux_path_ok`).
pub fn check(distro: &str, script: &'static str, install: &str, data: &str) -> Result<Output, Failure> {
    run(
        &["--distribution", distro, "--exec", "/bin/sh", "-s", "--", install, data],
        script.as_bytes(),
        CHECK_WAIT,
        256 * 1024,
    )
}

/// What a command that prints a one-line JSON result, and may then stay,
/// came to.
pub enum Said {
    /// Its result line, read as soon as it was printed. `wsl.exe` is left
    /// running, hidden, and outlives this window.
    Result(String),
    /// It ended without one: what it printed, then its error output, and
    /// its exit code when it was seen to end.
    Ended(String, Option<i32>),
    /// No result within the wait. Nothing was stopped.
    Unanswered,
}

/// Runs `wsl.exe` with `arguments` and reads its output until `is_result`
/// accepts a line, it ends, or `wait` is over.
pub fn until_result(arguments: &[String], wait: Duration, is_result: impl Fn(&str) -> bool) -> Result<Said, Failure> {
    let wsl = exe().ok_or(Failure::NoWsl)?;
    let mut child = command(&wsl, &arguments.iter().map(String::as_str).collect::<Vec<_>>())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Failure::Run(format!("Could not run WSL: {error}")))?;
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
    let deadline = Instant::now() + wait;
    let mut output = String::new();
    loop {
        match arriving.recv_timeout(Duration::from_millis(200)) {
            Ok(line) if is_result(&line) => return Ok(Said::Result(line)),
            Ok(line) => output.push_str(&line),
            // wsl.exe ended without a result: what it said is why.
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= deadline {
            return Ok(Said::Unanswered);
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
    let code = child.try_wait().ok().flatten().and_then(|status| status.code());
    Ok(Said::Ended(output, code))
}

/// Runs the installation's start entry in its WSL distribution and reads
/// its result as soon as it is printed. After starting Core the entry stays
/// while Core runs, so WSL keeps the distribution running: that `wsl.exe`
/// is left running, hidden, and outlives this window. Waiting ends after
/// [`START_WAIT`]; nothing is stopped then.
pub fn start(profile: &StartProfile) -> StartOutcome {
    match until_result(&profile.wsl_arguments(), START_WAIT, |line| connection::start_result_line(line).is_some()) {
        Ok(Said::Result(line)) => connection::start_result(profile, &line),
        Ok(Said::Ended(output, _)) => connection::start_result(profile, &output),
        Ok(Said::Unanswered) => StartOutcome::Unanswered,
        Err(Failure::NoWsl) => {
            StartOutcome::Failed("WSL is not installed on this computer, so Core cannot be started from here.".into())
        }
        Err(Failure::Run(message)) => StartOutcome::Failed(message),
        Err(Failure::Cancelled) => StartOutcome::Failed("The start was cancelled.".into()),
    }
}
