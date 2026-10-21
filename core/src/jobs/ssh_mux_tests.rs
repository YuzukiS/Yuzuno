//! T-163: remote-Job helper calls share a Core-private OpenSSH connection
//! (ssh_mux), against a real sshd on 127.0.0.1 with its own keys. None of
//! the user's SSH configuration, keys or known hosts is read: calls go
//! through a wrapper that gives OpenSSH this test's own configuration.
use super::remote::{call, Machine, Programs, Reply};
use super::ssh_mux::{destination, Mux};
use crate::remote::RemoteMachine;
use serde_json::json;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

struct Sshd {
    dir: tempfile::TempDir,
    child: std::process::Child,
    wrapper: String,
    port: u16,
    closed: u16,
}

impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn run(program: &str, args: &[&str]) {
    let status = std::process::Command::new(program).args(args).status().unwrap();
    assert!(status.success(), "{program} {args:?}");
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

impl Sshd {
    fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        run("ssh-keygen", &["-q", "-t", "ed25519", "-N", "", "-f", &path("host")]);
        run("ssh-keygen", &["-q", "-t", "ed25519", "-N", "", "-f", &path("client")]);
        std::fs::rename(path("client.pub"), path("authorized_keys")).unwrap();
        let port = free_port();
        std::fs::write(path("sshd_config"), format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nStrictModes no\n\
             UsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nLogLevel INFO\n",
            path("host"), path("sshd.pid"), path("authorized_keys"))).unwrap();
        let sshd = ["/usr/sbin/sshd", "/usr/bin/sshd"].into_iter().find(|p| Path::new(p).exists())
            .expect("these tests need OpenSSH's sshd");
        let child = std::process::Command::new(sshd)
            .args(["-D", "-f", &path("sshd_config"), "-E", &path("sshd.log")]).spawn().unwrap();
        let host = std::fs::read_to_string(path("host.pub")).unwrap();
        let mut key = host.split_whitespace();
        let (kind, base64) = (key.next().unwrap(), key.next().unwrap());
        std::fs::write(path("known_hosts"), format!("[127.0.0.1]:{port} {kind} {base64}\n")).unwrap();
        let closed = free_port();
        let wrapper = path("ssh");
        std::fs::write(&wrapper, format!("#!/bin/sh\nexec ssh -F '{}' \"$@\"\n", path("ssh_config"))).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sshd = Self { dir, child, wrapper, port, closed };
        sshd.point_box_a(port);
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return sshd;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("sshd did not start: {}", std::fs::read_to_string(sshd.dir.path().join("sshd.log")).unwrap_or_default());
    }

    /// The client configuration, with `box-a` leading to `port`; `box-b`
    /// leads to this sshd and `box-down` to a closed port.
    fn point_box_a(&self, port: u16) {
        let path = |name: &str| self.dir.path().join(name).to_string_lossy().into_owned();
        let mut config = String::new();
        for (alias, port) in [("box-a", port), ("box-b", self.port), ("box-down", self.closed)] {
            config += &format!("Host {alias}\n  HostName 127.0.0.1\n  Port {port}\n  IdentityFile {}\n  IdentitiesOnly yes\n  \
                IdentityAgent none\n  UserKnownHostsFile {}\n  GlobalKnownHostsFile /dev/null\n",
                path("client"), path("known_hosts"));
        }
        std::fs::write(path("ssh_config"), config).unwrap();
    }

    /// Connections sshd has accepted so far.
    fn connections(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("sshd.log")).unwrap_or_default()
            .lines().filter(|line| line.contains("Accepted publickey")).count()
    }
}

fn machine(id: &str, target: &str) -> RemoteMachine {
    RemoteMachine { id: id.into(), name: id.into(), target: target.into(), codex: "codex".into(), default_cwd: "/tmp".into(), ..Default::default() }
}

fn mux(base: &Path) -> Mux {
    Mux::new(Some(base.join("mux")), Duration::from_secs(60), Duration::from_secs(600), Duration::from_secs(60))
}

/// A short base for the sockets, as `$XDG_RUNTIME_DIR` or `/tmp` would be.
fn short_base() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("m").tempdir_in("/tmp").unwrap()
}

async fn hello(sshd: &Sshd, mux: Option<&Mux>, machine: &RemoteMachine) -> Reply {
    hello_through(&sshd.wrapper, mux, machine).await
}

async fn hello_through(ssh: &str, mux: Option<&Mux>, machine: &RemoteMachine) -> Reply {
    call(&Programs { ssh, windows: None, mux }, &Machine::Ssh(machine.clone()), json!({"action": "hello"})).await
}

/// Until the master started for `machine` is ready (or none is starting).
async fn settled(mux: &Mux, machine: &RemoteMachine) -> bool {
    for _ in 0..500 {
        let (ready, starting) = mux.state(machine);
        if !starting {
            return ready;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("a master is still starting");
}

fn answered(reply: &Reply) -> bool {
    matches!(reply, Reply::Answer(value) if value["status"] == "hello")
}

fn kind(reply: &Reply) -> &'static str {
    match reply {
        Reply::Answer(_) => "answer",
        Reply::Refused(_) => "refused",
        Reply::NoAnswer(_) => "no answer",
        Reply::Broken(_) => "broken",
        Reply::Unusable(_) => "unusable",
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn calls_share_one_private_connection_and_each_without_it_makes_its_own() {
    let sshd = Sshd::start();
    let base = short_base();
    let mux = mux(base.path());
    let box_a = machine("m1", "box-a");
    // The first call connects itself, as before, and starts the master.
    let first = hello(&sshd, Some(&mux), &box_a).await;
    assert!(answered(&first), "{}", kind(&first));
    assert!(settled(&mux, &box_a).await);
    for _ in 0..4 {
        assert!(answered(&hello(&sshd, Some(&mux), &box_a).await));
    }
    assert_eq!(sshd.connections(), 2, "the first call's own, then one for four calls");
    assert_eq!(mux.starts(&box_a), 1);
    // The socket is in this process's own private directory.
    let dir = mux.socket_dir().unwrap();
    let meta = std::fs::symlink_metadata(&dir).unwrap();
    assert!(meta.is_dir() && meta.mode() & 0o777 == 0o700 && meta.uid() == unsafe { libc::geteuid() });
    assert!(dir.file_name().unwrap().to_str().unwrap().starts_with(&format!("{}-", std::process::id())));
    let sockets: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().path()).collect();
    assert_eq!(sockets.len(), 1);
    assert!(sockets[0].as_os_str().len() < 108 - 17);
    // Without the shared connection every call is its own, as before.
    for _ in 0..2 {
        assert!(answered(&hello(&sshd, None, &box_a).await));
    }
    assert_eq!(sshd.connections(), 4);
    let pid = mux.master_pid(&box_a).unwrap();
    drop(mux);
    assert!(!dir.exists(), "a Core's sockets go with it");
    gone(pid).await;
}

/// Until process `pid` has ended (an ended child of this process is
/// reaped when its Child is dropped).
async fn gone(pid: u32) {
    for _ in 0..250 {
        let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        if state.is_empty() || state.split(") ").nth(1).is_some_and(|rest| rest.starts_with('Z')) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("master {pid} is still running");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_master_that_stops_is_replaced_and_every_call_answers() {
    let sshd = Sshd::start();
    let base = short_base();
    let mux = mux(base.path());
    let box_a = machine("m1", "box-a");
    assert!(answered(&hello(&sshd, Some(&mux), &box_a).await));
    assert!(settled(&mux, &box_a).await);
    mux.kill_master_for_test(&box_a);
    for _ in 0..250 {
        mux.sweep();
        if !mux.state(&box_a).0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Found stopped, it is replaced; this call connects itself meanwhile.
    assert!(answered(&hello(&sshd, Some(&mux), &box_a).await));
    assert!(settled(&mux, &box_a).await);
    assert!(answered(&hello(&sshd, Some(&mux), &box_a).await));
    assert_eq!(mux.starts(&box_a), 2);
    assert_eq!(sshd.connections(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn machines_targets_and_cores_never_share_a_connection() {
    let sshd = Sshd::start();
    let base = short_base();
    let (first, second) = (mux(base.path()), mux(base.path()));
    for (mux, machine) in [(&first, machine("m1", "box-a")), (&first, machine("m2", "box-a")),
        (&first, machine("m1", "box-b")), (&second, machine("m1", "box-a"))] {
        assert!(answered(&hello(&sshd, Some(mux), &machine).await));
        assert!(settled(mux, &machine).await);
        assert!(answered(&hello(&sshd, Some(mux), &machine).await));
        assert_eq!(mux.starts(&machine), 1);
    }
    // Another machine, a changed target and another Core each have their own.
    assert_eq!(sshd.connections(), 8);
    let (one, two) = (first.socket_dir().unwrap(), second.socket_dir().unwrap());
    assert_ne!(one, two);
    assert_eq!(std::fs::read_dir(&one).unwrap().count(), 3);
    assert_eq!(std::fs::read_dir(&two).unwrap().count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_target_pointed_elsewhere_never_uses_its_old_connection() {
    let sshd = Sshd::start();
    let base = short_base();
    let mux = mux(base.path());
    let box_a = machine("m1", "box-a");
    assert!(answered(&hello(&sshd, Some(&mux), &box_a).await));
    assert!(settled(&mux, &box_a).await);
    assert!(answered(&hello(&sshd, Some(&mux), &box_a).await));
    assert_eq!(sshd.connections(), 2);
    let here = destination(&sshd.wrapper, "box-a").await.unwrap();
    // The SSH configuration now leads the same name elsewhere (a closed
    // port here): the call goes there, as it would without a master.
    sshd.point_box_a(sshd.closed);
    assert_ne!(destination(&sshd.wrapper, "box-a").await.unwrap(), here);
    assert_eq!(kind(&hello(&sshd, Some(&mux), &box_a).await), "no answer");
    assert_eq!(kind(&hello(&sshd, None, &box_a).await), "no answer");
    // Pointed back, the connection to where it leads again is used.
    sshd.point_box_a(sshd.port);
    assert!(answered(&hello(&sshd, Some(&mux), &box_a).await));
    assert_eq!(sshd.connections(), 2, "the old connection, never one made through the other configuration");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refusing_or_unreachable_machine_answers_as_before_and_is_not_retried_early() {
    let sshd = Sshd::start();
    let base = short_base();
    let mux = Mux::new(Some(base.path().join("mux")), Duration::from_secs(60), Duration::from_secs(600), Duration::from_millis(500));
    let down = machine("m3", "box-down");
    let before = kind(&hello(&sshd, None, &down).await);
    assert_eq!(before, "no answer", "without a master");
    for _ in 0..2 {
        assert_eq!(kind(&hello(&sshd, Some(&mux), &down).await), before, "each call fails itself, as before");
        assert!(!settled(&mux, &down).await);
    }
    assert_eq!(mux.starts(&down), 1, "not tried again within its retry time");
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(kind(&hello(&sshd, Some(&mux), &down).await), before);
    assert!(!settled(&mux, &down).await);
    assert_eq!(mux.starts(&down), 2);
    // A host key that does not match is refused by the master as by a call:
    // the call answers as it would have without one.
    let wrong = sshd.dir.path().join("known_hosts");
    let text = std::fs::read_to_string(&wrong).unwrap();
    std::fs::write(&wrong, text.replace("ssh-ed25519 ", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrO")).unwrap();
    let box_a = machine("m1", "box-a");
    let refused = kind(&hello(&sshd, None, &box_a).await);
    assert_ne!(refused, "answer");
    assert_eq!(kind(&hello(&sshd, Some(&mux), &box_a).await), refused);
    assert!(!settled(&mux, &box_a).await, "no master with a host key that does not match");
    assert_eq!(sshd.connections(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_and_old_masters_end_but_never_under_a_call() {
    let sshd = Sshd::start();
    let base = short_base();
    let box_a = machine("m1", "box-a");
    let idle = Mux::new(Some(base.path().join("idle")), Duration::from_millis(300), Duration::from_secs(600), Duration::from_secs(60));
    assert!(answered(&hello(&sshd, Some(&idle), &box_a).await));
    assert!(settled(&idle, &box_a).await);
    let here = destination(&sshd.wrapper, "box-a").await.unwrap();
    let held = idle.client(&sshd.wrapper, &box_a, &here).expect("the live master");
    tokio::time::sleep(Duration::from_millis(400)).await;
    idle.sweep();
    assert!(idle.state(&box_a).0, "a call still uses it");
    drop(held);
    idle.sweep();
    assert!(!idle.state(&box_a).0, "idle and unused");
    let old = Mux::new(Some(base.path().join("old")), Duration::from_secs(60), Duration::from_millis(300), Duration::from_secs(60));
    assert!(answered(&hello(&sshd, Some(&old), &box_a).await));
    assert!(settled(&old, &box_a).await);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(answered(&hello(&sshd, Some(&old), &box_a).await));
    assert!(settled(&old, &box_a).await);
    assert_eq!(old.starts(&box_a), 2, "replaced after its age");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_private_short_directory_means_calls_connect_as_before() {
    let sshd = Sshd::start();
    let base = short_base();
    let box_a = machine("m1", "box-a");
    // A base others may write to is never used.
    let shared = base.path().join("shared");
    std::fs::create_dir(&shared).unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
    let open = Mux::new(Some(shared), Duration::from_secs(60), Duration::from_secs(600), Duration::from_secs(60));
    // Nor one whose sockets would not fit a Unix socket's path.
    let far = Mux::new(Some(base.path().join("x".repeat(90))), Duration::from_secs(60), Duration::from_secs(600), Duration::from_secs(60));
    // Nor one OpenSSH would split as an option's value.
    let spaced = Mux::new(Some(base.path().join("a b")), Duration::from_secs(60), Duration::from_secs(600), Duration::from_secs(60));
    for mux in [&open, &far, &spaced] {
        assert!(answered(&hello(&sshd, Some(mux), &box_a).await));
        assert!(mux.client(&sshd.wrapper, &box_a, &destination(&sshd.wrapper, "box-a").await.unwrap()).is_none());
        assert_eq!(mux.starts(&box_a), 0);
    }
    assert_eq!(sshd.connections(), 3, "each call connected itself");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn directories_of_ended_cores_are_removed_and_none_is_reused() {
    let sshd = Sshd::start();
    let base = short_base();
    let root = base.path().join("mux");
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ended = root.join("4194999-deadbeef");
    let alive = root.join(format!("{}-cafebabe", std::process::id()));
    for dir in [&ended, &alive] {
        std::fs::create_dir(dir).unwrap();
        std::fs::write(dir.join("0123456789abcdef"), "").unwrap();
    }
    let mux = mux(base.path());
    assert!(answered(&hello(&sshd, Some(&mux), &machine("m1", "box-a")).await));
    assert!(!ended.exists(), "left by a Core that has ended");
    assert!(alive.exists(), "another live Core's");
    let own = mux.socket_dir().unwrap();
    assert!(own != alive && own.parent() == Some(root.as_path()));
}

/// The Core of `a_killed_core_takes_its_master_with_it`: a process that
/// starts a master, says its process ID and waits to be killed.
#[test]
#[ignore = "run by a_killed_core_takes_its_master_with_it"]
fn killed_core_stand_in() {
    let (Ok(ssh), Ok(base)) = (std::env::var("YUZUNO_T163_SSH"), std::env::var("YUZUNO_T163_BASE")) else { return };
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    runtime.block_on(async {
        let mux = Mux::new(Some(PathBuf::from(base)), Duration::from_secs(60), Duration::from_secs(600), Duration::from_secs(60));
        let box_a = machine("m1", "box-a");
        assert!(answered(&hello_through(&ssh, Some(&mux), &box_a).await));
        assert!(settled(&mux, &box_a).await);
        println!("MASTER {} ", mux.master_pid(&box_a).unwrap());
        tokio::time::sleep(Duration::from_secs(120)).await;
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_killed_core_takes_its_master_with_it() {
    use std::io::BufRead;
    let sshd = Sshd::start();
    let base = short_base();
    let mut core = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "jobs::ssh_mux_tests::killed_core_stand_in", "--nocapture", "--test-threads=1"])
        .env("YUZUNO_T163_SSH", &sshd.wrapper)
        .env("YUZUNO_T163_BASE", base.path().join("mux"))
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = std::io::BufReader::new(core.stdout.take().unwrap());
    // libtest prints the line on its "test … " line.
    let pid: u32 = stdout.lines().map_while(Result::ok)
        .find_map(|line| line.split("MASTER ").nth(1).and_then(|pid| pid.split_whitespace().next()?.parse().ok()))
        .expect("the stand-in Core started a master");
    assert!(Path::new(&format!("/proc/{pid}")).exists());
    // As a crash: no Drop, no cleanup in the Core.
    core.kill().unwrap();
    core.wait().unwrap();
    gone(pid).await;
    assert_eq!(sshd.connections(), 2);
}

/// T-163's before and after, through `call` as Core makes it: one helper
/// `hello` 30 times on its own connections, then 30 times through a shared
/// one (started by a first call, not counted), on 127.0.0.1 (no network
/// round trips). Prints connections and per-call times; asserts only that
/// every call answered.
/// `cargo test --lib measure_calls_with_and_without_a_shared_connection -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "an opt-in measurement"]
async fn measure_calls_with_and_without_a_shared_connection() {
    let sshd = Sshd::start();
    let base = short_base();
    let mux = mux(base.path());
    let box_a = machine("m1", "box-a");
    let mut report = Vec::new();
    for shared in [false, true] {
        if shared {
            assert!(answered(&hello(&sshd, Some(&mux), &box_a).await));
            assert!(settled(&mux, &box_a).await);
        }
        let before = sshd.connections();
        let mut times = Vec::new();
        for _ in 0..30 {
            let at = std::time::Instant::now();
            let reply = hello(&sshd, shared.then_some(&mux), &box_a).await;
            times.push(at.elapsed().as_secs_f64() * 1000.0);
            assert!(answered(&reply), "{}", kind(&reply));
        }
        times.sort_by(f64::total_cmp);
        report.push(json!({"shared": shared, "calls": 30, "connections": sshd.connections() - before,
            "medianMs": (times[14] + times[15]) / 2.0, "p90Ms": times[26], "minMs": times[0], "maxMs": times[29]}));
    }
    println!("T163-MEASURE {}", serde_json::Value::Array(report));
}

/// Every other SSH invocation (`remote::ssh_with`: remote Agents, image
/// transfers, a call without a shared connection) keeps exactly the
/// arguments it had before T-163; only a shared connection's differ, and in
/// its ControlMaster and ControlPath alone.
#[test]
fn ssh_without_a_shared_connection_keeps_its_arguments() {
    use crate::remote::{ssh_with, ssh_with_control, Control};
    let args = |command: tokio::process::Command| -> Vec<String> {
        command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect()
    };
    let before: Vec<String> = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
        "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
        "-o", "RemoteCommand=none"].map(String::from).to_vec();
    assert_eq!(args(ssh_with("ssh")), before);
    let socket = Path::new("/run/user/1000/yuzuno-ssh/1-ab/0123456789abcdef");
    let client: Vec<String> = before.iter().map(|arg| match arg.as_str() {
        "ControlPath=none" => format!("ControlPath={}", socket.display()),
        other => other.to_owned(),
    }).collect();
    assert_eq!(args(ssh_with_control("ssh", Control::Client(socket))), client);
    let mut master = vec!["-o".to_owned(), "ControlPersist=no".to_owned()];
    master.extend(client.iter().map(|arg| if arg == "ControlMaster=no" { "ControlMaster=yes".to_owned() } else { arg.clone() }));
    assert_eq!(args(ssh_with_control("ssh", Control::Master(socket))), master);
}
