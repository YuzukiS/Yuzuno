//! Free space where Jobs write (T-95): Core's data folder, which holds every
//! Job's records and logs, and the Job's working directory. Each path is read
//! on its own filesystem; one partition never stands in for another. Below the
//! reserve no new Job starts.
//!
//! This is a check before each launch, not a quota: Jobs already running, and
//! every other program on the host, can still fill a disk afterwards.

use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{json, Value};
use std::{
    os::unix::fs::MetadataExt,
    path::Path,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

pub(crate) const GIB: u64 = 1 << 30;
/// An explicit reserve, in GiB, must lie within these bounds.
pub(crate) const MIN_RESERVE_GIB: u64 = 1;
pub(crate) const MAX_RESERVE_GIB: u64 = 1024;
/// Without one: 10 GiB, or a tenth of a filesystem smaller than 100 GiB.
/// Enough for Core's database and job records plus a build's first output,
/// without blocking small disks; large builds should set a higher reserve.
pub(crate) const DEFAULT_RESERVE_GIB: u64 = 10;
pub(crate) const DEFAULT_RULE: &str = "10 GiB, or a tenth of a filesystem smaller than 100 GiB";
/// A hung mount must not hold the queue: an unanswered read is unknown.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Reads that have not answered, out at once at most (see `Reads`).
const MAX_UNANSWERED: usize = 32;
pub(crate) const SCOPE: &str = "Checked before each new job starts, not a quota: running jobs and other programs can still fill a disk. Nothing is deleted and running jobs are never stopped for space.";

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Sample {
    pub path: String,
    pub role: &'static str,
    /// The filesystem's device (st_dev): paths on the same one share it.
    pub device: Option<u64>,
    pub total: Option<u64>,
    pub available: Option<u64>,
    pub error: Option<String>,
    /// The path itself cannot be used (missing, not a directory, not
    /// permitted), as opposed to a read that may work later.
    pub permanent: bool,
}

/// What the next Job does about free space.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Verdict {
    Start,
    /// Waits in the queue; the reason says why.
    Wait(String),
    /// Its own working directory cannot be used: not started, and the queue
    /// goes on instead of holding every later Job behind it.
    Reject(String),
}

pub(crate) const DATA: &str = "Core data and job records";
pub(crate) const WORKDIR: &str = "working directory";

/// The reserve on a filesystem of `total` bytes.
pub(crate) fn reserve_bytes(total: u64, configured: Option<u64>) -> u64 {
    match configured {
        Some(gib) => gib.saturating_mul(GIB),
        None => (DEFAULT_RESERVE_GIB * GIB).min(total / 10),
    }
}

/// Test hook: every read of a held path blocks, like a mount that stopped
/// answering, until the hold is dropped. Nothing real is unmounted or hung.
#[cfg(test)]
static HUNG: Mutex<Vec<(String, std::sync::Arc<Hang>)>> = Mutex::new(Vec::new());

#[cfg(test)]
#[derive(Default)]
pub(crate) struct Hang {
    entered: std::sync::atomic::AtomicUsize,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
}

#[cfg(test)]
pub(crate) struct Held(String, std::sync::Arc<Hang>);

#[cfg(test)]
impl Held {
    pub(crate) fn on(path: &str) -> Held {
        let hang = std::sync::Arc::new(Hang::default());
        HUNG.lock().unwrap().push((path.to_owned(), hang.clone()));
        Held(path.to_owned(), hang)
    }
    /// Reads of this path started so far, answered or not.
    pub(crate) fn entered(&self) -> usize {
        self.1.entered.load(std::sync::atomic::Ordering::SeqCst)
    }
    /// The filesystem answers: held reads return and later ones run.
    pub(crate) fn release(&self) {
        HUNG.lock().unwrap_or_else(PoisonError::into_inner).retain(|(path, _)| path != &self.0);
        *self.1.released.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.1.wake.notify_all();
    }
}

/// Released even when a test fails, so no blocking thread outlives it.
#[cfg(test)]
impl Drop for Held {
    fn drop(&mut self) {
        self.release();
    }
}

/// statvfs for unprivileged use: the space a Job can actually write.
fn read(path: &Path) -> std::io::Result<(u64, u64, u64)> {
    #[cfg(test)]
    {
        let hang = HUNG.lock().unwrap().iter().find(|(held, _)| Path::new(held) == path).map(|(_, hang)| hang.clone());
        if let Some(hang) = hang {
            hang.entered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut released = hang.released.lock().unwrap();
            while !*released {
                released = hang.wake.wait(released).unwrap();
            }
        }
    }
    let device = std::fs::metadata(path)?.dev();
    let stat = rustix::fs::statvfs(path)?;
    let unit = stat.f_frsize;
    Ok((device, stat.f_blocks.saturating_mul(unit), stat.f_bavail.saturating_mul(unit)))
}

/// A finished read: device, total and available bytes, or the error and
/// whether the path itself cannot be used.
type Reading = Result<(u64, u64, u64), (String, bool)>;

/// Free-space reads still waiting on their filesystem. A read that timed out
/// keeps its blocking thread until the kernel answers, which on a hung mount
/// may be never (review 39a920d7). So callers reading a path at the same time
/// share one read; once it has gone unanswered past the timeout, the path is
/// unknown at once, without another thread, until that read returns; and at
/// most `limit` reads are out together. A mount that stops answering costs a
/// fixed number of threads, not one more on every pass of the queue.
pub(crate) struct Reads {
    out: Mutex<Vec<(String, Out)>>,
    limit: usize,
    timeout: Duration,
}

struct Out {
    started: Instant,
    answer: Shared<BoxFuture<'static, Reading>>,
}

/// Held by the blocking read itself: the path is out until the read returns.
struct Returned(&'static Reads, String);

impl Drop for Returned {
    fn drop(&mut self) {
        self.0.out.lock().unwrap_or_else(PoisonError::into_inner).retain(|(path, _)| path != &self.1);
    }
}

static READS: Reads = Reads { out: Mutex::new(Vec::new()), limit: MAX_UNANSWERED, timeout: READ_TIMEOUT };

pub(crate) async fn sample(path: String, role: &'static str) -> Sample {
    READS.sample(path, role).await
}

impl Reads {
    #[cfg(test)]
    pub(crate) fn new(limit: usize, timeout: Duration) -> &'static Reads {
        Box::leak(Box::new(Reads { out: Mutex::new(Vec::new()), limit, timeout }))
    }

    /// The read of `path` to wait for, and how long; or why there is none.
    fn join(&'static self, path: &str) -> Result<(Shared<BoxFuture<'static, Reading>>, Duration), String> {
        let (answer, sender) = {
            let mut out = self.out.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some((_, read)) = out.iter().find(|(held, _)| held == path) {
                let left = self.timeout.saturating_sub(read.started.elapsed());
                if left.is_zero() {
                    return Err("its last read has not answered yet".into());
                }
                return Ok((read.answer.clone(), left));
            }
            if out.len() >= self.limit {
                return Err(format!("{} earlier reads have not answered yet", out.len()));
            }
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let answer = async move {
                receiver.await.unwrap_or_else(|_| Err(("the read stopped without an answer".into(), false)))
            }
            .boxed()
            .shared();
            out.push((path.to_owned(), Out { started: Instant::now(), answer: answer.clone() }));
            (answer, sender)
        };
        // Started outside the lock, which the read takes again when it returns.
        let returned = Returned(self, path.to_owned());
        tokio::task::spawn_blocking(move || {
            use std::io::ErrorKind::{NotADirectory, NotFound, PermissionDenied};
            let returned = returned;
            let reading = read(Path::new(&returned.1)).map_err(|error| {
                (error.to_string(), matches!(error.kind(), NotFound | NotADirectory | PermissionDenied))
            });
            let _ = sender.send(reading);
        });
        Ok((answer, self.timeout))
    }

    pub(crate) async fn sample(&'static self, path: String, role: &'static str) -> Sample {
        let mut sample = Sample { path, role, device: None, total: None, available: None, error: None, permanent: false };
        let reading = match self.join(&sample.path) {
            Ok((answer, left)) => tokio::time::timeout(left, answer).await.unwrap_or_else(|_| {
                Err((format!("no answer within {} seconds", self.timeout.as_secs_f32()), false))
            }),
            Err(error) => Err((error, false)),
        };
        match reading {
            Ok((device, total, available)) => {
                sample.device = Some(device);
                sample.total = Some(total);
                sample.available = Some(available);
            }
            Err((error, permanent)) => {
                sample.error = Some(error);
                sample.permanent = permanent;
            }
        }
        sample
    }
}

fn gib(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / GIB as f64)
}

/// What the next Job does: start; wait (a filesystem below its reserve, or
/// a free-space read that may work later, such as Core's own data folder or
/// a read that timed out); or not start at all, when its own working
/// directory cannot be used, so one bad path never holds the whole queue.
pub(crate) fn verdict(samples: &[Sample], configured: Option<u64>, observed_at: &str) -> Verdict {
    if let Some(s) = samples.iter().find(|s| s.role == WORKDIR && s.permanent) {
        return Verdict::Reject(format!(
            "Not started: its working directory {} cannot be used ({}). No process was created; submit again with a working directory that exists.",
            s.path, s.error.as_deref().unwrap_or("unknown error")
        ));
    }
    if let Some(s) = samples.iter().find(|s| s.error.is_some()) {
        return Verdict::Wait(format!(
            "Waiting: the free space of its {} {} could not be read ({}); it starts once the space can be checked. Cancel it to drop it.",
            s.role, s.path, s.error.as_deref().unwrap_or_default()
        ));
    }
    samples.iter().find_map(|s| {
        let (total, available) = (s.total?, s.available?);
        let reserve = reserve_bytes(total, configured);
        (available < reserve).then(|| Verdict::Wait(format!(
            "Waiting for disk space: the filesystem of its {} {} has {} free; new jobs start at {} or more (read {observed_at}). Running jobs are not stopped and nothing is deleted.",
            s.role, s.path, gib(available), gib(reserve)
        )))
    }).unwrap_or(Verdict::Start)
}

/// The Jobs panel's view: each filesystem once, with every path read on it.
pub(crate) fn view(samples: &[Sample], configured: Option<u64>, observed_at: &str) -> Value {
    let mut volumes: Vec<Value> = Vec::new();
    for s in samples {
        let path = json!({"path":s.path,"role":s.role});
        if let Some(error) = &s.error {
            volumes.push(json!({"device":null,"paths":[path],"totalBytes":null,"availableBytes":null,"reserveBytes":null,"low":null,"error":error}));
            continue;
        }
        if let Some(existing) = volumes.iter_mut().find(|v| v["device"] == json!(s.device)) {
            existing["paths"].as_array_mut().unwrap().push(path);
            continue;
        }
        let (total, available) = (s.total.unwrap_or(0), s.available.unwrap_or(0));
        let reserve = reserve_bytes(total, configured);
        volumes.push(json!({"device":s.device,"paths":[path],"totalBytes":total,"availableBytes":available,
            "reserveBytes":reserve,"low":available < reserve,"error":null}));
    }
    json!({"reserveGiB":configured,"defaultRule":DEFAULT_RULE,"bounds":{"minGiB":MIN_RESERVE_GIB,"maxGiB":MAX_RESERVE_GIB},
        "observedAt":observed_at,"volumes":volumes,"scope":SCOPE})
}
