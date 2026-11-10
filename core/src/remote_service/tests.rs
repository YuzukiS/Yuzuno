//! Behaviour of the packaged program and its boot step (YN-83 PR2).
#![cfg(unix)]

use super::package;
use crate::remote::RemoteMachine;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(6);

fn python() -> String {
    std::env::var("YUZUNO_TEST_PYTHON").unwrap_or_else(|_| "python3".into())
}

fn source(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

/// Lines from a child's stdout, read on their own thread so a test can put a
/// deadline on a line that never comes.
struct Lines(Receiver<std::io::Result<Option<String>>>);

impl Lines {
    fn new(stdout: ChildStdout) -> Self {
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = send.send(Ok(None));
                        return;
                    }
                    Ok(_) => {
                        if send.send(Ok(Some(line))).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = send.send(Err(error));
                        return;
                    }
                }
            }
        });
        Lines(receive)
    }

    fn line(&self, wait: Duration) -> Option<String> {
        self.0.recv_timeout(wait).ok().and_then(Result::ok).flatten()
    }

    fn value(&self, wait: Duration) -> Value {
        let line = self.line(wait).expect("a line before the deadline");
        serde_json::from_str(line.trim()).unwrap_or_else(|error| panic!("not JSON: {error}: {line:?}"))
    }
}

fn base_env(command: &mut Command, home: &Path) {
    command.env("HOME", home);
    command.env("YUZUNO_JOBS_MACHINE_ID_FILE", home.join("machine-id"));
    command.env("YUZUNO_JOBS_BOOT_ID_FILE", home.join("boot-id"));
    command.env("YUZUNO_REMOTE_BOOT_DEADLINE", "5");
    command.env("YUZUNO_REMOTE_SILENCE", "2");
    command.env("YUZUNO_REMOTE_WRITE_STALL", "2");
    command.env("YUZUNO_REMOTE_READ_WAIT", "0.3");
    command.env("YUZUNO_REMOTE_CHILD_WAIT", "0.2");
    command.env("YUZUNO_REMOTE_CHILD_TIMEOUT", "1");
    command.env("YUZUNO_REMOTE_BYE_WAIT", "0.3");
}

fn boot(home: &Path) -> Child {
    let mut command = Command::new(python());
    command.args(["-I", "-c", package::BOOT]);
    base_env(&mut command, home);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.spawn().expect("boot runs with python")
}

fn session(root: &Path, digest: &str, home: &Path) -> Child {
    let file = root.join("remote").join("bin").join(format!("{digest}.py"));
    let mut command = Command::new(python());
    command.args(["-I", file.to_str().unwrap(), "session"]);
    base_env(&mut command, home);
    command.env("YUZUNO_REMOTE_ROOT", root);
    command.env("YUZUNO_REMOTE_DIGEST", digest);
    command.env("YUZUNO_JOBS_MACHINE_ID_FILE", home.join("machine-id"));
    command.env("YUZUNO_JOBS_BOOT_ID_FILE", home.join("boot-id"));
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.spawn().expect("session runs with python")
}

fn install(root: &Path) {
    let bin = root.join("remote").join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::set_permissions(root.join("remote"), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let file = bin.join(format!("{}.py", package::digest()));
    std::fs::write(&file, package::bytes()).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn send(stdin: &mut ChildStdin, value: &Value) {
    stdin.write_all(serde_json::to_string(value).unwrap().as_bytes()).unwrap();
    stdin.write_all(b"\n").unwrap();
}

fn send_raw(stdin: &mut ChildStdin, bytes: &[u8]) {
    stdin.write_all(bytes).unwrap();
}

fn marked(line: &str, nonce: &str) -> Value {
    let prefix = format!("YUZUNO-REMOTE {nonce} ");
    let rest = line.strip_prefix(&prefix).unwrap_or_else(|| panic!("not marked for this nonce: {line:?}"));
    serde_json::from_str(rest.trim()).unwrap_or_else(|error| panic!("marked line is not JSON: {error}: {rest:?}"))
}

fn any_marked(line: &str) -> Value {
    let rest = line.strip_prefix("YUZUNO-REMOTE ").unwrap_or_else(|| panic!("not marked: {line:?}"));
    let (_, rest) = rest.split_once(' ').unwrap_or_else(|| panic!("no payload: {line:?}"));
    serde_json::from_str(rest.trim()).unwrap_or_else(|error| panic!("marked line is not JSON: {error}: {rest:?}"))
}

fn finish(mut child: Child, wait: Duration) -> (ExitStatus, String) {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            return (status, stderr);
        }
        if start.elapsed() > wait {
            let _ = child.kill();
            let status = child.wait().unwrap();
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("child did not exit in {wait:?}; status {status:?}; stderr {stderr}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn first_line(nonce: &str, digest: &str, root: &str) -> Value {
    json!({"v":1, "nonce":nonce, "digest":digest, "root":root})
}

#[test]
fn package_is_deterministic_and_under_the_size_budget() {
    let first = package::bytes().to_vec();
    let digest = package::digest().to_owned();
    let size = package::size();
    assert_eq!(first, package::bytes());
    assert_eq!(digest, package::digest());
    assert!(first.starts_with(b"# yuzuno-remote protocol 1\n"));
    assert!(size < 128 * 1024, "program is {size} bytes");
    println!("remote program size: {size} bytes, digest {digest}");
}

#[test]
fn boot_installs_once_with_private_modes_then_reuses_the_file() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let nonce = "0123456789abcdef0123456789abcdef";
    let digest = package::digest();

    let mut child = boot(&home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    send(&mut stdin, &first_line(nonce, digest, "~/data"));
    let need = marked(&lines.line(WAIT).expect("need"), nonce);
    assert_eq!(need, json!({"need":true}));
    send_raw(&mut stdin, format!("{}\n", package::size()).as_bytes());
    send_raw(&mut stdin, package::bytes());
    let ready = marked(&lines.line(WAIT).expect("ready"), nonce);
    assert_eq!(ready, json!({"ready":true}));
    let hello = lines.value(WAIT);
    assert_eq!(hello["ev"], "hello");
    assert_eq!(hello["data"]["protocol"], 1);
    assert_eq!(hello["data"]["version"], digest);
    drop(stdin);
    let (status, stderr) = finish(child, WAIT);
    assert_eq!(status.code(), Some(0), "stderr: {stderr}");

    let root = home.join("data");
    let bin = root.join("remote").join("bin");
    for path in [&root, &root.join("remote"), &bin] {
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{} mode {mode:o}", path.display());
    }
    let file = bin.join(format!("{digest}.py"));
    assert_eq!(std::fs::read(&file).unwrap(), package::bytes());
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);

    let mut second = boot(&home);
    let again = Lines::new(second.stdout.take().unwrap());
    let mut stdin = second.stdin.take().unwrap();
    send(&mut stdin, &first_line(nonce, digest, "~/data"));
    let ready = marked(&again.line(WAIT).expect("ready"), nonce);
    assert_eq!(ready, json!({"ready":true}));
    assert_eq!(again.value(WAIT)["ev"], "hello");
    drop(stdin);
    let (status, stderr) = finish(second, WAIT);
    assert_eq!(status.code(), Some(0), "stderr: {stderr}");
}

#[test]
fn boot_replaces_wrong_and_symlinked_files_without_touching_a_target() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let nonce = "0123456789abcdef0123456789abcdef";
    let digest = package::digest();

    let root = home.join("data");
    let bin = root.join("remote").join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(root.join("remote"), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
    let installed = bin.join(format!("{digest}.py"));
    std::fs::write(&installed, b"wrong").unwrap();
    std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o600)).unwrap();

    let mut child = boot(&home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    send(&mut stdin, &first_line(nonce, digest, "~/data"));
    assert_eq!(marked(&lines.line(WAIT).unwrap(), nonce), json!({"need":true}));
    send_raw(&mut stdin, format!("{}\n", package::size()).as_bytes());
    send_raw(&mut stdin, package::bytes());
    assert_eq!(marked(&lines.line(WAIT).unwrap(), nonce), json!({"ready":true}));
    drop(stdin);
    let (status, _) = finish(child, WAIT);
    assert_eq!(status.code(), Some(0));
    assert_eq!(std::fs::read(&installed).unwrap(), package::bytes());

    // A symlink is replaced as a name; its target stays exactly as it was.
    let target = home.join("target.txt");
    std::fs::write(&target, b"keep me").unwrap();
    let linked = home.join("linked.py");
    std::os::unix::fs::symlink(&target, &linked).unwrap();
    std::fs::remove_file(&installed).unwrap();
    std::os::unix::fs::symlink(&target, &installed).unwrap();
    let mut child = boot(&home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    send(&mut stdin, &first_line(nonce, digest, "~/data"));
    assert_eq!(marked(&lines.line(WAIT).unwrap(), nonce), json!({"need":true}));
    send_raw(&mut stdin, format!("{}\n", package::size()).as_bytes());
    send_raw(&mut stdin, package::bytes());
    assert_eq!(marked(&lines.line(WAIT).unwrap(), nonce), json!({"ready":true}));
    drop(stdin);
    let (status, _) = finish(child, WAIT);
    assert_eq!(status.code(), Some(0));
    assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
    assert!(!std::fs::symlink_metadata(&installed).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read(&installed).unwrap(), package::bytes());
}

#[test]
fn boot_refuses_bad_roots_and_a_hash_mismatch_leaves_no_temporary_file() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let nonce = "0123456789abcdef0123456789abcdef";
    let digest = package::digest();

    std::fs::create_dir(&home.join("open")).unwrap();
    std::fs::set_permissions(home.join("open"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let real = home.join("real");
    std::fs::create_dir(&real).unwrap();
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::symlink(&real, home.join("link")).unwrap();
    for root in ["~/open", "~/link", "~/missing/data"] {
        let mut child = boot(&home);
        let lines = Lines::new(child.stdout.take().unwrap());
        let mut stdin = child.stdin.take().unwrap();
        send(&mut stdin, &first_line(nonce, digest, root));
        let line = lines.line(WAIT).expect("root refusal");
        assert_eq!(marked(&line, nonce)["error"]["code"], "root_unsafe", "{root}");
        drop(stdin);
        let (status, stderr) = finish(child, WAIT);
        assert_eq!(status.code(), Some(3), "{root}: {stderr}");
    }

    let root = home.join("bad");
    let mut child = boot(&home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    send(&mut stdin, &first_line(nonce, digest, "~/bad"));
    assert_eq!(marked(&lines.line(WAIT).unwrap(), nonce), json!({"need":true}));
    send_raw(&mut stdin, b"5\nwrong");
    let line = lines.line(WAIT).expect("mismatch");
    assert_eq!(marked(&line, nonce)["error"]["code"], "upload_mismatch");
    drop(stdin);
    let (status, _) = finish(child, WAIT);
    assert_eq!(status.code(), Some(3));
    let bin = root.join("remote").join("bin");
    let leftovers: Vec<_> = std::fs::read_dir(&bin)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn boot_times_out_on_partial_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let nonce = "0123456789abcdef0123456789abcdef";
    let digest = package::digest();

    // The first line never ends.
    let mut command = Command::new(python());
    command.args(["-I", "-c", package::BOOT]);
    base_env(&mut command, &home);
    command.env("YUZUNO_REMOTE_BOOT_DEADLINE", "0.3");
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    send_raw(&mut stdin, b"{\"v\":1");
    let line = lines.line(Duration::from_secs(3)).expect("first-line timeout");
    assert_eq!(any_marked(&line)["error"]["code"], "bad_request");
    let (status, _) = finish(child, WAIT);
    assert_eq!(status.code(), Some(3));
    drop(stdin);

    // A length line and a payload that stop halfway.
    for (label, partial, code) in [
        ("length", b"10".to_vec(), "bad_request"),
        ("payload", b"100\nshort".to_vec(), "upload_short"),
    ] {
        let mut command = Command::new(python());
        command.args(["-I", "-c", package::BOOT]);
        base_env(&mut command, &home);
        command.env("YUZUNO_REMOTE_BOOT_DEADLINE", "0.3");
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let lines = Lines::new(child.stdout.take().unwrap());
        let mut stdin = child.stdin.take().unwrap();
        send(&mut stdin, &first_line(nonce, digest, "~/timeout"));
        assert_eq!(marked(&lines.line(WAIT).unwrap(), nonce), json!({"need":true}));
        send_raw(&mut stdin, &partial);
        let line = lines.line(Duration::from_secs(3)).unwrap_or_else(|| panic!("{label} timeout"));
        assert_eq!(marked(&line, nonce)["error"]["code"], code, "{label}");
        let (status, _) = finish(child, WAIT);
        assert_eq!(status.code(), Some(3), "{label}");
        let bin = home.join("timeout").join("remote").join("bin");
        if bin.exists() {
            for entry in std::fs::read_dir(&bin).unwrap() {
                assert!(!entry.unwrap().file_name().to_string_lossy().contains(".tmp"));
            }
        }
    }

    // The payload ends early: upload_short, and no temporary file is left.
    let mut command = Command::new(python());
    command.args(["-I", "-c", package::BOOT]);
    base_env(&mut command, &home);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    send(&mut stdin, &first_line(nonce, digest, "~/eof"));
    assert_eq!(marked(&lines.line(WAIT).unwrap(), nonce), json!({"need":true}));
    send_raw(&mut stdin, b"100\nshort");
    drop(stdin);
    let line = lines.line(WAIT).expect("payload EOF");
    assert_eq!(marked(&line, nonce)["error"]["code"], "upload_short");
    let (status, _) = finish(child, WAIT);
    assert_eq!(status.code(), Some(3));
    let bin = home.join("eof").join("remote").join("bin");
    if bin.exists() {
        for entry in std::fs::read_dir(&bin).unwrap() {
            assert!(!entry.unwrap().file_name().to_string_lossy().contains(".tmp"));
        }
    }
}

#[test]
fn boot_times_out_when_the_peer_cannot_read_the_need_line() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let nonce = "0123456789abcdef0123456789abcdef";
    let digest = package::digest();

    let (reader, mut writer) = UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    let mut filler = [0u8; 4096];
    while let Ok(wrote) = writer.write(&mut filler) {
        if wrote == 0 {
            break;
        }
    }
    let file = std::fs::File::from(OwnedFd::from(writer));
    let mut command = Command::new(python());
    command.args(["-I", "-c", package::BOOT]);
    base_env(&mut command, &home);
    command.env("YUZUNO_REMOTE_BOOT_DEADLINE", "0.3");
    command.stdin(Stdio::piped()).stdout(Stdio::from(file)).stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    send(&mut stdin, &first_line(nonce, digest, "~/blocked"));
    let (status, stderr) = finish(child, WAIT);
    assert_eq!(status.code(), Some(3), "stderr: {stderr}");
    drop(stdin);
    drop(reader);
}

#[test]
fn boot_leaves_a_frame_after_the_first_line_for_the_session() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("machine-id"), b"0123456789abcdef0123456789abcdef").unwrap();
    std::fs::write(home.join("boot-id"), b"boot").unwrap();
    let root = home.join("data");
    install(&root);
    let nonce = "0123456789abcdef0123456789abcdef";
    let digest = package::digest();

    let mut child = boot(&home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    let mut first = serde_json::to_vec(&first_line(nonce, digest, "~/data")).unwrap();
    first.extend_from_slice(b"\n{\"id\":7,\"op\":\"ping\"}\n");
    send_raw(&mut stdin, &first);
    assert_eq!(marked(&lines.line(WAIT).unwrap(), nonce), json!({"ready":true}));
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    let reply = lines.value(WAIT);
    assert_eq!(reply["re"], 7);
    assert!(reply["ok"].is_object());
    drop(stdin);
    let (status, _) = finish(child, WAIT);
    assert_eq!(status.code(), Some(0));
}

#[test]
fn session_rejects_bad_frames_and_answers_unknown_operations() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("machine-id"), b"0123456789abcdef0123456789abcdef").unwrap();
    std::fs::write(home.join("boot-id"), b"boot").unwrap();
    let root = home.join("data");
    install(&root);

    // Invalid JSON.
    let mut child = session(&root, package::digest(), &home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    send_raw(&mut stdin, b"not json\n");
    let bye = lines.value(WAIT);
    assert_eq!(bye["data"]["code"], 4);
    assert_eq!(finish(child, WAIT).0.code(), Some(4));

    // An incomplete frame over the limit.
    let mut child = session(&root, package::digest(), &home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    let mut huge = vec![b'a'; 300 * 1024];
    huge.push(b'\n');
    send_raw(&mut stdin, &huge);
    let bye = lines.value(WAIT);
    assert_eq!(bye["data"]["code"], 4);
    assert_eq!(finish(child, WAIT).0.code(), Some(4));

    // Unknown operation, then a ping still works.
    let mut child = session(&root, package::digest(), &home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    send(&mut stdin, &json!({"id":1,"op":"nope"}));
    let error = lines.value(WAIT);
    assert_eq!(error["re"], 1);
    assert_eq!(error["err"]["code"], "unknown_op");
    send(&mut stdin, &json!({"id":2,"op":"ping"}));
    assert_eq!(lines.value(WAIT)["re"], 2);
    drop(stdin);
    assert_eq!(finish(child, WAIT).0.code(), Some(0));
}

#[test]
fn session_exits_when_no_frames_arrive() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("machine-id"), b"0123456789abcdef0123456789abcdef").unwrap();
    std::fs::write(home.join("boot-id"), b"boot").unwrap();
    let root = home.join("data");
    install(&root);
    let mut child = Command::new(python());
    child.args(["-I", root.join("remote/bin").join(format!("{}.py", package::digest())).to_str().unwrap(), "session"]);
    base_env(&mut child, &home);
    child.env("YUZUNO_REMOTE_ROOT", &root);
    child.env("YUZUNO_REMOTE_DIGEST", package::digest());
    child.env("YUZUNO_REMOTE_SILENCE", "0.3");
    child.env("YUZUNO_JOBS_MACHINE_ID_FILE", home.join("machine-id"));
    child.env("YUZUNO_JOBS_BOOT_ID_FILE", home.join("boot-id"));
    child.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = child.spawn().unwrap();
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    // One byte at a time, never a newline: an unfinished frame must not refresh
    // the silence deadline, however steadily the bytes arrive.
    let trickle = std::thread::spawn(move || {
        for _ in 0..30 {
            if stdin.write_all(b"x").is_err() {
                return;
            }
            let _ = stdin.flush();
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    let bye = lines.value(Duration::from_secs(3));
    assert_eq!(bye["data"]["code"], 6, "{bye}");
    assert_eq!(finish(child, WAIT).0.code(), Some(6));
    trickle.join().unwrap();
}

#[test]
fn session_exits_when_the_peer_does_not_read_or_stdin_closes() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("machine-id"), b"0123456789abcdef0123456789abcdef").unwrap();
    std::fs::write(home.join("boot-id"), b"boot").unwrap();
    let root = home.join("data");
    install(&root);

    let mut child = session(&root, package::digest(), &home);
    let _stdout = child.stdout.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut pings = Vec::new();
    for id in 0..20000 {
        pings.extend_from_slice(format!("{{\"id\":{id},\"op\":\"ping\"}}\n").as_bytes());
    }
    let _ = stdin.write_all(&pings);
    let (status, stderr) = finish(child, WAIT);
    assert_eq!(status.code(), Some(5), "stderr: {stderr}");
    drop(_stdout);

    let mut child = session(&root, package::digest(), &home);
    let _stdout = child.stdout.take().unwrap();
    let stdin = child.stdin.take().unwrap();
    drop(stdin);
    let (status, stderr) = finish(child, WAIT);
    assert_eq!(status.code(), Some(0), "stderr: {stderr}");
}

#[test]
fn session_exits_when_stdout_is_closed_or_stdin_ends() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("machine-id"), b"0123456789abcdef0123456789abcdef").unwrap();
    std::fs::write(home.join("boot-id"), b"boot").unwrap();
    let root = home.join("data");
    install(&root);

    let mut child = session(&root, package::digest(), &home);
    drop(child.stdout.take());
    let mut stdin = child.stdin.take().unwrap();
    send(&mut stdin, &json!({"id":1,"op":"ping"}));
    let (status, stderr) = finish(child, WAIT);
    assert_eq!(status.code(), Some(5), "stderr: {stderr}");

    let mut child = session(&root, package::digest(), &home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let stdin = child.stdin.take().unwrap();
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    drop(stdin);
    let bye = lines.value(WAIT);
    assert_eq!(bye["ev"], "bye");
    assert_eq!(bye["data"]["clean"], true, "{bye}");
    assert_eq!(finish(child, WAIT).0.code(), Some(0));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_session_has_no_socket_or_child_process() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("machine-id"), b"0123456789abcdef0123456789abcdef").unwrap();
    std::fs::write(home.join("boot-id"), b"boot").unwrap();
    let root = home.join("data");
    install(&root);
    let mut child = session(&root, package::digest(), &home);
    let lines = Lines::new(child.stdout.take().unwrap());
    let stdin = child.stdin.take().unwrap();
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    let pid = child.id();
    for entry in std::fs::read_dir(format!("/proc/{pid}/fd")).unwrap() {
        let link = std::fs::read_link(entry.unwrap().path()).unwrap_or_default();
        assert!(!link.to_string_lossy().starts_with("socket:"), "socket fd {link:?}");
    }
    for entry in std::fs::read_dir("/proc").unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{name}/stat")) else { continue };
        let Some(rest) = stat.rsplit_once(") ") else { continue };
        let fields: Vec<&str> = rest.1.split_whitespace().collect();
        let ppid = fields.get(1).and_then(|value| value.parse::<u32>().ok());
        if ppid == Some(pid) {
            panic!("session {pid} has child {name}");
        }
    }
    drop(stdin);
    assert_eq!(finish(child, WAIT).0.code(), Some(0));
}

#[test]
fn identity_matches_the_jobs_helper_and_stays_null_without_machine_id() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let machine = home.join("machine-id");
    std::fs::write(&machine, b"0123456789abcdef0123456789abcdef").unwrap();
    let boot = home.join("boot-id");
    std::fs::write(&boot, b"boot").unwrap();
    let root = home.join("data");
    std::fs::create_dir(&root).unwrap();
    let script = r#"
import builtins, hashlib, importlib.util, io, json, os, platform, sys
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
program = load("remote_program", sys.argv[1])
jobs = load("remote_jobs", sys.argv[2])
# No override: give both helpers the same synthetic machine and boot identity
# through the paths they read by default, so this comparison does not depend on
# the host running the test.
synthetic = len(sys.argv) > 7 and sys.argv[7] == "synthetic"
expected = None
if synthetic:
    jobs.DARWIN = False
    platform.system = lambda: "Linux"
    machine = "fedcba9876543210fedcba9876543210"
    files = {"/etc/machine-id": machine + "\n",
             "/proc/sys/kernel/random/boot_id": "synthetic-boot\n"}
    real_open = builtins.open
    def opened(path, *args, **kwargs):
        name = path if isinstance(path, str) else os.fspath(path)
        if name in files:
            return io.StringIO(files[name])
        return real_open(path, *args, **kwargs)
    builtins.open = opened
    expected = hashlib.sha256(("yuzuno-jobs-host-v1:" + machine).encode("utf-8")).hexdigest()[:32]
host = program.host_id()
print(json.dumps({"programHost": host, "jobsHost": jobs.host_id(),
    "programBoot": program.boot_id(), "jobsBoot": jobs.boot_id(),
    "account": program.account_key(host, sys.argv[5]),
    "ioreg": program.parse_ioreg(sys.argv[6]),
    "expectedHost": expected}))
"#;
    let ioreg = r#""IOPlatformUUID" = "01234567-89AB-CDEF-0123-456789ABCDEF""#;
    let run = |machine_id: &Path| {
        let output = Command::new(python())
            .args(["-I", "-c", script,
                source("src/remote_service/program.py").to_str().unwrap(),
                source("src/jobs/remote_job.py").to_str().unwrap(),
                machine_id.to_str().unwrap(), boot.to_str().unwrap(),
                root.to_str().unwrap(), ioreg])
            .env("YUZUNO_JOBS_MACHINE_ID_FILE", machine_id)
            .env("YUZUNO_JOBS_BOOT_ID_FILE", &boot)
            .env("YUZUNO_REMOTE_ROOT", &root)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let found = run(&machine);
    assert_eq!(found["programHost"], found["jobsHost"]);
    assert_eq!(found["programBoot"], found["jobsBoot"]);
    assert_eq!(found["programHost"].as_str().unwrap().len(), 32);
    assert_eq!(found["account"].as_str().unwrap().len(), 32);
    assert_eq!(found["ioreg"], "0123456789abcdef0123456789abcdef");
    let missing = run(&home.join("missing"));
    assert!(missing["programHost"].is_null());
    assert!(missing["jobsHost"].is_null());
    assert!(missing["account"].is_null());

    // With no override both read the machine's own identity. The no-override
    // case is synthetic: the child's default paths are answered from fixed
    // values, so the comparison does not depend on the host running the test.
    let inherited = Command::new(python())
        .args(["-I", "-c", script,
            source("src/remote_service/program.py").to_str().unwrap(),
            source("src/jobs/remote_job.py").to_str().unwrap(),
            machine.to_str().unwrap(), boot.to_str().unwrap(),
            root.to_str().unwrap(), ioreg, "synthetic"])
        .env("HOME", &home)
        .env_remove("YUZUNO_JOBS_MACHINE_ID_FILE")
        .env_remove("YUZUNO_JOBS_BOOT_ID_FILE")
        .env_remove("YUZUNO_REMOTE_ROOT")
        .output()
        .unwrap();
    assert!(inherited.status.success(), "{}", String::from_utf8_lossy(&inherited.stderr));
    let inherited: Value = serde_json::from_slice(&inherited.stdout).unwrap();
    assert_eq!(inherited["programHost"], inherited["jobsHost"]);
    assert_eq!(inherited["programBoot"], inherited["jobsBoot"]);
    assert_eq!(inherited["programHost"], inherited["expectedHost"]);
    assert_eq!(inherited["programHost"].as_str().unwrap().len(), 32);
    assert_eq!(inherited["programBoot"], "synthetic-boot");
    assert_eq!(inherited["account"].as_str().unwrap().len(), 32);
}

#[test]
fn boot_command_ends_with_fixed_python_code() {
    let machine: RemoteMachine = serde_json::from_value(json!({
        "id":"m1", "name":"lab", "target":"lab.invalid", "codex":"codex", "defaultCwd":"/tmp"
    })).unwrap();
    let command = super::boot_command(&machine);
    let args: Vec<String> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
    assert_eq!(args.last().unwrap(), &format!("python3 -c {}", crate::remote::shell_quote(package::BOOT)));
    assert!(args.iter().any(|arg| arg == "ClearAllForwardings=yes"));
    assert!(args.iter().any(|arg| arg == "lab.invalid"));
}

#[test]
fn shutdown_reaps_children_before_bye_and_reports_a_pending_read() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::write(home.join("machine-id"), b"0123456789abcdef0123456789abcdef").unwrap();
    std::fs::write(home.join("boot-id"), b"boot").unwrap();
    let root = home.join("data");
    install(&root);
    let child_script = home.join("child.py");
    std::fs::write(&child_script, b"import os,sys,time\nopen(sys.argv[1],'w').write(str(os.getpid()))\ntime.sleep(60)\n").unwrap();
    let pid_file = home.join("child.pid");
    let child_command = format!("{} {} {}", python(), child_script.display(), pid_file.display());

    let mut command = Command::new(python());
    command.args(["-I", root.join("remote/bin").join(format!("{}.py", package::digest())).to_str().unwrap(), "session"]);
    base_env(&mut command, &home);
    command.env("YUZUNO_REMOTE_ROOT", &root);
    command.env("YUZUNO_REMOTE_DIGEST", package::digest());
    command.env("YUZUNO_JOBS_MACHINE_ID_FILE", home.join("machine-id"));
    command.env("YUZUNO_JOBS_BOOT_ID_FILE", home.join("boot-id"));
    command.env("YUZUNO_REMOTE_TEST_CHILD", child_command);
    command.env("YUZUNO_REMOTE_TEST_CHILD_PID_FILE", &pid_file);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let lines = Lines::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    let start = Instant::now();
    while !pid_file.exists() {
        assert!(start.elapsed() < WAIT, "child did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    let child_pid: u32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    send(&mut stdin, &json!({"id":1,"op":"close"}));
    let bye = lines.value(WAIT);
    assert_eq!(bye["data"]["clean"], true, "{bye}");
    assert_eq!(finish(child, WAIT).0.code(), Some(0));
    assert!(!Path::new(&format!("/proc/{child_pid}")).exists(), "child {child_pid} survived");

    let mut command = Command::new(python());
    command.args(["-I", root.join("remote/bin").join(format!("{}.py", package::digest())).to_str().unwrap(), "session"]);
    base_env(&mut command, &home);
    command.env("YUZUNO_REMOTE_ROOT", &root);
    command.env("YUZUNO_REMOTE_DIGEST", package::digest());
    command.env("YUZUNO_JOBS_MACHINE_ID_FILE", home.join("machine-id"));
    command.env("YUZUNO_JOBS_BOOT_ID_FILE", home.join("boot-id"));
    command.env("YUZUNO_REMOTE_TEST_HOLD_READ", "1");
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let lines = Lines::new(child.stdout.take().unwrap());
    let stdin = child.stdin.take().unwrap();
    assert_eq!(lines.value(WAIT)["ev"], "hello");
    drop(stdin);
    let bye = lines.value(WAIT);
    assert_eq!(bye["data"]["clean"], false, "{bye}");
    assert_eq!(bye["data"]["why"], json!(["read_pending"]));
    assert_eq!(finish(child, WAIT).0.code(), Some(0));
}
