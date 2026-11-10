//! What `/api/machine-live` shows of each machine (YN-83 S1 PR4b; design v4
//! PR4 items 10, 13 and 14): worked out at the moment of the answer, on
//! Core's own clock. Pure: no session, no process, no host file.

use super::link::Stamped;
use super::live::{answer, host_id, host_id_from, Live, Row, CPU_STALE, DISK_STALE};
use super::protocol::{Cpu, CpuSource, Disk, Hello, Load, Memory, MemorySource, Platform, Role, Space};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SILENCE: Duration = Duration::from_secs(30);

fn wall() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-10T12:00:00.000Z").unwrap().with_timezone(&Utc)
}

/// `seconds` before or after the answer's wall time.
fn at(seconds: f64) -> String {
    let delta = chrono::TimeDelta::milliseconds((seconds * 1000.0) as i64);
    (wall() + delta).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn hello(host: Option<&str>, account: Option<&str>, received: Instant) -> Arc<Stamped<Hello>> {
    Arc::new(Stamped {
        value: Hello {
            session_id: "ab".repeat(16),
            host_id: host.map(Into::into),
            boot_id: Some("6f1c2a1e-6c3b-4b39-9a51-2f8f6f8a1d0e".into()),
            account_key: account.map(Into::into),
            platform: Platform::Linux,
            python: "3.12.4".into(),
            cpu: Some(CpuSource::ProcStat),
            memory: Some(MemorySource::Meminfo),
            why: vec![],
        },
        received,
    })
}

/// A load read at `received`, each sample `age` old when it was sent.
fn load(received: Instant, age: Duration, disk_age: Duration) -> Arc<Stamped<Load>> {
    Arc::new(Stamped {
        value: Load {
            cpu: Some(Cpu { pct: 32.5, cores: Some(2), window_ms: 2000, age }),
            memory: Some(Memory { total_mib: 15876.0, used_mib: 8000.0, available_mib: 7876.0, measure: MemorySource::Meminfo, age }),
            disks: vec![Disk { roles: vec![Role::Root], space: Space::Known { total_mib: 1000.0, available_mib: 400.0, age: disk_age } }],
            why: vec![],
        },
        received,
    })
}

fn online(id: &str, hello: Arc<Stamped<Hello>>, load: Option<Arc<Stamped<Load>>>, last_frame: Instant, since: Instant) -> Row {
    Row { id: id.into(), name: format!("{id} name"), live: Live::Online { hello, load, last_frame }, since }
}

fn show(rows: &[Row], local: Option<&str>, now: Instant) -> Vec<Value> {
    answer(rows, local, now, wall(), SILENCE)["machines"].as_array().unwrap().clone()
}

#[test]
fn every_state_says_what_it_is_and_when_it_began() {
    let now = Instant::now() + Duration::from_secs(3600);
    let ago = |seconds: u64| now - Duration::from_secs(seconds);
    let rows = vec![
        Row { id: "a".into(), name: "A".into(), live: Live::Idle, since: ago(5) },
        Row { id: "b".into(), name: "B".into(), live: Live::Connecting, since: ago(2) },
        Row { id: "c".into(), name: "C".into(), live: Live::Offline { retry_at: now + Duration::from_secs(4) }, since: ago(1) },
        Row { id: "d".into(), name: "D".into(), live: Live::Unavailable { code: "ssh_auth" }, since: ago(9) },
        online("e", hello(None, None, ago(20)), Some(load(ago(1), Duration::from_millis(500), Duration::from_secs(2))), ago(1), ago(20)),
    ];
    let shown = show(&rows, None, now);
    let brief: Vec<(&str, &str, Value, &str, Value)> = shown
        .iter()
        .map(|row| (row["id"].as_str().unwrap(), row["state"].as_str().unwrap(), row["code"].clone(), row["since"].as_str().unwrap(), row["retryAt"].clone()))
        .collect();
    assert_eq!(brief, vec![
        ("a", "idle", Value::Null, at(-5.0).as_str(), Value::Null),
        ("b", "connecting", Value::Null, at(-2.0).as_str(), Value::Null),
        ("c", "offline", json!("ssh_unreachable"), at(-1.0).as_str(), json!(at(4.0))),
        ("d", "unavailable", json!("ssh_auth"), at(-9.0).as_str(), Value::Null),
        ("e", "online", Value::Null, at(-20.0).as_str(), Value::Null),
    ]);
    for row in &shown {
        assert_eq!(row["observedAt"], at(0.0), "{row}");
    }
    // Readings only online; the platform only from a session online now.
    assert!(shown[..4].iter().all(|row| row["load"].is_null() && row["platform"].is_null()), "{shown:?}");
    assert_eq!(shown[4]["platform"], "Linux");
    assert_eq!(shown[4]["load"], json!({
        "cpu": {"pct": 32.5, "cores": 2, "observedAt": at(-1.5)},
        "memory": {"totalMiB": 15876.0, "usedMiB": 8000.0, "availableMiB": 7876.0, "estimate": false, "observedAt": at(-1.5)},
        "disks": [{"roles": ["root"], "totalMiB": 1000.0, "availableMiB": 400.0, "observedAt": at(-3.0), "error": null, "permanent": null}],
        "gpu": {"state": "off", "code": "not_enabled"},
    }));
}

#[test]
fn readings_past_their_age_are_unknown_and_a_ping_alone_keeps_a_session_online() {
    let now = Instant::now() + Duration::from_secs(3600);
    let read = now - Duration::from_secs(1);
    // 1 s on Core plus what the program said: CPU and memory 6 s at most,
    // the disk 15 s; one millisecond past is unknown, never an old value.
    let fresh = load(read, CPU_STALE - Duration::from_secs(1), DISK_STALE - Duration::from_secs(1));
    let stale = load(read, CPU_STALE - Duration::from_secs(1) + Duration::from_millis(1), DISK_STALE - Duration::from_secs(1) + Duration::from_millis(1));
    let rows = vec![
        online("fresh", hello(None, None, read), Some(fresh), read, read),
        online("stale", hello(None, None, read), Some(stale), read, read),
        // Answers to pings, and no load yet: online, nothing known.
        online("pings", hello(None, None, read), None, now, read),
    ];
    let shown = show(&rows, None, now);
    let loaded = |at: usize| shown[at]["load"].clone();
    assert!(loaded(0)["cpu"].is_object() && loaded(0)["memory"].is_object(), "{}", loaded(0));
    assert!(loaded(0)["disks"][0]["totalMiB"].is_number(), "{}", loaded(0));
    assert_eq!((loaded(1)["cpu"].clone(), loaded(1)["memory"].clone()), (Value::Null, Value::Null), "{}", loaded(1));
    assert_eq!(loaded(1)["disks"], json!([{"roles": ["root"], "totalMiB": null, "availableMiB": null, "observedAt": null, "error": null, "permanent": null}]));
    assert_eq!(shown[2]["state"], "online");
    assert_eq!(loaded(2), json!({"cpu": null, "memory": null, "disks": null, "gpu": {"state": "off", "code": "not_enabled"}}));
    // A sample older than Core's clock reaches back still counts from Core's
    // own reading, never from the remote's wall clock, and does not overflow.
    let huge = load(read, Duration::from_secs(3600), Duration::from_secs(3600));
    let shown = show(&[online("old", hello(None, None, read), Some(huge), read, read)], None, now);
    assert_eq!(shown[0]["load"]["cpu"], Value::Null);
}

#[test]
fn thirty_seconds_without_a_frame_show_offline_silent_with_nothing_else() {
    let now = Instant::now() + Duration::from_secs(3600);
    let last = now - SILENCE - Duration::from_millis(1);
    let row = online("m1", hello(Some(&"11".repeat(16)), Some(&"22".repeat(16)), last), Some(load(last, Duration::ZERO, Duration::ZERO)), last, last);
    let shown = show(&[row], Some(&"11".repeat(16)), now);
    assert_eq!(shown[0], json!({
        "id": "m1", "name": "m1 name", "state": "offline", "code": "silent", "since": at(-0.001), "retryAt": null,
        "observedAt": at(0.0), "platform": null, "sameAs": null, "load": null,
    }));
    // At exactly 30 s it is still online.
    let last = now - SILENCE;
    let shown = show(&[online("m1", hello(None, None, last), None, last, last)], None, now);
    assert_eq!(shown[0]["state"], "online");
}

#[test]
fn same_as_marks_this_host_first_then_the_first_machine_with_the_account() {
    let now = Instant::now() + Duration::from_secs(3600);
    let local = "11".repeat(16);
    let (account, other) = ("aa".repeat(16), "bb".repeat(16));
    let row = |id: &str, host: Option<&str>, account: Option<&str>| online(id, hello(host, account, now), None, now, now);
    let rows = vec![
        row("m1", Some(&"33".repeat(16)), Some(&account)),
        row("m2", Some(&"33".repeat(16)), Some(&account)),
        row("m3", Some(&local), Some(&other)),
        row("m4", Some(&local), Some(&other)),
        row("m5", None, None),
        row("m6", None, None),
        // Gone silent: neither marked nor a match for a later one.
        online("m7", hello(None, Some(&"cc".repeat(16)), now), None, now - SILENCE * 2, now),
        row("m8", None, Some(&"cc".repeat(16))),
    ];
    let same = |local: Option<&str>| -> Vec<Value> { show(&rows, local, now).iter().map(|row| row["sameAs"].clone()).collect() };
    assert_eq!(same(Some(&local)), vec![
        Value::Null, json!("m1"), json!("local"), json!("local"), Value::Null, Value::Null, Value::Null, Value::Null,
    ]);
    // Without this host's id, nothing is compared with it.
    assert_eq!(same(None), vec![
        Value::Null, json!("m1"), Value::Null, json!("m3"), Value::Null, Value::Null, Value::Null, Value::Null,
    ]);
}

#[test]
fn disk_errors_show_only_known_codes_and_nothing_of_the_machine() {
    let now = Instant::now() + Duration::from_secs(3600);
    let error = |code: &str, permanent: bool| Disk { roles: vec![Role::Root], space: Space::Error { code: code.into(), permanent } };
    let failing = Arc::new(Stamped {
        value: Load { cpu: None, memory: None, disks: vec![error("unanswered", false)], why: vec![] },
        received: now,
    });
    let odd = Arc::new(Stamped { value: Load { cpu: None, memory: None, disks: vec![error("mount_lost_at_srv", true)], why: vec![] }, received: now });
    let rows = vec![online("m1", hello(None, None, now), Some(failing), now, now), online("m2", hello(None, None, now), Some(odd), now, now)];
    let shown = show(&rows, None, now);
    assert_eq!(shown[0]["load"]["disks"], json!([{"roles": ["root"], "totalMiB": null, "availableMiB": null, "observedAt": at(0.0),
        "error": "unanswered", "permanent": false}]));
    assert_eq!(shown[1]["load"]["disks"][0]["error"], "error");
    // Only these fields, whatever the session said.
    let keys: Vec<&String> = shown[0].as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 10, "{keys:?}");
    for key in ["id", "name", "state", "code", "since", "retryAt", "observedAt", "platform", "sameAs", "load"] {
        assert!(shown[0].get(key).is_some(), "{key}");
    }
    let text = serde_json::to_string(&shown).unwrap();
    for hidden in ["ab".repeat(16), "6f1c2a1e".into(), "3.12.4".into(), "mount_lost".into()] {
        assert!(!text.contains(&hidden), "{hidden} in {text}");
    }
}

#[test]
fn the_host_id_is_the_remote_programs_hash_of_the_machine_id() {
    // remote_job.py / program.py: sha256("yuzuno-jobs-host-v1:" + id)[:32].
    let id = "0123456789abcdef0123456789abcdef";
    let full = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(format!("yuzuno-jobs-host-v1:{id}").as_bytes()));
    assert_eq!(host_id(&format!("{id}\n")).as_deref(), Some(&full[..32]));
    for not_one in ["", "0123", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcdeg"] {
        assert_eq!(host_id(not_one), None, "{not_one:?}");
    }
    // The first file that holds one, as the program reads /etc/machine-id
    // then /var/lib/dbus/machine-id; these are a test's own files.
    let dir = tempfile::tempdir().unwrap();
    let (first, second) = (dir.path().join("machine-id"), dir.path().join("dbus-machine-id"));
    std::fs::write(&second, format!("{id}\n")).unwrap();
    assert_eq!(host_id_from(&[first.as_path(), second.as_path()]).as_deref(), Some(&full[..32]));
    std::fs::write(&first, "not an id\n").unwrap();
    assert_eq!(host_id_from(&[first.as_path()]), None);
}
