//! `GET /api/machine-live` (YN-83 S1 PR4b; design v4 PR4): each registered
//! SSH machine's remote session as it is now, for Home's machine card. No
//! page asks for it yet (PR5).
//!
//! The GET starts work: it records the user's interest and starts the
//! sessions that may start (registry.rs). So it needs exactly one
//! `X-Yuzuno-Client: desktop` header, which every request of Yuzuno's page
//! carries, on top of the local or phone entry's own rules; without it
//! nothing is recorded or started. HEAD is refused here (axum would answer
//! it with the GET), and so is every other method. It takes no query: only
//! registered machines, never a target or path from the request.
//!
//! Each answer is worked out at the moment it is made, on Core's monotonic
//! clock; the wall clock only writes the times out. The answer is
//!
//! ```text
//! {"machines": [{id, name, state, code, since, retryAt, observedAt,
//!                platform, sameAs, load}]}
//! ```
//!
//! in the machines' registered order, removed ones left out:
//! - `state`: `idle` (no session), `connecting`, `online`, `offline` or
//!   `unavailable`.
//! - `code`: null unless offline or unavailable. Offline is `ssh_unreachable`
//!   during a backoff, or `silent` for a session with no complete frame for
//!   30 s: shown so, with no readings, but that changes nothing and starts
//!   nothing. Unavailable is why nothing starts there now: a transport code
//!   (protocol.rs `Code`) or `machine_invalid` for a record that does not
//!   validate.
//! - `since`: when this state began. `retryAt`: only during a backoff, when
//!   it may start again (if the interest still lasts then). `observedAt`:
//!   when Core made this answer.
//! - `platform`: `Linux` or `Darwin`, from the hello of a session online now.
//! - `sameAs`: for display only (never a shared connection or an admission):
//!   `local` when an online session's host id is this host's (both by the
//!   `yuzuno-jobs-host-v1` hash of the machine-id; not compared when this
//!   host has none); else the id of the first machine above it online with
//!   the same non-null account key (same host, user and data root).
//! - `load`: null unless online. Then `cpu` {pct, cores, observedAt},
//!   `memory` {totalMiB, usedMiB, availableMiB, estimate, observedAt}, each
//!   null once more than 6 s old or never sent; `disks` null until a load
//!   came, else one row per root with totalMiB, availableMiB, observedAt,
//!   error and permanent, the numbers null once more than 15 s old or on an
//!   error; `gpu` always {state: off, code: not_enabled}. A sample's
//!   observedAt is when Core read it less how old the program said it was.
//!   `estimate` marks macOS's memory figure.
//!
//! Nothing else: no target, user, data root, path, stderr, hello or text of
//! the remote's own.

use super::link::{age_at, Link, Stamped};
use super::protocol::{Hello, Load, MemorySource, Platform, Role, Space};
use super::registry::{self, Host, Registry};
use crate::remote::RemoteMachine;
use crate::server::ApiError;
use crate::updates::admission::Admission;
use crate::workspace::Workspace;
use anyhow::Result;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// CPU and memory readings older than this are unknown: three of their 2 s
/// sampling periods (v4 A8, as machine_load's GPU_STALE).
pub(crate) const CPU_STALE: Duration = Duration::from_secs(6);
/// Disk readings older than this are unknown: three of their 5 s periods.
pub(crate) const DISK_STALE: Duration = Duration::from_secs(15);
/// What program.py says of a disk it could not read; anything else is `error`.
const DISK_ERRORS: [&str; 9] = ["busy", "io", "not_directory", "not_found", "pending", "permission", "stopping", "timeout", "unanswered"];

/// One registered machine as the registry has it.
pub(crate) struct Row {
    pub id: String,
    pub name: String,
    pub live: Live,
    pub since: Instant,
}

pub(crate) enum Live {
    Idle,
    Connecting,
    /// A session that said hello and goes on.
    Online { hello: Arc<Stamped<Hello>>, load: Option<Arc<Stamped<Load>>>, last_frame: Instant },
    /// A backoff after OpenSSH could not connect.
    Offline { retry_at: Instant },
    Unavailable { code: &'static str },
}

/// The answer, at `now` (Core's monotonic clock), its times written from `wall`.
pub(crate) fn answer(rows: &[Row], local: Option<&str>, now: Instant, wall: DateTime<Utc>, silence: Duration) -> Value {
    let at = |instant: Instant| stamp(instant, now, wall);
    let online = |row: &Row| match &row.live {
        Live::Online { hello, last_frame, .. } if now.saturating_duration_since(*last_frame) <= silence => Some(hello.clone()),
        _ => None,
    };
    let mut accounts: HashMap<String, String> = HashMap::new();
    let mut machines = vec![];
    for row in rows {
        let mut same_as = Value::Null;
        if let Some(hello) = online(row) {
            let hello = &hello.value;
            if local.is_some() && hello.host_id.as_deref() == local {
                same_as = "local".into();
            }
            if let Some(key) = &hello.account_key {
                match accounts.get(key) {
                    Some(first) if same_as.is_null() => same_as = first.clone().into(),
                    Some(_) => {}
                    None => {
                        accounts.insert(key.clone(), row.id.clone());
                    }
                }
            }
        }
        let (state, code, since, retry_at, platform, load) = match &row.live {
            Live::Idle => ("idle", None, at(row.since), None, None, Value::Null),
            Live::Connecting => ("connecting", None, at(row.since), None, None, Value::Null),
            Live::Online { hello, load, last_frame } => {
                if now.saturating_duration_since(*last_frame) > silence {
                    ("offline", Some("silent"), at(*last_frame + silence), None, None, Value::Null)
                } else {
                    let platform = match hello.value.platform {
                        Platform::Linux => "Linux",
                        Platform::Darwin => "Darwin",
                    };
                    ("online", None, at(row.since), None, Some(platform), readings(load.as_deref(), now, wall))
                }
            }
            Live::Offline { retry_at } => ("offline", Some("ssh_unreachable"), at(row.since), Some(at(*retry_at)), None, Value::Null),
            Live::Unavailable { code } => ("unavailable", Some(*code), at(row.since), None, None, Value::Null),
        };
        machines.push(json!({
            "id": row.id, "name": row.name, "state": state, "code": code, "since": since, "retryAt": retry_at,
            "observedAt": at(now), "platform": platform, "sameAs": same_as, "load": load,
        }));
    }
    json!({"machines": machines})
}

/// An online session's readings, each known only while fresh enough.
fn readings(load: Option<&Stamped<Load>>, now: Instant, wall: DateTime<Utc>) -> Value {
    let gpu = json!({"state": "off", "code": "not_enabled"});
    let Some(load) = load else {
        return json!({"cpu": null, "memory": null, "disks": null, "gpu": gpu});
    };
    let received = load.received;
    let fresh = |age: Duration, limit: Duration| {
        let old = age_at(received, age, now);
        (old <= limit).then(|| ago(old, wall))
    };
    let cpu = load.value.cpu.as_ref().and_then(|cpu| {
        fresh(cpu.age, CPU_STALE).map(|observed| json!({"pct": cpu.pct, "cores": cpu.cores, "observedAt": observed}))
    });
    let memory = load.value.memory.as_ref().and_then(|memory| {
        fresh(memory.age, CPU_STALE).map(|observed| {
            json!({"totalMiB": memory.total_mib, "usedMiB": memory.used_mib, "availableMiB": memory.available_mib,
                "estimate": memory.measure == MemorySource::DarwinFreeInactive, "observedAt": observed})
        })
    });
    let disks: Vec<Value> = load
        .value
        .disks
        .iter()
        .map(|disk| {
            let roles: Vec<&str> = disk.roles.iter().map(|role| match role {
                Role::Root => "root",
            }).collect();
            let unknown = json!({"roles": roles, "totalMiB": null, "availableMiB": null, "observedAt": null, "error": null, "permanent": null});
            match &disk.space {
                Space::Known { total_mib, available_mib, age } => match fresh(*age, DISK_STALE) {
                    Some(observed) => json!({"roles": roles, "totalMiB": total_mib, "availableMiB": available_mib,
                        "observedAt": observed, "error": null, "permanent": null}),
                    None => unknown,
                },
                Space::Error { code, permanent } => match fresh(Duration::ZERO, DISK_STALE) {
                    Some(observed) => {
                        let code = DISK_ERRORS.iter().copied().find(|known| *known == code.as_str()).unwrap_or("error");
                        json!({"roles": roles, "totalMiB": null, "availableMiB": null, "observedAt": observed,
                            "error": code, "permanent": permanent})
                    }
                    None => unknown,
                },
            }
        })
        .collect();
    json!({"cpu": cpu, "memory": memory, "disks": disks, "gpu": gpu})
}

/// `instant` on the wall clock, `wall` being `now`'s.
fn stamp(instant: Instant, now: Instant, wall: DateTime<Utc>) -> String {
    let at = if instant <= now {
        TimeDelta::from_std(now - instant).ok().and_then(|delta| wall.checked_sub_signed(delta))
    } else {
        TimeDelta::from_std(instant - now).ok().and_then(|delta| wall.checked_add_signed(delta))
    };
    at.unwrap_or(wall).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn ago(old: Duration, wall: DateTime<Utc>) -> String {
    TimeDelta::from_std(old).ok().and_then(|delta| wall.checked_sub_signed(delta)).unwrap_or(wall).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A machine-id's `yuzuno-jobs-host-v1` hash, as remote_job.py and
/// program.py write a host id: 32 lowercase hex digits in, the first 32 of
/// the hash out; anything else is none.
pub(crate) fn host_id(machine_id: &str) -> Option<String> {
    let value = machine_id.trim();
    if value.len() != 32 || !value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let hash = format!("{:x}", Sha256::digest(format!("yuzuno-jobs-host-v1:{value}").as_bytes()));
    Some(hash[..32].to_owned())
}

/// This host's id from the first of `paths` that holds a machine-id, as the
/// remote program reads its own.
pub(crate) fn host_id_from(paths: &[&std::path::Path]) -> Option<String> {
    paths.iter().find_map(|path| std::fs::read_to_string(path).ok().and_then(|text| host_id(&text)))
}

/// This host's id (Linux; none elsewhere, so nothing is compared).
fn local_host_id() -> Option<String> {
    if cfg!(target_os = "linux") {
        host_id_from(&[std::path::Path::new("/etc/machine-id"), std::path::Path::new("/var/lib/dbus/machine-id")])
    } else {
        None
    }
}

impl Host for Workspace {
    fn registry(&self) -> &Registry {
        &self.machine_live
    }

    fn admission(&self) -> &Arc<Admission> {
        &self.admission
    }

    fn registered(&self) -> BoxFuture<'_, Result<Vec<RemoteMachine>>> {
        Box::pin(self.stored(|store| store.machines()))
    }

    fn start(&self, machine: &RemoteMachine, generation: u64) -> Result<Link> {
        Link::start(machine, generation, self.machine_live.options())
    }

    fn local_host(&self) -> Option<String> {
        static LOCAL: OnceLock<Option<String>> = OnceLock::new();
        LOCAL.get_or_init(local_host_id).clone()
    }
}

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/machine-live", get(live).head(refused))
}

/// Exactly one `X-Yuzuno-Client: desktop`.
pub(crate) fn from_the_page(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all("x-yuzuno-client").iter();
    matches!((values.next(), values.next()), (Some(value), None) if value.as_bytes() == b"desktop")
}

async fn live(State(ws): State<Arc<Workspace>>, headers: HeaderMap) -> Response {
    if !from_the_page(&headers) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Workspace client header required"}))).into_response();
    }
    match registry::answer(&ws).await {
        Ok(answer) => Json(answer).into_response(),
        Err(error) => ApiError::from(error).into_response(),
    }
}

async fn refused() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "GET")]).into_response()
}

impl Workspace {
    /// Core's shutdown watch, which every way Core stops sends true on
    /// (main.rs, the update's Stop).
    pub fn follow_core_shutdown(&self, shutdown: tokio::sync::watch::Receiver<bool>) {
        self.machine_live.follow_shutdown(shutdown);
    }

    /// Core ends: every machine's remote session is asked to close, and they
    /// get 14 s together. Returns how many children were still unreaped.
    pub async fn close_remote_sessions(&self) -> usize {
        let registry = &self.machine_live;
        registry.close_all(registry::Closing::Shutdown, registry.closing()).await.unreaped
    }
}
