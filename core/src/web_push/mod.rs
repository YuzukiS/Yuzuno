//! Push notifications to Home Screen web apps (T-200): Web Push (RFC 8030)
//! with VAPID (RFC 8292), to Apple's push service only.
//!
//! A device's page subscribes with the key this Core made, and says which
//! of T-188's kinds it wants. Core compares one read of the Agent list and
//! Home's Asks with the next, as a page does (see `notices`), and sends
//! each new notice to the devices that want its kind: no conversation text,
//! no URL, at most one push per event. A push service that says the
//! subscription is gone, or refuses it, stops sending to it; a send it does
//! not answer is counted, never retried, and enough in a row stop it too.
//!
//! Routes, on both ports, under the browser's usual checks:
//! - `GET /api/push` → `{publicKey}`: base64url (65 bytes), or null before
//!   any device turned push on.
//! - `POST /api/push/key` `{}` → `{publicKey}`: made once, on a device's
//!   Turn on; the same key after.
//! - `POST /api/push/subscriptions` `{endpoint, keys:{p256dh, auth}, kinds}`
//!   (a `PushSubscription.toJSON()` and the kinds) → `{state:"active", kinds}`.
//!   The same endpoint again replaces its keys and kinds and sends again.
//! - `POST /api/push/subscriptions/state` `{endpoint}` → `{state, kinds?,
//!   stoppedAt?, reason?, deliveredAt?, lastError?}`; state is active,
//!   expired, failed or none.
//! - `POST /api/push/subscriptions/remove` `{endpoint}` → `{removed}`: only
//!   that device's subscription.
//!
//! A refusal is 400 `{error, code}`.
//!
//! The key and subscriptions are kept in `push.json` in the data folder,
//! which a backup leaves out: a restored Workspace has none, and each device
//! turns push on again.
mod crypto;
mod notices;
mod send;
#[cfg(test)]
mod tests;

use crate::{server::ApiError, store::Store, workspace::Workspace};
use anyhow::{Context, Result};
use axum::{
    extract::State as AppState,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use notices::{Kind, Notice, Read, Recent};
use send::{Answer, Outgoing};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::Notify;

pub(crate) const FILE: &str = "push.json";
/// Devices one Core sends to.
const DEVICES: usize = 20;
/// Sends in a row not answered before a subscription is stopped.
const UNANSWERED: u32 = 5;
const ENDPOINT_CHARS: usize = 2048;
/// How long a push service keeps a message for a device that is offline.
const TTL: u32 = 12 * 60 * 60;
/// A VAPID token lasts this long (Apple: at most a day) and is made again
/// after `TOKEN_REUSE` (Apple: no more than once an hour).
const TOKEN_LIFE: i64 = 12 * 60 * 60;
const TOKEN_REUSE: i64 = 6 * 60 * 60;
/// Changes that arrive together are read once, after this.
const SETTLE: Duration = Duration::from_millis(800);
/// Read again at least this often while a device is subscribed, for what no
/// message announces (an Ask's deferral ending).
const LOOK: Duration = Duration::from_secs(60);
/// Look for a first subscription this often, besides being woken.
const IDLE: Duration = Duration::from_secs(300);

#[derive(Default)]
pub(crate) struct State {
    /// One writer of push.json at a time.
    file: Mutex<()>,
    started: OnceLock<()>,
    /// A device subscribed: compare from now.
    wake: Arc<Notify>,
    recent: Mutex<Recent>,
    client: Mutex<Option<send::Https>>,
    tokens: Mutex<HashMap<(String, String), (String, i64)>>,
    #[cfg(test)]
    test_post: OnceLock<Arc<dyn Fn(&Outgoing) -> Answer + Send + Sync>>,
    /// Reads compared so far (tests wait for the first).
    #[cfg(test)]
    reads: std::sync::atomic::AtomicUsize,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    format: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<SavedKey>,
    #[serde(default)]
    subscriptions: Vec<Subscription>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedKey {
    /// PKCS#8, base64url: never shown, never in a backup.
    pkcs8: String,
    public_key: String,
    created_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Standing {
    Active,
    /// The push service no longer has it.
    Expired,
    /// The push service refused it, or did not answer often enough.
    Failed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Subscription {
    endpoint: String,
    p256dh: String,
    auth: String,
    kinds: Vec<Kind>,
    /// The page's origin when it subscribed: the VAPID `sub`.
    origin: String,
    /// Made again on each subscribe, so what a send recorded about an older
    /// one does not apply to it.
    id: String,
    state: Standing,
    subscribed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stopped_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default)]
    unanswered: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delivered_at: Option<String>,
}

// ---- saved state -------------------------------------------------------

fn path(ws: &Workspace) -> PathBuf {
    ws.data_dir.join(FILE)
}

fn read_saved(path: &Path) -> Result<Saved> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("{} is not a readable push record", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Saved { format: 1, ..Default::default() }),
        Err(error) => Err(error.into()),
    }
}

fn load(ws: &Workspace) -> Result<Saved> {
    let _held = ws.web_push.file.lock().unwrap();
    read_saved(&path(ws))
}

/// Read, change and write push.json, one writer at a time.
fn update<T>(ws: &Workspace, change: impl FnOnce(&mut Saved) -> Result<T>) -> Result<T> {
    let _held = ws.web_push.file.lock().unwrap();
    let path = path(ws);
    let mut saved = read_saved(&path)?;
    let value = change(&mut saved)?;
    saved.format = 1;
    crate::updates::package::atomic_json(&path, &saved)?;
    Ok(value)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---- routes -------------------------------------------------------------

pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/push", get(status))
        .route("/api/push/key", post(create_key))
        .route("/api/push/subscriptions", post(subscribe))
        .route("/api/push/subscriptions/state", post(subscription_state))
        .route("/api/push/subscriptions/remove", post(unsubscribe))
}

fn refused(code: &str, error: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error": error.into(), "code": code}))).into_response()
}

fn failed(error: anyhow::Error) -> Response {
    ApiError::from(error).into_response()
}

async fn status(AppState(ws): AppState<Arc<Workspace>>) -> Response {
    match load(&ws) {
        Ok(saved) => Json(json!({"publicKey": saved.key.map(|k| k.public_key)})).into_response(),
        Err(error) => failed(error),
    }
}

async fn create_key(AppState(ws): AppState<Arc<Workspace>>) -> Response {
    let made = update(&ws, |saved| {
        if saved.key.is_none() {
            let pkcs8 = crypto::Vapid::generate()?;
            let public = crypto::b64(crypto::Vapid::from_pkcs8(&pkcs8)?.public_key());
            saved.key = Some(SavedKey { pkcs8: crypto::b64(&pkcs8), public_key: public, created_at: now() });
        }
        Ok(saved.key.as_ref().map(|k| k.public_key.clone()))
    });
    match made {
        Ok(public) => Json(json!({"publicKey": public})).into_response(),
        Err(error) => failed(error),
    }
}

/// The push service's origin (the VAPID `aud`) when `endpoint` is one this
/// Core sends to: HTTPS on Apple's push service, on its usual port.
fn push_service(endpoint: &str) -> Option<String> {
    if endpoint.len() > ENDPOINT_CHARS {
        return None;
    }
    let url = reqwest::Url::parse(endpoint).ok()?;
    let host = url.domain()?;
    let apple = host.strip_suffix(".push.apple.com").is_some_and(|name| !name.is_empty() && !name.contains(".."));
    (url.scheme() == "https" && apple && url.username().is_empty() && url.password().is_none()
        && url.port().is_none() && url.fragment().is_none())
        .then(|| format!("https://{host}"))
}

fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

async fn subscribe(AppState(ws): AppState<Arc<Workspace>>, headers: HeaderMap, Json(input): Json<Value>) -> Response {
    let Some(endpoint) = text(&input, "endpoint") else { return refused("push_subscription_invalid", "The subscription has no endpoint.") };
    if push_service(endpoint).is_none() {
        return refused("push_service_unsupported", "Yuzuno sends push notifications only through Apple's push service (an iPhone or iPad Home Screen app).");
    }
    let keys = &input["keys"];
    let p256dh = text(keys, "p256dh").and_then(crypto::unb64);
    let auth = text(keys, "auth").and_then(crypto::unb64);
    let (Some(p256dh), Some(auth)) = (p256dh, auth) else {
        return refused("push_subscription_invalid", "The subscription's keys are missing or not base64url.");
    };
    if auth.len() != 16 || !crypto::device_key_usable(&p256dh) {
        return refused("push_subscription_invalid", "The subscription's keys are not a P-256 key and a 16-byte secret.");
    }
    let Some(asked) = input["kinds"].as_array() else { return refused("push_kind_unknown", "Say which kinds to send: needsYou, finished, failed.") };
    let mut kinds = Vec::new();
    for kind in asked {
        match serde_json::from_value::<Kind>(kind.clone()) {
            Ok(kind) if !kinds.contains(&kind) => kinds.push(kind),
            Ok(_) => {}
            Err(_) => return refused("push_kind_unknown", format!("{kind} is not a kind of notification: needsYou, finished or failed.")),
        }
    }
    // Browsers send the page's origin with every POST.
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).filter(|o| o.starts_with("https://") || o.starts_with("http://"));
    let Some(origin) = origin.filter(|o| o.len() <= 256).map(str::to_owned) else {
        return refused("push_subscription_invalid", "Subscribe from the Yuzuno page.");
    };
    let endpoint = endpoint.to_owned();
    let (p256dh, auth) = (crypto::b64(&p256dh), crypto::b64(&auth));
    let saved = update(&ws, |saved| {
        if saved.key.is_none() {
            return Ok(Err(refused("push_key_missing", "This Core has no push key yet: turn push on again.")));
        }
        saved.subscriptions.retain(|s| s.endpoint != endpoint);
        if saved.subscriptions.len() >= DEVICES {
            // Make room from subscriptions that are stopped, the oldest first.
            match saved.subscriptions.iter().position(|s| s.state != Standing::Active) {
                Some(stopped) => { saved.subscriptions.remove(stopped); }
                None => return Ok(Err(refused("push_devices_full", format!("This Core already sends to {DEVICES} devices. Turn push off on one of them first.")))),
            }
        }
        saved.subscriptions.push(Subscription {
            endpoint, p256dh, auth, kinds: kinds.clone(), origin, id: uuid::Uuid::new_v4().to_string(), state: Standing::Active,
            subscribed_at: now(), stopped_at: None, reason: None, unanswered: 0, last_error: None, delivered_at: None,
        });
        Ok(Ok(()))
    });
    match saved {
        Ok(Ok(())) => {
            ws.web_push.wake.notify_one();
            Json(json!({"state": Standing::Active, "kinds": kinds})).into_response()
        }
        Ok(Err(refusal)) => refusal,
        Err(error) => failed(error),
    }
}

async fn subscription_state(AppState(ws): AppState<Arc<Workspace>>, Json(input): Json<Value>) -> Response {
    let Some(endpoint) = text(&input, "endpoint") else { return refused("push_subscription_invalid", "Say which endpoint.") };
    match load(&ws) {
        Ok(saved) => Json(match saved.subscriptions.iter().find(|s| s.endpoint == endpoint) {
            None => json!({"state": "none"}),
            Some(s) => json!({"state": s.state, "kinds": s.kinds, "stoppedAt": s.stopped_at, "reason": s.reason,
                "deliveredAt": s.delivered_at, "lastError": s.last_error}),
        }).into_response(),
        Err(error) => failed(error),
    }
}

async fn unsubscribe(AppState(ws): AppState<Arc<Workspace>>, Json(input): Json<Value>) -> Response {
    let Some(endpoint) = text(&input, "endpoint").map(str::to_owned) else { return refused("push_subscription_invalid", "Say which endpoint.") };
    let removed = update(&ws, |saved| {
        let before = saved.subscriptions.len();
        saved.subscriptions.retain(|s| s.endpoint != endpoint);
        Ok(saved.subscriptions.len() != before)
    });
    match removed {
        Ok(removed) => Json(json!({"removed": removed})).into_response(),
        Err(error) => failed(error),
    }
}

// ---- noticing ----------------------------------------------------------

fn subscribed(ws: &Workspace) -> bool {
    match load(ws) {
        Ok(saved) => saved.key.is_some() && saved.subscriptions.iter().any(|s| s.state == Standing::Active && !s.kinds.is_empty()),
        Err(error) => {
            eprintln!("Push notifications: {error:#}");
            false
        }
    }
}

fn read_now(store: &Store) -> Result<Read> {
    let agents = store.agents()?;
    let names: HashMap<&str, &str> = agents.iter().map(|a| (a.id.as_str(), a.name.as_str())).collect();
    let asks = crate::project_brief::open_asks(store)?.into_iter().map(|ask| notices::AskState {
        agent_name: names.get(ask.owner_id.as_str()).map_or(ask.owner_name.clone(), |n| (*n).to_owned()),
        project: ask.project,
        key: ask.key,
        since: ask.since,
    }).collect();
    let agents = agents.iter().map(|a| notices::AgentState {
        id: a.id.clone(),
        name: a.name.clone(),
        status: a.status.clone(),
        pending: a.pending_count,
        closed: a.closed_at.is_some(),
        summary: a.work_summary.as_ref().map(|s| s.kind.clone()),
        turn: a.work_summary.as_ref().and_then(|s| s.turn_id.clone()),
        request: a.work_summary.as_ref().and_then(|s| s.request_id.clone()),
    }).collect();
    Ok(Read { agents, asks })
}

/// A message after which the Agent list or Home's Asks may read otherwise.
fn worth_reading(data: &str) -> bool {
    ["\"type\":\"agent.changed\"", "\"type\":\"agent.progress\"", "\"scope\":\"brief\""].iter().any(|t| data.contains(t))
}

impl Workspace {
    /// Starts comparing reads for push notifications; while no device is
    /// subscribed, nothing is read. Holds only a Weak owner.
    pub(crate) fn start_web_push(self: &Arc<Self>) {
        if self.web_push.started.set(()).is_err() {
            return;
        }
        tokio::spawn(watch(Arc::downgrade(self)));
    }
}

async fn watch(weak: Weak<Workspace>) {
    let mut last: Option<Read> = None;
    'subscribed: loop {
        let Some(ws) = weak.upgrade() else { return };
        let (changes, wake) = (ws.changes.clone(), ws.web_push.wake.clone());
        if !subscribed(&ws) {
            last = None;
            drop(ws);
            tokio::select! { _ = wake.notified() => {}, _ = tokio::time::sleep(IDLE) => {} }
            continue;
        }
        drop(ws);
        let mut stream = changes.subscribe(None);
        loop {
            let Some(ws) = weak.upgrade() else { return };
            if !subscribed(&ws) {
                continue 'subscribed;
            }
            // The first read is what later ones are compared with.
            match ws.stored(read_now).await {
                Ok(now) => {
                    if let Some(before) = &last {
                        let found = ws.web_push.recent.lock().unwrap().fresh(notices::notices(before, &now));
                        if !found.is_empty() {
                            tokio::spawn(deliver(ws.clone(), found));
                        }
                    }
                    last = Some(now);
                    #[cfg(test)]
                    ws.web_push.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                Err(error) => eprintln!("Push notifications: {error:#}"),
            }
            drop(ws);
            let woken = tokio::select! {
                more = async {
                    while let Some(entry) = stream.recv().await {
                        if worth_reading(&entry.data) { return true; }
                    }
                    false
                } => more,
                _ = tokio::time::sleep(LOOK) => true,
                _ = wake.notified() => true,
            };
            if !woken {
                // Dropped for falling behind: listen again. Closed: Core stops.
                if stream.overflowed() { continue 'subscribed; }
                return;
            }
            tokio::time::sleep(SETTLE).await;
            while stream.try_next().is_some() {}
        }
    }
}

// ---- sending -----------------------------------------------------------

/// A short coalescing name for a tag (RFC 8030 §5.4: at most 32 base64url
/// characters): a newer message with it replaces one not yet delivered.
fn topic(tag: &str) -> String {
    crypto::b64(&sha2::Sha256::digest(tag.as_bytes())[..16])
}

fn authorization(ws: &Workspace, key: &crypto::Vapid, aud: &str, sub: &str) -> Result<String> {
    let at = chrono::Utc::now().timestamp();
    let mut tokens = ws.web_push.tokens.lock().unwrap();
    let wanted = (aud.to_owned(), sub.to_owned());
    let token = match tokens.get(&wanted) {
        Some((token, made)) if at - made < TOKEN_REUSE => token.clone(),
        _ => {
            let token = key.token(aud, sub, at + TOKEN_LIFE)?;
            tokens.insert(wanted, (token.clone(), at));
            token
        }
    };
    Ok(key.authorization(&token))
}

async fn push_to(ws: &Workspace, out: &Outgoing) -> Answer {
    #[cfg(test)]
    if let Some(fake) = ws.web_push.test_post.get() {
        return fake(out);
    }
    let client = {
        let mut client = ws.web_push.client.lock().unwrap();
        if client.is_none() {
            match send::client() {
                Ok(made) => *client = Some(made),
                Err(error) => return Answer::Unanswered(format!("{error:#}")),
            }
        }
        client.clone().unwrap()
    };
    send::post(&client, out).await
}

async fn send_one(ws: &Workspace, key: &crypto::Vapid, to: &Subscription, notice: &Notice, workspace: &str) -> Answer {
    let made = (|| -> Result<Outgoing> {
        let aud = push_service(&to.endpoint).context("not a push service this Core sends to")?;
        let p256dh = crypto::unb64(&to.p256dh).context("the saved device key")?;
        let auth = crypto::unb64(&to.auth).context("the saved device secret")?;
        let body = crypto::encrypt(&p256dh, &auth, &serde_json::to_vec(&notices::payload(notice, workspace))?)?;
        Ok(Outgoing {
            endpoint: to.endpoint.clone(),
            authorization: authorization(ws, key, &aud, &to.origin)?,
            ttl: TTL,
            urgency: if notice.kind == Kind::NeedsYou { "high" } else { "normal" },
            topic: topic(&notice.tag),
            body,
        })
    })();
    match made {
        Ok(out) => push_to(ws, &out).await,
        Err(error) => Answer::Refused(0, format!("not sent: {error:#}")),
    }
}

/// What a send says about the subscription, if it is still the one sent
/// to. True when it is stopped now.
fn record(ws: &Workspace, to: &Subscription, answer: &Answer) -> Result<bool> {
    update(ws, |saved| {
        let Some(s) = saved.subscriptions.iter_mut().find(|s| s.id == to.id && s.state == Standing::Active) else { return Ok(true) };
        let stop = |s: &mut Subscription, state: Standing, reason: String| {
            s.state = state;
            s.stopped_at = Some(now());
            s.reason = Some(reason);
        };
        match answer {
            Answer::Accepted => {
                s.unanswered = 0;
                s.last_error = None;
                s.delivered_at = Some(now());
            }
            Answer::Gone(status) => stop(s, Standing::Expired, format!("The push service no longer has this subscription (HTTP {status}).")),
            Answer::Refused(status, why) => {
                let said = if why.is_empty() { String::new() } else { format!(": {why}") };
                let status = if *status == 0 { String::new() } else { format!(" (HTTP {status})") };
                stop(s, Standing::Failed, format!("The push service refused it{status}{said}."));
            }
            Answer::Unanswered(why) => {
                s.unanswered += 1;
                s.last_error = Some(why.clone());
                if s.unanswered >= UNANSWERED {
                    stop(s, Standing::Failed, format!("{UNANSWERED} sends in a row were not delivered; the last: {why}."));
                }
            }
        }
        Ok(s.state != Standing::Active)
    })
}

async fn deliver(ws: Arc<Workspace>, found: Vec<Notice>) {
    let saved = match load(&ws) {
        Ok(saved) => saved,
        Err(error) => return eprintln!("Push notifications: {error:#}"),
    };
    let key = saved.key.as_ref()
        .and_then(|k| crypto::unb64(&k.pkcs8))
        .map(|pkcs8| crypto::Vapid::from_pkcs8(&pkcs8));
    let key = match key {
        Some(Ok(key)) => key,
        Some(Err(error)) => return eprintln!("Push notifications: {error:#}"),
        None => return,
    };
    let workspace = match ws.stored(|store| store.workspace_id()).await {
        Ok(id) => id,
        Err(error) => return eprintln!("Push notifications: {error:#}"),
    };
    for to in saved.subscriptions.iter().filter(|s| s.state == Standing::Active) {
        let wanted = found.iter().filter(|n| to.kinds.contains(&n.kind)).cloned().collect();
        for notice in notices::merged(wanted) {
            let answer = send_one(&ws, &key, to, &notice, &workspace).await;
            match record(&ws, to, &answer) {
                Ok(false) => {}
                Ok(true) => break,
                Err(error) => {
                    eprintln!("Push notifications: {error:#}");
                    break;
                }
            }
        }
    }
}
