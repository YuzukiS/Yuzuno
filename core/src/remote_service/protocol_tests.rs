//! What Core accepts from a remote session and how an exit is classified
//! (YN-83 S1 PR4a, design v4 A2 and A3): pure functions, no processes.

use super::link::age_at;
use super::protocol::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const NONCE: &str = "0123456789abcdef0123456789abcdef";
const DIGEST: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn bytes(value: &Value) -> Vec<u8> {
    value.to_string().into_bytes()
}

fn hello_data() -> Value {
    json!({
        "protocol": 1, "version": DIGEST, "sessionId": "ab".repeat(16),
        "hostId": "cd".repeat(16), "bootId": "6f1c2a1e-6c3b-4b39-9a51-2f8f6f8a1d0e", "accountKey": "ef".repeat(16),
        "platform": "Linux", "python": "3.12.4",
        "load": {"cpu": "proc-stat", "memory": "meminfo", "disk": "statvfs", "gpu": null, "why": ["gpu:not_enabled"]},
    })
}

type Change = Box<dyn Fn(&mut Value)>;

fn change(f: impl Fn(&mut Value) + 'static) -> Change {
    Box::new(f)
}

fn hello_with(change: impl FnOnce(&mut Value)) -> Result<Hello, Code> {
    let mut data = hello_data();
    change(&mut data);
    hello(&bytes(&json!({"ev": "hello", "data": data})), DIGEST)
}

#[test]
fn boot_lines_count_only_with_this_nonce() {
    let marked = |nonce: &str, body: &str| format!("{MARK}{nonce} {body}").into_bytes();
    assert_eq!(boot_line(&marked(NONCE, r#"{"need":true}"#), NONCE), BootLine::Need);
    assert_eq!(boot_line(&marked(NONCE, r#"{"ready":true}"#), NONCE), BootLine::Ready);
    assert_eq!(boot_line(&marked(NONCE, r#"{"error":{"code":"root_unsafe","msg":"/home/someone"}}"#), NONCE), BootLine::Refused(Code::RootUnsafe));
    assert_eq!(boot_line(&marked(NONCE, r#"{"error":{"code":"timeout","msg":""}}"#), NONCE), BootLine::Refused(Code::BootTimeout));
    assert_eq!(boot_line(&marked(NONCE, r#"{"error":{"code":"something new"}}"#), NONCE), BootLine::Refused(Code::BootError));
    // Another nonce, no nonce, an unmarked line: noise, never a boot line.
    assert_eq!(boot_line(&marked("ffffffffffffffffffffffffffffffff", r#"{"ready":true}"#), NONCE), BootLine::Noise);
    assert_eq!(boot_line(br#"YUZUNO-REMOTE {"ready":true}"#, NONCE), BootLine::Noise);
    assert_eq!(boot_line(format!("{MARK}{NONCE}{{\"ready\":true}}").as_bytes(), NONCE), BootLine::Noise);
    assert_eq!(boot_line(b"Last login: Mon Nov  9 10:00:00 2026", NONCE), BootLine::Noise);
    // Marked, but not what the boot step writes.
    for body in [r#"{"need":false}"#, r#"{"ready":1}"#, "[true]", "{not json", r#"{"error":"text"}"#] {
        assert_eq!(boot_line(&marked(NONCE, body), NONCE), BootLine::Invalid, "{body}");
    }
}

#[test]
fn hello_needs_this_protocol_and_digest_and_checked_fields() {
    let checked = hello_with(|_| {}).unwrap();
    assert_eq!(checked.session_id, "ab".repeat(16));
    assert_eq!((checked.platform, checked.cpu, checked.memory), (Platform::Linux, Some(CpuSource::ProcStat), Some(MemorySource::Meminfo)));
    assert_eq!(checked.why, vec!["gpu:not_enabled".to_owned()]);
    // Unknown fields are ignored; nulls stay unknown.
    let darwin = hello_with(|data| {
        data["extra"] = json!({"anything": [1, 2]});
        data["hostId"] = Value::Null;
        data["bootId"] = Value::Null;
        data["accountKey"] = Value::Null;
        data["platform"] = json!("Darwin");
        data["load"]["cpu"] = json!("mach");
        data["load"]["memory"] = json!("darwin-free+inactive");
    })
    .unwrap();
    assert_eq!((darwin.host_id, darwin.boot_id, darwin.account_key), (None, None, None));
    assert_eq!(darwin.memory, Some(MemorySource::DarwinFreeInactive));
    assert_eq!(hello_with(|data| data["load"]["cpu"] = Value::Null).unwrap().cpu, None);
    // Another protocol or another program: version.
    assert_eq!(hello_with(|data| data["protocol"] = json!(2)), Err(Code::Version));
    assert_eq!(hello_with(|data| data["version"] = json!("2".repeat(64))), Err(Code::Version));
    assert_eq!(hello_with(|data| { data.as_object_mut().unwrap().remove("version"); }), Err(Code::Version));
    // Every other field out of shape: protocol.
    let wrong: Vec<(&str, Change)> = vec![
        ("sessionId short", change(|data| data["sessionId"] = json!("ab"))),
        ("sessionId upper", change(|data| data["sessionId"] = json!("AB".repeat(16)))),
        ("hostId 31", change(|data| data["hostId"] = json!("c".repeat(31)))),
        ("accountKey number", change(|data| data["accountKey"] = json!(5))),
        ("bootId 65", change(|data| data["bootId"] = json!("b".repeat(65)))),
        ("bootId control", change(|data| data["bootId"] = json!("boot\u{1b}[2J"))),
        ("bootId empty", change(|data| data["bootId"] = json!(""))),
        ("platform", change(|data| data["platform"] = json!("Windows"))),
        ("python 2", change(|data| data["python"] = json!("2.7.18"))),
        ("python short", change(|data| data["python"] = json!("3.12"))),
        ("python text", change(|data| data["python"] = json!("3.12.4rc1"))),
        ("cpu source", change(|data| data["load"]["cpu"] = json!("perf"))),
        ("disk source", change(|data| data["load"]["disk"] = Value::Null)),
        ("why", change(|data| data["load"]["why"] = json!(["Not A Token"]))),
        ("load", change(|data| data["load"] = json!("statvfs"))),
    ];
    for (label, change) in wrong {
        assert_eq!(hello_with(|data| change(data)), Err(Code::Protocol), "{label}");
    }
    // Not a hello frame at all.
    assert_eq!(hello(&bytes(&json!({"ev": "load", "data": hello_data()})), DIGEST), Err(Code::Protocol));
    assert_eq!(hello(b"YUZUNO-REMOTE x {}", DIGEST), Err(Code::Protocol));
}

fn load_frame(change: impl FnOnce(&mut Value)) -> Result<Frame, Code> {
    let mut data = json!({
        "cpu": {"pct": 32.5, "windowMs": 2001, "cores": 2, "ageMs": 120},
        "memory": {"totalMiB": 15876.3, "usedMiB": 4096.0, "availableMiB": 11780.3, "measure": "meminfo", "ageMs": 80},
        "disks": [{"roles": ["root"], "totalMiB": 1000.0, "availableMiB": 250.5, "ageMs": 3000}],
        "gpu": null,
        "why": ["gpu:not_enabled"],
    });
    change(&mut data);
    frame(&bytes(&json!({"ev": "load", "data": data})))
}

fn load_of(result: Result<Frame, Code>) -> Load {
    match result {
        Ok(Frame::Load(load)) => load,
        other => panic!("not a load: {other:?}"),
    }
}

#[test]
fn load_values_are_clipped_and_unknown_stays_unknown() {
    let load = load_of(load_frame(|_| {}));
    let cpu = load.cpu.unwrap();
    assert_eq!((cpu.pct, cpu.cores, cpu.window_ms, cpu.age), (32.5, Some(2), 2001, Duration::from_millis(120)));
    let memory = load.memory.unwrap();
    assert_eq!((memory.total_mib, memory.available_mib, memory.measure), (15876.3, 11780.3, MemorySource::Meminfo));
    assert_eq!(load.disks[0].roles, vec![Role::Root]);
    assert_eq!(load.disks[0].space, Space::Known { total_mib: 1000.0, available_mib: 250.5, age: Duration::from_secs(3) });
    // Out of range: clipped.
    let clipped = load_of(load_frame(|data| {
        data["cpu"]["pct"] = json!(250.0);
        data["cpu"]["cores"] = json!(0);
        data["cpu"]["ageMs"] = json!(-5);
        data["memory"]["usedMiB"] = json!(1e12);
        data["memory"]["availableMiB"] = json!(-1.0);
        data["disks"][0]["availableMiB"] = json!(5000.0);
        data["disks"][0]["ageMs"] = json!(1e15);
    }));
    let cpu = clipped.cpu.unwrap();
    assert_eq!((cpu.pct, cpu.cores, cpu.age), (100.0, Some(1), Duration::ZERO));
    let memory = clipped.memory.unwrap();
    assert_eq!((memory.used_mib, memory.available_mib), (15876.3, 0.0));
    assert_eq!(clipped.disks[0].space, Space::Known { total_mib: 1000.0, available_mib: 1000.0, age: Duration::from_secs(3600) });
    // Not sent, or null: unknown, never 0.
    let unknown = load_of(load_frame(|data| {
        data["cpu"] = Value::Null;
        data.as_object_mut().unwrap().remove("memory");
        data["disks"] = json!([{"roles": ["root"], "error": "unanswered", "permanent": false}]);
    }));
    assert_eq!((unknown.cpu, unknown.memory), (None, None));
    assert_eq!(unknown.disks[0].space, Space::Error { code: "unanswered".into(), permanent: false });
    assert_eq!(load_of(load_frame(|data| data["cpu"]["cores"] = Value::Null)).cpu.unwrap().cores, None);
    // Unknown fields are ignored.
    assert!(load_of(load_frame(|data| data["cpu"]["steal"] = json!("x"))).cpu.is_some());
    // A known field missing or of the wrong type: protocol.
    let wrong: Vec<(&str, Change)> = vec![
        ("pct missing", change(|data| { data["cpu"].as_object_mut().unwrap().remove("pct"); })),
        ("pct text", change(|data| data["cpu"]["pct"] = json!("32"))),
        ("age missing", change(|data| { data["memory"].as_object_mut().unwrap().remove("ageMs"); })),
        ("measure", change(|data| data["memory"]["measure"] = json!("free"))),
        ("cpu text", change(|data| data["cpu"] = json!("busy"))),
        ("no disks", change(|data| data["disks"] = json!([]))),
        ("five disks", change(|data| data["disks"] = Value::Array(vec![data["disks"][0].clone(); 5]))),
        ("role", change(|data| data["disks"][0]["roles"] = json!(["/home/someone"]))),
        ("no roles", change(|data| { data["disks"][0].as_object_mut().unwrap().remove("roles"); })),
        ("error code", change(|data| data["disks"] = json!([{"roles": ["root"], "error": "No such file: /x", "permanent": true}]))),
        ("permanent", change(|data| data["disks"] = json!([{"roles": ["root"], "error": "io"}]))),
        ("why", change(|data| data["why"] = json!("gpu:not_enabled"))),
        ("why long", change(|data| data["why"] = json!(["a".repeat(65)]))),
        ("why many", change(|data| data["why"] = Value::from(vec!["a"; 33]))),
    ];
    for (label, change) in wrong {
        assert_eq!(load_frame(|data| change(data)), Err(Code::Protocol), "{label}");
    }
}

#[test]
fn frames_after_the_hello() {
    assert_eq!(frame(br#"{"re":3,"ok":{}}"#), Ok(Frame::Reply));
    assert_eq!(frame(br#"{"re":4,"err":{"code":"unknown_op"}}"#), Ok(Frame::Reply));
    assert_eq!(frame(br#"{"ev":"later","data":{}}"#), Ok(Frame::Other));
    assert_eq!(
        frame(br#"{"ev":"bye","data":{"code":0,"clean":false,"why":["read_pending","child_stuck"]}}"#),
        Ok(Frame::Bye(Bye { code: 0, clean: false, why: vec!["read_pending".into(), "child_stuck".into()] }))
    );
    for line in [
        &br#"{"ev":"hello","data":{}}"#[..],
        br#"{"ev":5}"#,
        br#"{"re":"3","ok":{}}"#,
        br#"{"re":-1,"ok":{}}"#,
        br#"{"re":3}"#,
        br#"{"re":3,"ok":{},"err":{}}"#,
        br#"{"re":3,"ok":true}"#,
        br#"{"ev":"bye","data":{"code":256,"clean":true}}"#,
        br#"{"ev":"bye","data":{"code":0,"clean":"yes"}}"#,
        br#"{"something":1}"#,
        b"[1]",
        b"not json",
        b"",
    ] {
        assert_eq!(frame(line), Err(Code::Protocol), "{}", String::from_utf8_lossy(line));
    }
}

fn stderr(text: &str) -> Stderr {
    Stderr { head: text.as_bytes().to_vec(), truncated: false, complete: true }
}

#[test]
fn only_whole_connect_or_dns_failure_lines_may_back_off() {
    for text in [
        "ssh: connect to host box-a port 22: Connection refused\n",
        "ssh: connect to host 192.0.2.10 port 2222: Connection timed out\r\n",
        "ssh: connect to host box-a port 22: Operation timed out\n",
        "ssh: connect to host ::1 port 22: No route to host\n",
        "ssh: connect to host box-a port 22: Network is unreachable\n",
        "ssh: connect to host box-a port 22: Host is down",
        "ssh: Could not resolve hostname box-a.invalid: Name or service not known\n",
        "ssh: Could not resolve hostname box-a: Temporary failure in name resolution\n",
        "ssh: Could not resolve hostname box-a: No address associated with hostname\n",
        "ssh: Could not resolve hostname box-a: nodename nor servname provided, or not known\n",
        "\nssh: connect to host box-a port 22: Connection refused\n\nssh: connect to host box-a port 22: Connection refused\n",
    ] {
        assert!(connect_failure_only(&stderr(text)), "{text:?}");
    }
    for text in [
        "",
        "\n\n",
        "kex_exchange_identification: read: Connection reset by peer\n",
        "Connection closed by 192.0.2.10 port 22\n",
        "Connection reset by peer\n",
        "ssh: connect to host box-a port 22: Connection refused\nkex_exchange_identification: read: Connection reset by peer\n",
        "ssh: connect to host box-a port 22: Connection refused (and more)\n",
        "ssh: connect to host box-a port 22: connection refused\n",
        "ssh: connect to host box a port 22: Connection refused\n",
        "ssh: connect to host box-a port: Connection refused\n",
        "ssh: connect to host box-a port 123456: Connection refused\n",
        "Warning: ssh: connect to host box-a port 22: Connection refused\n",
        "ssh: Could not resolve hostname : Name or service not known\n",
        "ssh: Could not resolve hostname box-a: Unknown error\n",
    ] {
        assert!(!connect_failure_only(&stderr(text)), "{text:?}");
    }
    let refused = "ssh: connect to host box-a port 22: Connection refused\n";
    assert!(!connect_failure_only(&Stderr { truncated: true, ..stderr(refused) }));
    assert!(!connect_failure_only(&Stderr { complete: false, ..stderr(refused) }));
    assert!(!connect_failure_only(&Stderr { head: b"ssh: connect to host \xff port 22: Connection refused\n".to_vec(), truncated: false, complete: true }));
}

fn facts<'a>(exit: Exit, stderr: &'a Stderr) -> Facts<'a> {
    Facts { detected: None, exit, stdout_seen: false, refused: None, bye_clean: false, eof: false, stderr }
}

#[test]
fn exits_follow_the_design_table_in_order() {
    let refused = stderr("ssh: connect to host box-a port 22: Connection refused\n");
    let empty = stderr("");
    // 1 and 2 before the whitelist.
    let auth = stderr("ssh: connect to host box-a port 22: Connection refused\nuser@box-a: Permission denied (publickey).\n");
    assert_eq!(classify(&facts(Exit::Code(255), &auth)), (After::Stop, Some(Code::SshAuth)));
    let many = stderr("Received disconnect from 192.0.2.10 port 22:2: Too many authentication failures\n");
    assert_eq!(classify(&facts(Exit::Code(255), &many)), (After::Stop, Some(Code::SshAuth)));
    let key = stderr("@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n");
    assert_eq!(classify(&facts(Exit::Code(255), &key)), (After::Stop, Some(Code::SshHostKey)));
    // 3: back off only with nothing on stdout.
    assert_eq!(classify(&facts(Exit::Code(255), &refused)), (After::Backoff, Some(Code::SshUnreachable)));
    let seen = Facts { stdout_seen: true, ..facts(Exit::Code(255), &refused) };
    assert_eq!(classify(&seen), (After::Stop, Some(Code::SshFailed)));
    // After ready and the hello the session may be running: the whitelist never backs off.
    let started = Facts { stdout_seen: true, eof: true, ..facts(Exit::Code(255), &refused) };
    assert_eq!(classify(&started), (After::Stop, Some(Code::SshFailed)));
    // 4.
    assert_eq!(classify(&facts(Exit::Code(255), &empty)), (After::Stop, Some(Code::SshFailed)));
    let noise = Stderr { head: vec![b'x'; 8192], truncated: true, complete: true };
    assert_eq!(classify(&facts(Exit::Code(255), &noise)), (After::Stop, Some(Code::SshFailed)));
    // 5: python3 there cannot run the boot step.
    assert_eq!(classify(&facts(Exit::Code(127), &stderr("sh: 1: python3: not found\n"))), (After::Stop, Some(Code::NoPython)));
    assert_eq!(classify(&facts(Exit::Code(126), &empty)), (After::Stop, Some(Code::NoPython)));
    assert_eq!(classify(&facts(Exit::Code(1), &stderr("SyntaxError: invalid syntax\n"))), (After::Stop, Some(Code::PythonTooOld)));
    let xcrun = stderr("xcrun: error: invalid active developer path\n");
    assert_eq!(classify(&facts(Exit::Code(1), &xcrun)), (After::Stop, Some(Code::PythonStandIn)));
    // 6: a marked refusal, only with exit 3.
    let refusal = Facts { refused: Some(Code::RootUnsafe), stdout_seen: true, eof: true, ..facts(Exit::Code(3), &empty) };
    assert_eq!(classify(&refusal), (After::Stop, Some(Code::RootUnsafe)));
    let wrong_exit = Facts { refused: Some(Code::RootUnsafe), ..facts(Exit::Code(0), &empty) };
    assert_eq!(classify(&wrong_exit), (After::Stop, Some(Code::UncleanExit)));
    assert_eq!(classify(&facts(Exit::Code(3), &xcrun)), (After::Stop, Some(Code::UncleanExit)));
    // 7: everything not proven clean.
    for exit in [Exit::Code(0), Exit::Code(1), Exit::Code(6), Exit::Code(137), Exit::Signal, Exit::Unknown] {
        assert_eq!(classify(&facts(exit, &empty)), (After::Stop, Some(Code::UncleanExit)), "{exit:?}");
    }
    // 8: clean needs all three of a clean bye, the end of stdout and exit 0.
    let clean = Facts { bye_clean: true, eof: true, stdout_seen: true, ..facts(Exit::Code(0), &empty) };
    assert_eq!(classify(&clean), (After::Clean, None));
    for (bye_clean, eof, exit) in [(false, true, Exit::Code(0)), (true, false, Exit::Code(0)), (true, true, Exit::Code(1)), (true, true, Exit::Signal), (true, true, Exit::Unknown)] {
        let partial = Facts { bye_clean, eof, stdout_seen: true, ..facts(exit, &empty) };
        assert_eq!(classify(&partial), (After::Stop, Some(Code::UncleanExit)), "{bye_clean} {eof} {exit:?}");
    }
    // What Core found wrong comes first, even with a clean-looking exit.
    for code in [Code::Protocol, Code::Version] {
        let detected = Facts { detected: Some(code), bye_clean: true, eof: true, ..facts(Exit::Code(0), &refused) };
        assert_eq!(classify(&detected), (After::Stop, Some(code)));
    }
}

#[test]
fn ages_use_only_this_cores_clock() {
    let received = Instant::now();
    let later = received + Duration::from_millis(1500);
    assert_eq!(age_at(received, Duration::from_millis(500), later), Duration::from_millis(2000));
    // A reading never gets younger than it was sent, and nothing underflows.
    assert_eq!(age_at(later, Duration::from_millis(500), received), Duration::from_millis(500));
    assert_eq!(age_at(received, Duration::MAX, later), Duration::MAX);
}

#[test]
fn codes_are_stable_strings() {
    let all = [
        Code::SshAuth, Code::SshHostKey, Code::SshUnreachable, Code::SshFailed, Code::NoPython, Code::PythonTooOld,
        Code::PythonStandIn, Code::BadRequest, Code::UnsupportedPlatform, Code::RootUnsafe, Code::UploadShort,
        Code::UploadMismatch, Code::BootTimeout, Code::BootInternal, Code::BootError, Code::Version, Code::Protocol,
        Code::UncleanExit,
    ];
    let names: Vec<&str> = all.iter().map(|code| code.as_str()).collect();
    assert_eq!(names.join(","), "ssh_auth,ssh_host_key,ssh_unreachable,ssh_failed,no_python,python_too_old,python_stand_in,\
bad_request,unsupported_platform,root_unsafe,upload_short,upload_mismatch,boot_timeout,boot_internal,boot_error,version,\
protocol,unclean_exit");
}
