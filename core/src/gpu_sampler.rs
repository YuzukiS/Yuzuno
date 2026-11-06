//! The one place Core reads its host's NVIDIA GPUs (T-58). Under WSL each
//! new nvidia-smi process, and each NVML session opened and closed, leaks
//! about 26 allocations in the Windows NVIDIA driver, freed only by a
//! reboot; a session kept open leaks none. So one sampler per Core process
//! keeps one session open while anything reads it: NVML in this process, or,
//! where NVML can't be loaded, initialised or read, one `nvidia-smi … -l 5`
//! child read as it prints. It samples every 5 s and keeps the latest
//! sample, which every reader shares: Machine Load (`machine_load`) and
//! Jobs' GPU admission and views (`jobs::sample_gpus`). Nothing else in Core
//! starts nvidia-smi or opens NVML; a test over the source tree holds that.
//!
//! The sampler starts on the first read, stops once nothing has read it for
//! 10 minutes, and starts again on the next read. A session that fails, or
//! whose child exits, after it gave a sample is started again after a
//! backoff (1 s, doubling to 60 s); one that gave none, as on a host with
//! neither NVML nor nvidia-smi, is not tried again for 60 s, and nothing is
//! started meanwhile. Each start and stop is logged.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

/// What one session's sampler is and does; `Config::from_env` for Core.
#[derive(Clone, Debug)]
pub struct Config {
    /// NVML libraries tried in order; none: NVML is not used.
    pub nvml: Vec<PathBuf>,
    /// nvidia-smi programs tried in order; none: no fallback.
    pub smi: Vec<PathBuf>,
    /// How often a session samples.
    pub interval: Duration,
    /// How long with no read before the session stops.
    pub idle: Duration,
    /// How long a sampler with no NVML and no nvidia-smi is not tried again.
    pub retry: Duration,
    /// The first backoff after a session that gave samples ends; doubled
    /// each time, up to `retry`.
    pub backoff: Duration,
}

impl Config {
    /// Core's: NVML from WSL's driver folder, then the library search path;
    /// nvidia-smi from PATH, then WSL's driver folder. `YUZUNO_NVML_LIB`
    /// (`none`, or one library) and `YUZUNO_NVIDIA_SMI` (one program) replace
    /// them, for stubs and labs.
    pub fn from_env() -> Self {
        let nvml = match std::env::var_os("YUZUNO_NVML_LIB") {
            Some(value) if value == "none" => vec![],
            Some(value) => vec![PathBuf::from(value)],
            None => vec!["/usr/lib/wsl/lib/libnvidia-ml.so.1".into(), "libnvidia-ml.so.1".into()],
        };
        let smi = match std::env::var_os("YUZUNO_NVIDIA_SMI") {
            Some(value) => vec![PathBuf::from(value)],
            None => vec!["nvidia-smi".into(), "/usr/lib/wsl/lib/nvidia-smi".into()],
        };
        Self { nvml, smi, ..Self::none() }
    }

    /// No NVML and no nvidia-smi: what the library's own tests start from,
    /// so that none of them reaches this host's GPU.
    pub fn none() -> Self {
        Self { nvml: vec![], smi: vec![], interval: Duration::from_secs(5), idle: Duration::from_secs(600),
            retry: Duration::from_secs(60), backoff: Duration::from_secs(1) }
    }
}

impl Default for Config {
    fn default() -> Self {
        if cfg!(test) { Self::none() } else { Self::from_env() }
    }
}

/// One device as a sample reads it. A value the driver does not report is
/// None: unknown is not zero.
#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub index: u32,
    pub uuid: String,
    pub name: String,
    pub memory_total_mib: Option<u64>,
    pub memory_free_mib: Option<u64>,
    pub memory_used_mib: Option<u64>,
    pub utilization_percent: Option<u32>,
}

/// The latest reading: its source (`nvml` or `nvidia-smi`), when it was
/// taken, and its devices; or, with neither source, why.
#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    pub source: &'static str,
    pub observed_at: String,
    taken: Instant,
    pub devices: Vec<Device>,
    pub error: Option<String>,
}

impl Sample {
    fn new(source: &'static str, devices: Vec<Device>, error: Option<String>) -> Self {
        Self { source, observed_at: crate::model::now(), taken: Instant::now(), devices, error }
    }

    /// How old it is.
    pub fn age(&self) -> Duration {
        self.taken.elapsed()
    }

    /// As Jobs keep it (`record_gpu_sample`): the devices by UUID, with
    /// memory and utilization, and its own observedAt.
    pub fn to_json(&self) -> Value {
        let devices: Vec<Value> = self.devices.iter().map(|d| json!({"index":d.index,"uuid":d.uuid,"name":d.name,
            "memoryTotalMiB":d.memory_total_mib,"memoryFreeMiB":d.memory_free_mib,"memoryUsedMiB":d.memory_used_mib,
            "utilizationPercent":d.utilization_percent})).collect();
        let mut value = json!({"source":self.source,"observedAt":self.observed_at,"devices":devices});
        if let Some(error) = &self.error {
            value["error"] = json!(error);
        }
        value
    }
}

/// Core's GPU sampler: one per Workspace, so one per Core process.
pub struct GpuSampler {
    inner: Arc<Inner>,
}

struct Inner {
    config: Mutex<Config>,
    shared: Mutex<Shared>,
    /// Wakes a session for a forced reading or a stop.
    wake: Condvar,
    sample: tokio::sync::watch::Sender<Option<Sample>>,
    /// Sessions started: NVML sessions opened and nvidia-smi children started.
    sessions: AtomicU64,
    /// nvidia-smi children started.
    children: AtomicU64,
    /// Starts attempted, a session or not.
    attempts: AtomicU64,
}

struct Shared {
    running: bool,
    last_read: Instant,
    /// No start before this: a backoff or the retry wait.
    not_before: Option<Instant>,
    backoff: Duration,
    /// A forced reading asked of the running NVML session.
    forced: bool,
    stopping: bool,
    /// The running session's source.
    source: Option<&'static str>,
    /// The running nvidia-smi child, to end it from outside its session.
    child: Option<u32>,
}

impl Default for GpuSampler {
    fn default() -> Self {
        Self::new(Config::default())
    }
}

impl GpuSampler {
    pub fn new(config: Config) -> Self {
        let backoff = config.backoff;
        Self { inner: Arc::new(Inner {
            config: Mutex::new(config),
            shared: Mutex::new(Shared { running: false, last_read: Instant::now(), not_before: None, backoff, forced: false,
                stopping: false, source: None, child: None }),
            wake: Condvar::new(),
            sample: tokio::sync::watch::channel(None).0,
            sessions: AtomicU64::new(0),
            children: AtomicU64::new(0),
            attempts: AtomicU64::new(0),
        }) }
    }

    /// Replaces how sessions start from the next one on: a stub, for tests.
    pub fn configure(&self, config: Config) {
        self.inner.shared.lock().unwrap().backoff = config.backoff;
        *self.inner.config.lock().unwrap() = config;
    }

    /// How sessions start now.
    pub fn config(&self) -> Config {
        self.inner.config.lock().unwrap().clone()
    }

    /// Sessions started so far, NVML or nvidia-smi.
    pub fn sessions(&self) -> u64 {
        self.inner.sessions.load(Ordering::SeqCst)
    }

    /// nvidia-smi children started so far.
    pub fn children(&self) -> u64 {
        self.inner.children.load(Ordering::SeqCst)
    }

    /// Starts attempted so far.
    pub fn attempts(&self) -> u64 {
        self.inner.attempts.load(Ordering::SeqCst)
    }

    /// Whether a session runs now.
    pub fn running(&self) -> bool {
        self.inner.shared.lock().unwrap().running
    }

    /// The latest sample, starting a session when none runs and none is
    /// barred; after a start, waits up to `wait` for its first reading.
    pub async fn latest(&self, wait: Duration) -> Option<Sample> {
        let mut seen = self.inner.sample.subscribe();
        if self.read() || seen.borrow().is_none() {
            let _ = tokio::time::timeout(wait, seen.changed()).await;
        }
        current(&seen)
    }

    /// A reading for admission (D2): taken now on a running NVML session,
    /// unless the latest is under a second old; with nvidia-smi, the latest
    /// (at most one interval old). Says which: `now` or `latest`.
    pub async fn now(&self, wait: Duration) -> (Option<Sample>, &'static str) {
        let mut seen = self.inner.sample.subscribe();
        if self.read() || seen.borrow().is_none() {
            let _ = tokio::time::timeout(wait, seen.changed()).await;
            return (current(&seen), "now");
        }
        let fresh = seen.borrow().as_ref().is_some_and(|s| s.age() < Duration::from_secs(1));
        let nvml = self.inner.shared.lock().unwrap().source == Some("nvml");
        if !nvml || fresh {
            return (current(&seen), if fresh { "now" } else { "latest" });
        }
        self.inner.shared.lock().unwrap().forced = true;
        self.inner.wake.notify_all();
        let taken = tokio::time::timeout(wait, seen.changed()).await.is_ok_and(|changed| changed.is_ok());
        (current(&seen), if taken { "now" } else { "latest" })
    }

    /// A read: noted for the idle stop, and a session started when none
    /// runs and none is barred. Whether one was started.
    fn read(&self) -> bool {
        let inner = &self.inner;
        {
            let mut shared = inner.shared.lock().unwrap();
            shared.last_read = Instant::now();
            if shared.running || shared.stopping || shared.not_before.is_some_and(|at| Instant::now() < at) {
                return false;
            }
            shared.running = true;
        }
        inner.attempts.fetch_add(1, Ordering::SeqCst);
        let session = inner.clone();
        if std::thread::Builder::new().name("gpu-sampler".into()).spawn(move || run(session)).is_err() {
            inner.shared.lock().unwrap().running = false;
            return false;
        }
        true
    }
}

/// The sample a receiver sees now.
fn current(seen: &tokio::sync::watch::Receiver<Option<Sample>>) -> Option<Sample> {
    seen.borrow().clone()
}

impl Drop for GpuSampler {
    fn drop(&mut self) {
        let child = {
            let mut shared = self.inner.shared.lock().unwrap();
            shared.stopping = true;
            shared.child
        };
        self.inner.wake.notify_all();
        if let Some(pid) = child {
            end(pid);
        }
    }
}

/// How a session ended.
enum Ended {
    /// Nothing read it for `idle`.
    Idle,
    /// The sampler is gone.
    Stopped,
    /// It failed or its child exited, after giving samples.
    Failed(String),
    /// It gave no sample: no NVML and no nvidia-smi, or neither worked.
    Unavailable(String),
}

/// One session, on its own thread: NVML, else one nvidia-smi child; then
/// what follows its end.
fn run(inner: Arc<Inner>) {
    let config = inner.config.lock().unwrap().clone();
    let session = inner.sessions.load(Ordering::SeqCst) + 1;
    let mut why = Vec::new();
    let mut ended = None;
    match nvml::Nvml::open(&config.nvml) {
        Ok(nvml) => {
            inner.sessions.fetch_add(1, Ordering::SeqCst);
            inner.shared.lock().unwrap().source = Some("nvml");
            eprintln!("GPU sampler: session {session} started, NVML {}", nvml.path.display());
            match sample_nvml(&inner, &config, &nvml) {
                Ended::Failed(error) => why.push(format!("NVML: {error}")),
                other => ended = Some(other),
            }
        }
        Err(error) => why.push(format!("NVML: {error}")),
    }
    let ended = match ended {
        Some(ended) => ended,
        None => match start_smi(&config) {
            Ok((child, program)) => {
                inner.sessions.fetch_add(1, Ordering::SeqCst);
                inner.children.fetch_add(1, Ordering::SeqCst);
                {
                    let mut shared = inner.shared.lock().unwrap();
                    shared.source = Some("nvidia-smi");
                    shared.child = Some(child.id());
                }
                eprintln!("GPU sampler: session {} started, {} (pid {})", inner.sessions.load(Ordering::SeqCst), program.display(), child.id());
                match sample_smi(&inner, &config, child) {
                    Ended::Unavailable(error) => Ended::Unavailable(format!("{}; nvidia-smi: {error}", why.join("; "))),
                    other => other,
                }
            }
            Err(error) => Ended::Unavailable(format!("{}; nvidia-smi: {error}", why.join("; "))),
        },
    };
    let mut shared = inner.shared.lock().unwrap();
    shared.running = false;
    shared.source = None;
    shared.child = None;
    match ended {
        Ended::Idle => {
            shared.not_before = None;
            shared.backoff = config.backoff;
            eprintln!("GPU sampler: stopped, nothing read it for {:?}", config.idle);
        }
        Ended::Stopped => {}
        Ended::Failed(error) => {
            let wait = shared.backoff;
            shared.not_before = Some(Instant::now() + wait);
            shared.backoff = (wait * 2).min(config.retry);
            eprintln!("GPU sampler: session ended ({error}); started again after {} ms at the earliest", wait.as_millis());
        }
        Ended::Unavailable(error) => {
            shared.not_before = Some(Instant::now() + config.retry);
            drop(shared);
            eprintln!("GPU sampler: no GPU reading ({error}); not tried again for {:?}", config.retry);
            inner.sample.send_replace(Some(Sample::new("none", vec![], Some(error.chars().take(500).collect()))));
        }
    }
}

/// Reads the open NVML session every interval, or at once when forced,
/// until nothing has read it for `idle` or the sampler is gone.
fn sample_nvml(inner: &Inner, config: &Config, nvml: &nvml::Nvml) -> Ended {
    loop {
        match nvml.devices() {
            Ok(devices) => {
                inner.sample.send_replace(Some(Sample::new("nvml", devices, None)));
            }
            Err(error) => return Ended::Failed(error),
        }
        let next = Instant::now() + config.interval;
        let mut shared = inner.shared.lock().unwrap();
        loop {
            if shared.stopping {
                return Ended::Stopped;
            }
            if shared.last_read.elapsed() >= config.idle {
                return Ended::Idle;
            }
            if shared.forced {
                shared.forced = false;
                break;
            }
            let Some(left) = next.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()) else { break };
            shared = inner.wake.wait_timeout(shared, left.min(config.idle)).unwrap().0;
        }
    }
}

/// The one nvidia-smi child, looping every interval, from the first program
/// that starts. It ends with Core: the kernel signals it when the thread
/// that started it goes.
fn start_smi(config: &Config) -> Result<(Child, PathBuf), String> {
    let every = if config.interval.subsec_millis() == 0 && config.interval.as_secs() > 0 {
        ["-l".to_owned(), config.interval.as_secs().to_string()]
    } else {
        ["-lms".to_owned(), config.interval.as_millis().to_string()]
    };
    let mut errors = Vec::new();
    for program in &config.smi {
        let mut command = Command::new(program);
        command.args(["--query-gpu=index,uuid,name,memory.total,memory.free,memory.used,utilization.gpu", "--format=csv,noheader,nounits"])
            .args(&every)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            // SAFETY: only prctl, which is async-signal-safe, runs between fork and exec.
            unsafe {
                command.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong);
                    Ok(())
                });
            }
        }
        match command.spawn() {
            Ok(child) => return Ok((child, program.clone())),
            Err(error) => errors.push(format!("{}: {error}", program.display())),
        }
    }
    Err(if errors.is_empty() { "none configured".to_owned() } else { errors.join("; ") })
}

/// Reads the child's rows as it prints them, each a device's latest, until
/// nothing has read the sampler for `idle`, the sampler is gone, or the
/// child exits.
fn sample_smi(inner: &Inner, config: &Config, mut child: Child) -> Ended {
    let pid = child.id();
    let Some(stdout) = child.stdout.take() else {
        end(pid);
        let _ = child.wait();
        return Ended::Unavailable("its output could not be read".into());
    };
    let mut devices: BTreeMap<u32, Device> = BTreeMap::new();
    let mut ended = None;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(device) = parse_row(&line) {
            devices.insert(device.index, device);
            inner.sample.send_replace(Some(Sample::new("nvidia-smi", devices.values().cloned().collect(), None)));
        }
        let shared = inner.shared.lock().unwrap();
        if shared.stopping {
            ended = Some(Ended::Stopped);
        } else if shared.last_read.elapsed() >= config.idle {
            ended = Some(Ended::Idle);
        }
        drop(shared);
        if ended.is_some() {
            end(pid);
            break;
        }
    }
    let status = child.wait();
    if inner.shared.lock().unwrap().stopping {
        return Ended::Stopped;
    }
    ended.unwrap_or_else(|| {
        let exited = status.map_or_else(|error| error.to_string(), |status| status.to_string());
        if devices.is_empty() { Ended::Unavailable(format!("exited ({exited}) with no reading")) } else { Ended::Failed(format!("nvidia-smi exited ({exited})")) }
    })
}

/// Ends the nvidia-smi child.
fn end(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: kill only signals the child this sampler started.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// One `index, uuid, name, memory.total, memory.free, memory.used,
/// utilization.gpu` row (`--format=csv,noheader,nounits`). A name may hold a
/// comma, so the fields are taken from both ends. `[N/A]` is None.
pub fn parse_row(line: &str) -> Option<Device> {
    let mut left = line.splitn(3, ',').map(str::trim);
    let index = left.next()?.parse().ok()?;
    let uuid = left.next()?.to_owned();
    let mut right = left.next()?.rsplitn(5, ',').map(str::trim);
    let number = |field: &str| field.parse::<u64>().ok();
    let utilization = right.next()?.parse::<u32>().ok();
    let used = number(right.next()?);
    let free = number(right.next()?);
    let total = number(right.next()?);
    let name = right.next()?.to_owned();
    (!uuid.is_empty() && !name.is_empty()).then_some(Device { index, uuid, name, memory_total_mib: total, memory_free_mib: free,
        memory_used_mib: used, utilization_percent: utilization })
}

/// NVML through `dlopen`, with no binding crate (D1, Lead 6032). The
/// declarations follow `nvml.h` of NVML API version 12 (CUDA 12.x); these
/// entry points and structures have kept their shape since the `_v2` calls
/// appeared, and `host.py`'s ctypes calls read them the same way on this
/// host until T-58:
///
/// - `nvmlReturn_t` is an `int` enum, `NVML_SUCCESS` = 0;
/// - `nvmlDevice_t` is `struct nvmlDevice_st *`;
/// - `nvmlInit_v2(void)`, `nvmlShutdown(void)`;
/// - `nvmlDeviceGetCount_v2(unsigned int *deviceCount)`;
/// - `nvmlDeviceGetHandleByIndex_v2(unsigned int index, nvmlDevice_t *device)`;
/// - `nvmlDeviceGetUUID(nvmlDevice_t, char *uuid, unsigned int length)`, with
///   `NVML_DEVICE_UUID_V2_BUFFER_SIZE` = 96;
/// - `nvmlDeviceGetName(nvmlDevice_t, char *name, unsigned int length)`, with
///   `NVML_DEVICE_NAME_V2_BUFFER_SIZE` = 96;
/// - `nvmlDeviceGetMemoryInfo(nvmlDevice_t, nvmlMemory_t *)`, where
///   `nvmlMemory_t` is `{unsigned long long total, free, used}` in bytes;
/// - `nvmlDeviceGetUtilizationRates(nvmlDevice_t, nvmlUtilization_t *)`,
///   where `nvmlUtilization_t` is `{unsigned int gpu, memory}` in percent.
///
/// Every call runs on the session's thread: an `Nvml` is opened, read and
/// shut down there, and never sent elsewhere.
mod nvml {
    use super::Device;
    use std::{
        ffi::{c_char, c_int, c_uint, c_void, CStr, CString},
        path::{Path, PathBuf},
    };

    type Return = c_int;
    type Handle = *mut c_void;
    const SUCCESS: Return = 0;
    /// NVML_DEVICE_UUID_V2_BUFFER_SIZE and NVML_DEVICE_NAME_V2_BUFFER_SIZE.
    const BUFFER: usize = 96;
    const MIB: u64 = 1024 * 1024;

    #[repr(C)]
    #[derive(Default)]
    struct Memory {
        total: u64,
        free: u64,
        used: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct Utilization {
        gpu: c_uint,
        /// Memory controller busy, in percent: in the layout, not read.
        _memory: c_uint,
    }

    type Bare = unsafe extern "C" fn() -> Return;
    type Count = unsafe extern "C" fn(*mut c_uint) -> Return;
    type ByIndex = unsafe extern "C" fn(c_uint, *mut Handle) -> Return;
    type Text = unsafe extern "C" fn(Handle, *mut c_char, c_uint) -> Return;
    type MemoryInfo = unsafe extern "C" fn(Handle, *mut Memory) -> Return;
    type UtilizationRates = unsafe extern "C" fn(Handle, *mut Utilization) -> Return;

    struct Calls {
        init: Bare,
        shutdown: Bare,
        count: Count,
        handle: ByIndex,
        uuid: Text,
        name: Text,
        memory: MemoryInfo,
        utilization: UtilizationRates,
    }

    /// An open NVML session: shut down when dropped. The library stays
    /// loaded, so a later session finds it already mapped.
    pub(super) struct Nvml {
        pub path: PathBuf,
        calls: Calls,
    }

    impl Nvml {
        /// The first library that loads, has every call and initialises.
        pub fn open(paths: &[PathBuf]) -> Result<Self, String> {
            let mut errors = Vec::new();
            for path in paths {
                match Self::open_one(path) {
                    Ok(nvml) => return Ok(nvml),
                    Err(error) => errors.push(format!("{}: {error}", path.display())),
                }
            }
            Err(if errors.is_empty() { "none configured".to_owned() } else { errors.join("; ") })
        }

        #[cfg(unix)]
        fn open_one(path: &Path) -> Result<Self, String> {
            let name = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|error| error.to_string())?;
            // SAFETY: dlopen is given a NUL-terminated path; a failure is a null handle, read with dlerror.
            let library = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
            if library.is_null() {
                return Err(last_error());
            }
            macro_rules! call {
                ($symbol:literal, $kind:ty) => {{
                    // SAFETY: the symbol is NUL-terminated; a missing one is a null pointer, refused below.
                    let found = unsafe { libc::dlsym(library, concat!($symbol, "\0").as_ptr().cast()) };
                    if found.is_null() {
                        return Err(format!("{} not found", $symbol));
                    }
                    // SAFETY: the symbol has the signature `nvml.h` gives it (see the module's note).
                    unsafe { std::mem::transmute::<*mut c_void, $kind>(found) }
                }};
            }
            let calls = Calls {
                init: call!("nvmlInit_v2", Bare),
                shutdown: call!("nvmlShutdown", Bare),
                count: call!("nvmlDeviceGetCount_v2", Count),
                handle: call!("nvmlDeviceGetHandleByIndex_v2", ByIndex),
                uuid: call!("nvmlDeviceGetUUID", Text),
                name: call!("nvmlDeviceGetName", Text),
                memory: call!("nvmlDeviceGetMemoryInfo", MemoryInfo),
                utilization: call!("nvmlDeviceGetUtilizationRates", UtilizationRates),
            };
            // SAFETY: nvmlInit_v2 takes no arguments; it is called once per session, on the session's thread.
            let code = unsafe { (calls.init)() };
            if code != SUCCESS {
                return Err(format!("nvmlInit_v2 returned {code}"));
            }
            Ok(Self { path: path.to_owned(), calls })
        }

        #[cfg(not(unix))]
        fn open_one(_: &Path) -> Result<Self, String> {
            Err("not on this platform".into())
        }

        /// Every device now.
        pub fn devices(&self) -> Result<Vec<Device>, String> {
            let mut count: c_uint = 0;
            // SAFETY: count points at a live c_uint.
            check(unsafe { (self.calls.count)(&mut count) }, "nvmlDeviceGetCount_v2")?;
            let mut devices = Vec::new();
            for index in 0..count {
                let mut handle: Handle = std::ptr::null_mut();
                // SAFETY: handle points at a live pointer NVML fills.
                check(unsafe { (self.calls.handle)(index, &mut handle) }, "nvmlDeviceGetHandleByIndex_v2")?;
                let mut uuid = [0 as c_char; BUFFER];
                let mut name = [0 as c_char; BUFFER];
                let mut memory = Memory::default();
                let mut utilization = Utilization::default();
                // SAFETY: each buffer is BUFFER bytes, as its length says; each structure is the `nvml.h` layout.
                unsafe {
                    check((self.calls.uuid)(handle, uuid.as_mut_ptr(), BUFFER as c_uint), "nvmlDeviceGetUUID")?;
                    check((self.calls.name)(handle, name.as_mut_ptr(), BUFFER as c_uint), "nvmlDeviceGetName")?;
                    check((self.calls.memory)(handle, &mut memory), "nvmlDeviceGetMemoryInfo")?;
                }
                // SAFETY: as above; a device that can't say its utilization reports it as unknown.
                let utilized = unsafe { (self.calls.utilization)(handle, &mut utilization) } == SUCCESS;
                devices.push(Device {
                    index,
                    uuid: text(&uuid),
                    name: text(&name),
                    memory_total_mib: Some(memory.total / MIB),
                    memory_free_mib: Some(memory.free / MIB),
                    memory_used_mib: Some(memory.used / MIB),
                    utilization_percent: utilized.then_some(utilization.gpu),
                });
            }
            Ok(devices)
        }
    }

    impl Drop for Nvml {
        fn drop(&mut self) {
            // SAFETY: the session this opened, shut down once, on its own thread.
            unsafe { (self.calls.shutdown)() };
        }
    }

    fn check(code: Return, call: &str) -> Result<(), String> {
        if code == SUCCESS { Ok(()) } else { Err(format!("{call} returned {code}")) }
    }

    /// What NVML wrote into a buffer, up to its NUL.
    fn text(buffer: &[c_char]) -> String {
        let bytes: Vec<u8> = buffer.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[cfg(unix)]
    fn last_error() -> String {
        // SAFETY: dlerror returns null or a NUL-terminated message valid until the next dl call on this thread.
        let message = unsafe { libc::dlerror() };
        if message.is_null() {
            "dlopen failed".into()
        } else {
            // SAFETY: as above.
            unsafe { CStr::from_ptr(message) }.to_string_lossy().into_owned()
        }
    }
}

#[cfg(test)]
#[path = "gpu_sampler_tests.rs"]
mod tests;
