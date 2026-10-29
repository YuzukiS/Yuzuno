//! A Project service served by a Yuzuno Job (T-5): the link between a
//! service (services.rs, T-151) and the ordinary Jobs that serve it, and what
//! the services list says about it.
//!
//! A service no Job serves is external: Yuzuno never starts or stops it. A
//! served one is started by an explicit job_submit with `service`, stopped by
//! that Job's own cancel, and restarted only as a new Job of the same service
//! once the earlier one has ended. Nothing here starts, stops or signals a
//! process, and no port is scanned: the only port read is the service's own,
//! and only to say whose listener answers there.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::services::{Service, LOCAL};
use crate::workspace::Workspace;

/// What a Job declares about the service it serves (job_submit `service`).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Declared {
    /// An existing service of the task's Project, served anew: a restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_id: Option<String>,
    /// A new service on this host: its name, its port and where to open it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// A path whose HTTP 2xx answer means the app is healthy. Without one no
    /// health is shown, never guessed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_path: Option<String>,
}

impl Declared {
    pub(crate) fn validate(&self) -> Result<()> {
        match &self.service_id {
            Some(id) => {
                ensure!(!id.trim().is_empty() && id.len() <= 128, "service.serviceId must contain 1–128 bytes");
                ensure!(
                    self.name.is_none() && self.port.is_none() && self.path.is_none(),
                    "service: give serviceId (an existing service, served anew) or name and port (a new one), not both"
                );
            }
            None => ensure!(
                self.name.is_some() && self.port.is_some(),
                "service: give name and port for a new service on this host, or serviceId for an existing one"
            ),
        }
        if let Some(path) = &self.health_path {
            ensure!(
                url_path(path),
                "service.healthPath starts with / (e.g. /health), at most 512 bytes, without spaces, \\ or #"
            );
        }
        Ok(())
    }
}

/// services.rs's rule for a path to open.
fn url_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 512
        && !path.chars().any(|c| c.is_control() || c.is_whitespace() || c == '\\' || c == '#')
}

/// The service a Job is linked to, once Core has registered or named it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Link {
    pub service_id: String,
    pub health_path: Option<String>,
}

/// Runs on every open, after services' own. Older builds ignore the table.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_service_jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE CASCADE,
            job_id TEXT NOT NULL UNIQUE, health_path TEXT, linked_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS project_service_jobs_service ON project_service_jobs(service_id, seq);
        DELETE FROM project_service_jobs WHERE service_id NOT IN (SELECT id FROM project_services);",
    )?;
    Ok(())
}

/// Before the Job's insert: the service it declares, registered on this host
/// if it is new. The registration is keyed by the Job's own requestId, so a
/// retry of the same submission finds the same service (services.rs). A
/// submission refused after this point leaves that registration in place,
/// as a service no Job serves.
pub(crate) async fn prepare(
    ws: &Workspace,
    actor: Option<&str>,
    task: &str,
    request_id: &str,
    declared: &Declared,
) -> Result<Link> {
    let health_path = declared.health_path.clone();
    if let Some(id) = &declared.service_id {
        return Ok(Link { service_id: id.clone(), health_path });
    }
    let task = task.to_owned();
    let project = ws
        .stored(move |s| {
            let db = s.db.read()?;
            let key = crate::collaboration_store::task_key(&db, &task)?.0;
            Ok(crate::projects::task_projects(&db, &[key.as_str()])?.remove(&key))
        })
        .await?
        .context("service: the task is in no Project, and a service belongs to one")?;
    let author = match actor {
        Some(agent) => {
            let id = agent.to_owned();
            let name = ws.stored(move |s| s.agent(&id)).await?.name;
            json!({"kind":"agent","id":agent,"name":name})
        }
        None => json!({"kind":"user"}),
    };
    let new = crate::services::NewService {
        name: declared.name.clone().unwrap_or_default(),
        machine_id: LOCAL.into(),
        port: declared.port.unwrap_or_default(),
        path: declared.path.clone().unwrap_or_else(|| "/".into()),
    };
    let view = ws.register_service(&project, new, author, Some(format!("job:{request_id}"))).await?;
    let service_id = view["id"].as_str().context("the service registration returned no id")?.to_owned();
    Ok(Link { service_id, health_path })
}

/// A status in which a Job may still be serving: anything but these, so
/// `unknown` too (its process was not seen to end) and `cancelling`.
const ENDED: &str = "'succeeded','failed','cancelled','interrupted','rejected'";

/// In the Job's own insert transaction: the service is this task's Project's,
/// on this host, and no earlier Job of it may still be serving.
pub(crate) fn check(tx: &Connection, task: &str, link: &Link) -> Result<()> {
    let project = crate::projects::task_projects(tx, &[task])?
        .remove(task)
        .context("service: the task is in no Project, and a service belongs to one")?;
    let raw: Option<String> = tx
        .query_row("SELECT data FROM project_services WHERE id=?1", [&link.service_id], |r| r.get(0))
        .optional()?;
    let service: Service = serde_json::from_str(&raw.context("service_not_found: no such service")?)?;
    ensure!(
        service.project_id == project,
        "service: {} belongs to another Project than the task",
        service.name
    );
    ensure!(
        service.machine_id == LOCAL,
        "service: {} is on {}; a Job serves a service on this host only in this version",
        service.name,
        service.machine_id
    );
    if let Some((job, status)) = live(tx, &link.service_id)? {
        bail!(
            "service: {} is still served by Job {job} ({status}); a restart is a new Job once that one has ended, so cancel it first",
            service.name
        );
    }
    Ok(())
}

/// In the same transaction, once the Job has its id.
pub(crate) fn insert(tx: &Connection, job: &str, link: &Link) -> Result<()> {
    tx.execute(
        "INSERT INTO project_service_jobs(service_id,job_id,health_path,linked_at) VALUES(?1,?2,?3,?4)",
        params![link.service_id, job, link.health_path, crate::model::now()],
    )?;
    Ok(())
}

fn live(db: &Connection, service: &str) -> Result<Option<(String, String)>> {
    Ok(db
        .query_row(
            &format!(
                "SELECT j.id, j.status FROM project_service_jobs l JOIN local_jobs j ON j.id=l.job_id
                 WHERE l.service_id=?1 AND j.status NOT IN ({ENDED}) ORDER BY l.seq DESC LIMIT 1"
            ),
            [service],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// A service's Jobs as linked, newest last.
struct Served {
    job: Value,
    earlier: Vec<String>,
    health_path: Option<String>,
}

fn served(db: &Connection, ids: &[String]) -> Result<HashMap<String, Served>> {
    let mut links = db.prepare(
        "SELECT job_id, health_path FROM project_service_jobs WHERE service_id=?1 ORDER BY seq",
    )?;
    let mut out = HashMap::new();
    for id in ids {
        let rows: Vec<(String, Option<String>)> = links
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let Some(((current, health_path), earlier)) = rows.split_last().map(|(l, e)| (l.clone(), e)) else { continue };
        let raw: Option<String> = db
            .query_row("SELECT data FROM local_jobs WHERE id=?1", [&current], |r| r.get(0))
            .optional()?;
        // A Job the store no longer has: its status is said to be unknown.
        let job = match raw {
            Some(raw) => serde_json::from_str(&raw)?,
            None => json!({"id": current, "status": "unknown"}),
        };
        let earlier = earlier.iter().map(|(job, _)| job.clone()).collect();
        out.insert(id.clone(), Served { job, earlier, health_path });
    }
    Ok(out)
}

/// The services list with each one's Job and health (T-5): `job` is null for
/// a service no Job serves, which is external and never stopped from Yuzuno.
pub(crate) async fn with_jobs(ws: &Workspace, services: &[Service], mut views: Vec<Value>) -> Result<Vec<Value>> {
    let ids: Vec<String> = services.iter().map(|s| s.id.clone()).collect();
    let mut links = ws.stored(move |s| served(&*s.db.read()?, &ids)).await?;
    for (service, view) in services.iter().zip(views.iter_mut()) {
        let Some(link) = links.remove(&service.id) else {
            view["job"] = Value::Null;
            view["health"] = json!({"declared": false});
            continue;
        };
        let (data, job, port) = (ws.data_dir.clone(), link.job.clone(), service.port);
        let owner = tokio::task::spawn_blocking(move || owner(&data, &job, port))
            .await
            .unwrap_or(Owner::Unknown);
        let status = link.job["status"].as_str().unwrap_or("unknown").to_owned();
        let job_id = link.job["id"].as_str().unwrap_or_default().to_owned();
        view["job"] = json!({
            "jobId": job_id,
            "status": status,
            "owner": owner,
            "earlierJobIds": link.earlier,
            // Stop is the Job's own cancel, which decides who may cancel it.
            "canStop": matches!(status.as_str(), "queued" | "waiting" | "running"),
        });
        view["health"] = match &link.health_path {
            None => json!({"declared": false}),
            Some(path) if status == "running" && owner == Owner::Verified => health(&job_id, port, path).await,
            Some(path) => json!({"declared": true, "path": path, "state": "unknown",
                "reason": if status == "running" { "not checked: the port is not served by this Job" } else { "not checked: the Job is not running" }}),
        };
    }
    Ok(views)
}

/// One health check per Job and path, at most this often.
const HEALTH_TTL: Duration = Duration::from_secs(10);
/// A health path that answers later than this is failing.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);

/// The last result of each Job's health path, when it was checked, and
/// whether a check is under way.
#[derive(Default)]
struct Checked {
    at: Option<Instant>,
    value: Option<Value>,
    checking: bool,
}

fn health_cache() -> &'static Mutex<HashMap<String, Checked>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Checked>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The list never waits for a health path: it gets the last result (with
/// its checkedAt), or `checking` before the first, while a check older than
/// HEALTH_TTL runs again in the background, one at a time per Job and path.
async fn health(job: &str, port: u16, path: &str) -> Value {
    let key = format!("{job} {path}");
    let (last, start) = {
        let mut cache = health_cache().lock().unwrap();
        cache.retain(|k, c| c.checking || c.at.is_some_and(|at| at.elapsed() < HEALTH_TTL * 6) || *k == key);
        let entry = cache.entry(key.clone()).or_default();
        let fresh = entry.at.is_some_and(|at| at.elapsed() < HEALTH_TTL);
        let start = !fresh && !entry.checking;
        entry.checking |= start;
        (entry.value.clone(), start)
    };
    if start {
        let path = path.to_owned();
        tokio::spawn(async move {
            let value = check_health(port, &path).await;
            let mut cache = health_cache().lock().unwrap();
            let entry = cache.entry(key).or_default();
            *entry = Checked { at: Some(Instant::now()), value: Some(value), checking: false };
        });
    }
    last.unwrap_or_else(|| json!({"declared": true, "path": path, "state": "unknown", "reason": "checking"}))
}

/// One check of a health path, at most HEALTH_TIMEOUT long.
async fn check_health(port: u16, path: &str) -> Value {
    let mut value = match tokio::time::timeout(HEALTH_TIMEOUT, crate::services::probe(port, path)).await {
        Ok(crate::services::Probe::Http(code, ..)) => json!({
            "state": if (200..300).contains(&code) { "ok" } else { "failing" }, "httpStatus": code}),
        Ok(crate::services::Probe::Refused(reason) | crate::services::Probe::Silent(reason)) => {
            json!({"state": "failing", "reason": reason})
        }
        Err(_) => json!({"state": "failing", "reason": format!("no answer within {} s", HEALTH_TIMEOUT.as_secs())}),
    };
    value["declared"] = json!(true);
    value["path"] = json!(path);
    value["checkedAt"] = json!(crate::model::now());
    value
}

/// Whose listener answers 127.0.0.1:port.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Owner {
    /// Every such listener is held by a process of the control group the
    /// Job's attempt recorded at its start, on this boot.
    Verified,
    /// Something listens there that this Job cannot be shown to hold.
    OtherProcess,
    NotListening,
    /// What listens, or what the Job holds, could not be read.
    Unknown,
}

/// A listener the Job cannot be shown to hold is never counted as ours: one
/// it holds beside another process's is `OtherProcess`.
pub(crate) fn owner(data: &Path, job: &Value, port: u16) -> Owner {
    let Ok(listeners) = listening(port) else { return Owner::Unknown };
    let Some(listeners) = reached(&listeners, port) else { return Owner::Unknown };
    if listeners.is_empty() {
        return Owner::NotListening;
    }
    // A Job queued or ended has no process that could hold it.
    if !matches!(job["status"].as_str(), Some("running" | "cancelling" | "unknown")) {
        return Owner::OtherProcess;
    }
    let Some(started) = crate::jobs::started_record(data, job) else { return Owner::Unknown };
    let (Some(group), Some(boot)) = (started["controlGroup"].as_str(), started["bootId"].as_str()) else {
        return Owner::Unknown;
    };
    match std::fs::read_to_string("/proc/sys/kernel/random/boot_id") {
        Ok(now) if now.trim() == boot => {}
        // Its processes ended with the boot it started on.
        Ok(_) => return Owner::OtherProcess,
        Err(_) => return Owner::Unknown,
    }
    let pids = group_pids(&Path::new("/sys/fs/cgroup").join(group.trim_start_matches('/')));
    let mut held = HashSet::new();
    for pid in pids {
        held.extend(sockets(pid, &listeners));
    }
    if listeners.is_subset(&held) {
        Owner::Verified
    } else {
        Owner::OtherProcess
    }
}

/// Where a socket listening on the port is bound, of the addresses a
/// connection to 127.0.0.1 can arrive at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Bound {
    Loopback,
    AnyV4,
    MappedLoopback,
    AnyV6,
}

/// The sockets listening on `port` at 127.0.0.1, 0.0.0.0, ::ffff:127.0.0.1
/// or ::, with their inodes.
fn listening(port: u16) -> std::io::Result<Vec<(Bound, u64)>> {
    let mut found = Vec::new();
    for file in ["/proc/net/tcp", "/proc/net/tcp6"] {
        match std::fs::read_to_string(file) {
            Ok(text) => found.extend(parse_listeners(&text, port)),
            // A kernel without IPv6 has no tcp6.
            Err(e) if file.ends_with('6') && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(found)
}

/// How long a connection to 127.0.0.1 may take to tell whether a lone ::
/// takes IPv4: a local one is answered at once unless its backlog is full.
const V4_CHECK: Duration = Duration::from_millis(300);

/// The listening sockets a connection to 127.0.0.1:port reaches, as Linux
/// picks: 127.0.0.1, else 0.0.0.0, else ::ffff:127.0.0.1, else ::. A :: that
/// is IPv6-only (IPV6_V6ONLY) takes no IPv4 at all. Beside an IPv4 listener
/// a :: on the same port is IPv6-only (or loses to it), so it is left out.
/// /proc doesn't say whether a lone :: is IPv6-only; one connection to
/// 127.0.0.1 tells. None: that could not be told.
fn reached(listeners: &[(Bound, u64)], port: u16) -> Option<HashSet<u64>> {
    let at = |bound: Bound| -> HashSet<u64> { listeners.iter().filter(|(b, _)| *b == bound).map(|(_, inode)| *inode).collect() };
    for bound in [Bound::Loopback, Bound::AnyV4, Bound::MappedLoopback] {
        let inodes = at(bound);
        if !inodes.is_empty() {
            return Some(inodes);
        }
    }
    let wildcard = at(Bound::AnyV6);
    if wildcard.is_empty() {
        return Some(wildcard);
    }
    match std::net::TcpStream::connect_timeout(&(std::net::Ipv4Addr::LOCALHOST, port).into(), V4_CHECK) {
        Ok(_) => Some(wildcard),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Some(HashSet::new()),
        Err(_) => None,
    }
}

/// /proc/net/tcp{,6} lines: `sl local rem st … inode`, addresses in hex.
fn parse_listeners(text: &str, port: u16) -> Vec<(Bound, u64)> {
    let mut found = Vec::new();
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some((address, local_port)) = fields[1].split_once(':') else { continue };
        if u16::from_str_radix(local_port, 16).ok() != Some(port) {
            continue;
        }
        let bound = match address.to_ascii_uppercase().as_str() {
            "0100007F" => Bound::Loopback,
            "00000000" => Bound::AnyV4,
            "0000000000000000FFFF00000100007F" => Bound::MappedLoopback,
            "00000000000000000000000000000000" => Bound::AnyV6,
            _ => continue,
        };
        if let Ok(inode) = fields[9].parse::<u64>() {
            if inode != 0 {
                found.push((bound, inode));
            }
        }
    }
    found
}

/// Every process of a control group and the groups below it.
fn group_pids(group: &Path) -> Vec<i32> {
    let mut pids = Vec::new();
    let mut todo = vec![group.to_path_buf()];
    while let Some(dir) = todo.pop() {
        if let Ok(text) = std::fs::read_to_string(dir.join("cgroup.procs")) {
            pids.extend(text.lines().filter_map(|l| l.trim().parse::<i32>().ok()));
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            todo.extend(entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
        }
    }
    pids
}

/// Which of `inodes` the process holds open.
fn sockets(pid: i32, inodes: &HashSet<u64>) -> HashSet<u64> {
    let mut held = HashSet::new();
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return held };
    for entry in entries.flatten() {
        let Ok(target) = std::fs::read_link(entry.path()) else { continue };
        let target = target.to_string_lossy();
        if let Some(inode) = target.strip_prefix("socket:[").and_then(|t| t.strip_suffix(']')).and_then(|t| t.parse().ok()) {
            if inodes.contains(&inode) {
                held.insert(inode);
            }
        }
    }
    held
}

#[cfg(test)]
#[path = "service_jobs_tests.rs"]
mod tests;
