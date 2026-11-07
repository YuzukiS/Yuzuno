//! Interactive previews of single-file HTML (T-5): a Home attachment or a
//! conversation file, shown working in the Portal or on its Home card rather
//! than as its source.
//!
//! Core never serves such a page from its own origin, whose every response
//! refuses framing (`server::harden`). The page is taken once, when the user
//! asks, and kept as it was under an unguessable token: a Home attachment as
//! the snapshot Core already keeps of it, held there for as long as the
//! preview is (`project_brief::hold_attachment`), and a conversation file as
//! Core's own copy of it in `<data dir>/previews`. Only their index stays in
//! memory: every answer reads its file CHUNK bytes at a time, so a page costs
//! Core the same memory whatever its size (YN-10). A page is as large as a
//! Home attachment Core keeps can be (MAX_BYTES); one on another machine, as
//! its helper reads (`remote::read_artifact`). A listener of Core's own on
//! one port P of the services' range (`services.rs`) serves them at
//! http://127.0.0.1:P/v/<token>, and nothing else but the page's one-time
//! proof that its client reaches P (as a service's way is proven).
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
//!
//! A Home card asks for its attachment's preview with `place: "card"` and
//! the section version it shows (YN-3). Cards keep snapshots of their own
//! (`Place`), so a card never takes the place of one the Portal opened; and a
//! card asking again for the same version of the same attachment, from the
//! same page through the same entry, is given the snapshot it has while at
//! least REUSE_LEFT of it remains, with a proof of its own each time. No
//! snapshot is ever given more time than its hour.
use crate::{server::{artifact_path, RemoteEntry}, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    body::{Body, Bytes},
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
    path::{Path, PathBuf},
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
/// One page, as one file: a conversation file up to this size is previewed,
/// as a Home attachment up to it is kept (`project_brief`).
pub(crate) const MAX_BYTES: u64 = crate::project_brief::SNAPSHOT_FILE_BYTES;
/// The files of each place's snapshots together, at most; never less than
/// one page.
const MAX_KEPT_BYTES: u64 = if cfg!(test) { 32 << 20 } else { 256 << 20 };
const _: () = assert!(MAX_KEPT_BYTES >= MAX_BYTES);
/// Snapshots the Portal keeps, and Home cards (`Place`); in each the oldest
/// go first, and neither makes room in the other.
const MAX_KEPT: usize = 16;
const MAX_CARDS: usize = 32;
/// Proofs not yet answered, of both places; the oldest go first.
const MAX_PROOFS: usize = 64;
/// How long a snapshot can be opened; then it is gone.
const LIFETIME: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 60 * 60 });
/// How long the page has to ask for its proof's answer.
const PROOF_TTL: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 60 });
/// The time a card's snapshot must have left to be given again.
const REUSE_LEFT: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 10 * 60 });
/// How much of a page is read or sent at once.
const CHUNK: usize = 64 * 1024;
/// Core's copies of conversation files, in the data folder.
const COPIES: &str = "previews";
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
    /// A Home section's attachment, in the version given or its latest; a
    /// card's preview names its version, and gets that one or none.
    BriefAttachment {
        project_id: String,
        section: String,
        name: String,
        version: Option<i64>,
        #[serde(default)]
        place: Place,
    },
    /// A file an Agent's conversation names, in its working directory.
    Artifact { agent_id: String, path: String },
}

impl Source {
    fn place(&self) -> Place {
        match self {
            Source::BriefAttachment { place, .. } => *place,
            Source::Artifact { .. } => Place::Portal,
        }
    }
}

/// Where a preview is shown, each place with snapshots of its own.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Place {
    /// The Portal: a new snapshot each time it opens one.
    #[default]
    Portal,
    /// A Home card (YN-3): its live snapshot is given again.
    Card,
}

impl Place {
    fn name(self) -> &'static str {
        match self {
            Place::Portal => "portal",
            Place::Card => "card",
        }
    }
    fn most(self) -> usize {
        match self {
            Place::Portal => MAX_KEPT,
            Place::Card => MAX_CARDS,
        }
    }
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
    /// The page, kept as it was for as long as the snapshot is (`_keep`).
    file: PathBuf,
    size: u64,
    /// The origin of the page that asked: the only one that may frame it.
    ancestor: Option<String>,
    until: Instant,
    via: Via,
    place: Place,
    /// What a card's snapshot is given again for.
    card: Option<CardKey>,
    /// The facts of the reply, the same each time it is given.
    shown: Value,
    _keep: Keep,
}

/// A card's snapshot is of one attachment in one section version, by its
/// content.
#[derive(Clone, Debug, PartialEq, Eq)]
struct CardKey {
    project: String,
    section: String,
    name: String,
    version: i64,
    sha256: String,
}

/// What keeps a snapshot's file as it was: a Home attachment's snapshot held
/// out of `collect_garbage`'s reach, or Core's own copy, deleted with it.
#[derive(Default)]
struct Keep {
    _hold: Option<crate::project_brief::AttachmentHold>,
    _copy: Option<Copied>,
}

/// A conversation file's copy, removed when the snapshot that keeps it goes.
struct Copied(PathBuf);

impl Drop for Copied {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

struct Proof {
    answer: String,
    origin: Option<String>,
    until: Instant,
    used: bool,
    via: Via,
}

/// The index of what Core keeps. What leaves it is handed back, to be let go
/// (its file deleted or released) once the lock is.
#[derive(Default)]
struct Kept {
    snapshots: HashMap<String, Snapshot>,
    /// Their tokens, oldest first.
    order: VecDeque<String>,
    proofs: HashMap<String, Proof>,
}

impl Kept {
    /// The bytes of the files `place` keeps.
    fn bytes(&self, place: Place) -> u64 {
        self.snapshots.values().filter(|s| s.place == place).map(|s| s.size).sum()
    }

    /// The snapshots `gone` picks, out.
    fn take(&mut self, gone: impl Fn(&Snapshot) -> bool) -> Vec<Snapshot> {
        let tokens: Vec<String> = self.snapshots.iter().filter(|(_, s)| gone(s)).map(|(token, _)| token.clone()).collect();
        let taken = tokens.iter().filter_map(|token| self.snapshots.remove(token)).collect();
        let snapshots = &self.snapshots;
        self.order.retain(|token| snapshots.contains_key(token));
        taken
    }

    /// What has had its time, out: answered or expired proofs, and expired snapshots.
    fn expired(&mut self) -> Vec<Snapshot> {
        let now = Instant::now();
        self.proofs.retain(|_, p| p.until > now && !p.used);
        self.take(|s| s.until <= now)
    }

    /// Expired ones out, then the oldest of `place` until one more of `size` fits there.
    fn make_room(&mut self, place: Place, size: u64) -> Vec<Snapshot> {
        let mut gone = self.expired();
        while self.snapshots.values().filter(|s| s.place == place).count() >= place.most() || self.bytes(place) + size > MAX_KEPT_BYTES {
            let snapshots = &self.snapshots;
            let Some(at) = self.order.iter().position(|token| snapshots.get(token).is_some_and(|s| s.place == place)) else { break };
            if let Some(oldest) = self.order.remove(at) {
                gone.extend(self.snapshots.remove(&oldest));
            }
        }
        gone
    }

    /// A proof for `challenge`; the oldest unanswered goes first once MAX_PROOFS are kept.
    fn prove(&mut self, challenge: String, proof: Proof) {
        while self.proofs.len() >= MAX_PROOFS {
            let Some(oldest) = self.proofs.iter().min_by_key(|(_, p)| p.until).map(|(challenge, _)| challenge.clone()) else { break };
            self.proofs.remove(&oldest);
        }
        self.proofs.insert(challenge, proof);
    }
}

/// The previews of this Core, and their listener once one was asked for.
#[derive(Default)]
pub struct Previews {
    port: tokio::sync::Mutex<Option<u16>>,
    kept: Arc<Mutex<Kept>>,
    /// Whether the folder of copies was emptied of an earlier Core's (`copy_path`).
    emptied: tokio::sync::OnceCell<()>,
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
        let taken = {
            let mut kept = self.kept.lock().unwrap();
            let gone = |via: &Via| matches!(via, Via::Phone(run) if Some(*run) != kept_run);
            kept.proofs.retain(|_, p| !gone(&p.via));
            kept.take(|s| gone(&s.via))
        };
        drop(taken);
    }

    /// A new path for a copy, in the folder of copies; the first time this
    /// Core copies a file, what an earlier one left there is removed (no
    /// snapshot outlives its Core).
    async fn copy_path(&self, data_dir: &Path) -> Result<PathBuf> {
        let dir = data_dir.join(COPIES);
        self.emptied.get_or_try_init(|| {
            let dir = dir.clone();
            async move {
                tokio::task::spawn_blocking(move || -> Result<()> {
                    match std::fs::remove_dir_all(&dir) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error).with_context(|| format!("cannot empty {}", dir.display())),
                    }
                    let mut folder = std::fs::DirBuilder::new();
                    folder.recursive(true);
                    #[cfg(unix)]
                    std::os::unix::fs::DirBuilderExt::mode(&mut folder, 0o700);
                    folder.create(&dir).with_context(|| format!("cannot create {}", dir.display()))
                })
                .await?
            }
        })
        .await?;
        Ok(dir.join(format!("{}.html", uuid::Uuid::new_v4().simple())))
    }
}

/// At `until`, takes what has expired out of the index and lets its files
/// go, even if nothing else is asked meanwhile.
fn sweep_at(kept: &Arc<Mutex<Kept>>, until: Instant) {
    let kept = Arc::downgrade(kept);
    tokio::spawn(async move {
        tokio::time::sleep_until(until).await;
        if let Some(kept) = kept.upgrade() {
            let gone = kept.lock().unwrap().expired();
            drop(gone);
        }
    });
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

/// The head of a response with the headers every answer of this origin
/// has, for a body of `length` bytes.
fn head_of(status: &str, extra: &[(&str, String)], length: u64) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in extra {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!(
        "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\n\
         Content-Length: {length}\r\nConnection: close\r\n\r\n"
    ));
    out.into_bytes()
}

/// A response with the headers every answer of this origin has.
fn response(status: &str, extra: &[(&str, String)], body: &[u8], with_body: bool) -> Vec<u8> {
    let mut bytes = head_of(status, extra, body.len() as u64);
    if with_body {
        bytes.extend_from_slice(body);
    }
    bytes
}

/// An answer on port P: one put together, or a page's head and its file.
enum Answer {
    Whole(Vec<u8>),
    Page { head: Vec<u8>, file: tokio::fs::File, size: u64 },
}

/// A snapshot's file, open for reading, while it is there at the size it
/// was kept at.
async fn opened(path: &Path, size: u64) -> Option<tokio::fs::File> {
    let file = tokio::fs::File::open(path).await.ok()?;
    (file.metadata().await.ok()?.len() == size).then_some(file)
}

/// `size` bytes of `file` to `out`, CHUNK at a time.
async fn send(file: tokio::fs::File, size: u64, out: &mut TcpStream) -> std::io::Result<()> {
    let mut file = file.take(size);
    let mut chunk = vec![0; CHUNK];
    loop {
        let n = file.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        out.write_all(&chunk[..n]).await?;
    }
}

/// `size` bytes of `file` as a body, CHUNK at a time.
fn chunks(file: tokio::fs::File, size: u64) -> Body {
    Body::from_stream(futures_util::stream::unfold(Some(file.take(size)), |file| async move {
        let mut file = file?;
        let mut chunk = vec![0; CHUNK];
        match file.read(&mut chunk).await {
            Ok(0) => None,
            Ok(n) => {
                chunk.truncate(n);
                Some((Ok(Bytes::from(chunk)), Some(file)))
            }
            Err(error) => Some((Err(error), None)),
        }
    }))
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
    let reply = match admit(&head, port) {
        Err((status, reason)) => Answer::Whole(refused(status, reason, with_body)),
        Ok(_) if method != "GET" && method != "HEAD" => Answer::Whole(response("405 Method Not Allowed", &[
            ("Allow", "GET, HEAD".into()),
            ("Content-Type", "text/plain; charset=utf-8".into()),
            ("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'".into()),
        ], b"405 Method Not Allowed", with_body)),
        Ok(via) => answer(path, via, &origins, &kept, with_body).await,
    };
    match reply {
        Answer::Whole(bytes) => {
            let _ = stream.write_all(&bytes).await;
        }
        Answer::Page { head, file, size } => {
            if stream.write_all(&head).await.is_ok() && with_body {
                let _ = send(file, size, &mut stream).await;
            }
        }
    }
    let _ = stream.shutdown().await;
}

/// The answer to an admitted GET or HEAD of `path`, through `via`.
async fn answer(path: &str, via: Via, origins: &[&str], kept: &Mutex<Kept>, with_body: bool) -> Answer {
    if let Some(challenge) = path.strip_prefix(PROOF_PATH) {
        Answer::Whole(proof_answer(challenge, via, origins, kept, with_body))
    } else if let Some(token) = path.strip_prefix(PAGE_PATH) {
        let found = {
            let kept = kept.lock().unwrap();
            kept.snapshots.get(token).filter(|s| Instant::now() < s.until && s.via == via).map(|s| (s.file.clone(), s.size, s.ancestor.clone()))
        };
        let page = match found {
            Some((file, size, ancestor)) => opened(&file, size).await.map(|file| (file, size, ancestor)),
            None => None,
        };
        match page {
            Some((file, size, ancestor)) => Answer::Page {
                head: head_of("200 OK", &[
                    ("Content-Type", "text/html; charset=utf-8".into()),
                    ("Content-Security-Policy", page_policy(ancestor.as_deref())),
                    ("Cross-Origin-Opener-Policy", "same-origin".into()),
                    ("Cross-Origin-Resource-Policy", "same-origin".into()),
                    ("Permissions-Policy", PERMISSIONS.into()),
                ], size),
                file,
                size,
            },
            None => Answer::Whole(refused("404 Not Found", "No such Yuzuno preview", with_body)),
        }
    } else {
        Answer::Whole(refused("404 Not Found", "No such Yuzuno preview", with_body))
    }
}

/// The answer to an admitted GET or HEAD of a proof's `challenge`.
fn proof_answer(challenge: &str, via: Via, origins: &[&str], kept: &Mutex<Kept>, with_body: bool) -> Vec<u8> {
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
        kept.snapshots.get(token).filter(|s| Instant::now() < s.until && s.via == Via::Phone(entry.run()))
            .map(|s| (s.file.clone(), s.size, s.ancestor.clone()))
    });
    let Some((file, size, ancestor)) = found else { return no_such().await };
    let Some(file) = opened(&file, size).await else { return no_such().await };
    let mut response = Response::new(chunks(file, size));
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

/// What a preview is taken of, found and not yet read.
enum Found {
    /// A Home attachment's snapshot, and what a card's preview of it is.
    Attachment { file: PathBuf, sha256: String, name: String, key: CardKey },
    /// A file in an Agent's working directory on this host.
    Local { file: PathBuf, name: String },
    /// One on the Agent's own machine, as its helper read it.
    Remote { bytes: Vec<u8>, name: String },
}

/// A page as Core keeps it: its file, what keeps that as it was, and what the reply says of it.
struct Taken {
    file: PathBuf,
    size: u64,
    sha256: String,
    name: String,
    version: Option<i64>,
    card: Option<CardKey>,
    keep: Keep,
}

/// Who asked, as the server's routing admitted the request, and where its snapshot and proof are.
struct Asked {
    via: Via,
    ancestor: Option<String>,
    /// The page's address and the proof's, but for the token or challenge.
    page_url: String,
    proof_url: String,
    method: Option<&'static str>,
    port: u16,
    place: Place,
}

impl Asked {
    /// The reply for snapshot `page`, with what it shows and a proof of its own.
    fn reply(&self, page: &str, shown: &Value, challenge: &str, answer: &str, reused: bool) -> Value {
        let mut proof = json!({"challenge": challenge, "answer": answer, "url": format!("{}{challenge}", self.proof_url)});
        if let Some(method) = self.method {
            proof["method"] = json!(method);
        }
        let mut reply = shown.clone();
        reply["port"] = json!(self.port);
        reply["url"] = json!(format!("{}{page}", self.page_url));
        reply["proof"] = proof;
        reply["place"] = json!(self.place.name());
        reply["reused"] = json!(reused);
        reply
    }

    /// A new proof whose answer is `answer`, for the page that asked, where it asked.
    fn proof(&self, answer: String) -> Proof {
        Proof { answer, origin: self.ancestor.clone(), until: Instant::now() + PROOF_TTL, used: false, via: self.via.clone() }
    }
}

/// Whether bytes given piece by piece are UTF-8 as a whole: a character a
/// piece ends inside of is carried into the next.
#[derive(Default)]
struct Utf8 {
    carried: Vec<u8>,
}

impl Utf8 {
    fn feed(&mut self, mut piece: &[u8]) -> bool {
        if let Some(&lead) = self.carried.first() {
            let width = match lead {
                0xC2..=0xDF => 2,
                0xE0..=0xEF => 3,
                0xF0..=0xF4 => 4,
                _ => return false,
            };
            let more = (width - self.carried.len()).min(piece.len());
            self.carried.extend_from_slice(&piece[..more]);
            piece = &piece[more..];
            if self.carried.len() < width {
                return true;
            }
            if std::str::from_utf8(&self.carried).is_err() {
                return false;
            }
            self.carried.clear();
        }
        match std::str::from_utf8(piece) {
            Ok(_) => true,
            // Cut short at its end: the rest of that character comes next.
            Err(error) if error.error_len().is_none() => {
                self.carried.extend_from_slice(&piece[error.valid_up_to()..]);
                true
            }
            Err(_) => false,
        }
    }

    /// Whether no character was left unfinished.
    fn whole(&self) -> bool {
        self.carried.is_empty()
    }
}

/// One pass over a page, CHUNK bytes at a time: its size and SHA-256, once
/// all of it is read, is UTF-8 and is at most `limit` bytes. Each chunk is
/// written to `copy` too.
fn scan(page: &mut impl std::io::Read, mut copy: Option<&mut std::fs::File>, limit: u64) -> Result<(u64, String)> {
    use std::io::Write;
    let (mut size, mut sha, mut text) = (0u64, Sha256::new(), Utf8::default());
    let mut chunk = vec![0; CHUNK];
    loop {
        let n = match page.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        };
        size += n as u64;
        ensure!(size <= limit, "preview_too_large: a previewed page is at most {} MB", limit >> 20);
        ensure!(text.feed(&chunk[..n]), "preview_unsupported: the file is not UTF-8 text");
        sha.update(&chunk[..n]);
        if let Some(copy) = copy.as_mut() {
            copy.write_all(&chunk[..n])?;
        }
    }
    ensure!(text.whole(), "preview_unsupported: the file is not UTF-8 text");
    Ok((size, format!("{:x}", sha.finalize())))
}

/// A new file for a copy, readable and writable by Core alone.
fn new_copy(path: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).with_context(|| format!("cannot copy into {}", path.display()))
}

impl Previews {
    /// What `found` is now, kept as it is: a Home attachment's snapshot held
    /// where it is, anything else copied once.
    async fn take(&self, data_dir: &Path, found: Found) -> Result<Taken> {
        match found {
            Found::Attachment { file, sha256, name, key } => {
                // Held before it is read: from here collect_garbage leaves it.
                let hold = crate::project_brief::hold_attachment(&file);
                let path = file.clone();
                let (size, sha) = tokio::task::spawn_blocking(move || -> Result<(u64, String)> {
                    let mut page = std::fs::File::open(&path).context("snapshot_missing: The snapshot of this attachment is no longer kept")?;
                    scan(&mut page, None, MAX_BYTES)
                })
                .await??;
                ensure!(sha == sha256, "preview_unavailable: the kept snapshot of this attachment no longer matches its SHA-256");
                let version = Some(key.version);
                Ok(Taken { file, size, sha256: sha, name, version, card: Some(key), keep: Keep { _hold: Some(hold), _copy: None } })
            }
            Found::Local { file, name } => self.copy(data_dir, name, move |copy| {
                let mut page = std::fs::File::open(&file).with_context(|| format!("{} cannot be read", file.display()))?;
                scan(&mut page, Some(copy), MAX_BYTES)
            }).await,
            Found::Remote { bytes, name } => self.copy(data_dir, name, move |copy| scan(&mut bytes.as_slice(), Some(copy), MAX_BYTES)).await,
        }
    }

    /// A conversation file as Core's copy of it, which `write` makes.
    async fn copy(&self, data_dir: &Path, name: String, write: impl FnOnce(&mut std::fs::File) -> Result<(u64, String)> + Send + 'static)
        -> Result<Taken> {
        let copied = Copied(self.copy_path(data_dir).await?);
        let path = copied.0.clone();
        let (size, sha256) = tokio::task::spawn_blocking(move || write(&mut new_copy(&path)?)).await??;
        Ok(Taken { file: copied.0.clone(), size, sha256, name, version: None, card: None, keep: Keep { _hold: None, _copy: Some(copied) } })
    }
}

impl Workspace {
    /// What `source` names, found where it is kept but not yet read, and its name.
    async fn preview_of(self: &Arc<Self>, source: &Source) -> Result<Found> {
        match source {
            Source::BriefAttachment { project_id, section, name, version, place } => {
                ensure!(html_name(name), "preview_unsupported: only a single .html or .htm file can be previewed");
                ensure!(*place == Place::Portal || version.is_some(), "invalid_input: a card's preview names the section version it shows");
                let kept = crate::project_brief::attachment_file(self, project_id, section, name, *version).await?;
                let key = CardKey { project: project_id.clone(), section: section.clone(), name: name.clone(), version: kept.version, sha256: kept.sha256.clone() };
                Ok(Found::Attachment { file: kept.path, sha256: kept.sha256, name: name.clone(), key })
            }
            Source::Artifact { agent_id, path } => {
                ensure!(html_name(path), "preview_unsupported: only a single .html or .htm file can be previewed");
                let agent = self.listed(agent_id).await?;
                let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
                Ok(match &agent.remote {
                    Some(remote) => Found::Remote { bytes: crate::remote::read_artifact(&remote.machine, &agent.cwd, path).await?, name },
                    None => Found::Local { file: artifact_path(&agent.cwd, path)?, name },
                })
            }
        }
    }

    /// The user's request to see `source` working: it is kept as it is now
    /// under a new token, with the proof for the page to check that its
    /// client reaches where it was taken for. A page on Core's own port
    /// (`origin` as the request had it) gets port P and a proof by GET (no
    /// `method`). One through the phone entry gets that entry's own origin,
    /// framed only by it, and a proof by POST (`method`), as its run serves
    /// now; or an error while phone access does not include previews. A card
    /// asking again is given its live snapshot, with a new proof. The reply
    /// alone carries the token and the proof's answer.
    pub async fn open_preview(self: &Arc<Self>, source: Source, asker: Asker<'_>) -> Result<Value> {
        if let Asker::Phone(entry) = &asker {
            ensure!(phone_open(self, entry), "{PHONE_OFF}");
        }
        let place = source.place();
        let found = self.preview_of(&source).await?;
        let asked = match asker {
            Asker::Local(origin) => {
                let port = self.previews.listening(self).await?;
                let base = format!("http://127.0.0.1:{port}");
                Asked { via: Via::Local, ancestor: origin_of(origin), page_url: format!("{base}{PAGE_PATH}"), proof_url: format!("{base}{PROOF_PATH}"),
                    method: None, port, place }
            }
            Asker::Phone(entry) => {
                let origin = entry.origin();
                let port = reqwest::Url::parse(origin).ok().and_then(|url| url.port_or_known_default()).unwrap_or(443);
                // By POST, which sends the page's Origin: a GET from the same origin usually sends none.
                Asked { via: Via::Phone(entry.run()), ancestor: Some(origin.to_owned()), page_url: format!("{origin}{PHONE_PAGE}"),
                    proof_url: format!("{origin}{PHONE_PROOF}"), method: Some("POST"), port, place }
            }
        };
        if let (Place::Card, Found::Attachment { key, .. }) = (place, &found) {
            let given = {
                let mut kept = self.previews.kept.lock().unwrap();
                let open = !matches!(asked.via, Via::Phone(run) if crate::remote_access::phone_previews(self) != Some(run));
                let left = Instant::now() + REUSE_LEFT;
                let live = kept.snapshots.iter()
                    .find(|(_, s)| open && s.place == Place::Card && s.card.as_ref() == Some(key) && s.ancestor == asked.ancestor
                        && s.via == asked.via && s.until >= left)
                    .map(|(page, s)| (page.clone(), s.shown.clone()));
                live.map(|(page, shown)| {
                    let (challenge, answer) = (token(), token());
                    kept.prove(challenge.clone(), asked.proof(answer.clone()));
                    asked.reply(&page, &shown, &challenge, &answer, true)
                })
            };
            if let Some(reply) = given {
                return Ok(reply);
            }
        }
        let taken = self.previews.take(&self.data_dir, found).await?;
        let (page, challenge, answer) = (token(), token(), token());
        let now = chrono::Utc::now();
        let shown = json!({
            "name": taken.name, "size": taken.size, "sha256": taken.sha256,
            "takenAt": now.to_rfc3339(),
            "expiresAt": (now + chrono::Duration::from_std(LIFETIME).context("lifetime")?).to_rfc3339(),
            "version": taken.version,
        });
        let reply = asked.reply(&page, &shown, &challenge, &answer, false);
        let until = Instant::now() + LIFETIME;
        let gone = {
            let mut kept = self.previews.kept.lock().unwrap();
            // Checked again under the lock that turning previews off clears
            // after it: nothing is kept for the phone once they are off.
            if matches!(asked.via, Via::Phone(run) if crate::remote_access::phone_previews(self) != Some(run)) {
                None
            } else {
                let gone = kept.make_room(place, taken.size);
                kept.snapshots.insert(page.clone(), Snapshot {
                    file: taken.file, size: taken.size, ancestor: asked.ancestor.clone(), until, via: asked.via.clone(), place,
                    card: taken.card.filter(|_| place == Place::Card), shown, _keep: taken.keep,
                });
                kept.order.push_back(page);
                kept.prove(challenge, asked.proof(answer));
                Some(gone)
            }
        };
        let Some(gone) = gone else { bail!("{PHONE_OFF}") };
        drop(gone);
        sweep_at(&self.previews.kept, until);
        Ok(reply)
    }
}

/// A single-file page of exactly `size` bytes (at least 512) for tests:
/// text with characters of every UTF-8 length, and a script at its very
/// end that says the whole page ran (YN-10).
#[cfg(test)]
pub(crate) fn synthetic_page(size: usize) -> Vec<u8> {
    let head = "<!doctype html><meta charset=\"utf-8\"><title>Large page</title><p id=\"end\">not run</p>\n";
    let tail = "\n<script>document.getElementById(\"end\").textContent=\"ran to the end\"</script>\n";
    let line = "<p>Plain ASCII, é ü ß, 中文字, 🙂 and more filler.</p>\n";
    assert!(size >= 512, "{size} bytes is too small a page");
    let mut page = String::with_capacity(size);
    page.push_str(head);
    // Whole lines while they fit, then a comment padded to the exact size.
    while page.len() + line.len() + "<!---->".len() + tail.len() <= size {
        page.push_str(line);
    }
    let pad = size - page.len() - "<!---->".len() - tail.len();
    page.push_str("<!--");
    page.push_str(&"a".repeat(pad));
    page.push_str("-->");
    page.push_str(tail);
    assert_eq!(page.len(), size);
    page.into_bytes()
}

#[cfg(test)]
#[path = "previews_tests.rs"]
mod tests;
