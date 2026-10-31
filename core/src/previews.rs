//! Interactive previews of single-file HTML (T-5): a Home attachment or a
//! conversation file, shown working in the Portal rather than as its source.
//!
//! Core never serves such a page from its own origin, whose every response
//! refuses framing (`server::harden`). The bytes are read once, when the user
//! asks, and kept as they were under an unguessable token; a listener of
//! Core's own on one port P of the services' range (`services.rs`) serves
//! them at http://127.0.0.1:P/v/<token>, and nothing else but the page's
//! one-time proof that its client reaches P (as a service's way is proven).
//!
//! A page asked for through the phone entry (T-170) cannot reach P. It is
//! served instead by the phone previews' entry (`remote_access::preview`):
//! a loopback listener of its own that only a second Tailscale Serve entry
//! is pointed at, on another HTTPS port of the same tailnet name. Which of
//! the two a snapshot is for is decided by the route the server admitted the
//! request on, never by what the request says of itself, and each snapshot
//! and proof opens only on the listener it was taken for: there, for the
//! phone, only while that entry still lets in the login and page origin it
//! was taken by.
//! Every snapshot response puts the page in a sandbox of its own (an opaque
//! origin, scripts only) that refuses its fetches, WebSockets and
//! subresources, forms, plugins, frames and workers, framed only by the page
//! that asked for it; opened in a browser, the same headers keep it there.
//! The download endpoints still send HTML as text.
//!
//! That is not a page cut off from the network. Neither a sandbox flag nor a
//! CSP directive stops a page navigating itself, so a script can still go to
//! any address and carry there what the file holds, as the file opened
//! directly in a browser could. Nor does `connect-src` cover WebRTC: in the
//! lab a snapshot's script sent STUN requests to an address it named, in
//! Chromium 153, which ignores CSP's `webrtc 'block'` too. It cannot read
//! Core, Yuzuno's storage or the user's sessions, so the file is all it has
//! to carry. The Portal says so, and stops showing a frame once it sees it
//! load something else.
use crate::{server::artifact_path, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{timeout, Instant},
};

/// The previews' key in the services' port pool (never a service's id).
const PORT_KEY: &str = "yuzuno-preview";
/// One page, as one file: enough for a hand-written prototype with inline
/// images, small enough to keep in memory.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
/// What Core keeps at most, all snapshots together; the oldest go first.
const MAX_KEPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_KEPT: usize = 16;
/// How long a snapshot can be opened; then it is gone.
const LIFETIME: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 60 * 60 });
/// How long the page has to ask for its proof's answer.
const PROOF_TTL: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 60 });
const HEAD_LIMIT: usize = 8192;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const PROOF_PATH: &str = "/.well-known/yuzuno-preview/";
const PAGE_PATH: &str = "/v/";

/// The page's whole policy. Scripts and styles only from the file itself;
/// images, fonts and media only from data: or blob:; no request of any other
/// kind, and only the asking page may frame it. Navigating itself and WebRTC
/// are not requests this can refuse (see the module's note).
pub(crate) fn page_policy(ancestor: Option<&str>) -> String {
    format!(
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
         img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; \
         base-uri 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; \
         object-src 'none'; frame-ancestors {}",
        ancestor.unwrap_or("'none'")
    )
}
const PERMISSIONS: &str = "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), \
    magnetometer=(), microphone=(), midi=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), xr-spatial-tracking=()";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum Source {
    /// A Home section's attachment, in the version given or its latest.
    BriefAttachment { project_id: String, section: String, name: String, version: Option<i64> },
    /// A file an Agent's conversation names, in its working directory.
    Artifact { agent_id: String, path: String },
}

/// Who asks for a preview, as the server's routing admitted the request.
pub enum Asker<'a> {
    /// A page on Core's own port, with its Origin as the browser boundary accepted it.
    Local(Option<&'a str>),
    /// A page through the phone entry, as that entry admitted it.
    Phone(&'a crate::server::RemoteEntry),
}

/// The phone previews' entry as it serves now (`remote_access::preview`):
/// the HTTPS host a browser names for it, and the phone page's origin and
/// Tailscale login it serves pages for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Door {
    pub(crate) host: String,
    pub(crate) origin: String,
    pub(crate) login: String,
}

/// The listener a snapshot or proof was taken for, and the only one it opens on.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Via {
    /// Port P, under a loopback name.
    Local,
    /// The phone previews' entry, while it is this door.
    Phone(Door),
}

struct Snapshot {
    bytes: Arc<Vec<u8>>,
    /// The origin of the page that asked: the only one that may frame it.
    ancestor: Option<String>,
    until: Instant,
    via: Via,
}

struct Proof {
    answer: String,
    origin: Option<String>,
    until: Instant,
    used: bool,
    via: Via,
}

#[derive(Default)]
struct Kept {
    snapshots: HashMap<String, Snapshot>,
    order: VecDeque<String>,
    proofs: HashMap<String, Proof>,
}

impl Kept {
    fn bytes(&self) -> usize {
        self.snapshots.values().map(|s| s.bytes.len()).sum()
    }

    /// Expired ones out, then the oldest until one more of `size` fits.
    fn make_room(&mut self, size: usize) {
        let now = Instant::now();
        self.snapshots.retain(|_, s| s.until > now);
        self.proofs.retain(|_, p| p.until > now && !p.used);
        let snapshots = &self.snapshots;
        self.order.retain(|token| snapshots.contains_key(token));
        while !self.order.is_empty() && (self.snapshots.len() >= MAX_KEPT || self.bytes() + size > MAX_KEPT_BYTES) {
            if let Some(oldest) = self.order.pop_front() {
                self.snapshots.remove(&oldest);
            }
        }
    }
}

/// The previews of this Core, and their listener once one was asked for.
#[derive(Default)]
pub struct Previews {
    port: tokio::sync::Mutex<Option<u16>>,
    kept: Arc<Mutex<Kept>>,
}

/// An origin as a browser sends it, fit to go back in a header: none when
/// the request had none or it is not plain `scheme://host[:port]`.
fn origin_of(origin: Option<&str>) -> Option<String> {
    let origin = origin?;
    let (scheme, rest) = origin.split_once("://")?;
    (matches!(scheme, "http" | "https")
        && origin.len() <= 256
        && !rest.is_empty()
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b)))
        .then(|| origin.to_owned())
}

fn token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

impl Previews {
    /// The listener's port, started on first use and kept while Core runs.
    async fn listening(&self, ws: &Workspace) -> Result<u16> {
        let mut port = self.port.lock().await;
        if let Some(port) = *port {
            return Ok(port);
        }
        let listener = ws.services.listen(PORT_KEY, 0).await.map_err(|reason| anyhow::anyhow!("preview_unavailable: {reason}"))?;
        let bound = listener.local_addr()?.port();
        tokio::spawn(accept(listener, bound, self.kept.clone()));
        *port = Some(bound);
        Ok(bound)
    }
}

async fn accept(listener: TcpListener, port: u16, kept: Arc<Mutex<Kept>>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        tokio::spawn(serve(stream, On::Local(port), kept.clone()));
    }
}

/// Serve the phone previews' entry on `listener`, which `remote_access`
/// binds and stops. Each request is let in by the door as it is when the
/// request has arrived.
pub(crate) async fn accept_phone(listener: TcpListener, ws: Arc<Workspace>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let kept = ws.previews.kept.clone();
        tokio::spawn(serve(stream, On::Phone(ws.clone()), kept));
    }
}

/// The listener a request came in on.
enum On {
    /// Port P.
    Local(u16),
    /// The phone previews' entry, of this Workspace.
    Phone(Arc<Workspace>),
}

/// The request's head, at most HEAD_LIMIT bytes, or nothing in time.
async fn head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match timeout(READ_TIMEOUT, stream.read(&mut buffer)).await {
            Ok(Ok(n)) if n > 0 && head.len() + n <= HEAD_LIMIT => head.extend_from_slice(&buffer[..n]),
            _ => return None,
        }
    }
    String::from_utf8(head).ok()
}

/// Every value `name` has in the request's head, in order.
fn values<'a>(head: &'a str, name: &str) -> Vec<&'a str> {
    head.split("\r\n").skip(1)
        .filter_map(|line| line.split_once(':').filter(|(n, _)| n.trim().eq_ignore_ascii_case(name)))
        .map(|(_, value)| value.trim())
        .collect()
}

/// Whether a request may reach the pages of the listener it came in on, and
/// as which; else the status and reason it is refused with. A header counts
/// only if it appears once.
fn admit(head: &str, on: &On) -> Result<Via, (&'static str, &'static str)> {
    match on {
        On::Local(port) => {
            // Only a proxy adds these: one pointed at P is refused, as on Core's own port.
            if crate::server::PROXY_HEADERS.iter().any(|name| !values(head, name).is_empty()) {
                return Err(("403 Forbidden", "Proxied request: a phone opens previews through their own entry"));
            }
            // Another name for this address (DNS rebinding) never reaches a page.
            let names = [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")];
            match values(head, "host")[..] {
                [host] if names.iter().any(|name| name.eq_ignore_ascii_case(host)) => Ok(Via::Local),
                _ => Err(("421 Misdirected Request", "Unrecognized preview host")),
            }
        }
        On::Phone(ws) => {
            let Some(door) = crate::remote_access::preview_door(ws) else {
                return Err(("403 Forbidden", "Phone previews are off"));
            };
            if !values(head, "tailscale-funnel-request").is_empty() {
                return Err(("403 Forbidden", "Funnel requests are not accepted"));
            }
            if values(head, "tailscale-user-login") != [door.login.as_str()] {
                return Err(("403 Forbidden", "Not the Tailscale login this preview entry allows"));
            }
            if values(head, "host") != [door.host.as_str()] {
                return Err(("421 Misdirected Request", "Unrecognized preview host"));
            }
            Ok(Via::Phone(door))
        }
    }
}

/// A response with the headers every answer of this origin has.
fn response(status: &str, extra: &[(&str, String)], body: &[u8], with_body: bool) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in extra {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!(
        "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    let mut bytes = out.into_bytes();
    if with_body {
        bytes.extend_from_slice(body);
    }
    bytes
}

/// A refusal; its body names this listener, so a check can tell it from
/// another program's answer.
fn refused(status: &str, reason: &str, with_body: bool) -> Vec<u8> {
    response(status, &[
        ("Content-Type", "text/plain; charset=utf-8".into()),
        ("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'".into()),
    ], format!("{status}: {reason} (Yuzuno preview)").as_bytes(), with_body)
}

/// One request on a previews' listener: a snapshot or the page's proof, by
/// GET (or HEAD), let in by `admit` and taken for this listener as it is
/// now; anything else is refused.
async fn serve(mut stream: TcpStream, on: On, kept: Arc<Mutex<Kept>>) {
    let Some(head) = head(&mut stream).await else { return };
    let mut line = head.split("\r\n").next().unwrap_or_default().split(' ');
    let (method, target) = (line.next().unwrap_or_default(), line.next().unwrap_or_default());
    let with_body = method != "HEAD";
    let path = target.split(['?', '#']).next().unwrap_or_default();
    let origins = values(&head, "origin");
    let bytes = match admit(&head, &on) {
        Err((status, reason)) => refused(status, reason, with_body),
        Ok(_) if method != "GET" && method != "HEAD" => response("405 Method Not Allowed", &[
            ("Allow", "GET, HEAD".into()),
            ("Content-Type", "text/plain; charset=utf-8".into()),
            ("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'".into()),
        ], b"405 Method Not Allowed", with_body),
        Ok(via) => answer(path, via, &origins, &kept, with_body),
    };
    let _ = stream.write_all(&bytes).await;
    let _ = stream.shutdown().await;
}

/// The answer to an admitted GET or HEAD of `path`, through `via`.
fn answer(path: &str, via: Via, origins: &[&str], kept: &Mutex<Kept>, with_body: bool) -> Vec<u8> {
    if let Some(challenge) = path.strip_prefix(PROOF_PATH) {
        // At most one Origin; the proof's own, or none for a page that sent none.
        let origin = match origins {
            [] => None,
            [origin] => Some((*origin).to_owned()),
            _ => return refused("404 Not Found", "No such Yuzuno preview", with_body),
        };
        let given = {
            let mut kept = kept.lock().unwrap();
            match kept.proofs.get_mut(challenge) {
                Some(proof) if !proof.used && Instant::now() < proof.until && origin == proof.origin && proof.via == via => {
                    proof.used = true;
                    Some((proof.answer.clone(), proof.origin.clone()))
                }
                _ => None,
            }
        };
        match given {
            Some((answer, origin)) => {
                let mut extra = vec![("Content-Type", "text/plain; charset=utf-8".to_owned())];
                if let Some(origin) = origin {
                    extra.push(("Access-Control-Allow-Origin", origin));
                    extra.push(("Vary", "Origin".into()));
                }
                response("200 OK", &extra, answer.as_bytes(), with_body)
            }
            None => refused("404 Not Found", "No such Yuzuno preview", with_body),
        }
    } else if let Some(token) = path.strip_prefix(PAGE_PATH) {
        let found = {
            let kept = kept.lock().unwrap();
            kept.snapshots.get(token).filter(|s| Instant::now() < s.until && s.via == via).map(|s| (s.bytes.clone(), s.ancestor.clone()))
        };
        match found {
            Some((page, ancestor)) => response("200 OK", &[
                ("Content-Type", "text/html; charset=utf-8".into()),
                ("Content-Security-Policy", page_policy(ancestor.as_deref())),
                ("Cross-Origin-Opener-Policy", "same-origin".into()),
                ("Cross-Origin-Resource-Policy", "same-origin".into()),
                ("Permissions-Policy", PERMISSIONS.into()),
            ], &page, with_body),
            None => refused("404 Not Found", "No such Yuzuno preview", with_body),
        }
    } else {
        refused("404 Not Found", "No such Yuzuno preview", with_body)
    }
}

/// Whether a name is one this preview shows: a single HTML file.
fn html_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

impl Workspace {
    /// The bytes of `source` as they are now, and the file's name.
    async fn preview_bytes(self: &Arc<Self>, source: &Source) -> Result<(String, Vec<u8>)> {
        match source {
            Source::BriefAttachment { project_id, section, name, version } => {
                ensure!(html_name(name), "preview_unsupported: only a single .html or .htm file can be previewed");
                let path = crate::project_brief::attachment_file(self, project_id, section, name, *version).await?;
                Ok((name.clone(), read_bounded(&path).await?))
            }
            Source::Artifact { agent_id, path } => {
                ensure!(html_name(path), "preview_unsupported: only a single .html or .htm file can be previewed");
                let agent = self.listed(agent_id).await?;
                let bytes = if let Some(remote) = &agent.remote {
                    crate::remote::read_artifact(&remote.machine, &agent.cwd, path).await?
                } else {
                    read_bounded(&artifact_path(&agent.cwd, path)?).await?
                };
                let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
                Ok((name, bytes))
            }
        }
    }

    /// The user's request to see `source` working: its bytes now, kept as
    /// they are under a new token, and the proof for the page to check that
    /// its client reaches the listener it was taken for. A page on Core's own
    /// port (`origin` as the request had it) gets port P; one through the
    /// phone entry gets the phone previews' entry, framed only by the
    /// origin that entry serves, or an error when it serves none. The reply
    /// alone carries the token and the proof's answer.
    pub async fn open_preview(self: &Arc<Self>, source: Source, asker: Asker<'_>) -> Result<Value> {
        let (door, origin) = match asker {
            Asker::Local(origin) => (None, origin),
            Asker::Phone(entry) => (Some(crate::remote_access::preview_door(self)
                .filter(|door| door.origin == entry.origin() && door.login == entry.login())
                .context("preview_unavailable_remote: previews are not served through the phone entry; turn on phone previews in Settings → Phone access, on the computer that runs Core")?), None),
        };
        let (name, bytes) = self.preview_bytes(&source).await?;
        ensure!(bytes.len() <= MAX_BYTES, "preview_too_large: a previewed page is at most {} MB", MAX_BYTES / (1024 * 1024));
        if std::str::from_utf8(&bytes).is_err() {
            bail!("preview_unsupported: the file is not UTF-8 text");
        }
        let (via, ancestor, base, port) = match door {
            Some(door) => {
                let port = door.host.rsplit_once(':').and_then(|(_, port)| port.parse().ok()).unwrap_or(443u16);
                (Via::Phone(door.clone()), Some(door.origin.clone()), format!("https://{}", door.host), port)
            }
            None => {
                let port = self.previews.listening(self).await?;
                (Via::Local, origin_of(origin), format!("http://127.0.0.1:{port}"), port)
            }
        };
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let size = bytes.len();
        let (page, challenge, answer) = (token(), token(), token());
        {
            let mut kept = self.previews.kept.lock().unwrap();
            kept.make_room(size);
            kept.snapshots.insert(page.clone(), Snapshot {
                bytes: Arc::new(bytes), ancestor: ancestor.clone(), until: Instant::now() + LIFETIME, via: via.clone(),
            });
            kept.order.push_back(page.clone());
            kept.proofs.insert(challenge.clone(), Proof { answer: answer.clone(), origin: ancestor, until: Instant::now() + PROOF_TTL, used: false, via });
        }
        let now = chrono::Utc::now();
        Ok(json!({
            "name": name, "size": size, "sha256": sha256,
            "takenAt": now.to_rfc3339(),
            "expiresAt": (now + chrono::Duration::from_std(LIFETIME).context("lifetime")?).to_rfc3339(),
            "port": port,
            "url": format!("{base}{PAGE_PATH}{page}"),
            "proof": {"challenge": challenge, "answer": answer, "url": format!("{base}{PROOF_PATH}{challenge}")},
        }))
    }
}

/// A file's bytes, read once and at most one past the limit.
async fn read_bounded(path: &std::path::Path) -> Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await.with_context(|| format!("{} cannot be read", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(test)]
#[path = "previews_tests.rs"]
mod tests;
