//! Phone previews (T-5): the second Serve entry Core owns, for single-file
//! HTML previews asked for through the phone entry (previews.rs).
//!
//! A page through the phone entry cannot reach the previews' port P, which
//! only loopback reaches. Here Core binds one more loopback listener, the
//! phone previews' entry, and points one more Serve entry at it: HTTPS on
//! another port of the phone entry's tailnet name, so that it is an origin
//! of its own. It serves snapshots and their proofs only, to the phone
//! entry's login under that name (`previews::admit`); Core's API is never
//! there.
//!
//! It is a switch of its own, off until the user turns it on: no record, or
//! one from before it, opens nothing. It is kept in a file of its own
//! (`remote-preview.json`), so the phone entry's record, and an older Core
//! reading that, are untouched, and an entry for previews that cannot be set
//! up or started never takes the phone entry down. Its changes are
//! operations like the phone entry's (steps, request IDs, one change at a
//! time, theirs included), on Core's own port only. It needs phone access
//! on, and turning phone access off turns it off too.
use super::*;

pub const DEFAULT_SERVE_PORT: u16 = 8445;
pub const DEFAULT_LOCAL_PORT: u16 = 4319;
const FILE: &str = "remote-preview.json";

/// The phone previews' entry: the Serve port a phone opens, and the
/// loopback port Serve sends it to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Ports {
    pub(super) serve_port: u16,
    pub(super) local_port: u16,
}

#[cfg(test)]
impl Ports {
    pub(super) fn for_tests(serve_port: u16, local_port: u16) -> Self {
        Self { serve_port, local_port }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Desired {
    enabled: bool,
    serve_port: u16,
    local_port: u16,
    saved_at: String,
}

/// What last applied: the entry served (None when off).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Applied {
    listen: Option<Ports>,
    applied_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Saved {
    format: u32,
    desired: Option<Desired>,
    effective: Option<Applied>,
    /// The one Serve entry for previews Core may change.
    owned: Option<Owned>,
    pub(super) operations: Vec<Operation<PreviewRequest>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewRequest {
    request_id: String,
    enabled: bool,
    #[serde(default)]
    serve_port: Option<u16>,
    #[serde(default)]
    local_port: Option<u16>,
}

struct Running {
    local_port: u16,
    task: tokio::task::JoinHandle<()>,
}

/// The previews' listener and what was last observed of it, per Workspace.
#[derive(Default)]
pub(crate) struct State {
    listener: tokio::sync::Mutex<Option<Running>>,
    /// What serves now: the ports, the tailnet name Serve has the entry for,
    /// and since when. The door is read from it, while an operation holds
    /// `listener` too.
    current: Mutex<Option<(Ports, String, String)>>,
    startup_error: OnceLock<String>,
    observed: Mutex<Value>,
}

// ---- saved state -------------------------------------------------------

pub(super) fn path(ws: &Workspace) -> PathBuf {
    ws.data_dir.join(FILE)
}

pub(super) fn read(path: &Path) -> Result<Saved> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("{} is not a readable phone previews record", path.display())),
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

fn set_aside(ws: &Workspace) -> Result<String> {
    let _held = ws.remote_access.file.lock().unwrap();
    let name = format!("{FILE}.unreadable-{}", uuid::Uuid::new_v4().simple());
    std::fs::rename(path(ws), ws.data_dir.join(&name))?;
    Ok(name)
}

/// `https://<name>[:<port>]`, with no port for 443, as a browser shows it.
fn authority(name: &str, port: u16) -> String {
    if port == 443 { name.to_owned() } else { format!("{name}:{port}") }
}

/// The phone entry's tailnet name and HTTPS port, from its origin.
fn phone_name(entry: &Entry) -> Option<(String, u16)> {
    let url = reqwest::Url::parse(&entry.origin).ok()?;
    Some((url.host_str()?.to_owned(), url.port_or_known_default()?))
}

/// The phone previews' entry as it lets requests in now: only while it
/// listens with its Serve entry set, and while the phone entry it serves is
/// on the same tailnet name; with that entry's page origin and login.
pub(crate) fn door(ws: &Workspace) -> Option<crate::previews::Door> {
    let (ports, name, _) = ws.remote_access.preview.current.lock().unwrap().clone()?;
    let phone = current(ws)?;
    (phone_name(&phone)?.0 == name).then(|| crate::previews::Door {
        host: authority(&name, ports.serve_port),
        origin: phone.origin,
        login: phone.login,
    })
}

// ---- startup -----------------------------------------------------------

/// What the record says to serve as Core starts: the applied entry and its
/// tailnet name, or why it cannot be read.
pub(super) fn startup(data: &Path) -> (Option<(Ports, String)>, Option<String>) {
    match read(&data.join(FILE)) {
        Ok(Saved { effective: Some(Applied { listen: Some(ports), .. }), owned: Some(owned), .. }) => (Some((ports, owned.host)), None),
        Ok(_) => (None, None),
        Err(error) => (None, Some(format!("Phone previews were not started: {error:#}. Turn them on again from Settings."))),
    }
}

/// Bind the applied entry's port; one that cannot be bound only leaves
/// previews off, with the reason on the page.
pub(super) async fn bind_startup(listen: Option<(Ports, String)>, error: Option<String>) -> (Option<(tokio::net::TcpListener, Ports, String)>, Option<String>) {
    let Some((ports, name)) = listen else { return (None, error) };
    match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, ports.local_port)).await {
        Ok(listener) => (Some((listener, ports, name)), None),
        Err(error) => (None, Some(format!(
            "Phone previews could not listen on 127.0.0.1:{}: {error}. Turn them on again from Settings, or choose another port.", ports.local_port
        ))),
    }
}

pub(super) fn run(ws: &Arc<Workspace>, bound: Option<(tokio::net::TcpListener, Ports, String)>, error: Option<String>) {
    let state = &ws.remote_access.preview;
    if let Some(error) = error {
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
        eprintln!("Phone previews record: {error:#}");
    }
    if let Some((listener, ports, name)) = bound {
        eprintln!("Phone previews: http://127.0.0.1:{} for Tailscale Serve, as https://{}", ports.local_port, authority(&name, ports.serve_port));
        *state.listener.try_lock().expect("no operation runs before start") = Some(spawn(ws, listener));
        *state.current.lock().unwrap() = Some((ports, name, crate::model::now()));
    }
}

// ---- the listener -------------------------------------------------------

fn spawn(ws: &Arc<Workspace>, listener: tokio::net::TcpListener) -> Running {
    let local_port = listener.local_addr().map(|a| a.port()).unwrap_or_default();
    Running { local_port, task: tokio::spawn(crate::previews::accept_phone(listener, ws.clone())) }
}

/// Stop a listener; once this returns its port is free.
async fn close(running: Running) {
    running.task.abort();
    let _ = running.task.await;
}

/// How to put the listener back if an apply stops after `listen`. It holds
/// no login or origin of its own (the door is read per request), so one on
/// the asked port is kept as it is.
enum Undo {
    Keep,
    /// There was none: close the new one.
    Remove,
    /// The previous one, on another port, still runs: close the new one, keep it.
    Restore(Running),
}

async fn undo(slot: &mut Option<Running>, undo: Undo) {
    match undo {
        Undo::Keep => {}
        Undo::Remove => {
            if let Some(new) = slot.take() {
                close(new).await;
            }
        }
        Undo::Restore(previous) => {
            if let Some(new) = slot.replace(previous) {
                close(new).await;
            }
        }
    }
}

// ---- checks ------------------------------------------------------------

/// The ports a check looks at: what applies, else what was last saved, else the defaults.
pub(super) fn planned(ws: &Workspace) -> Ports {
    let saved = read(&path(ws)).unwrap_or_default();
    match (&saved.effective, &saved.desired) {
        (Some(Applied { listen: Some(ports), .. }), _) => *ports,
        (_, Some(d)) => Ports { serve_port: d.serve_port, local_port: d.local_port },
        _ => Ports { serve_port: DEFAULT_SERVE_PORT, local_port: DEFAULT_LOCAL_PORT },
    }
}

/// What Check shows for phone previews, read only: Core's listener for them,
/// the Windows-to-WSL hop, their Serve entry and a request through it from
/// Windows. `name` is the tailnet name Tailscale reported, if it runs. Before
/// setup Serve is still read for the planned port, so a port someone else
/// uses shows before previews are turned on.
pub(super) async fn check(ws: &Arc<Workspace>, host: &Host, name: Option<&str>, planned: Ports) -> Value {
    let mut steps = Vec::new();
    let mut serve = json!({"state": "unchecked"});
    let skip = |id: &str, why: &str| step(id, "skipped", why);
    if !host.supported {
        for id in ["listener", "hop", "serve", "endToEnd"] {
            steps.push(skip(id, "Needs a supported host"));
        }
        return json!({"steps": steps, "serve": serve, "at": crate::model::now()});
    }
    let listening = ws.remote_access.preview.current.lock().unwrap().as_ref().map(|c| c.0);
    let ports = listening.unwrap_or(planned);
    let local = format!("http://127.0.0.1:{}/", ports.local_port);
    // Without the allowed login the listener refuses, in words of its own.
    let ours = |answer: &Result<(u16, String)>| matches!(answer, Ok((403, body)) if body.contains("Tailscale login") && body.contains("Yuzuno preview"));
    let listener_ok = match listening {
        None => {
            steps.push(step("listener", "failed", "Core is not listening for phone previews"));
            false
        }
        Some(ports) => {
            let answer = local_get(&local).await;
            let ok = ours(&answer);
            steps.push(match answer {
                _ if ok => step("listener", "ok", format!("Core answers on 127.0.0.1:{} and refuses a request without the allowed Tailscale login", ports.local_port)),
                Ok((code, body)) => step("listener", "failed", format!("127.0.0.1:{} answered {code} ({}), not Core's phone previews", ports.local_port, body.trim())),
                Err(error) => step("listener", "failed", format!("Core's phone previews on 127.0.0.1:{} did not answer: {error:#}", ports.local_port)),
            });
            ok
        }
    };
    let mut hop = false;
    if listener_ok {
        let answer = host::windows_get(host, &local).await;
        hop = ours(&answer);
        steps.push(match answer {
            _ if hop => step("hop", "ok", format!("Windows reaches Core's phone previews on 127.0.0.1:{}", ports.local_port)),
            Ok((code, body)) => step("hop", "failed", format!("From Windows, 127.0.0.1:{} answered {code} ({}): another program holds that port on Windows", ports.local_port, body.trim())),
            Err(error) => step("hop", "failed", format!("Windows could not reach Core on 127.0.0.1:{} ({error:#})", ports.local_port)),
        });
    } else {
        steps.push(skip("hop", "Needs Core listening"));
    }
    let target = format!("http://127.0.0.1:{}", ports.local_port);
    let mut served = false;
    match name {
        Some(name) => match host::serve_status(host).await {
            Ok(config) => {
                let (found, detail) = host::serve_entry(&config, name, ports.serve_port, &target);
                let owned = read(&path(ws)).ok().and_then(|s| s.owned);
                let recorded = owned.as_ref().is_some_and(|o| o.serve_port == ports.serve_port && o.host == name && o.target == target);
                serve = json!({
                    "state": match found { "match" if recorded => "ours", "match" => "sameTargetNotRecorded", other => other },
                    "port": ports.serve_port, "target": target, "detail": detail, "observedAt": crate::model::now(),
                });
                served = found == "match" && listening.is_some();
                let (state, detail) = match (listening.is_some(), found) {
                    (true, "match") => ("ok", detail),
                    (false, "absent") => ("skipped", format!("Port {} is free for phone previews; turning them on sets it", ports.serve_port)),
                    (false, "match") => ("skipped", format!("{detail}, where Core is not listening; turning previews on takes it over")),
                    _ => ("failed", detail),
                };
                steps.push(step("serve", state, detail));
            }
            Err(error) => {
                serve = json!({"state": "error", "port": ports.serve_port, "detail": format!("{error:#}"), "observedAt": crate::model::now()});
                steps.push(step("serve", "failed", format!("Could not read Serve's configuration: {error:#}")));
            }
        },
        None => steps.push(skip("serve", "Needs Tailscale running")),
    }
    match (served && hop, name) {
        (true, Some(name)) => {
            let origin = format!("https://{}", authority(name, ports.serve_port));
            steps.push(match host::windows_get(host, &format!("{origin}/")).await {
                Ok((404, body)) if body.contains("Yuzuno preview") => step("endToEnd", "ok", format!("{origin} reached Core's phone previews through Serve as this PC's Tailscale login")),
                Ok((403, body)) if body.contains("Tailscale login") => step("endToEnd", "ok", format!(
                    "{origin} reached Core's phone previews through Serve; this PC's login is not the phone entry's, so they refused it as configured"
                )),
                Ok((code, body)) => step("endToEnd", "failed", format!("{origin} answered {code} ({})", body.trim())),
                Err(error) => step("endToEnd", "failed", format!("{origin} could not be reached from Windows: {error:#}")),
            });
        }
        _ => steps.push(skip("endToEnd", "Needs the Serve entry and the Windows hop")),
    }
    json!({"steps": steps, "serve": serve, "at": crate::model::now()})
}

pub(super) fn observe(ws: &Workspace, result: &Value) {
    let ok = result["steps"].as_array().is_some_and(|steps| steps.iter().all(|s| s["state"] == "ok"));
    *ws.remote_access.preview.observed.lock().unwrap() = json!({
        "serve": result["serve"],
        "verification": {"ok": ok, "at": result["at"], "steps": result["steps"]},
    });
}

/// Check phone previews as Check does: the planned ports, the name Tailscale reports now.
pub(super) async fn check_now(ws: &Arc<Workspace>, host: &Host) {
    let name = if host.supported { host::status(host).await.ok().and_then(|s| s["dnsName"].as_str().map(str::to_owned)) } else { None };
    let result = check(ws, host, name.as_deref(), planned(ws)).await;
    observe(ws, &result);
}

// ---- the view ----------------------------------------------------------

/// The page's view of phone previews, read only.
pub(super) fn view(ws: &Workspace) -> Value {
    let state = &ws.remote_access.preview;
    let saved = read(&path(ws)).unwrap_or_default();
    let current = state.current.lock().unwrap().clone();
    let listening = current.as_ref().map(|(ports, _, since)| json!({"port": ports.local_port, "servePort": ports.serve_port, "since": since}));
    // An address only while the door lets in, at the Serve entry Core recorded as its own.
    let url = door(ws).filter(|_| match (&current, &saved.owned) {
        (Some((ports, name, _)), Some(owned)) => owned.serve_port == ports.serve_port && &owned.host == name
            && owned.target == format!("http://127.0.0.1:{}", ports.local_port),
        _ => false,
    }).map(|door| format!("https://{}", door.host));
    let desired = saved.desired.as_ref().map(|d| {
        let ports = Ports { serve_port: d.serve_port, local_port: d.local_port };
        let applied = match &saved.effective {
            Some(Applied { listen, .. }) => if d.enabled { *listen == Some(ports) } else { listen.is_none() },
            None => false,
        };
        json!({"enabled": d.enabled, "servePort": d.serve_port, "localPort": d.local_port, "savedAt": d.saved_at, "applied": applied})
    });
    let observed = state.observed.lock().unwrap().clone();
    json!({
        "saved": desired,
        "listening": listening,
        "serve": if observed["serve"].is_object() { observed["serve"].clone() } else { json!({"state": "unchecked"}) },
        "verification": observed["verification"],
        "operation": saved.operations.last().map(|op| serde_json::to_value(op).unwrap_or(Value::Null)),
        "url": url,
        "startupError": state.startup_error.get(),
        "defaults": {"servePort": DEFAULT_SERVE_PORT, "localPort": DEFAULT_LOCAL_PORT},
        "available": super::current(ws).is_some(),
    })
}

// ---- turn on and off -----------------------------------------------------

pub(super) async fn start(ws: &Arc<Workspace>, request: PreviewRequest) -> Result<Value> {
    anyhow::ensure!(!request.request_id.trim().is_empty() && request.request_id.len() <= 128, "requestId must contain 1–128 bytes");
    let mut notes = Vec::new();
    let saved = match read(&path(ws)) {
        Ok(saved) => saved,
        Err(error) => {
            let aside = set_aside(ws)?;
            notes.push(format!("The phone previews record could not be read ({error:#}); it is kept as {aside}, and this change starts from none"));
            Saved::default()
        }
    };
    if let Some(op) = saved.operations.into_iter().find(|op| op.request_id == request.request_id) {
        anyhow::ensure!(op.request == request, "idempotency_conflict: requestId already names a different phone previews change");
        return Ok(serde_json::to_value(op)?);
    }
    // One change at a time, phone access's included: previews follow its entry.
    let Ok(busy) = ws.remote_access.busy.clone().try_lock_owned() else {
        bail!("remote_access_busy: another phone access change is running; wait for it to finish");
    };
    let op = new_operation(request, notes);
    update(ws, |saved| {
        saved.operations.push(op.clone());
        Ok(())
    })?;
    changed(ws);
    let ws = ws.clone();
    let mut running = op.clone();
    tokio::spawn(async move {
        let host = ws.remote_access.host(true);
        let outcome = if running.request.enabled { enable(&ws, &host, &mut running).await } else { disable(&ws, &host, &mut running).await };
        finish(&mut running, outcome);
        // A successful turn-on checked itself; anything else is read again now.
        if !(running.kind == "apply" && matches!(running.step.as_str(), "verify" | "done")) {
            check_now(&ws, &host).await;
        }
        running.finished_at = Some(crate::model::now());
        drop(busy);
        record(&ws, &running);
    });
    Ok(serde_json::to_value(op)?)
}

fn new_operation(request: PreviewRequest, notes: Vec<String>) -> Operation<PreviewRequest> {
    Operation {
        id: uuid::Uuid::new_v4().to_string(),
        request_id: request.request_id.clone(),
        kind: if request.enabled { "apply" } else { "disable" }.into(),
        state: "running".into(),
        step: "validate".into(),
        error: None,
        notes,
        started_at: crate::model::now(),
        finished_at: None,
        url: None,
        request,
    }
}

fn finish(op: &mut Operation<PreviewRequest>, outcome: Result<&'static str>) {
    match outcome {
        Ok(state) => op.state = state.into(),
        Err(error) => {
            if op.state == "running" {
                op.state = if error.chain().any(|e| e.downcast_ref::<host::TimedOut>().is_some()) { "uncertain" } else { "failed" }.into();
            }
            op.error = Some(format!("{error:#}"));
        }
    }
}

fn record(ws: &Workspace, op: &Operation<PreviewRequest>) {
    let saved = update(ws, |saved| {
        if let Some(slot) = saved.operations.iter_mut().find(|o| o.id == op.id) {
            *slot = op.clone();
        }
        Ok(())
    });
    if let Err(error) = saved {
        eprintln!("Phone previews record: {error:#}");
    }
    changed(ws);
}

fn at(ws: &Workspace, op: &mut Operation<PreviewRequest>, step: &str) {
    op.step = step.into();
    record(ws, op);
}

/// Why Serve's `ports.serve_port` cannot be pointed at `target` for `name`
/// without taking someone else's entry, if so: Core's own entry there (for
/// another local port) may be replaced; anything else is left as it is.
fn taken(config: &Value, name: &str, ports: Ports, target: &str, owned: Option<&Owned>) -> Option<String> {
    let (found, detail) = host::serve_entry(config, name, ports.serve_port, target);
    let replaceable = owned.is_some_and(|o| o.serve_port == ports.serve_port && host::serve_entry(config, &o.host, o.serve_port, &o.target).0 == "match");
    (found == "conflict" && !replaceable).then_some(detail)
}

async fn enable(ws: &Arc<Workspace>, host: &Host, op: &mut Operation<PreviewRequest>) -> Result<&'static str> {
    let context = ws.remote_access.context.get().context("Phone access has not started")?;
    // validate: nothing changes until Serve's port for previews is known to be free or Core's.
    anyhow::ensure!(host.supported, "{}", host.support["reason"].as_str().unwrap_or("Unsupported host"));
    let status = host::status(host).await.context("Could not read Tailscale's status")?;
    anyhow::ensure!(status["state"] == "running", "Tailscale is not running here ({}); sign in to Tailscale on Windows first", status["backend"].as_str().unwrap_or("unknown"));
    let name = status["dnsName"].as_str().context("Tailscale reports no name for this computer")?.to_owned();
    anyhow::ensure!(status["https"] == true, "HTTPS certificates are off for this tailnet: turn on HTTPS Certificates in the Tailscale admin console (DNS), then turn previews on again");
    let phone = current(ws).context("Phone access is off: turn it on first, then phone previews")?;
    let (phone_name, phone_port) = phone_name(&phone).context("The phone entry has no tailnet name")?;
    anyhow::ensure!(phone_name == name, "The phone entry is for {phone_name}, not this computer's Tailscale name {name}: apply phone access again first");
    let ports = Ports {
        serve_port: op.request.serve_port.unwrap_or(DEFAULT_SERVE_PORT),
        local_port: op.request.local_port.unwrap_or(DEFAULT_LOCAL_PORT),
    };
    anyhow::ensure!(ports.serve_port != 0 && ports.local_port != 0, "Ports must be 1–65535");
    anyhow::ensure!(ports.local_port != context.core_port, "The previews' local port must differ from Core's own port {}", context.core_port);
    anyhow::ensure!(ports.local_port != phone.port, "The previews' local port must differ from the phone entry's {}", phone.port);
    anyhow::ensure!(ports.serve_port != phone_port, "The previews' Serve port must differ from the phone entry's {phone_port}");
    let target = format!("http://127.0.0.1:{}", ports.local_port);
    let config = host::serve_status(host).await.context("Could not read Serve's configuration; nothing was changed")?;
    let owned = read(&path(ws))?.owned;
    if let Some(detail) = taken(&config, &name, ports, &target, owned.as_ref()) {
        bail!("{detail}. Choose another Serve port for previews; nothing was changed");
    }
    // save: what the user asked for; what applies is unchanged.
    at(ws, op, "save");
    update(ws, |saved| {
        saved.desired = Some(Desired { enabled: true, serve_port: ports.serve_port, local_port: ports.local_port, saved_at: crate::model::now() });
        Ok(())
    })?;
    // listen
    at(ws, op, "listen");
    let mut slot = ws.remote_access.preview.listener.lock().await;
    let rollback = if slot.as_ref().is_some_and(|r| r.local_port == ports.local_port) {
        Undo::Keep
    } else {
        let listener = bind(ports.local_port).await?;
        match slot.replace(spawn(ws, listener)) {
            Some(previous) => Undo::Restore(previous),
            None => Undo::Remove,
        }
    };
    let unchanged = if matches!(rollback, Undo::Remove) { "phone previews stay off" } else { "phone previews are unchanged" };
    // serve: read again, in case it changed since the check above.
    at(ws, op, "serve");
    let config = match host::serve_status(host).await {
        Ok(config) => config,
        Err(error) => {
            undo(&mut slot, rollback).await;
            op.state = "rolledBack".into();
            return Err(error.context(format!("Could not read Serve's configuration; {unchanged}")));
        }
    };
    let (found, detail) = host::serve_entry(&config, &name, ports.serve_port, &target);
    let replacing = owned.clone().filter(|o| {
        found != "match" && o.serve_port == ports.serve_port && host::serve_entry(&config, &o.host, o.serve_port, &o.target).0 == "match"
    });
    match (found, &replacing) {
        ("match", _) => {}
        ("absent", _) | (_, Some(_)) => {
            if replacing.is_some() {
                if let Err(error) = host::serve_off(host, ports.serve_port).await {
                    let timed_out = error.downcast_ref::<host::TimedOut>().is_some();
                    undo(&mut slot, rollback).await;
                    op.state = if timed_out { "uncertain" } else { "rolledBack" }.into();
                    return Err(error.context(format!("Core's previous entry for previews on port {} was not replaced; {unchanged}", ports.serve_port)));
                }
            }
            if let Err(error) = host::serve_add(host, ports.serve_port, &target).await {
                let timed_out = error.downcast_ref::<host::TimedOut>().is_some();
                // Whether a lost answer took effect: look once more.
                let now = if timed_out {
                    host::serve_status(host).await.ok().map(|c| host::serve_entry(&c, &name, ports.serve_port, &target).0)
                } else {
                    None
                };
                if now != Some("match") {
                    if let Some(old) = &replacing {
                        if let Err(again) = host::serve_add(host, ports.serve_port, &old.target).await {
                            op.notes.push(format!("Serve port {} could not be pointed back at {}: {again:#}; turn previews on again", ports.serve_port, old.target));
                        }
                    }
                    undo(&mut slot, rollback).await;
                    op.state = if timed_out { "uncertain" } else { "rolledBack" }.into();
                    return Err(if timed_out {
                        error.context(format!("Serve did not confirm the entry for previews; {unchanged}. Turn them on again to check and finish"))
                    } else {
                        error.context(format!("{}{}", unchanged[..1].to_uppercase(), &unchanged[1..]))
                    });
                }
            }
        }
        _ => {
            undo(&mut slot, rollback).await;
            op.state = "rolledBack".into();
            bail!("{detail}. Choose another Serve port for previews; {unchanged}");
        }
    }
    // Core's previous entry for previews on another Serve port: removed only while it is still exactly that.
    if let Some(old) = owned.filter(|o| o.serve_port != ports.serve_port) {
        match host::serve_entry(&config, &old.host, old.serve_port, &old.target).0 {
            "match" => {
                if let Err(error) = host::serve_off(host, old.serve_port).await {
                    op.notes.push(format!("The previous entry for previews on port {} could not be removed: {error:#}", old.serve_port));
                }
            }
            "absent" => {}
            _ => op.notes.push(format!("Port {} was changed outside Yuzuno since it was set; it is left as it is", old.serve_port)),
        }
    }
    update(ws, |saved| {
        saved.effective = Some(Applied { listen: Some(ports), applied_at: crate::model::now() });
        saved.owned = Some(Owned { serve_port: ports.serve_port, host: name.clone(), target: target.clone() });
        Ok(())
    })?;
    *ws.remote_access.preview.current.lock().unwrap() = Some((ports, name.clone(), crate::model::now()));
    drop(slot);
    if let Undo::Restore(previous) = rollback {
        close(previous).await;
    }
    op.url = Some(format!("https://{}", authority(&name, ports.serve_port)));
    // verify
    at(ws, op, "verify");
    let result = check(ws, host, Some(&name), ports).await;
    observe(ws, &result);
    op.step = "done".into();
    if let Some(failed) = result["steps"].as_array().and_then(|s| s.iter().find(|s| s["state"] != "ok")) {
        op.step = "verify".into();
        op.error = Some(format!("Turned on, but not verified: {} ({})", failed["detail"].as_str().unwrap_or(""), failed["id"].as_str().unwrap_or("")));
        return Ok("failed");
    }
    Ok("succeeded")
}

async fn disable(ws: &Arc<Workspace>, host: &Host, op: &mut Operation<PreviewRequest>) -> Result<&'static str> {
    at(ws, op, "save");
    update(ws, |saved| {
        let previous = saved.desired.clone();
        saved.desired = Some(Desired {
            enabled: false,
            serve_port: previous.as_ref().map_or(DEFAULT_SERVE_PORT, |d| d.serve_port),
            local_port: previous.as_ref().map_or(DEFAULT_LOCAL_PORT, |d| d.local_port),
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
    let mut slot = ws.remote_access.preview.listener.lock().await;
    let running = slot.take();
    *ws.remote_access.preview.current.lock().unwrap() = None;
    drop(slot);
    if let Some(running) = running {
        close(running).await;
    }
    update(ws, |saved| {
        saved.effective = Some(Applied { listen: None, applied_at: crate::model::now() });
        saved.owned = keep_owned.clone();
        Ok(())
    })?;
    op.step = "done".into();
    if uncertain {
        op.error = Some("Phone previews are off in Core; whether Serve still lists their port is unknown. Turn them off again to check".into());
        return Ok("uncertain");
    }
    if keep_owned.is_some() {
        op.error = Some(op.notes.join("; "));
        return Ok("failed");
    }
    Ok("succeeded")
}

/// Turning phone access off turns previews off too, as an operation of
/// their own under the phone change's request ID; without anything of
/// theirs on, nothing. The phone change holds the one-change lock. Says how
/// it ended, for the phone change's notes.
pub(super) async fn follow_off(ws: &Arc<Workspace>, host: &Host, request_id: &str) -> Option<String> {
    let saved = read(&path(ws)).ok();
    let listening = ws.remote_access.preview.current.lock().unwrap().is_some() || ws.remote_access.preview.listener.lock().await.is_some();
    let on = saved.as_ref().is_some_and(|s| s.owned.is_some() || s.effective.as_ref().is_some_and(|e| e.listen.is_some()));
    if !listening && !on {
        return None;
    }
    let request = PreviewRequest { request_id: format!("{request_id}:previews"), enabled: false, serve_port: None, local_port: None };
    let mut op = new_operation(request, Vec::new());
    if let Err(error) = update(ws, |saved| {
        saved.operations.push(op.clone());
        Ok(())
    }) {
        return Some(format!("Phone previews were not turned off: {error:#}"));
    }
    let outcome = disable(ws, host, &mut op).await;
    finish(&mut op, outcome);
    check_now(ws, host).await;
    op.finished_at = Some(crate::model::now());
    record(ws, &op);
    Some(match op.state.as_str() {
        "succeeded" => "Phone previews were turned off too".to_owned(),
        _ => format!("Phone previews were turned off in Core; {}", op.error.as_deref().unwrap_or("their Serve entry may remain")),
    })
}

// ---- HTTP ---------------------------------------------------------------

pub(super) async fn post_change(AppState(ws): AppState<Arc<Workspace>>, Json(request): Json<PreviewRequest>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({"operation": start(&ws, request).await?})))
}

pub(super) async fn get_change(AppState(ws): AppState<Arc<Workspace>>, UrlPath(id): UrlPath<String>) -> Result<Json<Value>, ApiError> {
    let op = read(&path(&ws))?.operations.into_iter().find(|op| op.id == id).context("Unknown phone previews operation")?;
    Ok(Json(serde_json::to_value(op)?))
}
