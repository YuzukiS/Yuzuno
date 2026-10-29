use super::*;
use std::io::{Read, Write};

#[test]
fn only_listening_sockets_that_take_a_loopback_connection_on_the_port_count() {
    let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0
   1: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 20 4 30 10 -1
   3: 0101A8C0:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0000000000000000 100 0 0 10 0
   4: 0100007F:1436 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0000000000000000 100 0 0 10 0";
    // 127.0.0.1 and 0.0.0.0 listening on 0x1435; not the connection, not 192.168.1.1, not another port.
    assert_eq!(parse_listeners(tcp, 0x1435), vec![(Bound::Loopback, 111), (Bound::AnyV4, 222)]);
    let tcp6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 666 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 888 1 0000000000000000 100 0 0 10 0";
    // :: and ::ffff:127.0.0.1 may take 127.0.0.1; ::1 never does.
    assert_eq!(parse_listeners(tcp6, 0x1435), vec![(Bound::AnyV6, 666), (Bound::MappedLoopback, 888)]);
}

#[test]
fn a_connection_to_127_0_0_1_reaches_the_most_specific_ipv4_listener_first() {
    // No connection is made while an IPv4 listener decides it (port 9 is never asked).
    let all = [(Bound::AnyV6, 1), (Bound::AnyV4, 2), (Bound::Loopback, 3)];
    assert_eq!(reached(&all, 9), Some(HashSet::from([3])));
    assert_eq!(reached(&all[..2], 9), Some(HashSet::from([2])), "a :: beside 0.0.0.0 is IPv6-only or loses to it");
    assert_eq!(reached(&[(Bound::AnyV6, 1), (Bound::MappedLoopback, 4)], 9), Some(HashSet::from([4])));
    assert_eq!(reached(&[], 9), Some(HashSet::new()));
}

/// An IPv6-only (IPV6_V6ONLY) socket listening on [::]:port; None where this
/// host has no IPv6.
fn v6only_listener(port: u16) -> Option<std::net::TcpListener> {
    use std::os::fd::FromRawFd;
    // SAFETY: plain socket calls on a descriptor this function owns until
    // the TcpListener takes it.
    unsafe {
        let fd = libc::socket(libc::AF_INET6, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return None;
        }
        let one: libc::c_int = 1;
        let size = std::mem::size_of_val(&one) as libc::socklen_t;
        assert_eq!(libc::setsockopt(fd, libc::IPPROTO_IPV6, libc::IPV6_V6ONLY, &one as *const _ as *const libc::c_void, size), 0);
        let mut address: libc::sockaddr_in6 = std::mem::zeroed();
        address.sin6_family = libc::AF_INET6 as libc::sa_family_t;
        address.sin6_port = port.to_be();
        let length = std::mem::size_of_val(&address) as libc::socklen_t;
        let bound = libc::bind(fd, &address as *const _ as *const libc::sockaddr, length);
        assert_eq!(bound, 0, "bind [::]:{port}: {}", std::io::Error::last_os_error());
        assert_eq!(libc::listen(fd, 8), 0);
        Some(std::net::TcpListener::from_raw_fd(fd))
    }
}

/// This test process's own cgroup (v2) and boot, to stand for a Job.
fn own_group() -> Option<(String, String)> {
    let group = std::fs::read_to_string("/proc/self/cgroup").ok()?.lines().find_map(|l| l.strip_prefix("0::").map(str::to_owned))?;
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?.trim().to_owned();
    Some((group, boot))
}

#[test]
fn an_ipv6_only_wildcard_never_counts_for_127_0_0_1() {
    let Some((group, boot)) = own_group() else {
        eprintln!("no cgroup v2 here: the ownership check is not exercised");
        return;
    };
    let data = tempfile::tempdir().unwrap();
    let job = started(data.path(), &group, &boot);
    // The Job serves 127.0.0.1; an IPv6-only :: on the same port (anyone's)
    // takes no IPv4 connection, so it can't make the Job's listener another's.
    let v4 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = v4.local_addr().unwrap().port();
    let Some(v6) = v6only_listener(port) else {
        eprintln!("no IPv6 here: the IPv6-only case is not exercised");
        return;
    };
    let all = listening(port).unwrap();
    assert_eq!(all.len(), 2, "{all:?}");
    let ipv4: HashSet<u64> = all.iter().filter(|(b, _)| *b == Bound::Loopback).map(|(_, i)| *i).collect();
    assert_eq!(reached(&all, port), Some(ipv4));
    assert_eq!(owner(data.path(), &job, port), Owner::Verified);
    // Alone, the IPv6-only :: is not listening for 127.0.0.1, even when the
    // Job holds it.
    drop(v4);
    assert_eq!(reached(&listening(port).unwrap(), port), Some(HashSet::new()));
    assert_eq!(owner(data.path(), &job, port), Owner::NotListening);
    drop(v6);
    // A dual-stack :: does take 127.0.0.1: one connection tells.
    if std::fs::read_to_string("/proc/sys/net/ipv6/bindv6only").map(|v| v.trim() == "0").unwrap_or(false) {
        let dual = std::net::TcpListener::bind("[::]:0").unwrap();
        let port = dual.local_addr().unwrap().port();
        assert_eq!(owner(data.path(), &job, port), Owner::Verified);
    }
}

/// A Job folder whose start record names `group` on `boot`.
fn started(data: &Path, group: &str, boot: &str) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    let folder = data.join("jobs").join(&id);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("started.json"), json!({"jobId":id,"controlGroup":group,"bootId":boot}).to_string()).unwrap();
    json!({"id": id, "status": "running"})
}

#[test]
fn a_listener_is_the_jobs_only_if_a_process_of_its_control_group_holds_it() {
    let data = tempfile::tempdir().unwrap();
    // This test process stands for the Job: its own cgroup (v2) holds the listener.
    let Some(group) = std::fs::read_to_string("/proc/self/cgroup").unwrap().lines()
        .find_map(|l| l.strip_prefix("0::").map(str::to_owned))
    else {
        eprintln!("no cgroup v2 here: the ownership check is not exercised");
        return;
    };
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim().to_owned();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let ours = started(data.path(), &group, &boot);
    assert_eq!(owner(data.path(), &ours, port), Owner::Verified);
    // The same listener, as another Job's group sees it: someone else's.
    let elsewhere = started(data.path(), "/yuzuno-test-no-such-group", &boot);
    assert_eq!(owner(data.path(), &elsewhere, port), Owner::OtherProcess);
    // A start record from another boot: its processes ended with that boot.
    let earlier_boot = started(data.path(), &group, "an-earlier-boot");
    assert_eq!(owner(data.path(), &earlier_boot, port), Owner::OtherProcess);
    // A Job that has ended holds nothing, whatever its record says.
    let mut ended = ours.clone();
    ended["status"] = json!("succeeded");
    assert_eq!(owner(data.path(), &ended, port), Owner::OtherProcess);
    // Running, but no start record yet: not known.
    let unrecorded = json!({"id": uuid::Uuid::new_v4().to_string(), "status": "running"});
    assert_eq!(owner(data.path(), &unrecorded, port), Owner::Unknown);
    drop(listener);
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert_eq!(owner(data.path(), &ours, free), Owner::NotListening);
}

/// An HTTP server that answers every request with `status`, once per
/// connection, its status line in two pieces a moment apart: TCP keeps no
/// write boundaries, and a check must read the whole line.
fn answering(status: &'static str) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_nodelay(true);
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(b"HTTP/1.1 ");
            std::thread::sleep(Duration::from_millis(50));
            let rest = format!("{status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(rest.as_bytes());
        }
    });
    port
}

#[tokio::test]
async fn health_is_an_http_2xx_on_the_declared_path_and_anything_else_is_failing() {
    let ok = check_health(answering("204 No Content"), "/health").await;
    assert_eq!((ok["state"].as_str(), ok["httpStatus"].as_u64(), ok["declared"].as_bool()), (Some("ok"), Some(204), Some(true)));
    assert_eq!(ok["path"], "/health");
    assert!(ok["checkedAt"].is_string());
    let failing = check_health(answering("500 Internal Server Error"), "/health").await;
    assert_eq!((failing["state"].as_str(), failing["httpStatus"].as_u64()), (Some("failing"), Some(500)));
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let refused = check_health(free, "/health").await;
    assert_eq!(refused["state"], "failing");
    assert!(refused["reason"].is_string(), "{refused}");
    // A status line begun and never ended is not an answer.
    let stalled = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = stalled.local_addr().unwrap().port();
    let held = std::thread::spawn(move || {
        let (mut stream, _) = stalled.accept().unwrap();
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        let _ = stream.write_all(b"HTTP/1.1 20");
        std::thread::sleep(Duration::from_secs(3));
    });
    let partial = check_health(port, "/health").await;
    assert_eq!(partial["state"], "failing", "{partial}");
    assert!(partial["reason"].as_str().unwrap().contains("no complete HTTP status line"), "{partial}");
    held.join().unwrap();
}

#[tokio::test]
async fn the_list_never_waits_for_a_health_path() {
    // Accepts connections (the backlog) and never answers one.
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = silent.local_addr().unwrap().port();
    let begun = Instant::now();
    let first = health("job-silent", port, "/health").await;
    assert!(begun.elapsed() < Duration::from_millis(500), "waited {:?}", begun.elapsed());
    assert_eq!((first["state"].as_str(), first["reason"].as_str()), (Some("unknown"), Some("checking")));
    // While that check runs, another look starts none and does not wait either.
    let again = health("job-silent", port, "/health").await;
    assert_eq!(again["reason"], "checking");
    assert!(begun.elapsed() < Duration::from_millis(500));
    // Once it has ended, the list shows its result, kept with its time.
    let mut done = Value::Null;
    for _ in 0..40 {
        done = health("job-silent", port, "/health").await;
        if done["state"] != "unknown" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(done["state"], "failing", "{done}");
    assert!(done["checkedAt"].is_string());
    // A healthy path the same way: checking first, then ok.
    let ok = answering("200 OK");
    assert_eq!(health("job-healthy", ok, "/").await["reason"], "checking");
    for _ in 0..40 {
        done = health("job-healthy", ok, "/").await;
        if done["state"] != "unknown" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!((done["state"].as_str(), done["httpStatus"].as_u64()), (Some("ok"), Some(200)), "{done}");
    drop(silent);
}

#[test]
fn a_declaration_names_an_existing_service_or_a_new_one_on_this_host() {
    let declared = |v: Value| serde_json::from_value::<Declared>(v).unwrap().validate().map_err(|e| e.to_string());
    assert!(declared(json!({"serviceId":"s"})).is_ok());
    assert!(declared(json!({"name":"Vite","port":5173,"path":"/app","healthPath":"/health"})).is_ok());
    assert!(declared(json!({"serviceId":"s","name":"Vite"})).unwrap_err().contains("not both"));
    assert!(declared(json!({"port":5173})).unwrap_err().contains("name and port"));
    assert!(declared(json!({"serviceId":""})).unwrap_err().contains("1–128"));
    assert!(declared(json!({"serviceId":"s","healthPath":"/a b"})).unwrap_err().contains("healthPath"));
}
