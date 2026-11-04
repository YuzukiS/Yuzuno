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
//! served instead by the phone entry itself, at the same origin and through
//! the same Serve entry as Yuzuno's page, under a path the phone entry keeps
//! for previews alone (`phone_router`): a snapshot by GET or HEAD, its proof
//! by POST from that page, and nothing else there, never Yuzuno's page or
//! API. What keeps such a page from Yuzuno's is its sandbox (below): an
//! opaque origin of its own, never its path. Which entry a snapshot is for is
//! decided by the route the server admitted the request on, never by what
//! the request says of itself, and each snapshot and proof opens only where
//! it was taken: for the phone, only on the run of the phone entry that
//! admitted it (`RemoteEntry::run`), while phone access includes previews
//! (`remote_access::phone_previews`). Turning them off, phone access off, or
//! a new phone entry ends what an earlier one was given.
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
use crate::{server::{artifact_path, RemoteEntry}, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Extension, Router,
};
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
/// The path the phone entry keeps for previews: nothing under it is Yuzuno's page.
pub(crate) const PHONE_ROOT: &str = "/__yuzuno";
const PHONE_PAGE: &str = "/__yuzuno/preview/v/";
const PHONE_PROOF: &str = "/__yuzuno/preview/proof/";

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
const PHONE_OFF: &str = "preview_unavailable_remote: phone access does not include previews; choose Phone access includes previews \
    in Settings → Phone access, on the computer that runs Core, and Save and apply";
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
    Phone(&'a RemoteEntry),
}

/// Where a snapshot or proof was taken for, and the only place it opens.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Via {
    /// Port P, under a loopback name.
    Local,
    /// The phone entry, on the run that admitted its request (`RemoteEntry::run`).
    Phone(u64),
}

/// Marks a response that is a previewed page (T-5), framed by its own
/// policy: the only response of the phone entry `server::harden` leaves
/// without `X-Frame-Options: DENY`. Only this module's handler sets it;
/// nothing a request says can.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PreviewDocument;

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

    /// Forget what was taken for the phone entry: on every run (`None`),
    /// or on all runs but `kept`.
    pub(crate) fn revoke_phone(&self, kept_run: Option<u64>) {
        let mut kept = self.kept.lock().unwrap();
        let gone = |via: &Via| matches!(via, Via::Phone(run) if Some(*run) != kept_run);
        kept.snapshots.retain(|_, s| !gone(&s.via));
        kept.proofs.retain(|_, p| !gone(&p.via));
        let Kept { snapshots, order, .. } = &mut *kept;
        order.retain(|token| snapshots.contains_key(token));
    }
}

async fn accept(listener: TcpListener, port: u16, kept: Arc<Mutex<Kept>>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        tokio::spawn(serve(stream, port, kept.clone()));
    }
}

/// The request's head: its request line and headers, through the blank line
/// that ends them, at most HEAD_LIMIT bytes, or nothing in time. What follows
/// in the same reads (a body, another request) is dropped, never read as the
/// head's.
async fn head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::with_capacity(1024);
    let mut buffer = [0u8; 1024];
    loop {
        if let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            if end + 4 > HEAD_LIMIT {
                return None;
            }
            head.truncate(end + 4);
            return String::from_utf8(head).ok();
        }
        if head.len() >= HEAD_LIMIT {
            return None;
        }
        match timeout(READ_TIMEOUT, stream.read(&mut buffer)).await {
            Ok(Ok(n)) if n > 0 => head.extend_from_slice(&buffer[..n]),
            _ => return None,
        }
    }
}

/// Every value `name` has in the request's headers, in order: the lines
/// after the request line, up to the first empty one. A name is matched as
/// it stands; one with spaces around it is no header's.
fn values<'a>(head: &'a str, name: &str) -> Vec<&'a str> {
    head.split("\r\n").skip(1)
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':').filter(|(n, _)| n.eq_ignore_ascii_case(name)))
        .map(|(_, value)| value.trim())
        .collect()
}

/// Whether a request may reach the pages of port P; else the status and
/// reason it is refused with. A header counts only if it appears once.
fn admit(head: &str, port: u16) -> Result<Via, (&'static str, &'static str)> {
    // Only a proxy adds these: one pointed at P is refused, as on Core's own port.
    if crate::server::PROXY_HEADERS.iter().any(|name| !values(head, name).is_empty()) {
        return Err(("403 Forbidden", "Proxied request: a phone opens previews through the phone entry"));
    }
    // Another name for this address (DNS rebinding) never reaches a page.
    let names = [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")];
    match values(head, "host")[..] {
        [host] if names.iter().any(|name| name.eq_ignore_ascii_case(host)) => Ok(Via::Local),
        _ => Err(("421 Misdirected Request", "Unrecognized preview host")),
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

/// One request on port P: a snapshot or the page's proof, by GET (or HEAD),
/// let in by `admit` and taken for this port; anything else is refused.
async fn serve(mut stream: TcpStream, port: u16, kept: Arc<Mutex<Kept>>) {
    let Some(head) = head(&mut stream).await else { return };
    let mut line = head.split("\r\n").next().unwrap_or_default().split(' ');
    let (method, target) = (line.next().unwrap_or_default(), line.next().unwrap_or_default());
    let with_body = method != "HEAD";
    let path = target.split(['?', '#']).next().unwrap_or_default();
    let origins = values(&head, "origin");
    let bytes = match admit(&head, port) {
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

// ---- through the phone entry (T-5) -------------------------------------------

/// The phone entry's routes for previews (`server::remote_router`), behind
/// its boundary (`RemoteEntry::admit`): a snapshot by GET or HEAD, its proof
/// by POST, and for anything else under the reserved path a refusal of its
/// own, never Yuzuno's page.
pub(crate) fn phone_router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/__yuzuno/preview/v/{token}", get(phone_page).fallback(not_allowed))
        .route("/__yuzuno/preview/proof/{challenge}", post(phone_proof).fallback(not_allowed))
        .route("/__yuzuno", any(no_such))
        .route("/__yuzuno/", any(no_such))
        .route("/__yuzuno/{*rest}", any(no_such))
}

/// A refusal under the reserved path; its body names previews, so a check
/// can tell it from Yuzuno's page.
fn refusal(status: StatusCode, reason: &str) -> Response {
    let mut response = (status, format!("{} {}: {reason} (Yuzuno preview)", status.as_u16(), status.canonical_reason().unwrap_or(""))).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"));
    response
}

async fn no_such() -> Response {
    refusal(StatusCode::NOT_FOUND, "No such Yuzuno preview")
}

async fn not_allowed() -> Response {
    refusal(StatusCode::METHOD_NOT_ALLOWED, "Not a way to open a preview")
}

/// What a request names after `prefix`, exactly as it was sent: a token's
/// lowercase hex and nothing else (no encoding, no further segment).
fn named<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    let name = path.strip_prefix(prefix)?;
    (!name.is_empty() && name.len() <= 128 && name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(name)
}

/// Whether phone access includes previews now, on the run of the phone entry that admitted the request.
fn phone_open(ws: &Workspace, entry: &RemoteEntry) -> bool {
    crate::remote_access::phone_previews(ws) == Some(entry.run())
}

/// A snapshot through the phone entry, by its exact address, as it was
/// taken: with every header P's answer has, and its own policy on framing,
/// marked so (`PreviewDocument`).
async fn phone_page(State(ws): State<Arc<Workspace>>, Extension(entry): Extension<Arc<RemoteEntry>>, request: Request) -> Response {
    if !phone_open(&ws, &entry) {
        return refusal(StatusCode::FORBIDDEN, "Phone access does not include previews");
    }
    let found = named(request.uri().path(), PHONE_PAGE).and_then(|token| {
        let kept = ws.previews.kept.lock().unwrap();
        kept.snapshots.get(token).filter(|s| Instant::now() < s.until && s.via == Via::Phone(entry.run())).map(|s| (s.bytes.clone(), s.ancestor.clone()))
    });
    let Some((page, ancestor)) = found else { return no_such().await };
    let mut response = (StatusCode::OK, page.as_ref().clone()).into_response();
    let headers = response.headers_mut();
    for (name, value) in [
        (header::CONTENT_TYPE, "text/html; charset=utf-8".to_owned()),
        (header::CONTENT_SECURITY_POLICY, page_policy(ancestor.as_deref())),
        (header::HeaderName::from_static("cross-origin-opener-policy"), "same-origin".into()),
        (header::HeaderName::from_static("cross-origin-resource-policy"), "same-origin".into()),
        (header::HeaderName::from_static("permissions-policy"), PERMISSIONS.into()),
        (header::REFERRER_POLICY, "no-referrer".into()),
    ] {
        headers.insert(name, HeaderValue::from_str(&value).expect("a preview's header"));
    }
    response.extensions_mut().insert(PreviewDocument);
    response
}

/// A proof's answer through the phone entry: once, by POST from the page that
/// asked for the preview. The boundary let in only that page's exact Origin
/// with the client header; the proof checks its Origin once more, as its own.
async fn phone_proof(State(ws): State<Arc<Workspace>>, Extension(entry): Extension<Arc<RemoteEntry>>, request: Request) -> Response {
    let mut origins = request.headers().get_all(header::ORIGIN).iter();
    let origin = match (origins.next(), origins.next()) {
        (Some(origin), None) => origin.to_str().ok(),
        _ => None,
    };
    if origin != Some(entry.origin()) {
        return refusal(StatusCode::FORBIDDEN, "A proof is asked for by the page that opened the preview");
    }
    if !phone_open(&ws, &entry) {
        return refusal(StatusCode::FORBIDDEN, "Phone access does not include previews");
    }
    let given = named(request.uri().path(), PHONE_PROOF).and_then(|challenge| {
        let mut kept = ws.previews.kept.lock().unwrap();
        let proof = kept.proofs.get_mut(challenge)?;
        let fits = !proof.used && Instant::now() < proof.until && proof.via == Via::Phone(entry.run()) && proof.origin.as_deref() == origin;
        fits.then(|| {
            proof.used = true;
            proof.answer.clone()
        })
    });
    match given {
        Some(answer) => ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], answer).into_response(),
        None => no_such().await,
    }
}

/// The phone entry's guard for its reserved path (`server::remote_router`),
/// before any route: a path that is under it only once decoded, normalized
/// or read without case (`/%5F_yuzuno/…`, `//__yuzuno/…`, `/x/../__yuzuno/…`,
/// `/__YUZUNO/…`) is refused, never served as Yuzuno's page; and anything
/// there that asks to change protocol is refused before any handler, so it
/// takes nothing (a proof's challenge stays unused).
pub(crate) async fn reserved(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if aims_at_reserved(path) && !plainly_reserved(path) {
        return no_such().await;
    }
    if aims_at_reserved(path) && request.headers().contains_key(header::UPGRADE) {
        return refusal(StatusCode::BAD_REQUEST, "A preview is a page, never another protocol");
    }
    next.run(request).await
}

/// Whether `path` reaches the reserved path once decoded (until nothing more
/// decodes), with `\` as `/`, empty and dot segments taken out, and ASCII
/// case aside.
fn aims_at_reserved(path: &str) -> bool {
    let mut bytes = path.as_bytes().to_vec();
    for _ in 0..4 {
        let decoded = percent_decoded(&bytes);
        if decoded == bytes {
            break;
        }
        bytes = decoded;
    }
    let text = String::from_utf8_lossy(&bytes).replace('\\', "/").to_ascii_lowercase();
    let mut segments = Vec::new();
    for segment in text.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.first() == Some(&&PHONE_ROOT[1..])
}

/// Whether `path` is under the reserved path just as it was sent.
fn plainly_reserved(path: &str) -> bool {
    (path == PHONE_ROOT || path.starts_with(&format!("{PHONE_ROOT}/")))
        && !path.contains(['%', '\\'])
        && !path.contains("//")
        && !path.split('/').any(|segment| segment == "." || segment == "..")
}

fn percent_decoded(bytes: &[u8]) -> Vec<u8> {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(high), Some(low)) => {
                out.push(high << 4 | low);
                i += 3;
            }
            (b, _, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
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
    /// its client reaches where it was taken for. A page on Core's own port
    /// (`origin` as the request had it) gets port P and a proof by GET (no
    /// `method`). One through the phone entry gets that entry's own origin,
    /// framed only by it, and a proof by POST (`method`), as its run serves
    /// now; or an error while phone access does not include previews. The
    /// reply alone carries the token and the proof's answer.
    pub async fn open_preview(self: &Arc<Self>, source: Source, asker: Asker<'_>) -> Result<Value> {
        if let Asker::Phone(entry) = &asker {
            ensure!(phone_open(self, entry), "{PHONE_OFF}");
        }
        let (name, bytes) = self.preview_bytes(&source).await?;
        ensure!(bytes.len() <= MAX_BYTES, "preview_too_large: a previewed page is at most {} MB", MAX_BYTES / (1024 * 1024));
        if std::str::from_utf8(&bytes).is_err() {
            bail!("preview_unsupported: the file is not UTF-8 text");
        }
        let (page, challenge, answer) = (token(), token(), token());
        let (via, ancestor, url, proof, port) = match asker {
            Asker::Local(origin) => {
                let port = self.previews.listening(self).await?;
                let base = format!("http://127.0.0.1:{port}");
                let proof = json!({"challenge": challenge, "answer": answer, "url": format!("{base}{PROOF_PATH}{challenge}")});
                (Via::Local, origin_of(origin), format!("{base}{PAGE_PATH}{page}"), proof, port)
            }
            Asker::Phone(entry) => {
                let origin = entry.origin();
                let port = reqwest::Url::parse(origin).ok().and_then(|url| url.port_or_known_default()).unwrap_or(443);
                // By POST, which sends the page's Origin: a GET from the same origin usually sends none.
                let proof = json!({"challenge": challenge, "answer": answer, "url": format!("{origin}{PHONE_PROOF}{challenge}"), "method": "POST"});
                (Via::Phone(entry.run()), Some(origin.to_owned()), format!("{origin}{PHONE_PAGE}{page}"), proof, port)
            }
        };
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let size = bytes.len();
        {
            let mut kept = self.previews.kept.lock().unwrap();
            // Checked again under the lock that turning previews off clears
            // after it: nothing is kept for the phone once they are off.
            if let Via::Phone(run) = via {
                ensure!(crate::remote_access::phone_previews(self) == Some(run), "{PHONE_OFF}");
            }
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
            "url": url,
            "proof": proof,
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
