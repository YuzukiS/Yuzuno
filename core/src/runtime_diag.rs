//! Runtime diagnostics (YN-221 S7a): what this Core process served and sent
//! since it started, read only when asked (`GET /api/diagnostics/runtime`).
//!
//! Every count is under a bounded label: the entry a request came in on
//! (`local`, `phone`), its method, and its route's template as the router
//! matched it (`/api/agents/{id}`), never its path, query, headers or body;
//! an event's type (and a workspace change's scope). Counters only grow while
//! the process runs: read twice and subtract. A different `startedAt` means
//! Core started again in between, and the two reads do not subtract.
//!
//! Bytes are counted twice, apart: what a response declared (an exact length
//! its body knew, `bytesDeclared`, or none, `declaredUnknown`) and what its
//! body actually handed to the connection (`bytesSent`), with whether the body
//! ended (`bodiesCompleted`) or was dropped first (`bodiesDropped`, a client
//! that went away; an event stream ends this way). Time is to the response's
//! head (`wallMs`, `wallNsTotal`): how long the handler took, not the body's
//! transfer. CPU here is the process's and each thread group's, from the
//! kernel; which work it went to is not attributed here.
use axum::{
    body::{Body, Bytes, HttpBody},
    extract::{MatchedPath, Request, State},
    http::{Method, StatusCode},
    middleware::Next,
    response::Response,
};
use http_body::{Frame, SizeHint};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};

/// The entries a request comes in on (server.rs `finish`).
pub const LOCAL: &str = "local";
pub const PHONE: &str = "phone";
/// The label of a request no route matched: pages, /assets and anything
/// else the asset service answers.
pub const FALLBACK: &str = "(fallback)";
/// At most this many labels are kept; any beyond them count under
/// `(other)`. The router has a few hundred routes.
pub const ROUTES_KEPT: usize = 1024;
const OTHER: &str = "(other)";
/// The upper bounds of `wallMs`'s buckets, in milliseconds; the last
/// bucket is everything above.
pub const WALL_MS: [u64; 4] = [10, 50, 200, 1000];
/// The visibility a page says it had when it asked (`X-Yuzuno-Visibility`).
pub const VISIBILITY_HEADER: &str = "x-yuzuno-visibility";

#[derive(Default)]
struct Sent {
    bytes: AtomicU64,
    completed: AtomicU64,
    dropped: AtomicU64,
}

#[derive(Default)]
struct Route {
    count: u64,
    /// 1xx … 5xx.
    status: [u64; 5],
    /// visible, hidden, unknown.
    visibility: [u64; 3],
    wall: [u64; 5],
    wall_ns: u64,
    declared: u64,
    declared_unknown: u64,
    sent: Arc<Sent>,
}

type Key = (&'static str, &'static str, String);

/// The HTTP counters of one Workspace's process, shared by its entries.
pub struct Http {
    started_at: String,
    routes: Mutex<HashMap<Key, Route>>,
}

impl Default for Http {
    fn default() -> Self {
        Self { started_at: crate::model::now(), routes: Mutex::default() }
    }
}

fn method(method: &Method) -> &'static str {
    match *method {
        Method::GET => "GET",
        Method::HEAD => "HEAD",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::PATCH => "PATCH",
        Method::DELETE => "DELETE",
        Method::OPTIONS => "OPTIONS",
        _ => "OTHER",
    }
}

fn visibility(request: &Request) -> usize {
    match request.headers().get(VISIBILITY_HEADER).and_then(|v| v.to_str().ok()) {
        Some("visible") => 0,
        Some("hidden") => 1,
        _ => 2,
    }
}

impl Http {
    /// When these counters began: this process's start, for every reader.
    pub fn started_at(&self) -> &str {
        &self.started_at
    }

    fn record(&self, key: Key, status: StatusCode, visibility: usize, wall: Duration, declared: Option<u64>) -> Arc<Sent> {
        let mut routes = self.routes.lock().unwrap();
        let key = if routes.len() >= ROUTES_KEPT && !routes.contains_key(&key) { (key.0, key.1, OTHER.to_owned()) } else { key };
        let route = routes.entry(key).or_default();
        route.count += 1;
        route.status[(status.as_u16() / 100).clamp(1, 5) as usize - 1] += 1;
        route.visibility[visibility] += 1;
        let millis = wall.as_millis() as u64;
        route.wall[WALL_MS.iter().position(|bound| millis <= *bound).unwrap_or(WALL_MS.len())] += 1;
        route.wall_ns = route.wall_ns.saturating_add(wall.as_nanos() as u64);
        match declared {
            Some(bytes) => route.declared += bytes,
            None => route.declared_unknown += 1,
        }
        route.sent.clone()
    }

    /// Every label's counts, in label order.
    pub fn report(&self) -> Vec<Value> {
        let routes = self.routes.lock().unwrap();
        let mut keys: Vec<&Key> = routes.keys().collect();
        keys.sort();
        keys.into_iter().map(|key| {
            let r = &routes[key];
            json!({"entry":key.0,"method":key.1,"route":key.2,"count":r.count,
                "status":{"1xx":r.status[0],"2xx":r.status[1],"3xx":r.status[2],"4xx":r.status[3],"5xx":r.status[4]},
                "visibility":{"visible":r.visibility[0],"hidden":r.visibility[1],"unknown":r.visibility[2]},
                "wallMs":{"le10":r.wall[0],"le50":r.wall[1],"le200":r.wall[2],"le1000":r.wall[3],"gt1000":r.wall[4]},
                "wallNsTotal":r.wall_ns,"bytesDeclared":r.declared,"declaredUnknown":r.declared_unknown,
                "bytesSent":r.sent.bytes.load(Ordering::Relaxed),"bodiesCompleted":r.sent.completed.load(Ordering::Relaxed),
                "bodiesDropped":r.sent.dropped.load(Ordering::Relaxed)})
        }).collect()
    }
}

/// The middleware that counts each request under its entry, method and
/// route template (server.rs `finish`, inside `run_to_completion`).
pub async fn count(State((http, entry)): State<(Arc<Http>, &'static str)>, request: Request, next: Next) -> Response {
    let started = Instant::now();
    let label = request.extensions().get::<MatchedPath>().map_or_else(|| FALLBACK.to_owned(), |path| path.as_str().to_owned());
    // Its handler's CPU under `http <METHOD> <route>` (S7b).
    let cpu_label = intern(&format!("http {} {}", method(request.method()), label));
    let key = (entry, method(request.method()), label);
    let visibility = visibility(&request);
    let response = scope(cpu_label, next.run(request)).await;
    let declared = response.body().size_hint().exact();
    let sent = http.record(key, response.status(), visibility, started.elapsed(), declared);
    response.map(|inner| Body::new(Counted { inner, sent, done: false }))
}

/// A response body that counts what it hands on, and whether it ended.
struct Counted {
    inner: Body,
    sent: Arc<Sent>,
    done: bool,
}

impl Counted {
    fn end(&mut self, completed: bool) {
        if !self.done {
            self.done = true;
            let counter = if completed { &self.sent.completed } else { &self.sent.dropped };
            counter.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl HttpBody for Counted {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        match &polled {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.sent.bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
                }
            }
            Poll::Ready(None) => self.end(true),
            Poll::Ready(Some(Err(_))) => self.end(false),
            Poll::Pending => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        // A body with nothing to send is never polled.
        let empty = self.inner.is_end_stream();
        self.end(empty);
    }
}

// ---- CPU by label (YN-221 S7b) ------------------------------------------------
//
// A label names the work a future does: `http <METHOD> <route>`, `svc <name>`
// for a background service's own task, `sse` for the event stream's polls.
// Each poll of a labelled future is timed with this thread's CPU clock
// (CLOCK_THREAD_CPUTIME_ID), only within that poll: time a task spends
// waiting between polls is never counted, and a poll runs on one thread from
// its start to its end, so no move between threads can blur it. A labelled
// future polled inside another (a handler's own `scope`) counts its own time
// and the outer one only the rest (`INNER`), so nothing is counted twice.
// Store work (`db::blocking`) is timed the same way on its blocking thread,
// under the label of the future that asked for it (`storeNs`, `storeJobs`).
// What runs outside any label (tasks a labelled one spawns, the harnesses'
// readers, hyper's own IO) is the process's CPU less all of these
// (`unattributedNs`).

tokio::task_local! {
    static LABEL: &'static str;
}

std::thread_local! {
    /// The CPU of labelled polls nested in the one this thread runs now.
    static INNER: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Whether CPU is timed by label: on unless `YUZUNO_DIAG_CPU=0`, read once,
/// so the same build can be measured with and without these clocks.
pub fn cpu_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("YUZUNO_DIAG_CPU").map_or(true, |v| v != "0") && thread_cpu_ns().is_some())
}

/// This thread's CPU time so far (CLOCK_THREAD_CPUTIME_ID); None without one.
pub fn thread_cpu_ns() -> Option<u64> {
    #[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
    {
        let mut at = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: clock_gettime writes one timespec to the pointer it is given.
        if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut at) } == 0 {
            return Some(at.tv_sec as u64 * 1_000_000_000 + at.tv_nsec as u64);
        }
    }
    None
}

#[derive(Default)]
struct LabelCpu {
    async_ns: u64,
    polls: u64,
    store_ns: u64,
    store_jobs: u64,
}

/// The labels' CPU, process-wide: a label is a fixed string, at most
/// LABELS_KEPT of them, the rest under `(other)`.
fn label_cpu() -> &'static Mutex<HashMap<&'static str, LabelCpu>> {
    static LABELS: std::sync::OnceLock<Mutex<HashMap<&'static str, LabelCpu>>> = std::sync::OnceLock::new();
    LABELS.get_or_init(Mutex::default)
}
pub const LABELS_KEPT: usize = 512;
/// The label of store work asked for outside any labelled future.
pub const UNLABELED: &str = "unlabeled";

fn add(label: &'static str, change: impl FnOnce(&mut LabelCpu)) {
    let mut labels = label_cpu().lock().unwrap();
    let label = if labels.len() >= LABELS_KEPT && !labels.contains_key(label) { OTHER } else { label };
    change(labels.entry(label).or_default());
}

/// A fixed label for a string made at run time (an HTTP route's template):
/// each distinct one is kept once, for the process's life.
pub fn intern(label: &str) -> &'static str {
    static KNOWN: std::sync::OnceLock<Mutex<std::collections::HashSet<&'static str>>> = std::sync::OnceLock::new();
    let mut known = KNOWN.get_or_init(Mutex::default).lock().unwrap();
    if let Some(found) = known.get(label) {
        return found;
    }
    if known.len() >= LABELS_KEPT {
        return OTHER;
    }
    let kept: &'static str = Box::leak(label.to_owned().into_boxed_str());
    known.insert(kept);
    kept
}

pin_project_lite::pin_project! {
    /// A future whose polls are timed under `label` (`scope`).
    pub struct Measured<F> {
        #[pin]
        inner: F,
        label: &'static str,
    }
}

impl<F: std::future::Future> std::future::Future for Measured<F> {
    type Output = F::Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        let this = self.project();
        if !cpu_enabled() {
            return this.inner.poll(cx);
        }
        let outer = INNER.with(|inner| inner.replace(0));
        let started = thread_cpu_ns().unwrap_or(0);
        let polled = this.inner.poll(cx);
        let total = thread_cpu_ns().unwrap_or(0).saturating_sub(started);
        let nested = INNER.with(|inner| inner.replace(outer + total));
        let label = *this.label;
        add(label, |cpu| {
            cpu.async_ns += total.saturating_sub(nested);
            cpu.polls += 1;
        });
        polled
    }
}

/// `fut` under `label`: its polls timed (`Measured`), and the store work it
/// asks for counted under the same label.
pub fn scope<F: std::future::Future>(label: &'static str, fut: F) -> impl std::future::Future<Output = F::Output> {
    LABEL.scope(label, Measured { inner: fut, label })
}

/// `tokio::spawn` of `fut` under `label`: a background service's own task.
/// What it spawns in turn is not labelled.
pub fn spawn<F>(label: &'static str, fut: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(scope(label, fut))
}

/// The label of the future running now, for store work it asks for.
pub fn current_label() -> &'static str {
    LABEL.try_with(|label| *label).unwrap_or(UNLABELED)
}

/// Times one store job on its blocking thread under `label`.
pub fn store_job<T>(label: &'static str, job: impl FnOnce() -> T) -> T {
    if !cpu_enabled() {
        return job();
    }
    let started = thread_cpu_ns().unwrap_or(0);
    let done = job();
    let spent = thread_cpu_ns().unwrap_or(0).saturating_sub(started);
    add(label, |cpu| {
        cpu.store_ns += spent;
        cpu.store_jobs += 1;
    });
    done
}

pin_project_lite::pin_project! {
    /// A stream whose polls are timed under `label` (the event stream: hyper
    /// polls it outside the handler's future).
    pub struct MeasuredStream<S> {
        #[pin]
        inner: S,
        label: &'static str,
    }
}

impl<S: futures_util::Stream> futures_util::Stream for MeasuredStream<S> {
    type Item = S::Item;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<S::Item>> {
        let this = self.project();
        if !cpu_enabled() {
            return this.inner.poll_next(cx);
        }
        let outer = INNER.with(|inner| inner.replace(0));
        let started = thread_cpu_ns().unwrap_or(0);
        let polled = this.inner.poll_next(cx);
        let total = thread_cpu_ns().unwrap_or(0).saturating_sub(started);
        let nested = INNER.with(|inner| inner.replace(outer + total));
        let label = *this.label;
        add(label, |cpu| {
            cpu.async_ns += total.saturating_sub(nested);
            cpu.polls += 1;
        });
        polled
    }
}

pub fn measured_stream<S>(label: &'static str, inner: S) -> MeasuredStream<S> {
    MeasuredStream { inner, label }
}

/// Every label's CPU, in label order, and their sum.
fn labels_report() -> (Vec<Value>, u64) {
    let labels = label_cpu().lock().unwrap();
    let mut names: Vec<&&'static str> = labels.keys().collect();
    names.sort();
    let mut sum = 0u64;
    let rows = names.into_iter().map(|name| {
        let cpu = &labels[*name];
        sum = sum.saturating_add(cpu.async_ns).saturating_add(cpu.store_ns);
        json!({"label":name,"asyncNs":cpu.async_ns,"polls":cpu.polls,"storeNs":cpu.store_ns,"storeJobs":cpu.store_jobs})
    }).collect();
    (rows, sum)
}

/// Whether this process's Tokio threads were named by role (`name_threads`):
/// async workers `yz-async`, the blocking pool `yz-blocking`. Set once a
/// worker was renamed; until then, or where renaming is unsupported, roles are
/// unknown and every Tokio thread shares one name.
static ROLES_NAMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub const ASYNC_THREAD: &str = "yz-async";
pub const BLOCKING_THREAD: &str = "yz-blocking";

/// A runtime builder whose threads say their role: every thread starts as
/// `yz-blocking` (Tokio names all its threads alike), and a worker renames
/// itself `yz-async` the first time it parks, which only workers do.
pub fn name_threads(builder: &mut tokio::runtime::Builder) -> &mut tokio::runtime::Builder {
    builder.thread_name(BLOCKING_THREAD).on_thread_park(|| {
        std::thread_local! { static RENAMED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
        if !RENAMED.with(|renamed| renamed.replace(true)) && rename_current(ASYNC_THREAD) {
            ROLES_NAMED.store(true, Ordering::Relaxed);
        }
    })
}

/// Renames this thread as the kernel shows it; false where unsupported.
fn rename_current(name: &str) -> bool {
    let Ok(name) = std::ffi::CString::new(name) else { return false };
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: PR_SET_NAME reads a NUL-terminated string of at most 16 bytes.
        return unsafe { libc::prctl(libc::PR_SET_NAME, name.as_ptr() as libc::c_ulong, 0, 0, 0) } == 0;
    }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: names the calling thread with a NUL-terminated string.
        return unsafe { libc::pthread_setname_np(name.as_ptr()) } == 0;
    }
    #[allow(unreachable_code)]
    {
        let _ = name;
        false
    }
}

/// This process's CPU time so far, in nanoseconds (CLOCK_PROCESS_CPUTIME_ID);
/// None where the platform has no such clock.
pub fn process_cpu_ns() -> Option<u64> {
    #[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
    {
        let mut at = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: clock_gettime writes one timespec to the pointer it is given.
        if unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut at) } == 0 {
            return Some(at.tv_sec as u64 * 1_000_000_000 + at.tv_nsec as u64);
        }
    }
    None
}

/// This process's threads by name, with how many and their CPU time
/// (user + system) in nanoseconds, from /proc/self/task (Linux only;
/// None elsewhere). A thread that ended is no longer counted: its CPU
/// stays in the process's total only.
pub fn threads() -> Option<Vec<Value>> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: sysconf reads a constant.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if ticks <= 0 {
            return None;
        }
        let per_tick = 1_000_000_000 / ticks as u64;
        let mut groups: std::collections::BTreeMap<String, (u64, u64)> = Default::default();
        for task in std::fs::read_dir("/proc/self/task").ok()?.flatten() {
            let dir = task.path();
            let (Ok(name), Ok(stat)) = (std::fs::read_to_string(dir.join("comm")), std::fs::read_to_string(dir.join("stat"))) else { continue };
            // Fields after the name, which is in parentheses and may hold spaces.
            let Some((_, rest)) = stat.rsplit_once(") ") else { continue };
            let fields: Vec<&str> = rest.split(' ').collect();
            let ticks: u64 = [11, 12].iter().filter_map(|i| fields.get(*i)?.parse::<u64>().ok()).sum();
            let group = groups.entry(name.trim().to_owned()).or_default();
            group.0 += 1;
            group.1 += ticks * per_tick;
        }
        return Some(groups.into_iter().map(|(name, (count, cpu))| json!({"name":name,"count":count,"cpuNs":cpu})).collect());
    }
    #[allow(unreachable_code)]
    None
}

/// The `/api/diagnostics/runtime` answer (format 1).
pub fn report(ws: &crate::workspace::Workspace) -> Value {
    let (labels, labelled) = labels_report();
    let cpu = process_cpu_ns();
    let threads = threads();
    json!({
        "format": 1,
        "readAt": crate::model::now(),
        "startedAt": ws.http_counts.started_at(),
        "process": {"available": cpu.is_some(), "cpuNs": cpu},
        "threads": {"available": threads.is_some(), "groups": threads.unwrap_or_default()},
        "http": ws.http_counts.report(),
        "events": ws.changes.counts(),
        "cpu": {
            "enabled": cpu_enabled(),
            "labels": labels,
            "labelledNs": labelled,
            "unattributedNs": match (cpu, cpu_enabled()) { (Some(total), true) => Some(total.saturating_sub(labelled)), _ => None },
            "threadRoles": if ROLES_NAMED.load(Ordering::Relaxed) { "named" } else { "unknown" },
        },
        "note": "Counts since startedAt; read twice and subtract. Routes are templates: no path, query, header or body is kept. \
bytesDeclared is what responses declared, bytesSent what their bodies sent; wallMs is time to the response head. \
CPU is the process's and each thread name's; cpu.labels times each labelled poll and store job on its own thread, \
the rest of the process's CPU is cpu.unattributedNs.",
    })
}

#[cfg(test)]
#[path = "runtime_diag_tests.rs"]
mod tests;
