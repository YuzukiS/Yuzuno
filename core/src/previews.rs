//! Interactive previews of single-file HTML (T-5): a Home attachment or a
//! conversation file, shown working in the Portal rather than as its source.
//!
//! Core never serves such a page from its own origin, whose every response
//! refuses framing (`server::harden`). The bytes are read once, when the user
//! asks, and kept as they were under an unguessable token; a listener of
//! Core's own on one port P of the services' range (`services.rs`) serves
//! them at http://127.0.0.1:P/v/<token>, and nothing else but the page's
//! one-time proof that its client reaches P (as a service's way is proven).
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
fn page_policy(ancestor: Option<&str>) -> String {
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

struct Snapshot {
    bytes: Arc<Vec<u8>>,
    /// The origin of the page that asked: the only one that may frame it.
    ancestor: Option<String>,
    until: Instant,
}

struct Proof {
    answer: String,
    origin: Option<String>,
    until: Instant,
    used: bool,
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
        tokio::spawn(serve(stream, port, kept.clone()));
    }
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

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n").skip(1)
        .find_map(|line| line.split_once(':').filter(|(n, _)| n.trim().eq_ignore_ascii_case(name)))
        .map(|(_, value)| value.trim())
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

fn refused(status: &str, with_body: bool) -> Vec<u8> {
    response(status, &[
        ("Content-Type", "text/plain; charset=utf-8".into()),
        ("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'".into()),
    ], status.as_bytes(), with_body)
}

/// One request on the previews' port: a snapshot or the page's proof, by GET
/// (or HEAD) under this port's own name only; anything else is refused.
async fn serve(mut stream: TcpStream, port: u16, kept: Arc<Mutex<Kept>>) {
    let Some(head) = head(&mut stream).await else { return };
    let mut line = head.split("\r\n").next().unwrap_or_default().split(' ');
    let (method, target) = (line.next().unwrap_or_default(), line.next().unwrap_or_default());
    let with_body = method != "HEAD";
    // Another name for this address (DNS rebinding) never reaches a page.
    let host_ok = header(&head, "host").is_some_and(|host| {
        [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].iter().any(|h| h.eq_ignore_ascii_case(host))
    });
    let path = target.split(['?', '#']).next().unwrap_or_default();
    let bytes = if !host_ok {
        refused("421 Misdirected Request", with_body)
    } else if method != "GET" && method != "HEAD" {
        response("405 Method Not Allowed", &[
            ("Allow", "GET, HEAD".into()),
            ("Content-Type", "text/plain; charset=utf-8".into()),
            ("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'".into()),
        ], b"405 Method Not Allowed", with_body)
    } else if let Some(challenge) = path.strip_prefix(PROOF_PATH) {
        let origin = header(&head, "origin").map(str::to_owned);
        let given = {
            let mut kept = kept.lock().unwrap();
            match kept.proofs.get_mut(challenge) {
                Some(proof) if !proof.used && Instant::now() < proof.until && origin == proof.origin => {
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
            None => refused("404 Not Found", with_body),
        }
    } else if let Some(token) = path.strip_prefix(PAGE_PATH) {
        let found = {
            let kept = kept.lock().unwrap();
            kept.snapshots.get(token).filter(|s| Instant::now() < s.until).map(|s| (s.bytes.clone(), s.ancestor.clone()))
        };
        match found {
            Some((page, ancestor)) => response("200 OK", &[
                ("Content-Type", "text/html; charset=utf-8".into()),
                ("Content-Security-Policy", page_policy(ancestor.as_deref())),
                ("Cross-Origin-Opener-Policy", "same-origin".into()),
                ("Cross-Origin-Resource-Policy", "same-origin".into()),
                ("Permissions-Policy", PERMISSIONS.into()),
            ], &page, with_body),
            None => refused("404 Not Found", with_body),
        }
    } else {
        refused("404 Not Found", with_body)
    };
    let _ = stream.write_all(&bytes).await;
    let _ = stream.shutdown().await;
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
    /// they are under a new token, and the proof for the page (`origin`, as
    /// the request had it) to check that its client reaches the previews'
    /// port. The reply alone carries the token and the proof's answer.
    pub async fn open_preview(self: &Arc<Self>, source: Source, origin: Option<&str>) -> Result<Value> {
        let (name, bytes) = self.preview_bytes(&source).await?;
        ensure!(bytes.len() <= MAX_BYTES, "preview_too_large: a previewed page is at most {} MB", MAX_BYTES / (1024 * 1024));
        if std::str::from_utf8(&bytes).is_err() {
            bail!("preview_unsupported: the file is not UTF-8 text");
        }
        let port = self.previews.listening(self).await?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let size = bytes.len();
        let ancestor = origin_of(origin);
        let (page, challenge, answer) = (token(), token(), token());
        {
            let mut kept = self.previews.kept.lock().unwrap();
            kept.make_room(size);
            kept.snapshots.insert(page.clone(), Snapshot { bytes: Arc::new(bytes), ancestor: ancestor.clone(), until: Instant::now() + LIFETIME });
            kept.order.push_back(page.clone());
            kept.proofs.insert(challenge.clone(), Proof { answer: answer.clone(), origin: ancestor, until: Instant::now() + PROOF_TTL, used: false });
        }
        let now = chrono::Utc::now();
        Ok(json!({
            "name": name, "size": size, "sha256": sha256,
            "takenAt": now.to_rfc3339(),
            "expiresAt": (now + chrono::Duration::from_std(LIFETIME).context("lifetime")?).to_rfc3339(),
            "port": port,
            "url": format!("http://127.0.0.1:{port}{PAGE_PATH}{page}"),
            "proof": {"challenge": challenge, "answer": answer, "url": format!("http://127.0.0.1:{port}{PROOF_PATH}{challenge}")},
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
