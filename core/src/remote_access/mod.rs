//! Phone and remote access from Settings (T-185).
//!
//! The phone entry (T-170) is a second loopback listener that only
//! Tailscale Serve is pointed at. Here Core owns it while running: an apply
//! binds the new listener, sets the one Serve entry Core owns, and closes
//! the old listener, with no restart. What applies is saved in the data
//! folder (`remote-access.json`) and read again at startup, so an update or
//! a plain restart serves the same entry.
//!
//! Until Settings have applied anything, the entry from YUZUNO_REMOTE_* (if
//! any) is served as before; after that Settings decide, and the environment
//! is shown as ignored.
//!
//! Each apply or disable is one recorded operation with an id and steps:
//! validate, save, listen, serve, verify, done. A request id repeats it; a
//! second one waits for none, it is refused while another runs. Only the
//! Serve entry Core created, or adopted because it was exactly the wanted
//! one, is ever changed, and only while it is still exactly that.
mod host;
#[cfg(test)]
mod tests;

use crate::{server::{ApiError, RemoteEntry}, workspace::Workspace};
use anyhow::{bail, Context, Result};
use axum::{
    extract::{Path as UrlPath, Request, State as AppState},
    middleware::Next,
    response::Response,
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}, time::Duration};
use tokio::sync::watch;

pub(crate) use host::Host;

pub const DEFAULT_SERVE_PORT: u16 = 8444;
pub const DEFAULT_LOCAL_PORT: u16 = 4318;
const FILE: &str = "remote-access.json";
const KEPT: usize = 20;

/// What the phone listener serves: its loopback port, the origin the
/// browser shows and the one Tailscale login let in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub port: u16,
    pub origin: String,
    pub login: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Desired {
    enabled: bool,
    login: String,
    serve_port: u16,
    local_port: u16,
    origin: Option<String>,
    saved_at: String,
}

/// What Settings last applied: the listener (None when off) and its Serve port.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Applied {
    listen: Option<Entry>,
    serve_port: Option<u16>,
    applied_at: String,
}

/// The one Serve entry Core may change: HTTPS on `serve_port` at `host`,
/// "/" proxying to `target`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owned {
    serve_port: u16,
    host: String,
    target: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    format: u32,
    desired: Option<Desired>,
    effective: Option<Applied>,
    owned: Option<Owned>,
    operations: Vec<Operation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApplyRequest {
    request_id: String,
    enabled: bool,
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    serve_port: Option<u16>,
    #[serde(default)]
    local_port: Option<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    id: String,
    request_id: String,
    kind: String,
    state: String,
    step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    notes: Vec<String>,
    started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    request: ApplyRequest,
}

struct Running {
    entry: Entry,
    since: String,
    source: &'static str,
    revoke: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

struct Started {
    assets: PathBuf,
    updates: Option<Arc<crate::updates::controller::Controller>>,
    core_port: u16,
}

/// The phone listener and what was last observed, per Workspace.
#[derive(Default)]
pub(crate) struct State {
    file: Mutex<()>,
    busy: Arc<tokio::sync::Mutex<()>>,
    listener: tokio::sync::Mutex<Option<Running>>,
    /// The listener as the page sees it, readable while an operation holds `listener`.
    current: Mutex<Option<(Entry, String, &'static str)>>,
    context: OnceLock<Started>,
    environment: OnceLock<Option<Entry>>,
    startup_error: OnceLock<String>,
    observed: Mutex<Value>,
    host: Mutex<Option<Host>>,
    #[cfg(test)]
    pub(super) test_host: OnceLock<Host>,
}

impl State {
    fn host(&self, fresh: bool) -> Host {
        #[cfg(test)]
        if let Some(host) = self.test_host.get() {
            return host.clone();
        }
        let mut cached = self.host.lock().unwrap();
        if fresh || cached.is_none() {
            *cached = Some(Host::detect());
        }
        cached.clone().unwrap()
    }
}

// ---- saved state -------------------------------------------------------

fn path(ws: &Workspace) -> PathBuf {
    ws.data_dir.join(FILE)
}

fn read(path: &Path) -> Result<Saved> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("{} is not a readable phone access record", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Saved { format: 1, ..Default::default() }),
        Err(error) => Err(error.into()),
    }
}

/// Read, change and write the record atomically, one writer at a time.
fn update<T>(ws: &Workspace, change: impl FnOnce(&mut Saved) -> Result<T>) -> Result<T> {
    let _held = ws.remote_access.file.lock().unwrap();
    let path = path(ws);
    let mut saved = read(&path)?;
    let value = change(&mut saved)?;
    saved.format = 1;
    let keep = saved.operations.len().saturating_sub(KEPT);
    saved.operations.drain(..keep);
    crate::updates::package::atomic_json(&path, &saved)?;
    Ok(value)
}

fn changed(ws: &Workspace) {
    ws.changes.publish(&json!({"type":"workspace.changed","scope":"remote-access"}));
}

// ---- startup -----------------------------------------------------------

/// What this Core serves for phones as it starts: the entry Settings last
/// applied, or with none applied yet, the one from YUZUNO_REMOTE_*.
pub struct Startup {
    listen: Option<(Entry, &'static str)>,
    environment: Option<Entry>,
    error: Option<String>,
}

pub struct Bound {
    listener: Option<(tokio::net::TcpListener, Entry, &'static str)>,
    environment: Option<Entry>,
    error: Option<String>,
}

pub fn startup(data: &Path, environment: Option<(u16, RemoteEntry)>) -> Startup {
    let environment = environment.map(|(port, entry)| Entry { port, origin: entry.origin().to_owned(), login: entry.login().to_owned() });
    match read(&data.join(FILE)) {
        Ok(Saved { effective: Some(applied), .. }) => Startup { listen: applied.listen.map(|e| (e, "settings")), environment, error: None },
        Ok(_) => Startup { listen: environment.clone().map(|e| (e, "environment")), environment, error: None },
        Err(error) => Startup {
            listen: None,
            environment,
            error: Some(format!("Phone access was not started: {error:#}. Apply it again from Settings.")),
        },
    }
}

impl Startup {
    /// Bind the listener before the Workspace opens. A YUZUNO_REMOTE_PORT
    /// that cannot be bound stops Core, as it always did; a port Settings
    /// chose only leaves phone access off, with the reason on the page.
    pub async fn bind(self) -> Result<Bound> {
        let Some((entry, source)) = self.listen else {
            return Ok(Bound { listener: None, environment: self.environment, error: self.error });
        };
        match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, entry.port)).await {
            Ok(listener) => Ok(Bound { listener: Some((listener, entry, source)), environment: self.environment, error: None }),
            Err(error) if source == "environment" => {
                Err(anyhow::Error::new(error).context("Cannot bind the remote entry's loopback port (YUZUNO_REMOTE_PORT)"))
            }
            Err(error) => Ok(Bound {
                listener: None,
                environment: self.environment,
                error: Some(format!("Phone access could not listen on 127.0.0.1:{}: {error}. Apply it again from Settings, or choose another port.", entry.port)),
            }),
        }
    }
}

/// Start serving what `bound` holds, and mark operations a stopped Core left
/// unfinished as interrupted.
pub fn run(ws: &Arc<Workspace>, bound: Bound, assets: PathBuf, updates: Option<Arc<crate::updates::controller::Controller>>, core_port: u16) {
    let state = &ws.remote_access;
    let _ = state.context.set(Started { assets, updates, core_port });
    let _ = state.environment.set(bound.environment);
    if let Some(error) = bound.error {
        eprintln!("{error}");
        let _ = state.startup_error.set(error);
    }
    let left = read(&path(ws)).is_ok_and(|saved| saved.operations.iter().any(|op| op.state == "running"));
    let interrupted = left.then(|| update(ws, |saved| {
        for op in saved.operations.iter_mut().filter(|op| op.state == "running") {
            op.state = "interrupted".into();
            op.error = Some(format!("Core stopped during the {} step; nothing was finished after it. Check the current state, then apply again.", op.step));
            op.finished_at = Some(crate::model::now());
        }
        Ok(())
    }));
    if let Some(Err(error)) = interrupted {
        eprintln!("Phone access record: {error:#}");
    }
    if let Some((listener, entry, source)) = bound.listener {
        eprintln!("Remote entry: http://127.0.0.1:{} for Tailscale Serve, as {}", entry.port, entry.origin);
        match spawn(ws, listener, entry, source) {
            Ok(running) => {
                let mut slot = state.listener.try_lock().expect("no operation runs before start");
                *slot = Some(running);
                mirror(ws, &slot);
            }
            Err(error) => eprintln!("Remote entry not started: {error:#}"),
        }
    }
}

// ---- the listener -------------------------------------------------------

fn spawn(ws: &Arc<Workspace>, listener: tokio::net::TcpListener, entry: Entry, source: &'static str) -> Result<Running> {
    let context = ws.remote_access.context.get().context("Phone access has not started")?;
    let remote = RemoteEntry::new(&entry.origin, &entry.login)?;
    let (revoke, revoked) = watch::channel(false);
    let app = crate::server::remote_router(ws.clone(), context.assets.clone(), context.updates.clone(), remote)
        .layer(axum::middleware::from_fn_with_state(revoked.clone(), end_on_revoke));
    let mut stop = revoked;
    let mut shutdown = context.updates.as_ref().map(|u| u.shutdown.subscribe());
    let task = tokio::spawn(async move {
        let served = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let core = async {
                    match shutdown.as_mut() {
                        Some(shutdown) => { let _ = shutdown.wait_for(|stopping| *stopping).await; }
                        None => std::future::pending::<()>().await,
                    }
                };
                tokio::select! {
                    _ = stop.wait_for(|revoked| *revoked) => {}
                    _ = core => {}
                }
            })
            .await;
        if let Err(error) = served {
            eprintln!("Remote entry stopped: {error}");
        }
    });
    Ok(Running { entry, since: crate::model::now(), source, revoke, task })
}

/// Copy what the listener slot holds for the page and Check.
fn mirror(ws: &Workspace, slot: &Option<Running>) {
    *ws.remote_access.current.lock().unwrap() = slot.as_ref().map(|r| (r.entry.clone(), r.since.clone(), r.source));
}

fn current(ws: &Workspace) -> Option<Entry> {
    ws.remote_access.current.lock().unwrap().as_ref().map(|c| c.0.clone())
}

/// Every response of a listener being replaced ends with it: an event stream
/// or download that began under the old login does not outlive it.
async fn end_on_revoke(AppState(revoked): AppState<watch::Receiver<bool>>, request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let (parts, body) = response.into_parts();
    let mut revoked = revoked;
    let ended = Box::pin(async move {
        let _ = revoked.wait_for(|revoked| *revoked).await;
    });
    Response::from_parts(parts, axum::body::Body::from_stream(body.into_data_stream().take_until(ended)))
}

/// Revoke and stop a listener: its open responses end, then it stops
/// accepting; one that does not finish in five seconds is aborted.
async fn close(running: Running) {
    let _ = running.revoke.send(true);
    let mut task = running.task;
    if tokio::time::timeout(Duration::from_secs(5), &mut task).await.is_err() {
        task.abort();
    }
}

/// How to put the listener back if an apply stops after `listen`.
enum Undo {
    /// It was already as asked.
    Keep,
    /// There was none: close the new one.
    Remove,
    /// The previous one, on another port, still runs: close the new one, keep it.
    Restore(Running),
    /// The previous one shared the port and was closed: bind it again.
    Rebind(Entry, &'static str),
}

async fn undo(ws: &Arc<Workspace>, slot: &mut Option<Running>, undo: Undo) {
    if matches!(undo, Undo::Keep) {
        return;
    }
    if let Some(new) = slot.take() {
        close(new).await;
    }
    match undo {
        Undo::Restore(previous) => *slot = Some(previous),
        Undo::Rebind(entry, source) => match bind(entry.port).await {
            Ok(listener) => *slot = spawn(ws, listener, entry, source).ok(),
            Err(error) => eprintln!("Phone access: the previous entry could not listen again: {error:#}"),
        },
        Undo::Keep | Undo::Remove => {}
    }
    mirror(ws, slot);
}

async fn bind(port: u16) -> Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .with_context(|| format!("Port 127.0.0.1:{port} is in use or not allowed; choose another local port"))
}

// ---- checks ------------------------------------------------------------

fn step(id: &str, state: &str, detail: impl Into<String>) -> Value {
    json!({"id": id, "state": state, "detail": detail.into()})
}

/// The Serve and local ports a check looks at: what applies, else what was
/// last saved, else the defaults.
fn planned(saved: &Saved) -> (u16, u16) {
    match (&saved.effective, &saved.desired) {
        (Some(Applied { listen: Some(entry), serve_port: Some(port), .. }), _) => (*port, entry.port),
        (_, Some(desired)) => (desired.serve_port, desired.local_port),
        _ => (DEFAULT_SERVE_PORT, DEFAULT_LOCAL_PORT),
    }
}

/// What the page's Check shows, read only: the host pair, Tailscale, HTTPS,
/// Core's listener, the Windows-to-WSL hop, the Serve entry and a request
/// through it from Windows. A step that needs a failed one is skipped.
/// Before setup (nothing listening) Serve is still read for the planned
/// port, so a port someone else uses shows before an apply.
async fn check(ws: &Arc<Workspace>, host: &Host, listen: Option<Entry>, ports: (u16, u16)) -> Value {
    let serve_port = ports.0;
    let mut steps = Vec::new();
    let mut tailscale = Value::Null;
    let mut serve = json!({"state": "unchecked", "otherEntries": 0});
    let skip = |id: &str, why: &str| step(id, "skipped", why);
    if !host.supported {
        steps.push(step("host", "failed", host.support["reason"].as_str().unwrap_or("Unsupported host")));
        for id in ["tailscale", "https", "listener", "hop", "serve", "endToEnd"] {
            steps.push(skip(id, "Needs a supported host"));
        }
        return json!({"steps": steps, "tailscale": tailscale, "serve": serve, "at": crate::model::now()});
    }
    steps.push(step("host", "ok", format!(
        "Core runs in WSL ({}, {} networking); Tailscale for Windows is at {}",
        host.support["coreHost"]["name"].as_str().unwrap_or("?"),
        host.support["coreHost"]["networking"].as_str().unwrap_or("unknown"),
        host.tailscale.display()
    )));
    let mut dns = None;
    match host::status(host).await {
        Ok(status) => {
            dns = status["dnsName"].as_str().map(str::to_owned);
            if status["state"] == "running" && dns.is_some() {
                steps.push(step("tailscale", "ok", format!("Tailscale is running on {} as {}", dns.as_deref().unwrap_or(""), status["ownerLogin"].as_str().unwrap_or("an unknown login"))));
                steps.push(if status["https"] == true {
                    step("https", "ok", format!("HTTPS certificates are on for {}", dns.as_deref().unwrap_or("")))
                } else {
                    step("https", "failed", "HTTPS certificates are off for this tailnet: turn on HTTPS Certificates in the Tailscale admin console (DNS)")
                });
            } else {
                steps.push(step("tailscale", "failed", format!("Tailscale is not running here ({}); sign in to Tailscale on Windows", status["backend"].as_str().unwrap_or("unknown"))));
                steps.push(skip("https", "Needs Tailscale running"));
                dns = None;
            }
            tailscale = status;
        }
        Err(error) => {
            steps.push(step("tailscale", "failed", format!("Could not read Tailscale's status: {error:#}")));
            steps.push(skip("https", "Needs Tailscale's status"));
            tailscale = json!({"state": "error", "https": false, "detail": format!("{error:#}"), "observedAt": crate::model::now()});
        }
    }
    let listening = match &listen {
        None => {
            steps.push(step("listener", "failed", "Core is not listening for phone access"));
            false
        }
        Some(entry) => {
            let url = format!("http://127.0.0.1:{}/api/health", entry.port);
            match local_get(&url).await {
                Ok((403, body)) if body.contains("Tailscale login") => {
                    steps.push(step("listener", "ok", format!("Core answers on 127.0.0.1:{} and refuses a request without the allowed Tailscale login", entry.port)));
                    true
                }
                Ok((code, body)) => {
                    steps.push(step("listener", "failed", format!("127.0.0.1:{} answered {code} ({}), not Core's phone entry", entry.port, body.trim())));
                    false
                }
                Err(error) => {
                    steps.push(step("listener", "failed", format!("Core's phone entry on 127.0.0.1:{} did not answer: {error:#}", entry.port)));
                    false
                }
            }
        }
    };
    let mut hop = false;
    if let (true, Some(entry)) = (listening, &listen) {
        match host::windows_get(host, &format!("http://127.0.0.1:{}/api/health", entry.port)).await {
            Ok((403, body)) if body.contains("Tailscale login") => {
                steps.push(step("hop", "ok", format!("Windows reaches Core on 127.0.0.1:{}", entry.port)));
                hop = true;
            }
            Ok((code, body)) => steps.push(step("hop", "failed", format!("From Windows, 127.0.0.1:{} answered {code} ({}): another program holds that port on Windows", entry.port, body.trim()))),
            Err(error) => steps.push(step("hop", "failed", format!(
                "Windows could not reach Core on 127.0.0.1:{} ({error:#}); WSL networking is {}",
                entry.port, host.support["coreHost"]["networking"].as_str().unwrap_or("unknown")
            ))),
        }
    } else {
        steps.push(skip("hop", "Needs Core listening"));
    }
    let target = format!("http://127.0.0.1:{}", listen.as_ref().map_or(ports.1, |e| e.port));
    let mut served = false;
    match &dns {
        Some(dns) => match host::serve_status(host).await {
            Ok(config) => {
                let (found, detail) = host::serve_entry(&config, dns, serve_port, &target);
                let owned = read(&path(ws)).ok().and_then(|s| s.owned);
                let ours = owned.as_ref().is_some_and(|o| o.serve_port == serve_port && &o.host == dns && o.target == target);
                serve = json!({
                    "state": match found { "match" if ours => "ours", "match" => "sameTargetNotRecorded", other => other },
                    "port": serve_port, "target": target, "otherEntries": host::other_entries(&config, serve_port),
                    "detail": detail, "observedAt": crate::model::now(),
                });
                served = found == "match" && listen.is_some();
                let (state, detail) = match (listen.is_some(), found) {
                    (true, "match") => ("ok", detail),
                    (false, "absent") => ("skipped", format!("Port {serve_port} is free for phone access; Save and apply sets it")),
                    (false, "match") => ("skipped", format!("{detail}, where Core is not listening; Save and apply takes it over")),
                    _ => ("failed", detail),
                };
                steps.push(step("serve", state, detail));
            }
            Err(error) => {
                serve = json!({"state": "error", "port": serve_port, "otherEntries": 0, "detail": format!("{error:#}"), "observedAt": crate::model::now()});
                steps.push(step("serve", "failed", format!("Could not read Serve's configuration: {error:#}")));
            }
        },
        None => steps.push(skip("serve", "Needs Tailscale running")),
    }
    match (served && hop, &listen) {
        (true, Some(entry)) => match host::windows_get(host, &format!("{}/api/health", entry.origin)).await {
            Ok((200, _)) => steps.push(step("endToEnd", "ok", format!("{} reached Core through Serve as this PC's Tailscale login", entry.origin))),
            Ok((403, body)) if body.contains("Tailscale login") => steps.push(step("endToEnd", "ok", format!(
                "{} reached Core through Serve; this PC's login is not {}, so Core refused it as configured", entry.origin, entry.login
            ))),
            Ok((code, body)) => steps.push(step("endToEnd", "failed", format!("{} answered {code} ({})", entry.origin, body.trim()))),
            Err(error) => steps.push(step("endToEnd", "failed", format!("{} could not be reached from Windows: {error:#}", entry.origin))),
        },
        _ => steps.push(skip("endToEnd", "Needs the Serve entry and the Windows hop")),
    }
    json!({"steps": steps, "tailscale": tailscale, "serve": serve, "at": crate::model::now()})
}

async fn local_get(url: &str) -> Result<(u16, String)> {
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build()?;
    let response = client.get(url).send().await?;
    let code = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok((code, body.chars().take(300).collect()))
}

fn observe(ws: &Workspace, result: &Value) {
    let ok = result["steps"].as_array().is_some_and(|steps| steps.iter().all(|s| s["state"] == "ok"));
    *ws.remote_access.observed.lock().unwrap() = json!({
        "tailscale": result["tailscale"], "serve": result["serve"],
        "verification": {"ok": ok, "at": result["at"], "steps": result["steps"]},
    });
}

// ---- the view ----------------------------------------------------------

/// The page's view, read only: nothing is probed and nothing is written.
async fn view(ws: &Arc<Workspace>, can_change: bool) -> Result<Value> {
    let state = &ws.remote_access;
    let saved = read(&path(ws))?;
    let host = state.host(false);
    let listening = state.current.lock().unwrap().as_ref().map(|(entry, since, source)| json!({
        "port": entry.port, "origin": entry.origin, "login": entry.login, "since": since, "source": source,
    }));
    let applied_url = match (&saved.effective, &saved.owned) {
        (Some(Applied { listen: Some(entry), serve_port: Some(port), .. }), Some(owned)) if owned.serve_port == *port && listening.is_some() => Some(entry.origin.clone()),
        _ => None,
    };
    let url = match (&saved.effective, &listening) {
        (Some(_), _) => applied_url,
        // Not applied from Settings: the environment's entry, once Check saw its Serve entry.
        (None, Some(listening)) => {
            let observed = state.observed.lock().unwrap();
            (observed["serve"]["state"] == "sameTargetNotRecorded").then(|| listening["origin"].as_str().unwrap_or("").to_owned())
        }
        _ => None,
    };
    let desired = saved.desired.as_ref().map(|d| {
        let applied = match &saved.effective {
            Some(Applied { listen, serve_port, .. }) => if d.enabled {
                listen.as_ref().is_some_and(|e| e.port == d.local_port && e.login == d.login && Some(&e.origin) == d.origin.as_ref()) && *serve_port == Some(d.serve_port)
            } else {
                listen.is_none()
            },
            None => false,
        };
        json!({"enabled": d.enabled, "login": d.login, "servePort": d.serve_port, "localPort": d.local_port, "origin": d.origin, "savedAt": d.saved_at, "applied": applied})
    });
    let environment = state.environment.get().cloned().flatten().map(|e| json!({
        "port": e.port, "origin": e.origin, "login": e.login, "ignored": saved.effective.is_some(),
    }));
    let observed = state.observed.lock().unwrap().clone();
    let operation = saved.operations.last().map(|op| serde_json::to_value(op).unwrap_or(Value::Null));
    Ok(json!({
        "support": host.support,
        "saved": desired,
        "environment": environment,
        "listening": listening,
        "serve": if observed["serve"].is_object() { observed["serve"].clone() } else { json!({"state": "unchecked", "otherEntries": 0}) },
        "tailscale": observed["tailscale"],
        "verification": observed["verification"],
        "operation": operation,
        "qr": url.as_deref().and_then(qr),
        "url": url,
        "startupError": state.startup_error.get(),
        "defaults": {"servePort": DEFAULT_SERVE_PORT, "localPort": DEFAULT_LOCAL_PORT},
        "canChange": can_change,
        "readOnlyReason": (!can_change).then_some("Phone access is changed from Yuzuno on the computer that runs Core, not through the phone entry."),
    }))
}

/// `url` as QR modules, one string per row, '1' dark, for the page to draw.
fn qr(url: &str) -> Option<Value> {
    let code = qrcodegen::QrCode::encode_text(url, qrcodegen::QrCodeEcc::Medium).ok()?;
    let size = code.size();
    let rows: Vec<String> = (0..size).map(|y| (0..size).map(|x| if code.get_module(x, y) { '1' } else { '0' }).collect()).collect();
    Some(json!({"size": size, "rows": rows}))
}

// ---- apply and disable --------------------------------------------------

async fn start(ws: &Arc<Workspace>, request: ApplyRequest) -> Result<Value> {
    anyhow::ensure!(!request.request_id.trim().is_empty() && request.request_id.len() <= 128, "requestId must contain 1–128 bytes");
    let existing = read(&path(ws))?.operations.into_iter().find(|op| op.request_id == request.request_id);
    if let Some(op) = existing {
        anyhow::ensure!(op.request == request, "idempotency_conflict: requestId already names a different phone access change");
        return Ok(serde_json::to_value(op)?);
    }
    let Ok(busy) = ws.remote_access.busy.clone().try_lock_owned() else {
        bail!("remote_access_busy: another phone access change is running; wait for it to finish");
    };
    let op = Operation {
        id: uuid::Uuid::new_v4().to_string(),
        request_id: request.request_id.clone(),
        kind: if request.enabled { "apply" } else { "disable" }.into(),
        state: "running".into(),
        step: "validate".into(),
        error: None,
        notes: Vec::new(),
        started_at: crate::model::now(),
        finished_at: None,
        url: None,
        request,
    };
    update(ws, |saved| {
        saved.operations.push(op.clone());
        Ok(())
    })?;
    changed(ws);
    let ws = ws.clone();
    let mut running = op.clone();
    tokio::spawn(async move {
        let host = ws.remote_access.host(true);
        let outcome = if running.request.enabled {
            enable(&ws, &host, &mut running).await
        } else {
            disable(&ws, &host, &mut running).await
        };
        match outcome {
            Ok(state) => running.state = state.into(),
            Err(error) => {
                if running.state == "running" {
                    running.state = if error.chain().any(|e| e.downcast_ref::<host::TimedOut>().is_some()) { "uncertain" } else { "failed" }.into();
                }
                running.error = Some(format!("{error:#}"));
            }
        }
        // A successful apply checked itself; anything else is read again now,
        // so the page never shows Serve as it was before the change.
        if !(running.kind == "apply" && matches!(running.step.as_str(), "verify" | "done")) {
            let ports = read(&path(&ws)).map(|saved| planned(&saved)).unwrap_or((DEFAULT_SERVE_PORT, DEFAULT_LOCAL_PORT));
            let result = check(&ws, &host, current(&ws), ports).await;
            observe(&ws, &result);
        }
        running.finished_at = Some(crate::model::now());
        drop(busy);
        record(&ws, &running);
    });
    Ok(serde_json::to_value(op)?)
}

fn record(ws: &Workspace, op: &Operation) {
    let saved = update(ws, |saved| {
        if let Some(slot) = saved.operations.iter_mut().find(|o| o.id == op.id) {
            *slot = op.clone();
        }
        Ok(())
    });
    if let Err(error) = saved {
        eprintln!("Phone access record: {error:#}");
    }
    changed(ws);
}

fn at(ws: &Workspace, op: &mut Operation, step: &str) {
    op.step = step.into();
    record(ws, op);
}

async fn enable(ws: &Arc<Workspace>, host: &Host, op: &mut Operation) -> Result<&'static str> {
    let context = ws.remote_access.context.get().context("Phone access has not started")?;
    // validate
    anyhow::ensure!(host.supported, "{}", host.support["reason"].as_str().unwrap_or("Unsupported host"));
    let status = host::status(host).await.context("Could not read Tailscale's status")?;
    anyhow::ensure!(status["state"] == "running", "Tailscale is not running here ({}); sign in to Tailscale on Windows first", status["backend"].as_str().unwrap_or("unknown"));
    let dns = status["dnsName"].as_str().context("Tailscale reports no name for this computer")?.to_owned();
    anyhow::ensure!(status["https"] == true, "HTTPS certificates are off for this tailnet: turn on HTTPS Certificates in the Tailscale admin console (DNS), then apply again");
    let login = match op.request.login.clone().filter(|l| !l.trim().is_empty()) {
        Some(login) => login,
        None => status["ownerLogin"].as_str().context("Tailscale names no login for this computer; enter the login to allow")?.to_owned(),
    };
    let serve_port = op.request.serve_port.unwrap_or(DEFAULT_SERVE_PORT);
    let local_port = op.request.local_port.unwrap_or(DEFAULT_LOCAL_PORT);
    anyhow::ensure!(serve_port != 0 && local_port != 0, "Ports must be 1–65535");
    anyhow::ensure!(local_port != context.core_port, "The local port must differ from Core's own port {}", context.core_port);
    let origin = if serve_port == 443 { format!("https://{dns}") } else { format!("https://{dns}:{serve_port}") };
    RemoteEntry::new(&origin, &login)?;
    let entry = Entry { port: local_port, origin: origin.clone(), login: login.clone() };
    let target = format!("http://127.0.0.1:{local_port}");
    // save: what the user asked for; what applies is unchanged.
    at(ws, op, "save");
    update(ws, |saved| {
        saved.desired = Some(Desired { enabled: true, login: login.clone(), serve_port, local_port, origin: Some(origin.clone()), saved_at: crate::model::now() });
        Ok(())
    })?;
    // listen
    at(ws, op, "listen");
    let mut slot = ws.remote_access.listener.lock().await;
    let rollback = if slot.as_ref().is_some_and(|r| r.entry == entry) {
        // Already served as asked (the environment's entry, adopted): kept as it is.
        if let Some(running) = slot.as_mut() {
            running.source = "settings";
        }
        Undo::Keep
    } else if slot.as_ref().is_some_and(|r| r.entry.port == local_port) {
        // Same port, another origin or login: the old one goes first.
        let old = slot.take().unwrap();
        let (old_entry, old_source) = (old.entry.clone(), old.source);
        close(old).await;
        match bind(local_port).await {
            Ok(listener) => *slot = Some(spawn(ws, listener, entry.clone(), "settings")?),
            Err(error) => {
                undo(ws, &mut slot, Undo::Rebind(old_entry, old_source)).await;
                return Err(error);
            }
        }
        Undo::Rebind(old_entry, old_source)
    } else {
        let listener = bind(local_port).await?;
        match slot.replace(spawn(ws, listener, entry.clone(), "settings")?) {
            Some(previous) => Undo::Restore(previous),
            None => Undo::Remove,
        }
    };
    mirror(ws, &slot);
    // serve
    at(ws, op, "serve");
    let config = match host::serve_status(host).await {
        Ok(config) => config,
        Err(error) => {
            undo(ws, &mut slot, rollback).await;
            op.state = "rolledBack".into();
            return Err(error.context("Could not read Serve's configuration; the previous phone access is unchanged"));
        }
    };
    let (found, detail) = host::serve_entry(&config, &dns, serve_port, &target);
    match found {
        "match" => {}
        "absent" => {
            if let Err(error) = host::serve_add(host, serve_port, &target).await {
                if error.downcast_ref::<host::TimedOut>().is_some() {
                    // Whether it took effect is unknown: look once more.
                    let now = host::serve_status(host).await.ok().map(|c| host::serve_entry(&c, &dns, serve_port, &target).0);
                    if now != Some("match") {
                        // Kept as it is: the retry finds the listener and checks Serve again.
                        if let Undo::Restore(previous) = rollback {
                            close(previous).await;
                        }
                        op.state = "uncertain".into();
                        return Err(error.context("Serve did not confirm the entry; apply again to check and finish"));
                    }
                } else {
                    undo(ws, &mut slot, rollback).await;
                    op.state = "rolledBack".into();
                    return Err(error.context("The previous phone access is unchanged"));
                }
            }
        }
        _ => {
            undo(ws, &mut slot, rollback).await;
            op.state = "rolledBack".into();
            bail!("{detail}. Choose another Serve port in the advanced settings; the previous phone access is unchanged");
        }
    }
    // The previous entry Core owned, on another port: removed only while it is still exactly that.
    let owned = read(&path(ws))?.owned;
    if let Some(old) = owned.filter(|o| o.serve_port != serve_port || o.target != target || o.host != dns) {
        let still = host::serve_entry(&config, &old.host, old.serve_port, &old.target).0;
        match still {
            "match" => {
                if let Err(error) = host::serve_off(host, old.serve_port).await {
                    op.notes.push(format!("The previous entry on port {} could not be removed: {error:#}", old.serve_port));
                }
            }
            "absent" => {}
            _ => op.notes.push(format!("Port {} was changed outside Yuzuno since it was set; it is left as it is", old.serve_port)),
        }
    }
    update(ws, |saved| {
        saved.effective = Some(Applied { listen: Some(entry.clone()), serve_port: Some(serve_port), applied_at: crate::model::now() });
        saved.owned = Some(Owned { serve_port, host: dns.clone(), target: target.clone() });
        Ok(())
    })?;
    drop(slot);
    if let Undo::Restore(previous) = rollback {
        close(previous).await;
    }
    op.url = Some(origin);
    // verify
    at(ws, op, "verify");
    let result = check(ws, host, current(ws), (serve_port, local_port)).await;
    observe(ws, &result);
    op.step = "done".into();
    if let Some(failed) = result["steps"].as_array().and_then(|s| s.iter().find(|s| s["state"] != "ok")) {
        op.step = "verify".into();
        op.error = Some(format!("Applied, but not verified: {} ({})", failed["detail"].as_str().unwrap_or(""), failed["id"].as_str().unwrap_or("")));
        return Ok("failed");
    }
    Ok("succeeded")
}

async fn disable(ws: &Arc<Workspace>, host: &Host, op: &mut Operation) -> Result<&'static str> {
    at(ws, op, "save");
    update(ws, |saved| {
        let previous = saved.desired.clone();
        saved.desired = Some(Desired {
            enabled: false,
            login: previous.as_ref().map(|d| d.login.clone()).unwrap_or_default(),
            serve_port: previous.as_ref().map_or(DEFAULT_SERVE_PORT, |d| d.serve_port),
            local_port: previous.as_ref().map_or(DEFAULT_LOCAL_PORT, |d| d.local_port),
            origin: previous.and_then(|d| d.origin),
            saved_at: crate::model::now(),
        });
        Ok(())
    })?;
    at(ws, op, "serve");
    let owned = read(&path(ws))?.owned;
    let mut keep_owned = None;
    let mut uncertain = false;
    if let Some(old) = owned {
        if !host.supported {
            op.notes.push(format!("Serve could not be changed on this host; port {} may still be served", old.serve_port));
            keep_owned = Some(old);
        } else {
            match host::serve_status(host).await.map(|c| host::serve_entry(&c, &old.host, old.serve_port, &old.target).0) {
                Ok("match") => {
                    if let Err(error) = host::serve_off(host, old.serve_port).await {
                        uncertain = error.downcast_ref::<host::TimedOut>().is_some();
                        op.notes.push(format!("Serve port {} was not removed: {error:#}", old.serve_port));
                        keep_owned = Some(old);
                    }
                }
                Ok("absent") => {}
                Ok(_) => op.notes.push(format!("Port {} was changed outside Yuzuno since it was set; it is left as it is", old.serve_port)),
                Err(error) => {
                    op.notes.push(format!("Serve's configuration could not be read: {error:#}"));
                    keep_owned = Some(old);
                    uncertain = true;
                }
            }
        }
    }
    at(ws, op, "listen");
    let mut slot = ws.remote_access.listener.lock().await;
    let running = slot.take();
    mirror(ws, &slot);
    drop(slot);
    if let Some(running) = running {
        close(running).await;
    }
    update(ws, |saved| {
        saved.effective = Some(Applied { listen: None, serve_port: None, applied_at: crate::model::now() });
        saved.owned = keep_owned.clone();
        Ok(())
    })?;
    op.step = "done".into();
    if uncertain {
        op.error = Some("Phone access is off in Core; whether Serve still lists its port is unknown. Disable again to check".into());
        return Ok("uncertain");
    }
    if keep_owned.is_some() {
        op.error = Some(op.notes.join("; "));
        return Ok("failed");
    }
    Ok("succeeded")
}

// ---- HTTP ---------------------------------------------------------------

/// Marks a request that came through the phone entry (server.rs).
#[derive(Clone, Copy)]
pub struct RemoteRequest;

async fn get_view(AppState(ws): AppState<Arc<Workspace>>, request: Request) -> Result<Json<Value>, ApiError> {
    let can_change = request.extensions().get::<RemoteRequest>().is_none();
    Ok(Json(view(&ws, can_change).await?))
}

async fn post_check(AppState(ws): AppState<Arc<Workspace>>, request: Request) -> Result<Json<Value>, ApiError> {
    let can_change = request.extensions().get::<RemoteRequest>().is_none();
    let host = ws.remote_access.host(true);
    let saved = read(&path(&ws))?;
    let result = check(&ws, &host, current(&ws), planned(&saved)).await;
    observe(&ws, &result);
    changed(&ws);
    Ok(Json(view(&ws, can_change).await?))
}

async fn post_apply(AppState(ws): AppState<Arc<Workspace>>, Json(request): Json<ApplyRequest>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"operation": start(&ws, request).await?})))
}

async fn get_operation(AppState(ws): AppState<Arc<Workspace>>, UrlPath(id): UrlPath<String>) -> Result<Json<Value>, ApiError> {
    let op = read(&path(&ws))?.operations.into_iter().find(|op| op.id == id).context("Unknown phone access operation")?;
    Ok(Json(serde_json::to_value(op)?))
}

/// Reading routes, on Core's port and on the phone entry.
pub(crate) fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/remote-access", get(get_view))
        .route("/api/remote-access/check", post(post_check))
        .route("/api/remote-access/operations/{id}", get(get_operation))
}

/// Changing routes: on Core's own port only, so a phone cannot lock itself out.
pub(crate) fn changes() -> Router<Arc<Workspace>> {
    Router::new().route("/api/remote-access/apply", post(post_apply))
}
