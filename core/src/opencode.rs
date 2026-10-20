//! OpenCode (T-110 S1a) through its own server, `opencode serve`: one process
//! per Agent on this host's loopback, behind a password only Core holds. This
//! is the transport alone. No Agent uses it yet, nothing in the Workspace calls
//! it, and it adds no permission rule of its own.
//!
//! The protocol is the one read from OpenCode 1.19.3 (`VERSION`); a server
//! that reports another version is stopped. Native requests, events and
//! results come back as OpenCode sent them. What OpenCode did not say is not
//! decided here: an accepted prompt (204) is not yet a stored message, a
//! message not found is not proof it was not delivered, and no message is
//! ever sent twice.
//!
//! The event stream has no replay (its events carry no SSE `id`). After a
//! break, subscribe again and then read a `snapshot`: OpenCode registers a
//! subscriber before it sends `server.connected`, so what happened after that
//! is either in the snapshot or still to come as an event, possibly both.
//!
//! OpenCode runs in a process group of its own, so its own children (language
//! servers, local MCP servers) end with it: on `shutdown`, or when the
//! `Server` is dropped.
use anyhow::{anyhow, bail, ensure, Context, Result};
use reqwest::{Method, Response, Url};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fmt,
    path::PathBuf,
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{timeout, Instant},
};

/// The release whose server protocol this module speaks.
pub const VERSION: &str = "1.19.3";
/// OpenCode's default Basic user, set explicitly so that an inherited
/// `OPENCODE_SERVER_USERNAME` cannot change it.
const USERNAME: &str = "opencode";
const START_LIMIT: Duration = Duration::from_secs(30);
const REQUEST_LIMIT: Duration = Duration::from_secs(15);
const GRACE: Duration = Duration::from_secs(3);
/// OpenCode sends `server.heartbeat` every 10 s on an open stream.
pub const EVENT_IDLE_LIMIT: Duration = Duration::from_secs(30);
const BODY_LIMIT: usize = 2048;
const EVENT_BUFFER_LIMIT: usize = 16 << 20;

/// What one Agent's server is started with.
pub struct Launch {
    /// The `opencode` executable.
    pub program: PathBuf,
    /// The Agent's folder: the server's working directory, and the instance
    /// every request names.
    pub directory: PathBuf,
    /// This Agent's own session database (`OPENCODE_DB`), an absolute path.
    pub database: PathBuf,
}

/// A non-2xx answer, as OpenCode gave it (its body shortened).
#[derive(Debug, Clone, PartialEq)]
pub struct HttpStatus {
    pub code: u16,
    pub body: String,
}

impl fmt::Display for HttpStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OpenCode answered HTTP {}: {}", self.code, self.body)
    }
}

impl std::error::Error for HttpStatus {}

/// What a prompt submission is known to have done.
#[derive(Debug, PartialEq)]
pub enum Submission {
    /// 204: OpenCode started on the prompt. Not proof that the message was
    /// stored: OpenCode answers first and stores it afterwards, which can
    /// still fail (`handlers/session.ts`, `promptAsync`).
    Accepted,
    /// A 4xx: OpenCode refused the request before taking it (an unknown
    /// session, an invalid body, wrong credentials).
    Refused(HttpStatus),
    /// No answer, a lost connection, a 5xx or an unexpected status: it may
    /// or may not have been taken. Look for its ID; never send it again.
    Unknown(String),
}

/// An answer to a permission request. OpenCode's third answer, `always`,
/// is not offered: it would allow later requests of this process by patterns
/// the tool chooses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reply {
    Once,
    Reject,
}

/// Whether OpenCode reached an MCP server.
#[derive(Debug, PartialEq)]
pub enum Mcp {
    Connected,
    /// Any other status (`failed`, `needs_auth`, `disabled`, …) or none, as
    /// OpenCode reported it.
    NotConnected(Value),
}

/// What OpenCode holds for one session now.
#[derive(Debug)]
pub struct Snapshot {
    /// `[{info, parts}]`, as `GET /session/:id/message` lists them.
    pub messages: Value,
    /// `{type: busy | retry | idle, …}`. OpenCode lists only sessions that
    /// are not idle (`session/status.ts`), so an unlisted one is idle.
    pub status: Value,
    /// Requests pending in this session; other sessions' are left out.
    pub permissions: Vec<Value>,
    pub questions: Vec<Value>,
}

/// A message ID in OpenCode's own form: `msg_`, 12 hex digits of
/// `ms × 4096 + n`, 14 base62 characters (`schema/src/identifier.ts`).
/// OpenCode orders messages by the time it stores them, so the ID only has to
/// be new. A message keeps its ID: the same ID sent again would replace the
/// stored message and run the session again.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MessageId(String);

impl MessageId {
    pub fn new() -> Self {
        static LAST: Mutex<(u64, u64)> = Mutex::new((0, 0));
        const CHARS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let n = {
            let mut last = LAST.lock().unwrap();
            if last.0 != now {
                *last = (now, 0);
            }
            last.1 += 1;
            last.1
        };
        let value = now.wrapping_mul(0x1000).wrapping_add(n) & 0xffff_ffff_ffff;
        // The bytes of a v4 UUID that hold no version or variant bits.
        let random = uuid::Uuid::new_v4().into_bytes();
        let tail: String = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15]
            .iter()
            .map(|&i| CHARS[random[i] as usize % 62] as char)
            .collect();
        Self(format!("msg_{value:012x}{tail}"))
    }

    /// An ID made by `new` and kept, read back.
    pub fn parse(id: &str) -> Result<Self> {
        let b = id.as_bytes();
        let valid = b.len() == 30
            && b.starts_with(b"msg_")
            && b[4..16].iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && b[16..].iter().all(u8::is_ascii_alphanumeric);
        ensure!(valid, "Not an OpenCode message ID made by Yuzuno: {id}");
        Ok(Self(id.into()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for MessageId {
    fn default() -> Self {
        Self::new()
    }
}

/// OpenCode's process group, whose ID is OpenCode's PID. It is signalled only
/// while that process is not yet reaped, so the ID cannot be anyone else's.
struct Group(Option<u32>);

impl Group {
    fn signal(&self, kill: bool) {
        #[cfg(unix)]
        if let Some(pid) = self.0.and_then(|pid| rustix::process::Pid::from_raw(pid as i32)) {
            let signal = if kill { rustix::process::Signal::KILL } else { rustix::process::Signal::TERM };
            let _ = rustix::process::kill_process_group(pid, signal);
        }
        #[cfg(not(unix))]
        let _ = kill;
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.signal(true);
    }
}

/// One Agent's running `opencode serve`.
pub struct Server {
    // Before `child`: dropped first, while OpenCode is not yet reaped.
    group: Group,
    child: Child,
    base: String,
    password: String,
    directory: String,
    http: reqwest::Client,
    submitted: Mutex<HashSet<MessageId>>,
}

impl Server {
    /// Starts OpenCode on 127.0.0.1 with a new password and waits until it
    /// listens and reports `VERSION`. On any failure, what it started is ended.
    pub async fn start(launch: &Launch) -> Result<Self> {
        ensure!(launch.database.is_absolute(), "The OpenCode database path must be absolute");
        ensure!(launch.directory.is_absolute() && launch.directory.is_dir(),
            "The Agent's folder must be an existing absolute path");
        let directory = launch.directory.to_str().context("The Agent's folder is not valid UTF-8")?.to_owned();
        let password = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let mut command = Command::new(&launch.program);
        // Every network option is explicit: the user's `server` settings
        // (hostname, port, mDNS) apply only to options not given (cli/network.ts).
        command
            .args(["serve", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"])
            .current_dir(&launch.directory)
            .env("OPENCODE_SERVER_USERNAME", USERNAME)
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .env("OPENCODE_DB", &launch.database)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .context("Could not start OpenCode: install the official OpenCode CLI on the Core host")?;
        let stdout = child.stdout.take().context("OpenCode's output is unavailable")?;
        let mut server = Self {
            group: Group(child.id()),
            child,
            base: String::new(),
            password,
            directory,
            // Never through a proxy: the password goes to loopback only.
            http: reqwest::Client::builder().no_proxy().build()?,
            submitted: Mutex::default(),
        };
        // From here on, an error drops `server`, which ends its group.
        let mut lines = BufReader::new(stdout).lines();
        server.base = timeout(START_LIMIT, async {
            while let Some(line) = lines.next_line().await? {
                if let Some(base) = listening(&line)? {
                    return Ok::<_, anyhow::Error>(base);
                }
            }
            bail!("OpenCode exited before it was listening")
        })
        .await
        .map_err(|_| anyhow!("OpenCode was not listening after {}s", START_LIMIT.as_secs()))??;
        // Its later output is not read, only drained so it never blocks.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        let health = server.json(Method::GET, "/global/health", None).await?;
        let version = health["version"].as_str().unwrap_or_default();
        ensure!(health["healthy"] == true && version == VERSION,
            "OpenCode {version} is not supported: Yuzuno speaks the server protocol of OpenCode {VERSION}");
        Ok(server)
    }

    /// Ends OpenCode and its own children: SIGTERM to the group, up to 3 s
    /// for OpenCode to finish, then SIGKILL to whatever of it is left.
    pub async fn shutdown(mut self) -> Result<()> {
        #[cfg(unix)]
        {
            self.group.signal(false);
            let deadline = Instant::now() + GRACE;
            while !self.exited() && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            self.group.signal(true);
        }
        #[cfg(not(unix))]
        let _ = self.child.start_kill();
        let waited = self.child.wait().await;
        // Reaped: the group's ID may now be reused, so it is not signalled again.
        self.group.0 = None;
        waited.context("OpenCode did not end")?;
        Ok(())
    }

    /// Whether OpenCode has exited, without reaping it.
    #[cfg(unix)]
    fn exited(&self) -> bool {
        use rustix::process::{waitid, Pid, WaitId, WaitIdOptions};
        let Some(pid) = self.group.0.and_then(|pid| Pid::from_raw(pid as i32)) else { return true };
        let options = WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG;
        !matches!(waitid(WaitId::Pid(pid), options), Ok(None))
    }

    /// A new session; OpenCode's record of it (its `id` names it).
    pub async fn create_session(&self, title: &str) -> Result<Value> {
        let session = self.json(Method::POST, "/session", Some(&json!({"title": title}))).await?;
        segment(session["id"].as_str().unwrap_or_default()).context("OpenCode created a session without a usable ID")?;
        Ok(session)
    }

    /// Sends one text prompt under `id`, once: an ID this server was given
    /// before is refused here, whatever became of it.
    pub async fn submit(&self, session: &str, id: &MessageId, text: &str) -> Result<Submission> {
        let path = format!("/session/{}/prompt_async", segment(session)?);
        ensure!(self.submitted.lock().unwrap().insert(id.clone()),
            "Message {} was submitted already; it is never sent again", id.as_str());
        let body = json!({"messageID": id.as_str(), "parts": [{"type": "text", "text": text}]});
        let sent = self.request(Method::POST, &path).timeout(REQUEST_LIMIT).json(&body).send().await;
        Ok(match sent {
            Err(error) => Submission::Unknown(format!("OpenCode did not answer: {error}")),
            Ok(response) if response.status().as_u16() == 204 => Submission::Accepted,
            Ok(response) if response.status().is_client_error() => Submission::Refused(status(response).await),
            Ok(response) => Submission::Unknown(status(response).await.to_string()),
        })
    }

    /// The stored message with this ID, or `None` while OpenCode has none.
    /// After a 204 the message is stored a moment later, so `None` is not
    /// proof that it was not delivered. A session OpenCode does not know is
    /// an error, not a `None`.
    pub async fn message(&self, session: &str, id: &MessageId) -> Result<Option<Value>> {
        let path = format!("/session/{}/message/{}", segment(session)?, segment(id.as_str())?);
        match self.json(Method::GET, &path, None).await {
            Ok(message) => Ok(Some(message)),
            Err(error) if error.downcast_ref::<HttpStatus>().is_some_and(|s| s.code == 404) => {
                // The same 404 answers for an unknown session.
                self.json(Method::GET, &format!("/session/{session}"), None).await?;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Opens the event stream and reads up to its `server.connected`.
    /// `idle_limit` bounds a silence (normally `EVENT_IDLE_LIMIT`).
    pub async fn subscribe(&self, idle_limit: Duration) -> Result<Events> {
        // Not the request's own timeout: that would also end the stream.
        let sent = self.request(Method::GET, "/event").header("accept", "text/event-stream").send();
        let response = timeout(REQUEST_LIMIT, sent).await
            .map_err(|_| anyhow!("OpenCode did not answer /event"))?
            .context("OpenCode did not answer /event")?;
        let response = success(response).await?;
        let mut events = Events { response, buffer: Vec::new(), scanned: 0, idle_limit };
        let first = events.next().await?.context("OpenCode closed its event stream at once")?;
        ensure!(first["type"] == "server.connected", "OpenCode's event stream did not begin with server.connected");
        Ok(events)
    }

    /// The session's messages, status and pending requests, read now.
    pub async fn snapshot(&self, session: &str) -> Result<Snapshot> {
        let messages = self.json(Method::GET, &format!("/session/{}/message", segment(session)?), None).await?;
        let statuses = self.json(Method::GET, "/session/status", None).await?;
        let status = statuses.get(session).cloned().unwrap_or_else(|| json!({"type": "idle"}));
        Ok(Snapshot {
            messages,
            status,
            permissions: self.pending("/permission", session).await?,
            questions: self.pending("/question", session).await?,
        })
    }

    /// Answers a permission request pending in `session`. A request of
    /// another session, or no longer pending, is refused without an answer.
    /// OpenCode's rule: rejecting one rejects every other request then
    /// pending in the same session (`permission/index.ts`).
    pub async fn reply_permission(&self, session: &str, request: &str, reply: Reply) -> Result<()> {
        self.ensure_pending("/permission", session, request).await?;
        let reply = match reply { Reply::Once => "once", Reply::Reject => "reject" };
        self.json(Method::POST, &format!("/permission/{}/reply", segment(request)?), Some(&json!({"reply": reply}))).await?;
        Ok(())
    }

    /// Answers a question pending in `session`: for each of its questions,
    /// the labels chosen (or typed).
    pub async fn reply_question(&self, session: &str, request: &str, answers: &[Vec<String>]) -> Result<()> {
        self.ensure_pending("/question", session, request).await?;
        self.json(Method::POST, &format!("/question/{}/reply", segment(request)?), Some(&json!({"answers": answers}))).await?;
        Ok(())
    }

    pub async fn reject_question(&self, session: &str, request: &str) -> Result<()> {
        self.ensure_pending("/question", session, request).await?;
        self.json(Method::POST, &format!("/question/{}/reject", segment(request)?), None).await?;
        Ok(())
    }

    /// Asks OpenCode to stop the session's run. Its answer is not the end of
    /// the run: that is the session's status and messages, by event or snapshot.
    pub async fn abort(&self, session: &str) -> Result<()> {
        self.json(Method::POST, &format!("/session/{}/abort", segment(session)?), None).await?;
        Ok(())
    }

    /// Adds a remote MCP server to this instance, held in OpenCode's memory
    /// only (no config file), with OAuth discovery off.
    pub async fn add_mcp(&self, name: &str, url: &str, bearer: &str) -> Result<Mcp> {
        let config = json!({"type": "remote", "url": url, "oauth": false,
            "headers": {"Authorization": format!("Bearer {bearer}")}});
        let statuses = self.json(Method::POST, "/mcp", Some(&json!({"name": name, "config": config}))).await?;
        Ok(mcp_state(&statuses[name]))
    }

    pub async fn mcp(&self, name: &str) -> Result<Mcp> {
        Ok(mcp_state(&self.json(Method::GET, "/mcp", None).await?[name]))
    }

    async fn pending(&self, path: &str, session: &str) -> Result<Vec<Value>> {
        let all = self.json(Method::GET, path, None).await?;
        let all = all.as_array().with_context(|| format!("OpenCode's {path} is not a list"))?;
        Ok(all.iter().filter(|r| r["sessionID"] == session).cloned().collect())
    }

    async fn ensure_pending(&self, path: &str, session: &str, request: &str) -> Result<()> {
        let pending = self.pending(path, session).await?;
        ensure!(pending.iter().any(|r| r["id"] == request),
            "Request {request} is not pending in session {session}; it was not answered");
        Ok(())
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let mut url = Url::parse(&format!("{}{path}", self.base)).expect("an OpenCode path");
        // The query rather than `x-opencode-directory`: a folder need not be
        // a valid header value (server/.../middleware/workspace-routing.ts).
        url.query_pairs_mut().append_pair("directory", &self.directory);
        self.http.request(method, url).basic_auth(USERNAME, Some(&self.password))
    }

    async fn json(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut request = self.request(method, path).timeout(REQUEST_LIMIT);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.with_context(|| format!("OpenCode did not answer {path}"))?;
        success(response).await?.json().await.with_context(|| format!("OpenCode's answer to {path} is not JSON"))
    }
}

/// OpenCode's event stream.
pub struct Events {
    response: Response,
    buffer: Vec<u8>,
    /// Where in `buffer` the end of the next event is still to be looked for.
    scanned: usize,
    idle_limit: Duration,
}

impl Events {
    /// The next event as OpenCode sent it (`{id, type, properties}`), without
    /// heartbeats. `Ok(None)`: OpenCode ended the stream. An error: it broke,
    /// sent something that is not an event, or was silent past the idle
    /// limit. Either way events may have been missed; subscribe again, then
    /// read a snapshot.
    pub async fn next(&mut self) -> Result<Option<Value>> {
        loop {
            while let Some(data) = frame(&mut self.buffer, &mut self.scanned)? {
                let Some(data) = data else { continue };
                let event: Value = serde_json::from_str(&data).context("OpenCode sent an event that is not JSON")?;
                if event["type"] != "server.heartbeat" {
                    return Ok(Some(event));
                }
            }
            let chunk = timeout(self.idle_limit, self.response.chunk()).await
                .map_err(|_| anyhow!("OpenCode's event stream was silent for {:?}", self.idle_limit))?
                .context("OpenCode's event stream broke")?;
            let Some(chunk) = chunk else { return Ok(None) };
            self.buffer.extend_from_slice(&chunk);
            ensure!(self.buffer.len() <= EVENT_BUFFER_LIMIT, "OpenCode sent an event larger than 16 MiB");
        }
    }
}

/// The session an event belongs to: every session event names it as
/// `properties.sessionID` (`schema/src/v1/session.ts`, permission, question).
pub fn session_of(event: &Value) -> Option<&str> {
    event["properties"]["sessionID"].as_str()
}

/// The base URL from `opencode server listening on http://HOST:PORT`
/// (cli/cmd/serve.ts). Only 127.0.0.1, the address Core asked for, is used.
fn listening(line: &str) -> Result<Option<String>> {
    let Some(address) = line.trim().strip_prefix("opencode server listening on ") else { return Ok(None) };
    let (host, port) = address.strip_prefix("http://").and_then(|a| a.rsplit_once(':'))
        .with_context(|| format!("OpenCode reported an address Yuzuno does not read: {address}"))?;
    ensure!(host == "127.0.0.1", "OpenCode listened on {host}, not on this host's loopback; it was stopped");
    let port = port.parse::<u16>().ok().filter(|p| *p > 0)
        .with_context(|| format!("OpenCode reported an invalid port: {port}"))?;
    Ok(Some(format!("http://127.0.0.1:{port}")))
}

/// Takes one complete event off the front of `buffer`: `Some(data)` (`None`
/// for an event without data, such as a comment), or nothing yet. The lines
/// before `scanned` are known not to end the event, so a large event arriving
/// in many chunks is read through once.
fn frame(buffer: &mut Vec<u8>, scanned: &mut usize) -> Result<Option<Option<String>>> {
    while let Some(end) = buffer[*scanned..].iter().position(|b| *b == b'\n').map(|i| *scanned + i) {
        let line = &buffer[*scanned..end];
        if !line.is_empty() && line != b"\r" {
            *scanned = end + 1;
            continue;
        }
        let data = data(&buffer[..*scanned])?;
        buffer.drain(..=end);
        *scanned = 0;
        return Ok(Some(data));
    }
    Ok(None)
}

/// The `data` of one event's lines. `id`, `event` and `retry` carry nothing
/// OpenCode uses; a line with an empty field is a comment.
fn data(lines: &[u8]) -> Result<Option<String>> {
    let mut data: Option<String> = None;
    for line in lines.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let line = std::str::from_utf8(line).context("OpenCode sent an event that is not UTF-8")?;
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        if field == "data" {
            let value = value.strip_prefix(' ').unwrap_or(value);
            match &mut data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => data = Some(value.into()),
            }
        }
    }
    Ok(data)
}

/// An ID OpenCode made, checked before it becomes a path segment.
fn segment(id: &str) -> Result<&str> {
    ensure!(!id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Not an OpenCode ID: {id:?}");
    Ok(id)
}

fn mcp_state(status: &Value) -> Mcp {
    if status["status"] == "connected" { Mcp::Connected } else { Mcp::NotConnected(status.clone()) }
}

async fn success(response: Response) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    Err(status(response).await.into())
}

async fn status(response: Response) -> HttpStatus {
    let code = response.status().as_u16();
    let mut body = response.text().await.unwrap_or_default();
    if body.len() > BODY_LIMIT {
        let mut end = BODY_LIMIT;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
        body.push('…');
    }
    HttpStatus { code, body }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_loopback_listening_line_gives_an_address() {
        assert_eq!(listening("opencode server listening on http://127.0.0.1:4096").unwrap().as_deref(), Some("http://127.0.0.1:4096"));
        assert_eq!(listening("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.").unwrap(), None);
        for line in ["opencode server listening on http://0.0.0.0:4096", "opencode server listening on http://[::1]:4096",
            "opencode server listening on http://127.0.0.1:0", "opencode server listening on https://127.0.0.1:4096",
            "opencode server listening on http://127.0.0.1.example:4096"] {
            assert!(listening(line).is_err(), "{line}");
        }
    }

    #[test]
    fn events_are_framed_across_chunks_lines_and_comments() {
        let mut scanned = 0;
        let mut buffer = b": hello\r\n\r\ndata: {\"type\":\"a\"}\n\nda".to_vec();
        assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), Some(None));
        assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), Some(Some("{\"type\":\"a\"}".into())));
        assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), None, "an unfinished event waits");
        for chunk in [&b"ta: one\nda"[..], b"ta:two\r", b"\nid: 7\nevent: message\n", b"\n"] {
            assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), None);
            buffer.extend_from_slice(chunk);
        }
        assert_eq!(frame(&mut buffer, &mut scanned).unwrap(), Some(Some("one\ntwo".into())));
        assert!(buffer.is_empty() && scanned == 0);
        let mut broken = b"data: \xff\n\n".to_vec();
        assert!(frame(&mut broken, &mut 0).is_err());
    }

    #[test]
    fn message_ids_have_opencodes_form_and_do_not_repeat() {
        let ids: Vec<MessageId> = (0..5000).map(|_| MessageId::new()).collect();
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len());
        for id in &ids[..50] {
            assert_eq!(MessageId::parse(id.as_str()).unwrap(), *id);
        }
        for bad in ["msg_", "ses_0123456789abABCDEFGHIJKLMN", "msg_0123456789aBABCDEFGHIJKLMN", "msg_0123456789abABCDEFGHIJKL-N",
            "msg_0123456789abABCDEFGHIJ\u{e9}N"] {
            assert!(MessageId::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_plain_ids_become_path_segments() {
        assert!(segment("ses_01J9ZABC-x").is_ok());
        for bad in ["", "../config", "a/b", "per_1?x=1", "ses 1"] {
            assert!(segment(bad).is_err(), "{bad:?}");
        }
    }
}
