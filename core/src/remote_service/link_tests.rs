//! Core's side of one remote session (YN-83 S1 PR4a; design v4 A2, A3, A8).
//!
//! OpenSSH is a stand-in script that drops ssh's options and runs the remote
//! command here: the real boot step and program, or link_fake.py, which
//! breaks the protocol one way at a time. HOME and the identity files are set
//! only in the stand-in's own environment. One test goes through a real sshd
//! on 127.0.0.1 with its own keys and configuration (jobs::ssh_mux_tests).
//! No registered machine and none of the user's SSH files are used.

use super::link::{drain_stderr, write_frames, Ended, LineReader, Limits, Link, Options, Phase, Read, Snapshot, Terminal, WriteEnd, FRAME_LIMIT};
use super::package;
use super::protocol::{After, Code, Exit, Platform, Space, Stderr};
use crate::jobs::ssh_mux_tests::Sshd;
use crate::remote::{shell_quote, RemoteMachine};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

const WAIT: Duration = Duration::from_secs(30);
const FAKE: &str = include_str!("link_fake.py");
/// Skip ssh's options and the destination; $1 is then the remote command.
const ARGS: &str = "while [ $# -gt 0 ]; do case \"$1\" in -T) shift;; -o) shift 2;; *) break;; esac; done\nshift\n";
const NOISE: &str = r#"import json, sys
size = int(sys.argv[1])
line = "Welcome to box-a. (base) conda activated\n"
sys.stdout.write(line * (size // len(line) + 1))
sys.stdout.write("YUZUNO-REMOTE " + "f" * 32 + ' {"ready":true}\n')
sys.stdout.write(json.dumps({"ev": "hello", "data": {}}) + "\n")
sys.stdout.flush()
"#;

fn quick() -> Limits {
    Limits {
        handshake: Duration::from_secs(20),
        write: Duration::from_millis(800),
        ping: Duration::from_millis(100),
        silence: Duration::from_millis(1500),
        close: Duration::from_secs(5),
        exit_wait: Duration::from_millis(800),
        kill_wait: Duration::from_millis(800),
    }
}

struct Lab {
    dir: tempfile::TempDir,
}

impl Lab {
    fn new() -> Lab {
        let dir = tempfile::tempdir().unwrap();
        let lab = Lab { dir };
        std::fs::create_dir(lab.path("home")).unwrap();
        std::fs::create_dir(lab.path("root")).unwrap();
        std::fs::set_permissions(lab.path("root"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(lab.path("machine-id"), "0123456789abcdef0123456789abcdef\n").unwrap();
        std::fs::write(lab.path("boot-id"), "6f1c2a1e-6c3b-4b39-9a51-2f8f6f8a1d0e\n").unwrap();
        std::fs::write(lab.path("fake.py"), FAKE).unwrap();
        std::fs::write(lab.path("noise.py"), NOISE).unwrap();
        lab
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn at(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }

    fn root(&self) -> String {
        self.path("root").to_string_lossy().into_owned()
    }

    fn machine(&self) -> RemoteMachine {
        RemoteMachine {
            id: "m1".into(),
            name: "lab box".into(),
            target: "box-a".into(),
            codex: "codex".into(),
            default_cwd: "/tmp".into(),
            data_root: Some(self.root()),
            ..Default::default()
        }
    }

    /// A stand-in for OpenSSH that records each call, its arguments and its
    /// remote command, then runs `body` with that command as $1.
    fn ssh(&self, name: &str, body: &str) -> String {
        let lab = self.at();
        let script = format!(
            "#!/bin/sh\necho call >> '{lab}/calls'\nprintf '%s\\n' \"$*\" > '{lab}/argv'\n{ARGS}printf '%s' \"$1\" > '{lab}/command'\n\
             export HOME='{lab}/home' YUZUNO_JOBS_MACHINE_ID_FILE='{lab}/machine-id' YUZUNO_JOBS_BOOT_ID_FILE='{lab}/boot-id'\n\
             echo $$ > '{lab}/pid'\n{body}\n"
        );
        let path = self.path(name);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// The real boot step and program, in this process's place (same PID).
    fn real(&self) -> String {
        self.ssh("ssh-real", "exec /bin/sh -c \"exec $1\"")
    }

    fn fake(&self, mode: &str) -> String {
        let lab = self.at();
        self.ssh(&format!("ssh-{mode}"), &format!("exec python3 -I -B '{lab}/fake.py' {mode} '{lab}' {}", package::digest()))
    }

    /// OpenSSH failing by itself: `stderr`, then exit `code`, stdin unread.
    fn failing(&self, name: &str, code: i32, stderr: &str) -> String {
        std::fs::write(self.path(&format!("{name}.err")), stderr).unwrap();
        let lab = self.at();
        self.ssh(name, &format!("cat '{lab}/{name}.err' >&2\nexit {code}"))
    }

    fn calls(&self) -> usize {
        std::fs::read_to_string(self.path("calls")).unwrap_or_default().lines().count()
    }

    fn frames(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path("frames"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn pid(&self) -> u32 {
        std::fs::read_to_string(self.path("pid")).unwrap().trim().parse().unwrap()
    }
}

fn options(ssh: String) -> Options {
    Options { ssh, limits: quick(), ..Default::default() }
}

fn start(lab: &Lab, ssh: String) -> Link {
    Link::start(&lab.machine(), 1, options(ssh)).unwrap()
}

/// The first state that `done` accepts, or the end.
async fn until(link: &Link, done: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let mut state = link.subscribe();
    let found = tokio::time::timeout(WAIT, state.wait_for(|now| done(now) || now.terminal.is_some()))
        .await
        .expect("a state in time")
        .expect("the link's state")
        .clone();
    found
}

async fn online(link: &Link) -> Snapshot {
    let now = until(link, |now| now.phase == Phase::Online).await;
    assert_eq!(now.phase, Phase::Online, "{:?}", now.terminal);
    now
}

async fn ended(link: &mut Link) -> Arc<Terminal> {
    tokio::time::timeout(WAIT, link.ended()).await.expect("the session ended in time")
}

/// Starts, and returns how it ended.
async fn run(lab: &Lab, ssh: String) -> Arc<Terminal> {
    ended(&mut start(lab, ssh)).await
}

fn outcome(end: &Terminal) -> (After, Option<Code>) {
    (end.after, end.code)
}

fn gone(pid: u32) -> bool {
    !std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// The process state letter in /proc/<pid>/stat (Z for a zombie).
fn state_of(pid: u32) -> Option<char> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(") ").and_then(|(_, rest)| rest.chars().next())
}

#[tokio::test]
async fn the_real_boot_uploads_once_goes_online_with_loads_and_closes_clean() {
    let lab = Lab::new();
    let ssh = lab.real();
    for (generation, uploaded) in [(1, true), (2, false)] {
        let mut link = Link::start(&lab.machine(), generation, options(ssh.clone())).unwrap();
        let now = until(&link, |now| now.load.as_ref().is_some_and(|load| load.value.memory.is_some())).await;
        assert_eq!((now.phase, now.generation), (Phase::Online, generation), "{:?}", now.terminal);
        let hello = &now.hello.as_ref().unwrap().value;
        assert_eq!(hello.platform, Platform::Linux);
        assert!(hello.host_id.is_some() && hello.account_key.is_some(), "{hello:?}");
        let load = &now.load.as_ref().unwrap().value;
        assert!(matches!(load.disks[0].space, Space::Known { .. }), "{load:?}");
        link.close();
        let end = ended(&mut link).await;
        assert_eq!((end.generation, end.ended, end.exit, end.uploaded), (generation, Ended::Closed, Exit::Code(0), uploaded));
        assert_eq!(outcome(&end), (After::Clean, None));
        assert!(end.bye.as_ref().is_some_and(|bye| bye.clean) && end.reap.is_reaped());
    }
    assert_eq!(lab.calls(), 2);
    // The program it installed, private, under the root it was given.
    let file = lab.path("root").join("remote").join("bin").join(format!("{}.py", package::digest()));
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    // Its own connection, no forwarding, and only the fixed boot code as the
    // remote command: every value went on stdin.
    let argv = std::fs::read_to_string(lab.path("argv")).unwrap();
    for option in ["BatchMode=yes", "ControlMaster=no", "ControlPath=none", "ClearAllForwardings=yes", "box-a"] {
        assert!(argv.contains(option), "{option}: {argv}");
    }
    let command = std::fs::read_to_string(lab.path("command")).unwrap();
    assert_eq!(command, format!("python3 -c {}", shell_quote(package::BOOT)));
}

#[tokio::test]
async fn one_watch_of_the_root_then_pings_on_their_period() {
    let lab = Lab::new();
    let mut link = start(&lab, lab.fake("online"));
    online(&link).await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    link.close();
    let end = ended(&mut link).await;
    assert_eq!(outcome(&end), (After::Clean, None));
    let frames = lab.frames();
    let first = &frames[0]["first"];
    assert_eq!(first["v"], 1);
    assert_eq!(first["digest"], package::digest());
    assert_eq!(first["root"], lab.root());
    assert!(first["nonce"].as_str().is_some_and(|nonce| nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit())));
    let watches: Vec<&Value> = frames.iter().filter(|frame| frame["op"] == "watch").collect();
    assert_eq!(watches.len(), 1, "{frames:?}");
    assert_eq!(watches[0]["args"], json!({"paths": [{"role": "root", "path": lab.root()}]}));
    let ids: Vec<u64> = frames[1..].iter().filter_map(|frame| frame["id"].as_u64()).collect();
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]), "{ids:?}");
    let pings = frames.iter().filter(|frame| frame["op"] == "ping").count();
    assert!((3..=9).contains(&pings), "{pings} pings in about 700 ms at 100 ms");
    assert_eq!(frames.last().unwrap()["op"], "close");
}

#[tokio::test]
async fn login_noise_and_forged_lines_are_skipped_within_a_budget() {
    let lab = Lab::new();
    let at = lab.at();
    // A banner, a line marked with another nonce and an unmarked hello, then the real boot.
    let noisy = lab.ssh("ssh-noisy", &format!("python3 -I -B '{at}/noise.py' 2048\nexec /bin/sh -c \"exec $1\""));
    let mut link = start(&lab, noisy);
    online(&link).await;
    link.close();
    assert_eq!(outcome(&*ended(&mut link).await), (After::Clean, None));
    // More than 64 KiB of it: protocol.
    let flood = lab.ssh("ssh-loud", &format!("python3 -I -B '{at}/noise.py' 70000\nexec /bin/sh -c \"exec $1\""));
    let end = run(&lab, flood).await;
    assert_eq!((outcome(&end), end.ended), ((After::Stop, Some(Code::Protocol)), Ended::Invalid));
    // Only forged lines and a plain exit: never online, and no backoff.
    let end = run(&lab, lab.fake("forged")).await;
    assert_eq!((outcome(&end), end.exit), ((After::Stop, Some(Code::UncleanExit)), Exit::Code(0)));
}

#[tokio::test]
async fn a_second_need_a_bad_hello_another_version_or_a_frame_after_bye_stops() {
    let lab = Lab::new();
    for (mode, code) in [("need-twice", Code::Protocol), ("bad-hello", Code::Protocol), ("version", Code::Version), ("after-bye", Code::Protocol)] {
        let end = run(&lab, lab.fake(mode)).await;
        assert_eq!((outcome(&end), end.ended), ((After::Stop, Some(code)), Ended::Invalid), "{mode}");
        assert!(end.reap.is_reaped(), "{mode}");
        assert_eq!(end.uploaded, mode == "need-twice", "{mode}");
    }
}

#[tokio::test]
async fn a_line_at_the_limit_passes_and_one_past_it_ends_the_session() {
    let lab = Lab::new();
    let mut link = start(&lab, lab.fake("exact"));
    online(&link).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    link.close();
    assert_eq!(outcome(&*ended(&mut link).await), (After::Clean, None));
    let end = run(&lab, lab.fake("oversize")).await;
    assert_eq!((outcome(&end), end.ended), ((After::Stop, Some(Code::Protocol)), Ended::Invalid));
}

#[tokio::test]
async fn silence_or_bytes_without_a_frame_end_an_online_session_unclean() {
    let lab = Lab::new();
    let started = Instant::now();
    let end = run(&lab, lab.fake("partial")).await;
    assert_eq!((outcome(&end), end.ended), ((After::Stop, Some(Code::UncleanExit)), Ended::Silent));
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    // The real program, frozen after its hello (design v4 PR4 test 5).
    let mut link = start(&lab, lab.real());
    online(&link).await;
    let pid = lab.pid();
    assert!(std::process::Command::new("kill").args(["-STOP", &pid.to_string()]).status().unwrap().success());
    let end = ended(&mut link).await;
    assert_eq!((outcome(&end), end.ended, end.exit), ((After::Stop, Some(Code::UncleanExit)), Ended::Silent, Exit::Signal));
    assert!(end.reap.is_reaped() && gone(pid));
    // Nothing starts it again by itself.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(lab.calls(), 2);
}

#[tokio::test]
async fn only_whole_connect_failures_with_nothing_started_back_off() {
    let lab = Lab::new();
    let refused = "ssh: connect to host box-a port 22: Connection refused\r\n";
    let cases: Vec<(&str, i32, String, (After, Option<Code>))> = vec![
        ("refused", 255, refused.into(), (After::Backoff, Some(Code::SshUnreachable))),
        ("dns", 255, "ssh: Could not resolve hostname box-a: Name or service not known\n".into(), (After::Backoff, Some(Code::SshUnreachable))),
        ("empty", 255, String::new(), (After::Stop, Some(Code::SshFailed))),
        ("mixed", 255, format!("{refused}kex_exchange_identification: read: Connection reset by peer\n"), (After::Stop, Some(Code::SshFailed))),
        ("reset", 255, "kex_exchange_identification: read: Connection reset by peer\n".into(), (After::Stop, Some(Code::SshFailed))),
        ("closed", 255, "Connection closed by 192.0.2.10 port 22\n".into(), (After::Stop, Some(Code::SshFailed))),
        // Past the first 8 KiB: the whitelist cannot be judged, and what follows is not seen.
        ("cut", 255, refused.repeat(400), (After::Stop, Some(Code::SshFailed))),
        ("cut-auth", 255, format!("{}user@box-a: Permission denied (publickey).\n", "#".repeat(8192)), (After::Stop, Some(Code::SshFailed))),
        ("auth", 255, "user@box-a: Permission denied (publickey).\n".into(), (After::Stop, Some(Code::SshAuth))),
        ("hostkey", 255, "Host key verification failed.\n".into(), (After::Stop, Some(Code::SshHostKey))),
        ("python", 127, "sh: 1: python3: not found\n".into(), (After::Stop, Some(Code::NoPython))),
        ("old", 1, "  File \"<string>\", line 4\nSyntaxError: invalid syntax\n".into(), (After::Stop, Some(Code::PythonTooOld))),
        ("xcrun", 1, "xcrun: error: invalid active developer path\n".into(), (After::Stop, Some(Code::PythonStandIn))),
        ("137", 137, String::new(), (After::Stop, Some(Code::UncleanExit))),
    ];
    for (name, code, stderr, expected) in cases {
        let end = run(&lab, lab.failing(name, code, &stderr)).await;
        assert_eq!((outcome(&end), end.exit), (expected, Exit::Code(code)), "{name}");
        assert!(end.reap.is_reaped(), "{name}");
    }
    let signal = lab.ssh("ssh-signal", "kill -9 $$");
    let end = run(&lab, signal).await;
    assert_eq!((outcome(&end), end.exit), ((After::Stop, Some(Code::UncleanExit)), Exit::Signal));
    // ready was seen: a 255 with the whitelist on stderr still stops.
    let end = run(&lab, lab.fake("ready-255")).await;
    assert_eq!((outcome(&end), end.exit), ((After::Stop, Some(Code::SshFailed)), Exit::Code(255)));
    // Each case was one call: nothing tried again.
    assert_eq!(lab.calls(), 16);
}

#[tokio::test]
async fn stderr_is_drained_while_the_session_runs() {
    let lab = Lab::new();
    // 1 MiB on stderr before ready: undrained, it would block the boot.
    let mut link = start(&lab, lab.fake("stderr-flood"));
    online(&link).await;
    link.close();
    assert_eq!(outcome(&*ended(&mut link).await), (After::Clean, None));
}

#[tokio::test]
async fn a_closed_stdin_goes_to_the_exit_and_what_it_said() {
    let lab = Lab::new();
    let end = run(&lab, lab.fake("epipe")).await;
    assert_eq!((outcome(&end), end.ended, end.exit, end.uploaded), ((After::Stop, Some(Code::UploadShort)), Ended::WriteFailed, Exit::Code(3), true));
    assert_eq!(lab.calls(), 1);
}

#[tokio::test]
async fn writes_that_cannot_go_through_end_within_their_limit() {
    let lab = Lab::new();
    let started = Instant::now();
    // The upload, into a one-page stdin that is never read.
    let end = run(&lab, lab.fake("need-no-read")).await;
    assert_eq!((outcome(&end), end.ended, end.exit), ((After::Stop, Some(Code::UncleanExit)), Ended::WriteStalled, Exit::Signal));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    // Pings, online, while frames still come the other way.
    let mut fast = quick();
    fast.ping = Duration::from_millis(2);
    let mut link = Link::start(&lab.machine(), 1, Options { ssh: lab.fake("no-read"), limits: fast, ..Default::default() }).unwrap();
    online(&link).await;
    let end = ended(&mut link).await;
    assert_eq!((outcome(&end), end.ended, end.exit), ((After::Stop, Some(Code::UncleanExit)), Ended::WriteStalled, Exit::Signal));
}

#[tokio::test]
async fn a_close_is_clean_only_with_a_clean_bye_the_end_of_stdout_and_exit_0() {
    let lab = Lab::new();
    for (mode, exit) in [("bye-read-pending", 0), ("bye-child-stuck", 0), ("no-bye", 0), ("exit-1", 1), ("online", 0)] {
        let mut link = start(&lab, lab.fake(mode));
        online(&link).await;
        link.close();
        let end = ended(&mut link).await;
        let expected = if mode == "online" { (After::Clean, None) } else { (After::Stop, Some(Code::UncleanExit)) };
        assert_eq!((outcome(&end), end.ended, end.exit), (expected, Ended::Closed, Exit::Code(exit)), "{mode}");
        assert!(end.reap.is_reaped(), "{mode}");
    }
}

/// After a failed write (EPIPE) the session only reads what is left, and
/// every line is checked as before: anything but one clean bye and the end of
/// stdout is protocol, never clean. The stand-in sends its tail only once the
/// test has seen the session stop writing, so each case is read on that path.
#[tokio::test]
async fn after_a_failed_write_the_rest_is_checked_as_before() {
    let lab = Lab::new();
    let limits = Limits { exit_wait: Duration::from_secs(3), silence: Duration::from_secs(5), ..quick() };
    let modes = ["drain-clean", "drain-invalid", "drain-load", "drain-reply", "drain-two-byes", "drain-partial"];
    let mut seen = Vec::new();
    for mode in modes {
        let _ = std::fs::remove_file(lab.path("go"));
        let mut link = Link::start(&lab.machine(), 1, Options { ssh: lab.fake(mode), limits, ..Default::default() }).unwrap();
        // Online (a hello), then ending once a write failed: only then is the tail sent.
        let ending = until(&link, |now| now.phase == Phase::Closing).await;
        assert!(ending.phase == Phase::Closing && ending.hello.is_some(), "{mode}: {:?}", ending.terminal);
        std::fs::write(lab.path("go"), "").unwrap();
        let end = ended(&mut link).await;
        assert_eq!(end.ended, Ended::WriteFailed, "{mode}");
        assert!(end.reap.is_reaped(), "{mode}");
        seen.push((mode, outcome(&end)));
    }
    let protocol = (After::Stop, Some(Code::Protocol));
    assert_eq!(
        seen,
        vec![
            ("drain-clean", (After::Clean, None)),
            ("drain-invalid", protocol),
            ("drain-load", protocol),
            ("drain-reply", protocol),
            ("drain-two-byes", protocol),
            ("drain-partial", protocol),
        ]
    );
}

/// bye is the last frame: a whole frame after it, or the start of one before
/// stdout ends, is protocol even with exit 0.
#[tokio::test]
async fn output_after_a_clean_bye_is_never_clean() {
    let lab = Lab::new();
    let mut link = start(&lab, lab.fake("bye-partial"));
    online(&link).await;
    link.close();
    let partial = outcome(&*ended(&mut link).await);
    let whole = outcome(&*run(&lab, lab.fake("after-bye")).await);
    let protocol = (After::Stop, Some(Code::Protocol));
    assert_eq!(vec![("bye-partial", partial), ("after-bye", whole)], vec![("bye-partial", protocol), ("after-bye", protocol)]);
}

#[tokio::test]
async fn stdout_closed_while_the_child_lives_is_killed_and_reaped_within_4_s() {
    let lab = Lab::new();
    let limits = Limits { exit_wait: Duration::from_secs(2), kill_wait: Duration::from_secs(2), ..quick() };
    let mut link = Link::start(&lab.machine(), 1, Options { ssh: lab.fake("eof-alive"), limits, ..Default::default() }).unwrap();
    online(&link).await;
    let since = Instant::now();
    let end = ended(&mut link).await;
    assert!(since.elapsed() < Duration::from_millis(4500), "{:?}", since.elapsed());
    assert_eq!((outcome(&end), end.ended, end.exit), ((After::Stop, Some(Code::UncleanExit)), Ended::RemoteEnded, Exit::Signal));
    assert!(end.reap.is_reaped() && gone(lab.pid()));
}

#[tokio::test]
async fn a_child_that_cannot_be_reaped_keeps_its_gate_closed_until_a_real_wait() {
    let lab = Lab::new();
    let (release, hold) = watch::channel(false);
    let options = Options { ssh: lab.fake("eof-alive"), limits: quick(), hold_wait: Some(hold) };
    let mut link = Link::start(&lab.machine(), 1, options).unwrap();
    let gate = link.reap_gate();
    let end = ended(&mut link).await;
    assert_eq!((outcome(&end), end.exit), ((After::Stop, Some(Code::UncleanExit)), Exit::Unknown));
    // Killed, not reaped: a zombie, and the gate stays shut.
    let pid = lab.pid();
    let mut state = state_of(pid);
    for _ in 0..50 {
        if state == Some('Z') {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        state = state_of(pid);
    }
    assert_eq!(state, Some('Z'));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!gate.is_reaped() && !end.reap.is_reaped());
    // A wait that returns opens it.
    release.send_replace(true);
    tokio::time::timeout(Duration::from_secs(5), gate.reaped()).await.expect("reaped once the wait returns");
    assert!(gone(pid));
}

#[test]
fn a_dropped_reaper_never_opens_the_gate() {
    let lab = Lab::new();
    let (_release, hold) = watch::channel(false);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let gate = runtime.block_on(async {
        let options = Options { ssh: lab.fake("eof-alive"), limits: quick(), hold_wait: Some(hold) };
        let mut link = Link::start(&lab.machine(), 1, options).unwrap();
        let end = ended(&mut link).await;
        assert_eq!(end.exit, Exit::Unknown);
        link.reap_gate()
    });
    // The runtime and the reaper go; a dropped child is not a reaped one.
    drop(runtime);
    assert!(!gate.is_reaped());
    let again = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let opened = again.block_on(async { tokio::time::timeout(Duration::from_millis(300), gate.reaped()).await });
    assert!(opened.is_err());
}

#[tokio::test]
async fn a_dropped_link_closes_and_a_close_or_deadline_while_booting_kills() {
    let lab = Lab::new();
    // Online: the bounded close, so the exit is still proven clean.
    let link = start(&lab, lab.fake("online"));
    online(&link).await;
    let gate = link.reap_gate();
    drop(link);
    tokio::time::timeout(Duration::from_secs(10), gate.reaped()).await.expect("reaped after the drop");
    assert_eq!(lab.frames().last().unwrap()["op"], "close");
    // Booting: killed at once.
    let mut link = start(&lab, lab.fake("slow-boot"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let since = Instant::now();
    link.close();
    let end = ended(&mut link).await;
    assert_eq!((outcome(&end), end.ended, end.exit), ((After::Stop, Some(Code::UncleanExit)), Ended::Cancelled, Exit::Signal));
    assert!(since.elapsed() < Duration::from_secs(3) && end.reap.is_reaped());
    // Or at the handshake deadline.
    let limits = Limits { handshake: Duration::from_secs(1), ..quick() };
    let mut link = Link::start(&lab.machine(), 1, Options { ssh: lab.fake("slow-boot"), limits, ..Default::default() }).unwrap();
    let end = ended(&mut link).await;
    assert_eq!((outcome(&end), end.ended), ((After::Stop, Some(Code::UncleanExit)), Ended::HandshakeTimeout));
}

#[tokio::test]
async fn states_carry_their_generation_and_hold_only_the_latest_load() {
    let lab = Lab::new();
    let mut link = Link::start(&lab.machine(), 41, options(lab.fake("flood"))).unwrap();
    // A reader that never reads holds nothing up.
    let _idle = link.subscribe();
    let now = until(&link, |now| now.load.as_ref().is_some_and(|load| load.value.cpu.as_ref().is_some_and(|cpu| cpu.window_ms == 19_999))).await;
    assert_eq!((now.generation, now.phase), (41, Phase::Online), "{:?}", now.terminal);
    let pings = lab.frames().iter().filter(|frame| frame["op"] == "ping").count();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(lab.frames().iter().filter(|frame| frame["op"] == "ping").count() > pings, "pings go on");
    link.close();
    let end = ended(&mut link).await;
    assert_eq!((end.generation, outcome(&end)), (41, (After::Clean, None)));
    assert_eq!(link.generation(), 41);
    // A machine that does not validate starts nothing.
    let mut bad = lab.machine();
    bad.target = "-oProxyCommand=sh".into();
    assert!(Link::start(&bad, 42, options(lab.real())).is_err());
    // OpenSSH that cannot be started: stopped, nothing to reap.
    let mut link = Link::start(&lab.machine(), 43, options(lab.path("absent").to_string_lossy().into_owned())).unwrap();
    let end = ended(&mut link).await;
    assert_eq!((end.generation, outcome(&end), end.ended, end.exit), (43, (After::Stop, Some(Code::SshFailed)), Ended::NotStarted, Exit::NoChild));
    assert!(end.reap.is_reaped());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn over_a_real_sshd_a_session_goes_online_closes_clean_and_starts_again_without_upload() {
    let sshd = Sshd::start();
    let lab = Lab::new();
    let mut machine = lab.machine();
    machine.target = "box-b".into();
    let options = || Options { ssh: sshd.wrapper.clone(), limits: Limits::PRODUCTION, ..Default::default() };
    for (generation, uploaded) in [(1, true), (2, false)] {
        let mut link = Link::start(&machine, generation, options()).unwrap();
        online(&link).await;
        link.close();
        let end = ended(&mut link).await;
        assert_eq!((outcome(&end), end.ended, end.exit, end.uploaded), ((After::Clean, None), Ended::Closed, Exit::Code(0), uploaded));
        assert!(end.reap.is_reaped());
    }
    assert_eq!(sshd.connections(), 2);
    // A closed port: OpenSSH's own connect failure, and nothing ran there.
    machine.target = "box-down".into();
    let mut link = Link::start(&machine, 3, options()).unwrap();
    let end = ended(&mut link).await;
    assert_eq!(outcome(&end), (After::Backoff, Some(Code::SshUnreachable)), "{end:?}");
}

#[tokio::test]
async fn lines_come_whole_from_a_buffer_of_the_limit_plus_one() {
    let (mut tx, rx) = tokio::io::duplex(4096);
    let mut reader = LineReader::new(rx, FRAME_LIMIT);
    assert_eq!(reader.buffer.len(), FRAME_LIMIT + 1);
    let exact = vec![b'a'; FRAME_LIMIT];
    let writing = tokio::spawn(async move {
        tx.write_all(b"one\ntwo\n").await.unwrap();
        tx.write_all(&exact).await.unwrap();
        tx.write_all(b"\npart").await.unwrap();
    });
    let line = |read: Read| match read {
        Read::Line(line, _) => line,
        other => panic!("not a line: {other:?}"),
    };
    assert_eq!(line(reader.next().await), b"one");
    assert_eq!(line(reader.next().await), b"two");
    assert_eq!(line(reader.next().await).len(), FRAME_LIMIT);
    writing.await.unwrap();
    assert!(matches!(reader.next().await, Read::Eof { partial: true }));
    assert_eq!(reader.buffer.len(), FRAME_LIMIT + 1);
    // One byte more than the limit without a newline: oversize.
    let (mut tx, rx) = tokio::io::duplex(4096);
    let mut reader = LineReader::new(rx, FRAME_LIMIT);
    tokio::spawn(async move {
        let _ = tx.write_all(&vec![b'b'; FRAME_LIMIT + 1]).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
    });
    assert!(matches!(reader.next().await, Read::Oversize));
    let (tx, rx) = tokio::io::duplex(64);
    drop(tx);
    assert!(matches!(LineReader::new(rx, FRAME_LIMIT).next().await, Read::Eof { partial: false }));
}

#[tokio::test]
async fn a_write_ends_stalled_after_its_limit_closed_on_epipe_or_done() {
    // The other end is open and never read: stalled, within its limit.
    let (out, _unread) = tokio::io::duplex(64);
    let (frames, queued) = mpsc::channel(4);
    frames.send(vec![b'x'; 1024]).await.unwrap();
    let since = Instant::now();
    assert_eq!(write_frames(out, queued, Duration::from_millis(200)).await, WriteEnd::Stalled);
    assert!(since.elapsed() >= Duration::from_millis(200) && since.elapsed() < Duration::from_secs(2));
    // The other end is gone: EPIPE.
    let (out, gone) = tokio::io::duplex(64);
    drop(gone);
    let (frames, queued) = mpsc::channel(4);
    frames.send(b"{}\n".to_vec()).await.unwrap();
    assert_eq!(write_frames(out, queued, Duration::from_secs(1)).await, WriteEnd::Closed);
    // The queue closes: everything written, then stdin shut.
    let (out, mut peer) = tokio::io::duplex(64);
    let (frames, queued) = mpsc::channel(4);
    frames.send(b"a\n".to_vec()).await.unwrap();
    frames.send(b"b\n".to_vec()).await.unwrap();
    drop(frames);
    assert_eq!(write_frames(out, queued, Duration::from_secs(1)).await, WriteEnd::Done);
    let mut all = Vec::new();
    peer.read_to_end(&mut all).await.unwrap();
    assert_eq!(all, b"a\nb\n");
}

#[tokio::test]
async fn stderr_keeps_its_first_8_kib_and_whether_it_ended() {
    let (mut tx, rx) = tokio::io::duplex(1024);
    let head = Arc::new(Mutex::new(Stderr::default()));
    let draining = tokio::spawn(drain_stderr(rx, head.clone()));
    tx.write_all(&vec![b'e'; 20 * 1024]).await.unwrap();
    drop(tx);
    draining.await.unwrap();
    let kept = head.lock().unwrap().clone();
    assert_eq!((kept.head.len(), kept.truncated, kept.complete), (8192, true, true));
    // Still open: not complete.
    let (mut tx, rx) = tokio::io::duplex(1024);
    let head = Arc::new(Mutex::new(Stderr::default()));
    let draining = tokio::spawn(drain_stderr(rx, head.clone()));
    tx.write_all(b"ssh: connect to host box-a port 22: Connection refused\n").await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    draining.abort();
    let kept = head.lock().unwrap().clone();
    assert_eq!((kept.truncated, kept.complete), (false, false));
    assert!(kept.head.starts_with(b"ssh: connect"));
}
