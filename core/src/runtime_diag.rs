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
    let key = (entry, method(request.method()), label);
    let visibility = visibility(&request);
    let response = next.run(request).await;
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

/// This process's CPU time so far, in nanoseconds (CLOCK_PROCESS_CPUTIME_ID);
/// None where the platform has no such clock.
pub fn process_cpu_ns() -> Option<u64> {
    #[cfg(unix)]
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
    #[cfg(target_os = "linux")]
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
        "note": "Counts since startedAt; read twice and subtract. Routes are templates: no path, query, header or body is kept. \
bytesDeclared is what responses declared, bytesSent what their bodies sent; wallMs is time to the response head. \
CPU is the process's and each thread name's, not attributed to work.",
    })
}

#[cfg(test)]
#[path = "runtime_diag_tests.rs"]
mod tests;
