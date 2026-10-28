//! Project services (T-151): a web service that already runs on one of a
//! Project's Machines (a dev server, Jupyter, TensorBoard), registered by the
//! user or an Agent and opened only when the user asks. Yuzuno never starts,
//! stops or scans a service.
//!
//! Opening one makes Core listen on a port P of a fixed, narrow range on the
//! Core host's loopback and relay each connection there, unchanged, to the
//! service: to its port on this host, or through the machine's SSH (`ssh -L
//! 127.0.0.1:Q:127.0.0.1:PORT`, whose port Q only Core connects to). Core
//! holds all of it, listener, connections and SSH: SSH lives on Core's stdin
//! pipe (its remote command waits for EOF there), so the way ends with Core
//! however Core ends, and Yuzuno never looks for a process by ID or port to
//! end anything.
//!
//! A client opens http://127.0.0.1:P: the browser on the Core host itself,
//! or a client whose own tunnel to Core forwards the same port P (a Mac).
//! Core cannot tell which from a request, and a port P answering on the
//! client may be something else there, so the page proves the way before it
//! opens it: Core answers one reserved request on P with an answer that only
//! the page that opened the service was given (`relay`). The service gets an
//! origin of its own (127.0.0.1:P), never Core's.
use crate::{model::now, remote::RemoteMachine, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ops::RangeInclusive,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    time::{timeout, Instant},
};

/// The Core host, as Projects name it in `default_dirs`.
pub const LOCAL: &str = "local";
const MAX_PER_PROJECT: usize = 32;
/// The ports Core listens on for services: fixed and narrow, so a client
/// that reaches Core through an SSH tunnel of its own (a Mac) can forward the
/// same ports once. YUZUNO_SERVICE_PORTS=first-last changes them.
const PORTS: RangeInclusive<u16> = 4380..=4389;
/// The one request Core's listener answers itself (see `relay`).
const RESERVED: &[u8] = b"GET /.well-known/yuzuno-service/";
/// How long the page has to ask for its challenge's answer.
const PROOF_TTL: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 60 });
/// How long a new connection may stay silent before its first bytes (an
/// idle browser preconnection, or nothing at all); then Core closes it.
const FIRST_BYTES: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 60 });
/// How long SSH may take to sign in and listen.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// The forward's remote command: one line once SSH listens (it opens local
/// forwards before the session), then it waits for Core's end of stdin.
const HOLD: &str = "printf 'yuzuno-forward-ready\\n'; cat >/dev/null";
const READY: &str = "yuzuno-forward-ready";
/// How long a service may take to answer the first bytes of an HTTP response.
const PROBE_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 5 });
const STDERR_LIMIT: usize = 8192;
const CLOSED: &str = "the connection closed without an HTTP response";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub project_id: String,
    /// `local` (the Core host) or a registered SSH machine.
    pub machine_id: String,
    /// The port the service listens on, on that machine's loopback.
    pub port: u16,
    /// Where to open it, from `/`; never a credential (every Agent can read it).
    pub path: String,
    pub name: String,
    /// `{"kind":"user"}`, or `{"kind":"agent","id","name"}` for an Agent's.
    pub author: Value,
    pub created_at: String,
    /// An Agent's registration, retried with the same requestId, is the same one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewService {
    pub name: String,
    pub machine_id: String,
    pub port: u16,
    #[serde(default = "root")]
    pub path: String,
}

fn root() -> String {
    "/".into()
}

/// Runs on every open, as `projects::migrate`. Older builds ignore the table.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_services(id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS project_services_project ON project_services(project_id);
        DELETE FROM project_services WHERE project_id NOT IN (SELECT id FROM projects);",
    )?;
    Ok(())
}

fn validate(input: &NewService) -> Result<(String, String)> {
    let name = input.name.trim();
    ensure!(
        !name.is_empty() && name.len() <= 80 && !name.chars().any(char::is_control),
        "invalid_service: a name is 1–80 bytes without control characters"
    );
    ensure!(input.port > 0, "invalid_service: the port is 1–65535");
    let path = input.path.trim();
    ensure!(
        path.starts_with('/') && !path.starts_with("//") && path.len() <= 512
            && !path.chars().any(|c| c.is_control() || c.is_whitespace() || c == '\\' || c == '#'),
        "invalid_service: the path starts with / (e.g. / or /lab), at most 512 bytes, without spaces, \\ or #"
    );
    ensure!(
        input.machine_id != "windows",
        "invalid_service: services on Windows are not available in this version"
    );
    Ok((name.into(), path.into()))
}

fn load(db: &Connection, id: &str) -> Result<Service> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM project_services WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    Ok(serde_json::from_str(&raw.context("service_not_found: no such service")?)?)
}

fn of_project(db: &Connection, project: &str) -> Result<Vec<Service>> {
    let mut query = db.prepare("SELECT data FROM project_services WHERE project_id=?1 ORDER BY rowid")?;
    let rows = query.query_map([project], |r| r.get::<_, String>(0))?;
    rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
}

impl Store {
    pub fn services(&self, project: &str) -> Result<Vec<Service>> {
        let db = self.db.read()?;
        crate::projects::ensure_exists(&db, project)?;
        of_project(&db, project)
    }

    pub fn service(&self, id: &str) -> Result<Service> {
        load(&*self.db.read()?, id)
    }

    /// A new registration; nothing is opened. `request_id` makes an Agent's
    /// retry return the registration it made.
    pub(crate) fn register_service(&self, project: &str, input: &NewService, author: Value, request_id: Option<&str>)
        -> Result<Service> {
        let (name, path) = validate(input)?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        crate::projects::ensure_assignable(&tx, project)?;
        if input.machine_id != LOCAL {
            let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM machines WHERE id=?1)", [&input.machine_id], |r| r.get(0))?;
            ensure!(known, "invalid_service: machine {} is not registered", input.machine_id);
        }
        let existing = of_project(&tx, project)?;
        if let Some(request) = request_id {
            if let Some(same) = existing.iter().find(|s| s.request_id.as_deref() == Some(request) && s.author == author) {
                ensure!(same.name == name && same.machine_id == input.machine_id && same.port == input.port && same.path == path,
                    "idempotency_conflict: requestId already registered another service");
                return Ok(same.clone());
            }
        }
        ensure!(existing.len() < MAX_PER_PROJECT, "invalid_service: a project has at most {MAX_PER_PROJECT} services");
        ensure!(
            !existing.iter().any(|s| s.machine_id == input.machine_id && s.port == input.port && s.path == path),
            "invalid_service: this project already has that service ({} port {}{})", input.machine_id, input.port, path
        );
        let service = Service {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project.into(),
            machine_id: input.machine_id.clone(),
            port: input.port,
            path,
            name,
            author,
            created_at: now(),
            request_id: request_id.map(str::to_owned),
        };
        tx.execute("INSERT INTO project_services(id,project_id,data) VALUES(?1,?2,?3)",
            params![service.id, project, serde_json::to_string(&service)?])?;
        tx.commit()?;
        Ok(service)
    }

    pub(crate) fn delete_service(&self, id: &str) -> Result<Service> {
        let db = self.db.write()?;
        let service = load(&db, id)?;
        db.execute("DELETE FROM project_services WHERE id=?1", [id])?;
        Ok(service)
    }
}

/// What a service's way is now. Kept in memory only: Core holds every part of
/// it (its listener, its connections and its SSH), so after a restart every
/// service is `closed`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub state: State,
    /// The Core host's loopback port Core listens on for it: the address a
    /// client opens, here or through a tunnel of its own to the same port.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
    /// The HTTP status the last check got.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    /// Whether that answer lets another origin frame the page (T-5's Portal).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framing: Option<Framing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub since: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// Nothing is open for it.
    Closed,
    /// SSH is signing in and listening, or the first check is running.
    Opening,
    /// Something answered HTTP on the service's port, in time.
    Available,
    /// The way is open, but nothing listens on the service's port there.
    NotRunning,
    /// Something listens, but no HTTP response came in time.
    NotReady,
    /// No port of the services' range was free on the Core host, or SSH's own
    /// local port could not be listened on.
    PortInUse,
    /// SSH could not reach or sign in to the machine.
    MachineUnreachable,
    /// SSH ended before listening, for another reason.
    TunnelFailed,
    /// The forward ended after it was open; Core stopped listening for it.
    Disconnected,
}

/// Whether a service's page may be framed by another origin, from the
/// headers of the answer its check got. Read only: the relay passes every
/// header on unchanged, and the Portal opens a page that refuses framing in
/// the browser instead.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Framing {
    /// Neither X-Frame-Options nor a CSP frame-ancestors, or frame-ancestors *.
    Allowed,
    /// X-Frame-Options, or frame-ancestors 'none' or 'self' only.
    Blocked,
    /// frame-ancestors names origins: the page's own may or may not be one.
    Restricted,
    /// The answer's headers did not arrive whole in time.
    Unknown,
}

/// `Framing` from a response head. A CSP frame-ancestors decides when there
/// is one (browsers then ignore X-Frame-Options); a report-only one does not.
fn framing(head: &str) -> Framing {
    let headers = || head.split("\r\n").skip(1).filter_map(|line| line.split_once(':')).map(|(n, v)| (n.trim(), v.trim()));
    let ancestors: Vec<String> = headers()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-security-policy"))
        .flat_map(|(_, value)| value.split(';').map(str::trim).map(str::to_owned).collect::<Vec<_>>())
        .filter_map(|directive| {
            let mut words = directive.split_whitespace();
            words.next().filter(|n| n.eq_ignore_ascii_case("frame-ancestors"))?;
            Some(words.map(str::to_ascii_lowercase).collect::<Vec<_>>().join(" "))
        })
        .collect();
    if !ancestors.is_empty() {
        let sources: Vec<&str> = ancestors.iter().flat_map(|a| a.split_whitespace()).collect();
        return if sources.contains(&"*") {
            Framing::Allowed
        } else if sources.iter().all(|s| *s == "'none'" || *s == "'self'") {
            Framing::Blocked
        } else {
            Framing::Restricted
        };
    }
    if headers().any(|(name, _)| name.eq_ignore_ascii_case("x-frame-options")) {
        Framing::Blocked
    } else {
        Framing::Allowed
    }
}

impl Access {
    fn new(state: State, local_port: Option<u16>, reason: Option<String>) -> Self {
        Self { state, local_port, http_status: None, framing: None, reason, since: now() }
    }
}

/// The one challenge Core's listener answers for a service now. Each open
/// makes a new one and gives it, with its answer, only to the page that
/// opened the service. It is answered once, within PROOF_TTL, and only to a
/// request from that page's origin (none when the opener sent none); it goes
/// with the listener, so closing, deleting or a restart ends it.
struct Challenge {
    challenge: String,
    answer: String,
    origin: Option<String>,
    until: Instant,
    used: bool,
}
type Proof = Arc<Mutex<Challenge>>;

impl Challenge {
    fn new(origin: Option<&str>) -> Self {
        Self {
            challenge: uuid::Uuid::new_v4().simple().to_string(),
            answer: uuid::Uuid::new_v4().simple().to_string(),
            // An origin goes back in a response header: plain printable ASCII only.
            origin: origin.filter(|o| o.len() <= 256 && o.bytes().all(|b| b.is_ascii_graphic())).map(str::to_owned),
            until: Instant::now() + PROOF_TTL,
            used: false,
        }
    }
}

struct Open {
    generation: u64,
    connection: Access,
    /// Ends this service's listener, its connections and its SSH, and only them.
    stop: Option<oneshot::Sender<()>>,
    /// Where the listener relays to on this host: the service's own port, or
    /// the port of the SSH that forwards to it (which only Core connects to).
    upstream: u16,
    /// What this forward's SSH wrote (bounded), to tell why a check failed.
    stderr: Option<Arc<Mutex<String>>>,
    proof: Proof,
}

/// The services opened in this Core.
pub struct Runtime {
    open: Mutex<HashMap<String, Open>>,
    next: Mutex<u64>,
    /// One open or close at a time per Core: a check never races a close.
    gate: tokio::sync::Mutex<()>,
    ssh_program: Mutex<String>,
    ports: Mutex<RangeInclusive<u16>>,
    /// The port each service had last, kept while Core runs.
    assigned: Mutex<HashMap<String, u16>>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            open: Mutex::default(),
            next: Mutex::new(0),
            gate: tokio::sync::Mutex::new(()),
            ssh_program: Mutex::new("ssh".into()),
            ports: Mutex::new(port_range(std::env::var("YUZUNO_SERVICE_PORTS").ok().as_deref())),
            assigned: Mutex::default(),
        }
    }
}

/// `first-last` from YUZUNO_SERVICE_PORTS: unprivileged and at most 64 ports,
/// else the default range.
fn port_range(setting: Option<&str>) -> RangeInclusive<u16> {
    setting
        .and_then(|value| {
            let (first, last) = value.split_once('-')?;
            Some(first.trim().parse::<u16>().ok()?..=last.trim().parse::<u16>().ok()?)
        })
        .filter(|range| *range.start() >= 1024 && range.start() <= range.end() && range.end() - range.start() < 64)
        .unwrap_or(PORTS)
}

impl Runtime {
    /// A test's stand-in for OpenSSH (`ssh` conventions, see remote::ssh_with).
    #[cfg(test)]
    pub(crate) fn use_ssh(&self, program: &str) {
        *self.ssh_program.lock().unwrap() = program.into();
    }

    #[cfg(test)]
    pub(crate) fn use_ports(&self, ports: RangeInclusive<u16>) {
        *self.ports.lock().unwrap() = ports;
    }

    fn connection(&self, id: &str) -> Access {
        self.open.lock().unwrap().get(id).map(|o| o.connection.clone())
            .unwrap_or_else(|| Access::new(State::Closed, None, None))
    }

    fn generation(&self) -> u64 {
        let mut next = self.next.lock().unwrap();
        *next += 1;
        *next
    }

    fn set(&self, id: &str, generation: u64, connection: Access) {
        if let Some(open) = self.open.lock().unwrap().get_mut(id).filter(|o| o.generation == generation) {
            open.connection = connection;
        }
    }

    /// Ends this service's listener, connections and SSH, if any; never
    /// anything else.
    fn stop(&self, id: &str) {
        if let Some(mut open) = self.open.lock().unwrap().remove(id) {
            if let Some(stop) = open.stop.take() {
                let _ = stop.send(());
            }
        }
    }

    /// `stop`, for a service that no longer exists.
    fn forget(&self, id: &str) {
        self.stop(id);
        self.assigned.lock().unwrap().remove(id);
    }

    /// A port of the range for this service: the one it had last if it is
    /// free, else the first free one. Never the service's own port (a service
    /// on this host whose port is in the range would be relayed to itself).
    pub(crate) async fn listen(&self, id: &str, service_port: u16) -> std::result::Result<TcpListener, String> {
        let range = self.ports.lock().unwrap().clone();
        let last = self.assigned.lock().unwrap().get(id).copied();
        for port in last.into_iter().chain(range.clone()) {
            if !range.contains(&port) || port == service_port {
                continue;
            }
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
                self.assigned.lock().unwrap().insert(id.to_owned(), port);
                return Ok(listener);
            }
        }
        Err(format!("every port of the services' range 127.0.0.1:{}-{} is in use", range.start(), range.end()))
    }
}

/// What one HTTP request on the way found.
enum Probe {
    Http(u16, Framing),
    Refused(String),
    Silent(String),
}

/// One `GET path` on 127.0.0.1:port, judged by the first bytes of its answer.
/// Through an SSH forward a refused connection there arrives as a connection
/// closed before any byte (`forward_probe` tells that from a silent service).
async fn probe(port: u16, path: &str) -> Probe {
    let mut stream = match timeout(PROBE_TIMEOUT, TcpStream::connect(("127.0.0.1", port))).await {
        Err(_) => return Probe::Silent(format!("no TCP connection within {} s", PROBE_TIMEOUT.as_secs())),
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused =>
            return Probe::Refused(format!("nothing listens on 127.0.0.1:{port}")),
        Ok(Err(error)) => return Probe::Silent(error.to_string()),
        Ok(Ok(stream)) => stream,
    };
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: Yuzuno-service-check\r\nConnection: close\r\n\r\n");
    // Closed before any byte, gracefully or not: SSH resets a refused channel's
    // connection when the request is already there.
    let closed = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::BrokenPipe =>
            Probe::Silent(CLOSED.into()),
        _ => Probe::Silent(error.to_string()),
    };
    if let Err(error) = stream.write_all(request.as_bytes()).await {
        return closed(error);
    }
    // The status from the first bytes; the headers (for `framing`) as far as
    // they come whole, within the same time and at most 16 KiB.
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut head = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];
    loop {
        match tokio::time::timeout_at(deadline, stream.read(&mut buffer)).await {
            Err(_) if head.is_empty() => return Probe::Silent(format!("no HTTP response within {} s", PROBE_TIMEOUT.as_secs())),
            Ok(Err(error)) if head.is_empty() => return closed(error),
            Ok(Ok(0)) if head.is_empty() => return Probe::Silent(CLOSED.into()),
            Ok(Ok(n)) if n > 0 => {
                head.extend_from_slice(&buffer[..n]);
                if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() >= 16 * 1024 {
                    break;
                }
            }
            _ => break,
        }
    }
    let text = String::from_utf8_lossy(&head);
    let whole = text.find("\r\n\r\n").map(|end| &text[..end]);
    match text.strip_prefix("HTTP/").and_then(|rest| rest.split(' ').nth(1)).and_then(|code| code.parse().ok()) {
        Some(code) => Probe::Http(code, whole.map_or(Framing::Unknown, framing)),
        None => Probe::Silent("it answered, but not with HTTP".into()),
    }
}

fn judged(probe: Probe, local_port: u16) -> Access {
    match probe {
        Probe::Http(code, framing) => Access { http_status: Some(code), framing: Some(framing), ..Access::new(State::Available, Some(local_port), None) },
        Probe::Refused(reason) => Access::new(State::NotRunning, Some(local_port), Some(reason)),
        Probe::Silent(reason) => Access::new(State::NotReady, Some(local_port), Some(reason)),
    }
}

/// A free loopback port on the Core host for SSH's end, as the system picks
/// it. Never the service's own: when the Machine is this host too, that
/// would forward the port to itself.
async fn free_port(service: u16) -> Result<u16> {
    for _ in 0..4 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.context("no free loopback port on the Core host")?;
        let port = listener.local_addr()?.port();
        if port != service {
            return Ok(port);
        }
    }
    bail!("no free loopback port on the Core host")
}

/// SSH's own words for why it ended before listening.
fn ssh_failure(stderr: &str) -> (State, String) {
    let line = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("SSH ended").to_owned();
    if stderr.contains("Address already in use") || stderr.contains("cannot listen to port") {
        (State::PortInUse, line)
    } else if ["Permission denied", "Host key verification failed", "Could not resolve hostname", "Connection timed out",
        "Connection refused", "No route to host", "Network is unreachable", "Operation timed out"]
        .iter().any(|m| stderr.contains(m))
    {
        (State::MachineUnreachable, line)
    } else {
        (State::TunnelFailed, line)
    }
}

/// One connection to a service's port. The client speaks first (HTTP, a
/// WebSocket upgrade, TLS): Core reads only until the bytes leave the reserved
/// request's prefix, then relays everything, those bytes first, unchanged.
/// Only `GET /.well-known/yuzuno-service/<challenge>` is Core's own to answer.
async fn relay(mut client: TcpStream, upstream: u16, proof: Proof) {
    let mut first = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];
    loop {
        let n = match timeout(FIRST_BYTES, client.read(&mut buffer)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return,
            Ok(Ok(n)) => n,
        };
        first.extend_from_slice(&buffer[..n]);
        let shared = first.len().min(RESERVED.len());
        if first[..shared] != RESERVED[..shared] {
            break;
        }
        if first.len() >= RESERVED.len() {
            return answer(client, first, &proof).await;
        }
    }
    let Ok(mut server) = TcpStream::connect(("127.0.0.1", upstream)).await else { return };
    if server.write_all(&first).await.is_ok() {
        let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
    }
}

/// The reserved request: this open's answer, once, to the page that opened
/// it (its origin, readable there only), or 404 for anything else. It proves
/// only that this client's port reaches this Core. Never passed to the
/// service.
async fn answer(mut client: TcpStream, mut head: Vec<u8>, proof: &Proof) {
    let mut buffer = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match timeout(PROBE_TIMEOUT, client.read(&mut buffer)).await {
            Ok(Ok(n)) if n > 0 && head.len() < 8192 => head.extend_from_slice(&buffer[..n]),
            _ => return,
        }
    }
    let text = String::from_utf8_lossy(&head);
    let asked = text[RESERVED.len()..].split([' ', '\r']).next().unwrap_or_default();
    let origin = text.split("\r\n").skip(1)
        .find_map(|line| line.split_once(':').filter(|(name, _)| name.trim().eq_ignore_ascii_case("origin")))
        .map(|(_, value)| value.trim());
    let given = {
        let mut current = proof.lock().unwrap();
        let fits = !current.used && Instant::now() < current.until && asked == current.challenge
            && origin == current.origin.as_deref();
        current.used |= fits;
        fits.then(|| (current.answer.clone(), current.origin.clone()))
    };
    let response = match given {
        Some((answer, origin)) => format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n{}Cache-Control: no-store\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n{answer}",
            origin.map(|o| format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n")).unwrap_or_default(),
            answer.len()),
        None => "HTTP/1.1 404 Not Found\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    };
    let _ = client.write_all(response.as_bytes()).await;
    let _ = client.shutdown().await;
}

impl Workspace {
    /// A project's services with what is open for each now.
    pub async fn project_services(&self, project: &str) -> Result<Value> {
        let project = project.to_owned();
        let services = self.stored(move |s| s.services(&project)).await?;
        Ok(json!({"services": services.iter().map(|s| self.service_view(s)).collect::<Vec<_>>()}))
    }

    fn service_view(&self, service: &Service) -> Value {
        let mut view = serde_json::to_value(service).unwrap_or_default();
        view["connection"] = serde_json::to_value(self.services.connection(&service.id)).unwrap_or_default();
        view
    }

    /// A service on this host never names a port that is Yuzuno's own: Core's
    /// or one of the services' range (Core would relay it to itself).
    fn not_yuzunos(&self, machine: &str, port: u16) -> Result<()> {
        if machine != LOCAL {
            return Ok(());
        }
        let range = self.services.ports.lock().unwrap().clone();
        let core = self.collaboration_url.get().and_then(|url| url.rsplit(':').next()?.parse::<u16>().ok());
        ensure!(!range.contains(&port) && Some(port) != core,
            "invalid_service: port {port} on this host is Yuzuno's own (Core, or the services' range {}-{})", range.start(), range.end());
        Ok(())
    }

    pub async fn register_service(&self, project: &str, input: NewService, author: Value, request_id: Option<String>) -> Result<Value> {
        self.not_yuzunos(&input.machine_id, input.port)?;
        let project = project.to_owned();
        let service = self.stored(move |s| s.register_service(&project, &input, author, request_id.as_deref())).await?;
        self.projects_changed();
        Ok(self.service_view(&service))
    }

    /// Closes its way (never the service itself), then forgets it.
    pub async fn delete_service(&self, id: &str) -> Result<()> {
        let _gate = self.services.gate.lock().await;
        self.services.forget(id);
        let id = id.to_owned();
        self.stored(move |s| s.delete_service(&id)).await?;
        self.projects_changed();
        Ok(())
    }

    /// Deletes a project. Its services go with it (their rows by cascade), so
    /// whatever is open for them ends too, once the project is gone. The gate
    /// is held throughout: none of them opens meanwhile. A project that cannot
    /// be deleted keeps its services as they are.
    pub async fn delete_project(&self, project: &str) -> Result<()> {
        let _gate = self.services.gate.lock().await;
        let project = project.to_owned();
        let ids = self.stored(move |s| {
            let ids: Vec<String> = s.services(&project)?.into_iter().map(|service| service.id).collect();
            s.delete_project(&project)?;
            Ok(ids)
        }).await?;
        for id in ids {
            self.services.forget(&id);
        }
        self.projects_changed();
        Ok(())
    }

    pub async fn close_service(&self, id: &str) -> Result<Value> {
        let _gate = self.services.gate.lock().await;
        let service = { let id = id.to_owned(); self.stored(move |s| s.service(&id)).await? };
        self.services.stop(id);
        self.projects_changed();
        Ok(self.service_view(&service))
    }

    /// The user's request to reach a service: Core listens on a port of the
    /// services' range and relays it to the service (over the machine's SSH
    /// for an SSH machine's), then checks once that it answers HTTP. A way
    /// still open is checked again, not replaced. Only an HTTP answer is
    /// `available`; a live SSH is not. The reply alone carries a new
    /// challenge and its answer for the page (`origin`, from the request) to
    /// check once that its client reaches this port of this Core (`proof`).
    pub async fn open_service(self: &Arc<Self>, id: &str, origin: Option<&str>) -> Result<Value> {
        let _gate = self.services.gate.lock().await;
        let service = { let id = id.to_owned(); self.stored(move |s| s.service(&id)).await? };
        // The range may have changed since it was registered.
        self.not_yuzunos(&service.machine_id, service.port)?;
        let fresh = Challenge::new(origin);
        let pair = (fresh.challenge.clone(), fresh.answer.clone());
        let running = self.services.open.lock().unwrap().get(id)
            .filter(|o| o.stop.is_some())
            .and_then(|o| o.connection.local_port.map(|port| (o.generation, port, o.upstream, o.stderr.clone(), o.proof.clone())));
        match running {
            Some((generation, port, upstream, stderr, kept)) => {
                *kept.lock().unwrap() = fresh;
                let checked = judged(forward_probe(upstream, &service.path, stderr.as_deref()).await, port);
                self.services.set(id, generation, checked);
            }
            None => {
                self.services.stop(id);
                let generation = self.services.generation();
                let failed = match self.services.listen(id, service.port).await {
                    Err(reason) => Some(Access::new(State::PortInUse, None, Some(reason))),
                    Ok(listener) => {
                        let port = listener.local_addr()?.port();
                        let way = if service.machine_id == LOCAL {
                            Ok((service.port, None))
                        } else {
                            let machine = { let m = service.machine_id.clone(); self.stored(move |s| s.machine(&m)).await? };
                            self.forward(&service, &machine).await?
                                .map(|(upstream, child, stderr)| (upstream, Some((child, stderr))))
                        };
                        match way {
                            // The listener closes here: nothing listens for a way that failed.
                            Err(failed) => Some(failed),
                            Ok((upstream, ssh)) => {
                                let kept: Proof = Arc::new(Mutex::new(fresh));
                                let (stop, stopped) = oneshot::channel();
                                let stderr = ssh.as_ref().map(|(_, stderr)| stderr.clone());
                                self.services.open.lock().unwrap().insert(id.to_owned(), Open {
                                    generation,
                                    connection: Access::new(State::Opening, Some(port), None),
                                    stop: Some(stop),
                                    upstream,
                                    stderr: stderr.clone(),
                                    proof: kept.clone(),
                                });
                                self.serve(id.to_owned(), generation, listener, upstream, kept, stopped, ssh);
                                let checked = judged(forward_probe(upstream, &service.path, stderr.as_deref()).await, port);
                                self.services.set(id, generation, checked);
                                None
                            }
                        }
                    }
                };
                if let Some(failed) = failed {
                    // Nothing is open; what was tried is shown until the next attempt.
                    self.services.open.lock().unwrap().insert(id.to_owned(), Open {
                        generation, connection: failed, stop: None, upstream: 0, stderr: None,
                        proof: Arc::new(Mutex::new(Challenge::new(None))),
                    });
                }
            }
        }
        self.projects_changed();
        let mut view = self.service_view(&service);
        if view["connection"]["localPort"].is_u64() {
            view["proof"] = json!({"challenge": pair.0, "answer": pair.1});
        }
        Ok(view)
    }

    /// `ssh -L 127.0.0.1:Q:127.0.0.1:PORT target HOLD`, retried once on
    /// another port when Q was taken meanwhile: Q, the running SSH and its
    /// diagnostic, else what stopped it before it listened.
    async fn forward(&self, service: &Service, machine: &RemoteMachine)
        -> Result<std::result::Result<(u16, tokio::process::Child, Arc<Mutex<String>>), Access>> {
        crate::remote::validate_machine(machine)?;
        let mut taken = String::new();
        for _attempt in 0..2 {
            let port = free_port(service.port).await?;
            let program = self.services.ssh_program.lock().unwrap().clone();
            // stdin stays with the child: Core's end of it is the forward's life.
            let mut child = crate::remote::ssh_with(&program)
                .args(["-o", "ExitOnForwardFailure=yes", "-o", "GatewayPorts=no", "-L"])
                .arg(format!("127.0.0.1:{port}:127.0.0.1:{}", service.port))
                .arg(&machine.target)
                .arg(HOLD)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .context("SSH could not be started on the Core host")?;
            // Drained at once; only a bounded diagnostic is kept.
            let stderr = Arc::new(Mutex::new(String::new()));
            let drained = child.stderr.take().map(|mut pipe| {
                let kept = stderr.clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 1024];
                    while let Ok(n) = pipe.read(&mut buffer).await {
                        if n == 0 { break; }
                        let mut kept = kept.lock().unwrap();
                        if kept.len() < STDERR_LIMIT {
                            kept.push_str(&String::from_utf8_lossy(&buffer[..n]));
                        }
                    }
                })
            });
            let stdout = child.stdout.take().context("SSH stdout unavailable")?;
            match timeout(OPEN_TIMEOUT, ready(stdout)).await {
                Ok(true) => return Ok(Ok((port, child, stderr))),
                Ok(false) => {
                    // SSH ended (or the remote command did not run): its last words say why.
                    let _ = timeout(Duration::from_secs(2), child.wait()).await;
                    let _ = child.kill().await;
                    if let Some(drained) = drained {
                        let _ = timeout(Duration::from_secs(1), drained).await;
                    }
                    let (state, reason) = ssh_failure(&stderr.lock().unwrap());
                    if state == State::PortInUse {
                        taken = reason;
                        continue;
                    }
                    return Ok(Err(Access::new(state, None, Some(reason))));
                }
                Err(_) => {
                    let _ = child.kill().await;
                    return Ok(Err(Access::new(State::TunnelFailed, None,
                        Some(format!("SSH did not get ready within {} s", OPEN_TIMEOUT.as_secs())))));
                }
            }
        }
        Ok(Err(Access::new(State::PortInUse, None, Some(format!("two local ports were taken while SSH started: {taken}")))))
    }

    /// The service's way while it is open: Core's listener and every
    /// connection it relays, and the SSH (if any). All of it ends when the
    /// user closes it, or when SSH ends on its own (`disconnected`, with SSH's
    /// reason); it is all this Core's own, so it also ends with Core.
    fn serve(self: &Arc<Self>, id: String, generation: u64, listener: TcpListener, upstream: u16, proof: Proof,
        stopped: oneshot::Receiver<()>, ssh: Option<(tokio::process::Child, Arc<Mutex<String>>)>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let (mut child, stderr) = match ssh {
                Some((child, stderr)) => (Some(child), Some(stderr)),
                None => (None, None),
            };
            // Held here, apart from the child: `wait` would close it, and SSH's
            // remote command ends at its EOF.
            let hold = child.as_mut().and_then(|c| c.stdin.take());
            let mut connections = tokio::task::JoinSet::new();
            let ended = {
                let ssh_ended = async {
                    match child.as_mut() {
                        Some(child) => child.wait().await.ok(),
                        None => std::future::pending().await,
                    }
                };
                tokio::pin!(ssh_ended, stopped);
                loop {
                    tokio::select! {
                        _ = &mut stopped => break None,
                        status = &mut ssh_ended => break Some(status),
                        accepted = listener.accept() => {
                            if let Ok((client, _)) = accepted {
                                connections.spawn(relay(client, upstream, proof.clone()));
                            }
                        }
                        Some(_) = connections.join_next(), if !connections.is_empty() => {}
                    }
                }
            };
            drop(listener);
            connections.abort_all();
            if let Some(child) = child.as_mut() {
                let _ = child.kill().await;
            }
            drop(hold);
            let (Some(status), Some(ws)) = (ended, weak.upgrade()) else { return };
            let reason = stderr.as_ref().and_then(|s| s.lock().unwrap().lines().map(str::trim).filter(|l| !l.is_empty()).last().map(str::to_owned))
                .unwrap_or_else(|| format!("SSH ended ({})", status.map(|s| s.to_string()).unwrap_or_default()));
            if let Some(open) = ws.services.open.lock().unwrap().get_mut(&id).filter(|o| o.generation == generation) {
                open.stop = None;
                open.connection = Access::new(State::Disconnected, None, Some(reason));
            }
            ws.projects_changed();
        });
    }
}

/// Whether the remote command said it runs, which SSH starts only after its
/// forwards listen. A shell's start-up files may print first (bounded); the
/// rest of stdout is drained so it never blocks SSH.
async fn ready(stdout: tokio::process::ChildStdout) -> bool {
    let mut lines = BufReader::new(stdout).lines();
    for _ in 0..64 {
        match lines.next_line().await {
            Ok(Some(line)) if line.trim() == READY => {
                tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
                return true;
            }
            Ok(Some(_)) => continue,
            _ => return false,
        }
    }
    false
}

/// `probe` on the way's upstream. Through an SSH forward a connection that
/// closes before any byte is SSH refusing it: "open failed" names nothing
/// listening on the service's port (SSH writes it just after closing the
/// connection). Without SSH (`stderr` None) it is `probe` as is.
async fn forward_probe(port: u16, path: &str, stderr: Option<&Mutex<String>>) -> Probe {
    let before = stderr.map_or(0, |s| s.lock().unwrap().len());
    match probe(port, path).await {
        Probe::Silent(reason) if reason == CLOSED && stderr.is_some() => {
            let refused = || stderr.and_then(|s| {
                let text = s.lock().unwrap();
                text.get(before.min(text.len())..).unwrap_or_default().lines()
                    .find(|l| l.contains("open failed")).map(|l| l.trim().to_owned())
            });
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                if let Some(line) = refused() {
                    return Probe::Refused(line);
                }
                if Instant::now() >= deadline {
                    return Probe::Silent(reason);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        other => other,
    }
}

const REGISTER: &str = "service_register";
const LIST: &str = "services_list";

pub(crate) fn tool_definitions() -> Vec<Value> {
    let project = json!({"type":"string","description":"Project ID from projects_list. Omit for your own Project."});
    vec![
        json!({"name":LIST,
            "description":"List a Project's registered web services (a dev server, Jupyter, TensorBoard on one of its Machines) and what is open for each now: closed, available (it answered HTTP), notRunning, notReady, portInUse, machineUnreachable, tunnelFailed or disconnected. Only the user opens or closes one.",
            "inputSchema":{"type":"object","properties":{"projectId":project},"additionalProperties":false}}),
        json!({"name":REGISTER,
            "description":"Register a web service that already runs on one of your Project's Machines, so the user can open it from the Project. It names the Machine (local for the Core host, or a registered SSH machine; not windows), the port the service listens on there, on its loopback, and the path to open. Registering opens nothing: the user opens it, which forwards one loopback port over that machine's SSH and checks that it answers HTTP. Yuzuno never starts, stops or scans a service. Never put a token or password in the path: every Agent can read it. Retry a lost reply with the same requestId.",
            "inputSchema":{"type":"object","properties":{
                "requestId":{"type":"string","minLength":1,"maxLength":128},
                "projectId":project,
                "name":{"type":"string","minLength":1,"maxLength":80},
                "machineId":{"type":"string"},
                "port":{"type":"integer","minimum":1,"maximum":65535},
                "path":{"type":"string","default":"/","description":"Starts with /, e.g. / or /lab"}},
                "required":["requestId","name","machineId","port"],"additionalProperties":false}}),
    ]
}

/// An Agent's services_list or service_register.
pub async fn call(ws: Arc<Workspace>, actor: Option<String>, operation: String, mut input: Value) -> Result<Value> {
    ensure!(input.is_object(), "invalid_input: expected an object");
    let project = match input.get("projectId").and_then(Value::as_str) {
        Some(project) => project.to_owned(),
        None => {
            let agent = actor.clone().context("invalid_input: name the projectId")?;
            ws.stored(move |s| crate::projects::agent_project(&*s.db.read()?, &agent)).await?
                .context("invalid_input: you are in no Project; name the projectId")?
        }
    };
    match operation.as_str() {
        LIST => ws.project_services(&project).await,
        REGISTER => {
            let agent = actor.context("agent_only: the user registers services from the Project")?;
            let request_id = input["requestId"].as_str().filter(|r| !r.is_empty() && r.len() <= 128)
                .context("invalid_input: requestId is required")?.to_owned();
            let object = input.as_object_mut().unwrap();
            object.remove("requestId");
            object.remove("projectId");
            let new: NewService = serde_json::from_value(input).context("invalid_input")?;
            let name = { let a = agent.clone(); ws.stored(move |s| s.agent(&a)).await?.name };
            ws.register_service(&project, new, json!({"kind":"agent","id":agent,"name":name}), Some(request_id)).await
        }
        _ => bail!("unknown_operation: {operation}"),
    }
}

#[cfg(test)]
#[path = "services_tests.rs"]
mod tests;
