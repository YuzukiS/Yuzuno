use super::*;
use crate::{model::AgentDetail, remote::RemoteMachine, workspace::Workspace};
use tokio::task::JoinHandle;

/// OpenSSH's `-L` as far as these tests need it: a TCP relay from the local
/// port to the "remote" one (this host), the remote command's ready line once
/// it listens, an exit at the end of stdin (where the remote `cat` ends), and
/// ssh's own words for each failure.
const SSH: &str = r#"#!/usr/bin/python3
import os, socket, sys, threading
args, spec, target, command, i = sys.argv[1:], None, None, [], 0
while i < len(args):
    if args[i] == '-o': i += 2
    elif args[i] in ('-T', '-N'): i += 1
    elif args[i] == '-L': spec = args[i + 1]; i += 2
    elif target is None: target = args[i]; i += 1
    else: command.append(args[i]); i += 1
lhost, lport, rhost, rport = spec.rsplit(':', 3)
def say(line): print(line, file=sys.stderr, flush=True)
if target == 'unreachable':
    say('ssh: connect to host unreachable port 22: Connection refused'); sys.exit(255)
if target == 'busy':
    say(f'bind [127.0.0.1]:{lport}: Address already in use')
    say(f'channel_setup_fwd_listener_tcpip: cannot listen to port: {lport}')
    say('Could not request local forwarding.'); sys.exit(255)
server = socket.socket()
try:
    server.bind((lhost, int(lport)))
except OSError:
    say(f'bind [{lhost}]:{lport}: Address already in use'); sys.exit(255)
server.listen(16)
# Where a test can find this process.
open(os.path.join(os.path.dirname(sys.argv[0]), f'pid-{lport}'), 'w').write(str(os.getpid()))
if target == 'chatty':
    print('Welcome to a login banner', flush=True)
if 'cat >/dev/null' in ' '.join(command):
    print('yuzuno-forward-ready', flush=True)
def hold():
    while sys.stdin.buffer.read(1024): pass
    os._exit(0)
threading.Thread(target=hold, daemon=True).start()
if target == 'short':
    threading.Timer(1.0, lambda: (say('Connection to short closed by remote host.'), os._exit(255))).start()
channel = [2]
def pipe(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data: break
            b.sendall(data)
    except OSError: pass
    finally:
        try: b.shutdown(socket.SHUT_WR)
        except OSError: pass
def serve(client):
    try:
        up = socket.create_connection((rhost, int(rport)))
    except OSError:
        client.close()
        say(f'channel {channel[0]}: open failed: connect failed: Connection refused'); channel[0] += 1
        return
    threading.Thread(target=pipe, args=(client, up), daemon=True).start()
    pipe(up, client)
while True:
    client, _ = server.accept()
    threading.Thread(target=serve, args=(client,), daemon=True).start()
"#;

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    project: String,
    /// Last, so it is released after the Workspace (`ports`).
    _ports: std::fs::File,
}

fn lab() -> Lab {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    for (id, target) in [("m1", "fixture"), ("down", "unreachable"), ("busy", "busy"), ("short", "short"), ("chatty", "chatty")] {
        ws.store.add_machine(&RemoteMachine {
            id: id.into(), name: id.into(), target: target.into(), codex: "codex".into(), default_cwd: "/tmp".into(),
            ..Default::default()
        }).unwrap();
    }
    let project = ws.store.create_project("Lab", Default::default()).unwrap().id;
    let (ports, first) = ports(std::fs::metadata(dir.path()).unwrap().uid());
    ws.services.use_ports(first..=first + 7);
    let ssh = dir.path().join("ssh");
    std::fs::write(&ssh, SSH).unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    ws.services.use_ssh(&ssh.to_string_lossy());
    Lab { _dir: dir, ws, project, _ports: ports }
}

/// A block of 8 service ports for one lab alone, and the lock that holds it.
/// Tests run side by side, in this process and in others (CI runs the lib's
/// tests in parallel processes): a lab locks its block's file for as long as
/// it lives, so a port it closed is never another lab's.
fn ports(uid: u32) -> (std::fs::File, u16) {
    let locks = std::path::PathBuf::from(format!("/tmp/yuzuno-service-test-ports-{uid}"));
    std::fs::create_dir_all(&locks).unwrap();
    for first in (21000..25000).step_by(8) {
        let file = std::fs::File::create(locks.join(first.to_string())).unwrap();
        if file.try_lock().is_ok() {
            return (file, first);
        }
    }
    panic!("every block of service test ports is held");
}

/// An HTTP service on this host's loopback answering every request with 200,
/// or (silent) reading requests and never answering.
async fn service(silent: bool) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let _ = stream.read(&mut buffer).await;
                if silent {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                } else {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
                }
            });
        }
    });
    (port, task)
}

/// A port nothing listens on.
async fn unused_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port()
}

fn new(name: &str, machine: &str, port: u16) -> NewService {
    NewService { name: name.into(), machine_id: machine.into(), port, path: "/".into() }
}

async fn register(lab: &Lab, machine: &str, port: u16) -> String {
    let view = lab.ws.register_service(&lab.project, new("dev", machine, port), json!({"kind":"user"}), None).await.unwrap();
    view["id"].as_str().unwrap().to_owned()
}

async fn open(lab: &Lab, id: &str) -> Value {
    lab.ws.open_service(id, None).await.unwrap()["connection"].clone()
}

async fn answers(port: u16) -> bool {
    matches!(probe(port, "/").await, Probe::Http(200, _))
}

/// Whether nothing listens on `port` (one of this lab's) within 5 seconds:
/// a closed way's listener ends in its own task, just after the close.
async fn unheard(port: u16) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

/// The page's check before it opens a service: the reserved request on the
/// port this client would open, with only the challenge (and the page's
/// origin), must return exactly the answer Core gave it.
async fn proves(port: u16, proof: &Value) -> bool {
    proves_from(port, proof, None).await
}

async fn proves_from(port: u16, proof: &Value, origin: Option<&str>) -> bool {
    let (status, body, _) = exchange(port, &format!("/.well-known/yuzuno-service/{}", proof["challenge"].as_str().unwrap()), origin).await;
    status == 200 && body == proof["answer"].as_str().unwrap()
}

/// A plain GET: its status and body.
async fn get(port: u16, path: &str) -> (u16, String) {
    let (status, body, _) = exchange(port, path, None).await;
    (status, body)
}

/// A GET, with an Origin header if given: status, body and head.
async fn exchange(port: u16, path: &str, origin: Option<&str>) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
    stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{origin}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut text = String::new();
    let _ = timeout(Duration::from_secs(3), stream.read_to_string(&mut text)).await;
    let status = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (status, body.to_owned(), head.to_owned())
}

/// Something else on a client's port that answers 200 with the request's
/// own first line: it sees the challenge and sends it back.
async fn echoing() -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buffer = [0u8; 2048];
                let n = stream.read(&mut buffer).await.unwrap_or(0);
                let text = String::from_utf8_lossy(&buffer[..n]);
                let path = text.split(' ').nth(1).unwrap_or_default();
                let echo = path.rsplit('/').next().unwrap_or_default().to_owned();
                let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\
                    Connection: close\r\n\r\n{echo}", echo.len()).as_bytes()).await;
            });
        }
    });
    (port, task)
}

/// A server answering every request with 200 and a body of its own, and
/// counting them: an unrelated service on a client's port, or the service
/// itself when the test needs to know what reached it.
async fn counting() -> (u16, Arc<std::sync::atomic::AtomicUsize>, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = seen.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let count = count.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                if stream.read(&mut buffer).await.unwrap_or(0) > 0 {
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nsomething").await;
                }
            });
        }
    });
    (port, seen, task)
}

#[test]
fn registrations_are_checked_kept_and_an_agents_retry_is_the_same_one() {
    let lab = lab();
    let store = &lab.ws.store;
    let user = json!({"kind":"user"});
    for (bad, why) in [
        (new("", LOCAL, 8000), "name"),
        (new("dev", LOCAL, 0), "port"),
        (NewService { path: "lab".into(), ..new("dev", LOCAL, 8000) }, "path"),
        (NewService { path: "//other.example/x".into(), ..new("dev", LOCAL, 8000) }, "path"),
        (NewService { path: "/a b".into(), ..new("dev", LOCAL, 8000) }, "path"),
        (new("dev", "windows", 8000), "Windows"),
        (new("dev", "nowhere", 8000), "not registered"),
    ] {
        let error = store.register_service(&lab.project, &bad, user.clone(), None).unwrap_err().to_string();
        assert!(error.contains(why), "{why}: {error}");
    }
    assert!(store.register_service("no-project", &new("dev", LOCAL, 8000), user.clone(), None).is_err());
    let first = store.register_service(&lab.project, &new("vite", "m1", 5173), user.clone(), None).unwrap();
    let error = store.register_service(&lab.project, &new("again", "m1", 5173), user.clone(), None).unwrap_err().to_string();
    assert!(error.contains("already has that service"), "{error}");
    let agent = json!({"kind":"agent","id":"a","name":"A"});
    let made = store.register_service(&lab.project, &new("lab", "m1", 8888), agent.clone(), Some("r1")).unwrap();
    assert_eq!(store.register_service(&lab.project, &new("lab", "m1", 8888), agent.clone(), Some("r1")).unwrap(), made);
    let error = store.register_service(&lab.project, &new("lab", "m1", 8889), agent, Some("r1")).unwrap_err().to_string();
    assert!(error.contains("idempotency_conflict"), "{error}");
    assert_eq!(store.services(&lab.project).unwrap(), vec![first.clone(), made]);
    store.delete_service(&first.id).unwrap();
    assert_eq!(store.services(&lab.project).unwrap().len(), 1);
}

#[tokio::test]
async fn a_local_service_is_available_only_once_it_answers_http() {
    let lab = lab();
    let (port, running) = service(false).await;
    let id = register(&lab, LOCAL, port).await;
    let reached = open(&lab, &id).await;
    assert_eq!((reached["state"].clone(), reached["httpStatus"].clone()), (json!("available"), json!(200)), "{reached}");
    // Core's own port of the range, relayed to the service's.
    let local = reached["localPort"].as_u64().unwrap() as u16;
    assert!(lab.ws.services.ports.lock().unwrap().contains(&local) && local != port, "{reached}");
    assert!(answers(local).await, "the relay reaches the service");
    running.abort();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let stopped = open(&lab, &id).await;
    assert_eq!(stopped["state"], "notRunning", "{stopped}");

    let (silent, quiet) = service(true).await;
    let id = register(&lab, LOCAL, silent).await;
    let waiting = open(&lab, &id).await;
    assert_eq!(waiting["state"], "notReady", "{waiting}");
    quiet.abort();

    // A service on this host never names Yuzuno's own ports (Core would relay
    // to itself); another machine's port of the same number is its own.
    let first = *lab.ws.services.ports.lock().unwrap().start();
    let error = lab.ws.register_service(&lab.project, new("loop", LOCAL, first), json!({"kind":"user"}), None).await
        .unwrap_err().to_string();
    assert!(error.contains("Yuzuno's own"), "{error}");
    assert!(lab.ws.register_service(&lab.project, new("remote", "m1", first), json!({"kind":"user"}), None).await.is_ok());
}

#[tokio::test]
async fn only_the_page_that_opened_a_service_can_prove_its_port_reaches_this_core() {
    let lab = lab();
    let (port, seen, running) = counting().await;
    let id = register(&lab, LOCAL, port).await;
    let page = "http://127.0.0.1:4317";
    let opened = lab.ws.open_service(&id, Some(page)).await.unwrap();
    let local = opened["connection"]["localPort"].as_u64().unwrap() as u16;
    let proof = opened["proof"].clone();
    assert!(proof["challenge"].is_string() && proof["answer"].is_string(), "{opened}");
    // Only a request from the page that opened it, and only once.
    assert!(!proves(local, &proof).await, "not without the page's origin");
    assert!(!proves_from(local, &proof, Some("http://127.0.0.1:9999")).await, "not from another origin");
    let (status, body, head) = exchange(local, &format!("/.well-known/yuzuno-service/{}", proof["challenge"].as_str().unwrap()), Some(page)).await;
    assert_eq!((status, body.as_str()), (200, proof["answer"].as_str().unwrap()));
    assert!(head.contains(&format!("Access-Control-Allow-Origin: {page}")) && !head.contains("Access-Control-Allow-Origin: *"), "{head}");
    assert!(!proves_from(local, &proof, Some(page)).await, "answered once only");
    // The listing never shows it; another challenge gets nothing.
    let listed = lab.ws.project_services(&lab.project).await.unwrap().to_string();
    assert!(!listed.contains(proof["answer"].as_str().unwrap()), "{listed}");
    assert_eq!(get(local, "/.well-known/yuzuno-service/guess").await.0, 404);
    let reached = seen.load(std::sync::atomic::Ordering::SeqCst);
    // A request that only starts like it is the service's.
    assert_eq!(get(local, "/.well-known/other").await, (200, "something".into()));
    assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), reached + 1, "only that one reached the service");
    // Something else on the port a client would open (a Mac's own service on
    // the same number) answers 200 too, even with the challenge sent back to
    // it, but cannot answer it.
    let again = lab.ws.open_service(&id, None).await.unwrap();
    let (elsewhere, _, other) = counting().await;
    let (echo, echoes) = echoing().await;
    assert!(!proves(elsewhere, &again["proof"]).await, "an unrelated service does not prove the way");
    assert_eq!(get(echo, &format!("/.well-known/yuzuno-service/{}", again["proof"]["challenge"].as_str().unwrap())).await.1,
        again["proof"]["challenge"].as_str().unwrap(), "the echo sends the challenge back");
    assert!(!proves(echo, &again["proof"]).await, "an echo of the challenge does not prove the way");
    // Opening again made a new pair on the same port; the old one is gone.
    assert_eq!(again["connection"]["localPort"], json!(local));
    assert!(proves(local, &again["proof"]).await);
    // An answer not asked for in time is gone too.
    let late = lab.ws.open_service(&id, None).await.unwrap();
    tokio::time::sleep(PROOF_TTL + Duration::from_millis(200)).await;
    assert!(!proves(local, &late["proof"]).await, "expired");
    // Closing ends it with the listener.
    let last = lab.ws.open_service(&id, None).await.unwrap();
    lab.ws.close_service(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(TcpStream::connect(("127.0.0.1", local)).await.is_err() || !proves(local, &last["proof"]).await);
    running.abort();
    other.abort();
    echoes.abort();
}

#[test]
fn a_core_that_stops_leaves_no_listener_and_no_ssh() {
    // Core's own runtime ends (Core exits, or is stopped) with a service open
    // and a client stream on it: the listener closes and SSH is gone.
    let (dir, _ports, local) = std::thread::spawn(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let found = runtime.block_on(async {
            let lab = lab();
            let (port, running) = service(false).await;
            std::mem::forget(running);
            let id = register(&lab, "m1", port).await;
            let opened = open(&lab, &id).await;
            assert_eq!(opened["state"], "available", "{opened}");
            let local = opened["localPort"].as_u64().unwrap() as u16;
            let mut held = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
            held.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
            std::mem::forget(held);
            // Its block of ports stays held until the end of this test.
            let Lab { _dir, _ports, .. } = lab;
            (_dir, _ports, local)
        });
        runtime.shutdown_timeout(Duration::from_secs(1));
        found
    }).join().unwrap();
    let pid: i32 = std::fs::read_dir(dir.path()).unwrap().flatten()
        .find(|e| e.file_name().to_string_lossy().starts_with("pid-"))
        .map(|e| std::fs::read_to_string(e.path()).unwrap().trim().parse().unwrap())
        .expect("the SSH stand-in ran");
    let gone = || std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_or(true, |stat| stat.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z')));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !gone() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(gone(), "SSH ended with Core");
    assert!(std::net::TcpStream::connect(("127.0.0.1", local)).is_err(), "nothing listens on Core's port");
}

#[tokio::test]
async fn closing_ends_the_connections_core_relays_and_nothing_else() {
    let lab = lab();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    // A service that keeps each connection open, streaming.
    let streaming = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let _ = stream.read(&mut buffer).await;
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n").await;
                while stream.write_all(b"data: tick\n\n").await.is_ok() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            });
        }
    });
    let id = register(&lab, "m1", port).await;
    let local = open(&lab, &id).await["localPort"].as_u64().unwrap() as u16;
    let mut client = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
    client.write_all(b"GET /stream HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    let mut buffer = [0u8; 256];
    assert!(client.read(&mut buffer).await.unwrap() > 0, "the stream flows");
    lab.ws.close_service(&id).await.unwrap();
    let ended = timeout(Duration::from_secs(5), async {
        loop {
            match client.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    }).await;
    assert!(ended.is_ok(), "closing ends the client's stream too");
    assert!(answers(port).await, "the service keeps running");
    assert!(TcpStream::connect(("127.0.0.1", local)).await.is_err(), "nothing listens for it any more");
    streaming.abort();
}

#[tokio::test]
async fn an_ssh_service_is_forwarded_checked_and_closed_without_touching_the_service() {
    let lab = lab();
    let (port, running) = service(false).await;
    let id = register(&lab, "m1", port).await;
    let reached = open(&lab, &id).await;
    assert_eq!(reached["state"], "available", "{reached}");
    // The service's own port is taken here (by the service itself), so the
    // forward listens on another one.
    let local = reached["localPort"].as_u64().unwrap() as u16;
    assert_ne!(local, port);
    assert!(answers(local).await, "the forward reaches the service");
    // Opening again checks the same forward instead of starting another.
    assert_eq!(open(&lab, &id).await["localPort"], json!(local));
    // A second service's forward is its own and outlives the first one's close.
    let (other_port, other) = service(false).await;
    let other_id = register(&lab, "m1", other_port).await;
    let other_local = open(&lab, &other_id).await["localPort"].as_u64().unwrap() as u16;
    let closed = lab.ws.close_service(&id).await.unwrap()["connection"].clone();
    assert_eq!(closed["state"], "closed", "{closed}");
    assert!(unheard(local).await, "the forward ended");
    assert!(answers(port).await, "the service itself is untouched");
    assert!(answers(other_local).await, "the other forward is untouched");
    lab.ws.close_service(&other_id).await.unwrap();
    running.abort();
    other.abort();
}

#[tokio::test]
async fn a_forward_says_why_it_cannot_reach_a_service() {
    let lab = lab();
    let missing = unused_port().await;
    let id = register(&lab, "m1", missing).await;
    let refused = open(&lab, &id).await;
    assert_eq!(refused["state"], "notRunning", "{refused}");
    assert!(refused["reason"].as_str().unwrap().contains("open failed"), "{refused}");
    assert!(refused["localPort"].is_u64(), "the forward stays open to check again: {refused}");
    lab.ws.close_service(&id).await.unwrap();

    let (port, running) = service(false).await;
    for (machine, state, words) in [
        ("down", "machineUnreachable", "Connection refused"),
        ("busy", "portInUse", "cannot listen"),
    ] {
        let id = register(&lab, machine, port).await;
        let whole = lab.ws.open_service(&id, None).await.unwrap();
        let failed = whole["connection"].clone();
        assert_eq!(failed["state"], state, "{machine}: {failed}");
        assert!(failed["reason"].as_str().unwrap().contains(words) || failed["reason"].as_str().unwrap().contains("Could not"),
            "{machine}: {failed}");
        assert!(failed["localPort"].is_null() && whole["proof"].is_null(), "nothing listens for it: {whole}");
    }

    // Start-up files may print before the remote command says it runs.
    let id = register(&lab, "chatty", port).await;
    assert_eq!(open(&lab, &id).await["state"], "available");
    lab.ws.close_service(&id).await.unwrap();

    let id = register(&lab, "short", port).await;
    assert_eq!(open(&lab, &id).await["state"], "available");
    let deadline = Instant::now() + Duration::from_secs(10);
    let gone = loop {
        let now = lab.ws.project_services(&lab.project).await.unwrap()["services"].as_array().unwrap().iter()
            .find(|s| s["id"] == id.as_str()).unwrap()["connection"].clone();
        if now["state"] == "disconnected" || Instant::now() >= deadline {
            break now;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(gone["state"], "disconnected", "{gone}");
    assert!(gone["reason"].as_str().unwrap().contains("closed by remote host"), "{gone}");
    // Reopening after a disconnect starts a new forward.
    assert_eq!(open(&lab, &id).await["state"], "available");
    lab.ws.delete_service(&id).await.unwrap();
    assert!(answers(port).await, "deleting the registration leaves the service running");
    running.abort();
}

#[tokio::test]
async fn agents_register_and_list_in_their_project_but_never_open() {
    let lab = lab();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":"/tmp","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    lab.ws.store.insert(&agent).unwrap();
    lab.ws.store.set_agent_project("a", Some(&lab.project)).unwrap();
    let input = json!({"requestId":"r1","name":"Jupyter","machineId":"m1","port":8888,"path":"/lab"});
    let made = call(lab.ws.clone(), Some("a".into()), REGISTER.into(), input.clone()).await.unwrap();
    assert_eq!((made["author"].clone(), made["connection"]["state"].clone()),
        (json!({"kind":"agent","id":"a","name":"Mori"}), json!("closed")));
    let again = call(lab.ws.clone(), Some("a".into()), REGISTER.into(), input).await.unwrap();
    assert_eq!(again["id"], made["id"]);
    let listed = call(lab.ws.clone(), Some("a".into()), LIST.into(), json!({})).await.unwrap();
    assert_eq!(listed["services"].as_array().unwrap().len(), 1);
    assert!(call(lab.ws.clone(), None, REGISTER.into(), json!({"requestId":"u","projectId":lab.project,"name":"x","machineId":"m1","port":1}))
        .await.unwrap_err().to_string().contains("agent_only"));
    let names: Vec<_> = tool_definitions().iter().map(|t| t["name"].clone()).collect();
    assert_eq!(names, vec![json!(LIST), json!(REGISTER)], "no tool opens, closes or deletes");
}

#[tokio::test]
async fn deleting_a_project_ends_what_is_open_for_its_services_and_only_then() {
    let lab = lab();
    let (port, running) = service(false).await;
    let id = register(&lab, "m1", port).await;
    let local = open(&lab, &id).await["localPort"].as_u64().unwrap() as u16;
    // A project an Agent still belongs to is not deleted: its service stays open.
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":"/tmp","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    lab.ws.store.insert(&agent).unwrap();
    lab.ws.store.set_agent_project("a", Some(&lab.project)).unwrap();
    assert!(lab.ws.delete_project(&lab.project).await.is_err());
    assert!(answers(local).await, "still open");
    // Once it is deleted, its service's listener and SSH end with it.
    lab.ws.store.set_agent_project("a", None).unwrap();
    lab.ws.delete_project(&lab.project).await.unwrap();
    assert!(unheard(local).await, "nothing listens for it");
    assert!(lab.ws.services.open.lock().unwrap().is_empty() && lab.ws.services.assigned.lock().unwrap().is_empty());
    assert!(answers(port).await, "the service itself keeps running");
    running.abort();
}

#[test]
fn framing_is_read_from_the_answer_as_a_browser_would() {
    let head = |headers: &str| format!("HTTP/1.1 200 OK\r\n{headers}Content-Length: 0");
    assert_eq!(framing(&head("")), Framing::Allowed);
    assert_eq!(framing(&head("X-Frame-Options: DENY\r\n")), Framing::Blocked);
    assert_eq!(framing(&head("x-frame-options: SAMEORIGIN\r\n")), Framing::Blocked);
    assert_eq!(framing(&head("Content-Security-Policy: default-src 'self'; frame-ancestors 'self'\r\n")), Framing::Blocked);
    assert_eq!(framing(&head("Content-Security-Policy: frame-ancestors 'none'\r\n")), Framing::Blocked);
    assert_eq!(framing(&head("Content-Security-Policy: frame-ancestors http://localhost:4317\r\n")), Framing::Restricted);
    // A CSP frame-ancestors decides over X-Frame-Options; a report-only one decides nothing.
    assert_eq!(framing(&head("X-Frame-Options: DENY\r\nContent-Security-Policy: frame-ancestors *\r\n")), Framing::Allowed);
    assert_eq!(framing(&head("Content-Security-Policy-Report-Only: frame-ancestors 'none'\r\n")), Framing::Allowed);
}

/// An HTTP service on this host's loopback answering every request with 200
/// and the given header lines.
async fn service_with(headers: &'static str) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let _ = stream.read(&mut buffer).await;
                let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\n{headers}Content-Length: 2\r\nConnection: close\r\n\r\nok").as_bytes()).await;
            });
        }
    });
    (port, task)
}

#[tokio::test]
async fn an_open_service_says_whether_its_page_may_be_framed_and_passes_its_headers_on() {
    let lab = lab();
    let (plain, _a) = service_with("").await;
    let (denies, _b) = service_with("X-Frame-Options: DENY\r\n").await;
    let plain = register(&lab, LOCAL, plain).await;
    let denies = register(&lab, LOCAL, denies).await;
    assert_eq!(open(&lab, &plain).await["framing"], "allowed");
    let connection = open(&lab, &denies).await;
    assert_eq!((connection["state"].as_str(), connection["framing"].as_str()), (Some("available"), Some("blocked")));
    // The relay leaves the header as the service sent it.
    let port = connection["localPort"].as_u64().unwrap() as u16;
    let (status, _, head) = exchange(port, "/", None).await;
    assert_eq!(status, 200);
    assert!(head.contains("X-Frame-Options: DENY"), "{head}");
}
